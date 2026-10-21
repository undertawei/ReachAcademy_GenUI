import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import type { ReachDeckTextFrameV2, RichTextMark, RichTextNode } from '@reachany/reach-deck-dsl';
import { maicCssColor, maicLinearGradient } from './style.js';

type HtmlNode = DefaultTreeAdapterMap['node'];
type Styles = Record<string, string>;
const forbidden = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript',
]);
const blocks = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li']);
const supportedStyles = new Set([
  'padding',
  'color',
  'font-size',
  'font-family',
  'line-height',
  'letter-spacing',
  'text-align',
  'margin-left',
  'margin-top',
  'margin-bottom',
  'text-indent',
  'font-weight',
  'font-style',
  'text-decoration',
  'background',
  'background-color',
  'background-clip',
  '-webkit-background-clip',
]);
const css = (node: HtmlNode): Styles => {
  const raw =
    'attrs' in node ? (node.attrs.find((attr) => attr.name === 'style')?.value ?? '') : '';
  return Object.fromEntries(
    raw.split(';').flatMap((declaration) => {
      const colon = declaration.indexOf(':');
      const name = declaration.slice(0, colon).trim().toLowerCase();
      return colon > 0 && supportedStyles.has(name)
        ? [[name, declaration.slice(colon + 1).trim()]]
        : [];
    }),
  );
};
const numeric = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const px = (value: string | undefined, scale: number): number | undefined => {
  if (value === undefined || !/^-?\d+(?:\.\d+)?(?:px)?$/.test(value)) return undefined;
  const amount = Number.parseFloat(value) * scale;
  return Number.isFinite(amount) ? amount : undefined;
};
const fontFamily = (value: string): string =>
  /kai|wenkai/i.test(value)
    ? 'LXGW WenKai'
    : /song|serif|fangsong/i.test(value)
      ? 'Source Han Serif SC'
      : 'Source Han Sans VF';

export function maicTextFrame(
  value: string,
  source: Readonly<Record<string, unknown>> = {},
  scale = 1,
): ReachDeckTextFrameV2 {
  scale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const fragment = parseFragment(value);
  const root = fragment.childNodes.find((node) => 'tagName' in node && node.tagName === 'div');
  const rootStyles = root ? css(root) : {};
  const padding = (rootStyles.padding ?? '').split(/\s+/).map((part) => px(part, scale));
  const fallbackPadding = numeric(source.padding) * scale;
  const sides =
    padding.length && padding.every((part) => part !== undefined)
      ? ([
          padding[0],
          padding[1] ?? padding[0],
          padding[2] ?? padding[0],
          padding[3] ?? padding[1] ?? padding[0],
        ] as number[])
      : [fallbackPadding, fallbackPadding, fallbackPadding, fallbackPadding];
  const content: RichTextNode[] = [];
  let paragraph: RichTextNode | undefined;
  const defaults: Styles = {
    color: typeof source.defaultColor === 'string' ? source.defaultColor : '#333333',
    'font-size': `${numeric(source.fontSize, 16)}px`,
    'font-family': typeof source.defaultFontName === 'string' ? source.defaultFontName : '',
    'line-height': String(numeric(source.lineHeight, 1.5)),
    'letter-spacing': `${numeric(source.wordSpace)}px`,
    ...(source.bold === true ? { 'font-weight': 'bold' } : {}),
    ...(source.em === true ? { 'font-style': 'italic' } : {}),
    'text-decoration': [
      source.underline === true ? 'underline' : '',
      source.strikethrough === true ? 'line-through' : '',
    ].join(' '),
    ...(typeof source.textAlign === 'string' ? { 'text-align': source.textAlign } : {}),
  };
  const paragraphAttrs = (style: Styles): Record<string, unknown> => {
    const attrs: Record<string, unknown> = {
      spaceBefore:
        content.length === 0
          ? 0
          : Math.max(0, numeric(source.paragraphSpace, source.type === 'text' ? 5 : 0)) * scale,
    };
    const paragraphSize = px(style['font-size'], scale);
    if (paragraphSize !== undefined && paragraphSize > 0) attrs.fontSize = paragraphSize;
    if (['left', 'center', 'right', 'justify'].includes(style['text-align'] ?? ''))
      attrs.textAlign = style['text-align'];
    const lineHeight = style['line-height'];
    if (
      lineHeight &&
      /^\d+(?:\.\d+)?$/.test(lineHeight) &&
      Number.isFinite(Number(lineHeight)) &&
      Number(lineHeight) > 0
    )
      attrs.lineHeight = Number(lineHeight);
    else if (lineHeight?.endsWith('px')) {
      const size = px(lineHeight, scale);
      if (size !== undefined && size > 0) attrs.lineHeightPx = size;
    }
    for (const [key, name] of Object.entries({
      'margin-left': 'leftIndent',
      'margin-top': 'spaceBefore',
      'margin-bottom': 'spaceAfter',
      'text-indent': 'firstLineIndent',
    })) {
      const size = px(style[key], scale);
      if (size !== undefined) attrs[name] = size;
    }
    return attrs;
  };
  type Visit = { node: HtmlNode; inherited: Styles; inheritedMarks: string[]; exit?: boolean };
  // HTML nesting is independent of JSON depth; avoid recursion on imported markup.
  const pending: Visit[] = [...fragment.childNodes]
    .reverse()
    .map((node) => ({ node, inherited: defaults, inheritedMarks: [] }));
  while (pending.length) {
    const { node, inherited, inheritedMarks, exit } = pending.pop()!;
    if (exit) {
      paragraph = undefined;
      continue;
    }
    if ('tagName' in node && forbidden.has(node.tagName)) continue;
    const tag = 'tagName' in node ? node.tagName : '';
    const tagStyles: Styles = {};
    if (tag === 'b' || tag === 'strong') tagStyles['font-weight'] = 'bold';
    if (tag === 'i' || tag === 'em') tagStyles['font-style'] = 'italic';
    if (tag === 'u')
      tagStyles['text-decoration'] = `${inherited['text-decoration'] ?? ''} underline`;
    if (tag === 's' || tag === 'del')
      tagStyles['text-decoration'] = `${inherited['text-decoration'] ?? ''} line-through`;
    const style = { ...inherited, ...tagStyles, ...css(node) };
    const marks = [...new Set(inheritedMarks)];
    if (tag === 'sub') marks.push('subscript');
    if (tag === 'sup') marks.push('superscript');
    const children = 'childNodes' in node ? node.childNodes : [];
    const isParagraph =
      blocks.has(tag) && !children.some((child) => 'tagName' in child && blocks.has(child.tagName));
    if (isParagraph) {
      paragraph = { type: 'paragraph', attrs: paragraphAttrs(style), content: [] };
      content.push(paragraph);
    }
    if (node.nodeName === '#text' || tag === 'br') {
      const textValue = 'value' in node ? node.value : '';
      if (tag !== 'br' && !textValue) continue;
      if (!paragraph && tag !== 'br' && !textValue.trim()) continue;
      if (!paragraph) {
        paragraph = { type: 'paragraph', attrs: paragraphAttrs(style), content: [] };
        content.push(paragraph);
      }
      if (tag === 'br') paragraph.content!.push({ type: 'hardBreak' });
      else {
        const attrs: Record<string, unknown> = {};
        const color = maicCssColor(style.color);
        if (color) attrs.color = color;
        const size = px(style['font-size'], scale);
        if (size !== undefined && size > 0) attrs.fontSize = `${size}px`;
        attrs.fontFamily = fontFamily(style['font-family'] ?? '');
        const spacing = px(style['letter-spacing'], scale);
        if (spacing !== undefined) attrs.letterSpacing = spacing;
        if (/^[1-9]00$/.test(style['font-weight'] ?? ''))
          attrs.fontWeight = Number(style['font-weight']);
        else if (style['font-weight'] === 'bold') marks.push('bold');
        if (style['font-style'] === 'italic' || style['font-style'] === 'oblique')
          marks.push('italic');
        if (style['text-decoration']?.split(/\s+/).includes('underline')) marks.push('underline');
        if (style['text-decoration']?.split(/\s+/).includes('line-through')) marks.push('strike');
        const background = style.background ?? style['background-color'];
        const gradient = background ? maicLinearGradient(background) : undefined;
        if (
          gradient &&
          (style['background-clip'] === 'text' ||
            style['-webkit-background-clip'] === 'text' ||
            /\)\s+text\s*$/i.test(background ?? ''))
        )
          attrs.textGradient = gradient;
        else {
          const color = maicCssColor(background);
          if (color) attrs.backgroundColor = color;
        }
        const inlineMarks: RichTextMark[] = [...new Set(marks)].map((type) => ({ type }));
        inlineMarks.push({ type: 'textStyle', attrs });
        paragraph.content!.push({ type: 'text', text: textValue, marks: inlineMarks });
      }
    }
    if (isParagraph) pending.push({ node, inherited: style, inheritedMarks: marks, exit: true });
    for (let index = children.length - 1; index >= 0; index--)
      pending.push({ node: children[index]!, inherited: style, inheritedMarks: marks });
  }
  return {
    margins: {
      top: Math.max(0, sides[0]!),
      right: Math.max(0, sides[1]!),
      bottom: Math.max(0, sides[2]!),
      left: Math.max(0, sides[3]!),
    },
    verticalAlignment:
      source.align === 'middle' || source.vAlign === 'middle'
        ? 'middle'
        : source.align === 'bottom' || source.vAlign === 'bottom'
          ? 'bottom'
          : 'top',
    wrap: true,
    ...(source.vertical === true ? { orientation: 'vertical' as const } : {}),
    autofit: { mode: 'none' },
    doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] },
    fontSubstitutions: [],
  };
}
