import { runtimeInternalFetch } from '../internal-fetch-observability.js';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';

import type { ReachDeckDocumentWriterSession } from './decksmith/document-writer.js';
import { stripVolatileReachDeckMediaUrls, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { parseReachDeckMediaOrigin, type ReachDeckMediaOrigin } from '@reachany/reach-deck-dsl';

import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from './resource-scope.js';
import { parseReachDeckVoiceSelection, type ReachDeckVoiceSelection } from './voice-selection.js';
import {
  decodeWorkspaceResourceCacheEntry,
  workspaceReadProjectionCache,
  workspaceResourceCache,
} from './workspace-resource-cache.js';

type FetchLike = typeof fetch;
type ContentServiceEnv = Partial<Record<string, string | undefined>>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReachDeckWorkspaceResource extends ReachDeckResourceScope {
  draftRevision: number;
  workspace: Record<string, unknown>;
  recoveryRevision: number;
  recovery: Record<string, unknown>;
  materializedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReachDeckMaterializationResource extends ReachDeckResourceScope {
  mongodbDocumentId: string;
  draftRevision: number;
  contentDigest: string;
  materializedAt: string;
}

export interface ReachDeckModulePublicationResource extends ReachDeckResourceScope {
  status: 'published';
  publishedModuleVersionId: string;
  versionNo: number;
  mongodbDocumentId: string;
  contentDigest: string;
  publishedBy: string;
  publishedAt: string;
  published: boolean;
}

export interface ReachDeckGeneratedMediaResource {
  objectKey: string;
  downloadUrl: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  speechTimestamps?: ReachDeckGeneratedSpeechTimestamp[];
  origin?: ReachDeckMediaOrigin;
}

export interface ReachDeckGeneratedSpeechTimestamp {
  char: string;
  start: number;
  end: number;
}

export async function resolveReachDeckVoiceSelection(
  options: ContentServiceRequestOptions,
): Promise<ReachDeckVoiceSelection> {
  const scope = requireOptionsScope(options);
  const value = await requestJson(
    uuidBridgePath(scope, 'voice-selection'),
    { method: 'GET' },
    options,
  );
  try {
    const selection = parseReachDeckVoiceSelection(value);
    if (selection.kind === 'clone' && selection.courseId !== scope.courseId) {
      throw new Error('course scope mismatch');
    }
    return selection;
  } catch {
    throw new ContentServiceClientError(
      'content-service returned an invalid Reach Deck voice selection',
      502,
    );
  }
}

export async function exchangeReachDeckVoiceCapability(
  voiceSelection: ReachDeckVoiceSelection,
  operation: 'synthesize' | 'cancel',
  requestIdentity: string,
  options: ContentServiceRequestOptions,
): Promise<string> {
  if (voiceSelection.kind !== 'clone') {
    throw new ContentServiceClientError('Default voice does not require a clone capability', 500);
  }
  const scope = requireOptionsScope(options);
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'voice-selection/capability'),
      {
        method: 'POST',
        body: JSON.stringify({ voiceSelection, operation, requestIdentity }),
      },
      options,
    ),
    'Reach Deck voice capability',
  );
  return requireNonblank(value.capability, 'voice capability', 502);
}

export interface ReachDeckMaterialAssetResource {
  assetId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  status: 'available' | 'pending';
  /** Short-lived layout input; never persist into the generation workspace. */
  downloadUrl?: string;
}

export type ReachDeckAuthoringMediaKind = 'image' | 'audio' | 'video' | 'attachment';

export interface ReachDeckAuthoringMediaPresignResource {
  assetId: string;
  objectKey: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  expiresInSeconds: number;
}

export interface ReachDeckAuthoringMediaResource {
  assetId: string;
  kind: ReachDeckAuthoringMediaKind;
  objectKey: string;
  downloadUrl: string;
  expiresInSeconds: number;
  contentType: string;
  sizeBytes: number;
}

const SPEECH_MEDIA_PROTOCOL = 'reach-deck-speech-media/v1' as const;
const MAX_SPEECH_TIMESTAMPS = 10_000;
/** 与 content-service 的 `MAX_TIMESTAMP_TEXT_LENGTH` 对齐。 */
const MAX_TIMESTAMP_TEXT_LENGTH = 32;
/** 与 content-service 的 `Character::isISOControl` 对齐；无 `g` 标志，避免 `test` 带状态。 */
const ISO_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export type ReachDeckGenerationAuditStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'aborted';

export interface ReachDeckGenerationAuditCreateInput {
  jobId: string;
  runId: string;
  generationKind: string;
  generationStage: string;
  pageId?: string;
  generationAttempt: string;
  requestHash: string;
}

export interface ReachDeckGenerationAuditUpdateInput {
  status: Exclude<ReachDeckGenerationAuditStatus, 'queued'>;
  executionAttempt?: number;
  errorSummary?: string;
  stagedResultRef?: string;
}

export interface ReachDeckGenerationAuditAbortInput {
  errorSummary?: string;
}

/** 停滞对账结清孤儿审计时携带的「证明时读到的审计版本」。 */
export interface ReachDeckGenerationAuditOrphanSettlementInput {
  expectedStatus: Extract<ReachDeckGenerationAuditStatus, 'queued' | 'running' | 'retrying'>;
  expectedExecutionAttempt: number;
  expectedUpdatedAt: string;
}

export interface ReachDeckGenerationAuditResource extends ReachDeckResourceScope {
  id: string;
  jobId: string;
  actorId: string;
  billingGroupId: string | null;
  executionAttempt: number;
  requestHash: string;
  status: ReachDeckGenerationAuditStatus;
  stagedResultRef?: string;
  error?: { code: string; message: string };
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentServiceRequestOptions {
  actorId: string;
  /** Selected session organization for the actor; distinct from the course resource scope. */
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
  env?: ContentServiceEnv;
  fetch?: FetchLike;
  signal?: AbortSignal;
  documentWriterSession?: ReachDeckDocumentWriterSession;
}

export class ContentServiceClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ContentServiceClientError';
  }
}

export class ContentServiceTransportError extends Error {
  readonly retryable = true;
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'ContentServiceTransportError';
    this.cause = cause;
  }
}

/**
 * 读取整份 Reach Deck workspace 资源（条件读取）。
 *
 * 数据源：content-service `GET /reach-deck/courses/{courseId}/nodes/{courseNodeId}/workspace`
 * （Mongo 草稿 workspace 文档）；本进程的 workspace 资源缓存。
 *
 * 核心逻辑：
 * 1. 本进程缓存里有该范围的条目时带上 `If-None-Match`，没有则发无条件请求。
 * 2. `304`：用**发请求前**取到的条目从字节重新解析后返回，期间条目被淘汰或替换也不受影响。
 * 3. `200`：按原逻辑解析；响应带 `ETag` 时回填缓存，不带（旧版 content-service）则不缓存。
 * 4. 其它状态：清掉条目，按原有错误类型、status 与 retryable 判定抛出。
 * 5. 收到 `304` 但本地没有条目（理论上不可能）：清条目后不带条件头重试一次。
 *
 * 每次返回的对象都是独立解析的，调用方可以原地修改。
 */
export async function getReachDeckWorkspace(
  options: ContentServiceRequestOptions,
): Promise<ReachDeckWorkspaceResource> {
  return readReachDeckWorkspace(options, { parse: (resource) => resource });
}

/**
 * Reuse a pure read model only after a fresh authorized conditional GET returns 304.
 * The key identifies one validation algorithm, never an actor-dependent projection. New 200
 * responses always run the parser, even if their ETag matches an earlier response.
 */
export async function getReachDeckWorkspaceReadProjection<T>(
  options: ContentServiceRequestOptions,
  projection: {
    key: symbol;
    parse: (resource: ReachDeckWorkspaceResource) => T;
  },
): Promise<T> {
  return readReachDeckWorkspace(options, projection);
}

async function readReachDeckWorkspace<T>(
  options: ContentServiceRequestOptions,
  projection: { key?: symbol; parse: (resource: ReachDeckWorkspaceResource) => T },
): Promise<T> {
  const scope = requireOptionsScope(options);
  const path = uuidBridgePath(scope, 'workspace');
  const cached = workspaceResourceCache().get(scope);
  let response = await sendContentServiceRequest(
    path,
    cached === undefined
      ? { method: 'GET' }
      : { method: 'GET', headers: { 'if-none-match': cached.etag } },
    options,
  );
  if (response.status === 304) {
    if (cached !== undefined) {
      try {
        if (projection.key !== undefined) {
          const hit = workspaceReadProjectionCache().get<{
            scope: ReachDeckResourceScope;
            value: T;
          }>(cached, projection.key);
          if (hit !== undefined) {
            assertExpectedScope(hit.value.scope, scope);
            return hit.value.value;
          }
        }
        const value = projection.parse(
          parseWorkspace(decodeWorkspaceResourceCacheEntry(cached), scope),
        );
        if (projection.key !== undefined) {
          workspaceReadProjectionCache().set(cached, projection.key, { scope, value });
        }
        return value;
      } catch (error) {
        workspaceResourceCache().delete(scope);
        throw error;
      }
    }
    workspaceResourceCache().delete(scope);
    response = await sendContentServiceRequest(path, { method: 'GET' }, options);
  }
  const resource = acceptWholeWorkspaceResponse(response, 'GET', path, scope);
  // Capture the exact response entry before invoking the synchronous validator.
  const accepted = workspaceResourceCache().get(scope);
  try {
    const value = projection.parse(resource);
    if (accepted !== undefined && projection.key !== undefined) {
      workspaceReadProjectionCache().set(accepted, projection.key, { scope, value });
    }
    return value;
  } catch (error) {
    workspaceResourceCache().delete(scope);
    throw error;
  }
}

export async function createReachDeckWorkspace(
  workspace: unknown,
  recovery: unknown,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckWorkspaceResource> {
  const scope = requireOptionsScope(options);
  return writeWholeWorkspace(
    uuidBridgePath(scope, 'workspace'),
    {
      method: 'POST',
      body: JSON.stringify({
        workspace: requireRecord(workspace, 'Reach Deck workspace'),
        recovery: requireRecord(recovery, 'Reach Deck workspace recovery'),
      }),
    },
    options,
    scope,
  );
}

export async function putReachDeckWorkspace(
  workspace: unknown,
  expectedDraftRevision: number,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckWorkspaceResource> {
  const scope = requireOptionsScope(options);
  requireNonnegativeInteger(expectedDraftRevision, 'expectedDraftRevision');
  return writeWholeWorkspace(
    uuidBridgePath(scope, 'workspace'),
    {
      method: 'PUT',
      body: JSON.stringify({
        workspace: requireRecord(workspace, 'Reach Deck workspace'),
        expectedDraftRevision,
      }),
    },
    options,
    scope,
  );
}

/**
 * 以 `recoveryRevision` 做 CAS 整体替换 recovery 文档，返回写入后的整份资源。
 *
 * 数据源：content-service `PUT /reach-deck/courses/{courseId}/nodes/{courseNodeId}/workspace/recovery`
 * （Mongo 草稿 workspace 文档的 recovery 半边）；本进程的 workspace 资源缓存。
 *
 * 核心逻辑：
 * 1. 仅当缓存条目存在且其 `recoveryRevision` 等于 `expectedRecoveryRevision` 时才发
 *    `Prefer: return=minimal`，让服务端不把文档正文带回来。
 * 2. 响应头 `Preference-Applied` 不含 `return=minimal`（旧版 content-service 会忽略 `Prefer`）：
 *    按整份响应解析，带 `ETag` 则回填缓存。
 * 3. minimal 且响应的 `draftRevision`、`createdAt` 与发请求前的缓存条目一致：用缓存的
 *    `workspace` 半边、实际发出的请求体里的 `recovery`（取 `JSON.parse` 后的值，与线上表示
 *    一致）和响应里的版本字段重组整份资源，校验后返回，并以响应 `ETag` 回填缓存。
 * 4. minimal 但对不上（期间草稿被并发改写或重建）：清条目，再读一次整份资源取 `workspace`
 *    半边、`draftRevision` 与时间字段；`recovery` 半边与 `recoveryRevision` 仍取自本次写入。
 * 5. 任何失败（含 409 冲突）都清掉条目，错误语义不变。
 *
 * 注意：第 4 种情况下返回值的 `workspace` 半边（及 `draftRevision`、时间字段）来自写入之后的
 * 另一次读取，可能比本次写入更新；而且该次读取失败时本函数会抛错，但 recovery 已经写入。
 */
export async function putReachDeckWorkspaceRecovery(
  recovery: unknown,
  expectedRecoveryRevision: number,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckWorkspaceResource> {
  const scope = requireOptionsScope(options);
  requireNonnegativeInteger(expectedRecoveryRevision, 'expectedRecoveryRevision');
  const path = uuidBridgePath(scope, 'workspace/recovery');
  const body = JSON.stringify({
    recovery: requireRecord(recovery, 'Reach Deck workspace recovery'),
    expectedRecoveryRevision,
  });
  const base = readCachedWorkspaceForRecoveryWrite(scope, expectedRecoveryRevision);
  let response: ContentServiceResponse;
  try {
    response = await sendContentServiceRequest(
      path,
      base === undefined
        ? { method: 'PUT', body }
        : { method: 'PUT', body, headers: { prefer: 'return=minimal' } },
      options,
    );
  } catch (error) {
    workspaceResourceCache().delete(scope);
    throw error;
  }
  if (!response.ok || !appliedMinimalPreference(response)) {
    return acceptWholeWorkspaceResponse(response, 'PUT', path, scope);
  }

  let written: Pick<ReachDeckWorkspaceResource, 'recoveryRevision' | 'recovery'>;
  try {
    const version = parseWorkspaceVersion(
      readContentServiceResponseData(response, 'PUT', path),
      scope,
    );
    const sentRecovery = requireRecord(
      (JSON.parse(body) as { recovery: unknown }).recovery,
      'Reach Deck workspace recovery',
    );
    // 版本不连续说明服务端状态与 CAS 前提不符，不能把它写进缓存；交给回退读取与调用方的连续性校验。
    if (
      base !== undefined &&
      version.recoveryRevision === expectedRecoveryRevision + 1 &&
      base.draftRevision === version.draftRevision &&
      sameInstant(base.createdAt, version.createdAt)
    ) {
      const data = { ...version.data, workspace: base.workspace, recovery: sentRecovery };
      const resource = parseWorkspace(data, scope);
      const etag = readResponseEtag(response);
      if (etag === undefined) workspaceResourceCache().delete(scope);
      else workspaceResourceCache().set(scope, etag, data);
      return resource;
    }
    written = { recoveryRevision: version.recoveryRevision, recovery: sentRecovery };
  } catch (error) {
    workspaceResourceCache().delete(scope);
    throw error;
  }
  workspaceResourceCache().delete(scope);
  return { ...(await getReachDeckWorkspace(options)), ...written };
}

export async function materializeReachDeckModule(
  document: unknown,
  expectedDraftRevision: number,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckMaterializationResource> {
  const scope = requireOptionsScope(options);
  requireNonnegativeInteger(expectedDraftRevision, 'expectedDraftRevision');
  const stableDocument = stableReachDeckDocumentForPersistence(
    requireRecord(document, 'Reach Deck document'),
  );
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'materialize'),
      {
        method: 'POST',
        body: JSON.stringify({
          learnerDocument: stableDocument,
          expectedDraftRevision,
        }),
      },
      options,
    ),
    'Reach Deck materialization',
  );
  const actualScope = parseScopeFromResource(value);
  assertExpectedScope(actualScope, scope);
  const draftRevision = value.draftRevision;
  requireNonnegativeInteger(draftRevision, 'draftRevision', 502);
  return {
    ...actualScope,
    mongodbDocumentId: readRequiredString(value, 'mongodbDocumentId'),
    draftRevision,
    contentDigest: readRequiredString(value, 'contentDigest'),
    materializedAt: readRequiredString(value, 'materializedAt'),
  };
}

export async function storeReachDeckGeneratedMedia(
  input: {
    kind: 'image' | 'speech';
    pageId?: string;
    idempotencyKey: string;
    contentType: string;
    bytes: Uint8Array;
    speechTimestamps?: readonly ReachDeckGeneratedSpeechTimestamp[];
    origin?: ReachDeckMediaOrigin;
  },
  options: ContentServiceRequestOptions,
): Promise<ReachDeckGeneratedMediaResource> {
  const scope = requireOptionsScope(options);
  const query = new URLSearchParams({ kind: input.kind });
  if (input.pageId !== undefined) query.set('pageId', requireNonblank(input.pageId, 'pageId'));
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new ContentServiceClientError('generated media bytes must not be empty', 400);
  }
  const body = new Uint8Array(input.bytes.byteLength);
  body.set(input.bytes);
  const speechTimestamps = parseSpeechTimestampsForRequest(input.speechTimestamps, input.kind);
  const origin = input.origin === undefined ? undefined : parseReachDeckMediaOrigin(input.origin);
  if (origin && input.kind !== 'image')
    throw new ContentServiceClientError('Image origin requires image media', 400);
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'generated-media') + '?' + query.toString(),
      {
        method: 'POST',
        headers: {
          'content-type':
            speechTimestamps === undefined && origin === undefined
              ? requireNonblank(input.contentType, 'contentType')
              : 'application/json',
          'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey'),
        },
        body:
          origin !== undefined
            ? JSON.stringify({
                protocol: 'reach-deck-generated-image/v1',
                contentType: input.contentType,
                imageBase64: Buffer.from(body).toString('base64'),
                origin,
              })
            : speechTimestamps === undefined
              ? body.buffer
              : JSON.stringify({
                  protocol: SPEECH_MEDIA_PROTOCOL,
                  contentType: requireNonblank(input.contentType, 'contentType'),
                  audioBase64: Buffer.from(body).toString('base64'),
                  speechTimestamps,
                }),
      },
      options,
    ),
    'Reach Deck generated media',
  );
  const sizeBytes = value.sizeBytes;
  requireNonnegativeInteger(sizeBytes, 'sizeBytes', 502);
  return {
    objectKey: readRequiredString(value, 'objectKey'),
    downloadUrl: readRequiredString(value, 'downloadUrl'),
    contentType: readRequiredString(value, 'contentType'),
    sizeBytes: sizeBytes as number,
    checksumSha256: readGeneratedMediaChecksum(value),
    ...parseOptionalSpeechTimestamps(value.speechTimestamps),
    ...(value.origin == null ? {} : { origin: parseReachDeckMediaOrigin(value.origin) }),
  };
}

export async function storeReachDeckMaterialAsset(
  input: {
    runId: string;
    fileName: string;
    contentType: string;
    sha256: string;
    bytes: Uint8Array;
    idempotencyKey: string;
  },
  options: ContentServiceRequestOptions,
): Promise<ReachDeckMaterialAssetResource> {
  const scope = requireOptionsScope(options);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new ContentServiceClientError('material bytes must not be empty', 400);
  }
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'material-assets'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey'),
        },
        body: JSON.stringify({
          runId: requireNonblank(input.runId, 'runId'),
          fileName: requireNonblank(input.fileName, 'fileName'),
          contentType: requireNonblank(input.contentType, 'contentType'),
          sha256: requireNonblank(input.sha256, 'sha256'),
          bytesBase64: Buffer.from(input.bytes).toString('base64'),
        }),
      },
      options,
    ),
    'Reach Deck material asset',
  );
  requireNonnegativeInteger(value.sizeBytes, 'sizeBytes', 502);
  const sizeBytes = value.sizeBytes as number;
  const status = readRequiredString(value, 'status');
  if (status !== 'available' && status !== 'pending') {
    throw new ContentServiceClientError('Reach Deck material asset status is invalid', 502);
  }
  return {
    assetId: readRequiredString(value, 'assetId'),
    objectKey: readRequiredString(value, 'objectKey'),
    contentType: readRequiredString(value, 'contentType'),
    sizeBytes,
    checksumSha256: readGeneratedMediaChecksum(value),
    status,
  };
}

export async function presignReachDeckAuthoringMedia(
  input: {
    kind: ReachDeckAuthoringMediaKind;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  },
  options: ContentServiceRequestOptions,
): Promise<ReachDeckAuthoringMediaPresignResource> {
  const scope = requireOptionsScope(options);
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'authoring-media/presign'),
      {
        method: 'POST',
        body: JSON.stringify({
          kind: requireAuthoringMediaKind(input.kind),
          fileName: requireNonblank(input.fileName, 'fileName'),
          contentType: requireNonblank(input.contentType, 'contentType'),
          sizeBytes: requirePositiveInteger(input.sizeBytes, 'sizeBytes'),
        }),
      },
      options,
    ),
    'Reach Deck authoring media presign',
  );
  const requiredHeaders = requireRecord(value.requiredHeaders, 'requiredHeaders');
  if (Object.values(requiredHeaders).some((header) => typeof header !== 'string')) {
    throw new ContentServiceClientError(
      'content-service returned invalid authoring media required headers',
      502,
    );
  }
  return {
    assetId: readRequiredUuid(value, 'assetId'),
    objectKey: readRequiredString(value, 'objectKey'),
    uploadUrl: readRequiredString(value, 'uploadUrl'),
    requiredHeaders: requiredHeaders as Record<string, string>,
    expiresInSeconds: requirePositiveInteger(value.expiresInSeconds, 'expiresInSeconds', 502),
  };
}

export async function finalizeReachDeckAuthoringMedia(
  input: { kind: ReachDeckAuthoringMediaKind; assetId: string; objectKey: string },
  options: ContentServiceRequestOptions,
): Promise<ReachDeckAuthoringMediaResource> {
  const scope = requireOptionsScope(options);
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'authoring-media/finalize'),
      {
        method: 'POST',
        body: JSON.stringify({
          kind: requireAuthoringMediaKind(input.kind),
          assetId: requireUuid(input.assetId, 'assetId'),
          objectKey: requireNonblank(input.objectKey, 'objectKey'),
        }),
      },
      options,
    ),
    'Reach Deck authoring media',
  );
  const kind = requireAuthoringMediaKind(value.kind, 502);
  if (kind !== input.kind) {
    throw new ContentServiceClientError(
      'content-service authoring media kind did not match the request',
      502,
    );
  }
  return {
    assetId: readRequiredUuid(value, 'assetId'),
    kind,
    objectKey: readRequiredString(value, 'objectKey'),
    downloadUrl: readRequiredString(value, 'downloadUrl'),
    expiresInSeconds: requirePositiveInteger(value.expiresInSeconds, 'expiresInSeconds', 502),
    contentType: readRequiredString(value, 'contentType'),
    sizeBytes: requirePositiveInteger(value.sizeBytes, 'sizeBytes', 502),
  };
}

export async function deleteReachDeckMaterialAsset(
  assetId: string,
  options: ContentServiceRequestOptions,
): Promise<void> {
  const scope = requireOptionsScope(options);
  await requestJson(
    uuidBridgePath(scope, 'material-assets') +
      '?assetId=' +
      encodeURIComponent(requireNonblank(assetId, 'assetId')),
    {
      method: 'DELETE',
    },
    options,
  );
}

export async function resolveReachDeckMaterialAsset(
  assetId: string,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckMaterialAssetResource> {
  const scope = requireOptionsScope(options);
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'material-assets') +
        '?assetId=' +
        encodeURIComponent(requireNonblank(assetId, 'assetId')),
      { method: 'GET' },
      options,
    ),
    'Reach Deck material asset',
  );
  requireNonnegativeInteger(value.sizeBytes, 'sizeBytes', 502);
  return {
    assetId: readRequiredString(value, 'assetId'),
    objectKey: readRequiredString(value, 'objectKey'),
    contentType: readRequiredString(value, 'contentType'),
    sizeBytes: value.sizeBytes as number,
    checksumSha256: readGeneratedMediaChecksum(value),
    status: readRequiredString(value, 'status') as ReachDeckMaterialAssetResource['status'],
    ...(value.downloadUrl == null ? {} : { downloadUrl: readRequiredString(value, 'downloadUrl') }),
  };
}

export async function previewReachDeckMaterialAsset(
  assetId: string,
  options: ContentServiceRequestOptions,
) {
  const scope = requireOptionsScope(options);
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'material-assets/preview') +
        '?assetId=' +
        encodeURIComponent(requireNonblank(assetId, 'assetId')),
      { method: 'GET' },
      options,
    ),
    'Reach Deck material preview',
  );
  return {
    assetId: readRequiredString(value, 'assetId'),
    contentType: readRequiredString(value, 'contentType'),
    downloadUrl: readRequiredString(value, 'downloadUrl'),
  };
}

export async function findReachDeckGeneratedMedia(
  input: {
    kind: 'image' | 'speech';
    pageId?: string;
    idempotencyKey: string;
  },
  options: ContentServiceRequestOptions,
): Promise<ReachDeckGeneratedMediaResource | undefined> {
  const scope = requireOptionsScope(options);
  const query = new URLSearchParams({ kind: input.kind });
  if (input.pageId !== undefined) query.set('pageId', requireNonblank(input.pageId, 'pageId'));
  try {
    const value = requireRecord(
      await requestJson(
        uuidBridgePath(scope, 'generated-media') + '?' + query.toString(),
        {
          method: 'GET',
          headers: {
            'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey'),
          },
        },
        options,
      ),
      'Reach Deck generated media',
    );
    const sizeBytes = value.sizeBytes;
    requireNonnegativeInteger(sizeBytes, 'sizeBytes', 502);
    return {
      objectKey: readRequiredString(value, 'objectKey'),
      downloadUrl: readRequiredString(value, 'downloadUrl'),
      contentType: readRequiredString(value, 'contentType'),
      sizeBytes: sizeBytes as number,
      checksumSha256: readGeneratedMediaChecksum(value),
      ...parseOptionalSpeechTimestamps(value.speechTimestamps),
      ...(value.origin == null ? {} : { origin: parseReachDeckMediaOrigin(value.origin) }),
    };
  } catch (error) {
    if (error instanceof ContentServiceClientError && error.status === 404) return undefined;
    throw error;
  }
}

/** content-service 授权的一张 Decksmith 参考图；downloadUrl 只用于本次下载，不得持久化。 */
export interface ReachDeckDecksmithImageReference {
  objectKey: string;
  downloadUrl: string;
  expiresInSeconds: number;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  source: 'document' | 'generated';
}

/**
 * 请求 content-service 为本次 Decksmith 运行文档中的一张图片签发短时下载地址（评审 M7）。
 *
 * 数据源：content-service `POST /reach-deck/courses/{courseId}/nodes/{nodeId}/decksmith/image-references`，
 * 由其按物化文档引用或本模块版本生成媒体账本授权，并返回权威 checksum / contentType / size。
 * 核心逻辑：只上送 objectKey 与（文档里有 sha256 digest 时的）期望校验和；返回值逐项校验，
 * 回显的 objectKey 必须与请求一致，校验和必须是 64 位小写十六进制。
 */
export async function resolveReachDeckDecksmithImageReference(
  input: { objectKey: string; expectedChecksumSha256?: string },
  options: ContentServiceRequestOptions,
): Promise<ReachDeckDecksmithImageReference> {
  const scope = requireOptionsScope(options);
  const objectKey = requireNonblank(input.objectKey, 'objectKey');
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'decksmith/image-references'),
      {
        method: 'POST',
        body: JSON.stringify({
          objectKey,
          ...(input.expectedChecksumSha256 === undefined
            ? {}
            : { expectedChecksumSha256: input.expectedChecksumSha256 }),
        }),
      },
      options,
    ),
    'Reach Deck Decksmith image reference',
  );
  if (readRequiredString(value, 'objectKey') !== objectKey) {
    throw new ContentServiceClientError(
      'content-service returned a different image reference',
      502,
    );
  }
  requireNonnegativeInteger(value.sizeBytes, 'sizeBytes', 502);
  requireNonnegativeInteger(value.expiresInSeconds, 'expiresInSeconds', 502);
  const source = readRequiredString(value, 'source');
  if (source !== 'document' && source !== 'generated') {
    throw new ContentServiceClientError('content-service returned an unknown image source', 502);
  }
  return {
    objectKey,
    downloadUrl: readRequiredString(value, 'downloadUrl'),
    expiresInSeconds: value.expiresInSeconds as number,
    contentType: readRequiredString(value, 'contentType'),
    sizeBytes: value.sizeBytes as number,
    checksumSha256: readGeneratedMediaChecksum(value),
    source,
  };
}

function parseSpeechTimestampsForRequest(
  value: readonly ReachDeckGeneratedSpeechTimestamp[] | undefined,
  kind: 'image' | 'speech',
): ReachDeckGeneratedSpeechTimestamp[] | undefined {
  if (value === undefined) return undefined;
  if (kind !== 'speech') {
    throw new ContentServiceClientError('speech timestamps require speech media', 400);
  }
  const parsed = parseSpeechTimestamps(value, 400);
  if (parsed.length === 0) {
    throw new ContentServiceClientError('speech timestamps must not be empty', 400);
  }
  return parsed;
}

function parseOptionalSpeechTimestamps(value: unknown): {
  speechTimestamps?: ReachDeckGeneratedSpeechTimestamp[];
} {
  if (value === undefined || value === null) return {};
  return { speechTimestamps: parseSpeechTimestamps(value, 502) };
}

/**
 * 判定某个词条文本是否违反 content-service 的存储契约。
 *
 * 这里的三条（非空白、长度上限、无 ISO 控制字符）逐条对应
 * `ReachDeckGeneratedMediaService.requireSpeechTimestamps`。两侧口径必须一致：少一条就会
 * 出现"客户端放行、服务端 400"的哑失败，而服务端的 `BusinessException` 不写日志，排查时
 * 根本看不出是谁拒的。
 */
function speechTimestampTextRejection(char: string): string | undefined {
  if (char.trim().length === 0) return 'char must not be blank';
  if (char.length > MAX_TIMESTAMP_TEXT_LENGTH) {
    return `char exceeds ${MAX_TIMESTAMP_TEXT_LENGTH} characters`;
  }
  if (ISO_CONTROL_PATTERN.test(char)) return 'char contains a control character';
  return undefined;
}

function parseSpeechTimestamps(
  value: unknown,
  status: number,
): ReachDeckGeneratedSpeechTimestamp[] {
  if (!Array.isArray(value) || value.length > MAX_SPEECH_TIMESTAMPS) {
    throw new ContentServiceClientError('generated speech timestamps are invalid', status);
  }
  let previousStart = 0;
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw rejectSpeechTimestamp(index, 'entry must be an object', status);
    }
    const { char, start, end } = entry as Record<string, unknown>;
    if (typeof char !== 'string' || char.length < 1) {
      throw rejectSpeechTimestamp(index, 'char must be a nonempty string', status);
    }
    const textRejection = speechTimestampTextRejection(char);
    if (textRejection !== undefined) {
      throw rejectSpeechTimestamp(index, textRejection, status);
    }
    if (typeof start !== 'number' || !Number.isFinite(start) || start < previousStart) {
      throw rejectSpeechTimestamp(index, 'start must be finite and nondecreasing', status);
    }
    if (typeof end !== 'number' || !Number.isFinite(end) || end < start) {
      throw rejectSpeechTimestamp(index, 'end must be finite and at or after start', status);
    }
    previousStart = start;
    return { char, start, end };
  });
}

/**
 * 客户端侧的拒绝原因。
 *
 * 刻意不复用服务端那句 `generated speech timestamp is invalid`：两侧字符串一模一样时，
 * worker 日志里只有这一句，分不清是本地预校验还是 content-service 回的 400。
 */
function rejectSpeechTimestamp(
  index: number,
  reason: string,
  status: number,
): ContentServiceClientError {
  return new ContentServiceClientError(
    `ai-runtime rejected generated speech timestamp #${index}: ${reason}`,
    status,
  );
}

/** 教师编辑后的学习文档 rematerialize：原地替换 draft 物化产物（digest CAS）。 */
export async function rematerializeReachDeckModule(
  document: unknown,
  expectedDraftRevision: number,
  expectedContentDigest: string,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckMaterializationResource> {
  const scope = requireOptionsScope(options);
  requireNonnegativeInteger(expectedDraftRevision, 'expectedDraftRevision');
  requireNonblank(expectedContentDigest, 'expectedContentDigest');
  const stableDocument = stableReachDeckDocumentForPersistence(
    requireRecord(document, 'Reach Deck document'),
  );
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'rematerialize'),
      {
        method: 'POST',
        body: JSON.stringify({
          learnerDocument: stableDocument,
          expectedDraftRevision,
          expectedContentDigest,
        }),
      },
      options,
    ),
    'Reach Deck rematerialization',
  );
  const actualScope = parseScopeFromResource(value);
  assertExpectedScope(actualScope, scope);
  const draftRevision = value.draftRevision;
  requireNonnegativeInteger(draftRevision, 'draftRevision', 502);
  return {
    ...actualScope,
    mongodbDocumentId: readRequiredString(value, 'mongodbDocumentId'),
    draftRevision,
    contentDigest: readRequiredString(value, 'contentDigest'),
    materializedAt: readRequiredString(value, 'materializedAt'),
  };
}

export interface ReachDeckMaterializedDocumentResource extends ReachDeckResourceScope {
  materialized: boolean;
  draftRevision?: number;
  mongodbDocumentId?: string;
  contentDigest?: string;
  materializedAt?: string;
  learnerDocument?: Record<string, unknown>;
}

/** 读取当前 draft 模块版本的物化学习文档（教师编辑器加载用）；未物化时 materialized=false。 */
export async function getReachDeckMaterializedDocument(
  options: ContentServiceRequestOptions,
): Promise<ReachDeckMaterializedDocumentResource> {
  const scope = requireOptionsScope(options);
  const value = requireRecord(
    await requestJson(uuidBridgePath(scope, 'materialized-document'), { method: 'GET' }, options),
    'Reach Deck materialized document',
  );
  const actualScope = parseScopeFromResource(value);
  assertExpectedScope(actualScope, scope);
  if (value.materialized !== true) {
    return { ...actualScope, materialized: false };
  }
  const draftRevision = value.draftRevision;
  requireNonnegativeInteger(draftRevision, 'draftRevision', 502);
  return {
    ...actualScope,
    materialized: true,
    draftRevision,
    mongodbDocumentId: readRequiredString(value, 'mongodbDocumentId'),
    contentDigest: readRequiredString(value, 'contentDigest'),
    materializedAt: readRequiredString(value, 'materializedAt'),
    learnerDocument: requireRecord(value.learnerDocument, 'Reach Deck learner document'),
  };
}

export async function publishReachDeckModule(
  expectedDraftRevision: number,
  expectedContentDigest: string,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckModulePublicationResource> {
  const scope = requireOptionsScope(options);
  requireNonblank(expectedContentDigest, 'expectedContentDigest');
  const value = requireRecord(
    await requestJson(
      uuidBridgePath(scope, 'module-publication'),
      { method: 'POST', body: JSON.stringify({ expectedDraftRevision, expectedContentDigest }) },
      options,
    ),
    'Reach Deck module publication',
  );
  const actualScope = parseScopeFromResource(value);
  assertExpectedScope(actualScope, scope);
  const versionNo = value.versionNo;
  if (typeof versionNo !== 'number' || !Number.isSafeInteger(versionNo) || versionNo < 1) {
    throw new ContentServiceClientError(
      'content-service returned an invalid published version number',
      502,
    );
  }
  return {
    ...actualScope,
    status: 'published',
    publishedModuleVersionId: readRequiredUuid(value, 'publishedModuleVersionId'),
    versionNo,
    mongodbDocumentId: readRequiredString(value, 'mongodbDocumentId'),
    contentDigest: readRequiredString(value, 'contentDigest'),
    publishedBy: readRequiredString(value, 'publishedBy'),
    publishedAt: readRequiredString(value, 'publishedAt'),
    published: readRequiredBoolean(value, 'published'),
  };
}

export async function createReachDeckGenerationAudit(
  input: ReachDeckGenerationAuditCreateInput,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckGenerationAuditResource> {
  const resource = await auditRequest(
    '',
    {
      method: 'POST',
      body: JSON.stringify({ jobId: input.jobId, requestHash: input.requestHash }),
    },
    input.requestHash,
    false,
    options,
  );
  if (resource.jobId !== input.jobId || resource.requestHash !== input.requestHash) {
    throw new ContentServiceClientError(
      'content-service Reach Deck audit provenance did not match the create request',
      502,
    );
  }
  return resource;
}

export async function getReachDeckGenerationAudit(
  jobId: string,
  requestHash: string,
  options: ContentServiceRequestOptions,
  expectedOwner: Pick<ContentServiceRequestOptions, 'actorId' | 'billingGroupId'> = options,
): Promise<ReachDeckGenerationAuditResource> {
  const resource = await auditRequest(
    '/' + encodeURIComponent(jobId),
    { method: 'GET' },
    requestHash,
    true,
    options,
    expectedOwner,
  );
  if (resource.jobId !== jobId) {
    throw new ContentServiceClientError(
      'content-service Reach Deck audit response did not match the request',
      502,
    );
  }
  return resource;
}

export async function updateReachDeckGenerationAudit(
  jobId: string,
  requestHash: string,
  input: ReachDeckGenerationAuditUpdateInput,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckGenerationAuditResource> {
  const transition = auditTransition(input);
  const resource = await auditRequest(
    '/' + encodeURIComponent(jobId) + '/' + transition.path,
    {
      method: 'POST',
      body: JSON.stringify({ requestHash, ...transition.body }),
    },
    requestHash,
    false,
    options,
  );
  if (
    resource.jobId !== jobId ||
    resource.status !== input.status ||
    (input.executionAttempt !== undefined && resource.executionAttempt !== input.executionAttempt)
  ) {
    throw new ContentServiceClientError(
      'content-service Reach Deck audit update response did not match the request',
      502,
    );
  }
  return resource;
}

export async function abortReachDeckGenerationAudit(
  jobId: string,
  requestHash: string,
  input: ReachDeckGenerationAuditAbortInput,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckGenerationAuditResource> {
  const resource = await auditRequest(
    '/' + encodeURIComponent(jobId) + '/abort',
    {
      method: 'POST',
      body: JSON.stringify({
        requestHash,
        errorCode: 'cancelled',
      }),
    },
    requestHash,
    false,
    options,
  );
  if (resource.jobId !== jobId || resource.status !== 'aborted') {
    throw new ContentServiceClientError(
      'content-service Reach Deck abort response did not match the request',
      502,
    );
  }
  return resource;
}

/**
 * 按证明时读到的审计版本原子结清孤儿执行审计。
 *
 * 数据源：content-service 生成审计（MongoDB `reach_deck_generation_jobs`，经 settle-orphaned 转换）。
 *
 * 核心逻辑：
 * 1. 带上证明时读到的状态、executionAttempt 与 updatedAt；content-service 三项全部仍一致才转换；
 * 2. running/retrying 结清为 failed，执行过的 queued 结清为 aborted（错误码与原失败/中止转换一致）；
 * 3. 审计已推进（例如刚发生的手动重试）时返回 409，调用方据此重新判断是否停滞。
 */
export async function settleOrphanedReachDeckGenerationAudit(
  jobId: string,
  requestHash: string,
  input: ReachDeckGenerationAuditOrphanSettlementInput,
  options: ContentServiceRequestOptions,
): Promise<ReachDeckGenerationAuditResource> {
  const target = input.expectedStatus === 'queued' ? 'aborted' : 'failed';
  const resource = await auditRequest(
    '/' + encodeURIComponent(jobId) + '/settle-orphaned',
    {
      method: 'POST',
      body: JSON.stringify({
        requestHash,
        expectedStatus: input.expectedStatus,
        expectedExecutionAttempt: input.expectedExecutionAttempt,
        expectedUpdatedAt: requireNonblank(input.expectedUpdatedAt, 'expectedUpdatedAt'),
        errorCode: target === 'aborted' ? 'cancelled' : 'generation_failed',
      }),
    },
    requestHash,
    false,
    options,
  );
  if (
    resource.jobId !== jobId ||
    resource.status !== target ||
    resource.executionAttempt !== input.expectedExecutionAttempt
  ) {
    throw new ContentServiceClientError(
      'content-service Reach Deck orphan settlement response did not match the request',
      502,
    );
  }
  return resource;
}

async function auditRequest(
  suffix: string,
  init: RequestInit,
  requestHash: string,
  hashInQuery: boolean,
  options: ContentServiceRequestOptions,
  expectedOwner: Pick<ContentServiceRequestOptions, 'actorId' | 'billingGroupId'> = options,
): Promise<ReachDeckGenerationAuditResource> {
  const expectedScope = requireOptionsScope(options);
  return parseAudit(
    await requestJson(
      uuidBridgePath(expectedScope, 'generation-jobs' + suffix) +
        (hashInQuery ? '?requestHash=' + encodeURIComponent(requestHash) : ''),
      init,
      options,
    ),
    expectedScope,
    options,
    expectedOwner,
  );
}

function auditTransition(input: ReachDeckGenerationAuditUpdateInput): {
  path: string;
  body: Record<string, unknown>;
} {
  switch (input.status) {
    case 'running':
      return { path: 'running', body: {} };
    case 'retrying':
      return {
        path: 'retrying',
        body: { expectedExecutionAttempt: input.executionAttempt ?? 0 },
      };
    case 'succeeded':
      return {
        path: 'succeeded',
        body: {
          expectedExecutionAttempt: input.executionAttempt,
          stagedResultRef: requireNonblank(input.stagedResultRef, 'stagedResultRef'),
        },
      };
    case 'failed':
      return {
        path: input.executionAttempt === 0 ? 'enqueue-failed' : 'failed',
        body: {
          ...(input.executionAttempt === 0
            ? {}
            : { expectedExecutionAttempt: input.executionAttempt }),
          errorCode: 'generation_failed',
        },
      };
    case 'aborted':
      return {
        path: 'abort',
        body: {
          errorCode: 'cancelled',
        },
      };
  }
}

/** content-service 响应的状态、响应头与已解析的 JSON 载荷（无法解析时为 `undefined`）。 */
interface ContentServiceResponse {
  status: number;
  ok: boolean;
  headers: Headers | undefined;
  payload: unknown;
}

async function requestJson(
  path: string,
  init: RequestInit,
  options: ContentServiceRequestOptions,
): Promise<unknown> {
  return readContentServiceResponseData(
    await sendContentServiceRequest(path, init, options),
    init.method ?? 'GET',
    path,
  );
}

/** 签发服务令牌并发出请求；不判断状态码，供需要读取状态与响应头的调用方使用。 */
async function sendContentServiceRequest(
  path: string,
  init: RequestInit,
  options: ContentServiceRequestOptions,
): Promise<ContentServiceResponse> {
  const env = options.env ?? process.env;
  const token = await createContentServiceToken(options, env);
  let response: Response;
  try {
    response = await runtimeInternalFetch('ai.content', options.fetch ?? fetch)(
      resolveContentServiceApiUrl(path, env),
      {
        ...init,
        signal: options.signal,
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      },
    );
  } catch (error) {
    throw new ContentServiceTransportError('content-service request failed', error);
  }
  const payload = await response.json().catch(() => undefined);
  return { status: response.status, ok: response.ok, headers: response.headers, payload };
}

/** 把非 2xx 与业务错误码映射为 {@link ContentServiceClientError}，否则取出信封里的 `data`。 */
function readContentServiceResponseData(
  response: ContentServiceResponse,
  method: string,
  path: string,
): unknown {
  if (!response.ok) {
    throw new ContentServiceClientError(
      readString(readRecord(response.payload), 'message') ??
        `content-service ${method} ${path} failed with ${response.status}`,
      response.status,
      isRetryableContentServiceStatus(response.status),
    );
  }
  const envelope = readRecord(response.payload);
  if (envelope === undefined) {
    throw new ContentServiceClientError('content-service response was not an object', 502);
  }
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    throw new ContentServiceClientError(
      readString(envelope, 'message') ?? 'content-service returned an error',
      response.status,
    );
  }
  return 'data' in envelope ? envelope.data : envelope;
}

/** 整份 workspace 写入（POST / PUT workspace）：成功回填缓存，任何失败都清掉条目。 */
async function writeWholeWorkspace(
  path: string,
  init: RequestInit & { method: string },
  options: ContentServiceRequestOptions,
  scope: ReachDeckResourceScope,
): Promise<ReachDeckWorkspaceResource> {
  let response: ContentServiceResponse;
  try {
    response = await sendContentServiceRequest(path, init, options);
  } catch (error) {
    workspaceResourceCache().delete(scope);
    throw error;
  }
  return acceptWholeWorkspaceResponse(response, init.method, path, scope);
}

/**
 * 解析一份整份 workspace 响应并同步缓存。
 *
 * 只有通过校验且带 `ETag` 的响应才写入缓存；不带 `ETag`、非 2xx 或校验失败都清掉该范围的
 * 条目。缓存保存的是序列化后的字节，返回值与缓存不共享引用。
 */
function acceptWholeWorkspaceResponse(
  response: ContentServiceResponse,
  method: string,
  path: string,
  scope: ReachDeckResourceScope,
): ReachDeckWorkspaceResource {
  try {
    const data = readContentServiceResponseData(response, method, path);
    const resource = parseWorkspace(data, scope);
    const etag = readResponseEtag(response);
    if (etag === undefined) workspaceResourceCache().delete(scope);
    else workspaceResourceCache().set(scope, etag, data);
    return resource;
  } catch (error) {
    workspaceResourceCache().delete(scope);
    throw error;
  }
}

/**
 * recovery 写回前取缓存里的整份资源；只有其 `recoveryRevision` 等于本次期望版本时才返回。
 *
 * 返回 `undefined` 表示不能请求 minimal 响应（没有条目、条目版本不符或条目无法解析）。
 */
function readCachedWorkspaceForRecoveryWrite(
  scope: ReachDeckResourceScope,
  expectedRecoveryRevision: number,
): ReachDeckWorkspaceResource | undefined {
  const cached = workspaceResourceCache().get(scope);
  if (cached === undefined) return undefined;
  try {
    const resource = parseWorkspace(decodeWorkspaceResourceCacheEntry(cached), scope);
    return resource.recoveryRevision === expectedRecoveryRevision ? resource : undefined;
  } catch {
    workspaceResourceCache().delete(scope);
    return undefined;
  }
}

/**
 * 两个时间戳是否表示同一时刻。
 *
 * 与 ETag 的口径一致，按 epoch 毫秒比较：同一个 Mongo 时间在整份响应与瘦身响应里的小数位数
 * 可能不同，不能因此误判为文档被重建。无法解析时退回严格的字符串相等。
 */
function sameInstant(left: string, right: string): boolean {
  if (left === right) return true;
  const leftMillis = Date.parse(left);
  return Number.isFinite(leftMillis) && leftMillis === Date.parse(right);
}

/** 只接受形如 `"..."` 或 `W/"..."` 的可见 ASCII ETag，避免把异常值回写进请求头。 */
const ETAG_PATTERN = /^(?:W\/)?"[\x21\x23-\x7e]+"$/;

function readResponseEtag(response: ContentServiceResponse): string | undefined {
  const etag = response.headers?.get('etag')?.trim();
  return etag !== undefined && ETAG_PATTERN.test(etag) ? etag : undefined;
}

/** 服务端是否真的按 `Prefer: return=minimal` 返回了瘦身响应（旧版服务端会忽略该请求头）。 */
function appliedMinimalPreference(response: ContentServiceResponse): boolean {
  const applied = response.headers?.get('preference-applied');
  return (
    typeof applied === 'string' &&
    applied
      .split(/[,;]/)
      .some((preference) => preference.replace(/[\s"]/g, '').toLowerCase() === 'return=minimal')
  );
}

function parseWorkspace(
  value: unknown,
  expectedScope: ReachDeckResourceScope,
): ReachDeckWorkspaceResource {
  const resource = requireRecord(value, 'Reach Deck workspace');
  const scope = parseScopeFromResource(resource);
  assertExpectedScope(scope, expectedScope);
  const draftRevision = resource.draftRevision;
  const recoveryRevision = resource.recoveryRevision ?? 0;
  requireNonnegativeInteger(draftRevision, 'draftRevision', 502);
  requireNonnegativeInteger(recoveryRevision, 'recoveryRevision', 502);
  return {
    ...scope,
    draftRevision,
    workspace: requireRecord(resource.workspace, 'Reach Deck workspace'),
    recoveryRevision,
    recovery:
      resource.recovery === undefined
        ? {
            schemaVersion: 'reach-deck-workspace-recovery/v2',
            jobs: {},
            results: {},
            decksmithJobs: {},
            decksmithResults: {},
          }
        : requireRecord(resource.recovery, 'Reach Deck workspace recovery'),
    materializedAt: readString(resource, 'materializedAt'),
    createdAt: readRequiredString(resource, 'createdAt'),
    updatedAt: readRequiredString(resource, 'updatedAt'),
  };
}

/**
 * 解析 `Prefer: return=minimal` 的 recovery 写回响应：只含上下文字段与版本字段，不含正文。
 *
 * `data` 原样保留，用于与缓存的 `workspace` 半边、请求体里的 `recovery` 重组整份资源。
 */
function parseWorkspaceVersion(
  value: unknown,
  expectedScope: ReachDeckResourceScope,
): {
  data: Record<string, unknown>;
  draftRevision: number;
  recoveryRevision: number;
  createdAt: string;
} {
  const data = requireRecord(value, 'Reach Deck workspace version');
  assertExpectedScope(parseScopeFromResource(data), expectedScope);
  const draftRevision = data.draftRevision;
  const recoveryRevision = data.recoveryRevision;
  requireNonnegativeInteger(draftRevision, 'draftRevision', 502);
  requireNonnegativeInteger(recoveryRevision, 'recoveryRevision', 502);
  readRequiredString(data, 'updatedAt');
  return {
    data,
    draftRevision,
    recoveryRevision,
    createdAt: readRequiredString(data, 'createdAt'),
  };
}

function parseAudit(
  value: unknown,
  expectedScope: ReachDeckResourceScope,
  options: ContentServiceRequestOptions,
  expectedOwner: Pick<ContentServiceRequestOptions, 'actorId' | 'billingGroupId'> = options,
): ReachDeckGenerationAuditResource {
  const audit = requireRecord(value, 'Reach Deck generation audit');
  const scope = parseScopeFromResource(audit);
  assertExpectedScope(scope, expectedScope);
  const executionAttempt = audit.executionAttempt;
  requireNonnegativeInteger(executionAttempt, 'executionAttempt', 502);
  const status = readRequiredString(audit, 'status') as ReachDeckGenerationAuditStatus;
  if (!['queued', 'running', 'retrying', 'succeeded', 'failed', 'aborted'].includes(status)) {
    throw new ContentServiceClientError('content-service returned an invalid audit status', 502);
  }
  if (readRequiredString(audit, 'actorId') !== expectedOwner.actorId) {
    throw new ContentServiceClientError(
      'content-service Reach Deck audit scope did not match the signed request',
      502,
    );
  }
  return {
    ...scope,
    id: readRequiredString(audit, 'id'),
    jobId: readRequiredString(audit, 'jobId'),
    actorId: expectedOwner.actorId,
    billingGroupId: expectedOwner.billingGroupId,
    executionAttempt,
    requestHash: readRequiredString(audit, 'requestHash'),
    status,
    stagedResultRef: readString(audit, 'stagedResultRef'),
    error: parsePublicError(audit.error),
    startedAt: readString(audit, 'startedAt'),
    completedAt: readString(audit, 'completedAt'),
    createdAt: readRequiredString(audit, 'createdAt'),
    updatedAt: readRequiredString(audit, 'updatedAt'),
  };
}

function parsePublicError(value: unknown): { code: string; message: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const error = requireRecord(value, 'Reach Deck generation public error');
  return {
    code: readRequiredString(error, 'code'),
    message: readRequiredString(error, 'message'),
  };
}

function parseScopeFromResource(resource: Record<string, unknown>): ReachDeckResourceScope {
  return parseReachDeckResourceScope({
    organizationId: readRequiredString(resource, 'organizationId'),
    courseId: readRequiredString(resource, 'courseId'),
    courseWorkspaceType: readRequiredString(resource, 'courseWorkspaceType'),
    courseNodeId: readRequiredString(resource, 'courseNodeId'),
    moduleId: readRequiredString(resource, 'moduleId'),
    moduleVersionId: readRequiredString(resource, 'moduleVersionId'),
  });
}

function assertExpectedScope(
  actual: ReachDeckResourceScope,
  expected: ReachDeckResourceScope,
): void {
  if (!sameReachDeckResourceScope(actual, expected)) {
    throw new ContentServiceClientError(
      'content-service returned the wrong Reach Deck UUID scope',
      502,
    );
  }
}

function requireOptionsScope(options: ContentServiceRequestOptions): ReachDeckResourceScope {
  return parseReachDeckResourceScope(options.resourceScope);
}

function uuidBridgePath(scope: ReachDeckResourceScope, suffix: string): string {
  return (
    `/reach-deck/courses/${encodeURIComponent(scope.courseId)}/nodes/` +
    `${encodeURIComponent(scope.courseNodeId)}/${suffix}`
  );
}

function resolveContentServiceApiUrl(path: string, env: ContentServiceEnv): string {
  const raw = env.REACHANY_CONTENT_BASE_URL ?? 'http://127.0.0.1:8000';
  const url = new URL(raw.endsWith('/') ? raw : raw + '/');
  const root = url.pathname.replace(/\/+$/, '');
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  url.pathname = `${root.endsWith('/api/v1') ? root : root + '/api/v1'}${pathname}`;
  url.search = queryIndex === -1 ? '' : path.slice(queryIndex + 1);
  url.hash = '';
  return url.toString();
}

async function createContentServiceToken(
  options: ContentServiceRequestOptions,
  env: ContentServiceEnv,
): Promise<string> {
  let config;
  try {
    config = readHs256ServiceJwtConfig(env);
  } catch {
    throw new ContentServiceClientError(
      'Reach Deck content-service JWT configuration is invalid',
      500,
    );
  }
  const scope = requireOptionsScope(options);
  return createHs256Token({
    secret: config.secret,
    subject: 'ai-runtime',
    actorId: requireNonblank(options.actorId, 'actorId'),
    orgId: requireUuid(options.actorOrganizationId ?? scope.organizationId, 'actorOrganizationId'),
    issuer: config.issuer,
    audience: config.audience,
    expiresInSeconds: 5 * 60,
    roles: ['ai-runtime-service'],
    extraClaims: {
      token_type: 'service',
      scene_id: 'teacher.deck',
      billing_group_id: options.billingGroupId,
      role_grant_id: requireNonblank(options.roleGrantId, 'roleGrantId'),
      organization_id: scope.organizationId,
      course_id: scope.courseId,
      course_workspace_type: scope.courseWorkspaceType,
      course_node_id: scope.courseNodeId,
      module_id: scope.moduleId,
      module_version_id: scope.moduleVersionId,
    },
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContentServiceClientError(label + ' must be an object', 502);
  }
  return value as Record<string, unknown>;
}

function stableReachDeckDocumentForPersistence(
  document: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(document.pages)) return document;
  return stripVolatileReachDeckMediaUrls(
    document as unknown as ReachDeckDocument,
  ) as unknown as Record<string, unknown>;
}

function readGeneratedMediaChecksum(value: Record<string, unknown>): string {
  const checksumSha256 = readRequiredString(value, 'checksumSha256');
  if (!/^[0-9a-f]{64}$/.test(checksumSha256)) {
    throw new ContentServiceClientError(
      'content-service returned an invalid generated media checksum',
      502,
    );
  }
  return checksumSha256;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRequiredString(record: Record<string, unknown>, field: string): string {
  return requireNonblank(record[field], field, 502);
}

function readRequiredUuid(record: Record<string, unknown>, field: string): string {
  const value = readRequiredString(record, field);
  if (!UUID_PATTERN.test(value)) {
    throw new ContentServiceClientError(
      'content-service returned an invalid ' + field + ' UUID',
      502,
    );
  }
  return value.toLowerCase();
}

function requireUuid(value: unknown, field: string, status = 400): string {
  const uuid = requireNonblank(value, field, status).toLowerCase();
  if (!UUID_PATTERN.test(uuid)) {
    throw new ContentServiceClientError(field + ' must be a UUID', status);
  }
  return uuid;
}

function requirePositiveInteger(value: unknown, field: string, status = 400): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ContentServiceClientError(field + ' must be a positive integer', status);
  }
  return value;
}

function requireAuthoringMediaKind(value: unknown, status = 400): ReachDeckAuthoringMediaKind {
  if (value !== 'image' && value !== 'audio' && value !== 'video' && value !== 'attachment') {
    throw new ContentServiceClientError(
      'authoring media kind must be image, audio, video, or attachment',
      status,
    );
  }
  return value;
}

function readRequiredBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw new ContentServiceClientError(
      'content-service returned an invalid ' + field + ' boolean',
      502,
    );
  }
  return value;
}

function readString(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function requireNonblank(value: unknown, label: string, status = 400): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContentServiceClientError('Reach Deck content context requires ' + label, status);
  }
  return value.trim();
}

function requireNonnegativeInteger(
  value: unknown,
  label: string,
  status = 400,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ContentServiceClientError(label + ' must be a nonnegative integer', status);
  }
}

function isRetryableContentServiceStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
