import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  auditAbort: vi.fn(),
  auditRead: vi.fn(),
  auditUpdate: vi.fn(),
  auditUpdateRetry: vi.fn(),
  cancel: vi.fn(),
  cancelRuntime: vi.fn(),
  close: vi.fn(),
  createQueue: vi.fn(),
  read: vi.fn(),
  readWithPayload: vi.fn(),
  readWithRecovery: vi.fn(),
  readRecoveryDescriptor: vi.fn(),
  readDecksmithRecoveryDescriptor: vi.fn(),
  readDecksmithRecoveryJob: vi.fn(),
  readRecoveryJob: vi.fn(),
  readRecoveryResult: vi.fn(),
  retry: vi.fn(),
  loadWorkspace: vi.fn(),
  observeDecksmith: vi.fn(),
}));

vi.mock('@/lib/reach-deck/decksmith/observability', () => ({
  observeDecksmith: dependencies.observeDecksmith,
}));
vi.mock('@/lib/store/index', () => ({ getRuntimeStore: vi.fn(() => ({})) }));
vi.mock('@/lib/teacher-deck-runtime', () => ({
  createTeacherDeckRuntime: vi.fn(() => ({ cancel: dependencies.cancelRuntime })),
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/reach-deck/auth.js')>();
  return {
    ...original,
    authorizeScopedReachDeckRequest: dependencies.authorize,
  };
});
vi.mock('@/lib/reach-deck/queue', () => ({
  cancelReachDeckGenerationJob: dependencies.cancel,
  createReachDeckGenerationQueue: dependencies.createQueue,
  readReachDeckGenerationJob: dependencies.read,
  readReachDeckGenerationJobWithPayload: dependencies.readWithPayload,
  retryReachDeckGenerationJob: dependencies.retry,
}));
vi.mock('@/lib/reach-deck/generation-audit', () => ({
  abortReachDeckGenerationAuditByScopeWithNarrowRetry: dependencies.auditAbort,
  reachDeckGenerationAuditErrorSummary: (error: unknown, phase: string) =>
    JSON.stringify({ error: String(error), phase }),
  readReachDeckGenerationAuditByScope: dependencies.auditRead,
  updateReachDeckGenerationAuditByScope: dependencies.auditUpdate,
  updateReachDeckGenerationAuditByScopeWithNarrowRetry: dependencies.auditUpdateRetry,
}));
vi.mock('@/lib/reach-deck/workspace-store', () => ({
  loadReachDeckWorkspace: dependencies.loadWorkspace,
}));
vi.mock('@/lib/reach-deck/workspace-recovery', () => ({
  readReachDeckGenerationJobWithRecovery: dependencies.readWithRecovery,
  readReachDeckGenerationResultWithRecovery: dependencies.readRecoveryResult,
  readReachDeckWorkspaceRecoveryJob: dependencies.readRecoveryJob,
  readReachDeckWorkspaceRecoveryJobDescriptor: dependencies.readRecoveryDescriptor,
  readReachDeckWorkspaceDecksmithJobDescriptor: dependencies.readDecksmithRecoveryDescriptor,
  readReachDeckWorkspaceRecoveryDecksmithJob: dependencies.readDecksmithRecoveryJob,
}));

import { POST as cancelJob } from '../../app/api/reach-deck/generation/[jobId]/cancel/route.js';
import { GET as streamJob } from '../../app/api/reach-deck/generation/[jobId]/events/route.js';
import { GET as pollJob } from '../../app/api/reach-deck/generation/[jobId]/route.js';
import { GET as readResult } from '../../app/api/reach-deck/generation/[jobId]/result/route.js';
import { POST as retryJob } from '../../app/api/reach-deck/generation/[jobId]/retry/route.js';
import { createJobEventStream } from '../../lib/reach-deck/job-event-stream.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';

const scopedContext = {
  ...TEST_REACH_DECK_SCOPE,
  claims: {
    actorId: TEST_REACH_DECK_SCOPE.actorId,
    orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
    subject: TEST_REACH_DECK_SCOPE.actorId,
  },
};
const scope = TEST_REACH_DECK_SCOPE;
const jobId = 'deck-job-1';
const requestHash = 'a'.repeat(64);
const completedJob = {
  jobId,
  status: 'completed',
  progress: { phase: 'complete', percent: 100 },
  done: true,
};

describe('Reach Deck generation lifecycle routes', () => {
  beforeEach(() => {
    dependencies.authorize.mockReset().mockResolvedValue(scopedContext);
    dependencies.auditAbort.mockReset().mockResolvedValue({ status: 'aborted' });
    dependencies.auditRead
      .mockReset()
      .mockResolvedValue({ jobId, status: 'failed', executionAttempt: 2 });
    dependencies.auditUpdate
      .mockReset()
      .mockResolvedValue({ status: 'retrying', executionAttempt: 2 });
    dependencies.auditUpdateRetry.mockReset().mockResolvedValue({ status: 'aborted' });
    dependencies.cancel.mockReset().mockResolvedValue({
      changed: true,
      job: { jobId, status: 'cancelled', progress: 0, done: true },
    });
    dependencies.cancelRuntime.mockReset().mockResolvedValue(undefined);
    dependencies.retry.mockReset().mockResolvedValue({
      changed: true,
      job: { jobId, status: 'waiting', progress: 0, done: false },
    });
    dependencies.close.mockReset().mockResolvedValue(undefined);
    dependencies.read.mockReset().mockResolvedValue(completedJob);
    dependencies.readWithPayload
      .mockReset()
      .mockImplementation(async (id: string, jobScope: unknown) => {
        const view = await dependencies.read(id, jobScope);
        return view === null ? null : { view, payload: { requestHash } };
      });
    dependencies.readWithRecovery
      .mockReset()
      .mockImplementation((id: string, jobScope: unknown) => dependencies.read(id, jobScope));
    dependencies.readRecoveryDescriptor.mockReset().mockResolvedValue(null);
    dependencies.readRecoveryJob.mockReset().mockResolvedValue(null);
    dependencies.readDecksmithRecoveryDescriptor.mockReset().mockResolvedValue(null);
    dependencies.readDecksmithRecoveryJob.mockReset().mockResolvedValue(null);
    dependencies.readRecoveryResult.mockReset().mockResolvedValue({
      kind: 'lesson-plan',
      runId: 'run-1',
      generatedFromDraftRevision: 1,
      candidate: {
        id: 'plan-1',
        title: 'Private preview',
        audience: 'Teachers',
        durationMinutes: 10,
        learningObjectives: ['Inspect'],
        teachingStrategy: 'Preview',
        keyTerms: ['private'],
        narrative: 'Scoped result.',
      },
    });
    dependencies.observeDecksmith.mockReset();
    dependencies.loadWorkspace.mockReset().mockResolvedValue({
      workspace: { paused: false },
    });
    dependencies.createQueue.mockReset().mockResolvedValue({
      close: dependencies.close,
      read: dependencies.read,
    });
  });

  it('cancels a queued job with the same actor, course, and usage scope as polling', async () => {
    const response = await cancelJob(request('cancel'), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'cancelled', done: true });
    expect(dependencies.cancel).toHaveBeenCalledWith(jobId, scope);
    expect(dependencies.auditAbort).toHaveBeenCalledWith(
      jobId,
      requestHash,
      expect.not.objectContaining({ status: expect.anything() }),
      scope,
    );
  });

  it('cancels a durable active job when its old queue namespace is unavailable', async () => {
    dependencies.readWithPayload.mockResolvedValue(null);
    dependencies.readRecoveryDescriptor.mockResolvedValue({
      jobId,
      kind: 'lesson-plan',
      requestHash,
    });
    dependencies.readRecoveryJob.mockResolvedValue({
      jobId,
      kind: 'lesson-plan',
      status: 'queued',
      progress: 0,
      done: false,
    });

    const response = await cancelJob(request('cancel'), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'cancelled', done: true });
    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.auditAbort).toHaveBeenCalledWith(
      jobId,
      requestHash,
      expect.any(Object),
      scope,
    );
  });

  it('records Decksmith cancellation when recovering an expired queue job', async () => {
    dependencies.readWithPayload.mockResolvedValue(null);
    dependencies.readDecksmithRecoveryDescriptor.mockResolvedValue({
      jobId,
      kind: 'decksmith',
      requestHash,
    });
    dependencies.readDecksmithRecoveryJob.mockResolvedValue({
      jobId,
      kind: 'decksmith',
      status: 'queued',
      progress: 0,
      done: false,
    });

    const response = await cancelJob(request('cancel'), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'decksmith',
      status: 'cancelled',
      done: true,
    });
    expect(dependencies.observeDecksmith).toHaveBeenCalledWith({ event: 'cancelled', jobId });
  });

  it('returns a conflict instead of pretending an active job was cancelled', async () => {
    dependencies.cancel.mockResolvedValue({
      changed: false,
      job: { jobId, status: 'active', progress: 50, done: false },
    });

    const response = await cancelJob(request('cancel'), params());

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'active', done: false });
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('details');
  });

  it('returns the durable cancelled view for repeated cancellation', async () => {
    dependencies.cancel.mockResolvedValue({
      changed: false,
      job: { jobId, status: 'cancelled', progress: 0, done: true },
    });

    const response = await cancelJob(request('cancel'), params());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'cancelled', done: true });
  });

  it.each(['queue', 'recovery'] as const)(
    'keeps the cancellation conflict reason when the %s job fails before cancellation',
    async (path) => {
      const failed = {
        jobId,
        kind: 'lesson-plan',
        status: 'failed',
        progress: 50,
        done: true,
        error: 'Provider unavailable',
      };
      if (path === 'queue') {
        dependencies.cancel.mockResolvedValue({ changed: false, job: failed });
      } else {
        dependencies.readWithPayload.mockResolvedValue(null);
        dependencies.readRecoveryDescriptor.mockResolvedValue({
          jobId,
          kind: 'lesson-plan',
          requestHash,
        });
        dependencies.readRecoveryJob.mockResolvedValue(failed);
      }

      const response = await cancelJob(request('cancel'), params());

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        jobId,
        status: 'failed',
        done: true,
        error: 'Reach Deck generation job cannot be cancelled while failed',
        code: 'GENERATION_JOB_TERMINAL',
        details: { jobId, status: 'failed' },
      });
      expect(dependencies.auditAbort).not.toHaveBeenCalled();
      expect(dependencies.cancelRuntime).not.toHaveBeenCalled();
    },
  );

  it.each([
    { path: 'queue', status: 'completed' },
    { path: 'recovery', status: 'recovery-required' },
  ])(
    'returns scoped terminal proof for $path/$status cancellation conflicts',
    async ({ path, status }) => {
      const terminal = { jobId, kind: 'lesson-plan', status, progress: 100, done: true };
      if (path === 'queue') {
        dependencies.cancel.mockResolvedValue({ changed: false, job: terminal });
      } else {
        dependencies.readWithPayload.mockResolvedValue(null);
        dependencies.readRecoveryDescriptor.mockResolvedValue({
          jobId,
          kind: 'lesson-plan',
          requestHash,
        });
        dependencies.readRecoveryJob.mockResolvedValue(terminal);
      }
      const response = await cancelJob(request('cancel'), params());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        jobId,
        status,
        done: true,
        code: 'GENERATION_JOB_TERMINAL',
        details: { jobId, status },
      });
      expect(dependencies.auditAbort).not.toHaveBeenCalled();
      expect(dependencies.cancelRuntime).not.toHaveBeenCalled();
    },
  );

  it('reconciles a cancellation tombstone from its bounded Runtime job reference', async () => {
    dependencies.readWithPayload.mockResolvedValue({
      view: { jobId, status: 'cancelled', progress: 0, done: true },
      runtimeJob: { requestHash, kind: 'lesson-plan' },
    });
    dependencies.cancel.mockResolvedValue({
      changed: false,
      job: { jobId, status: 'cancelled', progress: 0, done: true },
    });

    const response = await cancelJob(request('cancel'), params());

    expect(response.status).toBe(200);
    expect(dependencies.cancel).toHaveBeenCalledWith(jobId, scope);
    expect(dependencies.auditAbort).toHaveBeenCalledWith(
      jobId,
      requestHash,
      expect.any(Object),
      scope,
    );
  });

  it('retries a failed job through BullMQ with scoped authorization', async () => {
    dependencies.read.mockResolvedValue({ ...completedJob, status: 'failed' });
    const response = await retryJob(request('retry'), params());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      jobId,
      status: 'waiting',
      pollPath: `/api/generation/${jobId}`,
      pollIntervalMs: 2_000,
    });
    expect(dependencies.retry).toHaveBeenCalledWith(jobId, scope);
    expect(dependencies.auditUpdate).toHaveBeenCalledWith(
      jobId,
      requestHash,
      expect.objectContaining({ status: 'retrying' }),
      scope,
    );
  });

  it('returns a stable conflict when another request already retried the job', async () => {
    dependencies.read.mockResolvedValue({ ...completedJob, status: 'failed' });
    dependencies.retry.mockResolvedValue({
      changed: false,
      job: { jobId, status: 'waiting', progress: 0, done: false },
    });

    const response = await retryJob(request('retry'), params());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: 'waiting', done: false });
    expect(dependencies.auditUpdateRetry).not.toHaveBeenCalled();
  });

  it('returns structured reconciliation details when durable audit is still queued@0', async () => {
    dependencies.read.mockResolvedValue({ ...completedJob, status: 'failed' });
    dependencies.auditRead.mockResolvedValue({ jobId, status: 'queued', executionAttempt: 0 });
    dependencies.auditUpdate.mockRejectedValue(
      new ContentServiceClientError('Reach Deck generation job state conflict', 409),
    );

    const response = await retryJob(request('retry'), params());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'Reach Deck generation job state conflict',
      status: 'failed',
      audit: { status: 'queued', executionAttempt: 0 },
      reconciliation: {
        reason: 'durable-state-conflict',
        actions: ['refresh', 'retry'],
      },
    });
    expect(dependencies.retry).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', new Error('redis retry failed'), 500],
    ['disappears', null, 404],
    [
      'stays failed',
      {
        changed: false,
        job: { jobId, status: 'failed', progress: 0, done: true },
      },
      409,
    ],
  ])(
    'rolls the audit back with the exact attempt when Queue.retry %s',
    async (_label, outcome, status) => {
      dependencies.read.mockResolvedValue({ ...completedJob, status: 'failed' });
      if (outcome instanceof Error) dependencies.retry.mockRejectedValue(outcome);
      else dependencies.retry.mockResolvedValue(outcome);

      const response = await retryJob(request('retry'), params());

      expect(response.status).toBe(status);
      expect(dependencies.auditUpdateRetry).toHaveBeenCalledWith(
        jobId,
        requestHash,
        expect.objectContaining({ status: 'failed', executionAttempt: 2 }),
        scope,
      );
    },
  );

  it('blocks staged retries while paused and allows them after resume', async () => {
    dependencies.read.mockResolvedValue({
      jobId,
      kind: 'lesson-plan',
      status: 'failed',
      progress: 10,
      done: true,
    });
    dependencies.loadWorkspace.mockResolvedValueOnce({ workspace: { paused: true } });

    const paused = await retryJob(request('retry'), params());

    expect(paused.status).toBe(409);
    expect(await paused.json()).toMatchObject({
      error: 'Reach Deck generation job cannot be retried while workspace is paused',
    });
    expect(dependencies.retry).not.toHaveBeenCalled();

    dependencies.loadWorkspace.mockResolvedValueOnce({ workspace: { paused: false } });
    const resumed = await retryJob(request('retry'), params());

    expect(resumed.status).toBe(202);
    expect(dependencies.retry).toHaveBeenCalledWith(jobId, scope);
  });

  it('streams the scoped BullMQ job view as a terminal SSE event', async () => {
    const response = await streamJob(request('events'), params());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(body).toContain('retry: 2000');
    expect(body).toContain('event: job');
    expect(body).toContain(`data: ${JSON.stringify(completedJob)}`);
    expect(dependencies.read).toHaveBeenCalledOnce();
    expect(dependencies.read).toHaveBeenCalledWith(jobId, scope);
    expect(dependencies.createQueue).toHaveBeenCalledOnce();
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it('keeps private results out of polling while serving the exact-scope result endpoint', async () => {
    dependencies.readWithRecovery.mockResolvedValue({
      ...completedJob,
      resultAvailable: true,
      result: { private: true },
      request: { prompt: 'secret' },
    });

    const polled = await pollJob(request('poll'), params());
    const pollBody = await polled.json();
    expect(polled.status).toBe(200);
    expect(pollBody).toMatchObject({
      jobId,
      status: 'completed',
      resultAvailable: true,
    });
    expect(pollBody).not.toHaveProperty('result');
    expect(pollBody).not.toHaveProperty('request');

    const preview = await readResult(request('result'), params());
    expect(preview.status).toBe(200);
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(await preview.json()).toMatchObject({
      jobId,
      kind: 'lesson-plan',
      result: { candidate: { title: 'Private preview' } },
    });
    expect(dependencies.readRecoveryResult).toHaveBeenCalledWith(jobId, scope);
  });

  it('slows browser polling while narration waits for TTS capacity', async () => {
    dependencies.readWithRecovery.mockResolvedValueOnce({
      ...completedJob,
      status: 'delayed',
      done: false,
      progress: { phase: 'waiting-tts', percent: 65 },
    });
    expect(await (await pollJob(request('poll'), params())).json()).toMatchObject({
      pollIntervalMs: 10_000,
    });

    dependencies.readWithRecovery.mockResolvedValueOnce({
      ...completedJob,
      status: 'active',
      done: false,
      progress: { phase: 'narration', percent: 10 },
    });
    expect(await (await pollJob(request('poll'), params())).json()).toMatchObject({
      pollIntervalMs: 2_000,
    });
  });

  it('sanitizes private failure details from polling and SSE job events', async () => {
    const privateError = 'provider rejected Authorization: Bearer secret-token';
    dependencies.readWithRecovery.mockResolvedValue({
      ...completedJob,
      status: 'failed',
      error: privateError,
    });

    const polled = await pollJob(request('poll'), params());
    const pollBody = await polled.json();
    expect(pollBody).toMatchObject({ status: 'failed', error: 'Generation failed: internal' });
    expect(JSON.stringify(pollBody)).not.toContain(privateError);

    const streamed = await streamJob(request('events'), params());
    const streamBody = await streamed.text();
    expect(streamBody).toContain('"error":"Generation failed: internal"');
    expect(streamBody).not.toContain(privateError);
  });

  it('returns stable generic errors for unexpected lifecycle infrastructure failures', async () => {
    dependencies.readWithRecovery.mockRejectedValue(new Error('redis password secret-token'));
    const polled = await pollJob(request('poll'), params());
    expect(polled.status).toBe(500);
    expect(await polled.json()).toEqual({ error: 'Failed to read Reach Deck job' });

    const streamed = await streamJob(request('events'), params());
    expect(streamed.status).toBe(500);
    expect(await streamed.json()).toEqual({ error: 'Failed to stream Reach Deck job' });

    dependencies.readRecoveryResult.mockRejectedValue(new Error('content-service secret-token'));
    const result = await readResult(request('result'), params());
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ error: 'Failed to read Reach Deck result' });

    dependencies.cancel.mockRejectedValue(new Error('redis secret-token'));
    const cancelled = await cancelJob(request('cancel'), params());
    expect(cancelled.status).toBe(500);
    expect(await cancelled.json()).toEqual({ error: 'Failed to cancel Reach Deck job' });

    dependencies.read.mockRejectedValue(new Error('redis secret-token'));
    const retried = await retryJob(request('retry'), params());
    expect(retried.status).toBe(500);
    expect(await retried.json()).toEqual({ error: 'Failed to retry Reach Deck job' });
  });

  it('sanitizes an SSE polling exception after the stream has opened', async () => {
    vi.useFakeTimers();
    try {
      const privateError = 'redis connection failed at private-host:6379';
      const running = {
        jobId,
        status: 'active',
        progress: 25,
        done: false,
      };
      const queue = {
        close: vi.fn(async () => undefined),
        read: vi.fn(async () => {
          throw new Error(privateError);
        }),
      };
      const bodyPromise = new Response(
        createJobEventStream(jobId, scope, running, new AbortController().signal, queue, {
          maxLifetimeMs: 10,
          pollIntervalMs: 1,
        }),
      ).text();

      await vi.advanceTimersByTimeAsync(1);
      const body = await bodyPromise;
      expect(body).toContain('event: error');
      expect(body).toContain('Failed to stream Reach Deck job');
      expect(body).not.toContain(privateError);
      expect(queue.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expose a job that the scoped queue lookup cannot see', async () => {
    dependencies.read.mockResolvedValue(null);

    const response = await streamJob(request('events'), params());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Reach Deck generation job not found' });
    expect(dependencies.createQueue).not.toHaveBeenCalled();
    expect(dependencies.close).not.toHaveBeenCalled();
  });

  it('expires a nonterminal stream while reusing and then closing one queue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
    try {
      const running = {
        jobId,
        status: 'active',
        progress: 25,
        done: false,
      };
      const queue = {
        close: vi.fn(async () => undefined),
        read: vi.fn(async () => running),
      };
      const bodyPromise = new Response(
        createJobEventStream(jobId, scope, running, new AbortController().signal, queue, {
          maxLifetimeMs: 8,
          pollIntervalMs: 1,
        }),
      ).text();

      await vi.advanceTimersByTimeAsync(8);
      const body = await bodyPromise;
      expect(body).toContain('event: timeout');
      expect(queue.read).toHaveBeenCalled();
      expect(queue.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts polling immediately and closes the shared queue', async () => {
    const running = {
      jobId,
      status: 'active',
      progress: 25,
      done: false,
    };
    const abort = new AbortController();
    const queue = {
      close: vi.fn(async () => undefined),
      read: vi.fn(async () => running),
    };
    const reader = createJobEventStream(jobId, scope, running, abort.signal, queue, {
      maxLifetimeMs: 10_000,
      pollIntervalMs: 10_000,
    }).getReader();

    await reader.read();
    abort.abort();
    while (!(await reader.read()).done) {
      // Drain the already-enqueued job event.
    }

    expect(queue.read).not.toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalledOnce();
  });
});

function request(action: string): NextRequest {
  return new Request(`http://reach-deck.test/api/generation/${jobId}/${action}`, {
    method: action === 'events' || action === 'poll' || action === 'result' ? 'GET' : 'POST',
  }) as NextRequest;
}

function params(): { params: Promise<{ jobId: string }> } {
  return { params: Promise.resolve({ jobId }) };
}
