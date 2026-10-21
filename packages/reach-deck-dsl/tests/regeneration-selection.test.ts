import { describe, expect, it } from 'vitest';
import {
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  selectReachDeckRegenerationPages,
  type NativeSlideArtifact,
  type ReachDeckNativeElementV2,
  type ReachDeckPageMediaSlot,
} from '../src/index.js';
import { NOW, lessonPlan, outline, page, slideMetadata } from './generationFixtures.js';
import { scientificNativeElementFixture } from './scientificVisualFixtures.js';

const imageChannels = {
  layout: false,
  image: true,
  narration: false,
  audio: false,
  animation: false,
};

function fixture(binding: ReachDeckPageMediaSlot['binding'] = 'image-element') {
  const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck', generatedAt: NOW });
  const pageId = document.pages[0]!.pageId;
  const slide = document.nativeSlides[0]!.slide;
  const common = {
    id: 'planned-image',
    transform: { x: 0, y: 0, width: 400, height: 300 },
    zIndex: 1,
  };
  const element: ReachDeckNativeElementV2 =
    binding === 'scientific-visual'
      ? { ...scientificNativeElementFixture(), id: common.id }
      : binding === 'shape-fill'
        ? {
            ...common,
            type: 'shape',
            geometry: { kind: 'preset', preset: 'ellipse' },
            style: { fill: { kind: 'image', resourceId: 'old-image', mode: 'cover' } },
          }
        : {
            ...common,
            type: 'image',
            resourceId: 'old-image',
            fit: 'contain',
            alt: 'Planned diagram',
          };
  slide.elements = [element];
  const slot = {
    assetId: 'asset',
    plannedIndex: 0,
    elementId: element.id,
    planDigest: 'a'.repeat(64),
    plannedAsset: {
      kind: 'image',
      prompt: 'Image',
      alt: 'Image',
      aspectRatio: '4:3',
      placement: 'primary',
      purpose: 'Explain',
    },
    attempt: 1,
    ...(binding === 'scientific-visual'
      ? { binding, contentDigest: 'b'.repeat(64), status: 'ready' }
      : { binding, resourceId: 'old-image', status: 'failed' }),
  } as ReachDeckPageMediaSlot;
  const workspace = createGenerationWorkspace({
    runId: 'run',
    documentId: document.id,
    source: 'Source',
    lessonPlan,
    pagedOutline: outline([page(pageId, 1, 'slide')]),
    createdAt: NOW,
  });
  const request = workspace.records[pageId]!.request!;
  workspace.sceneArtifacts[pageId] = {
    ...request,
    schemaVersion: 'reach-deck-slide-artifact/v2',
    sceneType: 'slide',
    status: 'ready',
    nativeSlide: structuredClone(slide),
    resources: document.resources,
    generatedAt: NOW,
    generationMetadata: { ...slideMetadata(pageId), mediaSlots: [slot] },
  } as NativeSlideArtifact;
  workspace.statuses[pageId] = { ...request, state: 'ready', sceneId: slide.id, completedAt: NOW };
  const select = (imageScope: 'failed' | 'all' = 'all', assetIds?: string[]) =>
    selectReachDeckRegenerationPages({
      document,
      workspace,
      channels: imageChannels,
      scope: 'all',
      imageScope,
      assetIds,
    });
  return { document, workspace, pageId, slide, element, slot, select };
}

describe('image regeneration selection against the current document', () => {
  it.each(['image-element', 'shape-fill'] as const)('skips deleted %s slots', (binding) => {
    const { slide, select, pageId } = fixture(binding);
    slide.elements = [];
    expect(select()).toMatchObject({
      accepted: [],
      skipped: [{ pageId, reason: 'no-selected-channel-failure' }],
    });
  });

  it.each(['image-element', 'shape-fill'] as const)(
    'skips manually replaced %s slots',
    (binding) => {
      const { element, select } = fixture(binding);
      if (element.type === 'image') element.resourceId = 'teacher-image';
      else if (element.type === 'shape' && element.style.fill?.kind === 'image')
        element.style.fill.resourceId = 'teacher-image';
      expect(select().accepted).toEqual([]);
    },
  );

  it('skips a durable teacher replacement marker even when its resource still matches', () => {
    const { slot, select } = fixture();
    slot.teacherReplaced = true;
    expect(select().accepted).toEqual([]);
  });

  it.each(['image-element', 'shape-fill'] as const)(
    'accepts a surviving %s inside nested groups',
    (binding) => {
      const { slide, element, select, pageId } = fixture(binding);
      slide.elements = [
        {
          id: 'outer',
          type: 'group',
          transform: element.transform,
          zIndex: 2,
          children: [
            {
              id: 'inner',
              type: 'group',
              transform: element.transform,
              zIndex: 1,
              children: [element],
            },
          ],
        },
      ];
      expect(select('failed', ['asset']).accepted.map((candidate) => candidate.pageId)).toEqual([
        pageId,
      ]);
      expect(select('failed', ['another-asset']).accepted).toEqual([]);
    },
  );

  it.each(['documentHtml', 'manifest'] as const)(
    'skips scientific content replaced through %s',
    (field) => {
      const { element, select } = fixture('scientific-visual');
      if (element.type !== 'scientificVisual') throw new Error('Expected scientific fixture');
      if (field === 'documentHtml') element.documentHtml += '<p>Teacher change</p>';
      else element.manifest.textAlternative = 'Teacher change';
      expect(select().accepted).toEqual([]);
    },
  );

  it('accepts moved scientific content and equivalent manifest key order without browser crypto', () => {
    const { element, select, pageId } = fixture('scientific-visual');
    if (element.type !== 'scientificVisual') throw new Error('Expected scientific fixture');
    element.transform.x += 100;
    element.manifest = Object.fromEntries(
      Object.entries(element.manifest).reverse(),
    ) as typeof element.manifest;
    expect(select().accepted.map((candidate) => candidate.pageId)).toEqual([pageId]);
    expect(select('failed').accepted).toEqual([]);
  });

  it('distinguishes absent slots from slots whose current targets no longer survive', () => {
    const { workspace, pageId, select } = fixture();
    const artifact = workspace.sceneArtifacts[pageId] as NativeSlideArtifact;
    delete artifact.generationMetadata.mediaSlots;
    expect(select().skipped).toEqual([{ pageId, reason: 'no-media-slots' }]);
  });
});
