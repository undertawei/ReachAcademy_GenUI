export { selectReachDeckRegenerationPages } from '@reachany/reach-deck-dsl';
import {
  selectReachDeckRegenerationPages,
  type ReachDeckRegenerationChannels,
  type ReachDeckRegenerationPlan,
} from '@reachany/reach-deck-dsl';
import { buildStagedGenerationRequestHash } from './job-identity.js';
import {
  loadReachDeckWorkspace,
  ReachDeckWorkspaceRevisionConflictError,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import { loadReachDeckMaterializedWorkspaceDocument } from './workspace-jobs.js';
import {
  loadReachDeckWorkspaceRecovery,
  listReachDeckWorkspaceRecoveryJobs,
} from './workspace-recovery.js';
import {
  registerReachDeckWorkspaceBatch,
  resumeReachDeckWorkspaceBatch,
} from './workspace-batch-coordinator.js';
import {
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  buildReachDeckWorkspaceBatchId,
  sameReachDeckWorkspaceBatchOwner,
  type ReachDeckWorkspaceBatch,
} from './workspace-batches.js';
import { publicReachDeckMediaBatch } from './saved-narration-media.js';
import { conflict, type AuthorizedWorkspaceRouteContext } from './workspace-route.js';
import { resolveReachDeckVoiceSelection } from './content-service-client.js';
import { activeReachDeckImagePageIds } from './image-work-admission.js';

/** A failed retry remains visible even when landing deliberately kept valid old media.
 * Apply history oldest first, so a later successful retry clears that lane's failure. */
export function applyReachDeckRegenerationBatchFailures(
  failures: Map<string, Set<string>>,
  batches: readonly ReachDeckWorkspaceBatch[],
): void {
  for (const batch of [...batches].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.batchId.localeCompare(b.batchId),
  )) {
    for (const member of batch.members) {
      if (!member.regeneration || !member.terminalOutcome || member.terminalOutcome === 'cancelled')
        continue;
      const lanes = failures.get(member.pageId) ?? new Set<string>();
      for (const [lane, selected] of Object.entries(member.regeneration.plan.channels)) {
        if (!selected) continue;
        const layoutSucceeded =
          lane === 'layout' && member.regeneration.completedLayout !== undefined;
        const narrationSucceeded =
          lane === 'narration' && member.reason === 'audio-generation-failed';
        if (member.terminalOutcome === 'completed' || layoutSucceeded || narrationSucceeded)
          lanes.delete(lane);
        else lanes.add(lane);
      }
      failures.set(member.pageId, lanes);
    }
  }
}

export async function startReachDeckRegeneration(input: {
  scoped: AuthorizedWorkspaceRouteContext;
  writerContext: ReachDeckWorkspaceContext;
  expectedDraftRevision: number;
  channels: ReachDeckRegenerationChannels;
  scope: 'failed' | 'all';
  audioAnimationMode: 'preserve' | 'clear';
  idempotencyKey: string;
  pageId?: string;
  imageScope?: 'failed' | 'all';
  assetIds?: readonly string[];
  /** 调用方据此加入异步写租约的 run；工作区已换 run 时拒绝，避免批次落在未持有租约的 run 上。 */
  expectedRunId?: string;
}) {
  const current = await loadReachDeckWorkspace(input.writerContext);
  const runId = current.workspace.runId;
  if (input.expectedRunId !== undefined && runId !== input.expectedRunId)
    throw new ReachDeckWorkspaceRevisionConflictError();
  const legacyImageSemantics =
    input.channels.image === input.channels.layout &&
    (input.imageScope === undefined || input.imageScope === 'all') &&
    input.assetIds === undefined;
  const { image: _image, ...legacyChannels } = input.channels;
  const requestHash = buildStagedGenerationRequestHash({
    kind: 'regeneration',
    runId,
    owner: input.scoped.jobScope,
    // 旧等价意图须还原四通道对象并省略新增键，才能命中部署前已接受的批次哈希。
    channels: legacyImageSemantics ? legacyChannels : input.channels,
    scope: input.scope,
    audioAnimationMode: input.audioAnimationMode,
    pageId: input.pageId ?? null,
    ...(legacyImageSemantics
      ? {}
      : {
          imageScope: input.imageScope ?? null,
          assetIds: input.assetIds ? [...input.assetIds].sort() : null,
        }),
    idempotencyKey: input.idempotencyKey,
  });
  const replay = await resumeReachDeckWorkspaceBatch(
    input.writerContext,
    input.scoped.jobScope,
    runId,
    'regeneration',
    requestHash,
  );
  if (replay.status === 'found') return result(replay.batch);
  if (replay.status === 'expired')
    throw conflict('This regeneration request was already accepted and its summary expired');
  if (current.draftRevision !== input.expectedDraftRevision)
    throw new ReachDeckWorkspaceRevisionConflictError();
  if (current.workspace.paused)
    throw conflict('Regeneration is unavailable while the workspace is paused');
  const materialized = await loadReachDeckMaterializedWorkspaceDocument(input.writerContext);
  if (!materialized.materialized) throw conflict('Regeneration requires a materialized document');
  const recovery = await loadReachDeckWorkspaceRecovery(input.writerContext);
  const jobs = await listReachDeckWorkspaceRecoveryJobs(
    input.writerContext,
    input.scoped.jobScope,
    runId,
    {
      nativeNarration: true,
      workspace: current.workspace,
      materializedDocument: materialized.document,
    },
  );
  const activePageIds = new Set<string>();
  const activeImagePageIds = activeReachDeckImagePageIds(
    runId,
    Object.values(recovery.recovery.batches),
    jobs,
  );
  for (const batch of Object.values(recovery.recovery.batches))
    if (batch.runId === runId && batch.phase !== 'terminal' && batch.phase !== 'stopped')
      for (const member of batch.members)
        if (!member.terminalOutcome) {
          activePageIds.add(member.pageId);
        }
  const failedLanesByPage = new Map<string, Set<string>>();
  for (const job of jobs) {
    if (!job.pageId) continue;
    if (!job.done && !['failed', 'cancelled', 'completed'].includes(job.status)) {
      activePageIds.add(job.pageId);
    }
    if (job.status === 'failed') {
      const lanes = failedLanesByPage.get(job.pageId) ?? new Set<string>();
      for (const lane of job.affectedLanes ??
        (job.kind === 'page-generation' ? ['layout'] : ['narration', 'audio', 'animation']))
        lanes.add(lane);
      failedLanesByPage.set(job.pageId, lanes);
    }
  }
  applyReachDeckRegenerationBatchFailures(
    failedLanesByPage,
    Object.values(recovery.recovery.batches).filter(
      (batch) =>
        batch.runId === runId && sameReachDeckWorkspaceBatchOwner(batch, input.scoped.jobScope),
    ),
  );
  const selected = selectReachDeckRegenerationPages({
    document: materialized.document,
    workspace: current.workspace,
    channels: input.channels,
    scope: input.scope,
    activePageIds,
    failedLanesByPage,
    imageScope: input.imageScope,
    assetIds: input.assetIds,
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
  });
  if (
    input.pageId &&
    input.channels.image &&
    !input.channels.layout &&
    selected.skipped.some((item) => item.reason === 'in-flight')
  )
    throw activeImagePageIds.has(input.pageId)
      ? conflict('Images for this page are already generating', 'image_generation_in_progress')
      : conflict('This page is already generating');
  if (!selected.accepted.length)
    return { batch: undefined, acceptedPageIds: [], skipped: selected.skipped };
  const voiceSelection = await resolveReachDeckVoiceSelection(input.scoped.jobScope);
  const candidate: ReachDeckWorkspaceBatch = {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId: buildReachDeckWorkspaceBatchId(requestHash),
    requestHash,
    runId,
    owner: input.scoped.jobScope,
    kind: 'regeneration',
    sourceKind: 'regeneration',
    createdAt: new Date().toISOString(),
    revision: 0,
    phase: 'ready',
    dispatchCursor: 0,
    voiceSelection,
    members: selected.accepted.map(({ pageId, planChannels }, order) => {
      const page = materialized.document.pages.find((p) => p.pageId === pageId)!;
      const plan: ReachDeckRegenerationPlan = {
        channels: planChannels,
        audioAnimationMode: input.audioAnimationMode,
        ...(planChannels.image ? { imageScope: input.imageScope ?? 'all' } : {}),
        ...(input.assetIds === undefined ? {} : { assetIds: [...input.assetIds].sort() }),
      };
      return {
        pageId,
        order,
        sourceKind:
          page.sceneType === 'interactive' ? 'materialized-interactive' : 'materialized-native',
        requestKey: buildStagedGenerationRequestHash({ requestHash, pageId }),
        requestedRevision: page.revision,
        attempt: 1,
        intent: 'waiting-dispatch',
        regeneration: {
          plan,
          stage: planChannels.layout ? 'layout' : planChannels.image ? 'image' : 'narration',
        },
      };
    }),
    skipped: selected.skipped.map((item, order) => ({ ...item, order })),
  };
  return result(
    await registerReachDeckWorkspaceBatch({
      context: input.writerContext,
      scope: input.scoped.jobScope,
      batch: candidate,
    }),
  );
}
function result(batch: ReachDeckWorkspaceBatch) {
  return {
    batch: publicReachDeckMediaBatch(batch),
    acceptedPageIds: batch.members.map((m) => m.pageId),
    skipped: batch.skipped.map(({ pageId, reason }) => ({ pageId, reason })),
  };
}
