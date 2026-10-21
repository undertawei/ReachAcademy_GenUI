import { readHs256ServiceJwtConfig } from '@reachany/auth';

import { readDecksmithEventStoreConfig } from './decksmith/event-store.js';

import {
  createReachDeckEventStoreRedisSource,
  type ReachDeckEventStoreRedisSource,
} from './queue.js';

type CheckDependency = () => Promise<boolean>;
type ValidateJwt = () => void;
type ReachDeckReadinessEnv = Partial<Record<string, string | undefined>>;

export interface TeacherDeckDependencyReadinessOptions {
  checkContent?: CheckDependency;
  checkEventStore?: CheckDependency;
  checkModel?: CheckDependency;
  env?: ReachDeckReadinessEnv;
  validateJwt?: ValidateJwt;
}

/** Dependencies that are specific to the native teacher.deck Scene. */
export async function readTeacherDeckDependencyReadiness(
  options: TeacherDeckDependencyReadinessOptions = {},
): Promise<{
  jwt: 'ready';
  eventStore: 'ready';
  content: 'ready';
  model: 'ready';
}> {
  const env = options.env ?? process.env;
  (options.validateJwt ?? (() => readHs256ServiceJwtConfig(env)))();
  const [eventStore, content, model] = await Promise.all([
    (options.checkEventStore ?? (() => checkReachDeckEventStoreReadiness({ env })))(),
    (options.checkContent ?? (() => checkReachDeckContentServiceReadiness({ env })))(),
    (options.checkModel ?? (() => checkReachDeckModelServiceReadiness({ env })))(),
  ]);
  if (!eventStore || !content || !model) {
    throw new Error('teacher.deck dependencies are not ready');
  }
  return { jwt: 'ready', eventStore: 'ready', content: 'ready', model: 'ready' };
}

export async function checkReachDeckEventStoreReadiness(
  options: {
    createSource?: () => Promise<ReachDeckEventStoreRedisSource>;
    env?: ReachDeckReadinessEnv;
  } = {},
): Promise<boolean> {
  let source: ReachDeckEventStoreRedisSource | undefined;
  let ready = false;
  try {
    readDecksmithEventStoreConfig(options.env);
    source = await (options.createSource ?? createReachDeckEventStoreRedisSource)();
    const client = await source.client;
    await client.xrange(source.streamKey('readiness-probe'), '-', '+', 'COUNT', 1);
    ready = true;
  } catch {
    // A fixed not-ready state is returned below.
  } finally {
    if (source !== undefined) {
      try {
        await source.close();
      } catch {
        ready = false;
      }
    }
  }
  return ready;
}

export async function checkReachDeckContentServiceReadiness(
  options: {
    env?: ReachDeckReadinessEnv;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  return checkServiceReadiness(
    options.env?.REACHANY_CONTENT_BASE_URL ?? 'http://127.0.0.1:8000',
    options.fetch ?? fetch,
    options.timeoutMs,
  );
}

export async function checkReachDeckModelServiceReadiness(
  options: {
    env?: ReachDeckReadinessEnv;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  return checkServiceReadiness(
    options.env?.REACHANY_MODEL_BASE_URL ?? 'http://127.0.0.1:8100',
    options.fetch ?? fetch,
    options.timeoutMs,
  );
}

async function checkServiceReadiness(
  rawBaseUrl: string,
  fetchImplementation: typeof fetch,
  timeoutMs = 6_000,
): Promise<boolean> {
  try {
    const url = new URL(rawBaseUrl.endsWith('/') ? rawBaseUrl : rawBaseUrl + '/');
    url.pathname = url.pathname.replace(/\/(?:api\/v1|v1)\/?$/, '').replace(/\/+$/, '') + '/readyz';
    url.search = '';
    url.hash = '';
    const response = await fetchImplementation(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}
