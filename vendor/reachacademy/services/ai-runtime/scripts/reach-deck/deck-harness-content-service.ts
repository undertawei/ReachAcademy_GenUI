/**
 * 调试工作台用的内存版 content-service。
 *
 * 真实 content-service 会把 Reach Deck 的草稿工作区、物化文档与生成媒体落到共享
 * PostgreSQL/MongoDB/OSS，并且在入口处按真实课程与角色授权鉴权——这意味着想跑一次
 * 生成就得先有一门真实课程、一个真实教师账号和对应的管理权限，还会写进大家共用的库。
 *
 * 这个替身在同一个 HTTP 契约上提供纯内存实现：课程、权限与存储都是假的，
 * 生成编排、模型调用、队列与 worker 全是真的。把 AI Runtime 的
 * `REACHANY_CONTENT_BASE_URL` 指过来即可，AI Runtime 一行代码都不用改。
 *
 * 它只服务本地调试：绑回环、不鉴权、进程退出即丢失全部数据。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { parseReachDeckMediaOrigin, type ReachDeckMediaOrigin } from '@reachany/reach-deck-dsl';

export const DECK_HARNESS_CONTENT_HOST = '127.0.0.1';
/** 单个生成媒体的字节上限，够一张插图或一段整页音频。 */
export const DECK_HARNESS_CONTENT_MAX_BODY_BYTES = 64 * 1024 * 1024;

const BRIDGE_PATTERN =
  /^\/api\/v1\/reach-deck\/courses\/([0-9a-f-]{36})\/nodes\/([0-9a-f-]{36})\/(.+)$/i;
const SPEECH_MEDIA_PROTOCOL = 'reach-deck-speech-media/v1';
const IMAGE_MEDIA_PROTOCOL = 'reach-deck-generated-image/v1';

/**
 * 替身持有的资源范围。
 *
 * 真实服务是用 (organizationId, courseId, 'draft', courseNodeId) 去课程表查出
 * moduleId 与 moduleVersionId；这里直接由配置给出，等价于"这门课就长这样"。
 */
export interface DeckHarnessContentScope {
  organizationId: string;
  courseId: string;
  courseNodeId: string;
  moduleId: string;
  moduleVersionId: string;
  moduleTitle: string;
}

interface WorkspaceRecord {
  workspace: Record<string, unknown>;
  recovery: Record<string, unknown>;
  draftRevision: number;
  recoveryRevision: number;
  createdAt: string;
  updatedAt: string;
}

interface MaterializationRecord {
  mongodbDocumentId: string;
  draftRevision: number;
  contentDigest: string;
  materializedAt: string;
  learnerDocument: Record<string, unknown>;
}

/**
 * 生成审计记录：同一 (jobId, requestHash) 的唯一状态机。
 *
 * 它是链式推进、教师手动发起与恢复重放之间唯一的去重点，所以 executionAttempt
 * 必须按真实语义推进——worker 会拿 running 返回的值作为 succeeded 的乐观并发条件。
 */
interface AuditRecord {
  id: string;
  jobId: string;
  requestHash: string;
  actorId: string;
  executionAttempt: number;
  status: 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'aborted';
  stagedResultRef?: string;
  error?: { code: string; message: string };
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface MediaRecord {
  objectKey: string;
  contentType: string;
  bytes: Buffer;
  checksumSha256: string;
  speechTimestamps?: unknown;
  origin?: ReachDeckMediaOrigin;
}

export interface DeckHarnessContentService {
  origin: string;
  close: () => Promise<void>;
  server: Server;
  /** 已存下的生成媒体，供测试与排障检查。 */
  media: ReadonlyMap<string, MediaRecord>;
}

/** 与真实服务一致的错误包络。 */
class BridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function startDeckHarnessContentService(input: {
  scope: DeckHarnessContentScope;
  /** 生成媒体的落盘目录；只写不读，便于事后翻看产物。 */
  mediaDirectory?: string;
  port?: number;
}): Promise<DeckHarnessContentService> {
  const workspaces = new Map<string, WorkspaceRecord>();
  const materializations = new Map<string, MaterializationRecord>();
  const media = new Map<string, MediaRecord>();
  const mediaIdempotency = new Map<string, string>();
  const audits = new Map<string, AuditRecord>();
  const materialAssets = new Map<string, { assetId: string; bytes: Buffer; contentType: string }>();

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = error instanceof BridgeError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'harness content-service failed';
      if (!response.headersSent) writeJson(response, status, { code: status, message, data: null });
      else response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port ?? 0, DECK_HARNESS_CONTENT_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The harness content-service has no TCP address.');
  }
  const origin = `http://${DECK_HARNESS_CONTENT_HOST}:${address.port}`;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', origin);
    const method = request.method ?? 'GET';

    // 生成媒体的回读地址：Player 与编辑器按 downloadUrl 直接取字节。
    if (url.pathname.startsWith('/harness-media/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      const record = media.get(decodeURIComponent(url.pathname.slice('/harness-media/'.length)));
      if (record === undefined) {
        response.writeHead(404).end();
        return;
      }
      const range = request.headers.range;
      let start = 0;
      let end = record.bytes.byteLength - 1;
      if (range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          start = match[1]
            ? Number(match[1])
            : Math.max(0, record.bytes.byteLength - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        } else {
          start = -1;
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start > end ||
          start >= record.bytes.byteLength
        ) {
          response.writeHead(416, { 'content-range': `bytes */${record.bytes.byteLength}` }).end();
          return;
        }
      }
      response.writeHead(range === undefined ? 200 : 206, {
        'content-type': record.contentType,
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        ...(range === undefined
          ? {}
          : { 'content-range': `bytes ${start}-${end}/${record.bytes.byteLength}` }),
      });
      response.end(method === 'HEAD' ? undefined : record.bytes.subarray(start, end + 1));
      return;
    }

    const match = BRIDGE_PATTERN.exec(url.pathname);
    if (match === null) {
      throw new BridgeError('unsupported harness content-service path', 404);
    }
    const [, courseId, courseNodeId, suffix] = match as unknown as [string, string, string, string];
    if (
      courseId.toLowerCase() !== input.scope.courseId ||
      courseNodeId.toLowerCase() !== input.scope.courseNodeId
    ) {
      // 真实服务此时会返回"课程不存在"；替身只认配置里的那一门课。
      throw new BridgeError('harness content-service serves a single debug course', 404);
    }
    const key = `${input.scope.moduleVersionId}`;

    if (suffix === 'context' && method === 'GET') {
      writeOk(response, scopeBody(input.scope));
      return;
    }

    if (suffix === 'voice-selection' && method === 'GET') {
      // 默认音色即可：克隆音色是产品侧的授权能力，调试工作台不涉及。
      writeOk(response, { kind: 'default', voice: 'zh_female_vv_uranus_bigtts' });
      return;
    }

    if (suffix === 'workspace') {
      if (method === 'GET') {
        const record = workspaces.get(key);
        if (record === undefined) throw new BridgeError('workspace not found', 404);
        writeOk(response, workspaceBody(input.scope, record));
        return;
      }
      if (method === 'POST') {
        if (workspaces.has(key)) throw new BridgeError('workspace already exists', 409);
        const body = await readJson(request);
        const now = new Date().toISOString();
        // 新建工作区的修订从 0 起：AI Runtime 显式校验这一点，非 0 会被判成
        // content-service 行为异常而拒绝建区。
        const record: WorkspaceRecord = {
          workspace: requireRecord(body.workspace, 'workspace'),
          recovery: isRecord(body.recovery) ? body.recovery : {},
          draftRevision: 0,
          recoveryRevision: 0,
          createdAt: now,
          updatedAt: now,
        };
        workspaces.set(key, record);
        writeOk(response, workspaceBody(input.scope, record));
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(request);
        const record = workspaces.get(key);
        if (record === undefined) throw new BridgeError('workspace not found', 404);
        // CAS 与真实服务同义：修订不匹配就是并发冲突，交给调用方重读后重试。
        if (record.draftRevision !== body.expectedDraftRevision) {
          throw new BridgeError('workspace draft revision conflict', 409);
        }
        record.workspace = requireRecord(body.workspace, 'workspace');
        record.draftRevision += 1;
        record.updatedAt = new Date().toISOString();
        writeOk(response, workspaceBody(input.scope, record));
        return;
      }
    }

    if (suffix === 'workspace/recovery' && method === 'PUT') {
      const body = await readJson(request);
      const record = workspaces.get(key);
      if (record === undefined) throw new BridgeError('workspace not found', 404);
      if (record.recoveryRevision !== body.expectedRecoveryRevision) {
        throw new BridgeError('workspace recovery revision conflict', 409);
      }
      record.recovery = requireRecord(body.recovery, 'recovery');
      record.recoveryRevision += 1;
      record.updatedAt = new Date().toISOString();
      writeOk(response, workspaceBody(input.scope, record));
      return;
    }

    if (suffix === 'materialize' && method === 'POST') {
      const body = await readJson(request);
      const record = workspaces.get(key);
      if (record === undefined) throw new BridgeError('workspace not found', 404);
      if (record.draftRevision !== body.expectedDraftRevision) {
        throw new BridgeError('workspace draft revision conflict', 409);
      }
      const learnerDocument = requireRecord(body.learnerDocument, 'learnerDocument');
      const materialization: MaterializationRecord = {
        mongodbDocumentId: randomUUID(),
        draftRevision: record.draftRevision,
        contentDigest: digest(JSON.stringify(learnerDocument)),
        materializedAt: new Date().toISOString(),
        learnerDocument,
      };
      materializations.set(key, materialization);
      record.updatedAt = materialization.materializedAt;
      writeOk(response, { ...scopeBody(input.scope), ...withoutDocument(materialization) });
      return;
    }

    if (suffix === 'rematerialize' && method === 'POST') {
      const body = await readJson(request);
      const record = workspaces.get(key);
      if (record === undefined) throw new BridgeError('workspace not found', 404);
      const existing = materializations.get(key);
      if (existing === undefined) throw new BridgeError('module is not materialized', 404);
      if (record.draftRevision !== body.expectedDraftRevision) {
        throw new BridgeError('workspace draft revision conflict', 409);
      }
      if (existing.contentDigest !== body.expectedContentDigest) {
        throw new BridgeError('materialization digest conflict', 409);
      }
      const learnerDocument = requireRecord(body.learnerDocument, 'learnerDocument');
      const materialization: MaterializationRecord = {
        ...existing,
        draftRevision: record.draftRevision,
        contentDigest: digest(JSON.stringify(learnerDocument)),
        materializedAt: new Date().toISOString(),
        learnerDocument,
      };
      materializations.set(key, materialization);
      writeOk(response, { ...scopeBody(input.scope), ...withoutDocument(materialization) });
      return;
    }

    if (suffix === 'materialized-document' && method === 'GET') {
      const materialization = materializations.get(key);
      if (materialization === undefined) {
        writeOk(response, { ...scopeBody(input.scope), materialized: false });
        return;
      }
      writeOk(response, {
        ...scopeBody(input.scope),
        materialized: true,
        ...withoutDocument(materialization),
        learnerDocument: materialization.learnerDocument,
      });
      return;
    }

    if (suffix === 'generated-media' && method === 'GET') {
      // 讲稿/图片落地前先按幂等键回查：命中就复用已存的对象，不再重复生成。
      const idempotencyKey = header(request, 'idempotency-key');
      const objectKey =
        idempotencyKey === undefined ? undefined : mediaIdempotency.get(idempotencyKey);
      const record = objectKey === undefined ? undefined : media.get(objectKey);
      if (record === undefined) throw new BridgeError('generated media not found', 404);
      writeOk(response, mediaBody(origin, record));
      return;
    }

    if (suffix === 'generated-media-resources' && method === 'GET') {
      writeOk(response, {
        ...scopeBody(input.scope),
        media: [...media.values()].map((record) => ({
          objectKey: record.objectKey,
          contentType: record.contentType,
          ...(record.origin === undefined ? {} : { origin: record.origin }),
        })),
      });
      return;
    }

    if (suffix === 'generated-media' && method === 'POST') {
      const idempotencyKey = header(request, 'idempotency-key');
      const existingKey =
        idempotencyKey === undefined ? undefined : mediaIdempotency.get(idempotencyKey);
      if (existingKey !== undefined) {
        // 与真实服务一致：同一个幂等键重复提交返回同一个对象，不产生第二份字节。
        writeOk(response, mediaBody(origin, media.get(existingKey)!));
        return;
      }
      const contentType = header(request, 'content-type') ?? 'application/octet-stream';
      const raw = await readBody(request);
      const record = await storeMedia({
        raw,
        contentType,
        kind: url.searchParams.get('kind') ?? 'image',
        mediaDirectory: input.mediaDirectory,
      });
      media.set(record.objectKey, record);
      if (idempotencyKey !== undefined) mediaIdempotency.set(idempotencyKey, record.objectKey);
      writeOk(response, mediaBody(origin, record));
      return;
    }

    if (suffix === 'generation-jobs' && method === 'POST') {
      const body = await readJson(request);
      const jobId = requireString(body.jobId, 'jobId');
      const requestHash = requireString(body.requestHash, 'requestHash');
      const existing = audits.get(jobId);
      // 幂等：同身份重复创建返回现有记录，由调用方按 status/executionAttempt 判断能否入队。
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          throw new BridgeError('generation audit provenance conflict', 409);
        }
        writeOk(response, auditBody(input.scope, existing));
        return;
      }
      const now = new Date().toISOString();
      const record: AuditRecord = {
        id: randomUUID(),
        jobId,
        requestHash,
        actorId: callerActorId(request),
        executionAttempt: 0,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      };
      audits.set(jobId, record);
      writeOk(response, auditBody(input.scope, record));
      return;
    }

    if (suffix.startsWith('generation-jobs/')) {
      const rest = suffix.slice('generation-jobs/'.length).split('/');
      const jobId = decodeURIComponent(rest[0] ?? '');
      const transition = rest[1];
      const record = audits.get(jobId);
      if (record === undefined) throw new BridgeError('generation audit not found', 404);

      if (transition === undefined && method === 'GET') {
        const requestHash = url.searchParams.get('requestHash');
        if (requestHash !== null && requestHash !== record.requestHash) {
          throw new BridgeError('generation audit not found', 404);
        }
        writeOk(response, auditBody(input.scope, record));
        return;
      }
      if (method !== 'POST') throw new BridgeError('unsupported generation audit call', 404);

      const body = await readJson(request);
      if (typeof body.requestHash === 'string' && body.requestHash !== record.requestHash) {
        throw new BridgeError('generation audit provenance conflict', 409);
      }
      const now = new Date().toISOString();
      // 乐观并发：除 running 外的转移都要求 executionAttempt 精确匹配，
      // 与真实服务一致——不匹配说明这个任务已被另一路推进过。
      const requireAttempt = (): void => {
        const expected = body.expectedExecutionAttempt;
        if (typeof expected === 'number' && expected !== record.executionAttempt) {
          throw new BridgeError('generation audit execution attempt conflict', 409);
        }
      };
      const publicError = (fallback: string) => ({
        code: typeof body.errorCode === 'string' ? body.errorCode : fallback,
        message: typeof body.errorCode === 'string' ? body.errorCode : fallback,
      });

      switch (transition) {
        case 'running':
          record.executionAttempt += 1;
          record.status = 'running';
          record.startedAt = now;
          break;
        case 'retrying':
          requireAttempt();
          record.status = 'retrying';
          break;
        case 'succeeded':
          requireAttempt();
          record.status = 'succeeded';
          record.stagedResultRef = requireString(body.stagedResultRef, 'stagedResultRef');
          record.completedAt = now;
          break;
        case 'failed':
          requireAttempt();
          record.status = 'failed';
          record.error = publicError('generation_failed');
          record.completedAt = now;
          break;
        case 'enqueue-failed':
          record.status = 'failed';
          record.error = publicError('generation_failed');
          record.completedAt = now;
          break;
        case 'abort':
          record.status = 'aborted';
          record.error = publicError('cancelled');
          record.completedAt = now;
          break;
        default:
          throw new BridgeError(`unsupported generation audit transition ${transition}`, 404);
      }
      record.updatedAt = now;
      writeOk(response, auditBody(input.scope, record));
      return;
    }

    if (suffix === 'material-assets' && method === 'POST') {
      const body = await readJson(request);
      const assetId = randomUUID();
      const bytes = Buffer.from(String(body.bytesBase64 ?? ''), 'base64');
      const contentType = String(body.contentType ?? 'application/octet-stream');
      materialAssets.set(assetId, { assetId, bytes, contentType });
      writeOk(response, {
        assetId,
        objectKey: `harness/material/${assetId}`,
        contentType,
        sizeBytes: bytes.byteLength,
        checksumSha256: digest(bytes),
        status: 'available',
      });
      return;
    }

    // 发布、教师素材直传等产品能力不属于生成编排，调试工作台不模拟它们。
    throw new BridgeError(`harness content-service does not implement ${method} ${suffix}`, 501);
  }

  return {
    origin,
    media,
    server,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * 存一份生成媒体。
 *
 * 语音带时间戳时，AI Runtime 发的是一个 JSON 信封（音频 base64 + 逐字时间戳），
 * 与纯字节的图片请求形状不同，这里按 content-type 区分。
 */
async function storeMedia(input: {
  raw: Buffer;
  contentType: string;
  kind: string;
  mediaDirectory?: string;
}): Promise<MediaRecord> {
  let bytes = input.raw;
  let contentType = input.contentType;
  let speechTimestamps: unknown;
  let origin: ReachDeckMediaOrigin | undefined;
  if (contentType.startsWith('application/json')) {
    const envelope = JSON.parse(input.raw.toString('utf8')) as Record<string, unknown>;
    if (envelope.protocol === IMAGE_MEDIA_PROTOCOL && input.kind === 'image') {
      if (
        typeof envelope.imageBase64 !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          envelope.imageBase64,
        )
      ) {
        throw new BridgeError('invalid generated image base64', 400);
      }
      contentType = String(envelope.contentType ?? '');
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)) {
        throw new BridgeError('unsupported generated image content type', 400);
      }
      bytes = Buffer.from(envelope.imageBase64, 'base64');
      try {
        origin =
          envelope.origin === undefined ? undefined : parseReachDeckMediaOrigin(envelope.origin);
      } catch {
        throw new BridgeError('invalid generated image origin', 400);
      }
    } else if (envelope.protocol === SPEECH_MEDIA_PROTOCOL && input.kind === 'speech') {
      bytes = Buffer.from(String(envelope.audioBase64 ?? ''), 'base64');
      contentType = String(envelope.contentType ?? 'audio/mpeg');
      speechTimestamps = envelope.speechTimestamps;
    } else {
      throw new BridgeError('unsupported generated media envelope', 400);
    }
  }
  if (bytes.byteLength === 0) throw new BridgeError('generated media bytes must not be empty', 400);
  const checksumSha256 = digest(bytes);
  const assetDigest =
    origin === undefined ? checksumSha256 : digest(JSON.stringify({ checksumSha256, origin }));
  const objectKey = `harness/${input.kind}/${assetDigest.slice(0, 32)}${extensionFor(contentType)}`;
  if (input.mediaDirectory !== undefined) {
    const file = path.join(input.mediaDirectory, objectKey);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return {
    objectKey,
    contentType,
    bytes,
    checksumSha256,
    ...(speechTimestamps === undefined ? {} : { speechTimestamps }),
    ...(origin === undefined ? {} : { origin }),
  };
}

function mediaBody(origin: string, record: MediaRecord) {
  return {
    objectKey: record.objectKey,
    downloadUrl: `${origin}/harness-media/${encodeURIComponent(record.objectKey)}`,
    contentType: record.contentType,
    sizeBytes: record.bytes.byteLength,
    checksumSha256: record.checksumSha256,
    ...(record.speechTimestamps === undefined ? {} : { speechTimestamps: record.speechTimestamps }),
    ...(record.origin === undefined ? {} : { origin: record.origin }),
  };
}

/**
 * 审计响应。
 *
 * actorId 必须回显调用者：客户端会拿它与签名请求比对，不一致即判为越权。
 */
function auditBody(scope: DeckHarnessContentScope, record: AuditRecord) {
  return {
    ...scopeBody(scope),
    id: record.id,
    jobId: record.jobId,
    actorId: record.actorId,
    executionAttempt: record.executionAttempt,
    requestHash: record.requestHash,
    status: record.status,
    ...(record.stagedResultRef === undefined ? {} : { stagedResultRef: record.stagedResultRef }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** 从服务间 token 里取调用者，供审计回显；替身不验签，只解析。 */
function callerActorId(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new BridgeError('authorization is required', 401);
  }
  const payload = authorization.slice('Bearer '.length).split('.')[1];
  if (payload === undefined) throw new BridgeError('authorization is malformed', 401);
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  const actorId = claims.actor_id ?? claims.sub;
  if (typeof actorId !== 'string') throw new BridgeError('token has no actor', 401);
  return actorId;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError(`${label} must be a nonblank string`, 400);
  }
  return value;
}

function scopeBody(scope: DeckHarnessContentScope) {
  return {
    organizationId: scope.organizationId,
    courseId: scope.courseId,
    courseWorkspaceType: 'draft',
    courseNodeId: scope.courseNodeId,
    moduleId: scope.moduleId,
    moduleVersionId: scope.moduleVersionId,
    moduleTitle: scope.moduleTitle,
  };
}

function workspaceBody(scope: DeckHarnessContentScope, record: WorkspaceRecord) {
  return {
    ...scopeBody(scope),
    draftRevision: record.draftRevision,
    workspace: record.workspace,
    recoveryRevision: record.recoveryRevision,
    recovery: record.recovery,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function withoutDocument(record: MaterializationRecord) {
  return {
    mongodbDocumentId: record.mongodbDocumentId,
    draftRevision: record.draftRevision,
    contentDigest: record.contentDigest,
    materializedAt: record.materializedAt,
  };
}

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('wav')) return '.wav';
  return '.bin';
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.byteLength;
    if (size > DECK_HARNESS_CONTENT_MAX_BODY_BYTES) {
      throw new BridgeError('request body is too large', 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(request)).toString('utf8');
  if (raw.trim().length === 0) return {};
  const value: unknown = JSON.parse(raw);
  return requireRecord(value, 'request body');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BridgeError(`${label} must be an object`, 400);
  return value;
}

/** content-service 的统一响应包络。 */
function writeOk(response: ServerResponse, data: unknown): void {
  writeJson(response, 200, { code: 0, message: 'ok', data });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}
