import type { ArtifactProposal, LessonPrepRunControl, RunRecord } from './contracts.js';
import { validateLessonPrepFinalPreviewHashes } from './lesson-prep-orchestrator.js';

export interface LessonPrepFinalReadyEvent {
  type: 'lesson-prep.gate.passed' | 'lesson-prep.final-preview.ready' | 'approval.required';
  payload: Record<string, unknown>;
}

interface FinalPreviewSummary {
  gateHash: string;
  requiredSlotSetHash: string;
  lessonCount: number;
  slotCount: number;
}

export function validateLessonPrepFinalPreviewProposal(
  run: RunRecord,
  control: LessonPrepRunControl,
  proposal: ArtifactProposal,
): FinalPreviewSummary | null {
  const preview = proposal.changeSet;
  if (
    proposal.artifactType !== 'lesson-prep-final-preview/v1' ||
    preview.schema !== 'lesson-prep-final-preview/v1' ||
    preview.previewRevision !== 1 ||
    preview.runId !== run.id ||
    preview.organizationId !== run.actor.orgId ||
    preview.actorAccountId !== run.actor.subject ||
    preview.courseId !== run.domainScope.courseId ||
    preview.expectedWorkspaceLockVersion !== Number(run.domainScope.expectedWorkspaceLockVersion) ||
    !sha256(preview.frozenInputHash) ||
    typeof preview.blueprintArtifactId !== 'string' ||
    !sha256(preview.blueprintSha256) ||
    !sha256(preview.requiredSlotSetHash) ||
    !sha256(preview.gateHash) ||
    !Array.isArray(preview.lessons) ||
    !sha256(preview.moduleOrchestrationSha256) ||
    typeof preview.moduleOrchestrationArtifactId !== 'string' ||
    !isObject(preview.slotContractSha256BySlot) ||
    !validateLessonPrepFinalPreviewHashes(preview as never)
  ) {
    return null;
  }

  const expectedSlots = Object.keys(control.slots)
    .filter((slotId) => control.stageCheckpoints?.[slotId] === undefined)
    .sort();
  if (expectedSlots.length === 0) return null;
  const actualSlots: string[] = [];
  for (const lesson of preview.lessons) {
    if (
      !isObject(lesson) ||
      typeof lesson.lessonId !== 'string' ||
      !Array.isArray(lesson.modules)
    ) {
      return null;
    }
    for (const module of lesson.modules) {
      if (
        !isObject(module) ||
        typeof module.slotId !== 'string' ||
        module.lessonId !== lesson.lessonId ||
        !['reach-deck', 'quiz', 'spaced-review'].includes(String(module.moduleType))
      ) {
        return null;
      }
      actualSlots.push(module.slotId);
    }
  }
  if (
    actualSlots.length !== expectedSlots.length ||
    new Set(actualSlots).size !== actualSlots.length ||
    actualSlots
      .slice()
      .sort()
      .some((slotId, index) => slotId !== expectedSlots[index])
  ) {
    return null;
  }

  return {
    gateHash: preview.gateHash,
    requiredSlotSetHash: preview.requiredSlotSetHash,
    lessonCount: preview.lessons.length,
    slotCount: actualSlots.length,
  };
}

export function lessonPrepFinalReadyEvents(
  summary: FinalPreviewSummary,
  artifactId: string,
  approvalId: string,
  contentSha256: string,
): LessonPrepFinalReadyEvent[] {
  return [
    {
      type: 'lesson-prep.gate.passed',
      payload: {
        gate: 'final-preview-deterministic/v1',
        gateHash: summary.gateHash,
        requiredSlotSetHash: summary.requiredSlotSetHash,
        checks: [
          'complete-slot-set',
          'native-document-contracts',
          'stable-identities',
          'ordered-lesson-tree',
        ],
      },
    },
    {
      type: 'lesson-prep.final-preview.ready',
      payload: {
        artifactId,
        approvalId,
        contentSha256,
        lessonCount: summary.lessonCount,
        slotCount: summary.slotCount,
        gateHash: summary.gateHash,
        requiredSlotSetHash: summary.requiredSlotSetHash,
        applyable: true,
      },
    },
    {
      type: 'approval.required',
      payload: { artifactId, approvalId, stakesTier: 'teacher' },
    },
  ];
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
