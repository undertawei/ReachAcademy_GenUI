import { describe, expect, it } from 'vitest';
import type {
  GenerationWorkspace,
  ReachDeckNativeElementV2,
  ReachDeckPageMediaSlot,
} from '@reachany/reach-deck-dsl';
import { createEditorDocument } from '../../../../../packages/reach-deck-editor/tests/fixture';
import { duplicateReachDeckPage } from '@reachany/reach-deck-editor';
import {
  currentReachDeckMediaSlots,
  failedReachDeckMediaSlots,
  remainingReachDeckMediaPlaceholders,
} from './reach-deck-media-slots';

const slot: ReachDeckPageMediaSlot = {
  assetId: 'asset-1',
  plannedIndex: 0,
  plannedAsset: {
    kind: 'image',
    prompt: 'Forest',
    purpose: 'Example',
    alt: 'Forest',
    aspectRatio: '4:3',
    placement: 'primary',
  },
  planDigest: 'digest',
  elementId: 'image-1',
  binding: 'image-element',
  resourceId: 'placeholder',
  status: 'failed',
  failure: { reason: 'timeout', retryable: true, at: '2026-10-17T00:00:00Z' },
  attempt: 1,
};
function fixture() {
  const document = createEditorDocument();
  const slide = document.nativeSlides[0]!.slide;
  slide.elements.push({
    id: 'image-1',
    type: 'image',
    resourceId: 'placeholder',
    alt: 'Forest',
    fit: 'contain',
    transform: { x: 0, y: 0, width: 100, height: 100 },
    zIndex: 1,
  });
  const workspace = {
    sceneArtifacts: {
      'page-1': {
        schemaVersion: 'reach-deck-slide-artifact/v2',
        sceneType: 'slide',
        generationMetadata: { mediaSlots: [slot] },
      },
    },
  } as unknown as GenerationWorkspace;
  return { document, workspace, slide };
}
describe('current media slots', () => {
  it.each(['background', 'shape', 'textFrame', 'table', 'diagram', 'scientificVisual'] as const)(
    'locates placeholder references in %s without a generation artifact',
    (kind) => {
      const { document, workspace, slide } = fixture();
      workspace.sceneArtifacts = {};
      document.resources.media.push({
        id: 'placeholder',
        objectKey: 'placeholder.png',
        digest: 'placeholder',
        contentType: 'image/png',
        origin: {
          schemaVersion: 'reach-deck-media-origin/v1',
          route: 'image',
          provider: 'reach-deck-placeholder/v1',
        },
      });
      const text = structuredClone(
        slide.elements.find((element) => element.type === 'textFrame')!.text,
      );
      slide.elements = [];
      const fill = { kind: 'image' as const, resourceId: 'placeholder', mode: 'cover' as const };
      const base = { id: 'target', transform: { x: 0, y: 0, width: 100, height: 100 }, zIndex: 1 };
      if (kind === 'background') slide.background = fill;
      else {
        const element: ReachDeckNativeElementV2 =
          kind === 'shape'
            ? {
                ...base,
                type: kind,
                geometry: { kind: 'preset', preset: 'ellipse' },
                style: { fill },
              }
            : kind === 'textFrame'
              ? { ...base, type: kind, text, style: { fill } }
              : kind === 'table'
                ? {
                    ...base,
                    type: kind,
                    columnWidths: [100],
                    rowHeights: [100],
                    rows: [
                      {
                        id: 'row',
                        cells: [{ id: 'cell', rowSpan: 1, columnSpan: 1, text, style: { fill } }],
                      },
                    ],
                  }
                : kind === 'diagram'
                  ? {
                      ...base,
                      type: kind,
                      diagramType: 'process',
                      nodes: [{ id: 'node', label: text, style: { fill } }],
                      edges: [],
                    }
                  : {
                      ...base,
                      type: kind,
                      documentHtml: '<main>Science</main>',
                      ariaLabel: 'Science',
                      manifest: {
                        schemaVersion: 'reach-scientific-visual-manifest/v2',
                        hooksVersion: 'reach-scientific-visual-hooks/v1',
                        anchors: [],
                        dependencies: [],
                        resourceIds: ['placeholder'],
                        ariaLabel: 'Science',
                        textAlternative: 'Science',
                      },
                    };
        slide.elements = [element];
      }
      expect(remainingReachDeckMediaPlaceholders(document, workspace)['page-1']).toEqual([
        {
          assetId: 'placeholder',
          elementId: kind === 'background' ? undefined : 'target',
          hidden: false,
        },
      ]);
    },
  );
  it('counts a placeholder resource once per page even when several elements reference it', () => {
    const { document, workspace, slide } = fixture();
    document.resources.media.push({
      id: 'placeholder',
      objectKey: 'placeholder.png',
      digest: 'placeholder',
      contentType: 'image/png',
      origin: {
        schemaVersion: 'reach-deck-media-origin/v1',
        route: 'image',
        provider: 'reach-deck-placeholder/v1',
      },
    });
    const image = slide.elements.find((element) => element.id === 'image-1')!;
    slide.elements.push({ ...image, id: 'duplicate-image' });
    expect(remainingReachDeckMediaPlaceholders(document, workspace)['page-1']).toEqual([
      { assetId: 'asset-1', elementId: 'image-1', hidden: false },
    ]);
  });
  it('keeps distinct planned slots when they share the same placeholder resource', () => {
    const { document, workspace, slide } = fixture();
    const image = slide.elements.find((element) => element.id === 'image-1')!;
    slide.elements.push({ ...image, id: 'image-2', hidden: true });
    const artifact = workspace.sceneArtifacts['page-1']!;
    if ('generationMetadata' in artifact)
      artifact.generationMetadata.mediaSlots = [
        slot,
        { ...slot, assetId: 'asset-2', elementId: 'image-2', plannedIndex: 1 },
      ];
    expect(remainingReachDeckMediaPlaceholders(document, workspace)['page-1']).toEqual([
      { assetId: 'asset-1', elementId: 'image-1', hidden: false },
      { assetId: 'asset-2', elementId: 'image-2', hidden: true },
    ]);
  });
  it('finds copied placeholders without artifacts and carries ancestor visibility', () => {
    const { document, workspace, slide } = fixture();
    delete workspace.sceneArtifacts['page-1'];
    document.resources.media.push({
      id: 'placeholder',
      objectKey: 'generated/placeholder.png',
      contentType: 'image/png',
      digest: 'sha256:placeholder',
      origin: {
        schemaVersion: 'reach-deck-media-origin/v1',
        route: 'image',
        provider: 'reach-deck-placeholder/v1',
      },
    });
    slide.elements = [
      {
        id: 'hidden-group',
        type: 'group',
        hidden: true,
        transform: { x: 0, y: 0, width: 100, height: 100 },
        zIndex: 1,
        children: [slide.elements.find((element) => element.id === 'image-1')!],
      },
    ];
    let ordinal = 0;
    const copied = duplicateReachDeckPage(
      document,
      'page-1',
      (kind) => `copied-${kind}-${ordinal++}`,
    );
    if (copied.schemaVersion !== 'reach-deck-document/v2')
      throw new Error('Expected native document');
    copied.pages = copied.pages.filter((page) => page.pageId !== 'page-1');
    copied.nativeSlides = copied.nativeSlides.filter((binding) => binding.pageId !== 'page-1');
    const remaining = remainingReachDeckMediaPlaceholders(copied, workspace)[
      copied.pages[0]!.pageId
    ];
    expect(remaining).toEqual([
      {
        assetId: 'placeholder',
        elementId: expect.stringContaining('copied-element-'),
        hidden: true,
      },
    ]);
  });
  it('finds remaining placeholders for retries and publication preflight', () => {
    const { document, workspace } = fixture();
    expect(
      failedReachDeckMediaSlots(currentReachDeckMediaSlots(document, workspace))['page-1'],
    ).toEqual([slot]);
  });
  it.each(['delete', 'replace'] as const)(
    'does not block publication after a teacher %s',
    (change) => {
      const { document, workspace, slide } = fixture();
      if (change === 'delete')
        slide.elements = slide.elements.filter((element) => element.id !== slot.elementId);
      else {
        const image = slide.elements.find((element) => element.id === slot.elementId)!;
        if (image.type === 'image') image.resourceId = 'teacher-image';
      }
      expect(currentReachDeckMediaSlots(document, workspace)['page-1']).toEqual([]);
    },
  );
  it('preserves manual replacement provenance after re-layout', () => {
    const { document, workspace } = fixture();
    const artifact = workspace.sceneArtifacts['page-1']!;
    if ('generationMetadata' in artifact)
      artifact.generationMetadata.mediaSlots = [
        { ...slot, status: 'ready', teacherReplaced: true },
      ];
    expect(currentReachDeckMediaSlots(document, workspace)['page-1']).toEqual([]);
  });
  it('allows legacy documents without saved media slots', () => {
    const { document, workspace } = fixture();
    const artifact = workspace.sceneArtifacts['page-1']!;
    if ('generationMetadata' in artifact) delete artifact.generationMetadata.mediaSlots;
    expect(currentReachDeckMediaSlots(document, workspace)['page-1']).toEqual([]);
  });
  it('finds shape fills in nested groups', () => {
    const { document, workspace, slide } = fixture();
    slide.elements = [
      {
        id: 'group-1',
        type: 'group',
        transform: { x: 10, y: 10, width: 100, height: 100 },
        zIndex: 1,
        children: [
          {
            id: 'image-1',
            type: 'shape',
            geometry: { kind: 'preset', preset: 'rect' },
            transform: { x: 0, y: 0, width: 100, height: 100 },
            zIndex: 1,
            style: { fill: { kind: 'image', resourceId: 'placeholder', mode: 'cover' } },
          },
        ],
      },
    ];
    expect(currentReachDeckMediaSlots(document, workspace)['page-1']).toEqual([slot]);
  });
  it('retains unchanged native scientific slots and excludes teacher-edited content', () => {
    const { document, workspace, slide } = fixture();
    const { resourceId: _resourceId, failure: _failure, ...common } = slot;
    const scientificSlot: ReachDeckPageMediaSlot = {
      ...common,
      binding: 'scientific-visual',
      status: 'ready',
      contentDigest: 'a'.repeat(64),
    };
    slide.elements = [
      {
        id: 'image-1',
        type: 'scientificVisual',
        documentHtml: '<main>Original</main>',
        manifest: {
          schemaVersion: 'reach-scientific-visual-manifest/v2',
          hooksVersion: 'reach-scientific-visual-hooks/v1',
          anchors: [],
          dependencies: [],
          resourceIds: [],
          ariaLabel: 'Science',
          textAlternative: 'Original',
        },
        ariaLabel: 'Science',
        zIndex: 1,
        transform: { x: 0, y: 0, width: 100, height: 100 },
      },
    ];
    const artifact = workspace.sceneArtifacts['page-1']!;
    if ('nativeSlide' in artifact) artifact.nativeSlide = structuredClone(slide);
    else Object.assign(artifact, { nativeSlide: structuredClone(slide) });
    if ('generationMetadata' in artifact) artifact.generationMetadata.mediaSlots = [scientificSlot];
    expect(currentReachDeckMediaSlots(document, workspace)['page-1']).toEqual([scientificSlot]);
    const element = slide.elements[0]!;
    if (element.type === 'scientificVisual') element.documentHtml = '<main>Teacher edit</main>';
    expect(currentReachDeckMediaSlots(document, workspace)['page-1']).toEqual([]);
  });
});
