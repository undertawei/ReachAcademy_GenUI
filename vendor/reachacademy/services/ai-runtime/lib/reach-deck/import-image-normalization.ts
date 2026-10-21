import sharp from 'sharp';

/** Mirrors the content-service generated-media image constraints. */
export const REACH_DECK_IMPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export const REACH_DECK_IMPORT_IMAGE_OUTPUT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const NORMALIZABLE_IMAGE_TYPES = new Set([
  ...REACH_DECK_IMPORT_IMAGE_OUTPUT_TYPES,
  'image/gif',
  'image/tiff',
  'image/bmp',
  'image/avif',
]);

const ANIMATED_IMAGE_TYPES = new Set(['image/gif', 'image/webp']);
const MAX_IMPORT_IMAGE_EDGE_PIXELS = 2880;
const PASSTHROUGH_BYTE_BUDGET = 4 * 1024 * 1024;
const NORMALIZED_IMAGE_CONTENT_TYPE = 'image/webp';
const NORMALIZED_WEBP_QUALITY = 82;
const NORMALIZED_WEBP_EFFORT = 4;

export interface ReachDeckNormalizedImportRaster {
  bytes: Uint8Array;
  contentType: string;
}

export interface ReachDeckImportRasterOptions {
  /**
   * 字节数不超过该预算、且像素也在导入舞台上限内的受支持图片保持原样。默认
   * PASSTHROUGH_BYTE_BUDGET；调用方可放宽到落库上限，以免把尺寸正常、只是字节
   * 偏大的图片也重编码掉。
   */
  passthroughByteBudget?: number;
}

export function isReachDeckNormalizableImageType(contentType: string): boolean {
  return NORMALIZABLE_IMAGE_TYPES.has(contentType);
}

/**
 * Bring a decoded import raster within the generated-media contract. Small,
 * already-supported images remain byte-identical; other supported raster
 * inputs are downscaled and encoded as WebP.
 */
export async function normalizeReachDeckImportRaster(
  bytes: Uint8Array,
  contentType: string,
  options: ReachDeckImportRasterOptions = {},
): Promise<ReachDeckNormalizedImportRaster | undefined> {
  if (bytes.byteLength === 0 || !isReachDeckNormalizableImageType(contentType)) return undefined;
  const passthroughEligible =
    REACH_DECK_IMPORT_IMAGE_OUTPUT_TYPES.has(contentType) &&
    bytes.byteLength <= (options.passthroughByteBudget ?? PASSTHROUGH_BYTE_BUDGET);
  const animated = ANIMATED_IMAGE_TYPES.has(contentType);
  try {
    const source = sharp(Buffer.from(bytes), { animated, failOn: 'none' });
    const metadata = await source.metadata();
    const width = metadata.width ?? 0;
    // An animated source reports the filmstrip height; pageHeight is one frame.
    const height = metadata.pageHeight ?? metadata.height ?? 0;
    if (width <= 0 || height <= 0) return undefined;
    if (passthroughEligible && Math.max(width, height) <= MAX_IMPORT_IMAGE_EDGE_PIXELS) {
      return { bytes, contentType };
    }
    const normalized = await source
      .rotate()
      .resize({
        width: MAX_IMPORT_IMAGE_EDGE_PIXELS,
        height: MAX_IMPORT_IMAGE_EDGE_PIXELS,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: NORMALIZED_WEBP_QUALITY, effort: NORMALIZED_WEBP_EFFORT })
      .toBuffer();
    if (normalized.byteLength === 0 || normalized.byteLength > REACH_DECK_IMPORT_IMAGE_MAX_BYTES) {
      return undefined;
    }
    return {
      bytes: new Uint8Array(normalized.buffer, normalized.byteOffset, normalized.byteLength),
      contentType: NORMALIZED_IMAGE_CONTENT_TYPE,
    };
  } catch {
    return undefined;
  }
}
