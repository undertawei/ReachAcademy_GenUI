import type { RuntimeEnv } from './env.js';
import type { WorkerChannelDefinition } from './scenes.js';

const QUEUE_DIMENSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function resolveRuntimeChannelQueuePrefix(
  channel: WorkerChannelDefinition,
  env: RuntimeEnv = process.env,
): string {
  const environment = queueDimension(env.REACHANY_ENV ?? 'development', 'REACHANY_ENV');
  const namespace = queueDimension(
    env.REACHANY_QUEUE_NAMESPACE ?? 'reachany',
    'REACHANY_QUEUE_NAMESPACE',
  );
  return `{ai-runtime:${environment}:${namespace}:${channel.queueSlot}}`;
}

function queueDimension(value: string, label: string): string {
  const normalized = value.trim();
  if (!QUEUE_DIMENSION_PATTERN.test(normalized)) {
    throw new Error(
      `${label} must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return normalized;
}
