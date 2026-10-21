import { describe, expect, it } from 'vitest';
import { assembleReachDeckDocument, reconcileReachDeckDocumentPages } from '../src/deckAssembly.js';
import { createGenerationWorkspace, parseGenerationWorkspace } from '../src/generationWorkspace.js';
import { parseReachDeckDocument } from '../src/document.js';
import { parseReachDeckDesignContextValue } from '../src/generationTypes.js';
import { resolveDeckDesignTheme } from '../src/designTheme.js';
import { resolveDeckTheme } from '../src/deckThemes.js';
import { createThemeResource } from '../src/compileToNativeV2.js';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '../src/reference-library/index.js';
import {
  NOW,
  lessonPlan,
  outline,
  page,
  prepareForArtifact,
  artifactFor,
  landSceneArtifact,
} from './generationFixtures.js';

const design = () =>
  parseReachDeckDesignContextValue({
    schemaVersion: 'reach-deck-design-context/v1',
    libraryVersion: REFERENCE_LIBRARY_VERSION,
    librarySha256: REFERENCE_LIBRARY_SHA256,
    paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
    imageStyleReferenceIds: [],
    visualIntent: 'Calm teaching',
    resolvedColors: {
      background: '#F0F2F4',
      surface: '#FFFFFF',
      ink: '#111111',
      muted: '#555555',
      accent: '#006699',
      success: '#006600',
      warning: '#663300',
    },
  });
const setup = (reference = true) => {
  let workspace = createGenerationWorkspace({
    runId: 'r',
    documentId: 'd',
    source: 'Source',
    lessonPlan,
    pagedOutline: {
      ...outline([page('p', 1, 'slide')]),
      ...(reference ? { designContext: design() } : { themeName: 'deep-tech' }),
    },
    createdAt: NOW,
  });
  workspace = prepareForArtifact(workspace, 'p');
  workspace = landSceneArtifact(workspace, artifactFor(workspace, 'p'));
  return { workspace, document: assembleReachDeckDocument(workspace, { generatedAt: NOW }) };
};

describe('frozen reference design assembly and reconciliation', () => {
  it('saves and restores exact colors before and after no-op backfill', () => {
    const { workspace, document } = setup();
    const restoredWorkspace = parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace)));
    const restoredDocument = parseReachDeckDocument(JSON.parse(JSON.stringify(document)));
    const result = reconcileReachDeckDocumentPages(restoredDocument, restoredWorkspace, {
      landedPageIds: ['p'],
      generatedAt: NOW,
    });
    expect(result).toBe(restoredDocument);
    expect(result.theme).toEqual(resolveDeckDesignTheme(undefined, design()));
    expect(result.resources.themes.find((t) => t.id === result.defaultThemeId)).toEqual(
      createThemeResource(result.theme),
    );
  });
  it('rejects conflicting explicit assembly colors', () => {
    const { workspace } = setup();
    expect(() =>
      assembleReachDeckDocument(workspace, {
        generatedAt: NOW,
        theme: resolveDeckTheme('deep-tech'),
      }),
    ).toThrow(/saved reference design/);
  });
  it.each([{ landedPageIds: [] as string[] }, { landedPageIds: ['p'] }])(
    'rejects document theme drift even with landed pages %j',
    ({ landedPageIds }) => {
      const { workspace, document } = setup();
      const changed = { ...document, theme: { ...document.theme, ink: '#222222' } };
      expect(() =>
        reconcileReachDeckDocumentPages(changed, workspace, { landedPageIds, generatedAt: NOW }),
      ).toThrow(/saved reference design/);
    },
  );
  it('rejects independent default resource drift before retained bindings can mix colors', () => {
    const { workspace, document } = setup();
    const changed = structuredClone(document);
    changed.resources.themes = changed.resources.themes.map((theme) =>
      theme.id === changed.defaultThemeId
        ? { ...theme, colors: { ...theme.colors, ink: '#222222' } }
        : theme,
    );
    expect(() =>
      reconcileReachDeckDocumentPages(changed, workspace, { landedPageIds: [], generatedAt: NOW }),
    ).toThrow(/saved reference design/);
  });
  it('adopts the new frozen design when a regenerated outline replaces every page', () => {
    const { document } = setup();
    const redesign = parseReachDeckDesignContextValue({
      ...design(),
      paletteReferenceId: REFERENCE_LIBRARY.palettes[1]!.id,
      resolvedColors: { ...design().resolvedColors, ink: '#222222', accent: '#AA3355' },
    });
    const outlinePages = [page('q', 1, 'slide'), page('r', 2, 'slide')];
    let regenerated = createGenerationWorkspace({
      runId: 'r',
      documentId: 'd',
      source: 'Source',
      lessonPlan,
      pagedOutline: { ...outline(outlinePages), designContext: redesign },
      createdAt: NOW,
    });
    regenerated = prepareForArtifact(regenerated, 'q');
    regenerated = landSceneArtifact(regenerated, artifactFor(regenerated, 'q'));
    const frozen = resolveDeckDesignTheme(undefined, redesign);
    const result = reconcileReachDeckDocumentPages(document, regenerated, {
      landedPageIds: ['q'],
      generatedAt: NOW,
    });
    expect(result.pages.map((item) => item.pageId)).toEqual(['q', 'r']);
    expect(result.theme).toEqual(frozen);
    expect(result.resources.themes.find((t) => t.id === result.defaultThemeId)).toEqual(
      createThemeResource(frozen),
    );
    // 下一页落地时文档已是新设计，照常回填。
    regenerated = prepareForArtifact(regenerated, 'r');
    regenerated = landSceneArtifact(regenerated, artifactFor(regenerated, 'r'));
    expect(
      reconcileReachDeckDocumentPages(result, regenerated, {
        landedPageIds: ['r'],
        generatedAt: NOW,
      }).theme,
    ).toEqual(frozen);
  });
  // 未落地的同伴页会以 slide 占位编译、顺带登记主题；只有全部落地的互动/测验页时没有任何编译产物。
  it.each([
    { sceneType: 'interactive' as const, pageIds: ['q'] },
    { sceneType: 'quiz' as const, pageIds: ['q'] },
    { sceneType: 'quiz' as const, pageIds: ['q', 'r'] },
  ])(
    'registers the new frozen theme resource when a replacing $sceneType outline $pageIds has nothing to compile',
    ({ sceneType, pageIds }) => {
      const { document } = setup();
      const redesign = parseReachDeckDesignContextValue({
        ...design(),
        paletteReferenceId: REFERENCE_LIBRARY.palettes[1]!.id,
        resolvedColors: { ...design().resolvedColors, ink: '#222222', accent: '#AA3355' },
      });
      let regenerated = createGenerationWorkspace({
        runId: 'r',
        documentId: 'd',
        source: 'Source',
        lessonPlan,
        pagedOutline: {
          ...outline(pageIds.map((pageId, index) => page(pageId, index + 1, sceneType))),
          designContext: redesign,
        },
        createdAt: NOW,
      });
      for (const pageId of pageIds) {
        regenerated = prepareForArtifact(regenerated, pageId);
        regenerated = landSceneArtifact(regenerated, artifactFor(regenerated, pageId));
      }
      const frozen = resolveDeckDesignTheme(undefined, redesign);
      const result = reconcileReachDeckDocumentPages(document, regenerated, {
        landedPageIds: pageIds,
        generatedAt: NOW,
      });
      expect(result.theme).toEqual(frozen);
      expect(result.resources.themes.find((t) => t.id === result.defaultThemeId)).toEqual(
        createThemeResource(frozen),
      );
      // 再次回填（如晚到讲稿）不再被"保存的参考设计不可更改"拒绝。
      expect(
        reconcileReachDeckDocumentPages(result, regenerated, {
          landedPageIds: pageIds,
          generatedAt: NOW,
        }),
      ).toBe(result);
    },
  );
  it('still rejects a new design while an old page is retained', () => {
    const { workspace, document } = setup();
    const redesign = parseReachDeckDesignContextValue({
      ...design(),
      resolvedColors: { ...design().resolvedColors, ink: '#222222' },
    });
    const retained = parseGenerationWorkspace({
      ...JSON.parse(JSON.stringify(workspace)),
      pagedOutline: { ...workspace.pagedOutline!, designContext: redesign },
    });
    expect(() =>
      reconcileReachDeckDocumentPages(document, retained, { landedPageIds: [], generatedAt: NOW }),
    ).toThrow(/saved reference design/);
  });
  it('keeps historical themeName resolution and legacy no-op reconciliation unchanged', () => {
    const { workspace, document } = setup(false);
    expect(document.theme).toEqual(resolveDeckTheme('deep-tech'));
    expect(
      reconcileReachDeckDocumentPages(document, workspace, {
        landedPageIds: ['p'],
        generatedAt: NOW,
      }),
    ).toBe(document);
    const changed = { ...document, theme: { ...document.theme, ink: '#EEEEEE' } };
    expect(
      reconcileReachDeckDocumentPages(changed, workspace, { landedPageIds: [], generatedAt: NOW }),
    ).toBe(changed);
  });
});
