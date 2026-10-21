import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('This workbench requires Node.js 24. See README.md.');
}
for (const entry of ['server', 'worker']) {
  await build({
    absWorkingDir: root,
    entryPoints: [`packages/reach-deck-geometry/src/${entry}.ts`],
    outfile: `packages/reach-deck-geometry/dist/${entry}.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
    legalComments: 'eof',
    tsconfig: resolve(root, 'tsconfig.json'),
  });
}
