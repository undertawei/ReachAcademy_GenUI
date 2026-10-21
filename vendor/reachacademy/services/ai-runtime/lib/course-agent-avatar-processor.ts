import crypto from 'node:crypto';

import sharp from 'sharp';

export const COURSE_AGENT_AVATAR_PROCESS_VERSION = 'course-agent-avatar/v1';
export const COURSE_AGENT_AVATAR_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const COURSE_AGENT_AVATAR_MAX_REQUEST_BYTES = 5_600_000;
export const COURSE_AGENT_AVATAR_MAX_PIXELS = 16_777_216;
export const COURSE_AGENT_AVATAR_MIN_DIMENSION = 256;
export const COURSE_AGENT_AVATAR_MAX_DIMENSION = 4096;
export const COURSE_AGENT_AVATAR_OUTPUT_SIZE = 512;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROCESSING_TIMEOUT_SECONDS = 5;
const MAX_CONCURRENT_PROCESSORS = 2;

const CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type AvatarContentType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface CourseAgentAvatarCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CourseAgentAvatarProcessInput {
  imageBase64: string;
  contentType: string;
  crop: CourseAgentAvatarCrop;
}

export interface CourseAgentAvatarProcessResult {
  version: typeof COURSE_AGENT_AVATAR_PROCESS_VERSION;
  contentType: 'image/webp';
  width: 512;
  height: 512;
  sha256: string;
  bytesBase64: string;
}

export class CourseAgentAvatarValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
    this.name = 'CourseAgentAvatarValidationError';
  }
}

export class CourseAgentAvatarBusyError extends Error {
  readonly status = 503;
  readonly code = 'avatar_processor_busy';

  constructor() {
    super('Avatar processor is busy');
    this.name = 'CourseAgentAvatarBusyError';
  }
}

let activeProcessors = 0;

/**
 * Validate, orientation-normalize, crop, and encode one untrusted image without persistence.
 * The bounded lease is intentionally fail-fast so requests cannot create an unbounded queue.
 */
export async function processCourseAgentAvatar(
  input: CourseAgentAvatarProcessInput,
): Promise<CourseAgentAvatarProcessResult> {
  if (activeProcessors >= MAX_CONCURRENT_PROCESSORS) throw new CourseAgentAvatarBusyError();
  activeProcessors += 1;
  try {
    const source = decodeBase64(input.imageBase64);
    const expectedType = normalizeContentType(input.contentType);
    const detectedType = detectAndValidateContainer(source);
    if (detectedType !== expectedType) {
      throw invalid(
        'avatar_media_type_mismatch',
        'Avatar content type does not match its encoding',
      );
    }

    const sourceImage = sharp(source, {
      failOn: 'error',
      limitInputPixels: COURSE_AGENT_AVATAR_MAX_PIXELS,
      sequentialRead: true,
    });
    let metadata: sharp.Metadata;
    try {
      metadata = await sourceImage.metadata();
    } catch {
      throw invalid('avatar_dimensions_invalid', 'Avatar dimensions exceed the processing limit');
    }
    const format = formatFromSharpMetadata(metadata.format);
    if (format !== detectedType)
      throw invalid('avatar_decode_failed', 'Avatar encoding cannot be decoded');
    if (
      (metadata.pages ?? 1) !== 1 ||
      (metadata.pageHeight ?? metadata.height) !== metadata.height
    ) {
      throw invalid('avatar_animation_not_allowed', 'Animated avatars are not supported');
    }
    if (
      !metadata.width ||
      !metadata.height ||
      !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height)
    ) {
      throw invalid('avatar_dimensions_invalid', 'Avatar dimensions are missing');
    }

    const orientation = metadata.orientation ?? 1;
    const swapsAxes = orientation >= 5 && orientation <= 8;
    const orientedWidth = swapsAxes ? metadata.height : metadata.width;
    const orientedHeight = swapsAxes ? metadata.width : metadata.height;
    validateDimensions(orientedWidth, orientedHeight);
    const crop = validateCrop(input.crop, orientedWidth, orientedHeight);

    // Force a complete oriented decode before extracting a user-selected region. This prevents a
    // decoder from accepting a truncated tail that happens to fall outside the requested crop.
    try {
      await sourceImage
        .clone()
        .rotate()
        .raw()
        .timeout({ seconds: PROCESSING_TIMEOUT_SECONDS })
        .toBuffer();
    } catch {
      throw invalid('avatar_decode_failed', 'Avatar could not be fully decoded');
    }

    let output: Buffer;
    try {
      output = await sourceImage
        .rotate()
        .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
        .resize(COURSE_AGENT_AVATAR_OUTPUT_SIZE, COURSE_AGENT_AVATAR_OUTPUT_SIZE, {
          fit: 'fill',
          kernel: sharp.kernel.lanczos3,
        })
        .webp({ lossless: true, effort: 4 })
        .timeout({ seconds: PROCESSING_TIMEOUT_SECONDS })
        .toBuffer();
    } catch {
      throw invalid('avatar_decode_failed', 'Avatar could not be fully decoded and normalized');
    }
    if (output.length === 0 || output.length > MAX_OUTPUT_BYTES) {
      throw invalid(
        'avatar_output_too_large',
        'Normalized avatar output exceeds the processing limit',
      );
    }
    await verifyOutput(output);
    return {
      version: COURSE_AGENT_AVATAR_PROCESS_VERSION,
      contentType: 'image/webp',
      width: COURSE_AGENT_AVATAR_OUTPUT_SIZE,
      height: COURSE_AGENT_AVATAR_OUTPUT_SIZE,
      sha256: crypto.createHash('sha256').update(output).digest('hex'),
      bytesBase64: output.toString('base64'),
    };
  } finally {
    activeProcessors -= 1;
  }
}

function decodeBase64(value: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil((COURSE_AGENT_AVATAR_MAX_SOURCE_BYTES * 4) / 3) + 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw invalid('avatar_encoding_invalid', 'Avatar bytes must be canonical base64');
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    throw invalid('avatar_encoding_invalid', 'Avatar bytes must be canonical base64');
  }
  if (decoded.length === 0 || decoded.length > COURSE_AGENT_AVATAR_MAX_SOURCE_BYTES) {
    throw invalid('avatar_size_exceeded', 'Avatar source exceeds the 4 MiB limit');
  }
  return decoded;
}

function normalizeContentType(value: string): AvatarContentType {
  if (typeof value !== 'string' || !CONTENT_TYPES.has(value)) {
    throw invalid('avatar_content_type_invalid', 'Avatar content type is unsupported');
  }
  return value as AvatarContentType;
}

function formatFromSharpMetadata(value: string | undefined): AvatarContentType | undefined {
  if (value === 'png') return 'image/png';
  if (value === 'jpeg') return 'image/jpeg';
  if (value === 'webp') return 'image/webp';
  return undefined;
}

function validateDimensions(width: number, height: number): void {
  if (
    width < COURSE_AGENT_AVATAR_MIN_DIMENSION ||
    height < COURSE_AGENT_AVATAR_MIN_DIMENSION ||
    width > COURSE_AGENT_AVATAR_MAX_DIMENSION ||
    height > COURSE_AGENT_AVATAR_MAX_DIMENSION ||
    width * height > COURSE_AGENT_AVATAR_MAX_PIXELS
  ) {
    throw invalid('avatar_dimensions_invalid', 'Avatar dimensions exceed the allowed bounds');
  }
}

function validateCrop(
  crop: CourseAgentAvatarCrop,
  imageWidth: number,
  imageHeight: number,
): Required<CourseAgentAvatarCrop> {
  if (crop === null || typeof crop !== 'object') {
    throw invalid('avatar_crop_invalid', 'Avatar crop is required');
  }
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (
    values.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value),
    )
  ) {
    throw invalid('avatar_crop_invalid', 'Avatar crop must contain finite integer coordinates');
  }
  if (crop.width <= 0 || crop.height <= 0 || crop.width !== crop.height) {
    throw invalid('avatar_crop_invalid', 'Avatar crop must be a positive square');
  }
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.x + crop.width > imageWidth ||
    crop.y + crop.height > imageHeight
  ) {
    throw invalid('avatar_crop_invalid', 'Avatar crop must be inside the oriented image');
  }
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

async function verifyOutput(bytes: Buffer): Promise<void> {
  try {
    const metadata = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: 512 * 512,
    }).metadata();
    if (
      metadata.format !== 'webp' ||
      metadata.width !== COURSE_AGENT_AVATAR_OUTPUT_SIZE ||
      metadata.height !== COURSE_AGENT_AVATAR_OUTPUT_SIZE ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.exif !== undefined ||
      metadata.icc !== undefined ||
      metadata.iptc !== undefined ||
      metadata.xmp !== undefined
    ) {
      throw new Error('output contract mismatch');
    }
  } catch {
    throw invalid('avatar_output_invalid', 'Normalized avatar output failed verification');
  }
}

function invalid(code: string, message: string): CourseAgentAvatarValidationError {
  return new CourseAgentAvatarValidationError(code, message);
}

function detectAndValidateContainer(bytes: Buffer): AvatarContentType {
  if (isPng(bytes)) {
    validatePngContainer(bytes);
    return 'image/png';
  }
  if (isJpeg(bytes)) {
    validateJpegContainer(bytes);
    return 'image/jpeg';
  }
  if (isWebp(bytes)) {
    validateWebpContainer(bytes);
    return 'image/webp';
  }
  throw invalid('avatar_encoding_invalid', 'Avatar is not a supported PNG, JPEG, or WebP image');
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

function validatePngContainer(bytes: Buffer): void {
  let cursor = 8;
  let sawHeader = false;
  let sawData = false;
  while (cursor + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(cursor);
    const end = cursor + 12 + size;
    if (end > bytes.length) throw invalid('avatar_truncated', 'PNG container is truncated');
    const type = bytes.toString('ascii', cursor + 4, cursor + 8);
    if (type === 'IHDR') {
      if (sawHeader || size !== 13 || cursor !== 8)
        throw invalid('avatar_encoding_invalid', 'PNG structure is invalid');
      sawHeader = true;
    } else if (type === 'acTL') {
      throw invalid('avatar_animation_not_allowed', 'Animated PNG avatars are not supported');
    } else if (type === 'IDAT') {
      sawData = true;
    } else if (type === 'IEND') {
      if (size !== 0 || !sawHeader || !sawData || end !== bytes.length) {
        throw invalid('avatar_truncated', 'PNG container is incomplete or has trailing data');
      }
      return;
    }
    cursor = end;
  }
  throw invalid('avatar_truncated', 'PNG container is incomplete');
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function validateJpegContainer(bytes: Buffer): void {
  let cursor = 2;
  let sawStartOfFrame = false;
  let sawEnd = false;
  while (cursor < bytes.length) {
    if (bytes[cursor++] !== 0xff)
      throw invalid('avatar_encoding_invalid', 'JPEG marker stream is invalid');
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) throw invalid('avatar_truncated', 'JPEG container is truncated');
    const marker = bytes[cursor++];
    if (marker === 0xd9) {
      if (!sawStartOfFrame) throw invalid('avatar_truncated', 'JPEG container is incomplete');
      // A small number of camera/exporter JPEGs append a four-byte footer after EOI.
      // Permit only that bounded footer shape; larger secondary payloads remain invalid.
      if (bytes.length - cursor > 4) {
        throw invalid('avatar_encoding_invalid', 'JPEG container has trailing data');
      }
      sawEnd = true;
      break;
    }
    if (marker === 0xda) {
      if (cursor + 2 > bytes.length)
        throw invalid('avatar_truncated', 'JPEG scan segment is truncated');
      const scanLength = bytes.readUInt16BE(cursor);
      if (scanLength < 2 || cursor + scanLength > bytes.length) {
        throw invalid('avatar_truncated', 'JPEG scan segment is truncated');
      }
      cursor += scanLength;
      // Entropy-coded bytes may contain FF00 and restart markers; find the EOI.
      let foundMarker = false;
      while (cursor + 1 < bytes.length) {
        if (bytes[cursor] !== 0xff) {
          cursor += 1;
          continue;
        }
        const markerStart = cursor;
        cursor += 1;
        while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
        if (cursor >= bytes.length) break;
        const next = bytes[cursor];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          cursor += 1;
          continue;
        }
        if (next === 0xd9) {
          cursor += 1;
          if (bytes.length - cursor > 4) {
            throw invalid('avatar_encoding_invalid', 'JPEG container has trailing data');
          }
          sawEnd = true;
          foundMarker = true;
          break;
        }
        // Progressive JPEGs have additional marker segments between scans. Let the outer
        // marker parser validate those segments instead of treating them as entropy bytes.
        cursor = markerStart;
        foundMarker = true;
        break;
      }
      if (sawEnd) break;
      if (!foundMarker) throw invalid('avatar_truncated', 'JPEG entropy stream is truncated');
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 2 > bytes.length) throw invalid('avatar_truncated', 'JPEG segment is truncated');
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length)
      throw invalid('avatar_truncated', 'JPEG segment is truncated');
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (sawStartOfFrame)
        throw invalid('avatar_animation_not_allowed', 'Multiple JPEG frames are not supported');
      sawStartOfFrame = true;
    }
    cursor += length;
  }
  if (!sawEnd) throw invalid('avatar_truncated', 'JPEG end marker is missing');
}

function isWebp(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function validateWebpContainer(bytes: Buffer): void {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw invalid('avatar_truncated', 'WebP container has trailing or missing bytes');
  let cursor = 12;
  let sawImage = false;
  while (cursor + 8 <= bytes.length) {
    const type = bytes.toString('ascii', cursor, cursor + 4);
    const size = bytes.readUInt32LE(cursor + 4);
    const end = cursor + 8 + size + (size & 1);
    if (end > bytes.length) throw invalid('avatar_truncated', 'WebP chunk is truncated');
    if (type === 'ANIM' || type === 'ANMF')
      throw invalid('avatar_animation_not_allowed', 'Animated WebP avatars are not supported');
    if (type === 'VP8X' && size >= 1 && (bytes[cursor + 8] & 0x02) !== 0)
      throw invalid('avatar_animation_not_allowed', 'Animated WebP avatars are not supported');
    if (type === 'VP8 ' || type === 'VP8L') sawImage = true;
    cursor = end;
  }
  if (cursor !== bytes.length || !sawImage)
    throw invalid('avatar_encoding_invalid', 'WebP image data is missing');
}
