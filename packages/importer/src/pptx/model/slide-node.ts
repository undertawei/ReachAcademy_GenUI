import type { PptxDiagnostic } from '../diagnostics.js';
import type { PptxSourceLocation, PptxUnknownNodeIR } from '../ir.js';
import type { PptxXmlElement } from '../package/xml.js';
import { resolvePptxTransform2D, type PptxResolvedTransform2D } from './geometry.js';
import { pptxAngle, pptxEmu, PptxGeometryError } from './units.js';
import { projectPptxTextBody, type PptxTextBodyIR } from './text.js';
import { parsePptxDirectShapeStyle, type PptxDirectShapeStyleIR } from '../style/drawing.js';

export interface PptxNonVisualShapeIR {
  readonly sourceId: string;
  readonly name: string;
  readonly description?: string;
  readonly title?: string;
  readonly hidden: boolean;
}

export interface PptxPlaceholderIR {
  readonly type?: string;
  readonly index?: string;
  readonly orientation?: string;
  readonly size?: string;
}

export type PptxShapeGeometryIR =
  | {
      readonly kind: 'preset';
      readonly preset: string;
      readonly adjustments: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'custom'; readonly xml: PptxXmlElement };

export interface PptxShapeNodeIR {
  readonly kind: 'shape';
  readonly id: string;
  readonly nonVisual: PptxNonVisualShapeIR;
  readonly placeholder?: PptxPlaceholderIR;
  /** Absent when the transform must be inherited from a matching placeholder. */
  readonly directTransform?: PptxResolvedTransform2D;
  /** Absent when geometry must be inherited from a matching placeholder. */
  readonly geometry?: PptxShapeGeometryIR;
  readonly directStyle?: PptxDirectShapeStyleIR;
  readonly text?: PptxTextBodyIR;
  readonly styleXml?: PptxXmlElement;
  readonly shapePropertiesXml?: PptxXmlElement;
  readonly xml: PptxXmlElement;
  readonly source: PptxSourceLocation;
}

export type PptxSlideNodeIR = PptxShapeNodeIR | PptxUnknownNodeIR;

export type PptxSlideNodeProjectionResult =
  | { readonly ok: true; readonly node: PptxSlideNodeIR }
  | { readonly ok: false; readonly diagnostics: readonly PptxDiagnostic[] };

const localName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);

const PRESENTATION_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);

const children = (
  element: PptxXmlElement,
  name: string,
  namespaces: ReadonlySet<string> = PRESENTATION_NAMESPACES,
): PptxXmlElement[] =>
  element.children.filter(
    (child) => localName(child.name) === name && namespaces.has(child.namespaceUri ?? ''),
  );

const one = (
  element: PptxXmlElement,
  name: string,
  namespaces?: ReadonlySet<string>,
): PptxXmlElement | undefined => children(element, name, namespaces)[0];

const parseBoolean = (value: string | undefined): boolean => {
  if (value === undefined || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new PptxGeometryError('pptx.geometry.invalid_boolean', `Invalid OOXML boolean: ${value}`);
};

const projectionFailure = (
  code: `pptx.${string}`,
  feature: PptxDiagnostic['feature'],
  message: string,
  source: PptxSourceLocation,
): PptxSlideNodeProjectionResult => ({
  ok: false,
  diagnostics: [{ code, severity: 'fatal', feature, message, location: source }],
});

const parseTransform = (
  shapeProperties: PptxXmlElement | undefined,
): PptxResolvedTransform2D | undefined => {
  const transform = shapeProperties && one(shapeProperties, 'xfrm', DRAWING_NAMESPACES);
  if (!transform) return undefined;
  const offsets = children(transform, 'off', DRAWING_NAMESPACES);
  const extents = children(transform, 'ext', DRAWING_NAMESPACES);
  if (offsets.length !== 1 || extents.length !== 1) {
    throw new PptxGeometryError(
      'pptx.geometry.invalid_extent',
      'Shape transform requires exactly one offset and one extent.',
    );
  }
  const offset = offsets[0]!;
  const extent = extents[0]!;
  if (
    offset.attributes.x === undefined ||
    offset.attributes.y === undefined ||
    extent.attributes.cx === undefined ||
    extent.attributes.cy === undefined
  ) {
    throw new PptxGeometryError(
      'pptx.geometry.invalid_extent',
      'Shape transform offset/extent attributes are incomplete.',
    );
  }
  return resolvePptxTransform2D({
    offset: { x: pptxEmu(offset.attributes.x), y: pptxEmu(offset.attributes.y) },
    extent: { width: pptxEmu(extent.attributes.cx), height: pptxEmu(extent.attributes.cy) },
    rotation: pptxAngle(transform.attributes.rot ?? '0'),
    flipHorizontal: parseBoolean(transform.attributes.flipH),
    flipVertical: parseBoolean(transform.attributes.flipV),
  });
};

const parseGeometry = (
  shapeProperties: PptxXmlElement | undefined,
  source: PptxSourceLocation,
): PptxShapeGeometryIR | undefined | PptxSlideNodeProjectionResult => {
  if (!shapeProperties) return undefined;
  const presets = children(shapeProperties, 'prstGeom', DRAWING_NAMESPACES);
  const customs = children(shapeProperties, 'custGeom', DRAWING_NAMESPACES);
  if (presets.length + customs.length > 1) {
    return projectionFailure(
      'pptx.geometry.ambiguous_shape_geometry',
      'geometry',
      'Shape contains multiple geometry definitions.',
      source,
    );
  }
  if (customs[0]) return { kind: 'custom', xml: customs[0] };
  const preset = presets[0];
  if (!preset) return undefined;
  const presetName = preset.attributes.prst?.trim();
  if (!presetName) {
    return projectionFailure(
      'pptx.geometry.missing_preset',
      'geometry',
      'Preset shape geometry is missing its prst attribute.',
      source,
    );
  }
  const adjustments: Record<string, string> = {};
  const adjustmentList = one(preset, 'avLst', DRAWING_NAMESPACES);
  for (const adjustment of adjustmentList?.children ?? []) {
    if (localName(adjustment.name) !== 'gd') continue;
    const name = adjustment.attributes.name?.trim();
    const formula = adjustment.attributes.fmla?.trim();
    if (!name || !formula || name in adjustments) {
      return projectionFailure(
        'pptx.geometry.invalid_adjustment',
        'geometry',
        'Preset shape adjustment names/formulas must be non-empty and unique.',
        source,
      );
    }
    adjustments[name] = formula;
  }
  return { kind: 'preset', preset: presetName, adjustments };
};

/** Project common shape identity/geometry without inventing inherited placeholder values. */
export const projectPptxSlideNode = (node: PptxUnknownNodeIR): PptxSlideNodeProjectionResult => {
  if (localName(node.qualifiedName) !== 'sp') return { ok: true, node };
  return projectPptxShapeElement(node.xml, node.id, node.source);
};

/** Shape projection shared by top-level slide nodes and p:grpSp descendants. */
export const projectPptxShapeElement = (
  xml: PptxXmlElement,
  id: string,
  source: PptxSourceLocation,
): PptxSlideNodeProjectionResult => {
  const nonVisualContainers = children(xml, 'nvSpPr');
  const shapePropertiesContainers = children(xml, 'spPr');
  const textBodies = children(xml, 'txBody');
  const styles = children(xml, 'style');
  if (
    nonVisualContainers.length !== 1 ||
    shapePropertiesContainers.length > 1 ||
    textBodies.length > 1 ||
    styles.length > 1
  ) {
    return projectionFailure(
      'pptx.shape.ambiguous_structure',
      'shape',
      'Shape contains missing or duplicate structural children.',
      source,
    );
  }
  const nonVisual = nonVisualContainers[0]!;
  const coreProperties = one(nonVisual, 'cNvPr');
  if (!coreProperties?.attributes.id || coreProperties.attributes.name === undefined) {
    return projectionFailure(
      'pptx.shape.missing_non_visual_properties',
      'shape',
      'Shape requires non-visual id and name attributes.',
      source,
    );
  }
  const placeholderElement = one(one(nonVisual, 'nvPr') ?? nonVisual, 'ph');
  const placeholder = placeholderElement
    ? {
        ...(placeholderElement.attributes.type ? { type: placeholderElement.attributes.type } : {}),
        ...(placeholderElement.attributes.idx ? { index: placeholderElement.attributes.idx } : {}),
        ...(placeholderElement.attributes.orient
          ? { orientation: placeholderElement.attributes.orient }
          : {}),
        ...(placeholderElement.attributes.sz ? { size: placeholderElement.attributes.sz } : {}),
      }
    : undefined;
  const shapeProperties = shapePropertiesContainers[0];
  let directTransform: PptxResolvedTransform2D | undefined;
  try {
    directTransform = parseTransform(shapeProperties);
  } catch (error) {
    return projectionFailure(
      error instanceof PptxGeometryError ? error.code : 'pptx.geometry.invalid_transform',
      'transform',
      error instanceof Error ? error.message : 'Shape transform is invalid.',
      source,
    );
  }
  const geometry = parseGeometry(shapeProperties, source);
  if (geometry && 'ok' in geometry) return geometry;
  const directStyle = shapeProperties
    ? parsePptxDirectShapeStyle(shapeProperties, source)
    : undefined;
  if (directStyle && !directStyle.ok) return directStyle;
  const text = textBodies[0] ? projectPptxTextBody(id, textBodies[0], source) : undefined;
  if (text && !text.ok) return text;
  let hidden: boolean;
  try {
    hidden = parseBoolean(coreProperties.attributes.hidden);
  } catch (error) {
    return projectionFailure(
      'pptx.shape.invalid_hidden',
      'shape',
      error instanceof Error ? error.message : 'Shape hidden flag is invalid.',
      source,
    );
  }
  return {
    ok: true,
    node: {
      kind: 'shape',
      id,
      nonVisual: {
        sourceId: coreProperties.attributes.id,
        name: coreProperties.attributes.name,
        ...(coreProperties.attributes.descr
          ? { description: coreProperties.attributes.descr }
          : {}),
        ...(coreProperties.attributes.title ? { title: coreProperties.attributes.title } : {}),
        hidden,
      },
      ...(placeholder ? { placeholder } : {}),
      ...(directTransform ? { directTransform } : {}),
      ...(geometry ? { geometry } : {}),
      ...(directStyle?.ok ? { directStyle: directStyle.style } : {}),
      ...(text?.ok ? { text: text.text } : {}),
      ...(styles[0] ? { styleXml: styles[0] } : {}),
      ...(shapeProperties ? { shapePropertiesXml: shapeProperties } : {}),
      xml,
      source,
    },
  };
};
