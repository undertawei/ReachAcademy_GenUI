import { runtimeInternalFetch } from './internal-fetch-observability.js';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';

import type { RunRecord } from './contracts.js';
import { resolveContentBaseUrl, resolveStudentBaseUrl, type RuntimeEnv } from './env.js';

export class DomainServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    // Transport failures (status 0): the undici cause code, e.g. UND_ERR_SOCKET or ECONNRESET.
    // `String(error)` of a failed fetch is only "TypeError: fetch failed".
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = 'DomainServiceError';
  }
}

function transportCauseCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown; name?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : cause?.name;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : undefined;
}

function apiUrl(base: string, path: string): string {
  return `${base}${base.endsWith('/api/v1') ? '' : '/api/v1'}${path}`;
}

export function contentApiUrl(path: string, env: RuntimeEnv = process.env): string {
  return apiUrl(resolveContentBaseUrl(env), path);
}

export function studentApiUrl(path: string, env: RuntimeEnv = process.env): string {
  return apiUrl(resolveStudentBaseUrl(env), path);
}

async function actorToken(
  run: RunRecord,
  env: RuntimeEnv,
  servicePrincipal = false,
): Promise<string> {
  const config = readHs256ServiceJwtConfig(env);
  return createHs256Token({
    secret: config.secret,
    subject: 'ai-runtime',
    actorId: run.actor.subject,
    issuer: config.issuer,
    audience: config.audience,
    expiresInSeconds: 5 * 60,
    roles: servicePrincipal
      ? [...new Set([...run.actor.roles, 'ai-runtime-service'])]
      : run.actor.roles,
    orgId: run.actor.orgId,
    extraClaims: {
      run_id: run.id,
      scene_id: run.sceneKey,
      ...(servicePrincipal ? { token_type: 'service' } : {}),
      ...(run.actor.billingGroupId ? { billing_group_id: run.actor.billingGroupId } : {}),
      ...(run.actor.roleGrantId ? { role_grant_id: run.actor.roleGrantId } : {}),
    },
  });
}

export async function domainServiceGet(
  url: string,
  run: RunRecord,
  options: { env?: RuntimeEnv; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  return domainRequest(url, run, { ...options, method: 'GET', servicePrincipal: true });
}

export async function domainPost(
  url: string,
  run: RunRecord,
  body: unknown,
  options: { env?: RuntimeEnv; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  return domainRequest(url, run, {
    ...options,
    body,
    method: 'POST',
    servicePrincipal: true,
  });
}

export async function domainGet(
  url: string,
  run: RunRecord,
  options: { env?: RuntimeEnv; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  return domainRequest(url, run, { ...options, method: 'GET', servicePrincipal: false });
}

async function domainRequest(
  url: string,
  run: RunRecord,
  options: {
    body?: unknown;
    env?: RuntimeEnv;
    fetchImpl?: typeof fetch;
    method: 'GET' | 'POST';
    servicePrincipal: boolean;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await runtimeInternalFetch(
      url.startsWith(resolveStudentBaseUrl(env)) ? 'ai.student' : 'ai.content',
      fetchImpl,
    )(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${await actorToken(run, env, options.servicePrincipal)}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      method: options.method,
      signal: options.signal,
    });
  } catch (error) {
    throw new DomainServiceError(
      `Domain service request failed: ${String(error)}`,
      0,
      true,
      transportCauseCode(error),
    );
  }
  if (!response.ok) {
    throw new DomainServiceError(
      `Domain service returned HTTP ${response.status}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
  const body = (await response.json()) as unknown;
  if (typeof body === 'object' && body !== null && 'code' in body && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}
