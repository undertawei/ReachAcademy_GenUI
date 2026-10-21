import type { ReachDeckDocumentV2, ReachDeckThemeResourceV2 } from './document.js';
import { typographyTokensForProfile, type DeckTypographyTokenName } from './layoutContract.js';
import type { RichTextDocument, RichTextNode } from './richText.js';

export type ReachDeckSemanticTextRole = DeckTypographyTokenName;

const SEMANTIC_ROLE_FONT_SLOT: Readonly<
  Record<ReachDeckSemanticTextRole, keyof ReachDeckThemeResourceV2['fonts']>
> = {
  title: 'display',
  body: 'body',
  caption: 'body',
};

const FORMULA_NODE_TYPES = new Set(['inlineMath', 'mathInline', 'blockMath', 'mathBlock']);

/** Resolve the only document theme that may supply default typography for newly authored v2 text. */
export function resolveReachDeckDefaultThemeV2(
  document: Pick<ReachDeckDocumentV2, 'defaultThemeId' | 'resources'>,
): ReachDeckThemeResourceV2 {
  const theme = document.resources.themes.find(
    (candidate) => candidate.id === document.defaultThemeId,
  );
  if (theme === undefined) {
    throw new Error('document.defaultThemeId must reference a v2 theme resource.');
  }
  return theme;
}

/**
 * Materialize a semantic text role into the durable native-v2 rich-text attributes.
 *
 * Existing run/paragraph attributes remain authoritative. This compiler supplies only missing
 * font size, line height, font family, and foreground color values.
 */
export function compileReachDeckSemanticTypographyV2(input: {
  document: Pick<ReachDeckDocumentV2, 'defaultThemeId' | 'resources'>;
  doc: RichTextDocument;
  role?: ReachDeckSemanticTextRole;
  colorToken?: string;
}): RichTextDocument {
  const role = input.role ?? 'body';
  const theme = resolveReachDeckDefaultThemeV2(input.document);
  const token = typographyTokensForProfile(undefined)[role];
  const fontFamily = theme.fonts[SEMANTIC_ROLE_FONT_SLOT[role]];
  const colorToken = input.colorToken ?? 'ink';
  const color = theme.colors[colorToken];
  if (color === undefined) {
    throw new Error(`Default Reach Deck theme is missing the ${colorToken} color token.`);
  }
  const fontSize = `${token.fontSize}px`;

  const visit = (node: RichTextNode): RichTextNode => {
    let next = node;
    if (
      node.type === 'paragraph' &&
      node.attrs?.lineHeight === undefined &&
      node.attrs?.lineHeightPx === undefined
    ) {
      next = { ...next, attrs: { ...(next.attrs ?? {}), lineHeightPx: token.lineHeight } };
    }
    if (typeof node.text === 'string') {
      const marks = [...(node.marks ?? [])];
      const styleIndex = marks.findIndex((mark) => mark.type === 'textStyle');
      const attrs: Record<string, unknown> = {
        ...(styleIndex < 0 ? {} : (marks[styleIndex]!.attrs ?? {})),
      };
      if (attrs.fontSize === undefined) attrs.fontSize = fontSize;
      if (attrs.color === undefined) attrs.color = color;
      if (attrs.fontFamily === undefined) attrs.fontFamily = fontFamily;
      const textStyle = { type: 'textStyle', attrs };
      if (styleIndex < 0) marks.unshift(textStyle);
      else marks[styleIndex] = textStyle;
      next = { ...next, marks };
    }
    if (FORMULA_NODE_TYPES.has(node.type)) {
      const attrs = { ...(node.attrs ?? {}) };
      if (attrs.fontSize === undefined) attrs.fontSize = fontSize;
      if (attrs.lineHeightPx === undefined) attrs.lineHeightPx = token.lineHeight;
      if (attrs.color === undefined) attrs.color = color;
      if (attrs.fontFamily === undefined) attrs.fontFamily = fontFamily;
      next = { ...next, attrs };
    }
    if (next.content !== undefined) next = { ...next, content: next.content.map(visit) };
    return next;
  };

  return {
    ...input.doc,
    ...(input.doc.content === undefined
      ? {}
      : { content: input.doc.content.map((node) => visit(node)) }),
  };
}
