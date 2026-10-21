import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import { UnrecoverableError, type Job } from 'bullmq';

import type { RunRecord, ValidatedArtifactRecord } from './contracts.js';
import type { RuntimeEnv } from './env.js';
import {
  bindLessonPrepInput,
  freezeLessonPrepInput,
  lessonPrepRunReference,
  type BoundLessonPrepInput,
} from './lesson-prep-input.js';
import {
  buildLessonPrepSourceEvidenceArtifact,
  buildLessonPrepSourceEvidenceManifestArtifact,
  LessonPrepSourceClientError,
  readLessonPrepSourceEvidence,
  readStagedLessonPrepSourceEvidence,
  stageLessonPrepSourceEvidence,
  validateLessonPrepSourceEvidenceArtifact,
  validateStagedLessonPrepSourceEvidence,
} from './lesson-prep-source-client.js';
import {
  assembleLessonPrepFinalPreview,
  createLessonPrepBlueprint,
  createLessonPrepDesignSpine,
  LESSON_PREP_MODULE_PRODUCERS,
  LESSON_PREP_DESIGN_STAGES,
  generateLessonPrepSlot,
  canonicalJson,
  parseBlueprint,
  sha256Canonical,
  validateLessonPrepFinalPreviewHashes,
  validateLessonPrepSlotOutput,
  type LessonPrepBlueprint,
  type LessonPrepDesignSpine,
  type LessonPrepFinalPreview,
  type LessonPrepSlotOutput,
} from './lesson-prep-orchestrator.js';
import {
  loadBoundLessonPrepReferenceProjection,
  referenceProjectionCheckpoint,
  referencePackBindingMatches,
} from './lesson-prep-reference-packs.js';
import {
  createLessonPrepProductionPlan,
  LESSON_PREP_PRODUCTION_STAGES,
  validateLessonPrepProductionStage,
  type LessonPrepProductionStageArtifact,
} from './lesson-prep-production-plan.js';
import type { RuntimeStore } from './store/index.js';
import { lessonPrepControl, lessonPrepControlTerminalCode } from './lesson-prep-control.js';
import { createLessonPrepDiagnosticEmitter } from './lesson-prep-diagnostics.js';

const CANCELLATION_POLL_MS = 1_000;

export interface LessonPrepWorkerExecutionContext {
  env: RuntimeEnv;
  store: RuntimeStore;
  attempt: number;
  maxAttempts: number;
}

export type LessonPrepWorkerExecutor = (
  job: Job,
  context: LessonPrepWorkerExecutionContext,
) => Promise<unknown>;

class LessonPrepStoppedError extends Error {
  constructor(readonly code: 'LESSON_PREP_CANCELLED' | 'RUN_EXPIRED' | 'BUDGET_EXHAUSTED') {
    super(code);
    this.name = 'LessonPrepStoppedError';
  }
}

class LessonPrepSlotFailedError extends Error {
  constructor(readonly slotId: string) {
    super('LESSON_PREP_SLOT_RETRYABLE');
    this.name = 'LessonPrepSlotFailedError';
  }
}

/**
 * Dedicated lesson-prep worker entry point. Runtime owns immutable checkpoints and approval;
 * Content Service remains the only owner of course/module writes.
 */
export const executeTeacherLessonPrepWorkerJob: LessonPrepWorkerExecutor = async (job, context) => {
  const data = job.data as { runId?: unknown; sceneKey?: unknown } | undefined;
  const runId = typeof data?.runId === 'string' ? data.runId : '';
  if (!runId || data?.sceneKey !== 'teacher.lesson-prep') {
    throw new UnrecoverableError('LESSON_PREP_WORKER_PAYLOAD_INVALID');
  }
  const run = await context.store.getRun(runId);
  if (!run || run.sceneKey !== 'teacher.lesson-prep') {
    throw new UnrecoverableError('LESSON_PREP_WORKER_SCENE_MISMATCH');
  }
  if (run.status === 'running') {
    const interrupted = await context.store.interruptLessonPrepRun(runId);
    if (interrupted) {
      await context.store.appendEvent(runId, 'lesson-prep.run.interrupted', {
        code: 'INTERRUPTED_RESUMABLE',
      });
    }
    throw new UnrecoverableError('INTERRUPTED_RESUMABLE');
  }
  const claimed = await context.store.claimLessonPrepRun(runId);
  if (!claimed) {
    throw new UnrecoverableError('LESSON_PREP_RUN_NOT_CLAIMABLE');
  }

  const control = lessonPrepControl(claimed);
  if (!control) throw new UnrecoverableError('LESSON_PREP_CONTROL_INVALID');
  const deadlineAt = Date.parse(control.deadlineAt);
  const monitor = monitorRun(context.store, runId, deadlineAt);
  const diagnostics = createLessonPrepDiagnosticEmitter(context.store, runId, context.attempt);
  try {
    await ensureRunActive(context.store, runId, deadlineAt);
    const frozenInput = await loadFrozenInput(context.store, claimed);
    const referenceBinding = {
      organizationId: claimed.actor.orgId,
      courseId: claimed.domainScope.courseId ?? '',
      runId: claimed.id,
      actorAccountId: claimed.actor.subject,
      frozenInputHash: frozenInput.frozenInputHash,
    };
    const referenceProjection = loadBoundLessonPrepReferenceProjection(
      'course_architecture',
      referenceBinding,
    );
    const designReferenceProjections = {
      'course-architecture': referenceProjection,
      'pedagogical-design': loadBoundLessonPrepReferenceProjection(
        'pedagogical_design',
        referenceBinding,
      ),
      'method-wisdom-alignment': loadBoundLessonPrepReferenceProjection(
        'method_wisdom_alignment',
        referenceBinding,
      ),
    } as const;
    await context.store.appendEvent(runId, 'lesson-prep.stage.started', {
      stage: 'intake',
      attempt: context.attempt,
      recovered: control.resumeCount > 0,
      inputSnapshot: frozenInput.contentSha256,
    });

    const sourceEvidenceArtifact = await loadOrCreateSourceEvidenceArtifact(
      context.store,
      claimed,
      frozenInput,
      context.env,
      diagnostics,
    );
    if (
      frozenInput.payload.sourceAssets.length > 0 &&
      sourceEvidenceArtifact.promptProjectionCoverage !== 'complete' &&
      !(
        sourceEvidenceArtifact.schema === 'lesson-prep-source-evidence/v2' &&
        sourceEvidenceArtifact.evidenceAsset !== null
      )
    ) {
      throw new Error('LESSON_PREP_SOURCE_EVIDENCE_PROJECTION_INCOMPLETE');
    }
    const designSpineCheckpoint = await loadDesignSpineCheckpoint(context.store, claimed);
    let designSpineArtifact: ValidatedArtifactRecord;
    if (!designSpineCheckpoint) {
      const stageSlots = await context.store.putLessonPrepCheckpoint(
        claimed,
        {
          artifactType: 'lesson-prep-source-evidence/v1',
          contentSha256: sha256Canonical(sourceEvidenceArtifact),
          domainRef: {
            ...claimed.domainScope,
            sourceManifestSha256: frozenInput.binding.sourceManifestSha256,
          },
          changeSet: sourceEvidenceArtifact as unknown as Record<string, unknown>,
        },
        'sourceEvidence',
        [...LESSON_PREP_DESIGN_STAGES, ...LESSON_PREP_PRODUCTION_STAGES],
      );
      if (!stageSlots) throw new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
    }
    let blueprint: LessonPrepBlueprint;
    let blueprintArtifact: ValidatedArtifactRecord;
    if (designSpineCheckpoint) {
      const expectedReferencePack = {
        ...referenceProjectionCheckpoint(referenceProjection),
      };
      const courseArchitectureStage = designSpineCheckpoint.spine.stages.find(
        (stage) => stage.stageId === 'course-architecture',
      );
      if (
        !referencePackBindingMatches(frozenInput.payload.referencePackBinding) ||
        !courseArchitectureStage?.referencePack ||
        JSON.stringify(courseArchitectureStage.referencePack) !==
          JSON.stringify(expectedReferencePack)
      ) {
        throw new Error('LESSON_PREP_REFERENCE_PACK_CHECKPOINT_INVALID');
      }
      for (const [stageId, projection] of Object.entries(designReferenceProjections)) {
        const stage = designSpineCheckpoint.spine.stages.find((item) => item.stageId === stageId);
        if (
          !stage ||
          JSON.stringify(stage.referencePack) !==
            JSON.stringify(referenceProjectionCheckpoint(projection))
        ) {
          throw new Error('LESSON_PREP_REFERENCE_PACK_CHECKPOINT_INVALID');
        }
      }
      designSpineArtifact = designSpineCheckpoint.artifact;
      blueprint = designSpineCheckpoint.spine.blueprint;
      const existingBlueprint = await loadBlueprintCheckpoint(context.store, claimed);
      if (!existingBlueprint) throw new Error('LESSON_PREP_BLUEPRINT_CHECKPOINT_INVALID');
      blueprintArtifact = existingBlueprint.artifact;
      await context.store.appendEvent(runId, 'lesson-prep.stage.reused', {
        stage: 'design-spine',
        artifactId: designSpineCheckpoint.artifact.id,
        contentSha256: designSpineCheckpoint.artifact.contentSha256,
      });
      for (const stage of designSpineCheckpoint.spine.stages) {
        await context.store.appendEvent(runId, 'lesson-prep.stage.reused', {
          stage: stage.stageId,
          contentSha256: stage.contentSha256,
        });
      }
    } else {
      for (const stage of [
        'resource-integration',
        'course-architecture',
        'pedagogical-design',
        'method-wisdom-alignment',
        'course-blueprint-foundation',
      ]) {
        await context.store.appendEvent(runId, 'lesson-prep.stage.started', {
          stage,
          attempt: context.attempt,
        });
      }
      const spineResult = await createLessonPrepDesignSpine(
        claimed,
        frozenInput,
        context.env,
        sourceEvidenceArtifact.promptProjection,
        monitor.signal,
        async (stageId) => {
          if (!(await context.store.beginLessonPrepModelCall(runId, stageId, 'author'))) {
            throw new Error('LESSON_PREP_MODEL_BUDGET_REJECTED');
          }
        },
        async (stage) => {
          const stageArtifact = await context.store.putLessonPrepStageCheckpoint(
            claimed,
            {
              artifactType: `lesson-prep-stage/${stage.stageId}/v1`,
              contentSha256: sha256Canonical(stage),
              domainRef: { ...claimed.domainScope, stageId: stage.stageId },
              changeSet: stage as unknown as Record<string, unknown>,
            },
            stage.stageId,
          );
          if (!stageArtifact) throw new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
          await context.store.appendEvent(runId, 'lesson-prep.stage.completed', {
            stage: stage.stageId,
            artifactId: stageArtifact.id,
            contentSha256: stageArtifact.contentSha256,
          });
        },
        async (stageId) => loadDesignStageCheckpoint(context.store, claimed, stageId),
        (await loadBlueprintCheckpoint(context.store, claimed))?.blueprint,
        referenceProjection,
        designReferenceProjections,
      );
      for (const usage of spineResult.usage)
        await context.store.recordLessonPrepUsage(claimed, usage);
      blueprint = spineResult.spine.blueprint;
      const blueprintResult = { contentSha256: sha256Canonical(blueprint) };
      const committedBlueprint = await context.store.putLessonPrepCheckpoint(
        claimed,
        {
          artifactType: 'lesson-prep-blueprint/v1',
          contentSha256: blueprintResult.contentSha256,
          domainRef: claimed.domainScope,
          changeSet: blueprint as unknown as Record<string, unknown>,
        },
        'blueprint',
        blueprint.lessons.flatMap((lesson) => lesson.modules.map((module) => module.slotId)),
      );
      if (!committedBlueprint) throw new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
      blueprintArtifact = committedBlueprint;
      const spineArtifact = await context.store.putLessonPrepCheckpoint(
        claimed,
        {
          artifactType: 'lesson-prep-design-spine/v1',
          contentSha256: sha256Canonical(spineResult.spine),
          domainRef: claimed.domainScope,
          changeSet: spineResult.spine as unknown as Record<string, unknown>,
        },
        'designSpine',
      );
      if (!spineArtifact) throw new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
      designSpineArtifact = spineArtifact;
    }

    const slots = blueprint.lessons.flatMap((lesson) =>
      lesson.modules.map((module) => ({
        lessonId: lesson.lessonId,
        slotId: module.slotId,
        moduleType: module.moduleType,
        status: 'planned',
      })),
    );
    await context.store.appendEvent(runId, 'lesson-prep.blueprint.ready', {
      artifactId: blueprintArtifact.id,
      contentSha256: blueprintArtifact.contentSha256,
      lessonCount: blueprint.lessons.length,
      slotCount: slots.length,
      moduleTypes: [...new Set(slots.map((slot) => slot.moduleType))],
      staged: true,
    });
    await context.store.appendEvent(runId, 'lesson-prep.gate.passed', {
      gate: 'blueprint-deterministic/v1',
      checks: [
        'supported-module-types',
        'bounded-slot-count',
        'stable-identities',
        'ordered-lessons',
      ],
    });

    const sourceEvidenceSha256 = sha256Canonical(sourceEvidenceArtifact);
    const productionSpine =
      designSpineCheckpoint?.spine ??
      (await loadDesignSpineCheckpoint(context.store, claimed))!.spine;
    const productionStages = await Promise.all(
      LESSON_PREP_PRODUCTION_STAGES.map((stageId) =>
        loadProductionStageCheckpoint(context.store, claimed, stageId),
      ),
    );
    const expectedProductionReferencePacks = {
      'lesson-choreography': referenceProjectionCheckpoint(
        loadBoundLessonPrepReferenceProjection('lesson_choreography', referenceBinding),
      ),
      'module-orchestration': referenceProjectionCheckpoint(
        loadBoundLessonPrepReferenceProjection('module_orchestration', referenceBinding),
      ),
    } as const;
    for (const stage of productionStages) {
      if (
        stage &&
        (!referencePackBindingMatches(stage.referencePackBinding) ||
          JSON.stringify(stage.referencePack) !==
            JSON.stringify(expectedProductionReferencePacks[stage.stageId]))
      ) {
        throw new Error('LESSON_PREP_REFERENCE_PACK_CHECKPOINT_INVALID');
      }
    }
    if (productionStages.some((stage) => stage === null)) {
      for (const stage of LESSON_PREP_PRODUCTION_STAGES) {
        await context.store.appendEvent(runId, 'lesson-prep.stage.started', {
          stage,
          attempt: context.attempt,
        });
      }
      const plan = await createLessonPrepProductionPlan(
        claimed,
        frozenInput,
        context.env,
        productionSpine,
        designSpineArtifact.contentSha256,
        sourceEvidenceSha256,
        monitor.signal,
        async (stageId) => {
          if (!(await context.store.beginLessonPrepModelCall(runId, stageId, 'author'))) {
            throw new Error('LESSON_PREP_MODEL_BUDGET_REJECTED');
          }
        },
        async (stage) => {
          const stored = await context.store.putLessonPrepStageCheckpoint(
            claimed,
            {
              artifactType: `lesson-prep-stage/${stage.stageId}/v1`,
              contentSha256: stage.contentSha256,
              domainRef: { ...claimed.domainScope, stageId: stage.stageId },
              changeSet: stage as unknown as Record<string, unknown>,
            },
            stage.stageId,
          );
          if (!stored) throw new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
          await context.store.appendEvent(runId, 'lesson-prep.stage.completed', {
            stage: stage.stageId,
            artifactId: stored.id,
            contentSha256: stored.contentSha256,
          });
        },
        async (stageId) => loadProductionStageCheckpoint(context.store, claimed, stageId),
        {
          'lesson-choreography': loadBoundLessonPrepReferenceProjection(
            'lesson_choreography',
            referenceBinding,
          ),
          'module-orchestration': loadBoundLessonPrepReferenceProjection(
            'module_orchestration',
            referenceBinding,
          ),
        },
      );
      for (const usage of plan.usage) await context.store.recordLessonPrepUsage(claimed, usage);
    }

    const choreographyCheckpoint = await loadProductionStageCheckpointRecord(
      context.store,
      claimed,
      'lesson-choreography',
    );
    const orchestrationCheckpoint = await loadProductionStageCheckpointRecord(
      context.store,
      claimed,
      'module-orchestration',
    );
    if (!choreographyCheckpoint || !orchestrationCheckpoint) {
      throw new Error('LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID');
    }
    if (
      !validateLessonPrepProductionStage(
        choreographyCheckpoint.stage,
        'lesson-choreography',
        productionSpine,
        designSpineArtifact.contentSha256,
        sourceEvidenceSha256,
        designSpineArtifact.contentSha256,
      ) ||
      !validateLessonPrepProductionStage(
        orchestrationCheckpoint.stage,
        'module-orchestration',
        productionSpine,
        designSpineArtifact.contentSha256,
        sourceEvidenceSha256,
        choreographyCheckpoint.stage.contentSha256,
      )
    ) {
      throw new Error('LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID');
    }
    if (productionStages.every((stage) => stage !== null)) {
      for (const stage of productionStages) {
        await context.store.appendEvent(runId, 'lesson-prep.stage.reused', {
          stage: stage!.stageId,
          contentSha256: stage!.contentSha256,
        });
      }
    }
    const orchestrationArtifactId = orchestrationCheckpoint.artifact.id;
    const orchestrationSha256 = orchestrationCheckpoint.artifact.contentSha256;
    const orchestrationSlotContracts = new Map(
      orchestrationCheckpoint.stage.slots.map((slot) => [slot.slotId, slot]),
    );
    const producerReferenceProjections = {
      'reach-deck': loadBoundLessonPrepReferenceProjection(
        'module_orchestration',
        referenceBinding,
      ),
      quiz: loadBoundLessonPrepReferenceProjection('mastery_assessment', referenceBinding),
      'spaced-review': loadBoundLessonPrepReferenceProjection(
        'mastery_assessment',
        referenceBinding,
      ),
    } as const;

    await ensureRunActive(context.store, runId, deadlineAt);
    const finalCheckpoint = await loadFinalPreviewCheckpoint(context.store, claimed);
    let finalPreview: LessonPrepFinalPreview;
    let finalContentSha256: string;
    if (finalCheckpoint) {
      finalPreview = finalCheckpoint.preview;
      const expectedReferenceBySlot = Object.fromEntries(
        slots.map((slot) => [
          slot.slotId,
          referenceProjectionCheckpoint(producerReferenceProjections[slot.moduleType]),
        ]),
      );
      if (
        !finalPreview.referencePackBySlot ||
        JSON.stringify(finalPreview.referencePackBySlot) !== JSON.stringify(expectedReferenceBySlot)
      ) {
        throw new Error('LESSON_PREP_REFERENCE_PACK_CHECKPOINT_INVALID');
      }
      finalContentSha256 = finalCheckpoint.artifact.contentSha256;
      await context.store.appendEvent(runId, 'lesson-prep.stage.reused', {
        stage: 'final-preview',
        artifactId: finalCheckpoint.artifact.id,
        contentSha256: finalContentSha256,
      });
    } else {
      await context.store.appendEvent(runId, 'lesson-prep.stage.started', {
        stage: 'module-production',
        attempt: context.attempt,
        slotCount: slots.length,
      });
      const descriptors = blueprint.lessons.flatMap((lesson) =>
        lesson.modules.map((slot) => ({ lesson, slot })),
      );
      const current = (await context.store.getRun(runId)) ?? claimed;
      const outputs = await mapWithConcurrency(descriptors, 3, async ({ lesson, slot }) => {
        await ensureRunActive(context.store, runId, deadlineAt);
        const checkpoint = await loadSlotCheckpoint(
          context.store,
          current,
          frozenInput.frozenInputHash,
          blueprintArtifact,
          lesson.lessonId,
          slot.slotId,
          slot.moduleType,
          orchestrationArtifactId,
          orchestrationSha256,
          orchestrationSlotContracts.get(slot.slotId),
          referenceProjectionCheckpoint(producerReferenceProjections[slot.moduleType]),
        );
        if (checkpoint) {
          await context.store.appendEvent(runId, 'lesson-prep.slot.reused', {
            slotId: slot.slotId,
            artifactId: checkpoint.artifact.id,
            contentSha256: checkpoint.artifact.contentSha256,
          });
          return checkpoint.output;
        }
        try {
          const generated = await generateLessonPrepSlot(
            claimed,
            frozenInput,
            blueprintArtifact.id,
            blueprintArtifact.contentSha256,
            lesson,
            slot,
            context.env,
            {
              beforeCall: async (kind) => {
                if (!(await context.store.beginLessonPrepModelCall(runId, slot.slotId, kind))) {
                  throw new Error('LESSON_PREP_MODEL_BUDGET_REJECTED');
                }
              },
              onUsage: (usage) =>
                context.store.recordLessonPrepUsage(claimed, usage, [slot.slotId]),
            },
            monitor.signal,
            {
              moduleOrchestrationArtifactId: orchestrationArtifactId,
              moduleOrchestrationSha256: orchestrationSha256,
              slotContractSha256: orchestrationSlotContractSha256(
                orchestrationArtifactId,
                orchestrationSha256,
                getOrchestrationSlotContract(
                  orchestrationSlotContracts,
                  slot.slotId,
                  lesson.lessonId,
                  slot.moduleType,
                ),
              ),
              authoringContext: orchestrationSlotContracts.get(slot.slotId) as
                | Record<string, unknown>
                | undefined,
            },
            producerReferenceProjections[slot.moduleType],
          );
          validateGeneratedSlotProducerBinding(
            generated.output,
            orchestrationArtifactId,
            orchestrationSha256,
            getOrchestrationSlotContract(
              orchestrationSlotContracts,
              slot.slotId,
              lesson.lessonId,
              slot.moduleType,
            ),
            orchestrationSlotContractSha256(
              orchestrationArtifactId,
              orchestrationSha256,
              getOrchestrationSlotContract(
                orchestrationSlotContracts,
                slot.slotId,
                lesson.lessonId,
                slot.moduleType,
              ),
            ),
          );
          const artifact = await context.store.putLessonPrepSlotCheckpoint(
            claimed,
            {
              artifactType: 'lesson-prep-slot-output/v1',
              contentSha256: generated.contentSha256,
              domainRef: { courseId: claimed.domainScope.courseId ?? '', slotId: slot.slotId },
              changeSet: generated.output as unknown as Record<string, unknown>,
            },
            slot.slotId,
          );
          if (!artifact) throw new Error('LESSON_PREP_SLOT_COMMIT_REJECTED');
          await context.store.appendEvent(runId, 'lesson-prep.slot.completed', {
            slotId: slot.slotId,
            artifactId: artifact.id,
            contentSha256: artifact.contentSha256,
          });
          return generated.output;
        } catch (error) {
          if (guardrailCode(error)) throw error;
          const stopped = await classifyStopped(context.store, runId, deadlineAt, error);
          if (stopped) throw stopped;
          const failed = await context.store.failLessonPrepSlot(runId, slot.slotId, {
            code: 'LESSON_PREP_SLOT_RETRYABLE',
            message: 'A lesson-prep slot failed and may be retried once by the initiating teacher.',
          });
          if (failed) {
            await context.store.appendEvent(runId, 'lesson-prep.slot.failed', {
              slotId: slot.slotId,
              code: 'LESSON_PREP_SLOT_RETRYABLE',
            });
          }
          throw new LessonPrepSlotFailedError(slot.slotId);
        }
      });
      const finalResult = assembleLessonPrepFinalPreview(
        claimed,
        frozenInput,
        blueprintArtifact.id,
        blueprintArtifact.contentSha256,
        blueprint,
        outputs,
        {
          artifactId: orchestrationArtifactId,
          sha256: orchestrationSha256,
          slotContractSha256BySlot: Object.fromEntries(
            [...orchestrationSlotContracts.entries()].map(([slotId, contract]) => [
              slotId,
              orchestrationSlotContractSha256(
                orchestrationArtifactId,
                orchestrationSha256,
                contract,
              ),
            ]),
          ),
        },
      );
      finalPreview = finalResult.preview;
      finalContentSha256 = finalResult.contentSha256;
    }

    await validateLessonPrepFinalPreviewBoundary(
      context.store,
      (await context.store.getRun(runId)) ?? claimed,
      frozenInput,
      blueprint,
      blueprintArtifact,
      finalPreview,
      orchestrationArtifactId,
      orchestrationSha256,
      orchestrationSlotContracts,
    );

    await ensureRunActive(context.store, runId, deadlineAt);
    const proposal = await proposeFinalPreview(
      context.store,
      claimed,
      finalPreview,
      finalContentSha256,
    );
    return {
      runId,
      status: 'waiting_approval',
      artifactId: proposal.artifactId,
      approvalId: proposal.approval.id,
    };
  } catch (error) {
    const guardrail = guardrailCode(error);
    if (guardrail) {
      await context.store.failLessonPrepRun(runId, { code: guardrail, message: guardrail });
      throw new UnrecoverableError(guardrail);
    }
    if (error instanceof LessonPrepSlotFailedError) {
      throw new UnrecoverableError('LESSON_PREP_SLOT_RETRYABLE');
    }
    const stopped = await classifyStopped(context.store, runId, deadlineAt, error);
    if (stopped) {
      if (stopped.code === 'RUN_EXPIRED' || stopped.code === 'BUDGET_EXHAUSTED') {
        await context.store.failLessonPrepRun(runId, {
          code: stopped.code,
          message:
            stopped.code === 'RUN_EXPIRED'
              ? 'The lesson-prep run exceeded its 24-hour deadline.'
              : 'The lesson-prep run exhausted its frozen execution budget.',
        });
      }
      throw new UnrecoverableError(stopped.code);
    }
    const invalidCode = deterministicFailureCode(error);
    if (invalidCode) {
      await context.store.failLessonPrepRun(runId, {
        code: invalidCode,
        message: deterministicFailureMessage(invalidCode),
      });
      throw new UnrecoverableError(invalidCode);
    }
    const interrupted = await context.store.interruptLessonPrepRun(runId);
    if (interrupted) {
      await context.store.appendEvent(runId, 'lesson-prep.run.interrupted', {
        code: 'INTERRUPTED_RESUMABLE',
      });
    }
    throw new UnrecoverableError(
      interrupted ? 'INTERRUPTED_RESUMABLE' : 'LESSON_PREP_RUN_NOT_INTERRUPTIBLE',
    );
  } finally {
    monitor.stop();
  }
};

async function loadOrCreateSourceEvidenceArtifact(
  store: RuntimeStore,
  run: RunRecord,
  frozenInput: BoundLessonPrepInput,
  env: RuntimeEnv,
  diagnostics: import('./lesson-prep-diagnostics.js').LessonPrepDiagnosticEmitter,
) {
  const expected = {
    runId: run.id,
    courseId: run.domainScope.courseId ?? '',
    sourceManifestSha256: frozenInput.binding.sourceManifestSha256,
  };
  const existingManifest = await store.getLatestArtifact(run.id, 'lesson-prep-source-evidence/v2');
  if (existingManifest) {
    const manifest = validateLessonPrepSourceEvidenceArtifact(existingManifest.changeSet, expected);
    if (sha256Canonical(manifest) !== existingManifest.contentSha256) {
      throw new Error('LESSON_PREP_SOURCE_EVIDENCE_CHECKPOINT_INVALID');
    }
    if (manifest.schema === 'lesson-prep-source-evidence/v2' && manifest.evidenceAsset) {
      const body = await readStagedLessonPrepSourceEvidence(
        {
          runId: run.id,
          courseId: expected.courseId,
          actor: run.actor,
          assetId: manifest.evidenceAsset.assetId,
          bodySha256: manifest.evidenceAsset.bodySha256,
        },
        { env },
      );
      validateStagedLessonPrepSourceEvidence(body, expected, manifest);
    }
    await store.appendEvent(run.id, 'lesson-prep.source-evidence.reused', {
      artifactId: existingManifest.id,
      contentSha256: existingManifest.contentSha256,
      evidenceCount: manifest.evidence.length,
      promptProjectionChars: manifest.promptProjection.length,
    });
    return manifest;
  }
  const existing = await store.getLatestArtifact(run.id, 'lesson-prep-source-evidence/v1');
  if (existing) {
    const artifact = validateLessonPrepSourceEvidenceArtifact(existing.changeSet, expected);
    if (sha256Canonical(artifact) !== existing.contentSha256) {
      throw new Error('LESSON_PREP_SOURCE_EVIDENCE_CHECKPOINT_INVALID');
    }
    await store.appendEvent(run.id, 'lesson-prep.source-evidence.reused', {
      artifactId: existing.id,
      contentSha256: existing.contentSha256,
      evidenceCount: artifact.evidence.length,
      promptProjectionChars: artifact.promptProjection.length,
    });
    return artifact;
  }
  const evidence =
    frozenInput.payload.sourceAssets.length === 0
      ? []
      : await readLessonPrepSourceEvidence(
          { runId: run.id, courseId: expected.courseId, actor: run.actor },
          { env, diagnostics },
        );
  const artifact = buildLessonPrepSourceEvidenceArtifact({
    ...expected,
    sourceAssets: frozenInput.payload.sourceAssets,
    evidence,
  });
  const body = new TextEncoder().encode(
    canonicalJson({ ...artifact, schema: 'lesson-prep-source-evidence/v2' }),
  );
  let staged: Awaited<ReturnType<typeof stageLessonPrepSourceEvidence>> | null = null;
  if (evidence.length > 0) {
    await diagnostics('evidence-staging', 'started');
    try {
      staged = await stageLessonPrepSourceEvidence(
        {
          runId: run.id,
          courseId: expected.courseId,
          actor: run.actor,
          sourceManifestSha256: expected.sourceManifestSha256,
          extractorVersion: artifact.extractorVersion,
          modelRoute: artifact.modelRoute,
          projectionSha256: artifact.promptProjectionSha256,
          projectionChars: artifact.promptProjection.length,
          body,
        },
        { env },
      );
      await diagnostics('evidence-staging', 'succeeded');
    } catch (error) {
      await diagnostics('evidence-staging', 'failed', lessonPrepEvidenceDiagnosticCode(error));
      throw error;
    }
  }
  const manifest = buildLessonPrepSourceEvidenceManifestArtifact(artifact, staged);
  const stored = await store.putLessonPrepCheckpoint(
    run,
    {
      artifactType: 'lesson-prep-source-evidence/v2',
      contentSha256: sha256Canonical(manifest),
      domainRef: { ...run.domainScope, sourceManifestSha256: expected.sourceManifestSha256 },
      changeSet: manifest as unknown as Record<string, unknown>,
    },
    'sourceEvidence',
  );
  if (!stored) throw new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
  await store.appendEvent(run.id, 'lesson-prep.source-evidence.ready', {
    artifactId: stored.id,
    contentSha256: stored.contentSha256,
    evidenceCount: manifest.evidence.length,
    promptProjectionChars: manifest.promptProjection.length,
  });
  return manifest;
}

async function proposeFinalPreview(
  store: RuntimeStore,
  run: RunRecord,
  preview: LessonPrepFinalPreview,
  contentSha256: string,
) {
  const proposed = await store.proposeLessonPrepFinalPreview(run, {
    artifactType: 'lesson-prep-final-preview/v1',
    stakesTier: 'teacher',
    domainRef: run.domainScope,
    baseRevision: String(preview.expectedWorkspaceLockVersion),
    contentSha256,
    changeSet: preview as unknown as Record<string, unknown>,
  });
  if (!proposed) {
    throw new Error('LESSON_PREP_STAGE_COMMIT_REJECTED');
  }
  return proposed;
}

async function loadFrozenInput(store: RuntimeStore, run: RunRecord) {
  try {
    const reference = JSON.parse(run.input.message) as Record<string, unknown>;
    if (
      reference.schema !== 'lesson-prep-run-reference/v1' ||
      typeof reference.artifactId !== 'string' ||
      typeof reference.contentSha256 !== 'string' ||
      typeof reference.frozenInputHash !== 'string' ||
      reference.promptOwnerAllowlistVersion !== 'lesson-prep-prompt-owners/v1'
    ) {
      throw new Error('invalid frozen input reference');
    }
    const artifact = await store.getValidatedArtifact(
      run.id,
      reference.artifactId,
      'lesson-prep-run-input/v1',
    );
    if (!artifact || artifact.contentSha256 !== reference.frozenInputHash) {
      throw new Error('input artifact unavailable');
    }
    const frozen = artifact.changeSet as unknown as BoundLessonPrepInput;
    if (frozen.schema !== 'lesson-prep-run-input/v1')
      throw new Error('invalid frozen input schema');
    const validated = freezeLessonPrepInput(frozen.payload);
    const rebound = bindLessonPrepInput(validated, {
      organizationId: run.actor.orgId,
      actorAccountId: run.actor.subject,
      courseId: run.domainScope.courseId ?? '',
      runId: run.id,
      expectedWorkspaceLockVersion: Number(run.domainScope.expectedWorkspaceLockVersion),
      sourceManifestSha256: frozen.binding.sourceManifestSha256,
    });
    if (
      rebound.frozenInputHash !== frozen.frozenInputHash ||
      JSON.stringify(lessonPrepRunReference(artifact.id, rebound)) !== JSON.stringify(reference)
    ) {
      throw new Error('frozen input binding mismatch');
    }
    return rebound;
  } catch {
    throw new Error('LESSON_PREP_INPUT_INVALID');
  }
}

async function loadBlueprintCheckpoint(
  store: RuntimeStore,
  run: RunRecord,
): Promise<{ blueprint: LessonPrepBlueprint; artifact: ValidatedArtifactRecord } | null> {
  const artifact = await store.getLatestArtifact(run.id, 'lesson-prep-blueprint/v1');
  if (!artifact) return null;
  const blueprint = parseBlueprint(JSON.stringify(artifact.changeSet));
  if (!blueprint || sha256Canonical(blueprint) !== artifact.contentSha256) {
    throw new Error('LESSON_PREP_BLUEPRINT_CHECKPOINT_INVALID');
  }
  return { blueprint, artifact };
}

async function loadDesignSpineCheckpoint(
  store: RuntimeStore,
  run: RunRecord,
): Promise<{ spine: LessonPrepDesignSpine; artifact: ValidatedArtifactRecord } | null> {
  const artifact = await store.getLatestArtifact(run.id, 'lesson-prep-design-spine/v1');
  if (!artifact) return null;
  const value = artifact.changeSet as unknown as LessonPrepDesignSpine;
  if (
    value.schema !== 'lesson-prep-design-spine/v1' ||
    !Array.isArray(value.stages) ||
    !value.blueprint ||
    sha256Canonical(value) !== artifact.contentSha256
  ) {
    throw new Error('LESSON_PREP_DESIGN_SPINE_CHECKPOINT_INVALID');
  }
  return { spine: value, artifact };
}

async function loadDesignStageCheckpoint(
  store: RuntimeStore,
  run: RunRecord,
  stageId: string,
): Promise<import('./lesson-prep-orchestrator.js').LessonPrepDesignStageArtifact | null> {
  const artifact = await store.getLatestArtifact(run.id, `lesson-prep-stage/${stageId}/v1`);
  if (!artifact) return null;
  if (sha256Canonical(artifact.changeSet) !== artifact.contentSha256) {
    throw new Error('LESSON_PREP_DESIGN_SPINE_CHECKPOINT_INVALID');
  }
  return artifact.changeSet as unknown as import('./lesson-prep-orchestrator.js').LessonPrepDesignStageArtifact;
}

async function loadProductionStageCheckpoint(
  store: RuntimeStore,
  run: RunRecord,
  stageId: (typeof LESSON_PREP_PRODUCTION_STAGES)[number],
): Promise<LessonPrepProductionStageArtifact | null> {
  const artifact = await store.getLatestArtifact(run.id, `lesson-prep-stage/${stageId}/v1`);
  if (!artifact) return null;
  const value = artifact.changeSet as unknown as LessonPrepProductionStageArtifact;
  const { contentSha256, ...withoutDigest } = value;
  if (
    value.stageId !== stageId ||
    value.contentSha256 !== artifact.contentSha256 ||
    sha256Canonical(withoutDigest) !== contentSha256
  ) {
    throw new Error('LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID');
  }
  return value;
}

async function loadProductionStageCheckpointRecord(
  store: RuntimeStore,
  run: RunRecord,
  stageId: (typeof LESSON_PREP_PRODUCTION_STAGES)[number],
): Promise<{ stage: LessonPrepProductionStageArtifact; artifact: ValidatedArtifactRecord } | null> {
  const artifact = await store.getLatestArtifact(run.id, `lesson-prep-stage/${stageId}/v1`);
  if (!artifact) return null;
  const value = artifact.changeSet as unknown as LessonPrepProductionStageArtifact;
  const { contentSha256, ...withoutDigest } = value;
  if (
    value.stageId !== stageId ||
    value.contentSha256 !== artifact.contentSha256 ||
    sha256Canonical(withoutDigest) !== contentSha256
  ) {
    throw new Error('LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID');
  }
  return { stage: value, artifact };
}

export async function loadSlotCheckpoint(
  store: RuntimeStore,
  run: RunRecord,
  frozenInputHash: string,
  blueprintArtifact: ValidatedArtifactRecord,
  lessonId: string,
  slotId: string,
  moduleType: LessonPrepSlotOutput['moduleType'],
  orchestrationArtifactId?: string,
  orchestrationSha256?: string,
  orchestrationSlotContract?: unknown,
  expectedReferencePack?: ReturnType<typeof referenceProjectionCheckpoint>,
): Promise<{ output: LessonPrepSlotOutput; artifact: ValidatedArtifactRecord } | null> {
  const control = lessonPrepControl(run);
  const slot = control?.slots[slotId];
  if (!slot) throw new Error('LESSON_PREP_SLOT_CHECKPOINT_INVALID');
  if (slot.status !== 'completed') {
    if (slot.checkpoint) throw new Error('LESSON_PREP_SLOT_CHECKPOINT_INVALID');
    return null;
  }
  if (!slot.checkpoint) throw new Error('LESSON_PREP_SLOT_CHECKPOINT_INVALID');
  const artifact = await store.getValidatedArtifact(
    run.id,
    slot.checkpoint.artifactId,
    'lesson-prep-slot-output/v1',
  );
  if (
    !artifact ||
    artifact.id !== slot.checkpoint.artifactId ||
    artifact.contentSha256 !== slot.checkpoint.contentSha256 ||
    artifact.domainRef.courseId !== run.domainScope.courseId ||
    artifact.domainRef.slotId !== slotId
  ) {
    throw new Error('LESSON_PREP_SLOT_CHECKPOINT_INVALID');
  }
  const output = artifact.changeSet as unknown as LessonPrepSlotOutput;
  const prepared = output.preparedModule;
  if (orchestrationArtifactId !== undefined && !sha256(orchestrationSha256)) {
    throw new Error('LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID');
  }
  const expectedSlotContractSha256 =
    orchestrationArtifactId !== undefined
      ? isOrchestrationSlotContract(orchestrationSlotContract)
        ? orchestrationSlotContractSha256(
            orchestrationArtifactId!,
            orchestrationSha256!,
            orchestrationSlotContract,
          )
        : (() => {
            throw new Error('LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID');
          })()
      : undefined;
  if (
    !validateLessonPrepSlotOutput(output, {
      runId: run.id,
      frozenInputHash,
      blueprintArtifactId: blueprintArtifact.id,
      blueprintSha256: blueprintArtifact.contentSha256,
      lessonId,
      slotId,
      moduleType,
      moduleOrchestrationArtifactId:
        orchestrationArtifactId ?? output.moduleOrchestrationArtifactId,
      moduleOrchestrationSha256: orchestrationSha256 ?? output.moduleOrchestrationSha256,
      slotContractSha256: expectedSlotContractSha256 ?? output.slotContractSha256,
    }) ||
    (orchestrationArtifactId !== undefined &&
      (output.moduleOrchestrationArtifactId !== orchestrationArtifactId ||
        output.moduleOrchestrationSha256 !== orchestrationSha256 ||
        output.slotContractSha256 !== expectedSlotContractSha256)) ||
    (expectedReferencePack !== undefined &&
      JSON.stringify(output.referencePack) !== JSON.stringify(expectedReferencePack)) ||
    !prepared ||
    prepared.slotId !== slotId ||
    prepared.lessonId !== lessonId ||
    prepared.moduleType !== moduleType ||
    prepared.mongodbDocumentId !== prepared.moduleVersionId ||
    !uuid(prepared.courseNodeId) ||
    !uuid(prepared.moduleId) ||
    !uuid(prepared.moduleVersionId) ||
    !sha256(prepared.contentDigest) ||
    sha256Canonical(prepared.content) !== prepared.contentDigest ||
    sha256Canonical(output) !== artifact.contentSha256
  ) {
    throw new Error('LESSON_PREP_SLOT_CHECKPOINT_INVALID');
  }
  return { output, artifact };
}

function getOrchestrationSlotContract(
  contracts: ReadonlyMap<string, LessonPrepProductionStageArtifact['slots'][number]>,
  slotId: string,
  lessonId: string,
  moduleType: LessonPrepSlotOutput['moduleType'],
): LessonPrepProductionStageArtifact['slots'][number] {
  const contract = contracts.get(slotId);
  if (
    !contract ||
    contract.lessonId !== lessonId ||
    contract.moduleType !== moduleType ||
    contract.producerRoute !== LESSON_PREP_MODULE_PRODUCERS[moduleType].producerRoute ||
    contract.producerContractVersion !==
      LESSON_PREP_MODULE_PRODUCERS[moduleType].producerContractVersion ||
    contract.producerAllowlistVersion !==
      LESSON_PREP_MODULE_PRODUCERS[moduleType].producerAllowlistVersion ||
    !isOrchestrationSlotContract(contract)
  ) {
    throw new Error('LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID');
  }
  return contract;
}

function orchestrationSlotContractSha256(
  artifactId: string,
  artifactSha256: string,
  slot: LessonPrepProductionStageArtifact['slots'][number],
): string {
  return sha256Canonical({
    moduleOrchestrationArtifactId: artifactId,
    moduleOrchestrationSha256: artifactSha256,
    ...slot,
  });
}

function isOrchestrationSlotContract(
  value: unknown,
): value is LessonPrepProductionStageArtifact['slots'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const slot = value as Partial<LessonPrepProductionStageArtifact['slots'][number]>;
  const producer =
    typeof slot.moduleType === 'string'
      ? LESSON_PREP_MODULE_PRODUCERS[slot.moduleType as LessonPrepSlotOutput['moduleType']]
      : undefined;
  return (
    typeof slot.slotId === 'string' &&
    typeof slot.lessonId === 'string' &&
    typeof slot.moduleType === 'string' &&
    typeof slot.title === 'string' &&
    typeof slot.learningMoveId === 'string' &&
    typeof slot.handoffIn === 'string' &&
    Array.isArray(slot.evidence) &&
    slot.evidence.every((item) => typeof item === 'string') &&
    typeof slot.handoffOut === 'string' &&
    Array.isArray(slot.continuityRefs) &&
    slot.continuityRefs.every((item) => typeof item === 'string') &&
    Number.isSafeInteger(slot.producerOrder) &&
    typeof slot.producerRoute === 'string' &&
    producer !== undefined &&
    slot.producerRoute === producer.producerRoute &&
    slot.producerContractVersion === producer.producerContractVersion &&
    slot.producerAllowlistVersion === producer.producerAllowlistVersion
  );
}

function validateGeneratedSlotProducerBinding(
  output: LessonPrepSlotOutput,
  orchestrationArtifactId: string,
  orchestrationSha256: string,
  slotContract: LessonPrepProductionStageArtifact['slots'][number],
  slotContractSha256: string,
): void {
  if (
    output.moduleOrchestrationArtifactId !== orchestrationArtifactId ||
    output.moduleOrchestrationSha256 !== orchestrationSha256 ||
    output.slotContractSha256 !== slotContractSha256 ||
    output.producerRoute !== LESSON_PREP_MODULE_PRODUCERS[slotContract.moduleType].producerRoute ||
    output.producerContractVersion !==
      LESSON_PREP_MODULE_PRODUCERS[slotContract.moduleType].producerContractVersion ||
    output.producerAllowlistVersion !==
      LESSON_PREP_MODULE_PRODUCERS[slotContract.moduleType].producerAllowlistVersion
  ) {
    throw new Error('LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID');
  }
}

async function validateLessonPrepFinalPreviewBoundary(
  store: RuntimeStore,
  run: RunRecord,
  input: BoundLessonPrepInput,
  blueprint: LessonPrepBlueprint,
  blueprintArtifact: ValidatedArtifactRecord,
  preview: LessonPrepFinalPreview,
  orchestrationArtifactId: string,
  orchestrationSha256: string,
  orchestrationSlotContracts: ReadonlyMap<
    string,
    LessonPrepProductionStageArtifact['slots'][number]
  >,
): Promise<void> {
  if (preview.lessons.length !== blueprint.lessons.length) {
    throw new Error('LESSON_PREP_FINAL_PREVIEW_CHECKPOINT_INVALID');
  }
  for (const [lessonIndex, lesson] of blueprint.lessons.entries()) {
    const previewLesson = preview.lessons[lessonIndex];
    if (
      !previewLesson ||
      previewLesson.lessonId !== lesson.lessonId ||
      previewLesson.title !== lesson.title ||
      previewLesson.objective !== lesson.objective ||
      previewLesson.modules.length !== lesson.modules.length
    ) {
      throw new Error('LESSON_PREP_FINAL_PREVIEW_CHECKPOINT_INVALID');
    }
    for (const [slotIndex, slot] of lesson.modules.entries()) {
      const previewModule = previewLesson.modules[slotIndex];
      const contract = getOrchestrationSlotContract(
        orchestrationSlotContracts,
        slot.slotId,
        lesson.lessonId,
        slot.moduleType,
      );
      const checkpoint = await loadSlotCheckpoint(
        store,
        run,
        input.frozenInputHash,
        blueprintArtifact,
        lesson.lessonId,
        slot.slotId,
        slot.moduleType,
        orchestrationArtifactId,
        orchestrationSha256,
        contract,
      );
      if (
        !checkpoint ||
        !previewModule ||
        previewModule.slotId !== slot.slotId ||
        previewModule.lessonId !== lesson.lessonId ||
        previewModule.moduleType !== slot.moduleType ||
        sha256Canonical(previewModule) !== sha256Canonical(checkpoint.output.preparedModule)
      ) {
        throw new Error('LESSON_PREP_FINAL_PREVIEW_CHECKPOINT_INVALID');
      }
    }
  }
}

async function loadFinalPreviewCheckpoint(
  store: RuntimeStore,
  run: RunRecord,
): Promise<{ preview: LessonPrepFinalPreview; artifact: ValidatedArtifactRecord } | null> {
  const artifact = await store.getLatestArtifact(run.id, 'lesson-prep-final-preview/v1');
  if (!artifact) return null;
  const value = artifact.changeSet as Partial<LessonPrepFinalPreview>;
  if (
    value.schema !== 'lesson-prep-final-preview/v1' ||
    value.runId !== run.id ||
    value.organizationId !== run.actor.orgId ||
    value.actorAccountId !== run.actor.subject ||
    value.courseId !== run.domainScope.courseId ||
    value.expectedWorkspaceLockVersion !== Number(run.domainScope.expectedWorkspaceLockVersion) ||
    !Array.isArray(value.lessons) ||
    !validateLessonPrepFinalPreviewHashes(value as LessonPrepFinalPreview) ||
    sha256Canonical(value) !== artifact.contentSha256
  ) {
    throw new Error('LESSON_PREP_FINAL_PREVIEW_CHECKPOINT_INVALID');
  }
  return { preview: value as LessonPrepFinalPreview, artifact };
}

function monitorRun(store: RuntimeStore, runId: string, deadlineAt: number) {
  const controller = new AbortController();
  const timer = setInterval(() => {
    void ensureRunActive(store, runId, deadlineAt).catch((error) => controller.abort(error));
  }, CANCELLATION_POLL_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
}

async function ensureRunActive(store: RuntimeStore, runId: string, deadlineAt: number) {
  if (Date.now() >= deadlineAt) {
    throw new LessonPrepStoppedError('RUN_EXPIRED');
  }
  const current = await store.getRun(runId);
  if (!current || current.status === 'cancelled') {
    throw new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
  }
  const terminalCode = lessonPrepControlTerminalCode(current);
  if (terminalCode === 'RUN_EXPIRED' || terminalCode === 'BUDGET_EXHAUSTED') {
    throw new LessonPrepStoppedError(terminalCode);
  }
  if (current.status !== 'running' || lessonPrepControl(current)?.mode !== 'running') {
    throw new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
  }
}

async function classifyStopped(
  store: RuntimeStore,
  runId: string,
  deadlineAt: number,
  error: unknown,
): Promise<LessonPrepStoppedError | null> {
  if (error instanceof LessonPrepStoppedError) return error;
  if (Date.now() >= deadlineAt) {
    return new LessonPrepStoppedError('RUN_EXPIRED');
  }
  const current = await store.getRun(runId);
  if (current?.status === 'cancelled') return new LessonPrepStoppedError('LESSON_PREP_CANCELLED');
  const terminalCode = current ? lessonPrepControlTerminalCode(current) : null;
  return terminalCode === 'RUN_EXPIRED' || terminalCode === 'BUDGET_EXHAUSTED'
    ? new LessonPrepStoppedError(terminalCode)
    : null;
}

export function deterministicFailureCode(error: unknown): string | null {
  const message =
    error instanceof LessonPrepSourceClientError
      ? error.code
      : error instanceof Error
        ? error.message
        : '';
  return [
    'LESSON_PREP_INPUT_INVALID',
    'LESSON_PREP_BLUEPRINT_INVALID',
    'LESSON_PREP_BLUEPRINT_CHECKPOINT_INVALID',
    'LESSON_PREP_SOURCE_EVIDENCE_CHECKPOINT_INVALID',
    'LESSON_PREP_SOURCE_EVIDENCE_PROJECTION_INCOMPLETE',
    'LESSON_PREP_DESIGN_SPINE_CHECKPOINT_INVALID',
    'LESSON_PREP_DESIGN_STAGE_CONTRACT_INVALID',
    'LESSON_PREP_PRODUCTION_CHECKPOINT_INVALID',
    'LESSON_PREP_PRODUCTION_DEPENDENCY_INVALID',
    'LESSON_PREP_NATIVE_REACH_DECK_CONTRACT_INVALID',
    'LESSON_PREP_MODULE_CONTENT_INVALID',
    'LESSON_PREP_BASELINE_INVALID',
    'LESSON_PREP_FROZEN_INPUT_HASH_INVALID',
    'LESSON_PREP_SLOT_CHECKPOINT_INVALID',
    'LESSON_PREP_SLOT_SET_INCOMPLETE',
    'LESSON_PREP_FINAL_PREVIEW_CHECKPOINT_INVALID',
    'LESSON_PREP_EVIDENCE_UNAVAILABLE',
    'LESSON_PREP_EVIDENCE_REJECTED',
    'LESSON_PREP_EVIDENCE_AUTH_REJECTED',
    'LESSON_PREP_EVIDENCE_NOT_FOUND',
    'LESSON_PREP_EVIDENCE_CONFLICT',
    'LESSON_PREP_EVIDENCE_VALIDATION_REJECTED',
    'LESSON_PREP_EVIDENCE_SERVICE_REJECTED',
    'LESSON_PREP_EVIDENCE_RESPONSE_INVALID',
    'LESSON_PREP_EVIDENCE_TICKET_INVALID',
    'LESSON_PREP_EVIDENCE_UPLOAD_UNAVAILABLE',
    'LESSON_PREP_EVIDENCE_UPLOAD_REJECTED',
    'LESSON_PREP_EVIDENCE_READ_INVALID',
    'LESSON_PREP_EVIDENCE_DOWNLOAD_UNAVAILABLE',
    'LESSON_PREP_EVIDENCE_DOWNLOAD_REJECTED',
    'LESSON_PREP_EVIDENCE_STAGING_MISMATCH',
    'LESSON_PREP_EVIDENCE_BODY_INVALID',
  ].includes(message)
    ? message
    : null;
}

function lessonPrepEvidenceDiagnosticCode(
  error: unknown,
): import('./lesson-prep-diagnostics.js').LessonPrepDiagnosticCode {
  const code = error instanceof LessonPrepSourceClientError ? error.code : '';
  const known: ReadonlySet<string> = new Set([
    'LESSON_PREP_EVIDENCE_UNAVAILABLE',
    'LESSON_PREP_EVIDENCE_REJECTED',
    'LESSON_PREP_EVIDENCE_AUTH_REJECTED',
    'LESSON_PREP_EVIDENCE_NOT_FOUND',
    'LESSON_PREP_EVIDENCE_CONFLICT',
    'LESSON_PREP_EVIDENCE_VALIDATION_REJECTED',
    'LESSON_PREP_EVIDENCE_SERVICE_REJECTED',
    'LESSON_PREP_EVIDENCE_RESPONSE_INVALID',
    'LESSON_PREP_EVIDENCE_TICKET_INVALID',
    'LESSON_PREP_EVIDENCE_UPLOAD_UNAVAILABLE',
    'LESSON_PREP_EVIDENCE_UPLOAD_REJECTED',
    'LESSON_PREP_EVIDENCE_READ_INVALID',
    'LESSON_PREP_EVIDENCE_DOWNLOAD_UNAVAILABLE',
    'LESSON_PREP_EVIDENCE_DOWNLOAD_REJECTED',
    'LESSON_PREP_EVIDENCE_STAGING_MISMATCH',
    'LESSON_PREP_EVIDENCE_BODY_INVALID',
  ] as const);
  return (
    known.has(code) ? code : 'LESSON_PREP_EVIDENCE_UPLOAD_UNAVAILABLE'
  ) as import('./lesson-prep-diagnostics.js').LessonPrepDiagnosticCode;
}

function deterministicFailureMessage(code: string): string {
  if (code === 'LESSON_PREP_INPUT_INVALID') {
    return 'The immutable lesson-prep input snapshot is invalid.';
  }
  if (code.startsWith('LESSON_PREP_EVIDENCE_')) {
    return 'Lesson-prep source evidence could not be staged safely.';
  }
  if (code.includes('BLUEPRINT')) {
    return 'The course architecture output did not satisfy the deterministic contract.';
  }
  return 'Generated module content did not satisfy the deterministic lesson-prep contract.';
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('LESSON_PREP_CONCURRENCY_INVALID');
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let firstError: unknown;
  const worker = async () => {
    while (firstError === undefined) {
      const index = nextIndex++;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  if (firstError !== undefined) throw firstError;
  return results;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
