'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, LockKeyhole } from 'lucide-react';

import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import { NativeV2SlideRenderer } from '@reachany/reach-deck-player';
import { Dialog, Tooltip } from '@reachany/ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import type { PortalTranslator } from '@/src/lib/i18n';
import {
  STUDENT_REACH_DECK_PAGE_BLOCK_MESSAGE_KEYS,
  studentReachDeckPageStatus,
  type StudentReachDeckPageAccess,
  type StudentReachDeckPageBlockReason,
} from '@/src/lib/student-reach-deck-page-access';
import { studentReachDeckPageScript } from '@/src/lib/student-reach-deck-page-script';

import styles from './StudentReachDeckWorkspace.module.css';

export interface StudentReachDeckScriptOutlineProps {
  activePageId: string | undefined;
  document: ReachDeckDocument;
  /** 大纲所在页签是否可见：切回时把当前页滚进视野（隐藏时无法测量）。 */
  visible: boolean;
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  /** 跳页入口与播放器、讨论区共用工作区的 navigateToPage（含可达性与全局锁判断）。 */
  onNavigate: (pageId: string) => void;
  orderedPages: readonly ReachDeckPublishedPage[];
  pageAccess: StudentReachDeckPageAccess;
  pageBlockReason: (pageId: string) => StudentReachDeckPageBlockReason | null;
  playerReady: boolean;
}

/**
 * 大纲（右栏页签）：每页一条「缩略图 + 页标题 + 本页讲稿」。
 *
 * - 可达性与锁定原因复用 T3 的 pageAccess / pageBlockReason：已学可跳、未学锁定（aria-disabled +
 *   Tooltip 原因），完成页带对勾徽标；点击锁定项不切页，由工作区给出原因提示。
 * - 当前页高亮并自动滚到可见：只调整列表自身的 scrollTop，不用 scrollIntoView（会连带滚动外层）。
 * - 每页等高：标题一行、讲稿两行，放不下时右下角给「更多」，在弹窗里看完整讲稿。「更多」是条目旁的
 *   独立按钮（不嵌套在跳页按钮里）。
 * - 还没学到的页（锁定）不开放：缩略图位置显示「未学习」，讲稿位置只有一句说明，没有「更多」。
 */
export function StudentReachDeckScriptOutline({
  activePageId,
  document,
  nativeResourceUrlsById,
  onNavigate,
  orderedPages,
  pageAccess,
  pageBlockReason,
  playerReady,
  visible,
}: StudentReachDeckScriptOutlineProps) {
  const { t } = usePortalI18n();
  const listRef = useRef<HTMLOListElement>(null);
  const baseId = useId();
  const [overflowingScripts, setOverflowingScripts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [scriptDialogPageId, setScriptDialogPageId] = useState<string | null>(null);
  const scripts = useMemo(
    () =>
      new Map(
        orderedPages.map((page) => [page.pageId, studentReachDeckPageScript(document, page)]),
      ),
    [document, orderedPages],
  );

  useEffect(() => {
    const list = listRef.current;
    if (!visible || list === null || activePageId === undefined) return;
    const item = [...list.querySelectorAll<HTMLElement>('[data-outline-page-id]')].find(
      (candidate) => candidate.dataset.outlinePageId === activePageId,
    );
    if (item === undefined) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const inset = Number.parseFloat(window.getComputedStyle(list).paddingTop) || 0;
    if (itemRect.top < listRect.top + inset) {
      list.scrollTop += itemRect.top - listRect.top - inset;
    } else if (itemRect.bottom > listRect.bottom - inset) {
      // 当前项比可视区还高时，让它的顶部对齐而不是底部，讲稿从头可读。
      list.scrollTop += Math.min(
        itemRect.bottom - listRect.bottom + inset,
        itemRect.top - listRect.top - inset,
      );
    }
  }, [activePageId, visible]);

  // 已开放讲稿的页：解锁新页时列表外框尺寸不变，ResizeObserver 不会触发，要靠它重量。
  const learnedPagesKey = orderedPages
    .filter((page) => studentReachDeckPageStatus(pageAccess, page.pageId) !== 'locked')
    .map((page) => page.pageId)
    .join('\n');

  // 讲稿是否被两行截断只能量出来：列表可见时、开放了新页的讲稿时量一次，宽度变化（右栏宽度档位）时重量。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!visible || list === null) return;
    const measure = () => {
      const next = new Set<string>();
      list.querySelectorAll<HTMLElement>('[data-outline-script]').forEach((element) => {
        if (element.scrollHeight > element.clientHeight + 1) {
          next.add(element.dataset.outlineScript ?? '');
        }
      });
      setOverflowingScripts((previous) =>
        previous.size === next.size && [...next].every((pageId) => previous.has(pageId))
          ? previous
          : next,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [learnedPagesKey, scripts, visible]);

  const dialogIndex =
    scriptDialogPageId === null
      ? -1
      : orderedPages.findIndex((page) => page.pageId === scriptDialogPageId);
  const dialogCandidate = dialogIndex < 0 ? undefined : orderedPages[dialogIndex];
  const dialogPage =
    dialogCandidate !== undefined &&
    studentReachDeckPageStatus(pageAccess, dialogCandidate.pageId) !== 'locked'
      ? dialogCandidate
      : undefined;

  return (
    <>
      <ol
        aria-label={t('reachDeck.sidePanel.outlineTab')}
        className={`${styles.outline} rx-scroll-y`}
        data-reach-deck-outline
        ref={listRef}
      >
        {orderedPages.map((page, index) => {
          const status = studentReachDeckPageStatus(pageAccess, page.pageId);
          const blockReason = pageBlockReason(page.pageId);
          const blocked = !playerReady || blockReason !== null;
          const current = page.pageId === activePageId;
          const notLearned = status === 'locked';
          // 还没学到的页不开放讲稿：不显示内容，也没有「更多」。
          const script = notLearned ? null : (scripts.get(page.pageId) ?? null);
          const title = t('reachDeck.outline.pageTitle', { index: index + 1, title: page.title });
          const scriptId = `${baseId}-script-${index}`;
          return (
            <li className={styles.outlineEntry} key={page.pageId}>
              <Tooltip
                content={
                  blockReason === null
                    ? null
                    : t(STUDENT_REACH_DECK_PAGE_BLOCK_MESSAGE_KEYS[blockReason])
                }
                placement="left"
              >
                <button
                  aria-current={current ? 'page' : undefined}
                  aria-describedby={scriptId}
                  aria-disabled={blocked ? 'true' : undefined}
                  className={styles.outlineItem}
                  data-outline-page-id={page.pageId}
                  data-page-status={status}
                  onClick={() => onNavigate(page.pageId)}
                  type="button"
                >
                  <span className={styles.thumbnailFrame}>
                    {notLearned ? (
                      <span aria-hidden="true" className={styles.thumbnail} data-not-learned="true">
                        <LockKeyhole size={16} strokeWidth={2} />
                        <span className={styles.notLearnedLabel}>
                          {t('reachDeck.outline.notLearned')}
                        </span>
                      </span>
                    ) : (
                      <PageThumbnail
                        document={document}
                        nativeResourceUrlsById={nativeResourceUrlsById}
                        page={page}
                      />
                    )}
                    {status !== 'completed' ? null : (
                      <span
                        aria-hidden="true"
                        className={styles.pageStatusBadge}
                        data-status={status}
                      >
                        <Check size={12} strokeWidth={2.5} />
                      </span>
                    )}
                  </span>
                  <span className={styles.outlineBody}>
                    <span className={styles.outlineTitle}>{title}</span>
                    {current ? (
                      <span className="sr-only">{t('reachDeck.outline.current')}</span>
                    ) : null}
                    {status === 'available' ? null : (
                      <span className="sr-only">
                        {t(
                          status === 'completed'
                            ? 'reachDeck.pageAccess.statusCompleted'
                            : 'reachDeck.pageAccess.statusLocked',
                        )}
                      </span>
                    )}
                    <span
                      className={styles.outlineScript}
                      data-empty={script === null ? 'true' : undefined}
                      data-outline-script={notLearned ? undefined : page.pageId}
                      id={scriptId}
                    >
                      {notLearned
                        ? t('reachDeck.outline.scriptLocked')
                        : (script ?? t('reachDeck.outline.noScript'))}
                    </span>
                  </span>
                </button>
              </Tooltip>
              {script !== null && overflowingScripts.has(page.pageId) ? (
                <button
                  aria-haspopup="dialog"
                  aria-label={t('reachDeck.outline.moreLabel', { index: index + 1 })}
                  className={styles.outlineMore}
                  data-outline-more={page.pageId}
                  onClick={() => setScriptDialogPageId(page.pageId)}
                  type="button"
                >
                  {t('reachDeck.outline.more')}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <Dialog
        closeLabel={t('reachDeck.outline.scriptDialogClose')}
        data-outline-script-dialog
        onOpenChange={(open) => {
          if (!open) setScriptDialogPageId(null);
        }}
        open={dialogPage !== undefined}
        size="md"
        title={
          dialogPage === undefined
            ? ''
            : t('reachDeck.outline.pageTitle', { index: dialogIndex + 1, title: dialogPage.title })
        }
      >
        <p className={styles.scriptDialogBody}>
          {dialogPage === undefined ? null : scripts.get(dialogPage.pageId)}
        </p>
      </Dialog>
    </>
  );
}

function PageThumbnail({
  document,
  nativeResourceUrlsById,
  page,
}: {
  document: ReachDeckDocument;
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  page: ReachDeckPublishedPage;
}) {
  const { t } = usePortalI18n();
  const nativeSlide =
    document.schemaVersion === 'reach-deck-document/v2' && page.sceneType === 'slide'
      ? document.nativeSlides.find((binding) => binding.pageId === page.pageId)?.slide
      : undefined;
  const themeColors =
    document.schemaVersion === 'reach-deck-document/v2'
      ? document.resources.themes.find((theme) => theme.id === document.defaultThemeId)?.colors
      : undefined;

  if (nativeSlide !== undefined) {
    return (
      <span aria-hidden="true" className={styles.thumbnail} inert>
        <NativeV2SlideRenderer
          hideDiagnostics
          passiveMedia
          resourceUrlsById={nativeResourceUrlsById ?? {}}
          slide={nativeSlide}
          stage={document.stage}
          themeColors={themeColors ?? {}}
        />
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={styles.thumbnail} data-scene-type={page.sceneType}>
      <span className={styles.thumbnailType}>{sceneTypeLabel(page.sceneType, t)}</span>
    </span>
  );
}

function sceneTypeLabel(sceneType: string, t: PortalTranslator): string {
  switch (sceneType) {
    case 'quiz':
      return t('reachDeck.studentWorkspace.moduleType.quiz');
    case 'interactive':
      return t('reachDeck.studentWorkspace.moduleType.interactive');
    default:
      return t('reachDeck.studentWorkspace.moduleType.deck');
  }
}
