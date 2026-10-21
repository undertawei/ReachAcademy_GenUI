import { runtimeInternalFetch } from '../internal-fetch-observability.js';
import { createHash } from 'node:crypto';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import type { RunRecord } from '../contracts.js';
import { contentApiUrl } from '../domain-client.js';
import type { RuntimeEnv } from '../env.js';
import { wordImportInput } from './input.js';

export interface WordImportSourceTicket {
  source: {
    assetId: string;
    courseId: string;
    courseNodeId: string;
    moduleId: string;
    moduleVersionId: string;
    sizeBytes: number;
    sha256: string;
    status: string;
    contentType: string;
    filename: string;
  };
  downloadUrl: string;
  expiresInSeconds: number;
  applied: boolean;
  paperId: string;
  paperIdentityContract?: 'quiz-paper-identity/v1';
}

export class WordImportTargetUnavailableError extends Error {
  constructor() {
    super('word-import.target-unavailable');
    this.name = 'WordImportTargetUnavailableError';
  }
}

export function isWordImportTargetUnavailableError(
  error: unknown,
): error is WordImportTargetUnavailableError {
  return error instanceof WordImportTargetUnavailableError;
}

export async function wordImportContentRequest(
  run: RunRecord,
  scope: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
  persistedHistoricalRun = false,
): Promise<unknown> {
  const input = wordImportInput(run);
  if (!run.actor.roleGrantId) throw new Error('word-import.role-grant-required');
  const config = readHs256ServiceJwtConfig(env);
  const token = await createHs256Token({
    secret: config.secret,
    issuer: config.issuer,
    audience: config.audience,
    subject: 'ai-runtime',
    actorId: run.actor.subject,
    orgId: run.actor.orgId,
    roles: ['ai-runtime-service'],
    expiresInSeconds: 60,
    extraClaims: {
      token_type: 'service',
      scene_id: run.sceneKey,
      scope,
      run_id: run.id,
      source_asset_id: input.sourceAssetId,
      course_id: input.courseId,
      course_node_id: input.courseNodeId,
      module_id: input.moduleId,
      module_version_id: input.moduleVersionId,
      paper_id: input.paperId,
      ...(input.paperIdentityContract
        ? { paper_identity_contract: input.paperIdentityContract }
        : {}),
      ...(persistedHistoricalRun ? { word_import_run_persisted: true } : {}),
      role_grant_id: run.actor.roleGrantId,
      organization_id: run.actor.orgId,
      actor_account_id: run.actor.subject,
    },
  });
  const requestUrl = contentApiUrl(path, env);
  const response = await runtimeInternalFetch('ai.content')(requestUrl, {
    method: init.method,
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    if (await isTrustedTargetUnavailableResponse(response, requestUrl))
      throw new WordImportTargetUnavailableError();
    throw new Error(`word-import.content-${response.status}`);
  }
  const body = (await response.json()) as { data?: unknown };
  if (body.data === undefined) throw new Error('word-import.invalid-content-response');
  return body.data;
}

export async function readWordImportSourceTicket(
  run: RunRecord,
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
  persistedHistoricalRun = false,
): Promise<WordImportSourceTicket> {
  const input = wordImportInput(run);
  const query = new URLSearchParams({
    courseId: input.courseId,
    courseNodeId: input.courseNodeId,
    moduleId: input.moduleId,
    moduleVersionId: input.moduleVersionId,
    paperId: input.paperId,
    ...(input.paperIdentityContract ? { paperIdentityContract: input.paperIdentityContract } : {}),
  });
  const value = (await wordImportContentRequest(
    run,
    'content.quiz.word-import.source.read',
    `/quiz/word-import/internal/runs/${run.id}/sources/${input.sourceAssetId}/ticket?${query}`,
    { method: 'GET' },
    env,
    signal,
    persistedHistoricalRun,
  )) as WordImportSourceTicket;
  if (
    !value?.source ||
    value.source.assetId !== input.sourceAssetId ||
    value.source.sha256 !== input.sourceSha256 ||
    value.source.courseId !== input.courseId ||
    value.source.courseNodeId !== input.courseNodeId ||
    value.source.moduleId !== input.moduleId ||
    value.source.moduleVersionId !== input.moduleVersionId ||
    value.paperId !== input.paperId ||
    (input.paperIdentityContract === undefined
      ? Object.prototype.hasOwnProperty.call(value, 'paperIdentityContract')
      : value.paperIdentityContract !== input.paperIdentityContract) ||
    value.source.status !== 'available' ||
    typeof value.applied !== 'boolean' ||
    !Number.isSafeInteger(value.source.sizeBytes) ||
    value.source.sizeBytes <= 0 ||
    value.source.sizeBytes > 25 * 1024 * 1024 ||
    typeof value.downloadUrl !== 'string'
  )
    throw new Error('word-import.source-binding-mismatch');
  return value;
}

export async function downloadWordImportSource(
  run: RunRecord,
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const ticket = await readWordImportSourceTicket(run, env, signal, true);
  const url = new URL(ticket.downloadUrl);
  if (url.protocol !== 'https:') throw new Error('word-import.invalid-source-url');
  const response = await fetch(url, {
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) throw new Error('word-import.source-download-failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > ticket.source.sizeBytes) throw new Error('word-import.source-size-mismatch');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (
    total !== ticket.source.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== ticket.source.sha256
  )
    throw new Error('word-import.source-checksum-mismatch');
  return bytes;
}

async function isTrustedTargetUnavailableResponse(
  response: Response,
  requestUrl: string,
): Promise<boolean> {
  if (
    response.status !== 404 ||
    response.headers.get('content-type')?.trim().toLowerCase() !== 'application/json' ||
    !response.url
  )
    return false;
  try {
    if (new URL(response.url).origin !== new URL(requestUrl).origin) return false;
  } catch {
    return false;
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 4096) return false;
  let body: Uint8Array;
  try {
    body = await readBoundedResponse(response.body, 4096);
  } catch {
    return false;
  }
  let value: unknown;
  try {
    value = parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (!exactKeys(envelope, ['code', 'message', 'data', 'requestId'])) return false;
  if (
    envelope.code !== 404 ||
    typeof envelope.message !== 'string' ||
    typeof envelope.requestId !== 'string' ||
    !envelope.data ||
    typeof envelope.data !== 'object' ||
    Array.isArray(envelope.data)
  )
    return false;
  const data = envelope.data as Record<string, unknown>;
  return exactKeys(data, ['error']) && data.error === 'word-import.target-unavailable';
}

async function readBoundedResponse(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('response-too-large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, size);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function parseJsonWithoutDuplicateKeys(source: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (/[\u0020\u0009\u000a\u000d]/.test(source[offset] ?? '')) offset++;
  };
  const string = (): string => {
    if (source[offset] !== '"') throw new Error('invalid-json');
    const start = offset++;
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset++]!;
      if (!escaped && character === '"') return JSON.parse(source.slice(start, offset)) as string;
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
    }
    throw new Error('invalid-json');
  };
  const value = (): unknown => {
    whitespace();
    if (source[offset] === '{') {
      offset++;
      const result: Record<string, unknown> = {};
      const seen = new Set<string>();
      whitespace();
      if (source[offset] === '}') {
        offset++;
        return result;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (seen.has(key)) throw new Error('duplicate-json-key');
        seen.add(key);
        whitespace();
        if (source[offset++] !== ':') throw new Error('invalid-json');
        result[key] = value();
        whitespace();
        const separator = source[offset++];
        if (separator === '}') return result;
        if (separator !== ',') throw new Error('invalid-json');
      }
    }
    if (source[offset] === '[') {
      offset++;
      const result: unknown[] = [];
      whitespace();
      if (source[offset] === ']') {
        offset++;
        return result;
      }
      for (;;) {
        result.push(value());
        whitespace();
        const separator = source[offset++];
        if (separator === ']') return result;
        if (separator !== ',') throw new Error('invalid-json');
      }
    }
    if (source[offset] === '"') return string();
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      source.slice(offset),
    );
    if (!match) throw new Error('invalid-json');
    offset += match[0].length;
    return JSON.parse(match[0]) as unknown;
  };
  const parsed = value();
  whitespace();
  if (offset !== source.length) throw new Error('invalid-json');
  return parsed;
}
