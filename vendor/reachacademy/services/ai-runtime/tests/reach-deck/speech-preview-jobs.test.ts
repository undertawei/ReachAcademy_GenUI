import { DelayedError, UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  execute: vi.fn(),
  releaseAdmission: vi.fn(async () => undefined),
  cancelSpeech: vi.fn(
    async (): Promise<'cancelled_pre_provider' | 'draining' | 'not_found'> => 'draining',
  ),
  exchangeCapability: vi.fn(),
  courseAuthorize: vi.fn(),
  courseCapability: vi.fn(),
  generateStructured: vi.fn(),
  queue: undefined as FakeQueue | undefined,
}));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    constructor() {
      return dependencies.queue!;
    }
  },
}));

vi.mock('../../lib/reach-deck/speech-markup-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/speech-markup-tools.js')>()),
  executeReachDeckSpeechPreviewAttempt: dependencies.execute,
}));
vi.mock('../../lib/reach-deck/speech-tool-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/speech-tool-admission.js')>()),
  releaseReachDeckSpeechToolAdmission: dependencies.releaseAdmission,
}));
vi.mock('../../lib/reach-deck/model-service-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-tools.js')>()),
  cancelReachDeckSpeech: dependencies.cancelSpeech,
}));
vi.mock('../../lib/reach-deck/model-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-client.js')>()),
  generateStructuredJsonWithModelService: dependencies.generateStructured,
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  exchangeReachDeckVoiceCapability: dependencies.exchangeCapability,
}));
vi.mock('../../lib/reach-deck/speech-preview-context.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/speech-preview-context.js')>()),
  authorizeCourseAgentPreviewSelection: dependencies.courseAuthorize,
  exchangeCourseAgentPreviewCapability: dependencies.courseCapability,
}));

import {
  cancelReachDeckSpeechPreviewTask,
  executeReachDeckSpeechPreviewJob,
  readReachDeckSpeechPreviewTask,
  submitReachDeckSpeechPreviewTask,
} from '../../lib/reach-deck/speech-preview-jobs.js';
import { ReachDeckTtsQueuedError } from '../../lib/reach-deck/model-service-tools.js';
import type { ReachDeckPreparedSpeechPreview } from '../../lib/reach-deck/speech-markup-tools.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const env = {
  REACHANY_ENV: 'test',
  REACHANY_QUEUE_NAMESPACE: 'preview-jobs',
  REDIS_HOST: '127.0.0.1',
};
const scoped = {
  ...TEST_REACH_DECK_SCOPE,
  workspaceContext: TEST_REACH_DECK_SCOPE,
  jobScope: TEST_REACH_DECK_SCOPE,
};
const modelContext = {
  actorId: scoped.actorId,
  billingGroupId: scoped.billingGroupId,
  resourceScope: scoped.resourceScope,
  jobId: 'speech-preview-job',
  runId: 'speech-preview-run',
};

describe('Reach Deck asynchronous speech preview jobs', () => {
  beforeEach(() => {
    dependencies.queue = new FakeQueue();
    dependencies.execute.mockReset();
    dependencies.releaseAdmission.mockClear();
    dependencies.cancelSpeech.mockReset().mockResolvedValue('draining');
    dependencies.exchangeCapability.mockReset();
    dependencies.courseAuthorize.mockReset().mockResolvedValue({ lockVersion: 0 });
    dependencies.courseCapability.mockReset().mockResolvedValue('execution-only-capability');
    globalThis.__reachanySpeechPreviewQueues = undefined;
    globalThis.__reachanyActiveSpeechPreviewTasks = undefined;
  });

  it('reserves an identity before admission so concurrent duplicates consume quota once', async () => {
    const acquire = vi.fn(async () => admission());
    let admit!: () => void;
    acquire.mockImplementationOnce(
      async () =>
        await new Promise<ReturnType<typeof admission>>((resolve) => {
          admit = () => resolve(admission());
        }),
    );

    const firstPending = submit(prepared(), acquire);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    const duplicatePending = submit(prepared(), acquire);
    admit();
    const [first, duplicate] = await Promise.all([firstPending, duplicatePending]);

    expect(first.status).toBe('queued');
    expect(duplicate).toEqual(first);
    expect(acquire).toHaveBeenCalledOnce();
    expect(dependencies.queue!.added).toHaveLength(1);
  });

  it('rejects conflicting identity reuse and isolates the same public id by authorization scope', async () => {
    await submit(prepared(), async () => admission());

    await expect(
      submit(prepared({ markdown: 'changed' }), async () => admission()),
    ).rejects.toThrow('conflicts');
    const otherScope = {
      ...scoped,
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceContext: {
        ...scoped.workspaceContext,
        actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      jobScope: { ...scoped.jobScope, actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    };
    const isolated = await submitReachDeckSpeechPreviewTask({
      scoped: otherScope,
      modelContext: { ...modelContext, actorId: otherScope.actorId },
      prepared: prepared(),
      acquireAdmission: async () => admission(),
      env,
    });
    expect(isolated.status).toBe('queued');
    expect(dependencies.queue!.added).toHaveLength(2);
  });

  it('honors a cancellation tombstone created before submit and releases acquired admission', async () => {
    const absent = await cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env);
    expect(absent).toBeNull();

    const task = await submit(prepared(), async () => admission());

    expect(task.status).toBe('cancelled');
    expect(dependencies.queue!.added).toHaveLength(0);
    expect(dependencies.releaseAdmission).toHaveBeenCalledOnce();
  });

  it('moves model-service 202 responses to delayed without consuming a BullMQ attempt', async () => {
    await submit(prepared(), async () => admission());
    dependencies.execute.mockRejectedValueOnce(
      new ReachDeckTtsQueuedError({
        protocol: 'tts-queue/v1',
        status: 'queued',
        ticket: 'private-ticket',
        queuedAtEpochMillis: Date.now(),
        expiresAtEpochMillis: Date.now() + 60_000,
        pollAfterMillis: 3_000,
        upstreamAttempts: 0,
      }),
    );
    const job = dependencies.queue!.added[0]!.job();

    await expect(executeReachDeckSpeechPreviewJob(job as never, env)).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    await expect(
      readReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env),
    ).resolves.toMatchObject({ status: 'queued', pollAfterMillis: 3_000 });
  });

  it('resolves formula readings once after admission and reuses them on a queued poll', async () => {
    const markdown = String.raw`比例是\(\frac{a}{b}\)。`;
    dependencies.generateStructured.mockImplementation(async (options) =>
      options.parse({ formulaReadings: [{ formulaId: 'f1', reading: 'a比b' }] }),
    );
    await submit(
      {
        ...prepared({ markdown }),
        pendingFormulaReadings: true,
        synthesisInput: '',
        alignmentTranscript: '',
      },
      async () => admission(),
    );
    expect(dependencies.generateStructured).not.toHaveBeenCalled();
    dependencies.execute
      .mockRejectedValueOnce(
        new ReachDeckTtsQueuedError({
          protocol: 'tts-queue/v1',
          status: 'queued',
          ticket: 'private-ticket',
          queuedAtEpochMillis: Date.now(),
          expiresAtEpochMillis: Date.now() + 60_000,
          pollAfterMillis: 3_000,
          upstreamAttempts: 0,
        }),
      )
      .mockResolvedValueOnce(previewResult());
    const firstJob = dependencies.queue!.added[0]!.job();
    await expect(executeReachDeckSpeechPreviewJob(firstJob as never, env)).rejects.toBeInstanceOf(
      DelayedError,
    );
    await executeReachDeckSpeechPreviewJob(dependencies.queue!.added[0]!.job() as never, env);

    expect(dependencies.generateStructured).toHaveBeenCalledOnce();
    const [firstPrepared, secondPrepared] = dependencies.execute.mock.calls.map(([value]) => value);
    expect(firstPrepared).toMatchObject({
      synthesisInput: '比例是a比b。',
      alignmentTranscript: '比例是a比b。',
      inputType: 'plain',
      formulaReadings: [{ reading: 'a比b' }],
    });
    expect(firstPrepared).not.toHaveProperty('pendingFormulaReadings');
    expect(secondPrepared).toEqual(firstPrepared);
  });

  it('delays cancellation-only reconciliation until queued provider work confirms cancellation', async () => {
    await submit(prepared(), async () => admission());
    dependencies.execute.mockRejectedValueOnce(
      new ReachDeckTtsQueuedError({
        protocol: 'tts-queue/v1',
        status: 'queued',
        ticket: 'private-ticket',
        queuedAtEpochMillis: Date.now(),
        expiresAtEpochMillis: Date.now() + 60_000,
        pollAfterMillis: 2_000,
        upstreamAttempts: 0,
      }),
    );
    const job = dependencies.queue!.added[0]!.job();
    await expect(executeReachDeckSpeechPreviewJob(job as never, env)).rejects.toBeInstanceOf(
      DelayedError,
    );

    dependencies.cancelSpeech.mockResolvedValue('draining');
    await expect(
      cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env),
    ).resolves.toMatchObject({ status: 'draining' });
    await expect(executeReachDeckSpeechPreviewJob(job as never, env)).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(dependencies.execute).toHaveBeenCalledOnce();
    expect(dependencies.releaseAdmission).not.toHaveBeenCalled();

    dependencies.cancelSpeech.mockResolvedValue('cancelled_pre_provider');
    await expect(executeReachDeckSpeechPreviewJob(job as never, env)).resolves.toEqual({
      taskId: 'rd.preview.task-1',
      status: 'cancelled',
    });
    expect(dependencies.execute).toHaveBeenCalledOnce();
    expect(dependencies.releaseAdmission).toHaveBeenCalledOnce();
  });

  it('bounds not-found cancellation reconciliation by the original task deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-22T10:00:00.000Z'));
      await submit(prepared(), async () => admission());
      dependencies.queue!.redis.rewriteTask((task) => ({
        ...task,
        status: 'queued',
        providerAttemptState: 'waiting',
      }));
      dependencies.cancelSpeech.mockResolvedValue('not_found');
      const job = dependencies.queue!.added[0]!.job();

      await cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env);
      await expect(executeReachDeckSpeechPreviewJob(job as never, env)).rejects.toBeInstanceOf(
        DelayedError,
      );
      expect(dependencies.releaseAdmission).not.toHaveBeenCalled();

      vi.advanceTimersByTime(15 * 60_000 + 1);
      await expect(executeReachDeckSpeechPreviewJob(job as never, env)).resolves.toEqual({
        taskId: 'rd.preview.task-1',
        status: 'expired',
      });
      expect(dependencies.execute).not.toHaveBeenCalled();
      expect(dependencies.releaseAdmission).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cancellation reconciliation alive after a transport failure during DELETE', async () => {
    await submit(prepared(), async () => admission());
    let rejectAttempt!: (error: Error) => void;
    dependencies.execute.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAttempt = reject;
        }),
    );
    const job = dependencies.queue!.added[0]!.job();
    const running = executeReachDeckSpeechPreviewJob(job as never, env);
    await vi.waitFor(() => expect(dependencies.execute).toHaveBeenCalledOnce());
    await cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env);
    rejectAttempt(new Error('connection reset'));

    await expect(running).rejects.toBeInstanceOf(DelayedError);
    expect(dependencies.releaseAdmission).not.toHaveBeenCalled();
    await expect(
      readReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env),
    ).resolves.toMatchObject({ status: 'draining' });
    dependencies.cancelSpeech.mockResolvedValue('cancelled_pre_provider');
    await expect(executeReachDeckSpeechPreviewJob(job as never, env)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(dependencies.execute).toHaveBeenCalledOnce();
    expect(dependencies.releaseAdmission).toHaveBeenCalledOnce();
  });

  it.each(['activation', 'queued-response', 'failure', 'worker-recovery'] as const)(
    'retains cancellation-only delayed work when DELETE wins the %s transition race',
    async (race) => {
      await submit(prepared(), async () => admission());
      // A waiting provider ticket makes DELETE retain admission until confirmation.
      dependencies.queue!.redis.rewriteTask((task) => ({
        ...task,
        status: race === 'worker-recovery' ? 'running' : 'queued',
        providerAttemptState: race === 'worker-recovery' ? 'in_flight' : 'waiting',
      }));
      dependencies.execute.mockRejectedValueOnce(
        race === 'queued-response'
          ? new ReachDeckTtsQueuedError({
              protocol: 'tts-queue/v1',
              status: 'queued',
              ticket: 'private-ticket',
              queuedAtEpochMillis: Date.now(),
              expiresAtEpochMillis: Date.now() + 60_000,
              pollAfterMillis: 2_000,
              upstreamAttempts: 0,
            })
          : new Error('connection reset'),
      );
      const targetStatus =
        race === 'activation' ? 'running' : race === 'queued-response' ? 'queued' : 'failed';
      const redis = dependencies.queue!.redis;
      const originalEval = redis.eval.bind(redis);
      let raced = false;
      vi.spyOn(redis, 'eval').mockImplementation(async (script, keys, key, ...args) => {
        if (!raced && keys === 1 && JSON.parse(args[3]!).status === targetStatus) {
          raced = true;
          await cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env);
        }
        return originalEval(script, keys, key, ...args);
      });
      const job = dependencies.queue!.added[0]!.job();

      await expect(executeReachDeckSpeechPreviewJob(job as never, env)).rejects.toBeInstanceOf(
        DelayedError,
      );
      expect(raced).toBe(true);
      expect(job.moveToDelayed).toHaveBeenCalledOnce();
      expect(dependencies.releaseAdmission).not.toHaveBeenCalled();
      await expect(
        readReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env),
      ).resolves.toMatchObject({ status: 'draining' });

      dependencies.cancelSpeech.mockResolvedValue('cancelled_pre_provider');
      await expect(executeReachDeckSpeechPreviewJob(job as never, env)).resolves.toMatchObject({
        status: 'cancelled',
      });
      expect(dependencies.execute).toHaveBeenCalledTimes(
        race === 'activation' || race === 'worker-recovery' ? 0 : 1,
      );
      expect(dependencies.releaseAdmission).toHaveBeenCalledOnce();
    },
  );

  it('fails closed instead of replaying a durable in-flight provider attempt after worker loss', async () => {
    await submit(prepared(), async () => admission());
    dependencies.queue!.redis.rewriteTask((task) => ({
      ...task,
      status: 'running',
      providerAttemptState: 'in_flight',
    }));
    const job = dependencies.queue!.added[0]!.job();

    await expect(executeReachDeckSpeechPreviewJob(job as never, env)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(dependencies.execute).not.toHaveBeenCalled();
    await expect(
      readReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'SPEECH_PREVIEW_OUTCOME_UNKNOWN' },
    });
  });

  it('holds admission while cancellation drains and releases after the local provider call settles', async () => {
    await submit(prepared(), async () => admission());
    let finish!: () => void;
    dependencies.execute.mockImplementationOnce(async (_prepared, context) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await context.assertCanPublish();
      throw new Error('unreachable');
    });
    const job = dependencies.queue!.added[0]!.job();
    const running = executeReachDeckSpeechPreviewJob(job as never, env);
    await vi.waitFor(() => expect(dependencies.execute).toHaveBeenCalledOnce());

    const draining = await cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env);
    expect(draining?.status).toBe('draining');
    expect(dependencies.releaseAdmission).not.toHaveBeenCalled();
    finish();
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(dependencies.releaseAdmission).toHaveBeenCalledOnce();
  });

  it('does not misclassify a queued provider ticket as pre-provider cancellation', async () => {
    await submit(
      { ...prepared(), voiceSelection: { kind: 'default', voice: 'configured_teacher_voice' } },
      async () => admission(),
    );
    dependencies.queue!.redis.rewriteTask((task) => ({
      ...task,
      status: 'queued',
      providerAttemptState: 'waiting',
    }));

    const task = await cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env);

    expect(task?.status).toBe('draining');
    expect(dependencies.cancelSpeech).toHaveBeenCalledOnce();
    expect(dependencies.cancelSpeech).toHaveBeenCalledWith(
      'rd.preview.task-1',
      expect.objectContaining({ voice: 'configured_teacher_voice' }),
    );
    expect(dependencies.releaseAdmission).not.toHaveBeenCalled();
  });

  it('allows only the activation owner to call the provider during overlapping delivery', async () => {
    await submit(prepared(), async () => admission());
    let finish!: () => void;
    dependencies.execute.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finish = () => resolve(previewResult());
        }),
    );
    const job = dependencies.queue!.added[0]!.job();
    const first = executeReachDeckSpeechPreviewJob(job as never, env);
    await vi.waitFor(() => expect(dependencies.execute).toHaveBeenCalledOnce());

    await expect(executeReachDeckSpeechPreviewJob(job as never, env)).resolves.toMatchObject({
      status: 'running',
    });
    expect(dependencies.execute).toHaveBeenCalledOnce();
    finish();
    await expect(first).resolves.toEqual({ taskId: 'rd.preview.task-1', status: 'ready' });
  });

  it('publishes only the bounded public result envelope without private task credentials', async () => {
    await submit(prepared(), async () => admission());
    dependencies.execute.mockResolvedValueOnce({
      schemaVersion: 'reach-deck-speech-preview/v1',
      pageId: 'page-1',
      pageRevision: 1,
      narrationDigest: 'a'.repeat(64),
      requestIdentity: 'rd.preview.task-1',
      audioBase64: 'AQID',
      contentType: 'audio/mpeg',
      sizeBytes: 3,
    });

    const workerOutcome = await executeReachDeckSpeechPreviewJob(
      dependencies.queue!.added[0]!.job() as never,
      env,
    );
    const task = await readReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env);

    expect(workerOutcome).toEqual({ taskId: 'rd.preview.task-1', status: 'ready' });
    expect(JSON.stringify(workerOutcome)).not.toContain('audioBase64');
    expect(task).toMatchObject({ status: 'ready', result: { audioBase64: 'AQID' } });
    expect(JSON.stringify(task)).not.toContain('lease-token');
    expect(JSON.stringify(task)).not.toContain('payloadHash');
    expect(JSON.stringify(task)).not.toContain('providerAttemptState');
  });

  it('reauthorizes course-only previews on read and cancellation and keeps clone credentials out of records', async () => {
    const courseScoped = {
      ...scoped,
      resourceScope: {
        kind: 'course-agent' as const,
        organizationId: scoped.resourceScope.organizationId,
        courseId: scoped.resourceScope.courseId,
        courseWorkspaceType: 'draft' as const,
        configurationId: '33333333-3333-4333-8333-333333333333',
      },
    };
    const value: ReachDeckPreparedSpeechPreview = {
      ...prepared(),
      reusableFullPreview: false,
      courseAgentSelection: {
        languageCode: 'en-US',
        voice: { kind: 'clone', cloneId: '66666666-6666-4666-8666-666666666666' },
        expectedLockVersion: 0,
      },
      voiceSelection: {
        kind: 'clone',
        cloneId: '66666666-6666-4666-8666-666666666666',
        synthesisRevision: 3,
        ownerAccountId: scoped.actorId,
        courseId: scoped.resourceScope.courseId,
        agentRole: 'teacher',
      },
    };
    await submitReachDeckSpeechPreviewTask({
      scoped: courseScoped,
      modelContext: {
        ...modelContext,
        resourceScope: courseScoped.resourceScope,
        roleGrantId: scoped.roleGrantId,
      },
      prepared: value,
      acquireAdmission: async () => admission(),
      env,
    });
    await readReachDeckSpeechPreviewTask(courseScoped, value.input.requestIdentity, env);
    expect(dependencies.courseAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ resourceScope: courseScoped.resourceScope }),
      value.courseAgentSelection,
      value.voiceSelection,
      undefined,
    );
    dependencies.execute.mockRejectedValueOnce(
      new ReachDeckTtsQueuedError({
        protocol: 'tts-queue/v1',
        status: 'queued',
        ticket: 'private-ticket',
        queuedAtEpochMillis: Date.now(),
        expiresAtEpochMillis: Date.now() + 60_000,
        pollAfterMillis: 3000,
        upstreamAttempts: 0,
      }),
    );
    await expect(
      executeReachDeckSpeechPreviewJob(dependencies.queue!.added[0]!.job() as never, env),
    ).rejects.toBeInstanceOf(DelayedError);
    dependencies.cancelSpeech.mockResolvedValueOnce('cancelled_pre_provider');
    await cancelReachDeckSpeechPreviewTask(courseScoped, value.input.requestIdentity, env);
    expect(dependencies.courseCapability).toHaveBeenCalledWith(
      expect.anything(),
      value.courseAgentSelection,
      value.voiceSelection,
      'cancel',
      value.input.requestIdentity,
      expect.any(AbortSignal),
    );
    expect(dependencies.exchangeCapability).not.toHaveBeenCalled();
    expect(JSON.stringify(Array.from(dependencies.queue!.redis.values.values()))).not.toContain(
      'execution-only-capability',
    );
    dependencies.courseAuthorize.mockRejectedValueOnce(new Error('grant revoked'));
    await expect(
      readReachDeckSpeechPreviewTask(courseScoped, value.input.requestIdentity, env),
    ).rejects.toThrow('grant revoked');
  });

  it('expires abandoned tasks at the original deadline and releases their page lease', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-22T10:00:00.000Z'));
      await submit(prepared(), async () => admission());
      vi.advanceTimersByTime(15 * 60_000 + 1);

      const task = await readReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env);

      expect(task).toMatchObject({
        status: 'expired',
        error: { code: 'SPEECH_PREVIEW_TIMEOUT' },
      });
      expect(dependencies.releaseAdmission).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('compensates an acquired lease when BullMQ enqueue fails', async () => {
    dependencies.queue!.failAdd = true;

    await expect(submit(prepared(), async () => admission())).rejects.toThrow('enqueue failed');

    expect(dependencies.releaseAdmission).toHaveBeenCalledOnce();
    await expect(
      readReachDeckSpeechPreviewTask(scoped, 'rd.preview.task-1', env),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'SPEECH_PREVIEW_ENQUEUE_FAILED' },
    });
  });

  it('rate limits only new missing-task cancellation tombstones', async () => {
    for (let index = 0; index < 32; index += 1) {
      await expect(
        cancelReachDeckSpeechPreviewTask(scoped, `rd.preview.missing-${index}`, env),
      ).resolves.toBeNull();
    }
    await expect(
      cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.missing-over-limit', env),
    ).rejects.toMatchObject({ status: 429, code: 'SPEECH_PREVIEW_CANCEL_RATE_LIMITED' });
    await expect(
      cancelReachDeckSpeechPreviewTask(scoped, 'rd.preview.missing-0', env),
    ).resolves.toBeNull();
  });
});

function prepared(overrides: { markdown?: string } = {}): ReachDeckPreparedSpeechPreview {
  const markdown = overrides.markdown ?? '试听文本';
  return {
    input: {
      pageId: 'page-1',
      markdown,
      selection: { from: 0, to: markdown.length },
      pageRevision: 1,
      narrationDigest: 'a'.repeat(64),
      requestIdentity: 'rd.preview.task-1',
    },
    voiceSelection: { kind: 'default', voice: 'zh_female_vv_uranus_bigtts' },
    synthesisInput: markdown,
    alignmentTranscript: markdown,
    inputType: 'plain',
    reusableFullPreview: true,
  };
}

function admission() {
  return { subject: 'b'.repeat(64), token: 'lease-token' };
}

function previewResult() {
  return {
    schemaVersion: 'reach-deck-speech-preview/v1' as const,
    pageId: 'page-1',
    pageRevision: 1,
    narrationDigest: 'a'.repeat(64),
    requestIdentity: 'rd.preview.task-1',
    audioBase64: 'AQID',
    contentType: 'audio/mpeg',
    sizeBytes: 3,
  };
}

function submit(
  value: ReachDeckPreparedSpeechPreview,
  acquireAdmission: () => Promise<ReturnType<typeof admission>>,
) {
  return submitReachDeckSpeechPreviewTask({
    scoped,
    modelContext,
    prepared: value,
    acquireAdmission,
    env,
  });
}

class FakeRedis {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<string | null> {
    if (args.includes('NX') && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async eval(script: string, _keys: number, key: string, ...args: string[]): Promise<unknown> {
    if (script.includes("return {'tombstone'}")) {
      if (this.values.has(key)) {
        this.values.set(args[0]!, '1');
        return ['task'];
      }
      const cancellationKey = args[0]!;
      if (this.values.has(cancellationKey)) return ['tombstone'];
      const rateKey = args[1]!;
      const count = Number(this.values.get(rateKey) ?? '0') + 1;
      this.values.set(rateKey, String(count));
      if (count > Number(args[3])) return ['rate'];
      this.values.set(cancellationKey, '1');
      return ['tombstone'];
    }
    const raw = this.values.get(key);
    if (raw === undefined) return ['missing'];
    const current = JSON.parse(raw);
    if (current.payloadHash !== args[0]) return ['conflict', raw];
    if (Number(current.revision) !== Number(args[1])) return ['stale', raw];
    const allowed = JSON.parse(args[2]!) as string[];
    if (!allowed.includes(current.status)) return ['current', raw];
    this.values.set(key, args[3]!);
    return ['updated', args[3]];
  }

  rewriteTask(update: (task: Record<string, unknown>) => Record<string, unknown>): void {
    const key = [...this.values.keys()].find((candidate) =>
      candidate.includes('speech-preview-task:'),
    )!;
    this.values.set(key, JSON.stringify(update(JSON.parse(this.values.get(key)!))));
  }
}

class FakeQueue {
  readonly redis = new FakeRedis();
  readonly client = Promise.resolve(this.redis);
  readonly added: Array<{
    name: string;
    data: Record<string, unknown>;
    options: Record<string, unknown>;
    job(): Record<string, unknown>;
  }> = [];
  failAdd = false;

  toKey(value: string): string {
    return `preview:${value}`;
  }

  async add(name: string, data: Record<string, unknown>, options: Record<string, unknown>) {
    if (this.failAdd) throw new Error('enqueue failed');
    const entry = {
      name,
      data,
      options,
      job: () => ({
        id: options.jobId,
        name,
        data,
        token: 'worker-lock-token',
        moveToDelayed: vi.fn(async () => undefined),
      }),
    };
    this.added.push(entry);
    return entry;
  }

  async getJob() {
    return undefined;
  }
}
