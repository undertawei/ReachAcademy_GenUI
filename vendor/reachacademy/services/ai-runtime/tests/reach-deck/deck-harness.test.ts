import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import path from 'node:path';

import { verifyHs256Token } from '@reachany/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DECK_HARNESS_DEFAULT_SCOPE,
  prepareDeckHarness,
  readDeckHarnessScopeConfig,
  resolveDeckHarnessAiRuntimeUrl,
  resolveDeckHarnessOutputDirectory,
  startDeckHarnessServer,
  unconfiguredDeckHarnessIdentityKeys,
  type DeckHarnessScopeConfig,
} from '../../scripts/reach-deck/deck-harness.js';
import { startDeckHarnessContentService } from '../../scripts/reach-deck/deck-harness-content-service.js';
import { storeReachDeckGeneratedMedia } from '../../lib/reach-deck/content-service-client.js';

const outputDirectory = resolveDeckHarnessOutputDirectory(`tmp/deck-harness-test-${randomUUID()}`);

const secret = 'deck-harness-test-secret-at-least-32-bytes';
const scope: DeckHarnessScopeConfig = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
  actorId: '77777777-7777-4777-8777-777777777777',
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  role: 'teacher',
  moduleTitle: '调试模块',
};

const harnessEnv = {
  REACHANY_SERVICE_JWT_MODE: 'hs256',
  REACHANY_SERVICE_JWT_SECRET: secret,
  REACH_DECK_HARNESS_MODE: 'on',
};

/** 站在真实 AI Runtime 的位置，记录收到的鉴权与 scope 头。 */
interface UpstreamCapture {
  url?: string;
  authorization?: string;
  headers: Record<string, string | undefined>;
  body?: string;
}

function startFakeAiRuntime(capture: UpstreamCapture): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    capture.url = request.url;
    capture.authorization = request.headers.authorization;
    capture.headers = request.headers as Record<string, string | undefined>;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      capture.body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ origin: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

describe('Reach Deck harness', () => {
  it('proxies only scoped registered memory media and preserves audio byte ranges', async () => {
    const content = await startDeckHarnessContentService({
      scope: { ...scope, moduleTitle: '调试模块' },
    });
    const media = await storeReachDeckGeneratedMedia(
      {
        kind: 'speech',
        pageId: 'page-1',
        idempotencyKey: 'playback-test',
        contentType: 'audio/mpeg',
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
      {
        actorId: scope.actorId,
        billingGroupId: null,
        roleGrantId: scope.roleGrantId,
        resourceScope: {
          organizationId: scope.organizationId,
          courseId: scope.courseId,
          courseWorkspaceType: 'draft',
          courseNodeId: scope.courseNodeId,
          moduleId: scope.moduleId,
          moduleVersionId: scope.moduleVersionId,
        },
        env: { ...harnessEnv, REACHANY_CONTENT_BASE_URL: content.origin },
      },
    );
    const harness = await startDeckHarnessServer({
      aiRuntimeUrl: content.origin,
      outputDirectory,
      scope,
      env: { ...harnessEnv, REACH_DECK_HARNESS_CONTENT_URL: content.origin },
    });
    const wrongScope = await startDeckHarnessServer({
      aiRuntimeUrl: content.origin,
      outputDirectory,
      scope: { ...scope, moduleVersionId: '66666666-6666-4666-8666-666666666666' },
      env: { ...harnessEnv, REACH_DECK_HARNESS_CONTENT_URL: content.origin },
    });
    try {
      const manifest = (await (
        await fetch(`${harness.origin}/harness/media-resources`)
      ).json()) as { resourceUrlsByObjectKey: Record<string, string> };
      const url = `${harness.origin}${manifest.resourceUrlsByObjectKey[media.objectKey]}`;
      const response = await fetch(url, { headers: { range: 'bytes=1-2' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3]);
      expect((await fetch(url, { method: 'HEAD' })).headers.get('content-length')).toBe('4');
      expect((await fetch(url, { headers: { range: 'bytes=7-9' } })).status).toBe(416);
      expect((await fetch(`${harness.origin}/harness/media/unknown`)).status).toBe(404);
      expect((await fetch(url, { headers: { origin: 'http://external.example' } })).status).toBe(
        404,
      );
      expect((await fetch(`${wrongScope.origin}/harness/media-resources`)).status).toBe(403);
    } finally {
      await harness.close();
      await wrongScope.close();
      await content.close();
    }
  });
  beforeAll(async () => {
    await prepareDeckHarness({ outputDirectory });
  }, 60_000);

  afterAll(async () => {
    await rm(outputDirectory, { recursive: true, force: true });
  });

  it('keeps generated artifacts inside repository tmp', () => {
    expect(() => resolveDeckHarnessOutputDirectory('services/ai-runtime/lib')).toThrow(
      'inside repository tmp/',
    );
    expect(resolveDeckHarnessOutputDirectory('tmp/deck-harness')).toContain(
      path.join('tmp', 'deck-harness'),
    );
  });

  it('refuses to sign tokens for anything but a loopback AI Runtime', () => {
    expect(resolveDeckHarnessAiRuntimeUrl('http://127.0.0.1:3050')).toBe('http://127.0.0.1:3050');
    expect(() => resolveDeckHarnessAiRuntimeUrl('https://ai-runtime.example.com')).toThrow(
      'plain loopback http origin',
    );
    expect(() => resolveDeckHarnessAiRuntimeUrl('http://10.0.0.5:3050')).toThrow(
      'plain loopback http origin',
    );
  });

  it('works out of the box, since the in-memory content-service needs no real course', () => {
    const fallback = readDeckHarnessScopeConfig({});
    expect(fallback.organizationId).toBe(DECK_HARNESS_DEFAULT_SCOPE.organizationId);
    expect(fallback.moduleVersionId).toBe(DECK_HARNESS_DEFAULT_SCOPE.moduleVersionId);
    expect(fallback.role).toBe('teacher');
  });

  it('lets a real content-service run override the debug course', () => {
    const overridden = readDeckHarnessScopeConfig({
      REACH_DECK_HARNESS_COURSE_ID: '88888888-8888-4888-8888-888888888888',
    });
    expect(overridden.courseId).toBe('88888888-8888-4888-8888-888888888888');
    expect(overridden.organizationId).toBe(DECK_HARNESS_DEFAULT_SCOPE.organizationId);
  });

  it('serves its configuration, including whether harness mode is on', async () => {
    const upstream = await startFakeAiRuntime({ headers: {} });
    const harness = await startDeckHarnessServer({
      aiRuntimeUrl: upstream.origin,
      outputDirectory,
      scope,
      env: harnessEnv,
    });
    try {
      const response = await fetch(`${harness.origin}/harness/config`);
      const config = (await response.json()) as {
        moduleContext: { moduleId: string };
        harnessModeEnabled: boolean;
        promptSnippets: Record<string, string>;
      };

      expect(config.moduleContext.moduleId).toBe(scope.moduleId);
      expect(config.harnessModeEnabled).toBe(true);
      expect(Object.keys(config.promptSnippets).length).toBeGreaterThan(0);
    } finally {
      await harness.close();
      upstream.server.close();
    }
  });

  it('keeps generation evidence read-only, same-origin, scoped and harness-gated', async () => {
    const upstream = await startFakeAiRuntime({ headers: {} });
    const harness = await startDeckHarnessServer({
      aiRuntimeUrl: upstream.origin,
      outputDirectory,
      scope,
      env: harnessEnv,
    });
    const disabled = await startDeckHarnessServer({
      aiRuntimeUrl: upstream.origin,
      outputDirectory,
      scope,
      env: { ...harnessEnv, REACH_DECK_HARNESS_MODE: 'off' },
    });
    try {
      const route = '/harness/generation-evidence?runId=unrelated-run';
      expect((await fetch(harness.origin + route)).status).toBe(200);
      expect(await (await fetch(harness.origin + route)).json()).toEqual({ entries: [] });
      expect(
        (await fetch(harness.origin + route, { headers: { origin: 'https://outside.invalid' } }))
          .status,
      ).toBe(404);
      expect((await fetch(harness.origin + route, { method: 'POST' })).status).toBe(404);
      expect((await fetch(disabled.origin + route)).status).toBe(404);
      expect((await fetch(harness.origin + '/harness/generation-evidence')).status).toBe(400);
      expect((await fetch(harness.origin + route + '&jobId=..%2Foutside')).status).toBe(404);
    } finally {
      await harness.close();
      await disabled.close();
      upstream.server.close();
    }
  });

  it('reports harness mode as off when the environment does not opt in', async () => {
    const upstream = await startFakeAiRuntime({ headers: {} });
    const harness = await startDeckHarnessServer({
      aiRuntimeUrl: upstream.origin,
      outputDirectory,
      scope,
      env: { ...harnessEnv, REACH_DECK_HARNESS_MODE: undefined },
    });
    try {
      const config = (await (await fetch(`${harness.origin}/harness/config`)).json()) as {
        harnessModeEnabled: boolean;
      };
      expect(config.harnessModeEnabled).toBe(false);
    } finally {
      await harness.close();
      upstream.server.close();
    }
  });

  it.each([
    {
      name: 'disabled HTML layout config',
      enabled: false,
      route: 'html-layout-config',
      method: 'GET',
      origin: 'same',
      source: 'Valid content',
      status: 404,
    },
    {
      name: 'disabled HTML layout generation',
      enabled: false,
      route: 'html-layout',
      method: 'POST',
      origin: 'same',
      source: 'Valid content',
      status: 404,
    },
    {
      name: 'cross-origin generation',
      enabled: true,
      route: 'html-layout',
      method: 'POST',
      origin: 'cross',
      source: 'Valid content',
      status: 404,
    },
    {
      name: 'generation without origin',
      enabled: true,
      route: 'html-layout',
      method: 'POST',
      origin: 'missing',
      source: 'Valid content',
      status: 403,
    },
    {
      name: 'invalid source',
      enabled: true,
      route: 'html-layout',
      method: 'POST',
      origin: 'same',
      source: '   ',
      status: 400,
    },
  ])(
    'rejects $name without contacting the model',
    async ({ enabled, route, method, origin, source, status }) => {
      const capture: UpstreamCapture = { headers: {} };
      const upstream = await startFakeAiRuntime(capture);
      const harness = await startDeckHarnessServer({
        aiRuntimeUrl: upstream.origin,
        outputDirectory,
        scope,
        env: {
          ...harnessEnv,
          REACH_DECK_HARNESS_HTML_LAYOUT: enabled ? 'on' : undefined,
          REACHANY_LITELLM_BASE_URL: upstream.origin,
          REACHANY_LITELLM_API_KEY: 'test-only-model-key',
        },
      });
      try {
        const response = await fetch(`${harness.origin}/harness/${route}`, {
          method,
          headers: {
            'content-type': 'application/json',
            ...(origin === 'same' ? { origin: harness.origin } : {}),
            ...(origin === 'cross' ? { origin: 'http://other.example.test' } : {}),
          },
          ...(method === 'POST' ? { body: JSON.stringify({ source }) } : {}),
        });
        expect(response.status).toBe(status);
        if (status === 400) {
          expect(await response.json()).toEqual({
            error: 'Source must contain 1-24000 characters',
          });
        }
        expect(capture.url).toBeUndefined();
      } finally {
        await harness.close();
        upstream.server.close();
      }
    },
  );

  it('refuses to start HTML layout trials without harness mode', async () => {
    await expect(
      startDeckHarnessServer({
        aiRuntimeUrl: 'http://127.0.0.1:3050',
        outputDirectory,
        scope,
        env: {
          ...harnessEnv,
          REACH_DECK_HARNESS_MODE: undefined,
          REACH_DECK_HARNESS_HTML_LAYOUT: 'on',
        },
      }),
    ).rejects.toThrow('HTML layout trial requires REACH_DECK_HARNESS_MODE=on');
  });

  it('signs a scoped token for the real AI Runtime without any login', async () => {
    const capture: UpstreamCapture = { headers: {} };
    const upstream = await startFakeAiRuntime(capture);
    const harness = await startDeckHarnessServer({
      aiRuntimeUrl: upstream.origin,
      outputDirectory,
      scope,
      env: harnessEnv,
    });
    try {
      const response = await fetch(`${harness.origin}/api/reach-deck/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: harness.origin },
        body: JSON.stringify({ source: 'Teacher source' }),
      });

      expect(response.status).toBe(200);
      expect(capture.url).toBe('/api/reach-deck/workspace');
      expect(capture.body).toBe(JSON.stringify({ source: 'Teacher source' }));
      expect(capture.headers['x-reachany-organization-id']).toBe(scope.organizationId);
      expect(capture.headers['x-reachany-module-version-id']).toBe(scope.moduleVersionId);
      expect(capture.headers['x-reachany-role']).toBe('teacher');

      const token = capture.authorization?.slice('Bearer '.length) ?? '';
      const claims = await verifyHs256Token(token, { secret, audience: 'reachany-services' });
      expect(claims.actorId).toBe(scope.actorId);
      expect(claims.extra.role_grant_id).toBe(scope.roleGrantId);
      expect(claims.extra.module_id).toBe(scope.moduleId);
    } finally {
      await harness.close();
      upstream.server.close();
    }
  });

  it('refuses a cross-origin caller so no other page can borrow the signed upstream', async () => {
    const capture: UpstreamCapture = { headers: {} };
    const upstream = await startFakeAiRuntime(capture);
    const harness = await startDeckHarnessServer({
      aiRuntimeUrl: upstream.origin,
      outputDirectory,
      scope,
      env: harnessEnv,
    });
    try {
      const response = await fetch(`${harness.origin}/api/reach-deck/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
        body: '{}',
      });

      expect(response.status).toBe(404);
      expect(capture.url).toBeUndefined();
    } finally {
      await harness.close();
      upstream.server.close();
    }
  });

  it('pins the debug course so a tampered query cannot reach another module', async () => {
    const capture: UpstreamCapture = { headers: {} };
    const upstream = await startFakeAiRuntime(capture);
    const harness = await startDeckHarnessServer({
      aiRuntimeUrl: upstream.origin,
      outputDirectory,
      scope,
      env: harnessEnv,
    });
    try {
      const response = await fetch(
        `${harness.origin}/api/reach-deck/workspace?moduleId=66666666-6666-4666-8666-666666666666`,
        { headers: { origin: harness.origin } },
      );

      expect(response.status).toBe(403);
      expect(capture.url).toBeUndefined();
    } finally {
      await harness.close();
      upstream.server.close();
    }
  });
});

describe('deck harness identity configuration', () => {
  it('names the variables that still hold built-in defaults', () => {
    expect(unconfiguredDeckHarnessIdentityKeys({})).toEqual([
      'REACH_DECK_HARNESS_ORGANIZATION_ID',
      'REACH_DECK_HARNESS_ACTOR_ID',
    ]);
  });

  it('says nothing once both name a real organization and account', () => {
    expect(
      unconfiguredDeckHarnessIdentityKeys({
        REACH_DECK_HARNESS_ORGANIZATION_ID: scope.organizationId,
        REACH_DECK_HARNESS_ACTOR_ID: scope.actorId,
      }),
    ).toEqual([]);
  });

  it('still flags a blank value, which env files produce easily', () => {
    expect(
      unconfiguredDeckHarnessIdentityKeys({
        REACH_DECK_HARNESS_ORGANIZATION_ID: '  ',
        REACH_DECK_HARNESS_ACTOR_ID: scope.actorId,
      }),
    ).toEqual(['REACH_DECK_HARNESS_ORGANIZATION_ID']);
  });
});
