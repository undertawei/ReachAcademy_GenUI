import { describe, expect, it } from 'vitest';
import {
  createBlankReachDeckDocument,
  parsePlannedVisualAsset,
  parsePageOutlineValue,
  parseReachDeckDocumentV2,
  parseReachDeckMediaOrigin,
  parseReachDiagramChartSpec,
  parseSlideContentBlueprintValue,
  finalizeGeneratedPagedDeckOutline,
  type GeneratedPagedDeckOutline,
} from '../src/index.js';
import { page, slideMetadata } from './generationFixtures.js';

const common = { purpose: '支持教学', alt: '颐和园实景', aspectRatio: '4:3', placement: 'primary' };
const reference = {
  ...common,
  kind: 'reference-image',
  query: '颐和园 实景',
  requiredIdentityGroups: [['颐和园', 'Summer Palace']],
  excludedTerms: ['游戏'],
};
const origin = {
  schemaVersion: 'reach-deck-media-origin/v1' as const,
  route: 'reference-image' as const,
  provider: 'doubao',
  sourceId: 'source-1',
  title: '颐和园',
  sourceUrl: 'https://example.org/palace',
  license: 'unknown',
};

describe('four-route visual planning', () => {
  it('bounds molecular input without stripping valid SMILES stereochemistry', () => {
    const asset = {
      ...common,
      kind: 'diagram',
      representation: 'molecule',
      spec: { smiles: 'N[C@@H](C)C(=O)O', title: null },
    };
    expect(parsePlannedVisualAsset(asset)).toMatchObject({ spec: { smiles: 'N[C@@H](C)C(=O)O' } });
    for (const spec of [
      { smiles: '' },
      { smiles: 'C'.repeat(513) },
      { smiles: 'C C' },
      { smiles: 'C\nC' },
      { smiles: 'CCO', script: 'execute' },
    ]) {
      expect(() => parsePlannedVisualAsset({ ...asset, spec })).toThrow();
    }
  });
  it('binds global visual material ordinals to selected page-local images without confusing order', () => {
    const draft = {
      title: 'Materials',
      pages: [
        {
          sceneType: 'slide',
          title: 'Sources',
          materialReferenceOrdinals: [3, 1],
          instructionalSpec: {
            learningObjective: '观察',
            teachingMove: 'explain',
            keyPoints: ['一', '二', '三'],
            visualDirection: '比较',
            density: 'low',
            visualAssets: [{ ...reference, materialReferenceOrdinal: 3 }],
          },
        },
      ],
    } as GeneratedPagedDeckOutline;
    const materials = [1, 2, 3].map((index) => ({
      id: `image-${index}`,
      kind: 'image' as const,
      sha256: 'a'.repeat(64),
      fileName: `image-${index}.png`,
    }));
    let id = 0;
    const bound = finalizeGeneratedPagedDeckOutline(
      draft,
      (prefix) => `${prefix}-${++id}`,
      materials,
    );
    expect(bound.pages[0]?.materialReferences?.map((material) => material.id)).toEqual([
      'image-3',
      'image-1',
    ]);
    expect(bound.pages[0]?.instructionalSpec?.visualAssets[0]).toMatchObject({
      materialReferenceOrdinal: 1,
    });
    for (const ordinal of [2, 4]) {
      const invalid = structuredClone(draft);
      const asset = invalid.pages[0]!.instructionalSpec!.visualAssets[0]!;
      if (asset.kind !== 'reference-image') throw new Error('fixture');
      asset.materialReferenceOrdinal = ordinal;
      expect(() =>
        finalizeGeneratedPagedDeckOutline(invalid, (prefix) => `${prefix}-${++id}`, materials),
      ).toThrow(/must select an image/);
    }
    expect(() =>
      finalizeGeneratedPagedDeckOutline(
        draft,
        (prefix) => `${prefix}-${++id}`,
        materials.map((material) => ({ ...material, kind: 'text' })),
      ),
    ).toThrow(/must select an image/);
  });
  it('requires explicit routes, preserves bounded identity groups and rejects executable fields', () => {
    expect(parsePlannedVisualAsset({ ...reference, materialReferenceOrdinal: 1 })).toEqual({
      ...reference,
      materialReferenceOrdinal: 1,
    });
    for (const extra of [
      { query: 'x'.repeat(101) },
      { requiredIdentityGroups: [] },
      { requiredIdentityGroups: [['one', 'two', 'three', 'four']] },
      { excludedTerms: Array(7).fill('exclude') },
      { materialReferenceOrdinal: 0 },
      { fallbackPrompt: 'invent a photo' },
      { downloadUrl: 'https://example.org/image.png' },
    ])
      expect(() => parsePlannedVisualAsset({ ...reference, ...extra })).toThrow();
    expect(() => parsePlannedVisualAsset({ ...common, prompt: 'sunset' })).toThrow();
    expect(() => parsePlannedVisualAsset({ ...common, kind: 'function-plot', plot: {} })).toThrow();
  });

  it('keeps up to three distinct alternative queries and omits an empty list', () => {
    expect(
      parsePlannedVisualAsset({
        ...reference,
        alternativeQueries: ['Summer Palace Beijing', '颐和园 照片'],
      }),
    ).toEqual({ ...reference, alternativeQueries: ['Summer Palace Beijing', '颐和园 照片'] });
    expect(parsePlannedVisualAsset({ ...reference, alternativeQueries: [] })).toEqual(reference);
    expect(parsePlannedVisualAsset({ ...reference, alternativeQueries: null })).toEqual(reference);
    for (const alternativeQueries of [
      ['a', 'b', 'c', 'd'],
      [''],
      ['x'.repeat(101)],
      [7],
      ['颐和园  实景'],
      ['Summer Palace', 'summer palace'],
      'Summer Palace',
    ])
      expect(() => parsePlannedVisualAsset({ ...reference, alternativeQueries })).toThrow();
  });

  it('keeps SVG/HTML briefs separate from host-rendered chart data', () => {
    for (const representation of ['svg', 'html', 'geometry']) {
      const asset = {
        ...common,
        kind: 'diagram',
        representation,
        prompt: '事件时间轴',
        invariants: ['事件按时间顺序'],
      };
      expect(parsePlannedVisualAsset(asset)).toEqual(asset);
      expect(() => parsePlannedVisualAsset({ ...asset, source: '<svg />' })).toThrow();
      expect(() => parsePlannedVisualAsset({ ...asset, invariants: [] })).toThrow();
    }
    const asset = {
      ...common,
      kind: 'diagram',
      representation: 'chart',
      spec: { type: 'bar', labels: ['A', 'B'], values: [-2, 3] },
    };
    expect(parsePlannedVisualAsset(asset)).toEqual(asset);
    expect(() =>
      parseReachDiagramChartSpec({ type: 'pie', labels: ['A'], values: [-1] }),
    ).toThrow();
    expect(() => parseReachDiagramChartSpec({ type: 'pie', labels: ['A'], values: [0] })).toThrow();
    expect(() =>
      parseReachDiagramChartSpec({ type: 'bar', labels: ['A'], values: [NaN] }),
    ).toThrow();
    expect(() =>
      parseReachDiagramChartSpec({ type: 'bar', labels: ['A'], values: [1, 2] }),
    ).toThrow();
  });

  it('rejects obsolete learnerAction and summary contracts', () => {
    const instructionalSpec = {
      learningObjective: '观察',
      teachingMove: 'explain',
      keyPoints: ['一', '二', '三'],
      visualDirection: '观察',
      density: 'low',
      visualAssets: [],
    };
    expect(
      parsePageOutlineValue({ ...page('slide', 1, 'slide'), instructionalSpec }).instructionalSpec
        ?.visualAssets,
    ).toEqual([]);
    expect(() =>
      parsePageOutlineValue({
        ...page('slide', 1, 'slide'),
        instructionalSpec: { ...instructionalSpec, learnerAction: 'obsolete' },
      }),
    ).toThrow();
    expect(() =>
      parsePageOutlineValue({ ...page('slide', 1, 'slide'), summary: 'obsolete' }),
    ).toThrow();
  });

  it('still loads persisted blueprints that carry the retired renderFallback', () => {
    const blueprint = parseSlideContentBlueprintValue({
      ...slideMetadata('slide').blueprint,
      mediaIntent: { kind: 'diagram', renderFallback: 'board-writing' },
    });
    expect(blueprint.mediaIntent).toEqual({ kind: 'diagram' });
  });
});

describe('durable media origin', () => {
  it.each(['design=modern', 'pagetoken=next', 'q=expires', 'q=signature', 'designation=palace'])(
    'allows ordinary source query keys: %s',
    (query) => {
      const sourceUrl = `https://example.org/source?${query}`;
      expect(parseReachDeckMediaOrigin({ ...origin, sourceUrl }).sourceUrl).toBe(sourceUrl);
    },
  );
  it.each([
    '%73ignature=secret',
    '%74oken=secret',
    'api%5Fkey=secret',
    'API%2DKEY=secret',
    'X%2DAmz%2DSignature=secret',
    'auth%5Fkey=secret',
  ])('rejects encoded credential keys consistently with Java: %s', (query) => {
    expect(() =>
      parseReachDeckMediaOrigin({ ...origin, sourceUrl: `https://example.org/source?${query}` }),
    ).toThrow(/stable public source URL/);
  });
  it('roundtrips managed resource provenance through strict Deck V2 parsing', () => {
    const doc = createBlankReachDeckDocument({ id: 'test', title: 'Test' });
    doc.resources.media.push({
      id: 'image',
      objectKey: 'images/managed.png',
      contentType: 'image/png',
      digest: 'sha256:asset',
      origin,
    });
    expect(
      parseReachDeckDocumentV2(JSON.parse(JSON.stringify(doc))).resources.media[0]?.origin,
    ).toEqual(origin);
    expect(
      parseReachDeckMediaOrigin({
        schemaVersion: origin.schemaVersion,
        route: 'diagram',
        engine: 'chart',
        rendererVersion: 'v1',
        sourceDigest: 'a'.repeat(64),
      }).engine,
    ).toBe('chart');
  });
  it('rejects raw source code, credentials, signed links and unbounded metadata', () => {
    for (const extra of [
      { downloadUrl: 'https://example.org/img' },
      { source: '<svg />' },
      { sourceUrl: 'https://example.org/img?X-Amz-Signature=secret' },
      { sourceUrl: 'https://example.org/img?auth_key=secret' },
      { sourceUrl: 'https://user:secret@example.org/img' },
      { sourceUrl: 'data:image/png;base64,abc' },
      { description: 'x'.repeat(4001) },
      { sourceDigest: 'not-a-digest' },
    ])
      expect(() => parseReachDeckMediaOrigin({ ...origin, ...extra })).toThrow();
  });
});
