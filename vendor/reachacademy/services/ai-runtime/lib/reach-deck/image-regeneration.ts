import {
  collectReachDeckMediaObjectKeys,
  collectReachDeckNativeSlideResourceIds,
  isNativeSlideArtifact,
  parseReachDeckDocumentV2,
  type ReachDeckDocumentV2,
  type ReachDeckNativeElementV2,
  type ReachDeckPageMediaSnapshot,
  type ReachDeckPageMediaSlot,
} from '@reachany/reach-deck-dsl';
import {
  scientificMediaContentDigest,
  scientificMediaElementProperties,
} from './scientific-media-slot.js';
import type {
  ReachDeckPageGenerationJobPayload,
  ReachDeckPageGenerationJobResult,
} from './contracts.js';
import { rematerializeReachDeckModule } from './content-service-client.js';
import {
  isContentServiceConflict,
  loadReachDeckMaterializedWorkspaceDocument,
} from './workspace-jobs.js';
import {
  loadReachDeckWorkspace,
  transitionReachDeckWorkspace,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import {
  transitionReachDeckWorkspaceBatches,
  shouldDeferReachDeckImageForNarration,
  type ReachDeckWorkspaceRecoveryResource,
} from './workspace-recovery.js';
import { assertReachDeckWorkspaceBatchJobNotCancelled } from './workspace-batch-cancellation.js';
import { ReachDeckGenerationCancelledError, type ReachDeckGenerationQueue } from './queue.js';
import { withReachDeckImageSkippedSlots } from './image-landing-reason.js';

function locateElement(
  elements: ReachDeckNativeElementV2[],
  id: string,
): { elements: ReachDeckNativeElementV2[]; index: number } | undefined {
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index]!;
    if (element.id === id) return { elements, index };
    if (element.type === 'group') {
      const nested = locateElement(element.children, id);
      if (nested) return nested;
    }
  }
}

function boundResource(
  element: ReachDeckNativeElementV2 | undefined,
  slot: ReachDeckPageMediaSlot,
): string | undefined {
  if (slot.binding === 'image-element' && element?.type === 'image') return element.resourceId;
  if (
    slot.binding === 'shape-fill' &&
    element?.type === 'shape' &&
    element.style.fill?.kind === 'image'
  )
    return element.style.fill.resourceId;
  return undefined;
}

function matchesSlot(
  element: ReachDeckNativeElementV2 | undefined,
  slot: ReachDeckPageMediaSlot,
): boolean {
  return slot.binding === 'scientific-visual'
    ? element?.type === 'scientificVisual' &&
        scientificMediaContentDigest(element) === slot.contentDigest
    : boundResource(element, slot) === slot.resourceId;
}

/** 将各图位替换合入教师当前页面，保留其余字段。 */
export function applyReachDeckImageSlotResults(
  document: ReachDeckDocumentV2,
  pageId: string,
  snapshot: ReachDeckPageMediaSnapshot,
  result: ReachDeckPageGenerationJobResult['artifact'],
  selectedAssetIds?: ReadonlySet<string>,
  metadataOnly = false,
): {
  document: ReachDeckDocumentV2;
  slots: ReachDeckPageMediaSlot[];
  removedAssetIds: string[];
  skipped: number;
} {
  if (!isNativeSlideArtifact(result)) throw new Error('Image results require a native slide');
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  const nextSlide = binding ? structuredClone(binding.slide) : undefined;
  const accepted: ReachDeckPageMediaSlot[] = [];
  const removedAssetIds: string[] = [];
  let skipped = 0;
  let changed = false;
  const replacedIds = new Set<string>();
  const extraResourceIds = new Set<string>();
  for (const prior of snapshot.mediaSlots) {
    if (result.generationMetadata.mediaSlots?.some((slot) => slot.assetId === prior.assetId))
      continue;
    const generatedLocation = locateElement(result.nativeSlide.elements, prior.elementId);
    const generated = generatedLocation?.elements[generatedLocation.index];
    if (generated?.type !== 'scientificVisual') continue;
    const location = nextSlide && locateElement(nextSlide.elements, prior.elementId);
    const current = location?.elements[location.index];
    const replay =
      current?.type === 'scientificVisual' &&
      current.documentHtml === generated.documentHtml &&
      JSON.stringify(current.manifest) === JSON.stringify(generated.manifest);
    if (metadataOnly && !replay) continue;
    if (!current || (!replay && boundResource(current, prior) !== prior.resourceId)) {
      skipped++;
      continue;
    }
    removedAssetIds.push(prior.assetId);
    if (replay) continue;
    changed = true;
    if (prior.resourceId) replacedIds.add(prior.resourceId);
    for (const id of generated.manifest.resourceIds) extraResourceIds.add(id);
    location!.elements[location!.index] = {
      ...generated,
      ...scientificMediaElementProperties(current),
    };
  }
  for (const slot of result.generationMetadata.mediaSlots ?? []) {
    const prior = snapshot.mediaSlots.find((candidate) => candidate.assetId === slot.assetId);
    if (!prior) continue;
    if (slot.attempt <= prior.attempt) {
      if (selectedAssetIds?.has(prior.assetId)) {
        const location = locateElement(snapshot.nativeSlide.elements, prior.elementId);
        if (prior.teacherReplaced || !matchesSlot(location?.elements[location.index], prior))
          skipped++;
      }
      continue;
    }
    const location = nextSlide && locateElement(nextSlide.elements, prior.elementId);
    const element = location?.elements[location.index];
    const currentResource = boundResource(element, prior);
    if (metadataOnly && !matchesSlot(element, slot)) continue;
    // 新图身份同时证明文档已写入但元数据尚未提交的可重放状态。
    if (!element || (!matchesSlot(element, prior) && !matchesSlot(element, slot))) {
      skipped++;
      continue;
    }
    if (slot.binding === 'scientific-visual') {
      const generatedLocation = locateElement(result.nativeSlide.elements, slot.elementId);
      const generated = generatedLocation?.elements[generatedLocation.index];
      if (generated?.type !== 'scientificVisual' || !matchesSlot(generated, slot))
        throw new Error('Scientific result does not match its media slot');
      accepted.push(slot);
      if (matchesSlot(element, slot)) continue;
      changed = true;
      if (prior.resourceId) replacedIds.add(prior.resourceId);
      for (const id of generated.manifest.resourceIds) extraResourceIds.add(id);
      location!.elements[location!.index] = {
        ...generated,
        ...scientificMediaElementProperties(element),
      };
      continue;
    }
    if (!result.resources.media.some((resource) => resource.id === slot.resourceId))
      throw new Error('Image result references a missing media resource');
    accepted.push(slot);
    if (currentResource === slot.resourceId) continue;
    changed = true;
    if (prior.resourceId) replacedIds.add(prior.resourceId);
    if (element.type === 'image') {
      element.resourceId = slot.resourceId;
    } else if (element.type === 'shape' && element.style.fill?.kind === 'image') {
      element.style.fill.resourceId = slot.resourceId;
    }
  }
  if (!changed || !nextSlide) return { document, slots: accepted, removedAssetIds, skipped };
  const resources = new Map(document.resources.media.map((resource) => [resource.id, resource]));
  for (const slot of accepted) {
    if (slot.binding === 'scientific-visual') continue;
    const resource = result.resources.media.find((candidate) => candidate.id === slot.resourceId)!;
    resources.set(resource.id, resource);
  }
  for (const resource of result.resources.media)
    if (extraResourceIds.has(resource.id)) resources.set(resource.id, resource);
  const nextDocument = {
    ...document,
    pages: document.pages.map((page) =>
      page.pageId === pageId ? { ...page, revision: page.revision + 1 } : page,
    ),
    nativeSlides: document.nativeSlides.map((candidate) =>
      candidate.pageId === pageId ? { ...candidate, slide: nextSlide } : candidate,
    ),
    resources: { ...document.resources, media: [...resources.values()] },
  };
  const referenced = new Set(collectReachDeckMediaObjectKeys(nextDocument));
  nextDocument.resources.media = nextDocument.resources.media.filter(
    (resource) => !replacedIds.has(resource.id) || referenced.has(resource.objectKey),
  );
  return {
    document: parseReachDeckDocumentV2(nextDocument),
    slots: accepted,
    removedAssetIds,
    skipped,
  };
}

function sameSlotPlan(
  current: ReachDeckPageMediaSlot,
  prior: ReachDeckPageMediaSlot,
  replacement?: ReachDeckPageMediaSlot,
): boolean {
  const identityMatches = (candidate: ReachDeckPageMediaSlot) =>
    current.binding === candidate.binding &&
    (current.binding === 'scientific-visual'
      ? current.contentDigest === candidate.contentDigest
      : current.resourceId === candidate.resourceId);
  return (
    current.assetId === prior.assetId &&
    current.elementId === prior.elementId &&
    current.planDigest === prior.planDigest &&
    ((current.attempt === prior.attempt && identityMatches(prior)) ||
      (replacement !== undefined &&
        current.attempt === replacement.attempt &&
        identityMatches(replacement)))
  );
}

/** 当前桥接分别提交文档与工作区，写入租约须覆盖两步条件更新；元数据修复前，耐久任务继续保持未落地状态。 */
export async function landReachDeckImageResults(
  context: ReachDeckWorkspaceContext,
  payload: ReachDeckPageGenerationJobPayload,
  result: ReachDeckPageGenerationJobResult,
  options: {
    metadataOnly?: boolean;
    checkOnly?: boolean;
    loadedRecovery?: ReachDeckWorkspaceRecoveryResource;
    queue?: ReachDeckGenerationQueue;
  } = {},
): Promise<'deferred' | void> {
  if (!isNativeSlideArtifact(result.artifact))
    throw new Error('Image result requires a native slide');
  const resultArtifact = result.artifact;
  const snapshot = payload.request.previousMedia;
  if (!snapshot) throw new Error('Image regeneration requires previous media');
  const plan = payload.request.regenerationPlan!;
  const selectedAssetIds = new Set(
    snapshot.mediaSlots
      .filter(
        (slot) =>
          (plan.imageScope === 'all' || slot.status === 'failed') &&
          (!plan.assetIds || plan.assetIds.includes(slot.assetId)),
      )
      .map((slot) => slot.assetId),
  );
  for (let round = 0; ; round++) {
    const [workspace, materialized] = await Promise.all([
      loadReachDeckWorkspace(context),
      loadReachDeckMaterializedWorkspaceDocument(context),
    ]);
    if (workspace.workspace.runId !== payload.runId) {
      if (options.metadataOnly) throw new ReachDeckGenerationCancelledError();
      return;
    }
    if (
      !materialized.materialized ||
      materialized.document.schemaVersion !== 'reach-deck-document/v2'
    ) {
      if (options.metadataOnly) throw new ReachDeckGenerationCancelledError();
      return;
    }
    const currentArtifact = workspace.workspace.sceneArtifacts[payload.request.pageId];
    if (!currentArtifact || !isNativeSlideArtifact(currentArtifact)) {
      if (options.metadataOnly) throw new ReachDeckGenerationCancelledError();
      return;
    }
    const eligibleSnapshot = {
      ...snapshot,
      mediaSlots: snapshot.mediaSlots.filter((prior) =>
        currentArtifact.generationMetadata.mediaSlots?.some((slot) =>
          sameSlotPlan(
            slot,
            prior,
            resultArtifact.generationMetadata.mediaSlots?.find(
              (replacement) => replacement.assetId === prior.assetId,
            ),
          ),
        ),
      ),
    };
    if (eligibleSnapshot.mediaSlots.length === 0) {
      if (options.metadataOnly) throw new ReachDeckGenerationCancelledError();
      return;
    }
    let metadataOnly = options.metadataOnly === true;
    try {
      await assertReachDeckWorkspaceBatchJobNotCancelled(payload);
    } catch (error) {
      if (!(error instanceof ReachDeckGenerationCancelledError)) throw error;
      metadataOnly = true;
    }
    const patch = applyReachDeckImageSlotResults(
      materialized.document,
      payload.request.pageId,
      eligibleSnapshot,
      result.artifact,
      selectedAssetIds,
      metadataOnly,
    );
    if (metadataOnly && patch.slots.length === 0 && patch.removedAssetIds.length === 0)
      throw new ReachDeckGenerationCancelledError();
    if (
      patch.document !== materialized.document &&
      (await shouldDeferReachDeckImageForNarration({
        context,
        runId: payload.runId,
        pageId: payload.request.pageId,
        revision: materialized.document.pages.find(
          (page) => page.pageId === payload.request.pageId,
        )!.revision,
        loadedRecovery: options.loadedRecovery,
        queue: options.queue,
      }))
    )
      return 'deferred';
    if (options.checkOnly) return;
    try {
      if (patch.document !== materialized.document) {
        await rematerializeReachDeckModule(
          patch.document,
          workspace.draftRevision,
          materialized.materialization.contentDigest,
          context,
        );
      }
      await transitionReachDeckWorkspace(context, (current) => {
        if (current.runId !== payload.runId) return current;
        const artifact = current.sceneArtifacts[payload.request.pageId];
        if (!artifact || !isNativeSlideArtifact(artifact)) return current;
        const slots = artifact.generationMetadata.mediaSlots;
        if (!slots) return current;
        const updates = new Map(patch.slots.map((slot) => [slot.assetId, slot]));
        const mediaSlots = slots
          .filter(
            (slot) =>
              !patch.removedAssetIds.includes(slot.assetId) ||
              !eligibleSnapshot.mediaSlots.some((prior) => sameSlotPlan(slot, prior)),
          )
          .map((slot) => {
            const replacement = updates.get(slot.assetId);
            const prior = snapshot.mediaSlots.find(
              (candidate) => candidate.assetId === slot.assetId,
            );
            return replacement &&
              prior &&
              sameSlotPlan(slot, prior, replacement) &&
              (slot.binding === 'scientific-visual' ||
                slot.resourceId === prior.resourceId ||
                slot.resourceId === replacement.resourceId) &&
              slot.attempt <= replacement.attempt
              ? replacement
              : slot;
          });
        if (JSON.stringify(mediaSlots) === JSON.stringify(slots)) return current;
        const nativeSlide = patch.document.nativeSlides.find(
          (candidate) => candidate.pageId === payload.request.pageId,
        )?.slide;
        const pageResourceIds = nativeSlide
          ? new Set(collectReachDeckNativeSlideResourceIds(nativeSlide))
          : undefined;
        return {
          ...current,
          sceneArtifacts: {
            ...current.sceneArtifacts,
            [payload.request.pageId]: {
              ...artifact,
              ...(nativeSlide
                ? {
                    nativeSlide,
                    resources: {
                      ...patch.document.resources,
                      media: patch.document.resources.media.filter((resource) =>
                        pageResourceIds!.has(resource.id),
                      ),
                    },
                  }
                : {}),
              generationMetadata: { ...artifact.generationMetadata, mediaSlots },
            },
          },
        };
      });
      if (patch.skipped)
        await transitionReachDeckWorkspaceBatches(context, (batches) =>
          Object.fromEntries(
            Object.entries(batches).map(([batchId, batch]) => {
              if (
                batch.runId !== payload.runId ||
                !batch.members.some((member) => member.jobId === payload.jobId)
              )
                return [batchId, batch];
              return [
                batchId,
                {
                  ...batch,
                  revision: batch.revision + 1,
                  members: batch.members.map((member) =>
                    member.jobId === payload.jobId
                      ? {
                          ...member,
                          reason: withReachDeckImageSkippedSlots(member.reason, patch.skipped),
                        }
                      : member,
                  ),
                },
              ];
            }),
          ),
        );
      return;
    } catch (error) {
      if (!isContentServiceConflict(error) || round >= 15) throw error;
    }
  }
}
