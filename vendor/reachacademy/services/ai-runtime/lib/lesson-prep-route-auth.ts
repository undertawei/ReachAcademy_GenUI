import type { NextRequest } from 'next/server';
import type { RunRecord } from './contracts.js';

export function lessonPrepCourseMatches(request: NextRequest, run: RunRecord): boolean {
  const courseId = request.nextUrl.searchParams.get('courseId')?.trim();
  return (
    typeof courseId === 'string' && courseId.length > 0 && run.domainScope.courseId === courseId
  );
}

export function lessonPrepWorkspaceHidden(run: RunRecord): boolean {
  return run.runtimeState?.lessonPrepWorkspace?.status === 'hidden';
}

export function lessonPrepWorkspaceDeletedResponse(): Response {
  return Response.json(
    {
      code: 'LESSON_PREP_WORKSPACE_DELETED',
      error: 'This lesson-prep workspace has been deleted.',
    },
    { status: 410 },
  );
}
