import Redis from 'ioredis';
import type { MaterialReference, WorkspaceMaterialSources } from '@reachany/reach-deck-dsl';
import { resolveRedisConnectionOptions } from '../env.js';
import { resolveReachDeckQueuePrefix } from './queue.js';
import { parseReachDeckResourceScope } from './resource-scope.js';
import type { ContentServiceRequestOptions } from './content-service-client.js';
import { materialDigest, type MaterialWarning } from './material-parser.js';

export const PREPARED_MATERIAL_TTL_SECONDS = 3600;
export class MaterialPreparationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'MaterialPreparationError';
  }
}
export interface PreparedMaterialOptions {
  webSearch: boolean;
  generationLanguage?: string;
  systemLanguage?: string;
}
export interface MaterialPreparationCapacity {
  estimatedInput: number;
  allowedInput: number;
  sourceCharacters: number;
  referenceCount: number;
}
export interface PreparedMaterialSummary {
  preparationId: string;
  expiresAt: number;
  fileCount: number;
  documentCount: number;
  imageCount: number;
  sourceCharacters: number;
  referenceCount: number;
  capacity: MaterialPreparationCapacity;
  warnings: MaterialWarning[];
}
export interface PreparedReachDeckMaterials {
  summary: PreparedMaterialSummary;
  identity: string;
  fingerprint: string;
  source: string;
  sourceDigest: string;
  materialReferences: MaterialReference[];
  materialSources?: WorkspaceMaterialSources;
  options: PreparedMaterialOptions;
  warnings: MaterialWarning[];
}
export interface PreparedMaterialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: 'EX', seconds: number, condition: 'NX'): Promise<unknown>;
}
let client: Redis | undefined;
async function redis(): Promise<PreparedMaterialStore> {
  if (client === undefined || client.status === 'end') {
    client = new Redis({
      ...resolveRedisConnectionOptions(),
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      commandTimeout: 3000,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
  }
  if (client.status === 'wait') await client.connect();
  return client;
}
export function preparedMaterialIdentity(
  scoped: ContentServiceRequestOptions,
  source: string,
  options: PreparedMaterialOptions,
): string {
  // Multipart form serialization uses CRLF, while JSON preserves the author's line endings.
  // Normalize identity only; the prepared source and its integrity digest remain unchanged.
  return materialIdentity(scoped, source.replace(/\r\n?/g, '\n'), options);
}
function materialIdentity(
  scoped: ContentServiceRequestOptions,
  source: string,
  options: PreparedMaterialOptions,
): string {
  return materialDigest(
    JSON.stringify({
      actorId: scoped.actorId,
      billingGroupId: scoped.billingGroupId ?? null,
      roleGrantId: scoped.roleGrantId,
      resourceScope: parseReachDeckResourceScope(scoped.resourceScope),
      brief: source.trim(),
      options,
    }),
  );
}
function key(preparationId: string) {
  return `${resolveReachDeckQueuePrefix()}:prepared-material:${preparationId}`;
}
export async function findPreparedReachDeckMaterials(
  preparationId: string,
  store?: PreparedMaterialStore,
): Promise<PreparedReachDeckMaterials | undefined> {
  if (!/^material-[a-f0-9]{64}$/.test(preparationId))
    throw new MaterialPreparationError(400, 'material_preparation_invalid');
  let raw: string | null;
  try {
    raw = await (store ?? (await redis())).get(key(preparationId));
  } catch {
    throw new MaterialPreparationError(503, 'material_preparation_store_unavailable');
  }
  if (raw === null) return undefined;
  try {
    const record = JSON.parse(raw) as PreparedReachDeckMaterials;
    if (record.summary.preparationId !== preparationId || record.summary.expiresAt <= Date.now())
      return undefined;
    if (materialDigest(record.source) !== record.sourceDigest)
      throw new Error('Corrupt preparation');
    return record;
  } catch {
    throw new MaterialPreparationError(503, 'material_preparation_store_invalid');
  }
}
export async function storePreparedReachDeckMaterials(
  record: PreparedReachDeckMaterials,
  store?: PreparedMaterialStore,
): Promise<PreparedReachDeckMaterials> {
  try {
    const target = store ?? (await redis());
    const created = await target.set(
      key(record.summary.preparationId),
      JSON.stringify(record),
      'EX',
      PREPARED_MATERIAL_TTL_SECONDS,
      'NX',
    );
    if (created) return record;
    const existing = await findPreparedReachDeckMaterials(record.summary.preparationId, target);
    if (
      !existing ||
      existing.identity !== record.identity ||
      existing.fingerprint !== record.fingerprint ||
      existing.sourceDigest !== record.sourceDigest
    )
      throw new MaterialPreparationError(409, 'material_preparation_conflict');
    return existing;
  } catch (error) {
    if (error instanceof MaterialPreparationError) throw error;
    throw new MaterialPreparationError(503, 'material_preparation_store_unavailable');
  }
}
export async function loadPreparedReachDeckMaterials(
  input: {
    preparationId: string;
    source: string;
    scoped: ContentServiceRequestOptions;
    webSearch?: boolean;
    generationLanguage?: string;
    systemLanguage?: string;
    acceptWarnings?: boolean;
  },
  store?: PreparedMaterialStore,
): Promise<PreparedReachDeckMaterials> {
  const record = await findPreparedReachDeckMaterials(input.preparationId, store);
  if (!record) throw new MaterialPreparationError(410, 'material_preparation_expired');
  const options = {
    webSearch: input.webSearch === true,
    ...(input.generationLanguage === undefined
      ? {}
      : { generationLanguage: input.generationLanguage }),
    ...(input.systemLanguage === undefined ? {} : { systemLanguage: input.systemLanguage }),
  };
  const canonicalSource = input.source.replace(/\r\n?/g, '\n');
  // One-hour records created before newline normalization contain the original brief hash.
  // Every candidate still binds all caller scope/options; never infer them from stored text.
  const identitySources = new Set([
    canonicalSource,
    input.source,
    canonicalSource.replace(/\n/g, '\r\n'),
    canonicalSource.replace(/\n/g, '\r'),
  ]);
  if (
    ![...identitySources].some(
      (source) => record.identity === materialIdentity(input.scoped, source, options),
    )
  )
    throw new MaterialPreparationError(409, 'material_preparation_scope_mismatch');
  return record;
}
