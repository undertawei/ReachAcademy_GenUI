'use client';

import { useLearningVisit } from '@/src/components/student/LearningVisitProvider';
import {
  getCurrentLearningVisit,
  withLearningVisit,
  type LearningRequestInit,
} from '@/src/lib/learning-visit';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Flag, Maximize2, Minimize2, NotebookPen } from 'lucide-react';

import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import {
  ReachDeckPlayer,
  ReachDeckAutoAdvanceToggle,
  isRuntimeStateForPage,
  type QuizAnswerUploadedAsset,
  type QuizGradingByQuestionId,
  type QuizGradingView,
  type ReachDeckPlayerActivity,
  type ReachDeckPlayerEvent,
  type ReachDeckNarrationLearnerIntent,
  type ReachDeckRuntimeByPageId,
  type ReachDeckSceneRuntimeState,
} from '@reachany/reach-deck-player';
import { BrandLoader, Button } from '@reachany/ui';

import {
  type AppendAttemptEventInput,
  type AttemptResponse,
  type AttemptProgress,
  type CompleteInteractivePageInput,
  type NarrationEventInput,
  parseActiveStudentDeckLearningFence,
  parseAttemptResponse,
  parseAttemptProgress,
  parseStudentDeckPageRuntime,
  parseStudentDeckWhiteboardList,
  type StudentDeckPageCommandInput,
  type StudentDeckPageRuntime,
  type StudentDeckLearningFence,
} from '@/src/lib/public-v2-reach-deck-client';
import {
  InteractiveLearningEventQueue,
  type QueuedInteractiveLearningEvent,
} from '@/src/lib/interactive-learning-event-queue';
import type { PortalTranslator } from '@/src/lib/i18n';
import { ReachDeckNarrationOutbox } from '@/src/lib/reach-deck-narration-outbox';
import {
  hydrateReachDeckRuntimeImages,
  serializeReachDeckRuntimeState,
} from '@/src/lib/reach-deck-runtime-images';
import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import { calculateStudentNativePlayerMaxWidth } from '@/src/lib/reach-deck-stage-fit';
import {
  narrationCovered,
  reachDeckSlideNarrationLengths,
  type NarrationCoverageEvent,
} from '@/src/lib/reach-deck-narration-coverage';
import {
  isStudentReachDeckPageNavigable,
  reachDeckPageCompletesOnEntry,
  resolveStudentReachDeckNavigationLock,
  resolveStudentReachDeckPageAccess,
  type StudentReachDeckNavigationState,
} from '@/src/lib/student-reach-deck-page-access';

import { useStudentLearningRailRefresh } from '@/src/components/student/StudentLearningPage';
import { useVisibleSerialRefresh } from '@/src/components/student/useVisibleSerialRefresh';

import {
  StudentReachDeckCompletionDialog,
  type StudentReachDeckCompletionCheck,
} from './StudentReachDeckCompletionDialog';
import { StudentDeckNarratorAvatar } from './StudentDeckNarratorAvatar';
import {
  StudentReachDeckWhiteboard,
  studentDeckWhiteboardCollectionUrl,
  type StudentDeckAttachmentUrlResolver,
  type StudentDeckWhiteboardDock,
} from './StudentReachDeckWhiteboard';
import { ControlledMarkdownContent } from './tutor-rich-text-adapter';

export interface StudentReachDeckAttemptPlayerProps {
  activePageId?: string;
  attempt: AttemptResponse;
  document: ReachDeckDocument;
  /** 学习页全屏（隐藏应用页头与返回栏）；入口在控制条最右侧，由工作台持有状态。 */
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
  initialProgress?: AttemptProgress | null;
  learningFence?: StudentDeckLearningFence | null;
  learningFenceResolved?: boolean;
  onLearningFenceChange?: (fence: StudentDeckLearningFence | null) => void;
  onLearningFenceRefreshStart?: () => void;
  /** The fence refresh begun by `onLearningFenceRefreshStart` failed; the host offers recovery. */
  onLearningFenceRefreshFailed?: (attemptId: string) => void;
  /** v2 原生媒体展示地址（resourceId → 短时签名 URL）。 */
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  nativeMediaScopeKey?: string;
  onNativeMediaError?: (resourceId: string, failedSrc: string) => void;
  onNativeMediaLoaded?: (resourceId: string, src: string) => void;
  onNativeMediaPlayingChange?: (resourceId: string, playing: boolean) => void;
  onPageChange?: (page: ReachDeckPublishedPage) => void;
  /** 白板编辑画布打开/关闭（覆盖播放列、锁定翻页）；只展开笔记列表不上报。 */
  onWhiteboardEditingChange?: (editing: boolean) => void;
  /** 页面可达性与护栏批阅锁的唯一来源；卸载时上报 null。 */
  onNavigationStateChange?: (state: StudentReachDeckNavigationState | null) => void;
  onTutorActivityChange?: (context: StudentReachDeckTutorActivityContext) => void;
  onTutorAvailabilityChange?: (locked: boolean) => void;
  onLearningEventDeliveryFailure?: (failure: {
    count: number;
    eventName: string;
    reason: 'overflow' | 'rejected' | 'retry_exhausted';
  }) => void;
}

export interface StudentReachDeckTutorActivityContext {
  attemptId: string;
  moduleVersionId: string;
  selectionId: string;
  activity: ReachDeckPlayerActivity;
}

interface EventMappingContext {
  document: ReachDeckDocument;
  event: ReachDeckPlayerEvent;
  eventId: string;
  occurredAt: string;
}

type AuthoritativeQueueItem =
  | { kind: 'event'; input: AppendAttemptEventInput; learningVisitId?: string | null }
  | {
      kind: 'interactiveComplete';
      input: CompleteInteractivePageInput;
      learningVisitId?: string | null;
    };

interface RuntimeDomainOperation {
  commandType: Extract<
    StudentDeckPageCommandInput['commandType'],
    'asset_attached' | 'asset_removed' | 'asset_reordered'
  >;
  metadata: StudentDeckPageCommandInput['metadata'];
}

interface QueuedRuntimeCommand {
  learningVisitId: string | null;
  commandType: StudentDeckPageCommandInput['commandType'];
  eventId: string;
  keepalive: boolean;
  metadata: StudentDeckPageCommandInput['metadata'];
  occurredAt: string;
  pageId: string;
  sceneId: string;
  sourceRevision: number;
  state: Record<string, unknown>;
}

interface GeometryRuntimeConflict {
  authoritativeRevision: number;
  authoritativeState: ReachDeckSceneRuntimeState;
  localState: ReachDeckSceneRuntimeState;
  pageId: string;
}

// 在线心跳间隔:课堂看板"在线"口径为最近 ~90s 内有活动,60s 间隔留出网络余量。
const PRESENCE_INTERVAL_MS = 60_000;
// AI 批阅轮询：有题目处于 grading 时每 3 秒重读所在页运行时；失败按倍数退避到 30 秒。
const GRADING_POLL_INTERVAL_MS = 3_000;
const GRADING_POLL_MAX_INTERVAL_MS = 30_000;

type ServerGradingByPage = Readonly<Record<string, QuizGradingByQuestionId>>;

interface GradingRetryUiState {
  retrying?: boolean;
  message?: string;
  /** The server refused with `retry_limit_reached`; the retry action stays disabled. */
  exhausted?: boolean;
}

class ReachDeckUserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReachDeckUserFacingError';
  }
}

function userFacingErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ReachDeckUserFacingError ? error.message : fallback;
}

export function StudentReachDeckAttemptPlayer({
  activePageId,
  attempt: initialAttempt,
  document,
  fullscreen = false,
  onFullscreenChange,
  initialProgress = null,
  learningFence = null,
  learningFenceResolved = true,
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
  onTutorActivityChange,
  onTutorAvailabilityChange,
  onLearningEventDeliveryFailure,
}: StudentReachDeckAttemptPlayerProps) {
  const { t, locale } = usePortalI18n();
  const [attemptStatus, setAttemptStatus] = useState<AttemptResponse['status']>(
    initialProgress?.status ?? initialAttempt.status,
  );
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  /*
   * 本次进入时还在学、随后在服务端完成：顺序学门禁下下一模块此刻才解锁，
   * 刷新一次模块链，返回栏「下一模块」与收尾弹窗就能直接去下一站。
   */
  const refreshLearningRail = useStudentLearningRailRefresh();
  const completedDuringVisitRef = useRef(attemptStatus !== 'in_progress');
  useEffect(() => {
    if (attemptStatus !== 'completed' || completedDuringVisitRef.current) return;
    completedDuringVisitRef.current = true;
    void refreshLearningRail?.();
  }, [attemptStatus, refreshLearningRail]);
  const [failedEvent, setFailedEvent] = useState<AuthoritativeQueueItem | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeReloadKey, setRuntimeReloadKey] = useState(0);
  const [runtimeLoadError, setRuntimeLoadError] = useState<string | null>(null);
  const [initialRuntime, setInitialRuntime] = useState<ReachDeckRuntimeByPageId>({});
  const [masteredFenceQuestions, setMasteredFenceQuestions] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [serverGrading, setServerGrading] = useState<ServerGradingByPage>({});
  const [gradingRetryUi, setGradingRetryUi] = useState<
    Readonly<Record<string, Readonly<Record<string, GradingRetryUiState>>>>
  >({});
  const gradingRetryUiRef = useRef(gradingRetryUi);
  gradingRetryUiRef.current = gradingRetryUi;
  const [gradingGateNotice, setGradingGateNotice] = useState<string | null>(null);
  // Bumped on every refused page entry so the resend effect re-arms even when no grading state
  // changed (e.g. the refresh of the blocking page failed).
  const [deferredPageEnterTick, setDeferredPageEnterTick] = useState(0);
  // Submitted questions per page whose question_submit command is stuck in a failed runtime queue.
  const [unsyncedSubmissionsByPage, setUnsyncedSubmissionsByPage] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  // Submitted questions per page whose question_submit the server has not confirmed yet. The quiz
  // player keeps no memory across page switches, so these stay pending in the projection we pass.
  const [submittingByPage, setSubmittingByPage] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [completionAwaitingGrading, setCompletionAwaitingGrading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeSyncing, setRuntimeSyncing] = useState(false);
  const [runtimeHasSaved, setRuntimeHasSaved] = useState(false);
  const [runtimeConflicts, setRuntimeConflicts] = useState<
    Readonly<Record<string, GeometryRuntimeConflict>>
  >({});
  const [runtimePlayerKey, setRuntimePlayerKey] = useState(0);
  const [currentPageId, setCurrentPageId] = useState(
    activePageId ?? [...document.pages].sort((left, right) => left.order - right.order)[0]?.pageId,
  );
  const [completedPageIds, setCompletedPageIds] = useState<ReadonlySet<string>>(
    () => new Set(initialProgress?.completedPageIds ?? []),
  );
  // 有讲稿的幻灯片要讲稿正常播放覆盖 90% 才算学完（服务端按讲稿事件判定）。本次访问里上报过的讲稿事件
  // 记在这里，按同一算法本地即时判定，下一页不用等服务端往返就解锁。
  const narrationLengths = useMemo(() => reachDeckSlideNarrationLengths(document), [document]);
  const narratedSlidePageIds = useMemo(() => new Set(narrationLengths.keys()), [narrationLengths]);
  const narrationLogRef = useRef(new Map<string, NarrationCoverageEvent[]>());
  const [locallyCoveredPageIds, setLocallyCoveredPageIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markNarrationCoverage = useCallback(
    (pageId: string, livePositionMs?: number) => {
      const lengthMs = narrationLengths.get(pageId);
      if (lengthMs === undefined) return;
      const events = narrationLogRef.current.get(pageId) ?? [];
      // 正在播放的一段还没收口：按当前位置临时收口一次，播到 90% 时就解锁，不等播完。
      const evaluated =
        livePositionMs === undefined
          ? events
          : [
              ...events,
              {
                eventType: 'narration_pause' as const,
                metadata: { positionMs: livePositionMs },
                occurredAtMs: Date.now(),
              },
            ];
      if (!narrationCovered(evaluated, lengthMs)) return;
      setLocallyCoveredPageIds((current) =>
        current.has(pageId) ? current : new Set(current).add(pageId),
      );
    },
    [narrationLengths],
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  // 自动播放（#804）：默认开启，进入页面即播讲稿，幻灯片播完自动翻页；GenUI 讲稿播完与测验页停下。
  const [autoPlay, setAutoPlay] = useState(true);
  const [nativePlayerMaxWidth, setNativePlayerMaxWidth] = useState<number>();
  // 学习笔记：入口在控制条右侧；notesOpen 只是展开上浮列表（不暂停、不锁翻页），
  // whiteboardEditing 是从列表进入的编辑画布（覆盖播放列，暂停播放并锁定翻页）。
  const [notesOpen, setNotesOpen] = useState(false);
  // 最后一页「完成学习」后的恭喜弹窗；只是收尾提示，完成与否由服务端按学习行为判定。
  const [completionDialogOpen, setCompletionDialogOpen] = useState(false);
  const [completionCheck, setCompletionCheck] = useState<{
    identity: object;
    state: StudentReachDeckCompletionCheck;
    progress: AttemptProgress | null;
  } | null>(null);
  const [completionCheckRetry, setCompletionCheckRetry] = useState(0);
  const completionCheckControllerRef = useRef<AbortController | null>(null);
  const confirmedCompletedIdentityRef = useRef<object | null>(null);
  const [whiteboardEditing, setWhiteboardEditing] = useState(false);
  const [notesDock, setNotesDock] = useState<StudentDeckWhiteboardDock>();
  const [noteCountByPage, setNoteCountByPage] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    onWhiteboardEditingChange?.(whiteboardEditing);
  }, [onWhiteboardEditingChange, whiteboardEditing]);
  useLearningVisit(
    { selectionId: initialAttempt.selectionId },
    runtimeReady && document.pages.length > 0,
    playing && !whiteboardEditing,
  );
  const playerColumnRef = useRef<HTMLDivElement>(null);
  const playerShellRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<AuthoritativeQueueItem[]>([]);
  const processingRef = useRef<Promise<boolean> | null>(null);
  const failedEventRef = useRef<AuthoritativeQueueItem | null>(null);
  const completedInteractivePagesRef = useRef(new Set<string>());
  const learningClientOrderRef = useRef(0);
  const learningFailureCountRef = useRef(0);
  const learningEventDeliveryFailureRef = useRef(onLearningEventDeliveryFailure);
  const learningEventQueueRef = useRef<InteractiveLearningEventQueue | null>(null);
  const narrationOutboxRef = useRef<ReachDeckNarrationOutbox | null>(null);
  const narrationDeliveryRejectedRef = useRef(false);
  const completionRequestedRef = useRef(
    (initialProgress?.status ?? initialAttempt.status) !== 'in_progress',
  );
  const terminalAttemptRef = useRef(completionRequestedRef.current);
  const runtimeRef = useRef<ReachDeckRuntimeByPageId>({});
  const runtimeRevisionRef = useRef<Record<string, number>>({});
  const serverGradingRef = useRef<ServerGradingByPage>({});
  const appliedRevisionRef = useRef<Record<string, number>>({});
  const deferredPageEnterRef = useRef<Record<string, StudentDeckPageCommandInput['metadata']>>({});
  const deferredPageEnterRefusalsRef = useRef(0);
  const deferredPageEnterSawGradingRef = useRef(false);
  const runtimePendingRef = useRef<Record<string, QueuedRuntimeCommand[]>>({});
  const runtimeQueueRef = useRef<Record<string, Promise<void>>>({});
  const runtimeTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const runtimeConflictsRef = useRef<Record<string, GeometryRuntimeConflict>>({});
  const pendingGeometryPageEnterRef = useRef<
    Record<string, StudentDeckPageCommandInput['metadata']>
  >({});
  const queuedGeometryPageEnterRef = useRef(new Set<string>());
  const suppressRuntimePageEnterRef = useRef<string | null>(null);
  const currentPageIdRef = useRef(currentPageId);
  const whiteboardReturnPlayingRef = useRef(false);
  const playingRef = useRef(false);
  const documentRef = useRef(document);
  const previousLearningFenceRef = useRef(learningFence);
  const resolvedFencePageRef = useRef<string | null>(null);
  learningEventDeliveryFailureRef.current = onLearningEventDeliveryFailure;
  const activeNativeStage =
    document.schemaVersion === 'reach-deck-document/v2' ? document.stage : undefined;

  const updateTutorAvailability = useCallback(
    (pageId: string | undefined, state?: ReachDeckSceneRuntimeState) => {
      const page = document.pages.find((candidate) => candidate.pageId === pageId);
      if (page?.sceneType !== 'quiz') {
        onTutorAvailabilityChange?.(false);
        return;
      }
      const submitted = state?.kind === 'quiz' ? state.submitted : undefined;
      const question =
        page.scene.content.questions.find((candidate) => submitted?.[candidate.id] !== true) ??
        page.scene.content.questions[0];
      const answered = question !== undefined && submitted?.[question.id] === true;
      const fenced = question?.learning_fence?.enabled === true;
      const runtimeFence =
        state?.kind === 'quiz'
          ? (state as unknown as { learningFence?: { status?: string; questionId?: string } })
              .learningFence
          : undefined;
      const activeFence =
        runtimeFence?.status === 'active' && runtimeFence.questionId === question?.id;
      // A fenced answer still being AI-graded, or whose grading failed and can be retried, may
      // yet activate the fence; keep Tutor locked.
      const fenceGradingStatus =
        fenced && question !== undefined
          ? serverGradingRef.current[page.pageId]?.[question.id]?.status
          : undefined;
      const fenceGrading = fenceGradingStatus === 'grading' || fenceGradingStatus === 'failed';
      onTutorAvailabilityChange?.(
        !(answered && (!fenced || (!activeFence && !fenceGrading && learningFence === null))),
      );
    },
    [document, learningFence, onTutorAvailabilityChange],
  );

  useEffect(() => {
    updateTutorAvailability(currentPageId, runtimeRef.current[currentPageId ?? '']);
  }, [currentPageId, runtimeReady, updateTutorAvailability]);

  /*
   * 幻灯片 16:9 拟合：字幕与控制条沉在播放列底部，幻灯片只占它们上方的剩余区域
   * （渲染器节点，flex:1）。按这块区域的宽高算出视口宽度，通过共享播放器的 nativeSlideMaxWidth 传入。
   *
   * 渲染器节点不能只在 currentPageId 变化时查一次：播放器内翻页（下一页 / 自动播放翻页）先回调
   * onPageChange 改 currentPageId，此时播放器仍停在旧页，要等外层把 activePageId 传回来才
   * 渲染幻灯片。从题目 / GenUI 页翻到幻灯片时，查询那一刻还没有渲染器，之后也不会再查，
   * 变量一直缺失，幻灯片按满宽渲染、高度溢出压住字幕（宽屏比例下最明显）。
   * 所以用 MutationObserver 跟踪渲染器节点的出现与替换，并把 ResizeObserver 换绑到当前节点。
   */
  useLayoutEffect(() => {
    const shell = playerShellRef.current;
    if (activeNativeStage === undefined || shell === null) {
      setNativePlayerMaxWidth(undefined);
      return;
    }
    let slot: HTMLElement | null = null;
    const measure = () => {
      if (slot === null) {
        setNativePlayerMaxWidth(undefined);
        return;
      }
      const next = calculateStudentNativePlayerMaxWidth({
        availableHeight: slot.clientHeight,
        availableWidth: slot.clientWidth,
        shellExtraHeight: 0,
        shellExtraWidth: 0,
        stageHeight: activeNativeStage.height,
        stageWidth: activeNativeStage.width,
      });
      setNativePlayerMaxWidth((current) =>
        next === undefined || current === undefined || Math.abs(current - next) >= 1
          ? next
          : current,
      );
    };
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    const bindSlot = () => {
      const next = shell.querySelector<HTMLElement>('[data-native-v2-slide-renderer]');
      if (next === slot) return;
      if (slot !== null) resizeObserver?.unobserve(slot);
      slot = next;
      if (slot !== null) resizeObserver?.observe(slot);
      measure();
    };
    bindSlot();
    measure();
    const mutationObserver =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(bindSlot);
    mutationObserver?.observe(shell, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeNativeStage, currentPageId, runtimeReady]);
  const runtimeDocumentKey = useMemo(
    () => JSON.stringify(document.pages.map((page) => [page.pageId, page.revision])),
    [document.pages],
  );
  const immutableIdentity = useMemo(
    () => ({
      attemptId: initialAttempt.attemptId,
      moduleVersionId: initialAttempt.moduleVersionId,
      selectionId: initialAttempt.selectionId,
    }),
    [initialAttempt.attemptId, initialAttempt.moduleVersionId, initialAttempt.selectionId],
  );
  const [progressRefreshNeededFor, setProgressRefreshNeededFor] = useState<object | null>(null);
  const completedPageIdsRef = useRef(completedPageIds);
  completedPageIdsRef.current = completedPageIds;
  const reconcileAttemptStatus = useCallback((status: AttemptResponse['status']) => {
    if (status !== 'in_progress') {
      terminalAttemptRef.current = true;
      completionRequestedRef.current = true;
      queueRef.current.length = 0;
      failedEventRef.current = null;
      for (const timer of Object.values(runtimeTimerRef.current)) clearTimeout(timer);
      runtimeTimerRef.current = {};
      runtimePendingRef.current = {};
      runtimeQueueRef.current = {};
      setSubmittingByPage({});
      setUnsyncedSubmissionsByPage({});
      setPendingCount(0);
      setFailedEvent(null);
      setCompletionError(null);
      setRuntimeError(null);
      setRuntimeSyncing(false);
      setSyncing(false);
    }
    setAttemptStatus((current) =>
      current === 'completed' || current === 'abandoned' ? current : status,
    );
  }, []);
  const applyAttemptProgress = useCallback(
    (progress: AttemptProgress) => {
      if (
        progress.attemptId !== immutableIdentity.attemptId ||
        progress.selectionId !== immutableIdentity.selectionId ||
        progress.moduleVersionId !== immutableIdentity.moduleVersionId
      ) {
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.responseMismatch'));
      }
      setCompletedPageIds((completed) => {
        const merged = new Set(completed);
        for (const pageId of progress.completedPageIds) merged.add(pageId);
        return merged.size === completed.size ? completed : merged;
      });
      if (progress.status === 'completed')
        confirmedCompletedIdentityRef.current = immutableIdentity;
      setCompletionCheck((current) =>
        current?.identity === immutableIdentity && current.state.status === 'ready'
          ? { ...current, progress }
          : current,
      );
      reconcileAttemptStatus(progress.status);
      return progress;
    },
    [immutableIdentity, reconcileAttemptStatus, t],
  );
  const refreshAttemptProgressRef = useRef<(() => Promise<unknown>) | null>(null);
  const progressLifecycle = useMemo(
    () => ({
      active: false,
      readSequence: 0,
      successfulRead: 0,
      latestProgress: null as AttemptProgress | null,
    }),
    [immutableIdentity],
  );
  useLayoutEffect(() => {
    progressLifecycle.active = true;
    return () => {
      progressLifecycle.active = false;
    };
  }, [progressLifecycle]);
  const refreshAttemptProgress = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++progressLifecycle.readSequence;
      const isCurrent = () => progressLifecycle.active && signal?.aborted !== true;
      try {
        const progress = parseAttemptProgress(
          await requestJson<unknown>(
            `/api/student/reach-deck/attempts/${encodeURIComponent(immutableIdentity.attemptId)}/progress`,
            { cache: 'no-store', method: 'GET', ...(signal === undefined ? {} : { signal }) },
            t,
            t('reachDeck.attempt.requestUnavailable'),
          ),
        );
        // A previous attempt's read may finish after this player changed identity or unmounted.
        if (!isCurrent()) return progress;
        // Both state updates and callers awaiting this read must retain the newest successful
        // snapshot. An older success must not replace a newer finish-dialog confirmation.
        if (sequence < progressLifecycle.successfulRead && progressLifecycle.latestProgress)
          return progressLifecycle.latestProgress;
        const applied = applyAttemptProgress(progress);
        progressLifecycle.successfulRead = sequence;
        progressLifecycle.latestProgress = applied;
        if (sequence === progressLifecycle.readSequence) setProgressRefreshNeededFor(null);
        return applied;
      } catch (error) {
        // A late failure must not undo a newer successful confirmation.
        if (isCurrent() && sequence > progressLifecycle.successfulRead)
          setProgressRefreshNeededFor(immutableIdentity);
        throw error;
      }
    },
    [applyAttemptProgress, immutableIdentity, progressLifecycle, t],
  );
  const readAttemptProgress = useCallback(
    async (isCurrent: () => boolean, signal: AbortSignal) => {
      if (!isCurrent()) return;
      try {
        await refreshAttemptProgress(signal);
      } catch (error) {
        if (error instanceof PageRuntimeRequestError && [401, 403, 404].includes(error.status))
          return false;
        throw error;
      }
    },
    [refreshAttemptProgress],
  );
  const refreshVisibleProgress = useVisibleSerialRefresh({
    enabled:
      attemptStatus === 'in_progress' &&
      (progressRefreshNeededFor === immutableIdentity ||
        [...locallyCoveredPageIds].some((pageId) => !completedPageIds.has(pageId))),
    identity: immutableIdentity,
    onRefresh: readAttemptProgress,
  });
  refreshAttemptProgressRef.current = refreshVisibleProgress;
  if (learningEventQueueRef.current === null) {
    learningEventQueueRef.current = new InteractiveLearningEventQueue({
      onDrop: (eventName, reason) => {
        learningFailureCountRef.current += 1;
        learningEventDeliveryFailureRef.current?.({
          count: learningFailureCountRef.current,
          eventName,
          reason,
        });
      },
      send: (input, keepalive, learningVisitId) =>
        fetch(
          `/api/student/reach-deck/attempts/${immutableIdentity.attemptId}/interactive-learning-events`,
          withLearningVisit({
            learningVisitId: learningVisitId ?? null,
            body: JSON.stringify(input),
            headers: { 'Content-Type': 'application/json' },
            keepalive,
            method: 'POST',
          }),
        ),
    });
  }

  useEffect(() => {
    const flush = () => learningEventQueueRef.current?.flushOnUnload();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  useEffect(() => {
    narrationDeliveryRejectedRef.current = false;
    const outbox = new ReachDeckNarrationOutbox({
      attemptId: immutableIdentity.attemptId,
      getVisitId: () =>
        getCurrentLearningVisit({ selectionId: immutableIdentity.selectionId })?.visitId ?? null,
      onFailure: (eventName, reason) => {
        if (reason === 'rejected' || reason === 'overflow')
          narrationDeliveryRejectedRef.current = true;
        learningFailureCountRef.current += 1;
        learningEventDeliveryFailureRef.current?.({
          count: learningFailureCountRef.current,
          eventName,
          reason,
        });
      },
      send: async (input, keepalive, learningVisitId) => {
        const response = await fetch(
          `/api/student/reach-deck/attempts/${immutableIdentity.attemptId}/narration-events`,
          withLearningVisit({
            learningVisitId: learningVisitId ?? null,
            body: JSON.stringify(input),
            headers: { 'Content-Type': 'application/json' },
            keepalive,
            method: 'POST',
          }),
        );
        // 讲稿播放收口送达后，服务端可能已把这页判为学完：刷新一次进度（发完成、解锁以服务端为准）。
        if (
          response.ok &&
          !keepalive &&
          input.events.some(
            (event) =>
              event.eventType === 'narration_pause' || event.eventType === 'narration_seek',
          )
        ) {
          void refreshAttemptProgressRef.current?.().catch(() => undefined);
        }
        return {
          body: await response
            .clone()
            .json()
            .catch(() => null),
          status: response.status,
        };
      },
      storage: window.localStorage,
    });
    narrationOutboxRef.current = outbox;
    const drain = () => void outbox.drain();
    const flush = () => outbox.flushOnPageHide();
    window.addEventListener('online', drain);
    window.addEventListener('pagehide', flush);
    drain();
    return () => {
      window.removeEventListener('online', drain);
      window.removeEventListener('pagehide', flush);
      flush();
      // 不清空引用：React 卸载时父组件清理先于子组件，播放器随后收口播放区间的暂停事件仍要入这个 outbox
      // （入队即落盘并普通发送；attempt 变化时由 setup 的赋值直接替换）。
    };
  }, [immutableIdentity.attemptId]);
  const refreshLearningFence = useCallback(async () => {
    onLearningFenceRefreshStart?.();
    let value: ReturnType<typeof parseActiveStudentDeckLearningFence>;
    try {
      value = parseActiveStudentDeckLearningFence(
        await requestJson<unknown>(
          `/api/student/reach-deck/attempts/${encodeURIComponent(initialAttempt.attemptId)}/learning-fence`,
          { cache: 'no-store', method: 'GET' },
          t,
        ),
      );
    } catch (error) {
      // The host locked navigation when the refresh began; let it offer a retry instead of
      // waiting for a resolution that callers swallowing this error would never deliver.
      onLearningFenceRefreshFailed?.(initialAttempt.attemptId);
      throw error;
    }
    onLearningFenceChange?.(value.fence);
    return value.fence;
  }, [
    initialAttempt.attemptId,
    onLearningFenceChange,
    onLearningFenceRefreshFailed,
    onLearningFenceRefreshStart,
    t,
  ]);

  const recordFenceMastery = useCallback(
    (pageId: string, state: Record<string, unknown>, grading: QuizGradingByQuestionId) => {
      const fence = state.learningFence;
      const activeQuestionId =
        typeof fence === 'object' &&
        fence !== null &&
        (fence as Record<string, unknown>).status === 'active'
          ? (fence as Record<string, unknown>).questionId
          : undefined;
      if (state.kind !== 'quiz' || typeof state.submitted !== 'object' || state.submitted === null)
        return;
      // Submitted flags are accepted only from server-confirmed question_submit commands. A
      // question still being graded, or whose grading failed and can be retried, cannot be
      // mastered yet: its server result may activate a fence.
      const questionIds = Object.entries(state.submitted)
        .filter(
          ([id, submitted]) =>
            submitted === true &&
            id !== activeQuestionId &&
            grading[id]?.status !== 'grading' &&
            grading[id]?.status !== 'failed',
        )
        .map(([id]) => id);
      setMasteredFenceQuestions((current) => {
        const existing = current[pageId] ?? [];
        return existing.length === questionIds.length &&
          existing.every((id) => questionIds.includes(id))
          ? current
          : { ...current, [pageId]: questionIds };
      });
    },
    [],
  );

  /**
   * Applies a server page runtime: the authoritative `serverGrading` projection and fence mastery.
   * Returns the question ids whose grading just left `grading` (graded or failed).
   */
  const applyServerRuntime = useCallback(
    (pageId: string, state: Record<string, unknown>, revision: number): string[] => {
      // Overlapping reads (poll vs. command/retry responses) must not roll the projection back.
      if (revision < (appliedRevisionRef.current[pageId] ?? -1)) return [];
      appliedRevisionRef.current[pageId] = revision;
      const previous = serverGradingRef.current[pageId] ?? {};
      const next = parseServerGrading(state);
      recordFenceMastery(pageId, state, next);
      const settled = Object.entries(previous)
        .filter(([id, entry]) => entry.status === 'grading' && next[id]?.status !== 'grading')
        .map(([id]) => id);
      if (!serverGradingEqual(previous, next)) {
        serverGradingRef.current = { ...serverGradingRef.current, [pageId]: next };
        setServerGrading(serverGradingRef.current);
        // A retry message only belongs to a failed entry; drop it once the entry moves on.
        setGradingRetryUi((current) => {
          const page = current[pageId];
          if (page === undefined) return current;
          const kept = Object.fromEntries(
            Object.entries(page).filter(([id]) => {
              const entry = next[id];
              return entry !== undefined && gradingRetryable(entry);
            }),
          );
          return Object.keys(kept).length === Object.keys(page).length
            ? current
            : { ...current, [pageId]: kept };
        });
      }
      return settled;
    },
    [recordFenceMastery],
  );

  /** Adopts a newer server revision unless a command for the page is in flight. */
  const adoptServerRevision = useCallback((pageId: string, revision: number) => {
    if (runtimeQueueRef.current[pageId] !== undefined) return;
    if (revision > (runtimeRevisionRef.current[pageId] ?? 0)) {
      runtimeRevisionRef.current[pageId] = revision;
    }
  }, []);

  const refreshResolvedFence = useCallback(async () => {
    const page = documentRef.current.pages.find(
      (candidate) => candidate.pageId === resolvedFencePageRef.current,
    );
    if (page === undefined) return;
    const runtime = await getPageRuntime(initialAttempt.attemptId, page, t);
    adoptServerRevision(page.pageId, runtime.revision);
    applyServerRuntime(page.pageId, runtime.state, runtime.revision);
    await refreshAttemptProgress();
    resolvedFencePageRef.current = null;
  }, [
    adoptServerRevision,
    applyServerRuntime,
    initialAttempt.attemptId,
    refreshAttemptProgress,
    t,
  ]);

  useEffect(() => {
    if (!learningFenceResolved) return;
    const previous = previousLearningFenceRef.current;
    previousLearningFenceRef.current = learningFence;
    if (previous === null || learningFence !== null) return;
    resolvedFencePageRef.current = previous.pageId;
    void refreshResolvedFence().catch(() =>
      setRuntimeError(t('reachDeck.attempt.runtimeRestoreFailed')),
    );
  }, [learningFence, learningFenceResolved, refreshResolvedFence, t]);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    if (activePageId === undefined) return;
    currentPageIdRef.current = activePageId;
    setCurrentPageId(activePageId);
  }, [activePageId]);

  useEffect(() => {
    let cancelled = false;
    const runtimeDocument = documentRef.current;
    setRuntimeReady(false);
    setRuntimeLoadError(null);
    void Promise.all(
      runtimeDocument.pages.map(async (page) => {
        const runtime = await getPageRuntime(initialAttempt.attemptId, page, t);
        applyServerRuntime(page.pageId, runtime.state, runtime.revision);
        runtimeRevisionRef.current[page.pageId] = runtime.revision;
        if (Object.keys(runtime.state).length === 0) return null;
        const state = (await hydrateReachDeckRuntimeImages(runtime.state, async (reference) => {
          const ticket = await requestJson<{ downloadUrl: string }>(
            assetRoute(
              initialAttempt.attemptId,
              page.pageId,
              reference.questionId,
              'presign-download',
            ),
            {
              body: JSON.stringify({
                assetId: reference.assetId,
                objectKey: reference.objectKey,
                disposition: 'inline',
              }),
              headers: { 'Content-Type': 'application/json' },
              method: 'POST',
            },
            t,
            t('reachDeck.attempt.runtimeRestoreFailed'),
          );
          return ticket.downloadUrl;
        })) as unknown as ReachDeckSceneRuntimeState;
        return page.sceneType !== 'slide' && isRuntimeStateForPage(state, page)
          ? ([page.pageId, state] as const)
          : null;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        const restored = Object.fromEntries(
          entries.filter(
            (entry): entry is readonly [string, ReachDeckSceneRuntimeState] => entry !== null,
          ),
        );
        runtimeRef.current = restored;
        setInitialRuntime(restored);
        setRuntimeReady(true);
        // Reloads may restore submissions newer than the SSR progress snapshot. Confirm their
        // authoritative coverage once; failed reads use the same bounded visible-page retry.
        const restoredQuizNeedsProgress = runtimeDocument.pages.some((page) => {
          if (page.sceneType !== 'quiz' || completedPageIdsRef.current.has(page.pageId))
            return false;
          const submitted = (restored[page.pageId] as { submitted?: Record<string, boolean> })
            ?.submitted;
          return (
            page.scene.content.questions.length > 0 &&
            page.scene.content.questions.every((question) => submitted?.[question.id] === true)
          );
        });
        if (restoredQuizNeedsProgress && !terminalAttemptRef.current)
          void refreshVisibleProgress().catch(() => undefined);
      })
      .catch((error) => {
        if (cancelled) return;
        setRuntimeLoadError(
          userFacingErrorMessage(error, t('reachDeck.attempt.runtimeRestoreFailed')),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    initialAttempt.attemptId,
    applyServerRuntime,
    refreshVisibleProgress,
    runtimeDocumentKey,
    runtimeReloadKey,
    t,
  ]);

  const replacePlayerRuntime = useCallback((pageId: string, state: ReachDeckSceneRuntimeState) => {
    runtimeRef.current = { ...runtimeRef.current, [pageId]: state };
    setInitialRuntime(runtimeRef.current);
    suppressRuntimePageEnterRef.current = currentPageIdRef.current ?? null;
    setRuntimePlayerKey((value) => value + 1);
  }, []);

  const setGeometryRuntimeConflict = useCallback(
    (conflict: GeometryRuntimeConflict | null, pageId: string) => {
      const next = { ...runtimeConflictsRef.current };
      if (conflict === null) delete next[pageId];
      else next[pageId] = conflict;
      runtimeConflictsRef.current = next;
      setRuntimeConflicts(next);
    },
    [],
  );

  const processRuntimeQueue = useCallback(
    (pageId: string): Promise<void> => {
      const active = runtimeQueueRef.current[pageId];
      if (active) return active;
      const pending = runtimePendingRef.current[pageId];
      if (!pending || pending.length === 0) return Promise.resolve();
      if (terminalAttemptRef.current) {
        pending.length = 0;
        delete runtimePendingRef.current[pageId];
        return Promise.resolve();
      }
      setRuntimeSyncing(true);
      // This page's queued submissions are in flight again; the run's end records what still fails.
      setUnsyncedSubmissionsByPage((current) => withPageIds(current, pageId, []));
      let processing: Promise<void>;
      processing = (async () => {
        while (pending.length > 0) {
          if (terminalAttemptRef.current) {
            pending.length = 0;
            break;
          }
          const command = pending[0]!;
          const input = (): StudentDeckPageCommandInput => ({
            commandType: command.commandType,
            eventId: command.eventId,
            expectedRevision: runtimeRevisionRef.current[pageId] ?? 0,
            metadata: command.metadata,
            occurredAt: command.occurredAt,
            sceneId: command.sceneId,
            sourceRevision: command.sourceRevision,
            state: command.state,
          });
          try {
            const saved = await postPageCommand(
              initialAttempt.attemptId,
              pageId,
              input(),
              t,
              command.keepalive,
              command.learningVisitId,
            );
            runtimeRevisionRef.current[pageId] = saved.revision;
            applyServerRuntime(pageId, saved.state, saved.revision);
            setRuntimeHasSaved(true);
            const confirmedQuestionId = command.metadata.questionId;
            if (
              command.commandType === 'question_submit' &&
              typeof confirmedQuestionId === 'string'
            ) {
              // The server projection now owns this question's grading state.
              setSubmittingByPage((current) =>
                withPageIds(
                  current,
                  pageId,
                  (current[pageId] ?? []).filter((id) => id !== confirmedQuestionId),
                ),
              );
            }
          } catch (error) {
            if (terminalAttemptRef.current) {
              pending.length = 0;
              break;
            }
            if (
              error instanceof PageRuntimeRequestError &&
              error.status === 409 &&
              error.reason === 'grading_pending_fence' &&
              command.commandType === 'page_enter'
            ) {
              // A fenced question elsewhere is still being AI-graded; the server refuses to
              // record entering this page. Keep the learner informed and resend once it settles,
              // even if the learner has moved on to another page meanwhile.
              deferredPageEnterRef.current[pageId] = command.metadata;
              deferredPageEnterRefusalsRef.current += 1;
              setDeferredPageEnterTick((tick) => tick + 1);
              setGradingGateNotice(t('reachDeck.attempt.gradingPendingNavigation'));
              const blockingPageId = error.data.pageId;
              if (typeof blockingPageId === 'string') {
                void refreshGradingPagesRef.current([blockingPageId]).catch(() => undefined);
              }
              pending.shift();
              continue;
            }
            if (!(error instanceof PageRuntimeRequestError) || error.status !== 409) throw error;
            const page = documentRef.current.pages.find((candidate) => candidate.pageId === pageId);
            if (page === undefined) throw error;
            const current = await getPageRuntime(initialAttempt.attemptId, page, t);
            runtimeRevisionRef.current[pageId] = current.revision;
            if (!geometryAuxiliaryGraphsEqual(command.state, current.state)) {
              const authoritativeState = runtimeStateForPage(current.state, page, t);
              const localState = runtimeStateForPage(
                runtimeRef.current[pageId] ?? pending.at(-1)?.state ?? command.state,
                page,
                t,
              );
              const timer = runtimeTimerRef.current[pageId];
              if (timer !== undefined) {
                clearTimeout(timer);
                delete runtimeTimerRef.current[pageId];
              }
              pending.splice(0, pending.length);
              setRuntimeError(null);
              setGeometryRuntimeConflict(
                {
                  authoritativeRevision: current.revision,
                  authoritativeState,
                  localState,
                  pageId,
                },
                pageId,
              );
              replacePlayerRuntime(pageId, authoritativeState);
              return;
            }
            const saved = await postPageCommand(
              initialAttempt.attemptId,
              pageId,
              input(),
              t,
              command.keepalive,
              command.learningVisitId,
            );
            runtimeRevisionRef.current[pageId] = saved.revision;
            applyServerRuntime(pageId, saved.state, saved.revision);
            setRuntimeHasSaved(true);
          }
          // The server has confirmed the command; a failed follow-up refresh below must not leave
          // it queued, or it would be reported unsynced and resent by the save retry.
          pending.shift();
          if (terminalAttemptRef.current) {
            pending.length = 0;
            break;
          }
          if (command.commandType === 'page_enter') {
            deferredPageEnterRefusalsRef.current = 0;
            if (
              pageCountsAsCompleteOnEntry(
                documentRef.current,
                pageId,
                new Set(reachDeckSlideNarrationLengths(documentRef.current).keys()),
              )
            ) {
              setCompletedPageIds((completed) =>
                completed.has(pageId) ? completed : new Set(completed).add(pageId),
              );
            }
            await refreshAttemptProgress().catch(() => undefined);
          }
          if (command.commandType === 'question_submit') {
            await refreshLearningFence();
            await refreshAttemptProgress();
            updateTutorAvailability(pageId, runtimeRef.current[pageId]);
          }
          setRuntimeError(null);
        }
      })()
        .catch((error) => {
          if (terminalAttemptRef.current) return;
          setRuntimeError(userFacingErrorMessage(error, t('reachDeck.attempt.runtimeSaveFailed')));
          void refreshAttemptProgress().catch(() => undefined);
          throw error;
        })
        .finally(() => {
          if (runtimeQueueRef.current[pageId] === processing) {
            delete runtimeQueueRef.current[pageId];
          }
          // Submissions still queued after the run failed never reached the server, so the
          // player must offer the save retry instead of waiting for a grading result forever.
          const unsynced = pending.flatMap((queued) =>
            queued.commandType === 'question_submit' &&
            typeof queued.metadata.questionId === 'string'
              ? [queued.metadata.questionId]
              : [],
          );
          setUnsyncedSubmissionsByPage((current) => withPageIds(current, pageId, unsynced));
          setSubmittingByPage((current) => withPageIds(current, pageId, unsynced));
          if (pending.length === 0) delete runtimePendingRef.current[pageId];
          if (Object.keys(runtimeQueueRef.current).length === 0) setRuntimeSyncing(false);
        });
      runtimeQueueRef.current[pageId] = processing;
      return processing;
    },
    [
      initialAttempt.attemptId,
      refreshAttemptProgress,
      refreshLearningFence,
      applyServerRuntime,
      replacePlayerRuntime,
      setGeometryRuntimeConflict,
      t,
      updateTutorAvailability,
    ],
  );

  const enqueueRuntimeCommand = useCallback(
    (
      pageId: string,
      state: ReachDeckSceneRuntimeState | Record<string, unknown>,
      commandType: StudentDeckPageCommandInput['commandType'],
      metadata: StudentDeckPageCommandInput['metadata'] = {},
      keepalive = false,
    ): Promise<void> => {
      const page = documentRef.current.pages.find((candidate) => candidate.pageId === pageId);
      if (
        !page ||
        terminalAttemptRef.current ||
        attemptStatus !== 'in_progress' ||
        runtimeConflictsRef.current[pageId] !== undefined
      ) {
        return Promise.resolve();
      }
      const pending = runtimePendingRef.current[pageId] ?? [];
      pending.push({
        learningVisitId:
          getCurrentLearningVisit({ selectionId: immutableIdentity.selectionId })?.visitId ?? null,
        commandType,
        eventId: globalThis.crypto.randomUUID(),
        keepalive,
        metadata,
        occurredAt: new Date().toISOString(),
        pageId,
        sceneId: pageSceneIdentity(page),
        sourceRevision: page.revision,
        state: serializeReachDeckRuntimeState(state as unknown as Record<string, unknown>),
      });
      runtimePendingRef.current[pageId] = pending;
      const submittedQuestionId = metadata.questionId;
      if (commandType === 'question_submit' && typeof submittedQuestionId === 'string') {
        setSubmittingByPage((current) =>
          current[pageId]?.includes(submittedQuestionId) === true
            ? current
            : withPageIds(current, pageId, [...(current[pageId] ?? []), submittedQuestionId]),
        );
      }
      return processRuntimeQueue(pageId);
    },
    [attemptStatus, processRuntimeQueue],
  );

  const scheduleRuntimeAutosave = useCallback(
    (pageId: string, state: ReachDeckSceneRuntimeState) => {
      if (terminalAttemptRef.current || runtimeConflictsRef.current[pageId] !== undefined) return;
      const previous = runtimeRef.current[pageId];
      runtimeRef.current = { ...runtimeRef.current, [pageId]: state };
      const existing = runtimeTimerRef.current[pageId];
      if (existing !== undefined) clearTimeout(existing);
      const pendingPageEnter = pendingGeometryPageEnterRef.current[pageId];
      const page = documentRef.current.pages.find((candidate) => candidate.pageId === pageId);
      if (page !== undefined && pageHasV2Geometry(page) && !hasGeometryHostStateV2(state)) {
        delete runtimeTimerRef.current[pageId];
        return;
      }
      if (
        pendingPageEnter !== undefined &&
        page !== undefined &&
        pageHasV2Geometry(page) &&
        hasGeometryHostStateV2(state) &&
        !queuedGeometryPageEnterRef.current.has(pageId)
      ) {
        delete runtimeTimerRef.current[pageId];
        delete pendingGeometryPageEnterRef.current[pageId];
        queuedGeometryPageEnterRef.current.add(pageId);
        void enqueueRuntimeCommand(pageId, state, 'page_enter', pendingPageEnter).catch(
          () => undefined,
        );
        return;
      }
      const operations = runtimeDomainOperations(previous, state);
      if (operations.length > 0) {
        delete runtimeTimerRef.current[pageId];
        for (const operation of operations) {
          void enqueueRuntimeCommand(
            pageId,
            state,
            operation.commandType,
            operation.metadata,
          ).catch(() => undefined);
        }
        return;
      }
      runtimeTimerRef.current[pageId] = setTimeout(() => {
        delete runtimeTimerRef.current[pageId];
        if (terminalAttemptRef.current) return;
        void enqueueRuntimeCommand(
          pageId,
          state,
          'runtime_autosave',
          runtimeAutosaveMetadata(previous, state),
        ).catch(() => undefined);
      }, 500);
    },
    [enqueueRuntimeCommand],
  );

  const flushRuntimePage = useCallback(
    async (
      pageId: string,
      commandType: StudentDeckPageCommandInput['commandType'] = 'runtime_autosave',
      metadata: StudentDeckPageCommandInput['metadata'] = {},
      keepalive = false,
    ) => {
      const timer = runtimeTimerRef.current[pageId];
      if (timer !== undefined) {
        clearTimeout(timer);
        delete runtimeTimerRef.current[pageId];
      }
      const page = documentRef.current.pages.find((candidate) => candidate.pageId === pageId);
      const state =
        runtimeRef.current[pageId] ??
        (commandType === 'page_leave' && page ? pageBehaviorState(page) : undefined);
      if (state !== undefined && runtimeConflictsRef.current[pageId] === undefined) {
        void enqueueRuntimeCommand(pageId, state, commandType, metadata, keepalive);
      }
      await processRuntimeQueue(pageId);
    },
    [enqueueRuntimeCommand, processRuntimeQueue],
  );

  const flushScheduledRuntime = useCallback(
    async (keepalive = false) => {
      const scheduledPageIds = Object.keys(runtimeTimerRef.current);
      await Promise.all(
        scheduledPageIds.map((pageId) =>
          flushRuntimePage(pageId, 'runtime_autosave', {}, keepalive),
        ),
      );
    },
    [flushRuntimePage],
  );

  useEffect(() => {
    const flushForLifecycle = () => {
      void flushScheduledRuntime(true).catch(() => undefined);
    };
    const handleVisibilityChange = () => {
      if (window.document.visibilityState === 'hidden') flushForLifecycle();
    };
    window.document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', flushForLifecycle);
    return () => {
      window.document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', flushForLifecycle);
      flushForLifecycle();
    };
  }, [flushScheduledRuntime]);

  // 在线心跳:页签可见且 attempt 进行中时周期上报,使教师课堂看板的"在线"口径
  // 覆盖纯浏览无互动的页面停留。失败静默丢弃,不重试、不阻塞学习事件队列。
  useEffect(() => {
    if (attemptStatus !== 'in_progress') return;
    let cancelled = false;
    const ping = () => {
      if (cancelled || window.document.visibilityState !== 'visible') return;
      void fetch(
        `/api/student/reach-deck/attempts/${immutableIdentity.attemptId}/presence`,
        withLearningVisit(
          {
            method: 'POST',
          },
          { selectionId: immutableIdentity.selectionId },
        ),
      ).catch(() => undefined);
    };
    ping();
    const interval = window.setInterval(ping, PRESENCE_INTERVAL_MS);
    const handlePresenceVisibility = () => {
      if (window.document.visibilityState === 'visible') ping();
    };
    window.document.addEventListener('visibilitychange', handlePresenceVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.document.removeEventListener('visibilitychange', handlePresenceVisibility);
    };
  }, [attemptStatus, immutableIdentity.attemptId]);

  const flushAllRuntime = useCallback(async () => {
    const pageIds = new Set([
      ...Object.keys(runtimeRef.current),
      ...Object.keys(runtimePendingRef.current),
      ...Object.keys(runtimeQueueRef.current),
    ]);
    await Promise.all([...pageIds].map((pageId) => flushRuntimePage(pageId)));
  }, [flushRuntimePage]);

  const uploadQuizAnswerAsset = useCallback(
    async (
      file: File,
      context: { kind: 'attachment' | 'inline_image'; pageId: string; questionId: string },
    ): Promise<QuizAnswerUploadedAsset> => {
      const learningVisitId =
        getCurrentLearningVisit({ selectionId: immutableIdentity.selectionId })?.visitId ?? null;
      const body = new FormData();
      body.set('file', file);
      body.set('kind', context.kind);
      return requestJson<QuizAnswerUploadedAsset>(
        assetRoute(initialAttempt.attemptId, context.pageId, context.questionId, 'upload'),
        {
          learningVisitId,
          body,
          method: 'POST',
        },
        t,
      );
    },
    [initialAttempt.attemptId, immutableIdentity.selectionId, t],
  );

  const processQueue = useCallback((): Promise<boolean> => {
    if (processingRef.current !== null) return processingRef.current;
    const processing = (async () => {
      setSyncing(true);
      while (queueRef.current.length > 0) {
        if (terminalAttemptRef.current) {
          queueRef.current.length = 0;
          setPendingCount(0);
          return true;
        }
        const input = queueRef.current[0];
        if (input === undefined) break;
        try {
          const updated =
            input.kind === 'event'
              ? await postAttemptEvent(
                  immutableIdentity,
                  input.input,
                  t,
                  input.learningVisitId ?? null,
                )
              : await postInteractivePageComplete(
                  immutableIdentity,
                  input.input,
                  t,
                  input.learningVisitId ?? null,
                );
          reconcileAttemptStatus(updated.status);
          if (input.kind === 'interactiveComplete') {
            setCompletedPageIds((completed) =>
              completed.has(input.input.pageId)
                ? completed
                : new Set(completed).add(input.input.pageId),
            );
            await refreshAttemptProgress().catch(() => undefined);
          }
          queueRef.current.shift();
          setPendingCount(queueRef.current.length);
          failedEventRef.current = null;
          setFailedEvent(null);
        } catch {
          if (terminalAttemptRef.current) {
            queueRef.current.length = 0;
            setPendingCount(0);
            return true;
          }
          failedEventRef.current = input;
          setFailedEvent(input);
          return false;
        }
      }
      return true;
    })().finally(() => {
      processingRef.current = null;
      setSyncing(false);
    });
    processingRef.current = processing;
    return processing;
  }, [immutableIdentity, reconcileAttemptStatus, refreshAttemptProgress, t]);

  const handlePlayerEvent = useCallback(
    (event: ReachDeckPlayerEvent) => {
      if (completionRequestedRef.current || attemptStatus !== 'in_progress') return;
      if (event.type === 'pageEnter' && suppressRuntimePageEnterRef.current === event.pageId) {
        suppressRuntimePageEnterRef.current = null;
        return;
      }
      if (event.type === 'interactiveLearningEvent') {
        const page = document.pages.find((candidate) => candidate.pageId === event.pageId);
        if (page?.sceneType !== 'interactive') return;
        const declaration = page.scene.eventManifest.events.find(
          (candidate) => candidate.name === event.eventName,
        );
        if (declaration === undefined) return;
        learningClientOrderRef.current += 1;
        learningEventQueueRef.current?.enqueue({
          learningVisitId:
            getCurrentLearningVisit({ selectionId: immutableIdentity.selectionId })?.visitId ??
            null,
          clientOrder: learningClientOrderRef.current,
          deliveryMode: declaration.delivery.mode,
          eventId: globalThis.crypto.randomUUID(),
          eventName: event.eventName,
          eventVersion: event.eventVersion,
          occurredAt: new Date().toISOString(),
          pageId: event.pageId,
          payload: event.payload,
          sceneId: event.sceneId,
          sourceRevision: event.revision,
        } satisfies QueuedInteractiveLearningEvent);
        return;
      }
      if (event.type === 'interactiveComplete') {
        const page = document.pages.find((candidate) => candidate.pageId === event.pageId);
        if (
          page?.sceneType !== 'interactive' ||
          page.scene.runtimePolicy.completionMode === 'none' ||
          completedInteractivePagesRef.current.has(page.pageId)
        ) {
          return;
        }
        completedInteractivePagesRef.current.add(page.pageId);
        const input: AuthoritativeQueueItem = {
          learningVisitId:
            getCurrentLearningVisit({ selectionId: immutableIdentity.selectionId })?.visitId ??
            null,
          kind: 'interactiveComplete',
          input: {
            occurredAt: new Date().toISOString(),
            pageId: page.pageId,
            progressEventId: globalThis.crypto.randomUUID(),
            resultEventId: globalThis.crypto.randomUUID(),
            sceneId: pageSceneIdentity(page),
            sourceRevision: page.revision,
          },
        };
        queueRef.current.push(input);
        setPendingCount(queueRef.current.length);
        if (failedEventRef.current === null) void processQueue();
        return;
      }
      if (event.type === 'pageEnter') {
        const page = document.pages.find((candidate) => candidate.pageId === event.pageId);
        if (page) {
          const state = runtimeRef.current[event.pageId];
          if (!pageHasV2Geometry(page)) {
            void enqueueRuntimeCommand(
              event.pageId,
              state ?? pageBehaviorState(page),
              'page_enter',
              { sceneType: event.sceneType },
            ).catch(() => undefined);
          } else if (!queuedGeometryPageEnterRef.current.has(event.pageId)) {
            if (hasGeometryHostStateV2(state)) {
              queuedGeometryPageEnterRef.current.add(event.pageId);
              void enqueueRuntimeCommand(event.pageId, state, 'page_enter', {
                sceneType: event.sceneType,
              }).catch(() => undefined);
            } else if (pendingGeometryPageEnterRef.current[event.pageId] === undefined) {
              pendingGeometryPageEnterRef.current[event.pageId] = {
                sceneType: event.sceneType,
              };
            }
          }
        }
      }
      const mapped = mapReachDeckPlayerEvent({
        document,
        event,
        eventId: globalThis.crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
      });
      if (mapped !== null) {
        queueRef.current.push({
          kind: 'event',
          input: mapped,
          learningVisitId:
            getCurrentLearningVisit({ selectionId: immutableIdentity.selectionId })?.visitId ??
            null,
        });
        setPendingCount(queueRef.current.length);
        if (failedEventRef.current === null) void processQueue();
      }
      if (event.type === 'quizSubmit') {
        setTimeout(() => {
          void flushRuntimePage(event.pageId, 'question_submit', {
            questionId: event.questionId,
          }).catch(() => undefined);
        }, 0);
      }
    },
    [
      attemptStatus,
      document,
      enqueueRuntimeCommand,
      flushRuntimePage,
      processQueue,
      updateTutorAvailability,
    ],
  );

  const handleNarrationLearnerIntent = useCallback(
    (intent: ReachDeckNarrationLearnerIntent) => {
      if (completionRequestedRef.current || attemptStatus !== 'in_progress') return;
      const occurredAt = new Date();
      const event = toNarrationEventInput(
        intent,
        globalThis.crypto.randomUUID(),
        occurredAt.toISOString(),
      );
      const outbox = narrationOutboxRef.current;
      if (outbox?.enqueue(event) === false) narrationDeliveryRejectedRef.current = true;
      // 页面卸载时播放器才收口的一段：outbox 自己的 pagehide 冲刷可能已先跑，补一次 keepalive（eventId 幂等）。
      if (intent.type === 'narration_pause' && intent.pageHide === true) outbox?.flushOnPageHide();
      if (narrationLengths.has(intent.pageId)) {
        const log = narrationLogRef.current.get(intent.pageId) ?? [];
        log.push({
          eventType: event.eventType,
          metadata: event.metadata,
          occurredAtMs: occurredAt.getTime(),
        });
        narrationLogRef.current.set(intent.pageId, log);
        markNarrationCoverage(intent.pageId);
      }
    },
    [attemptStatus, markNarrationCoverage, narrationLengths],
  );

  // 播放中跟随位置判定：本页讲稿正常播放到 90% 即本地视为学完。
  useEffect(() => {
    if (!playing || currentPageId === undefined || attemptStatus !== 'in_progress') return;
    if (!narrationLengths.has(currentPageId) || locallyCoveredPageIds.has(currentPageId)) return;
    markNarrationCoverage(currentPageId, Math.round(currentTime * 1000));
  }, [
    attemptStatus,
    currentPageId,
    currentTime,
    locallyCoveredPageIds,
    markNarrationCoverage,
    narrationLengths,
    playing,
  ]);

  const retryFailedEvent = useCallback(async () => {
    if (attemptStatus !== 'in_progress') return;
    failedEventRef.current = null;
    setFailedEvent(null);
    // If auto-completion was waiting on this sync, allow the completion effect to
    // resume after the queue drains instead of requiring a second manual retry.
    setCompletionError(null);
    await processQueue();
  }, [attemptStatus, processQueue]);

  const retryRuntimeSave = useCallback(async () => {
    setRuntimeError(null);
    try {
      await Promise.all(Object.keys(runtimePendingRef.current).map(processRuntimeQueue));
      await refreshResolvedFence();
      await refreshAttemptProgress();
    } catch {
      setRuntimeError(t('reachDeck.attempt.runtimeSaveFailed'));
    }
  }, [processRuntimeQueue, refreshAttemptProgress, refreshResolvedFence, t]);

  const useAuthoritativeGeometryState = useCallback(
    (conflict: GeometryRuntimeConflict) => {
      runtimeRevisionRef.current[conflict.pageId] = conflict.authoritativeRevision;
      setGeometryRuntimeConflict(null, conflict.pageId);
      setRuntimeError(null);
      setRuntimeHasSaved(true);
    },
    [setGeometryRuntimeConflict],
  );

  const restoreLocalGeometryState = useCallback(
    async (conflict: GeometryRuntimeConflict) => {
      runtimeRevisionRef.current[conflict.pageId] = conflict.authoritativeRevision;
      setGeometryRuntimeConflict(null, conflict.pageId);
      replacePlayerRuntime(conflict.pageId, conflict.localState);
      await enqueueRuntimeCommand(
        conflict.pageId,
        conflict.localState,
        'runtime_autosave',
        runtimeAutosaveMetadata(conflict.authoritativeState, conflict.localState),
      );
    },
    [enqueueRuntimeCommand, replacePlayerRuntime, setGeometryRuntimeConflict],
  );

  /**
   * Re-reads the given pages' runtimes for their server grading. When any question settles
   * (graded or failed), the fence, attempt progress and Tutor availability are refreshed.
   */
  const refreshGradingPages = useCallback(
    async (pageIds: readonly string[]): Promise<void> => {
      let settled = false;
      for (const pageId of pageIds) {
        const page = documentRef.current.pages.find((candidate) => candidate.pageId === pageId);
        if (page === undefined) continue;
        const runtime = await getPageRuntime(initialAttempt.attemptId, page, t);
        if (terminalAttemptRef.current) return;
        adoptServerRevision(pageId, runtime.revision);
        if (applyServerRuntime(pageId, runtime.state, runtime.revision).length > 0) settled = true;
      }
      if (!settled) return;
      await refreshLearningFence().catch(() => undefined);
      await refreshAttemptProgress().catch(() => undefined);
      const currentPageId = currentPageIdRef.current;
      updateTutorAvailability(currentPageId, runtimeRef.current[currentPageId ?? '']);
    },
    [
      adoptServerRevision,
      applyServerRuntime,
      initialAttempt.attemptId,
      refreshAttemptProgress,
      refreshLearningFence,
      t,
      updateTutorAvailability,
    ],
  );
  const refreshGradingPagesRef = useRef(refreshGradingPages);
  refreshGradingPagesRef.current = refreshGradingPages;

  const gradingPageKey = useMemo(
    () =>
      Object.entries(serverGrading)
        .filter(([, grading]) => Object.values(grading).some((entry) => entry.status === 'grading'))
        .map(([pageId]) => pageId)
        .sort()
        .join('\n'),
    [serverGrading],
  );
  const gradingPending = gradingPageKey.length > 0;

  // Poll only while some question is being AI-graded; stop when none remain, when the attempt
  // leaves in_progress, or on unmount. Failed reads back off instead of hammering the BFF.
  useEffect(() => {
    if (!runtimeReady || attemptStatus !== 'in_progress' || gradingPageKey.length === 0) return;
    const pageIds = gradingPageKey.split('\n');
    let cancelled = false;
    let delay = GRADING_POLL_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await refreshGradingPagesRef.current(pageIds);
        delay = GRADING_POLL_INTERVAL_MS;
      } catch {
        delay = Math.min(delay * 2, GRADING_POLL_MAX_INTERVAL_MS);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), delay);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [attemptStatus, gradingPageKey, runtimeReady]);

  // Completion that the server refused while grading resumes automatically once all settle.
  useEffect(() => {
    if (!gradingPending) setCompletionAwaitingGrading(false);
  }, [gradingPending]);

  /*
   * 答错的客观题成绩当场给出，AI 反馈后到（#804）：只轮询学生正在看的这一页，翻走就停，
   * 回到本页立即读一次。学习完成后反馈仍可能到达，所以不看 attempt 状态；只读本页运行时。
   */
  const feedbackRetryAvailable = Object.values(serverGrading).some((page) =>
    Object.values(page).some((entry) => entry.feedbackStatus === 'failed'),
  );
  const feedbackPollPageId =
    currentPageId !== undefined &&
    Object.values(serverGrading[currentPageId] ?? {}).some(
      (entry) => entry.feedbackStatus === 'grading',
    )
      ? currentPageId
      : undefined;
  useEffect(() => {
    if (!runtimeReady || feedbackPollPageId === undefined) return;
    const page = documentRef.current.pages.find(
      (candidate) => candidate.pageId === feedbackPollPageId,
    );
    if (page === undefined) return;
    let cancelled = false;
    let delay = GRADING_POLL_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const runtime = await getPageRuntime(initialAttempt.attemptId, page, t);
        if (cancelled) return;
        adoptServerRevision(feedbackPollPageId, runtime.revision);
        applyServerRuntime(feedbackPollPageId, runtime.state, runtime.revision);
        delay = GRADING_POLL_INTERVAL_MS;
      } catch {
        delay = Math.min(delay * 2, GRADING_POLL_MAX_INTERVAL_MS);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    adoptServerRevision,
    applyServerRuntime,
    feedbackPollPageId,
    initialAttempt.attemptId,
    runtimeReady,
    t,
  ]);

  const fencedGradingAnywhere = useMemo(
    () => hasFencedGradingAnywhere(document, serverGrading),
    [document, serverGrading],
  );
  // Page entries refused while a fenced question was grading are resent once no fenced grading is
  // known and no fence is active — for every refused page, including ones the learner has left,
  // so the visit is not lost. When the client never observed the blocking grading (e.g. refreshing
  // the blocking page failed), the resend backs off instead of waiting for a state change that may
  // never come; a renewed refusal simply defers it again.
  useEffect(() => {
    if (Object.keys(deferredPageEnterRef.current).length === 0) return;
    if (fencedGradingAnywhere) deferredPageEnterSawGradingRef.current = true;
    if (fencedGradingAnywhere || !learningFenceResolved || learningFence !== null) return;
    const refusals = Math.max(1, deferredPageEnterRefusalsRef.current);
    const delay = deferredPageEnterSawGradingRef.current
      ? 0
      : Math.min(GRADING_POLL_INTERVAL_MS * 2 ** (refusals - 1), GRADING_POLL_MAX_INTERVAL_MS);
    const timer = setTimeout(() => {
      if (terminalAttemptRef.current) return;
      const deferred = deferredPageEnterRef.current;
      deferredPageEnterRef.current = {};
      deferredPageEnterSawGradingRef.current = false;
      setGradingGateNotice(null);
      const currentPageId = currentPageIdRef.current;
      // The page the learner is on is entered last.
      const pageIds = Object.keys(deferred).sort(
        (left, right) => Number(left === currentPageId) - Number(right === currentPageId),
      );
      for (const pageId of pageIds) {
        const page = documentRef.current.pages.find((candidate) => candidate.pageId === pageId);
        if (page === undefined) continue;
        void enqueueRuntimeCommand(
          pageId,
          runtimeRef.current[pageId] ?? pageBehaviorState(page),
          'page_enter',
          deferred[pageId],
        ).catch(() => undefined);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [
    deferredPageEnterTick,
    enqueueRuntimeCommand,
    fencedGradingAnywhere,
    learningFence,
    learningFenceResolved,
  ]);

  const retryQuizGrading = useCallback(
    async (pageId: string, questionId: string) => {
      // 只补 AI 反馈的重试不改成绩，学习完成后仍可进行；其余重新批阅只在学习进行中。
      const feedbackOnly =
        serverGradingRef.current[pageId]?.[questionId]?.feedbackStatus === 'failed';
      if (terminalAttemptRef.current && !feedbackOnly) return;
      if (gradingRetryUiRef.current[pageId]?.[questionId]?.exhausted === true) return;
      const setRetryUi = (next: GradingRetryUiState | undefined) =>
        setGradingRetryUi((current) => {
          const page = { ...current[pageId] };
          if (next === undefined) delete page[questionId];
          else page[questionId] = next;
          return { ...current, [pageId]: page };
        });
      setRetryUi({ retrying: true });
      try {
        const runtime = parseStudentDeckPageRuntime(
          await requestJson<unknown>(
            gradingRetryRoute(initialAttempt.attemptId, pageId, questionId),
            {
              learningVisitId:
                getCurrentLearningVisit({ selectionId: immutableIdentity.selectionId })?.visitId ??
                null,
              method: 'POST',
            },
            t,
            t('reachDeck.grading.retryFailed'),
          ),
        );
        if (runtime.attemptId !== initialAttempt.attemptId || runtime.pageId !== pageId) {
          throw new ReachDeckUserFacingError(t('reachDeck.attempt.runtimeResponseMismatch'));
        }
        adoptServerRevision(pageId, runtime.revision);
        applyServerRuntime(pageId, runtime.state, runtime.revision);
        setRetryUi(undefined);
      } catch (error) {
        if (terminalAttemptRef.current && !feedbackOnly) return;
        // The player shows its own localized limit notice and keeps the action disabled.
        setRetryUi(
          error instanceof PageRuntimeRequestError && error.reason === 'retry_limit_reached'
            ? { exhausted: true }
            : { message: gradingRetryErrorMessage(error, t) },
        );
        if (error instanceof PageRuntimeRequestError && error.status === 409) {
          // The entry or attempt changed underneath us; resynchronize with the server.
          void refreshAttemptProgress().catch(() => undefined);
        }
        if (
          error instanceof PageRuntimeRequestError &&
          (error.reason === 'not_failed' ||
            error.reason === 'grading_not_found' ||
            error.reason === 'concurrent_update')
        ) {
          const page = documentRef.current.pages.find((candidate) => candidate.pageId === pageId);
          if (page !== undefined) {
            void getPageRuntime(initialAttempt.attemptId, page, t)
              .then((current) => {
                adoptServerRevision(pageId, current.revision);
                applyServerRuntime(pageId, current.state, current.revision);
              })
              .catch(() => undefined);
          }
        }
      }
    },
    [
      adoptServerRevision,
      applyServerRuntime,
      immutableIdentity.selectionId,
      initialAttempt.attemptId,
      refreshAttemptProgress,
      t,
    ],
  );

  const quizGradingByPageId = useMemo(() => {
    const merged: Record<string, QuizGradingByQuestionId> = { ...serverGrading };
    // A submission the server has not confirmed is still pending, even after the quiz player
    // remounts on page return; without an entry it would count as settled and reveal answers.
    // Only that page's own failed submissions are left to the unsynced notice instead: a save
    // failure elsewhere (the global runtime error) must not release this page's answers.
    for (const [pageId, questionIds] of Object.entries(submittingByPage)) {
      const unsynced = unsyncedSubmissionsByPage[pageId] ?? [];
      const page: Record<string, QuizGradingView> = { ...merged[pageId] };
      for (const questionId of questionIds) {
        if (!unsynced.includes(questionId)) page[questionId] ??= { status: 'grading', maxScore: 0 };
      }
      merged[pageId] = page;
    }
    for (const [pageId, questions] of Object.entries(gradingRetryUi)) {
      const page: Record<string, QuizGradingView> = { ...merged[pageId] };
      for (const [questionId, ui] of Object.entries(questions)) {
        const entry = page[questionId];
        if (entry === undefined || !gradingRetryable(entry)) continue;
        page[questionId] = {
          ...entry,
          ...(ui.retrying === true ? { retrying: true } : {}),
          ...(ui.message === undefined ? {} : { retryMessage: ui.message }),
          ...(ui.exhausted === true ? { retryExhausted: true } : {}),
        };
      }
      merged[pageId] = page;
    }
    return merged;
  }, [gradingRetryUi, serverGrading, submittingByPage, unsyncedSubmissionsByPage]);

  const renderGradingFeedback = useCallback(
    (markdown: string) => (
      <ControlledMarkdownContent
        ariaLabel={t('reachDeck.grading.feedbackAria')}
        emptyLabel={t('reachDeck.grading.feedbackEmpty')}
        markdown={markdown}
      />
    ),
    [t],
  );

  const whiteboardQuizGrading = useMemo(
    () => ({
      quizGradingByPageId,
      masteredLearningFenceQuestionIdsByPage: masteredFenceQuestions,
      renderQuizGradingFeedback: renderGradingFeedback,
    }),
    [masteredFenceQuestions, quizGradingByPageId, renderGradingFeedback],
  );

  const handleRetryQuizGrading = useCallback(
    (pageId: string, questionId: string) => void retryQuizGrading(pageId, questionId),
    [retryQuizGrading],
  );

  const complete = useCallback(async () => {
    if (attemptStatus === 'completed') return;
    if (failedEventRef.current !== null) return;
    completionRequestedRef.current = true;
    setCompleting(true);
    setCompletionError(null);
    try {
      const drained = await processQueue();
      if (!drained || queueRef.current.length > 0) {
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.retryPending'));
      }
      await flushAllRuntime();
      if (Object.keys(runtimeConflictsRef.current).length > 0)
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.geometryConflictPending'));
      if (runtimeError !== null)
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.runtimeRetryPending'));
      const updated = await postAttemptCompletion(immutableIdentity, t);
      if (updated.status !== 'completed') {
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.notCompleted'));
      }
      if (progressLifecycle.active) confirmedCompletedIdentityRef.current = immutableIdentity;
      reconcileAttemptStatus(updated.status);
    } catch (error) {
      await refreshAttemptProgress().catch(() => undefined);
      if (terminalAttemptRef.current) return;
      completionRequestedRef.current = false;
      if (error instanceof PageRuntimeRequestError && error.reason === 'grading_pending') {
        // The server is still grading somewhere: learn which pages, then wait for the poll to
        // settle them and let the auto-completion effect try again.
        const quizPageIds = documentRef.current.pages
          .filter((page) => page.sceneType === 'quiz')
          .map((page) => page.pageId);
        await refreshGradingPagesRef.current(quizPageIds).catch(() => undefined);
        if (hasPendingGrading(serverGradingRef.current)) {
          setCompletionAwaitingGrading(true);
          return;
        }
        setCompletionError(t('reachDeck.attempt.gradingPendingRetry'));
        return;
      }
      setCompletionError(userFacingErrorMessage(error, t('reachDeck.attempt.completeFailed')));
    } finally {
      setCompleting(false);
    }
  }, [
    attemptStatus,
    flushAllRuntime,
    immutableIdentity,
    processQueue,
    progressLifecycle,
    reconcileAttemptStatus,
    refreshAttemptProgress,
    runtimeError,
    t,
  ]);

  const changeCompletionDialogOpen = useCallback((open: boolean) => {
    completionCheckControllerRef.current?.abort();
    setCompletionCheck(null);
    // Let the child's playback effect close its narration interval before the confirmation
    // effect below drains the durable outbox. A click alone never submits completion.
    if (open) setPlaying(false);
    setCompletionDialogOpen(open);
  }, []);
  const retryCompletionCheck = useCallback(() => {
    completionCheckControllerRef.current?.abort();
    setCompletionCheck(null);
    setCompletionCheckRetry((retry) => retry + 1);
  }, []);
  const runCompletionCheckRef = useRef<
    (controller: AbortController, isCurrent: () => boolean) => Promise<void>
  >(async () => undefined);
  runCompletionCheckRef.current = async (controller, isCurrent) => {
    const previousCompletionError = completionError;
    try {
      const drained = await processQueue();
      if (!isCurrent()) return;
      if (!drained || queueRef.current.length > 0)
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.retryPending'));
      await flushAllRuntime();
      if (!isCurrent()) return;
      if (Object.keys(runtimeConflictsRef.current).length > 0)
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.geometryConflictPending'));
      if (Object.values(runtimePendingRef.current).some((pending) => pending.length > 0))
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.runtimeRetryPending'));
      setRuntimeError(null);
      const outbox = narrationOutboxRef.current;
      await outbox?.drain();
      if (!isCurrent()) return;
      if (outbox !== null && outbox.size > 0)
        throw new ReachDeckUserFacingError(t('reachDeck.completion.syncFailed'));
      const deliveryRejected = narrationDeliveryRejectedRef.current;
      narrationDeliveryRejectedRef.current = false;
      const progress = await refreshAttemptProgress(controller.signal);
      if (!isCurrent()) return;
      if (progress.status === 'abandoned')
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.unavailable'));
      // Report a new undeliverable record once, unless accepted evidence already proves coverage.
      // Historical parked records must not block later accepted playback or a completed attempt.
      if (deliveryRejected && progress.status !== 'completed' && !progress.coverageComplete)
        throw new ReachDeckUserFacingError(t('reachDeck.completion.syncFailed'));
      await refreshLearningRail?.({ throwOnError: true });
      if (!isCurrent()) return;
      // Another progress read may have succeeded while navigation was refreshing.
      const latestProgress = progressLifecycle.latestProgress ?? progress;
      if (latestProgress.status === 'abandoned')
        throw new ReachDeckUserFacingError(t('reachDeck.attempt.unavailable'));
      setCompletionCheck({
        identity: immutableIdentity,
        state: { status: 'ready' },
        progress: latestProgress,
      });
      // A failed automatic completion has an explicit retry latch. A fresh confirmation may
      // release it once the server confirms coverage; the existing effect still owns completion.
      if (latestProgress.coverageComplete && !completionRequestedRef.current)
        setCompletionError((current) => (current === previousCompletionError ? null : current));
    } catch (error) {
      if (!isCurrent()) return;
      setCompletionCheck({
        identity: immutableIdentity,
        state: {
          status: 'error',
          message: userFacingErrorMessage(error, t('reachDeck.completion.checkFailed')),
        },
        progress: null,
      });
    }
  };
  useEffect(() => {
    if (!completionDialogOpen) return;
    const controller = new AbortController();
    completionCheckControllerRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted && completionCheckControllerRef.current === controller;
    setCompletionCheck({
      identity: immutableIdentity,
      state: { status: 'checking' },
      progress: null,
    });
    void runCompletionCheckRef.current(controller, isCurrent);
    return () => controller.abort();
  }, [completionDialogOpen, completionCheckRetry, immutableIdentity]);

  const completed = attemptStatus === 'completed';
  const unavailable = attemptStatus === 'abandoned';
  const readOnly = completed || unavailable || completing;
  const currentRuntimeConflict =
    (currentPageId === undefined ? undefined : runtimeConflicts[currentPageId]) ??
    Object.values(runtimeConflicts)[0];
  const hasRuntimeConflicts = Object.keys(runtimeConflicts).length > 0;
  /*
   * 学完（completed）后播放器仍可翻页、播放、回看与编辑笔记：学习事件、运行态与心跳本就只在
   * in_progress 时写入，完成后自然不再上报。只有收尾中、尝试失效、护栏与运行态冲突才锁住播放器；
   * 私人白板与学习完成状态独立，重新批阅仍按 readOnly。
   */
  const interactionLocked =
    unavailable ||
    completing ||
    !learningFenceResolved ||
    learningFence !== null ||
    (currentPageId !== undefined && runtimeConflicts[currentPageId] !== undefined);
  const attachmentsReadable =
    completed &&
    !completing &&
    learningFenceResolved &&
    learningFence === null &&
    !hasRuntimeConflicts;

  const allPagesCompleted =
    document.pages.length > 0 && document.pages.every((page) => completedPageIds.has(page.pageId));

  /**
   * 学完最后一页即自动完成，学生不需要再点一次「完成学习」。仍然复用同一条
   * {@link complete} 路径，因此排队中的学习事件先落库再置完成态；某一步失败时
   * 只记错误并停在这里，等同步重试成功（依赖变化）后再自动重试一次。
   */
  useEffect(() => {
    if (!allPagesCompleted || !runtimeReady) return;
    if (attemptStatus !== 'in_progress') return;
    if (completing || completionRequestedRef.current) return;
    // A transient completion failure must wait for an explicit retry instead of
    // immediately re-firing the request on every render.
    if (completionError !== null) return;
    if (!learningFenceResolved || learningFence !== null) return;
    if (failedEvent !== null || runtimeError !== null || hasRuntimeConflicts) return;
    // Completion waits for every AI grading to settle (the server refuses it meanwhile).
    if (gradingPending || completionAwaitingGrading) return;
    void complete();
  }, [
    allPagesCompleted,
    completionAwaitingGrading,
    gradingPending,
    runtimeReady,
    attemptStatus,
    complete,
    completionError,
    completing,
    failedEvent,
    learningFence,
    learningFenceResolved,
    hasRuntimeConflicts,
    runtimeError,
  ]);
  const whiteboardPage = document.pages.find((page) => page.pageId === currentPageId);
  // Leaving a page whose fenced question is still being AI-graded is refused by the server
  // (`grading_pending_fence`), so the learner stays on it until the result arrives.
  const currentPageFencedGrading =
    currentPageId !== undefined &&
    pageHasFencedGrading(whiteboardPage, serverGrading[currentPageId]);
  const pageAccess = useMemo(
    () =>
      resolveStudentReachDeckPageAccess({
        attemptCompleted: attemptStatus === 'completed',
        completedPageIds: [...completedPageIds, ...locallyCoveredPageIds],
        currentPageId,
        narratedSlidePageIds,
        pages: document.pages,
      }),
    [
      attemptStatus,
      completedPageIds,
      currentPageId,
      document.pages,
      locallyCoveredPageIds,
      narratedSlidePageIds,
    ],
  );
  const navigationLock = resolveStudentReachDeckNavigationLock({
    currentPageFencedGrading,
    learningFenceActive: learningFence !== null,
    learningFenceResolved,
    whiteboardEditing,
  });
  // 还没学完的页（服务端确认或本地讲稿覆盖都不算数时）讲稿只能往回拖，向前最多到已正常播放到的位置。
  const restrictNarrationForwardSeek = useCallback(
    (page: ReachDeckPublishedPage) => !completed && !pageAccess.completedPageIds.has(page.pageId),
    [completed, pageAccess],
  );
  const narratorAvatar = useMemo(
    () => (
      <StudentDeckNarratorAvatar
        attemptId={initialAttempt.attemptId}
        moduleVersionId={initialAttempt.moduleVersionId}
        selectionId={initialAttempt.selectionId}
      />
    ),
    [initialAttempt.attemptId, initialAttempt.moduleVersionId, initialAttempt.selectionId],
  );
  const isPlayerPageNavigable = useCallback(
    (page: ReachDeckPublishedPage) => isStudentReachDeckPageNavigable(pageAccess, page.pageId),
    [pageAccess],
  );
  useEffect(() => {
    onNavigationStateChange?.({
      attemptId: initialAttempt.attemptId,
      currentPageFencedGrading,
      pageAccess,
    });
  }, [currentPageFencedGrading, initialAttempt.attemptId, onNavigationStateChange, pageAccess]);
  useEffect(() => () => onNavigationStateChange?.(null), [onNavigationStateChange]);
  const gradingNotice =
    attemptStatus !== 'in_progress'
      ? null
      : currentPageFencedGrading
        ? t('reachDeck.attempt.gradingPendingFence')
        : gradingGateNotice !== null
          ? gradingGateNotice
          : (allPagesCompleted && gradingPending) || completionAwaitingGrading
            ? t('reachDeck.attempt.gradingPendingCompletion')
            : null;

  // 保存/收尾完成只给一个状态点：进行中为橙色、已保存为绿色；出错与冲突仍走下方的提示条。
  const syncIndicator: StudentDeckSyncIndicator | null =
    currentRuntimeConflict !== undefined || runtimeError !== null
      ? null
      : completing || runtimeSyncing
        ? 'saving'
        : runtimeHasSaved
          ? 'saved'
          : null;

  const currentNoteCount = currentPageId === undefined ? 0 : (noteCountByPage[currentPageId] ?? 0);
  const orderedPages = useMemo(
    () => [...document.pages].sort((left, right) => left.order - right.order),
    [document.pages],
  );
  const confirmation = completionCheck?.identity === immutableIdentity ? completionCheck : null;
  const confirmedPageIds = new Set(confirmation?.progress?.completedPageIds ?? []);
  const learnedForCompletion = (page: ReachDeckPublishedPage) => confirmedPageIds.has(page.pageId);
  const firstIncompleteIndex = orderedPages.findIndex((page) => !learnedForCompletion(page));
  const completedPageCount = orderedPages.filter(learnedForCompletion).length;
  const toggleNotes = useCallback(() => setNotesOpen((open) => !open), []);
  const closeNotes = useCallback(() => setNotesOpen(false), []);
  // 编辑画布打开时暂停播放，关闭后恢复打开前的播放意图；只展开列表不打断播放。
  const changeWhiteboardEditing = useCallback((editing: boolean) => {
    setWhiteboardEditing((current) => {
      if (current === editing) return current;
      if (editing) {
        whiteboardReturnPlayingRef.current = playingRef.current;
        setPlaying(false);
      } else {
        setPlaying(whiteboardReturnPlayingRef.current);
      }
      return editing;
    });
  }, []);
  const recordNoteCount = useCallback(
    (count: number) => {
      if (currentPageId === undefined) return;
      setNoteCountByPage((current) =>
        current[currentPageId] === count ? current : { ...current, [currentPageId]: count },
      );
    },
    [currentPageId],
  );

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // 护栏激活或恢复中时不允许打开笔记；已展开的列表随之收起。
  useEffect(() => {
    if (interactionLocked && !whiteboardEditing) setNotesOpen(false);
  }, [interactionLocked, whiteboardEditing]);

  // 控制条入口显示当前页笔记数：列表未打开过的页单独取一次数量，之后由列表的增删上报。
  useEffect(() => {
    if (
      !runtimeReady ||
      interactionLocked ||
      currentPageId === undefined ||
      noteCountByPage[currentPageId] !== undefined
    ) {
      return;
    }
    const pageId = currentPageId;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          studentDeckWhiteboardCollectionUrl(initialAttempt.attemptId, pageId),
          { cache: 'no-store', signal: controller.signal },
        );
        if (!response.ok) return;
        const count = parseStudentDeckWhiteboardList(await response.json()).whiteboards.length;
        if (controller.signal.aborted) return;
        setNoteCountByPage((current) =>
          current[pageId] === undefined ? { ...current, [pageId]: count } : current,
        );
      } catch {
        // 取不到数量时入口显示 0；打开列表后由列表上报真实数量。
      }
    })();
    return () => controller.abort();
  }, [currentPageId, initialAttempt.attemptId, interactionLocked, noteCountByPage, runtimeReady]);

  // 上浮列表锚定在播放列（不滚动的定高容器）里：底边贴控制条上沿、横向与播放器对齐。
  // 依赖播放器稳定的 data hook（原生时间轴或题目/互动页控制条），不耦合样式类名。
  useLayoutEffect(() => {
    if (!notesOpen) return;
    const column = playerColumnRef.current;
    const shell = playerShellRef.current;
    if (column === null || shell === null) return;
    const measure = () => {
      const bar = shell.querySelector<HTMLElement>('[data-reach-deck-timeline]');
      const columnRect = column.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const anchorTop = bar?.getBoundingClientRect().top ?? shellRect.bottom;
      const next: StudentDeckWhiteboardDock = {
        bottom: Math.max(0, Math.round(columnRect.bottom - anchorTop)),
        left: Math.max(0, Math.round(shellRect.left - columnRect.left)),
        maxHeight: Math.max(0, Math.round(anchorTop - columnRect.top)),
        width: Math.round(shellRect.width),
      };
      setNotesDock((current) =>
        current !== undefined &&
        current.bottom === next.bottom &&
        current.left === next.left &&
        current.maxHeight === next.maxHeight &&
        current.width === next.width
          ? current
          : next,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(column);
    observer?.observe(shell);
    const bar = shell.querySelector<HTMLElement>('[data-reach-deck-timeline]');
    if (bar !== null) observer?.observe(bar);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [currentPageId, nativePlayerMaxWidth, notesOpen]);

  const resolveAttachmentUrl = useCallback<StudentDeckAttachmentUrlResolver>(
    async (ref, disposition, anchorAttemptId = initialAttempt.attemptId) => {
      const failure = t(
        disposition === 'attachment' ? 'attachment.downloadFailed' : 'attachment.loadFailed',
      );
      if (ref.questionId && ref.pageId) {
        const result = await requestJson<{
          downloadUrl: string;
          disposition: 'inline' | 'attachment';
          contentType?: string;
        }>(
          assetRoute(anchorAttemptId, ref.pageId, ref.questionId, 'presign-download'),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId: ref.assetId, objectKey: ref.objectKey, disposition }),
          },
          t,
          failure,
        );
        return {
          url: result.downloadUrl,
          disposition: result.disposition,
          contentType: result.contentType,
        };
      }
      const query = new URLSearchParams({ objectKey: ref.objectKey, disposition });
      const response = await fetch(
        `/api/student/reach-deck/track-modules/${encodeURIComponent(initialAttempt.selectionId)}/reach-deck-media/presign-download?${query}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error(failure);
      const result = (await response.json()) as {
        downloadUrl: string;
        disposition: 'inline' | 'attachment';
        contentType?: string;
      };
      return {
        url: result.downloadUrl,
        disposition: result.disposition,
        contentType: result.contentType,
      };
    },
    [initialAttempt.attemptId, initialAttempt.selectionId, t],
  );

  if (!runtimeReady) {
    if (runtimeLoadError !== null) {
      return (
        <div
          aria-live="assertive"
          className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger-border bg-danger-soft p-4 text-body text-danger-text"
          role="alert"
        >
          <span>{runtimeLoadError}</span>
          <Button onClick={() => setRuntimeReloadKey((value) => value + 1)} variant="secondary">
            {t('reachDeck.attempt.retryRestore')}
          </Button>
        </div>
      );
    }
    // 载入学习记录时只放品牌 loading，文案留给读屏。
    return (
      <div className="grid h-full min-h-0 place-items-center p-6" data-student-player-loading>
        <BrandLoader label={t('reachDeck.attempt.restoring')} size="lg" />
      </div>
    );
  }

  return (
    /*
     * 播放列：定高、不滚动。幻灯片 shell 按 16:9 拟合宽度；题目与互动页 shell 占满剩余高度，
     * 题目内容只在播放器舞台内部滚动，控制条固定在底部。上浮笔记列表与编辑画布都绝对定位在
     * 这一列上，因此与舞台的滚动位置无关。
     */
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-student-player-column
      ref={playerColumnRef}
    >
      {/*
       * 需要学生知情或操作的提示条排在播放器上方：字幕与控制条始终沉底，出现提示时只压缩
       * 中间的内容区，控件不跟着跳。
       */}
      <div className="flow-root flex-none" data-student-player-status>
        {/*
         * 只有「学生需要知道点什么」时才占一行：尝试已失效。保存与收尾完成属于同步细节，
         * 不再出文字条，改成播放器右上角的状态点（见 syncIndicator）。
         */}
        {completed || !unavailable ? null : (
          <div
            aria-live="polite"
            className="flex items-center gap-2 border-t border-line-subtle bg-surface-warm px-4 py-2.5 text-body text-fg-secondary sm:px-5"
            role="status"
          >
            <span aria-hidden="true" className="size-2 rounded-pill bg-danger" />
            {t('reachDeck.attempt.unavailable')}
          </div>
        )}

        {gradingNotice === null ? null : (
          <div
            aria-live="polite"
            className="flex items-center gap-2 border-t border-line bg-warning-soft px-4 py-2.5 text-body text-warning-text sm:px-5"
            data-grading-notice
            role="status"
          >
            {gradingNotice}
          </div>
        )}

        {failedEvent === null ? null : (
          <div
            aria-live="assertive"
            className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger-border bg-danger-soft p-4 text-body text-danger-text"
            role="alert"
          >
            <span>{t('reachDeck.attempt.syncFailed')}</span>
            <Button disabled={syncing} onClick={() => void retryFailedEvent()} variant="secondary">
              {syncing ? t('reachDeck.attempt.retrying') : t('reachDeck.attempt.retry')}
            </Button>
          </div>
        )}
        {completionError === null ? null : (
          <div
            aria-live="assertive"
            className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger-border bg-danger-soft p-4 text-body text-danger-text"
            role="alert"
          >
            <span>{completionError}</span>
            <Button disabled={completing} onClick={() => void complete()} variant="secondary">
              {completing ? t('reachDeck.attempt.retrying') : t('reachDeck.attempt.retry')}
            </Button>
          </div>
        )}
        {currentRuntimeConflict === undefined ? null : (
          <div
            aria-live="assertive"
            className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line-warm bg-warning-soft p-4 text-body text-warning-text"
            role="alert"
          >
            <span>{t('reachDeck.attempt.geometryConflict')}</span>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => useAuthoritativeGeometryState(currentRuntimeConflict)}
                variant="secondary"
              >
                {t('reachDeck.attempt.useSavedGeometry')}
              </Button>
              <Button
                onClick={() =>
                  void restoreLocalGeometryState(currentRuntimeConflict).catch(() => undefined)
                }
                variant="secondary"
              >
                {t('reachDeck.attempt.restoreLocalGeometry')}
              </Button>
            </div>
          </div>
        )}
        {runtimeError === null ? null : (
          <div
            aria-live="assertive"
            className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger-border bg-danger-soft p-4 text-body text-danger-text"
            role="alert"
          >
            <span>{runtimeError}</span>
            <Button
              onClick={() => void retryRuntimeSave().catch(() => undefined)}
              variant="secondary"
            >
              {t('reachDeck.attempt.retrySave')}
            </Button>
          </div>
        )}
      </div>

      <div
        className="relative flex min-h-0 w-full flex-1 flex-col"
        data-scene-type={whiteboardPage?.sceneType}
        data-student-native-player-shell
        ref={playerShellRef}
      >
        <div
          aria-disabled={interactionLocked}
          data-reach-deck-readable-attachments={attachmentsReadable ? 'true' : undefined}
          data-student-player-frame
          style={interactionLocked ? { opacity: 0.86, pointerEvents: 'none' } : undefined}
        >
          <ReachDeckPlayer
            resolveAttachmentUrl={resolveAttachmentUrl}
            key={`student-runtime-${runtimePlayerKey}`}
            locale={locale}
            activePageId={activePageId}
            autoPlay={autoPlay}
            appearance="learner"
            nativeSlideMaxWidth={nativePlayerMaxWidth}
            document={document}
            interactiveMode="learner"
            initialRuntimeByPageId={initialRuntime}
            initialPageId={currentPageId}
            currentTime={currentTime}
            hideNativeDiagnostics
            nativeResourceUrlsById={nativeResourceUrlsById}
            nativeMediaScopeKey={nativeMediaScopeKey}
            onNativeMediaError={onNativeMediaError}
            onNativeMediaLoaded={onNativeMediaLoaded}
            onNativeMediaPlayingChange={onNativeMediaPlayingChange}
            onEvent={handlePlayerEvent}
            onNarrationLearnerIntent={handleNarrationLearnerIntent}
            onActivityChange={(activity) =>
              onTutorActivityChange?.({ ...immutableIdentity, activity })
            }
            onPageChange={(page) => {
              if (whiteboardEditing) return;
              const previousPageId = currentPageIdRef.current;
              currentPageIdRef.current = page.pageId;
              setCurrentPageId(page.pageId);
              updateTutorAvailability(page.pageId, runtimeRef.current[page.pageId]);
              if (previousPageId && previousPageId !== page.pageId) {
                void flushRuntimePage(previousPageId, 'page_leave').catch(() => undefined);
              }
              onPageChange?.(page);
            }}
            onRuntimeStateChange={scheduleRuntimeAutosave}
            onCurrentTimeChange={setCurrentTime}
            onPlayingChange={setPlaying}
            playing={playing}
            pageNavigationLocked={navigationLock !== null}
            isPageNavigable={isPlayerPageNavigable}
            narratorAvatar={narratorAvatar}
            restrictNarrationForwardSeek={restrictNarrationForwardSeek}
            showPageIndicator
            showPageControls
            showStaticSlideBeforePlayback={false}
            masteredLearningFenceQuestionIdsByPage={masteredFenceQuestions}
            quizGradingMode="server"
            quizLayout="learner"
            quizGradingByPageId={quizGradingByPageId}
            quizUnsyncedSubmissionsByPageId={
              Object.keys(unsyncedSubmissionsByPage).length === 0
                ? undefined
                : unsyncedSubmissionsByPage
            }
            // 完成后只剩「成绩已定、AI 反馈失败」的题可以重新生成（retryQuizGrading 内部也只放行这一种）。
            onRetryQuizGrading={
              unavailable || (readOnly && !feedbackRetryAvailable)
                ? undefined
                : handleRetryQuizGrading
            }
            renderQuizGradingFeedback={renderGradingFeedback}
            // 最后一页的「下一页」换成「完成学习」旗子：纯前端的收尾入口，可反复打开。
            lastPageAction={
              <button
                aria-label={t('reachDeck.completion.finish')}
                className="reach-deck-player__transport"
                data-reach-deck-primary-control
                data-student-finish
                disabled={whiteboardEditing}
                onClick={() => changeCompletionDialogOpen(true)}
                title={t('reachDeck.completion.finish')}
                type="button"
              >
                <Flag aria-hidden="true" size={16} />
                <span aria-hidden="true" className="reach-deck-player__control-label">
                  {t('reachDeck.completion.finish')}
                </span>
              </button>
            }
            timelineExtra={
              <>
                <ReachDeckAutoAdvanceToggle
                  checked={autoPlay}
                  data-student-auto-play
                  label={t('reachDeck.attempt.autoPlay')}
                  onCheckedChange={setAutoPlay}
                  translate={t}
                />
                <button
                  aria-expanded={notesOpen || whiteboardEditing}
                  aria-label={t('reachDeck.whiteboard.entryLabel', { count: currentNoteCount })}
                  className="reach-deck-player__transport"
                  data-reach-deck-control-pill
                  data-student-notes-entry
                  disabled={interactionLocked || currentPageId === undefined}
                  onClick={toggleNotes}
                  title={t('reachDeck.whiteboard.entryLabel', { count: currentNoteCount })}
                  type="button"
                >
                  <NotebookPen aria-hidden="true" size={16} />
                  <span aria-hidden="true">{t('reachDeck.whiteboard.entry')}</span>
                  <span aria-hidden="true" data-reach-deck-control-badge data-student-notes-count>
                    {currentNoteCount}
                  </span>
                </button>
                {onFullscreenChange === undefined ? null : (
                  <button
                    aria-label={t(
                      fullscreen
                        ? 'reachDeck.attempt.exitFullscreen'
                        : 'reachDeck.attempt.enterFullscreen',
                    )}
                    aria-pressed={fullscreen}
                    className="reach-deck-player__transport"
                    data-student-fullscreen-toggle
                    onClick={() => onFullscreenChange(!fullscreen)}
                    title={t(
                      fullscreen
                        ? 'reachDeck.attempt.exitFullscreen'
                        : 'reachDeck.attempt.enterFullscreen',
                    )}
                    type="button"
                  >
                    {fullscreen ? (
                      <Minimize2 aria-hidden="true" size={16} />
                    ) : (
                      <Maximize2 aria-hidden="true" size={16} />
                    )}
                  </button>
                )}
              </>
            }
            translate={t}
            uploadQuizAnswerAsset={uploadQuizAnswerAsset}
          />
        </div>
        {syncIndicator === null ? null : (
          <span
            aria-live="polite"
            data-student-sync-indicator={syncIndicator}
            role="status"
            title={t(syncIndicatorLabelKey[syncIndicator])}
          >
            <span className="sr-only">{t(syncIndicatorLabelKey[syncIndicator])}</span>
          </span>
        )}
      </div>

      <StudentReachDeckCompletionDialog
        attemptCompleted={
          confirmation?.progress?.status === 'completed' ||
          confirmedCompletedIdentityRef.current === immutableIdentity
        }
        completedPages={completedPageCount}
        confirmation={
          confirmation?.state.status === 'ready' && completionError !== null
            ? { status: 'error', message: completionError }
            : (confirmation?.state ?? { status: 'checking' })
        }
        firstIncompletePageNumber={firstIncompleteIndex < 0 ? null : firstIncompleteIndex + 1}
        gradingPending={gradingPending || completionAwaitingGrading}
        moduleTitle={document.title}
        onGoToFirstIncomplete={() => {
          const page = orderedPages[firstIncompleteIndex];
          if (page !== undefined) onPageChange?.(page);
        }}
        onOpenChange={changeCompletionDialogOpen}
        onRetry={retryCompletionCheck}
        open={completionDialogOpen}
        totalPages={orderedPages.length}
      />

      {notesOpen && currentPageId !== undefined && whiteboardPage !== undefined ? (
        <StudentReachDeckWhiteboard
          key={`${initialAttempt.attemptId}:${currentPageId}`}
          attemptId={initialAttempt.attemptId}
          currentTime={currentTime}
          dock={notesDock}
          document={document}
          locale={locale}
          nativeResourceUrlsById={nativeResourceUrlsById}
          onBoardCountChange={recordNoteCount}
          onClose={closeNotes}
          onEditingChange={changeWhiteboardEditing}
          page={whiteboardPage}
          quizGrading={whiteboardQuizGrading}
          readOnly={interactionLocked}
          resolveAttachmentUrl={resolveAttachmentUrl}
          runtimeState={runtimeRef.current[currentPageId]}
          t={t}
        />
      ) : null}
    </div>
  );
}

type StudentDeckSyncIndicator = 'saved' | 'saving';

const syncIndicatorLabelKey = {
  saved: 'reachDeck.attempt.runtimeSaved',
  saving: 'reachDeck.attempt.runtimeSaving',
} as const satisfies Record<StudentDeckSyncIndicator, string>;

function toNarrationEventInput(
  intent: ReachDeckNarrationLearnerIntent,
  eventId: string,
  occurredAt: string,
): NarrationEventInput {
  const base = {
    eventId,
    occurredAt,
    pageId: intent.pageId,
    sceneId: intent.sceneId,
    sourceRevision: intent.revision,
  };
  switch (intent.type) {
    case 'narration_play':
    case 'narration_pause':
      return {
        ...base,
        eventType: intent.type,
        metadata: {
          positionMs: intent.positionMs,
          ...(intent.automatic === true ? { automatic: true as const } : {}),
        },
      };
    case 'narration_seek':
      return {
        ...base,
        eventType: intent.type,
        metadata: { fromMs: intent.fromMs, toMs: intent.toMs },
      };
    case 'narration_rate_change':
      return {
        ...base,
        eventType: intent.type,
        metadata: {
          fromRate: intent.fromRate,
          positionMs: intent.positionMs,
          toRate: intent.toRate,
        },
      };
  }
}

export function mapReachDeckPlayerEvent({
  document,
  event,
  eventId,
  occurredAt,
}: EventMappingContext): AppendAttemptEventInput | null {
  const page = document.pages.find((candidate) => candidate.pageId === event.pageId);
  if (page === undefined) return null;
  const base = { eventId, occurredAt, sceneId: pageSceneIdentity(page) };

  switch (event.type) {
    case 'pageEnter': {
      if (page.sceneType === 'interactive' && page.scene.runtimePolicy.completionMode !== 'none') {
        return null;
      }
      const ordered = [...document.pages].sort((left, right) => left.order - right.order);
      const pageIndex = ordered.findIndex((candidate) => candidate.pageId === event.pageId);
      if (pageIndex < 0 || ordered.length === 0) return null;
      return {
        ...base,
        eventType: 'progress',
        itemId: null,
        itemResult: null,
        progress: roundPercentage(((pageIndex + 1) / ordered.length) * 100),
        score: null,
      };
    }
    // Quiz results are written by the server from unified grading; the client never reports
    // `quiz_result` (the attempt-event endpoint rejects it).
    case 'quizSubmit':
    case 'interactiveComplete':
    case 'interactiveLearningEvent':
      return null;
  }
}

async function postAttemptEvent(
  identity: Pick<AttemptResponse, 'attemptId' | 'moduleVersionId' | 'selectionId'>,
  input: AppendAttemptEventInput,
  translate: PortalTranslator,
  learningVisitId: string | null,
): Promise<AttemptResponse> {
  return postAttempt(identity, 'events', translate, input, learningVisitId);
}

async function postAttemptCompletion(
  identity: Pick<AttemptResponse, 'attemptId' | 'moduleVersionId' | 'selectionId'>,
  translate: PortalTranslator,
): Promise<AttemptResponse> {
  return postAttempt(identity, 'complete', translate);
}

async function postInteractivePageComplete(
  identity: Pick<AttemptResponse, 'attemptId' | 'moduleVersionId' | 'selectionId'>,
  input: CompleteInteractivePageInput,
  translate: PortalTranslator,
  learningVisitId: string | null,
): Promise<AttemptResponse> {
  return postAttempt(identity, 'interactive-page-complete', translate, input, learningVisitId);
}

async function postAttempt(
  identity: Pick<AttemptResponse, 'attemptId' | 'moduleVersionId' | 'selectionId'>,
  action: 'complete' | 'events' | 'interactive-page-complete',
  translate: PortalTranslator,
  input?: AppendAttemptEventInput | CompleteInteractivePageInput,
  learningVisitId = getCurrentLearningVisit({ selectionId: identity.selectionId })?.visitId ?? null,
): Promise<AttemptResponse> {
  let response: Response;
  try {
    response = await fetch(
      `/api/student/reach-deck/attempts/${identity.attemptId}/${action}`,
      withLearningVisit(
        input === undefined
          ? { method: 'POST', learningVisitId }
          : {
              learningVisitId,
              body: JSON.stringify(input),
              headers: { 'Content-Type': 'application/json' },
              method: 'POST',
            },
      ),
    );
  } catch {
    throw new ReachDeckUserFacingError(translate('reachDeck.attempt.requestUnavailable'));
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new PageRuntimeRequestError(
      translate('reachDeck.attempt.requestFailed', { status: response.status }),
      response.status,
      errorDataOf(body),
    );
  }
  const updated = await parseAttemptResponseBody(response, translate);
  if (
    updated.attemptId !== identity.attemptId ||
    updated.selectionId !== identity.selectionId ||
    updated.moduleVersionId !== identity.moduleVersionId
  ) {
    throw new ReachDeckUserFacingError(translate('reachDeck.attempt.responseMismatch'));
  }
  return updated;
}

async function parseAttemptResponseBody(
  response: Response,
  translate: PortalTranslator,
): Promise<AttemptResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ReachDeckUserFacingError(translate('reachDeck.attempt.invalidResponse'));
  }
  try {
    return parseAttemptResponse(body);
  } catch {
    throw new ReachDeckUserFacingError(translate('reachDeck.attempt.invalidResponse'));
  }
}

class PageRuntimeRequestError extends ReachDeckUserFacingError {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'PageRuntimeRequestError';
  }

  /** Server machine code from `data.reason` (for example `grading_pending`). */
  get reason(): string | undefined {
    return typeof this.data.reason === 'string' ? this.data.reason : undefined;
  }
}

function errorDataOf(body: unknown): Readonly<Record<string, unknown>> {
  return isUnknownRecord(body) && isUnknownRecord(body.data) ? body.data : {};
}

async function getPageRuntime(
  attemptId: string,
  page: ReachDeckPublishedPage,
  translate: PortalTranslator,
): Promise<StudentDeckPageRuntime> {
  const runtime = parseStudentDeckPageRuntime(
    await requestJson<unknown>(
      pageRuntimeRoute(attemptId, page.pageId, 'runtime'),
      { method: 'GET' },
      translate,
      translate('reachDeck.attempt.runtimeRestoreFailed'),
    ),
  );
  if (
    runtime.attemptId !== attemptId ||
    runtime.pageId !== page.pageId ||
    runtime.sceneId !== pageSceneIdentity(page) ||
    runtime.sourceRevision !== page.revision
  ) {
    throw new ReachDeckUserFacingError(translate('reachDeck.attempt.runtimeResponseMismatch'));
  }
  return runtime;
}

async function postPageCommand(
  attemptId: string,
  pageId: string,
  input: StudentDeckPageCommandInput,
  translate: PortalTranslator,
  keepalive = false,
  learningVisitId: string | null = null,
): Promise<StudentDeckPageRuntime> {
  const body = JSON.stringify(input);
  const shouldKeepalive = keepalive && new TextEncoder().encode(body).byteLength <= 60 * 1024;
  const runtime = parseStudentDeckPageRuntime(
    await requestJson<unknown>(
      pageRuntimeRoute(attemptId, pageId, 'commands'),
      {
        body,
        learningVisitId,
        headers: { 'Content-Type': 'application/json' },
        ...(shouldKeepalive ? { keepalive: true } : {}),
        method: 'POST',
      },
      translate,
      translate('reachDeck.attempt.runtimeSaveFailed'),
    ),
  );
  if (
    runtime.attemptId !== attemptId ||
    runtime.pageId !== pageId ||
    runtime.sceneId !== input.sceneId ||
    runtime.sourceRevision !== input.sourceRevision
  ) {
    throw new ReachDeckUserFacingError(translate('reachDeck.attempt.runtimeResponseMismatch'));
  }
  return runtime;
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: LearningRequestInit | undefined,
  translate: PortalTranslator,
  failureMessage?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, withLearningVisit(init));
  } catch {
    throw new PageRuntimeRequestError(
      failureMessage ?? translate('reachDeck.attempt.requestUnavailable'),
      0,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new PageRuntimeRequestError(
      failureMessage ??
        translate('reachDeck.attempt.runtimeRequestFailed', { status: response.status }),
      response.status,
      errorDataOf(body),
    );
  }
  if (body === null) {
    throw new ReachDeckUserFacingError(translate('reachDeck.attempt.runtimeInvalidResponse'));
  }
  return body as T;
}

function pageRuntimeRoute(
  attemptId: string,
  pageId: string,
  action: 'commands' | 'runtime',
): string {
  return `/api/student/reach-deck/attempts/${encodeURIComponent(attemptId)}/pages/${encodeURIComponent(pageId)}/${action}`;
}

function gradingRetryRoute(attemptId: string, pageId: string, questionId: string): string {
  return `/api/student/reach-deck/attempts/${encodeURIComponent(attemptId)}/pages/${encodeURIComponent(pageId)}/questions/${encodeURIComponent(questionId)}/grading/retry`;
}

/** Parses `state.serverGrading` into player views; malformed entries are ignored. */
export function parseServerGrading(state: Record<string, unknown>): QuizGradingByQuestionId {
  const projection = state.serverGrading;
  if (!isUnknownRecord(projection)) return {};
  const views: Record<string, QuizGradingView> = {};
  for (const [questionId, value] of Object.entries(projection)) {
    if (!isUnknownRecord(value)) continue;
    const status = value.status;
    if (status !== 'grading' && status !== 'graded' && status !== 'failed') continue;
    if (typeof value.maxScore !== 'number' || !Number.isFinite(value.maxScore)) continue;
    views[questionId] = {
      status,
      maxScore: value.maxScore,
      ...(typeof value.score === 'number' && Number.isFinite(value.score)
        ? { score: value.score }
        : {}),
      ...(value.result === 'correct' || value.result === 'incorrect'
        ? { result: value.result }
        : {}),
      ...(typeof value.rationale === 'string' && value.rationale.trim().length > 0
        ? { rationale: value.rationale }
        : {}),
      ...(typeof value.feedbackMarkdown === 'string' && value.feedbackMarkdown.trim().length > 0
        ? { feedbackMarkdown: value.feedbackMarkdown }
        : {}),
      ...(status === 'graded' &&
      (value.feedbackStatus === 'grading' || value.feedbackStatus === 'failed')
        ? { feedbackStatus: value.feedbackStatus }
        : {}),
    };
  }
  return views;
}

function serverGradingEqual(left: QuizGradingByQuestionId, right: QuizGradingByQuestionId) {
  return canonicalRuntimeValue(left) === canonicalRuntimeValue(right);
}

/** A failed grading, or a final score whose AI feedback failed: both offer the learner a retry. */
function gradingRetryable(entry: QuizGradingView): boolean {
  return entry.status === 'failed' || entry.feedbackStatus === 'failed';
}

function hasPendingGrading(grading: ServerGradingByPage): boolean {
  return Object.values(grading).some((page) =>
    Object.values(page).some((entry) => entry.status === 'grading'),
  );
}

/** Replaces one page's question id list, dropping the page when empty; keeps identity when equal. */
function withPageIds(
  current: Readonly<Record<string, readonly string[]>>,
  pageId: string,
  ids: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const existing = current[pageId] ?? [];
  if (existing.length === ids.length && existing.every((id, index) => id === ids[index])) {
    return current;
  }
  const next = { ...current };
  if (ids.length === 0) delete next[pageId];
  else next[pageId] = ids;
  return next;
}

/** Whether a learning-fence question on this page is still being AI-graded. */
function pageHasFencedGrading(
  page: ReachDeckPublishedPage | undefined,
  grading: QuizGradingByQuestionId | undefined,
): boolean {
  if (page?.sceneType !== 'quiz' || grading === undefined) return false;
  return page.scene.content.questions.some(
    (question) =>
      question.learning_fence?.enabled === true && grading[question.id]?.status === 'grading',
  );
}

function hasFencedGradingAnywhere(
  document: ReachDeckDocument,
  grading: ServerGradingByPage,
): boolean {
  return document.pages.some((page) => pageHasFencedGrading(page, grading[page.pageId]));
}

function gradingRetryErrorMessage(error: unknown, translate: PortalTranslator): string {
  if (!(error instanceof PageRuntimeRequestError)) {
    return translate('reachDeck.grading.retryFailed');
  }
  switch (error.reason) {
    case 'retry_cooldown': {
      const seconds = error.data.retryAfterSeconds;
      return translate('reachDeck.grading.retryCooldown', {
        seconds: typeof seconds === 'number' && seconds > 0 ? Math.ceil(seconds) : 60,
      });
    }
    case 'retry_limit_reached':
      return translate('reachDeck.grading.retryLimitReached');
    case 'not_failed':
      return translate('reachDeck.grading.retryNotFailed');
    case 'grading_not_found':
      return translate('reachDeck.grading.retryNotFound');
    case 'concurrent_update':
      return translate('reachDeck.grading.retryConflict');
    default:
      return error.status === 409
        ? translate('reachDeck.grading.retryUnavailable')
        : translate('reachDeck.grading.retryFailed');
  }
}

function assetRoute(
  attemptId: string,
  pageId: string,
  questionId: string,
  action: 'presign-download' | 'presign-upload' | 'upload',
): string {
  return `/api/student/reach-deck/attempts/${encodeURIComponent(attemptId)}/pages/${encodeURIComponent(pageId)}/questions/${encodeURIComponent(questionId)}/assets/${action}`;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runtimeStateForPage(
  state: unknown,
  page: ReachDeckPublishedPage,
  translate: PortalTranslator,
): ReachDeckSceneRuntimeState {
  const candidate = state as unknown as ReachDeckSceneRuntimeState;
  if (page.sceneType !== 'slide' && isRuntimeStateForPage(candidate, page)) return candidate;
  throw new ReachDeckUserFacingError(translate('reachDeck.attempt.runtimeResponseMismatch'));
}

function pageHasV2Geometry(page: ReachDeckPublishedPage): boolean {
  if (page.sceneType !== 'interactive') return false;
  return (page.scene.runtimeDependencies ?? []).some(
    (dependency) =>
      dependency.id === 'geometry-euclidean-2d-v2' || dependency.id === 'geometry-euclidean-3d-v2',
  );
}

function hasGeometryHostStateV2(state: unknown): boolean {
  const auxiliary = geometryAuxiliaryGraphs(state);
  return auxiliary !== undefined && auxiliary !== null;
}

function geometryAuxiliaryGraphsEqual(
  localState: Record<string, unknown>,
  authoritativeState: Record<string, unknown>,
): boolean {
  const local = geometryAuxiliaryGraphs(localState);
  // Runtime states without the v2 geometry slot retain the established optimistic rebase path.
  if (local === undefined) return true;
  const authoritative = geometryAuxiliaryGraphs(authoritativeState);
  if (local === null || authoritative === undefined || authoritative === null) return false;
  return canonicalRuntimeValue(local) === canonicalRuntimeValue(authoritative);
}

function geometryAuxiliaryGraphs(state: unknown): Record<string, unknown> | null | undefined {
  if (!isUnknownRecord(state) || !isUnknownRecord(state.geometry)) return undefined;
  const geometry = state.geometry;
  if (geometry.schemaVersion !== 'reach-geometry-host-state/v2') return undefined;
  if (!isUnknownRecord(geometry.instances)) return null;
  const result: Record<string, unknown> = {};
  for (const [instanceId, value] of Object.entries(geometry.instances)) {
    if (!isUnknownRecord(value) || !Object.hasOwn(value, 'auxiliary')) return null;
    result[instanceId] = value.auxiliary;
  }
  return result;
}

function canonicalRuntimeValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRuntimeValue).join(',')}]`;
  if (isUnknownRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalRuntimeValue(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function pageBehaviorState(page: ReachDeckPublishedPage): Record<string, unknown> {
  return {
    kind: 'page_behavior',
    sceneType: page.sceneType,
    sceneId: pageSceneIdentity(page),
    sourceRevision: page.revision,
  };
}

function pageSceneIdentity(page: ReachDeckPublishedPage): string {
  return page.sceneType === 'slide' ? page.pageId : page.scene.id;
}

function pageCountsAsCompleteOnEntry(
  document: ReachDeckDocument,
  pageId: string,
  narratedSlidePageIds: ReadonlySet<string>,
): boolean {
  return reachDeckPageCompletesOnEntry(
    document.pages.find((candidate) => candidate.pageId === pageId),
    narratedSlidePageIds,
  );
}

function runtimeAutosaveMetadata(
  previous: ReachDeckSceneRuntimeState | undefined,
  next: ReachDeckSceneRuntimeState,
): StudentDeckPageCommandInput['metadata'] {
  const changedQuestions = changedQuizQuestionIds(previous, next);
  return {
    kind: next.kind,
    ...(changedQuestions.length === 1 ? { questionId: changedQuestions[0]! } : {}),
  };
}

function runtimeDomainOperations(
  previous: ReachDeckSceneRuntimeState | undefined,
  next: ReachDeckSceneRuntimeState,
): RuntimeDomainOperation[] {
  if (next.kind !== 'quiz') return [];
  const operations: RuntimeDomainOperation[] = [];
  for (const questionId of changedQuizQuestionIds(previous, next)) {
    const before = quizAnswerAssets(previous, questionId);
    const after = quizAnswerAssets(next, questionId);
    const beforeById = new Map(before.map((asset) => [asset.assetId, asset]));
    const afterById = new Map(after.map((asset) => [asset.assetId, asset]));
    for (const asset of after) {
      if (beforeById.has(asset.assetId)) continue;
      operations.push({
        commandType: 'asset_attached',
        metadata: { assetId: asset.assetId, assetKind: asset.kind, questionId },
      });
    }
    for (const asset of before) {
      if (afterById.has(asset.assetId)) continue;
      operations.push({
        commandType: 'asset_removed',
        metadata: { assetId: asset.assetId, assetKind: asset.kind, questionId },
      });
    }
    if (
      before.length > 1 &&
      before.length === after.length &&
      before.every((asset) => afterById.has(asset.assetId)) &&
      before.some((asset, index) => after[index]?.assetId !== asset.assetId)
    ) {
      operations.push({
        commandType: 'asset_reordered',
        metadata: { assetCount: after.length, questionId },
      });
    }
  }
  return operations;
}

function changedQuizQuestionIds(
  previous: ReachDeckSceneRuntimeState | undefined,
  next: ReachDeckSceneRuntimeState,
): string[] {
  if (next.kind !== 'quiz') return [];
  const previousAnswers = previous?.kind === 'quiz' ? previous.answers : {};
  const questionIds = new Set([...Object.keys(previousAnswers), ...Object.keys(next.answers)]);
  return [...questionIds].filter(
    (questionId) =>
      JSON.stringify(previousAnswers[questionId]) !== JSON.stringify(next.answers[questionId]),
  );
}

function quizAnswerAssets(
  state: ReachDeckSceneRuntimeState | undefined,
  questionId: string,
): Array<{ assetId: string; kind: 'attachment' | 'inline_image' }> {
  if (state?.kind !== 'quiz') return [];
  const answer = state.answers[questionId];
  const assets: Array<{ assetId: string; kind: 'attachment' | 'inline_image' }> = [];
  if (answer?.kind === 'fill_blanks') {
    for (const blank of answer.blanks) {
      if (blank.answer.kind === 'rich_text') {
        collectInlineImageAssets(blank.answer.document, assets);
      }
    }
    return assets;
  }
  if (answer?.kind !== 'rich_text') return assets;
  collectInlineImageAssets(answer.document, assets);
  for (const attachment of answer.attachments) {
    if (typeof attachment.assetId === 'string' && attachment.assetId.trim().length > 0) {
      assets.push({ assetId: attachment.assetId, kind: 'attachment' });
    }
  }
  return assets;
}

function collectInlineImageAssets(
  value: unknown,
  assets: Array<{ assetId: string; kind: 'attachment' | 'inline_image' }>,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectInlineImageAssets(entry, assets));
    return;
  }
  if (!isUnknownRecord(value)) return;
  if (
    value.type === 'image' &&
    isUnknownRecord(value.attrs) &&
    typeof value.attrs.assetId === 'string' &&
    value.attrs.assetId.trim().length > 0
  ) {
    assets.push({ assetId: value.attrs.assetId, kind: 'inline_image' });
  }
  Object.values(value).forEach((entry) => collectInlineImageAssets(entry, assets));
}

function roundPercentage(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}
