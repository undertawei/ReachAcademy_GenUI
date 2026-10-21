/**
 * Decksmith 选中图片视觉输入的冻结合同（WP5 第一步，评审 M5）。
 *
 * Run 输入只冻结稳定标识：元素 id、媒体资源 id、objectKey、content-service 返回的权威 checksum、
 * 内容类型与源字节数，以及归一化预设版本；绝不冻结会过期的签名 URL、像素或 base64。
 * 执行时按这些标识重新授权、下载并逐字节核对 checksum，再按同一预设生成缩略图。
 *
 * 本模块不依赖 page-stream-contracts（后者在解析冻结 Run 输入时引用这里的解析器），避免循环依赖。
 */

export const DECKSMITH_VISUAL_INPUTS_SCHEMA_VERSION =
  'reach-deck-decksmith-visual-inputs/v1' as const;

/**
 * 与 `REFERENCE_IMAGE_VISION_PRESET`（≤1024 px JPEG、单张 ≤600 KiB）一一对应；预设任何变化都必须提升此版本，
 * 旧版本冻结的 Run 在执行时以显式说明代替图片，而不是用新预设悄悄换算容量。
 */
export const DECKSMITH_VISION_NORMALIZATION_VERSION = 'decksmith-vision-jpeg-1024-600k/v1' as const;

export const DECKSMITH_VISUAL_INPUT_LIMITS = Object.freeze({
  /** 一轮最多附带的图片张数。 */
  attachedImages: 3,
  /** 冻结记录的条目上限，与上下文引用上限一致（超出张数上限的选中图片以 count-limit 省略说明记录，不静默丢弃）。 */
  entries: 100,
  /** 所有附图归一化后的编码总字节上限（单张上限由预设约束）。 */
  encodedBytesTotal: 1536 * 1024,
});

/**
 * 每张附图在确定性容量估算中占用的单位数（`model-token-upper-bound`）。
 *
 * 预设把解码尺寸限制在 1024×1024 以内。按各供应方公开的图片计量：OpenAI 分块计量约 765、
 * 按 32 px 补丁计量的小模型最多约 1024 补丁 × 2.46 ≈ 2.5k，Claude 约 1.4k，Gemini 高分辨率约 1.1k，
 * Qwen-VL 约 1.4k，均低于 4096；唯一例外是把图片 token 按计费倍率放大上报的旧模型（如 gpt-4o-mini），
 * 此类模型不得配置到 Decksmith 视觉槽位。pi 每轮都会重发首条用户消息，因此每次派发的 payload
 * 都按附图张数各计一次，与冻结测算一致。估算时每个 image_url 的 url 被替换为同等字节长度的占位串，
 * 因此冻结测算、恢复测算、pi 序列化后的派发前实测三条路径得到完全相同的数值。
 */
export const DECKSMITH_VISION_IMAGE_CAPACITY_UNITS = 4096;

export type DecksmithVisualInputOmissionReason =
  /** 超过本轮附图张数上限。 */
  | 'count-limit'
  /** 元素没有绑定可用的媒体资源。 */
  | 'no-media-resource'
  /** 授权返回的内容类型不是可附带的位图（png/jpeg/webp/gif）。 */
  | 'unsupported-media-type'
  /** content-service 拒绝授权或资源未就绪。 */
  | 'not-authorized'
  /** 授权服务暂不可用。 */
  | 'reference-unavailable'
  /** 冻结后元素已删除或改绑了其他图片。 */
  | 'picture-changed'
  /** 授权返回的或下载字节的 checksum 与冻结值不一致。 */
  | 'checksum-mismatch'
  /** 下载、解码或归一化失败。 */
  | 'load-failed'
  /** 归一化后超过本轮编码总字节上限。 */
  | 'byte-budget'
  /** 冻结时的归一化预设版本已不受支持。 */
  | 'unsupported-normalization';

const OMISSION_REASONS: ReadonlySet<string> = new Set<DecksmithVisualInputOmissionReason>([
  'count-limit',
  'no-media-resource',
  'unsupported-media-type',
  'not-authorized',
  'reference-unavailable',
  'picture-changed',
  'checksum-mismatch',
  'load-failed',
  'byte-budget',
  'unsupported-normalization',
]);

/** 冻结时可以出现的省略原因（执行期原因只出现在模型提示中，不落库）。 */
const FROZEN_OMISSION_REASONS: ReadonlySet<string> = new Set<DecksmithVisualInputOmissionReason>([
  'count-limit',
  'no-media-resource',
  'unsupported-media-type',
  'not-authorized',
  'reference-unavailable',
]);

export interface DecksmithFrozenVisualImage {
  readonly elementId: string;
  readonly status: 'attached';
  readonly resourceId: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

export interface DecksmithFrozenVisualOmission {
  readonly elementId: string;
  readonly status: 'omitted';
  readonly reason: DecksmithVisualInputOmissionReason;
}

export type DecksmithFrozenVisualEntry = DecksmithFrozenVisualImage | DecksmithFrozenVisualOmission;

export interface DecksmithFrozenVisualInputs {
  readonly schemaVersion: typeof DECKSMITH_VISUAL_INPUTS_SCHEMA_VERSION;
  readonly normalization: string;
  readonly pageId: string;
  readonly pageRevision: number;
  readonly images: readonly DecksmithFrozenVisualEntry[];
}

export function isDecksmithVisualInputOmissionReason(
  value: unknown,
): value is DecksmithVisualInputOmissionReason {
  return typeof value === 'string' && OMISSION_REASONS.has(value);
}

/** 严格解析冻结的视觉输入；任何多余字段、URL 或像素数据都被拒绝。 */
export function parseDecksmithFrozenVisualInputs(value: unknown): DecksmithFrozenVisualInputs {
  const input = exact(
    value,
    ['schemaVersion', 'normalization', 'pageId', 'pageRevision', 'images'],
    'Decksmith visual inputs',
  );
  if (input.schemaVersion !== DECKSMITH_VISUAL_INPUTS_SCHEMA_VERSION) {
    throw new Error('Decksmith visual inputs schema is invalid');
  }
  const images = input.images;
  if (
    !Array.isArray(images) ||
    images.length === 0 ||
    images.length > DECKSMITH_VISUAL_INPUT_LIMITS.entries
  ) {
    throw new Error('Decksmith visual input entries are invalid');
  }
  const parsedImages = images.map(parseEntry);
  if (new Set(parsedImages.map((entry) => entry.elementId)).size !== parsedImages.length) {
    throw new Error('Decksmith visual input entries contain duplicates');
  }
  if (
    parsedImages.filter((entry) => entry.status === 'attached').length >
    DECKSMITH_VISUAL_INPUT_LIMITS.attachedImages
  ) {
    throw new Error('Decksmith visual inputs exceed the attached image limit');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_VISUAL_INPUTS_SCHEMA_VERSION,
    normalization: identifier(input.normalization, 'normalization'),
    pageId: identifier(input.pageId, 'pageId'),
    pageRevision: positiveInteger(input.pageRevision, 'pageRevision'),
    images: Object.freeze(parsedImages),
  });
}

function parseEntry(value: unknown): DecksmithFrozenVisualEntry {
  const record = isObject(value) ? value : {};
  if (record.status === 'omitted') {
    const entry = exact(value, ['elementId', 'status', 'reason'], 'Decksmith visual omission');
    if (typeof entry.reason !== 'string' || !FROZEN_OMISSION_REASONS.has(entry.reason)) {
      throw new Error('Decksmith visual omission reason is invalid');
    }
    return Object.freeze({
      elementId: identifier(entry.elementId, 'elementId'),
      status: 'omitted',
      reason: entry.reason as DecksmithVisualInputOmissionReason,
    });
  }
  const entry = exact(
    value,
    [
      'elementId',
      'status',
      'resourceId',
      'objectKey',
      'contentType',
      'sizeBytes',
      'checksumSha256',
    ],
    'Decksmith visual image',
  );
  if (entry.status !== 'attached') throw new Error('Decksmith visual image status is invalid');
  if (typeof entry.checksumSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.checksumSha256)) {
    throw new Error('Decksmith visual image checksum is invalid');
  }
  const objectKey = identifier(entry.objectKey, 'objectKey', 1024);
  // objectKey 是存储内的稳定键，不是可下载地址；拒绝任何 URL / data URI 形态。
  if (/^[a-z][a-z0-9+.-]*:/i.test(objectKey)) {
    throw new Error('Decksmith visual image objectKey must not be a URL');
  }
  return Object.freeze({
    elementId: identifier(entry.elementId, 'elementId'),
    status: 'attached',
    resourceId: identifier(entry.resourceId, 'resourceId'),
    objectKey,
    contentType: identifier(entry.contentType, 'contentType'),
    sizeBytes: positiveInteger(entry.sizeBytes, 'sizeBytes'),
    checksumSha256: entry.checksumSha256,
  });
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  if (
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, label: string, limit = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new Error(`Decksmith visual input ${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Decksmith visual input ${label} is invalid`);
  }
  return value;
}
