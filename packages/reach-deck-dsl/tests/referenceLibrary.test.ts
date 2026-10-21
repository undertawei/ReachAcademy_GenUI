import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_PROVENANCE,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_REGISTRY,
  createReferenceCompactIndex,
  getReferenceEntry,
  retrieveReferenceLayouts,
  isReferenceMember,
} from '../src/reference-library/index.js';
import {
  parseReachDeckDesignContextValue,
  parseGeneratedPagedDeckOutlineValue,
  parsePageOutlineValue,
  finalizeGeneratedPagedDeckOutline,
  normalizeTeacherPagedDeckOutlineValue,
  parseReachDeckPageDesignIntentValue,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
} from '../src/generationTypes.js';
import { resolveSlidePageRole } from '../src/slideSemantics.js';
import { parseSlideGenerationMetadataValue } from '../src/generationTypes.js';
import { createGenerationWorkspace, parseGenerationWorkspace } from '../src/generationWorkspace.js';
import { REFERENCE_MANIFEST_VERSION } from '../src/referenceRegistry.js';
import { lessonPlan, slideMetadata, NOW } from './generationFixtures.js';
import { createReferenceCompactIndexText } from '../src/reference-library/index.js';
import { resolveDeckDesignTheme } from '../src/designTheme.js';
import { createThemeResource, deckThemeFromResource } from '../src/compileToNativeV2.js';

const design = () => ({
  schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
  libraryVersion: REFERENCE_LIBRARY_VERSION,
  librarySha256: REFERENCE_LIBRARY_SHA256,
  paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
  imageStyleReferenceIds: [REFERENCE_LIBRARY.imageStyles[0]!.id],
  visualIntent: 'Clear teaching',
  resolvedColors: {
    background: '#FFFFFF',
    surface: '#FFFFFF',
    ink: '#111111',
    muted: '#555555',
    accent: '#006699',
    success: '#006600',
    warning: '#663300',
  },
});
const intent = () => ({
  pageRole: 'content',
  focus: 'Evidence',
  informationRelationship: 'cause_effect',
  layoutReferenceIds: [REFERENCE_LIBRARY.layouts[0]!.id],
  componentReferenceIds: [],
  imageStyleReferenceIds: [],
});
const page = (count: number) => ({
  sceneType: 'slide',
  title: 'Evidence',
  instructionalSpec: {
    learningObjective: 'Explain',
    teachingMove: 'explain',
    keyPoints: ['a', 'b', 'c'],
    visualDirection: 'Compare evidence',
    density: 'medium',
    visualAssets: Array.from({ length: count }, () => ({
      kind: 'image',
      purpose: 'evidence',
      prompt: 'diagram',
      alt: 'evidence',
      aspectRatio: '1:1',
      placement: 'supporting',
    })),
  },
});

describe('full reference library snapshot', () => {
  it('projects every ID once in compact text without duplicate JSON field overhead', () => {
    const text = createReferenceCompactIndexText();
    expect(text).toBe(createReferenceCompactIndexText());
    expect(text.split('\n')).toHaveLength(251);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(45000);
    for (const entry of createReferenceCompactIndex()) {
      expect(text.split('\n').filter((line) => line.split(' | ')[1] === entry.id)).toHaveLength(1);
    }
  });
  it('protects global registry, catalog, guidance and source metadata from mutation', () => {
    expect(() => REFERENCE_REGISTRY.references.pop()).toThrow();
    expect(() => REFERENCE_LIBRARY.layouts[0]!.slots.pop()).toThrow();
    expect(() => REFERENCE_LIBRARY.imageStyles[0]!.avoid.push('mutation')).toThrow();
    expect(() => {
      REFERENCE_LIBRARY.sources[0]!.title = 'mutation';
    }).toThrow();
  });
  for (const palette of REFERENCE_LIBRARY.palettes)
    it(`resolved palette survives native resource round-trip: ${palette.id}`, () => {
      const context = parseReachDeckDesignContextValue({
        ...design(),
        paletteReferenceId: palette.id,
        resolvedColors: palette.colors,
      });
      const theme = resolveDeckDesignTheme(undefined, context);
      const restored = deckThemeFromResource(
        JSON.parse(JSON.stringify(createThemeResource(theme))),
      );
      expect(restored).toEqual(theme);
      for (const [key, value] of Object.entries(palette.colors))
        expect(restored?.[key as keyof typeof theme]).toBe(value);
    });
  for (const category of ['layouts', 'components'] as const)
    for (const entry of REFERENCE_LIBRARY[category])
      it(`complete advisory source projection: ${entry.id}`, () => {
        const registered = REFERENCE_REGISTRY.references.find(
          (reference) => reference.id === entry.id,
        )!;
        const source = getReferenceEntry('sources', entry.sourceId);
        expect(registered.source?.version).toBe(String(entry.version));
        expect(registered.source?.summary).toContain(
          `source=${source.id}; sha256=${source.digestSha256.toLowerCase()}`,
        );
        expect(registered.source?.pageRange).toBe(entry.sourcePages.join(','));
        expect(registered.verificationCaseIds).toEqual([`registry-contract:${entry.id}`]);
        expect(registered.projection.generation).toBe(true);
        expect(registered.source?.extractionBoundary).toContain(source.forbiddenReuse.join(','));
        expect(getReferenceEntry(category, entry.id)).toEqual(entry);
      });
  it('preserves all categories, governance and source digest without local paths or preview pixels', () => {
    const index = createReferenceCompactIndex();
    expect(index).toHaveLength(251);
    expect(new Set(index.map((e) => e.id))).toEqual(
      new Set(REFERENCE_REGISTRY.references.map((e) => e.id)),
    );
    expect(REFERENCE_LIBRARY.visualAssets).toEqual([]);
    for (const entry of index) expect(isReferenceMember(entry.category, entry.id)).toBe(true);
    expect(REFERENCE_LIBRARY.sources[0]!.technicalReadiness.generation).toBe(false);
    expect(REFERENCE_LIBRARY.sources[0]!.publication.state).toBe('candidate');
    expect(REFERENCE_LIBRARY.sources[0]!.digestSha256).toMatch(/^[a-f0-9]{64}$/i);
    expect(JSON.stringify(REFERENCE_LIBRARY)).not.toMatch(/[A-Za-z]:[\\/]|file:\/\/|data:image/);
    expect(createHash('sha256').update(JSON.stringify(REFERENCE_LIBRARY)).digest('hex')).toBe(
      REFERENCE_LIBRARY_SHA256,
    );
    expect(REFERENCE_LIBRARY_PROVENANCE.guidanceDifferences).toHaveLength(7);
  });
  for (const style of REFERENCE_LIBRARY.imageStyles)
    it(`guidance and restrictions: ${style.id}`, () => {
      expect(style.guidance.id).toBe(style.id);
      expect(style.guidance.generationPrompt).toContain('{{主题}}');
      expect(style.guidance.useWhen.length).toBeGreaterThan(0);
      expect(style.guidance.pptPlacement.length).toBeGreaterThan(0);
      expect(style.guidance.visualRecipe.length).toBeGreaterThan(0);
      expect(style.avoid).toEqual(expect.arrayContaining(style.catalogAvoid));
      expect(style.avoid).toEqual(expect.arrayContaining(style.guidance.avoid));
    });
  it('has deterministic complete index and individually reachable references', () => {
    expect(createReferenceCompactIndex()).toEqual(createReferenceCompactIndex());
    for (const item of createReferenceCompactIndex())
      expect(getReferenceEntry(item.category, item.id).id).toBe(item.id);
    expect(() => getReferenceEntry('palettes', REFERENCE_LIBRARY.layouts[0]!.id)).toThrow();
  });
  it('retains cross-type composition without replacing the requested teaching relationship', () => {
    const target = REFERENCE_LIBRARY.layouts[0]!;
    const query = {
      primaryType: 'cause_effect' as const,
      pageRole: 'content' as const,
      explicitReferenceIds: [target.id],
      limit: 1,
    };
    const result = retrieveReferenceLayouts(query);
    expect(result).toEqual(retrieveReferenceLayouts(query));
    expect(result[0]).toMatchObject({
      crossType: true,
      advisory: true,
      informationRelationship: 'cause_effect',
    });
    expect(result[0]!.reference.id).toBe(target.id);
  });
});

describe('reference design protocol compatibility', () => {
  it('round-trips four-asset pages through persisted workspace restoration', () => {
    let id = 0;
    const outline = finalizeGeneratedPagedDeckOutline(
      parseGeneratedPagedDeckOutlineValue({
        title: 'New',
        designContext: design(),
        pages: [page(4)],
      }),
      (prefix) => `${prefix}-${++id}`,
    );
    const workspace = createGenerationWorkspace({
      runId: 'r',
      documentId: 'd',
      source: 'Teaching',
      lessonPlan,
      pagedOutline: outline,
      createdAt: NOW,
    });
    const restored = parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(restored.pagedOutline).toEqual(outline);
    // Teacher adoption re-normalizes the same outline and must keep the design allowance.
    const adopted = normalizeTeacherPagedDeckOutlineValue(JSON.parse(JSON.stringify(outline)));
    expect(adopted.pages[0]!.instructionalSpec!.visualAssets).toHaveLength(4);
    expect(adopted.designContext).toEqual(outline.designContext);
  });
  it('new metadata persists advisory IDs separately from legacy layout matches', () => {
    const metadata = {
      ...slideMetadata('p'),
      layoutReferences: [],
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      designContext: design(),
      designIntent: intent(),
    };
    expect(parseSlideGenerationMetadataValue(metadata)).toEqual(metadata);
    expect(() =>
      parseSlideGenerationMetadataValue({ ...metadata, manifestVersion: 'unknown' }),
    ).toThrow();
    expect(() =>
      parseSlideGenerationMetadataValue({ ...slideMetadata('p'), layoutReferences: [] }),
    ).toThrow();
  });
  it('accepts historical outlines and preserves new snapshot during finalization', () => {
    expect(parseGeneratedPagedDeckOutlineValue({ title: 'Old', pages: [] })).toEqual({
      title: 'Old',
      pages: [],
    });
    const parsed = parseGeneratedPagedDeckOutlineValue({
      title: 'New',
      designContext: design(),
      pages: [{ ...page(4), designIntent: intent() }],
    });
    let id = 0;
    const final = finalizeGeneratedPagedDeckOutline(parsed, (prefix) => `${prefix}-${++id}`);
    expect(final.designContext).toEqual(design());
    expect(final.pages[0]!.designIntent).toEqual(intent());
    expect(final.pages[0]!.instructionalSpec!.visualAssets).toHaveLength(4);
    expect(Object.isFrozen(final.designContext!.resolvedColors)).toBe(true);
  });
  it('limits legacy/standalone parsing to three and new protocol to four assets', () => {
    expect(() => parseGeneratedPagedDeckOutlineValue({ title: 'Old', pages: [page(4)] })).toThrow();
    expect(() => parsePageOutlineValue({ ...page(4), id: 'p', order: 1 })).toThrow();
    expect(
      parsePageOutlineValue({ ...page(4), id: 'p', order: 1 }, design()).instructionalSpec!
        .visualAssets,
    ).toHaveLength(4);
    expect(() =>
      parseGeneratedPagedDeckOutlineValue({
        title: 'New',
        designContext: design(),
        pages: [page(5)],
      }),
    ).toThrow();
  });
  it.each([
    { libraryVersion: 'unknown' },
    { librarySha256: '0'.repeat(64) },
    { paletteReferenceId: 'unknown' },
    { imageStyleReferenceIds: ['unknown'] },
    { resolvedColors: { ...design().resolvedColors, ink: 'red' } },
    { paletteReferenceId: '' },
  ])('rejects invalid design %j', (patch) => {
    expect(() => parseReachDeckDesignContextValue({ ...design(), ...patch })).toThrow();
  });
  it('permits original design only with an explicit marker and full colors', () => {
    expect(
      parseReachDeckDesignContextValue({
        ...design(),
        paletteReferenceId: '',
        originalDesign: true,
      }).originalDesign,
    ).toBe(true);
  });
  it('rejects wrong-category and duplicate page references', () => {
    expect(() =>
      parseReachDeckPageDesignIntentValue({
        ...intent(),
        layoutReferenceIds: [design().paletteReferenceId],
      }),
    ).toThrow();
    expect(() =>
      parseReachDeckPageDesignIntentValue({
        ...intent(),
        layoutReferenceIds: [...intent().layoutReferenceIds, ...intent().layoutReferenceIds],
      }),
    ).toThrow();
  });
  it('historical page role inference respects narrative role without creating covers', () => {
    expect(resolveSlidePageRole({ narrativeRole: 'open' })).toBe('content');
    expect(resolveSlidePageRole({ narrativeRole: 'conclude' })).toBe('summary');
    expect(resolveSlidePageRole({ sceneType: 'quiz' })).toBe('practice');
    expect(resolveSlidePageRole({ narrativeRole: 'demonstrate' })).toBe('observe');
  });
});
