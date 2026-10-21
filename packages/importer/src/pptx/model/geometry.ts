/**
 * Transform composition is conceptually adapted from OpenMAIC's PPTX importer
 * (`serializer/groupSerializer.ts`) at commit
 * 63fc81d8e1e8e13d04106618ef29f713541a520e. This implementation retains group
 * coordinate spaces instead of baking them into child geometry. OpenMAIC is
 * distributed under the MIT license; see THIRD_PARTY_NOTICES.md.
 */

import {
  assertFiniteGeometryNumber,
  emuToPoints,
  ooxmlAngleToDegrees,
  PptxGeometryError,
  type PptxAngle,
  type PptxEmu,
} from './units.js';

export interface PptxEmuPoint {
  readonly x: PptxEmu;
  readonly y: PptxEmu;
}

export interface PptxEmuExtent {
  readonly width: PptxEmu;
  readonly height: PptxEmu;
}

export interface PptxPoint {
  readonly x: number;
  readonly y: number;
}

export interface PptxRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Matrix layout: [a c e; b d f; 0 0 1]. */
export interface PptxAffineTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface PptxTransform2DSource {
  readonly offset: PptxEmuPoint;
  readonly extent: PptxEmuExtent;
  readonly rotation: PptxAngle;
  readonly flipHorizontal: boolean;
  readonly flipVertical: boolean;
}

export interface PptxGroupTransformSource extends PptxTransform2DSource {
  readonly childOffset: PptxEmuPoint;
  readonly childExtent: PptxEmuExtent;
}

export interface PptxResolvedTransform2D {
  readonly source: PptxTransform2DSource;
  readonly bounds: PptxRect;
  readonly rotationDegrees: number;
  readonly flipHorizontal: boolean;
  readonly flipVertical: boolean;
  /** Maps element-local point coordinates into its parent coordinate space. */
  readonly localToParent: PptxAffineTransform;
}

export interface PptxResolvedGroupCoordinateSpace {
  readonly source: PptxGroupTransformSource;
  readonly bounds: PptxRect;
  readonly childBounds: PptxRect;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationDegrees: number;
  readonly flipHorizontal: boolean;
  readonly flipVertical: boolean;
  /** Maps the group's retained child coordinate space into its parent. */
  readonly childToParent: PptxAffineTransform;
  readonly parentToChild: PptxAffineTransform;
}

export interface PptxDecomposedAffineTransform {
  readonly translationX: number;
  readonly translationY: number;
  readonly rotationDegrees: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly skewXDegrees: number;
}

const finite = (value: number, label: string): number => assertFiniteGeometryNumber(value, label);

const affine = (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
): PptxAffineTransform =>
  Object.freeze({
    a: finite(a, 'Affine a'),
    b: finite(b, 'Affine b'),
    c: finite(c, 'Affine c'),
    d: finite(d, 'Affine d'),
    e: finite(e, 'Affine e'),
    f: finite(f, 'Affine f'),
  });

export const PPTX_IDENTITY_AFFINE: PptxAffineTransform = affine(1, 0, 0, 1, 0, 0);

export const createPptxTranslation = (x: number, y: number): PptxAffineTransform =>
  affine(1, 0, 0, 1, x, y);

export const createPptxScale = (x: number, y: number): PptxAffineTransform =>
  affine(x, 0, 0, y, 0, 0);

export const createPptxRotation = (degrees: number): PptxAffineTransform => {
  const radians = (normalizePptxDegrees(degrees) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return affine(cosine, sine, -sine, cosine, 0, 0);
};

/** Returns left(right(point)); matrix application is therefore right-to-left. */
export const multiplyPptxAffine = (
  left: PptxAffineTransform,
  right: PptxAffineTransform,
): PptxAffineTransform =>
  affine(
    left.a * right.a + left.c * right.b,
    left.b * right.a + left.d * right.b,
    left.a * right.c + left.c * right.d,
    left.b * right.c + left.d * right.d,
    left.a * right.e + left.c * right.f + left.e,
    left.b * right.e + left.d * right.f + left.f,
  );

export const applyPptxAffine = (transform: PptxAffineTransform, point: PptxPoint): PptxPoint =>
  Object.freeze({
    x: finite(transform.a * point.x + transform.c * point.y + transform.e, 'Point x'),
    y: finite(transform.b * point.x + transform.d * point.y + transform.f, 'Point y'),
  });

export const invertPptxAffine = (transform: PptxAffineTransform): PptxAffineTransform => {
  const determinant = finite(
    transform.a * transform.d - transform.b * transform.c,
    'Affine determinant',
  );
  if (determinant === 0) {
    throw new PptxGeometryError(
      'pptx.geometry.singular_transform',
      'Affine transform is singular and cannot be inverted.',
    );
  }
  return affine(
    transform.d / determinant,
    -transform.b / determinant,
    -transform.c / determinant,
    transform.a / determinant,
    (transform.c * transform.f - transform.d * transform.e) / determinant,
    (transform.b * transform.e - transform.a * transform.f) / determinant,
  );
};

export const normalizePptxDegrees = (degrees: number): number => {
  const value = finite(degrees, 'Rotation');
  const normalized = ((value % 360) + 360) % 360;
  return normalized >= 180 ? normalized - 360 : normalized;
};

const assertBoolean = (value: boolean, label: string): void => {
  if (typeof value !== 'boolean') {
    throw new PptxGeometryError(
      'pptx.geometry.invalid_boolean',
      `${label} must be an explicit boolean.`,
    );
  }
};

const pointFromEmu = (point: PptxEmuPoint): PptxPoint =>
  Object.freeze({ x: emuToPoints(point.x), y: emuToPoints(point.y) });

const extentFromEmu = (extent: PptxEmuExtent, label: string): PptxRect => {
  const width = emuToPoints(extent.width);
  const height = emuToPoints(extent.height);
  // 零宽/零高合法：水平/垂直直线常以 cx=0 或 cy=0 出现（谷歌/WPS 导出）。
  if (width < 0 || height < 0) {
    throw new PptxGeometryError(
      'pptx.geometry.invalid_extent',
      `${label} width and height must not be negative.`,
    );
  }
  return Object.freeze({ x: 0, y: 0, width, height });
};

const orientedAround = (
  center: PptxPoint,
  rotationDegrees: number,
  flipHorizontal: boolean,
  flipVertical: boolean,
): PptxAffineTransform =>
  multiplyPptxAffine(
    createPptxTranslation(center.x, center.y),
    multiplyPptxAffine(
      createPptxRotation(rotationDegrees),
      multiplyPptxAffine(
        createPptxScale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1),
        createPptxTranslation(-center.x, -center.y),
      ),
    ),
  );

export const resolvePptxTransform2D = (source: PptxTransform2DSource): PptxResolvedTransform2D => {
  assertBoolean(source.flipHorizontal, 'flipHorizontal');
  assertBoolean(source.flipVertical, 'flipVertical');
  const offset = pointFromEmu(source.offset);
  const extent = extentFromEmu(source.extent, 'Element extent');
  const bounds = Object.freeze({
    x: offset.x,
    y: offset.y,
    width: extent.width,
    height: extent.height,
  });
  const rotationDegrees = normalizePptxDegrees(ooxmlAngleToDegrees(source.rotation));
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const localToUnorientedParent = createPptxTranslation(bounds.x, bounds.y);
  const localToParent = multiplyPptxAffine(
    orientedAround(center, rotationDegrees, source.flipHorizontal, source.flipVertical),
    localToUnorientedParent,
  );
  return Object.freeze({
    source,
    bounds,
    rotationDegrees,
    flipHorizontal: source.flipHorizontal,
    flipVertical: source.flipVertical,
    localToParent,
  });
};

export const resolvePptxGroupCoordinateSpace = (
  source: PptxGroupTransformSource,
): PptxResolvedGroupCoordinateSpace => {
  assertBoolean(source.flipHorizontal, 'flipHorizontal');
  assertBoolean(source.flipVertical, 'flipVertical');
  const offset = pointFromEmu(source.offset);
  const extent = extentFromEmu(source.extent, 'Group extent');
  const childOffset = pointFromEmu(source.childOffset);
  const childExtent = extentFromEmu(source.childExtent, 'Group child extent');
  const bounds = Object.freeze({
    x: offset.x,
    y: offset.y,
    width: extent.width,
    height: extent.height,
  });
  const childBounds = Object.freeze({
    x: childOffset.x,
    y: childOffset.y,
    width: childExtent.width,
    height: childExtent.height,
  });
  // 子坐标空间某轴为 0 时该轴上所有子坐标折叠到同一点，缩放取 0。
  const scaleX = finite(
    childBounds.width === 0 ? 0 : bounds.width / childBounds.width,
    'Group scaleX',
  );
  const scaleY = finite(
    childBounds.height === 0 ? 0 : bounds.height / childBounds.height,
    'Group scaleY',
  );
  const rotationDegrees = normalizePptxDegrees(ooxmlAngleToDegrees(source.rotation));
  const childToUnorientedParent = multiplyPptxAffine(
    createPptxTranslation(bounds.x, bounds.y),
    multiplyPptxAffine(
      createPptxScale(scaleX, scaleY),
      createPptxTranslation(-childBounds.x, -childBounds.y),
    ),
  );
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const childToParent = multiplyPptxAffine(
    orientedAround(center, rotationDegrees, source.flipHorizontal, source.flipVertical),
    childToUnorientedParent,
  );
  return Object.freeze({
    source,
    bounds,
    childBounds,
    scaleX,
    scaleY,
    rotationDegrees,
    flipHorizontal: source.flipHorizontal,
    flipVertical: source.flipVertical,
    childToParent,
    parentToChild: invertPptxAffine(childToParent),
  });
};

export const decomposePptxAffine = (
  transform: PptxAffineTransform,
): PptxDecomposedAffineTransform => {
  const scaleX = Math.hypot(transform.a, transform.b);
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (scaleX === 0 || determinant === 0) {
    throw new PptxGeometryError(
      'pptx.geometry.singular_transform',
      'Affine transform is singular and cannot be decomposed.',
    );
  }
  const scaleY = determinant / scaleX;
  const skewTangent = (transform.a * transform.c + transform.b * transform.d) / (scaleX * scaleY);
  return Object.freeze({
    translationX: finite(transform.e, 'Translation x'),
    translationY: finite(transform.f, 'Translation y'),
    rotationDegrees: normalizePptxDegrees((Math.atan2(transform.b, transform.a) * 180) / Math.PI),
    scaleX: finite(scaleX, 'Scale x'),
    scaleY: finite(scaleY, 'Scale y'),
    skewXDegrees: finite((Math.atan(skewTangent) * 180) / Math.PI, 'Skew x'),
  });
};
