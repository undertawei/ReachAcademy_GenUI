import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { buildIdempotentPageRequestKey, buildStagedGenerationRequestHash } from './job-identity.js';
import { resolveReachDeckVoiceSelection } from './content-service-client.js';
import { loadReachDeckMaterializedWorkspaceDocument } from './workspace-jobs.js';
import { loadReachDeckWorkspace } from './workspace-store.js';
import {
  loadReachDeckWorkspaceRecovery,
  type ReachDeckWorkspaceReadSnapshot,
  transitionReachDeckImportGenerationIntents,
} from './workspace-recovery.js';
import {
  registerReachDeckNarrationBatch,
  resumeReachDeckNarrationBatch,
} from './workspace-batch-coordinator.js';
import {
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  buildReachDeckWorkspaceBatchId,
  sameReachDeckWorkspaceBatchOwner,
  type ReachDeckWorkspaceBatch,
} from './workspace-batches.js';
import {
  retainReachDeckImportGenerationIntents,
  type ReachDeckImportGenerationIntent,
} from './import-generation-contracts.js';
import { withReachDeckOrdinaryWriterLease } from './decksmith/page-routes.js';
import type {
  ReachDeckDocumentWriterContext,
  ReachDeckDocumentWriterSession,
} from './decksmith/document-writer.js';
import {
  conflict,
  ReachDeckWorkspaceRouteError,
  type AuthorizedWorkspaceRouteContext,
} from './workspace-route.js';

export type ReachDeckImportCompletionAction = 'generate-narration';
export interface ReachDeckImportGenerationResult {
  status: 'started' | 'pending' | 'skipped';
  batchId?: string;
  skipped: { pageId: string; reason: string }[];
}

class ImportGenerationReceiptUnavailableError extends ReachDeckWorkspaceRouteError {
  constructor() {
    super('Import generation receipt is unavailable', 409);
  }
}

export async function prepareReachDeckImportGeneration(
  context: ReachDeckDocumentWriterContext,
  scoped: AuthorizedWorkspaceRouteContext,
  document: ReachDeckDocumentV2,
  applicationId: string,
  completionAction?: ReachDeckImportCompletionAction,
): Promise<void> {
  const application = document.importApplications?.find(
    (item) => item.applicationId === applicationId,
  );
  if (application === undefined)
    throw new Error('Import generation requires an import application');
  const existing = (await loadReachDeckWorkspaceRecovery(context)).recovery
    .importGenerationIntents?.[applicationId];
  if (existing !== undefined) {
    if (
      !completionAction ||
      existing.requestFingerprint !== application.requestFingerprint ||
      !sameReachDeckWorkspaceBatchOwner({ owner: existing.owner }, scoped.jobScope)
    )
      throw conflict('Import generation conflicts with its durable request');
    return;
  }
  if (completionAction === undefined) return;
  const resource = await loadReachDeckWorkspace(context);
  const runId = resource.workspace.runId;
  const owner = scoped.jobScope;
  const voiceSelection = await resolveReachDeckVoiceSelection(owner);
  const pageIds = [...application.insertedPageIds];
  const pageSet = new Set(pageIds);
  const pages = [...document.pages]
    .filter((page) => pageSet.has(page.pageId))
    .sort((a, b) => a.order - b.order);
  const skipped: ReachDeckWorkspaceBatch['skipped'] = [];
  const members: ReachDeckWorkspaceBatch['members'] = [];
  for (const [order, page] of pages.entries()) {
    const binding = document.nativeSlides.find((binding) => binding.pageId === page.pageId);
    if (page.sceneType !== 'slide' || binding === undefined) {
      skipped.push({
        pageId: page.pageId,
        order,
        reason:
          page.sceneType === 'interactive'
            ? 'interactive-not-supported'
            : page.sceneType === 'quiz'
              ? 'quiz-not-supported'
              : 'no-native-slide',
      });
      continue;
    }
    const saved = Boolean(binding.slide.narration?.markdown?.trim());
    members.push({
      pageId: page.pageId,
      order: members.length,
      sourceKind: 'materialized-native',
      requestKey: buildIdempotentPageRequestKey({
        idempotencyKey: applicationId,
        actorId: scoped.actorId,
        billingGroupId: scoped.billingGroupId,
        resourceScope: scoped.resourceScope,
        runId,
        pageId: page.pageId,
        voiceSelection,
        action: 'narration-regenerate',
      }),
      requestedRevision: page.revision,
      attempt: 1,
      intent: members.length === 0 ? 'waiting-dispatch' : 'waiting-predecessor',
      narrationMode: saved ? 'saved-content' : 'regenerate-text',
      animationMode: 'regenerate',
    });
  }
  const requestHash = buildStagedGenerationRequestHash({
    action: 'import-generate-narration/v1',
    applicationId,
    requestFingerprint: application.requestFingerprint,
    runId,
    owner,
    voiceSelection,
    members,
    skipped,
  });
  const batch =
    members.length === 0
      ? undefined
      : {
          schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
          batchId: buildReachDeckWorkspaceBatchId(requestHash),
          requestHash,
          runId,
          owner,
          kind: 'narration' as const,
          sourceKind: 'materialized-native' as const,
          createdAt: new Date().toISOString(),
          revision: 0,
          phase: 'ready' as const,
          dispatchCursor: 0,
          voiceSelection,
          members,
          skipped,
        };
  const intent: ReachDeckImportGenerationIntent = {
    schemaVersion: 'reach-deck-import-generation-intent/v1',
    applicationId,
    requestFingerprint: application.requestFingerprint,
    runId,
    owner,
    voiceSelection,
    pageIds,
    skipped,
    registered: false,
    ...(batch === undefined ? {} : { batch }),
  };
  await transitionReachDeckImportGenerationIntents(context, (intents) => {
    const prior = intents[applicationId];
    if (prior !== undefined) {
      if (
        prior.requestFingerprint !== intent.requestFingerprint ||
        !sameReachDeckWorkspaceBatchOwner({ owner: prior.owner }, owner)
      )
        throw conflict('Import generation intent changed');
      return intents;
    }
    return retainReachDeckImportGenerationIntents({ ...intents, [applicationId]: intent }, runId);
  });
}

export async function reconcileReachDeckImportGeneration(
  context: ReachDeckDocumentWriterContext,
  session: ReachDeckDocumentWriterSession,
  scoped: AuthorizedWorkspaceRouteContext,
  applicationId: string,
  acceptedRequest?: {
    completionAction: ReachDeckImportCompletionAction;
    requestFingerprint: string;
  },
): Promise<ReachDeckImportGenerationResult | undefined> {
  const intent = (await loadReachDeckWorkspaceRecovery(context)).recovery.importGenerationIntents?.[
    applicationId
  ];
  if (intent === undefined) {
    if (acceptedRequest?.completionAction !== 'generate-narration') return undefined;
    const materialized = await loadReachDeckMaterializedWorkspaceDocument(context);
    if (
      !materialized.materialized ||
      materialized.document.schemaVersion !== 'reach-deck-document/v2'
    )
      return undefined;
    const application = materialized.document.importApplications?.find(
      (item) => item.applicationId === applicationId,
    );
    if (
      application === undefined ||
      application.requestFingerprint !== acceptedRequest.requestFingerprint
    )
      throw conflict('Import generation application changed');
    const skipped = application.insertedPageIds.flatMap((pageId) => {
      const page = materialized.document.pages.find((item) => item.pageId === pageId);
      const bound = materialized.document.nativeSlides.some((item) => item.pageId === pageId);
      return page?.sceneType === 'slide' && bound
        ? []
        : [
            {
              pageId,
              reason:
                page?.sceneType === 'interactive'
                  ? 'interactive-not-supported'
                  : page?.sceneType === 'quiz'
                    ? 'quiz-not-supported'
                    : 'no-native-slide',
            },
          ];
    });
    // Applied imports do not retain the frozen voice or batch identity. A missing intent may
    // already have been pruned after paid work, so it cannot safely authorize another batch.
    if (skipped.length !== application.insertedPageIds.length)
      throw new ImportGenerationReceiptUnavailableError();
    return { status: 'skipped', skipped };
  }
  if (!sameReachDeckWorkspaceBatchOwner({ owner: intent.owner }, scoped.jobScope))
    throw conflict('Import generation owner does not match');
  const result = (
    status: ReachDeckImportGenerationResult['status'],
  ): ReachDeckImportGenerationResult => ({
    status,
    ...(intent.batch === undefined ? {} : { batchId: intent.batch.batchId }),
    skipped: intent.skipped.map(({ pageId, reason }) => ({ pageId, reason })),
  });
  const resource = await loadReachDeckWorkspace(context);
  if (resource.workspace.runId !== intent.runId) return result('pending');
  const materialized = await loadReachDeckMaterializedWorkspaceDocument(context);
  if (
    !materialized.materialized ||
    materialized.document.schemaVersion !== 'reach-deck-document/v2'
  )
    return result('pending');
  const application = materialized.document.importApplications?.find(
    (item) => item.applicationId === applicationId,
  );
  if (application === undefined) return result('pending');
  if (
    application.requestFingerprint !== intent.requestFingerprint ||
    JSON.stringify(application.insertedPageIds) !== JSON.stringify(intent.pageIds)
  )
    throw conflict('Import generation application changed');
  try {
    let registeredBatch = intent.batch;
    if (intent.batch !== undefined) {
      const resumed = await resumeReachDeckNarrationBatch(
        context,
        intent.owner,
        intent.runId,
        intent.batch.requestHash,
      );
      if (resumed.status === 'missing') {
        if (intent.registered) throw new ImportGenerationReceiptUnavailableError();
        registeredBatch = await registerReachDeckNarrationBatch({
          context,
          scope: intent.owner,
          // Registration grace starts at queue acceptance, not at import preparation.
          batch: { ...intent.batch, createdAt: new Date().toISOString() },
        });
      }
      if (
        resumed.status !== 'expired' &&
        (resumed.status !== 'found' ||
          (resumed.batch.phase !== 'terminal' && resumed.batch.phase !== 'stopped'))
      )
        await session.retainForAsyncRun(intent.runId);
    }
    if (!intent.registered)
      await transitionReachDeckImportGenerationIntents(context, (intents) =>
        retainReachDeckImportGenerationIntents(
          {
            ...intents,
            [applicationId]: {
              ...intents[applicationId]!,
              registered: true,
              ...(registeredBatch === undefined ? {} : { batch: registeredBatch }),
            },
          },
          intent.runId,
        ),
      );
    return result(intent.batch === undefined ? 'skipped' : 'started');
  } catch (error) {
    if (error instanceof ImportGenerationReceiptUnavailableError) throw error;
    console.warn('Reach Deck imported narration scheduling remains pending', {
      applicationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return result('pending');
  }
}

export async function recoverReachDeckImportGeneration(
  scoped: AuthorizedWorkspaceRouteContext,
  snapshot?: ReachDeckWorkspaceReadSnapshot,
): Promise<boolean> {
  const resource = snapshot?.resource ?? (await loadReachDeckWorkspace(scoped.workspaceContext));
  const intents =
    (snapshot?.recovery ?? (await loadReachDeckWorkspaceRecovery(scoped.workspaceContext))).recovery
      .importGenerationIntents ?? {};
  const candidates = Object.values(intents).filter(
    (intent) =>
      !intent.registered &&
      intent.runId === resource.workspace.runId &&
      sameReachDeckWorkspaceBatchOwner({ owner: intent.owner }, scoped.jobScope),
  );
  if (candidates.length === 0) return false;
  const materialized = await loadReachDeckMaterializedWorkspaceDocument(scoped.workspaceContext);
  if (
    !materialized.materialized ||
    materialized.document.schemaVersion !== 'reach-deck-document/v2'
  )
    return false;
  let writerAttempted = false;
  for (const intent of candidates) {
    const application = materialized.document.importApplications?.find(
      (item) => item.applicationId === intent.applicationId,
    );
    if (
      application === undefined ||
      application.requestFingerprint !== intent.requestFingerprint ||
      JSON.stringify(application.insertedPageIds) !== JSON.stringify(intent.pageIds)
    )
      continue;
    try {
      // Even a failed write can have persisted changes: callers must discard their read snapshot.
      writerAttempted = true;
      await withReachDeckOrdinaryWriterLease({
        scoped,
        operationKind: 'import-generation-recovery',
        asyncRunId: intent.runId,
        operation: (context, session) =>
          reconcileReachDeckImportGeneration(context, session, scoped, intent.applicationId),
      });
    } catch (error) {
      console.warn('Reach Deck imported narration recovery deferred', {
        applicationId: intent.applicationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return writerAttempted;
}
