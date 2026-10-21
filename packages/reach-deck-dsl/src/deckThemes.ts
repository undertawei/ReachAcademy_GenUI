/**
 * 精选 deck 主题库：生成链路按大纲选定一个主题，贯穿整个 deck。
 *
 * 主题只承载**语义槽色值**，不承载版式：页面内容写 `colorToken`（ink/muted/accent/…）
 * 与背景 token，编译层（`compileDeckSlideToNativeV2`）按当前 `DeckTheme` 的同名槽解析成
 * 具体色值，因此换主题不需要改任何页面内容。
 *
 * 字体刻意全库统一（见 `SHARED_THEME_FONTS`）：`textCapacityTable.ts` 的每行字数容量表
 * 是按仓库自托管的 `Source Han Sans VF` 在真实浏览器里标定的，生成侧的内容长度预算、judge 侧的
 * textCapacity 检查都查那张表。主题若各自换字体，字宽随之改变，容量表会整体失准而
 * 又无从按主题分别标定，故本库只在颜色维度上做区分。
 */

import type { DeckTheme } from './types.js';

/**
 * 全库共用字体族。
 *
 * 生成模型不选择字体。展示与正文字体统一命中已有自托管字体，避免操作系统 fallback。
 */
const SHARED_THEME_FONTS = {
  fontDisplay: 'Source Han Sans VF',
  fontBody: 'Source Han Sans VF',
} as const satisfies Pick<DeckTheme, 'fontDisplay' | 'fontBody'>;

/** 主题库的稳定标识：落库到大纲工件的 `themeName` 用的就是这组字面量。 */
export const DECK_THEME_NAMES = [
  'reach-classic',
  'deep-tech',
  'warm-study',
  'high-contrast-board',
  'evergreen-field',
] as const;

export type DeckThemeName = (typeof DECK_THEME_NAMES)[number];

/** 库内主题条目：主题本体 + 给模型看的适用场景说明。 */
export interface DeckThemeEntry {
  name: DeckThemeName;
  theme: DeckTheme;
  /** 中文适用场景，供人阅读与运营侧选择。 */
  description: string;
  /** 英文一句话说明，注入大纲 prompt 供模型选型（prompt 正文一律英文）。 */
  guidance: string;
}

/**
 * 默认主题：与历史 `DEFAULT_THEME` 逐字段等值。
 *
 * 存量 deck 不带 `themeName`，解析时回落到这里，因此**这些色值不可改动**——
 * 改了等于给所有历史课件换色。新审美诉求请新增主题，不要改本条。
 */
const REACH_CLASSIC: DeckTheme = {
  name: 'Reach',
  background: '#ffffff',
  surface: '#f8fafc',
  ink: '#172024',
  muted: '#647178',
  accent: '#2563eb',
  success: '#15803d',
  warning: '#b45309',
  ...SHARED_THEME_FONTS,
};

/** 深底科技：夜间/理工科演示，深底浅字，弱化环境光干扰。 */
const DEEP_TECH: DeckTheme = {
  name: 'Deep Tech',
  background: '#0b1220',
  surface: '#151f33',
  ink: '#f1f5f9',
  muted: '#a9b6c9',
  accent: '#7dd3fc',
  success: '#6ee7b7',
  warning: '#fcd34d',
  ...SHARED_THEME_FONTS,
};

/** 浅底暖学：人文/语言类课程，米底暖褐字，长时间阅读不刺眼。 */
const WARM_STUDY: DeckTheme = {
  name: 'Warm Study',
  background: '#fdf8f1',
  surface: '#f5ece0',
  ink: '#2b2118',
  muted: '#6b5745',
  accent: '#b45309',
  success: '#3f6212',
  warning: '#9a3412',
  ...SHARED_THEME_FONTS,
};

/** 高对比板报：投影仪或低质量屏幕，纯黑白 + 高饱和强调色，牺牲雅致换清晰。 */
const HIGH_CONTRAST_BOARD: DeckTheme = {
  name: 'High Contrast Board',
  background: '#ffffff',
  surface: '#eef1f4',
  ink: '#000000',
  muted: '#44515c',
  accent: '#0b4fd1',
  success: '#12601f',
  warning: '#9a3200',
  ...SHARED_THEME_FONTS,
};

/** 常青原野：自然科学/生物地理，浅青底墨绿字，配图为绿色系时不打架。 */
const EVERGREEN_FIELD: DeckTheme = {
  name: 'Evergreen Field',
  background: '#f2f8f4',
  surface: '#e2efe7',
  ink: '#16241c',
  muted: '#4f6558',
  accent: '#0f766e',
  success: '#15803d',
  warning: '#a1500a',
  ...SHARED_THEME_FONTS,
};

/** 主题库全量条目，顺序即展示顺序（默认主题排第一）。 */
export const DECK_THEME_LIBRARY: readonly DeckThemeEntry[] = [
  {
    name: 'reach-classic',
    theme: REACH_CLASSIC,
    description: '默认通用主题：白底深墨蓝字，学科中立，不确定选什么时用它。',
    guidance: 'Neutral white background; the safe default for any subject.',
  },
  {
    name: 'deep-tech',
    theme: DEEP_TECH,
    description: '深底科技：夜间课堂或理工科演示，深蓝底浅字，代码与图表更聚焦。',
    guidance: 'Dark navy background for engineering, computing, or evening sessions.',
  },
  {
    name: 'warm-study',
    theme: WARM_STUDY,
    description: '浅底暖学：语文、历史、外语等人文课程，米色底暖褐字，长文阅读舒适。',
    guidance: 'Warm paper background for humanities, language, and reading-heavy lessons.',
  },
  {
    name: 'high-contrast-board',
    theme: HIGH_CONTRAST_BOARD,
    description: '高对比板报：投影仪、老旧屏幕或强环境光场景，纯黑字最大化可读性。',
    guidance: 'Maximum-contrast black on white for projectors and low-quality displays.',
  },
  {
    name: 'evergreen-field',
    theme: EVERGREEN_FIELD,
    description: '常青原野：生物、地理、环境等自然科学，浅青底墨绿字，与绿色系配图协调。',
    guidance: 'Cool green background for biology, geography, and environmental science.',
  },
] as const;

/** 缺省主题名：存量 deck 与模型未选型时都回落到它。 */
export const DEFAULT_DECK_THEME_NAME: DeckThemeName = 'reach-classic';

const THEME_BY_NAME = new Map<string, DeckTheme>(
  DECK_THEME_LIBRARY.map((entry) => [entry.name, entry.theme]),
);

/** 值是否为库内主题名。 */
export const isDeckThemeName = (value: unknown): value is DeckThemeName =>
  typeof value === 'string' && THEME_BY_NAME.has(value);

/**
 * 主题名 → `DeckTheme`，未知名字（含 undefined）一律回落默认主题。
 *
 * 刻意不抛错：主题名来自模型输出与历史落库数据，为一个不认识的名字整页生成失败
 * 得不偿失，回落默认主题是安全且可见的降级。
 */
export const resolveDeckTheme = (name: string | undefined): DeckTheme =>
  (name === undefined ? undefined : THEME_BY_NAME.get(name)) ??
  THEME_BY_NAME.get(DEFAULT_DECK_THEME_NAME)!;

/** 注入大纲 prompt 的主题清单说明段（英文，与 prompt 正文语言一致）。 */
export const deckThemeCatalogSnippet = (): string =>
  [
    'Available deck themes (choose exactly one themeName for the whole deck):',
    ...DECK_THEME_LIBRARY.map((entry) => `- ${entry.name}: ${entry.guidance}`),
  ].join('\n');
