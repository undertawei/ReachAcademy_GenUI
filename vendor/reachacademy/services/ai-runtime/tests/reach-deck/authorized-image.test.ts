import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthorizedImageError,
  downloadAuthorizedImage,
  loadAuthorizedReferenceImage,
  normalizeReferenceImage,
  REFERENCE_IMAGE_EDIT_PRESET,
  REFERENCE_IMAGE_VISION_PRESET,
} from '../../lib/reach-deck/authorized-image.js';
import { projectDecksmithVisionContentForCapacity } from '../../lib/reach-deck/decksmith/visual-input.js';

const SIGNED_URL = 'https://oss.example/uploads/org/image.png?X-Amz-Signature=abc';

async function png(width: number, height: number, alpha = false): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 20, g: 120, b: 200, alpha: 0.5 } : { r: 20, g: 120, b: 200 },
    },
  })
    .png()
    .toBuffer();
}

function source(bytes: Buffer, contentType = 'image/png') {
  return {
    downloadUrl: SIGNED_URL,
    contentType,
    sizeBytes: bytes.byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function respond(bytes: Uint8Array, init: ResponseInit = {}) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(new Uint8Array(bytes), init),
  );
}

async function failure(promise: Promise<unknown>): Promise<AuthorizedImageError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AuthorizedImageError);
  return error as AuthorizedImageError;
}

describe('authorized reference image download', () => {
  it('downloads a signed image without following redirects and verifies the checksum', async () => {
    const bytes = await png(64, 48);
    const fetchMock = respond(bytes);

    const downloaded = await downloadAuthorizedImage(source(bytes), {
      fetch: fetchMock as typeof fetch,
    });

    expect(Buffer.compare(downloaded, bytes)).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(SIGNED_URL);
    expect(init).toMatchObject({ redirect: 'manual' });
  });

  it('rejects a redirect instead of following it to another host', async () => {
    const bytes = await png(16, 16);
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );

    const error = await failure(
      downloadAuthorizedImage(source(bytes), { fetch: fetchMock as typeof fetch }),
    );
    expect(error.failure).toBe('redirect');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refuses non-HTTPS or credentialed URLs before any request', async () => {
    const bytes = await png(16, 16);
    const fetchMock = respond(bytes);
    for (const downloadUrl of ['http://oss.example/a.png', 'https://user:pw@oss.example/a.png']) {
      const error = await failure(
        downloadAuthorizedImage(
          { ...source(bytes), downloadUrl },
          { fetch: fetchMock as typeof fetch },
        ),
      );
      expect(error.failure).toBe('untrusted-url');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a forged checksum or a size mismatch as an integrity failure', async () => {
    const bytes = await png(32, 32);
    const forged = await failure(
      downloadAuthorizedImage(
        { ...source(bytes), checksumSha256: 'f'.repeat(64) },
        { fetch: respond(bytes) as typeof fetch },
      ),
    );
    expect(forged.failure).toBe('integrity');

    const truncated = await failure(
      downloadAuthorizedImage(
        { ...source(bytes), sizeBytes: bytes.byteLength + 1 },
        { fetch: respond(bytes) as typeof fetch },
      ),
    );
    expect(truncated.failure).toBe('integrity');
  });

  it('enforces the byte budget from metadata, Content-Length, and the streamed body', async () => {
    const bytes = await png(32, 32);
    const declaredTooLarge = await failure(
      downloadAuthorizedImage(source(bytes), {
        fetch: respond(bytes) as typeof fetch,
        maxBytes: bytes.byteLength - 1,
      }),
    );
    expect(declaredTooLarge.failure).toBe('too-large');

    const lyingHeader = vi.fn(
      async () =>
        new Response(new Uint8Array(bytes), {
          headers: { 'content-length': String(64 * 1024 * 1024) },
        }),
    );
    const headerTooLarge = await failure(
      downloadAuthorizedImage(source(bytes), { fetch: lyingHeader as typeof fetch }),
    );
    expect(headerTooLarge.failure).toBe('too-large');

    const oversized = Buffer.concat([bytes, Buffer.alloc(4096)]);
    const streamTooLarge = await failure(
      downloadAuthorizedImage(
        { ...source(bytes), sizeBytes: bytes.byteLength },
        {
          fetch: vi.fn(
            async () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(oversized));
                    controller.close();
                  },
                }),
              ),
          ) as typeof fetch,
          maxBytes: bytes.byteLength + 10,
        },
      ),
    );
    expect(streamTooLarge.failure).toBe('too-large');
  });

  it('reports HTTP failures and times out a stalled download', async () => {
    const bytes = await png(16, 16);
    const status = await failure(
      downloadAuthorizedImage(source(bytes), {
        fetch: vi.fn(async () => new Response('denied', { status: 403 })) as typeof fetch,
      }),
    );
    expect(status.failure).toBe('http-status');

    const stalled = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const timeout = await failure(
      downloadAuthorizedImage(source(bytes), { fetch: stalled as typeof fetch, timeoutMs: 20 }),
    );
    expect(timeout.failure).toBe('timeout');
    expect(timeout.retryable).toBe(true);
  });
});

describe('reference image normalization', () => {
  it('downscales a large opaque image to the edit preset as JPEG within model-service limits', async () => {
    const bytes = await png(3000, 2000);
    const normalized = await loadAuthorizedReferenceImage(
      source(bytes),
      REFERENCE_IMAGE_EDIT_PRESET,
      {
        fetch: respond(bytes) as typeof fetch,
      },
    );

    expect(normalized.contentType).toBe('image/jpeg');
    expect(Math.max(normalized.width, normalized.height)).toBe(2048);
    expect(normalized.bytes.byteLength).toBeLessThanOrEqual(REFERENCE_IMAGE_EDIT_PRESET.maxBytes);
    expect(normalized.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('flattens transparency into a 1024 px JPEG vision thumbnail within its byte budget', async () => {
    const bytes = await png(1600, 900, true);
    const normalized = await normalizeReferenceImage(
      bytes,
      'image/png',
      REFERENCE_IMAGE_VISION_PRESET,
    );
    expect(normalized.contentType).toBe('image/jpeg');
    expect(normalized.width).toBe(1024);
    expect(normalized.bytes.byteLength).toBeLessThanOrEqual(REFERENCE_IMAGE_VISION_PRESET.maxBytes);
    expect(normalized.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('fits a high-noise 1024 px picture into the vision byte budget and the dispatch data URL cap', async () => {
    const width = 1400;
    const height = 1400;
    const raw = Buffer.alloc(width * height * 3);
    let seed = 0x9e3779b9;
    for (let index = 0; index < raw.length; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[index] = seed >>> 24;
    }
    const noisy = await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const normalized = await normalizeReferenceImage(
      noisy,
      'image/jpeg',
      REFERENCE_IMAGE_VISION_PRESET,
    );
    expect(normalized.contentType).toBe('image/jpeg');
    expect(Math.max(normalized.width, normalized.height)).toBe(1024);
    expect(normalized.bytes.byteLength).toBeLessThanOrEqual(REFERENCE_IMAGE_VISION_PRESET.maxBytes);
    // 派发前检查按同一预设的单张上限放行这张图。
    expect(
      projectDecksmithVisionContentForCapacity([
        { role: 'user', content: [{ type: 'image_url', image_url: { url: normalized.dataUrl } }] },
      ]),
    ).not.toBeNull();
  });

  it('rejects bytes whose decoded format differs from the authorized content type', async () => {
    const jpeg = await sharp(await png(32, 32))
      .jpeg()
      .toBuffer();
    const error = await failure(
      normalizeReferenceImage(jpeg, 'image/png', REFERENCE_IMAGE_EDIT_PRESET),
    );
    expect(error.failure).toBe('content-type');
  });

  it('rejects sources over the decode pixel cap and images too small to edit', async () => {
    const bytes = await png(400, 300);
    const huge = await failure(
      normalizeReferenceImage(bytes, 'image/png', {
        ...REFERENCE_IMAGE_EDIT_PRESET,
        maxSourcePixels: 100 * 100,
      }),
    );
    expect(huge.failure).toBe('dimensions');

    const tiny = await failure(
      normalizeReferenceImage(await png(8, 8), 'image/png', REFERENCE_IMAGE_EDIT_PRESET),
    );
    expect(tiny.failure).toBe('dimensions');
  });

  it('rejects undecodable bytes', async () => {
    const error = await failure(
      normalizeReferenceImage(
        Buffer.from('not an image'),
        'image/png',
        REFERENCE_IMAGE_EDIT_PRESET,
      ),
    );
    expect(error.failure).toBe('decode');
  });
});
