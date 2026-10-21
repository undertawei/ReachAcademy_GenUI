import type { PptxDiagnostic } from '../diagnostics.js';
import type { PptxSourceLocation } from '../ir.js';
import type { PptxXmlElement } from '../package/xml.js';
import {
  pptxAngle,
  pptxEmu,
  pptxPercentage,
  type PptxAngle,
  type PptxEmu,
  type PptxPercentage,
} from '../model/units.js';

export interface PptxColorModifierIR {
  readonly kind: string;
  readonly value: PptxPercentage;
}

export type PptxColorIR =
  | {
      readonly kind: 'srgb';
      readonly value: string;
      readonly modifiers: readonly PptxColorModifierIR[];
    }
  | {
      readonly kind: 'scheme';
      readonly token: string;
      readonly modifiers: readonly PptxColorModifierIR[];
    }
  | {
      readonly kind: 'system';
      readonly systemName: string;
      readonly fallbackValue: string;
      readonly modifiers: readonly PptxColorModifierIR[];
    };

export type PptxFillIR =
  | { readonly kind: 'none'; readonly xml: PptxXmlElement }
  | { readonly kind: 'solid'; readonly color: PptxColorIR; readonly xml: PptxXmlElement }
  | {
      readonly kind: 'gradient';
      readonly stops: readonly { readonly position: PptxPercentage; readonly color: PptxColorIR }[];
      /** Linear gradient angle; absent for path (radial) gradients. */
      readonly angle?: PptxAngle;
      readonly xml: PptxXmlElement;
    }
  | { readonly kind: 'unsupported'; readonly fillType: string; readonly xml: PptxXmlElement };

export interface PptxStrokeIR {
  readonly width?: PptxEmu;
  readonly cap?: string;
  readonly compound?: string;
  readonly alignment?: string;
  readonly fill?: PptxFillIR;
  readonly dash?: string;
  readonly join?: 'round' | 'bevel' | 'miter';
  readonly xml: PptxXmlElement;
}

export interface PptxDirectShapeStyleIR {
  readonly fill?: PptxFillIR;
  readonly stroke?: PptxStrokeIR;
  readonly effectsXml?: PptxXmlElement;
}

export type PptxDrawingStyleResult =
  | { readonly ok: true; readonly style: PptxDirectShapeStyleIR }
  | { readonly ok: false; readonly diagnostics: readonly PptxDiagnostic[] };

const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);

const localName = (qualifiedName: string): string =>
  qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1);

const drawingChildren = (element: PptxXmlElement): PptxXmlElement[] =>
  element.children.filter((child) => DRAWING_NAMESPACES.has(child.namespaceUri ?? ''));

const failure = (message: string, source: PptxSourceLocation): PptxDrawingStyleResult => ({
  ok: false,
  diagnostics: [
    {
      code: 'pptx.shape.invalid_style',
      severity: 'fatal',
      feature: 'shape',
      message,
      location: source,
    },
  ],
});

const normalizedHex = (value: string | undefined): string | undefined =>
  value && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toUpperCase()}` : undefined;

const parseModifiers = (color: PptxXmlElement): PptxColorModifierIR[] => {
  const modifiers: PptxColorModifierIR[] = [];
  for (const child of drawingChildren(color)) {
    const value = child.attributes.val;
    if (value === undefined)
      throw new Error(`Color modifier ${localName(child.name)} is missing val.`);
    modifiers.push({ kind: localName(child.name), value: pptxPercentage(value) });
  }
  return modifiers;
};

/**
 * scRGB stores linear-light channels as OOXML percentages. Apply the sRGB
 * transfer function (IEC 61966-2-1) so the result matches what PowerPoint
 * paints, then carry it as an ordinary sRGB color.
 */
const scrgbChannelToByte = (raw: string | undefined): number => {
  if (raw === undefined) throw new Error('scRGB color requires r, g and b.');
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error('scRGB channel must be an integer.');
  const linear = Math.min(1, Math.max(0, parsed / 100_000));
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
};

const parseColor = (container: PptxXmlElement): PptxColorIR => {
  const colors = drawingChildren(container).filter((child) =>
    ['srgbClr', 'schemeClr', 'sysClr', 'scrgbClr'].includes(localName(child.name)),
  );
  if (colors.length !== 1) throw new Error('Solid fill must contain exactly one supported color.');
  const color = colors[0]!;
  const modifiers = parseModifiers(color);
  switch (localName(color.name)) {
    case 'srgbClr': {
      const value = normalizedHex(color.attributes.val);
      if (!value) throw new Error('sRGB color must contain a six-digit val.');
      return { kind: 'srgb', value, modifiers };
    }
    case 'scrgbClr': {
      const channels = (['r', 'g', 'b'] as const).map((channel) =>
        scrgbChannelToByte(color.attributes[channel]),
      );
      const value = `#${channels
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`;
      return { kind: 'srgb', value, modifiers };
    }
    case 'schemeClr': {
      const token = color.attributes.val?.trim();
      if (!token) throw new Error('Scheme color must contain a non-empty val.');
      return { kind: 'scheme', token, modifiers };
    }
    case 'sysClr': {
      const systemName = color.attributes.val?.trim();
      const fallbackValue = normalizedHex(color.attributes.lastClr);
      if (!systemName || !fallbackValue) {
        throw new Error('System color requires val and deterministic lastClr.');
      }
      return { kind: 'system', systemName, fallbackValue, modifiers };
    }
    default:
      throw new Error('Unsupported color kind.');
  }
};

const fillNames = new Set(['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill']);

const parseGradient = (element: PptxXmlElement): PptxFillIR => {
  const stopList = drawingChildren(element).find((child) => localName(child.name) === 'gsLst');
  const stops = (stopList ? drawingChildren(stopList) : [])
    .filter((child) => localName(child.name) === 'gs')
    .map((stop) => {
      if (stop.attributes.pos === undefined) throw new Error('Gradient stop is missing pos.');
      return { position: pptxPercentage(stop.attributes.pos), color: parseColor(stop) };
    });
  if (stops.length < 2) throw new Error('Gradient fill requires at least two stops.');
  const linear = drawingChildren(element).find((child) => localName(child.name) === 'lin');
  return {
    kind: 'gradient',
    stops,
    ...(linear?.attributes.ang === undefined ? {} : { angle: pptxAngle(linear.attributes.ang) }),
    xml: element,
  };
};

const parseFill = (element: PptxXmlElement): PptxFillIR => {
  switch (localName(element.name)) {
    case 'noFill':
      return { kind: 'none', xml: element };
    case 'solidFill':
      return { kind: 'solid', color: parseColor(element), xml: element };
    case 'gradFill':
      return parseGradient(element);
    default:
      return { kind: 'unsupported', fillType: localName(element.name), xml: element };
  }
};

const directFill = (element: PptxXmlElement): PptxFillIR | undefined => {
  const fills = drawingChildren(element).filter((child) => fillNames.has(localName(child.name)));
  if (fills.length > 1) throw new Error('Drawing properties contain multiple direct fills.');
  return fills[0] ? parseFill(fills[0]) : undefined;
};

/** Parse the direct fill child (if any) of a drawing properties element. */
export const parsePptxDirectFill = directFill;

/** Parse one explicit fill element (solidFill/gradFill/noFill/...). */
export const parsePptxFillElement = parseFill;

/** Parse one color container (an element whose child is srgbClr/schemeClr/sysClr). */
export const parsePptxColorContainer = parseColor;

const parseStroke = (line: PptxXmlElement): PptxStrokeIR => {
  const fill = directFill(line);
  const dashes = drawingChildren(line).filter((child) => localName(child.name) === 'prstDash');
  const joins = drawingChildren(line).filter((child) =>
    ['round', 'bevel', 'miter'].includes(localName(child.name)),
  );
  if (dashes.length > 1 || joins.length > 1) {
    throw new Error('Stroke contains ambiguous dash or join semantics.');
  }
  return {
    ...(line.attributes.w ? { width: pptxEmu(line.attributes.w) } : {}),
    ...(line.attributes.cap ? { cap: line.attributes.cap } : {}),
    ...(line.attributes.cmpd ? { compound: line.attributes.cmpd } : {}),
    ...(line.attributes.algn ? { alignment: line.attributes.algn } : {}),
    ...(fill ? { fill } : {}),
    ...(dashes[0]?.attributes.val ? { dash: dashes[0].attributes.val } : {}),
    ...(joins[0] ? { join: localName(joins[0].name) as 'round' | 'bevel' | 'miter' } : {}),
    xml: line,
  };
};

/** Parse one `a:ln`-shaped element for stroke resolution. */
export const parsePptxStrokeElement = parseStroke;

/** Parse direct drawing properties; inheritance remains a separate explicit resolution step. */
export const parsePptxDirectShapeStyle = (
  shapeProperties: PptxXmlElement,
  source: PptxSourceLocation,
): PptxDrawingStyleResult => {
  try {
    const fill = directFill(shapeProperties);
    const lines = drawingChildren(shapeProperties).filter(
      (child) => localName(child.name) === 'ln',
    );
    const effects = drawingChildren(shapeProperties).filter((child) =>
      ['effectLst', 'effectDag'].includes(localName(child.name)),
    );
    if (lines.length > 1 || effects.length > 1) {
      return failure('Shape contains ambiguous line or effect properties.', source);
    }
    return {
      ok: true,
      style: {
        ...(fill ? { fill } : {}),
        ...(lines[0] ? { stroke: parseStroke(lines[0]) } : {}),
        ...(effects[0] ? { effectsXml: effects[0] } : {}),
      },
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Shape style is invalid.', source);
  }
};
