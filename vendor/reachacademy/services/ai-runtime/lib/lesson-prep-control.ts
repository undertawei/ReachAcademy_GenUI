import type {
  LessonPrepCheckpointIdentity,
  LessonPrepRunControl,
  LessonPrepSlotControl,
  RunRecord,
} from './contracts.js';

export const LESSON_PREP_TERMINAL_DEADLINE_MS = 24 * 60 * 60 * 1_000;
export const LESSON_PREP_WALL_CLOCK_LIMIT_MS = 90 * 60 * 1_000;
export const LESSON_PREP_MODEL_CALL_LIMIT = 80;
export const LESSON_PREP_SLOT_LIMIT = 24;
export const LESSON_PREP_SLOT_CONCURRENCY = 3;

const CONTROL_KEYS = new Set([
  'schema',
  'mode',
  'deadlineAt',
  'wallClockLimitMs',
  'tokenBudget',
  'modelCallLimit',
  'slotLimit',
  'slotConcurrency',
  'transportRetryLimitPerSlot',
  'ownerRepairLimitPerSlot',
  'actorRetryLimitPerSlot',
  'attemptCount',
  'resumeCount',
  'modelCallCount',
  'tokenCount',
  'wallClockMs',
  'inputArtifact',
  'promptSha256',
  'checkpoints',
  'stageCheckpoints',
  'slots',
  'activeSince',
  'cancelRequestedAt',
  'interruptedAt',
]);

const MODES = new Set<LessonPrepRunControl['mode']>([
  'queued',
  'running',
  'interrupted',
  'slot_failed',
  'waiting_approval',
  'completed',
  'cancelled',
  'terminal',
]);

export function createLessonPrepControl(input: {
  now: Date;
  tokenBudget: number;
  inputArtifact: LessonPrepCheckpointIdentity;
  promptSha256: string;
}): LessonPrepRunControl {
  return {
    schema: 'runtime_state.control/v1',
    mode: 'queued',
    deadlineAt: new Date(input.now.getTime() + LESSON_PREP_TERMINAL_DEADLINE_MS).toISOString(),
    wallClockLimitMs: LESSON_PREP_WALL_CLOCK_LIMIT_MS,
    tokenBudget: input.tokenBudget,
    modelCallLimit: LESSON_PREP_MODEL_CALL_LIMIT,
    slotLimit: LESSON_PREP_SLOT_LIMIT,
    slotConcurrency: LESSON_PREP_SLOT_CONCURRENCY,
    transportRetryLimitPerSlot: 2,
    ownerRepairLimitPerSlot: 1,
    actorRetryLimitPerSlot: 1,
    attemptCount: 0,
    resumeCount: 0,
    modelCallCount: 0,
    tokenCount: 0,
    wallClockMs: 0,
    inputArtifact: { ...input.inputArtifact },
    promptSha256: input.promptSha256,
    checkpoints: {},
    stageCheckpoints: {},
    slots: {},
  };
}

export function parseLessonPrepControl(value: unknown): LessonPrepRunControl | null {
  if (!isObject(value) || Object.keys(value).some((key) => !CONTROL_KEYS.has(key))) return null;
  if (
    value.schema !== 'runtime_state.control/v1' ||
    typeof value.mode !== 'string' ||
    !MODES.has(value.mode as LessonPrepRunControl['mode']) ||
    !isIsoDate(value.deadlineAt) ||
    !positiveInteger(value.wallClockLimitMs) ||
    !positiveInteger(value.tokenBudget) ||
    !positiveInteger(value.modelCallLimit) ||
    !positiveInteger(value.slotLimit) ||
    !positiveInteger(value.slotConcurrency) ||
    !nonNegativeInteger(value.transportRetryLimitPerSlot) ||
    !nonNegativeInteger(value.ownerRepairLimitPerSlot) ||
    !nonNegativeInteger(value.actorRetryLimitPerSlot) ||
    !nonNegativeInteger(value.attemptCount) ||
    !nonNegativeInteger(value.resumeCount) ||
    !nonNegativeInteger(value.modelCallCount) ||
    !nonNegativeInteger(value.tokenCount) ||
    !nonNegativeInteger(value.wallClockMs) ||
    !checkpointIdentity(value.inputArtifact) ||
    typeof value.promptSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.promptSha256) ||
    !isObject(value.checkpoints) ||
    Object.keys(value.checkpoints).some(
      (key) => !['blueprint', 'finalPreview', 'sourceEvidence', 'designSpine'].includes(key),
    ) ||
    !optionalCheckpoint(value.checkpoints.blueprint) ||
    !optionalCheckpoint(value.checkpoints.finalPreview) ||
    !optionalCheckpoint(value.checkpoints.sourceEvidence) ||
    !optionalCheckpoint(value.checkpoints.designSpine) ||
    (value.stageCheckpoints !== undefined && !isObject(value.stageCheckpoints)) ||
    (isObject(value.stageCheckpoints) &&
      Object.keys(value.stageCheckpoints).some(
        (key) => !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(key),
      )) ||
    (isObject(value.stageCheckpoints) &&
      Object.values(value.stageCheckpoints).some(
        (checkpoint) => !checkpointIdentity(checkpoint),
      )) ||
    !isObject(value.slots) ||
    !Object.entries(value.slots).every(([slotId, slot]) => validSlot(slotId, slot)) ||
    !optionalIsoDate(value.activeSince) ||
    !optionalIsoDate(value.cancelRequestedAt) ||
    !optionalIsoDate(value.interruptedAt)
  ) {
    return null;
  }
  return {
    ...(structuredClone(value) as unknown as LessonPrepRunControl),
    stageCheckpoints: isObject(value.stageCheckpoints)
      ? (structuredClone(value.stageCheckpoints) as LessonPrepRunControl['stageCheckpoints'])
      : {},
  };
}

export function lessonPrepControl(run: RunRecord): LessonPrepRunControl | null {
  return parseLessonPrepControl(run.runtimeState?.control);
}

export function lessonPrepControlTerminalCode(run: RunRecord, now = Date.now()): string | null {
  const control = lessonPrepControl(run);
  if (!control) return 'LESSON_PREP_CONTROL_INVALID';
  if (now >= Date.parse(control.deadlineAt)) return 'RUN_EXPIRED';
  if (
    control.tokenCount >= Math.min(control.tokenBudget, run.tokenBudget) ||
    control.modelCallCount >= control.modelCallLimit ||
    control.wallClockMs +
      (control.activeSince ? Math.max(0, now - Date.parse(control.activeSince)) : 0) >=
      control.wallClockLimitMs
  ) {
    return 'BUDGET_EXHAUSTED';
  }
  return null;
}

export function createEmptyLessonPrepSlotControl(): LessonPrepSlotControl {
  return {
    status: 'planned',
    modelCalls: 0,
    tokenCount: 0,
    transportRetries: 0,
    ownerRepairs: 0,
    actorRetries: 0,
  };
}

function checkpointIdentity(value: unknown): value is LessonPrepCheckpointIdentity {
  return (
    isObject(value) &&
    Object.keys(value).length === 2 &&
    typeof value.artifactId === 'string' &&
    /^[0-9a-f-]{36}$/.test(value.artifactId) &&
    typeof value.contentSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.contentSha256)
  );
}

function optionalCheckpoint(value: unknown): boolean {
  return value === undefined || checkpointIdentity(value);
}

function validSlot(slotId: string, value: unknown): boolean {
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(slotId) || !isObject(value)) return false;
  const keys = [
    'status',
    'modelCalls',
    'tokenCount',
    'transportRetries',
    'ownerRepairs',
    'actorRetries',
    'checkpoint',
    'failureCode',
  ];
  return (
    Object.keys(value).every((key) => keys.includes(key)) &&
    ['planned', 'running', 'completed', 'failed'].includes(String(value.status)) &&
    nonNegativeInteger(value.modelCalls) &&
    nonNegativeInteger(value.tokenCount) &&
    nonNegativeInteger(value.transportRetries) &&
    nonNegativeInteger(value.ownerRepairs) &&
    nonNegativeInteger(value.actorRetries) &&
    optionalCheckpoint(value.checkpoint) &&
    (value.failureCode === undefined ||
      (typeof value.failureCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.failureCode)))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function optionalIsoDate(value: unknown): boolean {
  return value === undefined || isIsoDate(value);
}
