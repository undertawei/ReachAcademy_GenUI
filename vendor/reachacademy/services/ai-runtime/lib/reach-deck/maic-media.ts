import { createHash } from 'node:crypto';
import { lookup as lookupDns } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import { storeReachDeckGeneratedMedia } from './content-service-client.js';
import type { ContentServiceRequestOptions } from './content-service-client.js';
import {
  normalizeReachDeckImportRaster,
  REACH_DECK_IMPORT_IMAGE_MAX_BYTES,
  REACH_DECK_IMPORT_IMAGE_OUTPUT_TYPES,
} from './import-image-normalization.js';

const ALLOWED_HOSTNAMES = new Set(['file.maic.chat', 'maic-prod.oss-cn-wulanchabu.aliyuncs.com']);
/**
 * MAIC 导入的媒体体积预算。
 *
 * maxTotalSourceBytes 只是下载阶段的内存护栏，maxTotalMediaBytes 才是真正的入库
 * 预算，按归一化（≤2880px WebP）之后的字节计。两者分开是因为归一化压缩比很高，
 * 按原始下载字节计会把体积正常的课件误拒——《魏晋南北朝美术1》原始 129 MB，落库
 * 后远低于此。
 */
export const REACH_DECK_MAIC_MEDIA_LIMITS = Object.freeze({
  maxImageSourceBytes: 64 * 1024 * 1024,
  maxAudioSourceBytes: 32 * 1024 * 1024,
  maxTotalSourceBytes: 512 * 1024 * 1024,
  maxTotalMediaBytes: 256 * 1024 * 1024,
});

export type ReachDeckMaicMediaLimits = typeof REACH_DECK_MAIC_MEDIA_LIMITS;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ReachDeckMaicRemoteMediaReference {
  id?: string;
  url: string;
  kind: 'image' | 'audio';
}

export interface ReachDeckMaicResolvedMedia {
  objectKey: string;
  previewUrl?: string;
  contentType: string;
  byteLength: number;
  digest: `sha256:${string}`;
  normalization?: {
    sourceContentType: string;
    sourceByteLength: number;
  };
}

/** 单个媒体对象取回/入库失败的记录，供调用方降级成按页诊断。 */
export interface ReachDeckMaicMediaFailure {
  url: string;
  kind: 'image' | 'audio';
  referenceIds: readonly string[];
  code: string;
  message: string;
}

export interface ReachDeckMaicMediaResolution {
  resolved: ReadonlyMap<string, ReachDeckMaicResolvedMedia>;
  failures: readonly ReachDeckMaicMediaFailure[];
}

export type ReachDeckMaicMediaResolver = (
  references: readonly ReachDeckMaicRemoteMediaReference[],
) => Promise<ReachDeckMaicMediaResolution>;

interface MaicMediaFetchDependencies {
  /** 仅供测试收窄预算，生产走 REACH_DECK_MAIC_MEDIA_LIMITS。 */
  limits?: Partial<ReachDeckMaicMediaLimits>;
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  request?: typeof httpsRequest;
  fetchMedia?: (
    reference: ReachDeckMaicRemoteMediaReference,
  ) => Promise<Awaited<ReturnType<typeof fetchReachDeckMaicMedia>>>;
}

interface ResolvedAddress {
  address: string;
  family: number;
}

export function createReachDeckMaicMediaResolver(
  storageOptions: ContentServiceRequestOptions,
  dependencies: MaicMediaFetchDependencies = {},
): ReachDeckMaicMediaResolver {
  const limits = { ...REACH_DECK_MAIC_MEDIA_LIMITS, ...dependencies.limits };
  return async (references) => {
    const unique = new Map<string, ReachDeckMaicRemoteMediaReference>();
    const referenceIds = new Map<string, string[]>();
    for (const reference of references) {
      const canonical = validateMaicMediaUrl(reference.url).toString();
      const identity = `${reference.kind}\n${canonical}`;
      const conflicting = [...unique.values()].find(
        (candidate) => candidate.url === canonical && candidate.kind !== reference.kind,
      );
      if (conflicting !== undefined) {
        throw new ReachDeckMaicMediaError(
          'MAIC media URL is referenced with conflicting media kinds',
          'maic.media.kind_conflict',
        );
      }
      unique.set(identity, { ...reference, url: canonical });
      if (reference.id !== undefined) {
        referenceIds.set(identity, [...(referenceIds.get(identity) ?? []), reference.id]);
      }
    }

    const failures: ReachDeckMaicMediaFailure[] = [];
    // 单个对象的失败只记录、不抛：调用方据此把受影响的页降级成 error，其余页照常
    // 导入。只有全局性问题（总量超限、存储服务不可用）才继续向上抛成 fatal。
    const recordFailure = (
      identity: string,
      url: string,
      kind: 'image' | 'audio',
      error: unknown,
    ): void => {
      if (!(error instanceof ReachDeckMaicMediaError)) throw error;
      failures.push({
        url,
        kind,
        referenceIds: referenceIds.get(identity) ?? [],
        code: error.code,
        message: error.message,
      });
    };

    const fetched: Array<{
      identity: string;
      url: string;
      media: Awaited<ReturnType<typeof fetchReachDeckMaicMedia>>;
    }> = [];
    let sourceBytesTotal = 0;
    for (const [identity, reference] of unique) {
      let media: Awaited<ReturnType<typeof fetchReachDeckMaicMedia>>;
      try {
        media =
          dependencies.fetchMedia === undefined
            ? await fetchReachDeckMaicMedia(reference, dependencies)
            : await dependencies.fetchMedia(reference);
      } catch (error) {
        recordFailure(identity, reference.url, reference.kind, error);
        continue;
      }
      sourceBytesTotal += media.bytes.byteLength;
      if (sourceBytesTotal > limits.maxTotalSourceBytes) {
        throw new ReachDeckMaicMediaError(
          'MAIC import remote media exceeds the total source byte limit',
          'maic.media.total_source_too_large',
        );
      }
      fetched.push({ identity, url: reference.url, media });
    }

    const storedByDigest = new Map<string, ReachDeckMaicResolvedMedia>();
    const resolved = new Map<string, ReachDeckMaicResolvedMedia>();
    let storedBytesTotal = 0;
    for (const item of fetched) {
      const sourceBytes = item.media.bytes;
      const sourceContentType = item.media.contentType;
      const digest = sha256(sourceBytes);
      const deduplicationKey = `${item.media.kind}:${digest}`;
      let stored = storedByDigest.get(deduplicationKey);
      if (stored === undefined) {
        let upload: { bytes: Uint8Array; contentType: string; normalized: boolean };
        try {
          upload =
            item.media.kind === 'image'
              ? await prepareMaicImageForStorage(sourceBytes, sourceContentType)
              : { bytes: sourceBytes, contentType: sourceContentType, normalized: false };
        } catch (error) {
          recordFailure(item.identity, item.url, item.media.kind, error);
          continue;
        }
        // 入库预算按归一化之后的字节计，且只计真正新落库的对象（同摘要已去重），
        // 这才是实际占用的存储量；按原始下载字节计会把可正常压缩的课件误拒。
        storedBytesTotal += upload.bytes.byteLength;
        if (storedBytesTotal > limits.maxTotalMediaBytes) {
          throw new ReachDeckMaicMediaError(
            'MAIC import remote media exceeds the total byte limit',
            'maic.media.total_too_large',
          );
        }
        const result = await storeReachDeckGeneratedMedia(
          {
            kind: item.media.kind === 'audio' ? 'speech' : 'image',
            idempotencyKey: `maic-media:${item.media.kind}:${digest}`,
            contentType: upload.contentType,
            bytes: upload.bytes,
          },
          storageOptions,
        );
        stored = {
          objectKey: result.objectKey,
          previewUrl: result.downloadUrl,
          contentType: result.contentType,
          byteLength: result.sizeBytes,
          digest: `sha256:${result.checksumSha256}`,
          ...(upload.normalized
            ? {
                normalization: {
                  sourceContentType,
                  sourceByteLength: sourceBytes.byteLength,
                },
              }
            : {}),
        };
        storedByDigest.set(deduplicationKey, stored);
      }
      resolved.set(item.url, stored);
      for (const id of referenceIds.get(item.identity) ?? []) resolved.set(id, stored);
    }
    return { resolved, failures };
  };
}

export class ReachDeckMaicMediaError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ReachDeckMaicMediaError';
  }
}

export async function fetchReachDeckMaicMedia(
  reference: ReachDeckMaicRemoteMediaReference,
  dependencies: MaicMediaFetchDependencies = {},
): Promise<{ kind: 'image' | 'audio'; bytes: Uint8Array; contentType: string }> {
  let current = validateMaicMediaUrl(reference.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const addresses = await resolvePublicAddresses(current.hostname, dependencies.lookup);
    const response = await requestPinned(current, addresses[0]!, dependencies.request);
    if (isRedirect(response.statusCode)) {
      await discardResponse(response.body);
      if (redirects === MAX_REDIRECTS) {
        throw new ReachDeckMaicMediaError(
          'MAIC media exceeded the redirect limit',
          'maic.media.redirect_limit',
        );
      }
      const location = response.headers.location;
      if (location === undefined) {
        throw new ReachDeckMaicMediaError(
          'MAIC media redirect is missing a location',
          'maic.media.redirect_invalid',
        );
      }
      current = validateMaicMediaUrl(new URL(location, current).toString());
      continue;
    }
    if (response.statusCode !== 200) {
      await discardResponse(response.body);
      throw new ReachDeckMaicMediaError(
        `MAIC media returned HTTP ${response.statusCode}`,
        'maic.media.http_status',
      );
    }
    const fetchLimits = { ...REACH_DECK_MAIC_MEDIA_LIMITS, ...dependencies.limits };
    const maximumBytes =
      reference.kind === 'image'
        ? fetchLimits.maxImageSourceBytes
        : fetchLimits.maxAudioSourceBytes;
    const declaredLength = readContentLength(response.headers['content-length']);
    if (declaredLength !== undefined && declaredLength > maximumBytes) {
      await discardResponse(response.body);
      throw new ReachDeckMaicMediaError(
        'MAIC remote media exceeds the per-object byte limit',
        'maic.media.too_large',
      );
    }
    const bytes = await readBoundedResponse(response.body, maximumBytes);
    if (declaredLength !== undefined && declaredLength !== bytes.byteLength) {
      throw new ReachDeckMaicMediaError(
        'MAIC media content-length does not match its body',
        'maic.media.length_mismatch',
      );
    }
    const declaredType = normalizeContentType(response.headers['content-type']);
    const detectedType = detectMediaContentType(bytes);
    assertMediaKindAndType(reference.kind, declaredType, detectedType);
    return { kind: reference.kind, bytes, contentType: detectedType };
  }
  throw new ReachDeckMaicMediaError('MAIC media fetch failed', 'maic.media.fetch_failed');
}

export function validateMaicMediaUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReachDeckMaicMediaError('MAIC media URL is invalid', 'maic.media.url_invalid');
  }
  if (
    url.protocol !== 'https:' ||
    !ALLOWED_HOSTNAMES.has(url.hostname) ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    isIP(url.hostname) !== 0
  ) {
    throw new ReachDeckMaicMediaError(
      'MAIC media URL is outside the allowed HTTPS origin',
      'maic.media.url_forbidden',
    );
  }
  return url;
}

async function resolvePublicAddresses(
  hostname: string,
  lookup: MaicMediaFetchDependencies['lookup'],
): Promise<readonly ResolvedAddress[]> {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (lookup ?? ((name) => lookupDns(name, { all: true, verbatim: true })))(
      hostname,
    );
  } catch {
    throw new ReachDeckMaicMediaError('MAIC media DNS lookup failed', 'maic.media.dns_failed');
  }
  if (addresses.length === 0 || addresses.some((entry) => !isGlobalAddress(entry.address))) {
    throw new ReachDeckMaicMediaError(
      'MAIC media hostname resolved to a non-public address',
      'maic.media.address_forbidden',
    );
  }
  return addresses;
}

function requestPinned(
  url: URL,
  address: ResolvedAddress,
  request: typeof httpsRequest = httpsRequest,
): Promise<{
  statusCode: number;
  headers: import('node:http').IncomingHttpHeaders;
  body: import('node:http').IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.hostname,
      headers: { accept: 'image/png,image/jpeg,image/webp,image/gif,audio/mpeg' },
      lookup: (_hostname, options, callback) => {
        // Node's automatic family selection requests an array via all:true.
        // Both forms must retain the same prevalidated address pin.
        if (options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    };
    const outgoing = request(options, (response) => {
      resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response });
    });
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('request timeout'));
    });
    outgoing.once('error', () => {
      reject(
        new ReachDeckMaicMediaError(
          'MAIC media request failed or timed out',
          'maic.media.request_failed',
        ),
      );
    });
    outgoing.end();
  });
}

function isGlobalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isGlobalIpv4(address);
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isGlobalIpv4(lower.slice(7));
  const first = Number.parseInt(lower.split(':', 1)[0] || '0', 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  // The IETF special-purpose registry reserves a dense set below 2001:0200.
  // Conservatively reject that block rather than attempting an incomplete
  // denylist. Public allocations elsewhere in 2000::/3 remain eligible.
  if (first === 0x2001) {
    const second = Number.parseInt(lower.split(':')[1] || '0', 16);
    if (second < 0x0200 || second === 0x0db8) return false;
  }
  return first !== 0x2002;
}

function isGlobalIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function readContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ReachDeckMaicMediaError(
      'MAIC media content-length is invalid',
      'maic.media.length_invalid',
    );
  }
  return Number(value);
}

function normalizeContentType(value: string | string[] | undefined): string {
  if (typeof value !== 'string') {
    throw new ReachDeckMaicMediaError(
      'MAIC media content-type is missing',
      'maic.media.mime_missing',
    );
  }
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function detectMediaContentType(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 6 &&
    (String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a' ||
      String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a')
  )
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  // TIFF 与 AVIF 不是落库格式，但 sharp 能解码，会在 prepareMaicImageForStorage
  // 里统一转成 WebP。MAIC 的 CDN 会把这两类对象挂在 .png key 上，缺少这里的分支
  // 会让单个对象直接抛 magic_unsupported，进而使整份课件导入 fatal 失败。
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  )
    return 'image/tiff';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' &&
    (String.fromCharCode(...bytes.slice(8, 12)) === 'avif' ||
      String.fromCharCode(...bytes.slice(8, 12)) === 'avis')
  )
    return 'image/avif';
  if (
    (bytes.length >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === 'ID3') ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  )
    return 'audio/mpeg';
  throw new ReachDeckMaicMediaError(
    'MAIC media has an unsupported binary signature',
    'maic.media.magic_unsupported',
  );
}

function assertMediaKindAndType(kind: 'image' | 'audio', declared: string, detected: string): void {
  const allowed =
    kind === 'image'
      ? new Set([...REACH_DECK_IMPORT_IMAGE_OUTPUT_TYPES, 'image/gif', 'image/tiff', 'image/avif'])
      : new Set(['audio/mpeg']);
  // 魔数是唯一权威：detected 决定实际落库的 contentType，而且图片还会再过一遍
  // sharp。MAIC 的 CDN 会把 WebP 对象挂在 .png key 上并回 Content-Type: image/png，
  // 所以 declared 只做家族级 sanity 校验，不再要求与 detected 完全相等——否则
  // 单个被错标的对象就会让整份课件导入直接 fatal。
  const declaredFamily = kind === 'image' ? 'image/' : 'audio/';
  if (!allowed.has(detected) || !declared.startsWith(declaredFamily)) {
    throw new ReachDeckMaicMediaError(
      'MAIC media MIME type does not match its declared kind and binary signature',
      'maic.media.mime_mismatch',
    );
  }
}

async function prepareMaicImageForStorage(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ bytes: Uint8Array; contentType: string; normalized: boolean }> {
  // 不能只按字节数短路放行：导入舞台的 2880px 上限判断在 normalize 内部，提前
  // 返回会让像素极大但字节不超限的图原样落库（实测《魏晋南北朝美术1》80 个唯一
  // 对象里 79 个走了这条短路）。这里统一交给 normalize，只把 passthrough 的字节
  // 预算放宽到落库上限，保证尺寸本就正常的图仍然字节一致、不做无谓重编码。
  const normalized = await normalizeReachDeckImportRaster(bytes, contentType, {
    passthroughByteBudget: REACH_DECK_IMPORT_IMAGE_MAX_BYTES,
  });
  if (normalized === undefined) {
    throw new ReachDeckMaicMediaError(
      'MAIC image could not be normalized to the generated-media contract',
      'maic.media.image_normalization_failed',
    );
  }
  // passthrough 分支原样返回入参引用，据此区分是否真的重编码过。
  return { ...normalized, normalized: normalized.bytes !== bytes };
}

async function readBoundedResponse(
  body: import('node:http').IncomingMessage,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunkValue of body) {
    const chunk = typeof chunkValue === 'string' ? Buffer.from(chunkValue) : chunkValue;
    length += chunk.byteLength;
    if (length > maximumBytes) {
      body.destroy();
      throw new ReachDeckMaicMediaError(
        'MAIC remote media exceeds the per-object byte limit',
        'maic.media.too_large',
      );
    }
    chunks.push(new Uint8Array(chunk));
  }
  if (length === 0) {
    throw new ReachDeckMaicMediaError('MAIC remote media is empty', 'maic.media.empty');
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function discardResponse(body: import('node:http').IncomingMessage): Promise<void> {
  // Redirect and error bodies are untrusted too. Do not drain an unbounded
  // response before following a validated redirect.
  body.destroy();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
