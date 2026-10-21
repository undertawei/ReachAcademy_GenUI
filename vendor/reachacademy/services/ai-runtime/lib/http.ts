import { NextResponse } from 'next/server';
import { guardrailCode } from '@reachany/ai-runtime-feedforward';

import { RuntimeAuthorizationError } from './auth.js';
import { DomainServiceError } from './domain-client.js';
import type { RunRecord, ThreadRecord } from './contracts.js';
import { DecksmithDeckLockTimeoutError } from './reach-deck/decksmith/page-stream.js';
import {
  RunIdempotencyConflictError,
  RuntimeIdempotencyScopeConflictError,
  TutorStateConflictError,
} from './store/store.js';
import { formatRuntimeJobLogLine } from './worker-job-log.js';

// Every 503 below used to be silent (only the 500 path logged), so #602 P4 could not tell
// which dependency refused two Tutor messages. One line per response, with the request trace.
function logUnavailable(reason: string, status: number, fields: Record<string, unknown> = {}) {
  console.warn(formatRuntimeJobLogLine({ event: 'http.unavailable', reason, status, ...fields }));
}

export function errorResponse(error: unknown): NextResponse {
  // Approval and other non-workspace routes can also wait on the deck lock. Match the
  // semantic name too, because Next.js can load errors through different bundles.
  if (
    error instanceof DecksmithDeckLockTimeoutError ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'DecksmithDeckLockTimeoutError')
  ) {
    logUnavailable('decksmith_deck_lock', 503);
    return NextResponse.json(
      { error: 'Reach Deck is busy, please retry', code: 'DECKSMITH_DECK_LOCK_BUSY' },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }
  const code = guardrailCode(error);
  if (code) {
    if (code !== 'GUARDRAIL_BLOCKED') logUnavailable('guardrail_unavailable', 503, { code });
    return NextResponse.json(
      { error: code, code },
      { status: code === 'GUARDRAIL_BLOCKED' ? 422 : 503 },
    );
  }
  if (error instanceof RuntimeAuthorizationError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof RuntimeIdempotencyScopeConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof RunIdempotencyConflictError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof TutorStateConflictError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof DomainServiceError) {
    const status = error.status > 0 ? error.status : 503;
    if (status >= 500)
      logUnavailable('domain_service', status, {
        domainStatus: error.status,
        retryable: error.retryable,
        ...(error.causeCode ? { causeCode: error.causeCode } : {}),
      });
    return NextResponse.json({ error: error.message }, { status });
  }
  console.error(error);
  return NextResponse.json({ error: 'AI Runtime request failed' }, { status: 500 });
}

export function publicRun(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    threadId: run.threadId,
    sceneKey: run.sceneKey,
    sceneVersion: run.sceneVersion,
    status: run.status,
    input: run.input,
    domainScope: run.domainScope,
    tokenBudget: run.tokenBudget,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    cancelledAt: run.cancelledAt,
    error: run.error,
  };
}

export function publicThread(thread: ThreadRecord): Record<string, unknown> {
  return {
    id: thread.id,
    sceneKey: thread.sceneKey,
    tutorMode: thread.tutorMode,
    title: thread.title,
    domainScope: thread.domainScope,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
