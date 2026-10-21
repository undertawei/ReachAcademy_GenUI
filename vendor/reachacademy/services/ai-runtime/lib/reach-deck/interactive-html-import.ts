import { createHash } from 'node:crypto';

import {
  INTERACTIVE_HTML_IMPORT_LIMITS,
  INTERACTIVE_HTML_IMPORTER_VERSION,
  transformUploadedInteractiveHtml,
  type InteractiveHtmlDiagnostic,
} from '@reachany/importer/interactive-html';
import {
  parseInteractiveSceneValue,
  type InteractiveRuntimeDependency,
  type InteractiveScene,
  type ReachDeckDocument,
  type ReachDeckPublishedPage,
} from '@reachany/reach-deck-dsl';

import {
  assertInlineScriptsHaveValidSyntax,
  assertInteractiveDocumentStaticallyCompiles,
} from './interactive-generation-validation.js';
import { parseReachDeckResourceScope, type ReachDeckResourceScope } from './resource-scope.js';

export const REACH_DECK_INTERACTIVE_HTML_PREFLIGHT_SCHEMA_VERSION =
  'reach-deck-interactive-html-preflight/v1' as const;

/**
 * 上传的 Interactive HTML 与 MAIC 导入的旧互动页同级：离线运行、不持久化状态、不计分、
 * 无权威完成。学生刷新即重来。
 */
const UPLOADED_RUNTIME_POLICY = Object.freeze({
  completionMode: 'none' as const,
  allowReset: true,
  maximumDurationSeconds: null,
});
const UPLOADED_EVENT_MANIFEST = Object.freeze({
  schemaVersion: 'reach-interactive-event-manifest/v1' as const,
  events: [] as const,
});

export type ReachDeckInteractiveHtmlDiagnostic = InteractiveHtmlDiagnostic;

export interface ReachDeckInteractiveHtmlCandidate {
  generatedAt: string;
  candidateDigest: `sha256:${string}`;
  /** 只替换目标页的 scene；pageId、order 与标题由目标页决定。 */
  page: Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }>;
  runtimeDependencies: readonly InteractiveRuntimeDependency[];
  documentHtmlUtf8Bytes: number;
}

export interface ReachDeckInteractiveHtmlPreflightSuccess {
  ok: true;
  schemaVersion: typeof REACH_DECK_INTERACTIVE_HTML_PREFLIGHT_SCHEMA_VERSION;
  applicationId: string;
  importerVersion: typeof INTERACTIVE_HTML_IMPORTER_VERSION;
  sourceDigest: `sha256:${string}`;
  pageId: string;
  candidate: ReachDeckInteractiveHtmlCandidate;
  diagnostics: readonly ReachDeckInteractiveHtmlDiagnostic[];
  canApply: boolean;
}

export interface ReachDeckInteractiveHtmlPreflightFailure {
  ok: false;
  schemaVersion: typeof REACH_DECK_INTERACTIVE_HTML_PREFLIGHT_SCHEMA_VERSION;
  applicationId: string;
  importerVersion: typeof INTERACTIVE_HTML_IMPORTER_VERSION;
  pageId: string;
  diagnostics: readonly ReachDeckInteractiveHtmlDiagnostic[];
  canApply: false;
}

export type ReachDeckInteractiveHtmlPreflightResult =
  | ReachDeckInteractiveHtmlPreflightSuccess
  | ReachDeckInteractiveHtmlPreflightFailure;

export interface ReachDeckInteractiveHtmlTargetIdentity {
  draftRevision: number;
  contentDigest: string;
}

export interface ReachDeckInteractiveHtmlUpload {
  bytes: Uint8Array;
  pageId: string;
  sourceDigest?: string;
  candidateDigest?: string;
  importerVersion?: string;
  targetIdentity?: ReachDeckInteractiveHtmlTargetIdentity;
}

export class ReachDeckInteractiveHtmlUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = 'ReachDeckInteractiveHtmlUploadError';
  }
}

export function readInteractiveHtmlIdempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key')?.trim();
  if (value === undefined || value.length === 0 || value.length > 200) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML import requires a non-empty idempotency-key of at most 200 characters',
      400,
    );
  }
  return value;
}

export function buildReachDeckInteractiveHtmlApplicationId(
  scopeValue: ReachDeckResourceScope,
  pageId: string,
  idempotencyKey: string,
): string {
  const scope = parseReachDeckResourceScope(scopeValue);
  const key = idempotencyKey.trim();
  if (key.length === 0 || key.length > 200) {
    throw new Error('Interactive HTML idempotency key is invalid');
  }
  if (pageId.trim().length === 0) throw new Error('Interactive HTML pageId is invalid');
  return `interactive-html-import-${createHash('sha256')
    .update(
      [
        scope.organizationId,
        scope.courseId,
        scope.courseWorkspaceType,
        scope.courseNodeId,
        scope.moduleId,
        scope.moduleVersionId,
        pageId.trim(),
        key,
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

export type ReachDeckInteractiveHtmlTargetLookup =
  | { ok: true; page: Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }> }
  | { ok: false; reason: string };

/**
 * 定位并校验替换目标。上传只替换已存在的 Interactive 页，不创建页、不改变页类型，
 * 因此不需要 MAIC 的整册插入语义。调用方负责把失败原因映射成路由级冲突响应。
 */
export function locateInteractiveHtmlTargetPage(
  document: ReachDeckDocument,
  pageId: string,
): ReachDeckInteractiveHtmlTargetLookup {
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    return { ok: false, reason: 'Interactive HTML upload requires a Reach Deck v2 document' };
  }
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) {
    return { ok: false, reason: `Page ${pageId} does not exist in this Reach Deck` };
  }
  if (page.sceneType !== 'interactive') {
    return {
      ok: false,
      reason: `Page ${pageId} is ${page.sceneType}; only Interactive pages accept an upload`,
    };
  }
  return { ok: true, page };
}

export interface ReachDeckInteractiveHtmlPreflightOptions {
  applicationId: string;
  /** 目标页当前状态。候选页继承其 pageId、order、标题与讲稿。 */
  targetPage: Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }>;
  generatedAt: string;
}

export async function preflightReachDeckInteractiveHtml(
  bytes: Uint8Array,
  options: ReachDeckInteractiveHtmlPreflightOptions,
): Promise<ReachDeckInteractiveHtmlPreflightResult> {
  const { applicationId, targetPage, generatedAt } = options;
  const pageId = targetPage.pageId;
  const transformed = transformUploadedInteractiveHtml(bytes);
  const failure = (
    diagnostics: readonly ReachDeckInteractiveHtmlDiagnostic[],
  ): ReachDeckInteractiveHtmlPreflightFailure => ({
    ok: false,
    schemaVersion: REACH_DECK_INTERACTIVE_HTML_PREFLIGHT_SCHEMA_VERSION,
    applicationId,
    importerVersion: INTERACTIVE_HTML_IMPORTER_VERSION,
    pageId,
    diagnostics,
    canApply: false,
  });
  if (!transformed.ok) return failure(transformed.diagnostics);

  let scene: InteractiveScene;
  try {
    scene = parseInteractiveSceneValue(
      {
        schemaVersion: 'reach-interactive-scene/v2',
        id: pageId,
        title: targetPage.title,
        sceneType: 'interactive',
        documentHtml: transformed.html,
        bridgeVersion: 'reach-interactive-bridge/v1',
        runtimeDependencies: [...transformed.runtimeDependencies],
        runtimePolicy: { ...UPLOADED_RUNTIME_POLICY },
        eventManifest: { ...UPLOADED_EVENT_MANIFEST, events: [] },
        // 讲稿属于页面而不属于上传的 HTML：保留目标页已有的讲稿，重新上传不会把它抹掉。
        ...(targetPage.scene.narration === undefined
          ? {}
          : { narration: targetPage.scene.narration }),
      },
      pageId,
    );
    assertInlineScriptsHaveValidSyntax(scene.documentHtml);
    // 与 Decksmith 写入/提交同款的最后一道内联脚本与样式编译检查（只转译，不执行）。
    await assertInteractiveDocumentStaticallyCompiles(scene.documentHtml);
  } catch (error) {
    return failure([
      ...transformed.diagnostics,
      diagnostic('scene_invalid', readErrorMessage(error)),
    ]);
  }

  const page: ReachDeckInteractiveHtmlCandidate['page'] = {
    ...targetPage,
    revision: targetPage.revision + 1,
    scene,
  };
  return {
    ok: true,
    schemaVersion: REACH_DECK_INTERACTIVE_HTML_PREFLIGHT_SCHEMA_VERSION,
    applicationId,
    importerVersion: INTERACTIVE_HTML_IMPORTER_VERSION,
    sourceDigest: transformed.sourceDigest,
    pageId,
    candidate: {
      generatedAt,
      candidateDigest: createInteractiveHtmlCandidateDigest(scene),
      page,
      runtimeDependencies: transformed.runtimeDependencies,
      documentHtmlUtf8Bytes: Buffer.byteLength(scene.documentHtml, 'utf8'),
    },
    diagnostics: transformed.diagnostics,
    canApply: transformed.diagnostics.every(({ severity }) => severity !== 'error'),
  };
}

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
export const REACH_DECK_INTERACTIVE_HTML_MAX_MULTIPART_BYTES =
  INTERACTIVE_HTML_IMPORT_LIMITS.maxSourceBytes + MULTIPART_OVERHEAD_BYTES;

const ALLOWED_CONTENT_TYPES = new Set(['', 'text/html', 'application/octet-stream']);
const ALLOWED_FIELDS = new Set([
  'file',
  'pageId',
  'sourceDigest',
  'candidateDigest',
  'importerVersion',
  'targetDraftRevision',
  'targetContentDigest',
]);

export async function readInteractiveHtmlUpload(
  request: Request,
): Promise<ReachDeckInteractiveHtmlUpload> {
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML import requires multipart/form-data',
      400,
    );
  }
  let form: FormData;
  try {
    const body = await readBoundedRequestBody(
      request,
      REACH_DECK_INTERACTIVE_HTML_MAX_MULTIPART_BYTES,
    );
    form = await new Response(body.buffer as ArrayBuffer, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch (error) {
    if (error instanceof ReachDeckInteractiveHtmlUploadError) throw error;
    throw new ReachDeckInteractiveHtmlUploadError('Interactive HTML upload form is malformed', 400);
  }
  if ([...form.keys()].some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload contains unsupported multipart fields',
      400,
    );
  }
  const files = form.getAll('file');
  if (files.length !== 1 || !(files[0] instanceof Blob)) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload must contain exactly one file field',
      400,
    );
  }
  const file = files[0];
  if (file.size === 0) {
    throw new ReachDeckInteractiveHtmlUploadError('Interactive HTML upload must not be empty', 400);
  }
  if (file.size > INTERACTIVE_HTML_IMPORT_LIMITS.maxSourceBytes) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload exceeds the 512 KiB input byte limit',
      413,
    );
  }
  const fileName = 'name' in file && typeof file.name === 'string' ? file.name.toLowerCase() : '';
  if (!fileName.endsWith('.html') && !fileName.endsWith('.htm')) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload filename must end with .html or .htm',
      400,
    );
  }
  if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload content type is not supported',
      400,
    );
  }
  const pageIds = form.getAll('pageId');
  if (
    pageIds.length !== 1 ||
    typeof pageIds[0] !== 'string' ||
    pageIds[0].trim().length === 0 ||
    pageIds[0].trim().length > 200
  ) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload must contain exactly one non-empty pageId field',
      400,
    );
  }
  const importerVersions = form.getAll('importerVersion');
  if (
    importerVersions.length > 1 ||
    (importerVersions.length === 1 && typeof importerVersions[0] !== 'string')
  ) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML importerVersion is invalid',
      400,
    );
  }
  const sourceDigest = readOptionalDigest(form, 'sourceDigest');
  const candidateDigest = readOptionalDigest(form, 'candidateDigest');
  const targetIdentity = readTargetIdentity(form);
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    pageId: pageIds[0].trim(),
    ...(sourceDigest === undefined ? {} : { sourceDigest }),
    ...(candidateDigest === undefined ? {} : { candidateDigest }),
    ...(importerVersions.length === 1 ? { importerVersion: importerVersions[0] as string } : {}),
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
  };
}

export function createInteractiveHtmlCandidateDigest(scene: InteractiveScene): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalize(scene)).digest('hex')}`;
}

function diagnostic(
  suffix: string,
  message: string,
  severity: ReachDeckInteractiveHtmlDiagnostic['severity'] = 'error',
): ReachDeckInteractiveHtmlDiagnostic {
  return { code: `html.interactive.${suffix}`, severity, feature: 'interactive', message };
}

function readErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1000 ? message : `${message.slice(0, 997)}...`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`;
}

function readOptionalDigest(form: FormData, field: string): string | undefined {
  const values = form.getAll(field);
  if (
    values.length > 1 ||
    (values.length === 1 &&
      (typeof values[0] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(values[0])))
  ) {
    throw new ReachDeckInteractiveHtmlUploadError(`Interactive HTML ${field} is invalid`, 400);
  }
  return values.length === 1 ? (values[0] as string) : undefined;
}

function readTargetIdentity(form: FormData): ReachDeckInteractiveHtmlTargetIdentity | undefined {
  const revisions = form.getAll('targetDraftRevision');
  const digests = form.getAll('targetContentDigest');
  if (revisions.length === 0 && digests.length === 0) return undefined;
  if (
    revisions.length !== 1 ||
    digests.length !== 1 ||
    typeof revisions[0] !== 'string' ||
    typeof digests[0] !== 'string' ||
    !/^\d+$/.test(revisions[0]) ||
    !Number.isSafeInteger(Number(revisions[0])) ||
    digests[0].trim().length === 0
  ) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML target identity fields must be supplied exactly once as a valid complete set',
      400,
    );
  }
  return { draftRevision: Number(revisions[0]), contentDigest: digests[0] };
}

async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload content-length is invalid',
      400,
    );
  }
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload exceeds the multipart byte limit',
      413,
    );
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ReachDeckInteractiveHtmlUploadError(
          'Interactive HTML upload exceeds the multipart byte limit',
          413,
        );
      }
      chunks.push(result.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== length) {
    throw new ReachDeckInteractiveHtmlUploadError(
      'Interactive HTML upload content-length does not match its body',
      400,
    );
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
