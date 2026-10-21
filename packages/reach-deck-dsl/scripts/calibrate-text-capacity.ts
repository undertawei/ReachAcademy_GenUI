/// <reference lib="dom" />

/**
 * 文本容量标定脚本（一次性工具，不进 CI，不作为常规测试跑）。
 *
 * 用途：对 `TYPOGRAPHY_TOKENS`（layoutContract.ts）里每一种排版档位，在一组常用
 * 槽宽下，用 Playwright 驱动真实 Chromium 渲染引擎实测"一行能放多少个字"，产出
 * `../src/textCapacityTable.ts` 这份 check-in 的同源容量表数据，供 prompt 侧
 * 内容长度预算与 judge 侧 `TEXT_CAPACITY` 检查共同查表使用（同一份数据，两处消费）。
 *
 * 字体栈选择与播放器一致性论证：
 * - Reach Deck 文字实际使用的字号来自 `TYPOGRAPHY_TOKENS[variant].fontSize`
 *   透传给 `ReachDeckRichText` 的 `defaultFontSize`，并在每个段落上以内联样式
 *   `style.fontSize` 强制生效——这会覆盖 `styles.css` 里 `.text-caption`
 *   类选择器上的字号，因此实际渲染字号始终等于
 *   `TYPOGRAPHY_TOKENS` 里的数值，标定按 token 的 fontSize/lineHeight 取值是准确的。
 * - 字体族：从仓库 Player 字体目录加载 `Source Han Sans VF`，等待 fonts ready 并验证
 *   匹配 FontFace 已 loaded；系统 fallback 不算标定通过。
 *
 * 测量方法：用 canvas 2D `measureText` API 在 Playwright 页面上下文里逐字符实测
 * 宽度（比逐行渲染再读 DOM 尺寸更快、更精确，且是 Chromium 真实排版内核的度量结果，
 * 不是近似）。分别用一段代表性中文样本与一段代表性英文样本，取每个字符宽度的平均值
 * 作为 `cjkCharsPerLine`/`latinCharsPerLine` 的换算基准；标点/空格按各自实际宽度计入
 * 样本平均，不做单独修正。除字号外，`ctx.font` 按 token 写入真实 font-weight，
 * `ctx.letterSpacing`（Chromium canvas 2D 支持）按 token 写入真实字距——渲染属性
 * （family/weight/letter-spacing/text-transform）逐 token 复刻，而不是只喂 fontSize，
 * 详见 `TOKEN_RENDER_STYLES` 与其注释。
 *
 * 输出：`packages/reach-deck-dsl/src/textCapacityTable.ts`，含分场景实测数值
 * （token × 槽宽 → cjkCharsPerLine/latinCharsPerLine/maxCjkChars/maxLatinChars）与
 * 生成头注释（标定环境、生成时间、脚本路径）。脚本可重复运行（幂等）：每次运行都是
 * 用相同方法重新实测并整份重写数据文件，不依赖上一次运行的残留状态。
 *
 * 运行方式：`npx tsx packages/reach-deck-dsl/scripts/calibrate-text-capacity.ts`
 *（需要已安装 Playwright 及其 Chromium：`npx playwright install chromium`）。
 */

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  LEGACY_TYPOGRAPHY_TOKENS,
  type TypographyToken,
  type TypographyTokenSet,
} from '../src/layoutContract.js';

/** 播放器实际渲染族链；首选项必须由仓库 WOFF2 命中，不接受系统 fallback。 */
const FONT_FAMILY_NAME = 'Source Han Sans VF';
const FONT_FAMILY_STACK = `"${FONT_FAMILY_NAME}", sans-serif`;

/** 需求列出的常用槽宽（1440 = DECK_SAFE_AREA 满宽）。 */
const CALIBRATION_WIDTHS_PX = [320, 480, 640, 960, 1200, 1440] as const;
const DERIVED_NARROW_WIDTHS_PX = [160, 192, 240, 280] as const;
const ALL_CAPACITY_WIDTHS_PX = [...DERIVED_NARROW_WIDTHS_PX, ...CALIBRATION_WIDTHS_PX] as const;
const NARROW_WIDTH_REFERENCE_PX = 480;
const NARROW_WIDTH_SAFETY_RATIO = 0.9;

/** 中文实测样本：覆盖常见标点，避免样本全是等宽汉字导致标点权重被忽略。 */
const CJK_SAMPLE =
  '教育是国家发展的根本，课堂教学应当注重启发学生独立思考的能力与习惯，培养创新精神。' +
  '教师需要在有限的时间内，把复杂的知识点讲清楚、讲透彻，同时兼顾不同学生的理解节奏。';

/** 英文实测样本：覆盖大小写、常见标点与空格。 */
const LATIN_SAMPLE =
  'Education is the foundation of national development, and classroom teaching should ' +
  'inspire independent thinking skills and habits while cultivating a spirit of innovation ' +
  'among students today. Teachers must explain complex ideas clearly within limited time.';

/**
 * 每个排版档位在播放器里实际生效的渲染属性（font-weight / letter-spacing / text-transform）。
 *
 * 数据来源：`packages/reach-deck-player/styles.css` 的 `.text-{variant}` 类选择器实测：
 * - title：`font-weight: 800; letter-spacing: -0.035em;`（无 text-transform）。
 * - body / caption：`.reach-deck-player` 基础规则未设置 font-weight，两者均无更具体的
 *   覆盖规则，取浏览器默认 `font-weight: 400`、`letter-spacing: normal`。
 *
 * 之所以只标这三项（不含 font-size）：`ReachDeckRichText` 渲染段落时总以内联样式
 * `style.fontSize` 强制生效（见 `ReachDeckRichText.tsx` 的 `RichTextBlock`），会覆盖
 * 这里 CSS 类选择器上任何字号写法，因此字号维持直接取 `TYPOGRAPHY_TOKENS` 的既有做法
 * 不受影响；但 font-weight / letter-spacing 在段落级内联样式里没有对应字段（仅当
 * 富文本节点带 `textStyle` mark 显式覆盖时才会内联生效，DSL 当前生成的受限 markdown
 * 不产出这类 mark），且 text-transform 在任何层级都没有可覆盖的 mark，因此这三项
 * 始终从 `.text-{variant}` 类选择器上的 ambient 值继承下来，会实际影响字符宽度，
 * 标定必须按 token 复刻，不能只喂 fontSize。
 */
interface TokenRenderStyle {
  fontWeight: number;
  letterSpacingEm: number;
  textTransform: 'none' | 'uppercase';
}

const TOKEN_RENDER_STYLES: Record<keyof TypographyTokenSet, TokenRenderStyle> = {
  title: { fontWeight: 800, letterSpacingEm: -0.035, textTransform: 'none' },
  body: { fontWeight: 400, letterSpacingEm: 0, textTransform: 'none' },
  caption: { fontWeight: 400, letterSpacingEm: 0, textTransform: 'none' },
};

interface CapacityCell {
  cjkCharsPerLine: number;
  latinCharsPerLine: number;
  maxCjkChars: number;
  maxLatinChars: number;
}

type CapacityTableData = Record<string, Record<number, CapacityCell>>;

const deriveNarrowCell = (
  widthPx: number,
  token: TypographyToken,
  reference: CapacityCell,
): CapacityCell => {
  const ratio = (widthPx / NARROW_WIDTH_REFERENCE_PX) * NARROW_WIDTH_SAFETY_RATIO;
  const cjkCharsPerLine = Math.max(1, Math.floor(reference.cjkCharsPerLine * ratio));
  const latinCharsPerLine = Math.max(1, Math.floor(reference.latinCharsPerLine * ratio));
  return {
    cjkCharsPerLine,
    latinCharsPerLine,
    maxCjkChars: cjkCharsPerLine * token.maxLines,
    maxLatinChars: latinCharsPerLine * token.maxLines,
  };
};

interface MeasuredAvgWidths {
  cjkAvgWidthPx: number;
  latinAvgWidthPx: number;
}

/**
 * 实测某排版档位在其真实渲染属性（字号/字重/字距/大小写）下的平均字符宽度。
 *
 * `ctx.font` 按 canvas 2D 字体简写语法写入字重前缀，
 * `ctx.letterSpacing` 是 Chromium canvas 2D 上下文支持的属性（已通过实测验证：设置前后
 * `measureText().width` 有可度量差异），按 `letterSpacingEm × fontSizePx` 换算成像素写入。
 * `text-transform: uppercase` 只影响 Latin 采样：uppercase 档位下用大写版英文样本测量，
 * 而不是对小写样本测量后再假设变换不影响字宽（大写字形通常更宽，必须实测大写形态）。
 */
async function measureAverageCharWidths(
  page: import('@playwright/test').Page,
  fontSizePx: number,
  renderStyle: TokenRenderStyle,
): Promise<MeasuredAvgWidths> {
  const latinSample =
    renderStyle.textTransform === 'uppercase' ? LATIN_SAMPLE.toUpperCase() : LATIN_SAMPLE;
  return page.evaluate(
    ({ fontSizePx, fontFamily, cjkSample, latinSample, fontWeight, letterSpacingPx }) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法获取 canvas 2D 上下文');
      ctx.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`;
      ctx.letterSpacing = `${letterSpacingPx}px`;
      const cjkTotal = ctx.measureText(cjkSample).width;
      const latinTotal = ctx.measureText(latinSample).width;
      return {
        cjkAvgWidthPx: cjkTotal / [...cjkSample].length,
        latinAvgWidthPx: latinTotal / [...latinSample].length,
      };
    },
    {
      fontSizePx,
      fontFamily: FONT_FAMILY_STACK,
      cjkSample: CJK_SAMPLE,
      latinSample,
      fontWeight: renderStyle.fontWeight,
      letterSpacingPx: renderStyle.letterSpacingEm * fontSizePx,
    },
  );
}

function buildCell(
  widthPx: number,
  token: TypographyToken,
  avgWidths: MeasuredAvgWidths,
): CapacityCell {
  // 平均字宽不能精确建模行尾禁则、整词换行与混排；每行预留一个字符，避免临界值
  // 系统性多换一行。真实 DOM 诊断仍负责暴露富文本/公式等剩余偏差。
  const cjkCharsPerLine = Math.max(1, Math.floor(widthPx / avgWidths.cjkAvgWidthPx) - 1);
  const latinCharsPerLine = Math.max(1, Math.floor(widthPx / avgWidths.latinAvgWidthPx) - 1);
  return {
    cjkCharsPerLine,
    latinCharsPerLine,
    maxCjkChars: cjkCharsPerLine * token.maxLines,
    maxLatinChars: latinCharsPerLine * token.maxLines,
  };
}

async function calibrate(tokens: TypographyTokenSet): Promise<CapacityTableData> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const fontsDir = path.resolve(scriptDir, '../../reach-deck-player/fonts');
    const fontCss = readFileSync(path.join(fontsDir, 'fonts.css'), 'utf8');
    await page.route('http://reach-deck-calibration.local/*', async (route) => {
      const fileName = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
      if (path.basename(fileName) !== fileName || !fileName.endsWith('.woff2')) {
        await route.abort();
        return;
      }
      await route.fulfill({ contentType: 'font/woff2', path: path.join(fontsDir, fileName) });
    });
    await page.setContent(
      `<!doctype html><html><head><base href="http://reach-deck-calibration.local/"><style>${fontCss}</style></head><body></body></html>`,
    );
    await page.evaluate(
      async ({ cjkSample, family }) => {
        await document.fonts.load(`400 30px "${family}"`, cjkSample);
        await document.fonts.load(`800 64px "${family}"`, cjkSample);
        await document.fonts.ready;
      },
      { cjkSample: CJK_SAMPLE, family: FONT_FAMILY_NAME },
    );

    const fontCheck = await page.evaluate(
      ({ cjkSample, family }) => {
        let matchingFaces = 0;
        document.fonts.forEach((face) => {
          if (face.family.replaceAll('"', '') === family && face.status === 'loaded') {
            matchingFaces += 1;
          }
        });
        return {
          regularLoaded: document.fonts.check(`400 30px "${family}"`, cjkSample),
          titleLoaded: document.fonts.check(`800 64px "${family}"`, cjkSample),
          matchingFaces,
        };
      },
      { cjkSample: CJK_SAMPLE, family: FONT_FAMILY_NAME },
    );
    if (!fontCheck.regularLoaded || !fontCheck.titleLoaded || fontCheck.matchingFaces === 0) {
      throw new Error(
        `仓库字体 ${FONT_FAMILY_NAME} 未被 Chromium 实际加载，拒绝使用系统 fallback 标定。`,
      );
    }

    const table: CapacityTableData = {};
    for (const [tokenName, token] of Object.entries(tokens) as [
      keyof TypographyTokenSet,
      TypographyToken,
    ][]) {
      const renderStyle = TOKEN_RENDER_STYLES[tokenName];
      const avgWidths = await measureAverageCharWidths(page, token.fontSize, renderStyle);
      const row: Record<number, CapacityCell> = {};
      for (const widthPx of CALIBRATION_WIDTHS_PX) {
        row[widthPx] = buildCell(widthPx, token, avgWidths);
      }
      for (const widthPx of DERIVED_NARROW_WIDTHS_PX) {
        row[widthPx] = deriveNarrowCell(widthPx, token, row[NARROW_WIDTH_REFERENCE_PX]!);
      }
      table[tokenName] = row;
    }
    return table;
  } finally {
    await browser.close();
  }
}

function renderTableRows(table: CapacityTableData, tokenNames: string[]): string {
  return tokenNames
    .map((tokenName) => {
      const row = table[tokenName];
      const cellsLiteral = ALL_CAPACITY_WIDTHS_PX.map((widthPx) => {
        const cell = row[widthPx];
        return (
          `    ${widthPx}: { cjkCharsPerLine: ${cell.cjkCharsPerLine}, ` +
          `latinCharsPerLine: ${cell.latinCharsPerLine}, maxCjkChars: ${cell.maxCjkChars}, ` +
          `maxLatinChars: ${cell.maxLatinChars} },`
        );
      }).join('\n');
      return `  ${tokenName}: {\n${cellsLiteral}\n  },`;
    })
    .join('\n');
}

function renderDataFile(table: CapacityTableData, generatedAt: string): string {
  const tokenNames = Object.keys(LEGACY_TYPOGRAPHY_TOKENS);
  const widthsLiteral = CALIBRATION_WIDTHS_PX.join(', ');
  const derivedWidthsLiteral = DERIVED_NARROW_WIDTHS_PX.join(', ');
  const rowsLiteral = renderTableRows(table, tokenNames);

  return `/**
 * 文本容量表（同源数据，供 prompt 侧内容长度预算与 judge 侧 TEXT_CAPACITY 检查共用）。
 *
 * 本文件由脚本生成，不要手改数值——改标定方法或样本后重跑脚本覆盖整份重写：
 *   npx tsx packages/reach-deck-dsl/scripts/calibrate-text-capacity.ts
 *
 * 字段含义：
 * - 第一层 key：TYPOGRAPHY_TOKENS 的排版档位名（title/body/caption）。
 * - 第二层 key：槽宽（px）。[${widthsLiteral}] 来自浏览器标定；
 *   [${derivedWidthsLiteral}] 从稳定的 ${NARROW_WIDTH_REFERENCE_PX}px 标定档按宽度比例再乘
 *   ${NARROW_WIDTH_SAFETY_RATIO} 安全系数保守推导。1440 对应 DECK_SAFE_AREA 满宽。
 * - cjkCharsPerLine：该档位字号在该槽宽下，纯中文文本一行能放下的字数（含全角标点）。
 * - latinCharsPerLine：同一场景下，纯英文文本（含空格）一行能放下的字符数。
 * - maxCjkChars / maxLatinChars：结合该档位 maxLines（最大行数）算出的容器总容量
 *   （= 每行字数 × maxLines）。
 *
 * 标定环境与方法：
 * - 生成时间：${generatedAt}
 * - 标定脚本：packages/reach-deck-dsl/scripts/calibrate-text-capacity.ts
 * - 渲染引擎：Playwright 驱动的 Chromium headless（真实浏览器排版/字体解析内核）。
 * - 测量方式：canvas 2D \`measureText\` 逐样本测平均字符宽度（中文样本、英文样本各一段，
 *   覆盖常见标点与大小写），再用 \`floor(槽宽 / 平均字符宽度) - 1\` 换算每行安全字数；
 *   每行预留一个字符用于吸收行尾禁则、整词换行与混排误差。
 * - 字体：仓库自托管的 \`Source Han Sans VF\`；等待 fonts ready 并验证匹配 FontFace
 *   已 loaded，系统 fallback 不算通过。
 * - 字号/行高/最大行数：直接取 TYPOGRAPHY_TOKENS 的 fontSize/lineHeight/maxLines——
 *   ReachDeckRichText 渲染时总以内联样式 \`fontSize\` 生效（覆盖 styles.css 里
 *   .text-caption 类选择器上写死的字号），因此 TYPOGRAPHY_TOKENS 的数值
 *   才是真实渲染字号，按它标定与生产渲染一致。
 * - 字重 / 字距 / 大小写四项对账（family/weight/letter-spacing/text-transform）：
 *   font-family 与 fontSize 已如上分别论证一致；font-weight、letter-spacing、
 *   text-transform 这三项在段落级内联样式里没有对应字段（仅当富文本节点带
 *   \`textStyle\` mark 显式覆盖时才会内联生效，DSL 当前生成的受限 markdown 不产出
 *   这类 mark），因此始终从 \`packages/reach-deck-player/styles.css\` 的
 *   \`.text-{variant}\` 类选择器上的 ambient 值继承下来，会实际影响测量宽度：
 *     - title：font-weight 800，letter-spacing -0.035em，无 text-transform。
 *     - body / caption：\`.reach-deck-player\` 基础规则未设置 font-weight，两者均
 *       无更具体覆盖规则，标定时按浏览器默认 font-weight 400、letter-spacing
 *       normal 测量。
 *   这四项均已在标定脚本的 \`ctx.font\`/\`ctx.letterSpacing\`/大写采样里逐 token 复刻，
 *   不再只喂 fontSize。
 * - latinCharsPerLine / maxLatinChars 仅作参考校验：判定文字是否溢出的实际消费路径
 *   （\`estimateCharsPerLine\`/\`countEffectiveChars\` 的"等效中文字"折算）统一走
 *   cjkCharsPerLine 加一个从本表数据派生的 Latin/CJK 宽度折算比（见
 *   \`textCapacityEstimation.ts\` 的 \`LATIN_TO_CJK_WIDTH_RATIO\`），不会分别按
 *   cjk/latin 两套字数上限各自判断——这两列只用于人工核对标定数据是否合理。
 */

export interface TextCapacityCell {
  /** 纯中文文本一行能放下的字数（含全角标点）。 */
  cjkCharsPerLine: number;
  /** 纯英文文本（含空格）一行能放下的字符数。 */
  latinCharsPerLine: number;
  /** 结合 maxLines 算出的中文总容量（cjkCharsPerLine × maxLines）。 */
  maxCjkChars: number;
  /** 结合 maxLines 算出的英文总容量（latinCharsPerLine × maxLines）。 */
  maxLatinChars: number;
}

/** 标定覆盖的常用槽宽集合（px），1440 为 DECK_SAFE_AREA 满宽。 */
export const CALIBRATED_WIDTHS_PX = [${widthsLiteral}] as const;

export type CalibratedWidthPx = (typeof CALIBRATED_WIDTHS_PX)[number];

/** 从 ${NARROW_WIDTH_REFERENCE_PX}px 稳定档保守推导的窄框宽度。 */
export const DERIVED_NARROW_WIDTHS_PX = [${derivedWidthsLiteral}] as const;

/** judge 与 prompt 共同查表的完整宽度断点。 */
export const TEXT_CAPACITY_WIDTHS_PX = [
  ...DERIVED_NARROW_WIDTHS_PX,
  ...CALIBRATED_WIDTHS_PX,
] as const;

export type TextCapacityWidthPx = (typeof TEXT_CAPACITY_WIDTHS_PX)[number];

export const NARROW_WIDTH_SAFETY_RATIO = ${NARROW_WIDTH_SAFETY_RATIO};

export const TEXT_SAFE_LINE_BOX_HEIGHT_PX = {
  title: 76,
  body: 51,
  caption: 38,
} as const;

/** 唯一持久 token 集：token → 槽宽 → 安全容量数据。 */
export const TEXT_CAPACITY_TABLE: Record<
  keyof typeof import('./layoutContract.js').TYPOGRAPHY_TOKENS,
  Record<TextCapacityWidthPx, TextCapacityCell>
> = {
${rowsLiteral}
};

/** legacy/v16 profile 字段解析到同一容量表。 */
export const V16_TEXT_CAPACITY_TABLE = TEXT_CAPACITY_TABLE;
`;
}

async function main(): Promise<void> {
  const table = await calibrate(LEGACY_TYPOGRAPHY_TOKENS);
  const generatedAt = new Date().toISOString();
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outputPath = path.resolve(scriptDir, '../src/textCapacityTable.ts');
  writeFileSync(outputPath, renderDataFile(table, generatedAt), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`容量表已写入：${outputPath}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('容量标定脚本执行失败：', error);
  process.exitCode = 1;
});
