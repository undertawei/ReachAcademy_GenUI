import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import sharp from 'sharp';

export type ReferenceImageDownloadFailure =
  | 'unsafe-url'
  | 'dns-failed'
  | 'host-not-public'
  | 'http-status'
  | 'too-large'
  | 'network'
  | 'content-type'
  | 'decode-format'
  | 'dimensions'
  | 'redirect-budget';

/** Classified download rejection; `detail` feeds the bounded reference-image diagnostic. */
export class ReferenceImageDownloadError extends Error {
  constructor(
    message: string,
    readonly failure: ReferenceImageDownloadFailure,
    readonly detail: {
      status?: number;
      contentType?: string;
      bytes?: number;
      width?: number;
      height?: number;
    } = {},
  ) {
    super(message);
  }
}

/** Transient transport failure: the only download error the resolver retries. */
export class ReferenceImageNetworkError extends ReferenceImageDownloadError {
  constructor(message: string) {
    super(message, 'network');
  }
}

export async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) !== 4) return false; // IPv4-only pinned transport; never fall through to IPv6.
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export async function downloadReferenceImage(
  value: string,
  signal: AbortSignal,
  resolve = lookup,
): Promise<{
  bytes: Uint8Array;
  contentType: 'image/png';
  width: number;
  height: number;
  /** Diagnostics only: the upstream content type and byte size before PNG normalization. */
  source?: { contentType: string; bytes: number };
}> {
  let target = new URL(value);
  for (let hop = 0; hop < 4; hop++) {
    signal.throwIfAborted();
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      (target.port && target.port !== '443')
    )
      throw new ReferenceImageDownloadError(
        'Image download requires a public HTTPS URL',
        'unsafe-url',
      );
    let addresses: { address: string; family: number }[];
    try {
      addresses = await withAbort(resolve(target.hostname, { all: true, family: 4 }), signal);
    } catch (error) {
      signal.throwIfAborted();
      throw Object.assign(
        new ReferenceImageDownloadError('Image host lookup failed', 'dns-failed'),
        {
          cause: error,
        },
      );
    }
    if (!addresses.length || addresses.some((x) => !isPublicImageAddress(x.address)))
      throw new ReferenceImageDownloadError('Image host is not public', 'host-not-public');
    const address = addresses[0]!.address;
    const response = await new Promise<{
      status: number;
      location?: string;
      type: string;
      bytes: Buffer;
    }>((resolveResponse, reject) => {
      const req = https.get(
        target,
        {
          signal,
          agent: false,
          lookup: ((_host: unknown, options: unknown, cb: unknown) => {
            const done = cb as (...args: unknown[]) => void;
            if ((options as { all?: boolean }).all) done(null, [{ address, family: 4 }]);
            else done(null, address, 4);
          }) as never,
          headers: {
            Accept: 'image/png,image/jpeg,image/webp',
            'User-Agent': 'ReachAcademy-ImageSearch/1.0',
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
            res.destroy();
            resolveResponse({
              status: res.statusCode,
              location: res.headers.location,
              type: '',
              bytes: Buffer.alloc(0),
            });
            return;
          }
          const declaredBytes = Number(res.headers['content-length'] || 0);
          if (res.statusCode !== 200 || declaredBytes > 12000000) {
            res.destroy();
            reject(
              new ReferenceImageDownloadError(
                'Image HTTP response rejected',
                res.statusCode !== 200 ? 'http-status' : 'too-large',
                {
                  ...(res.statusCode !== undefined ? { status: res.statusCode } : {}),
                  contentType: String(res.headers['content-type'] || '').split(';')[0]!,
                  ...(declaredBytes > 0 ? { bytes: declaredBytes } : {}),
                },
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (b: Buffer) => {
            size += b.length;
            if (size > 12000000) {
              res.destroy();
              reject(
                new ReferenceImageDownloadError('Image exceeds byte budget', 'too-large', {
                  bytes: size,
                }),
              );
            } else chunks.push(b);
          });
          res.on('error', () =>
            reject(new ReferenceImageNetworkError('Image download interrupted')),
          );
          res.on('end', () =>
            resolveResponse({
              status: 200,
              type: String(res.headers['content-type'] || '').split(';')[0]!,
              bytes: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on('error', () =>
        reject(
          signal.aborted
            ? signal.reason
            : new ReferenceImageNetworkError('Image download connection failed'),
        ),
      );
    });
    if (response.location) {
      target = new URL(response.location, target);
      continue;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(response.type))
      throw new ReferenceImageDownloadError('Unsupported downloaded image type', 'content-type', {
        status: response.status,
        contentType: response.type,
        bytes: response.bytes.length,
      });
    const image = sharp(response.bytes, { limitInputPixels: 16000000, animated: false });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? ''))
      throw new ReferenceImageDownloadError('Decoded image format rejected', 'decode-format', {
        contentType: response.type,
        bytes: response.bytes.length,
      });
    if (
      !metadata.width ||
      !metadata.height ||
      Math.min(metadata.width, metadata.height) < 240 ||
      (metadata.pages ?? 1) > 1
    )
      throw new ReferenceImageDownloadError('Image dimensions rejected', 'dimensions', {
        contentType: response.type,
        bytes: response.bytes.length,
        ...(metadata.width ? { width: metadata.width } : {}),
        ...(metadata.height ? { height: metadata.height } : {}),
      });
    const bytes = await image
      .rotate()
      .resize({ width: 1920, height: 1440, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    signal.throwIfAborted();
    return {
      bytes,
      contentType: 'image/png',
      width: metadata.width,
      height: metadata.height,
      source: { contentType: response.type, bytes: response.bytes.length },
    };
  }
  throw new ReferenceImageDownloadError('Image redirect budget exhausted', 'redirect-budget');
}
