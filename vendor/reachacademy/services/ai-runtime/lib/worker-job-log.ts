import { getScene } from './scenes.js';
import { observationLogContext } from '@reachany/observability/tracing';

export type RuntimeJobLogEvent =
  | 'run.job.started'
  | 'run.job.completed'
  | 'run.job.failed'
  | 'run.job.delayed'
  | 'run.job.abandoned';

/** worker 事件日志能拿到的 BullMQ job 子集；字段全部可选，形状不符时对应键不出现。 */
export interface RuntimeJobLogSource {
  id?: string | number;
  data?: unknown;
  attemptsMade?: number;
  progress?: unknown;
}

export interface RuntimeJobLogEntry {
  event: RuntimeJobLogEvent;
  runId: string;
  sceneKey: string;
  channelKey?: string;
  queueName: string;
  jobId?: string;
  kind?: string;
  pageId?: string;
  batchId?: string;
  cursor?: number;
  attemptsMade?: number;
  consecutiveFailures?: number;
  courseNodeId?: string;
  moduleId?: string;
  errorType?: string;
  errorCode?: string;
}

export function buildRuntimeJobLogEntry(
  event: RuntimeJobLogEvent,
  queueName: string,
  job: RuntimeJobLogSource | undefined,
  error?: unknown,
): RuntimeJobLogEntry {
  const data =
    job?.data !== null && typeof job?.data === 'object'
      ? (job.data as { runId?: unknown; sceneKey?: unknown; resourceScope?: unknown })
      : undefined;
  // 批次协调 job 没有 runId，此前回落成 job.id 混进 runId 字段，日志里分不清
  // 「同一 job 的反复激活」和「同一 run 的多个分页 job」（2026-09-20 事故复盘）。
  // runId 保持原语义但不再拿 job.id 顶替；job 身份单独走 jobId。
  const runId = safeIdentifier(data?.runId) ?? 'none';
  const sceneKey =
    typeof data?.sceneKey === 'string' && getScene(data.sceneKey) ? data.sceneKey : 'unknown';
  const execution = getScene(sceneKey)?.execution;
  const entry: RuntimeJobLogEntry = {
    event,
    runId,
    sceneKey,
    channelKey: execution?.mode === 'worker' ? execution.channelKey : undefined,
    queueName: safeIdentifier(queueName) ?? 'unknown',
    ...readJobIdentity(job),
    // runId 是 scope + 幂等键的哈希，不可反推。没有这几个 id，线上就只能靠时间窗猜
    // 是哪个模块出的问题（Issue #525 的排查就卡在这里）。只记 id，不记请求体。
    ...readWorkspaceScopeIds(data?.resourceScope),
    ...(error === undefined ? {} : safeWorkerError(error)),
  };
  for (const key of ['jobId', 'pageId', 'batchId', 'courseNodeId', 'moduleId', 'kind'] as const) {
    if (!safeIdentifier(entry[key])) delete entry[key];
  }
  return entry;
}

const SAFE_ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'UnrecoverableError',
  'ReachDeckModelServiceError',
  'ReachDeckProviderOutputError',
  'ReachDeckModelToolError',
  'ReachDeckSpeechTimestampValidationError',
  'ReachDeckTtsQueuedError',
]);
const SAFE_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
]);
export function safeWorkerError(error: unknown): { errorType: string; errorCode?: string } {
  const value = error instanceof Error ? (error as Error & { code?: unknown }) : undefined;
  return {
    errorType: value && SAFE_ERROR_TYPES.has(value.name) ? value.name : 'Error',
    ...(typeof value?.code === 'string' && SAFE_ERROR_CODES.has(value.code)
      ? { errorCode: value.code }
      : {}),
  };
}
function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
    ? value
    : undefined;
}

export function formatRuntimeJobLogLine(entry: Record<string, unknown>): string {
  // This boundary also serves older callers passing errorMessage strings.
  const { errorMessage, error, ...safe } = entry;
  if (errorMessage !== undefined || error !== undefined)
    Object.assign(safe, safeWorkerError(error ?? errorMessage));
  for (const key of [
    'runId',
    'jobId',
    'pageId',
    'batchId',
    'courseNodeId',
    'moduleId',
    'queueName',
    'kind',
  ]) {
    if (safe[key] !== undefined && !safeIdentifier(safe[key])) delete safe[key];
  }
  for (const key of ['traceId', 'spanId', 'requestId']) delete safe[key];
  return `[ai-runtime] ${JSON.stringify({ timestamp: new Date().toISOString(), service: 'ai-runtime', ...safe, ...observationLogContext() })}`;
}

/**
 * 队列 job 自身的身份：jobId 恒有；kind / pageId / batchId / cursor 按各类 payload 的
 * 实际形状取（Reach Deck 分页 job 的 pageId 在 request 里，Decksmith 在顶层，批次协调
 * 只有 batchId+cursor）。attemptsMade 区分 BullMQ 正式重试；协调 job 的主动延迟不计入
 * attempts，靠 progress 里的连续失败数配合 `run.job.delayed` 行判读。
 */
function readJobIdentity(job: RuntimeJobLogSource | undefined): {
  jobId?: string;
  kind?: string;
  pageId?: string;
  batchId?: string;
  cursor?: number;
  attemptsMade?: number;
  consecutiveFailures?: number;
} {
  const data =
    job?.data !== null && typeof job?.data === 'object'
      ? (job.data as {
          jobId?: unknown;
          kind?: unknown;
          pageId?: unknown;
          batchId?: unknown;
          cursor?: unknown;
          request?: unknown;
        })
      : undefined;
  const requestPageId =
    data?.request !== null && typeof data?.request === 'object'
      ? (data.request as { pageId?: unknown }).pageId
      : undefined;
  const pageId = typeof data?.pageId === 'string' ? data.pageId : requestPageId;
  const progress =
    job?.progress !== null && typeof job?.progress === 'object'
      ? (job.progress as { consecutiveFailures?: unknown })
      : undefined;
  const jobId = typeof data?.jobId === 'string' ? data.jobId : job?.id;
  return {
    ...(jobId === undefined ? {} : { jobId: String(jobId) }),
    // 旧式无 kind 的 Reach Deck 生成 job 记为 generation，别让它在日志里长得像缺字段。
    ...(typeof data?.kind === 'string'
      ? { kind: data.kind }
      : typeof data?.jobId === 'string'
        ? { kind: 'generation' }
        : {}),
    ...(typeof pageId === 'string' ? { pageId } : {}),
    ...(typeof data?.batchId === 'string' ? { batchId: data.batchId } : {}),
    ...(typeof data?.cursor === 'number' ? { cursor: data.cursor } : {}),
    ...(typeof job?.attemptsMade === 'number' ? { attemptsMade: job.attemptsMade } : {}),
    ...(typeof progress?.consecutiveFailures === 'number'
      ? { consecutiveFailures: progress.consecutiveFailures }
      : {}),
  };
}

/** 从任意作用域化的 job payload 里取出可写进日志的资源 id；缺省或形状不符时什么都不加。 */
function readWorkspaceScopeIds(resourceScope: unknown): {
  courseNodeId?: string;
  moduleId?: string;
} {
  if (typeof resourceScope !== 'object' || resourceScope === null) return {};
  const scope = resourceScope as { courseNodeId?: unknown; moduleId?: unknown };
  return {
    ...(typeof scope.courseNodeId === 'string' ? { courseNodeId: scope.courseNodeId } : {}),
    ...(typeof scope.moduleId === 'string' ? { moduleId: scope.moduleId } : {}),
  };
}
