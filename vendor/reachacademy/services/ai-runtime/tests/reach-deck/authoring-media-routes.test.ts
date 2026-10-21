import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  authorize: vi.fn(),
  presign: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock('@/lib/reach-deck/workspace-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/workspace-route.js')>()),
  authorizeWorkspaceRoute: deps.authorize,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/content-service-client.js')>()),
  presignReachDeckAuthoringMedia: deps.presign,
  finalizeReachDeckAuthoringMedia: deps.finalize,
}));

import { POST as finalize } from '../../app/api/reach-deck/tools/authoring-media/finalize/route.js';
import { POST as presign } from '../../app/api/reach-deck/tools/authoring-media/presign/route.js';

const scoped = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  roleGrantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceScope: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    courseWorkspaceType: 'draft' as const,
    courseNodeId: '33333333-3333-4333-8333-333333333333',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: '55555555-5555-4555-8555-555555555555',
  },
};

describe('Reach Deck authoring media routes', () => {
  beforeEach(() => {
    deps.authorize.mockReset().mockResolvedValue(scoped);
    deps.presign.mockReset();
    deps.finalize.mockReset();
  });

  it.each([
    ['image', 'diagram.png', 'image/png'],
    ['audio', 'lesson.mp3', 'audio/mpeg'],
    ['video', 'lesson.mp4', 'video/mp4'],
    ['attachment', '图片1.png', 'image/png'],
    ['attachment', '材料.pdf', 'application/pdf'],
  ])(
    'presigns %s (%s) through the authorized resource scope',
    async (kind, fileName, contentType) => {
      deps.presign.mockResolvedValue({
        assetId: '66666666-6666-4666-8666-666666666666',
        objectKey: 'tmp/reach-deck-material/media.mp4',
        uploadUrl: 'https://oss.example/upload',
        requiredHeaders: { 'Content-Type': contentType },
        expiresInSeconds: 900,
      });

      const response = await presign(
        new Request('https://teacher.test/api/reach-deck/tools/authoring-media/presign', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind,
            fileName,
            contentType,
            sizeBytes: 2048,
          }),
        }),
      );

      expect(response.status).toBe(201);
      expect(deps.authorize).toHaveBeenCalledWith(expect.any(Request), ['teacher']);
      expect(deps.presign).toHaveBeenCalledWith(
        {
          kind,
          fileName,
          contentType,
          sizeBytes: 2048,
        },
        expect.objectContaining({ actorId: scoped.actorId, resourceScope: scoped.resourceScope }),
      );
      await expect(response.json()).resolves.toMatchObject({
        uploadUrl: 'https://oss.example/upload',
        requiredHeaders: { 'Content-Type': contentType },
      });
    },
  );

  it.each(['image', 'audio', 'video', 'attachment'])(
    'finalizes %s using the exact asset identity returned by presign',
    async (kind) => {
      const media = {
        assetId: '66666666-6666-4666-8666-666666666666',
        kind,
        objectKey: 'uploads/org/reach-deck/version/authoring/audio/media.mp3',
        downloadUrl: 'https://oss.example/download',
        expiresInSeconds: 900,
        contentType: 'audio/mpeg',
        sizeBytes: 4096,
      };
      deps.finalize.mockResolvedValue(media);

      const response = await finalize(
        new Request('https://teacher.test/api/reach-deck/tools/authoring-media/finalize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind,
            assetId: media.assetId,
            objectKey: 'tmp/reach-deck-material/media.mp3',
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(deps.finalize).toHaveBeenCalledWith(
        {
          kind,
          assetId: media.assetId,
          objectKey: 'tmp/reach-deck-material/media.mp3',
        },
        expect.objectContaining({ actorId: scoped.actorId, roleGrantId: scoped.roleGrantId }),
      );
      await expect(response.json()).resolves.toEqual(media);
    },
  );

  it.each([
    [
      presign,
      { kind: 'archive', fileName: 'file.zip', contentType: 'application/zip', sizeBytes: 1 },
    ],
    [
      finalize,
      {
        kind: 'archive',
        assetId: '66666666-6666-4666-8666-666666666666',
        objectKey: 'tmp/file.zip',
      },
    ],
  ] as const)('rejects unknown media kinds before forwarding', async (route, body) => {
    const response = await route(
      new Request('https://runtime.test/authoring-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('authoring media kind must be');
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });
});
