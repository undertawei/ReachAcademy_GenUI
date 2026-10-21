'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Paperclip, Trash2, X } from 'lucide-react';
import { Button, IconButton } from '@reachany/ui';
import {
  QUIZ_QUESTION_MAX_ATTACHMENTS,
  QUIZ_QUESTION_MAX_ATTACHMENT_BYTES,
  type QuizAttachmentReference,
} from '@reachany/reach-deck-dsl';
import {
  ReachDeckAttachmentList,
  translateReachDeck,
  type ReachDeckAttachmentUrlResolver,
  type ReachDeckTranslate,
} from '@reachany/reach-deck-player';

// 区分主动取消与切题卸载，避免宿主误报题目已变化。
export const QUIZ_ATTACHMENT_UPLOAD_CANCEL_REASON = 'user-cancelled-attachment-upload';

export function QuizQuestionAttachmentsEditor({
  attachments,
  onChange,
  upload,
  uploadDisabled = false,
  resolveAttachmentUrl,
  mediaUrlsByObjectKey,
  translate,
}: {
  attachments: readonly QuizAttachmentReference[];
  onChange: (
    update: (attachments: readonly QuizAttachmentReference[]) => QuizAttachmentReference[],
  ) => void;
  upload?: (file: File, signal: AbortSignal) => Promise<QuizAttachmentReference | undefined>;
  uploadDisabled?: boolean;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string, params?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, params);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const uploadingFile = useRef<File | undefined>(undefined);
  const failedFiles = useRef<string[]>([]);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const normalize = (values: readonly QuizAttachmentReference[]) =>
    values.map((attachment, order) => ({ ...attachment, order }));
  const failuresMessage = () =>
    failedFiles.current.length === 0
      ? ''
      : text(
          'reachDeck.editor.quiz.uploadAttachmentFilesFailed',
          '以下附件上传失败：{names}。请重试。',
          {
            names: failedFiles.current.join(
              text('reachDeck.editor.quiz.failedAttachmentNameSeparator', '、'),
            ),
          },
        );
  const uploadFiles = async (files: File[]) => {
    if (!upload || uploadDisabled || controller.current || files.length === 0) return;
    setError('');
    if (attachments.length + files.length > QUIZ_QUESTION_MAX_ATTACHMENTS) {
      setError(text('reachDeck.editor.quiz.maxAttachments', '每道题最多 10 个附件。'));
      return;
    }
    if (files.some((file) => file.size > QUIZ_QUESTION_MAX_ATTACHMENT_BYTES)) {
      setError(text('reachDeck.editor.quiz.attachmentMaxSize', '单个文件不得超过 100 MiB。'));
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    failedFiles.current = [];
    setBusy(true);
    try {
      for (const file of files) {
        if (abort.signal.aborted) break;
        uploadingFile.current = file;
        try {
          const result = await upload(file, abort.signal);
          if (abort.signal.aborted) break;
          if (!result) {
            failedFiles.current.push(file.name);
            continue;
          }
          // 每个已完成文件立即写回；后续失败、取消或切题不会丢掉已保存的结果。
          onChange((current) => normalize([...current, result]));
        } catch {
          if (abort.signal.aborted) break;
          failedFiles.current.push(file.name);
        }
      }
      if (mounted.current && !abort.signal.aborted) {
        setError(failuresMessage());
      }
    } finally {
      if (controller.current === abort) {
        controller.current = undefined;
        uploadingFile.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const move = (index: number, offset: number) => {
    const next = [...attachments];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    onChange(() => normalize(next));
  };
  return (
    <section aria-label={text('reachDeck.editor.quiz.attachments', '题目附件')}>
      {upload ? (
        <>
          <Button
            iconStart={<Paperclip />}
            type="button"
            disabled={uploadDisabled || busy || attachments.length >= QUIZ_QUESTION_MAX_ATTACHMENTS}
            onClick={() => input.current?.click()}
          >
            {text('reachDeck.editor.quiz.uploadAttachments', '选择附件')}
          </Button>
          {busy ? (
            <IconButton
              icon={<X />}
              size="sm"
              label={text('reachDeck.editor.quiz.cancelAttachmentUpload', '取消附件上传')}
              onClick={() => {
                controller.current?.abort(QUIZ_ATTACHMENT_UPLOAD_CANCEL_REASON);
                const cancelledMessage = text(
                  'reachDeck.editor.quiz.uploadAttachmentCancelled',
                  '已取消上传 {name}，已完成的附件已保留。',
                  {
                    name: uploadingFile.current?.name ?? '',
                  },
                );
                setError([failuresMessage(), cancelledMessage].filter(Boolean).join(' '));
              }}
            />
          ) : null}
          <input
            ref={input}
            type="file"
            multiple
            hidden
            disabled={uploadDisabled || busy}
            onChange={(event) => {
              void uploadFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </>
      ) : null}
      <ReachDeckAttachmentList
        attachments={attachments}
        resolveAttachmentUrl={resolveAttachmentUrl}
        mediaUrlsByObjectKey={mediaUrlsByObjectKey}
        translate={translate}
        renderActions={(attachment, index) => (
          <>
            <IconButton
              icon={<ArrowUp />}
              size="sm"
              type="button"
              disabled={busy || index === 0}
              label={text('reachDeck.player.quiz.answer.moveUp', '上移 {name}', {
                name: attachment.name,
              })}
              onClick={() => move(index, -1)}
            />
            <IconButton
              icon={<ArrowDown />}
              size="sm"
              type="button"
              disabled={busy || index === attachments.length - 1}
              label={text('reachDeck.player.quiz.answer.moveDown', '下移 {name}', {
                name: attachment.name,
              })}
              onClick={() => move(index, 1)}
            />
            <IconButton
              icon={<Trash2 />}
              size="sm"
              type="button"
              disabled={busy}
              label={text('reachDeck.player.quiz.answer.removeNamed', '移除 {name}', {
                name: attachment.name,
              })}
              onClick={() =>
                onChange((current) =>
                  normalize(current.filter((item) => item.objectKey !== attachment.objectKey)),
                )
              }
            />
          </>
        )}
      />
      {busy ? (
        <p role="status">{text('reachDeck.player.quiz.answer.uploading', '正在上传…')}</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
