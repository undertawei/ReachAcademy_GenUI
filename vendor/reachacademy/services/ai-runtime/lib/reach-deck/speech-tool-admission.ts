import { createHash, randomUUID } from 'node:crypto';

import {
  createReachDeckEventStoreRedisSource,
  type ReachDeckEventStoreRedisSource,
} from './queue.js';
import { isCourseAgentPreviewScope, type SpeechPreviewScope } from './speech-preview-context.js';

export type ReachDeckSpeechToolOperation = 'candidates' | 'preview';

export interface ReachDeckSpeechToolAdmissionLease {
  descriptor: ReachDeckSpeechToolAdmissionDescriptor;
  release(): Promise<void>;
}

export interface ReachDeckSpeechToolAdmissionDescriptor {
  subject: string;
  token: string;
}

export class ReachDeckSpeechToolAdmissionError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 429 | 503,
    readonly code:
      | 'SPEECH_TOOL_REQUEST_ACTIVE'
      | 'SPEECH_TOOL_RATE_LIMITED'
      | 'SPEECH_TOOL_ADMISSION_UNAVAILABLE',
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ReachDeckSpeechToolAdmissionError';
  }
}

interface AdmissionRedisClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface ReachDeckSpeechToolAdmissionDependencies {
  createSource: () => Promise<ReachDeckEventStoreRedisSource>;
  createToken: () => string;
}

const ACQUIRE_SCRIPT = `
local acquired = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if not acquired then
  return {'active', redis.call('PTTL', KEYS[1])}
end
local count = redis.call('INCR', KEYS[2])
if count == 1 or redis.call('PTTL', KEYS[2]) < 0 then
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
end
if count > tonumber(ARGV[4]) then
  if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
  return {'rate', redis.call('PTTL', KEYS[2])}
end
return {'acquired', count}
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RATE_WINDOW_MS = 60_000;
const POLICY: Readonly<
  Record<ReachDeckSpeechToolOperation, { activeTtlMs: number; requestsPerWindow: number }>
> = Object.freeze({
  candidates: { activeTtlMs: 12 * 60_000, requestsPerWindow: 4 },
  preview: { activeTtlMs: 15 * 60_000, requestsPerWindow: 8 },
});

const defaultDependencies: ReachDeckSpeechToolAdmissionDependencies = {
  createSource: () => createReachDeckEventStoreRedisSource(),
  createToken: randomUUID,
};

export async function acquireReachDeckSpeechToolAdmission(
  input: {
    operation: ReachDeckSpeechToolOperation;
    actorId: string;
    pageId: string;
    resourceScope: SpeechPreviewScope;
  },
  dependencies: ReachDeckSpeechToolAdmissionDependencies = defaultDependencies,
): Promise<ReachDeckSpeechToolAdmissionLease> {
  const policy = POLICY[input.operation];
  const subject = createHash('sha256')
    .update(
      [
        input.actorId,
        input.resourceScope.organizationId,
        input.resourceScope.courseId,
        isCourseAgentPreviewScope(input.resourceScope)
          ? `course-agent:${input.resourceScope.configurationId}`
          : input.resourceScope.moduleVersionId,
        input.pageId,
      ].join('\0'),
    )
    .digest('hex');
  const token = dependencies.createToken();
  const source = await createSourceOrReject(dependencies);
  let result: unknown;
  try {
    const redis = (await source.client) as AdmissionRedisClient;
    result = await redis.eval(
      ACQUIRE_SCRIPT,
      2,
      source.streamKey(`speech-tool:active:${subject}`),
      source.streamKey(`speech-tool:${input.operation}:rate:${subject}`),
      token,
      policy.activeTtlMs,
      RATE_WINDOW_MS,
      policy.requestsPerWindow,
    );
  } catch (error) {
    throw unavailable(error);
  } finally {
    await source.close().catch(() => undefined);
  }
  if (!Array.isArray(result) || typeof result[0] !== 'string') throw unavailable();
  const retryAfterSeconds = retryAfter(result[1]);
  if (result[0] === 'active') {
    throw new ReachDeckSpeechToolAdmissionError(
      'A speech tool request is already active for this page',
      409,
      'SPEECH_TOOL_REQUEST_ACTIVE',
      retryAfterSeconds,
    );
  }
  if (result[0] === 'rate') {
    throw new ReachDeckSpeechToolAdmissionError(
      'Speech tool request rate limit exceeded',
      429,
      'SPEECH_TOOL_RATE_LIMITED',
      retryAfterSeconds,
    );
  }
  if (result[0] !== 'acquired') throw unavailable();

  let released = false;
  const descriptor = Object.freeze({ subject, token });
  return {
    descriptor,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await releaseReachDeckSpeechToolAdmission(descriptor, dependencies);
    },
  };
}

/** Releases a lease after ownership has moved from an API replica to a worker. */
export async function releaseReachDeckSpeechToolAdmission(
  descriptor: ReachDeckSpeechToolAdmissionDescriptor,
  dependencies: Pick<
    ReachDeckSpeechToolAdmissionDependencies,
    'createSource'
  > = defaultDependencies,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(descriptor.subject) || descriptor.token.trim().length === 0) {
    throw unavailable();
  }
  const releaseSource = await createSourceOrReject({
    ...defaultDependencies,
    ...dependencies,
  });
  try {
    const redis = (await releaseSource.client) as AdmissionRedisClient;
    await redis.eval(
      RELEASE_SCRIPT,
      1,
      releaseSource.streamKey(`speech-tool:active:${descriptor.subject}`),
      descriptor.token,
    );
  } catch (error) {
    throw unavailable(error);
  } finally {
    await releaseSource.close().catch(() => undefined);
  }
}

function retryAfter(value: unknown): number | undefined {
  const milliseconds = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.max(1, Math.ceil(milliseconds / 1_000))
    : undefined;
}

function unavailable(cause?: unknown): ReachDeckSpeechToolAdmissionError {
  return new ReachDeckSpeechToolAdmissionError(
    'Speech tool admission is unavailable',
    503,
    'SPEECH_TOOL_ADMISSION_UNAVAILABLE',
    cause === undefined ? undefined : 1,
  );
}

async function createSourceOrReject(
  dependencies: ReachDeckSpeechToolAdmissionDependencies,
): Promise<ReachDeckEventStoreRedisSource> {
  try {
    return await dependencies.createSource();
  } catch (error) {
    throw unavailable(error);
  }
}
