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

export interface SrlReportAttachment {
  objectKey: string;
  name?: string;
  contentType?: string;
  sizeBytes?: number;
  downloadUrl?: string;
}

export interface SrlReportBundle {
  reportId: string;
  attemptId: string;
  guidance: {
    moduleKey: string;
    title: string;
    versionId: string;
    content: unknown;
  };
  report: {
    content: unknown;
    attachments: SrlReportAttachment[];
  };
}

export interface SrlFeedforwardContext {
  reportId: string;
  organizationId: string;
  generationRunId: string;
}

export interface SrlFeedforwardContentPort {
  fetchBundle(context: SrlFeedforwardContext): Promise<SrlReportBundle>;
  startRun(context: SrlFeedforwardContext): Promise<void>;
  completeRun(
    context: SrlFeedforwardContext,
    payload: {
      feedback: { format: 'markdown'; content: string; source: 'agent' };
      agentMeta: { model: string; promptSha256: string };
    },
  ): Promise<void>;
  failRun(context: SrlFeedforwardContext, errorSummary: string): Promise<void>;
  notifyFailure(context: SrlFeedforwardContext, errorSummary: string): Promise<void>;
}

export interface SrlFeedforwardWorkflowPorts {
  content: SrlFeedforwardContentPort;
  attachmentDependencies: AttachmentIngestionDependencies;
}

export function createSrlFeedforwardWorkflowPorts(
  run: RunRecord,
  env: RuntimeEnv,
  signal?: AbortSignal,
): SrlFeedforwardWorkflowPorts {
  const content: SrlFeedforwardContentPort = {
    fetchBundle: async (context) =>
      normalizeSrlReportBundle(
        await requestContent(`/srl/internal/reports/${context.reportId}/bundle`, run, env, signal),
        context,
      ),
    startRun: (context) =>
      postContent(
        `/srl/internal/reports/${context.reportId}/feedforward/runs/${context.generationRunId}/start`,
        run,
        env,
        signal,
      ),
    completeRun: (context, payload) =>
      postContent(
        `/srl/internal/reports/${context.reportId}/feedforward/runs/${context.generationRunId}/complete`,
        run,
        env,
        signal,
        payload,
      ),
    failRun: (context, errorSummary) =>
      postContent(
        `/srl/internal/reports/${context.reportId}/feedforward/runs/${context.generationRunId}/failure`,
        run,
        env,
        signal,
        { errorSummary },
      ),
    notifyFailure: (context, errorSummary) =>
      postContent(
        `/srl/internal/reports/${context.reportId}/feedforward/runs/${context.generationRunId}/failure`,
        run,
        env,
        signal,
        { errorSummary },
      ),
  };
  return {
    content,
    attachmentDependencies: createAttachmentIngestionDependencies({
      extractPdf: (input) => extractPdf(input, run),
      transcribeAudio: (input) => transcribeAudio(input, run),
      understandAudio: (input) => understandMedia(input, run, 'audio'),
      understandVideo: (input) => understandMedia(input, run, 'video'),
    }),
  };
}

export function normalizeSrlReportBundle(
  value: unknown,
  context: Pick<SrlFeedforwardContext, 'reportId' | 'organizationId'>,
): SrlReportBundle {
  const bundle = record(value, 'SRL bundle');
  const reportId = string(bundle.reportId, 'SRL bundle.reportId');
  if (reportId !== context.reportId) throw new Error('SRL bundle reportId does not match the Run');
  const guidance = record(bundle.guidance, 'SRL bundle.guidance');
  const report = record(bundle.report, 'SRL bundle.report');
  const attachments = Array.isArray(report.attachments) ? report.attachments : [];
  return {
    reportId,
    attemptId: string(bundle.attemptId, 'SRL bundle.attemptId'),
    guidance: {
      moduleKey: string(guidance.moduleKey, 'SRL bundle.guidance.moduleKey'),
      title: string(guidance.title, 'SRL bundle.guidance.title'),
      versionId: string(guidance.versionId, 'SRL bundle.guidance.versionId'),
      content: guidance.content,
    },
    report: {
      content: report.content,
      attachments: attachments.map((entry, index) => normalizeAttachment(entry, index)),
    },
  };
}

function normalizeAttachment(value: unknown, index: number): SrlReportAttachment {
  const attachment = record(value, `SRL bundle.report.attachments[${index}]`);
  return {
    objectKey: string(attachment.objectKey, `SRL attachment ${index}.objectKey`),
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
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${path} must be a string`);
  return value;
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
  if (!response.ok) {
    throw Object.assign(new Error(`content-service HTTP ${response.status}`), {
      retryable: response.status >= 500 || response.status === 429 || response.status === 409,
    });
  }
  const body = (await response.json()) as { data?: unknown };
  return body.data ?? body;
}

async function postContent(
  path: string,
  run: RunRecord,
  env: RuntimeEnv,
  signal?: AbortSignal,
  payload?: unknown,
): Promise<void> {
  const response = await runtimeInternalFetch('ai.content')(contentApiUrl(path, env), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${await serviceToken(run, env)}`,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error(`content-service HTTP ${response.status}`), {
      retryable: response.status >= 500 || response.status === 429 || response.status === 409,
    });
  }
}
