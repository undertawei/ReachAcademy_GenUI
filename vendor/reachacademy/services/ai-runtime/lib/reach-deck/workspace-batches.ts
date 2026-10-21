import { parseReachDeckVoiceSelection, type ReachDeckVoiceSelection } from './voice-selection.js';
import {
  parseReachDeckRegenerationPlan,
  type ReachDeckRegenerationPlan,
} from '@reachany/reach-deck-dsl';
import type { ReachDeckStagedGenerationJobPayload } from './contracts.js';
import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from './resource-scope.js';
import { actorOrganizationIdFromPayload } from './contracts.js';

export const REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION = 'reach-deck-workspace-batch/v1' as const;
export const REACH_DECK_BATCH_COORDINATOR_JOB_SCHEMA_VERSION =
  'reach-deck-batch-coordinator-job/v1' as const;
export const REACH_DECK_BATCH_COORDINATOR_JOB_NAME = 'coordinate-reach-deck-batch' as const;
export const MAX_REACH_DECK_WORKSPACE_BATCH_BYTES = 1024 * 1024;
export const MAX_ACTIVE_REACH_DECK_WORKSPACE_BATCHES_PER_RUN = 2;
export const MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES = 10;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type ReachDeckWorkspaceBatchKind = 'narration' | 'media' | 'regeneration';
export type ReachDeckWorkspaceBatchSourceKind =
  | 'workspace'
  | 'materialized-native'
  | 'materialized-media'
  | 'regeneration';
export type ReachDeckWorkspaceBatchMemberSourceKind =
  | 'workspace'
  | 'materialized-native'
  | 'materialized-interactive';
export type ReachDeckWorkspaceBatchPhase = 'preparing' | 'ready' | 'stopped' | 'terminal';
export type ReachDeckWorkspaceBatchMemberIntent =
  | 'waiting-predecessor'
  | 'waiting-dispatch'
  | 'dispatching'
  | 'dispatched'
  | 'blocked'
  | 'cancelled';
export type ReachDeckWorkspaceBatchMemberTerminalOutcome =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface ReachDeckWorkspaceBatchMember {
  pageId: string;
  order: number;
  sourceKind: ReachDeckWorkspaceBatchMemberSourceKind;
  requestKey: string;
  requestedRevision: number;
  attempt: number;
  intent: ReachDeckWorkspaceBatchMemberIntent;
  contentDigest?: string;
  animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
  narrationMode?: 'saved-content' | 'regenerate-text';
  /** 仅重写讲稿文字（整份讲稿批次的 textOnly 请求）；只在为真时出现。 */
  textOnly?: true;
  supersededAudioResourceId?: string;
  jobId?: string;
  blockedByPageId?: string;
  reason?: string;
  terminalOutcome?: ReachDeckWorkspaceBatchMemberTerminalOutcome;
  /** Authoring-only checkpoint. Exactly one active payload is retained per regeneration batch. */
  regeneration?: {
    plan: ReachDeckRegenerationPlan;
    stage: 'layout' | 'image' | 'narration';
    payload?: ReachDeckStagedGenerationJobPayload;
    completedLayout?: { jobId: string; requestedRevision: number; attempt: number };
  };
}

export interface ReachDeckWorkspaceBatchSkippedMember {
  pageId: string;
  order: number;
  reason: string;
}

export interface ReachDeckWorkspaceBatchCancelRequest {
  requestedAt: string;
  requestHash: string;
}

export interface ReachDeckWorkspaceBatchTerminalSummary {
  completedAt: string;
  status: 'completed' | 'partial-failure' | 'cancelled';
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  cancelled: number;
  skipped: number;
  audioFailed?: number;
}

export interface ReachDeckWorkspaceBatchOwner {
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
}

export interface ReachDeckWorkspaceBatch {
  schemaVersion: typeof REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION;
  batchId: string;
  requestHash: string;
  runId: string;
  owner: ReachDeckWorkspaceBatchOwner;
  kind: ReachDeckWorkspaceBatchKind;
  sourceKind: ReachDeckWorkspaceBatchSourceKind;
  createdAt: string;
  revision: number;
  phase: ReachDeckWorkspaceBatchPhase;
  dispatchCursor: number;
  voiceSelection: ReachDeckVoiceSelection;
  members: ReachDeckWorkspaceBatchMember[];
  skipped: ReachDeckWorkspaceBatchSkippedMember[];
  cancelRequested?: ReachDeckWorkspaceBatchCancelRequest;
  stopReason?: string;
  terminalSummary?: ReachDeckWorkspaceBatchTerminalSummary;
}

export type ReachDeckWorkspaceBatches = Record<string, ReachDeckWorkspaceBatch>;

export interface ReachDeckWorkspaceBatchRequest {
  batchId: string;
  runId: string;
  kind: ReachDeckWorkspaceBatchKind;
  acceptedAt: string;
}

export type ReachDeckWorkspaceBatchRequests = Record<string, ReachDeckWorkspaceBatchRequest>;

export interface ReachDeckBatchCoordinatorJobPayload {
  schemaVersion: typeof REACH_DECK_BATCH_COORDINATOR_JOB_SCHEMA_VERSION;
  kind: 'batch-coordinator';
  jobId: string;
  batchId: string;
  cursor: number;
  createdAt: string;
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
}

export class ReachDeckWorkspaceBatchCapacityError extends Error {
  readonly code = 'BATCH_CAPACITY_EXCEEDED';

  constructor(message = 'Reach Deck workspace batch capacity exceeded') {
    super(message);
    this.name = 'ReachDeckWorkspaceBatchCapacityError';
  }
}

/** 同一文档的图片任务按页互斥，不按协作者分开计费。 */
export class ReachDeckWorkspaceBatchPageInProgressError extends Error {
  readonly status = 409;
  readonly code?: 'image_generation_in_progress';

  constructor(imageActive: boolean) {
    super(
      imageActive
        ? 'Images for this page are already generating'
        : 'This page is already generating',
    );
    this.name = 'ReachDeckWorkspaceBatchPageInProgressError';
    if (imageActive) this.code = 'image_generation_in_progress';
  }
}

export function buildReachDeckBatchCoordinatorJobPayload(
  scope: Pick<
    ReachDeckBatchCoordinatorJobPayload,
    'actorId' | 'actorOrganizationId' | 'billingGroupId' | 'roleGrantId' | 'resourceScope'
  >,
  batchIdValue: string,
  cursorValue: number,
  createdAtValue: string,
): ReachDeckBatchCoordinatorJobPayload {
  const batchId = uuid(batchIdValue, 'batch coordinator batchId');
  const cursor = nonnegativeInteger(cursorValue, 'batch coordinator cursor');
  return {
    schemaVersion: REACH_DECK_BATCH_COORDINATOR_JOB_SCHEMA_VERSION,
    kind: 'batch-coordinator',
    jobId: `rdbc-${batchId}-${cursor}`,
    batchId,
    cursor,
    createdAt: timestamp(createdAtValue, 'batch coordinator createdAt'),
    actorId: string(scope.actorId, 'batch coordinator actorId', 255),
    actorOrganizationId: actorOrganizationIdFromPayload(scope),
    billingGroupId:
      scope.billingGroupId === null
        ? null
        : string(scope.billingGroupId, 'batch coordinator billingGroupId', 255),
    roleGrantId: string(scope.roleGrantId, 'batch coordinator roleGrantId', 255),
    resourceScope: parseReachDeckResourceScope(scope.resourceScope),
  };
}

export function isReachDeckBatchCoordinatorJobPayload(
  value: unknown,
): value is ReachDeckBatchCoordinatorJobPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion ===
      REACH_DECK_BATCH_COORDINATOR_JOB_SCHEMA_VERSION &&
    (value as Record<string, unknown>).kind === 'batch-coordinator'
  );
}

export function parseReachDeckBatchCoordinatorJobPayload(
  value: unknown,
): ReachDeckBatchCoordinatorJobPayload {
  const raw = exactRecord(
    value,
    [
      'schemaVersion',
      'kind',
      'jobId',
      'batchId',
      'cursor',
      'createdAt',
      'actorId',
      'billingGroupId',
      'roleGrantId',
      'resourceScope',
    ],
    'batch coordinator payload',
    ['actorOrganizationId'],
  );
  if (
    raw.schemaVersion !== REACH_DECK_BATCH_COORDINATOR_JOB_SCHEMA_VERSION ||
    raw.kind !== 'batch-coordinator'
  ) {
    throw new Error('Reach Deck batch coordinator contract is invalid');
  }
  const parsed = buildReachDeckBatchCoordinatorJobPayload(
    {
      actorId: string(raw.actorId, 'batch coordinator actorId', 255),
      actorOrganizationId: actorOrganizationIdFromPayload({
        actorOrganizationId: raw.actorOrganizationId,
        resourceScope: parseReachDeckResourceScope(raw.resourceScope),
      }),
      billingGroupId:
        raw.billingGroupId === null
          ? null
          : string(raw.billingGroupId, 'batch coordinator billingGroupId', 255),
      roleGrantId: string(raw.roleGrantId, 'batch coordinator roleGrantId', 255),
      resourceScope: parseReachDeckResourceScope(raw.resourceScope),
    },
    uuid(raw.batchId, 'batch coordinator batchId'),
    nonnegativeInteger(raw.cursor, 'batch coordinator cursor'),
    timestamp(raw.createdAt, 'batch coordinator createdAt'),
  );
  if (raw.jobId !== parsed.jobId) {
    throw new Error('Reach Deck batch coordinator job identity is invalid');
  }
  return parsed;
}

export function parseReachDeckWorkspaceBatches(value: unknown): ReachDeckWorkspaceBatches {
  const record = recordValue(value, 'workspace batches');
  const batches = Object.fromEntries(
    Object.entries(record).map(([batchId, candidate]) => {
      const batch = parseReachDeckWorkspaceBatch(candidate);
      if (batch.batchId !== batchId) {
        throw new Error('Reach Deck workspace batch map key is invalid');
      }
      return [batchId, batch];
    }),
  );
  assertReachDeckWorkspaceBatchCapacity(batches);
  return batches;
}

export function parseReachDeckWorkspaceBatchRequests(
  value: unknown,
): ReachDeckWorkspaceBatchRequests {
  const record = recordValue(value, 'workspace batch requests');
  return Object.fromEntries(
    Object.entries(record).map(([requestHash, candidate]) => {
      const raw = exactRecord(
        candidate,
        ['batchId', 'runId', 'kind', 'acceptedAt'],
        'workspace batch request',
      );
      return [
        hash(requestHash, 'batch request map key'),
        {
          batchId: uuid(raw.batchId, 'batch request batchId'),
          runId: string(raw.runId, 'batch request runId', 100),
          kind: batchKind(raw.kind),
          acceptedAt: timestamp(raw.acceptedAt, 'batch request acceptedAt'),
        },
      ];
    }),
  );
}

export function parseReachDeckWorkspaceBatch(value: unknown): ReachDeckWorkspaceBatch {
  const raw = exactRecord(
    value,
    [
      'schemaVersion',
      'batchId',
      'requestHash',
      'runId',
      'owner',
      'kind',
      'sourceKind',
      'createdAt',
      'revision',
      'phase',
      'dispatchCursor',
      'voiceSelection',
      'members',
      'skipped',
    ],
    'workspace batch',
    ['cancelRequested', 'stopReason', 'terminalSummary'],
  );
  if (raw.schemaVersion !== REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION) {
    throw new Error('Reach Deck workspace batch schemaVersion is invalid');
  }
  const batchId = uuid(raw.batchId, 'batchId');
  const requestHash = hash(raw.requestHash, 'batch requestHash');
  const runId = string(raw.runId, 'batch runId', 100);
  const owner = parseBatchOwner(raw.owner);
  const kind = batchKind(raw.kind);
  const sourceKind = batchSourceKind(raw.sourceKind);
  const createdAt = timestamp(raw.createdAt, 'batch createdAt');
  const revision = nonnegativeInteger(raw.revision, 'batch revision');
  const phase = batchPhase(raw.phase);
  if (!Array.isArray(raw.members) || raw.members.length < 1) {
    throw new Error('Reach Deck workspace batch members are invalid');
  }
  const members = raw.members.map((member, index) => parseBatchMember(member, index, sourceKind));
  const pageIds = new Set<string>();
  const orders = new Set<number>();
  const requestKeys = new Set<string>();
  const jobIds = new Set<string>();
  for (const member of members) {
    if (
      pageIds.has(member.pageId) ||
      orders.has(member.order) ||
      requestKeys.has(member.requestKey)
    ) {
      throw new Error('Reach Deck workspace batch members must be unique');
    }
    if (member.jobId !== undefined && jobIds.has(member.jobId)) {
      throw new Error('Reach Deck workspace batch job identities must be unique');
    }
    pageIds.add(member.pageId);
    orders.add(member.order);
    requestKeys.add(member.requestKey);
    if (member.jobId !== undefined) jobIds.add(member.jobId);
  }
  if (members.some((member, index) => member.order !== index)) {
    throw new Error('Reach Deck workspace batch member order is invalid');
  }
  if (!Array.isArray(raw.skipped)) {
    throw new Error('Reach Deck workspace batch skipped members are invalid');
  }
  const skipped = raw.skipped.map((item, index) => parseSkippedMember(item, index));
  for (const skippedMember of skipped) {
    if (pageIds.has(skippedMember.pageId)) {
      throw new Error('Reach Deck workspace batch page cannot be both a member and skipped');
    }
    pageIds.add(skippedMember.pageId);
  }
  const dispatchCursor = nonnegativeInteger(raw.dispatchCursor, 'batch dispatchCursor');
  if (dispatchCursor > members.length) {
    throw new Error('Reach Deck workspace batch dispatchCursor is invalid');
  }
  const cancelRequested =
    raw.cancelRequested === undefined ? undefined : parseCancelRequest(raw.cancelRequested);
  const stopReason =
    raw.stopReason === undefined ? undefined : string(raw.stopReason, 'batch stopReason', 128);
  const terminalSummary =
    raw.terminalSummary === undefined ? undefined : parseTerminalSummary(raw.terminalSummary);
  if ((phase === 'terminal') !== (terminalSummary !== undefined)) {
    throw new Error('Reach Deck terminal batch summary is invalid');
  }
  if (phase === 'stopped' && stopReason === undefined) {
    throw new Error('Reach Deck stopped batch reason is missing');
  }
  if (terminalSummary !== undefined && terminalSummary.total !== members.length + skipped.length) {
    throw new Error('Reach Deck terminal batch total is invalid');
  }
  const parsed: ReachDeckWorkspaceBatch = {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId,
    requestHash,
    runId,
    owner,
    kind,
    sourceKind,
    createdAt,
    revision,
    phase,
    dispatchCursor,
    voiceSelection: parseReachDeckVoiceSelection(raw.voiceSelection),
    members,
    skipped,
    ...(cancelRequested === undefined ? {} : { cancelRequested }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(terminalSummary === undefined ? {} : { terminalSummary }),
  };
  if (jsonBytes(parsed) > MAX_REACH_DECK_WORKSPACE_BATCH_BYTES) {
    throw new ReachDeckWorkspaceBatchCapacityError('Reach Deck workspace batch exceeds 1 MiB');
  }
  return parsed;
}

export function parseReachDeckWorkspaceBatchId(value: unknown): string {
  return uuid(value, 'batchId');
}

export function buildReachDeckWorkspaceBatchId(requestHashValue: string): string {
  const source = hash(requestHashValue, 'batch requestHash').slice(0, 32).split('');
  source[12] = '4';
  source[16] = ((Number.parseInt(source[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = source.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sameReachDeckWorkspaceBatchOwner(
  batch: Pick<ReachDeckWorkspaceBatch, 'owner'>,
  scope: ReachDeckWorkspaceBatchOwner,
): boolean {
  return (
    batch.owner.actorId === scope.actorId &&
    actorOrganizationIdFromPayload(batch.owner) === actorOrganizationIdFromPayload(scope) &&
    batch.owner.billingGroupId === scope.billingGroupId &&
    batch.owner.roleGrantId === scope.roleGrantId &&
    sameReachDeckResourceScope(batch.owner.resourceScope, scope.resourceScope)
  );
}

export function assertReachDeckWorkspaceBatchCapacity(batches: ReachDeckWorkspaceBatches): void {
  const active = Object.values(batches).filter(
    (batch) => batch.phase !== 'terminal' && batch.phase !== 'stopped',
  );
  const perRun = new Map<string, ReachDeckWorkspaceBatch[]>();
  for (const batch of active) {
    const siblings = perRun.get(batch.runId) ?? [];
    siblings.push(batch);
    perRun.set(batch.runId, siblings);
  }
  for (const siblings of perRun.values()) {
    if (siblings.length > MAX_ACTIVE_REACH_DECK_WORKSPACE_BATCHES_PER_RUN) {
      throw new ReachDeckWorkspaceBatchCapacityError();
    }
    if (new Set(siblings.map((batch) => batch.kind)).size !== siblings.length) {
      throw new ReachDeckWorkspaceBatchCapacityError(
        'Reach Deck workspace allows only one active batch for each kind',
      );
    }
  }
  const terminal = Object.values(batches).filter((batch) => batch.phase === 'terminal');
  if (terminal.length > MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES) {
    throw new ReachDeckWorkspaceBatchCapacityError(
      'Reach Deck workspace retains at most ten terminal batches',
    );
  }
}

export function retainRecentReachDeckWorkspaceBatches(
  batches: ReachDeckWorkspaceBatches,
): ReachDeckWorkspaceBatches {
  const retained = Object.values(batches).filter((batch) => batch.phase !== 'terminal');
  const terminal = Object.values(batches)
    .filter((batch) => batch.phase === 'terminal')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES);
  return Object.fromEntries([...retained, ...terminal].map((batch) => [batch.batchId, batch]));
}

function parseBatchMember(
  value: unknown,
  index: number,
  sourceKind: ReachDeckWorkspaceBatchSourceKind,
): ReachDeckWorkspaceBatchMember {
  const raw = exactRecord(
    value,
    ['pageId', 'order', 'sourceKind', 'requestKey', 'requestedRevision', 'attempt', 'intent'],
    `workspace batch member ${index}`,
    [
      'contentDigest',
      'animationMode',
      'narrationMode',
      'textOnly',
      'supersededAudioResourceId',
      'jobId',
      'blockedByPageId',
      'reason',
      'terminalOutcome',
      'regeneration',
    ],
  );
  const parsedSourceKind = batchMemberSourceKind(raw.sourceKind);
  if (
    (sourceKind === 'materialized-media' &&
      parsedSourceKind !== 'materialized-native' &&
      parsedSourceKind !== 'materialized-interactive') ||
    (sourceKind !== 'materialized-media' &&
      sourceKind !== 'regeneration' &&
      parsedSourceKind !== sourceKind)
  ) {
    throw new Error('Reach Deck workspace batch member sourceKind is invalid');
  }
  const intent = memberIntent(raw.intent);
  const blockedByPageId =
    raw.blockedByPageId === undefined
      ? undefined
      : string(raw.blockedByPageId, 'batch member blockedByPageId', 256);
  const reason =
    raw.reason === undefined ? undefined : string(raw.reason, 'batch member reason', 128);
  const terminalOutcome =
    raw.terminalOutcome === undefined ? undefined : memberTerminalOutcome(raw.terminalOutcome);
  const contentDigest =
    raw.contentDigest === undefined
      ? undefined
      : hash(raw.contentDigest, 'batch member contentDigest');
  const animationMode =
    raw.animationMode === undefined
      ? undefined
      : narrationAnimationMode(raw.animationMode, 'batch member animationMode');
  const narrationMode = raw.narrationMode;
  if (
    narrationMode !== undefined &&
    (sourceKind !== 'materialized-native' ||
      (narrationMode !== 'saved-content' && narrationMode !== 'regenerate-text'))
  ) {
    throw new Error('Reach Deck batch member narrationMode is invalid');
  }
  // 仅重写文字只属于原生讲稿批次的重写正文成员：不能与已存正文、动画模式或内容 digest 组合。
  if (
    raw.textOnly !== undefined &&
    (raw.textOnly !== true ||
      sourceKind !== 'materialized-native' ||
      narrationMode === 'saved-content' ||
      animationMode !== undefined ||
      contentDigest !== undefined)
  ) {
    throw new Error('Reach Deck batch member textOnly is invalid');
  }
  const supersededAudioResourceId =
    raw.supersededAudioResourceId === undefined
      ? undefined
      : string(raw.supersededAudioResourceId, 'batch member supersededAudioResourceId', 256);
  if (intent === 'blocked' && (blockedByPageId === undefined || reason === undefined)) {
    throw new Error('Reach Deck blocked batch member reason is invalid');
  }
  if (intent !== 'blocked' && blockedByPageId !== undefined) {
    throw new Error('Reach Deck batch member blockedByPageId is invalid');
  }
  if (sourceKind === 'materialized-media' && contentDigest === undefined) {
    throw new Error('Reach Deck media batch member contentDigest is required');
  }
  // 讲稿批次派发时按当前讲稿生成，不再登记 digest；只为存量已存讲稿成员保留可选读取。
  if (
    sourceKind !== 'materialized-media' &&
    narrationMode !== 'saved-content' &&
    contentDigest !== undefined
  ) {
    throw new Error('Reach Deck narration batch member contentDigest is invalid');
  }
  if (
    animationMode !== undefined &&
    ((sourceKind !== 'materialized-media' && narrationMode === undefined) ||
      parsedSourceKind !== 'materialized-native')
  ) {
    throw new Error('Reach Deck batch member animationMode is invalid');
  }
  if (
    supersededAudioResourceId !== undefined &&
    (sourceKind !== 'materialized-media' || parsedSourceKind !== 'materialized-interactive')
  ) {
    throw new Error('Reach Deck batch member supersededAudioResourceId is invalid');
  }
  return {
    pageId: string(raw.pageId, 'batch member pageId', 256),
    order: nonnegativeInteger(raw.order, 'batch member order'),
    sourceKind: parsedSourceKind,
    requestKey: string(raw.requestKey, 'batch member requestKey', 256),
    requestedRevision: nonnegativeInteger(raw.requestedRevision, 'batch member requestedRevision'),
    attempt: positiveInteger(raw.attempt, 'batch member attempt'),
    intent,
    ...(contentDigest === undefined ? {} : { contentDigest }),
    ...(animationMode === undefined ? {} : { animationMode }),
    ...(narrationMode === undefined ? {} : { narrationMode }),
    ...(raw.textOnly === true ? { textOnly: true as const } : {}),
    ...(supersededAudioResourceId === undefined ? {} : { supersededAudioResourceId }),
    ...(raw.jobId === undefined ? {} : { jobId: string(raw.jobId, 'batch member jobId', 128) }),
    ...(blockedByPageId === undefined ? {} : { blockedByPageId }),
    ...(raw.regeneration === undefined
      ? {}
      : { regeneration: parseMemberRegeneration(raw.regeneration) }),
    ...(reason === undefined ? {} : { reason }),
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
  };
}

function parseSkippedMember(value: unknown, index: number): ReachDeckWorkspaceBatchSkippedMember {
  const raw = exactRecord(
    value,
    ['pageId', 'order', 'reason'],
    `workspace batch skipped member ${index}`,
  );
  return {
    pageId: string(raw.pageId, 'batch skipped pageId', 256),
    order: nonnegativeInteger(raw.order, 'batch skipped order'),
    reason: string(raw.reason, 'batch skipped reason', 128),
  };
}

function parseCancelRequest(value: unknown): ReachDeckWorkspaceBatchCancelRequest {
  const raw = exactRecord(value, ['requestedAt', 'requestHash'], 'workspace batch cancel request');
  return {
    requestedAt: timestamp(raw.requestedAt, 'batch cancel requestedAt'),
    requestHash: hash(raw.requestHash, 'batch cancel requestHash'),
  };
}

function parseBatchOwner(value: unknown): ReachDeckWorkspaceBatchOwner {
  const raw = exactRecord(
    value,
    ['actorId', 'billingGroupId', 'roleGrantId', 'resourceScope'],
    'workspace batch owner',
    ['actorOrganizationId'],
  );
  return {
    actorId: string(raw.actorId, 'batch owner actorId', 255),
    actorOrganizationId: actorOrganizationIdFromPayload({
      actorOrganizationId: raw.actorOrganizationId,
      resourceScope: parseReachDeckResourceScope(raw.resourceScope),
    }),
    billingGroupId:
      raw.billingGroupId === null
        ? null
        : string(raw.billingGroupId, 'batch owner billingGroupId', 255),
    roleGrantId: string(raw.roleGrantId, 'batch owner roleGrantId', 255),
    resourceScope: parseReachDeckResourceScope(raw.resourceScope),
  };
}

function parseTerminalSummary(value: unknown): ReachDeckWorkspaceBatchTerminalSummary {
  const raw = exactRecord(
    value,
    ['completedAt', 'status', 'total', 'succeeded', 'failed', 'blocked', 'cancelled', 'skipped'],
    'workspace batch terminal summary',
    ['audioFailed'],
  );
  if (
    raw.status !== 'completed' &&
    raw.status !== 'partial-failure' &&
    raw.status !== 'cancelled'
  ) {
    throw new Error('Reach Deck workspace batch terminal status is invalid');
  }
  const summary: ReachDeckWorkspaceBatchTerminalSummary = {
    completedAt: timestamp(raw.completedAt, 'batch terminal completedAt'),
    status: raw.status as ReachDeckWorkspaceBatchTerminalSummary['status'],
    total: nonnegativeInteger(raw.total, 'batch terminal total'),
    succeeded: nonnegativeInteger(raw.succeeded, 'batch terminal succeeded'),
    failed: nonnegativeInteger(raw.failed, 'batch terminal failed'),
    blocked: nonnegativeInteger(raw.blocked, 'batch terminal blocked'),
    cancelled: nonnegativeInteger(raw.cancelled, 'batch terminal cancelled'),
    skipped: nonnegativeInteger(raw.skipped, 'batch terminal skipped'),
    ...(raw.audioFailed === undefined
      ? {}
      : { audioFailed: nonnegativeInteger(raw.audioFailed, 'batch terminal audioFailed') }),
  };
  if (
    summary.succeeded + summary.failed + summary.blocked + summary.cancelled + summary.skipped !==
    summary.total
  ) {
    throw new Error('Reach Deck workspace batch terminal counts are invalid');
  }
  if ((summary.audioFailed ?? 0) > summary.succeeded) {
    throw new Error('Reach Deck workspace batch audio failure count is invalid');
  }
  return summary;
}

function batchKind(value: unknown): ReachDeckWorkspaceBatchKind {
  if (value === 'narration' || value === 'media' || value === 'regeneration') return value;
  throw new Error('Reach Deck workspace batch kind is invalid');
}

function batchSourceKind(value: unknown): ReachDeckWorkspaceBatchSourceKind {
  if (
    value === 'workspace' ||
    value === 'materialized-native' ||
    value === 'materialized-media' ||
    value === 'regeneration'
  ) {
    return value;
  }
  throw new Error('Reach Deck workspace batch sourceKind is invalid');
}

function parseMemberRegeneration(
  value: unknown,
): NonNullable<ReachDeckWorkspaceBatchMember['regeneration']> {
  const raw = exactRecord(value, ['plan', 'stage'], 'member regeneration', [
    'payload',
    'completedLayout',
  ]);
  if (raw.stage !== 'layout' && raw.stage !== 'narration' && raw.stage !== 'image')
    throw new Error('Regeneration stage is invalid');
  let completedLayout: NonNullable<
    ReachDeckWorkspaceBatchMember['regeneration']
  >['completedLayout'];
  if (raw.completedLayout !== undefined) {
    const completed = exactRecord(
      raw.completedLayout,
      ['jobId', 'requestedRevision', 'attempt'],
      'completed layout',
    );
    completedLayout = {
      jobId: string(completed.jobId, 'completed layout jobId', 128),
      requestedRevision: nonnegativeInteger(
        completed.requestedRevision,
        'completed layout revision',
      ),
      attempt: positiveInteger(completed.attempt, 'completed layout attempt'),
    };
  }
  if (raw.payload !== undefined) recordValue(raw.payload, 'regeneration payload');
  return {
    plan: parseReachDeckRegenerationPlan(raw.plan),
    stage: raw.stage,
    ...(raw.payload === undefined
      ? {}
      : { payload: raw.payload as ReachDeckStagedGenerationJobPayload }),
    ...(completedLayout === undefined ? {} : { completedLayout }),
  };
}

function batchMemberSourceKind(value: unknown): ReachDeckWorkspaceBatchMemberSourceKind {
  if (
    value === 'workspace' ||
    value === 'materialized-native' ||
    value === 'materialized-interactive'
  ) {
    return value;
  }
  throw new Error('Reach Deck workspace batch member sourceKind is invalid');
}

function batchPhase(value: unknown): ReachDeckWorkspaceBatchPhase {
  if (value === 'preparing' || value === 'ready' || value === 'stopped' || value === 'terminal') {
    return value;
  }
  throw new Error('Reach Deck workspace batch phase is invalid');
}

function memberIntent(value: unknown): ReachDeckWorkspaceBatchMemberIntent {
  if (
    value === 'waiting-predecessor' ||
    value === 'waiting-dispatch' ||
    value === 'dispatching' ||
    value === 'dispatched' ||
    value === 'blocked' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new Error('Reach Deck workspace batch member intent is invalid');
}

function memberTerminalOutcome(value: unknown): ReachDeckWorkspaceBatchMemberTerminalOutcome {
  if (value === 'completed' || value === 'failed' || value === 'blocked' || value === 'cancelled') {
    return value;
  }
  throw new Error('Reach Deck workspace batch member terminalOutcome is invalid');
}

function narrationAnimationMode(
  value: unknown,
  label: string,
): 'preserve' | 'regenerate' | 'animations' | 'skip' {
  if (value === 'preserve' || value === 'regenerate' || value === 'animations' || value === 'skip')
    return value;
  throw new Error(`Reach Deck ${label} is invalid`);
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

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`Reach Deck ${label} is invalid`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const candidate = string(value, label, 36);
  if (!UUID_PATTERN.test(candidate)) throw new Error(`Reach Deck ${label} is invalid`);
  return candidate.toLowerCase();
}

function hash(value: unknown, label: string): string {
  const candidate = string(value, label, 64);
  if (!HASH_PATTERN.test(candidate)) throw new Error(`Reach Deck ${label} is invalid`);
  return candidate;
}

function timestamp(value: unknown, label: string): string {
  const candidate = string(value, label, 64);
  if (Number.isNaN(Date.parse(candidate))) throw new Error(`Reach Deck ${label} is invalid`);
  return candidate;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Reach Deck ${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result === 0) throw new Error(`Reach Deck ${label} is invalid`);
  return result;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** 公开阶段投影；持久计划和冻结载荷仅保留在创作恢复数据中。 */
export function reachDeckRegenerationMemberMetadata(member: ReachDeckWorkspaceBatchMember): {
  generationKind?: 'page-generation' | 'narration-generation';
  affectedLanes?: ('layout' | 'narration' | 'audio' | 'animation' | 'image')[];
} {
  const checkpoint = member.regeneration;
  if (!checkpoint) return {};
  return {
    generationKind: checkpoint.stage !== 'narration' ? 'page-generation' : 'narration-generation',
    affectedLanes:
      checkpoint.stage === 'image'
        ? ['image']
        : checkpoint.stage === 'layout'
          ? (['layout', 'narration', 'audio', 'animation'] as const).filter(
              (lane) => checkpoint.plan.channels[lane],
            )
          : (['narration', 'audio', 'animation'] as const).filter(
              (lane) => checkpoint.plan.channels[lane],
            ),
  };
}
