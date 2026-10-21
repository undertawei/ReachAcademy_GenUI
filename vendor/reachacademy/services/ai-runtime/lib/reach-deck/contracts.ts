import {
  parseReachDeckDocument,
  type ReachDeckDocument,
  GeneratedSceneArtifact,
  LessonPlan,
  PageGenerationRequest,
  PagedDeckOutline,
} from '@reachany/reach-deck-dsl';

import type {
  GenerateLessonPlanRequest,
  GenerateInteractiveNarrationRequest,
  GenerateMaterializedInteractiveNarrationRequest,
  GenerateNarrationRequest,
  GenerateNativeNarrationRequest,
  GeneratePagedOutlineRequest,
  ReachDeckNativeNarrationProduct,
} from './generation-pipeline.js';
import type { ReachDeckPromptSnippetOverrides } from './prompts/index.js';
import type { ReachDeckResourceScope } from './resource-scope.js';
import { parseReachDeckResourceScope } from './resource-scope.js';
import type { ReachDeckVoiceSelection } from './voice-selection.js';
import type { ScientificContextSnapshot } from './scientific-generation-context.js';
import type { DecksmithFrozenVisualInputs } from './decksmith/visual-input-contract.js';
import { DECKSMITH_ASSISTANT_TEXT_BYTES } from './decksmith/turn-memory.js';
import {
  isDecksmithClarificationQuestionId,
  parseReachDeckDecksmithClarification,
  type DecksmithClarificationAnswer,
  type ReachDeckDecksmithClarification,
} from './decksmith/clarification-contract.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithJobId,
  buildDecksmithRequestHash,
  buildDecksmithResultHash,
} from './job-identity.js';
import {
  DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
  DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_LIMITS,
  parseDecksmithContextRef,
  parseDecksmithFrozenRunInput,
  parseDecksmithPageMediaStatus,
  type DecksmithContextRef,
  type DecksmithFrozenRunInput,
  type DecksmithPageMediaStatus,
} from './decksmith/page-stream-contracts.js';

export * from './decksmith/page-stream-contracts.js';
export * from './decksmith/clarification-contract.js';

export const REACH_DECK_DECKSMITH_CAPABILITY = 'reach-deck-decksmith/v2' as const;
export const REACH_DECK_DECKSMITH_LEGACY_COMPATIBILITY_MS = 24 * 60 * 60 * 1_000;
export const REACH_DECK_DECKSMITH_LEGACY_JOB_SCHEMA_VERSION =
  'reach-deck-decksmith-job/v1' as const;
export const REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION = 'reach-deck-decksmith-job/v2' as const;
export const REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION = 'reach-deck-decksmith-result/v2' as const;
export const REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION =
  'reach-deck-decksmith-outcome/v1' as const;

export const REACH_DECK_DECKSMITH_LIMITS = Object.freeze({
  promptCharacters: 20_000,
  historyEntries: 12,
  historyEntryCharacters: 20_000,
  historyCharacters: 60_000,
  selectedElementIds: 100,
  identifierCharacters: 256,
  documentBytes: 2 * 1024 * 1024,
  inputBytes: 3 * 1024 * 1024,
  assistantMessageCharacters: 100_000,
  resultBytes: 3 * 1024 * 1024,
});

export interface ReachDeckDecksmithHistoryEntry {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ReachDeckDecksmithJobInput {
  readonly capability: typeof REACH_DECK_DECKSMITH_CAPABILITY;
  readonly prompt: string;
  readonly document: ReachDeckDocument;
  readonly pageId?: string;
  readonly selectedElementIds?: readonly string[];
  readonly history?: readonly ReachDeckDecksmithHistoryEntry[];
  readonly contextSummary?: string;
  readonly capacity?: {
    readonly capacityProfileVersion?: string;
    readonly estimatorVersion?: string;
    readonly capacityUnit?: string;
    readonly guaranteedInputCapacity: number;
    readonly reservedOutputCapacity: number;
  };
  readonly contextRefs?: readonly DecksmithContextRef[];
  readonly mediaStatus?: DecksmithPageMediaStatus;
  /** Server-resolved execution input; browser request parsing never accepts this field. */
  readonly voiceSelection?: ReachDeckVoiceSelection;
  /** Server-owned frozen input; browser request parsing never accepts this field. */
  readonly scientificContextSnapshot?: ScientificContextSnapshot;
  /** 服务端冻结的选中图片视觉输入（稳定标识）；浏览器请求解析从不接受此字段。 */
  readonly visualInputs?: DecksmithFrozenVisualInputs;
  /**
   * 浏览器请求字段（WP7）：本条消息回答的 Decksmith 问题 id。服务端入队时校验它是否为本页本话题
   * 最近一个未回答的问题，结论冻结为 clarificationAnswer。
   */
  readonly answersQuestionId?: string;
  /** 服务端冻结的回答关联结论；浏览器请求解析从不接受此字段。 */
  readonly clarificationAnswer?: DecksmithClarificationAnswer;
}

export interface ReachDeckDecksmithLegacyJobPayload {
  readonly schemaVersion:
    | typeof REACH_DECK_DECKSMITH_LEGACY_JOB_SCHEMA_VERSION
    | typeof REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION;
  readonly kind: 'decksmith';
  readonly capability: typeof REACH_DECK_DECKSMITH_CAPABILITY;
  readonly jobId: string;
  readonly runId: string;
  readonly requestHash: string;
  readonly baseDocumentHash: string;
  readonly actorId: string;
  /** Actor/session organization. Legacy persisted jobs may omit it. */
  readonly actorOrganizationId?: string;
  readonly billingGroupId: string | null;
  readonly roleGrantId: string;
  readonly resourceScope: ReachDeckResourceScope;
  readonly input: ReachDeckDecksmithJobInput;
}

export interface ReachDeckDecksmithV2JobPayload {
  readonly schemaVersion: typeof REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION;
  readonly kind: 'decksmith';
  readonly capability: typeof REACH_DECK_DECKSMITH_CAPABILITY;
  readonly jobId: string;
  readonly runId: string;
  readonly runtimeRunId: string;
  readonly threadId: string;
  /** Page targeted by the turn; legacy persisted payloads may omit this field. */
  readonly pageId?: string;
  readonly requestHash: string;
  readonly baseDocumentHash: string;
  readonly contextDigest: string;
  readonly actorId: string;
  /** Actor/session organization. Legacy persisted jobs may omit it. */
  readonly actorOrganizationId?: string;
  readonly billingGroupId: string | null;
  readonly roleGrantId: string;
  readonly resourceScope: ReachDeckResourceScope;
}

export type ReachDeckDecksmithJobPayload =
  | ReachDeckDecksmithLegacyJobPayload
  | ReachDeckDecksmithV2JobPayload;

export const REACH_DECK_DECKSMITH_SUGGESTED_ACTION_KINDS = [
  'regenerate-page',
  'regenerate-page-narration',
  'regenerate-page-narration-text',
  'generate-page-audio',
  'regenerate-page-animations',
  'regenerate-page-media',
] as const;

export type ReachDeckDecksmithSuggestedActionKind =
  (typeof REACH_DECK_DECKSMITH_SUGGESTED_ACTION_KINDS)[number];

/** 仅适用于幻灯片页面的建议动作：Interactive 页不提供仅重写讲稿文字，也没有讲稿驱动动画。 */
export const REACH_DECK_DECKSMITH_SLIDE_ONLY_SUGGESTED_ACTION_KINDS: ReadonlySet<ReachDeckDecksmithSuggestedActionKind> =
  new Set(['regenerate-page-narration-text', 'regenerate-page-animations']);

/**
 * An operation Decksmith offers because the teacher explicitly asked for it. Decksmith never runs
 * these itself; the editor renders a button that calls the same endpoint as the existing UI action.
 */
export interface ReachDeckDecksmithSuggestedAction {
  readonly kind: ReachDeckDecksmithSuggestedActionKind;
  readonly pageId: string;
}

export function isReachDeckDecksmithSuggestedActionKind(
  value: unknown,
): value is ReachDeckDecksmithSuggestedActionKind {
  return (REACH_DECK_DECKSMITH_SUGGESTED_ACTION_KINDS as readonly unknown[]).includes(value);
}

export const REACH_DECK_DECKSMITH_SUGGESTED_ACTION_LIMIT = 8;

/**
 * 采用后由服务端自动执行的页面媒体生成（WP8，提示词合同 v5 起）。
 * generate-page-audio：按已保存讲稿合成音频与时间戳（清除讲稿驱动动画，同编辑器"生成音频"）；
 * regenerate-page-media：合成音频并重新生成讲稿驱动动画（同编辑器"重新生成音频和动画"）。
 * 只允许出现在本次运行用 set_native_narration 写过讲稿、且讲稿确有变化的幻灯片页上。
 */
export const REACH_DECK_DECKSMITH_AFTER_APPLY_KINDS = [
  'generate-page-audio',
  'regenerate-page-media',
] as const;
export type ReachDeckDecksmithAfterApplyKind =
  (typeof REACH_DECK_DECKSMITH_AFTER_APPLY_KINDS)[number];
export interface ReachDeckDecksmithAfterApplyAction {
  readonly kind: ReachDeckDecksmithAfterApplyKind;
  readonly pageId: string;
}
export const REACH_DECK_DECKSMITH_AFTER_APPLY_LIMIT = 8;

export function isReachDeckDecksmithAfterApplyKind(
  value: unknown,
): value is ReachDeckDecksmithAfterApplyKind {
  return (REACH_DECK_DECKSMITH_AFTER_APPLY_KINDS as readonly unknown[]).includes(value);
}

/**
 * 严格解析采用后媒体意图列表（结果 outcome 与提案 changeSet 共用）：非空、有上限、按页去重、
 * 每项只含 kind 与 pageId。
 */
export function parseReachDeckDecksmithAfterApply(
  value: unknown,
): readonly ReachDeckDecksmithAfterApplyAction[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > REACH_DECK_DECKSMITH_AFTER_APPLY_LIMIT
  ) {
    throw new Error('Reach Deck Decksmith after-apply actions are invalid');
  }
  const pageIds = new Set<string>();
  return value.map((entry) => {
    const action = exactObject(entry, ['kind', 'pageId'], [], 'Decksmith after-apply action');
    if (!isReachDeckDecksmithAfterApplyKind(action.kind)) {
      throw new Error('Reach Deck Decksmith after-apply kind is invalid');
    }
    const pageId = boundedNonblankString(action.pageId, 'Decksmith after-apply pageId', 256);
    if (pageIds.has(pageId)) {
      throw new Error('Reach Deck Decksmith after-apply actions must not repeat a page');
    }
    pageIds.add(pageId);
    return { kind: action.kind, pageId };
  });
}

/** 预算收尾（WP4）时结果里剩余任务的条数与单条字符上限。 */
export const REACH_DECK_DECKSMITH_REMAINING_TASK_LIMIT = 8;
export const REACH_DECK_DECKSMITH_REMAINING_TASK_CHARACTERS = 300;

/**
 * 因额度提前收尾时给教师看的固定文案键：run = 本次运行额度，daily = 每日额度。
 * 文案在 Teacher 的 i18n 目录里，服务端只给键与剩余条数，不下发文字。
 */
export const REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS = Object.freeze({
  run: 'reachDeck.decksmith.budget.runLimited',
  daily: 'reachDeck.decksmith.budget.dailyLimited',
} as const);

export type ReachDeckDecksmithBudgetScope = keyof typeof REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS;

/** 单次运行达到模型轮数上限时的固定文案键（文案在应用 i18n 目录）。 */
export const REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY = 'reachDeck.decksmith.stepLimited';

/** 本轮因额度提前收尾（WP4）：下一次模型调用放不下，或模型按收尾提示停止并列出了剩余任务。 */
export interface ReachDeckDecksmithBudgetCompletion {
  readonly state: 'budget-limited';
  readonly scope: ReachDeckDecksmithBudgetScope;
  readonly messageKey: (typeof REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS)[ReachDeckDecksmithBudgetScope];
}

/** 本轮达到单次运行的模型轮数上限，模型仍在调用工具：任务被截断，需要教师回复"继续"。 */
export interface ReachDeckDecksmithStepLimitCompletion {
  readonly state: 'step-limited';
  readonly messageKey: typeof REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY;
}

export type ReachDeckDecksmithCompletion =
  | ReachDeckDecksmithBudgetCompletion
  | ReachDeckDecksmithStepLimitCompletion;

export interface ReachDeckDecksmithOutcome {
  readonly schemaVersion: typeof REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION;
  readonly mutationStatus: 'none' | 'proposal' | 'partial';
  readonly rejectedFontFamilies: readonly string[];
  readonly toolErrorCount: number;
  readonly suggestedActions?: readonly ReachDeckDecksmithSuggestedAction[];
  /** 预算收尾或轮数截断时尚未完成的任务（有界、面向下一轮"继续"）；与 completion 同时出现。旧结果没有。 */
  readonly remainingTasks?: readonly string[];
  readonly completion?: ReachDeckDecksmithCompletion;
  /** 本轮以结构化提问结束（WP7）：没有修改、没有提案，等待教师下一轮回答。旧结果没有。 */
  readonly clarification?: ReachDeckDecksmithClarification;
  /** 采用后由服务端自动生成的页面媒体（WP8，v5 起）；只随提案出现。旧结果没有。 */
  readonly afterApply?: readonly ReachDeckDecksmithAfterApplyAction[];
}

export interface ReachDeckDecksmithJobResultContent {
  readonly schemaVersion: typeof REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION;
  readonly kind: 'decksmith';
  readonly capability: typeof REACH_DECK_DECKSMITH_CAPABILITY;
  readonly jobId: string;
  readonly runId: string;
  readonly requestHash: string;
  readonly baseDocumentHash: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly message: string;
  /**
   * 模型最终答复（有界，UTF-8 不超过 1,500 字节）；用于跨轮记忆。旧结果没有此字段，照常解析。
   */
  readonly assistantText?: string;
  readonly changed: boolean;
  /** Optional only so persisted v2 results created before outcome/v1 remain readable. */
  readonly outcome?: ReachDeckDecksmithOutcome;
  readonly document?: ReachDeckDocument;
  readonly runtimeRunId?: string;
  readonly runtimeArtifactId?: string;
  readonly runtimeApprovalId?: string;
}

export interface ReachDeckDecksmithJobResult extends ReachDeckDecksmithJobResultContent {
  readonly resultHash: string;
}

export interface ReachDeckDecksmithJobView {
  readonly jobId: string;
  readonly kind: 'decksmith';
  readonly runId: string;
  readonly baseDocumentHash: string;
  readonly status: string;
  readonly progress: number | object;
  readonly resultAvailable: boolean;
  readonly done: boolean;
  readonly error?: string;
}

export function parseReachDeckDecksmithJobInput(value: unknown): ReachDeckDecksmithJobInput {
  const input = exactObject(
    value,
    ['capability', 'prompt', 'document'],
    ['pageId', 'selectedElementIds', 'history', 'contextRefs', 'mediaStatus', 'answersQuestionId'],
    'Decksmith input',
  );
  if (input.capability !== REACH_DECK_DECKSMITH_CAPABILITY) {
    throw new Error(`Reach Deck Decksmith capability must be ${REACH_DECK_DECKSMITH_CAPABILITY}`);
  }
  const prompt = boundedNonblankString(
    input.prompt,
    'Decksmith prompt',
    REACH_DECK_DECKSMITH_LIMITS.promptCharacters,
  );
  const document = parseReachDeckDocument(input.document);
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error('Reach Deck Decksmith v2 requires reach-deck-document/v2');
  }
  if (jsonBytes(document) > REACH_DECK_DECKSMITH_LIMITS.documentBytes) {
    throw new Error('Reach Deck Decksmith document exceeds the size limit');
  }
  const pageId =
    input.pageId === undefined
      ? undefined
      : boundedNonblankString(
          input.pageId,
          'Decksmith pageId',
          REACH_DECK_DECKSMITH_LIMITS.identifierCharacters,
        );
  const selectedElementIds = parseSelectedElementIds(input.selectedElementIds);
  const history = parseDecksmithHistory(input.history);
  const contextRefs = parseDecksmithRequestContextRefs(input.contextRefs);
  const mediaStatus =
    input.mediaStatus === undefined ? undefined : parseDecksmithPageMediaStatus(input.mediaStatus);
  if (mediaStatus !== undefined && pageId !== undefined && mediaStatus.pageId !== pageId) {
    throw new Error('Decksmith media status page does not match pageId');
  }
  if (
    input.answersQuestionId !== undefined &&
    !isDecksmithClarificationQuestionId(input.answersQuestionId)
  ) {
    throw new Error('Reach Deck Decksmith answersQuestionId is invalid');
  }
  const parsed: ReachDeckDecksmithJobInput = {
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt,
    document,
    ...(pageId === undefined ? {} : { pageId }),
    ...(selectedElementIds === undefined ? {} : { selectedElementIds }),
    ...(history === undefined ? {} : { history }),
    ...(contextRefs === undefined ? {} : { contextRefs }),
    ...(mediaStatus === undefined ? {} : { mediaStatus }),
    ...(input.answersQuestionId === undefined
      ? {}
      : { answersQuestionId: input.answersQuestionId as string }),
  };
  if (jsonBytes(parsed) > REACH_DECK_DECKSMITH_LIMITS.inputBytes) {
    throw new Error('Reach Deck Decksmith input exceeds the size limit');
  }
  return parsed;
}

/**
 * Shape-only deployment-window parser for durable run/recovery facts. Task 2 route and
 * reattachment checks enforce the 24-hour legacy age gate; callers can branch explicitly here.
 */
export type ReachDeckDecksmithCompatibleRunInput =
  | { readonly format: 'legacy'; readonly input: ReachDeckDecksmithJobInput }
  | { readonly format: 'frozen'; readonly input: DecksmithFrozenRunInput };

export function parseReachDeckDecksmithCompatibleRunInput(
  value: unknown,
): ReachDeckDecksmithCompatibleRunInput {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ((value as Record<string, unknown>).schemaVersion ===
      DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION ||
      (value as Record<string, unknown>).schemaVersion ===
        DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION)
  ) {
    return Object.freeze({ format: 'frozen', input: parseDecksmithFrozenRunInput(value) });
  }
  return Object.freeze({ format: 'legacy', input: parseReachDeckDecksmithJobInput(value) });
}

export function parseReachDeckDecksmithJobPayload(value: unknown): ReachDeckDecksmithJobPayload {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Object.prototype.hasOwnProperty.call(value, 'input')
  ) {
    return parseReachDeckDecksmithV2JobPayload(value);
  }
  const payload = exactObject(
    value,
    [
      'schemaVersion',
      'kind',
      'capability',
      'jobId',
      'runId',
      'requestHash',
      'baseDocumentHash',
      'actorId',
      'billingGroupId',
      'roleGrantId',
      'resourceScope',
      'input',
    ],
    ['actorOrganizationId'],
    'Decksmith job payload',
  );
  if (
    (payload.schemaVersion !== REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION &&
      payload.schemaVersion !== REACH_DECK_DECKSMITH_LEGACY_JOB_SCHEMA_VERSION) ||
    payload.kind !== 'decksmith' ||
    payload.capability !== REACH_DECK_DECKSMITH_CAPABILITY
  ) {
    throw new Error('Reach Deck Decksmith job contract is invalid');
  }
  const input = parseReachDeckDecksmithJobInput(payload.input);
  const resourceScope = parseReachDeckResourceScope(payload.resourceScope);
  const actorOrganizationId = actorOrganizationIdFromPayload({
    actorOrganizationId: payload.actorOrganizationId,
    resourceScope,
  });
  if (input.document.id !== resourceScope.moduleVersionId) {
    throw new Error('Reach Deck Decksmith document does not match the resource scope');
  }
  const parsed: ReachDeckDecksmithLegacyJobPayload = {
    schemaVersion: payload.schemaVersion,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: boundedNonblankString(payload.jobId, 'Decksmith jobId', 128),
    runId: boundedNonblankString(payload.runId, 'Decksmith runId', 128),
    requestHash: hashString(payload.requestHash, 'Decksmith requestHash'),
    baseDocumentHash: hashString(payload.baseDocumentHash, 'Decksmith baseDocumentHash'),
    actorId: boundedNonblankString(payload.actorId, 'Decksmith actorId', 255),
    actorOrganizationId,
    billingGroupId:
      payload.billingGroupId === null
        ? null
        : boundedNonblankString(payload.billingGroupId, 'Decksmith billingGroupId', 255),
    roleGrantId: boundedNonblankString(payload.roleGrantId, 'Decksmith roleGrantId', 255),
    resourceScope,
    input,
  };
  if (
    parsed.requestHash !== buildDecksmithRequestHash(parsed.input) ||
    parsed.baseDocumentHash !== buildDecksmithDocumentHash(parsed.input.document) ||
    parsed.jobId !== buildDecksmithJobId(parsed)
  ) {
    throw new Error('Reach Deck Decksmith job identity is invalid');
  }
  return parsed;
}

function parseReachDeckDecksmithV2JobPayload(value: unknown): ReachDeckDecksmithV2JobPayload {
  const payload = exactObject(
    value,
    [
      'schemaVersion',
      'kind',
      'capability',
      'jobId',
      'runId',
      'runtimeRunId',
      'threadId',
      'requestHash',
      'baseDocumentHash',
      'contextDigest',
      'actorId',
      'billingGroupId',
      'roleGrantId',
      'resourceScope',
    ],
    ['pageId', 'actorOrganizationId'],
    'Decksmith v2 job payload',
  );
  if (
    payload.schemaVersion !== REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION ||
    payload.kind !== 'decksmith' ||
    payload.capability !== REACH_DECK_DECKSMITH_CAPABILITY
  ) {
    throw new Error('Reach Deck Decksmith v2 job contract is invalid');
  }
  const resourceScope = parseReachDeckResourceScope(payload.resourceScope);
  const parsed: ReachDeckDecksmithV2JobPayload = {
    schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: boundedNonblankString(payload.jobId, 'Decksmith jobId', 128),
    runId: boundedNonblankString(payload.runId, 'Decksmith runId', 128),
    runtimeRunId: uuidString(payload.runtimeRunId, 'Decksmith runtimeRunId'),
    threadId: uuidString(payload.threadId, 'Decksmith threadId'),
    requestHash: hashString(payload.requestHash, 'Decksmith requestHash'),
    baseDocumentHash: hashString(payload.baseDocumentHash, 'Decksmith baseDocumentHash'),
    contextDigest: hashString(payload.contextDigest, 'Decksmith contextDigest'),
    actorId: boundedNonblankString(payload.actorId, 'Decksmith actorId', 255),
    actorOrganizationId: actorOrganizationIdFromPayload({
      actorOrganizationId: payload.actorOrganizationId,
      resourceScope,
    }),
    billingGroupId:
      payload.billingGroupId === null
        ? null
        : boundedNonblankString(payload.billingGroupId, 'Decksmith billingGroupId', 255),
    roleGrantId: boundedNonblankString(payload.roleGrantId, 'Decksmith roleGrantId', 255),
    resourceScope,
    ...(payload.pageId === undefined
      ? {}
      : { pageId: boundedNonblankString(payload.pageId, 'Decksmith pageId', 256) }),
  };
  if (parsed.jobId !== buildDecksmithJobId(parsed)) {
    throw new Error('Reach Deck Decksmith v2 job identity is invalid');
  }
  return parsed;
}

function decksmithAssistantText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > DECKSMITH_ASSISTANT_TEXT_BYTES
  ) {
    throw new Error('Decksmith result assistantText is invalid');
  }
  return value;
}

export function parseReachDeckDecksmithJobResult(
  value: unknown,
  expected?: ReachDeckDecksmithJobPayload,
): ReachDeckDecksmithJobResult {
  const result = exactObject(
    value,
    [
      'schemaVersion',
      'kind',
      'capability',
      'jobId',
      'runId',
      'requestHash',
      'baseDocumentHash',
      'resultHash',
      'attempt',
      'startedAt',
      'completedAt',
      'message',
      'changed',
    ],
    [
      'assistantText',
      'outcome',
      'document',
      'runtimeRunId',
      'runtimeArtifactId',
      'runtimeApprovalId',
    ],
    'Decksmith result',
  );
  if (
    result.schemaVersion !== REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION ||
    result.kind !== 'decksmith' ||
    result.capability !== REACH_DECK_DECKSMITH_CAPABILITY ||
    typeof result.changed !== 'boolean'
  ) {
    throw new Error('Reach Deck Decksmith result contract is invalid');
  }
  const document =
    result.document === undefined ? undefined : parseReachDeckDocument(result.document);
  if ((result.changed && document === undefined) || (!result.changed && document !== undefined)) {
    throw new Error('Reach Deck Decksmith result document does not match changed');
  }
  const outcome =
    result.outcome === undefined ? undefined : parseReachDeckDecksmithOutcome(result.outcome);
  if (
    outcome !== undefined &&
    ((result.changed && outcome.mutationStatus === 'none') ||
      (!result.changed && outcome.mutationStatus !== 'none'))
  ) {
    throw new Error('Reach Deck Decksmith result outcome does not match changed');
  }
  if (document !== undefined && jsonBytes(document) > REACH_DECK_DECKSMITH_LIMITS.documentBytes) {
    throw new Error('Reach Deck Decksmith result document exceeds the size limit');
  }
  const content: ReachDeckDecksmithJobResultContent = {
    schemaVersion: REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: boundedNonblankString(result.jobId, 'Decksmith result jobId', 128),
    runId: boundedNonblankString(result.runId, 'Decksmith result runId', 128),
    requestHash: hashString(result.requestHash, 'Decksmith result requestHash'),
    baseDocumentHash: hashString(result.baseDocumentHash, 'Decksmith result baseDocumentHash'),
    attempt: positiveInteger(result.attempt, 'Decksmith result attempt'),
    startedAt: timestamp(result.startedAt, 'Decksmith result startedAt'),
    completedAt: timestamp(result.completedAt, 'Decksmith result completedAt'),
    message: boundedString(
      result.message,
      'Decksmith result message',
      REACH_DECK_DECKSMITH_LIMITS.assistantMessageCharacters,
    ),
    ...(result.assistantText === undefined
      ? {}
      : { assistantText: decksmithAssistantText(result.assistantText) }),
    changed: result.changed,
    ...(outcome === undefined ? {} : { outcome }),
    ...(document === undefined ? {} : { document }),
    ...(result.runtimeRunId === undefined
      ? {}
      : {
          runtimeRunId: boundedNonblankString(
            result.runtimeRunId,
            'Decksmith result runtimeRunId',
            128,
          ),
        }),
    ...(result.runtimeArtifactId === undefined
      ? {}
      : {
          runtimeArtifactId: boundedNonblankString(
            result.runtimeArtifactId,
            'Decksmith result runtimeArtifactId',
            128,
          ),
        }),
    ...(result.runtimeApprovalId === undefined
      ? {}
      : {
          runtimeApprovalId: boundedNonblankString(
            result.runtimeApprovalId,
            'Decksmith result runtimeApprovalId',
            128,
          ),
        }),
  };
  if (Date.parse(content.completedAt) < Date.parse(content.startedAt)) {
    throw new Error('Reach Deck Decksmith result timestamps are invalid');
  }
  if (
    expected !== undefined &&
    (content.jobId !== expected.jobId ||
      content.runId !== expected.runId ||
      content.requestHash !== expected.requestHash ||
      content.baseDocumentHash !== expected.baseDocumentHash ||
      content.capability !== expected.capability ||
      (content.document !== undefined &&
        content.document.id !== expected.resourceScope.moduleVersionId))
  ) {
    throw new Error('Reach Deck Decksmith result provenance is invalid');
  }
  const parsed = {
    ...content,
    resultHash: hashString(result.resultHash, 'Decksmith resultHash'),
  };
  if (parsed.resultHash !== buildDecksmithResultHash(content)) {
    throw new Error('Reach Deck Decksmith result hash is invalid');
  }
  if (jsonBytes(parsed) > REACH_DECK_DECKSMITH_LIMITS.resultBytes) {
    throw new Error('Reach Deck Decksmith result exceeds the size limit');
  }
  return parsed;
}

export function parseReachDeckDecksmithOutcome(value: unknown): ReachDeckDecksmithOutcome {
  const outcome = exactObject(
    value,
    ['schemaVersion', 'mutationStatus', 'rejectedFontFamilies', 'toolErrorCount'],
    ['suggestedActions', 'remainingTasks', 'completion', 'clarification', 'afterApply'],
    'Decksmith outcome',
  );
  if (
    outcome.schemaVersion !== REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION ||
    (outcome.mutationStatus !== 'none' &&
      outcome.mutationStatus !== 'proposal' &&
      outcome.mutationStatus !== 'partial') ||
    !Array.isArray(outcome.rejectedFontFamilies) ||
    outcome.rejectedFontFamilies.length > 16 ||
    !Number.isInteger(outcome.toolErrorCount) ||
    (outcome.toolErrorCount as number) < 0
  ) {
    throw new Error('Reach Deck Decksmith outcome contract is invalid');
  }
  const rejectedFontFamilies = outcome.rejectedFontFamilies.map((font) =>
    boundedNonblankString(font, 'Decksmith rejected font family', 256),
  );
  if (
    new Set(rejectedFontFamilies.map((font) => font.toLowerCase())).size !==
    rejectedFontFamilies.length
  ) {
    throw new Error('Reach Deck Decksmith outcome rejected font families must be unique');
  }
  const completion =
    outcome.completion === undefined ? undefined : parseDecksmithCompletion(outcome.completion);
  const remainingTasks =
    outcome.remainingTasks === undefined
      ? undefined
      : parseDecksmithRemainingTasks(outcome.remainingTasks);
  // 剩余任务只在预算收尾或轮数截断时出现，二者必须同时给出。
  if ((completion === undefined) !== (remainingTasks === undefined)) {
    throw new Error('Reach Deck Decksmith outcome completion is inconsistent');
  }
  if (
    (outcome.mutationStatus === 'proposal' &&
      (rejectedFontFamilies.length > 0 ||
        outcome.toolErrorCount !== 0 ||
        completion !== undefined)) ||
    (outcome.mutationStatus === 'partial' &&
      rejectedFontFamilies.length === 0 &&
      outcome.toolErrorCount === 0 &&
      completion === undefined)
  ) {
    throw new Error('Reach Deck Decksmith outcome status is inconsistent');
  }
  const suggestedActions =
    outcome.suggestedActions === undefined
      ? undefined
      : parseDecksmithSuggestedActions(outcome.suggestedActions);
  const clarification =
    outcome.clarification === undefined
      ? undefined
      : parseReachDeckDecksmithClarification(outcome.clarification);
  // 提问结束的回合不产生提案，也不是额度收尾（停止语义：提问只允许在首个修改之前）。
  if (
    clarification !== undefined &&
    (outcome.mutationStatus !== 'none' || completion !== undefined)
  ) {
    throw new Error('Reach Deck Decksmith outcome clarification is inconsistent');
  }
  const afterApply =
    outcome.afterApply === undefined
      ? undefined
      : parseReachDeckDecksmithAfterApply(outcome.afterApply);
  // 采用后媒体只随提案出现：没有修改就没有可采用的讲稿。
  if (afterApply !== undefined && outcome.mutationStatus === 'none') {
    throw new Error('Reach Deck Decksmith outcome after-apply actions require a proposal');
  }
  return {
    schemaVersion: REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION,
    mutationStatus: outcome.mutationStatus,
    rejectedFontFamilies,
    toolErrorCount: outcome.toolErrorCount as number,
    ...(suggestedActions === undefined ? {} : { suggestedActions }),
    ...(remainingTasks === undefined ? {} : { remainingTasks }),
    ...(completion === undefined ? {} : { completion }),
    ...(clarification === undefined ? {} : { clarification }),
    ...(afterApply === undefined ? {} : { afterApply }),
  };
}

function parseDecksmithCompletion(value: unknown): ReachDeckDecksmithCompletion {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).state === 'step-limited'
  ) {
    const stepLimited = exactObject(
      value,
      ['state', 'messageKey'],
      [],
      'Decksmith outcome completion',
    );
    if (stepLimited.messageKey !== REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY) {
      throw new Error('Reach Deck Decksmith outcome completion is invalid');
    }
    return { state: 'step-limited', messageKey: REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY };
  }
  const completion = exactObject(
    value,
    ['state', 'scope', 'messageKey'],
    [],
    'Decksmith outcome completion',
  );
  if (
    completion.state !== 'budget-limited' ||
    (completion.scope !== 'run' && completion.scope !== 'daily') ||
    completion.messageKey !== REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS[completion.scope]
  ) {
    throw new Error('Reach Deck Decksmith outcome completion is invalid');
  }
  return {
    state: 'budget-limited',
    scope: completion.scope,
    messageKey: REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS[completion.scope],
  };
}

function parseDecksmithRemainingTasks(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > REACH_DECK_DECKSMITH_REMAINING_TASK_LIMIT
  ) {
    throw new Error('Reach Deck Decksmith remaining tasks are invalid');
  }
  return value.map((task) =>
    boundedNonblankString(
      task,
      'Decksmith remaining task',
      REACH_DECK_DECKSMITH_REMAINING_TASK_CHARACTERS,
    ),
  );
}

function parseDecksmithSuggestedActions(
  value: unknown,
): readonly ReachDeckDecksmithSuggestedAction[] {
  if (!Array.isArray(value) || value.length > REACH_DECK_DECKSMITH_SUGGESTED_ACTION_LIMIT) {
    throw new Error('Reach Deck Decksmith suggested actions are invalid');
  }
  return value.map((entry) => {
    const action = exactObject(entry, ['kind', 'pageId'], [], 'Decksmith suggested action');
    if (!isReachDeckDecksmithSuggestedActionKind(action.kind)) {
      throw new Error('Reach Deck Decksmith suggested action kind is invalid');
    }
    return {
      kind: action.kind,
      pageId: boundedNonblankString(action.pageId, 'Decksmith suggested action pageId', 256),
    };
  });
}

export interface ReachDeckGenerationRequest {
  prompt: string;
  language?: 'zh-CN';
  document?: ReachDeckDocument;
  expectedRevisionToken?: string;
}

export type ReachDeckGenerationAttempt = 'initial' | 'regenerate' | 'repair';

export interface ReachDeckGenerationIdentity {
  runId: string;
  pageId: string;
  pageRevision: number;
  attempt: ReachDeckGenerationAttempt;
}

export interface ReachDeckGenerationJobPayload extends ReachDeckGenerationIdentity {
  kind?: undefined;
  schemaVersion?: undefined;
  jobId: string;
  actorId: string;
  /** Actor/session organization. Legacy persisted jobs may omit it. */
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
  requestHash: string;
  request: ReachDeckGenerationRequest;
}

export interface ReachDeckGenerationResult {
  document: ReachDeckDocument;
  runId: string;
  pageId: string;
  pageRevision: number;
  revisionToken: string;
}

export const REACH_DECK_STAGED_JOB_SCHEMA_VERSION = 'reach-deck-generation-job/v5' as const;

export type ReachDeckStagedGenerationJobKind =
  | 'lesson-plan'
  | 'page-outline'
  | 'page-generation'
  | 'narration-generation';

interface ReachDeckStagedGenerationJobBase<Kind extends ReachDeckStagedGenerationJobKind, Request> {
  readonly schemaVersion: typeof REACH_DECK_STAGED_JOB_SCHEMA_VERSION;
  readonly kind: Kind;
  readonly jobId: string;
  readonly actorId: string;
  /** Actor/session organization. Legacy persisted jobs may omit it. */
  readonly actorOrganizationId?: string;
  readonly billingGroupId: string | null;
  readonly roleGrantId: string;
  readonly resourceScope: ReachDeckResourceScope;
  readonly runId: string;
  readonly createdFromDraftRevision: number;
  readonly requestHash: string;
  readonly voiceSelection: ReachDeckVoiceSelection;
  readonly request: Readonly<Request>;
  /** Frozen guidance for capabilities selected by the normal generation flow. */
  readonly scientificContextSnapshot?: ScientificContextSnapshot;
  /**
   * 提示词 snippet 的运行时覆盖，仅由免登录调试工作台产生。
   *
   * 可选字段，正式路径不写；已在途的旧任务读出来就是 undefined，无需迁移。
   * 它已计入 `requestHash`，因此不同覆盖的重跑天然是不同身份。
   */
  readonly promptSnippetOverrides?: ReachDeckPromptSnippetOverrides;
  /**
   * 上面这组覆盖是沿生成链继承而来，而非本阶段的请求直接指定。
   *
   * 链上各阶段模板包含的 snippet 子集不同，继承来的覆盖里出现不属于本阶段的条目
   * 是常态；缺了这个标记，一次 slide 专属的覆盖会让自动推进的讲稿任务在版面调用
   * 已经计费之后失败。不计入 `requestHash`：它只影响不适用条目的处置方式。
   */
  readonly promptSnippetOverridesInherited?: boolean;
}

export type ReachDeckLessonPlanJobPayload = ReachDeckStagedGenerationJobBase<
  'lesson-plan',
  GenerateLessonPlanRequest
>;

export type ReachDeckPageOutlineJobPayload = ReachDeckStagedGenerationJobBase<
  'page-outline',
  GeneratePagedOutlineRequest
>;

export type ReachDeckPageGenerationJobPayload = ReachDeckStagedGenerationJobBase<
  'page-generation',
  PageGenerationRequest
>;

/**
 * 讲稿独立 job：输入版面不随 payload 传输，payload 只携带身份与版面 digest。
 * 工作区通道从当前页工件读取输入；native 通道（sourceKind='materialized-native'）
 * 从物化 v2 文档的 nativeSlides 读取。两个变体分开实例化（而不是把 request 写成
 * 联合）是为了让 Readonly 在联合上正确分配、request 的通道判别可被 TS 收窄。
 */
export type ReachDeckNarrationGenerationJobPayload =
  | ReachDeckStagedGenerationJobBase<'narration-generation', GenerateNarrationRequest>
  | ReachDeckStagedGenerationJobBase<'narration-generation', GenerateInteractiveNarrationRequest>
  | ReachDeckStagedGenerationJobBase<
      'narration-generation',
      GenerateMaterializedInteractiveNarrationRequest
    >
  | ReachDeckStagedGenerationJobBase<'narration-generation', GenerateNativeNarrationRequest>;

export type ReachDeckStagedGenerationJobPayload =
  | ReachDeckLessonPlanJobPayload
  | ReachDeckPageOutlineJobPayload
  | ReachDeckPageGenerationJobPayload
  | ReachDeckNarrationGenerationJobPayload;

export type ReachDeckAnyGenerationJobPayload =
  | ReachDeckGenerationJobPayload
  | ReachDeckStagedGenerationJobPayload
  | ReachDeckDecksmithJobPayload;

/**
 * 调试工作台捕获的一次 provider 请求。
 *
 * `serializedModelInput` 是本次实际发出的完整请求（system + user 全文与 json schema），
 * 由 `model-service-client` 的 onPayload 钩子原样给出，不做任何再拼接。
 */
export interface ReachDeckCapturedModelPrompt {
  /** 发起这次调用的阶段。 */
  readonly stage: string;
  /** 本次使用的 promptVersion，覆盖生效时带 harness 后缀。 */
  readonly promptVersion?: string;
  /** 实际发出的完整请求 JSON 文本。 */
  readonly serializedModelInput: string;
}

interface ReachDeckStagedGenerationResultBase<Kind extends ReachDeckStagedGenerationJobKind> {
  kind: Kind;
  runId: string;
  generatedFromDraftRevision: number;
  /**
   * 本次任务实际发出的完整提示词，仅在调试工作台模式下记录。
   *
   * 正式路径永远不写：提示词正文很长，按阶段落库会显著放大存储。
   * 一次任务可能有多次调用（阶段内纠错重试、科学可视化子调用），故为数组。
   */
  readonly capturedModelPrompts?: readonly ReachDeckCapturedModelPrompt[];
}

export interface ReachDeckLessonPlanJobResult extends ReachDeckStagedGenerationResultBase<'lesson-plan'> {
  candidate: LessonPlan;
}

export interface ReachDeckPageOutlineJobResult extends ReachDeckStagedGenerationResultBase<'page-outline'> {
  candidate: PagedDeckOutline;
}

export interface ReachDeckPageGenerationJobResult extends ReachDeckStagedGenerationResultBase<'page-generation'> {
  artifact: GeneratedSceneArtifact;
}

/**
 * 讲稿 job 的耐久结果（工作区通道）：与版面工件同身份的完整 slide 工件，
 * scene 已带回填后的 voiceTimeline/duration/整页音频。
 */
export interface ReachDeckNarrationGenerationJobResult extends ReachDeckStagedGenerationResultBase<'narration-generation'> {
  /** Narration state observed at job start; landing rejects missing or changed identities. */
  narrationContentDigest: string;
  artifact: GeneratedSceneArtifact;
  /**
   * 首轮工作区原生 slide 通道的音频终态失败码：工件只带讲稿正文与语音标记，不含音频、段落与
   * 时间轴；与物化通道 nativeNarration.audioFailureCode 同义，页面照常收尾，由教师补生成音频。
   */
  audioFailureCode?: string;
}

/** Interactive narration result keeps media provenance beside the narrated scene artifact. */
export interface ReachDeckInteractiveNarrationGenerationJobResult extends ReachDeckStagedGenerationResultBase<'narration-generation'> {
  interactiveNarration: {
    interactiveContentDigest: string;
    narrationTextDigest: string;
    /** Input fence when the output narration was rewritten. */
    sourceNarrationTextDigest?: string;
    sourceInteractiveContentDigest?: string;
    artifact: GeneratedSceneArtifact;
  } & (
    | { audioObjectKey: string; textOnly?: never }
    /** 仅重写讲稿文字：新正文不带音频，落地时去掉旧音频引用。 */
    | { textOnly: true; audioObjectKey?: never }
  );
}

/**
 * 讲稿 job 的耐久结果（native 通道）：中立讲稿产物 + 身份与 native 版面 digest，
 * 由 finalize 写回物化 v2 文档的 nativeSlides（不经工作区工件）。
 */
export interface ReachDeckNativeNarrationGenerationJobResult extends ReachDeckStagedGenerationResultBase<'narration-generation'> {
  nativeNarration: {
    animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
    preservedNarrationDigest?: string;
    pageId: string;
    requestedRevision: number;
    attempt: number;
    generatedAt: string;
    /** 生成时输入版面的 digest；落地时与物化文档当前版面比对，变了即丢弃产物。 */
    nativeSlideContentDigest: string;
    narrationContentDigest: string;
    /**
     * 仅重写讲稿文字的无音频产物：segments 为空、duration 为 0，不含 reveal、音频与
     * audioFailureCode；与 audioFailureCode 并列为合法的"无音频"形态，但属于成功而非失败。
     */
    textOnly?: true;
  } & ReachDeckNativeNarrationProduct;
}

export type ReachDeckStagedGenerationResult =
  | ReachDeckLessonPlanJobResult
  | ReachDeckPageOutlineJobResult
  | ReachDeckPageGenerationJobResult
  | ReachDeckNarrationGenerationJobResult
  | ReachDeckInteractiveNarrationGenerationJobResult
  | ReachDeckNativeNarrationGenerationJobResult;

export type ReachDeckAnyGenerationResult =
  | ReachDeckGenerationResult
  | ReachDeckStagedGenerationResult
  | ReachDeckDecksmithJobResult;

export interface ReachDeckGenerationJobView {
  jobId: string;
  kind?: ReachDeckStagedGenerationJobKind | 'decksmith';
  status: string;
  progress: number | object;
  resultAvailable?: boolean;
  error?: string;
  done: boolean;
}

function parseSelectedElementIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > REACH_DECK_DECKSMITH_LIMITS.selectedElementIds) {
    throw new Error('Reach Deck Decksmith selectedElementIds is invalid');
  }
  const parsed = value.map((elementId) =>
    boundedNonblankString(
      elementId,
      'Decksmith selected element id',
      REACH_DECK_DECKSMITH_LIMITS.identifierCharacters,
    ),
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new Error('Reach Deck Decksmith selectedElementIds contains duplicates');
  }
  return parsed;
}

function parseDecksmithRequestContextRefs(
  value: unknown,
): readonly DecksmithContextRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > DECKSMITH_PAGE_STREAM_LIMITS.refs) {
    throw new Error('Reach Deck Decksmith contextRefs is invalid');
  }
  const refs = value.map((candidate) => parseDecksmithContextRef(candidate));
  const keys = refs.map((ref) =>
    [ref.kind, ref.pageId, ref.kind === 'page' ? '' : ref.componentId].join('\u0000'),
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error('Reach Deck Decksmith contextRefs contains duplicates');
  }
  return refs;
}

function parseDecksmithHistory(
  value: unknown,
): readonly ReachDeckDecksmithHistoryEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > REACH_DECK_DECKSMITH_LIMITS.historyEntries) {
    throw new Error('Reach Deck Decksmith history is invalid');
  }
  let characters = 0;
  const history = value.map((entry) => {
    const record = exactObject(entry, ['role', 'text'], [], 'Decksmith history entry');
    if (record.role !== 'user' && record.role !== 'assistant') {
      throw new Error('Reach Deck Decksmith history role is invalid');
    }
    const text = boundedNonblankString(
      record.text,
      'Decksmith history text',
      REACH_DECK_DECKSMITH_LIMITS.historyEntryCharacters,
    );
    characters += text.length;
    return { role: record.role as 'user' | 'assistant', text };
  });
  if (characters > REACH_DECK_DECKSMITH_LIMITS.historyCharacters) {
    throw new Error('Reach Deck Decksmith history exceeds the size limit');
  }
  return history;
}

function uuidString(value: unknown, label: string): string {
  const parsed = boundedNonblankString(value, label, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed)) {
    throw new Error(`${label} must be a UUID`);
  }
  return parsed;
}

/**
 * Returns the effective actor/session organization for a durable job. Jobs written before the
 * actor/resource split intentionally fall back to the canonical resource organization.
 */
export function actorOrganizationIdFromPayload(payload: {
  readonly actorOrganizationId?: unknown;
  readonly resourceScope: ReachDeckResourceScope;
}): string {
  return uuidString(
    payload.actorOrganizationId ?? payload.resourceScope.organizationId,
    'Reach Deck actorOrganizationId',
  );
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Reach Deck ${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error(`Reach Deck ${label} contains missing or unsupported keys`);
  }
  return record;
}

function boundedNonblankString(value: unknown, label: string, maximum: number): string {
  const result = boundedString(value, label, maximum);
  if (result.trim().length === 0) throw new Error(`Reach Deck ${label} must be nonblank`);
  return result;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`Reach Deck ${label} is invalid`);
  }
  return value;
}

function hashString(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`Reach Deck ${label} is invalid`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Reach Deck ${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = boundedNonblankString(value, label, 64);
  if (Number.isNaN(Date.parse(result))) throw new Error(`Reach Deck ${label} is invalid`);
  return result;
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
