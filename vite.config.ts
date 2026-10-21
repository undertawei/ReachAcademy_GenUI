import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));
export const sourceAliases = [
  {
    find: '@reachany/reach-deck-dsl/euclidean-geometry-contract-v2',
    replacement: resolve(root, 'packages/reach-deck-dsl/src/euclideanGeometryContractV2.json'),
  },
  {
    find: '@reachany/reach-deck-dsl/euclidean-geometry-contract',
    replacement: resolve(root, 'packages/reach-deck-dsl/src/euclideanGeometryContract.json'),
  },
  {
    find: '@reachany/reach-deck-dsl/euclidean-geometry-v2',
    replacement: resolve(root, 'packages/reach-deck-dsl/src/euclideanGeometryV2.ts'),
  },
  {
    find: '@reachany/reach-deck-dsl/euclidean-geometry',
    replacement: resolve(root, 'packages/reach-deck-dsl/src/euclideanGeometry.ts'),
  },
  {
    find: '@reachany/reach-deck-dsl/function-plot-geometry',
    replacement: resolve(root, 'packages/reach-deck-dsl/src/functionPlotGeometry.ts'),
  },
  {
    find: '@reachany/reach-deck-dsl/reference-library',
    replacement: resolve(root, 'packages/reach-deck-dsl/src/reference-library/index.ts'),
  },
  {
    find: '@reachany/reach-deck-geometry/server',
    replacement: resolve(root, 'packages/reach-deck-geometry/dist/server.mjs'),
  },
  {
    find: '@reachany/importer/maic',
    replacement: resolve(root, 'packages/importer/src/maic/index.ts'),
  },
  {
    find: /^@reachany\/([^/]+)$/,
    replacement: `${root.replaceAll('\\', '/')}/packages/$1/src/index.ts`,
  },
];

export default defineConfig({
  root: resolve(root, 'apps/workbench'),
  plugins: [react()],
  resolve: { alias: sourceAliases },
  server: { host: '127.0.0.1', fs: { allow: [root] } },
  build: { outDir: resolve(root, 'dist'), emptyOutDir: false },
});
