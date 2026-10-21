import type { RichTextDocument, RichTextMark, RichTextNode } from '@reachany/reach-deck-dsl';

export type RichTextSpacingValue =
  | { kind: 'absolute'; value: number }
  | { kind: 'mixed' }
  | { kind: 'unset' }
  | { kind: 'value'; value: number };

const spacingValuesEqual = (left: number | undefined, right: number | undefined): boolean =>
  left === right;

function summarizeSpacingValues(values: Array<number | undefined>): RichTextSpacingValue {
  if (values.length === 0) return { kind: 'unset' };
  const first = values[0];
  if (!values.every((value) => spacingValuesEqual(value, first))) return { kind: 'mixed' };
  return first === undefined ? { kind: 'unset' } : { kind: 'value', value: first };
}

function visitRichTextNodes(
  nodes: RichTextNode[] | undefined,
  visitor: (node: RichTextNode) => void,
): void {
  for (const node of nodes ?? []) {
    visitor(node);
    visitRichTextNodes(node.content, visitor);
  }
}

/** Returns a multiplier only when every paragraph uses the same relative line height. */
export function richTextLineSpacing(document: RichTextDocument): RichTextSpacingValue {
  const relativeValues: Array<number | undefined> = [];
  const absoluteValues: number[] = [];
  visitRichTextNodes(document.content, (node) => {
    if (node.type !== 'paragraph') return;
    if (typeof node.attrs?.lineHeightPx === 'number' && node.attrs.lineHeightPx > 0) {
      absoluteValues.push(node.attrs.lineHeightPx);
      return;
    }
    relativeValues.push(
      typeof node.attrs?.lineHeight === 'number' && node.attrs.lineHeight > 0
        ? node.attrs.lineHeight
        : undefined,
    );
  });
  if (absoluteValues.length > 0) {
    if (
      relativeValues.length > 0 ||
      !absoluteValues.every((value) => value === absoluteValues[0])
    ) {
      return { kind: 'mixed' };
    }
    return { kind: 'absolute', value: absoluteValues[0]! };
  }
  return summarizeSpacingValues(relativeValues);
}

/** Missing letter spacing is the CSS default of zero pixels. */
export function richTextLetterSpacing(document: RichTextDocument): RichTextSpacingValue {
  const values: Array<number | undefined> = [];
  visitRichTextNodes(document.content, (node) => {
    if (node.type !== 'paragraph') return;
    const fallback =
      typeof node.attrs?.defaultLetterSpacing === 'number' &&
      Number.isFinite(node.attrs.defaultLetterSpacing)
        ? node.attrs.defaultLetterSpacing
        : 0;
    const paragraphValues: number[] = [];
    visitRichTextNodes(node.content, (child) => {
      if (child.text === undefined) return;
      const textStyle = child.marks?.find((mark) => mark.type === 'textStyle');
      const spacing = textStyle?.attrs?.letterSpacing;
      paragraphValues.push(
        typeof spacing === 'number' && Number.isFinite(spacing) ? spacing : fallback,
      );
    });
    values.push(...(paragraphValues.length > 0 ? paragraphValues : [fallback]));
  });
  return summarizeSpacingValues(values);
}

function mapRichTextNodes(
  nodes: RichTextNode[] | undefined,
  update: (node: RichTextNode) => RichTextNode,
): RichTextNode[] | undefined {
  if (nodes === undefined) return undefined;
  return nodes.map((node) => {
    const content = mapRichTextNodes(node.content, update);
    return update(content === node.content ? node : { ...node, content });
  });
}

function withoutEmptyAttrs(attrs: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(attrs).length === 0 ? undefined : attrs;
}

/** Setting undefined restores automatic line height; a number applies one multiplier to all paragraphs. */
export function setRichTextLineSpacing(
  document: RichTextDocument,
  value: number | undefined,
): RichTextDocument {
  const content = mapRichTextNodes(document.content, (node) => {
    if (node.type !== 'paragraph') return node;
    const attrs = { ...(node.attrs ?? {}) };
    delete attrs.lineHeightPx;
    if (value === undefined) delete attrs.lineHeight;
    else attrs.lineHeight = value;
    const nextAttrs = withoutEmptyAttrs(attrs);
    return { ...node, ...(nextAttrs === undefined ? { attrs: undefined } : { attrs: nextAttrs }) };
  });
  return content === document.content ? document : { ...document, content };
}

/** Applies one absolute stage-pixel line height to all paragraphs and clears relative spacing. */
export function setRichTextFixedLineSpacing(
  document: RichTextDocument,
  value: number,
): RichTextDocument {
  const content = mapRichTextNodes(document.content, (node) => {
    if (node.type !== 'paragraph') return node;
    const attrs = { ...(node.attrs ?? {}) };
    delete attrs.lineHeight;
    attrs.lineHeightPx = value;
    return { ...node, attrs };
  });
  return content === document.content ? document : { ...document, content };
}

function setMarkLetterSpacing(
  marks: RichTextMark[] | undefined,
  value: number,
): RichTextMark[] | undefined {
  const current = marks ?? [];
  const textStyleIndex = current.findIndex((mark) => mark.type === 'textStyle');
  if (textStyleIndex < 0) {
    return value === 0
      ? marks
      : [...current, { type: 'textStyle', attrs: { letterSpacing: value } }];
  }

  const textStyle = current[textStyleIndex]!;
  const attrs = { ...(textStyle.attrs ?? {}) };
  if (value === 0) delete attrs.letterSpacing;
  else attrs.letterSpacing = value;
  const next = [...current];
  if (Object.keys(attrs).length === 0) next.splice(textStyleIndex, 1);
  else next[textStyleIndex] = { ...textStyle, attrs };
  return next.length === 0 ? undefined : next;
}

/** Applies character spacing to every text run while preserving all other marks and text styles. */
export function setRichTextLetterSpacing(
  document: RichTextDocument,
  value: number,
): RichTextDocument {
  const content = mapRichTextNodes(document.content, (node) => {
    if (node.type === 'paragraph') {
      const attrs = { ...(node.attrs ?? {}) };
      if (value === 0) delete attrs.defaultLetterSpacing;
      else attrs.defaultLetterSpacing = value;
      const nextAttrs = withoutEmptyAttrs(attrs);
      return {
        ...node,
        ...(nextAttrs === undefined ? { attrs: undefined } : { attrs: nextAttrs }),
      };
    }
    if (node.text === undefined) return node;
    const marks = setMarkLetterSpacing(node.marks, value);
    return { ...node, ...(marks === undefined ? { marks: undefined } : { marks }) };
  });
  return content === document.content ? document : { ...document, content };
}
