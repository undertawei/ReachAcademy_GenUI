import { runtimeInternalFetch } from '../internal-fetch-observability.js';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import {
  createAttachmentIngestionDependencies,
  type AttachmentIngestionDependencies,
} from '@reachany/ai-runtime-feedforward';

import type { RunRecord } from '../contracts.js';
import { contentApiUrl } from '../domain-client.js';
import type { RuntimeEnv } from '../env.js';
import { extractPdf, transcribeAudio, understandMedia } from '../feedforward/model-adapter.js';

export interface GroupCollaborationReviewAttachment {
  objectKey: string;
  name?: string;
  contentType?: string;
  sizeBytes?: number;
  downloadUrl?: string;
}

export interface GroupCollaborationReviewBundle {
  submissionId: string;
  attemptId: string;
  actorAccountId: string;
  moduleVersionId: string;
  generation: number;
  taskInstructions: unknown;
  rubric: Record<string, unknown>;
  submissionSummary: unknown;
  attachments: GroupCollaborationReviewAttachment[];
  submittedAt: string;
}

export interface GroupCollaborationReviewContext {
  submissionId: string;
  generation: number;
  organizationId: string;
  actorSubject: string;
  runId: string;
}

export interface GroupCollaborationReviewPorts {
  fetchBundle(context: GroupCollaborationReviewContext): Promise<GroupCollaborationReviewBundle>;
  start(context: GroupCollaborationReviewContext, attemptNumber: number): Promise<void>;
  complete(
    context: GroupCollaborationReviewContext,
    payload: {
      feedback: { format: 'markdown'; content: string; source: 'agent' };
      suggestedScore: number | null;
      rubricSource: 'configured' | 'inferred';
      evaluationDimensions: Record<string, unknown>[];
      evidence: Record<string, unknown>[];
      limitations: string[];
      agentMeta: Record<string, unknown>;
    },
  ): Promise<void>;
  fail(context: GroupCollaborationReviewContext, failureCode: string): Promise<void>;
  attachmentDependencies: AttachmentIngestionDependencies;
}

export function createGroupCollaborationReviewPorts(
  run: RunRecord,
  env: RuntimeEnv,
  signal?: AbortSignal,
): GroupCollaborationReviewPorts {
  return {
    fetchBundle: async (context) =>
      normalizeGroupCollaborationReviewBundle(
        await requestContent(`${basePath(context)}/bundle`, run, env, signal),
        context,
      ),
    start: (context, attemptNumber) =>
      postContent(`${basePath(context)}/runs/${context.runId}/start`, run, env, signal, {
        attemptNumber,
      }),
    complete: (context, payload) =>
      postContent(`${basePath(context)}/runs/${context.runId}/complete`, run, env, signal, payload),
    fail: (context, failureCode) =>
      postContent(`${basePath(context)}/runs/${context.runId}/failure`, run, env, signal, {
        failureCode,
      }),
    attachmentDependencies: createAttachmentIngestionDependencies({
      extractPdf: (input) => extractPdf(input, run),
      transcribeAudio: (input) => transcribeAudio(input, run),
      understandAudio: (input) => understandMedia(input, run, 'audio'),
      understandVideo: (input) => understandMedia(input, run, 'video'),
    }),
  };
}

export function normalizeGroupCollaborationReviewBundle(
  value: unknown,
  context: Pick<GroupCollaborationReviewContext, 'submissionId' | 'generation' | 'actorSubject'>,
): GroupCollaborationReviewBundle {
  const bundle = record(value, 'group collaboration review bundle');
  const submissionId = string(bundle.submissionId, 'bundle.submissionId');
  const generation = integer(bundle.generation, 'bundle.generation');
  if (submissionId !== context.submissionId || generation !== context.generation) {
    throw new Error('Group collaboration review bundle does not match the Run');
  }
  const actorAccountId = string(bundle.actorAccountId, 'bundle.actorAccountId');
  if (actorAccountId !== context.actorSubject) {
    throw new Error('Group collaboration review bundle account does not match the Run actor');
  }
  const rubric =
    bundle.rubric === null || bundle.rubric === undefined
      ? {}
      : record(bundle.rubric, 'bundle.rubric');
  const attachments = Array.isArray(bundle.attachments)
    ? bundle.attachments.map((entry, index) => normalizeAttachment(entry, index))
    : [];
  if (new Set(attachments.map((attachment) => attachment.objectKey)).size !== attachments.length) {
    throw new Error('Group collaboration review bundle contains duplicate attachment objectKeys');
  }
  return {
    submissionId,
    attemptId: string(bundle.attemptId, 'bundle.attemptId'),
    actorAccountId,
    moduleVersionId: string(bundle.moduleVersionId, 'bundle.moduleVersionId'),
    generation,
    taskInstructions: bundle.taskInstructions,
    rubric,
    submissionSummary: bundle.submissionSummary,
    attachments,
    submittedAt: string(bundle.submittedAt, 'bundle.submittedAt'),
  };
}

function basePath(context: GroupCollaborationReviewContext): string {
  return `/group-collaboration/internal/reviews/${encodeURIComponent(context.submissionId)}/generations/${context.generation}`;
}

function normalizeAttachment(value: unknown, index: number): GroupCollaborationReviewAttachment {
  const attachment = record(value, `bundle.attachments[${index}]`);
  return {
    objectKey: string(attachment.objectKey, `attachment ${index}.objectKey`),
    ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
    ...(typeof attachment.contentType === 'string' ? { contentType: attachment.contentType } : {}),
    ...(typeof attachment.sizeBytes === 'number' ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(typeof attachment.downloadUrl === 'string' ? { downloadUrl: attachment.downloadUrl } : {}),
  };
}

function record(value: unknown, path: string): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, any>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${path} must be an integer`);
  return Number(value);
}

async function serviceToken(run: RunRecord, env: RuntimeEnv): Promise<string> {
  const config = readHs256ServiceJwtConfig(env);
  return createHs256Token({
    secret: config.secret,
    subject: 'ai-runtime',
    actorId: run.actor.subject,
    issuer: config.issuer,
    audience: config.audience,
    expiresInSeconds: 300,
    roles: ['ai-runtime-service'],
    orgId: run.actor.orgId,
    extraClaims: { token_type: 'service', run_id: run.id, scene_id: run.sceneKey },
  });
}

async function requestContent(
  path: string,
  run: RunRecord,
  env: RuntimeEnv,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await runtimeInternalFetch('ai.content')(contentApiUrl(path, env), {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${await serviceToken(run, env)}`,
    },
    signal,
  });
  if (!response.ok) throw domainError(response.status);
  const body = (await response.json()) as { data?: unknown };
  return body.data ?? body;
}

async function postContent(
  path: string,
  run: RunRecord,
  env: RuntimeEnv,
  signal: AbortSignal | undefined,
  payload: unknown,
): Promise<void> {
  const response = await runtimeInternalFetch('ai.content')(contentApiUrl(path, env), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${await serviceToken(run, env)}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw domainError(response.status);
}

function domainError(status: number): Error {
  return Object.assign(new Error(`content-service HTTP ${status}`), {
    retryable: status >= 500 || status === 429 || status === 409,
  });
}
