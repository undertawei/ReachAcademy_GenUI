import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const port = Number(process.argv[2]);
assert(Number.isInteger(port) && port > 1024 && port < 65536, 'Supply an allocated worktree port');
const probe = createServer();
probe.listen(port, '127.0.0.1');
await once(probe, 'listening');
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

await mkdir(path.join(root, 'tmp'), { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/geometry-standalone-'));
try {
  const standalone = path.join(temporary, 'app');
  await cp(path.join(root, 'services/ai-runtime/.next/standalone'), standalone, {
    recursive: true,
    verbatimSymlinks: true,
  });
  // Match the runner's explicit trusted-package copies and service working directory.
  for (const entry of ['dist', 'package.json']) {
    await cp(
      path.join(root, 'packages/reach-deck-geometry', entry),
      path.join(standalone, 'packages/reach-deck-geometry', entry),
      { recursive: true },
    );
  }
  const service = path.join(standalone, 'services/ai-runtime');
  const require = createRequire(path.join(service, 'package.json'));
  const resolverPath = await realpath(require.resolve('@reachany/reach-deck-geometry/worker-path'));
  assert(
    resolverPath.startsWith(`${standalone}${path.sep}`),
    'Resolver escaped the standalone artifact',
  );
  const { resolveGeometryWorkerPath } = await import(pathToFileURL(resolverPath).href);
  const workerPath = await realpath(resolveGeometryWorkerPath());
  assert(
    workerPath.startsWith(`${standalone}${path.sep}`),
    'Worker escaped the standalone artifact',
  );
  const child = spawn(process.execPath, [path.join(service, 'server.js')], {
    cwd: service,
    env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  const url = `http://127.0.0.1:${port}/api/integrations/reach-deck/geometry/validate`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert(child.exitCode === null, 'Standalone server exited before readiness');
      try {
        const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(1000) });
        if (response.status === 401) {
          ready = true;
          break;
        }
      } catch {}
      await delay(100);
    }
    assert(ready, 'Standalone route did not become ready');
    const config = readHs256ServiceJwtConfig(process.env);
    const token = await createHs256Token({
      ...config,
      subject: 'content-service',
      audience: 'ai-runtime',
      roles: [],
      extraClaims: { token_type: 'service' },
      expiresInSeconds: 60,
    });
    const contract = JSON.parse(
      await readFile(
        path.join(root, 'packages/reach-deck-dsl/src/euclideanGeometryContract.json'),
        'utf8',
      ),
    );
    const scenarios = JSON.parse(
      await readFile(
        path.join(root, 'packages/reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json'),
        'utf8',
      ),
    );
    const markers = [
      { instanceId: 'planar', envelope: scenarios[0].envelope },
      { instanceId: 'spatial', envelope: scenarios.find((s) => s.id.startsWith('G3')).envelope },
    ];
    const call = async (entries, digestOverride) => {
      const bytes = Buffer.from(
        JSON.stringify({ schemaVersion: contract.transport.schemaVersion, markers: entries }),
      );
      const digest = createHash('sha256').update(bytes).digest('hex');
      const started = performance.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
          'x-reach-geometry-digest': digestOverride ?? digest,
        },
        body: bytes,
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      return {
        status: response.status,
        body,
        digest,
        elapsedMs: Math.round(performance.now() - started),
      };
    };
    const valid = await call(markers);
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body, {
      schemaVersion: contract.transport.schemaVersion,
      evaluatorVersion: contract.evaluatorVersion,
      digest: valid.digest,
      results: markers.map((marker) => ({
        instanceId: marker.instanceId,
        valid: true,
        diagnostics: [],
      })),
    });
    const invalid = structuredClone(markers[0]);
    invalid.envelope.spec.objects.find((object) => object.kind === 'circle').radius = 0;
    const degenerate = await call([invalid]);
    assert.equal(degenerate.status, 200);
    assert.equal(degenerate.body.results[0].valid, false);
    assert(
      degenerate.body.results[0].diagnostics.some(
        (diagnostic) => diagnostic.code === 'invalid_radius',
      ),
    );
    assert.equal((await call(markers, '0'.repeat(64))).status, 400);
    console.log(
      JSON.stringify(
        {
          status: 'PASS',
          resolver: path.relative(standalone, resolverPath),
          worker: path.relative(standalone, workerPath),
          cwd: 'relocated runner layout: app/services/ai-runtime',
          validRequestMs: valid.elapsedMs,
          invalidRequestMs: degenerate.elapsedMs,
          checks: [
            'missing-auth-401',
            'valid-planar-spatial-200',
            'degenerate-invalid-200',
            'digest-mismatch-400',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
