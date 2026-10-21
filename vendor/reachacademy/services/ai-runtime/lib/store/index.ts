import { isRuntimeMockMode, type RuntimeEnv } from '../env.js';
import { MemoryRuntimeStore } from './memory.js';
import { PostgresRuntimeStore } from './postgres.js';
import type { RuntimeStore } from './store.js';
import { observeRuntimeStore } from './observation.js';

declare global {
  // eslint-disable-next-line no-var
  var __reachanyAiRuntimeStore: RuntimeStore | undefined;
}

export function getRuntimeStore(env: RuntimeEnv = process.env): RuntimeStore {
  if (globalThis.__reachanyAiRuntimeStore) return globalThis.__reachanyAiRuntimeStore;
  globalThis.__reachanyAiRuntimeStore = observeRuntimeStore(
    isRuntimeMockMode(env) ? new MemoryRuntimeStore(env) : new PostgresRuntimeStore(env),
  );
  return globalThis.__reachanyAiRuntimeStore;
}

export type { RuntimeStore } from './store.js';
