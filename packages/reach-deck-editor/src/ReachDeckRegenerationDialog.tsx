'use client';

import { useId, useRef, useState, type RefObject } from 'react';
import { Button, Checkbox, ConfirmDialog, Dialog, InlineNotice, RadioGroup } from '@reachany/ui';
import { translateReachDeck, type ReachDeckTranslate } from '@reachany/reach-deck-player';

export type ReachDeckRegenerationChannel = 'layout' | 'image' | 'narration' | 'audio' | 'animation';

export interface ReachDeckRegenerationSelection {
  channels: Record<Exclude<ReachDeckRegenerationChannel, 'image'>, boolean> & { image?: boolean };
  scope: 'failed' | 'all';
  audioAnimationMode: 'preserve' | 'clear';
  imageScope?: 'failed' | 'all';
  assetIds?: readonly string[];
}

export interface ReachDeckRegenerationDialogProps {
  open: boolean;
  pageTitle?: string;
  selection: ReachDeckRegenerationSelection;
  /** Omitted entries are unsupported by the current page type. */
  options: readonly {
    channel: ReachDeckRegenerationChannel;
    disabled?: boolean;
    description?: string;
  }[];
  disabledReason?: string;
  imageCount?: number;
  failedImageCount?: number;
  /** Keep an uncertain submission's choices frozen while its exact request is retried. */
  selectionLockedReason?: string;
  notice?: string;
  onSelectionChange: (selection: ReachDeckRegenerationSelection) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (selection: ReachDeckRegenerationSelection) => Promise<void>;
  returnFocusTarget?: RefObject<HTMLElement | null>;
  translate?: ReachDeckTranslate;
}

/** Presentation shared by whole-Deck and current-page regeneration. The owner supplies eligibility. */
export function ReachDeckRegenerationDialog({
  open,
  pageTitle,
  selection,
  options,
  disabledReason,
  imageCount = 0,
  failedImageCount,
  selectionLockedReason,
  notice,
  onSelectionChange,
  onOpenChange,
  onSubmit,
  returnFocusTarget,
  translate,
}: ReachDeckRegenerationDialogProps) {
  const text = (key: string, fallback: string, values?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, values);
  const [confirmImages, setConfirmImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const scopeId = useId();
  const animationModeId = useId();
  const imageScopeId = useId();
  const imageOnly =
    selection.channels.image &&
    !selection.channels.layout &&
    !selection.channels.narration &&
    !selection.channels.audio &&
    !selection.channels.animation;
  const hasSelection = options.some(
    ({ channel, disabled }) => selection.channels[channel] && !disabled,
  );
  const invalidSelection = Object.entries(selection.channels).some(
    ([channel, checked]) =>
      checked && !options.some((option) => option.channel === channel && !option.disabled),
  );
  const change = (next: ReachDeckRegenerationSelection) => {
    setError(undefined);
    if (selectionLockedReason === undefined) onSelectionChange(next);
  };
  const submit = async (confirmed = false) => {
    if (
      !confirmed &&
      selection.channels.image &&
      selection.imageScope === 'all' &&
      imageCount > 20
    ) {
      setConfirmImages(true);
      return;
    }
    if (submitting.current || disabledReason || !hasSelection || invalidSelection) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(selection);
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'ReachDeckUserFacingError'
          ? cause.message
          : text('reachDeck.regeneration.failed', '提交失败，请确认任务状态后重试。'),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!submitting.current) {
            setError(undefined);
            onOpenChange(next);
          }
        }}
        title={
          pageTitle === undefined
            ? text('reachDeck.regeneration.title', '重新生成课件')
            : text('reachDeck.regeneration.pageTitle', '重新生成：{title}', { title: pageTitle })
        }
        closeLabel={text('reachDeck.regeneration.close', '关闭')}
        dismissible={!busy}
        dismissOnOverlay={false}
        returnFocusTarget={returnFocusTarget}
        size="sm"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
              {text('reachDeck.regeneration.cancel', '取消')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={busy || !hasSelection || invalidSelection || disabledReason !== undefined}
              onClick={() => void submit()}
            >
              {selectionLockedReason === undefined
                ? text('reachDeck.regeneration.submit', '开始生成')
                : text('reachDeck.regeneration.confirmPreviousSubmission', '确认上次提交')}
            </Button>
          </>
        }
      >
        <div className="reach-deck-regeneration">
          <fieldset disabled={busy || selectionLockedReason !== undefined}>
            <legend>{text('reachDeck.regeneration.channels', '选择需要重新生成的内容')}</legend>
            {options.map(({ channel, disabled, description }) => (
              <div
                key={channel}
                className={
                  channel === 'image' ? 'reach-deck-regeneration__image-option' : undefined
                }
              >
                <Checkbox
                  key={channel}
                  checked={selection.channels[channel]}
                  disabled={disabled || disabledReason !== undefined}
                  label={text(
                    `reachDeck.regeneration.${channel}`,
                    {
                      layout: '版面',
                      image: '图片',
                      narration: '讲稿',
                      audio: '音频',
                      animation: '动画',
                    }[channel],
                  )}
                  description={description}
                  onCheckedChange={(checked) =>
                    change({
                      ...selection,
                      channels: { ...selection.channels, [channel]: checked },
                    })
                  }
                />
              </div>
            ))}
          </fieldset>
          {selection.channels.image ? (
            <div className="reach-deck-regeneration__image-option">
              <p id={imageScopeId}>{text('reachDeck.regeneration.imageScope', '图片范围')}</p>
              <RadioGroup
                aria-labelledby={imageScopeId}
                disabled={busy || selectionLockedReason !== undefined}
                value={selection.imageScope ?? (selection.channels.layout ? 'all' : 'failed')}
                onChange={(imageScope) => {
                  if (imageScope === 'failed' || imageScope === 'all')
                    change({ ...selection, imageScope });
                }}
                options={[
                  {
                    value: 'failed',
                    label: text('reachDeck.regeneration.imageFailed', '只重试失败的图片'),
                    disabled: !!imageOnly && pageTitle !== undefined && failedImageCount === 0,
                  },
                  {
                    value: 'all',
                    label: text('reachDeck.regeneration.imageAll', '全部重新生成并覆盖'),
                  },
                ]}
              />
              {selection.imageScope === 'all' ? (
                <p>
                  {text('reachDeck.regeneration.imageCount', '将重新生成 {count} 张图片', {
                    count: imageCount,
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
          {pageTitle === undefined && !imageOnly ? (
            <div>
              <p id={scopeId}>{text('reachDeck.regeneration.scope', '生成范围')}</p>
              <RadioGroup
                aria-labelledby={scopeId}
                disabled={busy || selectionLockedReason !== undefined}
                value={selection.scope}
                onChange={(scope) => {
                  if (scope === 'failed' || scope === 'all') change({ ...selection, scope });
                }}
                options={[
                  {
                    value: 'failed',
                    label: text('reachDeck.regeneration.failedOnly', '只重试失败页面'),
                  },
                  { value: 'all', label: text('reachDeck.regeneration.all', '覆盖所有页面') },
                ]}
              />
            </div>
          ) : null}
          {selection.channels.audio && !selection.channels.animation ? (
            <div>
              <p id={animationModeId}>
                {text('reachDeck.regeneration.animationHandling', '已有动画')}
              </p>
              <RadioGroup
                aria-labelledby={animationModeId}
                disabled={busy || selectionLockedReason !== undefined}
                value={selection.audioAnimationMode}
                onChange={(audioAnimationMode) => {
                  if (audioAnimationMode === 'preserve' || audioAnimationMode === 'clear') {
                    change({ ...selection, audioAnimationMode });
                  }
                }}
                options={[
                  {
                    value: 'preserve',
                    label: text('reachDeck.regeneration.preserve', '保留动画并匹配新时间戳'),
                  },
                  { value: 'clear', label: text('reachDeck.regeneration.clear', '清除动画') },
                ]}
              />
            </div>
          ) : null}
          {notice ? <InlineNotice tone="info">{notice}</InlineNotice> : null}
          {selectionLockedReason ? (
            <InlineNotice tone="warning">{selectionLockedReason}</InlineNotice>
          ) : null}
          {disabledReason ? <InlineNotice tone="warning">{disabledReason}</InlineNotice> : null}
          {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmImages}
        title={text('reachDeck.regeneration.imageConfirmTitle', '重新生成所有图片？')}
        description={text(
          'reachDeck.regeneration.imageConfirm',
          '将重新生成并覆盖 {count} 张图片。',
          { count: imageCount },
        )}
        confirmLabel={text('reachDeck.regeneration.submit', '开始生成')}
        cancelLabel={text('reachDeck.regeneration.cancel', '取消')}
        onCancel={() => setConfirmImages(false)}
        onConfirm={() => {
          setConfirmImages(false);
          void submit(true);
        }}
      />
    </>
  );
}
