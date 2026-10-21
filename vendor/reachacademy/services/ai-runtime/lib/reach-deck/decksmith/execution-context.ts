import { createHash } from 'node:crypto';

import {
  hasCurrentLandedNarrationSource,
  parseReachDeckDocument,
  REACH_DECK_NARRATION_ANIMATION_ID_PREFIX,
  type GenerationWorkspace,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { Window } from 'happy-dom';

import type { RuntimeActor, RunRecord } from '../../contracts.js';
import { getScene } from '../../scenes.js';
import type { RuntimeStore } from '../../store/store.js';
import { getReachDeckMaterializedDocument } from '../content-service-client.js';
import {
  actorOrganizationIdFromPayload,
  REACH_DECK_DECKSMITH_CAPABILITY,
  type ReachDeckDecksmithJobInput,
  type ReachDeckDecksmithV2JobPayload,
} from '../contracts.js';
import { buildDecksmithDocumentHash, buildStagedGenerationRequestHash } from '../job-identity.js';
import {
  buildScientificGenerationContext,
  trimScientificContextSnapshot,
} from '../scientific-generation-context.js';
import {
  sameReachDeckPageDomainScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from '../resource-scope.js';
import {
  DECKSMITH_CONTEXT_REF_SCHEMA_VERSION,
  DECKSMITH_CUTOFF_SCHEMA_VERSION,
  DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
  DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
  parseDecksmithContextRef,
  parseDecksmithFrozenRunInput,
  type DecksmithContextRef,
  type DecksmithFrozenCapacitySnapshot,
  type DecksmithFrozenRunInput,
  type DecksmithFrozenContextPlan,
  type DecksmithFrozenProjection,
  type DecksmithPageMediaStatus,
  type DecksmithPageSummary,
  DECKSMITH_TURN_PROJECTION_V2,
} from './page-stream-contracts.js';
import {
  DecksmithPageStreamService,
  canonicalPageStreamScope,
  type DecksmithCompactionRunCreation,
  type DecksmithPageStreamOwnerScope,
} from './page-stream.js';
import {
  DECKSMITH_CONTEXT_SELECTION_ALGORITHM_VERSION,
  discoverDecksmithCapacity,
  estimateWithFrozenCapacity,
} from './capacity.js';
import { measureDecksmithModelInput } from './agent.js';
import { DECKSMITH_PROMPT_CONTRACT_VERSION } from './prompt-contract-version.js';
import type { DecksmithFrozenVisualInputs } from './visual-input-contract.js';
import { resolveDecksmithClarificationAnswer } from './clarification.js';
import { decksmithVisualInputsMatchDocument } from './visual-input.js';
import {
  digestDecksmithSummary,
  decksmithProjectionPolicy,
  digestDecksmithTurnProjection,
  projectCompleteDecksmithTurns,
  projectEligibleDecksmithTurns,
  snapshotDecksmithProposalOutcomes,
  type DecksmithProjectionPolicy,
} from './turn-projection.js';
import {
  buildDecksmithContextRefHints,
  decksmithSummaryContextText,
  deriveDecksmithProposalOutcome,
  readDecksmithSummaryProposalOutcomes,
} from './turn-memory.js';
import {
  DEFAULT_REACH_DECK_VOICE_SELECTION,
  parseReachDeckVoiceSelection,
  reachDeckVoiceSelectionDigest,
  type ReachDeckVoiceSelection,
} from '../voice-selection.js';

export const DECKSMITH_RECENT_WINDOW = Object.freeze({ messages: 12, utf8Bytes: 60_000 });
export const DECKSMITH_CONTEXT_ESTIMATOR_VERSION =
  'decksmith-recent-window/messages12-bytes60000/v1';

// Interactive component lookup is authoring-only. Keep the parser inert: the stored document is
// inspected for explicit selection markers but none of its scripts or resources may execute.
const interactiveComponentParserWindow = new Window({
  settings: {
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    enableImageFileLoading: false,
    enableJavaScriptEvaluation: false,
  },
});

export class DecksmithContextValidationError extends Error {
  constructor(
    readonly code:
      | 'DECKSMITH_ORIGIN_PAGE_STALE'
      | 'DECKSMITH_PAGE_REF_STALE'
      | 'DECKSMITH_COMPONENT_REF_STALE'
      | 'DECKSMITH_COMPONENT_REF_UNSUPPORTED'
      | 'DECKSMITH_FROZEN_CONTEXT_STALE',
    message: string,
  ) {
    super(message);
    this.name = 'DecksmithContextValidationError';
  }
}

export interface DecksmithPreparedTurn {
  readonly run: RunRecord;
  readonly created: boolean;
  readonly threadId: string;
  readonly frozenInput: DecksmithFrozenRunInput;
  readonly contextDigest: string;
}

/**
 * Discover the model capacity profile without holding the deck-wide writer lease. The profile is
 * independent from this probe's estimate; prepareDecksmithTurn re-estimates the authoritative
 * history snapshot under the lease before freezing the Run.
 */
export async function discoverDecksmithTurnCapacity(input: {
  readonly actor: RuntimeActor;
  readonly resourceScope: ReachDeckResourceScope;
  readonly pageId: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
  readonly document: ReachDeckDocumentV2;
  readonly contextRefs?: readonly unknown[];
  /** 路由冻结前授权得到的选中图片视觉输入；与 prepareDecksmithTurn 传入同一份。 */
  readonly visualInputs?: DecksmithFrozenVisualInputs;
}): Promise<DecksmithFrozenCapacitySnapshot> {
  const baselineHash = buildDecksmithDocumentHash(input.document);
  const origin = requirePage(input.document, input.pageId, 'DECKSMITH_ORIGIN_PAGE_STALE');
  const refs = validateContextRefs(input.contextRefs ?? [], input.document, baselineHash);
  assertVisualInputsMatch(input.visualInputs, input.document, input.pageId);
  const selectedElementIds = focusedNativeIds(refs, input.pageId);
  const scientificContextSnapshot = buildScientificGenerationContext({
    stage: 'decksmith',
    contexts: ['interactive'],
    pageIntent: { sceneType: origin.sceneType, title: origin.title },
    teacherRequest: input.prompt,
    currentEnvelopes:
      origin.sceneType === 'interactive'
        ? readScientificContextEnvelopes(origin.scene.documentHtml)
        : [],
  });
  const measure = measureDecksmithModelInput({
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt: promptWithExactReferencesForValues(input.prompt, refs),
    document: input.document,
    pageId: input.pageId,
    history: [],
    scientificContextSnapshot,
    promptContractVersion: DECKSMITH_PROMPT_CONTRACT_VERSION,
    ...(selectedElementIds.length === 0 ? {} : { selectedElementIds }),
    ...(input.visualInputs === undefined ? {} : { visualInputs: input.visualInputs }),
  });
  return discoverDecksmithCapacity({
    context: {
      actorId: input.actor.subject,
      actorOrganizationId: input.actor.orgId,
      billingGroupId: input.actor.billingGroupId ?? null,
      resourceScope: input.resourceScope,
      jobId: input.idempotencyKey,
      runId: input.idempotencyKey,
    },
    measure,
  });
}

/** Build the server-authoritative media state snapshot frozen into a Decksmith turn. */
export function deriveDecksmithPageMediaStatus(
  workspace: GenerationWorkspace,
  document: ReachDeckDocumentV2,
  pageId: string,
): DecksmithPageMediaStatus {
  const state = workspace.statuses[pageId]?.state;
  if (state === 'pending' || state === 'generating') {
    return {
      schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
      pageId,
      narration: 'not-started',
      audio: 'not-started',
      animation: 'not-started',
      reasonCode: 'layout-generating',
    };
  }
  if (state === 'narrating') {
    return {
      schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
      pageId,
      narration: 'generating',
      audio: 'generating',
      animation: 'generating',
      reasonCode: 'narration-generating',
    };
  }
  if (state === 'failed' || state === 'manual-review-required') {
    const mediaFailed = hasCurrentLandedNarrationSource(workspace, pageId);
    return {
      schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
      pageId,
      narration: mediaFailed ? 'failed' : 'not-started',
      audio: mediaFailed ? 'failed' : 'not-started',
      animation: mediaFailed ? 'failed' : 'not-started',
      reasonCode:
        state === 'manual-review-required'
          ? 'narration-review-required'
          : mediaFailed
            ? 'narration-generation-failed'
            : 'layout-generation-failed',
    };
  }
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page?.sceneType === 'interactive') {
    const narration = page.scene.narration;
    const hasNarration = narration !== undefined;
    const hasAudio = narration?.audioResourceId !== undefined;
    return {
      schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
      pageId,
      narration: hasNarration ? 'completed' : 'not-started',
      audio: hasAudio ? 'completed' : 'not-started',
      animation: 'not-started',
      ...(hasNarration || hasAudio ? {} : { reasonCode: 'not-started' }),
    };
  }
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  const narration = binding?.slide.narration;
  const hasNarration = narration?.markdown?.trim().length || narration?.segments?.length;
  const hasAudio = narration?.audioResourceId !== undefined;
  const hasNarrationAnimation =
    binding?.slide.animations.some((animation) =>
      animation.id.startsWith(REACH_DECK_NARRATION_ANIMATION_ID_PREFIX),
    ) ?? false;
  return {
    schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
    pageId,
    narration: hasNarration ? 'completed' : 'not-started',
    audio: hasAudio ? 'completed' : 'not-started',
    animation: hasNarrationAnimation ? 'completed' : 'not-started',
    ...(hasNarration || hasAudio || hasNarrationAnimation ? {} : { reasonCode: 'not-started' }),
  };
}

export async function prepareDecksmithTurn(input: {
  readonly store: RuntimeStore;
  readonly actor: RuntimeActor;
  readonly resourceScope: ReachDeckResourceScope;
  readonly pageId: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
  readonly roleGrantId: string;
  readonly baselineContentDigest: string;
  readonly document: ReachDeckDocumentV2;
  readonly voiceSelection?: ReachDeckVoiceSelection;
  readonly contextRefs?: readonly unknown[];
  readonly mediaStatus?: DecksmithPageMediaStatus;
  readonly existingRunId?: string;
  readonly capacityProfile?: DecksmithFrozenCapacitySnapshot;
  /** 选中图片视觉输入：只含稳定标识与权威 checksum，冻结进 Run 并计入容量。 */
  readonly visualInputs?: DecksmithFrozenVisualInputs;
  /** 浏览器声明本条消息回答的 Decksmith 问题 id（WP7）；入队时核对并冻结关联结论。 */
  readonly answersQuestionId?: string;
}): Promise<DecksmithPreparedTurn> {
  const voiceSelection = parseReachDeckVoiceSelection(
    input.voiceSelection ?? DEFAULT_REACH_DECK_VOICE_SELECTION,
  );
  const baselineHash = buildDecksmithDocumentHash(input.document);
  const origin = requirePage(input.document, input.pageId, 'DECKSMITH_ORIGIN_PAGE_STALE');
  const ownerScope: DecksmithPageStreamOwnerScope = {
    actor: input.actor,
    resourceScope: input.resourceScope,
    pageId: input.pageId,
  };
  const streams = new DecksmithPageStreamService(input.store);
  const stream = await streams.pageStream(ownerScope);
  const refs = validateContextRefs(input.contextRefs ?? [], input.document, baselineHash);
  const scene = getScene('teacher.deck');
  if (scene === undefined) throw new Error('teacher.deck Scene is unavailable');
  const { domainScope } = canonicalPageStreamScope(ownerScope);
  if (input.existingRunId !== undefined) {
    const existing = await input.store.getRun(input.existingRunId);
    if (existing === null || existing.threadId !== stream.threadId) {
      throw new DecksmithContextValidationError(
        'DECKSMITH_FROZEN_CONTEXT_STALE',
        'Decksmith idempotency key collides with different frozen context',
      );
    }
    const stored = parseDecksmithFrozenRunInput(existing.input);
    const storedRequestKey = `decksmith-turn-v2:${buildDecksmithV2RequestIdentity({
      idempotencyKey: input.idempotencyKey,
      billingGroupId: input.actor.billingGroupId ?? null,
      resourceScope: input.resourceScope,
      frozenInput: stored,
    })}`;
    if (
      existing.requestKey !== storedRequestKey ||
      stored.message !== input.prompt ||
      stored.authorization.roleGrantId !== input.roleGrantId ||
      stored.baseline.documentHash !== baselineHash ||
      stored.baseline.contentDigest !== input.baselineContentDigest ||
      stored.baseline.pageRevision !== origin.revision ||
      JSON.stringify(stored.contextRefs) !== JSON.stringify(refs) ||
      JSON.stringify(stored.mediaStatus) !== JSON.stringify(input.mediaStatus) ||
      stored.clarificationAnswer?.questionId !== input.answersQuestionId ||
      reachDeckVoiceSelectionDigest(stored.voiceSelection) !==
        reachDeckVoiceSelectionDigest(voiceSelection)
    ) {
      throw new DecksmithContextValidationError(
        'DECKSMITH_FROZEN_CONTEXT_STALE',
        'Decksmith idempotency key collides with different frozen context',
      );
    }
    return {
      run: existing,
      created: false,
      threadId: stream.threadId,
      frozenInput: stored,
      contextDigest: buildDecksmithFrozenContextDigest(stored),
    };
  }
  const storedSummary =
    stream.context.summary === undefined
      ? null
      : await input.store.loadDecksmithSummary({
          threadId: stream.threadId,
          scope: ownerScope,
          ref: stream.context.summary,
        });
  if (stream.context.summary !== undefined && storedSummary === null) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_FROZEN_CONTEXT_STALE',
      'Decksmith rolling summary is unavailable or invalid',
    );
  }
  const summaryRef =
    stream.context.summary === undefined || storedSummary === null
      ? undefined
      : {
          ...stream.context.summary,
          summaryDigest:
            stream.context.summary.summaryDigest ?? digestDecksmithSummary(storedSummary.summary),
          sourceLastSequence:
            stream.context.summary.sourceLastSequence ?? storedSummary.summary.source.lastSequence,
        };
  const compactionSnapshot = await input.store.loadDecksmithCompactionSnapshot({
    threadId: stream.threadId,
    scope: ownerScope,
  });
  // 冻结投影合同（WP1 / 评审 M1）：新 Run 一律 v2，入队时已知的提案结局写入快照；
  // 执行、压缩与安装时都按这份快照重建投影，之后到达的审批事件不会让本 Run 误报 stale。
  const summaryOutcomeUpdates =
    storedSummary === null
      ? []
      : await resolveSummaryOutcomeUpdates(
          input.store,
          stream.threadId,
          ownerScope,
          storedSummary.summary,
        );
  const contextRefHints = buildDecksmithContextRefHints(input.document, refs);
  // 回答关联（WP7）：只认本页本话题最近一轮的问题；过期或重复回答不失败，冻结为说明交给模型。
  const clarificationAnswer =
    input.answersQuestionId === undefined
      ? undefined
      : resolveDecksmithClarificationAnswer({
          items: compactionSnapshot.items,
          epoch: stream.context.currentEpoch.epoch,
          questionId: input.answersQuestionId,
        });
  const proposalOutcomes = snapshotDecksmithProposalOutcomes(compactionSnapshot.items);
  const projection: DecksmithFrozenProjection = {
    projectionVersion: DECKSMITH_TURN_PROJECTION_V2,
    proposalOutcomes,
    ...(summaryOutcomeUpdates.length === 0 ? {} : { summaryOutcomeUpdates }),
    ...(contextRefHints === undefined ? {} : { contextRefHints }),
  };
  const projectionPolicy = decksmithProjectionPolicy(projection);
  // Select model history from the complete bounded compaction snapshot, not only the first UI
  // history page. This lets the shared gap-aware selector retain an older interrupted teacher turn
  // while still applying the 12-message / 60k recent window.
  const assembled = assembleDecksmithRecentHistory(
    compactionSnapshot.items,
    stream.context.currentEpoch.epoch,
    projectionPolicy,
  );
  const fullHistory = assembleHistory(
    compactionSnapshot.items,
    stream.context.currentEpoch.epoch,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    projectionPolicy,
  );
  let scientificContextSnapshot = buildScientificGenerationContext({
    stage: 'decksmith',
    contexts: ['interactive'],
    pageIntent: { sceneType: origin.sceneType, title: origin.title },
    teacherRequest: input.prompt,
    currentEnvelopes:
      origin.sceneType === 'interactive'
        ? readScientificContextEnvelopes(origin.scene.documentHtml)
        : [],
  });
  assertVisualInputsMatch(input.visualInputs, input.document, input.pageId);
  const selectedElementIds = focusedNativeIds(refs, input.pageId);
  const modelInput = {
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt: promptWithExactReferencesForValues(input.prompt, refs),
    document: input.document,
    pageId: input.pageId,
    history: fullHistory.messages,
    // 新 Run 冻结当前提示词合同版本；测算与执行都按这一版本组装提示词和工具面。
    promptContractVersion: DECKSMITH_PROMPT_CONTRACT_VERSION,
    ...(storedSummary === null
      ? {}
      : {
          contextSummary: decksmithSummaryContextText(
            storedSummary.summary.text,
            projection.summaryOutcomeUpdates,
          ),
        }),
    // 恢复时会把冻结的媒体状态交给模型，容量测算必须按同一份输入计算。
    ...(input.mediaStatus === undefined ? {} : { mediaStatus: input.mediaStatus }),
    // 恢复时同样会带上选中元素与附图（以固定占位计入），冻结测算必须一致。
    ...(selectedElementIds.length === 0 ? {} : { selectedElementIds }),
    ...(input.visualInputs === undefined ? {} : { visualInputs: input.visualInputs }),
    // 恢复时回答关联说明会进入首条用户消息，测算同样计入。
    ...(clarificationAnswer === undefined ? {} : { clarificationAnswer }),
  };
  let measure = measureDecksmithModelInput({ ...modelInput, scientificContextSnapshot });
  let capacity =
    input.capacityProfile === undefined
      ? await discoverDecksmithCapacity({
          context: {
            actorId: input.actor.subject,
            actorOrganizationId: input.actor.orgId,
            billingGroupId: input.actor.billingGroupId ?? null,
            resourceScope: input.resourceScope,
            jobId: input.idempotencyKey,
            runId: input.idempotencyKey,
          },
          measure,
        })
      : estimateWithFrozenCapacity(input.capacityProfile, measure);
  // Trim optional scientific examples before freezing either the capacity plan or run identity.
  while (capacity.state === 'blocked' || capacity.state === 'needs_compaction') {
    const trimmed = trimScientificContextSnapshot(scientificContextSnapshot);
    if (trimmed === null) break;
    scientificContextSnapshot = trimmed;
    measure = measureDecksmithModelInput({ ...modelInput, scientificContextSnapshot });
    capacity = estimateWithFrozenCapacity(capacity, measure);
  }
  const completeOlderTurns = projectCompleteDecksmithTurns(
    compactionSnapshot.items,
    stream.context.currentEpoch.epoch,
    projectionPolicy,
  ).filter((turn) => !assembled.runIds.includes(turn.runId));
  const olderById = new Map(compactionSnapshot.items.map((item) => [item.runId, item]));
  const older = completeOlderTurns.map((turn) => olderById.get(turn.runId)!);
  let compaction: DecksmithFrozenContextPlan['compaction'];
  let compactionRun: DecksmithCompactionRunCreation | undefined;
  if (!compactionSnapshot.truncated && older.length > 0 && capacity.state !== 'ordinary') {
    const source = {
      runIds: older.map((item) => item.runId),
      firstSequence: parseDecksmithFrozenRunInput(older[0]!.input).stream.sequence,
      lastSequence: parseDecksmithFrozenRunInput(older.at(-1)!.input).stream.sequence,
      digest: digestDecksmithTurnProjection(
        completeOlderTurns,
        summaryRef?.summaryDigest,
        DECKSMITH_TURN_PROJECTION_V2,
      ),
    };
    const olderRunIds = new Set(source.runIds);
    const compactionInput = {
      schemaVersion: 'reach-deck-decksmith-compaction-run-input/v1' as const,
      kind: 'decksmith-compaction' as const,
      message: '' as const,
      authorization: { roleGrantId: input.roleGrantId },
      resourceScope: input.resourceScope,
      threadId: stream.threadId,
      pageId: input.pageId,
      epoch: stream.context.currentEpoch.epoch,
      source,
      ...(summaryRef === undefined ? {} : { previousSummaryRef: summaryRef }),
      ...(storedSummary === null ? {} : { previousSummary: storedSummary.summary }),
      capacity,
      inputDigest: buildStagedGenerationRequestHash({ source, capacity }),
      // 压缩子 Run 沿用父 Run 冻结的结局快照（只取其源 Run），执行与安装时按同一快照校验 digest。
      projection: {
        projectionVersion: DECKSMITH_TURN_PROJECTION_V2,
        proposalOutcomes: proposalOutcomes.filter((entry) => olderRunIds.has(entry.runId)),
        ...(summaryOutcomeUpdates.length === 0 ? {} : { summaryOutcomeUpdates }),
      },
    };
    const childId = deterministicCompactionRunId(compactionInput);
    compactionRun = {
      id: childId,
      run: {
        threadId: stream.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: scene.version,
        actor: input.actor,
        requestKey: `decksmith-compaction:${stream.threadId}:${source.digest}`,
        input: compactionInput,
        domainScope,
        tokenBudget: scene.perRunTokens,
      },
    };
    compaction = { runId: childId, inputDigest: compactionInput.inputDigest, source };
  }
  const sequence = stream.context.streamSequence + 1;
  const frozenInput = parseDecksmithFrozenRunInput({
    schemaVersion: DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
    kind: 'decksmith-turn',
    message: input.prompt,
    authorization: {
      roleGrantId: input.roleGrantId,
    },
    resourceScope: input.resourceScope,
    voiceSelection,
    scientificContextSnapshot,
    stream: {
      schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
      pageId: input.pageId,
      sequence,
      epoch: stream.context.currentEpoch.epoch,
      contextRevision: stream.context.contextRevision + 1,
    },
    baseline: {
      documentId: input.document.id,
      documentHash: baselineHash,
      contentDigest: input.baselineContentDigest,
      pageId: input.pageId,
      pageRevision: origin.revision,
    },
    contextRefs: refs,
    ...(input.mediaStatus === undefined ? {} : { mediaStatus: input.mediaStatus }),
    ...(input.visualInputs === undefined ? {} : { visualInputs: input.visualInputs }),
    projection,
    promptContractVersion: DECKSMITH_PROMPT_CONTRACT_VERSION,
    ...(clarificationAnswer === undefined ? {} : { clarificationAnswer }),
    summaryOrCutoff:
      storedSummary === null
        ? {
            schemaVersion: DECKSMITH_CUTOFF_SCHEMA_VERSION,
            kind: 'deterministic-cutoff',
            epoch: stream.context.currentEpoch.epoch,
            afterSequence: Math.max(
              stream.context.currentEpoch.startedAfterSequence,
              stream.context.modelContextCutoffSequence,
            ),
            reason:
              stream.context.visibilityCutoff === undefined ? 'no-summary' : 'visibility-cutoff',
          }
        : storedSummary.summary,
    includedRunRange: {
      runIds: assembled.runIds,
      firstSequence: assembled.firstSequence,
      lastSequence: assembled.lastSequence,
      digest: assembled.digest,
    },
    estimatorVersion: DECKSMITH_CONTEXT_ESTIMATOR_VERSION,
    capacity,
    contextPlan: {
      schemaVersion: 'reach-deck-decksmith-context-plan/v1',
      selectionAlgorithmVersion: DECKSMITH_CONTEXT_SELECTION_ALGORITHM_VERSION,
      transcriptSourceDigest: digestDecksmithTurnProjection(
        projectEligibleDecksmithTurns(
          compactionSnapshot.items,
          stream.context.currentEpoch.epoch,
          projectionPolicy,
        ),
        summaryRef?.summaryDigest,
        DECKSMITH_TURN_PROJECTION_V2,
      ),
      coverage: {
        truncated: compactionSnapshot.truncated,
        eligibleRunCount: compactionSnapshot.items.length + (compactionSnapshot.truncated ? 1 : 0),
        contiguous: !compactionSnapshot.truncated,
      },
      ...(summaryRef === undefined ? {} : { previousSummaryRef: summaryRef }),
      recentCandidates: {
        runIds: assembled.runIds,
        firstSequence: assembled.firstSequence,
        lastSequence: assembled.lastSequence,
        digest: assembled.digest,
      },
      ...(compaction === undefined ? {} : { compaction }),
    },
  });
  const requestKey = `decksmith-turn-v2:${buildDecksmithV2RequestIdentity({
    idempotencyKey: input.idempotencyKey,
    billingGroupId: input.actor.billingGroupId ?? null,
    resourceScope: input.resourceScope,
    frozenInput,
  })}`;
  const created = await input.store.createDecksmithPageTurn({
    threadId: stream.threadId,
    scope: ownerScope,
    ...(compactionRun === undefined ? {} : { compaction: compactionRun }),
    run: {
      threadId: stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: scene.version,
      actor: input.actor,
      requestKey,
      input: frozenInput,
      domainScope,
      tokenBudget: scene.perRunTokens,
    },
  });
  const stored = parseDecksmithFrozenRunInput(created.run.input);
  return {
    run: created.run,
    created: created.created,
    threadId: stream.threadId,
    frozenInput: stored,
    contextDigest: buildDecksmithFrozenContextDigest(stored),
  };
}

export function deterministicCompactionRunId(input: unknown): string {
  const bytes = createHash('sha256')
    .update(`reach-deck-decksmith-compaction-run/v1\n${buildStagedGenerationRequestHash(input)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function rehydrateDecksmithV2Input(
  payload: ReachDeckDecksmithV2JobPayload,
  store: RuntimeStore,
): Promise<ReachDeckDecksmithJobInput> {
  const run = await store.getRun(payload.runtimeRunId);
  if (
    run === null ||
    run.sceneKey !== 'teacher.deck' ||
    run.threadId !== payload.threadId ||
    run.actor.subject !== payload.actorId ||
    run.actor.orgId !== actorOrganizationIdFromPayload(payload)
  ) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_FROZEN_CONTEXT_STALE',
      'Decksmith frozen run ownership is stale',
    );
  }
  if (!(await store.ownsActiveDecksmithDeckLease(run.id))) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_FROZEN_CONTEXT_STALE',
      'Decksmith execution lease is stale',
    );
  }
  const frozen = parseDecksmithFrozenRunInput(run.input);
  if (
    buildDecksmithFrozenContextDigest(frozen) !== payload.contextDigest ||
    frozen.baseline.documentHash !== payload.baseDocumentHash ||
    frozen.authorization.roleGrantId !== payload.roleGrantId ||
    !sameReachDeckResourceScope(frozen.resourceScope, payload.resourceScope) ||
    !sameReachDeckPageDomainScope(run.domainScope, payload.resourceScope, frozen.stream.pageId) ||
    frozen.stream.pageId !== run.domainScope.pageId
  ) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_FROZEN_CONTEXT_STALE',
      'Decksmith frozen context digest is stale',
    );
  }
  const materialized = await getReachDeckMaterializedDocument({
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  });
  if (materialized.materialized !== true || materialized.learnerDocument === undefined) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_FROZEN_CONTEXT_STALE',
      'Decksmith authoritative baseline is unavailable',
    );
  }
  const document = parseReachDeckDocument(materialized.learnerDocument);
  if (
    typeof materialized.contentDigest !== 'string' ||
    materialized.contentDigest.trim().length === 0 ||
    document.schemaVersion !== 'reach-deck-document/v2'
  ) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_FROZEN_CONTEXT_STALE',
      'Decksmith authoritative baseline is unavailable',
    );
  }
  // Non-structural page saves may run beside a Decksmith turn, so the deck can move on between
  // enqueue and pickup. The turn works on the current document; its proposal records that baseline
  // and adoption rebases onto whatever the other pages hold at that time.
  if (
    materialized.contentDigest !== frozen.baseline.contentDigest ||
    buildDecksmithDocumentHash(document) !== payload.baseDocumentHash
  ) {
    console.info('Decksmith turn starts from a newer document than it was queued on', {
      runId: run.id,
      pageId: frozen.stream.pageId,
    });
  }
  const scope: DecksmithPageStreamOwnerScope = {
    actor: run.actor,
    resourceScope: payload.resourceScope,
    pageId: frozen.stream.pageId,
    ...(frozen.mediaStatus === undefined ? {} : { mediaStatus: frozen.mediaStatus }),
  };
  const selected = await store.loadDecksmithFrozenHistory({
    threadId: payload.threadId,
    scope,
    runIds: frozen.includedRunRange.runIds,
  });
  // 旧 Run（无 projection）按 v1 重建并校验原 digest；新 Run 按冻结的结局快照重建 v2。
  const assembled = assembleDecksmithRecentHistory(
    selected,
    frozen.stream.epoch,
    decksmithProjectionPolicy(frozen.projection),
  );
  if (
    assembled.digest !== frozen.includedRunRange.digest ||
    JSON.stringify(assembled.runIds) !== JSON.stringify(frozen.includedRunRange.runIds)
  ) {
    throw new DecksmithContextValidationError(
      'DECKSMITH_FROZEN_CONTEXT_STALE',
      'Decksmith frozen history is unavailable',
    );
  }
  return {
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt: promptWithExactReferences(frozen),
    document,
    voiceSelection: frozen.voiceSelection,
    ...(frozen.scientificContextSnapshot === undefined
      ? {}
      : { scientificContextSnapshot: frozen.scientificContextSnapshot }),
    pageId: frozen.stream.pageId,
    // 冻结的来源页媒体状态：既进入提示词说明，也作为会话的生成锁；漏传会让"生成中禁止改讲稿/音频/动画"失效。
    ...(frozen.mediaStatus === undefined ? {} : { mediaStatus: frozen.mediaStatus }),
    // 只交出稳定标识；执行时重新授权取图并核对 checksum。
    ...(frozen.visualInputs === undefined ? {} : { visualInputs: frozen.visualInputs }),
    // 旧 Run 没有版本字段：保持缺省，继续使用旧提示词与互动合同预加载。
    ...(frozen.promptContractVersion === undefined
      ? {}
      : { promptContractVersion: frozen.promptContractVersion }),
    // 冻结的回答关联结论（WP7）；旧 Run 与普通消息没有，首条用户消息不变。
    ...(frozen.clarificationAnswer === undefined
      ? {}
      : { clarificationAnswer: frozen.clarificationAnswer }),
    ...(frozen.capacity === undefined || frozen.capacity.state === 'ordinary'
      ? {}
      : { capacity: frozen.capacity }),
    ...(frozen.summaryOrCutoff.kind === 'summary'
      ? {
          contextSummary: decksmithSummaryContextText(
            frozen.summaryOrCutoff.text,
            frozen.projection?.summaryOutcomeUpdates,
          ),
        }
      : {}),
    ...(focusedNativeIds(frozen.contextRefs, frozen.stream.pageId).length === 0
      ? {}
      : { selectedElementIds: focusedNativeIds(frozen.contextRefs, frozen.stream.pageId) }),
    ...(assembled.messages.length === 0 ? {} : { history: assembled.messages }),
  };
}

function readScientificContextEnvelopes(html: string): readonly unknown[] {
  const document = interactiveComponentParserWindow.document.implementation.createHTMLDocument();
  document.body.innerHTML = html;
  return [...document.querySelectorAll('script[data-reach-science-kit]')]
    .slice(0, 4)
    .flatMap((marker) => {
      try {
        return [JSON.parse(marker.textContent ?? '') as unknown];
      } catch {
        return [];
      }
    });
}

function validateContextRefs(
  values: readonly unknown[],
  document: ReachDeckDocumentV2,
  baselineHash: string,
): readonly DecksmithContextRef[] {
  return values.map((value) => {
    const ref = parseDecksmithContextRef(value);
    if (ref.baseline.documentId !== document.id || ref.baseline.documentHash !== baselineHash) {
      throw new DecksmithContextValidationError(
        'DECKSMITH_PAGE_REF_STALE',
        'Decksmith reference baseline is stale',
      );
    }
    const page = requirePage(document, ref.pageId, 'DECKSMITH_PAGE_REF_STALE');
    const pageOrder = document.pages.findIndex((candidate) => candidate.pageId === ref.pageId) + 1;
    const revision = ref.kind === 'page' ? ref.revision : ref.pageRevision;
    if (revision !== page.revision) {
      throw new DecksmithContextValidationError(
        'DECKSMITH_PAGE_REF_STALE',
        'Decksmith referenced page revision is stale',
      );
    }
    if (ref.kind === 'page') {
      if (ref.label !== page.title || ref.order !== pageOrder) {
        throw new DecksmithContextValidationError(
          'DECKSMITH_PAGE_REF_STALE',
          'Decksmith referenced page metadata is stale',
        );
      }
      return ref;
    }
    if (
      ref.pageLabel !== page.title ||
      ref.pageOrder !== pageOrder ||
      ref.sceneId !== (page.sceneType === 'slide' ? page.pageId : page.scene.id) ||
      ref.sceneType !== page.sceneType
    ) {
      throw staleComponent();
    }
    if (ref.kind === 'native-element') {
      if (page.sceneType !== 'slide') throw unsupportedComponent();
      const binding = document.nativeSlides.find((candidate) => candidate.pageId === page.pageId);
      const component =
        binding === undefined ? undefined : findObjectById(binding.slide, ref.componentId);
      if (
        component === undefined ||
        component.type !== ref.componentType ||
        buildStagedGenerationRequestHash(component) !== ref.baseline.componentHash
      ) {
        throw staleComponent();
      }
      return ref;
    }
    if (page.sceneType !== 'interactive') throw unsupportedComponent();
    const component = findMarkedInteractiveComponent(page.scene, ref.componentId);
    if (
      component === undefined ||
      component.type !== ref.componentType ||
      buildStagedGenerationRequestHash(component) !== ref.baseline.componentHash
    ) {
      throw staleComponent();
    }
    return ref;
  });
}

function assertVisualInputsMatch(
  visualInputs: DecksmithFrozenVisualInputs | undefined,
  document: ReachDeckDocumentV2,
  pageId: string,
): void {
  if (
    visualInputs !== undefined &&
    !decksmithVisualInputsMatchDocument(visualInputs, document, pageId)
  ) {
    throw staleComponent();
  }
}

function requirePage(
  document: ReachDeckDocumentV2,
  pageId: string,
  code: 'DECKSMITH_ORIGIN_PAGE_STALE' | 'DECKSMITH_PAGE_REF_STALE',
) {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined)
    throw new DecksmithContextValidationError(code, 'Decksmith page is stale or deleted');
  return page;
}

function unsupportedComponent() {
  return new DecksmithContextValidationError(
    'DECKSMITH_COMPONENT_REF_UNSUPPORTED',
    'Quiz internal component references are not supported',
  );
}

function staleComponent() {
  return new DecksmithContextValidationError(
    'DECKSMITH_COMPONENT_REF_STALE',
    'Decksmith focused component is stale or forged',
  );
}

function findObjectById(value: unknown, id: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findObjectById(child, id);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.id === id) return record;
  for (const child of Object.values(record)) {
    const found = findObjectById(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findMarkedInteractiveComponent(
  value: unknown,
  id: string,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const documentHtml = (value as Record<string, unknown>).documentHtml;
  if (typeof documentHtml !== 'string') return undefined;
  const document = new interactiveComponentParserWindow.DOMParser().parseFromString(
    documentHtml,
    'text/html',
  );
  const matches = [...document.querySelectorAll('[data-reach-component-id]')].filter(
    (element) => element.getAttribute('data-reach-component-id') === id,
  );
  if (matches.length !== 1) return undefined;
  const element = matches[0]!;
  return {
    id,
    type: element.localName,
    html: element.outerHTML,
  };
}

/**
 * 最近窗口历史（12 条消息 / 60,000 字节，从新到旧），入队、执行与回放夹具共用同一实现。
 *
 * 数据源：压缩快照或冻结历史中的 Run 冻结输入与事件（ai_run、ai_run_event）。
 */
export function assembleDecksmithRecentHistory(
  items: readonly {
    runId: string;
    status: RunRecord['status'];
    input: unknown;
    events: readonly { type: string; payload: Readonly<Record<string, unknown>> }[];
  }[],
  epoch: number,
  policy: DecksmithProjectionPolicy,
) {
  return assembleHistory(
    items,
    epoch,
    DECKSMITH_RECENT_WINDOW.messages,
    DECKSMITH_RECENT_WINDOW.utf8Bytes,
    policy,
  );
}

function assembleHistory(
  items: readonly {
    runId: string;
    status: RunRecord['status'];
    input: unknown;
    events: readonly { type: string; payload: Readonly<Record<string, unknown>> }[];
  }[],
  epoch: number,
  messageLimit: number,
  byteLimit: number,
  policy: DecksmithProjectionPolicy,
) {
  const candidates = projectEligibleDecksmithTurns(items, epoch, policy)
    .map((turn) => ({
      runId: turn.runId,
      sequence: turn.sequence,
      messages: [
        { role: turn.user.role, text: turn.user.content },
        ...(turn.assistant === undefined
          ? []
          : [{ role: turn.assistant.role, text: turn.assistant.content }]),
      ],
    }))
    .sort((left, right) => left.sequence - right.sequence);
  const hardBoundary = candidates.find((candidate) => candidate.messages.length === 1);
  const kept: typeof candidates = [];
  let messageCount = hardBoundary?.messages.length ?? 0;
  let bytes =
    hardBoundary === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(hardBoundary.messages), 'utf8');
  if (hardBoundary !== undefined && messageCount <= messageLimit && bytes <= byteLimit) {
    kept.push(hardBoundary);
  } else if (hardBoundary !== undefined) {
    messageCount = 0;
    bytes = 0;
  }
  for (const candidate of [...candidates].reverse()) {
    if (candidate.runId === hardBoundary?.runId) continue;
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate.messages), 'utf8');
    if (
      messageCount + candidate.messages.length > messageLimit ||
      bytes + candidateBytes > byteLimit
    )
      break;
    kept.push(candidate);
    messageCount += candidate.messages.length;
    bytes += candidateBytes;
  }
  kept.sort((left, right) => left.sequence - right.sequence);
  const messages = kept.flatMap((item) => item.messages);
  const runIds = kept.map((item) => item.runId);
  return {
    messages,
    runIds,
    firstSequence: kept[0]?.sequence ?? 0,
    lastSequence: kept.at(-1)?.sequence ?? 0,
    // v1 的 digest 形状保持不变（旧冻结 Run 按它校验）；v2 额外带版本号。
    digest: createHash('sha256')
      .update(
        JSON.stringify(
          policy.projectionVersion === 1
            ? { runIds, messages }
            : { projectionVersion: policy.projectionVersion, runIds, messages },
        ),
      )
      .digest('hex'),
  };
}

/**
 * 找出旧摘要中当时仍 pending、现在已有结局的提案，作为本 Run 冻结的"结局更新"。
 *
 * 数据源：滚动摘要的结构化 proposalOutcomes（服务端写入的条目）；对应源 Run 的审批 / 采用事件
 * （ai_run、ai_run_event，经 loadDecksmithFrozenHistory 按 owner 范围读取）。
 * 核心逻辑：
 * 1. 只挑出摘要里 outcome=pending 的结构化条目；模型自由生成的旧条目无法定位，不纠正；
 * 2. 读取这些 Run 的当前事件并推导结局，仍为 pending 或无法推导的跳过；
 * 3. 读取失败（Run 已不可见等）时不阻断入队，按无更新处理。
 */
async function resolveSummaryOutcomeUpdates(
  store: RuntimeStore,
  threadId: string,
  scope: DecksmithPageStreamOwnerScope,
  summary: DecksmithPageSummary,
): Promise<NonNullable<DecksmithFrozenProjection['summaryOutcomeUpdates']>> {
  const pending = readDecksmithSummaryProposalOutcomes(summary.proposalOutcomes).filter(
    (entry) => entry.outcome === 'pending',
  );
  if (pending.length === 0) return [];
  let items: Awaited<ReturnType<RuntimeStore['loadDecksmithFrozenHistory']>>;
  try {
    items = await store.loadDecksmithFrozenHistory({
      threadId,
      scope,
      runIds: [...new Set(pending.map((entry) => entry.runId))],
    });
  } catch {
    return [];
  }
  const current = new Map(
    items.map((item) => [item.runId, deriveDecksmithProposalOutcome(item.events)]),
  );
  const seen = new Set<string>();
  return pending.flatMap((entry) => {
    const outcome = current.get(entry.runId);
    if (outcome === undefined || outcome === 'pending' || seen.has(entry.runId)) return [];
    seen.add(entry.runId);
    return [{ runId: entry.runId, sequence: entry.sequence, outcome }];
  });
}

function promptWithExactReferences(input: DecksmithFrozenRunInput): string {
  return promptWithExactReferencesForValues(input.message, input.contextRefs);
}

function promptWithExactReferencesForValues(
  message: string,
  refs: readonly DecksmithContextRef[],
): string {
  const pages = [...new Set(refs.map((ref) => ref.pageId))];
  const components = refs.flatMap((ref) =>
    ref.kind === 'page' ? [] : [`${ref.pageId}#${ref.componentId} (${ref.kind})`],
  );
  return pages.length === 0
    ? message
    : `${message}\n\nExact referenced pages: ${pages.join(', ')}.${
        components.length === 0 ? '' : ` Exact focused components: ${components.join(', ')}.`
      } Call read_page(pageId) directly for each referenced page and focus only the named component IDs; do not call list_pages first and do not load those pages' chat history.`;
}

function focusedNativeIds(refs: readonly DecksmithContextRef[], originPageId: string): string[] {
  return refs.flatMap((ref) =>
    ref.kind === 'native-element' && ref.pageId === originPageId ? [ref.componentId] : [],
  );
}

export function buildDecksmithV2RequestIdentity(input: {
  readonly idempotencyKey: string;
  readonly billingGroupId: string | null;
  readonly resourceScope: ReachDeckResourceScope;
  readonly frozenInput: DecksmithFrozenRunInput;
}): string {
  if (!sameReachDeckResourceScope(input.resourceScope, input.frozenInput.resourceScope)) {
    throw new Error('Decksmith v2 request resource scope does not match the frozen input');
  }
  return buildStagedGenerationRequestHash({
    version: 2,
    clientIdempotencyKey: input.idempotencyKey,
    billingGroupId: input.billingGroupId,
    roleGrantId: input.frozenInput.authorization.roleGrantId,
    resourceScope: input.frozenInput.resourceScope,
    prompt: input.frozenInput.message,
    baselineHash: input.frozenInput.baseline.documentHash,
    originPageId: input.frozenInput.stream.pageId,
    epoch: input.frozenInput.stream.epoch,
    refsContextDigest: buildStagedGenerationRequestHash(input.frozenInput.contextRefs),
    ...(input.frozenInput.schemaVersion === DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION
      ? {}
      : { voiceDigest: reachDeckVoiceSelectionDigest(input.frozenInput.voiceSelection) }),
  });
}

/** Preserves the exact durable v1 digest while exposing a default voice to execution. */
export function buildDecksmithFrozenContextDigest(input: DecksmithFrozenRunInput): string {
  if (input.schemaVersion !== DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION) {
    return buildStagedGenerationRequestHash(input);
  }
  const { voiceSelection: _executionDefault, ...legacyIdentity } = input;
  return buildStagedGenerationRequestHash(legacyIdentity);
}
