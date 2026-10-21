import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolveReachDeckRuntimeAsset } from '../../lib/reach-deck/runtime-assets.ts';

await build({
  entryPoints: [resolveReachDeckRuntimeAsset('html-layout-source')],
  outfile: resolveReachDeckRuntimeAsset('html-layout-bundle'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  plugins: [
    {
      name: 'html-layout-static-tailwind-theme',
      setup(builder) {
        builder.onResolve({ filter: /^tailwindcss\/theme\.css\?raw$/ }, () => ({
          path: resolveReachDeckRuntimeAsset('tailwind-theme'),
          namespace: 'raw-theme',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'raw-theme' }, async ({ path }) => ({
          contents: await readFile(path, 'utf8'),
          loader: 'text',
        }));
      },
    },
  ],
});
