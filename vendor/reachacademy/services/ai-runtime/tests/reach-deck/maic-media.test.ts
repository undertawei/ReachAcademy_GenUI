import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';

import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createReachDeckMaicMediaResolver,
  fetchReachDeckMaicMedia,
  ReachDeckMaicMediaError,
  validateMaicMediaUrl,
} from '../../lib/reach-deck/maic-media.js';
import { storeReachDeckGeneratedMedia } from '../../lib/reach-deck/content-service-client.js';

vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  storeReachDeckGeneratedMedia: vi.fn(),
}));

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

const storedMedia = vi.mocked(storeReachDeckGeneratedMedia);

describe('Reach Deck MAIC remote media boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])('honors scalar and all-address lookup contracts for IPv$family', async (pinned) => {
    const lookup = vi.fn(async () => [pinned, { address: '8.8.8.8', family: 4 }]);
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    await fetchReachDeckMaicMedia(
      { url: 'https://file.maic.chat/image.png', kind: 'image' },
      { lookup, request },
    );
    const options = request.mock.calls[0]?.[0] as RequestOptions;
    for (const mode of [{ all: true }, { all: false }, {}]) {
      const callback = vi.fn();
      options.lookup!('file.maic.chat', mode, callback);
      if (mode.all) expect(callback).toHaveBeenCalledExactlyOnceWith(null, [pinned]);
      else expect(callback).toHaveBeenCalledExactlyOnceWith(null, pinned.address, pinned.family);
    }
    expect(lookup).toHaveBeenCalledExactlyOnceWith('file.maic.chat');
    expect(options.hostname).toBe('file.maic.chat');
    expect(options.servername).toBe('file.maic.chat');
  });

  it('accepts only the two exact approved MAIC HTTPS hosts', () => {
    expect(validateMaicMediaUrl('https://file.maic.chat/course/image.png').hostname).toBe(
      'file.maic.chat',
    );
    expect(
      validateMaicMediaUrl('https://maic-prod.oss-cn-wulanchabu.aliyuncs.com/course/image.png')
        .hostname,
    ).toBe('maic-prod.oss-cn-wulanchabu.aliyuncs.com');
    for (const value of [
      'http://file.maic.chat/course/image.png',
      'https://file.maic.chat.evil.test/image.png',
      'https://maic-prod.oss-cn-wulanchabu.aliyuncs.com.evil.test/image.png',
      'https://other.oss-cn-wulanchabu.aliyuncs.com/image.png',
      'https://user@file.maic.chat/image.png',
      'https://file.maic.chat:444/image.png',
      'https://file.maic.chat/image.png#fragment',
      'https://127.0.0.1/image.png',
    ]) {
      expect(() => validateMaicMediaUrl(value)).toThrow(ReachDeckMaicMediaError);
    }
  });

  it('rejects private DNS answers before opening a connection', async () => {
    const request = vi.fn();
    await expect(
      fetchReachDeckMaicMedia(
        { url: 'https://file.maic.chat/image.png', kind: 'image' },
        {
          lookup: async () => [{ address: '127.0.0.1', family: 4 }],
          request: request as never,
        },
      ),
    ).rejects.toMatchObject({ code: 'maic.media.address_forbidden' });
    expect(request).not.toHaveBeenCalled();
  });

  it('pins the validated public answer and accepts matching PNG MIME and magic bytes', async () => {
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/png', 'content-length': '8' },
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    const media = await fetchReachDeckMaicMedia(
      { url: 'https://file.maic.chat/image.png', kind: 'image' },
      {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request,
      },
    );
    expect(media).toMatchObject({ kind: 'image', contentType: 'image/png' });
    const options = request.mock.calls[0]?.[0] as RequestOptions;
    expect(options.servername).toBe('file.maic.chat');
    expect(options.lookup).toBeTypeOf('function');
  });

  it('trusts the binary signature over a mislabelled image content-type', async () => {
    // MAIC 的 CDN 会把 WebP 对象挂在 .png key 上并回 Content-Type: image/png。
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '8' },
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    const media = await fetchReachDeckMaicMedia(
      { url: 'https://file.maic.chat/image.png', kind: 'image' },
      {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request,
      },
    );
    expect(media).toMatchObject({ kind: 'image', contentType: 'image/png' });
  });

  it('rejects a declared content-type from the wrong media family', async () => {
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': '8' },
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    await expect(
      fetchReachDeckMaicMedia(
        { url: 'https://file.maic.chat/image.png', kind: 'image' },
        {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          request,
        },
      ),
    ).rejects.toMatchObject({ code: 'maic.media.mime_mismatch' });
  });

  it('rejects an image payload requested as audio', async () => {
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': '8' },
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    await expect(
      fetchReachDeckMaicMedia(
        { url: 'https://file.maic.chat/clip.mp3', kind: 'audio' },
        {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          request,
        },
      ),
    ).rejects.toMatchObject({ code: 'maic.media.mime_mismatch' });
  });

  it('accepts matching GIF input and normalizes it to bounded WebP storage', async () => {
    const gif = new Uint8Array(
      await sharp({
        create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 220 } },
      })
        .gif()
        .toBuffer(),
    );
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/gif', 'content-length': String(gif.byteLength) },
      bytes: gif,
    });
    storedMedia.mockImplementationOnce(async (input) => ({
      objectKey: 'generated/normalized.webp',
      downloadUrl: 'https://preview.test/normalized.webp',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: 'a'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      lookup: publicLookup,
      request,
    });

    const { resolved } = await resolver([
      { id: 'gif-reference', url: 'https://file.maic.chat/actually-a-gif.png', kind: 'image' },
    ]);

    const upload = storedMedia.mock.calls.at(-1)?.[0];
    expect(upload?.contentType).toBe('image/webp');
    expect(upload?.bytes.byteLength).toBeGreaterThan(0);
    expect(upload?.bytes.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(resolved.get('gif-reference')).toMatchObject({
      contentType: 'image/webp',
      normalization: { sourceContentType: 'image/gif', sourceByteLength: gif.byteLength },
    });
  });

  it('accepts a TIFF object mislabelled as PNG and normalizes it to WebP storage', async () => {
    // 线上课件（秦汉美术2）里有一张大端 TIFF 挂在 .png key 上并回 Content-Type:
    // image/tiff。缺少 TIFF 魔数分支时它会抛 magic_unsupported，使整份 58 页课件
    // 导入直接 fatal 失败。
    const tiff = new Uint8Array(
      await sharp({
        create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 220 } },
      })
        .tiff()
        .toBuffer(),
    );
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/tiff', 'content-length': String(tiff.byteLength) },
      bytes: tiff,
    });
    storedMedia.mockImplementationOnce(async (input) => ({
      objectKey: 'generated/from-tiff.webp',
      downloadUrl: 'https://preview.test/from-tiff.webp',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: 'c'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      lookup: publicLookup,
      request,
    });

    const { resolved } = await resolver([
      { id: 'tiff-reference', url: 'https://file.maic.chat/actually-a-tiff.png', kind: 'image' },
    ]);

    const upload = storedMedia.mock.calls.at(-1)?.[0];
    expect(upload?.contentType).toBe('image/webp');
    expect(upload?.bytes.byteLength).toBeGreaterThan(0);
    expect(resolved.get('tiff-reference')).toMatchObject({
      contentType: 'image/webp',
      normalization: { sourceContentType: 'image/tiff', sourceByteLength: tiff.byteLength },
    });
  });

  it('normalizes a PNG source above 10 MiB before storage', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 120, b: 220 } },
    })
      .png()
      .toBuffer();
    const source = new Uint8Array(10 * 1024 * 1024 + 1);
    source.set(png);
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(source.byteLength) },
      bytes: source,
    });
    storedMedia.mockImplementationOnce(async (input) => ({
      objectKey: 'generated/large.webp',
      downloadUrl: 'https://preview.test/large.webp',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: 'b'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      lookup: publicLookup,
      request,
    });

    const { resolved } = await resolver([
      { id: 'large-png', url: 'https://file.maic.chat/large.png', kind: 'image' },
    ]);

    const upload = storedMedia.mock.calls.at(-1)?.[0];
    expect(upload?.contentType).toBe('image/webp');
    expect(upload?.bytes.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(resolved.get('large-png')?.normalization).toEqual({
      sourceContentType: 'image/png',
      sourceByteLength: source.byteLength,
    });
  });

  it('stores a supported PNG at or below 10 MiB byte-identical', async () => {
    const png = new Uint8Array(
      await sharp({
        create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 220 } },
      })
        .png()
        .toBuffer(),
    );
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
      bytes: png,
    });
    storedMedia.mockImplementationOnce(async (input) => ({
      objectKey: 'generated/original.png',
      downloadUrl: 'https://preview.test/original.png',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: 'c'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      lookup: publicLookup,
      request,
    });

    const { resolved } = await resolver([
      { id: 'original-png', url: 'https://file.maic.chat/original.png', kind: 'image' },
    ]);

    const upload = storedMedia.mock.calls.at(-1)?.[0];
    expect(upload).toMatchObject({ contentType: 'image/png', bytes: png });
    expect(resolved.get('original-png')?.normalization).toBeUndefined();
  });

  it.each([
    { kind: 'image' as const, maximum: 4096 },
    { kind: 'audio' as const, maximum: 2048 },
  ])('enforces the $kind declared source-byte ceiling', async ({ kind, maximum }) => {
    const request = createRequestMock({
      statusCode: 200,
      headers: {
        'content-type': kind === 'image' ? 'image/png' : 'audio/mpeg',
        'content-length': String(maximum + 1),
      },
      bytes: new Uint8Array(),
    });

    await expect(
      fetchReachDeckMaicMedia(
        { url: `https://file.maic.chat/declared-${kind}`, kind },
        {
          lookup: publicLookup,
          request,
          limits: { maxImageSourceBytes: 4096, maxAudioSourceBytes: 2048 },
        },
      ),
    ).rejects.toMatchObject({ code: 'maic.media.too_large' });
  });

  it.each([
    { kind: 'image' as const, maximum: 4096 },
    { kind: 'audio' as const, maximum: 2048 },
  ])('enforces the $kind streamed source-byte ceiling', async ({ kind, maximum }) => {
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': kind === 'image' ? 'image/png' : 'audio/mpeg' },
      bytes: new Uint8Array(maximum + 1),
    });

    await expect(
      fetchReachDeckMaicMedia(
        { url: `https://file.maic.chat/streamed-${kind}`, kind },
        {
          lookup: publicLookup,
          request,
          limits: { maxImageSourceBytes: 4096, maxAudioSourceBytes: 2048 },
        },
      ),
    ).rejects.toMatchObject({ code: 'maic.media.too_large' });
  });

  it('downscales an oversized-pixel image even when its byte count is under the store limit', async () => {
    // 回归：prepareMaicImageForStorage 曾只看类型与字节数就原样放行，绕过了
    // 2880px 上限 —— 实测《魏晋南北朝美术1》80 个唯一对象里 79 个走了这条短路。
    const wide = await sharp({
      create: { width: 4000, height: 1200, channels: 3, background: { r: 30, g: 90, b: 150 } },
    })
      .png()
      .toBuffer();
    expect(wide.byteLength).toBeLessThan(10 * 1024 * 1024);
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(wide.byteLength) },
      bytes: new Uint8Array(wide),
    });
    storedMedia.mockImplementationOnce(async (input) => ({
      objectKey: 'generated/downscaled.webp',
      downloadUrl: 'https://preview.test/downscaled.webp',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: '9'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      lookup: publicLookup,
      request,
    });

    const { resolved } = await resolver([
      { id: 'wide', url: 'https://file.maic.chat/wide.png', kind: 'image' },
    ]);

    const upload = storedMedia.mock.calls.at(-1)?.[0];
    expect(upload?.contentType).toBe('image/webp');
    const stored = await sharp(Buffer.from(upload!.bytes)).metadata();
    expect(Math.max(stored.width ?? 0, stored.height ?? 0)).toBeLessThanOrEqual(2880);
    expect(resolved.get('wide')?.normalization).toMatchObject({
      sourceContentType: 'image/png',
      sourceByteLength: wide.byteLength,
    });
  });

  it('keeps a within-limits image byte-identical instead of re-encoding it', async () => {
    // 变体 B 的另一半：只补像素判断，不收紧字节预算 —— 尺寸正常的图仍原样入库。
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 40, b: 10 } },
    })
      .png()
      .toBuffer();
    const request = createRequestMock({
      statusCode: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
      bytes: new Uint8Array(png),
    });
    storedMedia.mockImplementationOnce(async (input) => ({
      objectKey: 'generated/identical.png',
      downloadUrl: 'https://preview.test/identical.png',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: '8'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      lookup: publicLookup,
      request,
    });

    const { resolved } = await resolver([
      { id: 'plain', url: 'https://file.maic.chat/plain.png', kind: 'image' },
    ]);

    const upload = storedMedia.mock.calls.at(-1)?.[0];
    expect(upload?.contentType).toBe('image/png');
    expect(upload?.bytes.byteLength).toBe(png.byteLength);
    expect(resolved.get('plain')?.normalization).toBeUndefined();
  });

  it('counts post-normalization bytes, not raw downloads, against the aggregate limit', async () => {
    // 三张原始 10 MiB+ 的 PNG（共 30 MiB）远超 4 MiB 预算，但都会被归一化成几 KiB
    // 的 WebP，应当放行。这正是《隋唐美术1》被误拒的场景：原始 287 MB，落库后仅
    // 数十 MB。按原始下载字节计费会把这类可正常压缩的课件拒之门外。
    const sources = await Promise.all(
      [0, 1, 2].map(async (seed) => {
        const png = await sharp({
          create: { width: 64, height: 64, channels: 3, background: { r: seed, g: 20, b: 40 } },
        })
          .png()
          .toBuffer();
        const padded = new Uint8Array(10 * 1024 * 1024 + 1);
        padded.set(png);
        return padded;
      }),
    );
    let index = 0;
    const fetchMedia = vi.fn(async () => ({
      kind: 'image' as const,
      bytes: sources[index++]!,
      contentType: 'image/png',
    }));
    storedMedia.mockImplementation(async (input) => ({
      objectKey: 'generated/x.webp',
      downloadUrl: 'https://preview.test/x.webp',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: 'd'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      fetchMedia,
      limits: { maxTotalMediaBytes: 4 * 1024 * 1024 },
    });

    const { resolved, failures } = await resolver(
      sources.map((_, i) => ({
        id: `image-${i}`,
        url: `https://file.maic.chat/image-${i}.png`,
        kind: 'image' as const,
      })),
    );

    expect(failures).toEqual([]);
    expect(resolved.size).toBe(6);
    expect(storedMedia).toHaveBeenCalledTimes(3);
    for (const call of storedMedia.mock.calls) {
      expect(call[0].contentType).toBe('image/webp');
      expect(call[0].bytes.byteLength).toBeLessThan(64 * 1024);
    }
  });

  it('still fails the whole import when post-normalization storage exceeds the budget', async () => {
    // 必须是真能解码的 PNG：归一化阶段会过一遍 sharp，只有魔数的假数据会被
    // 判成单对象失败，测不到总量预算这条路径。尺寸小且字节数在落库上限内，
    // 因此走 passthrough，原始字节直接计入预算。
    const sources = await Promise.all(
      [0, 1, 2].map(async (seed) => {
        const png = await sharp({
          create: { width: 32, height: 32, channels: 3, background: { r: seed, g: 60, b: 90 } },
        })
          .png()
          .toBuffer();
        const padded = new Uint8Array(512 * 1024);
        padded.set(png);
        return padded;
      }),
    );
    let index = 0;
    const fetchMedia = vi.fn(async () => ({
      kind: 'image' as const,
      bytes: sources[index++]!,
      contentType: 'image/png',
    }));
    storedMedia.mockImplementation(async (input) => ({
      objectKey: 'generated/x.webp',
      downloadUrl: 'https://preview.test/x.webp',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: 'e'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      fetchMedia,
      limits: { maxTotalMediaBytes: 640 * 1024 },
    });

    await expect(
      resolver(
        sources.map((_, i) => ({
          id: `image-${i}`,
          url: `https://file.maic.chat/image-${i}.png`,
          kind: 'image' as const,
        })),
      ),
    ).rejects.toMatchObject({ code: 'maic.media.total_too_large' });
  });

  it('guards raw download volume separately from the storage budget', async () => {
    const source = new Uint8Array(1024 * 1024);
    const fetchMedia = vi.fn(async () => ({
      kind: 'image' as const,
      bytes: source,
      contentType: 'image/png',
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, {
      fetchMedia,
      limits: { maxTotalSourceBytes: 2 * 1024 * 1024 },
    });

    await expect(
      resolver(
        Array.from({ length: 4 }, (_, i) => ({
          id: `image-${i}`,
          url: `https://file.maic.chat/image-${i}.png`,
          kind: 'image' as const,
        })),
      ),
    ).rejects.toMatchObject({ code: 'maic.media.total_source_too_large' });
    expect(storedMedia).not.toHaveBeenCalled();
  });

  it('degrades a single failed media object instead of failing the whole import', async () => {
    const good = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();
    const fetchMedia = vi.fn(async (reference: { url: string }) => {
      if (reference.url.includes('broken')) {
        throw new ReachDeckMaicMediaError(
          'MAIC remote media exceeds the per-object byte limit',
          'maic.media.too_large',
        );
      }
      return { kind: 'image' as const, bytes: new Uint8Array(good), contentType: 'image/png' };
    });
    storedMedia.mockImplementation(async (input) => ({
      objectKey: 'generated/ok.png',
      downloadUrl: 'https://preview.test/ok.png',
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      checksumSha256: 'f'.repeat(64),
    }));
    const resolver = createReachDeckMaicMediaResolver({} as never, { fetchMedia });

    const { resolved, failures } = await resolver([
      { id: 'ok-1', url: 'https://file.maic.chat/fine.png', kind: 'image' },
      { id: 'bad-1', url: 'https://file.maic.chat/broken.png', kind: 'image' },
    ]);

    expect(resolved.get('ok-1')).toBeDefined();
    expect(resolved.get('bad-1')).toBeUndefined();
    expect(failures).toEqual([
      {
        url: 'https://file.maic.chat/broken.png',
        kind: 'image',
        referenceIds: ['bad-1'],
        code: 'maic.media.too_large',
        message: 'MAIC remote media exceeds the per-object byte limit',
      },
    ]);
  });

  it('revalidates redirect targets and rejects leaving the allowlisted origin', async () => {
    const request = createRequestMock({
      statusCode: 302,
      headers: { location: 'https://evil.test/media.png' },
      bytes: new Uint8Array(),
    });
    await expect(
      fetchReachDeckMaicMedia(
        { url: 'https://file.maic.chat/image.png', kind: 'image' },
        {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          request,
        },
      ),
    ).rejects.toMatchObject({ code: 'maic.media.url_forbidden' });
  });

  it('revalidates DNS and pins hostname, SNI, and address after an approved-host redirect', async () => {
    const approvedHostname = 'maic-prod.oss-cn-wulanchabu.aliyuncs.com';
    const lookup = vi.fn(async (hostname: string) => [
      hostname === 'file.maic.chat'
        ? { address: '93.184.216.34', family: 4 }
        : { address: '8.8.8.8', family: 4 },
    ]);
    const request = createRequestSequenceMock([
      {
        statusCode: 302,
        headers: { location: `https://${approvedHostname}/image.png` },
        bytes: new Uint8Array(),
      },
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ]);

    await fetchReachDeckMaicMedia(
      { url: 'https://file.maic.chat/start.png', kind: 'image' },
      { lookup, request },
    );

    expect(lookup.mock.calls.map(([hostname]) => hostname)).toEqual([
      'file.maic.chat',
      approvedHostname,
    ]);
    const first = request.mock.calls[0]?.[0] as RequestOptions;
    const second = request.mock.calls[1]?.[0] as RequestOptions;
    expect(first).toMatchObject({ hostname: 'file.maic.chat', servername: 'file.maic.chat' });
    expect(second).toMatchObject({ hostname: approvedHostname, servername: approvedHostname });
    const callback = vi.fn();
    second.lookup!(approvedHostname, { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
  });
});

function createRequestMock(responseValue: {
  statusCode: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
}) {
  return vi.fn((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const request = new EventEmitter() as ClientRequest;
    request.setTimeout = vi.fn().mockReturnValue(request);
    request.end = vi.fn(() => {
      const response = new PassThrough() as unknown as IncomingMessage & PassThrough;
      response.statusCode = responseValue.statusCode;
      response.headers = responseValue.headers;
      callback(response);
      response.end(Buffer.from(responseValue.bytes));
      return request;
    });
    request.destroy = vi.fn().mockReturnValue(request);
    return request;
  }) as unknown as ReturnType<typeof vi.fn> & typeof import('node:https').request;
}

function createRequestSequenceMock(
  responses: Array<{ statusCode: number; headers: Record<string, string>; bytes: Uint8Array }>,
) {
  let index = 0;
  return vi.fn((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const responseValue = responses[index++];
    if (responseValue === undefined) throw new Error('Unexpected MAIC media request');
    const request = new EventEmitter() as ClientRequest;
    request.setTimeout = vi.fn().mockReturnValue(request);
    request.end = vi.fn(() => {
      const response = new PassThrough() as unknown as IncomingMessage & PassThrough;
      response.statusCode = responseValue.statusCode;
      response.headers = responseValue.headers;
      callback(response);
      response.end(Buffer.from(responseValue.bytes));
      return request;
    });
    request.destroy = vi.fn().mockReturnValue(request);
    return request;
  }) as unknown as ReturnType<typeof vi.fn> & typeof import('node:https').request;
}
