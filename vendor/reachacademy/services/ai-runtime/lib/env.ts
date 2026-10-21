import { Agent, type Dispatcher } from 'undici';

import { isRuntimeMockMode, type RuntimeEnv } from './runtime-mode.js';

// 既有调用方一直从这里取这两个符号，保持原样导出。
export { isRuntimeMockMode };
export type { RuntimeEnv };

// 外层调用必须覆盖 model-service 的 60s 准入、90s 流式握手和内部响应预算，
// 避免 Runtime 先取消后重试、而上一次供应商调用仍在执行。
export const DEFAULT_MODEL_NON_STREAM_CALL_TIMEOUT_MS = 690_000;
export const DEFAULT_MODEL_STREAM_CALL_TIMEOUT_MS = 840_000;

export function requireEnv(env: RuntimeEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalEnv(env: RuntimeEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function resolveDatabaseUrl(env: RuntimeEnv = process.env): string {
  const configured = optionalEnv(env, 'REACHANY_DATABASE_URL');
  if (configured) return configured;
  const host = requireEnv(env, 'POSTGRES_HOST');
  const port = optionalEnv(env, 'POSTGRES_PORT') ?? '5432';
  const database = requireEnv(env, 'POSTGRES_DB');
  const username = encodeURIComponent(requireEnv(env, 'POSTGRES_USER'));
  const password = encodeURIComponent(requireEnv(env, 'POSTGRES_PASSWORD'));
  return `postgresql://${username}:${password}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function resolveRedisUrl(env: RuntimeEnv = process.env): string {
  const configured = optionalEnv(env, 'REACHANY_REDIS_URL') ?? optionalEnv(env, 'REDIS_URL');
  if (configured) return configured;
  const host = requireEnv(env, 'REDIS_HOST');
  const port = optionalEnv(env, 'REDIS_PORT') ?? '6379';
  const username = optionalEnv(env, 'REDIS_USERNAME');
  const password = optionalEnv(env, 'REDIS_PASSWORD');
  const credentials =
    username || password
      ? `${encodeURIComponent(username ?? 'default')}:${encodeURIComponent(password ?? '')}@`
      : '';
  return `redis://${credentials}${host}:${port}`;
}

export function resolveRedisConnectionOptions(env: RuntimeEnv = process.env): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
} {
  const url = new URL(resolveRedisUrl(env));
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('Redis URL must use redis or rediss');
  }
  const db = Number(url.pathname.replace('/', '') || 0);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(Number.isFinite(db) && db > 0 ? { db } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export function resolveModelServiceBaseUrl(env: RuntimeEnv = process.env): string {
  return (env.REACHANY_MODEL_BASE_URL ?? 'http://127.0.0.1:8100').replace(/\/+$/, '');
}

export function resolveModelServiceCallTimeoutMs(
  env: RuntimeEnv = process.env,
  mode: 'non-stream' | 'stream',
): number {
  const key =
    mode === 'stream'
      ? 'REACHANY_MODEL_STREAM_CALL_TIMEOUT_MS'
      : 'REACHANY_MODEL_NON_STREAM_CALL_TIMEOUT_MS';
  const fallback =
    mode === 'stream'
      ? DEFAULT_MODEL_STREAM_CALL_TIMEOUT_MS
      : DEFAULT_MODEL_NON_STREAM_CALL_TIMEOUT_MS;
  const configured = optionalEnv(env, key);
  if (configured === undefined) return fallback;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer in milliseconds`);
  }
  return parsed;
}

export function createModelServiceRequestSignal(
  env: RuntimeEnv,
  mode: 'non-stream' | 'stream',
  outerSignal?: AbortSignal,
): AbortSignal {
  const deadline = AbortSignal.timeout(resolveModelServiceCallTimeoutMs(env, mode));
  return outerSignal === undefined ? deadline : AbortSignal.any([outerSignal, deadline]);
}

/** model-service 请求的 fetch 参数：超时信号 + 与之对齐的 undici 连接池。 */
export interface ModelServiceRequestInit extends RequestInit {
  dispatcher?: Dispatcher;
}

/**
 * 按超时预算复用的 undici 连接池，键为毫秒数。
 *
 * Agent 自带连接池，每次请求新建会让连接无法复用；同一预算只需要一个实例。
 */
const modelServiceDispatchers = new Map<number, Agent>();

/**
 * undici 超时相对调用预算的上浮量。
 *
 * 取正值是刻意的：两者若取同一个数，谁先触发取决于计时器抖动，失败要么是
 * TimeoutError 要么是 UND_ERR_HEADERS_TIMEOUT，线上归因时多一层不确定。上浮后
 * AbortSignal 稳定地成为唯一权威，undici 这道只作兜底——它存在的意义是不让
 * 默认的 300 秒盖过配置，而不是自己去当超时判据。
 */
const MODEL_SERVICE_DISPATCHER_MARGIN_MS = 30_000;

/**
 * 取与调用预算对齐的 undici 连接池。
 *
 * 数据源：无 PG/Mongo 读写；仅读取运行时环境变量中的超时配置。
 *
 * 核心逻辑：
 * <ol>
 *   <li>按 mode 解析出本次调用的毫秒预算（与 AbortSignal 用的是同一个函数）</li>
 *   <li>同一预算复用同一个 Agent，避免每请求新建连接池</li>
 *   <li>headersTimeout / bodyTimeout 设成该预算加上兜底上浮量</li>
 * </ol>
 *
 * 设计动机：Node 内建 fetch 底下的 undici 有自己的 headersTimeout（默认 300 秒），
 * 它先于 {@link createModelServiceRequestSignal} 的 AbortSignal 触发，导致 690 秒的
 * 配置形同虚设——任何耗时超过 300 秒的 model-service 调用都不可能成功，配置写多大
 * 都没用（实测 UND_ERR_HEADERS_TIMEOUT 在 301 秒触发）。
 */
export function resolveModelServiceDispatcher(
  env: RuntimeEnv,
  mode: 'non-stream' | 'stream',
): Dispatcher {
  const timeoutMs = resolveModelServiceCallTimeoutMs(env, mode);
  const existing = modelServiceDispatchers.get(timeoutMs);
  if (existing !== undefined) return existing;
  const backstopMs = resolveModelServiceDispatcherTimeoutMs(env, mode);
  const agent = new Agent({ headersTimeout: backstopMs, bodyTimeout: backstopMs });
  modelServiceDispatchers.set(timeoutMs, agent);
  return agent;
}

/**
 * undici 兜底超时的毫秒数：调用预算加上浮量。
 *
 * 单独导出是为了可断言——Agent 把构造选项收在内部符号里读不到，测试只能对着这个
 * 数字锁「兜底值必须严格大于调用预算」，防止两者哪天被改成同一个值又开始抢跑。
 */
export function resolveModelServiceDispatcherTimeoutMs(
  env: RuntimeEnv,
  mode: 'non-stream' | 'stream',
): number {
  return resolveModelServiceCallTimeoutMs(env, mode) + MODEL_SERVICE_DISPATCHER_MARGIN_MS;
}

/**
 * model-service 调用的 fetch 参数：超时信号与 undici 连接池必须成对出现。
 *
 * 调用方以 `...createModelServiceRequestInit(env, mode, signal)` 展开进 fetch init，
 * 而不是分别设置 signal 和 dispatcher——两者拆开写，漏配一个就会退回 undici 的
 * 300 秒默认值，且失败时表现为普通的传输层错误，很难归因。
 */
export function createModelServiceRequestInit(
  env: RuntimeEnv,
  mode: 'non-stream' | 'stream',
  outerSignal?: AbortSignal,
): { signal: AbortSignal; dispatcher: Dispatcher } {
  return {
    signal: createModelServiceRequestSignal(env, mode, outerSignal),
    dispatcher: resolveModelServiceDispatcher(env, mode),
  };
}

export function resolveContentBaseUrl(env: RuntimeEnv = process.env): string {
  return (env.REACHANY_CONTENT_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
}

export function resolveStudentBaseUrl(env: RuntimeEnv = process.env): string {
  return (env.REACHANY_STUDENT_BASE_URL ?? 'http://127.0.0.1:8300').replace(/\/+$/, '');
}
