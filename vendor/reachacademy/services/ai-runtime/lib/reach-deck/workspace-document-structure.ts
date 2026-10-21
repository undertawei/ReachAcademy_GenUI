import {
  parseGenerationWorkspace,
  reachDeckPageContentEqual,
  reachDeckValuesEqual,
  type GenerationWorkspace,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import { observationLogContext } from '@reachany/observability/tracing';
import { settleAdvancedReachDeckDeletedPageRetirements } from './deleted-page-retirements.js';
import {
  loadReachDeckWorkspaceRecovery,
  transitionReachDeckDeletedPageRetirements,
} from './workspace-recovery.js';
import {
  transitionReachDeckWorkspaceAtRevision,
  type ReachDeckAuthoringWorkspaceResource,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';

/** Page order is presentation metadata; an unrelated insertion/reorder does not replace content. */
export function unchangedReachDeckDocumentPageIds(
  before: ReachDeckDocument,
  after: ReachDeckDocument,
): string[] {
  return before.pages.flatMap((page) => {
    const candidate = after.pages.find((entry) => entry.pageId === page.pageId);
    if (candidate === undefined || !reachDeckPageContentEqual(page, candidate)) return [];
    const binding = (document: ReachDeckDocument) =>
      document.schemaVersion === 'reach-deck-document/v2'
        ? document.nativeSlides.find((entry) => entry.pageId === page.pageId)
        : undefined;
    return reachDeckValuesEqual(binding(before), binding(after)) ? [page.pageId] : [];
  });
}

/**
 * Retire generation records whose materialized page has been deleted or replaced with another
 * scene type. Never infer completion for an actual pending page from an incomplete projection.
 * New manual pages have no generation request and do not join the generation target set.
 * `deletedInFlightPageIds` are pages the teacher deleted while they were still generating; their
 * work has already been cancelled, so they retire even though their status is still in flight.
 */
export function reconcileReachDeckWorkspaceDocumentStructure(
  workspace: GenerationWorkspace,
  document: ReachDeckDocument,
  updatedAt: string,
  deletedInFlightPageIds: ReadonlySet<string> = new Set(),
): GenerationWorkspace {
  if (workspace.stage !== 'page-generation' && workspace.stage !== 'complete') return workspace;
  const current = new Map(document.pages.map((page) => [page.pageId, page]));
  const retired = new Set(
    workspace.order.filter((pageId) => {
      const state = workspace.statuses[pageId]?.state;
      const page = current.get(pageId);
      if (page === undefined && deletedInFlightPageIds.has(pageId)) return true;
      if (state === 'pending' || state === 'generating' || state === 'narrating') return false;
      return page === undefined || page.sceneType !== workspace.records[pageId]?.page.sceneType;
    }),
  );
  if (retired.size === 0) return workspace;
  const targets = workspace.targetPageIds.filter((pageId) => !retired.has(pageId));
  if (targets.length === 0) {
    // A fully manual replacement uses the existing copied-workspace contract, which permits
    // a saved document without generation execution state; no schema relaxation is needed.
    return parseGenerationWorkspace({
      ...workspace,
      baseDocument: document,
      baseRevisions: Object.fromEntries(document.pages.map((page) => [page.pageId, page.revision])),
      pagedOutline: undefined,
      priorGeneration: undefined,
      targetPageIds: [],
      order: [],
      records: {},
      sceneArtifacts: {},
      statuses: {},
      stage: 'copied',
      updatedAt,
    });
  }
  const order = workspace.order.filter((pageId) => !retired.has(pageId));
  const pages = order.map((pageId, index) => ({
    ...workspace.records[pageId]!.page,
    order: index + 1,
  }));
  const keep = <T>(values: Record<string, T>) =>
    Object.fromEntries(Object.entries(values).filter(([pageId]) => !retired.has(pageId)));
  return parseGenerationWorkspace({
    ...workspace,
    pagedOutline: { ...workspace.pagedOutline!, pages },
    order,
    records: Object.fromEntries(
      pages.map((page) => [page.id, { ...workspace.records[page.id]!, page, order: page.order }]),
    ),
    targetPageIds: targets,
    sceneArtifacts: keep(workspace.sceneArtifacts),
    statuses: keep(workspace.statuses),
    priorGeneration: undefined,
    stage: targets.every((pageId) => workspace.statuses[pageId]?.state === 'ready')
      ? 'complete'
      : 'page-generation',
    updatedAt,
  });
}

/** Caller holds the document writer; the exact workspace revision still fences unrelated writes. */
export async function synchronizeReachDeckWorkspaceDocumentStructure(
  context: ReachDeckWorkspaceContext,
  resource: ReachDeckAuthoringWorkspaceResource,
  document: ReachDeckDocument,
  deletedInFlightPageIds?: ReadonlySet<string>,
): Promise<ReachDeckAuthoringWorkspaceResource> {
  return (
    await synchronizeReachDeckWorkspaceDocumentStructureWithDeletions(
      context,
      resource,
      document,
      deletedInFlightPageIds,
    )
  ).resource;
}

/**
 * 按物化文档同步工作区结构，并退役删除仍在生成的页面时记下的页。
 *
 * 数据源：Mongo reach_deck_authoring_workspaces 的 workspace 与 recovery.deletedPageRetirements。
 * 核心逻辑：
 * 1. 读 recovery 里当前 run 记下的被删页，与本次保存直接给出的被删在途页合并；
 * 2. 文档里已不存在的这些页即使仍是在途状态也退役（任务早已取消），其余页按原规则同步；
 * 3. 不在这里结算记录：返回已不在工作区里的记录页，调用方推进生成链成功后再结算。
 * 设计动机：删除流程在文档写入成功、工作区同步失败时，下一次保存已无法从文档差异推出被删页；
 * 被删页的任务已取消，留在工作区会一直挡住后面的讲稿进度。记录一直保留到生成链推进成功，
 * 退役、推进、结算任一步失败后，下一次保存都能接着收尾，且幂等。
 */
export async function synchronizeReachDeckWorkspaceDocumentStructureWithDeletions(
  context: ReachDeckWorkspaceContext,
  resource: ReachDeckAuthoringWorkspaceResource,
  document: ReachDeckDocument,
  deletedInFlightPageIds: ReadonlySet<string> = new Set(),
): Promise<{
  resource: ReachDeckAuthoringWorkspaceResource;
  /** 记录里（或本次删除的在途页里）已不在工作区、尚欠一次生成链推进的页。 */
  pendingLaneAdvancePageIds: string[];
}> {
  const runId = resource.workspace.runId;
  const recorded =
    (await loadReachDeckWorkspaceRecovery(context)).recovery.deletedPageRetirements?.[runId]
      ?.pageIds ?? [];
  const forced = new Set([...deletedInFlightPageIds, ...recorded]);
  const synchronized = await retireReachDeckWorkspacePages(context, resource, document, forced);
  const remaining = new Set(synchronized.workspace.order);
  return {
    resource: synchronized,
    pendingLaneAdvancePageIds: [...forced].filter((pageId) => !remaining.has(pageId)),
  };
}

/**
 * 写入新文档之前先收尾上一次没做完的删除：记录里已不在当前文档中的页从工作区退役。
 *
 * 数据源：Mongo reach_deck_authoring_workspaces 的 workspace 与 recovery.deletedPageRetirements。
 * 核心逻辑：读当前 run 的记录 → 取已不在当前物化文档里的页 → 强制退役（版面生成中的幽灵页
 * 否则会让后续保存的页锁校验一直失败）→ 返回退役后的工作区与这些页，调用方据此推进生成链。
 * 调用方持有文档写锁。
 */
export async function recoverRecordedReachDeckPageDeletions(
  context: ReachDeckWorkspaceContext,
  resource: ReachDeckAuthoringWorkspaceResource,
  document: ReachDeckDocument,
): Promise<{ resource: ReachDeckAuthoringWorkspaceResource; pageIds: string[] }> {
  const recorded =
    (await loadReachDeckWorkspaceRecovery(context)).recovery.deletedPageRetirements?.[
      resource.workspace.runId
    ]?.pageIds ?? [];
  const inDocument = new Set(document.pages.map((page) => page.pageId));
  const pageIds = recorded.filter((pageId) => !inDocument.has(pageId));
  if (pageIds.length === 0) return { resource, pageIds };
  return {
    resource: await retireReachDeckWorkspacePages(context, resource, document, new Set(pageIds)),
    pageIds,
  };
}

/** 生成链推进成功后，从记录里结清这些页。 */
export async function settleAdvancedReachDeckPageDeletions(
  context: ReachDeckWorkspaceContext,
  runId: string,
  pageIds: readonly string[],
): Promise<void> {
  await transitionReachDeckDeletedPageRetirements(context, (current) =>
    settleAdvancedReachDeckDeletedPageRetirements(current, runId, new Set(pageIds)),
  );
}

async function retireReachDeckWorkspacePages(
  context: ReachDeckWorkspaceContext,
  resource: ReachDeckAuthoringWorkspaceResource,
  document: ReachDeckDocument,
  deletedInFlightPageIds: ReadonlySet<string>,
): Promise<ReachDeckAuthoringWorkspaceResource> {
  const next = reconcileReachDeckWorkspaceDocumentStructure(
    resource.workspace,
    document,
    new Date().toISOString(),
    deletedInFlightPageIds,
  );
  if (next === resource.workspace) return resource;
  const saved = await transitionReachDeckWorkspaceAtRevision(
    context,
    resource.draftRevision,
    () => next,
  );
  console.info(
    JSON.stringify({
      ...observationLogContext(),
      event: 'reach_deck_workspace_structure_reconciled',
      reason: 'materialized-document-structure',
      courseNodeId: context.resourceScope.courseNodeId,
      runId: next.runId,
      retiredPageCount: resource.workspace.order.length - next.order.length,
      retiredTargetCount: resource.workspace.targetPageIds.length - next.targetPageIds.length,
      previousStage: resource.workspace.stage,
      stage: next.stage,
      previousDraftRevision: resource.draftRevision,
      draftRevision: saved.resource.draftRevision,
    }),
  );
  return saved.resource;
}
