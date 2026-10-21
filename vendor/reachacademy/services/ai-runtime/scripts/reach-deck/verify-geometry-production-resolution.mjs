import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveReachDeckRuntimeAsset } from '../../lib/reach-deck/runtime-assets.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
await mkdir(path.join(root, 'tmp'), { recursive: true });
const temporary = await mkdtemp(path.join(root, 'tmp/geometry-production-resolution-'));

try {
  const standalone = path.join(temporary, 'app');
  await cp(path.join(root, 'services/ai-runtime/.next/standalone'), standalone, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const service = path.join(standalone, 'services/ai-runtime');
  const require = createRequire(path.join(service, 'package.json'));
  for (const id of [
    '@reachany/reach-deck-player/styles.css',
    '@reachany/tiptap-mathlive/static',
    '@reachany/reach-deck-geometry/server',
    'smiles-drawer',
    'katex/dist/katex.min.css',
  ]) {
    const resolved = await realpath(require.resolve(id));
    assert(resolved.startsWith(`${standalone}${path.sep}`), `${id} escaped the artifact`);
  }
  const styles = require.resolve('@reachany/reach-deck-player/styles.css');
  await access(path.join(path.dirname(styles), 'fonts/manifest.json'));
  await access(path.join(path.dirname(styles), 'fonts/fonts.css'));
  for (const cssPath of [
    path.join(path.dirname(styles), 'fonts/fonts.css'),
    require.resolve('katex/dist/katex.min.css'),
  ]) {
    const css = await readFile(cssPath, 'utf8');
    for (const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) {
      if (match[1].startsWith('data:')) continue;
      // The compiler replaces each KaTeX src list with its embedded WOFF2 face.
      if (cssPath.endsWith('katex.min.css') && !match[1].endsWith('.woff2')) continue;
      const asset = await realpath(path.resolve(path.dirname(cssPath), match[1]));
      assert(asset.startsWith(`${standalone}${path.sep}`), 'CSS asset escaped the artifact');
      await access(asset);
    }
  }
  const originalCwd = process.cwd();
  try {
    process.chdir(service);
    for (const id of [
      'player-styles',
      'katex-css',
      'smiles-drawer',
      'geometry-server',
      'html-layout-bundle',
    ]) {
      const resolved = await realpath(resolveReachDeckRuntimeAsset(id));
      assert(resolved.startsWith(`${standalone}${path.sep}`), `${id} helper escaped artifact`);
    }
  } finally {
    process.chdir(originalCwd);
  }
  await access(path.join(service, 'dist/reach-deck/html-layout-browser.js'));
  const resolverPath = await realpath(require.resolve('@reachany/reach-deck-geometry/worker-path'));
  assert(
    resolverPath.startsWith(`${standalone}${path.sep}`),
    'Geometry resolver escaped the production artifact',
  );
  const { resolveGeometryWorkerPath } = await import(pathToFileURL(resolverPath).href);
  const workerPath = await realpath(resolveGeometryWorkerPath());
  assert(
    workerPath.startsWith(`${standalone}${path.sep}`),
    'Geometry worker escaped the production artifact',
  );

  const worker = new Worker(workerPath);
  try {
    const ready = Promise.race([
      once(worker, 'message'),
      once(worker, 'error').then(([error]) => Promise.reject(error)),
      delay(5_000, undefined, { ref: false }).then(() =>
        Promise.reject(new Error('Geometry worker readiness timed out')),
      ),
    ]);
    assert.deepEqual(await ready, [{ type: 'ready' }]);
  } finally {
    await worker.terminate();
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
