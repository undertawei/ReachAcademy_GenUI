import { modelExecutionClaims } from '../model-execution-contract.js';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import { GuardrailError, guardrailCode } from '@reachany/ai-runtime-feedforward';
import { inspectMediaFile, transcodeVideoToH264 } from '@reachany/ai-runtime-common/file-ingestion';

import type { RunRecord } from '../contracts.js';
import { contentApiUrl } from '../domain-client.js';
import type { RuntimeEnv } from '../env.js';
import { resolveModelServiceBaseUrl } from '../env.js';
import type {
  VideoProcessingBundle,
  VideoProcessingPorts,
  VideoProcessingStateRequest,
  VideoSubtitleCue,
} from './workflow.js';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const ASR_HTTP_TIMEOUT_MS = 30_000;
const RETRYABLE = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/** Runtime-owned HTTP/filesystem boundary for the course.video.processing Scene. */
export function createVideoProcessingPorts(
  run: RunRecord,
  draftModuleVersionId: string,
  env: RuntimeEnv,
  fetchImpl: typeof fetch = fetch,
): VideoProcessingPorts {
  let expectedVideoObjectKey: string | undefined;
  let bundleLoaded = false;
  return {
    content: {
      fetchBundle: async () => {
        const bundle = (await contentRequest(
          `/video/internal/module-versions/${draftModuleVersionId}/processing-bundle`,
          run,
          env,
          fetchImpl,
        )) as VideoProcessingBundle;
        if (
          bundleLoaded &&
          expectedVideoObjectKey &&
          bundle.videoObjectKey !== expectedVideoObjectKey
        ) {
          throw new Error('video processing source changed while refreshing the bundle');
        }
        expectedVideoObjectKey = bundle.videoObjectKey;
        bundleLoaded = true;
        return bundle;
      },
      recordState: async (request: VideoProcessingStateRequest) => {
        if (!bundleLoaded) throw new Error('video processing bundle has not been loaded');
        await contentRequest(
          `/video/internal/module-versions/${draftModuleVersionId}/processing-state`,
          run,
          env,
          fetchImpl,
          { ...request, ...(expectedVideoObjectKey ? { expectedVideoObjectKey } : {}) },
        );
        if (request.videoObjectKey) expectedVideoObjectKey = request.videoObjectKey;
      },
      requestTranscodeTarget: async (sizeBytes: number) => {
        const body = (await contentRequest(
          `/video/internal/module-versions/${draftModuleVersionId}/transcode-target`,
          run,
          env,
          fetchImpl,
          { sizeBytes },
        )) as { objectKey?: unknown; uploadUrl?: unknown };
        if (typeof body.objectKey !== 'string' || typeof body.uploadUrl !== 'string') {
          throw new Error('content-service transcode target response is incomplete');
        }
        return { objectKey: body.objectKey, uploadUrl: body.uploadUrl };
      },
    },
    media: {
      download: (url, maxBytes) => downloadToTemp(url, maxBytes, fetchImpl),
      inspect: inspectMediaFile,
      transcodeToH264: transcodeVideoToH264,
      upload: (filePath, uploadUrl) => uploadFromFile(filePath, uploadUrl, fetchImpl),
      allocateTempFile: allocateTempOutput,
    },
    asr: {
      submit: async ({ mediaUrl, clientToken }) => {
        const body = await modelRequest(run, env, fetchImpl, '/v1/video/subtitle-tasks', {
          method: 'POST',
          payload: { mediaUrl, clientToken },
        });
        const taskId = (body as { taskId?: unknown }).taskId;
        if (typeof taskId !== 'string' || taskId.length === 0) {
          throw new Error('model-service subtitle submit response is missing taskId');
        }
        return { taskId };
      },
      query: async (taskId) => {
        const body = (await modelRequest(
          run,
          env,
          fetchImpl,
          `/v1/video/subtitle-tasks/${encodeURIComponent(taskId)}`,
          { method: 'GET' },
        )) as { status?: unknown; cues?: unknown; failureCode?: unknown };
        const status = body.status;
        if (status !== 'running' && status !== 'completed' && status !== 'failed') {
          throw Object.assign(new Error('model-service subtitle status is invalid'), {
            retryable: true,
          });
        }
        return {
          status,
          ...(Array.isArray(body.cues) ? { cues: body.cues as VideoSubtitleCue[] } : {}),
          ...(typeof body.failureCode === 'string' ? { failureCode: body.failureCode } : {}),
        };
      },
    },
  };
}

/** content-service 服务间令牌：ai-runtime-service 角色 + scene_id（镜像 feedforward workflow-adapter）。 */
async function contentToken(run: RunRecord, env: RuntimeEnv): Promise<string> {
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
    extraClaims: {
      token_type: 'service',
      run_id: run.id,
      scene_id: run.sceneKey,
    },
  });
}

/** model-service 服务间令牌：model-service:delegate + scene_id + organization_id 双写。 */
async function modelToken(run: RunRecord, env: RuntimeEnv): Promise<string> {
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
    },
  });
}

async function contentRequest(
  path: string,
  run: RunRecord,
  env: RuntimeEnv,
  fetchImpl: typeof fetch,
  payload?: unknown,
): Promise<unknown> {
  const response = await fetchImpl(contentApiUrl(path, env), {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${await contentToken(run, env)}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`content-service HTTP ${response.status}`), {
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  const body = (await response.json().catch(() => ({}))) as { data?: unknown };
  return body.data ?? body;
}

async function modelRequest(
  run: RunRecord,
  env: RuntimeEnv,
  fetchImpl: typeof fetch,
  path: string,
  options: { method: 'GET' | 'POST'; payload?: unknown },
): Promise<unknown> {
  const base = resolveModelServiceBaseUrl(env).replace(/\/api\/v1$/, '');
  let response: Response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      method: options.method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${await modelToken(run, env)}`,
        'x-reachany-invocation': JSON.stringify({
          scene_id: run.sceneKey,
          orchestration: 'courseware.transcript',
          stage: 'subtitle-transcription',
          tool: 'speech-recognition',
          channel: 'speech-recognition',
        }),
        ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
      signal: AbortSignal.timeout(ASR_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    const code = guardrailCode(error);
    if (code) throw new GuardrailError(code);
    throw Object.assign(new Error(`model-service request failed: ${String(error)}`), {
      retryable: true,
    });
  }
  if (!response.ok) {
    const code = guardrailCode(await response.text());
    if (code) throw new GuardrailError(code);
    throw Object.assign(new Error(`model-service HTTP ${response.status}`), {
      retryable: RETRYABLE(response.status),
    });
  }
  const body = (await response.json()) as { data?: unknown };
  return body.data ?? body;
}

/** 分配转码输出临时文件路径；cleanup 由调用方负责。 */
async function allocateTempOutput(
  suffix: string,
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const directory = join(
    tmpdir(),
    'reachany-ai-runtime-video',
    `${Date.now()}-${globalThis.crypto.randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  return {
    filePath: join(directory, `output${suffix}`),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** 转码产物 PUT 回预签名 OSS URL（content-type 与签名一致）。 */
async function uploadFromFile(
  filePath: string,
  uploadUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const body = await readFile(filePath);
  const response = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4', 'content-length': String(body.byteLength) },
    body,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`transcoded upload HTTP ${response.status}`), {
      retryable: response.status >= 500 || response.status === 429,
    });
  }
}

/** 下载签名 URL 到 temp 文件（字节上限 + 超时），返回 cleanup 由调用方负责。 */
async function downloadToTemp(
  url: string,
  maxBytes: number,
  fetchImpl: typeof fetch,
): Promise<{ filePath: string; bytes: number; cleanup: () => Promise<void> }> {
  const directory = join(
    tmpdir(),
    'reachany-ai-runtime-video',
    `${Date.now()}-${globalThis.crypto.randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, 'source.mp4');
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`video download HTTP ${response.status}`), {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    if (response.body === null) throw new Error('video download response has no body');
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw Object.assign(new Error('video download exceeds the size bound'), {
        sizeBoundExceeded: true,
      });
    }
    const handle = await open(filePath, 'wx');
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes + value.byteLength > maxBytes) {
          await reader.cancel();
          throw Object.assign(new Error('video download exceeds the size bound'), {
            sizeBoundExceeded: true,
          });
        }
        await handle.write(value);
        bytes += value.byteLength;
      }
    } finally {
      reader.releaseLock();
      await handle.close();
    }
    return { filePath, bytes, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}
