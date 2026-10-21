import {
  setPageGenerationStatus,
  type GenerationWorkspace,
  type PageGenerationStatus,
} from '@reachany/reach-deck-dsl';

import { actorOrganizationIdFromPayload } from './contracts.js';
import {
  ContentServiceClientError,
  getReachDeckGenerationAudit,
  type ReachDeckGenerationAuditResource,
} from './content-service-client.js';
import { settleOrphanedReachDeckGenerationAuditByScope } from './generation-audit.js';
import {
  releaseReachDeckAsyncWriterLeaseIfSettled,
  withReachDeckRetainedAsyncWriterLease,
  type ReachDeckDocumentWriterContext,
} from './decksmith/document-writer.js';
import { readReachDeckGenerationJob } from './queue.js';
import {
  isReachDeckOrphanedGenerationAudit,
  loadReachDeckWorkspaceRecovery,
  type ReachDeckWorkspaceRecoveryJob,
  type ReachDeckWorkspaceRecoveryResource,
} from './workspace-recovery.js';
import { transitionReachDeckWorkspace } from './workspace-store.js';

/**
 * 页当前 attempt 的任务已终结却没有写回工作区（「停滞」）的证明与自愈。
 *
 * 数据源：content-service 创作工作区与 recovery 描述符、content-service 生成审计、BullMQ 任务记录。
 *
 * 背景：讲稿 lane 严格按页序推进，前页停在 pending/generating/narrating 就挡住所有后页。
 * 前页停在非终态有两种已知来源：
 * 1. 任务终态失败后，失败写回拿不到 deck 写租约，只记日志放弃（best-effort），页永远停在 pending；
 * 2. worker 滚动发布时排空中断，任务的重试没能入队，审计停在 running/retrying、BullMQ 记录已过期。
 * 两种情况下 lane 再次推进都会撞上审计门（只允许 executionAttempt 为 0 的任务重新入队），
 * 把它当作 already-queued 原地等待；教师侧的讲稿重生成、整页重生成也都按状态判定为在途。
 *
 * 核心逻辑：
 * 1. 取该页当前 (runId, requestedRevision, attempt) 的全部同类描述符；没有描述符不构成证明；
 * 2. 每个描述符都必须可证明终结：没有待落地产物；BullMQ 记录不存在或已结束；且审计为
 *    failed/aborted（executionAttempt ≥ 1），或审计停在 running/retrying（及 executionAttempt ≥ 1 的
 *    queued）超过孤儿阈值。读不到审计（跨账号）时只认 BullMQ 记录的 failed 终态；
 * 3. 证明成立时把该页转为可重试的 failed（与正常失败写回同形），lane 随即跳过它继续推进；
 * 4. 写页面前把孤儿审计结清为终态（running/retrying → failed，执行过的 queued → aborted）。审计停在
 *    执行中会让异步写租约判定一直认为任务在途，页面修好了租约却不释放，后续 Decksmith 与普通写入
 *    持续冲突。结清按证明时读到的审计版本（状态、executionAttempt、updatedAt）原子校验：手动重试在
 *    同一 attempt 上切到 retrying 只刷新 updatedAt，worker 可能已把 queued@N 推进为 running@N+1，
 *    只按 attempt 校验会覆盖刚恢复的真实重试或中止真实执行；
 * 5. 结清没有全部成功（版本已推进、旧服务没有该接口或传输失败）时重新证明。仍成立就用新快照再结清
 *    一轮（最多两轮），写页面前的最后一次证明必须仍成立；不成立说明任务已被真实恢复，放弃本次自愈。
 *    结清始终失败而证明仍成立时照旧自愈，租约判定对孤儿审计另有同规则兜底。
 * 任一描述符仍可能在途就不动：误判在途只会多等，误判终结则会让同一页并发两份任务。
 */

export type ReachDeckStalledPageKind = 'page-generation' | 'narration-generation';

/** 证明过程中认定为孤儿的审计，供结清使用。 */
export interface ReachDeckOrphanedPageAudit {
  readonly job: ReachDeckWorkspaceRecoveryJob;
  readonly audit: ReachDeckGenerationAuditResource;
}

export type ReachDeckStalledPageProof =
  | {
      readonly stalled: true;
      readonly reason: 'failed' | 'orphaned';
      readonly jobIds: string[];
      readonly orphanedAudits: readonly ReachDeckOrphanedPageAudit[];
    }
  | { readonly stalled: false };

type StalledPageIdentity = Pick<
  PageGenerationStatus,
  'runId' | 'pageId' | 'requestedRevision' | 'attempt'
>;

export interface ReachDeckStalledPageDependencies {
  readonly readJob?: typeof readReachDeckGenerationJob;
  readonly readAudit?: typeof getReachDeckGenerationAudit;
  readonly settleAudit?: typeof settleOrphanedReachDeckGenerationAuditByScope;
  /** 重新证明时读取最新 recovery；缺省读 content-service。 */
  readonly loadRecovery?: typeof loadReachDeckWorkspaceRecovery;
  readonly now?: () => number;
}

const STALLABLE_STATES: Record<ReachDeckStalledPageKind, ReadonlySet<string>> = {
  'page-generation': new Set(['pending', 'generating']),
  'narration-generation': new Set(['narrating']),
};

/** 页当前状态对应的任务种类；非在途状态返回 undefined。 */
export function reachDeckStalledPageKind(
  status: PageGenerationStatus | undefined,
): ReachDeckStalledPageKind | undefined {
  if (status === undefined) return undefined;
  if (STALLABLE_STATES['page-generation'].has(status.state)) return 'page-generation';
  if (STALLABLE_STATES['narration-generation'].has(status.state)) return 'narration-generation';
  return undefined;
}

/** 该页当前 attempt 是否已有同类任务描述符（不论是否在途）。 */
export function hasReachDeckPageAttemptDescriptor(
  recovery: ReachDeckWorkspaceRecoveryResource,
  identity: StalledPageIdentity,
  kind: ReachDeckStalledPageKind,
): boolean {
  return attemptDescriptors(recovery, identity, kind).length > 0;
}

function attemptDescriptors(
  recovery: ReachDeckWorkspaceRecoveryResource,
  identity: StalledPageIdentity,
  kind: ReachDeckStalledPageKind,
): ReachDeckWorkspaceRecoveryJob[] {
  return Object.values(recovery.recovery.jobs).filter(
    (job) =>
      job.kind === kind &&
      job.runId === identity.runId &&
      job.pageId === identity.pageId &&
      job.requestedRevision === identity.requestedRevision &&
      job.generationAttempt === String(identity.attempt) &&
      job.appliedAt === undefined,
  );
}

export async function proveReachDeckPageAttemptStalled(
  input: {
    readonly context: ReachDeckDocumentWriterContext;
    readonly identity: StalledPageIdentity;
    readonly kind: ReachDeckStalledPageKind;
    /** 调用方已读到的 recovery 快照；缺省时读取一次。 */
    readonly recovery?: ReachDeckWorkspaceRecoveryResource;
  },
  dependencies: ReachDeckStalledPageDependencies = {},
): Promise<ReachDeckStalledPageProof> {
  const recovery = input.recovery ?? (await loadReachDeckWorkspaceRecovery(input.context));
  const descriptors = attemptDescriptors(recovery, input.identity, input.kind);
  if (descriptors.length === 0) return { stalled: false };
  // 有待落地产物就是落地还没完成，不是停滞。
  if (descriptors.some((job) => job.artifactRef !== undefined)) return { stalled: false };
  const readJob = dependencies.readJob ?? readReachDeckGenerationJob;
  const readAudit = dependencies.readAudit ?? getReachDeckGenerationAudit;
  const now = (dependencies.now ?? Date.now)();
  let reason: 'failed' | 'orphaned' = 'failed';
  const orphanedAudits: ReachDeckOrphanedPageAudit[] = [];
  for (const job of descriptors) {
    const owner = {
      actorId: job.actorId,
      actorOrganizationId: actorOrganizationIdFromPayload(job),
      billingGroupId: job.billingGroupId,
      roleGrantId: job.roleGrantId,
      resourceScope: job.resourceScope,
    };
    // 先读队列：正常在途的任务在这里就返回，不再读审计。
    const view = await readJob(job.jobId, owner);
    if (view !== null && !view.done) return { stalled: false };
    let audit: ReachDeckGenerationAuditResource | undefined;
    // 审计按账号查询；跨账号时只能依赖 BullMQ 的终态记录。
    if (job.actorId === input.context.actorId) {
      try {
        audit = await readAudit(job.jobId, job.requestHash, input.context, owner);
      } catch (error) {
        if (!(error instanceof ContentServiceClientError && error.status === 404)) throw error;
      }
    }
    if (audit === undefined || audit.jobId !== job.jobId || audit.requestHash !== job.requestHash) {
      if (view?.done === true && view.status === 'failed') continue;
      return { stalled: false };
    }
    if ((audit.status === 'failed' || audit.status === 'aborted') && audit.executionAttempt >= 1) {
      continue;
    }
    if (isReachDeckOrphanedGenerationAudit(audit, view, now)) {
      reason = 'orphaned';
      orphanedAudits.push({ job, audit });
      continue;
    }
    return { stalled: false };
  }
  return { stalled: true, reason, jobIds: descriptors.map((job) => job.jobId), orphanedAudits };
}

/** 每次自愈最多结清几轮：首轮按原证明，冲突后按重新证明的新快照再来一轮。 */
const ORPHAN_SETTLEMENT_ROUNDS = 2;

/**
 * 把证明为停滞的孤儿审计按证明时读到的版本结清为终态，返回是否全部结清。
 *
 * 数据源：content-service 生成审计（写，settle-orphaned 转换）。
 *
 * 核心逻辑：每条孤儿审计带上读到的状态、executionAttempt 与 updatedAt，content-service 只在三项
 * 全部仍一致时转换（running/retrying → failed，执行过的 queued → aborted）；任一条冲突、404 或传输失败
 * 只记日志并返回 false，由调用方重新证明后决定是否继续自愈。
 */
export async function settleReachDeckStalledPageAudits(
  context: ReachDeckDocumentWriterContext,
  orphanedAudits: readonly ReachDeckOrphanedPageAudit[],
  dependencies: ReachDeckStalledPageDependencies = {},
): Promise<boolean> {
  const settleAudit = dependencies.settleAudit ?? settleOrphanedReachDeckGenerationAuditByScope;
  let settled = true;
  for (const { job, audit } of orphanedAudits) {
    if (audit.status !== 'queued' && audit.status !== 'running' && audit.status !== 'retrying') {
      continue;
    }
    try {
      await settleAudit(
        job.jobId,
        job.requestHash,
        {
          expectedStatus: audit.status,
          expectedExecutionAttempt: audit.executionAttempt,
          expectedUpdatedAt: audit.updatedAt,
        },
        context,
      );
    } catch (error) {
      settled = false;
      console.warn('Reach Deck 停滞页孤儿审计结清未生效，写页面前重新证明', {
        moduleVersionId: context.resourceScope.moduleVersionId,
        jobId: job.jobId,
        status: audit.status,
        executionAttempt: audit.executionAttempt,
        updatedAt: audit.updatedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return settled;
}

/**
 * 证明停滞并结清孤儿审计，返回写页面前最后一次成立的证明。
 *
 * 数据源：同 {@link proveReachDeckPageAttemptStalled}，另写 content-service 生成审计。
 *
 * 核心逻辑：
 * 1. 首次证明；不成立或没有孤儿审计时直接返回；
 * 2. 结清孤儿审计，全部结清即返回该证明；
 * 3. 没有全部结清就重新读 recovery、审计与队列再证明一次：不成立（审计已推进、队列在途）返回未停滞；
 *    仍成立则用新快照进入下一轮，最多 {@link ORPHAN_SETTLEMENT_ROUNDS} 轮；
 * 4. 每轮失败后都会重新证明，所以返回的证明总是读到的最新状态，调用方据此写页面。
 */
async function proveAndSettleReachDeckPageAttemptStalled(
  input: Parameters<typeof proveReachDeckPageAttemptStalled>[0],
  dependencies: ReachDeckStalledPageDependencies,
): Promise<ReachDeckStalledPageProof> {
  let proof = await proveReachDeckPageAttemptStalled(input, dependencies);
  for (let round = 0; round < ORPHAN_SETTLEMENT_ROUNDS; round += 1) {
    if (!proof.stalled || proof.orphanedAudits.length === 0) return proof;
    if (await settleReachDeckStalledPageAudits(input.context, proof.orphanedAudits, dependencies)) {
      return proof;
    }
    const loadRecovery = dependencies.loadRecovery ?? loadReachDeckWorkspaceRecovery;
    proof = await proveReachDeckPageAttemptStalled(
      { ...input, recovery: await loadRecovery(input.context) },
      dependencies,
    );
  }
  return proof;
}

/**
 * 路由用的停滞判定：读取失败一律按「未证明」处理并记日志。
 * 路由原本就会按在途返回 409，对账读失败不能把它变成 500。
 *
 * 证明成立时顺带按版本结清孤儿审计；结清冲突后重新证明不成立（任务已被真实恢复）就返回 false，
 * 路由按原有在途语义处理。调用方随后才会把页转为 failed（转换失败时下次证明仍成立）。
 */
export async function isReachDeckPageAttemptProvablyStalled(
  input: Parameters<typeof proveReachDeckPageAttemptStalled>[0],
  dependencies: ReachDeckStalledPageDependencies = {},
): Promise<boolean> {
  try {
    return (await proveAndSettleReachDeckPageAttemptStalled(input, dependencies)).stalled;
  } catch (error) {
    console.warn('Reach Deck 停滞页对账读取失败，按在途处理', {
      moduleVersionId: input.context.resourceScope.moduleVersionId,
      runId: input.identity.runId,
      pageId: input.identity.pageId,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * 把停滞页转为可重试的 failed（纯函数，供路由在自身的转换回调里使用）。
 * 页已不是该 attempt 的对应在途状态时原样返回。
 */
export function failReachDeckStalledPageAttempt(
  workspace: GenerationWorkspace,
  identity: StalledPageIdentity,
  kind: ReachDeckStalledPageKind,
  failedAt: string,
): GenerationWorkspace {
  const current = workspace.statuses[identity.pageId];
  if (
    workspace.runId !== identity.runId ||
    current === undefined ||
    !STALLABLE_STATES[kind].has(current.state) ||
    current.runId !== identity.runId ||
    current.requestedRevision !== identity.requestedRevision ||
    current.attempt !== identity.attempt
  ) {
    return workspace;
  }
  return setPageGenerationStatus(
    workspace,
    {
      runId: identity.runId,
      pageId: identity.pageId,
      requestedRevision: identity.requestedRevision,
      attempt: identity.attempt,
      state: 'failed',
      retryable: true,
      // 原始失败原因已随丢失的写回一起丢失；按「内部中断，可重试」提示教师。
      message: 'internal',
      failedAt,
    },
    failedAt,
  );
}

/**
 * lane 推进时的自愈：证明该页停滞后在写会话内转为 failed，返回是否已转换。
 *
 * 有写会话时直接在会话内写；没有时按失败写回同样的方式取本 run 的异步写租约，
 * 写完尝试释放（没有后续任务时不留下租约）。证明或写入失败一律视为未转换：
 * 这是 lane 推进的辅助，不能反过来打断推进本身。
 */
export async function healReachDeckStalledPageAttempt(
  input: {
    readonly context: ReachDeckDocumentWriterContext;
    readonly status: PageGenerationStatus;
    readonly recovery?: ReachDeckWorkspaceRecoveryResource;
  },
  dependencies: ReachDeckStalledPageDependencies = {},
): Promise<boolean> {
  const kind = reachDeckStalledPageKind(input.status);
  if (kind === undefined) return false;
  const identity: StalledPageIdentity = {
    runId: input.status.runId,
    pageId: input.status.pageId,
    requestedRevision: input.status.requestedRevision,
    attempt: input.status.attempt,
  };
  try {
    // 先结清孤儿审计再写页面：写页面时取的异步写租约在写完后要能被判定为已结清并释放；
    // 结清冲突后重新证明不成立说明任务已被真实恢复，不能再把页改成失败。
    const proof = await proveAndSettleReachDeckPageAttemptStalled(
      { context: input.context, identity, kind, recovery: input.recovery },
      dependencies,
    );
    if (!proof.stalled) return false;
    const transition = async (writerContext: ReachDeckDocumentWriterContext) =>
      (
        await transitionReachDeckWorkspace(writerContext, (workspace) =>
          failReachDeckStalledPageAttempt(workspace, identity, kind, new Date().toISOString()),
        )
      ).applied;
    let applied: boolean;
    if (input.context.documentWriterSession !== undefined) {
      applied = await transition(input.context);
    } else {
      applied = await withReachDeckRetainedAsyncWriterLease({
        context: input.context,
        pageId: identity.pageId,
        operationKind: `${kind}-stall-reconcile`,
        asyncRunId: identity.runId,
        operation: transition,
      });
      try {
        await releaseReachDeckAsyncWriterLeaseIfSettled(input.context, identity.runId);
      } catch {
        // 释放只是回收，后续写入路由的租约判定会再次尝试。
      }
    }
    if (applied) {
      console.warn('Reach Deck 停滞页已转为可重试失败', {
        moduleVersionId: input.context.resourceScope.moduleVersionId,
        runId: identity.runId,
        pageId: identity.pageId,
        attempt: identity.attempt,
        kind,
        reason: proof.reason,
        jobIds: proof.jobIds,
      });
    }
    return applied;
  } catch (error) {
    console.warn('Reach Deck 停滞页对账未完成', {
      moduleVersionId: input.context.resourceScope.moduleVersionId,
      runId: identity.runId,
      pageId: identity.pageId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
