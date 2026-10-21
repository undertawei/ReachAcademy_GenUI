'use client';

import { useMediaStallRecovery } from './useMediaStallRecovery.js';
import { useRetainedMediaSource } from './useRetainedMediaSource.js';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { ChevronLeft, ChevronRight, MessageSquareText, Pause, Play } from 'lucide-react';
import {
  getActiveNarrationSegmentV2,
  getNarrationCaptionV2,
  getReachDeckNativeSlideEffectiveDuration,
  isInteractiveBlankDocument,
  reachDeckMediaUrlsByObjectKey,
  type ReachDeckAnimationV2,
  type ReachDeckDocument,
  type ReachDeckPublishedPage,
  type ReachDeckTransformV2,
} from '@reachany/reach-deck-dsl';
import { Switch, type ControlTouchTarget } from '@reachany/ui';

import { InteractiveScenePlayer } from './InteractiveScenePlayer.js';
import { InteractiveNarrationBar } from './InteractiveNarrationBar.js';
import {
  LearnerNarrationDock,
  NARRATION_SKIP_SECONDS,
  NarrationRateControl,
  NarrationSkipButton,
  NarrationVolumeControl,
  type NarrationVolume,
} from './LearnerNarrationDock.js';
import { PlaybackRateSelect } from './PlaybackRateControl.js';
import { isPlaybackRate } from './playbackRates.js';
import { NativeV2SlideRenderer, type NativeV2SlideRendererProps } from './NativeV2SlideRenderer.js';
import { NarrationCaption } from './NarrationCaption.js';
import { createScientificVisualUrlResourceResolver } from './ScientificVisualPlayer.js';
import { type QuizAnswerAssetKind, type QuizAnswerUploadedAsset } from './QuizAnswerEditor.js';
import { QuizScenePlayer } from './QuizScenePlayer.js';
import type {
  ReachDeckAttachmentUrlResolver,
  ReachDeckAttachmentUnavailablePredicate,
} from './ReachDeckAttachmentList.js';
import {
  createInteractiveIframePoolState,
  reconcileInteractiveIframePool,
} from './interactiveIframePool.js';
import { isRuntimeStateForPage, reconcileReachDeckRuntime } from './sceneRuntime.js';
import { gradeObjectiveQuestion } from './objectiveGrading.js';
import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';
import type {
  InteractiveSceneRuntimeState,
  QuizGradingByQuestionId,
  QuizGradingMode,
  QuizSceneLayout,
  ReachDeckPlayerActivity,
  ReachDeckPlayerEvent,
  ReachDeckRuntimeByPageId,
  ReachDeckSceneRuntimeState,
} from './types.js';
import type {
  GeometryEditProposal,
  GeometryHostMode,
  InteractiveComponentFocus,
} from './interactiveBridge.js';

const EMPTY_NATIVE_RESOURCE_URLS: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_QUIZ_GRADING: QuizGradingByQuestionId = Object.freeze({});

/** 滚轮翻页的最小位移与冷却，避免一次惯性滚动连翻多页。 */
const WHEEL_PAGE_THRESHOLD = 12;
const WHEEL_PAGE_COOLDOWN_MS = 320;
const MEDIA_END_COMPLETION_TOLERANCE_SECONDS = 0.15;
const MEDIA_EXPLICIT_SEEK_TOLERANCE_SECONDS = 0.02;
const NARRATION_INTENT_SEEK_TOLERANCE_SECONDS = 0.05;

/**
 * 讲稿事件。幻灯片的每次开始 / 停止播放都会上报（服务端据此重建正常播放区间、判定本页是否学完）；
 * 不是学习者点出来的（自动播放、自然播完、换页、缓冲中断、宿主暂停）带 `automatic: true`。
 */
export type ReachDeckNarrationLearnerIntent =
  | (NarrationIntentBase<'narration_play'> & { automatic?: true; positionMs: number })
  | (NarrationIntentBase<'narration_pause'> & {
      automatic?: true;
      /** 页面正在卸载（刷新、关闭、整页跳转）：宿主需立即以 keepalive 方式送出。 */
      pageHide?: true;
      positionMs: number;
    })
  | (NarrationIntentBase<'narration_seek'> & { fromMs: number; toMs: number })
  | (NarrationIntentBase<'narration_rate_change'> & {
      fromRate: number;
      positionMs: number;
      toRate: number;
    });

interface NarrationIntentContext {
  pageId: string;
  revision: number;
  sceneId: string;
}

interface NarrationIntentBase<Type extends string> extends NarrationIntentContext {
  type: Type;
}

export interface ReachDeckNarrationSeekRequest {
  id: number;
  pageId: string;
  time: number;
}

interface ResolvedNarrationSeekRequest extends ReachDeckNarrationSeekRequest {
  src: string;
}

export interface ReachDeckPlayerProps {
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  isAttachmentUnavailable?: ReachDeckAttachmentUnavailablePredicate;
  document: ReachDeckDocument;
  translate?: ReachDeckTranslate;
  locale?: string;
  initialRuntimeByPageId?: ReachDeckRuntimeByPageId;
  /** Server-confirmed fence mastery; omitted by teacher preview hosts. */
  masteredLearningFenceQuestionIdsByPage?: Readonly<Record<string, readonly string[]>>;
  /**
   * Quiz grading authority. Defaults to `server`: answers are never graded locally and reference
   * answers wait for a terminal server result. Only Teacher Trial/authoring hosts pass `trial`,
   * which grades objective questions locally and reveals AI-graded references immediately.
   */
  quizGradingMode?: QuizGradingMode;
  /** 题目页排布；缺省 `default` 与原来一致，学生端传 `learner`。 */
  quizLayout?: QuizSceneLayout;
  /** Shared learner chrome; omitted hosts retain the default appearance. */
  appearance?: 'default' | 'learner';
  /**
   * Server-authoritative quiz grading by page id (server mode). Omitting it in server mode keeps
   * every scored submission unrevealed and pending.
   */
  quizGradingByPageId?: Readonly<Record<string, QuizGradingByQuestionId>>;
  /** Submitted question ids per page whose submission the host failed to save. */
  quizUnsyncedSubmissionsByPageId?: Readonly<Record<string, readonly string[]>>;
  onRetryQuizGrading?: (pageId: string, questionId: string) => void;
  /** Host-owned safe renderer for controlled grading Markdown. */
  renderQuizGradingFeedback?: (markdown: string) => ReactNode;
  activePageId?: string;
  initialPageId?: string;
  onEvent?: (event: ReachDeckPlayerEvent) => void;
  /** Explicit learner narration-control intent. Omit in Teacher/editor hosts to keep them inert. */
  onNarrationLearnerIntent?: (intent: ReachDeckNarrationLearnerIntent) => void;
  onElementSelect?: (elementId: string | undefined) => void;
  /** 多选集合变化回调（框选、Ctrl 点选）；提供后 slide 画布启用多选交互。 */
  onElementsSelect?: (elementIds: string[]) => void;
  /** 原生 v2 元素画布拖拽/缩放/旋转产生的 transform 变更回调。 */
  onNativeElementTransformChange?: (elementId: string, transform: ReachDeckTransformV2) => void;
  onNativeElementTransformStart?: (elementId: string) => void;
  onNativeElementTransformEnd?: (elementId: string) => void;
  /** 原生 v2 文本框双击进入行内编辑的回调。 */
  onNativeTextFrameDoubleClick?: (elementId: string, cellId?: string) => void;
  editingNativeTableCellId?: string;
  /** 原生 v2 空白画布双击回调，坐标已经换算到未缩放舞台。 */
  onNativeBlankCanvasDoubleClick?: (point: { x: number; y: number }) => void;
  /** 行内编辑中的原生文本框的替换渲染（编辑器由宿主提供）。 */
  renderEditingNativeTextFrame?: NativeV2SlideRendererProps['renderEditingTextFrame'];
  /** 编辑器叠加层：渲染在原生幻灯片舞台坐标系内（见 NativeV2SlideRenderer.stageOverlay）。 */
  nativeStageOverlay?: ReactNode;
  onPageChange?: (page: ReachDeckPublishedPage) => void;
  onActivityChange?: (activity: ReachDeckPlayerActivity) => void;
  onRuntimeStateChange?: (pageId: string, state: ReachDeckSceneRuntimeState) => void;
  uploadQuizAnswerAsset?: (
    file: File,
    context: { kind: QuizAnswerAssetKind; pageId: string; questionId: string },
  ) => Promise<QuizAnswerUploadedAsset>;
  selectedElementId?: string;
  currentTime?: number;
  playing?: boolean;
  /**
   * Explicit host seek intent for narration. The id must increase for each new request; pageId is
   * the stable identity, while the Player resolves the current signed media URL internally.
   */
  narrationSeekRequest?: ReachDeckNarrationSeekRequest;
  onCurrentTimeChange?: (time: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** 宿主受控的讲稿倍速（`PLAYBACK_RATES` 档位或 0.5–3 内的自定义倍速）；省略时由播放器内部倍速控件管理。 */
  playbackRate?: number;
  onPlaybackRateChange?: (playbackRate: number) => void;
  /**
   * Opt-in slide auto-advance intent. Playback still starts and pauses through the normal
   * transport control; pausing never clears this intent or restarts playback by itself.
   */
  autoAdvance?: boolean;
  /**
   * Renders a labelled auto-advance switch (`reachDeck.player.autoAdvance`) next to `timelineExtra`,
   * bound to `autoAdvance`. Omitted hosts render no switch and keep managing the intent themselves.
   */
  onAutoAdvanceChange?: (autoAdvance: boolean) => void;
  /**
   * 连续自动播放（学习者宿主）：进入幻灯片页或带讲稿的 GenUI 页即开始播放讲稿；幻灯片自然播完后
   * 翻到下一个可达页（同 autoAdvance）并继续播放，GenUI 讲稿播完与测验页停下来等学习者操作。
   * 自动开始不算学习者的讲稿操作，不产生 narration_play 意图；浏览器拒绝自动播放时停在暂停态。
   */
  autoPlay?: boolean;
  showNativeTimeline?: boolean;
  /** 渲染在原生时间轴最右侧的宿主自定义控件（如学生白板入口按钮）。 */
  timelineExtra?: ReactNode;
  /** 最后一页时替换「下一页」按钮的宿主控件（如学生端的「完成学习」）；缺省仍显示禁用的下一页。 */
  lastPageAction?: ReactNode;
  /** Enables wheel gestures on blank stage space to navigate pages. Disable inside scrollable editors. */
  enableWheelPageNavigation?: boolean;
  /** Prevents learner-initiated page changes while still following a controlled activePageId. */
  pageNavigationLocked?: boolean;
  /**
   * Per-page reachability for learner-initiated navigation (previous/next buttons, wheel paging and
   * auto-advance). Omitted hosts keep every page reachable; a controlled activePageId is still
   * followed even when it points to a page this predicate rejects.
   */
  isPageNavigable?: (page: ReachDeckPublishedPage) => boolean;
  /** Shows the `current/total` page indicator in the native slide timeline. Off by default. */
  showPageIndicator?: boolean;
  /**
   * Renders a page control bar (previous/next, the optional page indicator and `timelineExtra`)
   * below quiz and interactive pages, which have no native timeline. Slides keep the native
   * timeline. Off by default so existing hosts keep their layout.
   */
  showPageControls?: boolean;
  /** 编辑宿主策略：未播放时绕过动画轨道，展示全部基础组件；播放头位置保持不变。 */
  showStaticSlideWhenNotPlaying?: boolean;
  /**
   * 编辑宿主的单个动画演示：当前原生页只应用这一条动画，并按 `time` 渲染视觉状态，
   * 优先于播放态与静态展示；不驱动播放时钟、不播放音频。缺省时行为不变。
   */
  nativeAnimationPreview?: { animation: ReachDeckAnimationV2; time: number };
  /**
   * 学习者首次播放前（未播放、未拖动进度）是否展示整页静态内容。默认开启以保持既有宿主行为；
   * 关闭后首播前就按当前播放头（通常是 0）渲染，即只显示第 0 帧，入场动画元素在播放前不露出。
   */
  showStaticSlideBeforePlayback?: boolean;
  /**
   * 在 v2 原生页上展示「当前编辑器中只读」提示。
   * 这是编辑器语境的宿主 chrome，学习者播放路径一律不显示，故默认关闭、由编辑器显式打开。
   */
  showNativeReadOnlyHint?: boolean;
  /** 编辑宿主正在原位编辑的 native v2 文本元素。 */
  editingNativeTextElementId?: string;
  /** Resolved URLs are supplied by the host; missing resources stay visibly diagnosed. */
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  nativeMediaScopeKey?: string;
  /** Opt into retained healthy sources and resource-specific recovery through the owning app. */
  onNativeMediaError?: (resourceId: string, failedSrc: string) => void;
  onNativeMediaLoaded?: (resourceId: string, src: string) => void;
  onNativeMediaPlayingChange?: (resourceId: string, playing: boolean) => void;
  resolveScientificResource?: NativeV2SlideRendererProps['resolveScientificResource'];
  scientificDependencyBaseUrl?: string;
  reducedMotion?: boolean;
  /**
   * 隐藏原生 v2 renderer 追加在画布外的保真诊断面板。编辑器会把同一批诊断
   * 收进自己的右上角提醒；独立播放器缺省仍保留原始只读诊断，避免静默丢失信息。
   */
  hideNativeDiagnostics?: boolean;
  /** 原生幻灯片画布最大宽度；预览宿主可为字幕与播放控件保留空间。 */
  nativeSlideMaxWidth?: number;
  /** 显式启用控制条的窄屏触控尺寸，未传时保持宿主原有布局。 */
  controlTouchTarget?: ControlTouchTarget;
  /** Teacher authoring enables marked-component focus and an action on intentional empty pages. */
  interactiveMode?: 'authoring' | 'learner';
  /** Geometry-specific mode; authoring trial state is isolated from edit proposals. */
  geometryHostMode?: GeometryHostMode;
  onInteractiveEmptyAction?: (pageId: string) => void;
  /** Teacher authoring can also offer uploading a prepared single-file Interactive HTML. */
  onInteractiveUploadAction?: (pageId: string) => void;
  onInteractiveComponentFocus?: (focus: InteractiveComponentFocus) => void;
  onGeometryEditProposal?: (proposal: GeometryEditProposal) => void;
  /** Editor authoring can replace the learner-facing bar with its richer task-status track. */
  showInteractiveNarrationBar?: boolean;
  /** 学习者讲稿区（appearance="learner"）左侧的讲者头像；缺省是通用人像图标。 */
  narratorAvatar?: ReactNode;
  /**
   * 学习者还没学过的页：讲稿进度只能往回拖，向前最多到本次已经正常播放到的位置
   * （拖动、快进按钮与宿主跳转请求都受限）。播放到结尾后本页解除限制。缺省不限制。
   */
  restrictNarrationForwardSeek?: (page: ReachDeckPublishedPage) => boolean;
}

export function ReachDeckPlayer({
  resolveAttachmentUrl,
  isAttachmentUnavailable,
  document,
  translate,
  locale = 'en-US',
  initialRuntimeByPageId,
  masteredLearningFenceQuestionIdsByPage,
  quizGradingMode = 'server',
  quizLayout = 'default',
  appearance = 'default',
  quizGradingByPageId,
  quizUnsyncedSubmissionsByPageId,
  onRetryQuizGrading,
  renderQuizGradingFeedback,
  activePageId,
  initialPageId,
  onEvent,
  onNarrationLearnerIntent,
  onElementSelect,
  onElementsSelect,
  onNativeElementTransformChange,
  onNativeElementTransformStart,
  onNativeElementTransformEnd,
  onNativeTextFrameDoubleClick,
  editingNativeTableCellId,
  onNativeBlankCanvasDoubleClick,
  renderEditingNativeTextFrame,
  nativeStageOverlay,
  onPageChange,
  onActivityChange,
  onRuntimeStateChange,
  uploadQuizAnswerAsset,
  selectedElementId,
  currentTime: controlledCurrentTime,
  playing: controlledPlaying,
  narrationSeekRequest: externalNarrationSeekRequest,
  onCurrentTimeChange,
  onPlayingChange,
  playbackRate: controlledPlaybackRate,
  onPlaybackRateChange,
  autoAdvance = false,
  onAutoAdvanceChange,
  autoPlay = false,
  showNativeTimeline = true,
  timelineExtra,
  lastPageAction,
  enableWheelPageNavigation = true,
  pageNavigationLocked = false,
  isPageNavigable,
  showPageIndicator = false,
  showPageControls = false,
  showStaticSlideWhenNotPlaying = false,
  nativeAnimationPreview,
  showStaticSlideBeforePlayback = true,
  showNativeReadOnlyHint = false,
  editingNativeTextElementId,
  nativeResourceUrlsById = EMPTY_NATIVE_RESOURCE_URLS,
  nativeMediaScopeKey,
  onNativeMediaError,
  onNativeMediaLoaded,
  onNativeMediaPlayingChange,
  resolveScientificResource,
  scientificDependencyBaseUrl,
  reducedMotion,
  hideNativeDiagnostics = false,
  nativeSlideMaxWidth,
  controlTouchTarget,
  interactiveMode = 'learner',
  geometryHostMode = interactiveMode === 'authoring' ? 'authoring-edit' : 'learner',
  onInteractiveEmptyAction,
  onInteractiveUploadAction,
  onInteractiveComponentFocus,
  onGeometryEditProposal,
  showInteractiveNarrationBar = true,
  narratorAvatar,
  restrictNarrationForwardSeek,
}: ReachDeckPlayerProps) {
  const reconcileRuntime = (runtime: ReachDeckRuntimeByPageId, sourceDocument: ReachDeckDocument) =>
    reconcileReachDeckRuntime(runtime, sourceDocument, {
      migrateInteractiveRevision: geometryHostMode === 'authoring-edit',
    });
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const [activeIndex, setActiveIndex] = useState(() =>
    resolveInitialPageIndex(document, activePageId ?? initialPageId),
  );
  const [internalCurrentTime, setInternalCurrentTime] = useState(0);
  const [internalPlaying, setInternalPlaying] = useState(false);
  const [internalPlaybackRate, setInternalPlaybackRate] = useState(1);
  const [narrationVolume, setNarrationVolume] = useState<NarrationVolume>({
    muted: false,
    volume: 1,
  });
  // 每页正常播放到过的最远位置（秒），只随播放推进；受限页的向前跳转以它为上限。
  const furthestPlayedByPageIdRef = useRef(new Map<string, number>());
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  // A paused timeline seek is still an explicit presentation state. Keep the
  // editor's authored-static mode intact, but allow the player/harness to
  // inspect an animation frame without requiring a play click first.
  const [hasExplicitSeek, setHasExplicitSeek] = useState(false);
  const [narrationPlaybackReady, setNarrationPlaybackReady] = useState(false);
  const [narrationSeekRequest, setNarrationSeekRequest] = useState<ResolvedNarrationSeekRequest>();
  // 按音频资源 id 而非页缓存实测时长：删除或替换音频后旧时长自然失效，不会让无声页沿用旧音频时长；
  // 也不按签名地址缓存，Student、Teacher 定期续签只换地址，换了就丢时长会让越过声明时长的播放头回退。
  const [audioDurationByResourceId, setAudioDurationByResourceId] = useState<
    Readonly<Record<string, number>>
  >({});
  const defaultScientificResourceResolver = useMemo(
    () => createScientificVisualUrlResourceResolver(nativeResourceUrlsById),
    [nativeResourceUrlsById],
  );
  // 测验富文本里的图片只存稳定 objectKey；这里按文档的媒体清单翻成展示地址。
  const quizMediaUrlsByObjectKey = useMemo(
    () => reachDeckMediaUrlsByObjectKey(document, nativeResourceUrlsById),
    [document, nativeResourceUrlsById],
  );
  const mediaIdentity =
    (nativeMediaScopeKey ?? document.id) +
    ':' +
    JSON.stringify(
      document.schemaVersion === 'reach-deck-document/v2'
        ? document.resources.media.map(({ id, objectKey }) => [id, objectKey])
        : [],
    );
  const effectiveScientificResourceResolver =
    resolveScientificResource ?? defaultScientificResourceResolver;
  const currentTime = controlledCurrentTime ?? internalCurrentTime;
  const playing = controlledPlaying ?? internalPlaying;
  const playbackRate =
    controlledPlaybackRate !== undefined && isPlaybackRate(controlledPlaybackRate)
      ? controlledPlaybackRate
      : internalPlaybackRate;
  const currentTimeRef = useRef(currentTime);
  const narrationPositionRef = useRef(currentTime);
  const playingRef = useRef(playing);
  const narrationSeekRequestIdRef = useRef(0);
  const narrationSeekIntentStartRef = useRef<number | undefined>(undefined);
  // 当前这段幻灯片播放（已上报 narration_play、尚未上报暂停）的页面身份与最新位置。
  const slidePlaybackSessionRef = useRef<
    { context: NarrationIntentContext; positionSeconds: number } | undefined
  >(undefined);
  // 下一次 playing 变化若由学习者点出（点播放键），记下点击时的位置；其余变化一律按自动上报。
  const learnerPlaybackChangeRef = useRef<{ positionSeconds: number } | undefined>(undefined);
  const lastHandledExternalNarrationSeekRequestIdRef = useRef<number | undefined>(undefined);
  currentTimeRef.current = currentTime;
  playingRef.current = playing;
  const setCurrentTime = (next: number | ((current: number) => number)) => {
    const value = typeof next === 'function' ? next(currentTimeRef.current) : next;
    currentTimeRef.current = value;
    narrationPositionRef.current = value;
    const session = slidePlaybackSessionRef.current;
    if (session !== undefined && session.context.pageId === narrationPositionPageIdRef.current) {
      session.positionSeconds = value;
    }
    if (controlledCurrentTime === undefined) setInternalCurrentTime(value);
    onCurrentTimeChange?.(value);
  };
  const setPlaying = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(playingRef.current) : next;
    if (value) setHasStartedPlayback(true);
    playingRef.current = value;
    if (controlledPlaying === undefined) setInternalPlaying(value);
    onPlayingChange?.(value);
  };
  const lastWheelPageAtRef = useRef(0);
  const naturallyCompletedPageIdRef = useRef<string | undefined>(undefined);
  const pendingAutomaticPlaybackPageIdRef = useRef<string | undefined>(undefined);
  const [internalSelectedElementId, setInternalSelectedElementId] = useState<string>();
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystemReducedMotion(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  const effectiveReducedMotion = reducedMotion ?? systemReducedMotion;
  const [runtimeStore, setRuntimeStore] = useState<{
    documentId: string;
    byPageId: ReachDeckRuntimeByPageId;
  }>(() => ({
    documentId: document.id,
    byPageId: reconcileRuntime(initialRuntimeByPageId ?? {}, document),
  }));
  const [interactiveIframePool, setInteractiveIframePool] = useState(() =>
    createInteractiveIframePoolState(),
  );
  const activePage = document.pages[activeIndex] ?? document.pages[0];
  const narrationPositionPageIdRef = useRef(activePage?.pageId);
  if (narrationPositionPageIdRef.current !== activePage?.pageId) {
    narrationPositionPageIdRef.current = activePage?.pageId;
    narrationPositionRef.current = 0;
  }
  const orderedPages = useMemo(
    () => [...document.pages].sort((left, right) => left.order - right.order),
    [document.pages],
  );
  const orderedIndex = activePage
    ? orderedPages.findIndex((page) => page.pageId === activePage.pageId)
    : -1;
  const activeNativeSlide =
    document.schemaVersion === 'reach-deck-document/v2' && activePage !== undefined
      ? document.nativeSlides?.find((binding) => binding.pageId === activePage.pageId)?.slide
      : undefined;
  const previewAnimation = nativeAnimationPreview?.animation;
  const renderedNativeSlide = useMemo(
    () =>
      activeNativeSlide === undefined || previewAnimation === undefined
        ? activeNativeSlide
        : { ...activeNativeSlide, animations: [previewAnimation] },
    [activeNativeSlide, previewAnimation],
  );
  const resolvedNarrationAudioSrc =
    activeNativeSlide?.narration?.audioResourceId === undefined
      ? undefined
      : nativeResourceUrlsById[activeNativeSlide.narration.audioResourceId];
  const narrationAudioSrc =
    resolvedNarrationAudioSrc === undefined || resolvedNarrationAudioSrc.trim().length === 0
      ? undefined
      : resolvedNarrationAudioSrc;
  const narrationAudioResourceId =
    narrationAudioSrc === undefined ? undefined : activeNativeSlide?.narration?.audioResourceId;
  const interactiveNarration =
    activePage?.sceneType === 'interactive' ? activePage.scene.narration : undefined;
  const resolvedInteractiveNarrationAudioSrc =
    interactiveNarration?.audioResourceId === undefined
      ? undefined
      : nativeResourceUrlsById[interactiveNarration.audioResourceId];
  const interactiveNarrationAudioSrc =
    resolvedInteractiveNarrationAudioSrc === undefined ||
    resolvedInteractiveNarrationAudioSrc.trim().length === 0
      ? undefined
      : resolvedInteractiveNarrationAudioSrc;
  const requestNarrationSeek = (time: number) => {
    if (narrationAudioSrc === undefined) return;
    narrationPositionRef.current = time;
    narrationSeekRequestIdRef.current += 1;
    setNarrationSeekRequest({
      id: narrationSeekRequestIdRef.current,
      pageId: activePage?.pageId ?? '',
      src: narrationAudioSrc,
      time,
    });
  };
  const restrictNarrationForwardSeekRef = useRef(restrictNarrationForwardSeek);
  restrictNarrationForwardSeekRef.current = restrictNarrationForwardSeek;
  const notePlaybackPosition = (pageId: string | undefined, time: number) => {
    if (pageId === undefined || !Number.isFinite(time)) return;
    const furthest = furthestPlayedByPageIdRef.current;
    if (time > (furthest.get(pageId) ?? 0)) furthest.set(pageId, time);
  };
  /** 受限页（学习者还没学过）向前跳转的上限；不受限时为 undefined。 */
  const narrationSeekLimitFor = (page: ReachDeckPublishedPage | undefined) => {
    if (page === undefined || page.sceneType !== 'slide') return undefined;
    if (restrictNarrationForwardSeekRef.current?.(page) !== true) return undefined;
    return furthestPlayedByPageIdRef.current.get(page.pageId) ?? 0;
  };
  const effectiveDuration =
    activePage?.sceneType === 'slide' && activeNativeSlide !== undefined
      ? getReachDeckNativeSlideEffectiveDuration(
          activeNativeSlide,
          narrationAudioResourceId === undefined
            ? undefined
            : audioDurationByResourceId[narrationAudioResourceId],
        )
      : undefined;
  /** 把一次跳转目标收进 [0, 时长]，受限页再收到已播放的最远位置。 */
  const clampNarrationSeek = (time: number) => {
    const limit = narrationSeekLimitFor(activePage);
    const upper = Math.min(effectiveDuration ?? 0, limit ?? Number.POSITIVE_INFINITY);
    return Math.max(0, Math.min(upper, Number.isFinite(time) ? time : 0));
  };
  const latestDocumentRef = useRef(document);
  latestDocumentRef.current = document;
  const onElementSelectRef = useRef(onElementSelect);
  const onElementsSelectRef = useRef(onElementsSelect);
  const onEventRef = useRef(onEvent);
  const onNarrationLearnerIntentRef = useRef(onNarrationLearnerIntent);
  const onPageChangeRef = useRef(onPageChange);
  const onActivityChangeRef = useRef(onActivityChange);
  const onRuntimeStateChangeRef = useRef(onRuntimeStateChange);
  const emittedRuntimeRef = useRef(runtimeStore.byPageId);
  const lastEmittedPageEnterIdentityRef = useRef<string | undefined>(undefined);
  onElementSelectRef.current = onElementSelect;
  onElementsSelectRef.current = onElementsSelect;
  onEventRef.current = onEvent;
  onNarrationLearnerIntentRef.current = onNarrationLearnerIntent;
  onPageChangeRef.current = onPageChange;
  onActivityChangeRef.current = onActivityChange;
  onRuntimeStateChangeRef.current = onRuntimeStateChange;
  const narrationIntentContext = (() => {
    if (activePage?.sceneType === 'slide' && narrationAudioSrc !== undefined) {
      return {
        pageId: activePage.pageId,
        revision: activePage.revision,
        sceneId: activePage.pageId,
      };
    }
    if (activePage?.sceneType === 'interactive' && interactiveNarrationAudioSrc !== undefined) {
      return {
        pageId: activePage.pageId,
        revision: activePage.revision,
        sceneId: activePage.scene.id,
      };
    }
    return undefined;
  })();
  const slideNarrationContextRef = useRef<NarrationIntentContext | undefined>(undefined);
  slideNarrationContextRef.current =
    activePage?.sceneType === 'slide' ? narrationIntentContext : undefined;
  const emitNarrationIntent = (
    intent:
      | { type: 'narration_play' | 'narration_pause'; positionMs: number }
      | { type: 'narration_seek'; fromMs: number; toMs: number }
      | {
          type: 'narration_rate_change';
          fromRate: number;
          positionMs: number;
          toRate: number;
        },
  ) => {
    if (narrationIntentContext === undefined) return;
    onNarrationLearnerIntentRef.current?.({ ...narrationIntentContext, ...intent });
  };
  const commitNarrationSeekIntent = (nextSeconds: number) => {
    const fromSeconds = narrationSeekIntentStartRef.current;
    narrationSeekIntentStartRef.current = undefined;
    if (
      fromSeconds === undefined ||
      Math.abs(nextSeconds - fromSeconds) < NARRATION_INTENT_SEEK_TOLERANCE_SECONDS
    ) {
      return;
    }
    emitNarrationIntent({
      fromMs: toNarrationMilliseconds(fromSeconds),
      toMs: toNarrationMilliseconds(nextSeconds),
      type: 'narration_seek',
    });
  };
  const runtimeByPageId =
    runtimeStore.documentId === document.id
      ? reconcileRuntime(runtimeStore.byPageId, document)
      : {};
  const interactivePagesById = useMemo(
    () =>
      new Map(
        document.pages
          .filter(
            (page): page is Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }> =>
              page.sceneType === 'interactive' &&
              !isInteractiveBlankDocument(page.scene.documentHtml),
          )
          .map((page) => [page.pageId, page]),
      ),
    [document.pages],
  );

  useEffect(() => {
    const previous = emittedRuntimeRef.current;
    for (const [pageId, state] of Object.entries(runtimeByPageId)) {
      if (previous[pageId] !== state) onRuntimeStateChangeRef.current?.(pageId, state);
    }
    emittedRuntimeRef.current = runtimeByPageId;
  }, [runtimeByPageId]);
  const validInteractivePageIds = useMemo(
    () => new Set(interactivePagesById.keys()),
    [interactivePagesById],
  );
  const activeInteractivePageId =
    activePage?.sceneType === 'interactive' && interactivePagesById.has(activePage.pageId)
      ? activePage.pageId
      : undefined;
  const renderedInteractiveIframePool = useMemo(
    () =>
      reconcileInteractiveIframePool(
        interactiveIframePool,
        validInteractivePageIds,
        activeInteractivePageId,
      ),
    [activeInteractivePageId, interactiveIframePool, validInteractivePageIds],
  );

  useEffect(() => {
    setActiveIndex(resolveInitialPageIndex(document, activePageId ?? initialPageId));
  }, [activePageId, document.id, document.pages, initialPageId]);

  useEffect(() => {
    setRuntimeStore((current) => {
      if (current.documentId !== document.id) return { documentId: document.id, byPageId: {} };
      const reconciled = reconcileRuntime(current.byPageId, document);
      return reconciled === current.byPageId ? current : { ...current, byPageId: reconciled };
    });
  }, [document.id, document.pages, geometryHostMode]);

  useEffect(() => {
    if (renderedInteractiveIframePool !== interactiveIframePool) {
      setInteractiveIframePool(renderedInteractiveIframePool);
    }
  }, [interactiveIframePool, renderedInteractiveIframePool]);

  // Reset playback and editor selection only when the displayed page changes.
  // A native-v2 editor increments page revision for element edits; revision
  // changes must not clear the element that the teacher is currently editing.
  // A controlled activePageId reaches activeIndex in a separate effect. Resetting
  // on that prop early would overwrite the previous page's closing position.
  useEffect(() => {
    const continueAutomaticPlayback =
      activePage?.sceneType === 'slide' &&
      (autoPlay ||
        (autoAdvance && pendingAutomaticPlaybackPageIdRef.current === activePage.pageId));
    pendingAutomaticPlaybackPageIdRef.current = undefined;
    naturallyCompletedPageIdRef.current = undefined;
    setCurrentTime(0);
    setPlaying(continueAutomaticPlayback);
    setHasStartedPlayback(false);
    setHasExplicitSeek(false);
    setInternalSelectedElementId(undefined);
    onElementSelectRef.current?.(undefined);
    onElementsSelectRef.current?.([]);
  }, [activePage?.pageId]);

  // 幻灯片播放区间上报：playing 的每次变化（以及播放中换页、讲稿地址就绪）都收口上一段、打开新一段。
  // 声明在换页重置之后，换页时读到的已是新页的 0 位置；旧页的最后位置留在 session 里。
  useEffect(() => {
    const learner = learnerPlaybackChangeRef.current;
    learnerPlaybackChangeRef.current = undefined;
    const context = activePage?.sceneType === 'slide' ? narrationIntentContext : undefined;
    const session = slidePlaybackSessionRef.current;
    const sameContext =
      session !== undefined &&
      context !== undefined &&
      session.context.pageId === context.pageId &&
      session.context.revision === context.revision;
    if (session !== undefined && (!playing || !sameContext)) {
      slidePlaybackSessionRef.current = undefined;
      const learnerPause = learner !== undefined && sameContext;
      onNarrationLearnerIntentRef.current?.({
        ...session.context,
        positionMs: toNarrationMilliseconds(
          learnerPause ? learner.positionSeconds : session.positionSeconds,
        ),
        type: 'narration_pause',
        ...(learnerPause ? {} : { automatic: true as const }),
      });
    }
    if (playing && context !== undefined && slidePlaybackSessionRef.current === undefined) {
      const positionSeconds = learner?.positionSeconds ?? currentTimeRef.current;
      slidePlaybackSessionRef.current = { context, positionSeconds };
      onNarrationLearnerIntentRef.current?.({
        ...context,
        positionMs: toNarrationMilliseconds(positionSeconds),
        type: 'narration_play',
        ...(learner === undefined ? { automatic: true as const } : {}),
      });
    }
  }, [activePage?.pageId, activePage?.revision, narrationAudioSrc, playing]);

  // 播放器卸载（站内离开学习页）或页面卸载（刷新、关闭）时收口正在播放的一段。
  // 页面卸载不会触发 React 卸载，只能靠 pagehide；从往返缓存恢复且仍在播放时重新打开一段。
  useEffect(() => {
    const closeSession = (pageHide: boolean) => {
      const session = slidePlaybackSessionRef.current;
      if (session === undefined) return;
      slidePlaybackSessionRef.current = undefined;
      onNarrationLearnerIntentRef.current?.({
        ...session.context,
        automatic: true,
        positionMs: toNarrationMilliseconds(session.positionSeconds),
        type: 'narration_pause',
        ...(pageHide ? { pageHide: true as const } : {}),
      });
    };
    const onPageHide = () => closeSession(true);
    const onPageShow = (event: PageTransitionEvent) => {
      const context = slideNarrationContextRef.current;
      if (!event.persisted || !playingRef.current || context === undefined) return;
      if (slidePlaybackSessionRef.current !== undefined) return;
      const positionSeconds = currentTimeRef.current;
      slidePlaybackSessionRef.current = { context, positionSeconds };
      onNarrationLearnerIntentRef.current?.({
        ...context,
        automatic: true,
        positionMs: toNarrationMilliseconds(positionSeconds),
        type: 'narration_play',
      });
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      closeSession(false);
    };
  }, []);

  useEffect(() => {
    if (activePage === undefined) return;
    if (activePageId !== undefined && activePage.pageId !== activePageId) return;
    const pageEnterIdentity = `${document.id}:${activePage.pageId}:${activePage.revision}`;
    if (lastEmittedPageEnterIdentityRef.current === pageEnterIdentity) return;
    lastEmittedPageEnterIdentityRef.current = pageEnterIdentity;
    if (activePageId === undefined) onPageChangeRef.current?.(activePage);
    onEventRef.current?.({
      type: 'pageEnter',
      pageId: activePage.pageId,
      revision: activePage.revision,
      sceneType: activePage.sceneType,
    });
  }, [activePage?.pageId, activePage?.revision, activePageId, document.id]);

  useEffect(() => {
    if (autoAdvance || autoPlay) return;
    pendingAutomaticPlaybackPageIdRef.current = undefined;
  }, [autoAdvance, autoPlay]);

  useEffect(() => {
    if (activePage === undefined) return;
    onActivityChangeRef.current?.(
      playerActivityFor(activePage, runtimeByPageId[activePage.pageId], {
        currentTime,
        playing,
      }),
    );
  }, [activePage, currentTime, playing, runtimeByPageId]);

  useEffect(() => {
    if (playing) setHasStartedPlayback(true);
  }, [playing]);

  useEffect(() => {
    setNarrationPlaybackReady(false);
    setNarrationSeekRequest(undefined);
  }, [activePage?.pageId, narrationAudioResourceId]);

  useEffect(() => {
    const request = externalNarrationSeekRequest;
    if (request === undefined) return;
    const handledId = lastHandledExternalNarrationSeekRequestIdRef.current;
    if (handledId !== undefined && request.id <= handledId) return;
    if (request.pageId !== activePage?.pageId) {
      lastHandledExternalNarrationSeekRequestIdRef.current = request.id;
      return;
    }
    if (narrationAudioSrc === undefined) return;
    lastHandledExternalNarrationSeekRequestIdRef.current = request.id;
    requestNarrationSeek(clampNarrationSeek(request.time));
  }, [activePage?.pageId, externalNarrationSeekRequest, narrationAudioSrc]);

  useEffect(() => {
    if (
      !playing ||
      effectiveDuration === undefined ||
      (narrationAudioSrc !== undefined && !narrationPlaybackReady)
    ) {
      return;
    }
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.max(0, (now - previous) / 1_000);
      previous = now;
      const next = Math.min(effectiveDuration, currentTimeRef.current + elapsed * playbackRate);
      setCurrentTime(next);
      notePlaybackPosition(activePage?.pageId, next);
      if (next >= effectiveDuration) finishPlaybackNaturally(effectiveDuration);
    }, 50);
    return () => window.clearInterval(timer);
  }, [
    activePage?.pageId,
    activePageId,
    autoAdvance,
    autoPlay,
    document.pages,
    effectiveDuration,
    onPageChange,
    orderedIndex,
    orderedPages,
    pageNavigationLocked,
    playbackRate,
    playing,
    narrationAudioSrc,
    narrationPlaybackReady,
  ]);

  useEffect(() => {
    if (effectiveDuration === undefined) return;
    if (currentTimeRef.current <= effectiveDuration) return;
    setCurrentTime(effectiveDuration);
    setPlaying(false);
  }, [effectiveDuration]);

  if (document.schemaVersion !== 'reach-deck-document/v2') {
    return (
      <div className="reach-deck-player__unsupported" role="alert">
        {text('reachDeck.player.legacyUnsupported', '旧版 Reach Deck 不受支持')}
      </div>
    );
  }

  if (activePage === undefined) {
    return (
      <div className="reach-deck-player__empty">
        {text('reachDeck.player.empty', 'Reach Deck 暂无内容。')}
      </div>
    );
  }

  const canNavigateToOrderedPage = (index: number) => {
    if (pageNavigationLocked) return false;
    const page = orderedPages[index];
    if (page === undefined) return false;
    return isPageNavigable === undefined || isPageNavigable(page);
  };

  // The next page exists and nothing else locks navigation, yet the host keeps it unreachable.
  const nextPageLockedByReachability =
    !pageNavigationLocked &&
    isPageNavigable !== undefined &&
    orderedIndex >= 0 &&
    orderedPages[orderedIndex + 1] !== undefined &&
    !isPageNavigable(orderedPages[orderedIndex + 1]!);

  const selectOrderedPage = (index: number, reason: 'automatic' | 'manual' = 'manual') => {
    if (!canNavigateToOrderedPage(index)) return;
    const page = orderedPages[index];
    if (page === undefined) return;
    if (reason === 'manual') pendingAutomaticPlaybackPageIdRef.current = undefined;
    if (activePageId !== undefined) {
      onPageChange?.(page);
      return;
    }
    const documentIndex = document.pages.findIndex((candidate) => candidate.pageId === page.pageId);
    if (documentIndex >= 0) setActiveIndex(documentIndex);
  };

  const finishPlaybackNaturally = (duration: number) => {
    if (!playingRef.current || activePage.sceneType !== 'slide') return;
    if (naturallyCompletedPageIdRef.current === activePage.pageId) return;
    naturallyCompletedPageIdRef.current = activePage.pageId;
    notePlaybackPosition(activePage.pageId, duration);
    setCurrentTime(duration);
    setPlaying(false);
    if (!(autoAdvance || autoPlay) || !canNavigateToOrderedPage(orderedIndex + 1)) return;
    const nextPage = orderedPages[orderedIndex + 1];
    if (nextPage === undefined) return;
    pendingAutomaticPlaybackPageIdRef.current =
      nextPage.sceneType === 'slide' ? nextPage.pageId : undefined;
    selectOrderedPage(orderedIndex + 1, 'automatic');
  };

  // 幻灯片外空白区滚轮翻页；节流避免一次滚动手势连翻多页。
  const onStageWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!enableWheelPageNavigation || pageNavigationLocked) return;
    if (event.currentTarget !== event.target) return;
    if (Math.abs(event.deltaY) < WHEEL_PAGE_THRESHOLD) return;
    const now = Date.now();
    if (now - lastWheelPageAtRef.current < WHEEL_PAGE_COOLDOWN_MS) return;
    const next = orderedIndex + (event.deltaY > 0 ? 1 : -1);
    if (next < 0 || next >= orderedPages.length) return;
    if (!canNavigateToOrderedPage(next)) return;
    lastWheelPageAtRef.current = now;
    selectOrderedPage(next);
  };

  const renderPreviousPageButton = () => (
    <button
      aria-label={text('reachDeck.player.previousPage', '上一页')}
      className="reach-deck-player__transport"
      disabled={orderedIndex <= 0 || !canNavigateToOrderedPage(orderedIndex - 1)}
      onClick={() => selectOrderedPage(orderedIndex - 1)}
      title={text('reachDeck.player.previousPage', '上一页')}
      type="button"
    >
      <ChevronLeft className="reach-deck-player__page-arrow" size={17} />
      {/* 文字只在学习者讲稿区的宽 / 中档显示（见 LearnerNarrationDock），其余宿主只有图标。 */}
      <span aria-hidden="true" className="reach-deck-player__control-label">
        {text('reachDeck.player.previousPage', '上一页')}
      </span>
    </button>
  );

  const renderNextPageButton = () =>
    lastPageAction !== undefined &&
    orderedIndex >= 0 &&
    orderedIndex === orderedPages.length - 1 ? (
      lastPageAction
    ) : (
      <button
        aria-label={text('reachDeck.player.nextPage', '下一页')}
        className="reach-deck-player__transport"
        disabled={
          orderedIndex < 0 ||
          orderedIndex >= orderedPages.length - 1 ||
          !canNavigateToOrderedPage(orderedIndex + 1)
        }
        onClick={() => selectOrderedPage(orderedIndex + 1)}
        title={
          nextPageLockedByReachability
            ? text('reachDeck.player.nextPageLocked', '学完本页后解锁下一页')
            : text('reachDeck.player.nextPage', '下一页')
        }
        type="button"
      >
        <ChevronRight className="reach-deck-player__page-arrow" size={17} />
        <span aria-hidden="true" className="reach-deck-player__control-label">
          {text('reachDeck.player.nextPage', '下一页')}
        </span>
      </button>
    );

  const renderPageIndicator = () =>
    showPageIndicator && orderedIndex >= 0 ? (
      <span className="reach-deck-player__page-indicator" data-reach-deck-page-indicator>
        <span aria-hidden="true">
          {orderedIndex + 1}/{orderedPages.length}
        </span>
        <span className="reach-deck-player__sr-only">
          {text('reachDeck.player.pageIndicator', '第 {current} 页，共 {total} 页', {
            current: orderedIndex + 1,
            total: orderedPages.length,
          })}
        </span>
      </span>
    ) : null;

  const autoAdvanceLabelId = useId();
  // 自动翻页是带文字的开关（读屏读作「自动翻页，开关，已开启/已关闭」），不与「下一页」混淆。
  const renderTimelineExtra = () =>
    onAutoAdvanceChange === undefined && timelineExtra === undefined ? null : (
      <div className="reach-deck-player__timeline-extra">
        {onAutoAdvanceChange === undefined ? null : (
          <span className="reach-deck-player__auto-advance" data-reach-deck-auto-advance>
            <span id={autoAdvanceLabelId}>{text('reachDeck.player.autoAdvance', '自动翻页')}</span>
            <Switch
              aria-labelledby={autoAdvanceLabelId}
              checked={autoAdvance}
              onCheckedChange={onAutoAdvanceChange}
              size="sm"
            />
          </span>
        )}
        {timelineExtra}
      </div>
    );

  const toggleSlidePlayback = () => {
    const wasPlaying = playingRef.current;
    const restartingFromEnd = !wasPlaying && currentTimeRef.current >= (effectiveDuration ?? 0);
    if (restartingFromEnd) {
      naturallyCompletedPageIdRef.current = undefined;
      setCurrentTime(0);
      requestNarrationSeek(0);
    }
    // 播放 / 暂停事件由下方的 playing 变化统一上报，这里只标记这次变化来自学习者及其位置。
    learnerPlaybackChangeRef.current = {
      positionSeconds: restartingFromEnd ? 0 : currentTimeRef.current,
    };
    setPlaying(!wasPlaying);
  };

  /** 拖动 / 键盘调整进度：目标先收进可达范围（受限页不超过已播放的最远位置）。 */
  const seekSlideNarration = (time: number) => {
    const next = clampNarrationSeek(time);
    if (next < (effectiveDuration ?? 0)) naturallyCompletedPageIdRef.current = undefined;
    setHasExplicitSeek(true);
    setCurrentTime(next);
    requestNarrationSeek(next);
  };

  /** 快退 / 快进按钮是一次完整的跳转，直接记一条 narration_seek 意图。 */
  const skipSlideNarration = (deltaSeconds: number) => {
    const from = currentTimeRef.current;
    const to = clampNarrationSeek(from + deltaSeconds);
    if (Math.abs(to - from) < NARRATION_INTENT_SEEK_TOLERANCE_SECONDS) return;
    seekSlideNarration(to);
    emitNarrationIntent({
      fromMs: toNarrationMilliseconds(from),
      toMs: toNarrationMilliseconds(to),
      type: 'narration_seek',
    });
  };

  const changeSlidePlaybackRate = (nextRate: number) => {
    if (!isPlaybackRate(nextRate)) {
      return;
    }
    const previousRate = playbackRate;
    if (nextRate === previousRate) return;
    setInternalPlaybackRate(nextRate);
    onPlaybackRateChange?.(nextRate);
    emitNarrationIntent({
      fromRate: previousRate,
      positionMs: toNarrationMilliseconds(currentTimeRef.current),
      toRate: nextRate,
      type: 'narration_rate_change',
    });
  };

  const renderSlideRateSelect = () => (
    <PlaybackRateSelect
      className="reach-deck-player__rate"
      onChange={changeSlidePlaybackRate}
      touchTarget={controlTouchTarget}
      translate={translate}
      value={playbackRate}
    />
  );

  const pageNumber =
    orderedIndex >= 0 ? { current: orderedIndex + 1, total: orderedPages.length } : undefined;

  /** 学习者讲稿区里翻页与宿主扩展位（自动播放、笔记……）这一段，幻灯片与 GenUI 共用。 */
  const renderLearnerNavigation = () => (
    <>
      <div className="reach-deck-player__transport-group">
        {renderPreviousPageButton()}
        {renderNextPageButton()}
      </div>
      {renderTimelineExtra()}
    </>
  );

  const renderLearnerSlideDock = (caption: ReactNode) => {
    const duration = effectiveDuration ?? 0;
    const seekLimit = narrationSeekLimitFor(activePage);
    const forwardLimit = Math.min(duration, seekLimit ?? Number.POSITIVE_INFINITY);
    return (
      <LearnerNarrationDock
        avatar={narratorAvatar}
        caption={caption}
        controls={
          <>
            <div className="reach-deck-player__transport-group">
              <NarrationSkipButton
                direction="backward"
                disabled={currentTime <= NARRATION_INTENT_SEEK_TOLERANCE_SECONDS}
                onClick={() => skipSlideNarration(-NARRATION_SKIP_SECONDS)}
                translate={translate}
              />
              <NarrationSkipButton
                direction="forward"
                disabled={currentTime >= forwardLimit - NARRATION_INTENT_SEEK_TOLERANCE_SECONDS}
                onClick={() => skipSlideNarration(NARRATION_SKIP_SECONDS)}
                translate={translate}
              />
              <NarrationVolumeControl
                disabled={narrationAudioSrc === undefined}
                onChange={setNarrationVolume}
                translate={translate}
                value={narrationVolume}
              />
              <NarrationRateControl
                onChange={changeSlidePlaybackRate}
                translate={translate}
                value={playbackRate}
              />
            </div>
            {renderLearnerNavigation()}
          </>
        }
        onTogglePlay={toggleSlidePlayback}
        pageId={activePage.pageId}
        pageNumber={showPageIndicator ? pageNumber : undefined}
        playDisabled={duration <= 0}
        playing={playing}
        progress={
          duration <= 0
            ? undefined
            : {
                currentTime,
                duration,
                ...(seekLimit === undefined ? {} : { seekLimit }),
                onSeek: seekSlideNarration,
                onSeekCancel: () => {
                  narrationSeekIntentStartRef.current = undefined;
                },
                onSeekCommit: (time) => commitNarrationSeekIntent(clampNarrationSeek(time)),
                onSeekStart: () => {
                  if (narrationSeekIntentStartRef.current === undefined) {
                    narrationSeekIntentStartRef.current = currentTimeRef.current;
                  }
                },
              }
        }
        timelineKind="native-v2"
        translate={translate}
      />
    );
  };

  // 题目页与互动页没有原生时间轴：宿主开启后在其下方给出同一套翻页控件与宿主扩展位。
  // 学习者 GenUI 讲稿区自带翻页与扩展位，不再另起一条控制条。
  const interactiveNarrationDocked =
    appearance === 'learner' &&
    showInteractiveNarrationBar &&
    activePage.sceneType === 'interactive' &&
    interactiveNarration !== undefined;
  const showSceneControlBar =
    showPageControls && activePage.sceneType !== 'slide' && !interactiveNarrationDocked;

  return (
    <section
      aria-label={document.title}
      className="reach-deck-player"
      data-reach-deck-appearance={appearance}
      data-control-touch-target={controlTouchTarget}
      data-page-id={activePage.pageId}
      data-scene-type={activePage.sceneType}
    >
      <div className="reach-deck-player__stage" onWheel={onStageWheel}>
        {activePage.sceneType === 'interactive' && activeInteractivePageId !== undefined
          ? null
          : renderPage()}
        {renderedInteractiveIframePool.pageIds.map((pageId) => {
          const page = interactivePagesById.get(pageId);
          if (!page) return null;
          const visible = page.pageId === activeInteractivePageId;
          const state = runtimeByPageId[page.pageId];
          const interactiveState = state?.kind === 'interactive' ? state : undefined;
          return (
            <div
              aria-hidden={visible ? undefined : true}
              data-interactive-page-id={page.pageId}
              hidden={!visible}
              key={`${document.id}:${page.pageId}:${page.revision}:${page.scene.id}`}
            >
              <InteractiveScenePlayer
                attempt={interactiveState?.attempt ?? 1}
                authoring={interactiveMode === 'authoring'}
                geometryHostMode={geometryHostMode}
                dependencyBaseUrl={scientificDependencyBaseUrl}
                onComplete={() => {
                  updateRuntime(document.id, page, (current) => ({
                    ...interactiveRuntimeFor(page, current),
                    completed: true,
                  }));
                  onEvent?.({ type: 'interactiveComplete', pageId: page.pageId });
                }}
                onError={(error) =>
                  updateRuntime(document.id, page, (current) => ({
                    ...interactiveRuntimeFor(page, current),
                    errorCode: error.code,
                  }))
                }
                onPhaseChange={(phase) =>
                  updateRuntime(document.id, page, (current) => ({
                    ...interactiveRuntimeFor(page, current),
                    phase,
                    ...(phase === 'booting' || phase === 'active' ? { errorCode: undefined } : {}),
                  }))
                }
                onReady={(payload) => {
                  const restored =
                    typeof payload === 'object' &&
                    payload !== null &&
                    (payload as { restored?: unknown }).restored === true;
                  if (restored) return;
                  updateRuntime(document.id, page, (current) => {
                    const runtime = interactiveRuntimeFor(page, current);
                    if (runtime.snapshot === undefined && !runtime.completed) return runtime;
                    const {
                      geometry: _invalidGeometry,
                      snapshot: _invalidSnapshot,
                      ...withoutSnapshot
                    } = runtime;
                    return { ...withoutSnapshot, completed: false };
                  });
                }}
                onInteraction={(event) =>
                  onEventRef.current?.({
                    type: 'interactiveLearningEvent',
                    pageId: page.pageId,
                    sceneId: page.scene.id,
                    revision: page.revision,
                    manifestVersion: page.scene.eventManifest.schemaVersion,
                    eventName: event.name,
                    eventVersion: event.eventVersion,
                    payload: event.payload,
                    wireSequence: event.wireSequence,
                  })
                }
                onComponentFocus={onInteractiveComponentFocus}
                onGeometryEditProposal={onGeometryEditProposal}
                onReset={(attempt) =>
                  updateRuntime(document.id, page, () => ({
                    ...interactiveRuntimeFor(page),
                    attempt,
                    phase: 'active',
                  }))
                }
                onStateChange={(snapshot) =>
                  updateRuntime(document.id, page, (current) => ({
                    ...interactiveRuntimeFor(page, current),
                    ...splitInteractiveSnapshot(snapshot),
                  }))
                }
                restoredSnapshot={composeInteractiveSnapshot(interactiveState)}
                pageId={page.pageId}
                scene={page.scene}
                sourceRevision={page.revision}
                translate={translate}
                locale={locale}
                visible={visible}
              />
            </div>
          );
        })}
        {showInteractiveNarrationBar &&
        activePage.sceneType === 'interactive' &&
        interactiveNarration !== undefined ? (
          <InteractiveNarrationBar
            key={mediaIdentity}
            audioSrc={interactiveNarrationAudioSrc}
            onMediaError={
              onNativeMediaError === undefined
                ? undefined
                : (src) => {
                    if (interactiveNarration.audioResourceId)
                      onNativeMediaError(interactiveNarration.audioResourceId, src);
                  }
            }
            onMediaLoaded={(src) => {
              if (interactiveNarration.audioResourceId)
                onNativeMediaLoaded?.(interactiveNarration.audioResourceId, src);
            }}
            onMediaPlayingChange={(playing) => {
              if (interactiveNarration.audioResourceId)
                onNativeMediaPlayingChange?.(interactiveNarration.audioResourceId, playing);
            }}
            autoPlay={autoPlay}
            {...(appearance === 'learner'
              ? {
                  avatar: narratorAvatar,
                  layout: 'dock' as const,
                  navigation: renderLearnerNavigation(),
                  onVolumeChange: setNarrationVolume,
                  pageNumber: showPageIndicator ? pageNumber : undefined,
                  volume: narrationVolume,
                }
              : {})}
            scrollable={appearance === 'learner'}
            onPause={(positionSeconds) =>
              emitNarrationIntent({
                positionMs: toNarrationMilliseconds(positionSeconds),
                type: 'narration_pause',
              })
            }
            onPlay={(positionSeconds) =>
              emitNarrationIntent({
                positionMs: toNarrationMilliseconds(positionSeconds),
                type: 'narration_play',
              })
            }
            onRateChange={(fromRate, toRate, positionSeconds) =>
              emitNarrationIntent({
                fromRate,
                positionMs: toNarrationMilliseconds(positionSeconds),
                toRate,
                type: 'narration_rate_change',
              })
            }
            pageId={activePage.pageId}
            text={interactiveNarration.text}
            touchTarget={controlTouchTarget}
            translate={translate}
          />
        ) : null}
      </div>
      {showSceneControlBar ? (
        <div
          className="reach-deck-player__timeline reach-deck-player__page-controls"
          data-reach-deck-timeline="page-controls"
        >
          <div className="reach-deck-player__transport-group">
            {renderPreviousPageButton()}
            {renderNextPageButton()}
          </div>
          {renderPageIndicator()}
          {renderTimelineExtra()}
        </div>
      ) : null}
    </section>
  );

  function renderPage() {
    switch (activePage.sceneType) {
      case 'slide': {
        if (activeNativeSlide !== undefined) {
          const themeColors =
            document.schemaVersion === 'reach-deck-document/v2'
              ? document.resources.themes.find((theme) => theme.id === document.defaultThemeId)
                  ?.colors
              : undefined;
          const narrationSegment = getActiveNarrationSegmentV2(activeNativeSlide, currentTime);
          const narrationSegmentIndex =
            narrationSegment === undefined
              ? -1
              : (activeNativeSlide.narration?.segments?.indexOf(narrationSegment) ?? -1);
          // 字幕文本单独解析：短空档沿用上一句、修整句首标点；动画高亮仍按严格命中的分段。
          const narrationCaption = getNarrationCaptionV2(activeNativeSlide, currentTime);
          const showNativeCaption = activeNativeSlide.narration !== undefined;
          const nativeVisualTime =
            nativeAnimationPreview?.time ??
            (showStaticSlideWhenNotPlaying
              ? playing
                ? currentTime
                : undefined
              : showStaticSlideBeforePlayback && !hasStartedPlayback && !playing && !hasExplicitSeek
                ? undefined
                : currentTime);
          return (
            <div
              style={{ width: '100%' }}
              {...(onElementSelect === undefined
                ? { 'data-native-v2-readonly': true }
                : { 'data-native-v2-editable': true })}
            >
              {showNativeReadOnlyHint ? (
                <p role="status">
                  {text(
                    'reachDeck.player.nativeReadOnly',
                    '该原生幻灯片可见，但在当前编辑器中只读。',
                  )}
                </p>
              ) : null}
              <NativeV2SlideRenderer
                maxWidth={appearance === 'learner' ? undefined : nativeSlideMaxWidth}
                viewportMaxWidth={appearance === 'learner' ? nativeSlideMaxWidth : undefined}
                resourceMimeTypesById={Object.fromEntries(
                  document.resources.media.map((resource) => [resource.id, resource.contentType]),
                )}
                trustedAnimatedGifResourceIds={
                  new Set(
                    document.resources.media
                      .filter(
                        (resource) =>
                          resource.contentType.toLowerCase() === 'image/gif' &&
                          resource.origin?.route === 'diagram' &&
                          resource.origin.engine === 'code',
                      )
                      .map((resource) => resource.id),
                  )
                }
                animationControlLabel={(action) =>
                  action === 'play'
                    ? text('reachDeck.player.animationPlay', 'Play animation')
                    : action === 'pause'
                      ? text('reachDeck.player.animationPause', 'Pause animation')
                      : text('reachDeck.player.animationUnavailable', 'Animation unavailable')
                }
                audioControlLabel={(title) =>
                  text('reachDeck.player.audioControl', 'Audio: {title}', { title })
                }
                currentTime={nativeVisualTime}
                effectiveDuration={effectiveDuration}
                hideDiagnostics={hideNativeDiagnostics}
                playbackRate={playbackRate}
                playing={playing}
                reducedMotion={effectiveReducedMotion}
                resolveScientificResource={effectiveScientificResourceResolver}
                resourceUrlsById={nativeResourceUrlsById}
                mediaScopeKey={mediaIdentity}
                onMediaError={onNativeMediaError}
                onMediaLoaded={onNativeMediaLoaded}
                onMediaPlayingChange={onNativeMediaPlayingChange}
                scientificDependencyBaseUrl={scientificDependencyBaseUrl}
                scientificSourceRevision={activePage.revision}
                scientificStaticMode={nativeVisualTime === undefined}
                selectedElementId={selectedElementId ?? internalSelectedElementId}
                slide={renderedNativeSlide ?? activeNativeSlide}
                stage={document.stage}
                stageOverlay={nativeStageOverlay}
                themeColors={themeColors}
                {...(narrationSegmentIndex < 0
                  ? {}
                  : { activeNarrationSegmentId: `segment:${narrationSegmentIndex}` })}
                {...(onElementSelect === undefined
                  ? {}
                  : {
                      onElementSelect: (elementId: string | undefined) => {
                        setInternalSelectedElementId(elementId);
                        onElementSelect(elementId);
                        onElementsSelect?.(elementId === undefined ? [] : [elementId]);
                      },
                    })}
                {...(onNativeElementTransformChange === undefined
                  ? {}
                  : { onElementTransformChange: onNativeElementTransformChange })}
                {...(onNativeElementTransformStart === undefined
                  ? {}
                  : { onElementTransformStart: onNativeElementTransformStart })}
                {...(onNativeElementTransformEnd === undefined
                  ? {}
                  : { onElementTransformEnd: onNativeElementTransformEnd })}
                {...(onNativeTextFrameDoubleClick === undefined
                  ? {}
                  : { onTextFrameDoubleClick: onNativeTextFrameDoubleClick })}
                {...(onNativeBlankCanvasDoubleClick === undefined
                  ? {}
                  : { onBlankCanvasDoubleClick: onNativeBlankCanvasDoubleClick })}
                {...(editingNativeTextElementId === undefined
                  ? {}
                  : { editingElementId: editingNativeTextElementId })}
                {...(editingNativeTableCellId === undefined
                  ? {}
                  : { editingCellId: editingNativeTableCellId })}
                {...(renderEditingNativeTextFrame === undefined
                  ? {}
                  : { renderEditingTextFrame: renderEditingNativeTextFrame })}
              />
              {appearance === 'learner' || !showNativeCaption ? null : (
                <div className="voice-caption-strip" aria-live="polite">
                  <MessageSquareText size={16} />
                  {narrationCaption === undefined ? (
                    <span>{text('reachDeck.player.noCaptions', '暂无字幕')}</span>
                  ) : (
                    <NarrationCaption
                      authoritative={activeNativeSlide.narration?.markdown !== undefined}
                      scrollable
                      ariaLabel={text('reachDeck.player.captionsLabel', '幻灯片字幕')}
                      text={narrationCaption.text}
                    />
                  )}
                </div>
              )}
              <NarrationAudioV2
                currentTime={narrationPositionRef.current}
                key={`${mediaIdentity}:${activePage.pageId}:${narrationAudioResourceId ?? 'none'}`}
                onMediaError={
                  onNativeMediaError === undefined
                    ? undefined
                    : (src) => {
                        if (narrationAudioResourceId)
                          onNativeMediaError(narrationAudioResourceId, src);
                      }
                }
                onMediaLoaded={(src) => {
                  if (narrationAudioResourceId)
                    onNativeMediaLoaded?.(narrationAudioResourceId, src);
                }}
                onMediaPlayingChange={(playing) => {
                  if (narrationAudioResourceId)
                    onNativeMediaPlayingChange?.(narrationAudioResourceId, playing);
                }}
                onEnded={() => {
                  if (
                    effectiveDuration !== undefined &&
                    currentTimeRef.current >=
                      effectiveDuration - MEDIA_END_COMPLETION_TOLERANCE_SECONDS
                  ) {
                    finishPlaybackNaturally(effectiveDuration);
                  }
                }}
                onDurationChange={(duration) => {
                  if (narrationAudioResourceId === undefined) return;
                  setAudioDurationByResourceId((current) =>
                    (current[narrationAudioResourceId] ?? 0) >= duration
                      ? current
                      : { ...current, [narrationAudioResourceId]: duration },
                  );
                }}
                onPlaybackReadyChange={setNarrationPlaybackReady}
                onUnexpectedPause={(time) => {
                  if (!playingRef.current) return;
                  setCurrentTime(Math.min(effectiveDuration ?? time, Math.max(0, time)));
                  setNarrationPlaybackReady(false);
                  setPlaying(false);
                }}
                onTimeChange={(time) => {
                  if (!playingRef.current) return;
                  const next = Math.min(effectiveDuration ?? time, Math.max(0, time));
                  setCurrentTime(next);
                  notePlaybackPosition(activePage.pageId, next);
                }}
                muted={narrationVolume.muted}
                playbackRate={playbackRate}
                pageId={activePage.pageId}
                playing={playing}
                seekRequest={narrationSeekRequest}
                src={narrationAudioSrc}
                volume={narrationVolume.volume}
              />
              {showNativeTimeline && appearance === 'learner'
                ? renderLearnerSlideDock(
                    !showNativeCaption ? (
                      <span className="reach-deck-player__dock-empty">
                        {text('reachDeck.player.noNarration', '本页没有讲稿')}
                      </span>
                    ) : narrationCaption === undefined ? (
                      <span className="reach-deck-player__dock-empty">
                        {text('reachDeck.player.noCaptions', '暂无字幕')}
                      </span>
                    ) : (
                      <NarrationCaption
                        authoritative={activeNativeSlide.narration?.markdown !== undefined}
                        scrollable
                        ariaLabel={text('reachDeck.player.captionsLabel', '幻灯片字幕')}
                        text={narrationCaption.text}
                      />
                    ),
                  )
                : null}
              {showNativeTimeline && appearance !== 'learner' ? (
                <div className="reach-deck-player__timeline" data-reach-deck-timeline="native-v2">
                  <div className="reach-deck-player__transport-group">
                    {renderPreviousPageButton()}
                    <button
                      aria-label={
                        playing
                          ? text('reachDeck.player.pause', '暂停')
                          : text('reachDeck.player.play', '播放')
                      }
                      className="reach-deck-player__transport"
                      data-reach-deck-play-toggle
                      onClick={toggleSlidePlayback}
                      title={
                        playing
                          ? text('reachDeck.player.pause', '暂停')
                          : text('reachDeck.player.play', '播放')
                      }
                      type="button"
                    >
                      {playing ? <Pause size={16} /> : <Play size={16} />}
                    </button>
                    {renderNextPageButton()}
                  </div>
                  {renderPageIndicator()}
                  <input
                    aria-label={text('reachDeck.player.slideProgress', '幻灯片进度')}
                    max={effectiveDuration}
                    min={0}
                    onChange={(event) => seekSlideNarration(Number(event.target.value))}
                    onKeyDown={(event) => {
                      if (
                        isNarrationSeekKey(event.key) &&
                        narrationSeekIntentStartRef.current === undefined
                      ) {
                        narrationSeekIntentStartRef.current = currentTimeRef.current;
                      }
                    }}
                    onKeyUp={(event) => {
                      if (isNarrationSeekKey(event.key)) {
                        commitNarrationSeekIntent(Number(event.currentTarget.value));
                      }
                    }}
                    onPointerCancel={() => {
                      narrationSeekIntentStartRef.current = undefined;
                    }}
                    onPointerDown={() => {
                      narrationSeekIntentStartRef.current = currentTimeRef.current;
                    }}
                    onPointerUp={(event) =>
                      commitNarrationSeekIntent(Number(event.currentTarget.value))
                    }
                    step={0.01}
                    type="range"
                    value={Math.min(currentTime, effectiveDuration ?? 0)}
                  />
                  <span className="reach-deck-player__time">
                    {formatPlaybackTime(currentTime)} / {formatPlaybackTime(effectiveDuration ?? 0)}
                  </span>
                  {renderSlideRateSelect()}
                  {renderTimelineExtra()}
                </div>
              ) : null}
            </div>
          );
        }
        // The v2 document validator requires one native binding per slide.
        // Reaching this branch means a caller bypassed validation or supplied
        // a malformed object; do not fall back to the legacy scene renderer or
        // synthesize a native slide at runtime.
        return (
          <div className="reach-deck-player__unsupported" role="alert">
            {text('reachDeck.player.invalidNativeSlide', '幻灯片缺少有效的原生绑定，文档无效。')}
          </div>
        );
      }
      case 'quiz':
        return (
          <QuizScenePlayer
            isAttachmentUnavailable={isAttachmentUnavailable}
            resolveAttachmentUrl={
              resolveAttachmentUrl
                ? (ref, disposition) =>
                    resolveAttachmentUrl({ ...ref, pageId: activePage.pageId }, disposition)
                : undefined
            }
            masteredLearningFenceQuestionIds={
              masteredLearningFenceQuestionIdsByPage === undefined
                ? undefined
                : (masteredLearningFenceQuestionIdsByPage[activePage.pageId] ?? [])
            }
            gradingMode={quizGradingMode}
            layout={quizLayout}
            {...(quizGradingByPageId === undefined || quizGradingMode === 'trial'
              ? {}
              : {
                  gradingByQuestionId: quizGradingByPageId[activePage.pageId] ?? EMPTY_QUIZ_GRADING,
                  ...(onRetryQuizGrading === undefined
                    ? {}
                    : {
                        onRetryGrading: (questionId: string) =>
                          onRetryQuizGrading(activePage.pageId, questionId),
                      }),
                })}
            {...(quizUnsyncedSubmissionsByPageId?.[activePage.pageId] === undefined
              ? {}
              : {
                  unsyncedSubmissionQuestionIds: quizUnsyncedSubmissionsByPageId[activePage.pageId],
                })}
            renderGradingFeedback={renderQuizGradingFeedback}
            initialRuntimeState={quizRuntimeState(runtimeByPageId[activePage.pageId])}
            mediaUrlsByObjectKey={quizMediaUrlsByObjectKey}
            key={`${document.id}:${activePage.pageId}:${activePage.revision}:quiz`}
            onRuntimeStateChange={(state) => updateRuntime(document.id, activePage, () => state)}
            onSubmit={(questionId, answer, state) => {
              // Submit commands must not wait for the runtime store's passive effect.
              onRuntimeStateChangeRef.current?.(activePage.pageId, state);
              emittedRuntimeRef.current = {
                ...emittedRuntimeRef.current,
                [activePage.pageId]: state,
              };
              const question = activePage.scene.content.questions.find(
                (candidate) => candidate.id === questionId,
              );
              // Learner hosts get results from the server; only trial hosts grade locally.
              const trialGrade =
                quizGradingMode !== 'trial' || question === undefined
                  ? undefined
                  : gradeObjectiveQuestion(question, answer);
              onEvent?.({
                type: 'quizSubmit',
                pageId: activePage.pageId,
                questionId,
                ...(trialGrade === undefined ? {} : { trialGrade }),
              });
            }}
            scene={activePage.scene}
            sourceRevision={activePage.revision}
            translate={translate}
            {...(uploadQuizAnswerAsset === undefined
              ? {}
              : {
                  uploadAnswerAsset: (
                    file: File,
                    context: { kind: QuizAnswerAssetKind; questionId: string },
                  ) => uploadQuizAnswerAsset(file, { ...context, pageId: activePage.pageId }),
                })}
          />
        );
      case 'interactive':
        return (
          <div
            className="reach-deck-player__interactive-empty"
            data-interactive-empty-mode={interactiveMode}
            role="status"
          >
            <strong>
              {text(
                'reachDeck.player.interactive.emptyTitle',
                'This interactive page is intentionally empty.',
              )}
            </strong>
            <span>
              {text(
                interactiveMode === 'authoring'
                  ? onInteractiveUploadAction === undefined
                    ? 'reachDeck.player.interactive.emptyAuthoringBody'
                    : 'reachDeck.player.interactive.emptyAuthoringUploadBody'
                  : 'reachDeck.player.interactive.emptyLearnerBody',
                interactiveMode === 'authoring'
                  ? onInteractiveUploadAction === undefined
                    ? 'Ask Decksmith to create or edit the activity for this page.'
                    : 'Describe the activity to Decksmith on the right, or upload a prepared HTML file.'
                  : 'There is no interactive activity on this page yet.',
              )}
            </span>
            {interactiveMode === 'authoring' ? (
              <div className="reach-deck-player__interactive-empty-actions">
                <button onClick={() => onInteractiveEmptyAction?.(activePage.pageId)} type="button">
                  {text('reachDeck.player.interactive.emptyAction', 'Create with Decksmith')}
                </button>
                {onInteractiveUploadAction === undefined ? null : (
                  <button
                    onClick={() => onInteractiveUploadAction(activePage.pageId)}
                    type="button"
                  >
                    {text('reachDeck.player.interactive.emptyUploadAction', 'Upload HTML')}
                  </button>
                )}
              </div>
            ) : null}
          </div>
        );
      default:
        return assertNever(activePage);
    }
  }

  function updateRuntime(
    sourceDocumentId: string,
    sourcePage: ReachDeckPublishedPage,
    update: (current: ReachDeckSceneRuntimeState | undefined) => ReachDeckSceneRuntimeState,
  ) {
    const latestDocument = latestDocumentRef.current;
    if (latestDocument.id !== sourceDocumentId) return;
    const latestPage = latestDocument.pages.find((page) => page.pageId === sourcePage.pageId);
    if (!latestPage || !samePageRuntimeIdentity(latestPage, sourcePage)) return;

    setRuntimeStore((currentStore) => {
      if (latestDocumentRef.current.id !== sourceDocumentId) return currentStore;
      const current =
        currentStore.documentId === sourceDocumentId
          ? reconcileRuntime(currentStore.byPageId, latestDocumentRef.current)
          : {};
      const currentState = current[sourcePage.pageId];
      const next = update(
        currentState && isRuntimeStateForPage(currentState, sourcePage) ? currentState : undefined,
      );
      if (!isRuntimeStateForPage(next, sourcePage)) return currentStore;
      return {
        documentId: sourceDocumentId,
        byPageId: { ...current, [sourcePage.pageId]: next },
      };
    });
  }
}

/**
 * 整页单条讲稿音频：与逐 cue 音频不同，v2 一页只有一条 TTS 音频，
 * 页内时间就是音频内偏移，因此不需要按分段做 start 换算。
 */
function NarrationAudioV2({
  currentTime,
  muted,
  onDurationChange,
  onEnded,
  onPlaybackReadyChange,
  onUnexpectedPause,
  onTimeChange,
  pageId,
  playbackRate,
  playing,
  seekRequest,
  src: latestSrc,
  onMediaError,
  onMediaLoaded,
  onMediaPlayingChange,
  volume,
}: {
  currentTime: number;
  muted: boolean;
  onDurationChange: (duration: number) => void;
  onEnded: () => void;
  onPlaybackReadyChange: (ready: boolean) => void;
  onUnexpectedPause: (time: number) => void;
  onTimeChange: (time: number) => void;
  pageId: string;
  playbackRate: number;
  playing: boolean;
  seekRequest: ResolvedNarrationSeekRequest | undefined;
  src: string | undefined;
  onMediaError?: (src: string) => void;
  onMediaLoaded?: (src: string) => void;
  onMediaPlayingChange?: (playing: boolean) => void;
  volume: number;
}) {
  const {
    source: src,
    adoptLatest,
    markHealthy,
    retryRevision,
  } = useRetainedMediaSource(latestSrc, playing && onMediaError !== undefined, pageId);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stallRecovery = useMediaStallRecovery((media) => {
    if (!onMediaError) return;
    failurePositionRef.current = media.currentTime;
    adoptLatest();
    if (src) onMediaError(src);
  }, src ?? '');
  const playingCallbackRef = useRef(onMediaPlayingChange);
  playingCallbackRef.current = onMediaPlayingChange;
  useEffect(() => () => playingCallbackRef.current?.(false), [pageId]);
  const currentTimeRef = useRef(currentTime);
  const mediaProgressRef = useRef(currentTime);
  const needsStartPositionRef = useRef(true);
  const appliedSeekRef = useRef<number | undefined>(undefined);
  const replacementPositionRef = useRef<number | undefined>(undefined);
  const failurePositionRef = useRef<number | undefined>(undefined);
  const previousSrcRef = useRef(src);
  if (previousSrcRef.current !== src) {
    replacementPositionRef.current =
      failurePositionRef.current ?? audioRef.current?.currentTime ?? currentTime;
    failurePositionRef.current = undefined;
    previousSrcRef.current = src;
  }
  currentTimeRef.current = currentTime;

  const retriedRef = useRef(0);
  useEffect(() => {
    if (!onMediaError || retryRevision === retriedRef.current) return;
    retriedRef.current = retryRevision;
    const audio = audioRef.current;
    if (!audio || audio.getAttribute('src') !== src || failurePositionRef.current === undefined)
      return;
    // Release is also useful when a transient network failure needs a retry of the same URL.
    if (typeof navigator !== 'undefined' && !navigator.userAgent.toLowerCase().includes('jsdom'))
      audio.load();
  }, [retryRevision, src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    needsStartPositionRef.current = true;
    onPlaybackReadyChange(false);
    setMediaCurrentTime(audio, replacementPositionRef.current ?? currentTimeRef.current);
  }, [onPlaybackReadyChange, src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    audio.playbackRate = playbackRate;
  }, [playbackRate, src]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.muted = muted;
  }, [muted, src, volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    if (!playing) {
      onPlaybackReadyChange(false);
      audio.pause();
      return;
    }
    if (needsStartPositionRef.current) {
      setMediaCurrentTime(audio, replacementPositionRef.current ?? currentTimeRef.current);
      needsStartPositionRef.current = false;
    }
    onPlaybackReadyChange(false);
    let cancelled = false;
    void audio.play().catch((error: unknown) => {
      if (cancelled) return;
      // 浏览器拒绝无手势播放（自动播放策略）时停在暂停态，等学习者点播放；
      // 其他失败（音频损坏等）仍按原样放行时间轴，画面照常推进。
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        onUnexpectedPause(audio.currentTime);
        return;
      }
      onPlaybackReadyChange(onMediaError === undefined);
      if (src) {
        failurePositionRef.current = audio.currentTime;
        adoptLatest();
        onMediaError?.(src);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [onPlaybackReadyChange, playing, src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (
      !audio ||
      !src ||
      seekRequest?.pageId !== pageId ||
      appliedSeekRef.current === seekRequest.id
    ) {
      return;
    }
    appliedSeekRef.current = seekRequest.id;
    setMediaCurrentTime(audio, seekRequest.time);
  }, [pageId, seekRequest, src]);

  if (!src) return null;
  return (
    <audio
      aria-hidden="true"
      onEnded={(event) => {
        stallRecovery.cancel(event.currentTarget);
        onMediaPlayingChange?.(false);
        onEnded();
      }}
      onLoadedMetadata={(event) => {
        const position =
          replacementPositionRef.current ?? failurePositionRef.current ?? currentTimeRef.current;
        setMediaCurrentTime(event.currentTarget, position);
        const recovering =
          replacementPositionRef.current !== undefined || failurePositionRef.current !== undefined;
        replacementPositionRef.current = undefined;
        failurePositionRef.current = undefined;
        event.currentTarget.playbackRate = playbackRate;
        event.currentTarget.volume = Math.max(0, Math.min(1, volume));
        event.currentTarget.muted = muted;
        mediaProgressRef.current = position;
        onTimeChange(position);
        if (recovering && playing && onMediaError)
          void event.currentTarget.play().catch(() => onMediaError(src));
        const duration = event.currentTarget.duration;
        if (Number.isFinite(duration) && duration > 0) onDurationChange(duration);
      }}
      onCanPlay={(event) => {
        stallRecovery.cancel(event.currentTarget);
        failurePositionRef.current = undefined;
        markHealthy(src);
        onMediaLoaded?.(src);
      }}
      onError={(event) => {
        stallRecovery.cancel(event.currentTarget);
        failurePositionRef.current = event.currentTarget.currentTime;
        onPlaybackReadyChange(onMediaError === undefined);
        adoptLatest();
        onMediaError?.(src);
      }}
      onPause={(event) => {
        stallRecovery.cancel(event.currentTarget);
        // A URL replacement can emit pause before metadata; it is not learner intent.
        if (
          (onMediaError !== undefined && event.currentTarget.readyState === 0) ||
          replacementPositionRef.current !== undefined
        )
          return;
        onMediaPlayingChange?.(false);
        if (playing && !event.currentTarget.ended && !event.currentTarget.seeking) {
          onPlaybackReadyChange(false);
          onUnexpectedPause(event.currentTarget.currentTime);
        }
      }}
      onPlaying={(event) => {
        stallRecovery.cancel(event.currentTarget);
        if (replacementPositionRef.current !== undefined) return;
        failurePositionRef.current = undefined;
        markHealthy(src);
        onMediaPlayingChange?.(true);
        onPlaybackReadyChange(true);
        mediaProgressRef.current = event.currentTarget.currentTime;
        onTimeChange(event.currentTarget.currentTime);
      }}
      onSeeking={() => onPlaybackReadyChange(false)}
      onSeeked={(event) => {
        onTimeChange(event.currentTarget.currentTime);
        onPlaybackReadyChange(playing);
      }}
      onStalled={(event) => {
        onPlaybackReadyChange(false);
        stallRecovery.arm(event.currentTarget);
      }}
      onTimeUpdate={(event) => {
        if (
          replacementPositionRef.current !== undefined ||
          (onMediaError !== undefined && event.currentTarget.readyState === 0)
        )
          return;
        const media = event.currentTarget;
        if (
          media.currentTime > mediaProgressRef.current + 0.001 &&
          playing &&
          !media.paused &&
          !media.seeking &&
          media.readyState >= 2
        ) {
          // Download stalls can leave buffered audio playing without another `playing` event.
          stallRecovery.cancel(media);
          onPlaybackReadyChange(true);
        }
        mediaProgressRef.current = media.currentTime;
        currentTimeRef.current = event.currentTarget.currentTime;
        onTimeChange(event.currentTarget.currentTime);
      }}
      onWaiting={(event) => {
        onPlaybackReadyChange(false);
        stallRecovery.arm(event.currentTarget);
      }}
      preload="metadata"
      ref={audioRef}
      src={src}
    />
  );
}

function setMediaCurrentTime(audio: HTMLAudioElement, time: number): void {
  if (!Number.isFinite(time) || time < 0) return;
  if (Math.abs(audio.currentTime - time) <= MEDIA_EXPLICIT_SEEK_TOLERANCE_SECONDS) return;
  audio.currentTime = time;
}

function formatPlaybackTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function toNarrationMilliseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

function isNarrationSeekKey(key: string): boolean {
  return [
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'End',
    'Home',
    'PageDown',
    'PageUp',
  ].includes(key);
}

function playerActivityFor(
  page: ReachDeckPublishedPage,
  runtime: ReachDeckSceneRuntimeState | undefined,
  slideState: {
    currentTime: number;
    playing: boolean;
  },
): ReachDeckPlayerActivity {
  const state =
    page.sceneType === 'slide'
      ? {
          currentTime: Math.max(0, Math.round(slideState.currentTime * 10) / 10),
          playing: slideState.playing,
        }
      : (runtime ?? null);
  return {
    schemaVersion: 'reach-deck-player-activity/v1',
    pageId: page.pageId,
    sceneId: page.sceneType === 'slide' ? page.pageId : page.scene.id,
    sceneType: page.sceneType,
    sourceRevision: page.revision,
    state,
  };
}

function interactiveRuntimeFor(
  page: Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }>,
  current?: ReachDeckSceneRuntimeState,
): InteractiveSceneRuntimeState {
  if (current?.kind === 'interactive' && isRuntimeStateForPage(current, page)) return current;
  return {
    kind: 'interactive',
    sceneId: page.scene.id,
    sourceRevision: page.revision,
    attempt: 1,
    phase: 'booting',
    completed: false,
  };
}

function composeInteractiveSnapshot(runtime: InteractiveSceneRuntimeState | undefined): unknown {
  if (runtime?.geometry === undefined) return runtime?.snapshot;
  const snapshot = isUnknownRecord(runtime.snapshot) ? runtime.snapshot : {};
  return { ...snapshot, geometry: runtime.geometry };
}

function splitInteractiveSnapshot(
  snapshot: unknown,
): Pick<InteractiveSceneRuntimeState, 'snapshot' | 'geometry'> {
  if (!isUnknownRecord(snapshot) || !isGeometryHostState(snapshot.geometry)) return { snapshot };
  const { geometry, ...pageSnapshot } = snapshot;
  return { snapshot: pageSnapshot, geometry };
}

function isGeometryHostState(value: unknown): value is Record<string, unknown> {
  return (
    isUnknownRecord(value) &&
    value.schemaVersion === 'reach-geometry-host-state/v2' &&
    isUnknownRecord(value.instances)
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quizRuntimeState(state: ReachDeckSceneRuntimeState | undefined) {
  return state?.kind === 'quiz' ? state : undefined;
}

function samePageRuntimeIdentity(
  left: ReachDeckPublishedPage,
  right: ReachDeckPublishedPage,
): boolean {
  return (
    left.pageId === right.pageId &&
    left.sceneType === right.sceneType &&
    left.revision === right.revision &&
    (left.sceneType === 'slide' ||
      (right.sceneType !== 'slide' && left.scene.id === right.scene.id))
  );
}

function resolveInitialPageIndex(document: ReachDeckDocument, pageId: string | undefined): number {
  if (pageId === undefined) return 0;
  const index = document.pages.findIndex((page) => page.pageId === pageId);
  return index < 0 ? 0 : index;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Reach Deck page: ${String(value)}`);
}
