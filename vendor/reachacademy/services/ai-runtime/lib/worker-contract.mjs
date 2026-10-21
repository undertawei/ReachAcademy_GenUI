import channelDefinitions from './worker-channels.json' with { type: 'json' };

export const WORKER_CHANNELS = Object.freeze(
  Object.fromEntries(
    Object.entries(channelDefinitions).map(([key, value]) => [key, Object.freeze(value)]),
  ),
);
export const WORKER_GROUP_KEYS = Object.freeze([
  'deck',
  'tutor',
  'feedforward',
  'video-processing',
]);
export const WORKER_GROUPS = Object.freeze(
  Object.fromEntries(
    WORKER_GROUP_KEYS.map((group) => [
      group,
      Object.freeze(
        Object.values(WORKER_CHANNELS)
          .filter((channel) => channel.group === group)
          .map((channel) => channel.key),
      ),
    ]),
  ),
);

/** Preserve the existing consumer's parseInt/fallback behavior outside strict deployment validation. */
export function resolveChannelConcurrency(channel, env = {}) {
  const raw = env[channel.concurrencyEnv];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : channel.defaultConcurrency;
}

export function requireQueueDimension(value, name) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${name} must be an explicit 1-64 character queue dimension`);
  }
  return value;
}

/** Shared by the observer, worker startup validation and the plain-Node deployment renderer. */
export function resolveWorkerContract(env) {
  const environment = requireQueueDimension(env.REACHANY_ENV, 'REACHANY_ENV');
  const namespace = requireQueueDimension(env.REACHANY_QUEUE_NAMESPACE, 'REACHANY_QUEUE_NAMESPACE');
  const concurrencyNames = new Set(
    Object.values(WORKER_CHANNELS).map((channel) => channel.concurrencyEnv),
  );
  if (
    Object.keys(env).some(
      (key) => /^AI_RUNTIME_.*CONCURRENCY$/.test(key) && !concurrencyNames.has(key),
    )
  ) {
    throw new Error('Worker contract contains an unknown AI_RUNTIME concurrency override');
  }
  const channels = Object.values(WORKER_CHANNELS).map((channel) => {
    const raw = env[channel.concurrencyEnv];
    if (
      raw !== undefined &&
      (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 1024)
    ) {
      throw new Error(`${channel.concurrencyEnv} must be an integer from 1 to 1024`);
    }
    return Object.freeze({ ...channel, concurrency: resolveChannelConcurrency(channel, env) });
  });
  return Object.freeze({ environment, namespace, channels: Object.freeze(channels) });
}
