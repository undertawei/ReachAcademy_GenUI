import { resolveWorkerContract, type WorkerContract } from './worker-contract.mjs';
import { resolveRedisConnectionOptions } from './env.js';
import type { RuntimeEnv } from './runtime-mode.js';

export interface WorkerMetricsConfig {
  contract: WorkerContract;
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  intervalMs: number;
  sampleTimeoutMs: number;
  commandTimeoutMs: number;
  connectTimeoutMs: number;
  freshnessMs: number;
  redis: ReturnType<typeof resolveRedisConnectionOptions>;
}

export function resolveWorkerMetricsConfig(env: RuntimeEnv): WorkerMetricsConfig {
  const contract = resolveWorkerContract(env);
  const host = env.AI_RUNTIME_WORKER_METRICS_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('AI_RUNTIME_WORKER_METRICS_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  const config: WorkerMetricsConfig = {
    contract,
    host,
    port: integer(env, 'AI_RUNTIME_WORKER_METRICS_PORT', 9464, 1, 65535),
    intervalMs: integer(env, 'AI_RUNTIME_WORKER_METRICS_INTERVAL_MS', 10_000, 100, 60_000),
    sampleTimeoutMs: integer(
      env,
      'AI_RUNTIME_WORKER_METRICS_SAMPLE_TIMEOUT_MS',
      5_000,
      100,
      30_000,
    ),
    commandTimeoutMs: integer(
      env,
      'AI_RUNTIME_WORKER_METRICS_COMMAND_TIMEOUT_MS',
      2_000,
      50,
      15_000,
    ),
    connectTimeoutMs: integer(
      env,
      'AI_RUNTIME_WORKER_METRICS_CONNECT_TIMEOUT_MS',
      2_000,
      50,
      15_000,
    ),
    freshnessMs: integer(env, 'AI_RUNTIME_WORKER_METRICS_FRESHNESS_MS', 30_000, 1000, 120_000),
    redis: resolveRedisConnectionOptions(env),
  };
  if (
    config.commandTimeoutMs > config.sampleTimeoutMs ||
    config.connectTimeoutMs > config.sampleTimeoutMs ||
    config.intervalMs + config.sampleTimeoutMs >= config.freshnessMs
  ) {
    throw new Error(
      'Worker metrics timeouts must fit within the sample budget and freshness window',
    );
  }
  return config;
}

function integer(
  env: RuntimeEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[key];
  const value = raw === undefined ? fallback : /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
