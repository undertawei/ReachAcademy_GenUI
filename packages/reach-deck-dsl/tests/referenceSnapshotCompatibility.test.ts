import { describe, expect, it } from 'vitest';
import {
  assembleReachDeckDocument,
  assertCurrentReferenceLibrary,
  createGenerationWorkspace,
  isCurrentReferenceLibrary,
  parseGenerationWorkspace,
  parsePagedDeckOutlineValue,
  parseProductionGeneratedPagedDeckOutlineValue,
  parseReachDeckDesignContextValue,
  parseSlideGenerationMetadataValue,
  parseStoredReachDeckDesignContextValue,
  parseStoredReachDeckPageDesignIntentValue,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REFERENCE_MANIFEST_VERSION,
  resolveDeckDesignTheme,
} from '../src/index.js';
import {
  createReferenceCoverageManifest,
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '../src/reference-library/index.js';
import {
  artifactFor,
  landSceneArtifact,
  lessonPlan,
  NOW,
  prepareForArtifact,
  slideMetadata,
} from './generationFixtures.js';

const currentDesign = () => ({
  schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
  libraryVersion: REFERENCE_LIBRARY_VERSION,
  librarySha256: REFERENCE_LIBRARY_SHA256,
  paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
  imageStyleReferenceIds: [REFERENCE_LIBRARY.imageStyles[0]!.id],
  visualIntent: 'Saved classroom design',
  resolvedColors: {
    background: '#FAFCFF',
    surface: '#FFFFFF',
    ink: '#111111',
    muted: '#555555',
    accent: '#006699',
    success: '#006600',
    warning: '#663300',
  },
});
const currentIntent = () => ({
  pageRole: 'content' as const,
  focus: 'Evidence',
  informationRelationship: 'comparison',
  layoutReferenceIds: [REFERENCE_LIBRARY.layouts[0]!.id],
  componentReferenceIds: [REFERENCE_LIBRARY.components[0]!.id],
  imageStyleReferenceIds: [REFERENCE_LIBRARY.imageStyles[0]!.id],
});
const historicalDesign = () => ({
  ...currentDesign(),
  libraryVersion: 'retired-library/v0',
  librarySha256: 'a'.repeat(64),
  paletteReferenceId: 'retired-palette',
  imageStyleReferenceIds: ['retired-image-style'],
});
const historicalIntent = () => ({
  ...currentIntent(),
  layoutReferenceIds: ['retired-layout'],
  componentReferenceIds: ['retired-component'],
  imageStyleReferenceIds: ['retired-image-style'],
});
const productionOutline = () => ({
  title: 'Saved lesson',
  manifestVersion: REFERENCE_MANIFEST_VERSION,
  referenceCoverage: createReferenceCoverageManifest(),
  designContext: currentDesign(),
  pages: [{ sceneType: 'slide' as const, title: 'Evidence', designIntent: currentIntent() }],
});

describe('self-contained historical reference snapshots', () => {
  it('loads workspace, page intent and artifact metadata and materializes saved colors after the library has changed', () => {
    const savedOutline = parsePagedDeckOutlineValue({
      ...productionOutline(),
      id: 'outline',
      designContext: historicalDesign(),
      pages: [
        {
          id: 'p',
          order: 1,
          sceneType: 'slide',
          title: 'Evidence',
          designIntent: historicalIntent(),
        },
      ],
    });
    let workspace = createGenerationWorkspace({
      runId: 'r',
      documentId: 'd',
      source: 'Teaching',
      lessonPlan,
      pagedOutline: savedOutline,
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'p');
    const artifact = artifactFor(workspace, 'p');
    if (artifact.sceneType !== 'slide') throw new Error('Expected slide fixture');
    const metadata = {
      ...slideMetadata('p'),
      layoutReferences: [],
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      designContext: historicalDesign(),
      designIntent: historicalIntent(),
    };
    artifact.generationMetadata = parseSlideGenerationMetadataValue(metadata);
    workspace = landSceneArtifact(workspace, artifact);
    const restored = parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(restored.pagedOutline?.designContext).toEqual(historicalDesign());
    expect(restored.pagedOutline?.pages[0]?.designIntent).toEqual(historicalIntent());
    expect(restored.sceneArtifacts.p).toMatchObject({ generationMetadata: metadata });
    const document = assembleReachDeckDocument(restored, { generatedAt: NOW });
    expect(document.theme).toMatchObject(historicalDesign().resolvedColors);
    expect(document.resources.themes.some((theme) => theme.colors.accent === '#006699')).toBe(true);
    expect(resolveDeckDesignTheme(undefined, historicalDesign()).background).toBe('#FAFCFF');
  });

  it('keeps current-library retrieval an explicit guarded operation', () => {
    expect(parseStoredReachDeckDesignContextValue(historicalDesign())).toEqual(historicalDesign());
    expect(parseStoredReachDeckPageDesignIntentValue(historicalIntent())).toEqual(
      historicalIntent(),
    );
    expect(isCurrentReferenceLibrary(historicalDesign())).toBe(false);
    expect(() => assertCurrentReferenceLibrary(historicalDesign())).toThrow();
    expect(() => parseReachDeckDesignContextValue(historicalDesign())).toThrow();
    expect(isCurrentReferenceLibrary(currentDesign())).toBe(true);
    expect(() => assertCurrentReferenceLibrary(currentDesign())).not.toThrow();
  });

  it.each([
    { libraryVersion: '' },
    { librarySha256: 'not-a-hash' },
    { schemaVersion: 'unknown' },
    { paletteReferenceId: ' ' },
    { imageStyleReferenceIds: ['duplicate', 'duplicate'] },
    { resolvedColors: { ...currentDesign().resolvedColors, ink: 'red' } },
  ])('rejects malformed saved snapshot shapes: %j', (patch) => {
    expect(() =>
      parseStoredReachDeckDesignContextValue({ ...historicalDesign(), ...patch }),
    ).toThrow();
  });

  it('accepts only the current complete production protocol', () => {
    expect(parseProductionGeneratedPagedDeckOutlineValue(productionOutline())).toEqual(
      productionOutline(),
    );
    expect(() =>
      parseProductionGeneratedPagedDeckOutlineValue({
        ...productionOutline(),
        designContext: historicalDesign(),
      }),
    ).toThrow();
    const missingSource = productionOutline();
    delete missingSource.referenceCoverage.references[0]!.source;
    expect(() => parseProductionGeneratedPagedDeckOutlineValue(missingSource)).toThrow();
  });

  it.each([
    'palette',
    'image-style',
    'layout',
    'component',
    'page-image-style',
    'wrong-category',
  ] as const)('rejects unknown or wrong-category %s IDs in new production', (category) => {
    const value = productionOutline();
    if (category === 'palette') value.designContext.paletteReferenceId = 'unknown-palette';
    else if (category === 'image-style')
      value.designContext.imageStyleReferenceIds = ['unknown-image-style'];
    else if (category === 'layout')
      value.pages[0]!.designIntent.layoutReferenceIds = ['unknown-layout'];
    else if (category === 'component')
      value.pages[0]!.designIntent.componentReferenceIds = ['unknown-component'];
    else if (category === 'page-image-style')
      value.pages[0]!.designIntent.imageStyleReferenceIds = ['unknown-image-style'];
    else value.pages[0]!.designIntent.layoutReferenceIds = [REFERENCE_LIBRARY.components[0]!.id];
    expect(() => parseProductionGeneratedPagedDeckOutlineValue(value)).toThrow();
  });
});
