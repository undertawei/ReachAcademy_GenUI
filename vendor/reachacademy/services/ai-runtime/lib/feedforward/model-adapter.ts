import { modelExecutionClaims } from '../model-execution-contract.js';
import { runtimeInternalFetch } from '../internal-fetch-observability.js';
import { openAsBlob } from 'node:fs';

import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import {
  FEEDFORWARD_IMAGE_CAPABILITY,
  type FeedforwardModelRequestContext,
  FeedforwardModelServiceError,
  guardrailCode,
  gradingSceneStage,
  resolveGradingScene,
} from '@reachany/ai-runtime-feedforward';

import { createModelServiceRequestInit, type RuntimeEnv } from '../env.js';
import type { RunRecord } from '../contracts.js';
import { guardrailInputForRun } from '../guardrail-input.js';

const RETRYABLE = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

export function resolveModelOpenAiBaseUrl(env: RuntimeEnv): string {
  const base = new URL((env.REACHANY_MODEL_BASE_URL ?? 'http://127.0.0.1:8100') + '/');
  const path = base.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  base.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  base.search = '';
  base.hash = '';
  return base.toString().replace(/\/+$/, '');
}

async function modelToken(
  run: RunRecord,
  env: RuntimeEnv,
  context?: FeedforwardModelRequestContext,
) {
  const config = readHs256ServiceJwtConfig(env);
  return createHs256Token({
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
      token_type: 'service',
      organization_id: run.actor.orgId,
      run_id: run.id,
      scene_id: run.sceneKey,
      guardrail_contract: 'scene-v2',
      ...(context?.submissionId ? { submission_id: context.submissionId } : {}),
    },
  });
}

interface ManagedInput {
  filePath: string;
  filename: string;
  contentType: string;
  context: FeedforwardModelRequestContext;
  env: RuntimeEnv;
  fetch: typeof fetch;
}

async function multipart(
  input: ManagedInput & {
    endpoint: string;
    invocation: Record<string, string>;
    fields?: Record<string, string>;
  },
  run: RunRecord,
): Promise<Record<string, unknown>> {
  const file = await openAsBlob(input.filePath, { type: input.contentType });
  const form = new FormData();
  form.set('file', file, input.filename);
  form.set('session_id', input.context.attemptId ?? input.context.submissionId);
  form.set('invocation', JSON.stringify(input.invocation));
  for (const [key, value] of Object.entries(input.fields ?? {})) form.set(key, value);
  let response: Response;
  try {
    response = await runtimeInternalFetch('ai.model.media', input.fetch)(input.endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${await modelToken(run, input.env, input.context)}`,
      },
      body: form,
      ...createModelServiceRequestInit(input.env, 'non-stream'),
    });
  } catch (error) {
    throw new FeedforwardModelServiceError('model-service file request failed', {
      retryable: true,
      cause: error,
    });
  }
  if (!response.ok) {
    const code = guardrailCode(await response.text().catch(() => ''));
    if (code)
      throw new FeedforwardModelServiceError(code, { retryable: false, status: response.status });
    throw new FeedforwardModelServiceError(
      `model-service file request failed with HTTP ${response.status}`,
      {
        retryable: RETRYABLE(response.status),
        status: response.status,
      },
    );
  }
  const payload = (await response.json()) as unknown;
  const envelope = record(payload);
  const body = record(envelope?.data) ?? envelope;
  if (!body)
    throw new FeedforwardModelServiceError('model-service response was not an object', {
      retryable: false,
    });
  return body;
}

export async function extractPdf(input: ManagedInput, run: RunRecord) {
  const body = await multipart(
    {
      ...input,
      endpoint: `${resolveModelOpenAiBaseUrl(input.env)}/document/extractions`,
      invocation: attachmentInvocation(run, 'read_attachment.pdf', 'document-extraction'),
      fields: {
        max_images: '8',
        max_image_bytes: String(40 * 1024 * 1024),
        max_text_chars: '12000',
      },
    },
    run,
  );
  if (typeof body.text !== 'string')
    throw new FeedforwardModelServiceError('document extraction response did not contain text', {
      retryable: false,
    });
  const images = Array.isArray(body.images)
    ? body.images.flatMap((value) => {
        const image = record(value);
        return image && typeof image.data === 'string' && typeof image.mime_type === 'string'
          ? [
              {
                data: image.data,
                mimeType: image.mime_type,
                ...(typeof image.page_number === 'number' ? { pageNumber: image.page_number } : {}),
                ...(typeof image.description === 'string'
                  ? { description: image.description }
                  : {}),
              },
            ]
          : [];
      })
    : [];
  return { text: body.text, images };
}

export async function transcribeAudio(input: ManagedInput, run: RunRecord): Promise<string> {
  const body = await multipart(
    {
      ...input,
      endpoint: `${resolveModelOpenAiBaseUrl(input.env)}/audio/transcriptions`,
      invocation: attachmentInvocation(run, 'read_attachment.audio', 'speech-recognition'),
    },
    run,
  );
  if (typeof body.text !== 'string')
    throw new FeedforwardModelServiceError('transcription response did not contain text', {
      retryable: false,
    });
  return body.text;
}

export async function understandMedia(
  input: ManagedInput & { task: string },
  run: RunRecord,
  kind: 'audio' | 'video',
): Promise<string> {
  const body = await multipart(
    {
      ...input,
      endpoint: `${resolveModelOpenAiBaseUrl(input.env)}/feedforward/media/${kind}/understandings`,
      invocation: attachmentInvocation(
        run,
        kind === 'audio' ? 'read_attachment.audio' : 'read_attachment.video',
        'media-understanding',
      ),
      fields: { task: input.task },
    },
    run,
  );
  if (typeof body.text !== 'string')
    throw new FeedforwardModelServiceError('media understanding response did not contain text', {
      retryable: false,
    });
  return body.text;
}

function attachmentInvocation(
  run: RunRecord,
  tool: string,
  channel: string,
): Record<string, string> {
  const gradingScene = resolveGradingScene(run.sceneKey);
  const route =
    gradingScene !== null
      ? { orchestration: gradingScene.orchestration, stage: gradingSceneStage(gradingScene) }
      : run.sceneKey === 'student.srl.feedforward'
        ? { orchestration: 'srl.feedback', stage: 'feedback' }
        : run.sceneKey === 'student.group-collaboration.review'
          ? { orchestration: 'group.review', stage: 'review' }
          : run.sceneKey === 'teacher.lesson-prep' && tool === 'read_attachment.pdf'
            ? { orchestration: 'lesson-prep/v1', stage: 'resource-integration' }
            : undefined;
  if (route === undefined) {
    throw new FeedforwardModelServiceError(
      `No attachment invocation contract is registered for ${run.sceneKey}`,
      { retryable: false },
    );
  }
  return {
    scene_id: run.sceneKey,
    orchestration: route.orchestration,
    stage: route.stage,
    tool,
    channel,
  };
}

export async function generateImage(
  input: {
    prompt: string;
    size: string;
    context: FeedforwardModelRequestContext;
    env: RuntimeEnv;
    fetch: typeof fetch;
    /** 调用方（批阅循环）的中止信号，与请求超时合并。 */
    signal?: AbortSignal;
  },
  run: RunRecord,
): Promise<{ base64: string }> {
  const response = await runtimeInternalFetch('ai.model.media', input.fetch)(
    `${resolveModelOpenAiBaseUrl(input.env)}/images/generations`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${await modelToken(run, input.env, input.context)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'policy-routed',
        prompt: input.prompt,
        reachany_guardrail_input: guardrailInputForRun(run),
        n: 1,
        quality: 'medium',
        size: input.size,
        response_format: 'b64_json',
        session_id: input.context.attemptId ?? input.context.submissionId,
        metadata: {
          reachany_application_llm_span: {
            invocation: {
              scene_id: run.sceneKey,
              // 反馈图片槽位按批阅 Scene 的 orchestration 区分（测验 quiz.feedback.image-generation）。
              orchestration: resolveGradingScene(run.sceneKey)?.orchestration ?? 'quiz.feedback',
              // Image feedback is its own execution slot.  Keep the invocation tuple aligned
              // with model-service's server-owned registry instead of reusing the text feedback
              // stage/tool labels.
              stage: 'generate_image',
              tool: 'image-generation',
              channel: 'image-generation',
            },
            run_id: input.context.generationRunId ?? input.context.submissionId,
            question_id: input.context.questionId,
          },
        },
      }),
      ...createModelServiceRequestInit(input.env, 'non-stream', input.signal),
    },
  );
  if (!response.ok) {
    const code = guardrailCode(await response.text().catch(() => ''));
    if (code)
      throw new FeedforwardModelServiceError(code, { retryable: false, status: response.status });
    throw new FeedforwardModelServiceError(
      `model-service image request failed with HTTP ${response.status}`,
      { retryable: RETRYABLE(response.status), status: response.status },
    );
  }
  const envelope = record(await response.json());
  const body = record(envelope?.data) ?? envelope;
  const first = Array.isArray(body?.data) ? record(body.data[0]) : undefined;
  if (!first || typeof first.b64_json !== 'string' || first.b64_json.length === 0)
    throw new FeedforwardModelServiceError('image response did not contain b64_json', {
      retryable: false,
    });
  return { base64: first.b64_json };
}

function record(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}
