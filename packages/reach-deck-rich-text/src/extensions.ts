import TextAlign from '@tiptap/extension-text-align';
import { Extension, Mark, mergeAttributes, type NodeViewRenderer } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import { TableKit } from '@tiptap/extension-table';
import {
  BackgroundColor,
  Color,
  FontFamily,
  FontSize,
  TextStyle,
} from '@tiptap/extension-text-style';
import StarterKit from '@tiptap/starter-kit';
import { parseRichTextGradient, richTextGradientCss } from '@reachany/reach-deck-dsl';

const TextGradient = Extension.create({
  name: 'textGradient',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          textGradient: {
            default: null,
            parseHTML: (element) => {
              try {
                return (
                  parseRichTextGradient(
                    JSON.parse(element.getAttribute('data-text-gradient') ?? 'null'),
                  ) ?? null
                );
              } catch {
                return null;
              }
            },
            renderHTML: (attributes) => {
              const gradient = parseRichTextGradient(attributes.textGradient);
              return gradient
                ? {
                    'data-text-gradient': JSON.stringify(gradient),
                    style: `background-image: ${richTextGradientCss(gradient)}; background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent`,
                  }
                : {};
            },
          },
        },
      },
    ];
  },
});

const Superscript = Mark.create({
  name: 'superscript',
  excludes: 'subscript',
  parseHTML: () => [{ tag: 'sup' }],
  renderHTML: ({ HTMLAttributes }) => ['sup', HTMLAttributes, 0],
});

const Subscript = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  parseHTML: () => [{ tag: 'sub' }],
  renderHTML: ({ HTMLAttributes }) => ['sub', HTMLAttributes, 0],
});

/**
 * TextStyle 的字重属性。
 *
 * 标题等 variant 自带粗体基准值；显式写入 400 后，教师仍可像 PowerPoint 一样
 * 关闭基准粗体，而不必把元素降级成另一种 variant。
 */
const FontWeight = Extension.create({
  name: 'fontWeight',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontWeight: {
            default: null,
            parseHTML: (element) => {
              const value = Number.parseInt(element.style.fontWeight, 10);
              return Number.isFinite(value) ? value : null;
            },
            renderHTML: (attributes) =>
              typeof attributes.fontWeight === 'number'
                ? { style: `font-weight: ${attributes.fontWeight}` }
                : {},
          },
        },
      },
    ];
  },
});

// Match the editor's usable font-size range and the 1600px slide width.
const CLIPBOARD_FONT_SIZE_MIN_PX = 1;
const CLIPBOARD_FONT_SIZE_MAX_PX = 88;
const CLIPBOARD_LINE_HEIGHT_MAX_RATIO = 10;
const CLIPBOARD_LAYOUT_LENGTH_MAX_PX = 1_600;
const CLIPBOARD_LETTER_SPACING_MAX_PX = 100;
const CSS_NUMBER_PATTERN = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))$/;
const CSS_PERCENTAGE_PATTERN = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/;
const CSS_ABSOLUTE_LENGTH_PATTERN = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|pt)$/i;

function roundedCssNumber(value: number): number {
  return Number(value.toFixed(4));
}

function clipboardAbsoluteLengthPx(
  raw: string,
  {
    allowNegative = false,
    maximum,
    minimum = 0,
  }: { allowNegative?: boolean; maximum: number; minimum?: number },
): number | null {
  const match = CSS_ABSOLUTE_LENGTH_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || (!allowNegative && parsed < 0)) return null;
  const pixels = match[2]!.toLowerCase() === 'pt' ? parsed * (4 / 3) : parsed;
  if (!Number.isFinite(pixels) || Math.abs(pixels) < minimum || Math.abs(pixels) > maximum) {
    return null;
  }
  return roundedCssNumber(pixels);
}

function clipboardPositiveLengthPx(raw: string, maximum: number): number | null {
  const value = clipboardAbsoluteLengthPx(raw, { maximum });
  return value !== null && value > 0 ? value : null;
}

function clipboardNonZeroLengthPx(raw: string, maximum: number): number | null {
  const value = clipboardAbsoluteLengthPx(raw, { allowNegative: true, maximum });
  return value !== null && value !== 0 ? value : null;
}

function clipboardLineHeightRatio(raw: string): number | null {
  const normalized = raw.trim();
  const numberMatch = CSS_NUMBER_PATTERN.exec(normalized);
  const percentageMatch = CSS_PERCENTAGE_PATTERN.exec(normalized);
  const value = numberMatch
    ? Number(numberMatch[1])
    : percentageMatch
      ? Number(percentageMatch[1]) / 100
      : NaN;
  return Number.isFinite(value) && value > 0 && value <= CLIPBOARD_LINE_HEIGHT_MAX_RATIO
    ? roundedCssNumber(value)
    : null;
}

const ClipboardFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => {
              const value = clipboardAbsoluteLengthPx(element.style.fontSize, {
                maximum: CLIPBOARD_FONT_SIZE_MAX_PX,
                minimum: CLIPBOARD_FONT_SIZE_MIN_PX,
              });
              return value === null ? null : `${value}px`;
            },
            renderHTML: (attributes) =>
              typeof attributes.fontSize === 'string' && attributes.fontSize.length > 0
                ? { style: `font-size: ${attributes.fontSize}` }
                : {},
          },
        },
      },
    ];
  },
});

// HTML-derived runs may have a larger line box than their paragraph strut.
const InlineLineHeight = Extension.create({
  name: 'inlineLineHeight',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          lineHeightPx: {
            default: null,
            parseHTML: (element) =>
              clipboardPositiveLengthPx(element.style.lineHeight, CLIPBOARD_LAYOUT_LENGTH_MAX_PX),
            renderHTML: (attributes) =>
              typeof attributes.lineHeightPx === 'number' &&
              Number.isFinite(attributes.lineHeightPx) &&
              attributes.lineHeightPx > 0
                ? { style: `line-height: ${attributes.lineHeightPx}px` }
                : {},
          },
        },
      },
    ];
  },
});

/**
 * 段落级排版属性（PPTX 导入的行距 / 段前 / 段后 / 缩进）。
 *
 * lineHeight 是相对行距倍数（1 = 单倍）；lineHeightPx 是绝对行距（舞台像素,
 * 对应 PPTX spcPts），两者互斥，mapper 只写其一。defaultLetterSpacing 是空段落
 * 及未显式设置 run 的字符间距回退。spaceBefore / spaceAfter / leftIndent /
 * rightIndent / firstLineIndent 单位为舞台像素（firstLineIndent 可为负 = 悬挂缩进）。
 * 教师改文字不丢导入排版；不设置时完全不出现在 JSON 里。
 */
function createParagraphSpacing(clipboardCssParsing: boolean) {
  return Extension.create({
    name: 'paragraphSpacing',
    addGlobalAttributes() {
      return [
        {
          types: ['paragraph'],
          attributes: {
            fontSize: {
              default: null,
              parseHTML: (element) => {
                const raw = element.style.fontSize;
                if (clipboardCssParsing) {
                  return clipboardAbsoluteLengthPx(raw, {
                    maximum: CLIPBOARD_FONT_SIZE_MAX_PX,
                    minimum: CLIPBOARD_FONT_SIZE_MIN_PX,
                  });
                }
                const value = /^\d+(?:\.\d+)?px$/.test(raw) ? Number.parseFloat(raw) : NaN;
                return Number.isFinite(value) && value > 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.fontSize === 'number' &&
                Number.isFinite(attributes.fontSize) &&
                attributes.fontSize > 0
                  ? { style: `font-size: ${attributes.fontSize}px` }
                  : {},
            },
            lineHeight: {
              default: null,
              parseHTML: (element) => {
                const raw = element.style.lineHeight;
                if (clipboardCssParsing) return clipboardLineHeightRatio(raw);
                if (raw.endsWith('px')) return null;
                const value = Number.parseFloat(raw);
                return Number.isFinite(value) && value > 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.lineHeight === 'number'
                  ? { style: `line-height: ${attributes.lineHeight}` }
                  : {},
            },
            lineHeightPx: {
              default: null,
              parseHTML: (element) => {
                const raw = element.style.lineHeight;
                if (clipboardCssParsing) {
                  return clipboardPositiveLengthPx(raw, CLIPBOARD_LAYOUT_LENGTH_MAX_PX);
                }
                if (!raw.endsWith('px')) return null;
                const value = Number.parseFloat(raw);
                return Number.isFinite(value) && value > 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.lineHeightPx === 'number'
                  ? { style: `line-height: ${attributes.lineHeightPx}px` }
                  : {},
            },
            defaultLetterSpacing: {
              default: null,
              parseHTML: (element) => {
                if (clipboardCssParsing) {
                  return clipboardNonZeroLengthPx(
                    element.style.letterSpacing,
                    CLIPBOARD_LETTER_SPACING_MAX_PX,
                  );
                }
                const value = Number.parseFloat(element.style.letterSpacing);
                return Number.isFinite(value) && value !== 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.defaultLetterSpacing === 'number'
                  ? { style: `letter-spacing: ${attributes.defaultLetterSpacing}px` }
                  : {},
            },
            spaceBefore: {
              default: null,
              parseHTML: (element) => {
                if (clipboardCssParsing) {
                  return clipboardPositiveLengthPx(
                    element.style.marginTop,
                    CLIPBOARD_LAYOUT_LENGTH_MAX_PX,
                  );
                }
                const value = Number.parseFloat(element.style.marginTop);
                return Number.isFinite(value) && value > 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.spaceBefore === 'number'
                  ? { style: `margin-top: ${attributes.spaceBefore}px` }
                  : {},
            },
            spaceAfter: {
              default: null,
              parseHTML: (element) => {
                if (clipboardCssParsing) {
                  return clipboardPositiveLengthPx(
                    element.style.marginBottom,
                    CLIPBOARD_LAYOUT_LENGTH_MAX_PX,
                  );
                }
                const value = Number.parseFloat(element.style.marginBottom);
                return Number.isFinite(value) && value > 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.spaceAfter === 'number'
                  ? { style: `margin-bottom: ${attributes.spaceAfter}px` }
                  : {},
            },
            leftIndent: {
              default: null,
              parseHTML: (element) => {
                if (clipboardCssParsing) {
                  return clipboardPositiveLengthPx(
                    element.style.marginLeft,
                    CLIPBOARD_LAYOUT_LENGTH_MAX_PX,
                  );
                }
                const value = Number.parseFloat(element.style.marginLeft);
                return Number.isFinite(value) && value > 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.leftIndent === 'number'
                  ? { style: `margin-left: ${attributes.leftIndent}px` }
                  : {},
            },
            rightIndent: {
              default: null,
              parseHTML: (element) => {
                if (clipboardCssParsing) {
                  return clipboardPositiveLengthPx(
                    element.style.marginRight,
                    CLIPBOARD_LAYOUT_LENGTH_MAX_PX,
                  );
                }
                const value = Number.parseFloat(element.style.marginRight);
                return Number.isFinite(value) && value > 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.rightIndent === 'number'
                  ? { style: `margin-right: ${attributes.rightIndent}px` }
                  : {},
            },
            firstLineIndent: {
              default: null,
              parseHTML: (element) => {
                if (clipboardCssParsing) {
                  return clipboardNonZeroLengthPx(
                    element.style.textIndent,
                    CLIPBOARD_LAYOUT_LENGTH_MAX_PX,
                  );
                }
                const value = Number.parseFloat(element.style.textIndent);
                return Number.isFinite(value) && value !== 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.firstLineIndent === 'number'
                  ? { style: `text-indent: ${attributes.firstLineIndent}px` }
                  : {},
            },
          },
        },
      ];
    },
  });
}

const ParagraphSpacing = createParagraphSpacing(false);
const ClipboardParagraphSpacing = createParagraphSpacing(true);

/**
 * TextStyle 的字符间距属性（PPTX rPr spc）。单位为舞台像素。
 */
function createLetterSpacing(clipboardCssParsing: boolean) {
  return Extension.create({
    name: 'letterSpacing',
    addGlobalAttributes() {
      return [
        {
          types: ['textStyle'],
          attributes: {
            letterSpacing: {
              default: null,
              parseHTML: (element) => {
                if (clipboardCssParsing) {
                  return clipboardNonZeroLengthPx(
                    element.style.letterSpacing,
                    CLIPBOARD_LETTER_SPACING_MAX_PX,
                  );
                }
                const value = Number.parseFloat(element.style.letterSpacing);
                return Number.isFinite(value) && value !== 0 ? value : null;
              },
              renderHTML: (attributes) =>
                typeof attributes.letterSpacing === 'number'
                  ? { style: `letter-spacing: ${attributes.letterSpacing}px` }
                  : {},
            },
          },
        },
      ];
    },
  });
}

const LetterSpacing = createLetterSpacing(false);
const ClipboardLetterSpacing = createLetterSpacing(true);

/**
 * Reach Deck 文本元素的 tiptap 扩展集 —— 富文本 schema 的**唯一**定义处。
 *
 * 编辑器与服务端 HTML→JSON 转换必须用同一套扩展，否则同一段 HTML 在两侧会解析出
 * 不同结果。schema 本身即白名单：ProseMirror 解析时丢弃未声明的节点 / 标记 / 属性，
 * 因此不需要额外的消毒器（`<script>`、`onerror=` 这类输入会被直接丢掉）。
 *
 * 单独成包而不是放进 reach-deck-dsl：dsl 是零依赖的纯数据层，被 client / player
 * 等不需要 tiptap 的包依赖，不应把 tiptap 运行时强加给它们。
 */
export type ReachDeckTextExtensionOptions = {
  blockMathNodeView?: NodeViewRenderer;
  /** Restrict imported clipboard CSS to bounded px/pt typography and spacing values. */
  clipboardCssParsing?: boolean;
  /**
   * 打开测验编辑字段的行内图片节点。
   *
   * 幻灯片文本框刻意不开 —— 幻灯片有自己的原生 image 元素，文本框 schema 保持最小。
   * 服务端 HTML→JSON 边界（`html.ts`）同样不开，外部 `<img>` 继续被整体剥离。
   */
  imageNode?: boolean;
  /** 为行内图片提供展示用 NodeView；节点本身不带 `src`，URL 由宿主在渲染期注入。 */
  imageNodeView?: NodeViewRenderer;
  inlineMathNodeView?: NodeViewRenderer;
  /**
   * 打开标题与表格。
   *
   * 幻灯片文本框刻意不开：一个文本框就是一段排版好的文字，标题层级由元素 variant 决定，
   * 表格是独立元素。测验题干 / 解析则是**文档语义**——教师从 Word 复制过来的表格和小标题
   * 属于题目内容本身，展平掉就等于丢信息，所以那边打开，与测验模块的取舍对齐。
   */
  richBlocks?: boolean;
  /**
   * 只对本仓库共享剪贴板转换器（`@reachany/clipboard-content`）产出的安全 HTML 打开。
   *
   * 打开后公式标记只读取 `data-latex`；`data-font-size` / `data-line-height-px` /
   * `data-color` / `data-font-family` 及对应 inline style 一律不进入 schema，
   * 因此外部 HTML 自带的排版 data 属性不可能被提升成幻灯片公式属性。未打开时
   * 仍保持 `clipboardCssParsing` 拒绝一切剪贴板公式标记的既有边界。
   */
  trustedFormulaMarkup?: boolean;
};

type MathTypographyElement = {
  getAttribute(name: string): string | null;
  style: {
    color: string;
    fontFamily: string;
    fontSize: string;
    lineHeight: string;
  };
};

const positiveNumber = (value: unknown): number | null => {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^\s*\d+(?:\.\d+)?(?:px)?\s*$/i.test(value))
  ) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const fontSizeValue = (value: unknown): string | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? `${value}px` : null;
  }
  if (typeof value !== 'string' || !/^\s*\d+(?:\.\d+)?(?:px)?\s*$/i.test(value)) return null;
  const parsed = positiveNumber(value);
  return parsed === null ? null : `${parsed}px`;
};

const colorValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (/^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%+\-\s/]+\))$/i.test(normalized)) {
    return normalized;
  }
  return null;
};

const fontFamilyValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
  const normalized = unquoted.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 && /^[\p{L}\p{N} .()_-]+$/u.test(normalized) ? normalized : null;
};

/**
 * 受信公式标记的最小属性集：只有 upstream 的 latex，没有任何排版属性。
 *
 * 共享剪贴板转换器只会输出 `data-latex`，因此受信解析不需要、也不允许排版属性
 * 存在于 schema 中 —— 属性不存在就无法被外部 HTML 写入。
 */
const trustedFormulaAttributes = () => ({
  latex: {
    default: '',
    parseHTML: (element: MathTypographyElement) => element.getAttribute('data-latex'),
    renderHTML: (attributes: Record<string, unknown>) => ({ 'data-latex': attributes.latex }),
  },
});

const mathTypographyAttributes = () => ({
  fontSize: {
    default: null,
    parseHTML: (element: MathTypographyElement) =>
      fontSizeValue(element.getAttribute('data-font-size') ?? element.style.fontSize),
    renderHTML: (attributes: Record<string, unknown>) => {
      const fontSize = fontSizeValue(attributes.fontSize);
      return fontSize === null ? {} : { 'data-font-size': fontSize };
    },
  },
  lineHeightPx: {
    default: null,
    parseHTML: (element: MathTypographyElement) => {
      const lineHeight = positiveNumber(
        element.getAttribute('data-line-height-px') ??
          (element.style.lineHeight.endsWith('px') ? element.style.lineHeight : ''),
      );
      return lineHeight;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const lineHeight = positiveNumber(attributes.lineHeightPx);
      return lineHeight === null ? {} : { 'data-line-height-px': String(lineHeight) };
    },
  },
  color: {
    default: null,
    parseHTML: (element: MathTypographyElement) =>
      colorValue(element.getAttribute('data-color') ?? element.style.color),
    renderHTML: (attributes: Record<string, unknown>) => {
      const color = colorValue(attributes.color);
      return color === null ? {} : { 'data-color': color };
    },
  },
  fontFamily: {
    default: null,
    parseHTML: (element: MathTypographyElement) =>
      fontFamilyValue(element.getAttribute('data-font-family') ?? element.style.fontFamily),
    renderHTML: (attributes: Record<string, unknown>) => {
      const fontFamily = fontFamilyValue(attributes.fontFamily);
      return fontFamily === null ? {} : { 'data-font-family': fontFamily };
    },
  },
});

/**
 * Slide formulas carry the resolved typography that generation/native-v2 compilation writes.
 * Keep the upstream latex attribute and HTML contract, and only add safe scalar CSS values.
 * Learner-answer formulas intentionally continue to use the upstream schema below.
 */
const ReachDeckBlockMathBase = BlockMath.extend({
  addAttributes() {
    return { ...this.parent?.(), ...mathTypographyAttributes() };
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'reachany-mathlive-node is-block',
        'data-type': 'block-math',
      }),
    ];
  },
});

const ReachDeckInlineMathBase = InlineMath.extend({
  addAttributes() {
    return { ...this.parent?.(), ...mathTypographyAttributes() };
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'reachany-mathlive-node is-inline',
        'data-type': 'inline-math',
      }),
    ];
  },
});

/** Stable asset metadata is persisted; src is an optional display-time URL. */
const ReachDeckImageBase = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: { default: null },
      contentType: { default: null },
      name: { default: null },
      objectKey: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-object-key'),
        renderHTML: (attributes) =>
          typeof attributes.objectKey === 'string' && attributes.objectKey.length > 0
            ? { 'data-object-key': attributes.objectKey }
            : {},
      },
      sizeBytes: { default: null },
    };
  },
});

const ReachDeckAnswerImage = ReachDeckImageBase;

/**
 * 教师授课内容（测验题干 / 选项 / 解析…）的行内图片：**schema 里根本没有 `src`**。
 *
 * 整份 Deck 文档会被 sha256 成 revision token（services/ai-runtime/lib/reach-deck/deck-store.ts），
 * 文档里一旦留下易失的预签名 URL，每次换签都会换 token 并引发假 409。把属性从 schema 里去掉，
 * 让 ProseMirror 自己成为强制点：粘贴、setContent、Decksmith、将来任何命令都写不进 URL。
 * 展示用地址由宿主通过 NodeView 注入。
 *
 * 必须自带 parseHTML —— upstream 只认 `img[src]`，而站内复制经
 * `markTrustedProseMirrorClipboardHtml` 原样保留的 HTML 里图片没有 `src`，不覆写会静默丢图。
 */
const ReachDeckAuthoringImage = ReachDeckImageBase.extend({
  addAttributes() {
    const { src: _src, ...rest } = (this.parent?.() ?? {}) as Record<string, unknown>;
    return rest;
  },
  parseHTML: () => [{ tag: 'img[data-object-key]' }],
});

export function createReachDeckTextExtensions(options: ReachDeckTextExtensionOptions = {}) {
  const blockMathNodeView = options.blockMathNodeView;
  const clipboardCssParsing = options.clipboardCssParsing === true;
  const trustedFormulaMarkup = options.trustedFormulaMarkup === true;
  const inlineMathNodeView = options.inlineMathNodeView;
  // 受信模式窄化属性后仍按 upstream 规则解析 data-type 公式标记；非受信的剪贴板
  // 解析继续整体拒绝公式标记，普通（模型）边界保持完整属性。
  const clipboardMath = <TExtension extends typeof ReachDeckBlockMathBase>(base: TExtension) =>
    trustedFormulaMarkup
      ? base.extend({
          addAttributes: trustedFormulaAttributes,
        })
      : base.extend({
          parseHTML() {
            return [];
          },
        });
  const blockMathBase = clipboardCssParsing
    ? clipboardMath(ReachDeckBlockMathBase)
    : ReachDeckBlockMathBase;
  const inlineMathBase = clipboardCssParsing
    ? clipboardMath(ReachDeckInlineMathBase)
    : ReachDeckInlineMathBase;
  const ReachDeckBlockMath = blockMathNodeView
    ? blockMathBase.extend({
        addNodeView() {
          return blockMathNodeView;
        },
      })
    : blockMathBase;
  const ReachDeckInlineMath = inlineMathNodeView
    ? inlineMathBase.extend({
        addNodeView() {
          return inlineMathNodeView;
        },
      })
    : inlineMathBase;
  const imageNodeView = options.imageNodeView;
  const ReachDeckImage = imageNodeView
    ? ReachDeckAuthoringImage.extend({
        addNodeView() {
          return imageNodeView;
        },
      })
    : ReachDeckAuthoringImage;

  const richBlocks = options.richBlocks === true;

  return [
    StarterKit.configure({
      // 幻灯片文本框需要段落、列表与行内格式；其余块级结构由元素本身承载。
      // 列表自 PPTX 导入起加入 schema（bullet/number 层级是幻灯片文本的常态）。
      // 测验题干是文档语义，额外放开标题（表格见下方的 TableKit）。
      heading: richBlocks ? undefined : false,
      blockquote: false,
      code: clipboardCssParsing ? false : undefined,
      codeBlock: false,
      horizontalRule: false,
      link: clipboardCssParsing ? false : undefined,
    }),
    ...(richBlocks ? [TableKit.configure({ table: { renderWrapper: true } })] : []),
    TextStyle,
    FontWeight,
    InlineLineHeight,
    clipboardCssParsing ? ClipboardParagraphSpacing : ParagraphSpacing,
    clipboardCssParsing ? ClipboardLetterSpacing : LetterSpacing,
    ...(clipboardCssParsing ? [] : [TextGradient]),
    Color,
    BackgroundColor,
    FontFamily,
    clipboardCssParsing ? ClipboardFontSize : FontSize,
    Superscript,
    Subscript,
    TextAlign.configure({ types: ['paragraph'] }),
    ReachDeckInlineMath.configure({ katexOptions: { throwOnError: false } }),
    ReachDeckBlockMath.configure({ katexOptions: { throwOnError: false } }),
    ...(options.imageNode === true
      ? [ReachDeckImage.configure({ allowBase64: false, inline: false })]
      : []),
  ];
}

/** Full rich-text schema for learner-entered Quiz answers; slide text remains intentionally small. */
export function createReachDeckAnswerExtensions(options: ReachDeckTextExtensionOptions = {}) {
  const blockMathNodeView = options.blockMathNodeView;
  const inlineMathNodeView = options.inlineMathNodeView;
  const AnswerBlockMath = blockMathNodeView
    ? BlockMath.extend({
        addNodeView() {
          return blockMathNodeView;
        },
      })
    : BlockMath;
  const AnswerInlineMath = inlineMathNodeView
    ? InlineMath.extend({
        addNodeView() {
          return inlineMathNodeView;
        },
      })
    : InlineMath;

  return [
    StarterKit,
    TextStyle,
    FontWeight,
    Color,
    BackgroundColor,
    FontFamily,
    FontSize,
    Superscript,
    Subscript,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ReachDeckAnswerImage.configure({ allowBase64: false, inline: false }),
    AnswerInlineMath.configure({ katexOptions: { throwOnError: false } }),
    AnswerBlockMath.configure({ katexOptions: { throwOnError: false } }),
  ];
}
