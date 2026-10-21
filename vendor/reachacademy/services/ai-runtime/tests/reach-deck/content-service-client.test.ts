import { verifyHs256Token } from '@reachany/auth';
import { describe, expect, it, vi } from 'vitest';

import {
  createReachDeckGenerationAudit,
  findReachDeckGeneratedMedia,
  getReachDeckGenerationAudit,
  getReachDeckWorkspace,
  materializeReachDeckModule,
  publishReachDeckModule,
  putReachDeckWorkspace,
  putReachDeckWorkspaceRecovery,
  settleOrphanedReachDeckGenerationAudit,
  updateReachDeckGenerationAudit,
  resolveReachDeckMaterialAsset,
} from '../../lib/reach-deck/content-service-client.js';

const resourceScope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};
const env = {
  REACHANY_CONTENT_BASE_URL: 'https://content.example.test',
  REACHANY_SERVICE_JWT_SECRET: 'content-client-test-secret-at-least-32-bytes',
  REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
};

function options(fetchMock: typeof fetch) {
  return {
    actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    actorOrganizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    billingGroupId: null,
    roleGrantId: '99999999-9999-4999-8999-999999999999',
    resourceScope,
    env,
    fetch: fetchMock,
  };
}

function workspace(body: Record<string, unknown> = {}) {
  return {
    ...resourceScope,
    draftRevision: 3,
    workspace: { documentId: resourceScope.moduleVersionId },
    recoveryRevision: 1,
    recovery: { schemaVersion: 'reach-deck-workspace-recovery/v1', jobs: {}, results: {} },
    createdAt: '2026-07-21T00:00:00Z',
    updatedAt: '2026-07-21T00:01:00Z',
    ...body,
  };
}

describe('Reach Deck UUID content-service bridge', () => {
  it.each([undefined, 'https://signed.test/material.png'])(
    'reads optional authorized material download URL %s',
    async (downloadUrl) => {
      const fetchMock = vi.fn(async (_url: string | URL | Request) =>
        Response.json({
          code: 0,
          data: {
            assetId: 'material-1',
            objectKey: 'uploads/material.png',
            contentType: 'image/png',
            sizeBytes: 10,
            checksumSha256: 'a'.repeat(64),
            status: 'available',
            ...(downloadUrl === undefined ? {} : { downloadUrl }),
          },
        }),
      );
      const result = await resolveReachDeckMaterialAsset(
        'material-1',
        options(fetchMock as typeof fetch),
      );
      expect(result.downloadUrl).toBe(downloadUrl);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/material-assets?assetId=material-1');
    },
  );
  it('defaults a missing opaque recovery document to the v2-compatible empty shape', async () => {
    const fetchMock = vi.fn(async () => {
      const resource = workspace();
      delete (resource as { recovery?: unknown }).recovery;
      return Response.json({ code: 0, data: resource });
    });

    await expect(getReachDeckWorkspace(options(fetchMock as typeof fetch))).resolves.toMatchObject({
      recovery: {
        schemaVersion: 'reach-deck-workspace-recovery/v2',
        jobs: {},
        results: {},
        decksmithJobs: {},
        decksmithResults: {},
      },
    });
  });

  it('uses the course/node workspace family and signs the exact UUID scope', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      Response.json({ code: 0, data: workspace(JSON.parse(String(init?.body ?? '{}'))) }),
    );

    await getReachDeckWorkspace(options(fetchMock as typeof fetch));
    await putReachDeckWorkspace(
      { documentId: resourceScope.moduleVersionId },
      2,
      options(fetchMock as typeof fetch),
    );
    await putReachDeckWorkspaceRecovery(
      { schemaVersion: 'reach-deck-workspace-recovery/v1', jobs: {}, results: {} },
      0,
      options(fetchMock as typeof fetch),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://content.example.test/api/v1/reach-deck/courses/' +
        resourceScope.courseId +
        '/nodes/' +
        resourceScope.courseNodeId +
        '/workspace',
    );
    const token = new Headers(init.headers).get('authorization')!.replace('Bearer ', '');
    await expect(
      verifyHs256Token(token, {
        secret: env.REACHANY_SERVICE_JWT_SECRET,
        audience: env.REACHANY_SERVICE_JWT_AUDIENCE,
      }),
    ).resolves.toMatchObject({
      subject: 'ai-runtime',
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      roles: ['ai-runtime-service'],
      orgId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      extra: {
        token_type: 'service',
        scene_id: 'teacher.deck',
        billing_group_id: null,
        role_grant_id: '99999999-9999-4999-8999-999999999999',
        organization_id: resourceScope.organizationId,
        course_id: resourceScope.courseId,
        course_workspace_type: 'draft',
        course_node_id: resourceScope.courseNodeId,
        module_id: resourceScope.moduleId,
        module_version_id: resourceScope.moduleVersionId,
      },
    });
  });

  it('uses exact materialize and module-publication DTOs', async () => {
    const publishedModuleVersionId = '66666666-6666-4666-8666-666666666666';
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/materialize')) {
        expect(body).toEqual({
          learnerDocument: { id: resourceScope.moduleVersionId },
          expectedDraftRevision: 7,
        });
        return Response.json({
          code: 0,
          data: {
            ...resourceScope,
            mongodbDocumentId: resourceScope.moduleVersionId,
            draftRevision: 7,
            contentDigest: 'a'.repeat(64),
            materializedAt: '2026-07-21T00:02:00Z',
          },
        });
      }
      expect(String(url)).toContain('/module-publication');
      expect(body).toEqual({ expectedDraftRevision: 7, expectedContentDigest: 'a'.repeat(64) });
      return Response.json({
        code: 0,
        data: {
          ...resourceScope,
          publishedModuleVersionId,
          versionNo: 4,
          mongodbDocumentId: publishedModuleVersionId,
          contentDigest: 'a'.repeat(64),
          publishedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          publishedAt: '2026-07-21T00:03:00Z',
          published: true,
        },
      });
    });

    await expect(
      materializeReachDeckModule(
        { id: resourceScope.moduleVersionId },
        7,
        options(fetchMock as typeof fetch),
      ),
    ).resolves.toMatchObject({ mongodbDocumentId: resourceScope.moduleVersionId });
    await expect(
      publishReachDeckModule(7, 'a'.repeat(64), options(fetchMock as typeof fetch)),
    ).resolves.toMatchObject({ status: 'published', versionNo: 4 });
  });

  it('looks up an idempotent generated asset before provider work and treats 404 as absent', async () => {
    const found = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('media-request-1');
      return Response.json({
        code: 0,
        data: {
          objectKey: 'uploads/reach-deck/image-1',
          downloadUrl: 'https://oss.example/image-1',
          contentType: 'image/png',
          sizeBytes: 123,
          checksumSha256: 'a'.repeat(64),
        },
      });
    });

    await expect(
      findReachDeckGeneratedMedia(
        { kind: 'image', pageId: 'page-1', idempotencyKey: 'media-request-1' },
        options(found as typeof fetch),
      ),
    ).resolves.toMatchObject({ objectKey: 'uploads/reach-deck/image-1' });

    const missing = vi.fn(async () => Response.json({ error: 'missing' }, { status: 404 }));
    await expect(
      findReachDeckGeneratedMedia(
        { kind: 'speech', pageId: 'page-1', idempotencyKey: 'media-request-2' },
        options(missing as typeof fetch),
      ),
    ).resolves.toBeUndefined();
  });

  it('maps generation create, read, and running transitions to Java lifecycle endpoints', async () => {
    const requestHash = 'b'.repeat(64);
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      Response.json({
        code: 0,
        data: {
          id: 'job-1',
          jobId: 'job-1',
          actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          ...resourceScope,
          requestHash,
          status: 'queued',
          executionAttempt: 0,
          createdAt: '2026-07-21T00:00:00Z',
          updatedAt: '2026-07-21T00:00:00Z',
        },
      }),
    );
    const clientOptions = options(fetchMock as typeof fetch);

    await createReachDeckGenerationAudit(
      {
        jobId: 'job-1',
        runId: 'run-1',
        generationKind: 'lesson-plan',
        generationStage: 'lesson-plan',
        generationAttempt: 'initial',
        requestHash,
      },
      clientOptions,
    );
    await getReachDeckGenerationAudit('job-1', requestHash, clientOptions);
    await updateReachDeckGenerationAudit(
      'job-1',
      requestHash,
      { status: 'running' },
      clientOptions,
    ).catch(() => undefined);

    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls[0]).toContain('/generation-jobs');
    expect(calls[1]).toContain('/generation-jobs/job-1?requestHash=' + requestHash);
    expect(calls[2]).toContain('/generation-jobs/job-1/running');
  });

  it('settles an orphaned audit only at the version read by the stall proof', async () => {
    const requestHash = 'd'.repeat(64);
    const settled = (status: string) =>
      vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          code: 0,
          data: {
            id: 'job-1',
            jobId: 'job-1',
            actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            ...resourceScope,
            requestHash,
            status,
            executionAttempt: 2,
            createdAt: '2026-07-21T00:00:00Z',
            updatedAt: '2026-07-21T00:30:00.123Z',
          },
        }),
      );
    const failed = settled('failed');
    await settleOrphanedReachDeckGenerationAudit(
      'job-1',
      requestHash,
      {
        expectedStatus: 'retrying',
        expectedExecutionAttempt: 2,
        expectedUpdatedAt: '2026-07-21T00:10:00.456Z',
      },
      options(failed as typeof fetch),
    );
    const [url, init] = failed.mock.calls[0]!;
    expect(String(url)).toContain('/generation-jobs/job-1/settle-orphaned');
    expect(JSON.parse(String(init?.body))).toEqual({
      requestHash,
      expectedStatus: 'retrying',
      expectedExecutionAttempt: 2,
      expectedUpdatedAt: '2026-07-21T00:10:00.456Z',
      errorCode: 'generation_failed',
    });

    const aborted = settled('aborted');
    await settleOrphanedReachDeckGenerationAudit(
      'job-1',
      requestHash,
      {
        expectedStatus: 'queued',
        expectedExecutionAttempt: 2,
        expectedUpdatedAt: '2026-07-21T00:10:00.456Z',
      },
      options(aborted as typeof fetch),
    );
    expect(JSON.parse(String(aborted.mock.calls[0]![1]?.body))).toMatchObject({
      expectedStatus: 'queued',
      errorCode: 'cancelled',
    });

    // 服务端返回的终态与请求不符（例如旧服务把它当成别的转换）时拒绝接受。
    await expect(
      settleOrphanedReachDeckGenerationAudit(
        'job-1',
        requestHash,
        {
          expectedStatus: 'queued',
          expectedExecutionAttempt: 2,
          expectedUpdatedAt: '2026-07-21T00:10:00.456Z',
        },
        options(settled('failed') as typeof fetch),
      ),
    ).rejects.toMatchObject({ status: 502 });

    const conflict = vi.fn(async () =>
      Response.json(
        { code: 409, message: 'Reach Deck generation job state conflict' },
        { status: 409 },
      ),
    );
    await expect(
      settleOrphanedReachDeckGenerationAudit(
        'job-1',
        requestHash,
        {
          expectedStatus: 'running',
          expectedExecutionAttempt: 2,
          expectedUpdatedAt: '2026-07-21T00:10:00.456Z',
        },
        options(conflict as typeof fetch),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('separates current audit authorization from original same-actor owner metadata', async () => {
    const requestHash = 'c'.repeat(64);
    const fetchMock = vi.fn(async () =>
      Response.json({
        code: 0,
        data: {
          id: 'job-rotated-grant',
          jobId: 'job-rotated-grant',
          actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          ...resourceScope,
          requestHash,
          status: 'failed',
          executionAttempt: 1,
          createdAt: '2026-07-21T00:00:00Z',
          updatedAt: '2026-07-21T00:01:00Z',
        },
      }),
    );
    const currentAuthorization = {
      ...options(fetchMock as typeof fetch),
      billingGroupId: 'current-billing-group',
      roleGrantId: '88888888-8888-4888-8888-888888888888',
    };

    await expect(
      getReachDeckGenerationAudit('job-rotated-grant', requestHash, currentAuthorization, {
        actorId: currentAuthorization.actorId,
        billingGroupId: null,
      }),
    ).resolves.toMatchObject({
      actorId: currentAuthorization.actorId,
      billingGroupId: null,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const token = new Headers(init.headers).get('authorization')!.replace('Bearer ', '');
    await expect(
      verifyHs256Token(token, {
        secret: env.REACHANY_SERVICE_JWT_SECRET,
        audience: env.REACHANY_SERVICE_JWT_AUDIENCE,
      }),
    ).resolves.toMatchObject({
      actorId: currentAuthorization.actorId,
      extra: {
        billing_group_id: 'current-billing-group',
        role_grant_id: '88888888-8888-4888-8888-888888888888',
      },
    });
  });

  it('rejects a bridge response whose UUID scope drifts', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        code: 0,
        data: workspace({ moduleVersionId: '66666666-6666-4666-8666-666666666666' }),
      }),
    );
    await expect(getReachDeckWorkspace(options(fetchMock as typeof fetch))).rejects.toThrow(
      'wrong Reach Deck UUID scope',
    );
  });
});
