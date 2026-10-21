'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  AudioLines,
  Bot,
  ChartColumn,
  Check as CheckIcon,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  ClipboardPaste,
  Copy,
  CopyPlus,
  FileUp,
  FlaskConical,
  Group as GroupIcon,
  Image as ImageIcon,
  LayoutTemplate,
  Minus as MinusIcon,
  MousePointerClick,
  Music,
  Plus,
  RefreshCw,
  Redo2,
  Scissors,
  ScrollText,
  Send,
  Shapes,
  Sigma,
  Sparkles,
  Square,
  Table as TableIcon,
  Trash2,
  TriangleAlert,
  Type as TypeIcon,
  Undo2,
  Video,
  Volume2,
  WandSparkles,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  buildReachDeckMediaResourceForObjectKey,
  captureQuizQuestionTypeSession,
  isNativeSlideNarrationContentStale,
  collectQuizQuestionInlineImageObjectKeys,
  convertQuizQuestionTypeWithSession,
  createQuizQuestion,
  emptyQuizRichText,
  ensureReachDeckRichTextMediaResources,
  quizOptionValueAt,
  reachDeckMediaUrlsByObjectKey,
  QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS,
  QUIZ_QUESTION_MAX_INLINE_IMAGES,
  reconcileQuizOptions,
  reconcileQuizQuestionTypeSession,
  reorderQuizOptions,
  richTextHasRenderableContent,
  richTextFromPlainText,
  synchronizeQuizQuestionBlanks,
  parseReachDeckDocument,
  reachDeckPageContentEqual,
  reachDeckPlayableAnimations,
  reachDeckValuesEqual,
  richTextToPlainText,
  typographyTokensForProfile,
  type DeckElement,
  type DeckTheme,
  type RichTextDocument,
  type RichTextFontFamily,
  REACH_DECK_BUILT_IN_FONT_FAMILIES,
  type ReachDeckDocument,
  type ReachDeckPageMediaSlot,
  type ReachDeckAnimationV2,
  type ReachDeckNativeElementV2,
  type ReachDeckNativeSlideV2,
  type ReachDeckPublishedPage,
  type ReachDeckSceneType,
  type ReachDeckSpeechMarkV1,
  type ReachDeckSpeechMarkupV1,
  type QuizQuestion,
  type QuizQuestionBlank,
  type QuizQuestionOption,
  type QuizQuestionType,
  type QuizQuestionTypeSession,
  type TextElement,
} from '@reachany/reach-deck-dsl';
import {
  firstSupportedClipboardImage,
  normalizeClipboardImageFile,
} from '@reachany/clipboard-content';
import {
  REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS,
  richTextFromClipboardHtml,
  richTextFromClipboardPlainText,
} from '@reachany/reach-deck-rich-text';
import {
  NativeV2SlideRenderer,
  ReachDeckPlayer,
  ReachDeckRichText,
  translateReachDeck,
  type ReachDeckNarrationSeekRequest,
  type ReachDeckRuntimeByPageId,
  type ReachDeckSceneRuntimeState,
  type ReachDeckTranslate,
  type ReachDeckAttachmentUrlResolver,
} from '@reachany/reach-deck-player';
import { BrandLoader, Button, ConfirmDialog, Select } from '@reachany/ui';
import {
  QuizQuestionAttachmentsEditor,
  QUIZ_ATTACHMENT_UPLOAD_CANCEL_REASON,
} from './QuizQuestionAttachmentsEditor.js';
import { AnimationPropertiesPanel } from './AnimationPropertiesPanel.js';
import { clearReachDeckDocumentMedia, type ReachDeckMediaClearHandler } from './deckMediaClear.js';
import type { ReachDeckRegenerationChannel } from './ReachDeckRegenerationDialog.js';

import {
  RichTextElementEditor,
  RichTextToolbarPlaceholder,
  type RichTextImageInsertion,
  type RichTextUploadedImage,
} from './RichTextElementEditor.js';
import {
  CLIPBOARD_IMAGE_ACCEPT,
  CLIPBOARD_IMAGE_EXTENSIONS,
  CLIPBOARD_IMAGE_MAX_BYTES,
} from './authoringMedia.js';
import { rebaseAssistantCandidate, rebaseAssistantCandidateByPages } from './assistantRebase.js';
import { useAssistantWaiting } from './useAssistantWaiting.js';
import {
  restoreReplacedNarrationDraft,
  takeReplacedNarrationDrafts,
} from './assistantNarrationDrafts.js';
import {
  decksmithCandidateChangedPageIds,
  decksmithCandidateFingerprint,
  planDecksmithCandidateRestore,
} from './assistantRecovery.js';
import { InteractiveNarrationStatusTrack } from './InteractiveNarrationStatusTrack.js';
import {
  NarrationEditor,
  prepareNarrationDraftForRegeneration,
  hasReachDeckNarrationAudioTiming,
  type NarrationDraftCache,
  type NarrationDraftCacheEntry,
  type NarrationEditorInteractiveHandle,
  type NarrationSpeechMarkupCandidate,
  type NarrationSpeechPreviewAudio,
  type NarrationSpeechPreviewStatus,
} from './NarrationEditor.js';
import {
  canExecuteEditorCommand,
  editorCommandTargetIsEditable as deckShortcutTargetIsEditable,
  resolveEditorCommandContext,
  type EditorCommandContext,
} from './editorCommands.js';
import { ReachDeckTimeline } from './ReachDeckTimeline.js';
import {
  nativeElementChipInfo,
  locateNativeElement,
  resolveClarificationCandidates,
  type ResolvedClarificationCandidate,
} from './assistantClarification.js';
import {
  deriveInteractiveNarrationViewModel,
  interactiveNarrationGenerationState,
  type InteractiveNarrationDraftSnapshot,
} from './interactiveNarration.js';
import { defaultTweenForEffect, entrancePresetKind } from './nativeAnimationDefaults.js';
import { narrationDisplayWindows, timelineContentDuration } from './timelineOperations.js';
import { installPressHoldPreview } from './pressHoldPreview.js';
import {
  GeometryAuthoringModeControl,
  GeometryAuthoringPanel,
  GeometryAuthoringReadOnlyNotice,
} from './GeometryAuthoringPanel.js';
import {
  applyGeometryEditProposal,
  deleteGeometryAuthoredItem,
  inspectGeometryAuthoring,
  setGeometryAuthoredInitialState,
  updateGeometryAuthoredPresentation,
  updateGeometryExplorationPolicy,
  updateGeometryParameterAuthoring,
  GeometryAuthoringError,
  type GeometryAuthoringEditProposal,
  type GeometryAuthoringInspection,
} from './geometryAuthoring.js';
import {
  deriveReachDeckPageLaneStatuses,
  REACH_DECK_PAGE_LANES,
  type ReachDeckPageLane,
  type ReachDeckPageLaneState,
} from './pageLaneStatus.js';
import {
  richTextLetterSpacing,
  richTextLineSpacing,
  setRichTextFixedLineSpacing,
  setRichTextLetterSpacing,
  setRichTextLineSpacing,
  type RichTextSpacingValue,
} from './richTextSpacing.js';
import {
  closeReachDeckDocumentHistoryGroup,
  createReachDeckDocumentHistory,
  rebaseReachDeckDocumentDraft,
  rebaseReachDeckDocumentHistory,
  recordReachDeckDocumentEdit,
  redoReachDeckDocumentEdit,
  undoReachDeckDocumentEdit,
  type ReachDeckDocumentSnapshot,
} from './documentHistory.js';
import {
  addReachDeckPage,
  addEmptyReachDeckTextFrame,
  applyReachDeckBodyTypographyDefaults,
  copyReachDeckNativeElement,
  copyReachDeckNativeElements,
  deleteReachDeckNativeElements,
  deleteReachDeckPage,
  duplicateReachDeckPage,
  revealReachDeckNativeElement,
  insertReachDeckAuthoringMedia,
  insertReachDeckClipboardTextFrame,
  parseReachDeckNativeElementClipboard,
  pasteReachDeckNativeElement,
  pasteReachDeckNativeElements,
  REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
  reorderReachDeckPages,
  serializeReachDeckNativeElementClipboard,
  normalizeReachDeckEditorMutation,
  updateReachDeckPage,
  updateReachDeckNativeSlide,
  type ReachDeckIdFactory,
  type ReachDeckAuthoringMediaKind,
  type ReachDeckPageInsertionTarget,
} from './operations.js';
import {
  ELEMENT_CLIPBOARD_VERSION,
  parseReachDeckElementsClipboard,
  reachDeckElementsClipboardHtml,
  reachDeckElementsClipboardPlainText,
  readReachDeckElementsClipboardHtml,
  serializeReachDeckElementsClipboard,
} from './elementClipboard.js';
import {
  activePageAfterSelection,
  reconcilePageSelection,
  reducePageSelection,
  type PageSelection,
} from './pageSelection.js';

interface PageMarquee {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  selectedPageIdsAtStart: string[];
  additive: boolean;
}

const PAGE_MARQUEE_DRAG_THRESHOLD = 4;

type SlidePage = Extract<ReachDeckPublishedPage, { sceneType: 'slide' }>;
type QuizPage = Extract<ReachDeckPublishedPage, { sceneType: 'quiz' }>;
type InteractivePage = Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }>;
type ReachDeckHistoryMetadata = { readonly historyGroup?: string };

const sceneTypes: ReachDeckSceneType[] = ['slide', 'quiz', 'interactive'];
let activeReachDeckEditorInstance: symbol | undefined;
const sceneTypeLabels: Record<ReachDeckSceneType, string> = {
  slide: '幻灯片',
  quiz: '测验',
  interactive: '互动',
};
const quizQuestionTypeLabels: Record<QuizQuestionType, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  fill_in_the_blank: '自由填空',
  cloze: '完形填空',
  fill_with_candidates: '候选填空',
  short_answer: '解答题',
};

const PAGE_MENU_WIDTH = 208;
const PAGE_SUBMENU_WIDTH = 176;
const PAGE_MENU_VIEWPORT_GAP = 8;
const LEGACY_ASSISTANT_RECOVERY_KEY = '__legacy-decksmith-recovery__';

interface EditorCommitOptions {
  historyGroup?: string;
  adoption?: boolean;
  /**
   * 教师已在二次确认里同意放弃未结清的 Decksmith 工作、停止被删页的生成，这次结构改动直接提交。
   */
  structureConfirmed?: boolean;
}

/** 一次等待教师确认的结构改动：确认后若草稿仍是 `baseDraft`，按原参数提交 `next`。 */
interface StructureChangeConfirmation {
  readonly next: ReachDeckDocument;
  readonly options: EditorCommitOptions | undefined;
  readonly baseDraft: ReachDeckDocument;
  /** 需要放弃未结清的 Decksmith 工作。 */
  readonly decksmith: boolean;
  /** 被删除、仍有生成在途的页。 */
  readonly generatingPageIds: readonly string[];
  /** 来自撤销/重做的结构改动：确认后按同一方向重新恢复历史，`next` 是预期恢复出的草稿。 */
  readonly history?: 'undo' | 'redo';
}

/** 页面结构（页集合与顺序）的比较键。 */
/** 讲稿阶段失败时需重做的通道：取失败通道中的讲稿/音频/动画，缺省三者全选。 */
function failedNarrationLanes(
  affectedLanes: readonly ('layout' | 'image' | 'narration' | 'audio' | 'animation')[] | undefined,
): ReachDeckRegenerationChannel[] {
  const lanes = (affectedLanes ?? []).filter(
    (lane): lane is 'narration' | 'audio' | 'animation' =>
      lane === 'narration' || lane === 'audio' || lane === 'animation',
  );
  return lanes.length > 0 ? lanes : ['narration', 'audio', 'animation'];
}

function pageIdSequenceOf(document: ReachDeckDocument): string {
  return [...document.pages]
    .sort((left, right) => left.order - right.order)
    .map((page) => page.pageId)
    .join('|');
}

/** `next` 只删除了 `current` 的页：没有新页，留下的页相对顺序不变。 */
function isPureReachDeckPageDeletion(current: ReachDeckDocument, next: ReachDeckDocument): boolean {
  const remaining = new Set(next.pages.map((page) => page.pageId));
  const kept = pageIdSequenceOf(current)
    .split('|')
    .filter((pageId) => remaining.has(pageId))
    .join('|');
  return (
    next.pages.length < current.pages.length &&
    next.pages.every((page) => current.pages.some((before) => before.pageId === page.pageId)) &&
    kept === pageIdSequenceOf(next)
  );
}
const ASSISTANT_PREVIEW_MEDIA_RETRY_MS = 3_000;
const ASSISTANT_PREVIEW_MEDIA_REFRESH_MS = 10 * 60 * 1000;
const EMPTY_NATIVE_RESOURCE_URLS: Readonly<Record<string, string>> = {};

const AUTHORING_MEDIA_ACCEPT: Readonly<
  Record<Exclude<ReachDeckAuthoringMediaKind, 'attachment'>, string>
> = {
  image: '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif',
  audio:
    '.mp3,.wav,.ogg,.oga,.aac,.flac,.m4a,.webm,audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/aac,audio/flac,audio/mp4,audio/x-m4a,audio/webm',
  video: '.mp4,.m4v,.webm,.mov,video/mp4,video/webm,video/quicktime',
};

type RightPanelTab = 'decksmith' | 'properties' | 'narration';
const RIGHT_PANEL_TABS: readonly RightPanelTab[] = ['decksmith', 'properties', 'narration'];

/**
 * 宿主投影的页级批次状态。页面列表只用它驱动缩略图通道图标与无障碍标签；
 * 批次的文字进度与取消入口由宿主在工作台工具栏的任务状态弹层里展示。
 */
export interface ReachDeckEditorBatchStatus {
  accessibleLabel: string;
  batchId: string;
  /** 批次种类；缺省时缩略图通道图标不会把该批次映射到具体通道。 */
  kind?: 'narration' | 'media' | 'regeneration';
  affectedLanes?: readonly ReachDeckPageLane[];
  status: string;
}

export interface ReachDeckEditorProps {
  document: ReachDeckDocument;
  mediaSlotsByPageId?: Readonly<Record<string, readonly ReachDeckPageMediaSlot[]>>;
  imageGeneratingPageIds?: readonly string[];
  onRegenerateImage?: (
    pageId: string,
    assetId: string,
    imageScope: 'failed' | 'all',
  ) => Promise<void>;
  mediaSlotFocusRequest?: {
    pageId: string;
    elementId?: string;
    revealHidden?: boolean;
    key: number;
  };
  /** Host-owned route/module identity rendered above the page rail. */
  workspacePageRailHeader?: ReactNode;
  /** Host-owned workflow/document actions rendered before page-specific editing tools. */
  workspaceCommandBar?: ReactNode;
  /** Host-owned deck-level action rendered in the canvas corner, left of "重新生成本页". */
  workspaceCanvasAction?: ReactNode;
  /** Host-owned deck narration action rendered only inside the narration tab. */
  workspaceNarrationPanelAction?: ReactNode;
  /** Host-owned secondary action rendered below the right-panel tabs. */
  workspaceRightPanelAction?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  /** 版面尚未落地、内容只读的页；讲稿/音频/动画在途不影响版面编辑。 */
  lockedPageIds?: readonly string[];
  /** 已有可预览版面的锁定页；保留用于兼容宿主自定义锁定展示。 */
  previewableLockedPageIds?: readonly string[];
  /** 锁定页上显示的原因文案。 */
  lockedPageReason?: string;
  /** 按页覆盖的锁定原因文案（如 narrating 页显示"讲稿生成中"）；缺省回落 lockedPageReason。 */
  lockedPageReasonById?: Readonly<Record<string, string>>;
  /** 页面生成状态由对应画布/时间轴就地展示，不在页面列表或外层横幅重复占位。 */
  generationStatusByPageId?: Readonly<
    Record<
      string,
      {
        phase: 'layout' | 'narration';
        affectedLanes?: readonly ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
        state: 'loading' | 'failed' | 'manual-review-required';
        activity?: 'queued' | 'generating';
        message?: string;
        /** Plain-language cause and what the teacher can try; never an error code. */
        hint?: string;
        retryable?: boolean;
        candidateMarkdown?: string;
      }
    >
  >;
  /** Host-resolved durable batch status shown on every page row, including pages without a job. */
  batchStatusByPageId?: Readonly<
    Record<string, ReachDeckEditorBatchStatus | readonly ReachDeckEditorBatchStatus[]>
  >;
  /** 宿主动作失败的本地反馈；只投到当前负责显示的画布或时间轴遮罩。 */
  generationActionError?: { message: string; pageId: string };
  /** 生成回合进行中：禁用页面新增/复制/删除/拖拽排序等结构编辑。 */
  structureLocked?: boolean;
  /**
   * 宿主可见的 Decksmith 未结清工作：运行中的请求，或已批准但尚未落地的修改。此时以及编辑器
   * 自己持有待审提案时，增删、重排页面先二次确认；确认后编辑器放弃待审提案，再由宿主经
   * `onReleaseDecksmithStructureHold` 停止请求、让下一次结构保存结清已批准提案，然后才提交改动。
   */
  decksmithStructureHold?: boolean;
  onReleaseDecksmithStructureHold?: () => Promise<void>;
  /**
   * 生成期间也允许删页，包括正在生成的页：插入、复制、排序仍受 `structureLocked` 限制。删除的页
   * 里有 `generationInFlightPageIds` 中的页时先二次确认，确认后经
   * `onConfirmGeneratingPageDeletion` 让宿主在这次结构保存里停止这些页的生成任务。
   */
  allowDeletingGeneratingPages?: boolean;
  /** 仍有生成在途（版面、讲稿或媒体）的页。 */
  generationInFlightPageIds?: readonly string[];
  onConfirmGeneratingPageDeletion?: (pageIds: readonly string[]) => Promise<void> | void;
  idFactory?: ReachDeckIdFactory;
  locale?: string;
  onChange?: (document: ReachDeckDocument) => void;
  /** 切换当前页时触发宿主保存；导航立即发生，保存失败由宿主反馈且不阻塞页面切换。 */
  onBeforeActivePageChange?: (fromPageId: string, toPageId: string) => Promise<void> | void;
  /** Opens the product-owned PPTX preview flow at the selected rail insertion position. */
  onRequestPptxInsert?: (target: ReachDeckPageInsertionTarget) => void;
  /** Opens the product-owned compatible JSON preview flow at the selected rail insertion position. */
  onRequestMaicInsert?: (target: ReachDeckPageInsertionTarget) => void;
  /**
   * Open the product-owned current-page regeneration dialog without starting a task. `preset`
   * pre-checks the lanes a failure overlay would regenerate so the teacher sees and can adjust them.
   */
  onRequestRegenerationPage?: (
    pageId: string,
    preset?: { channels: readonly ReachDeckRegenerationChannel[] },
  ) => void;
  /**
   * 注册整份课件的音频/动画删除入口（宿主的“一键删除”调用）。删除走编辑器提交与撤销历史，
   * 只读锁定页跳过；返回实际变更与跳过的页。
   */
  onRegisterMediaClear?: (clear: ReachDeckMediaClearHandler | undefined) => void;
  /** Suspend Undo/Redo while the host confirms or persists an irreversible media deletion. */
  documentHistoryDisabled?: boolean;
  /**
   * Register a save barrier covering narration drafts cached across page switches. The host calls
   * it before regeneration (one page) and before its document Save (every page, drafts only).
   */
  onRegisterRegenerationPreparation?: (
    prepare: ((pageId?: string) => Promise<void>) | undefined,
  ) => void;
  onSaveInteractivePageNarrationDraft?: (input: {
    pageId: string;
    text: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  /**
   * 时间轴讲稿面板里的"重新生成讲稿"，作用于当前 slide 页；缺省不渲染该按钮。
   * 面板的"仅重新生成本页讲稿"以 `{ textOnly: true }` 调用，宿主必须只重写讲稿文字
   * （不合成音频、不生成讲稿动画）。
   */
  onRegeneratePageNarration?: (
    pageId: string,
    options?: { textOnly?: boolean },
  ) => Promise<void> | void;
  /** 宿主按真实 workspace 判定、允许教师显式新建讲稿生成任务的锁定失败页。 */
  narrationRegeneratablePageIds?: readonly string[];
  /** Current course voice capability; omitted hosts retain the full supported mark set. */
  allowedNarrationSpeechMarkTypes?: readonly ReachDeckSpeechMarkV1['type'][];
  /** 保存教师整页讲稿，并从该精确 Markdown 生成音频与动画。 */
  onSavePageNarrationAndGenerate?: (input: {
    markdown: string;
    pageId: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onSavePageNarrationAudio?: (input: {
    markdown: string;
    pageId: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onSavePageNarrationDraft?: (input: {
    markdown: string;
    pageId: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onRegeneratePageNarrationAnimations?: (input: {
    markdown: string;
    pageId: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onRegeneratePageAnimationsOnly?: (input: {
    markdown: string;
    pageId: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onRequestPageSpeechMarkupCandidates?: (
    input: { markdown: string; pageId: string; speechMarkup?: ReachDeckSpeechMarkupV1 },
    signal: AbortSignal,
  ) => Promise<readonly NarrationSpeechMarkupCandidate[]>;
  onPreviewPageSpeech?: (
    input: {
      markdown: string;
      markdownFrom: number;
      markdownTo: number;
      pageId: string;
      speechMarkup?: ReachDeckSpeechMarkupV1;
    },
    signal: AbortSignal,
    onProgress?: (status: NarrationSpeechPreviewStatus) => void,
  ) => Promise<NarrationSpeechPreviewAudio>;
  /**
   * 保存 Interactive 单段落讲稿，并从该精确正文生成整段音频。`speechMarkup` 的偏移锚定在
   * `reachDeckInteractiveNarrationMarkdown(text)` 上，无标记时缺省。
   */
  onSaveInteractivePageNarrationAndGenerate?: (input: {
    pageId: string;
    text: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  /** 画布右上角"重新生成本页"图标（调试生成 prompt 用）：整页重跑版面+讲稿；缺省不渲染。 */
  onRegeneratePage?: (pageId: string) => Promise<void> | void;
  onGeneratePage?: (input: {
    document: ReachDeckDocument;
    pageId: string;
  }) => Promise<ReachDeckDocument | void> | ReachDeckDocument | void;
  onAssistantPrompt?: (
    input: ReachDeckEditorAssistantRequest,
  ) => Promise<ReachDeckEditorAssistantResponse> | ReachDeckEditorAssistantResponse;
  onAssistantDecision?: (input: {
    runtimeApprovalId: string;
    decision: 'approved' | 'rejected';
    /** The teacher confirmed applying this proposal over overlapping changes. */
    override?: boolean;
  }) => Promise<void> | void;
  /**
   * Check a proposal just before applying it. Overlap with other Decksmith turns, or pages changed
   * since the proposal was made, is shown for confirmation; some situations cannot be applied.
   */
  onAssistantApplyCheck?: (
    runtimeApprovalId: string,
  ) =>
    | Promise<ReachDeckEditorAssistantApplyCheck | undefined>
    | ReachDeckEditorAssistantApplyCheck
    | undefined;
  /** Reconcile an already-approved candidate after its durable content save. */
  onAssistantAppliedRetry?: (runtimeApprovalId: string) => Promise<void> | void;
  /**
   * 恢复已批准候选前的版本证明（WP8 / M9）：宿主先把本地待保存的编辑落盘，再返回审批的冲突报告
   * （提案改动页、结构 / 外壳是否变化、哪些页在提案之后被修改过）。缺省时编辑器不会自动把候选
   * 写回草稿，只提供显式"重新采用"。
   */
  onAssistantRestoreCheck?: (
    runtimeApprovalId: string,
  ) => Promise<ReachDeckEditorAssistantRestoreCheck> | ReachDeckEditorAssistantRestoreCheck;
  /** Durable host save confirmed the approved Decksmith candidate. */
  assistantAppliedApprovalId?: string;
  /** Durable document save succeeded but Decksmith application confirmation failed. */
  assistantApplyFailedApprovalId?: string;
  /** Confirmation reached a terminal conflict; do not offer an endless retry loop. */
  assistantApplyTerminalApprovalId?: string;
  /** Host has durably recorded approval; rejection is no longer a valid UI action. */
  assistantApprovedApprovalId?: string;
  /** The host confirmed that this approval reached a terminal state and no longer owns a candidate. */
  assistantResolvedApprovalId?: string;
  /**
   * Set-valued forms of the approval ids above, for hosts running Decksmith on several pages at
   * once. They are merged with the single-id props.
   */
  assistantAppliedApprovalIds?: readonly string[];
  assistantApplyFailedApprovalIds?: readonly string[];
  assistantApplyTerminalApprovalIds?: readonly string[];
  assistantApprovedApprovalIds?: readonly string[];
  assistantResolvedApprovalIds?: readonly string[];
  /**
   * 审批已结清，但候选被教师之后的修改替代、从未真正落进课件（WP8 的 superseded 结局）。
   * 这些提案显示"已被你之后的修改替代"，不显示"已应用"。
   */
  assistantSupersededApprovalIds?: readonly string[];
  /**
   * 待审提案在服务端的页面租约已过期（超过 2 小时未处理）：服务端不再据此拒绝生成落地，
   * 这些提案不再挡生成，只留在对话里挂起，应用时由冲突检查提示已失效。
   */
  assistantExpiredApprovalIds?: readonly string[];
  assistantStatus?: string;
  /**
   * A generation task owns the deck, so a new Decksmith request would conflict with it. The
   * composer stays visible but cannot send, and this reason is shown.
   */
  assistantBlockedReason?: string;
  /**
   * Decksmith owns the deck (running, or an approved proposal is still being saved), so actions
   * that start page, narration, audio or animation generation are disabled with this reason.
   */
  generationBlockedReason?: string;
  assistantSuggestions?: string[];
  assistantRecovery?: ReachDeckEditorAssistantRecovery;
  /** Every recovered result, at most one per page; merged with `assistantRecovery`. */
  assistantRecoveries?: readonly ReachDeckEditorAssistantRecovery[];
  assistantConnectionState?: 'reconnecting';
  assistantJobActive?: boolean;
  /**
   * Pages with a running Decksmith job. When given, each page's composer, progress and cancel are
   * independent and `assistantJobActive` / `assistantActivePageId` are ignored.
   */
  assistantJobPageIds?: readonly string[];
  /** Exact user-history entry for each running job; prevents retrying a previous turn. */
  assistantJobUserMessageIdsByPage?: Readonly<Record<string, string | undefined>>;
  /** Each new object represents real model/tool progress, including recovered/background jobs. */
  assistantJobProgressByPage?: Readonly<
    Record<string, { readonly text: string; readonly updatedAt: number } | undefined>
  >;
  /** Cancel the running job; hosts running several pages receive the page to cancel. */
  onAssistantCancel?: (pageId?: string) => Promise<void> | void;
  onAssistantRecoveryResolve?: (recoveryId: string) => void;
  assistantHistory?: ReachDeckEditorAssistantHistory;
  assistantActivePageId?: string;
  assistantBackgroundPageIds?: readonly string[];
  onAssistantPageChange?: (pageId: string) => void;
  onAssistantLoadOlder?: (pageId: string) => Promise<void> | void;
  onAssistantNewTopic?: (pageId: string) => Promise<void> | void;
  onAssistantDeleteConversation?: (pageId: string) => Promise<void> | void;
  /** Task 5 supplies this only after its trusted iframe selection bridge validates the marker. */
  interactiveComponentFocus?: ReachDeckEditorInteractiveComponentFocus;
  onInteractiveComponentFocusChange?: (
    focus: ReachDeckEditorInteractiveComponentFocus | undefined,
  ) => void;
  onInteractiveComponentFocusClear?: () => void;
  /**
   * 宿主打开"上传 HTML"面板。未提供时互动页只保留 Decksmith 入口，
   * 独立播放器与学生端不受影响。
   */
  onInteractiveHtmlUpload?: (pageId: string) => void;
  /** v2 原生媒体展示地址（resourceId → 短时签名 URL）；画布与缩略图共用。 */
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  /** Resolve candidate-only media without mutating the host's authoritative media coordinator. */
  resolveNativeResourceUrl?: (objectKey: string) => Promise<string>;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  /** Upload authoring media through the trusted host; the editor persists only stable metadata. */
  onUploadAuthoringMedia?: (input: {
    file: File;
    kind: ReachDeckAuthoringMediaKind;
    signal: AbortSignal;
  }) => Promise<{
    objectKey: string;
    contentType: string;
    digest: string;
    downloadUrl: string;
    assetId?: string;
    name?: string;
    sizeBytes?: number;
  }>;
  translate?: ReachDeckTranslate;
}

export interface ReachDeckEditorAssistantRequest {
  document: ReachDeckDocument;
  elementId?: string;
  /** 画布上的多选元素 id 集合（含单选），作为 Decksmith 的参考上下文。 */
  selectedElementIds?: string[];
  pageId: string;
  prompt: string;
  includeCurrentPage: boolean;
  mentionedPageIds: string[];
  /**
   * 其他页上被明确指定的元素（跨页回答 Decksmith 提问时点选的候选），以 pageId + elementId 精确标识；
   * 宿主据此生成该页的元素引用，同页同名候选也能区分。
   */
  mentionedElements?: { pageId: string; elementId: string }[];
  interactiveComponentFocus?: ReachDeckEditorInteractiveComponentFocus;
  /** 本条消息回答的 Decksmith 问题（outcome.clarification.questionId）；宿主随请求原样转发。 */
  answersQuestionId?: string;
  /** 流式进度回调：文本增量或工具进度说明，显示在思考指示器上。 */
  onProgress?: (text: string) => void;
}

export interface ReachDeckEditorAssistantResponse {
  changeSummary?: ReachDeckEditorAssistantChangeSummary;
  document?: ReachDeckDocument;
  message: string;
  outcome?: ReachDeckEditorAssistantOutcome;
  runtimeApprovalId?: string;
  historyRunId?: string;
  /**
   * Bounded compatibility marker for a legacy content-service job id used as historyRunId.
   * Hosts must omit this once Runtime supplies its authoritative run id.
   */
  legacyHistoryRunId?: string;
  originPageId?: string;
}

/**
 * Decksmith 建议的单页操作：
 * - `regenerate-page`：按大纲重新生成整页；
 * - `regenerate-page-narration`：AI 重写讲稿并生成音频与动画（完整流水线）；
 * - `regenerate-page-narration-text`：仅 AI 重写讲稿文字，仅幻灯片页；
 * - `generate-page-audio`：用已保存讲稿生成音频与时间戳，并清除讲稿动画；
 * - `regenerate-page-animations`：沿用现有音频时间戳仅重做动画，仅幻灯片页；
 * - `regenerate-page-media`：用已保存讲稿重新生成音频和动画。
 */
export interface ReachDeckEditorAssistantSuggestedAction {
  kind:
    | 'regenerate-page'
    | 'regenerate-page-narration'
    | 'regenerate-page-narration-text'
    | 'generate-page-audio'
    | 'regenerate-page-animations'
    | 'regenerate-page-media';
  pageId: string;
}

/** Decksmith 结构化提问的候选元素（服务端给出的页、修订、元素 id 与有界标签）。 */
export interface ReachDeckEditorAssistantClarificationCandidate {
  pageId: string;
  pageRevision: number;
  elementId: string;
  label: string;
}

/** Decksmith 以提问结束本轮：问题与选项是模型生成内容，原样显示。 */
export interface ReachDeckEditorAssistantClarification {
  questionId: string;
  question: string;
  options: readonly string[];
  candidates: readonly ReachDeckEditorAssistantClarificationCandidate[];
  expect: 'choice' | 'select-element' | 'text';
}

export interface ReachDeckEditorAssistantOutcome {
  schemaVersion: 'reach-deck-decksmith-outcome/v1';
  mutationStatus: 'none' | 'proposal' | 'partial';
  rejectedFontFamilies: readonly string[];
  toolErrorCount: number;
  /** Existing editor operations Decksmith offers as buttons because the teacher asked. */
  suggestedActions?: readonly ReachDeckEditorAssistantSuggestedAction[];
  /** Unfinished tasks when the turn stopped early (budget or step limit); only their count is shown. */
  remainingTasks?: readonly string[];
  /** Present when the turn stopped early on its run or daily token budget, or on its step limit. */
  completion?:
    | {
        state: 'budget-limited';
        scope: 'run' | 'daily';
        messageKey: string;
      }
    | {
        state: 'step-limited';
        messageKey: string;
      };
  /** Present when Decksmith ended the turn with a question instead of a proposal. */
  clarification?: ReachDeckEditorAssistantClarification;
  /**
   * 采用后由服务端自动生成媒体的页（WP8）：只作说明，不展示费用、不另行确认；
   * 生成进度与手动生成一样显示在页面状态里。
   */
  afterApply?: readonly {
    kind: 'generate-page-audio' | 'regenerate-page-media';
    pageId: string;
  }[];
}

export interface ReachDeckEditorInteractiveComponentFocus {
  pageId: string;
  componentId: string;
  label: string;
  detail?: string;
}

export type ReachDeckEditorAssistantHistoryEntry =
  | {
      id: string;
      kind: 'message';
      role: 'assistant' | 'user';
      text: string;
      outcome?: ReachDeckEditorAssistantOutcome;
    }
  | {
      id: string;
      kind: 'new-topic';
      messageKey: string;
      replacements: Readonly<Record<string, string>>;
    }
  | {
      id: string;
      kind: 'application-message';
      state: 'ordinary' | 'approaching' | 'needs_compaction' | 'blocked';
      messageKey:
        | 'reachDeck.decksmith.capacity.ordinary'
        | 'reachDeck.decksmith.capacity.approaching'
        | 'reachDeck.decksmith.capacity.compacting'
        | 'reachDeck.decksmith.capacity.blocked';
      guidance?: {
        action: 'new-topic';
        messageKey: 'reachDeck.decksmith.capacity.startNewTopic';
      };
    };

export interface ReachDeckEditorAssistantHistory {
  pageId: string;
  entries: readonly ReachDeckEditorAssistantHistoryEntry[];
  loading: boolean;
  loadingOlder?: boolean;
  hasOlder: boolean;
  error?: string;
}

function safeCapacityApplicationCopy(
  entry: Extract<ReachDeckEditorAssistantHistoryEntry, { kind: 'application-message' }>,
): { fallback: string } | undefined {
  const expected = {
    ordinary: {
      key: 'reachDeck.decksmith.capacity.ordinary',
      fallback: 'Decksmith 正在使用当前页的对话上下文。',
    },
    approaching: {
      key: 'reachDeck.decksmith.capacity.approaching',
      fallback: '当前页对话正在变长，但 Decksmith 仍可继续。',
    },
    needs_compaction: {
      key: 'reachDeck.decksmith.capacity.compacting',
      fallback: 'Decksmith 已整理较早的对话上下文并继续处理。',
    },
    blocked: {
      key: 'reachDeck.decksmith.capacity.blocked',
      fallback: 'Decksmith 无法安全地继续使用当前对话上下文。',
    },
  } as const;
  const copy = expected[entry.state];
  if (entry.messageKey !== copy.key) return undefined;
  if (
    entry.guidance !== undefined &&
    ((entry.state !== 'needs_compaction' && entry.state !== 'blocked') ||
      entry.guidance.action !== 'new-topic' ||
      entry.guidance.messageKey !== 'reachDeck.decksmith.capacity.startNewTopic')
  ) {
    return undefined;
  }
  if (entry.state === 'blocked' && entry.guidance === undefined) return undefined;
  return { fallback: copy.fallback };
}

export type ReachDeckEditorAssistantChangeSummary =
  | {
      schemaVersion: 'reach-deck-editor-change-summary/v1';
      status: 'grounded';
      addedPages: readonly ReachDeckEditorAssistantChangedPage[];
      removedPages: readonly ReachDeckEditorAssistantChangedPage[];
      modifiedPages: readonly ReachDeckEditorAssistantChangedPage[];
      documentMetadataChanged: boolean;
      resourcesChanged: boolean;
    }
  | {
      schemaVersion: 'reach-deck-editor-change-summary/v1';
      status: 'unavailable';
      reason: 'historical-baseline-unavailable';
    };

export interface ReachDeckEditorAssistantChangedPage {
  pageId: string;
  title: string;
}

export interface ReachDeckEditorAssistantRecovery {
  id: string;
  pageId?: string;
  state: 'ready' | 'stale';
  baselineDocument?: ReachDeckDocument;
  response: ReachDeckEditorAssistantResponse;
  /**
   * Pages the proposal changes (from its durable adoption proof). A recovered proposal whose
   * baseline draft is gone is then rebased onto the current draft by these pages.
   */
  changedPageIds?: readonly string[];
  /** The proposal changes the document envelope (title, theme, stage). */
  envelopeChanged?: boolean;
  /** The proposal adds, removes or reorders pages. */
  structural?: boolean;
}

/** One reason applying a Decksmith proposal needs confirmation or cannot proceed. */
export interface ReachDeckEditorAssistantConflict {
  kind: 'held' | 'adoption-in-progress' | 'stale' | 'structure-changed' | 'envelope-changed';
  pageIds: readonly string[];
  holder?: { originPageId: string; state: 'running' | 'pending' | 'approved-unsaved' };
}

export interface ReachDeckEditorAssistantApplyCheck {
  expired: boolean;
  structural: boolean;
  /** Every conflict can be resolved by applying this proposal over the others. */
  overridable: boolean;
  conflicts: readonly ReachDeckEditorAssistantConflict[];
}

/** 恢复证明：冲突报告 + 采用证明给出的提案改动页（WP8 / M9）。 */
export interface ReachDeckEditorAssistantRestoreCheck extends ReachDeckEditorAssistantApplyCheck {
  changedPageIds?: readonly string[];
  envelopeChanged?: boolean;
}

interface AssistantMessage {
  action?: 'new-topic';
  approvalPhase?:
    | 'proposal'
    | 'saving'
    | 'apply-failed'
    | 'apply-terminal'
    | 'applied'
    | 'superseded'
    | 'rejected';
  changeSummary?: ReachDeckEditorAssistantChangeSummary;
  capacityState?: 'ordinary' | 'approaching' | 'needs_compaction' | 'blocked';
  guidanceTranslation?: LocalizedEditorCopy;
  id: string;
  persistedUserMessageIdsAtCreation?: readonly string[];
  role: 'assistant' | 'boundary' | 'system' | 'user';
  runtimeApprovalId?: string;
  outcome?: ReachDeckEditorAssistantOutcome;
  text: string;
  translation?: LocalizedEditorCopy;
  suffixTranslation?: LocalizedEditorCopy;
}

type AssistantRetryRequest = Omit<ReachDeckEditorAssistantRequest, 'document' | 'onProgress'>;
type StoppedAssistantRequest = {
  operationId: number;
  topicId: string | undefined;
  userMessageId?: string;
  request?: AssistantRetryRequest;
};

function currentAssistantTopicMessages(messages: readonly AssistantMessage[]): AssistantMessage[] {
  const reversed = [...messages].reverse();
  const boundary = reversed.findIndex((message) => message.role === 'boundary');
  return boundary < 0 ? reversed : reversed.slice(0, boundary);
}

/** 画布点选会话：提问所在页（回答在这一页的对话里发送）与待选的问题。 */
interface ClarificationPickSession {
  originPageId: string;
  clarification: ReachDeckEditorAssistantClarification;
}

interface LegacyAssistantRun {
  assistantText: string;
  runId: string;
  userText?: string;
}

const MAX_LEGACY_ASSISTANT_RUNS_PER_PAGE = 4;

function historyMessageRunId(
  entry: ReachDeckEditorAssistantHistoryEntry,
  role: 'assistant' | 'user',
): string | undefined {
  if (entry.kind !== 'message' || entry.role !== role) return undefined;
  const suffix = `:${role}`;
  return entry.id.endsWith(suffix) && entry.id.length > suffix.length
    ? entry.id.slice(0, -suffix.length)
    : undefined;
}

function authoritativeRunIdForLegacy(
  entries: readonly ReachDeckEditorAssistantHistoryEntry[],
  legacy: LegacyAssistantRun,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
    if (entry.text !== legacy.assistantText) continue;
    const runId = historyMessageRunId(entry, 'assistant');
    if (runId === undefined || runId === legacy.runId) continue;
    if (
      legacy.userText !== undefined &&
      !entries.some(
        (candidate) =>
          historyMessageRunId(candidate, 'user') === runId &&
          candidate.kind === 'message' &&
          candidate.text === legacy.userText,
      )
    ) {
      continue;
    }
    return runId;
  }
  return undefined;
}

interface LocalizedEditorCopy {
  fallback: string;
  key: string;
  replacements?: Record<string, string | number>;
}

function upsertAssistantMessage(
  current: readonly AssistantMessage[],
  incoming: AssistantMessage,
): AssistantMessage[] {
  let inserted = false;
  const reconciled: AssistantMessage[] = [];
  for (const message of current) {
    if (message.id !== incoming.id) {
      reconciled.push(message);
      continue;
    }
    if (inserted) continue;
    inserted = true;
    reconciled.push({
      ...message,
      ...incoming,
      ...((incoming.changeSummary ?? message.changeSummary) === undefined
        ? {}
        : { changeSummary: incoming.changeSummary ?? message.changeSummary }),
      ...((incoming.translation ?? message.translation) === undefined
        ? {}
        : { translation: incoming.translation ?? message.translation }),
      ...((incoming.suffixTranslation ?? message.suffixTranslation) === undefined
        ? {}
        : { suffixTranslation: incoming.suffixTranslation ?? message.suffixTranslation }),
      ...((incoming.outcome ?? message.outcome) === undefined
        ? {}
        : { outcome: incoming.outcome ?? message.outcome }),
    });
  }
  if (!inserted) reconciled.push(incoming);
  return reconciled;
}

function resolvePreviewPageId(
  originalPages: readonly ReachDeckPublishedPage[],
  candidatePages: readonly ReachDeckPublishedPage[],
  activePageId: string | undefined,
): string | undefined {
  if (candidatePages.length === 0) return undefined;
  if (activePageId !== undefined && candidatePages.some((page) => page.pageId === activePageId)) {
    return activePageId;
  }
  const originalIndex = originalPages.findIndex((page) => page.pageId === activePageId);
  const candidateIndex = Math.max(
    0,
    Math.min(originalIndex < 0 ? 0 : originalIndex, candidatePages.length - 1),
  );
  return [...candidatePages].sort((left, right) => left.order - right.order)[candidateIndex]
    ?.pageId;
}

function formatGroundedAssistantChangeSummary(
  summary: Extract<ReachDeckEditorAssistantChangeSummary, { status: 'grounded' }>,
  translate: (
    key: string,
    fallback: string,
    replacements?: Record<string, string | number>,
  ) => string,
): string {
  const parts: string[] = [];
  const pageChange = (
    key: string,
    fallback: string,
    pages: readonly ReachDeckEditorAssistantChangedPage[],
  ) => {
    if (pages.length === 0) return;
    parts.push(
      translate(key, fallback, {
        count: pages.length,
        titles: pages.map((page) => page.title.trim() || page.pageId).join('、'),
      }),
    );
  };
  pageChange(
    'reachDeck.editor.assistant.actualChangesAdded',
    '新增 {count} 页（{titles}）',
    summary.addedPages,
  );
  pageChange(
    'reachDeck.editor.assistant.actualChangesRemoved',
    '删除 {count} 页（{titles}）',
    summary.removedPages,
  );
  pageChange(
    'reachDeck.editor.assistant.actualChangesModified',
    '修改 {count} 页（{titles}）',
    summary.modifiedPages,
  );
  if (summary.documentMetadataChanged) {
    parts.push(translate('reachDeck.editor.assistant.actualChangesMetadata', '文档元数据已变更'));
  }
  if (summary.resourcesChanged) {
    parts.push(translate('reachDeck.editor.assistant.actualChangesResources', '媒体资源已变更'));
  }
  return parts.length === 0
    ? translate('reachDeck.editor.assistant.actualChangesNone', '实际文档无变化。')
    : parts.join('；') + '。';
}

function formatDecksmithOutcome(
  outcome: ReachDeckEditorAssistantOutcome,
  translate: (
    key: string,
    fallback: string,
    replacements?: Record<string, string | number>,
  ) => string,
): string {
  const parts = [
    outcome.clarification !== undefined
      ? translate(
          'reachDeck.editor.assistant.outcome.clarification',
          'Decksmith 需要你先回答一个问题，课件尚未修改。',
        )
      : outcome.mutationStatus === 'none'
        ? translate('reachDeck.editor.assistant.outcome.none', 'Decksmith 未修改课件。')
        : outcome.mutationStatus === 'proposal'
          ? translate(
              'reachDeck.editor.assistant.outcome.proposal',
              'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。',
            )
          : translate(
              'reachDeck.editor.assistant.outcome.partial',
              'Decksmith 已生成部分修改建议，请检查实际变更后再决定是否采用。',
            ),
  ];
  if (outcome.rejectedFontFamilies.length > 0) {
    parts.push(
      translate(
        'reachDeck.editor.assistant.outcome.rejectedFonts',
        '已拒绝非平台内置字体请求：{fonts}。',
        { fonts: outcome.rejectedFontFamilies.join(', ') },
      ),
    );
  }
  if (outcome.toolErrorCount > 0) {
    parts.push(
      translate('reachDeck.editor.assistant.outcome.toolErrors', '有 {count} 个工具操作失败。', {
        count: outcome.toolErrorCount,
      }),
    );
  }
  return parts.join(' ');
}

/**
 * 某页对话里仍在等待回答的 Decksmith 提问：只有最后一条对话消息是带提问的 Decksmith 回复时才算；
 * 之后有任何教师消息、回复或新话题，旧问题只保留展示。
 */
function openClarificationOf(messages: readonly AssistantMessage[]):
  | {
      clarification: ReachDeckEditorAssistantClarification;
      messageId: string;
    }
  | undefined {
  const last = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'user' || message.role === 'assistant' || message.role === 'boundary',
    );
  const clarification = last?.role === 'assistant' ? last.outcome?.clarification : undefined;
  return clarification === undefined || last === undefined
    ? undefined
    : { clarification, messageId: last.id };
}

/** 上下文 chip 的元素类型图标。 */
const NATIVE_ELEMENT_TYPE_ICONS: Readonly<Record<ReachDeckNativeElementV2['type'], LucideIcon>> = {
  audio: Music,
  chart: ChartColumn,
  diagram: Workflow,
  formula: Sigma,
  group: GroupIcon,
  image: ImageIcon,
  line: MinusIcon,
  scientificVisual: FlaskConical,
  shape: Shapes,
  table: TableIcon,
  textFrame: TypeIcon,
  video: Video,
};

/** 上下文 chip 的元素类型名（编辑器内置中文回退，宿主目录提供双语）。 */
const NATIVE_ELEMENT_TYPE_NAMES: Readonly<Record<ReachDeckNativeElementV2['type'], string>> = {
  audio: '音频',
  chart: '图表',
  diagram: '图示',
  formula: '公式',
  group: '组合',
  image: '图片',
  line: '线条',
  scientificVisual: '科学示意图',
  shape: '形状',
  table: '表格',
  textFrame: '文本框',
  video: '视频',
};

/** 额度收尾提示：只显示剩余条数与固定文案，不显示服务端的任务文本。 */
function formatDecksmithBudgetNotice(
  outcome: ReachDeckEditorAssistantOutcome,
  translate: (
    key: string,
    fallback: string,
    replacements?: Record<string, string | number>,
  ) => string,
): string | undefined {
  const completion = outcome.completion;
  if (completion === undefined) return undefined;
  const count = Math.max(1, outcome.remainingTasks?.length ?? 0);
  if (completion.state === 'step-limited') {
    return translate(
      'reachDeck.decksmith.stepLimited',
      '本次已达到单次执行步数上限，还有 {count} 项未完成，回复"继续"接着做。',
      { count },
    );
  }
  if (completion.state !== 'budget-limited') return undefined;
  return completion.scope === 'daily'
    ? translate(
        'reachDeck.decksmith.budget.dailyLimited',
        '今日 AI 额度已用完，还有 {count} 项未完成，额度恢复后回复"继续"接着做。',
        { count },
      )
    : translate(
        'reachDeck.decksmith.budget.runLimited',
        '本次额度已用完，还有 {count} 项未完成，回复"继续"接着做。',
        { count },
      );
}

/**
 * A host rejects a decision with the runtime's conflict report attached (`applyCheck`) when
 * applying needs the teacher's confirmation or is no longer possible.
 */
function assistantApplyCheckFromError(
  error: unknown,
): ReachDeckEditorAssistantApplyCheck | undefined {
  if (typeof error !== 'object' || error === null || !('applyCheck' in error)) return undefined;
  const check = (error as { applyCheck?: unknown }).applyCheck;
  return typeof check === 'object' &&
    check !== null &&
    Array.isArray((check as { conflicts?: unknown }).conflicts)
    ? (check as ReachDeckEditorAssistantApplyCheck)
    : undefined;
}

/** Merge a single approval id prop with its set-valued form into one stable set. */
function useApprovalIdSet(
  single: string | undefined,
  many: readonly string[] | undefined,
): ReadonlySet<string> {
  const key = [single ?? '', ...(many ?? [])].join('\u0000');
  return useMemo(
    () => new Set([...(single === undefined ? [] : [single]), ...(many ?? [])]),
    // `key` captures both inputs; hosts rebuild the arrays on every render.
    [key],
  );
}

function AssistantConversation({
  children,
  loading,
  loadingOverlay,
}: {
  children: ReactNode;
  loading: boolean;
  loadingOverlay: ReactNode;
}) {
  return (
    <div className="reach-deck-editor__assistant-conversation">
      <div
        aria-live="polite"
        className="reach-deck-editor__assistant-messages"
        inert={loading}
        role="log"
      >
        {children}
      </div>
      {loadingOverlay}
    </div>
  );
}

export function ReachDeckEditor({
  document,
  mediaSlotsByPageId,
  imageGeneratingPageIds,
  onRegenerateImage,
  mediaSlotFocusRequest,
  workspacePageRailHeader,
  workspaceCommandBar,
  workspaceCanvasAction,
  workspaceNarrationPanelAction,
  workspaceRightPanelAction,
  disabled = false,
  disabledReason,
  lockedPageIds,
  previewableLockedPageIds,
  lockedPageReason,
  lockedPageReasonById,
  generationStatusByPageId,
  batchStatusByPageId,
  generationActionError,
  structureLocked = false,
  decksmithStructureHold = false,
  onReleaseDecksmithStructureHold,
  allowDeletingGeneratingPages = false,
  generationInFlightPageIds,
  onConfirmGeneratingPageDeletion,
  idFactory = defaultIdFactory,
  locale = 'zh-CN',
  onChange,
  onBeforeActivePageChange,
  onRequestPptxInsert,
  onRequestMaicInsert,
  onRegeneratePageNarration,
  narrationRegeneratablePageIds,
  allowedNarrationSpeechMarkTypes,
  onSavePageNarrationAndGenerate,
  onSavePageNarrationDraft,
  onSaveInteractivePageNarrationDraft,
  onRequestRegenerationPage,
  onRegisterRegenerationPreparation,
  onRegisterMediaClear,
  documentHistoryDisabled = false,
  onSavePageNarrationAudio,
  onRegeneratePageNarrationAnimations,
  onRegeneratePageAnimationsOnly,
  onRequestPageSpeechMarkupCandidates,
  onPreviewPageSpeech,
  onSaveInteractivePageNarrationAndGenerate,
  onRegeneratePage,
  onGeneratePage,
  onAssistantDecision,
  onAssistantAppliedRetry,
  onAssistantRestoreCheck,
  onAssistantPrompt,
  assistantStatus,
  assistantBlockedReason,
  generationBlockedReason: hostGenerationBlockedReason,
  assistantApprovedApprovalId,
  assistantApprovedApprovalIds,
  assistantRecovery,
  assistantRecoveries,
  assistantConnectionState,
  assistantJobActive: assistantJobActiveProp = false,
  assistantJobPageIds,
  assistantJobUserMessageIdsByPage,
  assistantJobProgressByPage,
  onAssistantApplyCheck,
  assistantHistory,
  assistantActivePageId,
  assistantBackgroundPageIds = [],
  onAssistantCancel,
  onAssistantDeleteConversation,
  onAssistantLoadOlder,
  onAssistantNewTopic,
  onAssistantPageChange,
  onAssistantRecoveryResolve,
  assistantAppliedApprovalId,
  assistantAppliedApprovalIds,
  assistantApplyFailedApprovalId,
  assistantApplyFailedApprovalIds,
  assistantApplyTerminalApprovalId,
  assistantApplyTerminalApprovalIds,
  assistantResolvedApprovalId,
  assistantResolvedApprovalIds,
  assistantSupersededApprovalIds,
  assistantExpiredApprovalIds,
  interactiveComponentFocus,
  onInteractiveComponentFocusChange,
  onInteractiveComponentFocusClear,
  onInteractiveHtmlUpload,
  assistantSuggestions,
  nativeResourceUrlsById = EMPTY_NATIVE_RESOURCE_URLS,
  resolveNativeResourceUrl,
  resolveAttachmentUrl,
  onUploadAuthoringMedia,
  translate,
}: ReachDeckEditorProps) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const localizedCopy = (
    key: string,
    fallback: string,
    replacements?: Record<string, string | number>,
  ): LocalizedEditorCopy => ({ fallback, key, ...(replacements ? { replacements } : {}) });
  const renderLocalizedCopy = (copy: LocalizedEditorCopy): string =>
    text(copy.key, copy.fallback, copy.replacements);
  const clearInteractiveComponentFocus = () => {
    onInteractiveComponentFocusChange?.(undefined);
    onInteractiveComponentFocusClear?.();
  };
  const resolvedAssistantSuggestions = assistantSuggestions ?? [
    text('reachDeck.editor.assistant.suggestion.title', '把标题更有吸引力'),
    text('reachDeck.editor.assistant.suggestion.shorten', '精简当前页文字'),
    text('reachDeck.editor.assistant.suggestion.highlight', '增加一个重点提示'),
  ];
  const [draft, setDraft] = useState(() => parseReachDeckDocument(document));
  const persistedBaselineRef = useRef(draft);
  const draftRef = useRef(draft);
  const editorRootRef = useRef<HTMLElement>(null);
  const editorInstanceRef = useRef(Symbol('reach-deck-editor'));
  const clipboardPasteSequenceRef = useRef<{ count: number; signature?: string }>({ count: 0 });
  const localClipboardCopyRef = useRef<{
    elements?: string;
    native?: string;
    pageId: string;
  }>(undefined);
  const compositionActiveRef = useRef(false);
  const mediaInputImageRef = useRef<HTMLInputElement>(null);
  const mediaInputAudioRef = useRef<HTMLInputElement>(null);
  const mediaInputVideoRef = useRef<HTMLInputElement>(null);
  const mediaUploadAbortRef = useRef<AbortController | undefined>(undefined);
  const mediaInsertionStateRef = useRef({
    busyAction: undefined as 'generate' | 'retry-layout' | undefined,
    disabled,
    lockedPageIds: new Set(lockedPageIds ?? []),
    structureLocked,
    allowDeletingGeneratingPages,
  });
  const lastEmittedDocumentRef = useRef<ReachDeckDocument | undefined>(undefined);
  const draftVersionRef = useRef(0);
  // 只计教师自己的编辑（提交与撤销 / 重做），不计服务端回写：恢复证明据此判断检查期间有没有本地编辑。
  const localEditVersionRef = useRef(0);
  const operationIdRef = useRef(0);
  const assistantOperationIdRef = useRef(0);
  const assistantSystemMessageIdRef = useRef(-1);
  const assistantRecoverySeenRef = useRef<Set<string>>(new Set());
  const [mediaSlotError, setMediaSlotError] = useState<string>();
  const [imageSubmissionPageId, setImageSubmissionPageId] = useState<string>();
  const imageSubmittingRef = useRef(false);
  const [activePageId, setActivePageId] = useState<string | undefined>(document.pages[0]?.pageId);
  const [selectedElementId, setSelectedElementIdState] = useState<string>();
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const [selectedAnimationId, setSelectedAnimationId] = useState<string>();
  const selectedElementIdRef = useRef(selectedElementId);
  const selectedElementIdsRef = useRef(selectedElementIds);
  const selectedAnimationIdRef = useRef(selectedAnimationId);
  const restoringHistorySelectionRef = useRef(false);
  const restoringHistorySelectionTimerRef = useRef<number | undefined>(undefined);
  selectedElementIdRef.current = selectedElementId;
  selectedElementIdsRef.current = selectedElementIds;
  selectedAnimationIdRef.current = selectedAnimationId;
  const historyRef = useRef(createReachDeckDocumentHistory());
  const activeHistoryGroupRef = useRef<string | undefined>(undefined);
  const [, setHistoryVersion] = useState(0);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('decksmith');
  const [pageRailCollapsed, setPageRailCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const rightPanelTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const narrationRegenerateButtonRef = useRef<HTMLButtonElement>(null);
  const [focusNarrationRegenerateRequested, setFocusNarrationRegenerateRequested] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  // 预览倍速跨页保留：幻灯片时间轴与互动讲稿试听共用同一档。
  const [playbackRate, setPlaybackRate] = useState(1);
  // 动画演示（更换效果/缓动、新建动画后自动播放一遍起止）：只在画布上应用这一条动画，
  // 不动播放头、不放音频；点击画布、播放、切页或演示结束即回到原编辑画面。
  const [animationDemo, setAnimationDemo] = useState<{
    pageId: string;
    animationId: string;
    animation: ReachDeckAnimationV2;
    time: number;
  }>();
  const animationDemoFrameRef = useRef<number | undefined>(undefined);
  const [narrationSeekRequest, setNarrationSeekRequest] = useState<ReachDeckNarrationSeekRequest>();
  const narrationSeekRequestIdRef = useRef(0);
  const narrationDraftCache = useRef<NarrationDraftCache>(new Map());
  // 采用 AI 候选时被替换掉的未保存讲稿（WP8 / S8），按页暂存以便提示与撤销；
  // epoch 变化会重新挂载该页讲稿面板，让组件状态与缓存同步重置。
  const [replacedNarrationDrafts, setReplacedNarrationDrafts] = useState<
    Readonly<Record<string, NarrationDraftCacheEntry>>
  >({});
  const [narrationEditorEpochs, setNarrationEditorEpochs] = useState<
    Readonly<Record<string, number>>
  >({});
  const bumpNarrationEditorEpochs = (pageIds: readonly string[]) => {
    if (pageIds.length === 0) return;
    setNarrationEditorEpochs((current) => {
      const next = { ...current };
      for (const pageId of pageIds) next[pageId] = (next[pageId] ?? 0) + 1;
      return next;
    });
  };
  /**
   * 把 AI 候选写进草稿（采用）。改写了讲稿的页上若有教师未保存的讲稿，显式替换并允许撤销，
   * 而不是让旧 dirty draft 静默盖住 AI 讲稿；预览、拒绝与服务端回填不走这里。
   */
  const commitAdoptedAssistantDocument = (adopted: ReachDeckDocument) => {
    const replaced = takeReplacedNarrationDrafts(
      narrationDraftCache.current,
      draftRef.current,
      adopted,
    );
    commit(adopted, { adoption: true });
    const pageIds = Object.keys(replaced);
    if (pageIds.length === 0) return;
    setReplacedNarrationDrafts((current) => ({ ...current, ...replaced }));
    bumpNarrationEditorEpochs(pageIds);
  };
  const undoReplacedNarrationDraft = (pageId: string) => {
    const entry = replacedNarrationDrafts[pageId];
    if (entry === undefined) return;
    if (restoreReplacedNarrationDraft(narrationDraftCache.current, pageId, entry)) {
      bumpNarrationEditorEpochs([pageId]);
    }
    setReplacedNarrationDrafts((current) => {
      const { [pageId]: _removed, ...rest } = current;
      return rest;
    });
  };
  const dismissReplacedNarrationDraft = (pageId: string) =>
    setReplacedNarrationDrafts((current) => {
      const { [pageId]: _removed, ...rest } = current;
      return rest;
    });
  const renderReplacedNarrationNotice = (pageId: string) =>
    replacedNarrationDrafts[pageId] === undefined ? null : (
      <p className="reach-deck-editor__narration-status" data-narration-replaced role="status">
        {text('reachDeck.editor.narration.replacedByAssistant', 'AI 讲稿已替换你未保存的讲稿。')}{' '}
        <button
          className="reach-deck-editor__assistant-guidance-action"
          onClick={() => undoReplacedNarrationDraft(pageId)}
          type="button"
        >
          {text('reachDeck.editor.narration.restoreReplacedDraft', '恢复我的讲稿')}
        </button>{' '}
        <button
          className="reach-deck-editor__assistant-guidance-action"
          onClick={() => dismissReplacedNarrationDraft(pageId)}
          type="button"
        >
          {text('reachDeck.editor.narration.keepAssistantNarration', '保留 AI 讲稿')}
        </button>
      </p>
    );
  const regenerationPreparationRef = useRef<(pageId?: string) => Promise<void>>(
    async () => undefined,
  );
  regenerationPreparationRef.current = async (pageId) => {
    const current = draftRef.current;
    // 已删除页面的草稿没有落点，跳过；否则宿主的整份保存会被一页已不存在的草稿永久挡住。
    const pending = [...narrationDraftCache.current.entries()]
      .filter(
        ([id, entry]) =>
          entry.dirty &&
          (pageId === undefined || id === pageId) &&
          current.pages.some((page) => page.pageId === id),
      )
      .map(([id, entry]) => {
        const page = current.pages.find((candidate) => candidate.pageId === id);
        const slide = current.nativeSlides.find((candidate) => candidate.pageId === id)?.slide;
        if (page === undefined || (page.sceneType !== 'interactive' && slide === undefined))
          throw Object.assign(
            new Error(
              text(
                'reachDeck.regeneration.draftConflict',
                '讲稿已在其他位置发生变化，请先检查并保存当前草稿。',
              ),
            ),
            { name: 'ReachDeckUserFacingError' },
          );
        const value = prepareNarrationDraftForRegeneration(
          entry,
          page.sceneType === 'interactive'
            ? { interactive: { id, narration: page.scene.narration } }
            : { slide },
          translate,
          allowedNarrationSpeechMarkTypes,
        );
        return { id, entry, value, interactive: page.sceneType === 'interactive' };
      });
    const saved: string[] = [];
    try {
      for (const { id, entry, value, interactive } of pending) {
        if (interactive) {
          if (onSaveInteractivePageNarrationDraft === undefined || value.text === undefined)
            throw Object.assign(
              new Error(
                text(
                  'reachDeck.regeneration.invalidDraft',
                  '有未保存的讲稿未通过校验，请先修正后再生成。',
                ),
              ),
              { name: 'ReachDeckUserFacingError' },
            );
          await onSaveInteractivePageNarrationDraft({
            pageId: id,
            text: value.text,
            speechMarkup: value.speechMarkup,
          });
        } else {
          if (onSavePageNarrationDraft === undefined)
            throw Object.assign(
              new Error(
                text(
                  'reachDeck.regeneration.invalidDraft',
                  '有未保存的讲稿未通过校验，请先修正后再生成。',
                ),
              ),
              { name: 'ReachDeckUserFacingError' },
            );
          await onSavePageNarrationDraft({
            pageId: id,
            markdown: value.markdown,
            speechMarkup: value.speechMarkup,
          });
        }
        const latest = narrationDraftCache.current.get(id);
        if (latest?.draftState !== entry.draftState || latest.speechSpeak !== entry.speechSpeak)
          throw Object.assign(
            new Error(
              text(
                'reachDeck.regeneration.draftChanged',
                '讲稿在保存期间发生变化，请检查后重新提交。',
              ),
            ),
            { name: 'ReachDeckUserFacingError' },
          );
        narrationDraftCache.current.set(id, {
          ...latest,
          dirty: false,
          baselineIdentity: value.baselineIdentity,
          sourceIdentity: value.sourceIdentity,
        });
        saved.push(id);
      }
    } finally {
      bumpNarrationEditorEpochs(saved);
    }
  };
  useEffect(() => {
    onRegisterRegenerationPreparation?.((pageId) => regenerationPreparationRef.current(pageId));
    return () => onRegisterRegenerationPreparation?.(undefined);
  }, [onRegisterRegenerationPreparation]);
  const mediaClearRef = useRef<ReachDeckMediaClearHandler>(() => ({
    document: draftRef.current,
    changedPageIds: [],
    skippedPageIds: [],
  }));
  useEffect(() => {
    onRegisterMediaClear?.((selection, options) => mediaClearRef.current(selection, options));
    return () => onRegisterMediaClear?.(undefined);
  }, [onRegisterMediaClear]);

  // Interactive 讲稿草稿由讲稿面板持有（跨页保留在 narrationDraftCache 中）；这里只记录当前页面板
  // 上报的快照，供画布下方状态条显示，并通过面板句柄保存完全相同的内容。
  const [interactiveNarrationSnapshot, setInteractiveNarrationSnapshot] = useState<{
    draft: InteractiveNarrationDraftSnapshot;
    pageId: string;
  }>();
  const interactiveNarrationActionsRef = useRef<NarrationEditorInteractiveHandle>(null);
  const [activeQuizQuestionIndex, setActiveQuizQuestionIndex] = useState(0);
  const [geometryModeByPageId, setGeometryModeByPageId] = useState<
    Record<string, 'edit' | 'trial'>
  >({});
  const [geometryInstanceIdByPageId, setGeometryInstanceIdByPageId] = useState<
    Record<string, string | undefined>
  >({});
  const [geometrySelectedItemByPageId, setGeometrySelectedItemByPageId] = useState<
    Record<string, { category: 'objects' | 'measurements' | 'relations'; id: string } | undefined>
  >({});
  const [latestGeometryProposalByInstance, setLatestGeometryProposalByInstance] = useState<
    Record<string, GeometryAuthoringEditProposal | undefined>
  >({});
  const [geometryEditRuntimeByPageId, setGeometryEditRuntimeByPageId] =
    useState<ReachDeckRuntimeByPageId>({});
  const [geometryAuthoringErrorByPageId, setGeometryAuthoringErrorByPageId] = useState<
    Record<string, string | undefined>
  >({});
  const quizQuestionTypeSessionsRef = useRef(new Map<string, QuizQuestionTypeSession>());
  const commandContextRef = useRef<EditorCommandContext>('canvas');
  const previewRef = useRef<HTMLElement>(null);
  const [richTextToolbarTarget, setRichTextToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [inlineTextSession, setInlineTextSession] = useState<{
    elementId: string;
    cellId?: string;
    original: RichTextDocument;
    draft: RichTextDocument;
    /** true 表示编辑的是原生 v2 文本框；提交路径不同，编辑器完全同款。 */
    native?: boolean;
    /** Only a frame created by the current blank-canvas gesture is removed when left empty. */
    createdFromBlankCanvas?: boolean;
  }>();
  /** 单选入口：同时同步多选集合，避免两个选择状态漂移。 */
  const setSelectedElementId = (elementId: string | undefined) => {
    setSelectedElementIdState(elementId);
    setSelectedElementIds(elementId === undefined ? [] : [elementId]);
    setSelectedAnimationId(undefined);
    if (elementId !== undefined) setRightPanelTab('properties');
  };
  const [pageMenu, setPageMenu] = useState<{
    pageId: string;
    x: number;
    y: number;
  }>();
  const [elementMenu, setElementMenu] = useState<{
    x: number;
    y: number;
    elementIds: string[];
    hitElementId?: string;
  }>();
  const [pageSelection, setPageSelection] = useState<PageSelection>({
    selectedPageIds: [],
    selectionAnchorPageId: undefined,
    focusedPageId: undefined,
  });
  const [pageMarquee, setPageMarquee] = useState<PageMarquee | undefined>(undefined);
  const pageMarqueeRef = useRef<PageMarquee | undefined>(undefined);
  const [insertionMenu, setInsertionMenu] = useState<{
    target: ReachDeckPageInsertionTarget;
    x: number;
    y: number;
    openSubmenu?: 'new' | 'import';
    submenuSide: 'left' | 'right' | 'below';
  }>();
  const pageMenuRef = useRef<HTMLDivElement>(null);
  const [pageMenuTop, setPageMenuTop] = useState(0);

  useEffect(() => {
    if (pageMenu === undefined && elementMenu === undefined) return;
    const menu = editorRootRef.current?.querySelector<HTMLElement>(
      elementMenu === undefined
        ? '.reach-deck-editor__page-menu[role="menu"]'
        : '.reach-deck-editor__element-menu',
    );
    menu?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const pageId = pageMenu?.pageId;
      setPageMenu(undefined);
      setElementMenu(undefined);
      if (pageId !== undefined) {
        [...(editorRootRef.current?.querySelectorAll<HTMLElement>('[data-page-card]') ?? [])]
          .find((card) => card.dataset.pageId === pageId)
          ?.focus();
      } else {
        previewRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [elementMenu, pageMenu]);

  useLayoutEffect(() => {
    const menu = pageMenuRef.current;
    const anchor = insertionMenu ?? pageMenu;
    if (menu === null || anchor === undefined) return;

    // Keep menus above thumbnail stacking contexts and outside the scrolling rail's clip.
    // Older embedded browsers retain the existing fixed-position fallback.
    if (typeof menu.showPopover === 'function' && !menu.matches(':popover-open')) {
      menu.showPopover();
    }

    const positionMenu = () => {
      const bounds = menu.getBoundingClientRect();
      const submenu =
        insertionMenu?.submenuSide === 'below'
          ? null
          : menu.querySelector('.reach-deck-editor__page-submenu');
      const submenuBounds = submenu?.getBoundingClientRect();
      // Side submenus extend outside the parent; inline submenus grow its height.
      const topOffset = Math.min(bounds.top, submenuBounds?.top ?? bounds.top) - bounds.top;
      const bottomOffset =
        Math.max(bounds.bottom, submenuBounds?.bottom ?? bounds.bottom) - bounds.top;
      setPageMenuTop(
        Math.max(
          PAGE_MENU_VIEWPORT_GAP - topOffset,
          Math.min(anchor.y, window.innerHeight - PAGE_MENU_VIEWPORT_GAP - bottomOffset),
        ),
      );
    };
    positionMenu();
    window.addEventListener('resize', positionMenu);
    return () => window.removeEventListener('resize', positionMenu);
  }, [insertionMenu, pageMenu]);

  useEffect(() => {
    const preview = previewRef.current;
    if (preview === null) return;

    const scrollPreview = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      if (
        event.target instanceof Element &&
        event.target.closest('.reach-deck-editor__quiz-canvas') !== null
      )
        return;

      const maxScrollTop = Math.max(0, preview.scrollHeight - preview.clientHeight);
      if (maxScrollTop === 0) return;

      const deltaY =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * preview.clientHeight
            : event.deltaY;
      const nextScrollTop = Math.max(0, Math.min(maxScrollTop, preview.scrollTop + deltaY));
      if (nextScrollTop === preview.scrollTop) return;

      preview.scrollTop = nextScrollTop;
      event.preventDefault();
      event.stopPropagation();
    };

    preview.addEventListener('wheel', scrollPreview, { capture: true, passive: false });
    return () => preview.removeEventListener('wheel', scrollPreview, { capture: true });
  }, []);
  useEffect(() => {
    const instance = editorInstanceRef.current;
    if (activeReachDeckEditorInstance === undefined) activeReachDeckEditorInstance = instance;
    const deactivateOutside = (event: Event) => {
      if (activeReachDeckEditorInstance !== instance) return;
      const root = editorRootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        activeReachDeckEditorInstance = undefined;
      }
    };
    window.addEventListener('pointerdown', deactivateOutside, true);
    window.addEventListener('focusin', deactivateOutside, true);
    return () => {
      window.removeEventListener('pointerdown', deactivateOutside, true);
      window.removeEventListener('focusin', deactivateOutside, true);
      mediaUploadAbortRef.current?.abort();
      if (activeReachDeckEditorInstance === instance) activeReachDeckEditorInstance = undefined;
    };
  }, []);
  const [draggingPageIds, setDraggingPageIds] = useState<string[]>([]);
  const [dragOverPageId, setDragOverPageId] = useState<string>();
  useEffect(() => {
    // A touch context menu or a drop outside the rail may swallow the source's dragend.
    const resetPageDrag = () => {
      setDraggingPageIds([]);
      setDragOverPageId(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetPageDrag();
    };
    const onVisibilityChange = () => {
      if (globalThis.document.visibilityState === 'hidden') resetPageDrag();
    };
    const endEvents = ['dragend', 'drop', 'pointerup', 'blur', 'contextmenu'] as const;
    for (const name of endEvents) window.addEventListener(name, resetPageDrag);
    window.addEventListener('keydown', onKeyDown);
    globalThis.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      for (const name of endEvents) window.removeEventListener(name, resetPageDrag);
      window.removeEventListener('keydown', onKeyDown);
      globalThis.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
  const [busyAction, setBusyAction] = useState<'generate' | 'retry-layout'>();
  const retryLayoutInFlightRef = useRef<string | undefined>(undefined);
  const retryLayoutOperationRef = useRef(0);
  const [retryLayoutPageId, setRetryLayoutPageId] = useState<string>();
  const [retryLayoutErrors, setRetryLayoutErrors] = useState<
    Record<
      string,
      {
        message: string;
        status: unknown;
        revision?: number;
      }
    >
  >({});
  const retryLayoutDocumentIdRef = useRef(document.id);
  retryLayoutDocumentIdRef.current = document.id;
  const retryLayoutStatusRef = useRef(generationStatusByPageId);
  retryLayoutStatusRef.current = generationStatusByPageId;
  useEffect(() => {
    retryLayoutOperationRef.current += 1;
    retryLayoutInFlightRef.current = undefined;
    setRetryLayoutPageId(undefined);
    setRetryLayoutErrors({});
    setBusyAction((current) => (current === 'retry-layout' ? undefined : current));
  }, [document.id]);
  const [mediaUploadKind, setMediaUploadKind] = useState<ReachDeckAuthoringMediaKind>();
  const [mediaUploadError, setMediaUploadError] = useState<string>();
  const [uploadedNativeResourceUrlsById, setUploadedNativeResourceUrlsById] = useState<
    Readonly<Record<string, string>>
  >({});
  const resolvedNativeResourceUrlsById = useMemo(
    () => ({ ...uploadedNativeResourceUrlsById, ...nativeResourceUrlsById }),
    [nativeResourceUrlsById, uploadedNativeResourceUrlsById],
  );
  const quizImageUrlsByObjectKey = useMemo(
    () => reachDeckMediaUrlsByObjectKey(draft, resolvedNativeResourceUrlsById),
    [draft, resolvedNativeResourceUrlsById],
  );
  const [actionMessage, setActionMessage] = useState<string | LocalizedEditorCopy>();
  const [assistantPrompt, setAssistantPrompt] = useState('');
  // 教师取消了"回复 Decksmith 的问题"关联的页面 → 被取消关联的问题 id。
  const [assistantReplyUnlinkedByPage, setAssistantReplyUnlinkedByPage] = useState<
    Readonly<Record<string, string>>
  >({});
  // 画布点选（WP7 第二阶段）：教师按 Esc / 退出点选关闭高亮的问题 id。
  const [dismissedClarificationPickIds, setDismissedClarificationPickIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // 从提问页前往候选所在页时保留的点选会话。
  const [crossPageClarificationPick, setCrossPageClarificationPick] = useState<{
    originPageId: string;
    questionId: string;
  }>();
  // 画布上点中、等待"用这个"确认的候选。
  const [pendingClarificationPick, setPendingClarificationPick] = useState<{
    questionId: string;
    pageId: string;
    elementId: string;
  }>();
  // 在其他页确认的回答：回到提问页后经同一发送路径发出（回答必须在提问页的对话里发送）。
  const [queuedClarificationAnswer, setQueuedClarificationAnswer] = useState<{
    originPageId: string;
    fromPageId: string;
    questionId: string;
    prompt: string;
    mentionedElement: { pageId: string; elementId: string };
  }>();
  // Decksmith may run on several pages at once: busy state and progress are kept per page.
  const [assistantBusyPageIds, setAssistantBusyPageIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [assistantCancelBusy, setAssistantCancelBusy] = useState(false);
  const [assistantDecisionBusyPageId, setAssistantDecisionBusyPageId] = useState<string>();
  const [assistantProgressByPage, setAssistantProgressByPage] = useState<
    Readonly<Record<string, { text: string | undefined; updatedAt: number } | undefined>>
  >({});
  const assistantOperationByPageRef = useRef<Record<string, number>>({});
  const [assistantApplyCheck, setAssistantApplyCheck] = useState<{
    pageId: string;
    check: ReachDeckEditorAssistantApplyCheck;
  }>();
  const appliedApprovalIds = useApprovalIdSet(
    assistantAppliedApprovalId,
    assistantAppliedApprovalIds,
  );
  const applyFailedApprovalIds = useApprovalIdSet(
    assistantApplyFailedApprovalId,
    assistantApplyFailedApprovalIds,
  );
  const applyTerminalApprovalIds = useApprovalIdSet(
    assistantApplyTerminalApprovalId,
    assistantApplyTerminalApprovalIds,
  );
  const approvedApprovalIds = useApprovalIdSet(
    assistantApprovedApprovalId,
    assistantApprovedApprovalIds,
  );
  const resolvedApprovalIds = useApprovalIdSet(
    assistantResolvedApprovalId,
    assistantResolvedApprovalIds,
  );
  const supersededApprovalIds = useApprovalIdSet(undefined, assistantSupersededApprovalIds);
  const isAppliedApproval = (id: string | undefined) =>
    id !== undefined && appliedApprovalIds.has(id);
  const isApplyFailedApproval = (id: string | undefined) =>
    id !== undefined && applyFailedApprovalIds.has(id);
  const isApplyTerminalApproval = (id: string | undefined) =>
    id !== undefined && applyTerminalApprovalIds.has(id);
  const isApprovedApproval = (id: string | undefined) =>
    id !== undefined && approvedApprovalIds.has(id);
  const isResolvedApproval = (id: string | undefined) =>
    id !== undefined && (resolvedApprovalIds.has(id) || supersededApprovalIds.has(id));
  const isSupersededApproval = (id: string | undefined) =>
    id !== undefined && supersededApprovalIds.has(id);
  const recoveries = useMemo(
    () => [
      ...(assistantRecoveries ?? []),
      ...(assistantRecovery === undefined ||
      (assistantRecoveries ?? []).some((recovery) => recovery.id === assistantRecovery.id)
        ? []
        : [assistantRecovery]),
    ],
    [assistantRecoveries, assistantRecovery],
  );
  const assistantJobPages = useMemo(
    () => (assistantJobPageIds === undefined ? undefined : new Set(assistantJobPageIds)),
    [assistantJobPageIds],
  );
  const [assistantPreviewButton, setAssistantPreviewButton] = useState<HTMLButtonElement | null>(
    null,
  );
  const assistantComposerRef = useRef<HTMLTextAreaElement>(null);
  const focusAssistantComposerAfterActionRef = useRef(false);
  const [assistantPreviewing, setAssistantPreviewing] = useState(false);
  /** Decksmith 返回的待确认文档变更；教师点「应用修改」后才落到草稿。 */
  type PendingAssistantChange = {
    document?: ReachDeckDocument;
    baseVersion: number;
    /** Draft the request started from; lets a newer draft be rebased instead of discarded. */
    baseDocument?: ReachDeckDocument;
    messageId: string;
    legacyHistoryRunId?: string;
    recoveryId?: string;
    runtimeApprovalId?: string;
    /** The candidate is in local draft state; retain it until durable save is confirmed. */
    appliedLocally?: boolean;
    stale?: boolean;
    /** The authoritative document contains only part of this approved candidate. */
    recoverablePartial?: boolean;
    /**
     * 无法证明恢复不会覆盖较新的教师修改（WP8 / M9）：只能由教师显式重新采用这些页。
     */
    reAdopt?: {
      reason: 'later-edit' | 'overlap' | 'unmergeable' | 'unproven';
      pageIds: readonly string[];
    };
    /** Recovered proposal without its baseline draft: rebase onto the draft by these pages. */
    changedPageIds?: readonly string[];
    envelopeChanged?: boolean;
    structural?: boolean;
  };
  const introMessage = (): AssistantMessage => ({
    id: 'intro',
    role: 'assistant',
    text: '我是 Decksmith。告诉我你想怎样调整课件：可以改当前页、增删页面，或先选中元素再描述修改。',
    translation: localizedCopy(
      'reachDeck.editor.assistant.intro',
      '我是 Decksmith。告诉我你想怎样调整课件：可以改当前页、增删页面，或先选中元素再描述修改。',
    ),
  });
  const initialPageId = document.pages[0]?.pageId;
  const [pendingAssistantChanges, setPendingAssistantChanges] = useState<
    Record<string, PendingAssistantChange | undefined>
  >({});
  const pendingAssistantChangesRef = useRef(pendingAssistantChanges);
  pendingAssistantChangesRef.current = pendingAssistantChanges;
  // A proposal still awaiting the teacher's decision holds the deck on the server, so generation
  // would be rejected; the host cannot see this state, only the editor can. Once its lease has
  // expired the server accepts generation again, so an expired proposal stays put without blocking.
  const generationBlockedReason =
    hostGenerationBlockedReason ??
    (Object.values(pendingAssistantChanges).some(
      (change) =>
        change?.runtimeApprovalId !== undefined &&
        assistantExpiredApprovalIds?.includes(change.runtimeApprovalId) !== true,
    )
      ? text(
          'reachDeck.editor.assistant.generationBlockedByProposal',
          '请先采用或放弃 Decksmith 的修改建议，再开始生成',
        )
      : undefined);
  const [assistantMessagesByPage, setAssistantMessagesByPage] = useState<
    Record<string, AssistantMessage[]>
  >(() => (initialPageId === undefined ? {} : { [initialPageId]: [introMessage()] }));
  const assistantMessagesRef = useRef(assistantMessagesByPage);
  assistantMessagesRef.current = assistantMessagesByPage;
  const assistantRequestsRef = useRef<
    Record<string, { operationId: number; request: AssistantRetryRequest } | undefined>
  >({});
  const [stoppedAssistantRequests, setStoppedAssistantRequests] = useState<
    Record<string, StoppedAssistantRequest | undefined>
  >({});
  const stoppedAssistantRequestsRef = useRef(stoppedAssistantRequests);
  const assistantCancelBusyRef = useRef(false);
  const assistantCancelGatesRef = useRef<Record<string, Promise<void> | undefined>>({});
  const assistantTopicVersionsRef = useRef<Record<string, number>>({});
  const assistantTopicId = (pageId: string) =>
    assistantMessagesRef.current[pageId]
      ?.slice()
      .reverse()
      .find((message) => message.role === 'boundary')?.id;
  const setStoppedAssistantRequest = (
    pageId: string,
    stopped: StoppedAssistantRequest | undefined,
  ) => {
    stoppedAssistantRequestsRef.current = {
      ...stoppedAssistantRequestsRef.current,
      [pageId]: stopped,
    };
    setStoppedAssistantRequests(stoppedAssistantRequestsRef.current);
  };
  const clearAssistantRetryTopic = (pageId: string) => {
    assistantTopicVersionsRef.current[pageId] =
      (assistantTopicVersionsRef.current[pageId] ?? 0) + 1;
    setStoppedAssistantRequest(pageId, undefined);
  };
  const legacyAssistantRunsByPageRef = useRef<Record<string, readonly LegacyAssistantRun[]>>({});
  const [assistantContextByPage, setAssistantContextByPage] = useState<
    Record<string, { includeCurrentPage: boolean; mentionedPageIds: string[] }>
  >({});
  const [assistantContextError, setAssistantContextError] = useState<string>();
  const [assistantPickerIndex, setAssistantPickerIndex] = useState(0);
  const [assistantControlBusy, setAssistantControlBusy] = useState<
    'delete' | 'new-topic' | 'older'
  >();
  const [assistantDeleteConfirmation, setAssistantDeleteConfirmation] = useState(false);
  const [structureChangeConfirmation, setStructureChangeConfirmation] = useState<
    StructureChangeConfirmation | undefined
  >();
  const structureChangeConfirmationRef = useRef<StructureChangeConfirmation | undefined>(undefined);
  const [structureChangeBusy, setStructureChangeBusy] = useState(false);
  const [structureChangeError, setStructureChangeError] = useState<string | undefined>();
  const activePageIdRef = useRef(activePageId);
  activePageIdRef.current = activePageId;
  const onAssistantPageChangeRef = useRef(onAssistantPageChange);
  onAssistantPageChangeRef.current = onAssistantPageChange;
  const pendingAssistantChangeKey =
    activePageId !== undefined && pendingAssistantChanges[activePageId] !== undefined
      ? activePageId
      : pendingAssistantChanges[LEGACY_ASSISTANT_RECOVERY_KEY] !== undefined
        ? LEGACY_ASSISTANT_RECOVERY_KEY
        : undefined;
  const pendingAssistantChange =
    pendingAssistantChangeKey === undefined
      ? undefined
      : pendingAssistantChanges[pendingAssistantChangeKey];
  const assistantMessages =
    activePageId === undefined ? [] : (assistantMessagesByPage[activePageId] ?? [introMessage()]);
  // 结构化提问（WP7）：只有当前页对话的最后一条消息是 Decksmith 的提问时，问题才可作答；
  // 之后有任何教师消息、回复或新话题，旧问题只保留展示。
  const openAssistantClarificationEntry = openClarificationOf(assistantMessages);
  const openAssistantClarification = openAssistantClarificationEntry?.clarification;
  const openAssistantClarificationMessageId = openAssistantClarificationEntry?.messageId;
  // 画布点选（WP7 第二阶段）：最新未答问题要求选元素时，在候选所在页的画布上高亮候选，
  // 教师点中后确认"用这个"即作答。前往候选所在的其他页时保留会话，回到提问页发送。
  const clarificationPickSession = ((): ClarificationPickSession | undefined => {
    if (activePageId === undefined) return undefined;
    if (openAssistantClarification?.expect === 'select-element') {
      return dismissedClarificationPickIds.has(openAssistantClarification.questionId)
        ? undefined
        : { originPageId: activePageId, clarification: openAssistantClarification };
    }
    const crossPage = crossPageClarificationPick;
    if (
      crossPage === undefined ||
      crossPage.originPageId === activePageId ||
      dismissedClarificationPickIds.has(crossPage.questionId)
    ) {
      return undefined;
    }
    const origin = openClarificationOf(assistantMessagesByPage[crossPage.originPageId] ?? []);
    return origin?.clarification.questionId === crossPage.questionId &&
      origin.clarification.expect === 'select-element'
      ? { originPageId: crossPage.originPageId, clarification: origin.clarification }
      : undefined;
  })();
  const clarificationPickQuestionId = clarificationPickSession?.clarification.questionId;
  const clarificationPickCandidates = useMemo(
    () =>
      clarificationPickSession === undefined
        ? []
        : resolveClarificationCandidates(draft, clarificationPickSession.clarification.candidates),
    // 会话对象每次渲染重建；按问题本身与草稿重新判定候选现状。
    [draft, clarificationPickSession?.clarification],
  );
  const activeClarificationPickCandidates = clarificationPickCandidates.filter(
    (resolved) => resolved.candidate.pageId === activePageId,
  );
  const pendingClarificationCandidate =
    pendingClarificationPick === undefined ||
    pendingClarificationPick.questionId !== clarificationPickQuestionId ||
    pendingClarificationPick.pageId !== activePageId ||
    // 选区经其他途径（快捷键、删除、全选等）变化后，"用这个"不再指向画布上的选区。
    selectedElementIds.length !== 1 ||
    selectedElementIds[0] !== pendingClarificationPick.elementId
      ? undefined
      : activeClarificationPickCandidates.find(
          (resolved) =>
            resolved.state === 'available' &&
            resolved.candidate.elementId === pendingClarificationPick.elementId,
        );
  /** 画布点击是否命中当前页一个可作答的候选。 */
  const clarificationPickTarget = (elementId: string | undefined) =>
    elementId === undefined
      ? undefined
      : activeClarificationPickCandidates.find(
          (resolved) =>
            resolved.state === 'available' && resolved.candidate.elementId === elementId,
        );
  // 输入框发送的消息默认作为对未答问题的回复，教师可取消关联当作新请求发送。
  const linkedAssistantQuestionId =
    openAssistantClarification !== undefined &&
    activePageId !== undefined &&
    assistantReplyUnlinkedByPage[activePageId] !== openAssistantClarification.questionId
      ? openAssistantClarification.questionId
      : undefined;
  const legacyRecoveryMessages = assistantMessagesByPage[LEGACY_ASSISTANT_RECOVERY_KEY] ?? [];
  const legacyPendingAssistantChange = pendingAssistantChanges[LEGACY_ASSISTANT_RECOVERY_KEY];
  const legacyRecoveryMessage = legacyRecoveryMessages.find(
    (message) =>
      (legacyPendingAssistantChange !== undefined &&
        message.id === legacyPendingAssistantChange.messageId) ||
      (message.runtimeApprovalId !== undefined &&
        isApplyTerminalApproval(message.runtimeApprovalId)),
  );
  const canRetryStaleApprovedChange =
    pendingAssistantChange?.stale === true &&
    pendingAssistantChange.runtimeApprovalId !== undefined &&
    isApprovedApproval(pendingAssistantChange.runtimeApprovalId) &&
    pendingAssistantChange.document !== undefined &&
    onAssistantAppliedRetry !== undefined;
  const canRetryStaleApprovedLegacyChange =
    legacyPendingAssistantChange?.stale === true &&
    legacyPendingAssistantChange.runtimeApprovalId !== undefined &&
    isApprovedApproval(legacyPendingAssistantChange.runtimeApprovalId) &&
    legacyPendingAssistantChange.document !== undefined &&
    onAssistantAppliedRetry !== undefined;
  useEffect(() => {
    if (
      appliedApprovalIds.size === 0 &&
      resolvedApprovalIds.size === 0 &&
      supersededApprovalIds.size === 0 &&
      applyTerminalApprovalIds.size === 0
    )
      return;
    setAssistantMessagesByPage((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).map(([pageId, messages]) => [
          pageId,
          messages.map((message) => {
            const phase: AssistantMessage['approvalPhase'] = isSupersededApproval(
              message.runtimeApprovalId,
            )
              ? 'superseded'
              : isAppliedApproval(message.runtimeApprovalId)
                ? 'applied'
                : isApplyTerminalApproval(message.runtimeApprovalId)
                  ? 'apply-terminal'
                  : isResolvedApproval(message.runtimeApprovalId)
                    ? 'rejected'
                    : undefined;
            if (phase === undefined || message.approvalPhase === phase) return message;
            changed = true;
            return { ...message, approvalPhase: phase };
          }),
        ]),
      );
      return changed ? next : current;
    });
    setPendingAssistantChanges((current) => {
      const next = { ...current };
      for (const [pageId, pending] of Object.entries(current)) {
        if (
          isAppliedApproval(pending?.runtimeApprovalId) ||
          isResolvedApproval(pending?.runtimeApprovalId) ||
          isApplyTerminalApproval(pending?.runtimeApprovalId)
        ) {
          delete next[pageId];
        }
      }
      return next;
    });
  }, [appliedApprovalIds, applyTerminalApprovalIds, resolvedApprovalIds, supersededApprovalIds]);

  useEffect(() => {
    if (applyFailedApprovalIds.size === 0) return;
    setAssistantMessagesByPage((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).map(([pageId, messages]) => [
          pageId,
          messages.map((message) => {
            if (
              !isApplyFailedApproval(message.runtimeApprovalId) ||
              isApplyTerminalApproval(message.runtimeApprovalId)
            ) {
              return message;
            }
            changed = true;
            return { ...message, approvalPhase: 'apply-failed' as const };
          }),
        ]),
      );
      return changed ? next : current;
    });
  }, [applyFailedApprovalIds, applyTerminalApprovalIds]);
  // The active page's view of per-page Decksmith state.
  const assistantBusy = activePageId !== undefined && assistantBusyPageIds.has(activePageId);
  const assistantActivity =
    activePageId === undefined
      ? undefined
      : (assistantJobProgressByPage?.[activePageId] ?? assistantProgressByPage[activePageId]);
  const assistantProgress = assistantActivity?.text;
  const assistantJobActive =
    assistantJobPages === undefined
      ? assistantJobActiveProp
      : activePageId !== undefined && assistantJobPages.has(activePageId);
  const assistantProgressVisible =
    (assistantBusy || assistantJobActive) &&
    (assistantJobPages !== undefined ||
      assistantActivePageId === undefined ||
      assistantActivePageId === activePageId);
  const stoppedAssistantRequest =
    activePageId === undefined ? undefined : stoppedAssistantRequests[activePageId];
  const activeHostUserMessageId =
    activePageId === undefined ? undefined : assistantJobUserMessageIdsByPage?.[activePageId];
  const replacementAssistantJob =
    assistantJobActive &&
    activeHostUserMessageId !== undefined &&
    stoppedAssistantRequest !== undefined &&
    stoppedAssistantRequest.userMessageId !== activeHostUserMessageId;
  useEffect(() => {
    if (replacementAssistantJob && activePageId !== undefined)
      setStoppedAssistantRequest(activePageId, undefined);
  }, [replacementAssistantJob, activePageId]);
  const stoppedHistoryPrompt =
    activePageId === undefined || stoppedAssistantRequest?.userMessageId === undefined
      ? undefined
      : currentAssistantTopicMessages(assistantMessagesByPage[activePageId] ?? []).find(
          (message) =>
            message.role === 'user' && message.id === stoppedAssistantRequest.userMessageId,
        )?.text;
  const assistantStopped =
    !replacementAssistantJob &&
    stoppedAssistantRequest !== undefined &&
    activePageId !== undefined &&
    stoppedAssistantRequest.operationId === assistantOperationByPageRef.current[activePageId] &&
    (stoppedAssistantRequest.topicId === assistantTopicId(activePageId) ||
      (stoppedAssistantRequest.request === undefined && stoppedHistoryPrompt !== undefined));
  const stoppedRetryRequest =
    stoppedAssistantRequest?.request ??
    (activePageId === undefined || stoppedHistoryPrompt === undefined
      ? undefined
      : {
          pageId: activePageId,
          prompt: stoppedHistoryPrompt,
          includeCurrentPage: true,
          mentionedPageIds: [],
        });
  const assistantWaiting = useAssistantWaiting(
    activePageId,
    assistantProgressVisible,
    assistantActivity,
  );
  const setAssistantPageBusy = (pageId: string, busy: boolean) =>
    setAssistantBusyPageIds((current) => {
      if (current.has(pageId) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(pageId);
      else next.delete(pageId);
      return next;
    });
  const setAssistantPageProgress = (pageId: string, progress: string | undefined) =>
    // New tool actions may share the same label; each callback is still actual progress.
    setAssistantProgressByPage((current) => {
      if (progress !== undefined) {
        return { ...current, [pageId]: { text: progress, updatedAt: Date.now() } };
      }
      const next = { ...current };
      delete next[pageId];
      return next;
    });
  const assistantContext =
    activePageId === undefined
      ? { includeCurrentPage: true, mentionedPageIds: [] as string[] }
      : (assistantContextByPage[activePageId] ?? {
          includeCurrentPage: true,
          mentionedPageIds: [] as string[],
        });
  const updateAssistantMessages = (
    pageId: string,
    update: (current: AssistantMessage[]) => AssistantMessage[],
  ) => {
    setAssistantMessagesByPage((current) => ({
      ...current,
      [pageId]: update(current[pageId] ?? [introMessage()]),
    }));
  };
  const setPendingAssistantChange = (pageId: string, value: PendingAssistantChange | undefined) =>
    setPendingAssistantChanges((current) => ({ ...current, [pageId]: value }));
  const rememberLegacyAssistantRun = (pageId: string, legacy: LegacyAssistantRun) => {
    const current = legacyAssistantRunsByPageRef.current[pageId] ?? [];
    legacyAssistantRunsByPageRef.current = {
      ...legacyAssistantRunsByPageRef.current,
      [pageId]: [...current.filter((candidate) => candidate.runId !== legacy.runId), legacy].slice(
        -MAX_LEGACY_ASSISTANT_RUNS_PER_PAGE,
      ),
    };
  };
  const forgetLegacyAssistantRun = (pageId: string, runId: string | undefined) => {
    if (runId === undefined) return;
    const current = legacyAssistantRunsByPageRef.current[pageId];
    if (current === undefined || !current.some((candidate) => candidate.runId === runId)) return;
    legacyAssistantRunsByPageRef.current = {
      ...legacyAssistantRunsByPageRef.current,
      [pageId]: current.filter((candidate) => candidate.runId !== runId),
    };
  };

  const assistantPreviewMediaPlan = useMemo(() => {
    const candidate = pendingAssistantChange?.document;
    if (candidate === undefined || pendingAssistantChange?.stale === true) return undefined;
    const authoritativeMediaById = new Map(
      draft.resources.media.map((resource) => [resource.id, resource] as const),
    );
    const reusableUrls: Record<string, string> = {};
    const resourcesToResolve = candidate.resources.media.filter((resource) => {
      const authoritativeResource = authoritativeMediaById.get(resource.id);
      const authoritativeUrl = resolvedNativeResourceUrlsById[resource.id]?.trim();
      if (
        authoritativeResource?.objectKey === resource.objectKey &&
        authoritativeUrl !== undefined &&
        authoritativeUrl.length > 0
      ) {
        reusableUrls[resource.id] = authoritativeUrl;
        return false;
      }
      return true;
    });
    const resolutionKey = JSON.stringify(
      resourcesToResolve
        .map((resource) => [resource.id, resource.objectKey] as const)
        .sort(([leftId, leftKey], [rightId, rightKey]) =>
          leftId === rightId ? leftKey.localeCompare(rightKey) : leftId.localeCompare(rightId),
        ),
    );
    return { candidate, resolutionKey, resourcesToResolve, reusableUrls };
  }, [draft.resources.media, pendingAssistantChange, resolvedNativeResourceUrlsById]);
  const [assistantPreviewResolvedMedia, setAssistantPreviewResolvedMedia] = useState<{
    resolutionKey: string;
    urls: Readonly<Record<string, string>>;
  }>();
  const assistantPreviewMediaResolutionKey = assistantPreviewMediaPlan?.resolutionKey;

  useEffect(() => {
    // resolutionKey is the complete, sorted (resourceId, objectKey) identity. Depending on the
    // plan object itself would restart this effect whenever the host republishes an equal URL map.
    const plan = assistantPreviewMediaPlan;
    if (
      plan === undefined ||
      plan.resourcesToResolve.length === 0 ||
      resolveNativeResourceUrl === undefined
    ) {
      setAssistantPreviewResolvedMedia(undefined);
      return;
    }

    let cancelled = false;
    let nextAttemptTimer: number | undefined;
    const resolvedUrls: Record<string, string> = {};
    const resourceGroups = [
      ...plan.resourcesToResolve.reduce((groups, resource) => {
        const resourceIds = groups.get(resource.objectKey) ?? [];
        resourceIds.push(resource.id);
        groups.set(resource.objectKey, resourceIds);
        return groups;
      }, new Map<string, string[]>()),
    ].map(([objectKey, resourceIds]) => ({ objectKey, resourceIds }));

    const resolveResources = async (groups: typeof resourceGroups): Promise<void> => {
      const unresolved = (
        await Promise.all(
          groups.map(async (group) => {
            try {
              const url = (await resolveNativeResourceUrl(group.objectKey)).trim();
              if (url.length === 0) return group;
              for (const resourceId of group.resourceIds) resolvedUrls[resourceId] = url;
              return undefined;
            } catch {
              return group;
            }
          }),
        )
      ).filter((group): group is (typeof groups)[number] => group !== undefined);

      if (cancelled) return;
      if (unresolved.length === 0) {
        setAssistantPreviewResolvedMedia({
          resolutionKey: plan.resolutionKey,
          urls: { ...resolvedUrls },
        });
        nextAttemptTimer = window.setTimeout(() => {
          nextAttemptTimer = undefined;
          void resolveResources(resourceGroups);
        }, ASSISTANT_PREVIEW_MEDIA_REFRESH_MS);
        return;
      }
      nextAttemptTimer = window.setTimeout(() => {
        nextAttemptTimer = undefined;
        void resolveResources(unresolved);
      }, ASSISTANT_PREVIEW_MEDIA_RETRY_MS);
    };

    void resolveResources(resourceGroups);
    return () => {
      cancelled = true;
      if (nextAttemptTimer !== undefined) window.clearTimeout(nextAttemptTimer);
    };
  }, [assistantPreviewMediaResolutionKey, resolveNativeResourceUrl]);

  const assistantPreviewDocument = useMemo(() => {
    const plan = assistantPreviewMediaPlan;
    if (plan === undefined) return undefined;
    const resolvedUrls =
      plan.resourcesToResolve.length === 0
        ? EMPTY_NATIVE_RESOURCE_URLS
        : assistantPreviewResolvedMedia?.resolutionKey === plan.resolutionKey
          ? assistantPreviewResolvedMedia.urls
          : undefined;
    if (resolvedUrls === undefined) return undefined;
    const candidateResourceUrls = { ...plan.reusableUrls, ...resolvedUrls };
    if (
      !plan.candidate.resources.media.every(
        (resource) => (candidateResourceUrls[resource.id] ?? '').trim().length > 0,
      )
    ) {
      return undefined;
    }
    const candidate = plan.candidate;
    const candidatePageId = resolvePreviewPageId(draft.pages, candidate.pages, activePageId);
    return candidatePageId === undefined
      ? undefined
      : { document: candidate, pageId: candidatePageId, resourceUrls: candidateResourceUrls };
  }, [activePageId, assistantPreviewMediaPlan, assistantPreviewResolvedMedia, draft.pages]);

  useEffect(() => {
    if (assistantPreviewButton === null) return;
    return installPressHoldPreview({
      element: assistantPreviewButton,
      canPreview: () => assistantPreviewDocument !== undefined,
      onPreviewStart: () => setAssistantPreviewing(true),
      onPreviewEnd: () => setAssistantPreviewing(false),
    });
  }, [assistantPreviewButton, assistantPreviewDocument]);

  useEffect(() => {
    if (assistantPreviewDocument === undefined) setAssistantPreviewing(false);
  }, [assistantPreviewDocument]);

  useEffect(() => {
    if (document === lastEmittedDocumentRef.current) {
      lastEmittedDocumentRef.current = undefined;
      return;
    }
    const next = parseReachDeckDocument(document);
    const nextQuizQuestions = next.pages.flatMap((page) =>
      page.sceneType === 'quiz'
        ? page.scene.content.questions.map((question) => ({ pageId: page.pageId, question }))
        : [],
    );
    const reconciledSessions = new Map<string, QuizQuestionTypeSession>();
    for (const { pageId, question } of nextQuizQuestions) {
      const key = `${pageId}:${question.id}`;
      reconciledSessions.set(
        key,
        reconcileQuizQuestionTypeSession(
          quizQuestionTypeSessionsRef.current.get(key) ?? {},
          question,
        ),
      );
    }
    quizQuestionTypeSessionsRef.current = reconciledSessions;
    const previousDraft = draftRef.current;
    const previousServer = persistedBaselineRef.current;
    const rebasedHistory = rebaseReachDeckDocumentHistory(
      historyRef.current,
      previousServer,
      next,
      previousDraft,
    );
    const rebasedDraft = reachDeckValuesEqual(previousDraft, previousServer)
      ? { document: next, invalidated: false }
      : rebaseReachDeckDocumentDraft(previousDraft, previousServer, next);
    historyRef.current = rebasedHistory.history;
    persistedBaselineRef.current = next;
    draftRef.current = rebasedDraft.document;
    draftVersionRef.current += 1;
    setDraft(rebasedDraft.document);
    setHistoryVersion((version) => version + 1);
    if (rebasedHistory.invalidated || rebasedDraft.invalidated) {
      setSelectedElementId(undefined);
      setActionMessage(undefined);
    }
    if (interactiveComponentFocus !== undefined) {
      const previousFocusedPage = previousDraft.pages.find(
        (page) => page.pageId === interactiveComponentFocus.pageId,
      );
      const nextFocusedPage = rebasedDraft.document.pages.find(
        (page) => page.pageId === interactiveComponentFocus.pageId,
      );
      if (
        previousFocusedPage === undefined ||
        nextFocusedPage === undefined ||
        !reachDeckPageContentEqual(previousFocusedPage, nextFocusedPage)
      ) {
        clearInteractiveComponentFocus();
      }
    }
    const retainedActivePage = rebasedDraft.document.pages.some(
      (page) => page.pageId === activePageIdRef.current,
    );
    const nextActivePageId = retainedActivePage
      ? activePageIdRef.current
      : rebasedDraft.document.pages[0]?.pageId;
    setActivePageId(nextActivePageId);
    if (!retainedActivePage && nextActivePageId !== undefined) {
      setPageSelection({
        selectedPageIds: [nextActivePageId],
        selectionAnchorPageId: nextActivePageId,
        focusedPageId: nextActivePageId,
      });
    }
  }, [document]);

  useEffect(
    () => () => {
      quizQuestionTypeSessionsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    historyRef.current = closeReachDeckDocumentHistoryGroup(historyRef.current);
    setActiveQuizQuestionIndex(0);
  }, [activePageId]);

  useEffect(() => {
    for (const assistantRecovery of recoveries) {
      if (assistantRecoverySeenRef.current.has(assistantRecovery.id)) continue;
      assistantRecoverySeenRef.current.add(assistantRecovery.id);
      processAssistantRecovery(assistantRecovery);
    }
  }, [
    appliedApprovalIds,
    applyFailedApprovalIds,
    applyTerminalApprovalIds,
    recoveries,
    resolvedApprovalIds,
    onAssistantRecoveryResolve,
  ]);

  function processAssistantRecovery(assistantRecovery: ReachDeckEditorAssistantRecovery): void {
    if (
      assistantRecovery.response.runtimeApprovalId !== undefined &&
      (isAppliedApproval(assistantRecovery.response.runtimeApprovalId) ||
        isResolvedApproval(assistantRecovery.response.runtimeApprovalId))
    ) {
      onAssistantRecoveryResolve?.(assistantRecovery.id);
      return;
    }
    const messageId =
      assistantRecovery.response.historyRunId === undefined
        ? `recovery:${assistantRecovery.id}:assistant`
        : `${assistantRecovery.response.historyRunId}:assistant`;
    const recoveryPageId = assistantRecovery.pageId ?? LEGACY_ASSISTANT_RECOVERY_KEY;
    const legacyHistoryRunId =
      assistantRecovery.response.legacyHistoryRunId === assistantRecovery.response.historyRunId
        ? assistantRecovery.response.legacyHistoryRunId
        : undefined;
    if (legacyHistoryRunId !== undefined) {
      rememberLegacyAssistantRun(recoveryPageId, {
        assistantText: assistantRecovery.response.message,
        runId: legacyHistoryRunId,
      });
    }
    const rebaseByPages = assistantRecovery.changedPageIds !== undefined;
    const stale =
      assistantRecovery.state === 'stale' ||
      (!rebaseByPages &&
        assistantRecovery.baselineDocument !== undefined &&
        !editorValuesEqual(
          draftRef.current,
          parseReachDeckDocument(assistantRecovery.baselineDocument),
        ));
    const recoverablePartial =
      stale &&
      assistantRecovery.baselineDocument !== undefined &&
      assistantRecovery.response.document !== undefined &&
      isRecoverablePartialDecksmithCandidate(
        assistantRecovery.baselineDocument,
        assistantRecovery.response.document,
      );
    const recoveryApplyTerminal =
      assistantRecovery.response.runtimeApprovalId !== undefined &&
      isApplyTerminalApproval(assistantRecovery.response.runtimeApprovalId);
    updateAssistantMessages(recoveryPageId, (current) =>
      upsertAssistantMessage(current, {
        ...(assistantRecovery.response.changeSummary === undefined
          ? {}
          : { changeSummary: assistantRecovery.response.changeSummary }),
        id: messageId,
        role: 'assistant',
        ...(assistantRecovery.response.runtimeApprovalId === undefined
          ? {}
          : {
              approvalPhase: isApplyTerminalApproval(assistantRecovery.response.runtimeApprovalId)
                ? 'apply-terminal'
                : isApplyFailedApproval(assistantRecovery.response.runtimeApprovalId)
                  ? 'apply-failed'
                  : 'proposal',
              runtimeApprovalId: assistantRecovery.response.runtimeApprovalId,
            }),
        ...(assistantRecovery.response.outcome === undefined
          ? {}
          : { outcome: assistantRecovery.response.outcome }),
        text: assistantRecovery.response.message,
        ...(stale
          ? {
              suffixTranslation: localizedCopy(
                'reachDeck.editor.assistant.recoveryStaleSuffix',
                '（当前草稿已变更，恢复结果已过期，不能应用。）',
              ),
            }
          : {}),
      }),
    );
    if (!recoveryApplyTerminal && (stale || assistantRecovery.response.document !== undefined)) {
      setPendingAssistantChange(recoveryPageId, {
        document: assistantRecovery.response.document,
        baseVersion: draftVersionRef.current,
        messageId,
        ...(legacyHistoryRunId === undefined ? {} : { legacyHistoryRunId }),
        recoveryId: assistantRecovery.id,
        ...(assistantRecovery.response.runtimeApprovalId === undefined
          ? {}
          : { runtimeApprovalId: assistantRecovery.response.runtimeApprovalId }),
        // A ready recovery was checked against this baseline; keep it so the proposal can be
        // rebased after another proposal is applied first.
        ...(stale || assistantRecovery.baselineDocument === undefined
          ? {}
          : { baseDocument: assistantRecovery.baselineDocument }),
        ...(assistantRecovery.changedPageIds === undefined
          ? {}
          : {
              changedPageIds: assistantRecovery.changedPageIds,
              envelopeChanged: assistantRecovery.envelopeChanged === true,
              structural: assistantRecovery.structural === true,
            }),
        stale,
        recoverablePartial,
      });
    }
  }

  const lockedPages = useMemo(() => new Set(lockedPageIds ?? []), [lockedPageIds]);
  mediaInsertionStateRef.current = {
    busyAction,
    disabled,
    lockedPageIds: lockedPages,
    structureLocked,
    allowDeletingGeneratingPages,
  };
  const narrationRegeneratablePages = useMemo(
    () => new Set(narrationRegeneratablePageIds ?? []),
    [narrationRegeneratablePageIds],
  );
  const previewableLockedPages = useMemo(
    () => new Set(previewableLockedPageIds ?? []),
    [previewableLockedPageIds],
  );
  const isPageLocked = (pageId: string | undefined): boolean =>
    pageId !== undefined && lockedPages.has(pageId);
  const orderedPages = useMemo(
    () => [...draft.pages].sort((left, right) => left.order - right.order),
    [draft.pages],
  );
  const normalizedBatchStatusByPageId = useMemo(() => {
    const normalized: Record<string, readonly ReachDeckEditorBatchStatus[]> = {};
    for (const [pageId, status] of Object.entries(batchStatusByPageId ?? {})) {
      normalized[pageId] = Array.isArray(status) ? status : [status];
    }
    return normalized;
  }, [batchStatusByPageId]);
  const effectiveGenerationStatuses = useMemo(() => {
    const statuses = { ...generationStatusByPageId };
    for (const [pageId, status] of Object.entries(statuses)) {
      if (status?.affectedLanes?.length === 1 && status.affectedLanes[0] === 'image')
        delete statuses[pageId];
    }
    for (const [pageId, error] of Object.entries(retryLayoutErrors)) {
      if (
        error.status === JSON.stringify(generationStatusByPageId?.[pageId]) &&
        error.revision === draft.pages.find((page) => page.pageId === pageId)?.revision
      ) {
        statuses[pageId] = { phase: 'layout', state: 'failed', message: error.message };
      }
    }
    if (retryLayoutPageId !== undefined && statuses[retryLayoutPageId]?.state !== 'loading') {
      statuses[retryLayoutPageId] = {
        phase: 'layout',
        state: 'loading',
        activity: 'queued',
        message: text('reachDeck.editor.generation.submitting', '正在提交本页重新生成…'),
      };
    }
    return statuses;
  }, [draft.pages, generationStatusByPageId, retryLayoutErrors, retryLayoutPageId, translate]);
  const pageLaneStatusByPageId = useMemo(
    () =>
      Object.fromEntries(
        orderedPages.map((page) => [
          page.pageId,
          deriveReachDeckPageLaneStatuses({
            page,
            nativeSlide:
              draft.schemaVersion === 'reach-deck-document/v2'
                ? draft.nativeSlides.find((binding) => binding.pageId === page.pageId)?.slide
                : undefined,
            locked: lockedPages.has(page.pageId),
            generationStatus: effectiveGenerationStatuses[page.pageId],
            batchStatuses: normalizedBatchStatusByPageId[page.pageId],
            imageStatus: imageGeneratingPageIds?.includes(page.pageId)
              ? 'generating'
              : mediaSlotsByPageId?.[page.pageId]?.some((slot) => slot.status === 'failed')
                ? 'attention'
                : mediaSlotsByPageId?.[page.pageId]?.length
                  ? 'ready'
                  : undefined,
          }),
        ]),
      ),
    [
      draft,
      effectiveGenerationStatuses,
      lockedPages,
      normalizedBatchStatusByPageId,
      orderedPages,
      mediaSlotsByPageId,
      imageGeneratingPageIds,
    ],
  );
  const activePage = orderedPages.find((page) => page.pageId === activePageId) ?? orderedPages[0];
  useEffect(() => {
    const pageIds = orderedPages.map((page) => page.pageId);
    setPageSelection((current) => reducePageSelection(current, { type: 'reconcile' }, pageIds));
  }, [orderedPages]);
  const [suggestedActionBusyKey, setSuggestedActionBusyKey] = useState<string>();
  /**
   * Decksmith 只提供按钮，每个按钮调用编辑器自身重新生成入口背后的同一个宿主操作，
   * 并使用页面当前已保存的讲稿。宿主未提供操作或前置条件不满足时返回禁用原因，
   * 按钮保持可见但不可点，并通过 title 说明原因。
   */
  const describeSuggestedAction = (
    action: ReachDeckEditorAssistantSuggestedAction,
  ):
    | {
        Icon: typeof RefreshCw;
        label: string;
        run?: () => Promise<void> | void;
        unavailableReason?: string;
      }
    | undefined => {
    const pageIndex = orderedPages.findIndex((page) => page.pageId === action.pageId);
    const page = pageIndex < 0 ? undefined : orderedPages[pageIndex];
    const pageLabel = { page: pageIndex < 0 ? '?' : pageIndex + 1 };
    const interactive = page?.sceneType === 'interactive';
    const view = (Icon: typeof RefreshCw, label: string) => {
      const available = (run: (() => Promise<void> | void) | undefined) =>
        run === undefined
          ? {
              Icon,
              label,
              unavailableReason: text(
                'reachDeck.editor.assistant.suggestedAction.unsupported',
                '当前编辑器不支持此操作。',
              ),
            }
          : { Icon, label, run };
      const unavailable = (unavailableReason: string) => ({ Icon, label, unavailableReason });
      return { available, unavailable };
    };
    const descriptor = (() => {
      switch (action.kind) {
        case 'regenerate-page':
          return view(
            RefreshCw,
            text(
              'reachDeck.editor.assistant.suggestedAction.regeneratePage',
              '重新生成第 {page} 页',
              pageLabel,
            ),
          );
        case 'regenerate-page-narration':
          return view(
            WandSparkles,
            interactive
              ? text(
                  'reachDeck.editor.assistant.suggestedAction.regenerateInteractiveNarration',
                  '重新生成第 {page} 页讲稿和音频',
                  pageLabel,
                )
              : text(
                  'reachDeck.editor.assistant.suggestedAction.regenerateNarration',
                  '重新生成第 {page} 页讲稿、音频和动画',
                  pageLabel,
                ),
          );
        case 'regenerate-page-narration-text':
          return view(
            ScrollText,
            text(
              'reachDeck.editor.assistant.suggestedAction.regenerateNarrationText',
              '仅重新生成第 {page} 页讲稿',
              pageLabel,
            ),
          );
        case 'generate-page-audio':
          return view(
            AudioLines,
            text(
              'reachDeck.editor.assistant.suggestedAction.generateAudio',
              '生成第 {page} 页音频',
              pageLabel,
            ),
          );
        case 'regenerate-page-animations':
          return view(
            Sparkles,
            text(
              'reachDeck.editor.assistant.suggestedAction.regenerateAnimations',
              '重新生成第 {page} 页动画',
              pageLabel,
            ),
          );
        case 'regenerate-page-media':
          // Interactive 页没有讲稿驱动动画，该操作等同于用已保存讲稿重新生成音频。
          return view(
            interactive ? AudioLines : Clapperboard,
            interactive
              ? text(
                  'reachDeck.editor.assistant.suggestedAction.generateAudio',
                  '生成第 {page} 页音频',
                  pageLabel,
                )
              : text(
                  'reachDeck.editor.assistant.suggestedAction.regenerateMedia',
                  '重新生成第 {page} 页音频和动画',
                  pageLabel,
                ),
          );
        default:
          // 宿主可能传入未经解析的数据：未知动作不渲染按钮。
          return undefined;
      }
    })();
    if (descriptor === undefined) return undefined;
    if (page === undefined) {
      return descriptor.unavailable(
        text('reachDeck.editor.assistant.suggestedAction.pageMissing', '该页面已不存在。'),
      );
    }
    if (action.kind === 'regenerate-page') {
      return descriptor.available(
        onRegeneratePage === undefined ? undefined : () => onRegeneratePage(action.pageId),
      );
    }
    if (page.sceneType !== 'slide' && page.sceneType !== 'interactive') {
      return descriptor.unavailable(
        text('reachDeck.editor.narrationUnavailable', '当前页面没有可编辑的讲稿。'),
      );
    }
    if (
      interactive &&
      (action.kind === 'regenerate-page-narration-text' ||
        action.kind === 'regenerate-page-animations')
    ) {
      return descriptor.unavailable(
        text('reachDeck.editor.assistant.suggestedAction.slideOnly', '此操作仅适用于幻灯片页面。'),
      );
    }
    if (action.kind === 'regenerate-page-narration') {
      return descriptor.available(
        onRegeneratePageNarration === undefined
          ? undefined
          : () => onRegeneratePageNarration(action.pageId),
      );
    }
    if (action.kind === 'regenerate-page-narration-text') {
      // 与讲稿面板一致：失败/生成中的页只走完整重试。仅讲稿结果不带音频，原生通道不回写
      // 工作区状态，页面会一直停在失败/生成中。
      if (effectiveGenerationStatuses[action.pageId] !== undefined) {
        return descriptor.unavailable(
          text(
            'reachDeck.editor.assistant.suggestedAction.textOnlyUnsettled',
            '本页生成失败或仍在生成中，请改用“重新生成第 {page} 页讲稿、音频和动画”。',
            pageLabel,
          ),
        );
      }
      return descriptor.available(
        onRegeneratePageNarration === undefined
          ? undefined
          : () => onRegeneratePageNarration(action.pageId, { textOnly: true }),
      );
    }
    const narrationMissing = () =>
      descriptor.unavailable(
        text(
          'reachDeck.editor.assistant.suggestedAction.narrationMissing',
          '本页还没有已保存的讲稿，请先保存讲稿。',
        ),
      );
    if (page.sceneType === 'interactive') {
      const narrationText = page.scene.narration?.text;
      const narrationSpeechMarkup = page.scene.narration?.speechMarkup;
      if (onSaveInteractivePageNarrationAndGenerate === undefined) {
        return descriptor.available(undefined);
      }
      if (!narrationText) return narrationMissing();
      // 用已保存讲稿重新生成音频：语音标记必须原样带上，否则重新保存会丢掉标记。
      return descriptor.available(() =>
        onSaveInteractivePageNarrationAndGenerate({
          pageId: action.pageId,
          text: narrationText,
          ...(narrationSpeechMarkup === undefined ? {} : { speechMarkup: narrationSpeechMarkup }),
        }),
      );
    }
    const slide =
      draft.schemaVersion === 'reach-deck-document/v2'
        ? draft.nativeSlides.find((binding) => binding.pageId === action.pageId)?.slide
        : undefined;
    const operation =
      action.kind === 'generate-page-audio'
        ? onSavePageNarrationAudio
        : action.kind === 'regenerate-page-animations'
          ? onRegeneratePageAnimationsOnly
          : onRegeneratePageNarrationAnimations;
    if (operation === undefined) return descriptor.available(undefined);
    const narration = slide?.narration;
    const markdown = narration?.markdown;
    if (slide === undefined || !markdown) return narrationMissing();
    if (action.kind === 'regenerate-page-animations' && !hasReachDeckNarrationAudioTiming(slide)) {
      return descriptor.unavailable(
        text(
          'reachDeck.editor.narration.animationsOnlyUnavailable',
          '请先为已保存的讲稿生成音频，再重新生成动画。',
        ),
      );
    }
    return descriptor.available(() =>
      operation({
        pageId: action.pageId,
        markdown,
        ...(narration?.speechMarkup === undefined ? {} : { speechMarkup: narration.speechMarkup }),
      }),
    );
  };
  const activeGeometryInspection = useMemo<{
    inspection?: GeometryAuthoringInspection;
    invalid: boolean;
  }>(() => {
    if (activePage?.sceneType !== 'interactive') return { invalid: false };
    try {
      return {
        inspection: inspectGeometryAuthoring(activePage.scene.documentHtml),
        invalid: false,
      };
    } catch {
      return { invalid: true };
    }
  }, [activePage]);
  const activeGeometryInstances =
    activeGeometryInspection.inspection?.instances.filter((instance) => instance.editable) ?? [];
  const activeGeometryInstance =
    activeGeometryInstances.find(
      (instance) =>
        activePage !== undefined &&
        instance.instanceId === geometryInstanceIdByPageId[activePage.pageId],
    ) ?? activeGeometryInstances[0];
  const activeGeometryMode =
    activePage === undefined ? 'edit' : (geometryModeByPageId[activePage.pageId] ?? 'edit');
  const activeGeometrySelectedItem =
    activePage === undefined ? undefined : geometrySelectedItemByPageId[activePage.pageId];
  const activeGeometryProposal =
    activePage === undefined || activeGeometryInstance === undefined
      ? undefined
      : latestGeometryProposalByInstance[
          `${activePage.pageId}:${activeGeometryInstance.instanceId}`
        ];
  useEffect(() => {
    setLatestGeometryProposalByInstance((current) => {
      let changed = false;
      const next = { ...current };
      for (const [key, proposal] of Object.entries(current)) {
        if (proposal === undefined) continue;
        const page = draft.pages.find((candidate) => candidate.pageId === proposal.pageId);
        if (page?.sceneType !== 'interactive') {
          delete next[key];
          changed = true;
          continue;
        }
        try {
          const instance = inspectGeometryAuthoring(page.scene.documentHtml).instances.find(
            (candidate) => candidate.instanceId === proposal.instanceId,
          );
          if (
            instance === undefined ||
            proposal.sourceRevision !== page.revision ||
            proposal.fingerprint !== instance.fingerprint
          ) {
            delete next[key];
            changed = true;
          }
        } catch {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [draft.pages]);
  // 标题是导入时写死的(PPTX 导入产出 "Slide 1…N"),插页之后就与实际位置脱节。
  // 当前页 chip 必须报实时位置,否则教师看到的页码与页面导航轨道对不上。
  const activePageOrder =
    activePage === undefined
      ? undefined
      : orderedPages.findIndex((page) => page.pageId === activePage.pageId) + 1;
  const backgroundAssistantPages = useMemo(
    () => new Set(assistantBackgroundPageIds),
    [assistantBackgroundPageIds],
  );
  // Pages with a running Decksmith turn, and pages whose returned proposal awaits a decision.
  const runningAssistantPages = useMemo(
    () => new Set([...(assistantJobPageIds ?? []), ...assistantBusyPageIds]),
    [assistantBusyPageIds, assistantJobPageIds],
  );
  const pendingAssistantPages = useMemo(
    () =>
      new Set(
        Object.entries(pendingAssistantChanges)
          .filter(([, change]) => change !== undefined && change.stale !== true)
          .map(([pageId]) => pageId),
      ),
    [pendingAssistantChanges],
  );
  const activeTypographyTokens = typographyTokensForProfile(undefined);
  const activePageLocked =
    isPageLocked(activePage?.pageId) ||
    (activePage !== undefined &&
      effectiveGenerationStatuses[activePage.pageId]?.phase === 'layout' &&
      effectiveGenerationStatuses[activePage.pageId]?.state === 'loading');
  const activeGeometryEditingBlocked = disabled || busyAction !== undefined || activePageLocked;
  const activeNarrationRegeneratable =
    activePage !== undefined && narrationRegeneratablePages.has(activePage.pageId);
  const activeGenerationStatus =
    activePage === undefined ? undefined : effectiveGenerationStatuses[activePage.pageId];
  const localGenerationStatus =
    retryLayoutPageId === activePage?.pageId ||
    generationActionError === undefined ||
    generationActionError.pageId !== activePage?.pageId
      ? activeGenerationStatus
      : {
          ...activeGenerationStatus,
          phase: activeGenerationStatus?.phase ?? ('layout' as const),
          state: 'failed' as const,
          message: generationActionError.message,
          // The action's own error replaces the stored cause, so its advice no longer applies.
          hint: undefined,
        };
  const activeNarrationNeedsManualReview =
    localGenerationStatus?.phase === 'narration' &&
    localGenerationStatus.state === 'manual-review-required';
  const activeInteractiveNarration =
    activePage?.sceneType === 'interactive' ? activePage.scene.narration : undefined;
  const activeInteractiveNarrationSnapshot =
    activePage?.sceneType === 'interactive' &&
    interactiveNarrationSnapshot?.pageId === activePage.pageId
      ? interactiveNarrationSnapshot.draft
      : undefined;
  const activeInteractiveNarrationAudioSrc =
    activeInteractiveNarration?.audioResourceId === undefined
      ? undefined
      : resolvedNativeResourceUrlsById[activeInteractiveNarration.audioResourceId];
  const activeInteractiveNarrationModel = useMemo(
    () =>
      activePage?.sceneType !== 'interactive'
        ? undefined
        : deriveInteractiveNarrationViewModel({
            audioSrc: activeInteractiveNarrationAudioSrc,
            // 面板尚未上报（首帧）时按已保存讲稿推导，结果与未修改的草稿一致。
            draft: activeInteractiveNarrationSnapshot,
            draftText: activeInteractiveNarration?.text ?? '',
            generationStatus: localGenerationStatus,
            persistedNarration: activeInteractiveNarration,
          }),
    [
      activeInteractiveNarration,
      activeInteractiveNarrationAudioSrc,
      activeInteractiveNarrationSnapshot,
      activePage,
      localGenerationStatus,
    ],
  );
  const activeInteractiveNarrationLoading =
    localGenerationStatus?.phase === 'narration' && localGenerationStatus.state === 'loading';
  // 面板与状态条共用同一个编辑锁：音频排队/生成期间不接受新的保存。
  const activeInteractiveNarrationLocked =
    disabled || busyAction !== undefined || activePageLocked || activeInteractiveNarrationLoading;

  /** 状态条的保存/重试与讲稿面板主按钮走同一条路径，保存的就是面板当前显示的草稿。 */
  const saveActiveInteractiveNarration = async (): Promise<void> => {
    await interactiveNarrationActionsRef.current?.saveAndGenerate();
  };

  const activatePage = (pageId: string, preserveRailSelection = false): void => {
    // 结构改动等待二次确认时，紧随其后的「激活新页」指向尚不存在的页，忽略即可。
    if (!draftRef.current.pages.some((page) => page.pageId === pageId)) return;
    if (!preserveRailSelection) {
      setPageSelection({
        selectedPageIds: [pageId],
        selectionAnchorPageId: pageId,
        focusedPageId: pageId,
      });
    }
    if (pageId === activePageId) return;
    const previousPageId = activePageId;
    if (inlineTextSession !== undefined) finishInlineTextEditing();
    const apply = () => {
      setSelectedElementIds([]);
      setActivePageId(pageId);
      setSelectedElementId(undefined);
      clearInteractiveComponentFocus();
    };
    // Navigation is intentionally optimistic: a pending or failed host save must not strand the
    // teacher on one page. The host callback still starts/flushes its save, while its rejection is
    // observed here to avoid an unhandled Promise (the host owns the user-facing error state).
    apply();
    if (previousPageId === undefined || onBeforeActivePageChange === undefined) return;
    try {
      const pending = onBeforeActivePageChange(previousPageId, pageId);
      if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // A synchronous host failure is likewise surfaced by the host; navigation remains usable.
    }
  };

  const safelyActivatePage = (pageId: string): void => {
    if (pageId !== activePageId) finishInlineTextEditing();
    activatePage(pageId);
  };

  useEffect(() => {
    if (!mediaSlotFocusRequest) return;
    if (mediaSlotFocusRequest.revealHidden && mediaSlotFocusRequest.elementId) {
      const current = draftRef.current;
      const next = revealReachDeckNativeElement(
        current,
        mediaSlotFocusRequest.pageId,
        mediaSlotFocusRequest.elementId,
      );
      if (next !== current) commit(next);
    }
    safelyActivatePage(mediaSlotFocusRequest.pageId);
    setSelectedElementIds(mediaSlotFocusRequest.elementId ? [mediaSlotFocusRequest.elementId] : []);
    setSelectedElementIdState(mediaSlotFocusRequest.elementId);
    setRightPanelTab('properties');
  }, [mediaSlotFocusRequest]);

  useEffect(() => {
    if (!activePageLocked) return;
    setSelectedElementIdState(undefined);
    setSelectedElementIds([]);
    setInlineTextSession(undefined);
    setPlaying(false);
  }, [activePageLocked, activePage?.pageId]);
  useEffect(() => {
    if (
      !focusNarrationRegenerateRequested ||
      rightPanelCollapsed ||
      rightPanelTab !== 'narration'
    ) {
      return;
    }
    const regenerationMenu = narrationRegenerateButtonRef.current?.closest('details');
    if (regenerationMenu !== null && regenerationMenu !== undefined) regenerationMenu.open = true;
    (
      narrationRegenerateButtonRef.current ??
      rightPanelTabRefs.current[RIGHT_PANEL_TABS.indexOf('narration')]
    )?.focus();
    setFocusNarrationRegenerateRequested(false);
  }, [focusNarrationRegenerateRequested, rightPanelCollapsed, rightPanelTab]);
  /** 锁定原因：优先按页覆盖（如 narrating 页的"讲稿生成中"），再回落统一文案。 */
  const lockedReasonCopy = (pageId?: string) =>
    (pageId === undefined ? undefined : lockedPageReasonById?.[pageId]) ??
    lockedPageReason ??
    text('reachDeck.editor.pageLocked', '生成中');
  const activeNativeSlide =
    draft.schemaVersion === 'reach-deck-document/v2' && activePage !== undefined
      ? draft.nativeSlides.find((binding) => binding.pageId === activePage.pageId)?.slide
      : undefined;
  // Slide pages are native-only; the legacy element editor is intentionally unavailable.
  const selectedElement = undefined;
  const selectedTextElement = undefined;
  const selectedNativeElement = activeNativeSlide?.elements.find(
    (element) => element.id === selectedElementId,
  );
  const selectedAnimation = activeNativeSlide?.animations.find(
    (animation) => animation.id === selectedAnimationId,
  );
  // 原生文本与 v1 文本是同一种文本框：都用共享富文本 doc + 同一套编辑器。
  const selectedNativeTextFrame =
    selectedNativeElement !== undefined &&
    (selectedNativeElement.type === 'shape' || selectedNativeElement.type === 'textFrame')
      ? selectedNativeElement.text
      : undefined;

  useEffect(() => {
    setCurrentTime(0);
    setNarrationSeekRequest(undefined);
    setInlineTextSession(undefined);
    setSelectedElementIdState(undefined);
    setSelectedElementIds([]);
    setSelectedAnimationId(undefined);
  }, [activePage?.pageId]);

  // 演示只服务于当前页当前动画：切页、开始播放、改选其他动画或动画被删除都立即结束演示。
  const animationDemoStale =
    animationDemo !== undefined &&
    (animationDemo.pageId !== activePage?.pageId ||
      playing ||
      (selectedAnimationId !== undefined && selectedAnimationId !== animationDemo.animationId) ||
      !activeNativeSlide?.animations.some(
        (animation) => animation.id === animationDemo.animationId,
      ));
  useEffect(() => {
    if (animationDemoStale) stopAnimationDemo();
  }, [animationDemoStale]);
  useEffect(() => {
    if (animationDemo === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopAnimationDemo();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [animationDemo === undefined]);
  useEffect(
    () => () => {
      if (animationDemoFrameRef.current !== undefined)
        window.cancelAnimationFrame(animationDemoFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    if (activePage === undefined) return;
    setAssistantPrompt('');
    setAssistantContextError(undefined);
    setAssistantContextByPage((current) =>
      current[activePage.pageId] === undefined
        ? {
            ...current,
            [activePage.pageId]: { includeCurrentPage: true, mentionedPageIds: [] },
          }
        : current,
    );
    // Host callback replacement is not a page change: history/status updates must not
    // clear the teacher's in-progress message or start another history request.
    onAssistantPageChangeRef.current?.(activePage.pageId);
  }, [activePage?.pageId]);

  useEffect(() => {
    if (assistantHistory === undefined) return;
    const registeredLegacyRuns =
      legacyAssistantRunsByPageRef.current[assistantHistory.pageId] ?? [];
    const replacementByLegacyMessageId = new Map<string, string>();
    const replacedLegacyRunIds = new Set<string>();
    for (const legacy of registeredLegacyRuns) {
      const authoritativeRunId = authoritativeRunIdForLegacy(assistantHistory.entries, legacy);
      if (authoritativeRunId === undefined) continue;
      replacedLegacyRunIds.add(legacy.runId);
      replacementByLegacyMessageId.set(`${legacy.runId}:user`, `${authoritativeRunId}:user`);
      replacementByLegacyMessageId.set(
        `${legacy.runId}:assistant`,
        `${authoritativeRunId}:assistant`,
      );
    }
    const preservedLegacyRunIds = new Set(
      registeredLegacyRuns
        .filter((legacy) => !replacedLegacyRunIds.has(legacy.runId))
        .map((legacy) => legacy.runId),
    );
    if (replacedLegacyRunIds.size > 0) {
      legacyAssistantRunsByPageRef.current = {
        ...legacyAssistantRunsByPageRef.current,
        [assistantHistory.pageId]: registeredLegacyRuns.filter(
          (legacy) => !replacedLegacyRunIds.has(legacy.runId),
        ),
      };
      setPendingAssistantChanges((current) => {
        const pending = current[assistantHistory.pageId];
        if (pending === undefined) return current;
        const replacement = replacementByLegacyMessageId.get(pending.messageId);
        if (replacement === undefined) return current;
        const { legacyHistoryRunId: _legacyHistoryRunId, ...rest } = pending;
        return {
          ...current,
          [assistantHistory.pageId]: { ...rest, messageId: replacement },
        };
      });
    }
    const legacyMessageIdForCanonical = new Map(
      [...replacementByLegacyMessageId].map(([legacyId, canonicalId]) => [canonicalId, legacyId]),
    );
    setAssistantMessagesByPage((current) => {
      const existingById = new Map(
        (current[assistantHistory.pageId] ?? []).map((message) => [message.id, message]),
      );
      const hydrated = assistantHistory.entries.flatMap<AssistantMessage>((entry) => {
        let message: AssistantMessage;
        if (entry.kind === 'new-topic') {
          message = {
            id: entry.id,
            role: 'boundary',
            text: '',
            translation: localizedCopy(
              entry.messageKey,
              '新话题从这里开始',
              Object.fromEntries(
                Object.entries(entry.replacements).map(([key, value]) => [key, value]),
              ),
            ),
          };
        } else if (entry.kind === 'application-message') {
          const copy = safeCapacityApplicationCopy(entry);
          if (copy === undefined) return [];
          message = {
            id: entry.id,
            role: 'system',
            text: '',
            capacityState: entry.state,
            translation: localizedCopy(entry.messageKey, copy.fallback),
            ...((entry.state === 'needs_compaction' || entry.state === 'blocked') &&
            onAssistantNewTopic !== undefined
              ? { action: 'new-topic' as const }
              : {}),
            ...(entry.guidance === undefined
              ? {}
              : {
                  guidanceTranslation: localizedCopy(
                    entry.guidance.messageKey,
                    '开始新话题后，现有消息仍会保留，后续请求不会发送之前的历史。',
                  ),
                }),
          };
        } else {
          message = {
            id: entry.id,
            role: entry.role,
            text: entry.text,
            ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
          };
        }
        const existing =
          existingById.get(message.id) ??
          existingById.get(legacyMessageIdForCanonical.get(message.id) ?? '');
        if (existing === undefined || existing.role !== message.role) return [message];
        return [
          {
            ...message,
            ...(existing.approvalPhase === undefined
              ? {}
              : { approvalPhase: existing.approvalPhase }),
            ...(existing.changeSummary === undefined
              ? {}
              : { changeSummary: existing.changeSummary }),
            ...(existing.runtimeApprovalId === undefined
              ? {}
              : { runtimeApprovalId: existing.runtimeApprovalId }),
            ...(existing.outcome === undefined ? {} : { outcome: existing.outcome }),
            ...(existing.suffixTranslation === undefined
              ? {}
              : { suffixTranslation: existing.suffixTranslation }),
          },
        ];
      });
      const local = (current[assistantHistory.pageId] ?? []).filter((message) => {
        if (message.id === 'intro' || message.id.startsWith('local:')) return true;
        for (const runId of preservedLegacyRunIds) {
          if (message.id === `${runId}:user` || message.id === `${runId}:assistant`) return true;
        }
        return false;
      });
      const intro = local.find((message) => message.id === 'intro') ?? introMessage();
      const transient = local.filter((message) => message.id !== 'intro');
      const claimedHydratedUserIds = new Set<string>();
      const reconciledTransient = transient.filter((message) => {
        if (message.role !== 'user' || message.persistedUserMessageIdsAtCreation === undefined) {
          return true;
        }
        const existingAtCreation = new Set(message.persistedUserMessageIdsAtCreation);
        const canonical = hydrated.find(
          (candidate) =>
            candidate.role === 'user' &&
            candidate.text === message.text &&
            !existingAtCreation.has(candidate.id) &&
            !claimedHydratedUserIds.has(candidate.id),
        );
        if (canonical === undefined) return true;
        claimedHydratedUserIds.add(canonical.id);
        return false;
      });
      const byId = new Map(
        [...hydrated, ...reconciledTransient].map((message) => [message.id, message]),
      );
      return { ...current, [assistantHistory.pageId]: [intro, ...byId.values()] };
    });
  }, [assistantHistory, onAssistantNewTopic]);

  useEffect(() => {
    if (activePageId === undefined) return;
    const pageIds = new Set(draft.pages.map((page) => page.pageId));
    const mentioned = assistantContext.mentionedPageIds.filter((pageId) => pageIds.has(pageId));
    if (mentioned.length === assistantContext.mentionedPageIds.length) return;
    setAssistantContextByPage((current) => ({
      ...current,
      [activePageId]: { ...assistantContext, mentionedPageIds: mentioned },
    }));
    setAssistantContextError(
      text('reachDeck.editor.assistant.pageReferenceRemoved', '引用页面已删除，请重新选择。'),
    );
  }, [activePageId, assistantContext, draft.pages]);

  useEffect(() => {
    if (selectedAnimationId !== undefined && selectedAnimation === undefined) {
      setSelectedAnimationId(undefined);
    }
  }, [selectedAnimation, selectedAnimationId]);

  useEffect(() => {
    if (inlineTextSession === undefined) return;
    const commitOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-rich-text-inline]') !== null) return;
      if (richTextToolbarTarget?.contains(target)) return;
      finishInlineTextEditing();
    };
    window.addEventListener('pointerdown', commitOnOutsideClick);
    return () => window.removeEventListener('pointerdown', commitOnOutsideClick);
  }, [inlineTextSession, richTextToolbarTarget]);

  // 页面、画布和插入位置菜单：点击别处或按 Esc 关闭。
  useEffect(() => {
    if (pageMenu === undefined && insertionMenu === undefined && elementMenu === undefined) return;
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          '.reach-deck-editor__page-menu, .reach-deck-editor__insertion-menu, .reach-deck-editor__element-menu',
        ) !== null
      ) {
        return;
      }
      setPageMenu(undefined);
      setInsertionMenu(undefined);
      setElementMenu(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPageMenu(undefined);
        setInsertionMenu(undefined);
        setElementMenu(undefined);
      }
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [elementMenu, insertionMenu, pageMenu]);

  /**
   * 页级锁防线：锁定页内容或结构（页集合/顺序）在锁定期的变化一律丢弃，交互层本应已拦截。
   * 锁定页用内容深比较（相对当前草稿）判断，而非 revision——normalize 的 revision 是相对
   * 持久基线计算的，草稿与新提交可能各改一次却落在同一 revision 上。
   */
  const violatesPageLocks = (
    current: ReachDeckDocument,
    next: ReachDeckDocument,
    options?: { readonly adoption?: boolean; readonly structureConfirmed?: boolean },
  ): boolean => {
    // The host locks structure while a Decksmith proposal is pending or approved; landing that
    // proposal is the structural change the lock waits for, so an adoption is exempt (the runtime
    // still checks it against the approved transition). Pages under generation stay locked.
    // 生成期间只放行「纯删除」：插入、复制、排序仍会打乱正在生成的页序。
    const deletionAllowed =
      allowDeletingGeneratingPages && isPureReachDeckPageDeletion(current, next);
    if (structureLocked && options?.adoption !== true && !deletionAllowed) {
      if (pageIdSequenceOf(current) !== pageIdSequenceOf(next)) return true;
    }
    const pageIds = new Set([...current.pages, ...next.pages].map((page) => page.pageId));
    return [...pageIds].some((pageId) => {
      if (!lockedPages.has(pageId)) return false;
      const previous = current.pages.find((candidate) => candidate.pageId === pageId);
      const page = next.pages.find((candidate) => candidate.pageId === pageId);
      // 删除生成中的页须经二次确认（确认后宿主在保存里停止它的生成）。
      if (previous !== undefined && page === undefined && deletionAllowed) {
        return options?.structureConfirmed !== true;
      }
      if (previous === undefined || page === undefined) return true;
      if (!reachDeckPageContentEqual(previous, page)) return true;
      if (current.schemaVersion !== 'reach-deck-document/v2') return false;
      if (next.schemaVersion !== 'reach-deck-document/v2') return true;
      const previousBinding = current.nativeSlides.find((binding) => binding.pageId === pageId);
      const nextBinding = next.nativeSlides.find((binding) => binding.pageId === pageId);
      return !reachDeckValuesEqual(previousBinding, nextBinding);
    });
  };

  const currentHistorySnapshot = (): ReachDeckDocumentSnapshot => ({
    document: draftRef.current,
    activePageId: activePageIdRef.current,
    selectedElementId: selectedElementIdRef.current,
    selectedElementIds: [...selectedElementIdsRef.current],
    selectedAnimationId: selectedAnimationIdRef.current,
    pageSelection: {
      selectedPageIds: [...pageSelection.selectedPageIds],
      selectionAnchorPageId: pageSelection.selectionAnchorPageId,
      focusedPageId: pageSelection.focusedPageId,
    },
  });

  /**
   * 结构改动（增删、重排页面）是否要先经教师二次确认：会让未结清的 Decksmith 工作作废，或删掉
   * 仍在生成的页。commit 与撤销/重做共用这一判断，历史恢复不能绕过确认直接改草稿。
   * 采用提案自带结构、已确认的改动不再询问；返回需要确认的内容，不需要时返回 undefined。
   */
  const structureChangeRequirement = (
    valid: ReachDeckDocument,
    options?: Pick<EditorCommitOptions, 'adoption' | 'structureConfirmed'>,
  ): Pick<StructureChangeConfirmation, 'decksmith' | 'generatingPageIds'> | undefined => {
    if (options?.adoption === true || options?.structureConfirmed === true) return undefined;
    if (pageIdSequenceOf(draftRef.current) === pageIdSequenceOf(valid)) return undefined;
    const decksmith = decksmithHoldsStructure();
    const generatingPageIds = allowDeletingGeneratingPages
      ? draftRef.current.pages
          .map((page) => page.pageId)
          .filter(
            (pageId) =>
              !valid.pages.some((page) => page.pageId === pageId) &&
              (lockedPages.has(pageId) || generationInFlightPageIds?.includes(pageId) === true),
          )
      : [];
    return decksmith || generatingPageIds.length > 0 ? { decksmith, generatingPageIds } : undefined;
  };

  /** 登记一次待教师确认的结构改动；已有确认在等待时不覆盖它。 */
  const requestStructureChangeConfirmation = (request: StructureChangeConfirmation) => {
    // 正在提交采用/放弃决定：采用落地会带着提案自己的页面结构，此时改结构会被它覆盖。
    if (assistantDecisionBusyPageId !== undefined) {
      setActionMessage(
        localizedCopy(
          'reachDeck.editor.structureChange.decisionPending',
          '正在处理 Decksmith 的修改，请稍候再调整页面。',
        ),
      );
      return;
    }
    // 结构改动会让未结清的 Decksmith 工作作废：先二次确认，确认后再提交这次改动。
    if (structureChangeConfirmationRef.current === undefined) {
      structureChangeConfirmationRef.current = request;
      setStructureChangeConfirmation(request);
      setStructureChangeError(undefined);
    }
  };

  const commit = (next: ReachDeckDocument, options?: EditorCommitOptions) => {
    if (disabled) return;
    // 测验行内图片存在 page.scene 的富文本里，但授权它的 objectKey 要落在文档级媒体表上。
    // 在唯一的提交漏斗里补登记，保证两者进同一次 commit / 同一个 revision。
    const valid = normalizeReachDeckEditorMutation(
      persistedBaselineRef.current,
      ensureReachDeckRichTextMediaResources(next),
    );
    const confirmation = structureChangeRequirement(valid, options);
    if (confirmation !== undefined) {
      // 确认后仍会被页锁挡下的改动（例如生成期间插入页面）不必询问，也不该先作废 Decksmith 工作。
      if (violatesPageLocks(draftRef.current, valid, { structureConfirmed: true })) return;
      requestStructureChangeConfirmation({
        next,
        options,
        baseDraft: draftRef.current,
        ...confirmation,
      });
      return;
    }
    if (
      violatesPageLocks(draftRef.current, valid, {
        adoption: options?.adoption,
        structureConfirmed: options?.structureConfirmed,
      })
    )
      return;
    if (reachDeckValuesEqual(draftRef.current, valid)) return;
    if (interactiveComponentFocus !== undefined) {
      const previousFocusedPage = draftRef.current.pages.find(
        (page) => page.pageId === interactiveComponentFocus.pageId,
      );
      const nextFocusedPage = valid.pages.find(
        (page) => page.pageId === interactiveComponentFocus.pageId,
      );
      if (
        previousFocusedPage === undefined ||
        nextFocusedPage === undefined ||
        !reachDeckPageContentEqual(previousFocusedPage, nextFocusedPage)
      ) {
        clearInteractiveComponentFocus();
      }
    }
    historyRef.current = recordReachDeckDocumentEdit(
      historyRef.current,
      currentHistorySnapshot(),
      options?.historyGroup,
    );
    draftRef.current = valid;
    draftVersionRef.current += 1;
    localEditVersionRef.current += 1;
    lastEmittedDocumentRef.current = valid;
    setDraft(valid);
    setHistoryVersion((version) => version + 1);
    onChange?.(valid);
  };

  // 一键删除：整份课件一次提交、一步撤销；只读锁定页跳过，避免整次提交被页锁拒绝。
  mediaClearRef.current = (selection, options) => {
    if (options !== undefined) {
      // A successful direct media save must update history before the host releases its dialog.
      // Waiting for the server prop's effect leaves a window where Undo can restore old audio.
      const next = parseReachDeckDocument(options.savedDocument);
      const previous = persistedBaselineRef.current;
      const current = draftRef.current;
      historyRef.current = rebaseReachDeckDocumentHistory(
        historyRef.current,
        previous,
        next,
        current,
      ).history;
      const rebased = rebaseReachDeckDocumentDraft(current, previous, next).document;
      persistedBaselineRef.current = next;
      draftRef.current = rebased;
      draftVersionRef.current += 1;
      setDraft(rebased);
      setHistoryVersion((version) => version + 1);
    }
    if (disabled) return { document: draftRef.current, changedPageIds: [], skippedPageIds: [] };
    const result = clearReachDeckDocumentMedia(draftRef.current, selection, lockedPages);
    if (result.changedPageIds.length === 0) return result;
    stopAnimationDemo();
    setPlaying(false);
    commit(result.document);
    if (
      selectedAnimationIdRef.current !== undefined &&
      result.document.schemaVersion === 'reach-deck-document/v2' &&
      !result.document.nativeSlides.some((binding) =>
        binding.slide.animations.some(
          (animation) => animation.id === selectedAnimationIdRef.current,
        ),
      )
    )
      setSelectedAnimationId(undefined);
    return result;
  };

  const duplicateCanvasElements = (elementIds: readonly string[]) => {
    const pageId = activePageIdRef.current;
    if (
      pageId === undefined ||
      !canExecuteEditorCommand('duplicate', 'canvas', mediaInsertionStateRef.current, [pageId])
    )
      return;
    const fragment = copyReachDeckNativeElements(draftRef.current, pageId, elementIds);
    if (fragment === undefined) return;
    const result = pasteReachDeckNativeElements(draftRef.current, pageId, fragment, idFactory, 24);
    if (result.elementIds.length === 0) return;
    commit(result.document);
    setSelectedElementIds(result.elementIds);
    setSelectedElementIdState(result.elementIds.length === 1 ? result.elementIds[0] : undefined);
    setElementMenu(undefined);
  };

  const pasteCanvasFromMenu = async () => {
    const pageId = activePageIdRef.current;
    const target = previewRef.current;
    setElementMenu(undefined);
    if (pageId === undefined || target === null) return;
    try {
      const clipboard = navigator.clipboard;
      const values = new Map<string, string>();
      const files: File[] = [];
      if (clipboard?.read !== undefined) {
        for (const item of await clipboard.read()) {
          for (const type of item.types) {
            const blob = await item.getType(type);
            if (CLIPBOARD_IMAGE_EXTENSIONS[type.toLowerCase()] !== undefined) {
              files.push(new File([blob], 'clipboard-image', { type }));
            } else if (type.startsWith('text/') || type.startsWith('application/vnd.reachany.')) {
              values.set(type, await blob.text());
            }
          }
        }
      } else if (clipboard?.readText !== undefined) {
        values.set('text/plain', await clipboard.readText());
      } else {
        throw new Error('Clipboard read unavailable');
      }
      if (activePageIdRef.current !== pageId || !target.isConnected) return;
      const clipboardData = {
        getData: (type: string) => values.get(type) ?? '',
        types: [...values.keys()],
        files,
        items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      } as unknown as DataTransfer;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: clipboardData });
      activeReachDeckEditorInstance = editorInstanceRef.current;
      commandContextRef.current = 'canvas';
      target.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error('Clipboard content not accepted');
    } catch {
      setActionMessage(
        localizedCopy('reachDeck.editor.clipboardPasteFailed', '无法粘贴此 Deck 元素'),
      );
    }
  };

  const closeHistoryGroup = () => {
    historyRef.current = closeReachDeckDocumentHistoryGroup(historyRef.current);
  };

  const selectPageInRail = (pageId: string, mode: 'single' | 'range' | 'toggle' = 'single') => {
    const pageIds = orderedPages.map((page) => page.pageId);
    const next = reducePageSelection(pageSelection, { type: 'select', pageId, mode }, pageIds);
    setPageSelection(next);
    const nextActive = activePageAfterSelection(activePageIdRef.current, next, pageIds);
    if (nextActive !== undefined) activatePage(nextActive, true);
  };

  const updatePageMarquee = (next: PageMarquee | undefined) => {
    pageMarqueeRef.current = next;
    setPageMarquee(next);
  };

  const finishPageMarquee = (rail: HTMLElement, pointerId: number) => {
    const marquee = pageMarqueeRef.current;
    if (marquee === undefined || marquee.pointerId !== pointerId) return;
    updatePageMarquee(undefined);
    const left = Math.min(marquee.startX, marquee.currentX);
    const right = Math.max(marquee.startX, marquee.currentX);
    const top = Math.min(marquee.startY, marquee.currentY);
    const bottom = Math.max(marquee.startY, marquee.currentY);
    if (right - left < PAGE_MARQUEE_DRAG_THRESHOLD && bottom - top < PAGE_MARQUEE_DRAG_THRESHOLD) {
      if (!marquee.additive) {
        setPageSelection({
          selectedPageIds: [],
          selectionAnchorPageId: undefined,
          focusedPageId: undefined,
        });
      }
      return;
    }
    const intersectedPageIds = [...rail.querySelectorAll<HTMLElement>('[data-page-card]')]
      .filter((card) => {
        const bounds = card.getBoundingClientRect();
        return (
          bounds.left <= right &&
          bounds.right >= left &&
          bounds.top <= bottom &&
          bounds.bottom >= top
        );
      })
      .map((card) => card.dataset.pageId)
      .filter((pageId): pageId is string => pageId !== undefined);
    const pageIds = orderedPages.map((page) => page.pageId);
    const selectedPageIds = marquee.additive
      ? [...new Set([...marquee.selectedPageIdsAtStart, ...intersectedPageIds])]
      : intersectedPageIds;
    setPageSelection((current) =>
      reducePageSelection(current, { type: 'replace', pageIds: selectedPageIds }, pageIds),
    );
  };

  const deleteSelectedPages = (requestedPageIds = pageSelection.selectedPageIds): boolean => {
    const pageIds = orderedPages.map((page) => page.pageId);
    const selected = pageIds.filter((pageId) => requestedPageIds.includes(pageId));
    const lockedSelection =
      !allowDeletingGeneratingPages && selected.some((pageId) => lockedPages.has(pageId));
    if (
      selected.length === 0 ||
      !canExecuteEditorCommand('delete', 'pageRail', mediaInsertionStateRef.current, selected) ||
      lockedSelection
    ) {
      if (lockedSelection) setActionMessage(localizedCopy('reachDeck.editor.pageLocked', '生成中'));
      return false;
    }
    if (selected.length === pageIds.length) {
      setActionMessage(localizedCopy('reachDeck.editor.keepOnePage', '请至少保留一页'));
      return false;
    }
    let next = draftRef.current;
    for (const pageId of selected) {
      next = deleteReachDeckPage(next, pageId);
    }
    if (next === draftRef.current) return false;
    const remaining = [...next.pages].sort((left, right) => left.order - right.order);
    commit(next);
    const activePageStillExists = remaining.some((page) => page.pageId === activePageId);
    const focusIndex = Math.min(pageIds.indexOf(selected[0]!), remaining.length - 1);
    const focusId = activePageStillExists
      ? activePageId
      : remaining[Math.max(0, focusIndex)]?.pageId;
    if (focusId !== undefined) activatePage(focusId);
    return true;
  };

  const uploadAuthoringMedia = async (
    kind: Exclude<ReachDeckAuthoringMediaKind, 'attachment'>,
    file: File,
    offset = 0,
  ): Promise<void> => {
    const targetDocumentId = draftRef.current.id;
    const targetPageId = activePageIdRef.current;
    const targetPage = draftRef.current.pages.find((page) => page.pageId === targetPageId);
    const targetBinding =
      draftRef.current.schemaVersion === 'reach-deck-document/v2'
        ? draftRef.current.nativeSlides.find((binding) => binding.pageId === targetPageId)
        : undefined;
    if (
      onUploadAuthoringMedia === undefined ||
      targetPageId === undefined ||
      targetPage?.sceneType !== 'slide' ||
      targetBinding === undefined ||
      mediaInsertionStateRef.current.disabled ||
      mediaInsertionStateRef.current.busyAction !== undefined ||
      mediaInsertionStateRef.current.lockedPageIds.has(targetPageId) ||
      mediaInsertionStateRef.current.structureLocked ||
      mediaUploadAbortRef.current !== undefined
    ) {
      return;
    }

    const abortController = new AbortController();
    mediaUploadAbortRef.current = abortController;
    setMediaUploadError(undefined);
    setMediaUploadKind(kind);
    try {
      const uploaded = await onUploadAuthoringMedia({ file, kind, signal: abortController.signal });
      const currentState = mediaInsertionStateRef.current;
      const currentDocument = draftRef.current;
      const currentPage = currentDocument.pages.find((page) => page.pageId === targetPageId);
      const targetStillExists =
        currentDocument.schemaVersion === 'reach-deck-document/v2' &&
        currentDocument.nativeSlides.some((binding) => binding.pageId === targetPageId);
      if (
        abortController.signal.aborted ||
        currentDocument.id !== targetDocumentId ||
        activePageIdRef.current !== targetPageId ||
        currentPage?.sceneType !== 'slide' ||
        !targetStillExists ||
        currentState.disabled ||
        currentState.busyAction !== undefined ||
        currentState.lockedPageIds.has(targetPageId) ||
        currentState.structureLocked
      ) {
        if (!abortController.signal.aborted) {
          setMediaUploadError(
            text(
              'reachDeck.editor.media.targetChanged',
              '上传已完成，但目标页面已切换、删除或锁定，未插入媒体。',
            ),
          );
        }
        return;
      }
      const result = insertReachDeckAuthoringMedia(
        currentDocument,
        targetPageId,
        {
          kind,
          objectKey: uploaded.objectKey,
          contentType: uploaded.contentType,
          digest: uploaded.digest,
          title: file.name,
        },
        idFactory,
        offset,
      );
      if (result.elementId === undefined || result.resourceId === undefined) {
        throw new Error('Reach Deck authoring media target is unavailable.');
      }
      commit(result.document);
      setUploadedNativeResourceUrlsById((current) => ({
        ...current,
        [result.resourceId!]: uploaded.downloadUrl,
      }));
      setSelectedElementId(result.elementId);
      setRightPanelTab('properties');
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        setMediaUploadError(
          text('reachDeck.editor.media.uploadFailed', '媒体上传失败，请检查文件后重试。'),
        );
      }
    } finally {
      if (mediaUploadAbortRef.current === abortController) {
        mediaUploadAbortRef.current = undefined;
        setMediaUploadKind(undefined);
      }
    }
  };

  /**
   * 测验富文本的行内图片上传。
   *
   * 只回传稳定元数据：节点由富文本字段插入，媒体资源由 `commit` 补登记，两者同一次提交。
   * 目标在 await 期间失效（切页 / 删除 / 锁定）时返回 undefined，让字段给出「目标已切换」提示。
   */
  const uploadQuizInlineImage = async (
    file: File,
    signal: AbortSignal,
  ): Promise<RichTextUploadedImage | undefined> => {
    const targetDocumentId = draftRef.current.id;
    const targetPageId = activePageIdRef.current;
    const targetPage = draftRef.current.pages.find((page) => page.pageId === targetPageId);
    if (
      onUploadAuthoringMedia === undefined ||
      targetPageId === undefined ||
      targetPage?.sceneType !== 'quiz' ||
      mediaInsertionStateRef.current.disabled ||
      mediaInsertionStateRef.current.busyAction !== undefined ||
      mediaInsertionStateRef.current.lockedPageIds.has(targetPageId) ||
      mediaUploadAbortRef.current !== undefined
    ) {
      return undefined;
    }

    const abortController = new AbortController();
    const abortUpload = () => abortController.abort();
    signal.addEventListener('abort', abortUpload);
    mediaUploadAbortRef.current = abortController;
    setMediaUploadKind('image');
    try {
      const uploaded = await onUploadAuthoringMedia({
        file,
        kind: 'image',
        signal: abortController.signal,
      });
      const currentState = mediaInsertionStateRef.current;
      const currentPage = draftRef.current.pages.find((page) => page.pageId === targetPageId);
      if (
        abortController.signal.aborted ||
        draftRef.current.id !== targetDocumentId ||
        activePageIdRef.current !== targetPageId ||
        currentPage?.sceneType !== 'quiz' ||
        currentState.disabled ||
        currentState.busyAction !== undefined ||
        currentState.lockedPageIds.has(targetPageId)
      ) {
        return undefined;
      }
      if (!uploaded.contentType.trim().toLowerCase().startsWith('image/')) return undefined;
      // 派生资源 id 与 commit 的补登记同源，因此刚上传的图片在宿主媒体协调器
      // 同步到新文档之前就已经能显示。
      setUploadedNativeResourceUrlsById((current) => ({
        ...current,
        [buildReachDeckMediaResourceForObjectKey(uploaded.objectKey).id]: uploaded.downloadUrl,
      }));
      return {
        contentType: uploaded.contentType,
        name: file.name,
        objectKey: uploaded.objectKey,
        sizeBytes: file.size,
      };
    } finally {
      signal.removeEventListener('abort', abortUpload);
      if (mediaUploadAbortRef.current === abortController) {
        mediaUploadAbortRef.current = undefined;
        setMediaUploadKind(undefined);
      }
    }
  };

  const uploadQuizAttachment = async (file: File, signal: AbortSignal) => {
    const documentId = draftRef.current.id;
    const pageId = activePageIdRef.current;
    const page = draftRef.current.pages.find((candidate) => candidate.pageId === pageId);
    const questionId =
      page?.sceneType === 'quiz'
        ? page.scene.content.questions[
            Math.min(activeQuizQuestionIndex, page.scene.content.questions.length - 1)
          ]?.id
        : undefined;
    const state = mediaInsertionStateRef.current;
    if (
      !onUploadAuthoringMedia ||
      !pageId ||
      !questionId ||
      state.disabled ||
      state.busyAction !== undefined ||
      state.lockedPageIds.has(pageId) ||
      mediaUploadAbortRef.current ||
      signal.aborted
    )
      return undefined;
    const controller = new AbortController();
    const targetChangedMessage = () =>
      setActionMessage(
        text(
          'reachDeck.editor.quiz.uploadAttachmentTargetChanged',
          '题目已切换、删除或不可编辑，请回到原题后重新上传附件。',
        ),
      );
    const abort = () => {
      controller.abort();
      if (signal.reason !== QUIZ_ATTACHMENT_UPLOAD_CANCEL_REASON) targetChangedMessage();
    };
    signal.addEventListener('abort', abort);
    mediaUploadAbortRef.current = controller;
    setMediaUploadKind('attachment');
    try {
      const uploaded = await onUploadAuthoringMedia({
        file,
        kind: 'attachment',
        signal: controller.signal,
      });
      const latest = mediaInsertionStateRef.current;
      const latestPage = draftRef.current.pages.find((candidate) => candidate.pageId === pageId);
      if (
        controller.signal.aborted ||
        draftRef.current.id !== documentId ||
        activePageIdRef.current !== pageId ||
        latestPage?.sceneType !== 'quiz' ||
        !latestPage.scene.content.questions.some((question) => question.id === questionId) ||
        latest.disabled ||
        latest.busyAction !== undefined ||
        latest.lockedPageIds.has(pageId)
      ) {
        if (signal.reason !== QUIZ_ATTACHMENT_UPLOAD_CANCEL_REASON) targetChangedMessage();
        return undefined;
      }
      return {
        ...(uploaded.assetId ? { assetId: uploaded.assetId } : {}),
        contentType: uploaded.contentType,
        name: uploaded.name ?? file.name,
        objectKey: uploaded.objectKey,
        sizeBytes: uploaded.sizeBytes ?? file.size,
        order: 0,
      };
    } finally {
      signal.removeEventListener('abort', abort);
      if (mediaUploadAbortRef.current === controller) {
        mediaUploadAbortRef.current = undefined;
        setMediaUploadKind(undefined);
      }
    }
  };

  const applyHistorySnapshot = (
    snapshot: ReachDeckDocumentSnapshot,
    options?: { readonly structureConfirmed?: boolean },
  ): boolean => {
    const valid = normalizeReachDeckEditorMutation(persistedBaselineRef.current, snapshot.document);
    if (disabled) return false;
    // 需要二次确认的结构恢复只能经 restoreDocumentHistory 的确认入口进来。
    if (structureChangeRequirement(valid, options) !== undefined) return false;
    if (violatesPageLocks(draftRef.current, valid, options)) return false;
    draftRef.current = valid;
    draftVersionRef.current += 1;
    localEditVersionRef.current += 1;
    lastEmittedDocumentRef.current = valid;
    setDraft(valid);
    const restoredPageId = valid.pages.some((page) => page.pageId === snapshot.activePageId)
      ? snapshot.activePageId
      : valid.pages[0]?.pageId;
    setActivePageId(restoredPageId);
    setPageSelection(
      snapshot.pageSelection
        ? reconcilePageSelection(
            snapshot.pageSelection,
            valid.pages.map((page) => page.pageId),
          )
        : {
            selectedPageIds: restoredPageId === undefined ? [] : [restoredPageId],
            selectionAnchorPageId: restoredPageId,
            focusedPageId: restoredPageId,
          },
    );
    setSelectedElementIdState(snapshot.selectedElementId);
    setSelectedElementIds([...snapshot.selectedElementIds]);
    setSelectedAnimationId(snapshot.selectedAnimationId);
    restoringHistorySelectionRef.current = true;
    window.clearTimeout(restoringHistorySelectionTimerRef.current);
    restoringHistorySelectionTimerRef.current = window.setTimeout(() => {
      restoringHistorySelectionRef.current = false;
    }, 0);
    onChange?.(valid);
    return true;
  };

  useEffect(() => () => window.clearTimeout(restoringHistorySelectionTimerRef.current), []);

  /**
   * 撤销/重做。恢复出的草稿改了页面结构、又会作废未结清的 Decksmith 工作或删掉生成中的页时，
   * 与 commit 一样先走二次确认：取消确认时草稿与历史都不动，确认后再按同一方向恢复。
   * `expected` 是确认时预期恢复出的草稿，等待期间历史变了就放弃，由教师重新操作。
   */
  const restoreDocumentHistory = (
    direction: 'undo' | 'redo',
    confirmed?: { readonly expected: ReachDeckDocument },
  ) => {
    const result = (direction === 'undo' ? undoReachDeckDocumentEdit : redoReachDeckDocumentEdit)(
      historyRef.current,
      currentHistorySnapshot(),
    );
    if (result.snapshot === undefined || disabled || documentHistoryDisabled) return;
    const valid = normalizeReachDeckEditorMutation(
      persistedBaselineRef.current,
      result.snapshot.document,
    );
    if (confirmed !== undefined && !reachDeckValuesEqual(valid, confirmed.expected)) return;
    if (confirmed === undefined) {
      const confirmation = structureChangeRequirement(valid);
      if (confirmation !== undefined) {
        // 生成期间撤销删除会重新插入页面：页锁照样不放行，不必询问，也不作废 Decksmith 工作。
        if (violatesPageLocks(draftRef.current, valid, { structureConfirmed: true })) return;
        requestStructureChangeConfirmation({
          next: valid,
          options: undefined,
          baseDraft: draftRef.current,
          ...confirmation,
          history: direction,
        });
        return;
      }
    }
    if (
      !applyHistorySnapshot(
        result.snapshot,
        confirmed === undefined ? undefined : { structureConfirmed: true },
      )
    )
      return;
    historyRef.current = result.history;
    setHistoryVersion((version) => version + 1);
  };

  const undoDocument = () => restoreDocumentHistory('undo');

  const redoDocument = () => restoreDocumentHistory('redo');

  const nextClipboardPasteCount = (signature: string): number => {
    const sequence = clipboardPasteSequenceRef.current;
    if (sequence.signature !== signature) {
      clipboardPasteSequenceRef.current = { count: 1, signature };
      return 1;
    }
    sequence.count += 1;
    return sequence.count;
  };

  /**
   * Delete/Backspace：删除画布上选中的元素（多选一起删），或时间轴上选中的动画片段。
   * 文本内联编辑、任何输入控件/对话框获得焦点时不接管，交还给浏览器默认行为。
   * 返回是否真的删除了内容（决定是否 preventDefault，避免 Backspace 触发页面后退）。
   */
  const deleteSelectionShortcut = (): boolean => {
    if (
      disabled ||
      busyAction !== undefined ||
      inlineTextSession !== undefined ||
      activePage?.sceneType !== 'slide' ||
      activeNativeSlide === undefined ||
      activePageLocked ||
      deckEditorHasOpenDialog(editorRootRef.current)
    ) {
      return false;
    }
    if (commandContextRef.current !== 'canvas' && commandContextRef.current !== 'timeline')
      return false;
    if (
      !canExecuteEditorCommand(
        'delete',
        commandContextRef.current,
        mediaInsertionStateRef.current,
        [activePage.pageId],
      )
    )
      return false;
    if (commandContextRef.current === 'timeline' && selectedAnimation !== undefined) {
      commit(
        updateReachDeckNativeSlide(draftRef.current, activePage.pageId, (slide) => ({
          ...slide,
          animations: slide.animations.filter((animation) => animation.id !== selectedAnimation.id),
        })),
      );
      setSelectedAnimationId(undefined);
      return true;
    }
    if (commandContextRef.current !== 'canvas') return false;
    const elementIds =
      selectedElementIds.length > 0
        ? selectedElementIds
        : selectedElementId === undefined
          ? []
          : [selectedElementId];
    if (elementIds.length === 0) return false;
    const next = deleteReachDeckNativeElements(draftRef.current, activePage.pageId, elementIds);
    if (next === draftRef.current) return false;
    const focused = window.document.activeElement;
    if (focused instanceof HTMLElement && previewRef.current?.contains(focused)) {
      focused.blur();
    }
    commit(next);
    setSelectedElementId(undefined);
    return true;
  };

  const deleteCanvasElements = (elementIds: readonly string[]): boolean => {
    if (
      activePage?.sceneType !== 'slide' ||
      !canExecuteEditorCommand('delete', 'canvas', mediaInsertionStateRef.current, [
        activePage.pageId,
      ])
    )
      return false;
    const next = deleteReachDeckNativeElements(draftRef.current, activePage.pageId, elementIds);
    if (next === draftRef.current) return false;
    commit(next);
    setSelectedElementId(undefined);
    setElementMenu(undefined);
    return true;
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        activeReachDeckEditorInstance !== editorInstanceRef.current ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.repeat ||
        deckShortcutTargetIsEditable(event.target) ||
        deckShortcutTargetIsEditable(window.document.activeElement)
      )
        return;
      if (event.defaultPrevented) return;
      commandContextRef.current = resolveEditorCommandContext(
        event.target,
        commandContextRef.current,
      );
      if (!event.metaKey && !event.ctrlKey) {
        if (
          commandContextRef.current === 'pageRail' &&
          (event.key === 'Delete' || event.key === 'Backspace') &&
          deleteSelectedPages()
        ) {
          event.preventDefault();
          return;
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && deleteSelectionShortcut()) {
          event.preventDefault();
        }
        return;
      }
      const key = event.key.toLowerCase();
      const undo = key === 'z' && !event.shiftKey;
      const redo = (key === 'z' && event.shiftKey) || (event.ctrlKey && key === 'y');
      if (undo || redo) {
        event.preventDefault();
        if (undo) undoDocument();
        else redoDocument();
      }
    };
    const clipboardTargetIsOwnedByBrowser = (event: ClipboardEvent) =>
      resolveEditorCommandContext(event.target, commandContextRef.current) !== 'canvas' ||
      deckShortcutTargetIsEditable(event.target) ||
      deckShortcutTargetIsEditable(window.document.activeElement) ||
      deckEditorHasOpenDialog(editorRootRef.current);
    const onCopy = (event: ClipboardEvent) => {
      if (
        activeReachDeckEditorInstance !== editorInstanceRef.current ||
        compositionActiveRef.current ||
        clipboardTargetIsOwnedByBrowser(event) ||
        window.getSelection()?.isCollapsed === false ||
        event.clipboardData === null
      ) {
        return;
      }
      const current = draftRef.current;
      const pageId = activePageIdRef.current;
      const elementIds =
        selectedElementIdsRef.current.length > 0
          ? selectedElementIdsRef.current
          : selectedElementIdRef.current === undefined
            ? []
            : [selectedElementIdRef.current];
      if (pageId === undefined || elementIds.length === 0) return;
      const multiClipboard = copyReachDeckNativeElements(current, pageId, elementIds);
      if (multiClipboard === undefined) return;
      const serializedMulti = serializeReachDeckElementsClipboard(multiClipboard, current);
      if (serializedMulti === undefined) return;
      const plainText = reachDeckElementsClipboardPlainText(multiClipboard);
      if (elementIds.length === 1) {
        const singleClipboard = copyReachDeckNativeElement(current, pageId, elementIds[0]!);
        if (singleClipboard === undefined) return;
        const serialized = serializeReachDeckNativeElementClipboard(singleClipboard, current);
        if (serialized === undefined) return;
        try {
          event.clipboardData.setData(REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME, serialized);
          event.clipboardData.setData(
            `application/vnd.reachany.${ELEMENT_CLIPBOARD_VERSION}`,
            serializedMulti,
          );
        } catch {}
        const privatePayloadWritten =
          clipboardContainsType(event.clipboardData, REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME) ||
          clipboardContainsType(
            event.clipboardData,
            `application/vnd.reachany.${ELEMENT_CLIPBOARD_VERSION}`,
          );
        if (privatePayloadWritten) {
          try {
            event.clipboardData.setData(
              'text/html',
              reachDeckElementsClipboardHtml(serializedMulti, plainText),
            );
          } catch {}
        }
        if (plainText.length > 0) {
          try {
            event.clipboardData.setData('text/plain', plainText);
          } catch {}
        }
        const plainTextWritten = clipboardContainsType(event.clipboardData, 'text/plain');
        if (!privatePayloadWritten && !plainTextWritten) return;
        if (privatePayloadWritten) {
          clipboardPasteSequenceRef.current = { count: 0 };
          localClipboardCopyRef.current = { elements: serializedMulti, native: serialized, pageId };
        }
        event.preventDefault();
        return;
      }
      try {
        event.clipboardData.setData(
          `application/vnd.reachany.${ELEMENT_CLIPBOARD_VERSION}`,
          serializedMulti,
        );
        if (plainText.length > 0) event.clipboardData.setData('text/plain', plainText);
        event.clipboardData.setData(
          'text/html',
          reachDeckElementsClipboardHtml(serializedMulti, plainText),
        );
      } catch {}
      const privatePayloadWritten =
        clipboardContainsType(
          event.clipboardData,
          `application/vnd.reachany.${ELEMENT_CLIPBOARD_VERSION}`,
        ) || clipboardContainsType(event.clipboardData, REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME);
      if (!privatePayloadWritten && !clipboardContainsType(event.clipboardData, 'text/plain'))
        return;
      clipboardPasteSequenceRef.current = { count: 0 };
      if (privatePayloadWritten)
        localClipboardCopyRef.current = { elements: serializedMulti, pageId };
      event.preventDefault();
    };
    const onPaste = (event: ClipboardEvent) => {
      const state = mediaInsertionStateRef.current;
      if (
        activeReachDeckEditorInstance !== editorInstanceRef.current ||
        compositionActiveRef.current ||
        clipboardTargetIsOwnedByBrowser(event) ||
        event.clipboardData === null ||
        !canExecuteEditorCommand('paste', 'canvas', state, []) ||
        mediaUploadAbortRef.current !== undefined
      ) {
        return;
      }
      const current = draftRef.current;
      const pageId = activePageIdRef.current;
      const page = current.pages.find((candidate) => candidate.pageId === pageId);
      if (
        pageId === undefined ||
        page?.sceneType !== 'slide' ||
        state.lockedPageIds.has(pageId) ||
        current.schemaVersion !== 'reach-deck-document/v2' ||
        !current.nativeSlides.some((binding) => binding.pageId === pageId)
      ) {
        return;
      }

      const clipboardData = event.clipboardData;
      const elementsMime = `application/vnd.reachany.${ELEMENT_CLIPBOARD_VERSION}`;
      const elementsValue = readClipboardText(clipboardData, elementsMime);
      const htmlCarrier = readReachDeckElementsClipboardHtml(
        readClipboardText(clipboardData, 'text/html'),
      );
      const recognizedDeckFragment = elementsValue.length > 0 || htmlCarrier.recognized;
      const elementsPayload = parseReachDeckElementsClipboard(
        elementsValue || htmlCarrier.value || '',
        current,
      );
      if (elementsPayload !== undefined) {
        try {
          const pasteCount = nextClipboardPasteCount(
            JSON.stringify(['elements', elementsValue || htmlCarrier.value, current.id, pageId]),
          );
          const samePageLocalCopy =
            elementsPayload.documentId === current.id &&
            elementsPayload.pageId === pageId &&
            localClipboardCopyRef.current?.elements === (elementsValue || htmlCarrier.value) &&
            localClipboardCopyRef.current?.pageId === pageId;
          const result = pasteReachDeckNativeElements(
            current,
            pageId,
            elementsPayload,
            idFactory,
            24 * (pasteCount - (samePageLocalCopy ? 0 : 1)),
          );
          if (result.elementIds.length > 0) {
            event.preventDefault();
            commit(result.document);
            setSelectedElementIds(result.elementIds);
            setSelectedElementIdState(
              result.elementIds.length === 1 ? result.elementIds[0] : undefined,
            );
            return;
          }
        } catch {
          // Reject a malformed private fragment without changing the document.
        }
      }
      const nativeValue = readClipboardText(
        clipboardData,
        REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
      );
      if (nativeValue.length > 0) {
        try {
          const clipboard = parseReachDeckNativeElementClipboard(nativeValue, current);
          if (clipboard !== undefined) {
            const pasteCount = nextClipboardPasteCount(
              JSON.stringify(['native', nativeValue, current.id, pageId]),
            );
            const result = pasteReachDeckNativeElement(
              current,
              pageId,
              clipboard,
              idFactory,
              24 *
                (pasteCount -
                  (clipboard.documentId === current.id &&
                  localClipboardCopyRef.current?.native === nativeValue &&
                  localClipboardCopyRef.current?.pageId === pageId
                    ? 0
                    : 1)),
            );
            if (result.elementId !== undefined) {
              parseReachDeckDocument(result.document);
              event.preventDefault();
              commit(result.document);
              setSelectedElementId(result.elementId);
              return;
            }
          }
        } catch {
          // A stale or malformed private payload must not block current external clipboard formats.
        }
      }

      if (recognizedDeckFragment || nativeValue.length > 0) {
        event.preventDefault();
        setActionMessage(
          localizedCopy('reachDeck.editor.clipboardPasteFailed', '无法粘贴此 Deck 元素'),
        );
        return;
      }

      const clipboardImage = firstSupportedClipboardImage(
        clipboardData,
        CLIPBOARD_IMAGE_EXTENSIONS,
      );
      const html = readClipboardText(clipboardData, 'text/html');
      if (html.length > REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS) {
        if (clipboardImage === undefined) {
          event.preventDefault();
          return;
        }
      }
      if (html.length > 0 && html.length <= REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS) {
        try {
          const richText = richTextFromClipboardHtml(html);
          if (richTextHasRenderableContent(richText)) {
            const pasteCount = nextClipboardPasteCount(`html:${html}`);
            const result = insertReachDeckClipboardTextFrame(
              current,
              pageId,
              richText,
              idFactory,
              24 * (pasteCount - 1),
            );
            if (result.elementId !== undefined) {
              event.preventDefault();
              commit(result.document);
              setSelectedElementId(result.elementId);
              return;
            }
          }
        } catch {
          if (clipboardImage === undefined) {
            event.preventDefault();
            return;
          }
        }
      }

      if (clipboardImage !== undefined) {
        if (clipboardImage.size === 0 || clipboardImage.size > CLIPBOARD_IMAGE_MAX_BYTES) {
          event.preventDefault();
          return;
        }
        if (onUploadAuthoringMedia === undefined) return;
        const file = normalizeClipboardImageFile(clipboardImage, CLIPBOARD_IMAGE_EXTENSIONS);
        const pasteCount = nextClipboardPasteCount(
          `image:${clipboardImage.type.toLowerCase()}:${clipboardImage.size}`,
        );
        event.preventDefault();
        void uploadAuthoringMedia('image', file, 24 * (pasteCount - 1));
        return;
      }

      const plainText = readClipboardText(clipboardData, 'text/plain');
      let richText: RichTextDocument;
      try {
        richText = richTextFromClipboardPlainText(plainText);
      } catch {
        event.preventDefault();
        return;
      }
      if (plainText.trim().length === 0) return;
      const pasteCount = nextClipboardPasteCount(`plain:${plainText}`);
      const result = insertReachDeckClipboardTextFrame(
        current,
        pageId,
        richText,
        idFactory,
        24 * (pasteCount - 1),
      );
      if (result.elementId === undefined) return;
      event.preventDefault();
      commit(result.document);
      setSelectedElementId(result.elementId);
    };
    const onCut = (event: ClipboardEvent) => {
      if (
        activeReachDeckEditorInstance !== editorInstanceRef.current ||
        compositionActiveRef.current ||
        clipboardTargetIsOwnedByBrowser(event) ||
        window.getSelection()?.isCollapsed === false ||
        event.clipboardData === null
      )
        return;
      const current = draftRef.current;
      const pageId = activePageIdRef.current;
      const elementIds =
        selectedElementIdsRef.current.length > 0
          ? selectedElementIdsRef.current
          : selectedElementIdRef.current === undefined
            ? []
            : [selectedElementIdRef.current];
      if (
        pageId === undefined ||
        elementIds.length === 0 ||
        !canExecuteEditorCommand('cut', 'canvas', mediaInsertionStateRef.current, [pageId])
      )
        return;
      const fragment = copyReachDeckNativeElements(current, pageId, elementIds);
      if (fragment === undefined) return;
      const serialized = serializeReachDeckElementsClipboard(fragment, current);
      if (serialized === undefined) return;
      try {
        event.clipboardData.setData(
          `application/vnd.reachany.${ELEMENT_CLIPBOARD_VERSION}`,
          serialized,
        );
        event.clipboardData.setData('text/plain', reachDeckElementsClipboardPlainText(fragment));
        event.clipboardData.setData(
          'text/html',
          reachDeckElementsClipboardHtml(serialized, reachDeckElementsClipboardPlainText(fragment)),
        );
      } catch {}
      if (
        !clipboardContainsType(
          event.clipboardData,
          `application/vnd.reachany.${ELEMENT_CLIPBOARD_VERSION}`,
        )
      )
        return;
      event.preventDefault();
      clipboardPasteSequenceRef.current = { count: 0 };
      localClipboardCopyRef.current = undefined;
      deleteCanvasElements(elementIds);
    };
    const onCompositionStart = () => {
      compositionActiveRef.current = true;
    };
    const onCompositionEnd = () => {
      compositionActiveRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    window.addEventListener('compositionstart', onCompositionStart);
    window.addEventListener('compositionend', onCompositionEnd);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('compositionstart', onCompositionStart);
      window.removeEventListener('compositionend', onCompositionEnd);
    };
  });

  const updateActivePage = (
    update: (page: ReachDeckPublishedPage) => ReachDeckPublishedPage,
    options?: ReachDeckHistoryMetadata,
  ) => {
    if (activePage === undefined) return;
    commit(updateReachDeckPage(draftRef.current, activePage.pageId, update), options);
  };

  const reportGeometryAuthoringError = (pageId: string, error: unknown) => {
    const errorCopy =
      error instanceof GeometryAuthoringError
        ? {
            bad_marker: ['invalid', '几何标记无效，请使用 Decksmith 修复。'],
            duplicate_instance: ['invalid', '几何实例重复，请使用 Decksmith 修复。'],
            external_reference: ['invalid', '几何构造包含外部引用，请使用 Decksmith 修复。'],
            invalid_value: ['invalidValue', '几何设置超出允许范围，请调整后重试。'],
            invalid_proposal: ['invalidProposal', '几何试用状态无效，请重新操作后再试。'],
            invalid_snapshot: ['invalidSnapshot', '几何初始状态无效，请重新设置。'],
            not_found: ['notFound', '未找到要修改的几何对象，请重新选择。'],
            read_only: ['readOnlyError', '此几何对象不可直接编辑，请使用 Decksmith 修改。'],
            stale_fingerprint: ['stale', '几何构造已变化，请重新选择后再试。'],
            stale_revision: ['stale', '页面已变化，请重新选择后再试。'],
            unsupported_initial_value: [
              'unsupportedValue',
              '当前值不能设为初始状态，请检查参数范围和对象绑定。',
            ],
          }[error.code]
        : undefined;
    const message = text(
      `reachDeck.geometry.authoring.error.${errorCopy?.[0] ?? 'unknown'}`,
      errorCopy?.[1] ?? '几何修改未应用，请检查设置后重试。',
    );
    setGeometryAuthoringErrorByPageId((current) => ({ ...current, [pageId]: message }));
    setActionMessage(message);
  };

  const commitGeometryPage = (
    pageId: string,
    update: (page: InteractivePage) => InteractivePage,
  ): boolean => {
    const state = mediaInsertionStateRef.current;
    if (state.disabled || state.busyAction !== undefined || state.lockedPageIds.has(pageId)) {
      return false;
    }
    const current = draftRef.current.pages.find((page) => page.pageId === pageId);
    if (current?.sceneType !== 'interactive') return false;
    try {
      const nextPage = update(current);
      commit(updateReachDeckPage(draftRef.current, pageId, () => nextPage));
      setGeometryAuthoringErrorByPageId((errors) => {
        if (errors[pageId] === undefined) return errors;
        const next = { ...errors };
        delete next[pageId];
        return next;
      });
      return true;
    } catch (error) {
      reportGeometryAuthoringError(pageId, error);
      return false;
    }
  };

  const handleGeometryEditProposal = (proposal: GeometryAuthoringEditProposal) => {
    const state = mediaInsertionStateRef.current;
    if (
      state.disabled ||
      state.busyAction !== undefined ||
      state.lockedPageIds.has(proposal.pageId)
    ) {
      return;
    }
    const page = draftRef.current.pages.find((candidate) => candidate.pageId === proposal.pageId);
    if (
      page?.sceneType !== 'interactive' ||
      (geometryModeByPageId[proposal.pageId] ?? 'edit') !== 'edit'
    ) {
      return;
    }
    setLatestGeometryProposalByInstance((current) => ({
      ...current,
      [`${proposal.pageId}:${proposal.instanceId}`]: proposal,
    }));
    const selection = proposal.state.selection;
    const bindings = proposal.envelope.spec.authoring;
    if (typeof selection === 'string' && bindings !== undefined) {
      const category = (['objects', 'measurements', 'relations'] as const).find((candidate) =>
        bindings.editable[candidate].includes(selection),
      );
      if (category !== undefined) {
        setGeometrySelectedItemByPageId((current) => ({
          ...current,
          [proposal.pageId]: { category, id: selection },
        }));
      }
    }
    const auxiliary = proposal.state.auxiliary;
    const hasAuxiliary =
      auxiliary !== null &&
      typeof auxiliary === 'object' &&
      !Array.isArray(auxiliary) &&
      (['objects', 'measurements', 'relations', 'freedoms'] as const).some(
        (key) =>
          Array.isArray((auxiliary as Record<string, unknown>)[key]) &&
          ((auxiliary as Record<string, unknown>)[key] as unknown[]).length > 0,
      );
    // Input, selection, visibility and camera proposals remain local until the explicit initial-state action.
    if (!hasAuxiliary) return;
    commitGeometryPage(proposal.pageId, (current) =>
      applyGeometryEditProposal({ page: current, proposal }),
    );
  };

  const updateActiveGeometry = (
    update: (input: {
      page: InteractivePage;
      instanceId: string;
      expectedFingerprint: string;
    }) => InteractivePage,
  ) => {
    if (activePage?.sceneType !== 'interactive' || activeGeometryInstance === undefined) return;
    commitGeometryPage(activePage.pageId, (page) =>
      update({
        page,
        instanceId: activeGeometryInstance.instanceId,
        expectedFingerprint: activeGeometryInstance.fingerprint,
      }),
    );
  };

  const addPage = (
    sceneType: ReachDeckSceneType,
    target: ReachDeckPageInsertionTarget = activePage === undefined
      ? { mode: 'before-first' }
      : { mode: 'insert-after', afterPageId: activePage.pageId },
  ) => {
    const current = draftRef.current;
    let next: ReachDeckDocument;
    try {
      next = addReachDeckPage(current, {
        sceneType,
        target,
        idFactory,
        locale,
        translate,
      });
    } catch {
      setActionMessage(
        localizedCopy('reachDeck.editor.insertionFailed', '插入页面失败，请重新选择位置后再试。'),
      );
      return;
    }
    const added = [...next.pages]
      .sort((left, right) => left.order - right.order)
      .find((page) => !current.pages.some((item) => item.pageId === page.pageId));
    commit(next);
    if (added) {
      activatePage(added.pageId);
    }
  };

  const openInsertionMenu = (
    target: ReachDeckPageInsertionTarget,
    clientX: number,
    clientY: number,
  ) => {
    setDraggingPageIds([]);
    setDragOverPageId(undefined);
    const maxX = Math.max(
      PAGE_MENU_VIEWPORT_GAP,
      window.innerWidth - PAGE_MENU_WIDTH - PAGE_MENU_VIEWPORT_GAP,
    );
    const x = Math.max(PAGE_MENU_VIEWPORT_GAP, Math.min(clientX, maxX));
    setPageMenu(undefined);
    setInsertionMenu({
      target,
      submenuSide:
        x + PAGE_MENU_WIDTH + 4 + PAGE_SUBMENU_WIDTH + PAGE_MENU_VIEWPORT_GAP <= window.innerWidth
          ? 'right'
          : x - PAGE_SUBMENU_WIDTH - 4 >= PAGE_MENU_VIEWPORT_GAP
            ? 'left'
            : 'below',
      x,
      y: clientY,
    });
  };

  const duplicatePage = (pageId: string) => {
    const selectedPageIds = pageSelection.selectedPageIds.includes(pageId)
      ? orderedPages
          .filter((page) => pageSelection.selectedPageIds.includes(page.pageId))
          .map((page) => page.pageId)
      : [pageId];
    if (
      !canExecuteEditorCommand(
        'duplicate',
        'pageRail',
        mediaInsertionStateRef.current,
        selectedPageIds,
      )
    )
      return;
    const current = draftRef.current;
    let next = current;
    const addedPageIds: string[] = [];
    for (const sourcePageId of selectedPageIds) {
      const existingPageIds = new Set(next.pages.map((page) => page.pageId));
      next = duplicateReachDeckPage(next, sourcePageId, idFactory, translate);
      const added = next.pages.find((candidate) => !existingPageIds.has(candidate.pageId));
      if (added !== undefined) addedPageIds.push(added.pageId);
    }
    const lastSourcePageId = selectedPageIds.at(-1);
    if (addedPageIds.length > 1 && lastSourcePageId !== undefined) {
      const afterLastSource = next.pages.findIndex((page) => page.pageId === lastSourcePageId) + 1;
      next = reorderReachDeckPages(next, addedPageIds, afterLastSource);
    }
    commit(next);
    if (addedPageIds.length > 0) {
      activatePage(addedPageIds[0]);
      setPageSelection({
        selectedPageIds: addedPageIds,
        selectionAnchorPageId: addedPageIds[0],
        focusedPageId: addedPageIds.at(-1),
      });
    }
  };

  const updateSelectedElement = (update: (element: DeckElement) => DeckElement) => {
    if (activePage?.sceneType !== 'slide' || selectedElement === undefined) return;
    // Legacy slide scene editing is intentionally unavailable in native-only v2.
    void update;
  };

  const updateSelectedNativeElement = (
    update: (element: ReachDeckNativeElementV2) => ReachDeckNativeElementV2,
    options?: { historyGroup?: string },
  ) => {
    if (activePage === undefined || selectedNativeElement === undefined) return;
    commit(
      updateReachDeckNativeSlide(draftRef.current, activePage.pageId, (slide) => ({
        ...slide,
        elements: slide.elements.map((element) =>
          element.id === selectedNativeElement.id ? update(element) : element,
        ),
      })),
      options,
    );
  };

  const stopAnimationDemo = () => {
    if (animationDemoFrameRef.current !== undefined)
      window.cancelAnimationFrame(animationDemoFrameRef.current);
    animationDemoFrameRef.current = undefined;
    setAnimationDemo(undefined);
  };

  /**
   * 在画布上演示一条动画：前置 0.3 秒展示起始态，播完后停留 0.6 秒再回到编辑画面。
   * 演示副本把开始时间平移到前置点、去掉延迟，不写回文档；系统要求减少动态效果时不演示。
   */
  const startAnimationDemo = (animation: ReachDeckAnimationV2) => {
    if (activePage === undefined) return;
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    stopAnimationDemo();
    setPlaying(false);
    const lead = 0.3;
    const total = lead + Math.max(animation.duration, 0.2) + 0.6;
    const demo = {
      pageId: activePage.pageId,
      animationId: animation.id,
      animation: { ...animation, start: lead, delay: 0 },
    };
    const startedAt = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      if (elapsed >= total) {
        animationDemoFrameRef.current = undefined;
        setAnimationDemo(undefined);
        return;
      }
      setAnimationDemo({ ...demo, time: elapsed });
      animationDemoFrameRef.current = window.requestAnimationFrame(tick);
    };
    setAnimationDemo({ ...demo, time: 0 });
    animationDemoFrameRef.current = window.requestAnimationFrame(tick);
  };

  /** 应用动画补丁并返回更新后的动画（供演示使用）；无法应用时返回 undefined。 */
  const updateSelectedAnimation = (
    patch: Partial<ReachDeckAnimationV2>,
  ): ReachDeckAnimationV2 | undefined => {
    if (activePage === undefined || selectedAnimation === undefined) return undefined;
    const target = activeNativeSlide?.elements.find(
      (element) => element.id === selectedAnimation.targetId,
    );
    const nextPatch =
      patch.effect !== undefined && patch.effect !== selectedAnimation.effect
        ? {
            ...patch,
            ...defaultTweenForEffect(patch.effect, entrancePresetKind(target?.type ?? 'shape')),
          }
        : patch;
    const normalizedPatch =
      patch.effect !== undefined && ['appear', 'disappear'].includes(patch.effect)
        ? { ...nextPatch, from: undefined, to: undefined }
        : nextPatch;
    commit(
      updateReachDeckNativeSlide(draftRef.current, activePage.pageId, (slide) => {
        const animations = slide.animations.map((animation) =>
          animation.id === selectedAnimation.id ? { ...animation, ...normalizedPatch } : animation,
        );
        // 孤儿动画播放时忽略，不能撑长页时长。
        const contentDuration = timelineContentDuration(
          narrationDisplayWindows(slide.narration?.segments ?? []),
          reachDeckPlayableAnimations({ ...slide, animations }),
        );
        return {
          ...slide,
          animations,
          duration: Math.max(slide.duration ?? 0, contentDuration),
        };
      }),
    );
    return { ...selectedAnimation, ...normalizedPatch };
  };

  const runGeneratePage = () => {
    if (disabled || onGeneratePage === undefined || activePage === undefined) return;
    const operationId = ++operationIdRef.current;
    const startVersion = draftVersionRef.current;
    const snapshot = draftRef.current;
    setBusyAction('generate');
    setActionMessage(undefined);
    Promise.resolve(onGeneratePage({ document: snapshot, pageId: activePage.pageId }))
      .then((next) => {
        if (operationId !== operationIdRef.current) return;
        if (draftVersionRef.current !== startVersion) {
          if (next && editorValuesEqual(draftRef.current, parseReachDeckDocument(next))) {
            setActionMessage(localizedCopy('reachDeck.editor.generation.complete', '页面生成完成'));
            return;
          }
          setActionMessage(
            localizedCopy('reachDeck.editor.generation.stale', '草稿已更改，未应用过期的生成结果'),
          );
          return;
        }
        if (next) {
          commit(next);
          setActionMessage(localizedCopy('reachDeck.editor.generation.complete', '页面生成完成'));
        } else {
          setActionMessage(
            localizedCopy('reachDeck.editor.generation.cancelled', '已取消页面生成'),
          );
        }
      })
      .catch((error: unknown) => {
        if (operationId === operationIdRef.current) {
          setActionMessage(
            error instanceof Error
              ? error.message
              : localizedCopy('reachDeck.editor.generation.failed', '页面生成失败'),
          );
        }
      })
      .finally(() => {
        if (operationId === operationIdRef.current) setBusyAction(undefined);
      });
  };

  const retryLayoutGeneration = async () => {
    if (
      onRegeneratePage === undefined ||
      activePage === undefined ||
      busyAction !== undefined ||
      retryLayoutInFlightRef.current !== undefined ||
      (effectiveGenerationStatuses[activePage.pageId]?.phase === 'layout' &&
        effectiveGenerationStatuses[activePage.pageId]?.state === 'loading')
    )
      return;
    const pageId = activePage.pageId;
    const documentId = document.id;
    const operation = ++retryLayoutOperationRef.current;
    retryLayoutInFlightRef.current = pageId;
    setRetryLayoutPageId(pageId);
    setRetryLayoutErrors((current) => {
      const next = { ...current };
      delete next[pageId];
      return next;
    });
    setBusyAction('retry-layout');
    try {
      await onRegeneratePage(pageId);
    } catch {
      if (
        retryLayoutDocumentIdRef.current !== documentId ||
        retryLayoutOperationRef.current !== operation
      )
        return;
      setRetryLayoutErrors((current) => ({
        ...current,
        [pageId]: {
          message: text(
            'reachDeck.editor.generation.submissionUnknown',
            '重新生成的响应中断，请先刷新确认任务是否已受理，再决定是否重试。',
          ),
          status: JSON.stringify(retryLayoutStatusRef.current?.[pageId]),
          revision: activePage.revision,
        },
      }));
    } finally {
      if (
        retryLayoutDocumentIdRef.current === documentId &&
        retryLayoutOperationRef.current === operation
      ) {
        retryLayoutInFlightRef.current = undefined;
        setRetryLayoutPageId(undefined);
        setBusyAction(undefined);
      }
    }
  };

  function finishInlineTextEditing() {
    const session = inlineTextSession;
    if (session === undefined) return;
    if (session.native) {
      if (activePage !== undefined) {
        const draftHasRenderableContent = richTextHasRenderableContent(session.draft);
        if (session.createdFromBlankCanvas === true && !draftHasRenderableContent) {
          const reverted = undoReachDeckDocumentEdit(historyRef.current, currentHistorySnapshot());
          if (reverted.snapshot !== undefined && applyHistorySnapshot(reverted.snapshot)) {
            historyRef.current = { ...reverted.history, future: [] };
            setHistoryVersion((version) => version + 1);
          } else {
            commit(
              updateReachDeckNativeSlide(draftRef.current, activePage.pageId, (slide) => ({
                ...slide,
                elements: slide.elements.filter((element) => element.id !== session.elementId),
                animations: slide.animations.filter(
                  (animation) => animation.targetId !== session.elementId,
                ),
              })),
            );
          }
          setSelectedElementId(undefined);
        } else {
          const nextTextDocument =
            draftHasRenderableContent && !richTextHasRenderableContent(session.original)
              ? applyReachDeckBodyTypographyDefaults(draftRef.current, session.draft)
              : session.draft;
          commit(
            updateReachDeckNativeSlide(draftRef.current, activePage.pageId, (slide) => ({
              ...slide,
              elements: slide.elements.map((element) =>
                element.id === session.elementId &&
                element.type === 'table' &&
                session.cellId !== undefined
                  ? {
                      ...element,
                      rows: element.rows.map((row) => ({
                        ...row,
                        cells: row.cells.map((cell) =>
                          cell.id === session.cellId
                            ? { ...cell, text: { ...cell.text, doc: nextTextDocument } }
                            : cell,
                        ),
                      })),
                    }
                  : element.id === session.elementId &&
                      (element.type === 'shape' || element.type === 'textFrame') &&
                      element.text !== undefined
                    ? { ...element, text: { ...element.text, doc: nextTextDocument } }
                    : element,
              ),
            })),
          );
        }
      }
      setInlineTextSession(undefined);
      return;
    }
    // A non-native inline session can only come from an incompatible legacy
    // document; close it without mutating the native-only draft.
    setInlineTextSession(undefined);
  }

  const mentionMatch = /(?:^|\s)@([^@\s]*)$/u.exec(assistantPrompt);
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase(locale);
  const mentionCandidates =
    mentionMatch === null
      ? []
      : orderedPages.filter(
          (page) =>
            page.pageId !== activePage?.pageId &&
            !assistantContext.mentionedPageIds.includes(page.pageId) &&
            (mentionQuery === '' ||
              page.title.toLocaleLowerCase(locale).includes(mentionQuery ?? '')),
        );
  const selectMentionPage = (pageId: string) => {
    if (activePage === undefined || !orderedPages.some((page) => page.pageId === pageId)) {
      setAssistantContextError(
        text('reachDeck.editor.assistant.pageReferenceMissing', '引用页面不存在，请重新选择。'),
      );
      return;
    }
    setAssistantContextByPage((current) => ({
      ...current,
      [activePage.pageId]: {
        ...(current[activePage.pageId] ?? { includeCurrentPage: true, mentionedPageIds: [] }),
        mentionedPageIds: [
          ...new Set([...(current[activePage.pageId]?.mentionedPageIds ?? []), pageId]),
        ],
      },
    }));
    if (mentionMatch !== null) {
      setAssistantPrompt((current) => current.slice(0, mentionMatch.index).trimEnd());
    }
    setAssistantPickerIndex(0);
    setAssistantContextError(undefined);
    assistantComposerRef.current?.focus();
  };

  const runAssistantControl = async (action: 'delete' | 'new-topic' | 'older') => {
    if (activePage === undefined || assistantControlBusy !== undefined) return;
    if (action === 'delete') {
      setAssistantDeleteConfirmation(true);
      return;
    }
    setAssistantControlBusy(action);
    setAssistantContextError(undefined);
    try {
      if (action === 'new-topic') {
        await onAssistantNewTopic?.(activePage.pageId);
        clearAssistantRetryTopic(activePage.pageId);
      } else await onAssistantLoadOlder?.(activePage.pageId);
    } catch (error) {
      setAssistantContextError(
        error instanceof Error
          ? error.message
          : text('reachDeck.editor.assistant.controlFailed', 'Decksmith 对话操作失败，请重试。'),
      );
    } finally {
      setAssistantControlBusy(undefined);
    }
  };

  const confirmAssistantDelete = async () => {
    setAssistantDeleteConfirmation(false);
    if (activePage === undefined || assistantControlBusy !== undefined) return;
    setAssistantControlBusy('delete');
    setAssistantContextError(undefined);
    try {
      await onAssistantDeleteConversation?.(activePage.pageId);
      clearAssistantRetryTopic(activePage.pageId);
      setAssistantMessagesByPage((current) => ({
        ...current,
        [activePage.pageId]: [introMessage()],
      }));
    } catch (error) {
      setAssistantContextError(
        error instanceof Error
          ? error.message
          : text('reachDeck.editor.assistant.controlFailed', 'Decksmith 对话操作失败，请重试。'),
      );
    } finally {
      setAssistantControlBusy(undefined);
    }
  };

  /**
   * 以候选作答（卡片候选按钮与画布"用这个"共用）：
   * - 候选在当前幻灯片页上：在画布上选中它（不切换右侧面板），以"选这个"作答并把该元素作为本轮上下文；
   * - 候选在其他页：以文字作答（附页码），并把该页与候选元素（pageId + elementId）作为引用，不夹带当前选区。
   * 不可用的候选（元素已删除或页面已修改）不会走到这里。
   */
  const answerAssistantClarificationWithCandidate = (
    clarification: ReachDeckEditorAssistantClarification,
    resolved: ResolvedClarificationCandidate,
  ) => {
    const { candidate } = resolved;
    setPendingClarificationPick(undefined);
    if (candidate.pageId === activePageId) {
      setSelectedElementIdState(candidate.elementId);
      setSelectedElementIds([candidate.elementId]);
      setSelectedAnimationId(undefined);
      void runAssistantPrompt(
        text('reachDeck.editor.assistant.clarification.pickAnswer', '选这个：{label}', {
          label: candidate.label,
        }),
        { questionId: clarification.questionId, selectedElementIds: [candidate.elementId] },
      );
      return;
    }
    void runAssistantPrompt(clarificationOffPageAnswer(resolved), {
      questionId: clarification.questionId,
      selectedElementIds: [],
      mentionedPageIds: [candidate.pageId],
      // 以候选的 pageId + elementId 作为元素引用：同页可能有标签相同的候选，只靠文字无法区分。
      mentionedElements: [{ pageId: candidate.pageId, elementId: candidate.elementId }],
    });
  };

  const clarificationOffPageAnswer = (resolved: ResolvedClarificationCandidate) =>
    text(
      'reachDeck.editor.assistant.clarification.pickAnswerOnPage',
      '选这个：第 {order} 页的 {label}',
      {
        order: resolved.pageOrder ?? '?',
        label: resolved.candidate.label,
      },
    );

  /** 进入（或重新进入）画布点选；targetPageId 指向候选所在的其他页时一并跳转过去。 */
  const startClarificationPick = (
    originPageId: string,
    clarification: ReachDeckEditorAssistantClarification,
    targetPageId?: string,
  ) => {
    setDismissedClarificationPickIds((current) => {
      if (!current.has(clarification.questionId)) return current;
      const next = new Set(current);
      next.delete(clarification.questionId);
      return next;
    });
    setPendingClarificationPick(undefined);
    if (targetPageId === undefined || targetPageId === activePageId) return;
    setCrossPageClarificationPick(
      targetPageId === originPageId
        ? undefined
        : { originPageId, questionId: clarification.questionId },
    );
    safelyActivatePage(targetPageId);
  };

  /** Esc / 退出点选：关闭高亮，保留卡片上的其他作答方式。 */
  const exitClarificationPick = (questionId: string) => {
    setDismissedClarificationPickIds((current) => new Set(current).add(questionId));
    setCrossPageClarificationPick(undefined);
    setPendingClarificationPick(undefined);
    // 提示条与徽标随即卸载：焦点交还给画布区，不落回 body。
    previewRef.current?.focus();
  };

  /** 画布点中可作答的候选：选中它并显示"用这个"确认，不切换右侧面板。 */
  const chooseClarificationCandidate = (resolved: ResolvedClarificationCandidate) => {
    if (clarificationPickQuestionId === undefined) return;
    setSelectedElementIdState(resolved.candidate.elementId);
    setSelectedElementIds([resolved.candidate.elementId]);
    setSelectedAnimationId(undefined);
    setPendingClarificationPick({
      questionId: clarificationPickQuestionId,
      pageId: resolved.candidate.pageId,
      elementId: resolved.candidate.elementId,
    });
  };

  /** "用这个"：在提问页直接发送；在其他页时先回到提问页，再经同一发送路径发出。 */
  const confirmClarificationPick = () => {
    const session = clarificationPickSession;
    const resolved = pendingClarificationCandidate;
    if (session === undefined || resolved === undefined || activePageId === undefined) return;
    if (session.originPageId === activePageId) {
      answerAssistantClarificationWithCandidate(session.clarification, resolved);
      return;
    }
    setPendingClarificationPick(undefined);
    setCrossPageClarificationPick(undefined);
    setQueuedClarificationAnswer({
      originPageId: session.originPageId,
      fromPageId: activePageId,
      questionId: session.clarification.questionId,
      prompt: clarificationOffPageAnswer(resolved),
      mentionedElement: {
        pageId: resolved.candidate.pageId,
        elementId: resolved.candidate.elementId,
      },
    });
    safelyActivatePage(session.originPageId);
  };

  // 跨页确认的回答：回到提问页后发送；问题已不再等待回答或教师去了别的页则放弃。
  useEffect(() => {
    const queued = queuedClarificationAnswer;
    if (queued === undefined) return;
    if (activePageId === queued.originPageId) {
      setQueuedClarificationAnswer(undefined);
      if (openAssistantClarification?.questionId === queued.questionId) {
        void runAssistantPrompt(queued.prompt, {
          questionId: queued.questionId,
          selectedElementIds: [],
          mentionedPageIds: [queued.mentionedElement.pageId],
          mentionedElements: [queued.mentionedElement],
        });
      }
    } else if (activePageId !== queued.fromPageId) {
      setQueuedClarificationAnswer(undefined);
    }
  });

  // 点选期间 Esc 退出高亮（输入框、富文本与对话框内的 Esc 不受影响）。页面/插入/元素菜单打开时
  // Esc 只关闭菜单：菜单的 window 监听注册在后，这里不能靠 defaultPrevented 判断。
  const editorMenuOpen =
    pageMenu !== undefined || insertionMenu !== undefined || elementMenu !== undefined;
  useEffect(() => {
    if (clarificationPickQuestionId === undefined || editorMenuOpen) return;
    const questionId = clarificationPickQuestionId;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (deckShortcutTargetIsEditable(event.target)) return;
      setDismissedClarificationPickIds((current) => new Set(current).add(questionId));
      setCrossPageClarificationPick(undefined);
      setPendingClarificationPick(undefined);
      if (
        event.target instanceof Element &&
        event.target.closest(
          '.reach-deck-editor__clarification-pick, .reach-deck-editor__clarification-highlights',
        ) !== null
      ) {
        previewRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clarificationPickQuestionId, editorMenuOpen]);

  /** 卡片与画布共用的候选无障碍名称：编号 + 模型给出的标签（+ 不可用说明）。 */
  const clarificationCandidateName = (resolved: ResolvedClarificationCandidate) =>
    resolved.state === 'available'
      ? text('reachDeck.editor.assistant.clarification.canvasCandidate', '候选 {index}：{label}', {
          index: resolved.index,
          label: resolved.candidate.label,
        })
      : text(
          'reachDeck.editor.assistant.clarification.canvasCandidateUnavailable',
          '候选 {index}：{label}（已不可用）',
          { index: resolved.index, label: resolved.candidate.label },
        );

  const activeMediaSlots = (mediaSlotsByPageId?.[activePage?.pageId ?? ''] ?? []).filter((slot) => {
    if (slot.teacherReplaced) return false;
    const element =
      activeNativeSlide && locateNativeElement(activeNativeSlide.elements, slot.elementId)?.element;
    if (slot.binding === 'scientific-visual') {
      const originalSlide =
        document.schemaVersion === 'reach-deck-document/v2'
          ? document.nativeSlides.find((binding) => binding.pageId === activePage?.pageId)?.slide
          : undefined;
      const original =
        originalSlide && locateNativeElement(originalSlide.elements, slot.elementId)?.element;
      return (
        element?.type === 'scientificVisual' &&
        original?.type === 'scientificVisual' &&
        element.documentHtml === original.documentHtml &&
        reachDeckValuesEqual(element.manifest, original.manifest)
      );
    }
    return element?.type === 'image'
      ? element.resourceId === slot.resourceId
      : element?.type === 'shape' &&
          element.style?.fill?.kind === 'image' &&
          element.style.fill.resourceId === slot.resourceId;
  });
  const imageGenerating =
    imageSubmissionPageId === activePage?.pageId ||
    imageGeneratingPageIds?.includes(activePage?.pageId ?? '') === true;
  const mediaSlotFeedbackContext = JSON.stringify([
    activePage?.pageId,
    activeMediaSlots.map((slot) => [slot.assetId, slot.status, slot.resourceId, slot.attempt]),
  ]);
  useEffect(() => setMediaSlotError(undefined), [mediaSlotFeedbackContext]);
  const remoteImageGenerating = imageGeneratingPageIds?.includes(activePage?.pageId ?? '') === true;
  useEffect(() => {
    if (remoteImageGenerating) setMediaSlotError(undefined);
  }, [remoteImageGenerating]);
  const regenerateMediaSlot = async (slot: ReachDeckPageMediaSlot) => {
    if (
      !onRegenerateImage ||
      !activePage ||
      imageGenerating ||
      imageSubmittingRef.current ||
      activePageLocked ||
      disabled ||
      structureLocked
    )
      return;
    imageSubmittingRef.current = true;
    setImageSubmissionPageId(activePage.pageId);
    setMediaSlotError(undefined);
    try {
      await onRegenerateImage(
        activePage.pageId,
        slot.assetId,
        slot.status === 'failed' ? 'failed' : 'all',
      );
    } catch (error) {
      setMediaSlotError(
        error instanceof Error && error.name === 'ReachDeckUserFacingError'
          ? error.message
          : text('reachDeck.regeneration.failed', '提交失败，请确认任务状态后重试。'),
      );
    } finally {
      imageSubmittingRef.current = false;
      setImageSubmissionPageId(undefined);
    }
  };
  const mediaSlotOverlay =
    !onRegenerateImage || !activeNativeSlide || activePageLocked ? null : (
      <div className="reach-deck-editor__media-slots">
        {activeMediaSlots
          .filter((slot) => slot.status === 'failed')
          .map((slot) => {
            const located = locateNativeElement(activeNativeSlide.elements, slot.elementId);
            if (!located || nativeElementIsHidden(activeNativeSlide.elements, slot.elementId))
              return null;
            const label = text('reachDeck.editor.mediaSlot.retry', '重试这张图片');
            const description = slot.plannedAsset.alt.trim();
            const reason = text(
              `reachDeck.editor.mediaSlot.reason.${slot.failure?.reason ?? 'internal'}`,
              '图片生成失败，请重试。',
            );
            return (
              <button
                key={slot.assetId}
                type="button"
                className="reach-deck-editor__media-slot-retry"
                aria-label={text(
                  description
                    ? 'reachDeck.editor.mediaSlot.retryLabel'
                    : 'reachDeck.editor.mediaSlot.retryLabelWithoutDescription',
                  description ? '重试第 {number} 张图片：{description}' : '重试第 {number} 张图片',
                  {
                    number: slot.plannedIndex + 1,
                    description,
                  },
                )}
                title={text('reachDeck.editor.mediaSlot.retryTooltip', '{label}：{reason}', {
                  label,
                  reason,
                })}
                disabled={
                  imageGenerating ||
                  disabled ||
                  structureLocked ||
                  busyAction !== undefined ||
                  hostGenerationBlockedReason !== undefined
                }
                aria-busy={imageGenerating}
                style={{
                  left: located.box.x + located.box.width / 2,
                  top: located.box.y + located.box.height / 2,
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void regenerateMediaSlot(slot);
                }}
              >
                <RefreshCw data-spinning={imageGenerating || undefined} />
              </button>
            );
          })}
      </div>
    );

  /** 画布舞台叠加层：候选外框与编号徽标（编号按钮可用键盘点选）。 */
  const clarificationStageOverlay =
    clarificationPickSession === undefined ||
    activePage?.sceneType !== 'slide' ||
    activeClarificationPickCandidates.every(
      (resolved) => resolved.box === undefined,
    ) ? undefined : (
      <div
        className="reach-deck-editor__clarification-highlights"
        data-clarification-question-id={clarificationPickSession.clarification.questionId}
      >
        {activeClarificationPickCandidates.map((resolved) =>
          resolved.box === undefined ? null : (
            <div
              className="reach-deck-editor__clarification-highlight"
              data-candidate-element-id={resolved.candidate.elementId}
              data-pending={
                pendingClarificationCandidate?.candidate.elementId ===
                  resolved.candidate.elementId || undefined
              }
              data-state={resolved.state}
              key={resolved.candidate.elementId}
              style={{
                height: resolved.box.height,
                left: resolved.box.x,
                top: resolved.box.y,
                transform:
                  resolved.box.rotation === undefined
                    ? undefined
                    : `rotate(${resolved.box.rotation}deg)`,
                width: resolved.box.width,
              }}
            >
              <button
                aria-label={clarificationCandidateName(resolved)}
                aria-pressed={
                  resolved.state === 'available'
                    ? pendingClarificationCandidate?.candidate.elementId ===
                      resolved.candidate.elementId
                    : undefined
                }
                className="reach-deck-editor__clarification-badge"
                disabled={
                  resolved.state !== 'available' ||
                  disabled ||
                  busyAction !== undefined ||
                  activePageLocked
                }
                onClick={(event) => {
                  event.stopPropagation();
                  chooseClarificationCandidate(resolved);
                }}
                title={clarificationCandidateName(resolved)}
                type="button"
              >
                {resolved.index}
              </button>
            </div>
          ),
        )}
      </div>
    );

  /** 画布上方的点选提示条：说明、跨页前往/返回、"用这个"确认与退出。 */
  const renderClarificationPickBar = () => {
    const session = clarificationPickSession;
    if (session === undefined || activePageId === undefined) return null;
    const availableHere = activeClarificationPickCandidates.filter(
      (resolved) => resolved.state === 'available',
    ).length;
    const unavailableHere = activeClarificationPickCandidates.length - availableHere;
    const otherPages = [
      ...new Map(
        clarificationPickCandidates
          .filter(
            (resolved) =>
              resolved.candidate.pageId !== activePageId &&
              resolved.state === 'available' &&
              resolved.pageOrder !== undefined,
          )
          .map((resolved) => [resolved.candidate.pageId, resolved.pageOrder!] as const),
      ),
    ];
    const originOrder = orderedPages.findIndex((page) => page.pageId === session.originPageId) + 1;
    const confirmBlocked =
      disabled ||
      busyAction !== undefined ||
      (session.originPageId === activePageId
        ? assistantSendBlocked
        : runningAssistantPages.has(session.originPageId) ||
          pendingAssistantPages.has(session.originPageId));
    return (
      <div
        aria-label={text('reachDeck.editor.assistant.clarification.pickBar', '点选回答 Decksmith')}
        className="reach-deck-editor__clarification-pick"
        role="group"
      >
        <MousePointerClick aria-hidden size={16} />
        <p aria-live="polite" className="reach-deck-editor__clarification-pick-status">
          {pendingClarificationCandidate !== undefined
            ? text('reachDeck.editor.assistant.clarification.pickSelected', '已选：{name}', {
                name: clarificationCandidateName(pendingClarificationCandidate),
              })
            : availableHere > 0
              ? text(
                  'reachDeck.editor.assistant.clarification.pickHint',
                  '点击画布上带编号的高亮元素来回答 Decksmith 的问题。',
                )
              : text(
                  'reachDeck.editor.assistant.clarification.pickNoneHere',
                  '这一页没有可点选的候选。',
                )}
          {unavailableHere > 0 ? (
            <small>
              {text(
                'reachDeck.editor.assistant.clarification.pickUnavailable',
                '{count} 个候选已不可用（元素已删除或页面已修改）。',
                { count: unavailableHere },
              )}
            </small>
          ) : null}
        </p>
        <div className="reach-deck-editor__clarification-pick-actions">
          {otherPages.map(([pageId, order]) => (
            <Button
              key={pageId}
              onClick={() =>
                startClarificationPick(session.originPageId, session.clarification, pageId)
              }
              size="sm"
              variant="outline"
            >
              {text('reachDeck.editor.assistant.clarification.goToPage', '前往第 {order} 页', {
                order,
              })}
            </Button>
          ))}
          {session.originPageId === activePageId || originOrder < 1 ? null : (
            <Button
              onClick={() => safelyActivatePage(session.originPageId)}
              size="sm"
              variant="outline"
            >
              {text(
                'reachDeck.editor.assistant.clarification.backToQuestion',
                '返回提问的第 {order} 页',
                { order: originOrder },
              )}
            </Button>
          )}
          {pendingClarificationCandidate === undefined ? null : (
            <Button
              className="reach-deck-editor__clarification-confirm"
              disabled={confirmBlocked}
              iconStart={<CheckIcon aria-hidden />}
              onClick={confirmClarificationPick}
              size="sm"
              variant="primary"
            >
              {text('reachDeck.editor.assistant.clarification.useThis', '用这个')}
            </Button>
          )}
          <Button
            onClick={() => exitClarificationPick(session.clarification.questionId)}
            size="sm"
            variant="ghost"
          >
            {text('reachDeck.editor.assistant.clarification.exitPick', '退出点选')}
          </Button>
        </div>
      </div>
    );
  };

  /** 结构化提问卡片：问题、选项按钮、候选列表与文字回复入口；非最新的问题只读展示。 */
  const renderAssistantClarification = (
    clarification: ReachDeckEditorAssistantClarification,
    open: boolean,
  ) => {
    const answerDisabled = !open || assistantSendBlocked;
    const questionLabel = text(
      'reachDeck.editor.assistant.clarification.label',
      'Decksmith 的问题',
    );
    const resolvedCandidates = resolveClarificationCandidates(draft, clarification.candidates);
    const pickable =
      open && clarification.expect === 'select-element' && activePageId !== undefined;
    const otherCandidatePages = pickable
      ? [
          ...new Map(
            resolvedCandidates
              .filter(
                (resolved) =>
                  resolved.candidate.pageId !== activePageId &&
                  resolved.state === 'available' &&
                  resolved.pageOrder !== undefined,
              )
              .map((resolved) => [resolved.candidate.pageId, resolved.pageOrder!] as const),
          ),
        ]
      : [];
    const pickDismissed = pickable && dismissedClarificationPickIds.has(clarification.questionId);
    return (
      <div
        aria-label={questionLabel}
        className="reach-deck-editor__assistant-clarification"
        data-clarification-expect={clarification.expect}
        data-clarification-open={open ? 'true' : 'false'}
        role="group"
      >
        <strong>{questionLabel}</strong>
        <p className="reach-deck-editor__assistant-clarification-question">
          {clarification.question}
        </p>
        {clarification.options.length > 0 ? (
          <div
            aria-label={text('reachDeck.editor.assistant.clarification.options', '可选回答')}
            className="reach-deck-editor__assistant-clarification-options"
            role="group"
          >
            {clarification.options.map((option) => (
              <button
                aria-label={text(
                  'reachDeck.editor.assistant.clarification.optionAnswer',
                  '回答：{option}',
                  { option },
                )}
                disabled={answerDisabled}
                key={option}
                onClick={() =>
                  void runAssistantPrompt(option, { questionId: clarification.questionId })
                }
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {resolvedCandidates.length > 0 ? (
          <ul
            aria-label={text('reachDeck.editor.assistant.clarification.candidates', '候选元素')}
            className="reach-deck-editor__assistant-clarification-candidates"
          >
            {resolvedCandidates.map((resolved) => {
              const { candidate } = resolved;
              const unavailable = resolved.state !== 'available';
              return (
                <li
                  data-unavailable={unavailable || undefined}
                  key={`${candidate.pageId}:${candidate.elementId}`}
                >
                  <span aria-hidden className="reach-deck-editor__assistant-clarification-index">
                    {resolved.index}
                  </span>
                  {clarification.expect === 'select-element' ? (
                    <button
                      aria-label={
                        unavailable
                          ? clarificationCandidateName(resolved)
                          : text(
                              'reachDeck.editor.assistant.clarification.pickCandidate',
                              '选择并回答：{label}',
                              { label: candidate.label },
                            )
                      }
                      disabled={answerDisabled || unavailable}
                      onClick={() =>
                        answerAssistantClarificationWithCandidate(clarification, resolved)
                      }
                      type="button"
                    >
                      {candidate.label}
                    </button>
                  ) : (
                    <span>{candidate.label}</span>
                  )}
                  {unavailable && clarification.expect === 'select-element' ? (
                    <small aria-hidden>
                      {text('reachDeck.editor.assistant.clarification.unavailable', '已不可用')}
                    </small>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {pickable && (pickDismissed || otherCandidatePages.length > 0) ? (
          <div className="reach-deck-editor__assistant-clarification-pick-actions">
            {pickDismissed ? (
              <button
                onClick={() => startClarificationPick(activePageId, clarification)}
                type="button"
              >
                <MousePointerClick aria-hidden size={14} />
                {text('reachDeck.editor.assistant.clarification.pickOnCanvas', '在画布上点选')}
              </button>
            ) : null}
            {otherCandidatePages.map(([pageId, order]) => (
              <button
                key={pageId}
                onClick={() => startClarificationPick(activePageId, clarification, pageId)}
                type="button"
              >
                {text('reachDeck.editor.assistant.clarification.goToPage', '前往第 {order} 页', {
                  order,
                })}
              </button>
            ))}
          </div>
        ) : null}
        {open ? (
          <button
            className="reach-deck-editor__assistant-clarification-reply"
            disabled={assistantSendBlocked}
            onClick={() => {
              if (activePageId !== undefined) {
                setAssistantReplyUnlinkedByPage((current) => {
                  if (current[activePageId] === undefined) return current;
                  const { [activePageId]: _unlinked, ...rest } = current;
                  return rest;
                });
              }
              assistantComposerRef.current?.focus();
            }}
            type="button"
          >
            {text('reachDeck.editor.assistant.clarification.replyWithText', '用文字回答')}
          </button>
        ) : (
          <small className="reach-deck-editor__assistant-clarification-closed">
            {text('reachDeck.editor.assistant.clarification.closed', '这个问题已不再等待回答。')}
          </small>
        )}
      </div>
    );
  };

  /**
   * 发送一轮 Decksmith 请求。
   * answer：回答 Decksmith 的提问（选项、候选或文字回复）；selectedElementIds 覆盖当前选区，
   * 让"点候选"在同一次点击里把该元素作为上下文发送，不依赖尚未提交的选区状态。
   * 输入框发送（无 suggestedPrompt）时自动关联未取消的待答问题；快捷指令不关联。
   */
  const runAssistantPrompt = async (
    suggestedPrompt?: string,
    answer?: {
      readonly questionId: string;
      readonly selectedElementIds?: readonly string[];
      /** 候选在其他页时把那一页加入页面引用。 */
      readonly mentionedPageIds?: readonly string[];
      /** 候选在其他页时把该元素（pageId + elementId）加入元素引用。 */
      readonly mentionedElements?: readonly { pageId: string; elementId: string }[];
    },
    retry?: AssistantRetryRequest,
  ) => {
    const prompt = (retry?.prompt ?? suggestedPrompt ?? assistantPrompt).trim();
    const answersQuestionId =
      answer?.questionId ?? (suggestedPrompt === undefined ? linkedAssistantQuestionId : undefined);
    const requestElementIds =
      answer?.selectedElementIds === undefined
        ? selectedElementIds
        : [...answer.selectedElementIds];
    const requestElementId =
      answer?.selectedElementIds === undefined ? selectedElementId : requestElementIds[0];
    if (
      prompt.length === 0 ||
      onAssistantPrompt === undefined ||
      activePage === undefined ||
      disabled ||
      busyAction !== undefined ||
      assistantBlockedReason !== undefined ||
      assistantControlBusy !== undefined ||
      assistantCancelBusyRef.current ||
      assistantRequestsRef.current[activePage.pageId] !== undefined ||
      assistantBusy ||
      assistantJobActive ||
      pendingAssistantChange !== undefined
    ) {
      return;
    }
    const operationId = ++assistantOperationIdRef.current;
    const originPageId = activePage.pageId;
    setStoppedAssistantRequest(originPageId, undefined);
    assistantOperationByPageRef.current[originPageId] = operationId;
    const isCurrentOperation = () =>
      assistantOperationByPageRef.current[originPageId] === operationId;
    const snapshot = draftRef.current;
    const startVersion = draftVersionRef.current;
    setAssistantPrompt('');
    setAssistantPageBusy(originPageId, true);
    setAssistantProgressByPage((current) => ({
      ...current,
      [originPageId]: { text: undefined, updatedAt: Date.now() },
    }));
    setPendingAssistantChange(originPageId, undefined);
    const optimisticUserId = `local:${operationId}:user`;
    updateAssistantMessages(originPageId, (current) => [
      ...current,
      {
        id: optimisticUserId,
        persistedUserMessageIdsAtCreation: current
          .filter((message) => message.role === 'user' && !message.id.startsWith('local:'))
          .map((message) => message.id),
        role: 'user',
        text: prompt,
      },
    ]);
    const request: AssistantRetryRequest =
      retry === undefined
        ? {
            elementId: requestElementId,
            ...(requestElementIds.length > 0 ? { selectedElementIds: requestElementIds } : {}),
            pageId: originPageId,
            prompt,
            ...(answersQuestionId === undefined ? {} : { answersQuestionId }),
            includeCurrentPage: assistantContext.includeCurrentPage,
            mentionedPageIds: [
              ...new Set([
                ...assistantContext.mentionedPageIds,
                ...(answer?.mentionedPageIds ?? []),
              ]),
            ],
            ...(answer?.mentionedElements === undefined || answer.mentionedElements.length === 0
              ? {}
              : { mentionedElements: answer.mentionedElements.map((element) => ({ ...element })) }),
            ...(interactiveComponentFocus?.pageId === originPageId
              ? { interactiveComponentFocus }
              : {}),
          }
        : {
            ...retry,
            selectedElementIds: retry.selectedElementIds?.slice(),
            mentionedPageIds: retry.mentionedPageIds.slice(),
            mentionedElements: retry.mentionedElements?.map((element) => ({ ...element })),
          };
    assistantRequestsRef.current[originPageId] = { operationId, request };
    try {
      const response = await onAssistantPrompt({
        ...request,
        document: snapshot,
        onProgress: (text) => {
          // Kept per page: switching away and back shows the page's own latest progress.
          if (isCurrentOperation() && text.length > 0) setAssistantPageProgress(originPageId, text);
        },
      });
      await assistantCancelGatesRef.current[originPageId];
      if (!isCurrentOperation()) return;
      if (response.originPageId !== undefined && response.originPageId !== originPageId) {
        throw new Error(
          text(
            'reachDeck.editor.assistant.responsePageMismatch',
            'Decksmith 回复与发起页面不匹配，未将其加入当前对话。',
          ),
        );
      }
      const historyRunId = response.historyRunId ?? `local:${operationId}`;
      const legacyHistoryRunId =
        response.legacyHistoryRunId === historyRunId ? response.legacyHistoryRunId : undefined;
      if (legacyHistoryRunId !== undefined) {
        rememberLegacyAssistantRun(originPageId, {
          assistantText: response.message,
          runId: legacyHistoryRunId,
          userText: prompt,
        });
      }
      const historyUserId = `${historyRunId}:user`;
      const assistantMessageId = `${historyRunId}:assistant`;
      if (response.document !== undefined) {
        setPendingAssistantChange(originPageId, {
          document: response.document,
          baseVersion: startVersion,
          baseDocument: snapshot,
          messageId: assistantMessageId,
          ...(legacyHistoryRunId === undefined ? {} : { legacyHistoryRunId }),
          ...(response.runtimeApprovalId === undefined
            ? {}
            : { runtimeApprovalId: response.runtimeApprovalId }),
        });
      }
      updateAssistantMessages(originPageId, (current) => [
        ...current.filter(
          (message) =>
            message.id !== optimisticUserId &&
            message.id !== historyUserId &&
            message.id !== assistantMessageId,
        ),
        { id: historyUserId, role: 'user', text: prompt },
        {
          ...(response.changeSummary === undefined
            ? {}
            : { changeSummary: response.changeSummary }),
          id: assistantMessageId,
          role: 'assistant',
          ...(response.runtimeApprovalId === undefined
            ? {}
            : { approvalPhase: 'proposal', runtimeApprovalId: response.runtimeApprovalId }),
          ...(response.outcome === undefined ? {} : { outcome: response.outcome }),
          text: response.message,
          ...(response.document === undefined
            ? {}
            : {
                suffixTranslation: localizedCopy(
                  'reachDeck.editor.assistant.confirmSuffix',
                  '（请在下方确认是否应用修改）',
                ),
              }),
        },
      ]);
    } catch (error) {
      await assistantCancelGatesRef.current[originPageId];
      if (isCurrentOperation()) {
        updateAssistantMessages(originPageId, (current) => [
          ...current,
          {
            id: `local:${operationId}:error`,
            role: 'assistant',
            text: error instanceof Error ? error.message : 'AI 修改失败，请重试。',
            ...(error instanceof Error
              ? {}
              : {
                  translation: localizedCopy(
                    'reachDeck.editor.assistant.failed',
                    'AI 修改失败，请重试。',
                  ),
                }),
          },
        ]);
      }
    } finally {
      if (isCurrentOperation()) {
        delete assistantRequestsRef.current[originPageId];
        setAssistantPageBusy(originPageId, false);
        setAssistantPageProgress(originPageId, undefined);
      }
    }
  };

  /**
   * 已批准候选的有版本证明恢复（WP8 / 评审 M9）。
   *
   * 数据源：宿主的恢复证明（先落盘本地编辑，再读审批冲突报告：提案改动页、stale 页、结构 / 外壳漂移）
   * 与本地草稿、本地编辑版本。
   * 核心逻辑：
   * 1. 记下审批 id、候选指纹与本地编辑版本，请宿主给出证明；
   * 2. 返回后三者任一变化（检查期间有本地编辑、待处理候选被替换）都不写草稿，提示重试；
   * 3. 证明成立时只把候选改动的、草稿里缺失的页写回草稿（不整份覆盖）；已包含或已过期时不写；
   * 4. 有较新的教师修改或无法证明时，标记为需要显式"重新采用"，返回 stop。
   * 返回 continue 表示可以继续；settle 表示提案已过期（结构 / 外壳变化），只重发 `/applied` 结清、不写草稿。
   */
  const proveApprovedCandidateRestore = async (
    pageId: string,
    target: PendingAssistantChange,
  ): Promise<'continue' | 'stop' | 'settle'> => {
    const candidate = target.document;
    const approvalId = target.runtimeApprovalId;
    if (candidate === undefined || approvalId === undefined) return 'continue';
    const offerReAdopt = (
      reAdopt: NonNullable<PendingAssistantChange['reAdopt']>,
      footprint?: Pick<PendingAssistantChange, 'changedPageIds' | 'structural' | 'envelopeChanged'>,
    ) => {
      // 有服务端冲突报告时，重新采用按报告给出的提案足迹（采用证明的改动页 / 结构性）逐页合并。
      setPendingAssistantChange(pageId, { ...target, ...footprint, reAdopt });
      updateAssistantMessages(pageId, (current) => [
        ...current,
        {
          id: `local:${++assistantOperationIdRef.current}:system`,
          role: 'assistant',
          text: '这些页在 AI 修改之后又被编辑过，未自动恢复 AI 修改。需要时可重新采用，会覆盖这些页上较新的修改。',
          translation: localizedCopy(
            'reachDeck.editor.assistant.reAdoptRequired',
            '这些页在 AI 修改之后又被编辑过，未自动恢复 AI 修改。需要时可重新采用，会覆盖这些页上较新的修改。',
          ),
        },
      ]);
    };
    const knownChanged = decksmithCandidateChangedPageIds({
      candidate,
      ...(target.baseDocument === undefined ? {} : { baseline: target.baseDocument }),
      ...(target.changedPageIds === undefined ? {} : { changedPageIds: target.changedPageIds }),
    });
    if (onAssistantRestoreCheck === undefined) {
      const plan =
        knownChanged === undefined
          ? undefined
          : planDecksmithCandidateRestore({
              candidate,
              draft: draftRef.current,
              changedPageIds: knownChanged,
              structural: target.structural === true,
              envelopeChanged: target.envelopeChanged === true,
              check: { expired: false, conflicts: [] },
            });
      if (plan?.kind === 'present') return 'continue';
      offerReAdopt({ reason: 'unproven', pageIds: knownChanged ?? [] });
      return 'stop';
    }
    const editVersion = localEditVersionRef.current;
    const fingerprint = decksmithCandidateFingerprint(candidate);
    let check: ReachDeckEditorAssistantRestoreCheck;
    try {
      check = await onAssistantRestoreCheck(approvalId);
    } catch {
      // 读不到证明时不写草稿；`/applied` 会按服务端状态结清（已采用 / 被替代 / 过期）。
      return 'continue';
    }
    const latest = pendingAssistantChangesRef.current[pageId];
    if (
      localEditVersionRef.current !== editVersion ||
      latest?.runtimeApprovalId !== approvalId ||
      latest.document === undefined ||
      decksmithCandidateFingerprint(latest.document) !== fingerprint
    ) {
      updateAssistantMessages(pageId, (current) => [
        ...current,
        {
          id: `local:${++assistantOperationIdRef.current}:system`,
          role: 'assistant',
          text: '检查期间课件有新的修改，未恢复 AI 修改，请再试一次。',
          translation: localizedCopy(
            'reachDeck.editor.assistant.restoreChangedDuringCheck',
            '检查期间课件有新的修改，未恢复 AI 修改，请再试一次。',
          ),
        },
      ]);
      return 'stop';
    }
    const changedPageIds = check.changedPageIds ?? knownChanged;
    if (changedPageIds === undefined) {
      offerReAdopt({ reason: 'unproven', pageIds: [] });
      return 'stop';
    }
    const plan = planDecksmithCandidateRestore({
      candidate,
      draft: draftRef.current,
      changedPageIds,
      structural: check.structural || target.structural === true,
      envelopeChanged: check.envelopeChanged === true || target.envelopeChanged === true,
      check,
    });
    if (plan.kind === 'conflict') {
      offerReAdopt(
        { reason: plan.reason, pageIds: plan.pageIds },
        {
          changedPageIds,
          structural: check.structural || target.structural === true,
          envelopeChanged: check.envelopeChanged === true || target.envelopeChanged === true,
        },
      );
      return 'stop';
    }
    if (plan.kind === 'settle') return 'settle';
    if (plan.kind === 'restore') commitAdoptedAssistantDocument(plan.document);
    return 'continue';
  };

  /** 草稿是否已包含候选改动的全部页（不需要恢复）；改动页未知时视为不包含。 */
  const draftContainsAssistantCandidate = (target: PendingAssistantChange): boolean => {
    if (target.document === undefined) return true;
    const changedPageIds = decksmithCandidateChangedPageIds({
      candidate: target.document,
      ...(target.baseDocument === undefined ? {} : { baseline: target.baseDocument }),
      ...(target.changedPageIds === undefined ? {} : { changedPageIds: target.changedPageIds }),
    });
    return (
      changedPageIds !== undefined &&
      planDecksmithCandidateRestore({
        candidate: target.document,
        draft: draftRef.current,
        changedPageIds,
        structural: target.structural === true,
        envelopeChanged: target.envelopeChanged === true,
        check: { expired: false, conflicts: [] },
      }).kind === 'present'
    );
  };

  /**
   * 教师显式重新采用（WP8 / M9）：证明不成立时，按提案改动页把候选写回草稿（覆盖这些页上较新的修改），
   * 再由宿主保存并重发 `/applied`。
   */
  const reAdoptAssistantChange = async (pageId: string): Promise<void> => {
    const target = pendingAssistantChangesRef.current[pageId];
    const candidate = target?.document;
    if (
      target === undefined ||
      candidate === undefined ||
      target.runtimeApprovalId === undefined ||
      onAssistantAppliedRetry === undefined ||
      assistantDecisionBusyPageId !== undefined
    ) {
      return;
    }
    const changedPageIds =
      decksmithCandidateChangedPageIds({
        candidate,
        ...(target.baseDocument === undefined ? {} : { baseline: target.baseDocument }),
        ...(target.changedPageIds === undefined ? {} : { changedPageIds: target.changedPageIds }),
      }) ?? candidate.pages.map((page) => page.pageId);
    const rebased = rebaseAssistantCandidateByPages(candidate, draftRef.current, changedPageIds, {
      envelopeChanged: target.envelopeChanged === true,
      structural: target.structural === true,
    });
    if (rebased === undefined) {
      // 按页合并失败（改动页已不在草稿里等）：绝不退回整份候选覆盖，否则会连带冲掉提案之外各页的
      // 较新修改与之后新增的页；保留"重新采用"状态，由教师放弃这份修改。
      updateAssistantMessages(pageId, (current) => [
        ...current,
        {
          id: `local:${++assistantOperationIdRef.current}:system`,
          role: 'assistant',
          text: '这份 AI 修改已无法与当前课件按页合并，未重新采用；可以放弃这份修改。',
          translation: localizedCopy(
            'reachDeck.editor.assistant.reAdoptUnmergeable',
            '这份 AI 修改已无法与当前课件按页合并，未重新采用；可以放弃这份修改。',
          ),
        },
      ]);
      return;
    }
    commitAdoptedAssistantDocument(rebased.document);
    const { reAdopt: _reAdopt, ...rest } = target;
    setPendingAssistantChange(pageId, { ...rest, stale: false, appliedLocally: true });
    setAssistantDecisionBusyPageId(pageId);
    try {
      await onAssistantAppliedRetry(target.runtimeApprovalId);
    } catch {
      updateAssistantMessages(pageId, (current) => [
        ...current,
        {
          id: `local:${++assistantOperationIdRef.current}:system`,
          role: 'assistant',
          text: '本次 AI 修改尚未应用成功，请重试。',
          translation: localizedCopy(
            'reachDeck.editor.assistant.applyConfirmationFailed',
            '本次 AI 修改尚未应用成功，请重试。',
          ),
        },
      ]);
    } finally {
      setAssistantDecisionBusyPageId((current) => (current === pageId ? undefined : current));
    }
  };

  /** 教师确认采纳 Decksmith 变更；若草稿在确认前已被手工编辑则放弃，避免覆盖较新内容。 */
  const applyAssistantChange = async (
    pageId: string | undefined = pendingAssistantChangeKey,
    options: { readonly override?: boolean } = {},
  ): Promise<void> => {
    const target = pageId === undefined ? undefined : pendingAssistantChanges[pageId];
    const approvedRecovery =
      target?.runtimeApprovalId !== undefined && isApprovedApproval(target.runtimeApprovalId);
    if (
      disabled ||
      busyAction !== undefined ||
      assistantDecisionBusyPageId !== undefined ||
      target === undefined ||
      target.document === undefined
    ) {
      return;
    }
    if (activePage === undefined || pageId === undefined) return;
    if (target.stale === true) {
      // A stale approved recovery cannot be rejected (the decision is immutable), but asking the
      // host to confirm `/applied` is safe: a proposal mismatch releases the old lease while an
      // already-authoritative candidate converges idempotently.
      if (approvedRecovery && onAssistantAppliedRetry !== undefined) {
        setAssistantDecisionBusyPageId(pageId);
        try {
          // A refresh can observe a multi-page candidate after only some page-only writes have
          // landed. Restore only the candidate pages the draft is missing, and only with a
          // version proof that no later teacher edit would be overwritten (WP8 / M9); otherwise
          // the teacher must re-adopt explicitly. Then retry the idempotent `/applied`.
          if (target.recoverablePartial === true) {
            if ((await proveApprovedCandidateRestore(pageId, target)) === 'stop') return;
          }
          await onAssistantAppliedRetry(target.runtimeApprovalId!);
        } catch {
          updateAssistantMessages(pageId, (current) => [
            ...current,
            {
              id: `local:${++assistantOperationIdRef.current}:system`,
              role: 'assistant',
              text: '恢复结果已过期，暂时无法清理旧的应用确认，请稍后重试。',
              translation: localizedCopy(
                'reachDeck.editor.assistant.staleRecoveryRetryFailed',
                '恢复结果已过期，暂时无法清理旧的应用确认，请稍后重试。',
              ),
            },
          ]);
        } finally {
          setAssistantDecisionBusyPageId((current) => (current === pageId ? undefined : current));
        }
      }
      return;
    }
    if (target.appliedLocally) {
      // `appliedLocally` 只说明候选已写进本地草稿，不代表持久化保存成功——它在 commit 之后
      // 立刻置位。真正的重放靠宿主：`onAssistantAppliedRetry` 会先 flush 一次自动保存
      // （失败的那次会把 pending 放回队列），再重发 `/applied`。这里不再 commit，是因为
      // 重复 commit 会盖掉期间更新的草稿，而不是因为「保存已经成功了」。
      if (target.runtimeApprovalId !== undefined && onAssistantAppliedRetry !== undefined) {
        setAssistantDecisionBusyPageId(pageId);
        try {
          try {
            await onAssistantAppliedRetry(target.runtimeApprovalId);
          } catch (error) {
            // 候选还没成为权威文档，而草稿里也已经没有它（例如旧刷新把草稿换回了基线）：
            // 只在有版本证明时把缺的页恢复进草稿再重试一次，否则要求显式重新采用（WP8 / M9）。
            if (
              (error as { kind?: unknown } | undefined)?.kind !==
                'candidate_not_authoritative_yet' ||
              draftContainsAssistantCandidate(target)
            ) {
              throw error;
            }
            const gate = await proveApprovedCandidateRestore(pageId, target);
            if (gate === 'stop') return;
            await onAssistantAppliedRetry(target.runtimeApprovalId);
          }
        } catch {
          updateAssistantMessages(pageId, (current) =>
            current.map((message) =>
              message.id === target.messageId
                ? { ...message, approvalPhase: 'apply-failed' }
                : message,
            ),
          );
          updateAssistantMessages(pageId, (current) => [
            ...current,
            {
              id: `local:${++assistantOperationIdRef.current}:system`,
              role: 'assistant',
              text: '本次 AI 修改尚未应用成功，请重试。',
              translation: localizedCopy(
                'reachDeck.editor.assistant.applyConfirmationFailed',
                '本次 AI 修改尚未应用成功，请重试。',
              ),
            },
          ]);
          return;
        } finally {
          setAssistantDecisionBusyPageId((current) => (current === pageId ? undefined : current));
        }
      }
      focusAssistantComposerAfterActionRef.current = true;
      queueMicrotask(() => assistantComposerRef.current?.focus());
      return;
    }
    if (
      approvedRecovery &&
      target.changedPageIds !== undefined &&
      onAssistantRestoreCheck !== undefined &&
      onAssistantAppliedRetry !== undefined
    ) {
      // 已批准的恢复提案会按改动页落到当前草稿：先证明这些页之后没有被教师改过（WP8 / M9）。
      setAssistantDecisionBusyPageId(pageId);
      try {
        const gate = await proveApprovedCandidateRestore(pageId, target);
        if (gate === 'stop') return;
        if (gate === 'settle') {
          await onAssistantAppliedRetry(target.runtimeApprovalId!);
          return;
        }
      } catch {
        return;
      } finally {
        setAssistantDecisionBusyPageId((current) => (current === pageId ? undefined : current));
      }
    }
    if (
      target.runtimeApprovalId !== undefined &&
      !approvedRecovery &&
      options.override !== true &&
      onAssistantApplyCheck !== undefined
    ) {
      // Other pages' Decksmith turns may touch the same pages: ask before overriding them.
      setAssistantDecisionBusyPageId(pageId);
      let check: ReachDeckEditorAssistantApplyCheck | undefined;
      try {
        check = await onAssistantApplyCheck(target.runtimeApprovalId);
      } catch {
        // The decision itself re-checks and refuses an unconfirmed override.
        check = undefined;
      } finally {
        setAssistantDecisionBusyPageId((current) => (current === pageId ? undefined : current));
      }
      if (check !== undefined && (check.expired || check.conflicts.length > 0)) {
        setAssistantApplyCheck({ pageId, check });
        return;
      }
    }
    setAssistantApplyCheck((current) => (current?.pageId === pageId ? undefined : current));
    const id = `local:${++assistantOperationIdRef.current}:system`;
    const recoveryId = target.recoveryId;
    // The teacher may keep editing other pages while Decksmith runs. Take only the pages the
    // proposal changes and keep everything else from the current draft.
    // A recovered proposal has no starting draft; its changed pages come from the server proof.
    const rebaseOntoDraft = () =>
      target.changedPageIds !== undefined
        ? rebaseAssistantCandidateByPages(
            target.document!,
            draftRef.current,
            target.changedPageIds,
            {
              envelopeChanged: target.envelopeChanged === true,
              structural: target.structural === true,
            },
          )
        : draftVersionRef.current !== target.baseVersion && target.baseDocument !== undefined
          ? rebaseAssistantCandidate(target.baseDocument, target.document!, draftRef.current)
          : undefined;
    const needsRebase = () =>
      target.changedPageIds !== undefined || draftVersionRef.current !== target.baseVersion;
    const keepUnmergedProposal = async () => {
      if (approvedRecovery && onAssistantAppliedRetry !== undefined) {
        setPendingAssistantChange(pageId, { ...target, stale: true });
        setAssistantDecisionBusyPageId(pageId);
        try {
          await onAssistantAppliedRetry(target.runtimeApprovalId!);
        } catch {
          updateAssistantMessages(pageId, (current) => [
            ...current,
            {
              id,
              role: 'assistant',
              text: '草稿已变更，恢复结果无法直接应用；正在等待清理旧的应用确认。',
              translation: localizedCopy(
                'reachDeck.editor.assistant.staleRecoveryRetryFailed',
                '草稿已变更，恢复结果无法直接应用；正在等待清理旧的应用确认。',
              ),
            },
          ]);
        } finally {
          setAssistantDecisionBusyPageId((current) => (current === pageId ? undefined : current));
        }
        return;
      }
      // Never decide for the teacher: keep the proposal so it can be retried or discarded.
      updateAssistantMessages(pageId, (current) => [
        ...current,
        {
          id,
          role: 'assistant',
          text: '这份修改暂时无法合并到当前草稿，已保留，可稍后重试或放弃。',
          translation: localizedCopy(
            'reachDeck.editor.assistant.rebaseUnavailable',
            '这份修改暂时无法合并到当前草稿，已保留，可稍后重试或放弃。',
          ),
        },
      ]);
    };
    // Checked before approving: once the approval is recorded its candidate must land.
    const checkedRebase = rebaseOntoDraft();
    if (needsRebase() && checkedRebase === undefined) {
      await keepUnmergedProposal();
      return;
    }
    const checkedVersion = draftVersionRef.current;
    const terminalApplyFailure =
      target.runtimeApprovalId !== undefined && isApplyTerminalApproval(target.runtimeApprovalId);
    if (target.runtimeApprovalId !== undefined && !terminalApplyFailure) {
      // Record the approval before touching the draft. A refused or failed decision leaves the
      // draft and the proposal as they were; a conflict found at decision time asks again.
      setAssistantDecisionBusyPageId(pageId);
      try {
        await onAssistantDecision?.({
          runtimeApprovalId: target.runtimeApprovalId,
          decision: 'approved',
          ...(options.override === true ? { override: true } : {}),
        });
      } catch (error) {
        const check = assistantApplyCheckFromError(error);
        if (check !== undefined) {
          setAssistantApplyCheck({ pageId, check });
          return;
        }
        updateAssistantMessages(pageId, (current) => [
          ...current,
          {
            id,
            role: 'assistant',
            text: '未能确认采用 AI 修改，请重试。',
            translation: localizedCopy(
              'reachDeck.editor.assistant.decisionFailed',
              '未能确认采用 AI 修改，请重试。',
            ),
          },
        ]);
        return;
      } finally {
        setAssistantDecisionBusyPageId((current) => (current === pageId ? undefined : current));
      }
    }
    // The draft may have changed while the decision was recorded; rebase onto the latest one.
    // The approval cannot be withdrawn, so should that no longer be possible (the draft's page
    // structure changed meanwhile), land the document checked before approving and say so.
    const latestRebase =
      draftVersionRef.current === checkedVersion ? checkedRebase : rebaseOntoDraft();
    const replacedDraftChange = needsRebase() && latestRebase === undefined;
    const rebase = replacedDraftChange ? checkedRebase : latestRebase;
    const adoptedDocument = rebase?.document ?? target.document;
    forgetLegacyAssistantRun(pageId, target.legacyHistoryRunId);
    commitAdoptedAssistantDocument(adoptedDocument);
    if (recoveryId !== undefined) onAssistantRecoveryResolve?.(recoveryId);
    // Keep an approved candidate pending until the host confirms the durable save. If autosave
    // fails, the teacher can retry (or discard) instead of leaving an unresolved approval lease.
    if (target.runtimeApprovalId !== undefined) {
      setPendingAssistantChange(pageId, {
        ...target,
        document: adoptedDocument,
        appliedLocally: true,
      });
    } else {
      setPendingAssistantChange(pageId, undefined);
    }
    focusAssistantComposerAfterActionRef.current = true;
    queueMicrotask(() => assistantComposerRef.current?.focus());
    if (replacedDraftChange) {
      updateAssistantMessages(pageId, (current) => [
        ...current,
        {
          id: `${id}:replaced-draft`,
          role: 'assistant',
          text: '确认期间课件结构有变动，已采用的 AI 修改替换了这些变动。',
          translation: localizedCopy(
            'reachDeck.editor.assistant.approvedOverDraftChange',
            '确认期间课件结构有变动，已采用的 AI 修改替换了这些变动。',
          ),
        },
      ]);
    }
    const overwrittenPages = (rebase?.overwrittenPageIds ?? [])
      .map((overwrittenId) => orderedPages.findIndex((page) => page.pageId === overwrittenId) + 1)
      .filter((pageNumber) => pageNumber > 0)
      .join('、');
    if (overwrittenPages.length > 0) {
      updateAssistantMessages(pageId, (current) => [
        ...current,
        {
          id: `${id}:overwritten`,
          role: 'assistant',
          text: `第 ${overwrittenPages} 页在 Decksmith 运行期间的修改已被采用的 AI 修改替换。`,
          translation: localizedCopy(
            'reachDeck.editor.assistant.rebaseOverwrotePages',
            '第 {pages} 页在 Decksmith 运行期间的修改已被采用的 AI 修改替换。',
            { pages: overwrittenPages },
          ),
        },
      ]);
    }
    updateAssistantMessages(pageId, (current) =>
      target.runtimeApprovalId === undefined
        ? [
            ...current,
            {
              id,
              role: 'assistant',
              text: 'Decksmith 修改已写入当前草稿。',
              translation: localizedCopy(
                'reachDeck.editor.assistant.draftUpdated',
                'Decksmith 修改已写入当前草稿。',
              ),
            },
          ]
        : current.map((message) =>
            message.id === target.messageId ? { ...message, approvalPhase: 'saving' } : message,
          ),
    );
  };

  /** Decksmith 是否仍有会被结构改动作废的工作：宿主可见的部分，加上编辑器持有的待审提案。 */
  const decksmithHoldsStructure = (): boolean =>
    decksmithStructureHold ||
    Object.values(pendingAssistantChangesRef.current).some(
      (change) => change?.runtimeApprovalId !== undefined,
    );

  const cancelStructureChange = () => {
    if (structureChangeBusy) return;
    structureChangeConfirmationRef.current = undefined;
    setStructureChangeConfirmation(undefined);
    setStructureChangeError(undefined);
  };

  const confirmStructureChange = async () => {
    const request = structureChangeConfirmationRef.current;
    if (request === undefined || structureChangeBusy) return;
    setStructureChangeBusy(true);
    setStructureChangeError(undefined);
    try {
      for (const [pageId, change] of request.decksmith
        ? Object.entries(pendingAssistantChangesRef.current)
        : []) {
        if (change?.runtimeApprovalId === undefined) continue;
        // 待审提案直接放弃；已批准未落地的提案由宿主让下一次结构保存按「被教师修改替代」结清。
        if (!isApprovedApproval(change.runtimeApprovalId)) {
          await onAssistantDecision?.({
            runtimeApprovalId: change.runtimeApprovalId,
            decision: 'rejected',
          });
        }
        forgetLegacyAssistantRun(pageId, change.legacyHistoryRunId);
        setPendingAssistantChange(pageId, undefined);
        if (change.recoveryId !== undefined) onAssistantRecoveryResolve?.(change.recoveryId);
        updateAssistantMessages(pageId, (current) => [
          ...current,
          {
            id: `local:${++assistantOperationIdRef.current}:system`,
            role: 'assistant',
            text: '页面结构已调整，本次 AI 修改已放弃。',
            translation: localizedCopy(
              'reachDeck.editor.assistant.discardedForStructure',
              '页面结构已调整，本次 AI 修改已放弃。',
            ),
          },
        ]);
      }
      if (request.decksmith) await onReleaseDecksmithStructureHold?.();
      if (request.generatingPageIds.length > 0) {
        await onConfirmGeneratingPageDeletion?.(request.generatingPageIds);
      }
    } catch {
      setStructureChangeError(
        text(
          'reachDeck.editor.structureChange.failed',
          '未能停止 Decksmith 或放弃它的修改，页面结构未改动，请重试。',
        ),
      );
      return;
    } finally {
      setStructureChangeBusy(false);
    }
    structureChangeConfirmationRef.current = undefined;
    setStructureChangeConfirmation(undefined);
    // 等待期间草稿又变了：原改动基于旧草稿，丢弃，由教师重新操作。
    if (draftRef.current !== request.baseDraft) return;
    if (request.history !== undefined) {
      // 撤销/重做自己恢复选中页与焦点，不走下面的新增页聚焦。
      restoreDocumentHistory(request.history, { expected: request.next });
      return;
    }
    commit(request.next, { ...request.options, structureConfirmed: true });
    if (draftRef.current === request.baseDraft) return;
    const before = new Set(request.baseDraft.pages.map((page) => page.pageId));
    const ordered = [...draftRef.current.pages].sort((left, right) => left.order - right.order);
    const focusId =
      ordered.find((page) => !before.has(page.pageId))?.pageId ??
      (ordered.some((page) => page.pageId === activePageIdRef.current)
        ? undefined
        : ordered[0]?.pageId);
    if (focusId !== undefined) activatePage(focusId);
  };

  const discardAssistantChange = async (
    pageId: string | undefined = pendingAssistantChangeKey,
  ): Promise<void> => {
    const target = pageId === undefined ? undefined : pendingAssistantChanges[pageId];
    if (
      disabled ||
      busyAction !== undefined ||
      assistantDecisionBusyPageId !== undefined ||
      target === undefined
    ) {
      return;
    }
    if (activePage === undefined || pageId === undefined) return;
    const id = `local:${++assistantOperationIdRef.current}:system`;
    const recoveryId = target.recoveryId;
    if (target.runtimeApprovalId !== undefined) {
      setAssistantDecisionBusyPageId(pageId);
      try {
        await onAssistantDecision?.({
          runtimeApprovalId: target.runtimeApprovalId,
          decision: 'rejected',
        });
      } catch {
        updateAssistantMessages(pageId, (current) => [
          ...current,
          {
            id,
            role: 'assistant',
            text: '未能确认放弃 AI 修改，已保留该结果，请重试。',
            translation: localizedCopy(
              'reachDeck.editor.assistant.decisionFailed',
              '未能确认放弃 AI 修改，已保留该结果，请重试。',
            ),
          },
        ]);
        return;
      } finally {
        setAssistantDecisionBusyPageId((current) => (current === pageId ? undefined : current));
      }
    }
    forgetLegacyAssistantRun(pageId, target.legacyHistoryRunId);
    setPendingAssistantChange(pageId, undefined);
    focusAssistantComposerAfterActionRef.current = true;
    if (recoveryId !== undefined) onAssistantRecoveryResolve?.(recoveryId);
    updateAssistantMessages(pageId, (current) => [
      ...current,
      {
        id,
        role: 'assistant',
        text: '已放弃本次 AI 修改。',
        translation: localizedCopy('reachDeck.editor.assistant.discarded', '已放弃本次 AI 修改。'),
      },
    ]);
  };

  const cancelAssistantJob = async () => {
    if (onAssistantCancel === undefined || assistantCancelBusyRef.current) return;
    const cancelPageId =
      assistantJobPages === undefined
        ? (assistantActivePageId ?? activePageIdRef.current)
        : activePageIdRef.current;
    if (cancelPageId === undefined) return;
    const cancelledOperationId = assistantOperationByPageRef.current[cancelPageId];
    const topicVersion = assistantTopicVersionsRef.current[cancelPageId];
    const topicId = assistantTopicId(cancelPageId);
    const frozenRequest = assistantRequestsRef.current[cancelPageId]?.request;
    const userMessageId = assistantJobUserMessageIdsByPage?.[cancelPageId];
    const historyPrompt = currentAssistantTopicMessages(
      assistantMessagesRef.current[cancelPageId] ?? [],
    ).find((message) => message.role === 'user' && message.id === userMessageId)?.text;
    const request =
      frozenRequest ??
      (historyPrompt === undefined
        ? undefined
        : {
            pageId: cancelPageId,
            prompt: historyPrompt,
            includeCurrentPage: true,
            mentionedPageIds: [],
          });
    let releaseCancel!: () => void;
    assistantCancelGatesRef.current[cancelPageId] = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    assistantCancelBusyRef.current = true;
    setAssistantCancelBusy(true);
    try {
      await onAssistantCancel(cancelPageId);
      if (assistantOperationByPageRef.current[cancelPageId] === cancelledOperationId) {
        const operationId = ++assistantOperationIdRef.current;
        assistantOperationByPageRef.current[cancelPageId] = operationId;
        delete assistantRequestsRef.current[cancelPageId];
        setAssistantPageBusy(cancelPageId, false);
        setAssistantPageProgress(cancelPageId, undefined);
        const matchingHistoryInTopic =
          frozenRequest === undefined &&
          userMessageId !== undefined &&
          currentAssistantTopicMessages(assistantMessagesRef.current[cancelPageId] ?? []).some(
            (message) => message.role === 'user' && message.id === userMessageId,
          );
        if (
          assistantTopicVersionsRef.current[cancelPageId] === topicVersion &&
          (assistantTopicId(cancelPageId) === topicId || matchingHistoryInTopic)
        ) {
          setStoppedAssistantRequest(cancelPageId, {
            operationId,
            topicId: assistantTopicId(cancelPageId),
            request,
            userMessageId,
          });
        }
      }
      focusAssistantComposerAfterActionRef.current = true;
    } catch (error) {
      const pageId = cancelPageId;
      if (pageId === undefined) return;
      updateAssistantMessages(pageId, (current) => [
        ...current,
        {
          id: `local:system:${assistantSystemMessageIdRef.current--}`,
          role: 'assistant',
          text: error instanceof Error ? error.message : '取消生成失败，请重试。',
          ...(error instanceof Error
            ? {}
            : {
                translation: localizedCopy(
                  'reachDeck.editor.assistant.cancelFailed',
                  '取消生成失败，请重试。',
                ),
              }),
        },
      ]);
    } finally {
      delete assistantCancelGatesRef.current[cancelPageId];
      releaseCancel();
      assistantCancelBusyRef.current = false;
      setAssistantCancelBusy(false);
    }
  };
  const retryAssistantJob = () => {
    if (
      activePageId === undefined ||
      stoppedAssistantRequest === undefined ||
      stoppedAssistantRequestsRef.current[activePageId] !== stoppedAssistantRequest ||
      !assistantStopped ||
      stoppedRetryRequest === undefined
    )
      return;
    void runAssistantPrompt(undefined, undefined, stoppedRetryRequest);
  };
  const pageNumbersOf = (pageIds: readonly string[]) =>
    pageIds
      .map((pageId) => orderedPages.findIndex((page) => page.pageId === pageId) + 1)
      .filter((pageNumber) => pageNumber > 0)
      .join('、');
  /** Plain-language lines explaining why applying a proposal needs confirmation. */
  const describeAssistantApplyCheck = (check: ReachDeckEditorAssistantApplyCheck): string[] => {
    if (check.expired) {
      return [
        text(
          'reachDeck.editor.assistant.conflictExpired',
          '这份修改建议已超过 2 小时未处理，已失效，请放弃后重新发起。',
        ),
      ];
    }
    const lines: string[] = [];
    for (const conflict of check.conflicts) {
      const pages = pageNumbersOf(conflict.pageIds);
      const origin =
        conflict.holder === undefined ? '' : pageNumbersOf([conflict.holder.originPageId]);
      if (conflict.kind === 'held') {
        lines.push(
          conflict.holder?.state === 'running'
            ? text(
                'reachDeck.editor.assistant.conflictHeldRunning',
                '本修改会改动第 {pages} 页，该页正被第 {origin} 页发起的另一轮 Decksmith 占用（运行中）。',
                { pages, origin },
              )
            : text(
                'reachDeck.editor.assistant.conflictHeldPending',
                '本修改会改动第 {pages} 页，该页正被第 {origin} 页发起的另一轮 Decksmith 占用（有未处理的修改建议）。',
                { pages, origin },
              ),
        );
      } else if (conflict.kind === 'stale') {
        lines.push(
          text(
            'reachDeck.editor.assistant.conflictStale',
            '第 {pages} 页在这份修改生成后已被改动。',
            { pages },
          ),
        );
      } else if (conflict.kind === 'adoption-in-progress') {
        lines.push(
          text(
            'reachDeck.editor.assistant.conflictAdoptionInProgress',
            '第 {origin} 页发起的另一份修改正在保存，它也改动了第 {pages} 页。请等它保存完成后再应用这一份。',
            { pages, origin },
          ),
        );
      } else if (conflict.kind === 'envelope-changed') {
        lines.push(
          text(
            'reachDeck.editor.assistant.conflictEnvelopeChanged',
            '课件的标题、主题或图片等共享资源已被另一份修改更新，这份修改无法再应用，只能放弃后重新发起。',
          ),
        );
      } else {
        lines.push(
          text(
            'reachDeck.editor.assistant.conflictStructureChanged',
            '页面已被新增、删除或调整顺序，这份修改无法再应用，只能放弃。',
          ),
        );
      }
    }
    if (check.overridable) {
      lines.push(
        check.structural
          ? text(
              'reachDeck.editor.assistant.conflictStructural',
              '这份修改会调整页面结构，覆盖后以本修改为准，其他页待处理建议中涉及被删除或移动页面的部分将失效。',
            )
          : text(
              'reachDeck.editor.assistant.conflictOverrideEffect',
              '覆盖后以本修改为准，另一份建议中对这些页的修改将失效。',
            ),
      );
    }
    return lines;
  };
  const activeApplyCheck =
    assistantApplyCheck !== undefined &&
    (assistantApplyCheck.pageId === activePage?.pageId ||
      assistantApplyCheck.pageId === LEGACY_ASSISTANT_RECOVERY_KEY)
      ? assistantApplyCheck
      : undefined;
  const assistantPromptBlocked =
    disabled ||
    busyAction !== undefined ||
    assistantBusy ||
    assistantJobActive ||
    pendingAssistantChange !== undefined;
  const assistantSendBlocked = assistantPromptBlocked || assistantBlockedReason !== undefined;
  const assistantMessagesLoading =
    assistantConnectionState === 'reconnecting' ||
    (assistantHistory?.pageId === activePage?.pageId && assistantHistory?.loading === true);
  useEffect(() => {
    if (!focusAssistantComposerAfterActionRef.current || assistantBusy || assistantJobActive)
      return;
    focusAssistantComposerAfterActionRef.current = false;
    assistantComposerRef.current?.focus();
  }, [assistantBusy, assistantJobActive, pendingAssistantChange]);
  const insertionBlocked = disabled || busyAction !== undefined || structureLocked;
  const selectRightPanelTab = (tab: RightPanelTab) => setRightPanelTab(tab);
  const handleRightPanelTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: RightPanelTab,
  ) => {
    const currentIndex = RIGHT_PANEL_TABS.indexOf(currentTab);
    const nextIndex =
      event.key === 'ArrowRight'
        ? (currentIndex + 1) % RIGHT_PANEL_TABS.length
        : event.key === 'ArrowLeft'
          ? (currentIndex - 1 + RIGHT_PANEL_TABS.length) % RIGHT_PANEL_TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? RIGHT_PANEL_TABS.length - 1
              : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = RIGHT_PANEL_TABS[nextIndex];
    setRightPanelTab(nextTab);
    rightPanelTabRefs.current[nextIndex]?.focus();
  };
  // 插入媒体只对 slide 页有意义，因此挂在属性页的 slide 分支里，与文字/对象格式条并列。
  const mediaInsertToolbar =
    onUploadAuthoringMedia === undefined ? null : (
      <>
        <div
          aria-label={text('reachDeck.editor.media.insertGroup', '插入媒体')}
          className="reach-deck-editor__rich-text-toolbar reach-deck-editor__media-toolbar reach-deck-editor__media-actions"
          role="group"
        >
          <span className="reach-deck-editor__toolbar-scope">
            {text('reachDeck.editor.media.scope', '媒体')}
          </span>
          {(
            [
              ['image', ImageIcon, mediaInputImageRef],
              ['audio', AudioLines, mediaInputAudioRef],
              ['video', Video, mediaInputVideoRef],
            ] as const
          ).map(([kind, Icon, inputRef]) => {
            const labels: Record<Exclude<ReachDeckAuthoringMediaKind, 'attachment'>, string> = {
              image: text('reachDeck.editor.media.insertImage', '插入图片'),
              audio: text('reachDeck.editor.media.insertAudio', '插入音频'),
              video: text('reachDeck.editor.media.insertVideo', '插入视频'),
            };
            const unavailable =
              disabled ||
              busyAction !== undefined ||
              mediaUploadKind !== undefined ||
              structureLocked ||
              activePageLocked ||
              activePage?.sceneType !== 'slide' ||
              activeNativeSlide === undefined;
            return (
              <span className="reach-deck-editor__media-action" key={kind}>
                <button
                  aria-busy={mediaUploadKind === kind || undefined}
                  aria-label={labels[kind]}
                  className="reach-deck-editor__rich-text-button"
                  data-uploading={mediaUploadKind === kind || undefined}
                  disabled={unavailable}
                  onClick={() => inputRef.current?.click()}
                  title={labels[kind]}
                  type="button"
                >
                  <Icon aria-hidden size={15} />
                  <span>{labels[kind]}</span>
                </button>
                <input
                  accept={AUTHORING_MEDIA_ACCEPT[kind]}
                  aria-hidden="true"
                  disabled={unavailable}
                  hidden
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (file !== undefined) void uploadAuthoringMedia(kind, file);
                  }}
                  ref={inputRef}
                  tabIndex={-1}
                  type="file"
                />
              </span>
            );
          })}
        </div>
        <span aria-live="polite" className="sr-only">
          {mediaUploadKind === undefined
            ? ''
            : text('reachDeck.editor.media.uploading', '正在上传媒体')}
        </span>
        {mediaUploadError === undefined ? null : (
          <p className="reach-deck-editor__media-error" role="alert">
            {mediaUploadError}
          </p>
        )}
      </>
    );
  const editableQuizCanvasActive =
    activePage?.sceneType === 'quiz' && !disabled && busyAction === undefined && !activePageLocked;
  // 按住预览层：幻灯片 / 互动页叠在 player-stack 里；可编辑的测验页不走 player-stack
  // （渲染的是 ReachDeckQuizCanvas），所以测验分支也要单独挂上同一个预览层。
  const assistantPreviewLayer =
    assistantPreviewing && assistantPreviewDocument !== undefined ? (
      <div aria-hidden="true" className="reach-deck-editor__player-preview-layer" inert>
        <ReachDeckPlayer
          locale={locale}
          activePageId={assistantPreviewDocument.pageId}
          currentTime={0}
          document={assistantPreviewDocument.document}
          enableWheelPageNavigation={false}
          quizGradingMode="trial"
          hideNativeDiagnostics
          nativeResourceUrlsById={assistantPreviewDocument.resourceUrls}
          playing={false}
          showInteractiveNarrationBar={false}
          showStaticSlideWhenNotPlaying
          showNativeTimeline={false}
          translate={translate}
        />
      </div>
    ) : null;
  return (
    <section
      aria-busy={busyAction !== undefined}
      aria-label={text('reachDeck.editor.label', 'Reach Deck 编辑器')}
      className="reach-deck-editor"
      data-deck-command-context="canvas"
      onClickCapture={(event) => {
        commandContextRef.current = resolveEditorCommandContext(
          event.target,
          commandContextRef.current,
        );
        activeReachDeckEditorInstance = editorInstanceRef.current;
      }}
      onFocusCapture={(event) => {
        commandContextRef.current = resolveEditorCommandContext(
          event.target,
          commandContextRef.current,
        );
        activeReachDeckEditorInstance = editorInstanceRef.current;
      }}
      onPointerDownCapture={(event) => {
        commandContextRef.current = resolveEditorCommandContext(
          event.target,
          commandContextRef.current,
        );
        activeReachDeckEditorInstance = editorInstanceRef.current;
      }}
      onContextMenuCapture={(event) => {
        commandContextRef.current = resolveEditorCommandContext(
          event.target,
          commandContextRef.current,
        );
        activeReachDeckEditorInstance = editorInstanceRef.current;
        // Preventing the native context menu does not transfer focus. Move it off a
        // previously focused canvas overlay so subsequent real keyboard/clipboard
        // events belong to the rail as well as the stored command context.
        if (commandContextRef.current === 'pageRail' && event.target instanceof Element) {
          const rail = event.target.closest<HTMLElement>('[data-deck-command-context="pageRail"]');
          const control = event.target.closest<HTMLElement>('[data-page-card], button');
          (control !== null && rail?.contains(control) ? control : rail)?.focus({
            preventScroll: true,
          });
        }
        if (commandContextRef.current === 'canvas' && event.target instanceof Element) {
          const hitElementId = event.target.closest<HTMLElement>('[data-native-v2-element-id]')
            ?.dataset.nativeV2ElementId;
          if (hitElementId === undefined || activePage?.sceneType !== 'slide') return;
          const elementId = activeNativeSlide?.elements.find((element) =>
            nativeElementContainsId(element, hitElementId),
          )?.id;
          if (elementId === undefined) return;
          event.preventDefault();
          const elementIds = selectedElementIdsRef.current.includes(elementId)
            ? selectedElementIdsRef.current
            : [elementId];
          setSelectedElementIds(elementIds);
          setSelectedElementIdState(elementIds.length === 1 ? elementId : undefined);
          const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 216));
          const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 224));
          setElementMenu({ x, y, elementIds, hitElementId });
          setPageMenu(undefined);
          setInsertionMenu(undefined);
        }
      }}
      ref={editorRootRef}
    >
      <div className="reach-deck-editor__controls">
        {mediaSlotError ? <p role="alert">{mediaSlotError}</p> : null}
        {disabled && disabledReason ? (
          <p className="reach-deck-editor__status">{disabledReason}</p>
        ) : null}
        {actionMessage ? (
          <p className="reach-deck-editor__status">
            {typeof actionMessage === 'string' ? actionMessage : renderLocalizedCopy(actionMessage)}
          </p>
        ) : null}

        <div
          className="reach-deck-editor__workspace"
          data-page-rail-collapsed={pageRailCollapsed || undefined}
          data-right-panel-collapsed={rightPanelCollapsed || undefined}
        >
          {/* 收起按钮固定在页面栏右上角；收起后页面栏收成竖条，只保留展开按钮。 */}
          <header className="reach-deck-editor__page-rail-header">
            <div
              aria-hidden={pageRailCollapsed || undefined}
              className="reach-deck-editor__page-rail-header-content"
              inert={pageRailCollapsed}
            >
              {workspacePageRailHeader ?? (
                <span className="reach-deck-editor__page-rail-title">
                  {text('reachDeck.editor.pagesLabel', '幻灯片页面')}
                </span>
              )}
            </div>
            <button
              aria-expanded={!pageRailCollapsed}
              aria-label={
                pageRailCollapsed
                  ? text('reachDeck.editor.expandPageRail', '展开页面列表')
                  : text('reachDeck.editor.collapsePageRail', '收起页面列表')
              }
              className="reach-deck-editor__sidebar-toggle reach-deck-editor__page-rail-toggle"
              onClick={() => setPageRailCollapsed((current) => !current)}
              title={
                pageRailCollapsed
                  ? text('reachDeck.editor.expandPageRail', '展开页面列表')
                  : text('reachDeck.editor.collapsePageRail', '收起页面列表')
              }
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={20} strokeWidth={2.4} />
            </button>
          </header>
          <aside
            aria-hidden={pageRailCollapsed || undefined}
            className="reach-deck-editor__pages"
            data-deck-command-context="pageRail"
            tabIndex={-1}
            aria-label={text('reachDeck.editor.pagesLabel', '幻灯片页面')}
            inert={pageRailCollapsed}
            onPointerCancel={() => updatePageMarquee(undefined)}
            onScroll={() => updatePageMarquee(undefined)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && pageMarqueeRef.current !== undefined) {
                event.preventDefault();
                updatePageMarquee(undefined);
              }
            }}
            onPointerDown={(event: ReactPointerEvent<HTMLElement>) => {
              if (event.button !== 0 || draggingPageIds.length > 0) return;
              const list = event.currentTarget.querySelector('ol');
              if (event.target !== event.currentTarget && event.target !== list) return;
              const marquee: PageMarquee = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                currentX: event.clientX,
                currentY: event.clientY,
                selectedPageIdsAtStart: pageSelection.selectedPageIds,
                additive: pageRailMultiSelectModifier(event),
              };
              event.currentTarget.setPointerCapture?.(event.pointerId);
              updatePageMarquee(marquee);
            }}
            onPointerMove={(event) => {
              const marquee = pageMarqueeRef.current;
              if (marquee === undefined || marquee.pointerId !== event.pointerId) return;
              updatePageMarquee({ ...marquee, currentX: event.clientX, currentY: event.clientY });
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture?.(event.pointerId);
              }
              finishPageMarquee(event.currentTarget, event.pointerId);
            }}
            onContextMenu={(event) => {
              if (insertionBlocked) return;
              const target = event.target;
              if (
                target instanceof Element &&
                target.closest('[data-page-card], [data-insertion-gap]') !== null
              ) {
                return;
              }
              event.preventDefault();
              const lastPage = orderedPages.at(-1);
              openInsertionMenu(
                lastPage === undefined
                  ? { mode: 'before-first' }
                  : { mode: 'insert-after', afterPageId: lastPage.pageId },
                event.clientX,
                event.clientY,
              );
            }}
          >
            {orderedPages.length === 0 ? (
              <button
                className="reach-deck-editor__add-first-page"
                data-insertion-gap="true"
                disabled={insertionBlocked}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  openInsertionMenu({ mode: 'before-first' }, rect.right, rect.top);
                }}
                type="button"
              >
                <Plus aria-hidden="true" size={16} />
                {text('reachDeck.editor.addFirstPage', '添加第一页')}
              </button>
            ) : null}
            <ol
              aria-label={text('reachDeck.editor.pagesLabel', '幻灯片页面')}
              aria-multiselectable="true"
              role="listbox"
            >
              {orderedPages.map((page, index) => (
                <li
                  data-drag-over={dragOverPageId === page.pageId || undefined}
                  data-dragging={draggingPageIds.includes(page.pageId) || undefined}
                  key={page.pageId}
                  role="presentation"
                  onDragEnd={() => {
                    setDraggingPageIds([]);
                    setDragOverPageId(undefined);
                  }}
                  onDragLeave={() =>
                    setDragOverPageId((current) => (current === page.pageId ? undefined : current))
                  }
                  onDragOver={(event) => {
                    if (draggingPageIds.length === 0) return;
                    event.preventDefault();
                    setDragOverPageId(page.pageId);
                    const rail = event.currentTarget.closest<HTMLElement>(
                      '.reach-deck-editor__pages',
                    );
                    if (rail !== null && typeof rail.scrollBy === 'function') {
                      const bounds = rail.getBoundingClientRect();
                      const edge = 36;
                      if (event.clientY < bounds.top + edge) rail.scrollBy({ top: -18 });
                      else if (event.clientY > bounds.bottom - edge) rail.scrollBy({ top: 18 });
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggingPageIds.length > 0) {
                      const selectedIndices = draggingPageIds
                        .map((id) => orderedPages.findIndex((candidate) => candidate.pageId === id))
                        .filter((selectedIndex) => selectedIndex >= 0);
                      const after = index > Math.max(...selectedIndices);
                      commit(
                        reorderReachDeckPages(
                          draftRef.current,
                          draggingPageIds,
                          index + (after ? 1 : 0),
                        ),
                      );
                    }
                    setDraggingPageIds([]);
                    setDragOverPageId(undefined);
                  }}
                >
                  <button
                    aria-label={
                      index === 0
                        ? text('reachDeck.editor.insertBeforeFirst', '在第一页之前插入')
                        : text('reachDeck.editor.insertAfterPage', '在页面 {title} 之后插入', {
                            title: orderedPages[index - 1]?.title ?? '',
                          })
                    }
                    className="reach-deck-editor__insertion-gap"
                    data-insertion-gap="true"
                    disabled={insertionBlocked}
                    onClick={(event) => {
                      if (insertionBlocked) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      openInsertionMenu(
                        index === 0
                          ? { mode: 'before-first' }
                          : {
                              mode: 'insert-after',
                              afterPageId: orderedPages[index - 1]!.pageId,
                            },
                        rect.right,
                        rect.top,
                      );
                    }}
                    onContextMenu={(event) => {
                      if (insertionBlocked) return;
                      event.preventDefault();
                      event.stopPropagation();
                      openInsertionMenu(
                        index === 0
                          ? { mode: 'before-first' }
                          : {
                              mode: 'insert-after',
                              afterPageId: orderedPages[index - 1]!.pageId,
                            },
                        event.clientX,
                        event.clientY,
                      );
                    }}
                    type="button"
                  >
                    <Plus aria-hidden="true" size={14} />
                  </button>
                  <div
                    aria-label={[
                      text('reachDeck.editor.pageNavigatorLabel', '第 {order} 页：{title}', {
                        order: index + 1,
                        title: page.title,
                      }),
                      ...(normalizedBatchStatusByPageId[page.pageId]?.map(
                        (status) => status.accessibleLabel,
                      ) ?? []),
                    ]
                      .filter((label): label is string => label !== undefined)
                      .join('. ')}
                    aria-current={page.pageId === activePage?.pageId ? 'page' : undefined}
                    aria-selected={pageSelection.selectedPageIds.includes(page.pageId)}
                    data-batch-status={
                      normalizedBatchStatusByPageId[page.pageId]
                        ?.map((status) => status.status)
                        .join(' ') || undefined
                    }
                    data-page-card="true"
                    data-page-id={page.pageId}
                    data-selected={pageSelection.selectedPageIds.includes(page.pageId) || undefined}
                    data-locked={isPageLocked(page.pageId) ? 'true' : undefined}
                    draggable={
                      !disabled &&
                      busyAction === undefined &&
                      !structureLocked &&
                      pageMenu === undefined &&
                      insertionMenu === undefined &&
                      !isPageLocked(page.pageId)
                    }
                    onClick={(event) => {
                      selectPageInRail(
                        page.pageId,
                        event.shiftKey
                          ? 'range'
                          : pageRailMultiSelectModifier(event)
                            ? 'toggle'
                            : 'single',
                      );
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      const maxX = Math.max(
                        PAGE_MENU_VIEWPORT_GAP,
                        window.innerWidth - PAGE_MENU_WIDTH - PAGE_MENU_VIEWPORT_GAP,
                      );
                      const x = Math.max(PAGE_MENU_VIEWPORT_GAP, Math.min(event.clientX, maxX));
                      setPageMenu({
                        pageId: page.pageId,
                        x,
                        y: event.clientY,
                      });
                      setInsertionMenu(undefined);
                    }}
                    onDragStart={(event) => {
                      if (pageMenuRef.current !== null) {
                        event.preventDefault();
                        setDraggingPageIds([]);
                        setDragOverPageId(undefined);
                        return;
                      }
                      const pageIds = orderedPages.map((candidate) => candidate.pageId);
                      const selectedPageIds = pageSelection.selectedPageIds.includes(page.pageId)
                        ? pageSelection.selectedPageIds
                        : [page.pageId];
                      if (
                        !canExecuteEditorCommand(
                          'reorder',
                          'pageRail',
                          mediaInsertionStateRef.current,
                          selectedPageIds,
                        )
                      ) {
                        event.preventDefault();
                        return;
                      }
                      if (!pageSelection.selectedPageIds.includes(page.pageId)) {
                        setPageSelection((current) =>
                          reducePageSelection(
                            current,
                            { type: 'select', pageId: page.pageId },
                            pageIds,
                          ),
                        );
                      }
                      setDraggingPageIds(selectedPageIds);
                    }}
                    onKeyDown={(event) => {
                      if (pageRailMultiSelectModifier(event) && event.key.toLowerCase() === 'a') {
                        event.preventDefault();
                        setPageSelection((current) =>
                          reducePageSelection(
                            current,
                            { type: 'all' },
                            orderedPages.map((candidate) => candidate.pageId),
                          ),
                        );
                        return;
                      }
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        const nextIndex = Math.max(
                          0,
                          Math.min(
                            orderedPages.length - 1,
                            index + (event.key === 'ArrowDown' ? 1 : -1),
                          ),
                        );
                        const nextPage = orderedPages[nextIndex];
                        if (nextPage !== undefined) {
                          selectPageInRail(nextPage.pageId, event.shiftKey ? 'range' : 'single');
                          window.requestAnimationFrame(() =>
                            [
                              ...(editorRootRef.current?.querySelectorAll<HTMLElement>(
                                '[data-page-card]',
                              ) ?? []),
                            ]
                              .find((card) => card.dataset.pageId === nextPage.pageId)
                              ?.focus({ preventScroll: true }),
                          );
                        }
                        return;
                      }
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      selectPageInRail(
                        page.pageId,
                        event.shiftKey
                          ? 'range'
                          : pageRailMultiSelectModifier(event)
                            ? 'toggle'
                            : 'single',
                      );
                    }}
                    role="option"
                    tabIndex={0}
                  >
                    <PageThumbnail
                      page={page}
                      resourceMimeTypesById={Object.fromEntries(
                        draft.resources.media.map((resource) => [
                          resource.id,
                          resource.contentType,
                        ]),
                      )}
                      resourceUrlsById={resolvedNativeResourceUrlsById}
                      nativeSlide={
                        draft.schemaVersion === 'reach-deck-document/v2'
                          ? draft.nativeSlides.find((binding) => binding.pageId === page.pageId)
                              ?.slide
                          : undefined
                      }
                      stage={
                        draft.schemaVersion === 'reach-deck-document/v2' ? draft.stage : undefined
                      }
                      themeColors={
                        draft.schemaVersion === 'reach-deck-document/v2'
                          ? draft.resources.themes.find(
                              (theme) => theme.id === draft.defaultThemeId,
                            )?.colors
                          : deckThemeColorRecord(draft.theme)
                      }
                    />
                    <PageLaneIndicators
                      statuses={pageLaneStatusByPageId[page.pageId] ?? {}}
                      text={text}
                    />
                    <span className="reach-deck-editor__page-order">{index + 1}</span>
                    {runningAssistantPages.has(page.pageId) ? (
                      <span
                        aria-label={text(
                          'reachDeck.editor.assistant.pageRunning',
                          'Decksmith 正在修改此页面',
                        )}
                        className="reach-deck-editor__assistant-page-indicator is-running"
                        title={text(
                          'reachDeck.editor.assistant.pageRunning',
                          'Decksmith 正在修改此页面',
                        )}
                      />
                    ) : pendingAssistantPages.has(page.pageId) ? (
                      <span
                        aria-label={text(
                          'reachDeck.editor.assistant.pagePending',
                          '此页面有待处理的 Decksmith 修改',
                        )}
                        className="reach-deck-editor__assistant-page-indicator is-pending"
                        title={text(
                          'reachDeck.editor.assistant.pagePending',
                          '此页面有待处理的 Decksmith 修改',
                        )}
                      />
                    ) : backgroundAssistantPages.has(page.pageId) ? (
                      <span
                        aria-label={text(
                          'reachDeck.editor.assistant.backgroundResult',
                          'Decksmith 已完成此页面的回复',
                        )}
                        className="reach-deck-editor__assistant-page-indicator"
                        title={text(
                          'reachDeck.editor.assistant.backgroundResult',
                          'Decksmith 已完成此页面的回复',
                        )}
                      />
                    ) : null}
                    <span className="reach-deck-editor__page-copy">
                      <span className="sr-only">{page.title}</span>
                      <small>
                        {text(
                          `reachDeck.editor.sceneType.${page.sceneType}`,
                          sceneTypeLabels[page.sceneType],
                        )}
                      </small>
                    </span>
                  </div>
                  {pageMenu?.pageId === page.pageId ? (
                    <div
                      aria-label={text('reachDeck.editor.pageActions', '页面操作 {title}', {
                        title: page.title,
                      })}
                      className="reach-deck-editor__page-menu"
                      popover="manual"
                      ref={pageMenuRef}
                      role="menu"
                      style={{ left: pageMenu.x, top: pageMenuTop }}
                    >
                      <button
                        disabled={
                          !canExecuteEditorCommand(
                            'duplicate',
                            'pageRail',
                            mediaInsertionStateRef.current,
                            pageSelection.selectedPageIds.includes(page.pageId)
                              ? pageSelection.selectedPageIds
                              : [page.pageId],
                          )
                        }
                        title={
                          isPageLocked(page.pageId) || structureLocked
                            ? lockedReasonCopy(page.pageId)
                            : undefined
                        }
                        onClick={() => {
                          duplicatePage(page.pageId);
                          setPageMenu(undefined);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <Copy size={14} /> {text('reachDeck.editor.duplicate', '创建副本')}
                      </button>
                      <button
                        disabled={
                          orderedPages.length === 1 ||
                          !canExecuteEditorCommand(
                            'delete',
                            'pageRail',
                            mediaInsertionStateRef.current,
                            [page.pageId],
                          )
                        }
                        title={
                          isPageLocked(page.pageId) || structureLocked
                            ? lockedReasonCopy(page.pageId)
                            : undefined
                        }
                        onClick={() => {
                          deleteSelectedPages(
                            pageSelection.selectedPageIds.includes(page.pageId)
                              ? pageSelection.selectedPageIds
                              : [page.pageId],
                          );
                          setPageMenu(undefined);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        <Trash2 size={14} /> {text('reachDeck.editor.delete', '删除')}
                      </button>
                    </div>
                  ) : null}
                  {index === orderedPages.length - 1 ? (
                    <button
                      aria-label={text(
                        'reachDeck.editor.insertAfterPage',
                        '在页面 {title} 之后插入',
                        {
                          title: page.title,
                        },
                      )}
                      className="reach-deck-editor__insertion-gap"
                      data-insertion-gap="true"
                      disabled={insertionBlocked}
                      onClick={(event) => {
                        if (insertionBlocked) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        openInsertionMenu(
                          { mode: 'insert-after', afterPageId: page.pageId },
                          rect.right,
                          rect.top,
                        );
                      }}
                      onContextMenu={(event) => {
                        if (insertionBlocked) return;
                        event.preventDefault();
                        event.stopPropagation();
                        openInsertionMenu(
                          { mode: 'insert-after', afterPageId: page.pageId },
                          event.clientX,
                          event.clientY,
                        );
                      }}
                      type="button"
                    >
                      <Plus aria-hidden="true" size={14} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
            {pageMarquee === undefined ? null : (
              <div
                aria-hidden="true"
                className="reach-deck-editor__page-marquee"
                style={{
                  height: Math.abs(pageMarquee.currentY - pageMarquee.startY),
                  left: Math.min(pageMarquee.startX, pageMarquee.currentX),
                  top: Math.min(pageMarquee.startY, pageMarquee.currentY),
                  width: Math.abs(pageMarquee.currentX - pageMarquee.startX),
                }}
              />
            )}
            {insertionMenu === undefined ? null : (
              <div
                aria-label={text('reachDeck.editor.insertionActions', '插入操作')}
                className="reach-deck-editor__insertion-menu reach-deck-editor__page-menu"
                popover="manual"
                data-submenu-side={insertionMenu.submenuSide}
                ref={pageMenuRef}
                role="menu"
                style={{ left: insertionMenu.x, top: pageMenuTop }}
              >
                <div className="reach-deck-editor__page-menu-submenu-trigger" role="none">
                  <button
                    aria-expanded={insertionMenu.openSubmenu === 'new'}
                    aria-haspopup="menu"
                    disabled={insertionBlocked}
                    onClick={() =>
                      setInsertionMenu((current) =>
                        current === undefined
                          ? current
                          : {
                              ...current,
                              openSubmenu: current.openSubmenu === 'new' ? undefined : 'new',
                            },
                      )
                    }
                    role="menuitem"
                    type="button"
                  >
                    <Plus size={14} /> <span>{text('reachDeck.editor.new', '新建')}</span>
                    <ChevronRight size={14} />
                  </button>
                  {insertionMenu.openSubmenu === 'new' ? (
                    <div
                      aria-label={text('reachDeck.editor.chooseNewPageType', '选择新建幻灯片类型')}
                      className="reach-deck-editor__page-submenu"
                      role="menu"
                    >
                      {sceneTypes.map((sceneType) => {
                        return (
                          <button
                            disabled={insertionBlocked}
                            key={sceneType}
                            onClick={() => {
                              addPage(sceneType, insertionMenu.target);
                              setInsertionMenu(undefined);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            {text(
                              `reachDeck.editor.sceneType.${sceneType}`,
                              sceneTypeLabels[sceneType],
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                {onRequestPptxInsert === undefined && onRequestMaicInsert === undefined ? null : (
                  <div className="reach-deck-editor__page-menu-submenu-trigger" role="none">
                    <button
                      aria-expanded={insertionMenu.openSubmenu === 'import'}
                      aria-haspopup="menu"
                      disabled={insertionBlocked}
                      onClick={() =>
                        setInsertionMenu((current) =>
                          current === undefined
                            ? current
                            : {
                                ...current,
                                openSubmenu:
                                  current.openSubmenu === 'import' ? undefined : 'import',
                              },
                        )
                      }
                      role="menuitem"
                      type="button"
                    >
                      <FileUp size={14} /> <span>{text('reachDeck.editor.import', '导入')}</span>
                      <ChevronRight size={14} />
                    </button>
                    {insertionMenu.openSubmenu === 'import' ? (
                      <div
                        aria-label={text('reachDeck.editor.chooseImportType', '选择导入格式')}
                        className="reach-deck-editor__page-submenu"
                        role="menu"
                      >
                        {onRequestPptxInsert === undefined ? null : (
                          <button
                            disabled={insertionBlocked}
                            onClick={() => {
                              onRequestPptxInsert(insertionMenu.target);
                              setInsertionMenu(undefined);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            {text('reachDeck.import.entry.pptxInsert', '上传 PPTX')}
                          </button>
                        )}
                        {onRequestMaicInsert === undefined ? null : (
                          <button
                            disabled={insertionBlocked}
                            onClick={() => {
                              onRequestMaicInsert(insertionMenu.target);
                              setInsertionMenu(undefined);
                            }}
                            role="menuitem"
                            type="button"
                          >
                            {text('reachDeck.import.entry.maicInsert', '从 JSON 导入')}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </aside>

          <main className="reach-deck-editor__preview" ref={previewRef} tabIndex={0}>
            {editableQuizCanvasActive ? (
              <ReachDeckQuizCanvas
                attachmentUploadDisabled={busyAction !== undefined || mediaUploadKind !== undefined}
                resolveAttachmentUrl={resolveAttachmentUrl}
                onUploadAttachment={onUploadAuthoringMedia ? uploadQuizAttachment : undefined}
                activeQuestionIndex={activeQuizQuestionIndex}
                idFactory={idFactory}
                imageUrlsByObjectKey={quizImageUrlsByObjectKey}
                {...(onUploadAuthoringMedia === undefined
                  ? {}
                  : { onUploadInlineImage: uploadQuizInlineImage })}
                onChange={(page, metadata) => updateActivePage(() => page, metadata)}
                onUpdate={updateActivePage}
                onHistoryGroupEnd={closeHistoryGroup}
                onQuestionDelete={(questionId) =>
                  quizQuestionTypeSessionsRef.current.delete(`${activePage.pageId}:${questionId}`)
                }
                onQuestionTypeChange={(question, questionType) => {
                  const key = `${activePage.pageId}:${question.id}`;
                  const changed = convertQuizQuestionTypeWithSession(
                    question,
                    questionType,
                    quizQuestionTypeSessionsRef.current.get(key),
                  );
                  quizQuestionTypeSessionsRef.current.set(key, changed.session);
                  return changed.question;
                }}
                onQuestionUpdate={(question) => {
                  const key = `${activePage.pageId}:${question.id}`;
                  quizQuestionTypeSessionsRef.current.set(
                    key,
                    captureQuizQuestionTypeSession(
                      quizQuestionTypeSessionsRef.current.get(key) ?? {},
                      question,
                    ),
                  );
                }}
                onQuestionIndexChange={(index) => {
                  closeHistoryGroup();
                  setActiveQuizQuestionIndex(index);
                }}
                page={activePage}
                translate={translate}
              />
            ) : activePage ? (
              <div
                className="reach-deck-editor__player-stack"
                data-previewing={assistantPreviewing || undefined}
              >
                {renderClarificationPickBar()}
                {activeGeometryInstance === undefined ? null : (
                  <div className="reach-deck-editor__geometry-mode-overlay">
                    <GeometryAuthoringModeControl
                      disabled={activeGeometryEditingBlocked}
                      mode={activeGeometryMode}
                      onChange={(mode) => {
                        setGeometryModeByPageId((current) => ({
                          ...current,
                          [activePage.pageId]: mode,
                        }));
                        setGeometryAuthoringErrorByPageId((current) => {
                          if (current[activePage.pageId] === undefined) return current;
                          const next = { ...current };
                          delete next[activePage.pageId];
                          return next;
                        });
                      }}
                      translate={translate}
                    />
                  </div>
                )}
                <div
                  className="reach-deck-editor__player-layer"
                  data-animation-demo={animationDemo !== undefined || undefined}
                  // 演示中点击画布只结束演示、回到原编辑画面，不改选元素。
                  onPointerDownCapture={(event) => {
                    if (animationDemo === undefined) return;
                    event.preventDefault();
                    event.stopPropagation();
                    stopAnimationDemo();
                  }}
                >
                  <ReachDeckPlayer
                    key={
                      activeGeometryInstance === undefined
                        ? 'standard-editor-player'
                        : `${activePage.pageId}:${activeGeometryMode}`
                    }
                    locale={locale}
                    activePageId={activePage.pageId}
                    currentTime={currentTime}
                    document={draft}
                    enableWheelPageNavigation={false}
                    // 教师编辑预览：本地判客观题并直接展示参考答案。
                    quizGradingMode="trial"
                    editingNativeTextElementId={
                      inlineTextSession?.native === true ? inlineTextSession.elementId : undefined
                    }
                    hideNativeDiagnostics
                    geometryHostMode={
                      activeGeometryInstance === undefined || activeGeometryEditingBlocked
                        ? 'authoring-trial'
                        : activeGeometryMode === 'trial'
                          ? 'authoring-trial'
                          : 'authoring-edit'
                    }
                    initialRuntimeByPageId={
                      activeGeometryInstance !== undefined &&
                      activeGeometryMode === 'edit' &&
                      !activeGeometryEditingBlocked
                        ? geometryEditRuntimeByPageId
                        : undefined
                    }
                    interactiveMode="authoring"
                    resolveAttachmentUrl={resolveAttachmentUrl}
                    nativeResourceUrlsById={resolvedNativeResourceUrlsById}
                    nativeStageOverlay={
                      <>
                        {clarificationStageOverlay}
                        {mediaSlotOverlay}
                      </>
                    }
                    narrationSeekRequest={narrationSeekRequest}
                    {...(animationDemo === undefined || animationDemo.pageId !== activePage.pageId
                      ? {}
                      : {
                          nativeAnimationPreview: {
                            animation: animationDemo.animation,
                            time: animationDemo.time,
                          },
                        })}
                    onNativeElementTransformChange={
                      disabled || busyAction !== undefined || activePageLocked
                        ? undefined
                        : (elementId, transform) => {
                            setSelectedElementId(elementId);
                            if (activePage === undefined) return;
                            commit(
                              updateReachDeckNativeSlide(
                                draftRef.current,
                                activePage.pageId,
                                (slide) => ({
                                  ...slide,
                                  elements: slide.elements.map((element) =>
                                    element.id === elementId ? { ...element, transform } : element,
                                  ),
                                }),
                              ),
                              { historyGroup: activeHistoryGroupRef.current },
                            );
                          }
                    }
                    onNativeElementTransformEnd={() => {
                      activeHistoryGroupRef.current = undefined;
                      closeHistoryGroup();
                    }}
                    onNativeElementTransformStart={(elementId) => {
                      activeHistoryGroupRef.current = `transform:${activePage?.pageId ?? ''}:${elementId}`;
                    }}
                    onCurrentTimeChange={setCurrentTime}
                    onGeometryEditProposal={
                      activeGeometryEditingBlocked ? undefined : handleGeometryEditProposal
                    }
                    onInteractiveComponentFocus={(focus) =>
                      onInteractiveComponentFocusChange?.({
                        pageId: focus.pageId,
                        componentId: focus.componentId,
                        label: focus.label,
                        ...(focus.detail === undefined ? {} : { detail: focus.detail }),
                      })
                    }
                    onInteractiveEmptyAction={() => {
                      setRightPanelCollapsed(false);
                      setRightPanelTab('decksmith');
                      requestAnimationFrame(() => assistantComposerRef.current?.focus());
                    }}
                    {...(disabled || onInteractiveHtmlUpload === undefined
                      ? {}
                      : { onInteractiveUploadAction: onInteractiveHtmlUpload })}
                    onPlayingChange={setPlaying}
                    onPlaybackRateChange={setPlaybackRate}
                    playbackRate={playbackRate}
                    {...(disabled || busyAction !== undefined || activePageLocked
                      ? {}
                      : {
                          onElementSelect: (elementId: string | undefined) => {
                            if (elementId === undefined && restoringHistorySelectionRef.current)
                              return;
                            restoringHistorySelectionRef.current = false;
                            window.clearTimeout(restoringHistorySelectionTimerRef.current);
                            // 点选作答：点中候选只选中并等待确认，右侧仍停在 Decksmith 面板。
                            const pickTarget = clarificationPickTarget(elementId);
                            if (pickTarget !== undefined) {
                              chooseClarificationCandidate(pickTarget);
                              return;
                            }
                            setPendingClarificationPick(undefined);
                            setSelectedElementId(elementId);
                          },
                          onElementsSelect: (elementIds: string[]) => {
                            if (elementIds.length === 0 && restoringHistorySelectionRef.current)
                              return;
                            restoringHistorySelectionRef.current = false;
                            window.clearTimeout(restoringHistorySelectionTimerRef.current);
                            const pickTarget =
                              elementIds.length === 1
                                ? clarificationPickTarget(elementIds[0])
                                : undefined;
                            if (pickTarget !== undefined) {
                              chooseClarificationCandidate(pickTarget);
                              return;
                            }
                            // 多选或选中非候选：选区已不是待确认的候选，撤下"用这个"。
                            setPendingClarificationPick(undefined);
                            setSelectedElementIds(elementIds);
                            setSelectedElementIdState(
                              elementIds.length === 1 ? elementIds[0] : undefined,
                            );
                            setSelectedAnimationId(undefined);
                            if (elementIds.length > 0) setRightPanelTab('properties');
                          },
                        })}
                    onPageChange={(page) => {
                      safelyActivatePage(page.pageId);
                    }}
                    onRuntimeStateChange={(pageId: string, state: ReachDeckSceneRuntimeState) => {
                      if (
                        activeGeometryInstance === undefined ||
                        (geometryModeByPageId[pageId] ?? 'edit') !== 'edit'
                      )
                        return;
                      setGeometryEditRuntimeByPageId((current) =>
                        current[pageId] === state ? current : { ...current, [pageId]: state },
                      );
                    }}
                    selectedElementId={activePageLocked ? undefined : selectedElementId}
                    playing={assistantPreviewing ? false : playing}
                    showInteractiveNarrationBar={false}
                    showStaticSlideWhenNotPlaying
                    showNativeTimeline={false}
                    translate={translate}
                    {...(disabled || busyAction !== undefined || activePageLocked
                      ? {}
                      : {
                          editingNativeTableCellId: inlineTextSession?.cellId,
                          onNativeTextFrameDoubleClick: (elementId: string, cellId?: string) => {
                            const element = activeNativeSlide?.elements.find(
                              (candidate) => candidate.id === elementId,
                            );
                            if (element?.type === 'table' && cellId !== undefined) {
                              const cell = element.rows
                                .flatMap((row) => row.cells)
                                .find((candidate) => candidate.id === cellId);
                              if (cell === undefined) return;
                              setSelectedElementId(elementId);
                              setInlineTextSession({
                                elementId,
                                cellId,
                                native: true,
                                original: cell.text.doc,
                                draft: cell.text.doc,
                              });
                              return;
                            }
                            if (
                              (element?.type !== 'shape' && element?.type !== 'textFrame') ||
                              element.text === undefined
                            ) {
                              return;
                            }
                            setSelectedElementId(elementId);
                            setInlineTextSession({
                              elementId,
                              native: true,
                              original: element.text.doc,
                              draft: element.text.doc,
                            });
                          },
                          onNativeBlankCanvasDoubleClick: (point: { x: number; y: number }) => {
                            if (activePage.sceneType !== 'slide') return;
                            const result = addEmptyReachDeckTextFrame(
                              draftRef.current,
                              activePage.pageId,
                              point,
                              idFactory,
                            );
                            if (result.elementId === undefined) return;
                            const element =
                              result.document.schemaVersion === 'reach-deck-document/v2'
                                ? result.document.nativeSlides
                                    .find((binding) => binding.pageId === activePage.pageId)
                                    ?.slide.elements.find(
                                      (candidate) => candidate.id === result.elementId,
                                    )
                                : undefined;
                            if (element?.type !== 'textFrame') return;
                            commit(result.document);
                            setSelectedElementId(element.id);
                            setInlineTextSession({
                              createdFromBlankCanvas: true,
                              elementId: element.id,
                              native: true,
                              original: element.text.doc,
                              draft: element.text.doc,
                            });
                          },
                          renderEditingNativeTextFrame: () =>
                            inlineTextSession === undefined ? null : (
                              <RichTextElementEditor
                                inline
                                label={text('reachDeck.editor.canvasText', '画布文本')}
                                onCancel={() => {
                                  if (inlineTextSession.createdFromBlankCanvas === true) {
                                    finishInlineTextEditing();
                                  } else {
                                    setInlineTextSession(undefined);
                                  }
                                }}
                                onChange={(doc) =>
                                  setInlineTextSession((current) =>
                                    current === undefined ? current : { ...current, draft: doc },
                                  )
                                }
                                onDone={finishInlineTextEditing}
                                toolbarTarget={richTextToolbarTarget}
                                translate={translate}
                                value={inlineTextSession.draft}
                              />
                            ),
                        })}
                  />
                </div>
                {assistantPreviewLayer}
              </div>
            ) : null}
            {editableQuizCanvasActive ? assistantPreviewLayer : null}
            {activePage?.sceneType === 'interactive' &&
            activeInteractiveNarrationModel !== undefined ? (
              <InteractiveNarrationStatusTrack
                disabled={activeInteractiveNarrationLocked}
                model={activeInteractiveNarrationModel}
                onSaveAndGenerate={
                  onSaveInteractivePageNarrationAndGenerate === undefined
                    ? undefined
                    : saveActiveInteractiveNarration
                }
                onPlaybackRateChange={setPlaybackRate}
                pageId={activePage.pageId}
                playbackRate={playbackRate}
                saveBlockedReason={generationBlockedReason}
                saving={activeInteractiveNarrationSnapshot?.saving === true}
                translate={translate}
              />
            ) : null}
            {activePage?.sceneType === 'slide' && activeNativeSlide !== undefined ? (
              // 时间轴作为常驻工具栏：不再由外层开关卸载，收起/展开由其自身 header 控制。
              <ReachDeckTimeline
                currentTime={currentTime}
                disabled={disabled || busyAction !== undefined || activePageLocked}
                generationStatus={
                  localGenerationStatus?.phase === 'narration' ? localGenerationStatus : undefined
                }
                idFactory={idFactory}
                onAnimationCreated={startAnimationDemo}
                onChange={(nextSlide) =>
                  commit(
                    updateReachDeckNativeSlide(
                      draftRef.current,
                      activePage.pageId,
                      () => nextSlide,
                    ),
                    { historyGroup: activeHistoryGroupRef.current },
                  )
                }
                onInteractionEnd={() => {
                  activeHistoryGroupRef.current = undefined;
                  closeHistoryGroup();
                }}
                onInteractionStart={(animationId) => {
                  activeHistoryGroupRef.current = `timeline:${activePage.pageId}:${animationId}`;
                }}
                onPlayingChange={setPlaying}
                onPlaybackRateChange={setPlaybackRate}
                onOpenNarrationPanel={
                  activeNarrationRegeneratable || activeNarrationNeedsManualReview
                    ? () => {
                        setRightPanelCollapsed(false);
                        setRightPanelTab('narration');
                        setFocusNarrationRegenerateRequested(!activeNarrationNeedsManualReview);
                      }
                    : undefined
                }
                // 有统一重新生成弹窗时，失败浮层也走弹窗并预勾选失败的通道，让教师看清会重做什么。
                onRegenerateNarration={
                  !activeNarrationRegeneratable
                    ? undefined
                    : onRequestRegenerationPage !== undefined
                      ? () =>
                          onRequestRegenerationPage(activePage.pageId, {
                            channels: failedNarrationLanes(localGenerationStatus?.affectedLanes),
                          })
                      : onRegeneratePageNarration === undefined
                        ? undefined
                        : () => onRegeneratePageNarration(activePage.pageId)
                }
                regenerateNarrationOpensDialog={onRequestRegenerationPage !== undefined}
                onSelectedAnimationChange={(animationId) => {
                  setSelectedAnimationId(animationId);
                  if (animationId !== undefined) setRightPanelTab('properties');
                }}
                onSeek={(time) => {
                  const limit = activeNativeSlide.duration ?? Number.POSITIVE_INFINITY;
                  const next = Math.max(0, Math.min(limit, time));
                  setCurrentTime(next);
                  narrationSeekRequestIdRef.current += 1;
                  setNarrationSeekRequest({
                    id: narrationSeekRequestIdRef.current,
                    pageId: activePage.pageId,
                    time: next,
                  });
                }}
                onSelectElement={
                  activePageLocked
                    ? () => undefined
                    : (elementId) => {
                        setSelectedElementIdState(elementId);
                        setSelectedElementIds([elementId]);
                        setRightPanelTab('properties');
                      }
                }
                playing={playing}
                playbackRate={playbackRate}
                selectedAnimationId={selectedAnimationId}
                selectedElementId={selectedElementId}
                slide={activeNativeSlide}
                translate={translate}
              />
            ) : null}
            {localGenerationStatus?.phase === 'layout' ||
            (activePageLocked && !previewableLockedPages.has(activePage?.pageId ?? '')) ? (
              <div
                aria-live="polite"
                className="reach-deck-editor__generating-overlay"
                data-failed={localGenerationStatus?.state === 'failed' || undefined}
                role={localGenerationStatus?.state === 'failed' ? 'alert' : 'status'}
              >
                {localGenerationStatus?.state === 'failed' ? (
                  <>
                    <TriangleAlert aria-hidden size={38} />
                    <p>
                      {localGenerationStatus.message ??
                        text('reachDeck.editor.generation.layoutFailed', '页面生成失败')}
                    </p>
                    {localGenerationStatus.hint === undefined ? null : (
                      <p className="reach-deck-editor__generating-hint">
                        {localGenerationStatus.hint}
                      </p>
                    )}
                    {(onRegeneratePage === undefined && onRequestRegenerationPage === undefined) ||
                    activePage === undefined ? null : (
                      // 版面失败的页没有可用的讲稿/动画，重新生成会连同讲稿、音频与动画一起重做。
                      // 有统一弹窗时打开它并预勾选这些内容，与右上角“重新生成本页”同一入口。
                      <button
                        disabled={busyAction !== undefined || generationBlockedReason !== undefined}
                        onClick={() => {
                          if (onRequestRegenerationPage !== undefined)
                            onRequestRegenerationPage(activePage.pageId, {
                              channels: ['layout', 'narration', 'audio', 'animation'],
                            });
                          else void retryLayoutGeneration();
                        }}
                        title={
                          generationBlockedReason ??
                          text(
                            'reachDeck.editor.regeneratePageWholeHint',
                            '重新生成本页版面，并连同讲稿、音频与动画一起重做',
                          )
                        }
                        type="button"
                      >
                        <RefreshCw size={15} />
                        {onRequestRegenerationPage !== undefined
                          ? text('reachDeck.editor.regeneratePageWithOptions', '重新生成本页…')
                          : text('reachDeck.editor.regeneratePage', '重新生成本页')}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <span aria-hidden className="reach-deck-editor__generating-spinner" />
                    <p>{localGenerationStatus?.message ?? lockedReasonCopy(activePage?.pageId)}</p>
                  </>
                )}
              </div>
            ) : null}
            {activePage !== undefined ? (
              <div className="reach-deck-editor__canvas-corner">
                <div className="reach-deck-editor__canvas-corner-actions">
                  {onRegeneratePage === undefined &&
                  onRequestRegenerationPage === undefined &&
                  workspaceCanvasAction === undefined ? null : (
                    <div className="reach-deck-editor__canvas-corner-row">
                      {workspaceCanvasAction}
                      {onRegeneratePage === undefined &&
                      onRequestRegenerationPage === undefined ? null : (
                        <button
                          aria-label={text('reachDeck.editor.regeneratePage', '重新生成本页')}
                          className="reach-deck-editor__regenerate-page"
                          disabled={
                            disabled ||
                            busyAction !== undefined ||
                            activePageLocked ||
                            generationBlockedReason !== undefined
                          }
                          onClick={() => {
                            if (onRequestRegenerationPage !== undefined)
                              onRequestRegenerationPage(activePage.pageId);
                            else void retryLayoutGeneration();
                          }}
                          title={
                            generationBlockedReason ??
                            text('reachDeck.editor.regeneratePage', '重新生成本页')
                          }
                          type="button"
                        >
                          <RefreshCw size={15} />
                        </button>
                      )}
                    </div>
                  )}
                  <div
                    aria-label={text('reachDeck.editor.documentHistory', '课件历史')}
                    className="reach-deck-editor__document-history"
                    role="group"
                  >
                    <button
                      aria-label={text('reachDeck.editor.undoDocument', '撤销课件修改')}
                      disabled={
                        disabled || documentHistoryDisabled || historyRef.current.past.length === 0
                      }
                      onClick={undoDocument}
                      title={text('reachDeck.editor.undoDocumentHint', '撤销课件修改 (Ctrl/Cmd+Z)')}
                      type="button"
                    >
                      <Undo2 aria-hidden size={15} />
                    </button>
                    <button
                      aria-label={text('reachDeck.editor.redoDocument', '重做课件修改')}
                      disabled={
                        disabled ||
                        documentHistoryDisabled ||
                        historyRef.current.future.length === 0
                      }
                      onClick={redoDocument}
                      title={text(
                        'reachDeck.editor.redoDocumentHint',
                        '重做课件修改 (Ctrl/Cmd+Shift+Z)',
                      )}
                      type="button"
                    >
                      <Redo2 aria-hidden size={15} />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </main>

          <aside
            aria-label={text('reachDeck.editor.rightPanel', '编辑侧栏')}
            className="reach-deck-editor__properties"
            data-collapsed={rightPanelCollapsed || undefined}
          >
            {/* 规范 02 §T4：页签条最右是收起按钮；收起后面板变为竖条，只保留展开按钮。
                宿主命令条（如有）单独占一行，并随面板收起隐藏。 */}
            <div className="reach-deck-editor__right-panel-header">
              {workspaceCommandBar === undefined ? null : (
                <div
                  aria-hidden={rightPanelCollapsed || undefined}
                  className="reach-deck-editor__workspace-command-bar"
                  inert={rightPanelCollapsed}
                >
                  <div className="reach-deck-editor__host-command-bar">{workspaceCommandBar}</div>
                </div>
              )}
              <div
                aria-hidden={rightPanelCollapsed || undefined}
                className="reach-deck-editor__right-panel-header-content"
                inert={rightPanelCollapsed}
              >
                <div
                  aria-label={text('reachDeck.editor.rightPanelTabs', '编辑侧栏视图')}
                  className="reach-deck-editor__right-tabs"
                  role="tablist"
                >
                  {RIGHT_PANEL_TABS.map((tab, index) => {
                    const labels: Record<RightPanelTab, string> = {
                      decksmith: 'Decksmith',
                      properties: text('reachDeck.editor.propertiesTab', '属性'),
                      narration: text('reachDeck.editor.narrationTab', '讲稿'),
                    };
                    return (
                      <button
                        aria-controls={`reach-deck-right-panel-${tab}`}
                        aria-selected={rightPanelTab === tab}
                        id={`reach-deck-right-tab-${tab}`}
                        key={tab}
                        onClick={() => selectRightPanelTab(tab)}
                        onKeyDown={(event) => handleRightPanelTabKeyDown(event, tab)}
                        ref={(node) => {
                          rightPanelTabRefs.current[index] = node;
                        }}
                        role="tab"
                        tabIndex={rightPanelTab === tab ? 0 : -1}
                        type="button"
                      >
                        {labels[tab]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                aria-expanded={!rightPanelCollapsed}
                aria-label={
                  rightPanelCollapsed
                    ? text('reachDeck.editor.expandRightPanel', '展开编辑侧栏')
                    : text('reachDeck.editor.collapseRightPanel', '收起编辑侧栏')
                }
                className="reach-deck-editor__sidebar-toggle reach-deck-editor__right-panel-toggle"
                onClick={() => setRightPanelCollapsed((current) => !current)}
                title={
                  rightPanelCollapsed
                    ? text('reachDeck.editor.expandRightPanel', '展开编辑侧栏')
                    : text('reachDeck.editor.collapseRightPanel', '收起编辑侧栏')
                }
                type="button"
              >
                <ChevronRight aria-hidden="true" size={20} strokeWidth={2.4} />
              </button>
              {workspaceRightPanelAction === undefined ? null : (
                <div
                  aria-hidden={rightPanelCollapsed || undefined}
                  className="reach-deck-editor__right-panel-action"
                  inert={rightPanelCollapsed}
                >
                  {workspaceRightPanelAction}
                </div>
              )}
            </div>
            <div
              aria-hidden={rightPanelCollapsed || undefined}
              aria-labelledby="reach-deck-right-tab-decksmith"
              className="reach-deck-editor__right-panel"
              hidden={rightPanelTab !== 'decksmith'}
              id="reach-deck-right-panel-decksmith"
              inert={rightPanelCollapsed}
              role="tabpanel"
            >
              {onAssistantPrompt ? (
                <section aria-label="Decksmith" className="reach-deck-editor__assistant">
                  <header>
                    <span>
                      <Bot size={17} />
                    </span>
                    <div className="reach-deck-editor__assistant-identity">
                      <strong>Decksmith</strong>
                    </div>
                    <div className="reach-deck-editor__assistant-history-actions">
                      <button
                        aria-label={text('reachDeck.editor.assistant.newTopic', '新话题')}
                        disabled={
                          assistantPromptBlocked ||
                          onAssistantNewTopic === undefined ||
                          assistantControlBusy !== undefined
                        }
                        onClick={() => void runAssistantControl('new-topic')}
                        title={text('reachDeck.editor.assistant.newTopic', '新话题')}
                        type="button"
                      >
                        <Plus aria-hidden size={13} />
                      </button>
                      <button
                        aria-label={text(
                          'reachDeck.editor.assistant.deleteCurrentPage',
                          '清除当前对话',
                        )}
                        className="reach-deck-editor__assistant-clear-conversation"
                        disabled={
                          assistantPromptBlocked ||
                          onAssistantDeleteConversation === undefined ||
                          assistantControlBusy !== undefined
                        }
                        onClick={() => void runAssistantControl('delete')}
                        title={text('reachDeck.editor.assistant.deleteCurrentPage', '清除当前对话')}
                        type="button"
                      >
                        <Trash2 aria-hidden size={13} />
                      </button>
                    </div>
                  </header>
                  {legacyRecoveryMessage !== undefined &&
                  (legacyPendingAssistantChange !== undefined ||
                    (legacyRecoveryMessage.runtimeApprovalId !== undefined &&
                      isApplyTerminalApproval(legacyRecoveryMessage.runtimeApprovalId))) ? (
                    <aside
                      aria-label={text(
                        'reachDeck.editor.assistant.moduleRecovery',
                        '未知页面的历史恢复结果',
                      )}
                      className="reach-deck-editor__assistant-module-recovery"
                    >
                      <strong>
                        {text(
                          'reachDeck.editor.assistant.moduleRecovery',
                          '未知页面的历史恢复结果',
                        )}
                      </strong>
                      {legacyRecoveryMessage.changeSummary === undefined ? null : (
                        <span
                          className="reach-deck-editor__assistant-change-summary"
                          data-change-summary-status={legacyRecoveryMessage.changeSummary.status}
                        >
                          <strong>
                            {legacyRecoveryMessage.changeSummary.status === 'grounded'
                              ? text(
                                  'reachDeck.editor.assistant.actualChanges',
                                  '实际变更（基于文档差异）',
                                )
                              : text('reachDeck.editor.assistant.historicalResult', '历史结果')}
                          </strong>
                          {legacyRecoveryMessage.changeSummary.status === 'grounded'
                            ? formatGroundedAssistantChangeSummary(
                                legacyRecoveryMessage.changeSummary,
                                text,
                              )
                            : text(
                                'reachDeck.editor.assistant.historicalSummaryUnavailable',
                                '无可用的结构化实际变更摘要。',
                              )}
                        </span>
                      )}
                      <p>
                        {legacyRecoveryMessage.runtimeApprovalId !== undefined &&
                        isApplyTerminalApproval(legacyRecoveryMessage.runtimeApprovalId)
                          ? text(
                              'reachDeck.editor.assistant.applyConfirmationTerminal',
                              '内容已保存，但该修改无法完成应用确认，请重新发起修改或联系管理员。',
                            )
                          : legacyRecoveryMessage.translation
                            ? renderLocalizedCopy(legacyRecoveryMessage.translation)
                            : legacyRecoveryMessage.text}
                        {legacyRecoveryMessage.suffixTranslation
                          ? renderLocalizedCopy(legacyRecoveryMessage.suffixTranslation)
                          : null}
                      </p>
                      {legacyPendingAssistantChange !== undefined ? (
                        <div
                          aria-label={text(
                            'reachDeck.editor.assistant.confirmation',
                            'AI 修改确认',
                          )}
                          className="reach-deck-editor__assistant-confirm-actions"
                          role="group"
                        >
                          {pendingAssistantChangeKey === LEGACY_ASSISTANT_RECOVERY_KEY &&
                          assistantPreviewDocument !== undefined ? (
                            <button
                              aria-label={text(
                                'reachDeck.editor.assistant.previewHold',
                                '按住预览修改后的页面',
                              )}
                              className="reach-deck-editor__assistant-preview-hold"
                              disabled={
                                disabled ||
                                busyAction !== undefined ||
                                assistantDecisionBusyPageId !== undefined
                              }
                              ref={setAssistantPreviewButton}
                              type="button"
                            >
                              {text('reachDeck.editor.assistant.previewHold', '按住预览')}
                            </button>
                          ) : null}
                          {(legacyPendingAssistantChange.stale !== true ||
                            canRetryStaleApprovedLegacyChange) &&
                          legacyPendingAssistantChange.document !== undefined ? (
                            <button
                              aria-label={
                                canRetryStaleApprovedLegacyChange
                                  ? text('reachDeck.editor.assistant.retrySave', '重试确认应用')
                                  : text('reachDeck.editor.assistant.apply', '应用修改')
                              }
                              className="reach-deck-editor__assistant-apply"
                              disabled={
                                disabled ||
                                busyAction !== undefined ||
                                assistantDecisionBusyPageId !== undefined
                              }
                              onClick={() =>
                                void applyAssistantChange(LEGACY_ASSISTANT_RECOVERY_KEY)
                              }
                              type="button"
                            >
                              {canRetryStaleApprovedLegacyChange
                                ? text('reachDeck.editor.assistant.retrySave', '重试确认应用')
                                : text('reachDeck.editor.assistant.apply', '应用修改')}
                            </button>
                          ) : null}
                          {!legacyPendingAssistantChange.appliedLocally &&
                          (legacyPendingAssistantChange.runtimeApprovalId === undefined ||
                            !isApprovedApproval(legacyPendingAssistantChange.runtimeApprovalId)) ? (
                            <button
                              aria-label={text(
                                'reachDeck.editor.assistant.discardRecovery',
                                '放弃恢复结果',
                              )}
                              disabled={
                                disabled ||
                                busyAction !== undefined ||
                                assistantDecisionBusyPageId !== undefined
                              }
                              onClick={() =>
                                void discardAssistantChange(LEGACY_ASSISTANT_RECOVERY_KEY)
                              }
                              type="button"
                            >
                              {text('reachDeck.editor.assistant.discardRecovery', '放弃恢复结果')}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </aside>
                  ) : null}
                  <AssistantConversation
                    loading={assistantMessagesLoading}
                    loadingOverlay={
                      assistantMessagesLoading ? (
                        <div
                          aria-busy="true"
                          className="reach-deck-editor__assistant-loading-overlay"
                          data-decksmith-connection-state={
                            assistantConnectionState === 'reconnecting' ? 'reconnecting' : undefined
                          }
                          role="status"
                        >
                          <BrandLoader size="lg" />
                          <span>
                            {assistantConnectionState === 'reconnecting'
                              ? text(
                                  'reachDeck.editor.assistant.reconnecting',
                                  '连接中断，正在重连…',
                                )
                              : text(
                                  'reachDeck.editor.assistant.loadingHistory',
                                  '正在加载本页对话…',
                                )}
                          </span>
                          {assistantJobActive && onAssistantCancel !== undefined ? (
                            <button
                              aria-label={text('reachDeck.editor.assistant.cancel', '取消生成')}
                              className="reach-deck-editor__assistant-cancel"
                              disabled={assistantCancelBusy}
                              onClick={() => void cancelAssistantJob()}
                              title={text('reachDeck.editor.assistant.cancel', '取消生成')}
                              type="button"
                            >
                              <Square aria-hidden size={12} />
                            </button>
                          ) : null}
                        </div>
                      ) : null
                    }
                  >
                    {assistantHistory !== undefined &&
                    assistantHistory.pageId === activePage?.pageId &&
                    assistantHistory.hasOlder ? (
                      <button
                        className="reach-deck-editor__assistant-load-older"
                        aria-busy={
                          assistantHistory.loadingOlder || assistantControlBusy === 'older'
                        }
                        disabled={
                          assistantHistory.loadingOlder || assistantControlBusy !== undefined
                        }
                        onClick={() => void runAssistantControl('older')}
                        type="button"
                      >
                        {assistantHistory.loadingOlder || assistantControlBusy === 'older' ? (
                          <BrandLoader size="sm" />
                        ) : null}
                        {assistantHistory.loadingOlder || assistantControlBusy === 'older'
                          ? text('reachDeck.editor.assistant.loadingOlder', '正在加载更早消息…')
                          : text('reachDeck.editor.assistant.loadOlder', '加载更早消息')}
                      </button>
                    ) : null}
                    {assistantMessages.map((message) => (
                      <article
                        className={`reach-deck-editor__assistant-message is-${message.role}`}
                        {...(message.capacityState === undefined
                          ? {}
                          : { 'data-decksmith-capacity-state': message.capacityState })}
                        key={message.id}
                      >
                        {message.role === 'boundary' ? (
                          <span className="reach-deck-editor__assistant-boundary" role="separator">
                            {message.translation
                              ? renderLocalizedCopy(message.translation)
                              : message.text}
                          </span>
                        ) : message.changeSummary === undefined ? null : (
                          <span
                            className="reach-deck-editor__assistant-change-summary"
                            data-change-summary-status={message.changeSummary.status}
                          >
                            <strong>
                              {message.changeSummary.status === 'grounded'
                                ? text(
                                    'reachDeck.editor.assistant.actualChanges',
                                    '实际变更（基于文档差异）',
                                  )
                                : text('reachDeck.editor.assistant.historicalResult', '历史结果')}
                            </strong>
                            {message.changeSummary.status === 'grounded'
                              ? formatGroundedAssistantChangeSummary(message.changeSummary, text)
                              : text(
                                  'reachDeck.editor.assistant.historicalSummaryUnavailable',
                                  '无可用的结构化实际变更摘要。',
                                )}
                          </span>
                        )}
                        {message.role === 'boundary' ? null : (
                          <span className="reach-deck-editor__assistant-explanation">
                            {message.runtimeApprovalId === undefined
                              ? message.outcome !== undefined
                                ? formatDecksmithOutcome(message.outcome, text)
                                : message.translation
                                  ? renderLocalizedCopy(message.translation)
                                  : message.text
                              : message.approvalPhase === 'superseded' ||
                                  isSupersededApproval(message.runtimeApprovalId)
                                ? text(
                                    'reachDeck.editor.assistant.supersededByTeacherEdit',
                                    '本次 AI 修改已被你之后的修改替代。',
                                  )
                                : message.approvalPhase === 'applied' ||
                                    isAppliedApproval(message.runtimeApprovalId)
                                  ? text(
                                      'reachDeck.editor.assistant.applied',
                                      '已应用 Decksmith 的修改。',
                                    )
                                  : message.approvalPhase === 'rejected' ||
                                      isResolvedApproval(message.runtimeApprovalId)
                                    ? text(
                                        'reachDeck.editor.assistant.proposalNotApplied',
                                        'Decksmith 修改建议未采用。',
                                      )
                                    : message.approvalPhase === 'saving'
                                      ? text(
                                          'reachDeck.editor.assistant.awaitingAppliedConfirmation',
                                          'Decksmith 修改正在保存，等待系统确认。',
                                        )
                                      : message.approvalPhase === 'apply-failed'
                                        ? text(
                                            'reachDeck.editor.assistant.applyConfirmationFailed',
                                            '本次 AI 修改尚未应用成功，请重试。',
                                          )
                                        : message.approvalPhase === 'apply-terminal'
                                          ? text(
                                              'reachDeck.editor.assistant.applyConfirmationTerminal',
                                              '内容已保存，但该修改无法完成应用确认，请重新发起修改或联系管理员。',
                                            )
                                          : message.outcome !== undefined
                                            ? formatDecksmithOutcome(message.outcome, text)
                                            : text(
                                                'reachDeck.editor.assistant.proposalPending',
                                                '已生成修改建议，等待采用。',
                                              )}
                            {message.suffixTranslation &&
                            message.approvalPhase !== 'applied' &&
                            message.approvalPhase !== 'superseded' &&
                            message.approvalPhase !== 'rejected' &&
                            !isAppliedApproval(message.runtimeApprovalId) &&
                            !isResolvedApproval(message.runtimeApprovalId)
                              ? renderLocalizedCopy(message.suffixTranslation)
                              : null}
                          </span>
                        )}
                        {message.role !== 'boundary' && message.outcome !== undefined
                          ? (() => {
                              const notice = formatDecksmithBudgetNotice(message.outcome, text);
                              return notice === undefined ? null : (
                                <span
                                  className="reach-deck-editor__assistant-budget-notice"
                                  data-budget-scope={
                                    message.outcome.completion?.state === 'budget-limited'
                                      ? message.outcome.completion.scope
                                      : undefined
                                  }
                                  data-completion-state={message.outcome.completion?.state}
                                >
                                  {notice}
                                </span>
                              );
                            })()
                          : null}
                        {message.role === 'assistant' &&
                        message.outcome?.clarification !== undefined
                          ? renderAssistantClarification(
                              message.outcome.clarification,
                              message.id === openAssistantClarificationMessageId,
                            )
                          : null}
                        {message.guidanceTranslation ? (
                          <span className="reach-deck-editor__assistant-guidance">
                            {renderLocalizedCopy(message.guidanceTranslation)}
                          </span>
                        ) : null}
                        {message.role === 'assistant' && message.outcome?.afterApply?.length
                          ? message.outcome.afterApply.map((action) => {
                              const index = orderedPages.findIndex(
                                (page) => page.pageId === action.pageId,
                              );
                              const pageLabel = { page: index < 0 ? '?' : index + 1 };
                              return (
                                <span
                                  className="reach-deck-editor__assistant-guidance"
                                  data-after-apply={action.kind}
                                  key={`${message.id}:after-apply:${action.pageId}`}
                                >
                                  {action.kind === 'regenerate-page-media'
                                    ? text(
                                        'reachDeck.editor.assistant.afterApply.regenerateMedia',
                                        '采用后将自动生成第 {page} 页音频和动画',
                                        pageLabel,
                                      )
                                    : text(
                                        'reachDeck.editor.assistant.afterApply.generateAudio',
                                        '采用后将自动生成第 {page} 页音频',
                                        pageLabel,
                                      )}
                                </span>
                              );
                            })
                          : null}
                        {message.outcome?.suggestedActions?.length ? (
                          <div
                            className="reach-deck-editor__assistant-suggested-actions"
                            role="group"
                          >
                            {message.outcome.suggestedActions.map((action) => {
                              const described = describeSuggestedAction(action);
                              if (described === undefined) return null;
                              const { Icon, label, run, unavailableReason } = described;
                              const key = `${message.id}:${action.kind}:${action.pageId}`;
                              return (
                                <button
                                  aria-label={label}
                                  className="reach-deck-editor__assistant-suggested-action"
                                  data-kind={action.kind}
                                  disabled={
                                    run === undefined ||
                                    generationBlockedReason !== undefined ||
                                    disabled ||
                                    suggestedActionBusyKey !== undefined
                                  }
                                  key={key}
                                  onClick={() => {
                                    if (run === undefined) return;
                                    setSuggestedActionBusyKey(key);
                                    void Promise.resolve()
                                      .then(run)
                                      .catch(() => undefined)
                                      .finally(() => setSuggestedActionBusyKey(undefined));
                                  }}
                                  title={unavailableReason ?? generationBlockedReason ?? label}
                                  type="button"
                                >
                                  <Icon aria-hidden="true" size={14} />
                                  <span>{label}</span>
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                        {message.action === 'new-topic' ? (
                          <button
                            className="reach-deck-editor__assistant-guidance-action"
                            disabled={assistantControlBusy !== undefined}
                            onClick={() => void runAssistantControl('new-topic')}
                            type="button"
                          >
                            {text('reachDeck.editor.assistant.newTopic', '新话题')}
                          </button>
                        ) : null}
                        {pendingAssistantChange?.messageId === message.id ? (
                          <div
                            aria-label={text(
                              'reachDeck.editor.assistant.confirmation',
                              'AI 修改确认',
                            )}
                            className="reach-deck-editor__assistant-confirm-actions"
                            role="group"
                          >
                            {assistantPreviewDocument !== undefined ? (
                              <button
                                aria-label={text(
                                  'reachDeck.editor.assistant.previewHold',
                                  '按住预览修改后的页面',
                                )}
                                className="reach-deck-editor__assistant-preview-hold"
                                disabled={disabled || busyAction !== undefined}
                                ref={setAssistantPreviewButton}
                                title={text(
                                  'reachDeck.editor.assistant.previewHold',
                                  '按住预览修改后的页面',
                                )}
                                type="button"
                              >
                                <span>
                                  {text('reachDeck.editor.assistant.previewHold', '按住预览')}
                                </span>
                              </button>
                            ) : null}
                            {(pendingAssistantChange.stale !== true ||
                              canRetryStaleApprovedChange) &&
                            (pendingAssistantChange.runtimeApprovalId === undefined ||
                              !isApplyTerminalApproval(pendingAssistantChange.runtimeApprovalId)) &&
                            pendingAssistantChange.document !== undefined ? (
                              <button
                                aria-label={
                                  pendingAssistantChange.appliedLocally ||
                                  canRetryStaleApprovedChange
                                    ? text('reachDeck.editor.assistant.retrySave', '重试确认应用')
                                    : text('reachDeck.editor.assistant.apply', '应用修改')
                                }
                                className="reach-deck-editor__assistant-apply"
                                disabled={
                                  disabled ||
                                  busyAction !== undefined ||
                                  assistantDecisionBusyPageId !== undefined
                                }
                                onClick={() => void applyAssistantChange(pendingAssistantChangeKey)}
                                title={
                                  pendingAssistantChange.appliedLocally ||
                                  canRetryStaleApprovedChange
                                    ? text('reachDeck.editor.assistant.retrySave', '重试确认应用')
                                    : text('reachDeck.editor.assistant.apply', '应用修改')
                                }
                                type="button"
                              >
                                <span>
                                  {pendingAssistantChange.appliedLocally ||
                                  canRetryStaleApprovedChange
                                    ? text('reachDeck.editor.assistant.retrySave', '重试确认应用')
                                    : text('reachDeck.editor.assistant.apply', '应用修改')}
                                </span>
                              </button>
                            ) : null}
                            {pendingAssistantChange.reAdopt !== undefined &&
                            pendingAssistantChange.document !== undefined &&
                            onAssistantAppliedRetry !== undefined ? (
                              <button
                                className="reach-deck-editor__assistant-apply"
                                data-readopt-reason={pendingAssistantChange.reAdopt.reason}
                                disabled={
                                  disabled ||
                                  busyAction !== undefined ||
                                  assistantDecisionBusyPageId !== undefined
                                }
                                onClick={() =>
                                  pendingAssistantChangeKey === undefined
                                    ? undefined
                                    : void reAdoptAssistantChange(pendingAssistantChangeKey)
                                }
                                title={text(
                                  'reachDeck.editor.assistant.reAdoptHint',
                                  '用 AI 修改覆盖这些页上较新的修改',
                                )}
                                type="button"
                              >
                                <span>
                                  {text('reachDeck.editor.assistant.reAdopt', '重新采用 AI 修改')}
                                </span>
                              </button>
                            ) : null}
                            {(!pendingAssistantChange.appliedLocally ||
                              (pendingAssistantChange.runtimeApprovalId !== undefined &&
                                isApplyTerminalApproval(
                                  pendingAssistantChange.runtimeApprovalId,
                                ))) &&
                            (pendingAssistantChange.runtimeApprovalId === undefined ||
                              !isApplyTerminalApproval(pendingAssistantChange.runtimeApprovalId)) &&
                            (pendingAssistantChange.runtimeApprovalId === undefined ||
                              !isApprovedApproval(pendingAssistantChange.runtimeApprovalId)) ? (
                              <button
                                aria-label={
                                  pendingAssistantChange.stale === true
                                    ? text(
                                        'reachDeck.editor.assistant.discardRecovery',
                                        '放弃恢复结果',
                                      )
                                    : text('reachDeck.editor.assistant.discard', '放弃修改')
                                }
                                disabled={
                                  disabled ||
                                  busyAction !== undefined ||
                                  assistantDecisionBusyPageId !== undefined
                                }
                                onClick={() =>
                                  void discardAssistantChange(pendingAssistantChangeKey)
                                }
                                title={
                                  pendingAssistantChange.stale === true
                                    ? text(
                                        'reachDeck.editor.assistant.discardRecovery',
                                        '放弃恢复结果',
                                      )
                                    : text('reachDeck.editor.assistant.discard', '放弃修改')
                                }
                                type="button"
                              >
                                <span>
                                  {pendingAssistantChange.stale === true
                                    ? text(
                                        'reachDeck.editor.assistant.discardRecovery',
                                        '放弃恢复结果',
                                      )
                                    : text('reachDeck.editor.assistant.discard', '放弃修改')}
                                </span>
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    ))}
                    {assistantProgressVisible && !assistantStopped ? (
                      <div className="reach-deck-editor__assistant-thinking-row">
                        <p
                          aria-busy="true"
                          className="reach-deck-editor__assistant-message is-assistant is-thinking"
                        >
                          <span className="reach-deck-editor__assistant-loading">
                            <BrandLoader size="sm" />
                            {assistantProgress ??
                              text(
                                'reachDeck.editor.assistant.thinking',
                                '正在理解课件结构并修改…',
                              )}
                          </span>
                          {assistantWaiting ? (
                            <span role="status">
                              <br />
                              {text(
                                'reachDeck.editor.assistant.waiting',
                                '可能正在排队，请耐心等待，或停止后重试。',
                              )}
                            </span>
                          ) : null}
                        </p>
                        {assistantJobActive &&
                        onAssistantCancel !== undefined &&
                        !assistantMessagesLoading ? (
                          <button
                            aria-label={text('reachDeck.editor.assistant.cancel', '取消生成')}
                            className="reach-deck-editor__assistant-cancel"
                            disabled={assistantCancelBusy}
                            onClick={() => void cancelAssistantJob()}
                            title={text('reachDeck.editor.assistant.cancel', '取消生成')}
                            type="button"
                          >
                            <Square aria-hidden size={12} />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {assistantStopped ? (
                      <div className="reach-deck-editor__assistant-thinking-row">
                        <p className="reach-deck-editor__assistant-message is-assistant">
                          {text('reachDeck.editor.assistant.stopped', '已停止生成')}
                        </p>
                        <button
                          aria-label={text('reachDeck.editor.assistant.retry', '重试生成')}
                          className="reach-deck-editor__assistant-cancel"
                          disabled={
                            disabled ||
                            busyAction !== undefined ||
                            assistantBlockedReason !== undefined ||
                            assistantBusy ||
                            assistantJobActive ||
                            assistantCancelBusy ||
                            assistantControlBusy !== undefined ||
                            pendingAssistantChange !== undefined ||
                            onAssistantPrompt === undefined ||
                            stoppedRetryRequest === undefined
                          }
                          onClick={retryAssistantJob}
                          title={text('reachDeck.editor.assistant.retry', '重试生成')}
                          type="button"
                        >
                          <RefreshCw aria-hidden size={12} />
                        </button>
                      </div>
                    ) : null}
                    {activeApplyCheck === undefined ? null : (
                      <div
                        aria-label={text(
                          'reachDeck.editor.assistant.conflictTitle',
                          '应用这份修改前请确认',
                        )}
                        className="reach-deck-editor__assistant-conflict"
                        role="alertdialog"
                      >
                        <strong>
                          {text('reachDeck.editor.assistant.conflictTitle', '应用这份修改前请确认')}
                        </strong>
                        {describeAssistantApplyCheck(activeApplyCheck.check).map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                        <div className="reach-deck-editor__assistant-actions">
                          {activeApplyCheck.check.overridable && !activeApplyCheck.check.expired ? (
                            <>
                              <button
                                className="reach-deck-editor__assistant-apply"
                                disabled={assistantDecisionBusyPageId !== undefined}
                                onClick={() => {
                                  const pageId = activeApplyCheck.pageId;
                                  setAssistantApplyCheck(undefined);
                                  void applyAssistantChange(pageId, { override: true });
                                }}
                                type="button"
                              >
                                {text('reachDeck.editor.assistant.conflictOverride', '覆盖并应用')}
                              </button>
                              <button
                                className="reach-deck-editor__assistant-discard"
                                onClick={() => setAssistantApplyCheck(undefined)}
                                type="button"
                              >
                                {text('reachDeck.editor.assistant.conflictCancel', '取消')}
                              </button>
                            </>
                          ) : (
                            <>
                              {activeApplyCheck.check.expired ||
                              activeApplyCheck.check.conflicts.some(
                                (conflict) =>
                                  conflict.kind === 'structure-changed' ||
                                  conflict.kind === 'envelope-changed',
                              ) ? (
                                <button
                                  className="reach-deck-editor__assistant-discard"
                                  disabled={assistantDecisionBusyPageId !== undefined}
                                  onClick={() => {
                                    const pageId = activeApplyCheck.pageId;
                                    setAssistantApplyCheck(undefined);
                                    void discardAssistantChange(pageId);
                                  }}
                                  type="button"
                                >
                                  {text(
                                    'reachDeck.editor.assistant.conflictDiscard',
                                    '放弃这份修改',
                                  )}
                                </button>
                              ) : null}
                              <button
                                className="reach-deck-editor__assistant-discard"
                                onClick={() => setAssistantApplyCheck(undefined)}
                                type="button"
                              >
                                {text('reachDeck.editor.assistant.conflictClose', '关闭')}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </AssistantConversation>
                  {(assistantContextError ??
                  (assistantHistory !== undefined && assistantHistory.pageId === activePage?.pageId
                    ? assistantHistory.error
                    : undefined)) ? (
                    <p className="reach-deck-editor__assistant-context-error" role="alert">
                      {assistantContextError ?? assistantHistory?.error}
                    </p>
                  ) : null}
                  <div
                    aria-label={text(
                      'reachDeck.editor.assistant.contextLabel',
                      '发送给 Decksmith 的上下文',
                    )}
                    className="reach-deck-editor__assistant-context-chips"
                  >
                    {activePage !== undefined ? (
                      <button
                        aria-label={
                          assistantContext.includeCurrentPage
                            ? text(
                                'reachDeck.editor.assistant.removeCurrentPage',
                                '移除当前页面上下文',
                              )
                            : text(
                                'reachDeck.editor.assistant.addCurrentPage',
                                '添加当前页面上下文',
                              )
                        }
                        aria-pressed={assistantContext.includeCurrentPage}
                        className="reach-deck-editor__assistant-current-page-chip"
                        data-included={assistantContext.includeCurrentPage}
                        onClick={() =>
                          setAssistantContextByPage((current) => ({
                            ...current,
                            [activePage.pageId]: {
                              ...assistantContext,
                              includeCurrentPage: !assistantContext.includeCurrentPage,
                            },
                          }))
                        }
                        type="button"
                      >
                        <span className="reach-deck-editor__assistant-current-page-label">
                          {text(
                            'reachDeck.editor.assistant.currentPageChip',
                            '当前页：第 {order} 页 · {title}',
                            { order: activePageOrder ?? 1, title: activePage.title },
                          )}
                        </span>
                        {assistantContext.includeCurrentPage ? (
                          <X aria-hidden size={12} />
                        ) : (
                          <Plus aria-hidden size={12} />
                        )}
                      </button>
                    ) : null}
                    {assistantContext.mentionedPageIds.map((pageId) => {
                      const page = orderedPages.find((candidate) => candidate.pageId === pageId);
                      if (page === undefined) return null;
                      return (
                        <button
                          aria-label={text(
                            'reachDeck.editor.assistant.removePageReference',
                            '移除页面引用 {title}',
                            { title: page.title },
                          )}
                          key={pageId}
                          onClick={() =>
                            activePage === undefined
                              ? undefined
                              : setAssistantContextByPage((current) => ({
                                  ...current,
                                  [activePage.pageId]: {
                                    ...assistantContext,
                                    mentionedPageIds: assistantContext.mentionedPageIds.filter(
                                      (candidate) => candidate !== pageId,
                                    ),
                                  },
                                }))
                          }
                          type="button"
                        >
                          @{page.title} ×
                        </button>
                      );
                    })}
                    {activePage?.sceneType === 'slide'
                      ? selectedElementIds.map((componentId) => {
                          const located =
                            activeNativeSlide === undefined
                              ? undefined
                              : locateNativeElement(activeNativeSlide.elements, componentId);
                          const info =
                            located === undefined
                              ? undefined
                              : nativeElementChipInfo(located.element);
                          const TypeIconComponent =
                            info === undefined ? undefined : NATIVE_ELEMENT_TYPE_ICONS[info.type];
                          const typeName =
                            info === undefined
                              ? undefined
                              : text(
                                  `reachDeck.editor.assistant.elementType.${info.type}`,
                                  NATIVE_ELEMENT_TYPE_NAMES[info.type],
                                );
                          // 可读标签：类型 + 有界描述；元素已不在页上时回落到 id。
                          const chipLabel =
                            typeName === undefined
                              ? text('reachDeck.editor.assistant.componentChip', '组件：{id}', {
                                  id: componentId,
                                })
                              : info?.detail === undefined
                                ? typeName
                                : text(
                                    'reachDeck.editor.assistant.elementChip',
                                    '{type}：{detail}',
                                    { type: typeName, detail: info.detail },
                                  );
                          // 缩略图只用编辑器已加载的媒体地址，不新增取图路径。
                          const thumbnailUrl =
                            info?.imageResourceId === undefined
                              ? undefined
                              : resolvedNativeResourceUrlsById[info.imageResourceId];
                          return (
                            <button
                              aria-label={text(
                                'reachDeck.editor.assistant.removeComponentFocus',
                                '移除组件聚焦 {label}',
                                { label: chipLabel },
                              )}
                              className="reach-deck-editor__assistant-element-chip"
                              data-element-type={info?.type}
                              key={componentId}
                              onClick={() => {
                                setSelectedElementIds((current) =>
                                  current.filter((candidate) => candidate !== componentId),
                                );
                                if (selectedElementId === componentId)
                                  setSelectedElementId(undefined);
                              }}
                              title={text(
                                'reachDeck.editor.assistant.elementChipTitle',
                                '{label}（ID：{id}）',
                                { label: chipLabel, id: componentId },
                              )}
                              type="button"
                            >
                              {thumbnailUrl === undefined ? (
                                TypeIconComponent === undefined ? null : (
                                  <TypeIconComponent aria-hidden size={12} />
                                )
                              ) : (
                                <img
                                  alt=""
                                  aria-hidden
                                  className="reach-deck-editor__assistant-element-chip-thumbnail"
                                  src={thumbnailUrl}
                                />
                              )}
                              <span className="reach-deck-editor__assistant-element-chip-label">
                                {chipLabel}
                              </span>
                              <X aria-hidden size={12} />
                            </button>
                          );
                        })
                      : null}
                    {activePage?.sceneType === 'interactive' &&
                    interactiveComponentFocus?.pageId === activePage.pageId ? (
                      <button
                        aria-label={text(
                          'reachDeck.editor.assistant.removeInteractiveFocus',
                          '移除互动组件聚焦 {label}',
                          { label: interactiveComponentFocus.label },
                        )}
                        onClick={clearInteractiveComponentFocus}
                        type="button"
                      >
                        {text(
                          'reachDeck.editor.assistant.interactiveComponentChip',
                          '互动组件：{label}',
                          {
                            label: interactiveComponentFocus.label,
                          },
                        )}{' '}
                        ×
                      </button>
                    ) : null}
                  </div>
                  {activePage?.sceneType === 'slide' ? (
                    <div
                      aria-label={text('reachDeck.editor.assistant.quickPrompts', 'AI 快捷指令')}
                      className="reach-deck-editor__assistant-suggestions"
                    >
                      {resolvedAssistantSuggestions.map((suggestion) => (
                        <button
                          disabled={assistantSendBlocked}
                          key={suggestion}
                          onClick={() => void runAssistantPrompt(suggestion)}
                          title={suggestion}
                          type="button"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <form
                    className="reach-deck-editor__assistant-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runAssistantPrompt();
                    }}
                  >
                    {assistantBlockedReason === undefined ? null : (
                      <p className="reach-deck-editor__assistant-blocked" role="status">
                        {assistantBlockedReason}
                      </p>
                    )}
                    {openAssistantClarification !== undefined && activePageId !== undefined ? (
                      <p
                        className="reach-deck-editor__assistant-reply-link"
                        data-linked={linkedAssistantQuestionId === undefined ? 'false' : 'true'}
                      >
                        <span aria-live="polite">
                          {linkedAssistantQuestionId === undefined
                            ? text(
                                'reachDeck.editor.assistant.clarification.replyUnlinked',
                                '这条消息将作为新请求发送，不回答上面的问题。',
                              )
                            : text(
                                'reachDeck.editor.assistant.clarification.replyLinked',
                                '这条消息将作为对 Decksmith 问题的回答。',
                              )}
                        </span>
                        {/* 按钮名称描述切换后的动作（随状态变化），不再叠加 aria-pressed，避免读成"改为新请求，已按下"。 */}
                        <button
                          onClick={() => {
                            const pageId = activePageId;
                            const questionId = openAssistantClarification.questionId;
                            setAssistantReplyUnlinkedByPage((current) => {
                              const { [pageId]: unlinked, ...rest } = current;
                              return unlinked === questionId
                                ? rest
                                : { ...rest, [pageId]: questionId };
                            });
                          }}
                          type="button"
                        >
                          {linkedAssistantQuestionId === undefined
                            ? text(
                                'reachDeck.editor.assistant.clarification.linkReply',
                                '改为回答问题',
                              )
                            : text(
                                'reachDeck.editor.assistant.clarification.unlinkReply',
                                '改为新请求',
                              )}
                        </button>
                      </p>
                    ) : null}
                    <label htmlFor="reach-deck-assistant-prompt">
                      {text('reachDeck.editor.assistant.promptLabel', '向 Decksmith 描述修改')}
                    </label>
                    <textarea
                      ref={assistantComposerRef}
                      disabled={disabled}
                      id="reach-deck-assistant-prompt"
                      onChange={(event) => setAssistantPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (mentionCandidates.length === 0) return;
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                          event.preventDefault();
                          setAssistantPickerIndex((current) =>
                            event.key === 'ArrowDown'
                              ? (current + 1) % mentionCandidates.length
                              : (current - 1 + mentionCandidates.length) % mentionCandidates.length,
                          );
                        } else if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          selectMentionPage(
                            mentionCandidates[assistantPickerIndex]?.pageId ??
                              mentionCandidates[0]!.pageId,
                          );
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setAssistantPrompt((current) =>
                            mentionMatch === null
                              ? current
                              : current.slice(0, mentionMatch.index).trimEnd(),
                          );
                        }
                      }}
                      placeholder={text(
                        'reachDeck.editor.assistant.placeholder',
                        '例如：把标题改得更有悬念，并在最后加一页测验…',
                      )}
                      rows={3}
                      value={assistantPrompt}
                    />
                    {mentionCandidates.length > 0 ? (
                      <div
                        aria-label={text('reachDeck.editor.assistant.pagePicker', '选择引用页面')}
                        className="reach-deck-editor__assistant-page-picker"
                        role="listbox"
                      >
                        {mentionCandidates.map((page, index) => (
                          <button
                            aria-selected={index === assistantPickerIndex}
                            key={page.pageId}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => selectMentionPage(page.pageId)}
                            role="option"
                            type="button"
                          >
                            {page.title}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <button
                      disabled={assistantSendBlocked || assistantPrompt.trim().length === 0}
                      type="submit"
                    >
                      <Send size={15} />{' '}
                      {text('reachDeck.editor.assistant.send', '发送给 Decksmith')}
                    </button>
                  </form>
                </section>
              ) : assistantStatus !== undefined ? (
                <section aria-label="Decksmith" className="reach-deck-editor__assistant">
                  <header>
                    <span>
                      <Bot size={17} />
                    </span>
                    <div className="reach-deck-editor__assistant-identity">
                      <strong>Decksmith</strong>
                      <small>{assistantStatus}</small>
                    </div>
                  </header>
                  <div
                    aria-live="polite"
                    className="reach-deck-editor__assistant-messages"
                    role="status"
                  >
                    <p className="is-assistant is-thinking">{assistantStatus}</p>
                  </div>
                </section>
              ) : null}
            </div>

            <div
              aria-hidden={rightPanelCollapsed || undefined}
              aria-labelledby="reach-deck-right-tab-properties"
              className="reach-deck-editor__right-panel"
              hidden={rightPanelTab !== 'properties'}
              id="reach-deck-right-panel-properties"
              inert={rightPanelCollapsed}
              role="tabpanel"
              aria-label={text('reachDeck.editor.objectProperties', '对象属性')}
            >
              {activePage ? (
                selectedAnimation !== undefined ? (
                  <AnimationPropertiesPanel
                    animation={selectedAnimation}
                    disabled={disabled || busyAction !== undefined || activePageLocked}
                    onChange={updateSelectedAnimation}
                    onPreview={startAnimationDemo}
                    onStopPreview={stopAnimationDemo}
                    previewing={animationDemo?.animationId === selectedAnimation.id}
                    translate={translate}
                  />
                ) : (
                  <>
                    {activePage.sceneType === 'interactive' ? (
                      <div
                        aria-label={text('reachDeck.editor.scene.interactiveSettings', '互动设置')}
                        className="reach-deck-editor__inspector-toolbar reach-deck-editor__property-stack"
                      >
                        {activeGeometryInspection.invalid ? (
                          <GeometryAuthoringReadOnlyNotice invalid translate={translate} />
                        ) : activeGeometryInstance !== undefined ? (
                          <>
                            {activeGeometryInstances.length > 1 ? (
                              <label className="reach-deck-editor__property">
                                <span>
                                  {text('reachDeck.geometry.authoring.instance', '几何实例')}
                                </span>
                                <select
                                  aria-label={text(
                                    'reachDeck.geometry.authoring.instance',
                                    '几何实例',
                                  )}
                                  onChange={(event) => {
                                    setGeometryInstanceIdByPageId((current) => ({
                                      ...current,
                                      [activePage.pageId]: event.target.value,
                                    }));
                                    setGeometrySelectedItemByPageId((current) => ({
                                      ...current,
                                      [activePage.pageId]: undefined,
                                    }));
                                  }}
                                  value={activeGeometryInstance.instanceId}
                                >
                                  {activeGeometryInstances.map((instance) => (
                                    <option key={instance.instanceId} value={instance.instanceId}>
                                      {instance.instanceId}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ) : null}
                            <GeometryAuthoringPanel
                              canSetInitial={
                                activeGeometryProposal?.sourceRevision === activePage.revision &&
                                activeGeometryProposal.fingerprint ===
                                  activeGeometryInstance.fingerprint
                              }
                              disabled={activeGeometryEditingBlocked}
                              instance={activeGeometryInstance}
                              mode={activeGeometryMode}
                              onDelete={(category, id) => {
                                updateActiveGeometry((input) =>
                                  deleteGeometryAuthoredItem({ ...input, category, id }),
                                );
                                setGeometrySelectedItemByPageId((current) => ({
                                  ...current,
                                  [activePage.pageId]: undefined,
                                }));
                              }}
                              onModeChange={(mode) =>
                                setGeometryModeByPageId((current) => ({
                                  ...current,
                                  [activePage.pageId]: mode,
                                }))
                              }
                              onParameterSettingsChange={(settings) =>
                                updateActiveGeometry((input) =>
                                  updateGeometryParameterAuthoring({ ...input, settings }),
                                )
                              }
                              onPolicyChange={(policy) =>
                                updateActiveGeometry((input) =>
                                  updateGeometryExplorationPolicy({ ...input, policy }),
                                )
                              }
                              onPresentationChange={(category, id, patch) =>
                                updateActiveGeometry((input) =>
                                  updateGeometryAuthoredPresentation({
                                    ...input,
                                    category,
                                    id,
                                    patch,
                                  }),
                                )
                              }
                              onSelect={(selected) =>
                                setGeometrySelectedItemByPageId((current) => ({
                                  ...current,
                                  [activePage.pageId]: selected,
                                }))
                              }
                              onSetInitial={() => {
                                if (activeGeometryProposal === undefined) return;
                                updateActiveGeometry((input) =>
                                  setGeometryAuthoredInitialState({
                                    ...input,
                                    state: activeGeometryProposal.state,
                                  }),
                                );
                              }}
                              selected={activeGeometrySelectedItem}
                              translate={translate}
                            />
                          </>
                        ) : activeGeometryInspection.inspection?.hasGeometryV2 ? (
                          <GeometryAuthoringReadOnlyNotice translate={translate} />
                        ) : null}
                        {geometryAuthoringErrorByPageId[activePage.pageId] === undefined ? null : (
                          <p className="reach-deck-editor__geometry-error" role="alert">
                            {geometryAuthoringErrorByPageId[activePage.pageId]}
                          </p>
                        )}
                        <InteractiveSceneToolbar
                          disabled={disabled || busyAction !== undefined || activePageLocked}
                          onUpdate={updateActivePage}
                          page={activePage}
                          translate={translate}
                        />
                        {onGeneratePage || onInteractiveHtmlUpload ? (
                          <div className="reach-deck-editor__canvas-actions">
                            {onGeneratePage ? (
                              <button
                                disabled={disabled || busyAction !== undefined || activePageLocked}
                                onClick={runGeneratePage}
                                type="button"
                              >
                                {text('reachDeck.editor.generateCurrentPage', '生成当前页')}
                              </button>
                            ) : null}
                            {onInteractiveHtmlUpload ? (
                              <button
                                disabled={disabled || busyAction !== undefined || activePageLocked}
                                onClick={() => onInteractiveHtmlUpload(activePage.pageId)}
                                type="button"
                              >
                                {text('reachDeck.editor.interactive.uploadHtml', '上传 HTML')}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : activePage.sceneType === 'quiz' ? (
                      <div
                        aria-label={text('reachDeck.editor.quiz.settings', '测验设置')}
                        className="reach-deck-editor__inspector-toolbar reach-deck-editor__property-stack"
                      >
                        <QuizPropertiesPanel
                          activeQuestionIndex={activeQuizQuestionIndex}
                          disabled={disabled || busyAction !== undefined || activePageLocked}
                          onHistoryGroupEnd={closeHistoryGroup}
                          onQuestionIndexChange={setActiveQuizQuestionIndex}
                          onUpdate={updateActivePage}
                          page={activePage}
                          translate={translate}
                        />
                      </div>
                    ) : (
                      <div
                        aria-label={text('reachDeck.editor.canvasFormatting', '画布格式')}
                        className="reach-deck-editor__inspector-toolbar reach-deck-editor__property-stack"
                      >
                        {/* 富文本工具栏插槽（display: contents）：portal 只会追加进插槽
                        内部，保证行内顺序恒为 文字 → 对象 → 生成按钮。 */}
                        <div
                          className="reach-deck-editor__toolbar-slot"
                          ref={setRichTextToolbarTarget}
                        >
                          {inlineTextSession === undefined &&
                          selectedTextElement === undefined &&
                          selectedNativeTextFrame === undefined ? (
                            <RichTextToolbarPlaceholder translate={translate} />
                          ) : null}
                          {inlineTextSession === undefined &&
                          selectedNativeTextFrame !== undefined &&
                          selectedNativeElement !== undefined ? (
                            <RichTextElementEditor
                              disabled={disabled || busyAction !== undefined}
                              formatWholeDocument
                              key={`native-${selectedNativeElement.id}`}
                              label={text(
                                'reachDeck.editor.selectedTextFormatting',
                                '选中文本格式',
                              )}
                              onChange={(doc, metadata) =>
                                updateSelectedNativeElement(
                                  (element) =>
                                    (element.type === 'shape' || element.type === 'textFrame') &&
                                    element.text !== undefined
                                      ? { ...element, text: { ...element.text, doc } }
                                      : element,
                                  metadata,
                                )
                              }
                              toolbarOnly
                              toolbarTarget={richTextToolbarTarget}
                              translate={translate}
                              value={selectedNativeTextFrame.doc}
                            />
                          ) : null}
                        </div>
                        {inlineTextSession === undefined &&
                        selectedNativeTextFrame !== undefined &&
                        selectedNativeElement !== undefined ? (
                          <TextSpacingControls
                            disabled={disabled || busyAction !== undefined}
                            document={selectedNativeTextFrame.doc}
                            onChange={(doc) =>
                              updateSelectedNativeElement((element) =>
                                (element.type === 'shape' || element.type === 'textFrame') &&
                                element.text !== undefined
                                  ? { ...element, text: { ...element.text, doc } }
                                  : element,
                              )
                            }
                            translate={translate}
                          />
                        ) : null}
                        {activeNativeSlide !== undefined ? (
                          selectedNativeElement !== undefined &&
                          (selectedNativeElement.type === 'shape' ||
                            selectedNativeElement.type === 'line') ? (
                            <NativeV2StyleToolbar
                              disabled={disabled || busyAction !== undefined}
                              element={selectedNativeElement}
                              onUpdate={updateSelectedNativeElement}
                            />
                          ) : (
                            <NativeV2StyleToolbarPlaceholder />
                          )
                        ) : null}
                        {mediaInsertToolbar}
                        {onGeneratePage ? (
                          <div className="reach-deck-editor__canvas-actions">
                            <button
                              disabled={disabled || busyAction !== undefined || activePageLocked}
                              onClick={runGeneratePage}
                              type="button"
                            >
                              {text('reachDeck.editor.generateCurrentPage', '生成当前页')}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </>
                )
              ) : null}
            </div>
            <div
              aria-hidden={rightPanelCollapsed || undefined}
              aria-labelledby="reach-deck-right-tab-narration"
              className="reach-deck-editor__right-panel reach-deck-editor__narration-panel"
              hidden={rightPanelTab !== 'narration'}
              id="reach-deck-right-panel-narration"
              inert={rightPanelCollapsed}
              role="tabpanel"
            >
              {rightPanelTab === 'narration' && workspaceNarrationPanelAction !== undefined ? (
                <div className="reach-deck-timeline__narration-actions reach-deck-editor__narration-workspace-action">
                  {workspaceNarrationPanelAction}
                </div>
              ) : null}
              {activePage?.sceneType === 'slide' && activeNativeSlide !== undefined ? (
                <>
                  {localGenerationStatus?.phase === 'narration' ? (
                    <p
                      aria-live="polite"
                      className="reach-deck-editor__narration-status"
                      data-failed={localGenerationStatus.state === 'failed' || undefined}
                      role={localGenerationStatus.state === 'failed' ? 'alert' : 'status'}
                    >
                      {localGenerationStatus.state === 'loading' ? (
                        <span aria-hidden className="reach-deck-timeline__generation-spinner" />
                      ) : null}
                      {localGenerationStatus.message}
                    </p>
                  ) : null}
                  {activeNativeSlide !== undefined &&
                  isNativeSlideNarrationContentStale(activeNativeSlide) ? (
                    <p role="status" className="reach-deck-editor__narration-status">
                      {text(
                        'reachDeck.editor.narration.contentStale',
                        '页面文字已变化，讲稿可能已过期。可重新生成讲稿。',
                      )}
                    </p>
                  ) : null}
                  {renderReplacedNarrationNotice(activePage.pageId)}
                  <NarrationEditor
                    hideGenerationMenu={onRequestRegenerationPage !== undefined}
                    key={`${activePage.pageId}:${narrationEditorEpochs[activePage.pageId] ?? 0}`}
                    draftCache={narrationDraftCache.current}
                    draftCacheKey={activePage.pageId}
                    applying={
                      localGenerationStatus?.phase === 'narration' &&
                      localGenerationStatus.state === 'loading'
                    }
                    onSaveAudio={
                      onSavePageNarrationAudio === undefined
                        ? undefined
                        : (input) =>
                            onSavePageNarrationAudio({ ...input, pageId: activePage.pageId })
                    }
                    onSaveDraft={
                      onSavePageNarrationDraft === undefined
                        ? undefined
                        : (input) =>
                            onSavePageNarrationDraft({ ...input, pageId: activePage.pageId })
                    }
                    onRegenerateAnimations={
                      onRegeneratePageNarrationAnimations === undefined
                        ? undefined
                        : (input) =>
                            onRegeneratePageNarrationAnimations({
                              ...input,
                              pageId: activePage.pageId,
                            })
                    }
                    onRegenerateAnimationsOnly={
                      onRegeneratePageAnimationsOnly === undefined
                        ? undefined
                        : (input) =>
                            onRegeneratePageAnimationsOnly({ ...input, pageId: activePage.pageId })
                    }
                    allowedSpeechMarkTypes={allowedNarrationSpeechMarkTypes}
                    disabled={disabled || busyAction !== undefined || activePageLocked}
                    onRegenerate={
                      onRegeneratePageNarration === undefined
                        ? undefined
                        : () => onRegeneratePageNarration(activePage.pageId)
                    }
                    onRegenerateTextOnly={
                      // 失败/生成中的页只走完整重试：仅讲稿结果不带音频，原生通道不回写工作区状态，
                      // 页面会一直停在失败/生成中。
                      onRegeneratePageNarration === undefined ||
                      activeGenerationStatus !== undefined
                        ? undefined
                        : () => onRegeneratePageNarration(activePage.pageId, { textOnly: true })
                    }
                    regenerateButtonRef={narrationRegenerateButtonRef}
                    generationBlockedReason={generationBlockedReason}
                    regenerateDisabled={
                      disabled ||
                      busyAction !== undefined ||
                      (activePageLocked && !activeNarrationRegeneratable)
                    }
                    fallbackMarkdown={
                      localGenerationStatus?.phase === 'narration' &&
                      localGenerationStatus.state === 'manual-review-required'
                        ? localGenerationStatus.candidateMarkdown
                        : undefined
                    }
                    onSaveAndGenerate={
                      onSavePageNarrationAndGenerate === undefined
                        ? undefined
                        : ({ markdown, speechMarkup }) =>
                            onSavePageNarrationAndGenerate({
                              markdown,
                              pageId: activePage.pageId,
                              ...(speechMarkup === undefined ? {} : { speechMarkup }),
                            })
                    }
                    onRequestSpeechMarkupCandidates={
                      onRequestPageSpeechMarkupCandidates === undefined
                        ? undefined
                        : (input, signal) =>
                            onRequestPageSpeechMarkupCandidates(
                              { ...input, pageId: activePage.pageId },
                              signal,
                            )
                    }
                    onPreviewSpeech={
                      onPreviewPageSpeech === undefined
                        ? undefined
                        : (input, signal, onProgress) =>
                            onPreviewPageSpeech(
                              { ...input, pageId: activePage.pageId },
                              signal,
                              onProgress,
                            )
                    }
                    slide={activeNativeSlide}
                    translate={translate}
                  />
                </>
              ) : activePage?.sceneType === 'interactive' &&
                activeInteractiveNarrationModel !== undefined ? (
                <>
                  <p className="reach-deck-timeline__narration-hint">
                    {text(
                      'reachDeck.editor.interactiveNarration.hint',
                      '用一段简洁的话说明学生如何操作，以及需要观察、比较或发现什么。',
                    )}
                  </p>
                  {localGenerationStatus?.phase === 'narration' &&
                  localGenerationStatus.state === 'failed' &&
                  localGenerationStatus.message !== undefined ? (
                    <p className="reach-deck-editor__narration-status" data-failed role="alert">
                      {localGenerationStatus.message}
                    </p>
                  ) : null}
                  {renderReplacedNarrationNotice(activePage.pageId)}
                  <NarrationEditor
                    hideGenerationMenu={onRequestRegenerationPage !== undefined}
                    key={`${activePage.pageId}:${narrationEditorEpochs[activePage.pageId] ?? 0}`}
                    actionsRef={interactiveNarrationActionsRef}
                    allowedSpeechMarkTypes={allowedNarrationSpeechMarkTypes}
                    applying={activeInteractiveNarrationLoading}
                    disabled={activeInteractiveNarrationLocked}
                    draftCache={narrationDraftCache.current}
                    draftCacheKey={activePage.pageId}
                    generationBlockedReason={generationBlockedReason}
                    interactive={{
                      id: activePage.pageId,
                      narration: activeInteractiveNarration,
                      generationState: interactiveNarrationGenerationState(localGenerationStatus),
                    }}
                    onDraftChange={(nextDraft) =>
                      setInteractiveNarrationSnapshot({
                        draft: nextDraft,
                        pageId: activePage.pageId,
                      })
                    }
                    onPreviewSpeech={
                      onPreviewPageSpeech === undefined
                        ? undefined
                        : (input, signal, onProgress) =>
                            onPreviewPageSpeech(
                              { ...input, pageId: activePage.pageId },
                              signal,
                              onProgress,
                            )
                    }
                    onRegenerate={
                      onRegeneratePageNarration === undefined
                        ? undefined
                        : () => onRegeneratePageNarration(activePage.pageId)
                    }
                    onRequestSpeechMarkupCandidates={
                      onRequestPageSpeechMarkupCandidates === undefined
                        ? undefined
                        : (input, signal) =>
                            onRequestPageSpeechMarkupCandidates(
                              { ...input, pageId: activePage.pageId },
                              signal,
                            )
                    }
                    onSaveAndGenerate={
                      onSaveInteractivePageNarrationAndGenerate === undefined
                        ? undefined
                        : ({ text: narrationText, speechMarkup }) =>
                            onSaveInteractivePageNarrationAndGenerate({
                              pageId: activePage.pageId,
                              text: narrationText,
                              ...(speechMarkup === undefined ? {} : { speechMarkup }),
                            })
                    }
                    regenerateButtonRef={narrationRegenerateButtonRef}
                    regenerateDisabled={
                      disabled ||
                      busyAction !== undefined ||
                      activeInteractiveNarrationLoading ||
                      (activePageLocked && !activeNarrationRegeneratable)
                    }
                    translate={translate}
                  />
                </>
              ) : (
                <p className="reach-deck-editor__right-panel-empty">
                  {text('reachDeck.editor.narrationUnavailable', '当前页面没有可编辑的讲稿。')}
                </p>
              )}
            </div>
          </aside>
        </div>
      </div>
      {structureChangeConfirmation === undefined ? null : (
        <ConfirmDialog
          busy={structureChangeBusy}
          cancelLabel={text('shared.confirm.cancel', '取消')}
          confirmLabel={
            structureChangeConfirmation.decksmith
              ? text('reachDeck.editor.structureChange.confirm', '放弃并继续')
              : text('reachDeck.editor.structureChange.deleteGenerating.confirm', '删除')
          }
          description={
            structureChangeError ??
            [
              ...(structureChangeConfirmation.generatingPageIds.length > 0
                ? [
                    text(
                      'reachDeck.editor.structureChange.deleteGenerating.description',
                      '要删除的页面还在生成中。删除会停止这些页面的生成任务，其他页面继续生成；停止后无法恢复。',
                    ),
                  ]
                : []),
              ...(structureChangeConfirmation.decksmith
                ? [
                    text(
                      'reachDeck.editor.structureChange.description',
                      'Decksmith 还有正在进行或尚未落地的修改。增删或调整页面顺序会停止这些请求并放弃它们的修改，放弃后无法恢复。',
                    ),
                  ]
                : []),
            ].join(' ')
          }
          onCancel={cancelStructureChange}
          onConfirm={() => void confirmStructureChange()}
          open
          title={
            structureChangeConfirmation.decksmith
              ? text('reachDeck.editor.structureChange.title', '放弃 Decksmith 的修改？')
              : text(
                  'reachDeck.editor.structureChange.deleteGenerating.title',
                  '删除正在生成的页面？',
                )
          }
          tone="danger"
        />
      )}
      {assistantDeleteConfirmation ? (
        <ConfirmDialog
          cancelLabel={text('shared.confirm.cancel', '取消')}
          confirmLabel={text('shared.confirm.continue', '继续')}
          description={text(
            'reachDeck.editor.assistant.deleteConfirm',
            '隐藏当前页的全部 Decksmith 对话？此操作不会影响其他页面。',
          )}
          onCancel={() => setAssistantDeleteConfirmation(false)}
          onConfirm={() => void confirmAssistantDelete()}
          open
          title={text('reachDeck.editor.assistant.deleteTitle', '确认删除当前页对话')}
          tone="danger"
        />
      ) : null}
      {elementMenu === undefined ? null : (
        <div
          aria-label={text('reachDeck.editor.elementActions', '元素操作')}
          className="reach-deck-editor__page-menu reach-deck-editor__element-menu"
          role="menu"
          style={{ left: elementMenu.x, top: elementMenu.y }}
        >
          {elementMenu.elementIds.length === 1 && onRegenerateImage
            ? activeMediaSlots
                .filter(
                  (slot) =>
                    slot.elementId === (elementMenu.hitElementId ?? elementMenu.elementIds[0]),
                )
                .map((slot) => (
                  <button
                    key={slot.assetId}
                    role="menuitem"
                    type="button"
                    disabled={
                      imageGenerating ||
                      disabled ||
                      activePageLocked ||
                      structureLocked ||
                      hostGenerationBlockedReason !== undefined
                    }
                    onClick={() => {
                      setElementMenu(undefined);
                      void regenerateMediaSlot(slot);
                    }}
                  >
                    <RefreshCw size={14} />
                    {text(
                      slot.status === 'failed'
                        ? 'reachDeck.editor.mediaSlot.retry'
                        : 'reachDeck.editor.mediaSlot.regenerate',
                      slot.status === 'failed' ? '重试这张图片' : '重新生成这张图片',
                    )}
                  </button>
                ))
            : null}
          <button
            onClick={() => {
              window.document.execCommand('copy');
              setElementMenu(undefined);
            }}
            role="menuitem"
            type="button"
          >
            <Copy size={14} /> {text('reachDeck.editor.copy', '复制')}
          </button>
          <button
            disabled={
              !canExecuteEditorCommand('cut', 'canvas', mediaInsertionStateRef.current, [
                activePage?.pageId ?? '',
              ])
            }
            onClick={() => {
              window.document.execCommand('cut');
              setElementMenu(undefined);
            }}
            role="menuitem"
            type="button"
          >
            <Scissors size={14} /> {text('reachDeck.editor.cut', '剪切')}
          </button>
          <button
            disabled={
              !canExecuteEditorCommand('paste', 'canvas', mediaInsertionStateRef.current, [
                activePage?.pageId ?? '',
              ])
            }
            onClick={() => void pasteCanvasFromMenu()}
            role="menuitem"
            type="button"
          >
            <ClipboardPaste size={14} /> {text('reachDeck.editor.paste', '粘贴')}
          </button>
          <button
            disabled={
              !canExecuteEditorCommand('duplicate', 'canvas', mediaInsertionStateRef.current, [
                activePage?.pageId ?? '',
              ])
            }
            onClick={() => duplicateCanvasElements(elementMenu.elementIds)}
            role="menuitem"
            type="button"
          >
            <CopyPlus size={14} /> {text('reachDeck.editor.duplicate', '创建副本')}
          </button>
          <button
            disabled={
              !canExecuteEditorCommand('delete', 'canvas', mediaInsertionStateRef.current, [
                activePage?.pageId ?? '',
              ])
            }
            onClick={() => deleteCanvasElements(elementMenu.elementIds)}
            role="menuitem"
            type="button"
          >
            <Trash2 size={14} /> {text('reachDeck.editor.delete', '删除')}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * 幻灯片缩略图：按 1600×900 舞台等比缩放的真实内容预览。
 *
 * ready slide 只使用 native v2 renderer；生成中/失败页显示稳定 placeholder。
 */
function PageThumbnail({
  page,
  nativeSlide,
  stage,
  themeColors,
  resourceUrlsById,
  resourceMimeTypesById,
}: {
  page: ReachDeckPublishedPage;
  nativeSlide?: ReachDeckNativeSlideV2;
  stage?: { width: number; height: number };
  themeColors?: Readonly<Record<string, string>>;
  resourceUrlsById?: Readonly<Record<string, string>>;
  resourceMimeTypesById?: Readonly<Record<string, string>>;
}) {
  const thumbnailBackground = page.sceneType === 'slide' ? '#f7f5ef' : undefined;
  // 占位页（生成尚未落地）：不渲染任何元素，只给空底色；存量文档里占位页
  // 可能仍带默认标题/“正在生成”文本元素，这里一并挡掉。
  if (nativeSlide !== undefined && stage !== undefined) {
    return (
      <span
        aria-hidden="true"
        className="reach-deck-editor__thumbnail"
        style={{ pointerEvents: 'none' }}
      >
        <NativeV2SlideRenderer
          hideDiagnostics
          passiveMedia
          resourceMimeTypesById={resourceMimeTypesById}
          resourceUrlsById={resourceUrlsById ?? {}}
          slide={nativeSlide}
          stage={stage}
          themeColors={themeColors ?? {}}
        />
      </span>
    );
  }
  if (page.sceneType !== 'slide') {
    return (
      <span className={'reach-deck-editor__thumbnail is-' + page.sceneType} aria-hidden="true">
        <span>{sceneTypeLabels[page.sceneType]}</span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="reach-deck-editor__thumbnail"
      style={{ background: thumbnailBackground }}
    />
  );
}

function deckThemeColorRecord(theme: DeckTheme): Readonly<Record<string, string>> {
  return {
    accent: theme.accent,
    background: theme.background,
    ink: theme.ink,
    muted: theme.muted,
    success: theme.success,
    surface: theme.surface,
    warning: theme.warning,
  };
}

function defaultFontForTextElement(
  element: TextElement,
  document: ReachDeckDocument,
): RichTextFontFamily {
  const themeFont =
    element.variant === 'body' || element.variant === 'caption'
      ? document.theme.fontBody
      : document.theme.fontDisplay;
  const builtIn = REACH_DECK_BUILT_IN_FONT_FAMILIES.find((family) => family === themeFont);
  if (builtIn !== undefined) return builtIn;
  return /serif/i.test(themeFont) ? 'Source Han Serif SC' : 'Source Han Sans VF';
}

function defaultFontWeightForTextElement(element: TextElement): number {
  if (element.variant === 'title') return 800;
  return 400;
}

function renderElementContentEditor(
  element: DeckElement,
  onUpdate: (update: (element: DeckElement) => DeckElement) => void,
  _disabled: boolean,
  translate?: ReachDeckTranslate,
): ReactNode {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  switch (element.type) {
    case 'text':
      return null;
    case 'image':
      return (
        <>
          <Property label={text('reachDeck.editor.element.imageUrl', '图片 URL')}>
            <input
              aria-label={text('reachDeck.editor.element.imageUrl', '图片 URL')}
              onChange={(event) =>
                onUpdate((current) =>
                  current.type === 'image' ? { ...current, src: event.target.value } : current,
                )
              }
              placeholder="https://…"
              value={element.src ?? ''}
            />
          </Property>
          <Property label={text('reachDeck.editor.element.altText', '替代文本')}>
            <input
              aria-label={text('reachDeck.editor.element.imageAltText', '图片替代文本')}
              onChange={(event) =>
                onUpdate((current) =>
                  current.type === 'image' ? { ...current, alt: event.target.value } : current,
                )
              }
              value={element.alt}
            />
          </Property>
          <Property label={text('reachDeck.editor.element.fit', '填充方式')}>
            <select
              aria-label={text('reachDeck.editor.element.imageFit', '图片填充方式')}
              onChange={(event) =>
                onUpdate((current) =>
                  current.type === 'image'
                    ? { ...current, fit: event.target.value as 'cover' | 'contain' }
                    : current,
                )
              }
              value={element.fit}
            >
              <option value="cover">
                {text('reachDeck.editor.element.fit.cover', '裁剪填满')}
              </option>
              <option value="contain">
                {text('reachDeck.editor.element.fit.contain', '完整显示')}
              </option>
            </select>
          </Property>
        </>
      );
    case 'video':
      return (
        <>
          <Property label={text('reachDeck.editor.element.videoUrl', '视频 URL')}>
            <input
              aria-label={text('reachDeck.editor.element.videoUrl', '视频 URL')}
              onChange={(event) =>
                onUpdate((current) =>
                  current.type === 'video' ? { ...current, src: event.target.value } : current,
                )
              }
              placeholder="https://…"
              value={element.src}
            />
          </Property>
          <Property label={text('reachDeck.editor.element.videoTitle', '视频标题')}>
            <input
              aria-label={text('reachDeck.editor.element.videoTitle', '视频标题')}
              onChange={(event) =>
                onUpdate((current) =>
                  current.type === 'video' ? { ...current, title: event.target.value } : current,
                )
              }
              value={element.title}
            />
          </Property>
        </>
      );
    case 'shape':
    case 'line':
    case 'scientificVisual':
      return null;
    default:
      return assertNever(element);
  }
}

function updateQuestionLearningFence(
  question: QuizQuestion,
  enabled: boolean,
  defaultPrompt: string,
): QuizQuestion {
  const withDefaultChoiceAnswer =
    enabled &&
    (question.question_type === 'single_choice' || question.question_type === 'multiple_choice') &&
    Array.isArray(question.answer) &&
    question.answer.length === 0 &&
    question.options?.[0] !== undefined
      ? { ...question, answer: [question.options[0].value] }
      : question;
  return {
    ...withDefaultChoiceAnswer,
    has_answer:
      question.question_type === 'single_choice' ||
      question.question_type === 'multiple_choice' ||
      question.question_type === 'fill_in_the_blank' ||
      question.question_type === 'fill_with_candidates'
        ? questionHasAnswer(withDefaultChoiceAnswer)
        : enabled || question.has_answer,
    learning_fence: enabled
      ? {
          enabled: true,
          prompt: question.learning_fence?.prompt ?? defaultPrompt,
        }
      : undefined,
  };
}

function QuizPropertiesPanel({
  activeQuestionIndex,
  disabled,
  onHistoryGroupEnd,
  onQuestionIndexChange,
  onUpdate,
  page,
  translate,
}: {
  activeQuestionIndex: number;
  disabled: boolean;
  onHistoryGroupEnd: () => void;
  onQuestionIndexChange: (index: number) => void;
  onUpdate: (
    updater: (page: ReachDeckPublishedPage) => ReachDeckPublishedPage,
    options?: ReachDeckHistoryMetadata,
  ) => void;
  page: QuizPage;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const questionIndex = Math.min(activeQuestionIndex, page.scene.content.questions.length - 1);
  const question = page.scene.content.questions[questionIndex];
  if (question === undefined) return null;
  const updateQuestion = (nextQuestion: QuizQuestion, metadata?: ReachDeckHistoryMetadata) =>
    onUpdate((current) => {
      if (current.sceneType !== 'quiz') return current;
      return {
        ...current,
        scene: {
          ...current.scene,
          content: {
            ...current.scene.content,
            questions: current.scene.content.questions.map((candidate, index) =>
              index === questionIndex ? nextQuestion : candidate,
            ),
          },
        },
      };
    }, metadata);
  return (
    <div className="reach-deck-editor__quiz-properties">
      <Property label={text('reachDeck.editor.quiz.questionSelect', '题目')}>
        <Select
          aria-label={text('reachDeck.editor.quiz.questionSelect', '题目')}
          disabled={disabled}
          onChange={(questionId) => {
            const nextIndex = page.scene.content.questions.findIndex(
              (candidate) => candidate.id === questionId,
            );
            if (nextIndex >= 0) onQuestionIndexChange(nextIndex);
          }}
          options={page.scene.content.questions.map((candidate, index) => ({
            label: text('reachDeck.editor.quiz.questionNumber', '第 {number} 题', {
              number: candidate.question_index || index + 1,
            }),
            value: candidate.id,
          }))}
          value={question.id}
        />
      </Property>
      <label className="reach-deck-editor__property-checkbox">
        <input
          checked={question.learning_fence?.enabled === true}
          disabled={disabled}
          onChange={(event) => {
            const enabled = event.target.checked;
            onUpdate((current) => {
              if (current.sceneType !== 'quiz') return current;
              return {
                ...current,
                scene: {
                  ...current.scene,
                  content: {
                    ...current.scene.content,
                    questions: current.scene.content.questions.map((candidate, index) =>
                      index === questionIndex
                        ? updateQuestionLearningFence(
                            candidate,
                            enabled,
                            text(
                              'reachDeck.editor.quiz.learningFenceDefaultPrompt',
                              'Only confirm mastery after the learner independently explains the key concept, why the correct answer is correct, and what was wrong with the earlier reasoning. Ask a follow-up question whenever the evidence is incomplete.',
                            ),
                          )
                        : candidate,
                    ),
                  },
                },
              };
            });
          }}
          type="checkbox"
        />
        <span>{text('reachDeck.editor.quiz.learningFenceEnabled', '答错后启用学习围栏')}</span>
      </label>
      {question.learning_fence?.enabled === true ? (
        <section className="reach-deck-editor__quiz-learning-fence">
          <span className="reach-deck-editor__property-label">
            {text('reachDeck.editor.quiz.learningFencePrompt', '掌握度判定提示词')}
          </span>
          <RichTextElementEditor
            historyGroup={`quiz-rich-text:${page.pageId}:${question.id}:learning-fence`}
            label={text(
              'reachDeck.editor.quiz.learningFencePromptLabel',
              '第 {number} 题学习围栏判定提示词',
              { number: question.question_index },
            )}
            onChange={(document, metadata) => {
              const prompt = richTextToPlainText(document).slice(
                0,
                QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS,
              );
              // The published Quiz contract still owns a required plain string. Keep the last
              // valid value while the author temporarily clears the rich-text surface.
              if (prompt.trim().length === 0) return;
              updateQuestion(
                {
                  ...question,
                  learning_fence: { enabled: true, prompt },
                },
                metadata,
              );
            }}
            onHistoryGroupEnd={onHistoryGroupEnd}
            disabled={disabled}
            showFontControls={false}
            toolbarVisibility="focus"
            translate={translate}
            value={richTextFromPlainText(question.learning_fence.prompt)}
          />
          <small id={`learning-fence-hint-${question.id}`}>
            {text(
              'reachDeck.editor.quiz.learningFenceHint',
              '围栏仅在本题答错后触发。请说明学生必须自主讲清楚的知识点与通过标准。',
            )}
          </small>
        </section>
      ) : null}
    </div>
  );
}

function ReachDeckQuizCanvas({
  attachmentUploadDisabled,
  resolveAttachmentUrl,
  onUploadAttachment,
  activeQuestionIndex,
  idFactory,
  imageUrlsByObjectKey,
  onChange,
  onUpdate,
  onHistoryGroupEnd,
  onQuestionDelete,
  onQuestionTypeChange,
  onQuestionUpdate,
  onQuestionIndexChange,
  onUploadInlineImage,
  page,
  translate,
}: {
  attachmentUploadDisabled: boolean;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  onUploadAttachment?: React.ComponentProps<typeof QuizQuestionAttachmentsEditor>['upload'];
  activeQuestionIndex: number;
  idFactory: ReachDeckIdFactory;
  imageUrlsByObjectKey: Readonly<Record<string, string>>;
  onChange: (page: QuizPage, metadata?: ReachDeckHistoryMetadata) => void;
  onUpdate: (update: (page: ReachDeckPublishedPage) => ReachDeckPublishedPage) => void;
  onHistoryGroupEnd: () => void;
  onQuestionDelete: (questionId: string) => void;
  onQuestionTypeChange: (question: QuizQuestion, questionType: QuizQuestionType) => QuizQuestion;
  onQuestionUpdate: (question: QuizQuestion) => void;
  onQuestionIndexChange: (index: number) => void;
  onUploadInlineImage?: (
    file: File,
    signal: AbortSignal,
  ) => Promise<RichTextUploadedImage | undefined>;
  page: QuizPage;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const questions = page.scene.content.questions;
  const visibleQuestionIndex = Math.min(activeQuestionIndex, questions.length - 1);
  const visibleQuestion = questions[visibleQuestionIndex];
  // 限额按整道题统计（题干 + 选项 + 答案 + 填空 + 解析 + 认知图式），与旧测验模块一致。
  const imageInsertion: RichTextImageInsertion | undefined =
    onUploadInlineImage === undefined || visibleQuestion === undefined
      ? undefined
      : {
          accept: CLIPBOARD_IMAGE_ACCEPT,
          maxBytes: CLIPBOARD_IMAGE_MAX_BYTES,
          maxImages: QUIZ_QUESTION_MAX_INLINE_IMAGES,
          remaining:
            QUIZ_QUESTION_MAX_INLINE_IMAGES -
            collectQuizQuestionInlineImageObjectKeys(visibleQuestion).length,
          upload: onUploadInlineImage,
          urlsByObjectKey: imageUrlsByObjectKey,
        };

  const updateQuestions = (questions: QuizQuestion[], metadata?: ReachDeckHistoryMetadata) =>
    onChange(
      {
        ...page,
        scene: {
          ...page.scene,
          content: {
            ...page.scene.content,
            questions: questions.map((question, index) => ({
              ...question,
              question_index: index + 1,
            })),
          },
        },
      },
      metadata,
    );
  const updateQuestion = (
    questionIndex: number,
    question: QuizQuestion,
    metadata?: ReachDeckHistoryMetadata,
  ) => {
    onQuestionUpdate(question);
    updateQuestions(
      page.scene.content.questions.map((current, index) =>
        index === questionIndex ? question : current,
      ),
      metadata,
    );
  };

  return (
    <section
      aria-label={text('reachDeck.editor.quiz.canvas', '测验编辑画布')}
      className="reach-deck-editor__quiz-canvas"
    >
      <header>
        <span>{text('reachDeck.editor.quiz.badge', '测验')}</span>
        <div className="reach-deck-editor__quiz-header-actions">
          <nav
            aria-label={text('reachDeck.editor.quiz.pagination', '测验题目翻页')}
            className="reach-deck-editor__quiz-pagination"
          >
            <button
              aria-label={text('reachDeck.editor.quiz.previousQuestion', '上一题')}
              disabled={visibleQuestionIndex === 0}
              onClick={() => onQuestionIndexChange(Math.max(0, visibleQuestionIndex - 1))}
              type="button"
            >
              <ChevronLeft size={16} />
            </button>
            <span aria-live="polite">
              {visibleQuestionIndex + 1} / {questions.length}
            </span>
            <button
              aria-label={text('reachDeck.editor.quiz.nextQuestion', '下一题')}
              disabled={visibleQuestionIndex === questions.length - 1}
              onClick={() =>
                onQuestionIndexChange(Math.min(questions.length - 1, visibleQuestionIndex + 1))
              }
              type="button"
            >
              <ChevronRight size={16} />
            </button>
          </nav>
          <button
            onClick={() => {
              const nextQuestionIndex = questions.length;
              updateQuestions([
                ...questions,
                createQuizQuestion('single_choice', nextQuestionIndex + 1, idFactory('question')),
              ]);
              onQuestionIndexChange(nextQuestionIndex);
            }}
            type="button"
          >
            <Plus size={15} /> {text('reachDeck.editor.quiz.addQuestion', '添加题目')}
          </button>
        </div>
      </header>
      <div className="reach-deck-editor__quiz-questions">
        {visibleQuestion === undefined ? null : (
          <article className="reach-deck-editor__quiz-question" key={visibleQuestion.id}>
            <div className="reach-deck-editor__quiz-question-heading">
              <strong>
                {text('reachDeck.editor.quiz.questionNumber', '第 {number} 题', {
                  number: visibleQuestion.question_index,
                })}
              </strong>
              <div className="reach-deck-editor__quiz-question-type">
                <span>{text('reachDeck.editor.quiz.questionType', '题型')}</span>
                <Select<QuizQuestionType>
                  aria-label={text(
                    'reachDeck.editor.quiz.questionTypeLabel',
                    '第 {number} 题题型',
                    { number: visibleQuestion.question_index },
                  )}
                  onChange={(questionType) =>
                    updateQuestion(
                      visibleQuestionIndex,
                      onQuestionTypeChange(visibleQuestion, questionType),
                    )
                  }
                  options={Object.entries(quizQuestionTypeLabels).map(([value, label]) => ({
                    label: text(`reachDeck.editor.quiz.type.${value}`, label),
                    value: value as QuizQuestionType,
                  }))}
                  value={visibleQuestion.question_type}
                />
              </div>
              <label>
                {text('reachDeck.editor.quiz.points', '分值')}
                <input
                  aria-label={text('reachDeck.editor.quiz.pointsLabel', '第 {number} 题分值', {
                    number: visibleQuestion.question_index,
                  })}
                  min={1}
                  onChange={(event) =>
                    updateQuestion(visibleQuestionIndex, {
                      ...visibleQuestion,
                      points: Math.max(1, Math.round(Number(event.target.value) || 1)),
                    })
                  }
                  type="number"
                  value={visibleQuestion.points}
                />
              </label>
              <button
                aria-label={text('reachDeck.editor.quiz.deleteQuestion', '删除第 {number} 题', {
                  number: visibleQuestion.question_index,
                })}
                disabled={questions.length === 1}
                onClick={() => {
                  onQuestionDelete(visibleQuestion.id);
                  updateQuestions(questions.filter((_, index) => index !== visibleQuestionIndex));
                  onQuestionIndexChange(
                    Math.min(visibleQuestionIndex, Math.max(0, questions.length - 2)),
                  );
                }}
                type="button"
              >
                <Trash2 size={15} />
              </button>
            </div>
            <QuizRichField
              allowBlankInsertion={
                visibleQuestion.question_type === 'fill_in_the_blank' ||
                visibleQuestion.question_type === 'cloze' ||
                visibleQuestion.question_type === 'fill_with_candidates'
              }
              historyGroup={`quiz-rich-text:${page.pageId}:${visibleQuestion.id}:prompt`}
              {...(imageInsertion === undefined ? {} : { imageInsertion })}
              label={text('reachDeck.editor.quiz.prompt', '题干 / 大题材料')}
              onChange={(questionDocument, metadata) => {
                if (
                  visibleQuestion.question_type !== 'fill_in_the_blank' &&
                  visibleQuestion.question_type !== 'cloze' &&
                  visibleQuestion.question_type !== 'fill_with_candidates'
                ) {
                  updateQuestion(
                    visibleQuestionIndex,
                    {
                      ...visibleQuestion,
                      question: questionDocument,
                    },
                    metadata,
                  );
                  return;
                }
                const synchronized = synchronizeQuizQuestionBlanks(
                  visibleQuestion.question_type,
                  questionDocument,
                  visibleQuestion.blanks ?? [],
                );
                updateQuestion(
                  visibleQuestionIndex,
                  {
                    ...visibleQuestion,
                    blanks: synchronized.blanks,
                    has_answer: fillBlanksHaveAnswers(
                      visibleQuestion.question_type,
                      synchronized.blanks,
                    ),
                    question: synchronized.document,
                  },
                  metadata,
                );
              }}
              onHistoryGroupEnd={onHistoryGroupEnd}
              translate={translate}
              value={visibleQuestion.question}
            />
            <QuizQuestionAttachmentsEditor
              key={`${page.pageId}:${visibleQuestion.id}`}
              attachments={visibleQuestion.question_attachments ?? []}
              upload={onUploadAttachment}
              uploadDisabled={attachmentUploadDisabled}
              resolveAttachmentUrl={resolveAttachmentUrl}
              mediaUrlsByObjectKey={imageUrlsByObjectKey}
              translate={translate}
              onChange={(updateAttachments) =>
                onUpdate((current) => {
                  if (current.sceneType !== 'quiz') return current;
                  return {
                    ...current,
                    scene: {
                      ...current.scene,
                      content: {
                        ...current.scene.content,
                        questions: current.scene.content.questions.map((question) =>
                          question.id === visibleQuestion.id
                            ? {
                                ...question,
                                question_attachments: updateAttachments(
                                  question.question_attachments ?? [],
                                ),
                              }
                            : question,
                        ),
                      },
                    },
                  };
                })
              }
            />
            <QuizOptionsEditor
              {...(imageInsertion === undefined ? {} : { imageInsertion })}
              onChange={(nextQuestion, metadata) =>
                updateQuestion(visibleQuestionIndex, nextQuestion, metadata)
              }
              onHistoryGroupEnd={onHistoryGroupEnd}
              pageId={page.pageId}
              question={visibleQuestion}
              translate={translate}
            />
            <label className="reach-deck-editor__quiz-answer-toggle">
              <input
                checked={questionHasAnswer(visibleQuestion)}
                disabled={
                  visibleQuestion.learning_fence?.enabled === true ||
                  visibleQuestion.question_type === 'single_choice' ||
                  visibleQuestion.question_type === 'multiple_choice' ||
                  visibleQuestion.question_type === 'fill_in_the_blank' ||
                  visibleQuestion.question_type === 'cloze' ||
                  visibleQuestion.question_type === 'fill_with_candidates'
                }
                onChange={(event) =>
                  updateQuestion(visibleQuestionIndex, {
                    ...visibleQuestion,
                    has_answer: event.target.checked,
                  })
                }
                type="checkbox"
              />
              {text('reachDeck.editor.quiz.includeAnswer', '包含标准答案')}
            </label>
            {visibleQuestion.has_answer ||
            visibleQuestion.question_type === 'fill_in_the_blank' ||
            visibleQuestion.question_type === 'fill_with_candidates' ? (
              <QuizAnswerEditor
                {...(imageInsertion === undefined ? {} : { imageInsertion })}
                onChange={(nextQuestion, metadata) =>
                  updateQuestion(visibleQuestionIndex, nextQuestion, metadata)
                }
                onHistoryGroupEnd={onHistoryGroupEnd}
                pageId={page.pageId}
                question={visibleQuestion}
                translate={translate}
              />
            ) : null}
            <QuizRichField
              historyGroup={`quiz-rich-text:${page.pageId}:${visibleQuestion.id}:analysis`}
              {...(imageInsertion === undefined ? {} : { imageInsertion })}
              label={text('reachDeck.editor.quiz.analysis', '答案解析')}
              onChange={(analysis, metadata) =>
                updateQuestion(visibleQuestionIndex, { ...visibleQuestion, analysis }, metadata)
              }
              onHistoryGroupEnd={onHistoryGroupEnd}
              translate={translate}
              value={visibleQuestion.analysis}
            />
            <QuizRichField
              historyGroup={`quiz-rich-text:${page.pageId}:${visibleQuestion.id}:cognitive-schema`}
              {...(imageInsertion === undefined ? {} : { imageInsertion })}
              label={text('reachDeck.editor.quiz.cognitiveSchema', '认知图式')}
              onChange={(cognitiveSchema, metadata) =>
                updateQuestion(
                  visibleQuestionIndex,
                  {
                    ...visibleQuestion,
                    cognitive_schema: cognitiveSchema,
                  },
                  metadata,
                )
              }
              onHistoryGroupEnd={onHistoryGroupEnd}
              translate={translate}
              value={visibleQuestion.cognitive_schema}
            />
          </article>
        )}
      </div>
    </section>
  );
}

function QuizOptionsEditor({
  imageInsertion,
  onChange,
  onHistoryGroupEnd,
  pageId,
  question,
  translate,
}: {
  imageInsertion?: RichTextImageInsertion;
  onChange: (question: QuizQuestion, metadata?: ReachDeckHistoryMetadata) => void;
  onHistoryGroupEnd: () => void;
  pageId: string;
  question: QuizQuestion;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [answerAnnouncement, setAnswerAnnouncement] = useState('');
  if (question.question_type !== 'single_choice' && question.question_type !== 'multiple_choice') {
    return null;
  }
  const options = question.options ?? [];
  const selected = Array.isArray(question.answer) ? question.answer : [];
  const itemLabel = text('reachDeck.editor.quiz.option', '选项');
  const commit = (nextOptions: QuizQuestionOption[], nextAnswer = selected) => {
    const reconciled = reconcileQuizOptions(nextOptions, nextAnswer);
    onChange({
      ...question,
      answer: reconciled.answerValues,
      has_answer: reconciled.answerValues.length > 0,
      options: reconciled.options,
    });
  };
  return (
    <fieldset className="reach-deck-editor__quiz-options">
      <legend>{itemLabel}</legend>
      {options.map((option, index) => (
        <div
          draggable
          key={`${option.value}-${index}`}
          onDragEnd={() => setDraggedIndex(null)}
          onDragOver={(event) => event.preventDefault()}
          onDragStart={() => setDraggedIndex(index)}
          onDrop={(event) => {
            event.preventDefault();
            if (draggedIndex === null) return;
            const reordered = reorderQuizOptions(options, selected, draggedIndex, index);
            setDraggedIndex(null);
            onChange({
              ...question,
              answer: reordered.answerValues,
              has_answer: reordered.answerValues.length > 0,
              options: reordered.options,
            });
          }}
        >
          <div className="reach-deck-editor__quiz-option-value">
            <span>{option.value}</span>
            <label>
              <input
                aria-label={text('reachDeck.editor.quiz.correctItem', '设为正确答案 {value}', {
                  value: option.value,
                })}
                checked={selected.includes(option.value)}
                name={`answer-${question.id}`}
                onChange={(event) => {
                  const previous = selected[0];
                  const answer =
                    question.question_type === 'multiple_choice'
                      ? event.target.checked
                        ? [...selected, option.value]
                        : selected.filter((value) => value !== option.value)
                      : event.target.checked
                        ? [option.value]
                        : [];
                  if (question.question_type === 'single_choice') {
                    setAnswerAnnouncement(
                      event.target.checked
                        ? previous !== undefined && previous !== option.value
                          ? text(
                              'reachDeck.editor.quiz.singleAnswerReplaced',
                              '{value} 已设为唯一正确答案，{previous} 已取消',
                              { value: option.value, previous },
                            )
                          : text(
                              'reachDeck.editor.quiz.singleAnswerSelected',
                              '{value} 已设为唯一正确答案',
                              { value: option.value },
                            )
                        : text('reachDeck.editor.quiz.singleAnswerCleared', '已取消标准答案'),
                    );
                  }
                  onChange({ ...question, answer, has_answer: answer.length > 0 });
                }}
                type="checkbox"
              />
              <span>{text('reachDeck.editor.quiz.correct', '正确')}</span>
            </label>
          </div>
          <QuizRichField
            historyGroup={`quiz-rich-text:${pageId}:${question.id}:option:${option.value}`}
            {...(imageInsertion === undefined ? {} : { imageInsertion })}
            label={text('reachDeck.editor.quiz.itemLabel', '{item} {value}', {
              item: itemLabel,
              value: option.value,
            })}
            onChange={(label, metadata) =>
              onChange(
                {
                  ...question,
                  options: options.map((current, currentIndex) =>
                    currentIndex === index ? { ...current, label } : current,
                  ),
                },
                metadata,
              )
            }
            onHistoryGroupEnd={onHistoryGroupEnd}
            translate={translate}
            value={option.label}
          />
          <button
            aria-label={text('reachDeck.editor.quiz.deleteItem', '删除{item} {value}', {
              item: itemLabel,
              value: option.value,
            })}
            disabled={options.length <= 2}
            onClick={() => commit(options.filter((_, currentIndex) => currentIndex !== index))}
            type="button"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={() => {
          commit([
            ...options,
            { value: quizOptionValueAt(options.length), label: emptyQuizRichText() },
          ]);
        }}
        type="button"
      >
        <Plus size={14} />{' '}
        {text('reachDeck.editor.quiz.addItem', '添加{item}', { item: itemLabel })}
      </button>
      <p aria-live="polite" className="reach-deck-editor__sr-only" role="status">
        {answerAnnouncement}
      </p>
    </fieldset>
  );
}

function QuizAnswerEditor({
  imageInsertion,
  onChange,
  onHistoryGroupEnd,
  pageId,
  question,
  translate,
}: {
  imageInsertion?: RichTextImageInsertion;
  onChange: (question: QuizQuestion, metadata?: ReachDeckHistoryMetadata) => void;
  onHistoryGroupEnd: () => void;
  pageId: string;
  question: QuizQuestion;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  if (question.question_type === 'single_choice' || question.question_type === 'multiple_choice') {
    return null;
  }
  if (
    question.question_type === 'fill_in_the_blank' ||
    question.question_type === 'cloze' ||
    question.question_type === 'fill_with_candidates'
  ) {
    const fillQuestionType = question.question_type;
    const blanks = question.blanks ?? [];
    return (
      <section className="reach-deck-editor__quiz-blank-answers">
        {blanks.length === 0 ? (
          <p>{text('reachDeck.editor.quiz.insertBlankHelp', '请先在题干中插入填空。')}</p>
        ) : null}
        {blanks.map((blank, index) => (
          <section data-blank-id={blank.id} key={blank.id}>
            <strong>
              {text('reachDeck.editor.quiz.blankAnswer', '第 {number} 空标准答案', {
                number: index + 1,
              })}
            </strong>
            {question.question_type === 'fill_with_candidates' ||
            question.question_type === 'cloze' ? (
              <CandidateBlankOptionsEditor
                blank={blank}
                {...(imageInsertion === undefined ? {} : { imageInsertion })}
                onChange={(nextBlank, metadata) => {
                  const nextBlanks = blanks.map((candidate) =>
                    candidate.id === blank.id ? nextBlank : candidate,
                  );
                  onChange(
                    {
                      ...question,
                      blanks: nextBlanks,
                      has_answer: fillBlanksHaveAnswers(fillQuestionType, nextBlanks),
                    },
                    metadata,
                  );
                }}
                onHistoryGroupEnd={onHistoryGroupEnd}
                pageId={pageId}
                questionId={question.id}
                translate={translate}
              />
            ) : (
              <QuizRichField
                historyGroup={`quiz-rich-text:${pageId}:${question.id}:blank:${blank.id}:answer`}
                {...(imageInsertion === undefined ? {} : { imageInsertion })}
                label={text('reachDeck.editor.quiz.blankAnswer', '第 {number} 空标准答案', {
                  number: index + 1,
                })}
                onChange={(answer, metadata) => {
                  const nextBlanks = blanks.map((candidate) =>
                    candidate.id === blank.id ? { ...candidate, answer } : candidate,
                  );
                  onChange(
                    {
                      ...question,
                      blanks: nextBlanks,
                      has_answer: fillBlanksHaveAnswers(fillQuestionType, nextBlanks),
                    },
                    metadata,
                  );
                }}
                onHistoryGroupEnd={onHistoryGroupEnd}
                translate={translate}
                value={Array.isArray(blank.answer) ? emptyQuizRichText() : blank.answer}
              />
            )}
          </section>
        ))}
      </section>
    );
  }
  return (
    <QuizRichField
      historyGroup={`quiz-rich-text:${pageId}:${question.id}:answer`}
      {...(imageInsertion === undefined ? {} : { imageInsertion })}
      label={text('reachDeck.editor.quiz.answer', '标准答案')}
      onChange={(answer, metadata) => onChange({ ...question, answer }, metadata)}
      onHistoryGroupEnd={onHistoryGroupEnd}
      translate={translate}
      value={Array.isArray(question.answer) ? emptyQuizRichText() : question.answer}
    />
  );
}

function CandidateBlankOptionsEditor({
  blank,
  imageInsertion,
  onChange,
  onHistoryGroupEnd,
  pageId,
  questionId,
  translate,
}: {
  blank: QuizQuestionBlank;
  imageInsertion?: RichTextImageInsertion;
  onChange: (blank: QuizQuestionBlank, metadata?: ReachDeckHistoryMetadata) => void;
  onHistoryGroupEnd: () => void;
  pageId: string;
  questionId: string;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const options = blank.candidates ?? [];
  const selected = Array.isArray(blank.answer) ? blank.answer : [];
  const commit = (nextOptions: QuizQuestionOption[], nextAnswer = selected) => {
    const reconciled = reconcileQuizOptions(nextOptions, nextAnswer);
    onChange({ ...blank, answer: reconciled.answerValues, candidates: reconciled.options });
  };
  return (
    <div className="reach-deck-editor__quiz-options">
      {options.map((option, index) => (
        <div
          draggable
          key={`${option.value}-${index}`}
          onDragEnd={() => setDraggedIndex(null)}
          onDragOver={(event) => event.preventDefault()}
          onDragStart={() => setDraggedIndex(index)}
          onDrop={(event) => {
            event.preventDefault();
            if (draggedIndex === null) return;
            const reordered = reorderQuizOptions(options, selected, draggedIndex, index);
            setDraggedIndex(null);
            onChange({
              ...blank,
              answer: reordered.answerValues,
              candidates: reordered.options,
            });
          }}
        >
          <span>{option.value}</span>
          <input
            aria-label={text('reachDeck.editor.quiz.correctItem', '设为正确答案 {value}', {
              value: option.value,
            })}
            checked={selected.includes(option.value)}
            name={`answer-${questionId}-${blank.id}`}
            onChange={(event) =>
              onChange({
                ...blank,
                answer: event.target.checked ? [option.value] : [],
              })
            }
            type="radio"
          />
          <QuizRichField
            historyGroup={`quiz-rich-text:${pageId}:${questionId}:candidate:${blank.id}:${option.value}`}
            {...(imageInsertion === undefined ? {} : { imageInsertion })}
            label={text('reachDeck.editor.quiz.itemLabel', '候选项 {value}', {
              value: option.value,
            })}
            onChange={(label, metadata) =>
              onChange(
                {
                  ...blank,
                  candidates: options.map((candidate, candidateIndex) =>
                    candidateIndex === index ? { ...candidate, label } : candidate,
                  ),
                },
                metadata,
              )
            }
            onHistoryGroupEnd={onHistoryGroupEnd}
            translate={translate}
            value={option.label}
          />
          <button
            aria-label={text('reachDeck.editor.quiz.deleteItem', '删除候选项 {value}', {
              value: option.value,
            })}
            disabled={options.length <= 2}
            onClick={() => commit(options.filter((_, candidateIndex) => candidateIndex !== index))}
            type="button"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          commit([
            ...options,
            { label: emptyQuizRichText(), value: quizOptionValueAt(options.length) },
          ])
        }
        type="button"
      >
        <Plus size={14} /> {text('reachDeck.editor.quiz.addCandidate', '添加候选项')}
      </button>
    </div>
  );
}

function fillBlanksHaveAnswers(
  questionType: 'fill_in_the_blank' | 'cloze' | 'fill_with_candidates',
  blanks: readonly QuizQuestionBlank[],
): boolean {
  return (
    blanks.length > 0 &&
    blanks.every((blank) =>
      questionType === 'fill_with_candidates' || questionType === 'cloze'
        ? Array.isArray(blank.answer) && blank.answer.length > 0
        : !Array.isArray(blank.answer) && richTextHasRenderableContent(blank.answer),
    )
  );
}

function questionHasAnswer(question: QuizQuestion): boolean {
  if (question.question_type === 'single_choice' || question.question_type === 'multiple_choice') {
    return Array.isArray(question.answer) && question.answer.length > 0;
  }
  if (
    question.question_type === 'fill_in_the_blank' ||
    question.question_type === 'cloze' ||
    question.question_type === 'fill_with_candidates'
  ) {
    return fillBlanksHaveAnswers(question.question_type, question.blanks ?? []);
  }
  return question.has_answer;
}

function QuizRichField({
  allowBlankInsertion = false,
  historyGroup,
  imageInsertion,
  label,
  onChange,
  onHistoryGroupEnd,
  translate,
  value,
}: {
  allowBlankInsertion?: boolean;
  historyGroup: string;
  imageInsertion?: RichTextImageInsertion;
  label: string;
  onChange: (value: RichTextDocument, metadata?: ReachDeckHistoryMetadata) => void;
  onHistoryGroupEnd: () => void;
  translate?: ReachDeckTranslate;
  value: RichTextDocument;
}) {
  const labelId = useId();
  // 不能用 <label> 包裹富文本编辑器：label 会把悬停 / 点击转发给第一个可标注后代——
  // 格式栏里的「撤销」按钮，导致指针一进题干区「撤销」就被激活、点击即撤销刚输入的内容。
  // 编辑面本身已用 aria-label 命名，这里只用 group + aria-labelledby 关联可见标题。
  return (
    <div aria-labelledby={labelId} className="reach-deck-editor__quiz-rich-field" role="group">
      <span id={labelId}>{label}</span>
      <RichTextElementEditor
        allowQuizBlankInsertion={allowBlankInsertion}
        historyGroup={historyGroup}
        {...(imageInsertion === undefined ? {} : { imageInsertion })}
        label={label}
        onChange={onChange}
        onHistoryGroupEnd={onHistoryGroupEnd}
        showFontControls={false}
        // 题干 / 选项 / 解析是文档语义：从 Word 复制的表格与小标题属于题目内容本身，
        // 展平成段落就是丢信息。幻灯片文本框仍走 slide 档位。
        surface="document"
        toolbarVisibility="focus"
        translate={translate}
        value={value}
      />
    </div>
  );
}

function InteractiveSceneToolbar({
  disabled,
  page,
  onUpdate,
  translate,
}: {
  disabled: boolean;
  page: InteractivePage;
  onUpdate: (update: (page: ReachDeckPublishedPage) => ReachDeckPublishedPage) => void;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const updatePolicy = (patch: Partial<InteractivePage['scene']['runtimePolicy']>) =>
    onUpdate((current) =>
      current.sceneType === 'interactive'
        ? {
            ...current,
            scene: {
              ...current.scene,
              runtimePolicy: { ...current.scene.runtimePolicy, ...patch },
            },
          }
        : current,
    );

  return (
    <>
      <span className="reach-deck-editor__toolbar-scope">
        {text('reachDeck.editor.scene.interactiveScope', '互动')}
      </span>
      <label className="reach-deck-editor__interactive-toolbar-field">
        <span className="reach-deck-editor__toolbar-field-label">
          {text('reachDeck.editor.scene.completionMode', '完成方式')}
        </span>
        <select
          aria-label={text('reachDeck.editor.scene.interactiveCompletionMode', '互动完成方式')}
          disabled={disabled}
          onChange={(event) =>
            updatePolicy({
              completionMode: event.target.value as 'explicit' | 'automatic' | 'none',
            })
          }
          value={page.scene.runtimePolicy.completionMode}
        >
          <option value="none">
            {text('reachDeck.editor.scene.completion.none', '不要求完成')}
          </option>
          <option value="explicit">
            {text('reachDeck.editor.scene.completion.explicit', '学习者确认')}
          </option>
          <option value="automatic">
            {text('reachDeck.editor.scene.completion.automatic', '自动完成')}
          </option>
        </select>
      </label>
      <label className="reach-deck-editor__interactive-toolbar-field">
        <span className="reach-deck-editor__toolbar-field-label">
          {text('reachDeck.editor.scene.allowedDuration', '允许时长')}
        </span>
        <input
          aria-label={text('reachDeck.editor.scene.interactiveMaximumDuration', '互动允许时长')}
          disabled={disabled}
          max={3600}
          min={1}
          onChange={(event) => {
            if (event.target.value === '') {
              updatePolicy({ maximumDurationSeconds: null });
              return;
            }
            const maximumDurationSeconds = Number(event.target.value);
            if (
              !Number.isInteger(maximumDurationSeconds) ||
              maximumDurationSeconds < 1 ||
              maximumDurationSeconds > 3600
            )
              return;
            updatePolicy({ maximumDurationSeconds });
          }}
          placeholder={text('reachDeck.editor.scene.durationUnlimited', '不限时')}
          title={text(
            'reachDeck.editor.scene.interactiveDurationHint',
            '留空表示不限时；如需限制，请输入 1–3600 秒',
          )}
          type="number"
          value={page.scene.runtimePolicy.maximumDurationSeconds ?? ''}
        />
        <span className="reach-deck-editor__interactive-duration-unit">
          {text('reachDeck.editor.scene.durationSecondsUnit', '秒')}
        </span>
      </label>
      <label className="reach-deck-editor__interactive-toolbar-check">
        <input
          checked={page.scene.runtimePolicy.allowReset}
          disabled={disabled}
          onChange={(event) => updatePolicy({ allowReset: event.target.checked })}
          type="checkbox"
        />
        <RefreshCw aria-hidden size={13} />
        <span>{text('reachDeck.editor.scene.allowReset', '允许重置')}</span>
      </label>
    </>
  );
}

const MARKER_OPTIONS = [
  ['none', '无'],
  ['arrow', '箭头'],
  ['triangle', '三角'],
  ['diamond', '菱形'],
  ['oval', '圆点'],
] as const;

/**
 * 与文字工具栏同行的对象格式条。控件复用富文本工具栏的类名，
 * 开头的作用域标签把"形状/连接线"的颜色与"文字"的颜色区分开。
 */
function NativeV2StyleToolbar({
  disabled,
  element,
  onUpdate,
}: {
  disabled: boolean;
  element: Extract<ReachDeckNativeElementV2, { type: 'shape' | 'line' }>;
  onUpdate: (update: (element: ReachDeckNativeElementV2) => ReachDeckNativeElementV2) => void;
}) {
  const colorValue = (color: { kind: string; value?: string } | undefined, fallback: string) =>
    color?.kind === 'srgb' && color.value !== undefined ? color.value : fallback;

  if (element.type === 'line') {
    return (
      <div
        aria-label="连接线样式"
        className="reach-deck-editor__rich-text-toolbar reach-deck-editor__object-toolbar"
        role="toolbar"
      >
        <span className="reach-deck-editor__toolbar-scope">连接线</span>
        <span className="reach-deck-editor__rich-text-divider" />
        <label className="reach-deck-editor__rich-text-color">
          <span className="reach-deck-editor__toolbar-field-label">线条颜色</span>
          <input
            aria-label="连接线颜色"
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value.toUpperCase();
              onUpdate((current) =>
                current.type === 'line'
                  ? { ...current, stroke: { ...current.stroke, fill: { kind: 'srgb', value } } }
                  : current,
              );
            }}
            type="color"
            value={colorValue(element.stroke.fill, '#000000')}
          />
        </label>
        <label className="reach-deck-editor__rich-text-field">
          <span className="reach-deck-editor__toolbar-field-label">线宽</span>
          <input
            aria-label="连接线线宽"
            disabled={disabled}
            min={0.25}
            onChange={(event) => {
              const width = Number(event.target.value);
              if (!Number.isFinite(width) || width <= 0) return;
              onUpdate((current) =>
                current.type === 'line'
                  ? { ...current, stroke: { ...current.stroke, width } }
                  : current,
              );
            }}
            step={0.25}
            type="number"
            value={element.stroke.width}
          />
        </label>
        <span className="reach-deck-editor__rich-text-divider" />
        {(['start', 'end'] as const).map((endpoint) => (
          <label className="reach-deck-editor__rich-text-field" key={endpoint}>
            <span className="reach-deck-editor__toolbar-field-label">
              {endpoint === 'start' ? '起点' : '终点'}
            </span>
            <select
              aria-label={endpoint === 'start' ? '起点箭头' : '终点箭头'}
              disabled={disabled}
              onChange={(event) => {
                const marker = event.target.value as
                  | 'none'
                  | 'arrow'
                  | 'diamond'
                  | 'oval'
                  | 'triangle';
                onUpdate((current) => {
                  if (current.type !== 'line') return current;
                  const point = { ...current[endpoint] };
                  if (marker === 'none') delete point.marker;
                  else point.marker = marker;
                  return { ...current, [endpoint]: point };
                });
              }}
              value={element[endpoint].marker ?? 'none'}
            >
              {MARKER_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    );
  }

  const fill = element.style.fill;
  const stroke = element.style.stroke;
  const fillEnabled = fill !== undefined && fill.kind !== 'none';
  return (
    <div
      aria-label="形状样式"
      className="reach-deck-editor__rich-text-toolbar reach-deck-editor__object-toolbar"
      role="toolbar"
    >
      <span className="reach-deck-editor__toolbar-scope">形状</span>
      <span className="reach-deck-editor__rich-text-divider" />
      <button
        aria-label="形状是否填充"
        aria-pressed={fillEnabled}
        className="reach-deck-editor__rich-text-button"
        disabled={disabled}
        onClick={() =>
          onUpdate((current) =>
            current.type === 'shape'
              ? {
                  ...current,
                  style: {
                    ...current.style,
                    fill: fillEnabled
                      ? { kind: 'none' }
                      : { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
                  },
                }
              : current,
          )
        }
        title="形状是否填充"
        type="button"
      >
        填充
      </button>
      <label className="reach-deck-editor__rich-text-color">
        <span className="sr-only">形状填充颜色</span>
        <input
          aria-label="形状填充颜色"
          disabled={disabled || !fillEnabled}
          onChange={(event) => {
            const value = event.target.value.toUpperCase();
            onUpdate((current) =>
              current.type === 'shape'
                ? {
                    ...current,
                    style: {
                      ...current.style,
                      fill: { kind: 'solid', color: { kind: 'srgb', value } },
                    },
                  }
                : current,
            );
          }}
          type="color"
          value={colorValue(fill?.kind === 'solid' ? fill.color : undefined, '#FFFFFF')}
        />
      </label>
      <span className="reach-deck-editor__rich-text-divider" />
      <button
        aria-label="形状是否描边"
        aria-pressed={stroke !== undefined}
        className="reach-deck-editor__rich-text-button"
        disabled={disabled}
        onClick={() =>
          onUpdate((current) => {
            if (current.type !== 'shape') return current;
            const style = { ...current.style };
            if (style.stroke === undefined) {
              style.stroke = { width: 1, fill: { kind: 'srgb', value: '#111827' } };
            } else {
              delete style.stroke;
            }
            return { ...current, style };
          })
        }
        title="形状是否描边"
        type="button"
      >
        描边
      </button>
      <label className="reach-deck-editor__rich-text-color">
        <span className="sr-only">形状描边颜色</span>
        <input
          aria-label="形状描边颜色"
          disabled={disabled || stroke === undefined}
          onChange={(event) => {
            const value = event.target.value.toUpperCase();
            onUpdate((current) =>
              current.type === 'shape' && current.style.stroke !== undefined
                ? {
                    ...current,
                    style: {
                      ...current.style,
                      stroke: { ...current.style.stroke, fill: { kind: 'srgb', value } },
                    },
                  }
                : current,
            );
          }}
          type="color"
          value={colorValue(stroke?.fill, '#111827')}
        />
      </label>
      <label className="reach-deck-editor__rich-text-field">
        <span className="reach-deck-editor__toolbar-field-label">线宽</span>
        <input
          aria-label="形状描边线宽"
          disabled={disabled || stroke === undefined}
          min={0.25}
          onChange={(event) => {
            const width = Number(event.target.value);
            if (!Number.isFinite(width) || width <= 0) return;
            onUpdate((current) =>
              current.type === 'shape' && current.style.stroke !== undefined
                ? {
                    ...current,
                    style: {
                      ...current.style,
                      stroke: { ...current.style.stroke, width },
                    },
                  }
                : current,
            );
          }}
          step={0.25}
          type="number"
          value={stroke?.width ?? 1}
        />
      </label>
    </div>
  );
}

/** 未选中对象时的对象格式占位：结构与真实格式条一致，避免选中后画布跳动。 */
function NativeV2StyleToolbarPlaceholder() {
  return (
    <div
      aria-label="对象格式"
      className="reach-deck-editor__rich-text-toolbar reach-deck-editor__object-toolbar"
      data-placeholder="true"
      role="toolbar"
    >
      <span className="reach-deck-editor__toolbar-scope is-placeholder">对象</span>
      <span className="reach-deck-editor__rich-text-divider" />
      <button className="reach-deck-editor__rich-text-button" disabled type="button">
        填充
      </button>
      <span aria-hidden="true" className="reach-deck-editor__rich-text-color is-placeholder">
        <span className="reach-deck-editor__toolbar-swatch" />
      </span>
      <span className="reach-deck-editor__rich-text-divider" />
      <button className="reach-deck-editor__rich-text-button" disabled type="button">
        描边
      </button>
      <span aria-hidden="true" className="reach-deck-editor__rich-text-color is-placeholder">
        <span className="reach-deck-editor__toolbar-swatch" />
      </span>
    </div>
  );
}

const PAGE_LANE_ICONS: Record<ReachDeckPageLane, typeof LayoutTemplate> = {
  layout: LayoutTemplate,
  image: ImageIcon,
  narration: ScrollText,
  audio: Volume2,
  animation: Sparkles,
};
const PAGE_LANE_FALLBACK_LABELS: Record<ReachDeckPageLane, string> = {
  layout: '版面',
  image: '图片',
  narration: '讲稿',
  audio: '语音',
  animation: '动画',
};
const PAGE_LANE_STATE_FALLBACK_LABELS: Record<ReachDeckPageLaneState, string> = {
  ready: '已就绪',
  generating: '生成中',
  attention: '需要处理',
  none: '未生成',
};

/** 缩略图右上角的通道状态图标：绿=就绪、蓝=生成中、黄=需要教师处理、灰=尚无内容。 */
function PageLaneIndicators({
  statuses,
  text,
}: {
  statuses: Readonly<Partial<Record<ReachDeckPageLane, ReachDeckPageLaneState>>>;
  text: (key: string, fallback: string, replacements?: Record<string, string | number>) => string;
}) {
  const lanes = REACH_DECK_PAGE_LANES.filter((lane) => statuses[lane] !== undefined);
  if (lanes.length === 0) return null;
  return (
    <span
      aria-label={text('reachDeck.editor.pageLane.group', '页面生成状态')}
      className="reach-deck-editor__page-lanes"
      role="group"
    >
      {lanes.map((lane) => {
        const state = statuses[lane]!;
        const Icon = PAGE_LANE_ICONS[lane];
        const label = text('reachDeck.editor.pageLane.status', '{lane}：{state}', {
          lane: text(`reachDeck.editor.pageLane.${lane}`, PAGE_LANE_FALLBACK_LABELS[lane]),
          state: text(
            `reachDeck.editor.pageLane.state.${state}`,
            PAGE_LANE_STATE_FALLBACK_LABELS[state],
          ),
        });
        return (
          <span
            aria-label={label}
            className="reach-deck-editor__page-lane"
            data-lane={lane}
            data-state={state}
            key={lane}
            role="img"
            title={label}
          >
            <Icon aria-hidden size={11} strokeWidth={2.4} />
          </span>
        );
      })}
    </span>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="reach-deck-editor__property">
      <span>{label}</span>
      {children}
    </label>
  );
}

const LINE_SPACING_PRESETS = [1, 1.15, 1.5, 2] as const;
const LINE_SPACING_MIN = 0.5;
const LINE_SPACING_MAX = 5;
const FIXED_LINE_SPACING_MIN = 1;
const FIXED_LINE_SPACING_MAX = 500;
const LETTER_SPACING_MIN = -20;
const LETTER_SPACING_MAX = 100;

type LineSpacingMode = 'auto' | 'fixed' | 'mixed' | 'multiple';

function spacingDraft(value: RichTextSpacingValue): string {
  return value.kind === 'value' ? String(value.value) : '';
}

function lineSpacingMode(value: RichTextSpacingValue): LineSpacingMode {
  if (value.kind === 'absolute') return 'fixed';
  if (value.kind === 'mixed') return 'mixed';
  if (value.kind === 'unset') return 'auto';
  return 'multiple';
}

function lineSpacingDraft(value: RichTextSpacingValue, mode: LineSpacingMode): string {
  if (mode === 'fixed' && value.kind === 'absolute') return String(value.value);
  if (mode === 'multiple' && value.kind === 'value') return String(value.value);
  return '';
}

function clampSpacingDraft(value: string, minimum: number, maximum: number): number | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function TextSpacingControls({
  disabled,
  document,
  onChange,
  translate,
}: {
  disabled: boolean;
  document: RichTextDocument;
  onChange: (document: RichTextDocument) => void;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const lineSpacing = useMemo(() => richTextLineSpacing(document), [document]);
  const letterSpacing = useMemo(() => richTextLetterSpacing(document), [document]);
  const [lineMode, setLineMode] = useState<LineSpacingMode>(() => lineSpacingMode(lineSpacing));
  const [lineDraft, setLineDraft] = useState(() =>
    lineSpacingDraft(lineSpacing, lineSpacingMode(lineSpacing)),
  );
  const [letterDraft, setLetterDraft] = useState(() => spacingDraft(letterSpacing));

  useEffect(() => {
    const mode = lineSpacingMode(lineSpacing);
    setLineMode(mode);
    setLineDraft(lineSpacingDraft(lineSpacing, mode));
  }, [lineSpacing]);
  useEffect(() => setLetterDraft(spacingDraft(letterSpacing)), [letterSpacing]);

  const commitLineDraft = () => {
    if (lineMode === 'auto' || lineMode === 'mixed') return;
    const value = clampSpacingDraft(
      lineDraft,
      lineMode === 'fixed' ? FIXED_LINE_SPACING_MIN : LINE_SPACING_MIN,
      lineMode === 'fixed' ? FIXED_LINE_SPACING_MAX : LINE_SPACING_MAX,
    );
    if (value === undefined) {
      setLineDraft(lineSpacingDraft(lineSpacing, lineMode));
      return;
    }
    setLineDraft(String(value));
    if (lineMode === 'fixed') {
      if (lineSpacing.kind === 'absolute' && lineSpacing.value === value) return;
      onChange(setRichTextFixedLineSpacing(document, value));
      return;
    }
    if (lineSpacing.kind !== 'value' || lineSpacing.value !== value) {
      onChange(setRichTextLineSpacing(document, value));
    }
  };
  const commitLetterDraft = () => {
    const value = clampSpacingDraft(letterDraft, LETTER_SPACING_MIN, LETTER_SPACING_MAX);
    if (value === undefined) {
      setLetterDraft(spacingDraft(letterSpacing));
      return;
    }
    setLetterDraft(String(value));
    if (letterSpacing.kind === 'value' && letterSpacing.value === value) return;
    onChange(setRichTextLetterSpacing(document, value));
  };
  const lineMenuValue =
    lineMode === 'auto'
      ? 'auto'
      : lineMode === 'fixed'
        ? 'fixed'
        : lineMode === 'mixed'
          ? 'mixed'
          : lineSpacing.kind === 'value' &&
              LINE_SPACING_PRESETS.includes(
                lineSpacing.value as (typeof LINE_SPACING_PRESETS)[number],
              )
            ? String(lineSpacing.value)
            : 'multiple';

  return (
    <fieldset
      className="reach-deck-editor__text-spacing"
      disabled={disabled}
      data-rich-text-spacing
    >
      <legend>{text('reachDeck.editor.richText.spacing', '文本间距')}</legend>
      <label className="reach-deck-editor__text-spacing-row">
        <span>{text('reachDeck.editor.richText.lineSpacing', '行距')}</span>
        <select
          aria-label={text('reachDeck.editor.richText.lineSpacingPreset', '行距选项')}
          onChange={(event) => {
            if (event.target.value === 'auto') {
              setLineMode('auto');
              setLineDraft('');
              if (lineSpacing.kind !== 'unset') {
                onChange(setRichTextLineSpacing(document, undefined));
              }
              return;
            }
            if (event.target.value === 'multiple' || event.target.value === 'fixed') {
              const mode = event.target.value;
              setLineMode(mode);
              setLineDraft(lineSpacingDraft(lineSpacing, mode));
              return;
            }
            const value = Number(event.target.value);
            if (!Number.isFinite(value)) return;
            setLineMode('multiple');
            setLineDraft(String(value));
            onChange(setRichTextLineSpacing(document, value));
          }}
          value={lineMenuValue}
        >
          {lineSpacing.kind === 'mixed' ? (
            <option disabled value="mixed">
              {text('reachDeck.editor.richText.mixedSpacing', '混合值')}
            </option>
          ) : null}
          <option value="auto">{text('reachDeck.editor.richText.automaticSpacing', '自动')}</option>
          {LINE_SPACING_PRESETS.map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
          <option value="multiple">
            {text('reachDeck.editor.richText.lineSpacingMultiple', '多倍行距')}
          </option>
          <option value="fixed">
            {text('reachDeck.editor.richText.lineSpacingFixed', '固定值')}
          </option>
        </select>
        <span className="reach-deck-editor__text-spacing-number">
          <input
            aria-label={
              lineMode === 'fixed'
                ? text('reachDeck.editor.richText.lineSpacingFixedValue', '固定行距（像素）')
                : text('reachDeck.editor.richText.lineSpacingMultiplier', '行距倍数')
            }
            disabled={lineMode === 'auto' || lineMode === 'mixed'}
            inputMode="decimal"
            max={lineMode === 'fixed' ? FIXED_LINE_SPACING_MAX : LINE_SPACING_MAX}
            min={lineMode === 'fixed' ? FIXED_LINE_SPACING_MIN : LINE_SPACING_MIN}
            onBlur={commitLineDraft}
            onChange={(event) => setLineDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.preventDefault();
                setLineDraft(lineSpacingDraft(lineSpacing, lineMode));
              }
            }}
            placeholder="—"
            step={lineMode === 'fixed' ? 0.5 : 0.05}
            type="number"
            value={lineDraft}
          />
          <span aria-hidden>{lineMode === 'fixed' ? 'px' : '×'}</span>
        </span>
      </label>
      <label className="reach-deck-editor__text-spacing-row">
        <span>{text('reachDeck.editor.richText.letterSpacing', '字间距')}</span>
        <span className="reach-deck-editor__text-spacing-number is-wide">
          <input
            aria-label={text('reachDeck.editor.richText.letterSpacingPixels', '字间距（像素）')}
            inputMode="decimal"
            max={LETTER_SPACING_MAX}
            min={LETTER_SPACING_MIN}
            onBlur={commitLetterDraft}
            onChange={(event) => setLetterDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.preventDefault();
                setLetterDraft(spacingDraft(letterSpacing));
              }
            }}
            placeholder={letterSpacing.kind === 'mixed' ? '—' : '0'}
            step={0.1}
            type="number"
            value={letterDraft}
          />
          <span aria-hidden>px</span>
        </span>
      </label>
    </fieldset>
  );
}

/**
 * Detects the safe refresh window where an approved multi-page candidate was only partly
 * persisted. The current document must be an ordered subset of the candidate, contain at least
 * one candidate page in its final state, and must not contain a newer revision than the candidate
 * on any divergent page. This keeps an unrelated teacher edit cleanup-only instead of silently
 * overwriting it with the recovered proposal.
 */
function isRecoverablePartialDecksmithCandidate(
  current: ReachDeckDocument,
  candidate: ReachDeckDocument,
): boolean {
  if (current.schemaVersion !== candidate.schemaVersion) return false;
  const currentPages = [...current.pages].sort((left, right) => left.order - right.order);
  const candidatePages = [...candidate.pages].sort((left, right) => left.order - right.order);
  const candidateById = new Map(candidatePages.map((page) => [page.pageId, page]));
  if (currentPages.some((page) => !candidateById.has(page.pageId))) return false;
  let candidatePageIndex = 0;
  for (const page of currentPages) {
    while (candidatePageIndex < candidatePages.length) {
      if (candidatePages[candidatePageIndex]?.pageId === page.pageId) break;
      candidatePageIndex += 1;
    }
    if (candidatePageIndex >= candidatePages.length) return false;
    candidatePageIndex += 1;
  }

  const candidateBindingById =
    candidate.schemaVersion === 'reach-deck-document/v2'
      ? new Map(candidate.nativeSlides.map((binding) => [binding.pageId, binding] as const))
      : undefined;
  const currentBindingById =
    current.schemaVersion === 'reach-deck-document/v2'
      ? new Map(current.nativeSlides.map((binding) => [binding.pageId, binding] as const))
      : undefined;
  let matchingPages = 0;
  let divergentPages = 0;
  for (const currentPage of currentPages) {
    const candidatePage = candidateById.get(currentPage.pageId)!;
    const pageMatches =
      reachDeckPageContentEqual(currentPage, candidatePage) &&
      (candidateBindingById === undefined ||
        reachDeckValuesEqual(
          currentBindingById?.get(currentPage.pageId),
          candidateBindingById.get(currentPage.pageId),
        ));
    if (pageMatches) {
      matchingPages += 1;
      continue;
    }
    if (currentPage.revision > candidatePage.revision) return false;
    divergentPages += 1;
  }
  const missingCandidatePages = candidatePages.length - currentPages.length;
  return matchingPages > 0 && (missingCandidatePages > 0 || divergentPages > 0);
}

function editorValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => editorValuesEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && editorValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function defaultIdFactory(prefix: string): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return prefix + '-' + suffix;
}

/**
 * 编辑器内是否有"正在展示"的对话框。宿主的 popover（如批次进度弹层）常驻 DOM 且带
 * role=dialog，关闭时不能算作阻塞，否则 Delete/复制/粘贴快捷键会被永久吞掉。
 */
function deckEditorHasOpenDialog(root: HTMLElement | null): boolean {
  if (root === null) return false;
  return [...root.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some((node) => {
    if (!node.hasAttribute('popover')) return true;
    try {
      return node.matches(':popover-open');
    } catch {
      return false;
    }
  });
}

/** 隐藏的组合会隐藏整棵子树，画布重试入口沿用同一可见性。 */
function nativeElementIsHidden(elements: readonly ReachDeckNativeElementV2[], id: string): boolean {
  for (const element of elements) {
    if (!nativeElementContainsId(element, id)) continue;
    return (
      element.hidden === true ||
      (element.type === 'group' && nativeElementIsHidden(element.children, id))
    );
  }
  return false;
}

function nativeElementContainsId(element: ReachDeckNativeElementV2, id: string): boolean {
  return (
    element.id === id ||
    (element.type === 'group' &&
      element.children.some((child) => nativeElementContainsId(child, id)))
  );
}

function pageRailMultiSelectModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
}

function readClipboardText(clipboardData: DataTransfer, type: string): string {
  try {
    return clipboardData.getData(type);
  } catch {
    return '';
  }
}

function clipboardContainsType(clipboardData: DataTransfer, type: string): boolean {
  try {
    const normalized = type.toLowerCase();
    return Array.from(clipboardData.types).some(
      (candidate) => candidate.toLowerCase() === normalized,
    );
  } catch {
    return false;
  }
}

function assertNever(value: never): never {
  throw new Error('Unsupported Reach Deck editor value: ' + String(value));
}
