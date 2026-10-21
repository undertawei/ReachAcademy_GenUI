import type {
  ReachDeckDocumentV2,
  ReachDeckNativeElementV2,
  RichTextNode,
} from '@reachany/reach-deck-dsl';

/**
 * Compact, document-derived design summary for Decksmith.
 *
 * Generated decks carry their palette, typography and course background only as concrete values on
 * slides; the generation-time design context is not part of the learner document. Summarising what
 * the slides actually use lets edits match neighbouring pages without shipping every slide.
 */
export interface DecksmithDeckDesignSummary {
  theme?: {
    name: string;
    colors: Record<string, string>;
    fonts: { display: string; body: string };
  };
  textColors: string[];
  fontFamilies: string[];
  fontSizes: number[];
  backgrounds: string[];
}

const TOP = 6;

export function summarizeDecksmithDeckDesign(
  document: ReachDeckDocumentV2,
): DecksmithDeckDesignSummary {
  const colors = new Map<string, number>();
  const families = new Map<string, number>();
  const sizes = new Map<number, number>();
  const backgrounds = new Map<string, number>();
  const bump = <K>(map: Map<K, number>, key: K | undefined) => {
    if (key !== undefined) map.set(key, (map.get(key) ?? 0) + 1);
  };
  const visitText = (nodes: readonly RichTextNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      const attrs = node.marks?.find((mark) => mark.type === 'textStyle')?.attrs;
      if (typeof node.text === 'string' && node.text.trim() !== '' && attrs !== undefined) {
        if (typeof attrs.color === 'string') bump(colors, attrs.color.toLowerCase());
        if (typeof attrs.fontFamily === 'string') bump(families, attrs.fontFamily);
        const size = Number.parseFloat(String(attrs.fontSize ?? ''));
        if (Number.isFinite(size)) bump(sizes, Math.round(size));
      }
      visitText(node.content);
    }
  };
  const visitElement = (element: ReachDeckNativeElementV2): void => {
    if (element.type === 'group') element.children.forEach(visitElement);
    else if (element.type === 'textFrame' || element.type === 'shape') {
      visitText(element.text?.doc.content);
    } else if (element.type === 'table') {
      element.rows.forEach((row) => row.cells.forEach((cell) => visitText(cell.text.doc.content)));
    }
  };
  for (const { slide } of document.nativeSlides) {
    slide.elements.forEach(visitElement);
    const background = slide.background;
    bump(
      backgrounds,
      background.kind === 'solid' && background.color.kind === 'srgb'
        ? `solid ${background.color.value.toLowerCase()}`
        : background.kind === 'image'
          ? 'image (course background)'
          : background.kind,
    );
  }
  const top = <K>(map: Map<K, number>) =>
    [...map.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, TOP)
      .map(([key]) => key);
  const theme = document.resources.themes.find((item) => item.id === document.defaultThemeId);
  return {
    ...(theme === undefined
      ? {}
      : { theme: { name: theme.name, colors: { ...theme.colors }, fonts: { ...theme.fonts } } }),
    textColors: top(colors),
    fontFamilies: top(families),
    fontSizes: top(sizes).sort((left, right) => right - left),
    backgrounds: top(backgrounds),
  };
}
