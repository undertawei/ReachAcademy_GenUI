import { createHash } from 'node:crypto';

import type { ReachDeckWorkspaceContext } from './workspace-store.js';

export const REACH_DECK_MEDIA_CHECKPOINT_VERSION = 'reach-deck-media-checkpoint/v1' as const;
export const MAX_REACH_DECK_CODE_SOURCE_RECEIPT_BYTES = 512 * 1024;
export const MAX_REACH_DECK_MEDIA_CHECKPOINT_BYTES = 4 * 1024 * 1024;
export const MAX_REACH_DECK_MEDIA_CHECKPOINTS = 256;

interface MediaCheckpointIdentityBase {
  runId: string;
  pageId: string;
  requestedRevision: number;
  /** Identity of the original queued page request. */
  originalRequestHash: string;
  /** Digest of the planned visual asset this call produces (name kept from the checkpoint v1 shape). */
  intentsDigest: string;
  capabilityDigest: string;
  modelInputDigest: string;
  promptVersion: string;
  corpusDigest: string;
}

export type ReachDeckMediaCheckpointIdentity = MediaCheckpointIdentityBase & {
  kind: 'code-source';
  assetId: string;
};

export type ReachDeckMediaCheckpointResult = {
  kind: 'code-source';
  documentHtml: string;
  scientificModel: string[];
  sourceDigest: string;
};

interface MediaCheckpointBase {
  schemaVersion: typeof REACH_DECK_MEDIA_CHECKPOINT_VERSION;
  identity: ReachDeckMediaCheckpointIdentity;
  createdAt: string;
  updatedAt: string;
}

export type ReachDeckMediaCheckpoint = MediaCheckpointBase &
  (
    | { state: 'planned' }
    | { state: 'in_flight' | 'outcome_unknown'; ownerId: string }
    | {
        state: 'completed';
        ownerId: string;
        result: ReachDeckMediaCheckpointResult;
        resultDigest: string;
      }
  );

export type ReachDeckMediaCheckpoints = Record<string, ReachDeckMediaCheckpoint>;

/** There is no provider receipt to recover an unpersisted successful LLM response. */
export class ReachDeckMediaCheckpointOutcomeUnknownError extends Error {
  readonly code = 'REACH_DECK_MEDIA_OUTCOME_UNKNOWN';
  readonly retryable = false;

  constructor() {
    super('Reach Deck media model outcome is unknown; explicit replanning is required');
    this.name = 'ReachDeckMediaCheckpointOutcomeUnknownError';
  }
}

export class ReachDeckMediaCheckpointConflictError extends Error {
  readonly code = 'REACH_DECK_MEDIA_CHECKPOINT_CONFLICT';
  readonly retryable = false;

  constructor() {
    super('Reach Deck media checkpoint identity, owner, or result conflicts');
    this.name = 'ReachDeckMediaCheckpointConflictError';
  }
}

export class ReachDeckMediaCheckpointBudgetError extends Error {
  readonly code = 'REACH_DECK_MEDIA_CHECKPOINT_BUDGET';
  readonly retryable = false;

  constructor() {
    super('Reach Deck media checkpoint exceeds its durable storage budget');
    this.name = 'ReachDeckMediaCheckpointBudgetError';
  }
}

/** Stable key ordering makes semantically identical model input objects share an identity. */
export function reachDeckMediaCheckpointDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function buildReachDeckMediaCheckpointKey(
  identity: ReachDeckMediaCheckpointIdentity,
): string {
  return reachDeckMediaCheckpointDigest(parseIdentity(identity));
}

export function buildReachDeckCodeSourceDigest(
  documentHtml: string,
  scientificModel: readonly string[],
): string {
  return reachDeckMediaCheckpointDigest({ documentHtml, scientificModel });
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw invalid();
  return record;
}

function invalid(): Error {
  return new Error('Reach Deck media checkpoint contract is invalid');
}

function text(value: unknown, limit = 200): string {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    value.trim().length === 0 ||
    value !== value.trim()
  )
    throw invalid();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw invalid();
  return value;
}

function timestamp(value: unknown): string {
  const parsed = text(value, 40);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed)
    throw invalid();
  return parsed;
}

function parseIdentity(value: unknown): ReachDeckMediaCheckpointIdentity {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind !== 'code-source') throw invalid();
  const raw = exact(value, [
    'kind',
    'runId',
    'pageId',
    'requestedRevision',
    'originalRequestHash',
    'intentsDigest',
    'capabilityDigest',
    'modelInputDigest',
    'promptVersion',
    'corpusDigest',
    'assetId',
  ]);
  if (!Number.isSafeInteger(raw.requestedRevision) || (raw.requestedRevision as number) < 1)
    throw invalid();
  return {
    kind,
    runId: text(raw.runId, 100),
    pageId: text(raw.pageId),
    requestedRevision: raw.requestedRevision as number,
    originalRequestHash: digest(raw.originalRequestHash),
    intentsDigest: digest(raw.intentsDigest),
    capabilityDigest: digest(raw.capabilityDigest),
    modelInputDigest: digest(raw.modelInputDigest),
    promptVersion: text(raw.promptVersion),
    corpusDigest: digest(raw.corpusDigest),
    assetId: text(raw.assetId),
  };
}

function parseResult(
  value: unknown,
  identity: ReachDeckMediaCheckpointIdentity,
): ReachDeckMediaCheckpointResult {
  const raw = exact(value, ['kind', 'documentHtml', 'scientificModel', 'sourceDigest']);
  if (
    raw.kind !== identity.kind ||
    typeof raw.documentHtml !== 'string' ||
    raw.documentHtml.trim().length === 0 ||
    !Array.isArray(raw.scientificModel) ||
    raw.scientificModel.length < 1 ||
    raw.scientificModel.length > 16
  )
    throw invalid();
  const scientificModel = raw.scientificModel.map((rule) => text(rule, 2048));
  const sourceDigest = digest(raw.sourceDigest);
  if (sourceDigest !== buildReachDeckCodeSourceDigest(raw.documentHtml, scientificModel))
    throw invalid();
  return { kind: 'code-source', documentHtml: raw.documentHtml, scientificModel, sourceDigest };
}

export function parseReachDeckMediaCheckpoint(value: unknown): ReachDeckMediaCheckpoint {
  const state = (value as { state?: unknown } | null)?.state;
  if (!['planned', 'in_flight', 'completed', 'outcome_unknown'].includes(state as string))
    throw invalid();
  const raw = exact(value, [
    'schemaVersion',
    'identity',
    'state',
    'createdAt',
    'updatedAt',
    ...(state === 'planned' ? [] : ['ownerId']),
    ...(state === 'completed' ? ['result', 'resultDigest'] : []),
  ]);
  if (raw.schemaVersion !== REACH_DECK_MEDIA_CHECKPOINT_VERSION) throw invalid();
  const identity = parseIdentity(raw.identity);
  const base: MediaCheckpointBase = {
    schemaVersion: REACH_DECK_MEDIA_CHECKPOINT_VERSION,
    identity,
    createdAt: timestamp(raw.createdAt),
    updatedAt: timestamp(raw.updatedAt),
  };
  if (Date.parse(base.updatedAt) < Date.parse(base.createdAt)) throw invalid();
  let checkpoint: ReachDeckMediaCheckpoint;
  if (state === 'planned') checkpoint = { ...base, state };
  else if (state === 'completed') {
    const result = parseResult(raw.result, identity);
    const resultDigest = digest(raw.resultDigest);
    if (resultDigest !== reachDeckMediaCheckpointDigest(result)) throw invalid();
    checkpoint = { ...base, state, ownerId: text(raw.ownerId), result, resultDigest };
  } else
    checkpoint = {
      ...base,
      state: state as 'in_flight' | 'outcome_unknown',
      ownerId: text(raw.ownerId),
    };
  if (byteLength(checkpoint) > MAX_REACH_DECK_CODE_SOURCE_RECEIPT_BYTES)
    throw new ReachDeckMediaCheckpointBudgetError();
  return checkpoint;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Reserve completion capacity before dispatch; completed sources retain their actual byte cost. */
export function parseReachDeckMediaCheckpoints(value: unknown): ReachDeckMediaCheckpoints {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const entries = Object.entries(value);
  if (entries.length > MAX_REACH_DECK_MEDIA_CHECKPOINTS)
    throw new ReachDeckMediaCheckpointBudgetError();
  let reserved = 2;
  const parsed = Object.fromEntries(
    entries.map(([key, raw]) => {
      const checkpoint = parseReachDeckMediaCheckpoint(raw);
      if (key !== buildReachDeckMediaCheckpointKey(checkpoint.identity)) throw invalid();
      reserved +=
        key.length +
        4 +
        (checkpoint.state === 'completed' || checkpoint.state === 'outcome_unknown'
          ? byteLength(checkpoint)
          : MAX_REACH_DECK_CODE_SOURCE_RECEIPT_BYTES);
      return [key, checkpoint];
    }),
  );
  if (reserved > MAX_REACH_DECK_MEDIA_CHECKPOINT_BYTES)
    throw new ReachDeckMediaCheckpointBudgetError();
  return parsed;
}

/** Extra bytes already promised to in-flight outputs, beyond the records stored today. */
export function reachDeckMediaCheckpointReservedBytes(value: ReachDeckMediaCheckpoints): number {
  return Object.values(parseReachDeckMediaCheckpoints(value)).reduce(
    (total, checkpoint) =>
      total +
      (checkpoint.state === 'planned' || checkpoint.state === 'in_flight'
        ? MAX_REACH_DECK_CODE_SOURCE_RECEIPT_BYTES - byteLength(checkpoint)
        : 0),
    0,
  );
}

/** Storage hooks keep this protocol independent of provider, queue, and rendering lifecycles. */
export interface ReachDeckMediaCheckpointPersistence {
  read(): Promise<ReachDeckMediaCheckpoints>;
  transition(
    update: (checkpoints: ReachDeckMediaCheckpoints) => ReachDeckMediaCheckpoints,
  ): Promise<ReachDeckMediaCheckpoints>;
}

export function createReachDeckMediaCheckpointStore(
  context: ReachDeckWorkspaceContext,
  persistence: ReachDeckMediaCheckpointPersistence = {
    async read() {
      const { loadReachDeckWorkspaceRecovery } = await import('./workspace-recovery.js');
      return (await loadReachDeckWorkspaceRecovery(context)).recovery.mediaCheckpoints;
    },
    async transition(update) {
      const { transitionReachDeckWorkspaceMediaCheckpoints } =
        await import('./workspace-recovery.js');
      return transitionReachDeckWorkspaceMediaCheckpoints(context, update);
    },
  },
) {
  const update = async (
    identityValue: ReachDeckMediaCheckpointIdentity,
    transition: (current: ReachDeckMediaCheckpoint | undefined) => ReachDeckMediaCheckpoint,
  ): Promise<ReachDeckMediaCheckpoint> => {
    const identity = parseIdentity(identityValue);
    const key = buildReachDeckMediaCheckpointKey(identity);
    const saved = await persistence.transition((values) => {
      const checkpoints = parseReachDeckMediaCheckpoints(values);
      return parseReachDeckMediaCheckpoints({
        ...checkpoints,
        [key]: transition(checkpoints[key]),
      });
    });
    return parseReachDeckMediaCheckpoints(saved)[key]!;
  };
  const read = async (identity: ReachDeckMediaCheckpointIdentity) => {
    const values = parseReachDeckMediaCheckpoints(await persistence.read());
    return values[buildReachDeckMediaCheckpointKey(identity)] ?? null;
  };
  return {
    read,
    async plan(identity: ReachDeckMediaCheckpointIdentity) {
      return update(identity, (current) => {
        if (current) return current;
        const now = new Date().toISOString();
        return {
          schemaVersion: REACH_DECK_MEDIA_CHECKPOINT_VERSION,
          identity: parseIdentity(identity),
          state: 'planned',
          createdAt: now,
          updatedAt: now,
        };
      });
    },
    async claim(identity: ReachDeckMediaCheckpointIdentity, ownerId: string) {
      text(ownerId);
      // CAS transitions may be evaluated again; never dispatch based on a discarded attempt.
      let claimed = false;
      const checkpoint = await update(identity, (current) => {
        claimed = false;
        if (!current) throw new ReachDeckMediaCheckpointConflictError();
        if (current.state === 'outcome_unknown')
          throw new ReachDeckMediaCheckpointOutcomeUnknownError();
        if (current.state !== 'planned') return current;
        claimed = true;
        return { ...current, state: 'in_flight', ownerId, updatedAt: new Date().toISOString() };
      });
      return { checkpoint, claimed };
    },
    async complete(
      identity: ReachDeckMediaCheckpointIdentity,
      ownerId: string,
      resultValue: ReachDeckMediaCheckpointResult,
    ) {
      text(ownerId);
      const result = parseResult(resultValue, parseIdentity(identity));
      const resultDigest = reachDeckMediaCheckpointDigest(result);
      return update(identity, (current) => {
        if (current?.state === 'outcome_unknown')
          throw new ReachDeckMediaCheckpointOutcomeUnknownError();
        if (!current || current.state === 'planned' || current.ownerId !== ownerId)
          throw new ReachDeckMediaCheckpointConflictError();
        if (current.state === 'completed') {
          if (current.resultDigest !== resultDigest)
            throw new ReachDeckMediaCheckpointConflictError();
          return current;
        }
        return {
          ...current,
          state: 'completed',
          result,
          resultDigest,
          updatedAt: new Date().toISOString(),
        };
      });
    },
    /** A failed pre-dispatch lease check proves this owner never sent the paid request. */
    async releaseUnsent(identity: ReachDeckMediaCheckpointIdentity, ownerId: string) {
      text(ownerId);
      return update(identity, (current) => {
        if (current?.state !== 'in_flight' || current.ownerId !== ownerId)
          throw new ReachDeckMediaCheckpointConflictError();
        const { ownerId: _ownerId, ...checkpoint } = current;
        return { ...checkpoint, state: 'planned', updatedAt: new Date().toISOString() };
      });
    },
    /** Caller must first establish that this exact execution owner was lost, e.g. a stalled worker. */
    async markOutcomeUnknown(identity: ReachDeckMediaCheckpointIdentity, ownerId: string) {
      text(ownerId);
      return update(identity, (current) => {
        if (!current || current.state === 'planned' || current.ownerId !== ownerId)
          throw new ReachDeckMediaCheckpointConflictError();
        if (current.state === 'completed' || current.state === 'outcome_unknown') return current;
        return { ...current, state: 'outcome_unknown', updatedAt: new Date().toISOString() };
      });
    },
  };
}
