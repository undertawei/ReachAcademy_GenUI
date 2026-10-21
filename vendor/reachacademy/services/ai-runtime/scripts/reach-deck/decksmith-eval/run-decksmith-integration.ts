import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  loadAuthorizedReferenceImage,
  REFERENCE_IMAGE_VISION_PRESET,
} from '../../../lib/reach-deck/authorized-image.js';
import {
  ContentServiceClientError,
  resolveReachDeckDecksmithImageReference,
} from '../../../lib/reach-deck/content-service-client.js';
import type { ReachDeckResourceScope } from '../../../lib/reach-deck/resource-scope.js';
import {
  DECKSMITH_REPLAY_CONTEXT,
  DECKSMITH_REPLAY_OBJECT_KEY_PREFIX,
} from '../../../tests/reach-deck/decksmith-replay/fixture-loader.js';
import { DECKSMITH_EVAL_CASES } from './cases.js';
import { runEvalSample, type EvalSampleRecord } from './run-sample.js';
import { createEvalSampleScope, installEvalFetchRouter, runInEvalScope } from './transport.js';

/**
 * Decksmith 第③层：经本地 model-service / content-service 的集成验证（WP9 / 评审 M12）。
 *
 * 数据源：本地 model-service（默认 http://127.0.0.1:8100）与 content-service（默认 http://127.0.0.1:8000），
 * 二者连接云端共享 PostgreSQL / OSS / LiteLLM；冻结输入取自第①层回放夹具。
 * 核心逻辑：
 * 1. 健康检查两个服务的 /readyz，任一不可用即打印启动方法并以"跳过"结束（退出码 0）；
 * 2. 取图授权（只读）：合成夹具的 objectKey 必须被 content-service 拒绝（fail-closed）；
 *    给了 --reference-scope 时，再验证一张真实图片能授权、下载并通过校验和；
 * 3. 只有显式 --allow-shared-writes 才调用模型：model-service 每次调用都会写共享库的用量事件与护栏审计；
 *    - 槽位路由与计费：讲稿改写案例经 model-service 跑一次，核对调用合同、上游模型、每次调用都有 usage，
 *      且 runDecksmith 的 usage 事件（job-runner 记账口径）与 provider usage 总量一致；
 *    - 模态：选中图片案例附带视觉输入（取图用夹具桩），首个主模型请求必须带图且被接受；
 *    - 护栏：上述正常请求不得被误拦；给了 --guardrail-probe 时，探针原话必须以 GUARDRAIL_BLOCKED 失败；
 * 4. 生成媒体写入（POST generated-media）始终用内存桩；报告写到 tmp/decksmith-eval/。
 */

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const EXPECTED_INVOCATION = {
  scene_id: 'teacher.deck',
  orchestration: 'courseware.deck',
  stage: 'decksmith',
  tool: 'chat',
  channel: 'chat',
};
const START_COMMANDS = `Start the required services first (one terminal each, from the repository root):
  cd java && npx dotenvx run -f ../infra/env/dev.env -- ./gradlew :model-service:bootRun
  cd java && npx dotenvx run -f ../infra/env/dev.env -- ./gradlew :content-service:bootRun
(auth-service is not needed: ai-runtime signs its own service JWT.) Then rerun under dotenvx.`;

type CheckStatus = 'pass' | 'fail' | 'skip';

interface IntegrationCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

async function main(): Promise<void> {
  process.env.REACH_HTTP_LOG_ENABLED ??= 'false';
  const { values } = parseArgs({
    // `pnpm run <script> -- …` 会把分隔符 `--` 原样传进来。
    args: process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--'),
    options: {
      'model-service': { type: 'string' },
      'content-service': { type: 'string' },
      'allow-shared-writes': { type: 'boolean', default: false },
      'real-image-edit': { type: 'boolean', default: false },
      'reference-scope': { type: 'string' },
      'guardrail-probe': { type: 'string' },
      'expect-model': { type: 'string' },
      'timeout-ms': { type: 'string', default: '420000' },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  const modelService = loopback(
    values['model-service'] ?? process.env.REACHANY_MODEL_BASE_URL ?? 'http://127.0.0.1:8100',
    '--model-service',
  );
  const contentService = loopback(
    values['content-service'] ?? process.env.REACHANY_CONTENT_BASE_URL ?? 'http://127.0.0.1:8000',
    '--content-service',
  );
  // 生产客户端从环境读取服务地址；只允许指向本机，避免评测打到共享部署。
  process.env.REACHANY_MODEL_BASE_URL = modelService;
  process.env.REACHANY_CONTENT_BASE_URL = contentService;
  const startedAt = new Date();
  const checks: IntegrationCheck[] = [];
  const samples: EvalSampleRecord[] = [];

  const health = await Promise.all([
    ready('model-service', modelService),
    ready('content-service', contentService),
  ]);
  checks.push(...health);
  const [modelHealth, contentHealth] = health;
  if (modelHealth!.status !== 'pass' && contentHealth!.status !== 'pass') {
    for (const check of health)
      console.log(`  ${check.status.toUpperCase()} ${check.id}: ${check.detail}`);
    console.log(`\nSKIPPED: layer-3 integration needs the local services.\n${START_COMMANDS}`);
    await writeReport(values.out, startedAt, 'skipped', checks, samples);
    return;
  }

  const restore = installEvalFetchRouter({
    mode: 'integration',
    env: process.env,
    realImageEdit: values['real-image-edit'],
  });
  try {
    // 取图授权只需要 content-service（只读：签发短时下载地址，不写库）。
    if (contentHealth!.status === 'pass') {
      // 出站路由按样本作用域归属请求；授权检查用一个不打桩的作用域直通 content-service。
      const authScope = createEvalSampleScope(new Map(), 1, false);
      checks.push(await runInEvalScope(authScope, syntheticReferenceDenied));
      checks.push(
        values['reference-scope'] === undefined
          ? skip('authorization.real-reference', 'no --reference-scope file given')
          : await runInEvalScope(authScope, () =>
              realReferenceAuthorized(values['reference-scope']!),
            ),
      );
    } else {
      for (const id of [
        'authorization.synthetic-reference-denied',
        'authorization.real-reference',
      ]) {
        checks.push(skip(id, 'content-service is not running'));
      }
    }
    const modelSkip =
      modelHealth!.status !== 'pass'
        ? 'model-service is not running'
        : !values['allow-shared-writes']
          ? 'model calls write usage events and guardrail audits to the shared database; pass --allow-shared-writes'
          : contentHealth!.status !== 'pass'
            ? 'content-service is not running'
            : undefined;
    if (modelSkip !== undefined) {
      for (const id of [
        'routing-and-billing',
        'modality.image-input',
        'guardrail.no-false-positive',
        'guardrail.blocked-probe',
      ])
        checks.push(skip(id, modelSkip));
    } else {
      const timeoutMs = Number(values['timeout-ms']);
      const base = {
        env: process.env,
        timeoutMs,
        tokenCap: 400_000,
        promptContract: 'current' as const,
      };
      const narration = DECKSMITH_EVAL_CASES.find((c) => c.id === 'narration-rewrite-text-only')!;
      const routed = await runEvalSample(narration, 1, { ...base, stubContent: false });
      samples.push(routed);
      checks.push(routingAndBilling(routed, values['expect-model']));
      const image = DECKSMITH_EVAL_CASES.find((c) => c.id === 'image-edit-selected')!;
      const vision = await runEvalSample(image, 1, { ...base, stubContent: true });
      samples.push(vision);
      checks.push(modality(vision));
      checks.push(noFalsePositive([routed, vision]));
      if (values['guardrail-probe'] === undefined) {
        checks.push(skip('guardrail.blocked-probe', 'no --guardrail-probe prompt file given'));
      } else {
        const prompt = (await readFile(values['guardrail-probe'], 'utf8')).trim();
        const probe = await runEvalSample(narration, 1, { ...base, stubContent: false, prompt });
        samples.push(probe);
        checks.push(guardrailBlocked(probe));
      }
    }
  } finally {
    restore();
  }
  for (const check of checks)
    console.log(`  ${check.status.toUpperCase()} ${check.id}: ${check.detail}`);
  const failed = checks.some((check) => check.status === 'fail');
  await writeReport(values.out, startedAt, failed ? 'failed' : 'passed', checks, samples);
  if (failed) process.exitCode = 1;
}

async function ready(name: string, base: string): Promise<IntegrationCheck> {
  try {
    const response = await fetch(new URL('/readyz', base), { signal: AbortSignal.timeout(3_000) });
    return response.ok
      ? { id: `health.${name}`, status: 'pass', detail: `${base}/readyz ${response.status}` }
      : {
          id: `health.${name}`,
          status: 'skip',
          detail: `${base}/readyz returned ${response.status}`,
        };
  } catch {
    return { id: `health.${name}`, status: 'skip', detail: `${base} is not reachable` };
  }
}

/** 合成夹具的图片不属于任何真实课程：content-service 必须拒绝签发下载地址。 */
async function syntheticReferenceDenied(): Promise<IntegrationCheck> {
  const id = 'authorization.synthetic-reference-denied';
  try {
    await resolveReachDeckDecksmithImageReference(
      { objectKey: `${DECKSMITH_REPLAY_OBJECT_KEY_PREFIX}hero.png` },
      {
        actorId: DECKSMITH_REPLAY_CONTEXT.actorId,
        billingGroupId: DECKSMITH_REPLAY_CONTEXT.billingGroupId,
        roleGrantId: DECKSMITH_REPLAY_CONTEXT.roleGrantId,
        resourceScope: DECKSMITH_REPLAY_CONTEXT.resourceScope,
        signal: AbortSignal.timeout(10_000),
      },
    );
    return {
      id,
      status: 'fail',
      detail: 'content-service signed a URL for a synthetic object key',
    };
  } catch (error) {
    // 404 "Endpoint not found" 是连到了不含该接口的旧 content-service 进程（2026-10-09 T11 实测：8000 端口上
    // 跑的是另一个 worktree），没有验证任何授权逻辑，记为失败。
    if (
      error instanceof ContentServiceClientError &&
      error.status === 404 &&
      /Endpoint not found/u.test(error.message)
    ) {
      return {
        id,
        status: 'fail',
        detail: `content-service has no Decksmith image-reference endpoint (stale process on this port?): ${describe(error)}`,
      };
    }
    if (error instanceof ContentServiceClientError && error.status >= 400 && error.status < 500) {
      return { id, status: 'pass', detail: `denied with ${error.status}` };
    }
    // 没签发地址（fail-closed）但状态不是 4xx：执行期会被归为"引用暂不可用"而不是"未授权"，同样记为失败。
    if (error instanceof ContentServiceClientError) {
      return {
        id,
        status: 'fail',
        detail: `no URL was signed, but content-service answered ${error.status} instead of a 4xx denial: ${describe(error)}`,
      };
    }
    return { id, status: 'fail', detail: `unexpected failure: ${describe(error)}` };
  }
}

/** 真实课程里的一张图：授权、下载、校验和与归一都必须成功（只读）。 */
async function realReferenceAuthorized(file: string): Promise<IntegrationCheck> {
  const id = 'authorization.real-reference';
  const config = JSON.parse(await readFile(file, 'utf8')) as {
    actorId: string;
    roleGrantId: string;
    billingGroupId?: string | null;
    resourceScope: ReachDeckResourceScope;
    objectKey: string;
  };
  try {
    const reference = await resolveReachDeckDecksmithImageReference(
      { objectKey: config.objectKey },
      {
        actorId: config.actorId,
        billingGroupId: config.billingGroupId ?? null,
        roleGrantId: config.roleGrantId,
        resourceScope: config.resourceScope,
        signal: AbortSignal.timeout(10_000),
      },
    );
    const image = await loadAuthorizedReferenceImage(reference, REFERENCE_IMAGE_VISION_PRESET);
    return {
      id,
      status: 'pass',
      detail: `${reference.source} image ${reference.sizeBytes} bytes → ${image.width}×${image.height} ${image.contentType}`,
    };
  } catch (error) {
    return { id, status: 'fail', detail: describe(error) };
  }
}

function routingAndBilling(
  sample: EvalSampleRecord,
  expectModel: string | undefined,
): IntegrationCheck {
  const id = 'routing-and-billing';
  const modelCalls = sample.calls.filter(
    (call) => call.kind === 'main-chat' || call.kind === 'sub-chat',
  );
  const problems: string[] = [];
  if (sample.error !== undefined) problems.push(`run error: ${sample.error}`);
  if (modelCalls.length === 0) problems.push('no model call reached model-service');
  for (const [index, call] of modelCalls.entries()) {
    if (call.status !== 200) problems.push(`call ${index + 1} returned ${call.status}`);
    if (call.usage === undefined) problems.push(`call ${index + 1} has no usage`);
    if (
      call.kind === 'main-chat' &&
      JSON.stringify(call.invocation) !== JSON.stringify(EXPECTED_INVOCATION)
    ) {
      problems.push(`call ${index + 1} invocation ${JSON.stringify(call.invocation)}`);
    }
    if (call.responseModel === undefined)
      problems.push(`call ${index + 1} reports no routed model`);
    else if (expectModel !== undefined && call.responseModel !== expectModel) {
      problems.push(`call ${index + 1} routed to ${call.responseModel}, expected ${expectModel}`);
    }
  }
  const provider = modelCalls.reduce(
    (sum, call) =>
      sum + (call.usage === undefined ? 0 : call.usage.promptTokens + call.usage.completionTokens),
    0,
  );
  if (sample.billedUsage.totalTokens !== provider) {
    problems.push(
      `usage events total ${sample.billedUsage.totalTokens} ≠ provider usage ${provider}`,
    );
  }
  const models = [...new Set(modelCalls.map((call) => call.responseModel))].join(', ');
  return problems.length === 0
    ? {
        id,
        status: 'pass',
        detail: `${modelCalls.length} calls via ${models}; ${provider} tokens billed`,
      }
    : { id, status: 'fail', detail: problems.join('; ') };
}

function modality(sample: EvalSampleRecord): IntegrationCheck {
  const id = 'modality.image-input';
  const first = sample.calls.find((call) => call.kind === 'main-chat');
  if (sample.visionAttached === 0) return { id, status: 'fail', detail: 'no picture was attached' };
  if (first?.imageInput !== true)
    return { id, status: 'fail', detail: 'first main request carried no image block' };
  if (first.status !== 200)
    return {
      id,
      status: 'fail',
      detail: `model-service rejected the image input with ${first.status}: ${first.error ?? ''}`,
    };
  return {
    id,
    status: 'pass',
    detail: `image input accepted by ${first.responseModel ?? 'unknown model'}; case ${sample.passed ? 'passed' : 'failed: ' + sample.failures.map((f) => f.category).join(', ')}`,
  };
}

function noFalsePositive(samples: readonly EvalSampleRecord[]): IntegrationCheck {
  const blocked = samples.filter((sample) =>
    sample.failures.some((f) => f.category === 'guardrail'),
  );
  return blocked.length === 0
    ? {
        id: 'guardrail.no-false-positive',
        status: 'pass',
        detail: `${samples.length} ordinary teacher requests were not blocked`,
      }
    : {
        id: 'guardrail.no-false-positive',
        status: 'fail',
        detail: `blocked: ${blocked.map((s) => s.caseId).join(', ')}`,
      };
}

function guardrailBlocked(sample: EvalSampleRecord): IntegrationCheck {
  const id = 'guardrail.blocked-probe';
  const guarded = sample.failures.find((failure) => failure.category === 'guardrail');
  if (guarded === undefined) {
    return {
      id,
      status: 'fail',
      detail: `probe was not blocked (${sample.failures.map((f) => f.category).join(', ') || 'passed'})`,
    };
  }
  return {
    id,
    status: 'pass',
    detail: `blocked without a proposal: ${guarded.detail.slice(0, 120)}`,
  };
}

function skip(id: string, detail: string): IntegrationCheck {
  return { id, status: 'skip', detail };
}

function loopback(value: string, flag: string): string {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`${flag} must point to a local service (got ${url.origin})`);
  }
  return url.origin;
}

function describe(error: unknown): string {
  if (error instanceof ContentServiceClientError) return `${error.status} ${error.message}`;
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return error instanceof Error ? `${error.name}: ${error.message}${cause}` : String(error);
}

async function writeReport(
  out: string | undefined,
  startedAt: Date,
  status: 'passed' | 'failed' | 'skipped',
  checks: readonly IntegrationCheck[],
  samples: readonly EvalSampleRecord[],
): Promise<void> {
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const directory = path.resolve(
    REPOSITORY_ROOT,
    out ?? path.join('tmp', 'decksmith-eval', `integration-${stamp}`),
  );
  if (!/^\.?tmp(?:\/|$)/.test(path.relative(REPOSITORY_ROOT, directory))) {
    throw new Error('--out must stay under tmp/ or .tmp/');
  }
  await mkdir(directory, { recursive: true });
  const report = {
    schemaVersion: 'decksmith-integration-report/v1',
    layer: 3,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    checks,
    samples,
  };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    path.join(directory, 'report.md'),
    [
      `# Decksmith 第③层集成验证：${status}`,
      '',
      '| 检查 | 结果 | 说明 |',
      '| ---- | ---- | ---- |',
      ...checks.map(
        (check) => `| ${check.id} | ${check.status} | ${check.detail.replace(/\|/g, '\\|')} |`,
      ),
      '',
    ].join('\n'),
  );
  console.log(`Report: ${path.relative(REPOSITORY_ROOT, directory)}/report.{json,md}`);
}

function usage(): string {
  return `Usage:
  npx -y @dotenvx/dotenvx run -f <dev.env> -- pnpm --filter @reachany/ai-runtime eval:decksmith:integration -- [options]

Options:
  --model-service <url>     Local model-service (default REACHANY_MODEL_BASE_URL or http://127.0.0.1:8100; loopback only)
  --content-service <url>   Local content-service (default REACHANY_CONTENT_BASE_URL or http://127.0.0.1:8000; loopback only)
  --allow-shared-writes     Run the model checks (model-service records usage events and guardrail audits)
  --real-image-edit         Send edit_native_image through model-service (billed RouterLink edit) instead of the stub
  --reference-scope <file>  JSON {actorId, roleGrantId, billingGroupId?, resourceScope, objectKey} for a real image
  --guardrail-probe <file>  Prompt known to be blocked by the guardrail policy; expects GUARDRAIL_BLOCKED
  --expect-model <id>       Upstream model the Decksmith chat slot must route to
  --timeout-ms <n>          Per-run timeout (default 420000)
  --out <dir>               Report directory under tmp/ (default tmp/decksmith-eval/integration-<timestamp>)

${START_COMMANDS}`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
