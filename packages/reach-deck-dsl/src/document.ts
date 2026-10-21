import { parseInteractiveSceneValue, type InteractiveScene } from './interactiveScene.js';
import { parseQuizSceneValue, type QuizScene } from './quizScene.js';
import { parseReachDeckNativeSlideV2 } from './nativeV2Validation.js';
import { REACH_DECK_STATIC_SLIDE_DURATION_SECONDS } from './playbackV2.js';
import type {
  ReachDeckElementStyleV2,
  ReachDeckFillV2,
  ReachDeckNativeElementV2,
  ReachDeckNativeSlideV2,
} from './nativeV2.js';
import type { DeckRevision, DeckTheme } from './types.js';
import { parseReachDeckMediaOrigin, type ReachDeckMediaOrigin } from './mediaOrigin.js';

export type ReachDeckSceneType = 'slide' | 'quiz' | 'interactive';

export interface ReachDeckPublishedSlidePage {
  pageId: string;
  order: number;
  revision: number;
  sceneType: 'slide';
  title: string;
}

export type ReachDeckPublishedPage =
  | ReachDeckPublishedSlidePage
  | ReachDeckPublishedScenePage<'quiz', QuizScene>
  | ReachDeckPublishedScenePage<'interactive', InteractiveScene>;

export interface ReachDeckPublishedScenePage<SceneType extends ReachDeckSceneType, Scene> {
  pageId: string;
  order: number;
  revision: number;
  sceneType: SceneType;
  title: string;
  scene: Scene;
}

export interface ReachDeckDocumentMetadataV2 {
  source: 'api' | 'editor' | 'migration' | 'import';
  language: string;
  generatedAt: string;
  contentDigest: string;
}

export interface ReachDeckStageV2 {
  width: number;
  height: number;
  aspectRatio: `${number}:${number}`;
}

export const MAX_REACH_DECK_STAGE_DIMENSION = 100_000;

export interface ReachDeckThemeResourceV2 {
  id: string;
  name: string;
  colors: Readonly<Record<string, string>>;
  fonts: {
    display: string;
    body: string;
  };
}

export interface ReachDeckMasterResourceV2 {
  id: string;
  name: string;
  themeId: string;
}

export interface ReachDeckLayoutResourceV2 {
  id: string;
  name: string;
  masterId: string;
}

export interface ReachDeckMediaResourceV2 {
  id: string;
  objectKey: string;
  contentType: string;
  digest: string;
  origin?: ReachDeckMediaOrigin;
}

export interface ReachDeckResourcesV2 {
  themes: ReachDeckThemeResourceV2[];
  masters: ReachDeckMasterResourceV2[];
  layouts: ReachDeckLayoutResourceV2[];
  media: ReachDeckMediaResourceV2[];
}

export interface ReachDeckNativeSlideBindingV2 {
  pageId: string;
  slide: ReachDeckNativeSlideV2;
}

export type ReachDeckImportModeV2 = 'create' | 'insert-after' | 'before-first';

export interface ReachDeckInsertedResourceIdsV2 {
  themeIds: string[];
  masterIds: string[];
  layoutIds: string[];
  mediaIds: string[];
}

/**
 * Durable exactly-once marker for one confirmed external import application.
 *
 * The record remains in the document even if an editor later removes an imported page or an
 * unreferenced resource. This lets an apply service distinguish a lost-response retry from a new
 * request without relying on transient server state.
 */
export interface ReachDeckImportApplicationV2 {
  applicationId: string;
  requestFingerprint: string;
  sourceDigest: string;
  candidateDigest: string;
  profileDigest: string;
  mediaDigest: string;
  mode: ReachDeckImportModeV2;
  anchorPageId?: string;
  insertedPageIds: string[];
  insertedResourceIds: ReachDeckInsertedResourceIdsV2;
}

export interface ReachDeckDocumentV2 {
  schemaVersion: 'reach-deck-document/v2';
  id: string;
  title: string;
  stage: ReachDeckStageV2;
  /** Document-level theme used by native slide rendering and non-slide scenes. */
  theme: DeckTheme;
  defaultThemeId: string;
  resources: ReachDeckResourcesV2;
  metadata: ReachDeckDocumentMetadataV2;
  provenance?: {
    source: 'pptx' | 'maic';
    sourceDigest: string;
    importerVersion?: string;
  };
  revisions: DeckRevision[];
  /** Non-slide pages retain their scene payload; slide pages are native-only. */
  pages: ReachDeckPublishedPage[];
  /** Native editable slide payloads are the sole persisted slide authority. */
  nativeSlides: ReachDeckNativeSlideBindingV2[];
  /** Append-only exactly-once import history for native v2 imports. */
  importApplications?: ReachDeckImportApplicationV2[];
}

export type ReachDeckDocument = ReachDeckDocumentV2;

/** Create the smallest valid first-party document for a newly authored module. */
export function createBlankReachDeckDocument(input: {
  id: string;
  title: string;
  generatedAt?: string;
}): ReachDeckDocumentV2 {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: input.id,
    title: input.title,
    stage: { width: 1600, height: 900, aspectRatio: '16:9' },
    theme: {
      name: 'Reach',
      background: '#ffffff',
      surface: '#f8fafc',
      ink: '#172024',
      muted: '#647178',
      accent: '#2563eb',
      success: '#15803d',
      warning: '#b45309',
      fontDisplay: 'Inter',
      fontBody: 'Inter',
    },
    defaultThemeId: 'reach-default-theme',
    resources: {
      themes: [
        {
          id: 'reach-default-theme',
          name: 'Reach',
          colors: {
            background: '#ffffff',
            surface: '#f8fafc',
            ink: '#172024',
            muted: '#647178',
            accent: '#2563eb',
            success: '#15803d',
            warning: '#b45309',
          },
          fonts: { display: 'Inter', body: 'Inter' },
        },
      ],
      masters: [],
      layouts: [],
      media: [],
    },
    metadata: {
      source: 'editor',
      language: 'zh-CN',
      generatedAt,
      contentDigest: 'draft:blank:v2',
    },
    revisions: [],
    pages: [
      {
        pageId: `${input.id}:page-1`,
        order: 1,
        revision: 1,
        sceneType: 'slide',
        title: input.title,
      },
    ],
    // Slide pages are native-only in the v2 persisted contract: the page keeps
    // identity/order metadata while the complete slide payload lives in the
    // required native binding below.
    nativeSlides: [
      {
        pageId: `${input.id}:page-1`,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `blank:${input.id}:page-1`,
          title: input.title,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
          elements: [],
          animations: [],
          duration: REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
        },
      },
    ],
  });
}

export function parseReachDeckDocumentV2(value: unknown): ReachDeckDocumentV2 {
  const document = readRecord(value, 'Reach Deck document');
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error('Reach Deck document must use schemaVersion reach-deck-document/v2.');
  }
  assertExactKeys(
    document,
    [
      'schemaVersion',
      'id',
      'title',
      'stage',
      'theme',
      'defaultThemeId',
      'resources',
      'metadata',
      'provenance',
      'revisions',
      'pages',
      'nativeSlides',
      'importApplications',
    ],
    'Reach Deck v2 document',
  );

  const id = readNonEmptyString(document.id, 'document.id');
  const title = readNonEmptyString(document.title, 'document.title');
  const stage = parseStageV2(document.stage);
  const themeValue = readRecord(document.theme, 'document.theme');
  assertExactKeys(
    themeValue,
    [
      'name',
      'background',
      'surface',
      'ink',
      'muted',
      'accent',
      'success',
      'warning',
      'fontDisplay',
      'fontBody',
    ],
    'document.theme',
  );
  const theme = parseTheme(themeValue);
  const resources = parseResourcesV2(document.resources);
  const defaultThemeId = readNonEmptyString(document.defaultThemeId, 'document.defaultThemeId');
  if (!resources.themes.some((resource) => resource.id === defaultThemeId)) {
    throw new Error('document.defaultThemeId must reference a v2 theme resource.');
  }
  assertResourceReferencesV2(resources);
  const metadata = parseMetadataV2(document.metadata);
  const provenance = parseProvenanceV2(document.provenance);
  const revisions = parseRevisions(document.revisions);
  const rawPages = readArray(document.pages, 'document.pages');
  // Zero-page documents are valid durable authoring drafts, but cannot be played or published.
  const pages = rawPages.map(parsePublishedPage);
  assertUniqueValues(
    pages.map((page) => page.pageId),
    'page ids',
  );
  assertUniqueValues(
    pages.map((page) => page.order),
    'page orders',
  );
  const sceneIds = pages.flatMap((page) => (page.sceneType === 'slide' ? [] : [page.scene.id]));
  assertUniqueValues(sceneIds, 'scene ids');
  assertSequentialOrders(pages);
  assertInteractiveNarrationMediaReferencesV2(pages, resources);
  // `nativeSlides` is required and must contain exactly one binding for every
  // slide page.  Missing bindings are an invalid v2 document (no v1 fallback
  // or deterministic conversion is attempted).
  const nativeSlides = parseNativeSlideBindingsV2(document.nativeSlides, pages, resources);
  assertNativeSlideBindingsV2(pages, nativeSlides);
  const importApplications =
    document.importApplications === undefined
      ? undefined
      : parseImportApplicationsV2(document.importApplications);

  return {
    schemaVersion: 'reach-deck-document/v2',
    id,
    title,
    stage,
    theme,
    defaultThemeId,
    resources,
    metadata,
    ...(provenance ? { provenance } : {}),
    revisions,
    pages,
    nativeSlides,
    ...(importApplications === undefined ? {} : { importApplications }),
  };
}

export function parseReachDeckDocument(value: unknown): ReachDeckDocumentV2 {
  const document = readRecord(value, 'Reach Deck document');
  switch (document.schemaVersion) {
    case 'reach-deck-document/v1':
      throw new Error('Legacy Reach Deck documents are not supported.');
    case 'reach-deck-document/v2':
      return parseReachDeckDocumentV2(document);
    default:
      throw new Error('Reach Deck document must use schemaVersion reach-deck-document/v2.');
  }
}

export function normalizeReachDeckDocumentV2(value: unknown): ReachDeckDocumentV2 {
  return parseReachDeckDocumentV2(value);
}

export function isReachDeckDocument(value: unknown): value is ReachDeckDocumentV2 {
  try {
    parseReachDeckDocument(value);
    return true;
  } catch {
    return false;
  }
}

/** True when slides are native-v2 bound and any Interactive narration has complete audio. */
export function isReachDeckDocumentReadyForPlayback(
  document: ReachDeckDocument,
): document is ReachDeckDocumentV2 {
  if (document.schemaVersion !== 'reach-deck-document/v2' || document.pages.length === 0)
    return false;
  const bindingCounts = new Map<string, number>();
  for (const binding of document.nativeSlides) {
    bindingCounts.set(binding.pageId, (bindingCounts.get(binding.pageId) ?? 0) + 1);
  }
  return document.pages.every((page) => {
    if (page.sceneType === 'interactive') {
      return (
        page.scene.narration === undefined || page.scene.narration.audioResourceId !== undefined
      );
    }
    if (page.sceneType !== 'slide') return true;
    if (bindingCounts.get(page.pageId) !== 1) return false;
    const binding = document.nativeSlides.find((candidate) => candidate.pageId === page.pageId);
    // Partial-generation placeholders are valid editor projections but must never be trialled
    // or published until the corresponding page has a real generated artifact.
    return !binding?.slide.id.startsWith('generation-placeholder:');
  });
}

export function assertReachDeckDocumentReadyForPlayback(
  document: ReachDeckDocument,
): asserts document is ReachDeckDocumentV2 {
  if (!isReachDeckDocumentReadyForPlayback(document)) {
    throw new Error(
      'Reach Deck trial and publication require complete slide and Interactive narration media.',
    );
  }
}

/**
 * Validate one durable write against the document currently stored.
 *
 * Page order may change without resetting learner runtime, but authored page
 * content must advance exactly one revision per write. New pages always start
 * at revision one, and immutable revision history can only be appended.
 */
export function assertReachDeckDocumentTransition(
  previousValue: unknown,
  nextValue: unknown,
): ReachDeckDocumentV2 {
  const previous = parseReachDeckDocument(previousValue);
  const next = parseReachDeckDocument(nextValue);
  if (previous.id !== next.id) {
    throw new Error('Reach Deck document identity cannot change between revisions.');
  }
  if (next.revisions.length < previous.revisions.length) {
    throw new Error('Reach Deck revision history cannot be removed.');
  }
  previous.revisions.forEach((revision, index) => {
    if (!valuesEqual(revision, next.revisions[index])) {
      throw new Error('Reach Deck revision history is immutable and append-only.');
    }
  });

  const previousPages = new Map(previous.pages.map((page) => [page.pageId, page]));
  next.pages.forEach((page) => {
    const previousPage = previousPages.get(page.pageId);
    if (previousPage === undefined) {
      if (page.revision !== 1) {
        throw new Error(`New Reach Deck page ${page.pageId} must start at revision 1.`);
      }
      return;
    }
    if (page.revision < previousPage.revision) {
      throw new Error(`Reach Deck page ${page.pageId} has a stale revision.`);
    }
    if (page.revision > previousPage.revision + 1) {
      throw new Error(`Reach Deck page ${page.pageId} skipped a revision.`);
    }
    const contentChanged =
      page.title !== previousPage.title ||
      page.sceneType !== previousPage.sceneType ||
      (page.sceneType !== 'slide' &&
        previousPage.sceneType !== 'slide' &&
        !valuesEqual(page.scene, previousPage.scene));
    if (contentChanged && page.revision === previousPage.revision) {
      throw new Error(`Reach Deck page ${page.pageId} changed without increasing its revision.`);
    }
  });
  {
    const previousApplications = previous.importApplications ?? [];
    const nextApplications = next.importApplications ?? [];
    if (nextApplications.length < previousApplications.length) {
      throw new Error('Reach Deck import application history cannot be removed.');
    }
    previousApplications.forEach((application, index) => {
      if (!valuesEqual(application, nextApplications[index])) {
        throw new Error('Reach Deck import application history is immutable and append-only.');
      }
    });
    const previousNative = new Map(
      previous.nativeSlides.map((binding) => [binding.pageId, binding.slide]),
    );
    const nextNative = new Map(next.nativeSlides.map((binding) => [binding.pageId, binding.slide]));
    for (const pageId of new Set([...previousNative.keys(), ...nextNative.keys()])) {
      if (valuesEqual(previousNative.get(pageId), nextNative.get(pageId))) continue;
      const previousPage = previousPages.get(pageId);
      const nextPage = next.pages.find((page) => page.pageId === pageId);
      if (previousPage && nextPage?.revision === previousPage.revision) {
        throw new Error(
          `Reach Deck native slide ${pageId} changed without increasing its revision.`,
        );
      }
    }
  }
  return next;
}

/** Parse and validate one published page (server-side page-level write entry point). */
export function parseReachDeckPublishedPage(value: unknown): ReachDeckPublishedPage {
  return parsePublishedPage(value);
}

/** Page content equality: compares title/sceneType/scene, ignoring revision/order. */
export function reachDeckPageContentEqual(
  left: ReachDeckPublishedPage,
  right: ReachDeckPublishedPage,
): boolean {
  return (
    left.title === right.title &&
    left.sceneType === right.sceneType &&
    (left.sceneType === 'slide' ||
      (right.sceneType !== 'slide' && valuesEqual(left.scene, right.scene)))
  );
}

/**
 * Write one page's content into the document. The revision is stamped from the
 * stored document (content change = current revision + 1) and the stored order
 * is preserved. Equal content returns the original references so callers can
 * skip persistence. The incoming page is normalized through the page parser
 * before comparison, so legacy input shapes never mint phantom revisions, and
 * the returned page is always the persisted copy inside the returned document.
 *
 * Inserting new pages is intentionally unsupported here: page creation goes
 * through the outline/begin flow, not this primitive.
 */
export function upsertReachDeckDocumentPage(
  document: ReachDeckDocument,
  page: ReachDeckPublishedPage,
): { document: ReachDeckDocument; page: ReachDeckPublishedPage; changed: boolean } {
  const current = document.pages.find((candidate) => candidate.pageId === page.pageId);
  if (current === undefined) {
    throw new Error(`Reach Deck page ${page.pageId} does not exist in the document.`);
  }
  if (current.sceneType !== page.sceneType) {
    throw new Error(`Reach Deck page ${page.pageId} cannot change its scene type.`);
  }
  const incoming = parseReachDeckPublishedPage(page);
  if (reachDeckPageContentEqual(current, incoming)) {
    return { document, page: current, changed: false };
  }
  const nextDocument = parseReachDeckDocument({
    ...document,
    pages: document.pages.map((candidate) =>
      candidate.pageId === incoming.pageId
        ? { ...incoming, order: current.order, revision: current.revision + 1 }
        : candidate,
    ),
  });
  const nextPage = nextDocument.pages.find((candidate) => candidate.pageId === incoming.pageId);
  if (nextPage === undefined) {
    throw new Error(`Reach Deck page ${incoming.pageId} was lost while re-parsing the document.`);
  }
  return { document: nextDocument, page: nextPage, changed: true };
}

function parsePublishedPage(value: unknown): ReachDeckPublishedPage {
  const page = readRecord(value, 'Reach Deck page');
  const baseKeys = ['pageId', 'order', 'revision', 'sceneType', 'title'];
  const pageId = readNonEmptyString(page.pageId, 'page.pageId');
  const title = readNonEmptyString(page.title, 'page.title');
  const order = readPositiveInteger(page.order, 'page.order');
  const revision = readPositiveInteger(page.revision, 'page.revision');

  switch (page.sceneType) {
    case 'slide':
      assertExactKeys(page, baseKeys, 'Reach Deck slide page');
      return {
        pageId,
        title,
        order,
        revision,
        sceneType: 'slide',
      };
    case 'quiz':
      assertExactKeys(page, [...baseKeys, 'scene'], 'Reach Deck quiz page');
      return {
        pageId,
        title,
        order,
        revision,
        sceneType: 'quiz',
        scene: parseQuizSceneValue(page.scene, pageId),
      };
    case 'interactive':
      assertExactKeys(page, [...baseKeys, 'scene'], 'Reach Deck interactive page');
      return {
        pageId,
        title,
        order,
        revision,
        sceneType: 'interactive',
        scene: parseInteractiveSceneValue(page.scene, pageId),
      };
    default:
      throw new Error('Reach Deck page has an unsupported sceneType.');
  }
}

function greatestCommonDivisor(left: number, right: number): number {
  let first = Math.abs(left);
  let second = Math.abs(right);
  while (second !== 0) {
    const remainder = first % second;
    first = second;
    second = remainder;
  }
  return first;
}

function parseStageV2(value: unknown): ReachDeckStageV2 {
  const stage = readRecord(value, 'document.stage');
  assertExactKeys(stage, ['width', 'height', 'aspectRatio'], 'document.stage');
  const width = readPositiveSafeInteger(stage.width, 'stage.width');
  const height = readPositiveSafeInteger(stage.height, 'stage.height');
  if (width > MAX_REACH_DECK_STAGE_DIMENSION || height > MAX_REACH_DECK_STAGE_DIMENSION) {
    throw new Error(
      `Reach Deck v2 stage dimensions cannot exceed ${MAX_REACH_DECK_STAGE_DIMENSION}.`,
    );
  }
  const divisor = greatestCommonDivisor(width, height);
  const expectedAspectRatio = `${width / divisor}:${height / divisor}` as const;
  if (stage.aspectRatio !== expectedAspectRatio) {
    throw new Error(`document.stage.aspectRatio must be ${expectedAspectRatio}.`);
  }
  return { width, height, aspectRatio: expectedAspectRatio };
}

function parseTheme(value: unknown): DeckTheme {
  const theme = readRecord(value, 'document.theme');
  return {
    name: readNonEmptyString(theme.name, 'theme.name'),
    background: readNonEmptyString(theme.background, 'theme.background'),
    surface: readNonEmptyString(theme.surface, 'theme.surface'),
    ink: readNonEmptyString(theme.ink, 'theme.ink'),
    muted: readNonEmptyString(theme.muted, 'theme.muted'),
    accent: readNonEmptyString(theme.accent, 'theme.accent'),
    success: readNonEmptyString(theme.success, 'theme.success'),
    warning: readNonEmptyString(theme.warning, 'theme.warning'),
    fontDisplay: readNonEmptyString(theme.fontDisplay, 'theme.fontDisplay'),
    fontBody: readNonEmptyString(theme.fontBody, 'theme.fontBody'),
  };
}

function parseMetadataV2(value: unknown): ReachDeckDocumentV2['metadata'] {
  const metadata = readRecord(value, 'document.metadata');
  assertExactKeys(
    metadata,
    ['source', 'language', 'generatedAt', 'contentDigest'],
    'document.metadata',
  );
  if (
    metadata.source !== 'api' &&
    metadata.source !== 'editor' &&
    metadata.source !== 'migration' &&
    metadata.source !== 'import'
  ) {
    throw new Error('document.metadata.source is invalid.');
  }
  return {
    source: metadata.source,
    language: readNonEmptyString(metadata.language, 'metadata.language'),
    generatedAt: readNonEmptyString(metadata.generatedAt, 'metadata.generatedAt'),
    contentDigest: readNonEmptyString(metadata.contentDigest, 'metadata.contentDigest'),
  };
}

function parseProvenanceV2(value: unknown): ReachDeckDocumentV2['provenance'] {
  if (value === undefined) return undefined;
  const provenance = readRecord(value, 'document.provenance');
  assertExactKeys(provenance, ['source', 'sourceDigest', 'importerVersion'], 'document.provenance');
  if (provenance.source !== 'pptx' && provenance.source !== 'maic') {
    throw new Error('document.provenance.source is invalid.');
  }
  return {
    source: provenance.source,
    sourceDigest: readNonEmptyString(provenance.sourceDigest, 'provenance.sourceDigest'),
    ...(provenance.importerVersion === undefined
      ? {}
      : {
          importerVersion: readNonEmptyString(
            provenance.importerVersion,
            'provenance.importerVersion',
          ),
        }),
  };
}

/** Strict parser for one document-level v2 media resource entry. */
export function parseReachDeckMediaResourceV2(value: unknown): ReachDeckMediaResourceV2 {
  const resource = readRecord(value, 'media resource');
  assertExactKeys(
    resource,
    ['id', 'objectKey', 'contentType', 'digest', 'origin'],
    'media resource',
  );
  return {
    id: readNonEmptyString(resource.id, 'media resource id'),
    objectKey: readNonEmptyString(resource.objectKey, 'media resource objectKey'),
    contentType: readNonEmptyString(resource.contentType, 'media resource contentType'),
    digest: readNonEmptyString(resource.digest, 'media resource digest'),
    ...(resource.origin === undefined
      ? {}
      : { origin: parseReachDeckMediaOrigin(resource.origin) }),
  };
}

export function parseResourcesV2(value: unknown): ReachDeckResourcesV2 {
  const resources = readRecord(value, 'document.resources');
  assertExactKeys(resources, ['themes', 'masters', 'layouts', 'media'], 'document.resources');
  const themes = readArray(resources.themes, 'resources.themes').map((item) => {
    const theme = readRecord(item, 'theme resource');
    assertExactKeys(theme, ['id', 'name', 'colors', 'fonts'], 'theme resource');
    const colors = readStringRecord(theme.colors, 'theme resource colors');
    if (Object.keys(colors).length === 0) {
      throw new Error('Reach Deck v2 theme resource colors cannot be empty.');
    }
    const fonts = readRecord(theme.fonts, 'theme resource fonts');
    assertExactKeys(fonts, ['display', 'body'], 'theme resource fonts');
    return {
      id: readNonEmptyString(theme.id, 'theme resource id'),
      name: readNonEmptyString(theme.name, 'theme resource name'),
      colors,
      fonts: {
        display: readNonEmptyString(fonts.display, 'theme resource display font'),
        body: readNonEmptyString(fonts.body, 'theme resource body font'),
      },
    };
  });
  if (themes.length === 0) throw new Error('Reach Deck v2 requires at least one theme resource.');

  const masters = readArray(resources.masters, 'resources.masters').map((item) => {
    const master = readRecord(item, 'master resource');
    assertExactKeys(master, ['id', 'name', 'themeId'], 'master resource');
    return {
      id: readNonEmptyString(master.id, 'master resource id'),
      name: readNonEmptyString(master.name, 'master resource name'),
      themeId: readNonEmptyString(master.themeId, 'master resource themeId'),
    };
  });
  const layouts = readArray(resources.layouts, 'resources.layouts').map((item) => {
    const layout = readRecord(item, 'layout resource');
    assertExactKeys(layout, ['id', 'name', 'masterId'], 'layout resource');
    return {
      id: readNonEmptyString(layout.id, 'layout resource id'),
      name: readNonEmptyString(layout.name, 'layout resource name'),
      masterId: readNonEmptyString(layout.masterId, 'layout resource masterId'),
    };
  });
  const media = readArray(resources.media, 'resources.media').map(parseReachDeckMediaResourceV2);

  assertUniqueValues(
    themes.map((resource) => resource.id),
    'theme ids',
  );
  assertUniqueValues(
    masters.map((resource) => resource.id),
    'master ids',
  );
  assertUniqueValues(
    layouts.map((resource) => resource.id),
    'layout ids',
  );
  assertUniqueValues(
    media.map((resource) => resource.id),
    'media resource ids',
  );
  return { themes, masters, layouts, media };
}

function assertResourceReferencesV2(resources: ReachDeckResourcesV2): void {
  const themeIds = new Set(resources.themes.map((resource) => resource.id));
  const masterIds = new Set(resources.masters.map((resource) => resource.id));
  for (const master of resources.masters) {
    if (!themeIds.has(master.themeId)) {
      throw new Error(`Reach Deck v2 master ${master.id} references an unknown themeId.`);
    }
  }
  for (const layout of resources.layouts) {
    if (!masterIds.has(layout.masterId)) {
      throw new Error(`Reach Deck v2 layout ${layout.id} references an unknown masterId.`);
    }
  }
}

function assertInteractiveNarrationMediaReferencesV2(
  pages: ReachDeckPublishedPage[],
  resources: ReachDeckResourcesV2,
): void {
  const mediaById = new Map(resources.media.map((resource) => [resource.id, resource] as const));
  for (const page of pages) {
    if (page.sceneType !== 'interactive' || page.scene.narration?.audioResourceId === undefined) {
      continue;
    }
    const resourceId = page.scene.narration.audioResourceId;
    const resource = mediaById.get(resourceId);
    if (resource === undefined) {
      throw new Error(
        `Reach Deck interactive scene ${page.scene.id} references unknown media resource ${resourceId}.`,
      );
    }
    if (!resource.contentType.toLowerCase().startsWith('audio/')) {
      throw new Error(
        `Reach Deck interactive scene ${page.scene.id} narration media resource ${resourceId} must have an audio contentType.`,
      );
    }
  }
}

function parseNativeSlideBindingsV2(
  value: unknown,
  pages: ReachDeckPublishedPage[],
  resources: ReachDeckResourcesV2,
): ReachDeckNativeSlideBindingV2[] {
  const pageIds = new Set(pages.map((page) => page.pageId));
  const layoutIds = new Set(resources.layouts.map((layout) => layout.id));
  const mediaIds = new Set(resources.media.map((media) => media.id));
  const mediaById = new Map(resources.media.map((media) => [media.id, media] as const));
  const bindings = readArray(value, 'document.nativeSlides').map((item, index) => {
    const binding = readRecord(item, `document.nativeSlides[${index}]`);
    assertExactKeys(binding, ['pageId', 'slide'], `document.nativeSlides[${index}]`);
    const pageId = readNonEmptyString(binding.pageId, `document.nativeSlides[${index}].pageId`);
    if (!pageIds.has(pageId)) {
      throw new Error(`Reach Deck native slide binding references unknown pageId ${pageId}.`);
    }
    const slide = parseReachDeckNativeSlideV2(binding.slide);
    if (slide.layoutId !== undefined && !layoutIds.has(slide.layoutId)) {
      throw new Error(`Reach Deck native slide ${slide.id} references an unknown layoutId.`);
    }
    const referencedMedia = new Set<string>();
    collectFillMediaReferences(slide.background, referencedMedia);
    slide.elements.forEach((element) => collectElementMediaReferences(element, referencedMedia));
    if (slide.narration?.audioResourceId !== undefined) {
      referencedMedia.add(slide.narration.audioResourceId);
    }
    for (const resourceId of referencedMedia) {
      if (!mediaIds.has(resourceId)) {
        throw new Error(
          `Reach Deck native slide ${slide.id} references unknown media resource ${resourceId}.`,
        );
      }
    }
    return { pageId, slide };
  });
  assertUniqueValues(
    bindings.map((binding) => binding.pageId),
    'native slide page bindings',
  );
  assertUniqueValues(
    bindings.map((binding) => binding.slide.id),
    'native slide ids',
  );
  return bindings;
}

function assertNativeSlideBindingsV2(
  pages: ReachDeckPublishedPage[],
  bindings: ReachDeckNativeSlideBindingV2[],
): void {
  const pagesById = new Map(pages.map((page) => [page.pageId, page]));
  const boundPageIds = new Set(bindings.map((binding) => binding.pageId));
  for (const binding of bindings) {
    if (pagesById.get(binding.pageId)?.sceneType !== 'slide') {
      throw new Error(
        `Reach Deck native slide binding ${binding.pageId} must reference a slide page.`,
      );
    }
  }
  for (const page of pages) {
    if (page.sceneType !== 'slide') {
      if (boundPageIds.has(page.pageId)) {
        throw new Error(
          `Reach Deck native slide binding ${page.pageId} must reference a slide page.`,
        );
      }
      continue;
    }
    if (!boundPageIds.has(page.pageId)) {
      throw new Error(`Reach Deck slide page ${page.pageId} must have exactly one native binding.`);
    }
  }
}

function parseImportApplicationsV2(value: unknown): ReachDeckImportApplicationV2[] {
  const applications = readArray(value, 'document.importApplications').map((item, index) => {
    const label = `document.importApplications[${index}]`;
    const application = readRecord(item, label);
    assertExactKeys(
      application,
      [
        'applicationId',
        'requestFingerprint',
        'sourceDigest',
        'candidateDigest',
        'profileDigest',
        'mediaDigest',
        'mode',
        'anchorPageId',
        'insertedPageIds',
        'insertedResourceIds',
      ],
      label,
    );
    const mode =
      application.mode === 'create'
        ? ('create' as const)
        : application.mode === 'insert-after'
          ? ('insert-after' as const)
          : application.mode === 'before-first'
            ? ('before-first' as const)
            : undefined;
    if (mode === undefined) {
      throw new Error(`${label}.mode must be create, insert-after, or before-first.`);
    }
    const anchorPageId =
      application.anchorPageId === undefined
        ? undefined
        : readNonEmptyString(application.anchorPageId, `${label}.anchorPageId`);
    if (mode !== 'insert-after' && anchorPageId !== undefined) {
      throw new Error(`${label}.anchorPageId must be omitted for ${mode} mode.`);
    }
    if (mode === 'insert-after' && anchorPageId === undefined) {
      throw new Error(`${label}.anchorPageId is required for insert-after mode.`);
    }

    const insertedPageIds = parseUniqueStringArray(
      application.insertedPageIds,
      `${label}.insertedPageIds`,
    );
    if (insertedPageIds.length === 0) {
      throw new Error(`${label}.insertedPageIds cannot be empty.`);
    }
    const resourceIds = readRecord(application.insertedResourceIds, `${label}.insertedResourceIds`);
    assertExactKeys(
      resourceIds,
      ['themeIds', 'masterIds', 'layoutIds', 'mediaIds'],
      `${label}.insertedResourceIds`,
    );

    return {
      applicationId: readNonEmptyString(application.applicationId, `${label}.applicationId`),
      requestFingerprint: readSha256Digest(
        application.requestFingerprint,
        `${label}.requestFingerprint`,
      ),
      sourceDigest: readSha256Digest(application.sourceDigest, `${label}.sourceDigest`),
      candidateDigest: readSha256Digest(application.candidateDigest, `${label}.candidateDigest`),
      profileDigest: readSha256Digest(application.profileDigest, `${label}.profileDigest`),
      mediaDigest: readSha256Digest(application.mediaDigest, `${label}.mediaDigest`),
      mode,
      ...(anchorPageId === undefined ? {} : { anchorPageId }),
      insertedPageIds,
      insertedResourceIds: {
        themeIds: parseUniqueStringArray(
          resourceIds.themeIds,
          `${label}.insertedResourceIds.themeIds`,
        ),
        masterIds: parseUniqueStringArray(
          resourceIds.masterIds,
          `${label}.insertedResourceIds.masterIds`,
        ),
        layoutIds: parseUniqueStringArray(
          resourceIds.layoutIds,
          `${label}.insertedResourceIds.layoutIds`,
        ),
        mediaIds: parseUniqueStringArray(
          resourceIds.mediaIds,
          `${label}.insertedResourceIds.mediaIds`,
        ),
      },
    };
  });
  assertUniqueValues(
    applications.map((application) => application.applicationId),
    'import application ids',
  );
  return applications;
}

function collectFillMediaReferences(fill: ReachDeckFillV2 | undefined, output: Set<string>): void {
  if (fill?.kind === 'image') output.add(fill.resourceId);
}

function collectStyleMediaReferences(
  style: ReachDeckElementStyleV2 | undefined,
  output: Set<string>,
): void {
  collectFillMediaReferences(style?.fill, output);
}

function collectElementMediaReferences(
  element: ReachDeckNativeElementV2,
  output: Set<string>,
): void {
  switch (element.type) {
    case 'shape':
    case 'textFrame':
      collectStyleMediaReferences(element.style, output);
      return;
    case 'line':
    case 'chart':
    case 'formula':
      return;
    case 'group':
      element.children.forEach((child) => collectElementMediaReferences(child, output));
      return;
    case 'image':
    case 'audio':
      output.add(element.resourceId);
      return;
    case 'video':
      output.add(element.resourceId);
      if (element.posterResourceId !== undefined) output.add(element.posterResourceId);
      return;
    case 'table':
      element.rows.forEach((row) =>
        row.cells.forEach((cell) => collectStyleMediaReferences(cell.style, output)),
      );
      return;
    case 'diagram':
      element.nodes.forEach((node) => collectStyleMediaReferences(node.style, output));
      return;
    case 'scientificVisual':
      element.manifest.resourceIds.forEach((resourceId) => output.add(resourceId));
      return;
  }
}

function parseRevisions(value: unknown): DeckRevision[] {
  const revisions = readArray(value, 'document.revisions').map((item) => {
    const revision = readRecord(item, 'document revision');
    if (revision.author !== 'ai' && revision.author !== 'editor') {
      throw new Error('document revision author is invalid.');
    }
    const author: DeckRevision['author'] = revision.author;
    return {
      id: readNonEmptyString(revision.id, 'revision.id'),
      label: readNonEmptyString(revision.label, 'revision.label'),
      author,
      createdAt: readNonEmptyString(revision.createdAt, 'revision.createdAt'),
      summary: readNonEmptyString(revision.summary, 'revision.summary'),
    };
  });
  assertUniqueValues(
    revisions.map((revision) => revision.id),
    'revision ids',
  );
  return revisions;
}

function assertSequentialOrders(pages: ReachDeckPublishedPage[]): void {
  const orders = pages.map((page) => page.order).sort((left, right) => left - right);
  if (orders.some((order, index) => order !== index + 1)) {
    throw new Error('Reach Deck page orders must be the sequence 1..n.');
  }
}

function assertUniqueValues(values: Array<string | number>, label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Reach Deck document contains duplicate ${label}.`);
  }
}

/** 结构化深比较（键序无关）；文档写入路径判定"内容是否真的变了"用它。 */
export function reachDeckValuesEqual(left: unknown, right: unknown): boolean {
  return valuesEqual(left, right);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function parseUniqueStringArray(value: unknown, label: string): string[] {
  const items = readArray(value, label).map((item, index) =>
    readNonEmptyString(item, `${label}[${index}]`),
  );
  assertUniqueValues(items, label);
  return items;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readSha256Digest(value: unknown, label: string): string {
  const digest = readNonEmptyString(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be a lowercase sha256 digest.`);
  }
  return digest;
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function readPositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function readStringRecord(value: unknown, label: string): Record<string, string> {
  const record = readRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key.trim().length === 0 || typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${label} must contain non-empty string keys and values.`);
    }
    result[key] = item;
  }
  return result;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknownKeys.sort().join(', ')}.`);
  }
}
