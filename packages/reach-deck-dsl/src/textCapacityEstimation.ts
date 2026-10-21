/**
 * 文本容量表的查表 / 折算工具函数。
 *
 * 与 `textCapacityTable.ts`（标定数据，脚本生成，勿手改）配套使用，是 prompt 侧内容
 * 长度预算与 judge 侧 `TEXT_CAPACITY` 检查共同的查表入口——同一份数据、同一套折算
 * 规则，避免两处估算公式各写一套导致互相打架。
 */

import {
  TYPOGRAPHY_TOKENS,
  typographyTokensForProfile,
  type DeckTypographyProfile,
} from './layoutContract.js';
import type { SlideLayoutPlan } from './layoutPlan.js';
import { richTextMaximumFontSize, type RichTextDocument, type RichTextNode } from './richText.js';
import {
  CALIBRATED_WIDTHS_PX,
  TEXT_CAPACITY_WIDTHS_PX,
  TEXT_CAPACITY_TABLE,
  TEXT_SAFE_LINE_BOX_HEIGHT_PX,
  V16_TEXT_CAPACITY_TABLE,
  type TextCapacityWidthPx,
} from './textCapacityTable.js';

export type TypographyTokenName = keyof typeof TYPOGRAPHY_TOKENS;

/**
 * The browser calibration table already reserves one full character per line. New model-authored
 * slides keep a further 8% reserve for punctuation rules, mixed scripts, and font-metric drift.
 */
export const TEXT_CAPACITY_ADDITIONAL_HEADROOM_RATIO = 0.92;

/** 除 title 外的正文类档位，用于逐槽枚举预算时的固定顺序（与展示可读性相关，非数据本身）。 */
const CONTENT_TOKEN_ORDER: TypographyTokenName[] = ['body', 'caption'];

/**
 * 按槽宽估算某排版档位单行能容纳的"等效中文字"数（不含 maxLines 换算）。
 *
 * "等效中文字"是 `countEffectiveChars` 的计量单位（CJK=1、Latin=约 0.44，数据派生
 * 值，见 `LATIN_TO_CJK_WIDTH_RATIO` 注释），
 * 这里直接取标定表里的 `cjkCharsPerLine`（本身就是这一单位下的每行字数），两个函数由
 * 此共享同一把尺子，可以直接比大小。
 *
 * 非表内槽宽用相邻两档线性插值；160/192/240/280px 是从稳定宽档保守推导的窄框
 * 断点，因此小于 320px 不再向上夹成 320px 容量。超出完整表范围才 clamp 到边界档。
 *
 * 不取整（保留小数）：调用方常常还要乘以行数或缩放系数，提前取整会放大累积误差；
 * 真正对外的容量数字由 `estimateTextCapacity` 取整。
 */
export function estimateCharsPerLine(
  tokenName: TypographyTokenName,
  widthPx: number,
  profile: DeckTypographyProfile = 'legacy',
): number {
  const row = (profile === 'v16' ? V16_TEXT_CAPACITY_TABLE : TEXT_CAPACITY_TABLE)[tokenName];
  const widths = TEXT_CAPACITY_WIDTHS_PX;

  const clampedWidth = Math.min(Math.max(widthPx, widths[0]), widths[widths.length - 1]);

  let lowerWidth: TextCapacityWidthPx = widths[0];
  let upperWidth: TextCapacityWidthPx = widths[widths.length - 1];
  for (let i = 0; i < widths.length - 1; i += 1) {
    if (clampedWidth >= widths[i] && clampedWidth <= widths[i + 1]) {
      lowerWidth = widths[i];
      upperWidth = widths[i + 1];
      break;
    }
  }

  const lowerCharsPerLine = row[lowerWidth].cjkCharsPerLine;
  const upperCharsPerLine = row[upperWidth].cjkCharsPerLine;
  const ratio =
    upperWidth === lowerWidth ? 0 : (clampedWidth - lowerWidth) / (upperWidth - lowerWidth);
  return (
    (lowerCharsPerLine + (upperCharsPerLine - lowerCharsPerLine) * ratio) *
    TEXT_CAPACITY_ADDITIONAL_HEADROOM_RATIO
  );
}

/**
 * 按槽宽估算某排版档位能容纳的"等效中文字"上限（= 单行容量 × maxLines）。
 */
export function estimateTextCapacity(
  tokenName: TypographyTokenName,
  widthPx: number,
  profile: DeckTypographyProfile = 'legacy',
): number {
  const token = typographyTokensForProfile(profile)[tokenName];
  return Math.floor(estimateCharsPerLine(tokenName, widthPx, profile) * token.maxLines);
}

/** 无 layoutPlan 槽位时的通用预算表：按 token 取满宽（1440px）档。 */
export function genericCapacityByToken(
  profile: DeckTypographyProfile = 'legacy',
): Record<TypographyTokenName, number> {
  const result = {} as Record<TypographyTokenName, number>;
  for (const tokenName of Object.keys(TYPOGRAPHY_TOKENS) as TypographyTokenName[]) {
    result[tokenName] = estimateTextCapacity(tokenName, 1440, profile);
  }
  return result;
}

/**
 * 生成 prompt 侧注入用的内容长度预算说明段（英文正文，供 AI Runtime Reach Deck 的
 * slide 生成阶段拼进用户可见的模型提示词）。
 *
 * 有 `layoutPlan` 时：按 `compileSlideLayoutPlan` 给出的参考槽宽，为 titleFrame 与每个
 * 内容槽分别查表——槽本身不带 token/variant（模型独立决定每个内容单元用哪个档位），
 * 所以每个槽枚举 `CONTENT_TOKEN_ORDER` 里的常用正文类档位，而不是猜一个档位。
 *
 * 无 `layoutPlan`（或该计划没有槽位）时：退化为 `genericCapacityByToken()` 的满宽
 * （1440px）通用预算表，按 token 逐档给一个数。
 *
 * 数值单位与 `countEffectiveChars` 一致（"等效中文字"），说明段里换算成更易懂的
 * "characters"措辞，避免要求模型理解内部计量单位。
 */
export function describeContentLengthBudget(
  layoutPlan?: SlideLayoutPlan,
  profile: DeckTypographyProfile = 'legacy',
): string {
  const header = 'CONTENT LENGTH BUDGET';
  const intro =
    'Suggested maximum content length per zone at its planned width, in effective Chinese characters (a Latin letter or digit counts as roughly half a character). Treat it as a soft ceiling for legibility, not a hard limit — trimming toward it usually improves the page. Formulas occupy visual boxes based on rendered width and height; never budget them by raw LaTeX source length.';

  if (layoutPlan === undefined || layoutPlan.slots.length === 0) {
    const generic = genericCapacityByToken(profile);
    const lines = (Object.keys(generic) as TypographyTokenName[]).map(
      (tokenName) =>
        `- ${tokenName}: up to ${generic[tokenName]} characters at full width (1440px).`,
    );
    return [header, intro, ...lines].join('\n');
  }

  const titleCapacity = estimateTextCapacity('title', layoutPlan.titleFrame.width, profile);
  const lines = [
    `- Title zone (width ${Math.round(layoutPlan.titleFrame.width)}px): up to ${titleCapacity} characters.`,
  ];
  for (const slot of layoutPlan.slots) {
    const perToken = CONTENT_TOKEN_ORDER.map(
      (tokenName) =>
        `${tokenName} up to ${estimateTextCapacity(tokenName, slot.frame.width, profile)}`,
    ).join(', ');
    lines.push(
      `- Slot ${slot.id} (${slot.role}, width ${Math.round(slot.frame.width)}px): ${perToken} characters.`,
    );
  }
  return [header, intro, ...lines].join('\n');
}

/** 行内公式按可见数学原子估算宽度；控制词拼写与排版括号不按源码字符数占位。 */
function inlineFormulaVisualUnits(latex: string): number {
  const structures = latex.match(/\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|lim)\b/g)?.length ?? 0;
  const commands = latex.match(/\\[A-Za-z]+/g)?.length ?? 0;
  const visible = latex
    .replace(/\\[A-Za-z]+/g, 'M')
    .replace(/\\./g, 'M')
    .replace(/[{}_^\s]/g, '');
  return Math.max(2, weightedPlainTextLength(visible) * 0.72 + commands * 0.28 + structures * 1.2);
}

/**
 * 块级公式（`$$...$$`）固定按"一整行"折算——公式无论长短都独占一行的视觉空间，用
 * 长度折算反而失真。这里取 body 档在满宽（1440px）下的 `cjkCharsPerLine`（标定表的
 * 实测值）作为"一整行"的默认量化基准：它是本仓最常见的正文行密度，比拍一个脱离实测的
 * 常数更有依据。仅作 `countEffectiveChars` 未传入 `blockFormulaLineChars` 时的默认值
 * （prompt 侧枚举通用预算时用这个满宽默认档）；judge 侧按元素实际槽宽查表后传入真实
 * 每行字数，避免窄槽把"一整行"算成满宽的行长度而系统性过计（见该处调用）。
 */
const BLOCK_FORMULA_LINE_CHARS = estimateCharsPerLine('body', 1440);

/**
 * Latin/CJK 平均字宽折算比：从标定表数据反推，而非拍一个 0.5 的经验值。
 *
 * 取 body 档非最小槽宽（不含 320px，字符数太少易受取整噪声影响）的
 * `cjkCharsPerLine / latinCharsPerLine` 比值均值。之所以选 body 档：它是最常见的
 * 正文字号，标定样本字符数最多、噪声最小；其余档位的比值在标定环境下与之接近
 * （详见 task-7-report.md 的四项对账），用 body 档代表全体是合理简化。
 *
 * 实测比值约 0.44（如 body/1440：48 / 109 ≈ 0.44），而非此前假设的 0.5——同样的
 * 等效中文字预算下，Latin 字符的真实宽度占比更低，用 0.5 会低估折算长度、进而
 * 低估真实占用空间。
 */
export const LATIN_TO_CJK_WIDTH_RATIO = (() => {
  const body = TEXT_CAPACITY_TABLE.body;
  const widths = CALIBRATED_WIDTHS_PX.filter((width) => width !== 320);
  const ratios = widths.map((width) => body[width].cjkCharsPerLine / body[width].latinCharsPerLine);
  return ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
})();

/** CJK 字符判定：覆盖中日韩统一表意文字、日文假名、韩文谥文、全角标点等常见区段。 */
const CJK_CHAR_PATTERN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/u;

/**
 * 混排折算：CJK 记 1 个"等效中文字"，其余（Latin 字母/数字/空白/半角标点）记
 * `LATIN_TO_CJK_WIDTH_RATIO`（数据派生值，约 0.44）个——折算比来自标定表实测数据，
 * 不是拍脑袋常数，见该常量注释。
 */
function weightedPlainTextLength(text: string): number {
  let total = 0;
  for (const character of text) {
    total += CJK_CHAR_PATTERN.test(character) ? 1 : LATIN_TO_CJK_WIDTH_RATIO;
  }
  return total;
}

const BLOCK_FORMULA_PATTERN = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g;
const INLINE_FORMULA_PATTERN = /\$([^$\n]+?)\$|\\\(([^\n]+?)\\\)/g;
const BOLD_PATTERN = /\*\*([^*]+?)\*\*/g;
const ITALIC_PATTERN = /\*([^*]+?)\*/g;
const LIST_MARKER_PATTERN = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm;

/**
 * 统计一段文本的"等效中文字"数——prompt 侧内容长度预算与 judge 侧 `TEXT_CAPACITY`
 * 检查共用的计数口径。
 *
 * 输入既可以是模型直出的受限 markdown 原始字符串（`$…$`/`$$…$$`/`**`/`*`/列表符号，
 * 生成阶段的天然形态），也可以是 `richTextToPlainText` 对已解析富文本的展开结果
 * （公式已转成 `\(…\)`/`\[…\]` 转义形式，粗体/斜体已降级为 mark、不再带 `**`/`*`
 * 字面符号）——judge 侧用后一种输入直接复用同一套计数逻辑，两侧不必各写一套。
 *
 * `blockFormulaLineChars`：块级公式按"一整行"折算时使用的每行字数，默认取满宽
 * （1440px）body 档的实测值——prompt 侧枚举通用预算时槽宽未知，用这个默认档合理。
 * judge 侧按元素实际槽宽调用 `estimateCharsPerLine` 后传入真实值，避免窄槽（如
 * 480px）把块公式算成满宽整行的字数而系统性过计容量占用。
 *
 * 处理顺序（顺序影响结果，需固定）：
 * 1. 先摘出块级公式（`$$…$$` 或 `\[…\]`），每个按 `blockFormulaLineChars` 计一次，
 *    摘除后不再参与后续折算，避免其内部的 `*`、数字等被当成普通文字或行内公式重复计数。
 * 2. 再摘出行内公式（`$…$` 或 `\(…\)`），按其 LaTeX 明文长度乘
 *    `INLINE_FORMULA_FOLD_RATIO` 折算，同样摘除、不重复计数。
 * 3. 剥离列表行首标记（`-`/`*`/`+`/`1.`/`1)`），标记本身不计入字数。
 * 4. 剥离粗体 `**...**`、斜体 `*...*` 标记，保留内部文字（标记符号本身不计入字数）。
 * 5. 对剩余纯文本按 CJK=1 / 其余=`LATIN_TO_CJK_WIDTH_RATIO` 加权求和。
 * 6. 汇总 1/2/5 三部分之和。
 */
export function countEffectiveChars(
  markdown: string,
  blockFormulaLineChars: number = BLOCK_FORMULA_LINE_CHARS,
): number {
  let total = 0;
  let remaining = markdown;

  remaining = remaining.replace(BLOCK_FORMULA_PATTERN, () => {
    total += blockFormulaLineChars;
    return '';
  });

  remaining = remaining.replace(
    INLINE_FORMULA_PATTERN,
    (_match, dollarLatex: string | undefined, escapedLatex: string | undefined) => {
      const latex = dollarLatex ?? escapedLatex ?? '';
      total += inlineFormulaVisualUnits(latex);
      return '';
    },
  );

  remaining = remaining
    .replace(LIST_MARKER_PATTERN, '')
    .replace(BOLD_PATTERN, '$1')
    .replace(ITALIC_PATTERN, '$1');

  total += weightedPlainTextLength(remaining);

  return total;
}

const INLINE_MATH_NODE_TYPES = new Set(['inlineMath', 'mathInline']);
const BLOCK_MATH_NODE_TYPES = new Set(['blockMath', 'mathBlock']);
const LIST_NODE_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

interface ForcedVisualRow {
  text: string;
  listItem: boolean;
}

const latexOf = (node: RichTextNode): string =>
  typeof node.attrs?.latex === 'string' ? node.attrs.latex.trim() : '';

const inlineTextOf = (node: RichTextNode): string => {
  if (node.type === 'hardBreak') return '\n';
  if (typeof node.text === 'string') return node.text;
  const latex = latexOf(node);
  if (INLINE_MATH_NODE_TYPES.has(node.type) && latex) return `\\(${latex}\\)`;
  if (BLOCK_MATH_NODE_TYPES.has(node.type) && latex) return `\\[${latex}\\]`;
  return (node.content ?? []).map(inlineTextOf).join('');
};

/**
 * Preserve author-forced starts instead of flattening a rich-text document into one character sum.
 * Paragraphs, hard breaks and list items each begin a new visual row. Wrapping inside each row is
 * still calculated from the shared calibrated width table.
 */
const forcedVisualRows = (document: RichTextDocument): ForcedVisualRow[] => {
  const rowsForNode = (node: RichTextNode, listItem = false): ForcedVisualRow[] => {
    const latex = latexOf(node);
    if (BLOCK_MATH_NODE_TYPES.has(node.type) && latex) {
      return [{ text: `\\[${latex}\\]`, listItem }];
    }
    if (LIST_NODE_TYPES.has(node.type)) {
      return (node.content ?? []).flatMap((child) => rowsForNode(child, child.type === 'listItem'));
    }
    if (node.type === 'listItem') {
      const rows = (node.content ?? []).flatMap((child) => rowsForNode(child, true));
      return rows.length > 0 ? rows : [{ text: '', listItem: true }];
    }
    if (
      node.type === 'paragraph' ||
      node.type === 'heading' ||
      node.type === 'blockquote' ||
      node.type === 'codeBlock'
    ) {
      return inlineTextOf(node)
        .split('\n')
        .map((text) => ({ text, listItem }));
    }
    if ((node.content?.length ?? 0) > 0) {
      return node.content!.flatMap((child) => rowsForNode(child, listItem));
    }
    const text = inlineTextOf(node);
    return text.length > 0 ? [{ text, listItem }] : [];
  };

  return (document.content ?? []).flatMap((node) => rowsForNode(node));
};

export interface RichTextFrameFitOptions {
  widthPx: number;
  heightPx: number;
  paddingX?: number;
  paddingY?: number;
  profile?: DeckTypographyProfile;
}

export interface RichTextFrameFit {
  effectiveWidth: number;
  effectiveHeight: number;
  charsPerLine: number;
  effectiveLength: number;
  requiredLines: number;
  availableLines: number;
  visualRowCount: number;
  requiredHeight: number;
  safeLineBoxHeight: number;
  fontScale: number;
  capacity: number;
  lineQualityIssues: TextLineQualityIssue[];
}

export type TextLineQualityIssueKind =
  | 'single-cjk-orphan'
  | 'forbidden-punctuation-break'
  | 'latin-whole-word-wrap';

export interface TextLineQualityIssue {
  kind: TextLineQualityIssueKind;
  row: number;
}

const HAN_CHARACTER_PATTERN = /[\u3400-\u9fff]/u;
const CLOSING_PUNCTUATION_PATTERN = /[，。！？；：、）》】〕］｝…]/u;
const OPENING_PUNCTUATION_PATTERN = /[（《【〔［｛]/u;
const LATIN_WORD_PATTERN = /[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/gu;

function lineQualityIssuesForRow(
  text: string,
  charsPerLine: number,
  row: number,
): TextLineQualityIssue[] {
  const issues: TextLineQualityIssue[] = [];
  const characters = [...text];
  const total = weightedPlainTextLength(text);
  if (total > charsPerLine) {
    const completedLines = Math.floor(total / charsPerLine);
    const tail = total - completedLines * charsPerLine;
    const last = characters.at(-1) ?? '';
    if (tail > 0 && tail <= 1 && HAN_CHARACTER_PATTERN.test(last)) {
      issues.push({ kind: 'single-cjk-orphan', row });
    }
  }

  let lineUsed = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const units = weightedPlainTextLength(character);
    if (lineUsed > 0 && lineUsed + units > charsPerLine) {
      const previous = characters[index - 1] ?? '';
      if (
        CLOSING_PUNCTUATION_PATTERN.test(character) ||
        OPENING_PUNCTUATION_PATTERN.test(previous)
      ) {
        issues.push({ kind: 'forbidden-punctuation-break', row });
      }
      lineUsed = 0;
    }
    lineUsed += units;
  }

  for (const word of text.matchAll(LATIN_WORD_PATTERN)) {
    if (weightedPlainTextLength(word[0]) > charsPerLine) {
      issues.push({ kind: 'latin-whole-word-wrap', row });
      break;
    }
  }
  return issues;
}

/**
 * Shared rich-text occupancy arithmetic for generation guidance, catalog guards and static judge.
 * Padding is removed before width/height arithmetic; callers whose text frame is already inset pass
 * zero padding. A local font-size mark conservatively scales the whole frame by the largest run so
 * enlarged text cannot be hidden by surrounding smaller copy.
 */
export function estimateRichTextFrameFit(
  document: RichTextDocument,
  tokenName: TypographyTokenName,
  options: RichTextFrameFitOptions,
): RichTextFrameFit {
  const profile = options.profile ?? 'legacy';
  const token = typographyTokensForProfile(profile)[tokenName];
  const paddingX = Math.max(0, options.paddingX ?? 0);
  const paddingY = Math.max(0, options.paddingY ?? 0);
  const innerWidth = Math.max(0, options.widthPx - paddingX * 2);
  const innerHeight = Math.max(0, options.heightPx - paddingY * 2);
  const maximumFontSize = richTextMaximumFontSize(document, token.fontSize);
  const fontScale = Math.max(1, maximumFontSize / token.fontSize);
  const effectiveWidth = innerWidth / fontScale;
  const effectiveHeight = innerHeight / fontScale;
  const charsPerLine = Math.max(1, estimateCharsPerLine(tokenName, effectiveWidth, profile));
  const rows = forcedVisualRows(document);
  let effectiveLength = 0;
  let requiredLines = 0;
  const lineQualityIssues: TextLineQualityIssue[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const rowText = row.listItem ? `• ${row.text}` : row.text;
    const length = countEffectiveChars(rowText, charsPerLine);
    effectiveLength += length;
    requiredLines += Math.max(1, Math.ceil(length / charsPerLine));
    lineQualityIssues.push(...lineQualityIssuesForRow(rowText, charsPerLine, rowIndex));
  }
  const safeLineBoxHeight = TEXT_SAFE_LINE_BOX_HEIGHT_PX[tokenName] * fontScale;
  const availableLines = Math.min(
    token.maxLines,
    Math.floor(innerHeight / Math.max(1, safeLineBoxHeight)),
  );
  return {
    effectiveWidth,
    effectiveHeight,
    charsPerLine,
    effectiveLength,
    requiredLines,
    availableLines,
    visualRowCount: rows.length,
    requiredHeight: requiredLines * safeLineBoxHeight,
    safeLineBoxHeight,
    fontScale,
    capacity: Math.floor(charsPerLine * availableLines),
    lineQualityIssues,
  };
}

/** Mandatory model-facing arithmetic generated from the same table consumed by the judge. */
export function describeTextFrameFitContract(profile: DeckTypographyProfile = 'legacy'): string {
  const widths = TEXT_CAPACITY_WIDTHS_PX;
  const tokens = typographyTokensForProfile(profile);
  const tokenLines = (Object.keys(tokens) as TypographyTokenName[]).map((tokenName) => {
    const token = tokens[tokenName];
    const breakpoints = widths
      .map((width) => `${width}:${estimateCharsPerLine(tokenName, width, profile).toFixed(2)}`)
      .join(', ');
    return `- ${tokenName}: font ${token.fontSize}px; safe line box ${TEXT_SAFE_LINE_BOX_HEIGHT_PX[tokenName]}px; maximum ${token.maxLines} lines; effective-CJK chars/line by width { ${breakpoints} }.`;
  });
  return [
    'TEXT FRAME FIT CONTRACT (MANDATORY)',
    'Before returning the one slide output, apply this arithmetic to every text frame. This is a hard generation requirement, not advisory composition guidance.',
    "- The values below add 8% headroom on top of the calibration table's existing one-character-per-line reserve.",
    ...tokenLines,
    `- Latin letters, digits, spaces, and half-width punctuation count as ${LATIN_TO_CJK_WIDTH_RATIO.toFixed(2)} effective CJK characters each. Interpolate only between listed widths; below ${widths[0]}px use the ${widths[0]}px capacity and never round a narrow frame up to 320px.`,
    '- requiredLines is the sum of each paragraph, hard-break row, and list-item row after wrapping that row at the applicable chars/line. Every display formula reserves at least one complete visual line; inline formulas consume their rendered visual-box width, never their raw LaTeX source length. Local font-size marks scale both width demand and safe line-box height.',
    '- availableLines = min(tier maximum lines, floor(text frame height / safe line-box height)). The required containment is requiredLines <= availableLines.',
    '- When text is inside a color block, first reserve 32-48px padding on every side: text.x >= block.x + padding, text.y >= block.y + padding, text.right <= block.right - padding, and text.bottom <= block.bottom - padding. Apply text-fit arithmetic to the remaining text frame, not the outer block.',
    '- If any budget or containment fails, remove optional detail, enlarge the text frame and its containing block, reduce parallel items, or change the composition before returning. Never shrink typography, clip text, add in-slide scrolling, or rely on a later correction.',
  ].join('\n');
}
