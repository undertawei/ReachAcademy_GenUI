import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REFERENCE_MANIFEST_VERSION,
} from '@reachany/reach-deck-dsl';
import {
  createReferenceCoverageManifest,
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '@reachany/reach-deck-dsl/reference-library';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeQueueName, resolveRuntimeQueuePrefix } from '../../lib/queue.js';
import type {
  TeacherDeckRuntime,
  TeacherDeckRuntimeExecution,
} from '../../lib/teacher-deck-runtime.js';
import type {
  ReachDeckAnyGenerationJobPayload,
  ReachDeckDecksmithJobPayload,
  ReachDeckDecksmithLegacyJobPayload,
  ReachDeckDecksmithV2JobPayload,
  ReachDeckGenerationJobPayload,
  ReachDeckGenerationResult,
  ReachDeckLessonPlanJobPayload,
  ReachDeckPageGenerationJobPayload,
  ReachDeckStagedGenerationJobKind,
  ReachDeckStagedGenerationJobPayload,
} from '../../lib/reach-deck/contracts.js';
import {
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  parseReachDeckDecksmithJobInput,
} from '../../lib/reach-deck/contracts.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithJobId,
  buildDecksmithRequestHash,
  buildDecksmithRunId,
  buildReachDeckInteractiveNarrationTextDigest,
  buildScopedStagedGenerationRequestHash,
  buildStagedGenerationJobId,
  buildStagedGenerationRequestHash,
} from '../../lib/reach-deck/job-identity.js';
import {
  REACH_DECK_DECKSMITH_JOB_NAME,
  REACH_DECK_GENERATION_JOB_NAME,
  REACH_DECK_GENERATION_QUEUE_NAME,
  REACH_DECK_LESSON_PLAN_JOB_NAME,
  REACH_DECK_NARRATION_GENERATION_JOB_NAME,
  REACH_DECK_PAGE_GENERATION_JOB_NAME,
  REACH_DECK_PAGE_OUTLINE_JOB_NAME,
  ReachDeckGenerationCancelledError,
  buildReachDeckRedisConnection,
  createReachDeckEventStoreRedisSourceFromBullMQ,
  createReachDeckGenerationQueueFromBullMQ,
  enqueueReachDeckBatchCoordinator,
  enqueueReachDeckGenerationJob,
  enqueueReachDeckGenerationJobWithQueue,
  processReachDeckQueuedJob,
  parseReachDeckStagedGenerationJobPayload,
  reachDeckJobNameForPayload,
  resolveReachDeckQueuePrefix,
  type ReachDeckGenerationJobScope,
} from '../../lib/reach-deck/queue.js';
import {
  buildReachDeckBatchCoordinatorJobPayload,
  REACH_DECK_BATCH_COORDINATOR_JOB_NAME,
} from '../../lib/reach-deck/workspace-batches.js';
import { ReachDeckTtsQueuedError } from '../../lib/reach-deck/model-service-tools.js';
import { buildReachDeckTtsRequestIdentity } from '../../lib/reach-deck/generation-media.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import { buildScientificGenerationContext } from '../../lib/reach-deck/scientific-generation-context.js';
import {
  OTHER_MODULE_VERSION_ID,
  OTHER_ORGANIZATION_ID,
  TEST_REACH_DECK_RESOURCE_SCOPE,
} from './fixtures/resource-scope.js';

const legacyRequest = { prompt: 'Generate a deck' };
const payload: ReachDeckGenerationJobPayload = {
  jobId: 'deck-job-1',
  runId: 'run-1',
  pageId: 'document',
  pageRevision: 1,
  attempt: 'regenerate',
  actorId: 'teacher-1',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  requestHash: buildScopedStagedGenerationRequestHash(
    TEST_REACH_DECK_RESOURCE_SCOPE,
    legacyRequest,
  ),
  request: legacyRequest,
};

const stagedRequest = { source: 'Generate a staged lesson plan' };
const queueEnv = {
  REACHANY_ENV: 'test',
  REACHANY_QUEUE_NAMESPACE: 'unit',
  REDIS_HOST: 'redis',
} as const;
const queuePrefix = resolveReachDeckQueuePrefix(queueEnv);
const stagedPayload: ReachDeckLessonPlanJobPayload = {
  schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  kind: 'lesson-plan',
  jobId: 'deck-v3-job-1',
  actorId: 'teacher-1',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  runId: 'run-staged-1',
  createdFromDraftRevision: 4,
  requestHash: buildScopedStagedGenerationRequestHash(TEST_REACH_DECK_RESOURCE_SCOPE, {
    request: stagedRequest,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  }),
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  request: stagedRequest,
};

describe('Reach Deck BullMQ queue', () => {
  it('adds a deterministic coordinator job without creating a generation audit', async () => {
    const coordinator = buildReachDeckBatchCoordinatorJobPayload(
      {
        actorId: stagedPayload.actorId,
        billingGroupId: stagedPayload.billingGroupId,
        roleGrantId: stagedPayload.roleGrantId,
        resourceScope: stagedPayload.resourceScope,
      },
      '11111111-1111-4111-8111-111111111111',
      0,
      '2026-09-13T08:00:00.000Z',
    );
    const queue = coordinatorQueueStub();

    await enqueueReachDeckBatchCoordinator(coordinator, queueEnv, async () => queue);

    expect(queue.add).toHaveBeenCalledWith(
      REACH_DECK_BATCH_COORDINATOR_JOB_NAME,
      coordinator,
      expect.objectContaining({
        jobId: coordinator.jobId,
        delay: 1_000,
        removeOnComplete: true,
      }),
    );
    expect(queue.close).toHaveBeenCalledOnce();
  });

  it('treats an identical coordinator as idempotent and rejects a same-ID payload collision', async () => {
    const coordinator = buildReachDeckBatchCoordinatorJobPayload(
      {
        actorId: stagedPayload.actorId,
        billingGroupId: stagedPayload.billingGroupId,
        roleGrantId: stagedPayload.roleGrantId,
        resourceScope: stagedPayload.resourceScope,
      },
      '11111111-1111-4111-8111-111111111111',
      0,
      '2026-09-13T08:00:00.000Z',
    );
    const queue = coordinatorQueueStub();
    queue.getJob.mockResolvedValue({ data: coordinator });

    await enqueueReachDeckBatchCoordinator(coordinator, queueEnv, async () => queue);
    expect(queue.add).not.toHaveBeenCalled();

    await expect(
      enqueueReachDeckBatchCoordinator(
        { ...coordinator, createdAt: '2026-09-13T08:01:00.000Z' },
        queueEnv,
        async () => queue,
      ),
    ).resolves.toBeUndefined();
    expect(queue.add).not.toHaveBeenCalled();

    const collisionQueue = coordinatorQueueStub();
    collisionQueue.getJob.mockResolvedValue({
      data: { ...coordinator, actorId: 'another-actor' },
    });
    await expect(
      enqueueReachDeckBatchCoordinator(coordinator, queueEnv, async () => collisionQueue),
    ).rejects.toThrow(/identity collides/i);
    expect(collisionQueue.add).not.toHaveBeenCalled();
    expect(collisionQueue.close).toHaveBeenCalledOnce();
  });

  it('retries an exhausted deterministic coordinator job in place', async () => {
    const coordinator = buildReachDeckBatchCoordinatorJobPayload(
      {
        actorId: stagedPayload.actorId,
        billingGroupId: stagedPayload.billingGroupId,
        roleGrantId: stagedPayload.roleGrantId,
        resourceScope: stagedPayload.resourceScope,
      },
      '11111111-1111-4111-8111-111111111111',
      2,
      '2026-09-13T08:00:00.000Z',
    );
    const queue = coordinatorQueueStub();
    const retry = vi.fn(async () => undefined);
    queue.getJob.mockResolvedValue({
      data: coordinator,
      getState: vi.fn(async () => 'failed'),
      retry,
    });

    await enqueueReachDeckBatchCoordinator(coordinator, queueEnv, async () => queue);

    expect(retry).toHaveBeenCalledWith('failed');
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalledOnce();
  });

  it('builds password-safe Redis and TLS connections', () => {
    expect(
      buildReachDeckRedisConnection({
        REDIS_URL: 'rediss://user:p%40ss@redis.example.test:6380/3',
      }),
    ).toEqual({
      host: 'redis.example.test',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 3,
      tls: {},
    });
    expect(buildReachDeckRedisConnection({ REDIS_HOST: 'redis', REDIS_PORT: '6381' })).toEqual({
      host: 'redis',
      port: 6381,
    });
  });

  it('isolates BullMQ keys by environment and stable deployment namespace', () => {
    expect(resolveReachDeckQueuePrefix(queueEnv)).toBe('{ai-runtime:test:unit:teacher-deck}');
    expect(resolveReachDeckQueuePrefix(queueEnv)).toBe(
      resolveRuntimeQueuePrefix('teacher.deck', queueEnv),
    );
    expect(resolveReachDeckQueuePrefix({ REACHANY_ENV: 'test' })).toBe(
      '{ai-runtime:test:reachany:teacher-deck}',
    );
    expect(() =>
      resolveReachDeckQueuePrefix({
        REACHANY_ENV: 'test',
        REACHANY_QUEUE_NAMESPACE: 'Invalid Namespace',
      }),
    ).toThrow('REACHANY_QUEUE_NAMESPACE');
  });

  it('exposes the existing namespaced BullMQ queue client for Decksmith event streams', async () => {
    const client = {
      disconnect: vi.fn(),
      duplicate: vi.fn(),
      eval: vi.fn(),
      get: vi.fn(async () => null),
      xrange: vi.fn(),
      xrevrange: vi.fn(),
      xread: vi.fn(),
    };
    const close = vi.fn(async () => undefined);
    const constructor = vi.fn();
    class FakeQueue {
      client = Promise.resolve(client);
      toKey = (type: string) => `${queuePrefix}:${REACH_DECK_GENERATION_QUEUE_NAME}:${type}`;
      constructor(name: string, options: { connection: Record<string, unknown>; prefix: string }) {
        constructor(name, options);
      }
      add = vi.fn();
      close = close;
      getJob = vi.fn();
    }

    const source = createReachDeckEventStoreRedisSourceFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(source.client).resolves.toBe(client);
    expect(source.streamKey('decksmith-v1-job')).toBe(
      `${queuePrefix}:${REACH_DECK_GENERATION_QUEUE_NAME}:decksmith-events:decksmith-v1-job`,
    );
    expect(constructor).toHaveBeenCalledWith(
      REACH_DECK_GENERATION_QUEUE_NAME,
      expect.objectContaining({ prefix: queuePrefix }),
    );
    await source.close();
    expect(close).toHaveBeenCalledOnce();
  });
  it('maps legacy and staged payload kinds to distinct BullMQ job names', () => {
    expect(REACH_DECK_GENERATION_QUEUE_NAME).toBe(resolveRuntimeQueueName('teacher.deck'));
    expect(reachDeckJobNameForPayload(payload)).toBe(REACH_DECK_GENERATION_JOB_NAME);
    expect(reachDeckJobNameForPayload(stagedPayload)).toBe(REACH_DECK_LESSON_PLAN_JOB_NAME);
    expect(reachDeckJobNameForPayload(stagedPayloadForKind('page-outline'))).toBe(
      REACH_DECK_PAGE_OUTLINE_JOB_NAME,
    );
    expect(reachDeckJobNameForPayload(stagedPayloadForKind('page-generation'))).toBe(
      REACH_DECK_PAGE_GENERATION_JOB_NAME,
    );
    expect(reachDeckJobNameForPayload(stagedPayloadForKind('narration-generation'))).toBe(
      REACH_DECK_NARRATION_GENERATION_JOB_NAME,
    );
  });

  it('prioritizes page layout jobs ahead of narration jobs', async () => {
    const { add, queue } = createValidationQueue();
    await queue.enqueue(stagedPayloadForKind('page-generation'));
    expect(add).toHaveBeenLastCalledWith(
      REACH_DECK_PAGE_GENERATION_JOB_NAME,
      expect.any(Object),
      expect.objectContaining({ priority: 1 }),
    );

    await queue.enqueue(stagedPayloadForKind('narration-generation'));
    expect(add).toHaveBeenLastCalledWith(
      REACH_DECK_NARRATION_GENERATION_JOB_NAME,
      expect.any(Object),
      expect.objectContaining({ priority: 10 }),
    );
    await queue.close();
  });

  it('rejects raw v4 staged payloads instead of projecting a default voice', () => {
    expect(() =>
      parseReachDeckStagedGenerationJobPayload({
        ...stagedPayloadForKind('lesson-plan'),
        schemaVersion: 'reach-deck-generation-job/v4',
      }),
    ).toThrow(/no longer accepted/);
  });

  it('rejects raw v4 staged payloads before worker execution', async () => {
    const candidate = {
      ...stagedPayloadForKind('lesson-plan'),
      schemaVersion: 'reach-deck-generation-job/v4',
    } as unknown as ReachDeckAnyGenerationJobPayload;
    const runtime = runtimeStub();
    const processor = vi.fn(async () => ({ kind: 'lesson-plan' }));

    await expect(
      processReachDeckQueuedJob(
        {
          id: candidate.jobId,
          name: REACH_DECK_LESSON_PLAN_JOB_NAME,
          data: candidate,
          attemptsMade: 0,
          opts: { attempts: 3 },
          updateProgress: vi.fn(async () => undefined),
        },
        directProcessorOptions(processor, runtime),
      ),
    ).rejects.toThrow(/no longer accepted/);
    expect(runtime.claim).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
  });

  it('reconciles an existing audit and Runtime run for a rejected pre-claim payload', async () => {
    const candidate = {
      ...stagedPayloadForKind('lesson-plan'),
      schemaVersion: 'reach-deck-generation-job/v4',
    } as unknown as ReachDeckAnyGenerationJobPayload;
    const audit = {
      ...createAuditLifecycle(),
      read: vi.fn(async () => auditResource('queued', 0)),
    };
    const runtime = runtimeStub();
    const existingRun = { id: 'runtime-run', status: 'queued' } as never;
    runtime.readExisting = vi.fn(async () => existingRun);
    runtime.failExisting = vi.fn(async () => undefined);

    await expect(
      processReachDeckQueuedJob(
        {
          id: candidate.jobId,
          name: REACH_DECK_LESSON_PLAN_JOB_NAME,
          data: candidate,
          attemptsMade: 0,
          opts: { attempts: 3 },
          updateProgress: vi.fn(async () => undefined),
        },
        { ...directProcessorOptions(vi.fn(), runtime), audit },
      ),
    ).rejects.toThrow(/no longer accepted/);

    expect(audit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: candidate.jobId,
        runId: candidate.runId,
        requestHash: candidate.requestHash,
      }),
      expect.objectContaining({ status: 'failed', executionAttempt: 0 }),
    );
    expect(runtime.readExisting).toHaveBeenCalledOnce();
    expect(runtime.failExisting).toHaveBeenCalledWith(existingRun, expect.any(Error));
    expect(runtime.ensureQueued).not.toHaveBeenCalled();
    expect(runtime.fail).not.toHaveBeenCalled();
  });

  it.each([
    ['missing resource scope', { ...payload, resourceScope: undefined }],
    ['missing billing scope', { ...payload, billingGroupId: undefined }],
    ['missing request hash', { ...payload, requestHash: undefined }],
    ['mismatched request hash', { ...payload, requestHash: 'b'.repeat(64) }],
    ['oversized job id', { ...payload, jobId: 'j'.repeat(129) }],
    ['oversized run id', { ...payload, runId: 'r'.repeat(101) }],
    ['oversized page id', { ...payload, pageId: 'p'.repeat(257) }],
    [
      'blank module version scope',
      { ...payload, resourceScope: { ...payload.resourceScope, moduleVersionId: ' ' } },
    ],
  ])('fails closed for a legacy job with %s', async (_label, candidate) => {
    const { add, queue } = createValidationQueue();

    await expect(
      queue.enqueue(candidate as unknown as ReachDeckGenerationJobPayload),
    ).rejects.toThrow(/legacy generation payload|Reach Deck/);
    expect(add).not.toHaveBeenCalled();
  });

  it.each([
    [
      'v2 schema',
      { ...stagedPayload, schemaVersion: 'reach-deck-generation-job/v2' },
      /no longer accepted/,
    ],
    [
      'v3 schema',
      { ...stagedPayload, schemaVersion: 'reach-deck-generation-job/v3' },
      /no longer accepted/,
    ],
    [
      'v4 schema',
      { ...stagedPayload, schemaVersion: 'reach-deck-generation-job/v4' },
      /no longer accepted/,
    ],
    ['missing billing scope', { ...stagedPayload, billingGroupId: undefined }, /billingGroupId/],
  ])('rejects a staged job with %s', async (_label, candidate, message) => {
    const { add, queue } = createValidationQueue();

    await expect(
      queue.enqueue(candidate as unknown as ReachDeckStagedGenerationJobPayload),
    ).rejects.toThrow(message);
    expect(add).not.toHaveBeenCalled();
  });

  it.each(['lesson-plan', 'page-outline', 'page-generation', 'narration-generation'] as const)(
    'accepts a strictly valid %s staged request',
    async (kind) => {
      const { add, queue } = createValidationQueue();
      const candidate = stagedPayloadForKind(kind);

      await expect(queue.enqueue(candidate)).resolves.toBeUndefined();
      expect(add).toHaveBeenCalledWith(
        reachDeckJobNameForPayload(candidate),
        candidate,
        expect.objectContaining({ jobId: candidate.jobId }),
      );
    },
  );

  it.each(['page-generation', 'narration-generation'] as const)(
    'round-trips four-asset reference %s jobs and rejects altered immutable design snapshots',
    async (kind) => {
      const designContext = referenceDesign();
      const page = {
        ...validPage,
        instructionalSpec: {
          learningObjective: 'Compare four observations',
          teachingMove: 'explain',
          keyPoints: [
            'Each observation is evidence',
            'Compare the patterns',
            'Explain the difference',
          ],
          visualDirection: 'Compare observations',
          density: 'medium',
          visualAssets: Array.from({ length: 4 }, (_, index) => ({
            kind: 'image',
            purpose: 'evidence',
            prompt: `Observation ${index + 1}`,
            alt: `Observation ${index + 1}`,
            aspectRatio: '1:1',
            placement: 'supporting',
          })),
        },
      };
      const request =
        kind === 'page-generation'
          ? {
              ...validPageGenerationRequest,
              page,
              pagedOutline: {
                ...validPagedOutline,
                pages: [page],
                designContext,
                manifestVersion: REFERENCE_MANIFEST_VERSION,
                referenceCoverage: createReferenceCoverageManifest(),
              },
            }
          : { ...validNarrationGenerationRequest, page, designContext };
      const candidate = stagedPayloadWithRequest(kind, request);
      const decoded = parseReachDeckStagedGenerationJobPayload(
        JSON.parse(JSON.stringify(candidate)),
      );
      expect(decoded).toEqual(candidate);
      const { queue, add } = createValidationQueue();
      await expect(queue.enqueue(decoded)).resolves.toBeUndefined();
      expect(add).toHaveBeenCalledWith(
        reachDeckJobNameForPayload(candidate),
        candidate,
        expect.objectContaining({ jobId: candidate.jobId }),
      );
      expect(parseReachDeckStagedGenerationJobPayload(stagedPayloadForKind(kind))).toEqual(
        stagedPayloadForKind(kind),
      );
      const corrupted = structuredClone(candidate);
      if (corrupted.kind === 'page-generation')
        corrupted.request.pagedOutline.designContext!.resolvedColors.accent = '#224466';
      else if (corrupted.kind === 'narration-generation' && 'designContext' in corrupted.request)
        corrupted.request.designContext!.resolvedColors.accent = '#224466';
      expect(() => parseReachDeckStagedGenerationJobPayload(corrupted)).toThrow(/hash/i);
    },
  );

  it.each([
    [
      '缺 slideContentDigest',
      (request: Record<string, unknown>) => delete request.slideContentDigest,
      /missing or unsupported keys/,
    ],
    [
      'digest 非 64 位十六进制',
      (request: Record<string, unknown>) => (request.slideContentDigest = 'not-a-digest'),
      /slideContentDigest is invalid/,
    ],
    [
      'page 与 pageId 不一致',
      (request: Record<string, unknown>) => (request.pageId = 'page-9'),
      /page must match the requested pageId/,
    ],
    [
      '非 slide 页',
      (request: Record<string, unknown>) =>
        (request.page = { ...(request.page as Record<string, unknown>), sceneType: 'quiz' }),
      /only applies to slide pages/,
    ],
    [
      'attemptReason 非法',
      (request: Record<string, unknown>) => (request.attemptReason = 'repair'),
      /attemptReason is invalid/,
    ],
  ])('rejects a narration-generation request with %s', async (_label, mutate, message) => {
    const { add, queue } = createValidationQueue();
    const request = structuredClone(validNarrationGenerationRequest) as Record<string, unknown>;
    mutate(request);
    const candidate = stagedPayloadWithRequest('narration-generation', request);

    await expect(queue.enqueue(candidate)).rejects.toThrow(message);
    expect(add).not.toHaveBeenCalled();
  });

  it.each(['workspace-interactive', 'materialized-interactive'] as const)(
    'accepts a valid %s narration request',
    async (sourceKind) => {
      const { add, queue } = createValidationQueue();
      const narrationText = 'Move the control, then compare how the output changes.';
      const request =
        sourceKind === 'workspace-interactive'
          ? {
              sourceKind,
              runId: stagedPayload.runId,
              pageId: 'interactive-page',
              requestedRevision: 2,
              attempt: 1,
              attemptReason: 'initial',
              source: 'Explore a changing system.',
              page: {
                id: 'interactive-page',
                order: 1,
                sceneType: 'interactive',
                title: 'System explorer',
              },
              interactiveContentDigest: 'a'.repeat(64),
              narrationText,
              narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
            }
          : {
              sourceKind,
              runId: stagedPayload.runId,
              pageId: 'interactive-page',
              requestedRevision: 2,
              attempt: 1,
              attemptReason: 'regenerate',
              requestKey: 'request-interactive-narration',
              interactiveContentDigest: 'a'.repeat(64),
              narrationText,
              narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
            };
      const candidate = stagedPayloadWithRequest('narration-generation', request);

      await expect(queue.enqueue(candidate)).resolves.toBeUndefined();
      expect(add).toHaveBeenCalledOnce();
    },
  );

  it('accepts four-asset reference neighbors in materialized Interactive lesson context', async () => {
    const narrationText = 'Move the control, then compare how the output changes.';
    const neighbor = {
      ...validPage,
      id: 'page-before',
      instructionalSpec: {
        learningObjective: 'Compare four observations',
        teachingMove: 'explain',
        keyPoints: [
          'Each observation is evidence',
          'Compare the patterns',
          'Explain the difference',
        ],
        visualDirection: 'Compare observations',
        density: 'medium',
        visualAssets: Array.from({ length: 4 }, (_, index) => ({
          kind: 'image',
          purpose: 'evidence',
          prompt: `Observation ${index + 1}`,
          alt: `Observation ${index + 1}`,
          aspectRatio: '1:1',
          placement: 'supporting',
        })),
      },
    };
    const lessonContext = {
      courseTitle: 'Systems',
      pageIndex: 1,
      totalPages: 2,
      currentPage: {
        id: 'interactive-page',
        order: 2,
        sceneType: 'interactive',
        title: 'System explorer',
      },
      precedingPages: [neighbor],
    };
    // lessonContext stays out of the durable requestHash, so attach it after hashing.
    const withLessonContext = (request: Record<string, unknown>) => {
      const payload = stagedPayloadWithRequest('narration-generation', request);
      return { ...payload, request: { ...request, lessonContext } } as typeof payload;
    };
    const request = {
      sourceKind: 'materialized-interactive',
      mode: 'regenerate-text',
      runId: stagedPayload.runId,
      pageId: 'interactive-page',
      requestedRevision: 2,
      attempt: 1,
      attemptReason: 'regenerate',
      requestKey: 'request-interactive-narration',
      interactiveContentDigest: 'a'.repeat(64),
      narrationText,
      narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
    };
    const { queue: withoutDesign } = createValidationQueue();
    await expect(withoutDesign.enqueue(withLessonContext(request))).rejects.toThrow(
      /instructional spec/,
    );
    const { add, queue } = createValidationQueue();
    await expect(
      queue.enqueue(withLessonContext({ ...request, designContext: referenceDesign() })),
    ).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledOnce();
  });

  it.each([
    ['non-canonical text', { narrationText: '  Move the control.  ' }, /already be canonical/],
    ['wrong text digest', { narrationTextDigest: 'c'.repeat(64) }, /does not match narrationText/],
    [
      'malformed content digest',
      { interactiveContentDigest: 'invalid' },
      /content digest is invalid/,
    ],
    ['blank materialized request key', { requestKey: ' ' }, /requestKey/],
  ])(
    'rejects malformed materialized Interactive narration: %s',
    async (_label, override, message) => {
      const { add, queue } = createValidationQueue();
      const narrationText = 'Move the control, then compare how the output changes.';
      const candidate = stagedPayloadWithRequest('narration-generation', {
        sourceKind: 'materialized-interactive',
        runId: stagedPayload.runId,
        pageId: 'interactive-page',
        requestedRevision: 2,
        attempt: 1,
        attemptReason: 'regenerate',
        requestKey: 'request-interactive-narration',
        interactiveContentDigest: 'a'.repeat(64),
        narrationText,
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
        ...override,
      });

      await expect(queue.enqueue(candidate)).rejects.toThrow(message);
      expect(add).not.toHaveBeenCalled();
    },
  );

  describe('text-only narration requests', () => {
    const narrationText = 'Move the control, then compare how the output changes.';
    const interactiveRequest = {
      sourceKind: 'materialized-interactive',
      mode: 'regenerate-text',
      textOnly: true,
      runId: stagedPayload.runId,
      pageId: 'interactive-page',
      requestedRevision: 2,
      attempt: 1,
      attemptReason: 'regenerate',
      requestKey: 'request-interactive-text-only',
      interactiveContentDigest: 'a'.repeat(64),
      narrationText,
      narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
    };
    const nativeRequest = {
      sourceKind: 'materialized-native',
      mode: 'regenerate-text',
      textOnly: true,
      runId: stagedPayload.runId,
      pageId: 'native-page',
      requestedRevision: 3,
      attempt: 1,
      attemptReason: 'regenerate',
      requestKey: 'request-native-text-only',
      deckTitle: 'Systems deck',
      pageTitle: 'Systems page',
      nativeSlideContentDigest: 'b'.repeat(64),
      narrationContentDigest: 'c'.repeat(64),
    };

    it.each([
      ['materialized Interactive', interactiveRequest],
      ['materialized native', nativeRequest],
    ])('accepts a literal true flag on a %s rewrite', async (_label, request) => {
      const { add, queue } = createValidationQueue();
      await expect(
        queue.enqueue(stagedPayloadWithRequest('narration-generation', request)),
      ).resolves.toBeUndefined();
      expect(add).toHaveBeenCalledOnce();
    });

    it.each([
      ['Interactive non-literal flag', { ...interactiveRequest, textOnly: false }],
      ['Interactive without rewrite mode', { ...interactiveRequest, mode: undefined }],
      [
        'Interactive superseded audio',
        { ...interactiveRequest, supersededAudioResourceId: 'media-old-audio' },
      ],
      ['native non-literal flag', { ...nativeRequest, textOnly: 'true' }],
      ['native animation mode', { ...nativeRequest, animationMode: 'regenerate' }],
      [
        'native saved content',
        { ...nativeRequest, mode: 'saved-content', narrationMarkdown: 'Saved narration.' },
      ],
      [
        'workspace slide request',
        { ...structuredClone(validNarrationGenerationRequest), textOnly: true },
      ],
    ])('rejects a text-only %s request', async (_label, request) => {
      const { add, queue } = createValidationQueue();
      const candidate = stagedPayloadWithRequest(
        'narration-generation',
        JSON.parse(JSON.stringify(request)),
      );
      await expect(queue.enqueue(candidate)).rejects.toThrow(
        /text-only narration request is invalid|unsupported keys/,
      );
      expect(add).not.toHaveBeenCalled();
    });
  });

  it('accepts the bounded previous-page summary shape for new page jobs', async () => {
    const { add, queue } = createValidationQueue();
    const { previousSlides: _legacy, ...request } = validPageGenerationRequest;
    const candidate = stagedPayloadWithRequest('page-generation', {
      ...request,
      previousPageSummaries: [
        {
          pageId: 'page-before',
          layoutReferenceIds: ['single-focus-statement-v1'],
          hero: false,
          elementTypeCounts: { text: 2, image: 1 },
        },
      ],
    });

    await expect(queue.enqueue(candidate)).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledOnce();
  });

  it('accepts a page-generation request carrying a regeneration plan', async () => {
    // 批次重新生成的版面通道会带 regenerationPlan；白名单漏掉它会让协调任务入队时被永久拒绝。
    const { add, queue } = createValidationQueue();
    const candidate = stagedPayloadWithRequest('page-generation', {
      ...validPageGenerationRequest,
      regenerationPlan: {
        channels: { layout: true, narration: true, audio: false, animation: false },
        audioAnimationMode: 'preserve',
      },
    });

    await expect(queue.enqueue(candidate)).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledOnce();

    const invalid = stagedPayloadWithRequest('page-generation', {
      ...validPageGenerationRequest,
      regenerationPlan: { channels: {} },
    });
    await expect(queue.enqueue(invalid)).rejects.toThrow();
    expect(add).toHaveBeenCalledOnce();
  });

  it('accepts bounded earlier quiz context only for a later quiz page', async () => {
    const { add, queue } = createValidationQueue();
    const earlierQuiz = { ...validPage, id: 'quiz-before', order: 1, sceneType: 'quiz' as const };
    const currentQuiz = { ...validPage, id: 'quiz-current', order: 2, sceneType: 'quiz' as const };
    const candidate = stagedPayloadWithRequest('page-generation', {
      ...validPageGenerationRequest,
      pageId: currentQuiz.id,
      page: currentQuiz,
      pagedOutline: { ...validPagedOutline, pages: [earlierQuiz, currentQuiz] },
      previousQuizSummaries: [
        {
          pageId: earlierQuiz.id,
          learningObjective: 'Classify evidence using a stated criterion.',
          assessmentEvidence: 'Select one supported classification.',
          teachingMove: 'evaluate',
          questionType: 'single_choice',
          questionSummary: 'Which classification follows from the observation?',
          cognitiveEvidence: 'Apply the criterion to the supplied evidence.',
        },
      ],
    });

    await expect(queue.enqueue(candidate)).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledOnce();
  });

  it('rejects previous quiz context on a non-quiz page', async () => {
    const { add, queue } = createValidationQueue();
    const candidate = stagedPayloadWithRequest('page-generation', {
      ...validPageGenerationRequest,
      previousQuizSummaries: [],
    });

    await expect(queue.enqueue(candidate)).rejects.toThrow(/previousQuizSummaries is invalid/);
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects earlier quiz context that is not in page order', async () => {
    const { add, queue } = createValidationQueue();
    const firstQuiz = { ...validPage, id: 'quiz-first', order: 1, sceneType: 'quiz' as const };
    const secondQuiz = { ...validPage, id: 'quiz-second', order: 2, sceneType: 'quiz' as const };
    const currentQuiz = { ...validPage, id: 'quiz-current', order: 3, sceneType: 'quiz' as const };
    const summary = (pageId: string) => ({
      pageId,
      learningObjective: 'Compare two representations using one criterion.',
      teachingMove: 'evaluate' as const,
      questionType: 'single_choice' as const,
      questionSummary: 'Which representation satisfies the stated criterion?',
    });
    const candidate = stagedPayloadWithRequest('page-generation', {
      ...validPageGenerationRequest,
      pageId: currentQuiz.id,
      page: currentQuiz,
      pagedOutline: { ...validPagedOutline, pages: [firstQuiz, secondQuiz, currentQuiz] },
      previousQuizSummaries: [summary(secondQuiz.id), summary(firstQuiz.id)],
    });

    await expect(queue.enqueue(candidate)).rejects.toThrow(/page order is invalid/);
    expect(add).not.toHaveBeenCalled();
  });

  it('accepts the enabled scene type set on page-outline jobs', async () => {
    const { add, queue } = createValidationQueue();
    const candidate = stagedPayloadWithRequest('page-outline', {
      ...validPageOutlineRequest,
      enabledSceneTypes: ['slide', 'quiz'],
    });

    await expect(queue.enqueue(candidate)).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledOnce();
  });

  it('accepts page-outline jobs with missing or malformed advisory Step 2 context', async () => {
    const { add, queue } = createValidationQueue();
    const { lessonPlan: _ignored, ...sourceOnly } = validPageOutlineRequest;
    await expect(
      queue.enqueue(stagedPayloadWithRequest('page-outline', sourceOnly)),
    ).resolves.toBeUndefined();
    await expect(
      queue.enqueue(
        stagedPayloadWithRequest('page-outline', {
          ...sourceOnly,
          lessonPlan: { knowledgePlan: { points: 'teacher text' } },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(add).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: 'cross-kind request shape',
      payload: () => stagedPayloadWithRequest('lesson-plan', validPageOutlineRequest),
      message: 'unsupported keys',
    },
    {
      label: 'malformed enabled scene type set',
      payload: () =>
        stagedPayloadWithRequest('page-outline', {
          ...validPageOutlineRequest,
          enabledSceneTypes: [],
        }),
      message: 'enabledSceneTypes must be a string array',
    },
    {
      label: 'unsupported request field',
      payload: () =>
        stagedPayloadWithRequest('lesson-plan', {
          ...stagedRequest,
          unsupported: true,
        }),
      message: 'unsupported keys',
    },
    {
      label: 'top-level and nested run mismatch',
      payload: () => ({
        ...stagedPayloadWithRequest('page-generation', validPageGenerationRequest),
        runId: 'run-other',
      }),
      message: 'top-level runId does not match',
    },
    {
      label: 'missing previous-page context shape',
      payload: () => {
        const { previousSlides: _legacy, ...request } = validPageGenerationRequest;
        return stagedPayloadWithRequest('page-generation', request);
      },
      message: 'must include previousPageSummaries or legacy previousSlides',
    },
  ])('rejects a hash-valid $label', async ({ payload: createPayload, message }) => {
    const { add, queue } = createValidationQueue();
    const candidate = createPayload();

    await expect(queue.enqueue(candidate)).rejects.toThrow(message);
    expect(add).not.toHaveBeenCalled();
  });

  it('collapses exact staged duplicates but rejects a colliding request hash', async () => {
    let stored: ReachDeckAnyGenerationJobPayload = stagedPayload;
    const add = vi.fn(async () => undefined);
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = add;
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({ data: stored }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(queue.enqueue({ ...stagedPayload, request: { ...stagedRequest } })).resolves.toBe(
      undefined,
    );
    expect(add).not.toHaveBeenCalled();

    const collidingRequest = { source: 'A different staged request' };
    stored = {
      ...stagedPayload,
      request: collidingRequest,
      requestHash: buildStagedGenerationRequestHash(collidingRequest),
    };
    await expect(queue.enqueue(stagedPayload)).rejects.toThrow(
      'collides with another request hash',
    );
    expect(add).not.toHaveBeenCalled();
  });

  it('collapses a delayed deterministic duplicate while preserving immutable identity', async () => {
    const existing = deterministicPageGenerationPayload(6);
    const reconciled = deterministicPageGenerationPayload(8);
    const add = vi.fn(async () => undefined);
    let stored: ReachDeckAnyGenerationJobPayload = existing;
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = add;
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({ data: stored }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    expect(reconciled).toMatchObject({
      jobId: existing.jobId,
      requestHash: existing.requestHash,
      request: existing.request,
      createdFromDraftRevision: 8,
    });
    await expect(queue.enqueue(reconciled)).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();

    const changedSource = structuredClone(validPageGenerationRequest);
    changedSource.source = 'Changed source';
    await expect(
      queue.enqueue(deterministicPageGenerationPayload(8, changedSource, existing.jobId)),
    ).rejects.toThrow('collides with another request hash');

    const changedPage = structuredClone(validPageGenerationRequest);
    changedPage.page.title = 'Changed page title';
    await expect(
      queue.enqueue(deterministicPageGenerationPayload(8, changedPage, existing.jobId)),
    ).rejects.toThrow('collides with another request hash');

    const changedRun = structuredClone(validPageGenerationRequest);
    changedRun.runId = 'run-other';
    const runCollision = {
      ...deterministicPageGenerationPayload(8, changedRun, existing.jobId),
      runId: 'run-other',
    };
    await expect(queue.enqueue(runCollision)).rejects.toThrow('collides with another request hash');

    await expect(queue.enqueue({ ...reconciled, actorId: 'teacher-other' })).rejects.toThrow(
      'collides with another scope',
    );
    await expect(
      queue.enqueue({ ...reconciled, billingGroupId: 'billing-group-1' }),
    ).rejects.toThrow('collides with another scope');

    stored = stagedPayload;
    await expect(queue.enqueue({ ...stagedPayload, createdFromDraftRevision: 5 })).rejects.toThrow(
      'collides with another staged payload',
    );
  });

  it('reads staged jobs using top-level ownership scope and exposes their kind', async () => {
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({
        data: stagedPayload,
        getState: async () => 'waiting',
        getProgress: async () => 10,
      }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });
    const scope = stagedPayloadScope();

    const publicView = await queue.read(stagedPayload.jobId, scope);
    expect(publicView).toMatchObject({
      kind: 'lesson-plan',
      status: 'waiting',
    });
    expect(publicView).not.toHaveProperty('payload');
    await expect(queue.readWithPayload(stagedPayload.jobId, scope)).resolves.toEqual({
      payload: stagedPayload,
      view: publicView,
    });
    await expect(
      queue.read(stagedPayload.jobId, {
        ...scope,
        resourceScope: { ...scope.resourceScope, courseId: OTHER_ORGANIZATION_ID },
      }),
    ).resolves.toBeNull();
    await expect(
      queue.read(stagedPayload.jobId, {
        ...scope,
        resourceScope: { ...scope.resourceScope, organizationId: OTHER_ORGANIZATION_ID },
      }),
    ).resolves.toBeNull();
    await expect(
      queue.read(stagedPayload.jobId, {
        ...scope,
        resourceScope: { ...scope.resourceScope, moduleVersionId: OTHER_MODULE_VERSION_ID },
      }),
    ).resolves.toBeNull();
    await expect(
      queue.read(stagedPayload.jobId, { ...scope, billingGroupId: 'billing-group-1' }),
    ).resolves.toBeNull();
  });

  it.each([
    ['provider failure', 'provider rejected secret-token', 'Generation failed: internal'],
    ['cancellation', 'Generation cancelled', 'Generation cancelled'],
  ])('sanitizes a BullMQ %s reason in public job views', async (_label, failedReason, error) => {
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({
        data: stagedPayload,
        failedReason,
        getState: async () => 'failed',
        getProgress: async () => 10,
      }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    const publicView = await queue.read(stagedPayload.jobId, stagedPayloadScope());

    expect(publicView).toMatchObject({ status: 'failed', error, done: true });
    expect(JSON.stringify(publicView)).not.toContain('secret-token');
  });

  it('tombstones an active staged job without removing its BullMQ lock', async () => {
    const remove = vi.fn(async () => undefined);
    const client = createFakeRedisClient();
    client.eval.mockImplementation(async (_script, _keyCount, ...args) => {
      expect(args.at(-1)).toBe('1');
      return ['cancelled', 'active'];
    });
    class FakeQueue {
      client = Promise.resolve(client);
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({
        data: stagedPayload,
        getState: async () => 'active',
        getProgress: async () => ({ phase: 'lesson-plan', percent: 25 }),
        remove,
      }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(queue.cancel(stagedPayload.jobId, stagedPayloadScope())).resolves.toMatchObject({
      changed: true,
      job: { kind: 'lesson-plan', status: 'cancelled', done: true },
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('enqueues a stable identity with retries and reads completed results', async () => {
    let added = false;
    const add = vi.fn(async () => {
      added = true;
    });
    const close = vi.fn();
    let queueOptions: { connection: Record<string, unknown>; prefix: string } | undefined;
    const result = { runId: 'run-1', pageId: 'page-1', pageRevision: 2 } as
      | ReachDeckGenerationResult
      | undefined;
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        readonly name: string,
        readonly options: { connection: Record<string, unknown>; prefix: string },
      ) {
        queueOptions = options;
      }
      add = add;
      close = close;
      getJob = vi.fn(async () =>
        added
          ? {
              data: payload,
              getState: async () => 'completed',
              getProgress: async () => ({ phase: 'complete', percent: 100 }),
              returnvalue: result,
            }
          : undefined,
      );
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });
    expect(queueOptions).toMatchObject({ prefix: queuePrefix });
    await queue.enqueue(payload);
    expect(add).toHaveBeenCalledWith(
      REACH_DECK_GENERATION_JOB_NAME,
      payload,
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        jobId: payload.jobId,
      }),
    );
    expect(
      await queue.read(payload.jobId, {
        actorId: payload.actorId,
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
      }),
    ).toMatchObject({
      jobId: payload.jobId,
      status: 'completed',
      done: true,
      resultAvailable: true,
    });
    await queue.close();
    expect(close).toHaveBeenCalled();
  });

  it('uses the BullMQ job id to collapse duplicate enqueues', async () => {
    const storedJobs = new Map<string, ReachDeckAnyGenerationJobPayload>();
    const add = vi.fn(
      async (
        _name: string,
        data: ReachDeckAnyGenerationJobPayload,
        options: Record<string, unknown>,
      ) => {
        const jobId = String(options.jobId);
        if (!storedJobs.has(jobId)) storedJobs.set(jobId, data);
        return { id: jobId };
      },
    );
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient(['cancelled', 'waiting']));
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = add;
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => undefined);
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await queue.enqueue(payload);
    await queue.enqueue({ ...payload, request: { ...payload.request } });

    expect(add).toHaveBeenCalledTimes(2);
    expect(storedJobs).toHaveLength(1);
    expect(storedJobs.get(payload.jobId)).toEqual(payload);
  });

  it('cancels only scoped jobs that have not started', async () => {
    const remove = vi.fn(async () => undefined);
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({
        data: payload,
        getState: async () => 'waiting',
        getProgress: async () => ({ phase: 'queued', percent: 0 }),
        remove,
      }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });
    const scope = payloadScope();

    await expect(
      queue.cancel(payload.jobId, {
        ...scope,
        resourceScope: { ...scope.resourceScope, organizationId: OTHER_ORGANIZATION_ID },
      }),
    ).resolves.toBeNull();
    await expect(
      queue.cancel(payload.jobId, {
        ...scope,
        resourceScope: { ...scope.resourceScope, moduleVersionId: OTHER_MODULE_VERSION_ID },
      }),
    ).resolves.toBeNull();
    expect(remove).not.toHaveBeenCalled();

    expect(await queue.cancel(payload.jobId, scope)).toEqual({
      changed: true,
      job: {
        jobId: payload.jobId,
        status: 'cancelled',
        progress: { phase: 'queued', percent: 0 },
        error: 'Generation cancelled',
        done: true,
      },
    });
    expect(remove).toHaveBeenCalledOnce();

    expect(
      await queue.cancel(payload.jobId, {
        actorId: 'another-teacher',
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
      }),
    ).toBeNull();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('rejects active cancellation and retries a failed scoped job', async () => {
    let state = 'active';
    const remove = vi.fn(async () => undefined);
    const retry = vi.fn(async () => {
      state = 'waiting';
    });
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({
        data: payload,
        getState: async () => state,
        getProgress: async () => 25,
        remove,
        retry,
      }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });
    const scope = {
      actorId: payload.actorId,
      billingGroupId: payload.billingGroupId,
      roleGrantId: payload.roleGrantId,
      resourceScope: payload.resourceScope,
    };

    expect(await queue.cancel(payload.jobId, scope)).toMatchObject({
      changed: false,
      job: { status: 'active' },
    });
    expect(remove).not.toHaveBeenCalled();

    state = 'completed';
    expect(await queue.retry(payload.jobId, scope)).toMatchObject({
      changed: false,
      job: { status: 'completed' },
    });
    expect(retry).not.toHaveBeenCalled();

    state = 'failed';
    await expect(
      queue.retry(payload.jobId, {
        ...scope,
        resourceScope: { ...scope.resourceScope, organizationId: OTHER_ORGANIZATION_ID },
      }),
    ).resolves.toBeNull();
    await expect(
      queue.retry(payload.jobId, {
        ...scope,
        resourceScope: { ...scope.resourceScope, moduleVersionId: OTHER_MODULE_VERSION_ID },
      }),
    ).resolves.toBeNull();
    expect(retry).not.toHaveBeenCalled();
    expect(await queue.retry(payload.jobId, scope)).toMatchObject({
      changed: true,
      job: { status: 'waiting', done: false },
    });
    expect(retry).toHaveBeenCalledWith('failed');
  });

  it('keeps cancellation durable, idempotent, and non-resurrecting until expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
    try {
      const redis = createExpiringLifecycleRedis();
      let storedJob:
        | {
            data: ReachDeckGenerationJobPayload;
            getProgress: () => Promise<number>;
            getState: () => Promise<string>;
            remove: () => Promise<void>;
          }
        | undefined;
      const remove = vi.fn(async () => {
        storedJob = undefined;
      });
      storedJob = {
        data: payload,
        getProgress: async () => 0,
        getState: async () => 'waiting',
        remove,
      };
      const add = vi.fn(async () => {
        storedJob = {
          data: payload,
          getProgress: async () => 0,
          getState: async () => 'waiting',
          remove,
        };
      });
      class FakeQueue {
        client = Promise.resolve(redis.client);
        toKey = queueKey;
        constructor(
          _name: string,
          _options: { connection: Record<string, unknown>; prefix: string },
        ) {}
        add = add;
        close = vi.fn(async () => undefined);
        getJob = vi.fn(async () => storedJob);
      }
      const queue = createReachDeckGenerationQueueFromBullMQ({
        Queue: FakeQueue,
        env: { ...queueEnv, REACH_DECK_CANCELLATION_TTL_MS: '1000' },
      });
      const scope = payloadScope();

      expect(await queue.cancel(payload.jobId, scope)).toMatchObject({
        changed: true,
        job: { status: 'cancelled', done: true },
      });
      expect(await queue.cancel(payload.jobId, scope)).toMatchObject({
        changed: false,
        job: { status: 'cancelled', done: true },
      });
      expect(await queue.read(payload.jobId, scope)).toMatchObject({
        status: 'cancelled',
        done: true,
      });
      expect(await queue.read(payload.jobId, { ...scope, actorId: 'another-teacher' })).toBeNull();
      expect(
        await queue.read(payload.jobId, { ...scope, billingGroupId: 'billing-group-1' }),
      ).toBeNull();

      await queue.enqueue(payload);
      expect(add).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_001);
      await queue.enqueue(payload);
      expect(add).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects cancellation tombstones without explicit billing context', async () => {
    const client = createFakeRedisClient();
    client.get.mockResolvedValue(
      JSON.stringify({
        actorId: payload.actorId,
        ...payload.resourceScope,
        cancelledAt: '2026-07-18T00:00:00.000Z',
        done: true,
        error: 'Generation cancelled',
        jobId: payload.jobId,
        progress: 0,
        status: 'cancelled',
      }),
    );
    class FakeQueue {
      client = Promise.resolve(client);
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => undefined);
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(queue.read(payload.jobId, payloadScope())).rejects.toThrow(/billingGroupId/);
  });

  it('fails closed when a queued job becomes active during cancellation', async () => {
    let state = 'waiting';
    const remove = vi.fn(async () => undefined);
    const client = createFakeRedisClient();
    client.eval.mockImplementation(async (_script, _keyCount, ...args) => {
      state = 'active';
      expect(args.at(-1)).toBe('0');
      return ['blocked', 'active'];
    });
    const job = {
      data: payload,
      getProgress: async () => 0,
      getState: async () => state,
      remove,
    };
    class FakeQueue {
      client = Promise.resolve(client);
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => job);
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(queue.cancel(payload.jobId, payloadScope())).resolves.toMatchObject({
      changed: false,
      job: { status: 'active', done: false },
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('tombstones a staged job that becomes active inside the cancellation script', async () => {
    let state = 'waiting';
    const remove = vi.fn(async () => undefined);
    const client = createFakeRedisClient();
    client.eval.mockImplementation(async (_script, _keyCount, ...args) => {
      state = 'active';
      return args.at(-1) === '1' ? ['cancelled', 'active'] : ['blocked', 'active'];
    });
    const job = {
      data: stagedPayload,
      getProgress: async () => 25,
      getState: async () => state,
      remove,
    };
    class FakeQueue {
      client = Promise.resolve(client);
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => job);
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(queue.cancel(stagedPayload.jobId, stagedPayloadScope())).resolves.toMatchObject({
      changed: true,
      job: { kind: 'lesson-plan', status: 'cancelled', done: true },
    });
    expect(state).toBe('active');
    expect(remove).not.toHaveBeenCalled();
  });

  it('preserves a bounded Runtime ref and reconciles repeated cancellation after job removal', async () => {
    let tombstone: string | null = null;
    let storedJob:
      | {
          data: ReachDeckLessonPlanJobPayload;
          getProgress: () => Promise<number>;
          getState: () => Promise<string>;
          remove: () => Promise<void>;
        }
      | undefined;
    const remove = vi.fn(async () => {
      storedJob = undefined;
    });
    storedJob = {
      data: stagedPayload,
      getProgress: async () => 0,
      getState: async () => 'waiting',
      remove,
    };
    const client = createFakeRedisClient();
    client.get.mockImplementation(async () => tombstone);
    client.eval.mockImplementation(async (_script, _keyCount, ...args) => {
      tombstone = String(args.at(-3));
      return ['cancelled', 'waiting'];
    });
    class FakeQueue {
      client = Promise.resolve(client);
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => storedJob);
    }
    const runtime = runtimeStub();
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
      runtime,
    });

    await expect(queue.cancel(stagedPayload.jobId, stagedPayloadScope())).resolves.toMatchObject({
      changed: true,
      job: { status: 'cancelled' },
    });
    await expect(queue.cancel(stagedPayload.jobId, stagedPayloadScope())).resolves.toMatchObject({
      changed: false,
      job: { status: 'cancelled' },
    });

    expect(remove).toHaveBeenCalledOnce();
    expect(runtime.cancel).toHaveBeenCalledTimes(2);
    expect(runtime.cancel).toHaveBeenNthCalledWith(1, {
      actorId: stagedPayload.actorId,
      actorOrganizationId: stagedPayload.resourceScope.organizationId,
      billingGroupId: stagedPayload.billingGroupId,
      roleGrantId: stagedPayload.roleGrantId,
      resourceScope: stagedPayload.resourceScope,
      jobId: stagedPayload.jobId,
      runId: stagedPayload.runId,
      requestHash: stagedPayload.requestHash,
      kind: stagedPayload.kind,
    });
    expect(runtime.cancel).toHaveBeenNthCalledWith(2, runtime.cancel.mock.calls[0]![0]);
    const parsed = JSON.parse(tombstone!);
    expect(parsed.runtimeJob).toEqual(runtime.cancel.mock.calls[0]![0]);
    expect(parsed).not.toHaveProperty('request');
    expect(parsed.runtimeJob).not.toHaveProperty('request');
    expect(parsed.runtimeJob).not.toHaveProperty('document');
    expect(JSON.stringify(parsed)).not.toContain(stagedRequest.source);
    await expect(queue.readWithPayload(stagedPayload.jobId, stagedPayloadScope())).resolves.toEqual(
      {
        view: expect.objectContaining({ status: 'cancelled' }),
        runtimeJob: parsed.runtimeJob,
      },
    );
  });

  it('turns a concurrent BullMQ retry transition into a stable conflict view', async () => {
    let state = 'failed';
    const retry = vi.fn(async () => {
      state = 'waiting';
      throw new Error('Job is not in the failed state');
    });
    const job = {
      data: payload,
      getProgress: async () => 0,
      getState: async () => state,
      retry,
    };
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => job);
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(queue.retry(payload.jobId, payloadScope())).resolves.toMatchObject({
      changed: false,
      job: { status: 'waiting', done: false },
    });
  });

  it('publishes completed when Runtime completion wins after the active-job Lua check', async () => {
    let terminal: string | null = null;
    const client = createFakeRedisClient();
    client.get.mockImplementation(async () => terminal);
    client.eval.mockImplementation(async (_script, keyCount, ...args) => {
      if (keyCount === 10) {
        terminal = String(args.at(-3));
        return ['cancelled', 'active'];
      }
      expect(keyCount).toBe(1);
      expect(args[1]).toBe(terminal);
      terminal = String(args[2]);
      return ['completed', terminal];
    });
    const remove = vi.fn(async () => undefined);
    const job = {
      data: stagedPayload,
      getProgress: async () => 95,
      getState: async () => 'active',
      remove,
    };
    class FakeQueue {
      client = Promise.resolve(client);
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => job);
    }
    const runtime = runtimeStub();
    runtime.cancel.mockResolvedValue({ status: 'completed' });
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
      runtime,
    });

    await expect(queue.cancel(stagedPayload.jobId, stagedPayloadScope())).resolves.toEqual({
      changed: false,
      job: {
        jobId: stagedPayload.jobId,
        kind: stagedPayload.kind,
        status: 'completed',
        progress: { phase: 'complete', percent: 100 },
        resultAvailable: true,
        done: true,
      },
    });
    await expect(queue.read(stagedPayload.jobId, stagedPayloadScope())).resolves.toMatchObject({
      status: 'completed',
      resultAvailable: true,
      done: true,
    });
    await expect(
      queue.assertNotCancelled(stagedPayload.jobId, stagedPayloadScope()),
    ).resolves.toBeUndefined();
    await expect(queue.cancel(stagedPayload.jobId, stagedPayloadScope())).resolves.toMatchObject({
      changed: false,
      job: { status: 'completed' },
    });
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(JSON.parse(terminal!)).not.toHaveProperty('error');
  });

  it('does not overwrite a concurrent cancellation and reconciles it on a scoped read', async () => {
    let terminal: string | null = null;
    let markAttempts = 0;
    const client = createFakeRedisClient();
    client.get.mockImplementation(async () => terminal);
    client.eval.mockImplementation(async (_script, keyCount, ...args) => {
      if (keyCount === 10) {
        terminal = String(args.at(-3));
        return ['cancelled', 'active'];
      }
      markAttempts += 1;
      if (markAttempts === 1) {
        const concurrent = {
          ...JSON.parse(terminal!),
          cancelledAt: '2026-08-11T12:00:00.000Z',
        };
        terminal = JSON.stringify(concurrent);
        return ['conflict', terminal];
      }
      expect(args[1]).toBe(terminal);
      terminal = String(args[2]);
      return ['completed', terminal];
    });
    const job = {
      data: stagedPayload,
      getProgress: async () => 95,
      getState: async () => 'active',
      remove: vi.fn(async () => undefined),
    };
    class FakeQueue {
      client = Promise.resolve(client);
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = vi.fn();
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => job);
    }
    const runtime = runtimeStub();
    runtime.cancel.mockResolvedValue({ status: 'completed' });
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
      runtime,
    });

    await expect(queue.cancel(stagedPayload.jobId, stagedPayloadScope())).rejects.toThrow(
      'changed during completed-wins reconciliation',
    );
    expect(JSON.parse(terminal!)).toMatchObject({
      status: 'cancelled',
      cancelledAt: '2026-08-11T12:00:00.000Z',
    });
    await expect(
      queue.read(stagedPayload.jobId, {
        ...stagedPayloadScope(),
        actorId: 'another-teacher',
      }),
    ).resolves.toBeNull();
    expect(markAttempts).toBe(1);

    await expect(queue.read(stagedPayload.jobId, stagedPayloadScope())).resolves.toMatchObject({
      status: 'completed',
      resultAvailable: true,
    });
    expect(markAttempts).toBe(2);
    expect(runtime.cancel).toHaveBeenCalledTimes(2);
    await expect(queue.read(stagedPayload.jobId, stagedPayloadScope())).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('rejects an existing queue id owned by another scope', async () => {
    const add = vi.fn();
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = add;
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({
        data: { ...payload, actorId: 'teacher-2' },
      }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(queue.enqueue(payload)).rejects.toThrow('collides with another scope');
    expect(add).not.toHaveBeenCalled();
  });

  it('rejects a legacy queue id collision with different immutable provenance', async () => {
    const add = vi.fn();
    class FakeQueue {
      client = Promise.resolve(createFakeRedisClient());
      toKey = queueKey;
      constructor(
        _name: string,
        _options: { connection: Record<string, unknown>; prefix: string },
      ) {}
      add = add;
      close = vi.fn(async () => undefined);
      getJob = vi.fn(async () => ({
        data: { ...payload, runId: 'different-run' },
      }));
    }
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    });

    await expect(queue.enqueue(payload)).rejects.toThrow('collides with another legacy payload');
    expect(add).not.toHaveBeenCalled();
  });

  it('emits Decksmith attempt-started and succeeded terminal observations', async () => {
    const candidate = decksmithPayload();
    const processor = vi.fn(async () => ({ kind: 'decksmith' }));
    const run = await workerHarness(createAuditLifecycle(), processor, createFakeRedisClient(), {
      payload: candidate,
    });
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await expect(run({ attemptsMade: 1, opts: { attempts: 3 } })).resolves.toEqual({
        kind: 'decksmith',
      });
      expect(consoleInfo.mock.calls.map(([record]) => JSON.parse(String(record)))).toEqual([
        {
          component: 'reach-deck.decksmith',
          event: 'attempt-started',
          jobId: candidate.jobId,
          attempt: 2,
        },
        {
          component: 'reach-deck.decksmith',
          event: 'terminal',
          jobId: candidate.jobId,
          attempt: 2,
          terminalState: 'succeeded',
        },
      ]);
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it('rejects a stale durable descriptor before any Runtime or processor mutation', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const candidate = decksmithPayload();
    const execution = runtimeExecutionStub();
    const runtime = runtimeStub(execution);
    const processor = vi.fn(async () => ({ kind: 'decksmith' }));
    const validateDecksmithJob = vi.fn(async () => {
      throw new Error('Decksmith durable job scope is stale');
    });
    const releaseLease = vi.spyOn(store, 'releaseDecksmithDeckLease');
    const options = directProcessorOptions(processor, runtime);
    options.lifecycleQueue.assertNotCancelled.mockRejectedValue(
      new ReachDeckGenerationCancelledError(),
    );

    try {
      await expect(
        processReachDeckQueuedJob(
          {
            id: candidate.jobId,
            name: reachDeckJobNameForPayload(candidate),
            data: candidate,
            attemptsMade: 0,
            opts: { attempts: 3 },
            updateProgress: vi.fn(async () => undefined),
          },
          {
            ...options,
            validateDecksmithJob,
          },
        ),
      ).rejects.toThrow('Decksmith durable job scope is stale');

      expect(validateDecksmithJob).toHaveBeenCalledWith(candidate);
      expect(options.lifecycleQueue.assertNotCancelled).not.toHaveBeenCalled();
      expect(runtime.claim).not.toHaveBeenCalled();
      expect(runtime.fail).not.toHaveBeenCalled();
      expect(runtime.cancel).not.toHaveBeenCalled();
      expect(execution.fail).not.toHaveBeenCalled();
      expect(execution.cancel).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
      expect(releaseLease).not.toHaveBeenCalled();
      expect(options.audit.update).not.toHaveBeenCalled();
      expect(options.audit.abort).not.toHaveBeenCalled();
    } finally {
      globalThis.__reachanyAiRuntimeStore = undefined;
    }
  });

  it('rejects frozen context before Runtime or audit mutation when authoritative validation is missing', async () => {
    const legacy = parseReachDeckStagedGenerationJobPayload(stagedPayloadForKind('page-outline'));
    const scientificContextSnapshot = buildScientificGenerationContext({
      stage: 'outline',
      contexts: ['interactive'],
    });
    const candidate = {
      ...legacy,
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      scientificContextSnapshot,
      requestHash: buildScopedStagedGenerationRequestHash(legacy.resourceScope, {
        request: legacy.request,
        voiceSelection: legacy.voiceSelection,
        scientificContextSnapshot,
      }),
    };
    const runtime = runtimeStub();
    const processor = vi.fn();
    const options = directProcessorOptions(processor, runtime);
    await expect(
      processReachDeckQueuedJob(
        {
          id: candidate.jobId,
          name: reachDeckJobNameForPayload(candidate),
          data: candidate,
          attemptsMade: 0,
          opts: { attempts: 3 },
          updateProgress: vi.fn(),
        },
        options,
      ),
    ).rejects.toThrow(/authoritative frozen staged input validation is unavailable/);
    expect(runtime.claim).not.toHaveBeenCalled();
    expect(runtime.fail).not.toHaveBeenCalled();
    expect(options.audit.update).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
  });

  it('fails closed before Runtime mutation when pre-claim validation is not wired', async () => {
    const candidate = decksmithPayload();
    const execution = runtimeExecutionStub();
    const runtime = runtimeStub(execution);
    const processor = vi.fn(async () => ({ kind: 'decksmith' }));
    const { validateDecksmithJob: _omitted, ...options } = directProcessorOptions(
      processor,
      runtime,
    );

    await expect(
      processReachDeckQueuedJob(
        {
          id: candidate.jobId,
          name: reachDeckJobNameForPayload(candidate),
          data: candidate,
          attemptsMade: 0,
          opts: { attempts: 3 },
          updateProgress: vi.fn(async () => undefined),
        },
        options,
      ),
    ).rejects.toThrow('Decksmith durable job validation is unavailable');

    expect(runtime.claim).not.toHaveBeenCalled();
    expect(runtime.fail).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
  });

  it('records a pre-claim worker failure against queued attempt zero', async () => {
    const candidate = stagedPayloadForKind('page-generation');
    const audit = createAuditLifecycle();
    const runtime = runtimeStub();
    runtime.claim.mockRejectedValue(new Error('Runtime claim failed'));
    const processor = vi.fn(async () => ({ kind: 'page-generation' }));

    await expect(
      processReachDeckQueuedJob(
        {
          id: candidate.jobId,
          name: reachDeckJobNameForPayload(candidate),
          data: candidate,
          attemptsMade: 2,
          opts: { attempts: 3 },
          updateProgress: vi.fn(async () => undefined),
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: processor as never,
          runtime,
        },
      ),
    ).rejects.toThrow('Runtime claim failed');

    expect(audit.update).toHaveBeenCalledWith(
      candidate,
      expect.objectContaining({ status: 'failed', executionAttempt: 0 }),
    );
    expect(runtime.fail).toHaveBeenCalledWith(candidate, expect.any(Error));
    expect(processor).not.toHaveBeenCalled();
  });

  it('keeps waiting-tts progress instead of rewinding to early phases on a TTS re-entry', async () => {
    const narrationPayload = stagedPayloadForKind('narration-generation');
    const audit = {
      ...createAuditLifecycle(),
      read: vi.fn(async () => auditResource('running', 3)),
    };
    const updateProgress = vi.fn(async () => undefined);
    const result = { kind: 'narration-generation', runId: narrationPayload.runId };
    const processor = vi.fn(async (_payload, progress: (value: object) => Promise<void>) => {
      await progress({ phase: 'narration-generation', percent: 10 });
      await progress({ phase: 'media', percent: 80 });
      return result;
    });
    await expect(
      processReachDeckQueuedJob(
        {
          id: narrationPayload.jobId,
          name: reachDeckJobNameForPayload(narrationPayload),
          data: narrationPayload,
          attemptsMade: 0,
          opts: { attempts: 3 },
          token: 'resume-lock',
          progress: { phase: 'waiting-tts', percent: 65 },
          updateProgress,
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: processor as never,
          runtime: runtimeStub(runtimeExecutionStub()),
        },
      ),
    ).resolves.toBe(result);
    expect(updateProgress.mock.calls).toEqual([[{ phase: 'media', percent: 80 }]]);
  });

  it('settles an interrupted running audit as retrying before a stalled replay runs', async () => {
    const candidate = stagedPayloadForKind('narration-generation');
    const audit = {
      ...createAuditLifecycle(),
      read: vi.fn(async () => auditResource('running', 1)),
    };
    const conflict = new Error('Reach Deck generation audit state conflict');
    audit.update
      .mockRejectedValueOnce(conflict)
      .mockImplementation(async (_payload, input: { status: string }) =>
        auditResource(input.status as 'running', input.status === 'running' ? 2 : 1),
      );
    const result = { kind: 'narration-generation', runId: candidate.runId };

    await expect(
      processReachDeckQueuedJob(
        {
          id: candidate.jobId,
          name: reachDeckJobNameForPayload(candidate),
          data: candidate,
          attemptsMade: 0,
          opts: { attempts: 3 },
          updateProgress: vi.fn(async () => undefined),
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: vi.fn(async () => result) as never,
          runtime: runtimeStub(runtimeExecutionStub()),
        },
      ),
    ).resolves.toBe(result);

    expect(audit.update.mock.calls.map((call) => call[1])).toEqual([
      { status: 'running' },
      expect.objectContaining({ status: 'retrying', executionAttempt: 1 }),
      { status: 'running' },
      expect.objectContaining({ status: 'succeeded', executionAttempt: 2 }),
    ]);
  });

  it('lands the failed audit with the durable attempt when the running transition failed', async () => {
    const candidate = stagedPayloadForKind('narration-generation');
    const audit = {
      ...createAuditLifecycle(),
      read: vi.fn(async () => auditResource('running', 1)),
    };
    audit.update
      .mockRejectedValueOnce(new Error('audit conflict'))
      .mockRejectedValueOnce(new Error('retrying refused'))
      .mockRejectedValueOnce(new Error('retrying refused'))
      .mockRejectedValueOnce(new Error('retrying refused'))
      .mockImplementation(async (_payload, input: { status: string }) =>
        auditResource(input.status as 'failed', 1),
      );

    await expect(
      processReachDeckQueuedJob(
        {
          id: candidate.jobId,
          name: reachDeckJobNameForPayload(candidate),
          data: candidate,
          attemptsMade: 2,
          opts: { attempts: 3 },
          updateProgress: vi.fn(async () => undefined),
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: vi.fn() as never,
          runtime: runtimeStub(runtimeExecutionStub()),
        },
      ),
    ).rejects.toThrow('retrying refused');

    expect(audit.update).toHaveBeenLastCalledWith(
      candidate,
      expect.objectContaining({ status: 'failed', executionAttempt: 1 }),
    );
  });

  it('settles a replay that failed after the old attempt was moved to retrying', async () => {
    const candidate = stagedPayloadForKind('narration-generation');
    const audit = {
      ...createAuditLifecycle(),
      read: vi
        .fn()
        .mockResolvedValueOnce(auditResource('running', 1))
        .mockResolvedValueOnce(auditResource('retrying', 1)),
    };
    audit.update
      .mockRejectedValueOnce(new Error('audit conflict'))
      .mockResolvedValueOnce(auditResource('retrying', 1))
      .mockRejectedValueOnce(new Error('running unavailable'))
      .mockImplementation(async (_payload, input) => {
        if (input.status !== 'failed' || input.executionAttempt !== 1) {
          throw new Error('Expected the durable retrying attempt to be settled');
        }
        return auditResource('failed', 1);
      });
    const processor = vi.fn();

    await expect(
      processReachDeckQueuedJob(
        {
          id: candidate.jobId,
          name: reachDeckJobNameForPayload(candidate),
          data: candidate,
          attemptsMade: 0,
          opts: { attempts: 1 },
          updateProgress: vi.fn(),
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: processor as never,
          runtime: runtimeStub(runtimeExecutionStub()),
        },
      ),
    ).rejects.toThrow('running unavailable');

    expect(audit.update).toHaveBeenLastCalledWith(
      candidate,
      expect.objectContaining({ status: 'failed', executionAttempt: 1 }),
    );
    expect(processor).not.toHaveBeenCalled();
  });

  it.each(['queued', 'retrying'] as const)(
    'settles %s attempt zero when the claimed execution never reaches running',
    async (status) => {
      const candidate = stagedPayloadForKind('narration-generation');
      const audit = {
        ...createAuditLifecycle(),
        read: vi.fn(async () => auditResource(status, 0)),
      };
      audit.update
        .mockRejectedValueOnce(new Error('running unavailable'))
        .mockImplementation(async (_payload, input) => {
          if (input.status !== 'failed' || input.executionAttempt !== 0) {
            throw new Error('Expected the durable pre-execution ordinal');
          }
          return auditResource('failed', 0);
        });
      const processor = vi.fn();

      await expect(
        processReachDeckQueuedJob(
          {
            id: candidate.jobId,
            name: reachDeckJobNameForPayload(candidate),
            data: candidate,
            attemptsMade: 0,
            opts: { attempts: 1 },
            updateProgress: vi.fn(),
          },
          {
            audit,
            lifecycleQueue: generationQueueStub(),
            markWorkspacePageFailed: vi.fn(async () => undefined),
            processor: processor as never,
            runtime: runtimeStub(runtimeExecutionStub()),
          },
        ),
      ).rejects.toThrow('running unavailable');

      expect(audit.update).toHaveBeenLastCalledWith(
        candidate,
        expect.objectContaining({ status: 'failed', executionAttempt: 0 }),
      );
      expect(processor).not.toHaveBeenCalled();
    },
  );

  it('releases the Decksmith lease after a settled no-change completion', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const candidate = decksmithPayload();
    const execution = runtimeExecutionStub();
    const releaseLease = vi.spyOn(store, 'releaseDecksmithDeckLease').mockResolvedValue(true);
    vi.spyOn(store, 'hasUnresolvedApprovalForRun').mockResolvedValue(false);
    const processor = vi.fn(async () => ({ kind: 'decksmith', changed: false }));

    try {
      await expect(
        processReachDeckQueuedJob(
          {
            id: candidate.jobId,
            name: reachDeckJobNameForPayload(candidate),
            data: candidate,
            attemptsMade: 0,
            opts: { attempts: 3 },
            updateProgress: vi.fn(async () => undefined),
          },
          directProcessorOptions(processor, runtimeStub(execution)),
        ),
      ).resolves.toMatchObject({ changed: false });

      expect(execution.complete).toHaveBeenCalledOnce();
      expect(releaseLease).toHaveBeenCalledWith(execution.runId);
    } finally {
      globalThis.__reachanyAiRuntimeStore = undefined;
    }
  });

  it.each([
    {
      label: 'failed',
      error: new Error('provider failed'),
      attemptsMade: 2,
      terminalState: 'failed',
    },
    {
      label: 'cancelled',
      error: new ReachDeckGenerationCancelledError(),
      attemptsMade: 0,
      terminalState: 'cancelled',
    },
  ] as const)(
    'emits a Decksmith $label terminal observation',
    async ({ error, attemptsMade, terminalState }) => {
      const candidate = decksmithPayload();
      const processor = vi.fn(async () => {
        throw error;
      });
      const run = await workerHarness(createAuditLifecycle(), processor, createFakeRedisClient(), {
        payload: candidate,
      });
      const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      try {
        await expect(run({ attemptsMade, opts: { attempts: 3 } })).rejects.toThrow(error.message);
        expect(consoleInfo.mock.calls.map(([record]) => JSON.parse(String(record)))).toEqual([
          {
            component: 'reach-deck.decksmith',
            event: 'attempt-started',
            jobId: candidate.jobId,
            attempt: attemptsMade + 1,
          },
          {
            component: 'reach-deck.decksmith',
            event: 'terminal',
            jobId: candidate.jobId,
            attempt: attemptsMade + 1,
            terminalState,
          },
        ]);
      } finally {
        consoleInfo.mockRestore();
      }
    },
  );

  it('retains the Decksmith lease when a proposal is committed before terminal enrichment failure', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const candidate = decksmithPayload();
    const { run: artifactRun } = await store.createRun({
      actor: {
        subject: '01900000-0000-7000-8000-000000000401',
        orgId: candidate.resourceScope.organizationId,
        roles: ['teacher'],
      },
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      requestKey: 'queue-proposal-enrichment-failure',
      input: { kind: 'message', message: 'Create a Decksmith proposal' },
      domainScope: { ...candidate.resourceScope },
      tokenBudget: 32_000,
    });
    const execution = { ...runtimeExecutionStub(), runId: artifactRun.id };
    const releaseLease = vi.spyOn(store, 'releaseDecksmithDeckLease');
    const enrichmentFailure = new Error('proposal event enrichment failed');
    const processor = vi.fn(async () => {
      await store.proposeArtifact(artifactRun, {
        artifactType: 'deck-change-set',
        domainRef: artifactRun.domainScope,
        contentSha256: 'a'.repeat(64),
        changeSet: { source: 'reach-deck.decksmith' },
      });
      throw enrichmentFailure;
    });

    try {
      await expect(
        processReachDeckQueuedJob(
          {
            id: candidate.jobId,
            name: reachDeckJobNameForPayload(candidate),
            data: candidate,
            attemptsMade: 2,
            opts: { attempts: 3 },
            updateProgress: vi.fn(async () => undefined),
          },
          directProcessorOptions(processor, runtimeStub(execution)),
        ),
      ).rejects.toThrow(enrichmentFailure.message);

      await expect(store.hasUnresolvedApprovalForRun(artifactRun.id)).resolves.toBe(true);
      expect(releaseLease).not.toHaveBeenCalled();
    } finally {
      globalThis.__reachanyAiRuntimeStore = undefined;
    }
  });

  it('retains the Decksmith lease when terminal cancellation cannot resolve approval state', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const candidate = decksmithPayload();
    const approvalLookup = vi
      .spyOn(store, 'hasUnresolvedApprovalForRun')
      .mockRejectedValue(new Error('approval store unavailable'));
    const releaseLease = vi.spyOn(store, 'releaseDecksmithDeckLease');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const processor = vi.fn(async () => {
      throw new ReachDeckGenerationCancelledError();
    });

    try {
      await expect(
        processReachDeckQueuedJob(
          {
            id: candidate.jobId,
            name: reachDeckJobNameForPayload(candidate),
            data: candidate,
            attemptsMade: 0,
            opts: { attempts: 3 },
            updateProgress: vi.fn(async () => undefined),
          },
          directProcessorOptions(processor, runtimeStub()),
        ),
      ).rejects.toThrow('Generation cancelled');

      expect(approvalLookup).toHaveBeenCalledWith('runtime-run-1');
      expect(releaseLease).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        'Decksmith approval lookup failed; retaining lease',
        expect.objectContaining({ runId: 'runtime-run-1' }),
      );
    } finally {
      consoleError.mockRestore();
      globalThis.__reachanyAiRuntimeStore = undefined;
    }
  });

  it('releases the Decksmith lease after terminal failure when approval state is settled', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const candidate = decksmithPayload();
    vi.spyOn(store, 'hasUnresolvedApprovalForRun').mockResolvedValue(false);
    const releaseLease = vi.spyOn(store, 'releaseDecksmithDeckLease').mockResolvedValue(true);
    const processor = vi.fn(async () => {
      throw new Error('terminal failure without proposal');
    });

    try {
      await expect(
        processReachDeckQueuedJob(
          {
            id: candidate.jobId,
            name: reachDeckJobNameForPayload(candidate),
            data: candidate,
            attemptsMade: 2,
            opts: { attempts: 3 },
            updateProgress: vi.fn(async () => undefined),
          },
          directProcessorOptions(processor, runtimeStub()),
        ),
      ).rejects.toThrow('terminal failure without proposal');

      expect(releaseLease).toHaveBeenCalledOnce();
      expect(releaseLease).toHaveBeenCalledWith('runtime-run-1');
    } finally {
      globalThis.__reachanyAiRuntimeStore = undefined;
    }
  });

  it('does not emit a Decksmith terminal observation for a retrying attempt', async () => {
    const candidate = decksmithPayload();
    const processor = vi.fn(async () => {
      throw new Error('retryable provider failure');
    });
    const run = await workerHarness(createAuditLifecycle(), processor, createFakeRedisClient(), {
      payload: candidate,
    });
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await expect(run({ attemptsMade: 0, opts: { attempts: 3 } })).rejects.toThrow(
        'retryable provider failure',
      );
      expect(consoleInfo.mock.calls.map(([record]) => JSON.parse(String(record)))).toEqual([
        {
          component: 'reach-deck.decksmith',
          event: 'attempt-started',
          jobId: candidate.jobId,
          attempt: 1,
        },
      ]);
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it('creates a queued audit before insertion and records enqueue failure', async () => {
    const order: string[] = [];
    const audit = createAuditLifecycle();
    audit.create.mockImplementation(async () => {
      order.push('audit');
      return auditResource('queued', 0);
    });
    const queue = generationQueueStub();
    queue.enqueue.mockImplementation(async () => {
      order.push('queue');
      throw new Error('redis unavailable');
    });

    await expect(enqueueReachDeckGenerationJob(payload, audit, async () => queue)).rejects.toThrow(
      'redis unavailable',
    );

    expect(order).toEqual(['audit', 'queue']);
    expect(audit.update).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ status: 'failed', executionAttempt: 0 }),
    );
    expect(queue.close).toHaveBeenCalledOnce();
  });

  it('does not close a caller-owned queue after enqueue', async () => {
    const audit = createAuditLifecycle();
    const queue = generationQueueStub();

    await enqueueReachDeckGenerationJobWithQueue(payload, queue, audit);

    expect(queue.enqueue).toHaveBeenCalledWith(payload);
    expect(queue.close).not.toHaveBeenCalled();
  });

  it('leaves a v2 Decksmith audit recoverable after an ambiguous enqueue failure', async () => {
    const legacy = decksmithPayload() as ReachDeckDecksmithLegacyJobPayload;
    const { input: _input, ...identity } = legacy;
    const candidate: ReachDeckDecksmithV2JobPayload = {
      ...identity,
      schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
      runtimeRunId: '11111111-1111-4111-8111-111111111111',
      threadId: '22222222-2222-4222-8222-222222222222',
      contextDigest: 'c'.repeat(64),
    };
    expect(candidate).not.toHaveProperty('input');
    expect(Object.keys(candidate).sort()).toEqual(
      expect.arrayContaining(['runtimeRunId', 'threadId', 'contextDigest']),
    );
    const audit = createAuditLifecycle();
    const queue = generationQueueStub();
    queue.enqueue.mockRejectedValue(new Error('ambiguous Redis failure'));

    await expect(
      enqueueReachDeckGenerationJob(candidate, audit, async () => queue),
    ).rejects.toThrow('ambiguous Redis failure');

    expect(audit.update).not.toHaveBeenCalled();
    expect(audit.abort).not.toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalledOnce();
  });

  it('does not insert a missing BullMQ job when the same audit already succeeded', async () => {
    const audit = createAuditLifecycle({ status: 'succeeded' });
    audit.create.mockResolvedValue(auditResource('succeeded', 1));
    const createQueue = vi.fn(async () => generationQueueStub());

    await expect(enqueueReachDeckGenerationJob(payload, audit, createQueue)).rejects.toThrow(
      'already succeeded@1',
    );

    expect(createQueue).not.toHaveBeenCalled();
    expect(audit.update).not.toHaveBeenCalled();
  });

  it('does not replay a structurally aborted job after its workspace tombstone is collected', async () => {
    const audit = createAuditLifecycle({ status: 'aborted' });
    audit.create.mockResolvedValue(auditResource('aborted', 1));
    const createQueue = vi.fn(async () => generationQueueStub());

    await expect(enqueueReachDeckGenerationJob(payload, audit, createQueue)).rejects.toThrow(
      'already aborted@1',
    );

    expect(createQueue).not.toHaveBeenCalled();
    expect(audit.update).not.toHaveBeenCalled();
  });

  it('resumes only a same-provenance enqueue failure at execution attempt zero', async () => {
    const audit = createAuditLifecycle({ status: 'failed' });
    audit.create.mockResolvedValue(auditResource('failed', 0));
    audit.update.mockResolvedValue(auditResource('retrying', 0));
    const queue = generationQueueStub();

    await enqueueReachDeckGenerationJob(payload, audit, async () => queue);

    expect(audit.update).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ status: 'retrying' }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith(payload);
  });

  it('blocks provider work until retry reconciliation and a running audit response succeed', async () => {
    const processor = vi.fn(async () => ({ ...payload, document: undefined }));
    const audit = createAuditLifecycle();
    let auditCalls = 0;
    audit.update.mockImplementation(async (_payload, input) => {
      auditCalls += 1;
      if (auditCalls <= 4) throw new Error('audit outage');
      return auditResource(
        input.status as Parameters<typeof auditResource>[0],
        input.status === 'running' ? 1 : 0,
      );
    });
    const run = await workerHarness(audit, processor);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(run({ attemptsMade: 0, opts: { attempts: 3 } })).rejects.toThrow('audit outage');
      expect(processor).not.toHaveBeenCalled();

      await expect(run({ attemptsMade: 1, opts: { attempts: 3 } })).resolves.toBeDefined();
      expect(processor).toHaveBeenCalledOnce();
      const statuses = audit.update.mock.calls.map((call) => call[1].status);
      expect(statuses.slice(-3)).toEqual(['retrying', 'running', 'succeeded']);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('marks automatic retry and final failure with the server-returned execution attempt', async () => {
    const retryAudit = createAuditLifecycle();
    const retryProcessor = vi.fn(async () => {
      throw new Error('provider timeout');
    });
    const retryRun = await workerHarness(retryAudit, retryProcessor);
    await expect(retryRun({ attemptsMade: 0, opts: { attempts: 3 } })).rejects.toThrow(
      'provider timeout',
    );
    expect(retryAudit.update).toHaveBeenLastCalledWith(
      payload,
      expect.objectContaining({ status: 'retrying', executionAttempt: 1 }),
    );

    const finalAudit = createAuditLifecycle();
    const finalRun = await workerHarness(finalAudit, retryProcessor);
    await expect(finalRun({ attemptsMade: 2, opts: { attempts: 3 } })).rejects.toThrow(
      'provider timeout',
    );
    expect(finalAudit.update).toHaveBeenLastCalledWith(
      payload,
      expect.objectContaining({ status: 'failed', executionAttempt: 1 }),
    );
  });

  it('delegates terminal staged page failure synchronization to the worker boundary', async () => {
    const pagePayload = stagedPayloadForKind('page-generation');
    const failure = new Error('terminal page failure');
    const markWorkspacePageFailed = vi.fn(async () => undefined);
    const run = await workerHarness(
      createAuditLifecycle(),
      vi.fn(async () => {
        throw failure;
      }),
      createFakeRedisClient(),
      { payload: pagePayload, markWorkspacePageFailed },
    );

    await expect(run({ attemptsMade: 2, opts: { attempts: 3 } })).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: failure.message,
    });
    expect(markWorkspacePageFailed).toHaveBeenCalledOnce();
    expect(markWorkspacePageFailed).toHaveBeenCalledWith(pagePayload, failure);
  });

  it.each(['slide', 'quiz-terminal-attempt', 'quiz-unrecoverable'] as const)(
    'honors cancellation that arrived during a failed provider request: %s',
    async (scenario) => {
      const page = { ...validPage, sceneType: 'quiz' as const };
      const pagePayload =
        scenario === 'slide'
          ? stagedPayloadForKind('page-generation')
          : stagedPayloadWithRequest('page-generation', {
              ...validPageGenerationRequest,
              page,
              pagedOutline: { ...validPageGenerationRequest.pagedOutline, pages: [page] },
            });
      const execution = runtimeExecutionStub();
      const processor = vi.fn();
      const options = directProcessorOptions(processor, runtimeStub(execution));
      const providerFailure =
        scenario === 'quiz-unrecoverable'
          ? new UnrecoverableError('scientific capture failed')
          : new Error('scientific capture failed');
      processor.mockImplementation(async () => {
        options.lifecycleQueue.assertNotCancelled.mockRejectedValue(
          new ReachDeckGenerationCancelledError(),
        );
        throw providerFailure;
      });

      await expect(
        processReachDeckQueuedJob(
          {
            ...queuedJob({
              attemptsMade: scenario === 'quiz-terminal-attempt' ? 2 : 0,
              opts: { attempts: 3 },
            }),
            id: pagePayload.jobId,
            name: reachDeckJobNameForPayload(pagePayload),
            data: pagePayload,
          },
          options,
        ),
      ).rejects.toMatchObject({ name: 'UnrecoverableError', message: 'Generation cancelled' });

      expect(execution.cancel).toHaveBeenCalledOnce();
      expect(execution.fail).not.toHaveBeenCalled();
      expect(execution.retry).not.toHaveBeenCalled();
      expect(options.audit.abort).toHaveBeenCalledOnce();
      expect(options.audit.update.mock.calls.some(([, update]) => update.status === 'failed')).toBe(
        false,
      );
      // Cancellation beats continuation: no failed-page sync, so no next page is dispatched.
      expect(options.markWorkspacePageFailed).not.toHaveBeenCalled();
    },
  );

  it('polls Redis cancellation every second but reads durable batch state at most every 15 seconds', async () => {
    // 2026-10-17 test：每页每秒都从 content-service 读一次 recovery，8 个 deck worker 事件循环被打满。
    const pagePayload = stagedPayloadForKind('page-generation');
    const processor = vi.fn();
    const assertDurableNotCancelled = vi.fn(async () => undefined);
    let clock = 1_000_000;
    const options = {
      ...directProcessorOptions(processor, runtimeStub(runtimeExecutionStub())),
      assertDurableNotCancelled,
      now: () => clock,
    };
    const observed: Array<{ lifecycle: number; durable: number }> = [];
    processor.mockImplementation(
      async (
        _payload: unknown,
        _update: unknown,
        _assert: unknown,
        execution: { pollCancellation?: () => Promise<void> },
      ) => {
        const lifecycle = options.lifecycleQueue.assertNotCancelled.mock.calls.length;
        const durable = assertDurableNotCancelled.mock.calls.length;
        for (const advance of [0, 14_999, 1, 1000]) {
          clock += advance;
          await execution.pollCancellation!();
          observed.push({
            lifecycle: options.lifecycleQueue.assertNotCancelled.mock.calls.length - lifecycle,
            durable: assertDurableNotCancelled.mock.calls.length - durable,
          });
        }
        throw new UnrecoverableError('stop after polling');
      },
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        processReachDeckQueuedJob(
          {
            ...queuedJob({ attemptsMade: 0, opts: { attempts: 3 } }),
            id: pagePayload.jobId,
            name: reachDeckJobNameForPayload(pagePayload),
            data: pagePayload,
          },
          options,
        ),
      ).rejects.toThrow();
    } finally {
      consoleError.mockRestore();
    }
    expect(observed).toEqual([
      { lifecycle: 1, durable: 0 },
      { lifecycle: 2, durable: 0 },
      { lifecycle: 3, durable: 1 },
      { lifecycle: 4, durable: 1 },
    ]);
  });

  it('does not continue pages when cancellation cannot be checked after a provider failure', async () => {
    const pagePayload = stagedPayloadForKind('page-generation');
    const execution = runtimeExecutionStub();
    const processor = vi.fn();
    const options = directProcessorOptions(processor, runtimeStub(execution));
    const providerFailure = new Error('scientific capture failed');
    processor.mockImplementation(async () => {
      options.lifecycleQueue.assertNotCancelled.mockRejectedValue(new Error('redis unavailable'));
      throw providerFailure;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // The single-pass slide fallback still converts the original failure to terminal.
      await expect(
        processReachDeckQueuedJob(
          {
            ...queuedJob({ attemptsMade: 0, opts: { attempts: 3 } }),
            id: pagePayload.jobId,
            name: reachDeckJobNameForPayload(pagePayload),
            data: pagePayload,
          },
          options,
        ),
      ).rejects.toMatchObject({ name: 'UnrecoverableError', message: providerFailure.message });
    } finally {
      consoleError.mockRestore();
    }
    expect(execution.fail).toHaveBeenCalledWith(providerFailure);
    expect(execution.cancel).not.toHaveBeenCalled();
    expect(options.audit.abort).not.toHaveBeenCalled();
    expect(options.markWorkspacePageFailed).not.toHaveBeenCalled();
  });

  it('keeps the original stack when a single-pass slide failure becomes terminal', async () => {
    const pagePayload = stagedPayloadForKind('page-generation');
    const execution = runtimeExecutionStub();
    const processor = vi.fn();
    const options = directProcessorOptions(processor, runtimeStub(execution));
    const providerFailure = new Error('recursive use of an object detected');
    providerFailure.stack = `${providerFailure.message}\n    at wasm-module (resvg_bg.wasm:1:1)`;
    processor.mockRejectedValue(providerFailure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failure: unknown;
    try {
      await processReachDeckQueuedJob(
        {
          ...queuedJob({ attemptsMade: 0, opts: { attempts: 1 } }),
          id: pagePayload.jobId,
          name: reachDeckJobNameForPayload(pagePayload),
          data: pagePayload,
        },
        options,
      ).catch((error: unknown) => {
        failure = error;
      });
    } finally {
      consoleError.mockRestore();
    }
    // BullMQ 只持久化抛出错误的 stack，原始 wasm 帧必须跟着包装错误走。
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect(failure).toMatchObject({ message: providerFailure.message });
    expect((failure as Error).stack).toContain(`Caused by: ${providerFailure.stack}`);
  });

  it('enqueues only ordinary slides with one attempt', async () => {
    for (const kind of [
      'lesson-plan',
      'page-outline',
      'page-generation',
      'narration-generation',
    ] as const) {
      const { queue, add } = createValidationQueue();
      const jobPayload = stagedPayloadForKind(kind);
      await queue.enqueue(jobPayload);
      expect(add).toHaveBeenCalledWith(
        expect.any(String),
        jobPayload,
        expect.objectContaining({ attempts: kind === 'page-generation' ? 1 : 3 }),
      );
    }
    const page = { ...validPage, sceneType: 'quiz' as const };
    const quizPayload = stagedPayloadWithRequest('page-generation', {
      ...validPageGenerationRequest,
      page,
      pagedOutline: { ...validPageGenerationRequest.pagedOutline, pages: [page] },
    });
    const { queue, add } = createValidationQueue();
    await queue.enqueue(quizPayload);
    expect(add).toHaveBeenCalledWith(
      expect.any(String),
      quizPayload,
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it.each(['transport timeout', 'HTML structural failure'])(
    'never retries previously queued slides after %s',
    async (message) => {
      const pagePayload = stagedPayloadForKind('page-generation');
      const failure = new Error(message);
      const audit = createAuditLifecycle();
      const markWorkspacePageFailed = vi.fn(async () => undefined);
      const processor = vi.fn(async () => {
        throw failure;
      });
      const run = await workerHarness(audit, processor, createFakeRedisClient(), {
        payload: pagePayload,
        markWorkspacePageFailed,
      });
      await expect(run({ attemptsMade: 0, opts: { attempts: 3 } })).rejects.toMatchObject({
        name: 'UnrecoverableError',
        message,
      });
      expect(processor).toHaveBeenCalledOnce();
      expect(audit.update).toHaveBeenLastCalledWith(
        pagePayload,
        expect.objectContaining({ status: 'failed', executionAttempt: 1 }),
      );
      expect(markWorkspacePageFailed).toHaveBeenCalledWith(pagePayload, failure);
    },
  );

  it('keeps a slide terminal when failure reconciliation also fails', async () => {
    const pagePayload = stagedPayloadForKind('page-generation');
    const audit = createAuditLifecycle();
    const failure = new Error('provider timeout');
    const markWorkspacePageFailed = vi.fn(async () => {
      throw new Error('workspace outage');
    });
    const run = await workerHarness(
      audit,
      vi.fn(async () => {
        throw failure;
      }),
      createFakeRedisClient(),
      { payload: pagePayload, markWorkspacePageFailed },
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(run({ attemptsMade: 0, opts: { attempts: 3 } })).rejects.toMatchObject({
        name: 'UnrecoverableError',
        message: failure.message,
      });
      expect(markWorkspacePageFailed).toHaveBeenCalledOnce();
      expect(audit.update).toHaveBeenLastCalledWith(
        pagePayload,
        expect.objectContaining({ status: 'failed' }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it.each(['claim', 'fail', 'complete'] as const)(
    'keeps a slide terminal when Runtime %s fails',
    async (phase) => {
      const pagePayload = stagedPayloadForKind('page-generation');
      const execution = runtimeExecutionStub();
      const runtime = runtimeStub(execution);
      const outage = new Error(`Runtime ${phase} outage`);
      if (phase === 'claim') runtime.claim.mockRejectedValue(outage);
      else execution[phase].mockRejectedValue(outage);
      const processor = vi.fn(async () => {
        if (phase === 'fail') throw new Error('original provider failure');
        return { status: 'ready' };
      });
      const options = directProcessorOptions(processor, runtime);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(
          processReachDeckQueuedJob(
            {
              name: reachDeckJobNameForPayload(pagePayload),
              data: pagePayload,
              attemptsMade: 0,
              opts: { attempts: 3 },
              updateProgress: async () => undefined,
            },
            options,
          ),
        ).rejects.toMatchObject({
          name: 'UnrecoverableError',
          message: phase === 'fail' ? 'original provider failure' : outage.message,
        });
        expect(options.markWorkspacePageFailed).toHaveBeenCalledOnce();
        expect(options.audit.update).toHaveBeenLastCalledWith(
          pagePayload,
          expect.objectContaining({ status: 'failed' }),
        );
        expect(execution.retry).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it('makes cancellation unrecoverable after recording aborted', async () => {
    const audit = createAuditLifecycle();
    const processor = vi.fn(async () => {
      throw new ReachDeckGenerationCancelledError();
    });
    const run = await workerHarness(audit, processor);

    const error = await run({ attemptsMade: 0, opts: { attempts: 3 } }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ name: 'UnrecoverableError', message: 'Generation cancelled' });
    expect(audit.abort).toHaveBeenLastCalledWith(
      payload,
      expect.objectContaining({ errorSummary: expect.any(String) }),
    );
  });

  it('propagates Runtime completion failure so durable success can be reconciled on retry', async () => {
    const completionFailure = new Error('Runtime completion unavailable');
    const execution = runtimeExecutionStub();
    execution.complete.mockRejectedValue(completionFailure);
    const processor = vi.fn(async () => ({ ...payload, document: undefined }));

    await expect(
      processReachDeckQueuedJob(
        queuedJob({ attemptsMade: 0, opts: { attempts: 3 } }),
        directProcessorOptions(processor, runtimeStub(execution)),
      ),
    ).rejects.toBe(completionFailure);

    expect(processor).toHaveBeenCalledOnce();
    expect(execution.retry).toHaveBeenCalledWith(completionFailure, 1, 3);
  });

  it('propagates final Runtime failure transition errors instead of losing reconciliation', async () => {
    const providerFailure = new Error('provider failed');
    const transitionFailure = new Error('Runtime fail transition unavailable');
    const execution = runtimeExecutionStub();
    execution.fail.mockRejectedValue(transitionFailure);
    const processor = vi.fn(async () => {
      throw providerFailure;
    });

    await expect(
      processReachDeckQueuedJob(
        queuedJob({ attemptsMade: 2, opts: { attempts: 3 } }),
        directProcessorOptions(processor, runtimeStub(execution)),
      ),
    ).rejects.toBe(transitionFailure);

    expect(execution.fail).toHaveBeenCalledWith(providerFailure);
  });

  it('propagates Runtime cancellation transition errors for a later reconciliation attempt', async () => {
    const transitionFailure = new Error('Runtime cancel transition unavailable');
    const execution = runtimeExecutionStub();
    execution.cancel.mockRejectedValue(transitionFailure);
    const processor = vi.fn(async () => {
      throw new ReachDeckGenerationCancelledError();
    });

    await expect(
      processReachDeckQueuedJob(
        queuedJob({ attemptsMade: 0, opts: { attempts: 3 } }),
        directProcessorOptions(processor, runtimeStub(execution)),
      ),
    ).rejects.toBe(transitionFailure);

    expect(execution.cancel).toHaveBeenCalledOnce();
  });

  it('checks cancellation again after processor return before writing succeeded', async () => {
    const audit = createAuditLifecycle();
    const processor = vi.fn(async () => ({ ...payload, document: undefined }));
    const cancellation = JSON.stringify({
      ...payloadScope(),
      cancelledAt: '2026-07-18T00:00:00.000Z',
      done: true,
      error: 'Generation cancelled',
      jobId: payload.jobId,
      progress: 90,
      status: 'cancelled',
    });
    let reads = 0;
    const redis = createFakeRedisClient();
    redis.get.mockImplementation(async () => {
      reads += 1;
      return reads >= 3 ? cancellation : null;
    });
    const run = await workerHarness(audit, processor, redis);

    const error = await run({ attemptsMade: 0, opts: { attempts: 3 } }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ name: 'UnrecoverableError', message: 'Generation cancelled' });
    expect(processor).toHaveBeenCalledOnce();
    expect(audit.update.mock.calls.map((call) => call[1].status)).toEqual(['running']);
    expect(audit.abort).toHaveBeenCalledOnce();
  });

  it('reconciles succeeded to aborted when cancellation wins before BullMQ completion', async () => {
    const audit = createAuditLifecycle();
    const processor = vi.fn(async () => ({ ...payload, document: undefined }));
    const cancellation = JSON.stringify({
      ...payloadScope(),
      cancelledAt: '2026-07-18T00:00:00.000Z',
      done: true,
      error: 'Generation cancelled',
      jobId: payload.jobId,
      progress: 100,
      status: 'cancelled',
    });
    let reads = 0;
    const redis = createFakeRedisClient();
    redis.get.mockImplementation(async () => {
      reads += 1;
      return reads >= 4 ? cancellation : null;
    });
    const run = await workerHarness(audit, processor, redis);

    const error = await run({ attemptsMade: 0, opts: { attempts: 3 } }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ name: 'UnrecoverableError', message: 'Generation cancelled' });
    expect(audit.update.mock.calls.map((call) => call[1].status)).toEqual(['running', 'succeeded']);
    expect(audit.abort).toHaveBeenCalledOnce();
  });

  it('does not replay when success audit and post-processor cancellation reads both fail', async () => {
    const audit = createAuditLifecycle();
    audit.update.mockImplementation(async (_payload, input) => {
      if (input.status === 'succeeded') throw new Error('terminal audit outage');
      return auditResource(input.status as Parameters<typeof auditResource>[0], 1);
    });
    const processor = vi.fn(async () => ({ ...payload, document: undefined }));
    let reads = 0;
    const redis = createFakeRedisClient();
    redis.get.mockImplementation(async () => {
      reads += 1;
      if (reads >= 3) throw new Error('redis cancellation read outage');
      return null;
    });
    const run = await workerHarness(audit, processor, redis);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(run({ attemptsMade: 0, opts: { attempts: 3 } })).resolves.toBeDefined();
      expect(processor).toHaveBeenCalledOnce();
      expect(audit.update.mock.calls.filter((call) => call[1].status === 'succeeded')).toHaveLength(
        3,
      );
      expect(audit.abort).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('cancellation check failed'),
        expect.objectContaining({ message: 'redis cancellation read outage' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('moves a queued TTS poll active→delayed at priority 1 with the real token and no retry attempt', async () => {
    const narrationPayload = stagedPayloadForKind('narration-generation');
    const audit = createAuditLifecycle();
    const execution = runtimeExecutionStub();
    const runtime = runtimeStub(execution);
    const moveToDelayed = vi.fn(async () => undefined);
    const changePriority = vi.fn(async () => undefined);
    const updateProgress = vi.fn(async () => undefined);
    const queue = {
      protocol: 'tts-queue/v1' as const,
      status: 'queued' as const,
      ticket: 'ticket-1',
      queuedAtEpochMillis: 1_000,
      expiresAtEpochMillis: 43_201_000,
      pollAfterMillis: 2_500,
      upstreamAttempts: 0,
    };
    const processor = vi.fn(async () => {
      throw new ReachDeckTtsQueuedError(queue);
    });

    const error = await processReachDeckQueuedJob(
      {
        id: narrationPayload.jobId,
        name: reachDeckJobNameForPayload(narrationPayload),
        data: narrationPayload,
        attemptsMade: 0,
        opts: { attempts: 3 },
        token: 'real-lock-token',
        changePriority,
        moveToDelayed,
        updateProgress,
      },
      {
        audit,
        lifecycleQueue: generationQueueStub(),
        markWorkspacePageFailed: vi.fn(async () => undefined),
        processor: processor as never,
        runtime,
        now: () => 10_000,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DelayedError);
    expect(changePriority).toHaveBeenCalledWith({ priority: 1 });
    expect(moveToDelayed).toHaveBeenCalledWith(12_500, 'real-lock-token');
    expect(updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'waiting-tts', expiresAtEpochMillis: 43_201_000 }),
    );
    expect(narrationPayload).not.toHaveProperty('token');
    expect(audit.update.mock.calls.map((call) => call[1].status)).toEqual(['running']);
    expect(runtime.claim).toHaveBeenCalledOnce();
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(execution.retry).not.toHaveBeenCalled();
    expect(execution.fail).not.toHaveBeenCalled();
  });

  it('resumes repeated waiting-tts polls without incrementing execution attempts', async () => {
    const narrationPayload = stagedPayloadForKind('narration-generation');
    const audit = {
      ...createAuditLifecycle(),
      read: vi.fn(async () => auditResource('running', 3)),
    };
    const execution = runtimeExecutionStub();
    const runtime = runtimeStub(execution);
    const result = { kind: 'narration-generation', runId: narrationPayload.runId };
    const processor = vi
      .fn(async () => result)
      .mockRejectedValueOnce(
        new ReachDeckTtsQueuedError({
          protocol: 'tts-queue/v1',
          status: 'queued',
          ticket: 'ticket-resume',
          queuedAtEpochMillis: 1_000,
          expiresAtEpochMillis: 43_201_000,
          pollAfterMillis: 1_000,
          upstreamAttempts: 0,
        }),
      );

    await expect(
      processReachDeckQueuedJob(
        {
          id: narrationPayload.jobId,
          name: reachDeckJobNameForPayload(narrationPayload),
          data: narrationPayload,
          attemptsMade: 0,
          opts: { attempts: 3 },
          token: 'resume-lock',
          progress: { phase: 'waiting-tts', percent: 65 },
          updateProgress: vi.fn(async () => undefined),
          changePriority: vi.fn(async () => undefined),
          moveToDelayed: vi.fn(async () => undefined),
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(),
          processor: processor as never,
          runtime,
        },
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(audit.update).not.toHaveBeenCalled();

    await expect(
      processReachDeckQueuedJob(
        {
          id: narrationPayload.jobId,
          name: reachDeckJobNameForPayload(narrationPayload),
          data: narrationPayload,
          attemptsMade: 0,
          opts: { attempts: 3 },
          progress: { phase: 'waiting-tts', percent: 65 },
          updateProgress: vi.fn(async () => undefined),
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: processor as never,
          runtime,
        },
      ),
    ).resolves.toBe(result);

    expect(runtime.claim).not.toHaveBeenCalled();
    expect(runtime.resume).toHaveBeenCalledWith(narrationPayload);
    expect(audit.update.mock.calls.map((call) => call[1].status)).toEqual(['succeeded']);
    expect(audit.read).toHaveBeenCalledWith(narrationPayload);
    expect(audit.read).toHaveBeenCalledTimes(2);
    expect(audit.update).toHaveBeenCalledWith(
      narrationPayload,
      expect.objectContaining({ status: 'succeeded', executionAttempt: 3 }),
    );
    expect(execution.retry).not.toHaveBeenCalled();
  });

  it('defers waiting-tts resumes beyond the per-process gate without any workspace reads', async () => {
    const narrationPayload = stagedPayloadForKind('narration-generation');
    const audit = {
      ...createAuditLifecycle(),
      read: vi.fn(async () => auditResource('running', 3)),
    };
    const runtime = runtimeStub(runtimeExecutionStub());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const result = { kind: 'narration-generation', runId: narrationPayload.runId };
    const processor = vi.fn(async () => {
      await held;
      return result;
    });
    const resumeJob = (token: string, moveToDelayed = vi.fn(async () => undefined)) => ({
      id: narrationPayload.jobId,
      name: reachDeckJobNameForPayload(narrationPayload),
      data: narrationPayload,
      attemptsMade: 0,
      opts: { attempts: 3 },
      token,
      progress: { phase: 'waiting-tts', percent: 65 },
      updateProgress: vi.fn(async () => undefined),
      changePriority: vi.fn(async () => undefined),
      moveToDelayed,
    });
    const options = {
      audit,
      lifecycleQueue: generationQueueStub(),
      markWorkspacePageFailed: vi.fn(async () => undefined),
      processor: processor as never,
      runtime,
      now: () => 10_000,
    };

    const admitted = Array.from({ length: 16 }, (_, index) =>
      processReachDeckQueuedJob(resumeJob(`lock-${index}`), options),
    );
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(16));
    const readsBeforeDefer = audit.read.mock.calls.length;
    const moveToDelayed = vi.fn(async () => undefined);

    await expect(
      processReachDeckQueuedJob(resumeJob('lock-deferred', moveToDelayed), options),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock-deferred');
    const [[deferredUntil]] = moveToDelayed.mock.calls as unknown as Array<[number]>;
    expect(deferredUntil).toBeGreaterThanOrEqual(12_000);
    expect(deferredUntil).toBeLessThan(15_000);
    expect(audit.read).toHaveBeenCalledTimes(readsBeforeDefer);
    expect(runtime.resume).toHaveBeenCalledTimes(16);

    release();
    await expect(Promise.all(admitted)).resolves.toHaveLength(16);
    await vi.waitFor(async () =>
      expect(await processReachDeckQueuedJob(resumeJob('lock-after'), options)).toBe(result),
    );
  });

  it('peeks the queued ticket before a waiting-tts re-entry and skips the full resume while queued', async () => {
    const narrationPayload = stagedPayloadForKind('narration-generation');
    const audit = {
      ...createAuditLifecycle(),
      read: vi.fn(async () => auditResource('running', 3)),
    };
    const runtime = runtimeStub(runtimeExecutionStub());
    const result = { kind: 'narration-generation', runId: narrationPayload.runId };
    const processor = vi.fn(async () => result);
    const peekTtsAdmission = vi
      .fn()
      .mockResolvedValueOnce({ status: 'queued', pollAfterMillis: 4_000 })
      .mockResolvedValueOnce({ status: 'proceed', pollAfterMillis: 0 })
      .mockRejectedValueOnce(new Error('model-service unavailable'));
    const resumeJob = (moveToDelayed = vi.fn(async () => undefined)) => ({
      id: narrationPayload.jobId,
      name: reachDeckJobNameForPayload(narrationPayload),
      data: narrationPayload,
      attemptsMade: 0,
      opts: { attempts: 3 },
      token: 'peek-lock',
      progress: { phase: 'waiting-tts', percent: 65, requestIdentity: 'tts-identity-1' },
      updateProgress: vi.fn(async () => undefined),
      changePriority: vi.fn(async () => undefined),
      moveToDelayed,
    });
    const options = {
      audit,
      lifecycleQueue: generationQueueStub(),
      markWorkspacePageFailed: vi.fn(async () => undefined),
      processor: processor as never,
      runtime,
      peekTtsAdmission,
      now: () => 10_000,
    };

    const moveToDelayed = vi.fn(async () => undefined);
    await expect(
      processReachDeckQueuedJob(resumeJob(moveToDelayed), options),
    ).rejects.toBeInstanceOf(DelayedError);
    // 仍在排队：按探询给的退避放回 delayed，不读审计、不恢复 Runtime、不跑讲稿流程。
    expect(peekTtsAdmission).toHaveBeenCalledWith(
      'tts-identity-1',
      expect.objectContaining({
        context: expect.objectContaining({ jobId: narrationPayload.jobId }),
      }),
    );
    expect(moveToDelayed).toHaveBeenCalledWith(14_000, 'peek-lock');
    expect(audit.read).not.toHaveBeenCalled();
    expect(runtime.resume).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();

    // 能拿到槽位或探询失败时照常走完整重入。
    await expect(processReachDeckQueuedJob(resumeJob(), options)).resolves.toBe(result);
    await expect(processReachDeckQueuedJob(resumeJob(), options)).resolves.toBe(result);
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it('records the queued request identity in waiting-tts progress', async () => {
    const narrationPayload = stagedPayloadForKind('narration-generation');
    const updateProgress = vi.fn(async () => undefined);
    const processor = vi.fn(async () => {
      throw new ReachDeckTtsQueuedError(
        {
          protocol: 'tts-queue/v1',
          status: 'queued',
          ticket: 'ticket-identity',
          queuedAtEpochMillis: 1_000,
          expiresAtEpochMillis: 43_201_000,
          pollAfterMillis: 1_000,
          upstreamAttempts: 0,
        },
        'tts-identity-2',
      );
    });

    await expect(
      processReachDeckQueuedJob(
        {
          id: narrationPayload.jobId,
          name: reachDeckJobNameForPayload(narrationPayload),
          data: narrationPayload,
          attemptsMade: 0,
          opts: { attempts: 3 },
          token: 'identity-lock',
          updateProgress,
          changePriority: vi.fn(async () => undefined),
          moveToDelayed: vi.fn(async () => undefined),
        },
        {
          audit: createAuditLifecycle(),
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: processor as never,
          runtime: runtimeStub(runtimeExecutionStub()),
        },
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'waiting-tts', requestIdentity: 'tts-identity-2' }),
    );
  });

  it('preserves the durable attempt when a resumed TTS execution fails', async () => {
    const narrationPayload = stagedPayloadForKind('narration-generation');
    const audit = {
      ...createAuditLifecycle(),
      read: vi.fn(async () => auditResource('running', 3)),
    };
    const error = new Error('speech provider failed');
    await expect(
      processReachDeckQueuedJob(
        {
          id: narrationPayload.jobId,
          name: reachDeckJobNameForPayload(narrationPayload),
          data: narrationPayload,
          attemptsMade: 0,
          opts: { attempts: 1 },
          progress: { phase: 'waiting-tts', percent: 65 },
          updateProgress: vi.fn(async () => undefined),
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: vi.fn(async () => {
            throw error;
          }) as never,
          runtime: runtimeStub(),
        },
      ),
    ).rejects.toBe(error);
    expect(audit.update).toHaveBeenCalledWith(
      narrationPayload,
      expect.objectContaining({ status: 'failed', executionAttempt: 3 }),
    );
  });

  it.each(['read-error', 'zero-attempt', 'terminal-audit'])(
    'does not mutate a TTS resume with %s',
    async (scenario) => {
      const narrationPayload = stagedPayloadForKind('narration-generation');
      const audit = {
        ...createAuditLifecycle(),
        read: vi.fn(async () => {
          if (scenario === 'read-error') throw new Error('audit unavailable');
          return auditResource(
            scenario === 'terminal-audit' ? 'succeeded' : 'running',
            scenario === 'zero-attempt' ? 0 : 3,
          );
        }),
      };
      const runtime = runtimeStub();
      const processor = vi.fn();
      const markWorkspacePageFailed = vi.fn();
      const failure = await processReachDeckQueuedJob(
        {
          id: narrationPayload.jobId,
          name: reachDeckJobNameForPayload(narrationPayload),
          data: narrationPayload,
          attemptsMade: 0,
          opts: { attempts: 3 },
          progress: { phase: 'waiting-tts', percent: 65 },
          updateProgress: vi.fn(async () => undefined),
        },
        {
          audit,
          lifecycleQueue: generationQueueStub(),
          markWorkspacePageFailed,
          processor: processor as never,
          runtime,
        },
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(Error);
      if (scenario === 'read-error') expect(failure).not.toBeInstanceOf(UnrecoverableError);
      else expect(failure).toBeInstanceOf(UnrecoverableError);
      expect(audit.update).not.toHaveBeenCalled();
      expect(audit.abort).not.toHaveBeenCalled();
      expect(runtime.resume).not.toHaveBeenCalled();
      expect(processor).not.toHaveBeenCalled();
      expect(markWorkspacePageFailed).not.toHaveBeenCalled();
    },
  );

  it('projects BullMQ lock loss -3 as terminal manual failure instead of a fresh queue window', async () => {
    const narrationPayload = stagedPayloadForKind('narration-generation');
    const execution = runtimeExecutionStub();
    const runtime = runtimeStub(execution);
    const processor = vi.fn(async () => {
      throw new ReachDeckTtsQueuedError({
        protocol: 'tts-queue/v1',
        status: 'queued',
        ticket: 'ticket-1',
        queuedAtEpochMillis: 1_000,
        expiresAtEpochMillis: 43_201_000,
        pollAfterMillis: 1_000,
        upstreamAttempts: 0,
      });
    });
    const lockLost = Object.assign(new Error('Missing lock'), { code: -3 });

    const error = await processReachDeckQueuedJob(
      {
        id: narrationPayload.jobId,
        name: reachDeckJobNameForPayload(narrationPayload),
        data: narrationPayload,
        attemptsMade: 0,
        opts: { attempts: 3 },
        token: 'real-lock-token',
        changePriority: vi.fn(async () => undefined),
        moveToDelayed: vi.fn(async () => Promise.reject(lockLost)),
        updateProgress: vi.fn(async () => undefined),
      },
      {
        audit: createAuditLifecycle(),
        lifecycleQueue: generationQueueStub(),
        markWorkspacePageFailed: vi.fn(async () => undefined),
        processor: processor as never,
        runtime,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'UnrecoverableError',
      message: 'TTS_LEASE_LOST: BullMQ lock was lost while delaying TTS',
    });
    expect(execution.fail).toHaveBeenCalledWith(error);
    expect(execution.retry).not.toHaveBeenCalled();
  });

  it.each(['clone', 'default'] as const)(
    'uses the frozen %s voice when a tombstone cancels TTS before moveToDelayed',
    async (kind) => {
      const baseNarration = stagedPayloadForKind('narration-generation');
      if (baseNarration.kind !== 'narration-generation') throw new Error('expected narration');
      const voiceSelection =
        kind === 'default'
          ? { kind: 'default' as const, voice: 'configured_teacher_voice' }
          : {
              kind: 'clone' as const,
              grantId: '11111111-1111-4111-8111-111111111111',
              cloneId: '22222222-2222-4222-8222-222222222222',
              synthesisRevision: 3,
              courseId: baseNarration.resourceScope.courseId,
              agentRole: 'teacher' as const,
            };
      const narrationPayload = {
        ...baseNarration,
        voiceSelection,
        requestHash: buildScopedStagedGenerationRequestHash(baseNarration.resourceScope, {
          request: baseNarration.request,
          voiceSelection,
        }),
      };
      const lifecycleQueue = generationQueueStub();
      let checks = 0;
      lifecycleQueue.assertNotCancelled.mockImplementation(async () => {
        checks += 1;
        if (checks === 3) throw new ReachDeckGenerationCancelledError();
      });
      const exchangeVoiceCapability = vi.fn(async () => 'fresh-cancel-capability');
      const cancelSpeech = vi.fn(async () => undefined);
      const clearTtsContinuation = vi.fn(async () => undefined);
      const moveToDelayed = vi.fn(async () => undefined);
      const processor = vi.fn(async () => {
        throw new ReachDeckTtsQueuedError({
          protocol: 'tts-queue/v1',
          status: 'queued',
          ticket: 'ticket-race',
          queuedAtEpochMillis: 1_000,
          expiresAtEpochMillis: 43_201_000,
          pollAfterMillis: 1_000,
          upstreamAttempts: 0,
        });
      });

      const error = await processReachDeckQueuedJob(
        {
          id: narrationPayload.jobId,
          name: reachDeckJobNameForPayload(narrationPayload),
          data: narrationPayload,
          attemptsMade: 0,
          opts: { attempts: 3 },
          token: 'real-lock-token',
          changePriority: vi.fn(async () => undefined),
          moveToDelayed,
          updateProgress: vi.fn(async () => undefined),
        },
        {
          audit: createAuditLifecycle(),
          lifecycleQueue,
          markWorkspacePageFailed: vi.fn(async () => undefined),
          processor: processor as never,
          runtime: runtimeStub(),
          exchangeVoiceCapability,
          cancelSpeech,
          clearTtsContinuation,
        },
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ name: 'UnrecoverableError', message: 'Generation cancelled' });
      expect(moveToDelayed).not.toHaveBeenCalled();
      if (kind === 'clone')
        expect(exchangeVoiceCapability).toHaveBeenCalledWith(
          voiceSelection,
          'cancel',
          buildReachDeckTtsRequestIdentity(narrationPayload),
          expect.objectContaining({ roleGrantId: narrationPayload.roleGrantId }),
        );
      expect(cancelSpeech).toHaveBeenCalledWith(
        buildReachDeckTtsRequestIdentity(narrationPayload),
        expect.objectContaining(
          kind === 'clone'
            ? { voiceCloneCapability: 'fresh-cancel-capability' }
            : { voice: 'configured_teacher_voice' },
        ),
      );
      if (kind === 'default') expect(exchangeVoiceCapability).not.toHaveBeenCalled();
      expect(clearTtsContinuation).toHaveBeenCalledWith(narrationPayload);
    },
  );
});

function createAuditLifecycle(
  options: { status?: 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'aborted' } = {},
) {
  const resource = (status = options.status ?? 'queued', executionAttempt = 0) => ({
    id: 'audit-1',
    jobId: payload.jobId,
    runId: payload.runId,
    actorId: payload.actorId,
    billingGroupId: payload.billingGroupId,
    ...payload.resourceScope,
    generationKind: 'legacy-generation',
    generationStage: 'document',
    pageId: payload.pageId,
    generationAttempt: payload.attempt,
    executionAttempt,
    requestHash: payload.requestHash,
    status,
    startedAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  });
  return {
    create: vi.fn(async () => resource()),
    update: vi.fn(async (_payload, input: { status: string; executionAttempt?: number }) =>
      resource(
        input.status as ReturnType<typeof resource>['status'],
        input.status === 'running' ? 1 : 1,
      ),
    ),
    abort: vi.fn(async () => resource('aborted', 1)),
  };
}

function auditResource(
  status: 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'aborted',
  executionAttempt: number,
) {
  return {
    id: 'audit-1',
    jobId: payload.jobId,
    runId: payload.runId,
    actorId: payload.actorId,
    billingGroupId: payload.billingGroupId,
    ...payload.resourceScope,
    generationKind: 'legacy-generation',
    generationStage: 'document',
    pageId: payload.pageId,
    generationAttempt: payload.attempt,
    executionAttempt,
    requestHash: payload.requestHash,
    status,
    startedAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function generationQueueStub() {
  return {
    enqueue: vi.fn(async (_payload: ReachDeckAnyGenerationJobPayload) => undefined),
    read: vi.fn(async () => null),
    readWithPayload: vi.fn(async () => null),
    readExecutionState: vi.fn(async () => 'missing' as const),
    cancel: vi.fn(async () => null),
    retry: vi.fn(async () => null),
    assertNotCancelled: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function coordinatorQueueStub() {
  return {
    getJob: vi.fn<
      () => Promise<
        | {
            data: unknown;
            getState?: () => Promise<string>;
            retry?: (state: 'failed') => Promise<void>;
          }
        | null
        | undefined
      >
    >(async () => null),
    add: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function runtimeExecutionStub() {
  return {
    runId: 'runtime-run-1',
    assertBudget: vi.fn(async () => undefined),
    progress: vi.fn(async () => undefined),
    usage: vi.fn(async () => undefined),
    toolAudit: vi.fn(async () => undefined),
    decksmithEvent: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  } satisfies TeacherDeckRuntimeExecution;
}

function runtimeStub(execution = runtimeExecutionStub()) {
  return {
    ensureQueued: vi.fn(async () => {
      throw new Error('ensureQueued is not expected');
    }),
    readExisting: vi.fn(async () => null),
    failExisting: vi.fn(async () => undefined),
    claim: vi.fn(async () => execution),
    resume: vi.fn(async () => execution),
    failQueueing: vi.fn(async () => undefined),
    retryFailed: vi.fn(async () => undefined),
    failRetryDispatch: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    cancel: vi.fn<TeacherDeckRuntime['cancel']>(async () => ({ status: 'cancelled' })),
  } satisfies TeacherDeckRuntime;
}

function queuedJob(overrides: { attemptsMade?: number; opts?: { attempts?: number } } = {}) {
  return {
    id: payload.jobId,
    name: reachDeckJobNameForPayload(payload),
    data: payload,
    updateProgress: vi.fn(async () => undefined),
    ...overrides,
  };
}

function directProcessorOptions(processor: ReturnType<typeof vi.fn>, runtime: TeacherDeckRuntime) {
  return {
    audit: createAuditLifecycle(),
    lifecycleQueue: generationQueueStub(),
    markWorkspacePageFailed: vi.fn(async () => undefined),
    processor: processor as never,
    runtime,
    validateDecksmithJob: vi.fn(async () => undefined),
  };
}

async function workerHarness(
  audit: ReturnType<typeof createAuditLifecycle>,
  processor: ReturnType<typeof vi.fn>,
  redis = createFakeRedisClient(),
  harnessOptions: {
    payload?: ReachDeckAnyGenerationJobPayload;
    markWorkspacePageFailed?: (
      payload: ReachDeckStagedGenerationJobPayload,
      error: unknown,
    ) => Promise<void>;
  } = {},
) {
  const jobPayload = harnessOptions.payload ?? payload;
  class FakeQueue {
    client = Promise.resolve(redis);
    toKey = queueKey;
    constructor(_name: string, _options: { connection: Record<string, unknown>; prefix: string }) {}
    add = vi.fn();
    close = vi.fn(async () => undefined);
    getJob = vi.fn(async () => undefined);
  }
  const lifecycleQueue = createReachDeckGenerationQueueFromBullMQ({
    Queue: FakeQueue,
    env: queueEnv,
  });
  return (overrides: { attemptsMade?: number; opts?: { attempts?: number } }) =>
    processReachDeckQueuedJob(
      {
        name: reachDeckJobNameForPayload(jobPayload),
        data: jobPayload,
        updateProgress: async () => undefined,
        ...overrides,
      },
      {
        audit,
        lifecycleQueue,
        markWorkspacePageFailed:
          harnessOptions.markWorkspacePageFailed ?? vi.fn(async () => undefined),
        processor: processor as never,
      },
    );
}

function createFakeRedisClient(evalResult: unknown = ['cancelled', 'waiting']) {
  return {
    eval: vi.fn<(script: string, numberOfKeys: number, ...args: string[]) => Promise<unknown>>(
      async () => evalResult,
    ),
    get: vi.fn<() => Promise<string | null>>(async () => null),
    set: vi.fn(async () => 'OK'),
  };
}

function queueKey(type: string): string {
  return `${queuePrefix}:reach-deck-generation:${type}`;
}

function payloadScope(): ReachDeckGenerationJobScope {
  return {
    actorId: payload.actorId,
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
}

function decksmithPayload(): ReachDeckDecksmithJobPayload {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title: 'Queue observability test',
    }),
  );
  const input = parseReachDeckDecksmithJobInput({
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt: 'Shorten the first page',
    document,
  });
  const runId = buildDecksmithRunId({
    idempotencyKey: 'queue-decksmith-observability',
    ...payloadScope(),
  });
  const requestHash = buildDecksmithRequestHash(input);
  return {
    schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: buildDecksmithJobId({ runId, requestHash }),
    runId,
    requestHash,
    baseDocumentHash: buildDecksmithDocumentHash(input.document),
    ...payloadScope(),
    input,
  };
}
function stagedPayloadScope(): ReachDeckGenerationJobScope {
  return {
    actorId: stagedPayload.actorId,
    billingGroupId: stagedPayload.billingGroupId,
    roleGrantId: stagedPayload.roleGrantId,
    resourceScope: stagedPayload.resourceScope,
  };
}

function stagedPayloadForKind(
  kind: ReachDeckStagedGenerationJobKind,
): ReachDeckAnyGenerationJobPayload {
  const requests: Record<ReachDeckStagedGenerationJobKind, unknown> = {
    'lesson-plan': stagedRequest,
    'page-outline': validPageOutlineRequest,
    'page-generation': validPageGenerationRequest,
    'narration-generation': validNarrationGenerationRequest,
  };
  return stagedPayloadWithRequest(kind, requests[kind]);
}

function stagedPayloadWithRequest(
  kind: ReachDeckStagedGenerationJobKind,
  request: unknown,
): ReachDeckStagedGenerationJobPayload {
  return {
    ...stagedPayload,
    kind,
    jobId: `deck-v3-${kind}`,
    request,
    requestHash: buildScopedStagedGenerationRequestHash(TEST_REACH_DECK_RESOURCE_SCOPE, {
      request,
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    }),
  } as ReachDeckStagedGenerationJobPayload;
}

function createValidationQueue() {
  const add = vi.fn(async () => undefined);
  class FakeQueue {
    client = Promise.resolve(createFakeRedisClient());
    toKey = queueKey;
    constructor(_name: string, _options: { connection: Record<string, unknown>; prefix: string }) {}
    add = add;
    close = vi.fn(async () => undefined);
    getJob = vi.fn(async () => undefined);
  }
  return {
    add,
    queue: createReachDeckGenerationQueueFromBullMQ({
      Queue: FakeQueue,
      env: queueEnv,
    }),
  };
}

const validLessonPlan = {
  id: 'lesson-1',
  title: 'Systems',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain connected parts'],
  teachingStrategy: 'Model and practice',
  keyTerms: ['system'],
  narrative: 'Move from explanation to application.',
  assessmentPlan: 'Check understanding.',
};

function referenceDesign() {
  return {
    schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
    libraryVersion: REFERENCE_LIBRARY_VERSION,
    librarySha256: REFERENCE_LIBRARY_SHA256,
    paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
    imageStyleReferenceIds: [REFERENCE_LIBRARY.imageStyles[0]!.id],
    visualIntent: 'Clear teaching',
    resolvedColors: {
      background: '#FFFFFF',
      surface: '#FFFFFF',
      ink: '#111111',
      muted: '#555555',
      accent: '#006699',
      success: '#006600',
      warning: '#663300',
    },
  };
}
const validPage = {
  id: 'page-1',
  order: 1,
  sceneType: 'slide' as const,
  title: 'Systems page',
};
const validPagedOutline = {
  id: 'outline-1',
  title: 'Systems',
  pages: [validPage],
};
const validPageOutlineRequest = {
  source: 'Source facts',
  lessonPlan: validLessonPlan,
  prompt: 'Create an outline',
};
const validPageGenerationRequest = {
  runId: stagedPayload.runId,
  pageId: validPage.id,
  requestedRevision: 1,
  attempt: 1,
  attemptReason: 'initial' as const,
  source: 'Source facts',
  lessonPlan: validLessonPlan,
  pagedOutline: validPagedOutline,
  page: validPage,
  previousSlides: [],
  nearbyLayoutReferenceIds: [],
  prompt: 'Generate this page',
};
const validNarrationGenerationRequest = {
  runId: stagedPayload.runId,
  pageId: validPage.id,
  requestedRevision: 1,
  attempt: 1,
  attemptReason: 'initial' as const,
  source: 'Source facts',
  page: validPage,
  slideContentDigest: 'a'.repeat(64),
  prompt: 'Narrate this page',
};

function deterministicPageGenerationPayload(
  createdFromDraftRevision: number,
  request = structuredClone(validPageGenerationRequest),
  jobIdOverride?: string,
): ReachDeckPageGenerationJobPayload {
  const requestHash = buildScopedStagedGenerationRequestHash(stagedPayload.resourceScope, {
    request,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  });
  const runId = request.runId;
  const jobId = buildStagedGenerationJobId({
    actorId: stagedPayload.actorId,
    billingGroupId: stagedPayload.billingGroupId,
    resourceScope: stagedPayload.resourceScope,
    runId,
    requestHash,
    kind: 'page-generation',
    pageId: request.pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
  });
  return {
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind: 'page-generation',
    jobId: jobIdOverride ?? jobId,
    actorId: stagedPayload.actorId,
    billingGroupId: stagedPayload.billingGroupId,
    roleGrantId: stagedPayload.roleGrantId,
    resourceScope: stagedPayload.resourceScope,
    runId,
    createdFromDraftRevision,
    requestHash,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    request,
  };
}

function createExpiringLifecycleRedis() {
  let tombstone: string | null = null;
  let expiresAt = 0;
  const client = {
    get: vi.fn(async () => {
      if (Date.now() >= expiresAt) tombstone = null;
      return tombstone;
    }),
    eval: vi.fn(async (_script: string, _numberOfKeys: number, ...args: string[]) => {
      if (Date.now() >= expiresAt) tombstone = null;
      if (tombstone !== null) return ['existing', tombstone];
      tombstone = args[11] ?? null;
      expiresAt = Date.now() + Number(args[12]);
      return ['cancelled', 'waiting'];
    }),
  };
  return { client };
}
