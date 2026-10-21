/**
 * 受限 markdown 子集 → 共享富文本文档（tiptap JSON）。
 *
 * 生成侧只允许模型写这几种标记：`**粗体**`、`*斜体*`、`-` 无序列表、`1.` 有序
 * 列表（最多一层嵌套）、`$…$` / `\(…\)` 行内公式、`$$…$$` 独立公式、段落与换行。子集之外
 * 的语法（标题、链接、图片、表格、代码块、引用、HTML、更深的嵌套列表）**不报错**：
 * 剥掉标记符号、保留可见文字，并追加一条中文 diagnostic 说明忽略了什么。
 *
 * 手写解析器，不引入 remark / markdown-it 之类的大依赖 —— 这个包同时被服务端
 * worker 与浏览器加载，且产物要能被 sha256 成稳定的 revision token。
 */

import {
  plainTextFromMarkup,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from './richText.js';

export interface RestrictedMarkdownResult {
  doc: RichTextDocument;
  /** 中文诊断，按首次出现顺序去重。 */
  diagnostics: string[];
}

const DIAGNOSTIC_HEADING = '已忽略 markdown 标题标记（#），标题文字按普通段落保留。';
const DIAGNOSTIC_LINK = '已忽略 markdown 链接，仅保留链接文字。';
const DIAGNOSTIC_IMAGE = '已忽略 markdown 图片，仅保留替代文字。';
const DIAGNOSTIC_INLINE_CODE = '已忽略行内代码标记（`），仅保留代码文字。';
const DIAGNOSTIC_CODE_BLOCK = '已忽略代码块围栏（```），代码按普通段落保留。';
const DIAGNOSTIC_TABLE = '已忽略 markdown 表格结构，单元格文字按普通段落保留。';
const DIAGNOSTIC_QUOTE = '已忽略引用标记（>），引用文字按普通段落保留。';
const DIAGNOSTIC_RULE = '已忽略分割线。';
const DIAGNOSTIC_HTML = '已忽略内联 HTML 标签，仅保留可见文字。';
const DIAGNOSTIC_DEEP_LIST = '列表嵌套超过一层，更深的层级已降级为第二层。';
const DIAGNOSTIC_INLINE_BLOCK_MATH = '独立公式（$$…$$）出现在行内，已按行内公式处理。';

type ListKind = 'bullet' | 'number';

interface PendingListItem {
  /** 行首缩进宽度（原始值）；层级在收尾时按缩进排名统一换算。 */
  indent: number;
  kind: ListKind;
  text: string;
}

const HEADING_PATTERN = /^ {0,3}#{1,6}\s+(.*)$/;
const RULE_PATTERN = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_PATTERN = /^ {0,3}>\s?(.*)$/;
const FENCE_PATTERN = /^\s*(?:`{3,}|~{3,})/;
const BULLET_PATTERN = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_PATTERN = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_ROW_PATTERN = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER_PATTERN = /^\s*\|[\s:|-]*\|\s*$/;

/** 制表符按 4 空格折算，避免同一份内容因缩进字符不同解析出不同层级。 */
const indentWidth = (indent: string): number =>
  [...indent].reduce((total, character) => total + (character === '\t' ? 4 : 1), 0);

export function parseRestrictedMarkdown(markdown: string): RestrictedMarkdownResult {
  const diagnostics: string[] = [];
  const note = (message: string): void => {
    if (!diagnostics.includes(message)) diagnostics.push(message);
  };

  const content: RichTextNode[] = [];
  let paragraphLines: string[] = [];
  let listItems: PendingListItem[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    const lines = paragraphLines;
    paragraphLines = [];
    const inline: RichTextNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) inline.push({ type: 'hardBreak' });
      inline.push(...parseInlineText(line, note));
    });
    content.push({ type: 'paragraph', ...(inline.length > 0 ? { content: inline } : {}) });
  };

  const flushList = (): void => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    content.push(...buildLists(items, note));
  };

  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (FENCE_PATTERN.test(line)) {
      flushAll();
      note(DIAGNOSTIC_CODE_BLOCK);
      // 围栏内的内容不做行内解析：代码里的 * 和 $ 不是标记。
      for (index += 1; index < lines.length && !FENCE_PATTERN.test(lines[index]!); index += 1) {
        const code = lines[index]!;
        content.push({
          type: 'paragraph',
          ...(code.length > 0 ? { content: [{ type: 'text', text: code }] } : {}),
        });
      }
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    if (line.trimStart().startsWith('$$')) {
      flushAll();
      const consumed = consumeBlockMath(lines, index);
      if (consumed !== undefined) {
        if (consumed.latex.length > 0) {
          content.push({ type: 'blockMath', attrs: { latex: consumed.latex } });
        }
        index = consumed.nextIndex;
        continue;
      }
      // 没有闭合的 $$：当普通文字处理，不吞掉内容。
    }

    if (RULE_PATTERN.test(line)) {
      flushAll();
      note(DIAGNOSTIC_RULE);
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading !== null) {
      flushAll();
      note(DIAGNOSTIC_HEADING);
      paragraphLines.push(heading[1]!);
      flushParagraph();
      continue;
    }

    const quote = QUOTE_PATTERN.exec(line);
    if (quote !== null) {
      flushList();
      note(DIAGNOSTIC_QUOTE);
      paragraphLines.push(quote[1]!);
      continue;
    }

    if (TABLE_ROW_PATTERN.test(line)) {
      flushAll();
      note(DIAGNOSTIC_TABLE);
      if (TABLE_DIVIDER_PATTERN.test(line)) continue;
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
      // 每一行表格自成一段，避免整张表被压成一个没有分隔的长段落。
      if (cells.length > 0) {
        paragraphLines.push(cells.join(' '));
        flushParagraph();
      }
      continue;
    }

    const bullet = BULLET_PATTERN.exec(line);
    const ordered = bullet === null ? ORDERED_PATTERN.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      flushParagraph();
      const match = (bullet ?? ordered)!;
      listItems.push({
        indent: indentWidth(match[1]!),
        kind: bullet !== null ? 'bullet' : 'number',
        text: match[2]!,
      });
      continue;
    }

    flushList();
    paragraphLines.push(line.trim());
  }
  flushAll();

  return { doc: { type: 'doc', ...(content.length > 0 ? { content } : {}) }, diagnostics };
}

/** 读取以 `$$` 开头的独立公式块，支持单行 `$$x$$` 与多行两种写法。 */
function consumeBlockMath(
  lines: readonly string[],
  startIndex: number,
): { latex: string; nextIndex: number } | undefined {
  const first = lines[startIndex]!.trim();
  const inlineClose = first.length > 4 && first.endsWith('$$');
  if (inlineClose) return { latex: first.slice(2, -2).trim(), nextIndex: startIndex };

  const collected: string[] = [first.slice(2)];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const closeAt = line.indexOf('$$');
    if (closeAt < 0) {
      collected.push(line);
      continue;
    }
    collected.push(line.slice(0, closeAt));
    return { latex: collected.join('\n').trim(), nextIndex: index };
  }
  return undefined;
}

/**
 * 把连续的列表项装配成（最多两层的）bulletList / orderedList。
 *
 * 层级不按缩进的绝对宽度判断，而是对本段列表里出现过的缩进宽度**排名**：这样
 * 2 空格缩进和 4 空格缩进都能被识别成同一层嵌套。排名 ≥2 的层级统一降级到第二
 * 层并记一条 diagnostic。
 */
function buildLists(
  items: readonly PendingListItem[],
  note: (message: string) => void,
): RichTextNode[] {
  const indents = [...new Set(items.map((item) => item.indent))].sort(
    (left, right) => left - right,
  );
  const result: RichTextNode[] = [];
  let root: { node: RichTextNode; kind: ListKind } | undefined;
  let nested: { node: RichTextNode; kind: ListKind } | undefined;

  const listNode = (kind: ListKind): RichTextNode => ({
    type: kind === 'bullet' ? 'bulletList' : 'orderedList',
    content: [],
  });

  for (const item of items) {
    const rank = indents.indexOf(item.indent);
    if (rank > 1) note(DIAGNOSTIC_DEEP_LIST);
    const level = Math.min(rank, 1);
    const paragraph: RichTextNode = {
      type: 'paragraph',
      content: parseInlineText(item.text, note),
    };
    const listItem: RichTextNode = { type: 'listItem', content: [paragraph] };

    if (level === 0 || root === undefined) {
      if (root === undefined || root.kind !== item.kind) {
        root = { node: listNode(item.kind), kind: item.kind };
        nested = undefined;
        result.push(root.node);
      } else if (level === 0) {
        nested = undefined;
      }
      root.node.content!.push(listItem);
      continue;
    }

    const parentItems = root.node.content!;
    const parent = parentItems[parentItems.length - 1];
    if (parent === undefined) {
      root.node.content!.push(listItem);
      continue;
    }
    if (nested === undefined || nested.kind !== item.kind) {
      nested = { node: listNode(item.kind), kind: item.kind };
      parent.content = [...(parent.content ?? []), nested.node];
    }
    nested.node.content!.push(listItem);
  }

  return result;
}

/** 单行文字 → 行内节点：先剥掉子集之外的行内标记，再切分公式 / 粗体 / 斜体。 */
function parseInlineText(raw: string, note: (message: string) => void): RichTextNode[] {
  let text = raw;
  const plainText = plainTextFromMarkup(text);
  if (plainText !== text) {
    note(DIAGNOSTIC_HTML);
    text = plainText;
  }
  if (/!\[[^\]]*\]\([^)]*\)/.test(text)) {
    note(DIAGNOSTIC_IMAGE);
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  }
  if (/\[[^\]]*\]\([^)]*\)/.test(text)) {
    note(DIAGNOSTIC_LINK);
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  }
  if (/`[^`]*`/.test(text)) {
    note(DIAGNOSTIC_INLINE_CODE);
    text = text.replace(/`([^`]*)`/g, '$1');
  }
  return tokenizeInline(text, [], note);
}

function withMark(marks: readonly RichTextMark[], type: string): RichTextMark[] {
  return marks.some((mark) => mark.type === type) ? [...marks] : [...marks, { type }];
}

/**
 * 行内切分器：从左到右扫描，遇到 `\(…\)` / `$$` / `$` / `**` / `*` 就切一刀。
 * 没有配对闭合符的分隔符按普通字面量处理，永远不抛错。
 */
function tokenizeInline(
  text: string,
  marks: readonly RichTextMark[],
  note: (message: string) => void,
): RichTextNode[] {
  const nodes: RichTextNode[] = [];
  let buffer = '';
  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    nodes.push({ type: 'text', text: buffer, ...(marks.length > 0 ? { marks: [...marks] } : {}) });
    buffer = '';
  };

  let index = 0;
  while (index < text.length) {
    if (text.startsWith('\\(', index)) {
      const close = text.indexOf('\\)', index + 2);
      const latex = close < 0 ? '' : text.slice(index + 2, close).trim();
      if (latex.length > 0) {
        flushBuffer();
        nodes.push({ type: 'inlineMath', attrs: { latex } });
        index = close + 2;
        continue;
      }
    } else if (text.startsWith('$$', index)) {
      const close = text.indexOf('$$', index + 2);
      const latex = close < 0 ? '' : text.slice(index + 2, close).trim();
      if (latex.length > 0) {
        flushBuffer();
        note(DIAGNOSTIC_INLINE_BLOCK_MATH);
        nodes.push({ type: 'inlineMath', attrs: { latex } });
        index = close + 2;
        continue;
      }
    } else if (text[index] === '$') {
      const close = text.indexOf('$', index + 1);
      const latex = close < 0 ? '' : text.slice(index + 1, close).trim();
      if (latex.length > 0) {
        flushBuffer();
        nodes.push({ type: 'inlineMath', attrs: { latex } });
        index = close + 1;
        continue;
      }
    } else if (text.startsWith('**', index)) {
      const close = text.indexOf('**', index + 2);
      const inner = close < 0 ? '' : text.slice(index + 2, close);
      if (inner.length > 0) {
        flushBuffer();
        nodes.push(...tokenizeInline(inner, withMark(marks, 'bold'), note));
        index = close + 2;
        continue;
      }
    } else if (text[index] === '*') {
      const close = text.indexOf('*', index + 1);
      const inner = close < 0 ? '' : text.slice(index + 1, close);
      if (inner.length > 0) {
        flushBuffer();
        nodes.push(...tokenizeInline(inner, withMark(marks, 'italic'), note));
        index = close + 1;
        continue;
      }
    }
    buffer += text[index];
    index += 1;
  }
  flushBuffer();
  return nodes;
}
