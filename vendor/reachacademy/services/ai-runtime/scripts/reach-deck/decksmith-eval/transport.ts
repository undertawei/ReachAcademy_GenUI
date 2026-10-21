import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import {
  resolveModelServiceOpenAiBaseUrl,
  type ReachDeckModelEnv,
} from '../../../lib/reach-deck/model-service-client.js';
import {
  DECKSMITH_REPLAY_OBJECT_KEY_PREFIX,
  type DecksmithReplayMediaFile,
} from '../../../tests/reach-deck/decksmith-replay/fixture-loader.js';
import { evalMediaFile } from './media.js';
import { createDirectLiteLlmFetch, directLiteLlmEndpoint } from '../offline-model-client.js';

/**
 * Decksmith 第②/③层评测的出站请求路由（替换进程内的全局 fetch）。
 *
 * 数据源：生产代码经全局 fetch 发出的全部 HTTP 请求——model-service 聊天/图片、content-service
 * 生成媒体与取图授权、签名下载地址；不访问数据库。
 * 核心逻辑：
 * 1. 每个样本在 AsyncLocalStorage 作用域内运行，请求按作用域归属到样本（并发样本互不串扰）；
 * 2. direct 模式（第②层）：model-service 聊天改由 createDirectLiteLlmFetch 直连 LiteLLM（绕过
 *    model-service）；图片编辑/生成默认用桩（可选真实 RouterLink 编辑）；content-service 全部用内存桩；
 * 3. integration 模式（第③层）：model-service 与 content-service 的只读请求透传给本地服务；
 *    生成媒体写入（POST generated-media）始终用内存桩，不写共享库；
 * 4. 每次模型调用记录耗时、状态、上游模型、usage（含缓存与推理 token）与网关报告的费用；
 * 5. 未识别的出站请求一律拒绝（fail-closed），避免评测意外打到共享服务。
 * 设计动机：脚本进程不能像 vitest 那样替换模块，而生产代码的所有外部依赖都经全局 fetch，
 * 在这一层替换即可保持 agentLoop、工具、会话与提示词全部走真实代码。
 */

export type EvalTransportMode = 'direct' | 'integration';

export type EvalCallKind =
  | 'main-chat'
  | 'sub-chat'
  | 'image-edit'
  | 'image-generate'
  | 'content-read'
  | 'content-write-stub'
  | 'download';

export interface EvalTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly reasoningTokens: number;
}

export interface EvalCallRecord {
  readonly kind: EvalCallKind;
  readonly stubbed: boolean;
  readonly startedAt: number;
  durationMs: number;
  status: number;
  /** 上游实际返回的模型（SSE / JSON 的 model 字段）；第③层用来核对槽位路由。 */
  responseModel?: string;
  usage?: EvalTokenUsage;
  /** LiteLLM 在响应头里报告的费用（美元）；流式响应常常没有。 */
  gatewayCostUsd?: number;
  /** 主模型请求是否带图片输入块（模态核对）。 */
  imageInput?: boolean;
  /** 发给 model-service 的调用合同（metadata.reachany_application_llm_span.invocation）。 */
  invocation?: Readonly<Record<string, unknown>>;
  error?: string;
}

export interface EvalSampleScope {
  readonly calls: EvalCallRecord[];
  /** 本样本可解析的媒体：基线文档图片 + 桩存储的生成图。 */
  readonly media: Map<string, DecksmithReplayMediaFile>;
  readonly stored: { objectKey: string; sha256: string; pageId?: string }[];
  readonly imageEditRequests: { instruction: string; referenceSha256: string }[];
  /** 最近一次主模型请求体（含完整对话与工具结果），用于失败诊断与工具轨迹。 */
  lastMainRequest?: Record<string, unknown>;
  /** 单样本 token 上限：超过即中止本样本（防止循环烧钱）。 */
  readonly tokenCap: number;
  /**
   * content-service 全部用内存桩（direct 模式恒为 true）。第③层的模态检查用它：合成夹具的取图授权
   * 必然被真实 content-service 拒绝，模态只验证 model-service 是否接受图片输入。
   */
  readonly stubContent: boolean;
  readonly abort: AbortController;
  tokensUsed: number;
}

export interface EvalTransportOptions {
  readonly mode: EvalTransportMode;
  readonly env: ReachDeckModelEnv;
  /** direct 模式的 LiteLLM 模型 id。 */
  readonly model?: string;
  /** direct 模式：图片编辑走真实 RouterLink（默认桩）。integration 模式：经 model-service 真实编辑。 */
  readonly realImageEdit?: boolean;
  /** 试运行：不允许任何模型调用（只校验夹具、输入组装与视觉输入授权链路）。 */
  readonly offline?: boolean;
}

const STUB_DOWNLOAD_ORIGIN = 'https://decksmith-eval.invalid/';
const scopes = new AsyncLocalStorage<EvalSampleScope>();
let installed: { restore: () => void } | undefined;

export function createEvalSampleScope(
  baseline: ReadonlyMap<string, DecksmithReplayMediaFile>,
  tokenCap: number,
  stubContent = true,
): EvalSampleScope {
  return {
    stubContent,
    calls: [],
    media: new Map(baseline),
    stored: [],
    imageEditRequests: [],
    tokenCap,
    abort: new AbortController(),
    tokensUsed: 0,
  };
}

export function runInEvalScope<T>(scope: EvalSampleScope, run: () => Promise<T>): Promise<T> {
  return scopes.run(scope, run);
}

/** 安装全局 fetch 路由；返回卸载函数。同一进程只允许一个路由。 */
export function installEvalFetchRouter(options: EvalTransportOptions): () => void {
  if (installed !== undefined) throw new Error('decksmith eval fetch router is already installed');
  const originalFetch = globalThis.fetch;
  const modelBase = trimSlash(resolveModelServiceOpenAiBaseUrl(options.env));
  const litellm =
    options.mode === 'direct' && options.offline !== true
      ? {
          endpoint: directLiteLlmEndpoint(options.env),
          fetch: createDirectLiteLlmFetch(options.env, requireModel(options.model)),
        }
      : undefined;
  const routerLink = options.realImageEdit === true ? routerLinkEditConfig(options.env) : undefined;

  const router: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const href = url.toString();
    // 直连 LiteLLM / RouterLink 的真实请求（由下面的分支发起）原样放行。
    if (litellm !== undefined && href === litellm.endpoint) return originalFetch(input, init);
    if (routerLink !== undefined && href === routerLink.endpoint) return originalFetch(input, init);
    const scope = scopes.getStore();
    if (scope === undefined) {
      throw new Error(`decksmith eval: outbound request outside a sample scope: ${url.origin}`);
    }
    if (href.startsWith(STUB_DOWNLOAD_ORIGIN)) return serveStubDownload(scope, href);
    if (href.startsWith(modelBase + '/')) {
      const path = href.slice(modelBase.length);
      if (path === '/chat/completions') return modelChat(scope, input, init);
      if (path === '/images/edits') return imageEdit(scope, input, init);
      if (path === '/images/generations') return imageGenerate(scope);
    }
    if (url.pathname.includes('/reach-deck/courses/')) return content(scope, url, input, init);
    if (
      options.mode === 'integration' &&
      url.protocol === 'https:' &&
      init?.redirect === 'manual'
    ) {
      // content-service 签发的对象存储签名下载地址（只读）。
      return recordPassThrough(scope, 'download', () => originalFetch(input, init));
    }
    throw new Error(`decksmith eval: blocked unexpected outbound request to ${url.origin}`);
  };

  const modelChat = async (
    scope: EvalSampleScope,
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (options.offline === true)
      throw new Error('decksmith eval dry-run: model calls are disabled');
    const main = Array.isArray(body.tools);
    if (main) scope.lastMainRequest = body;
    if (scope.tokensUsed >= scope.tokenCap) {
      scope.abort.abort(new EvalTokenCapError(scope.tokenCap));
      throw new EvalTokenCapError(scope.tokenCap);
    }
    const record: EvalCallRecord = {
      kind: main ? 'main-chat' : 'sub-chat',
      stubbed: false,
      startedAt: Date.now(),
      durationMs: 0,
      status: 0,
      imageInput: JSON.stringify(body.messages ?? []).includes('"image_url"'),
      ...readInvocation(body),
    };
    scope.calls.push(record);
    let response: Response;
    try {
      // LiteLLM 的响应缓存不按会话隔离：同一冻结输入的第二个样本会直接命中缓存（0.2 秒、token 相同），
      // 样本就不独立了。直连时每次请求都绕过并且不写缓存（与 model-service 对页面阶段的处理相同）。
      response =
        litellm !== undefined
          ? await litellm.fetch(input, {
              ...init,
              body: JSON.stringify({ ...body, cache: { 'no-cache': true, 'no-store': true } }),
            })
          : await originalFetch(input, init);
    } catch (error) {
      record.durationMs = Date.now() - record.startedAt;
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
    record.status = response.status;
    const cost = Number(response.headers.get('x-litellm-response-cost') ?? '');
    if (Number.isFinite(cost) && cost > 0) record.gatewayCostUsd = cost;
    return observeResponse(response, record, (usage) => {
      scope.tokensUsed += usage.promptTokens + usage.completionTokens;
    });
  };

  const imageEdit = async (
    scope: EvalSampleScope,
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const instruction = typeof body.prompt === 'string' ? body.prompt : '';
    const image = typeof body.image === 'string' ? body.image : '';
    scope.imageEditRequests.push({
      instruction,
      referenceSha256: sha256(Buffer.from(image.slice(image.indexOf(',') + 1), 'base64')),
    });
    const record: EvalCallRecord = {
      kind: 'image-edit',
      stubbed: false,
      startedAt: Date.now(),
      durationMs: 0,
      status: 0,
    };
    scope.calls.push(record);
    if (options.mode === 'integration' && options.realImageEdit === true) {
      const response = await originalFetch(input, init);
      record.status = response.status;
      return observeResponse(response, record, () => undefined);
    }
    if (routerLink !== undefined) {
      const response = await callRouterLinkEdit(routerLink, instruction, image);
      record.status = response.status;
      return observeResponse(response, record, () => undefined);
    }
    // 桩：返回固定的小 PNG，不带 usage（不计入 token 与费用）。
    const stub = { ...record, stubbed: true };
    scope.calls[scope.calls.length - 1] = stub;
    stub.status = 200;
    const { bytes } = await evalMediaFile('edited-hero.png')!;
    return Response.json({
      created: 0,
      data: [{ b64_json: bytes.toString('base64'), media_type: 'image/png' }],
    });
  };

  const imageGenerate = async (scope: EvalSampleScope): Promise<Response> => {
    scope.calls.push({
      kind: 'image-generate',
      stubbed: true,
      startedAt: Date.now(),
      durationMs: 0,
      status: 200,
    });
    const { bytes } = await evalMediaFile('edited-hero.png')!;
    return Response.json({ created: 0, data: [{ b64_json: bytes.toString('base64') }] });
  };

  const content = async (
    scope: EvalSampleScope,
    url: URL,
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const generatedMedia = url.pathname.endsWith('/generated-media');
    // 写入（生成媒体落库）在两种模式下都只进内存桩。
    if (generatedMedia && method === 'POST') return storeStubMedia(scope, url, init);
    if (options.mode === 'integration' && !scope.stubContent) {
      return recordPassThrough(scope, 'content-read', () => originalFetch(input, init));
    }
    scope.calls.push({
      kind: 'content-read',
      stubbed: true,
      startedAt: Date.now(),
      durationMs: 0,
      status: 200,
    });
    if (generatedMedia) return Response.json({ message: 'not found' }, { status: 404 });
    if (url.pathname.endsWith('/decksmith/image-references') && method === 'POST') {
      const request = JSON.parse(String(init?.body ?? '{}')) as { objectKey?: string };
      const file = request.objectKey === undefined ? undefined : scope.media.get(request.objectKey);
      if (file === undefined) return Response.json({ message: 'forbidden' }, { status: 403 });
      return Response.json({
        objectKey: request.objectKey,
        downloadUrl: STUB_DOWNLOAD_ORIGIN + request.objectKey,
        expiresInSeconds: 120,
        contentType: file.contentType,
        sizeBytes: file.bytes.byteLength,
        checksumSha256: file.sha256,
        source: request.objectKey!.includes('/generated/') ? 'generated' : 'document',
      });
    }
    // 生成工作区（HTML 起草的设计上下文）等其余读取：按"不存在"处理，生产代码会回退到文档主题。
    return Response.json({ message: 'not found' }, { status: 404 });
  };

  globalThis.fetch = router;
  installed = {
    restore: () => {
      globalThis.fetch = originalFetch;
      installed = undefined;
    },
  };
  return installed.restore;
}

export class EvalTokenCapError extends Error {
  constructor(readonly cap: number) {
    super(`decksmith eval: sample exceeded the token cap (${cap})`);
    this.name = 'EvalTokenCapError';
  }
}

function storeStubMedia(scope: EvalSampleScope, url: URL, init: RequestInit | undefined): Response {
  const declared = new Headers(init?.headers).get('content-type') ?? 'image/png';
  const raw = init?.body;
  // 带来源信息的图片以 JSON 信封上送（imageBase64），普通生成图以原始字节上送。
  const envelope =
    declared === 'application/json'
      ? (JSON.parse(String(raw ?? '{}')) as { contentType?: string; imageBase64?: string })
      : undefined;
  const contentType = envelope?.contentType ?? declared;
  const bytes =
    envelope !== undefined
      ? Buffer.from(envelope.imageBase64 ?? '', 'base64')
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          : Buffer.from(String(raw ?? ''));
  const digest = sha256(bytes);
  const extension = contentType === 'image/jpeg' ? 'jpg' : 'png';
  const objectKey = `${DECKSMITH_REPLAY_OBJECT_KEY_PREFIX}generated/${digest.slice(0, 16)}.${extension}`;
  scope.media.set(objectKey, { bytes, contentType, width: 2, height: 2, sha256: digest });
  const pageId = url.searchParams.get('pageId');
  scope.stored.push({ objectKey, sha256: digest, ...(pageId === null ? {} : { pageId }) });
  scope.calls.push({
    kind: 'content-write-stub',
    stubbed: true,
    startedAt: Date.now(),
    durationMs: 0,
    status: 200,
  });
  return Response.json({
    objectKey,
    downloadUrl: STUB_DOWNLOAD_ORIGIN + objectKey,
    contentType,
    sizeBytes: bytes.byteLength,
    checksumSha256: digest,
  });
}

function serveStubDownload(scope: EvalSampleScope, href: string): Response {
  const file = scope.media.get(href.slice(STUB_DOWNLOAD_ORIGIN.length));
  if (file === undefined) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      'content-type': file.contentType,
      'content-length': String(file.bytes.byteLength),
    },
  });
}

async function recordPassThrough(
  scope: EvalSampleScope,
  kind: EvalCallKind,
  call: () => Promise<Response>,
): Promise<Response> {
  const record: EvalCallRecord = {
    kind,
    stubbed: false,
    startedAt: Date.now(),
    durationMs: 0,
    status: 0,
  };
  scope.calls.push(record);
  try {
    const response = await call();
    record.status = response.status;
    record.durationMs = Date.now() - record.startedAt;
    return response;
  } catch (error) {
    record.durationMs = Date.now() - record.startedAt;
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

/**
 * 把响应体分成两路：一路原样交给生产代码，另一路在后台解析 usage 与上游模型。
 * SSE 取最后一个带 usage 的 data 帧；JSON 直接取 usage。
 */
function observeResponse(
  response: Response,
  record: EvalCallRecord,
  onUsage: (usage: EvalTokenUsage) => void,
): Response {
  if (response.body === null) {
    record.durationMs = Date.now() - record.startedAt;
    return response;
  }
  const [forward, observe] = response.body.tee();
  void (async () => {
    try {
      const text = await new Response(observe).text();
      const frames = text.trimStart().startsWith('{')
        ? [text]
        : text
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .filter((line) => line !== '' && line !== '[DONE]');
      for (const frame of frames) {
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(frame) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (typeof value.model === 'string' && value.model !== '')
          record.responseModel = value.model;
        const usage = readUsage(value.usage);
        if (usage !== undefined) record.usage = usage;
        if (record.error === undefined && typeof value.error === 'object' && value.error !== null) {
          const message = (value.error as { message?: unknown }).message;
          record.error = typeof message === 'string' ? message.slice(0, 300) : 'provider error';
        }
      }
      if (!response.ok && record.error === undefined) record.error = text.slice(0, 300);
      if (record.usage !== undefined) onUsage(record.usage);
    } catch (error) {
      record.error ??= error instanceof Error ? error.message : String(error);
    } finally {
      record.durationMs = Date.now() - record.startedAt;
    }
  })();
  return new Response(forward, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function readUsage(value: unknown): EvalTokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const prompt = numberOr(usage.prompt_tokens ?? usage.input_tokens);
  const completion = numberOr(usage.completion_tokens ?? usage.output_tokens);
  if (prompt === undefined || completion === undefined) return undefined;
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedPromptTokens: numberOr(promptDetails.cached_tokens) ?? 0,
    reasoningTokens: numberOr(completionDetails.reasoning_tokens) ?? 0,
  };
}

function readInvocation(body: Record<string, unknown>): { invocation?: Record<string, unknown> } {
  const metadata = body.metadata as Record<string, unknown> | undefined;
  const span = metadata?.reachany_application_llm_span as Record<string, unknown> | undefined;
  const invocation = span?.invocation;
  return typeof invocation === 'object' && invocation !== null
    ? { invocation: invocation as Record<string, unknown> }
    : {};
}

interface RouterLinkEditConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
}

/** 与 model-service RouterLinkImageEditClient 同形：同源 /api/v1/chat/completions，白名单首个模型。 */
function routerLinkEditConfig(env: ReachDeckModelEnv): RouterLinkEditConfig {
  const apiKey = env.REACHANY_ROUTERLINK_IMAGE_API_KEY?.trim();
  const explicit = env.REACHANY_ROUTERLINK_IMAGE_EDIT_ENDPOINT?.trim();
  const imageEndpoint = env.REACHANY_ROUTERLINK_IMAGE_ENDPOINT?.trim();
  const endpoint =
    explicit !== undefined && explicit !== ''
      ? explicit
      : imageEndpoint !== undefined && imageEndpoint !== ''
        ? new URL('/api/v1/chat/completions', imageEndpoint).toString()
        : undefined;
  if (endpoint === undefined || apiKey === undefined || apiKey === '') {
    throw new Error(
      'decksmith eval: --real-image-edit needs REACHANY_ROUTERLINK_IMAGE_API_KEY and an image endpoint',
    );
  }
  const model =
    (env.REACHANY_ROUTERLINK_IMAGE_EDIT_MODELS ?? 'gemini-nano-banana-2.1')
      .split(',')
      .map((entry) => entry.trim())
      .find((entry) => entry !== '') ?? 'gemini-nano-banana-2.1';
  return { endpoint, apiKey, model };
}

/** 直连 RouterLink 做参考图编辑，并把响应归一成 OpenAI images 形状（与 model-service 一致）。 */
async function callRouterLinkEdit(
  config: RouterLinkEditConfig,
  instruction: string,
  image: string,
): Promise<Response> {
  const upstream = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      modalities: ['image', 'text'],
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    }),
  });
  const payload = (await upstream.json().catch(() => undefined)) as
    | {
        model?: string;
        usage?: unknown;
        choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
      }
    | undefined;
  if (!upstream.ok || payload === undefined) {
    return Response.json(
      { message: 'RouterLink image edit failed' },
      { status: upstream.status || 502 },
    );
  }
  const url = payload.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? '';
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(url);
  if (match === null) {
    return Response.json({ message: 'RouterLink returned no edited image' }, { status: 502 });
  }
  return Response.json({
    created: 0,
    model: payload.model,
    data: [{ b64_json: match[2], media_type: match[1] }],
    usage: payload.usage,
  });
}

function requireModel(model: string | undefined): string {
  if (model === undefined || model.trim() === '')
    throw new Error('decksmith eval: --model is required');
  return model.trim();
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
