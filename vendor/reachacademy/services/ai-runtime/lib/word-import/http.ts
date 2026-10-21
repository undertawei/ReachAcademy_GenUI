import { NextResponse } from 'next/server';
import { authorizeRequest, RuntimeAuthorizationError } from '../auth.js';
import type { RunRecord, RuntimeActor } from '../contracts.js';
import type { RuntimeStore } from '../store/index.js';
import { errorResponse, isUuid } from '../http.js';
import {
  isWordImportTargetUnavailableError,
  readWordImportSourceTicket,
  type WordImportSourceTicket,
} from './content-client.js';
import { canRetryWordImportRun, WORD_IMPORT_TARGET_UNAVAILABLE } from './control.js';
import { wordImportInput } from './input.js';

export async function readBoundedWordBody(request: Request, maximum: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (declared > maximum) throw new Error('word-import.input-too-large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('word-import.input-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function authorizeWordImportActor(headers: Headers): Promise<RuntimeActor> {
  const actor = await authorizeRequest(headers);
  if (!actor.roles.includes('teacher') || !actor.roleGrantId)
    throw new RuntimeAuthorizationError('Teacher role authorization is required', 403);
  return actor;
}

export async function authorizedWordImportRun(
  runId: string,
  actor: RuntimeActor,
  store: RuntimeStore,
): Promise<RunRecord> {
  if (!isUuid(runId)) throw new RuntimeAuthorizationError('Word import was not found', 403);
  const run = await store.getRun(runId);
  if (
    !run ||
    run.sceneKey !== 'teacher.quiz.word-import' ||
    run.actor.subject !== actor.subject ||
    run.actor.orgId !== actor.orgId
  )
    throw new RuntimeAuthorizationError('Word import was not found', 403);
  // A stale stored grant is not a substitute for the current session and live authoring permission.
  await authorizedWordImportTicket({ ...run, actor }, store);
  return { ...run, actor };
}

export async function authorizedWordImportRunContext(
  runId: string,
  actor: RuntimeActor,
  store: RuntimeStore,
): Promise<{ run: RunRecord; ticket: WordImportSourceTicket }> {
  if (!isUuid(runId)) throw new RuntimeAuthorizationError('Word import was not found', 403);
  const run = await store.getRun(runId);
  if (
    !run ||
    run.sceneKey !== 'teacher.quiz.word-import' ||
    run.actor.subject !== actor.subject ||
    run.actor.orgId !== actor.orgId
  )
    throw new RuntimeAuthorizationError('Word import was not found', 403);
  const authorized = { ...run, actor };
  return { run: authorized, ticket: await authorizedWordImportTicket(authorized, store) };
}

export async function authorizedWordImportTicket(
  run: RunRecord,
  store: RuntimeStore,
): Promise<WordImportSourceTicket> {
  try {
    return await readWordImportSourceTicket(run, process.env, undefined, true);
  } catch (error) {
    if (isWordImportTargetUnavailableError(error))
      await store.terminalizeWordImportTargetUnavailable(run.id);
    throw error;
  }
}

export function publicWordImportRun(run: RunRecord, applied = false): Record<string, unknown> {
  const input = wordImportInput(run);
  const control = run.runtimeState?.wordImport;
  return {
    runId: run.id,
    mode: input.mode,
    sourceAssetId: input.sourceAssetId,
    courseId: input.courseId,
    courseNodeId: input.courseNodeId,
    moduleVersionId: input.moduleVersionId,
    paperId: input.paperId,
    ...(input.paperIdentityContract ? { paperIdentityContract: input.paperIdentityContract } : {}),
    status: run.status,
    applied,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    cancelledAt: run.cancelledAt,
    errorCode: run.error?.code,
    timings: control?.timings ?? {},
    completedPhases: Object.keys(control?.checkpoints ?? {}),
    modelCalls: control?.modelCalls ?? 0,
    deadlineAt: control?.deadlineAt,
    canRetry: canRetryWordImportRun(run, new Date()),
  };
}

export function wordImportErrorResponse(error: unknown): Response {
  if (error instanceof Error && error.message.startsWith('word-import.')) {
    const code = error.message;
    const status =
      code === WORD_IMPORT_TARGET_UNAVAILABLE
        ? 409
        : /content-(401|403|404)/.test(code)
          ? 403
          : /invalid|mismatch|too-large/.test(code)
            ? 400
            : 503;
    return NextResponse.json({ error: code }, { status });
  }
  return errorResponse(error);
}
