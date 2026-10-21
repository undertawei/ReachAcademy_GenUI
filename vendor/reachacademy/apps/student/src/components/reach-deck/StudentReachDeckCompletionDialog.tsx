'use client';

import { BookOpenCheck, PartyPopper } from 'lucide-react';
import Link from 'next/link';

import { Button, buttonStyleProps, Dialog } from '@reachany/ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import { useStudentLearningNavTargets } from '@/src/components/student/StudentLearningPage';
import { unavailableReasonText } from '@/src/components/student/StudentTrackModuleChip';

import styles from './StudentReachDeckWorkspace.module.css';

export type StudentReachDeckCompletionCheck =
  | { status: 'checking' }
  | { status: 'error'; message: string }
  | { status: 'ready' };

/**
 * Deck 最后一页「完成学习」后的收尾弹窗（#804，参考模课）。
 *
 * 只是给学生的仪式感与去向指引，不提交任何东西：Deck 是否完成由服务端按学习行为判定
 * （学完全部页面后播放器自动完成，见 StudentReachDeckAttemptPlayer 的自动完成）。
 *
 * 只有服务端确认 attempt 已完成才祝贺；页面覆盖完成但 attempt 尚未完成时继续等待自动确认。
 */
export function StudentReachDeckCompletionDialog({
  attemptCompleted,
  completedPages,
  confirmation,
  firstIncompletePageNumber,
  gradingPending,
  moduleTitle,
  onGoToFirstIncomplete,
  onOpenChange,
  onRetry,
  open,
  totalPages,
}: {
  attemptCompleted: boolean;
  completedPages: number;
  confirmation: StudentReachDeckCompletionCheck;
  /** 第一个未学页的页码（从 1 开始）；全部学完时为 null。 */
  firstIncompletePageNumber: number | null;
  gradingPending: boolean;
  moduleTitle: string;
  onGoToFirstIncomplete: () => void;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  open: boolean;
  totalPages: number;
}) {
  const { t } = usePortalI18n();
  const targets = useStudentLearningNavTargets();
  const backHref = targets?.backHref ?? '/student/track-detail';
  const nextItem = targets?.nextItem;
  const remaining = Math.max(0, totalPages - completedPages);
  const close = () => onOpenChange(false);
  const nextModule =
    nextItem === undefined ? null : (
      <div>
        <p className={styles.completionNext}>
          <span>{t('reachDeck.completion.upNext')}</span>
          <strong>{nextItem.moduleTitle}</strong>
        </p>
        {nextItem.available && nextItem.href ? null : (
          <p className={styles.completionNote}>
            {unavailableReasonText(nextItem.unavailableReason, t)}
          </p>
        )}
      </div>
    );

  if (confirmation.status !== 'ready') {
    const checking = confirmation.status === 'checking';
    return (
      <Dialog
        closeLabel={t('reachDeck.completion.close')}
        footer={
          <>
            <Button onClick={close} variant="secondary">
              {t('reachDeck.completion.close')}
            </Button>
            {checking ? null : <Button onClick={onRetry}>{t('reachDeck.completion.retry')}</Button>}
          </>
        }
        icon={<BookOpenCheck />}
        onOpenChange={onOpenChange}
        open={open}
        size="sm"
        title={t(
          checking ? 'reachDeck.completion.checkingTitle' : 'reachDeck.completion.errorTitle',
        )}
      >
        <p aria-live="polite" role={checking ? 'status' : 'alert'}>
          {checking ? t('reachDeck.completion.checkingDescription') : confirmation.message}
        </p>
      </Dialog>
    );
  }

  if (!attemptCompleted && completedPages >= totalPages) {
    return (
      <Dialog
        closeLabel={t('reachDeck.completion.close')}
        footer={
          <>
            <Button onClick={close} variant="secondary">
              {t('reachDeck.completion.review')}
            </Button>
            <Button onClick={onRetry}>{t('reachDeck.completion.retry')}</Button>
          </>
        }
        icon={<BookOpenCheck />}
        onOpenChange={onOpenChange}
        open={open}
        size="sm"
        title={t('reachDeck.completion.pendingTitle')}
      >
        <p aria-live="polite" role="status">
          {t(
            gradingPending
              ? 'reachDeck.completion.gradingPending'
              : 'reachDeck.completion.pendingDescription',
          )}
        </p>
        {nextModule}
      </Dialog>
    );
  }

  if (!attemptCompleted) {
    return (
      <Dialog
        closeLabel={t('reachDeck.completion.close')}
        footer={
          <>
            <Button onClick={close} variant="secondary">
              {t('reachDeck.completion.later')}
            </Button>
            {firstIncompletePageNumber === null ? null : (
              <Button
                onClick={() => {
                  close();
                  onGoToFirstIncomplete();
                }}
              >
                {t('reachDeck.completion.goToPage', { page: firstIncompletePageNumber })}
              </Button>
            )}
          </>
        }
        icon={<BookOpenCheck />}
        onOpenChange={onOpenChange}
        open={open}
        size="sm"
        title={t('reachDeck.completion.unfinishedTitle', { count: remaining })}
      >
        <p>{t('reachDeck.completion.unfinishedDescription')}</p>
        {gradingPending ? <p>{t('reachDeck.completion.gradingPending')}</p> : null}
        {nextModule}
      </Dialog>
    );
  }

  return (
    <Dialog
      className={styles.completionDialog}
      closeLabel={t('reachDeck.completion.close')}
      footer={
        <>
          <Link {...buttonStyleProps({ variant: 'secondary' })} href={backHref}>
            {targets?.backLabel ?? t('student.course.backToTrack')}
          </Link>
          {nextItem?.available !== true || !nextItem.href ? (
            <Button onClick={close}>{t('reachDeck.completion.review')}</Button>
          ) : (
            <Link {...buttonStyleProps()} href={nextItem.href}>
              {t('reachDeck.completion.nextModule')}
            </Link>
          )}
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      size="sm"
      title={<span className="sr-only">{t('reachDeck.completion.title')}</span>}
    >
      <div className={styles.completion} data-reach-deck-completion>
        <span aria-hidden="true" className={styles.completionIcon}>
          <PartyPopper />
        </span>
        <p className={styles.completionTitle}>{t('reachDeck.completion.title')}</p>
        <p className={styles.completionDescription}>
          {t('reachDeck.completion.description', { title: moduleTitle, count: totalPages })}
        </p>
        {gradingPending ? (
          <p className={styles.completionNote}>{t('reachDeck.completion.gradingPending')}</p>
        ) : null}
        {nextModule}
      </div>
    </Dialog>
  );
}
