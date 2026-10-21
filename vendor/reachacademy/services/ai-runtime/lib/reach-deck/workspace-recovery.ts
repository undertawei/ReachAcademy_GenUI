import {
  canonicalizeInteractiveNarrationText,
  isEntranceAnimationPresetName,
  isNativeSlideArtifact,
  parseReachDeckFormulaReadingsV1,
  parseReachDeckSpeechMarkupV1,
  reachDeckPageUsesNativeNarration,
  type GenerationWorkspace,
  upgradeLegacyPersistedPageOutline,
  type GenerationSceneType,
  type ReachDeckDocument,
  type ReachDeckFormulaReadingV1,
  type ReachDeckNativeSlideV2,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';
import { observationLogContext } from '@reachany/observability/tracing';

import {
  reachDeckJobResponseMetadata,
  type ReachDeckJobResponseMetadata,
} from './job-response-metadata.js';

import type { ApprovalRecord, RunRecord } from '../contracts.js';
import { assertReachDeckOutlineInputTextSafe } from './structured-text-safety.js';
import {
  createTeacherDeckRuntime,
  type TeacherDeckRuntime,
  type TeacherDeckRuntimeJobRef,
} from '../teacher-deck-runtime.js';
import {
  parseReachDeckStagedFrozenRunInput,
  stagedScientificSourceRequestHash,
} from './staged-frozen-input.js';
import {
  ContentServiceClientError,
  ContentServiceTransportError,
  exchangeReachDeckVoiceCapability,
  getReachDeckGenerationAudit,
  getReachDeckWorkspace,
  getReachDeckWorkspaceReadProjection,
  putReachDeckWorkspaceRecovery,
  type ReachDeckGenerationAuditResource,
  type ReachDeckWorkspaceResource,
} from './content-service-client.js';
import type {
  ReachDeckDecksmithJobPayload,
  ReachDeckDecksmithJobResult,
  ReachDeckGenerationJobView,
  ReachDeckNarrationGenerationJobPayload,
  ReachDeckNarrationGenerationJobResult,
  ReachDeckPageGenerationJobPayload,
  ReachDeckStagedGenerationJobKind,
  ReachDeckStagedGenerationJobPayload,
  ReachDeckStagedGenerationResult,
} from './contracts.js';
import {
  actorOrganizationIdFromPayload,
  parseReachDeckDecksmithJobPayload,
  parseReachDeckDecksmithJobResult,
} from './contracts.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithResultHash,
  buildReachDeckInteractiveNarrationTextDigest,
  buildReachDeckNarrationStateDigest,
  buildReachDeckNativeSlideContentDigest,
  buildStagedGenerationRequestHash,
} from './job-identity.js';
import {
  isNativeNarrationRequest,
  isInteractiveNarrationRequest,
  type GenerateNarrationRequest,
  type ReachDeckPreparedNativeNarration,
  type ReachDeckPreparedSlideNarration,
} from './generation-pipeline.js';
import { mapWithConcurrency, runSerializedByKey } from './concurrency.js';
import { cancelReachDeckSpeech, type ReachDeckTtsQueueState } from './model-service-tools.js';
import { classifyReachDeckPublicFailure } from './public-job-error.js';
import {
  parseCompletedStagedResult,
  stagedResultProvenanceFromPayload,
  type ReachDeckStagedResultProvenance,
} from './staged-result.js';
import {
  createReachDeckGenerationQueue,
  parseReachDeckStagedGenerationJobPayload,
  readReachDeckGenerationJob,
  readReachDeckGenerationJobWithPayload,
  type ReachDeckGenerationQueue,
  type ReachDeckGenerationJobScope,
} from './queue.js';
import {
  abortReachDeckGenerationAuditByScopeWithNarrowRetry,
  reachDeckGenerationAuditErrorSummary,
  updateReachDeckGenerationAuditByScopeWithNarrowRetry,
} from './generation-audit.js';
import { toWorkspaceResource, type ReachDeckWorkspaceContext } from './workspace-store.js';
import { measureWorkspaceReadPhase } from '../workspace-read-diagnostics.js';
import {
  parseReachDeckMediaCheckpoints,
  ReachDeckMediaCheckpointBudgetError,
  reachDeckMediaCheckpointReservedBytes,
  type ReachDeckMediaCheckpoints,
} from './media-generation-checkpoint.js';
import { getRuntimeStore } from '../store/index.js';
import { canonicalUuid } from './decksmith/page-stream.js';
import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from './resource-scope.js';
import {
  DEFAULT_REACH_DECK_VOICE_SELECTION,
  parseReachDeckVoiceSelection,
  reachDeckVoiceSelectionDigest,
  sameReachDeckVoiceSelection,
  type ReachDeckVoiceSelection,
} from './voice-selection.js';
import {
  parseReachDeckWorkspaceBatchRequests,
  parseReachDeckWorkspaceBatches,
  ReachDeckWorkspaceBatchCapacityError,
  retainRecentReachDeckWorkspaceBatches,
  sameReachDeckWorkspaceBatchOwner,
  reachDeckRegenerationMemberMetadata,
  type ReachDeckWorkspaceBatch,
  type ReachDeckWorkspaceBatchRequests,
  type ReachDeckWorkspaceBatches,
} from './workspace-batches.js';

import {
  parseReachDeckImportGenerationIntents,
  type ReachDeckImportGenerationIntents,
} from './import-generation-contracts.js';
import {
  parseReachDeckDeletedPageRetirements,
  recordReachDeckDeletedPageRetirement,
  type ReachDeckDeletedPageRetirements,
} from './deleted-page-retirements.js';
import { ReachDeckWorkspaceJobDescriptorMissingError } from './workspace-recovery-errors.js';

const REACH_DECK_WORKSPACE_RECOVERY_V1_SCHEMA_VERSION = 'reach-deck-workspace-recovery/v1' as const;
const REACH_DECK_WORKSPACE_RECOVERY_V2_SCHEMA_VERSION = 'reach-deck-workspace-recovery/v2' as const;
const REACH_DECK_WORKSPACE_RECOVERY_V3_SCHEMA_VERSION = 'reach-deck-workspace-recovery/v3' as const;
export const REACH_DECK_WORKSPACE_RECOVERY_SCHEMA_VERSION =
  'reach-deck-workspace-recovery/v4' as const;
export const REACH_DECK_WORKSPACE_RECOVERY_V5_SCHEMA_VERSION =
  'reach-deck-workspace-recovery/v5' as const;
type ReachDeckWorkspaceRecoverySchemaVersion =
  | typeof REACH_DECK_WORKSPACE_RECOVERY_V1_SCHEMA_VERSION
  | typeof REACH_DECK_WORKSPACE_RECOVERY_V2_SCHEMA_VERSION
  | typeof REACH_DECK_WORKSPACE_RECOVERY_V3_SCHEMA_VERSION
  | typeof REACH_DECK_WORKSPACE_RECOVERY_SCHEMA_VERSION
  | typeof REACH_DECK_WORKSPACE_RECOVERY_V5_SCHEMA_VERSION;
const MAX_DURABLE_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_RECOVERY_STATE_BYTES = 12 * 1024 * 1024;
export const MAX_REACH_DECK_MONGO_WORKSPACE_DOCUMENT_BYTES = 16 * 1024 * 1024;
const CONSERVATIVE_MONGO_DOCUMENT_OVERHEAD_BYTES = 512 * 1024;
const MAX_TTS_CONTINUATION_BYTES = 512 * 1024;
const DECKSMITH_ENQUEUE_VISIBILITY_GRACE_MS = 120_000;
const MAX_RECOVERABLE_DECKSMITH_LIST_JOBS = 20;
export const MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES = 2_048;

export class ReachDeckDecksmithIdempotencyConflictError extends Error {
  constructor(message = 'Reach Deck Decksmith idempotency key collides with another request') {
    super(message);
    this.name = 'ReachDeckDecksmithIdempotencyConflictError';
  }
}

export class ReachDeckNarrationAdmissionReadError extends Error {
  readonly code = 'NARRATION_ADMISSION_RETRY';
  constructor() {
    super('Page generation status could not be confirmed; retry shortly');
    this.name = 'ReachDeckNarrationAdmissionReadError';
  }
}

export interface ReachDeckNarrationAdmissionSnapshot {
  readonly runId: string;
  readonly jobs: ReadonlyMap<
    string,
    {
      readonly identity: string;
      /** Undefined records an unavailable read; null proves the queue record is absent. */
      readonly view?: ReachDeckGenerationJobView | null;
    }
  >;
}

/** Resolve queue views once, outside the document writer lease. No recovery writes occur here. */
export async function prepareReachDeckNarrationAdmissionSnapshot(
  input: {
    context: ReachDeckWorkspaceContext;
    scope: ReachDeckGenerationJobScope;
    runId: string;
  },
  createQueue: () => Promise<ReachDeckGenerationQueue> = createReachDeckGenerationQueue,
): Promise<ReachDeckNarrationAdmissionSnapshot> {
  const resource = await loadReachDeckWorkspaceRecovery(input.context);
  const candidates = Object.values(resource.recovery.jobs).filter(
    (job) =>
      job.runId === input.runId &&
      sameScope(job, input.scope) &&
      (job.kind === 'narration-generation' || job.kind === 'page-generation') &&
      job.appliedAt === undefined &&
      job.artifactRef === undefined,
  );
  const queueReader = lazyRecoveryProjectionQueue(createQueue);
  const deadline = Date.now() + 4_000;
  try {
    const jobs = await mapWithConcurrency(candidates, 4, async (job) => {
      let view: ReachDeckGenerationJobView | null | undefined;
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ReachDeckNarrationAdmissionReadError();
        view = await boundedNarrationAdmissionRead(
          async () => (await queueReader.get()).read(job.jobId, input.scope),
          Math.min(1_000, remaining),
        );
        if (view !== null && view.jobId !== job.jobId) view = undefined;
      } catch {
        /* Preserve the failed read for retryable admission after exact batch replay. */
      }
      return [job.jobId, { identity: narrationAdmissionIdentity(job), view }] as const;
    });
    return { runId: input.runId, jobs: new Map(jobs) };
  } finally {
    await queueReader.close();
  }
}

function narrationAdmissionIdentity(job: ReachDeckWorkspaceRecoveryJob): string {
  return JSON.stringify({
    jobId: job.jobId,
    requestHash: job.requestHash,
    runId: job.runId,
    kind: job.kind,
    pageId: job.pageId,
    requestedRevision: job.requestedRevision,
    generationAttempt: job.generationAttempt,
    actorId: job.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(job),
    billingGroupId: job.billingGroupId,
    roleGrantId: job.roleGrantId,
    resourceScope: job.resourceScope,
    artifactRef: job.artifactRef,
    appliedAt: job.appliedAt,
  });
}

async function boundedNarrationAdmissionRead<T>(
  read: () => Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReachDeckNarrationAdmissionReadError()), timeoutMs);
      }),
    ]);
  } catch {
    throw new ReachDeckNarrationAdmissionReadError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ReachDeckWorkspaceRecoveryJob extends ReachDeckGenerationJobScope {
  scientificContextSourceHash?: string;
  jobId: string;
  kind: ReachDeckStagedGenerationJobKind;
  runId: string;
  createdFromDraftRevision: number;
  requestHash: string;
  voiceSelection: ReachDeckVoiceSelection;
  voiceDigest: string;
  generationStage: string;
  generationAttempt: string;
  queuedAt: string;
  pageId?: string;
  requestedRevision?: number;
  /** 图片阶段的通道证明独立于批次生命周期，批次清理后仍可恢复失败状态。 */
  affectedLanes?: ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
  /** Added for Interactive narration; missing legacy narration descriptors mean slide. */
  sceneType?: GenerationSceneType;
  chainId?: string;
  artifactRef?: string;
  appliedAt?: string;
}

export interface ReachDeckWorkspaceRecoveryResult {
  jobId: string;
  requestHash: string;
  resultHash: string;
  storedAt: string;
  result: ReachDeckStagedGenerationResult;
}

export interface ReachDeckWorkspaceRecoveryDecksmithJob extends ReachDeckGenerationJobScope {
  jobId: string;
  kind: 'decksmith';
  runId: string;
  requestHash: string;
  baseDocumentHash: string;
  queuedAt: string;
  runtimeRunId?: string;
  resultRef?: string;
  pageId?: string;
}

export interface ReachDeckWorkspaceRecoveryDecksmithResult {
  jobId: string;
  requestHash: string;
  baseDocumentHash: string;
  resultHash: string;
  storedAt: string;
  result: ReachDeckDecksmithJobResult;
}

/**
 * 一个可能持有在飞 TTS 票据的块。
 *
 * v3 之前整份 continuation 只跟踪一个块（单游标），并发分块后同一 job 会同时持有
 * 多张票据，队列状态与审计序号也必须按块各记一份——跨块的 attempt 序号本就没有
 * 可比性，拿全局单序列去断言单调递增在并发下必然误报。
 */
export interface ReachDeckWorkspaceTtsActiveChunk {
  chunkIndex: number;
  queueIdentity: string;
  queue?: ReachDeckTtsQueueState;
  highestObservedAttempt: number;
  highestAuditedAttempt: number;
  auditClaimId?: string;
}

export interface ReachDeckWorkspaceTtsContinuation {
  schemaVersion:
    | 'reach-deck-tts-continuation/v2'
    | 'reach-deck-tts-continuation/v3'
    | 'reach-deck-tts-continuation/v4';
  jobId: string;
  runId: string;
  requestHash: string;
  pageId: string;
  sourceKind:
    | 'workspace'
    | 'workspace-interactive'
    | 'materialized-interactive'
    | 'materialized-native';
  layoutDigest: string;
  narrationDigest: string;
  queueIdentity: string;
  /** v4 记录全部可能在飞的块；v3 的单游标迁移为单元素数组。 */
  activeChunks?: ReachDeckWorkspaceTtsActiveChunk[];
  /** 被换掉但可能还挂着上游票据的旧块身份，只用于取消。 */
  supersededQueueIdentities?: string[];
  speechMarkup?: ReachDeckSpeechMarkupV1;
  /**
   * Formula readings fixed before the first TTS dispatch. Re-generating them on a queued-TTS poll
   * would change chunk synthesis digests and request identities, so every poll reuses these.
   */
  formulaReadings?: ReachDeckFormulaReadingV1[];
  voiceSelection: ReachDeckVoiceSelection;
  voiceDigest: string;
  prepared: ReachDeckPreparedSlideNarration | ReachDeckPreparedNativeNarration;
  queue?: ReachDeckTtsQueueState;
  highestObservedAttempt: number;
  highestAuditedAttempt: number;
  auditClaimId?: string;
}

export interface ReachDeckWorkspaceRecoveryState {
  schemaVersion: ReachDeckWorkspaceRecoverySchemaVersion;
  jobs: Record<string, ReachDeckWorkspaceRecoveryJob>;
  results: Record<string, ReachDeckWorkspaceRecoveryResult>;
  decksmithJobs: Record<string, ReachDeckWorkspaceRecoveryDecksmithJob>;
  decksmithResults: Record<string, ReachDeckWorkspaceRecoveryDecksmithResult>;
  ttsContinuations: Record<string, ReachDeckWorkspaceTtsContinuation>;
  batches: ReachDeckWorkspaceBatches;
  batchRequests: ReachDeckWorkspaceBatchRequests;
  structuralMutations: ReachDeckWorkspaceStructuralMutations;
  structuralJobTombstones: ReachDeckWorkspaceStructuralJobTombstones;
  mediaCheckpoints: ReachDeckMediaCheckpoints;
  importGenerationIntents?: ReachDeckImportGenerationIntents;
  /** 已取消生成、待从工作区退役的被删页；为空时不落盘。 */
  deletedPageRetirements?: ReachDeckDeletedPageRetirements;
}

export const REACH_DECK_WORKSPACE_STRUCTURAL_MUTATION_SCHEMA_VERSION =
  'reach-deck-workspace-structural-mutation/v1' as const;

export interface ReachDeckWorkspaceStructuralMutation {
  schemaVersion: typeof REACH_DECK_WORKSPACE_STRUCTURAL_MUTATION_SCHEMA_VERSION;
  runId: string;
  owner: ReachDeckWorkspaceBatch['owner'];
  phase: 'pending-cleanup';
  fencedAt: string;
  batchIds: string[];
  /** Exact standalone job identities protected by a materialized page structure save. */
  preservedJobIds?: string[];
}

export type ReachDeckWorkspaceStructuralMutations = Record<
  string,
  ReachDeckWorkspaceStructuralMutation
>;

export const REACH_DECK_WORKSPACE_STRUCTURAL_JOB_TOMBSTONE_SCHEMA_VERSION =
  'reach-deck-workspace-structural-job-tombstone/v1' as const;

export interface ReachDeckWorkspaceStructuralJobTombstone {
  schemaVersion: typeof REACH_DECK_WORKSPACE_STRUCTURAL_JOB_TOMBSTONE_SCHEMA_VERSION;
  jobId: string;
  runId: string;
  owner: ReachDeckWorkspaceBatch['owner'];
  pageId: string;
  requestedRevision: number;
  attempt: number;
  requestHash: string;
  cancelledAt: string;
  reason: 'structural-mutation';
}

export type ReachDeckWorkspaceStructuralJobTombstones = Record<
  string,
  ReachDeckWorkspaceStructuralJobTombstone
>;

export interface ReachDeckStructuralJobCleanupDependencies {
  queue?: ReachDeckGenerationQueue;
  createQueue?: () => Promise<ReachDeckGenerationQueue>;
  runtime?: TeacherDeckRuntime;
  readAudit?: typeof getReachDeckGenerationAudit;
  abortAudit?: typeof abortReachDeckGenerationAuditByScopeWithNarrowRetry;
  updateAudit?: typeof updateReachDeckGenerationAuditByScopeWithNarrowRetry;
  cancelSpeech?: typeof cancelReachDeckSpeech;
  exchangeVoiceCapability?: typeof exchangeReachDeckVoiceCapability;
}

export class ReachDeckStructuralJobCleanupPendingError extends Error {
  constructor(readonly pendingJobIds: readonly string[]) {
    super('Reach Deck structural generation cleanup is still pending');
    this.name = 'ReachDeckStructuralJobCleanupPendingError';
  }
}

export class ReachDeckStructuralJobTombstoneCapacityError extends ReachDeckWorkspaceBatchCapacityError {
  constructor(message: string) {
    super(message);
    this.name = 'ReachDeckStructuralJobTombstoneCapacityError';
  }
}

class ReachDeckStructuralJobIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReachDeckStructuralJobIdentityError';
  }
}

class ReachDeckStructuralJobCleanupDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReachDeckStructuralJobCleanupDeferredError';
  }
}

export interface ReachDeckWorkspaceRecoveryResource extends ReachDeckResourceScope {
  recoveryRevision: number;
  recovery: ReachDeckWorkspaceRecoveryState;
  /** Conservative JSON byte estimate used to stay below Mongo's 16 MiB document ceiling. */
  workspaceBytes: number;
}

export interface ReachDeckRecoveredJobMetadata extends ReachDeckJobResponseMetadata {
  done?: boolean;
  jobId: string;
  kind: ReachDeckStagedGenerationJobKind | 'decksmith';
  runId: string;
  status: string;
  pollPath: string;
  eventsPath: string;
  pollIntervalMs: number;
  pageId?: string;
  /** Page revision captured when a page/narration job was requested. */
  requestedRevision?: number;
  /** Native whole-deck narration chain identity, when present. */
  chainId?: string;
  /** Descriptor registration time, used only for deterministic recovery ordering. */
  queuedAt?: string;
  /** Decksmith-only provenance used by browser recovery when sessionStorage is unavailable. */
  baseDocumentHash?: string;
  runtimeApprovalId?: string;
  nativeAudioFailure?: {
    pageId: string;
    requestedRevision: number;
    markdown: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
    audioFailureCode: string;
  };
}

export interface ReachDeckWorkspaceBatchView {
  batchId: string;
  runId: string;
  kind: 'narration' | 'media' | 'regeneration';
  status: 'active' | 'cancelling' | 'completed' | 'partial-failure' | 'cancelled' | 'stopped';
  revision: number;
  createdAt: string;
  members: Array<{
    pageId: string;
    order: number;
    status: string;
    requestedRevision: number;
    done: boolean;
    jobId?: string;
    reason?: string;
    blockedByPageId?: string;
    generationKind?: 'page-generation' | 'narration-generation';
    affectedLanes?: ('layout' | 'narration' | 'audio' | 'animation' | 'image')[];
  }>;
  skipped: ReachDeckWorkspaceBatch['skipped'];
  terminalSummary?: ReachDeckWorkspaceBatch['terminalSummary'];
}

class ReachDeckWorkspaceRecoveryConflictError extends Error {
  constructor() {
    super('Reach Deck recovery state changed since it was loaded');
    this.name = 'ReachDeckWorkspaceRecoveryConflictError';
  }
}

export function emptyReachDeckWorkspaceRecovery(): ReachDeckWorkspaceRecoveryState {
  return {
    schemaVersion: REACH_DECK_WORKSPACE_RECOVERY_SCHEMA_VERSION,
    jobs: {},
    results: {},
    decksmithJobs: {},
    decksmithResults: {},
    ttsContinuations: {},
    batches: {},
    batchRequests: {},
    structuralMutations: {},
    structuralJobTombstones: {},
    mediaCheckpoints: {},
    importGenerationIntents: {},
  };
}

export async function loadReachDeckWorkspaceRecovery(
  context: ReachDeckWorkspaceContext,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  return toRecoveryResource(await getReachDeckWorkspace(context), context);
}

const WORKSPACE_READ_PROJECTION = Symbol.for('reachany.reach-deck.workspace-read-snapshot.v1');
const RECOVERY_READ_PROJECTION = Symbol.for('reachany.reach-deck.recovery-read-snapshot.v1');

/** Read models remain independent per request. Writers and CAS retries use the uncached parser. */
export async function loadReachDeckWorkspaceReadSnapshot(context: ReachDeckWorkspaceContext) {
  return getReachDeckWorkspaceReadProjection(context, {
    key: WORKSPACE_READ_PROJECTION,
    parse: (resource) => ({
      resource: toWorkspaceResource(resource, context.resourceScope),
      recovery: toRecoveryResource(resource, context),
    }),
  });
}

async function loadReachDeckWorkspaceRecoveryReadSnapshot(context: ReachDeckWorkspaceContext) {
  return getReachDeckWorkspaceReadProjection(context, {
    key: RECOVERY_READ_PROJECTION,
    parse: (resource) => toRecoveryResource(resource, context),
  });
}

export type ReachDeckWorkspaceReadSnapshot = Awaited<
  ReturnType<typeof loadReachDeckWorkspaceReadSnapshot>
>;

function toRecoveryResource(
  resource: ReachDeckWorkspaceResource,
  context: ReachDeckWorkspaceContext,
): ReachDeckWorkspaceRecoveryResource {
  const resourceScope = parseReachDeckResourceScope(context.resourceScope);
  if (!sameReachDeckResourceScope(resource, resourceScope)) {
    throw new Error('content-service returned the wrong Reach Deck recovery identity');
  }
  return {
    ...resourceScope,
    recoveryRevision: resource.recoveryRevision,
    recovery: measureWorkspaceReadPhase('recovery-parse', () =>
      parseReachDeckWorkspaceRecovery(resource.recovery),
    ),
    workspaceBytes: jsonByteLength(resource.workspace),
  };
}

/** Model work must happen outside this pure CAS transition, after a persisted claim. */
export async function transitionReachDeckWorkspaceMediaCheckpoints(
  context: ReachDeckWorkspaceContext,
  transition: (checkpoints: ReachDeckMediaCheckpoints) => ReachDeckMediaCheckpoints,
): Promise<ReachDeckMediaCheckpoints> {
  const saved = await transitionReachDeckWorkspaceRecovery(context, (current) => ({
    ...current,
    mediaCheckpoints: parseReachDeckMediaCheckpoints(transition(current.mediaCheckpoints)),
  }));
  return saved.recovery.mediaCheckpoints;
}

/**
 * Keep recovery-capable attempts and authoritative visual receipts, while collecting receipts
 * whose run has no durable job or tombstone left. Unknown/in-flight entries are intentionally
 * retained because their absence could cause a paid provider call to be replayed.
 */
export function pruneReachDeckMediaCheckpoints(
  checkpoints: ReachDeckMediaCheckpoints,
  recovery: Pick<ReachDeckWorkspaceRecoveryState, 'jobs' | 'structuralJobTombstones' | 'batches'>,
): ReachDeckMediaCheckpoints {
  const liveRunIds = new Set<string>();
  for (const job of Object.values(recovery.jobs)) liveRunIds.add(job.runId);
  for (const tombstone of Object.values(recovery.structuralJobTombstones)) {
    liveRunIds.add(tombstone.runId);
  }
  for (const batch of Object.values(recovery.batches)) {
    if (batch.phase !== 'terminal') liveRunIds.add(batch.runId);
  }
  const livePageRequests = new Set(
    Object.values(recovery.jobs)
      .filter((job) => job.kind === 'page-generation')
      .map((job) => `${job.runId}|${job.pageId}|${job.requestedRevision}|${job.requestHash}`),
  );
  return Object.fromEntries(
    Object.entries(checkpoints).filter(([, checkpoint]) => {
      if (checkpoint.state === 'in_flight' || checkpoint.state === 'outcome_unknown') return true;
      if (!liveRunIds.has(checkpoint.identity.runId)) return false;
      const identity = checkpoint.identity;
      return livePageRequests.has(
        `${identity.runId}|${identity.pageId}|${identity.requestedRevision}|${identity.originalRequestHash}`,
      );
    }),
  );
}

export async function transitionReachDeckWorkspaceBatches(
  context: ReachDeckWorkspaceContext,
  transition: (batches: ReachDeckWorkspaceBatches) => ReachDeckWorkspaceBatches,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  const apply = () =>
    transitionReachDeckWorkspaceRecovery(context, (current) => ({
      ...current,
      schemaVersion: REACH_DECK_WORKSPACE_RECOVERY_V5_SCHEMA_VERSION,
      batches: retainRecentReachDeckWorkspaceBatches(transition(structuredClone(current.batches))),
    }));
  return retryAfterStructuralTombstoneCapacityRecovery(context, apply);
}

export async function transitionReachDeckWorkspaceBatchState(
  context: ReachDeckWorkspaceContext,
  transition: (state: {
    batches: ReachDeckWorkspaceBatches;
    batchRequests: ReachDeckWorkspaceBatchRequests;
    structuralMutations: ReachDeckWorkspaceStructuralMutations;
  }) => {
    batches: ReachDeckWorkspaceBatches;
    batchRequests: ReachDeckWorkspaceBatchRequests;
  },
): Promise<ReachDeckWorkspaceRecoveryResource> {
  const apply = () =>
    transitionReachDeckWorkspaceRecovery(context, (current) => {
      const next = transition({
        batches: structuredClone(current.batches),
        batchRequests: structuredClone(current.batchRequests),
        structuralMutations: structuredClone(current.structuralMutations),
      });
      return {
        ...current,
        schemaVersion: REACH_DECK_WORKSPACE_RECOVERY_V5_SCHEMA_VERSION,
        batches: retainRecentReachDeckWorkspaceBatches(next.batches),
        batchRequests: next.batchRequests,
      };
    });
  return retryAfterStructuralTombstoneCapacityRecovery(context, apply);
}

export async function transitionReachDeckImportGenerationIntents(
  context: ReachDeckWorkspaceContext,
  transition: (intents: ReachDeckImportGenerationIntents) => ReachDeckImportGenerationIntents,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  return transitionReachDeckWorkspaceRecovery(context, (current) => ({
    ...current,
    importGenerationIntents: parseReachDeckImportGenerationIntents(
      transition(structuredClone(current.importGenerationIntents ?? {})),
    ),
  }));
}

export async function readReachDeckWorkspaceBatchRequest(
  context: ReachDeckWorkspaceContext,
  requestHash: string,
): Promise<{
  request: ReachDeckWorkspaceBatchRequests[string];
  batch: ReachDeckWorkspaceBatch | null;
} | null> {
  const recovery = (await loadReachDeckWorkspaceRecovery(context)).recovery;
  const request = recovery.batchRequests[requestHash];
  if (request === undefined) return null;
  return { request, batch: recovery.batches[request.batchId] ?? null };
}

export async function readReachDeckWorkspaceBatch(
  context: ReachDeckWorkspaceContext,
  batchId: string,
): Promise<ReachDeckWorkspaceBatch | null> {
  const batch = (await loadReachDeckWorkspaceRecovery(context)).recovery.batches[batchId];
  return batch !== undefined && sameReachDeckWorkspaceBatchOwner(batch, context) ? batch : null;
}

export async function fenceReachDeckWorkspaceBatchesForStructuralMutation(
  context: ReachDeckWorkspaceContext,
  runId: string,
  unchangedPageIds?: readonly string[],
  survivingImagePageIds: readonly string[] | undefined = unchangedPageIds,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  const fencedAt = new Date().toISOString();
  return transitionReachDeckWorkspaceRecovery(context, (current) => {
    const existing = current.structuralMutations[runId];
    // 图片补丁按元素/资源身份落地；插页、排序不应取消仍存在页面的付费任务。
    const preservedImageBatches = new Set(
      Object.values(current.batches)
        .filter(
          (batch) =>
            batch.runId === runId &&
            batch.phase !== 'terminal' &&
            batch.phase !== 'stopped' &&
            survivingImagePageIds !== undefined &&
            batch.members.every(
              (member) =>
                member.terminalOutcome !== undefined ||
                (survivingImagePageIds.includes(member.pageId) &&
                  member.regeneration?.stage === 'image' &&
                  member.regeneration.plan.channels.image === true &&
                  !member.regeneration.plan.channels.layout &&
                  !member.regeneration.plan.channels.narration &&
                  !member.regeneration.plan.channels.audio &&
                  !member.regeneration.plan.channels.animation),
            ),
        )
        .map((batch) => batch.batchId),
    );
    const affected = Object.values(current.batches).filter(
      (batch) =>
        batch.runId === runId &&
        !preservedImageBatches.has(batch.batchId) &&
        batch.phase !== 'terminal' &&
        (batch.phase !== 'stopped' || batch.stopReason === 'structural-mutation'),
    );
    if (affected.length === 0 && existing === undefined && unchangedPageIds === undefined)
      return current;
    if (affected.some((batch) => !sameReachDeckWorkspaceBatchOwner(batch, context))) {
      throw new Error('Reach Deck structural mutation batch owner does not match');
    }
    if (
      existing !== undefined &&
      !sameReachDeckWorkspaceBatchOwner({ owner: existing.owner }, context)
    ) {
      throw new Error('Reach Deck structural mutation owner does not match');
    }
    const batchIds = [
      ...new Set([...affected.map((batch) => batch.batchId), ...(existing?.batchIds ?? [])]),
    ].sort();
    const referenced = new Set(
      Object.values(current.batches).flatMap((batch) =>
        batch.members.flatMap((member) => (member.jobId === undefined ? [] : [member.jobId])),
      ),
    );
    const preservedJobIds =
      existing?.preservedJobIds ??
      (unchangedPageIds === undefined
        ? undefined
        : Object.values(current.jobs)
            .filter(
              (job) =>
                job.runId === runId &&
                ((job.kind === 'narration-generation' &&
                  job.pageId !== undefined &&
                  unchangedPageIds.includes(job.pageId) &&
                  job.chainId === undefined &&
                  !referenced.has(job.jobId) &&
                  sameScope(job, context)) ||
                  Object.values(current.batches).some(
                    (batch) =>
                      preservedImageBatches.has(batch.batchId) &&
                      batch.members.some((member) => member.jobId === job.jobId),
                  )),
            )
            .map((job) => job.jobId)
            .sort());
    let changed = existing === undefined || batchIds.join('\0') !== existing.batchIds.join('\0');
    const fenced = Object.fromEntries(
      Object.entries(current.batches).map(([batchId, batch]) => {
        if (
          batch.runId !== runId ||
          batch.phase === 'terminal' ||
          batch.phase === 'stopped' ||
          preservedImageBatches.has(batchId)
        ) {
          return [batchId, batch];
        }
        changed = true;
        return [
          batchId,
          {
            ...batch,
            phase: 'stopped' as const,
            stopReason: 'structural-mutation',
            revision: batch.revision + 1,
          },
        ];
      }),
    );
    return changed
      ? {
          ...current,
          schemaVersion: REACH_DECK_WORKSPACE_RECOVERY_V5_SCHEMA_VERSION,
          batches: retainRecentReachDeckWorkspaceBatches(fenced),
          structuralMutations: {
            ...current.structuralMutations,
            [runId]:
              existing === undefined
                ? {
                    schemaVersion: REACH_DECK_WORKSPACE_STRUCTURAL_MUTATION_SCHEMA_VERSION,
                    runId,
                    owner: {
                      actorId: context.actorId,
                      actorOrganizationId: actorOrganizationIdFromPayload(context),
                      billingGroupId: context.billingGroupId,
                      roleGrantId: context.roleGrantId,
                      resourceScope: parseReachDeckResourceScope(context.resourceScope),
                    },
                    phase: 'pending-cleanup',
                    fencedAt,
                    batchIds,
                    ...(preservedJobIds === undefined ? {} : { preservedJobIds }),
                  }
                : { ...existing, batchIds },
          },
        }
      : current;
  });
}

export async function registerReachDeckWorkspaceJob(
  payload: ReachDeckStagedGenerationJobPayload,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  // Never register a recovery descriptor whose frozen input PostgreSQL will reject; the
  // descriptor would outlive the failed write and every retry would report missing input.
  if (payload.kind === 'page-outline')
    assertReachDeckOutlineInputTextSafe({ request: payload.request });
  const context = scopeFromPayload(payload);
  const apply = () =>
    transitionReachDeckWorkspaceRecovery(context, (current) => {
      const descriptor = descriptorFromPayload(payload);
      const existing = current.jobs[payload.jobId];
      if (
        descriptor.scientificContextSourceHash !== undefined &&
        Object.values(current.jobs).some(
          (job) =>
            job.jobId !== descriptor.jobId &&
            job.kind === descriptor.kind &&
            job.runId === descriptor.runId &&
            job.actorId === descriptor.actorId &&
            job.scientificContextSourceHash === descriptor.scientificContextSourceHash &&
            (job.kind !== 'page-outline' ||
              job.createdFromDraftRevision === descriptor.createdFromDraftRevision),
        )
      ) {
        throw new Error(
          'Reach Deck scientific generation already has a frozen task for this request',
        );
      }
      if (existing !== undefined) {
        assertSameDescriptor(existing, descriptor);
        if (existing.affectedLanes === undefined && descriptor.affectedLanes !== undefined)
          return {
            ...current,
            jobs: {
              ...current.jobs,
              [payload.jobId]: { ...existing, affectedLanes: descriptor.affectedLanes },
            },
          };
        return current;
      }
      return {
        ...current,
        schemaVersion: promoteRecoveryForStagedJob(current.schemaVersion),
        jobs: { ...current.jobs, [payload.jobId]: descriptor },
      };
    });
  return retryAfterStructuralTombstoneCapacityRecovery(context, apply);
}

/** Find the original private input before a retry can consult today's capability catalog. */
export async function replayReachDeckScientificJob(
  provisional: ReachDeckStagedGenerationJobPayload,
): Promise<ReachDeckStagedGenerationJobPayload | undefined> {
  const resource = await loadReachDeckWorkspaceRecovery(scopeFromPayload(provisional));
  const sourceHash = stagedScientificSourceRequestHash(provisional);
  const matches = Object.values(resource.recovery.jobs).filter(
    (job) =>
      job.scientificContextSourceHash === sourceHash &&
      job.kind === provisional.kind &&
      job.runId === provisional.runId &&
      job.actorId === provisional.actorId &&
      sameReachDeckResourceScope(job.resourceScope, provisional.resourceScope) &&
      (job.kind !== 'page-outline' ||
        job.createdFromDraftRevision === provisional.createdFromDraftRevision),
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1)
    throw new Error('Reach Deck scientific frozen task identity is ambiguous');
  const descriptor = matches[0]!;
  const run = await getRuntimeStore().getRunByRequestKey(
    {
      subject: provisional.actorId,
      orgId: actorOrganizationIdFromPayload(provisional),
      roles: ['teacher'],
      ...(provisional.billingGroupId === null
        ? {}
        : { billingGroupId: provisional.billingGroupId }),
    },
    'teacher.deck',
    descriptor.jobId,
  );
  const frozen = parseReachDeckStagedFrozenRunInput(run?.input);
  const payload = parseReachDeckStagedGenerationJobPayload(frozen.payload);
  if (
    payload.jobId !== descriptor.jobId ||
    payload.requestHash !== descriptor.requestHash ||
    payload.actorId !== provisional.actorId ||
    payload.billingGroupId !== provisional.billingGroupId ||
    payload.roleGrantId !== provisional.roleGrantId ||
    payload.runId !== provisional.runId ||
    payload.kind !== provisional.kind ||
    stagedScientificSourceRequestHash(payload) !== sourceHash ||
    !sameReachDeckResourceScope(payload.resourceScope, provisional.resourceScope)
  ) {
    throw new Error('Reach Deck scientific frozen task provenance is invalid');
  }
  return payload;
}

type NarrationJobPayload = Extract<
  ReachDeckStagedGenerationJobPayload,
  { kind: 'narration-generation' }
>;

function assertNarrationJobRegistered(
  current: ReachDeckWorkspaceRecoveryState,
  payload: NarrationJobPayload,
): void {
  if (current.jobs[payload.jobId]?.kind !== 'narration-generation') {
    throw new ReachDeckWorkspaceJobDescriptorMissingError();
  }
}

export async function storeReachDeckWorkspaceTtsContinuation(
  payload: NarrationJobPayload,
  prepared: ReachDeckPreparedSlideNarration | ReachDeckPreparedNativeNarration,
  queueIdentity: string,
  formulaReadings: readonly ReachDeckFormulaReadingV1[] = [],
): Promise<ReachDeckWorkspaceTtsContinuation> {
  const candidate = continuationFrom(payload, prepared, queueIdentity, formulaReadings);
  const saved = await transitionReachDeckWorkspaceRecovery(scopeFromPayload(payload), (current) => {
    assertNarrationJobRegistered(current, payload);
    const existing = current.ttsContinuations[payload.jobId];
    if (existing !== undefined) {
      if (
        payload.request.sourceKind === 'materialized-interactive' &&
        payload.request.mode === 'regenerate-text'
      ) {
        // A duplicate worker may finish the model call after another worker has persisted
        // a different valid rewrite. Adopt the winner only under exactly the same provenance.
        assertContinuationMatchesPayload(existing, payload);
        if (existing.queueIdentity !== candidate.queueIdentity) {
          throw new Error('Reach Deck TTS continuation queue identity changed');
        }
        return current;
      }
      assertSameTtsContinuation(existing, candidate);
      return current;
    }
    return {
      ...current,
      schemaVersion: promoteRecoveryForTts(current.schemaVersion),
      ttsContinuations: { ...current.ttsContinuations, [payload.jobId]: candidate },
    };
  });
  return saved.recovery.ttsContinuations[payload.jobId]!;
}

export async function readReachDeckWorkspaceTtsContinuation(
  payload: NarrationJobPayload,
): Promise<ReachDeckWorkspaceTtsContinuation | null> {
  const resource = await loadReachDeckWorkspaceRecovery(scopeFromPayload(payload));
  const continuation = resource.recovery.ttsContinuations[payload.jobId];
  if (continuation === undefined) return null;
  assertContinuationMatchesPayload(continuation, payload);
  return continuation;
}

/** 同一 job 能同时跟踪的在飞块数上限：单页讲稿上限 1 万字符，按最小块长也到不了。 */
const MAX_TTS_ACTIVE_CHUNKS = 256;

/**
 * 登记一个块的托管 TTS 票据，供取消与恢复使用。
 *
 * 数据源：工作区恢复文档（Mongo）的 ttsContinuations。
 *
 * 核心逻辑：
 * <ol>
 *   <li>同块同身份重复登记直接返回，保证幂等</li>
 *   <li>同块换了身份则整条替换，并清空该块的队列状态与审计序号——换身份意味着
 *       这是一次全新的上游请求，旧序号不再可比</li>
 *   <li>新块追加进集合，超出上限时拒绝，避免异常输入撑爆恢复文档</li>
 * </ol>
 *
 * 与 v3 的差别：不再有「游标只能停在原地或加一」的约束。那条约束是为串行分块设计
 * 的，并发下第一个 tick 就会误报；而每块本来就有独立幂等键，重跑时已完成的块直接
 * 命中缓存，续跑语义从「续上第 N 块」变成「补齐未完成的块集合」，本就无需游标。
 */
export async function activateReachDeckWorkspaceTtsChunk(
  payload: NarrationJobPayload,
  chunkIndex: number,
  queueIdentity: string,
): Promise<ReachDeckWorkspaceTtsContinuation> {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('Reach Deck TTS chunk index is invalid');
  }
  const identity = requireString(queueIdentity, 'TTS active queueIdentity', 128);
  const saved = await transitionReachDeckWorkspaceRecovery(scopeFromPayload(payload), (current) => {
    assertNarrationJobRegistered(current, payload);
    const existing = current.ttsContinuations[payload.jobId];
    if (existing === undefined) throw new Error('Reach Deck TTS continuation is missing');
    assertContinuationMatchesPayload(existing, payload);
    const active = existing.activeChunks ?? [];
    const found = active.find((entry) => entry.chunkIndex === chunkIndex);
    if (found !== undefined && found.queueIdentity === identity) return current;
    if (found === undefined && active.length >= MAX_TTS_ACTIVE_CHUNKS) {
      throw new Error('Reach Deck TTS continuation exceeds the active chunk limit');
    }
    const replacement: ReachDeckWorkspaceTtsActiveChunk = {
      chunkIndex,
      queueIdentity: identity,
      highestObservedAttempt: 0,
      highestAuditedAttempt: 0,
    };
    const activeChunks =
      found === undefined
        ? [...active, replacement]
        : active.map((entry) => (entry.chunkIndex === chunkIndex ? replacement : entry));
    // 换身份意味着这是一次全新的上游请求，但旧那张票可能还挂着：留给取消链路，
    // 否则它会占着准入并发额度直到自然超时。
    const superseded =
      found === undefined
        ? (existing.supersededQueueIdentities ?? [])
        : [...new Set([...(existing.supersededQueueIdentities ?? []), found.queueIdentity])].slice(
            -MAX_TTS_ACTIVE_CHUNKS,
          );
    return {
      ...current,
      schemaVersion: promoteRecoveryForTts(current.schemaVersion),
      ttsContinuations: {
        ...current.ttsContinuations,
        [payload.jobId]: {
          ...existing,
          schemaVersion: 'reach-deck-tts-continuation/v4',
          activeChunks: sortedActiveChunks(activeChunks),
          ...(superseded.length === 0 ? {} : { supersededQueueIdentities: superseded }),
        },
      },
    };
  });
  return saved.recovery.ttsContinuations[payload.jobId]!;
}

/** 记录某块最新的队列状态；attempt 序号按块单调，跨块互不比较。 */
export async function observeReachDeckWorkspaceTtsQueueState(
  payload: NarrationJobPayload,
  chunkIndex: number,
  queue: ReachDeckTtsQueueState,
): Promise<ReachDeckWorkspaceTtsContinuation> {
  const saved = await transitionReachDeckWorkspaceRecovery(scopeFromPayload(payload), (current) => {
    assertNarrationJobRegistered(current, payload);
    const existing = current.ttsContinuations[payload.jobId];
    if (existing === undefined) throw new Error('Reach Deck TTS continuation is missing');
    assertContinuationMatchesPayload(existing, payload);
    const chunk = resolveActiveChunk(existing, chunkIndex);
    if (
      chunk.queue !== undefined &&
      (chunk.queue.ticket !== queue.ticket ||
        chunk.queue.queuedAtEpochMillis !== queue.queuedAtEpochMillis ||
        chunk.queue.expiresAtEpochMillis !== queue.expiresAtEpochMillis)
    ) {
      throw new Error('Reach Deck TTS queue identity changed during recovery');
    }
    if (queue.upstreamAttempts < chunk.highestObservedAttempt) {
      throw new Error('Reach Deck TTS upstream attempt ordinal regressed during recovery');
    }
    // pollAfterMillis 每次轮询都带抖动、落库后也不再读取；只有它变了就不写，免得每次排队轮询都 CAS 一次。
    if (
      chunk.queue !== undefined &&
      valuesEqual({ ...chunk.queue, pollAfterMillis: 0 }, { ...queue, pollAfterMillis: 0 })
    ) {
      return current;
    }
    return {
      ...current,
      schemaVersion: promoteRecoveryForTts(current.schemaVersion),
      ttsContinuations: {
        ...current.ttsContinuations,
        [payload.jobId]: withActiveChunk(existing, chunkIndex, {
          ...chunk,
          queue,
          highestObservedAttempt: Math.max(chunk.highestObservedAttempt, queue.upstreamAttempts),
        }),
      },
    };
  });
  return saved.recovery.ttsContinuations[payload.jobId]!;
}

/** 认领某块某个 attempt 的审计权，保证同一 attempt 只落一条审计。 */
export async function claimReachDeckWorkspaceTtsAuditOrdinal(
  payload: NarrationJobPayload,
  chunkIndex: number,
  ordinal: number,
  claimId: string,
): Promise<boolean> {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return false;
  const saved = await transitionReachDeckWorkspaceRecovery(scopeFromPayload(payload), (current) => {
    assertNarrationJobRegistered(current, payload);
    const existing = current.ttsContinuations[payload.jobId];
    if (existing === undefined) throw new Error('Reach Deck TTS continuation is missing');
    assertContinuationMatchesPayload(existing, payload);
    const chunk = resolveActiveChunk(existing, chunkIndex);
    if (chunk.highestAuditedAttempt >= ordinal) return current;
    return {
      ...current,
      schemaVersion: promoteRecoveryForTts(current.schemaVersion),
      ttsContinuations: {
        ...current.ttsContinuations,
        [payload.jobId]: withActiveChunk(existing, chunkIndex, {
          ...chunk,
          highestObservedAttempt: Math.max(chunk.highestObservedAttempt, ordinal),
          highestAuditedAttempt: ordinal,
          auditClaimId: claimId,
        }),
      },
    };
  });
  const claimed = findActiveChunk(saved.recovery.ttsContinuations[payload.jobId], chunkIndex);
  return claimed?.highestAuditedAttempt === ordinal && claimed.auditClaimId === claimId;
}

function sortedActiveChunks(
  chunks: readonly ReachDeckWorkspaceTtsActiveChunk[],
): ReachDeckWorkspaceTtsActiveChunk[] {
  return [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
}

function findActiveChunk(
  continuation: ReachDeckWorkspaceTtsContinuation | undefined,
  chunkIndex: number,
): ReachDeckWorkspaceTtsActiveChunk | undefined {
  return continuation?.activeChunks?.find((entry) => entry.chunkIndex === chunkIndex);
}

/**
 * 取某块的状态条目，不存在则按页级身份补一条。
 *
 * 不分块的路径（不要时间戳的请求）不会调 {@link activateReachDeckWorkspaceTtsChunk}，
 * 但仍会上报队列状态与审计序号。对这类请求，页级 queueIdentity 就是它唯一的票据
 * 身份，补建条目既让它有地方落状态，也让取消时能扫到它。
 */
function resolveActiveChunk(
  continuation: ReachDeckWorkspaceTtsContinuation,
  chunkIndex: number,
): ReachDeckWorkspaceTtsActiveChunk {
  return (
    findActiveChunk(continuation, chunkIndex) ?? {
      chunkIndex,
      queueIdentity: continuation.queueIdentity,
      highestObservedAttempt: 0,
      highestAuditedAttempt: 0,
    }
  );
}

function withActiveChunk(
  continuation: ReachDeckWorkspaceTtsContinuation,
  chunkIndex: number,
  replacement: ReachDeckWorkspaceTtsActiveChunk,
): ReachDeckWorkspaceTtsContinuation {
  const active = continuation.activeChunks ?? [];
  const activeChunks = active.some((entry) => entry.chunkIndex === chunkIndex)
    ? active.map((entry) => (entry.chunkIndex === chunkIndex ? replacement : entry))
    : [...active, replacement];
  if (activeChunks.length > MAX_TTS_ACTIVE_CHUNKS) {
    throw new Error('Reach Deck TTS continuation exceeds the active chunk limit');
  }
  return {
    ...continuation,
    schemaVersion: 'reach-deck-tts-continuation/v4',
    activeChunks: sortedActiveChunks(activeChunks),
  };
}

/**
 * 该 continuation 名下所有可能还挂着票据的请求身份。
 *
 * 三个来源全部取并集，一个都不能少：
 * <ol>
 *   <li>页级 `queueIdentity`——不分块的请求用它；滚动升级时旧 worker 留下的整页票据
 *       也挂在它名下。若只在集合为空时才回退到它，升级后新 worker 一登记分块身份，
 *       那张整页票就从取消链路上消失，而它正对应最长的那次对齐</li>
 *   <li>当前在飞的各块身份</li>
 *   <li>被顶替的旧块身份——块身份由内容摘要决定，本次改动调整了摘要输入，升级后同一
 *       块会换身份，旧那张票同样要取消</li>
 * </ol>
 *
 * 多取消几个不存在的身份是安全的：上游对未知身份返回 not_found。漏取消才会让票据
 * 占着准入并发额度（全局仅 10）直到自然超时。
 */
export function reachDeckTtsContinuationQueueIdentities(
  continuation: ReachDeckWorkspaceTtsContinuation,
): string[] {
  return [
    ...new Set([
      continuation.queueIdentity,
      ...(continuation.activeChunks ?? []).map((entry) => entry.queueIdentity),
      ...(continuation.supersededQueueIdentities ?? []),
    ]),
  ];
}

/** 是否还有可能在飞的票据；决定清扫时要不要发取消。 */
export function reachDeckTtsContinuationHasActiveTicket(
  continuation: ReachDeckWorkspaceTtsContinuation,
): boolean {
  return (continuation.activeChunks ?? []).length > 0;
}

export async function clearReachDeckWorkspaceTtsContinuation(
  payload: NarrationJobPayload,
): Promise<void> {
  await transitionReachDeckWorkspaceRecovery(scopeFromPayload(payload), (current) => {
    if (current.ttsContinuations[payload.jobId] === undefined) return current;
    const ttsContinuations = { ...current.ttsContinuations };
    delete ttsContinuations[payload.jobId];
    return { ...current, ttsContinuations };
  });
}

export async function registerReachDeckWorkspaceDecksmithJob(
  payloadValue: ReachDeckDecksmithJobPayload,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  const payload = parseReachDeckDecksmithJobPayload(payloadValue);
  return transitionReachDeckWorkspaceRecovery(scopeFromDecksmithPayload(payload), (current) => {
    const descriptor = decksmithDescriptorFromPayload(payload);
    const existing = current.decksmithJobs[payload.jobId];
    if (existing !== undefined) {
      assertSameDecksmithDescriptor(existing, descriptor);
      return current;
    }
    const runCollision = Object.values(current.decksmithJobs).find(
      (candidate) => candidate.runId === descriptor.runId,
    );
    if (runCollision !== undefined) {
      throw new ReachDeckDecksmithIdempotencyConflictError();
    }
    return {
      ...current,
      schemaVersion: promoteRecoveryForDecksmith(current.schemaVersion),
      decksmithJobs: { ...current.decksmithJobs, [payload.jobId]: descriptor },
    };
  });
}

export async function storeReachDeckWorkspaceDecksmithResult(
  payloadValue: ReachDeckDecksmithJobPayload,
  resultValue: ReachDeckDecksmithJobResult,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  const payload = parseReachDeckDecksmithJobPayload(payloadValue);
  const result = parseReachDeckDecksmithJobResult(resultValue, payload);
  if (jsonByteLength(result) > MAX_DURABLE_RESULT_BYTES) {
    throw new Error('Reach Deck Decksmith durable result exceeds the recovery size limit');
  }
  return transitionReachDeckWorkspaceRecovery(scopeFromDecksmithPayload(payload), (current) => {
    const expected = decksmithDescriptorFromPayload(payload);
    const existingDescriptor = current.decksmithJobs[payload.jobId];
    if (existingDescriptor === undefined) {
      throw new Error('Reach Deck Decksmith job must be registered before storing its result');
    }
    assertSameDecksmithDescriptor(existingDescriptor, expected);
    const descriptor = existingDescriptor;
    const resultRef = decksmithResultReference(payload.jobId);
    const existingResult = current.decksmithResults[resultRef];
    if (existingResult !== undefined) {
      if (!valuesEqual(existingResult.result, result)) {
        throw new Error('Reach Deck Decksmith durable result collides with different provenance');
      }
      if (descriptor.resultRef === resultRef) return current;
    }
    return {
      ...current,
      decksmithJobs: {
        ...current.decksmithJobs,
        [payload.jobId]: { ...descriptor, resultRef },
      },
      decksmithResults: {
        ...current.decksmithResults,
        [resultRef]: existingResult ?? {
          jobId: payload.jobId,
          requestHash: payload.requestHash,
          baseDocumentHash: payload.baseDocumentHash,
          resultHash: result.resultHash,
          storedAt: new Date().toISOString(),
          result,
        },
      },
    };
  });
}

export async function readReachDeckWorkspaceDecksmithJobDescriptor(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckWorkspaceRecoveryDecksmithJob | null> {
  const resource = await loadReachDeckWorkspaceRecovery(scope);
  const descriptor = resource.recovery.decksmithJobs[jobId];
  return descriptor !== undefined && sameDecksmithScope(descriptor, scope) ? descriptor : null;
}

export async function readReachDeckWorkspaceDecksmithResult(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckDecksmithJobResult | null> {
  const resource = await loadReachDeckWorkspaceRecovery(scope);
  const descriptor = resource.recovery.decksmithJobs[jobId];
  if (
    descriptor === undefined ||
    descriptor.resultRef === undefined ||
    !sameDecksmithScope(descriptor, scope)
  ) {
    return null;
  }
  const stored = resource.recovery.decksmithResults[descriptor.resultRef];
  const resolution =
    stored === undefined ? null : await resolveDecksmithPublicResult(descriptor, stored);
  return resolution?.result ?? null;
}

type DecksmithResultLifecycle =
  | 'completed'
  | 'awaiting-approval'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'apply-failed'
  | 'rejected';

interface DecksmithResultResolution {
  readonly result: ReachDeckDecksmithJobResult | null;
  readonly lifecycle: DecksmithResultLifecycle;
}

async function resolveDecksmithPublicResult(
  descriptor: ReachDeckWorkspaceRecoveryDecksmithJob,
  stored: ReachDeckWorkspaceRecoveryDecksmithResult,
): Promise<DecksmithResultResolution | null> {
  const result = stored.result;
  if (descriptor.runtimeRunId === undefined || !result.changed) {
    return { result, lifecycle: 'completed' };
  }
  if (result.runtimeRunId !== descriptor.runtimeRunId || result.document === undefined) return null;

  if ((result.runtimeArtifactId === undefined) !== (result.runtimeApprovalId === undefined)) {
    return null;
  }
  const proposal = await getRuntimeStore().findDecksmithArtifactApproval({
    runId: descriptor.runtimeRunId,
    actor: {
      subject: descriptor.actorId,
      orgId: actorOrganizationIdFromPayload(descriptor),
      roles: [],
      ...(descriptor.billingGroupId === null ? {} : { billingGroupId: descriptor.billingGroupId }),
    },
    resourceScope: descriptor.resourceScope,
    artifactType: 'deck-change-set',
    contentSha256: buildDecksmithDocumentHash(result.document),
  });
  if (proposal === null) return null;
  const lifecycle = decksmithResultLifecycle(proposal.approval);
  const hasStoredRefs = result.runtimeArtifactId !== undefined;
  if (!hasStoredRefs && lifecycle !== 'awaiting-approval') return null;
  const refs = {
    runtimeArtifactId: proposal.artifact.id,
    runtimeApprovalId: proposal.approval.id,
  };
  if (
    hasStoredRefs &&
    (result.runtimeArtifactId !== refs.runtimeArtifactId ||
      result.runtimeApprovalId !== refs.runtimeApprovalId)
  ) {
    return null;
  }
  if (lifecycle === 'rejected') return { result: null, lifecycle };
  if (
    result.runtimeArtifactId === refs.runtimeArtifactId &&
    result.runtimeApprovalId === refs.runtimeApprovalId
  ) {
    return { result, lifecycle };
  }
  const { resultHash: _resultHash, ...content } = result;
  const enrichedContent = { ...content, ...refs };
  return {
    result: parseReachDeckDecksmithJobResult({
      ...enrichedContent,
      resultHash: buildDecksmithResultHash(enrichedContent),
    }),
    lifecycle,
  };
}

function decksmithResultLifecycle(
  approval: ApprovalRecord,
): Exclude<DecksmithResultLifecycle, 'completed'> {
  if (approval.decision === 'pending') return 'awaiting-approval';
  if (approval.decision === 'rejected') return 'rejected';
  if (approval.applyStatus === 'applying') return 'applying';
  if (approval.applyStatus === 'applied') return 'applied';
  if (approval.applyStatus === 'failed') return 'apply-failed';
  return 'approved';
}

export async function enrichReachDeckWorkspaceDecksmithResultRuntimeRefs(
  payloadValue: ReachDeckDecksmithJobPayload,
  resultValue: ReachDeckDecksmithJobResult,
  refs: { runtimeArtifactId: string; runtimeApprovalId: string },
): Promise<ReachDeckDecksmithJobResult> {
  const payload = parseReachDeckDecksmithJobPayload(payloadValue);
  const base = parseReachDeckDecksmithJobResult(resultValue, payload);
  if (base.runtimeArtifactId !== undefined || base.runtimeApprovalId !== undefined) {
    if (
      base.runtimeArtifactId === refs.runtimeArtifactId &&
      base.runtimeApprovalId === refs.runtimeApprovalId
    ) {
      return base;
    }
    throw new Error('Reach Deck Decksmith Runtime references collide');
  }
  const { resultHash: _baseHash, ...baseContent } = base;
  const enrichedContent = { ...baseContent, ...refs };
  const enriched = parseReachDeckDecksmithJobResult(
    { ...enrichedContent, resultHash: buildDecksmithResultHash(enrichedContent) },
    payload,
  );
  await transitionReachDeckWorkspaceRecovery(scopeFromDecksmithPayload(payload), (current) => {
    const descriptor = current.decksmithJobs[payload.jobId];
    const resultRef = descriptor?.resultRef;
    if (descriptor === undefined || resultRef === undefined) {
      throw new Error('Reach Deck Decksmith durable result is unavailable for enrichment');
    }
    assertSameDecksmithDescriptor(descriptor, decksmithDescriptorFromPayload(payload));
    const stored = current.decksmithResults[resultRef];
    if (stored === undefined) throw new Error('Reach Deck Decksmith durable result is missing');
    const storedResult = parseReachDeckDecksmithJobResult(stored.result, payload);
    if (valuesEqual(storedResult, enriched)) return current;
    if (!valuesEqual(storedResult, base)) {
      throw new Error('Reach Deck Decksmith durable result changed before Runtime enrichment');
    }
    return {
      ...current,
      decksmithResults: {
        ...current.decksmithResults,
        [resultRef]: {
          ...stored,
          resultHash: enriched.resultHash,
          result: enriched,
        },
      },
    };
  });
  return enriched;
}

/**
 * Decksmith 运行期全文档短锁:注册过、无落库结果且队列侧未终态的任务视为活跃。
 * 队列查不到任务时视为不活跃；读取失败则 fail closed，避免依赖故障期间放行
 * 与可能仍在执行的全文档改写冲突。
 *
 * 复杂度为 O(未落库结果的描述符数) 次队列读取:失败/取消的任务永远不会写
 * resultRef,只能等队列条目过期后不再判活。按 queuedAt 从新到旧扫描,常见
 * 情形(唯一在途任务就是最新注册)读一次即命中返回。若无结果描述符随时间
 * 累积导致读取放大,后续可为描述符补终态标记或做定期清理。
 */
export async function hasActiveReachDeckDecksmithJob(
  scope: ReachDeckGenerationJobScope,
): Promise<boolean> {
  if (
    await getRuntimeStore().hasActiveDecksmithDeckLease({
      actor: {
        subject: scope.actorId,
        orgId: actorOrganizationIdFromPayload(scope),
        roles: ['teacher'],
        ...(scope.billingGroupId === null ? {} : { billingGroupId: scope.billingGroupId }),
      },
      resourceScope: scope.resourceScope,
    })
  ) {
    return true;
  }
  const resource = await loadReachDeckWorkspaceRecovery(scope);
  const unresolved = Object.values(resource.recovery.decksmithJobs)
    .filter((job) => job.resultRef === undefined && sameDecksmithScope(job, scope))
    .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  for (const job of unresolved) {
    let queued: ReachDeckGenerationJobView | null = null;
    try {
      queued = await readReachDeckGenerationJob(job.jobId, scope);
    } catch (error) {
      console.error('Reach Deck Decksmith active-lock queue read failed', {
        jobId: job.jobId,
        error,
      });
      throw error;
    }
    if (queued !== null && !queued.done) return true;
  }
  return false;
}

export async function reconcileReachDeckOrphanedDecksmithLease(
  context: ReachDeckWorkspaceContext,
): Promise<{ readonly released: boolean; readonly jobId?: string }> {
  if ((await queuedDecksmithLeaseOwners(context)).length === 0) return { released: false };
  const resource = await loadReachDeckWorkspaceRecovery(context);
  return reconcileLoadedDecksmithLease(context, resource);
}

/**
 * Decksmith turns on different pages hold separate leases, so any of them may be a queued turn
 * whose enqueue never became visible.
 */
async function queuedDecksmithLeaseOwners(context: ReachDeckWorkspaceContext): Promise<string[]> {
  const store = getRuntimeStore();
  const scope = parseReachDeckResourceScope(context.resourceScope);
  const entries = await store.listDecksmithDeckLeaseEntries({
    actor: {
      subject: context.actorId,
      orgId: scope.organizationId,
      roles: ['teacher'],
      ...(context.billingGroupId === null ? {} : { billingGroupId: context.billingGroupId }),
    },
    resourceScope: scope,
    pageId: '__document__',
  });
  const owners: string[] = [];
  for (const { lease } of entries) {
    if (lease.asyncRunId !== undefined) continue;
    const run = await store.getRun(lease.ownerRunId);
    if (run?.status === 'queued' && run.startedAt === undefined) owners.push(lease.ownerRunId);
  }
  return owners;
}

async function reconcileLoadedDecksmithLease(
  context: ReachDeckWorkspaceContext,
  resource: ReachDeckWorkspaceRecoveryResource,
  getQueue?: () => Promise<ReachDeckGenerationQueue>,
): Promise<{ readonly released: boolean; readonly jobId?: string }> {
  let released = false;
  let jobId: string | undefined;
  for (const ownerRunId of await queuedDecksmithLeaseOwners(context)) {
    const reconciled = await reconcileQueuedDecksmithLease(context, resource, ownerRunId, getQueue);
    released ||= reconciled.released;
    jobId ??= reconciled.jobId;
  }
  return { released, ...(jobId === undefined ? {} : { jobId }) };
}

async function reconcileQueuedDecksmithLease(
  context: ReachDeckWorkspaceContext,
  resource: ReachDeckWorkspaceRecoveryResource,
  ownerRunId: string,
  getQueue?: () => Promise<ReachDeckGenerationQueue>,
): Promise<{ readonly released: boolean; readonly jobId?: string }> {
  const store = getRuntimeStore();
  const scope = parseReachDeckResourceScope(context.resourceScope);
  const descriptor = Object.values(resource.recovery.decksmithJobs).find(
    (candidate) =>
      candidate.runtimeRunId === ownerRunId &&
      candidate.resultRef === undefined &&
      sameReachDeckResourceScope(candidate.resourceScope, scope),
  );
  if (descriptor === undefined) return { released: false };
  const staleBefore = new Date(Date.now() - DECKSMITH_ENQUEUE_VISIBILITY_GRACE_MS);
  if (Date.parse(descriptor.queuedAt) > staleBefore.getTime()) {
    return { released: false, jobId: descriptor.jobId };
  }
  const descriptorScope = {
    actorId: descriptor.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(descriptor),
    billingGroupId: descriptor.billingGroupId,
    roleGrantId: descriptor.roleGrantId,
    resourceScope: descriptor.resourceScope,
  };
  const queued =
    getQueue === undefined
      ? await readReachDeckGenerationJob(descriptor.jobId, descriptorScope)
      : await (await getQueue()).read(descriptor.jobId, descriptorScope);
  if (queued !== null) return { released: false, jobId: descriptor.jobId };
  const released = await store.expireQueuedDecksmithRunLease(
    ownerRunId,
    DECKSMITH_ENQUEUE_VISIBILITY_GRACE_MS,
  );
  if (released) {
    await store
      .appendEvent(ownerRunId, 'run.failed', {
        code: 'RUN_QUEUE_UNAVAILABLE',
        source: 'reach-deck-enqueue-reconciliation',
      })
      .catch((error) =>
        console.error('Decksmith orphaned enqueue failure event append failed', error),
      );
  }
  return { released, jobId: descriptor.jobId };
}

/**
 * Deployment-window guard for already-registered full-payload jobs. New v2 work has a durable
 * Runtime run reference and is serialized by the resource-wide lease itself; legacy work does not,
 * so callers must also keep it from entering the lease race before its worker can claim the lease.
 */
export async function hasActiveLegacyReachDeckDecksmithJob(
  scope: ReachDeckGenerationJobScope,
): Promise<boolean> {
  const resource = await loadReachDeckWorkspaceRecovery(scope);
  const unresolved = Object.values(resource.recovery.decksmithJobs)
    .filter(
      (job) =>
        job.runtimeRunId === undefined &&
        job.resultRef === undefined &&
        sameReachDeckResourceScope(job.resourceScope, scope.resourceScope),
    )
    .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  for (const job of unresolved) {
    const queued = await readReachDeckGenerationJob(job.jobId, {
      actorId: job.actorId,
      actorOrganizationId: actorOrganizationIdFromPayload(job),
      billingGroupId: job.billingGroupId,
      roleGrantId: job.roleGrantId,
      resourceScope: job.resourceScope,
    });
    if (queued !== null && !queued.done) return true;
  }
  return false;
}

export async function readReachDeckWorkspaceRecoveryDecksmithJob(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobView | null> {
  return projectReachDeckWorkspaceRecoveryDecksmithJob(
    await loadReachDeckWorkspaceRecovery(scope),
    jobId,
    scope,
  );
}

async function projectReachDeckWorkspaceRecoveryDecksmithJob(
  resource: ReachDeckWorkspaceRecoveryResource,
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobView | null> {
  const recovered = await scopedDecksmithRecoveryJobWithAudit(resource, jobId, scope);
  if (recovered === null) return null;
  const { audit, descriptor, result } = recovered;
  const resolution =
    result === undefined ? null : await resolveDecksmithPublicResult(descriptor, result);
  if (resolution !== null) {
    if (resolution.lifecycle === 'rejected') {
      return {
        jobId,
        kind: 'decksmith',
        status: 'rejected',
        progress: 100,
        resultAvailable: false,
        error: 'Generation proposal rejected',
        done: true,
      };
    }
    return {
      jobId,
      kind: 'decksmith',
      status: resolution.lifecycle,
      progress: 100,
      resultAvailable: true,
      done: true,
    };
  }
  if (audit?.status === 'aborted') {
    return {
      jobId,
      kind: 'decksmith',
      status: 'cancelled',
      progress: 0,
      error: 'Generation cancelled',
      done: true,
    };
  }
  if (audit?.status === 'failed') {
    return {
      jobId,
      kind: 'decksmith',
      status: 'failed',
      progress: 0,
      error: 'Generation failed',
      done: true,
    };
  }
  if (descriptor.runtimeRunId !== undefined) {
    const runtimeRun = await getRuntimeStore().getRun(descriptor.runtimeRunId);
    if (runtimeRun?.status === 'failed' && runtimeRun.error?.code === 'RUN_QUEUE_UNAVAILABLE') {
      return {
        jobId,
        kind: 'decksmith',
        status: 'failed',
        progress: 0,
        error: 'Generation queue insertion expired',
        done: true,
      };
    }
  }
  if (audit?.status === 'succeeded') {
    return {
      jobId,
      kind: 'decksmith',
      status: 'recovery-required',
      progress: 100,
      error: 'Generation completed but its durable result is unavailable',
      done: true,
    };
  }
  if (audit === undefined) {
    return {
      jobId,
      kind: 'decksmith',
      status: 'registered',
      progress: 0,
      done: false,
    };
  }
  return {
    jobId,
    kind: descriptor.kind,
    status: audit.status,
    progress: 0,
    error: 'Queue state is unavailable; server reconciliation is pending',
    done: false,
  };
}
export async function storeReachDeckWorkspaceJobResult(
  payload: ReachDeckStagedGenerationJobPayload,
  resultValue: ReachDeckStagedGenerationResult,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  const parsedResult = parseCompletedStagedResult(
    resultValue,
    stagedResultProvenanceFromPayload(payload),
  );
  if (jsonByteLength(parsedResult) > MAX_DURABLE_RESULT_BYTES) {
    throw new Error('Reach Deck durable result exceeds the recovery size limit');
  }
  const resultHash = buildStagedGenerationRequestHash(parsedResult);
  return transitionReachDeckWorkspaceRecovery(scopeFromPayload(payload), (current) => {
    const expected = descriptorFromPayload(payload);
    const existingDescriptor = current.jobs[payload.jobId];
    if (existingDescriptor !== undefined) {
      assertSameDescriptor(existingDescriptor, expected);
    }
    const descriptor = existingDescriptor ?? expected;
    const artifactRef = artifactReference(payload.jobId);
    const existingResult = current.results[artifactRef];
    if (existingResult !== undefined) {
      if (
        existingResult.jobId !== payload.jobId ||
        existingResult.requestHash !== payload.requestHash ||
        existingResult.resultHash !== resultHash ||
        buildStagedGenerationRequestHash(existingResult.result) !== resultHash
      ) {
        throw new Error('Reach Deck durable result collides with different provenance');
      }
      if (descriptor.artifactRef === artifactRef) return current;
    }
    const storedAt = new Date().toISOString();
    return {
      ...current,
      jobs: {
        ...current.jobs,
        [payload.jobId]: { ...descriptor, artifactRef },
      },
      results: {
        ...current.results,
        [artifactRef]:
          existingResult ??
          ({
            jobId: payload.jobId,
            requestHash: payload.requestHash,
            resultHash,
            storedAt,
            result: parsedResult,
          } satisfies ReachDeckWorkspaceRecoveryResult),
      },
    };
  });
}

/**
 * Worker crash recovery reader. Unlike the public result API this does not wait
 * for the generation audit to reach succeeded: the durable result itself is the
 * checkpoint that prevents replaying completed model or media work.
 */
export async function readReachDeckWorkspaceStoredJobResult(
  payload: ReachDeckStagedGenerationJobPayload,
): Promise<ReachDeckStagedGenerationResult | null> {
  const resource = await loadReachDeckWorkspaceRecovery(scopeFromPayload(payload));
  const descriptor = resource.recovery.jobs[payload.jobId];
  if (descriptor === undefined) return null;
  assertSameDescriptor(descriptor, descriptorFromPayload(payload));
  if (descriptor.artifactRef === undefined) return null;
  const stored = resource.recovery.results[descriptor.artifactRef];
  if (
    stored === undefined ||
    stored.jobId !== payload.jobId ||
    stored.requestHash !== payload.requestHash ||
    stored.resultHash !== buildStagedGenerationRequestHash(stored.result)
  ) {
    throw new Error('Reach Deck durable result provenance is invalid');
  }
  return parseCompletedStagedResult(stored.result, stagedResultProvenanceFromPayload(payload));
}

export async function markReachDeckWorkspaceJobApplied(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
  appliedAt: string,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  requireTimestamp(appliedAt, 'appliedAt');
  return transitionReachDeckWorkspaceRecovery(scope, (current) => {
    const descriptor = current.jobs[jobId];
    if (descriptor === undefined || !sameScope(descriptor, scope)) {
      throw new Error('Reach Deck recovery job not found in the exact scope');
    }
    if (descriptor.artifactRef === undefined) {
      throw new Error('Reach Deck recovery job cannot be applied without a durable result');
    }
    if (descriptor.appliedAt !== undefined) return current;
    return {
      ...current,
      jobs: {
        ...current.jobs,
        [jobId]: { ...descriptor, appliedAt },
      },
    };
  });
}

/**
 * 移除一条队列从未接收的登记（没有结果、未应用）。用于载荷校验确定性失败的批次成员：
 * 成员保留 jobId 作为终态记录，登记本身不再代表任何在途任务。已有结果或已应用的登记保持不变。
 */
export async function forgetUnqueuedReachDeckWorkspaceJob(
  context: ReachDeckWorkspaceContext,
  jobId: string,
): Promise<boolean> {
  let forgotten = false;
  await transitionReachDeckWorkspaceRecovery(context, (current) => {
    forgotten = false;
    const descriptor = current.jobs[jobId];
    if (
      descriptor === undefined ||
      descriptor.artifactRef !== undefined ||
      descriptor.appliedAt !== undefined
    ) {
      return current;
    }
    const jobs = { ...current.jobs };
    const ttsContinuations = { ...current.ttsContinuations };
    delete jobs[jobId];
    delete ttsContinuations[jobId];
    forgotten = true;
    return { ...current, jobs, ttsContinuations };
  });
  return forgotten;
}

/**
 * 讲稿保留、音频终态失败的结果落地后，把所在批次的成员原因记为 audio-generation-failed。
 *
 * 数据源：content-service 创作工作区的 recovery 文档（batches）。物化通道与首轮工作区通道共用：
 * 批次终态统计据此计入 audioFailed，教师端据此提示「音频生成失败」。不属于任何批次时不写入。
 */
export async function markReachDeckWorkspaceBatchMemberAudioFailed(
  context: ReachDeckWorkspaceContext,
  payload: { readonly jobId: string; readonly runId: string },
  pageId: string,
): Promise<void> {
  await transitionReachDeckWorkspaceBatches(context, (batches) => {
    let anyChanged = false;
    const next = Object.fromEntries(
      Object.entries(batches).map(([batchId, batch]) => {
        if (batch.runId !== payload.runId || batch.phase === 'terminal') {
          return [batchId, batch];
        }
        let batchChanged = false;
        const members = batch.members.map((member) => {
          if (member.jobId !== payload.jobId || member.pageId !== pageId) return member;
          batchChanged = true;
          return { ...member, reason: 'audio-generation-failed' };
        });
        anyChanged ||= batchChanged;
        return [
          batchId,
          batchChanged ? { ...batch, revision: batch.revision + 1, members } : batch,
        ];
      }),
    );
    return anyChanged ? next : batches;
  });
}

/** Records a handled but deliberately discarded narration result against its durable batch. */
export async function markReachDeckWorkspaceBatchMemberResultDiscarded(
  payload: ReachDeckNarrationGenerationJobPayload | ReachDeckPageGenerationJobPayload,
  reason: string,
  appliedAt: string,
): Promise<boolean> {
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0 || normalizedReason.length > 128) {
    throw new Error('Reach Deck discarded batch member reason is invalid');
  }
  requireTimestamp(appliedAt, 'appliedAt');
  const scope = scopeFromPayload(payload);
  const saved = await transitionReachDeckWorkspaceRecovery(scope, (current) => {
    const descriptor = current.jobs[payload.jobId];
    if (descriptor === undefined || !sameScope(descriptor, scope)) {
      throw new Error('Reach Deck recovery job not found in the exact scope');
    }
    if (descriptor.artifactRef === undefined) {
      throw new Error('Reach Deck recovery job cannot be applied without a durable result');
    }
    const jobMatches = Object.values(current.batches).filter(
      (batch) =>
        batch.runId === payload.runId &&
        sameReachDeckWorkspaceBatchOwner(batch, payload) &&
        batch.members.some((member) => member.jobId === payload.jobId),
    );
    if (jobMatches.length === 0) {
      if (descriptor.appliedAt !== undefined) return current;
      return {
        ...current,
        jobs: { ...current.jobs, [payload.jobId]: { ...descriptor, appliedAt } },
      };
    }
    const matches = jobMatches.filter((batch) =>
      batch.members.some(
        (member) =>
          member.jobId === payload.jobId &&
          member.pageId === payload.request.pageId &&
          member.requestedRevision === payload.request.requestedRevision &&
          member.attempt === payload.request.attempt,
      ),
    );
    if (matches.length === 0) {
      throw new Error('Reach Deck discarded result does not match its workspace batch member');
    }
    if (matches.length !== 1) {
      throw new Error('Reach Deck discarded result belongs to multiple workspace batches');
    }
    const batch = matches[0]!;
    const member = batch.members.find((candidate) => candidate.jobId === payload.jobId)!;
    const alreadySettled =
      member.terminalOutcome === 'failed' && member.reason === normalizedReason;
    if (!alreadySettled && (batch.phase === 'terminal' || member.terminalOutcome !== undefined)) {
      throw new Error('Reach Deck discarded result conflicts with a terminal batch member');
    }
    return {
      ...current,
      schemaVersion: REACH_DECK_WORKSPACE_RECOVERY_V5_SCHEMA_VERSION,
      jobs: {
        ...current.jobs,
        [payload.jobId]:
          descriptor.appliedAt === undefined ? { ...descriptor, appliedAt } : descriptor,
      },
      batches: {
        ...current.batches,
        [batch.batchId]:
          alreadySettled && member.regeneration?.payload === undefined
            ? batch
            : {
                ...batch,
                revision: batch.revision + 1,
                members: batch.members.map((candidate) => {
                  if (candidate.jobId !== payload.jobId) return candidate;
                  let regeneration = candidate.regeneration;
                  if (regeneration !== undefined) {
                    const { payload: _payload, ...checkpoint } = regeneration;
                    regeneration = checkpoint;
                  }
                  return {
                    ...candidate,
                    reason: normalizedReason,
                    terminalOutcome: 'failed' as const,
                    ...(regeneration === undefined ? {} : { regeneration }),
                  };
                }),
              },
      },
    };
  });
  return Object.values(saved.recovery.batches).some(
    (batch) =>
      batch.runId === payload.runId &&
      sameReachDeckWorkspaceBatchOwner(batch, payload) &&
      batch.members.some(
        (member) =>
          member.jobId === payload.jobId &&
          member.terminalOutcome === 'failed' &&
          member.reason === normalizedReason,
      ),
  );
}

/**
 * Removes a durable result whose landing was fenced by batch cancellation. The batch member keeps
 * its jobId as a cancellation tombstone, while the descriptor, result body and TTS continuation are
 * removed in one recovery CAS so retained writer ownership can eventually settle.
 */
export async function discardReachDeckWorkspaceBatchJobResult(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  batchId: string,
  jobId: string,
  terminalOutcome: 'failed' | 'cancelled',
  reason: string,
): Promise<boolean> {
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0 || normalizedReason.length > 128) {
    throw new Error('Reach Deck discarded batch member reason is invalid');
  }
  let discarded = false;
  await transitionReachDeckWorkspaceRecovery(context, (current) => {
    discarded = false;
    const batch = current.batches[batchId];
    if (batch === undefined) throw new Error('Reach Deck workspace batch not found');
    if (!sameReachDeckWorkspaceBatchOwner(batch, scope)) {
      throw new Error('Reach Deck workspace batch scope does not match');
    }
    if (batch.cancelRequested === undefined) {
      throw new Error('Reach Deck batch cancellation fence is missing');
    }
    const member = batch.members.find((candidate) => candidate.jobId === jobId);
    if (member === undefined) {
      throw new Error('Reach Deck cancelled result is not a member of the workspace batch');
    }
    if (
      member.terminalOutcome !== undefined &&
      (member.terminalOutcome !== terminalOutcome || member.reason !== normalizedReason)
    ) {
      throw new Error('Reach Deck discarded result conflicts with a terminal batch member');
    }
    const descriptor = current.jobs[jobId];
    if (descriptor === undefined) {
      discarded = member.terminalOutcome === terminalOutcome && member.reason === normalizedReason;
      return current;
    }
    if (descriptor.appliedAt !== undefined) return current;
    if (!sameScope(descriptor, scope)) {
      throw new Error('Reach Deck cancelled result scope does not match its descriptor');
    }
    if (descriptor.artifactRef === undefined) return current;
    const jobs = { ...current.jobs };
    const results = { ...current.results };
    const ttsContinuations = { ...current.ttsContinuations };
    delete jobs[jobId];
    delete results[descriptor.artifactRef];
    delete ttsContinuations[jobId];
    discarded = true;
    return {
      ...current,
      jobs,
      results,
      ttsContinuations,
      batches: {
        ...current.batches,
        [batchId]: {
          ...batch,
          revision: batch.revision + 1,
          members: batch.members.map((candidate) =>
            candidate.jobId === jobId
              ? {
                  ...candidate,
                  ...(terminalOutcome === 'cancelled' ? { intent: 'cancelled' as const } : {}),
                  reason: normalizedReason,
                  terminalOutcome,
                }
              : candidate,
          ),
        },
      },
    };
  });
  return discarded;
}

/** 删除页面后从批次里移除的成员记入 skipped 时使用的原因码。 */
export const REACH_DECK_DELETED_PAGE_SKIP_REASON = 'page-deleted';

/**
 * 删除页面时只回收这些页的生成工作，其他页的成员、任务与批次照常推进。
 *
 * 数据源：Mongo reach_deck_authoring_workspaces 的 recovery 文档（CAS 写回）。
 * 核心逻辑：
 * 1. 本轮未终结（preparing/ready）的批次里，被删页上尚未终结的成员移出 members，记入 skipped；
 *    剩余成员按下标重排 order，dispatchCursor 回拨为已派发且仍保留的成员数，协调器据此继续派发；
 * 2. 未终结成员全在被删页上的批次直接终结，这些成员记为取消（批次至少保留一个成员）；
 * 3. 删除调用方已在队列、审计与 Runtime 侧取消的任务的描述符、结果与 TTS 续接，并同步裁剪媒体检查点；
 * 4. 同一次 CAS 把仍在生成的被删页记入 deletedPageRetirements：文档写入后工作区同步若失败，
 *    之后的结构同步仍能据此退役这些页（见 synchronizeReachDeckWorkspaceDocumentStructure）。
 * 已终结的成员保留原有结局；被删页已落地的任务不在 `cancelledJobIds` 里，照常由内容保存后的清理回收。
 * 调用方持有文档写锁；返回仍需重新调度协调器的批次。
 */
export async function retireReachDeckWorkspaceDeletedPageWork(
  context: ReachDeckWorkspaceContext,
  runId: string,
  deletedPageIds: readonly string[],
  cancelledJobIds: readonly string[],
  deletedInFlightPageIds: readonly string[] = [],
): Promise<{
  resource: ReachDeckWorkspaceRecoveryResource;
  rescheduledBatches: ReachDeckWorkspaceBatch[];
}> {
  const deleted = new Set(deletedPageIds);
  const cancelled = new Set(cancelledJobIds);
  const retiredAt = new Date().toISOString();
  let rescheduledBatches: ReachDeckWorkspaceBatch[] = [];
  const resource = await transitionReachDeckWorkspaceRecovery(context, (current) => {
    rescheduledBatches = [];
    const batches = Object.fromEntries(
      Object.entries(current.batches).map(([batchId, batch]): [string, ReachDeckWorkspaceBatch] => {
        if (batch.runId !== runId || (batch.phase !== 'preparing' && batch.phase !== 'ready')) {
          return [batchId, batch];
        }
        const removed = batch.members.filter(
          (member) => deleted.has(member.pageId) && member.terminalOutcome === undefined,
        );
        if (removed.length === 0) return [batchId, batch];
        const kept = batch.members.filter((member) => !removed.includes(member));
        if (kept.length === 0) {
          // 批次至少保留一个成员：成员全在被删页上时原样保留并记为取消，批次直接终结。
          const members = batch.members.map((member) => ({
            ...member,
            intent: 'cancelled' as const,
            reason: REACH_DECK_DELETED_PAGE_SKIP_REASON,
            terminalOutcome: 'cancelled' as const,
          }));
          return [
            batchId,
            {
              ...batch,
              phase: 'terminal',
              stopReason: REACH_DECK_DELETED_PAGE_SKIP_REASON,
              revision: batch.revision + 1,
              members,
              terminalSummary: {
                completedAt: retiredAt,
                status: 'cancelled',
                total: members.length + batch.skipped.length,
                succeeded: 0,
                failed: 0,
                blocked: 0,
                cancelled: members.length,
                skipped: batch.skipped.length,
              },
            },
          ];
        }
        const members = kept.map((member, index) => ({ ...member, order: index }));
        const dispatchCursor = kept.filter((member) => member.order < batch.dispatchCursor).length;
        const skipped = [
          ...batch.skipped,
          ...removed.map((member) => ({
            pageId: member.pageId,
            order: member.order,
            reason: REACH_DECK_DELETED_PAGE_SKIP_REASON,
          })),
        ];
        const next = { ...batch, revision: batch.revision + 1, dispatchCursor, members, skipped };
        rescheduledBatches.push(next);
        return [batchId, next];
      }),
    );
    const retainedBatches = retainRecentReachDeckWorkspaceBatches(batches);
    const jobs = Object.fromEntries(
      Object.entries(current.jobs).filter(([jobId]) => !cancelled.has(jobId)),
    );
    return {
      ...current,
      jobs,
      results: Object.fromEntries(
        Object.entries(current.results).filter(([, result]) => !cancelled.has(result.jobId)),
      ),
      ttsContinuations: Object.fromEntries(
        Object.entries(current.ttsContinuations).filter(([jobId]) => !cancelled.has(jobId)),
      ),
      batches: retainedBatches,
      mediaCheckpoints: pruneReachDeckMediaCheckpoints(current.mediaCheckpoints, {
        jobs,
        batches: retainedBatches,
        structuralJobTombstones: current.structuralJobTombstones,
      }),
      ...(deletedInFlightPageIds.length === 0
        ? {}
        : {
            deletedPageRetirements: recordReachDeckDeletedPageRetirement(
              current.deletedPageRetirements ?? {},
              runId,
              deletedInFlightPageIds,
              retiredAt,
            ),
          }),
    };
  });
  return { resource, rescheduledBatches };
}

/** 读写待退役的被删页记录；转换函数必须是同步纯函数。 */
export async function transitionReachDeckDeletedPageRetirements(
  context: ReachDeckWorkspaceContext,
  transition: (retirements: ReachDeckDeletedPageRetirements) => ReachDeckDeletedPageRetirements,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  return transitionReachDeckWorkspaceRecovery(context, (current) => ({
    ...current,
    deletedPageRetirements: parseReachDeckDeletedPageRetirements(
      transition(structuredClone(current.deletedPageRetirements ?? {})),
    ),
  }));
}

/**
 * 只改页面内容（页面集合与顺序不变）的保存后回收恢复数据：只删已落地的独立页面/讲稿任务。
 *
 * 数据源：Mongo `reach_deck_authoring_workspaces.recovery`（jobs / results / ttsContinuations /
 * mediaCheckpoints）。
 * 核心逻辑：
 * 1. 同 run 尚有结构变更清理意图时不动，交给结构清理流程；
 * 2. 只选 `appliedAt` 已写入、未被任何批次成员或结构墓碑引用、且没有活动 TTS 票据的任务；
 * 3. 一次 CAS 删除这些任务的描述符、结果与 continuation，并按剩余任务回收素材检查点，
 *    在途任务与批次原样保留。
 * 设计动机：结构清理会停掉批次并直接删除在途独立任务的描述符，worker 随后写 continuation 时
 * 报 provenance invalid 并空转重试；内容保存与页面保存一样不该打断生成，落地由页面 CAS 与
 * 过时判定兜底。
 */
export async function pruneReachDeckWorkspaceAppliedPageJobs(
  context: ReachDeckWorkspaceContext,
  runId: string,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  return transitionReachDeckWorkspaceRecovery(context, (current) => {
    if (current.structuralMutations[runId] !== undefined) return current;
    const referencedJobIds = new Set([
      ...Object.values(current.batches).flatMap((batch) =>
        batch.members.flatMap((member) => (member.jobId === undefined ? [] : [member.jobId])),
      ),
      ...Object.keys(current.structuralJobTombstones),
    ]);
    const removable = new Set(
      Object.values(current.jobs)
        .filter((job) => {
          if (
            job.runId !== runId ||
            (job.kind !== 'page-generation' && job.kind !== 'narration-generation') ||
            job.appliedAt === undefined ||
            referencedJobIds.has(job.jobId)
          ) {
            return false;
          }
          const continuation = current.ttsContinuations[job.jobId];
          return (
            continuation === undefined ||
            (continuation.queue === undefined &&
              !reachDeckTtsContinuationHasActiveTicket(continuation))
          );
        })
        .map((job) => job.jobId),
    );
    if (removable.size === 0) return current;
    const jobs = Object.fromEntries(
      Object.entries(current.jobs).filter(([jobId]) => !removable.has(jobId)),
    );
    return {
      ...current,
      jobs,
      results: Object.fromEntries(
        Object.entries(current.results).filter(([, result]) => !removable.has(result.jobId)),
      ),
      ttsContinuations: Object.fromEntries(
        Object.entries(current.ttsContinuations).filter(([jobId]) => !removable.has(jobId)),
      ),
      mediaCheckpoints: pruneReachDeckMediaCheckpoints(current.mediaCheckpoints, {
        jobs,
        batches: current.batches,
        structuralJobTombstones: current.structuralJobTombstones,
      }),
    };
  });
}

/**
 * Structural cleanup for batch-member narration is intentionally three-phase. The first recovery
 * CAS installs exact worker tombstones and preserves every descriptor/continuation needed for
 * takeover. External audit, Queue, Runtime and TTS state then converges. The final recovery CAS
 * removes only identities that still exactly match the settled snapshot, so a process exit or
 * concurrent replacement cannot strand work or erase a newer fence. Standalone page and narration
 * recovery data is removed directly; active standalone TTS identities are cancelled best-effort.
 */
export async function pruneReachDeckWorkspacePageJobs(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  dependencies: ReachDeckStructuralJobCleanupDependencies = {},
): Promise<ReachDeckWorkspaceRecoveryResource> {
  const directLiveContinuations = new Map<
    string,
    {
      continuation: ReachDeckWorkspaceTtsContinuation;
      scope: ReachDeckGenerationJobScope;
    }
  >();
  const prunedAt = new Date().toISOString();
  let cleanupSummary: { preservedJobIds: string[]; cancelledJobIds: string[] } | undefined;
  let structuralLeaseRelease = false;
  await transitionReachDeckWorkspaceRecovery(context, (current) => {
    directLiveContinuations.clear();
    const structuralCleanup =
      current.structuralMutations[runId] !== undefined ||
      Object.values(current.batches).some(
        (batch) =>
          batch.runId === runId &&
          batch.phase === 'stopped' &&
          batch.stopReason === 'structural-mutation',
      );
    structuralLeaseRelease =
      structuralCleanup ||
      Object.values(current.batches).some(
        (batch) =>
          batch.runId === runId &&
          batch.phase === 'terminal' &&
          batch.stopReason === 'pruned' &&
          sameReachDeckWorkspaceBatchOwner(batch, scope),
      );
    const structuralIntent = current.structuralMutations[runId];
    if (
      structuralIntent !== undefined &&
      !sameReachDeckWorkspaceBatchOwner({ owner: structuralIntent.owner }, scope)
    ) {
      throw new Error('Reach Deck structural mutation cleanup scope does not match');
    }
    const preserved = new Set(structuralIntent?.preservedJobIds ?? []);
    const staleJobs = Object.values(current.jobs).filter(
      (job) =>
        job.runId === runId &&
        !preserved.has(job.jobId) &&
        (job.kind === 'page-generation' || job.kind === 'narration-generation'),
    );
    cleanupSummary = {
      preservedJobIds: [...preserved].filter((jobId) => current.jobs[jobId] !== undefined),
      cancelledJobIds: staleJobs.map((job) => job.jobId),
    };
    const staleNarrationJobs = staleJobs.filter((job) => job.kind === 'narration-generation');
    const affectedBatches = Object.values(current.batches).filter(
      (batch) =>
        batch.runId === runId &&
        batch.phase !== 'terminal' &&
        (structuralIntent === undefined || structuralIntent.batchIds.includes(batch.batchId)),
    );
    const existingTombstones = Object.values(current.structuralJobTombstones).filter(
      (tombstone) => tombstone.runId === runId,
    );
    if (
      staleJobs.length === 0 &&
      affectedBatches.length === 0 &&
      structuralIntent === undefined &&
      existingTombstones.length === 0
    ) {
      return current;
    }
    const durableJobIds = new Set(existingTombstones.map((tombstone) => tombstone.jobId));
    // Materialized structure edits cancel replaced standalone jobs with the same durable,
    // exact-identity audit/queue fence as batch members, rather than losing their registration.
    if (structuralIntent?.preservedJobIds !== undefined) {
      for (const job of staleNarrationJobs) if (sameScope(job, scope)) durableJobIds.add(job.jobId);
    }
    const structuralJobTombstones = { ...current.structuralJobTombstones };
    for (const batch of affectedBatches) {
      for (const member of batch.members) {
        if (member.jobId === undefined) continue;
        durableJobIds.add(member.jobId);
        const descriptor = current.jobs[member.jobId];
        const existingTombstone = structuralJobTombstones[member.jobId];
        if (descriptor === undefined) {
          if (existingTombstone !== undefined) {
            assertStructuralJobTombstoneMatchesBatchMember(existingTombstone, batch, member);
          } else if (member.intent === 'dispatched') {
            throw new Error('Reach Deck structural cleanup dispatched job descriptor is missing');
          }
          continue;
        }
        if (descriptor.kind !== 'narration-generation') {
          throw new Error('Reach Deck structural cleanup batch job kind is invalid');
        }
        assertStructuralJobDescriptorMatchesBatchMember(descriptor, batch, member);
      }
    }
    const durableNarrationJobs = staleNarrationJobs.filter((descriptor) =>
      durableJobIds.has(descriptor.jobId),
    );
    for (const descriptor of durableNarrationJobs) {
      const candidate = structuralJobTombstoneFromDescriptor(descriptor, prunedAt);
      const existing = structuralJobTombstones[descriptor.jobId];
      if (existing !== undefined) {
        assertSameStructuralJobTombstone(existing, candidate);
        continue;
      }
      structuralJobTombstones[descriptor.jobId] = candidate;
    }
    assertStructuralJobTombstoneCapacity(structuralJobTombstones);
    const directJobIds = new Set(
      staleJobs
        .filter((descriptor) => !durableJobIds.has(descriptor.jobId))
        .map((descriptor) => descriptor.jobId),
    );
    for (const [jobId, continuation] of Object.entries(current.ttsContinuations)) {
      if (
        directJobIds.has(jobId) &&
        (continuation.queue !== undefined || reachDeckTtsContinuationHasActiveTicket(continuation))
      ) {
        const descriptor = current.jobs[jobId]!;
        directLiveContinuations.set(jobId, {
          continuation,
          scope: {
            actorId: descriptor.actorId,
            actorOrganizationId: actorOrganizationIdFromPayload(descriptor),
            billingGroupId: descriptor.billingGroupId,
            roleGrantId: descriptor.roleGrantId,
            resourceScope: descriptor.resourceScope,
          },
        });
      }
    }
    const batches = retainRecentReachDeckWorkspaceBatches(
      Object.fromEntries(
        Object.entries(current.batches).map(([batchId, batch]) => {
          if (batch.runId !== runId) return [batchId, batch];
          if (
            batch.phase === 'terminal' ||
            !affectedBatches.some((affected) => affected.batchId === batchId)
          )
            return [batchId, batch];
          const members = batch.members.map((member) => {
            const {
              blockedByPageId: _blockedByPageId,
              terminalOutcome: _terminalOutcome,
              ...cancelled
            } = member;
            return {
              ...cancelled,
              intent: 'cancelled' as const,
              reason: 'pruned',
              terminalOutcome: 'cancelled' as const,
            };
          });
          const {
            cancelRequested: _cancelRequested,
            terminalSummary: _terminalSummary,
            ...active
          } = batch;
          return [
            batchId,
            {
              ...active,
              phase: 'terminal' as const,
              stopReason: 'pruned',
              revision: batch.revision + 1,
              members,
              terminalSummary: {
                completedAt: prunedAt,
                status: 'cancelled' as const,
                total: members.length + batch.skipped.length,
                succeeded: 0,
                failed: 0,
                blocked: 0,
                cancelled: members.length,
                skipped: batch.skipped.length,
              },
            },
          ];
        }),
      ),
    );
    const existingIntent = current.structuralMutations[runId];
    const requiresStructuralCleanup = existingIntent !== undefined || affectedBatches.length > 0;
    const structuralMutations = !requiresStructuralCleanup
      ? current.structuralMutations
      : existingIntent !== undefined
        ? current.structuralMutations
        : {
            ...current.structuralMutations,
            [runId]: {
              schemaVersion: REACH_DECK_WORKSPACE_STRUCTURAL_MUTATION_SCHEMA_VERSION,
              runId,
              owner: {
                actorId: scope.actorId,
                actorOrganizationId: actorOrganizationIdFromPayload(scope),
                billingGroupId: scope.billingGroupId,
                roleGrantId: scope.roleGrantId,
                resourceScope: parseReachDeckResourceScope(scope.resourceScope),
              },
              phase: 'pending-cleanup' as const,
              fencedAt: prunedAt,
              batchIds: affectedBatches.map((batch) => batch.batchId).sort(),
            },
          };
    return {
      ...current,
      jobs: Object.fromEntries(
        Object.entries(current.jobs).filter(([jobId]) => !directJobIds.has(jobId)),
      ),
      results: Object.fromEntries(
        Object.entries(current.results).filter(([, result]) => !directJobIds.has(result.jobId)),
      ),
      ttsContinuations: Object.fromEntries(
        Object.entries(current.ttsContinuations).filter(([jobId]) => !directJobIds.has(jobId)),
      ),
      batches,
      structuralMutations,
      structuralJobTombstones,
      mediaCheckpoints: pruneReachDeckMediaCheckpoints(current.mediaCheckpoints, {
        jobs: Object.fromEntries(
          Object.entries(current.jobs).filter(([jobId]) => !directJobIds.has(jobId)),
        ),
        batches,
        structuralJobTombstones,
      }),
    };
  });

  if (cleanupSummary !== undefined) {
    console.info(
      JSON.stringify({
        ...observationLogContext(),
        event: 'reach_deck_structure_generation_cleanup',
        reason: 'structural-mutation',
        courseNodeId: context.resourceScope.courseNodeId,
        runId,
        preservedJobCount: cleanupSummary.preservedJobIds.length,
        cancelledJobCount: cleanupSummary.cancelledJobIds.length,
        preservedJobIds: cleanupSummary.preservedJobIds.slice(0, 20),
        cancelledJobIds: cleanupSummary.cancelledJobIds.slice(0, 20),
        truncated:
          cleanupSummary.preservedJobIds.length > 20 || cleanupSummary.cancelledJobIds.length > 20,
      }),
    );
  }

  await cancelPrunedReachDeckTtsContinuations(directLiveContinuations, dependencies);

  const reconciliation = await reconcileReachDeckWorkspaceStructuralJobTombstones(
    context,
    dependencies,
    runId,
  );
  const final = await finishReachDeckStructuralCleanupRun(context, scope, runId);
  const remaining = Object.values(final.recovery.structuralJobTombstones).filter(
    (tombstone) => tombstone.runId === runId && sameStructuralJobTombstoneOwner(tombstone, scope),
  );
  if (remaining.length > 0 || reconciliation.pendingJobIds.length > 0) {
    throw new ReachDeckStructuralJobCleanupPendingError(
      [
        ...new Set([...reconciliation.pendingJobIds, ...remaining.map((item) => item.jobId)]),
      ].sort(),
    );
  }
  if (structuralLeaseRelease) {
    await context.documentWriterSession?.releaseAfterStructuralCleanupForAsyncRun?.(runId);
  } else {
    await context.documentWriterSession?.releaseIfSettledForAsyncRun(runId);
  }
  return final;
}

export async function reconcileReachDeckWorkspaceStructuralJobTombstones(
  context: ReachDeckWorkspaceContext,
  dependencies: ReachDeckStructuralJobCleanupDependencies = {},
  targetRunId?: string,
): Promise<{ removedJobIds: string[]; pendingJobIds: string[] }> {
  const loaded = await loadReachDeckWorkspaceRecovery(context);
  const candidates = Object.values(loaded.recovery.structuralJobTombstones).filter(
    (tombstone) => targetRunId === undefined || tombstone.runId === targetRunId,
  );
  if (candidates.length === 0) return { removedJobIds: [], pendingJobIds: [] };

  const runtime = dependencies.runtime ?? createTeacherDeckRuntime(getRuntimeStore());
  const callerOwnedQueue = dependencies.queue;
  let queue: ReachDeckGenerationQueue;
  if (callerOwnedQueue !== undefined) {
    queue = callerOwnedQueue;
  } else {
    try {
      queue = await (
        dependencies.createQueue ?? (() => createReachDeckGenerationQueue(process.env, runtime))
      )();
    } catch (error) {
      warnStructuralJobCleanupFailure('queue-create', error, {
        candidateCount: candidates.length,
        ...(candidates.length === 1 ? { jobId: candidates[0]!.jobId } : {}),
      });
      return { removedJobIds: [], pendingJobIds: candidates.map((item) => item.jobId).sort() };
    }
  }

  const settled: ReachDeckStructuralJobCleanupSnapshot[] = [];
  const pendingJobIds: string[] = [];
  const durableResultJobIds = new Set(
    Object.values(loaded.recovery.results).map((result) => result.jobId),
  );
  try {
    const outcomes = await mapWithConcurrency(candidates, 8, async (tombstone) => {
      const descriptor = loaded.recovery.jobs[tombstone.jobId];
      const continuation = loaded.recovery.ttsContinuations[tombstone.jobId];
      const snapshot = {
        tombstone,
        ...(descriptor === undefined ? {} : { descriptor }),
        ...(continuation === undefined ? {} : { continuation }),
        hasDurableResult: durableResultJobIds.has(tombstone.jobId),
      } satisfies ReachDeckStructuralJobCleanupSnapshot;
      let stage: ReachDeckStructuralJobCleanupStage = 'snapshot';
      try {
        assertStructuralCleanupSnapshot(snapshot);
        stage = 'audit';
        const auditState = await convergeStructuralGenerationAudit(tombstone, dependencies);
        stage = 'queue-cancel';
        const queueObserved = (await queue.cancel(tombstone.jobId, tombstone.owner)) !== null;
        stage = 'queue-read';
        const queueState = await queue.readExecutionState(tombstone.jobId, tombstone.owner);
        if (queueState === 'active') {
          throw new ReachDeckStructuralJobCleanupDeferredError(
            'Reach Deck structural generation Queue execution is still active',
          );
        }
        stage = 'runtime';
        const runtimeState = await convergeStructuralRuntime(tombstone, runtime);
        stage = 'tts-cancel';
        await cancelStructuralTtsContinuation(continuation, tombstone, dependencies);
        if (auditState === 'missing') {
          if (
            !canCollectStructuralJobWithoutGenerationAudit(
              snapshot,
              queueObserved,
              queueState,
              runtimeState,
            )
          ) {
            throw new ReachDeckStructuralJobCleanupDeferredError(
              'Reach Deck structural generation audit is missing but execution evidence remains',
            );
          }
          // The coordinator registers recovery before it creates the audit. Structural cleanup
          // holds the same document writer lock, so a pristine descriptor plus two audit 404s
          // around all execution-plane checks identifies a crashed pre-enqueue registration.
          stage = 'audit-confirm';
          await convergeStructuralGenerationAudit(tombstone, dependencies);
        }
        return { status: 'settled' as const, snapshot };
      } catch (error) {
        if (error instanceof ReachDeckStructuralJobIdentityError) {
          warnStructuralJobCleanupFailure(stage, error, { jobId: tombstone.jobId });
          throw error;
        }
        if (!(error instanceof ReachDeckStructuralJobCleanupDeferredError)) {
          warnStructuralJobCleanupFailure(stage, error, { jobId: tombstone.jobId });
        }
        return { status: 'pending' as const, jobId: tombstone.jobId };
      }
    });
    for (const outcome of outcomes) {
      if (outcome.status === 'settled') settled.push(outcome.snapshot);
      else pendingJobIds.push(outcome.jobId);
    }
  } finally {
    if (callerOwnedQueue === undefined) {
      try {
        await queue.close();
      } catch (error) {
        warnStructuralJobCleanupFailure('queue-close', error, {
          candidateCount: candidates.length,
          ...(candidates.length === 1 ? { jobId: candidates[0]!.jobId } : {}),
        });
      }
    }
  }

  const removedJobIds = await finalizeReachDeckStructuralJobTombstones(context, settled);
  for (const snapshot of settled) {
    if (!removedJobIds.includes(snapshot.tombstone.jobId)) {
      pendingJobIds.push(snapshot.tombstone.jobId);
    }
  }
  return {
    removedJobIds: [...new Set(removedJobIds)].sort(),
    pendingJobIds: [...new Set(pendingJobIds)].sort(),
  };
}

interface ReachDeckStructuralJobCleanupSnapshot {
  tombstone: ReachDeckWorkspaceStructuralJobTombstone;
  descriptor?: ReachDeckWorkspaceRecoveryJob;
  continuation?: ReachDeckWorkspaceTtsContinuation;
  hasDurableResult: boolean;
}

type ReachDeckStructuralGenerationAuditState = 'fenced' | 'missing';

async function convergeStructuralGenerationAudit(
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
  dependencies: ReachDeckStructuralJobCleanupDependencies,
): Promise<ReachDeckStructuralGenerationAuditState> {
  const readAudit = dependencies.readAudit ?? getReachDeckGenerationAudit;
  const updateAudit =
    dependencies.updateAudit ?? updateReachDeckGenerationAuditByScopeWithNarrowRetry;
  const abortAudit = dependencies.abortAudit ?? abortReachDeckGenerationAuditByScopeWithNarrowRetry;
  const errorSummary = reachDeckGenerationAuditErrorSummary(
    'Generation invalidated by a structural workspace mutation',
    'structural-mutation',
  );
  let audit: ReachDeckGenerationAuditResource;
  try {
    audit = await readAudit(tombstone.jobId, tombstone.requestHash, tombstone.owner);
  } catch (error) {
    if (error instanceof ContentServiceClientError && error.status === 404) return 'missing';
    throw error;
  }
  for (let transition = 0; transition < 4; transition += 1) {
    assertAuditMatchesStructuralJobTombstone(audit, tombstone);
    if (isPermanentGenerationAuditFence(audit)) return 'fenced';
    try {
      if (audit.status === 'failed') {
        audit = await updateAudit(
          tombstone.jobId,
          tombstone.requestHash,
          {
            status: 'retrying',
            executionAttempt: audit.executionAttempt,
            errorSummary,
          },
          tombstone.owner,
        );
        assertAuditMatchesStructuralJobTombstone(audit, tombstone);
        if (isPermanentGenerationAuditFence(audit)) return 'fenced';
        if (audit.status !== 'retrying') {
          throw new Error('Reach Deck structural generation audit retry transition was rejected');
        }
      }
      audit = await abortAudit(
        tombstone.jobId,
        tombstone.requestHash,
        { errorSummary },
        tombstone.owner,
      );
    } catch (error) {
      if (!(error instanceof ContentServiceClientError && error.status === 409)) throw error;
      audit = await readAudit(tombstone.jobId, tombstone.requestHash, tombstone.owner);
      continue;
    }
    assertAuditMatchesStructuralJobTombstone(audit, tombstone);
    if (isPermanentGenerationAuditFence(audit)) return 'fenced';
  }
  throw new Error('Reach Deck structural generation audit is not permanently fenced');
}

function isPermanentGenerationAuditFence(audit: ReachDeckGenerationAuditResource): boolean {
  return audit.status === 'aborted' || audit.status === 'succeeded';
}

async function convergeStructuralRuntime(
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
  runtime: Pick<TeacherDeckRuntime, 'readExisting' | 'cancel'>,
): Promise<'missing' | 'present'> {
  if (runtime.readExisting === undefined) {
    throw new Error('Reach Deck structural Runtime read is unavailable');
  }
  const reference = structuralRuntimeJobRef(tombstone);
  let run = await runtime.readExisting(reference);
  if (run === null) return 'missing';
  if (isTerminalRuntimeRun(run)) return 'present';
  await runtime.cancel(reference);
  run = await runtime.readExisting(reference);
  if (run !== null && !isTerminalRuntimeRun(run)) {
    throw new ReachDeckStructuralJobCleanupDeferredError(
      'Reach Deck structural Runtime execution is still active',
    );
  }
  return 'present';
}

function canCollectStructuralJobWithoutGenerationAudit(
  snapshot: ReachDeckStructuralJobCleanupSnapshot,
  queueObserved: boolean,
  queueState: 'missing' | 'active' | 'inactive',
  runtimeState: 'missing' | 'present',
): boolean {
  return (
    snapshot.descriptor !== undefined &&
    snapshot.descriptor.artifactRef === undefined &&
    snapshot.descriptor.appliedAt === undefined &&
    !snapshot.hasDurableResult &&
    snapshot.continuation === undefined &&
    !queueObserved &&
    queueState === 'missing' &&
    runtimeState === 'missing'
  );
}

function isTerminalRuntimeRun(run: RunRecord): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}

function structuralRuntimeJobRef(
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
): TeacherDeckRuntimeJobRef {
  return {
    ...tombstone.owner,
    jobId: tombstone.jobId,
    kind: 'narration-generation',
    runId: tombstone.runId,
    requestHash: tombstone.requestHash,
  };
}

async function cancelStructuralTtsContinuation(
  continuation: ReachDeckWorkspaceTtsContinuation | undefined,
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
  dependencies: ReachDeckStructuralJobCleanupDependencies,
): Promise<void> {
  if (
    continuation === undefined ||
    (continuation.queue === undefined && !reachDeckTtsContinuationHasActiveTicket(continuation))
  ) {
    return;
  }
  const exchangeVoiceCapability =
    dependencies.exchangeVoiceCapability ?? exchangeReachDeckVoiceCapability;
  const cancelSpeech = dependencies.cancelSpeech ?? cancelReachDeckSpeech;
  // 并发分块下一个 job 可能同时持有多张票据，漏掉一张就会让它跑到自然超时。
  // 逐张各自兜错、最后再抛：共用一个 try 时首张失败会跳过其余，正好重新打开本要堵
  // 的那个洞；但错误也不能就此吞掉——调用方靠它把 continuation 留下来稍后重试。
  let failure: unknown;
  for (const requestIdentity of reachDeckTtsContinuationQueueIdentities(continuation)) {
    try {
      const voiceCloneCapability =
        continuation.voiceSelection.kind === 'clone'
          ? await exchangeVoiceCapability(
              continuation.voiceSelection,
              'cancel',
              requestIdentity,
              tombstone.owner,
            )
          : undefined;
      await cancelSpeech(requestIdentity, {
        ...(continuation.voiceSelection.kind === 'default'
          ? { voice: continuation.voiceSelection.voice }
          : {}),
        context: {
          actorId: tombstone.owner.actorId,
          billingGroupId: tombstone.owner.billingGroupId,
          resourceScope: tombstone.owner.resourceScope,
          jobId: tombstone.jobId,
          runId: tombstone.runId,
        },
        signal: AbortSignal.timeout(5_000),
        ...(voiceCloneCapability === undefined ? {} : { voiceCloneCapability }),
      });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function finalizeReachDeckStructuralJobTombstones(
  context: ReachDeckWorkspaceContext,
  snapshots: readonly ReachDeckStructuralJobCleanupSnapshot[],
): Promise<string[]> {
  if (snapshots.length === 0) return [];
  const expected = new Map(snapshots.map((snapshot) => [snapshot.tombstone.jobId, snapshot]));
  const saved = await transitionReachDeckWorkspaceRecovery(context, (current) => {
    const jobs = { ...current.jobs };
    const results = { ...current.results };
    const ttsContinuations = { ...current.ttsContinuations };
    const structuralJobTombstones = { ...current.structuralJobTombstones };
    const removable = new Set<string>();
    for (const [jobId, snapshot] of expected) {
      const tombstone = structuralJobTombstones[jobId];
      if (tombstone === undefined || !sameStructuralJobTombstone(tombstone, snapshot.tombstone)) {
        continue;
      }
      const descriptor = jobs[jobId];
      const continuation = ttsContinuations[jobId];
      if (
        !optionalValuesEqual(descriptor, snapshot.descriptor) ||
        !optionalValuesEqual(continuation, snapshot.continuation) ||
        !canRemoveStructuralBatchReferences(current.batches, tombstone)
      ) {
        continue;
      }
      removable.add(jobId);
      delete jobs[jobId];
      delete ttsContinuations[jobId];
      delete structuralJobTombstones[jobId];
      for (const [reference, result] of Object.entries(results)) {
        if (result.jobId === jobId) delete results[reference];
      }
    }
    if (removable.size === 0) return current;
    const batches = Object.fromEntries(
      Object.entries(current.batches).map(([batchId, batch]) => [
        batchId,
        {
          ...batch,
          members: batch.members.map((member) => {
            if (member.jobId === undefined || !removable.has(member.jobId)) return member;
            const { jobId: _jobId, ...withoutJobReference } = member;
            return withoutJobReference;
          }),
        },
      ]),
    );
    return {
      ...current,
      jobs,
      results,
      ttsContinuations,
      batches,
      structuralJobTombstones,
    };
  });
  return snapshots
    .map((snapshot) => snapshot.tombstone.jobId)
    .filter((jobId) => saved.recovery.structuralJobTombstones[jobId] === undefined);
}

function canRemoveStructuralBatchReferences(
  batches: ReachDeckWorkspaceBatches,
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
): boolean {
  return Object.values(batches).every((batch) =>
    batch.members.every((member) => {
      if (member.jobId !== tombstone.jobId) return true;
      return (
        batch.runId === tombstone.runId &&
        batch.phase === 'terminal' &&
        sameReachDeckWorkspaceBatchOwner(batch, tombstone.owner) &&
        member.pageId === tombstone.pageId &&
        member.requestedRevision === tombstone.requestedRevision &&
        member.attempt === tombstone.attempt
      );
    }),
  );
}

async function finishReachDeckStructuralCleanupRun(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  runId: string,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  return transitionReachDeckWorkspaceRecovery(context, (current) => {
    const intent = current.structuralMutations[runId];
    if (intent === undefined) return current;
    if (!sameReachDeckWorkspaceBatchOwner({ owner: intent.owner }, scope)) {
      throw new Error('Reach Deck structural mutation cleanup scope does not match');
    }
    const hasRecoveryReferences = Object.values(current.structuralJobTombstones).some(
      (tombstone) => tombstone.runId === runId,
    );
    if (hasRecoveryReferences) return current;
    const structuralMutations = { ...current.structuralMutations };
    delete structuralMutations[runId];
    return { ...current, structuralMutations };
  });
}

async function cancelPrunedReachDeckTtsContinuations(
  liveContinuations: ReadonlyMap<
    string,
    {
      continuation: ReachDeckWorkspaceTtsContinuation;
      scope: ReachDeckGenerationJobScope;
    }
  >,
  dependencies: ReachDeckStructuralJobCleanupDependencies,
): Promise<void> {
  const cancelSpeech = dependencies.cancelSpeech ?? cancelReachDeckSpeech;
  const exchangeVoiceCapability =
    dependencies.exchangeVoiceCapability ?? exchangeReachDeckVoiceCapability;
  await Promise.all(
    [...liveContinuations.values()].flatMap(({ continuation, scope }) =>
      reachDeckTtsContinuationQueueIdentities(continuation).map(async (requestIdentity) => {
        try {
          const voiceCloneCapability =
            continuation.voiceSelection.kind === 'clone'
              ? await exchangeVoiceCapability(
                  continuation.voiceSelection,
                  'cancel',
                  requestIdentity,
                  scope,
                )
              : undefined;
          await cancelSpeech(requestIdentity, {
            ...(continuation.voiceSelection.kind === 'default'
              ? { voice: continuation.voiceSelection.voice }
              : {}),
            context: {
              actorId: scope.actorId,
              actorOrganizationId: actorOrganizationIdFromPayload(scope),
              billingGroupId: scope.billingGroupId,
              resourceScope: scope.resourceScope,
              jobId: continuation.jobId,
              runId: continuation.runId,
            },
            signal: AbortSignal.timeout(5_000),
            ...(voiceCloneCapability === undefined ? {} : { voiceCloneCapability }),
          });
        } catch (error) {
          console.warn('Reach Deck pruned TTS ticket cancel failed', error);
        }
      }),
    ),
  );
}

async function retryAfterStructuralTombstoneCapacityRecovery<T>(
  context: ReachDeckWorkspaceContext,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ReachDeckStructuralJobTombstoneCapacityError)) throw error;
    let recovery: Awaited<ReturnType<typeof reconcileReachDeckWorkspaceStructuralJobTombstones>>;
    try {
      recovery = await reconcileReachDeckWorkspaceStructuralJobTombstones(context);
    } catch (recoveryError) {
      warnStructuralJobCleanupFailure('capacity-recovery', recoveryError);
      throw error;
    }
    if (recovery.removedJobIds.length === 0) throw error;
    return operation();
  }
}

type ReachDeckStructuralJobCleanupStage =
  | 'queue-create'
  | 'snapshot'
  | 'audit'
  | 'audit-confirm'
  | 'queue-cancel'
  | 'queue-read'
  | 'queue-close'
  | 'runtime'
  | 'tts-cancel'
  | 'capacity-recovery';

function warnStructuralJobCleanupFailure(
  stage: ReachDeckStructuralJobCleanupStage,
  error: unknown,
  context: { jobId?: string; candidateCount?: number } = {},
): void {
  const details =
    error instanceof Error
      ? { errorName: error.name, errorMessage: error.message }
      : { errorName: 'UnknownError', errorMessage: String(error) };
  console.warn('Reach Deck structural job cleanup failed', {
    stage,
    ...context,
    ...details,
  });
}

function structuralJobTombstoneFromDescriptor(
  descriptor: ReachDeckWorkspaceRecoveryJob,
  cancelledAt: string,
): ReachDeckWorkspaceStructuralJobTombstone {
  const attempt = Number(descriptor.generationAttempt);
  if (
    descriptor.kind !== 'narration-generation' ||
    descriptor.pageId === undefined ||
    descriptor.requestedRevision === undefined ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  ) {
    throw new Error('Reach Deck structural cleanup job identity is incomplete');
  }
  return {
    schemaVersion: REACH_DECK_WORKSPACE_STRUCTURAL_JOB_TOMBSTONE_SCHEMA_VERSION,
    jobId: descriptor.jobId,
    runId: descriptor.runId,
    owner: {
      actorId: descriptor.actorId,
      actorOrganizationId: actorOrganizationIdFromPayload(descriptor),
      billingGroupId: descriptor.billingGroupId,
      roleGrantId: descriptor.roleGrantId,
      resourceScope: descriptor.resourceScope,
    },
    pageId: descriptor.pageId,
    requestedRevision: descriptor.requestedRevision,
    attempt,
    requestHash: descriptor.requestHash,
    cancelledAt,
    reason: 'structural-mutation',
  };
}

function assertStructuralCleanupSnapshot(snapshot: ReachDeckStructuralJobCleanupSnapshot): void {
  if (
    snapshot.descriptor !== undefined &&
    !structuralJobDescriptorMatchesTombstone(snapshot.descriptor, snapshot.tombstone)
  ) {
    throw new ReachDeckStructuralJobIdentityError(
      'Reach Deck structural cleanup descriptor identity changed',
    );
  }
  if (
    snapshot.continuation !== undefined &&
    (snapshot.continuation.jobId !== snapshot.tombstone.jobId ||
      snapshot.continuation.runId !== snapshot.tombstone.runId ||
      snapshot.continuation.requestHash !== snapshot.tombstone.requestHash ||
      snapshot.continuation.pageId !== snapshot.tombstone.pageId)
  ) {
    throw new ReachDeckStructuralJobIdentityError(
      'Reach Deck structural cleanup TTS continuation identity changed',
    );
  }
}

function assertAuditMatchesStructuralJobTombstone(
  audit: ReachDeckGenerationAuditResource,
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
): void {
  if (
    audit.jobId !== tombstone.jobId ||
    audit.actorId !== tombstone.owner.actorId ||
    audit.billingGroupId !== tombstone.owner.billingGroupId ||
    !sameReachDeckResourceScope(audit, tombstone.owner.resourceScope) ||
    audit.requestHash !== tombstone.requestHash
  ) {
    throw new ReachDeckStructuralJobIdentityError(
      'Reach Deck structural generation audit identity changed',
    );
  }
}

function structuralJobDescriptorMatchesTombstone(
  descriptor: ReachDeckWorkspaceRecoveryJob,
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
): boolean {
  return (
    descriptor.jobId === tombstone.jobId &&
    descriptor.kind === 'narration-generation' &&
    descriptor.runId === tombstone.runId &&
    sameScope(descriptor, tombstone.owner) &&
    descriptor.pageId === tombstone.pageId &&
    descriptor.requestedRevision === tombstone.requestedRevision &&
    Number(descriptor.generationAttempt) === tombstone.attempt &&
    descriptor.requestHash === tombstone.requestHash
  );
}

function sameStructuralJobTombstoneOwner(
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
  scope: ReachDeckGenerationJobScope,
): boolean {
  return sameReachDeckWorkspaceBatchOwner({ owner: tombstone.owner }, scope);
}

function optionalValuesEqual(left: unknown, right: unknown): boolean {
  return left === undefined && right === undefined
    ? true
    : left === undefined || right === undefined
      ? false
      : valuesEqual(left, right);
}

/** 队列记录已清理、审计却仍停在 running/retrying 超过这个时长，按中断后的孤儿审计处理。 */
export const ORPHANED_AUDIT_AFTER_MS = 10 * 60_000;

/**
 * 孤儿审计判定：任务执行过（executionAttempt ≥ 1）却停在 queued/running/retrying，
 * 久未更新，且 BullMQ 里已没有在途记录。
 *
 * 数据源：content-service 生成审计、BullMQ 任务记录（均由调用方读出后传入，本函数不读写）。
 *
 * 核心逻辑：任务结束时先写终态审计、BullMQ 才清理记录；队列里已没有（或已结束）、审计却停在
 * 执行中且超过 {@link ORPHANED_AUDIT_AFTER_MS} 没有更新，就是中断后没结清的审计（典型是 worker
 * 发布排空时丢了重试）。从未执行过的 queued@0 不算：那是入队可见性尚未建立，lane 会重新入队接住。
 * 停滞页对账、异步写租约判定和发布检查共用这一条规则，避免各自漂移。
 */
export function isReachDeckOrphanedGenerationAudit(
  audit: Pick<ReachDeckGenerationAuditResource, 'status' | 'executionAttempt' | 'updatedAt'>,
  queued: Pick<ReachDeckGenerationJobView, 'done'> | null,
  now: number,
): boolean {
  if (queued !== null && !queued.done) return false;
  const executing =
    audit.status === 'running' ||
    audit.status === 'retrying' ||
    (audit.status === 'queued' && audit.executionAttempt >= 1);
  return executing && now - Date.parse(audit.updatedAt) > ORPHANED_AUDIT_AFTER_MS;
}

export async function listReachDeckWorkspaceRecoveryJobs(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  options: {
    /** Existing workspace classification; only the native channel is filtered below. */
    nativeNarration?: boolean;
    workspace?: GenerationWorkspace;
    allowPayloadRead?: boolean;
    /** Caller-provided materialized document. A missing value is a conservative fallback. */
    materializedDocument?: ReachDeckDocument;
  } = {},
): Promise<ReachDeckRecoveredJobMetadata[]> {
  let resource = await loadReachDeckWorkspaceRecovery(context);
  if ((await reconcileLoadedDecksmithLease(context, resource)).released) {
    resource = await loadReachDeckWorkspaceRecovery(context);
  }
  const queueReader = lazyRecoveryProjectionQueue(createReachDeckGenerationQueue);
  try {
    return await projectReachDeckWorkspaceRecoveryJobs(
      resource,
      scope,
      runId,
      options,
      queueReader.get,
    );
  } finally {
    await queueReader.close();
  }
}

async function projectReachDeckWorkspaceRecoveryJobs(
  resource: ReachDeckWorkspaceRecoveryResource,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  options: {
    nativeNarration?: boolean;
    workspace?: GenerationWorkspace;
    allowPayloadRead?: boolean;
    publicationCheck?: boolean;
    materializedDocument?: ReachDeckDocument;
  },
  getQueue: () => Promise<ReachDeckGenerationQueue>,
): Promise<ReachDeckRecoveredJobMetadata[]> {
  const scopedStaged = Object.values(resource.recovery.jobs).filter(
    (job) => job.runId === runId && sameScope(job, scope),
  );
  // Choose before hiding applied descriptors: a newer applied plan must still suppress an
  // older unapplied result after a browser reload. Other job kinds retain their own selection.
  const latestPlanners = new Map<string, ReachDeckWorkspaceRecoveryJob>();
  for (const job of scopedStaged) {
    if (job.kind !== 'lesson-plan' && job.kind !== 'page-outline') continue;
    const previous = latestPlanners.get(job.kind);
    if (previous === undefined || job.queuedAt >= previous.queuedAt) {
      latestPlanners.set(job.kind, job);
    }
  }
  const chainStartedAt = new Map<string, string>();
  for (const job of scopedStaged) {
    if (job.kind !== 'narration-generation' || job.chainId === undefined) continue;
    const current = chainStartedAt.get(job.chainId);
    if (current === undefined || job.queuedAt < current)
      chainStartedAt.set(job.chainId, job.queuedAt);
  }
  const provenance = new Map<
    string,
    ReachDeckJobResponseMetadata & { status?: string; done?: boolean }
  >();
  for (const job of scopedStaged) {
    if (job.kind === 'page-generation') {
      const member = Object.values(resource.recovery.batches)
        .filter((batch) => batch.runId === runId && sameReachDeckWorkspaceBatchOwner(batch, scope))
        .flatMap((batch) => batch.members)
        .find((candidate) => candidate.jobId === job.jobId);
      provenance.set(job.jobId, {
        sourceKind: 'workspace',
        affectedLanes: ['layout'],
        ...(member ? reachDeckRegenerationMemberMetadata(member) : {}),
        ...(job.affectedLanes === undefined ? {} : { affectedLanes: job.affectedLanes }),
      });
      continue;
    }
    if (job.kind !== 'narration-generation') continue;
    const stored =
      job.artifactRef === undefined
        ? undefined
        : resource.recovery.results[job.artifactRef]?.result;
    const durable = reachDeckJobResponseMetadata(undefined, stored);
    const continuation = resource.recovery.ttsContinuations[job.jobId];
    const memberBatch = Object.values(resource.recovery.batches).find(
      (batch) =>
        batch.runId === runId &&
        sameReachDeckWorkspaceBatchOwner(batch, scope) &&
        batch.members.some((member) => member.jobId === job.jobId),
    );
    const sourceKind =
      durable.sourceKind ??
      continuation?.sourceKind ??
      memberBatch?.members.find((member) => member.jobId === job.jobId)?.sourceKind ??
      (job.pageId !== undefined &&
      reachDeckPageUsesNativeNarration(
        options.workspace ?? { records: {} },
        options.materializedDocument,
        job.pageId,
      )
        ? 'materialized-native'
        : undefined) ??
      (job.pageId !== undefined &&
      options.workspace?.records[job.pageId]?.request === undefined &&
      options.materializedDocument?.pages.some(
        (page) => page.pageId === job.pageId && page.sceneType === 'interactive',
      )
        ? 'materialized-interactive'
        : undefined);
    const memberIndex = memberBatch?.members.findIndex((member) => member.jobId === job.jobId);
    const terminalOutcome =
      memberBatch === undefined || memberIndex === undefined || memberIndex < 0
        ? undefined
        : (memberBatch.members[memberIndex]?.terminalOutcome ??
          deriveLegacyBatchMemberTerminalOutcome(memberBatch, memberIndex));
    provenance.set(job.jobId, {
      ...durable,
      ...(sourceKind === undefined ? {} : { sourceKind }),
      ...(terminalOutcome === undefined ? {} : { status: terminalOutcome, done: true }),
    });
  }
  // Read only bounded active jobs whose source/options are not durably known. These reads do
  // not mutate recovery, and share the projection's queue instance with batch inspection.
  const ambiguous = scopedStaged
    .filter(
      (job) =>
        job.kind === 'narration-generation' &&
        job.artifactRef === undefined &&
        job.appliedAt === undefined &&
        resource.recovery.ttsContinuations[job.jobId] === undefined &&
        !Object.values(resource.recovery.batches).some(
          (batch) =>
            batch.runId === runId &&
            sameReachDeckWorkspaceBatchOwner(batch, scope) &&
            batch.members.some((member) => member.jobId === job.jobId),
        ) &&
        (provenance.get(job.jobId)?.sourceKind === undefined ||
          provenance.get(job.jobId)?.affectedLanes === undefined),
    )
    .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
    .slice(0, 20);
  if (options.allowPayloadRead !== false && ambiguous.length > 0) {
    await mapWithConcurrency(ambiguous, 4, async (job) => {
      const value = await boundedRecoveryQueueRead(async () =>
        (await getQueue()).readWithPayload(job.jobId, scope),
      );
      if (value === null || value.view.jobId !== job.jobId) return;
      const payload = value.payload;
      const exact =
        payload !== undefined &&
        payload.kind === job.kind &&
        payload.jobId === job.jobId &&
        payload.runId === job.runId &&
        payload.requestHash === job.requestHash &&
        payload.actorId === scope.actorId &&
        actorOrganizationIdFromPayload(payload) === actorOrganizationIdFromPayload(scope) &&
        payload.billingGroupId === scope.billingGroupId &&
        payload.roleGrantId === scope.roleGrantId &&
        sameReachDeckResourceScope(payload.resourceScope, scope.resourceScope);
      const metadata = exact
        ? reachDeckJobResponseMetadata(payload as ReachDeckStagedGenerationJobPayload)
        : {};
      provenance.set(job.jobId, {
        ...provenance.get(job.jobId),
        ...metadata,
        status: value.view.status,
        done: value.view.done,
      });
    });
  }
  // Payload provenance and live status are separate. TTS/batch-proven jobs and jobs beyond the
  // payload limit still need bounded status reads so reload can show their actual activity.
  if (options.allowPayloadRead !== false || options.publicationCheck === true) {
    const candidates = scopedStaged
      .filter(
        (job) =>
          job.appliedAt === undefined &&
          job.artifactRef === undefined &&
          (job.kind === 'narration-generation' || job.kind === 'page-generation') &&
          provenance.get(job.jobId)?.done === undefined,
      )
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
    // Publication inspects every potentially live descriptor; the display window cannot
    // establish that an older standalone task has finished.
    const statusJobs = options.publicationCheck === true ? candidates : candidates.slice(0, 40);
    await mapWithConcurrency(statusJobs, 4, async (job) => {
      const read = async () => (await getQueue()).read(job.jobId, scope);
      const view =
        options.publicationCheck === true
          ? await boundedNarrationAdmissionRead(read)
          : await boundedRecoveryQueueRead(read);
      if (options.publicationCheck === true && view === null) {
        const audit = await boundedNarrationAdmissionRead(async () => {
          try {
            return await getReachDeckGenerationAudit(job.jobId, job.requestHash, scope);
          } catch (error) {
            if (error instanceof ContentServiceClientError && error.status === 404)
              return undefined;
            throw error;
          }
        });
        if (audit !== undefined) {
          assertAuditMatchesDescriptor(audit, job);
          const resultPending = audit.status === 'succeeded' && audit.stagedResultRef !== undefined;
          // 任务结束时先写终态审计、BullMQ 才清理记录；队列里已没有、审计却停在 running/retrying
          // 且久未更新，是中断后没结清的孤儿审计（例如 worker 部署替换时被中断），不能永久挡住发布。
          const orphaned = isReachDeckOrphanedGenerationAudit(audit, null, Date.now());
          provenance.set(job.jobId, {
            ...provenance.get(job.jobId),
            status: resultPending ? 'completed' : orphaned ? 'failed' : audit.status,
            done:
              orphaned ||
              (!resultPending && ['failed', 'aborted', 'succeeded'].includes(audit.status)),
          });
        }
        return;
      }
      if (options.publicationCheck === true && view?.jobId !== job.jobId)
        throw new ReachDeckNarrationAdmissionReadError();
      if (view === null || view.jobId !== job.jobId) return;
      provenance.set(job.jobId, {
        ...provenance.get(job.jobId),
        status: view.status,
        done: view.done,
      });
    });
  }
  const activeStaged = selectActiveStagedRecoveryJobs(scopedStaged, {
    nativeNarration: options.nativeNarration === true,
    workspace: options.workspace,
    materializedDocument: options.materializedDocument,
    chainStartedAt,
    provenance,
  });
  const staged = activeStaged
    .filter((job) => !latestPlanners.has(job.kind) || latestPlanners.get(job.kind) === job)
    .filter((job) => job.appliedAt === undefined)
    .map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      runId: job.runId,
      status:
        provenance.get(job.jobId)?.status ??
        (job.artifactRef === undefined ? ('registered' as const) : ('completed' as const)),
      ...provenance.get(job.jobId),
      pollPath: `/api/generation/${encodeURIComponent(job.jobId)}`,
      eventsPath: `/api/generation/${encodeURIComponent(job.jobId)}/events`,
      pollIntervalMs: job.artifactRef === undefined ? 2_000 : 0,
      ...(job.pageId === undefined ? {} : { pageId: job.pageId }),
      ...(job.requestedRevision === undefined ? {} : { requestedRevision: job.requestedRevision }),
      ...(job.chainId === undefined ? {} : { chainId: job.chainId }),
      queuedAt: job.queuedAt,
    }));
  const appliedNativeAudioFailures = scopedStaged
    .filter(
      (job) =>
        job.kind === 'narration-generation' &&
        job.appliedAt !== undefined &&
        job.artifactRef !== undefined,
    )
    .flatMap((job) => {
      const failure = nativeAudioFailureMetadata(
        resource,
        job,
        options.materializedDocument,
        options.workspace,
      );
      return failure === undefined
        ? []
        : [
            {
              jobId: job.jobId,
              kind: job.kind,
              runId: job.runId,
              status: 'completed' as const,
              pollPath: `/api/generation/${encodeURIComponent(job.jobId)}`,
              eventsPath: `/api/generation/${encodeURIComponent(job.jobId)}/events`,
              pollIntervalMs: 0,
              pageId: job.pageId,
              requestedRevision: job.requestedRevision,
              queuedAt: job.queuedAt,
              nativeAudioFailure: failure,
            },
          ];
    });
  const decksmith = await Promise.all(
    Object.values(resource.recovery.decksmithJobs)
      // Decksmith runs have their own idempotency namespace and therefore do not share the
      // workspace generation runId. Scope is the authority boundary; the caller selects the
      // active candidate by lifecycle/page rather than comparing unrelated run identifiers.
      .filter((job) => sameDecksmithScope(job, scope))
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
      .map(async (job) => {
        const stored =
          job.resultRef === undefined
            ? undefined
            : resource.recovery.decksmithResults[job.resultRef];
        const resolution =
          stored === undefined ? null : await resolveDecksmithPublicResult(job, stored);
        const runtimeRun =
          job.runtimeRunId === undefined ? null : await getRuntimeStore().getRun(job.runtimeRunId);
        const failed =
          runtimeRun?.status === 'failed' && runtimeRun.error?.code === 'RUN_QUEUE_UNAVAILABLE';
        return {
          jobId: job.jobId,
          kind: job.kind,
          runId: job.runId,
          status: failed
            ? ('failed' as const)
            : resolution !== null
              ? resolution.lifecycle
              : ('registered' as const),
          pollPath: `/api/generation/${encodeURIComponent(job.jobId)}`,
          eventsPath: `/api/generation/${encodeURIComponent(job.jobId)}/events`,
          pollIntervalMs: failed || resolution !== null ? 0 : 2_000,
          baseDocumentHash: job.baseDocumentHash,
          ...(job.pageId === undefined ? {} : { pageId: job.pageId }),
          ...(resolution?.result?.runtimeApprovalId === undefined
            ? {}
            : { runtimeApprovalId: resolution.result.runtimeApprovalId }),
          queuedAt: job.queuedAt,
        };
      }),
  );
  return [
    ...staged.map((job) => ({ ...job, queuedAt: resource.recovery.jobs[job.jobId]!.queuedAt })),
    ...(options.publicationCheck === true ? [] : appliedNativeAudioFailures),
    ...decksmith
      .filter(
        (job) => job.status !== 'rejected' && job.status !== 'applied' && job.status !== 'failed',
      )
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
      .slice(0, MAX_RECOVERABLE_DECKSMITH_LIST_JOBS),
  ]
    .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
    .map((job) => {
      if (job.kind !== 'decksmith') return job;
      const { queuedAt: _queuedAt, ...publicJob } = job;
      return publicJob;
    });
}

function nativeAudioFailureMetadata(
  resource: ReachDeckWorkspaceRecoveryResource,
  job: ReachDeckWorkspaceRecoveryJob,
  document: ReachDeckDocument | undefined,
  workspace: GenerationWorkspace | undefined,
): NonNullable<ReachDeckRecoveredJobMetadata['nativeAudioFailure']> | undefined {
  if (job.pageId === undefined || job.requestedRevision === undefined) return undefined;
  if (job.artifactRef === undefined) return undefined;
  const workspaceResult = resource.recovery.results[job.artifactRef]?.result;
  if (
    workspaceResult?.kind === 'narration-generation' &&
    'artifact' in workspaceResult &&
    workspaceResult.artifact.pageId === job.pageId
  ) {
    return workspaceNarrationAudioFailure(workspaceResult, document, workspace);
  }
  if (document?.schemaVersion !== 'reach-deck-document/v2') return undefined;
  const page = document.pages.find((candidate) => candidate.pageId === job.pageId);
  const narration = document.nativeSlides.find((candidate) => candidate.pageId === job.pageId)
    ?.slide.narration;
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === job.pageId);
  const stored = resource.recovery.results[job.artifactRef];
  const result = stored?.result;
  if (
    page === undefined ||
    binding === undefined ||
    page.revision !== job.requestedRevision + 1 ||
    narration === undefined ||
    narration.audioResourceId !== undefined ||
    result?.kind !== 'narration-generation' ||
    !('nativeNarration' in result)
  ) {
    return undefined;
  }
  const native = result.nativeNarration;
  if (
    native.audioFailureCode === undefined ||
    native.pageId !== job.pageId ||
    native.markdown !== narration.markdown ||
    !jsonEqual(native.speechMarkup, narration.speechMarkup) ||
    buildReachDeckNativeSlideContentDigest(binding.slide) !== native.nativeSlideContentDigest
  ) {
    return undefined;
  }
  return {
    pageId: native.pageId,
    requestedRevision: native.requestedRevision,
    markdown: native.markdown,
    ...(native.speechMarkup === undefined ? {} : { speechMarkup: native.speechMarkup }),
    audioFailureCode: native.audioFailureCode,
  };
}

/**
 * 首轮工作区通道「讲稿保留、音频失败」结果的教师端投影。
 *
 * 数据源：recovery 文档中的耐久结果，加当前物化文档（已物化时）或工作区工件（未物化时）。
 * 核心逻辑：
 * 1. 只处理带 audioFailureCode 的原生 slide 工件结果；
 * 2. 已物化：物化文档该页讲稿与结果一致且仍无音频才报告；
 * 3. 未物化：工作区该页工件与结果同一请求身份、讲稿一致且仍无音频才报告；
 * 4. 教师改了讲稿或补好音频后不再报告，避免过期提示。
 */
export function workspaceNarrationAudioFailure(
  result: ReachDeckNarrationGenerationJobResult,
  document: ReachDeckDocument | undefined,
  workspace: GenerationWorkspace | undefined,
): NonNullable<ReachDeckRecoveredJobMetadata['nativeAudioFailure']> | undefined {
  const artifact = result.artifact;
  if (result.audioFailureCode === undefined || !isNativeSlideArtifact(artifact)) return undefined;
  const script = artifact.nativeSlide.narration;
  if (script?.markdown === undefined) return undefined;
  const sameScript = (narration: ReachDeckNativeSlideV2['narration']) =>
    narration !== undefined &&
    narration.markdown === script.markdown &&
    jsonEqual(narration.speechMarkup, script.speechMarkup) &&
    narration.audioResourceId === undefined &&
    (narration.segments ?? []).length === 0;
  let matches: boolean;
  if (document?.schemaVersion === 'reach-deck-document/v2') {
    matches = sameScript(
      document.nativeSlides.find((binding) => binding.pageId === artifact.pageId)?.slide.narration,
    );
  } else {
    const current = workspace?.sceneArtifacts[artifact.pageId];
    matches =
      current !== undefined &&
      isNativeSlideArtifact(current) &&
      current.runId === artifact.runId &&
      current.requestedRevision === artifact.requestedRevision &&
      current.attempt === artifact.attempt &&
      sameScript(current.nativeSlide.narration);
  }
  if (!matches) return undefined;
  return {
    pageId: artifact.pageId,
    requestedRevision: artifact.requestedRevision,
    markdown: script.markdown,
    ...(script.speechMarkup === undefined ? {} : { speechMarkup: script.speechMarkup }),
    audioFailureCode: result.audioFailureCode,
  };
}

/** Structured JSON equality for matching recovered artifacts to the current document state. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftEntries = Object.entries(left as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  const rightRecord = right as Record<string, unknown>;
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return (
    leftEntries.length === rightKeys.length &&
    leftEntries.every(([key, value]) => jsonEqual(value, rightRecord[key]))
  );
}

export async function listReachDeckWorkspaceGenerationProjection(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  options: {
    nativeNarration?: boolean;
    workspace?: GenerationWorkspace;
    allowPayloadRead?: boolean;
    /** Publication checks all descriptor statuses and confirms absent queue records via audit. */
    publicationCheck?: boolean;
    materializedDocument?: ReachDeckDocument;
    /** Validated snapshot from this authorized request; never reused by writes. */
    loadedRecovery?: ReachDeckWorkspaceRecoveryResource;
  } = {},
  createQueue: () => Promise<ReachDeckGenerationQueue> = createReachDeckGenerationQueue,
): Promise<{
  jobs: ReachDeckRecoveredJobMetadata[];
  batches: ReachDeckWorkspaceBatchView[];
}> {
  const queueReader = lazyRecoveryProjectionQueue(createQueue);
  const getQueue = queueReader.get;
  try {
    let resource =
      options.loadedRecovery ?? (await loadReachDeckWorkspaceRecoveryReadSnapshot(context));
    if (!sameReachDeckResourceScope(resource, context.resourceScope)) {
      throw new Error('Reach Deck recovery snapshot scope mismatch');
    }
    if ((await reconcileLoadedDecksmithLease(context, resource, getQueue)).released) {
      resource = await loadReachDeckWorkspaceRecovery(context);
    }
    const [jobs, batches] = await Promise.all([
      projectReachDeckWorkspaceRecoveryJobs(resource, scope, runId, options, getQueue),
      projectReachDeckWorkspaceBatches(resource, scope, runId, getQueue),
    ]);
    return { jobs, batches };
  } finally {
    await queueReader.close();
  }
}

export async function listReachDeckWorkspaceBatches(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  createQueue: () => Promise<ReachDeckGenerationQueue> = createReachDeckGenerationQueue,
): Promise<ReachDeckWorkspaceBatchView[]> {
  const resource = await loadReachDeckWorkspaceRecovery(context);
  let queue: ReachDeckGenerationQueue | undefined;
  try {
    return await projectReachDeckWorkspaceBatches(resource, scope, runId, async () => {
      queue ??= await createQueue();
      return queue;
    });
  } finally {
    await queue?.close();
  }
}

async function projectReachDeckWorkspaceBatches(
  resource: ReachDeckWorkspaceRecoveryResource,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  getQueue: () => Promise<ReachDeckGenerationQueue>,
): Promise<ReachDeckWorkspaceBatchView[]> {
  const batches = Object.values(resource.recovery.batches)
    .filter((batch) => batch.runId === runId && sameReachDeckWorkspaceBatchOwner(batch, scope))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const projectedJobIds = new Set<string>();
  for (const batch of batches) {
    for (const member of batch.members) {
      const terminalOutcome =
        member.terminalOutcome ?? deriveLegacyBatchMemberTerminalOutcome(batch, member.order);
      if (
        terminalOutcome === undefined &&
        member.jobId !== undefined &&
        resource.recovery.jobs[member.jobId]?.appliedAt === undefined &&
        member.intent !== 'blocked' &&
        member.intent !== 'cancelled'
      ) {
        projectedJobIds.add(member.jobId);
      }
    }
  }
  const jobs = new Map<string, ReachDeckGenerationJobView | null>();
  if (projectedJobIds.size > 0) {
    const queue = await getQueue();
    const projectedJobs = await mapWithConcurrency([...projectedJobIds], 8, async (jobId) => ({
      jobId,
      view: await readReachDeckGenerationJobWithRecoverySnapshot(jobId, scope, {
        queue,
        recovery: resource,
      }),
    }));
    for (const projected of projectedJobs) jobs.set(projected.jobId, projected.view);
  }
  return batches.map((batch) => {
    const members = batch.members.map((member) => {
      const terminalOutcome =
        member.terminalOutcome ?? deriveLegacyBatchMemberTerminalOutcome(batch, member.order);
      if (terminalOutcome !== undefined) {
        return {
          pageId: member.pageId,
          order: member.order,
          status: terminalOutcome,
          requestedRevision: member.requestedRevision,
          done: true,
          ...(member.jobId === undefined ? {} : { jobId: member.jobId }),
          ...(member.reason === undefined ? {} : { reason: member.reason }),
          ...(member.blockedByPageId === undefined
            ? {}
            : { blockedByPageId: member.blockedByPageId }),
        };
      }
      if (
        member.jobId !== undefined &&
        resource.recovery.jobs[member.jobId]?.appliedAt !== undefined
      ) {
        return {
          pageId: member.pageId,
          order: member.order,
          status:
            member.regeneration !== undefined && batch.phase !== 'terminal'
              ? ('running' as const)
              : ('completed' as const),
          requestedRevision: member.requestedRevision,
          done: member.regeneration === undefined || batch.phase === 'terminal',
          jobId: member.jobId,
          ...(member.reason === undefined ? {} : { reason: member.reason }),
        };
      }
      if (member.intent === 'blocked' || member.intent === 'cancelled') {
        return {
          pageId: member.pageId,
          order: member.order,
          status: member.intent,
          requestedRevision: member.requestedRevision,
          done: true,
          ...(member.jobId === undefined ? {} : { jobId: member.jobId }),
          ...(member.reason === undefined ? {} : { reason: member.reason }),
          ...(member.blockedByPageId === undefined
            ? {}
            : { blockedByPageId: member.blockedByPageId }),
        };
      }
      if (member.jobId === undefined) {
        return {
          pageId: member.pageId,
          order: member.order,
          status:
            batch.cancelRequested !== undefined
              ? 'cancelling'
              : member.intent === 'waiting-predecessor'
                ? 'waiting-predecessor'
                : 'waiting-dispatch',
          requestedRevision: member.requestedRevision,
          done: false,
        };
      }
      const job = jobs.get(member.jobId) ?? null;
      if (batch.cancelRequested !== undefined) {
        return {
          pageId: member.pageId,
          order: member.order,
          status: job?.status === 'failed' ? ('failed' as const) : ('cancelling' as const),
          requestedRevision: member.requestedRevision,
          done: job?.status === 'failed',
          jobId: member.jobId,
          ...(member.reason !== undefined
            ? { reason: member.reason }
            : job?.error === undefined
              ? {}
              : { reason: job.error }),
        };
      }
      const awaitingLanding =
        job?.status === 'completed' &&
        resource.recovery.jobs[member.jobId]?.appliedAt === undefined;
      return {
        pageId: member.pageId,
        order: member.order,
        status: awaitingLanding
          ? 'running'
          : (job === null || job.status === 'recovery-required') && member.intent === 'dispatching'
            ? 'waiting-dispatch'
            : (job?.status ?? 'waiting-dispatch'),
        requestedRevision: member.requestedRevision,
        done:
          awaitingLanding ||
          (job?.status === 'recovery-required' && member.intent === 'dispatching')
            ? false
            : (job?.done ?? false),
        jobId: member.jobId,
        ...(member.reason !== undefined
          ? { reason: member.reason }
          : job?.error === undefined
            ? {}
            : { reason: job.error }),
      };
    });
    return {
      batchId: batch.batchId,
      runId: batch.runId,
      kind: batch.kind,
      status:
        batch.phase === 'terminal'
          ? batch.terminalSummary!.status
          : batch.cancelRequested !== undefined
            ? ('cancelling' as const)
            : batch.phase === 'stopped'
              ? ('stopped' as const)
              : ('active' as const),
      revision: batch.revision,
      createdAt: batch.createdAt,
      members: members.map((member, index) => ({
        ...member,
        ...reachDeckRegenerationMemberMetadata(batch.members[index]!),
      })),
      skipped: batch.skipped,
      ...(batch.terminalSummary === undefined ? {} : { terminalSummary: batch.terminalSummary }),
    };
  });
}

function deriveLegacyBatchMemberTerminalOutcome(
  batch: ReachDeckWorkspaceBatch,
  memberIndex: number,
): ReachDeckWorkspaceBatch['members'][number]['terminalOutcome'] {
  const summary = batch.phase === 'terminal' ? batch.terminalSummary : undefined;
  if (summary === undefined) return undefined;
  if (memberIndex < summary.succeeded) return 'completed';
  if (memberIndex < summary.succeeded + summary.failed) return 'failed';
  if (memberIndex < summary.succeeded + summary.failed + summary.blocked) return 'blocked';
  return 'cancelled';
}

/**
 * Native import workspaces have no generation status projection, so their materialized v2 page
 * revision is the only durable proof that a narration descriptor is still current. Keep this
 * helper deliberately conservative: when the caller cannot provide a v2 document, return all
 * descriptors and let the Teacher's document-aware projection make the same decision locally.
 */
function selectActiveStagedRecoveryJobs(
  jobs: readonly ReachDeckWorkspaceRecoveryJob[],
  options: {
    nativeNarration: boolean;
    workspace?: GenerationWorkspace;
    materializedDocument?: ReachDeckDocument;
    chainStartedAt: ReadonlyMap<string, string>;
    provenance: ReadonlyMap<string, ReachDeckJobResponseMetadata>;
  },
): ReachDeckWorkspaceRecoveryJob[] {
  if (
    (options.nativeNarration === false && options.workspace === undefined) ||
    options.materializedDocument?.schemaVersion !== 'reach-deck-document/v2'
  ) {
    return [...jobs];
  }
  const document = options.materializedDocument;
  const pages = new Map(document.pages.map((page) => [page.pageId, page]));
  const nativeBindings = new Set(document.nativeSlides.map((binding) => binding.pageId));
  const nativeCandidates = jobs.filter(
    (job) =>
      job.kind === 'narration-generation' &&
      ['materialized-native', 'materialized-interactive'].includes(
        options.provenance.get(job.jobId)?.sourceKind ?? '',
      ) &&
      job.pageId !== undefined &&
      job.requestedRevision !== undefined,
  );
  const selectedNative = new Map<string, ReachDeckWorkspaceRecoveryJob>();
  for (const job of nativeCandidates) {
    const page = pages.get(job.pageId!);
    if (
      page === undefined ||
      (!nativeBindings.has(job.pageId!) && page.sceneType !== 'interactive') ||
      job.requestedRevision !== page.revision
    ) {
      continue;
    }
    const existing = selectedNative.get(job.pageId!);
    if (
      existing === undefined ||
      compareNativeRecoveryJobs(job, existing, options.chainStartedAt) > 0
    ) {
      selectedNative.set(job.pageId!, job);
    }
  }
  return jobs.filter((job) => {
    if (job.kind !== 'narration-generation' || job.pageId === undefined) return true;
    const source = options.provenance.get(job.jobId)?.sourceKind;
    if (source !== 'materialized-native' && source !== 'materialized-interactive') return true;
    // Native narration candidates are represented by their page binding. A malformed, stale, or
    // already-applied descriptor for a removed/unbound page is intentionally omitted from the
    // active projection. Including applied descriptors in selection makes a fully applied newer
    // chain suppress any orphaned older descriptor for the same page/revision.
    const page = pages.get(job.pageId);
    const binding = document.nativeSlides.find((candidate) => candidate.pageId === job.pageId);
    if (page === undefined || (binding === undefined && page.sceneType !== 'interactive'))
      return false;
    if (job.requestedRevision === undefined) {
      // Preserve a legacy descriptor only while the materialized page still lacks narration; once
      // narration is landed, an unknown-revision failure is historical by definition.
      return page.sceneType === 'interactive'
        ? page.scene.narration === undefined
        : binding?.slide.narration === undefined;
    }
    return selectedNative.get(job.pageId) === job;
  });
}

function lazyRecoveryProjectionQueue(createQueue: () => Promise<ReachDeckGenerationQueue>) {
  let pending: Promise<ReachDeckGenerationQueue> | undefined;
  let queue: ReachDeckGenerationQueue | undefined;
  let closing = false;
  const reads = new Map<string, Promise<ReachDeckGenerationJobView | null>>();
  return {
    get: () =>
      (pending ??= createQueue().then((created) => {
        queue = created;
        if (closing) void created.close().catch(() => undefined);
        return {
          ...created,
          read: (jobId: string, scope?: ReachDeckGenerationJobScope) => {
            const key = JSON.stringify({ jobId, scope });
            let read = reads.get(key);
            if (read === undefined) {
              read = created.read(jobId, scope);
              reads.set(key, read);
            }
            return read;
          },
        };
      })),
    close: async () => {
      closing = true;
      if (queue !== undefined)
        await boundedRecoveryQueueRead(async () => {
          await queue!.close();
          return true;
        });
    },
  };
}

async function boundedRecoveryQueueRead<T>(read: () => Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function compareNativeRecoveryJobs(
  left: ReachDeckWorkspaceRecoveryJob,
  right: ReachDeckWorkspaceRecoveryJob,
  chainStartedAt: ReadonlyMap<string, string>,
): number {
  const leftChainStart =
    left.chainId === undefined
      ? left.queuedAt
      : (chainStartedAt.get(left.chainId) ?? left.queuedAt);
  const rightChainStart =
    right.chainId === undefined
      ? right.queuedAt
      : (chainStartedAt.get(right.chainId) ?? right.queuedAt);
  return (
    leftChainStart.localeCompare(rightChainStart) ||
    left.queuedAt.localeCompare(right.queuedAt) ||
    left.jobId.localeCompare(right.jobId)
  );
}

export async function readReachDeckWorkspaceRecoveryJob(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobView | null> {
  return projectReachDeckWorkspaceRecoveryJob(
    await loadReachDeckWorkspaceRecovery(scope),
    jobId,
    scope,
  );
}

async function projectReachDeckWorkspaceRecoveryJob(
  resource: ReachDeckWorkspaceRecoveryResource,
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobView | null> {
  const recovered = await scopedRecoveryJobWithAudit(resource, jobId, scope);
  if (recovered === null) return null;
  const { audit, descriptor, result } = recovered;
  if (audit?.status === 'aborted') {
    return {
      jobId,
      kind: descriptor.kind,
      status: 'cancelled',
      progress: 0,
      error: 'Generation cancelled',
      done: true,
    };
  }
  if (audit === undefined) {
    return {
      jobId,
      kind: descriptor.kind,
      status: 'recovery-required',
      progress: 0,
      error: 'Generation was registered but its queue state is unavailable',
      done: true,
    };
  }
  if (audit.status === 'failed') {
    return {
      jobId,
      kind: descriptor.kind,
      status: 'failed',
      progress: 0,
      error: `Generation failed: ${classifyReachDeckPublicFailure(audit.error?.message ?? '')}`,
      done: true,
    };
  }
  if (audit.status === 'succeeded') {
    if (result !== undefined) {
      return {
        jobId,
        kind: descriptor.kind,
        status: 'completed',
        progress: 100,
        resultAvailable: true,
        done: true,
      };
    }
    return {
      jobId,
      kind: descriptor.kind,
      status: 'recovery-required',
      progress: 100,
      error: 'Generation completed but its durable result is unavailable',
      done: true,
    };
  }
  return {
    jobId,
    kind: descriptor.kind,
    status: audit.status,
    progress: 0,
    error: 'Queue state is unavailable; server reconciliation is pending',
    done: false,
  };
}

export async function readReachDeckWorkspaceRecoveryJobDescriptor(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
  includeRegenerationPayload = false,
): Promise<
  | (ReachDeckWorkspaceRecoveryJob & { regenerationPayload?: ReachDeckStagedGenerationJobPayload })
  | null
> {
  const resource = await loadReachDeckWorkspaceRecovery(scope);
  const descriptor = scopedRecoveryJob(resource, jobId, scope)?.descriptor;
  if (!descriptor) return null;
  if (!includeRegenerationPayload) return descriptor;
  const member = Object.values(resource.recovery.batches)
    .filter((batch) => sameReachDeckWorkspaceBatchOwner(batch, scope))
    .flatMap((batch) => batch.members)
    .find((candidate) => candidate.jobId === jobId);
  return {
    ...descriptor,
    ...(member?.regeneration?.payload ? { regenerationPayload: member.regeneration.payload } : {}),
  };
}

/** 图片修改会推进页面修订与内容摘要，须先让当前修订的原生旁白完成落地。 */
export async function shouldDeferReachDeckImageForNarration(input: {
  context: ReachDeckWorkspaceContext;
  runId: string;
  pageId: string;
  revision: number;
  loadedRecovery?: ReachDeckWorkspaceRecoveryResource;
  queue?: ReachDeckGenerationQueue;
}): Promise<boolean> {
  const resource = input.loadedRecovery ?? (await loadReachDeckWorkspaceRecovery(input.context));
  const candidates = Object.values(resource.recovery.jobs).filter(
    (job) =>
      job.kind === 'narration-generation' &&
      (job.sceneType === undefined || job.sceneType === 'slide') &&
      job.runId === input.runId &&
      job.pageId === input.pageId &&
      job.requestedRevision === input.revision &&
      job.appliedAt === undefined &&
      sameReachDeckResourceScope(job.resourceScope, input.context.resourceScope),
  );
  for (const candidate of candidates) {
    try {
      // 队列身份来自原所有者；只读状态，不加载或投影协作者的结果正文。
      const view = await boundedNarrationAdmissionRead(() =>
        input.queue
          ? input.queue.read(candidate.jobId, candidate)
          : readReachDeckGenerationJob(candidate.jobId, candidate),
      );
      if (view === null && candidate.artifactRef === undefined) continue;
      if (
        view?.jobId === candidate.jobId &&
        (view.status === 'failed' || view.status === 'cancelled')
      )
        continue;
      return true;
    } catch {
      // 无法确认已终结时保留付费旁白的落地机会，下轮重新检查。
      return true;
    }
  }
  return false;
}

/**
 * 找出这一页还没终结的另一个讲稿任务。
 *
 * 用途是入队准入：同一页同时在跑两个讲稿任务时，先写回的那个会把页 revision 顶上去，
 * 后完成的那个在收尾重建载荷时必然判定作废（见 job-runner 的
 * `loadReachDeckNativeNarrationSource`）——而它此时已经把整页 TTS 与字幕对齐跑完了。
 * 教师侧看到的是一次长等待加一条笼统的生成失败，且更晚提交的那次意图被更早的覆盖。
 *
 * A missing or terminal queue record releases admission. A failed/timed-out read cannot prove
 * that another paid job has ended and produces a retryable conflict without persisting a blocker.
 */
export async function findUnfinishedReachDeckPageNarrationJob(input: {
  context: ReachDeckWorkspaceContext;
  scope: ReachDeckGenerationJobScope;
  runId: string;
  pageId: string;
  /** 本次要入队的任务；同一请求重复提交时 jobId 相同，不能把自己算成冲突。 */
  excludeJobId: string;
  /** Durable narration results waiting to land still own this exact source revision. */
  includePendingLandingRevision?: number;
  /** Native starts must also respect a page layout request already in the queue. */
  includePageGeneration?: boolean;
  /** Latest recovery read under the writer lease, paired with outside-lease queue views. */
  loadedRecovery?: ReachDeckWorkspaceRecoveryResource;
  admissionSnapshot?: ReachDeckNarrationAdmissionSnapshot;
}): Promise<string | undefined> {
  if (input.admissionSnapshot !== undefined && input.admissionSnapshot.runId !== input.runId) {
    throw new ReachDeckNarrationAdmissionReadError();
  }
  const resource = input.loadedRecovery ?? (await loadReachDeckWorkspaceRecovery(input.context));
  const candidates = Object.values(resource.recovery.jobs)
    .filter(
      (descriptor) =>
        (descriptor.kind === 'narration-generation' ||
          (input.includePageGeneration === true && descriptor.kind === 'page-generation')) &&
        descriptor.runId === input.runId &&
        descriptor.pageId === input.pageId &&
        descriptor.jobId !== input.excludeJobId &&
        (descriptor.artifactRef === undefined ||
          (descriptor.kind === 'narration-generation' &&
            input.includePendingLandingRevision !== undefined &&
            descriptor.requestedRevision === input.includePendingLandingRevision)) &&
        descriptor.appliedAt === undefined &&
        sameScope(descriptor, input.scope),
    )
    .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
  for (const candidate of candidates) {
    if (candidate.artifactRef !== undefined) return candidate.jobId;
    let view: ReachDeckGenerationJobView | null;
    if (input.admissionSnapshot !== undefined) {
      const prepared = input.admissionSnapshot.jobs.get(candidate.jobId);
      if (
        input.admissionSnapshot.runId !== input.runId ||
        prepared === undefined ||
        prepared.identity !== narrationAdmissionIdentity(candidate) ||
        prepared.view === undefined
      ) {
        throw new ReachDeckNarrationAdmissionReadError();
      }
      view = prepared.view;
    } else {
      view = await boundedNarrationAdmissionRead(() =>
        readReachDeckGenerationJob(candidate.jobId, input.scope),
      );
    }
    if (view !== null && view.jobId !== candidate.jobId)
      throw new ReachDeckNarrationAdmissionReadError();
    if (view !== null && !view.done) return candidate.jobId;
  }
  return undefined;
}

/**
 * 同一轮异步写租约判定共用的读取上下文。
 *
 * 一次判定要逐个核对 deck 上所有未落地的任务，长期使用的 deck 会积累数百条已被取代的失败任务。
 * 每个任务各自重拉整份工作区文档、各开一条 Redis 连接时，单次判定就是数百次远程往返，
 * 写入路由会因此挂起几十分钟。这里让整轮判定共用一份 recovery 快照和一条惰性创建的队列连接。
 */
export interface ReachDeckAsyncWriterInspectionReads {
  readonly recovery: ReachDeckWorkspaceRecoveryResource;
  readonly getQueue: () => Promise<ReachDeckGenerationQueue>;
}

export function openReachDeckAsyncWriterInspectionReads(
  recovery: ReachDeckWorkspaceRecoveryResource,
  createQueue: () => Promise<ReachDeckGenerationQueue> = createReachDeckGenerationQueue,
): ReachDeckAsyncWriterInspectionReads & { readonly close: () => Promise<void> } {
  const queueReader = lazyRecoveryProjectionQueue(createQueue);
  return { recovery, getQueue: queueReader.get, close: queueReader.close };
}

export async function inspectReachDeckAsyncWriterJob(
  jobId: string,
  provenanceScope: ReachDeckGenerationJobScope,
  authorizationScope: ReachDeckGenerationJobScope = provenanceScope,
  reads?: ReachDeckAsyncWriterInspectionReads,
): Promise<{
  readonly queued: ReachDeckGenerationJobView | null;
  readonly audit?: ReachDeckGenerationAuditResource;
  readonly resultStored: boolean;
} | null> {
  // Lease reconciliation is deliberately metadata-only: never project or dereference the
  // original owner's stored result body while proving that an async writer is terminal.
  const resource = reads?.recovery ?? (await loadReachDeckWorkspaceRecovery(authorizationScope));
  const descriptor = resource.recovery.jobs[jobId];
  if (descriptor === undefined || !sameScope(descriptor, provenanceScope)) return null;
  let audit: ReachDeckGenerationAuditResource | undefined;
  // Content-service's audit lookup is actor-keyed. A rotated grant/billing context for the same
  // actor can authorize the read while preserving the original audit owner projection. A different
  // actor cannot query that row, so cross-actor cleanup relies on the exact BullMQ terminal record
  // plus the server-loaded durable descriptor/result-presence proof below.
  if (authorizationScope.actorId === provenanceScope.actorId) {
    try {
      audit = await getReachDeckGenerationAudit(
        jobId,
        descriptor.requestHash,
        authorizationScope,
        provenanceScope,
      );
    } catch (error) {
      if (!(error instanceof ContentServiceClientError && error.status === 404)) throw error;
    }
  }
  if (audit !== undefined) assertAuditMatchesDescriptor(audit, descriptor);
  const queued =
    reads === undefined
      ? await readReachDeckGenerationJob(jobId, provenanceScope)
      : await (await reads.getQueue()).read(jobId, provenanceScope);
  return {
    queued,
    resultStored:
      descriptor.artifactRef !== undefined &&
      Object.prototype.hasOwnProperty.call(resource.recovery.results, descriptor.artifactRef),
    ...(audit === undefined ? {} : { audit }),
  };
}

export async function readReachDeckGenerationJobWithRecovery(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobView | null> {
  let resource: ReachDeckWorkspaceRecoveryResource | undefined;
  return readReachDeckGenerationJobWithRecoveryUsing(
    jobId,
    scope,
    {
      read: readReachDeckGenerationJob,
      readWithPayload: readReachDeckGenerationJobWithPayload,
    },
    async () => (resource ??= await loadReachDeckWorkspaceRecoveryReadSnapshot(scope)),
  );
}

/** Projects a job through caller-owned Queue and recovery resources without closing either. */
export async function readReachDeckGenerationJobWithRecoverySnapshot(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
  input: {
    queue: ReachDeckGenerationQueue;
    recovery: ReachDeckWorkspaceRecoveryResource;
  },
): Promise<ReachDeckGenerationJobView | null> {
  return readReachDeckGenerationJobWithRecoveryUsing(
    jobId,
    scope,
    input.queue,
    async () => input.recovery,
  );
}

async function readReachDeckGenerationJobWithRecoveryUsing(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
  queue: Pick<ReachDeckGenerationQueue, 'read' | 'readWithPayload'>,
  loadRecovery: () => Promise<ReachDeckWorkspaceRecoveryResource>,
): Promise<ReachDeckGenerationJobView | null> {
  let queued: ReachDeckGenerationJobView | null = null;
  let queueError: unknown;
  try {
    queued = await queue.read(jobId, scope);
  } catch (error) {
    queueError = error;
  }
  // Legacy document-generation jobs predate staged workspace recovery and are
  // intentionally represented only by BullMQ. Do not turn a valid legacy job
  // into a recovery lookup failure merely because it has no staged descriptor.
  if (queued !== null && queued.kind === undefined) return queued;
  const recovery = await loadRecovery();
  let recoveredDecksmith: ReachDeckGenerationJobView | null = null;
  if (queued === null || queued.kind === 'decksmith') {
    try {
      recoveredDecksmith = await projectReachDeckWorkspaceRecoveryDecksmithJob(
        recovery,
        jobId,
        scope,
      );
    } catch (error) {
      if (queued?.kind === 'decksmith' && isRetryableContentServiceFailure(error)) return queued;
      throw error;
    }
  }
  if (recoveredDecksmith !== null) {
    if (
      queued !== null &&
      (queued.status === 'failed' || queued.status === 'cancelled') &&
      !recoveredDecksmith.done
    ) {
      // A nonterminal recovery projection (including registered-without-audit) cannot hide a
      // durable BullMQ terminal. Successful/rejected Decksmith outcomes remain authoritative.
      return queued;
    }
    if (recoveredDecksmith.done || queued === null || queued.done) return recoveredDecksmith;
    return queued?.kind === 'decksmith' ? queued : recoveredDecksmith;
  }
  if (queued?.kind === 'decksmith') return queued;
  const recovered = await projectReachDeckWorkspaceRecoveryJob(recovery, jobId, scope);
  if (recovered !== null) {
    // A BullMQ failed/cancelled record is authoritative even when the audit projection was
    // deleted or never created. Do not replace a durable terminal queue result with the synthetic
    // recovery-required state; otherwise clients keep polling a job that cannot recover.
    if (
      queued !== null &&
      (queued.status === 'failed' || queued.status === 'cancelled') &&
      (recovered.status === 'failed' ||
        recovered.status === 'cancelled' ||
        recovered.status === 'recovery-required')
    ) {
      return queued;
    }
    if (
      recovered.status === 'recovery-required' &&
      queued?.status === 'completed' &&
      queued.resultAvailable === true &&
      (await backfillCompletedQueueResult(jobId, scope, queue))
    ) {
      return (
        (await projectReachDeckWorkspaceRecoveryJob(
          await loadReachDeckWorkspaceRecovery(scope),
          jobId,
          scope,
        )) ?? recovered
      );
    }
    if (
      queued?.status === 'completed' &&
      (recovered.status === 'recovery-required' || !recovered.done)
    ) {
      // 成功审计可能未写入；队列终局与当前作用域的耐久结果共同证明任务已完成。
      if (scopedRecoveryJob(recovery, jobId, scope)?.result !== undefined) {
        return {
          jobId,
          kind: recovered.kind,
          status: 'completed',
          progress: 100,
          resultAvailable: true,
          done: true,
        };
      }
      // 队列已经完成即证明付费工作结束；存储回填失败也不能退回可重新派发的登记态。
      return {
        ...recovered,
        status: 'recovery-required',
        progress: 100,
        resultAvailable: false,
        done: true,
        error: 'Generation completed but its durable result is unavailable',
      };
    }
    if (recovered.done || queued === null) return recovered;
    // 队列已终局(失败/取消)而审计仍停在进行中:worker 在写审计终局前崩溃或抛出
    // 不可恢复错误(如 UnrecoverableError)。此时以队列的终局状态为准,否则任务
    // 视图会永远停在"进行中"——前端既等不到结果,取消又因任务已终局而 409。
    return queued;
  }
  if (queued !== null) return queued;
  if (queueError !== undefined) throw queueError;
  return null;
}

export async function readReachDeckWorkspaceRecoveryResult(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckStagedGenerationResult | null> {
  const recovered = await loadScopedRecoveryJobWithAudit(jobId, scope);
  if (recovered?.audit?.status !== 'succeeded' || recovered.result === undefined) return null;
  return recovered.result.result;
}

export async function readReachDeckGenerationResultWithRecovery(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckStagedGenerationResult | null> {
  const recovered = await loadScopedRecoveryJobWithAudit(jobId, scope);
  if (recovered?.audit?.status !== 'succeeded') return null;
  if (recovered.result !== undefined) return recovered.result.result;
  const stored = await readReachDeckGenerationJobWithPayload(jobId, scope);
  if (
    stored?.payload === undefined ||
    stored.view.status !== 'completed' ||
    stored.result === undefined
  ) {
    return null;
  }
  const payload = parseReachDeckStagedGenerationJobPayload(stored.payload);
  const result = parseCompletedStagedResult(
    stored.result,
    stagedResultProvenanceFromPayload(payload),
  );
  try {
    await storeReachDeckWorkspaceJobResult(payload, result);
  } catch (error) {
    console.error('Reach Deck result preview recovery backfill failed', error);
    return null;
  }
  return result;
}

async function backfillCompletedQueueResult(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
  queue: Pick<ReachDeckGenerationQueue, 'readWithPayload'>,
): Promise<boolean> {
  try {
    const recovered = await loadScopedRecoveryJobWithAudit(jobId, scope);
    if (recovered?.audit?.status !== 'succeeded') return false;
    const stored = await queue.readWithPayload(jobId, scope);
    if (
      stored?.payload === undefined ||
      stored.view.status !== 'completed' ||
      stored.result === undefined
    ) {
      return false;
    }
    const payload = parseReachDeckStagedGenerationJobPayload(stored.payload);
    const result = parseCompletedStagedResult(
      stored.result,
      stagedResultProvenanceFromPayload(payload),
    );
    await storeReachDeckWorkspaceJobResult(payload, result);
    return true;
  } catch (error) {
    console.error('Reach Deck completed queue result recovery backfill failed', error);
    return false;
  }
}

export function parseReachDeckWorkspaceRecovery(value: unknown): ReachDeckWorkspaceRecoveryState {
  const raw = recordValue(value, 'recovery state');
  const isV1 = raw.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_V1_SCHEMA_VERSION;
  const isV2 = raw.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_V2_SCHEMA_VERSION;
  const isV3 = raw.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_V3_SCHEMA_VERSION;
  const isV4 = raw.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_SCHEMA_VERSION;
  const isV5 = raw.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_V5_SCHEMA_VERSION;
  if (!isV1 && !isV2 && !isV3 && !isV4 && !isV5) {
    throw new Error('Reach Deck recovery schemaVersion is invalid');
  }
  const required = isV1
    ? ['schemaVersion', 'jobs', 'results']
    : isV2
      ? ['schemaVersion', 'jobs', 'results', 'decksmithJobs', 'decksmithResults']
      : [
          'schemaVersion',
          'jobs',
          'results',
          'decksmithJobs',
          'decksmithResults',
          'ttsContinuations',
        ];
  // Compatibility readers expose one normalized in-memory shape, while persistence below emits
  // only the fields native to the record's version. `batches` is intentionally optional on every
  // supported version so a mixed reader never strips a v5 payload or rejects a compatibility
  // record solely because its version marker has not yet been promoted.
  const recovery = exactRecord(value, required, 'recovery state', [
    ...(required.includes('decksmithJobs') ? [] : ['decksmithJobs', 'decksmithResults']),
    ...(required.includes('ttsContinuations') ? [] : ['ttsContinuations']),
    'batches',
    'batchRequests',
    'structuralMutations',
    'structuralJobTombstones',
    'mediaCheckpoints',
    'importGenerationIntents',
    'deletedPageRetirements',
  ]);
  const rawJobs = recordValue(recovery.jobs, 'recovery jobs');
  const rawResults = recordValue(recovery.results, 'recovery results');
  const jobs = Object.fromEntries(
    Object.entries(rawJobs).map(([jobId, job]) => {
      const parsed = parseRecoveryJob(job, isV1 || isV2 || isV3);
      if (parsed.jobId !== jobId) throw new Error('Reach Deck recovery job map key is invalid');
      return [jobId, parsed];
    }),
  );
  const results = Object.fromEntries(
    Object.entries(rawResults).map(([reference, result]) => {
      const parsed = parseRecoveryResult(result, jobs);
      if (artifactReference(parsed.jobId) !== reference) {
        throw new Error('Reach Deck recovery result map key is invalid');
      }
      return [reference, parsed];
    }),
  );
  for (const descriptor of Object.values(jobs)) {
    if (descriptor.artifactRef !== undefined && results[descriptor.artifactRef] === undefined) {
      throw new Error('Reach Deck recovery artifact reference does not resolve');
    }
  }
  const decksmithJobs =
    recovery.decksmithJobs === undefined
      ? {}
      : parseDecksmithRecoveryJobs(recordValue(recovery.decksmithJobs, 'Decksmith recovery jobs'));
  const decksmithResults =
    recovery.decksmithResults === undefined
      ? {}
      : parseDecksmithRecoveryResults(
          recordValue(recovery.decksmithResults, 'Decksmith recovery results'),
          decksmithJobs,
        );
  const ttsContinuations =
    recovery.ttsContinuations === undefined
      ? {}
      : parseTtsContinuations(recordValue(recovery.ttsContinuations, 'TTS continuations'), jobs);
  const batches =
    recovery.batches === undefined ? {} : parseReachDeckWorkspaceBatches(recovery.batches);
  const batchRequests =
    recovery.batchRequests === undefined
      ? {}
      : parseReachDeckWorkspaceBatchRequests(recovery.batchRequests);
  const structuralMutations =
    recovery.structuralMutations === undefined
      ? {}
      : parseReachDeckWorkspaceStructuralMutations(recovery.structuralMutations);
  const structuralJobTombstones =
    recovery.structuralJobTombstones === undefined
      ? {}
      : parseReachDeckWorkspaceStructuralJobTombstones(recovery.structuralJobTombstones);
  const parsed: ReachDeckWorkspaceRecoveryState = {
    schemaVersion: recovery.schemaVersion as ReachDeckWorkspaceRecoverySchemaVersion,
    jobs,
    results,
    decksmithJobs,
    decksmithResults,
    ttsContinuations,
    batches,
    batchRequests,
    structuralMutations,
    structuralJobTombstones,
    mediaCheckpoints: parseReachDeckMediaCheckpoints(recovery.mediaCheckpoints ?? {}),
    importGenerationIntents: parseReachDeckImportGenerationIntents(
      recovery.importGenerationIntents ?? {},
    ),
  };
  const deletedPageRetirements = parseReachDeckDeletedPageRetirements(
    recovery.deletedPageRetirements ?? {},
  );
  // 只在有记录时挂上字段，旧数据与没有删除的工作区解析结果保持不变。
  if (Object.keys(deletedPageRetirements).length > 0) {
    parsed.deletedPageRetirements = deletedPageRetirements;
  }
  if (jsonByteLength(parsed) > MAX_RECOVERY_STATE_BYTES) {
    throw new Error('Reach Deck recovery state exceeds the storage size limit');
  }
  return parsed;
}

/**
 * recovery 文档的 CAS 冲突预算。
 *
 * 内容服务侧 `compareAndSetRecovery` 是整文档替换 + `recoveryRevision` 递增，而文档按
 * 工作区归一：同一 run 的所有页、所有分块、批次协调器和 API 进程写的都是同一份。
 * 原先「3 次、无退避、立刻重载重试」在几十个写者下就是惊群，冲突必然逃逸出去。
 */
const MAX_RECOVERY_CAS_CONFLICTS = 8;
const RECOVERY_CAS_BACKOFF_BASE_MS = 50;
const RECOVERY_CAS_BACKOFF_CAP_MS = 1_000;

/** 满抖动指数退避：同时撞上的写者会被打散到不同时刻，而不是整齐地再撞一次。 */
function recoveryCasBackoffMillis(conflicts: number): number {
  const ceiling = Math.min(
    RECOVERY_CAS_BACKOFF_CAP_MS,
    RECOVERY_CAS_BACKOFF_BASE_MS * 2 ** Math.max(0, conflicts - 1),
  );
  return Math.floor(Math.random() * ceiling);
}

/** 进程内串行化的分区键：recovery 文档本身就是按这三个字段归一的。 */
function recoverySerializationKey(context: ReachDeckWorkspaceContext): string {
  const scope = context.resourceScope;
  return `${scope.organizationId}|${scope.moduleId}|${scope.moduleVersionId}`;
}

async function transitionReachDeckWorkspaceRecovery(
  context: ReachDeckWorkspaceContext,
  transition: (state: ReachDeckWorkspaceRecoveryState) => ReachDeckWorkspaceRecoveryState,
  maxConflicts = MAX_RECOVERY_CAS_CONFLICTS,
): Promise<ReachDeckWorkspaceRecoveryResource> {
  // 进程内先串行（消掉分块并发与 job 并发的自我争用），跨进程再靠下面的退避重试。
  // transition 回调都是同步纯函数，不会在持锁期间重入本函数。
  return runSerializedByKey(recoverySerializationKey(context), async () => {
    let current = await loadReachDeckWorkspaceRecovery(context);
    let conflicts = 0;
    while (true) {
      const input = structuredClone(current.recovery);
      const candidate = parseReachDeckWorkspaceRecovery(transition(input));
      assertStructuralJobTombstoneReservationCapacity(candidate);
      if (valuesEqual(candidate, current.recovery)) return current;
      const persisted = serializeReachDeckWorkspaceRecovery(candidate);
      assertRecoveryStorageBudgets(persisted, current.workspaceBytes);
      const reservedRecoveryBytes =
        jsonByteLength(persisted) +
        reachDeckMediaCheckpointReservedBytes(candidate.mediaCheckpoints);
      if (
        reservedRecoveryBytes > MAX_RECOVERY_STATE_BYTES ||
        reservedRecoveryBytes +
          current.workspaceBytes +
          CONSERVATIVE_MONGO_DOCUMENT_OVERHEAD_BYTES >
          MAX_REACH_DECK_MONGO_WORKSPACE_DOCUMENT_BYTES
      ) {
        throw new ReachDeckMediaCheckpointBudgetError();
      }
      try {
        const saved = await putReachDeckWorkspaceRecovery(
          persisted,
          current.recoveryRevision,
          context,
        );
        if (saved.recoveryRevision !== current.recoveryRevision + 1) {
          throw new Error('content-service returned a non-contiguous recovery revision');
        }
        return {
          ...context.resourceScope,
          recoveryRevision: saved.recoveryRevision,
          recovery: parseReachDeckWorkspaceRecovery(saved.recovery),
          workspaceBytes: jsonByteLength(saved.workspace),
        };
      } catch (error) {
        if (
          !(error instanceof ContentServiceClientError && error.status === 409) ||
          conflicts >= maxConflicts
        ) {
          throw error;
        }
        conflicts += 1;
        await delay(recoveryCasBackoffMillis(conflicts));
        current = await loadReachDeckWorkspaceRecovery(context);
      }
    }
  });
}

function delay(millis: number): Promise<void> {
  if (millis <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, millis));
}

export function serializeReachDeckWorkspaceRecovery(
  stateValue: ReachDeckWorkspaceRecoveryState,
): Record<string, unknown> {
  const state = parseReachDeckWorkspaceRecovery(stateValue);
  const base = {
    schemaVersion: state.schemaVersion,
    ...(Object.keys(state.importGenerationIntents ?? {}).length === 0
      ? {}
      : { importGenerationIntents: state.importGenerationIntents }),
    ...(Object.keys(state.deletedPageRetirements ?? {}).length === 0
      ? {}
      : { deletedPageRetirements: state.deletedPageRetirements }),
    jobs:
      state.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_SCHEMA_VERSION ||
      state.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_V5_SCHEMA_VERSION
        ? state.jobs
        : Object.fromEntries(
            Object.entries(state.jobs).map(([jobId, descriptor]) => {
              const {
                voiceSelection: _voiceSelection,
                voiceDigest: _voiceDigest,
                ...legacyDescriptor
              } = descriptor;
              return [jobId, legacyDescriptor];
            }),
          ),
    results: state.results,
  } satisfies Record<string, unknown>;
  const withDecksmith =
    state.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_V1_SCHEMA_VERSION
      ? base
      : {
          ...base,
          decksmithJobs: state.decksmithJobs,
          decksmithResults: state.decksmithResults,
        };
  const withTts =
    state.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_V1_SCHEMA_VERSION ||
    state.schemaVersion === REACH_DECK_WORKSPACE_RECOVERY_V2_SCHEMA_VERSION
      ? withDecksmith
      : { ...withDecksmith, ttsContinuations: state.ttsContinuations };
  const withBatches =
    Object.keys(state.batches).length === 0 ? withTts : { ...withTts, batches: state.batches };
  const withBatchRequests =
    Object.keys(state.batchRequests).length === 0
      ? withBatches
      : { ...withBatches, batchRequests: state.batchRequests };
  const withStructuralMutations =
    Object.keys(state.structuralMutations).length === 0
      ? withBatchRequests
      : { ...withBatchRequests, structuralMutations: state.structuralMutations };
  const withStructuralJobTombstones =
    Object.keys(state.structuralJobTombstones).length === 0
      ? withStructuralMutations
      : { ...withStructuralMutations, structuralJobTombstones: state.structuralJobTombstones };
  return Object.keys(state.mediaCheckpoints).length === 0
    ? withStructuralJobTombstones
    : { ...withStructuralJobTombstones, mediaCheckpoints: state.mediaCheckpoints };
}

function parseReachDeckWorkspaceStructuralMutations(
  value: unknown,
): ReachDeckWorkspaceStructuralMutations {
  const mutations = recordValue(value, 'workspace structural mutations');
  return Object.fromEntries(
    Object.entries(mutations).map(([runId, candidate]) => {
      const raw = exactRecord(
        candidate,
        ['schemaVersion', 'runId', 'owner', 'phase', 'fencedAt', 'batchIds'],
        'workspace structural mutation',
        ['preservedJobIds'],
      );
      if (
        raw.schemaVersion !== REACH_DECK_WORKSPACE_STRUCTURAL_MUTATION_SCHEMA_VERSION ||
        raw.phase !== 'pending-cleanup'
      ) {
        throw new Error('Reach Deck workspace structural mutation contract is invalid');
      }
      const parsedRunId = requireString(raw.runId, 'structural mutation runId', 100);
      if (parsedRunId !== runId) {
        throw new Error('Reach Deck workspace structural mutation map key is invalid');
      }
      const owner = exactRecord(
        raw.owner,
        ['actorId', 'billingGroupId', 'roleGrantId', 'resourceScope'],
        'workspace structural mutation owner',
        ['actorOrganizationId'],
      );
      const resourceScope = parseReachDeckResourceScope(owner.resourceScope);
      if (!Array.isArray(raw.batchIds)) {
        throw new Error('Reach Deck workspace structural mutation batchIds are invalid');
      }
      const batchIds = raw.batchIds.map((batchId) => canonicalUuid(batchId, 'batchId'));
      if (new Set(batchIds).size !== batchIds.length) {
        throw new Error('Reach Deck workspace structural mutation batchIds must be unique');
      }
      const preservedJobIds =
        raw.preservedJobIds === undefined
          ? undefined
          : (() => {
              if (
                !Array.isArray(raw.preservedJobIds) ||
                raw.preservedJobIds.length > MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES
              )
                throw new Error('Reach Deck structural preserved job IDs are invalid');
              const ids = raw.preservedJobIds.map((value) =>
                requireString(value, 'preserved jobId', 255),
              );
              if (new Set(ids).size !== ids.length)
                throw new Error('Reach Deck structural preserved job IDs must be unique');
              return ids;
            })();
      return [
        runId,
        {
          schemaVersion: REACH_DECK_WORKSPACE_STRUCTURAL_MUTATION_SCHEMA_VERSION,
          runId,
          owner: {
            actorId: requireString(owner.actorId, 'structural mutation actorId', 255),
            actorOrganizationId: actorOrganizationIdFromPayload({
              actorOrganizationId: owner.actorOrganizationId,
              resourceScope,
            }),
            billingGroupId:
              owner.billingGroupId === null
                ? null
                : requireString(owner.billingGroupId, 'structural mutation billingGroupId', 255),
            roleGrantId: requireString(owner.roleGrantId, 'structural mutation roleGrantId', 255),
            resourceScope,
          },
          phase: 'pending-cleanup' as const,
          fencedAt: requireTimestamp(raw.fencedAt, 'structural mutation fencedAt'),
          batchIds,
          ...(preservedJobIds === undefined ? {} : { preservedJobIds }),
        },
      ];
    }),
  );
}

function parseReachDeckWorkspaceStructuralJobTombstones(
  value: unknown,
): ReachDeckWorkspaceStructuralJobTombstones {
  const tombstones = recordValue(value, 'workspace structural job tombstones');
  const parsed = Object.fromEntries(
    Object.entries(tombstones).map(([jobId, candidate]) => {
      const raw = exactRecord(
        candidate,
        [
          'schemaVersion',
          'jobId',
          'runId',
          'owner',
          'pageId',
          'requestedRevision',
          'attempt',
          'requestHash',
          'cancelledAt',
          'reason',
        ],
        'workspace structural job tombstone',
      );
      if (
        raw.schemaVersion !== REACH_DECK_WORKSPACE_STRUCTURAL_JOB_TOMBSTONE_SCHEMA_VERSION ||
        raw.reason !== 'structural-mutation'
      ) {
        throw new Error('Reach Deck workspace structural job tombstone contract is invalid');
      }
      const parsedJobId = requireString(raw.jobId, 'structural job tombstone jobId', 128);
      if (parsedJobId !== jobId) {
        throw new Error('Reach Deck workspace structural job tombstone map key is invalid');
      }
      const owner = exactRecord(
        raw.owner,
        ['actorId', 'billingGroupId', 'roleGrantId', 'resourceScope'],
        'workspace structural job tombstone owner',
        ['actorOrganizationId'],
      );
      const resourceScope = parseReachDeckResourceScope(owner.resourceScope);
      return [
        jobId,
        {
          schemaVersion: REACH_DECK_WORKSPACE_STRUCTURAL_JOB_TOMBSTONE_SCHEMA_VERSION,
          jobId,
          runId: requireString(raw.runId, 'structural job tombstone runId', 100),
          owner: {
            actorId: requireString(owner.actorId, 'structural job tombstone actorId', 255),
            actorOrganizationId: actorOrganizationIdFromPayload({
              actorOrganizationId: owner.actorOrganizationId,
              resourceScope,
            }),
            billingGroupId:
              owner.billingGroupId === null
                ? null
                : requireString(
                    owner.billingGroupId,
                    'structural job tombstone billingGroupId',
                    255,
                  ),
            roleGrantId: requireString(
              owner.roleGrantId,
              'structural job tombstone roleGrantId',
              255,
            ),
            resourceScope,
          },
          pageId: requireString(raw.pageId, 'structural job tombstone pageId', 256),
          requestedRevision: requirePositiveInteger(
            raw.requestedRevision,
            'structural job tombstone requestedRevision',
          ),
          attempt: requirePositiveInteger(raw.attempt, 'structural job tombstone attempt'),
          requestHash: requireHash(raw.requestHash, 'structural job tombstone requestHash'),
          cancelledAt: requireTimestamp(raw.cancelledAt, 'structural job tombstone cancelledAt'),
          reason: 'structural-mutation' as const,
        },
      ];
    }),
  );
  assertStructuralJobTombstoneCapacity(parsed);
  return parsed;
}

function assertStructuralJobTombstoneCapacity(
  tombstones: ReachDeckWorkspaceStructuralJobTombstones,
): void {
  if (Object.keys(tombstones).length > MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES) {
    throw new ReachDeckStructuralJobTombstoneCapacityError(
      'Reach Deck structural cancellation tombstone capacity exceeded',
    );
  }
}

function assertStructuralJobTombstoneReservationCapacity(
  state: ReachDeckWorkspaceRecoveryState,
): void {
  const reservedJobIds = new Set(Object.keys(state.structuralJobTombstones));
  for (const descriptor of Object.values(state.jobs)) {
    if (descriptor.kind === 'narration-generation') reservedJobIds.add(descriptor.jobId);
  }
  let unassignedBatchMembers = 0;
  for (const batch of Object.values(state.batches)) {
    if (batch.phase === 'terminal' || batch.phase === 'stopped') continue;
    for (const member of batch.members) {
      if (member.terminalOutcome !== undefined || member.intent === 'cancelled') continue;
      if (member.jobId === undefined) unassignedBatchMembers += 1;
      else reservedJobIds.add(member.jobId);
    }
  }
  if (reservedJobIds.size + unassignedBatchMembers > MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES) {
    throw new ReachDeckStructuralJobTombstoneCapacityError(
      'Reach Deck structural cancellation capacity is fully reserved',
    );
  }
}

function assertSameStructuralJobTombstone(
  existing: ReachDeckWorkspaceStructuralJobTombstone,
  candidate: ReachDeckWorkspaceStructuralJobTombstone,
): void {
  if (
    existing.jobId !== candidate.jobId ||
    existing.runId !== candidate.runId ||
    !sameReachDeckWorkspaceBatchOwner({ owner: existing.owner }, candidate.owner) ||
    existing.pageId !== candidate.pageId ||
    existing.requestedRevision !== candidate.requestedRevision ||
    existing.attempt !== candidate.attempt ||
    existing.requestHash !== candidate.requestHash ||
    existing.reason !== candidate.reason
  ) {
    throw new Error('Reach Deck structural cancellation tombstone identity collides');
  }
}

function sameStructuralJobTombstone(
  left: ReachDeckWorkspaceStructuralJobTombstone,
  right: ReachDeckWorkspaceStructuralJobTombstone,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.jobId === right.jobId &&
    left.runId === right.runId &&
    sameReachDeckWorkspaceBatchOwner({ owner: left.owner }, right.owner) &&
    left.pageId === right.pageId &&
    left.requestedRevision === right.requestedRevision &&
    left.attempt === right.attempt &&
    left.requestHash === right.requestHash &&
    left.cancelledAt === right.cancelledAt &&
    left.reason === right.reason
  );
}

function assertStructuralJobDescriptorMatchesBatchMember(
  descriptor: ReachDeckWorkspaceRecoveryJob,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatch['members'][number],
): void {
  if (
    descriptor.runId !== batch.runId ||
    !sameReachDeckWorkspaceBatchOwner(
      {
        owner: {
          actorId: descriptor.actorId,
          actorOrganizationId: actorOrganizationIdFromPayload(descriptor),
          billingGroupId: descriptor.billingGroupId,
          roleGrantId: descriptor.roleGrantId,
          resourceScope: descriptor.resourceScope,
        },
      },
      batch.owner,
    ) ||
    descriptor.pageId !== member.pageId ||
    descriptor.requestedRevision !== member.requestedRevision ||
    descriptor.generationAttempt !== String(member.attempt)
  ) {
    throw new Error('Reach Deck structural cleanup batch job identity is invalid');
  }
}

function assertStructuralJobTombstoneMatchesBatchMember(
  tombstone: ReachDeckWorkspaceStructuralJobTombstone,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatch['members'][number],
): void {
  if (
    tombstone.runId !== batch.runId ||
    !sameReachDeckWorkspaceBatchOwner({ owner: tombstone.owner }, batch.owner) ||
    tombstone.pageId !== member.pageId ||
    tombstone.requestedRevision !== member.requestedRevision ||
    tombstone.attempt !== member.attempt
  ) {
    throw new Error('Reach Deck structural cleanup batch tombstone identity is invalid');
  }
}

function assertRecoveryStorageBudgets(
  persistedRecovery: Record<string, unknown>,
  workspaceBytes: number,
): void {
  const recoveryBytes = jsonByteLength(persistedRecovery);
  if (recoveryBytes > MAX_RECOVERY_STATE_BYTES) {
    throw new Error('Reach Deck recovery state exceeds the storage size limit');
  }
  if (
    workspaceBytes + recoveryBytes + CONSERVATIVE_MONGO_DOCUMENT_OVERHEAD_BYTES >
    MAX_REACH_DECK_MONGO_WORKSPACE_DOCUMENT_BYTES
  ) {
    throw new Error('Reach Deck workspace document exceeds the conservative Mongo size limit');
  }
}

function promoteRecoveryForStagedJob(
  version: ReachDeckWorkspaceRecoverySchemaVersion,
): ReachDeckWorkspaceRecoverySchemaVersion {
  return version === REACH_DECK_WORKSPACE_RECOVERY_V1_SCHEMA_VERSION ||
    version === REACH_DECK_WORKSPACE_RECOVERY_V2_SCHEMA_VERSION ||
    version === REACH_DECK_WORKSPACE_RECOVERY_V3_SCHEMA_VERSION
    ? REACH_DECK_WORKSPACE_RECOVERY_SCHEMA_VERSION
    : version;
}

function promoteRecoveryForDecksmith(
  version: ReachDeckWorkspaceRecoverySchemaVersion,
): ReachDeckWorkspaceRecoverySchemaVersion {
  return version === REACH_DECK_WORKSPACE_RECOVERY_V1_SCHEMA_VERSION
    ? REACH_DECK_WORKSPACE_RECOVERY_V2_SCHEMA_VERSION
    : version;
}

function promoteRecoveryForTts(
  version: ReachDeckWorkspaceRecoverySchemaVersion,
): ReachDeckWorkspaceRecoverySchemaVersion {
  return version === REACH_DECK_WORKSPACE_RECOVERY_V1_SCHEMA_VERSION ||
    version === REACH_DECK_WORKSPACE_RECOVERY_V2_SCHEMA_VERSION
    ? REACH_DECK_WORKSPACE_RECOVERY_V3_SCHEMA_VERSION
    : version;
}

export function estimateReachDeckMongoWorkspaceDocumentBytes(
  workspaceValue: unknown,
  persistedRecovery: Record<string, unknown>,
): number {
  return (
    jsonByteLength(workspaceValue) +
    jsonByteLength(persistedRecovery) +
    CONSERVATIVE_MONGO_DOCUMENT_OVERHEAD_BYTES
  );
}

export function assertReachDeckMongoWorkspaceDocumentBudget(
  workspaceValue: unknown,
  persistedRecovery: Record<string, unknown>,
): void {
  assertRecoveryStorageBudgets(persistedRecovery, jsonByteLength(workspaceValue));
}

async function loadScopedRecoveryJob(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<{
  descriptor: ReachDeckWorkspaceRecoveryJob;
  result?: ReachDeckWorkspaceRecoveryResult;
} | null> {
  return scopedRecoveryJob(await loadReachDeckWorkspaceRecovery(scope), jobId, scope);
}

function scopedRecoveryJob(
  resource: ReachDeckWorkspaceRecoveryResource,
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): {
  descriptor: ReachDeckWorkspaceRecoveryJob;
  result?: ReachDeckWorkspaceRecoveryResult;
} | null {
  const descriptor = resource.recovery.jobs[jobId];
  if (descriptor === undefined || !sameScope(descriptor, scope)) return null;
  const result =
    descriptor.artifactRef === undefined
      ? undefined
      : resource.recovery.results[descriptor.artifactRef];
  return { descriptor, ...(result === undefined ? {} : { result }) };
}

async function scopedDecksmithRecoveryJobWithAudit(
  resource: ReachDeckWorkspaceRecoveryResource,
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<{
  audit?: ReachDeckGenerationAuditResource;
  descriptor: ReachDeckWorkspaceRecoveryDecksmithJob;
  result?: ReachDeckWorkspaceRecoveryDecksmithResult;
} | null> {
  const descriptor = resource.recovery.decksmithJobs[jobId];
  if (descriptor === undefined || !sameDecksmithScope(descriptor, scope)) return null;
  const result =
    descriptor.resultRef === undefined
      ? undefined
      : resource.recovery.decksmithResults[descriptor.resultRef];
  if (result !== undefined && (await resolveDecksmithPublicResult(descriptor, result)) !== null) {
    return { descriptor, result };
  }
  let audit: ReachDeckGenerationAuditResource | undefined;
  try {
    audit = await getReachDeckGenerationAudit(jobId, descriptor.requestHash, scope);
  } catch (error) {
    if (!(error instanceof ContentServiceClientError && error.status === 404)) throw error;
  }
  if (audit !== undefined) assertAuditMatchesDescriptor(audit, descriptor);
  return {
    descriptor,
    ...(result === undefined ? {} : { result }),
    ...(audit === undefined ? {} : { audit }),
  };
}
async function loadScopedRecoveryJobWithAudit(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<{
  audit?: ReachDeckGenerationAuditResource;
  descriptor: ReachDeckWorkspaceRecoveryJob;
  result?: ReachDeckWorkspaceRecoveryResult;
} | null> {
  return scopedRecoveryJobWithAudit(await loadReachDeckWorkspaceRecovery(scope), jobId, scope);
}

async function scopedRecoveryJobWithAudit(
  resource: ReachDeckWorkspaceRecoveryResource,
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<{
  audit?: ReachDeckGenerationAuditResource;
  descriptor: ReachDeckWorkspaceRecoveryJob;
  result?: ReachDeckWorkspaceRecoveryResult;
} | null> {
  const recovered = scopedRecoveryJob(resource, jobId, scope);
  if (recovered === null) return null;
  let audit: ReachDeckGenerationAuditResource | undefined;
  try {
    audit = await getReachDeckGenerationAudit(jobId, recovered.descriptor.requestHash, scope);
  } catch (error) {
    if (!(error instanceof ContentServiceClientError && error.status === 404)) throw error;
  }
  if (audit !== undefined) assertAuditMatchesDescriptor(audit, recovered.descriptor);
  return { ...recovered, ...(audit === undefined ? {} : { audit }) };
}

function descriptorFromPayload(
  payload: ReachDeckStagedGenerationJobPayload,
): ReachDeckWorkspaceRecoveryJob {
  const provenance = stagedResultProvenanceFromPayload(payload);
  return {
    ...(payload.scientificContextSnapshot === undefined
      ? {}
      : { scientificContextSourceHash: stagedScientificSourceRequestHash(payload) }),
    jobId: payload.jobId,
    kind: payload.kind,
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: parseReachDeckResourceScope(payload.resourceScope),
    runId: payload.runId,
    createdFromDraftRevision: payload.createdFromDraftRevision,
    requestHash: payload.requestHash,
    voiceSelection: parseReachDeckVoiceSelection(payload.voiceSelection),
    voiceDigest: reachDeckVoiceSelectionDigest(payload.voiceSelection),
    generationStage: generationStage(payload),
    generationAttempt: provenance.attempt === undefined ? 'initial' : String(provenance.attempt),
    queuedAt: new Date().toISOString(),
    ...(provenance.pageId === undefined ? {} : { pageId: provenance.pageId }),
    ...(provenance.requestedRevision === undefined
      ? {}
      : { requestedRevision: provenance.requestedRevision }),
    ...(payload.kind === 'page-generation' &&
    reachDeckJobResponseMetadata(payload).affectedLanes?.includes('image')
      ? { affectedLanes: ['image'] as ['image'] }
      : {}),
    ...(payload.kind === 'narration-generation' && provenance.sceneType !== undefined
      ? { sceneType: provenance.sceneType }
      : {}),
    ...(payload.kind === 'narration-generation' &&
    payload.request.sourceKind === 'materialized-native' &&
    payload.request.chainId !== undefined
      ? { chainId: payload.request.chainId }
      : {}),
  };
}

function decksmithDescriptorFromPayload(
  payload: ReachDeckDecksmithJobPayload,
): ReachDeckWorkspaceRecoveryDecksmithJob {
  return {
    jobId: payload.jobId,
    kind: 'decksmith',
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: parseReachDeckResourceScope(payload.resourceScope),
    runId: payload.runId,
    requestHash: payload.requestHash,
    baseDocumentHash: payload.baseDocumentHash,
    queuedAt: new Date().toISOString(),
    ...('pageId' in payload ? { pageId: payload.pageId } : {}),
    ...('runtimeRunId' in payload ? { runtimeRunId: payload.runtimeRunId } : {}),
  };
}

function parseDecksmithRecoveryJobs(
  value: Record<string, unknown>,
): Record<string, ReachDeckWorkspaceRecoveryDecksmithJob> {
  return Object.fromEntries(
    Object.entries(value).map(([jobId, rawJob]) => {
      const job = exactRecord(
        rawJob,
        [
          'jobId',
          'kind',
          'actorId',
          'billingGroupId',
          'roleGrantId',
          'resourceScope',
          'runId',
          'requestHash',
          'baseDocumentHash',
          'queuedAt',
        ],
        'Decksmith recovery job',
        ['runtimeRunId', 'resultRef', 'pageId', 'actorOrganizationId'],
      );
      if (job.kind !== 'decksmith')
        throw new Error('Reach Deck Decksmith recovery kind is invalid');
      const resourceScope = parseReachDeckResourceScope(job.resourceScope);
      const descriptor: ReachDeckWorkspaceRecoveryDecksmithJob = {
        jobId: requireString(job.jobId, 'Decksmith jobId', 128),
        kind: 'decksmith',
        actorId: requireString(job.actorId, 'Decksmith actorId', 255),
        actorOrganizationId: actorOrganizationIdFromPayload({
          actorOrganizationId: job.actorOrganizationId,
          resourceScope,
        }),
        billingGroupId: requireNullableString(job, 'billingGroupId', 255),
        roleGrantId: requireString(job.roleGrantId, 'Decksmith roleGrantId', 255),
        resourceScope,
        runId: requireString(job.runId, 'Decksmith runId', 128),
        requestHash: requireHash(job.requestHash, 'Decksmith requestHash'),
        baseDocumentHash: requireHash(job.baseDocumentHash, 'Decksmith baseDocumentHash'),
        queuedAt: requireTimestamp(job.queuedAt, 'Decksmith queuedAt'),
        ...(job.runtimeRunId === undefined
          ? {}
          : { runtimeRunId: canonicalUuid(job.runtimeRunId, 'Decksmith runtimeRunId') }),
        ...(job.resultRef === undefined
          ? {}
          : { resultRef: requireString(job.resultRef, 'Decksmith resultRef', 256) }),
        ...(job.pageId === undefined
          ? {}
          : { pageId: requireString(job.pageId, 'Decksmith pageId', 256) }),
      };
      if (descriptor.jobId !== jobId) {
        throw new Error('Reach Deck Decksmith recovery job map key is invalid');
      }
      if (
        descriptor.resultRef !== undefined &&
        descriptor.resultRef !== decksmithResultReference(descriptor.jobId)
      ) {
        throw new Error('Reach Deck Decksmith recovery resultRef is invalid');
      }
      return [jobId, descriptor];
    }),
  );
}

function parseDecksmithRecoveryResults(
  value: Record<string, unknown>,
  jobs: Record<string, ReachDeckWorkspaceRecoveryDecksmithJob>,
): Record<string, ReachDeckWorkspaceRecoveryDecksmithResult> {
  const results = Object.fromEntries(
    Object.entries(value).map(([reference, rawResult]) => {
      const record = exactRecord(
        rawResult,
        ['jobId', 'requestHash', 'baseDocumentHash', 'resultHash', 'storedAt', 'result'],
        'Decksmith recovery result',
      );
      const jobId = requireString(record.jobId, 'Decksmith result jobId', 128);
      const descriptor = jobs[jobId];
      const result = parseReachDeckDecksmithJobResult(record.result);
      if (
        descriptor === undefined ||
        reference !== decksmithResultReference(jobId) ||
        descriptor.resultRef !== reference ||
        descriptor.requestHash !== record.requestHash ||
        descriptor.baseDocumentHash !== record.baseDocumentHash ||
        result.jobId !== descriptor.jobId ||
        result.runId !== descriptor.runId ||
        result.requestHash !== descriptor.requestHash ||
        result.baseDocumentHash !== descriptor.baseDocumentHash ||
        result.resultHash !== record.resultHash ||
        (result.document !== undefined &&
          result.document.id !== descriptor.resourceScope.moduleVersionId)
      ) {
        throw new Error('Reach Deck Decksmith recovery result provenance is invalid');
      }
      return [
        reference,
        {
          jobId,
          requestHash: requireHash(record.requestHash, 'Decksmith result requestHash'),
          baseDocumentHash: requireHash(
            record.baseDocumentHash,
            'Decksmith result baseDocumentHash',
          ),
          resultHash: requireHash(record.resultHash, 'Decksmith resultHash'),
          storedAt: requireTimestamp(record.storedAt, 'Decksmith result storedAt'),
          result,
        },
      ];
    }),
  );
  for (const descriptor of Object.values(jobs)) {
    if (descriptor.resultRef !== undefined && results[descriptor.resultRef] === undefined) {
      throw new Error('Reach Deck Decksmith recovery result reference does not resolve');
    }
  }
  return results;
}

function parseRecoveryJob(
  value: unknown,
  legacyWithoutVoice: boolean,
): ReachDeckWorkspaceRecoveryJob {
  const job = exactRecord(
    value,
    [
      'jobId',
      'kind',
      'actorId',
      'billingGroupId',
      'roleGrantId',
      'resourceScope',
      'runId',
      'createdFromDraftRevision',
      'requestHash',
      ...(legacyWithoutVoice ? [] : ['voiceSelection', 'voiceDigest']),
      'generationStage',
      'generationAttempt',
      'queuedAt',
    ],
    'recovery job',
    [
      'pageId',
      'requestedRevision',
      'affectedLanes',
      'sceneType',
      'chainId',
      'artifactRef',
      'appliedAt',
      'scientificContextSourceHash',
      'actorOrganizationId',
      ...(legacyWithoutVoice ? ['voiceSelection', 'voiceDigest'] : []),
    ],
  );
  const kind = requireKind(job.kind);
  const hasVoiceSelection = job.voiceSelection !== undefined;
  const hasVoiceDigest = job.voiceDigest !== undefined;
  if (hasVoiceSelection !== hasVoiceDigest || (!legacyWithoutVoice && !hasVoiceSelection)) {
    throw new Error('Reach Deck recovery voice provenance is invalid');
  }
  const voiceSelection = hasVoiceSelection
    ? parseReachDeckVoiceSelection(job.voiceSelection)
    : DEFAULT_REACH_DECK_VOICE_SELECTION;
  const descriptor: ReachDeckWorkspaceRecoveryJob = {
    ...(job.scientificContextSourceHash === undefined
      ? {}
      : {
          scientificContextSourceHash: requireHash(
            job.scientificContextSourceHash,
            'scientificContextSourceHash',
          ),
        }),
    jobId: requireString(job.jobId, 'jobId', 128),
    kind,
    actorId: requireString(job.actorId, 'actorId', 255),
    actorOrganizationId: actorOrganizationIdFromPayload({
      actorOrganizationId: job.actorOrganizationId,
      resourceScope: parseReachDeckResourceScope(job.resourceScope),
    }),
    billingGroupId: requireNullableString(job, 'billingGroupId', 255),
    roleGrantId: requireString(job.roleGrantId, 'roleGrantId', 255),
    resourceScope: parseReachDeckResourceScope(job.resourceScope),
    runId: requireString(job.runId, 'runId', 100),
    createdFromDraftRevision: requireNonnegativeInteger(
      job.createdFromDraftRevision,
      'createdFromDraftRevision',
    ),
    requestHash: requireHash(job.requestHash, 'requestHash'),
    voiceSelection,
    voiceDigest: hasVoiceDigest
      ? requireHash(job.voiceDigest, 'voiceDigest')
      : reachDeckVoiceSelectionDigest(DEFAULT_REACH_DECK_VOICE_SELECTION),
    generationStage: requireString(job.generationStage, 'generationStage', 50),
    generationAttempt: requireString(job.generationAttempt, 'generationAttempt', 50),
    queuedAt: requireTimestamp(job.queuedAt, 'queuedAt'),
    ...(job.pageId === undefined ? {} : { pageId: requireString(job.pageId, 'pageId', 256) }),
    ...(job.requestedRevision === undefined
      ? {}
      : {
          requestedRevision: requirePositiveInteger(job.requestedRevision, 'requestedRevision'),
        }),
    ...(job.affectedLanes === undefined
      ? {}
      : { affectedLanes: parseRecoveryAffectedLanes(job.affectedLanes) }),
    ...(job.sceneType === undefined
      ? {}
      : {
          sceneType: parseRecoverySceneType(job.sceneType),
        }),
    ...(job.chainId === undefined ? {} : { chainId: requireString(job.chainId, 'chainId', 256) }),
    ...(job.artifactRef === undefined
      ? {}
      : { artifactRef: requireString(job.artifactRef, 'artifactRef', 256) }),
    ...(job.appliedAt === undefined
      ? {}
      : { appliedAt: requireTimestamp(job.appliedAt, 'appliedAt') }),
  };
  assertDescriptorProvenance(descriptor);
  if (descriptor.voiceDigest !== reachDeckVoiceSelectionDigest(descriptor.voiceSelection)) {
    throw new Error('Reach Deck recovery voice provenance is invalid');
  }
  if (
    descriptor.artifactRef !== undefined &&
    descriptor.artifactRef !== artifactReference(descriptor.jobId)
  ) {
    throw new Error('Reach Deck recovery artifactRef is invalid');
  }
  if (descriptor.appliedAt !== undefined && descriptor.artifactRef === undefined) {
    throw new Error('Reach Deck recovery appliedAt requires an artifactRef');
  }
  return descriptor;
}

function parseRecoveryAffectedLanes(
  value: unknown,
): NonNullable<ReachDeckWorkspaceRecoveryJob['affectedLanes']> {
  const allowed = ['layout', 'image', 'narration', 'audio', 'animation'];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some((lane) => typeof lane !== 'string' || !allowed.includes(lane))
  )
    throw new Error('Reach Deck recovery affectedLanes is invalid');
  return value as NonNullable<ReachDeckWorkspaceRecoveryJob['affectedLanes']>;
}

function parseRecoveryResult(
  value: unknown,
  jobs: Record<string, ReachDeckWorkspaceRecoveryJob>,
): ReachDeckWorkspaceRecoveryResult {
  const record = exactRecord(
    value,
    ['jobId', 'requestHash', 'resultHash', 'storedAt', 'result'],
    'recovery result',
  );
  const jobId = requireString(record.jobId, 'jobId', 128);
  const descriptor = jobs[jobId];
  if (descriptor === undefined) throw new Error('Reach Deck recovery result job is missing');
  const requestHash = requireHash(record.requestHash, 'requestHash');
  const storedResultHash = requireHash(record.resultHash, 'resultHash');
  if (buildStagedGenerationRequestHash(record.result) !== storedResultHash) {
    throw new Error('Reach Deck recovery result content hash is invalid');
  }
  // The content hash binds the stored bytes; upgrade legacy outline pages only after checking it.
  const result = parseCompletedStagedResult(
    upgradeLegacyRecoveryOutlineCandidate(record.result),
    provenanceFromDescriptor(descriptor),
  );
  if (descriptor.requestHash !== requestHash) {
    throw new Error('Reach Deck recovery result request hash is invalid');
  }
  if (descriptor.artifactRef !== artifactReference(jobId)) {
    throw new Error('Reach Deck recovery result artifact reference is invalid');
  }
  return {
    jobId,
    requestHash,
    resultHash: buildStagedGenerationRequestHash(result),
    storedAt: requireTimestamp(record.storedAt, 'storedAt'),
    result,
  };
}

/** Stored page-outline results keep the page shapes their release wrote; see persistedOutlineUpgrade. */
function upgradeLegacyRecoveryOutlineCandidate(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;
  const candidate = (result as { candidate?: unknown }).candidate;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return result;
  }
  const pages = (candidate as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return result;
  return {
    ...result,
    candidate: { ...candidate, pages: pages.map(upgradeLegacyPersistedPageOutline) },
  };
}

function continuationFrom(
  payload: NarrationJobPayload,
  prepared: ReachDeckPreparedSlideNarration | ReachDeckPreparedNativeNarration,
  queueIdentity: string,
  formulaReadings: readonly ReachDeckFormulaReadingV1[],
): ReachDeckWorkspaceTtsContinuation {
  let sourceKind: ReachDeckWorkspaceTtsContinuation['sourceKind'];
  let layoutDigest: string;
  let narrationDigest: string;
  if (isNativeNarrationRequest(payload.request)) {
    sourceKind = 'materialized-native';
    layoutDigest = payload.request.nativeSlideContentDigest;
    narrationDigest = buildReachDeckNarrationStateDigest(
      prepared.markdown,
      payload.request.speechMarkup,
    );
  } else if (isInteractiveNarrationRequest(payload.request)) {
    sourceKind = payload.request.sourceKind;
    layoutDigest = payload.request.interactiveContentDigest;
    assertInteractivePreparedNarration(
      prepared,
      payload.request.sourceKind === 'materialized-interactive' &&
        payload.request.mode === 'regenerate-text'
        ? prepared.markdown
        : payload.request.narrationText,
    );
    narrationDigest = buildReachDeckInteractiveNarrationTextDigest(prepared.markdown);
  } else {
    sourceKind = 'workspace';
    layoutDigest = (payload.request as Readonly<GenerateNarrationRequest>).slideContentDigest;
    narrationDigest = buildReachDeckNarrationStateDigest(prepared.markdown);
  }
  const speechMarkup =
    isNativeNarrationRequest(payload.request) && payload.request.speechMarkup !== undefined
      ? parseReachDeckSpeechMarkupV1(payload.request.speechMarkup, prepared.markdown)
      : undefined;
  const candidate: ReachDeckWorkspaceTtsContinuation = {
    // 权威讲稿一律分块，新 continuation 统一 v4；在飞集合由各块登记时填充。
    schemaVersion: 'reach-deck-tts-continuation/v4',
    jobId: payload.jobId,
    runId: payload.runId,
    requestHash: payload.requestHash,
    pageId: payload.request.pageId,
    sourceKind,
    layoutDigest,
    narrationDigest,
    queueIdentity: requireString(queueIdentity, 'TTS queueIdentity', 128),
    activeChunks: [],
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    ...(formulaReadings.length === 0
      ? {}
      : {
          formulaReadings: parseReachDeckFormulaReadingsV1(
            continuationSpeechText(sourceKind, prepared.markdown),
            formulaReadings,
          ),
        }),
    voiceSelection: parseReachDeckVoiceSelection(payload.voiceSelection),
    voiceDigest: reachDeckVoiceSelectionDigest(payload.voiceSelection),
    prepared: parsePreparedNarration(prepared),
    highestObservedAttempt: 0,
    highestAuditedAttempt: 0,
  };
  if (jsonByteLength(candidate) > MAX_TTS_CONTINUATION_BYTES) {
    throw new Error('Reach Deck TTS continuation exceeds the storage size limit');
  }
  return candidate;
}

/** The exact text synthesized for this continuation; readings index into it. */
function continuationSpeechText(
  sourceKind: ReachDeckWorkspaceTtsContinuation['sourceKind'],
  markdown: string,
): string {
  return sourceKind === 'workspace-interactive' || sourceKind === 'materialized-interactive'
    ? canonicalizeInteractiveNarrationText(markdown)
    : markdown;
}

function assertSameTtsContinuation(
  existing: ReachDeckWorkspaceTtsContinuation,
  candidate: ReachDeckWorkspaceTtsContinuation,
): void {
  const {
    queue: _queue,
    highestObservedAttempt: _highestObservedAttempt,
    highestAuditedAttempt: _highestAuditedAttempt,
    auditClaimId: _auditClaimId,
    // 在飞块集合与被顶替身份随各块登记而变，属于运行状态而非身份的一部分。
    activeChunks: _activeChunks,
    supersededQueueIdentities: _supersededQueueIdentities,
    ...immutableExisting
  } = existing;
  if (
    !valuesEqual(
      {
        ...immutableExisting,
        activeChunks: [],
        highestObservedAttempt: 0,
        highestAuditedAttempt: 0,
      },
      { ...candidate, activeChunks: [] },
    )
  ) {
    throw new Error('Reach Deck TTS continuation collides with different provenance');
  }
}

function assertContinuationMatchesPayload(
  continuation: ReachDeckWorkspaceTtsContinuation,
  payload: NarrationJobPayload,
): void {
  let sourceKind: ReachDeckWorkspaceTtsContinuation['sourceKind'];
  let layoutDigest: string;
  let narrationDigest: string;
  if (isNativeNarrationRequest(payload.request)) {
    sourceKind = 'materialized-native';
    layoutDigest = payload.request.nativeSlideContentDigest;
    narrationDigest = buildReachDeckNarrationStateDigest(
      continuation.prepared.markdown,
      payload.request.speechMarkup,
    );
  } else if (isInteractiveNarrationRequest(payload.request)) {
    sourceKind = payload.request.sourceKind;
    layoutDigest = payload.request.interactiveContentDigest;
    assertInteractivePreparedNarration(
      continuation.prepared,
      payload.request.sourceKind === 'materialized-interactive' &&
        payload.request.mode === 'regenerate-text'
        ? continuation.prepared.markdown
        : payload.request.narrationText,
    );
    narrationDigest = buildReachDeckInteractiveNarrationTextDigest(continuation.prepared.markdown);
  } else {
    sourceKind = 'workspace';
    layoutDigest = (payload.request as Readonly<GenerateNarrationRequest>).slideContentDigest;
    narrationDigest = buildReachDeckNarrationStateDigest(continuation.prepared.markdown);
  }
  if (
    continuation.jobId !== payload.jobId ||
    continuation.runId !== payload.runId ||
    continuation.requestHash !== payload.requestHash ||
    continuation.pageId !== payload.request.pageId ||
    continuation.sourceKind !== sourceKind ||
    continuation.layoutDigest !== layoutDigest ||
    !sameReachDeckVoiceSelection(continuation.voiceSelection, payload.voiceSelection) ||
    continuation.voiceDigest !== reachDeckVoiceSelectionDigest(payload.voiceSelection) ||
    continuation.narrationDigest !== narrationDigest ||
    !valuesEqual(
      continuation.speechMarkup,
      isNativeNarrationRequest(payload.request) ? payload.request.speechMarkup : undefined,
    )
  ) {
    throw new Error('Reach Deck TTS continuation provenance is invalid');
  }
}

function assertInteractivePreparedNarration(
  prepared: ReachDeckPreparedSlideNarration | ReachDeckPreparedNativeNarration,
  narrationText: string,
): void {
  const cue = prepared.cues[0];
  if (
    prepared.markdown !== narrationText ||
    prepared.cues.length !== 1 ||
    cue?.text !== narrationText ||
    cue.revealElementIds !== undefined ||
    cue.revealEffect !== undefined ||
    prepared.revealRanges.length !== 0 ||
    prepared.scientificAnchorRanges !== undefined
  ) {
    throw new Error(
      'Reach Deck Interactive TTS continuation must contain exactly one plain-text cue',
    );
  }
}

function parseTtsContinuations(
  value: Record<string, unknown>,
  jobs: Record<string, ReachDeckWorkspaceRecoveryJob>,
): Record<string, ReachDeckWorkspaceTtsContinuation> {
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      const entry = exactRecord(
        raw,
        [
          'schemaVersion',
          'jobId',
          'runId',
          'requestHash',
          'pageId',
          'sourceKind',
          'layoutDigest',
          'narrationDigest',
          'queueIdentity',
          ...(isTtsContinuationV1(raw) ? [] : ['voiceSelection', 'voiceDigest']),
          'prepared',
          'highestObservedAttempt',
          'highestAuditedAttempt',
        ],
        'TTS continuation',
        [
          'queue',
          'auditClaimId',
          'activeChunkIndex',
          'activeQueueIdentity',
          'activeChunks',
          'supersededQueueIdentities',
          'speechMarkup',
          'formulaReadings',
        ],
      );
      const legacyWithoutVoice = entry.schemaVersion === 'reach-deck-tts-continuation/v1';
      // v3 用单游标记一个在飞块，v4 改成集合；两者都按 v4 读出来，取消时逐个处理。
      const singleCursor = entry.schemaVersion === 'reach-deck-tts-continuation/v3';
      const chunkSet = entry.schemaVersion === 'reach-deck-tts-continuation/v4';
      if (
        !legacyWithoutVoice &&
        entry.schemaVersion !== 'reach-deck-tts-continuation/v2' &&
        !singleCursor &&
        !chunkSet
      ) {
        throw new Error('Reach Deck TTS continuation schemaVersion is invalid');
      }
      if (
        entry.sourceKind !== 'workspace' &&
        entry.sourceKind !== 'workspace-interactive' &&
        entry.sourceKind !== 'materialized-interactive' &&
        entry.sourceKind !== 'materialized-native'
      ) {
        throw new Error('Reach Deck TTS continuation sourceKind is invalid');
      }
      const continuation: ReachDeckWorkspaceTtsContinuation = {
        schemaVersion:
          singleCursor || chunkSet
            ? 'reach-deck-tts-continuation/v4'
            : 'reach-deck-tts-continuation/v2',
        jobId: requireString(entry.jobId, 'TTS jobId', 128),
        runId: requireString(entry.runId, 'TTS runId', 128),
        requestHash: requireHash(entry.requestHash, 'TTS requestHash'),
        pageId: requireString(entry.pageId, 'TTS pageId', 256),
        sourceKind: entry.sourceKind,
        layoutDigest: requireHash(entry.layoutDigest, 'TTS layoutDigest'),
        narrationDigest: requireHash(entry.narrationDigest, 'TTS narrationDigest'),
        queueIdentity: requireString(entry.queueIdentity, 'TTS queueIdentity', 128),
        ...(singleCursor || chunkSet
          ? {
              activeChunks: singleCursor
                ? [
                    {
                      chunkIndex: requireNonnegativeInteger(
                        entry.activeChunkIndex,
                        'TTS activeChunkIndex',
                      ),
                      queueIdentity: requireString(
                        entry.activeQueueIdentity,
                        'TTS active queueIdentity',
                        128,
                      ),
                      highestObservedAttempt: requireNonnegativeInteger(
                        entry.highestObservedAttempt,
                        'TTS highestObservedAttempt',
                      ),
                      highestAuditedAttempt: requireNonnegativeInteger(
                        entry.highestAuditedAttempt,
                        'TTS highestAuditedAttempt',
                      ),
                      ...(entry.queue === undefined
                        ? {}
                        : { queue: parsePersistedTtsQueue(entry.queue) }),
                      ...(entry.auditClaimId === undefined
                        ? {}
                        : {
                            auditClaimId: requireString(
                              entry.auditClaimId,
                              'TTS auditClaimId',
                              128,
                            ),
                          }),
                    },
                  ]
                : parseTtsActiveChunks(entry.activeChunks),
              ...(entry.supersededQueueIdentities === undefined
                ? {}
                : {
                    supersededQueueIdentities: parseTtsSupersededIdentities(
                      entry.supersededQueueIdentities,
                    ),
                  }),
              ...(entry.speechMarkup === undefined
                ? {}
                : {
                    speechMarkup: parseReachDeckSpeechMarkupV1(
                      entry.speechMarkup,
                      (entry.prepared as { markdown?: unknown }).markdown as string,
                    ),
                  }),
            }
          : {}),
        ...(entry.formulaReadings === undefined
          ? {}
          : {
              formulaReadings: parseReachDeckFormulaReadingsV1(
                continuationSpeechText(
                  entry.sourceKind,
                  (entry.prepared as { markdown?: unknown }).markdown as string,
                ),
                entry.formulaReadings,
              ),
            }),
        voiceSelection: legacyWithoutVoice
          ? DEFAULT_REACH_DECK_VOICE_SELECTION
          : parseReachDeckVoiceSelection(entry.voiceSelection),
        voiceDigest: legacyWithoutVoice
          ? reachDeckVoiceSelectionDigest(DEFAULT_REACH_DECK_VOICE_SELECTION)
          : requireHash(entry.voiceDigest, 'TTS voiceDigest'),
        prepared: parsePreparedNarration(entry.prepared),
        ...(entry.queue === undefined ? {} : { queue: parsePersistedTtsQueue(entry.queue) }),
        highestObservedAttempt: requireNonnegativeInteger(
          entry.highestObservedAttempt,
          'TTS highestObservedAttempt',
        ),
        highestAuditedAttempt: requireNonnegativeInteger(
          entry.highestAuditedAttempt,
          'TTS highestAuditedAttempt',
        ),
        ...(entry.auditClaimId === undefined
          ? {}
          : { auditClaimId: requireString(entry.auditClaimId, 'TTS auditClaimId', 128) }),
      };
      const interactive =
        continuation.sourceKind === 'workspace-interactive' ||
        continuation.sourceKind === 'materialized-interactive';
      if (interactive) {
        assertInteractivePreparedNarration(continuation.prepared, continuation.prepared.markdown);
      }
      const expectedNarrationDigest = interactive
        ? buildReachDeckInteractiveNarrationTextDigest(continuation.prepared.markdown)
        : buildReachDeckNarrationStateDigest(
            continuation.prepared.markdown,
            continuation.speechMarkup,
          );
      const descriptor = jobs[continuation.jobId];
      if (
        key !== continuation.jobId ||
        descriptor?.kind !== 'narration-generation' ||
        descriptor.runId !== continuation.runId ||
        descriptor.requestHash !== continuation.requestHash ||
        descriptor.pageId !== continuation.pageId ||
        continuation.narrationDigest !== expectedNarrationDigest ||
        continuation.voiceDigest !== reachDeckVoiceSelectionDigest(continuation.voiceSelection) ||
        !sameReachDeckVoiceSelection(continuation.voiceSelection, descriptor.voiceSelection) ||
        continuation.voiceDigest !== descriptor.voiceDigest ||
        // v3 的分块只存在于 native 通道；v4 三条通道都分块，不再有这个约束。
        (singleCursor && continuation.sourceKind !== 'materialized-native') ||
        continuation.highestAuditedAttempt > continuation.highestObservedAttempt ||
        (continuation.queue !== undefined &&
          continuation.queue.upstreamAttempts > continuation.highestObservedAttempt) ||
        (continuation.activeChunks ?? []).some(
          (chunk) =>
            chunk.highestAuditedAttempt > chunk.highestObservedAttempt ||
            (chunk.queue !== undefined &&
              chunk.queue.upstreamAttempts > chunk.highestObservedAttempt),
        ) ||
        jsonByteLength(continuation) > MAX_TTS_CONTINUATION_BYTES
      ) {
        throw new Error('Reach Deck TTS continuation provenance is invalid');
      }
      return [key, continuation];
    }),
  );
}

function isTtsContinuationV1(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 'reach-deck-tts-continuation/v1'
  );
}

function parsePreparedNarration(
  value: unknown,
): ReachDeckPreparedSlideNarration | ReachDeckPreparedNativeNarration {
  const record = exactRecord(
    value,
    ['markdown', 'cues', 'revealRanges'],
    'prepared TTS narration',
    ['scientificAnchorRanges', 'persistentElementIds'],
  );
  const markdown = requireString(record.markdown, 'TTS markdown', 256 * 1024);
  if (!Array.isArray(record.cues) || record.cues.length < 1 || record.cues.length > 8) {
    throw new Error('Reach Deck prepared TTS narration cues are invalid');
  }
  const cues = record.cues.map((raw, index) => {
    const cue = exactRecord(raw, ['text'], `prepared TTS narration cue ${index}`, [
      'revealElementIds',
      'revealEffect',
    ]);
    const revealElementIds =
      cue.revealElementIds === undefined
        ? undefined
        : Array.isArray(cue.revealElementIds) && cue.revealElementIds.length <= 256
          ? cue.revealElementIds.map((id) => requireString(id, 'TTS revealElementId', 256))
          : (() => {
              throw new Error('Reach Deck prepared TTS revealElementIds are invalid');
            })();
    if (cue.revealEffect !== undefined && !isEntranceAnimationPresetName(cue.revealEffect)) {
      throw new Error('Reach Deck prepared TTS revealEffect is invalid');
    }
    return {
      text: requireString(cue.text, 'TTS narration cue text', 128 * 1024),
      ...(revealElementIds === undefined ? {} : { revealElementIds }),
      ...(cue.revealEffect === undefined ? {} : { revealEffect: cue.revealEffect }),
    };
  });
  if (cues.map((cue) => cue.text).join('') !== markdown) {
    throw new Error('Reach Deck prepared TTS cues do not reconstruct authoritative Markdown');
  }
  if (!Array.isArray(record.revealRanges) || record.revealRanges.length > 64) {
    throw new Error('Reach Deck prepared TTS revealRanges are invalid');
  }
  const revealRanges = record.revealRanges.map((raw, index) => {
    const range = exactRecord(
      raw,
      ['start', 'end', 'revealElementIds'],
      `prepared TTS reveal range ${index}`,
      ['revealEffect'],
    );
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      (range.start as number) < 0 ||
      (range.end as number) <= (range.start as number) ||
      (range.end as number) > markdown.length
    ) {
      throw new Error('Reach Deck prepared TTS reveal range offsets are invalid');
    }
    if (
      !Array.isArray(range.revealElementIds) ||
      range.revealElementIds.length < 1 ||
      range.revealElementIds.length > 256
    ) {
      throw new Error('Reach Deck prepared TTS reveal range element ids are invalid');
    }
    if (range.revealEffect !== undefined && !isEntranceAnimationPresetName(range.revealEffect)) {
      throw new Error('Reach Deck prepared TTS reveal range effect is invalid');
    }
    return {
      start: range.start as number,
      end: range.end as number,
      revealElementIds: range.revealElementIds.map((id) =>
        requireString(id, 'TTS revealElementId', 256),
      ),
      ...(range.revealEffect === undefined ? {} : { revealEffect: range.revealEffect }),
    };
  });
  const persistentElementIds =
    record.persistentElementIds === undefined
      ? undefined
      : (() => {
          if (
            !Array.isArray(record.persistentElementIds) ||
            record.persistentElementIds.length > 256
          ) {
            throw new Error('Reach Deck prepared TTS persistentElementIds are invalid');
          }
          const ids = record.persistentElementIds.map((id) =>
            requireString(id, 'TTS persistentElementId', 256),
          );
          if (
            new Set(ids).size !== ids.length ||
            revealRanges.some((range) => range.revealElementIds.some((id) => ids.includes(id)))
          ) {
            throw new Error(
              'Reach Deck prepared TTS persistentElementIds conflict with reveal targets',
            );
          }
          return ids;
        })();
  const scientificAnchorRanges =
    record.scientificAnchorRanges === undefined
      ? undefined
      : (() => {
          if (
            !Array.isArray(record.scientificAnchorRanges) ||
            record.scientificAnchorRanges.length > 64
          ) {
            throw new Error('Reach Deck prepared TTS scientificAnchorRanges are invalid');
          }
          return record.scientificAnchorRanges.map((raw, index) => {
            const range = exactRecord(
              raw,
              ['elementId', 'anchorId', 'start', 'end'],
              `prepared TTS scientific anchor range ${index}`,
            );
            if (
              !Number.isInteger(range.start) ||
              !Number.isInteger(range.end) ||
              (range.start as number) < 0 ||
              (range.end as number) <= (range.start as number) ||
              (range.end as number) > markdown.length
            ) {
              throw new Error('Reach Deck prepared TTS scientific anchor offsets are invalid');
            }
            return {
              elementId: requireString(range.elementId, 'TTS scientific anchor elementId', 256),
              anchorId: requireString(range.anchorId, 'TTS scientific anchor anchorId', 256),
              start: range.start as number,
              end: range.end as number,
            };
          });
        })();
  return {
    markdown,
    cues,
    revealRanges,
    ...(persistentElementIds === undefined ? {} : { persistentElementIds }),
    ...(scientificAnchorRanges === undefined ? {} : { scientificAnchorRanges }),
  };
}

/**
 * 解析 v4 的在飞块集合。
 *
 * 核心逻辑：1) 必须是数组且不超过上限；2) 逐条按 exactRecord 校验字段；3) 块序号不得
 * 重复——重复意味着同一块登记了两个身份，取消时会漏掉其中一个；4) 按块序号排序，让
 * 持久化结果与内存中的顺序一致，便于比对。
 */
/** 解析被顶替的旧块身份列表；它只喂给取消链路，去重并受条数上限约束。 */
function parseTtsSupersededIdentities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Reach Deck TTS continuation supersededQueueIdentities must be an array');
  }
  if (value.length > MAX_TTS_ACTIVE_CHUNKS) {
    throw new Error('Reach Deck TTS continuation exceeds the superseded identity limit');
  }
  return [
    ...new Set(value.map((item) => requireString(item, 'TTS superseded queueIdentity', 128))),
  ];
}

function parseTtsActiveChunks(value: unknown): ReachDeckWorkspaceTtsActiveChunk[] {
  if (!Array.isArray(value)) {
    throw new Error('Reach Deck TTS continuation activeChunks must be an array');
  }
  if (value.length > MAX_TTS_ACTIVE_CHUNKS) {
    throw new Error('Reach Deck TTS continuation exceeds the active chunk limit');
  }
  const seen = new Set<number>();
  const chunks = value.map((item) => {
    const entry = exactRecord(
      item,
      ['chunkIndex', 'queueIdentity', 'highestObservedAttempt', 'highestAuditedAttempt'],
      'TTS active chunk',
      ['queue', 'auditClaimId'],
    );
    const chunkIndex = requireNonnegativeInteger(entry.chunkIndex, 'TTS active chunkIndex');
    if (seen.has(chunkIndex)) {
      throw new Error('Reach Deck TTS continuation repeats an active chunk index');
    }
    seen.add(chunkIndex);
    return {
      chunkIndex,
      queueIdentity: requireString(entry.queueIdentity, 'TTS active queueIdentity', 128),
      highestObservedAttempt: requireNonnegativeInteger(
        entry.highestObservedAttempt,
        'TTS active highestObservedAttempt',
      ),
      highestAuditedAttempt: requireNonnegativeInteger(
        entry.highestAuditedAttempt,
        'TTS active highestAuditedAttempt',
      ),
      ...(entry.queue === undefined ? {} : { queue: parsePersistedTtsQueue(entry.queue) }),
      ...(entry.auditClaimId === undefined
        ? {}
        : { auditClaimId: requireString(entry.auditClaimId, 'TTS active auditClaimId', 128) }),
    } satisfies ReachDeckWorkspaceTtsActiveChunk;
  });
  return sortedActiveChunks(chunks);
}

function parsePersistedTtsQueue(value: unknown): ReachDeckTtsQueueState {
  const queue = exactRecord(
    value,
    [
      'protocol',
      'status',
      'ticket',
      'queuedAtEpochMillis',
      'expiresAtEpochMillis',
      'pollAfterMillis',
      'upstreamAttempts',
    ],
    'persisted TTS queue',
    ['lastAttempt'],
  );
  if (
    queue.protocol !== 'tts-queue/v1' ||
    (queue.status !== 'queued' && queue.status !== 'running')
  ) {
    throw new Error('Reach Deck persisted TTS queue status is invalid');
  }
  const upstreamAttempts = requireNonnegativeInteger(
    queue.upstreamAttempts,
    'TTS upstreamAttempts',
  );
  let lastAttempt: ReachDeckTtsQueueState['lastAttempt'];
  if (upstreamAttempts > 0) {
    const attempt = exactRecord(
      queue.lastAttempt,
      ['ordinal', 'outcome'],
      'persisted TTS lastAttempt',
    );
    const ordinal = requirePositiveInteger(attempt.ordinal, 'TTS lastAttempt ordinal');
    if (
      ordinal > upstreamAttempts ||
      (attempt.outcome !== 'running' &&
        attempt.outcome !== 'provider_rate_limited' &&
        attempt.outcome !== 'succeeded')
    ) {
      throw new Error('Reach Deck persisted TTS lastAttempt is invalid');
    }
    lastAttempt = { ordinal, outcome: attempt.outcome };
  } else if (queue.lastAttempt !== undefined) {
    throw new Error('Reach Deck persisted TTS lastAttempt is invalid');
  }
  const queuedAtEpochMillis = requireNonnegativeInteger(
    queue.queuedAtEpochMillis,
    'TTS queuedAtEpochMillis',
  );
  const expiresAtEpochMillis = requireNonnegativeInteger(
    queue.expiresAtEpochMillis,
    'TTS expiresAtEpochMillis',
  );
  const pollAfterMillis = requirePositiveInteger(queue.pollAfterMillis, 'TTS pollAfterMillis');
  if (expiresAtEpochMillis <= queuedAtEpochMillis || pollAfterMillis > 30_000) {
    throw new Error('Reach Deck persisted TTS queue timing is invalid');
  }
  return {
    protocol: 'tts-queue/v1',
    status: queue.status,
    ticket: requireString(queue.ticket, 'TTS ticket', 256),
    queuedAtEpochMillis,
    expiresAtEpochMillis,
    pollAfterMillis,
    upstreamAttempts,
    ...(lastAttempt === undefined ? {} : { lastAttempt }),
  };
}

function provenanceFromDescriptor(
  descriptor: ReachDeckWorkspaceRecoveryJob,
): ReachDeckStagedResultProvenance {
  return {
    kind: descriptor.kind,
    runId: descriptor.runId,
    createdFromDraftRevision: descriptor.createdFromDraftRevision,
    ...(descriptor.pageId === undefined ? {} : { pageId: descriptor.pageId }),
    ...(descriptor.requestedRevision === undefined
      ? {}
      : { requestedRevision: descriptor.requestedRevision }),
    ...(descriptor.kind === 'page-generation'
      ? {
          attempt: Number.parseInt(descriptor.generationAttempt, 10),
          sceneType: sceneTypeFromDescriptor(descriptor),
        }
      : {}),
    ...(descriptor.kind === 'narration-generation'
      ? {
          attempt: Number.parseInt(descriptor.generationAttempt, 10),
          sceneType: descriptor.sceneType ?? ('slide' as const),
        }
      : {}),
  };
}

function sceneTypeFromDescriptor(descriptor: ReachDeckWorkspaceRecoveryJob): GenerationSceneType {
  if (
    descriptor.generationStage === 'slide' ||
    descriptor.generationStage === 'quiz' ||
    descriptor.generationStage === 'interactive'
  ) {
    return descriptor.generationStage;
  }
  throw new Error('Reach Deck recovery scene type is invalid');
}

function parseRecoverySceneType(value: unknown): GenerationSceneType {
  if (value === 'slide' || value === 'quiz' || value === 'interactive') {
    return value;
  }
  throw new Error('Reach Deck recovery scene type is invalid');
}

function generationStage(payload: ReachDeckStagedGenerationJobPayload): string {
  switch (payload.kind) {
    case 'lesson-plan':
      return 'lesson-plan';
    case 'page-outline':
      return 'paged-outline';
    case 'page-generation':
      return payload.request.page.sceneType;
    case 'narration-generation':
      return 'narration';
  }
}

function assertDescriptorProvenance(descriptor: ReachDeckWorkspaceRecoveryJob): void {
  if (
    descriptor.scientificContextSourceHash !== undefined &&
    descriptor.kind !== 'page-outline' &&
    !(
      descriptor.kind === 'page-generation' &&
      (descriptor.generationStage === 'slide' || descriptor.generationStage === 'interactive')
    )
  ) {
    throw new Error('Reach Deck scientific recovery provenance is invalid');
  }
  if (descriptor.kind === 'lesson-plan' || descriptor.kind === 'page-outline') {
    if (
      descriptor.pageId !== undefined ||
      descriptor.requestedRevision !== undefined ||
      descriptor.sceneType !== undefined ||
      descriptor.generationAttempt !== 'initial' ||
      (descriptor.kind === 'lesson-plan' && descriptor.generationStage !== 'lesson-plan') ||
      (descriptor.kind === 'page-outline' && descriptor.generationStage !== 'paged-outline')
    ) {
      throw new Error('Reach Deck recovery planning provenance is invalid');
    }
    return;
  }
  if (
    descriptor.pageId === undefined ||
    descriptor.requestedRevision === undefined ||
    !/^[1-9]\d*$/.test(descriptor.generationAttempt)
  ) {
    throw new Error('Reach Deck recovery page provenance is invalid');
  }
  if (descriptor.kind === 'narration-generation') {
    if (
      descriptor.generationStage !== 'narration' ||
      (descriptor.sceneType !== undefined &&
        descriptor.sceneType !== 'slide' &&
        descriptor.sceneType !== 'interactive')
    ) {
      throw new Error('Reach Deck recovery narration provenance is invalid');
    }
    return;
  }
  if (descriptor.sceneType !== undefined) {
    throw new Error('Reach Deck recovery page provenance is invalid');
  }
  sceneTypeFromDescriptor(descriptor);
}

function assertSameDescriptor(
  existing: ReachDeckWorkspaceRecoveryJob,
  expected: ReachDeckWorkspaceRecoveryJob,
): void {
  // Page and narration jobs are re-derived from the live workspace at enqueue
  // and checkpoint time, so their draft revision advances while the content
  // identity stays fixed. Mirror comparableStagedPayload in queue.ts and
  // compare both kinds without createdFromDraftRevision.
  const ignoreDraftRevision =
    expected.kind === 'page-generation' || expected.kind === 'narration-generation';
  const comparableExisting = {
    ...existing,
    ...(existing.affectedLanes === undefined && expected.affectedLanes !== undefined
      ? { affectedLanes: expected.affectedLanes }
      : {}),
    ...(existing.kind === 'narration-generation' && existing.sceneType === undefined
      ? { sceneType: 'slide' as const }
      : {}),
    queuedAt: expected.queuedAt,
    ...(ignoreDraftRevision ? { createdFromDraftRevision: expected.createdFromDraftRevision } : {}),
    artifactRef: undefined,
    appliedAt: undefined,
  };
  const comparableExpected = {
    ...expected,
    artifactRef: undefined,
    appliedAt: undefined,
  };
  if (!valuesEqual(comparableExisting, comparableExpected)) {
    throw new Error('Reach Deck recovery job collides with different immutable provenance');
  }
}

function assertSameDecksmithDescriptor(
  existing: ReachDeckWorkspaceRecoveryDecksmithJob,
  expected: ReachDeckWorkspaceRecoveryDecksmithJob,
): void {
  if (
    !valuesEqual(
      { ...existing, queuedAt: expected.queuedAt, resultRef: undefined },
      { ...expected, resultRef: undefined },
    )
  ) {
    throw new ReachDeckDecksmithIdempotencyConflictError();
  }
}

function assertAuditMatchesDescriptor(
  audit: ReachDeckGenerationAuditResource,
  descriptor: ReachDeckWorkspaceRecoveryJob | ReachDeckWorkspaceRecoveryDecksmithJob,
): void {
  if (
    audit.jobId !== descriptor.jobId ||
    audit.actorId !== descriptor.actorId ||
    audit.billingGroupId !== descriptor.billingGroupId ||
    !sameReachDeckResourceScope(audit, descriptor.resourceScope) ||
    audit.requestHash !== descriptor.requestHash
  ) {
    throw new Error('Reach Deck recovery audit provenance does not match its descriptor');
  }
}

function isRetryableContentServiceFailure(error: unknown): boolean {
  return (
    error instanceof ContentServiceTransportError ||
    (error instanceof ContentServiceClientError && error.retryable)
  );
}

function scopeFromPayload(payload: ReachDeckStagedGenerationJobPayload): ReachDeckWorkspaceContext {
  return {
    actorId: payload.actorId,
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: parseReachDeckResourceScope(payload.resourceScope),
  };
}

function scopeFromDecksmithPayload(
  payload: ReachDeckDecksmithJobPayload,
): ReachDeckWorkspaceContext {
  return {
    actorId: payload.actorId,
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: parseReachDeckResourceScope(payload.resourceScope),
  };
}

function sameScope(
  descriptor: ReachDeckWorkspaceRecoveryJob,
  scope: ReachDeckGenerationJobScope,
): boolean {
  return (
    descriptor.actorId === scope.actorId &&
    actorOrganizationIdFromPayload(descriptor) === actorOrganizationIdFromPayload(scope) &&
    descriptor.billingGroupId === scope.billingGroupId &&
    descriptor.roleGrantId === scope.roleGrantId &&
    sameReachDeckResourceScope(descriptor.resourceScope, scope.resourceScope)
  );
}

function sameDecksmithScope(
  descriptor: ReachDeckWorkspaceRecoveryDecksmithJob,
  scope: ReachDeckGenerationJobScope,
): boolean {
  return (
    descriptor.actorId === scope.actorId &&
    actorOrganizationIdFromPayload(descriptor) === actorOrganizationIdFromPayload(scope) &&
    descriptor.billingGroupId === scope.billingGroupId &&
    descriptor.roleGrantId === scope.roleGrantId &&
    sameReachDeckResourceScope(descriptor.resourceScope, scope.resourceScope)
  );
}

function artifactReference(jobId: string): string {
  return `result:${jobId}`;
}

function decksmithResultReference(jobId: string): string {
  return `decksmith-result:${jobId}`;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = recordValue(value, label);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error(`Reach Deck ${label} contains missing or unsupported keys`);
  }
  return record;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Reach Deck ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`Reach Deck recovery ${label} is invalid`);
  }
  return value;
}

function requireNullableString(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new Error(`Reach Deck recovery ${key} is missing`);
  }
  return value[key] === null ? null : requireString(value[key], key, maximum);
}

function requireKind(value: unknown): ReachDeckStagedGenerationJobKind {
  if (
    value !== 'lesson-plan' &&
    value !== 'page-outline' &&
    value !== 'page-generation' &&
    value !== 'narration-generation'
  ) {
    throw new Error('Reach Deck recovery job kind is invalid');
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Reach Deck recovery ${label} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const integer = requireNonnegativeInteger(value, label);
  if (integer === 0) throw new Error(`Reach Deck recovery ${label} is invalid`);
  return integer;
}

function requireHash(value: unknown, label: string): string {
  const hash = requireString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Reach Deck recovery ${label} is invalid`);
  }
  return hash;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, 64);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Reach Deck recovery ${label} is invalid`);
  }
  return timestamp;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
