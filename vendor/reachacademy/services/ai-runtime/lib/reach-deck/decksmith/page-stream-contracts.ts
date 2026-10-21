import { createHash } from 'node:crypto';
import {
  isDecksmithPromptContractVersion,
  type DecksmithPromptContractVersion,
} from './prompt-contract-version.js';

import type { ReachDeckResourceScope } from '../resource-scope.js';
import { parseReachDeckResourceScope } from '../resource-scope.js';
import {
  parseScientificContextSnapshot,
  type ScientificContextSnapshot,
} from '../scientific-generation-context.js';
import {
  DEFAULT_REACH_DECK_VOICE_SELECTION,
  parseReachDeckVoiceSelection,
  type ReachDeckVoiceSelection,
} from '../voice-selection.js';
import {
  parseDecksmithFrozenVisualInputs,
  type DecksmithFrozenVisualInputs,
} from './visual-input-contract.js';
import {
  parseDecksmithClarificationAnswer,
  type DecksmithClarificationAnswer,
} from './clarification-contract.js';

export const DECKSMITH_PAGE_STREAM_SCHEMA_VERSION = 'reach-deck-decksmith-page-stream/v1' as const;
export const DECKSMITH_PAGE_STREAM_CONTEXT_SCHEMA_VERSION =
  'reach-deck-decksmith-page-stream-context/v1' as const;
export const DECKSMITH_PAGE_TURN_SCHEMA_VERSION = 'reach-deck-decksmith-page-turn/v1' as const;
export const DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION =
  'reach-deck-decksmith-control-boundary/v1' as const;
export const DECKSMITH_CONTEXT_REF_SCHEMA_VERSION = 'reach-deck-decksmith-context-ref/v1' as const;
export const DECKSMITH_EPOCH_SCHEMA_VERSION = 'reach-deck-decksmith-epoch/v1' as const;
export const DECKSMITH_SUMMARY_SCHEMA_VERSION = 'reach-deck-decksmith-summary/v1' as const;
export const DECKSMITH_SUMMARY_REF_SCHEMA_VERSION = 'reach-deck-decksmith-summary-ref/v1' as const;
export const DECKSMITH_CUTOFF_SCHEMA_VERSION = 'reach-deck-decksmith-cutoff/v1' as const;
export const DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION =
  'reach-deck-decksmith-frozen-run-input/v1' as const;
export const DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION =
  'reach-deck-decksmith-frozen-run-input/v2' as const;
export const DECKSMITH_CAPACITY_SNAPSHOT_SCHEMA_VERSION =
  'reach-deck-decksmith-capacity-snapshot/v1' as const;
export const DECKSMITH_CONTEXT_PLAN_SCHEMA_VERSION =
  'reach-deck-decksmith-context-plan/v1' as const;
export const DECKSMITH_COMPACTION_RUN_INPUT_SCHEMA_VERSION =
  'reach-deck-decksmith-compaction-run-input/v1' as const;
export const DECKSMITH_APPLICATION_MESSAGE_SCHEMA_VERSION =
  'reach-deck-decksmith-application-message/v1' as const;
export const DECKSMITH_PAGE_MEDIA_STATUS_SCHEMA_VERSION =
  'reach-deck-decksmith-page-media-status/v1' as const;
/**
 * 历史投影版本：缺省（旧 Run / 旧压缩输入）= v1，只投影教师原话与 result 套话；
 * v2 = 实际答复 + 结构化变更 + 入队时已知的提案结局 + 当轮选区描述。
 */
export const DECKSMITH_TURN_PROJECTION_V2 = 2 as const;
/**
 * 提案结局。approved / rejected / pending / superseded 是 WP1 的推导结果（旧冻结快照只含这四种）；
 * adopted / stale 是 WP8 持久化的真实采用结局，只会出现在 WP8 之后入队的新 Run 快照里，
 * 旧快照的结局行因此逐字节不变（评审 M1）。
 */
export const DECKSMITH_PROPOSAL_OUTCOMES = Object.freeze([
  'approved',
  'rejected',
  'pending',
  'superseded',
  'adopted',
  'stale',
] as const);
export type DecksmithProposalOutcome = (typeof DECKSMITH_PROPOSAL_OUTCOMES)[number];
/** 选区可读提示（alt / 文本前缀）的字符上限；只存纯文本，不存 URL、base64。 */
export const DECKSMITH_CONTEXT_REF_HINT_CHARACTERS = 80;

export const DECKSMITH_PAGE_STREAM_LIMITS = Object.freeze({
  identifierCharacters: 256,
  labelCharacters: 500,
  displayCharacters: 2_000,
  messageCharacters: 100_000,
  summaryCharacters: 100_000,
  frozenInputBytes: 1024 * 1024,
  summaryBytes: 256 * 1024,
  refs: 100,
  includedRuns: 500,
  factArrayEntries: 100,
  factTotalNodes: 2_000,
  factDepth: 6,
  factObjectEntries: 100,
  factStringCharacters: 20_000,
  historyPage: 100,
  eventsPerRun: 200,
});

export interface DecksmithPageStreamScope extends ReachDeckResourceScope {
  readonly pageId: string;
}

/** Exact `domain_scope` projection. Values are identifiers only; display text is forbidden here. */
export interface DecksmithPageStreamDomainScope {
  readonly [key: string]: string;
  readonly organizationId: string;
  readonly courseId: string;
  readonly courseNodeId: string;
  readonly moduleId: string;
  readonly moduleVersionId: string;
  readonly pageId: string;
}

export interface DecksmithPageStreamPosition {
  readonly schemaVersion: typeof DECKSMITH_PAGE_STREAM_SCHEMA_VERSION;
  readonly pageId: string;
  readonly sequence: number;
  readonly epoch: number;
  readonly contextRevision: number;
}

export interface DecksmithPageEpoch {
  readonly schemaVersion: typeof DECKSMITH_EPOCH_SCHEMA_VERSION;
  readonly epoch: number;
  readonly startedAfterSequence: number;
  readonly boundaryRunId?: string;
}

export interface DecksmithPageVisibilityCutoff {
  readonly schemaVersion: typeof DECKSMITH_CUTOFF_SCHEMA_VERSION;
  readonly kind: 'visibility';
  readonly sequence: number;
  readonly controlRunId: string;
}

export interface DecksmithPageStreamContext {
  readonly schemaVersion: typeof DECKSMITH_PAGE_STREAM_CONTEXT_SCHEMA_VERSION;
  readonly streamSequence: number;
  readonly contextRevision: number;
  readonly currentEpoch: DecksmithPageEpoch;
  readonly modelContextCutoffSequence: number;
  readonly visibilityCutoff?: DecksmithPageVisibilityCutoff;
  /** Metadata-only pointer. Readable summary facts belong in an authorized run input. */
  readonly summary?: DecksmithPageSummaryRef;
}

export type DecksmithPageMediaState = 'not-started' | 'generating' | 'completed' | 'failed';

/** Authoritative media-generation snapshot frozen with each Decksmith turn. */
export interface DecksmithPageMediaStatus {
  readonly schemaVersion: typeof DECKSMITH_PAGE_MEDIA_STATUS_SCHEMA_VERSION;
  readonly pageId: string;
  readonly narration: DecksmithPageMediaState;
  readonly audio: DecksmithPageMediaState;
  readonly animation: DecksmithPageMediaState;
  readonly reasonCode?: string;
}

export type DecksmithContextRef =
  | {
      readonly schemaVersion: typeof DECKSMITH_CONTEXT_REF_SCHEMA_VERSION;
      readonly kind: 'page';
      readonly pageId: string;
      readonly label: string;
      readonly order: number;
      readonly revision: number;
      readonly baseline: {
        readonly documentId: string;
        readonly documentHash: string;
      };
    }
  | {
      readonly schemaVersion: typeof DECKSMITH_CONTEXT_REF_SCHEMA_VERSION;
      readonly kind: 'native-element' | 'interactive-component';
      readonly pageId: string;
      readonly pageLabel: string;
      readonly pageOrder: number;
      readonly pageRevision: number;
      readonly sceneId: string;
      readonly sceneType: 'slide' | 'interactive';
      readonly componentId: string;
      readonly componentType: string;
      readonly display: {
        readonly label: string;
        readonly detail?: string;
      };
      readonly baseline: {
        readonly documentId: string;
        readonly documentHash: string;
        readonly pageRevision: number;
        readonly componentHash: string;
      };
    };

export interface DecksmithPageTurn {
  readonly schemaVersion: typeof DECKSMITH_PAGE_TURN_SCHEMA_VERSION;
  readonly kind: 'turn';
  readonly role: 'teacher' | 'assistant';
  readonly stream: DecksmithPageStreamPosition;
  readonly text: string;
  readonly contextRefs: readonly DecksmithContextRef[];
}

export interface DecksmithApplicationMessage {
  readonly schemaVersion: typeof DECKSMITH_PAGE_TURN_SCHEMA_VERSION;
  readonly kind: 'application';
  readonly stream: DecksmithPageStreamPosition;
  readonly messageKey: string;
  readonly replacements: Readonly<Record<string, string>>;
}

export type DecksmithPageControlBoundary =
  | {
      readonly schemaVersion: typeof DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION;
      readonly kind: 'new-topic';
      readonly stream: DecksmithPageStreamPosition;
      readonly previousEpoch: number;
      readonly nextEpoch: number;
      readonly message: DecksmithApplicationMessage;
    }
  | {
      readonly schemaVersion: typeof DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION;
      readonly kind: 'soft-delete';
      readonly stream: DecksmithPageStreamPosition;
      readonly visibilityCutoffSequence: number;
      readonly modelContextCutoffSequence: number;
    };

export interface DecksmithControlRunInput {
  readonly schemaVersion: 'reach-deck-decksmith-control-run-input/v1';
  readonly kind: 'decksmith-control';
  readonly message: '';
  readonly control: DecksmithPageControlBoundary;
}

export interface DecksmithPageSummary {
  readonly schemaVersion: typeof DECKSMITH_SUMMARY_SCHEMA_VERSION;
  readonly kind: 'summary';
  readonly revision: number;
  readonly epoch: number;
  readonly metadata?: {
    readonly pageId: string;
    readonly status: 'created' | 'installed';
    readonly previousSummaryDigest?: string;
    readonly capacityProfileVersion: string;
    readonly estimatorVersion: string;
    readonly capacityUnit: string;
  };
  readonly source: {
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly firstRunId: string;
    readonly lastRunId: string;
    readonly digest: string;
  };
  /** Authorized body fact; never copy this field into `domain_scope` or monitoring projections. */
  readonly text: string;
  readonly pageFacts: readonly Readonly<Record<string, unknown>>[];
  readonly unresolvedDecisions: readonly Readonly<Record<string, unknown>>[];
  readonly proposalOutcomes: readonly Readonly<Record<string, unknown>>[];
  readonly previousSummary?: {
    readonly runId: string;
    readonly revision: number;
    readonly digest: string;
  };
  readonly provenance?: {
    readonly creationRunId: string;
    readonly modelUsageDigest: string;
    readonly sourcePlanDigest: string;
  };
}

export interface DecksmithPageSummaryRef {
  readonly schemaVersion: typeof DECKSMITH_SUMMARY_REF_SCHEMA_VERSION;
  readonly kind: 'summary-ref';
  readonly runId: string;
  readonly revision: number;
  readonly epoch: number;
  readonly sourceDigest: string;
  /** Digest of the exact authorized summary body. Optional only for legacy refs. */
  readonly summaryDigest?: string;
  /** Last raw turn covered by the rolling summary. Optional only for legacy refs. */
  readonly sourceLastSequence?: number;
}

export type DecksmithSummaryOrCutoff =
  | DecksmithPageSummary
  | {
      readonly schemaVersion: typeof DECKSMITH_CUTOFF_SCHEMA_VERSION;
      readonly kind: 'deterministic-cutoff';
      readonly epoch: number;
      readonly afterSequence: number;
      readonly reason: 'no-summary' | 'visibility-cutoff' | 'compaction-fallback';
    };

export type DecksmithCapacityState = 'ordinary' | 'approaching' | 'needs_compaction' | 'blocked';

const DECKSMITH_CAPACITY_APPLICATION_MESSAGE_KEYS = Object.freeze({
  ordinary: 'reachDeck.decksmith.capacity.ordinary',
  approaching: 'reachDeck.decksmith.capacity.approaching',
  needs_compaction: 'reachDeck.decksmith.capacity.compacting',
  blocked: 'reachDeck.decksmith.capacity.blocked',
} as const);
const DECKSMITH_CAPACITY_APPLICATION_GUIDANCE_KEY =
  'reachDeck.decksmith.capacity.startNewTopic' as const;

export interface DecksmithCapacityApplicationMessage {
  readonly schemaVersion: typeof DECKSMITH_APPLICATION_MESSAGE_SCHEMA_VERSION;
  readonly kind: 'capacity';
  readonly state: DecksmithCapacityState;
  readonly messageKey: (typeof DECKSMITH_CAPACITY_APPLICATION_MESSAGE_KEYS)[DecksmithCapacityState];
  readonly guidance?: {
    readonly action: 'new-topic';
    readonly messageKey: typeof DECKSMITH_CAPACITY_APPLICATION_GUIDANCE_KEY;
  };
}

export function parseDecksmithCapacityApplicationMessage(
  value: unknown,
): DecksmithCapacityApplicationMessage {
  const message = exactObject(
    value,
    ['schemaVersion', 'kind', 'state', 'messageKey'],
    ['guidance'],
    'Decksmith capacity application message',
  );
  const state = message.state;
  if (
    message.schemaVersion !== DECKSMITH_APPLICATION_MESSAGE_SCHEMA_VERSION ||
    message.kind !== 'capacity' ||
    (state !== 'ordinary' &&
      state !== 'approaching' &&
      state !== 'needs_compaction' &&
      state !== 'blocked') ||
    message.messageKey !== DECKSMITH_CAPACITY_APPLICATION_MESSAGE_KEYS[state]
  ) {
    throw new Error('Decksmith capacity application message is invalid');
  }
  let guidance: DecksmithCapacityApplicationMessage['guidance'];
  if (message.guidance !== undefined) {
    const parsed = exactObject(
      message.guidance,
      ['action', 'messageKey'],
      [],
      'Decksmith capacity application guidance',
    );
    if (
      (state !== 'needs_compaction' && state !== 'blocked') ||
      parsed.action !== 'new-topic' ||
      parsed.messageKey !== DECKSMITH_CAPACITY_APPLICATION_GUIDANCE_KEY
    ) {
      throw new Error('Decksmith capacity application guidance is invalid');
    }
    guidance = Object.freeze({
      action: 'new-topic',
      messageKey: DECKSMITH_CAPACITY_APPLICATION_GUIDANCE_KEY,
    });
  }
  if (state === 'blocked' && guidance === undefined) {
    throw new Error('Decksmith blocked capacity application guidance is required');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_APPLICATION_MESSAGE_SCHEMA_VERSION,
    kind: 'capacity',
    state,
    messageKey: DECKSMITH_CAPACITY_APPLICATION_MESSAGE_KEYS[state],
    ...(guidance === undefined ? {} : { guidance }),
  });
}

export interface DecksmithFrozenCapacitySnapshot {
  readonly schemaVersion: typeof DECKSMITH_CAPACITY_SNAPSHOT_SCHEMA_VERSION;
  readonly capacityProfileVersion: string;
  readonly estimatorVersion: string;
  readonly capacityUnit: string;
  readonly guaranteedInputCapacity: number;
  readonly reservedOutputCapacity: number;
  readonly estimatedInput: number;
  readonly thresholds: {
    readonly approaching: number;
    readonly needsCompaction: number;
    readonly blocked: number;
  };
  readonly state: DecksmithCapacityState;
  readonly messageKey: string;
  readonly provenance:
    | { readonly kind: 'model-service' }
    | { readonly kind: 'conservative-fallback'; readonly fallbackVersion: string };
  readonly inputMeasure: {
    readonly serializedInputUtf8Bytes: number;
    readonly structuralItemCount: number;
    readonly digest: string;
  };
}

export interface DecksmithFrozenContextPlan {
  readonly schemaVersion: typeof DECKSMITH_CONTEXT_PLAN_SCHEMA_VERSION;
  readonly selectionAlgorithmVersion: string;
  readonly transcriptSourceDigest: string;
  readonly previousSummaryRef?: DecksmithPageSummaryRef;
  readonly coverage: {
    readonly truncated: boolean;
    readonly eligibleRunCount: number;
    readonly contiguous: boolean;
  };
  readonly recentCandidates: {
    readonly runIds: readonly string[];
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly digest: string;
  };
  readonly compaction?: {
    readonly runId: string;
    readonly inputDigest: string;
    readonly source: {
      readonly runIds: readonly string[];
      readonly firstSequence: number;
      readonly lastSequence: number;
      readonly digest: string;
    };
  };
}

/**
 * 冻结的历史投影合同（评审 M1）。只冻结会在入队后变化的事实：源 Run 的提案结局。
 * 教师原话、选区、result 事件在源 Run 结束后不再变化，执行与压缩时照常从持久事件重建并校验 digest。
 */
export interface DecksmithFrozenProjection {
  readonly projectionVersion: typeof DECKSMITH_TURN_PROJECTION_V2;
  /** 入队时已知的提案结局，只列出产生过提案的源 Run；之后到达的审批事件不改变本 Run 的投影。 */
  readonly proposalOutcomes: readonly {
    readonly runId: string;
    readonly outcome: DecksmithProposalOutcome;
  }[];
  /** 旧摘要中当时仍 pending、入队时已有结局的提案；作为"结局更新"行附在摘要后。 */
  readonly summaryOutcomeUpdates?: readonly {
    readonly runId: string;
    readonly sequence: number;
    readonly outcome: DecksmithProposalOutcome;
  }[];
  /** 本 Run 自身选区的可读提示（由入队时的基线文档派生）；后续 Run 投影本轮教师条目时使用。 */
  readonly contextRefHints?: readonly {
    readonly pageId: string;
    readonly componentId: string;
    readonly hint: string;
  }[];
}

export interface DecksmithCompactionRunInput {
  readonly schemaVersion: typeof DECKSMITH_COMPACTION_RUN_INPUT_SCHEMA_VERSION;
  readonly kind: 'decksmith-compaction';
  readonly message: '';
  readonly authorization: { readonly roleGrantId: string };
  readonly resourceScope: ReachDeckResourceScope;
  readonly threadId: string;
  readonly pageId: string;
  readonly epoch: number;
  readonly source: {
    readonly runIds: readonly string[];
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly digest: string;
  };
  readonly previousSummaryRef?: DecksmithPageSummaryRef;
  readonly previousSummary?: DecksmithPageSummary;
  readonly capacity: DecksmithFrozenCapacitySnapshot;
  readonly inputDigest: string;
  /** 缺省 = v1 投影（旧压缩输入按原 digest 校验）。 */
  readonly projection?: DecksmithFrozenProjection;
}

export interface DecksmithFrozenRunInput {
  readonly schemaVersion:
    | typeof DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION
    | typeof DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION;
  readonly scientificContextSnapshot?: ScientificContextSnapshot;
  readonly kind: 'decksmith-turn';
  readonly message: string;
  readonly authorization: {
    readonly roleGrantId: string;
  };
  readonly resourceScope: ReachDeckResourceScope;
  readonly voiceSelection: ReachDeckVoiceSelection;
  readonly stream: DecksmithPageStreamPosition;
  readonly baseline: {
    readonly documentId: string;
    readonly documentHash: string;
    readonly contentDigest: string;
    readonly pageId: string;
    readonly pageRevision: number;
  };
  readonly contextRefs: readonly DecksmithContextRef[];
  readonly mediaStatus?: DecksmithPageMediaStatus;
  /**
   * 教师选中图片的视觉输入（只含稳定标识与权威 checksum，不含 URL/像素）。旧 Run 没有此字段，
   * 照常解析且不附图。
   */
  readonly visualInputs?: DecksmithFrozenVisualInputs;
  readonly summaryOrCutoff: DecksmithSummaryOrCutoff;
  readonly includedRunRange: {
    readonly runIds: readonly string[];
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly digest: string;
  };
  readonly estimatorVersion: string;
  /** Present on new v2 transport Runs; absent only for the bounded legacy recovery window. */
  readonly capacity?: DecksmithFrozenCapacitySnapshot;
  readonly contextPlan?: DecksmithFrozenContextPlan;
  /** 缺省 = v1 投影；旧 Run 继续按 v1 逻辑与原 digest 恢复。 */
  readonly projection?: DecksmithFrozenProjection;
  /**
   * 冻结的提示词与工具合同版本（WP2 / 评审 M1）。缺省 = v1：旧 Run 继续使用旧系统提示词与互动合同预加载；
   * 新 Run 写入当前版本，执行时按此版本选择提示词与工具面。
   */
  readonly promptContractVersion?: DecksmithPromptContractVersion;
  /**
   * 本轮教师消息回答的 Decksmith 问题（WP7）：入队时由服务端核对后的关联结论。旧 Run 与普通消息没有
   * 此字段，投影与提示词逐字节不变。
   */
  readonly clarificationAnswer?: DecksmithClarificationAnswer;
}

export function decksmithPageStreamDomainScope(
  value: DecksmithPageStreamScope,
): DecksmithPageStreamDomainScope {
  const { pageId, ...resourceValue } = value;
  const resource = parseReachDeckResourceScope(resourceValue);
  return Object.freeze({
    organizationId: resource.organizationId,
    courseId: resource.courseId,
    courseNodeId: resource.courseNodeId,
    moduleId: resource.moduleId,
    moduleVersionId: resource.moduleVersionId,
    pageId: boundedIdentifier(pageId, 'Decksmith pageId'),
  });
}

export function initialDecksmithPageStreamContext(): DecksmithPageStreamContext {
  return Object.freeze({
    schemaVersion: DECKSMITH_PAGE_STREAM_CONTEXT_SCHEMA_VERSION,
    streamSequence: 0,
    contextRevision: 0,
    currentEpoch: Object.freeze({
      schemaVersion: DECKSMITH_EPOCH_SCHEMA_VERSION,
      epoch: 1,
      startedAfterSequence: 0,
    }),
    modelContextCutoffSequence: 0,
  });
}

export function parseDecksmithPageStreamContext(value: unknown): DecksmithPageStreamContext {
  const context = exactObject(
    value,
    [
      'schemaVersion',
      'streamSequence',
      'contextRevision',
      'currentEpoch',
      'modelContextCutoffSequence',
    ],
    ['visibilityCutoff', 'summary'],
    'Decksmith page stream context',
  );
  if (context.schemaVersion !== DECKSMITH_PAGE_STREAM_CONTEXT_SCHEMA_VERSION) {
    throw new Error('Decksmith page stream context schema is invalid');
  }
  const streamSequence = nonnegativeInteger(context.streamSequence, 'streamSequence');
  const contextRevision = nonnegativeInteger(context.contextRevision, 'contextRevision');
  const currentEpoch = parseEpoch(context.currentEpoch);
  const modelContextCutoffSequence = nonnegativeInteger(
    context.modelContextCutoffSequence,
    'modelContextCutoffSequence',
  );
  const visibilityCutoff =
    context.visibilityCutoff === undefined
      ? undefined
      : parseVisibilityCutoff(context.visibilityCutoff);
  const summary = context.summary === undefined ? undefined : parseSummaryRef(context.summary);
  if (
    currentEpoch.startedAfterSequence > streamSequence ||
    contextRevision > streamSequence ||
    modelContextCutoffSequence > streamSequence ||
    (visibilityCutoff !== undefined && visibilityCutoff.sequence > streamSequence) ||
    (summary !== undefined && summary.epoch > currentEpoch.epoch)
  ) {
    throw new Error('Decksmith page stream context is not monotonic');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_PAGE_STREAM_CONTEXT_SCHEMA_VERSION,
    streamSequence,
    contextRevision,
    currentEpoch,
    modelContextCutoffSequence,
    ...(visibilityCutoff === undefined ? {} : { visibilityCutoff }),
    ...(summary === undefined ? {} : { summary }),
  });
}

export function parseDecksmithFrozenRunInput(value: unknown): DecksmithFrozenRunInput {
  const raw = isObject(value) ? value : {};
  const legacyWithoutVoice = raw.schemaVersion === DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION;
  const input = exactObject(
    value,
    [
      'schemaVersion',
      'kind',
      'message',
      'authorization',
      'resourceScope',
      ...(legacyWithoutVoice ? [] : ['voiceSelection']),
      'stream',
      'baseline',
      'contextRefs',
      'summaryOrCutoff',
      'includedRunRange',
      'estimatorVersion',
    ],
    [
      'capacity',
      'contextPlan',
      'mediaStatus',
      'scientificContextSnapshot',
      'visualInputs',
      'projection',
      'promptContractVersion',
      'clarificationAnswer',
    ],
    'Decksmith frozen run input',
  );
  if (
    (input.schemaVersion !== DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION &&
      input.schemaVersion !== DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION) ||
    input.kind !== 'decksmith-turn'
  ) {
    throw new Error('Decksmith frozen run input schema is invalid');
  }
  const baseline = exactObject(
    input.baseline,
    ['documentId', 'documentHash', 'contentDigest', 'pageId', 'pageRevision'],
    [],
    'Decksmith frozen baseline',
  );
  const authorization = exactObject(
    input.authorization,
    ['roleGrantId'],
    [],
    'Decksmith frozen authorization',
  );
  const resourceScope = parseReachDeckResourceScope(input.resourceScope);
  const range = exactObject(
    input.includedRunRange,
    ['runIds', 'firstSequence', 'lastSequence', 'digest'],
    [],
    'Decksmith included run range',
  );
  const runIds = stringArray(
    range.runIds,
    'included run ids',
    DECKSMITH_PAGE_STREAM_LIMITS.includedRuns,
  );
  const firstSequence = nonnegativeInteger(range.firstSequence, 'included first sequence');
  const lastSequence = nonnegativeInteger(range.lastSequence, 'included last sequence');
  const stream = parseStreamPosition(input.stream);
  const baselinePageId = boundedIdentifier(baseline.pageId, 'baseline pageId');
  if (baselinePageId !== stream.pageId)
    throw new Error('Decksmith frozen baseline page is invalid');
  const parsedBaseline = Object.freeze({
    documentId: canonicalUuid(baseline.documentId, 'baseline documentId'),
    documentHash: hash(baseline.documentHash, 'baseline documentHash'),
    contentDigest: boundedIdentifier(baseline.contentDigest, 'baseline contentDigest'),
    pageId: baselinePageId,
    pageRevision: positiveInteger(baseline.pageRevision, 'baseline pageRevision'),
  });
  if (parsedBaseline.documentId !== resourceScope.moduleVersionId) {
    throw new Error('Decksmith frozen baseline document does not match the resource scope');
  }
  const contextRefs = parseContextRefs(input.contextRefs);
  const mediaStatus =
    input.mediaStatus === undefined ? undefined : parseDecksmithPageMediaStatus(input.mediaStatus);
  if (mediaStatus !== undefined && mediaStatus.pageId !== stream.pageId) {
    throw new Error('Decksmith page media status page does not match the stream page');
  }
  const visualInputs =
    input.visualInputs === undefined
      ? undefined
      : parseDecksmithFrozenVisualInputs(input.visualInputs);
  if (visualInputs !== undefined) {
    if (
      visualInputs.pageId !== stream.pageId ||
      visualInputs.pageRevision !== parsedBaseline.pageRevision
    ) {
      throw new Error('Decksmith visual inputs do not match the origin page baseline');
    }
    const selectedImages = new Set(
      contextRefs.flatMap((ref) =>
        ref.kind === 'native-element' &&
        ref.pageId === stream.pageId &&
        ref.componentType === 'image'
          ? [ref.componentId]
          : [],
      ),
    );
    if (visualInputs.images.some((entry) => !selectedImages.has(entry.elementId))) {
      throw new Error('Decksmith visual inputs must reference selected origin-page images');
    }
  }
  const summaryOrCutoff = parseDecksmithSummaryOrCutoff(input.summaryOrCutoff);
  if (summaryOrCutoff.epoch !== stream.epoch) {
    throw new Error('Decksmith frozen context epoch does not match the stream');
  }
  if (
    (runIds.length === 0 && (firstSequence !== 0 || lastSequence !== 0)) ||
    (runIds.length > 0 &&
      (firstSequence === 0 || firstSequence > lastSequence || lastSequence >= stream.sequence))
  ) {
    throw new Error('Decksmith included run range is invalid');
  }
  const contextLastSequence =
    summaryOrCutoff.kind === 'summary'
      ? summaryOrCutoff.source.lastSequence
      : summaryOrCutoff.afterSequence;
  if (
    contextLastSequence >= stream.sequence ||
    (runIds.length > 0 && firstSequence <= contextLastSequence)
  ) {
    throw new Error('Decksmith frozen context range does not precede the turn');
  }
  for (const ref of contextRefs) {
    if (
      ref.baseline.documentId !== parsedBaseline.documentId ||
      ref.baseline.documentHash !== parsedBaseline.documentHash
    ) {
      throw new Error('Decksmith context ref baseline does not match the frozen document');
    }
    if (
      ref.pageId === stream.pageId &&
      (ref.kind === 'page' ? ref.revision : ref.pageRevision) !== parsedBaseline.pageRevision
    ) {
      throw new Error('Decksmith current-page context ref revision is stale');
    }
  }
  const parsed = Object.freeze({
    schemaVersion: input.schemaVersion,
    kind: 'decksmith-turn',
    message: boundedString(
      input.message,
      'Decksmith message',
      DECKSMITH_PAGE_STREAM_LIMITS.messageCharacters,
    ),
    authorization: Object.freeze({
      roleGrantId: boundedIdentifier(authorization.roleGrantId, 'roleGrantId'),
    }),
    resourceScope,
    voiceSelection: legacyWithoutVoice
      ? DEFAULT_REACH_DECK_VOICE_SELECTION
      : parseReachDeckVoiceSelection(input.voiceSelection),
    ...(input.scientificContextSnapshot !== undefined
      ? {
          scientificContextSnapshot: parseScientificContextSnapshot(
            input.scientificContextSnapshot,
          ),
        }
      : {}),
    stream,
    baseline: parsedBaseline,
    contextRefs,
    ...(mediaStatus === undefined ? {} : { mediaStatus }),
    ...(visualInputs === undefined ? {} : { visualInputs }),
    summaryOrCutoff,
    includedRunRange: Object.freeze({
      runIds,
      firstSequence,
      lastSequence,
      digest: hash(range.digest, 'included run digest'),
    }),
    estimatorVersion: boundedIdentifier(input.estimatorVersion, 'estimatorVersion'),
    ...(input.capacity === undefined
      ? {}
      : { capacity: parseDecksmithCapacitySnapshot(input.capacity) }),
    ...(input.contextPlan === undefined
      ? {}
      : { contextPlan: parseDecksmithFrozenContextPlan(input.contextPlan) }),
    ...(input.projection === undefined
      ? {}
      : { projection: parseDecksmithFrozenProjection(input.projection) }),
    ...(input.promptContractVersion === undefined
      ? {}
      : { promptContractVersion: promptContractVersion(input.promptContractVersion) }),
    ...(input.clarificationAnswer === undefined
      ? {}
      : { clarificationAnswer: parseDecksmithClarificationAnswer(input.clarificationAnswer) }),
  });
  for (const hint of parsed.projection?.contextRefHints ?? []) {
    if (
      !contextRefs.some(
        (ref) =>
          ref.kind !== 'page' && ref.pageId === hint.pageId && ref.componentId === hint.componentId,
      )
    ) {
      throw new Error('Decksmith context ref hint does not match a frozen component ref');
    }
  }
  if ((parsed.capacity === undefined) !== (parsed.contextPlan === undefined)) {
    throw new Error('Decksmith frozen capacity and context plan must be present together');
  }
  if (
    parsed.scientificContextSnapshot !== undefined &&
    parsed.scientificContextSnapshot.stage !== 'decksmith'
  ) {
    throw new Error('Decksmith scientific context stage is invalid');
  }
  if (jsonBytes(parsed) > DECKSMITH_PAGE_STREAM_LIMITS.frozenInputBytes) {
    throw new Error('Decksmith frozen run input exceeds the size limit');
  }
  return parsed;
}

export function parseDecksmithPageMediaStatus(value: unknown): DecksmithPageMediaStatus {
  const input = exactObject(
    value,
    ['schemaVersion', 'pageId', 'narration', 'audio', 'animation'],
    ['reasonCode'],
    'Decksmith page media status',
  );
  if (input.schemaVersion !== DECKSMITH_PAGE_MEDIA_STATUS_SCHEMA_VERSION) {
    throw new Error('Decksmith page media status schema is invalid');
  }
  const state = (candidate: unknown, label: string): DecksmithPageMediaState => {
    if (
      candidate !== 'not-started' &&
      candidate !== 'generating' &&
      candidate !== 'completed' &&
      candidate !== 'failed'
    ) {
      throw new Error(`Decksmith page media status ${label} is invalid`);
    }
    return candidate;
  };
  return Object.freeze({
    schemaVersion: DECKSMITH_PAGE_MEDIA_STATUS_SCHEMA_VERSION,
    pageId: boundedIdentifier(input.pageId, 'media status pageId'),
    narration: state(input.narration, 'narration'),
    audio: state(input.audio, 'audio'),
    animation: state(input.animation, 'animation'),
    ...(input.reasonCode === undefined
      ? {}
      : { reasonCode: boundedIdentifier(input.reasonCode, 'media status reasonCode') }),
  });
}

export function parseDecksmithPageTurn(value: unknown): DecksmithPageTurn {
  const turn = exactObject(
    value,
    ['schemaVersion', 'kind', 'role', 'stream', 'text', 'contextRefs'],
    [],
    'Decksmith page turn',
  );
  if (
    turn.schemaVersion !== DECKSMITH_PAGE_TURN_SCHEMA_VERSION ||
    turn.kind !== 'turn' ||
    (turn.role !== 'teacher' && turn.role !== 'assistant')
  ) {
    throw new Error('Decksmith page turn schema is invalid');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_PAGE_TURN_SCHEMA_VERSION,
    kind: 'turn',
    role: turn.role,
    stream: parseStreamPosition(turn.stream),
    text: boundedString(
      turn.text,
      'Decksmith turn text',
      DECKSMITH_PAGE_STREAM_LIMITS.messageCharacters,
    ),
    contextRefs: parseContextRefs(turn.contextRefs),
  });
}

export function parseDecksmithContextRef(value: unknown): DecksmithContextRef {
  return parseContextRefs([value])[0]!;
}

export function parseDecksmithPageControlBoundary(value: unknown): DecksmithPageControlBoundary {
  const object = exactObject(
    value,
    ['schemaVersion', 'kind', 'stream'],
    [
      'previousEpoch',
      'nextEpoch',
      'message',
      'visibilityCutoffSequence',
      'modelContextCutoffSequence',
    ],
    'Decksmith control boundary',
  );
  if (object.schemaVersion !== DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION) {
    throw new Error('Decksmith control boundary schema is invalid');
  }
  const stream = parseStreamPosition(object.stream);
  if (object.kind === 'new-topic') {
    requireExactOptionalSet(object, ['previousEpoch', 'nextEpoch', 'message']);
    const previousEpoch = positiveInteger(object.previousEpoch, 'previousEpoch');
    const nextEpoch = positiveInteger(object.nextEpoch, 'nextEpoch');
    if (nextEpoch !== previousEpoch + 1 || stream.epoch !== nextEpoch) {
      throw new Error('Decksmith New topic epoch is invalid');
    }
    return Object.freeze({
      schemaVersion: DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION,
      kind: 'new-topic',
      stream,
      previousEpoch,
      nextEpoch,
      message: parseApplicationMessage(object.message, stream),
    });
  }
  if (object.kind === 'soft-delete') {
    requireExactOptionalSet(object, ['visibilityCutoffSequence', 'modelContextCutoffSequence']);
    const visibilityCutoffSequence = nonnegativeInteger(
      object.visibilityCutoffSequence,
      'visibilityCutoffSequence',
    );
    const modelContextCutoffSequence = nonnegativeInteger(
      object.modelContextCutoffSequence,
      'modelContextCutoffSequence',
    );
    if (
      visibilityCutoffSequence !== stream.sequence ||
      modelContextCutoffSequence !== stream.sequence
    ) {
      throw new Error('Decksmith soft-delete cutoff is invalid');
    }
    return Object.freeze({
      schemaVersion: DECKSMITH_CONTROL_BOUNDARY_SCHEMA_VERSION,
      kind: 'soft-delete',
      stream,
      visibilityCutoffSequence,
      modelContextCutoffSequence,
    });
  }
  throw new Error('Decksmith control boundary kind is invalid');
}

export function parseDecksmithPageSummary(value: unknown): DecksmithPageSummary {
  const summary = exactObject(
    value,
    [
      'schemaVersion',
      'kind',
      'revision',
      'epoch',
      'source',
      'text',
      'pageFacts',
      'unresolvedDecisions',
      'proposalOutcomes',
    ],
    ['previousSummary', 'provenance', 'metadata'],
    'Decksmith summary',
  );
  if (summary.schemaVersion !== DECKSMITH_SUMMARY_SCHEMA_VERSION || summary.kind !== 'summary') {
    throw new Error('Decksmith summary schema is invalid');
  }
  const source = exactObject(
    summary.source,
    ['firstSequence', 'lastSequence', 'firstRunId', 'lastRunId', 'digest'],
    [],
    'Decksmith summary source',
  );
  const firstSequence = positiveInteger(source.firstSequence, 'summary firstSequence');
  const lastSequence = positiveInteger(source.lastSequence, 'summary lastSequence');
  if (firstSequence > lastSequence) throw new Error('Decksmith summary source is invalid');
  const factBudget = { nodes: 0 };
  const parsed = Object.freeze({
    schemaVersion: DECKSMITH_SUMMARY_SCHEMA_VERSION,
    kind: 'summary',
    revision: positiveInteger(summary.revision, 'summary revision'),
    epoch: positiveInteger(summary.epoch, 'summary epoch'),
    ...(summary.metadata === undefined ? {} : { metadata: parseSummaryMetadata(summary.metadata) }),
    source: Object.freeze({
      firstSequence,
      lastSequence,
      firstRunId: canonicalUuid(source.firstRunId, 'summary firstRunId'),
      lastRunId: canonicalUuid(source.lastRunId, 'summary lastRunId'),
      digest: hash(source.digest, 'summary digest'),
    }),
    text: boundedString(
      summary.text,
      'summary text',
      DECKSMITH_PAGE_STREAM_LIMITS.summaryCharacters,
    ),
    pageFacts: recordArray(summary.pageFacts, 'summary pageFacts', factBudget),
    unresolvedDecisions: recordArray(
      summary.unresolvedDecisions,
      'summary unresolvedDecisions',
      factBudget,
    ),
    proposalOutcomes: recordArray(summary.proposalOutcomes, 'summary proposalOutcomes', factBudget),
    ...(summary.previousSummary === undefined
      ? {}
      : { previousSummary: parsePreviousSummary(summary.previousSummary) }),
    ...(summary.provenance === undefined
      ? {}
      : { provenance: parseSummaryProvenance(summary.provenance) }),
  });
  if (jsonBytes(parsed) > DECKSMITH_PAGE_STREAM_LIMITS.summaryBytes) {
    throw new Error('Decksmith summary exceeds the size limit');
  }
  return parsed;
}

export function parseDecksmithCapacitySnapshot(value: unknown): DecksmithFrozenCapacitySnapshot {
  const snapshot = exactObject(
    value,
    [
      'schemaVersion',
      'capacityProfileVersion',
      'estimatorVersion',
      'capacityUnit',
      'guaranteedInputCapacity',
      'reservedOutputCapacity',
      'estimatedInput',
      'thresholds',
      'state',
      'messageKey',
      'provenance',
      'inputMeasure',
    ],
    [],
    'Decksmith capacity snapshot',
  );
  if (snapshot.schemaVersion !== DECKSMITH_CAPACITY_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('Decksmith capacity snapshot schema is invalid');
  }
  const thresholds = exactObject(
    snapshot.thresholds,
    ['approaching', 'needsCompaction', 'blocked'],
    [],
    'Decksmith capacity thresholds',
  );
  const inputMeasure = exactObject(
    snapshot.inputMeasure,
    ['serializedInputUtf8Bytes', 'structuralItemCount', 'digest'],
    [],
    'Decksmith capacity input measure',
  );
  const provenance = exactObject(
    snapshot.provenance,
    ['kind'],
    ['fallbackVersion'],
    'Decksmith capacity provenance',
  );
  if (provenance.kind !== 'model-service' && provenance.kind !== 'conservative-fallback') {
    throw new Error('Decksmith capacity provenance is invalid');
  }
  if (
    (provenance.kind === 'model-service' && provenance.fallbackVersion !== undefined) ||
    (provenance.kind === 'conservative-fallback' && provenance.fallbackVersion === undefined)
  ) {
    throw new Error('Decksmith capacity fallback provenance is invalid');
  }
  const guaranteedInputCapacity = positiveSafeInteger(
    snapshot.guaranteedInputCapacity,
    'guaranteed input capacity',
  );
  const reservedOutputCapacity = positiveSafeInteger(
    snapshot.reservedOutputCapacity,
    'reserved output capacity',
  );
  const estimatedInput = nonnegativeSafeInteger(snapshot.estimatedInput, 'estimated input');
  const approaching = positiveSafeInteger(thresholds.approaching, 'approaching threshold');
  const needsCompaction = positiveSafeInteger(
    thresholds.needsCompaction,
    'needs compaction threshold',
  );
  const blocked = positiveSafeInteger(thresholds.blocked, 'blocked threshold');
  const failClosedFallbackFloor =
    provenance.kind === 'conservative-fallback' &&
    guaranteedInputCapacity === 1 &&
    approaching === 1 &&
    needsCompaction === 1 &&
    blocked === 1;
  if (
    (!(approaching < needsCompaction && needsCompaction < blocked) && !failClosedFallbackFloor) ||
    blocked > guaranteedInputCapacity
  ) {
    throw new Error('Decksmith capacity thresholds are invalid');
  }
  if (
    !['ordinary', 'approaching', 'needs_compaction', 'blocked'].includes(String(snapshot.state))
  ) {
    throw new Error('Decksmith capacity state is invalid');
  }
  const expectedState: DecksmithCapacityState =
    estimatedInput >= blocked
      ? 'blocked'
      : estimatedInput >= needsCompaction
        ? 'needs_compaction'
        : estimatedInput >= approaching
          ? 'approaching'
          : 'ordinary';
  const expectedMessageKey = `reachDeck.decksmith.capacity.${
    expectedState === 'needs_compaction' ? 'compacting' : expectedState
  }`;
  if (snapshot.state !== expectedState || snapshot.messageKey !== expectedMessageKey) {
    throw new Error('Decksmith capacity state does not match its estimate');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_CAPACITY_SNAPSHOT_SCHEMA_VERSION,
    capacityProfileVersion: boundedIdentifier(
      snapshot.capacityProfileVersion,
      'capacityProfileVersion',
    ),
    estimatorVersion: boundedIdentifier(snapshot.estimatorVersion, 'capacity estimatorVersion'),
    capacityUnit: boundedIdentifier(snapshot.capacityUnit, 'capacityUnit'),
    guaranteedInputCapacity,
    reservedOutputCapacity,
    estimatedInput,
    thresholds: Object.freeze({ approaching, needsCompaction, blocked }),
    state: snapshot.state as DecksmithCapacityState,
    messageKey: boundedIdentifier(snapshot.messageKey, 'capacity messageKey'),
    provenance: Object.freeze(
      provenance.kind === 'model-service'
        ? { kind: 'model-service' as const }
        : {
            kind: 'conservative-fallback' as const,
            fallbackVersion: boundedIdentifier(provenance.fallbackVersion, 'fallbackVersion'),
          },
    ),
    inputMeasure: Object.freeze({
      serializedInputUtf8Bytes: nonnegativeSafeInteger(
        inputMeasure.serializedInputUtf8Bytes,
        'serialized input bytes',
      ),
      structuralItemCount: nonnegativeSafeInteger(
        inputMeasure.structuralItemCount,
        'structural item count',
      ),
      digest: hash(inputMeasure.digest, 'capacity input digest'),
    }),
  });
}

export function parseDecksmithFrozenContextPlan(value: unknown): DecksmithFrozenContextPlan {
  const plan = exactObject(
    value,
    [
      'schemaVersion',
      'selectionAlgorithmVersion',
      'transcriptSourceDigest',
      'recentCandidates',
      'coverage',
    ],
    ['previousSummaryRef', 'compaction'],
    'Decksmith context plan',
  );
  if (plan.schemaVersion !== DECKSMITH_CONTEXT_PLAN_SCHEMA_VERSION) {
    throw new Error('Decksmith context plan schema is invalid');
  }
  const recentCandidates = parseRunRange(plan.recentCandidates, 'recent candidates', true);
  const coverage = exactObject(
    plan.coverage,
    ['truncated', 'eligibleRunCount', 'contiguous'],
    [],
    'Decksmith context coverage',
  );
  if (
    typeof coverage.truncated !== 'boolean' ||
    typeof coverage.contiguous !== 'boolean' ||
    (coverage.truncated && coverage.contiguous)
  ) {
    throw new Error('Decksmith context coverage is invalid');
  }
  const previousSummaryRef =
    plan.previousSummaryRef === undefined ? undefined : parseSummaryRef(plan.previousSummaryRef);
  let compaction: DecksmithFrozenContextPlan['compaction'];
  if (plan.compaction !== undefined) {
    const candidate = exactObject(
      plan.compaction,
      ['runId', 'inputDigest', 'source'],
      [],
      'Decksmith compaction plan',
    );
    const source = parseRunRange(candidate.source, 'compaction source', false);
    if (source.runIds.length === 0) throw new Error('Decksmith compaction source is empty');
    compaction = Object.freeze({
      runId: canonicalUuid(candidate.runId, 'compaction runId'),
      inputDigest: hash(candidate.inputDigest, 'compaction input digest'),
      source,
    });
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_CONTEXT_PLAN_SCHEMA_VERSION,
    selectionAlgorithmVersion: boundedIdentifier(
      plan.selectionAlgorithmVersion,
      'selectionAlgorithmVersion',
    ),
    transcriptSourceDigest: hash(plan.transcriptSourceDigest, 'transcript source digest'),
    coverage: Object.freeze({
      truncated: coverage.truncated,
      eligibleRunCount: nonnegativeSafeInteger(coverage.eligibleRunCount, 'eligible run count'),
      contiguous: coverage.contiguous,
    }),
    recentCandidates,
    ...(previousSummaryRef === undefined ? {} : { previousSummaryRef }),
    ...(compaction === undefined ? {} : { compaction }),
  });
}

export function parseDecksmithCompactionRunInput(value: unknown): DecksmithCompactionRunInput {
  const input = exactObject(
    value,
    [
      'schemaVersion',
      'kind',
      'message',
      'authorization',
      'resourceScope',
      'threadId',
      'pageId',
      'epoch',
      'source',
      'capacity',
      'inputDigest',
    ],
    ['previousSummaryRef', 'previousSummary', 'projection'],
    'Decksmith compaction run input',
  );
  if (
    input.schemaVersion !== DECKSMITH_COMPACTION_RUN_INPUT_SCHEMA_VERSION ||
    input.kind !== 'decksmith-compaction' ||
    input.message !== ''
  ) {
    throw new Error('Decksmith compaction run input schema is invalid');
  }
  const authorization = exactObject(
    input.authorization,
    ['roleGrantId'],
    [],
    'Decksmith compaction authorization',
  );
  const source = parseRunRange(input.source, 'compaction source', false);
  if (source.runIds.length === 0) throw new Error('Decksmith compaction source is empty');
  const previousSummaryRef =
    input.previousSummaryRef === undefined ? undefined : parseSummaryRef(input.previousSummaryRef);
  const previousSummary =
    input.previousSummary === undefined
      ? undefined
      : parseDecksmithPageSummary(input.previousSummary);
  if (
    (previousSummaryRef === undefined && previousSummary !== undefined) ||
    (previousSummaryRef !== undefined &&
      previousSummary !== undefined &&
      (previousSummaryRef.runId !== previousSummary.provenance?.creationRunId ||
        previousSummaryRef.revision !== previousSummary.revision ||
        previousSummaryRef.epoch !== previousSummary.epoch ||
        previousSummaryRef.sourceDigest !== previousSummary.source.digest ||
        (previousSummaryRef.summaryDigest !== undefined &&
          previousSummaryRef.summaryDigest !== hashJson(previousSummary)) ||
        (previousSummaryRef.sourceLastSequence !== undefined &&
          previousSummaryRef.sourceLastSequence !== previousSummary.source.lastSequence)))
  ) {
    throw new Error('Decksmith previous summary does not match its ref');
  }
  const parsed = Object.freeze({
    schemaVersion: DECKSMITH_COMPACTION_RUN_INPUT_SCHEMA_VERSION,
    kind: 'decksmith-compaction' as const,
    message: '' as const,
    authorization: Object.freeze({
      roleGrantId: boundedIdentifier(authorization.roleGrantId, 'compaction roleGrantId'),
    }),
    resourceScope: parseReachDeckResourceScope(input.resourceScope),
    threadId: canonicalUuid(input.threadId, 'compaction threadId'),
    pageId: boundedIdentifier(input.pageId, 'compaction pageId'),
    epoch: positiveInteger(input.epoch, 'compaction epoch'),
    source,
    ...(previousSummaryRef === undefined ? {} : { previousSummaryRef }),
    ...(previousSummary === undefined ? {} : { previousSummary }),
    capacity: parseDecksmithCapacitySnapshot(input.capacity),
    inputDigest: hash(input.inputDigest, 'compaction input digest'),
    ...(input.projection === undefined
      ? {}
      : { projection: parseDecksmithFrozenProjection(input.projection) }),
  });
  if (parsed.projection?.contextRefHints !== undefined) {
    throw new Error('Decksmith compaction projection must not carry context ref hints');
  }
  if (jsonBytes(parsed) > DECKSMITH_PAGE_STREAM_LIMITS.frozenInputBytes) {
    throw new Error('Decksmith compaction run input exceeds the size limit');
  }
  return parsed;
}

/**
 * 解析冻结投影合同（严格字段集）。
 *
 * 数据源：ai_run.input（冻结 Run 输入或压缩输入）中的 `projection` 字段。
 * 核心逻辑：
 * 1. 只接受 projectionVersion=2；
 * 2. 提案结局按 runId 去重，条数不超过单次可纳入的 Run 上限；
 * 3. 摘要结局更新不超过摘要事实条数上限；选区提示不超过选区上限且只含有界纯文本。
 */
export function parseDecksmithFrozenProjection(value: unknown): DecksmithFrozenProjection {
  const projection = exactObject(
    value,
    ['projectionVersion', 'proposalOutcomes'],
    ['summaryOutcomeUpdates', 'contextRefHints'],
    'Decksmith frozen projection',
  );
  if (projection.projectionVersion !== DECKSMITH_TURN_PROJECTION_V2) {
    throw new Error('Decksmith frozen projection version is invalid');
  }
  if (
    !Array.isArray(projection.proposalOutcomes) ||
    projection.proposalOutcomes.length > DECKSMITH_PAGE_STREAM_LIMITS.includedRuns
  ) {
    throw new Error('Decksmith frozen proposal outcomes are invalid');
  }
  const proposalOutcomes = projection.proposalOutcomes.map((entry) => {
    const record = exactObject(entry, ['runId', 'outcome'], [], 'Decksmith proposal outcome');
    return Object.freeze({
      runId: canonicalUuid(record.runId, 'proposal outcome runId'),
      outcome: proposalOutcome(record.outcome),
    });
  });
  if (new Set(proposalOutcomes.map((entry) => entry.runId)).size !== proposalOutcomes.length) {
    throw new Error('Decksmith frozen proposal outcomes contain duplicates');
  }
  let summaryOutcomeUpdates: DecksmithFrozenProjection['summaryOutcomeUpdates'];
  if (projection.summaryOutcomeUpdates !== undefined) {
    if (
      !Array.isArray(projection.summaryOutcomeUpdates) ||
      projection.summaryOutcomeUpdates.length === 0 ||
      projection.summaryOutcomeUpdates.length > DECKSMITH_PAGE_STREAM_LIMITS.factArrayEntries
    ) {
      throw new Error('Decksmith summary outcome updates are invalid');
    }
    summaryOutcomeUpdates = Object.freeze(
      projection.summaryOutcomeUpdates.map((entry) => {
        const record = exactObject(
          entry,
          ['runId', 'sequence', 'outcome'],
          [],
          'Decksmith summary outcome update',
        );
        return Object.freeze({
          runId: canonicalUuid(record.runId, 'summary outcome update runId'),
          sequence: positiveInteger(record.sequence, 'summary outcome update sequence'),
          outcome: proposalOutcome(record.outcome),
        });
      }),
    );
    if (
      new Set(summaryOutcomeUpdates.map((entry) => entry.runId)).size !==
      summaryOutcomeUpdates.length
    ) {
      throw new Error('Decksmith summary outcome updates contain duplicates');
    }
  }
  let contextRefHints: DecksmithFrozenProjection['contextRefHints'];
  if (projection.contextRefHints !== undefined) {
    if (
      !Array.isArray(projection.contextRefHints) ||
      projection.contextRefHints.length === 0 ||
      projection.contextRefHints.length > DECKSMITH_PAGE_STREAM_LIMITS.refs
    ) {
      throw new Error('Decksmith context ref hints are invalid');
    }
    contextRefHints = Object.freeze(
      projection.contextRefHints.map((entry) => {
        const record = exactObject(
          entry,
          ['pageId', 'componentId', 'hint'],
          [],
          'Decksmith context ref hint',
        );
        return Object.freeze({
          pageId: boundedIdentifier(record.pageId, 'context ref hint pageId'),
          componentId: boundedIdentifier(record.componentId, 'context ref hint componentId'),
          hint: boundedString(
            record.hint,
            'context ref hint',
            DECKSMITH_CONTEXT_REF_HINT_CHARACTERS,
            true,
          ),
        });
      }),
    );
  }
  return Object.freeze({
    projectionVersion: DECKSMITH_TURN_PROJECTION_V2,
    proposalOutcomes: Object.freeze(proposalOutcomes),
    ...(summaryOutcomeUpdates === undefined ? {} : { summaryOutcomeUpdates }),
    ...(contextRefHints === undefined ? {} : { contextRefHints }),
  });
}

/** 只接受已知的显式版本；未知版本（例如更新的 API 入队、旧 worker 执行）直接拒绝而不是退回旧提示词。 */
function promptContractVersion(value: unknown): DecksmithPromptContractVersion {
  if (!isDecksmithPromptContractVersion(value)) {
    throw new Error('Decksmith prompt contract version is invalid');
  }
  return value;
}

function proposalOutcome(value: unknown): DecksmithProposalOutcome {
  if (!DECKSMITH_PROPOSAL_OUTCOMES.includes(value as DecksmithProposalOutcome)) {
    throw new Error('Decksmith proposal outcome is invalid');
  }
  return value as DecksmithProposalOutcome;
}

export function parseDecksmithSummaryOrCutoff(value: unknown): DecksmithSummaryOrCutoff {
  if (isObject(value) && value.schemaVersion === DECKSMITH_SUMMARY_SCHEMA_VERSION) {
    return parseDecksmithPageSummary(value);
  }
  const cutoff = exactObject(
    value,
    ['schemaVersion', 'kind', 'epoch', 'afterSequence', 'reason'],
    [],
    'Decksmith deterministic cutoff',
  );
  if (
    cutoff.schemaVersion !== DECKSMITH_CUTOFF_SCHEMA_VERSION ||
    cutoff.kind !== 'deterministic-cutoff' ||
    !['no-summary', 'visibility-cutoff', 'compaction-fallback'].includes(String(cutoff.reason))
  ) {
    throw new Error('Decksmith deterministic cutoff is invalid');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_CUTOFF_SCHEMA_VERSION,
    kind: 'deterministic-cutoff',
    epoch: positiveInteger(cutoff.epoch, 'cutoff epoch'),
    afterSequence: nonnegativeInteger(cutoff.afterSequence, 'cutoff sequence'),
    reason: cutoff.reason as 'no-summary' | 'visibility-cutoff' | 'compaction-fallback',
  }) as DecksmithSummaryOrCutoff;
}

function parseSummaryRef(value: unknown): DecksmithPageSummaryRef {
  const summary = exactObject(
    value,
    ['schemaVersion', 'kind', 'runId', 'revision', 'epoch', 'sourceDigest'],
    ['summaryDigest', 'sourceLastSequence'],
    'Decksmith summary ref',
  );
  if (
    summary.schemaVersion !== DECKSMITH_SUMMARY_REF_SCHEMA_VERSION ||
    summary.kind !== 'summary-ref'
  ) {
    throw new Error('Decksmith summary ref schema is invalid');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_SUMMARY_REF_SCHEMA_VERSION,
    kind: 'summary-ref',
    runId: canonicalUuid(summary.runId, 'summary ref runId'),
    revision: positiveInteger(summary.revision, 'summary ref revision'),
    epoch: positiveInteger(summary.epoch, 'summary ref epoch'),
    sourceDigest: hash(summary.sourceDigest, 'summary ref digest'),
    ...(summary.summaryDigest === undefined
      ? {}
      : { summaryDigest: hash(summary.summaryDigest, 'summary body digest') }),
    ...(summary.sourceLastSequence === undefined
      ? {}
      : {
          sourceLastSequence: positiveInteger(
            summary.sourceLastSequence,
            'summary source last sequence',
          ),
        }),
  });
}

function hashJson(value: unknown): string {
  // Kept local to avoid making the persistence contract depend on execution helpers.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseRunRange(
  value: unknown,
  label: string,
  allowEmpty: boolean,
): {
  readonly runIds: readonly string[];
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly digest: string;
} {
  const range = exactObject(
    value,
    ['runIds', 'firstSequence', 'lastSequence', 'digest'],
    [],
    `Decksmith ${label}`,
  );
  const runIds = stringArray(
    range.runIds,
    `${label} run ids`,
    DECKSMITH_PAGE_STREAM_LIMITS.includedRuns,
  );
  const firstSequence = nonnegativeInteger(range.firstSequence, `${label} first sequence`);
  const lastSequence = nonnegativeInteger(range.lastSequence, `${label} last sequence`);
  if (
    (!allowEmpty && runIds.length === 0) ||
    (runIds.length === 0 && (firstSequence !== 0 || lastSequence !== 0)) ||
    (runIds.length > 0 && (firstSequence === 0 || firstSequence > lastSequence))
  ) {
    throw new Error(`Decksmith ${label} is invalid`);
  }
  return Object.freeze({
    runIds,
    firstSequence,
    lastSequence,
    digest: hash(range.digest, `${label} digest`),
  });
}

function parsePreviousSummary(value: unknown) {
  const previous = exactObject(
    value,
    ['runId', 'revision', 'digest'],
    [],
    'Decksmith previous summary',
  );
  return Object.freeze({
    runId: canonicalUuid(previous.runId, 'previous summary runId'),
    revision: positiveInteger(previous.revision, 'previous summary revision'),
    digest: hash(previous.digest, 'previous summary digest'),
  });
}

function parseSummaryMetadata(value: unknown) {
  const metadata = exactObject(
    value,
    ['pageId', 'status', 'capacityProfileVersion', 'estimatorVersion', 'capacityUnit'],
    ['previousSummaryDigest'],
    'Decksmith summary metadata',
  );
  if (metadata.status !== 'created' && metadata.status !== 'installed') {
    throw new Error('Decksmith summary status is invalid');
  }
  return Object.freeze({
    pageId: boundedIdentifier(metadata.pageId, 'summary pageId'),
    status: metadata.status,
    ...(metadata.previousSummaryDigest === undefined
      ? {}
      : { previousSummaryDigest: hash(metadata.previousSummaryDigest, 'previous summary digest') }),
    capacityProfileVersion: boundedIdentifier(
      metadata.capacityProfileVersion,
      'summary capacity profile version',
    ),
    estimatorVersion: boundedIdentifier(metadata.estimatorVersion, 'summary estimator version'),
    capacityUnit: boundedIdentifier(metadata.capacityUnit, 'summary capacity unit'),
  });
}

function parseSummaryProvenance(value: unknown) {
  const provenance = exactObject(
    value,
    ['creationRunId', 'modelUsageDigest', 'sourcePlanDigest'],
    [],
    'Decksmith summary provenance',
  );
  return Object.freeze({
    creationRunId: canonicalUuid(provenance.creationRunId, 'summary creationRunId'),
    modelUsageDigest: hash(provenance.modelUsageDigest, 'summary model usage digest'),
    sourcePlanDigest: hash(provenance.sourcePlanDigest, 'summary source plan digest'),
  });
}

function parseContextRefs(value: unknown): readonly DecksmithContextRef[] {
  if (!Array.isArray(value) || value.length > DECKSMITH_PAGE_STREAM_LIMITS.refs) {
    throw new Error('Decksmith context refs are invalid');
  }
  const keys = new Set<string>();
  return Object.freeze(
    value.map((candidate) => {
      const ref = exactObject(
        candidate,
        ['schemaVersion', 'kind', 'pageId'],
        [
          'label',
          'order',
          'revision',
          'pageLabel',
          'pageOrder',
          'pageRevision',
          'sceneId',
          'sceneType',
          'componentId',
          'componentType',
          'display',
          'baseline',
        ],
        'Decksmith context ref',
      );
      if (ref.schemaVersion !== DECKSMITH_CONTEXT_REF_SCHEMA_VERSION) {
        throw new Error('Decksmith context ref schema is invalid');
      }
      const pageId = boundedIdentifier(ref.pageId, 'context ref pageId');
      let parsed: DecksmithContextRef;
      if (ref.kind === 'page') {
        requireExactFields(ref, [
          'schemaVersion',
          'kind',
          'pageId',
          'label',
          'order',
          'revision',
          'baseline',
        ]);
        const baseline = parseRefBaseline(ref.baseline, false);
        parsed = Object.freeze({
          schemaVersion: DECKSMITH_CONTEXT_REF_SCHEMA_VERSION,
          kind: 'page',
          pageId,
          label: boundedString(
            ref.label,
            'context ref page label',
            DECKSMITH_PAGE_STREAM_LIMITS.labelCharacters,
            true,
          ),
          order: positiveInteger(ref.order, 'context ref page order'),
          revision: positiveInteger(ref.revision, 'context ref page revision'),
          baseline,
        });
      } else if (ref.kind === 'native-element' || ref.kind === 'interactive-component') {
        requireExactFields(ref, [
          'schemaVersion',
          'kind',
          'pageId',
          'pageLabel',
          'pageOrder',
          'pageRevision',
          'sceneId',
          'sceneType',
          'componentId',
          'componentType',
          'display',
          'baseline',
        ]);
        const expectedSceneType = ref.kind === 'native-element' ? 'slide' : 'interactive';
        if (ref.sceneType !== expectedSceneType) {
          throw new Error('Decksmith component context ref scene type is invalid');
        }
        const display = exactObject(
          ref.display,
          ['label'],
          ['detail'],
          'Decksmith component display snapshot',
        );
        const baseline = parseRefBaseline(ref.baseline, true);
        const pageRevision = positiveInteger(ref.pageRevision, 'context ref page revision');
        if (baseline.pageRevision !== pageRevision) {
          throw new Error('Decksmith component baseline revision is invalid');
        }
        parsed = Object.freeze({
          schemaVersion: DECKSMITH_CONTEXT_REF_SCHEMA_VERSION,
          kind: ref.kind,
          pageId,
          pageLabel: boundedString(
            ref.pageLabel,
            'context ref page label',
            DECKSMITH_PAGE_STREAM_LIMITS.labelCharacters,
            true,
          ),
          pageOrder: positiveInteger(ref.pageOrder, 'context ref page order'),
          pageRevision,
          sceneId: boundedIdentifier(ref.sceneId, 'context ref sceneId'),
          sceneType: expectedSceneType,
          componentId: boundedIdentifier(ref.componentId, 'context ref componentId'),
          componentType: boundedIdentifier(ref.componentType, 'context ref componentType'),
          display: Object.freeze({
            label: boundedString(
              display.label,
              'component display label',
              DECKSMITH_PAGE_STREAM_LIMITS.labelCharacters,
              true,
            ),
            ...(display.detail === undefined
              ? {}
              : {
                  detail: boundedString(
                    display.detail,
                    'component display detail',
                    DECKSMITH_PAGE_STREAM_LIMITS.displayCharacters,
                  ),
                }),
          }),
          baseline,
        });
      } else {
        throw new Error('Decksmith context ref kind is invalid');
      }
      const key = `${parsed.kind}\u0000${parsed.pageId}\u0000${'componentId' in parsed ? parsed.componentId : ''}`;
      if (keys.has(key)) throw new Error('Decksmith context refs contain duplicates');
      keys.add(key);
      return parsed;
    }),
  );
}

function parseRefBaseline(
  value: unknown,
  component: false,
): { readonly documentId: string; readonly documentHash: string };
function parseRefBaseline(
  value: unknown,
  component: true,
): {
  readonly documentId: string;
  readonly documentHash: string;
  readonly pageRevision: number;
  readonly componentHash: string;
};
function parseRefBaseline(value: unknown, component: boolean) {
  const baseline = exactObject(
    value,
    ['documentId', 'documentHash', ...(component ? ['pageRevision', 'componentHash'] : [])],
    [],
    'Decksmith context ref baseline',
  );
  return Object.freeze({
    documentId: canonicalUuid(baseline.documentId, 'context ref baseline documentId'),
    documentHash: hash(baseline.documentHash, 'context ref baseline documentHash'),
    ...(component
      ? {
          pageRevision: positiveInteger(baseline.pageRevision, 'context ref baseline pageRevision'),
          componentHash: hash(baseline.componentHash, 'context ref baseline componentHash'),
        }
      : {}),
  });
}

function parseStreamPosition(value: unknown): DecksmithPageStreamPosition {
  const stream = exactObject(
    value,
    ['schemaVersion', 'pageId', 'sequence', 'epoch', 'contextRevision'],
    [],
    'Decksmith stream position',
  );
  if (stream.schemaVersion !== DECKSMITH_PAGE_STREAM_SCHEMA_VERSION) {
    throw new Error('Decksmith stream position schema is invalid');
  }
  const sequence = positiveInteger(stream.sequence, 'stream sequence');
  const contextRevision = positiveInteger(stream.contextRevision, 'stream contextRevision');
  if (contextRevision > sequence) {
    throw new Error('Decksmith stream context revision exceeds its sequence');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
    pageId: boundedIdentifier(stream.pageId, 'stream pageId'),
    sequence,
    epoch: positiveInteger(stream.epoch, 'stream epoch'),
    contextRevision,
  });
}

function parseEpoch(value: unknown): DecksmithPageEpoch {
  const epoch = exactObject(
    value,
    ['schemaVersion', 'epoch', 'startedAfterSequence'],
    ['boundaryRunId'],
    'Decksmith epoch',
  );
  if (epoch.schemaVersion !== DECKSMITH_EPOCH_SCHEMA_VERSION) {
    throw new Error('Decksmith epoch schema is invalid');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_EPOCH_SCHEMA_VERSION,
    epoch: positiveInteger(epoch.epoch, 'epoch'),
    startedAfterSequence: nonnegativeInteger(epoch.startedAfterSequence, 'epoch start sequence'),
    ...(epoch.boundaryRunId === undefined
      ? {}
      : { boundaryRunId: canonicalUuid(epoch.boundaryRunId, 'boundary runId') }),
  });
}

function parseVisibilityCutoff(value: unknown): DecksmithPageVisibilityCutoff {
  const cutoff = exactObject(
    value,
    ['schemaVersion', 'kind', 'sequence', 'controlRunId'],
    [],
    'Decksmith visibility cutoff',
  );
  if (cutoff.schemaVersion !== DECKSMITH_CUTOFF_SCHEMA_VERSION || cutoff.kind !== 'visibility') {
    throw new Error('Decksmith visibility cutoff is invalid');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_CUTOFF_SCHEMA_VERSION,
    kind: 'visibility',
    sequence: positiveInteger(cutoff.sequence, 'visibility cutoff sequence'),
    controlRunId: canonicalUuid(cutoff.controlRunId, 'visibility cutoff runId'),
  });
}

function parseApplicationMessage(
  value: unknown,
  expectedStream: DecksmithPageStreamPosition,
): DecksmithApplicationMessage {
  const message = exactObject(
    value,
    ['schemaVersion', 'kind', 'stream', 'messageKey', 'replacements'],
    [],
    'Decksmith application message',
  );
  const stream = parseStreamPosition(message.stream);
  if (
    message.schemaVersion !== DECKSMITH_PAGE_TURN_SCHEMA_VERSION ||
    message.kind !== 'application' ||
    JSON.stringify(stream) !== JSON.stringify(expectedStream)
  ) {
    throw new Error('Decksmith application message is invalid');
  }
  const replacementsObject = exactRecord(message.replacements, 'application replacements');
  const replacements: Record<string, string> = {};
  for (const [key, replacement] of Object.entries(replacementsObject)) {
    replacements[boundedIdentifier(key, 'replacement key')] = boundedString(
      replacement,
      'replacement value',
      DECKSMITH_PAGE_STREAM_LIMITS.identifierCharacters,
    );
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_PAGE_TURN_SCHEMA_VERSION,
    kind: 'application',
    stream,
    messageKey: boundedIdentifier(message.messageKey, 'messageKey'),
    replacements: Object.freeze(replacements),
  });
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
  return value;
}

function requireExactFields(value: Record<string, unknown>, expected: readonly string[]): void {
  const fields = Object.keys(value).filter((key) => value[key] !== undefined);
  if (
    fields.length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error('Decksmith context ref fields do not match its kind');
  }
}

function requireExactOptionalSet(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const discriminator = new Set(['schemaVersion', 'kind', 'stream', ...expected]);
  if (Object.keys(value).some((key) => value[key] !== undefined && !discriminator.has(key))) {
    throw new Error('Decksmith control boundary fields do not match its kind');
  }
  if (expected.some((key) => value[key] === undefined)) {
    throw new Error('Decksmith control boundary is missing fields');
  }
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedIdentifier(value: unknown, label: string): string {
  return boundedString(value, label, DECKSMITH_PAGE_STREAM_LIMITS.identifierCharacters, true);
}

function boundedString(value: unknown, label: string, limit: number, nonblank = false): string {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    (nonblank && value.trim().length === 0)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, label: string, limit: number): readonly string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} is invalid`);
  const parsed = value.map((candidate) => canonicalUuid(candidate, label));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} contain duplicates`);
  return Object.freeze(parsed);
}

function recordArray(
  value: unknown,
  label: string,
  budget: { nodes: number },
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length > DECKSMITH_PAGE_STREAM_LIMITS.factArrayEntries) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze(
    value.map((candidate) => {
      const parsed = boundedJson(candidate, label, budget, 0);
      if (!isObject(parsed)) throw new Error(`${label} entries must be objects`);
      return parsed;
    }),
  );
}

function boundedJson(
  value: unknown,
  label: string,
  budget: { nodes: number },
  depth: number,
): unknown {
  budget.nodes += 1;
  if (
    budget.nodes > DECKSMITH_PAGE_STREAM_LIMITS.factTotalNodes ||
    depth > DECKSMITH_PAGE_STREAM_LIMITS.factDepth
  ) {
    throw new Error(`${label} is too complex`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains an invalid number`);
    return value;
  }
  if (typeof value === 'string') {
    return boundedString(value, label, DECKSMITH_PAGE_STREAM_LIMITS.factStringCharacters);
  }
  if (Array.isArray(value)) {
    if (value.length > DECKSMITH_PAGE_STREAM_LIMITS.factObjectEntries) {
      throw new Error(`${label} array is too large`);
    }
    return Object.freeze(value.map((entry) => boundedJson(entry, label, budget, depth + 1)));
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > DECKSMITH_PAGE_STREAM_LIMITS.factObjectEntries) {
      throw new Error(`${label} object is too large`);
    }
    return Object.freeze(
      Object.fromEntries(
        entries.map(([key, entry]) => [
          boundedIdentifier(key, `${label} key`),
          boundedJson(entry, label, budget, depth + 1),
        ]),
      ),
    );
  }
  throw new Error(`${label} contains a non-JSON value`);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Decksmith ${label} is invalid`);
  }
  return value;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Decksmith ${label} is invalid`);
  }
  return value;
}
