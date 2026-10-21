import { EventEmitter } from 'node:events';

import Redis from 'ioredis';

import type { RuntimeEnv } from './env.js';
import { isRuntimeMockMode, resolveRedisConnectionOptions } from './env.js';

type Listener = (eventId: string) => void;

interface RedisNotifierState {
  publisher: Redis;
  subscriber: Redis;
  listeners: Map<string, Set<Listener>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __reachanyRunEventRedisNotifier: RedisNotifierState | undefined;
  // eslint-disable-next-line no-var
  var __reachanyRunEventLocalBus: EventEmitter | undefined;
}

function localBus(): EventEmitter {
  return (globalThis.__reachanyRunEventLocalBus ??= new EventEmitter());
}

function channel(runId: string, env: RuntimeEnv): string {
  const environment = eventDimension(env.REACHANY_ENV ?? 'development', 'REACHANY_ENV');
  const namespace = eventDimension(
    env.REACHANY_QUEUE_NAMESPACE ?? 'reachany',
    'REACHANY_QUEUE_NAMESPACE',
  );
  return `ai-runtime:${environment}:${namespace}:run:${runId}`;
}

function eventDimension(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`${label} is not valid for the Runtime event namespace`);
  }
  return normalized;
}

function redisState(env: RuntimeEnv): RedisNotifierState {
  if (globalThis.__reachanyRunEventRedisNotifier) {
    return globalThis.__reachanyRunEventRedisNotifier;
  }
  const options = resolveRedisConnectionOptions(env);
  const publisher = new Redis(options);
  const subscriber = new Redis(options);
  const state: RedisNotifierState = { publisher, subscriber, listeners: new Map() };
  for (const client of [publisher, subscriber]) {
    client.on('error', (error) => {
      console.error(`[ai-runtime] Redis event notifier error: ${error.message}`);
    });
  }
  subscriber.on('message', (receivedChannel, raw) => {
    const eventId = parseEventId(raw);
    if (!eventId) return;
    for (const listener of state.listeners.get(receivedChannel) ?? []) listener(eventId);
  });
  globalThis.__reachanyRunEventRedisNotifier = state;
  return state;
}

function parseEventId(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as { eventId?: unknown };
    return typeof value.eventId === 'string' ? value.eventId : undefined;
  } catch {
    return undefined;
  }
}

export async function notifyRunEvent(
  runId: string,
  eventId: string,
  env: RuntimeEnv = process.env,
): Promise<void> {
  if (isRuntimeMockMode(env)) {
    localBus().emit(runId, eventId);
    return;
  }
  try {
    await redisState(env).publisher.publish(
      channel(runId, env),
      JSON.stringify({ runId, eventId }),
    );
  } catch (error) {
    console.error(
      `[ai-runtime] Redis event publish failed for Run ${runId}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

export async function subscribeRunEvents(
  runId: string,
  listener: Listener,
  env: RuntimeEnv = process.env,
): Promise<() => Promise<void>> {
  if (isRuntimeMockMode(env)) {
    localBus().on(runId, listener);
    return async () => {
      localBus().off(runId, listener);
    };
  }
  const state = redisState(env);
  const runChannel = channel(runId, env);
  let listeners = state.listeners.get(runChannel);
  if (!listeners) {
    listeners = new Set();
    state.listeners.set(runChannel, listeners);
    await state.subscriber.subscribe(runChannel);
  }
  listeners.add(listener);
  return async () => {
    const current = state.listeners.get(runChannel);
    current?.delete(listener);
    if (current?.size === 0) {
      state.listeners.delete(runChannel);
      await state.subscriber.unsubscribe(runChannel);
    }
  };
}

export async function closeRunEventNotifier(): Promise<void> {
  globalThis.__reachanyRunEventLocalBus?.removeAllListeners();
  globalThis.__reachanyRunEventLocalBus = undefined;
  const state = globalThis.__reachanyRunEventRedisNotifier;
  globalThis.__reachanyRunEventRedisNotifier = undefined;
  if (state) await Promise.all([state.publisher.quit(), state.subscriber.quit()]);
}
