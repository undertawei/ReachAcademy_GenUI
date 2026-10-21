import type { RunRecord } from './contracts.js';
import type { RuntimeEnv } from './env.js';
import { scheduleRun } from './queue.js';
import type { RuntimeStore } from './store/index.js';
import { formatRuntimeJobLogLine } from './worker-job-log.js';

// Error messages can carry job data, so only the class name and known transport/Redis phrases
// are logged. #602 P4: two Tutor messages got 503 here and nothing said why.
const ENQUEUE_FAILURE_HINT =
  /Connection is closed|Command timed out|Stream isn't writeable|max retries per request|Connection terminated|timeout exceeded when trying to connect|\b(?:READONLY|LOADING|OOM|MISCONF|CLUSTERDOWN|NOSCRIPT|BUSY)\b/i;

function enqueueFailureDetail(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return {};
  const hint = error.message.match(ENQUEUE_FAILURE_HINT)?.[0];
  return {
    ...(/^[A-Za-z]{1,60}$/.test(error.name) ? { errorName: error.name } : {}),
    ...(hint ? { errorHint: hint } : {}),
  };
}

const QUEUE_FAILURE = {
  code: 'RUN_QUEUE_UNAVAILABLE',
  message: 'AI Tutor queue is temporarily unavailable',
};

export class RunQueueUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super('AI Tutor 暂时无法开始回答，请重试');
    this.name = 'RunQueueUnavailableError';
  }
}

export interface ScheduledRun {
  run: RunRecord;
  eventsAfter?: string;
}

export async function schedulePersistedRun(
  result: { run: RunRecord; created: boolean },
  store: RuntimeStore,
  options: {
    env?: RuntimeEnv;
    queuedEvent?: Record<string, unknown>;
    enqueue?: typeof scheduleRun;
    /** Re-deliver the same durable job identity when reconciliation finds an active scoped Run. */
    recoverActive?: boolean;
  } = {},
): Promise<ScheduledRun> {
  let run = result.run;
  let eventsAfter: string | undefined;
  if (result.created) {
    eventsAfter = (await store.appendEvent(run.id, 'run.queued', options.queuedEvent)).id;
  } else if (run.status === 'failed' && run.error?.code === QUEUE_FAILURE.code) {
    const retried = await store.retryRunQueueing(run.id);
    if (retried) {
      run = retried;
      eventsAfter = (await store.appendEvent(run.id, 'run.queued', { recovered: true })).id;
    } else {
      run = (await store.getRun(run.id)) ?? run;
    }
  }

  const recoveringActive =
    options.recoverActive === true &&
    !result.created &&
    (run.status === 'queued' || run.status === 'running');
  if (recoveringActive && run.sceneKey === 'teacher.lesson-prep') {
    throw new RunQueueUnavailableError();
  }
  if (!recoveringActive && (run.status !== 'queued' || run.startedAt !== undefined)) {
    return { run, ...(eventsAfter ? { eventsAfter } : {}) };
  }
  try {
    await (options.enqueue ?? scheduleRun)(run.id, store, options.env, run.sceneKey);
  } catch (error) {
    console.warn(
      formatRuntimeJobLogLine({
        event: 'run.enqueue.failed',
        runId: run.id,
        sceneKey: run.sceneKey,
        recoveringActive,
        error,
        ...enqueueFailureDetail(error),
      }),
    );
    // A never-started Run can be projected as queue-unavailable. An already-started Run must
    // remain reclaimable through its existing durable Run/job id; reconciliation will try again.
    if (run.sceneKey === 'teacher.lesson-prep') {
      if (await store.interruptLessonPrepRun(run.id)) {
        await store.appendEvent(run.id, 'lesson-prep.run.interrupted', {
          code: 'INTERRUPTED_RESUMABLE',
          reason: 'queue-unavailable',
        });
      }
    } else if (!recoveringActive && (await store.failRunQueueing(run.id, QUEUE_FAILURE))) {
      await store.appendEvent(run.id, 'run.failed', QUEUE_FAILURE);
    }
    throw new RunQueueUnavailableError();
  }
  return {
    run: (await store.getRun(run.id)) ?? run,
    ...(eventsAfter ? { eventsAfter } : {}),
  };
}
