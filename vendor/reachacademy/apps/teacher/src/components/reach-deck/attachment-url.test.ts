import { describe, expect, it, vi } from 'vitest';
import { createPortalTranslator } from '@/src/lib/i18n';
const presign = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/quiz/teacher-api', () => ({ presignQuizDownload: presign }));
import { createTeacherDeckAttachmentResolver } from './attachment-url';

describe('Teacher Deck attachment resolver', () => {
  it('presigns on demand with the owning course and node and preserves server disposition', async () => {
    presign.mockResolvedValue({
      downloadUrl: 'https://oss.test/docx',
      disposition: 'attachment',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const resolver = createTeacherDeckAttachmentResolver(
      { courseId: 'course', courseNodeId: 'node' },
      createPortalTranslator('en-US'),
    );
    const result = await resolver(
      { objectKey: 'uploads/document.docx', assetId: 'asset' },
      'inline',
    );
    expect(presign).toHaveBeenCalledWith({
      objectKey: 'uploads/document.docx',
      assetId: 'asset',
      courseId: 'course',
      courseNodeId: 'node',
      disposition: 'inline',
    });
    expect(result.disposition).toBe('attachment');
  });
  it('rejects a legacy display URL with no attachment disposition', async () => {
    presign.mockResolvedValue({ downloadUrl: 'https://oss.test/legacy' });
    const resolver = createTeacherDeckAttachmentResolver(
      { courseId: 'course', courseNodeId: 'node' },
      createPortalTranslator('en-US'),
    );
    await expect(resolver({ objectKey: 'uploads/document' }, 'attachment')).rejects.toThrow();
  });
});
