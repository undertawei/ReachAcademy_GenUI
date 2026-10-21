import type { LessonPrepWorkspaceDraft, LessonPrepWorkspaceState, RunRecord } from './contracts.js';
import { freezeLessonPrepInput } from './lesson-prep-input.js';

const WORKSPACE_SCHEMA = 'lesson-prep-workspace/v1' as const;
const DRAFT_FIELDS = new Set([
  'teacherRequirements',
  'learningObjectives',
  'promptOwnerAllowlistVersion',
  'ownerInstructions',
  'sourceAssets',
  'locale',
]);

/** Normalize the only mutable lesson-prep fields accepted before immutable finalization. */
export function normalizeLessonPrepWorkspaceDraft(value: unknown): LessonPrepWorkspaceDraft {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lesson-prep workspace draft must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !DRAFT_FIELDS.has(key))) {
    throw new Error('lesson-prep workspace draft contains an unsupported field');
  }
  const frozen = freezeLessonPrepInput({
    teacherRequirements: raw.teacherRequirements ?? '',
    learningObjectives: raw.learningObjectives ?? '',
    ...(raw.promptOwnerAllowlistVersion === undefined
      ? {}
      : { promptOwnerAllowlistVersion: raw.promptOwnerAllowlistVersion }),
    ...(raw.ownerInstructions === undefined ? {} : { ownerInstructions: raw.ownerInstructions }),
    ...(raw.sourceAssets === undefined ? {} : { sourceAssets: raw.sourceAssets }),
    ...(raw.locale === undefined ? {} : { locale: raw.locale }),
  }).payload;
  return {
    teacherRequirements: frozen.teacherRequirements,
    learningObjectives: frozen.learningObjectives,
    promptOwnerAllowlistVersion: frozen.promptOwnerAllowlistVersion,
    ownerInstructions: structuredClone(frozen.ownerInstructions),
    sourceAssets: structuredClone(frozen.sourceAssets),
    ...(frozen.locale ? { locale: frozen.locale } : {}),
  };
}

export function createLessonPrepDraftWorkspace(
  draft: unknown,
  now: Date,
): LessonPrepWorkspaceState {
  return {
    schema: WORKSPACE_SCHEMA,
    status: 'draft',
    version: 1,
    updatedAt: now.toISOString(),
    draft: normalizeLessonPrepWorkspaceDraft(draft),
  };
}

export function updateLessonPrepDraftWorkspace(
  current: LessonPrepWorkspaceState,
  draft: unknown,
  now: Date,
): LessonPrepWorkspaceState {
  if (current.status !== 'draft') throw new Error('lesson-prep workspace is not editable');
  return {
    schema: WORKSPACE_SCHEMA,
    status: 'draft',
    version: current.version + 1,
    updatedAt: now.toISOString(),
    draft: normalizeLessonPrepWorkspaceDraft(draft),
  };
}

export function activateLessonPrepWorkspace(
  current: LessonPrepWorkspaceState,
  now: Date,
): LessonPrepWorkspaceState {
  if (current.status !== 'draft') throw new Error('lesson-prep workspace is not a draft');
  return {
    schema: WORKSPACE_SCHEMA,
    status: 'active',
    version: current.version + 1,
    updatedAt: now.toISOString(),
  };
}

export function hideLessonPrepWorkspace(
  current: LessonPrepWorkspaceState | null,
  now: Date,
): LessonPrepWorkspaceState {
  if (current?.status === 'hidden') return structuredClone(current);
  const hiddenAt = now.toISOString();
  return {
    schema: WORKSPACE_SCHEMA,
    status: 'hidden',
    version: (current?.version ?? 0) + 1,
    updatedAt: hiddenAt,
    hiddenAt,
    previousStatus: current?.status === 'draft' ? 'draft' : 'active',
    ...(current?.status === 'draft' ? { draft: structuredClone(current.draft) } : {}),
  };
}

export function parseLessonPrepWorkspace(value: unknown): LessonPrepWorkspaceState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schema !== WORKSPACE_SCHEMA ||
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 1 ||
    typeof raw.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.updatedAt))
  ) {
    return null;
  }
  if (raw.status === 'active') {
    return {
      schema: WORKSPACE_SCHEMA,
      status: 'active',
      version: Number(raw.version),
      updatedAt: raw.updatedAt,
    };
  }
  if (raw.status === 'draft') {
    try {
      return {
        schema: WORKSPACE_SCHEMA,
        status: 'draft',
        version: Number(raw.version),
        updatedAt: raw.updatedAt,
        draft: normalizeLessonPrepWorkspaceDraft(raw.draft),
      };
    } catch {
      return null;
    }
  }
  if (
    raw.status !== 'hidden' ||
    (raw.previousStatus !== 'draft' && raw.previousStatus !== 'active') ||
    typeof raw.hiddenAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.hiddenAt))
  ) {
    return null;
  }
  try {
    return {
      schema: WORKSPACE_SCHEMA,
      status: 'hidden',
      version: Number(raw.version),
      updatedAt: raw.updatedAt,
      hiddenAt: raw.hiddenAt,
      previousStatus: raw.previousStatus,
      ...(raw.previousStatus === 'draft'
        ? { draft: normalizeLessonPrepWorkspaceDraft(raw.draft) }
        : {}),
    };
  } catch {
    return null;
  }
}

export function lessonPrepWorkspace(run: RunRecord): LessonPrepWorkspaceState | null {
  return parseLessonPrepWorkspace(run.runtimeState?.lessonPrepWorkspace);
}

export function isLessonPrepDraft(run: RunRecord): boolean {
  return lessonPrepWorkspace(run)?.status === 'draft';
}

export function isLessonPrepHidden(run: RunRecord): boolean {
  return lessonPrepWorkspace(run)?.status === 'hidden';
}

export function lessonPrepPublicStatus(run: RunRecord): 'draft' | RunRecord['status'] {
  return isLessonPrepDraft(run) ? 'draft' : run.status;
}

/** Finalized immutable input must be an exact projection of the last saved editable fields. */
export function lessonPrepDraftMatchesFinalInput(
  draft: LessonPrepWorkspaceDraft,
  value: unknown,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  try {
    const projected = normalizeLessonPrepWorkspaceDraft({
      teacherRequirements: payload.teacherRequirements,
      learningObjectives: payload.learningObjectives,
      promptOwnerAllowlistVersion: payload.promptOwnerAllowlistVersion,
      ownerInstructions: payload.ownerInstructions,
      sourceAssets: payload.sourceAssets,
      ...(payload.locale === undefined ? {} : { locale: payload.locale }),
    });
    return JSON.stringify(projected) === JSON.stringify(draft);
  } catch {
    return false;
  }
}
