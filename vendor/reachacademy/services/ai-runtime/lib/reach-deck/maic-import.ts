import { createHash } from 'node:crypto';

import {
  collectMaicMediaReferences,
  createMaicCandidateDigest,
  createMaicProfileDigest,
  MAIC_IMPORTER_VERSION,
  MAIC_IMPORT_LIMITS,
  MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
  mapMaicToReachDeckV2,
  parseMaicCourse,
  type MaicCapabilityReport,
  type MaicDiagnostic,
  type MaicReachDeckV2PageReport,
} from '@reachany/importer/maic';
import type { DeckTheme, ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import type { ReachDeckMaicMediaResolver, ReachDeckMaicResolvedMedia } from './maic-media.js';
import { ReachDeckMaicMediaError } from './maic-media.js';
import { loadMaicTableFontMetrics } from './maic-table-fonts.js';
import { parseReachDeckResourceScope, type ReachDeckResourceScope } from './resource-scope.js';

const MAIC_IMPORT_COMPATIBILITY_THEME = {
  name: 'Reach',
  background: '#ffffff',
  surface: '#f8fafc',
  ink: '#172024',
  muted: '#647178',
  accent: '#2563eb',
  success: '#15803d',
  warning: '#b45309',
  fontDisplay: 'Inter',
  fontBody: 'Inter',
} as const;

export const REACH_DECK_MAIC_PREFLIGHT_SCHEMA_VERSION = 'reach-deck-maic-preflight/v1' as const;

export interface ReachDeckMaicMappingIdentity {
  schemaVersion: typeof MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION;
  generatedAt: string;
  profileDigest: `sha256:${string}`;
  candidateDigest: `sha256:${string}`;
  mediaDigest: `sha256:${string}`;
}

export interface ReachDeckMaicPreflightSuccess {
  ok: true;
  schemaVersion: typeof REACH_DECK_MAIC_PREFLIGHT_SCHEMA_VERSION;
  applicationId: string;
  importerVersion: typeof MAIC_IMPORTER_VERSION;
  sourceDigest: `sha256:${string}`;
  summary: {
    pageCount: number;
    canvasCount: number;
    quizCount: number;
    interactiveCount: number;
    mediaCount: number;
  };
  capabilities: MaicCapabilityReport;
  diagnostics: readonly MaicDiagnostic[];
  mapping?: ReachDeckMaicMappingIdentity & {
    document: ReachDeckDocumentV2;
    pageReports: readonly ReachDeckMaicPageReport[];
    mediaPreviewUrls?: Readonly<Record<string, string>>;
  };
  canApply: boolean;
  canApplyDegraded: boolean;
}

/** Wire enrichment used by the preview without altering importer diagnostics. */
export type ReachDeckMaicPageReport = MaicReachDeckV2PageReport & { title: string };

export interface ReachDeckMaicPreflightFailure {
  ok: false;
  schemaVersion: typeof REACH_DECK_MAIC_PREFLIGHT_SCHEMA_VERSION;
  applicationId: string;
  importerVersion: typeof MAIC_IMPORTER_VERSION;
  diagnostics: readonly MaicDiagnostic[];
  canApply: false;
  canApplyDegraded: false;
}

export type ReachDeckMaicPreflightResult =
  | ReachDeckMaicPreflightSuccess
  | ReachDeckMaicPreflightFailure;

export interface ReachDeckMaicPreflightOptions {
  applicationId: string;
  documentId: string;
  title: string;
  language: string;
  generatedAt: string;
  compatibilityTheme?: DeckTheme;
  resolveMedia?: ReachDeckMaicMediaResolver;
}

export type ReachDeckMaicImportTarget =
  | { mode: 'create' }
  | { mode: 'insert-after'; afterPageId: string }
  | { mode: 'before-first' };

export interface ReachDeckMaicTargetIdentity {
  draftRevision: number;
  contentDigest: string;
}

export interface ReachDeckMaicUpload {
  bytes: Uint8Array;
  target: ReachDeckMaicImportTarget;
  sourceDigest?: string;
  mapping?: ReachDeckMaicMappingIdentity;
  targetIdentity?: ReachDeckMaicTargetIdentity;
  acceptDegraded?: boolean;
  completionAction?: 'generate-narration';
}

export class ReachDeckMaicUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = 'ReachDeckMaicUploadError';
  }
}

export function readMaicIdempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key')?.trim();
  if (value === undefined || value.length === 0 || value.length > 200) {
    throw new ReachDeckMaicUploadError(
      'MAIC import requires a non-empty idempotency-key of at most 200 characters',
      400,
    );
  }
  return value;
}

export function buildReachDeckMaicApplicationId(
  scopeValue: ReachDeckResourceScope,
  idempotencyKey: string,
): string {
  const scope = parseReachDeckResourceScope(scopeValue);
  const key = idempotencyKey.trim();
  if (key.length === 0 || key.length > 200) throw new Error('MAIC idempotency key is invalid');
  return `maic-import-${createHash('sha256')
    .update(
      [
        scope.organizationId,
        scope.courseId,
        scope.courseWorkspaceType,
        scope.courseNodeId,
        scope.moduleId,
        scope.moduleVersionId,
        key,
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

export async function preflightReachDeckMaic(
  bytes: Uint8Array,
  options: ReachDeckMaicPreflightOptions,
): Promise<ReachDeckMaicPreflightResult> {
  const parsed = parseMaicCourse(bytes);
  if (!parsed.ok) {
    return failure(options.applicationId, parsed.diagnostics);
  }
  const references = collectMaicMediaReferences(parsed.ir);
  const resolvedByReferenceId: Record<
    string,
    { objectKey: string; contentType: string; digest: `sha256:${string}` }
  > = {};
  const resolvedMedia = new Map<string, ReachDeckMaicResolvedMedia>();
  const mediaDiagnostics: MaicDiagnostic[] = [];
  if (references.length > 0 && options.resolveMedia !== undefined) {
    try {
      const resolution = await options.resolveMedia(
        references.map((reference) => ({
          id: reference.id,
          url: reference.sourceUrl,
          kind: reference.kind,
        })),
      );
      const { resolved } = resolution;
      // 单个媒体对象失败只降级它所在的页：这里按引用 id 反查页/元素，落一条带
      // 具体原因的 error 诊断。mapper 随后也会为同一元素补 resource.unresolved，
      // 于是该页被标成 error、其余页仍可正常导入，而不是整份课件 fatal。
      for (const failure of resolution.failures) {
        const affected = references.filter(
          (reference) =>
            failure.referenceIds.includes(reference.id) || reference.sourceUrl === failure.url,
        );
        for (const reference of affected) {
          const sourceOrder = parsed.ir.pages.find(
            (page) => page.id === reference.pageId,
          )?.sourceOrder;
          mediaDiagnostics.push({
            code: failure.code as `maic.${string}`,
            severity: 'error',
            feature: 'resource',
            message: failure.message,
            location: {
              pageId: reference.pageId,
              ...(sourceOrder === undefined ? {} : { sourceOrder }),
              ...(reference.elementId === undefined
                ? { field: 'background' }
                : { elementId: reference.elementId }),
            },
            details: { sourceUrl: failure.url, mediaKind: failure.kind },
          });
        }
      }
      for (const reference of references) {
        const media = resolved.get(reference.id);
        if (media === undefined) continue;
        resolvedMedia.set(reference.id, media);
        resolvedByReferenceId[reference.id] = {
          objectKey: media.objectKey,
          contentType: media.contentType,
          digest: media.digest,
        };
        if (media.normalization !== undefined) {
          const sourceOrder = parsed.ir.pages.find(
            (page) => page.id === reference.pageId,
          )?.sourceOrder;
          mediaDiagnostics.push({
            code: 'maic.media.image_normalized',
            severity: 'warning',
            feature: 'image',
            message: `MAIC image ${media.normalization.sourceContentType} (${media.normalization.sourceByteLength} bytes) was converted to ${media.contentType} (${media.byteLength} bytes) for Reach Deck compatibility.`,
            location: {
              pageId: reference.pageId,
              ...(sourceOrder === undefined ? {} : { sourceOrder }),
              ...(reference.elementId === undefined
                ? { field: 'background' }
                : { elementId: reference.elementId }),
            },
            details: {
              sourceContentType: media.normalization.sourceContentType,
              sourceByteLength: media.normalization.sourceByteLength,
              storedContentType: media.contentType,
              storedByteLength: media.byteLength,
            },
          });
        }
      }
    } catch (error) {
      if (!(error instanceof ReachDeckMaicMediaError)) throw error;
      return failure(options.applicationId, [
        ...parsed.diagnostics,
        maicDiagnostic(error.code, 'fatal', 'resource', error.message),
      ]);
    }
  }

  let tableFontMetrics;
  if (
    parsed.ir.pages.some(
      (page) => page.kind === 'canvas' && page.elements.some((element) => element.type === 'table'),
    )
  ) {
    try {
      tableFontMetrics = await loadMaicTableFontMetrics();
    } catch {
      return failure(options.applicationId, [
        maicDiagnostic(
          'maic.table.font_metrics_unavailable',
          'fatal',
          'table',
          'Bundled fonts could not be loaded for table layout.',
        ),
      ]);
    }
  }
  const mapped = mapMaicToReachDeckV2(parsed.ir, {
    documentId: options.documentId,
    applicationId: options.applicationId,
    title: options.title,
    language: options.language,
    generatedAt: options.generatedAt,
    compatibilityTheme: options.compatibilityTheme ?? MAIC_IMPORT_COMPATIBILITY_THEME,
    media: resolvedByReferenceId,
    ...(tableFontMetrics ? { tableFontMetrics } : {}),
    // The parser is authoritative for page eligibility. Passing the exact
    // non-error set prevents mapper-successful fragments of a parser-error
    // page from leaking into an explicitly accepted degraded import.
    includePageIds: parsed.capabilityReport.pageReports
      .filter((report) => report.status !== 'error')
      .map((report) => report.pageId),
  });
  const diagnostics = mergeDiagnostics(parsed.diagnostics, [
    ...mapped.diagnostics,
    ...mediaDiagnostics,
  ]);
  const errorPageIds = new Set([
    ...parsed.capabilityReport.pageReports
      .filter((report) => report.status === 'error')
      .map((report) => report.pageId),
    ...(mapped.ok
      ? mapped.pageReports
          .filter((report) => report.status === 'error')
          .map((report) => report.pageId)
      : []),
  ]);
  const hasGlobalError = diagnostics.some(
    (diagnostic) =>
      (diagnostic.severity === 'error' || diagnostic.severity === 'fatal') &&
      (diagnostic.location?.pageId === undefined || !errorPageIds.has(diagnostic.location.pageId)),
  );
  const counts = { canvas: 0, quiz: 0, interactive: 0 };
  for (const page of parsed.ir.pages) counts[page.kind] += 1;
  if (!mapped.ok) {
    return {
      ok: true,
      schemaVersion: REACH_DECK_MAIC_PREFLIGHT_SCHEMA_VERSION,
      applicationId: options.applicationId,
      importerVersion: MAIC_IMPORTER_VERSION,
      sourceDigest: parsed.ir.sourceDigest,
      summary: {
        pageCount: parsed.ir.pages.length,
        canvasCount: counts.canvas,
        quizCount: counts.quiz,
        interactiveCount: counts.interactive,
        mediaCount: references.length,
      },
      capabilities: parsed.capabilityReport,
      diagnostics,
      canApply: false,
      canApplyDegraded: false,
    };
  }
  const mediaIdentity = references
    .map((reference) => ({
      id: reference.id,
      sourceUrl: reference.sourceUrl,
      kind: reference.kind,
      resolved: resolvedByReferenceId[reference.id] ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const mediaPreviewUrls = Object.fromEntries(
    mapped.document.resources.media.flatMap((resource) => {
      const resolved = [...resolvedMedia.values()].find(
        (candidate) => candidate.objectKey === resource.objectKey,
      );
      return resolved?.previewUrl === undefined
        ? []
        : [[resource.id, resolved.previewUrl] as const];
    }),
  );
  const mappedPagesById = new Map(
    mapped.document.pages.map((page) => [page.pageId, page] as const),
  );
  const parsedReportsByPageId = new Map(
    parsed.capabilityReport.pageReports.map((report) => [report.pageId, report] as const),
  );
  const pageReports = mapped.pageReports.map((report) => {
    const parsedReport = parsedReportsByPageId.get(report.pageId);
    const pageDiagnostics = mergeDiagnostics(parsedReport?.diagnostics ?? [], [
      ...report.diagnostics,
      ...mediaDiagnostics.filter((diagnostic) => diagnostic.location?.pageId === report.pageId),
    ]);
    return {
      ...report,
      // The browser preview keys reports by candidate page identity. Error pages
      // have no candidate and intentionally retain their source identity.
      pageId: report.mappedPageId ?? report.pageId,
      status: pageDiagnostics.some(
        (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
      )
        ? ('error' as const)
        : pageDiagnostics.some((diagnostic) => diagnostic.severity === 'warning')
          ? ('warning' as const)
          : ('ok' as const),
      diagnostics: pageDiagnostics,
      title:
        (report.mappedPageId === undefined
          ? undefined
          : mappedPagesById.get(report.mappedPageId)?.title) ?? `Page ${report.sourceOrder}`,
    };
  });
  return {
    ok: true,
    schemaVersion: REACH_DECK_MAIC_PREFLIGHT_SCHEMA_VERSION,
    applicationId: options.applicationId,
    importerVersion: MAIC_IMPORTER_VERSION,
    sourceDigest: parsed.ir.sourceDigest,
    summary: {
      pageCount: parsed.ir.pages.length,
      canvasCount: counts.canvas,
      quizCount: counts.quiz,
      interactiveCount: counts.interactive,
      mediaCount: references.length,
    },
    capabilities: parsed.capabilityReport,
    diagnostics,
    mapping: {
      schemaVersion: MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
      generatedAt: options.generatedAt,
      profileDigest: createMaicProfileDigest(parsed.capabilityReport),
      candidateDigest: createMaicCandidateDigest(mapped.document),
      mediaDigest: digestJson(mediaIdentity),
      document: mapped.document,
      pageReports,
      ...(Object.keys(mediaPreviewUrls).length === 0 ? {} : { mediaPreviewUrls }),
    },
    canApply: parsed.capabilityReport.canApply && errorPageIds.size === 0 && !hasGlobalError,
    canApplyDegraded:
      parsed.capabilityReport.canApply && mapped.document.pages.length > 0 && !hasGlobalError,
  };
}

export function addMaicPreflightDiagnostics(
  result: ReachDeckMaicPreflightResult,
  diagnostics: readonly MaicDiagnostic[],
): ReachDeckMaicPreflightResult {
  if (!result.ok || diagnostics.length === 0) return result;
  const combined = [...result.diagnostics, ...diagnostics];
  const blocking = diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
  );
  return {
    ...result,
    diagnostics: combined,
    canApply: result.canApply && !blocking,
    canApplyDegraded: result.canApplyDegraded && !blocking,
    capabilities: {
      ...result.capabilities,
      diagnostics: combined,
      canApply: result.capabilities.canApply && !blocking,
    },
  };
}

const MAIC_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
export const REACH_DECK_MAIC_MAX_MULTIPART_BYTES =
  MAIC_IMPORT_LIMITS.maxSourceBytes + MAIC_MULTIPART_OVERHEAD_BYTES;

export async function readMaicUpload(request: Request): Promise<ReachDeckMaicUpload> {
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new ReachDeckMaicUploadError('MAIC import requires multipart/form-data', 400);
  }
  let form: FormData;
  try {
    const body = await readBoundedRequestBody(request, REACH_DECK_MAIC_MAX_MULTIPART_BYTES);
    form = await new Response(body.buffer as ArrayBuffer, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch (error) {
    if (error instanceof ReachDeckMaicUploadError) throw error;
    throw new ReachDeckMaicUploadError('MAIC upload form is malformed', 400);
  }
  const allowed = new Set([
    'file',
    'mode',
    'afterPageId',
    'sourceDigest',
    'mappingSchemaVersion',
    'mappingGeneratedAt',
    'profileDigest',
    'candidateDigest',
    'mediaDigest',
    'targetDraftRevision',
    'targetContentDigest',
    'acceptDegraded',
    'completionAction',
  ]);
  if ([...form.keys()].some((key) => !allowed.has(key))) {
    throw new ReachDeckMaicUploadError('MAIC upload contains unsupported multipart fields', 400);
  }
  const files = form.getAll('file');
  if (files.length !== 1 || !(files[0] instanceof Blob)) {
    throw new ReachDeckMaicUploadError('MAIC upload must contain exactly one file field', 400);
  }
  const file = files[0];
  if (file.size === 0) throw new ReachDeckMaicUploadError('MAIC upload must not be empty', 400);
  if (file.size > MAIC_IMPORT_LIMITS.maxSourceBytes) {
    throw new ReachDeckMaicUploadError('MAIC upload exceeds the input byte limit', 413);
  }
  const fileName = 'name' in file && typeof file.name === 'string' ? file.name : '';
  if (!fileName.toLowerCase().endsWith('.json')) {
    throw new ReachDeckMaicUploadError('MAIC upload filename must end with .json', 400);
  }
  if (
    file.type !== '' &&
    file.type !== 'application/json' &&
    file.type !== 'application/octet-stream' &&
    file.type !== 'text/json'
  ) {
    throw new ReachDeckMaicUploadError('MAIC upload content type is not supported', 400);
  }
  const modes = form.getAll('mode');
  const anchors = form.getAll('afterPageId');
  if (modes.length !== 1 || typeof modes[0] !== 'string') {
    throw new ReachDeckMaicUploadError('MAIC upload must contain exactly one mode field', 400);
  }
  let target: ReachDeckMaicImportTarget;
  if (modes[0] === 'create') {
    if (anchors.length !== 0) {
      throw new ReachDeckMaicUploadError('MAIC create mode must not contain afterPageId', 400);
    }
    target = { mode: 'create' };
  } else if (
    modes[0] === 'insert-after' &&
    anchors.length === 1 &&
    typeof anchors[0] === 'string' &&
    anchors[0].trim().length > 0
  ) {
    target = { mode: 'insert-after', afterPageId: anchors[0].trim() };
  } else if (modes[0] === 'before-first' && anchors.length === 0) {
    target = { mode: 'before-first' };
  } else {
    throw new ReachDeckMaicUploadError('MAIC upload mode is invalid', 400);
  }
  const mapping = readMappingIdentity(form);
  const targetIdentity = readTargetIdentity(form);
  if (target.mode === 'create' && targetIdentity !== undefined) {
    throw new ReachDeckMaicUploadError('MAIC create mode must not contain a target identity', 400);
  }
  const sourceDigest = readOptionalDigest(form, 'sourceDigest');
  const degraded = form.getAll('acceptDegraded');
  const completionActions = form.getAll('completionAction');
  if (
    completionActions.length > 1 ||
    (completionActions.length === 1 && completionActions[0] !== 'generate-narration')
  )
    throw new ReachDeckMaicUploadError('MAIC completionAction is invalid', 400);
  if (
    degraded.length > 1 ||
    (degraded.length === 1 && !['1', 'true'].includes(String(degraded[0])))
  ) {
    throw new ReachDeckMaicUploadError('MAIC acceptDegraded is invalid', 400);
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    target,
    ...(sourceDigest === undefined ? {} : { sourceDigest }),
    ...(mapping === undefined ? {} : { mapping }),
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
    ...(degraded.length === 1 ? { acceptDegraded: true } : {}),
    ...(completionActions.length === 1 ? { completionAction: 'generate-narration' as const } : {}),
  };
}

function failure(
  applicationId: string,
  diagnostics: readonly MaicDiagnostic[],
): ReachDeckMaicPreflightFailure {
  // Media resolution can fail before the normal parser/mapper merge path. Keep
  // the wire report consistent by collapsing identical parser diagnostics here
  // as well.
  const uniqueDiagnostics = mergeDiagnostics([], diagnostics);
  return {
    ok: false,
    schemaVersion: REACH_DECK_MAIC_PREFLIGHT_SCHEMA_VERSION,
    applicationId,
    importerVersion: MAIC_IMPORTER_VERSION,
    diagnostics: uniqueDiagnostics,
    canApply: false,
    canApplyDegraded: false,
  };
}

function maicDiagnostic(
  code: string,
  severity: string,
  feature: string,
  message: string,
): MaicDiagnostic {
  return { code, severity, feature, message } as MaicDiagnostic;
}

function readOptionalDigest(form: FormData, field: string): string | undefined {
  const values = form.getAll(field);
  if (
    values.length > 1 ||
    (values.length === 1 &&
      (typeof values[0] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(values[0])))
  ) {
    throw new ReachDeckMaicUploadError(`MAIC ${field} is invalid`, 400);
  }
  return values.length === 1 ? (values[0] as string) : undefined;
}

function readMappingIdentity(form: FormData): ReachDeckMaicMappingIdentity | undefined {
  const names = [
    'mappingSchemaVersion',
    'mappingGeneratedAt',
    'profileDigest',
    'candidateDigest',
    'mediaDigest',
  ] as const;
  const values = names.map((name) => form.getAll(name));
  if (values.every((value) => value.length === 0)) return undefined;
  if (values.some((value) => value.length !== 1 || typeof value[0] !== 'string')) {
    throw new ReachDeckMaicUploadError(
      'MAIC mapping identity fields must be supplied exactly once as a complete set',
      400,
    );
  }
  const [schema, generatedAt, profile, candidate, media] = values.map(
    (value) => value[0] as string,
  );
  if (schema !== MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION) {
    throw new ReachDeckMaicUploadError('MAIC mapping schemaVersion is invalid', 400);
  }
  if (
    Number.isNaN(Date.parse(generatedAt)) ||
    new Date(Date.parse(generatedAt)).toISOString() !== generatedAt
  ) {
    throw new ReachDeckMaicUploadError('MAIC mapping generatedAt is invalid', 400);
  }
  for (const [name, value] of [
    ['profileDigest', profile],
    ['candidateDigest', candidate],
    ['mediaDigest', media],
  ] as const) {
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
      throw new ReachDeckMaicUploadError(`MAIC mapping ${name} is invalid`, 400);
    }
  }
  return {
    schemaVersion: MAIC_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
    generatedAt,
    profileDigest: profile as `sha256:${string}`,
    candidateDigest: candidate as `sha256:${string}`,
    mediaDigest: media as `sha256:${string}`,
  };
}

function readTargetIdentity(form: FormData): ReachDeckMaicTargetIdentity | undefined {
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
    throw new ReachDeckMaicUploadError(
      'MAIC target identity fields must be supplied exactly once as a valid complete set',
      400,
    );
  }
  return { draftRevision: Number(revisions[0]), contentDigest: digests[0] };
}

async function readBoundedRequestBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new ReachDeckMaicUploadError('MAIC upload content-length is invalid', 400);
  }
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new ReachDeckMaicUploadError('MAIC upload exceeds the multipart byte limit', 413);
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
        throw new ReachDeckMaicUploadError('MAIC upload exceeds the multipart byte limit', 413);
      }
      chunks.push(result.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== length) {
    throw new ReachDeckMaicUploadError('MAIC upload content-length does not match its body', 400);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function mergeDiagnostics(
  left: readonly MaicDiagnostic[],
  right: readonly MaicDiagnostic[],
): MaicDiagnostic[] {
  const byIdentity = new Map<string, MaicDiagnostic>();
  for (const diagnostic of [...left, ...right]) {
    byIdentity.set(JSON.stringify(diagnostic), diagnostic);
  }
  return [...byIdentity.values()];
}
