'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Volume2 } from 'lucide-react';
import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import { studentReachDeckPageScriptParts } from '@/src/lib/student-reach-deck-page-script';

import styles from './StudentReachDeckWorkspace.module.css';

export interface StudentReachDeckCurrentScriptProps {
  document: ReachDeckDocument;
  page: ReachDeckPublishedPage | undefined;
  currentTime: number | undefined;
  visible: boolean;
}

export function StudentReachDeckCurrentScript({
  document,
  page,
  currentTime,
  visible,
}: StudentReachDeckCurrentScriptProps) {
  const { t } = usePortalI18n();
  const containerRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLSpanElement>(null);
  const parts = useMemo(
    () => (page === undefined ? [] : studentReachDeckPageScriptParts(document, page)),
    [document, page],
  );
  const activeIndex =
    currentTime === undefined || !Number.isFinite(currentTime)
      ? -1
      : parts.findIndex(
          (part) =>
            part.start !== undefined &&
            part.end !== undefined &&
            currentTime >= part.start &&
            currentTime < part.end,
        );

  // Changing pages must not leave an untimed script at the previous page's scroll position.
  useEffect(() => {
    if (containerRef.current !== null) containerRef.current.scrollTop = 0;
  }, [page?.pageId]);

  // Only move this panel, and only when the active segment changes or the tab becomes visible.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || !visible) return;
    const active = activeRef.current;
    if (active === null) return;
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const inset = Number.parseFloat(window.getComputedStyle(container).paddingTop) || 0;
    if (activeRect.top < containerRect.top + inset) {
      container.scrollTop += activeRect.top - containerRect.top - inset;
    } else if (activeRect.bottom > containerRect.bottom - inset) {
      container.scrollTop += Math.min(
        activeRect.bottom - containerRect.bottom + inset,
        activeRect.top - containerRect.top - inset,
      );
    }
  }, [activeIndex, page?.pageId, visible]);

  return (
    <div
      className={styles.currentScript}
      data-reach-deck-current-script
      data-script-page-id={page?.pageId}
    >
      <header className={styles.currentScriptHeader} data-reach-deck-script-header>
        {page === undefined ? null : (
          <h2 className={styles.currentScriptTitle} title={page.title}>
            {page.title}
          </h2>
        )}
        <span
          className={styles.currentScriptStatus}
          data-active={activeIndex >= 0}
          data-script-status
        >
          <Volume2 aria-hidden="true" strokeWidth={1.5} />
          {t('reachDeck.script.speaking')}
        </span>
      </header>
      <section
        aria-label={t('reachDeck.script.label')}
        className={`${styles.currentScriptScroll} rx-scroll-y`}
        data-reach-deck-script-scroll
        ref={containerRef}
        tabIndex={0}
      >
        {parts.length === 0 ? (
          <p className={styles.currentScriptEmpty}>{t('reachDeck.script.empty')}</p>
        ) : (
          <p className={styles.currentScriptBody} data-reach-deck-script-body>
            {parts.map((part, index) => (
              <span
                aria-current={index === activeIndex ? 'true' : undefined}
                className={styles.currentScriptSegment}
                data-script-segment={part.start === undefined ? undefined : index}
                key={index}
                ref={index === activeIndex ? activeRef : undefined}
                title={index === activeIndex ? t('reachDeck.script.speaking') : undefined}
              >
                {part.text}
              </span>
            ))}
          </p>
        )}
      </section>
    </div>
  );
}
