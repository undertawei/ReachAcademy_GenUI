import {
  parseReachDeckDocument,
  reachDeckOrphanAnimationIds,
  type ReachDeckDocument,
  type ReachDeckNativeElementV2,
  type ReachDeckAnimationV2,
} from '@reachany/reach-deck-dsl';
import {
  parseReachDeckNativeElementClipboard,
  reachDeckNativeElementClipboardPlainText,
} from './operations.js';
import { isReachDeckElementsClipboardSelfContained } from './elementClipboardSafety.js';

export const ELEMENT_CLIPBOARD_VERSION = 'reach-deck-elements-clipboard/v2';
export const ELEMENT_CLIPBOARD_MAX_BYTES = 1_000_000;
export const ELEMENT_CLIPBOARD_HTML_MAX_BYTES = 6_100_000;
export const ELEMENT_CLIPBOARD_MAX_ELEMENTS = 512;
export const ELEMENT_CLIPBOARD_MAX_DEPTH = 32;
const ATTRIBUTE = 'data-reach-deck-elements';
export interface ReachDeckElementsClipboard {
  version: typeof ELEMENT_CLIPBOARD_VERSION;
  documentId: string;
  pageId?: string;
  stage: { width: number; height: number };
  elements: ReachDeckNativeElementV2[];
  portableElements?: ReachDeckNativeElementV2[];
  animations: ReachDeckAnimationV2[];
}
const bytes = (value: string) => new TextEncoder().encode(value).length;
/** Bound all nested data before invoking recursive DSL validation. Resource references remain IDs. */
function safeTree(value: unknown, depth = 0): boolean {
  if (depth > ELEMENT_CLIPBOARD_MAX_DEPTH) return false;
  if (typeof value === 'string')
    return !/(?:[?&](?:auth_key|[^=&]*(?:token|signature|credential)|x-amz-[^=]*|x-oss-[^=]*)=)/i.test(
      value,
    );
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, child]) =>
      !/^(?:objectKey|accessToken|refreshToken|authorization|signedUrl|narration|generationTask)$/i.test(
        key,
      ) && safeTree(child, depth + 1),
  );
}
function countElements(elements: readonly ReachDeckNativeElementV2[]): number {
  return elements.reduce(
    (count, element) =>
      count + 1 + (element.type === 'group' ? countElements(element.children) : 0),
    0,
  );
}
export function parseReachDeckElementsClipboard(
  value: string,
  document: ReachDeckDocument,
): ReachDeckElementsClipboard | undefined {
  if (
    document.schemaVersion !== 'reach-deck-document/v2' ||
    value.length > ELEMENT_CLIPBOARD_MAX_BYTES ||
    bytes(value) > ELEMENT_CLIPBOARD_MAX_BYTES
  )
    return undefined;
  try {
    const raw = JSON.parse(value);
    if (!safeTree(raw)) return undefined;
    if (raw?.version === 'reach-deck-element-clipboard/v1') {
      const legacy = parseReachDeckNativeElementClipboard(value, document);
      return legacy === undefined
        ? undefined
        : {
            version: ELEMENT_CLIPBOARD_VERSION,
            documentId: legacy.documentId,
            stage: { width: document.stage.width, height: document.stage.height },
            elements: [legacy.element],
            animations: legacy.animations,
          };
    }
    if (
      !raw ||
      raw.version !== ELEMENT_CLIPBOARD_VERSION ||
      typeof raw.documentId !== 'string' ||
      !raw.documentId ||
      typeof raw.pageId !== 'string' ||
      !raw.pageId ||
      !Array.isArray(raw.elements) ||
      !raw.elements.length ||
      raw.elements.length > ELEMENT_CLIPBOARD_MAX_ELEMENTS ||
      !Array.isArray(raw.animations) ||
      raw.animations.length > 2048 ||
      !raw.stage ||
      !Number.isFinite(raw.stage.width) ||
      raw.stage.width <= 0 ||
      !Number.isFinite(raw.stage.height) ||
      raw.stage.height <= 0 ||
      Object.keys(raw).some(
        (key) =>
          ![
            'version',
            'documentId',
            'pageId',
            'stage',
            'elements',
            'portableElements',
            'animations',
          ].includes(key),
      )
    )
      return undefined;
    const crossDeck = raw.documentId !== document.id;
    if (
      raw.portableElements !== undefined &&
      (!Array.isArray(raw.portableElements) ||
        raw.portableElements.length !== raw.elements.length ||
        raw.portableElements.length > ELEMENT_CLIPBOARD_MAX_ELEMENTS)
    )
      return undefined;
    const elements = crossDeck ? (raw.portableElements ?? raw.elements) : raw.elements;
    if (crossDeck && !isReachDeckElementsClipboardSelfContained(elements)) return undefined;
    if (countElements(elements) > ELEMENT_CLIPBOARD_MAX_ELEMENTS) return undefined;
    const first = document.nativeSlides[0];
    if (!first) return undefined;
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
                elements,
                animations: raw.animations,
              },
            }
          : binding,
      ),
    });
    if (validated.schemaVersion !== 'reach-deck-document/v2') return undefined;
    // 文档允许保留孤儿动画，但剪贴板载荷里的动画必须指向随附元素。
    if (reachDeckOrphanAnimationIds(validated.nativeSlides[0]!.slide).size > 0) return undefined;
    if (
      crossDeck &&
      !isReachDeckElementsClipboardSelfContained(validated.nativeSlides[0]!.slide.elements)
    )
      return undefined;
    return {
      version: ELEMENT_CLIPBOARD_VERSION,
      documentId: raw.documentId,
      pageId: raw.pageId,
      stage: { width: raw.stage.width, height: raw.stage.height },
      elements: validated.nativeSlides[0]!.slide.elements,
      animations: validated.nativeSlides[0]!.slide.animations,
    };
  } catch {
    return undefined;
  }
}
export function serializeReachDeckElementsClipboard(
  value: ReachDeckElementsClipboard,
  document: ReachDeckDocument,
): string | undefined {
  const themeColors =
    document.schemaVersion === 'reach-deck-document/v2'
      ? document.resources.themes.find((theme) => theme.id === document.defaultThemeId)?.colors
      : undefined;
  const resolveThemeColors = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(resolveThemeColors);
    if (item === null || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    if (record.kind === 'theme' && typeof record.token === 'string') {
      const color = themeColors?.[record.token];
      if (color !== undefined && record.tint === undefined && record.shade === undefined) {
        return {
          kind: 'srgb',
          value: color,
          ...(record.alpha === undefined ? {} : { alpha: record.alpha }),
        };
      }
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, resolveThemeColors(child)]),
    );
  };
  const portableElements = resolveThemeColors(value.elements) as ReachDeckNativeElementV2[];
  const serialized = JSON.stringify({
    ...value,
    portableElements:
      JSON.stringify(portableElements) === JSON.stringify(value.elements)
        ? undefined
        : portableElements,
  });
  return parseReachDeckElementsClipboard(serialized, document) ? serialized : undefined;
}
export function reachDeckElementsClipboardPlainText(value: ReachDeckElementsClipboard): string {
  return value.elements
    .map((element) =>
      reachDeckNativeElementClipboardPlainText({
        documentId: value.documentId,
        element,
        animations: [],
      }),
    )
    .filter(Boolean)
    .join('\n');
}
const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
export function reachDeckElementsClipboardHtml(serialized: string, plainText: string): string {
  return `<span ${ATTRIBUTE}="${escapeHtml(serialized)}">${escapeHtml(plainText)}</span>`;
}
/** Recognize marked content before ordinary rich-text limits, without executing HTML. */
export function readReachDeckElementsClipboardHtml(html: string): {
  recognized: boolean;
  value?: string;
} {
  if (!html.includes(ATTRIBUTE)) return { recognized: false };
  if (
    html.length > ELEMENT_CLIPBOARD_HTML_MAX_BYTES ||
    bytes(html) > ELEMENT_CLIPBOARD_HTML_MAX_BYTES
  )
    return { recognized: true };
  try {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const carriers = document.querySelectorAll(`[${ATTRIBUTE}]`);
    if (carriers.length !== 1) return { recognized: true };
    const value = carriers[0]!.getAttribute(ATTRIBUTE) ?? '';
    return { recognized: true, ...(bytes(value) <= ELEMENT_CLIPBOARD_MAX_BYTES ? { value } : {}) };
  } catch {
    return { recognized: true };
  }
}
