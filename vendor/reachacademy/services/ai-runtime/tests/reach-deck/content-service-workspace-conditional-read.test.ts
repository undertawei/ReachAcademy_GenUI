import { createHash } from 'node:crypto';
import { createGenerationWorkspace } from '@reachany/reach-deck-dsl';

import { renderHttpMetrics } from '@reachany/observability/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContentServiceClientError,
  ContentServiceTransportError,
  createReachDeckWorkspace,
  getReachDeckWorkspace,
  getReachDeckWorkspaceReadProjection,
  putReachDeckWorkspace,
  putReachDeckWorkspaceRecovery,
} from '../../lib/reach-deck/content-service-client.js';
import {
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  type ReachDeckLessonPlanJobPayload,
} from '../../lib/reach-deck/contracts.js';
import { buildStagedGenerationRequestHash } from '../../lib/reach-deck/job-identity.js';
import * as jobIdentity from '../../lib/reach-deck/job-identity.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import {
  emptyReachDeckWorkspaceRecovery,
  loadReachDeckWorkspaceRecovery,
  loadReachDeckWorkspaceReadSnapshot,
  registerReachDeckWorkspaceJob,
  serializeReachDeckWorkspaceRecovery,
  storeReachDeckWorkspaceJobResult,
} from '../../lib/reach-deck/workspace-recovery.js';
import {
  decodeWorkspaceResourceCacheEntry,
  resetWorkspaceResourceCacheForTests,
  workspaceResourceCache,
} from '../../lib/reach-deck/workspace-resource-cache.js';
import {
  TEST_REACH_DECK_RESOURCE_SCOPE,
  TEST_REACH_DECK_SCOPE,
} from './fixtures/resource-scope.js';

const resourceScope = TEST_REACH_DECK_RESOURCE_SCOPE;
const env = {
  REACHANY_CONTENT_BASE_URL: 'https://content.example.test',
  REACHANY_SERVICE_JWT_SECRET: 'content-client-test-secret-at-least-32-bytes',
  REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
};
const WORKSPACE_PATH =
  `/api/v1/reach-deck/courses/${resourceScope.courseId}/nodes/` +
  `${resourceScope.courseNodeId}/workspace`;

function options(fetchMock: typeof fetch) {
  return { ...TEST_REACH_DECK_SCOPE, env, fetch: fetchMock };
}

interface RecordedRequest {
  method: string;
  path: string;
  ifNoneMatch: string | null;
  prefer: string | null;
  status: number;
}

interface FakeContentServiceOptions {
  /** `false` 模拟旧版 content-service：不返回 ETag，忽略 `If-None-Match` 与 `Prefer`。 */
  conditional?: boolean;
}

/**
 * 按设计文档「协议」一节实现的内存版 content-service workspace 接口。
 *
 * 文档以 JSON 文本保存，等价于「请求体经存储往返后原样读回」。
 */
function createFakeContentService(fakeOptions: FakeContentServiceOptions = {}) {
  const conditional = fakeOptions.conditional ?? true;
  const state = {
    exists: true,
    draftRevision: 3,
    recoveryRevision: 1,
    workspace: JSON.stringify({ documentId: resourceScope.moduleVersionId, pages: [{ id: 'p1' }] }),
    recovery: JSON.stringify({
      schemaVersion: 'reach-deck-workspace-recovery/v2',
      jobs: {},
      results: {},
    }),
    materializedAt: null as string | null,
    createdAt: '2026-07-21T00:00:00Z',
    updatedAt: '2026-07-21T00:01:00Z',
  };
  const requests: RecordedRequest[] = [];
  /** 请求到达并生成响应之后、响应交还给客户端之前执行。 */
  const hooks: { beforeDeliver?: (request: RecordedRequest) => void | Promise<void> } = {};
  /** 下一次请求强制返回的响应（用于模拟异常状态）。 */
  const forced: Array<(request: RecordedRequest) => Response> = [];
  let clock = Date.parse('2026-07-21T00:02:00Z');

  const etag = () =>
    '"' +
    createHash('sha256')
      .update(
        [
          'workspace-document-id',
          resourceScope.organizationId,
          resourceScope.courseId,
          resourceScope.courseWorkspaceType,
          resourceScope.courseNodeId,
          resourceScope.moduleId,
          resourceScope.moduleVersionId,
          state.draftRevision,
          state.recoveryRevision,
          state.materializedAt === null ? '-' : Date.parse(state.materializedAt),
          Date.parse(state.createdAt),
          Date.parse(state.updatedAt),
        ].join('\n'),
      )
      .digest('hex')
      .slice(0, 32) +
    '"';
  const version = () => ({
    ...resourceScope,
    draftRevision: state.draftRevision,
    recoveryRevision: state.recoveryRevision,
    materializedAt: state.materializedAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  });
  const whole = () => ({
    ...version(),
    workspace: JSON.parse(state.workspace) as unknown,
    recovery: JSON.parse(state.recovery) as unknown,
  });
  const json = (data: unknown, headers: Record<string, string> = {}) =>
    Response.json(
      { code: 0, message: 'ok', data },
      { headers: conditional ? { etag: etag(), ...headers } : {} },
    );
  const touch = () => {
    clock += 1_000;
    state.updatedAt = new Date(clock).toISOString();
  };
  const conflict = (message: string) => Response.json({ code: 409, message }, { status: 409 });

  function respond(request: RecordedRequest, body: Record<string, unknown>): Response {
    const override = forced.shift();
    if (override !== undefined) return override(request);
    if (request.path === WORKSPACE_PATH && request.method === 'GET') {
      if (!state.exists) {
        return Response.json({ code: 404, message: 'workspace not found' }, { status: 404 });
      }
      if (conditional && request.ifNoneMatch === etag()) {
        return new Response(null, { status: 304, headers: { etag: etag() } });
      }
      return json(whole());
    }
    if (request.path === WORKSPACE_PATH && request.method === 'POST') {
      if (state.exists) return conflict('workspace already exists');
      Object.assign(state, {
        exists: true,
        draftRevision: 0,
        recoveryRevision: 0,
        workspace: JSON.stringify(body.workspace),
        recovery: JSON.stringify(body.recovery),
        materializedAt: null,
      });
      touch();
      state.createdAt = state.updatedAt;
      return json(whole());
    }
    if (request.path === WORKSPACE_PATH && request.method === 'PUT') {
      if (body.expectedDraftRevision !== state.draftRevision) {
        return conflict('Reach Deck draft revision conflict');
      }
      state.workspace = JSON.stringify(body.workspace);
      state.draftRevision += 1;
      touch();
      return json(whole());
    }
    if (request.path === WORKSPACE_PATH + '/recovery' && request.method === 'PUT') {
      if (body.expectedRecoveryRevision !== state.recoveryRevision) {
        return conflict('Reach Deck recovery revision conflict');
      }
      state.recovery = JSON.stringify(body.recovery);
      state.recoveryRevision += 1;
      touch();
      return conditional && request.prefer === 'return=minimal'
        ? json(version(), { 'preference-applied': 'return=minimal' })
        : json(whole());
    }
    return Response.json({ code: 404, message: 'unknown route' }, { status: 404 });
  }

  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: new URL(String(url)).pathname,
      ifNoneMatch: headers.get('if-none-match'),
      prefer: headers.get('prefer'),
      status: 0,
    };
    const response = respond(
      request,
      init?.body === undefined || init.body === null
        ? {}
        : (JSON.parse(String(init.body)) as Record<string, unknown>),
    );
    request.status = response.status;
    requests.push(request);
    await hooks.beforeDeliver?.(request);
    return response;
  });

  return {
    state,
    requests,
    hooks,
    forced,
    etag,
    whole,
    touch,
    options: () => options(fetchMock as typeof fetch),
    /** 模拟其他进程改写草稿。 */
    writeDraftElsewhere(workspace: unknown) {
      state.workspace = JSON.stringify(workspace);
      state.draftRevision += 1;
      touch();
    },
  };
}

const EDGE_RECOVERY = {
  schemaVersion: 'reach-deck-workspace-recovery/v2',
  jobs: {},
  results: {},
  nullValue: null,
  emptyObject: {},
  emptyArray: [],
  integer: 7,
  negativeInteger: -3,
  decimal: 0.1,
  largeNumber: 1e21,
  smallNumber: 1.5e-7,
  text: '讲稿 "引号" \\ 反斜杠',
  nested: { list: [null, {}, [], 0, 1.25, 'x', { deep: [null] }] },
  dropped: undefined,
};

describe('validated read projections over authorized conditional requests', () => {
  beforeEach(() => resetWorkspaceResourceCacheForTests());
  const key = Symbol('test-read-model');

  it('returns successful 200 and 304 reads when the projection cannot be serialized', async () => {
    const server = createFakeContentService();
    const value = { unsupported: () => 'validated result' };
    const parse = vi.fn(() => value);
    for (let index = 0; index < 3; index++) {
      await expect(
        getReachDeckWorkspaceReadProjection(server.options(), { key, parse }),
      ).resolves.toBe(value);
      expect(workspaceResourceCache().get(resourceScope)).toBeDefined();
    }
    expect(server.requests.map((request) => request.status)).toEqual([200, 304, 304]);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('validates once on 200/304, calls the service on every read and isolates mutations', async () => {
    const server = createFakeContentService();
    const parse = vi.fn((resource: Awaited<ReturnType<typeof getReachDeckWorkspace>>) => ({
      scope: resource.moduleVersionId,
      workspace: resource.workspace,
      missing: undefined,
    }));
    const projection = { key, parse };
    const first = await getReachDeckWorkspaceReadProjection(server.options(), projection);
    first.workspace.pages = [];
    const second = await getReachDeckWorkspaceReadProjection(server.options(), projection);
    expect(second.workspace.pages).toEqual([{ id: 'p1' }]);
    expect(second).toHaveProperty('missing', undefined);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(server.requests.map((r) => r.status)).toEqual([200, 304]);
    server.forced.push(() =>
      Response.json({ code: 403, message: 'grant revoked' }, { status: 403 }),
    );
    await expect(
      getReachDeckWorkspaceReadProjection(server.options(), projection),
    ).rejects.toMatchObject({ status: 403 });
    expect(server.requests).toHaveLength(3);
    expect(workspaceResourceCache().get(resourceScope)).toBeUndefined();
  });

  it('revalidates a new 200, including one with an unchanged ETag, and rejects invalid data', async () => {
    const server = createFakeContentService();
    const parse = vi.fn((resource: Awaited<ReturnType<typeof getReachDeckWorkspace>>) => {
      if (resource.workspace.invalid) throw new Error('invalid stored data');
      return resource.workspace;
    });
    const projection = { key, parse };
    await getReachDeckWorkspaceReadProjection(server.options(), projection);
    server.forced.push(() =>
      Response.json({ code: 0, data: server.whole() }, { headers: { etag: server.etag() } }),
    );
    await getReachDeckWorkspaceReadProjection(server.options(), projection);
    expect(parse).toHaveBeenCalledTimes(2);
    server.writeDraftElsewhere({ invalid: true });
    await expect(getReachDeckWorkspaceReadProjection(server.options(), projection)).rejects.toThrow(
      'invalid stored data',
    );
    expect(parse).toHaveBeenCalledTimes(3);
    expect(workspaceResourceCache().get(resourceScope)).toBeUndefined();
  });

  it('does not reuse across scope, or suppress ordinary raw reads and recovery writes', async () => {
    const server = createFakeContentService();
    const parse = vi.fn(
      (resource: Awaited<ReturnType<typeof getReachDeckWorkspace>>) => resource.recoveryRevision,
    );
    const projection = { key, parse };
    expect(await getReachDeckWorkspaceReadProjection(server.options(), projection)).toBe(1);
    const raw = await getReachDeckWorkspace(server.options());
    expect(raw.recoveryRevision).toBe(1);
    await putReachDeckWorkspaceRecovery(raw.recovery, 1, server.options());
    expect(await getReachDeckWorkspaceReadProjection(server.options(), projection)).toBe(2);
    expect(parse).toHaveBeenCalledTimes(2);
    await expect(
      getReachDeckWorkspaceReadProjection(
        {
          ...server.options(),
          resourceScope: {
            ...resourceScope,
            moduleVersionId: '66666666-6666-4666-8666-666666666666',
          },
        },
        projection,
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(server.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'PUT', 'GET', 'GET']);
  });

  it('validates every response from a server without ETags', async () => {
    const server = createFakeContentService({ conditional: false });
    const parse = vi.fn(
      (resource: Awaited<ReturnType<typeof getReachDeckWorkspace>>) => resource.workspace,
    );
    await getReachDeckWorkspaceReadProjection(server.options(), { key, parse });
    await getReachDeckWorkspaceReadProjection(server.options(), { key, parse });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(server.requests.map((r) => r.status)).toEqual([200, 200]);
  });

  it('binds a delayed 304 to its original entry when another read installs a new response', async () => {
    const server = createFakeContentService();
    const parse = vi.fn(
      (resource: Awaited<ReturnType<typeof getReachDeckWorkspace>>) => resource.workspace,
    );
    const projection = { key, parse };
    await getReachDeckWorkspaceReadProjection(server.options(), projection);
    let release!: () => void;
    let arrived!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    server.hooks.beforeDeliver = async (request) => {
      if (request.status !== 304) return;
      arrived();
      await pending;
    };
    const oldRead = getReachDeckWorkspaceReadProjection(server.options(), projection);
    await started;
    server.writeDraftElsewhere({
      documentId: resourceScope.moduleVersionId,
      pages: [{ id: 'p2' }],
    });
    expect((await getReachDeckWorkspaceReadProjection(server.options(), projection)).pages).toEqual(
      [{ id: 'p2' }],
    );
    server.hooks.beforeDeliver = undefined;
    release();
    expect((await oldRead).pages).toEqual([{ id: 'p1' }]);
    expect((await getReachDeckWorkspaceReadProjection(server.options(), projection)).pages).toEqual(
      [{ id: 'p2' }],
    );
    // The retired source falls back to raw decoding, without retaining an orphan projection.
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('validates a cached raw response on the first projection miss before reusing it', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    const parse = vi.fn(
      (resource: Awaited<ReturnType<typeof getReachDeckWorkspace>>) => resource.recovery,
    );
    await getReachDeckWorkspaceReadProjection(server.options(), { key, parse });
    await getReachDeckWorkspaceReadProjection(server.options(), { key, parse });
    expect(server.requests.map((r) => r.status)).toEqual([200, 304, 304]);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe('Reach Deck workspace conditional read', () => {
  beforeEach(() => {
    resetWorkspaceResourceCacheForTests();
  });

  it('caches the first 200 and answers an unchanged read from a 304 with an unshared object', async () => {
    const server = createFakeContentService();

    const first = await getReachDeckWorkspace(server.options());
    const second = await getReachDeckWorkspace(server.options());

    expect(server.requests).toMatchObject([
      { method: 'GET', ifNoneMatch: null, status: 200 },
      { method: 'GET', ifNoneMatch: server.etag(), status: 304 },
    ]);
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    expect(second.workspace).not.toBe(first.workspace);
    expect(second.recovery).not.toBe(first.recovery);
    expect(first).toStrictEqual({
      ...resourceScope,
      draftRevision: 3,
      workspace: { documentId: resourceScope.moduleVersionId, pages: [{ id: 'p1' }] },
      recoveryRevision: 1,
      recovery: { schemaVersion: 'reach-deck-workspace-recovery/v2', jobs: {}, results: {} },
      materializedAt: undefined,
      createdAt: '2026-07-21T00:00:00Z',
      updatedAt: '2026-07-21T00:01:00Z',
    });
    const entry = workspaceResourceCache().get(resourceScope)!;
    expect(entry.etag).toBe(server.etag());
    expect(decodeWorkspaceResourceCacheEntry(entry)).toEqual(server.whole());
  });

  it('never lets a caller mutation leak into later reads', async () => {
    const server = createFakeContentService();
    const pristine = structuredClone(await getReachDeckWorkspace(server.options()));

    const fromFull = await getReachDeckWorkspace(server.options());
    (fromFull.workspace.pages as unknown[]).push({ id: 'mutated' });
    fromFull.recovery.jobs = { mutated: true };
    fromFull.draftRevision = 99;
    const fromCache = await getReachDeckWorkspace(server.options());
    (fromCache.workspace.pages as unknown[]).length = 0;
    delete fromCache.recovery.schemaVersion;

    expect(await getReachDeckWorkspace(server.options())).toStrictEqual(pristine);
    expect(server.requests.map((request) => request.status)).toEqual([200, 304, 304, 304]);
  });

  it('does not cache a response without an ETag, matching the previous behaviour', async () => {
    const server = createFakeContentService({ conditional: false });

    const first = await getReachDeckWorkspace(server.options());
    const second = await getReachDeckWorkspace(server.options());

    expect(server.requests).toMatchObject([
      { ifNoneMatch: null, status: 200 },
      { ifNoneMatch: null, status: 200 },
    ]);
    expect(second).toStrictEqual(first);
    expect(workspaceResourceCache().size).toBe(0);
  });

  it('ignores a malformed ETag instead of echoing it back', async () => {
    const server = createFakeContentService();
    server.forced.push(() =>
      Response.json({ code: 0, data: server.whole() }, { headers: { etag: 'not-quoted' } }),
    );

    await getReachDeckWorkspace(server.options());
    await getReachDeckWorkspace(server.options());

    expect(server.requests[1]).toMatchObject({ ifNoneMatch: null, status: 200 });
  });

  it('refetches the whole resource once the document changes', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    const staleEtag = server.etag();
    server.writeDraftElsewhere({ documentId: resourceScope.moduleVersionId, pages: [] });

    const changed = await getReachDeckWorkspace(server.options());
    await getReachDeckWorkspace(server.options());

    expect(changed).toMatchObject({ draftRevision: 4, workspace: { pages: [] } });
    expect(server.requests.slice(1)).toMatchObject([
      { ifNoneMatch: staleEtag, status: 200 },
      { ifNoneMatch: server.etag(), status: 304 },
    ]);
  });

  it.each([
    { status: 500, retryable: true },
    { status: 404, retryable: false },
    { status: 409, retryable: true },
    { status: 429, retryable: true },
  ])(
    'clears the entry on a $status read and keeps the previous error semantics',
    async ({ status, retryable }) => {
      const failure = () => Response.json({ code: status, message: 'read failed' }, { status });
      const uncached = createFakeContentService();
      uncached.forced.push(failure);
      const expected = await getReachDeckWorkspace(uncached.options()).catch(
        (error: unknown) => error,
      );

      const server = createFakeContentService();
      await getReachDeckWorkspace(server.options());
      server.forced.push(failure);
      const actual = await getReachDeckWorkspace(server.options()).catch((error: unknown) => error);

      expect(actual).toBeInstanceOf(ContentServiceClientError);
      expect(actual).toMatchObject({ message: 'read failed', status, retryable });
      expect(actual).toStrictEqual(expected);
      expect(workspaceResourceCache().get(resourceScope)).toBe(undefined);
      await getReachDeckWorkspace(server.options());
      expect(server.requests.at(-1)).toMatchObject({ ifNoneMatch: null, status: 200 });
    },
  );

  it('keeps the default failure message when the error body is not JSON', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.forced.push(() => new Response('gateway down', { status: 503 }));

    await expect(getReachDeckWorkspace(server.options())).rejects.toMatchObject({
      name: 'ContentServiceClientError',
      message: `content-service GET ${WORKSPACE_PATH.replace('/api/v1', '')} failed with 503`,
      status: 503,
      retryable: true,
    });
    expect(workspaceResourceCache().size).toBe(0);
  });

  it('clears the entry when a 200 body fails validation', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.forced.push(() =>
      Response.json(
        { code: 0, data: { ...server.whole(), moduleVersionId: crypto.randomUUID() } },
        { headers: { etag: '"drifted"' } },
      ),
    );

    await expect(getReachDeckWorkspace(server.options())).rejects.toMatchObject({
      message: 'content-service returned the wrong Reach Deck UUID scope',
      status: 502,
    });
    expect(workspaceResourceCache().size).toBe(0);
  });

  it('keeps the entry across a transport failure, which carries no status', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.hooks.beforeDeliver = () => {
      throw new TypeError('fetch failed');
    };

    await expect(getReachDeckWorkspace(server.options())).rejects.toBeInstanceOf(
      ContentServiceTransportError,
    );
    server.hooks.beforeDeliver = undefined;
    await getReachDeckWorkspace(server.options());

    expect(server.requests.at(-1)).toMatchObject({ ifNoneMatch: server.etag(), status: 304 });
  });

  it('answers a 304 from the entry taken before the request even if it was evicted meanwhile', async () => {
    const server = createFakeContentService();
    const first = await getReachDeckWorkspace(server.options());
    server.hooks.beforeDeliver = () => resetWorkspaceResourceCacheForTests();

    const second = await getReachDeckWorkspace(server.options());

    expect(server.requests[1]).toMatchObject({ ifNoneMatch: server.etag(), status: 304 });
    expect(second).toStrictEqual(first);
    // 304 不回写缓存：被淘汰的条目不会复活，下一次读取是无条件请求。
    expect(workspaceResourceCache().size).toBe(0);
    server.hooks.beforeDeliver = undefined;
    await getReachDeckWorkspace(server.options());
    expect(server.requests[2]).toMatchObject({ ifNoneMatch: null, status: 200 });
  });

  it('retries once without the conditional header when a 304 arrives with no local entry', async () => {
    const server = createFakeContentService();
    server.forced.push(() => new Response(null, { status: 304, headers: { etag: server.etag() } }));

    const resource = await getReachDeckWorkspace(server.options());

    expect(server.requests).toMatchObject([
      { ifNoneMatch: null, status: 304 },
      { ifNoneMatch: null, status: 200 },
    ]);
    expect(resource).toMatchObject({ draftRevision: 3, recoveryRevision: 1 });
    expect(workspaceResourceCache().get(resourceScope)?.etag).toBe(server.etag());
  });

  it('fails with the ordinary status error when the unconditional retry is a 304 again', async () => {
    const server = createFakeContentService();
    const notModified = () => new Response(null, { status: 304 });
    server.forced.push(notModified, notModified);

    await expect(getReachDeckWorkspace(server.options())).rejects.toMatchObject({
      name: 'ContentServiceClientError',
      status: 304,
      retryable: false,
    });
    expect(server.requests).toHaveLength(2);
  });

  it('lets a late older response overwrite a newer pair without ever returning wrong data', async () => {
    const server = createFakeContentService();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.hooks.beforeDeliver = () => held;
    // 较早的读取：服务端已按旧版本生成响应，但响应迟迟没有送达。
    const slowOlderRead = getReachDeckWorkspace(server.options());
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    const olderEtag = server.etag();

    server.hooks.beforeDeliver = undefined;
    server.writeDraftElsewhere({ documentId: resourceScope.moduleVersionId, pages: ['new'] });
    const newer = await getReachDeckWorkspace(server.options());
    expect(workspaceResourceCache().get(resourceScope)?.etag).toBe(server.etag());

    release();
    const older = await slowOlderRead;
    // 旧的 (etag, body) 原子对后写入，覆盖了较新的一对。
    expect(older).toMatchObject({ draftRevision: 3, workspace: { pages: [{ id: 'p1' }] } });
    expect(workspaceResourceCache().get(resourceScope)?.etag).toBe(olderEtag);

    // 服务端以 ETag 权威判定：旧对只会换来一次 200，而不是把旧正文当作当前版本。
    const afterwards = await getReachDeckWorkspace(server.options());
    expect(server.requests.at(-1)).toMatchObject({ ifNoneMatch: olderEtag, status: 200 });
    expect(afterwards).toStrictEqual(newer);
    expect(await getReachDeckWorkspace(server.options())).toStrictEqual(newer);
    expect(server.requests.at(-1)).toMatchObject({ ifNoneMatch: server.etag(), status: 304 });
  });

  it('keeps concurrent reads of one scope independent', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());

    const results = await Promise.all(
      Array.from({ length: 4 }, () => getReachDeckWorkspace(server.options())),
    );

    expect(server.requests.slice(1).map((request) => request.status)).toEqual([304, 304, 304, 304]);
    expect(new Set(results.map((result) => result.workspace)).size).toBe(4);
    for (const result of results) expect(result).toStrictEqual(results[0]);
  });

  it('does not record a 304 as a failed downstream request', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    await getReachDeckWorkspace(server.options());

    const notModified = (await renderHttpMetrics()).body
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('reach_downstream_requests_seconds_count') &&
          line.includes('operation="ai.content"') &&
          line.includes('status="304"'),
      );
    expect(notModified).toHaveLength(1);
    expect(notModified[0]).toContain('error_type="none"');
  });
});

describe('Reach Deck whole workspace writes', () => {
  beforeEach(() => {
    resetWorkspaceResourceCacheForTests();
  });

  it('backfills the cache from a whole PUT response and never asks for a minimal one', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    const nextWorkspace = { documentId: resourceScope.moduleVersionId, pages: [{ id: 'p2' }] };

    const saved = await putReachDeckWorkspace(nextWorkspace, 3, server.options());
    nextWorkspace.pages.push({ id: 'mutated-after-save' });
    (saved.workspace.pages as unknown[]).push({ id: 'mutated-result' });
    const read = await getReachDeckWorkspace(server.options());

    expect(server.requests.slice(1)).toMatchObject([
      { method: 'PUT', prefer: null, ifNoneMatch: null, status: 200 },
      { method: 'GET', ifNoneMatch: server.etag(), status: 304 },
    ]);
    expect(read).toMatchObject({ draftRevision: 4, workspace: { pages: [{ id: 'p2' }] } });
    expect(read).toStrictEqual({
      ...saved,
      workspace: { ...saved.workspace, pages: [{ id: 'p2' }] },
    });
  });

  it('backfills the cache from a whole POST response', async () => {
    const server = createFakeContentService();
    server.state.exists = false;

    const created = await createReachDeckWorkspace(
      { documentId: resourceScope.moduleVersionId },
      { schemaVersion: 'reach-deck-workspace-recovery/v2', jobs: {}, results: {} },
      server.options(),
    );
    const read = await getReachDeckWorkspace(server.options());

    expect(server.requests).toMatchObject([
      { method: 'POST', prefer: null, status: 200 },
      { method: 'GET', ifNoneMatch: server.etag(), status: 304 },
    ]);
    expect(read).toStrictEqual(created);
    expect(created).toMatchObject({ draftRevision: 0, recoveryRevision: 0 });
  });

  it('leaves no entry behind when a whole write response carries no ETag', async () => {
    const modern = createFakeContentService();
    await getReachDeckWorkspace(modern.options());
    const legacy = createFakeContentService({ conditional: false });

    await putReachDeckWorkspace({ documentId: resourceScope.moduleVersionId }, 3, legacy.options());

    expect(workspaceResourceCache().size).toBe(0);
  });

  it('clears the entry on a 409 draft conflict and keeps the conflict error', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());

    const error = await putReachDeckWorkspace({}, 2, server.options()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ContentServiceClientError);
    expect(error).toMatchObject({
      message: 'Reach Deck draft revision conflict',
      status: 409,
      retryable: true,
    });
    expect(workspaceResourceCache().size).toBe(0);
  });

  it('clears the entry when a write fails in transport', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.hooks.beforeDeliver = () => {
      throw new TypeError('socket hang up');
    };

    await expect(putReachDeckWorkspace({}, 3, server.options())).rejects.toBeInstanceOf(
      ContentServiceTransportError,
    );
    await expect(
      putReachDeckWorkspaceRecovery({ schemaVersion: 'x' }, 1, server.options()),
    ).rejects.toBeInstanceOf(ContentServiceTransportError);

    expect(workspaceResourceCache().size).toBe(0);
  });
});

describe('Reach Deck recovery write-back', () => {
  beforeEach(() => {
    resetWorkspaceResourceCacheForTests();
  });

  it('recomposes the whole resource from a minimal response and refills the cache', async () => {
    const server = createFakeContentService();
    const before = await getReachDeckWorkspace(server.options());
    const recovery = structuredClone(EDGE_RECOVERY);

    const saved = await putReachDeckWorkspaceRecovery(recovery, 1, server.options());
    // 调用方随后修改入参或返回值，都不能影响缓存。
    recovery.nested.list.length = 0;
    (saved.recovery.nested as { list: unknown[] }).list.length = 0;
    const read = await getReachDeckWorkspace(server.options());

    expect(server.requests.slice(1)).toMatchObject([
      { method: 'PUT', prefer: 'return=minimal', ifNoneMatch: null, status: 200 },
      { method: 'GET', ifNoneMatch: server.etag(), status: 304 },
    ]);
    const expectedRecovery = JSON.parse(JSON.stringify(EDGE_RECOVERY)) as Record<string, unknown>;
    expect(read).toStrictEqual({
      ...before,
      recoveryRevision: 2,
      recovery: expectedRecovery,
      updatedAt: server.state.updatedAt,
    });
    expect(saved).toStrictEqual({
      ...read,
      recovery: { ...expectedRecovery, nested: { list: [] } },
    });
    expect('dropped' in read.recovery).toBe(false);
    expect(read.recovery.nullValue).toBe(null);
  });

  it('parses a recomposed resource exactly like a whole response with the same content', async () => {
    const run = async (server: ReturnType<typeof createFakeContentService>) => {
      resetWorkspaceResourceCacheForTests();
      server.state.workspace = JSON.stringify({
        documentId: resourceScope.moduleVersionId,
        nothing: null,
        emptyObject: {},
        emptyArray: [],
        count: 12,
        ratio: 0.3333,
        pages: [{ id: 'p1', bounds: { x: 0, y: -1.5, width: 1280, height: 720.25 } }],
      });
      server.state.materializedAt = '2026-07-21T00:00:30Z';
      await getReachDeckWorkspace(server.options());
      const firstWrite = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options());
      const secondWrite = await putReachDeckWorkspaceRecovery(
        { ...EDGE_RECOVERY, integer: 8, emptyArray: [[]] },
        2,
        server.options(),
      );
      const read = await getReachDeckWorkspace(server.options());
      return { firstWrite, secondWrite, read };
    };

    const modern = createFakeContentService();
    const recomposed = await run(modern);
    const legacy = createFakeContentService({ conditional: false });
    const whole = await run(legacy);

    expect(modern.requests.map(({ method, prefer, status }) => [method, prefer, status])).toEqual([
      ['GET', null, 200],
      ['PUT', 'return=minimal', 200],
      ['PUT', 'return=minimal', 200],
      ['GET', null, 304],
    ]);
    expect(legacy.requests.map(({ method, prefer, status }) => [method, prefer, status])).toEqual([
      ['GET', null, 200],
      ['PUT', null, 200],
      ['PUT', null, 200],
      ['GET', null, 200],
    ]);
    expect(recomposed).toStrictEqual(whole);
    expect(recomposed.read).toMatchObject({
      recoveryRevision: 3,
      materializedAt: '2026-07-21T00:00:30Z',
      workspace: { nothing: null, emptyObject: {}, emptyArray: [], count: 12, ratio: 0.3333 },
      recovery: { nullValue: null, emptyObject: {}, emptyArray: [[]], integer: 8, decimal: 0.1 },
    });
  });

  it('falls back to a whole read when the minimal response reports another draft revision', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    const staleEtag = server.etag();
    const concurrentWorkspace = { documentId: resourceScope.moduleVersionId, pages: ['other'] };
    server.writeDraftElsewhere(concurrentWorkspace);

    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options());

    expect(server.requests.slice(1)).toMatchObject([
      { method: 'PUT', prefer: 'return=minimal', status: 200 },
      // 条目已清掉，所以是无条件读取，不会带着旧 ETag。
      { method: 'GET', ifNoneMatch: null, status: 200 },
    ]);
    expect(staleEtag).not.toBe(server.etag());
    expect(saved).toStrictEqual({
      ...resourceScope,
      draftRevision: 4,
      workspace: concurrentWorkspace,
      recoveryRevision: 2,
      recovery: JSON.parse(JSON.stringify(EDGE_RECOVERY)),
      materializedAt: undefined,
      createdAt: server.state.createdAt,
      updatedAt: server.state.updatedAt,
    });
    // 回退读取拿到的是服务端的整份响应，缓存与服务端一致。
    await getReachDeckWorkspace(server.options());
    expect(server.requests.at(-1)).toMatchObject({ ifNoneMatch: server.etag(), status: 304 });
  });

  it('keeps the written recovery when the fallback read already sees a later recovery', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.writeDraftElsewhere({ documentId: resourceScope.moduleVersionId, pages: ['other'] });
    server.hooks.beforeDeliver = (request) => {
      if (request.method !== 'PUT') return;
      // 本次写入提交之后、回退读取之前，另一个进程又写了一次 recovery。
      server.state.recovery = JSON.stringify({ schemaVersion: 'later', jobs: { later: true } });
      server.state.recoveryRevision += 1;
      server.touch();
    };

    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options());

    expect(saved).toMatchObject({
      draftRevision: 4,
      workspace: { pages: ['other'] },
      recoveryRevision: 2,
      recovery: { integer: 7 },
    });
    expect(server.state.recoveryRevision).toBe(3);
  });

  it('falls back to a whole read when the document was recreated with another createdAt', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.state.createdAt = '2026-07-22T00:00:00Z';
    server.state.workspace = JSON.stringify({ documentId: resourceScope.moduleVersionId });

    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options());

    expect(server.requests.slice(1)).toMatchObject([
      { method: 'PUT', prefer: 'return=minimal', status: 200 },
      { method: 'GET', ifNoneMatch: null, status: 200 },
    ]);
    expect(saved).toMatchObject({
      draftRevision: 3,
      createdAt: '2026-07-22T00:00:00Z',
      workspace: { documentId: resourceScope.moduleVersionId },
      recoveryRevision: 2,
    });
    expect(saved.workspace).not.toHaveProperty('pages');
  });

  it('compares createdAt as an instant, like the ETag does, not as text', async () => {
    const server = createFakeContentService();
    // 同一时刻的两种写法：整份响应带毫秒小数，瘦身响应不带。
    server.state.createdAt = '2026-07-21T00:00:00.000Z';
    await getReachDeckWorkspace(server.options());
    server.state.createdAt = '2026-07-21T00:00:00Z';

    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options());

    expect(server.requests.slice(1)).toMatchObject([
      { method: 'PUT', prefer: 'return=minimal', status: 200 },
    ]);
    expect(saved).toMatchObject({ recoveryRevision: 2, createdAt: '2026-07-21T00:00:00Z' });
  });

  it('surfaces a failed fallback read after the recovery has been written', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.writeDraftElsewhere({ documentId: resourceScope.moduleVersionId });
    server.hooks.beforeDeliver = (request) => {
      if (request.method === 'PUT') {
        server.forced.push(() => Response.json({ message: 'busy' }, { status: 503 }));
      }
    };

    await expect(
      putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options()),
    ).rejects.toMatchObject({ status: 503, retryable: true });
    expect(server.state.recoveryRevision).toBe(2);
    expect(workspaceResourceCache().size).toBe(0);
  });

  it('treats the response as whole when an older content-service ignores Prefer', async () => {
    const modern = createFakeContentService();
    await getReachDeckWorkspace(modern.options());
    // 滚动发布混跑：缓存来自新版副本，写入落到不认识 `Prefer` 的旧版副本。
    const legacy = createFakeContentService({ conditional: false });

    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, legacy.options());

    expect(legacy.requests).toMatchObject([
      { method: 'PUT', prefer: 'return=minimal', status: 200 },
    ]);
    expect(saved).toStrictEqual({
      ...resourceScope,
      draftRevision: 3,
      workspace: JSON.parse(legacy.state.workspace),
      recoveryRevision: 2,
      recovery: JSON.parse(JSON.stringify(EDGE_RECOVERY)),
      materializedAt: undefined,
      createdAt: legacy.state.createdAt,
      updatedAt: legacy.state.updatedAt,
    });
    // 整份响应没有 ETag，旧条目不再保留。
    expect(workspaceResourceCache().size).toBe(0);
  });

  it('backfills the cache from a whole recovery response that carries an ETag', async () => {
    const server = createFakeContentService();

    // 没有缓存条目，不发 Prefer；服务端返回带 ETag 的整份响应。
    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options());
    const read = await getReachDeckWorkspace(server.options());

    expect(server.requests).toMatchObject([
      { method: 'PUT', prefer: null, status: 200 },
      { method: 'GET', ifNoneMatch: server.etag(), status: 304 },
    ]);
    expect(read).toStrictEqual(saved);
  });

  it('does not ask for a minimal response when the cached recoveryRevision differs', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    // 其他进程推进了 recovery；调用方从别处得知了新的期望版本，缓存条目仍是旧版本。
    server.state.recoveryRevision = 5;
    server.touch();

    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 5, server.options());

    expect(server.requests[1]).toMatchObject({ method: 'PUT', prefer: null, status: 200 });
    expect(saved).toMatchObject({ recoveryRevision: 6, recovery: { integer: 7 } });
    expect(workspaceResourceCache().get(resourceScope)?.etag).toBe(server.etag());
  });

  it('clears the entry on a 409 recovery conflict and keeps the conflict error', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.state.recoveryRevision = 2;
    server.touch();

    const error = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options()).catch(
      (caught: unknown) => caught,
    );

    expect(server.requests[1]).toMatchObject({ prefer: 'return=minimal', status: 409 });
    expect(error).toBeInstanceOf(ContentServiceClientError);
    expect(error).toMatchObject({
      message: 'Reach Deck recovery revision conflict',
      status: 409,
      retryable: true,
    });
    expect(workspaceResourceCache().size).toBe(0);
    await getReachDeckWorkspace(server.options());
    expect(server.requests.at(-1)).toMatchObject({ ifNoneMatch: null, status: 200 });
  });

  it('clears the entry when a minimal response carries no ETag', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    const minimal = { ...server.whole(), recoveryRevision: 2, workspace: null, recovery: null };
    server.forced.push(() =>
      Response.json(
        { code: 0, data: minimal },
        { headers: { 'Preference-Applied': 'respond-async, return=minimal' } },
      ),
    );

    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options());

    // 版本字段之外的 workspace / recovery 一律取自缓存与请求体，不取自瘦身响应。
    expect(saved).toMatchObject({
      recoveryRevision: 2,
      workspace: { pages: [{ id: 'p1' }] },
      recovery: { integer: 7 },
    });
    expect(workspaceResourceCache().size).toBe(0);
  });

  it('rejects a minimal response that lacks the version fields', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.forced.push(() =>
      Response.json(
        {
          code: 0,
          data: { ...resourceScope, draftRevision: 3, createdAt: server.state.createdAt },
        },
        { headers: { 'preference-applied': 'return=minimal', etag: '"x"' } },
      ),
    );

    await expect(
      putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options()),
    ).rejects.toMatchObject({ name: 'ContentServiceClientError', status: 502 });
    expect(workspaceResourceCache().size).toBe(0);
  });

  it('never caches a recomposed resource for a non-contiguous recovery revision', async () => {
    const server = createFakeContentService();
    await getReachDeckWorkspace(server.options());
    server.forced.push(() =>
      Response.json(
        {
          code: 0,
          data: { ...server.whole(), recoveryRevision: 3, workspace: null, recovery: null },
        },
        { headers: { 'preference-applied': 'return=minimal', etag: '"skipped"' } },
      ),
    );

    const saved = await putReachDeckWorkspaceRecovery(EDGE_RECOVERY, 1, server.options());

    // 版本不连续时不重组进缓存：回退到整份读取，连续性由调用方按返回的 recoveryRevision 判定。
    expect(server.requests.slice(1)).toMatchObject([
      { method: 'PUT', prefer: 'return=minimal', status: 200 },
      { method: 'GET', ifNoneMatch: null, status: 200 },
    ]);
    expect(saved.recoveryRevision).toBe(3);
    const reread = await getReachDeckWorkspace(server.options());
    expect(server.requests.at(-1)).toMatchObject({ ifNoneMatch: server.etag(), status: 304 });
    expect(reread).toMatchObject({ recoveryRevision: 1, recovery: { jobs: {}, results: {} } });
  });

  it('recomposes from the literal minimal body that content-service is tested to emit', async () => {
    const server = createFakeContentService();
    Object.assign(server.state, {
      draftRevision: 4,
      recoveryRevision: 9,
      createdAt: '2026-10-09T01:00:00.123Z',
    });
    await getReachDeckWorkspace(server.options());
    // 与 Java `ReachDeckInternalControllerHttpTest` 断言的 minimal `data` 逐字段同形（键顺序、
    // 毫秒精度的时间、显式的 `materializedAt: null`），只把范围 ID 换成本测试的资源范围。
    const literal =
      '{"code":0,"message":"ok","data":{' +
      `"organizationId":"${resourceScope.organizationId}",` +
      `"courseId":"${resourceScope.courseId}",` +
      `"courseWorkspaceType":"${resourceScope.courseWorkspaceType}",` +
      `"courseNodeId":"${resourceScope.courseNodeId}",` +
      `"moduleId":"${resourceScope.moduleId}",` +
      `"moduleVersionId":"${resourceScope.moduleVersionId}",` +
      '"draftRevision":4,"recoveryRevision":10,"materializedAt":null,' +
      '"createdAt":"2026-10-09T01:00:00.123Z","updatedAt":"2026-10-09T02:00:00.456Z"}}';
    server.forced.push(
      () =>
        new Response(literal, {
          headers: {
            'content-type': 'application/json',
            'Preference-Applied': 'return=minimal',
            ETag: '"0123456789abcdef0123456789abcdef"',
          },
        }),
    );

    const saved = await putReachDeckWorkspaceRecovery(
      { jobs: 2, cancelledAt: null, pages: [], meta: {} },
      9,
      server.options(),
    );

    expect(server.requests).toHaveLength(2);
    expect(saved).toEqual({
      ...resourceScope,
      draftRevision: 4,
      recoveryRevision: 10,
      workspace: { documentId: resourceScope.moduleVersionId, pages: [{ id: 'p1' }] },
      recovery: { jobs: 2, cancelledAt: null, pages: [], meta: {} },
      materializedAt: undefined,
      createdAt: '2026-10-09T01:00:00.123Z',
      updatedAt: '2026-10-09T02:00:00.456Z',
    });
    expect(workspaceResourceCache().get(resourceScope)?.etag).toBe(
      '"0123456789abcdef0123456789abcdef"',
    );
  });
});

describe('Reach Deck recovery transition over the conditional client', () => {
  const payload = (jobId: string): ReachDeckLessonPlanJobPayload => {
    const request = { source: 'Teacher source', prompt: jobId };
    return {
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      kind: 'lesson-plan',
      jobId,
      ...TEST_REACH_DECK_SCOPE,
      runId: 'run-1',
      createdFromDraftRevision: 3,
      requestHash: buildStagedGenerationRequestHash(request),
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      request,
    };
  };

  async function registerTwoJobs(server: ReturnType<typeof createFakeContentService>) {
    resetWorkspaceResourceCacheForTests();
    server.state.recovery = JSON.stringify(
      serializeReachDeckWorkspaceRecovery(emptyReachDeckWorkspaceRecovery()),
    );
    vi.stubGlobal('fetch', server.options().fetch);
    const first = await registerReachDeckWorkspaceJob(payload('rdj-conditional-1'));
    const second = await registerReachDeckWorkspaceJob(payload('rdj-conditional-2'));
    const loaded = await loadReachDeckWorkspaceRecovery(TEST_REACH_DECK_SCOPE);
    return { first, second, loaded };
  }

  beforeEach(() => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    // 描述符里的 queuedAt 取自系统时钟；只冻结 Date，CAS 退避用的定时器保持真实。
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-21T00:05:00Z') });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps full recovery validation on changed polling responses, including stored result hashes', async () => {
    const server = createFakeContentService();
    server.state.workspace = JSON.stringify(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: resourceScope.moduleVersionId,
        source: 'Source',
        createdAt: '2026-07-21T00:00:00Z',
      }),
    );
    server.state.recovery = JSON.stringify(
      serializeReachDeckWorkspaceRecovery(emptyReachDeckWorkspaceRecovery()),
    );
    vi.stubGlobal('fetch', server.options().fetch);
    const jobId = 'rdj-conditional-invalid-hash';
    await registerReachDeckWorkspaceJob(payload(jobId));
    await storeReachDeckWorkspaceJobResult(payload(jobId), {
      kind: 'lesson-plan',
      runId: 'run-1',
      generatedFromDraftRevision: 3,
      candidate: {
        id: 'plan-1',
        title: 'Systems',
        audience: 'Grade 8',
        durationMinutes: 45,
        learningObjectives: ['Explain a system'],
        teachingStrategy: 'Model and practice',
        keyTerms: ['system'],
        narrative: 'Move from explanation to application.',
      },
    });
    const hashes = vi.spyOn(jobIdentity, 'buildStagedGenerationRequestHash');
    const first = await loadReachDeckWorkspaceReadSnapshot(TEST_REACH_DECK_SCOPE);
    const initialHashes = hashes.mock.calls.length;
    expect(initialHashes).toBeGreaterThan(0);
    const second = await loadReachDeckWorkspaceReadSnapshot(TEST_REACH_DECK_SCOPE);
    expect(hashes).toHaveBeenCalledTimes(initialHashes);
    expect(second).toStrictEqual(first);
    expect(second.resource.workspace).not.toBe(first.resource.workspace);
    const corrupted = JSON.parse(server.state.recovery);
    const artifactRef = `result:${jobId}`;
    corrupted.jobs[jobId].artifactRef = artifactRef;
    corrupted.results[artifactRef] = {
      jobId,
      requestHash: payload(jobId).requestHash,
      resultHash: 'a'.repeat(64),
      storedAt: '2026-07-21T00:05:00Z',
      result: { tampered: true },
    };
    server.state.recovery = JSON.stringify(corrupted);
    server.state.recoveryRevision += 1;
    server.touch();
    await expect(loadReachDeckWorkspaceReadSnapshot(TEST_REACH_DECK_SCOPE)).rejects.toThrow(
      'content hash is invalid',
    );
  });

  it('returns the same recovery resource whether the write-back is minimal or whole', async () => {
    const modern = createFakeContentService();
    const recomposed = await registerTwoJobs(modern);
    const legacy = createFakeContentService({ conditional: false });
    const whole = await registerTwoJobs(legacy);

    expect(modern.requests.map(({ method, prefer, status }) => [method, prefer, status])).toEqual([
      ['GET', null, 200],
      ['PUT', 'return=minimal', 200],
      ['GET', null, 304],
      ['PUT', 'return=minimal', 200],
      ['GET', null, 304],
    ]);
    expect(legacy.requests.map(({ method, prefer }) => [method, prefer])).toEqual([
      ['GET', null],
      ['PUT', null],
      ['GET', null],
      ['PUT', null],
      ['GET', null],
    ]);
    expect(recomposed).toStrictEqual(whole);
    expect(recomposed.second).toMatchObject({
      recoveryRevision: 3,
      workspaceBytes: new TextEncoder().encode(modern.state.workspace).byteLength,
    });
    expect(Object.keys(recomposed.loaded.recovery.jobs)).toEqual([
      'rdj-conditional-1',
      'rdj-conditional-2',
    ]);
    expect(recomposed.loaded).toStrictEqual(recomposed.second);
  });

  it('retries a recovery CAS conflict with a fresh unconditional read', async () => {
    const server = createFakeContentService();
    server.state.recovery = JSON.stringify(
      serializeReachDeckWorkspaceRecovery(emptyReachDeckWorkspaceRecovery()),
    );
    vi.stubGlobal('fetch', server.options().fetch);
    let raced = false;
    server.hooks.beforeDeliver = (request) => {
      if (request.method !== 'GET' || raced) return;
      // 读取之后、写入之前，另一个进程推进了 recovery 版本。
      raced = true;
      server.state.recoveryRevision += 1;
      server.touch();
    };

    const saved = await registerReachDeckWorkspaceJob(payload('rdj-conditional-conflict'));

    expect(
      server.requests.map(({ method, ifNoneMatch, prefer, status }) => [
        method,
        ifNoneMatch === null ? null : 'conditional',
        prefer,
        status,
      ]),
    ).toEqual([
      ['GET', null, null, 200],
      ['PUT', null, 'return=minimal', 409],
      ['GET', null, null, 200],
      ['PUT', null, 'return=minimal', 200],
    ]);
    expect(saved.recoveryRevision).toBe(3);
    expect(saved.recovery.jobs['rdj-conditional-conflict']).toMatchObject({ kind: 'lesson-plan' });
  });
});
