import { describe, expect, it, vi } from 'vitest';

import {
  findReachDeckGeneratedMedia,
  resolveReachDeckDecksmithImageReference,
  storeReachDeckGeneratedMedia,
} from '../../lib/reach-deck/content-service-client.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const options = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  env: {
    REACHANY_CONTENT_SERVICE_URL: 'http://content:8000',
    REACHANY_SERVICE_JWT_SECRET: 'test-secret',
    REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
  },
} as const;

describe('Reach Deck generated speech media sidecar', () => {
  it('stores audio and real timestamps in one versioned JSON request', async () => {
    const speechTimestamps = [{ char: '讲', start: 0, end: 0.2 }];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({
        protocol: 'reach-deck-speech-media/v1',
        contentType: 'audio/mpeg',
        audioBase64: Buffer.from([1, 2, 3]).toString('base64'),
        speechTimestamps,
      });
      return Response.json(mediaResource(speechTimestamps));
    });

    await expect(
      storeReachDeckGeneratedMedia(
        {
          kind: 'speech',
          pageId: 'page-1',
          idempotencyKey: 'stable-speech-1',
          contentType: 'audio/mpeg',
          bytes: new Uint8Array([1, 2, 3]),
          speechTimestamps,
        },
        { ...options, fetch: fetchMock as typeof fetch },
      ),
    ).resolves.toMatchObject({ speechTimestamps });
  });

  it('returns the persisted timestamp sidecar on stable-media lookup', async () => {
    const speechTimestamps = [{ char: '讲', start: 0, end: 0.2 }];
    const fetchMock = vi.fn(async () => Response.json(mediaResource(speechTimestamps)));

    await expect(
      findReachDeckGeneratedMedia(
        { kind: 'speech', pageId: 'page-1', idempotencyKey: 'stable-speech-1' },
        { ...options, fetch: fetchMock as typeof fetch },
      ),
    ).resolves.toMatchObject({ speechTimestamps });
  });

  // content-service 的 requireSpeechTimestamps 拒收空白与控制字符；客户端漏检会变成
  // 「本地放行、服务端 400」的哑失败，而服务端 BusinessException 不写日志，无从分辨。
  it.each([
    ['blank char', { char: ' ', start: 0, end: 0.2 }, 'char must not be blank'],
    ['control char', { char: '释。\n', start: 0, end: 0.2 }, 'char contains a control character'],
    ['overlong char', { char: '字'.repeat(33), start: 0, end: 0.2 }, 'char exceeds 32 characters'],
  ])('拒收违反存储契约的词条（%s），且错误可区分于服务端', async (_name, entry, reason) => {
    const fetchMock = vi.fn(async () => Response.json(mediaResource([])));

    await expect(
      storeReachDeckGeneratedMedia(
        {
          kind: 'speech',
          pageId: 'page-1',
          idempotencyKey: 'stable-speech-1',
          contentType: 'audio/mpeg',
          bytes: new Uint8Array([1, 2, 3]),
          speechTimestamps: [entry],
        },
        { ...options, fetch: fetchMock as typeof fetch },
      ),
    ).rejects.toThrow(`ai-runtime rejected generated speech timestamp #0: ${reason}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mediaResource(speechTimestamps: Array<{ char: string; start: number; end: number }>) {
  return {
    objectKey: 'generated/audio.mp3',
    downloadUrl: 'https://signed.example/audio.mp3',
    contentType: 'audio/mpeg',
    sizeBytes: 3,
    checksumSha256: 'a'.repeat(64),
    speechTimestamps,
  };
}

describe('Decksmith image reference authorization client', () => {
  const objectKey = 'uploads/org/reach-deck/version/image/abc.png';
  const reference = {
    objectKey,
    downloadUrl: 'https://oss.example/signed',
    expiresInSeconds: 120,
    contentType: 'image/png',
    sizeBytes: 1024,
    checksumSha256: 'a'.repeat(64),
    source: 'generated',
  };

  it('posts only the object key and expected checksum to the scoped bridge path', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ code: 0, data: reference }),
    );

    await expect(
      resolveReachDeckDecksmithImageReference(
        { objectKey, expectedChecksumSha256: 'a'.repeat(64) },
        { ...options, fetch: fetchMock as typeof fetch },
      ),
    ).resolves.toEqual(reference);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      `/api/v1/reach-deck/courses/${TEST_REACH_DECK_RESOURCE_SCOPE.courseId}/nodes/` +
        `${TEST_REACH_DECK_RESOURCE_SCOPE.courseNodeId}/decksmith/image-references`,
    );
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      objectKey,
      expectedChecksumSha256: 'a'.repeat(64),
    });
  });

  it('rejects a response for a different object or with an invalid checksum', async () => {
    for (const data of [
      { ...reference, objectKey: 'uploads/org/other.png' },
      { ...reference, checksumSha256: 'not-a-digest' },
      { ...reference, source: 'prefix' },
    ]) {
      const fetchMock = vi.fn(async () => Response.json({ code: 0, data }));
      await expect(
        resolveReachDeckDecksmithImageReference(
          { objectKey },
          { ...options, fetch: fetchMock as typeof fetch },
        ),
      ).rejects.toMatchObject({ status: 502 });
    }
  });

  it('surfaces authorization denials with their status', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ code: 404, message: 'image reference was not found' }, { status: 404 }),
    );
    await expect(
      resolveReachDeckDecksmithImageReference(
        { objectKey },
        { ...options, fetch: fetchMock as typeof fetch },
      ),
    ).rejects.toMatchObject({ status: 404, message: 'image reference was not found' });
  });
});
