/**
 * 免登录的 Reach Deck 四阶段调试工作台（服务端）。
 *
 * 它只替换"登录"这一环：页面通过本进程的 `/api/reach-deck/*` 访问**真实**的
 * AI Runtime，鉴权、队列、worker、落库全部走正式代码，因此在这里调出来的结论
 * 迁回教师端不会缺斤少两。与教师端 BFF 的唯一差别是身份来源——那边从 Portal
 * 会话派生，这里用一组固定的本地开发身份，两者共用 `@reachany/reach-deck-bff`。
 *
 * 安全边界：只绑回环地址、只接受同源请求、只允许把 token 签给回环的 AI Runtime、
 * 产物只写仓库 `tmp/`。这些限制让它无法被用来对非本地环境签发服务 token。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

import { readHs256ServiceJwtConfig } from '@reachany/auth';
import {
  buildReachDeckProxyRequest,
  normalizeReachDeckUuidScope,
  type ReachDeckProxyIdentity,
  type ReachDeckUuidScope,
} from '@reachany/reach-deck-bff';
import { build } from 'esbuild';
import { generateHarnessHtml, htmlLayoutConfig } from './html-layout-server.js';
import {
  loadPlayerCss,
  resolvePlayerHarnessFontFile,
  contentTypeForPath,
} from './player-harness.js';

import { REACH_DECK_PROMPT_SNIPPETS } from '../../lib/reach-deck/prompts/index.js';
import {
  listDeckHarnessEvidence,
  readDeckHarnessEvidence,
} from '../../lib/reach-deck/harness-evidence.js';
import {
  isReachDeckHarnessModeEnabled,
  REACH_DECK_HARNESS_MODE_ENV,
} from '../../lib/reach-deck/harness-mode.js';

export const DECK_HARNESS_HOST = '127.0.0.1';
export const DECK_HARNESS_DEFAULT_AI_RUNTIME_URL = 'http://127.0.0.1:3050';
/** 代理请求体上限：素材上传走 AI Runtime 自己的预签名通道，这里只过控制面 JSON。 */
export const DECK_HARNESS_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const ENTRY_FILE = path.join(import.meta.dirname, 'deck-harness-entry.tsx');
const PROXY_PREFIX = '/api/reach-deck/';

const PUBLIC_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-src 'self' about:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join('; '),
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

/** 工作台默认的本地开发身份与资源范围，可整体由环境变量覆盖。 */
export interface DeckHarnessScopeConfig extends ReachDeckUuidScope {
  actorId: string;
  roleGrantId: string;
  role: 'teacher' | 'admin';
  moduleTitle?: string;
}

export interface DeckHarnessServer {
  origin: string;
  close: () => Promise<void>;
  server: Server;
}

export interface PreparedDeckHarness {
  outputDirectory: string;
}

const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Reach Deck 四阶段调试工作台</title>
    <link rel="stylesheet" href="/deck-harness.css">
  </head>
  <body>
    <div id="root"></div>
    <script src="/deck-harness.js"></script>
  </body>
</html>
`;

/** pnpm 会把 `--` 原样转发进来；剥掉它，让两种调用写法都成立。 */
export function normalizeDeckHarnessCliArguments(argv: readonly string[]): string[] {
  return argv[0] === '--' ? [...argv.slice(1)] : [...argv];
}

/** 产物必须落在仓库 tmp/ 或 .tmp/ 下，避免调试文件散进业务目录。 */
export function resolveDeckHarnessOutputDirectory(requested: string): string {
  const outputDirectory = path.resolve(REPOSITORY_ROOT, requested);
  if (
    !['tmp', '.tmp'].some((directory) =>
      isChildOf(path.join(REPOSITORY_ROOT, directory), outputDirectory),
    )
  ) {
    throw new Error('The deck harness output must be inside repository tmp/ or .tmp/.');
  }
  return outputDirectory;
}

/**
 * 校验上游 AI Runtime 地址。
 *
 * 只允许明文 HTTP 的回环地址：工作台会为任意请求签发服务 token，
 * 放开到任意主机就等于把一把免登录的钥匙指向了非本地环境。
 */
export function resolveDeckHarnessAiRuntimeUrl(configured: string): string {
  const url = new URL(configured);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'http:' ||
    !isLoopbackHostname(hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('The deck harness AI Runtime URL must be a plain loopback http origin.');
  }
  return url.origin;
}

const SCOPE_ENV_KEYS = {
  organizationId: 'REACH_DECK_HARNESS_ORGANIZATION_ID',
  courseId: 'REACH_DECK_HARNESS_COURSE_ID',
  courseNodeId: 'REACH_DECK_HARNESS_COURSE_NODE_ID',
  moduleId: 'REACH_DECK_HARNESS_MODULE_ID',
  moduleVersionId: 'REACH_DECK_HARNESS_MODULE_VERSION_ID',
  actorId: 'REACH_DECK_HARNESS_ACTOR_ID',
  roleGrantId: 'REACH_DECK_HARNESS_ROLE_GRANT_ID',
} as const;

/**
 * 调试课程的默认资源范围与操作者身份。
 *
 * 课程/章节/模块可以是假的：它们只经过内存版 content-service。但**组织与操作者
 * 必须真实存在**——AI Runtime 会把每次运行投影进自己的 `public.ai_run`，那张表带有
 * 指向 organization/account 的外键，且不经 content-service，替身伪造不了。
 * 用了默认值会在第一个阶段撞上外键约束失败，因此启动时就警告。
 *
 * 固定值而非随机值：重启工作台后仍能接着调上一次的工作区。
 */
export const DECK_HARNESS_DEFAULT_SCOPE = Object.freeze({
  organizationId: '0e00d0c0-0000-4000-8000-000000000001',
  courseId: '0e00d0c0-0000-4000-8000-000000000002',
  courseNodeId: '0e00d0c0-0000-4000-8000-000000000003',
  moduleId: '0e00d0c0-0000-4000-8000-000000000004',
  moduleVersionId: '0e00d0c0-0000-4000-8000-000000000005',
  actorId: '0e00d0c0-0000-4000-8000-000000000006',
  roleGrantId: '0e00d0c0-0000-4000-8000-000000000007',
} as const);

/**
 * 读取调试课程的资源范围与操作者身份。
 *
 * 数据源：`REACH_DECK_HARNESS_*` 环境变量，缺省时回落到
 * `DECK_HARNESS_DEFAULT_SCOPE`。工作台与内存版 content-service 必须读同一份配置，
 * 否则替身会认不出这门课。
 */
export function readDeckHarnessScopeConfig(
  env: Partial<Record<string, string | undefined>> = process.env,
): DeckHarnessScopeConfig {
  const read = (key: keyof typeof SCOPE_ENV_KEYS): string =>
    (env[SCOPE_ENV_KEYS[key]] ?? '').trim() || DECK_HARNESS_DEFAULT_SCOPE[key];
  const scope = normalizeReachDeckUuidScope({
    organizationId: read('organizationId'),
    courseId: read('courseId'),
    courseWorkspaceType: 'draft',
    courseNodeId: read('courseNodeId'),
    moduleId: read('moduleId'),
    moduleVersionId: read('moduleVersionId'),
  });
  return {
    ...scope,
    actorId: read('actorId').toLowerCase(),
    roleGrantId: read('roleGrantId').toLowerCase(),
    role: 'teacher',
    moduleTitle: env.REACH_DECK_HARNESS_MODULE_TITLE?.trim() || 'Deck Harness 调试模块',
  };
}

/**
 * 仍在使用内置默认值的组织/操作者变量名。
 *
 * 这两项必须指向共享库里真实存在的记录，否则第一个阶段会以一条难懂的外键约束
 * 错误失败；把它变成启动时的明确提示。
 */
export function unconfiguredDeckHarnessIdentityKeys(
  env: Partial<Record<string, string | undefined>> = process.env,
): string[] {
  return (['organizationId', 'actorId'] as const)
    .filter((key) => (env[SCOPE_ENV_KEYS[key]] ?? '').trim().length === 0)
    .map((key) => SCOPE_ENV_KEYS[key]);
}

/** 打包前端并写出静态资源。 */
export async function prepareDeckHarness(input: {
  outputDirectory: string;
}): Promise<PreparedDeckHarness> {
  const outputDirectory = resolveDeckHarnessOutputDirectory(input.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const bundle = await build({
    absWorkingDir: REPOSITORY_ROOT,
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryPoints: [ENTRY_FILE],
    format: 'iife',
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    plugins: [
      {
        name: 'html-layout-tailwind-theme',
        setup(plugin) {
          plugin.onResolve({ filter: /^tailwindcss\/theme\.css\?raw$/ }, () => ({
            path: createRequire(import.meta.url).resolve('tailwindcss/theme.css'),
            namespace: 'raw-css',
          }));
          plugin.onLoad({ filter: /.*/, namespace: 'raw-css' }, async ({ path: file }) => ({
            contents: await readFile(file, 'utf8'),
            loader: 'text',
          }));
        },
      },
    ],
    nodePaths: [path.join(REPOSITORY_ROOT, 'node_modules')],
    write: false,
  });
  const javascript = bundle.outputFiles[0];
  if (javascript === undefined) throw new Error('The deck harness bundle was not emitted.');
  await Promise.all([
    writeFile(path.join(outputDirectory, 'index.html'), HARNESS_HTML, 'utf8'),
    writeFile(path.join(outputDirectory, 'deck-harness.js'), javascript.text, 'utf8'),
    writeFile(path.join(outputDirectory, 'deck-harness.css'), await loadHarnessCss(), 'utf8'),
  ]);
  return { outputDirectory };
}

export async function startDeckHarnessServer(input: {
  aiRuntimeUrl: string;
  outputDirectory: string;
  port?: number;
  scope: DeckHarnessScopeConfig;
  env?: Partial<Record<string, string | undefined>>;
}): Promise<DeckHarnessServer> {
  const outputDirectory = resolveDeckHarnessOutputDirectory(input.outputDirectory);
  const aiRuntimeUrl = resolveDeckHarnessAiRuntimeUrl(input.aiRuntimeUrl);
  await Promise.all(
    ['index.html', 'deck-harness.js', 'deck-harness.css'].map((file) =>
      access(path.join(outputDirectory, file)),
    ),
  );
  const env = input.env ?? process.env;
  if (env.REACH_DECK_HARNESS_HTML_LAYOUT === 'on' && !isReachDeckHarnessModeEnabled(env)) {
    throw new Error('HTML layout trial requires REACH_DECK_HARNESS_MODE=on');
  }
  const configuredJwt = readHs256ServiceJwtConfig(env);
  // 服务 JWT 配置里的 audience 可缺省；AI Runtime 校验时用的是同一个默认值。
  const jwt = {
    audience: configuredJwt.audience ?? 'reachany-services',
    ...(configuredJwt.issuer === undefined ? {} : { issuer: configuredJwt.issuer }),
    secret: configuredJwt.secret,
  };
  const identity: ReachDeckProxyIdentity = {
    subject: input.scope.actorId,
    roleGrantId: input.scope.roleGrantId,
    orgId: input.scope.organizationId,
    roles: [input.scope.role],
  };

  const activeRequests = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    applyPublicHeaders(response);
    const task = handleDeckHarnessRequest(request, response, {
      aiRuntimeUrl,
      identity,
      jwt,
      outputDirectory,
      scope: input.scope,
      server,
      harnessModeEnabled: isReachDeckHarnessModeEnabled(env),
      env,
    }).catch(() => {
      if (!response.headersSent) writeJson(response, 500, { error: 'harness request failed' });
      else response.end();
    });
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port ?? 0, DECK_HARNESS_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('The deck harness server has no TCP address.');
  }
  return {
    origin: `http://${DECK_HARNESS_HOST}:${address.port}`,
    close: async () => {
      await closeServer(server);
      await Promise.allSettled([...activeRequests]);
    },
    server,
  };
}

interface HarnessRequestContext {
  env: Partial<Record<string, string | undefined>>;
  aiRuntimeUrl: string;
  identity: ReachDeckProxyIdentity;
  jwt: { audience: string; issuer?: string; secret: string };
  outputDirectory: string;
  scope: DeckHarnessScopeConfig;
  server: Server;
  harnessModeEnabled: boolean;
}

async function handleDeckHarnessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HarnessRequestContext,
): Promise<void> {
  const address = context.server.address();
  if (address === null || typeof address === 'string') {
    writeJson(response, 500, { error: 'harness has no address' });
    return;
  }
  const expectedOrigin = `http://${DECK_HARNESS_HOST}:${address.port}`;
  const pathname = safePathname(request.url);
  if (pathname === '/harness/generation-evidence') {
    if (
      !context.harnessModeEnabled ||
      request.method !== 'GET' ||
      !isSameOriginRequest(request, expectedOrigin)
    ) {
      response.writeHead(404).end();
      return;
    }
    const query = new URL(request.url ?? '/', expectedOrigin).searchParams;
    const runId = query.get('runId');
    const jobId = query.get('jobId');
    if (!runId || runId.length > 256 || (jobId !== null && (!jobId || jobId.length > 256))) {
      writeJson(response, 400, { error: 'A bounded run identity is required' });
      return;
    }
    const scope = {
      actorId: context.scope.actorId,
      roleGrantId: context.scope.roleGrantId,
      resourceScope: context.scope,
    };
    if (jobId === null) {
      writeJson(response, 200, {
        entries: await listDeckHarnessEvidence(scope, runId, context.env),
      });
    } else {
      const entry = await readDeckHarnessEvidence(scope, jobId, context.env);
      if (!entry || entry.runId !== runId) response.writeHead(404).end();
      else writeJson(response, 200, entry);
    }
    return;
  }
  if (pathname === '/harness/media-resources' || pathname.startsWith('/harness/media/')) {
    if (
      !isSameOriginRequest(request, expectedOrigin) ||
      !['GET', 'HEAD'].includes(request.method ?? '')
    ) {
      response.writeHead(404).end();
      return;
    }
    const configured = context.env.REACH_DECK_HARNESS_CONTENT_URL;
    if (!configured) {
      if (pathname === '/harness/media-resources')
        writeJson(response, 200, { resourceUrlsByObjectKey: {} });
      else response.writeHead(404).end();
      return;
    }
    const contentOrigin = resolveDeckHarnessAiRuntimeUrl(configured);
    const manifestResponse = await fetch(
      `${contentOrigin}/api/v1/reach-deck/courses/${context.scope.courseId}/nodes/${context.scope.courseNodeId}/generated-media-resources`,
      { redirect: 'error', signal: AbortSignal.timeout(10_000) },
    );
    if (!manifestResponse.ok) {
      writeJson(response, 502, { error: '内存媒体清单读取失败' });
      return;
    }
    const envelope = (await manifestResponse.json()) as { data?: Record<string, unknown> };
    const manifest = envelope.data;
    if (
      !manifest ||
      !['organizationId', 'courseId', 'courseNodeId', 'moduleId', 'moduleVersionId'].every(
        (key) => manifest[key] === context.scope[key as keyof DeckHarnessScopeConfig],
      ) ||
      manifest.courseWorkspaceType !== 'draft' ||
      !Array.isArray(manifest.media)
    ) {
      writeJson(response, 403, { error: '内存媒体资源范围不匹配' });
      return;
    }
    const knownKeys = new Set(
      manifest.media.flatMap((item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { objectKey?: unknown }).objectKey === 'string'
          ? [(item as { objectKey: string }).objectKey]
          : [],
      ),
    );
    if (pathname === '/harness/media-resources') {
      writeJson(response, 200, {
        resourceUrlsByObjectKey: Object.fromEntries(
          [...knownKeys].map((key) => [key, `/harness/media/${encodeURIComponent(key)}`]),
        ),
      });
      return;
    }
    const objectKey = decodeURIComponent(pathname.slice('/harness/media/'.length));
    if (!knownKeys.has(objectKey)) {
      response.writeHead(404).end();
      return;
    }
    const upstream = await fetch(
      `${contentOrigin}/harness-media/${encodeURIComponent(objectKey)}`,
      {
        method: request.method,
        headers: typeof request.headers.range === 'string' ? { range: request.headers.range } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) response.setHeader(header, value);
    }
    response.writeHead(upstream.status);
    response.end(request.method === 'HEAD' ? undefined : Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  const fontFile = resolvePlayerHarnessFontFile(pathname);
  if (fontFile && request.method === 'GET') {
    response.setHeader('Content-Type', contentTypeForPath(fontFile));
    response.end(await readFile(fontFile));
    return;
  }

  if (pathname === '/harness/html-layout-config' || pathname === '/harness/html-layout') {
    if (
      !context.harnessModeEnabled ||
      context.env.REACH_DECK_HARNESS_HTML_LAYOUT !== 'on' ||
      !isSameOriginRequest(request, expectedOrigin)
    ) {
      response.writeHead(404).end();
      return;
    }
    if (pathname.endsWith('-config') && request.method === 'GET') {
      writeJson(response, 200, await htmlLayoutConfig(context.env));
      return;
    }
    if (pathname === '/harness/html-layout' && request.method === 'POST') {
      if (
        request.headers.origin !== expectedOrigin ||
        !request.headers['content-type']?.startsWith('application/json')
      ) {
        writeJson(response, 403, { error: 'Same-origin JSON request required' });
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 240_000);
      response.once('close', () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        const result = await generateHarnessHtml(
          JSON.parse((await readRequestBody(request)).toString('utf8')),
          context.env,
          controller.signal,
        );
        writeJson(response, 200, result);
      } catch (error) {
        writeJson(response, 400, {
          error: error instanceof Error ? error.message : 'HTML generation failed',
        });
      } finally {
        clearTimeout(timeout);
      }
      return;
    }
    response.writeHead(405).end();
    return;
  }

  if (pathname === '/harness/config') {
    if (request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    writeJson(response, 200, {
      // 前端用它构造 ReachDeckClient 的 module context，与教师端同构。
      moduleContext: {
        organizationId: context.scope.organizationId,
        courseId: context.scope.courseId,
        courseWorkspaceType: context.scope.courseWorkspaceType,
        courseNodeId: context.scope.courseNodeId,
        moduleId: context.scope.moduleId,
        moduleVersionId: context.scope.moduleVersionId,
        ...(context.scope.moduleTitle === undefined
          ? {}
          : { moduleTitle: context.scope.moduleTitle }),
      },
      aiRuntimeUrl: context.aiRuntimeUrl,
      harnessModeEnabled: context.harnessModeEnabled,
      harnessModeEnvKey: REACH_DECK_HARNESS_MODE_ENV,
      htmlLayoutOnly: context.env.REACH_DECK_HARNESS_HTML_LAYOUT === 'on',
      slidesOnly: context.harnessModeEnabled && context.env.REACH_DECK_HARNESS_SLIDES_ONLY === 'on',
      // 可覆盖 snippet 的默认正文：页面据此展示原文并支持编辑。
      promptSnippets: REACH_DECK_PROMPT_SNIPPETS,
    });
    return;
  }

  if (pathname.startsWith(PROXY_PREFIX)) {
    if (!isSameOriginRequest(request, expectedOrigin)) {
      response.writeHead(404).end();
      return;
    }
    await proxyToAiRuntime(request, response, context, pathname.slice(PROXY_PREFIX.length));
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(404).end();
    return;
  }
  const fileName =
    pathname === '/'
      ? 'index.html'
      : pathname === '/deck-harness.js'
        ? 'deck-harness.js'
        : pathname === '/deck-harness.css'
          ? 'deck-harness.css'
          : undefined;
  if (fileName === undefined) {
    response.writeHead(404).end();
    return;
  }
  const file = path.join(context.outputDirectory, fileName);
  response.setHeader('Content-Type', contentTypeFor(fileName));
  if (request.method === 'HEAD') {
    response.writeHead(200).end();
    return;
  }
  response.writeHead(200).end(await readFile(file));
}

/**
 * 把一次页面请求转成带签名 token 的上游请求。
 *
 * 核心逻辑：
 * 1. 按 `ReachDeckClient` 的约定从 query 读六元 scope，并强制它等于本工作台配置的
 *    调试课程——页面改 query 也越不出这门课；
 * 2. 交给共享包签 token、注入 scope header、拼上游 URL；
 * 3. 原样回传状态码与响应体，SSE 直接流式透传，事件不做缓冲。
 */
async function proxyToAiRuntime(
  request: IncomingMessage,
  response: ServerResponse,
  context: HarnessRequestContext,
  upstreamPath: string,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', `http://${DECK_HARNESS_HOST}`);
  const searchParams = requestUrl.searchParams;
  for (const [key, expected] of [
    ['organizationId', context.scope.organizationId],
    ['courseId', context.scope.courseId],
    ['courseNodeId', context.scope.courseNodeId],
    ['moduleId', context.scope.moduleId],
    ['moduleVersionId', context.scope.moduleVersionId],
  ] as const) {
    const supplied = searchParams.get(key)?.trim().toLowerCase();
    if (supplied !== undefined && supplied !== expected) {
      writeJson(response, 403, { error: `deck harness scope is fixed: ${key}` });
      return;
    }
  }

  let body: Buffer | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      body = await readRequestBody(request);
    } catch {
      writeJson(response, 413, { error: 'request body is too large' });
      return;
    }
  }

  const incomingHeaders = new Headers();
  for (const key of ['accept', 'content-type', 'idempotency-key', 'last-event-id']) {
    const value = request.headers[key];
    if (typeof value === 'string') incomingHeaders.set(key, value);
  }

  const upstream = await buildReachDeckProxyRequest({
    baseUrl: context.aiRuntimeUrl,
    // 工作台只代理控制面 JSON：素材上传走 AI Runtime 自己的预签名直传，不经这里，
    // 所以请求体按 UTF-8 文本转发即可。
    ...(body === undefined ? {} : { body: body.toString('utf8') }),
    context: {
      organizationId: context.scope.organizationId,
      courseId: context.scope.courseId,
      courseWorkspaceType: 'draft',
      courseNodeId: context.scope.courseNodeId,
      moduleId: context.scope.moduleId,
      moduleVersionId: context.scope.moduleVersionId,
      billingGroupId: null,
      identity: context.identity,
      ...(context.scope.moduleTitle === undefined
        ? {}
        : { moduleTitle: context.scope.moduleTitle }),
      role: context.scope.role,
      tokenOptions: {
        audience: context.jwt.audience,
        ...(context.jwt.issuer === undefined ? {} : { issuer: context.jwt.issuer }),
        secret: context.jwt.secret,
      },
    },
    incomingHeaders,
    method: request.method ?? 'GET',
    path: upstreamPath.split('/').filter((segment) => segment.length > 0),
    searchParams,
  });

  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  const upstreamResponse = await fetch(upstream.url, {
    ...upstream.init,
    signal: controller.signal,
  });
  const headers: Record<string, string> = {};
  for (const key of ['content-type', 'cache-control', 'retry-after', 'x-accel-buffering']) {
    const value = upstreamResponse.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  response.writeHead(upstreamResponse.status, headers);
  if (upstreamResponse.body === null) {
    response.end();
    return;
  }
  // SSE 与普通 JSON 走同一条流式路径；事件到达即写出，不额外缓冲。
  const stream = Readable.fromWeb(upstreamResponse.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.pipe(response);
  await new Promise<void>((resolve) => {
    stream.once('end', resolve);
    stream.once('error', () => {
      if (!response.writableEnded) response.end();
      resolve();
    });
  });
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.byteLength;
    if (size > DECK_HARNESS_MAX_REQUEST_BYTES) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 只接受同源请求；跨源页面无法借这个端口调用真实 AI Runtime。 */
function isSameOriginRequest(request: IncomingMessage, expectedOrigin: string): boolean {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== expectedOrigin) return false;
  const referer = request.headers.referer;
  if (typeof referer === 'string' && !referer.startsWith(`${expectedOrigin}/`)) return false;
  return true;
}

function safePathname(requestUrl: string | undefined): string {
  const url = new URL(requestUrl ?? '/', `http://${DECK_HARNESS_HOST}`);
  const normalized = url.pathname.replace(/\/+$/, '') || '/';
  return normalized.includes('..') ? '/' : normalized;
}

function contentTypeFor(fileName: string): string {
  if (fileName.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (fileName.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function applyPublicHeaders(response: ServerResponse): void {
  for (const [key, value] of Object.entries(PUBLIC_HEADERS)) response.setHeader(key, value);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(body);
}

async function loadHarnessCss(): Promise<string> {
  const player = await loadPlayerCss();
  return `${player}\n${HARNESS_CSS}`;
}

function isChildOf(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

const HARNESS_CSS = `
:root { color-scheme: light; --harness-border: #d4d8de; --harness-muted: #5b6472; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #15181d; background: #f6f7f9; }
.harness { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; min-height: 100vh; }
.harness__rail { border-right: 1px solid var(--harness-border); background: #fff; padding: 16px; overflow-y: auto; }
.harness__main { padding: 16px; overflow-y: auto; }
.harness__title { margin: 0 0 4px; font-size: 16px; font-weight: 650; }
.harness__hint { margin: 0 0 16px; color: var(--harness-muted); font-size: 12px; }
.stage { border: 1px solid var(--harness-border); border-radius: 8px; background: #fff; margin-bottom: 12px; }
.stage__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; }
.stage__index { width: 22px; height: 22px; border-radius: 50%; background: #eef1f5; display: grid; place-items: center; font-size: 12px; }
.stage__name { font-weight: 600; flex: 1; }
.stage__state { font-size: 12px; color: var(--harness-muted); }
.stage__body { padding: 0 12px 12px; border-top: 1px solid #eef1f5; }
.panel { margin-top: 12px; }
.panel__label { font-size: 12px; font-weight: 600; color: var(--harness-muted); margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
textarea, pre { width: 100%; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid var(--harness-border); border-radius: 6px; padding: 8px; background: #fbfcfd; }
textarea { min-height: 140px; resize: vertical; }
pre { max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--harness-border); background: #fff; cursor: pointer; }
button[data-variant="primary"] { background: #1f6feb; border-color: #1f6feb; color: #fff; }
button:disabled { opacity: .5; cursor: not-allowed; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.banner { border: 1px solid #f0c36d; background: #fdf6e3; border-radius: 6px; padding: 8px 10px; margin-bottom: 12px; font-size: 12px; }
.banner[data-tone="error"] { border-color: #e5534b; background: #fdeceb; }
.tabs { display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap; }
.tabs button[data-active="true"] { background: #eef1f5; font-weight: 600; }
`;
