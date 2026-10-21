/**
 * native 通道（materialized-native）讲稿产物的落地与收尾。
 *
 * 评审决议 3：PPTX 导入的页没有任何特殊工作区表示——讲稿产物直接编译写回物化 v2
 * 文档的 `nativeSlides[].slide`（narration + 入场动画 + duration）并 bump 页
 * revision，全程**不触碰工作区状态机、不推进生成链**。
 *
 * 写并发权衡（设计定案，前端无页锁）：教师可能在讲稿任务飞行途中继续编辑版面；
 * 一致性由落地时的 native 版面 digest 校验兜底——版面变了就丢弃产物、记中文日志、
 * 描述符标已采用（教师可再点一次），绝不把对着旧版面写的讲稿盖到新版面上。
 */

import {
  applyReachDeckNarrationToNativeSlide,
  applyReachDeckTextOnlyNarrationToNativeSlide,
  buildReachDeckMediaResourceForObjectKey,
  collectReachDeckMediaObjectKeys,
  parseReachDeckDocumentV2,
  parseReachDeckNativeSlideV2,
  reachDeckNarrationMarkdown,
  type ApplyReachDeckNarrationToNativeSlideInput,
  type ApplyReachDeckNarrationToNativeSlideResult,
  type ReachDeckDocumentV2,
  type ReachDeckNativeSlideV2,
  clearPageManualReviewRequired,
  clearSupersededPageNarrationFailure,
} from '@reachany/reach-deck-dsl';

import type {
  ReachDeckNarrationGenerationJobPayload,
  ReachDeckNativeNarrationGenerationJobResult,
} from './contracts.js';
import { actorOrganizationIdFromPayload } from './contracts.js';
import {
  buildIdempotentPageRequestKey,
  buildReachDeckNarrationStateDigest,
  buildReachDeckNativeSlideContentDigest,
  buildReachDeckPreservedNarrationDigest,
} from './job-identity.js';
import { ReachDeckGenerationAuditStateError } from './generation-audit.js';
import {
  buildReachDeckNativeNarrationGenerationJobPayload,
  isContentServiceConflict,
  loadReachDeckMaterializedWorkspaceDocument,
  locateReachDeckNativeNarrationTarget,
  type ReachDeckWorkspaceJobScope,
} from './workspace-jobs.js';
import { rematerializeReachDeckModule } from './content-service-client.js';
import {
  loadReachDeckWorkspace,
  transitionReachDeckWorkspace,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import {
  loadReachDeckWorkspaceRecovery,
  markReachDeckWorkspaceBatchMemberAudioFailed,
  markReachDeckWorkspaceBatchMemberResultDiscarded,
  markReachDeckWorkspaceJobApplied,
  registerReachDeckWorkspaceJob,
} from './workspace-recovery.js';
import { enqueueReachDeckGenerationJob } from './queue.js';
import {
  settleReachDeckAsyncWriterLeaseAfter,
  withReachDeckRetainedAsyncWriterLease,
} from './decksmith/document-writer.js';
import { assertReachDeckWorkspaceBatchJobNotCancelled } from './workspace-batch-cancellation.js';
import { sameReachDeckWorkspaceBatchOwner } from './workspace-batches.js';

export type ReachDeckNativeNarrationLandingOutcome =
  /** 本次真正写回（或重放发现已是同一产物，幂等成功）。 */
  | { status: 'applied' }
  /** 版面 digest 已对不上（教师编辑/另一次讲稿落地），产物按设计丢弃。 */
  | {
      status: 'discarded';
      code:
        | 'NARRATION_TARGET_MISSING'
        | 'NARRATION_LAYOUT_SUPERSEDED'
        | 'NARRATION_RESULT_SUPERSEDED'
        | 'NARRATION_MARKDOWN_SUPERSEDED';
      reason: string;
    };

function buildNativeNarrationApplyInput(
  product: ReachDeckNativeNarrationGenerationJobResult['nativeNarration'],
  audioResourceId?: string,
): ApplyReachDeckNarrationToNativeSlideInput {
  return {
    animationMode: product.animationMode,
    markdown: product.markdown,
    speechMarkup: product.speechMarkup,
    segments: product.segments,
    reveals: product.reveals,
    persistentElementIds: product.persistentElementIds,
    ...(audioResourceId === undefined ? {} : { audioResourceId }),
    scientificAnchorBindings: product.scientificAnchorBindings,
    duration: product.duration,
  };
}

/**
 * 产物写回 native slide：仅重写文字的产物按讲稿失效语义落地（新正文、当前版面基线，
 * 清除音频/时间轴/页时长/科学锚点与讲稿驱动动画，保留教师动画），其余走完整写回。
 */
function applyNativeNarrationProduct(
  slide: ReachDeckNativeSlideV2,
  product: ReachDeckNativeNarrationGenerationJobResult['nativeNarration'],
  audioResourceId?: string,
): ApplyReachDeckNarrationToNativeSlideResult {
  if (product.textOnly === true) {
    return {
      slide: applyReachDeckTextOnlyNarrationToNativeSlide(
        slide,
        product.markdown,
        product.speechMarkup,
      ),
      diagnostics: [],
    };
  }
  return applyReachDeckNarrationToNativeSlide(
    slide,
    buildNativeNarrationApplyInput(product, audioResourceId),
  );
}

/** Exact read-only proof used when cancellation races the final appliedAt checkpoint. */
export async function hasExactReachDeckNativeNarrationResult(
  context: ReachDeckWorkspaceContext,
  result: ReachDeckNativeNarrationGenerationJobResult,
): Promise<boolean> {
  const existing = await loadReachDeckMaterializedWorkspaceDocument(context);
  const located = locateReachDeckNativeNarrationTarget(existing, result.nativeNarration.pageId);
  if (located === undefined) return false;
  if (
    located.page.revision <= result.nativeNarration.requestedRevision ||
    buildReachDeckNativeSlideContentDigest(located.binding.slide) !==
      result.nativeNarration.nativeSlideContentDigest
  ) {
    return false;
  }
  const audioResource =
    result.nativeNarration.audioObjectKey === undefined
      ? undefined
      : buildReachDeckMediaResourceForObjectKey(result.nativeNarration.audioObjectKey);
  const applied = applyNativeNarrationProduct(
    located.binding.slide,
    result.nativeNarration,
    audioResource?.id,
  );
  return (
    jsonEqual(parseReachDeckNativeSlideV2(applied.slide), located.binding.slide) &&
    (audioResource === undefined ||
      located.document.resources.media.some(
        (candidate) =>
          candidate.id === audioResource.id && candidate.objectKey === audioResource.objectKey,
      ))
  );
}

/** One full-document writer can win per round; this covers a deterministic 16-page batch. */
const MAX_NATIVE_NARRATION_CAS_ATTEMPTS = 16;

/**
 * Continue a native whole-deck narration batch after one page has landed. The route registers
 * every page descriptor up front, while this function dispatches exactly the first descriptor in
 * the batch that has not landed yet. Payload construction happens against the latest materialized
 * document so the preceding page narration is fresh when it is injected into the prompt.
 */
async function advanceReachDeckNativeNarrationChain(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckWorkspaceJobScope,
  runId: string,
  chainId: string,
): Promise<void> {
  const [workspaceResource, existing, recoveryResource] = await Promise.all([
    loadReachDeckWorkspace(context),
    loadReachDeckMaterializedWorkspaceDocument(context),
    loadReachDeckWorkspaceRecovery(context),
  ]);
  const durableBatch = recoveryResource.recovery.batches[chainId];
  // 重新生成批次的每个成员都由协调器派发，chainId 只是批次身份，不是旧链。若这里继续推进，
  // 会给尚未落地的成员补派重复任务；被作废的重复描述符永不 applied，首页便被无限重派。
  if (durableBatch?.kind === 'regeneration') return;
  if (
    durableBatch !== undefined &&
    durableBatch.runId === runId &&
    sameReachDeckWorkspaceBatchOwner(durableBatch, context) &&
    durableBatch.kind === 'narration' &&
    durableBatch.sourceKind === 'materialized-native' &&
    durableBatch.phase !== 'terminal' &&
    !(durableBatch.phase === 'stopped' && durableBatch.stopReason === 'pruned')
  ) {
    return;
  }
  if (!existing.materialized || existing.document.schemaVersion !== 'reach-deck-document/v2')
    return;
  const orderedPages = [...existing.document.pages].sort((left, right) => left.order - right.order);
  const nativePageIds = new Set(existing.document.nativeSlides.map((binding) => binding.pageId));
  const pending = orderedPages.find((page) => {
    if (!nativePageIds.has(page.pageId)) return false;
    const descriptor = recoveryResource.recovery.jobs;
    return Object.values(descriptor).some(
      (job) =>
        job.kind === 'narration-generation' &&
        job.runId === runId &&
        job.pageId === page.pageId &&
        job.chainId === chainId &&
        job.appliedAt === undefined,
    );
  });
  if (pending === undefined) return;
  const descriptor = Object.values(recoveryResource.recovery.jobs).find(
    (job) =>
      job.kind === 'narration-generation' &&
      job.runId === runId &&
      job.pageId === pending.pageId &&
      job.chainId === chainId &&
      job.appliedAt === undefined,
  );
  if (descriptor === undefined) return;
  const voiceSelection = descriptor.voiceSelection;
  const requestKey = buildIdempotentPageRequestKey({
    idempotencyKey: chainId,
    actorId: scope.actorId,
    billingGroupId: scope.billingGroupId,
    resourceScope: scope.resourceScope,
    runId,
    pageId: pending.pageId,
    voiceSelection,
    action: 'narration-regenerate',
  });
  const payload = await buildReachDeckNativeNarrationGenerationJobPayload(
    workspaceResource,
    scope,
    pending.pageId,
    { requestKey, chainId, voiceSelection },
  );
  try {
    await registerReachDeckWorkspaceJob(payload);
    await enqueueReachDeckGenerationJob(payload);
  } catch (error) {
    if (error instanceof ReachDeckGenerationAuditStateError) return;
    throw error;
  }
}

/**
 * 以全文档 CAS 落地 native 讲稿产物。
 *
 * 数据源：content-service 的物化 v2 学习文档（nativeSlides 绑定）与创作工作区
 * （仅取 draftRevision）。核心逻辑：
 * 1. 每轮重读物化文档与工作区（向最新状态收敛），定位该页绑定；
 * 2. 校验版面 digest 未变（strip 讲稿/动画/duration 后哈希）——变了即 discarded；
 * 3. `applyReachDeckNarrationToNativeSlide` 写回 narration/入场动画/duration；
 *    产物与当前绑定逐字节一致时视为重放，直接按 applied 返回（不再写、不再 bump）；
 * 4. 整页音频登记进文档级 `resources.media`（与编译器同一 id 派生规则，按 id 去重）；
 * 5. 页 revision bump（+1）后 rematerialize 全文档 CAS；digest CAS 冲突（409）
 *    重读重试一次（digest 仍符合才写），再冲突原样抛出交由调用方按落地失败处理。
 */
export async function landReachDeckNativeNarration(
  context: ReachDeckWorkspaceContext,
  result: ReachDeckNativeNarrationGenerationJobResult,
): Promise<ReachDeckNativeNarrationLandingOutcome> {
  const product = result.nativeNarration;
  for (let round = 0; ; round += 1) {
    const [resource, existing] = await Promise.all([
      loadReachDeckWorkspace(context),
      loadReachDeckMaterializedWorkspaceDocument(context),
    ]);
    if (!existing.materialized) {
      return {
        status: 'discarded',
        code: 'NARRATION_TARGET_MISSING',
        reason: '物化学习文档已不存在',
      };
    }
    const located = locateReachDeckNativeNarrationTarget(existing, product.pageId);
    if (located === undefined) {
      return {
        status: 'discarded',
        code: 'NARRATION_TARGET_MISSING',
        reason: '物化 v2 文档或该页 nativeSlides 绑定已不存在',
      };
    }
    const { document, page, binding } = located;
    if (
      buildReachDeckNativeSlideContentDigest(binding.slide) !== product.nativeSlideContentDigest
    ) {
      return {
        status: 'discarded',
        code: 'NARRATION_LAYOUT_SUPERSEDED',
        reason: '版面内容 digest 已变化（版面被编辑或重新导入）',
      };
    }
    const audioResource =
      product.audioObjectKey === undefined
        ? undefined
        : buildReachDeckMediaResourceForObjectKey(product.audioObjectKey);
    const preservedAudioObjectKey =
      binding.slide.narration?.audioResourceId === undefined
        ? undefined
        : document.resources.media.find(
            (candidate) => candidate.id === binding.slide.narration?.audioResourceId,
          )?.objectKey;
    const applied = applyNativeNarrationProduct(binding.slide, product, audioResource?.id);
    for (const diagnostic of applied.diagnostics) {
      console.warn('Reach Deck native 讲稿写回诊断', {
        moduleVersionId: context.resourceScope.moduleVersionId,
        pageId: product.pageId,
        diagnostic,
      });
    }
    // 写回产物必须仍是严格合法的 v2 native slide；这里失败说明产物或版面已损坏，
    // 抛错走"落地失败、描述符保留"路径，绝不把坏页写进文档。
    const nextSlide = parseReachDeckNativeSlideV2(applied.slide);
    if (jsonEqual(nextSlide, binding.slide) && page.revision > product.requestedRevision) {
      // 重放同一 jobId：讲稿已在文档里，幂等成功，不再重复 bump 页 revision。
      return { status: 'applied' };
    }
    // Even unchanged saved text needs a revision checkpoint on its first landing.
    // A page revision is part of the durable job identity. Check it only after
    // the idempotent replay path above, so a recovered result that already landed
    // remains a successful no-op while a competing result cannot overwrite it.
    if (page.revision !== product.requestedRevision) {
      return {
        status: 'discarded',
        code: 'NARRATION_RESULT_SUPERSEDED',
        reason: '页 revision 已变化（结果已被更新任务 supersede）',
      };
    }
    if (
      product.animationMode === 'animations' &&
      (preservedAudioObjectKey === undefined ||
        buildReachDeckPreservedNarrationDigest(binding.slide, preservedAudioObjectKey) !==
          product.preservedNarrationDigest)
    ) {
      return {
        status: 'discarded',
        code: 'NARRATION_RESULT_SUPERSEDED',
        reason: 'Saved narration audio or timing changed',
      };
    }
    if (
      product.narrationContentDigest === undefined ||
      buildReachDeckNarrationStateDigest(
        reachDeckNarrationMarkdown(binding.slide.narration),
        binding.slide.narration?.speechMarkup,
      ) !== product.narrationContentDigest
    ) {
      return {
        status: 'discarded',
        code: 'NARRATION_MARKDOWN_SUPERSEDED',
        reason: '讲稿正文 digest 已变化（教师保存了更新正文）',
      };
    }
    const nextPages = document.pages.map((candidate) =>
      candidate.pageId === product.pageId
        ? { ...candidate, revision: candidate.revision + 1 }
        : candidate,
    );
    const nextNativeSlides = document.nativeSlides.map((candidate) =>
      candidate.pageId === product.pageId ? { ...candidate, slide: nextSlide } : candidate,
    );
    // 仅重写文字会去掉本页旧音频引用：被替换的音频资源若已无其他引用，随本次写回一并清理。
    const supersededAudio =
      product.textOnly === true && binding.slide.narration?.audioResourceId !== undefined
        ? document.resources.media.find(
            (candidate) => candidate.id === binding.slide.narration?.audioResourceId,
          )
        : undefined;
    const retainedMedia =
      supersededAudio !== undefined &&
      !collectReachDeckMediaObjectKeys({
        ...document,
        pages: nextPages,
        nativeSlides: nextNativeSlides,
      }).includes(supersededAudio.objectKey)
        ? document.resources.media.filter((candidate) => candidate.id !== supersededAudio.id)
        : document.resources.media;
    const nextMedia =
      audioResource === undefined ||
      retainedMedia.some((candidate) => candidate.id === audioResource.id)
        ? retainedMedia
        : [...retainedMedia, audioResource];
    const nextDocument: ReachDeckDocumentV2 = parseReachDeckDocumentV2({
      ...document,
      pages: nextPages,
      nativeSlides: nextNativeSlides,
      resources:
        nextMedia === document.resources.media
          ? document.resources
          : { ...document.resources, media: nextMedia },
    });
    if (existing.materialization.contentDigest.trim().length === 0) {
      throw new Error('Reach Deck materialized document is missing its content digest');
    }
    try {
      await rematerializeReachDeckModule(
        nextDocument,
        resource.draftRevision,
        existing.materialization.contentDigest,
        context,
      );
      // page.revision 已在 nextDocument 中前移；这里仅为可观测记录成功。
      console.info('Reach Deck native 讲稿产物已写回物化文档', {
        moduleVersionId: context.resourceScope.moduleVersionId,
        pageId: product.pageId,
        pageRevision: page.revision + 1,
      });
      return { status: 'applied' };
    } catch (error) {
      // Every conflict re-reads and rebases on the latest sibling pages. Keep the retry bounded so
      // a hot document returns to BullMQ, whose recovered-result path retries landing only.
      if (!isContentServiceConflict(error) || round + 1 >= MAX_NATIVE_NARRATION_CAS_ATTEMPTS) {
        throw error;
      }
    }
  }
}

/**
 * native 讲稿任务成功收尾：落地产物 + 标记描述符已采用。
 *
 * provider 工作与耐久结果都已成功；落地或 applied 标记的暂态失败必须抛回 BullMQ，
 * 让队列重放已存储的结果而不是重复模型/TTS。明确 discard 仍是终态并可标记 applied。
 * 不推进生成链、不做工作区回填；仅在确实落地后，以完成 job 的请求身份清理同一份
 * manual-review candidate，绝不根据当前 status 反推身份或清理 discarded 结果。
 * 带音频落地时一并清掉同页在产物生成之前留下的工作区讲稿阶段失败（已被本次落地取代）。
 * 两项清理都在标记采用之前完成，失败时抛回队列重放。
 */
export async function finalizeReachDeckNativeNarrationGeneration(
  payload: ReachDeckNarrationGenerationJobPayload,
  result: ReachDeckNativeNarrationGenerationJobResult,
  inherited: Pick<ReachDeckWorkspaceContext, 'documentWriterSession'> = {},
): Promise<void> {
  const scope: ReachDeckWorkspaceJobScope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
  const context: ReachDeckWorkspaceContext = { ...scope, ...inherited };
  const pageId = result.nativeNarration.pageId;
  let outcome: ReachDeckNativeNarrationLandingOutcome | undefined;
  // 落地成功后、标记采用之前清理工作区里被本次结果取代的状态。失败抛回队列：重放耐久结果时
  // 落地是幂等空操作，清理会再跑一次，之后才标记采用；标记采用之后就不再有重试机会。
  const clearSupersededWorkspaceStatuses = async (writerContext: ReachDeckWorkspaceContext) => {
    // The current status may already belong to a newer attempt. Bind cleanup to the completed
    // job so clearPageManualReviewRequired's CAS-style identity checks preserve that candidate.
    const completedRequestIdentity = {
      runId: payload.request.runId,
      pageId: payload.request.pageId,
      requestedRevision: payload.request.requestedRevision,
      attempt: payload.request.attempt,
    };
    // 带音频的讲稿取代的是产物生成之前留下的工作区讲稿失败。截止时刻取耐久结果里的
    // generatedAt：重放时不变，两次执行之间出现的新失败不会被一次空操作的重放清掉。
    const supersedesNarrationFailure =
      result.nativeNarration.audioFailureCode === undefined &&
      result.nativeNarration.textOnly !== true;
    try {
      const clearedAt = new Date().toISOString();
      await transitionReachDeckWorkspace(writerContext, (workspace) => {
        const reviewed = clearPageManualReviewRequired(
          workspace,
          completedRequestIdentity,
          clearedAt,
        );
        return supersedesNarrationFailure
          ? clearSupersededPageNarrationFailure(
              reviewed,
              pageId,
              result.nativeNarration.generatedAt,
              clearedAt,
            )
          : reviewed;
      });
    } catch (error) {
      console.error('Reach Deck native 讲稿落地后的工作区状态清理失败，等待重放', {
        jobId: payload.jobId,
        pageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  await settleReachDeckAsyncWriterLeaseAfter(context, payload.runId, () =>
    withReachDeckRetainedAsyncWriterLease({
      context,
      operationKind: 'native-narration-finalize',
      asyncRunId: payload.runId,
      operation: async (writerContext) => {
        await assertReachDeckWorkspaceBatchJobNotCancelled(payload);
        // Saved-content audio retries must preserve a still-valid old recording when TTS fails.
        // The durable result remains failed for the regeneration batch, but consumes no content.
        if (
          payload.request.sourceKind === 'materialized-native' &&
          payload.request.mode === 'saved-content' &&
          result.nativeNarration.audioFailureCode !== undefined &&
          payload.request.chainId !== undefined
        ) {
          const batch = (await loadReachDeckWorkspaceRecovery(writerContext)).recovery.batches[
            payload.request.chainId
          ];
          if (batch?.kind === 'regeneration') {
            await clearSupersededWorkspaceStatuses(writerContext);
            await markReachDeckWorkspaceJobApplied(payload.jobId, scope, new Date().toISOString());
            outcome = { status: 'applied' };
            return;
          }
        }
        try {
          outcome = await landReachDeckNativeNarration(writerContext, result);
        } catch (error) {
          // 基础设施类落地失败：保留耐久结果并抛回队列。job-runner 的 recovered-result
          // 分支会只重放 landing，不会再次调用 provider/TTS。
          console.error('Reach Deck native 讲稿产物落地失败，等待重放自愈', {
            jobId: payload.jobId,
            runId: payload.runId,
            pageId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        if (outcome.status === 'discarded') {
          console.warn('Reach Deck native 讲稿产物对应的版面已变化，产物作废丢弃', {
            jobId: payload.jobId,
            runId: payload.runId,
            pageId,
            reason: outcome.reason,
            nativeSlideContentDigest: result.nativeNarration.nativeSlideContentDigest,
          });
          await markReachDeckWorkspaceBatchMemberResultDiscarded(
            payload,
            outcome.code,
            new Date().toISOString(),
          );
          return;
        }
        if (result.nativeNarration.audioFailureCode !== undefined) {
          await markReachDeckWorkspaceBatchMemberAudioFailed(context, payload, pageId);
        }
        await clearSupersededWorkspaceStatuses(writerContext);
        try {
          await markReachDeckWorkspaceJobApplied(payload.jobId, scope, new Date().toISOString());
        } catch (error) {
          console.error('Reach Deck native 讲稿产物落地标记失败', {
            jobId: payload.jobId,
            pageId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    }),
  );
  if (outcome === undefined)
    throw new Error('Reach Deck native narration did not produce an outcome');
  if (outcome.status === 'applied') {
    // 仅重写文字只来自耐久批次，由批次协调器推进；旧链推进会按完整流水线重建载荷。
    const chainId =
      payload.request.sourceKind === 'materialized-native' && payload.request.textOnly !== true
        ? payload.request.chainId
        : undefined;
    if (chainId !== undefined) {
      try {
        await advanceReachDeckNativeNarrationChain(context, scope, payload.runId, chainId);
      } catch (error) {
        console.error('Reach Deck native 讲稿链推进失败，等待下一次完成事件自愈', {
          jobId: payload.jobId,
          runId: payload.runId,
          pageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** 结构化 JSON 等价比较（幂等重放判定用）：键序无关、undefined 键忽略。 */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftEntries = Object.entries(left as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  const rightRecord = right as Record<string, unknown>;
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return (
    leftEntries.length === rightKeys.length &&
    leftEntries.every(([key, value]) => jsonEqual(value, rightRecord[key]))
  );
}
