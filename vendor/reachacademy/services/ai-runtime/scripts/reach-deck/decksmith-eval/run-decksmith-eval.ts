import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import { loadAuthorizedReferenceImage } from '../../../lib/reach-deck/authorized-image.js';
import { resolveReachDeckDecksmithImageReference } from '../../../lib/reach-deck/content-service-client.js';
import {
  authorizeDecksmithVisualInputs,
  loadDecksmithVisualInputs,
} from '../../../lib/reach-deck/decksmith/visual-input.js';
import {
  buildReplaySelectionContextRefs,
  DECKSMITH_REPLAY_CONTEXT,
} from '../../../tests/reach-deck/decksmith-replay/fixture-loader.js';
import { DECKSMITH_EVAL_CASES, type DecksmithEvalCase, type EvalObservation } from './cases.js';
import { loadEvalRates, summarizeEval, writeEvalReport } from './report.js';
import {
  loadEvalCaseInput,
  measureEvalCaseInput,
  runEvalSample,
  type EvalSampleRecord,
  type PromptContractChoice,
} from './run-sample.js';
import { createEvalSampleScope, installEvalFetchRouter, runInEvalScope } from './transport.js';

/**
 * Decksmith 第②层：显式联网、限额的真实模型质量评测（WP9 / 评审 M12）。
 *
 * 数据源：第①层回放夹具（同一冻结文档与请求）；模型经 createDirectLiteLlmFetch 直连 LiteLLM
 * （绕过 model-service，所以不验证槽位、计费、模态策略与护栏——那是第③层）；图片编辑/生成默认用桩。
 * 核心逻辑：
 * 1. 每个案例跑 N 个样本，限制并发、单样本超时、单样本与全局 token 上限；
 * 2. 案例首个样本因超时 / token 上限失败（疑似循环）时跳过该案例的剩余样本；
 * 3. 只按结局断言判定成败，汇总成功率、失败类别、p50/p95 延迟、token（含子调用）与估算费用；
 * 4. 报告写到 tmp/decksmith-eval/<时间戳>/（JSON + Markdown），不提交；
 * 5. --dry-run 不调用模型：校验夹具与媒体校验和、输入组装、视觉输入授权与图片归一、断言非空洞。
 */

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../../..');
const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
const USAGE = `Usage:
  npx -y @dotenvx/dotenvx run -f <dev.env> -- pnpm --filter @reachany/ai-runtime eval:decksmith -- [options]

Options:
  --dry-run                 Validate fixtures, inputs and checks without any model call
  --cases <a,b>             Case ids (default: all): ${DECKSMITH_EVAL_CASES.map((c) => c.id).join(', ')}
  --samples <n>             Samples per case (default 3)
  --concurrency <n>         Parallel samples (default 2)
  --timeout-ms <n>          Per-sample timeout (default 300000)
  --model <id>              LiteLLM model id (default REACH_DECK_DECKSMITH_EVAL_MODEL or ${DEFAULT_MODEL})
  --real-image-edit         Use the real RouterLink image edit instead of the stub
  --prompt-contract <v>     current (default, new-Run behaviour) | fixture (the case's frozen version)
  --max-run-tokens <n>      Abort one sample above this many tokens (default 400000)
  --max-total-tokens <n>    Stop the whole eval above this many tokens (default 3000000)
  --no-early-stop           Keep sampling a case after its first sample timed out / hit the token cap
  --rates <file>            Rate table JSON (default scripts/reach-deck/decksmith-eval/rates.json)
  --out <dir>               Report directory under tmp/ or .tmp/ (default tmp/decksmith-eval/<timestamp>)
`;

async function main(): Promise<void> {
  // 出站请求的结构化日志会淹没进度输出；评测自己记录每次调用。
  process.env.REACH_HTTP_LOG_ENABLED ??= 'false';
  const { values } = parseArgs({
    // `pnpm run <script> -- …` 会把分隔符 `--` 原样传进来。
    args: process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--'),
    options: {
      'dry-run': { type: 'boolean', default: false },
      cases: { type: 'string' },
      samples: { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '2' },
      'timeout-ms': { type: 'string', default: '300000' },
      model: { type: 'string' },
      'real-image-edit': { type: 'boolean', default: false },
      'prompt-contract': { type: 'string', default: 'current' },
      'max-run-tokens': { type: 'string', default: '400000' },
      'max-total-tokens': { type: 'string', default: '3000000' },
      'no-early-stop': { type: 'boolean', default: false },
      rates: { type: 'string', default: path.join(import.meta.dirname, 'rates.json') },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const cases = selectCases(values.cases);
  const promptContract = values['prompt-contract'] as PromptContractChoice;
  if (promptContract !== 'current' && promptContract !== 'fixture') {
    throw new Error('--prompt-contract must be current or fixture');
  }
  if (values['dry-run']) {
    await dryRun(cases, promptContract);
    return;
  }

  const model = values.model ?? process.env.REACH_DECK_DECKSMITH_EVAL_MODEL ?? DEFAULT_MODEL;
  const samples = positive(values.samples, '--samples');
  const concurrency = positive(values.concurrency, '--concurrency');
  const timeoutMs = positive(values['timeout-ms'], '--timeout-ms');
  const tokenCap = positive(values['max-run-tokens'], '--max-run-tokens');
  const totalCap = positive(values['max-total-tokens'], '--max-total-tokens');
  const rates = await loadEvalRates(values.rates);
  const outDir = resolveOutDir(values.out);
  await mkdir(outDir, { recursive: true });
  // 逐样本落盘：中途中止也保留已完成样本的明细。
  const samplesLog = path.join(outDir, 'samples.jsonl');
  const startedAt = new Date();
  const restore = installEvalFetchRouter({
    mode: 'direct',
    env: process.env,
    model,
    realImageEdit: values['real-image-edit'],
  });
  const stopAll = new AbortController();
  const records: EvalSampleRecord[] = [];
  const skippedCases = new Set<string>();
  let totalTokens = 0;
  console.log(
    `Decksmith eval (layer 2): ${cases.length} cases × ${samples} samples, model ${model}, concurrency ${concurrency}`,
  );
  try {
    // 按样本序号轮转案例：先拿到每个案例的首个样本，循环案例尽早被识别并跳过。
    const queue = Array.from({ length: samples }, (_, sample) =>
      cases.map((evalCase) => ({ evalCase, sample: sample + 1 })),
    ).flat();
    const worker = async () => {
      while (queue.length > 0 && !stopAll.signal.aborted) {
        const job = queue.shift()!;
        if (skippedCases.has(job.evalCase.id)) continue;
        const record = await runEvalSample(job.evalCase, job.sample, {
          env: process.env,
          timeoutMs,
          tokenCap,
          promptContract,
          signal: stopAll.signal,
        });
        records.push(record);
        await appendFile(samplesLog, JSON.stringify(record) + '\n');
        const used = record.calls.reduce(
          (sum, call) =>
            sum +
            (call.usage === undefined ? 0 : call.usage.promptTokens + call.usage.completionTokens),
          0,
        );
        totalTokens += used;
        console.log(
          `  ${record.passed ? 'PASS' : 'FAIL'} ${record.caseId} #${record.sample} ` +
            `${(record.latencyMs / 1000).toFixed(1)}s ${record.modelTurns} turns ${used} tokens` +
            (record.passed ? '' : ` — ${record.failures.map((f) => f.category).join(', ')}`),
        );
        if (
          !values['no-early-stop'] &&
          record.failures.some((f) => f.category === 'timeout' || f.category === 'token-cap')
        ) {
          skippedCases.add(record.caseId);
          console.log(`  skip remaining samples of ${record.caseId} (looping or too slow)`);
        }
        if (totalTokens >= totalCap) {
          console.log(`  total token cap ${totalCap} reached; stopping`);
          stopAll.abort(new Error('total token cap reached'));
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    restore();
  }
  records.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.sample - b.sample);
  const report = summarizeEval({
    layer: 2,
    startedAt,
    model,
    promptContract,
    imageTools: values['real-image-edit'] ? 'real' : 'stub',
    rates,
    cases: cases.map((evalCase) => ({ id: evalCase.id, summary: evalCase.summary })),
    samples: records,
  });
  const files = await writeEvalReport(outDir, report);
  console.log(
    `\n${report.totals.passed}/${report.totals.samples} passed; ` +
      `${report.totals.promptTokens + report.totals.completionTokens} tokens; ` +
      `estimated ${report.totals.estimatedCost.toFixed(4)} ${rates.currency}`,
  );
  for (const summary of report.cases) {
    console.log(
      `  ${summary.caseId}: ${summary.passed}/${summary.samples}, p50 ${(summary.latencyMs.p50 / 1000).toFixed(1)}s, ` +
        `p95 ${(summary.latencyMs.p95 / 1000).toFixed(1)}s, ${summary.tokensPerRun} tokens/run`,
    );
  }
  console.log(`Report: ${files.map((file) => path.relative(REPOSITORY_ROOT, file)).join(', ')}`);
}

/**
 * 试运行：不调用模型。逐案例核对夹具、组装首轮模型输入、（需要时）走一遍视觉输入授权与图片归一，
 * 并确认每个案例的断言会拒绝"什么都没做"的结果（断言不空洞）。
 */
async function dryRun(
  cases: readonly DecksmithEvalCase[],
  promptContract: PromptContractChoice,
): Promise<void> {
  // 桩授权仍会签一个服务 JWT（随后被路由丢弃）；未加载 dev.env 时用占位密钥。
  const env = {
    ...process.env,
    REACHANY_SERVICE_JWT_SECRET:
      process.env.REACHANY_SERVICE_JWT_SECRET ?? 'decksmith-eval-dry-run',
  };
  const restore = installEvalFetchRouter({ mode: 'direct', env, offline: true });
  let failed = 0;
  try {
    for (const evalCase of cases) {
      try {
        const { input, baseline, media } = await loadEvalCaseInput(evalCase, promptContract);
        const { tools, measurement } = measureEvalCaseInput(input);
        let vision = '';
        if (evalCase.vision === true) {
          const scope = createEvalSampleScope(media, 1);
          const document = input.document as ReachDeckDocumentV2;
          const options = {
            actorId: DECKSMITH_REPLAY_CONTEXT.actorId,
            billingGroupId: DECKSMITH_REPLAY_CONTEXT.billingGroupId,
            roleGrantId: DECKSMITH_REPLAY_CONTEXT.roleGrantId,
            resourceScope: DECKSMITH_REPLAY_CONTEXT.resourceScope,
            env,
          };
          const entries = await runInEvalScope(scope, async () => {
            const visualInputs = await authorizeDecksmithVisualInputs({
              document,
              pageId: input.pageId!,
              contextRefs: buildReplaySelectionContextRefs(
                document,
                input.pageId!,
                input.selectedElementIds ?? [],
              ),
              resolve: (reference, signal) =>
                resolveReachDeckDecksmithImageReference(reference, { ...options, signal }),
            });
            if (visualInputs === undefined) throw new Error('no visual input for the selection');
            return loadDecksmithVisualInputs({
              visualInputs,
              document,
              resolve: (reference, signal) =>
                resolveReachDeckDecksmithImageReference(reference, { ...options, signal }),
              load: loadAuthorizedReferenceImage,
            });
          });
          const attached = entries.filter((entry) => entry.state === 'attached').length;
          if (attached === 0) {
            throw new Error(
              `selected picture could not be attached as vision input: ${JSON.stringify(entries)}`,
            );
          }
          vision = `, vision ${attached} attached`;
        }
        const noop: EvalObservation = {
          baseline,
          pageId: input.pageId!,
          result: {
            type: 'result',
            message: 'dry-run no-op',
            changed: false,
            outcome: {
              schemaVersion: 'reach-deck-decksmith-outcome/v1',
              mutationStatus: 'none',
              rejectedFontFamilies: [],
              toolErrorCount: 0,
            },
          },
          toolsOk: [],
          toolErrors: [],
          imageEditCalls: 0,
          imageGenerateCalls: 0,
        };
        const noopFailures = evalCase.check(noop);
        if (noopFailures.length === 0) throw new Error('check accepts a no-op result (vacuous)');
        console.log(
          `  OK ${evalCase.id} ← ${evalCase.fixtureId}: ${input.promptContractVersion ?? 'v1'}, ` +
            `${tools} tools, ${JSON.stringify(measurement)}${vision}; no-op → ${noopFailures[0]!.category}`,
        );
      } catch (error) {
        failed += 1;
        console.error(`  FAIL ${evalCase.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    restore();
  }
  if (failed > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`Dry run passed for ${cases.length} cases (no model calls).`);
}

function selectCases(value: string | undefined): readonly DecksmithEvalCase[] {
  if (value === undefined) return DECKSMITH_EVAL_CASES;
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.map((id) => {
    const found = DECKSMITH_EVAL_CASES.find((evalCase) => evalCase.id === id);
    if (found === undefined) throw new Error(`unknown eval case ${id}`);
    return found;
  });
}

function resolveOutDir(value: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.resolve(
    REPOSITORY_ROOT,
    value ?? path.join('tmp', 'decksmith-eval', stamp),
  );
  const relative = path.relative(REPOSITORY_ROOT, directory);
  if (!/^\.?tmp(?:\/|$)/.test(relative)) {
    throw new Error('--out must stay under tmp/ or .tmp/ (reports are never committed)');
  }
  return directory;
}

function positive(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
