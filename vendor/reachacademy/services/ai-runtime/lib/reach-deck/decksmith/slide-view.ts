import {
  richTextToPlainText,
  type ReachDeckFillV2,
  type ReachDeckNativeElementV2,
  type ReachDeckNativeSlideV2,
  type ReachDeckTransformV2,
  type RichTextDocument,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';

/**
 * Compact projection of a native slide for Decksmith's read_page.
 *
 * Compiled slides repeat full run styling on every text span and carry large embedded documents,
 * so the raw slide costs several thousand tokens per read and every later model turn re-sends it.
 * The compact view keeps exactly what the editing tools need — stable ids, geometry, plain text,
 * the dominant text style, fills, table cells, and narration — and marks what is not editable.
 */
export function compactDecksmithNativeSlide(slide: ReachDeckNativeSlideV2) {
  return {
    schemaVersion: slide.schemaVersion,
    view: 'compact' as const,
    id: slide.id,
    title: slide.title,
    ...(slide.layoutId === undefined ? {} : { layoutId: slide.layoutId }),
    background: describeFill(slide.background),
    elements: slide.elements.map(compactElement),
    animations: slide.animations.map((animation) => ({
      id: animation.id,
      targetId: animation.targetId,
      trigger: animation.trigger,
      effect: animation.effect,
    })),
    ...(slide.narration === undefined
      ? {}
      : {
          narration: {
            markdown: slide.narration.markdown,
            hasAudio: slide.narration.audioResourceId !== undefined,
          },
        }),
    ...(slide.duration === undefined ? {} : { duration: slide.duration }),
  };
}

function compactElement(element: ReachDeckNativeElementV2): Record<string, unknown> {
  const base = {
    id: element.id,
    type: element.type,
    transform: roundTransform(element.transform),
    zIndex: element.zIndex,
  };
  switch (element.type) {
    case 'textFrame':
      return { ...base, ...compactText(element.text.doc), ...fillOf(element.style?.fill) };
    case 'shape':
      return {
        ...base,
        preset:
          element.geometry.kind === 'preset' ? element.geometry.preset : element.geometry.kind,
        ...(element.text === undefined ? {} : compactText(element.text.doc)),
        ...fillOf(element.style.fill),
      };
    case 'table':
      return {
        ...base,
        columnWidths: element.columnWidths.map(round),
        rowHeights: element.rowHeights.map(round),
        rows: element.rows.map((row) => ({
          id: row.id,
          cells: row.cells.map((cell) => ({
            id: cell.id,
            ...(cell.header === true ? { header: true } : {}),
            ...(cell.rowSpan === 1 ? {} : { rowSpan: cell.rowSpan }),
            ...(cell.columnSpan === 1 ? {} : { columnSpan: cell.columnSpan }),
            ...compactText(cell.text.doc),
            ...fillOf(cell.style.fill),
          })),
        })),
      };
    case 'group':
      return { ...base, children: element.children.map(compactElement) };
    case 'image':
      return {
        ...base,
        resourceId: element.resourceId,
        alt: element.alt,
        note: 'raster picture; any text drawn inside it is not editable',
      };
    case 'formula':
      return { ...base, latex: element.latex, display: element.display };
    case 'scientificVisual':
      return {
        ...base,
        ariaLabel: element.ariaLabel,
        ...(element.locked === true ? { locked: true } : {}),
        note: 'embedded scientific visual; its document is omitted here (read_page detail "full")',
      };
    default:
      return base;
  }
}

function compactText(doc: RichTextDocument) {
  const style = dominantTextStyle(doc.content);
  return { text: richTextToPlainText(doc), ...(style === undefined ? {} : { textStyle: style }) };
}

/** The style of the longest styled run; enough for the model to match neighbouring text. */
function dominantTextStyle(nodes: readonly RichTextNode[] | undefined) {
  let best: { length: number; style: Record<string, unknown> } | undefined;
  const visit = (items: readonly RichTextNode[] | undefined): void => {
    for (const node of items ?? []) {
      if (typeof node.text === 'string') {
        const attrs = node.marks?.find((mark) => mark.type === 'textStyle')?.attrs ?? {};
        const bold = node.marks?.some((mark) => mark.type === 'bold') === true;
        const size = Number.parseFloat(String(attrs.fontSize ?? ''));
        const style = {
          ...(typeof attrs.color === 'string' ? { color: attrs.color } : {}),
          ...(Number.isFinite(size) ? { fontSize: round(size) } : {}),
          ...(typeof attrs.fontFamily === 'string' ? { fontFamily: attrs.fontFamily } : {}),
          ...(bold ? { bold: true } : {}),
        };
        if (best === undefined || node.text.length > best.length) {
          best = { length: node.text.length, style };
        }
      }
      visit(node.content);
    }
  };
  visit(nodes);
  return best === undefined || Object.keys(best.style).length === 0 ? undefined : best.style;
}

function fillOf(fill: ReachDeckFillV2 | undefined) {
  return fill === undefined || fill.kind === 'none' ? {} : { fill: describeFill(fill) };
}

function describeFill(fill: ReachDeckFillV2): string {
  if (fill.kind === 'solid') {
    return fill.color.kind === 'srgb' ? fill.color.value : `theme:${fill.color.token}`;
  }
  if (fill.kind === 'image') return `image:${fill.resourceId}`;
  return fill.kind;
}

function roundTransform(transform: ReachDeckTransformV2) {
  return {
    x: round(transform.x),
    y: round(transform.y),
    width: round(transform.width),
    height: round(transform.height),
    ...(transform.rotation === undefined || transform.rotation === 0
      ? {}
      : { rotation: round(transform.rotation) }),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Compact view of loose elements, such as a draft from the HTML brush. */
export function compactDecksmithNativeElements(elements: readonly ReachDeckNativeElementV2[]) {
  return elements.map(compactElement);
}
