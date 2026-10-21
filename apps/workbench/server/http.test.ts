import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkbenchServer, WORKSPACE_ROOT } from './http.js';
import { DEMO_SCENE } from './demo.js';
import type { ModelConfig } from './config.js';
import type { FetchImplementation } from './provider.js';

const blankConfig: ModelConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  maxTokens: 16000,
  timeoutMs: 1000,
};
const fakeConfig: ModelConfig = {
  ...blankConfig,
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'private-test-key',
  model: 'fake-model',
};
const servers: Server[] = [];

async function start(
  options: { configured?: boolean; fetchImplementation?: FetchImplementation } = {},
) {
  const projectsDirectory = resolve(WORKSPACE_ROOT, 'tmp/server-tests', randomUUID());
  await mkdir(projectsDirectory, { recursive: true });
  const server = createWorkbenchServer({
    projectsDirectory,
    modelConfig: options.configured ? fakeConfig : blankConfig,
    fetchImplementation:
      options.fetchImplementation ??
      (async () => {
        throw new Error('Unexpected provider request');
      }),
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('No test server address');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    get: (path: string, headers?: HeadersInit) => fetch(origin + path, { headers }),
    post: (path: string, value: unknown, headers?: Record<string, string>) =>
      fetch(origin + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(value),
      }),
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

function completion(scene: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(scene) } }],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function pageId(init?: RequestInit): string {
  const request = JSON.parse(String(init?.body));
  return JSON.parse(request.messages[1].content).page.id;
}

describe('standalone GenUI API', () => {
  it('serves the original prompt and an offline demo with no credentials', async () => {
    const client = await start();
    const status = await (await client.get('/api/status')).json();
    expect(status).toMatchObject({
      configured: false,
      model: '',
      baseUrl: '',
      promptVersion: 'interactive/v39-flat-event-fields',
    });
    expect(JSON.stringify(status)).not.toContain('apiKey');
    const prompt = await (await client.get('/api/prompts')).json();
    expect(prompt.text).toContain('REACHINTERACTIVE BRIDGE CONTRACT');
    const demo = await (await client.get('/api/demo')).json();
    const validation = await client.post('/api/validate', { scene: demo.scene });
    expect(validation.status).toBe(200);
    const generation = await client.post('/api/generate', { instruction: '生成一个函数实验' });
    expect(generation.status).toBe(503);
    expect((await generation.json()).code).toBe('model_not_configured');
  });

  it('uses the server key privately and validates generated scenes using the supplied scene identity', async () => {
    let callCount = 0;
    const client = await start({
      configured: true,
      fetchImplementation: async (input, init) => {
        callCount += 1;
        expect(String(input)).toBe('https://provider.invalid/v1/chat/completions');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-test-key');
        expect(init?.redirect).toBe('error');
        const request = JSON.parse(String(init?.body));
        expect(request.messages[0].content).toContain('payloadFields');
        expect(request.response_format).toEqual({ type: 'json_object' });
        return completion({ ...DEMO_SCENE, id: pageId(init) });
      },
    });
    const response = await client.post('/api/generate', {
      instruction: '函数平移实验',
      scene: DEMO_SCENE,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.scene.id).toBe(DEMO_SCENE.id);
    expect(result.promptVersion).toBe('interactive/v39-flat-event-fields');
    expect(JSON.stringify(result)).not.toContain(fakeConfig.apiKey);
    expect(callCount).toBe(1);
  });

  it('rejects network resources and syntactically invalid imported HTML before preview', async () => {
    const client = await start();
    const remote = await client.post('/api/validate', {
      html: DEMO_SCENE.documentHtml.replace(
        '</head>',
        '<script src="https://example.com/unsafe.js"></script></head>',
      ),
    });
    expect(remote.status).toBe(422);
    const invalid = await client.post('/api/validate', {
      html: DEMO_SCENE.documentHtml.replace('let offset = 0;', 'let offset = ;'),
    });
    expect(invalid.status).toBe(422);
    const valid = await client.post('/api/validate', {
      html: DEMO_SCENE.documentHtml,
      title: '我的 HTML',
    });
    expect(valid.status).toBe(200);
    expect((await valid.json()).scene.title).toBe('我的 HTML');
  });

  it('rejects ordinary HTML and misleading bridge comments across import and project APIs', async () => {
    const client = await start();
    const ordinaryHtml =
      '<!DOCTYPE html><html><head><title>普通页面</title></head><body><h1>普通页面</h1></body></html>';
    const imported = await client.post('/api/validate', { html: ordinaryHtml });
    expect(imported.status).toBe(422);
    expect((await imported.json()).error).toContain('初始化握手');
    const commentOnly = ordinaryHtml.replace(
      '</body>',
      `<script>/* window.addEventListener('reach-interactive-initialize', () => window.ReachInteractive.ready({restored:false})); */</script></body>`,
    );
    expect((await client.post('/api/validate', { html: commentOnly })).status).toBe(422);
    const missingReady = DEMO_SCENE.documentHtml.replace(
      'window.ReachInteractive.ready(ready);',
      "console.log('ReachInteractive.ready(ready)');",
    );
    expect(
      (await client.post('/api/validate', { scene: { ...DEMO_SCENE, documentHtml: missingReady } }))
        .status,
    ).toBe(422);
    expect(
      (
        await client.post('/api/projects', {
          title: '普通页面',
          scene: { ...DEMO_SCENE, documentHtml: ordinaryHtml },
        })
      ).status,
    ).toBe(422);
    const aliasedBridge = DEMO_SCENE.documentHtml
      .replace('let offset = 0;', 'const bridge = window.ReachInteractive; let offset = 0;')
      .replace('window.ReachInteractive.ready(ready);', 'bridge.ready(ready);');
    expect((await client.post('/api/validate', { html: aliasedBridge })).status).toBe(200);
  });

  it('rejects generated scenes that omit the player initialization handshake', async () => {
    let calls = 0;
    const client = await start({
      configured: true,
      fetchImplementation: async (_input, init) => {
        calls += 1;
        return completion({
          ...DEMO_SCENE,
          id: pageId(init),
          documentHtml:
            '<!DOCTYPE html><html><head><title>普通页面</title></head><body><h1>普通页面</h1></body></html>',
        });
      },
    });
    const response = await client.post('/api/generate', { instruction: '互动实验' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('初始化握手');
    expect(calls).toBe(2);
  });

  it('rejects invalid model HTML after at most one repair', async () => {
    let calls = 0;
    const client = await start({
      configured: true,
      fetchImplementation: async (_input, init) => {
        calls += 1;
        return completion({
          ...DEMO_SCENE,
          id: pageId(init),
          documentHtml: DEMO_SCENE.documentHtml.replace(
            '</head>',
            '<script src="https://example.com/remote.js"></script></head>',
          ),
        });
      },
    });
    const response = await client.post('/api/generate', { instruction: '互动实验' });
    expect(response.status).toBe(422);
    expect(calls).toBe(2);
  });

  it('atomically limits concurrent generations after slow request bodies complete', async () => {
    const pending: Array<() => void> = [];
    let markProvidersReady!: () => void;
    const providersReady = new Promise<void>((done) => {
      markProvidersReady = done;
    });
    const client = await start({
      configured: true,
      fetchImplementation: async (_input, init) =>
        new Promise<Response>((done) => {
          pending.push(() => done(completion({ ...DEMO_SCENE, id: pageId(init) })));
          if (pending.length === 2) markProvidersReady();
        }),
    });
    let headerCount = 0;
    const headersReceived = new Promise<void>((done) => {
      client.server.on('request', () => {
        if (++headerCount === 3) done();
      });
    });
    const payload = JSON.stringify({ instruction: '函数实验' });
    const requests = Array.from({ length: 3 }, () => {
      let request!: ReturnType<typeof httpRequest>;
      const result = new Promise<number | undefined>((done, reject) => {
        request = httpRequest(
          `${client.origin}/api/generate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (response) => {
            response.resume();
            response.on('end', () => done(response.statusCode));
          },
        );
        request.on('error', reject);
        // Send all headers first and keep all bodies pending at the server's await.
        request.flushHeaders();
      });
      return { request, result };
    });
    await headersReceived;
    for (const { request } of requests) request.end(payload);
    try {
      await providersReady;
      // Both provider responses are still held; only the rejected third request can finish.
      expect(await Promise.race(requests.map(({ result }) => result))).toBe(429);
      expect(pending).toHaveLength(2);
    } finally {
      for (const complete of pending) complete();
    }
    expect((await Promise.all(requests.map(({ result }) => result))).sort()).toEqual([
      200, 200, 429,
    ]);
  });

  it('retains the original repair invariants and rejects a replacement activity', async () => {
    let calls = 0;
    const client = await start({
      configured: true,
      fetchImplementation: async (_input, init) => {
        calls += 1;
        return completion(
          calls === 1
            ? {
                ...DEMO_SCENE,
                id: pageId(init),
                documentHtml: DEMO_SCENE.documentHtml.replace('let offset = 0;', 'let offset = ;'),
              }
            : { ...DEMO_SCENE, id: pageId(init), title: 'A replacement title' },
        );
      },
    });
    const response = await client.post('/api/generate', { instruction: '互动实验' });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain('protected fields');
    expect(calls).toBe(2);
  });

  it('preserves script repair invariants when a missing ready call is added by the correction', async () => {
    let calls = 0;
    const client = await start({
      configured: true,
      fetchImplementation: async (_input, init) => {
        calls += 1;
        return completion({
          ...DEMO_SCENE,
          id: pageId(init),
          documentHtml:
            calls === 1
              ? DEMO_SCENE.documentHtml.replace('window.ReachInteractive.ready(ready);', '')
              : DEMO_SCENE.documentHtml,
        });
      },
    });
    const response = await client.post('/api/generate', { instruction: '函数实验' });
    expect(response.status).toBe(422);
    const result = await response.json();
    expect(result.code).toBe('generation_invalid');
    expect(result.error).toContain('protected');
    expect(result.error).toContain('修改需求后重新生成');
    expect(result.error).toContain('HTML 页签');
    expect(calls).toBe(2);
  });

  it('never returns a provider error body or the authorization key', async () => {
    const client = await start({
      configured: true,
      fetchImplementation: async () =>
        new Response(`provider error ${fakeConfig.apiKey}`, { status: 401 }),
    });
    const response = await client.post('/api/generate', { instruction: '互动实验' });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(fakeConfig.apiKey);
    expect(text).not.toContain('provider error');
    expect(text).toContain('401');
  });

  it('serves only pinned runtime bytes to the opaque player sandbox', async () => {
    const client = await start();
    const { runtimes } = await (await client.get('/api/runtime')).json();
    const runtime = await client.get(runtimes[0].scriptPath, { Origin: 'null' });
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect((await runtime.arrayBuffer()).byteLength).toBe(runtimes[0].sourceBytes);
    expect(
      (await client.get('/reach-deck-dependencies/not-a-pin/file.js', { Origin: 'null' })).status,
    ).toBe(404);
    expect((await client.get('/api/status', { Origin: 'null' })).status).toBe(403);
  });

  it('round-trips local projects and rejects path traversal and undeclared fields', async () => {
    const client = await start();
    const savedResponse = await client.post('/api/projects', {
      title: '函数实验',
      instruction: '探索平移',
      scene: DEMO_SCENE,
    });
    expect(savedResponse.status).toBe(200);
    const { project } = await savedResponse.json();
    const loaded = await (await client.get(`/api/projects/${project.id}`)).json();
    expect(loaded.project).toEqual(project);
    const updated = await (
      await client.post('/api/projects', { id: project.id, title: '重命名', scene: DEMO_SCENE })
    ).json();
    expect(updated.project.createdAt).toBe(project.createdAt);
    const list = await (await client.get('/api/projects')).json();
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0].title).toBe('重命名');
    expect((await client.get('/api/projects/%2e%2e%2f.env')).status).toBe(400);
    expect(
      (await client.post('/api/projects', { id: '../../.env', title: 'bad', scene: DEMO_SCENE }))
        .status,
    ).toBe(400);
    expect(
      (await client.post('/api/projects', { title: 'bad', scene: DEMO_SCENE, unexpected: true }))
        .status,
    ).toBe(400);
  });

  it('blocks cross-site API access, rebinding hosts, unknown routes and oversized bodies', async () => {
    const client = await start();
    expect(
      (await client.post('/api/validate', { scene: DEMO_SCENE }, { Origin: 'https://example.com' }))
        .status,
    ).toBe(403);
    const rebindingStatus = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(
        `${client.origin}/api/status`,
        { headers: { Host: 'attacker.example' } },
        (response) => {
          response.resume();
          response.on('end', () => done(response.statusCode));
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(rebindingStatus).toBe(403);
    expect((await client.get('/api/no-such-route')).status).toBe(404);
    expect(
      (await client.post('/api/generate', { instruction: 'x'.repeat(2 * 1024 * 1024) })).status,
    ).toBe(413);
    const status = await client.get('/api/status');
    expect(status.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await client.get('/.env')).status).toBe(404);
  });
});
