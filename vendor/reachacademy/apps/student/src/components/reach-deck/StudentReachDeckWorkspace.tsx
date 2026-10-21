'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, FileText, LockKeyhole, MessagesSquare, ScrollText } from 'lucide-react';

import { type ReachDeckDocument, type ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import { Button, SidePanel, Tab, TabList, TabPanel, Tabs } from '@reachany/ui';
import { TutorPanel, useTutorPanel } from '@reachany/tutor-ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import {
  type StudentLearningRailSelectEvent,
  useStudentLearningRailControl,
} from '@/src/components/student/StudentLearningPage';
import {
  parseActiveStudentDeckLearningFence,
  type AttemptProgress,
  type AttemptSummary,
  type StudentDeckLearningFence,
} from '@/src/lib/public-v2-reach-deck-client';
import {
  STUDENT_REACH_DECK_PAGE_BLOCK_MESSAGE_KEYS,
  resolveStudentReachDeckNavigationLock,
  resolveStudentReachDeckPageAccess,
  studentReachDeckPageBlockReason,
  type StudentReachDeckNavigationState,
  type StudentReachDeckPageBlockReason,
} from '@/src/lib/student-reach-deck-page-access';
import type { StudentReachDeckRailItem } from '@/src/lib/student-reach-deck-workspace';

import { StudentReachDeckAttemptLauncher } from './StudentReachDeckAttemptLauncher';
import type { StudentReachDeckTutorActivityContext } from './StudentReachDeckAttemptPlayer';
import { StudentReachDeckDiscussion } from './StudentReachDeckDiscussion';
import { StudentReachDeckCurrentScript } from './StudentReachDeckCurrentScript';
import { StudentReachDeckLearningFenceDialog } from './StudentReachDeckLearningFenceDialog';
import { StudentReachDeckScriptOutline } from './StudentReachDeckScriptOutline';
import styles from './StudentReachDeckWorkspace.module.css';
import { useStudentNativeMediaUrls } from './useStudentNativeMediaUrls';

export interface StudentReachDeckWorkspaceProps {
  document: ReachDeckDocument | null;
  initialAttempt: AttemptSummary | null;
  initialAttemptProgress?: AttemptProgress | null;
  moduleVersionId: string | null;
  courseId: string | null;
  courseNodeId: string | null;
  moduleId: string | null;
  /** v2 原生媒体展示地址（resourceId → 短时签名 URL）。 */
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  railItems: StudentReachDeckRailItem[];
  selectionId: string;
}

export function StudentReachDeckWorkspace({
  document,
  initialAttempt,
  initialAttemptProgress = null,
  courseId,
  courseNodeId,
  moduleId,
  moduleVersionId,
  nativeResourceUrlsById,
  railItems,
  selectionId,
}: StudentReachDeckWorkspaceProps) {
  const { t } = usePortalI18n();
  const orderedPages = useMemo(
    () =>
      document === null ? [] : [...document.pages].sort((left, right) => left.order - right.order),
    [document],
  );
  const {
    urls: resolvedNativeResourceUrlsById,
    requestRefresh,
    reportLoaded,
    reportPlaying,
  } = useStudentNativeMediaUrls({
    document,
    initialUrls: nativeResourceUrlsById,
    moduleVersionId,
    selectionId,
  });
  const [activePageId, setActivePageId] = useState(() =>
    initialReachDeckPageId(orderedPages, initialAttempt, initialAttemptProgress),
  );
  const [sideTab, setSideTab] = useState<StudentReachDeckSideTab>('tutor');
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // 进入全屏前的右栏收起状态：全屏时右栏收成竖条，退出时还原（不写入收起记忆）。
  const collapsedBeforeFullscreenRef = useRef<boolean | null>(null);
  const [learningFence, setLearningFence] = useState<StudentDeckLearningFence | null>(null);
  const [completedLearningFences, setCompletedLearningFences] = useState<
    StudentDeckLearningFence[]
  >([]);
  const tutorPanel = useTutorPanel();
  const {
    overlay: fenceOverlay,
    setOverlay: setFenceOverlay,
    openFence,
    activateFence,
  } = tutorPanel;
  const initialFenceAttemptId =
    initialAttempt?.status === 'in_progress' ? initialAttempt.attemptId : null;
  const [learningFenceResolved, setLearningFenceResolved] = useState(
    initialFenceAttemptId === null,
  );
  const [learningFenceRecoveryFailed, setLearningFenceRecoveryFailed] = useState(false);
  // Attempt whose in-player fence refresh failed; the recovery retry targets it first.
  const [failedFenceAttemptId, setFailedFenceAttemptId] = useState<string | null>(null);
  // 进入即自动开始学习；只有起不来时右栏才不再等学习上下文。
  const [attemptStartBlocked, setAttemptStartBlocked] = useState(false);
  const [tutorActivity, setTutorActivity] = useState<StudentReachDeckTutorActivityContext | null>(
    null,
  );
  const [quizTutorLocked, setQuizTutorLocked] = useState(false);
  const [whiteboardEditing, setWhiteboardEditing] = useState(false);
  // 播放器上报的可达性与护栏批阅锁；播放器尚未挂载（开始学习前）时用服务端初始进度兜底。
  const [playerNavigationState, setPlayerNavigationState] =
    useState<StudentReachDeckNavigationState | null>(null);
  const [pageBlockNotice, setPageBlockNotice] = useState<StudentReachDeckPageBlockReason | null>(
    null,
  );
  const currentItem = railItems.find((item) => item.selectionId === selectionId) ?? null;
  // 只有服务端判定不可用（顺序学 / Quiz 门禁 / 内容下架）才挡在播放器前；截止时间不参与。
  const gatedItem = currentItem?.available === false ? currentItem : null;
  const playerReady = gatedItem === null && document !== null && moduleVersionId !== null;
  const scopedTutorActivity =
    tutorActivity?.selectionId === selectionId && tutorActivity.moduleVersionId === moduleVersionId
      ? tutorActivity
      : null;
  const activeTutorActivity =
    scopedTutorActivity?.activity.pageId === activePageId ? scopedTutorActivity : null;
  const playbackState =
    activeTutorActivity?.activity.sceneType === 'slide' ? activeTutorActivity.activity.state : null;
  const scriptCurrentTime =
    playbackState !== null &&
    typeof playbackState === 'object' &&
    'currentTime' in playbackState &&
    typeof playbackState.currentTime === 'number'
      ? playbackState.currentTime
      : undefined;
  const tutorAttemptId = scopedTutorActivity?.attemptId;
  const tutorSelectionId = scopedTutorActivity?.selectionId;
  const tutorModuleVersionId = scopedTutorActivity?.moduleVersionId;
  const tutorDomainScope = useMemo(
    () =>
      tutorAttemptId === undefined ||
      tutorSelectionId === undefined ||
      tutorModuleVersionId === undefined
        ? null
        : {
            ...(courseId ? { courseId } : {}),
            ...(courseNodeId ? { courseNodeId } : {}),
            ...(moduleId ? { moduleId } : {}),
            selectionId: tutorSelectionId,
            moduleVersionId: tutorModuleVersionId,
            attemptId: tutorAttemptId,
            tutorDomain: 'ordinary',
          },
    [courseId, courseNodeId, moduleId, tutorAttemptId, tutorModuleVersionId, tutorSelectionId],
  );
  const discussionPages = useMemo(
    () =>
      orderedPages.map((page) => ({ pageId: page.pageId, title: page.title, order: page.order })),
    [orderedPages],
  );
  const tutorLearningContext = useMemo(
    () =>
      activeTutorActivity === null
        ? null
        : {
            schemaVersion: 'reach-deck-tutor-context/v1' as const,
            attemptId: activeTutorActivity.attemptId,
            pageId: activeTutorActivity.activity.pageId,
            observedAt: new Date().toISOString(),
            activity: activeTutorActivity.activity,
          },
    [activeTutorActivity],
  );
  const selectedLearningFence =
    learningFence ??
    completedLearningFences.find((fence) => fence.fenceId === fenceOverlay?.key) ??
    null;
  const fenceDomainScope = useMemo(
    () =>
      selectedLearningFence === null || moduleVersionId === null
        ? null
        : {
            ...(courseId ? { courseId } : {}),
            ...(courseNodeId ? { courseNodeId } : {}),
            ...(moduleId ? { moduleId } : {}),
            selectionId,
            moduleVersionId,
            attemptId: selectedLearningFence.attemptId,
            tutorDomain: 'learning_fence',
            fenceId: selectedLearningFence.fenceId,
            pageId: selectedLearningFence.pageId,
            questionId: selectedLearningFence.questionId,
            sceneId: selectedLearningFence.sceneId,
          },
    [courseId, courseNodeId, moduleId, moduleVersionId, selectedLearningFence, selectionId],
  );
  // 兜底只认服务端已确认的进度：开始学习前没有「进入」过任何页，不做幻灯片乐观解锁。
  const initialPageAccess = useMemo(() => {
    const progress = matchingInitialProgress(initialAttempt, initialAttemptProgress);
    return resolveStudentReachDeckPageAccess({
      attemptCompleted: initialAttempt?.status === 'completed',
      completedPageIds: progress?.completedPageIds ?? [],
      pages: orderedPages,
    });
  }, [initialAttempt, initialAttemptProgress, orderedPages]);
  const pageAccess = playerNavigationState?.pageAccess ?? initialPageAccess;
  const navigationLock = resolveStudentReachDeckNavigationLock({
    currentPageFencedGrading: playerNavigationState?.currentPageFencedGrading ?? false,
    learningFenceActive: learningFence !== null,
    learningFenceResolved,
    whiteboardEditing,
  });
  const navigationLocked = navigationLock !== null;
  const pageBlockReason = (pageId: string) =>
    studentReachDeckPageBlockReason(pageAccess, navigationLock, pageId, activePageId);
  /** 大纲、讨论区与护栏记录的跳页统一走这里；被拒时只给原因提示，不切页。 */
  const navigateToPage = (pageId: string): boolean => {
    if (!playerReady) return false;
    const reason = pageBlockReason(pageId);
    if (reason !== null) {
      setPageBlockNotice(reason);
      return false;
    }
    setPageBlockNotice(null);
    setActivePageId(pageId);
    return true;
  };
  const recoveryAttemptId =
    learningFence?.attemptId ?? failedFenceAttemptId ?? initialFenceAttemptId ?? tutorAttemptId;

  useEffect(() => {
    if (pageBlockNotice === null) return;
    const timer = window.setTimeout(() => setPageBlockNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [pageBlockNotice]);

  useEffect(() => {
    if (learningFence !== null && activePageId !== learningFence.pageId) {
      setActivePageId(learningFence.pageId);
    }
  }, [activePageId, learningFence]);

  // 规范 02 §6：1024–1279（及更窄）学生端右栏默认收起；用户手动切换过则以记忆为准。
  useLayoutEffect(() => {
    if (readStoredSidePanelCollapsed() !== undefined) return;
    if (window.matchMedia?.(SIDE_PANEL_AUTO_COLLAPSE_QUERY).matches) setSidePanelCollapsed(true);
  }, []);

  /*
   * 全屏（参考模课）：对整个文档请求浏览器全屏，并在 <html> 上打标记，由全局样式隐藏应用
   * 页头与返回栏——不对工作台节点本身全屏，否则挂到 body 上的浮层（倍速下拉等）会看不见。
   * 浏览器拒绝或不支持全屏 API 时退化为页面内全屏，Esc 同样可以退出。
   */
  const changeFullscreen = useCallback((next: boolean) => {
    setFullscreen(next);
    const root = globalThis.document.documentElement;
    if (next) {
      if (globalThis.document.fullscreenElement == null && root.requestFullscreen) {
        root.requestFullscreen().catch(() => undefined);
      }
    } else if (globalThis.document.fullscreenElement != null) {
      globalThis.document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const root = globalThis.document.documentElement;
    root.setAttribute('data-reach-deck-fullscreen', '');
    collapsedBeforeFullscreenRef.current = sidePanelCollapsed;
    setSidePanelCollapsed(true);
    let enteredNativeFullscreen = false;
    const onFullscreenChange = () => {
      if (globalThis.document.fullscreenElement != null) {
        enteredNativeFullscreen = true;
      } else if (enteredNativeFullscreen) {
        // 浏览器自己退出了全屏（Esc、系统手势）：页面也跟着退出。
        setFullscreen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && globalThis.document.fullscreenElement == null) {
        setFullscreen(false);
      }
    };
    globalThis.document.addEventListener('fullscreenchange', onFullscreenChange);
    globalThis.document.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.document.removeEventListener('fullscreenchange', onFullscreenChange);
      globalThis.document.removeEventListener('keydown', onKeyDown);
      root.removeAttribute('data-reach-deck-fullscreen');
      if (collapsedBeforeFullscreenRef.current !== null) {
        setSidePanelCollapsed(collapsedBeforeFullscreenRef.current);
        collapsedBeforeFullscreenRef.current = null;
      }
      if (globalThis.document.fullscreenElement != null) {
        globalThis.document.exitFullscreen().catch(() => undefined);
      }
    };
    // 只在进入/退出全屏时运行；全屏期间学生手动展开右栏不应触发重新收起。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  // 学习护栏对话只在「AI 对话」页签里进行：恢复中或激活时切回该页签；激活时还要展开右栏，
  // 学生必须完成这段对话才能继续（恢复中只是核对状态，不打断默认收起）。
  const fenceNeedsTutor = learningFence !== null || !learningFenceResolved;
  const fenceActive = learningFence !== null;
  useEffect(() => {
    if (fenceNeedsTutor) setSideTab('tutor');
  }, [fenceNeedsTutor]);
  useEffect(() => {
    if (fenceActive) setSidePanelCollapsed(false);
  }, [fenceActive]);

  const acceptLearningFence = useCallback(
    (fence: StudentDeckLearningFence | null) => {
      setLearningFence(fence);
      if (fence !== null) {
        setCompletedLearningFences((current) => upsertLearningFence(current, fence));
        activateFence(fence.fenceId);
      } else {
        setFenceOverlay((current) =>
          current?.kind === 'active' ? { ...current, kind: 'mastered' } : current,
        );
      }
      setLearningFenceResolved(true);
      setLearningFenceRecoveryFailed(false);
    },
    [setFenceOverlay, activateFence],
  );

  const refreshLearningFence = useCallback(
    async (attemptId: string) => {
      setLearningFenceResolved(false);
      setLearningFenceRecoveryFailed(false);
      try {
        const response = await fetch(
          `/api/student/reach-deck/attempts/${encodeURIComponent(attemptId)}/learning-fence`,
          { cache: 'no-store', method: 'GET' },
        );
        if (!response.ok) throw new Error(`Learning fence recovery failed (${response.status})`);
        const parsed = parseActiveStudentDeckLearningFence(await response.json());
        acceptLearningFence(parsed.fence);
      } catch {
        setLearningFenceRecoveryFailed(true);
      }
    },
    [acceptLearningFence],
  );

  useEffect(() => {
    if (initialFenceAttemptId !== null) void refreshLearningFence(initialFenceAttemptId);
  }, [initialFenceAttemptId, refreshLearningFence]);

  useEffect(() => {
    if (!learningFenceResolved || learningFence !== null || tutorDomainScope === null) {
      return;
    }
    const controller = new AbortController();
    void fetch('/api/ai-runtime/threads?sceneKey=student.tutor', { signal: controller.signal })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((value: unknown) => {
        if (controller.signal.aborted) return;
        const restored = restoreCompletedLearningFences(value, tutorDomainScope);
        if (!controller.signal.aborted && restored.length > 0) {
          setCompletedLearningFences((current) => mergeLearningFences(current, restored));
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [learningFence, learningFenceResolved, tutorDomainScope]);

  const beginLearningFenceRefresh = useCallback(() => {
    setLearningFenceResolved(false);
    setLearningFenceRecoveryFailed(false);
  }, []);

  const failLearningFenceRefresh = useCallback((attemptId: string) => {
    setFailedFenceAttemptId(attemptId);
    setLearningFenceRecoveryFailed(true);
  }, []);

  const selectModule = useCallback(
    (event: StudentLearningRailSelectEvent, item: StudentReachDeckRailItem) => {
      if (navigationLocked) {
        event.preventDefault();
        return;
      }
      if (!item.href) {
        event.preventDefault();
      }
    },
    [navigationLocked],
  );

  useStudentLearningRailControl({ navigationLocked, onSelect: selectModule });

  return (
    <section
      className={styles.workspace}
      data-reach-deck-layout="workspace"
      data-reach-deck-workspace
    >
      <div className={styles.playerColumn} data-reach-deck-region="player">
        <p
          aria-live="polite"
          className={styles.pageBlockNotice}
          data-reach-deck-page-block-notice
          role="status"
        >
          {pageBlockNotice === null
            ? null
            : t(STUDENT_REACH_DECK_PAGE_BLOCK_MESSAGE_KEYS[pageBlockNotice])}
        </p>
        {gatedItem !== null ? (
          <LockedModuleGate item={gatedItem} />
        ) : playerReady ? (
          <section className={styles.playerContainer} data-reach-deck-player-container>
            <StudentReachDeckAttemptLauncher
              activePageId={activePageId}
              document={document}
              fullscreen={fullscreen}
              onFullscreenChange={changeFullscreen}
              initialAttempt={initialAttempt}
              initialAttemptProgress={initialAttemptProgress}
              learningFenceResolved={learningFenceResolved}
              moduleVersionId={moduleVersionId}
              nativeResourceUrlsById={resolvedNativeResourceUrlsById}
              nativeMediaScopeKey={`${selectionId}:${moduleVersionId ?? 'none'}`}
              onNativeMediaError={requestRefresh}
              onNativeMediaLoaded={reportLoaded}
              onNativeMediaPlayingChange={reportPlaying}
              onPageChange={(page) => setActivePageId(page.pageId)}
              onWhiteboardEditingChange={setWhiteboardEditing}
              onNavigationStateChange={setPlayerNavigationState}
              onStartBlockedChange={setAttemptStartBlocked}
              learningFence={learningFence}
              onLearningFenceChange={acceptLearningFence}
              onLearningFenceRefreshStart={beginLearningFenceRefresh}
              onLearningFenceRefreshFailed={failLearningFenceRefresh}
              onTutorActivityChange={setTutorActivity}
              onTutorAvailabilityChange={setQuizTutorLocked}
              selectionId={selectionId}
            />
          </section>
        ) : (
          <div className={styles.futureGate} role="alert">
            <LockKeyhole className={styles.gateIcon} size={36} />
            <div>
              <h2 className={styles.gateTitle}>
                {t('reachDeck.studentWorkspace.unavailableTitle')}
              </h2>
              <p className={styles.gateDescription}>
                {t('reachDeck.studentWorkspace.unavailableDescription')}
              </p>
            </div>
          </div>
        )}
      </div>

      <Tabs
        className={styles.sideTabs}
        keepMounted
        onChange={(value) => setSideTab(value as StudentReachDeckSideTab)}
        value={sideTab}
        variant="panel"
      >
        <SidePanel
          aria-label={t('reachDeck.sidePanel.label')}
          className={styles.sidePanel}
          collapseLabel={t('reachDeck.sidePanel.collapse')}
          collapsed={sidePanelCollapsed}
          data-reach-deck-region="side-panel"
          expandLabel={t('reachDeck.sidePanel.expand')}
          header={
            <TabList aria-label={t('reachDeck.sidePanel.tabs')} className={styles.sideTabList}>
              <Tab icon={<MessagesSquare />} value="tutor">
                {t('reachDeck.sidePanel.tutorTab')}
              </Tab>
              <Tab icon={<FileText />} value="script">
                {t('reachDeck.sidePanel.scriptTab')}
              </Tab>
              <Tab icon={<ScrollText />} value="outline">
                {t('reachDeck.sidePanel.outlineTab')}
              </Tab>
            </TabList>
          }
          onCollapsedChange={setSidePanelCollapsed}
          persistKey={SIDE_PANEL_PERSIST_KEY}
          size="sm"
        >
          <TabPanel className={styles.sideTabPanel} data-reach-deck-region="tutor" value="tutor">
            <TutorPanel
              controller={tutorPanel}
              title={t(
                fenceOverlay?.kind === 'history'
                  ? 'reachDeck.learningFence.historyCardTitle'
                  : fenceOverlay?.kind === 'mastered'
                    ? 'reachDeck.learningFence.masteredTitle'
                    : 'reachDeck.learningFence.title',
              )}
              closeLabel={t(
                fenceOverlay?.kind === 'mastered'
                  ? 'reachDeck.learningFence.leave'
                  : 'reachDeck.learningFence.collapse',
              )}
              renderFence={(overlay) =>
                selectedLearningFence === null || fenceDomainScope === null ? null : (
                  <StudentReachDeckLearningFenceDialog
                    domainScope={fenceDomainScope}
                    fence={selectedLearningFence}
                    key={overlay.key}
                    locked={overlay.kind === 'active' && learningFenceResolved}
                    onRunSettled={() => {
                      if (overlay.kind === 'active')
                        void refreshLearningFence(selectedLearningFence.attemptId);
                    }}
                    readOnlyNotice={
                      !learningFenceResolved
                        ? t(
                            learningFenceRecoveryFailed
                              ? 'reachDeck.learningFence.recoveryFailed'
                              : 'reachDeck.learningFence.recovering',
                          )
                        : overlay.kind === 'mastered'
                          ? t('reachDeck.learningFence.masteredReadOnly')
                          : undefined
                    }
                    systemNotice={
                      overlay.kind === 'mastered'
                        ? t('reachDeck.learningFence.masteredMessage')
                        : undefined
                    }
                    recoveryAction={
                      learningFenceRecoveryFailed ? (
                        <Button
                          onClick={() => void refreshLearningFence(selectedLearningFence.attemptId)}
                        >
                          {t('reachDeck.learningFence.retryRecovery')}
                        </Button>
                      ) : undefined
                    }
                  />
                )
              }
            >
              {!learningFenceResolved && fenceOverlay === null ? (
                <aside
                  aria-label={t('reachDeck.learningFence.recoveryLabel')}
                  className="grid h-full place-items-center bg-surface-warm p-6 text-center"
                  role={learningFenceRecoveryFailed ? 'alert' : 'status'}
                >
                  <div className="max-w-xs">
                    <LockKeyhole className="mx-auto text-primary" size={28} />
                    <h2 className="mt-3 font-bold text-fg">
                      {t('reachDeck.learningFence.recoveryTitle')}
                    </h2>
                    <p className="mt-2 text-body leading-6 text-fg-secondary">
                      {t(
                        learningFenceRecoveryFailed
                          ? 'reachDeck.learningFence.recoveryFailed'
                          : 'reachDeck.learningFence.recovering',
                      )}
                    </p>
                    {learningFenceRecoveryFailed && recoveryAttemptId !== undefined ? (
                      <div className="mt-4">
                        <Button onClick={() => void refreshLearningFence(recoveryAttemptId)}>
                          {t('reachDeck.learningFence.retryRecovery')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </aside>
              ) : (
                <StudentReachDeckDiscussion
                  activePageId={activePageId}
                  domainScope={tutorDomainScope}
                  learningFences={completedLearningFences}
                  learningContext={tutorLearningContext}
                  onNavigateToPage={(pageId) => {
                    navigateToPage(pageId);
                  }}
                  readOnly={quizTutorLocked}
                  readOnlyNotice={
                    quizTutorLocked ? t('reachDeck.discussion.quizLocked') : undefined
                  }
                  onOpenLearningFence={(key, source) => {
                    if (navigationLocked) return;
                    const fence = completedLearningFences.find(
                      (candidate) => candidate.fenceId === key,
                    );
                    if (fence === undefined) return;
                    if (fence.pageId !== activePageId && !navigateToPage(fence.pageId)) return;
                    openFence(key, 'history', source);
                  }}
                  pages={discussionPages}
                  preparing={!attemptStartBlocked}
                />
              )}
            </TutorPanel>
          </TabPanel>
          <TabPanel className={styles.sideTabPanel} data-reach-deck-region="script" value="script">
            {document === null || !playerReady ? null : (
              <StudentReachDeckCurrentScript
                currentTime={scriptCurrentTime}
                document={document}
                page={orderedPages.find((page) => page.pageId === activePageId)}
                visible={sideTab === 'script' && !sidePanelCollapsed}
              />
            )}
          </TabPanel>
          <TabPanel
            className={styles.sideTabPanel}
            data-reach-deck-region="outline"
            value="outline"
          >
            {document === null ? null : (
              <StudentReachDeckScriptOutline
                activePageId={activePageId}
                document={document}
                nativeResourceUrlsById={resolvedNativeResourceUrlsById}
                onNavigate={(pageId) => {
                  navigateToPage(pageId);
                }}
                orderedPages={orderedPages}
                pageAccess={pageAccess}
                pageBlockReason={pageBlockReason}
                playerReady={playerReady}
                visible={sideTab === 'outline' && !sidePanelCollapsed}
              />
            )}
          </TabPanel>
        </SidePanel>
      </Tabs>
    </section>
  );
}

type StudentReachDeckSideTab = 'outline' | 'script' | 'tutor';

/** 右栏收起状态按页面类型记忆（规范 03 §3.19）。 */
const SIDE_PANEL_PERSIST_KEY = 'reachany.student.reach-deck.side-panel-collapsed';
const SIDE_PANEL_AUTO_COLLAPSE_QUERY = '(max-width: 1279px)';

function readStoredSidePanelCollapsed(): boolean | undefined {
  try {
    const value = window.localStorage.getItem(SIDE_PANEL_PERSIST_KEY);
    return value === 'true' ? true : value === 'false' ? false : undefined;
  } catch {
    return undefined;
  }
}

/** 只有与进行中 attempt 身份一致的服务端进度才可用于恢复页面与可达性。 */
function matchingInitialProgress(
  attempt: AttemptSummary | null,
  progress: AttemptProgress | null,
): AttemptProgress | null {
  if (
    attempt?.status !== 'in_progress' ||
    progress === null ||
    progress.attemptId !== attempt.attemptId ||
    progress.selectionId !== attempt.selectionId ||
    progress.moduleVersionId !== attempt.moduleVersionId
  ) {
    return null;
  }
  return progress;
}

function initialReachDeckPageId(
  orderedPages: ReachDeckPublishedPage[],
  attempt: AttemptSummary | null,
  initialProgress: AttemptProgress | null,
): string | undefined {
  const progress = matchingInitialProgress(attempt, initialProgress);
  if (progress === null) {
    return orderedPages[0]?.pageId;
  }
  const pageIds = new Set(orderedPages.map((page) => page.pageId));
  if (progress.firstIncompletePageId !== null && pageIds.has(progress.firstIncompletePageId)) {
    return progress.firstIncompletePageId;
  }
  const completedPageIds = new Set(progress.completedPageIds);
  return (
    orderedPages.find((page) => !completedPageIds.has(page.pageId))?.pageId ??
    orderedPages[0]?.pageId
  );
}

function restoreCompletedLearningFences(
  value: unknown,
  ordinaryScope: Record<string, string>,
): StudentDeckLearningFence[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const threads = (value as { threads?: unknown }).threads;
  if (!Array.isArray(threads)) return [];
  const fences: StudentDeckLearningFence[] = [];
  for (const candidate of threads) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
    const thread = candidate as { createdAt?: unknown; domainScope?: unknown; updatedAt?: unknown };
    if (
      typeof thread.domainScope !== 'object' ||
      thread.domainScope === null ||
      Array.isArray(thread.domainScope)
    ) {
      continue;
    }
    const scope = thread.domainScope as Record<string, unknown>;
    const matchingAttemptScope = Object.entries(ordinaryScope).every(
      ([key, expected]) => key === 'tutorDomain' || scope[key] === expected,
    );
    if (scope.tutorDomain !== 'learning_fence' || !matchingAttemptScope) {
      continue;
    }
    if (
      typeof scope.attemptId !== 'string' ||
      typeof scope.fenceId !== 'string' ||
      typeof scope.pageId !== 'string' ||
      typeof scope.questionId !== 'string' ||
      typeof scope.sceneId !== 'string' ||
      typeof thread.createdAt !== 'string' ||
      typeof thread.updatedAt !== 'string' ||
      thread.createdAt === thread.updatedAt
    ) {
      continue;
    }
    const activatedAt =
      typeof thread.createdAt === 'string' && !Number.isNaN(Date.parse(thread.createdAt))
        ? thread.createdAt
        : new Date(0).toISOString();
    fences.push({
      activatedAt,
      attemptId: scope.attemptId,
      fenceId: scope.fenceId,
      pageId: scope.pageId,
      questionId: scope.questionId,
      sceneId: scope.sceneId,
      status: 'active',
    });
  }
  return fences.sort((left, right) => left.activatedAt.localeCompare(right.activatedAt));
}

function upsertLearningFence(
  current: StudentDeckLearningFence[],
  fence: StudentDeckLearningFence,
): StudentDeckLearningFence[] {
  return mergeLearningFences(current, [fence]);
}

function mergeLearningFences(
  current: StudentDeckLearningFence[],
  incoming: StudentDeckLearningFence[],
): StudentDeckLearningFence[] {
  const byId = new Map(current.map((fence) => [fence.fenceId, fence]));
  for (const fence of incoming) byId.set(fence.fenceId, fence);
  return [...byId.values()].sort((left, right) =>
    left.activatedAt.localeCompare(right.activatedAt),
  );
}

/** 服务端已判定不可用的模块：只解释原因，不提供任何绕过入口。 */
function LockedModuleGate({ item }: { item: StudentReachDeckRailItem }) {
  const { t } = usePortalI18n();

  return (
    <section className={styles.futureGate}>
      <span className="grid size-14 place-items-center rounded-pill bg-surface-muted text-fg-secondary">
        <CalendarClock size={26} />
      </span>
      <div>
        <div className="text-caption font-bold uppercase text-fg-tertiary">
          {t('reachDeck.studentWorkspace.lockedModule')}
        </div>
        <h2 className="mt-2 text-title-md font-bold text-fg">{item.moduleTitle}</h2>
        <p className="mt-2 text-body text-fg-secondary">
          {item.courseName} ·{' '}
          {formatSchedule(item.scheduledAt, t('reachDeck.studentWorkspace.unscheduled'))}
        </p>
        <p className="mx-auto mt-4 max-w-md text-body leading-6 text-fg-secondary">
          {t(
            item.unavailableReason === 'sequential_locked'
              ? 'reachDeck.studentWorkspace.sequentialLocked'
              : 'reachDeck.studentWorkspace.moduleUnavailable',
          )}
        </p>
      </div>
    </section>
  );
}

function formatSchedule(value: string | null, unscheduled: string): string {
  if (value === null) return unscheduled;
  const [date, time] = value.split('T');
  if (!date || !time) return value;
  return `${date.slice(5)} ${time.slice(0, 5)}`;
}
