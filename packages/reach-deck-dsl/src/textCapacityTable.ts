/**
 * 文本容量表（同源数据，供 prompt 侧内容长度预算与 judge 侧 TEXT_CAPACITY 检查共用）。
 *
 * 本文件由脚本生成，不要手改数值——改标定方法或样本后重跑脚本覆盖整份重写：
 *   npx tsx packages/reach-deck-dsl/scripts/calibrate-text-capacity.ts
 *
 * 字段含义：
 * - 第一层 key：TYPOGRAPHY_TOKENS 的排版档位名（title/body/caption）。
 * - 第二层 key：槽宽（px）。320px 及以上来自浏览器标定；160/192/240/280px
 *   从稳定的 480px 标定档按宽度比例再乘 0.9 安全系数保守推导，避免把窄框向上
 *   夹成 320px 容量。1440 对应 DECK_SAFE_AREA 满宽。
 * - cjkCharsPerLine：该档位字号在该槽宽下，纯中文文本一行能放下的字数（含全角标点）。
 * - latinCharsPerLine：同一场景下，纯英文文本（含空格）一行能放下的字符数。
 * - maxCjkChars / maxLatinChars：结合该档位 maxLines（最大行数）算出的容器总容量
 *   （= 每行字数 × maxLines）。
 *
 * 标定环境与方法：
 * - 生成时间：2026-08-13T02:45:59.574Z
 * - 标定脚本：packages/reach-deck-dsl/scripts/calibrate-text-capacity.ts
 * - 渲染引擎：Playwright 驱动的 Chromium headless（真实浏览器排版/字体解析内核）。
 * - 测量方式：canvas 2D `measureText` 逐样本测平均字符宽度（中文样本、英文样本各一段，
 *   覆盖常见标点与大小写），再用 `floor(槽宽 / 平均字符宽度) - 1` 换算每行安全字数；
 *   每行预留一个字符用于吸收行尾禁则、整词换行与混排误差。
 * - 字体：仓库自托管的 `Source Han Sans VF`；等待 fonts ready 并验证匹配 FontFace
 *   已 loaded，系统 fallback 不算通过。
 * - 字号/行高/最大行数：直接取 TYPOGRAPHY_TOKENS 的 fontSize/lineHeight/maxLines——
 *   ReachDeckRichText 渲染时总以内联样式 `fontSize` 生效（覆盖 styles.css 里
 *   .text-caption 类选择器上写死的字号），因此 TYPOGRAPHY_TOKENS 的数值
 *   才是真实渲染字号，按它标定与生产渲染一致。
 * - 字重 / 字距 / 大小写四项对账（family/weight/letter-spacing/text-transform）：
 *   font-family 与 fontSize 已如上分别论证一致；font-weight、letter-spacing、
 *   text-transform 这三项在段落级内联样式里没有对应字段（仅当富文本节点带
 *   `textStyle` mark 显式覆盖时才会内联生效，DSL 当前生成的受限 markdown 不产出
 *   这类 mark），因此始终从 `packages/reach-deck-player/styles.css` 的
 *   `.text-{variant}` 类选择器上的 ambient 值继承下来，会实际影响测量宽度：
 *     - title：font-weight 800，letter-spacing -0.035em，无 text-transform。
 *     - body / caption：`.reach-deck-player` 基础规则未设置 font-weight，两者均
 *       无更具体覆盖规则，标定时按浏览器默认 font-weight 400、letter-spacing
 *       normal 测量。
 *   这四项均已在标定脚本的 `ctx.font`/`ctx.letterSpacing`/大写采样里逐 token 复刻，
 *   不再只喂 fontSize。
 * - latinCharsPerLine / maxLatinChars 仅作参考校验：判定文字是否溢出的实际消费路径
 *   （`estimateCharsPerLine`/`countEffectiveChars` 的"等效中文字"折算）统一走
 *   cjkCharsPerLine 加一个从本表数据派生的 Latin/CJK 宽度折算比（见
 *   `textCapacityEstimation.ts` 的 `LATIN_TO_CJK_WIDTH_RATIO`），不会分别按
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

/** 浏览器直接标定的常用槽宽集合（px），1440 为 DECK_SAFE_AREA 满宽。 */
export const CALIBRATED_WIDTHS_PX = [320, 480, 640, 960, 1200, 1440] as const;

export type CalibratedWidthPx = (typeof CALIBRATED_WIDTHS_PX)[number];

/** 从 480px 稳定档保守推导的窄框宽度；不是额外浏览器标定值。 */
export const DERIVED_NARROW_WIDTHS_PX = [160, 192, 240, 280] as const;

/** judge 与 prompt 共同查表的完整宽度断点。 */
export const TEXT_CAPACITY_WIDTHS_PX = [
  ...DERIVED_NARROW_WIDTHS_PX,
  ...CALIBRATED_WIDTHS_PX,
] as const;

export type TextCapacityWidthPx = (typeof TEXT_CAPACITY_WIDTHS_PX)[number];

/** 窄框由 480px 档线性缩放后额外保留 10% 安全余量。 */
export const NARROW_WIDTH_SAFETY_RATIO = 0.9;

/** 固定 typography tier 对应的安全完整行盒；prompt 与 judge 必须共同使用。 */
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
  title: {
    160: { cjkCharsPerLine: 1, latinCharsPerLine: 4, maxCjkChars: 2, maxLatinChars: 8 },
    192: { cjkCharsPerLine: 2, latinCharsPerLine: 5, maxCjkChars: 4, maxLatinChars: 10 },
    240: { cjkCharsPerLine: 2, latinCharsPerLine: 6, maxCjkChars: 4, maxLatinChars: 12 },
    280: { cjkCharsPerLine: 3, latinCharsPerLine: 7, maxCjkChars: 6, maxLatinChars: 14 },
    320: { cjkCharsPerLine: 4, latinCharsPerLine: 9, maxCjkChars: 8, maxLatinChars: 18 },
    480: { cjkCharsPerLine: 6, latinCharsPerLine: 15, maxCjkChars: 12, maxLatinChars: 30 },
    640: { cjkCharsPerLine: 9, latinCharsPerLine: 20, maxCjkChars: 18, maxLatinChars: 40 },
    960: { cjkCharsPerLine: 14, latinCharsPerLine: 31, maxCjkChars: 28, maxLatinChars: 62 },
    1200: { cjkCharsPerLine: 18, latinCharsPerLine: 39, maxCjkChars: 36, maxLatinChars: 78 },
    1440: { cjkCharsPerLine: 22, latinCharsPerLine: 47, maxCjkChars: 44, maxLatinChars: 94 },
  },
  body: {
    160: { cjkCharsPerLine: 4, latinCharsPerLine: 9, maxCjkChars: 32, maxLatinChars: 72 },
    192: { cjkCharsPerLine: 5, latinCharsPerLine: 11, maxCjkChars: 40, maxLatinChars: 88 },
    240: { cjkCharsPerLine: 6, latinCharsPerLine: 14, maxCjkChars: 48, maxLatinChars: 112 },
    280: { cjkCharsPerLine: 7, latinCharsPerLine: 17, maxCjkChars: 56, maxLatinChars: 136 },
    320: { cjkCharsPerLine: 9, latinCharsPerLine: 21, maxCjkChars: 72, maxLatinChars: 168 },
    480: { cjkCharsPerLine: 15, latinCharsPerLine: 33, maxCjkChars: 120, maxLatinChars: 264 },
    640: { cjkCharsPerLine: 20, latinCharsPerLine: 44, maxCjkChars: 160, maxLatinChars: 352 },
    960: { cjkCharsPerLine: 31, latinCharsPerLine: 67, maxCjkChars: 248, maxLatinChars: 536 },
    1200: { cjkCharsPerLine: 39, latinCharsPerLine: 84, maxCjkChars: 312, maxLatinChars: 672 },
    1440: { cjkCharsPerLine: 47, latinCharsPerLine: 102, maxCjkChars: 376, maxLatinChars: 816 },
  },
  caption: {
    160: { cjkCharsPerLine: 5, latinCharsPerLine: 12, maxCjkChars: 10, maxLatinChars: 24 },
    192: { cjkCharsPerLine: 6, latinCharsPerLine: 14, maxCjkChars: 12, maxLatinChars: 28 },
    240: { cjkCharsPerLine: 8, latinCharsPerLine: 18, maxCjkChars: 16, maxLatinChars: 36 },
    280: { cjkCharsPerLine: 9, latinCharsPerLine: 21, maxCjkChars: 18, maxLatinChars: 42 },
    320: { cjkCharsPerLine: 12, latinCharsPerLine: 27, maxCjkChars: 24, maxLatinChars: 54 },
    480: { cjkCharsPerLine: 19, latinCharsPerLine: 41, maxCjkChars: 38, maxLatinChars: 82 },
    640: { cjkCharsPerLine: 25, latinCharsPerLine: 56, maxCjkChars: 50, maxLatinChars: 112 },
    960: { cjkCharsPerLine: 39, latinCharsPerLine: 84, maxCjkChars: 78, maxLatinChars: 168 },
    1200: { cjkCharsPerLine: 49, latinCharsPerLine: 106, maxCjkChars: 98, maxLatinChars: 212 },
    1440: { cjkCharsPerLine: 59, latinCharsPerLine: 127, maxCjkChars: 118, maxLatinChars: 254 },
  },
};

/** legacy/v16 profile 字段解析到同一容量表。 */
export const V16_TEXT_CAPACITY_TABLE = TEXT_CAPACITY_TABLE;
