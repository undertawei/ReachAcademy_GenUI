import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import {
  AuthorizedImageError,
  REFERENCE_IMAGE_VISION_PRESET,
  type AuthorizedImageSource,
  type NormalizedReferenceImage,
  type ReferenceImagePreset,
} from '../authorized-image.js';
import { ContentServiceClientError } from '../content-service-client.js';
import { parseDecksmithContextRef, type DecksmithContextRef } from './page-stream-contracts.js';
import {
  DECKSMITH_VISION_IMAGE_CAPACITY_UNITS,
  DECKSMITH_VISION_NORMALIZATION_VERSION,
  DECKSMITH_VISUAL_INPUTS_SCHEMA_VERSION,
  DECKSMITH_VISUAL_INPUT_LIMITS,
  parseDecksmithFrozenVisualInputs,
  type DecksmithFrozenVisualEntry,
  type DecksmithFrozenVisualImage,
  type DecksmithFrozenVisualInputs,
  type DecksmithVisualInputOmissionReason,
} from './visual-input-contract.js';

/**
 * Decksmith 选中图片视觉输入（WP5 第一步）：冻结前授权、执行时取图、提示词与容量投影。
 *
 * 三条容量路径（冻结测算、恢复后测算、pi 序列化后的派发前实测）共用
 * {@link projectDecksmithVisionContentForCapacity}：每个 image_url 的 url 都被替换为固定长度占位串，
 * 因此附图在三条路径上计入完全相同的单位数，且 base64 永远不进入容量摘要、历史或压缩输入。
 */

const SUPPORTED_VISION_SOURCE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const VISION_DATA_URL_PREFIX = 'data:image/jpeg;base64,';
/** 单张附图在派发 payload 中允许的 data URL 最大长度（base64 膨胀 4/3 + 前缀）。 */
const MAX_VISION_DATA_URL_CHARACTERS =
  VISION_DATA_URL_PREFIX.length + Math.ceil(REFERENCE_IMAGE_VISION_PRESET.maxBytes / 3) * 4;

/** 固定长度的容量占位串：序列化后恰好占 DECKSMITH_VISION_IMAGE_CAPACITY_UNITS + 2（引号）字节。 */
export const DECKSMITH_VISION_IMAGE_CAPACITY_PLACEHOLDER = (() => {
  const prefix = `decksmith-vision-image:${DECKSMITH_VISION_NORMALIZATION_VERSION}:`;
  return prefix + '#'.repeat(DECKSMITH_VISION_IMAGE_CAPACITY_UNITS - prefix.length);
})();

/** content-service 图片授权返回的最小元数据（下载地址只在执行期短暂使用，绝不冻结）。 */
export interface DecksmithVisionImageReference extends AuthorizedImageSource {
  readonly objectKey: string;
}

/**
 * 单次授权调用。`signal` 携带本次调用的截止时间（以及执行期的取消信号），调用方应把它传给 content-service 请求。
 */
export type DecksmithVisionReferenceResolver = (
  input: {
    readonly objectKey: string;
    readonly expectedChecksumSha256?: string;
  },
  signal: AbortSignal,
) => Promise<DecksmithVisionImageReference>;

/**
 * 单张图片授权调用的截止时间。content-service 客户端本身没有超时，挂起的授权不能拖住
 * API 路由（冻结前）或模型调用（执行期）；超时按 reference-unavailable 显式说明处理。
 */
export const DECKSMITH_VISION_AUTHORIZATION_TIMEOUT_MS = 10_000;

export type DecksmithVisionImageLoader = (
  source: DecksmithVisionImageReference,
  preset: ReferenceImagePreset,
  options: { signal?: AbortSignal },
) => Promise<NormalizedReferenceImage>;

/** 一个选中图片条目在本轮模型输入中的最终状态。 */
export type DecksmithVisualEntryState =
  | {
      readonly elementId: string;
      readonly state: 'attached';
      /** 仅执行期存在；测算路径不取图，以固定占位代替。 */
      readonly image?: { readonly base64: string; readonly mimeType: 'image/jpeg' };
    }
  | {
      readonly elementId: string;
      readonly state: 'omitted';
      readonly reason: DecksmithVisualInputOmissionReason;
    };

/**
 * 冻结前授权教师选中的来源页图片（API 路由在测算容量前调用，不持有写锁）。
 *
 * 数据源：请求中的上下文引用（native-element / componentType=image / 来源页）、请求文档
 * （nativeSlides 的 image 元素与 resources.media），content-service
 * `POST .../decksmith/image-references`（按物化文档引用授权并返回权威 checksum / contentType / size）。
 * 核心逻辑：
 * 1. 引用无法解析时返回 undefined，交由后续的上下文校验给出准确的过期错误；
 * 2. 按引用顺序收集来源页上被选中的 image 元素（去重），没有则返回 undefined；
 * 3. 前 3 张有媒体资源的图片按批并发授权（单次带截止时间，失败由后续图片补位），冻结
 *    resourceId / objectKey / 权威 checksum / 类型 / 字节数；
 * 4. 超出张数、无资源、类型不支持、授权被拒或授权服务不可用的条目以显式省略原因记录，绝不静默丢弃；
 * 5. 签名下载地址只用于本次授权校验，不写入返回值。
 */
export async function authorizeDecksmithVisualInputs(input: {
  readonly document: ReachDeckDocumentV2;
  readonly pageId: string;
  readonly contextRefs: readonly unknown[];
  readonly resolve: DecksmithVisionReferenceResolver;
  /** 仅供测试缩短单次授权截止时间。 */
  readonly authorizationTimeoutMs?: number;
}): Promise<DecksmithFrozenVisualInputs | undefined> {
  let refs: DecksmithContextRef[];
  try {
    refs = input.contextRefs.map((value) => parseDecksmithContextRef(value));
  } catch {
    return undefined;
  }
  const page = input.document.pages.find((candidate) => candidate.pageId === input.pageId);
  if (page === undefined || page.sceneType !== 'slide') return undefined;
  const elementIds = selectedOriginImageIds(refs, input.pageId);
  if (elementIds.length === 0) return undefined;
  const bound = elementIds.slice(0, DECKSMITH_VISUAL_INPUT_LIMITS.entries).map((elementId) => ({
    elementId,
    binding: imageBinding(input.document, input.pageId, elementId),
  }));
  const decided = new Map<string, DecksmithFrozenVisualEntry>();
  const pending = bound.flatMap((entry) => (entry.binding === undefined ? [] : [entry]));
  let attached = 0;
  // 按选择顺序分批并发授权：每批只取剩余空位数量的候选，结果与逐张串行完全一致
  // （某张失败时由下一张补位），但路由延迟只取决于批数而非张数。
  while (pending.length > 0 && attached < DECKSMITH_VISUAL_INPUT_LIMITS.attachedImages) {
    const wave = pending.splice(0, DECKSMITH_VISUAL_INPUT_LIMITS.attachedImages - attached);
    const results = await Promise.all(
      wave.map(async ({ elementId, binding }) => {
        try {
          const reference = await withAuthorizationDeadline(
            (signal) => input.resolve({ objectKey: binding!.objectKey }, signal),
            input.authorizationTimeoutMs,
          );
          return frozenEntry(elementId, binding!, reference);
        } catch (error) {
          return omitted(elementId, authorizationFailureReason(error));
        }
      }),
    );
    for (const entry of results) {
      decided.set(entry.elementId, entry);
      if (entry.status === 'attached') attached += 1;
    }
  }
  const images = bound.map(
    ({ elementId, binding }) =>
      decided.get(elementId) ??
      omitted(elementId, binding === undefined ? 'no-media-resource' : 'count-limit'),
  );
  return parseDecksmithFrozenVisualInputs({
    schemaVersion: DECKSMITH_VISUAL_INPUTS_SCHEMA_VERSION,
    normalization: DECKSMITH_VISION_NORMALIZATION_VERSION,
    pageId: input.pageId,
    pageRevision: page.revision,
    images,
  });
}

function frozenEntry(
  elementId: string,
  binding: { resourceId: string; objectKey: string },
  reference: DecksmithVisionImageReference,
): DecksmithFrozenVisualEntry {
  if (
    reference.objectKey !== binding.objectKey ||
    !/^[a-f0-9]{64}$/.test(reference.checksumSha256) ||
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes < 1
  ) {
    return omitted(elementId, 'reference-unavailable');
  }
  if (!SUPPORTED_VISION_SOURCE_TYPES.has(reference.contentType)) {
    return omitted(elementId, 'unsupported-media-type');
  }
  return {
    elementId,
    status: 'attached',
    resourceId: binding.resourceId,
    objectKey: binding.objectKey,
    contentType: reference.contentType,
    sizeBytes: reference.sizeBytes,
    checksumSha256: reference.checksumSha256,
  };
}

/**
 * 给单次授权加截止时间：把合并后的信号交给解析器，同时与截止/取消竞速，
 * 即便解析器忽略信号也不会无限挂起。外部取消原样上抛，截止则抛出超时错误（由调用方转为说明）。
 */
async function withAuthorizationDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DECKSMITH_VISION_AUTHORIZATION_TIMEOUT_MS,
  outer?: AbortSignal,
): Promise<T> {
  outer?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('Decksmith image authorization timed out')),
    timeoutMs,
  );
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * 冻结时校验：视觉输入必须与权威文档中的元素绑定一致（路由与冻结之间文档不会变，变了即过期）。
 *
 * 数据源：冻结的视觉输入、请求文档。核心逻辑：每个 attached 条目的元素仍是 image，且绑定同一个
 * resourceId 与 objectKey；页修订与基线一致。返回 false 时调用方按组件过期拒绝本轮。
 */
export function decksmithVisualInputsMatchDocument(
  visualInputs: DecksmithFrozenVisualInputs,
  document: ReachDeckDocumentV2,
  pageId: string,
): boolean {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined || visualInputs.pageId !== pageId) return false;
  if (visualInputs.pageRevision !== page.revision) return false;
  return visualInputs.images.every(
    (entry) => entry.status !== 'attached' || bindingMatches(entry, document, pageId),
  );
}

/**
 * 不做 I/O 的计划状态：测算路径与执行路径都从这里出发，保证同一文档得出同一组附图。
 * 预设版本不再受支持或元素已改绑时，该条目以显式省略原因代替图片。
 */
export function planDecksmithVisualEntries(
  visualInputs: DecksmithFrozenVisualInputs,
  document: ReachDeckDocumentV2,
): DecksmithVisualEntryState[] {
  return visualInputs.images.map((entry) => {
    if (entry.status === 'omitted') {
      return { elementId: entry.elementId, state: 'omitted', reason: entry.reason };
    }
    if (visualInputs.normalization !== DECKSMITH_VISION_NORMALIZATION_VERSION) {
      return { elementId: entry.elementId, state: 'omitted', reason: 'unsupported-normalization' };
    }
    if (!bindingMatches(entry, document, visualInputs.pageId)) {
      return { elementId: entry.elementId, state: 'omitted', reason: 'picture-changed' };
    }
    return { elementId: entry.elementId, state: 'attached' };
  });
}

/**
 * 执行期取图：按冻结标识重新授权、下载、核对 checksum 并归一为 ≤1024 px JPEG。
 *
 * 数据源：冻结的视觉输入、执行期权威文档；content-service 图片授权（带期望 checksum，变化时 409）；
 * 授权返回的短时签名地址（只在本函数内使用）。
 * 核心逻辑：
 * 1. 从 {@link planDecksmithVisualEntries} 的计划状态出发，已省略的条目原样保留；
 * 2. 逐张授权（单次带截止时间）：409 或回显 checksum 与冻结值不一致 → checksum-mismatch；
 *    其余 4xx → not-authorized；超时与其他失败 → reference-unavailable；
 * 3. 下载与归一：网络抖动/超时时重新授权再试一次；字节校验失败 → checksum-mismatch，其余 → load-failed；
 * 4. 归一化后累计编码字节超过本轮总上限 → byte-budget；
 * 5. 取消信号直接上抛，不降级为说明。
 * 选择"显式说明"而非"整轮过期失败"：图片内容变化不影响本轮文本上下文的有效性，模型被明确告知
 * 看不到该图，不会出现静默丢图。
 */
export async function loadDecksmithVisualInputs(input: {
  readonly visualInputs: DecksmithFrozenVisualInputs;
  readonly document: ReachDeckDocumentV2;
  readonly resolve: DecksmithVisionReferenceResolver;
  readonly load: DecksmithVisionImageLoader;
  readonly signal?: AbortSignal;
  /** 仅供测试缩短单次授权截止时间。 */
  readonly authorizationTimeoutMs?: number;
}): Promise<DecksmithVisualEntryState[]> {
  const planned = planDecksmithVisualEntries(input.visualInputs, input.document);
  const frozen = new Map(
    input.visualInputs.images.flatMap((entry) =>
      entry.status === 'attached' ? [[entry.elementId, entry] as const] : [],
    ),
  );
  const result: DecksmithVisualEntryState[] = [];
  let encodedBytes = 0;
  for (const entry of planned) {
    if (entry.state === 'omitted') {
      result.push(entry);
      continue;
    }
    const source = frozen.get(entry.elementId)!;
    const loaded = await loadOne(source, input);
    input.signal?.throwIfAborted();
    if ('reason' in loaded) {
      result.push(omitted(entry.elementId, loaded.reason, true));
      continue;
    }
    if (
      loaded.contentType !== 'image/jpeg' ||
      encodedBytes + loaded.bytes.byteLength > DECKSMITH_VISUAL_INPUT_LIMITS.encodedBytesTotal
    ) {
      result.push(omitted(entry.elementId, 'byte-budget', true));
      continue;
    }
    encodedBytes += loaded.bytes.byteLength;
    result.push({
      elementId: entry.elementId,
      state: 'attached',
      image: { base64: loaded.bytes.toString('base64'), mimeType: 'image/jpeg' },
    });
  }
  return result;
}

async function loadOne(
  source: DecksmithFrozenVisualImage,
  input: Parameters<typeof loadDecksmithVisualInputs>[0],
): Promise<NormalizedReferenceImage | { reason: DecksmithVisualInputOmissionReason }> {
  const attempt = async () => {
    let reference: DecksmithVisionImageReference;
    try {
      reference = await withAuthorizationDeadline(
        (signal) =>
          input.resolve(
            { objectKey: source.objectKey, expectedChecksumSha256: source.checksumSha256 },
            signal,
          ),
        input.authorizationTimeoutMs,
        input.signal,
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (error instanceof ContentServiceClientError && error.status === 409) {
        return { reason: 'checksum-mismatch' as const };
      }
      return { reason: authorizationFailureReason(error) };
    }
    if (
      reference.objectKey !== source.objectKey ||
      reference.checksumSha256 !== source.checksumSha256
    ) {
      return { reason: 'checksum-mismatch' as const };
    }
    return input.load(reference, REFERENCE_IMAGE_VISION_PRESET, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  };
  try {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof AuthorizedImageError) || !error.retryable || input.signal?.aborted) {
        throw error;
      }
      return await attempt();
    }
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    if (error instanceof AuthorizedImageError && error.failure === 'integrity') {
      return { reason: 'checksum-mismatch' };
    }
    if (error instanceof AuthorizedImageError) return { reason: 'load-failed' };
    throw error;
  }
}

/**
 * 写进首条用户消息的选中图片说明：每张图一行（元素 id、alt、位置变换、是否附图及原因）。
 * 测算与执行用同一函数；附图顺序与随后的图片块顺序一致。
 */
export function decksmithVisualInputLines(
  visualInputs: DecksmithFrozenVisualInputs,
  entries: readonly DecksmithVisualEntryState[],
  document: ReachDeckDocumentV2,
): string[] {
  const lines = [
    `Selected pictures on page ${visualInputs.pageId} (page revision ${visualInputs.pageRevision}). ` +
      'The thumbnails (longest side at most 1024 px, JPEG) of the pictures marked attached follow this message text in the listed order; look at them before describing or editing those pictures.',
  ];
  let ordinal = 0;
  for (const entry of entries) {
    const element = findImageElement(document, visualInputs.pageId, entry.elementId);
    const facts =
      element === undefined
        ? 'no longer on the page'
        : `alt ${JSON.stringify(element.alt ?? '')}, transform ${JSON.stringify(element.transform ?? null)}`;
    if (entry.state === 'attached') {
      ordinal += 1;
      lines.push(`- Attached picture ${ordinal}: element ${entry.elementId}, ${facts}.`);
    } else {
      lines.push(
        `- Element ${entry.elementId} (${facts}) is NOT attached (${entry.reason}); you cannot see its pixels, so rely on its alt text and position and say so if it matters.`,
      );
    }
  }
  return lines;
}

/**
 * 容量投影：把 OpenAI chat 消息中每个 image_url 的 url 换成固定占位串，并在派发前强制附图合同。
 * 违反张数、data URL 格式或单张/总编码上限时返回 null，由调用方按容量阻断处理。
 */
export function projectDecksmithVisionContentForCapacity(
  messages: readonly unknown[],
): unknown[] | null {
  let images = 0;
  let encodedCharacters = 0;
  const projected: unknown[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      projected.push(message);
      continue;
    }
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content)) {
      projected.push(message);
      continue;
    }
    const content: unknown[] = [];
    for (const part of record.content) {
      if (
        typeof part !== 'object' ||
        part === null ||
        (part as Record<string, unknown>).type !== 'image_url'
      ) {
        content.push(part);
        continue;
      }
      const imageUrl = (part as Record<string, unknown>).image_url;
      const url =
        typeof imageUrl === 'object' && imageUrl !== null
          ? (imageUrl as Record<string, unknown>).url
          : undefined;
      if (typeof url !== 'string') return null;
      if (url !== DECKSMITH_VISION_IMAGE_CAPACITY_PLACEHOLDER) {
        if (
          !url.startsWith(VISION_DATA_URL_PREFIX) ||
          url.length > MAX_VISION_DATA_URL_CHARACTERS
        ) {
          return null;
        }
        encodedCharacters += url.length - VISION_DATA_URL_PREFIX.length;
      }
      images += 1;
      content.push({ ...part, image_url: { url: DECKSMITH_VISION_IMAGE_CAPACITY_PLACEHOLDER } });
    }
    projected.push({ ...record, content });
  }
  // pi 每轮重发首条用户消息，单个 payload 内的附图数与编码量仍受同一上限约束。
  if (
    images > DECKSMITH_VISUAL_INPUT_LIMITS.attachedImages ||
    (encodedCharacters / 4) * 3 > DECKSMITH_VISUAL_INPUT_LIMITS.encodedBytesTotal
  ) {
    return null;
  }
  return projected;
}

function selectedOriginImageIds(refs: readonly DecksmithContextRef[], pageId: string): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    if (
      ref.kind === 'native-element' &&
      ref.pageId === pageId &&
      ref.componentType === 'image' &&
      !ids.includes(ref.componentId)
    ) {
      ids.push(ref.componentId);
    }
  }
  return ids;
}

function imageBinding(
  document: ReachDeckDocumentV2,
  pageId: string,
  elementId: string,
): { resourceId: string; objectKey: string } | undefined {
  const element = findImageElement(document, pageId, elementId);
  if (element === undefined || typeof element.resourceId !== 'string') return undefined;
  const resource = document.resources.media.find(
    (candidate) => candidate.id === element.resourceId,
  );
  if (resource === undefined || typeof resource.objectKey !== 'string') return undefined;
  return { resourceId: resource.id, objectKey: resource.objectKey };
}

function bindingMatches(
  entry: DecksmithFrozenVisualImage,
  document: ReachDeckDocumentV2,
  pageId: string,
): boolean {
  const binding = imageBinding(document, pageId, entry.elementId);
  return (
    binding !== undefined &&
    binding.resourceId === entry.resourceId &&
    binding.objectKey === entry.objectKey
  );
}

interface ImageElementFacts {
  readonly resourceId?: unknown;
  readonly alt?: unknown;
  readonly transform?: unknown;
}

function findImageElement(
  document: ReachDeckDocumentV2,
  pageId: string,
  elementId: string,
): ImageElementFacts | undefined {
  const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
  if (slide === undefined) return undefined;
  const stack: unknown[] = [...slide.elements];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (record.id === elementId) {
      return record.type === 'image' ? (record as ImageElementFacts) : undefined;
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) stack.push(...value);
    }
  }
  return undefined;
}

function authorizationFailureReason(error: unknown): DecksmithVisualInputOmissionReason {
  if (
    error instanceof ContentServiceClientError &&
    error.status >= 400 &&
    error.status < 500 &&
    !error.retryable
  ) {
    return 'not-authorized';
  }
  return 'reference-unavailable';
}

function omitted(
  elementId: string,
  reason: DecksmithVisualInputOmissionReason,
): DecksmithFrozenVisualEntry;
function omitted(
  elementId: string,
  reason: DecksmithVisualInputOmissionReason,
  runtime: true,
): DecksmithVisualEntryState;
function omitted(
  elementId: string,
  reason: DecksmithVisualInputOmissionReason,
  runtime?: true,
): DecksmithFrozenVisualEntry | DecksmithVisualEntryState {
  return runtime === true
    ? { elementId, state: 'omitted', reason }
    : { elementId, status: 'omitted', reason };
}
