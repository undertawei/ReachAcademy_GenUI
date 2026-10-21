import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadTeacherTrialAsset, uploadTeacherTrialAsset } from './teacher-trial-asset';
import { createPortalTranslator } from '@/src/lib/i18n';

const attempt = {
  attemptId: 'trial',
  courseId: 'course',
  courseNodeId: 'node',
  organizationId: 'org',
  moduleId: 'module',
  moduleVersionId: 'version',
  courseWorkspaceType: 'draft' as const,
};
const context = { kind: 'inline_image' as const, pageId: 'page:1', questionId: 'q:2' };
const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
const t = createPortalTranslator('en-US');
const envelope = (data: unknown) => Response.json({ code: 0, data });
afterEach(() => vi.unstubAllGlobals());
describe('teacher trial answer media', () => {
  it('signs answer attachments on their teacher trial page and question boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({
        downloadUrl: 'https://oss.test/document',
        disposition: 'attachment',
        contentType: 'application/pdf',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await downloadTeacherTrialAsset(
        attempt,
        {
          assetId: 'asset',
          objectKey: 'uploads/document',
          pageId: context.pageId,
          questionId: context.questionId,
        },
        'attachment',
        t,
      ),
    ).toEqual({
      url: 'https://oss.test/document',
      disposition: 'attachment',
      contentType: 'application/pdf',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/pages/page%3A1/questions/q%3A2/assets/presign-download',
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      assetId: 'asset',
      objectKey: 'uploads/document',
      disposition: 'attachment',
    });
  });
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes network failures at every upload stage (%s)',
    async (locale) => {
      const translate = createPortalTranslator(locale);
      for (const stage of [0, 1, 2]) {
        const fetchMock = vi.fn();
        if (stage > 0)
          fetchMock.mockResolvedValueOnce(
            envelope({
              assetId: 'asset',
              objectKey: 'tmp/photo',
              uploadUrl: 'https://oss.test/upload',
            }),
          );
        if (stage > 1) fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        vi.stubGlobal('fetch', fetchMock);
        await expect(uploadTeacherTrialAsset(attempt, file, context, translate)).rejects.toThrow(
          translate('reachDeck.player.quiz.answer.imageUploadFailed'),
        );
        expect(fetchMock).toHaveBeenCalledTimes(stage + 1);
      }
    },
  );
  it('uploads through teacher-scoped tickets and returns the exact image reference', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        envelope({
          assetId: 'asset',
          objectKey: 'tmp/photo',
          uploadUrl: 'https://oss.test/upload',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(envelope({ downloadUrl: 'https://oss.test/photo' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await uploadTeacherTrialAsset(attempt, file, context, t)).toEqual({
      assetId: 'asset',
      objectKey: 'tmp/photo',
      downloadUrl: 'https://oss.test/photo',
      contentType: 'image/jpeg',
      name: 'photo.jpg',
      sizeBytes: 5,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/portal/teacher/courses/course/nodes/node/reach-deck-trial-attempts/trial/pages/page%3A1/questions/q%3A2/assets/presign-upload',
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual({
      kind: 'inline_image',
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 5,
    });
    expect(fetchMock.mock.calls[1]).toEqual([
      'https://oss.test/upload',
      { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: file },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1].body)).toEqual({
      assetId: 'asset',
      objectKey: 'tmp/photo',
      disposition: 'inline',
    });
  });
  it('does not upload when teacher authorization fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadTeacherTrialAsset(attempt, file, context, t)).rejects.toThrow('403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not insert an asset or request download when object upload fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        envelope({
          assetId: 'asset',
          objectKey: 'tmp/photo',
          uploadUrl: 'https://oss.test/upload',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadTeacherTrialAsset(attempt, file, context, t)).rejects.toThrow('500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
