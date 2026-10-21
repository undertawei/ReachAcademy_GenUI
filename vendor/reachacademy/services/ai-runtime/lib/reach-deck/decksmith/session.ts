import { randomUUID } from 'node:crypto';

import {
  INTERACTIVE_RUNTIME_PINS,
  parseInteractiveRuntimeDependenciesValue,
  REACH_DECK_NATIVE_V2_SCHEMA_FEATURES,
  collectReachDeckNativeElementIds,
  REACH_DECK_NARRATION_ANIMATION_ID_PREFIX,
  REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
  analyzeReachDeckNativeSlideV2Capabilities,
  assertReachDeckDocumentTransition,
  compileReachDeckSemanticTypographyV2,
  invalidateReachDeckNativeSlideNarration,
  parseQuizSceneValue,
  parseRestrictedMarkdown,
  richTextFromPlainText,
  parseReachDeckDocument,
  parseReachDeckNativeSlideV2,
  type RichTextDocument,
  type RichTextNode,
  type InteractiveRuntimeDependency,
  type ReachDeckAnimationV2,
  type ReachDeckDocumentV2,
  type ReachDeckElementStyleV2,
  type ReachDeckFillV2,
  type ReachDeckMediaResourceV2,
  type ReachDeckNativeElementV2,
  type ReachDeckNativeSlideV2,
  type ReachDeckPublishedPage,
  type ReachDeckSceneType,
  type ReachDeckSemanticTextRole,
  type ReachDeckTextFrameV2,
  type ReachDeckTransformV2,
} from '@reachany/reach-deck-dsl';
import { EUCLIDEAN_GEOMETRY_CONTRACT } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { EUCLIDEAN_GEOMETRY_CONTRACT_V2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';

import {
  REACH_DECK_DECKSMITH_AFTER_APPLY_LIMIT,
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_SLIDE_ONLY_SUGGESTED_ACTION_KINDS,
  REACH_DECK_DECKSMITH_SUGGESTED_ACTION_LIMIT,
  isReachDeckDecksmithAfterApplyKind,
  isReachDeckDecksmithSuggestedActionKind,
  type ReachDeckDecksmithAfterApplyAction,
  type ReachDeckDecksmithSuggestedAction,
} from '../contracts.js';
import { validateDecksmithAfterApplyActions } from './after-apply.js';
import { createGeneratedInteractiveSceneParser } from '../interactive-generation-validation.js';
import type { DecksmithPageMediaState, DecksmithPageMediaStatus } from './page-stream-contracts.js';

/** Decksmith 工具执行失败：消息会作为 tool error 反馈给 LLM，供其自我修正。 */
export class DecksmithSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecksmithSessionError';
  }
}

export interface DecksmithPageSummary {
  pageId: string;
  order: number;
  sceneType: ReachDeckPublishedPage['sceneType'];
  title: string;
  revision: number;
  native: boolean;
}

export interface DecksmithPageView {
  pageId: string;
  order: number;
  revision: number;
  sceneType: ReachDeckSceneType;
  title: string;
  nativeSlide?: ReachDeckNativeSlideV2;
  scene?: Exclude<ReachDeckPublishedPage, { sceneType: 'slide' }>['scene'];
}

export interface DecksmithNativeTextInput {
  pageId: string;
  elementId: string;
  text: string;
  transform?: ReachDeckTransformV2;
  zIndex?: number;
  role?: ReachDeckSemanticTextRole;
  textColor?: string;
  inlineBackgroundColor?: string | null;
  frameFillColor?: string | null;
}

export interface DecksmithNativeTableCellInput {
  pageId: string;
  elementId: string;
  cellId: string;
  text?: string;
  textColor?: string;
  fillColor?: string | null;
}

export interface DecksmithNativeAnimationInput {
  pageId: string;
  id: string;
  targetId: string;
  trigger: ReachDeckAnimationV2['trigger'];
  effect: ReachDeckAnimationV2['effect'];
  start: number;
  duration: number;
  delay?: number;
  easing?: ReachDeckAnimationV2['easing'];
  from?: Readonly<Record<string, number | string>>;
  to?: Readonly<Record<string, number | string>>;
}

export interface DecksmithNativeShapeInput {
  pageId: string;
  elementId: string;
  preset: string;
  transform?: ReachDeckTransformV2;
  zIndex?: number;
  fillColor?: string | null;
  strokeColor?: string;
  strokeWidth?: number;
  text?: string;
}

export interface DecksmithNativeTransformInput {
  pageId: string;
  elementId: string;
  transform: ReachDeckTransformV2;
  zIndex?: number;
}

export interface DecksmithNativeTransformState {
  transform: ReachDeckTransformV2;
  zIndex: number;
}

export interface DecksmithNativeTransformReceipt {
  pageId: string;
  elementId: string;
  changed: boolean;
  before: DecksmithNativeTransformState;
  after: DecksmithNativeTransformState;
  revision: number;
  slide: ReachDeckNativeSlideV2;
}

export interface DecksmithImageBindingInput {
  pageId: string;
  elementId: string;
  resource: ReachDeckMediaResourceV2;
  transform?: ReachDeckTransformV2;
  zIndex?: number;
  alt?: string;
  fit?: 'cover' | 'contain' | 'stretch';
}

export type DecksmithInsertSceneType = Exclude<ReachDeckSceneType, 'slide'>;

export interface DecksmithInteractiveValidationOptions {
  readonly scientificCapabilityPolicy: 'normal' | 'legacy' | 'candidate';
  readonly allowedRuntimeDependencies?: readonly InteractiveRuntimeDependency[];
}

/**
 * Decksmith v2 会话只接受已物化且语义自洽的 document/v2。
 *
 * nativeSlides 是 slide 页的唯一内容权威；slide page 不再携带 legacy scene 投影。
 * 非 slide scene 继续由各自严格 parser 拥有。
 */
export class DecksmithDocumentSession {
  private current: ReachDeckDocumentV2;
  private readonly baseline: ReachDeckDocumentV2;
  private readonly baselineRevisions: ReadonlyMap<string, number>;
  private readonly issuedPageIds: Set<string>;
  private readonly reservedPageIds = new Set<string>();
  private mutated = false;
  private readonly suggestions: ReachDeckDecksmithSuggestedAction[] = [];
  /** 本次运行写过讲稿（set_native_narration / 插页带讲稿）的页，采用后媒体意图只能落在这些页上。 */
  private readonly narrationWrittenPageIds = new Set<string>();
  /** 采用后自动生成的页面媒体（WP8），按页去重，后声明的覆盖先声明的。 */
  private readonly afterApply = new Map<string, ReachDeckDecksmithAfterApplyAction>();
  private readonly mediaStatus?: DecksmithPageMediaStatus;
  private validationOptions: DecksmithInteractiveValidationOptions;

  constructor(
    document: unknown,
    capability: unknown,
    options: {
      readonly mediaStatus?: DecksmithPageMediaStatus;
      readonly interactiveValidationOptions?: DecksmithInteractiveValidationOptions;
    } = {},
  ) {
    if (capability !== REACH_DECK_DECKSMITH_CAPABILITY) {
      throw new DecksmithSessionError(
        `Decksmith session capability must be ${REACH_DECK_DECKSMITH_CAPABILITY}.`,
      );
    }
    const baseline = parseReachDeckDocument(document);
    if (baseline.schemaVersion !== 'reach-deck-document/v2') {
      throw new DecksmithSessionError('Decksmith v2 does not accept legacy document/v1 content.');
    }
    assertSemanticConsistency(baseline);
    this.current = baseline;
    this.baseline = baseline;
    this.baselineRevisions = new Map(baseline.pages.map((page) => [page.pageId, page.revision]));
    this.issuedPageIds = new Set(baseline.pages.map((page) => page.pageId));
    this.mediaStatus = options.mediaStatus;
    const policy = options.interactiveValidationOptions?.scientificCapabilityPolicy ?? 'normal';
    const dependencies =
      options.interactiveValidationOptions?.allowedRuntimeDependencies ??
      (policy === 'normal'
        ? Object.entries(INTERACTIVE_RUNTIME_PINS)
            .filter(([id]) => !id.startsWith('geometry-euclidean-'))
            .map(([id, version]) => ({ id, version }) as InteractiveRuntimeDependency)
        : undefined);
    this.validationOptions = Object.freeze({
      scientificCapabilityPolicy: policy,
      ...(dependencies === undefined
        ? {}
        : {
            allowedRuntimeDependencies: Object.freeze(
              dependencies.map((dependency) => Object.freeze({ ...dependency })),
            ),
          }),
    });
  }

  get interactiveValidationOptions(): DecksmithInteractiveValidationOptions {
    return this.validationOptions;
  }

  enableScientificCapability(
    capabilityId: string,
    requestedRuntime?: InteractiveRuntimeDependency,
  ): void {
    if (this.validationOptions.scientificCapabilityPolicy !== 'normal') {
      throw new DecksmithSessionError('Offline evaluation capability policies cannot be widened.');
    }
    if (!Object.hasOwn(EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits, capabilityId)) {
      throw new DecksmithSessionError('Unknown scientific capability.');
    }
    const v2Kit =
      EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits[
        capabilityId as keyof typeof EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits
      ];
    const v1Kit =
      EUCLIDEAN_GEOMETRY_CONTRACT.kits[
        capabilityId as keyof typeof EUCLIDEAN_GEOMETRY_CONTRACT.kits
      ];
    const kit =
      requestedRuntime === undefined
        ? v2Kit
        : [v1Kit, v2Kit].find(
            (candidate) =>
              candidate.runtimeId === requestedRuntime.id &&
              candidate.runtimeVersion === requestedRuntime.version,
          );
    if (kit === undefined) {
      throw new DecksmithSessionError('Geometry runtime does not match the requested capability.');
    }
    const dependencies = this.validationOptions.allowedRuntimeDependencies ?? [];
    if (dependencies.some((pin) => pin.id === kit.runtimeId && pin.version === kit.runtimeVersion))
      return;
    this.validationOptions = Object.freeze({
      scientificCapabilityPolicy: 'normal',
      allowedRuntimeDependencies: Object.freeze([
        ...dependencies,
        ...parseInteractiveRuntimeDependenciesValue([
          { id: kit.runtimeId, version: kit.runtimeVersion },
        ]).map((pin) => Object.freeze(pin)),
      ]),
    });
  }

  /**
   * 媒体生成状态只描述来源页（status.pageId）；其他页没有可信状态，不能拿来源页的锁去拦它们，
   * 否则来源页在生成音频时，改别页讲稿也会被误拒。
   */
  assertMediaMutationAllowed(category: 'narration' | 'audio' | 'animation', pageId: string): void {
    const status = this.mediaStatus;
    if (
      status !== undefined &&
      status.pageId === pageId &&
      status[category] === ('generating' as DecksmithPageMediaState)
    ) {
      throw new DecksmithSessionError(
        `[DECKSMITH_MEDIA_GENERATION_ACTIVE] Cannot modify ${category} while its generation is in progress (${status.reasonCode ?? 'media-generation-active'}).`,
      );
    }
  }

  get document(): ReachDeckDocumentV2 {
    return this.current;
  }

  get changed(): boolean {
    return this.mutated;
  }

  get suggestedActions(): readonly ReachDeckDecksmithSuggestedAction[] {
    return this.suggestions;
  }

  /**
   * Record an existing editor operation to offer as a button. It never changes the document and
   * never runs anything; the teacher decides after reading the reply.
   */
  suggestAction(action: ReachDeckDecksmithSuggestedAction): void {
    if (!isReachDeckDecksmithSuggestedActionKind(action.kind)) {
      throw new DecksmithSessionError(`Unknown page action kind: ${String(action.kind)}.`);
    }
    const page = this.readPage(action.pageId);
    if (page.sceneType !== 'slide' && page.sceneType !== 'interactive') {
      throw new DecksmithSessionError(
        `Page ${action.pageId} has no narration media or layout to regenerate.`,
      );
    }
    if (
      page.sceneType !== 'slide' &&
      REACH_DECK_DECKSMITH_SLIDE_ONLY_SUGGESTED_ACTION_KINDS.has(action.kind)
    ) {
      throw new DecksmithSessionError(
        `${action.kind} is only available for slide pages; page ${action.pageId} is ${page.sceneType}.`,
      );
    }
    if (action.kind === 'regenerate-page-animations') {
      // 仅重做动画依赖已有音频的逐段时间戳；没有时让模型改用会先合成音频的动作。
      const narration = this.readNativeSlide(action.pageId).narration;
      const segments = narration?.segments ?? [];
      const timed =
        narration?.audioResourceId !== undefined &&
        segments.length > 0 &&
        segments.every((segment) => segment.start !== undefined && segment.end !== undefined);
      if (!timed) {
        throw new DecksmithSessionError(
          `Page ${action.pageId} has no narration audio timing to animate from; offer generate-page-audio or regenerate-page-media instead.`,
        );
      }
    }
    if (
      this.suggestions.some((item) => item.kind === action.kind && item.pageId === action.pageId)
    ) {
      return;
    }
    if (this.suggestions.length >= REACH_DECK_DECKSMITH_SUGGESTED_ACTION_LIMIT) {
      throw new DecksmithSessionError('Too many suggested actions in one reply.');
    }
    this.suggestions.push({ kind: action.kind, pageId: action.pageId });
  }

  listPages(): DecksmithPageSummary[] {
    const nativePageIds = new Set(this.current.nativeSlides.map((binding) => binding.pageId));
    return [...this.current.pages]
      .sort((left, right) => left.order - right.order)
      .map((page) => ({
        pageId: page.pageId,
        order: page.order,
        sceneType: page.sceneType,
        title: page.title,
        revision: page.revision,
        native: nativePageIds.has(page.pageId),
      }));
  }

  readPage(pageId: string): ReachDeckPublishedPage {
    const page = this.current.pages.find((candidate) => candidate.pageId === pageId);
    if (page === undefined) {
      throw new DecksmithSessionError(
        `Page ${pageId} does not exist. Call list_pages to see valid page ids.`,
      );
    }
    return page;
  }

  readPageView(pageId: string): DecksmithPageView {
    const page = this.readPage(pageId);
    const binding = this.current.nativeSlides.find((candidate) => candidate.pageId === pageId);
    if (page.sceneType !== 'slide' && binding === undefined) {
      return {
        pageId: page.pageId,
        order: page.order,
        revision: page.revision,
        sceneType: page.sceneType,
        title: page.title,
        scene: page.scene,
      };
    }
    if (binding === undefined) {
      throw new DecksmithSessionError(`Page ${pageId} has no authoritative native slide binding.`);
    }
    return {
      pageId: page.pageId,
      order: page.order,
      revision: page.revision,
      sceneType: page.sceneType,
      title: page.title,
      nativeSlide: binding.slide,
    };
  }

  readNativeSlide(pageId: string): ReachDeckNativeSlideV2 {
    const page = this.readPage(pageId);
    if (page.sceneType !== 'slide') {
      throw new DecksmithSessionError(`Page ${pageId} is not a native slide page.`);
    }
    const binding = this.current.nativeSlides.find((candidate) => candidate.pageId === pageId);
    if (binding === undefined) {
      throw new DecksmithSessionError(`Page ${pageId} has no authoritative native slide binding.`);
    }
    return binding.slide;
  }

  setPageTitle(pageId: string, titleValue: string): ReachDeckPublishedPage {
    const title = nonblank(titleValue, 'title');
    const page = this.readPage(pageId);
    if (page.title === title) return page;
    this.transition((draft) => {
      const target = requireDraftPage(draft, pageId);
      target.title = title;
      if (target.sceneType !== 'slide') {
        target.scene = { ...target.scene, title };
      }
      touchPage(target, this.baselineRevisions);
      const binding = draft.nativeSlides.find((candidate) => candidate.pageId === pageId);
      if (binding !== undefined) binding.slide = { ...binding.slide, title };
    });
    return this.readPage(pageId);
  }

  upsertNativeText(input: DecksmithNativeTextInput): ReachDeckNativeSlideV2 {
    const text = nonblank(input.text, 'text');
    return this.updateNativeSlide(input.pageId, (slide, draft) => {
      const transform =
        input.transform === undefined ? undefined : validateTransform(input.transform, draft.stage);
      const index = slide.elements.findIndex((element) => element.id === input.elementId);
      const existing = index < 0 ? undefined : slide.elements[index];
      if (existing !== undefined && existing.type !== 'textFrame' && existing.type !== 'shape') {
        throw new DecksmithSessionError(
          `Element ${input.elementId} exists but cannot carry native rich text.`,
        );
      }
      const doc = buildDecksmithRichTextDoc({
        document: draft,
        text,
        previous:
          existing?.type === 'shape' || existing?.type === 'textFrame'
            ? existing.text?.doc
            : undefined,
        role: input.role,
        textColor: input.textColor,
        inlineBackgroundColor: input.inlineBackgroundColor,
      });
      let element: ReachDeckNativeElementV2;
      if (existing?.type === 'shape') {
        element = {
          ...existing,
          ...(transform === undefined ? {} : { transform }),
          ...(input.zIndex === undefined ? {} : { zIndex: input.zIndex }),
          text: { ...(existing.text ?? defaultTextFrame(doc)), doc },
          style: applyRequiredElementFill(existing.style, input.frameFillColor),
        };
      } else if (existing?.type === 'textFrame') {
        const { style: existingStyle, ...existingWithoutStyle } = existing;
        const style = applyOptionalElementFill(existingStyle, input.frameFillColor);
        element = {
          ...existingWithoutStyle,
          ...(transform === undefined ? {} : { transform }),
          ...(input.zIndex === undefined ? {} : { zIndex: input.zIndex }),
          text: { ...existing.text, doc },
          ...(style === undefined ? {} : { style }),
        };
      } else {
        element = {
          id: nonblank(input.elementId, 'elementId'),
          type: 'textFrame',
          transform: requireTransform(transform, draft.stage),
          zIndex: input.zIndex ?? nextZIndex(slide.elements),
          text: defaultTextFrame(doc),
          ...(input.frameFillColor === undefined || input.frameFillColor === null
            ? {}
            : { style: { fill: solidFill(input.frameFillColor) } }),
        };
      }
      assertDecksmithNativeTextColorsAreDistinct(element, draft);
      slide.elements = replaceOrAppend(slide.elements, index, element);
      draft;
      return slide;
    });
  }

  /**
   * Edit one cell of a native table in place. Generated slides compile HTML tables to native
   * `table` elements, so cell text is not a textFrame and upsertNativeText cannot reach it.
   */
  setNativeTableCell(input: DecksmithNativeTableCellInput): ReachDeckNativeSlideV2 {
    const text = input.text === undefined ? undefined : nonblank(input.text, 'text');
    if (text === undefined && input.textColor === undefined && input.fillColor === undefined) {
      throw new DecksmithSessionError('Provide text, textColor, or fillColor for the table cell.');
    }
    return this.updateNativeSlide(input.pageId, (slide, draft) => {
      let found = false;
      const editTable = (element: ReachDeckNativeElementV2): ReachDeckNativeElementV2 => {
        if (element.type === 'group') {
          return { ...element, children: element.children.map(editTable) };
        }
        if (element.type !== 'table' || element.id !== input.elementId) return element;
        return {
          ...element,
          rows: element.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => {
              if (cell.id !== input.cellId) return cell;
              found = true;
              const next = {
                ...cell,
                ...(text === undefined
                  ? input.textColor === undefined
                    ? {}
                    : {
                        text: {
                          ...cell.text,
                          doc: applyRichTextColor(cell.text.doc, input.textColor),
                        },
                      }
                  : {
                      text: {
                        ...cell.text,
                        doc: buildDecksmithRichTextDoc({
                          document: draft,
                          text,
                          previous: cell.text.doc,
                          role: undefined,
                          textColor: input.textColor,
                          inlineBackgroundColor: undefined,
                        }),
                      },
                    }),
                style: applyRequiredElementFill(cell.style, input.fillColor),
              };
              assertDecksmithNativeTextColorsAreDistinct(next, draft);
              return next;
            }),
          })),
        };
      };
      const elements = slide.elements.map(editTable);
      if (!found) {
        throw new DecksmithSessionError(
          `Table ${input.elementId} has no cell ${input.cellId}. Read the page and use the exact table element id and cell id.`,
        );
      }
      slide.elements = elements;
      return slide;
    });
  }

  upsertNativeAnimation(input: DecksmithNativeAnimationInput): ReachDeckNativeSlideV2 {
    this.assertMediaMutationAllowed('animation', input.pageId);
    const id = nonblank(input.id, 'animation id');
    if (id.startsWith(REACH_DECK_NARRATION_ANIMATION_ID_PREFIX)) {
      throw new DecksmithSessionError(
        `Animation ids starting with ${REACH_DECK_NARRATION_ANIMATION_ID_PREFIX} are reserved for narration materialization.`,
      );
    }
    const existingSlide = this.readNativeSlide(input.pageId);
    // 文档允许保留孤儿动画（目标已删除），但 Decksmith 不能新造：目标必须在元素树里。
    if (!collectReachDeckNativeElementIds(existingSlide.elements).has(input.targetId)) {
      throw new DecksmithSessionError(`Animation target ${input.targetId} does not exist`);
    }
    if (
      existingSlide.elements.some(
        (element) => element.id === input.targetId && element.type === 'scientificVisual',
      )
    ) {
      throw new DecksmithSessionError(
        'Scientific visual content is presentation-owned; use page regeneration instead of generic animations.',
      );
    }
    const animation: ReachDeckAnimationV2 = {
      id,
      targetId: nonblank(input.targetId, 'animation targetId'),
      trigger: input.trigger,
      effect: input.effect,
      start: input.start,
      duration: input.duration,
      ...(input.delay === undefined ? {} : { delay: input.delay }),
      ...(input.easing === undefined ? {} : { easing: input.easing }),
      ...(input.from === undefined ? {} : { from: normalizeDecksmithAnimationValues(input.from) }),
      ...(input.to === undefined ? {} : { to: normalizeDecksmithAnimationValues(input.to) }),
    };
    return this.updateNativeSlide(input.pageId, (slide) => {
      const index = slide.animations.findIndex((candidate) => candidate.id === id);
      slide.animations =
        index < 0
          ? [...slide.animations, animation]
          : slide.animations.map((candidate, candidateIndex) =>
              candidateIndex === index ? animation : candidate,
            );
      return slide;
    });
  }

  removeNativeAnimation(pageId: string, animationIdValue: string): ReachDeckNativeSlideV2 {
    this.assertMediaMutationAllowed('animation', pageId);
    const animationId = nonblank(animationIdValue, 'animation id');
    if (animationId.startsWith(REACH_DECK_NARRATION_ANIMATION_ID_PREFIX)) {
      throw new DecksmithSessionError(
        'Narration-driven animations must be changed through narration regeneration.',
      );
    }
    return this.updateNativeSlide(pageId, (slide) => {
      if (!slide.animations.some((animation) => animation.id === animationId)) {
        throw new DecksmithSessionError(`Animation ${animationId} does not exist.`);
      }
      return {
        ...slide,
        animations: slide.animations.filter((animation) => animation.id !== animationId),
      };
    });
  }

  upsertNativeShape(input: DecksmithNativeShapeInput): ReachDeckNativeSlideV2 {
    return this.updateNativeSlide(input.pageId, (slide, draft) => {
      const transform =
        input.transform === undefined ? undefined : validateTransform(input.transform, draft.stage);
      const index = slide.elements.findIndex((element) => element.id === input.elementId);
      const existing = index < 0 ? undefined : slide.elements[index];
      if (existing !== undefined && existing.type !== 'shape') {
        throw new DecksmithSessionError(`Element ${input.elementId} exists but is not a shape.`);
      }
      const existingStyle = existing?.style ?? {};
      const style = applyRequiredElementFill(existingStyle, input.fillColor);
      const stroke =
        input.strokeColor === undefined
          ? existingStyle.stroke
          : {
              width: input.strokeWidth ?? existingStyle.stroke?.width ?? 1,
              fill: color(input.strokeColor),
            };
      const parsedText =
        input.text === undefined
          ? undefined
          : compileReachDeckSemanticTypographyV2({
              document: draft,
              doc: inheritDecksmithRichTextTypography(
                existing?.text?.doc,
                parseRestrictedMarkdown(input.text).doc,
              ),
            });
      const element: ReachDeckNativeElementV2 = {
        ...(existing ?? {
          id: nonblank(input.elementId, 'elementId'),
          type: 'shape' as const,
          transform: requireTransform(transform, draft.stage),
          zIndex: input.zIndex ?? nextZIndex(slide.elements),
        }),
        ...(transform === undefined ? {} : { transform }),
        ...(input.zIndex === undefined ? {} : { zIndex: input.zIndex }),
        geometry: { kind: 'preset', preset: nonblank(input.preset, 'preset') },
        style: {
          ...style,
          ...(stroke === undefined ? {} : { stroke }),
        },
        ...(input.text === undefined
          ? existing?.text === undefined
            ? {}
            : { text: existing.text }
          : {
              text:
                existing?.text === undefined
                  ? defaultTextFrame(parsedText!)
                  : { ...existing.text, doc: parsedText! },
            }),
      };
      slide.elements = replaceOrAppend(slide.elements, index, element);
      return slide;
    });
  }

  /** Transform an existing top-level native element without changing its subtype payload. */
  transformNativeElement(input: DecksmithNativeTransformInput): DecksmithNativeTransformReceipt {
    const before = this.readNativeSlide(input.pageId);
    const elementId = nonblank(input.elementId, 'elementId');
    const beforeElement = before.elements.find((element) => element.id === elementId);
    if (beforeElement === undefined) {
      throw new DecksmithSessionError(
        `Element ${elementId} does not exist on page ${input.pageId}.`,
      );
    }
    const validated = validateTransform(input.transform, this.current.stage);
    const beforeState = transformState(beforeElement);
    const sameTransform = transformValuesEqual(beforeElement.transform, validated);
    const sameZ = input.zIndex === undefined || beforeElement.zIndex === input.zIndex;
    if (sameTransform && sameZ) {
      return {
        pageId: input.pageId,
        elementId,
        changed: false,
        before: beforeState,
        after: beforeState,
        revision: this.readPage(input.pageId).revision,
        slide: before,
      };
    }
    const slide = this.updateNativeSlide(input.pageId, (candidate) => ({
      ...candidate,
      elements: candidate.elements.map((element) =>
        element.id !== elementId
          ? element
          : {
              ...element,
              transform: validated,
              ...(input.zIndex === undefined ? {} : { zIndex: input.zIndex }),
            },
      ),
    }));
    const afterElement = slide.elements.find((element) => element.id === elementId)!;
    return {
      pageId: input.pageId,
      elementId,
      changed: true,
      before: beforeState,
      after: transformState(afterElement),
      revision: this.readPage(input.pageId).revision,
      slide,
    };
  }

  /** Generated decks write `layouts: []`; layout binding is meaningless without resources. */
  hasLayoutResources(): boolean {
    return this.current.resources.layouts.length > 0;
  }

  setNativeLayout(pageId: string, layoutId: string | null): ReachDeckNativeSlideV2 {
    return this.updateNativeSlide(pageId, (slide, draft) => {
      if (
        layoutId !== null &&
        !draft.resources.layouts.some((candidate) => candidate.id === layoutId)
      ) {
        throw new DecksmithSessionError(`Layout ${layoutId} does not exist in document.resources.`);
      }
      const { layoutId: _current, ...rest } = slide;
      return layoutId === null ? rest : { ...rest, layoutId };
    });
  }

  /**
   * Place elements drafted by the HTML brush onto a slide, optionally removing the elements they
   * replace. Draft ids are replaced by fresh page-scoped ids; animations that targeted removed
   * elements are dropped. Returns the new ids and any overlap with elements that stay on the page.
   */
  placeDraftElements(input: {
    pageId: string;
    elements: readonly ReachDeckNativeElementV2[];
    resources: readonly ReachDeckMediaResourceV2[];
    removeElementIds: readonly string[];
  }): { slide: ReachDeckNativeSlideV2; placedIds: string[]; overlaps: string[] } {
    const placement = this.draftPlacementMutation(input);
    const slide = this.updateNativeSlide(input.pageId, placement.mutation);
    return { slide, placedIds: placement.placedIds, overlaps: placement.overlaps };
  }

  /**
   * Run every check placeDraftElements would, against a copy of the document, without changing
   * it. Callers use this before paying for side effects such as uploading the draft's media.
   * `resources` may hold placeholders shaped like the real ones.
   */
  validateDraftPlacement(input: {
    pageId: string;
    elements: readonly ReachDeckNativeElementV2[];
    resources: readonly ReachDeckMediaResourceV2[];
    removeElementIds: readonly string[];
  }): void {
    const placement = this.draftPlacementMutation(input);
    this.readNativeSlide(input.pageId);
    this.buildTransition(this.nativeSlideMutator(input.pageId, placement.mutation));
  }

  private draftPlacementMutation(input: {
    elements: readonly ReachDeckNativeElementV2[];
    resources: readonly ReachDeckMediaResourceV2[];
    removeElementIds: readonly string[];
  }) {
    if (input.elements.length === 0) {
      throw new DecksmithSessionError('Choose at least one drafted element to place.');
    }
    const placedIds: string[] = [];
    const overlaps: string[] = [];
    const mutation = (current: ReachDeckNativeSlideV2, draft: ReachDeckDocumentV2) => {
      placedIds.length = 0;
      overlaps.length = 0;
      const removed = new Set(input.removeElementIds);
      for (const id of removed) {
        if (!current.elements.some((element) => element.id === id)) {
          throw new DecksmithSessionError(`Element ${id} is not a top-level element on this page.`);
        }
      }
      const kept = current.elements.filter((element) => !removed.has(element.id));
      const prefix = `${current.id}:draft-${randomUUID().slice(0, 8)}`;
      let counter = 0;
      const rename = (element: ReachDeckNativeElementV2): ReachDeckNativeElementV2 => {
        const id = `${prefix}-${++counter}`;
        return element.type === 'group'
          ? { ...structuredClone(element), id, children: element.children.map(rename) }
          : { ...structuredClone(element), id };
      };
      const baseZ = nextZIndex(kept);
      const placed = input.elements.map((element, index) => ({
        ...rename(element),
        zIndex: baseZ + index,
      }));
      for (const element of placed) {
        validateTransform(element.transform, draft.stage);
        placedIds.push(element.id);
        for (const other of kept) {
          if (rectanglesOverlap(element.transform, other.transform)) {
            overlaps.push(`${element.id} overlaps ${other.id}`);
          }
        }
      }
      for (const resource of input.resources) upsertMediaResource(draft, resource);
      current.elements = [...kept, ...placed];
      current.animations = current.animations.filter(
        (animation) => !removed.has(animation.targetId),
      );
      return current;
    };
    return { mutation, placedIds, overlaps };
  }

  bindImage(input: DecksmithImageBindingInput): ReachDeckNativeSlideV2 {
    return this.updateNativeSlide(input.pageId, (slide, draft) => {
      const transform =
        input.transform === undefined ? undefined : validateTransform(input.transform, draft.stage);
      upsertMediaResource(draft, input.resource);
      const index = slide.elements.findIndex((element) => element.id === input.elementId);
      if (index < 0) {
        // 组合内的图片：只改绑资源（与可选的 alt / fit），位置与层级跟随组合，不在顶层另建元素。
        const nested = findDecksmithNativeElement(slide.elements, input.elementId);
        if (nested !== undefined) {
          if (nested.type !== 'image') {
            throw new DecksmithSessionError(
              `Element ${input.elementId} exists but is not an image.`,
            );
          }
          if (transform !== undefined || input.zIndex !== undefined) {
            throw new DecksmithSessionError(
              `Image ${input.elementId} is inside a group; omit transform and zIndex to keep its position.`,
            );
          }
          slide.elements = replaceDecksmithNativeElement(slide.elements, input.elementId, {
            ...nested,
            ...(input.alt === undefined ? {} : { alt: input.alt }),
            ...(input.fit === undefined ? {} : { fit: input.fit }),
            resourceId: input.resource.id,
          });
          return slide;
        }
      }
      const existing = index < 0 ? undefined : slide.elements[index];
      if (existing !== undefined && existing.type !== 'image') {
        throw new DecksmithSessionError(`Element ${input.elementId} exists but is not an image.`);
      }
      const element: ReachDeckNativeElementV2 = {
        ...(existing ?? {
          id: nonblank(input.elementId, 'elementId'),
          type: 'image' as const,
          transform: requireTransform(transform, draft.stage),
          zIndex: input.zIndex ?? nextZIndex(slide.elements),
          alt: nonblank(input.alt, 'alt'),
          fit: input.fit ?? 'cover',
        }),
        ...(transform === undefined ? {} : { transform }),
        ...(input.zIndex === undefined ? {} : { zIndex: input.zIndex }),
        ...(input.alt === undefined ? {} : { alt: input.alt }),
        ...(input.fit === undefined ? {} : { fit: input.fit }),
        resourceId: input.resource.id,
      };
      slide.elements = replaceOrAppend(slide.elements, index, element);
      return slide;
    });
  }

  setNarrationMarkdown(pageId: string, markdown: string): ReachDeckNativeSlideV2 {
    this.assertMediaMutationAllowed('narration', pageId);
    const slide = this.readNativeSlide(pageId);
    if (slide.elements.some((element) => element.type === 'scientificVisual')) {
      throw new DecksmithSessionError(
        'Scientific visual narration anchors are regenerated atomically with page narration; use narration regeneration.',
      );
    }
    const updated = this.updateNativeSlide(pageId, (slide) =>
      invalidateReachDeckNativeSlideNarration(slide, markdown),
    );
    this.narrationWrittenPageIds.add(pageId);
    return updated;
  }

  /**
   * 声明采用后由服务端自动生成本页媒体（WP8，v5 工具 schedule_page_media_after_apply）。
   *
   * 核心逻辑：只接受幻灯片页；本次运行必须已为该页写过讲稿；讲稿生成锁生效时拒绝；
   * 每页一条、总数有上限。结果时还会对照基线再校验一次讲稿确有变化（afterApplyActions）。
   */
  scheduleMediaAfterApply(action: ReachDeckDecksmithAfterApplyAction): void {
    if (!isReachDeckDecksmithAfterApplyKind(action.kind)) {
      throw new DecksmithSessionError(`Unknown after-apply media kind: ${String(action.kind)}.`);
    }
    const page = this.readPage(action.pageId);
    if (page.sceneType !== 'slide') {
      throw new DecksmithSessionError(
        `[DECKSMITH_AFTER_APPLY_SLIDE_ONLY] Page ${action.pageId} is ${page.sceneType}; only slide narration can be scheduled.`,
      );
    }
    if (!this.narrationWrittenPageIds.has(action.pageId)) {
      throw new DecksmithSessionError(
        `[DECKSMITH_AFTER_APPLY_REQUIRES_NARRATION] Write the narration of ${action.pageId} with set_native_narration in this run first; use suggest_page_action for media of narration you did not write.`,
      );
    }
    this.assertMediaMutationAllowed('narration', action.pageId);
    if (
      !this.afterApply.has(action.pageId) &&
      this.afterApply.size >= REACH_DECK_DECKSMITH_AFTER_APPLY_LIMIT
    ) {
      throw new DecksmithSessionError(
        `At most ${REACH_DECK_DECKSMITH_AFTER_APPLY_LIMIT} pages can be scheduled in one run.`,
      );
    }
    this.afterApply.set(action.pageId, { kind: action.kind, pageId: action.pageId });
  }

  /** 结果里的采用后媒体意图：对照基线与当前候选再校验一次（讲稿仍有变化、页面仍是幻灯片）。 */
  get afterApplyActions(): readonly ReachDeckDecksmithAfterApplyAction[] {
    if (this.afterApply.size === 0) return [];
    return validateDecksmithAfterApplyActions({
      baseline: this.baseline,
      candidate: this.current,
      actions: [...this.afterApply.values()],
    });
  }

  replaceScene(
    pageId: string,
    sceneType: Exclude<ReachDeckSceneType, 'slide'>,
    sceneValue: unknown,
  ): ReachDeckPublishedPage {
    const current = this.readPage(pageId);
    if (current.sceneType !== sceneType) {
      throw new DecksmithSessionError(
        `Page ${pageId} is ${current.sceneType}; ${sceneType} operations cannot change its type.`,
      );
    }
    const scene = parseScene(sceneType, sceneValue, pageId, this.interactiveValidationOptions);
    this.transition((draft) => {
      const page = requireDraftPage(draft, pageId);
      if (page.sceneType === 'slide') {
        throw new DecksmithSessionError(`Page ${pageId} does not accept a non-slide scene.`);
      }
      page.title = scene.title;
      page.scene = scene as typeof page.scene;
      touchPage(page, this.baselineRevisions);
    });
    return this.readPage(pageId);
  }

  replaceWithInteractiveScene(pageId: string, sceneValue: unknown): ReachDeckPublishedPage {
    const current = this.readPage(pageId);
    const scene = createGeneratedInteractiveSceneParser(
      pageId,
      this.interactiveValidationOptions,
    )(sceneValue);
    if (current.sceneType === 'slide') {
      this.assertMediaMutationAllowed('narration', pageId);
      this.assertMediaMutationAllowed('audio', pageId);
      this.assertMediaMutationAllowed('animation', pageId);
    }
    this.transition((draft) => {
      const index = draft.pages.findIndex((page) => page.pageId === pageId);
      draft.pages[index] = {
        pageId,
        order: current.order,
        revision: this.baselineRevisions.has(pageId) ? this.baselineRevisions.get(pageId)! + 1 : 1,
        sceneType: 'interactive',
        title: scene.title,
        scene,
      };
      draft.nativeSlides = draft.nativeSlides.filter((binding) => binding.pageId !== pageId);
    });
    return this.readPage(pageId);
  }

  reservePageId(): string {
    const pageId = this.nextPageId();
    this.reservedPageIds.add(pageId);
    return pageId;
  }

  insertSlidePage(titleValue: string, position?: number): ReachDeckPublishedPage {
    const title = nonblank(titleValue, 'title');
    const pageId = this.nextPageId();
    const titleTransform = {
      x: this.current.stage.width * 0.05,
      y: this.current.stage.height * 0.08,
      width: this.current.stage.width * 0.7,
      height: this.current.stage.height * 0.14,
    };
    const page: ReachDeckPublishedPage = {
      pageId,
      order: 1,
      revision: 1,
      sceneType: 'slide',
      title,
    } as ReachDeckPublishedPage;
    const slide: ReachDeckNativeSlideV2 = {
      schemaVersion: 'reach-deck-slide/v2',
      textCompatibility: 'native',
      id: `${pageId}:native`,
      title,
      // Generated decks paint the course background on every slide; a new page should match its
      // neighbours instead of appearing as the only blank page.
      background: this.neighbouringSlideBackground(position),
      elements: [
        {
          id: `${pageId}:title`,
          type: 'textFrame',
          transform: titleTransform,
          zIndex: 1,
          text: defaultTextFrame(
            compileReachDeckSemanticTypographyV2({
              document: this.current,
              doc: richTextFromPlainText(title),
              role: 'title',
            }),
          ),
        },
      ],
      animations: [],
    };
    this.insertPage(page, { pageId, slide }, position);
    return this.readPage(pageId);
  }

  private neighbouringSlideBackground(position?: number): ReachDeckNativeSlideV2['background'] {
    const ordered = [...this.current.pages].sort((left, right) => left.order - right.order);
    const insertAt = Math.min(Math.max((position ?? ordered.length + 1) - 1, 0), ordered.length);
    const candidates = [...ordered.slice(0, insertAt).reverse(), ...ordered.slice(insertAt)];
    for (const page of candidates) {
      const binding = this.current.nativeSlides.find((item) => item.pageId === page.pageId);
      if (binding !== undefined) return structuredClone(binding.slide.background);
    }
    return { kind: 'none' };
  }

  insertScenePage(
    sceneType: DecksmithInsertSceneType,
    sceneValue: unknown,
    position?: number,
    reservedPageId?: string,
  ): ReachDeckPublishedPage {
    if (typeof sceneValue !== 'object' || sceneValue === null || Array.isArray(sceneValue)) {
      throw new DecksmithSessionError(`${sceneType} scene must be an object.`);
    }
    const pageId = reservedPageId ?? this.nextPageId();
    if (reservedPageId !== undefined && !this.reservedPageIds.has(reservedPageId)) {
      throw new DecksmithSessionError(
        'Interactive page identity was not reserved by this session.',
      );
    }
    const scene = parseScene(
      sceneType,
      { ...sceneValue, id: pageId },
      pageId,
      this.interactiveValidationOptions,
    );
    const page: ReachDeckPublishedPage = {
      pageId,
      order: 1,
      revision: 1,
      sceneType,
      title: scene.title,
      scene,
    } as ReachDeckPublishedPage;
    this.insertPage(page, undefined, position);
    if (reservedPageId !== undefined) this.reservedPageIds.delete(reservedPageId);
    return this.readPage(pageId);
  }

  deletePage(pageId: string): void {
    this.readPage(pageId);
    if (this.current.pages.length === 1) {
      throw new DecksmithSessionError('Cannot delete the only page of the document.');
    }
    this.transition((draft) => {
      draft.pages = draft.pages
        .filter((page) => page.pageId !== pageId)
        .map((page, index) => ({ ...page, order: index + 1 }));
      draft.nativeSlides = draft.nativeSlides.filter((binding) => binding.pageId !== pageId);
    });
  }

  movePage(pageId: string, position: number): void {
    this.readPage(pageId);
    const target = clampPosition(position, this.current.pages.length) - 1;
    this.transition((draft) => {
      const sorted = [...draft.pages].sort((left, right) => left.order - right.order);
      const from = sorted.findIndex((page) => page.pageId === pageId);
      const [moved] = sorted.splice(from, 1);
      sorted.splice(target, 0, moved!);
      draft.pages = sorted.map((page, index) => ({ ...page, order: index + 1 }));
    });
  }

  private nextPageId(): string {
    for (;;) {
      const candidate = `${this.current.id}:decksmith-page-${randomUUID()}`;
      if (!this.issuedPageIds.has(candidate)) {
        this.issuedPageIds.add(candidate);
        return candidate;
      }
    }
  }

  private insertPage(
    page: ReachDeckPublishedPage,
    binding: ReachDeckDocumentV2['nativeSlides'][number] | undefined,
    position?: number,
  ): void {
    const target = clampPosition(position, this.current.pages.length + 1) - 1;
    this.transition((draft) => {
      const pages = [...draft.pages].sort((left, right) => left.order - right.order);
      pages.splice(target, 0, page);
      draft.pages = pages.map((candidate, index) => ({ ...candidate, order: index + 1 }));
      if (binding !== undefined) draft.nativeSlides.push(binding);
    });
  }

  private updateNativeSlide(
    pageId: string,
    mutation: (slide: ReachDeckNativeSlideV2, draft: ReachDeckDocumentV2) => ReachDeckNativeSlideV2,
  ): ReachDeckNativeSlideV2 {
    this.readNativeSlide(pageId);
    this.transition(this.nativeSlideMutator(pageId, mutation));
    return this.readNativeSlide(pageId);
  }

  private nativeSlideMutator(
    pageId: string,
    mutation: (slide: ReachDeckNativeSlideV2, draft: ReachDeckDocumentV2) => ReachDeckNativeSlideV2,
  ) {
    return (draft: ReachDeckDocumentV2) => {
      const binding = draft.nativeSlides.find((candidate) => candidate.pageId === pageId)!;
      binding.slide = parseReachDeckNativeSlideV2(mutation(structuredClone(binding.slide), draft));
      const page = requireDraftPage(draft, pageId);
      page.title = binding.slide.title;
      touchPage(page, this.baselineRevisions);
    };
  }

  private transition(mutator: (draft: ReachDeckDocumentV2) => void): void {
    const parsed = this.buildTransition(mutator);
    if (valuesEqual(parsed, this.current)) return;
    this.current = parsed;
    this.mutated = true;
  }

  /** Apply and fully validate a mutation on a copy of the document without committing it. */
  private buildTransition(mutator: (draft: ReachDeckDocumentV2) => void): ReachDeckDocumentV2 {
    assertSemanticConsistency(this.current);
    const draft = structuredClone(this.current);
    try {
      mutator(draft);
      const parsed = parseReachDeckDocument(draft);
      if (parsed.schemaVersion !== 'reach-deck-document/v2') {
        throw new Error('Decksmith transition unexpectedly downgraded the document.');
      }
      assertSemanticConsistency(parsed);
      assertReachDeckDocumentTransition(this.baseline, parsed);
      return parsed;
    } catch (error) {
      if (error instanceof DecksmithSessionError) throw error;
      throw new DecksmithSessionError(
        error instanceof Error ? error.message : 'The edited document failed v2 validation.',
      );
    }
  }
}

export function assertDecksmithV2DocumentConsistency(document: unknown): void {
  const parsed = parseReachDeckDocument(document);
  if (parsed.schemaVersion !== 'reach-deck-document/v2') {
    throw new DecksmithSessionError('Decksmith v2 does not accept legacy document/v1 content.');
  }
  assertSemanticConsistency(parsed);
}

function assertSemanticConsistency(document: ReachDeckDocumentV2): void {
  const bindings = new Map(document.nativeSlides.map((binding) => [binding.pageId, binding.slide]));
  const mediaIds = new Set(document.resources.media.map((resource) => resource.id));
  for (const page of document.pages) {
    const native = bindings.get(page.pageId);
    if (page.sceneType === 'slide') {
      if (native === undefined) {
        throw new DecksmithSessionError(
          `Slide page ${page.pageId} has no authoritative nativeSlides binding.`,
        );
      }
      if ('scene' in page && page.scene !== undefined) {
        throw new DecksmithSessionError(
          `Slide page ${page.pageId} contains an incompatible legacy scene projection.`,
        );
      }
      if (native.title !== page.title) {
        throw new DecksmithSessionError(
          `Slide page ${page.pageId} title projections do not match nativeSlides.`,
        );
      }
      const report = analyzeReachDeckNativeSlideV2Capabilities(native, {
        consumer: 'reach-deck-decksmith',
        version: 'v2',
        supportedFeatures: new Set(REACH_DECK_NATIVE_V2_SCHEMA_FEATURES),
      });
      if (!report.compatible) {
        throw new DecksmithSessionError(
          `Slide page ${page.pageId} requires unsupported native capability ${report.diagnostics[0]?.feature}.`,
        );
      }
      if (
        native.narration?.audioResourceId !== undefined &&
        !mediaIds.has(native.narration.audioResourceId)
      ) {
        throw new DecksmithSessionError(
          `Slide page ${page.pageId} narration references an unknown media resource.`,
        );
      }
    } else {
      if (native !== undefined) {
        throw new DecksmithSessionError(
          `Non-slide page ${page.pageId} cannot have a nativeSlides binding.`,
        );
      }
      if (!('scene' in page) || page.scene === undefined || page.scene.title !== page.title) {
        throw new DecksmithSessionError(`Page ${page.pageId} title projections are inconsistent.`);
      }
      if (
        page.sceneType === 'interactive' &&
        page.scene.narration?.audioResourceId !== undefined &&
        !mediaIds.has(page.scene.narration.audioResourceId)
      ) {
        throw new DecksmithSessionError(
          `Interactive page ${page.pageId} narration references an unknown media resource.`,
        );
      }
    }
  }
}

function parseScene(
  sceneType: Exclude<ReachDeckSceneType, 'slide'>,
  value: unknown,
  pageId: string,
  options: DecksmithInteractiveValidationOptions,
) {
  switch (sceneType) {
    case 'quiz':
      return parseQuizSceneValue(value, pageId);
    case 'interactive':
      return createGeneratedInteractiveSceneParser(pageId, options)(value);
  }
}

function touchPage(
  page: ReachDeckPublishedPage,
  baselineRevisions: ReadonlyMap<string, number>,
): void {
  const baselineRevision = baselineRevisions.get(page.pageId);
  page.revision = baselineRevision === undefined ? 1 : baselineRevision + 1;
}

function requireDraftPage(document: ReachDeckDocumentV2, pageId: string): ReachDeckPublishedPage {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) throw new DecksmithSessionError(`Page ${pageId} does not exist.`);
  return page;
}

function defaultTextFrame(doc: RichTextDocument): ReachDeckTextFrameV2 {
  return {
    margins: { left: 8, top: 4, right: 8, bottom: 4 },
    verticalAlignment: 'top',
    wrap: true,
    autofit: { mode: 'shrink-text', fontScale: 1, lineSpacingReduction: 0 },
    doc,
    fontSubstitutions: [],
  };
}

function color(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) {
    throw new DecksmithSessionError('Colors must use #RRGGBB.');
  }
  return { kind: 'srgb' as const, value: normalized };
}

function normalizeDecksmithAnimationValues(
  values: Readonly<Record<string, number | string>>,
): Record<string, number | string> {
  const normalized = { ...values };
  if (!Object.prototype.hasOwnProperty.call(normalized, 'color')) return normalized;
  if (typeof normalized.color !== 'string') {
    throw new DecksmithSessionError('Animation color must use #RRGGBB.');
  }
  normalized.color = color(normalized.color).value.toUpperCase();
  return normalized;
}

function solidFill(value: string): ReachDeckFillV2 {
  return { kind: 'solid', color: color(value) };
}

function applyOptionalElementFill(
  style: ReachDeckElementStyleV2 | undefined,
  value: string | null | undefined,
): ReachDeckElementStyleV2 | undefined {
  if (value === undefined) return style;
  const next = { ...(style ?? {}) };
  if (value === null) delete next.fill;
  else next.fill = solidFill(value);
  return Object.keys(next).length === 0 ? undefined : next;
}

function applyRequiredElementFill(
  style: ReachDeckElementStyleV2,
  value: string | null | undefined,
): ReachDeckElementStyleV2 {
  return applyOptionalElementFill(style, value) ?? {};
}

function applyRichTextColor(document: RichTextDocument, value: string): RichTextDocument {
  const textColor = color(value).value;
  const visit = (node: RichTextNode): RichTextNode => {
    const content = node.content?.map(visit);
    if (node.type !== 'text') {
      return { ...node, ...(content === undefined ? {} : { content }) };
    }
    const marks = [...(node.marks ?? [])];
    const index = marks.findIndex((mark) => mark.type === 'textStyle');
    const textStyle = {
      type: 'textStyle',
      attrs: {
        ...(index < 0 ? {} : (marks[index]?.attrs ?? {})),
        color: textColor,
      },
    };
    if (index < 0) marks.unshift(textStyle);
    else marks[index] = textStyle;
    return { ...node, marks, ...(content === undefined ? {} : { content }) };
  };
  return {
    ...document,
    ...(document.content === undefined ? {} : { content: document.content.map(visit) }),
  };
}

function applyRichTextBackground(
  document: RichTextDocument,
  value: string | null,
): RichTextDocument {
  const backgroundColor = value === null ? undefined : color(value).value;
  const visit = (node: RichTextNode): RichTextNode => {
    const content = node.content?.map(visit);
    if (node.type !== 'text') {
      return { ...node, ...(content === undefined ? {} : { content }) };
    }
    const marks = [...(node.marks ?? [])];
    const index = marks.findIndex((mark) => mark.type === 'textStyle');
    const attrs = { ...(index < 0 ? {} : (marks[index]?.attrs ?? {})) };
    if (backgroundColor === undefined) delete attrs.backgroundColor;
    else attrs.backgroundColor = backgroundColor;
    if (Object.keys(attrs).length === 0) {
      if (index >= 0) marks.splice(index, 1);
    } else {
      const textStyle = { type: 'textStyle', attrs };
      if (index < 0) marks.unshift(textStyle);
      else marks[index] = textStyle;
    }
    const next = { ...node, ...(content === undefined ? {} : { content }) };
    if (marks.length === 0) delete next.marks;
    else next.marks = marks;
    return next;
  };
  return {
    ...document,
    ...(document.content === undefined ? {} : { content: document.content.map(visit) }),
  };
}

/** Restricted Markdown → theme typography → optional colors, keeping the previous run styling. */
function buildDecksmithRichTextDoc(input: {
  document: ReachDeckDocumentV2;
  text: string;
  previous: RichTextDocument | undefined;
  role: ReachDeckSemanticTextRole | undefined;
  textColor: string | undefined;
  inlineBackgroundColor: string | null | undefined;
}): RichTextDocument {
  const parsedDoc = parseRestrictedMarkdown(input.text).doc;
  const inheritedDoc =
    input.previous === undefined
      ? parsedDoc
      : inheritDecksmithRichTextTypography(input.previous, parsedDoc);
  const semanticDoc = compileReachDeckSemanticTypographyV2({
    document: input.document,
    doc: inheritedDoc,
    role: input.role,
  });
  const coloredDoc =
    input.textColor === undefined ? semanticDoc : applyRichTextColor(semanticDoc, input.textColor);
  return input.inlineBackgroundColor === undefined
    ? coloredDoc
    : applyRichTextBackground(coloredDoc, input.inlineBackgroundColor);
}

function assertDecksmithNativeTextColorsAreDistinct(
  element: { text?: { doc: RichTextDocument }; style?: { fill?: ReachDeckFillV2 } },
  document: ReachDeckDocumentV2,
): void {
  const frameColor = resolveDecksmithSolidFillColor(element.style?.fill, document);
  const visit = (nodes: RichTextNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      const style = node.marks?.find((mark) => mark.type === 'textStyle')?.attrs;
      const foreground = normalizeDecksmithHexColor(
        typeof node.text === 'string' ? style?.color : node.attrs?.color,
      );
      const inlineBackground = normalizeDecksmithHexColor(
        typeof node.text === 'string' ? style?.backgroundColor : node.attrs?.backgroundColor,
      );
      if (foreground !== undefined && foreground === inlineBackground) {
        throw new DecksmithSessionError(
          '[DECKSMITH_TEXT_CONTRAST_INVALID] Native text foreground and inline background must use different colors. Choose a contrasting textColor or clear inlineBackgroundColor.',
        );
      }
      if (foreground !== undefined && foreground === frameColor) {
        throw new DecksmithSessionError(
          '[DECKSMITH_TEXT_CONTRAST_INVALID] Native text foreground and frame background must use different colors. Choose a contrasting textColor or clear frameFillColor.',
        );
      }
      visit(node.content);
    }
  };
  visit(element.text?.doc.content);
}

function resolveDecksmithSolidFillColor(
  fill: ReachDeckFillV2 | undefined,
  document: ReachDeckDocumentV2,
): string | undefined {
  if (fill?.kind !== 'solid') return undefined;
  if (fill.color.alpha === 0) return undefined;
  if (fill.color.kind === 'srgb') return normalizeDecksmithHexColor(fill.color.value);
  if (fill.color.tint !== undefined || fill.color.shade !== undefined) return undefined;
  const theme = document.resources.themes.find(
    (candidate) => candidate.id === document.defaultThemeId,
  );
  return normalizeDecksmithHexColor(theme?.colors[fill.color.token]);
}

function normalizeDecksmithHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  const long = /^#[0-9a-f]{6}$/.exec(normalized);
  if (long !== null) return long[0];
  const short = /^#([0-9a-f]{3})$/.exec(normalized);
  return short === null
    ? undefined
    : `#${[...short[1]!].map((digit) => `${digit}${digit}`).join('')}`;
}

const DECKSMITH_INLINE_TYPOGRAPHY_ATTRIBUTES = [
  'fontSize',
  'fontFamily',
  'fontWeight',
  'color',
  'letterSpacing',
] as const;
const DECKSMITH_PARAGRAPH_TYPOGRAPHY_ATTRIBUTES = [
  'defaultLetterSpacing',
  'lineHeight',
  'lineHeightPx',
  'textAlign',
] as const;
const DECKSMITH_FORMULA_TYPOGRAPHY_ATTRIBUTES = ['fontSize', 'fontFamily', 'color'] as const;
const DECKSMITH_FORMULA_NODE_TYPES = new Set([
  'inlineMath',
  'mathInline',
  'blockMath',
  'mathBlock',
]);

type DecksmithInlineTypographyAttribute = (typeof DECKSMITH_INLINE_TYPOGRAPHY_ATTRIBUTES)[number];
type DecksmithParagraphTypographyAttribute =
  (typeof DECKSMITH_PARAGRAPH_TYPOGRAPHY_ATTRIBUTES)[number];
type DecksmithParagraphTypography = {
  inline: Partial<Record<DecksmithInlineTypographyAttribute, unknown>>;
  paragraph: Partial<Record<DecksmithParagraphTypographyAttribute, unknown>>;
};

/**
 * Preserve a replaced native text frame's layout typography without copying its semantic marks.
 *
 * Paragraphs are enumerated depth-first in document order, including paragraphs nested in list
 * items. Each target paragraph maps to the source paragraph at the same index; overflow reuses the
 * last source paragraph. A per-attribute, visible-character-weighted mode prevents a short local
 * highlight from becoming the new paragraph-wide baseline. Missing values participate in the mode,
 * so one explicitly styled run cannot style a mostly-unformatted paragraph by accident.
 *
 * Markdown bold remains authoritative: ReachDeckRichText applies textStyle.fontWeight after the
 * bold mark, so inheriting a normal weight onto a bold run would make the bold visually disappear.
 */
export function inheritDecksmithRichTextTypography(
  source: RichTextDocument | undefined,
  target: RichTextDocument,
): RichTextDocument {
  if (source === undefined) return target;
  const sourceParagraphs = collectDecksmithParagraphs(source);
  if (sourceParagraphs.length === 0) return target;
  const baselines = sourceParagraphs.map(decksmithParagraphTypography);
  let paragraphIndex = 0;
  let lastBaseline = baselines[0]!;

  const visit = (node: RichTextNode): RichTextNode => {
    if (node.type === 'paragraph') {
      const baseline = baselines[Math.min(paragraphIndex, baselines.length - 1)]!;
      paragraphIndex += 1;
      lastBaseline = baseline;
      const inheritedParagraph = { ...baseline.paragraph };
      if (node.attrs?.lineHeight !== undefined || node.attrs?.lineHeightPx !== undefined) {
        delete inheritedParagraph.lineHeight;
        delete inheritedParagraph.lineHeightPx;
      }
      const attrs = inheritAttributes(
        node.attrs,
        inheritedParagraph,
        DECKSMITH_PARAGRAPH_TYPOGRAPHY_ATTRIBUTES,
      );
      return {
        ...node,
        ...(attrs === undefined ? {} : { attrs }),
        ...(node.content === undefined
          ? {}
          : {
              content: node.content.map((child) => applyDecksmithInlineTypography(child, baseline)),
            }),
      };
    }
    if (DECKSMITH_FORMULA_NODE_TYPES.has(node.type)) {
      return applyDecksmithFormulaTypography(node, lastBaseline);
    }
    return node.content === undefined
      ? node
      : { ...node, content: node.content.map((child) => visit(child)) };
  };

  return {
    ...target,
    ...(target.content === undefined ? {} : { content: target.content.map((node) => visit(node)) }),
  };
}

function collectDecksmithParagraphs(document: RichTextDocument): RichTextNode[] {
  const paragraphs: RichTextNode[] = [];
  const visit = (nodes: RichTextNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (node.type === 'paragraph') paragraphs.push(node);
      visit(node.content);
    }
  };
  visit(document.content);
  return paragraphs;
}

function decksmithParagraphTypography(paragraph: RichTextNode): DecksmithParagraphTypography {
  const inline: DecksmithParagraphTypography['inline'] = {};
  for (const attribute of DECKSMITH_INLINE_TYPOGRAPHY_ATTRIBUTES) {
    const value = dominantDecksmithTypographyValue(paragraph, attribute);
    if (value !== undefined) inline[attribute] = value;
  }
  const paragraphTypography: DecksmithParagraphTypography['paragraph'] = {};
  for (const attribute of DECKSMITH_PARAGRAPH_TYPOGRAPHY_ATTRIBUTES) {
    const value = paragraph.attrs?.[attribute];
    if (value !== undefined) paragraphTypography[attribute] = value;
  }
  return { inline, paragraph: paragraphTypography };
}

function dominantDecksmithTypographyValue(
  paragraph: RichTextNode,
  attribute: DecksmithInlineTypographyAttribute,
): unknown {
  const missing = Symbol('missing-typography');
  const totals = new Map<unknown, { first: number; value: unknown; weight: number }>();
  let order = 0;
  const count = (value: unknown, weight: number): void => {
    const key = value === undefined ? missing : typographyValueKey(value);
    const current = totals.get(key);
    if (current === undefined) {
      totals.set(key, { first: order++, value, weight });
      return;
    }
    current.weight += weight;
  };
  const visit = (nodes: RichTextNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (typeof node.text === 'string' && node.text.length > 0) {
        const style = node.marks?.find((mark) => mark.type === 'textStyle');
        count(style?.attrs?.[attribute], [...node.text].length);
      } else if (DECKSMITH_FORMULA_NODE_TYPES.has(node.type)) {
        count(node.attrs?.[attribute], 1);
      }
      visit(node.content);
    }
  };
  visit(paragraph.content);
  let winner: { first: number; value: unknown; weight: number } | undefined;
  for (const candidate of totals.values()) {
    if (
      winner === undefined ||
      candidate.weight > winner.weight ||
      (candidate.weight === winner.weight && candidate.first < winner.first)
    ) {
      winner = candidate;
    }
  }
  return winner?.value;
}

function typographyValueKey(value: unknown): string {
  if (typeof value === 'string') return `string:${value}`;
  if (typeof value === 'number') return `number:${value}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  return `json:${JSON.stringify(value)}`;
}

function applyDecksmithInlineTypography(
  node: RichTextNode,
  baseline: DecksmithParagraphTypography,
): RichTextNode {
  if (typeof node.text === 'string') {
    const marks = [...(node.marks ?? [])];
    const styleIndex = marks.findIndex((mark) => mark.type === 'textStyle');
    const existingStyle = styleIndex < 0 ? undefined : marks[styleIndex];
    const inherited: Partial<Record<DecksmithInlineTypographyAttribute, unknown>> = {
      ...baseline.inline,
    };
    if (marks.some((mark) => mark.type === 'bold')) delete inherited.fontWeight;
    const attrs = inheritAttributes(
      existingStyle?.attrs,
      inherited,
      DECKSMITH_INLINE_TYPOGRAPHY_ATTRIBUTES,
    );
    if (attrs !== undefined && Object.keys(attrs).length > 0) {
      const style = { type: 'textStyle', attrs };
      if (styleIndex < 0) marks.unshift(style);
      else marks[styleIndex] = style;
    }
    return { ...node, ...(marks.length === 0 ? {} : { marks }) };
  }
  if (DECKSMITH_FORMULA_NODE_TYPES.has(node.type)) {
    return applyDecksmithFormulaTypography(node, baseline);
  }
  return node.content === undefined
    ? node
    : {
        ...node,
        content: node.content.map((child) => applyDecksmithInlineTypography(child, baseline)),
      };
}

function applyDecksmithFormulaTypography(
  node: RichTextNode,
  baseline: DecksmithParagraphTypography,
): RichTextNode {
  const formulaBaseline: Record<string, unknown> = {};
  for (const attribute of DECKSMITH_FORMULA_TYPOGRAPHY_ATTRIBUTES) {
    const value = baseline.inline[attribute];
    if (value !== undefined) formulaBaseline[attribute] = value;
  }
  const lineHeight = baseline.paragraph.lineHeightPx;
  if (lineHeight !== undefined) formulaBaseline.lineHeightPx = lineHeight;
  const attrs = inheritAttributes(node.attrs, formulaBaseline, [
    ...DECKSMITH_FORMULA_TYPOGRAPHY_ATTRIBUTES,
    'lineHeightPx',
  ]);
  return { ...node, ...(attrs === undefined ? {} : { attrs }) };
}

function inheritAttributes(
  existing: Record<string, unknown> | undefined,
  baseline: Readonly<Record<string, unknown>>,
  attributes: readonly string[],
): Record<string, unknown> | undefined {
  let next = existing;
  for (const attribute of attributes) {
    if (next?.[attribute] !== undefined || baseline[attribute] === undefined) continue;
    next = { ...(next ?? {}), [attribute]: baseline[attribute] };
  }
  return next;
}

function requireTransform(
  value: ReachDeckTransformV2 | undefined,
  stage: ReachDeckDocumentV2['stage'],
): ReachDeckTransformV2 {
  if (value === undefined) {
    throw new DecksmithSessionError('transform is required when creating a native element.');
  }
  return validateTransform(value, stage);
}

function validateTransform(
  value: ReachDeckTransformV2,
  stage: ReachDeckDocumentV2['stage'],
): ReachDeckTransformV2 {
  if (
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.x < 0 ||
    value.y < 0 ||
    value.width <= 0 ||
    value.height <= 0 ||
    value.x + value.width > stage.width ||
    value.y + value.height > stage.height
  ) {
    throw new DecksmithSessionError(
      `Native element transform must fit inside the ${stage.width}x${stage.height} stage.`,
    );
  }
  return { ...value };
}

function transformState(element: ReachDeckNativeElementV2): DecksmithNativeTransformState {
  return { transform: { ...element.transform }, zIndex: element.zIndex };
}

/** Optional transform fields have native defaults; explicit default values are therefore no-ops. */
function transformValuesEqual(left: ReachDeckTransformV2, right: ReachDeckTransformV2): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    (left.rotation ?? 0) === (right.rotation ?? 0) &&
    (left.flipHorizontal ?? false) === (right.flipHorizontal ?? false) &&
    (left.flipVertical ?? false) === (right.flipVertical ?? false)
  );
}

/** 按 id 查找原生元素，含组合（group.children）内的嵌套元素。 */
export function findDecksmithNativeElement(
  elements: readonly ReachDeckNativeElementV2[],
  elementId: string,
): ReachDeckNativeElementV2 | undefined {
  for (const element of elements) {
    if (element.id === elementId) return element;
    if (element.type === 'group') {
      const nested = findDecksmithNativeElement(element.children, elementId);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** 按 id 替换原生元素（可在组合内），其余元素与组合结构保持不变。 */
function replaceDecksmithNativeElement(
  elements: readonly ReachDeckNativeElementV2[],
  elementId: string,
  replacement: ReachDeckNativeElementV2,
): ReachDeckNativeElementV2[] {
  return elements.map((element) => {
    if (element.id === elementId) return replacement;
    if (element.type !== 'group') return element;
    return {
      ...element,
      children: replaceDecksmithNativeElement(element.children, elementId, replacement),
    };
  });
}

function nextZIndex(elements: readonly ReachDeckNativeElementV2[]): number {
  return elements.reduce((maximum, element) => Math.max(maximum, element.zIndex), -1) + 1;
}

function replaceOrAppend(
  elements: ReachDeckNativeElementV2[],
  index: number,
  element: ReachDeckNativeElementV2,
): ReachDeckNativeElementV2[] {
  if (index < 0) return [...elements, element];
  return elements.map((candidate, candidateIndex) =>
    candidateIndex === index ? element : candidate,
  );
}

function upsertMediaResource(
  document: ReachDeckDocumentV2,
  resource: ReachDeckMediaResourceV2,
): void {
  const parsedResource = {
    id: nonblank(resource.id, 'resourceId'),
    objectKey: nonblank(resource.objectKey, 'objectKey'),
    contentType: nonblank(resource.contentType, 'contentType'),
    digest: nonblank(resource.digest, 'digest'),
  };
  const index = document.resources.media.findIndex((candidate) => candidate.id === resource.id);
  if (index < 0) {
    document.resources.media = [...document.resources.media, parsedResource];
    return;
  }
  const existing = document.resources.media[index]!;
  if (
    existing.objectKey !== parsedResource.objectKey ||
    existing.contentType !== parsedResource.contentType ||
    existing.digest !== parsedResource.digest
  ) {
    throw new DecksmithSessionError(
      `Media resource ${resource.id} already exists with different authoritative metadata.`,
    );
  }
}

function nonblank(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new DecksmithSessionError(`${field} is required.`);
  }
  return value.trim();
}

function clampPosition(position: number | undefined, maximum: number): number {
  if (position === undefined) return maximum;
  if (!Number.isInteger(position) || position < 1) {
    throw new DecksmithSessionError('position must be a positive integer (1-based).');
  }
  return Math.min(position, maximum);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rectanglesOverlap(left: ReachDeckTransformV2, right: ReachDeckTransformV2): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
