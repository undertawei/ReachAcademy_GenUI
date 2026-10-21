import { createHash } from 'node:crypto';

import type { ApprovalRecord } from '../../contracts.js';
import type { RuntimeStore } from '../../store/store.js';
import { resolveReachDeckVoiceSelection } from '../content-service-client.js';
import {
  buildIdempotentPageRequestKey,
  buildStagedGenerationRequestHash,
} from '../job-identity.js';
import { sameReachDeckResourceScope } from '../resource-scope.js';
import {
  buildSavedNarrationPayload,
  publicReachDeckMediaBatch,
  type SavedNarrationMediaBatchItem,
} from '../saved-narration-media.js';
import {
  registerReachDeckWorkspaceBatch,
  resumeReachDeckWorkspaceBatch,
} from '../workspace-batch-coordinator.js';
import {
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  buildReachDeckWorkspaceBatchId,
  type ReachDeckWorkspaceBatchMember,
} from '../workspace-batches.js';
import {
  loadReachDeckMaterializedWorkspaceDocument,
  ReachDeckNarrationPreflightError,
} from '../workspace-jobs.js';
import { authorizeWorkspaceRoute } from '../workspace-route.js';
import { loadReachDeckWorkspace } from '../workspace-store.js';
import {
  decksmithAfterApplyAnimationMode,
  decksmithSlideNarrationDigest,
  readDecksmithAdoptedAfterApply,
  type DecksmithAdoptedAfterApplyAction,
} from './after-apply.js';
import { readDecksmithAdoptionOutcome } from './adoption-outcome.js';
import type { DecksmithFrozenRunInput } from './page-stream-contracts.js';
import {
  reconcileReachDeckStructuralMutationBeforeRoute,
  withReachDeckOrdinaryWriterLease,
} from './page-routes.js';

/** 采用后媒体入队完成标记的事件类型（ai_run_event，按 approvalId 幂等追加）。 */
export const DECKSMITH_AFTER_APPLY_MEDIA_EVENT = 'decksmith.after-apply.media' as const;
const AFTER_APPLY_REQUEST_SCHEMA = 'reach-deck-decksmith-after-apply-media/v1' as const;

export interface DecksmithAfterApplySkippedPage {
  readonly pageId: string;
  /** narration-changed：教师在采用后又改了讲稿；page-missing：页已不在；其余为讲稿媒体预检码。 */
  readonly reason: string;
}

/**
 * `/applied` 响应里的采用后媒体状态（编辑器据此刷新工作区，像手动生成一样展示进度）。
 * - enqueued：已登记媒体批次（或此前已登记）；
 * - skipped：所有页都因讲稿已被改动、页面不在或预检不通过而跳过（终态，不再重试）；
 * - pending：暂时无法入队（其他写入占用课件、授权或工作区暂不可用），下次 `/applied` 重试。
 */
export type DecksmithAfterApplyMediaStatus =
  | {
      readonly status: 'enqueued';
      readonly pageIds: readonly string[];
      readonly skipped: readonly DecksmithAfterApplySkippedPage[];
      readonly batchId?: string;
    }
  | { readonly status: 'skipped'; readonly skipped: readonly DecksmithAfterApplySkippedPage[] }
  | { readonly status: 'pending'; readonly pageIds: readonly string[]; readonly reason: string };

type TerminalStatus = Exclude<DecksmithAfterApplyMediaStatus, { status: 'pending' }>;

/**
 * 读取一个已真实采用的审批持久化下来的采用后媒体意图。
 *
 * 数据源：`ai_run_event` 中该审批的 `artifact.applied` 事件（结局 adopted 时才有意图）。
 */
export async function loadDecksmithAdoptedAfterApply(
  store: Pick<RuntimeStore, 'listEventsByTypes'>,
  approval: Pick<ApprovalRecord, 'id' | 'runId'>,
): Promise<DecksmithAdoptedAfterApplyAction[]> {
  const events = await store.listEventsByTypes(approval.runId, ['artifact.applied']);
  const applied = events.find((event) => event.payload.approvalId === approval.id);
  if (applied === undefined || readDecksmithAdoptionOutcome(applied.payload) !== 'adopted') {
    return [];
  }
  return readDecksmithAdoptedAfterApply(applied.payload);
}

/**
 * 真实采用后，按讲稿媒体生成接口的合同为 Decksmith 声明的页面登记媒体批次（WP8）。
 *
 * 数据源：`ai_run_event`（采用结局与意图、完成标记）、工作区记录与批次状态（workspace-store /
 * workspace-batch-coordinator）、content-service 物化文档与音色设置。
 * 核心逻辑：
 * 1. 已有完成标记（同一 approvalId）直接返回记录的终态——双击、响应丢失后的重试不会重复入队；
 * 2. 用本次请求重新鉴权（Reach Deck 作用域 token），且必须与提案冻结的角色授权、模块范围一致；
 * 3. 在普通写租约内重读工作区与物化文档：页面已不在、讲稿 digest 与采用时不同（教师随后又改了讲稿）
 *    的页跳过；其余页按当前页修订、采用时的讲稿 digest 与音色构造任务并预检；
 * 4. 批次请求 hash 由 approvalId + 页 + 动作 + 讲稿 digest 派生，不含草稿修订与音色：
 *    宕机或响应丢失后重试会命中同一批次，不会重复登记或重复收费；教师在两次重试之间改了音色
 *    也只命中已登记的批次（每个审批至多一次采用后生成），逐页任务幂等键仍绑定登记时的音色；
 * 5. 登记成功或全部跳过后追加完成标记；暂时失败（租约冲突、授权/工作区不可用）返回 pending，
 *    不写标记，等下一次 `/applied` 重试。从不调用 advanceReachDeckGenerationLanes。
 */
export async function runDecksmithAfterApplyMedia(input: {
  readonly request: Request;
  readonly store: Pick<RuntimeStore, 'listEventsByTypes' | 'appendEventIfAbsent'>;
  readonly approval: Pick<ApprovalRecord, 'id' | 'runId' | 'actor'>;
  readonly frozen: Pick<DecksmithFrozenRunInput, 'authorization' | 'resourceScope'>;
  readonly actions: readonly DecksmithAdoptedAfterApplyAction[];
}): Promise<DecksmithAfterApplyMediaStatus | undefined> {
  const { store, approval, actions } = input;
  if (actions.length === 0) return undefined;
  const pageIds = actions.map((action) => action.pageId);
  const marker = (
    await store.listEventsByTypes(approval.runId, [DECKSMITH_AFTER_APPLY_MEDIA_EVENT])
  )
    .map((event) => event.payload)
    .find((payload) => payload.approvalId === approval.id);
  if (marker !== undefined) return readMarker(marker, pageIds);

  let scoped: Awaited<ReturnType<typeof authorizeWorkspaceRoute>>;
  try {
    scoped = await authorizeWorkspaceRoute(input.request);
  } catch {
    return { status: 'pending', pageIds, reason: 'authorization-unavailable' };
  }
  if (
    scoped.actorId !== approval.actor.subject ||
    scoped.roleGrantId !== input.frozen.authorization.roleGrantId ||
    !sameReachDeckResourceScope(scoped.resourceScope, input.frozen.resourceScope)
  ) {
    return { status: 'pending', pageIds, reason: 'authorization-mismatch' };
  }

  let result: TerminalStatus;
  try {
    await reconcileReachDeckStructuralMutationBeforeRoute(scoped.workspaceContext);
    const initial = await loadReachDeckWorkspace(scoped.workspaceContext);
    const outcome = await withReachDeckOrdinaryWriterLease({
      scoped,
      operationKind: 'decksmith-after-apply-media',
      asyncRunId: initial.workspace.runId,
      operation: async (writerContext, writerSession): Promise<TerminalStatus | 'retry'> => {
        const resource = await loadReachDeckWorkspace(writerContext);
        if (resource.workspace.runId !== initial.workspace.runId) return 'retry';
        const voiceSelection = await resolveReachDeckVoiceSelection(scoped.jobScope);
        const sortedActions = [...actions].sort((left, right) =>
          left.pageId.localeCompare(right.pageId),
        );
        const requestHash = buildStagedGenerationRequestHash({
          schemaVersion: AFTER_APPLY_REQUEST_SCHEMA,
          actorId: scoped.actorId,
          billingGroupId: scoped.billingGroupId,
          roleGrantId: scoped.roleGrantId,
          resourceScope: scoped.resourceScope,
          runId: resource.workspace.runId,
          approvalId: approval.id,
          // 不含音色：完成标记丢失后若教师改了音色，重试也必须命中已登记的批次，不能再收一次费。
          actions: sortedActions.map((action) => ({
            pageId: action.pageId,
            kind: action.kind,
            narrationDigest: action.narrationDigest,
          })),
        });
        const replay = await resumeReachDeckWorkspaceBatch(
          writerContext,
          scoped.jobScope,
          resource.workspace.runId,
          'media',
          requestHash,
        );
        if (replay.status === 'expired') return { status: 'enqueued', pageIds, skipped: [] };
        if (replay.status === 'found') {
          if (replay.batch.phase !== 'terminal' && replay.batch.phase !== 'stopped') {
            await writerSession.retainForAsyncRun(resource.workspace.runId);
          }
          return {
            status: 'enqueued',
            batchId: replay.batch.batchId,
            pageIds: replay.batch.members.map((member) => member.pageId),
            skipped: [],
          };
        }
        if (resource.workspace.paused) return 'retry';
        const materialized = await loadReachDeckMaterializedWorkspaceDocument(writerContext);
        if (
          !materialized.materialized ||
          materialized.document.schemaVersion !== 'reach-deck-document/v2'
        ) {
          return 'retry';
        }
        const document = materialized.document;
        const skipped: DecksmithAfterApplySkippedPage[] = [];
        const accepted: Array<{
          item: SavedNarrationMediaBatchItem;
          requestKey: string;
          payload: Awaited<ReturnType<typeof buildSavedNarrationPayload>>;
        }> = [];
        const ordered = [...actions].sort(
          (left, right) =>
            (document.pages.find((page) => page.pageId === left.pageId)?.order ??
              Number.MAX_SAFE_INTEGER) -
            (document.pages.find((page) => page.pageId === right.pageId)?.order ??
              Number.MAX_SAFE_INTEGER),
        );
        for (const action of ordered) {
          const page = document.pages.find((candidate) => candidate.pageId === action.pageId);
          const binding = document.nativeSlides.find(
            (candidate) => candidate.pageId === action.pageId,
          );
          if (page?.sceneType !== 'slide' || binding === undefined) {
            skipped.push({ pageId: action.pageId, reason: 'page-missing' });
            continue;
          }
          // 以采用时的讲稿为准：教师之后又改了讲稿，较新的教师讲稿优先，不替它生成。
          if (decksmithSlideNarrationDigest(binding.slide) !== action.narrationDigest) {
            skipped.push({ pageId: action.pageId, reason: 'narration-changed' });
            continue;
          }
          const item: SavedNarrationMediaBatchItem = {
            pageId: action.pageId,
            expectedPageRevision: page.revision,
            narrationContentDigest: action.narrationDigest,
            idempotencyKey: afterApplyIdempotencyKey(approval.id, action, voiceSelection),
            animationMode: decksmithAfterApplyAnimationMode(action.kind),
            hasExplicitAnimationMode: true,
          };
          const requestKey = buildIdempotentPageRequestKey({
            idempotencyKey: item.idempotencyKey,
            actorId: scoped.actorId,
            billingGroupId: scoped.billingGroupId,
            resourceScope: scoped.resourceScope,
            runId: resource.workspace.runId,
            pageId: item.pageId,
            voiceSelection,
            action: 'narration-generate-saved',
          });
          try {
            const payload = await buildSavedNarrationPayload(
              resource,
              scoped.jobScope,
              materialized,
              item,
              requestKey,
              voiceSelection,
            );
            accepted.push({ item, requestKey, payload });
          } catch (error) {
            if (!(error instanceof ReachDeckNarrationPreflightError)) throw error;
            skipped.push({ pageId: action.pageId, reason: error.code });
          }
        }
        if (accepted.length === 0) return { status: 'skipped', skipped };
        const members: ReachDeckWorkspaceBatchMember[] = accepted.map(
          ({ item, payload, requestKey }, order) => ({
            pageId: item.pageId,
            order,
            sourceKind: 'materialized-native',
            requestKey,
            requestedRevision: payload.request.requestedRevision,
            attempt: payload.request.attempt,
            intent: 'waiting-dispatch',
            contentDigest: item.narrationContentDigest,
            animationMode: item.animationMode,
          }),
        );
        const batch = await registerReachDeckWorkspaceBatch({
          context: writerContext,
          scope: scoped.jobScope,
          batch: {
            schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
            batchId: buildReachDeckWorkspaceBatchId(requestHash),
            requestHash,
            runId: resource.workspace.runId,
            owner: scoped.jobScope,
            kind: 'media',
            sourceKind: 'materialized-media',
            createdAt: new Date().toISOString(),
            revision: 0,
            phase: 'ready',
            dispatchCursor: 0,
            voiceSelection,
            members,
            skipped: [],
          },
        });
        await writerSession.retainForAsyncRun(resource.workspace.runId);
        const view = publicReachDeckMediaBatch(batch);
        return {
          status: 'enqueued',
          batchId: view.batchId,
          pageIds: view.members.map((member) => member.pageId),
          skipped,
        };
      },
    });
    if (outcome === 'retry') {
      return { status: 'pending', pageIds, reason: 'workspace-unavailable' };
    }
    result = outcome;
  } catch (error) {
    // 课件被其他写入占用、内容服务暂不可用等都可重试：不写完成标记，下一次 `/applied` 再试。
    console.warn('Decksmith after-apply media enqueue deferred', {
      approvalId: approval.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'pending', pageIds, reason: 'enqueue-deferred' };
  }
  try {
    await store.appendEventIfAbsent(
      approval.runId,
      DECKSMITH_AFTER_APPLY_MEDIA_EVENT,
      { approvalId: approval.id },
      { approvalId: approval.id, ...result },
    );
  } catch (error) {
    // 标记只用于短路重试；丢失时重试会经批次请求 hash 命中同一批次，不会重复登记。
    console.warn('Decksmith after-apply media marker append failed', {
      approvalId: approval.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

/** 单页任务的幂等键：绑定 approval / 动作 / 页 / 采用时讲稿 digest / 音色（评审 M10）。 */
function afterApplyIdempotencyKey(
  approvalId: string,
  action: DecksmithAdoptedAfterApplyAction,
  voiceSelection: unknown,
): string {
  return `decksmith-after-apply:${createHash('sha256')
    .update(
      JSON.stringify([
        AFTER_APPLY_REQUEST_SCHEMA,
        approvalId,
        action.kind,
        action.pageId,
        action.narrationDigest,
        buildStagedGenerationRequestHash({ voiceSelection }),
      ]),
    )
    .digest('hex')}`;
}

function readMarker(
  payload: Readonly<Record<string, unknown>>,
  fallbackPageIds: readonly string[],
): TerminalStatus {
  const skipped = Array.isArray(payload.skipped)
    ? payload.skipped.flatMap((entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).pageId === 'string' &&
        typeof (entry as Record<string, unknown>).reason === 'string'
          ? [
              {
                pageId: (entry as Record<string, string>).pageId!,
                reason: (entry as Record<string, string>).reason!,
              },
            ]
          : [],
      )
    : [];
  if (payload.status === 'skipped') return { status: 'skipped', skipped };
  const pageIds = Array.isArray(payload.pageIds)
    ? payload.pageIds.filter((pageId): pageId is string => typeof pageId === 'string')
    : [...fallbackPageIds];
  return {
    status: 'enqueued',
    pageIds,
    skipped,
    ...(typeof payload.batchId === 'string' ? { batchId: payload.batchId } : {}),
  };
}
