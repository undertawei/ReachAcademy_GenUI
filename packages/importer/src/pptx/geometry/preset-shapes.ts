/**
 * Evaluate DrawingML geometry into SVG paths: the shared path emitter for
 * `a:custGeom` command lists and for the preset shape definitions published with
 * the OOXML standard (§20.1.9.18), so a preset the player has no native
 * renderer for still imports as the exact outline the standard defines.
 */
import { createPptxGeometryGuides, pptxGeometryAngleRadians } from './formula.js';
import { PPTX_PRESET_SHAPE_DEFINITIONS } from './presetShapeDefinitions.generated.js';

/**
 * One path command with its operands kept as guide tokens, in SVG letters:
 * `M`oveTo, `L`ineTo, `C`ubic/`Q`uadratic Bézier, `A`rcTo (wR, hR, start and
 * swing angle) and `Z` close.
 */
export type PptxGeometryPathCommand =
  | readonly ['M', string, string]
  | readonly ['L', string, string]
  | readonly ['C', string, string, string, string, string, string]
  | readonly ['Q', string, string, string, string]
  | readonly ['A', string, string, string, string]
  | readonly ['Z'];

/** `a:path@fill` (§20.1.10.36): how the shape fill paints this subpath. */
export type PptxGeometryPathFill =
  | 'none'
  | 'norm'
  | 'lighten'
  | 'lightenLess'
  | 'darken'
  | 'darkenLess';

export interface PptxGeometryPath {
  /** `a:path@w`/`@h`: the coordinate space the commands are expressed in. */
  readonly w?: string;
  readonly h?: string;
  readonly fill?: PptxGeometryPathFill;
  readonly stroke?: boolean;
  readonly commands: readonly PptxGeometryPathCommand[];
}

export interface PptxPresetShapeDefinition {
  /** `a:avLst` defaults, as formulas (`val 16200000`). */
  readonly adjust?: Readonly<Record<string, string>>;
  /** `a:gdLst` entries in declaration order. */
  readonly guides?: readonly (readonly [string, string])[];
  readonly paths: readonly PptxGeometryPath[];
}

export interface PptxGeometrySubpath {
  readonly path: string;
  readonly fill: PptxGeometryPathFill;
  readonly stroked: boolean;
}

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/** Geometric angles are corrected to the ellipse parameter the standard's own
 * guides use (`cat2`/`sat2` over `sin`/`cos` operands, §20.1.9.3). */
const ellipseParameter = (angle: number, radiusX: number, radiusY: number): number => {
  const radians = pptxGeometryAngleRadians(angle);
  return Math.atan2(radiusX * Math.sin(radians), radiusY * Math.cos(radians));
};

/** Arc chunk limit in OOXML angle units (90°), so every `A` stays a small arc. */
const ARC_CHUNK = 5_400_000;

/**
 * Emit one path as an SVG path string, or undefined when a coordinate cannot be
 * resolved. Coordinates resolve in the shape extent's unit and are scaled from
 * the path's own coordinate space when it declares one.
 */
export function emitPptxGeometryPath(
  path: PptxGeometryPath,
  extent: { readonly width: number; readonly height: number },
  guides: { resolve(token: string | undefined): number | undefined },
): string | undefined {
  const spaceWidth = path.w === undefined ? undefined : guides.resolve(path.w);
  const spaceHeight = path.h === undefined ? undefined : guides.resolve(path.h);
  if (
    (path.w !== undefined && (spaceWidth === undefined || spaceWidth < 0)) ||
    (path.h !== undefined && (spaceHeight === undefined || spaceHeight < 0))
  ) {
    return undefined;
  }
  // A zero-extent axis only carries zero coordinates, so any finite scale works.
  const scaleX = spaceWidth === undefined ? 1 : spaceWidth === 0 ? 0 : extent.width / spaceWidth;
  const scaleY =
    spaceHeight === undefined ? 1 : spaceHeight === 0 ? 0 : extent.height / spaceHeight;
  const x = (token: string): number | undefined => {
    const value = guides.resolve(token);
    return value === undefined ? undefined : value * scaleX;
  };
  const y = (token: string): number | undefined => {
    const value = guides.resolve(token);
    return value === undefined ? undefined : value * scaleY;
  };
  const segments: string[] = [];
  let current: { x: number; y: number } | undefined;
  let subpathStart: { x: number; y: number } | undefined;
  for (const command of path.commands) {
    switch (command[0]) {
      case 'M':
      case 'L': {
        const pointX = x(command[1]);
        const pointY = y(command[2]);
        if (pointX === undefined || pointY === undefined) return undefined;
        segments.push(`${command[0]} ${round(pointX)} ${round(pointY)}`);
        current = { x: pointX, y: pointY };
        if (command[0] === 'M') subpathStart = current;
        break;
      }
      case 'C':
      case 'Q': {
        const coordinates: number[] = [];
        for (let index = 1; index < command.length; index += 2) {
          const pointX = x(command[index]!);
          const pointY = y(command[index + 1]!);
          if (pointX === undefined || pointY === undefined) return undefined;
          coordinates.push(pointX, pointY);
        }
        segments.push(`${command[0]} ${coordinates.map(round).join(' ')}`);
        current = {
          x: coordinates[coordinates.length - 2]!,
          y: coordinates[coordinates.length - 1]!,
        };
        break;
      }
      case 'A': {
        if (current === undefined) return undefined;
        const radiusX = x(command[1]);
        const radiusY = y(command[2]);
        const startAngle = guides.resolve(command[3]);
        const swingAngle = guides.resolve(command[4]);
        if (
          radiusX === undefined ||
          radiusY === undefined ||
          startAngle === undefined ||
          swingAngle === undefined
        ) {
          return undefined;
        }
        const startParameter = ellipseParameter(startAngle, radiusX, radiusY);
        const centerX = current.x - radiusX * Math.cos(startParameter);
        const centerY = current.y - radiusY * Math.sin(startParameter);
        const steps = Math.max(1, Math.ceil(Math.abs(swingAngle) / ARC_CHUNK));
        const sweepFlag = swingAngle < 0 ? 0 : 1;
        for (let step = 1; step <= steps; step += 1) {
          const parameter = ellipseParameter(
            startAngle + (swingAngle * step) / steps,
            radiusX,
            radiusY,
          );
          const pointX = centerX + radiusX * Math.cos(parameter);
          const pointY = centerY + radiusY * Math.sin(parameter);
          segments.push(
            `A ${round(Math.abs(radiusX))} ${round(Math.abs(radiusY))} 0 0 ${sweepFlag} ${round(pointX)} ${round(pointY)}`,
          );
          current = { x: pointX, y: pointY };
        }
        break;
      }
      case 'Z':
        segments.push('Z');
        if (subpathStart !== undefined) current = subpathStart;
        break;
    }
  }
  return segments.length === 0 ? undefined : segments.join(' ');
}

export const pptxPresetShapeDefinition = (preset: string): PptxPresetShapeDefinition | undefined =>
  PPTX_PRESET_SHAPE_DEFINITIONS[preset];

/**
 * Resolve a preset shape into its subpaths for one element box. Returns
 * undefined when the preset is unknown or a guide cannot be evaluated (a
 * degenerate extent, say), so callers keep reporting the geometry as lost.
 */
export function buildPptxPresetShapeGeometry(
  preset: string,
  adjustments: Readonly<Record<string, number>>,
  extent: { readonly width: number; readonly height: number },
): readonly PptxGeometrySubpath[] | undefined {
  const definition = pptxPresetShapeDefinition(preset);
  if (definition === undefined) return undefined;
  const formulas = new Map<string, string>();
  for (const [name, formula] of Object.entries(definition.adjust ?? {})) {
    formulas.set(name, formula);
  }
  for (const [name, value] of Object.entries(adjustments)) formulas.set(name, `val ${value}`);
  for (const [name, formula] of definition.guides ?? []) formulas.set(name, formula);
  const guides = createPptxGeometryGuides(extent, formulas);
  const subpaths: PptxGeometrySubpath[] = [];
  for (const path of definition.paths) {
    const emitted = emitPptxGeometryPath(path, extent, guides);
    if (emitted === undefined) return undefined;
    subpaths.push({
      path: emitted,
      fill: path.fill ?? 'norm',
      stroked: path.stroke !== false,
    });
  }
  return subpaths.length === 0 ? undefined : subpaths;
}
