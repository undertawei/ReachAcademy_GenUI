import {
  actorOrganizationIdFromPayload,
  ReachDeckAnyGenerationJobPayload,
  ReachDeckStagedGenerationJobPayload,
} from './contracts.js';
import {
  createReachDeckGenerationAudit as createContentServiceAudit,
  abortReachDeckGenerationAudit as abortContentServiceAudit,
  getReachDeckGenerationAudit as getContentServiceAudit,
  settleOrphanedReachDeckGenerationAudit as settleOrphanedContentServiceAudit,
  updateReachDeckGenerationAudit as updateContentServiceAudit,
  type ContentServiceRequestOptions,
  type ReachDeckGenerationAuditResource,
  type ReachDeckGenerationAuditAbortInput,
  type ReachDeckGenerationAuditOrphanSettlementInput,
  type ReachDeckGenerationAuditUpdateInput,
} from './content-service-client.js';
import type { ReachDeckResourceScope } from './resource-scope.js';

export interface ReachDeckGenerationAuditScope {
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
}

export interface ReachDeckGenerationAuditLifecycle {
  create(payload: ReachDeckAnyGenerationJobPayload): Promise<ReachDeckGenerationAuditResource>;
  /** Read the durable audit before a BullMQ replay so the optimistic attempt is exact. */
  read?(payload: ReachDeckAnyGenerationJobPayload): Promise<ReachDeckGenerationAuditResource>;
  update(
    payload: ReachDeckAnyGenerationJobPayload,
    input: ReachDeckGenerationAuditUpdateInput,
  ): Promise<ReachDeckGenerationAuditResource>;
  abort(
    payload: ReachDeckAnyGenerationJobPayload,
    input: ReachDeckGenerationAuditAbortInput,
  ): Promise<ReachDeckGenerationAuditResource>;
}

export class ReachDeckGenerationAuditStateError extends Error {
  constructor(
    readonly jobId: string,
    readonly status: ReachDeckGenerationAuditResource['status'],
    readonly executionAttempt: number,
  ) {
    super(
      `Reach Deck generation audit ${jobId} is already ${status}@${executionAttempt}; use the explicit lifecycle endpoint`,
    );
    this.name = 'ReachDeckGenerationAuditStateError';
  }
}

export const reachDeckGenerationAuditLifecycle: ReachDeckGenerationAuditLifecycle = {
  create: createReachDeckGenerationAudit,
  read: readReachDeckGenerationAudit,
  update: updateReachDeckGenerationAudit,
  abort: abortReachDeckGenerationAudit,
};

async function readReachDeckGenerationAudit(
  payload: ReachDeckAnyGenerationJobPayload,
): Promise<ReachDeckGenerationAuditResource> {
  return readReachDeckGenerationAuditByScope(
    payload.jobId,
    payload.requestHash,
    scopeFromPayload(payload),
  );
}

export async function createReachDeckGenerationAudit(
  payload: ReachDeckAnyGenerationJobPayload,
): Promise<ReachDeckGenerationAuditResource> {
  const provenance = auditProvenance(payload);
  return createContentServiceAudit(provenance, contentOptions(scopeFromPayload(payload)));
}

export async function updateReachDeckGenerationAudit(
  payload: ReachDeckAnyGenerationJobPayload,
  input: ReachDeckGenerationAuditUpdateInput,
): Promise<ReachDeckGenerationAuditResource> {
  return updateReachDeckGenerationAuditByScope(
    payload.jobId,
    payload.requestHash,
    input,
    scopeFromPayload(payload),
  );
}

export async function abortReachDeckGenerationAudit(
  payload: ReachDeckAnyGenerationJobPayload,
  input: ReachDeckGenerationAuditAbortInput,
): Promise<ReachDeckGenerationAuditResource> {
  return abortReachDeckGenerationAuditByScope(
    payload.jobId,
    payload.requestHash,
    input,
    scopeFromPayload(payload),
  );
}

export async function abortReachDeckGenerationAuditByScope(
  jobId: string,
  requestHash: string,
  input: ReachDeckGenerationAuditAbortInput,
  scope: ReachDeckGenerationAuditScope,
): Promise<ReachDeckGenerationAuditResource> {
  return abortContentServiceAudit(jobId, requestHash, input, contentOptions(scope));
}

/** 按 scope 原子结清孤儿执行审计；审计已不是证明时的那一版时 content-service 返回 409。 */
export async function settleOrphanedReachDeckGenerationAuditByScope(
  jobId: string,
  requestHash: string,
  input: ReachDeckGenerationAuditOrphanSettlementInput,
  scope: ReachDeckGenerationAuditScope,
): Promise<ReachDeckGenerationAuditResource> {
  return settleOrphanedContentServiceAudit(jobId, requestHash, input, contentOptions(scope));
}

/**
 * 按 scope 读取 content-service 侧生成审计当前状态。
 * 手动重试等场景需要先拿到真实 executionAttempt,再发状态转移,
 * 否则 content-service 的乐观并发条件(executionAttempt 精确匹配)会拒绝更新。
 */
export async function readReachDeckGenerationAuditByScope(
  jobId: string,
  requestHash: string,
  scope: ReachDeckGenerationAuditScope,
): Promise<ReachDeckGenerationAuditResource> {
  return getContentServiceAudit(jobId, requestHash, contentOptions(scope));
}

export async function updateReachDeckGenerationAuditByScope(
  jobId: string,
  requestHash: string,
  input: ReachDeckGenerationAuditUpdateInput,
  scope: ReachDeckGenerationAuditScope,
): Promise<ReachDeckGenerationAuditResource> {
  return updateContentServiceAudit(jobId, requestHash, input, contentOptions(scope));
}

export async function updateReachDeckGenerationAuditWithNarrowRetry(
  lifecycle: ReachDeckGenerationAuditLifecycle,
  payload: ReachDeckAnyGenerationJobPayload,
  input: ReachDeckGenerationAuditUpdateInput,
  attempts = 3,
): Promise<ReachDeckGenerationAuditResource> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await lifecycle.update(payload, input);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function updateReachDeckGenerationAuditByScopeWithNarrowRetry(
  jobId: string,
  requestHash: string,
  input: ReachDeckGenerationAuditUpdateInput,
  scope: ReachDeckGenerationAuditScope,
  attempts = 3,
): Promise<ReachDeckGenerationAuditResource> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await updateReachDeckGenerationAuditByScope(jobId, requestHash, input, scope);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function abortReachDeckGenerationAuditWithNarrowRetry(
  lifecycle: ReachDeckGenerationAuditLifecycle,
  payload: ReachDeckAnyGenerationJobPayload,
  input: ReachDeckGenerationAuditAbortInput,
  attempts = 3,
): Promise<ReachDeckGenerationAuditResource> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await lifecycle.abort(payload, input);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function abortReachDeckGenerationAuditByScopeWithNarrowRetry(
  jobId: string,
  requestHash: string,
  input: ReachDeckGenerationAuditAbortInput,
  scope: ReachDeckGenerationAuditScope,
  attempts = 3,
): Promise<ReachDeckGenerationAuditResource> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await abortReachDeckGenerationAuditByScope(jobId, requestHash, input, scope);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function reachDeckGenerationAuditErrorSummary(error: unknown, phase: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ phase, message: message.slice(0, 3500) });
}

function auditProvenance(payload: ReachDeckAnyGenerationJobPayload) {
  if (payload.kind === undefined) {
    return {
      jobId: payload.jobId,
      runId: payload.runId,
      generationKind: 'legacy-generation',
      generationStage: 'document',
      pageId: payload.pageId,
      generationAttempt: payload.attempt,
      requestHash: payload.requestHash,
    };
  }
  if (payload.kind === 'decksmith') {
    return {
      jobId: payload.jobId,
      runId: payload.runId,
      generationKind: 'decksmith',
      generationStage: 'decksmith',
      generationAttempt: 'whole-turn',
      requestHash: payload.requestHash,
    };
  }
  return {
    jobId: payload.jobId,
    runId: payload.runId,
    generationKind: payload.kind,
    generationStage: stagedGenerationStage(payload),
    ...(stagedPageId(payload) === undefined ? {} : { pageId: stagedPageId(payload) }),
    generationAttempt: stagedGenerationAttempt(payload),
    requestHash: payload.requestHash,
  };
}

function stagedGenerationStage(payload: ReachDeckStagedGenerationJobPayload): string {
  switch (payload.kind) {
    case 'lesson-plan':
      return 'lesson-plan';
    case 'page-outline':
      return 'paged-outline';
    case 'page-generation':
      return payload.request.page.sceneType;
    case 'narration-generation':
      return 'narration';
  }
}

function stagedPageId(payload: ReachDeckStagedGenerationJobPayload): string | undefined {
  if (payload.kind === 'page-generation' || payload.kind === 'narration-generation') {
    return payload.request.pageId;
  }
  return undefined;
}

function stagedGenerationAttempt(payload: ReachDeckStagedGenerationJobPayload): string {
  if (payload.kind === 'page-generation' || payload.kind === 'narration-generation') {
    return String(payload.request.attempt);
  }
  return 'initial';
}

function scopeFromPayload(
  payload: ReachDeckAnyGenerationJobPayload,
): ReachDeckGenerationAuditScope {
  return {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
}

function contentOptions(scope: ReachDeckGenerationAuditScope): ContentServiceRequestOptions {
  return {
    actorId: scope.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(scope),
    billingGroupId: scope.billingGroupId,
    roleGrantId: scope.roleGrantId,
    resourceScope: scope.resourceScope,
  };
}
