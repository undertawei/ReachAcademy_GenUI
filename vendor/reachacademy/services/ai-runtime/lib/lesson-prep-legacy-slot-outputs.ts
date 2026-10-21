import type {
  ApprovedArtifactRecord,
  LessonPrepSlotControl,
  RunRecord,
  ValidatedArtifactRecord,
} from './contracts.js';
import { lessonPrepControl } from './lesson-prep-control.js';
import { sha256Canonical } from './lesson-prep-orchestrator.js';
import type { RuntimeStore } from './store/index.js';

const MAX_LESSON_PREP_SLOTS = 24;

interface LegacySlotOutputEvidence {
  artifactId: string;
  contentSha256: string;
  output: Record<string, unknown>;
}

export async function readLegacySlotOutputs(
  store: RuntimeStore,
  run: RunRecord,
  record: ApprovedArtifactRecord,
): Promise<LegacySlotOutputEvidence[] | null> {
  const preview = record.artifact.changeSet;
  const orderedModules = canonicalPreparedModules(preview);
  if (!orderedModules || orderedModules.length > MAX_LESSON_PREP_SLOTS) return null;
  const provenanceStates = orderedModules.map((module) => preparedModuleProvenance(module));
  if (provenanceStates.some((state) => state === 'invalid')) return null;
  const v2Count = provenanceStates.filter((state) => state === 'v2').length;
  if (v2Count > 0 && v2Count !== orderedModules.length) return null;
  if (v2Count === orderedModules.length) return [];
  if (orderedModules.length === 0) return [];

  const control = lessonPrepControl(run);
  if (!control) return null;
  const evidence: LegacySlotOutputEvidence[] = [];
  const seenArtifacts = new Set<string>();
  for (const preparedModule of orderedModules) {
    const slotId = preparedModule.slotId;
    if (typeof slotId !== 'string') return null;
    const slot = control.slots[slotId];
    if (!isCompletedCheckpoint(slot) || seenArtifacts.has(slot.checkpoint.artifactId)) return null;
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
      artifact.domainRef.slotId !== slotId ||
      !isExactLegacySlotOutput(artifact, run, preview, preparedModule)
    ) {
      return null;
    }
    seenArtifacts.add(artifact.id);
    evidence.push({
      artifactId: artifact.id,
      contentSha256: artifact.contentSha256,
      output: artifact.changeSet,
    });
  }
  return evidence;
}

function canonicalPreparedModules(
  preview: Record<string, unknown>,
): Record<string, unknown>[] | null {
  if (!Array.isArray(preview.lessons)) return null;
  const modules: Record<string, unknown>[] = [];
  for (const rawLesson of preview.lessons) {
    if (!isObject(rawLesson) || !Array.isArray(rawLesson.modules)) return null;
    for (const module of rawLesson.modules) {
      if (!isObject(module)) return null;
      modules.push(module);
    }
  }
  return modules;
}

function preparedModuleProvenance(module: Record<string, unknown>): 'legacy' | 'v2' | 'invalid' {
  const values = [
    module.producerRoute,
    module.producerContractVersion,
    module.producerAllowlistVersion,
  ];
  if (values.every((value) => value === undefined)) {
    return hasExactPreparedModuleKeys(module, false) ? 'legacy' : 'invalid';
  }
  if (!values.every((value) => typeof value === 'string')) return 'invalid';
  const expected = expectedProducer(String(module.moduleType), false);
  return expected &&
    hasExactPreparedModuleKeys(module, true) &&
    module.producerRoute === expected.producerRoute &&
    module.producerContractVersion === expected.producerContractVersion &&
    module.producerAllowlistVersion === 'lesson-prep-producers/v1'
    ? 'v2'
    : 'invalid';
}

function isCompletedCheckpoint(
  slot: LessonPrepSlotControl | undefined,
): slot is LessonPrepSlotControl & { checkpoint: { artifactId: string; contentSha256: string } } {
  return slot?.status === 'completed' && slot.checkpoint !== undefined;
}

function isExactLegacySlotOutput(
  artifact: ValidatedArtifactRecord,
  run: RunRecord,
  preview: Record<string, unknown>,
  preparedModule: Record<string, unknown>,
): boolean {
  const output = artifact.changeSet;
  const allowedKeys = new Set([
    'schema',
    'runId',
    'frozenInputHash',
    'blueprintArtifactId',
    'blueprintSha256',
    'lessonId',
    'slotId',
    'moduleType',
    'producerRoute',
    'producerContractVersion',
    'producerAllowlistVersion',
    'moduleOrchestrationArtifactId',
    'moduleOrchestrationSha256',
    'slotContractSha256',
    'referencePack',
    'preparedModule',
  ]);
  if (Object.keys(output).some((key) => !allowedKeys.has(key))) return false;
  const expected = expectedProducer(String(preparedModule.moduleType), true);
  const referenceBySlot = isObject(preview.referencePackBySlot)
    ? preview.referencePackBySlot
    : undefined;
  return Boolean(
    expected &&
    output.schema === 'lesson-prep-slot-output/v1' &&
    output.runId === run.id &&
    output.frozenInputHash === preview.frozenInputHash &&
    output.blueprintArtifactId === preview.blueprintArtifactId &&
    output.blueprintSha256 === preview.blueprintSha256 &&
    output.lessonId === preparedModule.lessonId &&
    output.slotId === preparedModule.slotId &&
    output.moduleType === preparedModule.moduleType &&
    output.producerRoute === expected.producerRoute &&
    output.producerContractVersion === expected.producerContractVersion &&
    output.producerAllowlistVersion === 'lesson-prep-producers/v1' &&
    output.moduleOrchestrationArtifactId === preview.moduleOrchestrationArtifactId &&
    output.moduleOrchestrationSha256 === preview.moduleOrchestrationSha256 &&
    isObject(preview.slotContractSha256BySlot) &&
    output.slotContractSha256 === preview.slotContractSha256BySlot[String(output.slotId)] &&
    referenceBySlot !== undefined &&
    sha256Canonical(output.preparedModule) === sha256Canonical(preparedModule) &&
    sha256Canonical(output.referencePack) ===
      sha256Canonical(referenceBySlot[String(output.slotId)]) &&
    sha256Canonical(output) === artifact.contentSha256,
  );
}

function hasExactPreparedModuleKeys(module: Record<string, unknown>, v2: boolean): boolean {
  const expected = [
    'content',
    'contentDigest',
    'courseNodeId',
    'lessonId',
    'moduleId',
    'moduleType',
    'moduleVersionId',
    'mongodbDocumentId',
    ...(v2 ? ['producerAllowlistVersion', 'producerContractVersion', 'producerRoute'] : []),
    'settings',
    'slotId',
    'title',
  ].sort();
  return Object.keys(module).sort().join('\u0000') === expected.join('\u0000');
}

function expectedProducer(moduleType: string, legacyQuiz: boolean) {
  if (moduleType === 'reach-deck') {
    return {
      producerRoute: 'teacher.lesson-prep.reach-deck',
      producerContractVersion: 'lesson-prep-reach-deck-producer/v2',
    };
  }
  if (moduleType === 'quiz') {
    return {
      producerRoute: 'teacher.lesson-prep.quiz',
      producerContractVersion: legacyQuiz
        ? 'lesson-prep-quiz-producer/v1'
        : 'lesson-prep-quiz-producer/v2',
    };
  }
  if (moduleType === 'spaced-review') {
    return {
      producerRoute: 'teacher.lesson-prep.spaced-review',
      producerContractVersion: 'lesson-prep-spaced-review-producer/v1',
    };
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
