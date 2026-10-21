import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { CreateRunInput } from './contracts.js';
import {
  LESSON_PREP_REFERENCE_PACKAGE_VERSION,
  LESSON_PREP_REFERENCE_REGISTRY_SHA256,
  LESSON_PREP_REFERENCE_ROUTE_TABLE_SHA256,
  LESSON_PREP_REFERENCE_PACKS,
} from './lesson-prep-reference-packs.js';

export function deterministicLessonPrepArtifactId(
  organizationId: string,
  actorAccountId: string,
  courseId: string,
  requestKey: string,
): string {
  const digest = createHash('sha256')
    .update(
      `lesson-prep-input/v1\n${organizationId}\n${actorAccountId}\n${courseId}\n${requestKey}`,
    )
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface LessonPrepRunInput {
  courseTitle: string;
  courseSummary: string;
  teacherRequirements: string;
  learningObjectives: string;
  learnerProfile: string;
  pedagogyPreferences: string;
  presentationPreferences: string;
  promptOwnerAllowlistVersion: 'lesson-prep-prompt-owners/v1';
  ownerInstructions: Partial<Record<LessonPrepPromptOwner, string>>;
  referencePackBinding: {
    packageVersion: string;
    registrySha256: string;
    routeTableSha256: string;
    packIds: readonly string[];
  };
  sourceAssets: LessonPrepSourceAsset[];
  budget: typeof FIXED_BUDGET;
  locale?: 'zh-CN' | 'en-US';
}

export type LessonPrepPromptOwner = (typeof PROMPT_OWNERS)[number];

export interface LessonPrepSourceAsset {
  ordinal: number;
  assetId: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
}

export interface FrozenLessonPrepInput {
  schema: 'lesson-prep-run-input/v1';
  payload: LessonPrepRunInput;
  contentSha256: string;
}

export interface BoundLessonPrepInput extends FrozenLessonPrepInput {
  binding: {
    organizationId: string;
    actorAccountId: string;
    courseId: string;
    runId: string;
    baseline: {
      schema: 'lesson-prep-draft-baseline/v1';
      expectedWorkspaceLockVersion: number;
    };
    courseMetadataSha256: string;
    sourceAssetBindingsSha256: string;
    sourceManifestSha256: string;
    budgetSha256: string;
  };
  frozenInputHash: string;
}

export interface LessonPrepRunReference {
  schema: 'lesson-prep-run-reference/v1';
  artifactId: string;
  contentSha256: string;
  frozenInputHash: string;
  promptOwnerAllowlistVersion: 'lesson-prep-prompt-owners/v1';
}

const LIMITS = {
  courseTitle: 300,
  courseSummary: 4_000,
  teacherRequirements: 20_000,
  learningObjectives: 12_000,
  learnerProfile: 8_000,
  pedagogyPreferences: 8_000,
  presentationPreferences: 8_000,
  ownerInstruction: 2_000,
  ownerInstructionsTotal: 12_000,
} as const;

const PROMPT_OWNERS = [
  'resource_integration',
  'course_architecture',
  'pedagogical_design',
  'lesson_choreography',
  'course_opening',
  'group_activity',
  'course_close',
  'course_transition',
  'lecture',
  'visual_media',
  'interaction',
  'independent_practice',
  'mastery_assessment',
  'spaced_review',
] as const;

const FIXED_BUDGET = {
  slotLimit: 24,
  slotConcurrency: 3,
  transportRetriesPerSlot: 2,
  ownerRepairsPerSlot: 1,
  actorRetriesPerSlot: 1,
  modelCallLimit: 80,
  tokenLimit: 1_000_000,
  wallClockMinutes: 90,
  deadlineHours: 24,
} as const;

const SOURCE_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/markdown',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function freezeLessonPrepInput(value: unknown): FrozenLessonPrepInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('lesson-prep input must be an object');
  }
  const raw = value as Record<string, unknown>;
  const supported = new Set([
    'teacherRequirements',
    'learningObjectives',
    'prompt',
    'locale',
    'promptOwnerAllowlistVersion',
    'ownerInstructions',
    'courseTitle',
    'courseSummary',
    'learnerProfile',
    'pedagogyPreferences',
    'presentationPreferences',
    'sourceAssets',
    'budget',
    'referencePackBinding',
  ]);
  if (Object.keys(raw).some((key) => !supported.has(key))) {
    throw new Error('lesson-prep input contains an unsupported field');
  }
  let ownerInstructions: LessonPrepRunInput['ownerInstructions'];
  if (raw.ownerInstructions !== undefined) {
    if (
      raw.promptOwnerAllowlistVersion !== 'lesson-prep-prompt-owners/v1' ||
      typeof raw.ownerInstructions !== 'object' ||
      raw.ownerInstructions === null ||
      Array.isArray(raw.ownerInstructions)
    ) {
      throw new Error('lesson-prep prompt owner contract is invalid');
    }
    const owners = raw.ownerInstructions as Record<string, unknown>;
    if (Object.keys(owners).some((key) => !PROMPT_OWNERS.includes(key as LessonPrepPromptOwner))) {
      throw new Error('lesson-prep prompt owner is unsupported');
    }
    ownerInstructions = {};
    let instructionTotal = 0;
    for (const owner of PROMPT_OWNERS) {
      if (owners[owner] === undefined || owners[owner] === '') continue;
      const instruction = normalizeText(owners[owner], LIMITS.ownerInstruction);
      instructionTotal += instruction.length;
      if (instructionTotal > LIMITS.ownerInstructionsTotal) {
        throw new Error('lesson-prep prompt instructions exceed their total limit');
      }
      ownerInstructions[owner] = instruction;
    }
  } else {
    ownerInstructions =
      raw.prompt === undefined || raw.prompt === ''
        ? {}
        : { course_architecture: normalizeText(raw.prompt, LIMITS.ownerInstruction) };
  }
  if (raw.referencePackBinding !== undefined) {
    const binding = raw.referencePackBinding as Record<string, unknown>;
    if (
      !binding ||
      binding.packageVersion !== LESSON_PREP_REFERENCE_PACKAGE_VERSION ||
      binding.registrySha256 !== LESSON_PREP_REFERENCE_REGISTRY_SHA256 ||
      binding.routeTableSha256 !== LESSON_PREP_REFERENCE_ROUTE_TABLE_SHA256 ||
      !isDeepStrictEqual(binding.packIds, [...LESSON_PREP_REFERENCE_PACKS])
    ) {
      throw new Error('lesson-prep reference pack binding is invalid');
    }
  }
  const payload: LessonPrepRunInput = {
    courseTitle: optionalText(raw.courseTitle, LIMITS.courseTitle),
    courseSummary: optionalText(raw.courseSummary, LIMITS.courseSummary),
    teacherRequirements: normalizeText(raw.teacherRequirements, LIMITS.teacherRequirements),
    learningObjectives: normalizeText(raw.learningObjectives, LIMITS.learningObjectives),
    learnerProfile: optionalText(raw.learnerProfile, LIMITS.learnerProfile),
    pedagogyPreferences: optionalText(raw.pedagogyPreferences, LIMITS.pedagogyPreferences),
    presentationPreferences: optionalText(
      raw.presentationPreferences,
      LIMITS.presentationPreferences,
    ),
    promptOwnerAllowlistVersion: 'lesson-prep-prompt-owners/v1',
    ownerInstructions,
    referencePackBinding: {
      packageVersion: LESSON_PREP_REFERENCE_PACKAGE_VERSION,
      registrySha256: LESSON_PREP_REFERENCE_REGISTRY_SHA256,
      routeTableSha256: LESSON_PREP_REFERENCE_ROUTE_TABLE_SHA256,
      packIds: [...LESSON_PREP_REFERENCE_PACKS],
    },
    sourceAssets: normalizeSourceAssets(raw.sourceAssets),
    budget: normalizeBudget(raw.budget),
    ...(raw.locale === 'zh-CN' || raw.locale === 'en-US' ? { locale: raw.locale } : {}),
  };
  const canonical = JSON.stringify(payload);
  if (Buffer.byteLength(canonical, 'utf8') > 128 * 1024) {
    throw new Error('lesson-prep input exceeds its encoded size limit');
  }
  return {
    schema: 'lesson-prep-run-input/v1',
    payload,
    contentSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  };
}

export function bindLessonPrepInput(
  frozen: FrozenLessonPrepInput,
  binding: Pick<
    BoundLessonPrepInput['binding'],
    'organizationId' | 'actorAccountId' | 'courseId' | 'runId' | 'sourceManifestSha256'
  > & { expectedWorkspaceLockVersion: number },
): BoundLessonPrepInput {
  if (!CANONICAL_UUID.test(binding.runId) || !SHA256.test(binding.sourceManifestSha256)) {
    throw new Error('lesson-prep run source binding is invalid');
  }
  const canonicalBinding = {
    organizationId: binding.organizationId,
    actorAccountId: binding.actorAccountId,
    courseId: binding.courseId,
    runId: binding.runId,
    baseline: {
      schema: 'lesson-prep-draft-baseline/v1' as const,
      expectedWorkspaceLockVersion: binding.expectedWorkspaceLockVersion,
    },
    courseMetadataSha256: sha256({
      courseTitle: frozen.payload.courseTitle,
      courseSummary: frozen.payload.courseSummary,
    }),
    sourceAssetBindingsSha256: sha256(frozen.payload.sourceAssets),
    sourceManifestSha256: binding.sourceManifestSha256,
    budgetSha256: sha256(frozen.payload.budget),
  };
  const frozenInputHash = createHash('sha256')
    .update(
      JSON.stringify({ payloadSha256: frozen.contentSha256, binding: canonicalBinding }),
      'utf8',
    )
    .digest('hex');
  return { ...frozen, binding: canonicalBinding, frozenInputHash };
}

export function lessonPrepRunReference(
  artifactId: string,
  bound: BoundLessonPrepInput,
): LessonPrepRunReference {
  return {
    schema: 'lesson-prep-run-reference/v1',
    artifactId,
    contentSha256: bound.contentSha256,
    frozenInputHash: bound.frozenInputHash,
    promptOwnerAllowlistVersion: bound.payload.promptOwnerAllowlistVersion,
  };
}

/** Fail-closed store boundary for the dedicated write-once lesson-prep input artifact. */
export function validateLessonPrepRunInputArtifact(input: CreateRunInput): void {
  const artifact = input.inputArtifact;
  if (input.sceneKey !== 'teacher.lesson-prep' || !artifact || !input.requestKey) {
    throw new Error('lesson-prep input artifact is restricted to its dedicated Scene');
  }
  const courseId = input.domainScope.courseId;
  const requestedRunId = (input as CreateRunInput & { requestedRunId?: string }).requestedRunId;
  const expectedWorkspaceLockVersion = Number(input.domainScope.expectedWorkspaceLockVersion);
  if (
    !courseId ||
    !requestedRunId ||
    !CANONICAL_UUID.test(requestedRunId) ||
    !Number.isSafeInteger(expectedWorkspaceLockVersion) ||
    expectedWorkspaceLockVersion < 0
  ) {
    throw new Error('lesson-prep input artifact binding is invalid');
  }
  const expectedArtifactId = deterministicLessonPrepArtifactId(
    input.actor.orgId,
    input.actor.subject,
    courseId,
    input.requestKey,
  );
  const storedBinding = (artifact.changeSet as unknown as Partial<BoundLessonPrepInput>).binding;
  if (!storedBinding || !SHA256.test(storedBinding.sourceManifestSha256 ?? '')) {
    throw new Error('lesson-prep input artifact source binding is invalid');
  }
  const rebound = bindLessonPrepInput(freezeLessonPrepInput(artifact.changeSet.payload), {
    organizationId: input.actor.orgId,
    actorAccountId: input.actor.subject,
    courseId,
    runId: requestedRunId,
    expectedWorkspaceLockVersion,
    sourceManifestSha256: storedBinding.sourceManifestSha256,
  });
  let reference: unknown;
  try {
    reference = JSON.parse(input.input.message);
  } catch {
    throw new Error('lesson-prep input reference is invalid');
  }
  if (
    artifact.id !== expectedArtifactId ||
    artifact.artifactType !== 'lesson-prep-run-input/v1' ||
    artifact.domainRef.courseId !== courseId ||
    artifact.contentSha256 !== rebound.frozenInputHash ||
    !isDeepStrictEqual(artifact.changeSet, rebound) ||
    !isDeepStrictEqual(reference, lessonPrepRunReference(artifact.id, rebound))
  ) {
    throw new Error('lesson-prep input artifact identity is invalid');
  }
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const EMPTY_LESSON_PREP_SOURCE_MANIFEST_SHA256 = createHash('sha256')
  .update('[]', 'utf8')
  .digest('hex');

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new Error('lesson-prep text input is required');
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .trim();
  if (normalized.length > max) throw new Error('lesson-prep text input exceeds its limit');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    throw new Error('lesson-prep text input contains a control character');
  }
  return normalized;
}

function optionalText(value: unknown, max: number): string {
  if (value === undefined || value === null || value === '') return '';
  return normalizeText(value, max);
}

function normalizeSourceAssets(value: unknown): LessonPrepSourceAsset[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('lesson-prep source asset set is invalid');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('lesson-prep source asset is invalid');
    }
    const asset = item as Record<string, unknown>;
    if (
      Object.keys(asset).some(
        (key) => !['ordinal', 'assetId', 'sha256', 'mimeType', 'byteSize'].includes(key),
      ) ||
      asset.ordinal !== index ||
      typeof asset.assetId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        asset.assetId,
      ) ||
      typeof asset.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      typeof asset.mimeType !== 'string' ||
      !SOURCE_MIME_TYPES.has(asset.mimeType) ||
      !Number.isSafeInteger(asset.byteSize) ||
      Number(asset.byteSize) <= 0
    ) {
      throw new Error('lesson-prep source asset binding is invalid');
    }
    return {
      ordinal: index,
      assetId: asset.assetId,
      sha256: asset.sha256,
      mimeType: asset.mimeType,
      byteSize: Number(asset.byteSize),
    };
  });
}

function normalizeBudget(value: unknown): typeof FIXED_BUDGET {
  if (value !== undefined && !isDeepStrictEqual(value, FIXED_BUDGET)) {
    throw new Error('lesson-prep budget contract is fixed');
  }
  return FIXED_BUDGET;
}
