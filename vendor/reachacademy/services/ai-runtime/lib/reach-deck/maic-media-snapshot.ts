import { createHash } from 'node:crypto';

import Redis from 'ioredis';

import { isRuntimeMockMode, resolveRedisConnectionOptions } from '../env.js';
import type {
  ReachDeckMaicMediaResolution,
  ReachDeckMaicMediaResolver,
  ReachDeckMaicRemoteMediaReference,
} from './maic-media.js';
import { parseReachDeckResourceScope, type ReachDeckResourceScope } from './resource-scope.js';

const TTL_SECONDS = 30 * 60;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

interface SnapshotIdentity {
  actorId: string;
  resourceScope: ReachDeckResourceScope;
  applicationId: string;
  sourceDigest: string;
  mapping: {
    schemaVersion: string;
    generatedAt: string;
    profileDigest: string;
    candidateDigest: string;
    mediaDigest: string;
  };
}

interface SnapshotStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: 'EX', seconds: number): Promise<unknown>;
}

let client: Redis | undefined;
const memory = new Map<string, string>();
async function store(): Promise<SnapshotStore> {
  if (isRuntimeMockMode()) {
    return {
      get: async (key) => memory.get(key) ?? null,
      set: async (key, value) => {
        memory.set(key, value);
      },
    };
  }
  if (client === undefined || client.status === 'end') {
    client = new Redis({
      ...resolveRedisConnectionOptions(),
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
  }
  if (client.status === 'wait') await client.connect();
  return client;
}

function key(identity: SnapshotIdentity): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        ...identity,
        resourceScope: parseReachDeckResourceScope(identity.resourceScope),
      }),
    )
    .digest('hex');
  return `ai-runtime:${process.env.REACHANY_ENV ?? 'development'}:${process.env.REACHANY_QUEUE_NAMESPACE ?? 'reachany'}:maic-media-preview:v1:${digest}`;
}

/** Retain both successes and failures: a degraded confirmation accepts this exact page set. */
export async function storeMaicMediaSnapshot(
  identity: SnapshotIdentity,
  references: readonly ReachDeckMaicRemoteMediaReference[],
  resolution: ReachDeckMaicMediaResolution,
): Promise<void> {
  // Preview URLs are short lived and never part of the mapping identity or apply input.
  const resolved = [...resolution.resolved].map(([id, { previewUrl: _preview, ...media }]) => [
    id,
    media,
  ]);
  const raw = JSON.stringify({
    references,
    resolved,
    failures: resolution.failures,
    expiresAt: Date.now() + TTL_SECONDS * 1000,
  });
  if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES)
    throw new Error('MAIC media preview exceeds the snapshot limit');
  await (await store()).set(key(identity), raw, 'EX', TTL_SECONDS);
}

export function restoreMaicMediaResolver(identity: SnapshotIdentity): ReachDeckMaicMediaResolver {
  return async (references) => {
    let raw: string | null;
    try {
      raw = await (await store()).get(key(identity));
    } catch {
      throw snapshotUnavailable();
    }
    if (raw === null || Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) throw snapshotUnavailable();
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw snapshotUnavailable();
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      JSON.stringify(value.references) !== JSON.stringify(references) ||
      !Array.isArray(value.resolved) ||
      !Array.isArray(value.failures)
    )
      throw snapshotUnavailable();
    try {
      return {
        resolved: new Map(value.resolved),
        failures: value.failures,
      } as ReachDeckMaicMediaResolution;
    } catch {
      throw snapshotUnavailable();
    }
  };
}

export class ReachDeckMaicSnapshotUnavailableError extends Error {}
function snapshotUnavailable(): ReachDeckMaicSnapshotUnavailableError {
  return new ReachDeckMaicSnapshotUnavailableError(
    'MAIC media preview expired or is unavailable; parse and preview the file again',
  );
}
