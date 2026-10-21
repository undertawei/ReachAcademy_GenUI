'use client';

import { TeacherLoadingIcon, TeacherLoadingRegion } from '../TeacherLoading';

import { TeacherReturnLink } from '@/src/components/TeacherBrowseNavigation';

import { describeGuardrailError } from '@/src/lib/ai-guardrail-error';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { DragDropContext, Draggable, Droppable, type DropResult } from '@hello-pangea/dnd';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BookOpenCheck,
  Check,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  FilePlus2,
  FileText,
  FileUp,
  Globe2,
  Layers3,
  ListChecks,
  MessageSquareText,
  MonitorPlay,
  MousePointerClick,
  Pencil,
  Plus,
  Presentation,
  Save,
  ScrollText,
  Send,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  deriveGenerationInFlightPageIds,
  deriveRenderablePageIds,
  isReachDeckDocumentReadyForPlayback,
  applyPageInstructionalSpec,
  getPageInstructionalSpec,
  REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3,
  richTextFromPlainText,
  richTextHasRenderableContent,
  SLIDE_CONTENT_TYPES,
  type LessonPlan,
  type ReachDeckDocument,
  type PageInstructionalSpec,
  type PageOutline,
  type PagedDeckOutline,
  type RichTextDocument,
  type SlideOutlineClassification,
} from '@reachany/reach-deck-dsl';
import {
  type ReachDeckGenerationPanelJob,
  type ReachDeckGenerationPanelProps,
} from '@reachany/reach-deck-editor';
import { createReachDeckUuid, type ReachDeckWorkspaceBatchView } from '@reachany/reach-deck-client';
import {
  Button,
  ConfirmDialog,
  Dialog,
  IconButton,
  InlineNotice,
  Input,
  Popover,
  ProgressBar,
  RadioGroup,
  Select,
  Tooltip,
} from '@reachany/ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import { DraftNumberInput } from '@/src/components/DraftNumberInput';
import { QuizRichTextEditor } from '@/src/components/teacher/QuizRichTextEditor';
import { markdownToTiptapJson, tiptapJsonToMarkdown } from '@/src/lib/quiz/markdown-to-tiptap';

import styles from './ReachDeckAuthoringFlow.module.css';
import {
  pageActivityFailed,
  pendingPageActivityHasJob,
  pageActivityKindKey,
  pageActivityLabelKey,
  pageActivityProgress,
  selectStandalonePageJobs,
  type PendingPageActivity,
} from './reach-deck-page-activity';
import { isSameOrNewerGenerationJob } from './generation-job-order.js';
import { LessonKnowledgePoints } from './ReachDeckTeachingSemantics';
import { ReachDeckMaterialReferenceDialog } from './ReachDeckMaterialReferenceDialog';
import {
  editableLessonObjectives,
  editableSavedLessonPlan,
  LessonObjectivesEditor,
  LessonStoryEditor,
} from './ReachDeckLessonStructureEditor';
import { ReachDeckPageSpecEditor } from './ReachDeckPageSpecEditor';
import {
  isReachDeckBatchMemberUnfinished,
  presentReachDeckBatchPages,
  reachDeckBatchCancellationScopeSignature,
  reachDeckBatchStatusLabel,
  reachDeckBatchUnfinishedMembers,
  selectCurrentReachDeckBatches,
  summarizeReachDeckBatch,
  type ReachDeckBatchPageStatusTone,
  type ReachDeckBatchSummary,
} from './reach-deck-batch-presenter';

/**
 * Reach Deck 分阶段生成流程（正式版）。
 *
 * 需求收集 → 教学计划 → 页面大纲 → 分页生成 → 编辑，
 * 流程数据全部通过真实工作区控制器连接 Reach Deck 服务。
 *
 * 关键契约：
 * 1. 教案与大纲候选都可以由教师修改并采用；采用时会终止后续任务并使派生内容失效。
 * 2. 分页生成阶段的推进权在 AI Runtime：大纲采用后由版面 lane 与讲稿 lane 各自按页
 *    推进；版面落地即预览，讲稿与音频异步回填。本组件只在回合开始时物化占位文档，
 *    此后展示进度并提供手动重试。
 */

type FlowStep = 'brief' | 'lesson-plan' | 'page-outline' | 'studio';
type BriefMode = 'create' | 'import';
type ReachDeckGenerationLanguage = 'follow-system' | 'zh-CN' | 'en-US';

const MAX_BRIEF_FILES = 10;
const DOCUMENT_FILE_LIMIT = 50 * 1024 * 1024;
const IMAGE_FILE_LIMIT = 15 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'xlsx']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const AGGREGATE_FILE_LIMIT = 200 * 1024 * 1024;
const BRIEF_POWERED_BY = [
  'OpenMAIC',
  'MiniMax pptx-generator',
  'ppt-master',
  'frontend-slides',
  'pptx-from-layouts',
] as const;

function fileExtension(file: File): string {
  return file.name.toLowerCase().split('.').pop() ?? '';
}

function fileKey(file: File): string {
  return `${file.name.toLowerCase()}\u0000${file.size}\u0000${file.lastModified}`;
}

function browserGenerationLanguage(): 'zh-CN' | 'en-US' {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

async function contentHash(file: File): Promise<string> {
  const bytes =
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : new TextEncoder().encode(
          typeof file.text === 'function'
            ? await file.text()
            : `${file.name}\u0000${file.size}\u0000${file.lastModified}`,
        );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function briefFileLimit(file: File): number | undefined {
  const extension = fileExtension(file);
  if (DOCUMENT_EXTENSIONS.has(extension)) return DOCUMENT_FILE_LIMIT;
  if (IMAGE_EXTENSIONS.has(extension)) return IMAGE_FILE_LIMIT;
  return undefined;
}

export interface ReachDeckDocumentActions {
  busy?: 'trial' | 'save' | 'publish';
  disabled: boolean;
  onPublish: () => Promise<void> | void;
  onSave: () => Promise<void> | void;
  onTrial: (returnFocusTo?: HTMLElement) => Promise<void> | void;
  status?: string;
  statusTone?: 'error' | 'success';
}

export interface ReachDeckStudioChrome {
  /**
   * Legacy insertion point kept for host compatibility; activity now lives in the Flow toolbar.
   */
  canvasCornerAction?: ReactNode;
  commandBar?: ReactNode;
  narrationPanelAction?: ReactNode;
  pageRailHeader?: ReactNode;
  rightPanelAction?: ReactNode;
}

const steps: Array<{
  id: FlowStep;
  labelKey: string;
  noteKey: string;
  icon: typeof Sparkles;
}> = [
  {
    id: 'brief',
    labelKey: 'reachDeck.flow.step.brief',
    noteKey: 'reachDeck.flow.step.briefNote',
    icon: MessageSquareText,
  },
  {
    id: 'lesson-plan',
    labelKey: 'reachDeck.flow.step.lessonPlan',
    noteKey: 'reachDeck.flow.step.lessonPlanNote',
    icon: BookOpenCheck,
  },
  {
    id: 'page-outline',
    labelKey: 'reachDeck.flow.step.pageOutline',
    noteKey: 'reachDeck.flow.step.pageOutlineNote',
    icon: Layers3,
  },
  {
    id: 'studio',
    labelKey: 'reachDeck.flow.step.studio',
    noteKey: 'reachDeck.flow.step.studioNote',
    icon: Presentation,
  },
];

const stepIndex = (step: FlowStep) => steps.findIndex((candidate) => candidate.id === step);
const importedSteps = steps.filter((step) => step.id === 'brief' || step.id === 'studio');
const pptxImportRunId = /^pptx-import-[a-f0-9]{32}$/;
const maicImportRunId = /^maic-import-[a-f0-9]{32}$/;
const lessonPrepRunId =
  /^lesson-prep-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const marketplaceCopyRunId =
  /^marketplace-copy-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function restoreFlowStageFocus(step: FlowStep, stagesLabel: string): void {
  window.requestAnimationFrame(() => {
    const selectTrigger = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.getAttribute('aria-haspopup') === 'listbox' &&
        button.getAttribute('aria-label') === stagesLabel,
    );
    const stepButton = document.querySelector<HTMLButtonElement>(`[data-flow-step="${step}"]`);
    (selectTrigger ?? stepButton)?.focus();
  });
}

function isImportedCreateWorkspace(workspace: ReachDeckGenerationPanelProps['workspace']): boolean {
  if (workspace === undefined) return false;
  return (
    (workspace.source === 'pptx-import' && pptxImportRunId.test(workspace.runId)) ||
    (workspace.source === 'maic-import' && maicImportRunId.test(workspace.runId)) ||
    (workspace.source === 'manual-empty' && workspace.runId.startsWith('blank-'))
  );
}

function isMaterializedLessonPrepWorkspace(
  workspace: ReachDeckGenerationPanelProps['workspace'],
): boolean {
  return (
    workspace !== undefined &&
    workspace.source === 'lesson-prep' &&
    lessonPrepRunId.test(workspace.runId) &&
    workspace.baseDocument !== undefined
  );
}

/**
 * 市场复制出来的草稿没有生成回合:`ReachDeckCopyWorkspaceFactory` 造的是恢复壳,
 * `targetPageIds` 恒为空、`stage` 恒为 `lesson-plan`,所以「有产出页」和「阶段已完成」
 * 两条都不可能命中。产出本身已经现成躺在 `baseDocument` 里,和教案备课一样按来源放行;
 * 内容是否真能播放仍由 `isReachDeckDocumentReadyForPlayback` 独立把关。
 */
function isMaterializedMarketplaceCopyWorkspace(
  workspace: ReachDeckGenerationPanelProps['workspace'],
): boolean {
  return (
    workspace !== undefined &&
    (workspace.stage === 'copied' || workspace.source === 'marketplace-copy') &&
    marketplaceCopyRunId.test(workspace.runId) &&
    workspace.baseDocument !== undefined
  );
}

export function isReachDeckDocumentReady(
  materialized: boolean,
  workspace: ReachDeckGenerationPanelProps['workspace'],
  document?: ReachDeckDocument,
): boolean {
  return (
    materialized &&
    (document === undefined || isReachDeckDocumentReadyForPlayback(document)) &&
    workspace !== undefined &&
    deriveGenerationInFlightPageIds(workspace).length === 0 &&
    (isImportedCreateWorkspace(workspace) ||
      isMaterializedLessonPrepWorkspace(workspace) ||
      isMaterializedMarketplaceCopyWorkspace(workspace) ||
      workspace.stage === 'complete' ||
      deriveRenderablePageIds(workspace).length > 0)
  );
}

function isImportSourceSentinel(source: string): boolean {
  return source === 'pptx-import' || source === 'maic-import' || source === 'manual-empty';
}
const outlineSceneTypes: PageOutline['sceneType'][] = ['slide', 'quiz', 'interactive'];
const outlineSceneTypeIcons: Record<PageOutline['sceneType'], typeof Presentation> = {
  slide: Presentation,
  quiz: ListChecks,
  interactive: MousePointerClick,
};
/** 默认启用的页面类型:slide 恒定启用(锁定),quiz/interactive 默认勾选。 */
const defaultEnabledSceneTypes: PageOutline['sceneType'][] = ['slide', 'quiz', 'interactive'];

export function ReachDeckAuthoringFlow({
  backHref,
  batches = [],
  deckGenerationBlockedReason,
  documentActions,
  editor,
  initialWorkspaceLoading = false,
  importPanel,
  materialized,
  materializedDocument,
  moduleTitle,
  onRenameModule,
  onRequestRegeneration,
  onRequestMediaDeletion,
  onViewStageChange,
  onRequestMaicCreate,
  onRequestBlankCreate,
  onRequestPptxCreate,
  onCancelWorkspaceBatch,
  onInspectWorkspaceBatch,
  pageErrorHandledByEditor = false,
  panelProps,
  pendingPageActivities = [],
}: {
  pendingPageActivities?: readonly PendingPageActivity[];
  backHref?: string;
  batches?: readonly ReachDeckWorkspaceBatchView[];
  /** Deck-wide narration/media regeneration would conflict with a running operation (Decksmith). */
  deckGenerationBlockedReason?: string;
  documentActions?: ReachDeckDocumentActions;
  editor: ReactNode | ((chrome: ReachDeckStudioChrome) => ReactNode);
  initialWorkspaceLoading?: boolean;
  importPanel?: ReactNode;
  materialized: boolean;
  materializedDocument?: ReachDeckDocument;
  moduleTitle: string;
  onRenameModule?: (title: string) => Promise<void>;
  onRequestRegeneration?: () => void;
  /** 打开“一键删除”弹窗（删除整份课件的音频/动画）；缺省不显示按钮。 */
  onRequestMediaDeletion?: () => void;
  onViewStageChange?: () => void;
  onRequestMaicCreate?: () => void;
  onRequestBlankCreate?: () => Promise<void> | void;
  onRequestPptxCreate?: () => void;
  onCancelWorkspaceBatch?: (batchId: string) => Promise<void> | void;
  onInspectWorkspaceBatch?: (batchId: string) => Promise<ReachDeckWorkspaceBatchView>;
  /** The active page canvas/timeline owns this action failure and already renders its overlay. */
  pageErrorHandledByEditor?: boolean;
  panelProps: ReachDeckGenerationPanelProps;
}) {
  const { t } = usePortalI18n();
  const { workspace } = panelProps;
  const legacyCopyShell =
    workspace?.source === 'marketplace-copy' && marketplaceCopyRunId.test(workspace.runId);
  const copiedWithoutBrief = workspace?.stage === 'copied' && workspace.source.trim() === '';
  const effectiveLessonPlan = workspace?.stagedLessonPlan ?? workspace?.lessonPlan;
  // Discard candidates generated from the old COPY sentinel, rather than presenting them as history.
  const jobs = panelProps.jobs.filter((job) => {
    if (job.kind !== 'lesson-plan' && job.kind !== 'page-outline') return true;
    if (legacyCopyShell) return false;
    if (!copiedWithoutBrief) return true;
    return job.kind === 'page-outline' && effectiveLessonPlan !== undefined;
  });
  const importedWorkflow = isImportedCreateWorkspace(workspace);
  const documentReady = isReachDeckDocumentReady(materialized, workspace, materializedDocument);
  const currentBatches = selectCurrentReachDeckBatches(batches, workspace?.runId);
  const singleJobs = selectStandalonePageJobs(jobs, workspace, batches, materializedDocument);
  const pendingSingles = (
    [...pendingPageActivities, ...(panelProps.pendingPageActivities ?? [])] as PendingPageActivity[]
  ).filter(
    (activity, index, entries) =>
      activity.runId === workspace?.runId &&
      !pendingPageActivityHasJob(activity, singleJobs) &&
      entries.findIndex(
        (other) => other.pageId === activity.pageId && other.runId === activity.runId,
      ) === index,
  );
  const selectableSteps = importedWorkflow ? importedSteps : steps;
  const preparingMaterials = !importedWorkflow && panelProps.busyAction === 'create-workspace';
  const workflowStep: FlowStep = importedWorkflow
    ? materialized
      ? 'studio'
      : 'brief'
    : materialized
      ? 'studio'
      : preparingMaterials
        ? 'lesson-plan'
        : workspace === undefined
          ? 'brief'
          : workspace.stage === 'lesson-plan'
            ? 'lesson-plan'
            : workspace.stage === 'page-outline'
              ? 'page-outline'
              : 'studio';
  const [viewedStep, setViewedStep] = useState<FlowStep>();
  const visibleStep = preparingMaterials
    ? 'lesson-plan'
    : viewedStep !== undefined &&
        selectableSteps.some((step) => step.id === viewedStep) &&
        stepIndex(viewedStep) <= stepIndex(workflowStep)
      ? viewedStep
      : workflowStep;
  const autoStarted = useRef(new Set<string>());
  const materializeSignature = useRef<string | undefined>(undefined);
  // 教师在教学设计步勾选的页面类型集合;发起大纲生成时随请求下发,
  // 模型只会在启用集合内选择场景。仅前端会话内状态,刷新后回落默认集合。
  const [enabledSceneTypes, setEnabledSceneTypes] =
    useState<PageOutline['sceneType'][]>(defaultEnabledSceneTypes);
  // 教案/大纲草稿提升到父组件:步骤屏是条件渲染,切步骤时子屏卸载,
  // 草稿留在父级才能保住未采用的编辑;签名 ref 同步提升,子屏重挂载时
  // 加载 effect 依据签名跳过重置。仅会话内暂存,刷新后回落服务端已采用版本。
  const [briefFiles, setBriefFiles] = useState<File[]>([]);
  const [briefWebSearch, setBriefWebSearch] = useState(false);
  const [briefGenerationLanguage, setBriefGenerationLanguage] =
    useState<ReachDeckGenerationLanguage>('follow-system');
  const [briefMode, setBriefMode] = useState<BriefMode>(importedWorkflow ? 'import' : 'create');
  type FlowConfirmation =
    | { kind: 'cancel-job'; jobId: string }
    | {
        batch: ReachDeckWorkspaceBatchView;
        kind: 'cancel-batch';
        scopeChanged: boolean;
        scopeSignature: string;
      }
    | { kind: 'restore-prior' };
  const [pendingConfirmation, setPendingConfirmation] = useState<FlowConfirmation>();
  const [batchConfirmationBusy, setBatchConfirmationBusy] = useState(false);
  const [batchConfirmationError, setBatchConfirmationError] = useState<string>();
  /** 整份讲稿重新生成的确认框：完整流水线，或仅重写讲稿文字。 */
  const [narrationOverwriteDialog, setNarrationOverwriteDialog] = useState<'full' | 'text'>();
  const [mediaRegenerationDialog, setMediaRegenerationDialog] = useState(false);
  const [audioRegenerationDialog, setAudioRegenerationDialog] = useState(false);
  const [audioSubmissionBusy, setAudioSubmissionBusy] = useState(false);
  const [audioSubmissionError, setAudioSubmissionError] = useState<string>();
  const audioSubmissionRef = useRef(false);
  const audioCancelRef = useRef<HTMLButtonElement>(null);
  const deckActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const audioAnimationLabelId = useId();
  const [audioAnimationMode, setAudioAnimationMode] = useState<'preserve' | 'regenerate'>(
    'preserve',
  );
  const [animationRegenerationDialog, setAnimationRegenerationDialog] = useState(false);
  const [overwriteExistingNarration, setOverwriteExistingNarration] = useState(false);
  const [narrationInspection, setNarrationInspection] = useState({
    hasExistingNarration: false,
    hasInFlightNarration: false,
  });
  const confirmationResolverRef = useRef<(() => void) | undefined>(undefined);
  const batchCancellationRequestRef = useRef(false);
  const requestConfirmation = (confirmation: FlowConfirmation): Promise<void> =>
    new Promise((resolve) => {
      confirmationResolverRef.current = resolve;
      setPendingConfirmation(confirmation);
    });
  const requestBatchCancellation = async (batchId: string): Promise<void> => {
    if (
      onInspectWorkspaceBatch === undefined ||
      onCancelWorkspaceBatch === undefined ||
      batchCancellationRequestRef.current
    ) {
      return;
    }
    batchCancellationRequestRef.current = true;
    setBatchConfirmationBusy(true);
    setBatchConfirmationError(undefined);
    try {
      const batch = await onInspectWorkspaceBatch(batchId);
      if (reachDeckBatchUnfinishedMembers(batch).length === 0) return;
      setBatchConfirmationBusy(false);
      await requestConfirmation({
        batch,
        kind: 'cancel-batch',
        scopeChanged: false,
        scopeSignature: reachDeckBatchCancellationScopeSignature(batch),
      });
    } catch {
      setBatchConfirmationError(t('reachDeck.batch.cancel.scopeLoadFailed'));
    } finally {
      batchCancellationRequestRef.current = false;
      setBatchConfirmationBusy(false);
    }
  };
  const requestJobCancellation = (jobId: string): Promise<void> => {
    const owningBatch = [...selectCurrentReachDeckBatches(batches, workspace?.runId)]
      .reverse()
      .find(
        (batch) =>
          batch.status === 'active' &&
          batch.members.some(
            (member) => member.jobId === jobId && isReachDeckBatchMemberUnfinished(member),
          ),
      );
    return owningBatch === undefined
      ? requestConfirmation({ kind: 'cancel-job', jobId })
      : requestBatchCancellation(owningBatch.batchId);
  };
  const guardedPanelProps: ReachDeckGenerationPanelProps = {
    ...panelProps,
    onCancelJob: requestJobCancellation,
    ...(panelProps.onRestorePriorGeneration === undefined
      ? {}
      : {
          onRestorePriorGeneration: () => requestConfirmation({ kind: 'restore-prior' }),
        }),
  };
  const resolveConfirmation = async (confirmed: boolean) => {
    const pending = pendingConfirmation;
    if (!confirmed || pending === undefined) {
      const resolve = confirmationResolverRef.current;
      confirmationResolverRef.current = undefined;
      setPendingConfirmation(undefined);
      setBatchConfirmationError(undefined);
      resolve?.();
      return;
    }
    if (pending.kind === 'cancel-batch') {
      if (onInspectWorkspaceBatch === undefined || onCancelWorkspaceBatch === undefined) return;
      setBatchConfirmationBusy(true);
      setBatchConfirmationError(undefined);
      try {
        const latest = await onInspectWorkspaceBatch(pending.batch.batchId);
        const latestScopeSignature = reachDeckBatchCancellationScopeSignature(latest);
        if (reachDeckBatchUnfinishedMembers(latest).length === 0) {
          const resolve = confirmationResolverRef.current;
          confirmationResolverRef.current = undefined;
          setPendingConfirmation(undefined);
          resolve?.();
          return;
        }
        if (latestScopeSignature !== pending.scopeSignature) {
          setPendingConfirmation({
            batch: latest,
            kind: 'cancel-batch',
            scopeChanged: true,
            scopeSignature: latestScopeSignature,
          });
          return;
        }
        try {
          await onCancelWorkspaceBatch(latest.batchId);
        } catch {
          setBatchConfirmationError(t('reachDeck.batch.cancel.actionFailed'));
          return;
        }
        const resolve = confirmationResolverRef.current;
        confirmationResolverRef.current = undefined;
        setPendingConfirmation(undefined);
        resolve?.();
      } catch {
        setBatchConfirmationError(t('reachDeck.batch.cancel.scopeLoadFailed'));
      } finally {
        setBatchConfirmationBusy(false);
      }
      return;
    }
    const resolve = confirmationResolverRef.current;
    confirmationResolverRef.current = undefined;
    setPendingConfirmation(undefined);
    try {
      if (pending.kind === 'cancel-job') await panelProps.onCancelJob(pending.jobId);
      else await panelProps.onRestorePriorGeneration?.();
    } finally {
      resolve?.();
    }
  };

  const requestRegenerateAllNarration = async (mode: 'full' | 'text') => {
    if (panelProps.onRegenerateAllNarration === undefined) return;
    const inspection = (await panelProps.onInspectAllNarration?.()) ?? {
      hasExistingNarration: false,
      hasInFlightNarration: false,
    };
    setNarrationInspection(inspection);
    setOverwriteExistingNarration(false);
    setNarrationOverwriteDialog(mode);
  };

  const confirmRegenerateAllNarration = async () => {
    const mode = narrationOverwriteDialog;
    setNarrationOverwriteDialog(undefined);
    await panelProps.onRegenerateAllNarration?.({
      overwriteExisting: overwriteExistingNarration,
      ...(mode === 'text' ? { textOnly: true } : {}),
    });
  };
  const [lessonPlanDraftForm, setLessonPlanDraftForm] = useState<LessonPlanForm>();
  const loadedPlanSignature = useRef<string | undefined>(undefined);
  const [outlineDraft, setOutlineDraft] = useState<PagedDeckOutline>();
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const loadedOutlineSignature = useRef<string | undefined>(undefined);
  const toggleSceneType = (sceneType: PageOutline['sceneType']) => {
    if (sceneType === 'slide') return;
    setEnabledSceneTypes((current) =>
      current.includes(sceneType)
        ? current.filter((candidate) => candidate !== sceneType)
        : [...current, sceneType],
    );
  };

  useEffect(() => {
    if (importedWorkflow) setBriefMode('import');
  }, [importedWorkflow]);

  useEffect(() => {
    if (workspace?.webSearch !== undefined) setBriefWebSearch(workspace.webSearch);
    if (workspace?.generationLanguage !== undefined) {
      setBriefGenerationLanguage(workspace.generationLanguage);
    }
  }, [workspace?.generationLanguage, workspace?.webSearch]);

  useEffect(() => {
    if (
      viewedStep !== undefined &&
      !selectableSteps.some((candidate) => candidate.id === viewedStep)
    ) {
      setViewedStep(undefined);
    }
  }, [selectableSteps, viewedStep]);

  // 需求重提交后 runId 不变;以"新出现的未完成教案任务"为信号离开需求回看视图。
  // 每个任务只弹跳一次:教师手动切回需求页查看同一个仍在运行的任务时,不应被反复弹走。
  const jumpedForJob = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (importedWorkflow) return;
    const lessonJob = findJob(jobs, 'lesson-plan');
    if (
      visibleStep === 'brief' &&
      workspace !== undefined &&
      lessonJob !== undefined &&
      !lessonJob.done &&
      lessonJob.jobId !== jumpedForJob.current
    ) {
      jumpedForJob.current = lessonJob.jobId;
      setViewedStep('lesson-plan');
    }
  }, [importedWorkflow, jobs, visibleStep, workspace]);

  // 采用暂存教案等操作会在教师回看教学设计页时触发新一轮大纲生成;
  // 与上面的需求跳转对称,同样以"新出现的未完成大纲任务"为信号离开教学设计回看视图,
  // 且每个任务只弹跳一次。
  const jumpedForOutlineJob = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (importedWorkflow) return;
    const outlineJob = findJob(jobs, 'page-outline');
    if (
      visibleStep === 'lesson-plan' &&
      workspace !== undefined &&
      outlineJob !== undefined &&
      !outlineJob.done &&
      outlineJob.jobId !== jumpedForOutlineJob.current
    ) {
      jumpedForOutlineJob.current = outlineJob.jobId;
      setViewedStep('page-outline');
    }
  }, [importedWorkflow, jobs, visibleStep, workspace]);

  // 生成中取消且本阶段没有可回落数据时,自动回退到上一阶段视图。
  // 有旧数据(此前采用过的教案/大纲)时无需处理:屏幕自然回落显示旧数据。
  useEffect(() => {
    if (importedWorkflow) return;
    const lessonJob = findJob(jobs, 'lesson-plan');
    if (
      visibleStep === 'lesson-plan' &&
      lessonJob !== undefined &&
      lessonJob.done &&
      lessonJob.status === 'cancelled' &&
      lessonJob.candidate === undefined &&
      workspace?.lessonPlan === undefined
    ) {
      setViewedStep('brief');
    }
    const outlineJob = findJob(jobs, 'page-outline');
    if (
      visibleStep === 'page-outline' &&
      outlineJob !== undefined &&
      outlineJob.done &&
      outlineJob.status === 'cancelled' &&
      outlineJob.candidate === undefined &&
      workspace?.pagedOutline === undefined
    ) {
      setViewedStep('lesson-plan');
    }
  }, [importedWorkflow, jobs, visibleStep, workspace]);

  // 进入教学计划 / 页面大纲阶段时自动发起首次生成（每个 run 只发一次）。
  // 关键:看到在途任务或已有成果(教案/大纲候选或已采用版本)时要"补记"启动标记,
  // 而不是留空等下一拍。首次启动可能由控制器发起(如采纳教案后自动开大纲),不经过
  // 这里;任务完成自动入库后会从任务列表移除,若此时才评估就会误判"从未生成过"而
  // 重复发起一次生成——表现为大纲已返回又跳回生成态。
  useEffect(() => {
    if (
      importedWorkflow ||
      workspace === undefined ||
      workspace.stage === 'copied' ||
      marketplaceCopyRunId.test(workspace.runId) ||
      panelProps.busyAction !== undefined
    )
      return;
    if (workspace.stage === 'lesson-plan') {
      const key = workspace.runId + ':lesson-plan';
      if (autoStarted.current.has(key)) return;
      if (findJob(jobs, 'lesson-plan') !== undefined || workspace.lessonPlan !== undefined) {
        autoStarted.current.add(key);
        return;
      }
      autoStarted.current.add(key);
      void panelProps.onStartLessonPlan();
      return;
    }
    if (workspace.stage === 'page-outline') {
      const key = workspace.runId + ':page-outline';
      if (autoStarted.current.has(key)) return;
      if (
        findJob(jobs, 'page-outline') !== undefined ||
        workspace.stagedPagedOutline !== undefined ||
        workspace.pagedOutline !== undefined
      ) {
        autoStarted.current.add(key);
        return;
      }
      autoStarted.current.add(key);
      void panelProps.onStartPageOutline(undefined, { enabledSceneTypes });
    }
  }, [enabledSceneTypes, importedWorkflow, jobs, panelProps, workspace]);

  /**
   * 回合开始时物化占位文档，教师即刻进入可编辑的第四步。
   *
   * 数据源：reach-deck 工作区（GenerationWorkspace，经真实控制器轮询）。
   * 核心逻辑：
   * 1. 首个可渲染页面落地后即物化；失败页没有旧工件时以生成失败占位页展示，
   *    有旧工件时继续保留旧内容；
   * 2. complete 阶段兜底触发保留（存量工作区可能跳过了页生成阶段的物化）；
   * 3. 动作用签名去重，失败（error 面板可见）后不会无限重放。
   *
   * 逐页生成的推进权在 AI Runtime：版面与讲稿两条 lane 独立按页推进，
   * 版面落地即预览，讲稿/音频随后二次回填（见 generation-chain.ts）。
   * 前端只展示进度、提供手动重试，不再有"自动推进"职责。
   */
  useEffect(() => {
    if (workspace === undefined || materialized || workspace.source === 'manual-empty') return;
    if (panelProps.busyAction !== undefined || panelProps.conflict === true) return;
    if (
      !isImportedCreateWorkspace(workspace) &&
      !isMaterializedLessonPrepWorkspace(workspace) &&
      deriveRenderablePageIds(workspace).length === 0
    ) {
      return;
    }
    const key = 'materialize:' + workspace.runId;
    if (materializeSignature.current === key) return;
    materializeSignature.current = key;
    void panelProps.onMaterialize();
  }, [materialized, panelProps, workspace]);

  const deckActionDisabled =
    audioSubmissionBusy ||
    guardedPanelProps.busyAction !== undefined ||
    deckGenerationBlockedReason !== undefined;
  const pendingAudioMode = panelProps.pendingMediaAnimationMode;
  const selectedAudioMode =
    pendingAudioMode === undefined || pendingAudioMode === 'animations'
      ? audioAnimationMode
      : pendingAudioMode;
  const submitAllAudio = async () => {
    if (
      audioSubmissionRef.current ||
      deckActionDisabled ||
      pendingAudioMode === 'animations' ||
      !panelProps.onGenerateAllAudio
    )
      return;
    audioSubmissionRef.current = true;
    setAudioSubmissionBusy(true);
    setAudioSubmissionError(undefined);
    try {
      await panelProps.onGenerateAllAudio({ animationMode: selectedAudioMode });
      setAudioRegenerationDialog(false);
    } catch (cause) {
      setAudioSubmissionError(
        describeGuardrailError(cause, t) ??
          (cause instanceof Error && cause.name === 'ReachDeckUserFacingError'
            ? cause.message
            : t('reachDeck.workspace.error.generic')),
      );
    } finally {
      audioSubmissionRef.current = false;
      setAudioSubmissionBusy(false);
    }
  };
  const deckNarrationActions = (
    <>
      {guardedPanelProps.onRegenerateAllNarration ? (
        <button
          aria-label={t('reachDeck.flow.regenerateAllNarration')}
          disabled={deckActionDisabled}
          title={deckGenerationBlockedReason}
          onClick={() => void requestRegenerateAllNarration('full')}
          type="button"
        >
          <WandSparkles aria-hidden="true" size={14} />
          <span>{t('reachDeck.flow.regenerateAllNarration')}</span>
        </button>
      ) : null}
      {guardedPanelProps.onRegenerateAllNarration ||
      guardedPanelProps.onGenerateAllAudio ||
      guardedPanelProps.onRegenerateAllAnimations ||
      guardedPanelProps.onRegenerateAllMedia ? (
        <StudioDeckMenuGroup label={t('reachDeck.flow.partialGeneration')}>
          {guardedPanelProps.onRegenerateAllNarration ? (
            <button
              aria-label={t('reachDeck.flow.regenerateAllNarrationTextOnly')}
              disabled={deckActionDisabled}
              title={deckGenerationBlockedReason}
              onClick={() => void requestRegenerateAllNarration('text')}
              type="button"
            >
              <ScrollText aria-hidden="true" size={14} />
              <span>{t('reachDeck.flow.regenerateAllNarrationTextOnly')}</span>
            </button>
          ) : null}
          {guardedPanelProps.onGenerateAllAudio ? (
            <button
              aria-label={t('reachDeck.flow.generateAllAudio')}
              disabled={deckActionDisabled}
              title={deckGenerationBlockedReason}
              onClick={() => {
                setAudioAnimationMode(
                  pendingAudioMode === 'preserve' || pendingAudioMode === 'regenerate'
                    ? pendingAudioMode
                    : 'preserve',
                );
                setAudioSubmissionError(undefined);
                setAudioRegenerationDialog(true);
              }}
              type="button"
            >
              <AudioLines aria-hidden="true" size={14} />
              <span>{t('reachDeck.flow.generateAllAudio')}</span>
            </button>
          ) : null}
          {guardedPanelProps.onRegenerateAllAnimations ? (
            <button
              aria-label={t('reachDeck.flow.regenerateAllAnimations')}
              disabled={deckActionDisabled}
              title={deckGenerationBlockedReason}
              onClick={() => setAnimationRegenerationDialog(true)}
              type="button"
            >
              <Sparkles aria-hidden="true" size={14} />
              <span>{t('reachDeck.flow.regenerateAllAnimations')}</span>
            </button>
          ) : null}
          {guardedPanelProps.onRegenerateAllMedia ? (
            <button
              aria-label={t('reachDeck.flow.regenerateAllMedia')}
              disabled={deckActionDisabled}
              title={deckGenerationBlockedReason}
              onClick={() => setMediaRegenerationDialog(true)}
              type="button"
            >
              <Clapperboard aria-hidden="true" size={14} />
              <span>{t('reachDeck.flow.regenerateAllMedia')}</span>
            </button>
          ) : null}
        </StudioDeckMenuGroup>
      ) : null}
    </>
  );
  const batchCancellation =
    onCancelWorkspaceBatch === undefined || onInspectWorkspaceBatch === undefined
      ? undefined
      : requestBatchCancellation;
  const studioEditor: ReactNode =
    typeof editor === 'function'
      ? visibleStep === 'studio'
        ? editor({
            rightPanelAction:
              workspace?.priorGeneration === undefined ||
              guardedPanelProps.onRestorePriorGeneration === undefined ? undefined : (
                <button
                  className={styles.studioRestorePanelAction}
                  disabled={guardedPanelProps.busyAction !== undefined}
                  onClick={() => void guardedPanelProps.onRestorePriorGeneration?.()}
                  type="button"
                >
                  <ArrowLeft size={14} />
                  <span>{t('reachDeck.flow.restorePriorRound')}</span>
                </button>
              ),
          })
        : null
      : editor;
  const embeddedStudioChrome =
    visibleStep === 'studio' &&
    typeof editor === 'function' &&
    studioEditor !== null &&
    studioEditor !== undefined;

  if (initialWorkspaceLoading) {
    return (
      <section aria-label={t('reachDeck.flow.label')} className={styles.shell}>
        <div className={styles.viewport}>
          <div className={styles.screen} data-workspace-loading="true">
            <GeneratingDocument
              description={t('reachDeck.flow.loadingWorkspaceBody')}
              title={t('reachDeck.flow.loadingWorkspaceTitle')}
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t('reachDeck.flow.label')} className={styles.shell}>
      {visibleStep !== 'studio' ? (
        <CompactFlowHeader
          availableSteps={selectableSteps}
          backHref={backHref}
          current={visibleStep}
          documentActions={documentActions}
          furthest={workflowStep}
          moduleTitle={moduleTitle}
          onSelect={(step) => {
            onViewStageChange?.();
            setViewedStep(step);
          }}
        />
      ) : (
        <StudioCommandBar
          activity={
            <ReachDeckBatchActivityTrigger
              batches={currentBatches}
              singleJobs={singleJobs}
              pendingSingles={pendingSingles}
              onCancelBatch={batchCancellation}
              onCancelJob={requestJobCancellation}
              busy={batchConfirmationBusy || guardedPanelProps.busyAction !== undefined}
              error={batchConfirmationError}
              pages={
                materializedDocument?.pages ??
                workspace?.pagedOutline?.pages.map((page) => ({ ...page, pageId: page.id }))
              }
            />
          }
          availableSteps={selectableSteps}
          backHref={backHref}
          current={visibleStep}
          documentActions={documentActions}
          deckActions={deckNarrationActions}
          deckActionsDisabled={
            deckActionDisabled ||
            !(
              onRequestRegeneration ||
              guardedPanelProps.onRegenerateAllNarration ||
              guardedPanelProps.onGenerateAllAudio ||
              guardedPanelProps.onRegenerateAllAnimations ||
              guardedPanelProps.onRegenerateAllMedia
            )
          }
          deckActionsTriggerRef={deckActionsTriggerRef}
          furthest={workflowStep}
          moduleTitle={moduleTitle}
          onRenameModule={onRenameModule}
          onRequestMediaDeletion={onRequestMediaDeletion}
          onRequestRegeneration={onRequestRegeneration}
          onSelect={(step) => {
            onViewStageChange?.();
            setViewedStep(step);
          }}
          publishReady={documentReady}
          toolbar
        />
      )}
      <div className={styles.viewport}>
        <div className={styles.screen} data-step={visibleStep}>
          {preparingMaterials ? (
            <div className={styles.documentScreen} data-material-preparing="true">
              <GeneratingDocument
                description={t('reachDeck.materials.preparingBody')}
                title={t('reachDeck.materials.preparingTitle')}
              />
            </div>
          ) : visibleStep === 'brief' ? (
            workspace === undefined && panelProps.error !== undefined ? (
              <WorkspaceFailure panelProps={guardedPanelProps} />
            ) : (
              <BriefScreen
                initialWorkspaceLoading={initialWorkspaceLoading}
                onRequestBlankCreate={onRequestBlankCreate}
                files={briefFiles}
                importedWorkflow={importedWorkflow}
                mode={briefMode}
                onRequestMaicCreate={onRequestMaicCreate}
                onRequestPptxCreate={onRequestPptxCreate}
                panelProps={guardedPanelProps}
                setFiles={setBriefFiles}
                generationLanguage={briefGenerationLanguage}
                setGenerationLanguage={setBriefGenerationLanguage}
                setMode={setBriefMode}
                setWebSearch={setBriefWebSearch}
                webSearch={briefWebSearch}
              />
            )
          ) : visibleStep === 'lesson-plan' ? (
            <LessonPlanScreen
              draft={lessonPlanDraftForm}
              enabledSceneTypes={enabledSceneTypes}
              job={findJob(jobs, 'lesson-plan')}
              loadedPlanSignature={loadedPlanSignature}
              onToggleSceneType={toggleSceneType}
              panelProps={guardedPanelProps}
              setDraft={setLessonPlanDraftForm}
            />
          ) : visibleStep === 'page-outline' ? (
            <PageOutlineScreen
              enabledSceneTypes={enabledSceneTypes}
              job={findJob(jobs, 'page-outline')}
              loadedOutlineSignature={loadedOutlineSignature}
              outlineDraft={outlineDraft}
              panelProps={guardedPanelProps}
              selectedPageId={selectedPageId}
              setOutlineDraft={setOutlineDraft}
              setSelectedPageId={setSelectedPageId}
            />
          ) : (
            <GenerationStudio
              editor={studioEditor}
              materialized={materialized}
              panelProps={guardedPanelProps}
              restoreInBody={!embeddedStudioChrome}
            />
          )}
          {workspace !== undefined &&
          panelProps.error !== undefined &&
          !(visibleStep === 'studio' && (studioEditor === null || pageErrorHandledByEditor)) ? (
            <ActionFailure panelProps={guardedPanelProps} />
          ) : null}
        </div>
      </div>
      {importPanel}
      {pendingConfirmation ? (
        <ConfirmDialog
          busy={pendingConfirmation.kind === 'cancel-batch' && batchConfirmationBusy}
          busyLabel={t('reachDeck.batch.cancel.checking')}
          cancelLabel={t('shared.confirm.cancel')}
          confirmLabel={
            pendingConfirmation.kind === 'cancel-batch'
              ? t('reachDeck.batch.cancel.action')
              : t('shared.confirm.continue')
          }
          description={
            pendingConfirmation.kind === 'cancel-job' ? (
              t('reachDeck.workspace.cancelConfirm')
            ) : pendingConfirmation.kind === 'restore-prior' ? (
              t('reachDeck.workspace.restoreConfirm')
            ) : (
              <div className={styles.batchCancellationDescription}>
                <p>
                  {t(
                    pendingConfirmation.batch.kind === 'narration'
                      ? 'reachDeck.batch.cancel.description.narration'
                      : pendingConfirmation.batch.kind === 'regeneration'
                        ? 'reachDeck.batch.cancel.description.regeneration'
                        : 'reachDeck.batch.cancel.description.media',
                    {
                      count: reachDeckBatchUnfinishedMembers(pendingConfirmation.batch).length,
                    },
                  )}
                </p>
                {pendingConfirmation.scopeChanged ? (
                  <p role="status">{t('reachDeck.batch.cancel.scopeChanged')}</p>
                ) : null}
                {batchConfirmationError === undefined ? null : (
                  <p role="alert">{batchConfirmationError}</p>
                )}
              </div>
            )
          }
          onCancel={() => void resolveConfirmation(false)}
          onConfirm={() => void resolveConfirmation(true)}
          open
          title={
            pendingConfirmation.kind === 'cancel-job'
              ? t('reachDeck.workspace.cancelTitle')
              : pendingConfirmation.kind === 'restore-prior'
                ? t('reachDeck.workspace.restoreTitle')
                : t(
                    pendingConfirmation.batch.kind === 'narration'
                      ? 'reachDeck.batch.cancel.title.narration'
                      : pendingConfirmation.batch.kind === 'regeneration'
                        ? 'reachDeck.batch.cancel.title.regeneration'
                        : 'reachDeck.batch.cancel.title.media',
                  )
          }
          tone="danger"
        />
      ) : null}
      {mediaRegenerationDialog ? (
        <ConfirmDialog
          cancelLabel={t('shared.confirm.cancel')}
          confirmLabel={t('shared.confirm.continue')}
          description={t('reachDeck.flow.regenerateAllMediaDescription')}
          onCancel={() => setMediaRegenerationDialog(false)}
          onConfirm={() => {
            setMediaRegenerationDialog(false);
            void Promise.resolve(panelProps.onRegenerateAllMedia?.()).catch(() => undefined);
          }}
          open
          title={t('reachDeck.flow.regenerateAllMediaTitle')}
        />
      ) : null}
      {audioRegenerationDialog ? (
        <Dialog
          className="rx-confirm-dialog"
          description={t('reachDeck.flow.generateAllAudioDescription')}
          dismissible={!audioSubmissionBusy}
          dismissOnOverlay={false}
          footer={
            <>
              <Button
                disabled={audioSubmissionBusy}
                onClick={() => setAudioRegenerationDialog(false)}
                ref={audioCancelRef}
                variant="default"
              >
                {t('shared.confirm.cancel')}
              </Button>
              <Button
                disabled={deckActionDisabled || pendingAudioMode === 'animations'}
                loading={audioSubmissionBusy}
                loadingLabel={t('reachDeck.flow.audioSubmitting')}
                onClick={() => void submitAllAudio()}
                variant="primary"
              >
                {t(
                  pendingAudioMode === undefined
                    ? 'reachDeck.flow.generateAudio'
                    : 'reachDeck.flow.retryAudio',
                )}
              </Button>
            </>
          }
          icon={<AudioLines strokeWidth={1.5} />}
          initialFocus={audioCancelRef}
          onOpenChange={(open) => {
            if (!open) setAudioRegenerationDialog(false);
          }}
          open
          returnFocusTarget={deckActionsTriggerRef}
          role="alertdialog"
          size="sm"
          title={t('reachDeck.flow.generateAllAudio')}
        >
          <div aria-busy={audioSubmissionBusy} className={styles.audioRegenerationDescription}>
            {pendingAudioMode === undefined ? null : (
              <InlineNotice tone="info">
                {t(
                  pendingAudioMode === 'animations'
                    ? 'reachDeck.flow.audioPendingAnimations'
                    : 'reachDeck.flow.audioPendingBatch',
                )}
              </InlineNotice>
            )}
            <p id={audioAnimationLabelId}>{t('reachDeck.flow.audioAnimationMode')}</p>
            <RadioGroup
              aria-labelledby={audioAnimationLabelId}
              disabled={audioSubmissionBusy || pendingAudioMode !== undefined}
              onChange={(value) => {
                if (value === 'preserve' || value === 'regenerate') setAudioAnimationMode(value);
              }}
              options={[
                {
                  description: t('reachDeck.flow.audioAnimationPreserveDescription'),
                  label: t('reachDeck.flow.audioAnimationPreserve'),
                  value: 'preserve',
                },
                {
                  description: t('reachDeck.flow.audioAnimationRegenerateDescription'),
                  label: t('reachDeck.flow.audioAnimationRegenerate'),
                  value: 'regenerate',
                },
                ...(pendingAudioMode === 'skip'
                  ? [
                      {
                        description: t('reachDeck.flow.audioAnimationSkipDescription'),
                        label: t('reachDeck.flow.audioAnimationSkip'),
                        value: 'skip',
                      },
                    ]
                  : []),
              ]}
              value={selectedAudioMode}
            />
            {audioSubmissionError === undefined ? null : (
              <InlineNotice className={styles.audioRegenerationError} tone="error">
                {audioSubmissionError}
              </InlineNotice>
            )}
          </div>
        </Dialog>
      ) : null}
      {animationRegenerationDialog ? (
        <ConfirmDialog
          cancelLabel={t('shared.confirm.cancel')}
          confirmLabel={t('shared.confirm.continue')}
          description={t('reachDeck.flow.regenerateAllAnimationsDescription')}
          onCancel={() => setAnimationRegenerationDialog(false)}
          onConfirm={() => {
            setAnimationRegenerationDialog(false);
            void Promise.resolve(panelProps.onRegenerateAllAnimations?.()).catch(() => undefined);
          }}
          open
          title={t('reachDeck.flow.regenerateAllAnimationsTitle')}
        />
      ) : null}
      {narrationOverwriteDialog === undefined ? null : (
        <ConfirmDialog
          cancelLabel={t('shared.confirm.cancel')}
          confirmLabel={t('shared.confirm.continue')}
          description={
            <label>
              {narrationOverwriteDialog === 'text' ? (
                <span>
                  {narrationInspection.hasExistingNarration ||
                  narrationInspection.hasInFlightNarration
                    ? `${t('reachDeck.flow.regenerateAllNarrationTextOnlyExistingDescription')} `
                    : null}
                  {t('reachDeck.flow.regenerateAllNarrationTextOnlyDescription')}
                </span>
              ) : (
                <span>
                  {t(
                    narrationInspection.hasExistingNarration ||
                      narrationInspection.hasInFlightNarration
                      ? 'reachDeck.flow.regenerateAllNarrationDescription'
                      : 'reachDeck.flow.regenerateAllNarrationReadyDescription',
                  )}
                </span>
              )}
              {narrationInspection.hasExistingNarration ||
              narrationInspection.hasInFlightNarration ? (
                <span>
                  <input
                    checked={overwriteExistingNarration}
                    onChange={(event) => setOverwriteExistingNarration(event.target.checked)}
                    type="checkbox"
                  />{' '}
                  {t('reachDeck.flow.regenerateAllNarrationOverwrite')}
                </span>
              ) : null}
            </label>
          }
          onCancel={() => setNarrationOverwriteDialog(undefined)}
          onConfirm={() => void confirmRegenerateAllNarration()}
          open
          title={t(
            narrationOverwriteDialog === 'text'
              ? 'reachDeck.flow.regenerateAllNarrationTextOnlyTitle'
              : 'reachDeck.flow.regenerateAllNarrationTitle',
          )}
          tone={narrationOverwriteDialog === 'text' ? 'danger' : undefined}
        />
      )}
    </section>
  );
}

function CompactFlowHeader({
  availableSteps,
  backHref,
  current,
  documentActions,
  furthest,
  moduleTitle,
  onSelect,
}: {
  availableSteps: typeof steps;
  backHref?: string;
  current: Exclude<FlowStep, 'studio'>;
  documentActions?: ReachDeckDocumentActions;
  furthest: FlowStep;
  moduleTitle: string;
  onSelect: (step: FlowStep) => void;
}) {
  return (
    <header className={styles.compactFlowHeader} data-step={current}>
      <div className={styles.compactFlowBrand}>
        <StudioBrandHeader backHref={backHref} moduleTitle={moduleTitle} />
      </div>
      <div className={styles.compactFlowControls}>
        <StudioCommandBar
          availableSteps={availableSteps}
          current={current}
          documentActions={documentActions}
          furthest={furthest}
          onSelect={onSelect}
          publishReady={false}
        />
      </div>
    </header>
  );
}

/**
 * The workspace is the component that failed to load, so its recovery UI replaces the workspace
 * body. Transport and parsing failures must never grow a page-level banner above another stage.
 */
function WorkspaceFailure({ panelProps }: { panelProps: ReachDeckGenerationPanelProps }) {
  const { t } = usePortalI18n();
  return (
    <section className={styles.workspaceFailure} role="alert">
      <div className={styles.canvasPlaceholder}>
        <CircleAlert aria-hidden size={34} />
        <p>{panelProps.error}</p>
        <button
          className={styles.secondaryAction}
          disabled={panelProps.busyAction !== undefined}
          onClick={() => void panelProps.onRefresh()}
          type="button"
        >
          {t('reachDeck.flow.reload')}
        </button>
      </div>
    </section>
  );
}

/** Teacher-triggered failures float within the active stage without changing its layout height. */
function ActionFailure({ panelProps }: { panelProps: ReachDeckGenerationPanelProps }) {
  const { t } = usePortalI18n();
  return (
    <div className={styles.actionFailure} role="alert">
      <CircleAlert aria-hidden size={20} />
      <p>{panelProps.error}</p>
      <button
        disabled={panelProps.busyAction !== undefined}
        onClick={() => void panelProps.onRefresh()}
        type="button"
      >
        {t('reachDeck.flow.reload')}
      </button>
    </div>
  );
}

function generationJobLabel(
  job: ReachDeckGenerationPanelJob,
  t: (key: string, replacements?: Record<string, string | number>) => string,
): string {
  const label = t(`reachDeck.jobs.kind.${job.kind}`);
  return job.pageId === undefined
    ? label
    : t('reachDeck.jobs.pageJob', { label, pageId: job.pageId });
}

/**
 * job.error 中的失败分类码（Generation failed: <category>）,未匹配时返回 undefined。
 */
function jobFailureCategory(job: ReachDeckGenerationPanelJob): string | undefined {
  return job.error?.match(/^Generation failed: ([a-z-]+)$/)?.[1];
}

/**
 * job.error 的失败分类码（Generation failed: <category>）映射为 i18n 提示。
 * 未识别分类退回通用失败文案。
 */
function describeJobFailure(
  job: ReachDeckGenerationPanelJob,
  t: (key: string, replacements?: Record<string, string | number>) => string,
): string {
  const category = jobFailureCategory(job);
  const guardrailMessage = describeGuardrailError(job.error, t);
  if (guardrailMessage) return guardrailMessage;
  const key = `reachDeck.jobs.failure.${category ?? 'internal'}`;
  const translated = t(key);
  return translated === key ? t('reachDeck.jobs.failure.internal') : translated;
}

/**
 * 教案/大纲生成失败面板。此前失败任务只留下永久骨架屏；
 * 现在展示失败分类并提供重试（BullMQ retry）与重新发起两条路径。
 * superseded 分类的任务在执行前已被更早取代,不提供重试(仅可重新发起)。
 */
function PlanningJobFailure({
  compact = false,
  job,
  onRestart,
  panelProps,
}: {
  compact?: boolean;
  job: ReachDeckGenerationPanelJob;
  onRestart: () => void;
  panelProps: ReachDeckGenerationPanelProps;
}) {
  const { t } = usePortalI18n();
  const busy = panelProps.busyAction !== undefined;
  const retryable =
    job.status === 'failed' &&
    jobFailureCategory(job) !== 'superseded' &&
    !describeGuardrailError(job.error, t);
  return (
    <div
      className={styles.generatingDocument}
      role="alert"
      style={compact ? { minHeight: 0, padding: '16px 20px', flex: 'none' } : undefined}
    >
      <span className={styles.eyebrow}>{t('reachDeck.jobs.failedEyebrow')}</span>
      <h3>{t('reachDeck.jobs.failedTitle', { label: generationJobLabel(job, t) })}</h3>
      <p>{describeJobFailure(job, t)}</p>
      <div style={{ display: 'flex', gap: '0.6rem' }}>
        {retryable && (
          <button
            className={styles.primaryAction}
            disabled={busy}
            onClick={() => void panelProps.onRetryJob(job.jobId)}
            type="button"
          >
            {t('reachDeck.jobs.retry')}
          </button>
        )}
        <button
          className={styles.secondaryAction}
          disabled={busy}
          onClick={onRestart}
          type="button"
        >
          {t('reachDeck.jobs.restart')}
        </button>
      </div>
    </div>
  );
}

function StudioBrandHeader({ backHref, moduleTitle }: { backHref?: string; moduleTitle: string }) {
  const { t } = usePortalI18n();
  return (
    <div className={styles.studioBrandRow}>
      {backHref === undefined ? (
        <span aria-hidden className={styles.studioBrandMark}>
          <WandSparkles size={16} />
        </span>
      ) : (
        <TeacherReturnLink
          aria-label={t('reachDeck.flow.back')}
          className={styles.studioBackLink}
          href={backHref}
        >
          <ArrowLeft size={16} />
        </TeacherReturnLink>
      )}
      <strong title={moduleTitle}>{moduleTitle}</strong>
    </div>
  );
}

function StudioModuleName({
  backHref,
  moduleTitle,
  onRenameModule,
}: {
  backHref?: string;
  moduleTitle: string;
  onRenameModule?: (title: string) => Promise<void>;
}) {
  const { t } = usePortalI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(moduleTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const editingRef = useRef(false);
  const submissionRef = useRef(false);
  const errorId = useId();
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const open = () => {
    editingRef.current = true;
    setDraft(moduleTitle);
    setError(undefined);
    setEditing(true);
  };
  const close = (restoreFocus: boolean) => {
    editingRef.current = false;
    setEditing(false);
    setError(undefined);
    if (restoreFocus) {
      requestAnimationFrame(() => {
        if (!editingRef.current) triggerRef.current?.focus();
      });
    }
  };
  // 回车或焦点离开即提交，保存失败保留输入框与错误，便于修正后重试。回车提交空名称时提示必填，
  // 失焦时空名称或未改动直接还原；只有键盘提交/取消把焦点还给编辑按钮，点别处离开时不抢焦点。
  const commit = async (fromKeyboard: boolean) => {
    if (!editingRef.current || submissionRef.current || onRenameModule === undefined) return;
    const title = draft.trim();
    if (!title && fromKeyboard) {
      setError(t('teacher.courses.renameRequired'));
      return;
    }
    if (!title || title === moduleTitle) {
      close(fromKeyboard);
      return;
    }
    submissionRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onRenameModule(title);
      close(fromKeyboard);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message ? cause.message : t('teacher.courses.renameError'),
      );
    } finally {
      submissionRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={styles.workbenchModule}>
      {backHref === undefined ? null : (
        <TeacherReturnLink
          aria-label={t('reachDeck.flow.back')}
          className={styles.workbenchBack}
          href={backHref}
        >
          <ArrowLeft aria-hidden size={16} />
        </TeacherReturnLink>
      )}
      {editing ? (
        <div className={styles.moduleNameEditor}>
          <Input
            aria-busy={busy || undefined}
            aria-label={t('teacher.courses.renameInput', { title: moduleTitle })}
            aria-describedby={error === undefined ? undefined : errorId}
            invalid={error !== undefined}
            onBlur={() => void commit(false)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                void commit(true);
              }
              if (event.key === 'Escape' && !submissionRef.current) {
                event.preventDefault();
                close(true);
              }
            }}
            onValueChange={setDraft}
            readOnly={busy}
            ref={inputRef}
            size="sm"
            value={draft}
          />
          {error === undefined ? null : (
            <span className={styles.moduleNameError} id={errorId} role="alert">
              {error}
            </span>
          )}
        </div>
      ) : (
        <div className={styles.moduleName}>
          <strong title={moduleTitle}>{moduleTitle}</strong>
          {onRenameModule === undefined ? null : (
            <IconButton
              icon={<Pencil />}
              label={t('teacher.courses.renameLabel', { title: moduleTitle })}
              onClick={open}
              ref={triggerRef}
              size="sm"
              tooltipPlacement="bottom"
              variant="ghost"
            />
          )}
        </div>
      )}
    </div>
  );
}

const CANVAS_CORNER_SELECTOR = '.reach-deck-editor__canvas-corner-row';
const DECK_GROUP_MIN_GAP = 8;

/**
 * 工具条整组按钮的右缘对齐到编辑器画布右上角“重新生成本页”的右缘。
 *
 * 画布列宽随左右侧栏收起/展开、窗口缩放而变，CSS 拿不到编辑器内部状态，因此实测：
 * 目标间距 = 文档操作区左缘 − 画布角按钮右缘；空间不足（会挤压左侧标题/阶段）或
 * 编辑器未挂载时返回 undefined，回落为普通紧邻排布。测量合并到下一帧，避免抖动。
 */
function useCanvasCornerAlignment(
  enabled: boolean,
  groupRef: RefObject<HTMLDivElement | null>,
  actionsRef: RefObject<HTMLDivElement | null>,
): number | undefined {
  const [gap, setGap] = useState<number>();
  useEffect(() => {
    if (!enabled) {
      setGap(undefined);
      return;
    }
    let frame: number | undefined;
    let observedPreview: Element | null = null;
    const schedule = () => {
      if (frame === undefined) frame = window.requestAnimationFrame(measure);
    };
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    function measure() {
      frame = undefined;
      const group = groupRef.current;
      const actions = actionsRef.current;
      const corner = window.document.querySelector<HTMLElement>(CANVAS_CORNER_SELECTOR);
      const preview = corner?.closest('.reach-deck-editor__preview') ?? null;
      if (preview !== observedPreview) {
        if (observedPreview !== null) resize?.unobserve(observedPreview);
        if (preview !== null) resize?.observe(preview);
        observedPreview = preview;
      }
      if (group === null || actions === null || corner === null) {
        setGap(undefined);
        return;
      }
      const desired = actions.getBoundingClientRect().left - corner.getBoundingClientRect().right;
      const previous = group.previousElementSibling?.getBoundingClientRect().right;
      const room =
        previous === undefined
          ? desired
          : actions.getBoundingClientRect().left -
            previous -
            DECK_GROUP_MIN_GAP -
            group.getBoundingClientRect().width;
      const next = Math.round(Math.min(desired, room));
      setGap(next >= DECK_GROUP_MIN_GAP ? next : undefined);
    }
    const toolbarRow = groupRef.current?.parentElement;
    if (toolbarRow) resize?.observe(toolbarRow);
    // 编辑器在工具条之后挂载、换页时可能重建画布角：监听 DOM 结构变化重新定位目标。
    const mutation =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(schedule);
    mutation?.observe(window.document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [enabled, groupRef, actionsRef]);
  return gap;
}

function StudioCommandBar({
  activity,
  backHref,
  moduleTitle,
  onRenameModule,
  onRequestMediaDeletion,
  onRequestRegeneration,
  toolbar = false,
  deckActionsDisabled,
  availableSteps,
  current,
  documentActions,
  deckActions,
  deckActionsTriggerRef,
  furthest,
  onSelect,
  publishReady,
}: {
  activity?: ReactNode;
  backHref?: string;
  moduleTitle?: string;
  onRenameModule?: (title: string) => Promise<void>;
  onRequestMediaDeletion?: () => void;
  onRequestRegeneration?: () => void;
  toolbar?: boolean;
  deckActionsDisabled?: boolean;
  availableSteps: typeof steps;
  current: FlowStep;
  documentActions?: ReachDeckDocumentActions;
  deckActions?: ReactNode;
  deckActionsTriggerRef?: RefObject<HTMLButtonElement | null>;
  furthest: FlowStep;
  onSelect: (step: FlowStep) => void;
  publishReady: boolean;
}) {
  const { t } = usePortalI18n();
  const furthestIndex = stepIndex(furthest);
  const [menuOpen, setMenuOpen] = useState(false);
  const deckGroupRef = useRef<HTMLDivElement>(null);
  const documentActionsRef = useRef<HTMLDivElement>(null);
  const deckGroupEndGap = useCanvasCornerAlignment(toolbar, deckGroupRef, documentActionsRef);
  const hasDeckGroup =
    deckActions !== undefined ||
    onRequestRegeneration !== undefined ||
    activity !== undefined ||
    onRequestMediaDeletion !== undefined;
  return (
    <div
      aria-label={toolbar ? t('reachDeck.flow.toolbar') : undefined}
      className={toolbar ? styles.workbenchToolbar : styles.studioCommandBar}
      data-workbench-toolbar={toolbar || undefined}
      role={toolbar ? 'toolbar' : undefined}
    >
      <div className={styles.studioControlRow}>
        {toolbar && moduleTitle !== undefined ? (
          <StudioModuleName
            backHref={backHref}
            moduleTitle={moduleTitle}
            onRenameModule={onRenameModule}
          />
        ) : null}
        <Select
          aria-label={t('reachDeck.flow.stagesLabel')}
          className={styles.studioStepSelect}
          listboxClassName={styles.studioStepSelectList}
          onChange={(nextStep) => {
            onSelect(nextStep);
            if (nextStep !== current) {
              restoreFlowStageFocus(nextStep, t('reachDeck.flow.stagesLabel'));
            }
          }}
          options={availableSteps.map((step) => {
            const index = stepIndex(step.id);
            return {
              disabled: index > furthestIndex,
              label: `${String(index + 1).padStart(2, '0')} · ${t(step.labelKey)}`,
              value: step.id,
            };
          })}
          portal
          value={current}
        />
        {!hasDeckGroup ? null : (
          // 一键生成 / 生成任务状态 / 一键删除为一组，右缘与画布右上角“重新生成本页”对齐。
          <div
            className={styles.studioDeckGroup}
            ref={deckGroupRef}
            style={deckGroupEndGap === undefined ? undefined : { marginInlineEnd: deckGroupEndGap }}
          >
            {deckActions === undefined && onRequestRegeneration === undefined ? null : (
              <div className={styles.studioDeckMenuRow}>
                {onRequestRegeneration === undefined ? (
                  <Popover
                    className={styles.studioDeckMenu}
                    label={t('reachDeck.flow.deckActions')}
                    onOpenChange={setMenuOpen}
                    open={menuOpen}
                    placement="bottom-end"
                    trigger={
                      <Button
                        aria-label={t('reachDeck.flow.deckActions')}
                        disabled={deckActionsDisabled}
                        size="sm"
                        variant="default"
                        className={styles.studioDeckMenuTrigger}
                        iconStart={<WandSparkles />}
                        ref={deckActionsTriggerRef}
                        title={t('reachDeck.flow.deckActions')}
                        type="button"
                      >
                        {t('reachDeck.flow.regenerate')}
                      </Button>
                    }
                  >
                    <div
                      onClick={(event) => {
                        // 二级展开的切换按钮（带 aria-expanded）只展开/收起，不关闭菜单。
                        if (
                          (event.target as HTMLElement).closest(
                            'button:not(:disabled):not([aria-expanded])',
                          )
                        )
                          setMenuOpen(false);
                      }}
                    >
                      {deckActions}
                    </div>
                  </Popover>
                ) : (
                  <Button
                    disabled={deckActionsDisabled}
                    iconStart={<WandSparkles />}
                    onClick={onRequestRegeneration}
                    ref={deckActionsTriggerRef}
                    size="sm"
                    variant="default"
                  >
                    {t('reachDeck.flow.regenerate')}
                  </Button>
                )}
              </div>
            )}
            {activity}
            {onRequestMediaDeletion === undefined ? null : (
              <Button
                disabled={deckActionsDisabled}
                iconStart={<Trash2 />}
                onClick={onRequestMediaDeletion}
                size="sm"
                title={t('reachDeck.flow.deleteMediaHint')}
                variant="default"
              >
                {t('reachDeck.flow.deleteMedia')}
              </Button>
            )}
          </div>
        )}
        {documentActions === undefined ? null : (
          <div className={styles.studioDocumentActions} ref={documentActionsRef}>
            {current === 'studio' ? (
              <Tooltip
                content={publishReady ? undefined : t('reachDeck.flow.trialPendingHint')}
                placement="bottom"
              >
                <button
                  aria-busy={documentActions.busy === 'trial'}
                  aria-disabled={
                    !publishReady || documentActions.disabled || documentActions.busy !== undefined
                  }
                  aria-label={
                    documentActions.busy === 'trial'
                      ? t('reachDeck.flow.trialStarting')
                      : t('reachDeck.flow.trial')
                  }
                  className={styles.trialAction}
                  disabled={documentActions.disabled || documentActions.busy !== undefined}
                  onClick={(event) => {
                    if (publishReady) void documentActions.onTrial(event.currentTarget);
                  }}
                  title={
                    publishReady ? t('reachDeck.flow.trial') : t('reachDeck.flow.trialPendingHint')
                  }
                  type="button"
                >
                  {documentActions.busy === 'trial' ? (
                    <TeacherLoadingIcon />
                  ) : (
                    <MonitorPlay size={14} />
                  )}
                  <span>
                    {documentActions.busy === 'trial'
                      ? t('reachDeck.flow.trialStarting')
                      : t('reachDeck.flow.trial')}
                  </span>
                </button>
              </Tooltip>
            ) : null}
            <span className={styles.saveActionWithStatus}>
              <button
                aria-busy={documentActions.busy === 'save'}
                aria-label={
                  documentActions.busy === 'save'
                    ? t('reachDeck.flow.saving')
                    : t('reachDeck.flow.save')
                }
                disabled={documentActions.disabled || documentActions.busy !== undefined}
                onClick={() => void documentActions.onSave()}
                title={t('reachDeck.flow.save')}
                type="button"
              >
                {documentActions.busy === 'save' ? <TeacherLoadingIcon /> : <Save size={14} />}
                <span>
                  {documentActions.busy === 'save'
                    ? t('reachDeck.flow.saving')
                    : t('reachDeck.flow.save')}
                </span>
              </button>
              {documentActions.status === undefined ? null : (
                <span
                  aria-label={documentActions.status}
                  className={styles.saveStatusDot}
                  data-tone={documentActions.statusTone}
                  role="status"
                  title={documentActions.status}
                />
              )}
            </span>
            {current === 'studio' ? (
              <Tooltip
                content={publishReady ? undefined : t('reachDeck.flow.publishPendingHint')}
                placement="bottom"
              >
                <button
                  aria-busy={documentActions.busy === 'publish'}
                  aria-disabled={
                    !publishReady || documentActions.disabled || documentActions.busy !== undefined
                  }
                  aria-label={
                    documentActions.busy === 'publish'
                      ? t('reachDeck.flow.publishing')
                      : t('reachDeck.flow.publish')
                  }
                  className={styles.publishAction}
                  disabled={documentActions.disabled || documentActions.busy !== undefined}
                  onClick={() => {
                    if (publishReady) void documentActions.onPublish();
                  }}
                  title={
                    publishReady
                      ? t('reachDeck.flow.publish')
                      : t('reachDeck.flow.publishPendingHint')
                  }
                  type="button"
                >
                  {documentActions.busy === 'publish' ? <TeacherLoadingIcon /> : <Send size={14} />}
                  <span>
                    {documentActions.busy === 'publish'
                      ? t('reachDeck.flow.publishing')
                      : t('reachDeck.flow.publish')}
                  </span>
                </button>
              </Tooltip>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 整份课件操作菜单内的行内二级展开组：切换按钮不关闭外层菜单；菜单关闭即卸载，下次打开时收起。
 */
function StudioDeckMenuGroup({ children, label }: { children: ReactNode; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const groupId = useId();
  return (
    <>
      <button
        aria-controls={groupId}
        aria-expanded={expanded}
        className={styles.studioDeckMenuGroupToggle}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span>{label}</span>
        <ChevronRight aria-hidden="true" size={14} />
      </button>
      <div
        aria-label={label}
        className={styles.studioDeckMenuGroup}
        hidden={!expanded}
        id={groupId}
        role="group"
      >
        {children}
      </div>
    </>
  );
}

function BriefScreen({
  initialWorkspaceLoading,
  onRequestBlankCreate,
  files,
  generationLanguage,
  importedWorkflow,
  mode,
  onRequestMaicCreate,
  onRequestPptxCreate,
  panelProps,
  setGenerationLanguage,
  setFiles,
  setMode,
  setWebSearch,
  webSearch,
}: {
  initialWorkspaceLoading: boolean;
  onRequestBlankCreate?: () => Promise<void> | void;
  files: File[];
  generationLanguage: ReachDeckGenerationLanguage;
  importedWorkflow: boolean;
  mode: BriefMode;
  onRequestMaicCreate?: () => void;
  onRequestPptxCreate?: () => void;
  panelProps: ReachDeckGenerationPanelProps;
  setGenerationLanguage: Dispatch<SetStateAction<ReachDeckGenerationLanguage>>;
  setFiles: Dispatch<SetStateAction<File[]>>;
  setMode: Dispatch<SetStateAction<BriefMode>>;
  setWebSearch: Dispatch<SetStateAction<boolean>>;
  webSearch: boolean;
}) {
  const { t } = usePortalI18n();
  const [fileNotice, setFileNotice] = useState<string>();
  const createModeTab = useRef<HTMLButtonElement>(null);
  const importModeTab = useRef<HTMLButtonElement>(null);
  const suggestions = [
    t('reachDeck.brief.example1'),
    t('reachDeck.brief.example2'),
    t('reachDeck.brief.example3'),
  ];
  const rotatingTitleWords = [
    {
      primary: t('reachDeck.brief.title.knowledge.primary'),
      secondary: t('reachDeck.brief.title.knowledge.secondary'),
    },
    {
      primary: t('reachDeck.brief.title.capability.primary'),
      secondary: t('reachDeck.brief.title.capability.secondary'),
    },
    {
      primary: t('reachDeck.brief.title.value.primary'),
      secondary: t('reachDeck.brief.title.value.secondary'),
    },
  ];
  const displayedSource =
    (importedWorkflow && isImportSourceSentinel(panelProps.sourceDraft.trim())) ||
    panelProps.sourceDraft.trim() === 'marketplace-copy'
      ? ''
      : panelProps.sourceDraft;
  const submit = () => {
    const source = displayedSource.trim();
    if (source.length === 0) return;
    if (files.reduce((total, file) => total + file.size, 0) > AGGREGATE_FILE_LIMIT) {
      setFileNotice(t('reachDeck.brief.filesRejectedAggregate'));
      return;
    }
    void panelProps.onCreateWorkspace(source, {
      files,
      webSearch,
      generationLanguage,
      ...(generationLanguage === 'follow-system'
        ? { systemLanguage: browserGenerationLanguage() }
        : {}),
    });
  };
  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    // A cancelled native picker must not clear an existing selection.
    if (picked.length === 0) return;
    const existing = new Set(files.map(fileKey));
    const existingHashes = new Set<string>();
    for (const file of files) existingHashes.add(await contentHash(file));
    const accepted: File[] = [];
    let rejectedUnsupported = 0;
    let rejectedOversize = 0;
    let rejectedDuplicate = 0;
    let rejectedCapacity = 0;
    for (const file of picked) {
      const key = fileKey(file);
      const hash = await contentHash(file);
      if (
        existing.has(key) ||
        existingHashes.has(hash) ||
        accepted.some((candidate) => fileKey(candidate) === key)
      ) {
        rejectedDuplicate += 1;
        continue;
      }
      const limit = briefFileLimit(file);
      if (limit === undefined) {
        rejectedUnsupported += 1;
        continue;
      }
      if (file.size > limit) {
        rejectedOversize += 1;
        continue;
      }
      if (files.length + accepted.length >= MAX_BRIEF_FILES) {
        rejectedCapacity += 1;
        continue;
      }
      accepted.push(file);
      existingHashes.add(hash);
    }
    if (accepted.length > 0) setFiles((current) => [...current, ...accepted]);
    const reasons: string[] = [];
    if (accepted.length > 0)
      reasons.push(t('reachDeck.brief.filesAdded', { count: accepted.length }));
    if (rejectedUnsupported > 0)
      reasons.push(t('reachDeck.brief.filesRejectedUnsupported', { count: rejectedUnsupported }));
    if (rejectedOversize > 0)
      reasons.push(t('reachDeck.brief.filesRejectedOversize', { count: rejectedOversize }));
    if (rejectedDuplicate > 0)
      reasons.push(t('reachDeck.brief.filesRejectedDuplicate', { count: rejectedDuplicate }));
    if (rejectedCapacity > 0)
      reasons.push(t('reachDeck.brief.filesRejectedCapacity', { count: rejectedCapacity }));
    setFileNotice(reasons.join(' '));
    event.target.value = '';
  };
  const selectMode = (nextMode: BriefMode, focus = false) => {
    setMode(nextMode);
    if (focus) {
      window.requestAnimationFrame(() => {
        (nextMode === 'create' ? createModeTab : importModeTab).current?.focus();
      });
    }
  };

  return (
    <section aria-label={t('reachDeck.brief.label')} className={styles.briefScreen}>
      <div className={styles.briefScroll} data-brief-scroll>
        <div className={styles.briefAura} />
        <div className={styles.briefHero}>
          <span className={styles.eyebrow}>
            <Sparkles size={14} /> {t('reachDeck.brief.eyebrow')}
          </span>
          <h1 aria-label={t('reachDeck.brief.title')}>
            <span aria-hidden="true" className={styles.briefTitleSentence}>
              <span data-brief-title-static>{t('reachDeck.brief.title.prefix')}</span>
              <span className={styles.briefTitleWordCycle} data-brief-title-primary>
                {rotatingTitleWords.map((words, index) => (
                  <span data-brief-title-word={index + 1} key={words.primary}>
                    {words.primary}
                  </span>
                ))}
              </span>
              <span data-brief-title-static>{t('reachDeck.brief.title.connector')}</span>
              <span className={styles.briefTitleWordCycle} data-brief-title-secondary>
                {rotatingTitleWords.map((words, index) => (
                  <span data-brief-title-word={index + 1} key={words.secondary}>
                    {words.secondary}
                  </span>
                ))}
              </span>
              <span data-brief-title-static>{t('reachDeck.brief.title.suffix')}</span>
            </span>
          </h1>
          <p>{t('reachDeck.brief.body')}</p>
        </div>
        <div className={styles.briefModeCarousel} data-mode={mode}>
          <div
            aria-label={t('reachDeck.brief.mode.label')}
            className={styles.briefModeTabs}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                selectMode('create', true);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                selectMode('import', true);
              }
            }}
            role="tablist"
          >
            <button
              aria-controls="reach-deck-brief-create-panel"
              aria-label={t('reachDeck.brief.mode.switchCreate')}
              aria-selected={mode === 'create'}
              className={`${styles.briefModeArrow} ${styles.briefModeArrowLeft}`}
              id="reach-deck-brief-create-tab"
              onClick={() => selectMode('create')}
              ref={createModeTab}
              role="tab"
              tabIndex={mode === 'create' ? 0 : -1}
              type="button"
            >
              <ArrowLeft size={22} />
            </button>
            <button
              aria-controls="reach-deck-brief-import-panel"
              aria-label={t('reachDeck.brief.mode.switchImport')}
              aria-selected={mode === 'import'}
              className={`${styles.briefModeArrow} ${styles.briefModeArrowRight}`}
              id="reach-deck-brief-import-tab"
              onClick={() => selectMode('import')}
              ref={importModeTab}
              role="tab"
              tabIndex={mode === 'import' ? 0 : -1}
              type="button"
            >
              <ArrowRight size={22} />
            </button>
          </div>
          <div className={styles.briefModeStage}>
            <div
              aria-hidden={mode !== 'create'}
              aria-labelledby="reach-deck-brief-create-tab"
              className={styles.briefModeCard}
              data-active={mode === 'create' || undefined}
              data-card-mode="create"
              id="reach-deck-brief-create-panel"
              inert={mode !== 'create'}
              role="tabpanel"
            >
              <form
                aria-label={t('reachDeck.brief.formLabel')}
                className={styles.promptComposer}
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <div className={styles.briefModeHeading}>
                  <span className={styles.briefModeIcon}>
                    <MessageSquareText size={18} />
                  </span>
                  <span>
                    <strong>{t('reachDeck.brief.mode.create')}</strong>
                    <small>{t('reachDeck.brief.mode.createDescription')}</small>
                  </span>
                </div>
                <div className={styles.promptEditor}>
                  <MarkdownRichTextField
                    disabled={panelProps.busyAction !== undefined}
                    label={t('reachDeck.brief.sourceLabel')}
                    markdown={displayedSource}
                    onChange={panelProps.onSourceDraftChange}
                    placeholder={t('reachDeck.brief.placeholder')}
                  />
                </div>
                {files.length > 0 ? (
                  <ul aria-label={t('reachDeck.brief.filesLabel')} className={styles.fileList}>
                    {files.map((file) => (
                      <li key={fileKey(file)}>
                        <FileText size={14} />
                        <span>{file.name}</span>
                        <small>{formatBytes(file.size)}</small>
                        <button
                          aria-label={t('reachDeck.brief.removeFile', { name: file.name })}
                          disabled={panelProps.busyAction !== undefined}
                          onClick={() =>
                            setFiles((current) => current.filter((item) => item !== file))
                          }
                          type="button"
                        >
                          <X size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className={styles.filePolicy}>{t('reachDeck.brief.filePolicy')}</p>
                {fileNotice === undefined ? null : (
                  <p aria-live="polite" className={styles.fileNotice} role="status">
                    {fileNotice}
                  </p>
                )}
                <div className={styles.promptFooter}>
                  <div className={styles.promptTools}>
                    <label className={styles.fileButton}>
                      <FilePlus2 size={15} /> {t('reachDeck.brief.upload')}
                      <input
                        accept=".pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg,image/webp"
                        aria-label={t('reachDeck.brief.uploadLabel')}
                        disabled={panelProps.busyAction !== undefined}
                        multiple
                        onChange={onFiles}
                        type="file"
                      />
                    </label>
                    <button
                      aria-pressed={webSearch}
                      className={styles.toolPill}
                      data-active={webSearch || undefined}
                      onClick={() => setWebSearch((current) => !current)}
                      type="button"
                    >
                      <Globe2 size={15} /> {t('reachDeck.brief.webSearch')}
                    </button>
                    <div className={styles.languagePill}>
                      <span>{t('reachDeck.brief.languageLabel')}</span>
                      <Select<ReachDeckGenerationLanguage>
                        aria-label={t('reachDeck.brief.languageLabel')}
                        className={styles.languageSelect}
                        disabled={panelProps.busyAction !== undefined}
                        listboxClassName={styles.languageSelectList}
                        onChange={setGenerationLanguage}
                        options={[
                          {
                            label: t('reachDeck.brief.language.followSystem'),
                            value: 'follow-system',
                          },
                          { label: t('reachDeck.brief.language.zhCN'), value: 'zh-CN' },
                          { label: t('reachDeck.brief.language.enUS'), value: 'en-US' },
                        ]}
                        portal
                        value={generationLanguage}
                      />
                    </div>
                  </div>
                  <button
                    className={styles.primaryAction}
                    disabled={
                      displayedSource.trim().length === 0 || panelProps.busyAction !== undefined
                    }
                    type="submit"
                  >
                    {t('reachDeck.brief.submit')} <ArrowRight size={16} />
                  </button>
                </div>
              </form>
              <div aria-label={t('reachDeck.brief.examplesLabel')} className={styles.suggestions}>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => panelProps.onSourceDraftChange(suggestion)}
                    type="button"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
            <section
              aria-hidden={mode !== 'import'}
              aria-labelledby="reach-deck-brief-import-tab"
              className={`${styles.briefModeCard} ${styles.importModeCard}`}
              data-active={mode === 'import' || undefined}
              data-card-mode="import"
              id="reach-deck-brief-import-panel"
              inert={mode !== 'import'}
              role="tabpanel"
            >
              <div className={styles.importModeHeader}>
                <span className={styles.briefModeIcon}>
                  <FileUp size={20} />
                </span>
                <div>
                  <span className={styles.eyebrow}>{t('reachDeck.brief.mode.importEyebrow')}</span>
                  <h2>{t('reachDeck.brief.mode.import')}</h2>
                  <p>{t('reachDeck.brief.mode.importDescription')}</p>
                </div>
              </div>
              <div className={styles.importModeOptions}>
                {onRequestBlankCreate === undefined ? null : (
                  <button
                    className={styles.importModeOption}
                    disabled={
                      initialWorkspaceLoading ||
                      panelProps.busyAction !== undefined ||
                      (panelProps.workspace !== undefined &&
                        panelProps.workspace.source !== 'manual-empty')
                    }
                    onClick={() => void onRequestBlankCreate()}
                    type="button"
                  >
                    <span className={styles.importOptionIcon}>
                      <FilePlus2 size={22} />
                    </span>
                    <span>
                      <strong>{t('reachDeck.import.entry.blankCreate')}</strong>
                      <small>{t('reachDeck.brief.mode.blankDescription')}</small>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                )}
                {onRequestPptxCreate === undefined ? null : (
                  <button
                    className={styles.importModeOption}
                    disabled={panelProps.busyAction !== undefined}
                    onClick={onRequestPptxCreate}
                    type="button"
                  >
                    <span className={styles.importOptionIcon}>
                      <Presentation size={22} />
                    </span>
                    <span>
                      <strong>{t('reachDeck.import.entry.pptxCreate')}</strong>
                      <small>{t('reachDeck.brief.mode.pptxDescription')}</small>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                )}
                {onRequestMaicCreate === undefined ? null : (
                  <button
                    className={styles.importModeOption}
                    disabled={panelProps.busyAction !== undefined}
                    onClick={onRequestMaicCreate}
                    type="button"
                  >
                    <span className={styles.importOptionIcon}>
                      <FileText size={22} />
                    </span>
                    <span>
                      <strong>{t('reachDeck.import.entry.maicCreate')}</strong>
                      <small>{t('reachDeck.brief.mode.maicDescription')}</small>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                )}
              </div>
              <p className={styles.importModeHint}>
                <CircleAlert size={15} />
                {t(
                  importedWorkflow
                    ? 'reachDeck.brief.mode.existingDeckHint'
                    : 'reachDeck.brief.mode.directToStudio',
                )}
              </p>
            </section>
          </div>
        </div>
      </div>
      <div
        aria-label={t('reachDeck.brief.poweredByLabel')}
        className={styles.briefPoweredBy}
        data-brief-powered-by
        role="note"
      >
        <span aria-hidden="true" className={styles.briefPoweredByPrefix}>
          {t('reachDeck.brief.poweredBy')}
        </span>
        <span aria-hidden="true" className={styles.briefPoweredByCycle}>
          {BRIEF_POWERED_BY.map((brand) => (
            <span data-powered-by-brand key={brand}>
              {brand}
            </span>
          ))}
        </span>
      </div>
    </section>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function LessonPlanScreen({
  draft,
  enabledSceneTypes,
  job,
  loadedPlanSignature,
  onToggleSceneType,
  panelProps,
  setDraft,
}: {
  draft: LessonPlanForm | undefined;
  enabledSceneTypes: readonly PageOutline['sceneType'][];
  job?: Extract<ReachDeckGenerationPanelJob, { kind: 'lesson-plan' }>;
  loadedPlanSignature: MutableRefObject<string | undefined>;
  onToggleSceneType: (sceneType: PageOutline['sceneType']) => void;
  panelProps: ReachDeckGenerationPanelProps;
  setDraft: Dispatch<SetStateAction<LessonPlanForm | undefined>>;
}) {
  const { t } = usePortalI18n();
  const [activeTab, setActiveTab] = useState<LessonPlanTab>('overview');
  const tabPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tabPanelRef.current) tabPanelRef.current.scrollTop = 0;
  }, [activeTab]);
  // job 在采用后会被移除，回看时退回工作区已采用的教案，避免空白转圈。
  const plan: LessonPlan | undefined =
    (job?.done && job.status === 'completed' ? job.candidate : undefined) ??
    editableSavedLessonPlan(
      panelProps.workspace?.stagedLessonPlan ?? panelProps.workspace?.lessonPlan,
      panelProps.workspace?.advisoryLessonPlan,
    );
  const planSignature = plan === undefined ? undefined : JSON.stringify(plan);
  const active = job !== undefined && !job.done;
  const busy = panelProps.busyAction !== undefined;

  useEffect(() => {
    // 签名相同(含子屏重挂载)时跳过,保留父级暂存的草稿;仅在教案真正更新时重置。
    if (plan === undefined || planSignature === loadedPlanSignature.current) return;
    loadedPlanSignature.current = planSignature;
    setDraft(lessonPlanToForm(plan));
  }, [plan, planSignature, loadedPlanSignature, setDraft]);

  const lessonPlanDraft = draft === undefined ? undefined : lessonPlanFromForm(draft, plan);

  return (
    <section
      aria-label={t('reachDeck.lesson.label')}
      className={styles.documentScreen}
      style={{ flexDirection: 'column' }}
    >
      {job !== undefined && job.done && isFailedJobStatus(job.status) ? (
        <PlanningJobFailure
          compact={plan !== undefined}
          job={job}
          onRestart={() =>
            void (panelProps.onRestartPlanningStage !== undefined
              ? panelProps.onRestartPlanningStage('lesson-plan')
              : panelProps.onStartLessonPlan(undefined, {
                  regenerateNonce: createReachDeckUuid(),
                }))
          }
          panelProps={panelProps}
        />
      ) : !active &&
        plan === undefined &&
        (panelProps.workspace?.stage === 'copied' ||
          panelProps.workspace?.source === 'marketplace-copy') ? (
        <div className={styles.generatingDocument}>
          <p>{t('reachDeck.lesson.empty')}</p>
        </div>
      ) : active || plan === undefined ? (
        <GeneratingDocument
          compact={plan !== undefined}
          description={t('reachDeck.lesson.generatingBody')}
          onCancel={
            job === undefined || job.done
              ? undefined
              : { busy, run: () => void panelProps.onCancelJob(job.jobId) }
          }
          phase={job?.progressPhase}
          title={t('reachDeck.lesson.generatingTitle')}
        />
      ) : null}
      {plan !== undefined ? (
        <div className={styles.documentLayout}>
          <article className={styles.planPaper}>
            <div className={styles.planPaperHeader}>
              <div>
                <span className={styles.eyebrow}>{t('reachDeck.lesson.blueprint')}</span>
                <strong>{t('reachDeck.lesson.editHint')}</strong>
              </div>
              <div className={styles.planHeaderActions}>
                <ReachDeckMaterialReferenceDialog
                  workspace={panelProps.workspace}
                  onPreviewMaterialAsset={panelProps.onPreviewMaterialAsset}
                />
                <span className={styles.statusPill}>{t('reachDeck.lesson.reviewStatus')}</span>
              </div>
            </div>
            <div
              aria-label={t('reachDeck.lesson.tabsLabel')}
              className={styles.planTabs}
              role="tablist"
            >
              {(
                [
                  'overview',
                  'goals',
                  ...(plan?.knowledgePlan !== undefined ? ['knowledge' as const] : []),
                  'delivery',
                ] as const
              ).map((tab) => (
                <button
                  aria-selected={activeTab === tab}
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  role="tab"
                  type="button"
                >
                  {t(`reachDeck.lesson.tab.${tab}`)}
                </button>
              ))}
            </div>
            <div className={styles.planTabPanel} ref={tabPanelRef} role="tabpanel">
              {draft !== undefined && activeTab === 'overview' ? (
                <div className={`${styles.planSplit} ${styles.planOverview}`}>
                  <div className={`${styles.planSplitColumn} ${styles.planOverviewColumn}`}>
                    <div className={styles.planInlineRow}>
                      <PlanField label={t('reachDeck.lesson.titleLabel')}>
                        <input
                          aria-label={t('reachDeck.lesson.titleLabel')}
                          onChange={(event) =>
                            setDraft((current) =>
                              current === undefined
                                ? current
                                : { ...current, title: event.target.value },
                            )
                          }
                          value={draft.title}
                        />
                      </PlanField>
                      <PlanField label={t('reachDeck.lesson.duration')}>
                        <input
                          aria-label={t('reachDeck.lesson.durationLabel')}
                          min={1}
                          onChange={(event) =>
                            setDraft((current) =>
                              current === undefined
                                ? current
                                : { ...current, durationMinutes: event.target.value },
                            )
                          }
                          type="number"
                          value={draft.durationMinutes}
                        />
                      </PlanField>
                    </div>
                    <PlanField label={t('reachDeck.lesson.audience')}>
                      <textarea
                        aria-label={t('reachDeck.lesson.audienceLabel')}
                        className={styles.audienceInput}
                        onChange={(event) =>
                          setDraft((current) =>
                            current === undefined
                              ? current
                              : { ...current, audience: event.target.value },
                          )
                        }
                        rows={3}
                        value={draft.audience}
                      />
                    </PlanField>
                    <div className={styles.sceneTypeField}>
                      <PlanField label={t('reachDeck.lesson.sceneTypes')}>
                        <div
                          aria-label={t('reachDeck.lesson.sceneTypes')}
                          className={styles.sceneTypePicker}
                          role="group"
                        >
                          {outlineSceneTypes.map((sceneType) => {
                            const locked = sceneType === 'slide';
                            const SceneTypeIcon = outlineSceneTypeIcons[sceneType];
                            const label = sceneTypeLabel(sceneType, t);
                            return (
                              <button
                                aria-label={label}
                                aria-pressed={enabledSceneTypes.includes(sceneType)}
                                data-disabled={locked || undefined}
                                disabled={busy || locked}
                                key={sceneType}
                                onClick={() => onToggleSceneType(sceneType)}
                                title={label}
                                type="button"
                              >
                                <SceneTypeIcon aria-hidden="true" size={15} strokeWidth={2.2} />
                                <span className={styles.sceneTypeLabel}>{label}</span>
                                {enabledSceneTypes.includes(sceneType) ? (
                                  <Check
                                    aria-hidden="true"
                                    className={styles.sceneTypeCheck}
                                    size={11}
                                  />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                        <small className={styles.sceneTypeHint}>
                          {t('reachDeck.lesson.sceneTypesHint')}
                        </small>
                      </PlanField>
                    </div>
                  </div>
                  <div className={styles.planSplitColumn}>
                    {draft.story ? (
                      <LessonStoryEditor
                        story={draft.story}
                        objectives={draft.objectives ?? []}
                        disabled={busy}
                        onChange={(story) =>
                          setDraft((current) =>
                            current === undefined ? current : { ...current, story },
                          )
                        }
                      />
                    ) : null}
                    <PlanField
                      label={t(
                        draft.story
                          ? 'reachDeck.step2.story.supplement'
                          : 'reachDeck.lesson.narrative',
                      )}
                    >
                      <MarkdownRichTextField
                        disabled={busy}
                        label={t(
                          draft.story
                            ? 'reachDeck.step2.story.supplement'
                            : 'reachDeck.lesson.narrative',
                        )}
                        markdown={draft.narrative}
                        onChange={(narrative) =>
                          setDraft((current) =>
                            current === undefined ? current : { ...current, narrative },
                          )
                        }
                      />
                    </PlanField>
                  </div>
                </div>
              ) : null}
              {draft !== undefined && activeTab === 'goals' ? (
                <div className={styles.planSplit}>
                  <div className={styles.planSplitColumn}>
                    <LessonObjectivesEditor
                      disabled={busy}
                      objectives={draft.objectives ?? []}
                      onChange={(objectives) =>
                        setDraft((current) =>
                          current === undefined
                            ? current
                            : {
                                ...current,
                                objectives,
                                learningObjectives: objectives.map(({ statement }) => statement),
                              },
                        )
                      }
                    />
                  </div>
                  <div className={styles.planSplitColumn}>
                    <StringListRichTextField
                      addLabel={t('reachDeck.lesson.listAdd')}
                      disabled={busy}
                      label={t('reachDeck.lesson.keyTerms')}
                      onChange={(keyTerms) =>
                        setDraft((current) =>
                          current === undefined ? current : { ...current, keyTerms },
                        )
                      }
                      removeLabel={t('reachDeck.lesson.listRemove')}
                      value={draft.keyTerms}
                    />
                  </div>
                </div>
              ) : null}
              {draft !== undefined && activeTab === 'delivery' ? (
                <div className={styles.planSplit}>
                  <div className={styles.planSplitColumn}>
                    <PlanField label={t('reachDeck.lesson.strategy')}>
                      <MarkdownRichTextField
                        disabled={busy}
                        label={t('reachDeck.lesson.strategy')}
                        markdown={draft.teachingStrategy}
                        onChange={(teachingStrategy) =>
                          setDraft((current) =>
                            current === undefined ? current : { ...current, teachingStrategy },
                          )
                        }
                      />
                    </PlanField>
                  </div>
                  <div className={styles.planSplitColumn}>
                    <PlanField label={t('reachDeck.lesson.assessment')}>
                      <MarkdownRichTextField
                        disabled={busy}
                        label={t('reachDeck.lesson.assessment')}
                        markdown={draft.assessmentPlan}
                        onChange={(assessmentPlan) =>
                          setDraft((current) =>
                            current === undefined ? current : { ...current, assessmentPlan },
                          )
                        }
                      />
                    </PlanField>
                  </div>
                </div>
              ) : null}
              {activeTab === 'knowledge' && plan !== undefined ? (
                <LessonKnowledgePoints
                  disabled={busy}
                  knowledgePlan={draft?.knowledgePlan}
                  onChange={(knowledgePlan) =>
                    setDraft((current) =>
                      current === undefined
                        ? { ...lessonPlanToForm(plan), knowledgePlan }
                        : { ...current, knowledgePlan },
                    )
                  }
                  plan={lessonPlanDraft ?? plan}
                />
              ) : null}
            </div>
            <footer className={styles.planActions}>
              <p>{t('reachDeck.lesson.acceptHint')}</p>
              <div>
                {panelProps.onRestartPlanningStage !== undefined ? (
                  <button
                    className={styles.secondaryAction}
                    disabled={busy || active}
                    onClick={() => void panelProps.onRestartPlanningStage?.('lesson-plan')}
                    type="button"
                  >
                    <WandSparkles size={15} /> {t('reachDeck.lesson.regenerate')}
                  </button>
                ) : null}
                <button
                  className={styles.primaryAction}
                  disabled={busy || active || lessonPlanDraft === undefined}
                  onClick={() => {
                    if (lessonPlanDraft === undefined) return;
                    if (panelProps.onAdoptLessonPlan !== undefined) {
                      void panelProps.onAdoptLessonPlan(lessonPlanDraft, { enabledSceneTypes });
                    } else if (job !== undefined) {
                      void panelProps.onApplyLessonPlan(job.jobId);
                    }
                  }}
                  type="button"
                >
                  {t('reachDeck.lesson.accept')} <ArrowRight size={16} />
                </button>
              </div>
            </footer>
          </article>
        </div>
      ) : null}
    </section>
  );
}

function PageOutlineScreen({
  enabledSceneTypes,
  job,
  loadedOutlineSignature,
  outlineDraft,
  panelProps,
  selectedPageId,
  setOutlineDraft,
  setSelectedPageId,
}: {
  enabledSceneTypes: readonly PageOutline['sceneType'][];
  job?: Extract<ReachDeckGenerationPanelJob, { kind: 'page-outline' }>;
  loadedOutlineSignature: MutableRefObject<string | undefined>;
  outlineDraft: PagedDeckOutline | undefined;
  panelProps: ReachDeckGenerationPanelProps;
  selectedPageId: string | undefined;
  setOutlineDraft: Dispatch<SetStateAction<PagedDeckOutline | undefined>>;
  setSelectedPageId: Dispatch<SetStateAction<string | undefined>>;
}) {
  const { t } = usePortalI18n();
  // 只有已完成且候选已加载的任务能提供显示内容及其 provenance；终态任务缺少候选时
  // 依次退回工作区暂存/已采用大纲，避免把无关内容绑定到取消、失败或无结果任务。
  const completedCandidateJob =
    job !== undefined && job.done && job.status === 'completed' && job.candidate !== undefined
      ? job
      : undefined;
  const outline: PagedDeckOutline | undefined =
    completedCandidateJob?.candidate ??
    panelProps.workspace?.stagedPagedOutline ??
    panelProps.workspace?.pagedOutline;
  const outlineSignature = outline === undefined ? undefined : JSON.stringify(outline);
  const active = job !== undefined && !job.done;
  const busy = panelProps.busyAction !== undefined;
  const [overwriteConfirmation, setOverwriteConfirmation] = useState(false);

  useEffect(() => {
    // 签名相同(含子屏重挂载)时跳过,保留父级暂存的草稿;仅在大纲真正更新时重置。
    if (outline === undefined || outlineSignature === loadedOutlineSignature.current) return;
    loadedOutlineSignature.current = outlineSignature;
    setOutlineDraft({
      ...outline,
      pages: outline.pages.map((page) => ({
        ...page,
        ...(page.sceneType === 'slide' && page.slideClassification === undefined
          ? { slideClassification: defaultSlideClassification() }
          : {}),
      })),
    });
    setSelectedPageId(outline.pages[0]?.id);
  }, [outline, outlineSignature, loadedOutlineSignature, setOutlineDraft, setSelectedPageId]);

  const orderedPages = useMemo(
    () => outlineDraft?.pages.slice().sort((left, right) => left.order - right.order) ?? [],
    [outlineDraft],
  );
  const selectedPage = orderedPages.find((page) => page.id === selectedPageId) ?? orderedPages[0];
  const outlineEditorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (outlineEditorRef.current) outlineEditorRef.current.scrollTop = 0;
  }, [selectedPage?.id]);
  const lessonPlan = editableSavedLessonPlan(
    panelProps.workspace?.lessonPlan,
    panelProps.workspace?.advisoryLessonPlan,
  );
  // Teaching specifications are editable context, not a prerequisite for page production.
  const invalidScenePages = orderedPages.filter(
    (page) => !outlineSceneTypes.includes(page.sceneType),
  );
  const outlineDraftIsValid = invalidScenePages.length === 0;
  const outlineDraftDirty =
    outlineDraft !== undefined && JSON.stringify(outlineDraft) !== JSON.stringify(outline);

  const updateSelectedPage = (update: (page: PageOutline) => PageOutline) => {
    if (selectedPage === undefined) return;
    setOutlineDraft((current) =>
      current === undefined
        ? current
        : {
            ...current,
            pages: current.pages.map((page) => (page.id === selectedPage.id ? update(page) : page)),
          },
    );
  };

  const deletePage = (pageId: string) => {
    if (orderedPages.length <= 1) return;
    const deletedIndex = orderedPages.findIndex((page) => page.id === pageId);
    const remaining = orderedPages
      .filter((page) => page.id !== pageId)
      .map((page, index) => ({ ...page, order: index + 1 }));
    setOutlineDraft((current) =>
      current === undefined ? current : { ...current, pages: remaining },
    );
    setSelectedPageId(remaining[Math.min(Math.max(deletedIndex, 0), remaining.length - 1)]?.id);
  };

  const movePage = (result: DropResult) => {
    if (result.destination === undefined || result.destination === null) return;
    const from = result.source.index;
    const to = result.destination.index;
    if (from === to) return;
    const reordered = orderedPages.slice();
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    setOutlineDraft((current) =>
      current === undefined
        ? current
        : { ...current, pages: reordered.map((page, index) => ({ ...page, order: index + 1 })) },
    );
  };

  /**
   * 在页面地图第 index 个位置(0 起)手动插入一页。
   * id 随机生成(page-<uuid>,与服务端回填格式一致,不编码页序);
   * 新页带空的教学规格和中性分类骨架,可直接进入下一步由页面模型展开。
   */
  const insertPage = (index: number) => {
    const inserted: PageOutline = {
      id: `page-${createReachDeckUuid()}`,
      order: index + 1,
      sceneType: 'slide',
      title: t('reachDeck.outline.newPageTitle'),
      estimatedDurationMinutes: 3,
      instructionalSpec: emptyPageInstructionalSpec(),
      slideClassification: defaultSlideClassification(),
    };
    const next = orderedPages.slice();
    next.splice(index, 0, inserted);
    setOutlineDraft((current) =>
      current === undefined
        ? current
        : { ...current, pages: next.map((page, position) => ({ ...page, order: position + 1 })) },
    );
    setSelectedPageId(inserted.id);
  };

  const adoptOutline = () => {
    if (outlineDraft === undefined) return;
    if (panelProps.onAdoptPageOutline !== undefined) {
      void panelProps.onAdoptPageOutline(
        {
          ...outlineDraft,
          pages: outlineDraft.pages.map((page) =>
            applyPageInstructionalSpec(page, getPageInstructionalSpec(page)),
          ),
        },
        completedCandidateJob?.jobId,
      );
    } else if (completedCandidateJob !== undefined) {
      void panelProps.onApplyPageOutline(
        completedCandidateJob.jobId,
        outlineDraft.pages.map((page) => page.id),
      );
    }
  };

  const requestAdoptOutline = () => {
    if (outlineDraft === undefined) return;
    if (!outlineDraftIsValid) {
      setSelectedPageId(invalidScenePages[0]?.id);
      return;
    }
    const overwrites =
      panelProps.workspace !== undefined &&
      (panelProps.workspace.stage === 'page-generation' ||
        panelProps.workspace.stage === 'complete' ||
        panelProps.materialized === true);
    if (overwrites) {
      setOverwriteConfirmation(true);
      return;
    }
    adoptOutline();
  };

  return (
    <section
      aria-label={t('reachDeck.outline.label')}
      className={styles.documentScreen}
      style={{ flexDirection: 'column' }}
    >
      {job !== undefined && job.done && isFailedJobStatus(job.status) ? (
        <PlanningJobFailure
          compact={outline !== undefined}
          job={job}
          onRestart={() =>
            void (panelProps.onRestartPlanningStage !== undefined
              ? panelProps.onRestartPlanningStage('page-outline', undefined, {
                  enabledSceneTypes,
                })
              : panelProps.onStartPageOutline(undefined, {
                  enabledSceneTypes,
                  regenerateNonce: createReachDeckUuid(),
                }))
          }
          panelProps={panelProps}
        />
      ) : !active &&
        outline === undefined &&
        (panelProps.workspace?.stage === 'copied' ||
          panelProps.workspace?.source === 'marketplace-copy') ? (
        <div className={styles.generatingDocument}>
          <p>{t('reachDeck.outline.empty')}</p>
        </div>
      ) : active || outline === undefined ? (
        <GeneratingDocument
          compact={outline !== undefined}
          description={t('reachDeck.outline.generatingBody')}
          onCancel={
            job === undefined || job.done
              ? undefined
              : { busy, run: () => void panelProps.onCancelJob(job.jobId) }
          }
          phase={job?.progressPhase}
          title={t('reachDeck.outline.generatingTitle')}
        />
      ) : null}
      {outline !== undefined ? (
        <div className={styles.outlineWorkspace}>
          <aside className={styles.outlineDirectory}>
            <div>
              <span className={styles.eyebrow}>{t('reachDeck.outline.map')}</span>
              <strong>{t('reachDeck.outline.nodeCount', { count: orderedPages.length })}</strong>
            </div>
            <DragDropContext onDragEnd={movePage}>
              <Droppable droppableId="reach-deck-outline-pages">
                {(droppable) => (
                  <ol ref={droppable.innerRef} {...droppable.droppableProps}>
                    {orderedPages.map((page, index) => (
                      <Draggable
                        // 列表项内容几乎全是 button,库默认禁止从交互元素起拖;
                        // 打开后由位移阈值区分点击与拖拽,点击选中不受影响。
                        disableInteractiveElementBlocking
                        draggableId={page.id}
                        index={index}
                        isDragDisabled={busy}
                        key={page.id}
                      >
                        {(draggable) => (
                          <li
                            ref={draggable.innerRef}
                            {...draggable.draggableProps}
                            {...draggable.dragHandleProps}
                            aria-label={t('reachDeck.outline.dragPage', { title: page.title })}
                          >
                            {/* 悬浮在两项之间的间隙时浮现的插入热区(插到本项之前)。 */}
                            <button
                              aria-label={t('reachDeck.outline.insertPage', {
                                position: index + 1,
                              })}
                              className={styles.outlineInsert}
                              disabled={busy}
                              onClick={() => insertPage(index)}
                              type="button"
                            >
                              <Plus size={13} />
                            </button>
                            <button
                              aria-current={page.id === selectedPage?.id ? 'page' : undefined}
                              onClick={() => setSelectedPageId(page.id)}
                              type="button"
                            >
                              <span>{String(index + 1).padStart(2, '0')}</span>
                              <span>
                                <strong>{page.title}</strong>
                                <small>
                                  {t('reachDeck.outline.durationScene', {
                                    minutes: page.estimatedDurationMinutes ?? 0,
                                    scene: sceneTypeLabel(page.sceneType, t),
                                  })}
                                </small>
                                {(getPageInstructionalSpec(page).knowledgePointIds?.length ?? 0) >
                                0 ? (
                                  <small>
                                    {getPageInstructionalSpec(page)
                                      .knowledgePointIds?.map(
                                        (id, index) =>
                                          lessonPlan?.knowledgePlan?.points.find(
                                            (point) => point.id === id,
                                          )?.title ??
                                          t('reachDeck.outline.unavailableRelation', {
                                            index: index + 1,
                                          }),
                                      )
                                      .join(' · ')}
                                  </small>
                                ) : null}
                                {page.pageRole ? (
                                  <small>{t(`reachDeck.semantics.role.${page.pageRole}`)}</small>
                                ) : null}
                              </span>
                            </button>
                            <button
                              aria-label={t('reachDeck.outline.deletePage', { title: page.title })}
                              className={styles.outlineDelete}
                              disabled={orderedPages.length <= 1 || busy}
                              onClick={() => deletePage(page.id)}
                              type="button"
                            >
                              <Trash2 size={14} />
                            </button>
                          </li>
                        )}
                      </Draggable>
                    ))}
                    {droppable.placeholder}
                  </ol>
                )}
              </Droppable>
            </DragDropContext>
            <button
              aria-label={t('reachDeck.outline.insertPage', { position: orderedPages.length + 1 })}
              className={styles.outlineInsertTail}
              disabled={busy}
              onClick={() => insertPage(orderedPages.length)}
              type="button"
            >
              <Plus size={13} />
            </button>
          </aside>
          {selectedPage ? (
            <article className={styles.outlineEditor}>
              <div className={styles.outlineEditorBody} ref={outlineEditorRef}>
                <div className={styles.outlineTopline}>
                  <span>
                    {t('reachDeck.common.page')} {String(selectedPage.order).padStart(2, '0')}
                  </span>
                </div>
                <div className={styles.outlineTitle}>
                  <MarkdownRichTextField
                    allowBlockMath={false}
                    disabled={busy}
                    floatingMathTools
                    label={t('reachDeck.outline.titleLabel')}
                    markdown={selectedPage.title}
                    onChange={(title) => updateSelectedPage((page) => ({ ...page, title }))}
                  />
                </div>
                <div className={styles.outlineMeta}>
                  <label>
                    {t('reachDeck.outline.sceneType')}
                    <Select
                      aria-label={t('reachDeck.outline.sceneType')}
                      disabled={busy}
                      onChange={(sceneType) =>
                        updateSelectedPage((page) => {
                          const next = {
                            ...page,
                            sceneType,
                            ...(sceneType === 'slide'
                              ? {
                                  instructionalSpec:
                                    page.instructionalSpec ?? emptyPageInstructionalSpec(),
                                  slideClassification:
                                    page.slideClassification ?? defaultSlideClassification(),
                                }
                              : {}),
                          };
                          // Only legacy placeholders may be dropped. A v3 spec also records the
                          // teacher's explicit clearing and must survive scene switches.
                          if (
                            sceneType !== 'slide' &&
                            next.instructionalSpec !== undefined &&
                            next.instructionalSpec.schemaVersion !==
                              REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3 &&
                            isEmptyPageInstructionalSpec(next.instructionalSpec)
                          ) {
                            delete next.instructionalSpec;
                          }
                          return next;
                        })
                      }
                      options={outlineSceneTypes.map((sceneType) => ({
                        value: sceneType,
                        label: sceneTypeLabel(sceneType, t),
                      }))}
                      value={selectedPage.sceneType}
                    />
                  </label>
                  <label>
                    {t('reachDeck.outline.estimatedDuration')}
                    <span>
                      <DraftNumberInput
                        aria-label={t('reachDeck.outline.estimatedDuration')}
                        disabled={busy}
                        errorMessage={t('reachDeck.outline.estimatedDurationRange')}
                        isValidValue={(value) => Number.isFinite(value) && value > 0}
                        min={durationStepBase(selectedPage.estimatedDurationMinutes)}
                        onRestoreValue={(estimatedDurationMinutes) =>
                          updateSelectedPage((page) => ({
                            ...page,
                            estimatedDurationMinutes,
                          }))
                        }
                        onValidValueChange={(estimatedDurationMinutes) =>
                          updateSelectedPage((page) => ({
                            ...page,
                            estimatedDurationMinutes,
                          }))
                        }
                        step="1"
                        value={selectedPage.estimatedDurationMinutes}
                      />
                      {t('reachDeck.common.minutes')}
                    </span>
                  </label>
                </div>
                <ReachDeckPageSpecEditor
                  disabled={busy}
                  key={`spec-${selectedPage.id}`}
                  onChange={(instructionalSpec) =>
                    updateSelectedPage((page) =>
                      applyPageInstructionalSpec(page, instructionalSpec),
                    )
                  }
                  page={selectedPage}
                  plan={lessonPlan}
                  spec={getPageInstructionalSpec(selectedPage)}
                >
                  {selectedPage.sceneType === 'slide' ? (
                    <SlideClassificationEditor
                      classification={
                        selectedPage.slideClassification ?? defaultSlideClassification()
                      }
                      disabled={busy}
                      key={`classification-${selectedPage.id}`}
                      onChange={(slideClassification) =>
                        updateSelectedPage((page) => ({
                          ...page,
                          slideClassification: {
                            ...slideClassification,
                            density: getPageInstructionalSpec(page).density,
                          },
                        }))
                      }
                    />
                  ) : null}
                </ReachDeckPageSpecEditor>
                <div className={styles.outlineCallout}>
                  <Sparkles size={16} />
                  <p>{t('reachDeck.outline.contextNote')}</p>
                </div>
              </div>
              <footer className={styles.outlineActions}>
                <div>
                  <p>{t('reachDeck.outline.actionHint')}</p>
                  {invalidScenePages.length > 0 ? (
                    <p role="alert">
                      {t('reachDeck.outline.invalidSceneType', {
                        pages: invalidScenePages.map((page) => page.order).join(', '),
                      })}
                    </p>
                  ) : null}
                </div>
                {outlineDraftDirty ? <p role="status">{t('reachDeck.outline.unsaved')}</p> : null}
                <div>
                  {panelProps.onRestartPlanningStage !== undefined ? (
                    <button
                      className={styles.secondaryAction}
                      disabled={busy || active}
                      onClick={() =>
                        void panelProps.onRestartPlanningStage?.('page-outline', undefined, {
                          enabledSceneTypes,
                        })
                      }
                      type="button"
                    >
                      <WandSparkles size={15} /> {t('reachDeck.outline.regenerate')}
                    </button>
                  ) : null}
                  <button
                    className={styles.primaryAction}
                    disabled={
                      outlineDraft === undefined ||
                      orderedPages.length === 0 ||
                      !outlineDraftIsValid ||
                      (panelProps.onAdoptPageOutline === undefined &&
                        completedCandidateJob === undefined) ||
                      active ||
                      busy
                    }
                    onClick={requestAdoptOutline}
                    type="button"
                  >
                    {t('reachDeck.outline.continue')} <ArrowRight size={16} />
                  </button>
                </div>
              </footer>
            </article>
          ) : null}
        </div>
      ) : null}
      {overwriteConfirmation ? (
        <ConfirmDialog
          cancelLabel={t('shared.confirm.cancel')}
          confirmLabel={t('shared.confirm.continue')}
          description={t('reachDeck.outline.overwriteConfirm')}
          onCancel={() => setOverwriteConfirmation(false)}
          onConfirm={() => {
            setOverwriteConfirmation(false);
            adoptOutline();
          }}
          open
          title={t('reachDeck.outline.overwriteTitle')}
          tone="danger"
        />
      ) : null}
    </section>
  );
}

function emptyPageInstructionalSpec(): PageInstructionalSpec {
  return {
    schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3,
    pageRole: 'develop',
    pageJob: '',
    knowledgePointIds: [],
    learningObjective: '',
    teachingMove: 'explain',
    keyPoints: [],
    visualDirection: '',
    density: 'medium',
    visualAssets: [],
  };
}

function isEmptyPageInstructionalSpec(spec: PageInstructionalSpec): boolean {
  const hasContent = (value: unknown): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.some(hasContent);
    if (typeof value === 'object') return Object.values(value).some(hasContent);
    return true;
  };
  const { schemaVersion: _version, pageRole, teachingMove, density, ...editable } = spec;
  return (
    (pageRole === undefined || pageRole === 'develop') &&
    teachingMove === 'explain' &&
    density === 'medium' &&
    !Object.values(editable).some(hasContent)
  );
}

function defaultSlideClassification(): SlideOutlineClassification {
  return {
    primaryType: 'single_focus',
    density: 'medium',
    visualFocus: 'statement',
    mediaType: 'none',
  };
}

const outlineDensities: Array<PageInstructionalSpec['density']> = ['low', 'medium', 'high'];
const outlineVisualFocuses: Array<SlideOutlineClassification['visualFocus']> = [
  'statement',
  'process',
  'relationship',
  'evidence',
  'example',
  'summary',
];
const outlineMediaTypes: Array<SlideOutlineClassification['mediaType']> = [
  'none',
  'image',
  'scientific-visual',
  'diagram',
  'chart',
  'equation',
  'code',
];

/** 幻灯片信息分类的四个枚举下拉(仅 slide 页展示,决定版式检索)。 */
function SlideClassificationEditor({
  classification,
  disabled,
  onChange,
}: {
  classification: SlideOutlineClassification;
  disabled: boolean;
  onChange: (classification: SlideOutlineClassification) => void;
}) {
  const { t } = usePortalI18n();
  return (
    <section
      aria-label={t('reachDeck.outline.classificationSection')}
      className={styles.outlineSpecSection}
    >
      <span className={styles.outlineSpecTitle}>
        {t('reachDeck.outline.classificationSection')}
      </span>
      <div className={styles.outlineMeta}>
        <label>
          {t('reachDeck.outline.primaryType')}
          <Select
            aria-label={t('reachDeck.outline.primaryType')}
            disabled={disabled}
            onChange={(primaryType) => onChange({ ...classification, primaryType })}
            options={SLIDE_CONTENT_TYPES.map((contentType) => ({
              value: contentType,
              label: t(`reachDeck.outline.primaryType.${contentType}`),
            }))}
            value={classification.primaryType}
          />
        </label>
        <label>
          {t('reachDeck.outline.visualFocus')}
          <Select
            aria-label={t('reachDeck.outline.visualFocus')}
            disabled={disabled}
            onChange={(visualFocus) => onChange({ ...classification, visualFocus })}
            options={outlineVisualFocuses.map((focus) => ({
              value: focus,
              label: t(`reachDeck.outline.visualFocus.${focus}`),
            }))}
            value={classification.visualFocus}
          />
        </label>
        <label>
          {t('reachDeck.outline.mediaType')}
          <Select
            aria-label={t('reachDeck.outline.mediaType')}
            disabled={disabled}
            onChange={(mediaType) => onChange({ ...classification, mediaType })}
            options={outlineMediaTypes.map((mediaType) => ({
              value: mediaType,
              label: t(`reachDeck.outline.mediaType.${mediaType}`),
            }))}
            value={classification.mediaType}
          />
        </label>
      </div>
    </section>
  );
}

/**
 * markdown 字符串 ⇄ 富文本编辑器的通用桥接字段。
 * 外部状态保持 markdown(与生成链路/AI prompt 契约一致),编辑器内部维护 tiptap 文档,
 * 用 lastEmitted 防止自身 onChange 回流触发的重置。
 */
function MarkdownRichTextField({
  allowBlockMath,
  compact = true,
  disabled,
  floatingMathTools = false,
  label,
  markdown,
  onChange,
  placeholder,
  singleLine = false,
}: {
  allowBlockMath?: boolean;
  compact?: boolean;
  disabled: boolean;
  floatingMathTools?: boolean;
  label: string;
  markdown: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** 将段落/换行即时折叠为空格，供标题等单行 markdown string 契约使用。 */
  singleLine?: boolean;
}) {
  const [value, setValue] = useState<RichTextDocument>(() => outlineSummaryToRichText(markdown));
  const lastEmitted = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (markdown === lastEmitted.current) {
      // 这是本字段刚刚上抛后由父状态回流的同一个值，只跳过这一次重置。
      // 标记必须立即消费；否则切到其它页再返回时，同值会被误判为自身回流，
      // 使外部 page 已切回而 TipTap 仍停留在上一页内容。
      lastEmitted.current = undefined;
      return;
    }
    lastEmitted.current = undefined;
    setValue(outlineSummaryToRichText(markdown));
  }, [markdown]);

  return (
    <QuizRichTextEditor
      {...(allowBlockMath === undefined ? {} : { allowBlockMath })}
      compact={compact}
      disabled={disabled}
      label={label}
      onChange={(nextValue) => {
        const serialized = outlineSummaryFromRichText(nextValue);
        const nextMarkdown = singleLine ? serialized.replace(/\r?\n+/g, ' ').trim() : serialized;
        // 普通逐字输入保留编辑器原文档和选区；只有粘贴/换行真的违反单行契约时，
        // 才把编辑器内容同步回归一后的 markdown，避免只修 durable 值却让 UI 漂移。
        setValue(nextMarkdown === serialized ? nextValue : outlineSummaryToRichText(nextMarkdown));
        lastEmitted.current = nextMarkdown;
        onChange(nextMarkdown);
      }}
      {...(placeholder === undefined ? {} : { placeholder })}
      floatingMathTools={floatingMathTools}
      showColorTools={false}
      singleLine={singleLine}
      tablePasteMode="flatten"
      value={value}
    />
  );
}

/**
 * 字符串数组的列表编辑器:每个列表项一个精简富文本框(隐藏工具栏,聚焦时显示右侧公式按钮),
 * 支持增删项,直接以 string[] 收发。项内富文本产生的换行在上抛前折叠为空格,
 * 保证每个数组元素始终是单段文本。
 */
function StringListRichTextField({
  addLabel,
  disabled,
  label,
  maxItems,
  minItems = 1,
  onChange,
  removeLabel,
  value,
}: {
  addLabel: string;
  disabled: boolean;
  label: string;
  /** 可选项数上限；统一教学规格的内容与支撑证据不设置项数限制。 */
  maxItems?: number;
  minItems?: number;
  onChange: (value: string[]) => void;
  removeLabel: string;
  value: string[];
}) {
  const nextIdRef = useRef(0);
  const makeItem = (markdown: string) => ({ id: `li-${nextIdRef.current++}`, markdown });
  const [items, setItems] = useState<Array<{ id: string; markdown: string }>>(() =>
    value.map(makeItem),
  );
  const lastEmitted = useRef<string | undefined>(undefined);
  // 公式框失焦收起会引起布局位移,click 可能落在并未真正被按下的删除按钮上;
  // 仅当 pointerdown 与 click 都发生在同一删除按钮时才执行删除。
  const armedRemoveId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (JSON.stringify(value) === lastEmitted.current) return;
    setItems(value.map(makeItem));
    // makeItem 依赖 ref 计数器,自身引用稳定性无意义,仅需在外部值变化时重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (nextItems: Array<{ id: string; markdown: string }>) => {
    setItems(nextItems);
    const next = nextItems.map((item) => item.markdown.replace(/\r?\n+/g, ' ').trim());
    lastEmitted.current = JSON.stringify(next);
    onChange(next);
  };

  return (
    // 不能用 PlanField 的 <label> 包裹:无 for 的 label 会把点击转发给第一个可标注控件(即第一项的公式按钮)。
    <div className={styles.planField}>
      <span>{label}</span>
      <div className={styles.listField} role="group" aria-label={label}>
        {items.map((item, index) => (
          <div className={styles.listFieldItem} key={item.id}>
            <MarkdownRichTextField
              disabled={disabled}
              floatingMathTools
              label={`${label} ${index + 1}`}
              markdown={item.markdown}
              onChange={(markdown) =>
                emit(items.map((it) => (it.id === item.id ? { ...it, markdown } : it)))
              }
            />
            <button
              aria-label={`${removeLabel} ${index + 1}`}
              className={styles.listFieldRemove}
              disabled={disabled || items.length <= minItems}
              onClick={() => {
                if (armedRemoveId.current !== item.id) return;
                armedRemoveId.current = undefined;
                emit(items.filter((it) => it.id !== item.id));
              }}
              onPointerDown={() => {
                armedRemoveId.current = item.id;
              }}
              title={removeLabel}
              type="button"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          className={styles.listFieldAdd}
          disabled={disabled || (maxItems !== undefined && items.length >= maxItems)}
          onClick={() => emit([...items, makeItem('')])}
          type="button"
        >
          <Plus size={14} /> {addLabel}
        </button>
      </div>
    </div>
  );
}

function GenerationStudio({
  editor,
  materialized,
  panelProps,
  restoreInBody,
}: {
  editor: ReactNode;
  materialized: boolean;
  panelProps: ReachDeckGenerationPanelProps;
  restoreInBody: boolean;
}) {
  const { t } = usePortalI18n();
  const workspace = panelProps.workspace;
  const busy = panelProps.busyAction !== undefined;

  if (workspace === undefined) return null;

  const canRestorePriorRound =
    restoreInBody &&
    workspace.priorGeneration !== undefined &&
    panelProps.onRestorePriorGeneration !== undefined;

  return (
    <section
      aria-label={t('reachDeck.flow.editorLabel')}
      className={styles.editorScreen}
      data-editor-workspace="true"
    >
      {canRestorePriorRound ? (
        <button
          className={styles.fallbackRestorePriorRound}
          disabled={busy}
          onClick={() => void panelProps.onRestorePriorGeneration?.()}
          type="button"
        >
          <ArrowLeft size={14} /> {t('reachDeck.flow.restorePriorRound')}
        </button>
      ) : null}
      {editor ??
        (materialized && panelProps.materializedPreviewAvailable !== true ? (
          <section
            className={styles.canvasPlaceholder}
            role={panelProps.error === undefined ? 'status' : 'alert'}
          >
            {panelProps.error === undefined ? null : <CircleAlert aria-hidden size={34} />}
            {panelProps.error === undefined ? (
              <TeacherLoadingRegion label={t('reachDeck.flow.materializedDocumentLoading')} />
            ) : (
              <p>{panelProps.error}</p>
            )}
            <button
              className={styles.secondaryAction}
              disabled={busy}
              onClick={() => void panelProps.onRefresh()}
              type="button"
            >
              {t('reachDeck.flow.reload')}
            </button>
          </section>
        ) : (
          <div
            className={styles.canvasPlaceholder}
            role={panelProps.error === undefined ? 'status' : 'alert'}
          >
            {panelProps.error === undefined ? null : <CircleAlert aria-hidden size={34} />}
            {panelProps.error === undefined ? (
              <TeacherLoadingRegion label={t('reachDeck.flow.preparingEditor')} />
            ) : (
              <p>{panelProps.error}</p>
            )}
            {panelProps.error === undefined ? null : (
              <button
                className={styles.secondaryAction}
                disabled={busy}
                onClick={() => void panelProps.onRefresh()}
                type="button"
              >
                {t('reachDeck.flow.reload')}
              </button>
            )}
          </div>
        ))}
    </section>
  );
}

type ReachDeckBatchPageRef = Pick<ReachDeckDocument['pages'][number], 'order' | 'pageId' | 'title'>;

/**
 * 工具栏常驻任务状态入口；在途任务保留脉冲提醒，详情和取消在共享弹层内。
 */
function ReachDeckBatchActivityTrigger({
  singleJobs,
  pendingSingles,
  batches,
  busy,
  error,
  onCancelBatch,
  onCancelJob,
  pages,
}: {
  batches: readonly ReachDeckWorkspaceBatchView[];
  busy: boolean;
  error?: string;
  onCancelBatch?: (batchId: string) => Promise<void> | void;
  onCancelJob?: (jobId: string) => Promise<void> | void;
  pages?: readonly ReachDeckBatchPageRef[];
  singleJobs: readonly ReachDeckGenerationPanelJob[];
  pendingSingles: readonly PendingPageActivity[];
}) {
  const { t } = usePortalI18n();
  const [open, setOpen] = useState(false);
  const active =
    pendingSingles.length > 0 ||
    singleJobs.some((job) => !job.done && !pageActivityFailed(job)) ||
    batches.some(
      (batch) =>
        (batch.status === 'active' || batch.status === 'cancelling') &&
        reachDeckBatchUnfinishedMembers(batch).length > 0,
    );
  const attention =
    !active &&
    (singleJobs.some(pageActivityFailed) ||
      batches.some((batch) => batch.status === 'partial-failure' || batch.status === 'stopped'));
  const empty = batches.length === 0 && singleJobs.length === 0 && pendingSingles.length === 0;
  const label = t('reachDeck.flow.generationTaskStatus');
  const detailsLabel = t(
    singleJobs.length > 0 || pendingSingles.length > 0
      ? 'reachDeck.activity.label'
      : 'reachDeck.batch.label',
  );
  return (
    <div className={styles.batchActivity}>
      <Popover
        className={styles.batchActivityPopover}
        label={detailsLabel}
        onOpenChange={(next) => {
          if (!next && document.querySelector('[role="alertdialog"]')) return;
          setOpen(next);
        }}
        open={open}
        placement="bottom-end"
        trigger={
          <Button
            aria-label={label}
            className={styles.batchActivityTrigger}
            data-active={active || undefined}
            data-attention={attention || undefined}
            iconStart={<Activity />}
            size="sm"
            title={label}
            variant="default"
          >
            {label}
            {active ? <span aria-hidden className={styles.batchActivityPulse} /> : null}
          </Button>
        }
      >
        <div className={styles.batchActivityPopoverHeader}>
          <strong>
            {t(
              singleJobs.length > 0 || pendingSingles.length > 0
                ? 'reachDeck.activity.label'
                : 'reachDeck.batch.label',
            )}
          </strong>
          <button
            aria-label={t(
              singleJobs.length > 0 || pendingSingles.length > 0
                ? 'reachDeck.activity.close'
                : 'reachDeck.batch.activity.close',
            )}
            className={styles.batchActivityClose}
            onClick={() => setOpen(false)}
            title={t(
              singleJobs.length > 0 || pendingSingles.length > 0
                ? 'reachDeck.activity.close'
                : 'reachDeck.batch.activity.close',
            )}
            type="button"
          >
            <X aria-hidden size={14} />
          </button>
        </div>
        {empty ? (
          <p className={styles.batchActivityEmpty} role="status">
            {t('reachDeck.flow.generationTaskEmpty')}
          </p>
        ) : (
          <ReachDeckBatchSummaryStrip
            singleJobs={singleJobs}
            pendingSingles={pendingSingles}
            batches={batches}
            busy={busy}
            error={error}
            onCancelBatch={onCancelBatch}
            {...(onCancelJob === undefined ? {} : { onCancelJob })}
            pages={pages}
          />
        )}
      </Popover>
    </div>
  );
}

// 逐页进度按状态分组：需要教师处理的组置顶展开，已完成与跳过的组默认折叠，
// 避免大批次里成片的"已跳过"把失败页挤出视野。
const REACH_DECK_BATCH_MEMBER_GROUPS: ReadonlyArray<{
  labelKey: string;
  open: boolean;
  tone: ReachDeckBatchPageStatusTone;
}> = [
  { labelKey: 'reachDeck.batch.group.failed', open: true, tone: 'danger' },
  { labelKey: 'reachDeck.batch.group.attention', open: true, tone: 'warning' },
  { labelKey: 'reachDeck.batch.group.running', open: true, tone: 'progress' },
  { labelKey: 'reachDeck.batch.group.queued', open: true, tone: 'neutral' },
  { labelKey: 'reachDeck.batch.group.completed', open: false, tone: 'success' },
  { labelKey: 'reachDeck.batch.group.skipped', open: false, tone: 'muted' },
];

/** 批次分段进度条：各段按页数占比，剩余未结束的部分露出底色。 */
function ReachDeckBatchProgressBar({ summary }: { summary: ReachDeckBatchSummary }) {
  const segments = [
    ['success', summary.succeeded - summary.audioFailed],
    ['warning', summary.audioFailed + summary.blocked],
    ['danger', summary.failed],
    ['muted', summary.skipped + summary.cancelled],
  ] as const;
  const settled = segments.reduce((total, [, count]) => total + Math.max(0, count), 0);
  const total = Math.max(summary.total, settled, 1);
  return (
    <div aria-hidden className={styles.batchProgressBar}>
      {segments.map(([tone, count]) =>
        count > 0 ? (
          <i data-tone={tone} key={tone} style={{ width: `${(count / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

function ReachDeckBatchSummaryStrip({
  singleJobs,
  pendingSingles,
  batches,
  busy,
  error,
  onCancelBatch,
  onCancelJob,
  pages,
}: {
  batches: readonly ReachDeckWorkspaceBatchView[];
  busy: boolean;
  error?: string;
  onCancelBatch?: (batchId: string) => Promise<void> | void;
  onCancelJob?: (jobId: string) => Promise<void> | void;
  pages?: readonly ReachDeckBatchPageRef[];
  singleJobs: readonly ReachDeckGenerationPanelJob[];
  pendingSingles: readonly PendingPageActivity[];
}) {
  const { t } = usePortalI18n();
  // 逐页进度按批次分组：原先挂在页面列表缩略图下的文字行搬到这里。
  const pageOrder = useMemo(
    () =>
      pages === undefined
        ? undefined
        : [...pages].sort((left, right) => left.order - right.order).map((page) => page.pageId),
    [pages],
  );
  const pageTitles = useMemo(
    () =>
      pages === undefined
        ? undefined
        : Object.fromEntries(pages.map((page) => [page.pageId, page.title])),
    [pages],
  );
  const memberRowsByBatchId = useMemo(() => {
    const rows = new Map<
      string,
      Array<{
        label: string;
        number?: number;
        pageId: string;
        title: string;
        tone: ReachDeckBatchPageStatusTone;
      }>
    >();
    const presentations = presentReachDeckBatchPages(batches, t, { pageOrder, pageTitles });
    for (const [pageId, pagePresentations] of Object.entries(presentations)) {
      const index = pageOrder?.indexOf(pageId) ?? -1;
      for (const presentation of pagePresentations) {
        const list = rows.get(presentation.batchId) ?? [];
        list.push({
          label: presentation.label,
          ...(index < 0 ? {} : { number: index + 1 }),
          pageId,
          title: pageTitles?.[pageId] ?? t('reachDeck.batch.pageFallback'),
          tone: presentation.tone,
        });
        rows.set(presentation.batchId, list);
      }
    }
    for (const list of rows.values()) {
      list.sort(
        (left, right) =>
          (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER),
      );
    }
    return rows;
  }, [batches, pageOrder, pageTitles, t]);
  return (
    <section
      aria-label={t(
        singleJobs.length > 0 || pendingSingles.length > 0
          ? 'reachDeck.activity.label'
          : 'reachDeck.batch.label',
      )}
      className={styles.batchSummaryStrip}
    >
      {error === undefined ? null : (
        <p className={styles.batchSummaryError} role="alert">
          {error}
        </p>
      )}
      {pendingSingles.map((activity) => (
        <div
          className={styles.singlePageActivity}
          data-page-activity={activity.pageId}
          data-activity-status="submitting"
          key={'pending:' + activity.pageId}
          role="group"
        >
          <strong>
            {pageTitles?.[activity.pageId] ?? t('reachDeck.batch.pageFallback')} ·{' '}
            {t(pageActivityKindKey(activity))}
          </strong>
          <span>{t('reachDeck.editor.generation.submitting')}</span>
          <ProgressBar label={t('reachDeck.activity.progress')} />
        </div>
      ))}
      {singleJobs
        .filter((job) => !pendingSingles.some((pending) => pending.pageId === job.pageId))
        .map((job) => (
          <div
            className={styles.singlePageActivity}
            data-page-activity={job.pageId}
            data-activity-status={job.status}
            key={job.jobId}
            role="group"
          >
            <strong>
              {pageTitles?.[job.pageId ?? ''] ?? t('reachDeck.batch.pageFallback')} ·{' '}
              {t(pageActivityKindKey(job))}
            </strong>
            {onCancelJob !== undefined && !job.done && !pageActivityFailed(job) ? (
              <button
                aria-label={t('reachDeck.activity.cancelJobAria', {
                  kind: t(pageActivityKindKey(job)),
                  title: pageTitles?.[job.pageId ?? ''] ?? t('reachDeck.batch.pageFallback'),
                })}
                className={styles.batchSummaryCancel}
                disabled={busy}
                onClick={() => void onCancelJob(job.jobId)}
                type="button"
              >
                <Square aria-hidden size={11} />
                <span>{t('reachDeck.activity.cancelJob')}</span>
              </button>
            ) : null}
            <span
              role={
                job.status === 'cancelled'
                  ? 'status'
                  : pageActivityFailed(job)
                    ? 'alert'
                    : undefined
              }
            >
              {t(pageActivityLabelKey(job))}
            </span>
            <ProgressBar
              label={t('reachDeck.activity.progress')}
              showValue
              value={pageActivityProgress(job)}
              tone={
                job.status === 'cancelled'
                  ? 'primary'
                  : pageActivityFailed(job)
                    ? 'orange'
                    : job.done
                      ? 'success'
                      : 'primary'
              }
            />
          </div>
        ))}
      {batches.map((batch) => {
        const summary = summarizeReachDeckBatch(batch);
        const kindLabel = t(`reachDeck.batch.kind.${batch.kind}`);
        const statusLabel = reachDeckBatchStatusLabel(batch.status, t);
        const canCancel =
          onCancelBatch !== undefined &&
          batch.status === 'active' &&
          reachDeckBatchUnfinishedMembers(batch).length > 0;
        const memberRows = memberRowsByBatchId.get(batch.batchId) ?? [];
        return (
          <div
            aria-label={t('reachDeck.batch.summary.aria', {
              kind: kindLabel,
              status: statusLabel,
            })}
            className={styles.batchSummaryRow}
            data-batch-id={batch.batchId}
            data-batch-status={batch.status}
            key={batch.batchId}
            role="group"
          >
            <div className={styles.batchSummaryHeading}>
              <div className={styles.batchSummaryIdentity}>
                <strong>{kindLabel}</strong>
                <span data-status={batch.status}>{statusLabel}</span>
              </div>
              {canCancel ? (
                <button
                  aria-label={t('reachDeck.batch.cancel.summaryAria', { kind: kindLabel })}
                  className={styles.batchSummaryCancel}
                  disabled={busy}
                  onClick={() => void onCancelBatch?.(batch.batchId)}
                  title={t('reachDeck.batch.cancel.summaryAria', { kind: kindLabel })}
                  type="button"
                >
                  <Square aria-hidden size={11} />
                  <span>{t('reachDeck.batch.cancel.action')}</span>
                </button>
              ) : null}
            </div>
            <ReachDeckBatchProgressBar summary={summary} />
            <div className={styles.batchSummaryCounts} role="list">
              {(
                [
                  ['total', summary.total],
                  ['succeeded', summary.succeeded],
                  ['audioFailed', summary.audioFailed],
                  ['failed', summary.failed],
                  ['blocked', summary.blocked],
                  ['cancelled', summary.cancelled],
                  ['skipped', summary.skipped],
                ] as const
              )
                // 计数为 0 的类别不展示，避免一排"失败 0 未执行 0"稀释真正需要关注的数字。
                .filter(([key, count]) => key === 'total' || count > 0)
                .map(([key, count]) => (
                  <span data-count={key} key={key} role="listitem">
                    {t(`reachDeck.batch.summary.${key}`, { count })}
                  </span>
                ))}
            </div>
            {memberRows.length === 0 ? null : (
              <div
                aria-label={t('reachDeck.batch.members.label', { kind: kindLabel })}
                className={styles.batchSummaryMembers}
                role="group"
              >
                {REACH_DECK_BATCH_MEMBER_GROUPS.map(({ labelKey, open, tone }) => {
                  const rows = memberRows.filter((row) => row.tone === tone);
                  if (rows.length === 0) return null;
                  return (
                    <details
                      className={styles.batchMemberGroup}
                      data-tone={tone}
                      key={tone}
                      open={open}
                    >
                      <summary>
                        <ChevronRight aria-hidden size={12} />
                        <span>{t(labelKey)}</span>
                        <span>{t('reachDeck.batch.group.count', { count: rows.length })}</span>
                      </summary>
                      <ol>
                        {rows.map((row) => (
                          <li key={row.pageId}>
                            <span>
                              {row.number === undefined ? row.title : `${row.number}. ${row.title}`}
                            </span>
                            <span>{row.label}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function GeneratingDocument({
  compact = false,
  description,
  onCancel,
  phase,
  title,
}: {
  compact?: boolean;
  description: string;
  onCancel?: { busy: boolean; run: () => void };
  phase?: string;
  title: string;
}) {
  const { t } = usePortalI18n();
  const phaseKey = phase === undefined ? undefined : `reachDeck.jobs.phase.${phase}`;
  const phaseLabel =
    phaseKey === undefined ? undefined : t(phaseKey) === phaseKey ? phase : t(phaseKey);
  return (
    <div
      aria-live="polite"
      className={styles.generatingDocument}
      role="status"
      style={compact ? { minHeight: 0, padding: '16px 20px', flex: 'none' } : undefined}
    >
      {compact ? null : (
        <div className={styles.orbit}>
          <Sparkles size={22} />
          <i />
          <i />
        </div>
      )}
      <span className={styles.eyebrow}>
        {phaseLabel === undefined ? t('reachDeck.common.thinking') : phaseLabel}
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {onCancel === undefined ? null : (
        <button
          className={styles.secondaryAction}
          disabled={onCancel.busy}
          onClick={onCancel.run}
          style={{ marginTop: '18px' }}
          type="button"
        >
          <Square size={13} /> {t('reachDeck.jobs.cancel')}
        </button>
      )}
      {compact ? null : (
        <div className={styles.skeletonPaper}>
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
}

function isFailedJobStatus(status: string): boolean {
  return status === 'failed' || status === 'recovery-required' || status === 'cancelled';
}

function PlanField({
  children,
  label,
  wide,
}: {
  children: ReactNode;
  label: string;
  wide?: boolean;
}) {
  return (
    // 用 div 而非 label:无 for 的 label 会把空白处点击转发给第一个可标注控件,
    // 富文本字段的第一个控件是工具栏按钮(如加粗),会被静默触发。
    <div className={styles.planField} data-wide={wide || undefined}>
      <span>{label}</span>
      {children}
    </div>
  );
}

type LessonPlanTab = 'overview' | 'goals' | 'knowledge' | 'delivery';

interface LessonPlanForm extends Omit<LessonPlan, 'durationMinutes' | 'assessmentPlan'> {
  durationMinutes: string;
  assessmentPlan: string;
}

function lessonPlanToForm(plan: LessonPlan): LessonPlanForm {
  return {
    ...plan,
    id: plan.id,
    title: plan.title,
    audience: plan.audience,
    durationMinutes: String(plan.durationMinutes),
    objectives: editableLessonObjectives(plan),
    learningObjectives: editableLessonObjectives(plan).map(({ statement }) => statement),
    teachingStrategy: plan.teachingStrategy,
    keyTerms: [...plan.keyTerms],
    narrative: plan.narrative,
    assessmentPlan: plan.assessmentPlan ?? '',
  };
}

function lessonPlanFromForm(form: LessonPlanForm, fallback?: LessonPlan): LessonPlan | undefined {
  const durationMinutes = Number(form.durationMinutes);
  const learningObjectives = (form.objectives ?? []).map(({ statement }) => statement);
  const keyTerms = nonblankItems(form.keyTerms);
  if (
    form.title.trim().length === 0 ||
    form.audience.trim().length === 0 ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    learningObjectives.length === 0 ||
    form.teachingStrategy.trim().length === 0 ||
    keyTerms.length === 0 ||
    form.narrative.trim().length === 0
  ) {
    if (fallback === undefined) return undefined;
  }
  const candidate: LessonPlan = {
    ...(form.objectives === undefined ? {} : { objectives: form.objectives }),
    ...(form.story === undefined ? {} : { story: form.story }),
    // Step 2 is teacher-authored advisory context. Keep the edited knowledge
    // plan byte-for-byte at this boundary; do not reorder, truncate, repair
    // references, or fill teaching fields before the server adapter sees it.
    ...(form.knowledgePlan === undefined ? {} : { knowledgePlan: form.knowledgePlan }),
    ...(form.presentationPreferences === undefined
      ? {}
      : { presentationPreferences: form.presentationPreferences }),
    id: form.id,
    title: form.title,
    audience: form.audience,
    durationMinutes:
      Number.isFinite(durationMinutes) && durationMinutes > 0
        ? durationMinutes
        : (fallback?.durationMinutes ?? 0),
    learningObjectives,
    teachingStrategy: form.teachingStrategy,
    keyTerms: form.keyTerms,
    narrative: form.narrative,
    ...(form.assessmentPlan.trim().length === 0 ? {} : { assessmentPlan: form.assessmentPlan }),
  };
  return candidate;
}

function nonblankItems(items: string[]): string[] {
  return items
    .map((item) => item.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, ''))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function outlineSummaryToRichText(summary: string): RichTextDocument {
  try {
    return markdownToTiptapJson(summary);
  } catch {
    return richTextFromPlainText(summary);
  }
}

export function outlineSummaryFromRichText(document: RichTextDocument): string {
  return richTextHasRenderableContent(document) ? tiptapJsonToMarkdown(document).trim() : '';
}

function durationStepBase(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 1;
  const fraction = Number((value - Math.floor(value)).toFixed(10));
  return fraction > 0 ? fraction : 1;
}

/**
 * 延迟失效下同 kind 的旧完成任务与新任务可共存:
 * 最新登记的任务决定阶段状态；旧的在途或完成任务不能遮住本次重生成。
 */
function findJob<Kind extends ReachDeckGenerationPanelJob['kind']>(
  jobs: readonly ReachDeckGenerationPanelJob[],
  kind: Kind,
): Extract<ReachDeckGenerationPanelJob, { kind: Kind }> | undefined {
  const matching = jobs.filter(
    (job): job is Extract<ReachDeckGenerationPanelJob, { kind: Kind }> => job.kind === kind,
  );
  return matching.reduce<(typeof matching)[number] | undefined>(
    (latest, job) =>
      latest === undefined || isSameOrNewerGenerationJob(job, latest) ? job : latest,
    undefined,
  );
}

function sceneTypeLabel(
  sceneType: PageOutline['sceneType'],
  t: (key: string, replacements?: Record<string, string | number>) => string,
): string {
  return t(`reachDeck.outline.scene.${sceneType}`);
}
