/**
 * Reach Deck 文本元素的富文本文档模型（tiptap / ProseMirror JSON）。
 *
 * 结构故意与 `apps/portal/src/lib/teacher-quiz-mock.ts` 的 `RichTextDocument` 保持一致：
 * quiz 功能已经用同一套形态存 tiptap `getJSON()`，两边共用同样的取舍。
 *
 * 这里只定义**数据形态与纯函数**，不引入 tiptap 运行时依赖 —— dsl 包同时被
 * 服务端 worker 与浏览器加载，实际的 HTML 解析放在各自的边界上做。
 */

/** 行内标记（bold / italic / underline / textStyle 等）。 */
export interface RichTextMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface RichTextNode {
  type: string;
  text?: string;
  marks?: RichTextMark[];
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
}

export interface RichTextDocument {
  type: 'doc';
  content?: RichTextNode[];
}

export interface RichTextGradient {
  angle: number;
  stops: Array<{ offset: number; color: string }>;
}

/** Shared allowlist for renderer and editor; no source CSS or URLs are retained. */
export function parseRichTextGradient(value: unknown): RichTextGradient | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const gradient = value as Record<string, unknown>;
  if (
    typeof gradient.angle !== 'number' ||
    !Number.isFinite(gradient.angle) ||
    !Array.isArray(gradient.stops) ||
    gradient.stops.length < 2 ||
    gradient.stops.length > 32
  )
    return undefined;
  const stops: RichTextGradient['stops'] = [];
  for (const value of gradient.stops) {
    if (typeof value !== 'object' || value === null) return undefined;
    const stop = value as Record<string, unknown>;
    if (
      typeof stop.offset !== 'number' ||
      !Number.isFinite(stop.offset) ||
      stop.offset < 0 ||
      stop.offset > 1 ||
      typeof stop.color !== 'string' ||
      !/^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(stop.color)
    )
      return undefined;
    stops.push({ offset: stop.offset, color: stop.color });
  }
  return { angle: gradient.angle, stops };
}

export function richTextGradientCss(value: unknown): string | undefined {
  const gradient = parseRichTextGradient(value);
  return gradient
    ? `linear-gradient(${gradient.angle}deg, ${gradient.stops.map((stop) => `${stop.color} ${stop.offset * 100}%`).join(', ')})`
    : undefined;
}

const INLINE_MATH_NODE_TYPES = new Set(['inlineMath', 'mathInline']);
const BLOCK_MATH_NODE_TYPES = new Set(['blockMath', 'mathBlock']);

function formulaPlainText(node: RichTextNode): string | undefined {
  const latex = typeof node.attrs?.latex === 'string' ? node.attrs.latex.trim() : '';
  if (!latex) return undefined;
  if (BLOCK_MATH_NODE_TYPES.has(node.type)) return `\\[${latex}\\]`;
  if (INLINE_MATH_NODE_TYPES.has(node.type)) return `\\(${latex}\\)`;
  return undefined;
}

/** Reach Deck 随 Player 一起自托管、可在幻灯片工具栏中选择的完整字体目录。 */
export const REACH_DECK_BUILT_IN_FONT_FAMILIES = [
  'Source Han Sans VF',
  'Source Han Serif SC',
  'Alibaba PuHuiTi 3.0',
  'LXGW WenKai',
  'Zhuque Fangsong (technical preview)',
  'Carlito',
  'Liberation Sans',
  'Liberation Serif',
  'EB Garamond',
  'Montserrat',
  'Anton',
  'Comic Neue',
  'osifont',
  'STIX Two Math',
  'TeX Gyre Adventor',
] as const;
export type ReachDeckBuiltInFontFamily = (typeof REACH_DECK_BUILT_IN_FONT_FAMILIES)[number];

/** Quiz answer editor's retained compact choices; slide authoring uses the built-in catalog above. */
export const RICH_TEXT_FONT_FAMILIES = ['Noto Sans', 'Noto Serif'] as const;
export type RichTextFontFamily =
  | ReachDeckBuiltInFontFamily
  | (typeof RICH_TEXT_FONT_FAMILIES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 把模型漏进纯文本字段的标记降级为纯文本。
 *
 * 富文本只属于 text 元素的 `doc`；标题 / 摘要等仍是普通 `string`。模型会把
 * 强调标签写进这些字段（实测出现过 `如何用<strong style='…'>证据</strong>判断…`
 * 与 `<b style="color:#1E90FF">`），直接渲染成字面标签。块级边界换成空格，
 * 避免把相邻词粘成一个词。
 */
export function plainTextFromMarkup(value: string): string {
  if (!value.includes('<')) return value;
  const protectedMath = protectMathSpans(value);
  // 原始 `<` 只出现在合法数学 span 时不做任何归一，连公式外的空格也保持原样。
  const htmlTagPattern =
    /<\/?[A-Za-z][A-Za-z0-9:_-]*(?:(?:[\s/]+|(?<=["']))[A-Za-z_:][A-Za-z0-9:._-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?\s*>/g;
  if (!htmlTagPattern.test(protectedMath.value)) return protectedMath.restore(protectedMath.value);
  const plainText = protectedMath.value
    .replace(/<(?:br|hr)\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, ' ')
    .replace(htmlTagPattern, '')
    .replace(/\s+/g, ' ')
    .trim();
  return protectedMath.restore(plainText);
}

/**
 * 在 HTML 降级前暂存已经由产品契约识别的 TeX spans。
 *
 * `<` / `>` 在 TeX 中是普通关系运算符，但 `<...>` 会被通用标签剥离规则误判为
 * HTML。这里只保护带显式数学分隔符的完整 span；span 外的真实 HTML/XSS 仍走原有
 * fail-closed 降级。占位前缀会避开输入本身，恢复时不依赖 HTML/Markdown 解析器。
 */
function protectMathSpans(value: string): { value: string; restore: (input: string) => string } {
  const spans: string[] = [];
  let markerPrefix = '\uE000reach-deck-math';
  while (value.includes(markerPrefix)) markerPrefix += '-';
  const markerSuffix = '\uE001';
  const protectedValue = value.replace(
    /\\\([^\r\n]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$(?!\$)[^\r\n$]*\$/g,
    (span) => {
      // 单美元分隔符与货币符号天然歧义。按 Markdown math 的常用边界规则，
      // opening 后和 closing 前都不能是空白；否则 `$5 ... $9` 会把两笔金额之间的
      // HTML 一起误当成公式，绕过下面的标签降级。
      if (
        span.startsWith('$') &&
        !span.startsWith('$$') &&
        (span.length <= 2 || /\s/.test(span[1]!) || /\s/.test(span.at(-2)!))
      ) {
        return span;
      }
      const marker = `${markerPrefix}${spans.length}${markerSuffix}`;
      spans.push(span);
      return marker;
    },
  );
  return {
    value: protectedValue,
    restore: (input) =>
      spans.reduce(
        (restored, span, index) =>
          // 回调用于避免 TeX 的 `$$` 被 String.replace 当成 replacement token 折成 `$`。
          restored.replace(`${markerPrefix}${index}${markerSuffix}`, () => span),
        input,
      ),
  };
}

/** 纯文本 → 富文本文档。空串产出单个空段落，保持 tiptap 的最小合法结构。 */
export function richTextFromPlainText(text: string): RichTextDocument {
  const paragraphs = text.split('\n');
  return {
    type: 'doc',
    content: paragraphs.map((line) => ({
      type: 'paragraph',
      ...(line.length > 0 ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}

/**
 * 富文本 → 纯文本。用于排版容量判定、缩略图、无障碍标签与搜索。
 *
 * 段落之间用 `\n` 连接（`richTextFromPlainText` 的逆运算），行内节点直接拼接
 * 不加空格 —— 中文没有词间空格，插空格会让 `countEffectiveChars` 高估容量占用。
 */
export function richTextToPlainText(document: RichTextDocument): string {
  const visitInline = (nodes: RichTextNode[] | undefined): string =>
    (nodes ?? [])
      .map((node) => node.text ?? formulaPlainText(node) ?? visitInline(node.content))
      .join('');

  return (document.content ?? [])
    .map((node) =>
      node.type === 'hardBreak'
        ? '\n'
        : (formulaPlainText(node) ?? visitInline(node.content ?? [node])),
    )
    .join('\n');
}

const RENDERABLE_ATOM_NODE_TYPES = new Set([
  'attachment',
  'blockMath',
  'image',
  'inlineMath',
  'mathBlock',
  'mathInline',
  'mermaidDiagram',
]);

/** Whether a document contains visible text or a semantic atom such as a formula or image. */
export function richTextHasRenderableContent(document: RichTextDocument): boolean {
  const visit = (nodes: RichTextNode[] | undefined): boolean =>
    (nodes ?? []).some((node) => {
      if (typeof node.text === 'string' && node.text.trim().length > 0) return true;
      if (RENDERABLE_ATOM_NODE_TYPES.has(node.type)) {
        if (INLINE_MATH_NODE_TYPES.has(node.type) || BLOCK_MATH_NODE_TYPES.has(node.type)) {
          return typeof node.attrs?.latex === 'string' && node.attrs.latex.trim().length > 0;
        }
        return true;
      }
      return visit(node.content);
    });
  return visit(document.content);
}

/** Collect stable OSS object keys referenced by rich-text asset nodes. */
export function collectRichTextObjectKeys(document: RichTextDocument): string[] {
  const keys = new Set<string>();
  const visit = (nodes: RichTextNode[] | undefined) => {
    for (const node of nodes ?? []) {
      const objectKey = node.attrs?.objectKey;
      if (typeof objectKey === 'string' && objectKey.trim().length > 0) keys.add(objectKey);
      visit(node.content);
    }
  };
  visit(document.content);
  return [...keys];
}

/** 文档是否有可见内容（全空白视为空）。 */
export function richTextIsEmpty(document: RichTextDocument): boolean {
  return !richTextHasRenderableContent(document);
}

/**
 * 返回一段富文本实际需要的最大字号。
 *
 * 文本框 variant 只提供未标记文字的基准字号；整框缩小字号后，每个文字节点都会带
 * `textStyle.fontSize`。渲染段落必须用实际最大字号建立行盒，否则标题的 64px 基准
 * strut 会继续占位，把 20px 文字向下压出一块看似 padding 的空隙。
 */
export function richTextMaximumFontSize(
  root: RichTextDocument | RichTextNode,
  fallbackFontSize: number,
): number {
  const fallback =
    Number.isFinite(fallbackFontSize) && fallbackFontSize > 0 ? fallbackFontSize : 16;
  let maximum = 0;
  const visit = (nodes: RichTextNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (formulaPlainText(node) !== undefined) maximum = Math.max(maximum, fallback);
      if (typeof node.text === 'string' && node.text.length > 0) {
        const textStyle = node.marks?.find((mark) => mark.type === 'textStyle');
        const parsed = Number.parseFloat(String(textStyle?.attrs?.fontSize ?? ''));
        maximum = Math.max(maximum, Number.isFinite(parsed) && parsed > 0 ? parsed : fallback);
      }
      visit(node.content);
    }
  };
  visit(root.content);
  return maximum > 0 ? maximum : fallback;
}

function parseMarks(value: unknown): RichTextMark[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const marks: RichTextMark[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.type !== 'string') continue;
    marks.push({
      type: entry.type,
      ...(isRecord(entry.attrs) ? { attrs: entry.attrs } : {}),
    });
  }
  return marks.length > 0 ? marks : undefined;
}

/**
 * 丢掉值为 null / undefined 的属性。
 *
 * tiptap 会给节点补齐所有已注册扩展的默认属性（例如 TextAlign 会写入
 * `textAlign: null`）。若把这些空属性存进文档，`getJSON()` 的结果就和库里存的
 * 不一致，编辑器挂载时会误判成"内容变了"而触发一次伪编辑。统一剔除后，
 * 有值的属性才会被持久化。
 */
function parseAttrs(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const attrs: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    attrs[key] = entry;
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function parseNode(value: unknown): RichTextNode | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  const content = parseNodes(value.content);
  const marks = parseMarks(value.marks);
  const attrs = parseAttrs(value.attrs);
  return {
    type: value.type,
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
    ...(marks === undefined ? {} : { marks }),
    ...(attrs === undefined ? {} : { attrs }),
    ...(content === undefined ? {} : { content }),
  };
}

function parseNodes(value: unknown): RichTextNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nodes: RichTextNode[] = [];
  for (const entry of value) {
    const node = parseNode(entry);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}

/** 结构校验：是否是形态合法的富文本文档（不校验节点类型是否被 schema 支持）。 */
export function isRichTextDocumentShape(value: unknown): value is RichTextDocument {
  if (!isRecord(value) || value.type !== 'doc') return false;
  if (value.content === undefined) return true;
  if (!Array.isArray(value.content)) return false;

  const nodeIsShaped = (node: unknown): boolean => {
    if (!isRecord(node) || typeof node.type !== 'string') return false;
    if (node.text !== undefined && typeof node.text !== 'string') return false;
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) return false;
      if (!node.marks.every((mark) => isRecord(mark) && typeof mark.type === 'string'))
        return false;
      if (
        node.marks.some(
          (mark) =>
            isRecord(mark) &&
            isRecord(mark.attrs) &&
            mark.attrs.textGradient != null &&
            !parseRichTextGradient(mark.attrs.textGradient),
        )
      )
        return false;
    }
    if (node.attrs !== undefined && !isRecord(node.attrs)) return false;
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return false;
      if (!node.content.every(nodeIsShaped)) return false;
    }
    return true;
  };

  return value.content.every(nodeIsShaped);
}

/**
 * 字符串 → 富文本的解析器。
 *
 * 默认按纯文本处理。AI Runtime Reach Deck 在启动时注册 tiptap 原生的 HTML 解析
 * （见 `@reachany/reach-deck-rich-text` 的 `richTextFromModelHtml`），使模型产出的
 * 受限 HTML 能被解析成带 mark 的富文本。dsl 本身保持零依赖，不直接引入 tiptap。
 */
let stringParser: (value: string) => RichTextDocument = richTextFromPlainText;

/** 注册字符串解析器；传 undefined 恢复为纯文本解析。 */
export function setRichTextStringParser(
  parser: ((value: string) => RichTextDocument) | undefined,
): void {
  stringParser = parser ?? richTextFromPlainText;
}

/**
 * 归一化到稳定形态：接受**字符串**或富文本文档。
 *
 * 这是遗留课件与模型输出的升级入口 —— 旧数据里 `TextElement.text` 是 string，
 * 新数据是富文本文档，两者都要能加载。必须**幂等且键序稳定**：文档整体会被
 * `reachDeckRevisionToken`（services/ai-runtime/lib/reach-deck/deck-store.ts）做 sha256，
 * 同一逻辑内容每次都要产出同一份 JSON，否则每次加载都会换 revision token
 * 并触发假 409 冲突。
 */
export function normalizeRichText(value: unknown): RichTextDocument {
  if (typeof value === 'string') return stringParser(value);
  if (!isRichTextDocumentShape(value)) {
    throw new Error('Text element content must be a string or a rich text document.');
  }
  const content = parseNodes(value.content);
  return { type: 'doc', ...(content === undefined ? {} : { content }) };
}

/**
 * 文本元素内容的升级入口：同时接受新形态 `doc` 与遗留形态 `text`。
 *
 * 遗留课件（以及仍按 JSON Schema 产出 `text: string` 的模型输出）在这里被抬升为
 * 富文本文档，因此不需要数据迁移脚本，也不需要变更 `reach-deck-document/v2` 版本号。
 * `doc` 优先 —— 两个字段同时存在时以富文本为准，避免升级后又被旧字段覆盖。
 */
export function normalizeTextElementContent(source: {
  doc?: unknown;
  text?: unknown;
}): RichTextDocument {
  if (source.doc !== undefined) return normalizeRichText(source.doc);
  if (typeof source.text === 'string') return normalizeRichText(source.text);
  throw new Error('Text element must provide either doc or text.');
}
