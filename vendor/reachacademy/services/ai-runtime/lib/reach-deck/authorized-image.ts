import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * 读取 content-service 授权过的一张图片，并归一为可交给模型的参考图（WP6 参考图编辑与 WP5 视觉
 * 缩略图共用）。
 *
 * 只接受 content-service 刚签发的下载地址（调用方从授权接口拿到，绝不来自模型）：
 * - 仅 https、无用户信息，`redirect: 'manual'`，任何 3xx 一律拒绝，不跟随到别的主机；
 * - 流式读取，声明长度与实际累计字节都受上限约束，整体有超时并响应取消；
 * - 下载字节的 SHA-256 必须等于授权元数据中的 checksum，解码格式必须与授权 contentType 一致；
 * - 解码前先读头部尺寸，超过单边/总像素上限直接拒绝，sharp 再以 `limitInputPixels` 兜底。
 */

export type AuthorizedImageFailure =
  | 'untrusted-url'
  | 'redirect'
  | 'http-status'
  | 'too-large'
  | 'timeout'
  | 'network'
  | 'integrity'
  | 'content-type'
  | 'decode'
  | 'dimensions'
  | 'encode';

export class AuthorizedImageError extends Error {
  constructor(
    message: string,
    readonly failure: AuthorizedImageFailure,
  ) {
    super(message);
    this.name = 'AuthorizedImageError';
  }

  /** 只有网络抖动与超时值得重新授权后再试一次。 */
  get retryable(): boolean {
    return this.failure === 'network' || this.failure === 'timeout';
  }
}

export interface AuthorizedImageSource {
  downloadUrl: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface AuthorizedImageDownloadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/** 与 content-service 参考图上限一致（教师上传图片 15 MiB）。 */
export const AUTHORIZED_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const AUTHORIZED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function downloadAuthorizedImage(
  source: AuthorizedImageSource,
  options: AuthorizedImageDownloadOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? AUTHORIZED_IMAGE_MAX_BYTES;
  if (AUTHORIZED_IMAGE_TYPES[source.contentType] === undefined) {
    throw new AuthorizedImageError('Authorized media is not a supported image', 'content-type');
  }
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0) {
    throw new AuthorizedImageError('Authorized image size is invalid', 'too-large');
  }
  if (source.sizeBytes > maxBytes) {
    throw new AuthorizedImageError('Authorized image exceeds the download budget', 'too-large');
  }
  const url = trustedDownloadUrl(source.downloadUrl);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { redirect: 'manual', signal });
  } catch (error) {
    throw transportError(error, timeout, options.signal);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthorizedImageError('Authorized image download was redirected', 'redirect');
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthorizedImageError(
      `Authorized image download failed with HTTP ${response.status}`,
      'http-status',
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new AuthorizedImageError('Authorized image exceeds the download budget', 'too-large');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const checksum = createHash('sha256');
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new AuthorizedImageError('Authorized image exceeds the download budget', 'too-large');
      }
      chunks.push(value);
      checksum.update(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof AuthorizedImageError) throw error;
    throw transportError(error, timeout, options.signal);
  } finally {
    reader.releaseLock();
  }
  if (total !== source.sizeBytes || checksum.digest('hex') !== source.checksumSha256) {
    throw new AuthorizedImageError('Authorized image integrity check failed', 'integrity');
  }
  return Buffer.concat(chunks, total);
}

export interface ReferenceImagePreset {
  /** 输出最长边（像素），只缩小不放大。 */
  maxEdge: number;
  /** 输出字节上限。 */
  maxBytes: number;
  /** 输出最短边下限（model-service 要求每边 ≥16 px）。 */
  minEdge: number;
  /** 解码前允许的源图单边与总像素上限。 */
  maxSourceEdge: number;
  maxSourcePixels: number;
  /** 只输出 JPEG（透明区域铺白底）；缺省时有透明通道的图优先保留 PNG。 */
  jpegOnly?: boolean;
  /** 依次尝试的 JPEG 质量，第一个不超字节上限的结果胜出。 */
  jpegQualities?: readonly number[];
}

/** WP6：交给 `/v1/images/edits` 的参考图，远低于 model-service 的 4096 px / 16.7 MP / 10 MiB。 */
export const REFERENCE_IMAGE_EDIT_PRESET: ReferenceImagePreset = {
  maxEdge: 2048,
  maxBytes: 4 * 1024 * 1024,
  minEdge: 16,
  maxSourceEdge: 16_384,
  maxSourcePixels: 50_000_000,
};

/**
 * WP5：Decksmith 选中图片的视觉缩略图——最长边 ≤1024 px 的 JPEG，单张 ≤600 KiB。
 * 任何字段变化都必须同步提升 `DECKSMITH_VISION_NORMALIZATION_VERSION`（冻结在 Run 输入中）。
 */
export const REFERENCE_IMAGE_VISION_PRESET: ReferenceImagePreset = {
  maxEdge: 1024,
  maxBytes: 600 * 1024,
  minEdge: 16,
  maxSourceEdge: 16_384,
  maxSourcePixels: 50_000_000,
  jpegOnly: true,
  jpegQualities: [82, 72, 60, 50],
};

export interface NormalizedReferenceImage {
  bytes: Buffer;
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  dataUrl: string;
}

/**
 * 把授权图片归一为 PNG（有透明通道）或 JPEG（不透明，或 PNG 超出字节上限时铺白底），
 * 应用 EXIF 方向、去掉元数据，动图只取首帧。
 */
export async function normalizeReferenceImage(
  bytes: Uint8Array,
  expectedContentType: string,
  preset: ReferenceImagePreset,
): Promise<NormalizedReferenceImage> {
  const expectedFormat = AUTHORIZED_IMAGE_TYPES[expectedContentType];
  if (expectedFormat === undefined) {
    throw new AuthorizedImageError('Authorized media is not a supported image', 'content-type');
  }
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let metadata: sharp.Metadata;
  try {
    // 只读文件头取尺寸，不解码像素；像素上限在下方显式判断，解码时再由 limitInputPixels 兜底。
    metadata = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new AuthorizedImageError('Authorized image could not be decoded', 'decode');
  }
  if (metadata.format !== expectedFormat) {
    throw new AuthorizedImageError(
      'Authorized image bytes do not match their content type',
      'content-type',
    );
  }
  const width = metadata.width ?? 0;
  const height = metadata.pageHeight ?? metadata.height ?? 0;
  if (
    width <= 0 ||
    height <= 0 ||
    Math.max(width, height) > preset.maxSourceEdge ||
    width * height > preset.maxSourcePixels
  ) {
    throw new AuthorizedImageError('Authorized image dimensions are out of range', 'dimensions');
  }
  const scale = Math.min(1, preset.maxEdge / Math.max(width, height));
  // EXIF 旋转 5–8 会交换宽高；按旋转后的尺寸判断下限。
  if (Math.min(width, height) * scale < preset.minEdge) {
    throw new AuthorizedImageError('Authorized image is too small to edit', 'dimensions');
  }
  try {
    const base = () =>
      sharp(input, { limitInputPixels: preset.maxSourcePixels, failOn: 'error' }).rotate().resize({
        width: preset.maxEdge,
        height: preset.maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
    const candidates: Array<() => Promise<{ data: Buffer; info: sharp.OutputInfo }>> = [];
    if (metadata.hasAlpha === true && preset.jpegOnly !== true) {
      candidates.push(() =>
        base().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({
          resolveWithObject: true,
        }),
      );
    }
    for (const quality of preset.jpegQualities ?? [88, 78, 68]) {
      candidates.push(() =>
        base()
          .flatten({ background: '#ffffff' })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer({ resolveWithObject: true }),
      );
    }
    for (const candidate of candidates) {
      const { data, info } = await candidate();
      if (data.byteLength === 0 || data.byteLength > preset.maxBytes) continue;
      const contentType = info.format === 'png' ? 'image/png' : 'image/jpeg';
      return {
        bytes: data,
        contentType,
        width: info.width,
        height: info.height,
        dataUrl: `data:${contentType};base64,${data.toString('base64')}`,
      };
    }
  } catch (error) {
    if (error instanceof AuthorizedImageError) throw error;
    throw new AuthorizedImageError('Authorized image could not be decoded', 'decode');
  }
  throw new AuthorizedImageError('Reference image exceeds the encoded byte budget', 'encode');
}

/** 下载 + 校验 + 归一的组合入口。 */
export async function loadAuthorizedReferenceImage(
  source: AuthorizedImageSource,
  preset: ReferenceImagePreset,
  options: AuthorizedImageDownloadOptions = {},
): Promise<NormalizedReferenceImage> {
  const bytes = await downloadAuthorizedImage(source, options);
  options.signal?.throwIfAborted();
  return normalizeReferenceImage(bytes, source.contentType, preset);
}

function trustedDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthorizedImageError('Authorized image URL is invalid', 'untrusted-url');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new AuthorizedImageError(
      'Authorized image URL is not a signed HTTPS URL',
      'untrusted-url',
    );
  }
  return url;
}

function transportError(
  error: unknown,
  timeout: AbortSignal,
  parent: AbortSignal | undefined,
): Error {
  if (parent?.aborted) {
    return parent.reason instanceof Error ? parent.reason : new Error('aborted');
  }
  if (timeout.aborted) {
    return new AuthorizedImageError('Authorized image download timed out', 'timeout');
  }
  return new AuthorizedImageError(
    `Authorized image download failed: ${error instanceof Error ? error.message : String(error)}`,
    'network',
  );
}
