import { createHash } from 'node:crypto';
import { recordTutorReview, tutorTurn } from './tutor-optimization.js';
import { modelExecutionClaims } from './model-execution-contract.js';
import { ModelServiceError, transportFailure } from './model-service-error.js';
import { runtimeInternalFetch } from './internal-fetch-observability.js';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import { GuardrailError, guardrailCode } from '@reachany/ai-runtime-feedforward';
import type { AttachmentToolContent } from '@reachany/ai-runtime-common/file-ingestion';
import type { RunRecord } from './contracts.js';
import { isRuntimeMockMode, type RuntimeEnv } from './env.js';
import { resolveModelOpenAiBaseUrl } from './feedforward/model-adapter.js';

export type GuardrailInputPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

// Execution-local evidence; never serialize it into a Run or accept it from a browser.
const submissionInputs = new WeakMap<RunRecord, GuardrailInputPart[]>();

export function setGuardrailInput(run: RunRecord, text: string): void {
  submissionInputs.set(run, [{ type: 'text', text }]);
}

export function guardrailInputForRun(run: RunRecord): GuardrailInputPart[] | undefined {
  if (run.sceneKey === 'student.tutor') {
    if (typeof run.input.message !== 'string') throw new GuardrailError('GUARDRAIL_UNAVAILABLE');
    return [{ type: 'text', text: run.input.message }];
  }
  if (!run.sceneKey.startsWith('student.')) return undefined;
  const content = submissionInputs.get(run);
  if (!content) throw new GuardrailError('GUARDRAIL_UNAVAILABLE');
  return content;
}

/** Learner attachment evidence is INPUT even when produced by ASR or document extraction. */
export async function reviewAttachmentInput(
  run: RunRecord,
  env: RuntimeEnv,
  content: AttachmentToolContent[],
  signal?: AbortSignal,
): Promise<void> {
  const parts: GuardrailInputPart[] = content.map((part) =>
    part.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
      : part,
  );
  const turnId =
    run.sceneKey === 'student.tutor'
      ? `${tutorTurn(run).turnId}:attachment:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
      : undefined;
  await reviewInput(run, env, parts, signal, turnId);
}

export async function reviewTutorInput(
  run: RunRecord,
  env: RuntimeEnv,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
  recheck = false,
): Promise<string | undefined> {
  if (run.sceneKey !== 'student.tutor') return undefined;
  signal?.throwIfAborted();
  const turn = tutorTurn(run);
  if (turn.reviewed && !recheck) return turn.receipt;
  const parts = guardrailInputForRun(run)!;
  const receipt = await reviewInput(run, env, parts, signal, turn.turnId, fetchImpl);
  signal?.throwIfAborted();
  recordTutorReview(run, receipt);
  return receipt;
}

async function reviewInput(
  run: RunRecord,
  env: RuntimeEnv,
  parts: GuardrailInputPart[],
  signal?: AbortSignal,
  turnId?: string,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  const isTutor = run.sceneKey === 'student.tutor';
  if (isTutor) signal?.throwIfAborted();
  if (isRuntimeMockMode(env)) return undefined;
  const config = readHs256ServiceJwtConfig(env);
  const token = await createHs256Token({
    secret: config.secret,
    subject: 'ai-runtime',
    actorId: run.actor.subject,
    orgId: run.actor.orgId,
    issuer: config.issuer,
    audience: config.audience,
    expiresInSeconds: 300,
    roles: ['model-service:delegate'],
    extraClaims: {
      ...modelExecutionClaims(env),
      scene_id: run.sceneKey,
      run_id: run.id,
      guardrail_contract: 'scene-v2',
      ...(turnId
        ? {
            tutor_optimization_contract: 'tutor-v1',
            tutor_turn_id: turnId,
            tutor_output_purpose: 'student_visible',
          }
        : {}),
    },
  });
  if (isTutor) signal?.throwIfAborted();
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  const failTransport = (): never => {
    if (isTutor) {
      signal?.throwIfAborted();
      throw transportFailure(signal, effectiveSignal);
    }
    throw new GuardrailError('GUARDRAIL_UNAVAILABLE');
  };
  let response: Response;
  try {
    response = await runtimeInternalFetch('ai.model.guardrail', fetchImpl ?? fetch)(
      `${resolveModelOpenAiBaseUrl(env)}/guardrails/review`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: parts }),
        signal: effectiveSignal,
      },
    );
  } catch {
    return failTransport();
  }
  if (isTutor) {
    signal?.throwIfAborted();
    if (effectiveSignal.aborted) failTransport();
  }
  if (!response.ok) {
    let body: string;
    try {
      body = await response.text();
    } catch {
      return failTransport();
    }
    if (isTutor) {
      signal?.throwIfAborted();
      if (effectiveSignal.aborted) failTransport();
    }
    const code = guardrailCode(body);
    if (isTutor && !code)
      throw new ModelServiceError(
        `model-service returned HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    throw new GuardrailError(code ?? 'GUARDRAIL_UNAVAILABLE');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    return failTransport();
  }
  if (isTutor) {
    signal?.throwIfAborted();
    if (effectiveSignal.aborted) failTransport();
    const code = guardrailCode(result);
    if (code) throw new GuardrailError(code);
  }
  const invalidResponse = (): never => {
    if (isTutor) throw new ModelServiceError('model-service returned invalid input review', true);
    throw new GuardrailError('GUARDRAIL_UNAVAILABLE');
  };
  if (result?.reviewed !== true) invalidResponse();
  if (
    result.receipt !== undefined &&
    (typeof result.receipt !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(result.receipt))
  )
    invalidResponse();
  return result.receipt;
}
