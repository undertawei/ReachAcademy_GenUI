import type { ReachDeckAttachmentUrlResolver } from '@reachany/reach-deck-player';
import type { ReachDeckModuleContext } from '@reachany/reach-deck-client';
import type { PortalTranslator } from '@/src/lib/i18n';
import { presignQuizDownload } from '@/src/lib/quiz/teacher-api';

export function createTeacherDeckAttachmentResolver(
  context: Pick<ReachDeckModuleContext, 'courseId' | 'courseNodeId'>,
  t: PortalTranslator,
): ReachDeckAttachmentUrlResolver {
  return async (ref, disposition) => {
    const result = await presignQuizDownload({
      objectKey: ref.objectKey,
      assetId: ref.assetId,
      courseId: context.courseId,
      courseNodeId: context.courseNodeId,
      disposition,
    });
    if (result.disposition !== 'inline' && result.disposition !== 'attachment') {
      throw new Error(t('attachment.loadFailed'));
    }
    return {
      url: result.downloadUrl,
      disposition: result.disposition,
      contentType: result.contentType,
    };
  };
}
