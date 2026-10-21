import { loadSharedAttachmentCss } from './shared-attachment-css.mjs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseReachDeckDocumentV2, type ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import {
  INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES,
  REACH_SCIENTIFIC_DEPENDENCIES,
} from '@reachany/reach-deck-player';
import { build } from 'esbuild';

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
export const PLAYER_ROOT = path.join(REPOSITORY_ROOT, 'packages/reach-deck-player');
/** URL prefix the harness stylesheets use for repository-owned webfont files. */
export const PLAYER_FONTS_URL_PREFIX = '/__repo__/packages/reach-deck-player/fonts/';
export const KATEX_FONTS_URL_PREFIX = '/__repo__/node_modules/katex/dist/fonts/';
export const MATHLIVE_FONTS_URL_PREFIX = '/__repo__/node_modules/mathlive/fonts/';
const HARNESS_FONT_DIRECTORIES = [
  [PLAYER_FONTS_URL_PREFIX, path.join(PLAYER_ROOT, 'fonts')],
  [KATEX_FONTS_URL_PREFIX, path.join(REPOSITORY_ROOT, 'node_modules/katex/dist/fonts')],
  [MATHLIVE_FONTS_URL_PREFIX, path.join(REPOSITORY_ROOT, 'node_modules/mathlive/fonts')],
] as const;
const ENTRY_FILE = path.join(import.meta.dirname, 'player-harness-entry.tsx');
const FUNCTION_PLOT_DEPENDENCY = REACH_SCIENTIFIC_DEPENDENCIES.find(
  ({ id }) => id === 'function-plot',
)!;
export const FUNCTION_PLOT_SCRIPT_PATH = FUNCTION_PLOT_DEPENDENCY.scriptPath;
const FUNCTION_PLOT_FILE = path.join(
  REPOSITORY_ROOT,
  'apps/student/public/reach-deck-dependencies/function-plot',
  `${FUNCTION_PLOT_DEPENDENCY.sha256}.js`,
);
const EXTERNAL_RUNTIME_FILES = new Map<string, string>(
  INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.map((dependency) => [
    dependency.scriptPath,
    path.join(REPOSITORY_ROOT, 'apps/student/public', dependency.scriptPath),
  ]),
);

export interface PlayerHarnessAsset {
  bytes: Uint8Array;
  checksumSha256: string;
  contentType: string;
  fileName: string;
  sizeBytes: number;
}

export interface PlayerHarnessConfig {
  source: 'cloud-generation' | 'document-file' | 'fixture';
  timingSource: 'document' | 'uniform-preview';
  validatesTtsAlignment: boolean;
  resourceUrlsById: Record<string, string>;
}

export interface PreparedPlayerHarness {
  config: PlayerHarnessConfig;
  document: ReachDeckDocumentV2;
  outputDirectory: string;
  playerHtml: string;
}

export const isChildOf = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export const resolveTemporaryOutputDirectory = (
  requested: string,
  label = 'The output directory',
): string => {
  const outputDirectory = path.resolve(REPOSITORY_ROOT, requested);
  const allowed = ['tmp', '.tmp'].some((directory) =>
    isChildOf(path.join(REPOSITORY_ROOT, directory), outputDirectory),
  );
  if (!allowed) throw new Error(`${label} must be a child of repository tmp/ or .tmp/.`);
  return outputDirectory;
};

export const resolveRepositoryInputFile = (requested: string, label: string): string => {
  const file = path.resolve(REPOSITORY_ROOT, requested);
  if (!isChildOf(REPOSITORY_ROOT, file)) {
    throw new Error(`${label} must resolve to a file inside this repository.`);
  }
  const relative = path.relative(REPOSITORY_ROOT, file).split(path.sep);
  if (relative[0] === 'infra' && relative[1] === 'env') {
    throw new Error(`${label} must not point into infra/env.`);
  }
  return file;
};

export const loadStrictReachDeckDocument = async (
  requested: string,
): Promise<ReachDeckDocumentV2> => {
  const file = resolveRepositoryInputFile(requested, '--document-file');
  return parseReachDeckDocumentV2(JSON.parse(await readFile(file, 'utf8')));
};

export const loadPlayerHarnessResourceMap = async (
  document: ReachDeckDocumentV2,
  requested?: string,
): Promise<Map<string, PlayerHarnessAsset>> => {
  if (requested === undefined) {
    if (document.resources.media.length === 0) return new Map();
    throw new Error('--resource-map is required when an injected document declares media.');
  }
  const mapFile = resolveRepositoryInputFile(requested, '--resource-map');
  const parsed = JSON.parse(await readFile(mapFile, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      '--resource-map must contain a JSON object from resource id to repository file.',
    );
  }
  const declared = new Map(document.resources.media.map((resource) => [resource.id, resource]));
  const entries = Object.entries(parsed as Record<string, unknown>);
  const unexpected = entries.find(([resourceId]) => !declared.has(resourceId));
  if (unexpected !== undefined) {
    throw new Error(`Resource map contains undeclared resource id ${unexpected[0]}.`);
  }
  const missing = [...declared.keys()].find(
    (resourceId) => !Object.prototype.hasOwnProperty.call(parsed, resourceId),
  );
  if (missing !== undefined)
    throw new Error(`Resource map is missing declared resource ${missing}.`);
  const assets = new Map<string, PlayerHarnessAsset>();
  for (const [resourceId, requestedPath] of entries) {
    if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
      throw new Error(`Resource map entry ${resourceId} must be a non-empty repository path.`);
    }
    const file = resolveRepositoryInputFile(requestedPath, `resource ${resourceId}`);
    const bytes = new Uint8Array(await readFile(file));
    const resource = declared.get(resourceId)!;
    assets.set(resourceId, {
      bytes,
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: resource.contentType,
      fileName: `${resourceId}${extensionForContentType(resource.contentType)}`,
      sizeBytes: bytes.byteLength,
    });
  }
  return assets;
};

const extensionForContentType = (contentType: string): string => {
  switch (contentType.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'audio/mpeg':
      return '.mp3';
    case 'video/mp4':
      return '.mp4';
    default:
      return '.bin';
  }
};

export const loadPlayerCss = async (): Promise<string> => {
  const [styles, fonts, mathStyles, katexStyles, mathliveFonts] = await Promise.all([
    readFile(path.join(PLAYER_ROOT, 'styles.css'), 'utf8'),
    readFile(path.join(PLAYER_ROOT, 'fonts/fonts.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/tiptap-mathlive/styles.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'node_modules/katex/dist/katex.min.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'node_modules/mathlive/mathlive-fonts.css'), 'utf8'),
  ]);
  const fontsBase = PLAYER_FONTS_URL_PREFIX;
  // The harness writes one self-contained stylesheet instead of letting a browser bundler
  // resolve package CSS imports. Preserve the same KaTeX/MathLive font declarations used by
  // the role apps, while rewriting their relative URLs to bounded local harness routes.
  const staticMathStyles = [
    katexStyles.replaceAll('url(fonts/', `url(${KATEX_FONTS_URL_PREFIX}`),
    mathliveFonts.replaceAll('url(fonts/', `url(${MATHLIVE_FONTS_URL_PREFIX}`),
    mathStyles.replace(/^@import .*;$/gm, ''),
  ].join('\n');
  return (
    (await loadSharedAttachmentCss()) +
    '\n' +
    styles
      .replace("@import '@reachany/tiptap-mathlive/styles.css';", staticMathStyles)
      .replace("@import './fonts/fonts.css';", fonts.replaceAll('url("./', `url("${fontsBase}`))
  );
};

const harnessCss = `
:root{font-family:Inter,system-ui,sans-serif;color:#172024;background:#e7edf2}*{box-sizing:border-box}
body{margin:0}.harness-shell{min-height:100vh;padding:16px}.harness-header{display:flex;align-items:flex-start;gap:18px;justify-content:space-between;margin:0 auto 14px;max-width:1680px}.harness-header>div{display:grid;gap:3px}.harness-header span{font-size:12px;color:#60707b}.harness-header nav{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.harness-header button{border:1px solid #aab7c1;background:#fff;color:#172024;border-radius:6px;padding:6px 9px;cursor:pointer}.harness-header button[aria-current=page]{background:#172024;color:#fff}.harness-player{max-width:1680px;margin:auto;background:#fff;box-shadow:0 16px 44px #17202424}.harness-evidence{max-width:1680px;margin:14px auto 0;background:#172024;color:#d8e4ec;border-radius:6px;padding:10px 12px}.harness-evidence>div{display:flex;gap:16px;font:12px ui-monospace,monospace}.harness-evidence pre{max-height:180px;overflow:auto;margin:8px 0 0;font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap}@media(max-width:700px){.harness-shell{padding:8px}.harness-header{display:block}.harness-header nav{justify-content:flex-start;margin-top:8px}.harness-evidence{display:none}}
`;

const playerHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reach Deck Player harness</title><link rel="stylesheet" href="/player.css"></head><body><div id="root"></div><script src="/player.js"></script></body></html>`;

export const prepareReachDeckPlayerHarness = async (input: {
  assetsByResourceId: ReadonlyMap<string, PlayerHarnessAsset>;
  document: ReachDeckDocumentV2;
  outputDirectory: string;
  source: PlayerHarnessConfig['source'];
  timingSource: PlayerHarnessConfig['timingSource'];
  validatesTtsAlignment?: boolean;
}): Promise<PreparedPlayerHarness> => {
  const document = parseReachDeckDocumentV2(input.document);
  const outputDirectory = resolveTemporaryOutputDirectory(input.outputDirectory);
  const declaredIds = new Set(document.resources.media.map((resource) => resource.id));
  const unexpected = [...input.assetsByResourceId.keys()].find((id) => !declaredIds.has(id));
  if (unexpected !== undefined)
    throw new Error(`Harness asset ${unexpected} is not declared by the document.`);
  const missing = [...declaredIds].find((id) => !input.assetsByResourceId.has(id));
  if (missing !== undefined)
    throw new Error(`Harness document resource ${missing} has no local bytes.`);

  await mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
  const resourceUrlsById: Record<string, string> = {};
  const assetEvidence: Record<string, Omit<PlayerHarnessAsset, 'bytes'>> = {};
  for (const [resourceId, asset] of input.assetsByResourceId) {
    if (asset.sizeBytes !== asset.bytes.byteLength) {
      throw new Error(`Harness asset ${resourceId} sizeBytes does not match its bytes.`);
    }
    const checksum = createHash('sha256').update(asset.bytes).digest('hex');
    if (asset.checksumSha256 !== checksum) {
      throw new Error(`Harness asset ${resourceId} checksumSha256 does not match its bytes.`);
    }
    const safeFileName = `${encodeURIComponent(resourceId)}${path.extname(asset.fileName) || extensionForContentType(asset.contentType)}`;
    await writeFile(path.join(outputDirectory, 'assets', safeFileName), asset.bytes);
    resourceUrlsById[resourceId] = `/assets/${safeFileName}`;
    assetEvidence[resourceId] = {
      checksumSha256: asset.checksumSha256,
      contentType: asset.contentType,
      fileName: `assets/${safeFileName}`,
      sizeBytes: asset.sizeBytes,
    };
  }

  const bundle = await build({
    absWorkingDir: REPOSITORY_ROOT,
    alias: {
      '@reachany/reach-deck-player': path.join(PLAYER_ROOT, 'dist/index.js'),
    },
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryPoints: [ENTRY_FILE],
    format: 'iife',
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    nodePaths: [path.join(REPOSITORY_ROOT, 'node_modules')],
    write: false,
  });
  const config: PlayerHarnessConfig = {
    source: input.source,
    timingSource: input.timingSource,
    validatesTtsAlignment: input.validatesTtsAlignment ?? false,
    resourceUrlsById,
  };
  await Promise.all([
    writeFile(path.join(outputDirectory, 'player.html'), playerHtml, 'utf8'),
    writeFile(path.join(outputDirectory, 'index.html'), playerHtml, 'utf8'),
    writeFile(path.join(outputDirectory, 'player.js'), bundle.outputFiles[0]!.text, 'utf8'),
    writeFile(
      path.join(outputDirectory, 'player.css'),
      `${await loadPlayerCss()}\n${harnessCss}`,
      'utf8',
    ),
    writeFile(
      path.join(outputDirectory, 'document.json'),
      `${JSON.stringify(document, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      path.join(outputDirectory, 'harness-config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      path.join(outputDirectory, 'asset-evidence.json'),
      `${JSON.stringify(assetEvidence, null, 2)}\n`,
      'utf8',
    ),
  ]);
  return {
    config,
    document,
    outputDirectory,
    playerHtml: path.join(outputDirectory, 'player.html'),
  };
};

export const contentTypeForPath = (file: string): string => {
  switch (path.extname(file).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.ogg':
      return 'audio/ogg';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    default:
      return 'application/octet-stream';
  }
};

export const safeDecodedPath = (value: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes('\0') || decoded.split('/').includes('..')) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
};

export const resolvePlayerHarnessFontFile = (pathname: string): string | undefined => {
  for (const [urlPrefix, root] of HARNESS_FONT_DIRECTORIES) {
    if (!pathname.startsWith(urlPrefix)) continue;
    const relative = safeDecodedPath(pathname.slice(urlPrefix.length));
    const candidate = relative === undefined ? undefined : path.resolve(root, relative);
    return candidate !== undefined && isChildOf(root, candidate) ? candidate : undefined;
  }
  return undefined;
};

export const startReachDeckPlayerHarnessServer = async (
  outputDirectory: string,
  requestedPort = 0,
): Promise<{ close: () => Promise<void>; origin: string; server: Server }> => {
  await Promise.all([
    access(path.join(outputDirectory, 'player.html')),
    access(FUNCTION_PLOT_FILE),
    ...EXTERNAL_RUNTIME_FILES.values().map((file) => access(file)),
  ]);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    let file: string | undefined;
    let immutable = false;
    if (pathname === '/' || pathname === '/player.html')
      file = path.join(outputDirectory, 'player.html');
    else if (
      [
        '/player.js',
        '/player.css',
        '/document.json',
        '/harness-config.json',
        '/asset-evidence.json',
      ].includes(pathname)
    ) {
      file = path.join(outputDirectory, pathname.slice(1));
    } else if (pathname.startsWith('/assets/')) {
      const decoded = safeDecodedPath(pathname.slice('/assets/'.length));
      if (decoded !== undefined && !decoded.includes('/'))
        file = path.join(outputDirectory, 'assets', decoded);
    } else if (pathname === FUNCTION_PLOT_SCRIPT_PATH || EXTERNAL_RUNTIME_FILES.has(pathname)) {
      file =
        pathname === FUNCTION_PLOT_SCRIPT_PATH
          ? FUNCTION_PLOT_FILE
          : EXTERNAL_RUNTIME_FILES.get(pathname);
      immutable = true;
      response.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      file = resolvePlayerHarnessFontFile(pathname);
    }
    if (file === undefined) {
      response.writeHead(404).end('Not found');
      return;
    }
    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Not a file');
      size = info.size;
    } catch {
      response.writeHead(404).end('Not found');
      return;
    }
    response.setHeader('Content-Type', contentTypeForPath(file));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Accept-Ranges', 'bytes');
    if (immutable) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    let start = 0;
    let end = size - 1;
    // Local media are complete files. Chrome requires byte ranges and a known
    // length to discover MP3 duration and perform reliable audio seeking.
    if (request.method === 'GET' && request.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      const first = range?.[1];
      const last = range?.[2];
      if (range && (first || last)) {
        if (first) {
          start = Number(first);
          end = last ? Math.min(Number(last), size - 1) : size - 1;
        } else {
          start = Math.max(0, size - Number(last));
        }
      }
      if (
        !range ||
        (!first && !last) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        response
          .writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
          .end();
        return;
      }
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    response.setHeader('Content-Length', Math.max(0, end - start + 1));
    if (request.method === 'HEAD' || size === 0) {
      response.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    response.once('close', () => stream.destroy());
    stream
      .once('error', () => {
        response.destroy();
      })
      .pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Harness server has no TCP address.');
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    origin: `http://127.0.0.1:${address.port}`,
    server,
  };
};

export const playerHarnessFileUrl = (prepared: PreparedPlayerHarness): string =>
  pathToFileURL(prepared.playerHtml).href;
