import {
  QUIZ_BLOCK_MATH_CLOSE,
  QUIZ_BLOCK_MATH_OPEN,
  QUIZ_FEEDBACK_COLORS,
  QUIZ_INLINE_MATH_CLOSE,
  QUIZ_INLINE_MATH_OPEN,
  QUIZ_MARKDOWN_LIMITS,
} from './constants.js';

export type QuizMarkdownDiagnosticSeverity = 'repairable' | 'unsafe';

export interface QuizMarkdownDiagnostic {
  readonly code:
    | 'content-too-long'
    | 'unclosed-code-fence'
    | 'unclosed-inline-code'
    | 'unclosed-strong'
    | 'unclosed-strikethrough'
    | 'unclosed-inline-math'
    | 'unexpected-inline-math-close'
    | 'invalid-inline-math-content'
    | 'unclosed-block-math'
    | 'unexpected-block-math-close'
    | 'invalid-block-math-line'
    | 'unsafe-html'
    | 'invalid-color-mark'
    | 'unsafe-link-protocol'
    | 'invalid-image-uri'
    | 'unsafe-media-reference'
    | 'mermaid-too-long';
  readonly severity: QuizMarkdownDiagnosticSeverity;
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

export interface QuizMarkdownValidation {
  readonly ok: boolean;
  readonly diagnostics: readonly QuizMarkdownDiagnostic[];
  readonly repairable: boolean;
}

/**
 * Decode one extra escaping layer on math delimiters before rendering model-authored Markdown.
 * Code spans and fenced code blocks stay byte-for-byte unchanged. A doubled delimiter becomes
 * active math, while three leading slashes retain one escaped slash after decoding.
 * @deprecated Use normalizeQuizMarkdownMath for generation/rendering; this legacy decoder is not idempotent.
 */
export function decodeQuizMarkdownMathEscapes(markdown: string): string {
  const codeMask = new Uint8Array(markdown.length);
  scanCode(markdown, codeMask, []);

  let decoded = '';
  let index = 0;
  while (index < markdown.length) {
    if (codeMask[index] === 1 || markdown[index] !== '\\') {
      decoded += markdown[index];
      index += 1;
      continue;
    }

    let runEnd = index + 1;
    while (markdown[runEnd] === '\\') runEnd += 1;
    const runLength = runEnd - index;
    const next = markdown[runEnd];
    const isMathBoundary = next === '(' || next === ')' || next === '[' || next === ']';
    decoded += '\\'.repeat(isMathBoundary && runLength >= 2 ? runLength - 1 : runLength);
    index = runEnd;
  }
  return decoded;
}

/**
 * Canonicalize complete model-authored math before both validation and rendering.
 * Only an entire Markdown line (or an already separated block) can become display math.
 * Unlike the legacy decoder, this is idempotent: three or more slashes remain literal.
 */
export function normalizeQuizMarkdownMath(markdown: string): string {
  if (markdown.length > QUIZ_MARKDOWN_LIMITS.maxLength) return markdown;
  const protectedMask = quizMarkdownProtectedTextMask(markdown);

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const blockMask = new Uint8Array(markdown.length);
  const lines = lineRanges(markdown);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const raw = markdown.slice(line.start, line.contentEnd);
    const opening = /^([ \t]*)(\\{1,2})\[/.exec(raw);
    if (opening === null) continue;
    const start = line.start + opening[1]!.length;
    const bodyStart = line.start + opening[0].length;
    if (protectedMask[start] === 1) continue;

    // Only a delimiter-only opening line may continue onto later lines. In particular,
    // a literal `\\[a\\] is an example` must never consume a later formula's close.
    const lastLine = raw.slice(opening[0].length).trim() === '' ? lines.length - 1 : lineIndex;
    let rejected = false;
    for (let closeIndex = lineIndex; closeIndex <= lastLine; closeIndex += 1) {
      const closeLine = lines[closeIndex]!;
      const closeRaw = markdown.slice(closeLine.start, closeLine.contentEnd);
      let closing: { start: number; end: number } | undefined;
      const boundaries = /(?<!\\)(\\{1,2})([\[\]])/g;
      boundaries.lastIndex = closeIndex === lineIndex ? bodyStart - line.start : 0;
      for (
        let boundary = boundaries.exec(closeRaw);
        boundary !== null;
        boundary = boundaries.exec(closeRaw)
      ) {
        if (boundary[2] === '[' && boundary[1]!.length === 2) {
          const spacingEnd = texRowSpacingEnd(closeRaw, boundary.index + boundary[0].length);
          if (spacingEnd !== undefined) {
            boundaries.lastIndex = spacingEnd;
            continue;
          }
        }
        const end = boundary.index + boundary[0].length;
        if (boundary[2] !== ']' || closeRaw.slice(end).trim() !== '') {
          rejected = true;
          break;
        }
        closing = { start: closeLine.start + boundary.index, end: closeLine.start + end };
        break;
      }
      if (rejected) break;
      if (closing === undefined) continue;
      const { start: closeStart, end } = closing;
      blockMask.fill(1, start, end);
      lineIndex = closeIndex;
      if (protectedMask.subarray(start, end).some((entry) => entry === 1)) break;
      const body = markdown.slice(bodyStart, closeStart);
      if (body.trim().length === 0) break;
      const indent = opening[1]!;
      const leading = body.startsWith('\n') || body.startsWith('\r\n') ? '' : `\n${indent}`;
      const trailing = /\n[ \t]*$/.test(body) ? '' : `\n${indent}`;
      edits.push({ start, end, text: `\\[${leading}${body}${trailing}\\]` });
      break;
    }
  }

  // Existing doubled inline delimiters are common too. Decode only complete pairs and
  // leave display bodies alone, including TeX matrix row separators such as \\\\[2pt].
  let inlineOpen: { start: number; bodyStart: number; nested: boolean } | undefined;
  for (const match of markdown.matchAll(/(?<!\\)\\{1,2}[()]/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (protectedMask[start] === 1 || blockMask[start] === 1) continue;
    if (match[0].endsWith('(')) {
      if (inlineOpen === undefined) inlineOpen = { start, bodyStart: end, nested: false };
      else inlineOpen.nested = true;
      continue;
    }
    if (inlineOpen === undefined) continue;
    const body = markdown.slice(inlineOpen.bodyStart, start);
    if (
      !inlineOpen.nested &&
      !body.includes('\n') &&
      !protectedMask.subarray(inlineOpen.start, end).some((entry) => entry === 1) &&
      !blockMask.subarray(inlineOpen.start, end).some((entry) => entry === 1)
    ) {
      edits.push({ start: inlineOpen.start, end, text: `\\(${body}\\)` });
    }
    inlineOpen = undefined;
  }

  let normalized = markdown;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    normalized = normalized.slice(0, edit.start) + edit.text + normalized.slice(edit.end);
  }
  return normalized;
}

/** A TeX row separator takes an ordinary optional `[...]` argument, never a display close. */
function texRowSpacingEnd(line: string, from: number): number | undefined {
  for (let index = from; index < line.length; index += 1) {
    if (line[index] === ']' && !isEscaped(line, index)) return index + 1;
    // Another display delimiter cannot be hidden inside an optional spacing argument.
    if (
      line[index] === '\\' &&
      line[index - 1] !== '\\' &&
      /^\\{1,2}[\[\]]/.test(line.slice(index, index + 3))
    ) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Literal slash runs which a Markdown parser must not partially consume and turn into math.
 * Offsets refer to the supplied (already normalized) text; code, URLs and real TeX are excluded.
 */
export function quizMarkdownMathLiteralRanges(
  markdown: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const protectedMask = quizMarkdownProtectedTextMask(markdown);
  const mathMask = new Uint8Array(markdown.length);
  scanBlockMath(markdown, protectedMask, mathMask, []);
  scanInlineMath(markdown, protectedMask, mathMask, []);
  return [...markdown.matchAll(/\\{3,}[()[\]]/g)].flatMap((match) => {
    const start = match.index;
    const end = start + match[0].length;
    return protectedMask[start] === 1 || mathMask[start] === 1 ? [] : [{ start, end }];
  });
}

function quizMarkdownProtectedTextMask(markdown: string): Uint8Array {
  const mask = new Uint8Array(markdown.length);
  scanCode(markdown, mask, []);
  maskIndentedCode(markdown, mask);
  // Delimiters in link destinations, autolinks, bare URLs and reference definitions are data.
  for (const pattern of [
    /!?\[[^\]\n]*\]\([^\n]*?\)/g,
    /<[^<>\s]+:[^<>\n]*>/g,
    // Bare ASCII URLs end before adjacent Chinese prose; explicit targets above remain intact.
    /\b[a-z][a-z\d+.-]*:\/\/[\x21-\x3b\x3d\x3f-\x7e]+/gi,
    /^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*/gm,
  ]) {
    for (const match of markdown.matchAll(pattern)) {
      mask.fill(1, match.index, match.index + match[0].length);
    }
  }
  return mask;
}

/** Resolve indentation relative to list content; four absolute spaces need not mean code. */
function maskIndentedCode(markdown: string, mask: Uint8Array): void {
  const lines = lineRanges(markdown);
  const confirmedMathOpenings = new Set<number>();
  let pendingMathOpening: number | undefined;
  for (const line of lines) {
    if (mask[line.start] === 1) continue;
    const trimmed = markdown.slice(line.start, line.contentEnd).trim();
    if (/^\\{1,2}\[$/.test(trimmed)) pendingMathOpening = line.start;
    if (/^\\{1,2}\]$/.test(trimmed) && pendingMathOpening !== undefined) {
      confirmedMathOpenings.add(pendingMathOpening);
      pendingMathOpening = undefined;
    }
  }
  const listIndents: number[] = [];
  let previousBlank = true;
  let indentedCode = false;
  let displayMath = false;
  for (const line of lines) {
    const raw = markdown.slice(line.start, line.contentEnd);
    if (raw.trim() === '') {
      previousBlank = true;
      continue;
    }
    const whitespace = /^[ \t]*/.exec(raw)![0];
    const indent = indentationWidth(whitespace);
    while (listIndents.length > 0 && indent < listIndents.at(-1)!) listIndents.pop();
    const containerIndent = listIndents.at(-1) ?? 0;
    if (!displayMath && indent >= containerIndent + 4 && (previousBlank || indentedCode)) {
      mask.fill(1, line.start, line.end);
      indentedCode = true;
      previousBlank = false;
      continue;
    }
    indentedCode = false;
    if (mask[line.start] !== 1) {
      const marker = /^(?:[-+*]|\d+[.)])[ \t]+/.exec(raw.slice(whitespace.length));
      if (marker !== null && indent < containerIndent + 4) {
        listIndents.push(indentationWidth(whitespace + marker[0]));
      }
      if (confirmedMathOpenings.has(line.start)) displayMath = true;
      if (/^\\{1,2}\]$/.test(raw.trim())) displayMath = false;
    }
    previousBlank = false;
  }
}

function indentationWidth(whitespace: string): number {
  let width = 0;
  for (const character of whitespace) width += character === '\t' ? 4 - (width % 4) : 1;
  return width;
}

const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/g;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const COLOR_OPEN_PATTERN = /^<span data-feedback-color="(accent|success|warning|danger|muted)">$/;
const COLOR_CLOSE = '</span>';
const IMAGE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINK_PATTERN = /(^|[^!])\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const UNSAFE_SCHEME_PATTERN = /(?:javascript|data|blob|file|attachment)\s*:/gi;
const RAW_MEDIA_URL_PATTERN =
  /https?:\/\/\S+\.(?:avif|gif|jpe?g|png|svg|webp|mp3|mp4|mpeg|ogg|wav|webm)(?:[?#]\S*)?/gi;
const OSS_URI_PATTERN = /reachany-oss:\/\/[^\s)>]+/g;

/** Validate persisted Quiz feedback Markdown without interpreting ordinary dollar signs as math. */
export function validateQuizMarkdown(markdown: string): QuizMarkdownValidation {
  const diagnostics: QuizMarkdownDiagnostic[] = [];
  if (markdown.length > QUIZ_MARKDOWN_LIMITS.maxLength) {
    diagnostics.push(
      diagnostic(
        'content-too-long',
        'unsafe',
        `Markdown 超过 ${QUIZ_MARKDOWN_LIMITS.maxLength} 字符上限`,
        QUIZ_MARKDOWN_LIMITS.maxLength,
        markdown.length,
      ),
    );
  }

  const codeMask = new Uint8Array(markdown.length);
  scanCode(markdown, codeMask, diagnostics);
  const mathMask = new Uint8Array(markdown.length);
  scanBlockMath(markdown, codeMask, mathMask, diagnostics);
  scanInlineMath(markdown, codeMask, mathMask, diagnostics);
  // TeX 的原始 `<` / `>` 是关系运算符，不是 HTML。先建立 mathMask，再扫描标签，
  // 使完整数学 span 内的 `<y>` 不会被 HTML 正则误判；span 外仍严格 fail closed。
  scanHtml(markdown, codeMask, mathMask, diagnostics);
  scanLinksAndMedia(markdown, codeMask, diagnostics);
  scanPairedToken(
    markdown,
    '**',
    'unclosed-strong',
    '粗体定界符 ** 未配对',
    codeMask,
    mathMask,
    diagnostics,
  );
  scanPairedToken(
    markdown,
    '~~',
    'unclosed-strikethrough',
    '删除线定界符 ~~ 未配对',
    codeMask,
    mathMask,
    diagnostics,
  );

  diagnostics.sort((left, right) => left.start - right.start || left.end - right.end);
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    repairable:
      diagnostics.length > 0 && diagnostics.every((entry) => entry.severity === 'repairable'),
  };
}

function scanCode(markdown: string, mask: Uint8Array, diagnostics: QuizMarkdownDiagnostic[]): void {
  const lines = lineRanges(markdown);
  let open: { start: number; marker: string; language: string; contentStart: number } | undefined;
  for (const line of lines) {
    const value = markdown.slice(line.start, line.contentEnd);
    const match = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(value);
    if (open === undefined) {
      if (match === null) continue;
      open = {
        start: line.start,
        marker: match[1]!,
        language: match[2]!.trim().toLowerCase(),
        contentStart: line.end,
      };
      continue;
    }
    const closing = new RegExp(
      `^ {0,3}${escapeRegExp(open.marker[0]!)}{${open.marker.length},}\\s*$`,
    );
    if (!closing.test(value)) continue;
    mask.fill(1, open.start, line.end);
    if (open.language === 'mermaid') {
      const bodyLength = line.start - open.contentStart;
      if (bodyLength > QUIZ_MARKDOWN_LIMITS.maxMermaidLength) {
        diagnostics.push(
          diagnostic(
            'mermaid-too-long',
            'unsafe',
            `Mermaid 源码超过 ${QUIZ_MARKDOWN_LIMITS.maxMermaidLength} 字符上限`,
            open.contentStart,
            line.start,
          ),
        );
      }
    }
    open = undefined;
  }
  if (open !== undefined) {
    mask.fill(1, open.start, markdown.length);
    if (
      open.language === 'mermaid' &&
      markdown.length - open.contentStart > QUIZ_MARKDOWN_LIMITS.maxMermaidLength
    ) {
      diagnostics.push(
        diagnostic(
          'mermaid-too-long',
          'unsafe',
          `Mermaid 源码超过 ${QUIZ_MARKDOWN_LIMITS.maxMermaidLength} 字符上限`,
          open.contentStart,
          markdown.length,
        ),
      );
    }
    diagnostics.push(
      diagnostic(
        'unclosed-code-fence',
        'repairable',
        `代码围栏 ${open.marker} 未闭合`,
        open.start,
        open.start + open.marker.length,
      ),
    );
  }

  let index = 0;
  while (index < markdown.length) {
    if (mask[index] === 1 || markdown[index] !== '`' || isEscaped(markdown, index)) {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (markdown[index + runLength] === '`') runLength += 1;
    const marker = '`'.repeat(runLength);
    const close = findUnmaskedToken(markdown, marker, index + runLength, mask);
    if (close < 0) {
      diagnostics.push(
        diagnostic(
          'unclosed-inline-code',
          'repairable',
          `行内代码定界符 ${marker} 未闭合`,
          index,
          index + runLength,
        ),
      );
      index += runLength;
      continue;
    }
    mask.fill(1, index, close + runLength);
    index = close + runLength;
  }
}

function scanHtml(
  markdown: string,
  codeMask: Uint8Array,
  mathMask: Uint8Array,
  diagnostics: QuizMarkdownDiagnostic[],
): void {
  // 不能只在 match 起点检查 mask：`\\(x<y\\)<img ...>` 会让宽泛标签正则从公式内
  // 的 `<y` 一路吞到公式外 `<img>` 的 `>`，从而漏掉真正的 XSS 标签。用等长空格
  // 覆盖 code/math 后再扫描，既切断跨边界匹配，也保持 diagnostic 的原始索引。
  const htmlSource = Array.from({ length: markdown.length }, (_, index) =>
    codeMask[index] === 1 || mathMask[index] === 1 ? ' ' : markdown[index]!,
  ).join('');
  let colorDepth = 0;
  for (const match of htmlSource.matchAll(HTML_COMMENT_PATTERN)) {
    const start = match.index;
    diagnostics.push(
      diagnostic(
        'unsafe-html',
        'unsafe',
        'HTML 注释不属于受控颜色标记，已禁止',
        start,
        start + match[0].length,
      ),
    );
  }
  for (const match of htmlSource.matchAll(HTML_TAG_PATTERN)) {
    const start = match.index;
    const tag = match[0];
    const color = COLOR_OPEN_PATTERN.exec(tag)?.[1];
    if (color !== undefined && QUIZ_FEEDBACK_COLORS.includes(color as never)) {
      colorDepth += 1;
      continue;
    }
    if (tag === COLOR_CLOSE && colorDepth > 0) {
      colorDepth -= 1;
      continue;
    }
    diagnostics.push(
      diagnostic(
        tag.startsWith('<span') || tag === COLOR_CLOSE ? 'invalid-color-mark' : 'unsafe-html',
        'unsafe',
        '只允许成对的受控 data-feedback-color span，其他 HTML 被禁止',
        start,
        start + tag.length,
      ),
    );
  }
  if (colorDepth !== 0) {
    diagnostics.push(
      diagnostic(
        'invalid-color-mark',
        'unsafe',
        '受控颜色 span 未闭合',
        markdown.length,
        markdown.length,
      ),
    );
  }
}

function scanLinksAndMedia(
  markdown: string,
  codeMask: Uint8Array,
  diagnostics: QuizMarkdownDiagnostic[],
): void {
  const imageRanges: Array<{ start: number; end: number }> = [];
  for (const match of markdown.matchAll(IMAGE_PATTERN)) {
    const start = match.index;
    if (codeMask[start] === 1) continue;
    imageRanges.push({ start, end: start + match[0].length });
    const uri = match[1]!;
    if (!isValidOssImageUri(uri)) {
      diagnostics.push(
        diagnostic(
          'invalid-image-uri',
          'unsafe',
          'Markdown 图片只允许稳定的 reachany-oss:// objectKey',
          start,
          start + match[0].length,
        ),
      );
    }
  }
  for (const match of markdown.matchAll(OSS_URI_PATTERN)) {
    const start = match.index;
    if (codeMask[start] === 1) continue;
    if (imageRanges.some((range) => start >= range.start && start < range.end)) continue;
    diagnostics.push(
      diagnostic(
        'invalid-image-uri',
        'unsafe',
        'reachany-oss URI 只能出现在合法 Markdown 图片引用中',
        start,
        start + match[0].length,
      ),
    );
  }
  for (const match of markdown.matchAll(LINK_PATTERN)) {
    const start = match.index + match[1]!.length;
    if (codeMask[start] === 1) continue;
    const target = match[2]!;
    if (!isAllowedLinkTarget(target)) {
      diagnostics.push(
        diagnostic(
          'unsafe-link-protocol',
          'unsafe',
          `链接协议不受支持：${target.slice(0, 80)}`,
          start,
          start + match[0].length,
        ),
      );
    }
  }
  for (const pattern of [UNSAFE_SCHEME_PATTERN, RAW_MEDIA_URL_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of markdown.matchAll(pattern)) {
      const start = match.index;
      if (codeMask[start] === 1) continue;
      diagnostics.push(
        diagnostic(
          'unsafe-media-reference',
          'unsafe',
          '禁止 data/blob/file/attachment URI 及外链媒体地址',
          start,
          start + match[0].length,
        ),
      );
    }
  }
}

function scanBlockMath(
  markdown: string,
  codeMask: Uint8Array,
  mathMask: Uint8Array,
  diagnostics: QuizMarkdownDiagnostic[],
): void {
  let open: number | undefined;
  for (const line of lineRanges(markdown)) {
    if (codeMask[line.start] === 1) continue;
    const raw = markdown.slice(line.start, line.contentEnd);
    const trimmed = raw.trim();
    const tokenStart = line.start + raw.indexOf(trimmed);
    if (trimmed === QUIZ_BLOCK_MATH_OPEN && !isEscaped(markdown, tokenStart)) {
      if (open !== undefined) {
        diagnostics.push(
          diagnostic(
            'unclosed-block-math',
            'repairable',
            '块级公式开始定界符在前一公式闭合前再次出现',
            open,
            open + QUIZ_BLOCK_MATH_OPEN.length,
          ),
        );
      }
      open = tokenStart;
      continue;
    }
    if (trimmed === QUIZ_BLOCK_MATH_CLOSE && !isEscaped(markdown, tokenStart)) {
      if (open === undefined) {
        diagnostics.push(
          diagnostic(
            'unexpected-block-math-close',
            'repairable',
            '块级公式结束定界符没有对应的开始定界符',
            tokenStart,
            tokenStart + QUIZ_BLOCK_MATH_CLOSE.length,
          ),
        );
      } else {
        mathMask.fill(1, open, line.end);
        open = undefined;
      }
      continue;
    }
    for (const token of [QUIZ_BLOCK_MATH_OPEN, QUIZ_BLOCK_MATH_CLOSE]) {
      const tokenIndex = raw.indexOf(token);
      const absoluteIndex = line.start + tokenIndex;
      if (
        tokenIndex >= 0 &&
        codeMask[absoluteIndex] === 0 &&
        isSingleMathSlash(markdown, absoluteIndex)
      ) {
        diagnostics.push(
          diagnostic(
            'invalid-block-math-line',
            'repairable',
            `块级公式定界符 ${token} 必须独立成行`,
            absoluteIndex,
            absoluteIndex + token.length,
          ),
        );
      }
    }
  }
  if (open !== undefined) {
    // 未闭合内容不是完整数学 span，不能遮蔽其后的 HTML/XSS 扫描。
    diagnostics.push(
      diagnostic(
        'unclosed-block-math',
        'repairable',
        '块级公式未使用独立成行的 \\] 闭合',
        open,
        open + QUIZ_BLOCK_MATH_OPEN.length,
      ),
    );
  }
}

function scanInlineMath(
  markdown: string,
  codeMask: Uint8Array,
  mathMask: Uint8Array,
  diagnostics: QuizMarkdownDiagnostic[],
): void {
  let open: number | undefined;
  for (let index = 0; index < markdown.length; index += 1) {
    if (codeMask[index] === 1 || mathMask[index] === 1 || !isSingleMathSlash(markdown, index))
      continue;
    if (markdown.startsWith(QUIZ_INLINE_MATH_OPEN, index)) {
      if (open !== undefined) {
        diagnostics.push(
          diagnostic(
            'unclosed-inline-math',
            'repairable',
            '行内公式开始定界符在前一公式闭合前再次出现',
            open,
            open + QUIZ_INLINE_MATH_OPEN.length,
          ),
        );
      }
      open = index;
      index += QUIZ_INLINE_MATH_OPEN.length - 1;
      continue;
    }
    if (!markdown.startsWith(QUIZ_INLINE_MATH_CLOSE, index)) continue;
    if (open === undefined) {
      diagnostics.push(
        diagnostic(
          'unexpected-inline-math-close',
          'repairable',
          '行内公式结束定界符没有对应的开始定界符',
          index,
          index + QUIZ_INLINE_MATH_CLOSE.length,
        ),
      );
    } else {
      if (markdown.slice(open, index).includes('\n')) {
        diagnostics.push(
          diagnostic(
            'unclosed-inline-math',
            'repairable',
            '行内公式不能跨行，请改用独立成行的 \\[ 与 \\]',
            open,
            open + QUIZ_INLINE_MATH_OPEN.length,
          ),
        );
      } else {
        mathMask.fill(1, open, index + QUIZ_INLINE_MATH_CLOSE.length);
        const body = markdown.slice(open + QUIZ_INLINE_MATH_OPEN.length, index).trim();
        if (isLiteralDelimiterExample(body)) {
          diagnostics.push(
            diagnostic(
              'invalid-inline-math-content',
              'repairable',
              '行内公式不能只包含连接词或占位省略号；展示定界符本身时请改用行内代码',
              open,
              index + QUIZ_INLINE_MATH_CLOSE.length,
            ),
          );
        }
      }
      open = undefined;
    }
    index += QUIZ_INLINE_MATH_CLOSE.length - 1;
  }
  if (open !== undefined) {
    diagnostics.push(
      diagnostic(
        'unclosed-inline-math',
        'repairable',
        '行内公式未使用 \\) 闭合',
        open,
        open + QUIZ_INLINE_MATH_OPEN.length,
      ),
    );
  }
}

function isLiteralDelimiterExample(body: string): boolean {
  return /^(?:\.{2,}|…+|和|或|与|以及|and|or)$/iu.test(body);
}

function scanPairedToken(
  markdown: string,
  token: string,
  code: 'unclosed-strong' | 'unclosed-strikethrough',
  message: string,
  codeMask: Uint8Array,
  mathMask: Uint8Array,
  diagnostics: QuizMarkdownDiagnostic[],
): void {
  const positions: number[] = [];
  for (let index = 0; index <= markdown.length - token.length; index += 1) {
    if (
      codeMask[index] === 0 &&
      mathMask[index] === 0 &&
      !isEscaped(markdown, index) &&
      markdown.startsWith(token, index)
    ) {
      positions.push(index);
      index += token.length - 1;
    }
  }
  if (positions.length % 2 !== 0) {
    const start = positions.at(-1)!;
    diagnostics.push(diagnostic(code, 'repairable', message, start, start + token.length));
  }
}

function isValidOssImageUri(uri: string): boolean {
  const prefix = 'reachany-oss://';
  if (!uri.startsWith(prefix)) return false;
  const objectKey = uri.slice(prefix.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(objectKey)) return false;
  if (objectKey.includes('//') || objectKey.includes('?') || objectKey.includes('#')) return false;
  return !objectKey.split('/').some((segment) => segment === '.' || segment === '..');
}

function isAllowedLinkTarget(target: string): boolean {
  if (target.startsWith('/') || target.startsWith('#')) return true;
  return /^(?:https?:\/\/|mailto:)/i.test(target);
}

function lineRanges(markdown: string): Array<{ start: number; contentEnd: number; end: number }> {
  const ranges: Array<{ start: number; contentEnd: number; end: number }> = [];
  let start = 0;
  while (start <= markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const contentEnd = newline < 0 ? markdown.length : newline;
    ranges.push({ start, contentEnd, end: newline < 0 ? markdown.length : newline + 1 });
    if (newline < 0) break;
    start = newline + 1;
  }
  return ranges;
}

function findUnmaskedToken(
  markdown: string,
  token: string,
  from: number,
  mask: Uint8Array,
): number {
  let index = markdown.indexOf(token, from);
  while (index >= 0) {
    if (mask[index] === 0 && !isEscaped(markdown, index)) return index;
    index = markdown.indexOf(token, index + token.length);
  }
  return -1;
}

function isEscaped(markdown: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function isSingleMathSlash(markdown: string, index: number): boolean {
  return markdown[index] === '\\' && markdown[index - 1] !== '\\';
}

function diagnostic(
  code: QuizMarkdownDiagnostic['code'],
  severity: QuizMarkdownDiagnosticSeverity,
  message: string,
  start: number,
  end: number,
): QuizMarkdownDiagnostic {
  return { code, severity, message, start, end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
