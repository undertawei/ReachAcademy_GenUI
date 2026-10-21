import {
  collectReachDeckNativeSlideResourceIds,
  requestPageGeneration,
  setPageGenerationStatus,
  isNativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import { resolveMediaBatchDispatchWindow } from './workspace-batch-coordinator.js';
import type {
  ReachDeckBatchCoordinatorDependencies,
  ReachDeckBatchCoordinatorOutcome,
} from './workspace-batch-coordinator.js';
import type {
  ReachDeckBatchCoordinatorJobPayload,
  ReachDeckWorkspaceBatch,
  ReachDeckWorkspaceBatchMember,
} from './workspace-batches.js';
import {
  sameReachDeckWorkspaceBatchOwner,
  ReachDeckWorkspaceBatchCapacityError,
} from './workspace-batches.js';
import type { ReachDeckWorkspaceRecoveryResource } from './workspace-recovery.js';
import {
  loadReachDeckWorkspaceRecovery,
  transitionReachDeckWorkspaceBatches,
  registerReachDeckWorkspaceJob,
  findUnfinishedReachDeckPageNarrationJob,
  forgetUnqueuedReachDeckWorkspaceJob,
  readReachDeckGenerationJobWithRecovery,
  readReachDeckGenerationJobWithRecoverySnapshot,
} from './workspace-recovery.js';
import {
  loadReachDeckWorkspace,
  transitionReachDeckWorkspaceForPage,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import {
  buildReachDeckNativeNarrationGenerationJobPayload,
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload,
  prepareReachDeckPageGenerationJobPayload,
  loadReachDeckMaterializedWorkspaceDocument,
  ReachDeckNarrationPreflightError,
} from './workspace-jobs.js';
import {
  enqueueReachDeckGenerationJob,
  enqueueReachDeckGenerationJobWithQueue,
  parseReachDeckStagedGenerationJobPayload,
  ReachDeckInvalidGenerationPayloadError,
} from './queue.js';
import { ContentServiceClientError } from './content-service-client.js';
import type { ReachDeckStagedGenerationJobPayload } from './contracts.js';
import { ReachDeckGenerationAuditStateError } from './generation-audit.js';
import {
  reachDeckImageLandingAttempts,
  withReachDeckImageLandingAttempt,
  clearReachDeckImageLandingAttempt,
  reachDeckImageNarrationWait,
  withReachDeckImageNarrationWait,
} from './image-landing-reason.js';

const MAX_IMAGE_LANDING_REPLAYS = 3;
const MAX_RESULT_RECOVERY_READS = 3;
const IMAGE_NARRATION_POLL_MS = 15_000;
const MAX_IMAGE_NARRATION_WAIT_MS = 30 * 60_000;

/** Uses the existing delayed coordinator tick and generation queue. A page's next stage becomes
 * dispatchable only after the preceding durable result has landed, including materialization. */
export async function coordinateReachDeckRegeneration(
  context: ReachDeckWorkspaceContext,
  coordinator: ReachDeckBatchCoordinatorJobPayload,
  batch: ReachDeckWorkspaceBatch,
  recovery: ReachDeckWorkspaceRecoveryResource,
  dependencies: ReachDeckBatchCoordinatorDependencies,
): Promise<ReachDeckBatchCoordinatorOutcome> {
  const members = batch.members.filter((candidate) => candidate.terminalOutcome === undefined);
  if (members.length === 0) {
    await transitionReachDeckWorkspaceBatches(context, (batches) => {
      const current = batches[batch.batchId];
      if (!current || current.cancelRequested || current.phase === 'terminal') return batches;
      const failed = current.members.filter((m) => m.terminalOutcome === 'failed').length;
      const cancelled = current.members.filter((m) => m.terminalOutcome === 'cancelled').length;
      return {
        ...batches,
        [batch.batchId]: {
          ...current,
          phase: 'terminal',
          revision: current.revision + 1,
          terminalSummary: {
            completedAt: new Date().toISOString(),
            status: failed + cancelled > 0 ? 'partial-failure' : 'completed',
            total: current.members.length + current.skipped.length,
            succeeded: current.members.length - failed - cancelled,
            failed,
            cancelled,
            blocked: 0,
            skipped: current.skipped.length,
          },
        },
      };
    });
    return { status: 'terminal' };
  }
  // Keep page-local dependencies, but let independent pages share the existing media window.
  // Serialize durable writes under the inherited writer session to avoid recovery CAS storms.
  const waitingDelays: number[] = [];
  for (const member of members.slice(0, resolveMediaBatchDispatchWindow())) {
    const outcome = await advanceRegenerationMember(
      context,
      coordinator,
      batch,
      member,
      recovery,
      dependencies,
    );
    if (outcome.status === 'waiting' && outcome.retryAfterMs !== undefined)
      waitingDelays.push(outcome.retryAfterMs);
  }
  return {
    status: 'waiting',
    ...(waitingDelays.length === members.length
      ? { retryAfterMs: Math.min(...waitingDelays) }
      : {}),
  };
}

async function advanceRegenerationMember(
  context: ReachDeckWorkspaceContext,
  coordinator: ReachDeckBatchCoordinatorJobPayload,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
  recovery: ReachDeckWorkspaceRecoveryResource,
  dependencies: ReachDeckBatchCoordinatorDependencies,
): Promise<ReachDeckBatchCoordinatorOutcome> {
  const checkpoint = member.regeneration;
  if (!checkpoint) throw new Error('Regeneration member is missing its execution plan');
  if (member.jobId && checkpoint.payload) {
    const now = dependencies.now?.() ?? Date.now();
    const waiting = reachDeckImageNarrationWait(member.reason);
    if (
      checkpoint.stage === 'image' &&
      recovery.recovery.jobs[member.jobId]?.appliedAt === undefined &&
      waiting !== undefined
    ) {
      if (now - waiting.first >= MAX_IMAGE_NARRATION_WAIT_MS) {
        await finishMember(
          context,
          batch,
          member,
          'failed',
          'image-waiting-narration-timeout',
          true,
        );
        return { status: 'waiting' };
      }
      if (now - waiting.last < IMAGE_NARRATION_POLL_MS)
        return {
          status: 'waiting',
          retryAfterMs: Math.min(
            waiting.last + IMAGE_NARRATION_POLL_MS - now,
            waiting.first + MAX_IMAGE_NARRATION_WAIT_MS - now,
          ),
        };
    }
    const readJob = () =>
      dependencies.generationQueue === undefined
        ? readReachDeckGenerationJobWithRecovery(member.jobId!, coordinator)
        : readReachDeckGenerationJobWithRecoverySnapshot(member.jobId!, coordinator, {
            queue: dependencies.generationQueue,
            recovery,
          });
    let frozen: ReachDeckStagedGenerationJobPayload;
    try {
      frozen = parseReachDeckStagedGenerationJobPayload(checkpoint.payload);
    } catch (error) {
      if (!(error instanceof ReachDeckInvalidGenerationPayloadError)) throw error;
      // 已冻结的载荷不再通过校验（例如部署后校验收紧），每次 tick 都会同样失败。队列从未接收的
      // 登记要一并移除，否则它会一直以“已登记”出现在任务列表里。
      const job = await readJob();
      if (job === null || job.status === 'registered' || job.status === 'recovery-required') {
        await forgetUnqueuedReachDeckWorkspaceJob(context, member.jobId);
      }
      await finishMember(context, batch, member, 'failed', error.code);
      return { status: 'waiting' };
    }
    assertFrozenMember(frozen, batch, member);
    const job = await readJob();
    let memberRecovery = recovery;
    let descriptor = memberRecovery.recovery.jobs[member.jobId];
    if (job?.status === 'failed' || job?.status === 'cancelled') {
      await finishMember(
        context,
        batch,
        member,
        job.status === 'failed' ? 'failed' : 'cancelled',
        job.error ?? 'upstream-failed',
      );
      return { status: 'waiting' };
    }
    const missingResultAttempt = Number(
      /(?:^|;)generation-result-recovery:(\d+)(?:;|$)/.exec(member.reason ?? '')?.[1] ?? 0,
    );
    const paidCompletionKnown =
      job?.status === 'completed' ||
      (job?.status === 'recovery-required' && job.progress === 100) ||
      (descriptor?.artifactRef !== undefined &&
        memberRecovery.recovery.results[descriptor.artifactRef] !== undefined) ||
      missingResultAttempt > 0;
    if (
      paidCompletionKnown &&
      (descriptor?.artifactRef === undefined ||
        memberRecovery.recovery.results[descriptor.artifactRef] === undefined)
    ) {
      // 回填可能刚刚成功；先更新快照，再决定是否消耗有界恢复次数。
      memberRecovery = await loadReachDeckWorkspaceRecovery(context);
      descriptor = memberRecovery.recovery.jobs[member.jobId];
    }
    if (descriptor?.appliedAt !== undefined) {
      const stored =
        descriptor.artifactRef === undefined
          ? undefined
          : memberRecovery.recovery.results[descriptor.artifactRef]?.result;
      const changedPlans =
        checkpoint.stage === 'layout' &&
        checkpoint.plan.channels.image === false &&
        frozen.kind === 'page-generation' &&
        stored?.kind === 'page-generation' &&
        isNativeSlideArtifact(stored.artifact)
          ? (stored.artifact.generationMetadata.mediaSlots ?? []).filter((slot) => {
              const prior = frozen.request.previousMedia?.mediaSlots.find(
                (candidate) => candidate.assetId === slot.assetId,
              );
              return !prior || prior.planDigest !== slot.planDigest;
            }).length
          : 0;
      const preservedImageFailures =
        checkpoint.stage === 'image' &&
        stored?.kind === 'page-generation' &&
        isNativeSlideArtifact(stored.artifact)
          ? (stored.artifact.generationMetadata.imageRegenerationFailureCount ?? 0)
          : 0;
      const imageReason = preservedImageFailures
        ? `image-regeneration-failed:${preservedImageFailures}`
        : changedPlans
          ? `image-plans-changed:${changedPlans}`
          : undefined;
      if (
        checkpoint.stage !== 'narration' &&
        (checkpoint.plan.channels.narration ||
          checkpoint.plan.channels.audio ||
          checkpoint.plan.channels.animation)
      ) {
        await updateMember(context, batch, member, (current) => {
          const { jobId: _jobId, ...rest } = clearImageLandingRetryReason(current);
          return {
            ...rest,
            ...(imageReason ? { reason: imageReason } : {}),
            intent: 'waiting-dispatch',
            regeneration: {
              plan: checkpoint.plan,
              stage: 'narration',
              ...(checkpoint.stage === 'layout'
                ? {
                    completedLayout: {
                      jobId: member.jobId!,
                      requestedRevision: member.requestedRevision,
                      attempt: member.attempt,
                    },
                  }
                : {}),
            },
          };
        });
      } else {
        const audioFailure =
          stored?.kind === 'narration-generation' &&
          'nativeNarration' in stored &&
          stored.nativeNarration.audioFailureCode !== undefined;
        await finishMember(
          context,
          batch,
          member,
          audioFailure ? 'failed' : 'completed',
          audioFailure ? 'audio-generation-failed' : imageReason,
        );
      }
      return { status: 'waiting' };
    }
    if (
      paidCompletionKnown &&
      (descriptor?.artifactRef === undefined ||
        memberRecovery.recovery.results[descriptor.artifactRef] === undefined)
    ) {
      const attempt = missingResultAttempt + 1;
      if (attempt >= MAX_RESULT_RECOVERY_READS)
        await finishMember(context, batch, member, 'failed', 'generation-result-unavailable', true);
      else
        await updateMember(context, batch, member, (current) => {
          // 只替换本控制标记，保留跳过提示、旁白等待等并存状态。
          const reason = clearMissingResultRecoveryReason(current.reason);
          return {
            ...current,
            reason: [reason, `generation-result-recovery:${attempt}`].filter(Boolean).join(';'),
          };
        });
      return { status: 'waiting' };
    }
    if (paidCompletionKnown && descriptor?.artifactRef !== undefined) {
      const stored = memberRecovery.recovery.results[descriptor.artifactRef]?.result;
      if (missingResultAttempt > 0) {
        const { reason: _reason, ...rest } = member;
        const reason = clearMissingResultRecoveryReason(member.reason);
        member = { ...rest, ...(reason === undefined ? {} : { reason }) };
        await updateMember(context, batch, member, (current) => {
          const { reason: _reason, ...rest } = current;
          const reason = clearMissingResultRecoveryReason(current.reason);
          return { ...rest, ...(reason === undefined ? {} : { reason }) };
        });
      }
      if (frozen.kind === 'page-generation' && stored?.kind === 'page-generation') {
        const { finalizeReachDeckPageGeneration } = await import('./generation-chain.js');
        if (checkpoint.stage === 'image') {
          const { landReachDeckImageResults } = await import('./image-regeneration.js');
          const waitForNarration = async (previousLandingAttempts?: number) => {
            await updateMember(context, batch, member, (current) => {
              let reason = current.reason;
              if (previousLandingAttempts !== undefined) {
                // 实际落地才发现需等旁白时，仅撤销本次计数，保留当前新写入的提示和历史次数。
                reason =
                  previousLandingAttempts > 0
                    ? withReachDeckImageLandingAttempt(reason, previousLandingAttempts)
                    : clearReachDeckImageLandingAttempt(reason);
              }
              return { ...current, reason: withReachDeckImageNarrationWait(reason, now) };
            });
          };
          try {
            if (
              (await landReachDeckImageResults(context, frozen, stored, {
                checkOnly: true,
                loadedRecovery: recovery,
                queue: dependencies.generationQueue,
              })) === 'deferred'
            ) {
              await waitForNarration();
              return { status: 'waiting', retryAfterMs: IMAGE_NARRATION_POLL_MS };
            }
          } catch {
            // 真正的落地错误继续进入有限重放；旁白等待在上面提前返回，不消耗次数。
          }
          // 先耐久记录次数，进程重启后仍有界；最终以 appliedAt 确认落地，不能把吞掉的异常当成功。
          const previousLandingAttempts = reachDeckImageLandingAttempts(member.reason);
          const attempt = previousLandingAttempts + 1;
          if (attempt <= MAX_IMAGE_LANDING_REPLAYS) {
            await updateMember(context, batch, member, (current) => ({
              ...current,
              reason: withReachDeckImageLandingAttempt(current.reason, attempt),
            }));
            try {
              const landed = await finalizeReachDeckPageGeneration(frozen, stored, {
                documentWriterSession: context.documentWriterSession,
              });
              if (landed === 'deferred') {
                await waitForNarration(previousLandingAttempts);
                return { status: 'waiting', retryAfterMs: IMAGE_NARRATION_POLL_MS };
              }
            } catch {
              // 回放只做落地，不能重新入队已成功的付费生成；失败由下面的耐久证明及次数收敛。
            }
          }
          const latest = await loadReachDeckWorkspaceRecovery(context);
          if (
            latest.recovery.jobs[frozen.jobId]?.appliedAt === undefined &&
            attempt >= MAX_IMAGE_LANDING_REPLAYS
          ) {
            await finishMember(context, batch, member, 'failed', 'image-landing-failed', true);
            return { status: 'waiting' };
          }
          return { status: 'waiting' };
        }
        await finalizeReachDeckPageGeneration(frozen, stored, {
          documentWriterSession: context.documentWriterSession,
        });
      } else if (
        frozen.kind === 'narration-generation' &&
        stored?.kind === 'narration-generation'
      ) {
        if ('nativeNarration' in stored) {
          const { finalizeReachDeckNativeNarrationGeneration } =
            await import('./native-narration.js');
          await finalizeReachDeckNativeNarrationGeneration(frozen, stored, {
            documentWriterSession: context.documentWriterSession,
          });
        } else if ('interactiveNarration' in stored) {
          const { finalizeReachDeckMaterializedInteractiveNarrationGeneration } =
            await import('./interactive-narration.js');
          await finalizeReachDeckMaterializedInteractiveNarrationGeneration(frozen, stored, {
            documentWriterSession: context.documentWriterSession,
          });
        }
      }
      return { status: 'waiting' };
    }
    if (job === null || job?.status === 'registered' || job?.status === 'recovery-required') {
      await registerReachDeckWorkspaceJob(frozen);
      await enqueue(frozen, dependencies);
    }
    return { status: 'waiting' };
  }
  let payload: ReachDeckStagedGenerationJobPayload;
  try {
    // 在冻结、登记和入队之前先做与入队相同的纯校验：确定性错误直接判失败并回滚页面，
    // 不留下队列永远不会接收的登记，也不进入协调任务的依赖故障退避。
    payload = parseReachDeckStagedGenerationJobPayload(
      await buildRegenerationPayload(context, batch, member),
    );
  } catch (error) {
    if (
      error instanceof ReachDeckNarrationPreflightError ||
      error instanceof ReachDeckInvalidGenerationPayloadError ||
      (error instanceof ContentServiceClientError && error.status < 500 && !error.retryable)
    ) {
      await finishMember(
        context,
        batch,
        member,
        'failed',
        error instanceof ReachDeckNarrationPreflightError ||
          error instanceof ReachDeckInvalidGenerationPayloadError
          ? error.code
          : 'preflight-failed',
      );
      return { status: 'waiting' };
    }
    throw error;
  }
  if (payload.kind !== 'page-generation' && payload.kind !== 'narration-generation')
    throw new Error('Invalid regeneration job kind');
  const pagePayload = payload;
  try {
    await updateMember(context, batch, member, (current) => ({
      ...current,
      jobId: pagePayload.jobId,
      requestedRevision: pagePayload.request.requestedRevision,
      attempt: pagePayload.request.attempt,
      intent: 'dispatching',
      regeneration: { ...checkpoint, payload },
    }));
  } catch (error) {
    if (!(error instanceof ReachDeckWorkspaceBatchCapacityError)) throw error;
    const latest = (await loadReachDeckWorkspaceRecovery(context)).recovery.batches[batch.batchId];
    // Frozen inputs share the batch byte budget. Wait for active siblings to release theirs;
    // only an input that still cannot fit alone is a deterministic page failure.
    if (
      latest?.members.some(
        (candidate) =>
          candidate.order !== member.order &&
          !candidate.terminalOutcome &&
          candidate.regeneration?.payload !== undefined,
      )
    ) {
      return { status: 'waiting' };
    }
    const retainedImageProof = latest?.members.some(
      (candidate) =>
        candidate.terminalOutcome === 'failed' &&
        candidate.regeneration?.stage === 'image' &&
        candidate.regeneration.payload !== undefined,
    );
    // 只有已证实的容量不足才阻止新派发；失败通道保留在失败筛选中。
    await finishMember(
      context,
      batch,
      member,
      'failed',
      retainedImageProof ? 'image-landing-failed-upstream' : 'regeneration-input-too-large',
    );
    return { status: 'waiting' };
  }
  await registerReachDeckWorkspaceJob(payload);
  await enqueue(payload, dependencies);
  await updateMember(context, batch, member, (current) => ({ ...current, intent: 'dispatched' }));
  return { status: 'waiting' };
}

async function buildRegenerationPayload(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
): Promise<ReachDeckStagedGenerationJobPayload> {
  const checkpoint = member.regeneration!;
  const plan = checkpoint.plan;
  const current = await loadReachDeckWorkspace(context);
  if (current.workspace.runId !== batch.runId || current.workspace.paused)
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_REVISION_STALE',
      'Regeneration workspace changed',
    );
  if (checkpoint.stage === 'layout' || checkpoint.stage === 'image') {
    if (
      checkpoint.stage === 'image' &&
      (!current.workspace.lessonPlan ||
        !current.workspace.pagedOutline?.pages.some((page) => page.id === member.pageId) ||
        !current.workspace.records[member.pageId] ||
        current.workspace.statuses[member.pageId]?.state === 'manual-review-required')
    )
      throw new ReachDeckNarrationPreflightError(
        'IMAGE_CONTEXT_UNAVAILABLE',
        'Image generation context is unavailable',
      );
    const unfinished = await findUnfinishedReachDeckPageNarrationJob({
      context,
      scope: batch.owner,
      runId: batch.runId,
      pageId: member.pageId,
      excludeJobId: '',
      includePageGeneration: true,
    });
    if (unfinished !== undefined)
      throw new ReachDeckNarrationPreflightError(
        'NARRATION_REVISION_STALE',
        'Another page generation is active',
      );
    const prepare = (workspace: typeof current.workspace) => {
      const request = workspace.records[member.pageId]?.request;
      if (request?.requestKey === member.requestKey) return workspace;
      const status = workspace.statuses[member.pageId];
      if (status !== undefined && ['pending', 'generating', 'narrating'].includes(status.state))
        throw new ReachDeckNarrationPreflightError(
          'NARRATION_REVISION_STALE',
          'Another page generation is active',
        );
      return requestPageGeneration(workspace, {
        pageId: member.pageId,
        attempt: (request?.attempt ?? 0) + 1,
        attemptReason: request ? 'regenerate' : 'initial',
        requestedAt: batch.createdAt,
        requestKey: member.requestKey,
        regenerationPlan: plan,
      });
    };
    const artifact = current.workspace.sceneArtifacts[member.pageId];
    const hasMediaSlots =
      artifact?.sceneType === 'slide' &&
      isNativeSlideArtifact(artifact) &&
      (artifact.generationMetadata.mediaSlots?.length ?? 0) > 0;
    const materialized = hasMediaSlots
      ? await loadReachDeckMaterializedWorkspaceDocument(context)
      : undefined;
    const binding =
      materialized?.materialized && materialized.document.schemaVersion === 'reach-deck-document/v2'
        ? materialized.document.nativeSlides.find((candidate) => candidate.pageId === member.pageId)
        : undefined;
    const pageResourceIds = binding
      ? new Set(collectReachDeckNativeSlideResourceIds(binding.slide))
      : undefined;
    const previousMedia =
      artifact?.sceneType === 'slide' &&
      isNativeSlideArtifact(artifact) &&
      artifact.generationMetadata.mediaSlots &&
      binding &&
      materialized?.materialized
        ? {
            nativeSlide: binding.slide,
            resources: {
              ...materialized.document.resources,
              media: materialized.document.resources.media.filter((resource) =>
                pageResourceIds!.has(resource.id),
              ),
            },
            mediaSlots: artifact.generationMetadata.mediaSlots,
          }
        : undefined;
    if (checkpoint.stage === 'image' && previousMedia === undefined)
      throw new ReachDeckNarrationPreflightError(
        'NARRATION_REVISION_STALE',
        'Image generation requires media slots',
      );
    const transitioned =
      checkpoint.stage === 'image'
        ? { resource: { ...current, workspace: prepare(current.workspace) } }
        : await transitionReachDeckWorkspaceForPage(
            context,
            current.draftRevision,
            member.pageId,
            prepare,
          );
    return prepareReachDeckPageGenerationJobPayload(
      transitioned.resource,
      { ...batch.owner },
      member.pageId,
      {
        voiceSelection: batch.voiceSelection,
        ...(previousMedia === undefined ? {} : { previousMedia }),
      },
    );
  }
  const requestKey = `${member.requestKey}:narration`;
  if (member.sourceKind === 'materialized-interactive') {
    const materialized = await loadReachDeckMaterializedWorkspaceDocument(context);
    if (!materialized.materialized)
      throw new ReachDeckNarrationPreflightError(
        'NARRATION_REVISION_STALE',
        'Regeneration requires a materialized document',
      );
    const page = materialized.document.pages.find((page) => page.pageId === member.pageId);
    const audioId =
      page?.sceneType === 'interactive' ? page.scene.narration?.audioResourceId : undefined;
    const supersededAudioResourceId =
      plan.channels.audio &&
      materialized.document.resources.media.some(
        (resource) => resource.id === audioId && resource.contentType.startsWith('audio/'),
      )
        ? audioId
        : undefined;
    return buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
      current,
      batch.owner,
      member.pageId,
      {
        requestKey,
        voiceSelection: batch.voiceSelection,
        ...(supersededAudioResourceId === undefined ? {} : { supersededAudioResourceId }),
        ...(plan.channels.narration
          ? {
              mode: 'regenerate-text' as const,
              ...(!plan.channels.audio ? { textOnly: true } : {}),
            }
          : {}),
      },
    );
  }
  return buildReachDeckNativeNarrationGenerationJobPayload(current, batch.owner, member.pageId, {
    requestKey,
    voiceSelection: batch.voiceSelection,
    chainId: batch.batchId,
    mode: plan.channels.narration ? 'regenerate-text' : 'saved-content',
    ...(plan.channels.narration && !plan.channels.audio
      ? { textOnly: true }
      : {
          animationMode: plan.channels.animation
            ? plan.channels.audio
              ? 'regenerate'
              : 'animations'
            : plan.audioAnimationMode === 'preserve'
              ? 'preserve'
              : 'skip',
        }),
  });
}
async function updateMember(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
  update: (current: ReachDeckWorkspaceBatchMember) => ReachDeckWorkspaceBatchMember,
) {
  return transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[batch.batchId];
    if (!current || current.phase === 'terminal' || current.cancelRequested) return batches;
    const target = current.members[member.order];
    if (!target || target.terminalOutcome) return batches;
    return {
      ...batches,
      [batch.batchId]: {
        ...current,
        revision: current.revision + 1,
        members: current.members.map((m) => (m.order === member.order ? update(m) : m)),
      },
    };
  });
}
async function finishMember(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
  outcome: 'completed' | 'failed' | 'cancelled',
  reason?: string,
  preservePayload = false,
) {
  if (outcome === 'failed' && member.regeneration?.stage === 'layout') {
    const current = await loadReachDeckWorkspace(context);
    await transitionReachDeckWorkspaceForPage(
      context,
      current.draftRevision,
      member.pageId,
      (workspace) => {
        const request = workspace.records[member.pageId]?.request;
        const status = workspace.statuses[member.pageId];
        if (
          workspace.runId !== batch.runId ||
          request?.requestKey !== member.requestKey ||
          status === undefined ||
          !['pending', 'generating', 'narrating'].includes(status.state) ||
          status.requestedRevision !== request.requestedRevision ||
          status.attempt !== request.attempt
        )
          return workspace;
        const failedAt = new Date().toISOString();
        // 只写失败状态白名单字段：展开整份 request 会带入 requestKey 等字段，被严格解析拒绝后协调器无限退避。
        return setPageGenerationStatus(
          workspace,
          {
            runId: request.runId,
            pageId: request.pageId,
            requestedRevision: request.requestedRevision,
            attempt: request.attempt,
            state: 'failed',
            retryable: true,
            message: reason ?? 'regeneration-failed',
            failedAt,
          },
          failedAt,
        );
      },
    );
  }
  await updateMember(context, batch, member, (current) => {
    const { payload: _payload, ...checkpoint } = current.regeneration!;
    return {
      ...clearImageLandingRetryReason(current),
      terminalOutcome: outcome,
      ...(reason === undefined ? {} : { reason }),
      regeneration: preservePayload ? current.regeneration : checkpoint,
    };
  });
}

function clearImageLandingRetryReason(
  member: ReachDeckWorkspaceBatchMember,
): ReachDeckWorkspaceBatchMember {
  const reason = clearReachDeckImageLandingAttempt(clearMissingResultRecoveryReason(member.reason));
  if (reason === member.reason) return member;
  const { reason: _reason, ...rest } = member;
  return { ...rest, ...(reason === undefined ? {} : { reason }) };
}

function clearMissingResultRecoveryReason(reason: string | undefined): string | undefined {
  return (
    reason
      ?.split(';')
      .filter((part) => !part.startsWith('generation-result-recovery:'))
      .join(';') || undefined
  );
}
async function enqueue(
  payload: ReachDeckStagedGenerationJobPayload,
  dependencies: ReachDeckBatchCoordinatorDependencies,
) {
  try {
    if (dependencies.enqueueGeneration) await dependencies.enqueueGeneration(payload);
    else if (dependencies.generationQueue)
      await enqueueReachDeckGenerationJobWithQueue(payload, dependencies.generationQueue);
    else await enqueueReachDeckGenerationJob(payload);
  } catch (error) {
    if (!(error instanceof ReachDeckGenerationAuditStateError)) throw error;
  }
}
function assertFrozenMember(
  payload: ReachDeckStagedGenerationJobPayload,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
) {
  if (
    (payload.kind !== 'page-generation' && payload.kind !== 'narration-generation') ||
    payload.jobId !== member.jobId ||
    payload.runId !== batch.runId ||
    payload.request.pageId !== member.pageId ||
    payload.request.requestedRevision !== member.requestedRevision ||
    payload.request.attempt !== member.attempt ||
    !sameReachDeckWorkspaceBatchOwner(batch, payload) ||
    (member.regeneration?.stage !== 'narration'
      ? payload.kind !== 'page-generation'
      : payload.kind !== 'narration-generation')
  )
    throw new Error('Regeneration checkpoint identity mismatch');
}
