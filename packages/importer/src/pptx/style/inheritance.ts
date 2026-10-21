/**
 * Deterministic OOXML inheritance resolution for the native Reach Deck mapper:
 * master color maps, placeholder lookup, the 7-level text style chain, and the
 * theme format-scheme (fillStyleLst/lnStyleLst/bgFillStyleLst) style matrix.
 *
 * The chain ordering and placeholder matching rules are adapted from
 * OpenMAIC's PPTX importer (`serializer/textSerializer.ts`,
 * `serializer/StyleResolver.ts`) at commit
 * 63fc81d8e1e8e13d04106618ef29f713541a520e (MIT license; see
 * THIRD_PARTY_NOTICES.md).
 */

import type {
  PptxPresentationIR,
  PptxSlideIR,
  PptxSlideLayoutIR,
  PptxSlideMasterIR,
  PptxThemeIR,
} from '../ir.js';
import type { PptxXmlElement } from '../package/xml.js';
import type { PptxPlaceholderIR } from '../model/slide-node.js';
import { createPptxSchemeColorContext, type PptxSchemeColorContext } from './color-resolution.js';
import { parsePptxDirectShapeStyle, type PptxDirectShapeStyleIR } from './drawing.js';

const PRESENTATION_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);

const localName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);

const childByName = (
  element: PptxXmlElement | undefined,
  name: string,
  namespaces: ReadonlySet<string>,
): PptxXmlElement | undefined =>
  element?.children.find(
    (child) => localName(child.name) === name && namespaces.has(child.namespaceUri ?? ''),
  );

const presentationChild = (
  element: PptxXmlElement | undefined,
  name: string,
): PptxXmlElement | undefined => childByName(element, name, PRESENTATION_NAMESPACES);

const drawingChild = (
  element: PptxXmlElement | undefined,
  name: string,
): PptxXmlElement | undefined => childByName(element, name, DRAWING_NAMESPACES);

/** Parse `p:clrMap` (or `overrideClrMapping`) attributes into a token map. */
export const parsePptxColorMapAttributes = (
  element: PptxXmlElement | undefined,
): Readonly<Record<string, string>> => {
  const map: Record<string, string> = {};
  for (const [name, value] of Object.entries(element?.attributes ?? {})) {
    if (!name.startsWith('xmlns')) map[name] = value;
  }
  return map;
};

export interface PptxSlideInheritanceContext {
  readonly layout?: PptxSlideLayoutIR;
  readonly master?: PptxSlideMasterIR;
  readonly theme?: PptxThemeIR;
  readonly schemeContext: PptxSchemeColorContext;
  /** presentation.xml `p:defaultTextStyle` (a:lvlXpPr children). */
  readonly defaultTextStyle?: PptxXmlElement;
  /** master `p:txStyles` children keyed by placeholder category. */
  readonly masterTextStyles: {
    readonly title?: PptxXmlElement;
    readonly body?: PptxXmlElement;
    readonly other?: PptxXmlElement;
  };
  readonly formatScheme: PptxThemeFormatScheme;
}

export interface PptxThemeFormatScheme {
  readonly fillStyles: readonly PptxXmlElement[];
  readonly lineStyles: readonly PptxXmlElement[];
  readonly effectStyles: readonly PptxXmlElement[];
  readonly backgroundFillStyles: readonly PptxXmlElement[];
}

const emptyFormatScheme: PptxThemeFormatScheme = Object.freeze({
  fillStyles: [],
  lineStyles: [],
  effectStyles: [],
  backgroundFillStyles: [],
});

const parseFormatScheme = (theme: PptxThemeIR | undefined): PptxThemeFormatScheme => {
  const themeElements = drawingChild(theme?.xml, 'themeElements');
  const formatScheme = drawingChild(themeElements, 'fmtScheme');
  if (!formatScheme) return emptyFormatScheme;
  const styleEntries = (listName: string): readonly PptxXmlElement[] =>
    drawingChild(formatScheme, listName)?.children.filter((child) =>
      DRAWING_NAMESPACES.has(child.namespaceUri ?? ''),
    ) ?? [];
  return {
    fillStyles: styleEntries('fillStyleLst'),
    lineStyles: styleEntries('lnStyleLst'),
    effectStyles: styleEntries('effectStyleLst'),
    backgroundFillStyles: styleEntries('bgFillStyleLst'),
  };
};

/** Resolve the layout/master/theme chain plus scheme-color context for one slide. */
export const createPptxSlideInheritanceContext = (
  ir: PptxPresentationIR,
  slide: PptxSlideIR,
): PptxSlideInheritanceContext => {
  const layout = ir.layouts.find((candidate) => candidate.partPath === slide.layoutPartPath);
  const master = ir.masters.find((candidate) => candidate.partPath === layout?.masterPartPath);
  const theme = ir.themes.find((candidate) => candidate.partPath === master?.themePartPath);
  const colorMap = parsePptxColorMapAttributes(presentationChild(master?.xml, 'clrMap'));
  const slidePart = ir.parts.find((candidate) => candidate.path === slide.partPath);
  const layoutOverride = presentationChild(
    presentationChild(layout?.xml, 'clrMapOvr'),
    'overrideClrMapping',
  );
  const slideOverride = presentationChild(
    presentationChild(slidePart?.xml, 'clrMapOvr'),
    'overrideClrMapping',
  );
  const override = slideOverride ?? layoutOverride;
  const presentationPart = ir.parts.find((candidate) => candidate.path === ir.presentationPartPath);
  const textStyles = presentationChild(master?.xml, 'txStyles');
  return {
    ...(layout === undefined ? {} : { layout }),
    ...(master === undefined ? {} : { master }),
    ...(theme === undefined ? {} : { theme }),
    schemeContext: createPptxSchemeColorContext(
      theme?.style,
      colorMap,
      override === undefined ? undefined : parsePptxColorMapAttributes(override),
    ),
    ...(presentationChild(presentationPart?.xml, 'defaultTextStyle') === undefined
      ? {}
      : { defaultTextStyle: presentationChild(presentationPart?.xml, 'defaultTextStyle') }),
    masterTextStyles: {
      ...(presentationChild(textStyles, 'titleStyle') === undefined
        ? {}
        : { title: presentationChild(textStyles, 'titleStyle') }),
      ...(presentationChild(textStyles, 'bodyStyle') === undefined
        ? {}
        : { body: presentationChild(textStyles, 'bodyStyle') }),
      ...(presentationChild(textStyles, 'otherStyle') === undefined
        ? {}
        : { other: presentationChild(textStyles, 'otherStyle') }),
    },
    formatScheme: parseFormatScheme(theme),
  };
};

export type PptxPlaceholderCategory = 'title' | 'body' | 'other';

/** title/ctrTitle share the title style category; every other typed ph is body-like. */
export const pptxPlaceholderCategory = (
  placeholder: PptxPlaceholderIR | undefined,
): PptxPlaceholderCategory => {
  if (placeholder === undefined) return 'other';
  const type = placeholder.type;
  if (type === 'title' || type === 'ctrTitle') return 'title';
  return 'body';
};

const shapePlaceholder = (shape: PptxXmlElement): { type?: string; index?: string } | undefined => {
  const nonVisual =
    presentationChild(shape, 'nvSpPr') ?? presentationChild(shape, 'nvPicPr') ?? undefined;
  const ph = presentationChild(presentationChild(nonVisual, 'nvPr'), 'ph');
  if (!ph) return undefined;
  return {
    ...(ph.attributes.type === undefined ? {} : { type: ph.attributes.type }),
    ...(ph.attributes.idx === undefined ? {} : { index: ph.attributes.idx }),
  };
};

const placeholderShapes = (root: PptxXmlElement | undefined): PptxXmlElement[] => {
  const shapeTree = presentationChild(presentationChild(root, 'cSld'), 'spTree');
  return (shapeTree?.children ?? []).filter(
    (child) =>
      localName(child.name) === 'sp' &&
      PRESENTATION_NAMESPACES.has(child.namespaceUri ?? '') &&
      shapePlaceholder(child) !== undefined,
  );
};

/**
 * Find the layout/master placeholder shape matching a slide placeholder.
 * idx match wins over type match; title and ctrTitle are equivalent types.
 */
export const findPptxPlaceholderShape = (
  root: PptxXmlElement | undefined,
  placeholder: PptxPlaceholderIR,
): PptxXmlElement | undefined => {
  const candidates = placeholderShapes(root).map((shape) => ({
    shape,
    ph: shapePlaceholder(shape)!,
  }));
  if (placeholder.index !== undefined) {
    const byIndex = candidates.find((candidate) => candidate.ph.index === placeholder.index);
    if (byIndex) return byIndex.shape;
  }
  if (placeholder.type !== undefined) {
    const titleFamily = new Set(['title', 'ctrTitle']);
    const byType = candidates.find((candidate) =>
      titleFamily.has(placeholder.type!)
        ? titleFamily.has(candidate.ph.type ?? '')
        : candidate.ph.type === placeholder.type,
    );
    if (byType) return byType.shape;
  }
  return undefined;
};

export interface PptxInheritedShapeProperties {
  /** `a:xfrm` from the nearest placeholder that declares one. */
  readonly transform?: PptxXmlElement;
  /** `a:prstGeom` from the nearest placeholder that declares one. */
  readonly presetGeometry?: PptxXmlElement;
  /** Direct style (fill/stroke) of the nearest placeholder that declares any. */
  readonly style?: PptxDirectShapeStyleIR;
  /** `a:bodyPr` elements, nearest first. */
  readonly bodyProperties: readonly PptxXmlElement[];
  /** `a:lstStyle` elements, nearest first (layout before master). */
  readonly listStyles: readonly PptxXmlElement[];
}

/** Collect inheritable placeholder properties, layout first then master. */
export const resolvePptxPlaceholderInheritance = (
  context: PptxSlideInheritanceContext,
  placeholder: PptxPlaceholderIR,
): PptxInheritedShapeProperties => {
  const sources = [
    findPptxPlaceholderShape(context.layout?.xml, placeholder),
    findPptxPlaceholderShape(context.master?.xml, placeholder),
  ].filter((shape): shape is PptxXmlElement => shape !== undefined);
  let transform: PptxXmlElement | undefined;
  let presetGeometry: PptxXmlElement | undefined;
  let style: PptxDirectShapeStyleIR | undefined;
  const bodyProperties: PptxXmlElement[] = [];
  const listStyles: PptxXmlElement[] = [];
  for (const shape of sources) {
    const shapeProperties = presentationChild(shape, 'spPr');
    if (transform === undefined) transform = drawingChild(shapeProperties, 'xfrm');
    if (presetGeometry === undefined) presetGeometry = drawingChild(shapeProperties, 'prstGeom');
    if (style === undefined && shapeProperties !== undefined) {
      const parsed = parsePptxDirectShapeStyle(shapeProperties, { partPath: 'inherited' });
      if (parsed.ok && (parsed.style.fill !== undefined || parsed.style.stroke !== undefined)) {
        style = parsed.style;
      }
    }
    const textBody = presentationChild(shape, 'txBody');
    const bodyProperty = drawingChild(textBody, 'bodyPr');
    if (bodyProperty !== undefined) bodyProperties.push(bodyProperty);
    const listStyle = drawingChild(textBody, 'lstStyle');
    if (listStyle !== undefined) listStyles.push(listStyle);
  }
  return {
    ...(transform === undefined ? {} : { transform }),
    ...(presetGeometry === undefined ? {} : { presetGeometry }),
    ...(style === undefined ? {} : { style }),
    bodyProperties,
    listStyles,
  };
};

/**
 * Ordered pPr-shaped style sources for one paragraph level, lowest priority
 * first: presentation default → master category style → master/layout
 * placeholder lstStyle → shape lstStyle.
 */
export const collectPptxParagraphStyleChain = (
  context: PptxSlideInheritanceContext,
  category: PptxPlaceholderCategory,
  inherited: PptxInheritedShapeProperties,
  shapeListStyle: PptxXmlElement | undefined,
  level: number,
): readonly PptxXmlElement[] => {
  const levelName = `lvl${level + 1}pPr`;
  const chain: (PptxXmlElement | undefined)[] = [
    drawingChild(context.defaultTextStyle, levelName) ??
      (level === 0 ? drawingChild(context.defaultTextStyle, 'defPPr') : undefined),
    drawingChild(
      category === 'title'
        ? context.masterTextStyles.title
        : category === 'body'
          ? context.masterTextStyles.body
          : context.masterTextStyles.other,
      levelName,
    ),
    // inherited.listStyles is nearest-first; the chain wants lowest first.
    ...[...inherited.listStyles].reverse().map((style) => drawingChild(style, levelName)),
    drawingChild(shapeListStyle, levelName),
  ];
  return chain.filter((element): element is PptxXmlElement => element !== undefined);
};

export interface PptxThemeFontResolution {
  readonly latin?: string;
  readonly eastAsia?: string;
  readonly complexScript?: string;
  readonly supplemental: Readonly<Record<string, string>>;
}

/** Concrete theme font faces for one major/minor set. */
export const resolvePptxThemeFontSet = (
  context: PptxSlideInheritanceContext,
  set: 'major' | 'minor',
): PptxThemeFontResolution => {
  const scheme = context.theme?.style.fontScheme;
  const fonts = set === 'major' ? scheme?.major : scheme?.minor;
  return {
    ...(fonts?.latin?.typeface ? { latin: fonts.latin.typeface } : {}),
    ...(fonts?.eastAsia?.typeface ? { eastAsia: fonts.eastAsia.typeface } : {}),
    ...(fonts?.complexScript?.typeface ? { complexScript: fonts.complexScript.typeface } : {}),
    supplemental: fonts?.supplemental ?? {},
  };
};
