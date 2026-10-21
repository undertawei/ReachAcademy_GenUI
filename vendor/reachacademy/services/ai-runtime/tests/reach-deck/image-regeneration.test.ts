import {
  isNativeSlideArtifact,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  type ReachDeckPageMediaSlot,
  type ReachDeckPageMediaSnapshot,
  type GeneratedNativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/reach-deck/content-service-client.js', () => ({
  rematerializeReachDeckModule: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-jobs.js')>()),
  isContentServiceConflict: vi.fn(),
  loadReachDeckMaterializedWorkspaceDocument: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-store.js', () => ({
  loadReachDeckWorkspace: vi.fn(),
  transitionReachDeckWorkspace: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  transitionReachDeckWorkspaceBatches: vi.fn(),
  shouldDeferReachDeckImageForNarration: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-batch-cancellation.js', () => ({
  assertReachDeckWorkspaceBatchJobNotCancelled: vi.fn(),
}));
vi.mock('../../lib/reach-deck/queue.js', () => ({
  ReachDeckGenerationCancelledError: class extends Error {},
}));
import { assertReachDeckWorkspaceBatchJobNotCancelled } from '../../lib/reach-deck/workspace-batch-cancellation.js';
import { ReachDeckGenerationCancelledError } from '../../lib/reach-deck/queue.js';
import {
  applyReachDeckImageSlotResults,
  landReachDeckImageResults,
} from '../../lib/reach-deck/image-regeneration.js';
import { shouldDeferReachDeckImageForNarration } from '../../lib/reach-deck/workspace-recovery.js';
import { landReachDeckNativeNarration } from '../../lib/reach-deck/native-narration.js';
import {
  buildReachDeckNativeSlideContentDigest,
  buildReachDeckNarrationStateDigest,
} from '../../lib/reach-deck/job-identity.js';
import { scientificMediaContentDigest } from '../../lib/reach-deck/scientific-media-slot.js';
import { slideMetadata } from '../../../../packages/reach-deck-dsl/tests/generationFixtures.js';
import { rematerializeReachDeckModule } from '../../lib/reach-deck/content-service-client.js';
import { loadReachDeckMaterializedWorkspaceDocument } from '../../lib/reach-deck/workspace-jobs.js';
import {
  loadReachDeckWorkspace,
  transitionReachDeckWorkspace,
} from '../../lib/reach-deck/workspace-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import type {
  ReachDeckPageGenerationJobPayload,
  ReachDeckPageGenerationJobResult,
} from '../../lib/reach-deck/contracts.js';

function fixture() {
  const document = createBlankReachDeckDocument({
    id: 'deck',
    title: 'Deck',
    generatedAt: '2026-10-17T00:00:00.000Z',
  });
  const binding = document.nativeSlides[0]!;
  binding.slide.elements = [
    {
      id: 'image',
      type: 'image',
      transform: { x: 100, y: 80, width: 400, height: 300 },
      zIndex: 1,
      resourceId: 'old',
      fit: 'contain',
      alt: 'Teaching image',
    },
  ];
  const resource = (id: string) => ({
    id,
    objectKey: `${id}.png`,
    digest: id,
    contentType: 'image/png',
  });
  document.resources.media = [resource('old')];
  const slot: ReachDeckPageMediaSlot = {
    assetId: 'asset',
    elementId: 'image',
    binding: 'image-element',
    resourceId: 'old',
    plannedIndex: 0,
    plannedAsset: {
      kind: 'image',
      prompt: 'An image',
      alt: 'Teaching image',
      purpose: 'Explain',
      aspectRatio: '4:3',
      placement: 'primary',
    },
    planDigest: 'a'.repeat(64),
    status: 'failed',
    attempt: 1,
  };
  const snapshot: ReachDeckPageMediaSnapshot = {
    nativeSlide: structuredClone(binding.slide),
    resources: structuredClone(document.resources),
    mediaSlots: [slot],
  };
  const artifact: GeneratedNativeSlideArtifact = {
    schemaVersion: 'reach-deck-slide-artifact/v2',
    sceneType: 'slide',
    status: 'ready',
    runId: 'run',
    pageId: binding.pageId,
    requestedRevision: 1,
    attempt: 2,
    generatedAt: '2026-10-17T00:00:01.000Z',
    nativeSlide: {
      ...structuredClone(binding.slide),
      elements: [
        {
          ...binding.slide.elements[0]!,
          type: 'image',
          resourceId: 'new',
          fit: 'contain',
          alt: 'Teaching image',
        },
      ],
    },
    resources: { ...document.resources, media: [resource('new')] },
    generationMetadata: {
      ...slideMetadata(binding.pageId),
      mediaSlots: [{ ...slot, resourceId: 'new', status: 'ready', attempt: 2 }],
    },
  };
  return { document, binding, snapshot, artifact };
}

describe('image result conditional patches', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each(['before-document', 'before-metadata'])(
    'does not cross a new artifact identity: %s',
    async (boundary) => {
      vi.clearAllMocks();
      const { document, binding, snapshot, artifact } = fixture();
      const workspace = createGenerationWorkspace({
        runId: 'run',
        documentId: 'deck',
        source: 'Source',
        createdAt: '2026-10-17T00:00:00.000Z',
      });
      const priorArtifact = {
        ...artifact,
        nativeSlide: snapshot.nativeSlide,
        resources: snapshot.resources,
        generationMetadata: {
          ...artifact.generationMetadata,
          mediaSlots: structuredClone([...snapshot.mediaSlots]),
        },
      };
      workspace.sceneArtifacts[binding.pageId] = priorArtifact;
      const replaceIdentity = () => {
        priorArtifact.generationMetadata.mediaSlots![0]!.planDigest = 'b'.repeat(64);
      };
      if (boundary === 'before-document') replaceIdentity();
      const current = {
        ...TEST_REACH_DECK_SCOPE.resourceScope,
        draftRevision: 1,
        workspace,
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      };
      vi.mocked(loadReachDeckWorkspace).mockResolvedValue(current);
      vi.mocked(loadReachDeckMaterializedWorkspaceDocument).mockResolvedValue({
        materialized: true,
        document,
        materialization: {
          ...TEST_REACH_DECK_SCOPE.resourceScope,
          mongodbDocumentId: 'doc',
          draftRevision: 1,
          contentDigest: 'digest',
          materializedAt: '2026-10-17T00:00:00.000Z',
        },
      });
      vi.mocked(rematerializeReachDeckModule).mockImplementation(async () => {
        replaceIdentity();
        return {} as never;
      });
      vi.mocked(transitionReachDeckWorkspace).mockImplementation(async (_context, transition) => {
        current.workspace = transition(current.workspace) as typeof workspace;
        return { applied: true, resource: current };
      });
      const payload = {
        ...TEST_REACH_DECK_SCOPE,
        kind: 'page-generation',
        runId: 'run',
        jobId: 'job',
        request: {
          pageId: binding.pageId,
          requestedRevision: 1,
          previousMedia: snapshot,
          regenerationPlan: {
            channels: {
              image: true,
              layout: false,
              narration: false,
              audio: false,
              animation: false,
            },
            imageScope: 'failed',
            audioAnimationMode: 'preserve',
          },
        },
      } as unknown as ReachDeckPageGenerationJobPayload;
      await landReachDeckImageResults(TEST_REACH_DECK_SCOPE, payload, {
        kind: 'page-generation',
        artifact,
      } as ReachDeckPageGenerationJobResult);
      if (boundary === 'before-document')
        expect(rematerializeReachDeckModule).not.toHaveBeenCalled();
      expect(current.workspace.sceneArtifacts[binding.pageId]).toMatchObject({
        generationMetadata: {
          mediaSlots: [{ planDigest: 'b'.repeat(64), resourceId: 'old', attempt: 1 }],
        },
      });
    },
  );

  it.each(['not-cancelled', 'before-document', 'before-metadata', 'narration-pending'] as const)(
    'repairs only already-written image metadata when cancelled at %s',
    async (cancelledAt) => {
      const { document, binding, snapshot, artifact } = fixture();
      const workspace = createGenerationWorkspace({
        runId: 'run',
        documentId: 'deck',
        source: 'Teacher source',
        createdAt: '2026-10-17T00:00:00.000Z',
      });
      workspace.sceneArtifacts[binding.pageId] = {
        ...artifact,
        nativeSlide: snapshot.nativeSlide,
        resources: snapshot.resources,
        generationMetadata: {
          ...artifact.generationMetadata,
          mediaSlots: [...snapshot.mediaSlots],
        },
      };
      let current = {
        ...TEST_REACH_DECK_SCOPE.resourceScope,
        draftRevision: 1,
        workspace,
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      };
      document.resources.media.push({
        id: 'unrelated-page',
        objectKey: 'unrelated.png',
        contentType: 'image/png',
        digest: 'other',
      });
      let persisted = document;
      vi.mocked(loadReachDeckWorkspace).mockImplementation(async () => current);
      vi.mocked(loadReachDeckMaterializedWorkspaceDocument).mockImplementation(async () => ({
        materialized: true,
        document: persisted,
        materialization: {
          ...TEST_REACH_DECK_SCOPE.resourceScope,
          mongodbDocumentId: 'doc',
          draftRevision: 1,
          contentDigest: 'digest',
          materializedAt: '2026-10-17T00:00:00.000Z',
        },
      }));
      vi.mocked(rematerializeReachDeckModule).mockImplementation(async (value) => {
        persisted = value as typeof persisted;
        return {
          ...TEST_REACH_DECK_SCOPE.resourceScope,
          mongodbDocumentId: 'doc',
          draftRevision: 1,
          contentDigest: 'next-digest',
          materializedAt: '2026-10-17T00:00:00.000Z',
        };
      });
      vi.mocked(transitionReachDeckWorkspace)
        .mockRejectedValueOnce(new Error('metadata unavailable'))
        .mockImplementation(async (_context, transition) => {
          current = { ...current, workspace: transition(current.workspace) as typeof workspace };
          return { applied: true, resource: current };
        });
      const payload = {
        ...TEST_REACH_DECK_SCOPE,
        kind: 'page-generation',
        runId: 'run',
        jobId: 'image-job',
        request: {
          pageId: binding.pageId,
          previousMedia: snapshot,
          regenerationPlan: {
            channels: {
              image: true,
              layout: false,
              narration: false,
              audio: false,
              animation: false,
            },
            imageScope: 'failed',
            audioAnimationMode: 'preserve',
          },
        },
      } as unknown as ReachDeckPageGenerationJobPayload;
      const result = { kind: 'page-generation', artifact } as ReachDeckPageGenerationJobResult;
      const savedSlots = () => {
        const saved = current.workspace.sceneArtifacts[binding.pageId];
        if (saved?.sceneType !== 'slide') throw new Error('Expected slide artifact');
        return saved.generationMetadata.mediaSlots!;
      };
      if (cancelledAt === 'narration-pending') {
        vi.mocked(shouldDeferReachDeckImageForNarration).mockResolvedValue(true);
        await expect(
          landReachDeckImageResults(TEST_REACH_DECK_SCOPE, payload, result),
        ).resolves.toBe('deferred');
        expect(rematerializeReachDeckModule).not.toHaveBeenCalled();
        expect(transitionReachDeckWorkspace).not.toHaveBeenCalled();
        vi.mocked(shouldDeferReachDeckImageForNarration).mockResolvedValue(false);
        await expect(
          landReachDeckNativeNarration(TEST_REACH_DECK_SCOPE, {
            kind: 'narration-generation',
            runId: 'run',
            generatedFromDraftRevision: 1,
            nativeNarration: {
              pageId: binding.pageId,
              requestedRevision: document.pages[0]!.revision,
              attempt: 1,
              generatedAt: '2026-10-17T00:00:00.000Z',
              nativeSlideContentDigest: buildReachDeckNativeSlideContentDigest(
                snapshot.nativeSlide,
              ),
              narrationContentDigest: buildReachDeckNarrationStateDigest(undefined),
              markdown: 'New narration',
              audioObjectKey: 'audio/new.mp3',
              duration: 3,
              segments: [{ text: 'New narration', start: 0, end: 3 }],
            },
          }),
        ).resolves.toEqual({ status: 'applied' });
        vi.mocked(rematerializeReachDeckModule).mockClear();
        await expect(
          landReachDeckImageResults(TEST_REACH_DECK_SCOPE, payload, result, { checkOnly: true }),
        ).resolves.toBeUndefined();
        expect(shouldDeferReachDeckImageForNarration).toHaveBeenLastCalledWith(
          expect.objectContaining({ revision: 2 }),
        );
        expect(rematerializeReachDeckModule).not.toHaveBeenCalled();
        expect(transitionReachDeckWorkspace).not.toHaveBeenCalled();
      }
      if (cancelledAt === 'before-document') {
        vi.mocked(assertReachDeckWorkspaceBatchJobNotCancelled).mockRejectedValue(
          new ReachDeckGenerationCancelledError(),
        );
        await expect(
          landReachDeckImageResults(TEST_REACH_DECK_SCOPE, payload, result),
        ).rejects.toBeInstanceOf(ReachDeckGenerationCancelledError);
        expect(rematerializeReachDeckModule).not.toHaveBeenCalled();
        expect(transitionReachDeckWorkspace).not.toHaveBeenCalled();
        expect(savedSlots()[0]!.resourceId).toBe('old');
        return;
      }
      await expect(
        landReachDeckImageResults(TEST_REACH_DECK_SCOPE, payload, result),
      ).rejects.toThrow('metadata unavailable');
      expect(rematerializeReachDeckModule).toHaveBeenCalledTimes(1);
      expect(savedSlots()[0]!.resourceId).toBe('old');
      if (cancelledAt === 'before-metadata')
        vi.mocked(assertReachDeckWorkspaceBatchJobNotCancelled).mockRejectedValue(
          new ReachDeckGenerationCancelledError(),
        );
      vi.mocked(shouldDeferReachDeckImageForNarration).mockResolvedValue(true);
      await landReachDeckImageResults(TEST_REACH_DECK_SCOPE, payload, result);
      expect(rematerializeReachDeckModule).toHaveBeenCalledTimes(1);
      expect(savedSlots()[0]!).toMatchObject({ resourceId: 'new', status: 'ready', attempt: 2 });
      if (cancelledAt === 'narration-pending') {
        expect(persisted.nativeSlides[0]!.slide).toMatchObject({
          duration: 3,
          narration: {
            markdown: 'New narration',
            audioResourceId: expect.any(String),
            segments: [{ text: 'New narration', start: 0, end: 3 }],
          },
        });
        expect(persisted.pages[0]!.revision).toBe(document.pages[0]!.revision + 2);
        expect(
          persisted.resources.media.some((resource) => resource.objectKey === 'audio/new.mp3'),
        ).toBe(true);
      }
      const savedArtifact = current.workspace.sceneArtifacts[binding.pageId];
      expect(
        savedArtifact &&
          isNativeSlideArtifact(savedArtifact) &&
          savedArtifact.resources.media.map((r) => r.id),
      ).toEqual(
        cancelledAt === 'narration-pending'
          ? expect.arrayContaining([
              'new',
              persisted.nativeSlides[0]!.slide.narration!.audioResourceId,
            ])
          : ['new'],
      );
    },
  );
  it('replaces one grouped image while preserving teacher geometry and all unrelated fields', () => {
    const { document, binding, snapshot, artifact } = fixture();
    const image = binding.slide.elements[0]!;
    image.transform.x = 180;
    binding.slide.elements = [
      {
        id: 'group',
        type: 'group',
        transform: { x: 12, y: 15, width: 800, height: 600 },
        zIndex: 0,
        children: [image],
      },
    ];
    const patched = applyReachDeckImageSlotResults(document, binding.pageId, snapshot, artifact);
    const group = patched.document.nativeSlides[0]!.slide.elements[0]!;
    expect(group).toMatchObject({
      type: 'group',
      transform: binding.slide.elements[0]!.transform,
      children: [{ resourceId: 'new', transform: { x: 180 } }],
    });
    expect(patched.document.resources.media.map((resource) => resource.id)).toEqual(['new']);
    expect(patched.slots[0]).toMatchObject({ status: 'ready', attempt: 2 });
    expect(document.resources.media[0]!.id).toBe('old');
  });

  it.each(['replaced', 'deleted'])(
    'discards a result after the teacher %s the original image',
    (change) => {
      const { document, binding, snapshot, artifact } = fixture();
      if (change === 'deleted') binding.slide.elements = [];
      else if (binding.slide.elements[0]!.type === 'image')
        binding.slide.elements[0]!.resourceId = 'teacher';
      const patched = applyReachDeckImageSlotResults(document, binding.pageId, snapshot, artifact);
      expect(patched.document).toBe(document);
      expect(patched.slots).toEqual([]);
      expect(patched.skipped).toBe(1);
    },
  );

  it('replays the metadata checkpoint without rewriting the document or bumping revision', () => {
    const { document, binding, snapshot, artifact } = fixture();
    const first = applyReachDeckImageSlotResults(document, binding.pageId, snapshot, artifact);
    const replay = applyReachDeckImageSlotResults(
      first.document,
      binding.pageId,
      snapshot,
      artifact,
    );
    expect(replay.document).toBe(first.document);
    expect(replay.slots).toEqual(first.slots);
    expect(replay.skipped).toBe(0);
  });

  it('counts selected slots already replaced by the teacher before dispatch as skipped', () => {
    const { document, binding, snapshot, artifact } = fixture();
    if (snapshot.nativeSlide.elements[0]!.type === 'image')
      snapshot.nativeSlide.elements[0]!.resourceId = 'teacher';
    artifact.generationMetadata.mediaSlots = structuredClone([...snapshot.mediaSlots]);
    const patched = applyReachDeckImageSlotResults(
      document,
      binding.pageId,
      snapshot,
      artifact,
      new Set(['asset']),
    );
    expect(patched.document).toBe(document);
    expect(patched.slots).toEqual([]);
    expect(patched.skipped).toBe(1);
  });

  it('preserves an old resource still referenced by another element', () => {
    const { document, binding, snapshot, artifact } = fixture();
    binding.slide.elements.push({ ...structuredClone(binding.slide.elements[0]!), id: 'shared' });
    const patched = applyReachDeckImageSlotResults(document, binding.pageId, snapshot, artifact);
    expect(patched.document.resources.media.map((resource) => resource.id)).toEqual(['old', 'new']);
  });

  it('updates masked image fills without replacing the shape geometry', () => {
    const { document, binding, snapshot, artifact } = fixture();
    const prior = binding.slide.elements[0]!;
    binding.slide.elements = [
      {
        id: prior.id,
        type: 'shape',
        transform: prior.transform,
        zIndex: prior.zIndex,
        geometry: { kind: 'custom', viewBox: { width: 1, height: 1 }, path: 'M0 0H1V1H0Z' },
        style: { fill: { kind: 'image', resourceId: 'old', mode: 'cover' } },
      },
    ];
    snapshot.mediaSlots[0]!.binding = 'shape-fill';
    artifact.generationMetadata.mediaSlots![0]!.binding = 'shape-fill';
    const patched = applyReachDeckImageSlotResults(document, binding.pageId, snapshot, artifact);
    expect(patched.document.nativeSlides[0]!.slide.elements[0]).toEqual({
      ...binding.slide.elements[0],
      style: { fill: { kind: 'image', resourceId: 'new', mode: 'cover' } },
    });
  });

  it('replaces a scientific fallback and retains a replayable native science slot', () => {
    const { document, binding, snapshot, artifact } = fixture();
    Object.assign(binding.slide.elements[0]!, {
      hidden: true,
      opacity: 0.4,
      name: 'Teacher image',
      ariaLabel: 'Science',
    });

    const prior = artifact.nativeSlide.elements[0]!;
    artifact.nativeSlide.elements = [
      {
        id: prior.id,
        type: 'scientificVisual',
        transform: prior.transform,
        zIndex: prior.zIndex,
        ariaLabel: 'Science',
        documentHtml: '<!doctype html><html><body>Science</body></html>',
        manifest: {
          schemaVersion: 'reach-scientific-visual-manifest/v2',
          hooksVersion: 'reach-scientific-visual-hooks/v1',
          anchors: [],
          dependencies: [],
          resourceIds: [],
          ariaLabel: 'Science',
          textAlternative: 'Science',
        },
      },
    ];
    const science = artifact.nativeSlide.elements[0]!;
    if (science.type !== 'scientificVisual') throw new Error('科学图测试夹具不匹配');
    const { resourceId: _resourceId, failure: _failure, ...priorSlot } = snapshot.mediaSlots[0]!;
    artifact.generationMetadata.mediaSlots = [
      {
        ...priorSlot,
        binding: 'scientific-visual',
        status: 'ready',
        attempt: 2,
        contentDigest: scientificMediaContentDigest(science),
      },
    ];
    const patched = applyReachDeckImageSlotResults(document, binding.pageId, snapshot, artifact);
    expect(patched.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
      type: 'scientificVisual',
      id: 'image',
      hidden: true,
      opacity: 0.4,
      name: 'Teacher image',
      ariaLabel: 'Science',
      transform: binding.slide.elements[0]!.transform,
    });
    expect(patched.removedAssetIds).toEqual([]);
    expect(patched.slots).toMatchObject([
      { binding: 'scientific-visual', attempt: 2, status: 'ready' },
    ]);
    const replay = applyReachDeckImageSlotResults(
      patched.document,
      binding.pageId,
      snapshot,
      artifact,
    );
    expect(replay.document).toBe(patched.document);
    expect(replay.slots).toEqual(patched.slots);
    const nativeSnapshot: ReachDeckPageMediaSnapshot = {
      nativeSlide: structuredClone(patched.document.nativeSlides[0]!.slide),
      resources: patched.document.resources,
      mediaSlots: patched.slots,
    };
    const priorScienceSlot = patched.slots[0]!;
    if (priorScienceSlot.binding !== 'scientific-visual') throw new Error('科学图图位不匹配');
    science.documentHtml = '<!doctype html><html><body>New science</body></html>';
    artifact.generationMetadata.mediaSlots = [
      {
        ...priorScienceSlot,
        binding: 'scientific-visual',
        status: 'ready',
        attempt: 3,
        contentDigest: scientificMediaContentDigest(science),
      },
    ];
    const currentScience = patched.document.nativeSlides[0]!.slide.elements[0]!;
    if (currentScience.type !== 'scientificVisual') throw new Error('科学图测试夹具不匹配');
    currentScience.locked = true;
    const regenerated = applyReachDeckImageSlotResults(
      patched.document,
      binding.pageId,
      nativeSnapshot,
      artifact,
    );
    expect(regenerated.slots).toMatchObject([{ binding: 'scientific-visual', attempt: 3 }]);
    expect(regenerated.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
      documentHtml: science.documentHtml,
      hidden: true,
      opacity: 0.4,
      locked: true,
      ariaLabel: 'Science',
    });
    const edited = structuredClone(patched.document);
    const editedScience = edited.nativeSlides[0]!.slide.elements[0]!;
    if (editedScience.type !== 'scientificVisual') throw new Error('科学图测试夹具不匹配');
    editedScience.documentHtml = '<!doctype html><html><body>Teacher edit</body></html>';
    const kept = applyReachDeckImageSlotResults(edited, binding.pageId, nativeSnapshot, artifact);
    expect(kept.document).toBe(edited);
    expect(kept.slots).toEqual([]);
    expect(kept.skipped).toBe(1);
  });
});
