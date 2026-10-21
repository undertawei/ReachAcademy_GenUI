'use client';

import { useRef, useState, type RefObject } from 'react';
import { Button, Checkbox, Dialog, InlineNotice } from '@reachany/ui';
import { translateReachDeck, type ReachDeckTranslate } from '@reachany/reach-deck-player';

import type { ReachDeckMediaClearSelection } from './deckMediaClear.js';

export interface ReachDeckMediaDeletionDialogProps {
  open: boolean;
  /** 现有音频与动画所在的页数；为 0 的选项禁用。 */
  counts: { audioPages: number; animationPages: number };
  /** 仍在进行的后台生成任务数；大于 0 时提醒先终止，避免删除后被回填。 */
  activeTaskCount?: number;
  disabledReason?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (selection: ReachDeckMediaClearSelection) => Promise<void> | void;
  returnFocusTarget?: RefObject<HTMLElement | null>;
  translate?: ReachDeckTranslate;
}

/** 一键删除整份课件的音频与动画；弹窗本身即确认，动画可撤销，音频需重新生成。 */
export function ReachDeckMediaDeletionDialog({
  open,
  counts,
  activeTaskCount = 0,
  disabledReason,
  onOpenChange,
  onSubmit,
  returnFocusTarget,
  translate,
}: ReachDeckMediaDeletionDialogProps) {
  const text = (key: string, fallback: string, values?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, values);
  const [selection, setSelection] = useState<ReachDeckMediaClearSelection>({
    audio: false,
    animation: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const effective = {
    audio: selection.audio && counts.audioPages > 0,
    animation: selection.animation && counts.animationPages > 0,
  };
  const hasSelection = effective.audio || effective.animation;
  const close = (next: boolean) => {
    if (submitting.current) return;
    setError(undefined);
    if (!next) setSelection({ audio: false, animation: false });
    onOpenChange(next);
  };
  const submit = async () => {
    if (submitting.current || !hasSelection || disabledReason !== undefined) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(effective);
      submitting.current = false;
      close(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'ReachDeckUserFacingError'
          ? cause.message
          : text('reachDeck.mediaDeletion.failed', '删除失败，请稍后重试。'),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={text('reachDeck.mediaDeletion.title', '一键删除')}
      closeLabel={text('reachDeck.mediaDeletion.close', '关闭')}
      dismissible={!busy}
      dismissOnOverlay={false}
      returnFocusTarget={returnFocusTarget}
      size="sm"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => close(false)}>
            {text('reachDeck.mediaDeletion.cancel', '取消')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={busy || !hasSelection || disabledReason !== undefined}
            onClick={() => void submit()}
          >
            {text('reachDeck.mediaDeletion.submit', '删除')}
          </Button>
        </>
      }
    >
      <div className="reach-deck-regeneration">
        <fieldset disabled={busy}>
          <legend>{text('reachDeck.mediaDeletion.channels', '选择要从整份课件删除的内容')}</legend>
          <Checkbox
            checked={effective.audio}
            disabled={counts.audioPages === 0 || disabledReason !== undefined}
            label={text('reachDeck.mediaDeletion.audio', '音频')}
            description={
              counts.audioPages === 0
                ? text('reachDeck.mediaDeletion.audioEmpty', '课件中没有音频')
                : text(
                    'reachDeck.mediaDeletion.audioDescription',
                    '删除 {count} 页的讲稿音频，保留讲稿文字；立即保存，不可撤销',
                    { count: counts.audioPages },
                  )
            }
            onCheckedChange={(audio) => {
              setError(undefined);
              setSelection((current) => ({ ...current, audio }));
            }}
          />
          <Checkbox
            checked={effective.animation}
            disabled={counts.animationPages === 0 || disabledReason !== undefined}
            label={text('reachDeck.mediaDeletion.animation', '动画')}
            description={
              counts.animationPages === 0
                ? text('reachDeck.mediaDeletion.animationEmpty', '课件中没有动画')
                : text(
                    'reachDeck.mediaDeletion.animationDescription',
                    '删除 {count} 页的全部动画',
                    { count: counts.animationPages },
                  )
            }
            onCheckedChange={(animation) => {
              setError(undefined);
              setSelection((current) => ({ ...current, animation }));
            }}
          />
        </fieldset>
        <InlineNotice tone={activeTaskCount > 0 ? 'warning' : 'info'}>
          {text(
            'reachDeck.mediaDeletion.backgroundNotice',
            '后台仍在进行的生成任务完成后，可能会重新写入音频或动画。建议先在「生成任务状态」中终止所有生成任务。',
          )}
        </InlineNotice>
        <p className="reach-deck-regeneration__hint">
          {text(
            'reachDeck.mediaDeletion.undoHint',
            '删除的动画可用“撤销”恢复；删除的音频需要重新生成。',
          )}
        </p>
        {disabledReason ? <InlineNotice tone="warning">{disabledReason}</InlineNotice> : null}
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      </div>
    </Dialog>
  );
}
