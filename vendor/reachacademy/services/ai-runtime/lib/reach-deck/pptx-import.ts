import { createHash } from 'node:crypto';

import {
  collectPptxReferencedMediaPartPaths,
  createPptxCapabilityReport,
  DEFAULT_PPTX_PARSE_LIMITS,
  fitReachDeckPptxToStage,
  PPTX_STAGE_FIT_VERSION,
  mapPptxPresentationToReachDeckV2,
  parsePptx,
  sortPptxDiagnostics,
  PPTX_IMPORTER_VERSION,
  PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
  type PptxBinaryAsset,
  type PptxCapabilityEntry,
  type PptxCapabilityReport,
  type PptxCapabilityStatus,
  type PptxDiagnostic,
  type PptxMediaUpload,
  type PptxReachDeckV2PageReport,
  type PptxSourceDigest,
} from '@reachany/importer/pptx';
import {
  REACH_DECK_PPTX_MAX_UPLOAD_BYTES,
  type DeckTheme,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { parseReachDeckResourceScope, type ReachDeckResourceScope } from './resource-scope.js';

const PPTX_IMPORT_COMPATIBILITY_THEME = {
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

export const REACH_DECK_PPTX_PREFLIGHT_SCHEMA_VERSION = 'reach-deck-pptx-preflight/v1' as const;

export interface ReachDeckPptxPreflightSuccess {
  ok: true;
  schemaVersion: typeof REACH_DECK_PPTX_PREFLIGHT_SCHEMA_VERSION;
  applicationId: string;
  importerVersion: typeof PPTX_IMPORTER_VERSION;
  sourceDigest: PptxSourceDigest;
  summary: {
    slideCount: number;
    widthEmu: number;
    heightEmu: number;
    partCount: number;
    assetCount: number;
    assetBytes: number;
  };
  capabilities: PptxCapabilityReport;
  diagnostics: readonly PptxDiagnostic[];
  mapping?: {
    schemaVersion: typeof PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION;
    generatedAt: string;
    profileDigest: `sha256:${string}`;
    candidateDigest: `sha256:${string}`;
    mediaDigest: `sha256:${string}`;
    document: ReachDeckDocumentV2;
    /** Per source-slide mapping status for preview badges (ok/warning/error). */
    pageReports: readonly PptxReachDeckV2PageReport[];
    /**
     * Presigned display URL per imported media resource id, for candidate
     * previews only. Volatile — never persisted and outside every identity
     * digest.
     */
    mediaPreviewUrls?: Readonly<Record<string, string>>;
  };
  canApply: boolean;
  /**
   * Whether the degraded candidate (warnings kept, error pages skipped) can be
   * applied when the caller explicitly accepts the loss ("仍然导入").
   */
  canApplyDegraded: boolean;
}

export type ReachDeckPptxMappingIdentity = Omit<
  NonNullable<ReachDeckPptxPreflightSuccess['mapping']>,
  'document' | 'mediaPreviewUrls' | 'pageReports'
>;

export interface ReachDeckPptxPreflightFailure {
  ok: false;
  schemaVersion: typeof REACH_DECK_PPTX_PREFLIGHT_SCHEMA_VERSION;
  applicationId: string;
  importerVersion: typeof PPTX_IMPORTER_VERSION;
  diagnostics: readonly PptxDiagnostic[];
  canApply: false;
  canApplyDegraded: false;
}

export type ReachDeckPptxPreflightResult =
  | ReachDeckPptxPreflightSuccess
  | ReachDeckPptxPreflightFailure;

/** One uploaded package media asset: durable storage key + volatile preview URL. */
export interface ReachDeckPptxMediaUpload {
  objectKey: string;
  /** The stored bytes' content type, which normalization may have changed. */
  contentType: string;
  previewUrl?: string;
}

/**
 * Uploads referenced package media and returns what it stored, by part path.
 * MUST be deterministic for identical assets in the same import scope —
 * preflight and apply both run it and their candidate digests must agree.
 * Assets it omits (undecodable bytes) block with a mapper diagnostic.
 */
export type ReachDeckPptxMediaResolver = (
  assets: readonly PptxBinaryAsset[],
) => Promise<ReadonlyMap<string, ReachDeckPptxMediaUpload>>;

export interface ReachDeckPptxPreflightOptions {
  applicationId: string;
  documentId: string;
  title: string;
  language: string;
  generatedAt: string;
  compatibilityTheme?: DeckTheme;
  /** Existing insertion stage; create imports retain their source stage. */
  targetStage?: ReachDeckDocumentV2['stage'];
  resolveMediaObjectKeys?: ReachDeckPptxMediaResolver;
}

export type ReachDeckPptxImportTarget =
  | { mode: 'create' }
  | { mode: 'insert-after'; afterPageId: string }
  | { mode: 'before-first' };

export interface ReachDeckPptxTargetIdentity {
  draftRevision: number;
  contentDigest: string;
}

export interface ReachDeckPptxUpload {
  bytes: Uint8Array;
  target: ReachDeckPptxImportTarget;
  sourceDigest?: string;
  mapping?: ReachDeckPptxMappingIdentity;
  targetIdentity?: ReachDeckPptxTargetIdentity;
  /** Explicit "仍然导入" consent: apply the degraded candidate, skipping error pages. */
  acceptDegraded?: boolean;
  completionAction?: 'generate-narration';
}

export class ReachDeckPptxUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = 'ReachDeckPptxUploadError';
  }
}

export function readPptxIdempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key')?.trim();
  if (value === undefined || value.length === 0 || value.length > 200) {
    throw new ReachDeckPptxUploadError(
      'PPTX import requires a non-empty idempotency-key of at most 200 characters',
      400,
    );
  }
  return value;
}

export function buildReachDeckPptxApplicationId(
  scopeValue: ReachDeckResourceScope,
  idempotencyKey: string,
): string {
  const scope = parseReachDeckResourceScope(scopeValue);
  const key = idempotencyKey.trim();
  if (key.length === 0 || key.length > 200) {
    throw new Error('PPTX import idempotency key is invalid');
  }
  const identity = [
    scope.organizationId,
    scope.courseId,
    scope.courseWorkspaceType,
    scope.courseNodeId,
    scope.moduleId,
    scope.moduleVersionId,
    key,
  ].join('\n');
  return `pptx-import-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

const PPTX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
export const REACH_DECK_PPTX_MAX_MULTIPART_BYTES =
  REACH_DECK_PPTX_MAX_UPLOAD_BYTES + PPTX_MULTIPART_OVERHEAD_BYTES;

/**
 * Rejecting an oversized upload is a product answer, not a failure: say how big
 * the file is and what the ceiling is so the teacher can act on it.
 */
export function pptxUploadTooLargeError(byteLength: number): ReachDeckPptxUploadError {
  const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);
  return new ReachDeckPptxUploadError(
    `PPTX upload is ${megabytes(byteLength)} MB, over the ${megabytes(REACH_DECK_PPTX_MAX_UPLOAD_BYTES)} MB import limit`,
    413,
  );
}

async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = request.headers.get('content-length');
  let expectedLength: number | undefined;
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new ReachDeckPptxUploadError('PPTX upload content-length is invalid', 400);
    }
    expectedLength = Number(declaredLength);
    if (!Number.isSafeInteger(expectedLength)) {
      throw new ReachDeckPptxUploadError('PPTX upload content-length is invalid', 400);
    }
    if (expectedLength > maximumBytes) throw pptxUploadTooLargeError(expectedLength);
  }

  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw pptxUploadTooLargeError(byteLength);
      }
      chunks.push(result.value.slice());
    }
  } finally {
    reader.releaseLock();
  }

  if (expectedLength !== undefined && byteLength !== expectedLength) {
    throw new ReachDeckPptxUploadError('PPTX upload content-length does not match its body', 400);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Build the capability report the apply gate reads, from what the v2 mapper
 * actually produced for this package.
 *
 * Severity — not the mere presence of a diagnostic — decides the status. A
 * feature is `unsupported` only when the package itself could not be read
 * (fatal) or no candidate document exists; `conditional` when content was lost
 * (error), degraded (warning) or dropped semantics the target model has no
 * place for (info); `native` otherwise. Only `unsupported` refuses the import:
 * a deck missing a picture or a chart still imports, with the loss itemized
 * for the teacher — refusing a whole lesson over one element helps nobody.
 *
 * `analyzePptxCapabilities` is deliberately not the source here: its
 * `REACH_DECK_V2_CAPABILITY_PROFILE` predates the native mapper and still
 * reports shape/image/theme/notes as unsupported, so every real deck — clean
 * ones included — would block. The mapper's own diagnostics are the accurate
 * account of what this candidate kept and lost.
 */
function buildPptxCapabilityReport(
  mappingSucceeded: boolean,
  diagnostics: readonly PptxDiagnostic[],
): PptxCapabilityReport {
  const statuses = new Map<PptxDiagnostic['feature'], PptxCapabilityStatus>(
    NATIVE_PPTX_IMPORT_FEATURES.map((feature) => [feature, 'native' as const]),
  );
  const reasons = new Map<PptxDiagnostic['feature'], string>();
  const reasonRank = new Map<PptxDiagnostic['feature'], number>();
  const rank: Record<PptxDiagnostic['severity'], number> = {
    info: 0,
    warning: 1,
    error: 2,
    fatal: 3,
  };
  for (const diagnostic of diagnostics) {
    const unreadable = diagnostic.severity === 'fatal';
    if (statuses.get(diagnostic.feature) !== 'unsupported') {
      statuses.set(diagnostic.feature, unreadable ? 'unsupported' : 'conditional');
    }
    // The reason shown for a feature is its worst finding, not its first.
    if ((reasonRank.get(diagnostic.feature) ?? -1) < rank[diagnostic.severity]) {
      reasonRank.set(diagnostic.feature, rank[diagnostic.severity]);
      reasons.set(diagnostic.feature, diagnostic.message);
    }
  }
  if (!mappingSucceeded) {
    statuses.set('presentation', 'unsupported');
    reasons.set(
      'presentation',
      'The presentation could not be mapped to a Reach Deck candidate document.',
    );
  }
  const entries: PptxCapabilityEntry[] = [...statuses].map(([feature, status]) => {
    const reason = reasons.get(feature);
    return { feature, status, ...(reason === undefined ? {} : { reason }) };
  });
  return createPptxCapabilityReport(entries, diagnostics);
}

/**
 * Features the v2 mapper represents natively, listed so a clean candidate
 * reports what it covered rather than an empty inventory.
 */
const NATIVE_PPTX_IMPORT_FEATURES = [
  'presentation',
  'theme',
  'master',
  'layout',
  'geometry',
  'transform',
  'text-frame',
  'shape',
  'chart',
] as const satisfies readonly PptxDiagnostic['feature'][];

export async function preflightReachDeckPptx(
  bytes: Uint8Array,
  options: ReachDeckPptxPreflightOptions,
): Promise<ReachDeckPptxPreflightResult> {
  const parsed = await parsePptx(bytes);
  if (!parsed.ok) {
    return {
      ok: false,
      schemaVersion: REACH_DECK_PPTX_PREFLIGHT_SCHEMA_VERSION,
      applicationId: options.applicationId,
      importerVersion: PPTX_IMPORTER_VERSION,
      diagnostics: parsed.diagnostics,
      canApply: false,
      canApplyDegraded: false,
    };
  }

  const referencedMediaPaths = collectPptxReferencedMediaPartPaths(parsed.ir);
  let mediaUploads: Record<string, PptxMediaUpload> | undefined;
  const previewUrlsByObjectKey = new Map<string, string>();
  if (referencedMediaPaths.length > 0 && options.resolveMediaObjectKeys !== undefined) {
    const assetsByPath = new Map(parsed.assets.map((asset) => [asset.partPath, asset]));
    const referencedAssets = referencedMediaPaths
      .map((partPath) => assetsByPath.get(partPath))
      .filter((asset): asset is PptxBinaryAsset => asset !== undefined);
    const uploads = await options.resolveMediaObjectKeys(referencedAssets);
    mediaUploads = {};
    for (const [partPath, upload] of uploads) {
      mediaUploads[partPath] = { objectKey: upload.objectKey, contentType: upload.contentType };
      if (upload.previewUrl !== undefined) {
        previewUrlsByObjectKey.set(upload.objectKey, upload.previewUrl);
      }
    }
  }

  const mapped = mapPptxPresentationToReachDeckV2(parsed.ir, {
    documentId: options.documentId,
    applicationId: options.applicationId,
    title: options.title,
    language: options.language,
    generatedAt: options.generatedAt,
    compatibilityTheme: options.compatibilityTheme ?? PPTX_IMPORT_COMPATIBILITY_THEME,
    ...(mediaUploads === undefined ? {} : { mediaUploads }),
  });
  const fitted =
    mapped.ok && options.targetStage !== undefined
      ? fitReachDeckPptxToStage(mapped.document, options.targetStage)
      : undefined;
  const candidateDocument = mapped.ok ? (fitted?.document ?? mapped.document) : undefined;
  const diagnostics = sortPptxDiagnostics([...mapped.diagnostics, ...(fitted?.diagnostics ?? [])]);
  const capabilityReport = buildPptxCapabilityReport(mapped.ok, diagnostics);
  const mapping = mapped.ok
    ? {
        schemaVersion: mapped.schemaVersion,
        generatedAt: options.generatedAt,
        profileDigest: digestJson({
          importerVersion: PPTX_IMPORTER_VERSION,
          mappingSchemaVersion: PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
          ...(options.targetStage === undefined
            ? {}
            : {
                stageFit: { version: PPTX_STAGE_FIT_VERSION, target: options.targetStage },
              }),
        }),
        candidateDigest: digestJson(candidateDocument),
        mediaDigest: digestJson(
          parsed.assets.map(({ partPath, contentType, byteLength, digest }) => ({
            partPath,
            contentType,
            byteLength,
            digest,
          })),
        ),
        document: candidateDocument!,
        pageReports: mapped.pageReports.map((page): PptxReachDeckV2PageReport => {
          const fitDiagnostics =
            fitted?.diagnostics.filter((item) => item.details?.pageId === page.pageId) ?? [];
          return fitDiagnostics.length === 0
            ? page
            : {
                ...page,
                status: page.status === 'error' ? 'error' : 'warning',
                diagnostics: sortPptxDiagnostics([...page.diagnostics, ...fitDiagnostics]),
              };
        }),
        ...(() => {
          const mediaPreviewUrls = Object.fromEntries(
            candidateDocument!.resources.media.flatMap((resource) => {
              const url = previewUrlsByObjectKey.get(resource.objectKey);
              return url === undefined ? [] : [[resource.id, url] as const];
            }),
          );
          return Object.keys(mediaPreviewUrls).length === 0 ? {} : { mediaPreviewUrls };
        })(),
      }
    : undefined;
  const assetBytes = parsed.assets.reduce((total, asset) => total + asset.byteLength, 0);
  return {
    ok: true,
    schemaVersion: REACH_DECK_PPTX_PREFLIGHT_SCHEMA_VERSION,
    applicationId: options.applicationId,
    importerVersion: PPTX_IMPORTER_VERSION,
    sourceDigest: parsed.ir.sourceDigest,
    summary: {
      slideCount: parsed.ir.slides.length,
      widthEmu: parsed.ir.slideSize.widthEmu,
      heightEmu: parsed.ir.slideSize.heightEmu,
      partCount: parsed.ir.parts.length,
      assetCount: parsed.assets.length,
      assetBytes,
    },
    capabilities: capabilityReport,
    diagnostics,
    ...(mapping === undefined ? {} : { mapping }),
    canApply: capabilityReport.canApply,
    canApplyDegraded: mapping !== undefined,
  };
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function addPptxPreflightDiagnostics(
  result: ReachDeckPptxPreflightResult,
  diagnostics: readonly PptxDiagnostic[],
): ReachDeckPptxPreflightResult {
  if (!result.ok || diagnostics.length === 0) return result;
  const combined = [...result.diagnostics, ...diagnostics];
  // Target-level findings are about *where* the pages would land — a vanished
  // anchor or a changed deck. Unlike content loss
  // inside the package, applying anyway would put pages somewhere wrong, so
  // these still block.
  const blocking = diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'fatal',
  );
  const canApply = result.canApply && !blocking;
  return {
    ...result,
    diagnostics: combined,
    canApply,
    // Target-level blockers (missing anchor, absent deck…) invalidate even
    // an explicitly accepted degraded apply.
    canApplyDegraded: result.canApplyDegraded && !blocking,
    capabilities: {
      ...result.capabilities,
      diagnostics: combined,
      canApply,
    },
  };
}

export async function readPptxUpload(request: Request): Promise<ReachDeckPptxUpload> {
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new ReachDeckPptxUploadError('PPTX preflight requires multipart/form-data', 400);
  }

  let form: FormData;
  try {
    const body = await readBoundedRequestBody(request, REACH_DECK_PPTX_MAX_MULTIPART_BYTES);
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch (error) {
    if (error instanceof ReachDeckPptxUploadError) throw error;
    throw new ReachDeckPptxUploadError('PPTX upload form is malformed', 400);
  }
  const entries = [...form.entries()];
  const allowedFields = [
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
  ];
  if (entries.some(([key]) => !allowedFields.includes(key))) {
    throw new ReachDeckPptxUploadError('PPTX upload contains unsupported multipart fields', 400);
  }
  const files = form.getAll('file');
  if (files.length !== 1 || !(files[0] instanceof Blob)) {
    throw new ReachDeckPptxUploadError('PPTX upload must contain exactly one file field', 400);
  }
  const modes = form.getAll('mode');
  const anchors = form.getAll('afterPageId');
  const sourceDigests = form.getAll('sourceDigest');
  if (
    sourceDigests.length > 1 ||
    (sourceDigests.length === 1 &&
      (typeof sourceDigests[0] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(sourceDigests[0])))
  ) {
    throw new ReachDeckPptxUploadError('PPTX sourceDigest is invalid', 400);
  }
  const mapping = readPptxMappingIdentity(form);
  const targetIdentity = readPptxTargetIdentity(form);
  const degradedValues = form.getAll('acceptDegraded');
  if (
    degradedValues.length > 1 ||
    (degradedValues.length === 1 && degradedValues[0] !== '1' && degradedValues[0] !== 'true')
  ) {
    throw new ReachDeckPptxUploadError('PPTX acceptDegraded is invalid', 400);
  }
  const acceptDegraded = degradedValues.length === 1;
  const completionActions = form.getAll('completionAction');
  if (
    completionActions.length > 1 ||
    (completionActions.length === 1 && completionActions[0] !== 'generate-narration')
  )
    throw new ReachDeckPptxUploadError('PPTX completionAction is invalid', 400);
  if (modes.length !== 1 || typeof modes[0] !== 'string') {
    throw new ReachDeckPptxUploadError('PPTX upload must contain exactly one mode field', 400);
  }
  let target: ReachDeckPptxImportTarget;
  if (modes[0] === 'create') {
    if (anchors.length !== 0) {
      throw new ReachDeckPptxUploadError('PPTX create mode must not contain afterPageId', 400);
    }
    if (targetIdentity !== undefined) {
      throw new ReachDeckPptxUploadError(
        'PPTX create mode must not contain a target identity',
        400,
      );
    }
    target = { mode: 'create' };
  } else if (modes[0] === 'insert-after') {
    if (anchors.length !== 1 || typeof anchors[0] !== 'string' || anchors[0].trim().length === 0) {
      throw new ReachDeckPptxUploadError(
        'PPTX insert-after mode requires exactly one non-empty afterPageId',
        400,
      );
    }
    target = { mode: 'insert-after', afterPageId: anchors[0].trim() };
  } else if (modes[0] === 'before-first') {
    if (anchors.length !== 0) {
      throw new ReachDeckPptxUploadError(
        'PPTX before-first mode must not contain afterPageId',
        400,
      );
    }
    target = { mode: 'before-first' };
  } else {
    throw new ReachDeckPptxUploadError('PPTX upload mode is invalid', 400);
  }

  const file = files[0];
  if (file.size === 0) throw new ReachDeckPptxUploadError('PPTX upload must not be empty', 400);
  const fileName = 'name' in file && typeof file.name === 'string' ? file.name : '';
  if (!fileName.toLowerCase().endsWith('.pptx')) {
    throw new ReachDeckPptxUploadError('PPTX upload filename must end with .pptx', 400);
  }
  if (
    file.type !== '' &&
    file.type !== 'application/octet-stream' &&
    file.type !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    throw new ReachDeckPptxUploadError('PPTX upload content type is not supported', 400);
  }
  // Checked before `arrayBuffer()`: an oversized deck must not cost a second
  // copy of itself in memory just to be refused.
  if (file.size > REACH_DECK_PPTX_MAX_UPLOAD_BYTES) throw pptxUploadTooLargeError(file.size);
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    target,
    ...(sourceDigests.length === 1 ? { sourceDigest: sourceDigests[0] as string } : {}),
    ...(mapping === undefined ? {} : { mapping }),
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
    ...(acceptDegraded ? { acceptDegraded: true } : {}),
    ...(completionActions.length === 1 ? { completionAction: 'generate-narration' as const } : {}),
  };
}

function readPptxTargetIdentity(form: FormData): ReachDeckPptxTargetIdentity | undefined {
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
    throw new ReachDeckPptxUploadError(
      'PPTX target identity fields must be supplied exactly once as a valid complete set',
      400,
    );
  }
  return {
    draftRevision: Number(revisions[0]),
    contentDigest: digests[0],
  };
}

function readPptxMappingIdentity(form: FormData): ReachDeckPptxMappingIdentity | undefined {
  const fieldNames = [
    'mappingSchemaVersion',
    'mappingGeneratedAt',
    'profileDigest',
    'candidateDigest',
    'mediaDigest',
  ] as const;
  const values = Object.fromEntries(fieldNames.map((name) => [name, form.getAll(name)])) as Record<
    (typeof fieldNames)[number],
    FormDataEntryValue[]
  >;
  const presentCount = fieldNames.filter((name) => values[name].length > 0).length;
  if (presentCount === 0) return undefined;
  if (
    presentCount !== fieldNames.length ||
    fieldNames.some((name) => values[name].length !== 1 || typeof values[name][0] !== 'string')
  ) {
    throw new ReachDeckPptxUploadError(
      'PPTX mapping identity fields must be supplied exactly once as a complete set',
      400,
    );
  }
  const schemaVersion = values.mappingSchemaVersion[0] as string;
  const generatedAt = values.mappingGeneratedAt[0] as string;
  if (schemaVersion !== PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION) {
    throw new ReachDeckPptxUploadError('PPTX mapping schemaVersion is invalid', 400);
  }
  const generatedTimestamp = Date.parse(generatedAt);
  if (
    Number.isNaN(generatedTimestamp) ||
    new Date(generatedTimestamp).toISOString() !== generatedAt
  ) {
    throw new ReachDeckPptxUploadError('PPTX mapping generatedAt is invalid', 400);
  }
  for (const fieldName of ['profileDigest', 'candidateDigest', 'mediaDigest'] as const) {
    if (!/^sha256:[a-f0-9]{64}$/.test(values[fieldName][0] as string)) {
      throw new ReachDeckPptxUploadError(`PPTX mapping ${fieldName} is invalid`, 400);
    }
  }
  return {
    schemaVersion: PPTX_REACH_DECK_V2_MAPPING_SCHEMA_VERSION,
    generatedAt,
    profileDigest: values.profileDigest[0] as `sha256:${string}`,
    candidateDigest: values.candidateDigest[0] as `sha256:${string}`,
    mediaDigest: values.mediaDigest[0] as `sha256:${string}`,
  };
}
