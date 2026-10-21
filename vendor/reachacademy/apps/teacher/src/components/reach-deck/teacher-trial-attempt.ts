export interface TeacherReachDeckTrialAttempt {
  attemptId: string;
  organizationId: string;
  courseId: string;
  courseWorkspaceType: 'draft';
  courseNodeId: string;
  moduleId: string;
  moduleVersionId: string;
}

export async function startTeacherReachDeckTrialAttempt(
  courseId: string,
  courseNodeId: string,
): Promise<TeacherReachDeckTrialAttempt> {
  const response = await fetch(
    `/api/portal/teacher/courses/${encodeURIComponent(courseId)}/nodes/${encodeURIComponent(courseNodeId)}/reach-deck-trial-attempts`,
    { method: 'POST', headers: { accept: 'application/json' } },
  );
  const body = (await response.json()) as { data?: unknown; message?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof body.message === 'string'
        ? body.message
        : `Teacher BFF returned HTTP ${response.status}`,
    );
  }
  const attempt = requireRecord(body.data, 'Teacher trial attempt');
  const result: TeacherReachDeckTrialAttempt = {
    attemptId: requireUuid(attempt.attemptId, 'attemptId'),
    organizationId: requireUuid(attempt.organizationId, 'organizationId'),
    courseId: requireUuid(attempt.courseId, 'courseId'),
    courseWorkspaceType: requireDraft(attempt.courseWorkspaceType),
    courseNodeId: requireUuid(attempt.courseNodeId, 'courseNodeId'),
    moduleId: requireUuid(attempt.moduleId, 'moduleId'),
    moduleVersionId: requireUuid(attempt.moduleVersionId, 'moduleVersionId'),
  };
  if (result.courseId !== courseId || result.courseNodeId !== courseNodeId) {
    throw new Error('Teacher trial attempt identity does not match the requested module.');
  }
  return result;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireUuid(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`Teacher trial attempt ${field} must be a UUID.`);
  }
  return value;
}

function requireDraft(value: unknown): 'draft' {
  if (value !== 'draft') throw new Error('Teacher trial attempt must use the draft workspace.');
  return value;
}
