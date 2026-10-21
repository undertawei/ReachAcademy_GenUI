import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import {
  createSpeechPreviewModelToken,
  type SpeechPreviewModelContext,
} from './speech-preview-context.js';
import {
  createModelServiceToken,
  resolveModelServiceOpenAiBaseUrl,
  type ReachDeckInvocationContract,
  type ReachDeckModelEnv,
  type ReachDeckModelRequestContext,
} from './model-service-client.js';
import { createModelServiceRequestInit } from '../env.js';

type FetchLike = typeof fetch;

export const REACH_DECK_TOOL_CAPABILITIES = {
  image: 'image.courseware.reach-deck.slide',
  imageEdit: 'image.courseware.reach-deck.edit',
  tts: 'tts.courseware.reach-deck.narration',
  pdfParse: 'document.courseware.reach-deck.pdf-parse',
  webSearch: 'search.courseware.reach-deck.web',
} as const;

export interface ReachDeckWebSearchSource {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface ReachDeckWebSearchResult {
  query: string;
  answer: string;
  sources: ReachDeckWebSearchSource[];
  responseTime: number;
  provider: string;
}

export interface ReachDeckParsedDocument {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  markdown: string;
  pageCount?: number;
  provider: string;
  images?: readonly {
    sha256: string;
    mimeType: string;
    source: 'embedded' | 'direct';
    page?: number;
    dataBase64?: string;
    assetId?: string;
  }[];
}

export interface ReachDeckGeneratedImage {
  url?: string;
  base64?: string;
  revisedPrompt?: string;
}

/** Usage reported by model-service for one image edit; billed to the run as ordinary tool usage. */
export interface ReachDeckImageEditUsage {
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ReachDeckEditedImage extends ReachDeckGeneratedImage {
  base64: string;
  contentType?: string;
  width?: number;
  height?: number;
  usage?: ReachDeckImageEditUsage;
}

/** model-service `/v1/images/edits` limits (see docs/wiki/services/model-service.md). */
export const REACH_DECK_IMAGE_EDIT_MAX_PROMPT_CHARACTERS = 4000;
const IMAGE_EDIT_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_EDIT_MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

export interface ReachDeckSpeechAudio {
  bytes: Uint8Array;
  contentType: string;
  /** Monotonic count of real provider executions for this logical queue identity. */
  upstreamAttempts?: number;
  /** 词级时间戳（秒，相对音频起点）；未请求时间戳时可以缺失。 */
  timestamps?: ReachDeckSpeechTimestamp[];
}

/**
 * 一个词条目及其在音频中的起止秒。
 *
 * `char` 来自 model-service 字幕对齐结果的原文词条：通常是单个汉字，但可能吸附标点
 * （如 `"好，"`）而占多个字符——对齐时按其非空白长度消费输入字符位，不能假设恒为
 * 一个字符（见 narration-timing.ts）。
 */
export interface ReachDeckSpeechTimestamp {
  char: string;
  start: number;
  end: number;
}

export type ReachDeckTtsErrorReason =
  | 'TTS_ADMISSION_FULL'
  | 'TTS_PROVIDER_RATE_LIMITED'
  | 'TTS_QUEUE_CAPACITY_EXCEEDED'
  | 'TTS_QUEUE_CANCELLED'
  | 'TTS_QUEUE_DEADLINE_EXCEEDED'
  | 'TTS_REQUEST_IDENTITY_CONFLICT'
  | 'TTS_ADMISSION_UNAVAILABLE'
  | 'TTS_LEASE_LOST'
  | 'TTS_SSML_UNSUPPORTED_VOICE';

export type ReachDeckTtsAttemptOutcome = 'running' | 'provider_rate_limited' | 'succeeded';

export interface ReachDeckTtsQueueAttempt {
  ordinal: number;
  outcome: ReachDeckTtsAttemptOutcome;
}

export interface ReachDeckTtsQueueState {
  protocol: 'tts-queue/v1';
  status: 'queued' | 'running';
  ticket: string;
  queuedAtEpochMillis: number;
  expiresAtEpochMillis: number;
  pollAfterMillis: number;
  upstreamAttempts: number;
  lastAttempt?: ReachDeckTtsQueueAttempt;
}

/**
 * model-service `ErrorCode.MODEL_OUTPUT_INVALID`：上游已应答（可能已计费）但输出不合规，HTTP 502。
 * 再调一次同样要付费且大概率同样失败，因此不按 5xx 重试。
 */
const MODEL_OUTPUT_INVALID_CODE = 5602;
const TTS_ERROR_REASON_HEADER = 'x-reachany-tts-error-code';
const TTS_ERROR_REASONS = new Set<ReachDeckTtsErrorReason>([
  'TTS_ADMISSION_FULL',
  'TTS_PROVIDER_RATE_LIMITED',
  'TTS_QUEUE_CAPACITY_EXCEEDED',
  'TTS_QUEUE_CANCELLED',
  'TTS_QUEUE_DEADLINE_EXCEEDED',
  'TTS_REQUEST_IDENTITY_CONFLICT',
  'TTS_ADMISSION_UNAVAILABLE',
  'TTS_LEASE_LOST',
  'TTS_SSML_UNSUPPORTED_VOICE',
]);

const TTS_ASYNC_PROTOCOL_HEADER = 'X-ReachAny-TTS-Async';
const TTS_REQUEST_IDENTITY_HEADER = 'X-ReachAny-TTS-Request-Identity';
const TTS_UPSTREAM_ATTEMPTS_HEADER = 'x-reachany-tts-upstream-attempts';
const TTS_VOICE_CLONE_CAPABILITY_HEADER = 'X-ReachAny-Voice-Clone-Capability';
const TTS_CANCEL_OUTCOME_HEADER = 'x-reachany-tts-cancel-outcome';

export type ReachDeckTtsCancelOutcome = 'cancelled_pre_provider' | 'draining' | 'not_found';

export class ReachDeckTtsQueuedError extends Error {
  constructor(
    readonly queue: ReachDeckTtsQueueState,
    /** 排队票据对应的请求身份；任务重入前用它向 model-service 只读探询，不必先重建整段请求。 */
    readonly requestIdentity?: string,
  ) {
    super('Reach Deck narration audio is waiting for TTS capacity');
    this.name = 'ReachDeckTtsQueuedError';
  }
}

/** 只读探询结果：`queued` 表示此刻提交仍拿不到槽位，`proceed` 表示应走完整提交。 */
export interface ReachDeckTtsAdmissionPeek {
  status: 'queued' | 'proceed';
  pollAfterMillis: number;
}

export class ReachDeckModelToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly reasonCode?: ReachDeckTtsErrorReason,
    readonly upstreamAttempts?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ReachDeckModelToolError';
  }
}

interface ToolOptions {
  context: ReachDeckModelRequestContext;
  env?: ReachDeckModelEnv;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface ReachDeckImageSearchCandidate {
  id: string;
  title: string;
  sourceUrl?: string;
  imageUrl: string;
  width: number;
  height: number;
  description?: string;
  publishedAt?: string;
  watermark?: number;
}

export async function searchReachDeckImages(query: string, options: ToolOptions) {
  const value = record(
    await requestManagedTool('/reach-deck/tools/image-search', options, {
      query: requireNonblank(query, 'query'),
      maxResults: 5,
      invocation: {
        scene_id: 'teacher.deck',
        orchestration: 'courseware.deck',
        stage: 'image-search',
        tool: 'search_image',
        channel: 'web-search',
      },
      trace: toolTrace(options.context, 'image-search'),
    }),
    'image search result',
  );
  return {
    provider: string(value.provider, 'provider'),
    images: array(value.images, 'images')
      .slice(0, 5)
      .map((entry) => {
        const x = record(entry, 'image candidate');
        return {
          id: string(x.id, 'id'),
          title: optionalString(x.title),
          sourceUrl: optionalString(x.sourceUrl),
          imageUrl: string(x.imageUrl, 'imageUrl'),
          width: finiteNumber(x.width, 'width'),
          height: finiteNumber(x.height, 'height'),
          description: optionalString(x.description),
          publishedAt: optionalString(x.publishedAt),
          ...(typeof x.watermark === 'number' && x.watermark >= 0
            ? { watermark: x.watermark }
            : {}),
        } as ReachDeckImageSearchCandidate;
      }),
  };
}

export async function searchReachDeckWeb(
  query: string,
  options: ToolOptions & { maxResults?: number },
): Promise<ReachDeckWebSearchResult> {
  const value = await requestManagedTool('/reach-deck/tools/web-search', options, {
    query: requireNonblank(query, 'query'),
    maxResults: options.maxResults ?? 5,
    invocation: toolInvocation(REACH_DECK_TOOL_CAPABILITIES.webSearch, 'web-search'),
    trace: toolTrace(options.context, 'source-research'),
  });
  const result = record(value, 'web search result');
  return {
    query: string(result.query, 'query'),
    answer: optionalString(result.answer),
    sources: array(result.sources, 'sources').map((entry) => {
      const source = record(entry, 'web search source');
      return {
        title: optionalString(source.title),
        url: string(source.url, 'source url'),
        content: optionalString(source.content),
        score: finiteNumber(source.score, 'source score'),
      };
    }),
    responseTime: finiteNumber(result.responseTime, 'responseTime'),
    provider: string(result.provider, 'provider'),
  };
}

export async function parseReachDeckPdf(
  file: Blob,
  fileName: string,
  options: ToolOptions,
): Promise<ReachDeckParsedDocument> {
  const env = options.env ?? process.env;
  const token = await createModelServiceToken(env, options.context);
  const form = new FormData();
  form.set('file', file, requireNonblank(fileName, 'fileName'));
  form.set(
    'invocation',
    JSON.stringify(toolInvocation(REACH_DECK_TOOL_CAPABILITIES.pdfParse, 'pdf-parse')),
  );
  const trace = toolTrace(options.context, 'source-document');
  for (const [key, value] of Object.entries(trace)) {
    if (value !== undefined) form.set(key, value);
  }
  const value = await requestJson(
    managedToolUrl(env, '/reach-deck/tools/pdf-parse'),
    {
      method: 'POST',
      headers: { accept: 'application/json', authorization: 'Bearer ' + token },
      body: form,
      signal: options.signal,
    },
    options.fetch,
  );
  const result = record(readEnvelope(value), 'PDF parse result');
  const pageCount =
    result.pageCount === null || result.pageCount === undefined
      ? undefined
      : nonnegativeInteger(result.pageCount, 'pageCount');
  return {
    fileName: string(result.fileName, 'fileName'),
    contentType: string(result.contentType, 'contentType'),
    sizeBytes: nonnegativeInteger(result.sizeBytes, 'sizeBytes'),
    markdown: string(result.markdown, 'markdown'),
    ...(pageCount === undefined ? {} : { pageCount }),
    provider: string(result.provider, 'provider'),
    ...(Array.isArray(result.images)
      ? {
          images: result.images.flatMap((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
            const image = entry as Record<string, unknown>;
            if (
              typeof image.sha256 !== 'string' ||
              !/^[a-f0-9]{64}$/.test(image.sha256) ||
              typeof image.mimeType !== 'string'
            )
              return [];
            return [
              {
                sha256: image.sha256,
                mimeType: image.mimeType,
                source: 'embedded' as const,
                ...(typeof image.pageNumber === 'number' ? { page: image.pageNumber } : {}),
                ...(typeof image.dataBase64 === 'string' ? { dataBase64: image.dataBase64 } : {}),
              },
            ];
          }),
        }
      : {}),
  };
}

export async function generateReachDeckImage(
  prompt: string,
  options: ToolOptions & { pageId?: string; size?: string },
): Promise<ReachDeckGeneratedImage> {
  const value = await requestOpenAiTool('/images/generations', options, {
    prompt: requireNonblank(prompt, 'prompt'),
    n: 1,
    size: options.size ?? '1536x1024',
    response_format: 'b64_json',
    metadata: spanMetadata(
      REACH_DECK_TOOL_CAPABILITIES.image,
      options.context,
      'image-generation',
      options.pageId,
    ),
  });
  const envelope = record(value, 'image generation response');
  const first = array(envelope.data, 'image data')[0];
  const image = record(first, 'generated image');
  const url = nonblankOptionalString(image.url);
  const base64 = nonblankOptionalString(image.b64_json);
  const revisedPrompt = nonblankOptionalString(image.revised_prompt);
  if (url === undefined && base64 === undefined) {
    throw new ReachDeckModelToolError('model-service returned no generated image', 502, true);
  }
  return {
    ...(url === undefined ? {} : { url }),
    ...(base64 === undefined ? {} : { base64 }),
    ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
  };
}

/**
 * Decksmith 参考图编辑：把当前图片（规范化后的 data URL）与教师指令交给 model-service
 * `/v1/images/edits`（RouterLink Gemini，chat + 图片输出）。
 *
 * 数据源：model-service 编辑执行槽 `courseware.deck.decksmith.image-edit`，无本地持久化。
 * 核心逻辑：
 * 1. 本地先校验指令长度与参考图 data URL（类型、Base64、体积），不合规直接 400、不发请求；
 * 2. 请求体只带 prompt / image / n=1 / b64_json 与结构化调用合同 + run/job/page 归属，
 *    不传 model，模型由执行槽策略决定；
 * 3. 解析唯一一张返回图与 usage；usage 由调用方计入本次运行的普通工具用量。
 */
export async function editReachDeckImage(
  prompt: string,
  referenceDataUrl: string,
  options: ToolOptions & { pageId?: string },
): Promise<ReachDeckEditedImage> {
  const instruction = requireNonblank(prompt, 'prompt');
  if (instruction.length > REACH_DECK_IMAGE_EDIT_MAX_PROMPT_CHARACTERS) {
    throw new ReachDeckModelToolError(
      `prompt must not exceed ${REACH_DECK_IMAGE_EDIT_MAX_PROMPT_CHARACTERS} characters`,
      400,
      false,
    );
  }
  if (!IMAGE_EDIT_DATA_URL_PATTERN.test(referenceDataUrl)) {
    throw new ReachDeckModelToolError(
      'reference image must be a PNG, JPEG, or WebP base64 data URL',
      400,
      false,
    );
  }
  const encoded = referenceDataUrl.slice(referenceDataUrl.indexOf(',') + 1);
  if (Math.floor((encoded.length * 3) / 4) > IMAGE_EDIT_MAX_REFERENCE_BYTES) {
    throw new ReachDeckModelToolError('reference image exceeds the 10 MiB limit', 400, false);
  }
  const value = await requestOpenAiTool('/images/edits', options, {
    prompt: instruction,
    image: referenceDataUrl,
    n: 1,
    response_format: 'b64_json',
    metadata: spanMetadata(
      REACH_DECK_TOOL_CAPABILITIES.imageEdit,
      options.context,
      'decksmith',
      options.pageId,
    ),
  });
  const envelope = record(value, 'image edit response');
  const image = record(array(envelope.data, 'image data')[0], 'edited image');
  const base64 = nonblankOptionalString(image.b64_json);
  if (base64 === undefined) {
    throw new ReachDeckModelToolError('model-service returned no edited image', 502, true);
  }
  const contentType = nonblankOptionalString(image.media_type);
  const width = positiveIntegerOrUndefined(image.width);
  const height = positiveIntegerOrUndefined(image.height);
  const usage = readImageEditUsage(envelope.usage);
  return {
    base64,
    ...(contentType === undefined ? {} : { contentType }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function readImageEditUsage(value: unknown): ReachDeckImageEditUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = safeNonnegativeInteger(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = safeNonnegativeInteger(usage.completion_tokens ?? usage.output_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  const totalTokens = safeNonnegativeInteger(usage.total_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens ?? promptTokens + completionTokens,
  };
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * 请求时间戳时透传给 model service 的参数名，已是双方确认的内部契约。
 *
 * model service（本仓 java/model-service 的 `/v1/reach-deck/audio/speech`）收到
 * `with_timestamp: true` 时返回 `{audio, contentType, timestamps[]}` JSON 信封；
 * model service 先完成 Seed-TTS 合成，再以 ASR Fast 对齐权威朗读稿；低可信分片
 * 回退到 Seed Lite。Seed-TTS 自带的 `sentence.words[]` 实测恒为空。
 */
const SPEECH_TIMESTAMP_PARAM = 'with_timestamp';

/** 关掉时间戳链路的特性开关：置 '0'/'false' 即退回纯音频请求。 */
const speechTimestampsEnabled = (env: ReachDeckModelEnv): boolean => {
  const value = env.REACH_DECK_TTS_TIMESTAMPS;
  return value !== '0' && value?.toLowerCase() !== 'false';
};

export async function synthesizeReachDeckSpeech(
  input: string,
  options: Omit<ToolOptions, 'context'> & { context: SpeechPreviewModelContext } & {
    pageId?: string;
    voice?: string;
    speed?: number;
    responseFormat?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac';
    /** Stable identity for the model-service asynchronous queue protocol v1. */
    requestIdentity?: string;
    /** Execution-only capability; callers must never persist or log this value. */
    voiceCloneCapability?: string;
    /** 是否请求字级时间戳；两条对齐路径均失败时请求失败。 */
    withTimestamps?: boolean;
    /** Structured speech requests send SSML while alignment remains XML-free. */
    inputType?: 'plain' | 'ssml';
    alignmentTranscript?: string;
  },
): Promise<ReachDeckSpeechAudio> {
  const env = options.env ?? process.env;
  const token = await createSpeechPreviewModelToken(env, options.context);
  const withTimestamps = (options.withTimestamps ?? false) && speechTimestampsEnabled(env);
  const inputType = options.inputType ?? 'plain';
  if (inputType === 'ssml' && options.alignmentTranscript === undefined) {
    throw new ReachDeckModelToolError(
      'SSML speech synthesis requires an alignment transcript',
      400,
      false,
    );
  }
  if (inputType === 'plain' && options.alignmentTranscript !== undefined) {
    throw new ReachDeckModelToolError(
      'Plain speech synthesis cannot override the alignment transcript',
      400,
      false,
    );
  }
  const response = await request(
    openAiToolUrl(env, '/reach-deck/audio/speech'),
    {
      method: 'POST',
      headers: {
        // 请求时间戳时接受 JSON 信封；两级对齐都失败由 model-service 返回错误。
        accept: withTimestamps
          ? 'application/json,audio/*,application/octet-stream'
          : 'audio/*,application/octet-stream',
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        ...(options.requestIdentity === undefined
          ? {}
          : {
              [TTS_ASYNC_PROTOCOL_HEADER]: 'v1',
              [TTS_REQUEST_IDENTITY_HEADER]: requireTtsRequestIdentity(options.requestIdentity),
            }),
        ...(options.voiceCloneCapability === undefined
          ? {}
          : {
              [TTS_VOICE_CLONE_CAPABILITY_HEADER]: requireOpaqueCapability(
                options.voiceCloneCapability,
              ),
            }),
      },
      body: JSON.stringify({
        input: requireNonblank(input, 'input'),
        ...(inputType === 'ssml'
          ? {
              input_type: 'ssml',
              alignment_transcript: requireNonblank(
                options.alignmentTranscript!,
                'alignmentTranscript',
              ),
            }
          : {}),
        ...(options.voiceCloneCapability === undefined
          ? { voice: requireReachDeckOrdinaryVoice(options.voice) }
          : {}),
        speed: options.speed ?? 1,
        response_format: options.responseFormat ?? 'mp3',
        ...(withTimestamps ? { [SPEECH_TIMESTAMP_PARAM]: true } : {}),
        metadata: spanMetadata(
          REACH_DECK_TOOL_CAPABILITIES.tts,
          options.context,
          'tts',
          options.pageId,
        ),
      }),
      signal: options.signal,
    },
    options.fetch,
  );
  if (response.status === 202) {
    throw new ReachDeckTtsQueuedError(
      parseTtsQueueState(await response.json()),
      options.requestIdentity,
    );
  }
  const upstreamAttempts = parseUpstreamAttemptsHeader(
    response.headers.get(TTS_UPSTREAM_ATTEMPTS_HEADER),
    options.requestIdentity !== undefined,
  );
  const responseContentType =
    response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  if (responseContentType === 'application/json') {
    return parseSpeechEnvelope(await response.json(), upstreamAttempts);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ReachDeckModelToolError('model-service returned empty speech audio', 502, true);
  }
  return { bytes, contentType: responseContentType, upstreamAttempts };
}

export async function cancelReachDeckSpeech(
  requestIdentity: string,
  options: Omit<ToolOptions, 'context'> & {
    context: SpeechPreviewModelContext;
    voice?: string;
    voiceCloneCapability?: string;
  },
): Promise<ReachDeckTtsCancelOutcome | undefined> {
  const env = options.env ?? process.env;
  const token = await createSpeechPreviewModelToken(env, options.context);
  const response = await request(
    openAiToolUrl(env, '/reach-deck/audio/speech'),
    {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer ' + token,
        [TTS_ASYNC_PROTOCOL_HEADER]: 'v1',
        [TTS_REQUEST_IDENTITY_HEADER]: requireTtsRequestIdentity(requestIdentity),
        ...(options.voiceCloneCapability === undefined && options.voice !== undefined
          ? { 'X-Reach-Deck-Tts-Voice': requireReachDeckOrdinaryVoice(options.voice) }
          : {}),
        ...(options.voiceCloneCapability === undefined
          ? {}
          : {
              [TTS_VOICE_CLONE_CAPABILITY_HEADER]: requireOpaqueCapability(
                options.voiceCloneCapability,
              ),
            }),
      },
      signal: options.signal,
    },
    options.fetch,
  );
  if (response.status !== 204) {
    throw new ReachDeckModelToolError(
      'model-service returned an invalid TTS cancel response',
      502,
      true,
    );
  }
  const outcome = response.headers.get(TTS_CANCEL_OUTCOME_HEADER);
  if (outcome === null) return 'draining';
  if (outcome === 'cancelled_pre_provider' || outcome === 'draining' || outcome === 'not_found') {
    return outcome;
  }
  throw new ReachDeckModelToolError(
    'model-service returned an invalid TTS cancel outcome',
    502,
    true,
  );
}

/**
 * 只读探询一张排队中的 Reach Deck 语音票据：model-service 刷新它的最后轮询时间，只回答此刻
 * 提交能否拿到槽位，不授予也不建票。归属与取消一致，由同一任务上下文签发的 token 决定。
 */
export async function peekReachDeckSpeechAdmission(
  requestIdentity: string,
  options: Omit<ToolOptions, 'context'> & { context: SpeechPreviewModelContext },
): Promise<ReachDeckTtsAdmissionPeek> {
  const env = options.env ?? process.env;
  const token = await createSpeechPreviewModelToken(env, options.context);
  const response = await request(
    openAiToolUrl(env, '/reach-deck/audio/speech/admission'),
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        [TTS_ASYNC_PROTOCOL_HEADER]: 'v1',
        [TTS_REQUEST_IDENTITY_HEADER]: requireTtsRequestIdentity(requestIdentity),
      },
      signal: options.signal,
    },
    options.fetch,
  );
  const body = (await response.json().catch(() => null)) as {
    status?: unknown;
    pollAfterMillis?: unknown;
  } | null;
  if (
    response.status !== 200 ||
    body === null ||
    (body.status !== 'queued' && body.status !== 'proceed') ||
    typeof body.pollAfterMillis !== 'number' ||
    !Number.isSafeInteger(body.pollAfterMillis) ||
    body.pollAfterMillis < 0
  ) {
    throw new ReachDeckModelToolError(
      'model-service returned an invalid TTS admission peek response',
      502,
      true,
    );
  }
  return { status: body.status, pollAfterMillis: body.pollAfterMillis };
}

function requireReachDeckOrdinaryVoice(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ReachDeckModelToolError(
      'Reach Deck speech requires a configured ordinary voice',
      400,
      false,
    );
  }
  return value;
}

function requireOpaqueCapability(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 8192 || /[\r\n]/.test(normalized)) {
    throw new ReachDeckModelToolError('Voice clone capability is invalid', 500, false);
  }
  return normalized;
}

/**
 * 解析 JSON 信封 `{audio: base64, contentType, timestamps: [{char,start,end}]}`。
 *
 * 音频缺失才算错（那是真的拿不到产物）；时间戳字段畸形只当作"没有时间戳"，让调用方
 * 降级到占位时间轴——上游时间戳能力是增强项，不该反过来卡住语音合成本身。
 */
function parseSpeechEnvelope(payload: unknown, upstreamAttempts: number): ReachDeckSpeechAudio {
  const envelope = payload as { audio?: unknown; contentType?: unknown; timestamps?: unknown };
  const encoded = nonblankOptionalString(envelope.audio);
  if (encoded === undefined) {
    throw new ReachDeckModelToolError('model-service returned no speech audio', 502, true);
  }
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (bytes.byteLength === 0) {
    throw new ReachDeckModelToolError('model-service returned empty speech audio', 502, true);
  }
  const contentType = nonblankOptionalString(envelope.contentType) ?? 'application/octet-stream';
  const timestamps = parseSpeechTimestamps(envelope.timestamps);
  return {
    bytes,
    contentType,
    upstreamAttempts,
    ...(timestamps === undefined ? {} : { timestamps }),
  };
}

function parseTtsQueueState(payload: unknown): ReachDeckTtsQueueState {
  const envelope = record(payload, 'TTS queue response');
  if (envelope.protocol !== 'tts-queue/v1') {
    throw new ReachDeckModelToolError(
      'model-service returned an unsupported TTS queue protocol',
      502,
      true,
    );
  }
  if (envelope.status !== 'queued' && envelope.status !== 'running') {
    throw new ReachDeckModelToolError(
      'model-service returned an invalid TTS queue status',
      502,
      true,
    );
  }
  const upstreamAttempts = nonnegativeInteger(envelope.upstreamAttempts, 'upstreamAttempts');
  let lastAttempt: ReachDeckTtsQueueAttempt | undefined;
  if (upstreamAttempts > 0) {
    const value = record(envelope.lastAttempt, 'lastAttempt');
    const ordinal = nonnegativeInteger(value.ordinal, 'lastAttempt ordinal');
    if (
      ordinal < 1 ||
      ordinal > upstreamAttempts ||
      (value.outcome !== 'running' &&
        value.outcome !== 'provider_rate_limited' &&
        value.outcome !== 'succeeded')
    ) {
      throw new ReachDeckModelToolError(
        'model-service returned an invalid TTS attempt outcome',
        502,
        true,
      );
    }
    lastAttempt = { ordinal, outcome: value.outcome };
  } else if (envelope.lastAttempt !== undefined) {
    throw new ReachDeckModelToolError(
      'model-service returned a spurious TTS attempt outcome',
      502,
      true,
    );
  }
  const queuedAtEpochMillis = nonnegativeInteger(
    envelope.queuedAtEpochMillis,
    'queuedAtEpochMillis',
  );
  const expiresAtEpochMillis = nonnegativeInteger(
    envelope.expiresAtEpochMillis,
    'expiresAtEpochMillis',
  );
  const pollAfterMillis = nonnegativeInteger(envelope.pollAfterMillis, 'pollAfterMillis');
  if (
    expiresAtEpochMillis <= queuedAtEpochMillis ||
    pollAfterMillis < 1 ||
    pollAfterMillis > 30_000
  ) {
    throw new ReachDeckModelToolError('model-service returned invalid TTS queue timing', 502, true);
  }
  return {
    protocol: 'tts-queue/v1',
    status: envelope.status,
    ticket: requireBoundedString(envelope.ticket, 'ticket', 256),
    queuedAtEpochMillis,
    expiresAtEpochMillis,
    pollAfterMillis,
    upstreamAttempts,
    ...(lastAttempt === undefined ? {} : { lastAttempt }),
  };
}

function parseUpstreamAttemptsHeader(value: string | null, required: boolean): number {
  // Legacy synchronous responses predate the ordinal header. Async v1 must
  // carry it so an ordinary poll can never be mistaken for a provider call.
  if (value === null && !required) return 1;
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new ReachDeckModelToolError(
      'model-service omitted the TTS upstream-attempt count',
      502,
      true,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ReachDeckModelToolError(
      'model-service returned an invalid TTS upstream-attempt count',
      502,
      true,
    );
  }
  return parsed;
}

function requireTtsRequestIdentity(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new ReachDeckModelToolError('TTS request identity is invalid', 400, false);
  }
  return value;
}

function requireBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new ReachDeckModelToolError(`model-service returned invalid ${label}`, 502, true);
  }
  return value;
}

/** ISO 控制字符（C0 与 C1），与 content-service 的 `Character::isISOControl` 判定一致。 */
const ISO_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * 去掉词条文本里的控制字符。
 *
 * 字幕对齐会把转写里的 ignorable scalar（空白与标点）吸附到相邻词条上，所以讲稿 Markdown
 * 的**段内**换行会原样出现在 `char` 里（`alignment_transcript` 只 trim 首尾）。这类词条落库
 * 时会被 content-service 的控制字符校验拒掉，整块讲稿随之失败；纯文本路径也可能拿到带
 * `\t` / `\r` 的 provider 原词。
 *
 * 这里剔除控制字符是**对齐语义上的惰性操作**：`speech-timing-projection.ts` 的
 * `alignableScalars` 与 `alignSpeechTimestamps` 本就按非空白字符消费输入位，词条里的空白
 * 从不参与对齐。普通空格保留——它在英文词条里有显示意义，且不违反存储契约。
 */
function stripIsoControlCharacters(value: string): string {
  return value.replace(ISO_CONTROL_PATTERN, '');
}

function parseSpeechTimestamps(value: unknown): ReachDeckSpeechTimestamp[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const timestamps: ReachDeckSpeechTimestamp[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return undefined;
    const { char, start, end } = entry as Record<string, unknown>;
    if (typeof char !== 'string' || char.length === 0) return undefined;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return undefined;
    if (typeof end !== 'number' || !Number.isFinite(end) || end < start) return undefined;
    const normalized = stripIsoControlCharacters(char);
    // 归一化后只剩空白的条目不承载任何可对齐字符，整条丢弃而不是留下空 `char`。
    if (normalized.trim().length === 0) continue;
    timestamps.push({ char: normalized, start, end });
  }
  // 全部条目都被丢弃时视为"没有时间戳"，沿用本函数既有的降级语义。
  return timestamps.length === 0 ? undefined : timestamps;
}

async function requestManagedTool(
  path: string,
  options: ToolOptions,
  body: Record<string, unknown>,
): Promise<unknown> {
  const env = options.env ?? process.env;
  const token = await createModelServiceToken(env, options.context);
  const value = await requestJson(
    managedToolUrl(env, path),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...createModelServiceRequestInit(env, 'non-stream', options.signal),
    },
    options.fetch,
  );
  return readEnvelope(value);
}

async function requestOpenAiTool(
  path: string,
  options: ToolOptions,
  body: Record<string, unknown>,
): Promise<unknown> {
  const env = options.env ?? process.env;
  const token = await createModelServiceToken(env, options.context);
  return requestJson(
    openAiToolUrl(env, path),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...createModelServiceRequestInit(env, 'non-stream', options.signal),
    },
    options.fetch,
  );
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImplementation: FetchLike = fetch,
): Promise<unknown> {
  const response = await request(url, init, fetchImplementation);
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ReachDeckModelToolError('model-service returned invalid JSON', 502, true);
  }
}

async function request(
  url: string,
  init: RequestInit,
  fetchImplementation: FetchLike = fetch,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImplementation(url, init);
  } catch (error) {
    if (init.signal?.aborted && init.signal.reason?.name !== 'TimeoutError') throw error;
    throw new ReachDeckModelToolError('model-service tool request failed', 503, true);
  }
  if (response.ok) return response;
  const detail = await response.text().catch(() => '');
  const guardrail = guardrailCode(detail);
  if (guardrail) throw new ReachDeckModelToolError(guardrail, response.status, false);
  const reasonCode = parseTtsErrorReason(response.headers.get(TTS_ERROR_REASON_HEADER));
  let message = detail.slice(0, 500);
  let businessCode: unknown;
  try {
    const error = record(JSON.parse(detail) as unknown, 'error envelope');
    message = nonblankOptionalString(error.message) ?? message;
    businessCode = error.code;
  } catch {
    // Keep the bounded provider-safe response text.
  }
  throw new ReachDeckModelToolError(
    message || `model-service tool request failed with HTTP ${response.status}`,
    response.status,
    reasonCode !== 'TTS_LEASE_LOST' &&
      businessCode !== MODEL_OUTPUT_INVALID_CODE &&
      (response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500),
    reasonCode,
    parseOptionalUpstreamAttemptsHeader(response.headers.get(TTS_UPSTREAM_ATTEMPTS_HEADER)),
    parseRetryAfterSeconds(response.headers.get('retry-after')),
  );
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseOptionalUpstreamAttemptsHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ReachDeckModelToolError(
      'model-service returned an invalid TTS upstream-attempt count',
      502,
      true,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ReachDeckModelToolError(
      'model-service returned an invalid TTS upstream-attempt count',
      502,
      true,
    );
  }
  return parsed;
}

function parseTtsErrorReason(value: string | null): ReachDeckTtsErrorReason | undefined {
  if (value === null || !TTS_ERROR_REASONS.has(value as ReachDeckTtsErrorReason)) return undefined;
  return value as ReachDeckTtsErrorReason;
}

function readEnvelope(value: unknown): unknown {
  const envelope = record(value, 'model-service envelope');
  if (envelope.code !== 0) {
    throw new ReachDeckModelToolError(
      nonblankOptionalString(envelope.message) ?? 'model-service rejected the tool request',
      typeof envelope.code === 'number' ? envelope.code : 502,
      typeof envelope.code === 'number' && (envelope.code === 429 || envelope.code >= 500),
    );
  }
  return envelope.data;
}

function toolTrace(context: ReachDeckModelRequestContext, stage: string) {
  return {
    sessionId: context.jobId,
    jobId: context.jobId,
    runId: context.runId,
    stage,
  };
}

function spanMetadata(
  capability: string,
  context: SpeechPreviewModelContext,
  stage: string,
  pageId?: string,
) {
  const invocation = toolInvocation(capability, stage);
  return {
    reachany_application_llm_span: {
      invocation,
      job_id: context.jobId,
      run_id: context.runId,
      ...(pageId === undefined ? {} : { page_id: pageId }),
    },
  };
}

function toolInvocation(capability: string, stage: string): ReachDeckInvocationContract {
  if (capability === REACH_DECK_TOOL_CAPABILITIES.image) {
    return {
      scene_id: 'teacher.deck',
      orchestration: 'courseware.deck',
      stage: 'slide',
      tool: 'generate_image',
      channel: 'image-generation',
    };
  }
  if (capability === REACH_DECK_TOOL_CAPABILITIES.imageEdit) {
    return {
      scene_id: 'teacher.deck',
      orchestration: 'courseware.deck',
      stage: 'decksmith',
      tool: 'edit_image',
      channel: 'image-edit',
    };
  }
  if (capability === REACH_DECK_TOOL_CAPABILITIES.tts) {
    return {
      scene_id: 'teacher.deck',
      orchestration: 'courseware.deck',
      stage: 'narration',
      tool: 'speech-synthesis',
      channel: 'speech-synthesis',
    };
  }
  if (capability === REACH_DECK_TOOL_CAPABILITIES.pdfParse) {
    return {
      scene_id: 'teacher.deck',
      orchestration: 'courseware.deck',
      stage: 'pdf-parse',
      tool: 'read_attachment',
      channel: 'document-extraction',
    };
  }
  if (capability === REACH_DECK_TOOL_CAPABILITIES.webSearch) {
    return {
      scene_id: 'teacher.deck',
      orchestration: 'courseware.deck',
      stage: 'web-search',
      tool: 'search',
      channel: 'web-search',
    };
  }
  // Keep the helper total for future managed tools; unknown tools remain explicitly invalid on
  // the model-service side rather than silently falling back to a capability route.
  return {
    scene_id: 'teacher.deck',
    orchestration: 'courseware.deck',
    stage,
    tool: 'unknown',
    channel: 'unknown',
  };
}

function managedToolUrl(env: ReachDeckModelEnv, path: string): string {
  const url = new URL(resolveModelServiceOpenAiBaseUrl(env));
  url.pathname = url.pathname.replace(/\/v1\/?$/, '') + '/api/v1' + path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function openAiToolUrl(env: ReachDeckModelEnv, path: string): string {
  const url = new URL(resolveModelServiceOpenAiBaseUrl(env));
  url.pathname = url.pathname.replace(/\/+$/, '') + path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReachDeckModelToolError(`${label} must be an object`, 502, true);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ReachDeckModelToolError(`${label} must be an array`, 502, true);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ReachDeckModelToolError(`${label} must be a string`, 502, true);
  }
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nonblankOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function requireNonblank(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new ReachDeckModelToolError(`${label} must be nonblank`, 400, false);
  }
  return value.trim();
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReachDeckModelToolError(`${label} must be finite`, 502, true);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ReachDeckModelToolError(`${label} must be a nonnegative integer`, 502, true);
  }
  return value;
}
