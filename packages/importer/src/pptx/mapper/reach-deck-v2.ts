import {
  parseReachDeckDocumentV2,
  REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
  type DeckTheme,
  type ReachDeckColorV2,
  type ReachDeckCategoricalChartElementV2,
  type ReachDeckDocumentV2,
  type ReachDeckEffectsV2,
  type ReachDeckFillV2,
  type ReachDeckFontSubstitutionV2,
  type ReachDeckImageElementV2,
  type ReachDeckLineElementV2,
  type ReachDeckMediaResourceV2,
  type ReachDeckNativeElementV2,
  type ReachDeckShapeElementV2,
  type ReachDeckSpeakerNotesV2,
  type ReachDeckStrokeV2,
  type ReachDeckTableCellV2,
  type ReachDeckTextFrameV2,
  type RichTextDocument,
  type RichTextMark,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';

import {
  hasBlockingPptxDiagnostics,
  sortPptxDiagnostics,
  type PptxDiagnostic,
} from '../diagnostics.js';
import { createPptxGeometryGuides } from '../geometry/formula.js';
import {
  buildPptxPresetShapeGeometry,
  emitPptxGeometryPath,
  type PptxGeometryPath,
  type PptxGeometryPathCommand,
  type PptxGeometryPathFill,
  type PptxGeometrySubpath,
} from '../geometry/preset-shapes.js';
import { createStablePptxId } from '../identity.js';
import type { PptxPresentationIR, PptxRelationshipIR, PptxSlideIR } from '../ir.js';
import {
  projectPptxShapeElement,
  type PptxShapeNodeIR,
  type PptxSlideNodeIR,
} from '../model/slide-node.js';
import type {
  PptxTextBodyIR,
  PptxTextParagraphPropertiesIR,
  PptxTextRunPropertiesIR,
} from '../model/text.js';
import {
  parsePptxBodyPropertiesElement,
  parsePptxParagraphPropertiesElement,
  parsePptxRunPropertiesElement,
} from '../model/text.js';
import {
  emuToReachDeckStagePoints,
  emuToPoints,
  ooxmlAngleToDegrees,
  ooxmlPercentageToRatio,
  pptxAngle,
  pptxEmu,
  type PptxEmu,
} from '../model/units.js';
import {
  resolvePptxGroupCoordinateSpace,
  resolvePptxTransform2D,
  type PptxResolvedGroupCoordinateSpace,
  type PptxResolvedTransform2D,
} from '../model/geometry.js';
import type { PptxXmlElement } from '../package/xml.js';
import {
  parsePptxColorContainer,
  parsePptxDirectFill,
  parsePptxDirectShapeStyle,
  parsePptxFillElement,
  parsePptxStrokeElement,
  type PptxColorIR,
  type PptxFillIR,
  type PptxStrokeIR,
} from '../style/drawing.js';
import {
  resolvePptxColor,
  type PptxResolvedColor,
  type PptxSchemeColorContext,
} from '../style/color-resolution.js';
import {
  collectPptxParagraphStyleChain,
  createPptxSlideInheritanceContext,
  pptxPlaceholderCategory,
  resolvePptxPlaceholderInheritance,
  resolvePptxThemeFontSet,
  type PptxInheritedShapeProperties,
  type PptxSlideInheritanceContext,
  type PptxThemeFontResolution,
} from '../style/inheritance.js';
import { PPTX_IMPORTER_VERSION } from '../version.js';
import { REACH_PPTX_FONT_CATALOG } from '../style/font-catalog.js';
import { resolvePptxCatalogFamily, type PptxFontCatalog } from '../style/fonts.js';

export const PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION = 'pptx-reach-deck-v2-mapping/v1' as const;

/** One package media part as the caller stored it. */
export interface PptxMediaUpload {
  objectKey: string;
  /** The stored bytes' content type, which normalization may have changed. */
  contentType: string;
}

export interface PptxReachDeckV2MapperOptions {
  documentId: string;
  /** Stable per confirmed apply operation; prevents collisions across repeated insertions. */
  applicationId: string;
  title: string;
  language: string;
  generatedAt: string;
  /** Explicit compatibility projection required by the Reach Deck document envelope. */
  compatibilityTheme: DeckTheme;
  /**
   * What the caller stored for each referenced media part path (e.g.
   * `/ppt/media/image1.png`). The caller owns upload and may normalize the
   * bytes on the way — an oversized PNG can land as a downscaled WebP — so the
   * stored content type, not the package part's, is what the document
   * references. A referenced part without an entry blocks the mapping.
   */
  mediaUploads?: Readonly<Record<string, PptxMediaUpload>>;
  /**
   * Font catalog the imported document is constrained to. Every run's typeface
   * resolves into this closed set — imported decks never depend on viewer
   * machine fonts. Defaults to the built-in Reach catalog.
   */
  fontCatalog?: PptxFontCatalog;
}

export interface PptxReachDeckV2PageReport {
  /** Stable page id the slide maps to (present even when the page is excluded). */
  pageId: string;
  /** Original slide order inside the PPTX (1-based). */
  sourceOrder: number;
  title: string;
  /**
   * ok — mapped losslessly; warning — mapped, but some content was dropped
   * (see diagnostics); error — the page could not be mapped and is excluded
   * from the candidate document.
   */
  status: 'ok' | 'warning' | 'error';
  diagnostics: readonly PptxDiagnostic[];
}

export interface PptxReachDeckV2MappingSuccess {
  ok: true;
  schemaVersion: typeof PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION;
  document: ReachDeckDocumentV2;
  /** One report per source slide, in source order. */
  pageReports: readonly PptxReachDeckV2PageReport[];
  /** All mapping diagnostics; empty means a lossless (clean) candidate. */
  diagnostics: readonly PptxDiagnostic[];
}

export interface PptxReachDeckV2MappingFailure {
  ok: false;
  schemaVersion: typeof PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION;
  diagnostics: readonly PptxDiagnostic[];
}

export type PptxReachDeckV2MappingResult =
  | PptxReachDeckV2MappingSuccess
  | PptxReachDeckV2MappingFailure;

interface MappingContext {
  ir: PptxPresentationIR;
  options: PptxReachDeckV2MapperOptions;
  diagnostics: PptxDiagnostic[];
  /** Media resources referenced by mapped pictures, keyed by media part path. */
  media: Map<string, ReachDeckMediaResourceV2>;
}

interface SlideContext extends MappingContext {
  slide: PptxSlideIR;
  inheritance: PptxSlideInheritanceContext;
  /**
   * Part whose XML is currently being mapped: the slide part for slide
   * content, the owning master/layout part for materialized decorations.
   * Relationship ids (r:embed) and diagnostic locations resolve against it —
   * a picture on a master must resolve through the master's .rels, not the
   * slide's.
   */
  sourcePartPath: string;
  /**
   * Stable-id components scoping mapped elements. Slide content is scoped by
   * the slide part alone; master/layout decorations add their owning part so
   * one shared decoration materialized onto many pages yields a distinct,
   * deterministic element id per page.
   */
  elementIdScope: readonly string[];
  /**
   * Fill declared on the nearest enclosing p:grpSp, already resolved past any
   * grpFill of its own. Children declaring a:grpFill paint with it; absent a
   * group fill they paint nothing (ECMA-376 §20.1.8.35).
   */
  groupFill?: PptxFillIR;
}

interface MappedSlide {
  slide: PptxSlideIR;
  background: ReachDeckFillV2;
  elements: ReachDeckNativeElementV2[];
  notes?: ReachDeckSpeakerNotesV2;
}

const PRESENTATION_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const CHART_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/chart',
  'http://purl.oclc.org/ooxml/drawingml/chart',
]);
const OFFICE_DOCUMENT_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const CHART_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/chart',
]);
const MARKUP_COMPATIBILITY_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/markup-compatibility/2006',
]);

/**
 * Elements whose entire subtree is ignorable: ECMA-376 extension points and
 * non-content chrome (custom-data references, slide transition animations)
 * that has no bearing on rendered page fidelity.
 */
const IGNORED_SUBTREES = new Set(['extLst', 'custDataLst', 'transition']);

/**
 * The Office 2010 drawing extension namespace, whose `a14:m` carries an
 * equation's OOXML math. The markup-compatibility resolution only elects that
 * branch when every equation inside converts to LaTeX, so by the time the
 * strict walk sees one the text projection has already consumed it.
 */
const OFFICE_MATH_WRAPPER_NAMESPACE = 'http://schemas.microsoft.com/office/drawing/2010/main';
const isOfficeMathWrapperElement = (element: PptxXmlElement): boolean =>
  element.namespaceUri === OFFICE_MATH_WRAPPER_NAMESPACE && localName(element.name) === 'm';

/**
 * The Office 2016 SVG extension. PowerPoint itself writes an SVG picture as a
 * raster fallback on `a:blip@r:embed` plus the vector under this extension, but
 * generators that only target modern renderers write the extension alone and
 * leave the blip bare. Reading it is what keeps those pictures from being
 * reported as having no image relationship at all.
 */
const SVG_BLIP_EXTENSION_URI = '{96DAC541-7B7A-43D3-8B79-37D633B846F1}';
const SVG_BLIP_NAMESPACE = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';

/**
 * The relationship id a blip's image comes from: its own `r:embed` when a
 * raster is present, otherwise the SVG extension's. The raster fallback wins
 * because it is what PowerPoint renders and what the package author chose.
 */
function blipEmbedRelationshipId(blip: PptxXmlElement | undefined): string | undefined {
  if (blip === undefined) return undefined;
  const embedId = blip.attributes['r:embed'];
  if (embedId !== undefined) return embedId;
  for (const extensions of drawingChildrenOf(blip)) {
    if (localName(extensions.name) !== 'extLst') continue;
    for (const extension of drawingChildrenOf(extensions)) {
      if (localName(extension.name) !== 'ext') continue;
      if (extension.attributes.uri !== SVG_BLIP_EXTENSION_URI) continue;
      for (const candidate of extension.children) {
        if (candidate.namespaceUri !== SVG_BLIP_NAMESPACE) continue;
        if (localName(candidate.name) !== 'svgBlip') continue;
        const svgEmbedId = candidate.attributes['r:embed'];
        if (svgEmbedId !== undefined) return svgEmbedId;
      }
    }
  }
  return undefined;
}

const ANY_ATTRIBUTES = Symbol('any-attributes');
type AttributeAllowance = ReadonlySet<string> | typeof ANY_ATTRIBUTES;

const STRICT_PRESENTATION_ELEMENTS = new Map<string, AttributeAllowance>([
  ['sld', new Set(['showMasterSp', 'showMasterPhAnim'])],
  ['cSld', new Set(['name'])],
  ['bg', new Set()],
  ['bgPr', new Set(['shadeToTitle'])],
  ['bgRef', new Set(['idx'])],
  ['spTree', new Set()],
  ['grpSp', new Set()],
  ['nvGrpSpPr', new Set()],
  ['cNvGrpSpPr', new Set()],
  ['grpSpPr', new Set(['bwMode'])],
  ['sp', new Set()],
  ['nvSpPr', new Set()],
  ['cNvPr', new Set(['id', 'name', 'descr', 'title', 'hidden'])],
  ['cNvSpPr', new Set(['txBox'])],
  ['nvPr', new Set()],
  ['ph', new Set(['type', 'idx', 'orient', 'sz', 'hasCustomPrompt'])],
  ['spPr', new Set(['bwMode'])],
  ['txBody', new Set()],
  ['style', new Set()],
  ['clrMapOvr', new Set()],
  ['cxnSp', new Set()],
  ['nvCxnSpPr', new Set()],
  ['cNvCxnSpPr', new Set()],
  ['pic', new Set()],
  ['nvPicPr', new Set()],
  ['cNvPicPr', new Set(['preferRelativeResize'])],
  ['blipFill', new Set(['rotWithShape', 'dpi'])],
  ['graphicFrame', new Set()],
  ['nvGraphicFramePr', new Set()],
  ['cNvGraphicFramePr', new Set()],
  // p:xfrm on graphic frames mirrors the drawing-ns transform attributes.
  ['xfrm', new Set(['rot', 'flipH', 'flipV'])],
  ['oleObj', new Set(['spid', 'name', 'r:id', 'imgW', 'imgH', 'progId', 'showAsIcon'])],
  ['embed', new Set(['followColorScheme'])],
  ['link', new Set(['updateAutomatic'])],
]);

const STRICT_DRAWING_ELEMENTS = new Map<string, AttributeAllowance>([
  ['xfrm', new Set(['rot', 'flipH', 'flipV'])],
  ['off', new Set(['x', 'y'])],
  ['ext', new Set(['cx', 'cy'])],
  ['chOff', new Set(['x', 'y'])],
  ['chExt', new Set(['cx', 'cy'])],
  ['prstGeom', new Set(['prst'])],
  ['graphic', new Set()],
  ['graphicData', new Set(['uri'])],
  ['graphicFrameLocks', ANY_ATTRIBUTES],
  ['avLst', new Set()],
  ['gd', new Set(['name', 'fmla'])],
  ['custGeom', new Set()],
  ['gdLst', new Set()],
  ['ahLst', new Set()],
  ['cxnLst', new Set()],
  ['cxn', new Set(['ang'])],
  ['pos', new Set(['x', 'y'])],
  ['rect', new Set(['l', 't', 'r', 'b'])],
  ['pathLst', new Set()],
  // extrusionOk only permits 3D extrusion, which the native model never applies.
  ['path', new Set(['w', 'h', 'extrusionOk', 'fill', 'stroke'])],
  ['moveTo', new Set()],
  ['lnTo', new Set()],
  ['cubicBezTo', new Set()],
  ['quadBezTo', new Set()],
  ['arcTo', new Set(['wR', 'hR', 'stAng', 'swAng'])],
  ['close', new Set()],
  ['pt', new Set(['x', 'y'])],
  ['blip', new Set(['r:embed', 'cstate'])],
  // 背景 blipFill 走 drawing ns（图片元素的 blipFill 在 presentation ns）。
  ['blipFill', new Set(['dpi', 'rotWithShape'])],
  // 空的亮度/效果节点无视觉语义；非空内容会被子元素白名单逮住。
  ['lum', new Set(['bright', 'contrast'])],
  ['effectLst', new Set()],
  // 原生映射的 shape 效果:外阴影与光晕(含其常见几何/对齐属性)。
  [
    'outerShdw',
    new Set(['blurRad', 'dist', 'dir', 'sx', 'sy', 'kx', 'ky', 'algn', 'rotWithShape']),
  ],
  ['glow', new Set(['rad'])],
  ['prstClr', new Set(['val'])],
  // 降级(advisory)效果与 3D 属性:主体照常映射,效果丢弃并发非阻断诊断。
  ['blur', ANY_ATTRIBUTES],
  ['fillOverlay', ANY_ATTRIBUTES],
  ['innerShdw', ANY_ATTRIBUTES],
  ['prstShdw', ANY_ATTRIBUTES],
  ['reflection', ANY_ATTRIBUTES],
  ['softEdge', ANY_ATTRIBUTES],
  ['effectDag', ANY_ATTRIBUTES],
  ['cont', ANY_ATTRIBUTES],
  ['scene3d', new Set()],
  ['camera', ANY_ATTRIBUTES],
  ['lightRig', ANY_ATTRIBUTES],
  ['backdrop', ANY_ATTRIBUTES],
  ['anchor', ANY_ATTRIBUTES],
  ['norm', ANY_ATTRIBUTES],
  ['up', ANY_ATTRIBUTES],
  ['rot', ANY_ATTRIBUTES],
  ['sp3d', ANY_ATTRIBUTES],
  ['bevelT', ANY_ATTRIBUTES],
  ['bevelB', ANY_ATTRIBUTES],
  ['extrusionClr', new Set()],
  ['contourClr', new Set()],
  ['stretch', new Set()],
  ['fillRect', new Set(['l', 't', 'r', 'b'])],
  ['srcRect', new Set(['l', 't', 'r', 'b'])],
  ['tile', new Set(['tx', 'ty', 'sx', 'sy', 'flip', 'algn'])],
  // 图片颜色调整:主体保留、调整降级为 advisory,不再触发 unknown-xml。
  ['duotone', new Set()],
  ['clrChange', new Set(['useA'])],
  ['clrFrom', new Set()],
  ['clrTo', new Set()],
  ['grayscl', new Set()],
  ['biLevel', new Set(['thresh'])],
  ['alphaModFix', new Set(['amt'])],
  ['picLocks', ANY_ATTRIBUTES],
  ['noFill', new Set()],
  ['solidFill', new Set()],
  // 子形状引用所属组合的填充;组合映射把该填充沿上下文传给子元素。
  ['grpFill', new Set()],
  ['gradFill', new Set(['flip', 'rotWithShape'])],
  ['gsLst', new Set()],
  ['gs', new Set(['pos'])],
  ['lin', new Set(['ang', 'scaled'])],
  ['srgbClr', new Set(['val'])],
  // scRGB 线性色在解析期换算为 sRGB。
  ['scrgbClr', new Set(['r', 'g', 'b'])],
  ['sysClr', new Set(['val', 'lastClr'])],
  ['schemeClr', new Set(['val'])],
  ['tint', new Set(['val'])],
  ['shade', new Set(['val'])],
  ['satMod', new Set(['val'])],
  ['satOff', new Set(['val'])],
  ['lumMod', new Set(['val'])],
  ['lumOff', new Set(['val'])],
  ['hueMod', new Set(['val'])],
  ['hueOff', new Set(['val'])],
  ['alpha', new Set(['val'])],
  ['alphaOff', new Set(['val'])],
  ['alphaMod', new Set(['val'])],
  ['ln', new Set(['w', 'cap', 'cmpd', 'algn'])],
  // 表格:a:tbl 网格/行/单元格与逐边框线(lnL/lnR/lnT/lnB 同 a:ln 内容模型)。
  ['tbl', new Set()],
  ['tblPr', new Set(['firstRow', 'lastRow', 'firstCol', 'lastCol', 'bandRow', 'bandCol', 'rtl'])],
  ['tableStyleId', new Set()],
  ['tblGrid', new Set()],
  ['gridCol', new Set(['w'])],
  ['tr', new Set(['h'])],
  ['tc', new Set(['gridSpan', 'rowSpan', 'hMerge', 'vMerge', 'id'])],
  [
    'tcPr',
    new Set(['marL', 'marR', 'marT', 'marB', 'anchor', 'anchorCtr', 'vert', 'horzOverflow']),
  ],
  ['lnL', new Set(['w', 'cap', 'cmpd', 'algn'])],
  ['lnR', new Set(['w', 'cap', 'cmpd', 'algn'])],
  ['lnT', new Set(['w', 'cap', 'cmpd', 'algn'])],
  ['lnB', new Set(['w', 'cap', 'cmpd', 'algn'])],
  ['lnTlToBr', new Set(['w', 'cap', 'cmpd', 'algn'])],
  ['lnBlToTr', new Set(['w', 'cap', 'cmpd', 'algn'])],
  // 单元格文本体是 a:txBody(sp 的 txBody 在 presentation ns)。
  ['txBody', new Set()],
  ['prstDash', new Set(['val'])],
  ['round', new Set()],
  ['bevel', new Set()],
  ['miter', new Set(['lim'])],
  ['headEnd', new Set(['type', 'w', 'len'])],
  ['tailEnd', new Set(['type', 'w', 'len'])],
  ['spLocks', ANY_ATTRIBUTES],
  ['grpSpLocks', ANY_ATTRIBUTES],
  ['cxnSpLocks', ANY_ATTRIBUTES],
  ['bodyPr', ANY_ATTRIBUTES],
  ['lstStyle', new Set()],
  ['defPPr', ANY_ATTRIBUTES],
  ...Array.from({ length: 9 }, (_, index) => {
    return [`lvl${index + 1}pPr`, ANY_ATTRIBUTES] as [string, AttributeAllowance];
  }),
  ['p', new Set()],
  ['pPr', ANY_ATTRIBUTES],
  ['r', new Set()],
  ['br', new Set()],
  ['fld', new Set(['id', 'type'])],
  ['rPr', ANY_ATTRIBUTES],
  ['endParaRPr', ANY_ATTRIBUTES],
  ['defRPr', ANY_ATTRIBUTES],
  ['t', new Set()],
  ['latin', ANY_ATTRIBUTES],
  ['ea', ANY_ATTRIBUTES],
  ['cs', ANY_ATTRIBUTES],
  ['sym', ANY_ATTRIBUTES],
  ['buNone', new Set()],
  ['buChar', new Set(['char'])],
  ['buAutoNum', new Set(['type', 'startAt'])],
  ['buFont', ANY_ATTRIBUTES],
  ['buSzPct', new Set(['val'])],
  ['buSzPts', new Set(['val'])],
  ['buClr', new Set()],
  // "Bullet follows text" markers are the OOXML defaults spelled out: the
  // shared rich-text list renders bullets in the paragraph's own font, size and
  // colour, so they carry no information the explicit buFont/buSz*/buClr
  // siblings (already accepted) would not.
  ['buFontTx', new Set()],
  ['buSzTx', new Set()],
  ['buClrTx', new Set()],
  // Underline fill/line "follow text" likewise match the CSS default.
  ['uFillTx', new Set()],
  ['uLnTx', new Set()],
  ['lnSpc', new Set()],
  ['spcBef', new Set()],
  ['spcAft', new Set()],
  ['spcPct', new Set(['val'])],
  ['spcPts', new Set(['val'])],
  ['tabLst', new Set()],
  ['tab', new Set(['pos', 'algn'])],
  ['noAutofit', new Set()],
  ['normAutofit', new Set(['fontScale', 'lnSpcReduction'])],
  ['spAutoFit', new Set()],
  ['lnRef', new Set(['idx'])],
  ['fillRef', new Set(['idx'])],
  ['effectRef', new Set(['idx'])],
  ['fontRef', new Set(['idx'])],
  ['masterClrMapping', new Set()],
  ['overrideClrMapping', ANY_ATTRIBUTES],
  ['stCxn', new Set(['id', 'idx'])],
  ['endCxn', new Set(['id', 'idx'])],
]);

/**
 * ECMA-376 Part 3 MCE containers. The parser already resolves expandable
 * mc:AlternateContent, so these only survive when no choice is understood and
 * no fallback exists; the container itself is then structurally valid while
 * its unsupported branch content still trips the element whitelists above.
 */
const STRICT_MARKUP_COMPATIBILITY_ELEMENTS = new Map<string, AttributeAllowance>([
  ['AlternateContent', new Set()],
  ['Choice', new Set(['Requires'])],
  ['Fallback', new Set()],
]);

const SUPPORTED_SHAPE_PRESETS = new Set([
  'rect',
  'roundRect',
  'ellipse',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow',
  'triangle',
  'rtTriangle',
  'diamond',
  'parallelogram',
  'trapezoid',
  'chevron',
  'star5',
  'round2DiagRect',
  'wedgeRectCallout',
  'wedgeRoundRectCallout',
  'leftBrace',
  'rightBrace',
  'bracketPair',
]);
const SUPPORTED_CONNECTOR_PRESETS = new Set([
  'line',
  'straightConnector1',
  'bentConnector2',
  'bentConnector3',
]);

/**
 * Native mapping slice targeting real-tool PPTX output: direct and
 * placeholder-inherited text/shape content, theme/master/layout style
 * resolution, solid and linear-gradient fills, straight connectors, freeform
 * custom geometry, and embedded raster pictures (via caller-supplied storage
 * keys).
 *
 * Mapping is per-page best-effort, never silent: unmappable elements are
 * dropped with diagnostics (page status `warning`); pages whose foundations
 * fail (missing XML, unresolvable background) are excluded with diagnostics
 * (page status `error`). The result only fails outright when no page can be
 * represented at all or the presentation itself is out of scope.
 */
export function mapPptxPresentationToReachDeckV2(
  ir: PptxPresentationIR,
  options: PptxReachDeckV2MapperOptions,
): PptxReachDeckV2MappingResult {
  const context: MappingContext = { ir, options, diagnostics: [], media: new Map() };
  validateOptions(context);
  if (context.diagnostics.length > 0) {
    return {
      ok: false,
      schemaVersion: PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      diagnostics: sortPptxDiagnostics(context.diagnostics),
    };
  }
  validatePackageScope(context);
  const stage = mapStage(context);
  const results = ir.slides.map((slide) => mapSlide(context, slide));
  const pageReports = results.map((result) => result.report);
  const included = results.filter(
    (result): result is MappedSlideResult & { mapped: MappedSlide } => result.mapped !== undefined,
  );
  // Page reports keep every per-page occurrence; the document list reports
  // each authored defect once.
  const diagnostics = sortPptxDiagnostics(dedupePptxDiagnostics(context.diagnostics));
  if (stage === undefined || included.length === 0 || ir.slides.length === 0) {
    return {
      ok: false,
      schemaVersion: PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      diagnostics,
    };
  }

  try {
    const document = buildDocument(
      context,
      stage,
      included.map((result) => result.mapped),
    );
    return {
      ok: true,
      schemaVersion: PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      document,
      pageReports,
      diagnostics,
    };
  } catch (error) {
    return {
      ok: false,
      schemaVersion: PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      diagnostics: sortPptxDiagnostics([
        ...diagnostics,
        diagnostic(
          'error',
          'pptx.mapper.invalid_reach_deck_candidate',
          'presentation',
          error instanceof Error ? error.message : 'Reach Deck candidate validation failed.',
          { partPath: ir.presentationPartPath },
        ),
      ]),
    };
  }
}

function validateOptions(context: MappingContext): void {
  for (const [field, value] of [
    ['documentId', context.options.documentId],
    ['applicationId', context.options.applicationId],
    ['title', context.options.title],
    ['language', context.options.language],
    ['generatedAt', context.options.generatedAt],
  ] as const) {
    if (value.trim().length === 0) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.invalid_options',
          'presentation',
          `${field} must be a non-empty deterministic mapper option.`,
          { partPath: context.ir.presentationPartPath },
          { field },
        ),
      );
    }
  }
}

/**
 * Package part kinds the mapper cannot render. Diagrams lose the graphic
 * frame that references them (the frame reports its own error);
 * embedded OLE payloads only lose the live object — PowerPoint stores a picture
 * fallback beside it, which the graphic-frame mapper imports.
 */
const BLOCKED_PART_KINDS = new Set(['diagram']);
const FALLBACK_PART_KINDS = new Set(['embedding']);

const OFFICE_DOCUMENT_RELATIONSHIP_NAMESPACE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * External relationship types that only cost behaviour: the element stays on the
 * page (hyperlinks lose the link, linked media keeps the poster picture
 * PowerPoint stores inside the package). Every other external target means the
 * referenced bytes are simply absent.
 */
const DEGRADING_EXTERNAL_RELATIONSHIP_TYPES = new Map<string, string>([
  [
    `${OFFICE_DOCUMENT_RELATIONSHIP_NAMESPACE}/hyperlink`,
    'External hyperlinks are dropped; the linked element renders without the link.',
  ],
  [
    `${OFFICE_DOCUMENT_RELATIONSHIP_NAMESPACE}/video`,
    'Linked video is not imported; the page keeps the poster picture stored in the package.',
  ],
  [
    `${OFFICE_DOCUMENT_RELATIONSHIP_NAMESPACE}/audio`,
    'Linked audio is not imported; the element it is attached to still renders.',
  ],
  [
    'http://schemas.microsoft.com/office/2007/relationships/media',
    'Linked media is not imported; the page keeps the poster picture stored in the package.',
  ],
]);

const relationshipKey = (relationship: PptxRelationshipIR): string =>
  `${relationship.source.partPath}#${relationship.id}`;

/**
 * External relationships referenced as `r:link` next to an `r:embed` on the same
 * element. PowerPoint writes the pair when a picture is copied from disk: the
 * bytes live in the package behind `r:embed` and `r:link` only records where they
 * came from (ECMA-376 §20.1.8.13), so nothing is missing from the import.
 */
function collectProvenanceExternalRelationships(ir: PptxPresentationIR): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const part of ir.parts) {
    if (part.xml === undefined) continue;
    const linkIds = new Set<string>();
    const visit = (element: PptxXmlElement): void => {
      const link = element.attributes['r:link'];
      if (link !== undefined && element.attributes['r:embed'] !== undefined) linkIds.add(link);
      for (const child of element.children) visit(child);
    };
    visit(part.xml);
    for (const id of linkIds) {
      const relationship = part.relationships.find((candidate) => candidate.id === id);
      if (relationship?.targetMode === 'external') keys.add(relationshipKey(relationship));
    }
  }
  return keys;
}

function validatePackageScope(context: MappingContext): void {
  if (context.ir.slides.length === 0) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.empty_presentation_unsupported',
        'presentation',
        'Reach Deck import requires at least one slide.',
        { partPath: context.ir.presentationPartPath },
      ),
    );
  }
  const provenanceRelationships = collectProvenanceExternalRelationships(context.ir);
  for (const relationship of context.ir.relationships) {
    if (relationship.targetMode !== 'external') continue;
    if (provenanceRelationships.has(relationshipKey(relationship))) continue;
    const degradedMessage = DEGRADING_EXTERNAL_RELATIONSHIP_TYPES.get(relationship.type);
    context.diagnostics.push(
      diagnostic(
        degradedMessage === undefined ? 'error' : 'warning',
        'pptx.mapper.external_relationship_unsupported',
        'relationship',
        degradedMessage ??
          'Externally linked content is not inside the package and cannot be imported.',
        relationship.source,
        { target: relationship.target, type: relationship.type },
      ),
    );
  }
  for (const part of context.ir.parts) {
    if (BLOCKED_PART_KINDS.has(part.kind)) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.package_part_unsupported',
          'unknown-ooxml',
          `${part.kind} package parts are outside the native mapping slice.`,
          { partPath: part.path },
          { contentType: part.contentType, kind: part.kind },
        ),
      );
    } else if (FALLBACK_PART_KINDS.has(part.kind)) {
      context.diagnostics.push(
        diagnostic(
          'info',
          'pptx.mapper.package_part_unsupported',
          'unknown-ooxml',
          `${part.kind} package parts are not imported as live objects; slides use the picture fallback stored beside them.`,
          { partPath: part.path },
          { contentType: part.contentType, kind: part.kind },
        ),
      );
    }
  }
}

interface NonPlaceholderDrawable {
  xml: PptxXmlElement;
  /** Document-order node path inside the owning part, for diagnostics/ids. */
  nodePath: string;
}

/**
 * Non-placeholder sp/pic/cxnSp/grpSp under a master/layout spTree. Placeholder
 * shapes stay out: their geometry/text reach slides through the existing
 * placeholder inheritance chain and must not be rendered twice.
 */
function nonPlaceholderDrawables(root: PptxXmlElement): NonPlaceholderDrawable[] {
  const commonSlideData = presentationChildren(root).find(
    (child) => localName(child.name) === 'cSld',
  );
  const shapeTree =
    commonSlideData &&
    presentationChildren(commonSlideData).find((child) => localName(child.name) === 'spTree');
  if (shapeTree === undefined) return [];
  const drawables: NonPlaceholderDrawable[] = [];
  const occurrences = new Map<string, number>();
  for (const child of shapeTree.children) {
    const name = localName(child.name);
    if (name === 'nvGrpSpPr' || name === 'grpSpPr' || IGNORED_SUBTREES.has(name)) continue;
    const occurrence = (occurrences.get(child.name) ?? 0) + 1;
    occurrences.set(child.name, occurrence);
    if (name === 'sp' || name === 'pic') {
      const nonVisual = presentationChildren(child).find((candidate) =>
        ['nvSpPr', 'nvPicPr'].includes(localName(candidate.name)),
      );
      const nvPr = nonVisual
        ? presentationChildren(nonVisual).find((candidate) => localName(candidate.name) === 'nvPr')
        : undefined;
      const hasPlaceholder =
        nvPr !== undefined &&
        presentationChildren(nvPr).some((candidate) => localName(candidate.name) === 'ph');
      if (hasPlaceholder) continue;
    }
    drawables.push({
      xml: child,
      nodePath: `/${root.name}/${commonSlideData!.name}/${shapeTree.name}/${child.name}[${occurrence}]`,
    });
  }
  return drawables;
}

function mapStage(context: MappingContext): ReachDeckDocumentV2['stage'] | undefined {
  const width = emuToReachDeckStagePoints(pptxEmu(context.ir.slideSize.widthEmu));
  const height = emuToReachDeckStagePoints(pptxEmu(context.ir.slideSize.heightEmu));
  if (width === undefined || height === undefined || width > 100_000 || height > 100_000) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.stage_unsupported',
        'presentation',
        'The mapper requires positive slide dimensions that resolve to whole points within Reach Deck limits.',
        { partPath: context.ir.presentationPartPath },
        { widthEmu: context.ir.slideSize.widthEmu, heightEmu: context.ir.slideSize.heightEmu },
      ),
    );
    return undefined;
  }
  const divisor = greatestCommonDivisor(width, height);
  return { width, height, aspectRatio: `${width / divisor}:${height / divisor}` };
}

interface MappedSlideResult {
  report: PptxReachDeckV2PageReport;
  mapped?: MappedSlide;
}

function mapSlide(context: MappingContext, slide: PptxSlideIR): MappedSlideResult {
  const before = context.diagnostics.length;
  const location = { partPath: slide.partPath, slideId: slide.id };
  const pageId = createStablePptxId('page', [
    context.options.applicationId,
    slide.partPath,
    slide.id,
  ]);
  const title = `Slide ${slide.order}`;
  const part = context.ir.parts.find((candidate) => candidate.path === slide.partPath);
  let mapped: MappedSlide | undefined;
  if (part?.xml === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.slide_xml_missing',
        'presentation',
        'The lossless slide XML sidecar is required for closed-world mapping.',
        location,
      ),
    );
  } else {
    const slideContext: SlideContext = {
      ...context,
      diagnostics: context.diagnostics,
      slide,
      inheritance: createPptxSlideInheritanceContext(context.ir, slide),
      sourcePartPath: slide.partPath,
      elementIdScope: [slide.partPath],
    };
    validateStrictSlideXml(slideContext, part.xml);
    validateSlideRootSemantics(slideContext, part.xml);
    const background = mapSlideBackground(slideContext, part.xml);
    // PowerPoint composites master decorations below layout decorations below
    // the slide's own shapes; materialized elements keep that z-order.
    const decorations = mapMasterLayoutDecorations(slideContext, part.xml);
    const elements = [
      ...decorations,
      ...slide.nodes.flatMap((node, index) => {
        const element = mapSlideNode(slideContext, node, decorations.length + index);
        return element === undefined ? [] : [element];
      }),
    ];
    const notes = mapSlideNotes(slideContext);
    // A background that cannot resolve is one lost element among the page's
    // content, not a reason to drop the page: the shapes and text on it are
    // what the teacher needs. The page keeps a plain surface, and the loss is
    // already on record from mapSlideBackground.
    mapped = {
      slide,
      background: background ?? {
        kind: 'solid',
        color: {
          kind: 'srgb',
          value: context.options.compatibilityTheme.background.toUpperCase(),
        },
      },
      elements,
      ...(notes === undefined ? {} : { notes }),
    };
  }
  const pageDiagnostics = sortPptxDiagnostics(context.diagnostics.slice(before));
  // Informational diagnostics describe dropped non-visual semantics; only a
  // degraded or lost element makes the page a warning.
  const degraded = pageDiagnostics.some((entry) => entry.severity !== 'info');
  return {
    report: {
      pageId,
      sourceOrder: slide.order,
      title,
      status: mapped === undefined ? 'error' : degraded ? 'warning' : 'ok',
      diagnostics: pageDiagnostics,
    },
    ...(mapped === undefined ? {} : { mapped }),
  };
}

/**
 * Identity under which one authored defect is reported once at document
 * level. Master/layout decorations are materialized onto every derived page,
 * so their diagnostics repeat per page with a different `slideId`; collapsing
 * on everything but the slide recovers the authored count. Slide-owned
 * diagnostics keep their part path and are therefore never merged across
 * pages.
 */
export function pptxDiagnosticIdentity(diagnostic: PptxDiagnostic): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.feature,
    diagnostic.message,
    diagnostic.location?.partPath ?? null,
    diagnostic.location?.nodePath ?? null,
    diagnostic.location?.relationshipId ?? null,
    diagnostic.details ?? null,
  ]);
}

/**
 * Collapse per-page repeats of the same inherited diagnostic. The surviving
 * entry drops `slideId` when it merged reports from more than one slide, so
 * it reads as a master/layout-level finding rather than one page's.
 */
export function dedupePptxDiagnostics(diagnostics: readonly PptxDiagnostic[]): PptxDiagnostic[] {
  const groups = new Map<string, { diagnostic: PptxDiagnostic; slideIds: Set<string> }>();
  for (const entry of diagnostics) {
    const identity = pptxDiagnosticIdentity(entry);
    const group = groups.get(identity);
    if (group === undefined) {
      groups.set(identity, {
        diagnostic: entry,
        slideIds: new Set(entry.location?.slideId === undefined ? [] : [entry.location.slideId]),
      });
      continue;
    }
    if (entry.location?.slideId !== undefined) group.slideIds.add(entry.location.slideId);
  }
  return [...groups.values()].map(({ diagnostic: entry, slideIds }) => {
    if (slideIds.size <= 1 || entry.location === undefined) return entry;
    const { slideId: _slideId, ...location } = entry.location;
    return { ...entry, location };
  });
}

/**
 * Materialize non-placeholder master/layout decorations (images, shapes,
 * connectors, groups) as per-page elements, master first so the caller can
 * assign them the lowest z indexes.
 *
 * showMasterSp semantics (ECMA-376 Part 1 §19.3.1.38 p:sld, §19.3.1.39
 * p:sldLayout — both define @showMasterSp as "specifies if shapes on the
 * master slide should be shown"): a slide's direct master is its layout,
 * which in turn derives from the slide master, so `p:sld/@showMasterSp="0"`
 * (PowerPoint's "Hide Background Graphics") suppresses the whole inherited
 * chain — layout and master decorations alike. `p:sldLayout/@showMasterSp="0"`
 * is evaluated from the layout's perspective, whose master is the slide
 * master: it suppresses only the master layer on pages derived from that
 * layout; the layout's own decorations are its content, not inherited ones.
 */
function mapMasterLayoutDecorations(
  context: SlideContext,
  slideRoot: PptxXmlElement,
): ReachDeckNativeElementV2[] {
  const { layout, master } = context.inheritance;
  const slideShowsInheritedShapes = slideRoot.attributes.showMasterSp !== '0';
  const layoutShowsMasterShapes = layout?.xml.attributes.showMasterSp !== '0';
  const elements: ReachDeckNativeElementV2[] = [];
  if (!slideShowsInheritedShapes) return elements;
  const layers = [
    ...(master !== undefined && layoutShowsMasterShapes
      ? [{ partPath: master.partPath, root: master.xml }]
      : []),
    ...(layout !== undefined ? [{ partPath: layout.partPath, root: layout.xml }] : []),
  ];
  for (const layer of layers) {
    const layerContext: SlideContext = {
      ...context,
      sourcePartPath: layer.partPath,
      elementIdScope: [context.slide.partPath, layer.partPath],
    };
    for (const drawable of nonPlaceholderDrawables(layer.root)) {
      const element = mapDecorationDrawable(layerContext, drawable, elements.length);
      if (element !== undefined) elements.push(element);
    }
  }
  return elements;
}

function mapDecorationDrawable(
  context: SlideContext,
  drawable: NonPlaceholderDrawable,
  index: number,
): ReachDeckNativeElementV2 | undefined {
  const name = localName(drawable.xml.name);
  if (name === 'sp') {
    const projected = projectPptxShapeElement(
      drawable.xml,
      createStablePptxId('node', [context.sourcePartPath, drawable.nodePath]),
      { partPath: context.sourcePartPath, nodePath: drawable.nodePath },
    );
    if (!projected.ok) {
      // Same degradation as group children: projection fatals become
      // element-dropping errors inside best-effort mapping.
      context.diagnostics.push(
        ...projected.diagnostics.map((entry) => ({ ...entry, severity: 'error' as const })),
      );
      return undefined;
    }
    return projected.node.kind === 'shape' ? mapShape(context, projected.node, index) : undefined;
  }
  if (name === 'cxnSp') return mapConnector(context, drawable.xml, index, drawable.nodePath);
  if (name === 'pic') return mapPicture(context, drawable.xml, index, drawable.nodePath);
  if (name === 'graphicFrame') {
    return mapGraphicFrame(context, drawable.xml, index, drawable.nodePath);
  }
  if (name === 'grpSp') return mapGroup(context, drawable.xml, drawable.nodePath, index, 1);
  context.diagnostics.push(
    diagnostic(
      'error',
      'pptx.mapper.unknown_node_unsupported',
      'unknown-ooxml',
      `${drawable.xml.name} is outside the native mapping slice.`,
      { partPath: context.sourcePartPath, slideId: context.slide.id, nodePath: drawable.nodePath },
    ),
  );
  return undefined;
}

function mapSlideNode(
  context: SlideContext,
  node: PptxSlideNodeIR,
  index: number,
): ReachDeckNativeElementV2 | undefined {
  if (node.kind === 'shape') return mapShape(context, node, index);
  if (localName(node.qualifiedName) === 'cxnSp') {
    return mapConnector(context, node.xml, index, node.source.nodePath);
  }
  if (localName(node.qualifiedName) === 'pic') {
    return mapPicture(context, node.xml, index, node.source.nodePath);
  }
  if (localName(node.qualifiedName) === 'graphicFrame') {
    return mapGraphicFrame(context, node.xml, index, node.source.nodePath);
  }
  if (localName(node.qualifiedName) === 'grpSp') {
    return mapGroup(
      context,
      node.xml,
      node.source.nodePath ?? `${node.qualifiedName}[${index + 1}]`,
      index,
      1,
    );
  }
  context.diagnostics.push(
    diagnostic(
      'error',
      'pptx.mapper.unknown_node_unsupported',
      'unknown-ooxml',
      `${node.qualifiedName} is outside the native mapping slice.`,
      { ...node.source, slideId: context.slide.id },
    ),
  );
  return undefined;
}

interface DroppedContentRule {
  /** `error` only where the understood content is itself lost (e.g. embedded video). */
  severity: 'info' | 'warning' | 'error';
  feature: PptxDiagnostic['feature'];
  message: string;
  /** Attribute values under which the element is a no-op and needs no diagnostic. */
  silentWhen?: (element: PptxXmlElement) => boolean;
}

/**
 * Drawing-namespace content the strict walk understands but the native model
 * cannot carry. Each entry reports once at its own severity instead of the
 * unknown-XML error, and its subtree is not walked further. Keys are either a
 * local name or `parent/local` when the same local name is native elsewhere
 * (`a:path` is a freeform path under `a:pathLst` but a gradient shape under
 * `a:gradFill`).
 */
const DROPPED_DRAWING_ELEMENTS = new Map<string, DroppedContentRule>([
  [
    'gradFill/path',
    {
      severity: 'warning',
      feature: 'shape',
      message:
        'Path (radial/rectangular) gradients are outside the native mapping slice; the fill renders as a linear gradient over the same stops.',
    },
  ],
  [
    'prstTxWarp',
    {
      severity: 'warning',
      feature: 'text-frame',
      message: 'Text warp presets are dropped; the text renders without the warp.',
      silentWhen: (element) =>
        element.attributes.prst === undefined ||
        element.attributes.prst === 'textNoShape' ||
        element.attributes.prst === 'textPlain',
    },
  ],
  [
    'hlinkClick',
    {
      severity: 'warning',
      feature: 'shape',
      message: 'Hyperlinks are dropped; the element renders without the link.',
    },
  ],
  [
    'hlinkHover',
    {
      severity: 'warning',
      feature: 'shape',
      message: 'Hyperlinks are dropped; the element renders without the link.',
    },
  ],
  [
    'hlinkMouseOver',
    {
      severity: 'warning',
      feature: 'shape',
      message: 'Hyperlinks are dropped; the element renders without the link.',
    },
  ],
  [
    'highlight',
    {
      severity: 'warning',
      feature: 'text-frame',
      message: 'Text highlight colors are dropped; the run renders without the highlight.',
    },
  ],
  [
    'videoFile',
    {
      severity: 'warning',
      feature: 'video',
      message:
        'Video playback is outside the native mapping slice; the page keeps the poster picture PowerPoint stores with it.',
    },
  ],
]);

/**
 * Attributes the strict walk understands but the native model drops, keyed
 * `local@attribute`. Unknown attributes outside this table stay errors.
 */
const DROPPED_ATTRIBUTES = new Map<string, DroppedContentRule>([
  [
    'sld@show',
    {
      severity: 'warning',
      feature: 'presentation',
      message: 'The slide is hidden in PowerPoint (show="0"); it imports as a visible page.',
      silentWhen: (element) => element.attributes.show !== '0',
    },
  ],
  [
    'blip@r:link',
    {
      severity: 'info',
      feature: 'image',
      // The embedded copy is what PowerPoint renders; when `r:embed` is absent the
      // picture mapper reports the unresolvable relationship itself.
      message:
        'The original file path the picture was copied from is ignored; the copy stored in the package is imported.',
    },
  ],
]);

/**
 * Slide-root subtrees `validateSlideRootSemantics` already reports once
 * (animation timelines); the strict walk must not report them a second time.
 */
const ROOT_REPORTED_SUBTREES = new Set(['timing']);

function validateStrictSlideXml(context: SlideContext, root: PptxXmlElement): void {
  const slide = context.slide;
  const walk = (
    element: PptxXmlElement,
    path: string,
    parent: PptxXmlElement | undefined,
  ): void => {
    const name = localName(element.name);
    const parentName = parent === undefined ? undefined : localName(parent.name);
    if (IGNORED_SUBTREES.has(name) || ROOT_REPORTED_SUBTREES.has(name)) return;
    if (isOfficeMathWrapperElement(element)) return;
    const isChartRelationshipReference =
      parent !== undefined &&
      parentName === 'graphicData' &&
      DRAWING_NAMESPACES.has(parent.namespaceUri ?? '') &&
      name === 'chart' &&
      CHART_NAMESPACES.has(element.namespaceUri ?? '') &&
      parent.attributes.uri === element.namespaceUri;
    const inDrawingNamespace = DRAWING_NAMESPACES.has(element.namespaceUri ?? '');
    const dropped = inDrawingNamespace
      ? (DROPPED_DRAWING_ELEMENTS.get(`${parentName ?? ''}/${name}`) ??
        DROPPED_DRAWING_ELEMENTS.get(name))
      : undefined;
    if (dropped !== undefined) {
      if (dropped.silentWhen?.(element) !== true) {
        context.diagnostics.push(
          diagnostic(
            dropped.severity,
            'pptx.mapper.unknown_xml_unsupported',
            dropped.feature,
            `${element.name}: ${dropped.message}`,
            { partPath: slide.partPath, slideId: slide.id, nodePath: path },
            { namespaceUri: element.namespaceUri ?? null },
          ),
        );
      }
      return;
    }
    const relationshipAttribute = isChartRelationshipReference
      ? relationshipIdAttributeEntry(element)
      : undefined;
    const allowedAttributes = isChartRelationshipReference
      ? new Set(relationshipAttribute === undefined ? [] : [relationshipAttribute[0]])
      : PRESENTATION_NAMESPACES.has(element.namespaceUri ?? '')
        ? STRICT_PRESENTATION_ELEMENTS.get(name)
        : inDrawingNamespace
          ? STRICT_DRAWING_ELEMENTS.get(name)
          : MARKUP_COMPATIBILITY_NAMESPACES.has(element.namespaceUri ?? '')
            ? STRICT_MARKUP_COMPATIBILITY_ELEMENTS.get(name)
            : undefined;
    if (allowedAttributes === undefined) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.unknown_xml_unsupported',
          'unknown-ooxml',
          `${element.name} is not part of the native mapping profile.`,
          { partPath: slide.partPath, slideId: slide.id, nodePath: path },
          { namespaceUri: element.namespaceUri ?? null },
        ),
      );
      return;
    }
    if (allowedAttributes !== ANY_ATTRIBUTES) {
      const unsupportedAttributes: string[] = [];
      const reportedRules = new Set<DroppedContentRule>();
      for (const attribute of Object.keys(element.attributes)) {
        if (
          attribute.startsWith('xmlns') ||
          // MCE control attributes (mc:Ignorable, …) are consumed by the
          // parser's AlternateContent resolution and carry no visual meaning.
          isMarkupCompatibilityAttribute(element, attribute) ||
          allowedAttributes.has(attribute)
        ) {
          continue;
        }
        const rule = DROPPED_ATTRIBUTES.get(`${name}@${attribute}`);
        if (rule === undefined) {
          unsupportedAttributes.push(attribute);
          continue;
        }
        if (reportedRules.has(rule) || rule.silentWhen?.(element) === true) continue;
        reportedRules.add(rule);
        context.diagnostics.push(
          diagnostic(
            rule.severity,
            'pptx.mapper.unknown_attribute_unsupported',
            rule.feature,
            `${element.name}@${attribute}: ${rule.message}`,
            { partPath: slide.partPath, slideId: slide.id, nodePath: path },
            { attributes: [attribute] },
          ),
        );
      }
      if (unsupportedAttributes.length > 0) {
        context.diagnostics.push(
          diagnostic(
            'error',
            'pptx.mapper.unknown_attribute_unsupported',
            featureForStrictElement(name),
            `${element.name} contains attributes outside the native mapping profile.`,
            { partPath: slide.partPath, slideId: slide.id, nodePath: path },
            { attributes: unsupportedAttributes.sort() },
          ),
        );
      }
    }
    const childIndexes = new Map<string, number>();
    for (const child of element.children) {
      const childName = child.name;
      const childIndex = (childIndexes.get(childName) ?? 0) + 1;
      childIndexes.set(childName, childIndex);
      walk(child, `${path}/${childName}[${childIndex}]`, element);
    }
  };
  walk(root, `/${root.name}[1]`, undefined);
}

const GEOMETRY_STRICT_ELEMENTS = new Set([
  'prstGeom',
  'avLst',
  'custGeom',
  'gdLst',
  'ahLst',
  'cxnLst',
  'rect',
  'pathLst',
  'path',
  'moveTo',
  'lnTo',
  'cubicBezTo',
  'quadBezTo',
  'arcTo',
  'close',
  'pt',
]);

function featureForStrictElement(name: string): PptxDiagnostic['feature'] {
  if (name === 'sld' || name === 'cSld') return 'presentation';
  if (name === 'chart') return 'chart';
  if (name === 'xfrm' || name === 'off' || name === 'ext') return 'transform';
  if (GEOMETRY_STRICT_ELEMENTS.has(name)) return 'geometry';
  return 'shape';
}

function validateSlideRootSemantics(context: SlideContext, root: PptxXmlElement): void {
  const slide = context.slide;
  const location = { partPath: slide.partPath, slideId: slide.id };
  for (const child of presentationChildren(root)) {
    const name = localName(child.name);
    if (name === 'cSld' || name === 'clrMapOvr' || IGNORED_SUBTREES.has(name)) continue;
    if (ROOT_REPORTED_SUBTREES.has(name)) {
      // Reach Deck has no animation timeline; dropping p:timing loses nothing
      // visible on the page, so it is informational rather than a defect.
      context.diagnostics.push(
        diagnostic(
          'info',
          'pptx.mapper.slide_semantics_unsupported',
          featureForSlideChild(child),
          `${child.name} animation timelines have no Reach Deck equivalent and are dropped; page content is unaffected.`,
          location,
        ),
      );
      continue;
    }
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.slide_semantics_unsupported',
        featureForSlideChild(child),
        `${child.name} is outside the native mapping slice.`,
        location,
      ),
    );
  }
  const commonSlideData = presentationChildren(root).filter(
    (child) => localName(child.name) === 'cSld',
  );
  if (commonSlideData.length !== 1) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.slide_structure_unsupported',
        'presentation',
        'A mapped slide requires exactly one p:cSld.',
        location,
      ),
    );
    return;
  }
  for (const child of presentationChildren(commonSlideData[0]!)) {
    const name = localName(child.name);
    if (name === 'bg' || name === 'spTree' || IGNORED_SUBTREES.has(name)) continue;
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.slide_semantics_unsupported',
        'unknown-ooxml',
        `${child.name} is outside the native mapping slice.`,
        location,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Background resolution (slide → layout → master, bgPr direct or bgRef matrix)
// ---------------------------------------------------------------------------

function mapSlideBackground(
  context: SlideContext,
  slideRoot: PptxXmlElement,
): ReachDeckFillV2 | undefined {
  const location = { partPath: context.slide.partPath, slideId: context.slide.id };
  const backgroundSources = [
    { root: slideRoot, partPath: context.slide.partPath },
    ...(context.inheritance.layout === undefined
      ? []
      : [{ root: context.inheritance.layout.xml, partPath: context.inheritance.layout.partPath }]),
    ...(context.inheritance.master === undefined
      ? []
      : [{ root: context.inheritance.master.xml, partPath: context.inheritance.master.partPath }]),
  ];
  for (const source of backgroundSources) {
    const commonSlideData = presentationChildren(source.root).find(
      (child) => localName(child.name) === 'cSld',
    );
    const background =
      commonSlideData &&
      presentationChildren(commonSlideData).find((child) => localName(child.name) === 'bg');
    if (!background) continue;
    return resolveBackgroundElement(context, background, source.partPath, {
      ...location,
      nodePath: source.partPath,
    });
  }
  // No explicit background anywhere in the chain: OOXML renders bg1; decks
  // without a theme color scheme fall back to the compatibility background.
  const themeBackground = resolvePptxColor(
    { kind: 'scheme', token: 'bg1', modifiers: [] },
    context.inheritance.schemeContext,
  );
  return {
    kind: 'solid',
    color: {
      kind: 'srgb',
      value: themeBackground.ok
        ? themeBackground.color.hex
        : context.options.compatibilityTheme.background,
    },
  };
}

function resolveBackgroundElement(
  context: SlideContext,
  background: PptxXmlElement,
  ownerPartPath: string,
  location: { partPath: string; slideId?: string; nodePath?: string },
): ReachDeckFillV2 | undefined {
  const properties = presentationChildren(background).find(
    (child) => localName(child.name) === 'bgPr',
  );
  if (properties !== undefined) {
    const blipFill = drawingChildrenOf(properties).find(
      (child) => localName(child.name) === 'blipFill',
    );
    if (blipFill !== undefined) {
      return resolveBackgroundImage(context, blipFill, ownerPartPath, location);
    }
    let fill: PptxFillIR | undefined;
    try {
      fill = directFillOf(properties);
    } catch (error) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.background_fill_unsupported',
          'shape',
          error instanceof Error ? error.message : 'Background fill is invalid.',
          location,
        ),
      );
      return undefined;
    }
    if (fill === undefined) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.background_fill_unsupported',
          'shape',
          'bgPr requires an explicit fill.',
          location,
        ),
      );
      return undefined;
    }
    return resolveFillIr(context, fill, location, 'background');
  }
  const reference = presentationChildren(background).find(
    (child) => localName(child.name) === 'bgRef',
  );
  if (reference !== undefined) {
    return resolveStyleMatrixFill(context, reference, location, 'background');
  }
  context.diagnostics.push(
    diagnostic(
      'error',
      'pptx.mapper.background_inheritance_unsupported',
      'layout',
      'Background must declare bgPr or bgRef.',
      location,
    ),
  );
  return undefined;
}

/**
 * Map a `p:bgPr/a:blipFill` image background to a v2 image fill. Only the
 * plain full-bleed slice is native: an embedded raster (png/jpeg/webp)
 * stretched over the page without crop, tile, color adjustment or effects.
 */
function resolveBackgroundImage(
  context: SlideContext,
  blipFill: PptxXmlElement,
  ownerPartPath: string,
  location: { partPath: string; slideId?: string; nodePath?: string },
): ReachDeckFillV2 | undefined {
  const block = (message: string): undefined => {
    context.diagnostics.push(
      diagnostic('error', 'pptx.mapper.background_fill_unsupported', 'shape', message, location),
    );
    return undefined;
  };
  return resolveBlipFillImage(context, blipFill, ownerPartPath, location, {
    subject: 'Background',
    block,
    // 背景平铺无原生渲染路径,保持整页阻断而不是猜测铺贴。
    allowTile: false,
  });
}

/**
 * PPT `a:tile` defaults per ECMA-376: origin at the shape's top-left, native
 * scale, no mirroring. Only this identity form maps to the v2 `tile` mode; any
 * offset/scale/flip variant renders differently and stays blocked.
 */
const IDENTITY_TILE_ATTRIBUTES: Readonly<Record<string, string>> = {
  tx: '0',
  ty: '0',
  sx: '100000',
  sy: '100000',
  flip: 'none',
  algn: 'tl',
};

/**
 * Shared native slice for `a:blipFill` image fills (slide backgrounds and
 * shape fills): an embedded raster stretched over — or identity-tiled across —
 * the fill box, without crop, color adjustment or effects.
 */
function resolveBlipFillImage(
  context: SlideContext,
  blipFill: PptxXmlElement,
  ownerPartPath: string,
  location: { partPath: string; slideId?: string; nodePath?: string },
  options: { subject: string; block: (message: string) => undefined; allowTile: boolean },
): ReachDeckFillV2 | undefined {
  const { subject, block, allowTile } = options;
  let insets: { left: number; top: number; right: number; bottom: number } | undefined;
  const blip = drawingChildrenOf(blipFill).find((child) => localName(child.name) === 'blip');
  const embedId = blipEmbedRelationshipId(blip);
  if (blip === undefined || embedId === undefined) {
    return block(`${subject} image requires an embedded relationship.`);
  }
  // a:lum 等空调整节点无视觉效果；带属性或其他调整则超出原生切片。
  for (const adjustment of blip.children) {
    const name = localName(adjustment.name);
    if (IGNORED_SUBTREES.has(name)) continue;
    if (name === 'lum' && Object.keys(adjustment.attributes).length === 0) continue;
    return block(`${subject} image color/effect adjustments are outside the native mapping slice.`);
  }
  // 无 stretch/tile 子节点时 PowerPoint 以拉伸填充渲染。
  let mode: 'stretch' | 'tile' = 'stretch';
  for (const child of drawingChildrenOf(blipFill)) {
    const name = localName(child.name);
    if (name === 'blip' || IGNORED_SUBTREES.has(name)) continue;
    if (name === 'stretch') {
      const fillRect = drawingChildrenOf(child).find(
        (entry) => localName(entry.name) === 'fillRect',
      );
      const offsets: Partial<Record<'l' | 't' | 'r' | 'b', number>> = {};
      for (const [attribute, value] of Object.entries(fillRect?.attributes ?? {})) {
        if (attribute.startsWith('xmlns')) continue;
        const parsed = Number.parseInt(value, 10);
        if (
          !Number.isSafeInteger(parsed) ||
          (attribute !== 'l' && attribute !== 't' && attribute !== 'r' && attribute !== 'b')
        ) {
          return block(`${subject} stretch offsets are outside the native mapping slice.`);
        }
        const fraction = round(parsed / 100_000);
        // 亚千分位偏移无可见效果,归零以保留纯拉伸快速路径。
        if (Math.abs(fraction) >= 0.001) offsets[attribute] = fraction;
      }
      if (Object.keys(offsets).length > 0) {
        const left = offsets.l ?? 0;
        const top = offsets.t ?? 0;
        const right = offsets.r ?? 0;
        const bottom = offsets.b ?? 0;
        // 与 DSL 校验一致的边界:出血不超过 10 倍盒宽,内缩不吃掉可见区。
        if (
          [left, top, right, bottom].some((offset) => offset <= -10 || offset >= 1) ||
          left + right >= 1 ||
          top + bottom >= 1
        ) {
          return block(`${subject} stretch offsets are outside the native mapping slice.`);
        }
        insets = { left, top, right, bottom };
      }
      continue;
    }
    if (name === 'srcRect') {
      const offsets = Object.keys(child.attributes).filter(
        (attribute) => !attribute.startsWith('xmlns') && child.attributes[attribute] !== '0',
      );
      if (offsets.length > 0) {
        return block(`${subject} image cropping is outside the native mapping slice.`);
      }
      continue;
    }
    if (name === 'tile') {
      const nonIdentity = Object.entries(child.attributes).filter(
        ([attribute, value]) =>
          !attribute.startsWith('xmlns') && IDENTITY_TILE_ATTRIBUTES[attribute] !== value,
      );
      if (!allowTile || nonIdentity.length > 0) {
        return block(
          allowTile
            ? `${subject} tile offset/scale/flip variants are outside the native mapping slice.`
            : `Tiled image backgrounds are outside the native mapping slice.`,
        );
      }
      mode = 'tile';
      continue;
    }
    return block(`${subject} ${child.name} fill content is outside the native mapping slice.`);
  }
  const resourceId = resolveEmbeddedMediaResource(context, embedId, ownerPartPath, location, {
    subject,
    block,
  });
  if (resourceId === undefined) return undefined;
  return {
    kind: 'image',
    resourceId,
    mode,
    ...(insets === undefined || mode !== 'stretch' ? {} : { insets }),
  };
}

/**
 * Resolve a blip `r:embed` against the owning part's relationships down to an
 * uploaded media resource id, registering the media resource on first use.
 * Emits diagnostics (via `block` or the object-key advisory) and returns
 * undefined when the image cannot back a native element.
 */
function resolveEmbeddedMediaResource(
  context: SlideContext,
  embedId: string,
  ownerPartPath: string,
  location: { partPath: string; slideId?: string; nodePath?: string },
  options: { subject: string; block: (message: string) => undefined },
): string | undefined {
  const { subject, block } = options;
  const ownerPart = context.ir.parts.find((candidate) => candidate.path === ownerPartPath);
  const relationship = ownerPart?.relationships.find((candidate) => candidate.id === embedId);
  if (relationship === undefined || relationship.targetMode !== 'internal') {
    block(`${subject} image relationship could not be resolved inside the package.`);
    return undefined;
  }
  const mediaPart = context.ir.parts.find((candidate) => candidate.path === relationship.target);
  if (mediaPart === undefined || mediaPart.kind !== 'media') {
    block(`${subject} image part is missing from the package inventory.`);
    return undefined;
  }
  const upload = context.options.mediaUploads?.[mediaPart.path];
  if (upload === undefined || upload.objectKey.trim().length === 0) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.media_object_key_missing',
        'image',
        `No storage object key was provided for this ${subject.toLowerCase()} image; the caller must upload package media before mapping.`,
        { ...location, nodePath: mediaPart.path },
      ),
    );
    return undefined;
  }
  // The stored type is what the document points at: callers may normalize a
  // package asset the native model could not carry into one it can.
  if (!SUPPORTED_IMAGE_CONTENT_TYPES.has(upload.contentType)) {
    block(`${subject} content type ${upload.contentType} is outside the native mapping slice.`);
    return undefined;
  }
  const resourceId = createStablePptxId('media', [context.options.applicationId, mediaPart.path]);
  if (!context.media.has(mediaPart.path)) {
    // The native model carries rasters only, so vector art arrives already
    // rasterized. Note it once per asset: nothing is lost on the page, but the
    // picture no longer scales the way the source did.
    if (
      VECTOR_IMAGE_CONTENT_TYPES.has(mediaPart.contentType.toLowerCase()) &&
      upload.contentType !== mediaPart.contentType
    ) {
      context.diagnostics.push(
        diagnostic(
          'info',
          'pptx.mapper.vector_image_rasterized',
          'image',
          `${subject} vector image was rasterized to ${upload.contentType}; it renders as imported rather than at any zoom.`,
          { ...location, nodePath: mediaPart.path },
          { sourceContentType: mediaPart.contentType, storedContentType: upload.contentType },
        ),
      );
    }
    context.media.set(mediaPart.path, {
      id: resourceId,
      objectKey: upload.objectKey,
      contentType: upload.contentType,
      digest: mediaPart.digest,
    });
  }
  return resourceId;
}

/** Resolve a fillRef/bgRef against the theme format scheme with phClr substitution. */
function resolveStyleMatrixFill(
  context: SlideContext,
  reference: PptxXmlElement,
  location: { partPath: string; slideId?: string; nodePath?: string },
  label: string,
): ReachDeckFillV2 | undefined {
  const index = Number.parseInt(reference.attributes.idx ?? '0', 10);
  if (!Number.isSafeInteger(index) || index === 0 || index === 1000) return { kind: 'none' };
  const scheme = context.inheritance.formatScheme;
  const entry =
    index >= 1001 ? scheme.backgroundFillStyles[index - 1001] : scheme.fillStyles[index - 1];
  if (entry === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.style_matrix_unsupported',
        'theme',
        `${label} references style matrix fill ${index} which the theme does not define.`,
        location,
      ),
    );
    return undefined;
  }
  const placeholderColor = resolveReferenceColor(context, reference, location);
  if (placeholderColor === undefined) return undefined;
  let fill: PptxFillIR;
  try {
    fill = parsePptxFillElement(entry);
  } catch (error) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.style_matrix_unsupported',
        'theme',
        error instanceof Error ? error.message : 'Theme style matrix fill is invalid.',
        location,
      ),
    );
    return undefined;
  }
  return resolveFillIr(context, fill, location, label, placeholderColor);
}

function resolveReferenceColor(
  context: SlideContext,
  reference: PptxXmlElement,
  location: { partPath: string; slideId?: string; nodePath?: string },
): PptxResolvedColor | undefined {
  let color: PptxColorIR;
  try {
    color = parsePptxColorContainer(reference);
  } catch {
    // A style reference without a color child contributes no phClr value.
    return { hex: '#000000', alpha: 1 };
  }
  const resolved = resolvePptxColor(color, context.inheritance.schemeContext);
  if (!resolved.ok) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.scheme_color_unsupported',
        'theme',
        resolved.reason,
        location,
      ),
    );
    return undefined;
  }
  return resolved.color;
}

function resolveFillIr(
  context: SlideContext,
  fill: PptxFillIR,
  location: { partPath: string; slideId?: string; nodePath?: string },
  label: string,
  placeholderColor?: PptxResolvedColor,
): ReachDeckFillV2 | undefined {
  if (fill.kind === 'none') return { kind: 'none' };
  if (fill.kind === 'unsupported') {
    if (fill.fillType === 'grpFill') {
      // 引用组合填充:有则沿用组合的填充,无则等价 noFill。
      return context.groupFill === undefined
        ? { kind: 'none' }
        : resolveFillIr(context, context.groupFill, location, label, placeholderColor);
    }
    const block = (message: string): undefined => {
      context.diagnostics.push(
        diagnostic('error', 'pptx.mapper.fill_unsupported', 'shape', message, location),
      );
      return undefined;
    };
    if (fill.fillType === 'blipFill' && fill.xml !== undefined) {
      // r:embed 相对元素所属 part 的 .rels 解析;location.partPath 即该 part
      // (母版/版式装饰物化时为 master/layout part)。
      return resolveBlipFillImage(context, fill.xml, location.partPath, location, {
        subject: `${label[0]?.toUpperCase()}${label.slice(1)} fill`,
        block,
        allowTile: true,
      });
    }
    return block(`${fill.fillType} fill is outside the native mapping slice for ${label}.`);
  }
  if (fill.kind === 'solid') {
    const color = resolveColorIr(context, fill.color, location, placeholderColor);
    return color === undefined ? undefined : { kind: 'solid', color };
  }
  const stops: { offset: number; color: ReachDeckColorV2 }[] = [];
  for (const stop of fill.stops) {
    const color = resolveColorIr(context, stop.color, location, placeholderColor);
    if (color === undefined) return undefined;
    stops.push({ offset: clamp01(ooxmlPercentageToRatio(stop.position)), color });
  }
  stops.sort((left, right) => left.offset - right.offset);
  // OOXML linear angle 0 points left-to-right growing clockwise; CSS 0deg
  // points bottom-to-top. Both convert via +90deg.
  const angle = fill.angle === undefined ? 180 : (ooxmlAngleToDegrees(fill.angle) + 90 + 360) % 360;
  return { kind: 'gradient', angle: round(angle), stops };
}

function resolveColorIr(
  context: SlideContext,
  color: PptxColorIR,
  location: { partPath: string; slideId?: string; nodePath?: string },
  placeholderColor?: PptxResolvedColor,
): Extract<ReachDeckColorV2, { kind: 'srgb' }> | undefined {
  const resolved = resolvePptxColor(color, context.inheritance.schemeContext, {
    ...(placeholderColor === undefined ? {} : { placeholderColor }),
  });
  if (!resolved.ok) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.scheme_color_unsupported',
        'theme',
        resolved.reason,
        location,
      ),
    );
    return undefined;
  }
  return {
    kind: 'srgb',
    value: resolved.color.hex,
    ...(resolved.color.alpha >= 1 ? {} : { alpha: round(resolved.color.alpha) }),
  };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface ShapeStyleReferences {
  fillReference?: PptxXmlElement;
  lineReference?: PptxXmlElement;
  effectReference?: PptxXmlElement;
  fontReference?: PptxXmlElement;
}

function parseStyleReferences(styleXml: PptxXmlElement | undefined): ShapeStyleReferences {
  const references: ShapeStyleReferences = {};
  for (const child of styleXml?.children ?? []) {
    switch (localName(child.name)) {
      case 'fillRef':
        references.fillReference = child;
        break;
      case 'lnRef':
        references.lineReference = child;
        break;
      case 'effectRef':
        references.effectReference = child;
        break;
      case 'fontRef':
        references.fontReference = child;
        break;
    }
  }
  return references;
}

function mapShape(
  context: SlideContext,
  node: PptxShapeNodeIR,
  index: number,
): ReachDeckNativeElementV2 | undefined {
  const location = { ...node.source, slideId: context.slide.id };
  const before = context.diagnostics.length;
  const inherited: PptxInheritedShapeProperties =
    node.placeholder === undefined
      ? { bodyProperties: [], listStyles: [] }
      : resolvePptxPlaceholderInheritance(context.inheritance, node.placeholder);

  const presetName =
    node.geometry === undefined
      ? inherited.presetGeometry?.attributes.prst
      : node.geometry.kind === 'preset'
        ? node.geometry.preset
        : undefined;
  if (presetName === 'line') return mapShapeAsLine(context, node, inherited, index);

  const transform = resolveShapeTransform(context, node, inherited, location);
  const geometry = resolveShapeGeometry(context, node, inherited, location, transform);
  const references = parseStyleReferences(node.styleXml);
  const effectsXml = node.directStyle?.effectsXml ?? inherited.style?.effectsXml;
  const effects = resolveElementEffects(
    context,
    effectsXml,
    references.effectReference,
    location,
    'shape',
  );
  reportResidualEffects(context, node.xml, effectsXml, location, 'shape');
  const style = resolveShapeStyle(context, node, inherited, references, location);
  const text =
    node.text === undefined
      ? undefined
      : mapTextFrame(context, node, inherited, references, location);
  if (
    hasBlockingPptxDiagnostics(context.diagnostics.slice(before)) ||
    transform === undefined ||
    geometry === undefined
  ) {
    return undefined;
  }
  return {
    id: createStablePptxId('native-element', [
      context.options.applicationId,
      ...context.elementIdScope,
      node.id,
    ]),
    type: 'shape',
    transform,
    zIndex: index + 1,
    ...(node.nonVisual.name.trim() ? { name: node.nonVisual.name } : {}),
    ...(node.nonVisual.hidden ? { hidden: true } : {}),
    ...(node.nonVisual.description?.trim() ? { ariaLabel: node.nonVisual.description } : {}),
    source: {
      partPath: node.source.partPath,
      sourceId: node.nonVisual.sourceId,
    },
    geometry,
    style: { ...(style ?? {}), ...(effects === undefined ? {} : { effects }) },
    ...(text === undefined ? {} : { text }),
  };
}

/**
 * p:sp with prstGeom prst="line" is a straight line drawn across the shape
 * box diagonal (honouring flips) — not a fillable outline geometry. Mapping
 * it onto the native line element keeps the hundreds of engineering-deck rule
 * lines the shape path previously dropped as unsupported preset geometry.
 */
function mapShapeAsLine(
  context: SlideContext,
  node: PptxShapeNodeIR,
  inherited: PptxInheritedShapeProperties,
  index: number,
): ReachDeckLineElementV2 | undefined {
  const location = { ...node.source, slideId: context.slide.id };
  const before = context.diagnostics.length;
  let resolved: PptxResolvedTransform2D | undefined = node.directTransform;
  if (resolved === undefined && inherited.transform !== undefined) {
    resolved = parseTransformElement(inherited.transform);
  }
  if (resolved === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.inherited_shape_semantics_unsupported',
        'shape',
        'No direct or placeholder-inherited transform is available for this line shape.',
        location,
      ),
    );
    return undefined;
  }
  const references = parseStyleReferences(node.styleXml);
  const stroke = resolveShapeStroke(
    context,
    node.directStyle?.stroke ?? inherited.style?.stroke,
    references.lineReference,
    location,
  );
  if (stroke === null || hasBlockingPptxDiagnostics(context.diagnostics.slice(before))) {
    return undefined;
  }
  if (stroke === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.preset_geometry_unsupported',
        'geometry',
        'Line shapes require a resolvable stroke.',
        location,
      ),
    );
    return undefined;
  }
  // 线元素模型不含效果与文字:降级为 advisory,不丢线本体。
  reportResidualEffects(context, node.xml, undefined, location, 'shape');
  if (node.text !== undefined && node.text.paragraphs.some((p) => p.runs.length > 0)) {
    context.diagnostics.push({
      code: 'pptx.mapper.text_unsupported',
      severity: 'warning',
      feature: 'text-frame',
      message: 'Text attached to a line shape is dropped; the line renders without it.',
      location,
    });
  }
  const lineElement =
    node.shapePropertiesXml &&
    drawingChildrenOf(node.shapePropertiesXml).find((child) => localName(child.name) === 'ln');
  const headMarker = mapLineMarker(lineElement, 'headEnd');
  const tailMarker = mapLineMarker(lineElement, 'tailEnd');
  const x = round(emuToPoints(pptxEmu(resolved.source.offset.x.raw)));
  const y = round(emuToPoints(pptxEmu(resolved.source.offset.y.raw)));
  const rawWidth = round(emuToPoints(pptxEmu(resolved.source.extent.width.raw)));
  const rawHeight = round(emuToPoints(pptxEmu(resolved.source.extent.height.raw)));
  // 盒子下限只防零尺寸;组内子元素还要过 scaleIntoGroupSpace 的坐标缩放,
  // 更大的下限(如 1pt)会在微小本地单位空间里被缩放放大成上千 pt 的盒子。
  const width = Math.max(rawWidth, 0.01);
  const height = Math.max(rawHeight, 0.01);
  const startX = resolved.flipHorizontal ? rawWidth : 0;
  const endX = resolved.flipHorizontal ? 0 : rawWidth;
  const startY = resolved.flipVertical ? rawHeight : 0;
  const endY = resolved.flipVertical ? 0 : rawHeight;
  return {
    id: createStablePptxId('native-element', [
      context.options.applicationId,
      ...context.elementIdScope,
      node.id,
    ]),
    type: 'line',
    transform: {
      x,
      y,
      width,
      height,
      ...(resolved.rotationDegrees === 0 ? {} : { rotation: resolved.rotationDegrees }),
    },
    zIndex: index + 1,
    ...(node.nonVisual.name.trim() ? { name: node.nonVisual.name } : {}),
    ...(node.nonVisual.hidden ? { hidden: true } : {}),
    ...(node.nonVisual.description?.trim() ? { ariaLabel: node.nonVisual.description } : {}),
    source: {
      partPath: node.source.partPath,
      sourceId: node.nonVisual.sourceId,
    },
    start: { x: startX, y: startY, ...(headMarker === undefined ? {} : { marker: headMarker }) },
    end: { x: endX, y: endY, ...(tailMarker === undefined ? {} : { marker: tailMarker }) },
    routing: 'straight',
    connector: false,
    stroke,
  };
}

function resolveShapeTransform(
  context: SlideContext,
  node: PptxShapeNodeIR,
  inherited: PptxInheritedShapeProperties,
  location: { partPath: string; slideId?: string; nodePath?: string },
): ReachDeckNativeElementV2['transform'] | undefined {
  let resolved: PptxResolvedTransform2D | undefined = node.directTransform;
  if (resolved === undefined && inherited.transform !== undefined) {
    resolved = parseTransformElement(inherited.transform);
  }
  if (resolved === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.inherited_shape_semantics_unsupported',
        'shape',
        'No direct or placeholder-inherited transform is available for this shape.',
        location,
      ),
    );
    return undefined;
  }
  return toDslTransform(resolved);
}

function toDslTransform(transform: PptxResolvedTransform2D): ReachDeckNativeElementV2['transform'] {
  return {
    x: round(emuToPoints(pptxEmu(transform.source.offset.x.raw))),
    y: round(emuToPoints(pptxEmu(transform.source.offset.y.raw))),
    width: Math.max(round(emuToPoints(pptxEmu(transform.source.extent.width.raw))), 0.01),
    height: Math.max(round(emuToPoints(pptxEmu(transform.source.extent.height.raw))), 0.01),
    ...(transform.rotationDegrees === 0 ? {} : { rotation: transform.rotationDegrees }),
    ...(transform.flipHorizontal ? { flipHorizontal: true } : {}),
    ...(transform.flipVertical ? { flipVertical: true } : {}),
  };
}

function parseTransformElement(transform: PptxXmlElement): PptxResolvedTransform2D | undefined {
  const offset = drawingChildrenOf(transform).find((child) => localName(child.name) === 'off');
  const extent = drawingChildrenOf(transform).find((child) => localName(child.name) === 'ext');
  if (
    offset?.attributes.x === undefined ||
    offset.attributes.y === undefined ||
    extent?.attributes.cx === undefined ||
    extent.attributes.cy === undefined
  ) {
    return undefined;
  }
  return resolvePptxTransform2D({
    offset: { x: pptxEmu(offset.attributes.x), y: pptxEmu(offset.attributes.y) },
    extent: { width: pptxEmu(extent.attributes.cx), height: pptxEmu(extent.attributes.cy) },
    rotation: pptxAngle(transform.attributes.rot ?? '0'),
    flipHorizontal: transform.attributes.flipH === '1' || transform.attributes.flipH === 'true',
    flipVertical: transform.attributes.flipV === '1' || transform.attributes.flipV === 'true',
  });
}

function resolveShapeGeometry(
  context: SlideContext,
  node: PptxShapeNodeIR,
  inherited: PptxInheritedShapeProperties,
  location: { partPath: string; slideId?: string; nodePath?: string },
  transform: ReachDeckNativeElementV2['transform'] | undefined,
): Extract<ReachDeckNativeElementV2, { type: 'shape' }>['geometry'] | undefined {
  let preset: string | undefined;
  let adjustments: Readonly<Record<string, string>> = {};
  if (node.geometry !== undefined) {
    if (node.geometry.kind !== 'preset') {
      // A missing transform already blocked the shape; the coordinate space
      // needed to normalize the path is gone, so skip without double-reporting.
      if (transform === undefined) return undefined;
      return mapCustomGeometry(context, node.geometry.xml, transform, location);
    }
    preset = node.geometry.preset;
    adjustments = node.geometry.adjustments;
  } else if (inherited.presetGeometry?.attributes.prst !== undefined) {
    preset = inherited.presetGeometry.attributes.prst;
  } else {
    // Placeholders without any declared geometry are rectangles per OOXML.
    preset = 'rect';
  }
  return resolvePresetGeometry(context, preset, adjustments, transform, location);
}

/** Preset geometry shared by shapes and geometry-clipped pictures. */
function resolvePresetGeometry(
  context: SlideContext,
  preset: string,
  adjustments: Readonly<Record<string, string>>,
  transform: ReachDeckNativeElementV2['transform'] | undefined,
  location: { partPath: string; slideId?: string; nodePath?: string },
): Extract<ReachDeckNativeElementV2, { type: 'shape' }>['geometry'] | undefined {
  const numericAdjustments: Record<string, number> = {};
  for (const [name, formula] of Object.entries(adjustments)) {
    const match = /^val (-?\d+)$/.exec(formula);
    if (!match) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.geometry_adjustments_unsupported',
          'geometry',
          `Geometry adjustment formula ${formula} is outside the native mapping slice.`,
          location,
        ),
      );
      return undefined;
    }
    numericAdjustments[name] = Number.parseInt(match[1]!, 10);
  }
  if (!SUPPORTED_SHAPE_PRESETS.has(preset)) {
    return mapStandardPresetGeometry(context, preset, numericAdjustments, transform, location);
  }
  return {
    kind: 'preset',
    preset,
    ...(Object.keys(numericAdjustments).length === 0 ? {} : { adjustments: numericAdjustments }),
  };
}

/** DrawingML path commands inside the native slice, with their pt arity. */
const CUSTOM_GEOMETRY_COMMANDS: Readonly<
  Record<string, { letter: 'M' | 'L' | 'C' | 'Q' | 'Z'; points: number }>
> = {
  moveTo: { letter: 'M', points: 1 },
  lnTo: { letter: 'L', points: 1 },
  cubicBezTo: { letter: 'C', points: 3 },
  quadBezTo: { letter: 'Q', points: 2 },
  close: { letter: 'Z', points: 0 },
};

const GEOMETRY_PATH_FILLS = new Set<PptxGeometryPathFill>([
  'none',
  'norm',
  'lighten',
  'lightenLess',
  'darken',
  'darkenLess',
]);

/** `a:path@fill` values whose face shading the native model cannot express. */
const SHADED_GEOMETRY_FILLS = new Set<PptxGeometryPathFill>([
  'lighten',
  'lightenLess',
  'darken',
  'darkenLess',
]);

/** Text rectangles are compared in points, where a full-bounds edge is exact. */
const GEOMETRY_BOUNDS_EPSILON = 0.001;
const EMU_PER_POINT = 12_700;

/**
 * Outline a preset the native element model has no renderer for, by evaluating
 * the preset shape definition published with the OOXML standard
 * (§20.1.9.18) into the element's own coordinate space. The shape keeps its
 * exact outline, fill and stroke; what it loses is the preset identity (adjust
 * handles, and formula re-evaluation on resize), so this reports info instead of
 * dropping the element.
 */
function mapStandardPresetGeometry(
  context: SlideContext,
  preset: string,
  adjustments: Readonly<Record<string, number>>,
  transform: ReachDeckNativeElementV2['transform'] | undefined,
  location: { partPath: string; slideId?: string; nodePath?: string },
): Extract<ReachDeckNativeElementV2, { type: 'shape' }>['geometry'] | undefined {
  const subpaths =
    transform === undefined
      ? undefined
      : buildPptxPresetShapeGeometry(preset, adjustments, {
          width: transform.width,
          height: transform.height,
        });
  if (transform === undefined || subpaths === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.preset_geometry_unsupported',
        'geometry',
        `Preset geometry ${preset} is outside the native mapping slice.`,
        location,
      ),
    );
    return undefined;
  }
  context.diagnostics.push(
    diagnostic(
      'info',
      'pptx.mapper.preset_geometry_outlined',
      'geometry',
      `Preset geometry ${preset} has no native preset; it imports as the outline the OOXML standard defines for it.`,
      location,
    ),
  );
  if (subpaths.some((subpath) => SHADED_GEOMETRY_FILLS.has(subpath.fill))) {
    context.diagnostics.push(
      diagnostic(
        'warning',
        'pptx.mapper.preset_geometry_simplified',
        'geometry',
        `Preset geometry ${preset} shades individual faces; every face imports with the shape fill.`,
        location,
      ),
    );
  }
  return customGeometryFromSubpaths(subpaths, transform);
}

/**
 * Collapse emitted subpaths into the v2 custom geometry. `path` stays the filled
 * outline — what clips an image fill — and per-subpath paint modes only ride
 * along when a subpath deviates from the element's own fill and stroke.
 */
function customGeometryFromSubpaths(
  subpaths: readonly PptxGeometrySubpath[],
  extent: { width: number; height: number },
): Extract<ReachDeckNativeElementV2, { type: 'shape' }>['geometry'] {
  const painted = subpaths.map((subpath) => ({
    path: subpath.path,
    filled: subpath.fill !== 'none',
    stroked: subpath.stroked,
  }));
  const filled = painted.filter((subpath) => subpath.filled);
  const outline = (filled.length > 0 ? filled : painted).map((subpath) => subpath.path).join(' ');
  const plain = painted.length === 1 && painted[0]!.filled && painted[0]!.stroked;
  return {
    kind: 'custom',
    viewBox: { width: extent.width, height: extent.height },
    path: outline,
    ...(plain
      ? {}
      : {
          subpaths: painted.map((subpath) => ({
            path: subpath.path,
            ...(subpath.filled ? {} : { fillMode: 'none' as const }),
            ...(subpath.stroked ? {} : { stroked: false }),
          })),
        }),
  };
}

/**
 * Parse one `a:path` into the shared command form, keeping coordinates as guide
 * tokens so the emitter resolves them against the shape's guide list.
 */
function parseCustomGeometryPath(
  element: PptxXmlElement,
  block: (message: string) => undefined,
): PptxGeometryPath | undefined {
  const children = element.children.filter((child) => !IGNORED_SUBTREES.has(localName(child.name)));
  if (children.length === 0 || localName(children[0]!.name) !== 'moveTo') {
    return block('Custom geometry paths must begin with moveTo.');
  }
  const commands: PptxGeometryPathCommand[] = [];
  for (const command of children) {
    const name = localName(command.name);
    if (name === 'arcTo') {
      const { wR, hR, stAng, swAng } = command.attributes;
      if (wR === undefined || hR === undefined || stAng === undefined || swAng === undefined) {
        return block('Custom geometry a:arcTo requires wR, hR, stAng and swAng.');
      }
      commands.push(['A', wR, hR, stAng, swAng]);
      continue;
    }
    const shape = CUSTOM_GEOMETRY_COMMANDS[name];
    if (shape === undefined) {
      return block(`Custom geometry ${command.name} is outside the native mapping slice.`);
    }
    const points = command.children.filter((child) => !IGNORED_SUBTREES.has(localName(child.name)));
    if (points.length !== shape.points || points.some((point) => localName(point.name) !== 'pt')) {
      return block(`Custom geometry ${command.name} requires exactly ${shape.points} points.`);
    }
    const coordinates: string[] = [];
    for (const point of points) {
      const { x, y } = point.attributes;
      if (x === undefined || y === undefined) {
        return block('Custom geometry point coordinates are invalid.');
      }
      coordinates.push(x, y);
    }
    switch (shape.letter) {
      case 'M':
      case 'L':
        commands.push([shape.letter, coordinates[0]!, coordinates[1]!]);
        break;
      case 'Q':
        commands.push(['Q', coordinates[0]!, coordinates[1]!, coordinates[2]!, coordinates[3]!]);
        break;
      case 'C':
        commands.push([
          'C',
          coordinates[0]!,
          coordinates[1]!,
          coordinates[2]!,
          coordinates[3]!,
          coordinates[4]!,
          coordinates[5]!,
        ]);
        break;
      case 'Z':
        commands.push(['Z']);
        break;
    }
  }
  const { w, h, fill, stroke } = element.attributes;
  if (fill !== undefined && !GEOMETRY_PATH_FILLS.has(fill as PptxGeometryPathFill)) {
    return block(`Custom geometry path fill ${fill} is outside the native mapping slice.`);
  }
  return {
    ...(w === undefined ? {} : { w }),
    ...(h === undefined ? {} : { h }),
    ...(fill === undefined ? {} : { fill: fill as PptxGeometryPathFill }),
    ...(stroke === '0' || stroke === 'false' ? { stroke: false } : {}),
    commands,
  };
}

/**
 * Map a:custGeom to the v2 custom geometry: paths of line, Bézier and arc
 * commands — in their declared coordinate space, or the shape's own EMU space
 * when a:path omits w/h or sets them to 0 — normalized into the element box so the stored
 * SVG paths render 1:1 inside the transform. Coordinates resolve through the
 * shape's guide list; adjust handles and connection sites are rendering-neutral
 * and are ignored; text rectangles must evaluate to the full shape bounds or the
 * geometry blocks.
 */
function mapCustomGeometry(
  context: SlideContext,
  xml: PptxXmlElement,
  transform: ReachDeckNativeElementV2['transform'],
  location: { partPath: string; slideId?: string; nodePath?: string },
): Extract<ReachDeckNativeElementV2, { type: 'shape' }>['geometry'] | undefined {
  const block = (message: string): undefined => {
    context.diagnostics.push(
      diagnostic('error', 'pptx.mapper.custom_geometry_unsupported', 'geometry', message, location),
    );
    return undefined;
  };
  let pathList: PptxXmlElement | undefined;
  let guideList: PptxXmlElement | undefined;
  let textRectangle: PptxXmlElement | undefined;
  for (const child of xml.children) {
    const name = localName(child.name);
    if (IGNORED_SUBTREES.has(name)) continue;
    switch (name) {
      case 'avLst':
      case 'ahLst':
      case 'cxnLst':
        // Adjust values, handles and connection sites cannot affect the painted
        // path: the path coordinates reference gdLst guides, never these lists.
        break;
      case 'gdLst':
        guideList = child;
        break;
      case 'rect':
        textRectangle = child;
        break;
      case 'pathLst':
        pathList = child;
        break;
      default:
        return block(`Custom geometry ${child.name} is outside the native mapping slice.`);
    }
  }
  const extent = { width: transform.width, height: transform.height };
  // DrawingML built-in guides always use the shape's EMU dimensions, even
  // when an individual path declares a different coordinate space.
  const shapeSpace = {
    width: extent.width * EMU_PER_POINT,
    height: extent.height * EMU_PER_POINT,
  };
  const formulas = new Map<string, string>();
  for (const guide of guideList?.children ?? []) {
    if (localName(guide.name) !== 'gd') continue;
    const { name: guideName, fmla } = guide.attributes;
    if (guideName !== undefined && fmla !== undefined) formulas.set(guideName, fmla);
  }
  const guides = createPptxGeometryGuides(shapeSpace, formulas);
  if (textRectangle !== undefined) {
    // Only the full-bounds text rectangle keeps text layout unchanged; legacy
    // freeforms express it through gdLst guides ("*/ n w n"), so evaluate the
    // references in the shape's own space before comparing.
    const edges = {
      l: guides.resolve(textRectangle.attributes.l),
      t: guides.resolve(textRectangle.attributes.t),
      r: guides.resolve(textRectangle.attributes.r),
      b: guides.resolve(textRectangle.attributes.b),
    };
    const near = (value: number | undefined, expected: number): boolean =>
      value !== undefined && Math.abs(value - expected) <= GEOMETRY_BOUNDS_EPSILON * EMU_PER_POINT;
    if (
      !near(edges.l, 0) ||
      !near(edges.t, 0) ||
      !near(edges.r, shapeSpace.width) ||
      !near(edges.b, shapeSpace.height)
    ) {
      return block('Custom geometry text rectangles are outside the native mapping slice.');
    }
  }
  const pathElements = (pathList?.children ?? []).filter(
    (child) => localName(child.name) === 'path',
  );
  if (pathElements.length === 0) {
    return block('Custom geometry requires at least one explicit path.');
  }
  // Each path axis scales independently. Absent/zero w or h uses the shape's
  // EMU dimension on that axis; a declared dimension scales path coordinates
  // into the output box without changing how shape guides are evaluated.
  const subpaths: PptxGeometrySubpath[] = [];
  for (const element of pathElements) {
    const spaceWidth = guides.resolve(element.attributes.w);
    const spaceHeight = guides.resolve(element.attributes.h);
    if (
      (element.attributes.w !== undefined && (spaceWidth === undefined || spaceWidth < 0)) ||
      (element.attributes.h !== undefined && (spaceHeight === undefined || spaceHeight < 0))
    ) {
      return block('Custom geometry path coordinate space is invalid.');
    }
    const parsed = parseCustomGeometryPath(element, block);
    if (parsed === undefined) return undefined;
    const widthFromShape = spaceWidth === undefined || spaceWidth === 0;
    const heightFromShape = spaceHeight === undefined || spaceHeight === 0;
    const emitted = emitPptxGeometryPath(
      {
        ...parsed,
        ...(widthFromShape ? { w: String(shapeSpace.width) } : {}),
        ...(heightFromShape ? { h: String(shapeSpace.height) } : {}),
      },
      extent,
      guides,
    );
    if (emitted === undefined) return block('Custom geometry point coordinates are invalid.');
    subpaths.push({
      path: emitted,
      fill: parsed.fill ?? 'norm',
      stroked: parsed.stroke !== false,
    });
  }
  return customGeometryFromSubpaths(subpaths, extent);
}

function referencedEffectIndex(reference: PptxXmlElement | undefined): number {
  if (reference === undefined) return 0;
  const index = Number.parseInt(reference.attributes.idx ?? '0', 10);
  return Number.isSafeInteger(index) ? index : 0;
}

/**
 * Effects never block: an element keeps its mapped body even when its effects
 * cannot be represented. Dropped effects surface as warning-severity
 * diagnostics so audits see the loss without `hasBlockingPptxDiagnostics`
 * treating it as an apply blocker.
 */
function effectAdvisory(
  feature: PptxDiagnostic['feature'],
  message: string,
  location: PptxDiagnostic['location'],
): PptxDiagnostic {
  return {
    code: 'pptx.mapper.effects_unsupported',
    severity: 'warning',
    feature,
    message,
    location,
  };
}

function resolveEffectColor(
  context: SlideContext,
  container: PptxXmlElement,
  placeholderColor?: PptxResolvedColor,
): Extract<ReachDeckColorV2, { kind: 'srgb' }> | undefined {
  let color: PptxColorIR;
  try {
    color = parsePptxColorContainer(container);
  } catch {
    return undefined;
  }
  const resolved = resolvePptxColor(color, context.inheritance.schemeContext, {
    ...(placeholderColor === undefined ? {} : { placeholderColor }),
  });
  if (!resolved.ok) return undefined;
  return {
    kind: 'srgb',
    value: resolved.color.hex,
    ...(resolved.color.alpha >= 1 ? {} : { alpha: round(resolved.color.alpha) }),
  };
}

/** a:outerShdw → DSL shadow. blurRad/dist are EMU→pt; dir is 1/60000° clockwise from east. */
function mapOuterShadowEffect(
  context: SlideContext,
  xml: PptxXmlElement,
  placeholderColor: PptxResolvedColor | undefined,
  advisory: (message: string) => void,
): ReachDeckEffectsV2['shadow'] | undefined {
  const color = resolveEffectColor(context, xml, placeholderColor);
  if (color === undefined) {
    advisory('Outer shadow color could not be resolved; the shadow was dropped.');
    return undefined;
  }
  let blur: number;
  let distance: number;
  let angle: number;
  try {
    blur =
      xml.attributes.blurRad === undefined
        ? 0
        : round(emuToPoints(pptxEmu(xml.attributes.blurRad)));
    distance =
      xml.attributes.dist === undefined ? 0 : round(emuToPoints(pptxEmu(xml.attributes.dist)));
    angle =
      xml.attributes.dir === undefined
        ? 0
        : round(ooxmlAngleToDegrees(pptxAngle(xml.attributes.dir)));
  } catch {
    advisory('Outer shadow geometry attributes are invalid; the shadow was dropped.');
    return undefined;
  }
  if (blur < 0 || distance < 0) {
    advisory('Outer shadow geometry attributes are invalid; the shadow was dropped.');
    return undefined;
  }
  return { color, blur, distance, angle };
}

/** a:glow → DSL glow. rad is EMU→pt. */
function mapGlowEffect(
  context: SlideContext,
  xml: PptxXmlElement,
  placeholderColor: PptxResolvedColor | undefined,
  advisory: (message: string) => void,
): ReachDeckEffectsV2['glow'] | undefined {
  const color = resolveEffectColor(context, xml, placeholderColor);
  if (color === undefined) {
    advisory('Glow color could not be resolved; the glow was dropped.');
    return undefined;
  }
  let radius: number;
  try {
    radius = xml.attributes.rad === undefined ? 0 : round(emuToPoints(pptxEmu(xml.attributes.rad)));
  } catch {
    advisory('Glow radius is invalid; the glow was dropped.');
    return undefined;
  }
  if (radius < 0) {
    advisory('Glow radius is invalid; the glow was dropped.');
    return undefined;
  }
  return { color, radius };
}

/**
 * Resolve an element's effect list into the DSL effects model: outerShdw and
 * glow map natively; every other effect (inner shadow, reflection, soft edge,
 * preset shadow, effect graphs, theme entries that cannot be resolved) is
 * dropped with a warning-severity advisory. The element body is never blocked
 * here.
 *
 * Direct effects (spPr/grpSpPr effectLst) take precedence over the theme
 * effect style referenced by p:style/a:effectRef, mirroring OOXML precedence.
 */
function resolveElementEffects(
  context: SlideContext,
  effectsXml: PptxXmlElement | undefined,
  effectReference: PptxXmlElement | undefined,
  location: { partPath: string; slideId?: string; nodePath?: string },
  feature: PptxDiagnostic['feature'],
): ReachDeckEffectsV2 | undefined {
  const advisory = (message: string): void => {
    context.diagnostics.push(effectAdvisory(feature, message, location));
  };
  let source = effectsXml;
  let placeholderColor: PptxResolvedColor | undefined;
  if (source === undefined) {
    const index = referencedEffectIndex(effectReference);
    if (index <= 0) return undefined;
    const themeEffect = context.inheritance.formatScheme.effectStyles[index - 1];
    if (themeEffect === undefined) {
      advisory(`Theme effect style ${index} is not defined by the theme; effects were dropped.`);
      return undefined;
    }
    for (const child of drawingChildrenOf(themeEffect)) {
      const name = localName(child.name);
      if (name === 'effectLst' || name === 'effectDag') {
        source = child;
      } else if (!IGNORED_SUBTREES.has(name)) {
        advisory(`Theme effect ${child.name} is dropped; the element renders without it.`);
      }
    }
    if (source === undefined) return undefined;
    // effectRef's color child substitutes phClr inside the theme effect style;
    // a reference without one simply contributes no placeholder color.
    placeholderColor = undefined;
    try {
      const referenceColor = parsePptxColorContainer(effectReference!);
      const resolved = resolvePptxColor(referenceColor, context.inheritance.schemeContext);
      if (resolved.ok) placeholderColor = resolved.color;
    } catch {
      placeholderColor = undefined;
    }
  }
  if (localName(source.name) !== 'effectLst') {
    advisory(`${source.name} composite effects are dropped; the element renders without them.`);
    return undefined;
  }
  let shadow: ReachDeckEffectsV2['shadow'] | undefined;
  let glow: ReachDeckEffectsV2['glow'] | undefined;
  for (const child of drawingChildrenOf(source)) {
    const name = localName(child.name);
    if (IGNORED_SUBTREES.has(name)) continue;
    if (name === 'outerShdw' && shadow === undefined) {
      shadow = mapOuterShadowEffect(context, child, placeholderColor, advisory);
      continue;
    }
    if (name === 'glow' && glow === undefined) {
      glow = mapGlowEffect(context, child, placeholderColor, advisory);
      continue;
    }
    advisory(`${child.name} effect is dropped; the element renders without it.`);
  }
  if (shadow === undefined && glow === undefined) return undefined;
  return { ...(shadow === undefined ? {} : { shadow }), ...(glow === undefined ? {} : { glow }) };
}

const RESIDUAL_EFFECT_ELEMENTS = new Set(['effectLst', 'effectDag', 'scene3d', 'sp3d']);

/**
 * Advisories for effect content the direct/inherited resolution did not
 * consume: text-run effect lists, 3D scene/shape properties, and any other
 * nested effect list inside the element subtree. Warning severity only —
 * these never drop the element.
 */
function reportResidualEffects(
  context: SlideContext,
  xml: PptxXmlElement,
  handled: PptxXmlElement | undefined,
  location: { partPath: string; slideId?: string; nodePath?: string },
  feature: PptxDiagnostic['feature'],
): void {
  const walk = (element: PptxXmlElement): void => {
    for (const child of element.children) {
      const name = localName(child.name);
      if (IGNORED_SUBTREES.has(name) || child === handled) continue;
      if (RESIDUAL_EFFECT_ELEMENTS.has(name)) {
        const inert =
          name === 'effectLst' &&
          child.children.every((entry) => IGNORED_SUBTREES.has(localName(entry.name)));
        if (!inert) {
          context.diagnostics.push(
            effectAdvisory(
              feature,
              `${child.name} effects are dropped; the element renders without them.`,
              location,
            ),
          );
        }
        continue;
      }
      walk(child);
    }
  };
  walk(xml);
}

function resolveShapeStyle(
  context: SlideContext,
  node: PptxShapeNodeIR,
  inherited: PptxInheritedShapeProperties,
  references: ShapeStyleReferences,
  location: { partPath: string; slideId?: string; nodePath?: string },
): { fill?: ReachDeckFillV2; stroke?: ReachDeckStrokeV2 } | undefined {
  // Fill precedence: direct > style matrix fillRef > placeholder-inherited > none.
  let fill: ReachDeckFillV2 | undefined;
  if (node.directStyle?.fill !== undefined) {
    fill = resolveFillIr(context, node.directStyle.fill, location, 'shape');
    if (fill === undefined) return undefined;
  } else if (references.fillReference !== undefined) {
    fill = resolveStyleMatrixFill(context, references.fillReference, location, 'shape');
    if (fill === undefined) return undefined;
  } else if (inherited.style?.fill !== undefined) {
    fill = resolveFillIr(context, inherited.style.fill, location, 'shape');
    if (fill === undefined) return undefined;
  } else {
    fill = { kind: 'none' };
  }

  const stroke = resolveShapeStroke(
    context,
    node.directStyle?.stroke ?? inherited.style?.stroke,
    references.lineReference,
    location,
  );
  if (stroke === null) return undefined;
  return {
    fill,
    ...(stroke === undefined ? {} : { stroke }),
  };
}

/** Returns undefined for "no stroke", null for "blocked". */
function resolveShapeStroke(
  context: SlideContext,
  direct: PptxStrokeIR | undefined,
  lineReference: PptxXmlElement | undefined,
  location: { partPath: string; slideId?: string; nodePath?: string },
): ReachDeckStrokeV2 | undefined | null {
  const referenceIndex =
    lineReference === undefined ? 0 : Number.parseInt(lineReference.attributes.idx ?? '0', 10) || 0;
  let themeStroke: PptxStrokeIR | undefined;
  if (referenceIndex > 0) {
    const themeLine = context.inheritance.formatScheme.lineStyles[referenceIndex - 1];
    if (themeLine !== undefined) {
      try {
        themeStroke = parsePptxStrokeElement(themeLine);
      } catch {
        themeStroke = undefined;
      }
    }
  }
  if (direct === undefined && themeStroke === undefined) return undefined;
  if (direct?.fill?.kind === 'none') return undefined;

  const placeholderColor =
    lineReference === undefined
      ? undefined
      : resolveReferenceColor(context, lineReference, location);
  if (lineReference !== undefined && placeholderColor === undefined) return null;

  const strokeFill = direct?.fill ?? themeStroke?.fill;
  let color: Extract<ReachDeckColorV2, { kind: 'srgb' }> | undefined;
  if (strokeFill === undefined || strokeFill.kind === 'none') {
    return undefined;
  } else if (strokeFill.kind === 'solid') {
    color = resolveColorIr(context, strokeFill.color, location, placeholderColor);
    if (color === undefined) return null;
  } else {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.stroke_unsupported',
        'shape',
        'Only solid stroke fills are inside the native mapping slice.',
        location,
      ),
    );
    return null;
  }

  const widthEmu: PptxEmu | undefined = direct?.width ?? themeStroke?.width;
  // OOXML default stroke width when omitted is 9525 EMU (0.75pt).
  const rawWidth = widthEmu === undefined ? 0.75 : emuToPoints(widthEmu);
  if (rawWidth < 0 || !Number.isFinite(rawWidth)) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.stroke_unsupported',
        'shape',
        'Stroke width is invalid.',
        location,
      ),
    );
    return null;
  }
  if (rawWidth === 0) {
    // Preserve elements whose native model requires a stroke (lines and
    // connectors included) without turning a disabled outline into a visible
    // line. This also keeps optional shape, picture and table borders valid.
    context.diagnostics.push(
      diagnostic(
        'warning',
        'pptx.mapper.stroke_simplified',
        'shape',
        'Zero-width outline imports as invisible; producer-specific hairline rendering is not preserved.',
        location,
      ),
    );
    return { width: 0.75, fill: { ...color, alpha: 0 } };
  }
  // Positive widths must stay positive even below the normal rounding precision.
  const width = round(rawWidth) || rawWidth;
  const dashToken = direct?.dash ?? themeStroke?.dash;
  let dash = dashToken === undefined ? undefined : mapDash(dashToken);
  if (dashToken !== undefined && dash === undefined) {
    // A dash pattern the native model lacks is a styling difference, not a
    // missing element: approximate it and keep the stroke.
    dash = approximateDash(dashToken);
    context.diagnostics.push(
      diagnostic(
        'warning',
        'pptx.mapper.stroke_simplified',
        'shape',
        `Stroke dash ${dashToken} has no native equivalent; the stroke renders as ${dash}.`,
        location,
      ),
    );
  }
  const cap = mapCap(direct?.cap ?? themeStroke?.cap);
  return {
    width,
    fill: color,
    ...(dash === undefined || dash === 'solid' ? {} : { dash }),
    ...(cap === undefined ? {} : { cap }),
    ...((direct?.join ?? themeStroke?.join) === undefined
      ? {}
      : { join: (direct?.join ?? themeStroke?.join)! }),
  };
}

function mapDash(token: string): ReachDeckStrokeV2['dash'] | undefined {
  switch (token) {
    case 'solid':
      return 'solid';
    case 'dot':
    case 'sysDot':
      return 'dot';
    case 'dash':
    case 'sysDash':
      return 'dash';
    case 'dashDot':
    case 'sysDashDot':
      return 'dashDot';
    case 'lgDash':
      return 'longDash';
    default:
      return undefined;
  }
}

/**
 * Nearest native dash for the compound OOXML patterns the model lacks
 * (`lgDashDot`, `lgDashDotDot`, `sysDashDotDot`). Chosen by the pattern's
 * dominant segment so the stroke keeps reading as dashed rather than solid.
 */
function approximateDash(token: string): NonNullable<ReachDeckStrokeV2['dash']> {
  if (token.startsWith('lgDash')) return 'longDash';
  if (token.includes('DashDot')) return 'dashDot';
  if (token.includes('Dash') || token.includes('dash')) return 'dash';
  if (token.includes('Dot') || token.includes('dot')) return 'dot';
  return 'solid';
}

function mapCap(token: string | undefined): ReachDeckStrokeV2['cap'] | undefined {
  switch (token) {
    case 'flat':
      return 'flat';
    case 'rnd':
      return 'round';
    case 'sq':
      return 'square';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

interface RawConnectorTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

/** Connectors permit zero-length extents (horizontal/vertical lines). */
function parseConnectorTransform(transform: PptxXmlElement): RawConnectorTransform | undefined {
  const offset = drawingChildrenOf(transform).find((child) => localName(child.name) === 'off');
  const extent = drawingChildrenOf(transform).find((child) => localName(child.name) === 'ext');
  if (
    offset?.attributes.x === undefined ||
    offset.attributes.y === undefined ||
    extent?.attributes.cx === undefined ||
    extent.attributes.cy === undefined
  ) {
    return undefined;
  }
  try {
    return {
      x: round(emuToPoints(pptxEmu(offset.attributes.x))),
      y: round(emuToPoints(pptxEmu(offset.attributes.y))),
      width: round(emuToPoints(pptxEmu(extent.attributes.cx))),
      height: round(emuToPoints(pptxEmu(extent.attributes.cy))),
      rotation: round(ooxmlAngleToDegrees(pptxAngle(transform.attributes.rot ?? '0'))),
      flipHorizontal: transform.attributes.flipH === '1' || transform.attributes.flipH === 'true',
      flipVertical: transform.attributes.flipV === '1' || transform.attributes.flipV === 'true',
    };
  } catch {
    return undefined;
  }
}

const OLE_GRAPHIC_DATA_URI = 'http://schemas.openxmlformats.org/presentationml/2006/ole';
const TABLE_GRAPHIC_DATA_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table';
const CHART_GRAPHIC_DATA_URIS = CHART_NAMESPACES;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const TABLE_STYLES_PART_PATH = '/ppt/tableStyles.xml';
const CANONICAL_DRAWING_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const CANONICAL_PRESENTATION_NAMESPACE =
  'http://schemas.openxmlformats.org/presentationml/2006/main';
const COLOR_ELEMENT_NAMES = new Set([
  'srgbClr',
  'schemeClr',
  'sysClr',
  'scrgbClr',
  'hslClr',
  'prstClr',
]);
// PowerPoint table cell inset defaults (ECMA-376 a:tcPr).
const TABLE_CELL_MARGIN_DEFAULTS = { marL: '91440', marR: '91440', marT: '45720', marB: '45720' };

function syntheticXml(
  name: string,
  namespaceUri: string,
  attributes: Record<string, string>,
  children: PptxXmlElement[],
): PptxXmlElement {
  return { name, namespaceUri, attributes, children, content: children };
}

interface TableStyleTextDefaults {
  bold?: boolean;
  colorXml?: PptxXmlElement;
}

function tableLayerChild(
  layer: PptxXmlElement | undefined,
  name: string,
): PptxXmlElement | undefined {
  return layer && drawingChildrenOf(layer).find((child) => localName(child.name) === name);
}

/** tcTxStyle carries run defaults: bold flag plus a direct color child. */
function tableLayerTextDefaults(
  layer: PptxXmlElement | undefined,
): TableStyleTextDefaults | undefined {
  const textStyle = tableLayerChild(layer, 'tcTxStyle');
  if (textStyle === undefined) return undefined;
  const colorXml = drawingChildrenOf(textStyle).find((child) =>
    COLOR_ELEMENT_NAMES.has(localName(child.name)),
  );
  return {
    ...(textStyle.attributes.b === 'on'
      ? { bold: true }
      : textStyle.attributes.b === 'off'
        ? { bold: false }
        : {}),
    ...(colorXml === undefined ? {} : { colorXml }),
  };
}

function tableLayerFill(layer: PptxXmlElement | undefined): PptxFillIR | undefined {
  const cellStyle = tableLayerChild(layer, 'tcStyle');
  const fillContainer = tableLayerChild(cellStyle, 'fill');
  if (fillContainer === undefined) return undefined;
  try {
    return parsePptxDirectFill(fillContainer);
  } catch {
    return undefined;
  }
}

function tableLayerBorder(
  layer: PptxXmlElement | undefined,
  side: string,
): PptxXmlElement | undefined {
  const borders = tableLayerChild(tableLayerChild(layer, 'tcStyle'), 'tcBdr');
  const container = tableLayerChild(borders, side);
  return tableLayerChild(container, 'ln');
}

/** Locate the referenced tblStyle definition inside ppt/tableStyles.xml. */
function resolveTableStyleElement(
  context: SlideContext,
  styleId: string | undefined,
): PptxXmlElement | undefined {
  if (styleId === undefined) return undefined;
  const part = context.ir.parts.find((candidate) => candidate.path === TABLE_STYLES_PART_PATH);
  const styleList = part?.xml;
  if (styleList === undefined) return undefined;
  return drawingChildrenOf(styleList).find(
    (child) => localName(child.name) === 'tblStyle' && child.attributes.styleId === styleId,
  );
}

interface TableCellPlacement {
  xml: PptxXmlElement;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
}

/**
 * Map a:tbl into the native v2 table element. Cell fills and borders resolve
 * through the referenced table-style layers (wholeTbl → row band → firstRow)
 * with explicit tcPr values on top; per-side borders collapse onto the
 * uniform cell stroke by majority, surfacing an advisory when sides differ.
 * Cell text reuses the shape text pipeline via a synthesized p:sp whose
 * bodyPr carries the tcPr insets/anchor and whose lstStyle carries the
 * tcTxStyle run defaults.
 */
function mapTable(
  context: SlideContext,
  frameXml: PptxXmlElement,
  graphicData: PptxXmlElement,
  index: number,
  nodePath: string | undefined,
): ReachDeckNativeElementV2 | undefined {
  const location = {
    partPath: context.sourcePartPath,
    slideId: context.slide.id,
    ...(nodePath === undefined ? {} : { nodePath }),
  };
  const block = (message: string): undefined => {
    context.diagnostics.push(
      diagnostic('error', 'pptx.mapper.table_unsupported', 'table', message, location),
    );
    return undefined;
  };
  const advisory = (message: string): void => {
    context.diagnostics.push({
      code: 'pptx.mapper.table_simplified',
      severity: 'warning',
      feature: 'table',
      message,
      location,
    });
  };
  const before = context.diagnostics.length;
  const nonVisual = presentationChildren(frameXml).find(
    (child) => localName(child.name) === 'nvGraphicFramePr',
  );
  const coreProperties =
    nonVisual && presentationChildren(nonVisual).find((child) => localName(child.name) === 'cNvPr');
  const transformElement = presentationChildren(frameXml).find(
    (child) => localName(child.name) === 'xfrm',
  );
  const resolvedTransform =
    transformElement === undefined ? undefined : parseConnectorTransform(transformElement);
  if (resolvedTransform === undefined) {
    return block('Tables require an explicit graphic frame transform.');
  }
  const table = drawingChildrenOf(graphicData).find((child) => localName(child.name) === 'tbl');
  if (table === undefined) return block('Tables require an a:tbl payload.');
  const grid = drawingChildrenOf(table).find((child) => localName(child.name) === 'tblGrid');
  const gridColumns = (grid === undefined ? [] : drawingChildrenOf(grid)).filter(
    (child) => localName(child.name) === 'gridCol',
  );
  const rowElements = drawingChildrenOf(table).filter((child) => localName(child.name) === 'tr');
  if (gridColumns.length === 0 || rowElements.length === 0) {
    return block('Tables require at least one column and one row.');
  }
  let columnWidths: number[];
  let rowHeights: number[];
  try {
    columnWidths = gridColumns.map((column) =>
      Math.max(round(emuToPoints(pptxEmu(column.attributes.w ?? ''))), 0.01),
    );
    rowHeights = rowElements.map((row) =>
      Math.max(round(emuToPoints(pptxEmu(row.attributes.h ?? ''))), 0.01),
    );
  } catch {
    return block('Table grid dimensions are invalid.');
  }

  const properties = drawingChildrenOf(table).find((child) => localName(child.name) === 'tblPr');
  const styleId = tableLayerChild(properties, 'tableStyleId')?.text?.trim();
  const styleElement = resolveTableStyleElement(context, styleId);
  if (styleId !== undefined && styleElement === undefined) {
    advisory(
      `Table style ${styleId} is not defined in ppt/tableStyles.xml; using explicit cell formatting only.`,
    );
  }
  const firstRowEnabled = properties?.attributes.firstRow === '1';
  const bandRowEnabled = properties?.attributes.bandRow === '1';
  for (const flag of ['lastRow', 'firstCol', 'lastCol', 'bandCol'] as const) {
    if (properties?.attributes[flag] === '1') {
      advisory(`Table style option ${flag} is outside the native mapping slice and was ignored.`);
    }
  }
  const wholeTable = tableLayerChild(styleElement, 'wholeTbl');
  const band1 = tableLayerChild(styleElement, 'band1H');
  const band2 = tableLayerChild(styleElement, 'band2H');
  const firstRowLayer = tableLayerChild(styleElement, 'firstRow');

  // Grid EMU offsets keep the synthesized cell transforms exact.
  const columnOffsetsEmu: number[] = [0];
  for (const column of gridColumns) {
    columnOffsetsEmu.push(
      columnOffsetsEmu[columnOffsetsEmu.length - 1]! + Number(column.attributes.w ?? '0'),
    );
  }
  const rowOffsetsEmu: number[] = [0];
  for (const row of rowElements) {
    rowOffsetsEmu.push(rowOffsetsEmu[rowOffsetsEmu.length - 1]! + Number(row.attributes.h ?? '0'));
  }

  const placements: TableCellPlacement[][] = [];
  for (const [rowIndex, rowElement] of rowElements.entries()) {
    const rowPlacements: TableCellPlacement[] = [];
    let column = 0;
    for (const cell of drawingChildrenOf(rowElement)) {
      if (localName(cell.name) !== 'tc') continue;
      const columnSpan = Number.parseInt(cell.attributes.gridSpan ?? '1', 10) || 1;
      const rowSpan = Number.parseInt(cell.attributes.rowSpan ?? '1', 10) || 1;
      if (cell.attributes.hMerge === '1' || cell.attributes.vMerge === '1') {
        // Continuation cells of a merge occupy grid positions without content.
        column += columnSpan;
        continue;
      }
      if (column + columnSpan > columnWidths.length || rowIndex + rowSpan > rowElements.length) {
        return block('Table cell spans exceed the declared grid.');
      }
      rowPlacements.push({ xml: cell, row: rowIndex, column, rowSpan, columnSpan });
      column += columnSpan;
    }
    if (rowPlacements.length === 0) {
      return block('Table rows fully covered by merges are outside the native mapping slice.');
    }
    placements.push(rowPlacements);
  }

  const scope = [
    context.options.applicationId,
    ...context.elementIdScope,
    coreProperties?.attributes.id ?? `table-${index}`,
    nodePath ?? `table-${index}`,
  ];
  const rows: Extract<ReachDeckNativeElementV2, { type: 'table' }>['rows'] = [];
  let borderMismatchReported = false;
  for (const rowPlacements of placements) {
    const rowIndex = rowPlacements[0]!.row;
    const cells: ReachDeckTableCellV2[] = [];
    for (const placement of rowPlacements) {
      const cell = mapTableCell(context, placement, {
        location,
        block,
        scope,
        columnCount: columnWidths.length,
        rowCount: rowElements.length,
        columnOffsetsEmu,
        rowOffsetsEmu,
        firstRowEnabled,
        bandRowEnabled,
        wholeTable,
        band1,
        band2,
        firstRowLayer,
        reportBorderMismatch: () => {
          if (!borderMismatchReported) {
            borderMismatchReported = true;
            advisory(
              'Table cell borders differ per side; the majority border was applied uniformly.',
            );
          }
        },
      });
      if (cell === undefined) return undefined;
      cells.push(cell);
    }
    rows.push({
      id: createStablePptxId('native-element', [...scope, 'row', String(rowIndex)]),
      cells,
    });
  }
  if (hasBlockingPptxDiagnostics(context.diagnostics.slice(before))) return undefined;
  return {
    id: createStablePptxId('native-element', scope),
    type: 'table',
    transform: {
      x: resolvedTransform.x,
      y: resolvedTransform.y,
      width: Math.max(resolvedTransform.width, 0.01),
      height: Math.max(resolvedTransform.height, 0.01),
      ...(resolvedTransform.rotation === 0 ? {} : { rotation: resolvedTransform.rotation }),
      ...(resolvedTransform.flipHorizontal ? { flipHorizontal: true } : {}),
      ...(resolvedTransform.flipVertical ? { flipVertical: true } : {}),
    },
    zIndex: index + 1,
    ...(coreProperties?.attributes.name?.trim() ? { name: coreProperties.attributes.name } : {}),
    source: {
      partPath: context.sourcePartPath,
      ...(coreProperties?.attributes.id ? { sourceId: coreProperties.attributes.id } : {}),
    },
    columnWidths,
    rowHeights,
    rows,
  };
}

interface TableCellMappingInput {
  location: { partPath: string; slideId?: string; nodePath?: string };
  block: (message: string) => undefined;
  scope: readonly string[];
  columnCount: number;
  rowCount: number;
  columnOffsetsEmu: readonly number[];
  rowOffsetsEmu: readonly number[];
  firstRowEnabled: boolean;
  bandRowEnabled: boolean;
  wholeTable?: PptxXmlElement;
  band1?: PptxXmlElement;
  band2?: PptxXmlElement;
  firstRowLayer?: PptxXmlElement;
  reportBorderMismatch: () => void;
}

function mapTableCell(
  context: SlideContext,
  placement: TableCellPlacement,
  input: TableCellMappingInput,
): ReachDeckTableCellV2 | undefined {
  const { location, block, scope } = input;
  const cellProperties = drawingChildrenOf(placement.xml).find(
    (child) => localName(child.name) === 'tcPr',
  );
  const isFirstRow = input.firstRowEnabled && placement.row === 0;
  // Row banding starts below the header; band1H covers the odd data rows.
  const bandLayer =
    input.bandRowEnabled && !isFirstRow
      ? (placement.row - (input.firstRowEnabled ? 1 : 0)) % 2 === 0
        ? input.band1
        : input.band2
      : undefined;
  // Ascending precedence: wholeTbl, band, firstRow; explicit tcPr overrides.
  const layers = [input.wholeTable, bandLayer, ...(isFirstRow ? [input.firstRowLayer] : [])];

  let fillIr: PptxFillIR | undefined;
  try {
    fillIr = cellProperties === undefined ? undefined : parsePptxDirectFill(cellProperties);
  } catch (error) {
    return block(error instanceof Error ? error.message : 'Table cell fill is invalid.');
  }
  if (fillIr === undefined) {
    for (const layer of [...layers].reverse()) {
      const layerFill = tableLayerFill(layer);
      if (layerFill !== undefined) {
        fillIr = layerFill;
        break;
      }
    }
  }
  const fill =
    fillIr === undefined ? undefined : resolveFillIr(context, fillIr, location, 'table cell');
  if (fillIr !== undefined && fill === undefined) return undefined;

  // Outer edges use the table-level border keys, inner edges the inside keys.
  const sideKeys: Array<{ explicit: string; styleKey: string }> = [
    { explicit: 'lnL', styleKey: placement.column === 0 ? 'left' : 'insideV' },
    { explicit: 'lnT', styleKey: placement.row === 0 ? 'top' : 'insideH' },
    {
      explicit: 'lnR',
      styleKey: placement.column + placement.columnSpan === input.columnCount ? 'right' : 'insideV',
    },
    {
      explicit: 'lnB',
      styleKey: placement.row + placement.rowSpan === input.rowCount ? 'bottom' : 'insideH',
    },
  ];
  const sides: Array<ReachDeckStrokeV2 | undefined> = [];
  for (const side of sideKeys) {
    let borderXml =
      cellProperties &&
      drawingChildrenOf(cellProperties).find((child) => localName(child.name) === side.explicit);
    if (borderXml === undefined) {
      for (const layer of [...layers].reverse()) {
        const layerBorder = tableLayerBorder(layer, side.styleKey);
        if (layerBorder !== undefined) {
          borderXml = layerBorder;
          break;
        }
      }
    }
    if (borderXml === undefined) {
      sides.push(undefined);
      continue;
    }
    let strokeIr: PptxStrokeIR;
    try {
      strokeIr = parsePptxStrokeElement(borderXml);
    } catch (error) {
      return block(error instanceof Error ? error.message : 'Table cell border is invalid.');
    }
    const strokeDiagnosticsBefore = context.diagnostics.length;
    const stroke = resolveShapeStroke(context, strokeIr, undefined, location);
    if (stroke === null) {
      // Unresolvable border colors degrade to "no border" instead of dropping
      // the table; the mismatch advisory below records the simplification.
      context.diagnostics.length = strokeDiagnosticsBefore;
      sides.push(undefined);
      continue;
    }
    sides.push(stroke);
  }
  const groups = new Map<string, { stroke: ReachDeckStrokeV2 | undefined; count: number }>();
  for (const side of sides) {
    const key = side === undefined ? 'none' : JSON.stringify(side);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { stroke: side, count: 1 });
    else group.count += 1;
  }
  if (groups.size > 1) input.reportBorderMismatch();
  let winner: { stroke: ReachDeckStrokeV2 | undefined; count: number } | undefined;
  for (const group of groups.values()) {
    if (winner === undefined || group.count > winner.count) winner = group;
  }
  const stroke = winner?.stroke;

  const boxEmu = {
    width:
      input.columnOffsetsEmu[placement.column + placement.columnSpan]! -
      input.columnOffsetsEmu[placement.column]!,
    height:
      input.rowOffsetsEmu[placement.row + placement.rowSpan]! - input.rowOffsetsEmu[placement.row]!,
  };
  const text = mapTableCellText(context, placement, cellProperties, layers, boxEmu, location);
  if (text === undefined) return undefined;
  return {
    id: createStablePptxId('native-element', [
      ...scope,
      'cell',
      String(placement.row),
      String(placement.column),
    ]),
    rowSpan: placement.rowSpan,
    columnSpan: placement.columnSpan,
    text,
    style: {
      ...(fill === undefined ? {} : { fill }),
      ...(stroke === undefined ? {} : { stroke }),
    },
  };
}

/**
 * Reuse the shape text pipeline: wrap the cell's a:txBody in a synthesized
 * p:sp whose bodyPr carries the tcPr insets/anchor and whose lstStyle carries
 * the winning tcTxStyle bold/color run defaults.
 */
function mapTableCellText(
  context: SlideContext,
  placement: TableCellPlacement,
  cellProperties: PptxXmlElement | undefined,
  layers: ReadonlyArray<PptxXmlElement | undefined>,
  boxEmu: { width: number; height: number },
  location: { partPath: string; slideId?: string; nodePath?: string },
): ReachDeckTextFrameV2 | undefined {
  const blockText = (message: string): undefined => {
    context.diagnostics.push(
      diagnostic('error', 'pptx.mapper.table_unsupported', 'table', message, location),
    );
    return undefined;
  };
  const textBody = drawingChildrenOf(placement.xml).find(
    (child) => localName(child.name) === 'txBody',
  );
  if (textBody === undefined) return blockText('Table cells require a text body.');
  const bodyChildren = drawingChildrenOf(textBody);
  const existingBodyProperties = bodyChildren.find((child) => localName(child.name) === 'bodyPr');
  const existingListStyle = bodyChildren.find((child) => localName(child.name) === 'lstStyle');
  const margins = { ...TABLE_CELL_MARGIN_DEFAULTS };
  for (const key of ['marL', 'marR', 'marT', 'marB'] as const) {
    const value = cellProperties?.attributes[key];
    if (value !== undefined) margins[key] = value;
  }
  const anchor = cellProperties?.attributes.anchor;
  const vertical = cellProperties?.attributes.vert;
  const bodyProperties = syntheticXml(
    'a:bodyPr',
    CANONICAL_DRAWING_NAMESPACE,
    {
      ...existingBodyProperties?.attributes,
      lIns: margins.marL,
      tIns: margins.marT,
      rIns: margins.marR,
      bIns: margins.marB,
      ...(anchor === undefined ? {} : { anchor }),
      ...(vertical === undefined || vertical === 'horz' ? {} : { vert: vertical }),
    },
    [...(existingBodyProperties?.children ?? [])],
  );
  let textDefaults: TableStyleTextDefaults | undefined;
  for (const layer of [...layers].reverse()) {
    const layerDefaults = tableLayerTextDefaults(layer);
    if (layerDefaults !== undefined) {
      textDefaults = layerDefaults;
      break;
    }
  }
  const hasExistingListEntries = (existingListStyle?.children ?? []).some(
    (child) => !IGNORED_SUBTREES.has(localName(child.name)),
  );
  let listStyle = existingListStyle;
  if (
    !hasExistingListEntries &&
    (textDefaults?.bold !== undefined || textDefaults?.colorXml !== undefined)
  ) {
    const runDefaults = syntheticXml(
      'a:defRPr',
      CANONICAL_DRAWING_NAMESPACE,
      textDefaults.bold === undefined ? {} : { b: textDefaults.bold ? '1' : '0' },
      textDefaults.colorXml === undefined
        ? []
        : [syntheticXml('a:solidFill', CANONICAL_DRAWING_NAMESPACE, {}, [textDefaults.colorXml])],
    );
    listStyle = syntheticXml(
      'a:lstStyle',
      CANONICAL_DRAWING_NAMESPACE,
      {},
      Array.from({ length: 9 }, (_, level) =>
        syntheticXml(`a:lvl${level + 1}pPr`, CANONICAL_DRAWING_NAMESPACE, {}, [runDefaults]),
      ),
    );
  }
  const paragraphChildren = bodyChildren.filter(
    (child) => localName(child.name) !== 'bodyPr' && localName(child.name) !== 'lstStyle',
  );
  const shapeXml = syntheticXml('p:sp', CANONICAL_PRESENTATION_NAMESPACE, {}, [
    syntheticXml('p:nvSpPr', CANONICAL_PRESENTATION_NAMESPACE, {}, [
      syntheticXml(
        'p:cNvPr',
        CANONICAL_PRESENTATION_NAMESPACE,
        { id: '0', name: `table-cell-r${placement.row}c${placement.column}` },
        [],
      ),
      syntheticXml('p:cNvSpPr', CANONICAL_PRESENTATION_NAMESPACE, {}, []),
      syntheticXml('p:nvPr', CANONICAL_PRESENTATION_NAMESPACE, {}, []),
    ]),
    syntheticXml('p:spPr', CANONICAL_PRESENTATION_NAMESPACE, {}, [
      syntheticXml('a:xfrm', CANONICAL_DRAWING_NAMESPACE, {}, [
        syntheticXml('a:off', CANONICAL_DRAWING_NAMESPACE, { x: '0', y: '0' }, []),
        syntheticXml(
          'a:ext',
          CANONICAL_DRAWING_NAMESPACE,
          { cx: String(boxEmu.width), cy: String(boxEmu.height) },
          [],
        ),
      ]),
    ]),
    syntheticXml('p:txBody', CANONICAL_PRESENTATION_NAMESPACE, {}, [
      bodyProperties,
      ...(listStyle === undefined ? [] : [listStyle]),
      ...paragraphChildren,
    ]),
  ]);
  const projected = projectPptxShapeElement(
    shapeXml,
    `table-cell-r${placement.row}c${placement.column}`,
    {
      partPath: location.partPath,
      ...(location.nodePath === undefined ? {} : { nodePath: location.nodePath }),
    },
  );
  if (!projected.ok) {
    context.diagnostics.push(
      ...projected.diagnostics.map((entry) => ({ ...entry, severity: 'error' as const })),
    );
    return undefined;
  }
  if (projected.node.kind !== 'shape' || projected.node.text === undefined) {
    return blockText('Table cell text is outside the native mapping slice.');
  }
  return mapTextFrame(
    context,
    projected.node,
    { bodyProperties: [], listStyles: [] },
    {},
    location,
  );
}

function graphicFrameFeature(uri: string | undefined): PptxDiagnostic['feature'] {
  if (uri === TABLE_GRAPHIC_DATA_URI) return 'table';
  if (CHART_GRAPHIC_DATA_URIS.has(uri ?? '')) return 'chart';
  if (uri === 'http://schemas.openxmlformats.org/drawingml/2006/diagram') return 'diagram';
  if (uri === OLE_GRAPHIC_DATA_URI) return 'formula';
  return 'unknown-ooxml';
}

const SUPPORTED_CATEGORICAL_CHARTS = new Map<
  string,
  ReachDeckCategoricalChartElementV2['chartType']
>([
  ['lineChart', 'line'],
  ['areaChart', 'area'],
  ['pieChart', 'pie'],
  ['doughnutChart', 'doughnut'],
]);
const CHART_AXIS_NAMES = new Set(['catAx', 'dateAx', 'valAx', 'serAx']);
const MAX_CHART_CACHE_POINTS = 10_000;

interface ChartCache {
  length: number;
  values: ReadonlyMap<number, string>;
}

interface ChartFrameBase {
  id: string;
  transform: ReachDeckCategoricalChartElementV2['transform'];
  zIndex: number;
  name?: string;
  hidden?: boolean;
  ariaLabel?: string;
  source: NonNullable<ReachDeckCategoricalChartElementV2['source']>;
}

function chartFrameBase(
  context: SlideContext,
  frameXml: PptxXmlElement,
  index: number,
  nodePath: string,
): ChartFrameBase | undefined {
  const nonVisual = presentationChildren(frameXml).find(
    (child) => localName(child.name) === 'nvGraphicFramePr',
  );
  const coreProperties =
    nonVisual && presentationChildren(nonVisual).find((child) => localName(child.name) === 'cNvPr');
  const transformElement = presentationChildren(frameXml).find(
    (child) => localName(child.name) === 'xfrm',
  );
  const transform =
    transformElement === undefined ? undefined : parseConnectorTransform(transformElement);
  if (transform === undefined) return undefined;
  const sourceId = coreProperties?.attributes.id ?? `chart-${index}`;
  const name = coreProperties?.attributes.name?.trim();
  const description = coreProperties?.attributes.descr?.trim();
  const hidden =
    coreProperties?.attributes.hidden === '1' || coreProperties?.attributes.hidden === 'true';
  return {
    id: createStablePptxId('native-element', [
      context.options.applicationId,
      ...context.elementIdScope,
      sourceId,
      nodePath,
    ]),
    transform: {
      x: transform.x,
      y: transform.y,
      width: Math.max(transform.width, 0.01),
      height: Math.max(transform.height, 0.01),
      ...(transform.rotation === 0 ? {} : { rotation: transform.rotation }),
      ...(transform.flipHorizontal ? { flipHorizontal: true } : {}),
      ...(transform.flipVertical ? { flipVertical: true } : {}),
    },
    zIndex: index + 1,
    ...(name ? { name } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(description ? { ariaLabel: description } : {}),
    source: {
      partPath: context.sourcePartPath,
      ...(coreProperties?.attributes.id ? { sourceId: coreProperties.attributes.id } : {}),
    },
  };
}

function chartDescendant(
  element: PptxXmlElement | undefined,
  names: ReadonlySet<string>,
): PptxXmlElement | undefined {
  if (element === undefined) return undefined;
  for (const child of chartChildrenOf(element)) {
    if (names.has(localName(child.name))) return child;
    const nested = chartDescendant(child, names);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function chartDescendants(
  element: PptxXmlElement | undefined,
  names: ReadonlySet<string>,
): PptxXmlElement[] {
  if (element === undefined) return [];
  const matches: PptxXmlElement[] = [];
  for (const child of chartChildrenOf(element)) {
    if (names.has(localName(child.name))) matches.push(child);
    matches.push(...chartDescendants(child, names));
  }
  return matches;
}

function readChartCache(cache: PptxXmlElement | undefined): ChartCache | undefined | null {
  if (cache === undefined) return undefined;
  const points = chartChildrenOf(cache).filter((child) => localName(child.name) === 'pt');
  const declaredText = chartChildrenOf(cache).find((child) => localName(child.name) === 'ptCount')
    ?.attributes.val;
  const declared = declaredText === undefined ? points.length : Number(declaredText);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_CHART_CACHE_POINTS) {
    return null;
  }
  const values = new Map<number, string>();
  let length = declared;
  for (const point of points) {
    const index = Number(point.attributes.idx);
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_CHART_CACHE_POINTS) return null;
    if (values.has(index)) return null;
    const value = chartChildrenOf(point).find((child) => localName(child.name) === 'v');
    values.set(index, value?.text ?? '');
    length = Math.max(length, index + 1);
  }
  return { length, values };
}

function chartText(element: PptxXmlElement | undefined): string | undefined {
  if (element === undefined) return undefined;
  const chunks: string[] = [];
  const visit = (node: PptxXmlElement): void => {
    if (DRAWING_NAMESPACES.has(node.namespaceUri ?? '') && localName(node.name) === 't') {
      if (node.text) chunks.push(node.text);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(element);
  const richText = chunks.join('').trim();
  if (richText) return richText;
  const directValue = chartDescendant(element, new Set(['v']))?.text?.trim();
  return directValue || undefined;
}

function chartBoolean(element: PptxXmlElement | undefined): boolean {
  const value = element?.attributes.val;
  return value === undefined || value === '1' || value === 'true' || value === 'on';
}

function chartSeriesColor(
  context: SlideContext,
  series: PptxXmlElement,
): Extract<ReachDeckColorV2, { kind: 'srgb' }> | undefined {
  const shapeProperties = chartChildrenOf(series).find((child) => localName(child.name) === 'spPr');
  if (shapeProperties === undefined) return undefined;
  try {
    const fill = parsePptxDirectFill(shapeProperties);
    if (fill?.kind !== 'solid') return undefined;
    const resolved = resolvePptxColor(fill.color, context.inheritance.schemeContext);
    if (!resolved.ok) return undefined;
    return {
      kind: 'srgb',
      value: resolved.color.hex,
      ...(resolved.color.alpha >= 1 ? {} : { alpha: round(resolved.color.alpha) }),
    };
  } catch {
    return undefined;
  }
}

function mapChart(
  context: SlideContext,
  frameXml: PptxXmlElement,
  graphicData: PptxXmlElement,
  index: number,
  nodePath: string | undefined,
): ReachDeckNativeElementV2 | undefined {
  const location = {
    partPath: context.sourcePartPath,
    slideId: context.slide.id,
    ...(nodePath === undefined ? {} : { nodePath }),
  };
  const base = chartFrameBase(context, frameXml, index, nodePath ?? `chart-${index}`);
  if (base === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.chart_unsupported',
        'chart',
        'Charts require an explicit graphic frame transform.',
        location,
      ),
    );
    return undefined;
  }
  const advisory = (message: string, sourceChartType: string): ReachDeckNativeElementV2 => {
    context.diagnostics.push(
      diagnostic('warning', 'pptx.mapper.chart_unsupported', 'chart', message, location, {
        sourceChartType,
      }),
    );
    return {
      ...base,
      type: 'chart',
      chartType: 'unsupported',
      sourceChartType,
      showLegend: false,
      showDataLabels: false,
    };
  };
  const reference = chartChildrenOf(graphicData).find((child) => localName(child.name) === 'chart');
  const relationshipId = relationshipIdAttribute(reference);
  if (reference === undefined || relationshipId === undefined) {
    return advisory('The chart relationship reference is missing.', 'unresolved-chart');
  }
  const ownerPart = context.ir.parts.find((part) => part.path === context.sourcePartPath);
  const relationship = ownerPart?.relationships.find(
    (candidate) => candidate.id === relationshipId,
  );
  if (
    relationship === undefined ||
    relationship.targetMode !== 'internal' ||
    !CHART_RELATIONSHIP_TYPES.has(relationship.type)
  ) {
    return advisory('The internal chart relationship could not be resolved.', 'unresolved-chart');
  }
  const chartPart = context.ir.parts.find((part) => part.path === relationship.target);
  if (chartPart?.kind !== 'chart' || chartPart.xml === undefined) {
    return advisory('The related chart part is missing or unreadable.', 'unresolved-chart');
  }
  const chart = chartChildrenOf(chartPart.xml).find((child) => localName(child.name) === 'chart');
  const plotArea = chartChildrenOf(chart ?? chartPart.xml).find(
    (child) => localName(child.name) === 'plotArea',
  );
  const chartGroups = chartChildrenOf(plotArea ?? chartPart.xml).filter((child) =>
    localName(child.name).endsWith('Chart'),
  );
  const sourceChartType =
    chartGroups.length === 0
      ? 'unknown-chart'
      : chartGroups.length === 1
        ? localName(chartGroups[0]!.name)
        : 'combination-chart';
  if (chartGroups.length !== 1) {
    return advisory(
      chartGroups.length === 0
        ? 'The chart type is not present in the cached chart part.'
        : 'Combination charts are retained as read-only placeholders.',
      sourceChartType,
    );
  }
  const chartGroup = chartGroups[0]!;
  const groupName = localName(chartGroup.name);
  if (groupName.includes('3D') || groupName === 'scatterChart' || groupName === 'bubbleChart') {
    return advisory(`${groupName} is retained as a read-only placeholder.`, groupName);
  }
  const axisCount = chartChildrenOf(plotArea ?? chartPart.xml).filter((child) =>
    CHART_AXIS_NAMES.has(localName(child.name)),
  ).length;
  if (axisCount > 2) {
    return advisory(
      'Charts with secondary axes are retained as read-only placeholders.',
      groupName,
    );
  }
  let chartType = SUPPORTED_CATEGORICAL_CHARTS.get(groupName);
  if (groupName === 'barChart') {
    // CT_BarDir's @val defaults to col, so a writer that leaves the direction
    // out still means a column chart, not an unreadable one.
    const direction =
      chartChildrenOf(chartGroup).find((child) => localName(child.name) === 'barDir')?.attributes
        .val ?? 'col';
    chartType = direction === 'bar' ? 'bar' : direction === 'col' ? 'column' : undefined;
  }
  if (chartType === undefined) {
    return advisory(`${groupName} is retained as a read-only placeholder.`, groupName);
  }

  const sourceSeries = chartChildrenOf(chartGroup)
    .filter((child) => localName(child.name) === 'ser')
    .map((series, position) => {
      const orderValue = Number(
        chartChildrenOf(series).find((child) => localName(child.name) === 'order')?.attributes.val,
      );
      const sourceIndex =
        chartChildrenOf(series).find((child) => localName(child.name) === 'idx')?.attributes.val ??
        String(position);
      const categoryContainer = chartChildrenOf(series).find(
        (child) => localName(child.name) === 'cat',
      );
      const valueContainer = chartChildrenOf(series).find(
        (child) => localName(child.name) === 'val',
      );
      const categoryCache = readChartCache(
        chartDescendant(categoryContainer, new Set(['strCache', 'numCache', 'strLit', 'numLit'])),
      );
      const valueCache = readChartCache(
        chartDescendant(valueContainer, new Set(['numCache', 'numLit'])),
      );
      return {
        xml: series,
        position,
        order: Number.isSafeInteger(orderValue) && orderValue >= 0 ? orderValue : position,
        sourceIndex,
        categoryCache,
        valueCache,
      };
    })
    .sort((left, right) => left.order - right.order || left.position - right.position);
  if (sourceSeries.length === 0) {
    return advisory('The chart has no cached series.', groupName);
  }
  if (sourceSeries.some((series) => series.categoryCache === null || series.valueCache === null)) {
    return advisory('The chart cache contains invalid or excessive point indexes.', groupName);
  }
  const categoryCount = Math.max(
    0,
    ...sourceSeries.flatMap((series) => [
      series.categoryCache?.length ?? 0,
      series.valueCache?.length ?? 0,
    ]),
  );
  if (categoryCount === 0) {
    return advisory('The chart has no cached category or value points.', groupName);
  }
  const categoryCache = sourceSeries.find(
    (series) => (series.categoryCache?.length ?? 0) > 0,
  )?.categoryCache;
  const categories = Array.from({ length: categoryCount }, (_, pointIndex) => {
    const value = categoryCache?.values.get(pointIndex)?.trim();
    return value || String(pointIndex + 1);
  });
  const series: ReachDeckCategoricalChartElementV2['series'] = sourceSeries.map(
    (source, seriesIndex) => {
      const tx = chartChildrenOf(source.xml).find((child) => localName(child.name) === 'tx');
      const name = chartText(tx) ?? `Series ${seriesIndex + 1}`;
      const color = chartSeriesColor(context, source.xml);
      return {
        id: createStablePptxId('native-element', [
          context.options.applicationId,
          ...context.elementIdScope,
          base.id,
          'series',
          source.sourceIndex,
          String(source.position),
        ]),
        name,
        values: Array.from({ length: categoryCount }, (_, pointIndex) => {
          const raw = source.valueCache?.values.get(pointIndex)?.trim();
          if (!raw) return null;
          const value = Number(raw);
          return Number.isFinite(value) ? value : null;
        }),
        ...(color === undefined ? {} : { color }),
      };
    },
  );
  const titleElement = chartChildrenOf(chart ?? chartPart.xml).find(
    (child) => localName(child.name) === 'title',
  );
  const title = chartText(titleElement);
  const legend = chartChildrenOf(chart ?? chartPart.xml).find(
    (child) => localName(child.name) === 'legend',
  );
  const legendDeleted = chartChildrenOf(legend ?? chartPart.xml).find(
    (child) => localName(child.name) === 'delete',
  );
  const dataLabels = chartDescendants(chartGroup, new Set(['dLbls', 'dLbl']));
  const showDataLabels = dataLabels.some((labels) =>
    chartDescendants(
      labels,
      new Set(['showVal', 'showCatName', 'showSerName', 'showPercent', 'showBubbleSize']),
    ).some(chartBoolean),
  );
  context.diagnostics.push(
    diagnostic(
      'warning',
      'pptx.mapper.chart_simplified',
      'chart',
      'Chart layout and formatting are approximated from its cached data.',
      location,
      { sourceChartType: groupName },
    ),
  );
  return {
    ...base,
    type: 'chart',
    chartType,
    ...(title === undefined ? {} : { title }),
    categories,
    series,
    showLegend:
      legend !== undefined && !(legendDeleted !== undefined && chartBoolean(legendDeleted)),
    showDataLabels,
  };
}

/**
 * Map p:graphicFrame payloads. Embedded OLE objects (equations, worksheets)
 * import through the mc:Fallback picture PowerPoint always writes next to the
 * live object — MCE resolution at parse time already picked that branch, so
 * the p:oleObj with its p:pic is the direct graphicData child here.
 */
function mapGraphicFrame(
  context: SlideContext,
  xml: PptxXmlElement,
  index: number,
  nodePath?: string,
): ReachDeckNativeElementV2 | undefined {
  const location = {
    partPath: context.sourcePartPath,
    slideId: context.slide.id,
    ...(nodePath === undefined ? {} : { nodePath }),
  };
  const graphic = drawingChildrenOf(xml).find((child) => localName(child.name) === 'graphic');
  const graphicData =
    graphic && drawingChildrenOf(graphic).find((child) => localName(child.name) === 'graphicData');
  const uri = graphicData?.attributes.uri;
  const block = (message: string): undefined => {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.graphic_frame_unsupported',
        graphicFrameFeature(uri),
        message,
        {
          ...location,
        },
      ),
    );
    return undefined;
  };
  if (graphicData === undefined) return block('Graphic frames require a graphic payload.');
  if (uri === OLE_GRAPHIC_DATA_URI) {
    const oleObject = presentationChildren(graphicData).find(
      (child) => localName(child.name) === 'oleObj',
    );
    const fallbackPicture =
      oleObject && presentationChildren(oleObject).find((child) => localName(child.name) === 'pic');
    if (fallbackPicture === undefined) {
      return block(
        'Embedded objects without a picture fallback are outside the native mapping slice.',
      );
    }
    // The fallback is a complete DrawingML picture with its own absolute
    // transform; mapping it directly reuses every picture rule (crop, stroke,
    // media resolution). Its identity comes from the frame, because every OLE
    // fallback picture on a slide is written with the same `id="0"`.
    const frameProperties = presentationChildren(xml)
      .filter((child) => localName(child.name) === 'nvGraphicFramePr')
      .flatMap((child) => presentationChildren(child))
      .find((child) => localName(child.name) === 'cNvPr');
    return mapPicture(
      context,
      fallbackPicture,
      index,
      nodePath,
      frameProperties?.attributes.id ?? `graphic-frame-${index}`,
    );
  }
  if (uri === TABLE_GRAPHIC_DATA_URI) {
    return mapTable(context, xml, graphicData, index, nodePath);
  }
  if (CHART_GRAPHIC_DATA_URIS.has(uri ?? '')) {
    return mapChart(context, xml, graphicData, index, nodePath);
  }
  return block(`Graphic frame payload ${uri ?? '(none)'} is outside the native mapping slice.`);
}

function mapConnector(
  context: SlideContext,
  xml: PptxXmlElement,
  index: number,
  nodePath?: string,
): ReachDeckLineElementV2 | undefined {
  const location = {
    partPath: context.sourcePartPath,
    slideId: context.slide.id,
    ...(nodePath === undefined ? {} : { nodePath }),
  };
  const before = context.diagnostics.length;
  const nonVisual = presentationChildren(xml).find(
    (child) => localName(child.name) === 'nvCxnSpPr',
  );
  const coreProperties =
    nonVisual && presentationChildren(nonVisual).find((child) => localName(child.name) === 'cNvPr');
  const shapeProperties = presentationChildren(xml).find(
    (child) => localName(child.name) === 'spPr',
  );
  const styleXml = presentationChildren(xml).find((child) => localName(child.name) === 'style');
  const transformElement =
    shapeProperties &&
    drawingChildrenOf(shapeProperties).find((child) => localName(child.name) === 'xfrm');
  const geometry =
    shapeProperties &&
    drawingChildrenOf(shapeProperties).find((child) => localName(child.name) === 'prstGeom');
  const preset = geometry?.attributes.prst;
  if (preset === undefined || !SUPPORTED_CONNECTOR_PRESETS.has(preset)) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.connector_unsupported',
        'connector',
        `Connector geometry ${preset ?? '(none)'} is outside the native mapping slice.`,
        location,
      ),
    );
    return undefined;
  }
  const resolvedTransform =
    transformElement === undefined ? undefined : parseConnectorTransform(transformElement);
  if (resolvedTransform === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.connector_unsupported',
        'connector',
        'Connectors require an explicit transform.',
        location,
      ),
    );
    return undefined;
  }
  const references = parseStyleReferences(styleXml);
  const lineElement =
    shapeProperties &&
    drawingChildrenOf(shapeProperties).find((child) => localName(child.name) === 'ln');
  let direct: PptxStrokeIR | undefined;
  if (lineElement !== undefined) {
    try {
      direct = parsePptxStrokeElement(lineElement);
    } catch (error) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.connector_unsupported',
          'connector',
          error instanceof Error ? error.message : 'Connector stroke is invalid.',
          location,
        ),
      );
      return undefined;
    }
  }
  const stroke = resolveShapeStroke(context, direct, references.lineReference, location);
  if (stroke === null || hasBlockingPptxDiagnostics(context.diagnostics.slice(before))) {
    return undefined;
  }
  // 连接线效果(阴影等)超出 line 元素模型:降级为 advisory,不丢线。
  reportResidualEffects(context, xml, undefined, location, 'connector');
  if (stroke === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.connector_unsupported',
        'connector',
        'Connectors require a resolvable stroke.',
        location,
      ),
    );
    return undefined;
  }
  // Elbow connectors carry the vertical-segment position as adj1 (fraction of
  // the horizontal travel ×100000); bentConnector2 is the fixed corner elbow.
  let bend: number | undefined;
  if (preset === 'bentConnector2') bend = 1;
  if (preset === 'bentConnector3') {
    const adjustList = drawingChildrenOf(geometry!).find(
      (child) => localName(child.name) === 'avLst',
    );
    const adjust = (adjustList?.children ?? []).find(
      (child) => localName(child.name) === 'gd' && child.attributes.name === 'adj1',
    );
    const formula = adjust?.attributes.fmla ?? 'val 50000';
    const match = /^val (-?\d+)$/.exec(formula);
    const value = match === null ? Number.NaN : Number.parseInt(match[1]!, 10);
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.connector_unsupported',
          'connector',
          `Bent connector adjustment ${formula} is outside the native mapping slice.`,
          location,
        ),
      );
      return undefined;
    }
    bend = value / 100_000;
  }
  const rawWidth = resolvedTransform.width;
  const rawHeight = resolvedTransform.height;
  // The box floor keeps zero-extent axes visible; endpoints stay on the raw
  // values because group children use tiny local units that the enclosing
  // group scale would otherwise inflate (same rule as mapShapeAsLine).
  const width = Math.max(rawWidth, 0.01);
  const height = Math.max(rawHeight, 0.01);
  const startX = resolvedTransform.flipHorizontal ? rawWidth : 0;
  const endX = resolvedTransform.flipHorizontal ? 0 : rawWidth;
  const startY = resolvedTransform.flipVertical ? rawHeight : 0;
  const endY = resolvedTransform.flipVertical ? 0 : rawHeight;
  const headMarker = mapLineMarker(lineElement, 'headEnd');
  const tailMarker = mapLineMarker(lineElement, 'tailEnd');
  return {
    id: createStablePptxId('native-element', [
      context.options.applicationId,
      ...context.elementIdScope,
      coreProperties?.attributes.id ?? `connector-${index}`,
      nodePath ?? `connector-${index}`,
    ]),
    type: 'line',
    transform: {
      x: resolvedTransform.x,
      y: resolvedTransform.y,
      width,
      height,
      ...(resolvedTransform.rotation === 0 ? {} : { rotation: resolvedTransform.rotation }),
    },
    zIndex: index + 1,
    ...(coreProperties?.attributes.name?.trim() ? { name: coreProperties.attributes.name } : {}),
    source: {
      partPath: context.sourcePartPath,
      ...(coreProperties?.attributes.id ? { sourceId: coreProperties.attributes.id } : {}),
    },
    start: { x: startX, y: startY, ...(headMarker === undefined ? {} : { marker: headMarker }) },
    end: { x: endX, y: endY, ...(tailMarker === undefined ? {} : { marker: tailMarker }) },
    routing: bend === undefined ? 'straight' : 'elbow',
    ...(bend === undefined ? {} : { bend }),
    connector: preset !== 'line',
    stroke,
  };
}

function mapLineMarker(
  lineElement: PptxXmlElement | undefined,
  endName: 'headEnd' | 'tailEnd',
): 'none' | 'arrow' | 'diamond' | 'oval' | 'triangle' | undefined {
  const end =
    lineElement &&
    drawingChildrenOf(lineElement).find((child) => localName(child.name) === endName);
  switch (end?.attributes.type) {
    case undefined:
    case 'none':
      return undefined;
    case 'arrow':
    case 'stealth':
      return 'arrow';
    case 'triangle':
      return 'triangle';
    case 'diamond':
      return 'diamond';
    case 'oval':
      return 'oval';
    default:
      return 'arrow';
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** Mirrors the DSL's MAX_NATIVE_GROUP_DEPTH so mapped documents always validate. */
const MAX_GROUP_DEPTH = 32;

function parseGroupCoordinateSpace(
  transform: PptxXmlElement,
): PptxResolvedGroupCoordinateSpace | undefined {
  const child = (name: string): PptxXmlElement | undefined =>
    drawingChildrenOf(transform).find((candidate) => localName(candidate.name) === name);
  const offset = child('off');
  const extent = child('ext');
  const childOffset = child('chOff');
  const childExtent = child('chExt');
  if (
    offset?.attributes.x === undefined ||
    offset.attributes.y === undefined ||
    extent?.attributes.cx === undefined ||
    extent.attributes.cy === undefined ||
    childOffset?.attributes.x === undefined ||
    childOffset.attributes.y === undefined ||
    childExtent?.attributes.cx === undefined ||
    childExtent.attributes.cy === undefined
  ) {
    return undefined;
  }
  try {
    return resolvePptxGroupCoordinateSpace({
      offset: { x: pptxEmu(offset.attributes.x), y: pptxEmu(offset.attributes.y) },
      extent: { width: pptxEmu(extent.attributes.cx), height: pptxEmu(extent.attributes.cy) },
      rotation: pptxAngle(transform.attributes.rot ?? '0'),
      flipHorizontal: transform.attributes.flipH === '1' || transform.attributes.flipH === 'true',
      flipVertical: transform.attributes.flipV === '1' || transform.attributes.flipV === 'true',
      childOffset: { x: pptxEmu(childOffset.attributes.x), y: pptxEmu(childOffset.attributes.y) },
      childExtent: {
        width: pptxEmu(childExtent.attributes.cx),
        height: pptxEmu(childExtent.attributes.cy),
      },
    });
  } catch {
    return undefined;
  }
}

/**
 * Bake a group's child-space transform into a mapped child element. The
 * renderer positions group children absolutely inside the group box without
 * scaling them, so chOff/chExt scaling must land in the stored coordinates —
 * including recursively inside nested groups. Rotated children under a
 * non-uniform scale keep their angle with a scaled box (the exact result is a
 * parallelogram outside the DSL model); real-tool output groups at scale 1.
 *
 * Stroke widths are deliberately NOT scaled: a:ln/@w stays an absolute EMU
 * width regardless of the group's local coordinate space. Real decks use
 * tiny chExt values (e.g. cx=1763) with ordinary 1.5pt strokes, and
 * PowerPoint renders those strokes at 1.5pt — scaling them by chExt ratio
 * painted entire pages black.
 */
function scaleIntoGroupSpace(
  element: ReachDeckNativeElementV2,
  scaleX: number,
  scaleY: number,
  originX: number,
  originY: number,
  onGeometrySimplified: (element: ReachDeckNativeElementV2) => void,
): ReachDeckNativeElementV2 {
  if (scaleX === 1 && scaleY === 1 && originX === 0 && originY === 0) return element;
  const transform = {
    ...element.transform,
    x: round((element.transform.x - originX) * scaleX),
    y: round((element.transform.y - originY) * scaleY),
    width: Math.max(round(element.transform.width * scaleX), 0.01),
    height: Math.max(round(element.transform.height * scaleY), 0.01),
  };
  switch (element.type) {
    case 'line':
      return {
        ...element,
        transform,
        start: {
          ...element.start,
          x: round(element.start.x * scaleX),
          y: round(element.start.y * scaleY),
        },
        end: {
          ...element.end,
          x: round(element.end.x * scaleX),
          y: round(element.end.y * scaleY),
        },
      };
    case 'shape':
      if (element.geometry.kind === 'custom') {
        // Custom geometry is stored in the pre-scale box coordinates; the
        // viewBox must track the final box or absolute-pt strokes render
        // hundreds of times too wide inside a tiny viewBox.
        const width = round(element.geometry.viewBox.width * scaleX);
        const height = round(element.geometry.viewBox.height * scaleY);
        if (width < 0.01 || height < 0.01) onGeometrySimplified(element);
        return {
          ...element,
          transform,
          geometry: {
            ...element.geometry,
            viewBox: {
              width: Math.max(width, 0.01),
              height: Math.max(height, 0.01),
            },
            path: scaleSvgPathCoordinates(element.geometry.path, scaleX, scaleY),
          },
        };
      }
      return { ...element, transform };
    case 'group':
      return {
        ...element,
        transform,
        children: element.children.map((child) =>
          scaleIntoGroupSpace(child, scaleX, scaleY, 0, 0, onGeometrySimplified),
        ),
      };
    default:
      return { ...element, transform };
  }
}

/**
 * Rescale the coordinate tokens of a mapper-generated SVG path (absolute
 * M/L/C/Q/Z commands whose arguments are x,y pairs).
 */
function scaleSvgPathCoordinates(path: string, scaleX: number, scaleY: number): string {
  let coordinateIndex = 0;
  return path
    .split(' ')
    .map((token) => {
      if (/^[A-Za-z]$/.test(token)) {
        coordinateIndex = 0;
        return token;
      }
      const value = Number(token);
      const scaled = coordinateIndex % 2 === 0 ? value * scaleX : value * scaleY;
      coordinateIndex += 1;
      return String(round(scaled));
    })
    .join(' ');
}

function mapGroupChild(
  context: SlideContext,
  xml: PptxXmlElement,
  nodePath: string,
  index: number,
  depth: number,
  sourcePaths: Map<string, string>,
): ReachDeckNativeElementV2 | undefined {
  const name = localName(xml.name);
  const inPresentationNamespace = PRESENTATION_NAMESPACES.has(xml.namespaceUri ?? '');
  if (inPresentationNamespace && name === 'sp') {
    const projected = projectPptxShapeElement(
      xml,
      createStablePptxId('node', [context.sourcePartPath, nodePath]),
      { partPath: context.sourcePartPath, nodePath },
    );
    if (!projected.ok) {
      // Projection reports parser-grade fatals; inside best-effort mapping they
      // degrade to element-dropping errors like every other mapper blocker.
      context.diagnostics.push(
        ...projected.diagnostics.map((entry) => ({ ...entry, severity: 'error' as const })),
      );
      return undefined;
    }
    return projected.node.kind === 'shape' ? mapShape(context, projected.node, index) : undefined;
  }
  if (inPresentationNamespace && name === 'cxnSp') {
    return mapConnector(context, xml, index, nodePath);
  }
  if (inPresentationNamespace && name === 'pic') {
    return mapPicture(context, xml, index, nodePath);
  }
  if (inPresentationNamespace && name === 'graphicFrame') {
    return mapGraphicFrame(context, xml, index, nodePath);
  }
  if (inPresentationNamespace && name === 'grpSp') {
    return mapGroup(context, xml, nodePath, index, depth + 1, sourcePaths);
  }
  context.diagnostics.push(
    diagnostic(
      'error',
      'pptx.mapper.unknown_node_unsupported',
      'unknown-ooxml',
      `${xml.name} is outside the native mapping slice.`,
      { partPath: context.sourcePartPath, slideId: context.slide.id, nodePath },
    ),
  );
  return undefined;
}

/** a:grpSpPr fill children, in the order ECMA-376 allows exactly one of. */
const GROUP_FILL_ELEMENT_NAMES = new Set([
  'noFill',
  'solidFill',
  'gradFill',
  'blipFill',
  'pattFill',
  'grpFill',
]);

function mapGroup(
  context: SlideContext,
  xml: PptxXmlElement,
  nodePath: string,
  index: number,
  depth: number,
  // Native ids include the XML path, unlike producer source ids which may
  // repeat. Share paths across nested groups and keep them outside the DSL.
  sourcePaths = new Map<string, string>(),
): ReachDeckNativeElementV2 | undefined {
  const location = { partPath: context.sourcePartPath, slideId: context.slide.id, nodePath };
  const block = (message: string): undefined => {
    context.diagnostics.push(
      diagnostic('error', 'pptx.mapper.group_unsupported', 'group', message, location),
    );
    return undefined;
  };
  if (depth > MAX_GROUP_DEPTH) {
    return block(
      `Group nesting deeper than ${MAX_GROUP_DEPTH} is outside the native mapping slice.`,
    );
  }
  const nonVisual = presentationChildren(xml).find(
    (child) => localName(child.name) === 'nvGrpSpPr',
  );
  const coreProperties =
    nonVisual && presentationChildren(nonVisual).find((child) => localName(child.name) === 'cNvPr');
  const groupProperties = presentationChildren(xml).find(
    (child) => localName(child.name) === 'grpSpPr',
  );
  const transformElement =
    groupProperties &&
    drawingChildrenOf(groupProperties).find((child) => localName(child.name) === 'xfrm');
  if (transformElement === undefined) {
    return block('Groups require an explicit transform.');
  }
  // Beyond the transform, grpSpPr carries the group fill children may
  // reference through a:grpFill and effects. The group element itself paints
  // nothing, so its own fill only matters through those references. Effect
  // lists degrade: supported effects (outer shadow, glow) map onto the group
  // element and the rest are dropped with advisories — the group is kept.
  let groupEffectsXml: PptxXmlElement | undefined;
  let groupFill: PptxFillIR | undefined;
  for (const child of drawingChildrenOf(groupProperties!)) {
    const name = localName(child.name);
    if (name === 'xfrm' || IGNORED_SUBTREES.has(name)) continue;
    if (name === 'effectLst' || name === 'effectDag') {
      groupEffectsXml = child;
      continue;
    }
    if (GROUP_FILL_ELEMENT_NAMES.has(name)) {
      try {
        const parsed = parsePptxFillElement(child);
        // A group whose own fill is a:grpFill defers to its parent's.
        groupFill =
          parsed.kind === 'unsupported' && parsed.fillType === 'grpFill'
            ? context.groupFill
            : parsed;
      } catch {
        groupFill = undefined;
      }
      continue;
    }
    return block(`Group ${child.name} properties are outside the native mapping slice.`);
  }
  const groupEffects = resolveElementEffects(
    context,
    groupEffectsXml,
    undefined,
    location,
    'group',
  );
  const space = parseGroupCoordinateSpace(transformElement);
  if (space === undefined) {
    return block('Group transform offsets and child extents are missing or invalid.');
  }
  const childContext: SlideContext = groupFill === undefined ? context : { ...context, groupFill };
  const children: ReachDeckNativeElementV2[] = [];
  const occurrences = new Map<string, number>();
  let candidateCount = 0;
  for (const child of xml.children) {
    const name = localName(child.name);
    if (name === 'nvGrpSpPr' || name === 'grpSpPr' || IGNORED_SUBTREES.has(name)) continue;
    const occurrence = (occurrences.get(child.name) ?? 0) + 1;
    occurrences.set(child.name, occurrence);
    // One unmappable child drops that child (with its own diagnostics), never
    // the whole group.
    const element = mapGroupChild(
      childContext,
      child,
      `${nodePath}/${child.name}[${occurrence}]`,
      candidateCount,
      depth,
      sourcePaths,
    );
    candidateCount += 1;
    if (element === undefined) continue;
    sourcePaths.set(element.id, `${nodePath}/${child.name}[${occurrence}]`);
    children.push(
      scaleIntoGroupSpace(
        element,
        space.scaleX,
        space.scaleY,
        space.childBounds.x,
        space.childBounds.y,
        (simplified) => {
          context.diagnostics.push(
            diagnostic(
              'warning',
              'pptx.mapper.geometry_simplified',
              'geometry',
              'Grouped custom geometry below 0.01pt imports with the minimum positive view box.',
              {
                ...location,
                partPath: simplified.source?.partPath ?? location.partPath,
                nodePath: sourcePaths.get(simplified.id),
              },
              { sourceId: simplified.source?.sourceId ?? simplified.id },
            ),
          );
        },
      ),
    );
  }
  if (children.length === 0) {
    // The v2 schema rejects empty groups; when children existed their own
    // diagnostics already explain the drop.
    if (candidateCount === 0) return block('Groups require at least one drawable child.');
    return undefined;
  }
  const groupName = coreProperties?.attributes.name;
  const description = coreProperties?.attributes.descr;
  const hidden =
    coreProperties?.attributes.hidden === '1' || coreProperties?.attributes.hidden === 'true';
  return {
    id: createStablePptxId('native-element', [
      context.options.applicationId,
      ...context.elementIdScope,
      coreProperties?.attributes.id ?? `group-${nodePath}`,
      nodePath,
    ]),
    type: 'group',
    transform: {
      x: round(space.bounds.x),
      y: round(space.bounds.y),
      width: Math.max(round(space.bounds.width), 0.01),
      height: Math.max(round(space.bounds.height), 0.01),
      ...(space.rotationDegrees === 0 ? {} : { rotation: space.rotationDegrees }),
      ...(space.flipHorizontal ? { flipHorizontal: true } : {}),
      ...(space.flipVertical ? { flipVertical: true } : {}),
    },
    zIndex: index + 1,
    ...(groupName?.trim() ? { name: groupName } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(description?.trim() ? { ariaLabel: description } : {}),
    source: {
      partPath: context.sourcePartPath,
      ...(coreProperties?.attributes.id ? { sourceId: coreProperties.attributes.id } : {}),
    },
    children,
    ...(groupEffects === undefined ? {} : { effects: groupEffects }),
  };
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** Matches the shared media pipeline's accepted image payloads. */
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Package image types that are vector art. None of them can back a native
 * element, so callers rasterize them before upload; the mapper only needs to
 * recognize them well enough to report the conversion.
 */
const VECTOR_IMAGE_CONTENT_TYPES = new Set([
  'image/svg+xml',
  'image/wmf',
  'image/x-wmf',
  'image/emf',
  'image/x-emf',
  'image/x-emf-plus',
  'application/x-msmetafile',
]);

/**
 * Media part paths referenced by slide pictures. Callers upload exactly these
 * to object storage and hand the results to the mapper via `mediaUploads` —
 * parsing is pure, storage stays outside.
 */
export function collectPptxReferencedMediaPartPaths(ir: PptxPresentationIR): string[] {
  const paths = new Set<string>();
  const addBlipEmbed = (partPath: string, blip: PptxXmlElement | undefined): void => {
    const embedId = blipEmbedRelationshipId(blip);
    if (embedId === undefined) return;
    const part = ir.parts.find((candidate) => candidate.path === partPath);
    const relationship = part?.relationships.find((candidate) => candidate.id === embedId);
    if (relationship?.targetMode === 'internal') paths.add(relationship.target);
  };
  const addDrawableBlips = (partPath: string, element: PptxXmlElement): void => {
    // pic blips nested inside grpSp count too; blipFill lives in the
    // presentation namespace on pictures.
    if (localName(element.name) === 'pic') {
      const blipFill = presentationChildren(element).find(
        (child) => localName(child.name) === 'blipFill',
      );
      const blip =
        blipFill && drawingChildrenOf(blipFill).find((child) => localName(child.name) === 'blip');
      addBlipEmbed(partPath, blip);
      return;
    }
    // 表格单元格图片填充:a:tcPr 下的 a:blipFill。
    if (localName(element.name) === 'tcPr') {
      const blipFill = drawingChildrenOf(element).find(
        (child) => localName(child.name) === 'blipFill',
      );
      const blip =
        blipFill && drawingChildrenOf(blipFill).find((child) => localName(child.name) === 'blip');
      addBlipEmbed(partPath, blip);
      return;
    }
    // sp 图片填充:spPr 下的 a:blipFill(drawing ns)。
    if (localName(element.name) === 'sp') {
      const shapeProperties = presentationChildren(element).find(
        (child) => localName(child.name) === 'spPr',
      );
      const blipFill =
        shapeProperties &&
        drawingChildrenOf(shapeProperties).find((child) => localName(child.name) === 'blipFill');
      const blip =
        blipFill && drawingChildrenOf(blipFill).find((child) => localName(child.name) === 'blip');
      addBlipEmbed(partPath, blip);
      return;
    }
    for (const child of element.children) addDrawableBlips(partPath, child);
  };
  const addBackgroundBlip = (partPath: string, root: PptxXmlElement | undefined): void => {
    if (root === undefined) return;
    const commonSlideData = presentationChildren(root).find(
      (child) => localName(child.name) === 'cSld',
    );
    const background =
      commonSlideData &&
      presentationChildren(commonSlideData).find((child) => localName(child.name) === 'bg');
    const properties =
      background &&
      presentationChildren(background).find((child) => localName(child.name) === 'bgPr');
    const blipFill =
      properties &&
      drawingChildrenOf(properties).find((child) => localName(child.name) === 'blipFill');
    const blip =
      blipFill && drawingChildrenOf(blipFill).find((child) => localName(child.name) === 'blip');
    addBlipEmbed(partPath, blip);
  };
  for (const slide of ir.slides) {
    const part = ir.parts.find((candidate) => candidate.path === slide.partPath);
    if (part === undefined) continue;
    addBackgroundBlip(slide.partPath, part.xml);
    const layout = ir.layouts.find((candidate) => candidate.partPath === slide.layoutPartPath);
    if (layout !== undefined) {
      addBackgroundBlip(layout.partPath, layout.xml);
      const master = ir.masters.find((candidate) => candidate.partPath === layout.masterPartPath);
      if (master !== undefined) addBackgroundBlip(master.partPath, master.xml);
      // Decoration pictures materialize per page; the same showMasterSp gating
      // as mapping keeps the upload set aligned with what actually renders.
      const slideShowsInheritedShapes = part.xml?.attributes.showMasterSp !== '0';
      const layoutShowsMasterShapes = layout.xml.attributes.showMasterSp !== '0';
      if (slideShowsInheritedShapes) {
        if (master !== undefined && layoutShowsMasterShapes) {
          for (const drawable of nonPlaceholderDrawables(master.xml)) {
            addDrawableBlips(master.partPath, drawable.xml);
          }
        }
        for (const drawable of nonPlaceholderDrawables(layout.xml)) {
          addDrawableBlips(layout.partPath, drawable.xml);
        }
      }
    }
    for (const node of slide.nodes) {
      // Covers top-level pics/sp image fills and those nested inside grpSp trees.
      addDrawableBlips(slide.partPath, node.xml);
    }
  }
  return [...paths].sort();
}

function mapPicture(
  context: SlideContext,
  xml: PptxXmlElement,
  index: number,
  nodePath?: string,
  /**
   * Identity to use instead of the picture's own `p:cNvPr@id`. An OLE fallback
   * picture carries `id="0"` in every object PowerPoint writes, so several on
   * one slide would otherwise map to the same element id.
   */
  identityOverride?: string,
): ReachDeckImageElementV2 | ReachDeckShapeElementV2 | undefined {
  const location = {
    partPath: context.sourcePartPath,
    slideId: context.slide.id,
    ...(nodePath === undefined ? {} : { nodePath }),
  };
  const block = (message: string): undefined => {
    context.diagnostics.push(
      diagnostic('error', 'pptx.mapper.picture_unsupported', 'image', message, location),
    );
    return undefined;
  };
  // 降级不丢主体:图片照常渲染,被丢弃的调整/样式以 warning 记录。
  const advisory = (message: string): void => {
    context.diagnostics.push(
      diagnostic('warning', 'pptx.mapper.picture_unsupported', 'image', message, location),
    );
  };
  const nonVisual = presentationChildren(xml).find((child) => localName(child.name) === 'nvPicPr');
  const coreProperties =
    nonVisual && presentationChildren(nonVisual).find((child) => localName(child.name) === 'cNvPr');
  const nvPr =
    nonVisual && presentationChildren(nonVisual).find((child) => localName(child.name) === 'nvPr');
  if (
    nvPr !== undefined &&
    presentationChildren(nvPr).some((child) => localName(child.name) === 'ph')
  ) {
    return block('Placeholder-backed pictures are outside the native mapping slice.');
  }
  const blipFill = presentationChildren(xml).find((child) => localName(child.name) === 'blipFill');
  const blip =
    blipFill && drawingChildrenOf(blipFill).find((child) => localName(child.name) === 'blip');
  const embedId = blipEmbedRelationshipId(blip);
  if (blip === undefined || embedId === undefined) {
    return block('Pictures require an embedded image relationship.');
  }
  // a:duotone/a:clrChange 等颜色调整无 CSS 忠实等价物:丢调整、保图片。
  const adjustments = blip.children.filter((child) => {
    const name = localName(child.name);
    if (IGNORED_SUBTREES.has(name)) return false;
    if (name === 'lum' && Object.keys(child.attributes).length === 0) return false;
    return true;
  });
  if (adjustments.length > 0) {
    advisory(
      `Picture color/effect adjustments (${adjustments
        .map((child) => child.name)
        .join(', ')}) are dropped; the picture renders without them.`,
    );
  }
  let crop: ReachDeckImageElementV2['crop'];
  for (const child of drawingChildrenOf(blipFill!)) {
    const name = localName(child.name);
    if (name === 'blip' || IGNORED_SUBTREES.has(name)) continue;
    if (name === 'stretch') {
      const fillRect = drawingChildrenOf(child).find(
        (entry) => localName(entry.name) === 'fillRect',
      );
      const offsets = Object.keys(fillRect?.attributes ?? {}).filter(
        (attribute) => !attribute.startsWith('xmlns'),
      );
      if (offsets.length > 0) {
        return block('Stretch fill offsets are outside the native mapping slice.');
      }
      continue;
    }
    if (name === 'srcRect') {
      // 负值 = 位图内嵌在帧内(边缘留空),与正向裁剪同属原生切片。
      const ratio = (value: string | undefined): number | undefined => {
        if (value === undefined) return 0;
        const parsed = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(parsed) || parsed <= -100_000 || parsed >= 100_000) {
          return undefined;
        }
        return round(parsed / 100_000);
      };
      const left = ratio(child.attributes.l);
      const top = ratio(child.attributes.t);
      const right = ratio(child.attributes.r);
      const bottom = ratio(child.attributes.b);
      if (
        left === undefined ||
        top === undefined ||
        right === undefined ||
        bottom === undefined ||
        left + right >= 1 ||
        top + bottom >= 1
      ) {
        return block('Picture crop values are outside the native mapping slice.');
      }
      if (left !== 0 || top !== 0 || right !== 0 || bottom !== 0) {
        crop = { left, top, right, bottom };
      }
      continue;
    }
    return block(`${child.name} picture fill content is outside the native mapping slice.`);
  }
  const shapeProperties = presentationChildren(xml).find(
    (child) => localName(child.name) === 'spPr',
  );
  const transformElement =
    shapeProperties &&
    drawingChildrenOf(shapeProperties).find((child) => localName(child.name) === 'xfrm');
  let resolved: PptxResolvedTransform2D | undefined;
  try {
    resolved = transformElement === undefined ? undefined : parseTransformElement(transformElement);
  } catch {
    resolved = undefined;
  }
  if (resolved === undefined) {
    return block('Pictures require an explicit transform.');
  }
  let pictureEffectsXml: PptxXmlElement | undefined;
  let pictureStroke: ReachDeckStrokeV2 | undefined;
  // 非矩形几何(预设形状或自定义路径):按轮廓裁剪图片,见下方 shape 映射。
  let pictureClipGeometry: PptxXmlElement | undefined;
  const FILL_ELEMENT_NAMES = new Set(['solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill']);
  for (const child of drawingChildrenOf(shapeProperties!)) {
    const name = localName(child.name);
    if (name === 'xfrm' || IGNORED_SUBTREES.has(name)) continue;
    // a:noFill 位于不透明图片之下,无可见效果。
    if (name === 'noFill') continue;
    if (name === 'prstGeom') {
      if (child.attributes.prst !== 'rect') pictureClipGeometry = child;
      continue;
    }
    if (name === 'custGeom') {
      pictureClipGeometry = child;
      continue;
    }
    // 效果降级:支持的映射到 image.effects,其余 advisory,不丢图片主体。
    if (name === 'effectLst' || name === 'effectDag') {
      pictureEffectsXml = child;
      continue;
    }
    // 填充只在图片透明区域可见:丢样式、保图片。
    if (FILL_ELEMENT_NAMES.has(name)) {
      advisory(
        `Picture ${child.name} background styling is dropped; the picture renders without it.`,
      );
      continue;
    }
    // 图片边框:实色描边直接映射到元素;其余降级 advisory。
    if (name === 'ln') {
      let parsedStroke: PptxStrokeIR | undefined;
      try {
        parsedStroke = parsePptxStrokeElement(child);
      } catch {
        parsedStroke = undefined;
      }
      const strokeFill = parsedStroke?.fill;
      if (strokeFill === undefined || strokeFill.kind === 'none') continue;
      if (strokeFill.kind === 'solid' && pictureStroke === undefined) {
        const strokeDiagnosticsBefore = context.diagnostics.length;
        const resolvedStroke = resolveShapeStroke(context, parsedStroke, undefined, location);
        if (resolvedStroke !== null && resolvedStroke !== undefined) {
          pictureStroke = resolvedStroke;
          continue;
        }
        // 颜色/虚线等解析失败:换 advisory,不让 error 拉低整页。
        context.diagnostics.length = strokeDiagnosticsBefore;
      }
      advisory('Picture outline styling is dropped; the picture renders without it.');
      continue;
    }
    return block(`Picture ${child.name} styling is outside the native mapping slice.`);
  }
  const pictureEffects = resolveElementEffects(
    context,
    pictureEffectsXml,
    undefined,
    location,
    'image',
  );
  // r:embed resolves against the .rels of the part that hosts the pic —
  // for a master/layout decoration that is the master/layout part, not the
  // slide.
  const resourceId = resolveEmbeddedMediaResource(
    context,
    embedId,
    context.sourcePartPath,
    location,
    { subject: 'Picture', block },
  );
  if (resourceId === undefined) return undefined;
  const pictureName = coreProperties?.attributes.name;
  const description = coreProperties?.attributes.descr;
  const hidden =
    coreProperties?.attributes.hidden === '1' || coreProperties?.attributes.hidden === 'true';
  const transform = toDslTransform(resolved);
  const base = {
    id: createStablePptxId('native-element', [
      context.options.applicationId,
      ...context.elementIdScope,
      identityOverride ?? coreProperties?.attributes.id ?? `picture-${index}`,
      nodePath ?? `picture-${index}`,
    ]),
    transform,
    zIndex: index + 1,
    ...(pictureName?.trim() ? { name: pictureName } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(description?.trim() ? { ariaLabel: description } : {}),
    source: {
      partPath: context.sourcePartPath,
      ...(coreProperties?.attributes.id ? { sourceId: coreProperties.attributes.id } : {}),
    },
  };
  if (pictureClipGeometry !== undefined) {
    // 几何裁剪图片 = 按轮廓裁剪的拉伸位图,与 shape 的图片填充同语义:
    // srcRect 裁剪换算为等效的 fillRect 出血/内缩(相对帧尺寸)。
    const bleed = (side: number, visible: number): number =>
      side === 0 ? 0 : round(-side / visible);
    const insets =
      crop === undefined
        ? undefined
        : {
            left: bleed(crop.left, 1 - crop.left - crop.right),
            top: bleed(crop.top, 1 - crop.top - crop.bottom),
            right: bleed(crop.right, 1 - crop.left - crop.right),
            bottom: bleed(crop.bottom, 1 - crop.top - crop.bottom),
          };
    const insetsSupported =
      insets === undefined || Object.values(insets).every((inset) => inset > -10);
    const diagnosticsBefore = context.diagnostics.length;
    const presetName =
      localName(pictureClipGeometry.name) === 'prstGeom'
        ? (pictureClipGeometry.attributes.prst?.trim() ?? '')
        : undefined;
    const presetAdjustments: Record<string, string> = {};
    for (const list of drawingChildrenOf(pictureClipGeometry)) {
      if (presetName === undefined || localName(list.name) !== 'avLst') continue;
      for (const guide of list.children) {
        const { name: guideName, fmla } = guide.attributes;
        if (localName(guide.name) === 'gd' && guideName !== undefined && fmla !== undefined) {
          presetAdjustments[guideName.trim()] = fmla.trim();
        }
      }
    }
    const geometry = !insetsSupported
      ? undefined
      : presetName === undefined
        ? mapCustomGeometry(context, pictureClipGeometry, transform, location)
        : presetName === ''
          ? undefined
          : resolvePresetGeometry(context, presetName, presetAdjustments, transform, location);
    if (
      geometry !== undefined &&
      !hasBlockingPptxDiagnostics(context.diagnostics.slice(diagnosticsBefore))
    ) {
      return {
        ...base,
        type: 'shape',
        geometry,
        style: {
          fill: {
            kind: 'image',
            resourceId,
            mode: 'stretch',
            ...(insets === undefined ? {} : { insets }),
          },
          ...(pictureStroke === undefined ? {} : { stroke: pictureStroke }),
          ...(pictureEffects === undefined ? {} : { effects: pictureEffects }),
        },
      };
    }
    // 几何超出原生切片:撤回几何错误,图片按外接矩形渲染,不丢主体。
    context.diagnostics.length = diagnosticsBefore;
    advisory(
      `Picture geometry ${presetName === undefined ? 'a:custGeom' : presetName || '(none)'} is dropped; the picture renders in its bounding box.`,
    );
  }
  return {
    ...base,
    type: 'image',
    resourceId,
    // a:stretch fills the frame with the (cropped) bitmap, matching CSS fill.
    fit: 'stretch',
    ...(crop === undefined ? {} : { crop }),
    alt: description?.trim() ? description : pictureName?.trim() ? pictureName : 'Imported image',
    ...(pictureStroke === undefined ? {} : { stroke: pictureStroke }),
    ...(pictureEffects === undefined ? {} : { effects: pictureEffects }),
  };
}

// ---------------------------------------------------------------------------
// Text frames
// ---------------------------------------------------------------------------

interface MergedBodyProperties {
  margins: { left: number; top: number; right: number; bottom: number };
  verticalAlignment: 'top' | 'middle' | 'bottom';
  wrap: boolean;
  columns?: number;
  orientation?: 'vertical';
  autofit: ReachDeckTextFrameV2['autofit'];
}

function mapTextFrame(
  context: SlideContext,
  node: PptxShapeNodeIR,
  inherited: PptxInheritedShapeProperties,
  references: ShapeStyleReferences,
  location: { partPath: string; slideId?: string; nodePath?: string },
): ReachDeckTextFrameV2 | undefined {
  const text = node.text!;
  const body = mergeBodyProperties(context, text, inherited, location);
  if (body === undefined) return undefined;
  const category = pptxPlaceholderCategory(node.placeholder);
  const fontReferenceColor = resolveFontReferenceColor(context, references, location);
  if (fontReferenceColor === null) return undefined;
  const fontSet = resolveFontReferenceSet(context, references);
  // Imported text is constrained to the platform font catalog: every run's
  // typeface resolves into it, and the substitutions taken are recorded here.
  const fontSubstitutions = new Map<string, ReachDeckFontSubstitutionV2>();
  const paragraphs: MappedTextParagraph[] = [];
  for (const paragraph of text.paragraphs) {
    if (paragraph.unknownChildren.some((child) => !IGNORED_SUBTREES.has(localName(child.name)))) {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.text_unsupported',
          'text-frame',
          'Paragraph contains content outside the native mapping slice.',
          location,
        ),
      );
      return undefined;
    }
    const level = Number.parseInt(paragraph.properties?.level ?? '0', 10) || 0;
    const chainElements = collectPptxParagraphStyleChain(
      context.inheritance,
      category,
      inherited,
      text.listStyleXml,
      level,
    );
    const chain: PptxTextParagraphPropertiesIR[] = [];
    for (const element of chainElements) {
      try {
        chain.push(parsePptxParagraphPropertiesElement(element));
      } catch {
        // Malformed inherited style levels contribute nothing rather than block.
      }
    }
    if (paragraph.properties !== undefined) chain.push(paragraph.properties);
    const mapped = mapParagraph(
      context,
      chain,
      paragraph.runs,
      fontSet,
      fontReferenceColor,
      fontSubstitutions,
      location,
    );
    if (mapped === undefined) return undefined;
    paragraphs.push(mapped);
  }
  if (text.unknownChildren.some((child) => !IGNORED_SUBTREES.has(localName(child.name)))) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.text_unsupported',
        'text-frame',
        'Text body contains content outside the native mapping slice.',
        location,
      ),
    );
    return undefined;
  }
  return {
    margins: body.margins,
    verticalAlignment: body.verticalAlignment,
    wrap: body.wrap,
    ...(body.columns === undefined ? {} : { columns: body.columns }),
    ...(body.orientation === undefined ? {} : { orientation: body.orientation }),
    autofit: body.autofit,
    doc: assembleRichTextDoc(paragraphs),
    fontSubstitutions: [...fontSubstitutions.values()],
  };
}

/** One source paragraph, ready to be assembled into the shared rich-text doc. */
interface MappedTextParagraph {
  paragraph: RichTextNode;
  list?: { kind: 'bullet' | 'number'; level: number };
}

/**
 * Assemble paragraph nodes into a v1 rich-text document, grouping consecutive
 * list paragraphs into (nested) bulletList/orderedList structures.
 */
function assembleRichTextDoc(paragraphs: readonly MappedTextParagraph[]): RichTextDocument {
  const content: RichTextNode[] = [];
  // Stack of open list nodes, one per nesting level.
  let stack: { node: RichTextNode; kind: 'bullet' | 'number' }[] = [];
  const flush = () => {
    stack = [];
  };
  for (const entry of paragraphs) {
    if (entry.list === undefined) {
      flush();
      content.push(entry.paragraph);
      continue;
    }
    const targetDepth = Math.min(entry.list.level, stack.length);
    stack = stack.slice(0, targetDepth + 1);
    let current = stack[stack.length - 1];
    if (
      current === undefined ||
      stack.length < targetDepth + 1 ||
      current.kind !== entry.list.kind
    ) {
      if (
        current !== undefined &&
        current.kind !== entry.list.kind &&
        stack.length === targetDepth + 1
      ) {
        stack.pop();
        current = stack[stack.length - 1];
      }
      while (stack.length < targetDepth + 1) {
        const listNode: RichTextNode = {
          type: entry.list.kind === 'bullet' ? 'bulletList' : 'orderedList',
          content: [],
        };
        const parent = stack[stack.length - 1];
        if (parent === undefined) {
          content.push(listNode);
        } else {
          // Nested lists live inside the previous list item.
          const items = parent.node.content!;
          const lastItem = items[items.length - 1];
          if (lastItem === undefined) {
            content.push(listNode);
          } else {
            lastItem.content = [...(lastItem.content ?? []), listNode];
          }
        }
        stack.push({ node: listNode, kind: entry.list.kind });
      }
      current = stack[stack.length - 1]!;
    }
    current.node.content!.push({ type: 'listItem', content: [entry.paragraph] });
  }
  return { type: 'doc', content };
}

function mapParagraph(
  context: SlideContext,
  chain: readonly PptxTextParagraphPropertiesIR[],
  runs: PptxTextBodyIR['paragraphs'][number]['runs'],
  fontSet: 'major' | 'minor',
  fontReferenceColor: Extract<ReachDeckColorV2, { kind: 'srgb' }> | undefined,
  fontSubstitutions: Map<string, ReachDeckFontSubstitutionV2>,
  location: { partPath: string; slideId?: string; nodePath?: string },
): MappedTextParagraph | undefined {
  const nearest = <T>(select: (properties: PptxTextParagraphPropertiesIR) => T | undefined) => {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const value = select(chain[index]!);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const alignmentToken = nearest((properties) => properties.alignment);
  let alignment = mapAlignment(alignmentToken);
  if (alignment === undefined) {
    // `dist`/`justLow`/`thaiDist` are justification variants; the contract has
    // one justify. Approximating keeps the paragraph instead of dropping the
    // whole text frame over a spacing nuance.
    alignment = 'justify';
    context.diagnostics.push(
      diagnostic(
        'warning',
        'pptx.mapper.text_simplified',
        'text-frame',
        `Paragraph alignment ${alignmentToken} has no equivalent in the shared rich-text contract; the paragraph renders justified.`,
        location,
      ),
    );
  }
  const lineSpacing = mapSpacing(nearest((properties) => properties.lineSpacing));
  const spaceBefore = mapSpacing(nearest((properties) => properties.spaceBefore));
  const spaceAfter = mapSpacing(nearest((properties) => properties.spaceAfter));
  // PPTX spcPct 段前/段后是行高的百分比;行高按段内最大字号 × 1.2 单倍行距换算
  // 为舞台像素,与共享 rich-text 合约的绝对 spaceBefore/After 对齐。
  const referenceFontSize = paragraphFontSizePoints(chain, runs);
  const spacingPoints = (spacing: SpacingValue | undefined): number | undefined => {
    if (spacing?.points !== undefined) return spacing.points;
    if (spacing?.multiplier !== undefined && spacing.multiplier > 0) {
      return round(spacing.multiplier * referenceFontSize * 1.2);
    }
    return undefined;
  };
  const spaceBeforePoints = spacingPoints(spaceBefore);
  const spaceAfterPoints = spacingPoints(spaceAfter);
  // Tab stops position text within the line; the shared rich-text contract has
  // no equivalent, so tabs collapse to their whitespace. The words stay —
  // dropping the paragraph would lose the sentence to keep its alignment.
  const tabs = nearest((properties) => (properties.tabs.length > 0 ? properties.tabs : undefined));
  if (tabs !== undefined) {
    context.diagnostics.push(
      diagnostic(
        'warning',
        'pptx.mapper.text_simplified',
        'text-frame',
        'Custom tab stops have no equivalent in the shared rich-text contract; the text keeps its content but not its tab alignment.',
        location,
      ),
    );
  }
  const bullet = nearest((properties) => properties.bullet);
  const level = Number.parseInt(nearest((properties) => properties.level) ?? '0', 10) || 0;

  let list: MappedTextParagraph['list'];
  let leftIndentPoints: number | undefined;
  let rightIndentPoints: number | undefined;
  let firstLineIndentPoints: number | undefined;
  if (bullet !== undefined && bullet.kind !== 'none' && runs.length > 0) {
    if (bullet.kind === 'image') {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.text_unsupported',
          'text-frame',
          'Image bullets are outside the shared rich-text contract.',
          location,
        ),
      );
      return undefined;
    }
    list = { kind: bullet.kind === 'character' ? 'bullet' : 'number', level };
  } else {
    // 非列表段落缩进映射到共享 rich-text 的段级缩进属性:
    // marL → margin-left、marR → margin-right、indent → text-indent(负值 = 悬挂)。
    const leftMargin = nearest((properties) => properties.leftMargin);
    const rightMargin = nearest((properties) => properties.rightMargin);
    const indent = nearest((properties) => properties.indent);
    const marginPoints = leftMargin === undefined ? 0 : round(emuToPoints(leftMargin));
    const rightPoints = rightMargin === undefined ? 0 : round(emuToPoints(rightMargin));
    const indentPoints = indent === undefined ? 0 : round(emuToPoints(indent));
    if (runs.length > 0) {
      if (marginPoints > 0) leftIndentPoints = marginPoints;
      if (rightPoints > 0) rightIndentPoints = rightPoints;
      if (indentPoints !== 0) firstLineIndentPoints = indentPoints;
    }
  }

  const inline: RichTextNode[] = [];
  for (const run of runs) {
    if (run.kind === 'break') {
      inline.push({ type: 'hardBreak' });
      continue;
    }
    if (run.kind === 'math') {
      // The equation keeps its markup: editable, searchable and sharp at any
      // zoom, where the PowerPoint fallback was a picture of itself.
      inline.push({
        type: run.display ? 'blockMath' : 'inlineMath',
        attrs: { latex: run.latex },
      });
      continue;
    }
    if (run.text.length === 0) continue;
    const marks = resolveRunMarks(
      context,
      chain
        .map((properties) => properties.defaultRunProperties)
        .filter((value): value is PptxTextRunPropertiesIR => value !== undefined),
      run.properties,
      fontSet,
      fontReferenceColor,
      fontSubstitutions,
      location,
    );
    if (marks === undefined) return undefined;
    inline.push({ type: 'text', text: run.text, ...(marks.length > 0 ? { marks } : {}) });
  }

  const attrs: Record<string, unknown> = {
    ...(alignment === 'left' ? {} : { textAlign: alignment }),
    // PPTX spcPct is relative to PowerPoint's single-spacing line (≈1.2em);
    // the shared rich-text lineHeight is a CSS multiplier of the font size.
    // spcPts 绝对行距直接落到 lineHeightPx(舞台像素 = pt)。
    ...(lineSpacing?.multiplier !== undefined
      ? { lineHeight: round(lineSpacing.multiplier * 1.2) }
      : {}),
    ...(lineSpacing?.points !== undefined ? { lineHeightPx: lineSpacing.points } : {}),
    ...(spaceBeforePoints !== undefined && spaceBeforePoints > 0
      ? { spaceBefore: spaceBeforePoints }
      : {}),
    ...(spaceAfterPoints !== undefined && spaceAfterPoints > 0
      ? { spaceAfter: spaceAfterPoints }
      : {}),
    ...(leftIndentPoints === undefined ? {} : { leftIndent: leftIndentPoints }),
    ...(rightIndentPoints === undefined ? {} : { rightIndent: rightIndentPoints }),
    ...(firstLineIndentPoints === undefined ? {} : { firstLineIndent: firstLineIndentPoints }),
  };
  return {
    paragraph: {
      type: 'paragraph',
      ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      ...(inline.length > 0 ? { content: inline } : {}),
    },
    ...(list === undefined ? {} : { list }),
  };
}

/**
 * PowerPoint 段前/段后百分比(spcPct)基于行高;行高取段内最大有效字号。
 * 直接字号缺省时回退样式链默认字号,最终回退 18pt。
 */
function paragraphFontSizePoints(
  chain: readonly PptxTextParagraphPropertiesIR[],
  runs: PptxTextBodyIR['paragraphs'][number]['runs'],
): number {
  const chainSize = (() => {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const token = chain[index]!.defaultRunProperties?.fontSize;
      if (token !== undefined) {
        const value = Number.parseInt(token, 10) / 100;
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
    return undefined;
  })();
  let maximum: number | undefined;
  for (const run of runs) {
    const token = run.properties?.fontSize;
    const size = token === undefined ? chainSize : Number.parseInt(token, 10) / 100;
    if (size !== undefined && Number.isFinite(size) && (maximum === undefined || size > maximum)) {
      maximum = size;
    }
  }
  return maximum ?? chainSize ?? 18;
}

function mapAlignment(
  token: string | undefined,
): 'left' | 'center' | 'right' | 'justify' | undefined {
  switch (token) {
    case undefined:
    case 'l':
      return 'left';
    case 'ctr':
      return 'center';
    case 'r':
      return 'right';
    case 'just':
      return 'justify';
    default:
      return undefined;
  }
}

function mergeBodyProperties(
  context: SlideContext,
  text: PptxTextBodyIR,
  inherited: PptxInheritedShapeProperties,
  location: { partPath: string; slideId?: string; nodePath?: string },
): MergedBodyProperties | undefined {
  // Farthest-first so nearer declarations override.
  const sources = [...[...inherited.bodyProperties].reverse(), text.properties.xml];
  const attributes: Record<string, string> = {};
  let autofitElement: PptxXmlElement | undefined;
  for (const source of sources) {
    for (const [name, value] of Object.entries(source.attributes)) {
      if (!name.startsWith('xmlns')) attributes[name] = value;
    }
    const declaredAutofit = source.children.find((child) =>
      ['noAutofit', 'normAutofit', 'spAutoFit'].includes(localName(child.name)),
    );
    if (declaredAutofit !== undefined) autofitElement = declaredAutofit;
  }
  // bodyPr vert 竖排文本映射为帧级 orientation;各竖排变体统一按东亚竖排
  // (自上而下、行从右往左)近似渲染。
  const orientation: 'vertical' | undefined =
    attributes.vert !== undefined && attributes.vert !== 'horz' ? 'vertical' : undefined;
  const emuAttr = (name: string, fallback: number): number => {
    if (attributes[name] === undefined) return fallback;
    const margin = round(emuToPoints(pptxEmu(attributes[name])));
    if (margin < 0) {
      context.diagnostics.push(
        diagnostic(
          'warning',
          'pptx.mapper.text_margin_simplified',
          'text-frame',
          `Negative text inset ${name} imports as zero; text overflow beyond the frame is not preserved.`,
          location,
        ),
      );
      return 0;
    }
    return margin;
  };
  const verticalAlignment =
    attributes.anchor === 'ctr' ? 'middle' : attributes.anchor === 'b' ? 'bottom' : 'top';
  let autofit: ReachDeckTextFrameV2['autofit'] = { mode: 'none' };
  if (autofitElement !== undefined) {
    const autofitName = localName(autofitElement.name);
    if (autofitName === 'spAutoFit') autofit = { mode: 'resize-shape' };
    else if (autofitName === 'normAutofit') {
      const scale = (name: 'fontScale' | 'lnSpcReduction'): number | undefined => {
        const raw = autofitElement.attributes[name];
        if (raw === undefined) return undefined;
        let value: number | undefined;
        try {
          value = round(ooxmlPercentageToRatio({ unit: 'ooxml-percentage', raw }));
        } catch {
          value = undefined;
        }
        if (
          value !== undefined &&
          value >= 0 &&
          value <= 1 &&
          (name !== 'fontScale' || value > 0)
        ) {
          return value;
        }
        context.diagnostics.push(
          diagnostic(
            'warning',
            'pptx.mapper.text_autofit_simplified',
            'text-frame',
            `Invalid text autofit ${name} is ignored; shrink-text mode is preserved.`,
            location,
          ),
        );
        return undefined;
      };
      const fontScale = scale('fontScale');
      const lineSpacingReduction = scale('lnSpcReduction');
      autofit = {
        mode: 'shrink-text',
        ...(fontScale === undefined ? {} : { fontScale }),
        ...(lineSpacingReduction === undefined ? {} : { lineSpacingReduction }),
      };
    }
  }
  const columns = Number.parseInt(attributes.numCol ?? '1', 10);
  return {
    margins: {
      left: emuAttr('lIns', 7.2),
      top: emuAttr('tIns', 3.6),
      right: emuAttr('rIns', 7.2),
      bottom: emuAttr('bIns', 3.6),
    },
    verticalAlignment,
    wrap: attributes.wrap !== 'none',
    ...(Number.isSafeInteger(columns) && columns > 1 ? { columns } : {}),
    ...(orientation === undefined ? {} : { orientation }),
    autofit,
  };
}

function resolveFontReferenceColor(
  context: SlideContext,
  references: ShapeStyleReferences,
  location: { partPath: string; slideId?: string; nodePath?: string },
): Extract<ReachDeckColorV2, { kind: 'srgb' }> | undefined | null {
  if (references.fontReference === undefined) return undefined;
  let color: PptxColorIR;
  try {
    color = parsePptxColorContainer(references.fontReference);
  } catch {
    return undefined;
  }
  const resolved = resolveColorIr(context, color, location);
  return resolved === undefined ? null : resolved;
}

function resolveFontReferenceSet(
  context: SlideContext,
  references: ShapeStyleReferences,
): 'major' | 'minor' {
  return references.fontReference?.attributes.idx === 'major' ? 'major' : 'minor';
}

interface SpacingValue {
  points?: number;
  multiplier?: number;
}

function mapSpacing(
  spacing: PptxTextParagraphPropertiesIR['lineSpacing'],
): SpacingValue | undefined {
  if (spacing === undefined) return undefined;
  if (spacing.kind === 'points') {
    return { points: round(Number.parseInt(spacing.value, 10) / 100) };
  }
  return { multiplier: round(ooxmlPercentageToRatio(spacing.value)) };
}

const CJK_SCRIPTS: Record<string, string> = {
  'zh-cn': 'Hans',
  'zh-sg': 'Hans',
  'zh-hans': 'Hans',
  zh: 'Hans',
  'zh-tw': 'Hant',
  'zh-hk': 'Hant',
  'zh-mo': 'Hant',
  'zh-hant': 'Hant',
  ja: 'Jpan',
  'ja-jp': 'Jpan',
  ko: 'Hang',
  'ko-kr': 'Hang',
};

/** Resolve one run's typography into shared rich-text marks. */
function resolveRunMarks(
  context: SlideContext,
  defaultChain: readonly PptxTextRunPropertiesIR[],
  direct: PptxTextRunPropertiesIR | undefined,
  fontSet: 'major' | 'minor',
  fontReferenceColor: Extract<ReachDeckColorV2, { kind: 'srgb' }> | undefined,
  fontSubstitutions: Map<string, ReachDeckFontSubstitutionV2>,
  location: { partPath: string; slideId?: string; nodePath?: string },
): RichTextMark[] | undefined {
  const chain = direct === undefined ? defaultChain : [...defaultChain, direct];
  const nearest = <T>(select: (properties: PptxTextRunPropertiesIR) => T | undefined) => {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const value = select(chain[index]!);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const language = nearest((properties) => properties.language) ?? context.options.language;
  const script = CJK_SCRIPTS[language.toLowerCase()];
  const preferEastAsia = script !== undefined;
  const latinTypeface = nearest((properties) => properties.typefaces.latin);
  const eastAsiaTypeface = nearest((properties) => properties.typefaces.eastAsia);
  const requestedFamily = resolveTypeface(
    context,
    preferEastAsia ? (eastAsiaTypeface ?? latinTypeface) : latinTypeface,
    preferEastAsia ? 'eastAsia' : 'latin',
    script,
    fontSet,
  );
  if (requestedFamily === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.font.unresolved',
        'font-substitution',
        'No deterministic theme font is available for this run.',
        location,
        { language },
      ),
    );
    return undefined;
  }
  // Constrain the requested family to the platform font catalog so rendering
  // never depends on viewer machine fonts. Substitutions are recorded on the
  // frame; an uncovered family blocks rather than silently passing through.
  const catalog = context.options.fontCatalog ?? REACH_PPTX_FONT_CATALOG;
  const catalogResolution = resolvePptxCatalogFamily(
    catalog,
    requestedFamily,
    preferEastAsia ? 'eastAsia' : 'latin',
  );
  if (catalogResolution === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.font.unresolved',
        'font-substitution',
        `No platform font covers ${requestedFamily} (catalog ${catalog.version}).`,
        location,
        { requestedFamily },
      ),
    );
    return undefined;
  }
  const family = catalogResolution.resolvedFamily;
  if (catalogResolution.reason !== 'requested-available') {
    fontSubstitutions.set(`${catalogResolution.requestedFamily} ${family}`, {
      requestedFamily: catalogResolution.requestedFamily,
      resolvedFamily: family,
      reason:
        catalogResolution.reason === 'catalog-substitution'
          ? 'configured-substitute'
          : 'system-fallback',
      metricsDigest: `catalog:${catalog.version}`,
    });
  }

  const sizeToken = nearest((properties) => properties.fontSize);
  if (sizeToken === undefined) {
    // No invented defaults: every run must resolve a size somewhere in the
    // presentation/master/layout/shape/run style chain.
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.font_size_unresolved',
        'text-frame',
        'No font size is resolvable from the document style chain for this run.',
        location,
      ),
    );
    return undefined;
  }
  const fontSize = round(Number.parseInt(sizeToken, 10) / 100);

  const colorFromChain = (() => {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const runColor = runPropertiesColor(chain[index]!);
      if (runColor !== undefined) return runColor;
    }
    return undefined;
  })();
  let color: Extract<ReachDeckColorV2, { kind: 'srgb' }> | undefined;
  const directColor = direct === undefined ? undefined : runPropertiesColor(direct);
  if (directColor !== undefined) {
    color = resolveColorIr(context, directColor, location);
    if (color === undefined) return undefined;
  } else if (fontReferenceColor !== undefined) {
    color = fontReferenceColor;
  } else if (colorFromChain !== undefined) {
    color = resolveColorIr(context, colorFromChain, location);
    if (color === undefined) return undefined;
  } else {
    const themeInk = resolvePptxColor(
      { kind: 'scheme', token: 'tx1', modifiers: [] },
      context.inheritance.schemeContext,
    );
    // Decks without a theme color scheme use the compatibility ink color.
    color = themeInk.ok
      ? {
          kind: 'srgb',
          value: themeInk.color.hex,
          ...(themeInk.color.alpha >= 1 ? {} : { alpha: round(themeInk.color.alpha) }),
        }
      : { kind: 'srgb', value: context.options.compatibilityTheme.ink };
  }

  const underlineToken = nearest((properties) => properties.underline);
  const underline =
    underlineToken === undefined || underlineToken === 'none'
      ? undefined
      : underlineToken === 'sng'
        ? 'single'
        : underlineToken === 'dbl'
          ? 'double'
          : null;
  if (underline === null) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.text_unsupported',
        'text-frame',
        `Underline style ${underlineToken} is outside the native mapping slice.`,
        location,
      ),
    );
    return undefined;
  }
  const strikeToken = nearest((properties) => properties.strike);
  if (strikeToken !== undefined && !['noStrike', 'sngStrike'].includes(strikeToken)) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.text_unsupported',
        'text-frame',
        `Strike style ${strikeToken} is outside the native mapping slice.`,
        location,
      ),
    );
    return undefined;
  }
  const baselineToken = nearest((properties) => properties.baseline);
  const baselineValue = baselineToken === undefined ? 0 : Number.parseInt(baselineToken, 10) || 0;
  // rPr spc 单位是 1/100 pt;映射为 textStyle 的 letterSpacing(舞台像素)。
  const spacingToken = nearest((properties) => properties.characterSpacing);
  const letterSpacing =
    spacingToken === undefined ? 0 : round((Number.parseInt(spacingToken, 10) || 0) / 100);
  const bold = nearest((properties) => properties.bold);
  const italic = nearest((properties) => properties.italic);
  const cssColor =
    color.alpha === undefined || color.alpha >= 1
      ? color.value
      : `rgba(${Number.parseInt(color.value.slice(1, 3), 16)}, ${Number.parseInt(color.value.slice(3, 5), 16)}, ${Number.parseInt(color.value.slice(5, 7), 16)}, ${color.alpha})`;
  const marks: RichTextMark[] = [
    {
      type: 'textStyle',
      attrs: {
        fontFamily: family,
        fontSize: `${fontSize}px`,
        color: cssColor,
        ...(letterSpacing === 0 ? {} : { letterSpacing }),
      },
    },
  ];
  if (bold === true) marks.push({ type: 'bold' });
  if (italic === true) marks.push({ type: 'italic' });
  if (underline !== undefined) marks.push({ type: 'underline' });
  if (strikeToken === 'sngStrike') marks.push({ type: 'strike' });
  if (baselineValue > 0) marks.push({ type: 'superscript' });
  if (baselineValue < 0) marks.push({ type: 'subscript' });
  return marks;
}

function runPropertiesColor(properties: PptxTextRunPropertiesIR): PptxColorIR | undefined {
  const solidFill = properties.xml.children.find(
    (child) =>
      localName(child.name) === 'solidFill' && DRAWING_NAMESPACES.has(child.namespaceUri ?? ''),
  );
  if (solidFill === undefined) return undefined;
  try {
    return parsePptxColorContainer(solidFill);
  } catch {
    return undefined;
  }
}

function resolveTypeface(
  context: SlideContext,
  typeface: string | undefined,
  role: 'latin' | 'eastAsia',
  script: string | undefined,
  fontSet: 'major' | 'minor',
): string | undefined {
  const themeSet = (set: 'major' | 'minor'): PptxThemeFontResolution =>
    resolvePptxThemeFontSet(context.inheritance, set);
  // No invented defaults: an unresolvable typeface blocks instead of
  // silently falling back to a product font.
  const resolveFromTheme = (set: 'major' | 'minor'): string | undefined => {
    const fonts = themeSet(set);
    if (role === 'eastAsia') {
      if (fonts.eastAsia !== undefined && fonts.eastAsia.length > 0) return fonts.eastAsia;
      if (script !== undefined && fonts.supplemental[script] !== undefined) {
        return fonts.supplemental[script];
      }
    }
    return fonts.latin;
  };
  if (typeface === undefined || typeface.length === 0) return resolveFromTheme(fontSet);
  if (typeface.startsWith('+')) {
    const set = typeface.startsWith('+mj') ? 'major' : 'minor';
    return resolveFromTheme(set);
  }
  return typeface;
}

// ---------------------------------------------------------------------------
// Speaker notes
// ---------------------------------------------------------------------------

function mapSlideNotes(context: SlideContext): ReachDeckSpeakerNotesV2 | undefined {
  const slide = context.slide;
  if (slide.notesPartPath === undefined) return undefined;
  const notes = context.ir.notes.find((candidate) => candidate.partPath === slide.notesPartPath);
  const location = { partPath: slide.notesPartPath, slideId: slide.id };
  if (notes === undefined) {
    context.diagnostics.push(
      diagnostic(
        'error',
        'pptx.mapper.notes_unsupported',
        'notes',
        'The referenced notes slide part could not be inventoried.',
        location,
      ),
    );
    return undefined;
  }
  const commonSlideData = presentationChildren(notes.xml).find(
    (child) => localName(child.name) === 'cSld',
  );
  const shapeTree =
    commonSlideData &&
    presentationChildren(commonSlideData).find((child) => localName(child.name) === 'spTree');
  const paragraphs: RichTextNode[] = [];
  for (const child of shapeTree?.children ?? []) {
    const name = localName(child.name);
    if (name === 'nvGrpSpPr' || name === 'grpSpPr' || IGNORED_SUBTREES.has(name)) continue;
    if (name !== 'sp') {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.notes_unsupported',
          'notes',
          `${child.name} in speaker notes is outside the native mapping slice.`,
          location,
        ),
      );
      return undefined;
    }
    const nonVisual = presentationChildren(child).find(
      (candidate) => localName(candidate.name) === 'nvSpPr',
    );
    const nvPr =
      nonVisual &&
      presentationChildren(nonVisual).find((candidate) => localName(candidate.name) === 'nvPr');
    const placeholder =
      nvPr && presentationChildren(nvPr).find((candidate) => localName(candidate.name) === 'ph');
    const placeholderType = placeholder?.attributes.type;
    if (placeholderType !== 'body') continue;
    const textBody = presentationChildren(child).find(
      (candidate) => localName(candidate.name) === 'txBody',
    );
    for (const paragraphXml of textBody?.children ?? []) {
      if (localName(paragraphXml.name) !== 'p') continue;
      const paragraph = mapPlainNotesParagraph(context, paragraphXml, location);
      if (paragraph === undefined) return undefined;
      paragraphs.push(paragraph);
    }
  }
  return paragraphs.length === 0 ? undefined : { doc: { type: 'doc', content: paragraphs } };
}

function mapPlainNotesParagraph(
  context: SlideContext,
  paragraphXml: PptxXmlElement,
  location: { partPath: string; slideId?: string },
): RichTextNode | undefined {
  const inline: RichTextNode[] = [];
  for (const child of paragraphXml.children) {
    const name = localName(child.name);
    if (['pPr', 'endParaRPr'].includes(name) || IGNORED_SUBTREES.has(name)) continue;
    if (name === 'br') {
      inline.push({ type: 'hardBreak' });
      continue;
    }
    if (name !== 'r' && name !== 'fld') {
      context.diagnostics.push(
        diagnostic(
          'error',
          'pptx.mapper.notes_unsupported',
          'notes',
          `${child.name} in speaker notes is outside the native mapping slice.`,
          location,
        ),
      );
      return undefined;
    }
    const textElement = child.children.find((candidate) => localName(candidate.name) === 't');
    const text = textElement?.text ?? '';
    if (text.length > 0) inline.push({ type: 'text', text });
  }
  return { type: 'paragraph', ...(inline.length > 0 ? { content: inline } : {}) };
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function buildDocument(
  context: MappingContext,
  stage: ReachDeckDocumentV2['stage'],
  mappedSlides: readonly MappedSlide[],
): ReachDeckDocumentV2 {
  const themeId = createStablePptxId('theme', [context.options.applicationId, 'compatibility']);
  const pages = mappedSlides.map(({ slide, background }, index) => {
    const pageId = createStablePptxId('page', [
      context.options.applicationId,
      slide.partPath,
      slide.id,
    ]);
    const title = `Slide ${slide.order}`;
    return {
      pageId,
      // Skipped (error) pages leave gaps in the source numbering; page order
      // must stay contiguous, while the title keeps the source slide number.
      order: index + 1,
      revision: 1,
      sceneType: 'slide' as const,
      title,
    };
  });
  const nativeSlides = mappedSlides.map(({ slide, background, elements, notes }, index) => ({
    pageId: pages[index]!.pageId,
    slide: {
      schemaVersion: 'reach-deck-slide/v2' as const,
      textCompatibility: 'pptx' as const,
      id: createStablePptxId('native-slide', [
        context.options.applicationId,
        slide.partPath,
        slide.id,
      ]),
      title: pages[index]!.title,
      background,
      elements,
      ...(notes === undefined ? {} : { notes }),
      animations: [],
      duration: REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
    },
  }));
  const theme = context.options.compatibilityTheme;
  return parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: context.options.documentId,
    title: context.options.title,
    stage,
    theme,
    defaultThemeId: themeId,
    resources: {
      themes: [
        {
          id: themeId,
          name: theme.name,
          colors: {
            background: theme.background,
            surface: theme.surface,
            ink: theme.ink,
            muted: theme.muted,
            accent: theme.accent,
            success: theme.success,
            warning: theme.warning,
          },
          fonts: { display: theme.fontDisplay, body: theme.fontBody },
        },
      ],
      masters: [],
      layouts: [],
      media: [...context.media.values()].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    },
    metadata: {
      source: 'import',
      language: context.options.language,
      generatedAt: context.options.generatedAt,
      contentDigest: `draft:pptx:${context.ir.sourceDigest}:${context.options.applicationId}`,
    },
    provenance: {
      source: 'pptx',
      sourceDigest: context.ir.sourceDigest,
      importerVersion: PPTX_IMPORTER_VERSION,
    },
    revisions: [],
    pages,
    nativeSlides,
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Severity contract for mapper diagnostics (the preflight gate reads it):
 * - `info` — the target model has no equivalent semantics; nothing visible is
 *   lost (animation timelines, OLE payloads whose picture fallback maps).
 * - `warning` — the element stays but renders degraded (dropped effects,
 *   approximated dash/gradient, dropped hyperlink).
 * - `error` — an element or the whole page is actually missing from the
 *   candidate document.
 * Only `error`/`fatal` block a clean apply.
 */
function diagnostic(
  severity: PptxDiagnostic['severity'],
  code: `pptx.${string}`,
  feature: PptxDiagnostic['feature'],
  message: string,
  location: PptxDiagnostic['location'],
  details?: PptxDiagnostic['details'],
): PptxDiagnostic {
  return {
    code,
    severity,
    feature,
    message,
    ...(location === undefined ? {} : { location }),
    ...(details === undefined ? {} : { details }),
  };
}

function presentationChildren(element: PptxXmlElement): PptxXmlElement[] {
  return element.children.filter((child) => PRESENTATION_NAMESPACES.has(child.namespaceUri ?? ''));
}

function drawingChildrenOf(element: PptxXmlElement): PptxXmlElement[] {
  return element.children.filter((child) => DRAWING_NAMESPACES.has(child.namespaceUri ?? ''));
}

function chartChildrenOf(element: PptxXmlElement): PptxXmlElement[] {
  return element.children.filter((child) => CHART_NAMESPACES.has(child.namespaceUri ?? ''));
}

function relationshipIdAttributeEntry(
  element: PptxXmlElement | undefined,
): readonly [string, string] | undefined {
  if (element === undefined) return undefined;
  return Object.entries(element.attributes).find(([name]) => {
    const separator = name.indexOf(':');
    if (separator < 1 || localName(name) !== 'id') return false;
    const prefix = name.slice(0, separator);
    return OFFICE_DOCUMENT_RELATIONSHIP_NAMESPACES.has(element.namespaces?.[prefix] ?? '');
  });
}

function relationshipIdAttribute(element: PptxXmlElement | undefined): string | undefined {
  return relationshipIdAttributeEntry(element)?.[1];
}

function directFillOf(element: PptxXmlElement): PptxFillIR | undefined {
  const fillNames = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']);
  const fills = drawingChildrenOf(element).filter((child) => fillNames.has(localName(child.name)));
  if (fills.length > 1) throw new Error('Background declares multiple fills.');
  return fills[0] === undefined ? undefined : parsePptxFillElement(fills[0]);
}

function featureForSlideChild(child: PptxXmlElement): PptxDiagnostic['feature'] {
  switch (localName(child.name)) {
    case 'transition':
      return 'transition';
    case 'timing':
      return 'animation';
    default:
      return 'unknown-ooxml';
  }
}

function localName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);
}

/** True when the attribute's prefix resolves to the ECMA-376 MCE namespace. */
function isMarkupCompatibilityAttribute(element: PptxXmlElement, attribute: string): boolean {
  const separator = attribute.indexOf(':');
  if (separator < 1) return false;
  const prefix = attribute.slice(0, separator);
  return MARKUP_COMPATIBILITY_NAMESPACES.has(element.namespaces?.[prefix] ?? '');
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
