import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import { createHash } from 'node:crypto';

import { agentLoop, type AgentContext, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Message, Model } from '@mariozechner/pi-ai';
import {
  REACH_DECK_BUILT_IN_FONT_FAMILIES,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { createModelServiceRequestSignal } from '../../env.js';
import {
  findReachDeckGeneratedMedia,
  resolveReachDeckDecksmithImageReference,
  storeReachDeckGeneratedMedia,
  type ReachDeckGeneratedMediaResource,
} from '../content-service-client.js';
import {
  AuthorizedImageError,
  loadAuthorizedReferenceImage,
  REFERENCE_IMAGE_EDIT_PRESET,
} from '../authorized-image.js';
import type { DecksmithFrozenVisualInputs } from './visual-input-contract.js';
import {
  DECKSMITH_VISION_IMAGE_CAPACITY_PLACEHOLDER,
  decksmithVisualInputLines,
  loadDecksmithVisualInputs,
  planDecksmithVisualEntries,
  projectDecksmithVisionContentForCapacity,
  type DecksmithVisualEntryState,
} from './visual-input.js';
import { decodeReachDeckGeneratedImage } from '../generated-media.js';
import { editReachDeckImage, generateReachDeckImage } from '../model-service-tools.js';
import {
  REACH_DECK_MODEL_CAPABILITIES,
  REACH_DECK_STAGE_MAX_OUTPUT_TOKENS,
  createModelServiceToken,
  generateTextWithModelService,
  resolveModelServiceOpenAiBaseUrl,
  type ReachDeckModelEnv,
  type ReachDeckModelRequestContext,
} from '../model-service-client.js';
import {
  decksmithInteractivePrompt,
  decksmithInteractivePromptLegacy,
} from '../prompts/decksmith-interactive.js';
import {
  decksmithActiveScientificCapabilities,
  projectDecksmithScientificContext,
} from './scientific-context.js';
import type { ReachDeckResourceScope } from '../resource-scope.js';
import {
  parseScientificContextSnapshot,
  scientificContextDiagnostic,
  scientificContextPolicy,
  scientificContextGeometryEnabled,
  scientificContextOutputRuntimeDependencies,
  type ScientificContextSnapshot,
} from '../scientific-generation-context.js';
import type { ReachDeckVoiceSelection } from '../voice-selection.js';
import {
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY,
  type ReachDeckDecksmithCompletion,
  type ReachDeckDecksmithOutcome,
  type ReachDeckDecksmithAfterApplyAction,
  type ReachDeckDecksmithSuggestedAction,
} from '../contracts.js';
import type {
  DecksmithClarificationAnswer,
  ReachDeckDecksmithClarification,
} from './clarification-contract.js';
import {
  buildDecksmithClarificationQuestionId,
  createDecksmithAskTeacherTool,
  decksmithBlockedByQuestionToolResult,
  decksmithClarificationAnswerNote,
  type DecksmithAskTeacherDependencies,
} from './clarification.js';
import {
  DECKSMITH_BUDGET_WRAP_UP_INSTRUCTION,
  DECKSMITH_DEFAULT_MAIN_OUTPUT_RESERVE,
  DECKSMITH_IMAGE_EDIT_TOKEN_RESERVE,
  DECKSMITH_IMAGE_GENERATION_TOKEN_RESERVE,
  DecksmithBudgetStopError,
  boundDecksmithRemainingTasks,
  decksmithContinuationTask,
  describeDecksmithBlockedToolCall,
  estimateDecksmithSubCallTokens,
  parseDecksmithDeclaredRemainingTasks,
  type DecksmithBudgetController,
} from './budget.js';
import type { DecksmithPageMediaStatus } from './page-stream-contracts.js';
import { quizQuestionStemValue } from '../quiz-model-output.js';
import { createDecksmithMediaTools, retryTransientImageFailure } from './media-tools.js';
import { shouldEnableDecksmithInteractiveHarness } from './interactive-context.js';
import { listDecksmithUncommittedInteractivePages } from './interactive-workspace.js';
import { DecksmithParallelArgumentsGuard } from './parallel-arguments-guard.js';
import {
  DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED,
  DECKSMITH_PROMPT_CONTRACT_V8,
  decksmithOffersAskTeacher,
  decksmithQuizContractStatesSceneShape,
  decksmithSystemPrompt,
  decksmithUsesOnDemandInteractiveContract,
  decksmithSchedulesMediaAfterApply,
  decksmithUsesQuizHistoryReceipts,
  type DecksmithPromptContractVersion,
} from './system-prompt.js';
import {
  DecksmithDocumentSession,
  DecksmithSessionError,
  type DecksmithInteractiveValidationOptions,
} from './session.js';
import { summarizeDecksmithDeckDesign } from './design-summary.js';
import {
  createDecksmithAfterApplyMediaTool,
  createDecksmithTools,
  DECKSMITH_QUIZ_RECEIPT_PREFIX,
  richTextPlainText,
} from './tools.js';
import { createDecksmithDraftTools, type DecksmithDraftToolDependencies } from './draft-tools.js';
import { loadDecksmithDraftDesign } from './draft-design.js';
import { boundDecksmithAssistantText } from './turn-memory.js';
import { decksmithDraftMediaResourceId, draftDecksmithHtmlComponents } from './html-draft.js';
import { compileHtmlLayout } from '../html-layout/index.js';
import {
  DECKSMITH_CAPACITY_ESTIMATOR_VERSION,
  DECKSMITH_CAPACITY_UNIT,
  countDeterministicCapacityStructure,
  decksmithCapacityApplicationMessage,
  deterministicCapacityMeasure,
  estimateDeterministicCapacity,
} from './capacity.js';

/**
 * Decksmith 的 model-service capability。
 *
 * 复用整文档生成的 document capability：model-service 的 Reach Deck capability
 * 白名单归算法团队维护，业务侧不改 model-service 代码；待算法团队补充
 * text.courseware.reach-deck.decksmith 白名单与路由策略后，这里切换为专属 capability。
 */
const DECKSMITH_CAPABILITY = REACH_DECK_MODEL_CAPABILITIES.document;

/**
 * 单次会话的最大 LLM 轮数，只防工具循环失控；花费由预算门控约束。
 * v6 起每轮只调一个工具：把一页改成 10 道题至少要 13 轮（读、10 次插入、删除、答复），
 * 读契约与修复失败还会更多，因此给足余量。到上限仍在调用工具时按"轮数截断"如实收尾。
 */
export const DECKSMITH_MAX_TURNS = 64;

const DECKSMITH_FONT_REQUEST_PATTERN = /(?:字体|字型|font(?:\s+family)?|typeface)/i;
const DECKSMITH_FONT_CLAUSE_SEPARATOR = /(?:[，,。；;\n]+|并(?:且)?|同时|然后|\b(?:and|then)\b)/i;
const DECKSMITH_EXECUTABLE_EDIT_PATTERN =
  /(?:修改|调整|改写|精简|缩短|扩写|删除|移除|添加|新增|插入|移动|对齐|排列|重写|替换|更(?:简洁|清晰|醒目)|change|adjust|rewrite|shorten|expand|delete|remove|add|insert|move|align|replace)/iu;
const DECKSMITH_FONT_FAMILY_AFTER_MARKER_PATTERNS = [
  /(?:字体|字型)\s*(?:修改|更改|设置|设|改|换)?\s*(?:为|成|到|使用|用)\s*[“"'‘]?([^，,。；;\n]+?)[”"'’]?\s*$/iu,
  /(?:font(?:\s+family)?|typeface)\s*(?:(?:change|set|switch)(?:\s+it)?\s*)?(?:to|as|:)\s*["']?([^,.;\n]+?)["']?\s*$/iu,
] as const;
const DECKSMITH_FONT_FAMILY_BEFORE_MARKER_PATTERNS = [
  /(?:使用|用|改成|换成)\s*[“"'‘]?([^，,。；;\n]+?)[”"'’]?\s*(?:字体|字型)\s*$/iu,
  /(?:change|set|switch|use)\s+(?:the\s+)?(?:font(?:\s+family)?|typeface)\s*(?:to|as)\s*["']?([^,.;\n]+?)["']?\s*$/iu,
  /\buse\s+["']?([^,.;\n]+?)["']?\s+(?:font(?:\s+family)?|typeface)\s*$/iu,
] as const;
const DECKSMITH_NON_FONT_FAMILY_PATTERN =
  /^(?:粗体|斜体|繁体|简体|正体|变体|字号|字重|字形|字体颜色|bold|italic|regular|light|medium|semibold|semi-bold|size|weight|style|color|colour|spacing|height|highlight|emphasize|(?:be\s+)?larger|a\s+larger\s+size|something\s+more\s+readable|uppercase|lowercase|match\s+the\s+title|default|blue|red|green)(?:\s|$)/iu;
const DECKSMITH_BUILT_IN_FONT_ALIASES = [
  '思源黑体',
  '思源宋体',
  '霞鹜文楷',
  '阿里巴巴普惠体',
  '阿里巴巴普惠体 3.0',
  '朱雀仿宋',
  '朱雀仿宋（预览测试版）',
] as const;
const DECKSMITH_COMMON_EXTERNAL_FONT_FAMILIES = new Set(
  [
    'Arial',
    'Calibri',
    'Cambria',
    'Futura',
    'Georgia',
    'Helvetica',
    'Helvetica Neue',
    'Impact',
    'Papyrus',
    'Segoe UI',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana',
  ].map((font) => font.toLowerCase()),
);
const DECKSMITH_REJECTED_FONT_FAMILY_LIMIT = 16;
const DECKSMITH_REJECTED_FONT_FAMILY_MAX_CHARACTERS = 256;

export interface DecksmithRunInput {
  capability: typeof REACH_DECK_DECKSMITH_CAPABILITY;
  document: unknown;
  prompt: string;
  /** 教师当前正在编辑的页面。 */
  pageId?: string;
  /** 教师在画布上选中的元素 id（仅 slide 页有意义）。 */
  selectedElementIds?: readonly string[];
  /** 面板内既往对话，按时间顺序；用于多轮上下文。 */
  history?: readonly { role: 'user' | 'assistant'; text: string }[];
  /** Validated page/epoch-local summary, never referenced-page chat. */
  contextSummary?: string;
  /** Frozen model profile guarantee for new v2 jobs. */
  capacity?: {
    readonly capacityProfileVersion?: string;
    readonly estimatorVersion?: string;
    readonly capacityUnit?: string;
    readonly guaranteedInputCapacity: number;
    readonly reservedOutputCapacity: number;
  };
  /** Server-authoritative status snapshot for narration/audio/animation on the origin page. */
  mediaStatus?: DecksmithPageMediaStatus;
  /** Server-resolved durable selection; legacy request-bound callers default explicitly. */
  voiceSelection?: ReachDeckVoiceSelection;
  /** Validated private frozen context; absent legacy Runs never retrieve new capabilities. */
  scientificContextSnapshot?: ScientificContextSnapshot;
  /**
   * 冻结的选中图片视觉输入（只含稳定标识）；执行时重新授权取图并作为首条用户消息的图片块附带。
   * 缺省时（旧 Run、未选图片）首条用户消息保持纯文本。
   */
  visualInputs?: DecksmithFrozenVisualInputs;
  /**
   * 冻结的提示词与工具合同版本（WP2 / 评审 M1）。缺省 = v1（旧 Run）：一段式系统提示词，
   * 互动合同按旧规则预加载到用户消息；新 Run 冻结当前版本，互动合同改为按需读取。
   */
  promptContractVersion?: DecksmithPromptContractVersion;
  /**
   * 本轮教师消息回答的 Decksmith 问题（WP7）：入队时校验后的关联结论，只在首条用户消息里加一行说明。
   * 缺省时（旧 Run、普通消息）首条用户消息逐字节不变。
   */
  clarificationAnswer?: DecksmithClarificationAnswer;
}

export interface DecksmithRunContext {
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
  /** model-service session id，durable worker 绑定 BullMQ job id。 */
  sessionId: string;
  /** Durable BullMQ identity; request-bound legacy callers may omit these fields. */
  jobId?: string;
  runId?: string;
}

export type DecksmithStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-start'; tool: string; label: string; callId: string }
  | {
      type: 'tool-end';
      tool: string;
      callId: string;
      inputSha256: string;
      outputSha256: string;
      durationMs: number;
      isError: boolean;
      summary?: string;
    }
  | {
      type: 'usage';
      model: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
  | {
      type: 'result';
      /** 面向界面的固定如实结果文案（旧合同字段，保持不变）。 */
      message: string;
      /**
       * 模型最后一条不含工具调用的答复（不是流式增量拼接，也不含中间计划），已按 UTF-8 字节预算截断；
       * 最后一条消息仍在调用工具（如达到回合上限）或没有文字时缺省。
       */
      assistantText?: string;
      changed: boolean;
      /**
       * Actual agent runs always emit this; optional keeps legacy internal event replays readable.
       * 以 ask_teacher 结束的回合（WP7）在这里带 clarification，且没有 document。
       */
      outcome?: ReachDeckDecksmithOutcome;
      document?: ReachDeckDocument;
    }
  | { type: 'error'; message: string };
export class DecksmithProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DecksmithProviderError';
  }
}

/**
 * A model dispatch was stopped locally because its exact accumulated payload no longer fits the
 * frozen input guarantee. Keep this error deliberately free of capacity/token measurements: the
 * application needs only a stable machine state and safe recovery guidance.
 */
export class DecksmithCapacityBlockedError extends Error {
  readonly state = 'blocked' as const;
  readonly messageKey: string;
  readonly guidance: { readonly action: 'new-topic'; readonly messageKey: string };

  constructor(message = 'Decksmith context is blocked; start a new topic to continue') {
    super(message);
    this.name = 'DecksmithCapacityBlockedError';
    const applicationMessage = decksmithCapacityApplicationMessage('blocked');
    this.messageKey = applicationMessage.messageKey;
    this.guidance = applicationMessage.guidance!;
  }
}

const TOOL_LABELS: Record<string, string> = {
  list_pages: '页面清单',
  read_page: '读取页面',
  set_page_title: '修改页面标题',
  upsert_native_text: '编辑原生文本',
  set_native_table_cell: '编辑表格单元格',
  upsert_native_shape: '编辑原生形状',
  transform_native_element: '变换原生元素',
  upsert_native_animation: '编辑原生动画',
  remove_native_animation: '删除原生动画',
  set_native_layout: '设置原生版式',
  set_native_narration: '编辑权威讲稿',
  suggest_page_action: '提供页面操作按钮',
  schedule_page_media_after_apply: '采用后生成页面媒体',
  draft_layout_with_html: '用排版管线起草组件',
  place_draft_elements: '放置起草的组件',
  insert_slide_page: '插入原生幻灯页',
  read_quiz_authoring_contract: '读取测验编写规范',
  read_interactive_authoring_contract: '读取互动页编写规范',
  insert_quiz_page: '插入测验页',
  insert_interactive_page: '插入互动页',
  replace_quiz_scene: '编辑测验场景',
  delete_page: '删除页面',
  move_page: '移动页面',
  generate_native_image: '生成并绑定原生图片',
  edit_native_image: '参考原图编辑图片',
  read_interactive_html: '读取互动页 HTML',
  edit_interactive_html: '补丁编辑互动页 HTML',
  write_interactive_html: '重写互动页 HTML',
  check_and_commit_interactive_page: '检查并提交互动页',
  ask_teacher: '向教师提问',
};

/**
 * 运行一次 Decksmith 编辑会话（pi-agent-core agentLoop + model-service 网关）。
 *
 * 数据源：入参 document（内存会话，不落库）；LLM 经 model-service /v1/chat/completions。
 * 核心逻辑：
 * 1. 用 document 建立会话草稿与工具面；
 * 2. 组装用户消息（教师指令 + 当前页 + 选中元素 + 面板历史）；
 * 3. agentLoop 顺序执行工具调用（文档变更必须串行），文本增量与工具事件实时向外流出；
 * 4. 传入预算控制器时（WP4），主模型调用在 onPayload、调模型的工具与其内部每次子调用在派发前过门控；
 *    放不下即停止调用模型，以已验证修改确定性收尾，并在 outcome 里给出 remainingTasks 与预算收尾状态；
 *    已用约 75% 时注入一次收尾提示；取消与护栏拒绝仍按失败处理；
 * 5. v3 提示词合同起（WP7）：ask_teacher 只在首个修改前可用；提问后同批其余调用一律不执行，
 *    本回合后不再调用模型，结果没有提案、outcome 带 clarification；
 * 6. 结束后输出 result（助手答复 + 是否变更 + 变更后的整文档），由前端确认采纳。
 */
export async function* runDecksmith(
  input: DecksmithRunInput,
  context: DecksmithRunContext,
  options: {
    env?: ReachDeckModelEnv;
    signal?: AbortSignal;
    throwOnError?: boolean;
    /**
     * 运行级预算门控（WP4）。durable worker 按已记账用量建立；缺省（请求绑定旧路径、测试）不门控，
     * 仍由共享记账函数的硬上限保护。
     */
    budget?: DecksmithBudgetController;
  } = {},
): AsyncGenerator<DecksmithStreamEvent> {
  const budget = options.budget;
  const env = options.env ?? process.env;
  const modelSignal = createModelServiceRequestSignal(env, 'stream', options.signal);
  const session = new DecksmithDocumentSession(input.document, input.capability, {
    ...(input.mediaStatus === undefined ? {} : { mediaStatus: input.mediaStatus }),
    interactiveValidationOptions: decksmithScientificValidationOptions(
      input.scientificContextSnapshot,
    ),
  });
  if (input.scientificContextSnapshot !== undefined) {
    const snapshot = parseScientificContextSnapshot(input.scientificContextSnapshot);
    console.info('Reach Deck scientific context', {
      runId: context.runId ?? context.sessionId,
      ...scientificContextDiagnostic(snapshot),
    });
  }
  const fontPolicy = analyzeDecksmithFontRequest(input.prompt);
  if (fontPolicy.rejectedFonts.length > 0 && fontPolicy.executablePrompt === undefined) {
    const outcome = buildDecksmithOutcome(false, fontPolicy.rejectedFonts, 0);
    yield {
      type: 'result',
      message: decksmithTruthfulResultMessage({
        changed: false,
        rejectedFonts: fontPolicy.rejectedFonts,
        toolErrorCount: 0,
      }),
      changed: false,
      outcome,
    };
    return;
  }
  const modelContext: ReachDeckModelRequestContext = {
    actorId: context.actorId,
    actorOrganizationId: context.actorOrganizationId,
    billingGroupId: context.billingGroupId,
    resourceScope: context.resourceScope,
    jobId: context.jobId ?? context.sessionId,
    runId: context.runId ?? context.sessionId,
  };
  const mediaOptions = {
    actorId: context.actorId,
    actorOrganizationId: context.actorOrganizationId,
    billingGroupId: context.billingGroupId,
    roleGrantId: context.roleGrantId,
    resourceScope: context.resourceScope,
  };
  const pendingToolUsage: Array<Extract<DecksmithStreamEvent, { type: 'usage' }>> = [];
  const budgetedSubCall = async (estimatedTokens: number): Promise<void> => {
    budget?.assertModelCall(estimatedTokens, 'sub-call');
  };
  // 结构化提问（WP7）：提问成功后记录在这里，工具包装据此阻断同批后续调用，轮后钩子据此停止。
  let clarification: ReachDeckDecksmithClarification | undefined;
  const askTeacher: DecksmithAskTeacherDependencies = {
    questionId: buildDecksmithClarificationQuestionId(context.runId ?? context.sessionId),
    ...(input.pageId === undefined ? {} : { originPageId: input.pageId }),
    // 修改 = 会话文档已变或有未提交的 Interactive 工作副本；提问不能把它们藏起来。
    hasMutation: () =>
      session.changed || listDecksmithUncommittedInteractivePages(session).length > 0,
    onAsked: (asked) => {
      clarification = asked;
    },
  };
  const tools = decksmithTools(
    session,
    {
      generateImage: async (mediaInput) => {
        const idempotencyKey = buildDecksmithMediaIdempotencyKey(context, 'image', mediaInput);
        const existing = await findReachDeckGeneratedMedia(
          { kind: 'image', pageId: mediaInput.pageId, idempotencyKey },
          mediaOptions,
        );
        if (existing !== undefined) return stableMediaAsset(existing);
        // 每次尝试（含瞬时失败后的重试）派发前都过预算门控。
        const generated = await retryTransientImageFailure(
          () =>
            budgetedSubCall(DECKSMITH_IMAGE_GENERATION_TOKEN_RESERVE).then(() =>
              generateReachDeckImage(mediaInput.prompt, {
                context: modelContext,
                env,
                signal: modelSignal,
                pageId: mediaInput.pageId,
                ...(mediaInput.size === undefined ? {} : { size: mediaInput.size }),
              }),
            ),
          { signal: modelSignal },
        );
        const stored = await storeReachDeckGeneratedMedia(
          {
            kind: 'image',
            pageId: mediaInput.pageId,
            idempotencyKey,
            ...decodeReachDeckGeneratedImage(generated),
          },
          mediaOptions,
        );
        return stableMediaAsset(stored);
      },
      // 参考图编辑：取图授权 → 有界下载与校验 → 归一 → 编辑 → 存为新的生成媒体（不覆盖旧图）。
      editImage: async (editInput) => {
        const idempotencyKey = buildDecksmithImageEditIdempotencyKey(context, {
          pageId: editInput.pageId,
          targetId: editInput.targetId,
          instruction: editInput.instruction,
          sourceObjectKey: editInput.source.objectKey,
        });
        const existing = await findReachDeckGeneratedMedia(
          { kind: 'image', pageId: editInput.pageId, idempotencyKey },
          mediaOptions,
        );
        if (existing !== undefined) return stableMediaAsset(existing);
        // 下载遇网络抖动或超时时重新授权（拿新的短时签名地址）再试一次；其余失败直接上抛。
        const loadReference = async () =>
          loadAuthorizedReferenceImage(
            await resolveReachDeckDecksmithImageReference(
              { objectKey: editInput.source.objectKey },
              { ...mediaOptions, signal: modelSignal },
            ),
            REFERENCE_IMAGE_EDIT_PRESET,
            { signal: modelSignal },
          );
        let referenceImage: Awaited<ReturnType<typeof loadReference>>;
        try {
          referenceImage = await loadReference();
        } catch (error) {
          if (!(error instanceof AuthorizedImageError) || !error.retryable || modelSignal.aborted) {
            throw error;
          }
          referenceImage = await loadReference();
        }
        const edited = await retryTransientImageFailure(
          () =>
            budgetedSubCall(DECKSMITH_IMAGE_EDIT_TOKEN_RESERVE).then(() =>
              editReachDeckImage(editInput.instruction, referenceImage.dataUrl, {
                context: modelContext,
                env,
                signal: modelSignal,
                pageId: editInput.pageId,
              }),
            ),
          { signal: modelSignal },
        );
        // The edit is a model call outside the agent loop; bill it with the run.
        if (edited.usage !== undefined) {
          budget?.recordUsage(edited.usage);
          pendingToolUsage.push({
            type: 'usage',
            model: edited.usage.model ?? 'decksmith-image-edit',
            promptTokens: edited.usage.promptTokens,
            completionTokens: edited.usage.completionTokens,
            totalTokens: edited.usage.totalTokens,
          });
        }
        const stored = await storeReachDeckGeneratedMedia(
          {
            kind: 'image',
            pageId: editInput.pageId,
            idempotencyKey,
            ...decodeReachDeckGeneratedImage(edited),
          },
          mediaOptions,
        );
        return stableMediaAsset(stored);
      },
      draft: async (draftInput) =>
        draftDecksmithHtmlComponents(
          {
            document: session.document,
            pageId: draftInput.pageId,
            instruction: draftInput.instruction,
            ...(draftInput.region === undefined ? {} : { region: draftInput.region }),
            design: await loadDecksmithDraftDesign(mediaOptions, draftInput.pageId),
            signal: modelSignal,
          },
          {
            generateHtml: (request) =>
              generateTextWithModelService({
                stage: 'slide',
                context: modelContext,
                env,
                signal: modelSignal,
                pageId: request.pageId,
                prompt: request.prompt,
                promptVersion: request.promptVersion,
                payload: request.payload,
                // 子调用每次派发前（含纠错重试）都按最终请求体过预算门控。
                ...(budget === undefined
                  ? {}
                  : {
                      onPayload: (payload: {
                        readonly modelInput: unknown;
                        readonly serializedModelInput: string;
                      }) =>
                        budget.assertModelCall(
                          estimateDecksmithSubCallTokens({
                            modelInput: payload.modelInput,
                            serializedModelInput: payload.serializedModelInput,
                            maxOutputTokens: REACH_DECK_STAGE_MAX_OUTPUT_TOKENS.slide ?? 0,
                          }),
                          'sub-call',
                        ),
                    }),
                // The brush is a model call outside the agent loop; bill it with the run.
                onUsage: (usage) => {
                  budget?.recordUsage(usage);
                  pendingToolUsage.push({
                    type: 'usage',
                    model: usage.model ?? 'html-layout',
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                    totalTokens: usage.totalTokens,
                  });
                },
              }),
            compile: compileHtmlLayout,
          },
        ),
      // Compiler rasters are uploaded only for draft elements that are actually placed.
      storeDraftMedia: async ({ pageId, bytes, contentType }) => {
        const digest = createHash('sha256').update(bytes).digest('hex');
        const stored = await storeReachDeckGeneratedMedia(
          {
            kind: 'image',
            pageId,
            idempotencyKey: `decksmith-html-layout:${modelContext.runId}:${pageId}:${digest}`,
            bytes,
            contentType,
          },
          mediaOptions,
        );
        return {
          id: decksmithDraftMediaResourceId(stored.objectKey),
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          digest: stored.checksumSha256 ?? digest,
        };
      },
    },
    input,
    askTeacher,
  );
  const apiKey = await createModelServiceToken(env, modelContext);

  let guardrailFailure: DecksmithProviderError | undefined;
  // 被预算拦下、没有执行的工具调用（确定性描述），作为下一轮"继续"的剩余任务。
  const budgetBlockedTasks: string[] = [];
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = async (...args) => {
      if (guardrailFailure) throw guardrailFailure;
      // 已向教师提问：同批其余调用（含再次提问）一律不执行，避免提问后仍改动课件。
      if (clarification !== undefined) return decksmithBlockedByQuestionToolResult();
      // 预算停止后同批剩余工具一律不执行（含不调用模型的工具），避免半批修改与收尾回合脱节。
      if (
        budget !== undefined &&
        (budget.stopped !== undefined ||
          (DECKSMITH_MODEL_CALLING_TOOLS.has(tool.name) && !budget.admitModelCall(0, 'tool')))
      ) {
        budgetBlockedTasks.push(describeDecksmithBlockedToolCall(tool.name, args[1]));
        return decksmithBudgetBlockedToolResult();
      }
      try {
        return await execute(...args);
      } catch (error) {
        const code = guardrailCode(error);
        if (code) guardrailFailure = new DecksmithProviderError(code, false);
        if (guardrailFailure === undefined && error instanceof DecksmithBudgetStopError) {
          budgetBlockedTasks.push(describeDecksmithBlockedToolCall(tool.name, args[1]));
          return decksmithBudgetBlockedToolResult();
        }
        throw guardrailFailure ?? error;
      }
    };
  }

  // 并行调用参数丢失防护（全部版本）：同一回复里多个调用且有必填参数的调用参数为空时，不执行、不计错，
  // 返回 DECKSMITH_PARALLEL_ARGUMENTS_DROPPED 诊断，见 parallel-arguments-guard.ts。
  const parallelArgumentsGuard = new DecksmithParallelArgumentsGuard();
  parallelArgumentsGuard.install(tools);

  const agentContext: AgentContext = {
    systemPrompt: decksmithSystemPrompt(input.promptContractVersion),
    messages: [],
    tools,
  };
  // 选中图片：按冻结标识重新授权、下载、核对 checksum 并归一；失败的条目在提示中显式说明。
  // 图片只存在于这条内存中的首条用户消息里，不进入事件、历史、冻结输入或压缩输入。
  // 取图在模型循环之前完成；取消或意外错误与模型调用失败走同一条归一化路径。
  let visualEntries: DecksmithVisualEntryState[] | undefined;
  try {
    visualEntries =
      input.visualInputs === undefined
        ? undefined
        : await loadDecksmithVisualInputs({
            visualInputs: input.visualInputs,
            document: session.document,
            resolve: (reference, signal) =>
              resolveReachDeckDecksmithImageReference(reference, { ...mediaOptions, signal }),
            load: loadAuthorizedReferenceImage,
            signal: modelSignal,
          });
  } catch (error) {
    if (options.throwOnError) throw normalizeDecksmithProviderError(error, modelSignal);
    yield {
      type: 'error',
      message: error instanceof Error ? error.message : 'Decksmith 会话执行失败。',
    };
    return;
  }
  const userContent = buildDecksmithUserContent(
    fontPolicy.executablePrompt === undefined
      ? input
      : { ...input, prompt: fontPolicy.executablePrompt },
    session,
    visualEntries,
  );
  const visionAttached = typeof userContent !== 'string';
  const userMessage: AgentMessage = {
    role: 'user',
    content:
      typeof userContent === 'string'
        ? userContent
        : userContent.map((part) =>
            part.type === 'text'
              ? part
              : { type: 'image' as const, data: part.base64, mimeType: part.mimeType },
          ),
    timestamp: Date.now(),
  };

  let turns = 0;
  let toolErrorCount = 0;
  // 跨轮记忆（WP1）：只记录最后一条助手消息；它带工具调用时说明还在中途，不作为最终答复。
  let finalAssistantReply: string | undefined;
  // 最后一条助手消息里的文字（含带工具调用的消息）；以提问结束时用作答复。
  let lastAssistantText: string | undefined;
  let capacityBlockedError: DecksmithCapacityBlockedError | undefined;
  const activeTools = new Map<string, { inputSha256: string; startedAt: number }>();
  // signal 是 agentLoop 的第 4 个参数(config 内同名字段会被 loop 覆盖,不能放 config 里)。
  try {
    const stream = agentLoop(
      [userMessage],
      agentContext,
      {
        model: buildDecksmithModel(env, input.capacity, visionAttached),
        // v4（WP3 方案 A）起测验写调用与过期 read_page 在历史里换成回执；已冻结 v1–v3 的 Run 保持原历史形状。
        convertToLlm: (messages) => {
          parallelArgumentsGuard.track(messages);
          return convertDecksmithMessagesForProvider(messages, {
            quizHistoryReceipts: decksmithUsesQuizHistoryReceipts(input.promptContractVersion),
          });
        },
        toolExecution: 'sequential',
        apiKey,
        sessionId: context.sessionId,
        maxRetries: 0,
        // 工具执行前先记入本轮主模型用量，批内工具的门控才看得到它（事件流消费是异步的）。
        beforeToolCall: async ({ assistantMessage }) => {
          budget?.noteMainResponse(assistantMessage);
          return undefined;
        },
        shouldStopAfterTurn: ({ message }) => {
          turns += 1;
          budget?.noteMainResponse(message);
          return (
            guardrailFailure !== undefined ||
            budget?.stopped !== undefined ||
            clarification !== undefined ||
            turns >= DECKSMITH_MAX_TURNS
          );
        },
        // 一次性收尾提示：作为运行时注入的用户消息排在下一次主模型调用之前。
        getSteeringMessages: async () =>
          budget?.takeWrapUpInstruction() === true
            ? [
                {
                  role: 'user' as const,
                  content: DECKSMITH_BUDGET_WRAP_UP_INSTRUCTION,
                  timestamp: Date.now(),
                },
              ]
            : [],
        onPayload: (payload) => {
          try {
            assertDecksmithProviderDispatchCapacity(payload, input.capacity);
          } catch (error) {
            if (error instanceof DecksmithCapacityBlockedError) capacityBlockedError = error;
            throw error;
          }
          if (
            budget !== undefined &&
            !budget.admitMainDispatch({
              inputUnits: estimateDecksmithMainPayloadUnits(payload),
              maxOutputTokens: decksmithPayloadMaxOutputTokens(payload),
            })
          ) {
            throw new DecksmithBudgetStopError('main');
          }
          return {
            ...(payload as Record<string, unknown>),
            session_id: context.sessionId,
            metadata: {
              reachany_application_llm_span: {
                invocation: {
                  scene_id: 'teacher.deck',
                  orchestration: 'courseware.deck',
                  stage: 'decksmith',
                  tool: 'chat',
                  channel: 'chat',
                },
                job_id: context.jobId ?? context.sessionId,
                run_id: context.runId ?? context.sessionId,
              },
            },
          };
        },
      },
      modelSignal,
    );

    for await (const event of stream) {
      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta') {
          yield { type: 'text-delta', delta: delta.delta };
        }
        continue;
      }
      if (event.type === 'tool_execution_start') {
        activeTools.set(event.toolCallId, {
          inputSha256: sha256Json(event.args),
          startedAt: Date.now(),
        });
        yield {
          type: 'tool-start',
          tool: event.toolName,
          label: TOOL_LABELS[event.toolName] ?? event.toolName,
          callId: event.toolCallId,
        };
        continue;
      }
      if (event.type === 'tool_execution_end') {
        if (guardrailFailure) throw guardrailFailure;
        yield* pendingToolUsage.splice(0);
        // 网关丢参被拦下的调用没有执行，也不是模型或工具的错误：不计入 toolErrorCount。
        const argumentsDropped = parallelArgumentsGuard.wasDropped(event.toolCallId);
        const isError = event.isError && !argumentsDropped;
        if (isError) toolErrorCount += 1;
        const active = activeTools.get(event.toolCallId);
        activeTools.delete(event.toolCallId);
        yield {
          type: 'tool-end',
          tool: event.toolName,
          callId: event.toolCallId,
          inputSha256: active?.inputSha256 ?? sha256Json({ unavailable: true }),
          outputSha256: sha256Json(event.result),
          durationMs: Math.max(0, Date.now() - (active?.startedAt ?? Date.now())),
          isError,
          summary: readToolSummary(event.result),
        };
        continue;
      }
      if (event.type === 'message_end') {
        const message = event.message as { role?: string };
        if (message.role === 'assistant') {
          const assistant = event.message as Extract<Message, { role: 'assistant' }>;
          if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
            // pi-ai converts an onPayload throw into an assistant error event. Restore the exact
            // local capacity type so the durable worker cannot classify it as a provider retry.
            if (capacityBlockedError !== undefined) throw capacityBlockedError;
            // 预算门控拦下的主模型调用没有发出：不是失败，按已验证修改确定性收尾。
            // 取消、护栏拒绝等仍走下面的原路径。
            if (
              budget?.stopped === 'main' &&
              assistant.stopReason === 'error' &&
              !modelSignal.aborted &&
              guardrailFailure === undefined
            ) {
              continue;
            }
            const message = assistant.errorMessage ?? 'Decksmith 模型调用失败，请稍后重试。';
            const guardrail = guardrailCode(message);
            if (guardrail) throw new DecksmithProviderError(guardrail, false);
            if (options.throwOnError) {
              if (assistant.stopReason === 'aborted' && modelSignal.aborted) {
                throw modelSignal.reason ?? new Error('Decksmith generation aborted');
              }
              throw new DecksmithProviderError(message, isRetryableProviderMessage(message));
            }
            yield { type: 'error', message };
            return;
          }
          lastAssistantText = assistant.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('');
          finalAssistantReply = assistant.content.some((part) => part.type === 'toolCall')
            ? undefined
            : lastAssistantText;
          if (assistant.usage !== undefined) {
            yield {
              type: 'usage',
              model: assistant.responseModel ?? assistant.model,
              promptTokens: assistant.usage.input,
              completionTokens: assistant.usage.output,
              totalTokens: assistant.usage.totalTokens,
            };
          }
        }
      }
    }
  } catch (error) {
    if (options.throwOnError) {
      throw normalizeDecksmithProviderError(error, modelSignal);
    }
    yield {
      type: 'error',
      message: error instanceof Error ? error.message : 'Decksmith 会话执行失败。',
    };
    return;
  }

  // 预算停止会让循环不再调用模型而正常结束；此时已发生的取消或护栏拒绝必须照原样失败，
  // 不能被包装成正常的部分提案。
  if (budget?.stopped !== undefined) {
    if (guardrailFailure !== undefined) {
      if (options.throwOnError) throw guardrailFailure;
      yield { type: 'error', message: guardrailFailure.message };
      return;
    }
    if (modelSignal.aborted) {
      if (options.throwOnError) {
        throw modelSignal.reason ?? new Error('Decksmith generation aborted');
      }
      yield { type: 'error', message: 'Decksmith generation aborted' };
      return;
    }
  }
  // 提问结束的回合不是额度收尾：提问只在首个修改前成功，之后整批不执行，不存在需要续做的修改。
  // 额度收尾优先；否则到轮数上限且最后一条助手消息仍在调用工具时，是被截断的未完成任务。
  const budgetOutcome =
    clarification !== undefined
      ? undefined
      : (decksmithBudgetOutcome({
          budget,
          blockedTasks: budgetBlockedTasks,
          uncommittedInteractivePages: listDecksmithUncommittedInteractivePages(session),
          finalReply: finalAssistantReply,
          prompt: input.prompt,
        }) ??
        decksmithStepLimitOutcome({
          turns,
          finalReply: finalAssistantReply,
          uncommittedInteractivePages: listDecksmithUncommittedInteractivePages(session),
          prompt: input.prompt,
        }));
  const outcome = buildDecksmithOutcome(
    session.changed,
    fontPolicy.rejectedFonts,
    toolErrorCount,
    session.suggestedActions,
    budgetOutcome,
    clarification,
    session.changed && clarification === undefined ? session.afterApplyActions : [],
  );
  yield {
    type: 'result',
    message:
      clarification !== undefined
        ? DECKSMITH_CLARIFICATION_RESULT_MESSAGE
        : decksmithTruthfulResultMessage({
            changed: session.changed,
            rejectedFonts: fontPolicy.rejectedFonts,
            toolErrorCount,
            ...(budgetOutcome === undefined
              ? {}
              : {
                  remainingTaskCount: budgetOutcome.remainingTasks.length,
                  completionState: budgetOutcome.completion.state,
                }),
          }),
    ...withAssistantText(
      boundDecksmithAssistantText(
        clarification !== undefined ? lastAssistantText : finalAssistantReply,
      ),
    ),
    changed: session.changed,
    outcome,
    ...(session.changed ? { document: session.document } : {}),
  };
}

/** 以提问结束的回合的固定如实结果文案（界面另按 i18n 渲染问题卡片）。 */
const DECKSMITH_CLARIFICATION_RESULT_MESSAGE = 'Decksmith 需要你先回答一个问题，课件未修改。';

function withAssistantText(text: string | undefined): { assistantText?: string } {
  return text === undefined ? {} : { assistantText: text };
}

function analyzeDecksmithFontRequest(prompt: string): {
  readonly executablePrompt?: string;
  readonly rejectedFonts: readonly string[];
} {
  if (!DECKSMITH_FONT_REQUEST_PATTERN.test(prompt)) {
    return { rejectedFonts: [] };
  }

  const clauses = prompt
    .split(DECKSMITH_FONT_CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const builtInFonts = new Set(
    [...REACH_DECK_BUILT_IN_FONT_FAMILIES, ...DECKSMITH_BUILT_IN_FONT_ALIASES].map((font) =>
      font.toLowerCase(),
    ),
  );
  const fontRequests = clauses.map((clause) => ({
    clause,
    families: extractRequestedFontFamilies(clause, builtInFonts),
  }));
  const requestedFonts = fontRequests.flatMap((request) => request.families);
  const unsupportedFonts = requestedFonts.filter(
    (font) => !builtInFonts.has(font.trim().toLowerCase()),
  );
  const rejectedFonts = normalizeRejectedFontFamilies(unsupportedFonts);
  if (rejectedFonts.length === 0) return { rejectedFonts: [] };

  const rejectedFontSet = new Set(unsupportedFonts.map((font) => font.trim().toLowerCase()));
  const remainingClauses = fontRequests
    .filter((request) => !request.families.some((font) => rejectedFontSet.has(font.toLowerCase())))
    .map((request) => request.clause);
  return {
    rejectedFonts,
    ...(remainingClauses.some((clause) => DECKSMITH_EXECUTABLE_EDIT_PATTERN.test(clause))
      ? { executablePrompt: remainingClauses.join('，') }
      : {}),
  };
}

function extractRequestedFontFamilies(clause: string, builtInFonts: ReadonlySet<string>): string[] {
  const candidates = [
    ...DECKSMITH_FONT_FAMILY_AFTER_MARKER_PATTERNS,
    ...DECKSMITH_FONT_FAMILY_BEFORE_MARKER_PATTERNS,
  ].flatMap((pattern) => pattern.exec(clause)?.[1] ?? []);
  return candidates
    .flatMap((candidate) => candidate.split(/(?:、|\/|\s+(?:和|与|and)\s+)/i))
    .map((candidate) =>
      candidate
        .replace(/[”"'’]/g, '')
        .replace(/(?:字体|字型|font(?:\s+family)?|typeface)$/i, '')
        .trim(),
    )
    .filter((candidate) => isLikelyFontFamily(candidate, builtInFonts));
}

function isLikelyFontFamily(candidate: string, builtInFonts: ReadonlySet<string>): boolean {
  const normalized = candidate.trim();
  const normalizedLower = normalized.toLowerCase();
  if (builtInFonts.has(normalizedLower)) return true;
  if (DECKSMITH_NON_FONT_FAMILY_PATTERN.test(candidate)) return false;
  if (DECKSMITH_COMMON_EXTERNAL_FONT_FAMILIES.has(normalizedLower)) return true;
  if (
    /^[A-Z][A-Za-z0-9]*(?:[ ._()-][A-Z0-9][A-Za-z0-9 ._()-]*)*$/u.test(normalized) ||
    /^[A-Z]{8,}$/u.test(normalized)
  ) {
    return true;
  }
  return /^(?:(?:华文|方正|汉仪|思源)[\p{Script=Han}]{1,10}|[\p{Script=Han}]{1,12}(?:体|宋|黑|楷)|微软雅黑|苹方|等线|隶书|幼圆)$/u.test(
    candidate,
  );
}

function normalizeRejectedFontFamilies(fonts: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const font of fonts) {
    const bounded = font.trim().slice(0, DECKSMITH_REJECTED_FONT_FAMILY_MAX_CHARACTERS).trim();
    if (bounded === '') continue;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(bounded);
    if (normalized.length === DECKSMITH_REJECTED_FONT_FAMILY_LIMIT) break;
  }
  return normalized;
}

export function buildDecksmithOutcome(
  changed: boolean,
  rejectedFontFamilies: readonly string[],
  toolErrorCount: number,
  suggestedActions: readonly ReachDeckDecksmithSuggestedAction[] = [],
  budgetOutcome?: DecksmithBudgetOutcome,
  clarification?: ReachDeckDecksmithClarification,
  afterApply: readonly ReachDeckDecksmithAfterApplyAction[] = [],
): ReachDeckDecksmithOutcome {
  // 已声明采用后自动生成媒体的页不再给同类按钮，避免教师点了又重复生成（WP8）。
  const scheduledPageIds = new Set(afterApply.map((action) => action.pageId));
  const buttons = suggestedActions.filter(
    (action) =>
      !scheduledPageIds.has(action.pageId) ||
      (action.kind !== 'generate-page-audio' && action.kind !== 'regenerate-page-media'),
  );
  return {
    ...(buttons.length === 0 ? {} : { suggestedActions: [...buttons] }),
    schemaVersion: 'reach-deck-decksmith-outcome/v1',
    mutationStatus: !changed
      ? 'none'
      : rejectedFontFamilies.length > 0 || toolErrorCount > 0 || budgetOutcome !== undefined
        ? 'partial'
        : 'proposal',
    rejectedFontFamilies,
    toolErrorCount,
    ...(budgetOutcome === undefined
      ? {}
      : {
          remainingTasks: budgetOutcome.remainingTasks,
          completion: budgetOutcome.completion,
        }),
    ...(clarification === undefined ? {} : { clarification }),
    ...(afterApply.length === 0 ? {} : { afterApply: [...afterApply] }),
  };
}

interface DecksmithBudgetOutcome {
  readonly remainingTasks: readonly string[];
  readonly completion: ReachDeckDecksmithCompletion;
}

/**
 * 预算收尾结局（WP4）。
 *
 * 数据源：运行内的预算控制器状态、被拦下的工具调用描述、会话内未提交的 Interactive 工作副本与模型最后一条无工具答复。
 * 核心逻辑：
 * 1. 硬门控停止时：剩余任务 = 收尾提示后模型声明的任务 + 未提交的 Interactive 工作副本 + 被拦下的工具调用；
 *    都没有时给一条通用续做条目；
 * 2. 只发出了收尾提示、模型正常结束时：模型按提示列出剩余任务或留下未提交的工作副本才算预算收尾；
 * 3. 否则返回 undefined（普通结局，小修改不会多一轮）。
 * 设计动机：工作副本不在提案文档里，提前收尾时必须明示"未包含、需重做并提交"，不能静默丢失。
 */
function decksmithBudgetOutcome(input: {
  readonly budget: DecksmithBudgetController | undefined;
  readonly blockedTasks: readonly string[];
  readonly uncommittedInteractivePages: readonly string[];
  readonly finalReply: string | undefined;
  readonly prompt: string;
}): DecksmithBudgetOutcome | undefined {
  const budget = input.budget;
  if (budget === undefined) return undefined;
  if (budget.stopped === undefined && !budget.wrapUpIssued) return undefined;
  const declared = budget.wrapUpIssued
    ? parseDecksmithDeclaredRemainingTasks(input.finalReply)
    : [];
  const uncommitted = input.uncommittedInteractivePages.map(
    (pageId) =>
      `Interactive page ${pageId} had uncommitted working-copy edits that are NOT in this proposal; redo them and commit with check_and_commit_interactive_page`,
  );
  let remainingTasks = boundDecksmithRemainingTasks([
    ...declared,
    ...uncommitted,
    ...input.blockedTasks,
  ]);
  if (budget.stopped === undefined && remainingTasks.length === 0) return undefined;
  if (remainingTasks.length === 0) remainingTasks = [decksmithContinuationTask(input.prompt)];
  return { remainingTasks, completion: budget.completion() };
}

/**
 * 轮数截断结局：达到 {@link DECKSMITH_MAX_TURNS} 时最后一条助手消息仍带工具调用（没有最终答复），
 * 说明任务还没做完。剩余任务 = 未提交的 Interactive 工作副本 + 一条通用续做条目；
 * 不能当成普通提案返回，否则教师以为已全部完成。
 */
function decksmithStepLimitOutcome(input: {
  readonly turns: number;
  readonly finalReply: string | undefined;
  readonly uncommittedInteractivePages: readonly string[];
  readonly prompt: string;
}): DecksmithBudgetOutcome | undefined {
  if (input.turns < DECKSMITH_MAX_TURNS || input.finalReply !== undefined) return undefined;
  const remainingTasks = boundDecksmithRemainingTasks([
    ...input.uncommittedInteractivePages.map(
      (pageId) =>
        `Interactive page ${pageId} had uncommitted working-copy edits that are NOT in this proposal; redo them and commit with check_and_commit_interactive_page`,
    ),
    decksmithContinuationTask(input.prompt),
  ]);
  return {
    remainingTasks,
    completion: { state: 'step-limited', messageKey: REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY },
  };
}

/** 门控涉及的、会在工具内发起模型或图片调用的工具。 */
const DECKSMITH_MODEL_CALLING_TOOLS = new Set([
  'generate_native_image',
  'edit_native_image',
  'draft_layout_with_html',
]);

function decksmithBudgetBlockedToolResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          applied: false,
          code: 'DECKSMITH_BUDGET_EXHAUSTED',
          note: 'Not executed: this request has no token budget left for it. The run stops here and the teacher can say "continue" next turn.',
        }),
      },
    ],
    details: { budgetBlocked: true },
    terminate: true,
  };
}

/** 每条消息与每个工具定义的模板开销上界（角色标记、分隔符等）。 */
const DECKSMITH_MAIN_PAYLOAD_ITEM_OVERHEAD = 16;

/**
 * 主模型请求的确定性计费 token 上界：模型可见部分（消息 + 工具，图片按容量占位计）的 UTF-8 字节数，
 * 加上每条消息与每个工具的模板开销。字节级 BPE 下每个 token 至少对应 1 字节，因此字节数是 token
 * 上界；不沿用容量估算里"每个 JSON 结构项 16"的项，那是跨模型上下文容量的保守口径，按计费 token
 * 用会把首轮高估约一倍。请求体异常时退回整体 UTF-8 字节数。
 */
export function estimateDecksmithMainPayloadUnits(payload: unknown): number {
  try {
    const record = payload as { messages: unknown[]; tools: unknown[] };
    const measure = measureDecksmithProviderPayload(payload);
    return (
      measure.serializedInputUtf8Bytes +
      DECKSMITH_MAIN_PAYLOAD_ITEM_OVERHEAD * (record.messages.length + record.tools.length)
    );
  } catch {
    return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
  }
}

/** 主模型请求声明的最大输出（pi-ai 按 compat 写入 max_tokens 或 max_completion_tokens）。 */
function decksmithPayloadMaxOutputTokens(payload: unknown): number {
  const record =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  for (const value of [record.max_tokens, record.max_completion_tokens]) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  }
  return DECKSMITH_DEFAULT_MAIN_OUTPUT_RESERVE;
}

function decksmithTruthfulResultMessage(input: {
  readonly changed: boolean;
  readonly rejectedFonts: readonly string[];
  readonly toolErrorCount: number;
  readonly remainingTaskCount?: number;
  readonly completionState?: ReachDeckDecksmithCompletion['state'];
}): string {
  const budget =
    input.remainingTaskCount === undefined
      ? ''
      : input.completionState === 'step-limited'
        ? ` 本次已达到单次执行步数上限，还有 ${input.remainingTaskCount} 项未完成，回复"继续"可接着做。`
        : ` 本次额度已用完，还有 ${input.remainingTaskCount} 项未完成，回复"继续"可接着做。`;
  return decksmithTruthfulResultBaseMessage(input) + budget;
}

function decksmithTruthfulResultBaseMessage(input: {
  readonly changed: boolean;
  readonly rejectedFonts: readonly string[];
  readonly toolErrorCount: number;
}): string {
  const fontRejection =
    input.rejectedFonts.length === 0
      ? undefined
      : `已拒绝非平台内置字体请求：${input.rejectedFonts.join('、')}。`;
  if (!input.changed) {
    if (input.toolErrorCount > 0) {
      return `${fontRejection === undefined ? '' : `${fontRejection} `}Decksmith 未修改课件：有 ${input.toolErrorCount} 个工具操作失败。`;
    }
    return `${fontRejection === undefined ? '' : `${fontRejection} `}Decksmith 未修改课件。`;
  }
  if (input.toolErrorCount > 0) {
    return `${fontRejection === undefined ? '' : `${fontRejection} `}Decksmith 已生成部分修改建议，但有 ${input.toolErrorCount} 个工具操作失败。请检查实际变更后再决定是否采用。`;
  }
  return `${fontRejection === undefined ? '' : `${fontRejection} `}Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。`;
}

/** 构造指向 model-service 网关的 OpenAI 兼容模型描述；具体模型由网关按 capability 策略路由。 */
/**
 * 只有本轮首条用户消息真的附带了图片时才声明 image 输入：纯文本轮次的请求与改动前逐字节一致，
 * 也不会让 pi 把未来某个工具结果里的图片绕过附图容量合同转发给模型。
 */
function buildDecksmithModel(
  env: ReachDeckModelEnv,
  capacity?: DecksmithRunInput['capacity'],
  vision = false,
): Model<'openai-completions'> {
  return {
    id: 'reachany-model-service',
    name: 'ReachAny Decksmith Gateway',
    api: 'openai-completions',
    provider: 'reachany-model-service',
    baseUrl: resolveModelServiceOpenAiBaseUrl(env),
    reasoning: false,
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // The legacy full-payload recovery path keeps its historical declaration for at most 24h.
    // Every new v2 run supplies the frozen Task 4A guarantee and never uses this placeholder.
    contextWindow: capacity?.guaranteedInputCapacity ?? 200_000,
    maxTokens: capacity?.reservedOutputCapacity ?? 16_384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    },
  };
}

type DecksmithUserContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly base64: string; readonly mimeType: 'image/jpeg' };

/**
 * 组装首条用户消息。没有附图时是纯文本（与改动前一致）；有附图时为
 * `[文本, 图片1, 图片2, …]`，文本里的选中图片说明与图片块顺序一致。
 * entries 为空时（测算路径）按计划状态以占位图片计入容量。
 */
function buildDecksmithUserContent(
  input: DecksmithRunInput,
  session: DecksmithDocumentSession,
  entries?: readonly DecksmithVisualEntryState[],
): string | DecksmithUserContentPart[] {
  const resolved =
    input.visualInputs === undefined
      ? undefined
      : (entries ?? planDecksmithVisualEntries(input.visualInputs, session.document));
  const text = buildUserPrompt(input, session, resolved);
  const attached = (resolved ?? []).flatMap((entry) => (entry.state === 'attached' ? [entry] : []));
  if (attached.length === 0) return text;
  return [
    { type: 'text', text },
    ...attached.map((entry) => ({
      type: 'image' as const,
      base64: entry.image?.base64 ?? '',
      mimeType: 'image/jpeg' as const,
    })),
  ];
}

function buildUserPrompt(
  input: DecksmithRunInput,
  session: DecksmithDocumentSession,
  visualEntries?: readonly DecksmithVisualEntryState[],
): string {
  const lines: string[] = [];
  const origin = input.pageId === undefined ? undefined : session.readPageView(input.pageId);
  const activeCapabilities = decksmithActiveScientificCapabilities(
    input.scientificContextSnapshot,
    origin?.sceneType === 'interactive' && origin.scene?.sceneType === 'interactive'
      ? origin.scene.documentHtml
      : undefined,
  );
  if (input.contextSummary !== undefined) {
    lines.push('Validated summary of earlier conversation on this page and topic:');
    lines.push(input.contextSummary);
    lines.push('');
  }
  const history = input.history ?? [];
  if (history.length > 0) {
    lines.push('Previous panel conversation (oldest first):');
    for (const entry of history) {
      lines.push((entry.role === 'user' ? 'Teacher: ' : 'Decksmith: ') + entry.text);
    }
    lines.push('');
  }
  lines.push('Document overview: ' + JSON.stringify(session.listPages()));
  lines.push('Document stage: ' + JSON.stringify(session.document.stage));
  lines.push('Document language: ' + session.document.metadata.language);
  lines.push(
    'Deck design in use (most frequent first; reuse these for new or edited content): ' +
      JSON.stringify(summarizeDecksmithDeckDesign(session.document)),
  );
  if (input.pageId !== undefined) {
    lines.push('The teacher is currently editing page: ' + input.pageId);
  }
  if (decksmithUsesOnDemandInteractiveContract(input.promptContractVersion)) {
    // v2：不再按原话或来源页类型预加载整份互动合同，只提示来源页是互动页。
    if (origin?.sceneType === 'interactive') {
      lines.push(
        'The current page is an Interactive (GenUI) page. Before inserting, editing, rewriting, or committing Interactive HTML, call read_interactive_authoring_contract once and read the complete HTML with read_interactive_html; neither is needed to answer questions about the page or to turn it into quiz pages.',
      );
    }
  } else if (
    shouldEnableDecksmithInteractiveHarness(input.prompt, originSceneType(input, session))
  ) {
    lines.push(
      'Interactive coding context is enabled. Choose insert, patch, rewrite, or convert without a preclassified operation. Use server-held working-file tools and finish with check_and_commit_interactive_page. If the teacher actually asks for quiz questions (测验, 互动题, 题目), use the quiz tools instead.',
    );
    lines.push(
      'Apply the following content/safety/layout/runtime/validation contracts to tool edits; do not answer with raw scene JSON. Follow diagnostics until validation and commit succeed.',
    );
    lines.push('Interactive authoring and validation contract:');
    lines.push(
      decksmithInteractiveContractText(input.scientificContextSnapshot, activeCapabilities),
    );
    if (input.pageId !== undefined) {
      const current = session.readPageView(input.pageId);
      if (current.sceneType === 'interactive' && current.scene?.sceneType === 'interactive') {
        lines.push(
          'Read the current complete Interactive HTML working file with read_page or read_interactive_html before editing. The server holds the authoritative baseline.',
        );
      }
    }
    lines.push('End Interactive coding context.');
  }
  if (input.scientificContextSnapshot !== undefined) {
    lines.push(
      JSON.stringify(
        projectDecksmithScientificContext(input.scientificContextSnapshot, activeCapabilities),
      ),
    );
  }
  if (input.mediaStatus !== undefined) {
    lines.push(
      'Authoritative media-generation status for this page (do not override or infer): ' +
        JSON.stringify(input.mediaStatus),
    );
    lines.push(
      'If narration, audio, or animation is generating, explain that the media cannot be modified yet; layout edits remain allowed.',
    );
  }
  if (input.selectedElementIds !== undefined && input.selectedElementIds.length > 0) {
    lines.push(
      'The teacher selected these element ids on the current page: ' +
        input.selectedElementIds.join(', ') +
        '. Treat them as the focus of the request when relevant.',
    );
  }
  if (input.visualInputs !== undefined && visualEntries !== undefined) {
    lines.push(...decksmithVisualInputLines(input.visualInputs, visualEntries, session.document));
  }
  if (input.clarificationAnswer !== undefined) {
    lines.push(decksmithClarificationAnswerNote(input.clarificationAnswer));
  }
  lines.push('');
  lines.push('Teacher request: ' + input.prompt);
  return lines.join('\n');
}

export function measureDecksmithModelInput(input: DecksmithRunInput) {
  return measureDecksmithProviderPayload(buildDecksmithInitialProviderInput(input));
}

/** Initial OpenAI chat input, matching the gateway's system-role and non-strict tool settings. */
export function buildDecksmithInitialProviderInput(input: DecksmithRunInput) {
  const session = new DecksmithDocumentSession(input.document, input.capability, {
    ...(input.mediaStatus === undefined ? {} : { mediaStatus: input.mediaStatus }),
    interactiveValidationOptions: decksmithScientificValidationOptions(
      input.scientificContextSnapshot,
    ),
  });
  const tools = decksmithTools(
    session,
    {
      generateImage: async () => {
        throw new Error('Decksmith capacity measurement cannot execute media tools');
      },
      editImage: async () => {
        throw new Error('Decksmith capacity measurement cannot execute media tools');
      },
      draft: async () => {
        throw new Error('Decksmith capacity measurement cannot execute draft tools');
      },
      storeDraftMedia: async () => {
        throw new Error('Decksmith capacity measurement cannot execute draft tools');
      },
    },
    input,
  );
  const userContent = buildDecksmithUserContent(input, session);
  const messages: [
    { readonly role: 'system'; readonly content: string },
    {
      readonly role: 'user';
      readonly content:
        | string
        | (
            | { readonly type: 'text'; readonly text: string }
            | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }
          )[];
    },
  ] = [
    { role: 'system' as const, content: decksmithSystemPrompt(input.promptContractVersion) },
    {
      role: 'user' as const,
      // 附图在测算路径以固定长度占位 url 计入，与派发前对真实 data URL 的投影完全一致。
      content:
        typeof userContent === 'string'
          ? userContent
          : userContent.map((part) =>
              part.type === 'text'
                ? { type: 'text' as const, text: part.text }
                : {
                    type: 'image_url' as const,
                    image_url: { url: DECKSMITH_VISION_IMAGE_CAPACITY_PLACEHOLDER },
                  },
            ),
    },
  ];
  return {
    messages,
    tools: tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
  };
}

function decksmithScientificValidationOptions(
  snapshot?: ScientificContextSnapshot,
): DecksmithInteractiveValidationOptions {
  if (snapshot === undefined) return { scientificCapabilityPolicy: 'normal' };
  const parsed = parseScientificContextSnapshot(snapshot);
  if (parsed.stage !== 'decksmith')
    throw new Error('Decksmith scientific context stage is invalid');
  return {
    scientificCapabilityPolicy: scientificContextPolicy(parsed),
    allowedRuntimeDependencies: scientificContextOutputRuntimeDependencies(parsed),
  };
}

/** Measure only the exact model-visible portion of the final provider payload. */
export function measureDecksmithProviderPayload(payload: unknown) {
  if (typeof payload !== 'object' || payload === null) {
    throw new DecksmithCapacityBlockedError();
  }
  const candidate = payload as Record<string, unknown>;
  if (!Array.isArray(candidate.messages) || !Array.isArray(candidate.tools)) {
    throw new DecksmithCapacityBlockedError();
  }
  const messages = projectDecksmithVisionContentForCapacity(candidate.messages);
  if (messages === null) throw new DecksmithCapacityBlockedError();
  const modelInput = { messages, tools: candidate.tools };
  try {
    return deterministicCapacityMeasure(
      modelInput,
      countDeterministicCapacityStructure(modelInput),
    );
  } catch {
    throw new DecksmithCapacityBlockedError();
  }
}

/**
 * Enforce the frozen model profile immediately before each network dispatch. Legacy request-bound
 * callers either omit capacity or carry the historical two-number shape and retain their 24-hour
 * compatibility behavior; every v2 durable run carries all three version/unit fields.
 */
export function assertDecksmithProviderDispatchCapacity(
  payload: unknown,
  capacity: DecksmithRunInput['capacity'],
): void {
  if (capacity === undefined) return;
  const frozenFields = [
    capacity.capacityProfileVersion,
    capacity.estimatorVersion,
    capacity.capacityUnit,
  ];
  if (frozenFields.every((value) => value === undefined)) return;
  if (
    typeof capacity.capacityProfileVersion !== 'string' ||
    capacity.capacityProfileVersion.trim().length === 0 ||
    capacity.estimatorVersion !== DECKSMITH_CAPACITY_ESTIMATOR_VERSION ||
    capacity.capacityUnit !== DECKSMITH_CAPACITY_UNIT ||
    !Number.isSafeInteger(capacity.guaranteedInputCapacity) ||
    capacity.guaranteedInputCapacity < 1 ||
    !Number.isSafeInteger(capacity.reservedOutputCapacity) ||
    capacity.reservedOutputCapacity < 1
  ) {
    throw new DecksmithCapacityBlockedError();
  }
  const measure = measureDecksmithProviderPayload(payload);
  const estimatedInput = estimateDeterministicCapacity(measure);
  if (!Number.isSafeInteger(estimatedInput) || estimatedInput > capacity.guaranteedInputCapacity) {
    throw new DecksmithCapacityBlockedError();
  }
}

function decksmithTools(
  session: DecksmithDocumentSession,
  media: Parameters<typeof createDecksmithMediaTools>[1] & DecksmithDraftToolDependencies,
  input: Pick<
    DecksmithRunInput,
    'scientificContextSnapshot' | 'pageId' | 'prompt' | 'promptContractVersion'
  >,
  askTeacher?: DecksmithAskTeacherDependencies,
) {
  const scientificContextSnapshot = input.scientificContextSnapshot;
  const origin = input.pageId === undefined ? undefined : session.readPageView(input.pageId);
  const active = decksmithActiveScientificCapabilities(
    scientificContextSnapshot,
    origin?.sceneType === 'interactive' && origin.scene?.sceneType === 'interactive'
      ? origin.scene.documentHtml
      : undefined,
  );
  // 合同正文里已含细节的激活能力（几何能力仅在冻结上下文开启几何时计入）。
  const contractCapabilities = active.filter(
    (id) =>
      !id.startsWith('euclidean-geometry-') ||
      (scientificContextSnapshot !== undefined &&
        scientificContextGeometryEnabled(scientificContextSnapshot)),
  );
  if (decksmithUsesOnDemandInteractiveContract(input.promptContractVersion)) {
    // v2：合同只在模型调用 read_interactive_authoring_contract 时返回，读取后这些能力才视为已加载。
    // v3（WP7）：在 v2 工具面末尾追加 ask_teacher；测算路径没有运行依赖，工具只用于计入工具面。
    return [
      ...createDecksmithTools(
        session,
        scientificContextSnapshot,
        [],
        {
          text: () =>
            decksmithInteractiveContractText(
              scientificContextSnapshot,
              active,
              input.promptContractVersion,
            ),
          capabilities: contractCapabilities,
        },
        // v4：Decksmith 专属测验合同（只返回一次）与重复题干拒绝。
        {
          strictContract: decksmithUsesQuizHistoryReceipts(input.promptContractVersion),
          sceneShapeContract: decksmithQuizContractStatesSceneShape(input.promptContractVersion),
          editingContract: input.promptContractVersion === DECKSMITH_PROMPT_CONTRACT_V8,
        },
      ),
      ...createDecksmithMediaTools(session, media),
      ...createDecksmithDraftTools(session, media),
      ...(decksmithOffersAskTeacher(input.promptContractVersion)
        ? [createDecksmithAskTeacherTool(session, askTeacher)]
        : []),
      // v5（WP8）：采用后自动生成页面媒体的意图声明工具，追加在 v4 工具面末尾。
      ...(decksmithSchedulesMediaAfterApply(input.promptContractVersion)
        ? [createDecksmithAfterApplyMediaTool(session)]
        : []),
    ];
  }
  // v1（旧 Run）：命中旧规则时合同已预加载在用户消息里，对应能力从一开始就算已加载。
  const initiallyLoaded = shouldEnableDecksmithInteractiveHarness(input.prompt, origin?.sceneType)
    ? contractCapabilities
    : [];
  return [
    ...createDecksmithTools(session, scientificContextSnapshot, initiallyLoaded),
    // Narration audio and animations come from the editor's existing regenerate operations,
    // offered through suggest_page_action; Decksmith never synthesizes speech itself.
    ...createDecksmithMediaTools(session, media),
    ...createDecksmithDraftTools(session, media),
  ];
}

/** v8 使用独立编辑合同；已冻结 v1–v7 的运行保留历史合同正文。 */
function decksmithInteractiveContractText(
  snapshot: ScientificContextSnapshot | undefined,
  activeCapabilities: readonly string[],
  version?: DecksmithPromptContractVersion,
): string {
  const compose =
    version === DECKSMITH_PROMPT_CONTRACT_V8
      ? decksmithInteractivePrompt
      : decksmithInteractivePromptLegacy;
  return compose({
    scientificContext: snapshot !== undefined,
    geometryEnabled: snapshot !== undefined && scientificContextGeometryEnabled(snapshot),
    activeCapabilities,
  }).text;
}

function originSceneType(input: DecksmithRunInput, session: DecksmithDocumentSession) {
  return input.pageId === undefined
    ? undefined
    : session.listPages().find((page) => page.pageId === input.pageId)?.sceneType;
}

const DECKSMITH_PROVIDER_INLINE_PAYLOAD_BYTES = 2_048;
const INTERACTIVE_READ_TOOLS = new Set(['read_page', 'read_interactive_html']);
const INTERACTIVE_MUTATION_TOOLS = new Set([
  'edit_interactive_html',
  'write_interactive_html',
  'propose_interactive_geometry_edit',
  'check_and_commit_interactive_page',
]);

const QUIZ_WRITE_TOOLS = new Set(['insert_quiz_page', 'replace_quiz_scene']);
/** 测验回执里保留的题干前缀长度（Unicode 码点）。 */
const QUIZ_RECEIPT_QUESTION_PREFIX = 40;

export interface DecksmithProviderConversionOptions {
  /**
   * v4（WP3 方案 A）起：
   * 1. 较早成功的测验写调用的 sceneJson 换成测验回执；所有失败调用、以及仍在最新一条助手消息里的最近一次
   *    成功写调用原样保留；DECKSMITH_QUIZ_DUPLICATE 等拒绝不算成功；
   * 2. 页面读取被后续 replace_quiz_scene / delete_page 取代，或测验 / 互动页的 read_page 之后已有成功的 insert_quiz_page
   *    （来源内容已用过）时，换成"过期 / 按需重读"回执；
   * 3. 测验合同全文在之后已有成功写调用、且最新一轮没有失败的测验写调用时换成回执（重读工具会再给全文）。
   * 只替换参数与结果正文，call/result 成对与消息顺序不变。
   * 缺省（v1–v3）保持原历史形状：insert_quiz_page 超过 2 KB 的 sceneJson 一律换成 server-held 回执。
   */
  readonly quizHistoryReceipts?: boolean;
}

/** Keep completed working-file payloads server-side while preserving the latest readable baseline. */
export function convertDecksmithMessagesForProvider(
  messages: AgentMessage[],
  options: DecksmithProviderConversionOptions = {},
): Message[] {
  const providerMessages = messages.filter((message): message is Message =>
    ['user', 'assistant', 'toolResult'].includes((message as { role: string }).role),
  );
  const toolCalls = new Map<
    string,
    {
      readonly name: string;
      readonly pageId?: string;
      readonly arguments: Record<string, unknown>;
    }
  >();
  providerMessages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      const pageId = content.arguments.pageId;
      toolCalls.set(content.id, {
        name: content.name,
        arguments: content.arguments,
        ...(typeof pageId === 'string' ? { pageId } : {}),
      });
    }
  });
  const successfulInteractiveReads = providerMessages.flatMap((message, index) => {
    if (message.role !== 'toolResult' || message.isError) return [];
    const call = toolCalls.get(message.toolCallId);
    if (
      call?.pageId === undefined ||
      call.name !== message.toolName ||
      !INTERACTIVE_READ_TOOLS.has(call.name) ||
      !toolResultProvidesCompleteInteractiveBaseline(call, message.content, message.details)
    ) {
      return [];
    }
    return [{ index, pageId: call.pageId }];
  });
  const successfulInteractiveMutations = providerMessages.flatMap((message, index) => {
    if (message.role !== 'toolResult' || message.isError) return [];
    const call = toolCalls.get(message.toolCallId);
    if (
      call?.pageId === undefined ||
      call.name !== message.toolName ||
      !INTERACTIVE_MUTATION_TOOLS.has(call.name) ||
      !toolResultChangesInteractiveBaseline(call.name, message.content)
    ) {
      return [];
    }
    return [{ index, pageId: call.pageId, toolCallId: message.toolCallId, toolName: call.name }];
  });
  const successfulGeometryInspections = providerMessages.flatMap((message, index) => {
    if (message.role !== 'toolResult' || message.isError) return [];
    const call = toolCalls.get(message.toolCallId);
    if (
      call?.pageId === undefined ||
      call.name !== 'inspect_interactive_geometry' ||
      call.name !== message.toolName
    ) {
      return [];
    }
    return [{ index, pageId: call.pageId }];
  });
  const hasLaterInteractiveBaselineChange = (pageId: string, afterIndex: number) =>
    successfulInteractiveReads.some((read) => read.index > afterIndex && read.pageId === pageId) ||
    successfulGeometryInspections.some(
      (inspection) => inspection.index > afterIndex && inspection.pageId === pageId,
    ) ||
    successfulInteractiveMutations.some(
      (mutation) => mutation.index > afterIndex && mutation.pageId === pageId,
    );
  const readPageIds = new Set([
    ...successfulInteractiveReads.map((read) => read.pageId),
    ...successfulGeometryInspections.map((inspection) => inspection.pageId),
  ]);
  const hasLaterGeometryProposal = (pageId: string, afterIndex: number) =>
    successfulInteractiveMutations.some(
      (mutation) =>
        mutation.index > afterIndex &&
        mutation.pageId === pageId &&
        mutation.toolName === 'propose_interactive_geometry_edit',
    );
  const successfulGeometryProposalCallIds = new Set(
    successfulInteractiveMutations
      .filter((mutation) => mutation.toolName === 'propose_interactive_geometry_edit')
      .map((mutation) => mutation.toolCallId),
  );
  // 被合同门槛拒绝（v2）的写调用没有任何内容落到服务端工作副本：它的大参数不能换成"server-held"回执，
  // 否则模型会以为内容已在服务端，补读合同后既无法原样重发，也可能直接提交旧内容。
  const contractRefusedCallIds = new Set(
    providerMessages.flatMap((message) =>
      message.role === 'toolResult' &&
      !message.isError &&
      isInteractiveContractRefusal(message.content)
        ? [message.toolCallId]
        : [],
    ),
  );
  const quizReceipts = options.quizHistoryReceipts === true;
  const successfulQuizWrites = quizReceipts
    ? collectSuccessfulQuizWrites(providerMessages, toolCalls)
    : [];
  const quizWriteByCallId = new Map(successfulQuizWrites.map((write) => [write.toolCallId, write]));
  // 最近一次成功的测验写调用原样保留，供模型对照下一题的格式；更早的换成回执。
  const latestQuizWriteCallId = successfulQuizWrites.at(-1)?.toolCallId;
  const pageSupersessions = quizReceipts
    ? collectQuizPageSupersessions(providerMessages, toolCalls)
    : [];
  const laterPageSupersession = (pageId: string, afterIndex: number) =>
    pageSupersessions.find((change) => change.index > afterIndex && change.pageId === pageId);
  // 测验或互动页的 read_page 结果在之后有成功的 insert_quiz_page 时视为"已用过"（如 GenUI 转题的来源页）：
  // 换成按需重读的回执。只看插入：改写某页已由同页 replace_quiz_scene 的取代规则覆盖，另一页的改写不代表
  // 这一页的读取已用完（"先读 3、5 两页再逐页改写"时不该逼模型重读第 5 页）。
  // 原生幻灯片的紧凑视图保留，它们的元素 id 常被后续编辑直接引用。
  const consumedByLaterQuizWrite = (
    toolName: string,
    pageId: string,
    content: readonly { readonly type: string; readonly text?: string }[],
    afterIndex: number,
  ): DecksmithPageSupersession | undefined => {
    if (toolName !== 'read_page') return undefined;
    const write = successfulQuizWrites.find(
      (candidate) => candidate.toolName === 'insert_quiz_page' && candidate.index > afterIndex,
    );
    if (write === undefined) return undefined;
    const sceneType = readPageSceneType(toolResultText(content));
    return sceneType === 'quiz' || sceneType === 'interactive'
      ? { index: write.index, pageId, toolName: 'used-by-quiz-write' }
      : undefined;
  };
  // 最近一次成功写调用只在它所在的助手消息仍是最新一条时原样保留（紧接着的那一轮能对照原文）。
  const lastAssistantIndex = providerMessages.findLastIndex(
    (message) => message.role === 'assistant',
  );
  // 测验合同全文：之后已有成功测验写调用、且最新一条助手消息里没有失败的测验写调用（不需要据合同修题）时，
  // 换成"按需重读"回执；出现更晚的全文时较早的一份也换掉。tools.ts 的读取工具在这之后会重新给全文。
  const fullQuizContractIndexes = quizReceipts
    ? providerMessages.flatMap((message, index) =>
        message.role === 'toolResult' &&
        !message.isError &&
        message.toolName === 'read_quiz_authoring_contract' &&
        toolCalls.get(message.toolCallId)?.name === 'read_quiz_authoring_contract' &&
        !toolResultText(message.content).startsWith('{')
          ? [index]
          : [],
      )
    : [];
  const latestTurnHasFailedQuizWrite = providerMessages.some(
    (message, index) =>
      index > lastAssistantIndex &&
      message.role === 'toolResult' &&
      message.isError &&
      QUIZ_WRITE_TOOLS.has(message.toolName),
  );
  // 合同回执声称"最近一次成功写调用就是合格格式"，所以最近一次成功写调用靠字段改正才通过时不压缩合同：
  // 它原样保留的参数里正是错误字段名。改正出现之前这类调用会失败，失败时合同同样不压缩，历史形状不变。
  const latestSuccessfulQuizWrite = successfulQuizWrites.at(-1);
  const quizContractHeld = (index: number) =>
    fullQuizContractIndexes.some((later) => later > index) ||
    (!latestTurnHasFailedQuizWrite &&
      latestSuccessfulQuizWrite !== undefined &&
      latestSuccessfulQuizWrite.index > index &&
      !latestSuccessfulQuizWrite.repaired);
  const isSupersededGeometryProposal = (
    callId: string,
    pageId: string | undefined,
    callIndex: number,
  ) =>
    successfulGeometryProposalCallIds.has(callId) ||
    (pageId !== undefined && hasLaterGeometryProposal(pageId, callIndex));

  return providerMessages.map((message, index) => {
    if (message.role === 'user' && typeof message.content === 'string') {
      return {
        ...message,
        content: compactSupersededInitialInteractiveBaseline(message.content, readPageIds),
      };
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      // 附图的首条用户消息：只压缩文本块，图片块原样保留（不复制、不转存）。
      return {
        ...message,
        content: message.content.map((content) =>
          content.type === 'text'
            ? {
                ...content,
                text: compactSupersededInitialInteractiveBaseline(content.text, readPageIds),
              }
            : content,
        ),
      };
    }
    if (message.role === 'toolResult') {
      const call = toolCalls.get(message.toolCallId);
      const supersession =
        quizReceipts &&
        !message.isError &&
        call?.pageId !== undefined &&
        call.name === message.toolName &&
        INTERACTIVE_READ_TOOLS.has(call.name)
          ? (laterPageSupersession(call.pageId, index) ??
            consumedByLaterQuizWrite(call.name, call.pageId, message.content, index))
          : undefined;
      if (supersession !== undefined) {
        return {
          ...message,
          content: message.content.map((content) =>
            content.type === 'text'
              ? { ...content, text: compactStaleQuizPageRead(supersession, content.text) }
              : content,
          ),
        };
      }
      if (fullQuizContractIndexes.includes(index) && quizContractHeld(index)) {
        return {
          ...message,
          content: message.content.map((content) =>
            content.type === 'text'
              ? { ...content, text: heldQuizContractReceipt(content.text) }
              : content,
          ),
        };
      }
      if (
        call?.pageId !== undefined &&
        message.toolName === 'inspect_interactive_geometry' &&
        hasLaterGeometryProposal(call.pageId, index)
      ) {
        return {
          ...message,
          content: message.content.map((content) =>
            content.type === 'text'
              ? {
                  ...content,
                  text: compactLargeGeometryInspection(content.text),
                }
              : content,
          ),
        };
      }
      if (
        call?.pageId === undefined ||
        !['read_page', 'read_interactive_html'].includes(message.toolName) ||
        !hasLaterInteractiveBaselineChange(call.pageId, index)
      ) {
        return message;
      }
      return {
        ...message,
        content: message.content.map((content) =>
          content.type === 'text'
            ? {
                ...content,
                text: compactCompletedInteractiveRead(message.toolName, content.text),
              }
            : content,
        ),
      };
    }
    if (message.role !== 'assistant') return message;
    return {
      ...message,
      content: message.content.map((content) => {
        if (content.type !== 'toolCall') return content;
        if (quizReceipts && QUIZ_WRITE_TOOLS.has(content.name)) {
          // v4：失败调用（没有成功结果）与最近一次成功写调用原样保留，失败的可据诊断修改重发。
          const write = quizWriteByCallId.get(content.id);
          const sceneJson = content.arguments.sceneJson;
          if (
            write === undefined ||
            (content.id === latestQuizWriteCallId && index === lastAssistantIndex) ||
            typeof sceneJson !== 'string'
          ) {
            return content;
          }
          const receipt = quizWriteReceipt(write, sceneJson);
          return Buffer.byteLength(receipt, 'utf8') < Buffer.byteLength(sceneJson, 'utf8')
            ? { ...content, arguments: { ...content.arguments, sceneJson: receipt } }
            : content;
        }
        if (contractRefusedCallIds.has(content.id)) return content;
        if (
          content.name === 'propose_interactive_geometry_edit' &&
          isSupersededGeometryProposal(
            content.id,
            typeof content.arguments.pageId === 'string' ? content.arguments.pageId : undefined,
            index,
          )
        ) {
          const envelopeJson = content.arguments.envelopeJson;
          if (typeof envelopeJson !== 'string') return content;
          return {
            ...content,
            arguments: {
              ...content.arguments,
              envelopeJson: compactLargeProviderArgument(envelopeJson),
            },
          };
        }
        if (content.name === 'edit_interactive_html' && Array.isArray(content.arguments.edits)) {
          return {
            ...content,
            arguments: {
              ...content.arguments,
              edits: content.arguments.edits.map((edit) => {
                if (typeof edit !== 'object' || edit === null || Array.isArray(edit)) return edit;
                const candidate = edit as Record<string, unknown>;
                return {
                  ...candidate,
                  ...(typeof candidate.oldText === 'string'
                    ? { oldText: compactLargeInteractiveArgument(candidate.oldText) }
                    : {}),
                  ...(typeof candidate.newText === 'string'
                    ? { newText: compactLargeInteractiveArgument(candidate.newText) }
                    : {}),
                };
              }),
            },
          };
        }
        if (!['write_interactive_html', 'insert_quiz_page'].includes(content.name)) {
          return content;
        }
        const field = content.name === 'write_interactive_html' ? 'documentHtml' : 'sceneJson';
        const value = content.arguments[field];
        if (typeof value !== 'string') return content;
        return {
          ...content,
          arguments: {
            ...content.arguments,
            [field]:
              content.name === 'write_interactive_html'
                ? compactLargeInteractiveArgument(value)
                : compactLargeProviderArgument(value),
          },
        };
      }),
    };
  });
}

interface DecksmithQuizWrite {
  readonly index: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly pageId: string;
  /** 服务端改正过字段写法（结果带 fieldRepairs / Field repairs）：原样保留的参数不是合格示例。 */
  readonly repaired: boolean;
}

interface DecksmithPageSupersession {
  readonly index: number;
  readonly pageId: string;
  /** used-by-quiz-write：读取之后已有成功测验写调用（来源内容已用过，按需重读）。 */
  readonly toolName: 'replace_quiz_scene' | 'delete_page' | 'used-by-quiz-write';
}

type DecksmithConversionToolCalls = ReadonlyMap<
  string,
  { readonly name: string; readonly pageId?: string; readonly arguments: Record<string, unknown> }
>;

function toolResultText(content: readonly { readonly type: string; readonly text?: string }[]) {
  return content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
}

/**
 * 成功的测验写调用（按结果出现顺序）：insert_quiz_page 的结果是带 pageId、没有诊断码的回执
 * （DECKSMITH_QUIZ_DUPLICATE 等拒绝不算成功），replace_quiz_scene 的结果是"updated to revision"。
 */
function collectSuccessfulQuizWrites(
  messages: readonly Message[],
  toolCalls: DecksmithConversionToolCalls,
): DecksmithQuizWrite[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'toolResult' || message.isError) return [];
    const call = toolCalls.get(message.toolCallId);
    if (call === undefined || call.name !== message.toolName || !QUIZ_WRITE_TOOLS.has(call.name)) {
      return [];
    }
    const text = toolResultText(message.content);
    if (call.name === 'replace_quiz_scene') {
      return call.pageId !== undefined &&
        text.startsWith(`quiz page ${call.pageId} updated to revision `)
        ? [
            {
              index,
              toolCallId: message.toolCallId,
              toolName: call.name,
              pageId: call.pageId,
              repaired: text.includes('\nField repairs: '),
            },
          ]
        : [];
    }
    try {
      const receipt = JSON.parse(text) as Record<string, unknown>;
      return receipt.operation === 'insert_quiz_page' &&
        typeof receipt.pageId === 'string' &&
        receipt.code === undefined
        ? [
            {
              index,
              toolCallId: message.toolCallId,
              toolName: call.name,
              pageId: receipt.pageId,
              repaired: Array.isArray(receipt.fieldRepairs) && receipt.fieldRepairs.length > 0,
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
}

/** 使较早 read_page 结果过期的成功修改：测验页被 replace_quiz_scene 改写，或任意页被删除。 */
function collectQuizPageSupersessions(
  messages: readonly Message[],
  toolCalls: DecksmithConversionToolCalls,
): DecksmithPageSupersession[] {
  return messages.flatMap((message, index): DecksmithPageSupersession[] => {
    if (message.role !== 'toolResult' || message.isError) return [];
    const call = toolCalls.get(message.toolCallId);
    if (call?.pageId === undefined || call.name !== message.toolName) return [];
    const text = toolResultText(message.content);
    if (
      call.name === 'replace_quiz_scene' &&
      text.startsWith(`quiz page ${call.pageId} updated to revision `)
    ) {
      return [{ index, pageId: call.pageId, toolName: call.name }];
    }
    if (call.name === 'delete_page' && text === `Page ${call.pageId} deleted.`) {
      return [{ index, pageId: call.pageId, toolName: call.name }];
    }
    return [];
  });
}

/** 已用过的测验合同全文回执：说明可重读，最近一次成功写调用即合格示例。 */
function heldQuizContractReceipt(text: string): string {
  return JSON.stringify({
    contractStatus: 'held-server-side',
    heldBytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text).digest('hex'),
    note: 'The quiz authoring contract was read earlier in this run and the quiz writes after it passed validation; your latest successful write shows a valid format. Call read_quiz_authoring_contract again only if you need rules beyond that; it then returns the full contract.',
  });
}

/** read_page 结果的场景类型；不是 JSON 时返回 undefined。 */
function readPageSceneType(text: string): unknown {
  try {
    return (JSON.parse(text) as Record<string, unknown>).sceneType;
  } catch {
    return undefined;
  }
}

/** 较早成功测验写调用的 sceneJson 回执：页 id、题型、题干前缀、has_answer 与原文 SHA-256。 */
function quizWriteReceipt(write: DecksmithQuizWrite, sceneJson: string): string {
  let question: Record<string, unknown> = {};
  try {
    const scene = JSON.parse(sceneJson) as { content?: { questions?: unknown[] } };
    const first = scene?.content?.questions?.[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      question = first as Record<string, unknown>;
    }
  } catch {
    // 原文不是严格 JSON（服务端曾修复后接受）：回执只给摘要与长度。
  }
  // 题干可能仍是别名（服务端改正后才接受），回执按同一规则取题干，避免丢失已出过的题目。
  const text = richTextPlainText(quizQuestionStemValue(question)).replace(/\s+/gu, ' ').trim();
  const codePoints = Array.from(text);
  const prefix =
    codePoints.length > QUIZ_RECEIPT_QUESTION_PREFIX
      ? `${codePoints.slice(0, QUIZ_RECEIPT_QUESTION_PREFIX).join('')}…`
      : text;
  const fields = [
    `${write.toolName} succeeded for page ${write.pageId}`,
    `question_type=${typeof question.question_type === 'string' ? question.question_type : 'unknown'}`,
    `has_answer=${typeof question.has_answer === 'boolean' ? String(question.has_answer) : 'unknown'}`,
    `question=${JSON.stringify(prefix)}`,
    `sceneJson sha256=${createHash('sha256').update(sceneJson).digest('hex')} (${Buffer.byteLength(sceneJson, 'utf8')} UTF-8 bytes, held server-side)`,
  ];
  return `${DECKSMITH_QUIZ_RECEIPT_PREFIX} ${fields.join('; ')}. The page exists in the working copy: do not insert it again; to change it, call read_page and then replace_quiz_scene.]`;
}

/**
 * 被后续修改取代的页面读取结果（read_page，或被删除页的 read_interactive_html）：换成说明过期原因与
 * 原文摘要的回执（回执更长时保留原文）。
 */
function compactStaleQuizPageRead(supersession: DecksmithPageSupersession, text: string): string {
  const receipt = JSON.stringify({
    pageId: supersession.pageId,
    stale: true,
    supersededBy: supersession.toolName,
    note:
      supersession.toolName === 'delete_page'
        ? 'This page was deleted later in this run; its earlier content is no longer in the document.'
        : supersession.toolName === 'replace_quiz_scene'
          ? 'This quiz page was replaced later in this run; call read_page again if you need its current content.'
          : 'This read was already used for the quiz pages written after it and is held server-side; call read_page again if you still need its content.',
    heldBytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  return Buffer.byteLength(receipt, 'utf8') < Buffer.byteLength(text, 'utf8') ? receipt : text;
}

/** 合同门槛（v2）的拒绝结果：DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED 且未应用任何修改。 */
function isInteractiveContractRefusal(
  content: readonly { readonly type: string; readonly text?: string }[],
): boolean {
  const text = content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
  if (!text.includes(DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED)) return false;
  try {
    const receipt: unknown = JSON.parse(text);
    return (
      receipt !== null &&
      typeof receipt === 'object' &&
      !Array.isArray(receipt) &&
      (receipt as Record<string, unknown>).code === DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED &&
      (receipt as Record<string, unknown>).applied === false
    );
  } catch {
    return false;
  }
}

function toolResultChangesInteractiveBaseline(
  toolName: string,
  content: readonly { readonly type: string; readonly text?: string }[],
): boolean {
  const text = content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
  let receipt: unknown;
  try {
    receipt = JSON.parse(text);
  } catch {
    return toolName !== 'check_and_commit_interactive_page';
  }
  const record =
    receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
      ? (receipt as Record<string, unknown>)
      : undefined;
  // 合同门槛拒绝（v2）没有改动工作副本，之前读到的基线仍然有效。
  if (record?.code === DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED) return false;
  if (toolName !== 'check_and_commit_interactive_page') return true;
  return record?.committed === true;
}

function toolResultProvidesCompleteInteractiveBaseline(
  call: {
    readonly name: string;
    readonly pageId?: string;
    readonly arguments: Record<string, unknown>;
  },
  content: readonly { readonly type: string; readonly text?: string }[],
  details?: unknown,
): boolean {
  if (call.pageId === undefined) return false;
  const text = content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
  if (text.length === 0) return false;
  if (call.name === 'read_interactive_html') {
    if (details && typeof details === 'object' && 'interactiveRead' in details) {
      const receipt = details.interactiveRead;
      return (
        receipt !== null &&
        typeof receipt === 'object' &&
        'pageId' in receipt &&
        receipt.pageId === call.pageId &&
        'complete' in receipt &&
        receipt.complete === true
      );
    }
    return call.arguments.offset === undefined && call.arguments.limit === undefined;
  }
  if (call.name !== 'read_page') return false;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const scene = value.scene;
    return (
      value.pageId === call.pageId &&
      value.sceneType === 'interactive' &&
      typeof scene === 'object' &&
      scene !== null &&
      !Array.isArray(scene) &&
      typeof (scene as Record<string, unknown>).documentHtml === 'string'
    );
  } catch {
    return false;
  }
}

function compactCompletedInteractiveRead(toolName: string, text: string): string {
  if (toolName === 'read_page') {
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      const scene = value.scene;
      if (
        typeof scene === 'object' &&
        scene !== null &&
        !Array.isArray(scene) &&
        typeof (scene as Record<string, unknown>).documentHtml === 'string'
      ) {
        return JSON.stringify({
          ...value,
          scene: {
            ...(scene as Record<string, unknown>),
            documentHtml: compactLargeInteractiveArgument(
              (scene as Record<string, unknown>).documentHtml as string,
            ),
          },
        });
      }
    } catch {
      // Fall through to a whole-result receipt for a non-JSON or damaged historical result.
    }
  }
  return compactLargeInteractiveArgument(text);
}

function compactSupersededInitialInteractiveBaseline(
  text: string,
  readPageIds: ReadonlySet<string>,
): string {
  const currentPageId = /^The teacher is currently editing page: (.+)$/mu.exec(text)?.[1]?.trim();
  if (currentPageId === undefined || !readPageIds.has(currentPageId)) return text;
  const startMarker = 'Current complete Interactive HTML working-file baseline:\n';
  const endMarker = '\nEnd Interactive coding context.';
  const start = text.indexOf(startMarker);
  const end = start < 0 ? -1 : text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) return text;
  const htmlStart = start + startMarker.length;
  const documentHtml = text.slice(htmlStart, end);
  return text.slice(0, htmlStart) + compactLargeProviderArgument(documentHtml) + text.slice(end);
}

function compactLargeInteractiveArgument(value: string): string {
  return Buffer.byteLength(value, 'utf8') <= DECKSMITH_PROVIDER_INLINE_PAYLOAD_BYTES
    ? value
    : `${serverHeldReceipt(value)} Call read_interactive_html(pageId) before another patch.`;
}

function compactLargeProviderArgument(value: string): string {
  return Buffer.byteLength(value, 'utf8') <= DECKSMITH_PROVIDER_INLINE_PAYLOAD_BYTES
    ? value
    : serverHeldReceipt(value);
}

function compactLargeGeometryInspection(value: string): string {
  return Buffer.byteLength(value, 'utf8') <= DECKSMITH_PROVIDER_INLINE_PAYLOAD_BYTES
    ? value
    : `${serverHeldReceipt(value)} Call inspect_interactive_geometry(pageId) before another geometry proposal.`;
}

function serverHeldReceipt(value: string): string {
  return `[server-held ${Buffer.byteLength(value, 'utf8')} UTF-8 bytes; sha256=${createHash('sha256').update(value).digest('hex')}]`;
}

function normalizeDecksmithProviderError(error: unknown, signal?: AbortSignal): unknown {
  const guardrail = guardrailCode(error);
  if (guardrail) return new DecksmithProviderError(guardrail, false);
  if (signal?.aborted) return signal.reason ?? error;
  if (
    error instanceof DecksmithProviderError ||
    error instanceof DecksmithCapacityBlockedError ||
    error instanceof DecksmithSessionError ||
    isAbortOrCancellationError(error)
  ) {
    return error;
  }
  const message = providerErrorMessage(error);
  return new DecksmithProviderError(message, isRetryableStructuredProviderError(error, message));
}

function isRetryableStructuredProviderError(error: unknown, message: string): boolean {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const status = readProviderStatus(record);
  if (status !== undefined) {
    if ([400, 401, 403, 404, 409, 413, 422].includes(status)) return false;
    if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  }
  const code = typeof record?.code === 'string' ? record.code : undefined;
  if (code !== undefined) {
    if (
      /^(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|ENETDOWN|ENETUNREACH|ETIMEDOUT)$/i.test(
        code,
      ) ||
      /(?:rate[_-]?limit|timeout|connection|transport|temporar)/i.test(code)
    ) {
      return true;
    }
    if (/(?:auth|unauthor|forbidden|invalid|content[_-]?filter|safety|moderation)/i.test(code)) {
      return false;
    }
  }
  return isRetryableProviderMessage(message);
}

function readProviderStatus(record: Record<string, unknown> | undefined): number | undefined {
  for (const value of [record?.status, record?.statusCode, record?.code]) {
    const status =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d{3}$/.test(value)
          ? Number.parseInt(value, 10)
          : undefined;
    if (status !== undefined && Number.isSafeInteger(status)) return status;
  }
  return undefined;
}

function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return 'Decksmith provider request failed';
}

function isAbortOrCancellationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = 'name' in error ? String(error.name) : '';
  const message = 'message' in error ? String(error.message) : '';
  return (
    name === 'AbortError' || (name === 'UnrecoverableError' && message === 'Generation cancelled')
  );
}

function isRetryableProviderMessage(message: string): boolean {
  if (/\b(?:400|401|403|404|409|413|422)\b/.test(message)) return false;
  if (
    /(unauthorized|forbidden|authentication|invalid api[-_ ]?key|content[-_ ]?filter|safety policy|moderation)/i.test(
      message,
    )
  ) {
    return false;
  }
  return true;
}

function readToolSummary(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const firstText = content.find(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  );
  if (firstText === undefined) return undefined;
  return firstText.text.length > 200 ? firstText.text.slice(0, 200) + '…' : firstText.text;
}

export function buildDecksmithMediaIdempotencyKey(
  context: DecksmithRunContext,
  kind: 'image',
  input: Record<string, unknown>,
): string {
  // Field order is part of the key: stored images are looked up by it.
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        jobId: context.jobId ?? context.sessionId,
        kind,
        pageId: input.pageId,
        targetId: input.targetId,
        prompt: input.prompt,
        size: input.size,
      }),
    )
    .digest('hex');
  return `decksmith-${kind}-${digest}`;
}

/**
 * 参考图编辑的幂等键：同一 job 对同一元素、同一源图、同一指令只编辑一次（持久化重放直接复用）。
 * 源图以 objectKey 标识——生成/上传对象的 key 内含内容哈希或资产 id，不会被原地覆盖。
 */
export function buildDecksmithImageEditIdempotencyKey(
  context: DecksmithRunContext,
  input: { pageId: string; targetId: string; instruction: string; sourceObjectKey: string },
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        jobId: context.jobId ?? context.sessionId,
        kind: 'image-edit',
        pageId: input.pageId,
        targetId: input.targetId,
        instruction: input.instruction,
        sourceObjectKey: input.sourceObjectKey,
      }),
    )
    .digest('hex');
  return `decksmith-image-edit-${digest}`;
}

function stableMediaAsset(asset: ReachDeckGeneratedMediaResource) {
  return {
    objectKey: asset.objectKey,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    checksumSha256: asset.checksumSha256,
  };
}

function sha256Json(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = '[unserializable]';
  }
  return createHash('sha256')
    .update(serialized ?? 'undefined')
    .digest('hex');
}
