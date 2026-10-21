'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import { BrandLoader, Button } from '@reachany/ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import {
  type AttemptResponse,
  type AttemptProgress,
  type AttemptSummary,
  type StudentDeckLearningFence,
  parseAttemptResponse,
  parseAttemptProgress,
} from '@/src/lib/public-v2-reach-deck-client';
import type { StudentReachDeckNavigationState } from '@/src/lib/student-reach-deck-page-access';

import { StudentReachDeckAttemptPlayer } from './StudentReachDeckAttemptPlayer';
import type { StudentReachDeckTutorActivityContext } from './StudentReachDeckAttemptPlayer';

export interface StudentReachDeckAttemptLauncherProps {
  activePageId?: string;
  document: ReachDeckDocument;
  initialAttempt: AttemptSummary | null;
  initialAttemptProgress?: AttemptProgress | null;
  moduleVersionId: string;
  /** 学习页全屏（隐藏应用页头与返回栏）；入口在控制条最右侧，由工作台持有状态。 */
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;

  learningFence?: StudentDeckLearningFence | null;
  learningFenceResolved?: boolean;
  onLearningFenceChange?: (fence: StudentDeckLearningFence | null) => void;
  onLearningFenceRefreshStart?: () => void;
  onLearningFenceRefreshFailed?: (attemptId: string) => void;
  /** v2 原生媒体展示地址（resourceId → 短时签名 URL）。 */
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  nativeMediaScopeKey?: string;
  onNativeMediaError?: (resourceId: string, failedSrc: string) => void;
  onNativeMediaLoaded?: (resourceId: string, src: string) => void;
  onNativeMediaPlayingChange?: (resourceId: string, playing: boolean) => void;
  onPageChange?: (page: ReachDeckPublishedPage) => void;
  onWhiteboardEditingChange?: (editing: boolean) => void;
  onNavigationStateChange?: (state: StudentReachDeckNavigationState | null) => void;
  /** 本次学习起不来（自动开始失败或版本不匹配）时通知工作台，右栏不再等学习上下文。 */
  onStartBlockedChange?: (blocked: boolean) => void;
  onTutorActivityChange?: (context: StudentReachDeckTutorActivityContext | null) => void;
  onTutorAvailabilityChange?: (locked: boolean) => void;
  selectionId: string;
}

export function StudentReachDeckAttemptLauncher({
  activePageId,
  document,
  initialAttempt,
  initialAttemptProgress = null,
  moduleVersionId,
  fullscreen,
  onFullscreenChange,
  learningFence,
  learningFenceResolved,
  onLearningFenceChange,
  onLearningFenceRefreshStart,
  onLearningFenceRefreshFailed,
  nativeResourceUrlsById,
  nativeMediaScopeKey,
  onNativeMediaError,
  onNativeMediaLoaded,
  onNativeMediaPlayingChange,
  onPageChange,
  onWhiteboardEditingChange,
  onNavigationStateChange,
  onStartBlockedChange,
  onTutorActivityChange,
  onTutorAvailabilityChange,
  selectionId,
}: StudentReachDeckAttemptLauncherProps) {
  const { t } = usePortalI18n();
  const [attempt, setAttempt] = useState<AttemptResponse | null>(() =>
    initialAttempt === null ? null : { ...initialAttempt, applied: false },
  );
  const [attemptProgress, setAttemptProgress] = useState<AttemptProgress | null>(
    initialAttemptProgress,
  );
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const autoStartedRef = useRef(false);

  const needsAttempt = attempt === null || attempt.status === 'abandoned';
  const initialIdentityMatches =
    attempt === null ||
    (attempt.selectionId === selectionId && attempt.moduleVersionId === moduleVersionId);

  const startAttempt = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      const response = await fetch(
        `/api/student/reach-deck/track-modules/${encodeURIComponent(selectionId)}/attempts`,
        { method: 'POST' },
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(t('reachDeck.launcher.startFailed'));
      }
      let created: AttemptResponse;
      try {
        created = parseAttemptResponse(payload);
      } catch {
        throw new Error(t('reachDeck.launcher.startFailed'));
      }
      if (created.selectionId !== selectionId || created.moduleVersionId !== moduleVersionId) {
        setError(t('reachDeck.launcher.newAttemptMismatch'));
        return;
      }
      // 创建接口对已有记录是幂等返回；拿回来的仍不可学就按失败处理，不反复重建。
      if (created.status === 'abandoned') throw new Error(t('reachDeck.launcher.startFailed'));
      const progressResponse = await fetch(
        `/api/student/reach-deck/attempts/${encodeURIComponent(created.attemptId)}/progress`,
        { cache: 'no-store', method: 'GET' },
      );
      if (!progressResponse.ok) throw new Error(t('reachDeck.launcher.startFailed'));
      const progress = parseAttemptProgress(await progressResponse.json());
      if (
        progress.attemptId !== created.attemptId ||
        progress.selectionId !== created.selectionId ||
        progress.moduleVersionId !== created.moduleVersionId ||
        progress.status !== created.status
      ) {
        throw new Error(t('reachDeck.launcher.newAttemptMismatch'));
      }
      setAttempt(created);
      setAttemptProgress(progress);
    } catch {
      setError(t('reachDeck.launcher.startFailed'));
    } finally {
      startingRef.current = false;
    }
  }, [moduleVersionId, selectionId, t]);

  useEffect(() => {
    if (needsAttempt) onTutorActivityChange?.(null);
  }, [needsAttempt, onTutorActivityChange]);

  // 首次进入没有学习记录：不再让学生手动点「开始学习」，直接新建本次学习。
  useEffect(() => {
    if (!needsAttempt || !initialIdentityMatches || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void startAttempt();
  }, [initialIdentityMatches, needsAttempt, startAttempt]);

  const startBlocked = !initialIdentityMatches || (needsAttempt && error !== null);
  useEffect(() => {
    onStartBlockedChange?.(startBlocked);
  }, [onStartBlockedChange, startBlocked]);

  if (!initialIdentityMatches) {
    return (
      <div
        className="rounded-card border border-danger-border bg-danger-soft p-5 text-body text-danger-text"
        role="alert"
      >
        {t('reachDeck.launcher.identityMismatch')}
      </div>
    );
  }

  if (needsAttempt) {
    if (error !== null) {
      return (
        <div
          aria-live="assertive"
          className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger-border bg-danger-soft p-4 text-body text-danger-text"
          role="alert"
        >
          <span>{error}</span>
          <Button onClick={() => void startAttempt()} variant="secondary">
            {t('reachDeck.launcher.retry')}
          </Button>
        </div>
      );
    }
    // 与播放器载入学习记录时同一位置的品牌 loading，建好后无缝接上。
    return (
      <div className="grid h-full min-h-0 place-items-center p-6" data-student-player-loading>
        <BrandLoader label={t('reachDeck.launcher.starting')} size="lg" />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-visible">
      <StudentReachDeckAttemptPlayer
        activePageId={activePageId}
        attempt={attempt}
        initialProgress={attemptProgress}
        document={document}
        fullscreen={fullscreen}
        onFullscreenChange={onFullscreenChange}
        learningFence={learningFence}
        learningFenceResolved={learningFenceResolved}
        key={attempt.attemptId}
        nativeResourceUrlsById={nativeResourceUrlsById}
        nativeMediaScopeKey={nativeMediaScopeKey}
        onNativeMediaError={onNativeMediaError}
        onNativeMediaLoaded={onNativeMediaLoaded}
        onNativeMediaPlayingChange={onNativeMediaPlayingChange}
        onPageChange={onPageChange}
        onWhiteboardEditingChange={onWhiteboardEditingChange}
        onNavigationStateChange={onNavigationStateChange}
        onLearningEventDeliveryFailure={(failure) => {
          console.warn('Reach Deck learning event delivery failed', failure);
        }}
        onLearningFenceChange={onLearningFenceChange}
        onLearningFenceRefreshStart={onLearningFenceRefreshStart}
        onLearningFenceRefreshFailed={onLearningFenceRefreshFailed}
        onTutorActivityChange={onTutorActivityChange}
        onTutorAvailabilityChange={onTutorAvailabilityChange}
      />
    </div>
  );
}
