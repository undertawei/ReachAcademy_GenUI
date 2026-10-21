import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, ViteDevServer } from 'vite';
import { isConfigured, readModelConfig, safeBaseUrl, type ModelConfig } from './config.js';
import { HttpError } from './errors.js';
import { INTERACTIVE_PROMPT, generateScene, type FetchImplementation } from './provider.js';
import { ProjectStore } from './projects.js';
import { RuntimeStore, INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from './runtime.js';
import { validateRequest } from './scenes.js';
import { DEMO_SCENE } from './demo.js';

export const WORKSPACE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BODY_LIMIT = 2 * 1024 * 1024;
export interface WorkbenchServerOptions {
  root?: string;
  projectsDirectory?: string;
  publicDirectory?: string;
  distDirectory?: string;
  modelConfig?: ModelConfig;
  fetchImplementation?: FetchImplementation;
  middleware?: Connect.Server | ViteDevServer['middlewares'];
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  response.end(JSON.stringify(value));
}

function assertLocalRequest(request: IncomingMessage): void {
  const address = request.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) {
    throw new HttpError(403, 'local_only', '此工作台仅接受本机连接。');
  }
  const authority = `127.0.0.1:${request.socket.localPort}`;
  if (request.headers.host !== authority) {
    throw new HttpError(403, 'invalid_host', '请通过 http://127.0.0.1 和工作台端口访问。');
  }
  const origin = request.headers.origin;
  // An opaque sandbox can fetch only immutable runtime assets, never API or application data.
  const isRuntime = request.url?.startsWith('/reach-deck-dependencies/') === true;
  if (
    origin &&
    origin !== `http://${authority}` &&
    !(isRuntime && origin === 'null' && request.method === 'GET')
  ) {
    throw new HttpError(403, 'invalid_origin', '拒绝来自其他页面的请求。');
  }
  const site = request.headers['sec-fetch-site'];
  if (site === 'cross-site' && !isRuntime) {
    throw new HttpError(403, 'invalid_origin', '拒绝来自其他页面的请求。');
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'json_required', '接口只接受 application/json。');
  }
  const announcedSize = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(announcedSize) || announcedSize > BODY_LIMIT) {
    request.resume();
    throw new HttpError(413, 'body_too_large', '请求体不能超过 2 MiB。');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > BODY_LIMIT) {
      request.resume();
      throw new HttpError(413, 'body_too_large', '请求体不能超过 2 MiB。');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体必须是有效 JSON。');
  }
}

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function serveDist(
  pathname: string,
  response: ServerResponse,
  directory: string,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'invalid_path', '访问路径格式不正确。');
  }
  if (
    decoded.includes('\0') ||
    decoded.includes('\\') ||
    decoded.split('/').some((part) => part.startsWith('.'))
  ) {
    throw new HttpError(404, 'not_found', '找不到该页面。');
  }
  const root = resolve(directory);
  let path = resolve(root, decoded.slice(1) || 'index.html');
  if (!path.startsWith(`${root}${sep}`)) throw new HttpError(404, 'not_found', '找不到该页面。');
  try {
    if (!(await lstat(path)).isFile()) throw new Error('not_file');
  } catch {
    // Only extensionless navigation routes receive the application shell.
    if (extname(decoded)) throw new HttpError(404, 'not_found', '找不到该文件。');
    path = resolve(root, 'index.html');
  }
  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch {
    throw new HttpError(
      503,
      'ui_not_built',
      '工作台界面尚未构建，请先执行 pnpm build 或使用 pnpm dev。',
    );
  }
  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(path)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  });
  response.end(contents);
}

export function createWorkbenchServer(options: WorkbenchServerOptions = {}) {
  const root = options.root ?? WORKSPACE_ROOT;
  const config = options.modelConfig ?? readModelConfig();
  const projects = new ProjectStore(options.projectsDirectory ?? resolve(root, 'data/projects'));
  const runtimes = new RuntimeStore(
    options.publicDirectory ?? resolve(root, 'apps/workbench/public'),
  );
  let activeGenerations = 0;

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      assertLocalRequest(request);
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      const path = url.pathname;
      const method = request.method ?? 'GET';
      if (method === 'GET' && path.startsWith('/reach-deck-dependencies/')) {
        const contents = await runtimes.get(path);
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=31536000, immutable',
          // These public, pinned bytes are requested by an opaque sandbox with SRI.
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        response.end(contents);
        return;
      }
      if (path.startsWith('/api/')) {
        if (method === 'GET' && path === '/api/status') {
          json(response, 200, {
            configured: isConfigured(config),
            model: config.model,
            baseUrl: safeBaseUrl(config),
            promptVersion: INTERACTIVE_PROMPT.version,
          });
        } else if (method === 'GET' && path === '/api/prompts') {
          json(response, 200, {
            version: INTERACTIVE_PROMPT.version,
            text: INTERACTIVE_PROMPT.text,
          });
        } else if (method === 'GET' && path === '/api/demo') {
          json(response, 200, { scene: DEMO_SCENE });
        } else if (method === 'GET' && path === '/api/runtime') {
          json(response, 200, { runtimes: INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES });
        } else if (method === 'POST' && path === '/api/validate') {
          json(response, 200, { scene: await validateRequest(await body(request)) });
        } else if (method === 'POST' && path === '/api/generate') {
          const input = await body(request);
          // Check and acquire synchronously after reading the body. Otherwise several slow
          // request bodies could all pass a pre-read check before any acquires a slot.
          if (activeGenerations >= 2)
            throw new HttpError(429, 'generation_busy', '已有两个生成任务，请等待完成后再试。');
          activeGenerations += 1;
          const controller = new AbortController();
          const abort = () => {
            if (!response.writableEnded) controller.abort();
          };
          response.once('close', abort);
          try {
            json(
              response,
              200,
              await generateScene(input, config, options.fetchImplementation, controller.signal),
            );
          } finally {
            activeGenerations -= 1;
            response.off('close', abort);
          }
        } else if (path === '/api/projects' && method === 'GET') {
          json(response, 200, { projects: await projects.list() });
        } else if (path === '/api/projects' && method === 'POST') {
          json(response, 200, { project: await projects.save(await body(request)) });
        } else if (path.startsWith('/api/projects/') && method === 'GET') {
          let id: string;
          try {
            id = decodeURIComponent(path.slice('/api/projects/'.length));
          } catch {
            throw new HttpError(400, 'invalid_project_id', '项目 ID 格式不正确。');
          }
          json(response, 200, { project: await projects.load(id) });
        } else {
          throw new HttpError(404, 'not_found', '找不到该接口或不支持此请求方法。');
        }
        return;
      }
      if (method !== 'GET' && method !== 'HEAD')
        throw new HttpError(405, 'method_not_allowed', '不支持此请求方法。');
      if (options.middleware) {
        options.middleware(request, response, () => {
          if (!response.headersSent)
            json(response, 404, { error: '找不到该页面。', code: 'not_found' });
        });
      } else {
        await serveDist(path, response, options.distDirectory ?? resolve(root, 'dist'));
      }
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError)
        json(response, error.status, { error: error.message, code: error.code });
      else
        json(response, 500, {
          error: '工作台处理请求失败，请检查本地文件是否可读写。',
          code: 'internal_error',
        });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 50;
  return server;
}
