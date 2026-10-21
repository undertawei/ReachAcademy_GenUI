import { readFileSync } from 'node:fs';
import path from 'node:path';

type RuntimeAsset =
  | 'player-styles'
  | 'katex-css'
  | 'smiles-drawer'
  | 'geometry-server'
  | 'tailwind-theme'
  | 'resvg-wasm'
  | 'html-layout-source'
  | 'html-layout-bundle';

let root: string | undefined;
function runtimeRoot(): string {
  if (root) return root;
  for (const candidate of [process.cwd(), path.join(process.cwd(), 'services/ai-runtime')]) {
    try {
      if (
        JSON.parse(readFileSync(path.join(candidate, 'package.json'), 'utf8')).name ===
        '@reachany/ai-runtime'
      )
        return (root = candidate);
    } catch {
      // Support the documented service-root API and repository-root worker launches.
    }
  }
  throw new Error('AI Runtime must launch from its service or repository root.');
}

/** Native resolution is essential: Webpack turns imported createRequire.resolve into module IDs. */
export function resolveReachDeckRuntimeAsset(asset: RuntimeAsset): string {
  const directory = runtimeRoot();
  const nativeRequire = process
    .getBuiltinModule('module')
    .createRequire(path.join(directory, 'package.json'));
  switch (asset) {
    case 'player-styles':
      return nativeRequire.resolve('@reachany/reach-deck-player/styles.css');
    case 'katex-css':
      return process
        .getBuiltinModule('module')
        .createRequire(nativeRequire.resolve('@reachany/tiptap-mathlive/static'))
        .resolve('katex/dist/katex.min.css');
    case 'smiles-drawer':
      return nativeRequire.resolve('smiles-drawer');
    case 'geometry-server':
      return nativeRequire.resolve('@reachany/reach-deck-geometry/server');
    case 'tailwind-theme':
      return nativeRequire.resolve('tailwindcss/theme.css');
    case 'resvg-wasm':
      return nativeRequire.resolve('@resvg/resvg-wasm');
    case 'html-layout-source':
      return path.join(directory, 'lib/reach-deck/html-layout/browser.ts');
    case 'html-layout-bundle':
      return path.join(directory, 'dist/reach-deck/html-layout-browser.js');
  }
}
