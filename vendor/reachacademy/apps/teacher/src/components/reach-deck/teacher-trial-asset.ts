import type { QuizAnswerUploadedAsset } from '@reachany/reach-deck-player';
import type { PortalTranslator } from '@/src/lib/i18n';
import type { TeacherReachDeckTrialAttempt } from './teacher-trial-attempt';

export async function downloadTeacherTrialAsset(
  attempt: TeacherReachDeckTrialAttempt,
  ref: { assetId?: string; objectKey: string; pageId: string; questionId: string },
  disposition: 'inline' | 'attachment',
  t: PortalTranslator,
) {
  const segments = [
    'courses',
    attempt.courseId,
    'nodes',
    attempt.courseNodeId,
    'reach-deck-trial-attempts',
    attempt.attemptId,
    'pages',
    ref.pageId,
    'questions',
    ref.questionId,
    'assets',
    'presign-download',
  ].map(encodeURIComponent);
  const response = await fetch(`/api/portal/teacher/${segments.join('/')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ assetId: ref.assetId, objectKey: ref.objectKey, disposition }),
  });
  const failure = t(
    disposition === 'attachment' ? 'attachment.downloadFailed' : 'attachment.loadFailed',
  );
  if (!response.ok) throw new Error(failure);
  const envelope = (await response.json()) as {
    code: number;
    data?: {
      downloadUrl: string;
      disposition: 'inline' | 'attachment';
      contentType: string;
    };
  };
  const result = envelope.data;
  if (
    envelope.code !== 0 ||
    !result ||
    !result.downloadUrl ||
    (result.disposition !== 'inline' && result.disposition !== 'attachment')
  )
    throw new Error(failure);
  return {
    url: result.downloadUrl,
    disposition: result.disposition,
    contentType: result.contentType,
  };
}

/** 使用教师授权上传独立的试玩临时资源，不访问学生作答。 */
export async function uploadTeacherTrialAsset(
  attempt: TeacherReachDeckTrialAttempt,
  file: File,
  context: { kind: 'attachment' | 'inline_image'; pageId: string; questionId: string },
  t: PortalTranslator,
): Promise<QuizAnswerUploadedAsset> {
  const segments = [
    'courses',
    attempt.courseId,
    'nodes',
    attempt.courseNodeId,
    'reach-deck-trial-attempts',
    attempt.attemptId,
    'pages',
    context.pageId,
    'questions',
    context.questionId,
    'assets',
  ].map(encodeURIComponent);
  const base = `/api/portal/teacher/${segments.join('/')}`;
  const fetchMedia = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(url, init);
    } catch {
      throw new Error(
        t(
          context.kind === 'attachment'
            ? 'reachDeck.player.quiz.answer.attachmentUploadFailed'
            : 'reachDeck.player.quiz.answer.imageUploadFailed',
        ),
      );
    }
  };
  const request = async <T>(action: string, body: unknown): Promise<T> => {
    const response = await fetchMedia(`${base}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(t('reachDeck.attempt.assetUploadFailed', { status: response.status }));
    const envelope = (await response.json()) as { code: number; data: T };
    if (envelope.code !== 0 || !envelope.data)
      throw new Error(t('reachDeck.player.quiz.answer.imageUploadFailed'));
    return envelope.data;
  };
  const contentType = file.type || 'application/octet-stream';
  const ticket = await request<{ assetId: string; objectKey: string; uploadUrl: string }>(
    'presign-upload',
    {
      kind: context.kind,
      filename: file.name,
      contentType,
      sizeBytes: file.size,
    },
  );
  const upload = await fetchMedia(ticket.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: file,
  });
  if (!upload.ok)
    throw new Error(t('reachDeck.attempt.assetUploadFailed', { status: upload.status }));
  const download = await request<{ downloadUrl: string }>('presign-download', {
    assetId: ticket.assetId,
    objectKey: ticket.objectKey,
    disposition: 'inline',
  });
  return {
    assetId: ticket.assetId,
    objectKey: ticket.objectKey,
    downloadUrl: download.downloadUrl,
    contentType,
    name: file.name,
    sizeBytes: file.size,
  };
}
