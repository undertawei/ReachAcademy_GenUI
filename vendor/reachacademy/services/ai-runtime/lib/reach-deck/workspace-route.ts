import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import {
  reachDeckJobResponseMetadata,
  type ReachDeckJobResponseMetadata,
} from './job-response-metadata.js';
import {
  ReachDeckPageGenerationContextError,
  ReachDeckPageNotTerminalError,
} from '@reachany/reach-deck-dsl';

import type {
  ReachDeckStagedGenerationJobKind,
  ReachDeckStagedGenerationJobPayload,
  ReachDeckStagedGenerationResult,
} from './contracts.js';
import { ReachDeckAuthorizationError, authorizeScopedReachDeckRequest } from './auth.js';
import type { ReachDeckApiRole } from './auth.js';
import { ContentServiceClientError } from './content-service-client.js';
import { ReachDeckRevisionConflictError } from './deck-store.js';
import { ReachDeckGenerationAuditStateError } from './generation-audit.js';
import { ReachDeckPptxUploadError } from './pptx-import.js';
import {
  DecksmithDeckLeaseConflictError,
  DecksmithDeckLockTimeoutError,
  DecksmithDeckWriterConflictError,
} from './decksmith/page-stream.js';
import { DecksmithContextValidationError } from './decksmith/execution-context.js';
import {
  enqueueReachDeckGenerationJob,
  readReachDeckGenerationJob,
  type ReachDeckGenerationJobScope,
} from './queue.js';
import { isReachDeckJobId, parsePageId } from './validation.js';
import {
  ReachDeckWorkspaceRevisionConflictError,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import {
  ReachDeckDecksmithIdempotencyConflictError,
  ReachDeckNarrationAdmissionReadError,
  ReachDeckStructuralJobCleanupPendingError,
  fenceReachDeckWorkspaceBatchesForStructuralMutation,
  pruneReachDeckWorkspaceAppliedPageJobs,
  pruneReachDeckWorkspacePageJobs,
  readReachDeckGenerationResultWithRecovery,
  registerReachDeckWorkspaceJob,
} from './workspace-recovery.js';
import { ReachDeckHarnessModeDisabledError, requireReachDeckHarnessMode } from './harness-mode.js';
import {
  parseReachDeckPromptSnippetOverrides,
  ReachDeckPromptOverrideError,
} from './prompts/index.js';
import type { ReachDeckResourceScope } from './resource-scope.js';
import {
  ReachDeckWorkspaceBatchCapacityError,
  ReachDeckWorkspaceBatchPageInProgressError,
} from './workspace-batches.js';
import { ReachDeckOutlineInputTextError } from './structured-text-safety.js';
import { ReachDeckMaterialAdmissionError } from './material-admission.js';
import { MaterialPreparationError } from './prepared-material-store.js';

export interface AuthorizedWorkspaceRouteContext {
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
  workspaceContext: ReachDeckWorkspaceContext;
  jobScope: ReachDeckGenerationJobScope;
}

export class ReachDeckWorkspaceRouteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ReachDeckWorkspaceRouteError';
  }
}

/** 页被生成流程或 Decksmith 运行期锁定,拒绝内容写入。 */
export class ReachDeckPageLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReachDeckPageLockedError';
  }
}

export async function authorizeWorkspaceRoute(
  request: Request,
  allowedRoles: readonly ReachDeckApiRole[] = ['teacher', 'admin'],
): Promise<AuthorizedWorkspaceRouteContext> {
  const scoped = await authorizeScopedReachDeckRequest(request.headers, allowedRoles);
  const actorId = scoped.actorId;
  return {
    actorId,
    actorOrganizationId: scoped.actorOrganizationId,
    billingGroupId: scoped.billingGroupId,
    roleGrantId: scoped.roleGrantId,
    resourceScope: scoped.resourceScope,
    workspaceContext: {
      actorId,
      actorOrganizationId: scoped.actorOrganizationId,
      billingGroupId: scoped.billingGroupId,
      roleGrantId: scoped.roleGrantId,
      resourceScope: scoped.resourceScope,
    },
    jobScope: {
      actorId,
      actorOrganizationId: scoped.actorOrganizationId,
      billingGroupId: scoped.billingGroupId,
      roleGrantId: scoped.roleGrantId,
      resourceScope: scoped.resourceScope,
    },
  };
}

export async function readWorkspaceBody(
  request: Request,
  required: readonly string[],
  optional: readonly string[] = [],
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('Request body must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw badRequest('Request body contains missing or unsupported fields');
  }
  return record;
}

export function readExpectedDraftRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest('expectedDraftRevision must be a nonnegative integer');
  }
  return value;
}

/** The page request attempt the client acted on; absent from older clients. */
export function readOptionalExpectedPageAttempt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw badRequest('expectedPageAttempt must be a positive integer');
  }
  return value;
}

export function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${label} must be nonblank`);
  }
  return value.trim();
}

export function readOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : readRequiredString(value, label);
}

export function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`${label} must be a boolean`);
  return value;
}

export function readOptionalTimestamp(value: unknown, label: string): string | undefined {
  const timestamp = readOptionalString(value, label);
  if (timestamp !== undefined && Number.isNaN(Date.parse(timestamp))) {
    throw badRequest(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

export function readOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw badRequest(`${label} must be an array of nonblank strings`);
  }
  const result = value.map((item) => (item as string).trim());
  if (new Set(result).size !== result.length)
    throw badRequest(`${label} must not contain duplicates`);
  return result;
}

export function readJobId(value: unknown): string {
  const jobId = readRequiredString(value, 'jobId');
  if (!isReachDeckJobId(jobId)) throw badRequest('jobId is invalid');
  return jobId;
}

export function readRoutePageId(value: string): string {
  try {
    return parsePageId(value);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'pageId is invalid');
  }
}

export async function enqueueWorkspaceJob(
  payload: ReachDeckStagedGenerationJobPayload,
  scope: ReachDeckGenerationJobScope,
  options: WorkspaceJobEnqueueOptions = {},
): Promise<Response> {
  return Response.json(await enqueueWorkspaceJobMetadata(payload, scope, options), { status: 202 });
}

export interface WorkspaceJobMetadata extends ReachDeckJobResponseMetadata {
  jobId: string;
  kind: ReachDeckStagedGenerationJobKind;
  runId: string;
  status: string;
  pollPath: string;
  eventsPath: string;
  pollIntervalMs: number;
  pageId?: string;
  requestedRevision?: number;
  chainId?: string;
  /** Recovery descriptor registration time used for deterministic same-page selection. */
  queuedAt?: string;
}

export interface WorkspaceJobEnqueueOptions {
  /** Runs only after the exact durable recovery descriptor exists, before queue dispatch. */
  afterRegistration?: () => Promise<void>;
}

export async function enqueueWorkspaceJobMetadata(
  payload: ReachDeckStagedGenerationJobPayload,
  scope: ReachDeckGenerationJobScope,
  options: WorkspaceJobEnqueueOptions = {},
): Promise<WorkspaceJobMetadata> {
  const registered = await registerReachDeckWorkspaceJob(payload);
  const queuedAt = registered?.recovery.jobs[payload.jobId]?.queuedAt;
  await options.afterRegistration?.();
  await enqueueReachDeckGenerationJob(payload);
  let status = 'waiting';
  try {
    status = (await readReachDeckGenerationJob(payload.jobId, scope))?.status ?? status;
  } catch {
    // Queue.add succeeded. Polling is advisory, so retain deterministic
    // discovery metadata and let the client poll the job normally.
  }
  return {
    jobId: payload.jobId,
    ...reachDeckJobResponseMetadata(payload),
    kind: payload.kind,
    runId: payload.runId,
    status,
    pollPath: `/api/generation/${encodeURIComponent(payload.jobId)}`,
    eventsPath: `/api/generation/${encodeURIComponent(payload.jobId)}/events`,
    pollIntervalMs: 2_000,
    ...('pageId' in payload.request ? { pageId: payload.request.pageId } : {}),
    ...('requestedRevision' in payload.request
      ? { requestedRevision: payload.request.requestedRevision }
      : {}),
    ...('sourceKind' in payload.request && payload.request.sourceKind === 'materialized-native'
      ? payload.request.chainId === undefined
        ? {}
        : { chainId: payload.request.chainId }
      : {}),
    ...(queuedAt === undefined ? {} : { queuedAt }),
  };
}

export async function readCompletedWorkspaceJob(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
  expectedKinds: readonly ReachDeckStagedGenerationJobKind[],
): Promise<ReachDeckStagedGenerationResult> {
  const recovered = await readReachDeckGenerationResultWithRecovery(jobId, scope);
  if (recovered !== null) {
    if (!expectedKinds.includes(recovered.kind)) {
      throw badRequest('Reach Deck generation job kind does not match this apply route');
    }
    return recovered;
  }
  const view = await readReachDeckGenerationJob(jobId, scope);
  if (view === null) throw notFound('Reach Deck generation job not found');
  if (view.kind === undefined || view.kind === 'decksmith' || !expectedKinds.includes(view.kind)) {
    throw badRequest('Reach Deck generation job kind does not match this apply route');
  }
  throw conflict(`Reach Deck generation job cannot be applied while ${view.status}`);
}

/**
 * 规划阶段回退/大纲替换成功后清理当前 run 的页面级 recovery 描述符和批次派发意图。
 * The legacy name remains for route compatibility, but failure is deliberately surfaced: callers
 * must not report a completed rewind/adoption while durable dispatch cleanup is still uncertain.
 */
export async function prunePageJobsBestEffort(
  workspaceContext: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  runId: string,
): Promise<void> {
  await pruneReachDeckWorkspacePageJobs(workspaceContext, scope, runId);
}

/** 只改页面内容的保存：不停批次、不动在途任务，只回收已落地的独立任务。 */
export async function pruneAppliedPageJobsAfterContentSave(
  workspaceContext: ReachDeckWorkspaceContext,
  runId: string,
): Promise<void> {
  await pruneReachDeckWorkspaceAppliedPageJobs(workspaceContext, runId);
}

export async function fencePageJobsBeforeStructuralMutation(
  workspaceContext: ReachDeckWorkspaceContext,
  runId: string,
  unchangedPageIds?: readonly string[],
  survivingImagePageIds?: readonly string[],
): Promise<void> {
  await fenceReachDeckWorkspaceBatchesForStructuralMutation(
    workspaceContext,
    runId,
    unchangedPageIds,
    ...(survivingImagePageIds === undefined ? [] : [survivingImagePageIds]),
  );
}

export function workspaceRouteError(error: unknown): Response {
  const response = buildWorkspaceRouteErrorResponse(error);
  // 4xx 多是可预期冲突，但「既没报错也没保存」的故障恰恰只在这些分支里发生过：
  // 校验失败包成 400、CAS 冲突包成 409，此前都直接返回、不留任何痕迹，事后只能翻库还原。
  // 降噪到 warn，但必须留痕；只记错误类型与状态，不记请求体。
  if (response.status >= 400 && response.status < 500) {
    console.warn('Reach Deck workspace request rejected', {
      status: response.status,
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown workspace route rejection',
    });
  }
  return response;
}

function buildWorkspaceRouteErrorResponse(error: unknown): Response {
  if (error instanceof ReachDeckNarrationAdmissionReadError) {
    return Response.json(
      { error: error.message, code: error.code, retryable: true },
      { status: 409 },
    );
  }
  if (
    error instanceof ReachDeckMaterialAdmissionError ||
    error instanceof MaterialPreparationError
  ) {
    return Response.json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }
  const guardrail = guardrailCode(error);
  if (guardrail)
    return Response.json(
      { error: guardrail, code: guardrail },
      { status: guardrail === 'GUARDRAIL_BLOCKED' ? 422 : 503 },
    );
  if (error instanceof ReachDeckAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  // 调试入口被关闭，或者覆盖本身不合法：都是调用方可自行纠正的请求问题。
  if (
    error instanceof ReachDeckHarnessModeDisabledError ||
    error instanceof ReachDeckPromptOverrideError
  ) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ReachDeckWorkspaceRouteError) {
    return Response.json(
      {
        error: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      { status: error.status },
    );
  }
  if (error instanceof ReachDeckOutlineInputTextError) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        path: error.path,
        details: { path: error.path },
        repairable: true,
      },
      { status: 422 },
    );
  }
  if (
    error instanceof ReachDeckStructuralJobCleanupPendingError ||
    hasStructuralJobCleanupPendingName(error)
  ) {
    return Response.json(
      {
        error: 'Reach Deck structural generation cleanup is still pending',
        code: 'STRUCTURAL_CLEANUP_PENDING',
      },
      { status: 409 },
    );
  }
  if (
    error instanceof ReachDeckWorkspaceBatchCapacityError ||
    error instanceof ReachDeckWorkspaceBatchPageInProgressError
  ) {
    return Response.json({ error: error.message, code: error.code }, { status: 409 });
  }
  if (error instanceof ReachDeckPageLockedError) {
    return Response.json({ error: error.message }, { status: 423 });
  }
  // Next.js can load the same route module through different bundler graphs, so an
  // error crossing a route/worker boundary may have the right semantic name but a
  // different prototype. Keep the typed checks and add a name fallback so lease
  // conflicts remain the documented, retryable 409 contract instead of leaking 500.
  if (
    error instanceof DecksmithDeckLeaseConflictError ||
    error instanceof DecksmithDeckWriterConflictError ||
    hasDecksmithLeaseConflictName(error)
  ) {
    return Response.json(
      {
        error: decksmithLeaseConflictMessage(error),
        code: 'DECKSMITH_DECK_LEASE_ACTIVE',
      },
      { status: 409 },
    );
  }
  // deck 锁在有界等待内没拿到：没有人占着这份 deck 与调用方冲突，原样重试即可，不是服务端故障。
  if (
    error instanceof DecksmithDeckLockTimeoutError ||
    hasErrorName(error, 'DecksmithDeckLockTimeoutError')
  ) {
    return Response.json(
      { error: 'Reach Deck is busy, please retry', code: 'DECKSMITH_DECK_LOCK_BUSY' },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }
  if (error instanceof DecksmithContextValidationError) {
    return Response.json(
      { error: error.message, code: error.code, repairable: true },
      { status: 409 },
    );
  }
  if (error instanceof ReachDeckDecksmithIdempotencyConflictError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ReachDeckPageNotTerminalError) {
    // 首轮生成期间点「重新生成」必然撞上的并发状态冲突，不是服务端故障。
    return Response.json(
      { error: error.message, code: error.code, pageId: error.pageId },
      { status: 409 },
    );
  }
  if (
    (error instanceof ReachDeckPageGenerationContextError ||
      hasErrorName(error, 'ReachDeckPageGenerationContextError')) &&
    typeof (error as { code?: unknown }).code === 'string' &&
    [
      'PAGE_GENERATION_CONTEXT_REQUIRED',
      'PAGE_GENERATION_OUTLINE_MISMATCH',
      'PAGE_GENERATION_PAUSED',
    ].includes((error as { code: string }).code)
  ) {
    return Response.json(
      { error: 'Page generation context is unavailable', code: (error as { code: string }).code },
      { status: 409 },
    );
  }
  if (error instanceof ReachDeckGenerationAuditStateError) {
    return Response.json(
      {
        error: error.message,
        jobId: error.jobId,
        status: error.status,
        executionAttempt: error.executionAttempt,
      },
      { status: 409 },
    );
  }
  if (
    error instanceof ReachDeckWorkspaceRevisionConflictError ||
    error instanceof ReachDeckRevisionConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ContentServiceClientError) {
    if (
      error.status === 400 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409 ||
      error.status === 422
    ) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error('Reach Deck content-service request failed', {
      status: error.status,
      message: error.message,
    });
    return Response.json({ error: 'Reach Deck content service is unavailable' }, { status: 500 });
  }
  console.error('Reach Deck workspace request failed', {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : 'Unknown workspace route failure',
  });
  return Response.json({ error: 'Reach Deck request failed' }, { status: 500 });
}

function hasStructuralJobCleanupPendingName(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'ReachDeckStructuralJobCleanupPendingError'
  );
}

function hasErrorName(error: unknown, name: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === name
  );
}

function hasDecksmithLeaseConflictName(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    ((error as { name?: unknown }).name === 'DecksmithDeckLeaseConflictError' ||
      (error as { name?: unknown }).name === 'DecksmithDeckWriterConflictError')
  );
}

function decksmithLeaseConflictMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { message: string }).message.length > 0
  ) {
    return (error as { message: string }).message;
  }
  return 'Decksmith deck lease is active';
}

export function badRequest(message: string): ReachDeckWorkspaceRouteError {
  return new ReachDeckWorkspaceRouteError(message, 400);
}

export function notFound(message: string): ReachDeckWorkspaceRouteError {
  return new ReachDeckWorkspaceRouteError(message, 404);
}

export function conflict(
  message: string,
  code?: string,
  details?: unknown,
): ReachDeckWorkspaceRouteError {
  return new ReachDeckWorkspaceRouteError(message, 409, code, details);
}

/**
 * Status and body for a failed PPTX import, whether the route answered
 * directly or is reporting the failure inside a stream.
 */
export function reachDeckPptxRouteError(error: unknown): Response {
  if (error instanceof ReachDeckPptxUploadError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return workspaceRouteError(error);
}

/**
 * 从请求体读取调试工作台的提示词 snippet 覆盖，并把它并入任务作用域。
 *
 * 数据源：请求体的 `promptSnippetOverrides` 字段（仅调试工作台会传）。
 *
 * 核心逻辑：
 * 1. 请求没带这个字段时原样返回，正式路径完全不受影响；
 * 2. 带了就先过 `REACH_DECK_HARNESS_MODE` 环境门，关闭时直接 400 而不是静默忽略；
 * 3. 校验 snippet id 与正文，非法项一律拒绝；
 * 4. 并入作用域后由 `workspace-jobs` 写进任务身份哈希，保证不同覆盖是不同任务。
 */
export function withReachDeckPromptSnippetOverrides<T extends ReachDeckGenerationJobScope>(
  scope: T,
  body: Record<string, unknown>,
): T {
  if (body.promptSnippetOverrides === undefined) return scope;
  requireReachDeckHarnessMode('promptSnippetOverrides');
  const promptSnippetOverrides = parseReachDeckPromptSnippetOverrides(body.promptSnippetOverrides);
  return promptSnippetOverrides === undefined ? scope : { ...scope, promptSnippetOverrides };
}
