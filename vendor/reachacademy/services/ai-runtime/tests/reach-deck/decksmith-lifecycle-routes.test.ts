import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  cancel: vi.fn(),
  closeQueue: vi.fn(),
  closeReader: vi.fn(),
  closeRedis: vi.fn(),
  createEventStore: vi.fn(),
  createQueue: vi.fn(),
  createRedisSource: vi.fn(),
  openReader: vi.fn(),
  readDescriptor: vi.fn(),
  readResult: vi.fn(),
  readStagedResult: vi.fn(),
  readWithPayload: vi.fn(),
  readWithRecovery: vi.fn(),
  replay: vi.fn(),
  waitAfter: vi.fn(),
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  createReachDeckEventStoreRedisSource: dependencies.createRedisSource,
  createReachDeckGenerationQueue: dependencies.createQueue,
}));
vi.mock('@/lib/reach-deck/decksmith/event-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/event-store.js')>()),
  createDecksmithEventProvenanceResolver: vi.fn(() => vi.fn()),
  createDecksmithEventStore: dependencies.createEventStore,
}));
vi.mock('@/lib/reach-deck/workspace-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  readReachDeckGenerationJobWithRecovery: dependencies.readWithRecovery,
  readReachDeckGenerationResultWithRecovery: dependencies.readStagedResult,
  readReachDeckWorkspaceDecksmithJobDescriptor: dependencies.readDescriptor,
  readReachDeckWorkspaceDecksmithResult: dependencies.readResult,
}));

import { GET as streamJob } from '../../app/api/reach-deck/generation/[jobId]/events/route.js';
import { GET as readResult } from '../../app/api/reach-deck/generation/[jobId]/result/route.js';
import { DecksmithEventCursorError } from '../../lib/reach-deck/decksmith/event-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const jobId = 'decksmith-v1-lifecycle-route';
const scopedContext = {
  ...TEST_REACH_DECK_SCOPE,
  claims: {
    actorId: TEST_REACH_DECK_SCOPE.actorId,
    orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
    subject: TEST_REACH_DECK_SCOPE.actorId,
  },
};
const decksmithJob = {
  jobId,
  kind: 'decksmith' as const,
  status: 'active',
  progress: 25,
  done: false,
};

describe('Decksmith lifecycle routes', () => {
  beforeEach(() => {
    dependencies.authorize.mockReset().mockResolvedValue(scopedContext);
    dependencies.cancel.mockReset();
    dependencies.closeQueue.mockReset().mockResolvedValue(undefined);
    dependencies.closeReader.mockReset().mockResolvedValue(undefined);
    dependencies.closeRedis.mockReset().mockResolvedValue(undefined);
    dependencies.readWithPayload.mockReset().mockResolvedValue(null);
    dependencies.createQueue.mockReset().mockResolvedValue({
      read: vi.fn(async () => decksmithJob),
      readWithPayload: dependencies.readWithPayload,
      cancel: dependencies.cancel,
      close: dependencies.closeQueue,
    });
    dependencies.createRedisSource.mockReset().mockResolvedValue({
      client: Promise.resolve({}),
      streamKey: vi.fn(),
      close: dependencies.closeRedis,
    });
    dependencies.replay.mockReset().mockResolvedValue({
      events: [stored('7-0', 'result-ready')],
      streamAvailable: true,
      cursorExpired: false,
      terminal: true,
      lastEventId: '7-0',
    });
    dependencies.waitAfter.mockReset();
    dependencies.openReader.mockReset().mockResolvedValue({
      waitAfter: dependencies.waitAfter,
      close: dependencies.closeReader,
    });
    dependencies.createEventStore.mockReset().mockReturnValue({
      replay: dependencies.replay,
      openReader: dependencies.openReader,
    });
    dependencies.readDescriptor.mockReset().mockResolvedValue(null);
    dependencies.readWithRecovery.mockReset().mockResolvedValue(decksmithJob);
    dependencies.readResult.mockReset().mockResolvedValue(decksmithResult());
    dependencies.readStagedResult.mockReset().mockResolvedValue(null);
  });

  it('serves replayable Decksmith SSE ids with retry and no-buffering headers', async () => {
    const response = await streamJob(request('events'), params());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(body).toContain('retry: 2000');
    expect(body).toContain('id: 7-0');
    expect(body).toContain('event: decksmith');
    expect(dependencies.replay).toHaveBeenCalledWith(jobId, TEST_REACH_DECK_SCOPE, undefined);
    expect(dependencies.closeReader).toHaveBeenCalledOnce();
    expect(dependencies.closeRedis).toHaveBeenCalledOnce();
    expect(dependencies.closeQueue).toHaveBeenCalledOnce();
  });

  it('rejects conflicting Last-Event-ID and after cursors before opening Redis replay', async () => {
    const response = await streamJob(
      request('events?after=2-0', { 'Last-Event-ID': '1-0' }),
      params(),
    );

    expect(response.status).toBe(400);
    expect(dependencies.replay).not.toHaveBeenCalled();
    expect(dependencies.closeQueue).toHaveBeenCalledOnce();
  });

  it.each([
    ['malformed', 'bad-cursor', 400],
    ['future', '99-0', 409],
  ] as const)('fails closed for a %s replay cursor', async (kind, cursor, status) => {
    dependencies.replay.mockRejectedValue(
      new DecksmithEventCursorError(
        kind === 'malformed'
          ? 'Decksmith event cursor is malformed'
          : 'Decksmith event cursor is in the future',
      ),
    );

    const response = await streamJob(request('events', { 'Last-Event-ID': cursor }), params());

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: 'Decksmith event cursor cannot be resumed',
    });
    expect(dependencies.closeRedis).toHaveBeenCalledOnce();
    expect(dependencies.closeQueue).toHaveBeenCalledOnce();
  });
  it('returns a durable-result fallback path for a trimmed cursor', async () => {
    dependencies.replay.mockResolvedValue({
      events: [],
      streamAvailable: true,
      cursorExpired: true,
      terminal: true,
      lastEventId: '9-0',
    });

    const response = await streamJob(request('events', { 'Last-Event-ID': '1-0' }), params());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Decksmith event cursor is no longer available',
      resultPath: `/api/generation/${jobId}/result`,
    });
    expect(dependencies.closeRedis).toHaveBeenCalledOnce();
    expect(dependencies.closeQueue).toHaveBeenCalledOnce();
  });

  it('disconnects the HTTP stream without cancelling the durable job', async () => {
    let rejectWait: ((error: Error) => void) | undefined;
    dependencies.replay.mockResolvedValue({
      events: [],
      streamAvailable: false,
      cursorExpired: false,
      terminal: false,
    });
    dependencies.waitAfter.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectWait = reject;
        }),
    );
    dependencies.closeReader.mockImplementation(async () => {
      const error = new Error('reader closed');
      error.name = 'AbortError';
      rejectWait?.(error);
    });

    const response = await streamJob(request('events'), params());
    await response.body!.cancel();

    expect(dependencies.closeReader).toHaveBeenCalledOnce();
    expect(dependencies.closeRedis).toHaveBeenCalledOnce();
    expect(dependencies.closeQueue).toHaveBeenCalledOnce();
    expect(dependencies.cancel).not.toHaveBeenCalled();
  });

  it('reads a Decksmith result from durable recovery after Redis cleanup', async () => {
    dependencies.readWithRecovery.mockResolvedValue({
      ...decksmithJob,
      status: 'completed',
      progress: 100,
      resultAvailable: true,
      done: true,
    });

    const response = await readResult(request('result'), params());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      jobId,
      kind: 'decksmith',
      result: { kind: 'decksmith', message: 'Recovered' },
    });
    expect(dependencies.readResult).toHaveBeenCalledWith(jobId, TEST_REACH_DECK_SCOPE);
    expect(dependencies.readStagedResult).not.toHaveBeenCalled();
  });

  it('returns 404 when a cancelled changed result has no fenced Runtime proposal', async () => {
    dependencies.readWithRecovery.mockResolvedValue({
      ...decksmithJob,
      status: 'cancelled',
      progress: 0,
      error: 'Generation cancelled',
      done: true,
    });
    dependencies.readResult.mockResolvedValue(null);

    const response = await readResult(request('result'), params());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Reach Deck generation result not found' });
    expect(dependencies.readResult).toHaveBeenCalledWith(jobId, TEST_REACH_DECK_SCOPE);
    expect(dependencies.readStagedResult).not.toHaveBeenCalled();
  });

  it('fails closed before event-store lookup for another scope', async () => {
    dependencies.readWithRecovery.mockResolvedValue(null);

    const response = await streamJob(request('events'), params());

    expect(response.status).toBe(404);
    expect(dependencies.createQueue).not.toHaveBeenCalled();
    expect(dependencies.createEventStore).not.toHaveBeenCalled();
  });

  it('keeps completed staged generation on the existing polling SSE branch', async () => {
    dependencies.readWithRecovery.mockResolvedValue({
      jobId,
      kind: 'lesson-plan',
      status: 'completed',
      progress: 100,
      done: true,
    });

    const response = await streamJob(request('events'), params());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('event: job');
    expect(body).toContain('"kind":"lesson-plan"');
    expect(dependencies.createRedisSource).not.toHaveBeenCalled();
    expect(dependencies.closeQueue).toHaveBeenCalledOnce();
  });
});

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new Request(`http://reach-deck.test/api/generation/${jobId}/${path}`, {
    headers,
  }) as NextRequest;
}

function params(): { params: Promise<{ jobId: string }> } {
  return { params: Promise.resolve({ jobId }) };
}

function stored(id: string, type: 'result-ready') {
  return {
    id,
    event: {
      schemaVersion: 'reach-deck-decksmith-event/v1',
      jobId,
      attempt: 1,
      type,
      payload: { resultPath: `/api/generation/${jobId}/result` },
    },
  };
}

function decksmithResult() {
  return {
    schemaVersion: 'reach-deck-decksmith-result/v2',
    kind: 'decksmith',
    capability: 'reach-deck-decksmith/v2',
    jobId,
    runId: 'decksmith-run-v1-test',
    requestHash: 'a'.repeat(64),
    baseDocumentHash: 'b'.repeat(64),
    resultHash: 'c'.repeat(64),
    attempt: 1,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:00:01.000Z',
    message: 'Recovered',
    changed: false,
  };
}
