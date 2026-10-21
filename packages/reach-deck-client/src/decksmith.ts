import {
  parseReachDeckDocument,
  stripVolatileReachDeckMediaUrls,
  type ReachDeckDocument,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { createReachDeckUuid } from './uuid.js';

export const REACH_DECK_DECKSMITH_CAPABILITY = 'reach-deck-decksmith/v2' as const;
const DECKSMITH_RESULT_SCHEMA_VERSION = 'reach-deck-decksmith-result/v2' as const;
export const REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION =
  'reach-deck-decksmith-outcome/v1' as const;
const REDIS_STREAM_ID_PATTERN = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/;
const DEFAULT_RECONNECT_BASE_MS = 500;
const MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_SSE_FRAME_CHARACTERS = 256 * 1024;
const START_ATTEMPTS = 3;

export interface ReachDeckDecksmithRequest {
  prompt: string;
  document: ReachDeckDocument;
  pageId?: string;
  selectedElementIds?: string[];
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** v2 structured references. New consumers must not synthesize context in prompt text. */
  contextRefs?: readonly ReachDeckDecksmithContextRef[];
  /**
   * 本条消息回答的 Decksmith 问题 id（outcome.clarification.questionId）。服务端核对它是否仍是本页
   * 本话题最近一个未回答的问题；过期或重复时请求照常执行，只在模型输入里加说明。
   */
  answersQuestionId?: string;
}

export interface ReachDeckDecksmithPageRef {
  schemaVersion: 'reach-deck-decksmith-context-ref/v1';
  kind: 'page';
  pageId: string;
  label: string;
  order: number;
  revision: number;
  baseline: { documentId: string; documentHash: string };
}

export interface ReachDeckDecksmithComponentRef {
  schemaVersion: 'reach-deck-decksmith-context-ref/v1';
  kind: 'native-element' | 'interactive-component';
  pageId: string;
  pageLabel: string;
  pageOrder: number;
  pageRevision: number;
  sceneId: string;
  sceneType: 'slide' | 'interactive';
  componentId: string;
  componentType: string;
  display: { label: string; detail?: string };
  baseline: {
    documentId: string;
    documentHash: string;
    pageRevision: number;
    componentHash: string;
  };
}

export type ReachDeckDecksmithContextRef =
  | ReachDeckDecksmithPageRef
  | ReachDeckDecksmithComponentRef;

export type ReachDeckDecksmithPublicContextRef =
  | Omit<ReachDeckDecksmithPageRef, 'baseline'>
  | Omit<ReachDeckDecksmithComponentRef, 'baseline'>;

export interface ReachDeckDecksmithContextSelection {
  includeCurrentPage: boolean;
  mentionedPageIds?: readonly string[];
  selectedNativeElementIds?: readonly string[];
  /**
   * 其他幻灯片页上被明确指定的原生元素（如跨页回答 Decksmith 提问时点选的候选），
   * 以 pageId + elementId 精确标识；同一页可能有标签相同的多个元素，只靠页码与标签无法区分。
   */
  mentionedNativeElements?: readonly { pageId: string; elementId: string }[];
  interactiveComponent?: {
    pageId: string;
    componentId: string;
    label: string;
    detail?: string;
  };
}

export interface ReachDeckDecksmithHistoryCursor {
  queuedAt: string;
  runId: string;
}

export type ReachDeckDecksmithCapacityState =
  | 'ordinary'
  | 'approaching'
  | 'needs_compaction'
  | 'blocked';

export interface ReachDeckDecksmithApplicationMessage {
  schemaVersion: 'reach-deck-decksmith-application-message/v1';
  kind: 'capacity';
  state: ReachDeckDecksmithCapacityState;
  messageKey:
    | 'reachDeck.decksmith.capacity.ordinary'
    | 'reachDeck.decksmith.capacity.approaching'
    | 'reachDeck.decksmith.capacity.compacting'
    | 'reachDeck.decksmith.capacity.blocked';
  guidance?: {
    action: 'new-topic';
    messageKey: 'reachDeck.decksmith.capacity.startNewTopic';
  };
}

export type ReachDeckDecksmithTurnMessage =
  | {
      kind: 'assistant';
      text: string;
      outcome?: ReachDeckDecksmithOutcome;
      /** Decksmith 的实际最终答复（有界）；旧事件没有此字段。 */
      reply?: string;
    }
  | {
      kind: 'application-message';
      /** Stable within the authoritative Run even if bounded event projection rotates. */
      identity: string;
      message: ReachDeckDecksmithApplicationMessage;
    };

export type ReachDeckDecksmithHistoryEntry =
  | {
      kind: 'turn';
      runId: string;
      status: string;
      queuedAt: string;
      sequence: number;
      epoch: number;
      teacherText: string;
      contextRefs: readonly ReachDeckDecksmithPublicContextRef[];
      /** Public, display-safe event projection in durable event order. */
      messages?: readonly ReachDeckDecksmithTurnMessage[];
      /** Backward-compatible shortcut for the last assistant result. */
      assistantText?: string;
    }
  | {
      kind: 'new-topic';
      runId: string;
      status: string;
      queuedAt: string;
      sequence: number;
      previousEpoch: number;
      nextEpoch: number;
      messageKey: string;
      replacements: Readonly<Record<string, string>>;
    };

export interface ReachDeckDecksmithPageHistory {
  pageId: string;
  threadId: string;
  /** Newest-first, matching the server keyset contract. */
  entries: readonly ReachDeckDecksmithHistoryEntry[];
  nextCursor?: ReachDeckDecksmithHistoryCursor;
  streamSequence: number;
  currentEpoch: number;
  contextRevision: number;
}

export interface ReachDeckDecksmithControlResult {
  runId: string;
  created: boolean;
  pageId: string;
  sequence: number;
  currentEpoch: number;
  contextRevision: number;
}

export type ReachDeckDecksmithProgressEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-start'; tool: string; label: string }
  | { type: 'tool-end'; tool: string; isError: boolean; summary?: string }
  | { type: 'attempt-reset'; attempt: number; reason?: string };

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

/** An existing editor operation Decksmith offers as a button after the teacher asked for it. */
export interface ReachDeckDecksmithSuggestedAction {
  kind: ReachDeckDecksmithSuggestedActionKind;
  pageId: string;
}

/** 采用后由服务端自动生成的页面媒体（WP8）：音频，或音频加讲稿驱动动画。 */
export type ReachDeckDecksmithAfterApplyKind = 'generate-page-audio' | 'regenerate-page-media';

export interface ReachDeckDecksmithAfterApplyAction {
  kind: ReachDeckDecksmithAfterApplyKind;
  pageId: string;
}

/** 额度收尾时的固定文案键：run = 本次运行额度用完，daily = 每日额度用完（文案在应用 i18n 目录）。 */
export const REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS = Object.freeze({
  run: 'reachDeck.decksmith.budget.runLimited',
  daily: 'reachDeck.decksmith.budget.dailyLimited',
} as const);

export type ReachDeckDecksmithBudgetScope = keyof typeof REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS;

/** 单次运行达到模型轮数上限时的固定文案键（文案在应用 i18n 目录）。 */
export const REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY = 'reachDeck.decksmith.stepLimited';

/**
 * 本轮提前收尾：服务端保证同时给出至少一条 remainingTasks。
 * - budget-limited：额度用完（run = 本次运行，daily = 每日）；
 * - step-limited：达到单次运行的模型轮数上限，任务被截断。
 */
export type ReachDeckDecksmithCompletion =
  | {
      state: 'budget-limited';
      scope: ReachDeckDecksmithBudgetScope;
      messageKey: (typeof REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS)[ReachDeckDecksmithBudgetScope];
    }
  | {
      state: 'step-limited';
      messageKey: typeof REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY;
    };

export type ReachDeckDecksmithClarificationExpect = 'choice' | 'select-element' | 'text';

/** 提问候选元素：所在页、页修订、元素 id 与"类型 + alt/文本前缀"标签（服务端有界纯文本）。 */
export interface ReachDeckDecksmithClarificationCandidate {
  pageId: string;
  pageRevision: number;
  elementId: string;
  label: string;
}

/** Decksmith 以结构化提问结束本轮（没有修改、没有提案），等待教师回答。 */
export interface ReachDeckDecksmithClarification {
  questionId: string;
  question: string;
  options: readonly string[];
  candidates: readonly ReachDeckDecksmithClarificationCandidate[];
  expect: ReachDeckDecksmithClarificationExpect;
}

export interface ReachDeckDecksmithOutcome {
  schemaVersion: typeof REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION;
  mutationStatus: 'none' | 'proposal' | 'partial';
  rejectedFontFamilies: readonly string[];
  toolErrorCount: number;
  suggestedActions?: readonly ReachDeckDecksmithSuggestedAction[];
  /** 额度收尾或轮数截断时未完成的任务（最多 8 条）；与 completion 同时出现，旧结果没有。 */
  remainingTasks?: readonly string[];
  completion?: ReachDeckDecksmithCompletion;
  /** 本轮以提问结束时的问题（WP7）；旧结果没有。只与 mutationStatus none 同时出现。 */
  clarification?: ReachDeckDecksmithClarification;
  /** 采用后由服务端自动生成媒体的页（WP8）；只随提案出现，旧结果没有。 */
  afterApply?: readonly ReachDeckDecksmithAfterApplyAction[];
}

export interface ReachDeckDecksmithResult {
  message: string;
  /** 模型实际最终答复（有界，UTF-8 不超过 1,500 字节）；旧结果没有此字段。 */
  assistantText?: string;
  changed: boolean;
  /** Optional only for durable v2 results created before outcome/v1 was introduced. */
  outcome?: ReachDeckDecksmithOutcome;
  document?: ReachDeckDocument;
  runtimeRunId?: string;
  runtimeArtifactId?: string;
  runtimeApprovalId?: string;
}

export interface ReachDeckDecksmithJobMetadata {
  jobId: string;
  kind: 'decksmith';
  capability: typeof REACH_DECK_DECKSMITH_CAPABILITY;
  runId: string;
  /** Present for v2 frozen runs; omitted by the 24-hour legacy compatibility response. */
  runtimeRunId?: string;
  /** Present for v2 frozen page streams. */
  threadId?: string;
  baseDocumentHash: string;
  status: string;
  statusPath: string;
  eventsPath: string;
  resultPath: string;
}

export interface ReachDeckDecksmithStatus {
  jobId: string;
  kind: 'decksmith';
  status: string;
  progress?: number | Record<string, unknown>;
  resultAvailable: boolean;
  done: boolean;
  error?: string;
}

export interface ReachDeckDecksmithDurableResult extends ReachDeckDecksmithResult {
  schemaVersion: typeof DECKSMITH_RESULT_SCHEMA_VERSION;
  kind: 'decksmith';
  capability: typeof REACH_DECK_DECKSMITH_CAPABILITY;
  jobId: string;
  runId: string;
  requestHash: string;
  baseDocumentHash: string;
  resultHash: string;
  attempt: number;
  startedAt: string;
  completedAt: string;
}

export type ReachDeckDecksmithConnectionEvent =
  | {
      type: 'reconnecting';
      reconnectAttempt: number;
      delayMs: number;
      lastEventId?: string;
    }
  | { type: 'reconnected'; reconnectAttempt: number; lastEventId?: string };

export interface ReachDeckDecksmithObservation {
  event: 'reconnecting' | 'reconnected';
  reconnectCount: number;
  jobId?: string;
}

export interface ReachDeckDecksmithStartOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
  onConnectionEvent?: (event: ReachDeckDecksmithConnectionEvent) => void;
}

export interface ReachDeckDecksmithObserveOptions {
  lastEventId?: string;
  signal?: AbortSignal;
  onEvent?: (event: ReachDeckDecksmithProgressEvent) => void;
  onConnectionEvent?: (event: ReachDeckDecksmithConnectionEvent) => void;
}

export interface ReachDeckDecksmithRunOptions extends ReachDeckDecksmithStartOptions {
  lastEventId?: string;
}

export interface ReachDeckDecksmithContext {
  organizationId: string;
  courseId: string;
  courseWorkspaceType: 'draft';
  courseNodeId: string;
  moduleId: string;
  moduleVersionId: string;
  moduleTitle?: string;
}

export interface DecksmithClientDependencies {
  fetch: typeof globalThis.fetch;
  random: () => number;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  createIdempotencyKey: () => string;
  buildContextUrl: (path: string, context: ReachDeckDecksmithContext) => string;
  apiError: (message: string, status: number) => Error;
  observe: (observation: ReachDeckDecksmithObservation) => void;
}

export class DecksmithClientOperations {
  constructor(private readonly dependencies: DecksmithClientDependencies) {}

  async start(
    context: ReachDeckDecksmithContext,
    input: ReachDeckDecksmithRequest,
    options: ReachDeckDecksmithStartOptions = {},
  ): Promise<ReachDeckDecksmithJobMetadata> {
    const idempotencyKey = nonblank(
      options.idempotencyKey ?? this.dependencies.createIdempotencyKey(),
      'idempotencyKey',
    );
    const body = JSON.stringify({
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      prompt: nonblank(input.prompt, 'prompt'),
      document: input.document,
      ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
      ...(input.selectedElementIds === undefined
        ? {}
        : { selectedElementIds: input.selectedElementIds }),
      ...(input.history === undefined ? {} : { history: input.history }),
      ...(input.contextRefs === undefined ? {} : { contextRefs: input.contextRefs }),
      ...(input.answersQuestionId === undefined
        ? {}
        : { answersQuestionId: nonblank(input.answersQuestionId, 'answersQuestionId') }),
    });
    let lastError: unknown;
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
      throwIfAborted(options.signal);
      try {
        const response = await this.dependencies.fetch(
          this.dependencies.buildContextUrl('/workspace/decksmith', context),
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              'idempotency-key': idempotencyKey,
            },
            body,
            signal: options.signal,
          },
        );
        const payload = await readJson(response);
        if (response.ok) return parseJobMetadata(payload);
        lastError = apiErrorFromResponse(
          this.dependencies,
          response.status,
          payload,
          'Decksmith request failed',
        );
        if (!isRetryableStatus(response.status) || attempt === START_ATTEMPTS) throw lastError;
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted === true) throw error;
        lastError = error;
        if (!(error instanceof TypeError) || attempt === START_ATTEMPTS) throw error;
      }
      await this.waitToReconnect(attempt, undefined, options.signal, options.onConnectionEvent);
    }
    throw lastError;
  }

  async history(
    context: ReachDeckDecksmithContext,
    pageId: string,
    options: {
      cursor?: ReachDeckDecksmithHistoryCursor;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReachDeckDecksmithPageHistory> {
    const normalizedPageId = nonblank(pageId, 'pageId');
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Decksmith history limit must be an integer between 1 and 100');
    }
    const path = `/workspace/decksmith/pages/${encodeURIComponent(normalizedPageId)}`;
    const url = this.dependencies.buildContextUrl(path, context);
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.cursor !== undefined) {
      query.set('cursorQueuedAt', options.cursor.queuedAt);
      query.set('cursorRunId', nonblank(options.cursor.runId, 'history cursor runId'));
    }
    const response = await this.dependencies.fetch(`${url}&${query.toString()}`, {
      headers: { accept: 'application/json' },
      signal: options.signal,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw apiErrorFromResponse(
        this.dependencies,
        response.status,
        payload,
        'Decksmith history request failed',
      );
    }
    return parseReachDeckDecksmithPageHistory(payload, normalizedPageId);
  }

  async newTopic(
    context: ReachDeckDecksmithContext,
    pageId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithControlResult> {
    return this.control(context, pageId, 'new-topic', 'POST', idempotencyKey, signal);
  }

  async softDeleteConversation(
    context: ReachDeckDecksmithContext,
    pageId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithControlResult> {
    return this.control(context, pageId, 'conversation', 'DELETE', idempotencyKey, signal);
  }

  async run(
    context: ReachDeckDecksmithContext,
    input: ReachDeckDecksmithRequest,
    onEvent?: (event: ReachDeckDecksmithProgressEvent) => void,
    options: ReachDeckDecksmithRunOptions = {},
  ): Promise<ReachDeckDecksmithDurableResult> {
    const job = await this.start(context, input, options);
    return this.observe(context, job, {
      ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(onEvent === undefined ? {} : { onEvent }),
      ...(options.onConnectionEvent === undefined
        ? {}
        : { onConnectionEvent: options.onConnectionEvent }),
    });
  }

  async readStatus(
    context: ReachDeckDecksmithContext,
    job: string | ReachDeckDecksmithJobMetadata,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithStatus> {
    const jobId = typeof job === 'string' ? nonblank(job, 'jobId') : job.jobId;
    const path = typeof job === 'string' ? generationPath(jobId) : job.statusPath;
    const payload = await this.requestJson(path, context, signal);
    return parseStatus(payload, jobId);
  }

  async readResult(
    context: ReachDeckDecksmithContext,
    job: string | ReachDeckDecksmithJobMetadata,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithDurableResult> {
    const jobId = typeof job === 'string' ? nonblank(job, 'jobId') : job.jobId;
    const path = typeof job === 'string' ? generationPath(jobId) + '/result' : job.resultPath;
    const payload = await this.requestJson(path, context, signal);
    return parseDurableResult(payload, jobId, context.moduleVersionId);
  }

  async cancel(
    context: ReachDeckDecksmithContext,
    job: string | ReachDeckDecksmithJobMetadata,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithStatus> {
    const jobId = typeof job === 'string' ? nonblank(job, 'jobId') : job.jobId;
    const payload = await this.requestJson(generationPath(jobId) + '/cancel', context, signal, {
      method: 'POST',
    });
    return parseStatus(payload, jobId);
  }

  async observe(
    context: ReachDeckDecksmithContext,
    job: ReachDeckDecksmithJobMetadata,
    options: ReachDeckDecksmithObserveOptions = {},
  ): Promise<ReachDeckDecksmithDurableResult> {
    let lastEventId = validateOptionalEventId(options.lastEventId);
    let serverRetryMs = DEFAULT_RECONNECT_BASE_MS;
    let reconnectAttempt = 0;

    for (;;) {
      throwIfAborted(options.signal);
      let response: Response;
      try {
        response = await this.dependencies.fetch(
          this.dependencies.buildContextUrl(normalizeClientPath(job.eventsPath), context),
          {
            headers: {
              accept: 'text/event-stream',
              ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
            },
            signal: options.signal,
          },
        );
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted === true) throw error;
        const recovered = await this.tryReadTerminal(context, job, options.signal);
        if (recovered !== undefined) return recovered;
        reconnectAttempt += 1;
        await this.waitToReconnect(
          reconnectAttempt,
          lastEventId,
          options.signal,
          options.onConnectionEvent,
          serverRetryMs,
          job.jobId,
        );
        continue;
      }

      if (!response.ok) {
        const payload = await readJson(response);
        if (isExpiredCursorResponse(response.status, payload)) {
          return this.readTerminalResult(
            context,
            job,
            options.signal,
            options.onConnectionEvent,
            lastEventId,
          );
        }
        if (!isRetryableStatus(response.status)) {
          throw apiErrorFromResponse(
            this.dependencies,
            response.status,
            payload,
            'Decksmith event request failed',
          );
        }
        const recovered = await this.tryReadTerminal(context, job, options.signal);
        if (recovered !== undefined) return recovered;
        reconnectAttempt += 1;
        await this.waitToReconnect(
          reconnectAttempt,
          lastEventId,
          options.signal,
          options.onConnectionEvent,
          serverRetryMs,
          job.jobId,
        );
        continue;
      }

      if (reconnectAttempt > 0) {
        this.dependencies.observe({
          event: 'reconnected',
          reconnectCount: reconnectAttempt,
          jobId: job.jobId,
        });
        options.onConnectionEvent?.({
          type: 'reconnected',
          reconnectAttempt,
          ...(lastEventId === undefined ? {} : { lastEventId }),
        });
      }

      let shouldReconnect = true;
      try {
        for await (const frame of readServerSentEventFrames(response, options.signal)) {
          if (frame.retryMs !== undefined) serverRetryMs = frame.retryMs;
          if (frame.data === undefined) continue;
          if (frame.event === 'stream-expired') {
            return this.readTerminalResult(
              context,
              job,
              options.signal,
              options.onConnectionEvent,
              lastEventId,
            );
          }
          if (frame.event === 'error') throw new RetryableDecksmithStreamError();
          if (
            frame.event !== undefined &&
            frame.event !== 'decksmith' &&
            frame.event !== 'message'
          ) {
            throw this.dependencies.apiError('Decksmith event type is invalid', 502);
          }
          const event = parseEnvelope(frame.data, job.jobId);
          if (frame.id === undefined) {
            throw this.dependencies.apiError('Decksmith event id is required', 502);
          }
          if (lastEventId !== undefined && compareStreamIds(frame.id, lastEventId) <= 0) continue;

          const progress = parseProgressEvent(event);
          if (progress !== undefined) options.onEvent?.(progress);
          lastEventId = frame.id;

          if (event.type === 'result-ready') {
            shouldReconnect = false;
            return this.readTerminalResult(
              context,
              job,
              options.signal,
              options.onConnectionEvent,
              lastEventId,
            );
          }
          if (event.type === 'error') {
            shouldReconnect = false;
            throw terminalEventError(this.dependencies, event.payload);
          }
        }
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted === true) throw error;
        if (!(error instanceof RetryableDecksmithStreamError)) throw error;
      }

      if (!shouldReconnect) {
        throw this.dependencies.apiError('Decksmith stream ended without a result', 502);
      }
      const recovered = await this.tryReadTerminal(context, job, options.signal);
      if (recovered !== undefined) return recovered;
      reconnectAttempt += 1;
      await this.waitToReconnect(
        reconnectAttempt,
        lastEventId,
        options.signal,
        options.onConnectionEvent,
        serverRetryMs,
        job.jobId,
      );
    }
  }

  private async tryReadTerminal(
    context: ReachDeckDecksmithContext,
    job: ReachDeckDecksmithJobMetadata,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithDurableResult | undefined> {
    let status: ReachDeckDecksmithStatus;
    try {
      status = await this.readStatus(context, job, signal);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted === true) throw error;
      if (isHttpStatusError(error)) {
        if (isRetryableStatus(error.status)) return undefined;
        throw error;
      }
      if (error instanceof TypeError) return undefined;
      throw error;
    }
    if (!status.done) return undefined;
    if (!isResultBearingTerminalStatus(status)) {
      return await this.resultForTerminalStatus(context, job, status, signal);
    }
    try {
      return await this.resultForTerminalStatus(context, job, status, signal);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted === true) throw error;
      if (isHttpStatusError(error) && isRetryableStatus(error.status)) return undefined;
      if (error instanceof TypeError) return undefined;
      throw error;
    }
  }

  private async readTerminalResult(
    context: ReachDeckDecksmithContext,
    job: ReachDeckDecksmithJobMetadata,
    signal?: AbortSignal,
    onConnectionEvent?: (event: ReachDeckDecksmithConnectionEvent) => void,
    lastEventId?: string,
  ): Promise<ReachDeckDecksmithDurableResult> {
    let pollAttempt = 0;
    for (;;) {
      throwIfAborted(signal);
      let status: ReachDeckDecksmithStatus | undefined;
      try {
        status = await this.readStatus(context, job, signal);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw error;
        if (isHttpStatusError(error)) {
          if (!isRetryableStatus(error.status)) throw error;
        } else if (!(error instanceof TypeError)) {
          throw error;
        }
      }
      if (status?.done === true) {
        if (!isResultBearingTerminalStatus(status)) {
          return await this.resultForTerminalStatus(context, job, status, signal);
        }
        try {
          return await this.resultForTerminalStatus(context, job, status, signal);
        } catch (error) {
          if (isAbortError(error) || signal?.aborted === true) throw error;
          if (isHttpStatusError(error)) {
            if (!isRetryableStatus(error.status)) throw error;
          } else if (!(error instanceof TypeError)) {
            throw error;
          }
        }
      }
      pollAttempt += 1;
      await this.waitToReconnect(
        pollAttempt,
        lastEventId,
        signal,
        onConnectionEvent,
        2_000,
        job.jobId,
      );
    }
  }

  private async resultForTerminalStatus(
    context: ReachDeckDecksmithContext,
    job: ReachDeckDecksmithJobMetadata,
    status: ReachDeckDecksmithStatus,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithDurableResult> {
    // Decksmith durable results become available before the approval decision is
    // applied.  `awaiting-approval` is therefore a terminal, result-bearing
    // state for the observer even though the materialized document has not yet
    // been accepted by the workspace.  Treat it like `completed` here so the
    // editor can surface the pending change and let the teacher explicitly
    // approve or discard it.
    // A durable Decksmith result remains available while the teacher approval
    // moves through its adoption lifecycle.  Workspace recovery projects
    // these states as terminal so a refresh/new tab can recover the candidate
    // (including its runtime approval id) instead of turning it into a generic
    // 502.  Keep `resultAvailable` as the capability guard: rejected or
    // incomplete proposals must not be read as candidates.
    if (isResultBearingTerminalStatus(status)) {
      return this.readResult(context, job, signal);
    }
    if (status.status === 'cancelled') {
      throw this.dependencies.apiError(status.error ?? 'Decksmith generation was cancelled', 409);
    }
    if (status.status === 'failed') {
      throw this.dependencies.apiError(status.error ?? 'Decksmith generation failed', 502);
    }
    throw this.dependencies.apiError('Decksmith durable result is unavailable', 502);
  }

  private async requestJson(
    path: string,
    context: ReachDeckDecksmithContext,
    signal?: AbortSignal,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.dependencies.fetch(
      this.dependencies.buildContextUrl(normalizeClientPath(path), context),
      {
        ...init,
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        signal,
      },
    );
    const payload = await readJson(response);
    if (!response.ok) {
      throw apiErrorFromResponse(
        this.dependencies,
        response.status,
        payload,
        'Decksmith request failed',
      );
    }
    return payload;
  }

  private async control(
    context: ReachDeckDecksmithContext,
    pageId: string,
    action: 'new-topic' | 'conversation',
    method: 'POST' | 'DELETE',
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithControlResult> {
    const normalizedPageId = nonblank(pageId, 'pageId');
    const payload = await this.requestJson(
      `/workspace/decksmith/pages/${encodeURIComponent(normalizedPageId)}/${action}`,
      context,
      signal,
      {
        method,
        headers: { 'idempotency-key': nonblank(idempotencyKey, 'idempotencyKey') },
      },
    );
    return parseReachDeckDecksmithControlResult(payload, normalizedPageId);
  }

  private async waitToReconnect(
    reconnectAttempt: number,
    lastEventId: string | undefined,
    signal: AbortSignal | undefined,
    onConnectionEvent: ((event: ReachDeckDecksmithConnectionEvent) => void) | undefined,
    baseMs = DEFAULT_RECONNECT_BASE_MS,
    jobId?: string,
  ): Promise<void> {
    const exponential = Math.min(
      MAX_RECONNECT_DELAY_MS,
      Math.max(DEFAULT_RECONNECT_BASE_MS, baseMs) * 2 ** Math.min(reconnectAttempt - 1, 20),
    );
    const random = clampRandom(this.dependencies.random());
    const delayMs = Math.floor(exponential * (0.5 + random * 0.5));
    this.dependencies.observe({
      event: 'reconnecting',
      reconnectCount: reconnectAttempt,
      ...(jobId === undefined ? {} : { jobId }),
    });
    onConnectionEvent?.({
      type: 'reconnecting',
      reconnectAttempt,
      delayMs,
      ...(lastEventId === undefined ? {} : { lastEventId }),
    });
    await this.dependencies.sleep(delayMs, signal);
  }
}

interface DecksmithEventEnvelope {
  jobId: string;
  attempt: number;
  type: 'text-delta' | 'tool-start' | 'tool-end' | 'attempt-reset' | 'result-ready' | 'error';
  payload: Record<string, unknown>;
}

function parseJobMetadata(value: unknown): ReachDeckDecksmithJobMetadata {
  const record = requireRecord(value, 'Decksmith create response');
  const jobId = requiredString(record, 'jobId');
  if (record.kind !== 'decksmith') throw new Error('Decksmith create response kind is invalid');
  const expected = generationPath(jobId);
  const runtimeRunId = optionalString(record, 'runtimeRunId');
  const threadId = optionalString(record, 'threadId');
  const metadata = {
    jobId,
    kind: 'decksmith' as const,
    capability: requireDecksmithCapability(record.capability, 'Decksmith create response'),
    runId: requiredString(record, 'runId'),
    ...(runtimeRunId === undefined ? {} : { runtimeRunId }),
    ...(threadId === undefined ? {} : { threadId }),
    baseDocumentHash: requiredString(record, 'baseDocumentHash'),
    status: requiredString(record, 'status'),
    statusPath: requiredString(record, 'statusPath'),
    eventsPath: requiredString(record, 'eventsPath'),
    resultPath: requiredString(record, 'resultPath'),
  };
  if (
    metadata.statusPath !== expected ||
    metadata.eventsPath !== expected + '/events' ||
    metadata.resultPath !== expected + '/result'
  ) {
    throw new Error('Decksmith create response paths are invalid');
  }
  return metadata;
}

function parseStatus(value: unknown, expectedJobId: string): ReachDeckDecksmithStatus {
  const record = requireRecord(value, 'Decksmith status response');
  if (requiredString(record, 'jobId') !== expectedJobId || record.kind !== 'decksmith') {
    throw new Error('Decksmith status response identity is invalid');
  }
  if (typeof record.done !== 'boolean') throw new Error('Decksmith status done is required');
  const progress = parseProgress(record.progress);
  return {
    jobId: expectedJobId,
    kind: 'decksmith',
    status: requiredString(record, 'status'),
    ...(progress === undefined ? {} : { progress }),
    resultAvailable: record.resultAvailable === true,
    done: record.done,
    ...(typeof record.error === 'string' && record.error.length > 0 ? { error: record.error } : {}),
  };
}

function parseDurableResult(
  value: unknown,
  expectedJobId: string,
  moduleVersionId: string,
): ReachDeckDecksmithDurableResult {
  const response = requireRecord(value, 'Decksmith result response');
  if (requiredString(response, 'jobId') !== expectedJobId || response.kind !== 'decksmith') {
    throw new Error('Decksmith result response identity is invalid');
  }
  const result = requireRecord(response.result, 'Decksmith durable result');
  if (
    result.schemaVersion !== DECKSMITH_RESULT_SCHEMA_VERSION ||
    result.kind !== 'decksmith' ||
    result.capability !== REACH_DECK_DECKSMITH_CAPABILITY ||
    requiredString(result, 'jobId') !== expectedJobId ||
    typeof result.changed !== 'boolean'
  ) {
    throw new Error('Decksmith durable result contract is invalid');
  }
  const changed = result.changed;
  let document: ReachDeckDocument | undefined;
  if (changed) {
    document = parseReachDeckDocument(result.document);
    if (document.id !== moduleVersionId) {
      throw new Error('Decksmith document does not match the requested module version');
    }
  } else if (result.document !== undefined) {
    throw new Error('Decksmith unchanged result must not contain a document');
  }
  const runtimeRunId = optionalString(result, 'runtimeRunId');
  const runtimeArtifactId = optionalString(result, 'runtimeArtifactId');
  const runtimeApprovalId = optionalString(result, 'runtimeApprovalId');
  const outcome =
    result.outcome === undefined ? undefined : parseDecksmithOutcome(result.outcome, changed);
  return {
    schemaVersion: DECKSMITH_RESULT_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: expectedJobId,
    runId: requiredString(result, 'runId'),
    requestHash: requiredString(result, 'requestHash'),
    baseDocumentHash: requiredString(result, 'baseDocumentHash'),
    resultHash: requiredString(result, 'resultHash'),
    attempt: positiveInteger(result.attempt, 'attempt'),
    startedAt: timestamp(result.startedAt, 'startedAt'),
    completedAt: timestamp(result.completedAt, 'completedAt'),
    message: typeof result.message === 'string' ? result.message : '',
    ...(typeof result.assistantText === 'string' && result.assistantText.trim().length > 0
      ? { assistantText: result.assistantText }
      : {}),
    changed,
    ...(outcome === undefined ? {} : { outcome }),
    ...(document === undefined ? {} : { document }),
    ...(runtimeRunId === undefined ? {} : { runtimeRunId }),
    ...(runtimeArtifactId === undefined ? {} : { runtimeArtifactId }),
    ...(runtimeApprovalId === undefined ? {} : { runtimeApprovalId }),
  };
}

function parseDecksmithOutcome(value: unknown, changed: boolean): ReachDeckDecksmithOutcome {
  const outcome = requireRecord(value, 'Decksmith outcome');
  const mutationStatus = outcome.mutationStatus;
  if (
    outcome.schemaVersion !== REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION ||
    (mutationStatus !== 'none' && mutationStatus !== 'proposal' && mutationStatus !== 'partial') ||
    !Array.isArray(outcome.rejectedFontFamilies) ||
    outcome.rejectedFontFamilies.length > 16 ||
    !Number.isInteger(outcome.toolErrorCount) ||
    (outcome.toolErrorCount as number) < 0
  ) {
    throw new Error('Decksmith outcome contract is invalid');
  }
  const rejectedFontFamilies = outcome.rejectedFontFamilies.map((font) => {
    if (typeof font !== 'string' || font.trim().length === 0 || font.length > 256) {
      throw new Error('Decksmith rejected font family is invalid');
    }
    return font;
  });
  if (
    new Set(rejectedFontFamilies.map((font) => font.toLowerCase())).size !==
    rejectedFontFamilies.length
  ) {
    throw new Error('Decksmith rejected font families must be unique');
  }
  const toolErrorCount = outcome.toolErrorCount as number;
  const budget = parseDecksmithBudgetCompletion(outcome.completion, outcome.remainingTasks);
  if (
    (changed && mutationStatus === 'none') ||
    (!changed && mutationStatus !== 'none') ||
    (mutationStatus === 'proposal' &&
      (rejectedFontFamilies.length > 0 || toolErrorCount !== 0 || budget !== undefined)) ||
    (mutationStatus === 'partial' &&
      rejectedFontFamilies.length === 0 &&
      toolErrorCount === 0 &&
      budget === undefined)
  ) {
    throw new Error('Decksmith outcome status is inconsistent');
  }
  const suggestedActions = parseDecksmithSuggestedActions(outcome.suggestedActions);
  // 提问只在没有修改且不是额度收尾时成立；不合法时丢弃，不让整条结果不可用。
  const clarification =
    mutationStatus === 'none' && budget === undefined
      ? parseDecksmithClarification(outcome.clarification)
      : undefined;
  // 采用后媒体只随提案出现；不合法的条目丢弃，不让整条结果不可用。
  const afterApply = mutationStatus === 'none' ? [] : parseDecksmithAfterApply(outcome.afterApply);
  return {
    schemaVersion: REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION,
    mutationStatus,
    rejectedFontFamilies,
    toolErrorCount,
    ...(suggestedActions.length === 0 ? {} : { suggestedActions }),
    ...(budget === undefined ? {} : budget),
    ...(clarification === undefined ? {} : { clarification }),
    ...(afterApply.length === 0 ? {} : { afterApply }),
  };
}

/** 宽松解析采用后媒体意图：只保留合法动作、每页一条、最多 8 条。 */
function parseDecksmithAfterApply(value: unknown): ReachDeckDecksmithAfterApplyAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 8).flatMap((entry): ReachDeckDecksmithAfterApplyAction[] => {
    const record = readRecord(entry);
    const kind = record?.kind;
    const pageId = record?.pageId;
    if (
      (kind !== 'generate-page-audio' && kind !== 'regenerate-page-media') ||
      typeof pageId !== 'string' ||
      pageId.trim().length === 0 ||
      pageId.length > 256 ||
      seen.has(pageId)
    ) {
      return [];
    }
    seen.add(pageId);
    return [{ kind, pageId }];
  });
}

const DECKSMITH_CLARIFICATION_QUESTION_ID_PATTERN = /^dq_[a-f0-9]{32}$/;

/**
 * 结构化提问（WP7）：校验问题 id、问题与选项/候选的上限和 expect 搭配；缺省或不合法返回 undefined。
 * 问题与选项是模型生成内容，界面原样显示，不当作应用文案翻译。
 */
function parseDecksmithClarification(value: unknown): ReachDeckDecksmithClarification | undefined {
  const record = readRecord(value);
  if (record === undefined) return undefined;
  const text = (entry: unknown, maximum: number) =>
    typeof entry === 'string' && entry.trim().length > 0 && entry.length <= maximum
      ? entry
      : undefined;
  const questionId = record.questionId;
  const question = text(record.question, 300);
  const expect = record.expect;
  if (
    typeof questionId !== 'string' ||
    !DECKSMITH_CLARIFICATION_QUESTION_ID_PATTERN.test(questionId) ||
    question === undefined ||
    (expect !== 'choice' && expect !== 'select-element' && expect !== 'text') ||
    !Array.isArray(record.options) ||
    record.options.length > 5 ||
    !Array.isArray(record.candidates) ||
    record.candidates.length > 8
  ) {
    return undefined;
  }
  const options = record.options.map((option) => text(option, 60));
  if (options.some((option) => option === undefined)) return undefined;
  const candidates: ReachDeckDecksmithClarificationCandidate[] = [];
  for (const entry of record.candidates) {
    const candidate = readRecord(entry);
    const pageId = text(candidate?.pageId, 256);
    const elementId = text(candidate?.elementId, 256);
    const label = text(candidate?.label, 120);
    const pageRevision = candidate?.pageRevision;
    if (
      pageId === undefined ||
      elementId === undefined ||
      label === undefined ||
      typeof pageRevision !== 'number' ||
      !Number.isSafeInteger(pageRevision) ||
      pageRevision < 1
    ) {
      return undefined;
    }
    candidates.push({ pageId, pageRevision, elementId, label });
  }
  // 与服务端严格合同一致：选项与候选（页 + 元素）不得重复，否则整条提问丢弃（界面以它们作 key）。
  if (
    (expect === 'choice' && options.length < 2) ||
    (expect === 'select-element' && candidates.length === 0) ||
    new Set(options).size !== options.length ||
    new Set(candidates.map((candidate) => `${candidate.pageId}\n${candidate.elementId}`)).size !==
      candidates.length
  ) {
    return undefined;
  }
  return {
    questionId,
    question,
    options: options as string[],
    candidates,
    expect,
  };
}

/**
 * 提前收尾（WP4 额度收尾 / 轮数截断）：completion 与 remainingTasks 必须同时出现且合法；
 * 都缺省是旧结果或普通结局。只校验结构与固定文案键，不把服务端任务文本当作界面文案（界面只显示条数）。
 */
function parseDecksmithBudgetCompletion(
  completionValue: unknown,
  remainingTasksValue: unknown,
): { completion: ReachDeckDecksmithCompletion; remainingTasks: readonly string[] } | undefined {
  if (completionValue === undefined && remainingTasksValue === undefined) return undefined;
  const completion = requireRecord(completionValue, 'Decksmith outcome completion');
  const scope = completion.scope;
  const stepLimited =
    completion.state === 'step-limited' &&
    scope === undefined &&
    completion.messageKey === REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY;
  const budgetLimited =
    completion.state === 'budget-limited' &&
    (scope === 'run' || scope === 'daily') &&
    completion.messageKey === REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS[scope];
  if (
    (!stepLimited && !budgetLimited) ||
    !Array.isArray(remainingTasksValue) ||
    remainingTasksValue.length === 0 ||
    remainingTasksValue.length > 8 ||
    remainingTasksValue.some(
      (task) => typeof task !== 'string' || task.trim().length === 0 || task.length > 300,
    )
  ) {
    throw new Error('Decksmith outcome completion is invalid');
  }
  return {
    completion: stepLimited
      ? { state: 'step-limited', messageKey: REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY }
      : {
          state: 'budget-limited',
          scope: scope as ReachDeckDecksmithBudgetScope,
          messageKey:
            REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS[scope as ReachDeckDecksmithBudgetScope],
        },
    remainingTasks: [...(remainingTasksValue as string[])],
  };
}

/** Unknown or malformed suggestions are dropped: they are optional buttons, never content. */
function parseDecksmithSuggestedActions(value: unknown): ReachDeckDecksmithSuggestedAction[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entry): ReachDeckDecksmithSuggestedAction[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { kind, pageId } = entry as Record<string, unknown>;
    if (!(REACH_DECK_DECKSMITH_SUGGESTED_ACTION_KINDS as readonly unknown[]).includes(kind)) {
      return [];
    }
    if (typeof pageId !== 'string' || pageId.trim().length === 0 || pageId.length > 256) {
      return [];
    }
    return [{ kind: kind as ReachDeckDecksmithSuggestedActionKind, pageId }];
  });
}

function requireDecksmithCapability(value: unknown, label: string) {
  if (value !== REACH_DECK_DECKSMITH_CAPABILITY) {
    throw new Error(`${label} capability is invalid`);
  }
  return REACH_DECK_DECKSMITH_CAPABILITY;
}

function parseEnvelope(data: string, expectedJobId: string): DecksmithEventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new Error('Decksmith event data is not valid JSON');
  }
  const record = requireRecord(value, 'Decksmith event');
  if (
    record.schemaVersion !== 'reach-deck-decksmith-event/v1' ||
    requiredString(record, 'jobId') !== expectedJobId
  ) {
    throw new Error('Decksmith event identity is invalid');
  }
  const type = record.type;
  if (
    type !== 'text-delta' &&
    type !== 'tool-start' &&
    type !== 'tool-end' &&
    type !== 'attempt-reset' &&
    type !== 'result-ready' &&
    type !== 'error'
  ) {
    throw new Error('Decksmith event type is invalid');
  }
  return {
    jobId: expectedJobId,
    attempt: positiveInteger(record.attempt, 'attempt'),
    type,
    payload: requireRecord(record.payload, 'Decksmith event payload'),
  };
}

function parseProgressEvent(
  event: DecksmithEventEnvelope,
): ReachDeckDecksmithProgressEvent | undefined {
  switch (event.type) {
    case 'text-delta':
      return { type: event.type, delta: requiredString(event.payload, 'delta') };
    case 'tool-start':
      return {
        type: event.type,
        tool: requiredString(event.payload, 'tool'),
        label: requiredString(event.payload, 'label'),
      };
    case 'tool-end': {
      if (typeof event.payload.isError !== 'boolean') {
        throw new Error('Decksmith tool-end isError is required');
      }
      const summary = optionalString(event.payload, 'summary');
      return {
        type: event.type,
        tool: requiredString(event.payload, 'tool'),
        isError: event.payload.isError,
        ...(summary === undefined ? {} : { summary }),
      };
    }
    case 'attempt-reset': {
      const reason = optionalString(event.payload, 'reason');
      return {
        type: event.type,
        attempt: event.attempt,
        ...(reason === undefined ? {} : { reason }),
      };
    }
    case 'result-ready':
    case 'error':
      return undefined;
  }
}

interface ParsedSseFrame {
  id?: string;
  event?: string;
  data?: string;
  retryMs?: number;
}

class SseFrameParser {
  private buffer = '';
  private dataLines: string[] = [];
  private event: string | undefined;
  private id: string | undefined;
  private retryMs: number | undefined;
  private frameCharacters = 0;
  private firstLine = true;

  feed(chunk: string): ParsedSseFrame[] {
    if (chunk.includes('\0')) throw new Error('Decksmith SSE contains NUL');
    this.buffer += chunk;
    const frames: ParsedSseFrame[] = [];
    for (;;) {
      const newline = findNewline(this.buffer);
      if (newline === undefined) break;
      const line = this.buffer.slice(0, newline.index);
      this.buffer = this.buffer.slice(newline.index + newline.length);
      const frame = this.consumeLine(this.firstLine ? line.replace(/^\uFEFF/, '') : line);
      this.firstLine = false;
      if (frame !== undefined) frames.push(frame);
    }
    if (this.buffer.length + this.frameCharacters > MAX_SSE_FRAME_CHARACTERS) {
      throw new Error('Decksmith SSE frame exceeds the size limit');
    }
    return frames;
  }

  finish(): void {
    if (this.buffer.length + this.frameCharacters > MAX_SSE_FRAME_CHARACTERS) {
      throw new Error('Decksmith SSE frame exceeds the size limit');
    }
    // Do not dispatch an unterminated frame. A reconnect must resume after the
    // last complete event id when the transport ends in the middle of a frame.
  }

  private consumeLine(line: string): ParsedSseFrame | undefined {
    if (line.length === 0) {
      const frame = this.dispatch();
      this.dataLines = [];
      this.event = undefined;
      this.id = undefined;
      this.retryMs = undefined;
      this.frameCharacters = 0;
      return frame;
    }
    this.frameCharacters += line.length + 1;
    if (this.frameCharacters > MAX_SSE_FRAME_CHARACTERS) {
      throw new Error('Decksmith SSE frame exceeds the size limit');
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.event = value;
        break;
      case 'id':
        if (!REDIS_STREAM_ID_PATTERN.test(value)) {
          throw new Error('Decksmith SSE event id is invalid');
        }
        this.id = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          const retryMs = Number(value);
          if (Number.isSafeInteger(retryMs)) this.retryMs = retryMs;
        }
        break;
      default:
        break;
    }
    return undefined;
  }

  private dispatch(): ParsedSseFrame | undefined {
    const data = this.dataLines.length === 0 ? undefined : this.dataLines.join('\n');
    if (data === undefined && this.retryMs === undefined) return undefined;
    return {
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.event === undefined || this.event.length === 0 ? {} : { event: this.event }),
      ...(data === undefined ? {} : { data }),
      ...(this.retryMs === undefined ? {} : { retryMs: this.retryMs }),
    };
  }
}

async function* readServerSentEventFrames(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSseFrame> {
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();
  if (response.body === null) {
    for (const frame of parser.feed(await response.text())) yield frame;
    parser.finish();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw error;
        throw new RetryableDecksmithStreamError();
      }
      if (read.done) break;
      for (const frame of parser.feed(decoder.decode(read.value, { stream: true }))) yield frame;
    }
    for (const frame of parser.feed(decoder.decode())) yield frame;
    parser.finish();
  } finally {
    reader.releaseLock();
  }
}

function findNewline(value: string): { index: number; length: number } | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\n') return { index, length: 1 };
    if (character === '\r') {
      if (index === value.length - 1) return undefined;
      return { index, length: value[index + 1] === '\n' ? 2 : 1 };
    }
  }
  return undefined;
}

function generationPath(jobId: string): string {
  return '/api/generation/' + encodeURIComponent(nonblank(jobId, 'jobId'));
}

function normalizeClientPath(path: string): string {
  if (path.startsWith('/api/generation/')) return path.slice('/api'.length);
  if (path.startsWith('/workspace/')) return path;
  throw new Error('Decksmith API path is invalid');
}

function isExpiredCursorResponse(status: number, value: unknown): boolean {
  if (status !== 409) return false;
  const record = readRecord(value);
  return typeof record?.resultPath === 'string' && record.resultPath.startsWith('/api/generation/');
}

function terminalEventError(
  dependencies: DecksmithClientDependencies,
  payload: Record<string, unknown>,
): Error {
  const code = optionalString(payload, 'code');
  if (code === 'cancelled') return dependencies.apiError('Decksmith generation was cancelled', 409);
  return dependencies.apiError('Decksmith generation failed', 502);
}

function apiErrorFromResponse(
  dependencies: DecksmithClientDependencies,
  status: number,
  payload: unknown,
  fallback: string,
): Error {
  const record = readRecord(payload);
  return dependencies.apiError(
    optionalString(record, 'error') ?? `${fallback} with ${status}`,
    status,
  );
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isResultBearingTerminalStatus(status: ReachDeckDecksmithStatus): boolean {
  return (
    status.resultAvailable &&
    (status.status === 'completed' ||
      status.status === 'awaiting-approval' ||
      status.status === 'approved' ||
      status.status === 'applying' ||
      status.status === 'applied' ||
      status.status === 'apply-failed')
  );
}

function isHttpStatusError(error: unknown): error is Error & { status: number } {
  return (
    error instanceof Error && typeof (error as Error & { status?: unknown }).status === 'number'
  );
}

function compareStreamIds(left: string, right: string): number {
  const [leftTime, leftSequence] = left.split('-').map(BigInt);
  const [rightTime, rightSequence] = right.split('-').map(BigInt);
  if (leftTime! < rightTime!) return -1;
  if (leftTime! > rightTime!) return 1;
  if (leftSequence! < rightSequence!) return -1;
  if (leftSequence! > rightSequence!) return 1;
  return 0;
}

function validateOptionalEventId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!REDIS_STREAM_ID_PATTERN.test(value)) throw new Error('lastEventId is invalid');
  return value;
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function parseProgress(value: unknown): number | Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const record = readRecord(value);
  if (record !== undefined) return record;
  throw new Error('Decksmith status progress is invalid');
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Decksmith ${label} must be a positive integer`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`Decksmith ${label} must be an ISO timestamp`);
  }
  return value;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value, key);
  if (result === undefined) throw new Error(`Decksmith ${key} is required`);
  return result;
}

function optionalString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const result = readRecord(value);
  if (result === undefined) throw new Error(`${label} must be an object`);
  return result;
}

function requireExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} shape is invalid`);
  }
  return record;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonblank(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be nonblank`);
  }
  return value.trim();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException('The operation was aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

class RetryableDecksmithStreamError extends Error {}

export function createDecksmithIdempotencyKey(): string {
  return createReachDeckUuid();
}

export async function sleepForDecksmith(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const complete = (): void => {
      cleanup();
      resolve();
    };
    const abort = (): void => {
      cleanup();
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    timeout = setTimeout(complete, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Builds the exact ref snapshots accepted by Decksmith v2. The authoritative server validates every
 * field again against the materialized baseline, so stale or forged browser data still fails closed.
 */
export async function buildReachDeckDecksmithContextRefs(
  documentValue: ReachDeckDocument,
  originPageId: string,
  selection: ReachDeckDecksmithContextSelection,
): Promise<readonly ReachDeckDecksmithContextRef[]> {
  const document = parseReachDeckDocument(documentValue);
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error('Decksmith structured context requires a v2 document');
  }
  const origin = requireDocumentPage(document, originPageId);
  const documentHash = await stableSha256(stripVolatileReachDeckMediaUrls(document));
  const refs: ReachDeckDecksmithContextRef[] = [];
  const pageIds = [
    ...(selection.includeCurrentPage ? [originPageId] : []),
    ...(selection.mentionedPageIds ?? []),
  ];
  for (const pageId of new Set(pageIds)) {
    const page = requireDocumentPage(document, pageId);
    refs.push({
      schemaVersion: 'reach-deck-decksmith-context-ref/v1',
      kind: 'page',
      pageId,
      label: page.title,
      order: document.pages.findIndex((candidate) => candidate.pageId === pageId) + 1,
      revision: page.revision,
      baseline: { documentId: document.id, documentHash },
    });
  }

  if (origin.sceneType === 'slide') {
    const binding = document.nativeSlides.find((candidate) => candidate.pageId === originPageId);
    for (const componentId of new Set(selection.selectedNativeElementIds ?? [])) {
      const component =
        binding === undefined ? undefined : findObjectById(binding.slide, componentId);
      if (component === undefined || typeof component.type !== 'string') {
        throw new Error('Decksmith selected slide component is stale');
      }
      refs.push(
        await componentRef(document, origin, documentHash, {
          kind: 'native-element',
          componentId,
          componentType: component.type,
          component,
          label: componentLabel(component, componentId),
        }),
      );
    }
  }

  const seenMentionedElements = new Set<string>();
  for (const mentioned of selection.mentionedNativeElements ?? []) {
    const key = `${mentioned.pageId}#${mentioned.elementId}`;
    // 来源页上的元素由 selectedNativeElementIds 表达；重复条目只发一次。
    if (
      seenMentionedElements.has(key) ||
      (mentioned.pageId === originPageId &&
        (selection.selectedNativeElementIds ?? []).includes(mentioned.elementId))
    ) {
      continue;
    }
    seenMentionedElements.add(key);
    const page = requireDocumentPage(document, mentioned.pageId);
    const binding =
      page.sceneType === 'slide'
        ? document.nativeSlides.find((candidate) => candidate.pageId === page.pageId)
        : undefined;
    const component =
      binding === undefined ? undefined : findObjectById(binding.slide, mentioned.elementId);
    if (component === undefined || typeof component.type !== 'string') {
      throw new Error('Decksmith mentioned slide component is stale');
    }
    refs.push(
      await componentRef(document, page, documentHash, {
        kind: 'native-element',
        componentId: mentioned.elementId,
        componentType: component.type,
        component,
        label: componentLabel(component, mentioned.elementId),
      }),
    );
  }

  const interactive = selection.interactiveComponent;
  if (interactive !== undefined) {
    const page = requireDocumentPage(document, interactive.pageId);
    if (page.sceneType !== 'interactive') {
      throw new Error('Decksmith Interactive component is attached to a non-Interactive page');
    }
    const component = readMarkedInteractiveComponent(
      page.scene.documentHtml,
      interactive.componentId,
    );
    if (component === undefined || typeof component.type !== 'string') {
      throw new Error('Decksmith Interactive component is stale');
    }
    refs.push(
      await componentRef(document, page, documentHash, {
        kind: 'interactive-component',
        componentId: interactive.componentId,
        componentType: component.type,
        component,
        label: nonblank(interactive.label, 'Interactive component label'),
        ...(interactive.detail === undefined ? {} : { detail: interactive.detail }),
      }),
    );
  }
  return refs;
}

export function parseReachDeckDecksmithPageHistory(
  value: unknown,
  expectedPageId: string,
): ReachDeckDecksmithPageHistory {
  const response = requireRecord(value, 'Decksmith page history response');
  const stream = requireRecord(response.stream, 'Decksmith page stream');
  const domainScope = requireRecord(stream.domainScope, 'Decksmith page stream scope');
  const pageId = requiredString(domainScope, 'pageId');
  if (pageId !== expectedPageId) throw new Error('Decksmith page history scope is invalid');
  const context = requireRecord(stream.context, 'Decksmith page stream context');
  const epoch = requireRecord(context.currentEpoch, 'Decksmith current epoch');
  const history = requireRecord(response.history, 'Decksmith page history');
  const items = history.items;
  if (!Array.isArray(items)) throw new Error('Decksmith page history items must be an array');
  const entries = items.map(parseHistoryEntry);
  const nextCursor = parseHistoryCursor(history.nextCursor);
  return {
    pageId,
    threadId: requiredString(stream, 'threadId'),
    entries,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    streamSequence: nonnegativeInteger(context.streamSequence, 'streamSequence'),
    currentEpoch: positiveInteger(epoch.epoch, 'currentEpoch'),
    contextRevision: nonnegativeInteger(context.contextRevision, 'contextRevision'),
  };
}

export function parseReachDeckDecksmithControlResult(
  value: unknown,
  expectedPageId: string,
): ReachDeckDecksmithControlResult {
  const result = requireRecord(value, 'Decksmith control response');
  const boundary = requireRecord(result.boundary, 'Decksmith control boundary');
  const stream = requireRecord(boundary.stream, 'Decksmith control stream');
  if (requiredString(stream, 'pageId') !== expectedPageId) {
    throw new Error('Decksmith control page identity is invalid');
  }
  if (typeof result.created !== 'boolean') throw new Error('Decksmith control created is required');
  return {
    runId: requiredString(result, 'runId'),
    created: result.created,
    pageId: expectedPageId,
    sequence: nonnegativeInteger(stream.sequence, 'sequence'),
    currentEpoch: positiveInteger(stream.epoch, 'epoch'),
    contextRevision: nonnegativeInteger(stream.contextRevision, 'contextRevision'),
  };
}

function parseHistoryEntry(value: unknown): ReachDeckDecksmithHistoryEntry {
  const item = requireRecord(value, 'Decksmith page history item');
  const runId = requiredString(item, 'runId');
  const status = requiredString(item, 'status');
  const queuedAt = timestamp(item.queuedAt, 'history queuedAt');
  const input = requireRecord(item.input, 'Decksmith page history input');
  if (input.kind === 'decksmith-turn') {
    const stream = requireRecord(input.stream, 'Decksmith turn stream');
    const contextRefsValue = input.contextRefs;
    if (!Array.isArray(contextRefsValue)) throw new Error('Decksmith contextRefs must be an array');
    const contextRefs = contextRefsValue.map(parsePublicHistoryContextRef);
    const events = item.events;
    if (!Array.isArray(events)) throw new Error('Decksmith history events must be an array');
    const messages = parseHistoryTurnMessages(events);
    const assistantText = [...messages].reverse().find((message) => message.kind === 'assistant');
    return {
      kind: 'turn',
      runId,
      status,
      queuedAt,
      sequence: nonnegativeInteger(stream.sequence, 'sequence'),
      epoch: positiveInteger(stream.epoch, 'epoch'),
      teacherText: requiredString(input, 'message'),
      contextRefs,
      messages,
      ...(assistantText === undefined ? {} : { assistantText: assistantText.text }),
    };
  }
  if (input.kind === 'decksmith-control') {
    const control = requireRecord(input.control, 'Decksmith control');
    if (control.kind !== 'new-topic') {
      throw new Error('Soft-deleted Decksmith controls must not be visible in history');
    }
    const stream = requireRecord(control.stream, 'Decksmith control stream');
    const message = requireRecord(control.message, 'Decksmith boundary message');
    const replacementsValue = requireRecord(message.replacements, 'Decksmith message replacements');
    const replacements: Record<string, string> = {};
    for (const [key, replacement] of Object.entries(replacementsValue)) {
      if (typeof replacement !== 'string') throw new Error('Decksmith replacement is invalid');
      replacements[key] = replacement;
    }
    return {
      kind: 'new-topic',
      runId,
      status,
      queuedAt,
      sequence: nonnegativeInteger(stream.sequence, 'sequence'),
      previousEpoch: positiveInteger(control.previousEpoch, 'previousEpoch'),
      nextEpoch: positiveInteger(control.nextEpoch, 'nextEpoch'),
      messageKey: requiredString(message, 'messageKey'),
      replacements,
    };
  }
  throw new Error('Decksmith page history input kind is invalid');
}

function parseHistoryTurnMessages(
  events: readonly unknown[],
): readonly ReachDeckDecksmithTurnMessage[] {
  let lastAssistantIndex = -1;
  for (const [eventIndex, value] of events.entries()) {
    const event = readRecord(value);
    if (
      event?.type === 'decksmith.result' &&
      optionalString(readRecord(event.payload), 'message')
    ) {
      lastAssistantIndex = eventIndex;
    }
  }

  const applicationIdentities = new Set<string>();
  return events.flatMap<ReachDeckDecksmithTurnMessage>((value, eventIndex) => {
    const event = readRecord(value);
    if (event === undefined) return [];
    if (event.type === 'decksmith.result') {
      if (eventIndex !== lastAssistantIndex) return [];
      const payload = readRecord(event.payload);
      const message = optionalString(payload, 'message');
      if (message === undefined) return [];
      const outcome = parseHistoryDecksmithOutcome(payload);
      const reply = optionalString(payload, 'assistantText');
      return [
        {
          kind: 'assistant',
          text: message,
          ...(outcome === undefined ? {} : { outcome }),
          ...(reply === undefined || reply.trim().length === 0 ? {} : { reply }),
        },
      ];
    }
    if (event.type !== 'decksmith.application-message') return [];
    try {
      const message = parseReachDeckDecksmithApplicationMessage(event.payload);
      const identity = decksmithApplicationMessageIdentity(message);
      if (applicationIdentities.has(identity)) return [];
      applicationIdentities.add(identity);
      return [{ kind: 'application-message', identity, message }];
    } catch {
      // A malformed or future application message must not make the teacher's page history
      // unavailable. Ignore it rather than displaying server-controlled text or metadata.
      return [];
    }
  });
}

function parseHistoryDecksmithOutcome(
  payload: Record<string, unknown> | undefined,
): ReachDeckDecksmithOutcome | undefined {
  if (payload?.outcome !== undefined) {
    try {
      const record = requireRecord(payload.outcome, 'Decksmith history outcome');
      return parseDecksmithOutcome(record, record.mutationStatus !== 'none');
    } catch {
      // Fall through to the legacy changed flag rather than exposing application-owned copy.
    }
  }
  if (typeof payload?.changed !== 'boolean') return undefined;
  return {
    schemaVersion: REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION,
    mutationStatus: payload.changed ? 'proposal' : 'none',
    rejectedFontFamilies: [],
    toolErrorCount: 0,
  };
}

function decksmithApplicationMessageIdentity(
  message: ReachDeckDecksmithApplicationMessage,
): string {
  return [
    message.kind,
    message.state,
    message.messageKey,
    message.guidance?.action ?? 'no-action',
    message.guidance?.messageKey ?? 'no-guidance',
  ].join(':');
}

export function parseReachDeckDecksmithApplicationMessage(
  value: unknown,
): ReachDeckDecksmithApplicationMessage {
  const message = requireExactRecord(
    value,
    ['schemaVersion', 'kind', 'state', 'messageKey'],
    ['guidance'],
    'Decksmith application message',
  );
  const state = message.state;
  const messageKeys = {
    ordinary: 'reachDeck.decksmith.capacity.ordinary',
    approaching: 'reachDeck.decksmith.capacity.approaching',
    needs_compaction: 'reachDeck.decksmith.capacity.compacting',
    blocked: 'reachDeck.decksmith.capacity.blocked',
  } as const;
  if (
    message.schemaVersion !== 'reach-deck-decksmith-application-message/v1' ||
    message.kind !== 'capacity' ||
    (state !== 'ordinary' &&
      state !== 'approaching' &&
      state !== 'needs_compaction' &&
      state !== 'blocked') ||
    message.messageKey !== messageKeys[state]
  ) {
    throw new Error('Decksmith application message is unsupported');
  }
  let guidance: ReachDeckDecksmithApplicationMessage['guidance'];
  if (message.guidance !== undefined) {
    const parsed = requireExactRecord(
      message.guidance,
      ['action', 'messageKey'],
      [],
      'Decksmith application guidance',
    );
    if (
      (state !== 'needs_compaction' && state !== 'blocked') ||
      parsed.action !== 'new-topic' ||
      parsed.messageKey !== 'reachDeck.decksmith.capacity.startNewTopic'
    ) {
      throw new Error('Decksmith application guidance is unsupported');
    }
    guidance = {
      action: 'new-topic',
      messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
    };
  }
  if (state === 'blocked' && guidance === undefined) {
    throw new Error('Decksmith blocked application guidance is required');
  }
  return {
    schemaVersion: 'reach-deck-decksmith-application-message/v1',
    kind: 'capacity',
    state,
    messageKey: messageKeys[state],
    ...(guidance === undefined ? {} : { guidance }),
  };
}

function parseHistoryCursor(value: unknown): ReachDeckDecksmithHistoryCursor | undefined {
  if (value === undefined) return undefined;
  const cursor = requireRecord(value, 'Decksmith history cursor');
  const queuedAt = requiredString(cursor, 'queuedAt');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(queuedAt)) {
    throw new Error('Decksmith history cursor timestamp is invalid');
  }
  return { queuedAt, runId: requiredString(cursor, 'runId') };
}

function parsePublicHistoryContextRef(value: unknown): ReachDeckDecksmithPublicContextRef {
  const ref = requireRecord(value, 'Decksmith context ref');
  const common = {
    schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
    pageId: requiredString(ref, 'pageId'),
  };
  if (ref.schemaVersion !== common.schemaVersion)
    throw new Error('Decksmith context ref is invalid');
  if (ref.kind === 'page') {
    return {
      ...common,
      kind: 'page',
      label: requiredString(ref, 'label'),
      order: positiveInteger(ref.order, 'order'),
      revision: positiveInteger(ref.revision, 'revision'),
    };
  }
  if (ref.kind !== 'native-element' && ref.kind !== 'interactive-component') {
    throw new Error('Decksmith component ref kind is invalid');
  }
  const display = requireRecord(ref.display, 'Decksmith component display');
  const detail = optionalString(display, 'detail');
  if (ref.sceneType !== 'slide' && ref.sceneType !== 'interactive') {
    throw new Error('Decksmith component scene type is invalid');
  }
  return {
    ...common,
    kind: ref.kind,
    pageLabel: requiredString(ref, 'pageLabel'),
    pageOrder: positiveInteger(ref.pageOrder, 'pageOrder'),
    pageRevision: positiveInteger(ref.pageRevision, 'pageRevision'),
    sceneId: requiredString(ref, 'sceneId'),
    sceneType: ref.sceneType,
    componentId: requiredString(ref, 'componentId'),
    componentType: requiredString(ref, 'componentType'),
    display: {
      label: requiredString(display, 'label'),
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

async function componentRef(
  document: ReachDeckDocumentV2,
  page: ReachDeckDocumentV2['pages'][number],
  documentHash: string,
  input: {
    kind: 'native-element' | 'interactive-component';
    componentId: string;
    componentType: string;
    component: Record<string, unknown>;
    label: string;
    detail?: string;
  },
): Promise<ReachDeckDecksmithComponentRef> {
  if (page.sceneType !== 'slide' && page.sceneType !== 'interactive') {
    throw new Error('Decksmith component focus is unsupported for this page type');
  }
  return {
    schemaVersion: 'reach-deck-decksmith-context-ref/v1',
    kind: input.kind,
    pageId: page.pageId,
    pageLabel: page.title,
    pageOrder: document.pages.findIndex((candidate) => candidate.pageId === page.pageId) + 1,
    pageRevision: page.revision,
    sceneId: page.sceneType === 'slide' ? page.pageId : page.scene.id,
    sceneType: page.sceneType,
    componentId: input.componentId,
    componentType: input.componentType,
    display: {
      label: input.label,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
    baseline: {
      documentId: document.id,
      documentHash,
      pageRevision: page.revision,
      componentHash: await stableSha256(input.component),
    },
  };
}

function requireDocumentPage(document: ReachDeckDocumentV2, pageId: string) {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) throw new Error('Decksmith referenced page is missing');
  return page;
}

function findObjectById(value: unknown, id: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findObjectById(child, id);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.id === id) return record;
  for (const child of Object.values(record)) {
    const found = findObjectById(child, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function componentLabel(component: Record<string, unknown>, fallback: string): string {
  for (const key of ['name', 'label', 'title', 'type']) {
    if (typeof component[key] === 'string' && component[key].trim().length > 0) {
      return component[key].trim();
    }
  }
  return fallback;
}

function readMarkedInteractiveComponent(
  documentHtml: string,
  componentId: string,
): Record<string, unknown> | undefined {
  if (typeof DOMParser === 'undefined') {
    throw new Error('Interactive component focus requires a DOM parser');
  }
  const parsed = new DOMParser().parseFromString(documentHtml, 'text/html');
  const matches = [...parsed.querySelectorAll('[data-reach-component-id]')].filter(
    (element) => element.getAttribute('data-reach-component-id') === componentId,
  );
  if (matches.length !== 1) return undefined;
  const element = matches[0]!;
  return { id: componentId, type: element.localName, html: element.outerHTML };
}

async function stableSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableSerialize(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableSerialize(record[key]))
      .join(',') +
    '}'
  );
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Decksmith ${label} must be a nonnegative integer`);
  }
  return value as number;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Decksmith ${label} must be a SHA-256 digest`);
  }
  return value;
}
