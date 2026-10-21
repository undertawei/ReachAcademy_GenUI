import type { ReachDeckNarrationV2, ReachDeckNarrationSegmentV2 } from './nativeV2.js';
import type { RichTextDocument, RichTextNode } from './richText.js';

export const REACH_DECK_NARRATION_MAX_SEMANTIC_UNITS = 2_000;
export const REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS = 10_000;

const CONTENT_DIGEST_INPUT_VERSION = 'reach-deck-narration-markdown/v1';
const INLINE_FORMULA_OPEN = '\\(';
const INLINE_FORMULA_CLOSE = '\\)';
const BLOCK_FORMULA_OPEN = '\\[';
const BLOCK_FORMULA_CLOSE = '\\]';

export type ReachDeckNarrationMarkdownErrorCode =
  | 'empty'
  | 'malformed-formula'
  | 'unsupported-markdown'
  | 'unsupported-rich-text'
  | 'semantic-limit'
  | 'raw-limit';

export class ReachDeckNarrationMarkdownError extends Error {
  constructor(
    readonly code: ReachDeckNarrationMarkdownErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReachDeckNarrationMarkdownError';
  }
}

export interface ReachDeckNarrationMarkdownAnalysis {
  markdown: string;
  doc: RichTextDocument;
  semanticUnits: number;
  codePoints: number;
}

/** Parse, canonicalize, and enforce both narration capacity limits. */
export function analyzeReachDeckNarrationMarkdown(
  markdown: string,
): ReachDeckNarrationMarkdownAnalysis {
  if (typeof markdown !== 'string') {
    throw new ReachDeckNarrationMarkdownError(
      'unsupported-markdown',
      'Narration markdown must be a string.',
    );
  }
  const doc = parseReachDeckNarrationMarkdown(markdown);
  const canonical = serializeReachDeckNarrationMarkdown(doc);
  const semanticUnits = countReachDeckNarrationSemanticUnits(doc);
  const codePoints = [...canonical].length;
  if (semanticUnits === 0) {
    throw new ReachDeckNarrationMarkdownError(
      'empty',
      'Narration markdown must contain visible text or a formula.',
    );
  }
  if (semanticUnits > REACH_DECK_NARRATION_MAX_SEMANTIC_UNITS) {
    throw new ReachDeckNarrationMarkdownError(
      'semantic-limit',
      `Narration markdown exceeds ${REACH_DECK_NARRATION_MAX_SEMANTIC_UNITS} semantic units.`,
    );
  }
  if (codePoints > REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS) {
    throw new ReachDeckNarrationMarkdownError(
      'raw-limit',
      `Narration markdown exceeds ${REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS} Unicode code points.`,
    );
  }
  return { markdown: canonical, doc, semanticUnits, codePoints };
}

/** Canonical Markdown is the only persisted narration text representation. */
export const normalizeReachDeckNarrationMarkdown = (markdown: string): string =>
  analyzeReachDeckNarrationMarkdown(markdown).markdown;

/**
 * Parse the narration-only dialect into TipTap JSON.
 *
 * It intentionally supports only paragraph, hardBreak, inlineMath and blockMath. A single newline
 * is a hard break; one or more blank lines separate paragraphs/blocks. Dollar signs are ordinary
 * text. Formula delimiters are exclusively `\\(...\\)` and `\\[...\\]`.
 */
export function parseReachDeckNarrationMarkdown(markdown: string): RichTextDocument {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const content: RichTextNode[] = [];

  for (const block of blocks) {
    if (block.length === 0) continue;
    const startsBlockFormula = unescapedDelimiterIndex(block, BLOCK_FORMULA_OPEN) === 0;
    const blockClose = unescapedDelimiterIndex(block, BLOCK_FORMULA_CLOSE);
    const endsBlockFormula =
      blockClose >= 0 && blockClose === block.length - BLOCK_FORMULA_CLOSE.length;
    if (startsBlockFormula || endsBlockFormula) {
      if (!(startsBlockFormula && endsBlockFormula)) {
        malformedFormula();
      }
      const latex = block.slice(BLOCK_FORMULA_OPEN.length, -BLOCK_FORMULA_CLOSE.length);
      if (latex.trim().length === 0 || containsFormulaDelimiter(latex)) malformedFormula();
      content.push({ type: 'blockMath', attrs: { latex } });
      continue;
    }
    if (
      unescapedDelimiterIndex(block, BLOCK_FORMULA_OPEN) >= 0 ||
      unescapedDelimiterIndex(block, BLOCK_FORMULA_CLOSE) >= 0
    ) {
      throw new ReachDeckNarrationMarkdownError(
        'malformed-formula',
        'Block formulas must occupy their own Markdown block.',
      );
    }

    const lines = block.split('\n');
    const inline: RichTextNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) inline.push({ type: 'hardBreak' });
      inline.push(...parseInline(line));
    });
    content.push({ type: 'paragraph', ...(inline.length === 0 ? {} : { content: inline }) });
  }

  return { type: 'doc', ...(content.length === 0 ? {} : { content }) };
}

function parseInline(text: string): RichTextNode[] {
  const result: RichTextNode[] = [];
  // HTML/SSML 审计针对公式外的 Markdown 原文。用等长空格遮罩已识别的
  // `\(...\)` span，既避免把公式间的 `<` / `>` 跨段拼成标签，又保持真实
  // `<span title="\(...\)">` 等标签外壳仍可被原有 fail-closed 规则捕获。
  const plainMarkdownAudit = text.split('');
  let plain = '';
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === '\\' && !text.startsWith(INLINE_FORMULA_OPEN, cursor)) {
      const escaped = text[cursor + 1];
      if (escaped === undefined || !MARKDOWN_ESCAPABLE_CHARACTERS.has(escaped)) {
        throw new ReachDeckNarrationMarkdownError(
          'unsupported-markdown',
          'Literal backslashes in narration markdown must use canonical escaping.',
        );
      }
      plain += escaped;
      cursor += 2;
      continue;
    }
    if (text.startsWith(INLINE_FORMULA_CLOSE, cursor)) malformedFormula();
    if (!text.startsWith(INLINE_FORMULA_OPEN, cursor)) {
      plain += text[cursor];
      cursor += 1;
      continue;
    }
    appendText(result, plain);
    plain = '';
    const close = text.indexOf(INLINE_FORMULA_CLOSE, cursor + INLINE_FORMULA_OPEN.length);
    if (close < 0) malformedFormula();
    const latex = text.slice(cursor + INLINE_FORMULA_OPEN.length, close);
    if (latex.trim().length === 0 || containsFormulaDelimiter(latex)) malformedFormula();
    plainMarkdownAudit.fill(' ', cursor, close + INLINE_FORMULA_CLOSE.length);
    result.push({ type: 'inlineMath', attrs: { latex } });
    cursor = close + INLINE_FORMULA_CLOSE.length;
  }
  appendText(result, plain);
  rejectUnsupportedPlainMarkdown(plainMarkdownAudit.join(''));
  return result;
}

function appendText(nodes: RichTextNode[], text: string): void {
  if (text.length > 0) nodes.push({ type: 'text', text });
}

function rejectUnsupportedPlainMarkdown(text: string): void {
  if (
    /(?<!\\)<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[A-Za-z_:][A-Za-z0-9:._-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?\s*>/u.test(
      text,
    )
  ) {
    throw new ReachDeckNarrationMarkdownError(
      'unsupported-markdown',
      'Raw HTML and SSML are not supported in narration markdown.',
    );
  }
  if (
    /(^|\n)\s{0,3}(?:(?<!\\)#{1,6}\s|(?<!\\)>\s?|(?<!\\)[-+*]\s|\d+[.)]\s)/u.test(text) ||
    /(?:(?<!\\)\*\*|(?<!\\)__|(?<!\\)~~|(?<!\\)`|(?<!\\)!\[[^\]]*\]\(|(?<!\\)\[[^\]]+\]\()/u.test(
      text,
    )
  ) {
    throw new ReachDeckNarrationMarkdownError(
      'unsupported-markdown',
      'Narration markdown supports only plain text, paragraphs, line breaks, and formulas.',
    );
  }
}

const MARKDOWN_ESCAPABLE_CHARACTERS = new Set([
  '\\',
  '`',
  '*',
  '_',
  '<',
  '>',
  '#',
  '+',
  '-',
  '!',
  '|',
  '~',
]);

const serializePlainText = (text: string): string =>
  [...text]
    .map((character) =>
      MARKDOWN_ESCAPABLE_CHARACTERS.has(character) ? `\\${character}` : character,
    )
    .join('');

function containsFormulaDelimiter(value: string): boolean {
  return [INLINE_FORMULA_OPEN, INLINE_FORMULA_CLOSE, BLOCK_FORMULA_OPEN, BLOCK_FORMULA_CLOSE].some(
    (delimiter) => value.includes(delimiter),
  );
}

function unescapedDelimiterIndex(value: string, delimiter: string): number {
  let from = 0;
  while (from < value.length) {
    const found = value.indexOf(delimiter, from);
    if (found < 0) return -1;
    let precedingBackslashes = 0;
    for (let index = found - 1; index >= 0 && value[index] === '\\'; index -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 0) return found;
    from = found + delimiter.length;
  }
  return -1;
}

function malformedFormula(): never {
  throw new ReachDeckNarrationMarkdownError(
    'malformed-formula',
    'Narration markdown contains an empty, nested, or unclosed formula.',
  );
}

/** Serialize constrained TipTap JSON into the one stable Markdown spelling. */
export function serializeReachDeckNarrationMarkdown(doc: RichTextDocument): string {
  if (doc.type !== 'doc') unsupportedRichText('The narration rich-text root must be a doc.');
  const blocks = (doc.content ?? []).map((node) => {
    if (node.type === 'blockMath') return serializeFormula(node, true);
    if (node.type !== 'paragraph') unsupportedRichText(`Unsupported narration node: ${node.type}.`);
    rejectNodeDecoration(node);
    return (node.content ?? [])
      .map((child) => {
        if (child.type === 'text') {
          rejectNodeDecoration(child, true);
          if (typeof child.text !== 'string')
            unsupportedRichText('Narration text must be a string.');
          return serializePlainText(child.text);
        }
        if (child.type === 'hardBreak') {
          rejectNodeDecoration(child);
          if (child.content !== undefined || child.text !== undefined) {
            unsupportedRichText('A narration hard break cannot contain content.');
          }
          return '\n';
        }
        if (child.type === 'inlineMath') return serializeFormula(child, false);
        unsupportedRichText(`Unsupported narration inline node: ${child.type}.`);
      })
      .join('');
  });
  return blocks.join('\n\n');
}

function serializeFormula(node: RichTextNode, block: boolean): string {
  rejectNodeDecoration(node);
  if (node.content !== undefined || node.text !== undefined) {
    unsupportedRichText('Narration formulas store LaTeX only in attrs.latex.');
  }
  const keys = Object.keys(node.attrs ?? {});
  if (keys.length !== 1 || keys[0] !== 'latex' || typeof node.attrs?.latex !== 'string') {
    unsupportedRichText('Narration formulas require only a string attrs.latex value.');
  }
  const latex = node.attrs.latex;
  if (latex.trim().length === 0 || containsFormulaDelimiter(latex)) malformedFormula();
  return block
    ? `${BLOCK_FORMULA_OPEN}${latex}${BLOCK_FORMULA_CLOSE}`
    : `${INLINE_FORMULA_OPEN}${latex}${INLINE_FORMULA_CLOSE}`;
}

function rejectNodeDecoration(node: RichTextNode, allowText = false): void {
  if (node.marks !== undefined && node.marks.length > 0) {
    unsupportedRichText('Narration rich text does not support marks.');
  }
  if (
    !allowText &&
    node.attrs !== undefined &&
    node.type !== 'inlineMath' &&
    node.type !== 'blockMath'
  ) {
    unsupportedRichText(`Narration ${node.type} nodes do not support attributes.`);
  }
}

function unsupportedRichText(message: string): never {
  throw new ReachDeckNarrationMarkdownError('unsupported-rich-text', message);
}

/** Count product semantic units from constrained rich text, treating every formula as one. */
export function countReachDeckNarrationSemanticUnits(doc: RichTextDocument): number {
  // Serialization is also the strict schema check, so unsupported nodes cannot disappear from count.
  serializeReachDeckNarrationMarkdown(doc);
  let count = 0;
  let inLatinOrDigitToken = false;
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

  const countText = (text: string): void => {
    for (const { segment } of segmenter.segment(text)) {
      if (/^\s+$/u.test(segment)) {
        inLatinOrDigitToken = false;
      } else if (/^[\p{Script=Latin}\p{Decimal_Number}\p{Mark}]+$/u.test(segment)) {
        if (!inLatinOrDigitToken) count += 1;
        inLatinOrDigitToken = true;
      } else {
        count += 1;
        inLatinOrDigitToken = false;
      }
    }
  };

  for (const block of doc.content ?? []) {
    inLatinOrDigitToken = false;
    if (block.type === 'blockMath') {
      count += 1;
      continue;
    }
    for (const inline of block.content ?? []) {
      if (inline.type === 'inlineMath') {
        count += 1;
        inLatinOrDigitToken = false;
      } else if (inline.type === 'hardBreak') {
        inLatinOrDigitToken = false;
      } else if (inline.type === 'text') {
        countText(inline.text ?? '');
      }
    }
  }
  return count;
}

/** Legacy segments are presentation-imported as one document; their boundaries become paragraphs. */
export function reachDeckNarrationMarkdownFromSegments(
  segments: readonly Pick<ReachDeckNarrationSegmentV2, 'text'>[],
): string {
  const content: RichTextNode[] = segments.map((segment) => {
    const inline: RichTextNode[] = [];
    segment.text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .forEach((line, index) => {
        if (index > 0) inline.push({ type: 'hardBreak' });
        if (line.length > 0) inline.push({ type: 'text', text: line });
      });
    return { type: 'paragraph', ...(inline.length === 0 ? {} : { content: inline }) };
  });
  return normalizeReachDeckNarrationMarkdown(
    serializeReachDeckNarrationMarkdown({ type: 'doc', content }),
  );
}

/** Read authoritative markdown, falling back to a non-mutating legacy segment import. */
export function reachDeckNarrationMarkdown(
  narration: Pick<ReachDeckNarrationV2, 'markdown' | 'segments'> | undefined,
): string | undefined {
  if (narration === undefined) return undefined;
  if (narration.markdown !== undefined)
    return normalizeReachDeckNarrationMarkdown(narration.markdown);
  if (narration.segments === undefined || narration.segments.length === 0) return undefined;
  return reachDeckNarrationMarkdownFromSegments(narration.segments);
}

/**
 * 纯文本讲稿的朗读文本：去掉规范转义的反斜杠（`\-`、`\>` 等），公式 `\(...\)` / `\[...\]`
 * 原样保留。
 *
 * 讲稿 Markdown 只允许纯文本与公式，原文与朗读文本之间只差这些转义；反斜杠不会被读出，
 * 却会被当作原文参与字幕对齐。输入须是完整讲稿或不切开转义对的片段。
 */
export function unescapeReachDeckNarrationPlainText(markdown: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < markdown.length) {
    const opener = markdown.startsWith(INLINE_FORMULA_OPEN, cursor)
      ? INLINE_FORMULA_CLOSE
      : markdown.startsWith(BLOCK_FORMULA_OPEN, cursor)
        ? BLOCK_FORMULA_CLOSE
        : undefined;
    if (opener !== undefined) {
      const close = markdown.indexOf(opener, cursor + 2);
      const end = close < 0 ? markdown.length : close + opener.length;
      result += markdown.slice(cursor, end);
      cursor = end;
      continue;
    }
    const escaped = markdown[cursor + 1];
    if (
      markdown[cursor] === '\\' &&
      escaped !== undefined &&
      MARKDOWN_ESCAPABLE_CHARACTERS.has(escaped)
    ) {
      result += escaped;
      cursor += 2;
      continue;
    }
    result += markdown[cursor];
    cursor += 1;
  }
  return result;
}

/** Browser-safe, versioned SHA-256 input. Hashing remains at the owning server boundary. */
export const reachDeckNarrationContentDigestInput = (markdown: string): string =>
  `${CONTENT_DIGEST_INPUT_VERSION}\0${normalizeReachDeckNarrationMarkdown(markdown)}`;
