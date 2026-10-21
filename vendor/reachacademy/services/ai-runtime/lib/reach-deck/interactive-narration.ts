import {
  buildReachDeckMediaResourceForObjectKey,
  collectReachDeckMediaObjectKeys,
  parseReachDeckDocumentV2,
  parseInteractiveSceneValue,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';

import type {
  ReachDeckInteractiveNarrationGenerationJobResult,
  ReachDeckNarrationGenerationJobPayload,
} from './contracts.js';
import { actorOrganizationIdFromPayload } from './contracts.js';
import { rematerializeReachDeckModule } from './content-service-client.js';
import {
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
} from './job-identity.js';
import {
  isContentServiceConflict,
  loadReachDeckMaterializedWorkspaceDocument,
  locateReachDeckInteractiveNarrationTarget,
  type ReachDeckWorkspaceJobScope,
} from './workspace-jobs.js';
import { loadReachDeckWorkspace, type ReachDeckWorkspaceContext } from './workspace-store.js';
import {
  markReachDeckWorkspaceBatchMemberResultDiscarded,
  markReachDeckWorkspaceJobApplied,
} from './workspace-recovery.js';
import {
  settleReachDeckAsyncWriterLeaseAfter,
  withReachDeckRetainedAsyncWriterLease,
} from './decksmith/document-writer.js';
import { assertReachDeckWorkspaceBatchJobNotCancelled } from './workspace-batch-cancellation.js';

export type ReachDeckMaterializedInteractiveNarrationLandingOutcome =
  | { status: 'applied' }
  | {
      status: 'discarded';
      code:
        | 'NARRATION_TARGET_MISSING'
        | 'NARRATION_CONTENT_SUPERSEDED'
        | 'NARRATION_RESULT_SUPERSEDED';
    };

const MAX_CAS_ATTEMPTS = 16;

/** Exact read-only proof used when cancellation races the final appliedAt checkpoint. */
export async function hasExactReachDeckMaterializedInteractiveNarrationResult(
  context: ReachDeckWorkspaceContext,
  result: ReachDeckInteractiveNarrationGenerationJobResult,
): Promise<boolean> {
  const existing = await loadReachDeckMaterializedWorkspaceDocument(context);
  const artifact = result.interactiveNarration.artifact;
  if (artifact.sceneType !== 'interactive') return false;
  const located = locateReachDeckInteractiveNarrationTarget(existing, artifact.pageId);
  if (located === undefined) return false;
  const audioObjectKey = result.interactiveNarration.audioObjectKey;
  const audioResource =
    audioObjectKey === undefined
      ? undefined
      : buildReachDeckMediaResourceForObjectKey(audioObjectKey);
  return (
    JSON.stringify(located.page.scene) === JSON.stringify(artifact.scene) &&
    (audioResource === undefined ||
      located.document.resources.media.some(
        (candidate) =>
          candidate.id === audioResource.id && candidate.objectKey === audioResource.objectKey,
      ))
  );
}

export async function landReachDeckMaterializedInteractiveNarration(
  context: ReachDeckWorkspaceContext,
  result: ReachDeckInteractiveNarrationGenerationJobResult,
  supersededAudioResourceId?: string,
): Promise<ReachDeckMaterializedInteractiveNarrationLandingOutcome> {
  const product = result.interactiveNarration;
  const artifact = product.artifact;
  if (artifact.sceneType !== 'interactive') {
    throw new Error('Interactive narration result requires an Interactive artifact');
  }
  // 仅重写文字的结果不带音频：新正文落地时去掉旧音频引用（stripInteractiveNarrationAudio 语义）。
  const audioResource =
    product.textOnly === true
      ? undefined
      : buildReachDeckMediaResourceForObjectKey(product.audioObjectKey);
  if (artifact.scene.narration?.audioResourceId !== audioResource?.id) {
    throw new Error('Interactive narration media identity is invalid');
  }
  for (let round = 0; ; round += 1) {
    const [resource, existing] = await Promise.all([
      loadReachDeckWorkspace(context),
      loadReachDeckMaterializedWorkspaceDocument(context),
    ]);
    const located = locateReachDeckInteractiveNarrationTarget(existing, artifact.pageId);
    if (located === undefined) {
      return { status: 'discarded', code: 'NARRATION_TARGET_MISSING' };
    }
    const { document, page } = located;
    const currentScene = page.scene;
    const currentNarration = currentScene.narration;
    if (
      !existing.materialized ||
      (currentNarration === undefined &&
        product.sourceNarrationTextDigest !== buildReachDeckInteractiveNarrationTextDigest(''))
    ) {
      return { status: 'discarded', code: 'NARRATION_TARGET_MISSING' };
    }
    const alreadyApplied =
      JSON.stringify(currentScene) === JSON.stringify(artifact.scene) &&
      (audioResource === undefined ||
        document.resources.media.some(
          (entry) => entry.id === audioResource.id && entry.objectKey === audioResource.objectKey,
        ));
    if (alreadyApplied) return { status: 'applied' };
    if (page.revision !== artifact.requestedRevision) {
      return { status: 'discarded', code: 'NARRATION_RESULT_SUPERSEDED' };
    }
    const { narration: _resultNarration, ...resultLayout } = artifact.scene;
    const sourceScene = {
      ...resultLayout,
      ...(currentNarration === undefined ? {} : { narration: currentNarration }),
    };
    if (
      buildReachDeckInteractiveContentDigest(currentScene) !==
        (product.sourceInteractiveContentDigest ?? product.interactiveContentDigest) ||
      buildReachDeckInteractiveContentDigest(sourceScene) !==
        buildReachDeckInteractiveContentDigest(currentScene) ||
      buildReachDeckInteractiveNarrationTextDigest(
        currentNarration?.text ?? '',
        currentNarration?.speechMarkup,
      ) !== (product.sourceNarrationTextDigest ?? product.narrationTextDigest)
    ) {
      return { status: 'discarded', code: 'NARRATION_CONTENT_SUPERSEDED' };
    }
    const nextScene = parseInteractiveSceneValue(artifact.scene, page.pageId);
    const nextPages = document.pages.map((candidate) =>
      candidate.pageId === page.pageId
        ? { ...page, revision: page.revision + 1, scene: nextScene }
        : candidate,
    );
    // 仅重写文字替换的是当前页正在引用的音频；完整流水线沿用请求携带的被替换音频。
    const previousAudioResourceId =
      product.textOnly === true ? currentNarration?.audioResourceId : supersededAudioResourceId;
    const previousAudioResource =
      previousAudioResourceId === undefined
        ? undefined
        : document.resources.media.find((entry) => entry.id === previousAudioResourceId);
    const referencedObjectKeys = new Set(
      collectReachDeckMediaObjectKeys({ ...document, pages: nextPages }),
    );
    const retainedMedia =
      previousAudioResource !== undefined &&
      !referencedObjectKeys.has(previousAudioResource.objectKey)
        ? document.resources.media.filter((entry) => entry.id !== previousAudioResource.id)
        : document.resources.media;
    const nextMedia =
      audioResource === undefined || retainedMedia.some((entry) => entry.id === audioResource.id)
        ? retainedMedia
        : [...retainedMedia, audioResource];
    const nextDocument: ReachDeckDocumentV2 = parseReachDeckDocumentV2({
      ...document,
      pages: nextPages,
      resources:
        nextMedia === document.resources.media
          ? document.resources
          : { ...document.resources, media: nextMedia },
    });
    if (existing.materialization.contentDigest.trim().length === 0) {
      throw new Error('Reach Deck materialized document is missing its content digest');
    }
    try {
      await rematerializeReachDeckModule(
        nextDocument,
        resource.draftRevision,
        existing.materialization.contentDigest,
        context,
      );
      return { status: 'applied' };
    } catch (error) {
      if (!isContentServiceConflict(error) || round + 1 >= MAX_CAS_ATTEMPTS) throw error;
    }
  }
}

export async function finalizeReachDeckMaterializedInteractiveNarrationGeneration(
  payload: ReachDeckNarrationGenerationJobPayload,
  result: ReachDeckInteractiveNarrationGenerationJobResult,
  inherited: Pick<ReachDeckWorkspaceContext, 'documentWriterSession'> = {},
): Promise<void> {
  const scope: ReachDeckWorkspaceJobScope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
  const context: ReachDeckWorkspaceContext = { ...scope, ...inherited };
  const pageId = result.interactiveNarration.artifact.pageId;
  await settleReachDeckAsyncWriterLeaseAfter(context, payload.runId, () =>
    withReachDeckRetainedAsyncWriterLease({
      context,
      operationKind: 'interactive-narration-finalize',
      asyncRunId: payload.runId,
      operation: async (writerContext) => {
        await assertReachDeckWorkspaceBatchJobNotCancelled(payload);
        const outcome = await landReachDeckMaterializedInteractiveNarration(
          writerContext,
          result,
          payload.request.sourceKind === 'materialized-interactive'
            ? payload.request.supersededAudioResourceId
            : undefined,
        );
        if (outcome.status === 'discarded') {
          console.warn('Reach Deck Interactive 讲稿音频已被更新内容替代，丢弃迟到结果', {
            jobId: payload.jobId,
            pageId,
            code: outcome.code,
          });
          await markReachDeckWorkspaceBatchMemberResultDiscarded(
            payload,
            outcome.code,
            new Date().toISOString(),
          );
          return;
        }
        await markReachDeckWorkspaceJobApplied(payload.jobId, scope, new Date().toISOString());
      },
    }),
  );
}
