import { generateHTML, generateJSON } from '@tiptap/html';
import {
  CLIPBOARD_HTML_MAX_CHARACTERS,
  CLIPBOARD_MAX_DEPTH,
  CLIPBOARD_MAX_NODES,
  CLIPBOARD_MAX_PARAGRAPHS,
  CLIPBOARD_MAX_TEXT_CHARACTERS,
  transformOfficeClipboardHtml,
} from '@reachany/clipboard-content';
import {
  normalizeRichText,
  richTextFromPlainText,
  setRichTextStringParser,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';

import { createReachDeckTextExtensions } from './extensions.js';

/** 模型被要求产出的 HTML 子集里出现的标签；用于判断字符串是 HTML 还是纯文本。 */
const HTML_TAG_PATTERN =
  /<\/?(?:p|div|br|strong|b|em|i|u|s|sup|sub|span)(?:\s+[a-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?\s*>/i;

/**
 * 剪贴板预算常量。
 *
 * 数值与名称保持不变，但事实源已下沉到 `@reachany/clipboard-content`：共享包在
 * DOM/IR 阶段用同一组数值先拦一层，本包在宿主 schema 解析后再校验一层，两层必须
 * 同值，所以这里只做重导出而不再各自声明。
 */
export const REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS = CLIPBOARD_HTML_MAX_CHARACTERS;
export const REACH_DECK_CLIPBOARD_MAX_NODES = CLIPBOARD_MAX_NODES;
export const REACH_DECK_CLIPBOARD_MAX_DEPTH = CLIPBOARD_MAX_DEPTH;
export const REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS = CLIPBOARD_MAX_PARAGRAPHS;
export const REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS = CLIPBOARD_MAX_TEXT_CHARACTERS;

function parseReachDeckHtml(
  value: string,
  clipboardCssParsing = false,
  richBlocks = false,
): unknown {
  return generateJSON(value, createReachDeckTextExtensions({ clipboardCssParsing, richBlocks }));
}

/**
 * 剪贴板落点的结构能力。
 *
 * `slide`（默认）：幻灯片文本框，表格按行展平、标题降级为段落 —— 一个文本框就是一段排好版的
 * 文字，标题层级由元素 variant 决定，表格是独立元素。
 * `document`：测验题干 / 解析等文档语义字段，保留表格与标题 —— 教师从 Word 复制过来的
 * 表格和小标题属于题目内容本身，展平就是丢信息。与测验模块的取舍对齐。
 */
export type ReachDeckClipboardSurface = 'slide' | 'document';

/**
 * 共享剪贴板转换器产出的安全 HTML → 富文本 JSON。
 *
 * 只在本文件内部对共享转换结果启用受信公式解析；外部 HTML 永远走
 * `parseReachDeckHtml(value, true)`，公式标记在那条路径上仍被整体拒绝。
 * 制表符是表格展平后 cell 之间的唯一分隔符，所以按原样保留空白解析。
 */
function parseTransformedOfficeHtml(value: string, richBlocks = false): unknown {
  return generateJSON(
    value,
    createReachDeckTextExtensions({
      clipboardCssParsing: true,
      richBlocks,
      trustedFormulaMarkup: true,
    }),
    { preserveWhitespace: true },
  );
}

function assertClipboardRichTextBudget(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const rootContent = (value as { content?: unknown }).content;
  if (!Array.isArray(rootContent)) return;

  let nodeCount = 0;
  let textCharacters = 0;
  const stack: Array<{ depth: number; node: unknown }> = rootContent.map((node) => ({
    depth: 1,
    node,
  }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (typeof entry.node !== 'object' || entry.node === null) continue;
    nodeCount += 1;
    if (nodeCount > REACH_DECK_CLIPBOARD_MAX_NODES) {
      throw new Error(
        `Reach Deck clipboard rich text exceeds the ${REACH_DECK_CLIPBOARD_MAX_NODES}-node limit.`,
      );
    }
    if (entry.depth > REACH_DECK_CLIPBOARD_MAX_DEPTH) {
      throw new Error(
        `Reach Deck clipboard rich text exceeds the ${REACH_DECK_CLIPBOARD_MAX_DEPTH}-level depth limit.`,
      );
    }

    const node = entry.node as { content?: unknown; text?: unknown };
    if (typeof node.text === 'string') {
      textCharacters += node.text.length;
      if (textCharacters > REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS) {
        throw new Error(
          `Reach Deck clipboard rich text exceeds the ${REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS}-character text limit.`,
        );
      }
    }
    if (Array.isArray(node.content)) {
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        stack.push({ depth: entry.depth + 1, node: node.content[index] });
      }
    }
  }
}

function cleanClipboardTextStyleMark(mark: RichTextMark): RichTextMark | undefined {
  if (mark.type !== 'textStyle' || mark.attrs === undefined) return mark;
  const attrs = Object.fromEntries(
    Object.entries(mark.attrs).filter(
      ([, value]) => value !== null && value !== undefined && value !== '',
    ),
  );
  return Object.keys(attrs).length === 0 ? undefined : { ...mark, attrs };
}

function cleanClipboardNode(node: RichTextNode): RichTextNode {
  const { content, marks: sourceMarks, ...rest } = node;
  const marks = sourceMarks
    ?.map(cleanClipboardTextStyleMark)
    .filter((mark): mark is RichTextMark => mark !== undefined);
  return {
    ...rest,
    ...(marks === undefined || marks.length === 0 ? {} : { marks }),
    ...(content === undefined
      ? {}
      : { content: content.map((child) => cleanClipboardNode(child)) }),
  };
}

function cleanClipboardRichText(document: RichTextDocument): RichTextDocument {
  return {
    ...document,
    ...(document.content === undefined
      ? {}
      : { content: document.content.map((node) => cleanClipboardNode(node)) }),
  };
}

/**
 * System clipboard HTML -> Reach Deck rich text.
 *
 * Unlike the model boundary below, clipboard HTML is always parsed as HTML. The shared Tiptap
 * schema is the node/mark allowlist; this boundary additionally normalizes bounded CSS typography
 * and spacing, rejects oversized parsed documents, and removes empty style marks.
 *
 * Office / MathML 剪贴板先经共享转换器归一成受限安全 HTML（表格按行展平、图片只留
 * alt、公式转成 `data-latex` 标记），再用受信公式解析配置落到幻灯片 schema；内部
 * ProseMirror slice 与普通外部 HTML 由共享转换器判为 `not-applicable`，继续走原有的
 * 剪贴板 CSS 解析路径，公式标记在那里依旧不被承认。
 */
export function richTextFromClipboardHtml(
  value: string,
  surface: ReachDeckClipboardSurface = 'slide',
): RichTextDocument {
  if (value.length > REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS) {
    throw new Error(
      `Reach Deck clipboard HTML exceeds the ${REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS}-character limit.`,
    );
  }
  // 幻灯片富文本 schema 没有 table 节点，因此那条路径固定要求按行展平；
  // 文档语义字段（测验题干/解析）保留表格结构。
  const richBlocks = surface === 'document';
  const office = transformOfficeClipboardHtml(value, {
    tableMode: richBlocks ? 'preserve' : 'flatten',
  });
  const parsed =
    office.kind === 'transformed'
      ? parseTransformedOfficeHtml(office.html, richBlocks)
      : parseReachDeckHtml(value, true, richBlocks);
  assertClipboardRichTextBudget(parsed);
  return cleanClipboardRichText(normalizeRichText(parsed));
}

/** System clipboard plain text -> Reach Deck rich text with bounded paragraph expansion. */
export function richTextFromClipboardPlainText(value: string): RichTextDocument {
  if (value.length > REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS) {
    throw new Error(
      `Reach Deck clipboard plain text exceeds the ${REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS}-character limit.`,
    );
  }

  let nodeCount = 1;
  let paragraphCount = 1;
  let paragraphHasText = false;
  for (const character of value) {
    if (character === '\n') {
      paragraphCount += 1;
      nodeCount += 1;
      paragraphHasText = false;
    } else if (!paragraphHasText) {
      nodeCount += 1;
      paragraphHasText = true;
    }
  }
  if (nodeCount > REACH_DECK_CLIPBOARD_MAX_NODES) {
    throw new Error(
      `Reach Deck clipboard rich text exceeds the ${REACH_DECK_CLIPBOARD_MAX_NODES}-node limit.`,
    );
  }
  if (paragraphCount > REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS) {
    throw new Error(
      `Reach Deck clipboard plain text exceeds the ${REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS}-paragraph limit.`,
    );
  }
  return richTextFromPlainText(value);
}

/** Sanitize system clipboard HTML into the same HTML subset accepted by the editor. */
export function sanitizeReachDeckClipboardHtml(
  value: string,
  surface: ReachDeckClipboardSurface = 'slide',
): string {
  return richTextToHtml(richTextFromClipboardHtml(value, surface), surface);
}

/**
 * ProseMirror `transformPastedHTML` 的 Deck 实现。
 *
 * 这里不信任公开且可伪造的 `data-pm-slice` 标记。当前编辑器自己复制出的内容必须先
 * 通过实例级 provenance 校验才会绕过此函数；其余 HTML（含未知/篡改的内部标记、
 * Office / MathML）都由剪贴板边界清洗后交给宿主 schema 二次解析。
 */
export function transformReachDeckPastedHtml(
  value: string,
  surface: ReachDeckClipboardSurface = 'slide',
): string {
  return sanitizeReachDeckClipboardHtml(value, surface);
}

/**
 * 模型输出的受限 HTML → 富文本文档。
 *
 * 用 tiptap 原生解析（`generateJSON` + 与编辑器同一套扩展），不手写转换器：
 * 手写的话服务端与编辑器对同一段 HTML 会解析出不同结果。schema 即白名单，
 * 未声明的标签 / 属性（`<script>`、`onerror=` 等）在解析时被丢弃。
 *
 * 传入的字符串不含 HTML 标签时按纯文本处理 —— 模型偶尔会直接给纯文本，
 * 这时按 HTML 解析会把 `<` `&` 之类的字符错误处理。
 */
export function richTextFromModelHtml(value: string): RichTextDocument {
  if (!HTML_TAG_PATTERN.test(value)) return richTextFromPlainText(value);
  return normalizeRichText(parseReachDeckHtml(value));
}

/** 富文本文档 → HTML。用于把已有课件回填进 prompt 作为上下文。 */
export function richTextToHtml(
  document: RichTextDocument,
  surface: ReachDeckClipboardSurface = 'slide',
): string {
  return generateHTML(
    document,
    createReachDeckTextExtensions({ richBlocks: surface === 'document' }),
  );
}

/**
 * 让 dsl 的 `normalizeRichText` 用 tiptap 原生解析处理字符串。
 *
 * 服务端与编辑器进程都应在启动时调用一次：模型按 JSON Schema 产出的 `text` 是
 * 受限 HTML 字符串，注册后它会被解析成带 mark 的富文本，而不是被当作字面文本。
 * 幂等，可重复调用。
 */
export function installReachDeckRichTextParser(): void {
  setRichTextStringParser(richTextFromModelHtml);
}
