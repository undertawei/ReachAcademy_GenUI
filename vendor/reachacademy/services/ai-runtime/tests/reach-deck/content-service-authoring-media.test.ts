import { describe, expect, it, vi } from 'vitest';

import {
  finalizeReachDeckAuthoringMedia,
  presignReachDeckAuthoringMedia,
  type ReachDeckAuthoringMediaKind,
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

describe('Reach Deck content-service authoring media client', () => {
  it.each<ReachDeckAuthoringMediaKind>(['image', 'audio', 'video', 'attachment'])(
    'sends %s upload metadata and validates presign headers',
    async (kind) => {
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toContain('/authoring-media/presign');
        expect(JSON.parse(String(init?.body))).toEqual({
          kind,
          fileName: 'diagram.png',
          contentType: 'image/png',
          sizeBytes: 128,
        });
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
        return Response.json({
          assetId: '66666666-6666-4666-8666-666666666666',
          objectKey: 'tmp/reach-deck-material/image.png',
          uploadUrl: 'https://oss.example/upload',
          requiredHeaders: { 'Content-Type': 'image/png' },
          expiresInSeconds: 900,
        });
      });

      await expect(
        presignReachDeckAuthoringMedia(
          { kind, fileName: 'diagram.png', contentType: 'image/png', sizeBytes: 128 },
          { ...options, fetch: fetchMock as typeof fetch },
        ),
      ).resolves.toMatchObject({ requiredHeaders: { 'Content-Type': 'image/png' } });
    },
  );

  it.each<ReachDeckAuthoringMediaKind>(['image', 'audio', 'video', 'attachment'])(
    'returns stable %s metadata from finalize',
    async (kind) => {
      const assetId = '66666666-6666-4666-8666-666666666666';
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toContain('/authoring-media/finalize');
        expect(JSON.parse(String(init?.body))).toEqual({
          kind,
          assetId,
          objectKey: 'tmp/reach-deck-material/video.mp4',
        });
        return Response.json({
          assetId,
          kind,
          objectKey: 'uploads/org/reach-deck/version/authoring/video/video.mp4',
          downloadUrl: 'https://oss.example/download',
          expiresInSeconds: 900,
          contentType: 'video/mp4',
          sizeBytes: 1024,
        });
      });

      await expect(
        finalizeReachDeckAuthoringMedia(
          { kind, assetId, objectKey: 'tmp/reach-deck-material/video.mp4' },
          { ...options, fetch: fetchMock as typeof fetch },
        ),
      ).resolves.toMatchObject({
        assetId,
        kind,
        objectKey: 'uploads/org/reach-deck/version/authoring/video/video.mp4',
      });
    },
  );
});
