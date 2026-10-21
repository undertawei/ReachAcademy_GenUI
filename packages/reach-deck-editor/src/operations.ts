import {
  assertReachDeckDocumentTransition,
  isReachScientificAnchorBindingSetUsable,
  CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
  compileReachDeckSemanticTypographyV2,
  parseReachDeckDocument,
  parseReachDeckNativeSlideV2,
  preserveNativeSlideNarrationContentBaseline,
  reachDeckOrphanAnimationIds,
  REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
  richTextFromPlainText,
  richTextToPlainText,
  type ReachDeckDocument,
  type ReachDeckDocumentV2,
  type ReachDeckAnimationV2,
  type ReachDeckNativeElementV2,
  type ReachDeckNativeSlideV2,
  type ReachDeckElementStyleV2,
  type ReachDeckEffectsV2,
  type ReachDeckTextFrameV2,
  type ReachDeckPublishedPage,
  type ReachDeckSceneType,
  type RichTextDocument,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';
import { translateReachDeck, type ReachDeckTranslate } from '@reachany/reach-deck-player';
import type { ReachDeckElementsClipboard } from './elementClipboard.js';
import { isReachDeckElementsClipboardSelfContained } from './elementClipboardSafety.js';

export type ReachDeckIdFactory = (prefix: string) => string;

export interface ReachDeckNativeElementClipboard {
  documentId: string;
  element: ReachDeckNativeElementV2;
  animations: ReachDeckAnimationV2[];
}

export const REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME =
  'application/vnd.reachany.reach-deck-element+json';
export const REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION = 'reach-deck-element-clipboard/v1';
export const REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MAX_BYTES = 1_000_000;

interface ReachDeckNativeElementClipboardPayload extends ReachDeckNativeElementClipboard {
  version: typeof REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION;
}

export interface ReachDeckNativeElementPasteResult {
  document: ReachDeckDocument;
  elementId?: string;
}

export interface ReachDeckEmptyTextFrameResult {
  document: ReachDeckDocument;
  elementId?: string;
}

export interface ReachDeckClipboardTextFrameResult {
  document: ReachDeckDocument;
  elementId?: string;
}

/** Fill missing durable text attributes for content entered into a newly-created body text frame. */
export function applyReachDeckBodyTypographyDefaults(
  document: ReachDeckDocument,
  value: RichTextDocument,
): RichTextDocument {
  if (document.schemaVersion !== 'reach-deck-document/v2') return value;
  return compileReachDeckSemanticTypographyV2({ document, doc: value, role: 'body' });
}

export type ReachDeckAuthoringMediaKind = 'image' | 'audio' | 'video' | 'attachment';

export interface ReachDeckAuthoringMediaResource {
  kind: Exclude<ReachDeckAuthoringMediaKind, 'attachment'>;
  objectKey: string;
  contentType: string;
  digest: string;
  title: string;
}

export interface ReachDeckAuthoringMediaInsertionResult {
  document: ReachDeckDocument;
  elementId?: string;
  resourceId?: string;
}

const NATIVE_ELEMENT_PASTE_OFFSET = 24;
const EMPTY_TEXT_FRAME_WIDTH = 480;
const EMPTY_TEXT_FRAME_HEIGHT = 120;

export function createBlankReachDeckPage(input: {
  document: ReachDeckDocument;
  sceneType: ReachDeckSceneType;
  order: number;
  idFactory: ReachDeckIdFactory;
  locale?: string;
  translate?: ReachDeckTranslate;
}): ReachDeckPublishedPage {
  const pageId = input.idFactory('page');
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(input.translate, key, fallback, replacements);
  const title = text(
    `reachDeck.editor.default.pageTitle.${input.sceneType}`,
    blankPageTitles[input.sceneType],
  );

  switch (input.sceneType) {
    case 'slide': {
      // slide 页的内容模型统一为 v2 原生元素：壳保持空，真正的标题文本框
      // 放在 native slide 里（addReachDeckPage 负责为 v2 文档补上绑定）。
      return {
        pageId,
        order: input.order,
        revision: 1,
        sceneType: 'slide',
        title,
      } as ReachDeckPublishedPage;
    }
    case 'quiz':
      return createPageEnvelope(pageId, input.order, 'quiz', title, {
        schemaVersion: 'reach-quiz-scene/v1',
        id: pageId,
        title,
        sceneType: 'quiz',
        content: {
          questions: [
            {
              id: input.idFactory('question'),
              analysis: richTextFromPlainText(''),
              answer: [],
              cognitive_schema: richTextFromPlainText(''),
              has_answer: false,
              options: ['A', 'B', 'C', 'D'].map((value) => ({
                value,
                label: richTextFromPlainText(''),
              })),
              points: 10,
              question: richTextFromPlainText(
                text('reachDeck.editor.default.quizQuestion', '请输入题目'),
              ),
              question_index: 1,
              question_type: 'single_choice',
              sub_problems: [],
            },
          ],
          display_mode: 'single_question',
          navigation: 'horizontal',
          show_progress: true,
          show_question_index: true,
          answer_reveal: 'after_submit',
          allow_previous: true,
          allow_skip: false,
        },
      });
    case 'interactive':
      return createPageEnvelope(pageId, input.order, 'interactive', title, {
        schemaVersion: 'reach-interactive-scene/v2',
        id: pageId,
        title,
        sceneType: 'interactive',
        documentHtml: CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
        bridgeVersion: 'reach-interactive-bridge/v1',
        runtimeDependencies: [],
        runtimePolicy: {
          completionMode: 'none',
          allowReset: true,
          maximumDurationSeconds: null,
        },
        eventManifest: {
          schemaVersion: 'reach-interactive-event-manifest/v1',
          events: [],
        },
      });
    default:
      return assertNever(input.sceneType);
  }
}

export function createBlankSlidePage(input: {
  document: ReachDeckDocument;
  order: number;
  idFactory: ReachDeckIdFactory;
  locale?: string;
  translate?: ReachDeckTranslate;
}): ReachDeckPublishedPage {
  return createBlankReachDeckPage({ ...input, sceneType: 'slide' });
}

export type ReachDeckPageInsertionTarget =
  | { mode: 'before-first' }
  | { mode: 'insert-after'; afterPageId: string };

export function addReachDeckPage(
  document: ReachDeckDocument,
  input: {
    sceneType: ReachDeckSceneType;
    target?: ReachDeckPageInsertionTarget;
    /** @deprecated Use target so before-first cannot be confused with the append default. */
    afterPageId?: string;
    idFactory: ReachDeckIdFactory;
    locale?: string;
    translate?: ReachDeckTranslate;
  },
): ReachDeckDocument {
  const pages = sortedPages(document.pages);
  const uniqueIdFactory = createUniqueIdFactory(document, input.idFactory);
  const afterPageId =
    input.target?.mode === 'insert-after' ? input.target.afterPageId : input.afterPageId;
  const afterIndex =
    input.target?.mode === 'before-first'
      ? -1
      : afterPageId === undefined
        ? pages.length - 1
        : pages.findIndex((page) => page.pageId === afterPageId);
  if (input.target?.mode === 'insert-after' && afterIndex < 0) {
    throw new Error(`Reach Deck insertion anchor ${input.target.afterPageId} no longer exists.`);
  }
  const insertionIndex =
    input.target?.mode === 'before-first' ? 0 : afterIndex < 0 ? pages.length : afterIndex + 1;
  const page = createBlankReachDeckPage({
    document,
    sceneType: input.sceneType,
    order: insertionIndex + 1,
    idFactory: uniqueIdFactory,
    locale: input.locale,
    translate: input.translate,
  });
  pages.splice(insertionIndex, 0, page);
  const base = { ...document, pages: normalizePageOrders(pages) };
  if (input.sceneType !== 'slide' || base.schemaVersion !== 'reach-deck-document/v2') {
    return parseReachDeckDocument(base);
  }
  return parseReachDeckDocument({
    ...base,
    nativeSlides: [
      ...base.nativeSlides,
      {
        pageId: page.pageId,
        slide: createBlankNativeSlide(base, page.title, uniqueIdFactory),
      },
    ],
  });
}

/** 新建空白页的原生幻灯片：主题底色 + 一个可直接双击编辑的标题文本框。 */
function createBlankNativeSlide(
  document: ReachDeckDocumentV2,
  title: string,
  idFactory: ReachDeckIdFactory,
): ReachDeckNativeSlideV2 {
  const { width, height } = document.stage;
  return {
    schemaVersion: 'reach-deck-slide/v2',
    id: idFactory('slide'),
    title,
    duration: REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
    background: {
      kind: 'solid',
      color: { kind: 'srgb', value: srgbHex(document.theme.background) },
    },
    elements: [
      {
        id: idFactory('element'),
        type: 'textFrame',
        transform: {
          x: Math.round(width * 0.05),
          y: Math.round(height * 0.08),
          width: Math.round(width * 0.69),
          height: Math.round(height * 0.13),
        },
        zIndex: 1,
        text: {
          margins: { left: 8, top: 4, right: 8, bottom: 4 },
          verticalAlignment: 'middle',
          wrap: true,
          autofit: { mode: 'none' },
          doc: compileReachDeckSemanticTypographyV2({
            document,
            doc: richTextFromPlainText(title),
            role: 'title',
          }),
          fontSubstitutions: [],
        },
      },
    ],
    animations: [],
  };
}

/** 主题底色是宽松的 CSS 颜色；v2 校验只收严格 #RRGGBB，这里做收敛。 */
function srgbHex(value: string): string {
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (long !== null) return `#${long[1]!.toUpperCase()}`;
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short !== null) {
    return `#${[...short[1]!]
      .map((digit) => digit + digit)
      .join('')
      .toUpperCase()}`;
  }
  return '#FFFFFF';
}

export function addBlankSlidePage(
  document: ReachDeckDocument,
  input: {
    afterPageId?: string;
    idFactory: ReachDeckIdFactory;
  },
): ReachDeckDocument {
  return addReachDeckPage(document, { ...input, sceneType: 'slide' });
}

/** 仅在教师明确选择显示时，显露目标元素及其隐藏祖先。 */
export function revealReachDeckNativeElement(
  document: ReachDeckDocument,
  pageId: string,
  elementId: string,
): ReachDeckDocument {
  if (document.schemaVersion !== 'reach-deck-document/v2') return document;
  const reveal = (
    element: ReachDeckNativeElementV2,
  ): { found: boolean; element: ReachDeckNativeElementV2 } => {
    if (element.id === elementId)
      return { found: true, element: element.hidden ? { ...element, hidden: false } : element };
    if (element.type !== 'group') return { found: false, element };
    const children = element.children.map(reveal);
    if (!children.some((child) => child.found)) return { found: false, element };
    return {
      found: true,
      element: { ...element, hidden: false, children: children.map((child) => child.element) },
    };
  };
  let changed = false;
  const nativeSlides = document.nativeSlides.map((binding) => {
    if (binding.pageId !== pageId) return binding;
    const elements = binding.slide.elements.map((element) => {
      const result = reveal(element);
      changed ||= result.element !== element;
      return result.element;
    });
    return changed ? { ...binding, slide: { ...binding.slide, elements } } : binding;
  });
  return changed ? { ...document, nativeSlides } : document;
}

export function duplicateReachDeckPage(
  document: ReachDeckDocument,
  pageId: string,
  idFactory: ReachDeckIdFactory,
  translate?: ReachDeckTranslate,
): ReachDeckDocument {
  const pages = sortedPages(document.pages);
  const sourceIndex = pages.findIndex((page) => page.pageId === pageId);
  if (sourceIndex < 0) return document;

  const uniqueIdFactory = createUniqueIdFactory(document, idFactory);
  const source = cloneValue(pages[sourceIndex]);
  const copyPageId = uniqueIdFactory('page');
  const title = translateReachDeck(
    translate,
    'reachDeck.editor.default.copyTitle',
    '{title} 副本',
    {
      title: source.title,
    },
  );
  const copy =
    source.sceneType === 'slide'
      ? ({
          ...source,
          pageId: copyPageId,
          order: sourceIndex + 2,
          revision: 1,
          title,
        } as ReachDeckPublishedPage)
      : ({
          ...source,
          pageId: copyPageId,
          order: sourceIndex + 2,
          revision: 1,
          title,
          scene: { ...source.scene, id: copyPageId, title },
        } as ReachDeckPublishedPage);
  pages.splice(sourceIndex + 1, 0, copy);
  const base = { ...document, pages: normalizePageOrders(pages) };
  if (base.schemaVersion !== 'reach-deck-document/v2') return parseReachDeckDocument(base);
  const binding = base.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (binding === undefined) return parseReachDeckDocument(base);
  return parseReachDeckDocument({
    ...base,
    nativeSlides: [
      ...base.nativeSlides,
      {
        pageId: copyPageId,
        slide: cloneNativeSlideWithFreshIds(binding.slide, uniqueIdFactory, title),
      },
    ],
  });
}

/**
 * 复制页时只重分配真正的原生元素和动画身份。子类型载荷内的 id（图表系列、
 * 图节点、科学锚点/依赖/资源等）属于该载荷契约，必须原样保留。
 */
function cloneNativeSlideWithFreshIds(
  slide: ReachDeckNativeSlideV2,
  idFactory: ReachDeckIdFactory,
  title: string,
): ReachDeckNativeSlideV2 {
  const idMap = indexNativeElementIds(slide.elements, idFactory);
  const elements = slide.elements.map((element) =>
    cloneNativeElementWithIdMap(element, idMap, false),
  );
  const animations = slide.animations.map((animation) => ({
    ...cloneValue(animation),
    id: idFactory('animation'),
    targetId: idMap.get(animation.targetId) ?? animation.targetId,
  }));
  const narration = (() => {
    if (slide.narration === undefined) return undefined;
    const { scientificAnchorBindings: _bindings, ...withoutBindings } = cloneValue(slide.narration);
    if (!isReachScientificAnchorBindingSetUsable(slide)) return withoutBindings;
    return {
      ...withoutBindings,
      scientificAnchorBindings: slide.narration.scientificAnchorBindings!.map((binding) => {
        const elementId = idMap.get(binding.elementId)!;
        return {
          ...cloneValue(binding),
          id: `narration-anchor:${elementId}:${binding.anchorId}`,
          elementId,
        };
      }),
    };
  })();
  return {
    ...cloneValue(slide),
    id: idFactory('slide'),
    title,
    elements,
    animations,
    ...(narration === undefined ? {} : { narration }),
  };
}

/** Capture one top-level native element and the animations owned by its element subtree. */
export function copyReachDeckNativeElement(
  document: ReachDeckDocument,
  pageId: string,
  elementId: string,
): ReachDeckNativeElementClipboard | undefined {
  if (document.schemaVersion !== 'reach-deck-document/v2') return undefined;
  const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
  const element = slide?.elements.find((candidate) => candidate.id === elementId);
  if (slide === undefined || element === undefined) return undefined;
  const subtreeIds = collectNativeElementIds(element);
  const identityIdMap = new Map([...subtreeIds].map((id) => [id, id] as const));
  return {
    documentId: document.id,
    element: cloneNativeElementWithIdMap(element, identityIdMap, true),
    animations: slide.animations
      .filter((animation) => subtreeIds.has(animation.targetId))
      .map(cloneValue),
  };
}

/** Capture several top-level native elements and the animations owned by their subtrees. */
export function copyReachDeckNativeElements(
  document: ReachDeckDocument,
  pageId: string,
  elementIds: readonly string[],
): ReachDeckElementsClipboard | undefined {
  if (document.schemaVersion !== 'reach-deck-document/v2' || elementIds.length === 0)
    return undefined;
  const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
  if (slide === undefined) return undefined;
  const requested = new Set(elementIds);
  const elements = slide.elements.filter((element) => requested.has(element.id));
  if (elements.length === 0) return undefined;
  const subtreeIds = new Set(elements.flatMap((element) => [...collectNativeElementIds(element)]));
  const identityIdMap = new Map([...subtreeIds].map((id) => [id, id] as const));
  return {
    version: 'reach-deck-elements-clipboard/v2',
    documentId: document.id,
    pageId,
    stage: { width: document.stage.width, height: document.stage.height },
    elements: elements.map((element) => cloneNativeElementWithIdMap(element, identityIdMap, true)),
    animations: slide.animations
      .filter((animation) => subtreeIds.has(animation.targetId))
      .map(cloneValue),
  };
}

/** Best-effort visible text fallback for applications that do not understand the Deck MIME. */
export function reachDeckNativeElementClipboardPlainText(
  clipboard: ReachDeckNativeElementClipboard,
): string | undefined {
  const collect = (element: ReachDeckNativeElementV2): string[] => {
    if (element.hidden === true) return [];
    switch (element.type) {
      case 'shape':
        return element.text === undefined ? [] : [richTextToPlainText(element.text.doc)];
      case 'textFrame':
        return [richTextToPlainText(element.text.doc)];
      case 'group':
        return element.children.flatMap(collect);
      case 'image':
        return [element.alt];
      case 'audio':
      case 'video':
        return [element.title];
      default:
        return [];
    }
  };
  const visible = collect(clipboard.element).filter((value) => value.trim().length > 0);
  return visible.length === 0 ? undefined : visible.join('\n');
}

/** Serialize an editor-owned element into the versioned system clipboard contract. */
export function serializeReachDeckNativeElementClipboard(
  clipboard: ReachDeckNativeElementClipboard,
  document: ReachDeckDocument,
): string | undefined {
  const value = JSON.stringify({
    version: REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION,
    ...clipboard,
  } satisfies ReachDeckNativeElementClipboardPayload);
  if (clipboardByteLength(value) > REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MAX_BYTES) return undefined;
  return parseReachDeckNativeElementClipboard(value, document) === undefined ? undefined : value;
}

/** Parse and fully validate an untrusted system clipboard element payload against one deck. */
export function parseReachDeckNativeElementClipboard(
  value: string,
  document: ReachDeckDocument,
): ReachDeckNativeElementClipboard | undefined {
  if (
    document.schemaVersion !== 'reach-deck-document/v2' ||
    document.id.length === 0 ||
    value.length > REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MAX_BYTES ||
    clipboardByteLength(value) > REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MAX_BYTES
  ) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(value);
    if (!isRecord(payload)) return undefined;
    const keys = Object.keys(payload).sort();
    if (
      keys.length !== 4 ||
      !['animations', 'documentId', 'element', 'version'].every(
        (key, index) => key === keys[index],
      ) ||
      payload.version !== REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION ||
      payload.documentId !== document.id ||
      typeof payload.documentId !== 'string' ||
      payload.documentId.length === 0 ||
      !Array.isArray(payload.animations)
    ) {
      return undefined;
    }
    const validationBinding = document.nativeSlides[0];
    if (validationBinding === undefined) return undefined;
    const validated = parseReachDeckDocument({
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) =>
        index === 0
          ? {
              ...binding,
              slide: {
                schemaVersion: 'reach-deck-slide/v2',
                id: binding.slide.id,
                title: binding.slide.title,
                background: { kind: 'none' },
                elements: [payload.element],
                animations: payload.animations,
              },
            }
          : binding,
      ),
    });
    const slide = validated.nativeSlides.find(
      (binding) => binding.pageId === validationBinding.pageId,
    )!.slide;
    if (slide.elements.length !== 1) return undefined;
    // 文档允许保留孤儿动画，但剪贴板载荷里的动画必须指向随附元素子树。
    if (reachDeckOrphanAnimationIds(slide).size > 0) return undefined;
    return {
      documentId: payload.documentId,
      element: slide.elements[0]!,
      animations: slide.animations,
    };
  } catch {
    return undefined;
  }
}

/**
 * Paste a captured native element into any native page in the same deck. Element and animation
 * identities are fresh across the whole document. Connections within a copied group are remapped;
 * connections to elements outside the copied subtree are removed so cross-page paste cannot dangle.
 */
export function pasteReachDeckNativeElement(
  document: ReachDeckDocument,
  pageId: string,
  clipboard: ReachDeckNativeElementClipboard,
  idFactory: ReachDeckIdFactory,
  offset = NATIVE_ELEMENT_PASTE_OFFSET,
): ReachDeckNativeElementPasteResult {
  if (document.schemaVersion !== 'reach-deck-document/v2' || clipboard.documentId !== document.id) {
    return { document };
  }
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (binding === undefined) return { document };
  if (
    clipboard.element.type === 'scientificVisual' &&
    binding.slide.elements.some((element) => element.type === 'scientificVisual')
  ) {
    return { document };
  }

  const uniqueIdFactory = createUniqueIdFactory(document, idFactory);
  const idMap = indexNativeElementIds([clipboard.element], uniqueIdFactory);
  const cloned = cloneNativeElementWithIdMap(clipboard.element, idMap, true);
  const maximumX = Math.max(0, document.stage.width - cloned.transform.width);
  const maximumY = Math.max(0, document.stage.height - cloned.transform.height);
  const element: ReachDeckNativeElementV2 = {
    ...cloned,
    transform: {
      ...cloned.transform,
      x: Math.round(Math.max(0, Math.min(maximumX, cloned.transform.x + offset))),
      y: Math.round(Math.max(0, Math.min(maximumY, cloned.transform.y + offset))),
    },
    zIndex: Math.max(0, ...binding.slide.elements.map((candidate) => candidate.zIndex)) + 1,
  };
  const animations = clipboard.animations.flatMap((animation) => {
    const targetId = idMap.get(animation.targetId);
    return targetId === undefined
      ? []
      : [{ ...cloneValue(animation), id: uniqueIdFactory('animation'), targetId }];
  });
  const next = updateReachDeckNativeSlide(document, pageId, (slide) => ({
    ...slide,
    elements: [...slide.elements, element],
    animations: [...slide.animations, ...animations],
  }));
  return { document: next, elementId: element.id };
}

/** Paste a multi-element fragment, remapping every element/animation/connection identity once. */
export function pasteReachDeckNativeElements(
  document: ReachDeckDocument,
  pageId: string,
  clipboard: ReachDeckElementsClipboard,
  idFactory: ReachDeckIdFactory,
  offset = NATIVE_ELEMENT_PASTE_OFFSET,
): { document: ReachDeckDocument; elementIds: string[] } {
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    return { document, elementIds: [] };
  }
  const validated = validateReachDeckElementsClipboardForTarget(document, clipboard);
  if (
    validated === undefined ||
    (clipboard.documentId !== document.id &&
      !isReachDeckElementsClipboardSelfContained(validated.elements))
  )
    return { document, elementIds: [] };
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (binding === undefined) return { document, elementIds: [] };
  if (
    validated.elements.some((element) => element.type === 'scientificVisual') &&
    binding.slide.elements.some((element) => element.type === 'scientificVisual')
  ) {
    return { document, elementIds: [] };
  }
  const uniqueIdFactory = createUniqueIdFactory(document, idFactory);
  const idMap = indexNativeElementIds(validated.elements, uniqueIdFactory);
  const scale = Math.min(
    document.stage.width / clipboard.stage.width,
    document.stage.height / clipboard.stage.height,
  );
  const stageOffsetX = (document.stage.width - clipboard.stage.width * scale) / 2;
  const stageOffsetY = (document.stage.height - clipboard.stage.height * scale) / 2;
  const cloned = validated.elements.map((element) =>
    cloneNativeElementWithIdMap(element, idMap, true),
  );
  const adapted = cloned.map((element) =>
    scaleNativeElementForStage(element, scale, stageOffsetX, stageOffsetY),
  );
  const maxX = Math.max(
    ...adapted.map((element) => element.transform.x + element.transform.width),
    0,
  );
  const maxY = Math.max(
    ...adapted.map((element) => element.transform.y + element.transform.height),
    0,
  );
  const minX = Math.min(...adapted.map((element) => element.transform.x), 0);
  const minY = Math.min(...adapted.map((element) => element.transform.y), 0);
  const dx = Math.round(Math.max(0, Math.min(document.stage.width - maxX, offset - minX)));
  const dy = Math.round(Math.max(0, Math.min(document.stage.height - maxY, offset - minY)));
  const zStart = Math.max(0, ...binding.slide.elements.map((candidate) => candidate.zIndex)) + 1;
  const elements = adapted.map((element, index) => ({
    ...element,
    transform: { ...element.transform, x: element.transform.x + dx, y: element.transform.y + dy },
    zIndex: zStart + index,
  }));
  const animations = validated.animations.flatMap((animation) => {
    const targetId = idMap.get(animation.targetId);
    return targetId === undefined
      ? []
      : [
          {
            ...scaleNativeAnimationForStage(animation, scale),
            id: uniqueIdFactory('animation'),
            targetId,
          },
        ];
  });
  const next = updateReachDeckNativeSlide(document, pageId, (slide) => ({
    ...slide,
    elements: [...slide.elements, ...elements],
    animations: [...slide.animations, ...animations],
  }));
  return { document: next, elementIds: elements.map((element) => element.id) };
}

function scaleNativeElementForStage(
  element: ReachDeckNativeElementV2,
  scale: number,
  offsetX: number,
  offsetY: number,
): ReachDeckNativeElementV2 {
  const transform = {
    ...element.transform,
    x: element.transform.x * scale + offsetX,
    y: element.transform.y * scale + offsetY,
    width: element.transform.width * scale,
    height: element.transform.height * scale,
  };
  if (element.type === 'group') {
    return {
      ...element,
      transform,
      ...(element.effects && { effects: scaleNativeEffects(element.effects, scale) }),
      children: element.children.map((child) => scaleNativeElementForStage(child, scale, 0, 0)),
    };
  }
  if (element.type === 'line') {
    return {
      ...element,
      transform,
      start: {
        ...element.start,
        x: element.start.x * scale,
        y: element.start.y * scale,
      },
      end: {
        ...element.end,
        x: element.end.x * scale,
        y: element.end.y * scale,
      },
      stroke: scaleNativeStroke(element.stroke, scale),
    };
  }
  if (element.type === 'shape')
    return {
      ...element,
      transform,
      style: scaleNativeStyle(element.style, scale),
      ...(element.text && { text: scaleNativeText(element.text, scale) }),
    };
  if (element.type === 'textFrame')
    return {
      ...element,
      transform,
      ...(element.style && { style: scaleNativeStyle(element.style, scale) }),
      text: scaleNativeText(element.text, scale),
    };
  if (element.type === 'image')
    return {
      ...element,
      transform,
      ...(element.stroke && { stroke: scaleNativeStroke(element.stroke, scale) }),
      ...(element.effects && { effects: scaleNativeEffects(element.effects, scale) }),
    };
  if (element.type === 'table')
    return {
      ...element,
      transform,
      columnWidths: element.columnWidths.map((width) => width * scale),
      rowHeights: element.rowHeights.map((height) => height * scale),
      rows: element.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => ({
          ...cell,
          text: scaleNativeText(cell.text, scale),
          style: scaleNativeStyle(cell.style, scale),
        })),
      })),
    };
  if (element.type === 'diagram')
    return {
      ...element,
      transform,
      nodes: element.nodes.map((node) => ({
        ...node,
        label: scaleNativeText(node.label, scale),
        style: scaleNativeStyle(node.style, scale),
      })),
    };
  return { ...element, transform };
}

function scaleNativeStroke<T extends { width: number; customDash?: number[] }>(
  stroke: T,
  scale: number,
): T {
  return {
    ...stroke,
    width: stroke.width * scale,
    ...(stroke.customDash && { customDash: stroke.customDash.map((length) => length * scale) }),
  };
}

function scaleNativeEffects(
  effects: ReachDeckEffectsV2 | undefined,
  scale: number,
): ReachDeckEffectsV2 | undefined {
  if (!effects) return undefined;
  return {
    ...effects,
    ...(effects.shadow && {
      shadow: {
        ...effects.shadow,
        blur: effects.shadow.blur * scale,
        distance: effects.shadow.distance * scale,
      },
    }),
    ...(effects.glow && { glow: { ...effects.glow, radius: effects.glow.radius * scale } }),
  };
}

function scaleNativeStyle(style: ReachDeckElementStyleV2, scale: number): ReachDeckElementStyleV2 {
  return {
    ...style,
    ...(style.stroke && { stroke: scaleNativeStroke(style.stroke, scale) }),
    ...(style.effects && { effects: scaleNativeEffects(style.effects, scale) }),
  };
}

const RICH_TEXT_PIXEL_ATTRIBUTES = new Set([
  'lineHeightPx',
  'spaceBefore',
  'spaceAfter',
  'leftIndent',
  'rightIndent',
  'firstLineIndent',
  'defaultLetterSpacing',
  'letterSpacing',
]);

function scaleRichTextAttributes(
  attrs: Record<string, unknown> | undefined,
  scale: number,
): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  return Object.fromEntries(
    Object.entries(attrs).map(([key, value]) => {
      if (RICH_TEXT_PIXEL_ATTRIBUTES.has(key) && typeof value === 'number')
        return [key, value * scale];
      if (key === 'fontSize' && typeof value === 'number') return [key, value * scale];
      if (key === 'fontSize' && typeof value === 'string' && /^\d+(?:\.\d+)?px$/.test(value))
        return [key, `${Number.parseFloat(value) * scale}px`];
      return [key, value];
    }),
  );
}

function scaleRichTextNode(node: RichTextNode, scale: number): RichTextNode {
  return {
    ...node,
    ...(node.attrs && { attrs: scaleRichTextAttributes(node.attrs, scale) }),
    ...(node.marks && {
      marks: node.marks.map((mark) => ({
        ...mark,
        ...(mark.attrs && { attrs: scaleRichTextAttributes(mark.attrs, scale) }),
      })),
    }),
    ...(node.content && { content: node.content.map((child) => scaleRichTextNode(child, scale)) }),
  };
}

function scaleNativeText(text: ReachDeckTextFrameV2, scale: number): ReachDeckTextFrameV2 {
  return {
    ...text,
    margins: {
      left: text.margins.left * scale,
      top: text.margins.top * scale,
      right: text.margins.right * scale,
      bottom: text.margins.bottom * scale,
    },
    doc: {
      ...text.doc,
      ...(text.doc.content && {
        content: text.doc.content.map((node) => scaleRichTextNode(node, scale)),
      }),
    },
  };
}

function scaleNativeAnimationForStage(
  animation: ReachDeckAnimationV2,
  scale: number,
): ReachDeckAnimationV2 {
  const scaleTranslations = (values: ReachDeckAnimationV2['from']) =>
    values === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            (key === 'translateX' || key === 'translateY') && typeof value === 'number'
              ? value * scale
              : value,
          ]),
        );
  return {
    ...cloneValue(animation),
    ...(animation.from && { from: scaleTranslations(animation.from) }),
    ...(animation.to && { to: scaleTranslations(animation.to) }),
  };
}

/** Validate direct operation inputs against the target Deck before allocating IDs or mutating it. */
function validateReachDeckElementsClipboardForTarget(
  document: ReachDeckDocument,
  clipboard: ReachDeckElementsClipboard,
): Pick<ReachDeckElementsClipboard, 'elements' | 'animations'> | undefined {
  const first = document.nativeSlides[0];
  if (first === undefined) return undefined;
  try {
    const validated = parseReachDeckDocument({
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) =>
        index === 0
          ? {
              ...binding,
              slide: {
                schemaVersion: 'reach-deck-slide/v2',
                id: binding.slide.id,
                title: binding.slide.title,
                background: { kind: 'none' },
                elements: clipboard.elements,
                animations: clipboard.animations,
              },
            }
          : binding,
      ),
    });
    return {
      elements: validated.nativeSlides[0]!.slide.elements,
      animations: validated.nativeSlides[0]!.slide.animations,
    };
  } catch {
    return undefined;
  }
}

/** Add a stable-size, genuinely empty native text frame with theme-derived body defaults. */
export function addEmptyReachDeckTextFrame(
  document: ReachDeckDocument,
  pageId: string,
  point: { x: number; y: number },
  idFactory: ReachDeckIdFactory,
): ReachDeckEmptyTextFrameResult {
  if (document.schemaVersion !== 'reach-deck-document/v2') return { document };
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (binding === undefined) return { document };
  const uniqueIdFactory = createUniqueIdFactory(document, idFactory);
  const width = Math.min(EMPTY_TEXT_FRAME_WIDTH, document.stage.width);
  const height = Math.min(EMPTY_TEXT_FRAME_HEIGHT, document.stage.height);
  const maximumX = Math.max(0, document.stage.width - width);
  const maximumY = Math.max(0, document.stage.height - height);
  const element: ReachDeckNativeElementV2 = {
    id: uniqueIdFactory('element'),
    type: 'textFrame',
    transform: {
      x: Math.round(Math.max(0, Math.min(maximumX, point.x))),
      y: Math.round(Math.max(0, Math.min(maximumY, point.y))),
      width,
      height,
    },
    zIndex: Math.max(0, ...binding.slide.elements.map((candidate) => candidate.zIndex)) + 1,
    text: {
      margins: { left: 8, top: 4, right: 8, bottom: 4 },
      verticalAlignment: 'top',
      wrap: true,
      autofit: { mode: 'none' },
      doc: compileReachDeckSemanticTypographyV2({
        document,
        doc: richTextFromPlainText(''),
        role: 'body',
      }),
      fontSubstitutions: [],
    },
  };
  const next = updateReachDeckNativeSlide(document, pageId, (slide) => ({
    ...slide,
    elements: [...slide.elements, element],
  }));
  return { document: next, elementId: element.id };
}

/** Insert external clipboard text as one editable body text frame centered on the stage. */
export function insertReachDeckClipboardTextFrame(
  document: ReachDeckDocument,
  pageId: string,
  value: RichTextDocument,
  idFactory: ReachDeckIdFactory,
  offset = 0,
): ReachDeckClipboardTextFrameResult {
  if (document.schemaVersion !== 'reach-deck-document/v2') return { document };
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (binding === undefined) return { document };
  const uniqueIdFactory = createUniqueIdFactory(document, idFactory);
  const width = Math.min(EMPTY_TEXT_FRAME_WIDTH, document.stage.width);
  const height = Math.min(EMPTY_TEXT_FRAME_HEIGHT, document.stage.height);
  const maximumX = Math.max(0, document.stage.width - width);
  const maximumY = Math.max(0, document.stage.height - height);
  const element: ReachDeckNativeElementV2 = {
    id: uniqueIdFactory('element'),
    type: 'textFrame',
    transform: {
      x: Math.round(Math.max(0, Math.min(maximumX, (document.stage.width - width) / 2 + offset))),
      y: Math.round(Math.max(0, Math.min(maximumY, (document.stage.height - height) / 2 + offset))),
      width,
      height,
    },
    zIndex: Math.max(0, ...binding.slide.elements.map((candidate) => candidate.zIndex)) + 1,
    text: {
      margins: { left: 8, top: 4, right: 8, bottom: 4 },
      verticalAlignment: 'top',
      wrap: true,
      autofit: { mode: 'none' },
      doc: applyReachDeckBodyTypographyDefaults(document, value),
      fontSubstitutions: [],
    },
  };
  const next = updateReachDeckNativeSlide(document, pageId, (slide) => ({
    ...slide,
    elements: [...slide.elements, element],
  }));
  return { document: next, elementId: element.id };
}

/** Register an uploaded stable object and its native element as one editor mutation. */
export function insertReachDeckAuthoringMedia(
  document: ReachDeckDocument,
  pageId: string,
  media: ReachDeckAuthoringMediaResource,
  idFactory: ReachDeckIdFactory,
  offset = 0,
): ReachDeckAuthoringMediaInsertionResult {
  if (document.schemaVersion !== 'reach-deck-document/v2') return { document };
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (binding === undefined) return { document };
  const contentType = media.contentType.trim().toLowerCase();
  if (
    media.objectKey.trim().length === 0 ||
    media.digest.trim().length === 0 ||
    !contentType.startsWith(`${media.kind}/`)
  ) {
    throw new Error('Reach Deck authoring media resource is invalid.');
  }

  const uniqueIdFactory = createUniqueIdFactory(document, idFactory);
  const resourceId = uniqueIdFactory('media');
  const elementId = uniqueIdFactory('element');
  const transform = defaultAuthoringMediaTransform(document, media.kind, offset);
  const common = {
    id: elementId,
    transform,
    zIndex: Math.max(0, ...binding.slide.elements.map((candidate) => candidate.zIndex)) + 1,
  };
  const playback = { autoplay: false, loop: false, startAt: 0, volume: 1 } as const;
  const element: ReachDeckNativeElementV2 =
    media.kind === 'image'
      ? {
          ...common,
          type: 'image',
          resourceId,
          fit: 'contain',
          alt: media.title,
        }
      : media.kind === 'audio'
        ? { ...common, type: 'audio', resourceId, playback, title: media.title }
        : { ...common, type: 'video', resourceId, playback, title: media.title };
  const next = updateReachDeckNativeSlide(
    {
      ...document,
      resources: {
        ...document.resources,
        media: [
          ...document.resources.media,
          {
            id: resourceId,
            objectKey: media.objectKey.trim(),
            contentType,
            digest: media.digest,
          },
        ],
      },
    },
    pageId,
    (slide) => ({ ...slide, elements: [...slide.elements, element] }),
  );
  return { document: next, elementId, resourceId };
}

function defaultAuthoringMediaTransform(
  document: ReachDeckDocumentV2,
  kind: ReachDeckAuthoringMediaKind,
  offset: number,
) {
  const centeredTransform = (width: number, height: number) => ({
    x: Math.round(
      Math.max(
        0,
        Math.min(document.stage.width - width, (document.stage.width - width) / 2 + offset),
      ),
    ),
    y: Math.round(
      Math.max(
        0,
        Math.min(document.stage.height - height, (document.stage.height - height) / 2 + offset),
      ),
    ),
    width: Math.round(width),
    height: Math.round(height),
  });
  if (kind === 'audio') {
    const size = Math.max(1, Math.floor(Math.min(72, document.stage.width, document.stage.height)));
    return centeredTransform(size, size);
  }
  const maximumWidth = document.stage.width * 0.6;
  const maximumHeight = document.stage.height * 0.6;
  const width = Math.min(maximumWidth, (maximumHeight * 16) / 9);
  const height = (width * 9) / 16;
  return centeredTransform(width, height);
}

function indexNativeElementIds(
  elements: readonly ReachDeckNativeElementV2[],
  idFactory: ReachDeckIdFactory,
): Map<string, string> {
  const idMap = new Map<string, string>();
  const visit = (element: ReachDeckNativeElementV2) => {
    idMap.set(element.id, idFactory('element'));
    if (element.type === 'group') element.children.forEach(visit);
  };
  elements.forEach(visit);
  return idMap;
}

function collectNativeElementIds(element: ReachDeckNativeElementV2): Set<string> {
  const ids = new Set<string>();
  const visit = (candidate: ReachDeckNativeElementV2) => {
    ids.add(candidate.id);
    if (candidate.type === 'group') candidate.children.forEach(visit);
  };
  visit(element);
  return ids;
}

function cloneNativeElementWithIdMap(
  element: ReachDeckNativeElementV2,
  idMap: ReadonlyMap<string, string>,
  removeExternalConnections: boolean,
): ReachDeckNativeElementV2 {
  const cloned = { ...cloneValue(element), id: idMap.get(element.id)! };
  if (cloned.type === 'group' && element.type === 'group') {
    return {
      ...cloned,
      children: element.children.map((child) =>
        cloneNativeElementWithIdMap(child, idMap, removeExternalConnections),
      ),
    };
  }
  if (cloned.type === 'line' && element.type === 'line') {
    const remapEndpoint = (endpoint: typeof element.start): typeof element.start => {
      const copied = cloneValue(endpoint);
      if (endpoint.connection === undefined) return copied;
      const elementId = idMap.get(endpoint.connection.elementId);
      if (elementId === undefined) {
        if (removeExternalConnections) {
          const { connection: _connection, ...detached } = copied;
          return detached;
        }
        return copied;
      }
      return { ...copied, connection: { ...copied.connection!, elementId } };
    };
    return { ...cloned, start: remapEndpoint(element.start), end: remapEndpoint(element.end) };
  }
  return cloned;
}

/**
 * 删除当前页上的若干顶层原生元素（Delete/Backspace 快捷键）。
 * 连带清理：元素子树上的动画、指向被删元素的连接线端点吸附、
 * 科学可视化的讲稿锚点绑定。未命中任何元素时原样返回。
 */
export function deleteReachDeckNativeElements(
  document: ReachDeckDocument,
  pageId: string,
  elementIds: readonly string[],
): ReachDeckDocument {
  if (
    document.schemaVersion !== 'reach-deck-document/v2' ||
    elementIds.length === 0 ||
    !document.nativeSlides.some((binding) => binding.pageId === pageId)
  ) {
    return document;
  }
  const requested = new Set(elementIds);
  return updateReachDeckNativeSlide(document, pageId, (slide) => {
    const removed = slide.elements.filter((element) => requested.has(element.id));
    if (removed.length === 0) return slide;
    const removedIds = new Set(removed.flatMap((element) => [...collectNativeElementIds(element)]));
    const detachEndpoint = <Endpoint extends { connection?: { elementId: string } }>(
      endpoint: Endpoint,
    ): Endpoint => {
      if (endpoint.connection === undefined || !removedIds.has(endpoint.connection.elementId)) {
        return endpoint;
      }
      const { connection: _connection, ...detached } = endpoint;
      return detached as Endpoint;
    };
    // 连接线可能藏在保留下来的组里，所以要递归脱钩，不能只看顶层。
    const detachConnections = (element: ReachDeckNativeElementV2): ReachDeckNativeElementV2 => {
      if (element.type === 'line') {
        const start = detachEndpoint(element.start);
        const end = detachEndpoint(element.end);
        return start === element.start && end === element.end
          ? element
          : { ...element, start, end };
      }
      if (element.type === 'group') {
        const children = element.children.map(detachConnections);
        return children.every((child, index) => child === element.children[index])
          ? element
          : { ...element, children };
      }
      return element;
    };
    const elements = slide.elements
      .filter((element) => !removedIds.has(element.id))
      .map(detachConnections);
    const animations = slide.animations.filter((animation) => !removedIds.has(animation.targetId));
    const bindings = slide.narration?.scientificAnchorBindings?.filter(
      (binding) => !removedIds.has(binding.elementId),
    );
    const narration =
      slide.narration === undefined || bindings === undefined
        ? slide.narration
        : (() => {
            const { scientificAnchorBindings: _bindings, ...rest } = slide.narration;
            return bindings.length === 0 ? rest : { ...rest, scientificAnchorBindings: bindings };
          })();
    return {
      ...slide,
      elements,
      animations,
      ...(narration === undefined ? {} : { narration }),
    };
  });
}

export function deleteReachDeckPage(
  document: ReachDeckDocument,
  pageId: string,
): ReachDeckDocument {
  if (document.pages.length <= 1) return document;
  const pages = document.pages.filter((page) => page.pageId !== pageId);
  if (pages.length === document.pages.length) return document;
  const next = { ...document, pages: normalizePageOrders(sortedPages(pages)) };
  if (next.schemaVersion !== 'reach-deck-document/v2') return next;
  // 同步删除原生幻灯片绑定，否则孤儿绑定会让下一次文档解析直接失败。
  const nativeSlides = next.nativeSlides.filter((binding) => binding.pageId !== pageId);
  return nativeSlides.length === next.nativeSlides.length ? next : { ...next, nativeSlides };
}

/** 拖拽排序：把 pageId 移动到有序列表的 targetIndex 位置。 */
export function reorderReachDeckPage(
  document: ReachDeckDocument,
  pageId: string,
  targetIndex: number,
): ReachDeckDocument {
  const pages = sortedPages(document.pages);
  const index = pages.findIndex((page) => page.pageId === pageId);
  if (index < 0) return document;
  const bounded = Math.max(0, Math.min(pages.length - 1, targetIndex));
  if (bounded === index) return document;
  const [moved] = pages.splice(index, 1);
  if (moved === undefined) return document;
  pages.splice(bounded, 0, moved);
  return { ...document, pages: normalizePageOrders(pages) };
}

/** Move the selected pages as one ordered block before a source-list target index. */
export function reorderReachDeckPages(
  document: ReachDeckDocument,
  pageIds: readonly string[],
  targetIndex: number,
): ReachDeckDocument {
  const pages = sortedPages(document.pages);
  const selectedIds = new Set(pageIds);
  const selected = pages.filter((page) => selectedIds.has(page.pageId));
  if (selected.length === 0) return document;
  const bounded = Math.max(0, Math.min(pages.length, targetIndex));
  const removedBeforeTarget = pages
    .slice(0, bounded)
    .filter((page) => selectedIds.has(page.pageId)).length;
  const remaining = pages.filter((page) => !selectedIds.has(page.pageId));
  const insertionIndex = Math.max(0, Math.min(remaining.length, bounded - removedBeforeTarget));
  const reordered = [
    ...remaining.slice(0, insertionIndex),
    ...selected,
    ...remaining.slice(insertionIndex),
  ];
  if (reordered.every((page, index) => page.pageId === pages[index]?.pageId)) return document;
  return { ...document, pages: normalizePageOrders(reordered) };
}

export function updateReachDeckPage(
  document: ReachDeckDocument,
  pageId: string,
  update: (page: ReachDeckPublishedPage) => ReachDeckPublishedPage,
): ReachDeckDocument {
  let changed = false;
  const pages = document.pages.map((page) => {
    if (page.pageId !== pageId) return page;
    const next = update(page);
    if (next === page) return page;
    changed = true;
    return {
      ...next,
      pageId: page.pageId,
      order: page.order,
      revision: page.revision + 1,
    } as ReachDeckPublishedPage;
  });
  return changed ? { ...document, pages } : document;
}

/** Update one native-v2 slide without touching the legacy page envelope. */
export function updateReachDeckNativeSlide(
  document: ReachDeckDocument,
  pageId: string,
  update: (slide: ReachDeckNativeSlideV2) => ReachDeckNativeSlideV2,
): ReachDeckDocumentV2 {
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error('Native Reach Deck slides require a v2 document.');
  }
  const bindingIndex = document.nativeSlides.findIndex((binding) => binding.pageId === pageId);
  if (bindingIndex < 0) {
    throw new Error(`Reach Deck page ${pageId} has no native slide binding.`);
  }
  const current = document.nativeSlides[bindingIndex]!;
  const slide = parseReachDeckNativeSlideV2(update(current.slide));
  if (valuesEqual(slide, current.slide)) return document;
  const nativeSlides = [...document.nativeSlides];
  nativeSlides[bindingIndex] = { ...current, slide };
  return { ...document, nativeSlides };
}

/**
 * Make editor commits revision-safe even when they originate from document or
 * scene JSON. Structure-only changes keep the current revision, new pages start
 * at one, and each content change advances exactly one revision.
 */
export function normalizeReachDeckEditorMutation(
  persistedBaseline: ReachDeckDocument,
  candidate: ReachDeckDocument,
): ReachDeckDocument {
  const previousMedia = new Map(
    persistedBaseline.resources.media.map((resource) => [resource.id, resource]),
  );
  const parsedCandidate = parseReachDeckDocument({
    ...candidate,
    resources: {
      ...candidate.resources,
      media: candidate.resources.media.map((resource) => {
        const previous = previousMedia.get(resource.id);
        if (
          previous !== undefined &&
          (previous.objectKey !== resource.objectKey ||
            previous.digest !== resource.digest ||
            previous.contentType !== resource.contentType)
        ) {
          const { origin: _origin, ...replacement } = resource;
          return replacement;
        }
        return resource;
      }),
    },
  });
  const previousSlides = nativeSlidesByPageId(persistedBaseline);
  const validCandidate =
    parsedCandidate.schemaVersion !== 'reach-deck-document/v2'
      ? parsedCandidate
      : {
          ...parsedCandidate,
          nativeSlides: parsedCandidate.nativeSlides.map((binding) => {
            const previous = previousSlides.get(binding.pageId);
            return previous === undefined
              ? binding
              : {
                  ...binding,
                  slide: preserveNativeSlideNarrationContentBaseline(previous, binding.slide),
                };
          }),
        };
  if (persistedBaseline.id !== validCandidate.id) {
    throw new Error('Reach Deck document identity cannot change in the editor.');
  }
  const previousById = new Map(persistedBaseline.pages.map((page) => [page.pageId, page]));
  const previousNativeByPageId = nativeSlidesByPageId(persistedBaseline);
  const candidateNativeByPageId = nativeSlidesByPageId(validCandidate);
  const pages = validCandidate.pages.map((page) => {
    const current = previousById.get(page.pageId);
    if (current === undefined) return { ...page, revision: 1 } as ReachDeckPublishedPage;
    const contentChanged =
      page.title !== current.title ||
      page.sceneType !== current.sceneType ||
      (page.sceneType !== 'slide' &&
        current.sceneType !== 'slide' &&
        !valuesEqual(page.scene, current.scene)) ||
      !valuesEqual(
        previousNativeByPageId.get(page.pageId),
        candidateNativeByPageId.get(page.pageId),
      );
    return {
      ...page,
      revision: contentChanged ? current.revision + 1 : current.revision,
    } as ReachDeckPublishedPage;
  });
  return assertReachDeckDocumentTransition(persistedBaseline, {
    ...validCandidate,
    pages,
  });
}

function nativeSlidesByPageId(
  document: ReachDeckDocument,
): ReadonlyMap<string, ReachDeckNativeSlideV2> {
  return new Map(
    document.schemaVersion === 'reach-deck-document/v2'
      ? document.nativeSlides.map((binding) => [binding.pageId, binding.slide] as const)
      : [],
  );
}

export function createUniqueReachDeckId(
  document: ReachDeckDocument,
  prefix: string,
  idFactory: ReachDeckIdFactory,
): string {
  return createUniqueIdFactory(document, idFactory)(prefix);
}

export function parseReachDeckEditorJson(value: string): ReachDeckDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Reach Deck JSON 不是有效的 JSON。');
  }
  return parseReachDeckDocument(parsed);
}

const blankPageTitles: Record<ReachDeckSceneType, string> = {
  slide: '新幻灯片',
  quiz: '新测验',
  interactive: '新互动',
};

function createPageEnvelope<SceneType extends ReachDeckSceneType, Scene>(
  pageId: string,
  order: number,
  sceneType: SceneType,
  title: string,
  scene: Scene,
): ReachDeckPublishedPage {
  return { pageId, order, revision: 1, sceneType, title, scene } as ReachDeckPublishedPage;
}

function sortedPages(pages: ReachDeckPublishedPage[]): ReachDeckPublishedPage[] {
  return [...pages].sort((left, right) => left.order - right.order);
}

function normalizePageOrders(pages: ReachDeckPublishedPage[]): ReachDeckPublishedPage[] {
  return pages.map((page, index) => ({ ...page, order: index + 1 }) as ReachDeckPublishedPage);
}

function createUniqueIdFactory(
  document: ReachDeckDocument,
  idFactory: ReachDeckIdFactory,
): ReachDeckIdFactory {
  const reserved = new Set<string>();
  collectIds(document, reserved);

  return (prefix) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = idFactory(prefix);
      if (candidate.length > 0 && !reserved.has(candidate)) {
        reserved.add(candidate);
        return candidate;
      }
    }
    throw new Error('Reach Deck idFactory could not create a unique id.');
  };
}

function collectIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectIds(item, ids));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'id' || key === 'pageId') && typeof nested === 'string') ids.add(nested);
    collectIds(nested, ids);
  }
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]),
    ) as T;
  }
  return value;
}

function clipboardByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function assertNever(value: never): never {
  throw new Error('Unsupported Reach Deck scene type: ' + String(value));
}
