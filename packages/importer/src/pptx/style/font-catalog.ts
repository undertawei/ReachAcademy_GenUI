import { definePptxFontCatalog, type PptxFontCatalog } from './fonts.js';

/**
 * Built-in catalog for the licensed webfont bundle Reach Deck ships for PPTX
 * imports. Families mirror the name tables of the bundled font files; the
 * substitution rules map the system fonts observed in real teaching decks onto
 * the closest bundled (or metric-compatible) family. Symbol-only families
 * (Wingdings, Monotype Sorts, ...) are intentionally absent: an unresolved
 * symbol font must surface as a diagnostic instead of a silent glyph swap.
 */
export const REACH_PPTX_FONT_CATALOG: PptxFontCatalog = definePptxFontCatalog({
  version: 'reach-fonts/2026-08-04',
  families: [
    // --- CJK ---
    {
      family: 'Source Han Sans VF',
      aliases: ['Source Han Sans', 'SourceHanSans', '思源黑体'],
      scripts: ['latin', 'eastAsia'],
    },
    {
      family: 'Source Han Serif SC',
      aliases: ['Source Han Serif', 'SourceHanSerifSC', '思源宋体'],
      scripts: ['latin', 'eastAsia'],
    },
    {
      family: 'Alibaba PuHuiTi 3.0',
      aliases: ['Alibaba PuHuiTi', '阿里巴巴普惠体 3.0'],
      scripts: ['latin', 'eastAsia'],
    },
    { family: 'LXGW WenKai', aliases: ['霞鹜文楷'], scripts: ['latin', 'eastAsia'] },
    {
      family: 'Zhuque Fangsong (technical preview)',
      aliases: ['Zhuque Fangsong', '朱雀仿宋（预览测试版）'],
      scripts: ['latin', 'eastAsia'],
    },
    // --- Latin ---
    { family: 'Carlito', aliases: [], scripts: ['latin'] },
    { family: 'Liberation Sans', aliases: [], scripts: ['latin'] },
    { family: 'Liberation Serif', aliases: [], scripts: ['latin'] },
    { family: 'EB Garamond', aliases: [], scripts: ['latin'] },
    { family: 'Montserrat', aliases: [], scripts: ['latin'] },
    { family: 'Anton', aliases: [], scripts: ['latin'] },
    { family: 'Comic Neue', aliases: [], scripts: ['latin'] },
    { family: 'osifont', aliases: [], scripts: ['latin'] },
    { family: 'STIX Two Math', aliases: [], scripts: ['latin', 'symbol'] },
    { family: 'TeX Gyre Adventor', aliases: ['TeXGyreAdventor'], scripts: ['latin'] },
  ],
  substitutions: [
    // CJK sans (黑体系).
    { requestedFamily: '微软雅黑', candidates: ['Source Han Sans VF', 'Alibaba PuHuiTi 3.0'] },
    {
      requestedFamily: 'Microsoft YaHei',
      candidates: ['Source Han Sans VF', 'Alibaba PuHuiTi 3.0'],
    },
    { requestedFamily: '黑体', candidates: ['Source Han Sans VF'] },
    { requestedFamily: 'SimHei', candidates: ['Source Han Sans VF'] },
    { requestedFamily: '等线', candidates: ['Alibaba PuHuiTi 3.0', 'Source Han Sans VF'] },
    { requestedFamily: 'DengXian', candidates: ['Alibaba PuHuiTi 3.0', 'Source Han Sans VF'] },
    { requestedFamily: '等线 Light', candidates: ['Alibaba PuHuiTi 3.0', 'Source Han Sans VF'] },
    {
      requestedFamily: 'DengXian Light',
      candidates: ['Alibaba PuHuiTi 3.0', 'Source Han Sans VF'],
    },
    { requestedFamily: '幼圆', candidates: ['Alibaba PuHuiTi 3.0', 'Source Han Sans VF'] },
    // Weight variants of the bundled families resolve to the variable font;
    // the renderer picks the concrete weight from the run's fontWeight.
    { requestedFamily: '思源黑体 Light', candidates: ['Source Han Sans VF'] },
    { requestedFamily: '思源黑体 Heavy', candidates: ['Source Han Sans VF'] },
    { requestedFamily: '思源黑体 CN Regular', candidates: ['Source Han Sans VF'] },
    { requestedFamily: 'Noto Sans SC', candidates: ['Source Han Sans VF'] },
    // Vendor display blacks seen in teaching decks; nearest bundled shape.
    { requestedFamily: '汉仪粗黑简', candidates: ['Source Han Sans VF'] },
    { requestedFamily: '汉仪元隆黑-105简', candidates: ['Source Han Sans VF'] },
    { requestedFamily: '三极戟黑简体', candidates: ['Source Han Sans VF'] },
    { requestedFamily: 'YousheTitleBlack', candidates: ['Source Han Sans VF'] },
    { requestedFamily: 'FangZhengHeiTi', candidates: ['Source Han Sans VF'] },
    { requestedFamily: 'Adobe 黑体 Std R', candidates: ['Source Han Sans VF'] },
    // CJK serif (宋体系).
    { requestedFamily: '宋体', candidates: ['Source Han Serif SC'] },
    { requestedFamily: 'SimSun', candidates: ['Source Han Serif SC'] },
    { requestedFamily: 'NSimSun', candidates: ['Source Han Serif SC'] },
    { requestedFamily: '新宋体', candidates: ['Source Han Serif SC'] },
    { requestedFamily: '华文中宋', candidates: ['Source Han Serif SC'] },
    { requestedFamily: 'STZhongsong', candidates: ['Source Han Serif SC'] },
    { requestedFamily: '华文宋体', candidates: ['Source Han Serif SC'] },
    { requestedFamily: 'STSong', candidates: ['Source Han Serif SC'] },
    { requestedFamily: 'MS Mincho', candidates: ['Source Han Serif SC'] },
    { requestedFamily: '思源宋体 Light', candidates: ['Source Han Serif SC'] },
    { requestedFamily: '思源宋体 Heavy', candidates: ['Source Han Serif SC'] },
    { requestedFamily: 'Noto Serif SC', candidates: ['Source Han Serif SC'] },
    // 楷体 / 仿宋 / 隶书.
    { requestedFamily: '楷体', candidates: ['LXGW WenKai'] },
    { requestedFamily: 'KaiTi', candidates: ['LXGW WenKai'] },
    { requestedFamily: '楷体_GB2312', candidates: ['LXGW WenKai'] },
    { requestedFamily: '华文楷体', candidates: ['LXGW WenKai'] },
    { requestedFamily: 'STKaiti', candidates: ['LXGW WenKai'] },
    { requestedFamily: '隶书', candidates: ['LXGW WenKai'] },
    { requestedFamily: 'LiSu', candidates: ['LXGW WenKai'] },
    { requestedFamily: '仿宋', candidates: ['Zhuque Fangsong (technical preview)'] },
    { requestedFamily: 'FangSong', candidates: ['Zhuque Fangsong (technical preview)'] },
    { requestedFamily: '仿宋_GB2312', candidates: ['Zhuque Fangsong (technical preview)'] },
    { requestedFamily: '华文仿宋', candidates: ['Zhuque Fangsong (technical preview)'] },
    { requestedFamily: 'STFangsong', candidates: ['Zhuque Fangsong (technical preview)'] },
    // 阿里巴巴普惠体 naming variants.
    { requestedFamily: '阿里巴巴普惠体', candidates: ['Alibaba PuHuiTi 3.0'] },
    { requestedFamily: '阿里巴巴普惠体 M', candidates: ['Alibaba PuHuiTi 3.0'] },
    // Latin metric-compatible pairs.
    { requestedFamily: 'Times New Roman', candidates: ['Liberation Serif'] },
    { requestedFamily: 'Arial', candidates: ['Liberation Sans'] },
    { requestedFamily: 'Calibri', candidates: ['Carlito'] },
    { requestedFamily: 'Calibri Light', candidates: ['Carlito'] },
    // Latin best-effort pairs.
    { requestedFamily: 'Helvetica', candidates: ['Liberation Sans'] },
    { requestedFamily: 'Helvetica Neue', candidates: ['Liberation Sans'] },
    { requestedFamily: 'Segoe UI', candidates: ['Liberation Sans'] },
    { requestedFamily: 'Tahoma', candidates: ['Liberation Sans'] },
    { requestedFamily: 'Verdana', candidates: ['Liberation Sans'] },
    { requestedFamily: 'Trebuchet MS', candidates: ['Liberation Sans'] },
    { requestedFamily: 'Cambria', candidates: ['Liberation Serif'] },
    { requestedFamily: 'Georgia', candidates: ['Liberation Serif'] },
    { requestedFamily: 'Garamond', candidates: ['EB Garamond'] },
    { requestedFamily: 'Impact', candidates: ['Anton'] },
    { requestedFamily: 'Comic Sans MS', candidates: ['Comic Neue'] },
    { requestedFamily: 'Century Gothic', candidates: ['TeX Gyre Adventor'] },
    // Math and engineering-drawing fonts.
    { requestedFamily: 'Cambria Math', candidates: ['STIX Two Math'] },
    { requestedFamily: 'UniversalMath1 BT', candidates: ['STIX Two Math'] },
    { requestedFamily: 'ISOCP', candidates: ['osifont'] },
    { requestedFamily: 'ISOCPEUR', candidates: ['osifont'] },
  ],
  fallbacksByScript: {
    latin: ['Carlito', 'Liberation Sans'],
    eastAsia: ['Source Han Sans VF'],
    // No bundled complex-script or symbol coverage: resolution must fail
    // loudly so the import records a diagnostic instead of swapping glyphs.
    complexScript: [],
    symbol: [],
  },
});
