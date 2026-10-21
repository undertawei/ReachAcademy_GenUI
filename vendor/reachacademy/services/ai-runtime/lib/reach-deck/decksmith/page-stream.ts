import type { DecksmithLeaseEntry } from './lease-policy.js';
import { createHash } from 'node:crypto';

import type {
  ApprovalRecord,
  CreateRunInput,
  RunRecord,
  RunStatus,
  RuntimeActor,
  RuntimeRunInput,
} from '../../contracts.js';
import type { ReachDeckResourceScope } from '../resource-scope.js';
import type { DecksmithAdoptionProof } from './adoption.js';
import { decksmithCapacityApplicationMessage } from './capacity.js';
import { parseReachDeckResourceScope } from '../resource-scope.js';
import {
  DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION,
  DECKSMITH_CUTOFF_SCHEMA_VERSION,
  DECKSMITH_EPOCH_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_CONTEXT_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_LIMITS,
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
  DECKSMITH_PAGE_TURN_SCHEMA_VERSION,
  decksmithPageStreamDomainScope,
  parseDecksmithPageControlBoundary,
  parseDecksmithPageStreamContext,
  type DecksmithPageControlBoundary,
  type DecksmithControlRunInput,
  type DecksmithPageStreamContext,
  type DecksmithPageStreamDomainScope,
  type DecksmithPageSummary,
  type DecksmithPageSummaryRef,
  type DecksmithCompactionRunInput,
} from './page-stream-contracts.js';

export interface DecksmithPageStreamOwnerScope {
  readonly actor: RuntimeActor;
  readonly resourceScope: ReachDeckResourceScope;
  readonly pageId: string;
}

export interface DecksmithPageStreamRecord {
  readonly threadId: string;
  readonly actor: RuntimeActor;
  readonly domainScope: DecksmithPageStreamDomainScope;
  readonly context: DecksmithPageStreamContext;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly created: boolean;
}

export interface DecksmithPageHistoryCursor {
  /** Opaque precision-preserving database timestamp used only for keyset comparison. */
  readonly queuedAt: string;
  readonly runId: string;
}

const DECKSMITH_HISTORY_CURSOR_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

export interface DecksmithPageHistoryEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/**
 * Exact semantic event types admitted to bounded history. The latest event of every type remains
 * pinned when repeated supported events consume the remaining per-Run budget.
 */
export const DECKSMITH_HISTORY_PINNED_EVENT_TYPES = Object.freeze([
  'run.queued',
  'run.started',
  'run.recovered',
  'run.retry_scheduled',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'decksmith.result',
  'decksmith.error',
  'decksmith.application-message',
  'decksmith.capacity.blocked',
  'decksmith.compaction.best-effort-failed',
  'decksmith.page-stream.control',
  'artifact.proposed',
  'artifact.validated',
  'artifact.applied',
  'approval.required',
  'approval.decided',
] as const);

/**
 * Exact durable event surface consumed by page history, model turn projection, and capacity
 * recovery. High-volume deltas/progress/tool traces are intentionally not page-history data.
 */
export const DECKSMITH_HISTORY_EVENT_TYPES = DECKSMITH_HISTORY_PINNED_EVENT_TYPES;

const DECKSMITH_HISTORY_EVENT_TYPE_SET = new Set<string>(DECKSMITH_HISTORY_PINNED_EVENT_TYPES);

export function isDecksmithPageHistoryEventType(type: string): boolean {
  return DECKSMITH_HISTORY_EVENT_TYPE_SET.has(type);
}

export function selectDecksmithPageHistoryEvents<T extends DecksmithPageHistoryEvent>(
  values: readonly T[],
  limit = DECKSMITH_PAGE_STREAM_LIMITS.eventsPerRun,
): readonly T[] {
  if (!Number.isSafeInteger(limit) || limit < DECKSMITH_HISTORY_PINNED_EVENT_TYPES.length) {
    throw new Error('Decksmith history event limit is invalid');
  }
  const ordered = [...values].sort((left, right) => compareEventIds(left.id, right.id));
  const pinnedByType = new Map<string, T>();
  for (const event of ordered) {
    if (DECKSMITH_HISTORY_EVENT_TYPE_SET.has(event.type)) {
      pinnedByType.set(event.type, event);
    }
  }
  const selectedIds = new Set([...pinnedByType.values()].map((event) => event.id));
  for (let index = ordered.length - 1; index >= 0 && selectedIds.size < limit; index -= 1) {
    selectedIds.add(ordered[index]!.id);
  }
  return Object.freeze(ordered.filter((event) => selectedIds.has(event.id)));
}

export function projectDecksmithCapacityBlockedHistoryEvents<
  T extends DecksmithPageHistoryEvent,
>(input: {
  readonly runId: string;
  readonly status: RunStatus;
  readonly errorCode?: string;
  readonly queuedAt: string;
  readonly events: readonly T[];
}): readonly (T | DecksmithPageHistoryEvent)[] {
  if (
    input.status !== 'failed' ||
    input.errorCode !== 'DECKSMITH_CAPACITY_BLOCKED' ||
    input.events.some(
      (event) =>
        event.type === 'decksmith.application-message' &&
        event.payload.messageKey === 'reachDeck.decksmith.capacity.blocked',
    )
  ) {
    return input.events;
  }
  return Object.freeze([
    ...input.events,
    Object.freeze({
      id: `capacity-blocked:${input.runId}`,
      type: 'decksmith.application-message',
      payload: Object.freeze({ ...decksmithCapacityApplicationMessage('blocked') }),
      createdAt: input.queuedAt,
    }),
  ]);
}

function compareEventIds(left: string, right: string): number {
  if (/^[0-9]+$/.test(left) && /^[0-9]+$/.test(right)) {
    const normalizedLeft = left.replace(/^0+(?=\d)/, '');
    const normalizedRight = right.replace(/^0+(?=\d)/, '');
    return (
      normalizedLeft.length - normalizedRight.length ||
      normalizedLeft.localeCompare(normalizedRight)
    );
  }
  return left.localeCompare(right);
}

export interface DecksmithPageHistoryItem {
  readonly runId: string;
  readonly status: RunStatus;
  readonly input: RuntimeRunInput;
  readonly queuedAt: string;
  readonly events: readonly DecksmithPageHistoryEvent[];
}

export interface DecksmithPageHistoryPage {
  /** Newest-first. Consumers reverse each page only when rendering chronological UI. */
  readonly items: readonly DecksmithPageHistoryItem[];
  readonly nextCursor?: DecksmithPageHistoryCursor;
  readonly context: DecksmithPageStreamContext;
}

export interface DecksmithPageControlResult {
  readonly runId: string;
  readonly created: boolean;
  readonly boundary: DecksmithPageControlBoundary;
  readonly context: DecksmithPageStreamContext;
  readonly updatedAt: string;
}

export interface DecksmithCompactionSnapshot {
  /** Oldest-first exact page-stream turns after epoch/cutoff/last-good-summary boundaries. */
  readonly items: readonly DecksmithPageHistoryItem[];
  readonly context: DecksmithPageStreamContext;
  readonly truncated: boolean;
}

export interface DecksmithCompactionRunCreation {
  /** Caller-frozen UUID referenced by the parent turn before either Run is persisted. */
  readonly id: string;
  readonly run: CreateRunInput;
}

export interface DecksmithPageTurnCreationResult {
  readonly run: RunRecord;
  readonly created: boolean;
  readonly compactionRun?: RunRecord;
}

export interface DecksmithStoredSummary {
  readonly ref: DecksmithPageSummaryRef;
  readonly summary: DecksmithPageSummary;
}

export type DecksmithCompactionInstallResult =
  | { readonly status: 'installed'; readonly ref: DecksmithPageSummaryRef }
  | { readonly status: 'reused'; readonly ref: DecksmithPageSummaryRef }
  | { readonly status: 'stale' };

export interface DecksmithDeckLease {
  readonly schemaVersion: 'reach-deck-decksmith-deck-lease/v1';
  readonly ownerRunId: string;
  readonly ownerRequestKey: string;
  readonly threadId: string;
  readonly pageId: string;
  readonly acquiredAt: string;
  readonly asyncRunId?: string;
}

export const REACH_DECK_ASYNC_WRITER_LEASE_PREFIX = 'reach-deck-async-writer/v1:';
export const REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX = 'reach-deck-writer:';
export const DECKSMITH_CONTROL_LEASE_PREFIX = 'decksmith-control:';

/**
 * A Decksmith conversation turn (running, or its proposal awaiting a decision or adoption), as
 * opposed to the short-lived leases ordinary writers, async generation and page controls hold.
 * Non-structural page writes may run beside a turn lease; they never replace it.
 */
export function isDecksmithTurnLease(lease: DecksmithDeckLease): boolean {
  return (
    !lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX) &&
    !lease.ownerRequestKey.startsWith(REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX) &&
    !lease.ownerRequestKey.startsWith(DECKSMITH_CONTROL_LEASE_PREFIX)
  );
}

export interface DecksmithApprovedAdoption {
  readonly ownerRunId: string;
  readonly approvalId: string;
  readonly artifactId: string;
  readonly threadId: string;
  readonly pageId: string;
  readonly roleGrantId: string;
  readonly resourceScope: ReachDeckResourceScope;
  readonly baselineDocumentHash: string;
  readonly baselineContentDigest: string;
  readonly candidateDocumentHash: string;
  readonly proof: DecksmithAdoptionProof;
}

export interface DecksmithDeckWriterSession {
  /** Same contract as RuntimeStore.markApprovalApplied, on the connection holding the deck lock. */
  markApprovalApplied(
    approvalId: string,
    actorId: string,
    appliedEventFields?: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalRecord | null>;
  /** Record a decision on the connection that holds the deck lock (no second lock acquisition). */
  decideApproval(
    approvalId: string,
    actorId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ApprovalRecord | null>;
  releaseDecksmithDeckLease(ownerRunId: string): Promise<boolean>;
  renewDecksmithDeckLease(ownerRunId: string): Promise<boolean>;
  transferDecksmithDeckLease(input: {
    readonly fromOwnerRunId: string;
    readonly toOwnerRunId: string;
    readonly ownerRequestKey: string;
    readonly asyncRunId?: string;
  }): Promise<DecksmithDeckLease>;
}

export class DecksmithDeckLeaseConflictError extends Error {
  constructor(readonly lease: DecksmithDeckLease) {
    super('Another Decksmith turn or unresolved proposal is active for this deck');
    this.name = 'DecksmithDeckLeaseConflictError';
  }
}

export class DecksmithDeckWriterConflictError extends Error {
  constructor() {
    super('Another Reach Deck document writer is active for this deck');
    this.name = 'DecksmithDeckWriterConflictError';
  }
}

/**
 * The deck advisory lock stayed busy past the bounded wait. Unlike a conflict, nobody owns the deck
 * against this caller; the attempt is retryable as is.
 */
export class DecksmithDeckLockTimeoutError extends Error {
  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`Decksmith deck writer lock wait timed out after ${timeoutMs} ms`, options);
    this.name = 'DecksmithDeckLockTimeoutError';
  }
}

export interface DecksmithPageStreamStore {
  getOrCreateDecksmithPageStream(
    scope: DecksmithPageStreamOwnerScope,
  ): Promise<DecksmithPageStreamRecord>;
  listDecksmithPageHistory(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly cursor?: DecksmithPageHistoryCursor;
    readonly limit?: number;
  }): Promise<DecksmithPageHistoryPage>;
  loadDecksmithFrozenHistory(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly runIds: readonly string[];
  }): Promise<readonly DecksmithPageHistoryItem[]>;
  loadDecksmithCompactionSnapshot(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly limit?: number;
  }): Promise<DecksmithCompactionSnapshot>;
  loadDecksmithSummary(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ref: DecksmithPageSummaryRef;
  }): Promise<DecksmithStoredSummary | null>;
  completeDecksmithCompaction(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly leaseOwnerRunId: string;
    readonly parentRunId: string;
    readonly compactionRunId: string;
    readonly compactionInput: DecksmithCompactionRunInput;
    readonly summary: DecksmithPageSummary;
  }): Promise<DecksmithCompactionInstallResult>;
  advanceDecksmithPageEpoch(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly idempotencyKey: string;
    readonly leaseOwnerRunId?: string;
  }): Promise<DecksmithPageControlResult>;
  softDeleteDecksmithPageConversation(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly idempotencyKey: string;
    readonly leaseOwnerRunId?: string;
  }): Promise<DecksmithPageControlResult>;
  acquireDecksmithDeckLease(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ownerRunId: string;
    readonly ownerRequestKey: string;
  }): Promise<{ readonly lease: DecksmithDeckLease; readonly acquired: boolean }>;
  releaseDecksmithDeckLease(ownerRunId: string): Promise<boolean>;
  renewDecksmithDeckLease(ownerRunId: string): Promise<boolean>;
  decksmithDeckLeaseAgeAtLeast(ownerRunId: string, minimumAgeMs: number): Promise<boolean>;
  releaseDecksmithDeckLeaseIfOlderThan(ownerRunId: string, minimumAgeMs: number): Promise<boolean>;
  /**
   * The deck's most relevant lease: an active whole-deck writer, else a Decksmith turn (the one on
   * `scope.pageId` first). Several page-scoped leases may coexist; use
   * `listDecksmithDeckLeases` to see all of them.
   */
  getDecksmithDeckLease(scope: DecksmithPageStreamOwnerScope): Promise<DecksmithDeckLease | null>;
  /**
   * Every lease row on the deck of `scope`, active or not, with the holder state and proposal
   * footprint of active page-scoped leases.
   */
  listDecksmithDeckLeaseEntries(
    scope: DecksmithPageStreamOwnerScope,
  ): Promise<readonly DecksmithLeaseEntry[]>;
  /**
   * The approved, unapplied Decksmith proposal a write on `scope.pageId` must reconcile with (see
   * `selectDecksmithApprovedAdoption`).
   */
  getDecksmithApprovedAdoption(
    scope: DecksmithPageStreamOwnerScope,
  ): Promise<DecksmithApprovedAdoption | null>;
  /**
   * Every approved, unapplied Decksmith proposal a write on `scope.pageId` must reconcile with
   * (see `selectDecksmithApprovedAdoptions`); several only for a whole-document write.
   */
  getDecksmithApprovedAdoptions(
    scope: DecksmithPageStreamOwnerScope,
  ): Promise<readonly DecksmithApprovedAdoption[]>;
  /**
   * The approved, unapplied adoption of exactly this approval under its own active lease, or null.
   * `/applied` confirms one approval; unlike page saves it must never pick another proposal.
   */
  getDecksmithApprovedAdoptionForApproval(input: {
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ownerRunId: string;
    readonly approvalId: string;
    readonly artifactId: string;
  }): Promise<DecksmithApprovedAdoption | null>;
  /**
   * Serialize one document write for the deck. The owner of an active lease writes normally,
   * beside other pages' Decksmith turns. With `guest`, a writer without a lease may still write
   * while no whole-deck writer lease is active; a guest session cannot mutate leases or approvals.
   */
  withDecksmithDeckWriterLock<T>(input: {
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ownerRunId: string;
    readonly guest?: boolean;
    readonly operationKind?: string;
    readonly operation: (signal: AbortSignal, session: DecksmithDeckWriterSession) => Promise<T>;
  }): Promise<T>;
  transferDecksmithDeckLease(input: {
    readonly fromOwnerRunId: string;
    readonly toOwnerRunId: string;
    readonly ownerRequestKey: string;
    readonly asyncRunId?: string;
  }): Promise<DecksmithDeckLease>;
  hasActiveDecksmithDeckLease(input: {
    readonly actor: RuntimeActor;
    readonly resourceScope: ReachDeckResourceScope;
  }): Promise<boolean>;
  ownsActiveDecksmithDeckLease(ownerRunId: string): Promise<boolean>;
  createDecksmithPageTurn(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly run: CreateRunInput;
    readonly compaction?: DecksmithCompactionRunCreation;
  }): Promise<DecksmithPageTurnCreationResult>;
}

export class DecksmithPageStreamService {
  constructor(private readonly store: DecksmithPageStreamStore) {}

  pageStream(scope: DecksmithPageStreamOwnerScope): Promise<DecksmithPageStreamRecord> {
    return this.store.getOrCreateDecksmithPageStream(parseOwnerScope(scope));
  }

  history(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly cursor?: DecksmithPageHistoryCursor;
    readonly limit?: number;
  }): Promise<DecksmithPageHistoryPage> {
    const limit = input.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DECKSMITH_PAGE_STREAM_LIMITS.historyPage
    ) {
      throw new Error('Decksmith page history limit is invalid');
    }
    const cursor =
      input.cursor === undefined
        ? undefined
        : {
            queuedAt: parseDecksmithHistoryCursorTimestamp(input.cursor.queuedAt),
            runId: canonicalUuid(input.cursor.runId, 'history cursor runId'),
          };
    return this.store.listDecksmithPageHistory({
      threadId: canonicalUuid(input.threadId, 'threadId'),
      scope: parseOwnerScope(input.scope),
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
  }

  newTopic(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly idempotencyKey: string;
    readonly leaseOwnerRunId?: string;
  }): Promise<DecksmithPageControlResult> {
    return this.store.advanceDecksmithPageEpoch(parseControlInput(input));
  }

  softDeleteCurrentPage(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly idempotencyKey: string;
    readonly leaseOwnerRunId?: string;
  }): Promise<DecksmithPageControlResult> {
    return this.store.softDeleteDecksmithPageConversation(parseControlInput(input));
  }
}

export function parseOwnerScope(
  scope: DecksmithPageStreamOwnerScope,
): DecksmithPageStreamOwnerScope {
  const resourceScope = parseReachDeckResourceScope(scope.resourceScope);
  const actorOrganizationId = canonicalUuid(scope.actor.orgId, 'actor organization');
  return Object.freeze({
    actor: {
      subject: canonicalUuid(scope.actor.subject, 'actor subject'),
      orgId: actorOrganizationId,
      roles: [...scope.actor.roles],
      ...(scope.actor.billingGroupId === undefined
        ? {}
        : { billingGroupId: requireIdentifier(scope.actor.billingGroupId, 'billingGroupId') }),
    },
    resourceScope,
    pageId: requireIdentifier(scope.pageId, 'pageId'),
  });
}

export function canonicalPageStreamScope(scope: DecksmithPageStreamOwnerScope): {
  readonly domainScope: DecksmithPageStreamDomainScope;
  readonly lockKey: string;
} {
  const parsed = parseOwnerScope(scope);
  const domainScope = decksmithPageStreamDomainScope({
    ...parsed.resourceScope,
    pageId: parsed.pageId,
  });
  const lockKey = [
    'reach-deck-decksmith-page-stream/v1',
    parsed.actor.orgId,
    parsed.actor.subject,
    parsed.actor.billingGroupId ?? '__no_billing_group__',
    domainScope.courseId,
    domainScope.courseNodeId,
    domainScope.moduleId,
    domainScope.moduleVersionId,
    domainScope.pageId,
  ].join('\u0000');
  return { domainScope, lockKey };
}

export function decksmithControlRequestKey(
  scope: DecksmithPageStreamOwnerScope,
  kind: DecksmithPageControlBoundary['kind'],
  idempotencyKey: string,
): string {
  const key = requireIdentifier(idempotencyKey, 'idempotencyKey');
  const { lockKey } = canonicalPageStreamScope(scope);
  return `decksmith-control-v1:${kind}:${createHash('sha256')
    .update(lockKey)
    .update('\u0000')
    .update(key)
    .digest('hex')}`;
}

export function buildDecksmithControlBoundary(input: {
  readonly kind: DecksmithPageControlBoundary['kind'];
  readonly pageId: string;
  readonly context: DecksmithPageStreamContext;
}): DecksmithPageControlBoundary {
  const current = parseDecksmithPageStreamContext(input.context);
  const sequence = current.streamSequence + 1;
  const contextRevision = current.contextRevision + 1;
  if (input.kind === 'new-topic') {
    const nextEpoch = current.currentEpoch.epoch + 1;
    const stream = {
      schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
      pageId: requireIdentifier(input.pageId, 'pageId'),
      sequence,
      epoch: nextEpoch,
      contextRevision,
    } as const;
    return parseDecksmithPageControlBoundary({
      schemaVersion: DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION,
      kind: 'new-topic',
      stream,
      previousEpoch: current.currentEpoch.epoch,
      nextEpoch,
      message: {
        schemaVersion: DECKSMITH_PAGE_TURN_SCHEMA_VERSION,
        kind: 'application',
        stream,
        messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
        replacements: {},
      },
    });
  }
  const stream = {
    schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
    pageId: requireIdentifier(input.pageId, 'pageId'),
    sequence,
    epoch: current.currentEpoch.epoch,
    contextRevision,
  } as const;
  return parseDecksmithPageControlBoundary({
    schemaVersion: DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION,
    kind: 'soft-delete',
    stream,
    visibilityCutoffSequence: sequence,
    modelContextCutoffSequence: sequence,
  });
}

export function advanceContextWithControl(
  contextValue: DecksmithPageStreamContext,
  boundaryValue: DecksmithPageControlBoundary,
  controlRunId: string,
): DecksmithPageStreamContext {
  const context = parseDecksmithPageStreamContext(contextValue);
  const boundary = parseDecksmithPageControlBoundary(boundaryValue);
  if (
    boundary.stream.sequence !== context.streamSequence + 1 ||
    boundary.stream.contextRevision !== context.contextRevision + 1
  ) {
    throw new Error('Decksmith page control does not advance the context monotonically');
  }
  if (boundary.kind === 'new-topic') {
    if (
      boundary.previousEpoch !== context.currentEpoch.epoch ||
      boundary.nextEpoch !== context.currentEpoch.epoch + 1
    ) {
      throw new Error('Decksmith New topic control does not own the current epoch');
    }
    return parseDecksmithPageStreamContext({
      ...context,
      streamSequence: boundary.stream.sequence,
      contextRevision: boundary.stream.contextRevision,
      currentEpoch: {
        schemaVersion: DECKSMITH_EPOCH_SCHEMA_VERSION,
        epoch: boundary.nextEpoch,
        startedAfterSequence: boundary.stream.sequence,
        boundaryRunId: canonicalUuid(controlRunId, 'controlRunId'),
      },
      summary: undefined,
    });
  }
  if (boundary.stream.epoch !== context.currentEpoch.epoch) {
    throw new Error('Decksmith soft-delete control does not own the current epoch');
  }
  return parseDecksmithPageStreamContext({
    ...context,
    streamSequence: boundary.stream.sequence,
    contextRevision: boundary.stream.contextRevision,
    modelContextCutoffSequence: boundary.modelContextCutoffSequence,
    visibilityCutoff: {
      schemaVersion: DECKSMITH_CUTOFF_SCHEMA_VERSION,
      kind: 'visibility',
      sequence: boundary.visibilityCutoffSequence,
      controlRunId: canonicalUuid(controlRunId, 'controlRunId'),
    },
    summary: undefined,
  });
}

export function parseStoredControlInput(value: unknown): DecksmithPageControlBoundary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Decksmith control run input is invalid');
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 'reach-deck-decksmith-control-run-input/v1' ||
    input.kind !== 'decksmith-control' ||
    input.message !== '' ||
    Object.keys(input).some((key) => !['schemaVersion', 'kind', 'message', 'control'].includes(key))
  ) {
    throw new Error('Decksmith control run input is invalid');
  }
  return parseDecksmithPageControlBoundary(input.control);
}

export function controlRunInput(boundary: DecksmithPageControlBoundary): DecksmithControlRunInput {
  return Object.freeze({
    schemaVersion: 'reach-deck-decksmith-control-run-input/v1',
    kind: 'decksmith-control',
    message: '',
    control: parseDecksmithPageControlBoundary(boundary),
  });
}

function parseControlInput<
  T extends {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly idempotencyKey: string;
  },
>(input: T): T {
  return {
    ...input,
    threadId: canonicalUuid(input.threadId, 'threadId'),
    scope: parseOwnerScope(input.scope),
    idempotencyKey: requireIdentifier(input.idempotencyKey, 'idempotencyKey'),
    ...('leaseOwnerRunId' in input && input.leaseOwnerRunId !== undefined
      ? { leaseOwnerRunId: canonicalUuid(input.leaseOwnerRunId, 'control lease ownerRunId') }
      : {}),
  };
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > DECKSMITH_PAGE_STREAM_LIMITS.identifierCharacters
  ) {
    throw new Error(`Decksmith page stream ${label} is invalid`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`Decksmith page stream ${label} must be a UUID`);
  }
  return value.toLowerCase();
}

export function parseDecksmithHistoryCursorTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Decksmith page history cursor timestamp is invalid');
  }
  const match = DECKSMITH_HISTORY_CURSOR_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    throw new Error('Decksmith page history cursor timestamp is invalid');
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error('Decksmith page history cursor timestamp is invalid');
  }
  return value;
}
