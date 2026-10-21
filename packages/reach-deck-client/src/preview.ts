import {
  parseReachDeckDocument,
  type ReachDeckDocument,
  type RichTextDocument,
} from '@reachany/reach-deck-dsl';
export type AttachmentDisposition = 'inline' | 'attachment';
export interface AttachmentUrl {
  url: string;
  disposition: AttachmentDisposition;
  contentType?: string;
}

export function parseMarketplaceReachDeckPreview(value: unknown): MarketplaceReachDeckPreview {
  const data = requireRecord(value, 'marketplace Reach Deck preview');
  return {
    attachmentUrlsByObjectKey: parsePreviewAttachmentUrls(data.attachmentUrlsByObjectKey),
    contentDigest: requireText(data, 'contentDigest'),
    courseId: requireUuid(data, 'courseId'),
    courseNodeId: requireUuid(data, 'courseNodeId'),
    document: parseReachDeckDocument(data.content),
    expiresInSeconds: requirePositiveInteger(data, 'expiresInSeconds'),
    mediaUrlsByResourceId: parseMediaUrlsByResourceId(data.mediaUrlsByResourceId),
    moduleId: requireUuid(data, 'moduleId'),
    moduleVersionId: requireUuid(data, 'moduleVersionId'),
    versionNo: requirePositiveInteger(data, 'versionNo'),
  };
}

export function parseMarketplaceReachDeckPreviewMedia(
  value: unknown,
): MarketplaceReachDeckPreviewMedia {
  const data = requireRecord(value, 'marketplace Reach Deck preview media');
  return {
    attachmentUrlsByObjectKey: parsePreviewAttachmentUrls(data.attachmentUrlsByObjectKey),
    expiresInSeconds: requirePositiveInteger(data, 'expiresInSeconds'),
    mediaUrlsByResourceId: parseMediaUrlsByResourceId(data.mediaUrlsByResourceId),
    moduleVersionId: requireUuid(data, 'moduleVersionId'),
  };
}

export function parseMarketplaceQuizPreview(value: unknown): MarketplaceQuizPreview {
  const preview = parseQuizPreview(value);
  const data = requireRecord(value, 'marketplace Quiz preview');
  requireExactKeys(data, 'marketplace Quiz preview', [
    'moduleVersionId',
    'paper',
    'publishedAt',
    'mediaUrlsByObjectKey',
    'expiresInSeconds',
    'attachmentUrlsByObjectKey',
  ]);
  assertMarketplaceQuizPaper(preview.paper);
  requireUuidValue(preview.moduleVersionId, 'moduleVersionId');
  if (!Number.isFinite(Date.parse(preview.publishedAt))) throw new Error('Invalid publication');
  return {
    ...preview,
    expiresInSeconds: requirePositiveInteger(data, 'expiresInSeconds'),
    mediaUrlsByObjectKey: parseMarketplaceMediaUrls(data.mediaUrlsByObjectKey),
  };
}

export function parseMarketplaceQuizPreviewMedia(value: unknown): MarketplaceQuizPreviewMedia {
  const data = requireRecord(value, 'marketplace Quiz preview media');
  requireExactKeys(data, 'marketplace Quiz preview media', [
    'moduleVersionId',
    'mediaUrlsByObjectKey',
    'expiresInSeconds',
    'attachmentUrlsByObjectKey',
  ]);
  return {
    expiresInSeconds: requirePositiveInteger(data, 'expiresInSeconds'),
    mediaUrlsByObjectKey: parseMarketplaceMediaUrls(data.mediaUrlsByObjectKey),
    moduleVersionId: requireUuid(data, 'moduleVersionId'),
    attachmentUrlsByObjectKey: parsePreviewAttachmentUrls(data.attachmentUrlsByObjectKey),
  };
}

export function parseMarketplaceVideoPreview(value: unknown): VideoReusePreview {
  const data = requireRecord(value, 'marketplace Video preview');
  if (
    typeof data.playbackUrl !== 'string' ||
    !/^https?:\/\//.test(data.playbackUrl) ||
    !Array.isArray(data.subtitleCues)
  ) {
    throw new Error('Invalid marketplace Video preview');
  }
  const subtitleCues: VideoSubtitleCue[] = data.subtitleCues.map((cue) => {
    const entry = requireRecord(cue, 'video subtitle cue');
    if (
      ![entry.index, entry.startMs, entry.endMs].every(
        (n) => typeof n === 'number' && Number.isFinite(n),
      ) ||
      typeof entry.text !== 'string'
    ) {
      throw new Error('Invalid marketplace video subtitle');
    }
    return {
      index: entry.index as number,
      startMs: entry.startMs as number,
      endMs: entry.endMs as number,
      text: entry.text,
    };
  });
  return {
    moduleVersionId: requireUuid(data, 'moduleVersionId'),
    playbackUrl: data.playbackUrl,
    expiresInSeconds: requirePositiveInteger(data, 'expiresInSeconds'),
    subtitleCues,
  };
}

export function parseMarketplaceGroupPreview(value: unknown): GroupCollaborationPreview {
  const preview = parseGroupCollaborationPreview(value);
  if (preview === null) throw new Error('Invalid marketplace Group Collaboration preview');
  requireUuidValue(preview.moduleVersionId, 'moduleVersionId');
  return preview;
}

export function parseQuizPreview(value: unknown): QuizPreview {
  const data = requireRecord(value, 'Quiz preview');
  const moduleVersionId = requireString(data, 'moduleVersionId');
  const paper = requireRecord(data.paper, 'Quiz preview paper');
  const publishedAt = requireString(data, 'publishedAt');
  return {
    moduleVersionId,
    paper,
    publishedAt,
    attachmentUrlsByObjectKey: parsePreviewAttachmentUrls(data.attachmentUrlsByObjectKey),
  };
}

export function parseGroupCollaborationPreview(value: unknown): GroupCollaborationPreview | null {
  try {
    const data = requireRecord(value, 'group collaboration preview');
    if (!isRichTextDocument(data.instructions)) return null;
    const attachmentNames = requireArray(data, 'attachmentNames');
    if (!attachmentNames.every((name) => typeof name === 'string')) return null;
    const attachments = requireArray(data, 'attachments').flatMap((value) => {
      const attachment = parseGroupAttachment(value);
      return attachment ? [attachment] : [];
    });
    const submissionDeadline = requireString(data, 'submissionDeadline');
    const publishedAt = requireString(data, 'publishedAt');
    if (
      !Number.isFinite(Date.parse(submissionDeadline)) ||
      !Number.isFinite(Date.parse(publishedAt))
    )
      return null;
    return {
      // 课程内预览沿用 HEAD 口径只要求非空版本号；课程广场入口 parseMarketplaceGroupPreview 另行要求 UUID。
      moduleVersionId: requireString(data, 'moduleVersionId'),
      instructions: data.instructions,
      attachmentNames,
      attachments,
      mediaUrlsByObjectKey: parseGroupMediaUrls(data.mediaUrlsByObjectKey),
      minParticipants: requirePositiveInteger(data, 'minParticipants'),
      maxParticipants: requirePositiveInteger(data, 'maxParticipants'),
      submissionDeadline,
      publishedAt,
    };
  } catch {
    return null;
  }
}

type GroupAttachment = GroupCollaborationPreview['attachments'][number];

/**
 * 解析单个小组协作附件；单项问题只降级该项，不拒绝整份预览。
 * 结构损坏（缺名称、类型或大小）时丢弃该项；地址不是 http(s) 时只将该地址置空，
 * 界面据此显示“附件不可用”，不会渲染可执行或站内相对地址。
 */
function parseGroupAttachment(value: unknown): GroupAttachment | null {
  try {
    const item = requireRecord(value, 'group attachment');
    const previewDisposition =
      item.previewDisposition === 'inline' || item.previewDisposition === 'attachment'
        ? item.previewDisposition
        : null;
    // 呈现方式缺失或非法时无法安全内联预览，同时丢弃预览地址，界面退回下载方式。
    const previewUrl = previewDisposition === null ? null : httpUrlOrNull(item.previewUrl);
    return {
      assetId: requireString(item, 'assetId'),
      name: requireString(item, 'name'),
      contentType: requireString(item, 'contentType'),
      sizeBytes: requireNonNegativeInteger(item, 'sizeBytes'),
      previewUrl,
      downloadUrl: httpUrlOrNull(item.downloadUrl),
      previewDisposition: previewUrl === null ? null : previewDisposition,
    };
  } catch {
    return null;
  }
}

/** 正文图片签名地址：只保留 http(s) 条目，单张图片地址异常时该图不显示，其余正文照常渲染。 */
function parseGroupMediaUrls(value: unknown): Record<string, string> {
  const data = requireRecord(value, 'group preview media URLs');
  return Object.fromEntries(
    Object.entries(data).flatMap(([key, url]) => {
      const signed = httpUrlOrNull(url);
      return key.trim() && signed !== null ? [[key, signed]] : [];
    }),
  );
}

function httpUrlOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;
}

export interface MarketplaceReachDeckPreview {
  attachmentUrlsByObjectKey: PreviewAttachmentUrls;
  contentDigest: string;
  courseId: string;
  courseNodeId: string;
  document: ReachDeckDocument;
  expiresInSeconds: number;
  mediaUrlsByResourceId: Record<string, string>;
  moduleId: string;
  moduleVersionId: string;
  versionNo: number;
}

export interface MarketplaceReachDeckPreviewMedia {
  attachmentUrlsByObjectKey: PreviewAttachmentUrls;
  expiresInSeconds: number;
  mediaUrlsByResourceId: Record<string, string>;
  moduleVersionId: string;
}

export interface MarketplaceQuizPreviewMedia {
  attachmentUrlsByObjectKey: PreviewAttachmentUrls;
  expiresInSeconds: number;
  mediaUrlsByObjectKey: Record<string, string>;
  moduleVersionId: string;
}

function assertMarketplaceQuizPaper(paper: Record<string, unknown>) {
  allowedPaperKeys(paper, ['schema_version', 'questions', 'settings', 'spaced_review']);
  if (paper.schema_version !== 1 || !Array.isArray(paper.questions))
    throw new Error('Invalid preview paper');
  const settings = requireRecord(paper.settings, 'preview settings');
  allowedPaperKeys(settings, [
    'scoring_enabled',
    'review_required',
    'time_limit_enabled',
    'time_limit_minutes',
  ]);
  assertPreviewScalars(settings);
  paper.questions.forEach(assertMarketplaceQuizQuestion);
  if (paper.spaced_review !== undefined) {
    const schedule = requireRecord(paper.spaced_review, 'preview schedule');
    allowedPaperKeys(schedule, ['version', 'assignments']);
    if (schedule.version !== 1 || !Array.isArray(schedule.assignments))
      throw new Error('Invalid preview schedule');
    schedule.assignments.forEach((entry) => {
      const assignment = requireRecord(entry, 'preview assignment');
      allowedPaperKeys(assignment, ['root_question_id', 'review_days']);
      if (
        typeof assignment.root_question_id !== 'string' ||
        !Array.isArray(assignment.review_days) ||
        !assignment.review_days.every((day) => typeof day === 'number' && Number.isInteger(day))
      ) {
        throw new Error('Invalid preview assignment');
      }
    });
  }
}

function assertMarketplaceQuizQuestion(value: unknown): void {
  const question = requireRecord(value, 'preview question');
  allowedPaperKeys(question, [
    'id',
    'question_index',
    'question_type',
    'points',
    'candidate_pool_repeatable',
    'question',
    'cognitive_schema',
    'question_attachments',
    'options',
    'candidates',
    'blanks',
    'sub_problems',
  ]);
  if (typeof question.id !== 'string' || typeof question.question_type !== 'string')
    throw new Error('Invalid preview question');
  assertPreviewScalars(question, [
    'id',
    'question_index',
    'question_type',
    'points',
    'candidate_pool_repeatable',
  ]);
  assertMarketplaceRichText(question.question);
  if (question.cognitive_schema !== undefined) assertMarketplaceRichText(question.cognitive_schema);
  if (question.question_attachments !== undefined) {
    if (!Array.isArray(question.question_attachments))
      throw new Error('Invalid preview attachments');
    question.question_attachments.forEach((value) => {
      const attachment = requireRecord(value, 'preview attachment');
      allowedPaperKeys(attachment, [
        'assetId',
        'contentType',
        'name',
        'objectKey',
        'order',
        'sizeBytes',
      ]);
      assertPreviewScalars(attachment);
    });
  }
  for (const field of ['options', 'candidates'] as const) {
    if (question[field] === undefined) continue;
    if (!Array.isArray(question[field])) throw new Error('Invalid preview options');
    question[field].forEach((value) => {
      const option = requireRecord(value, 'preview option');
      allowedPaperKeys(option, ['value', 'label']);
      assertPreviewScalars(option, ['value']);
      assertMarketplaceRichText(option.label);
    });
  }
  if (question.blanks !== undefined) {
    if (!Array.isArray(question.blanks)) throw new Error('Invalid preview blanks');
    question.blanks.forEach((value) => {
      const blank = requireRecord(value, 'preview blank');
      allowedPaperKeys(blank, ['id', 'blank_index', 'candidates']);
      assertPreviewScalars(blank, ['id', 'blank_index']);
      if (blank.candidates !== undefined) {
        if (!Array.isArray(blank.candidates)) throw new Error('Invalid preview candidates');
        blank.candidates.forEach((candidate) => {
          const option = requireRecord(candidate, 'preview candidate');
          allowedPaperKeys(option, ['value', 'label']);
          assertPreviewScalars(option, ['value']);
          assertMarketplaceRichText(option.label);
        });
      }
    });
  }
  if (question.sub_problems !== undefined) {
    if (!Array.isArray(question.sub_problems)) throw new Error('Invalid preview sub-problems');
    question.sub_problems.forEach(assertMarketplaceQuizQuestion);
  }
}

function assertMarketplaceRichText(value: unknown): void {
  if (typeof value === 'string') return;
  const node = requireRecord(value, 'preview rich text node');
  allowedPaperKeys(node, ['type', 'text', 'attrs', 'marks', 'content']);
  if (typeof node.type !== 'string') throw new Error('Invalid preview rich text node');
  assertPreviewScalars(node, ['type', 'text']);
  if (node.attrs !== undefined) {
    const attrs = requireRecord(node.attrs, 'preview rich text attributes');
    allowedPaperKeys(attrs, [
      'objectKey',
      'latex',
      'formula',
      'value',
      'blankId',
      'blankIndex',
      'level',
      'start',
      'checked',
      'colspan',
      'rowspan',
      'colwidth',
      'align',
      'textAlign',
      'color',
      'backgroundColor',
      'fontFamily',
      'fontSize',
      'source',
      'language',
      'width',
      'height',
      'alt',
      'title',
    ]);
    assertPreviewScalars(attrs);
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) throw new Error('Invalid preview marks');
    node.marks.forEach((value) => {
      const mark = requireRecord(value, 'preview mark');
      allowedPaperKeys(mark, ['type', 'attrs']);
      assertPreviewScalars(mark, ['type']);
      if (mark.attrs !== undefined) {
        const attrs = requireRecord(mark.attrs, 'preview mark attributes');
        allowedPaperKeys(attrs, [
          'color',
          'backgroundColor',
          'fontFamily',
          'fontSize',
          'href',
          'target',
        ]);
        assertPreviewScalars(attrs);
      }
    });
  }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) throw new Error('Invalid preview rich text content');
    node.content.forEach(assertMarketplaceRichText);
  }
}

function assertPreviewScalars(record: Record<string, unknown>, keys = Object.keys(record)): void {
  for (const key of keys) {
    if (!(key in record)) continue;
    const value = record[key];
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new Error('Invalid marketplace preview scalar');
    }
  }
}

function allowedPaperKeys(value: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    throw new Error('Marketplace preview contains a field outside the learner-safe contract');
  }
}

function parseMediaUrlsByResourceId(value: unknown): Record<string, string> {
  const data = requireRecord(value, 'Reach Deck preview media URLs');
  return Object.fromEntries(
    Object.entries(data).map(([resourceId, url]) => {
      if (!resourceId.trim() || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        throw new Error('Reach Deck preview media URL entry is invalid');
      }
      return [resourceId, url];
    }),
  );
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requirePositiveInteger(record: Record<string, unknown>, field: string): number {
  const value = requireInteger(record, field);
  if (value < 1) throw new Error(`${field} must be positive`);
  return value;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function requireText(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  if (value.trim().length === 0) throw new Error(`${field} must not be blank`);
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  field: string,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Object.keys(record).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${field} must contain exactly the fixed fields`);
  }
}

function requireUuid(record: Record<string, unknown>, field: string): string {
  return requireUuidValue(requireString(record, field), field);
}

function requireUuidValue(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
  return value;
}

export interface MarketplaceQuizPreview extends QuizPreview {
  expiresInSeconds: number;
  mediaUrlsByObjectKey: Record<string, string>;
}

export interface QuizPreview {
  attachmentUrlsByObjectKey: PreviewAttachmentUrls;
  moduleVersionId: string;
  paper: Record<string, unknown>;
  publishedAt: string;
}

function parseMarketplaceMediaUrls(value: unknown): Record<string, string> {
  const data = requireRecord(value, 'marketplace preview media URLs');
  return Object.fromEntries(
    Object.entries(data).map(([key, url]) => {
      if (!key.trim() || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        throw new Error('Invalid marketplace preview media URL');
      }
      return [key, url];
    }),
  );
}

export type GroupCollaborationPreview = {
  moduleVersionId: string;
  instructions: RichTextDocument;
  attachmentNames: string[];
  attachments: {
    assetId: string;
    name: string;
    contentType: string;
    sizeBytes: number;
    previewUrl: string | null;
    downloadUrl: string | null;
    previewDisposition: 'inline' | 'attachment' | null;
  }[];
  mediaUrlsByObjectKey: Record<string, string>;
  minParticipants: number;
  maxParticipants: number;
  submissionDeadline: string;
  publishedAt: string;
};

function isRichTextDocument(value: unknown): value is RichTextDocument {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { content?: unknown; type?: unknown };
  return (
    candidate.type === 'doc' &&
    (candidate.content === undefined || Array.isArray(candidate.content))
  );
}

export type VideoSubtitleCue = { index: number; startMs: number; endMs: number; text: string };

export type VideoReusePreview = {
  moduleVersionId: string;
  playbackUrl: string;
  expiresInSeconds: number;
  subtitleCues: VideoSubtitleCue[];
};

function requireInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return value;
}
export interface PreviewAttachmentUrlPair {
  previewUrl: string | null;
  downloadUrl: string | null;
  previewDisposition: AttachmentDisposition | null;
  contentType: string | null;
}
export type PreviewAttachmentUrls = Record<string, PreviewAttachmentUrlPair>;
export function parsePreviewAttachmentUrls(value: unknown): PreviewAttachmentUrls {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid attachment URLs');
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!entry || typeof entry !== 'object') throw new Error('Invalid attachment URL');
      const item = entry as Record<string, unknown>;
      if (
        (item.downloadUrl !== null &&
          (typeof item.downloadUrl !== 'string' || !/^https?:\/\//.test(item.downloadUrl))) ||
        (item.previewUrl !== null &&
          (typeof item.previewUrl !== 'string' || !/^https?:\/\//.test(item.previewUrl))) ||
        !['inline', 'attachment', null].includes(item.previewDisposition as string | null) ||
        (item.contentType !== null && typeof item.contentType !== 'string')
      )
        throw new Error('Invalid attachment URL');
      return [
        key,
        {
          downloadUrl: item.downloadUrl,
          previewUrl: item.previewUrl,
          previewDisposition: item.previewDisposition,
          contentType: item.contentType,
        } as PreviewAttachmentUrlPair,
      ];
    }),
  );
}
export function previewAttachmentUrl(
  urls: PreviewAttachmentUrlPair | undefined,
  disposition: AttachmentDisposition,
): AttachmentUrl {
  if (!urls?.downloadUrl) throw new Error('Attachment is unavailable');
  const preview = disposition === 'inline' && Boolean(urls.previewUrl);
  const actualDisposition = preview ? urls.previewDisposition : 'attachment';
  if (!actualDisposition) throw new Error('Attachment presentation is unavailable');
  const trustedContentType = urls.contentType ?? undefined;
  return {
    url: preview ? urls.previewUrl! : urls.downloadUrl,
    disposition: actualDisposition,
    contentType:
      actualDisposition === 'inline' && trustedContentType?.startsWith('text/')
        ? 'text/plain; charset=utf-8'
        : trustedContentType,
  };
}
export function createQuizPreviewAttachmentResolver(path: string, moduleVersionId: string) {
  return async (
    attachment: { objectKey: string; contentType?: string },
    disposition: AttachmentDisposition,
  ) => {
    const response = await fetch(`${path}/attachment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ moduleVersionId, objectKey: attachment.objectKey, disposition }),
    });
    const envelope = (await response.json()) as {
      ok?: boolean;
      result?: Record<string, unknown>;
    };
    const result = envelope.result;
    if (
      !response.ok ||
      envelope.ok !== true ||
      result?.moduleVersionId !== moduleVersionId ||
      typeof result.url !== 'string' ||
      !/^https?:\/\//.test(result.url) ||
      !['inline', 'attachment'].includes(result.disposition as string) ||
      (disposition === 'attachment' && result.disposition !== 'attachment') ||
      (result.contentType !== null && typeof result.contentType !== 'string')
    )
      throw new Error('Attachment preview is unavailable');
    const actualDisposition = result.disposition as AttachmentDisposition;
    const contentType = (result.contentType as string | null) ?? undefined;
    return {
      url: result.url,
      disposition: actualDisposition,
      contentType:
        actualDisposition === 'inline' && contentType?.startsWith('text/')
          ? 'text/plain; charset=utf-8'
          : contentType,
    };
  };
}
export function createGroupPreviewReloader(
  path: string | (() => Promise<GroupCollaborationPreview>),
  moduleVersionId: string,
) {
  return async () => {
    const fresh =
      typeof path === 'function'
        ? await path()
        : parseGroupCollaborationPreview(await reloadAttachmentPreview(path, moduleVersionId));
    if (!fresh || fresh.moduleVersionId !== moduleVersionId)
      throw new Error('Invalid group preview');
    return fresh;
  };
}
export async function reloadAttachmentPreview(
  path: string,
  moduleVersionId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(path);
  const envelope = (await response.json()) as { ok?: boolean; result?: Record<string, unknown> };
  if (!response.ok || envelope.ok !== true || envelope.result?.moduleVersionId !== moduleVersionId)
    throw new Error('Attachment preview is unavailable');
  return envelope.result;
}
export const MAX_ATTACHMENT_OBJECT_KEY_LENGTH = 1024;
export function isCanonicalAttachmentObjectKey(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_ATTACHMENT_OBJECT_KEY_LENGTH ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    return false;
  return value
    .split('/')
    .every((segment) => Boolean(segment.trim()) && segment !== '.' && segment !== '..');
}
export function isPreviewAttachmentUnavailable(
  urls: PreviewAttachmentUrls | undefined,
  objectKey: string,
): boolean {
  return urls !== undefined && !urls[objectKey]?.downloadUrl?.trim();
}
export function parseReachDeckPreviewEnvelope(value: unknown): MarketplaceReachDeckPreview | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) return null;
  const result = value.result;
  if (
    typeof result.courseId !== 'string' ||
    typeof result.courseNodeId !== 'string' ||
    typeof result.moduleId !== 'string' ||
    typeof result.moduleVersionId !== 'string' ||
    typeof result.contentDigest !== 'string' ||
    typeof result.versionNo !== 'number' ||
    typeof result.expiresInSeconds !== 'number'
  ) {
    return null;
  }
  const mediaUrlsByResourceId = parseMediaUrls(result.mediaUrlsByResourceId);
  if (mediaUrlsByResourceId === null) return null;
  try {
    return {
      attachmentUrlsByObjectKey: parsePreviewAttachmentUrls(result.attachmentUrlsByObjectKey),
      contentDigest: result.contentDigest,
      courseId: result.courseId,
      courseNodeId: result.courseNodeId,
      document: parseReachDeckDocument(result.document),
      expiresInSeconds: result.expiresInSeconds,
      mediaUrlsByResourceId,
      moduleId: result.moduleId,
      moduleVersionId: result.moduleVersionId,
      versionNo: result.versionNo,
    };
  } catch {
    return null;
  }
}
export function parseReachDeckPreviewMediaEnvelope(
  value: unknown,
): MarketplaceReachDeckPreviewMedia | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) return null;
  const result = value.result;
  const mediaUrlsByResourceId = parseMediaUrls(result.mediaUrlsByResourceId);
  if (
    !(
      typeof result.moduleVersionId === 'string' &&
      Number.isSafeInteger(result.expiresInSeconds) &&
      (result.expiresInSeconds as number) > 0 &&
      mediaUrlsByResourceId !== null
    )
  )
    return null;
  try {
    return {
      attachmentUrlsByObjectKey: parsePreviewAttachmentUrls(result.attachmentUrlsByObjectKey),
      expiresInSeconds: result.expiresInSeconds as number,
      mediaUrlsByResourceId,
      moduleVersionId: result.moduleVersionId,
    };
  } catch {
    return null;
  }
}
function parseMediaUrls(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([id, url]) => id.trim() && typeof url === 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonNegativeInteger(record: Record<string, unknown>, field: string): number {
  const value = requireInteger(record, field);
  if (value < 0) throw new Error('Invalid nonnegative integer');
  return value;
}

function requireArray(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}
function requireLiteral<const T extends string>(
  record: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T {
  const value = requireString(record, field);
  if (!values.includes(value as T)) throw new Error(`${field} has an unsupported value`);
  return value as T;
}

export type PreviewAttachmentType = 'reach-deck' | 'quiz' | 'spaced-review';
export interface PreviewAttachmentRequest {
  moduleVersionId: string;
  objectKey: string;
  disposition: AttachmentDisposition;
}
export interface PreviewAttachmentRouteContext {
  params: Promise<{ courseId: string; courseNodeId: string; moduleType?: string }>;
}
export interface PreviewAttachmentAuthorization {
  sign: (
    courseId: string,
    courseNodeId: string,
    type: PreviewAttachmentType,
    input: PreviewAttachmentRequest,
  ) => Promise<unknown>;
}
/** 两端共用固定版本与附件键校验；应用注入各自角色会话授权与后端客户端。 */
export function createPreviewAttachmentHandler(options: {
  authorize: (request: Request) => Promise<PreviewAttachmentAuthorization | Response>;
  onError: (error: unknown) => Response;
  type?: PreviewAttachmentType;
}) {
  return async (request: Request, context: PreviewAttachmentRouteContext): Promise<Response> => {
    const authorization = await options.authorize(request);
    if (authorization instanceof Response) return authorization;
    let courseId: string, courseNodeId: string, type: PreviewAttachmentType;
    try {
      const params = await context.params;
      courseId = requireUuidValue(decodeURIComponent(params.courseId), 'courseId');
      courseNodeId = requireUuidValue(decodeURIComponent(params.courseNodeId), 'courseNodeId');
      type = requireLiteral(
        { type: options.type ?? decodeURIComponent(params.moduleType ?? '') },
        'type',
        ['reach-deck', 'quiz', 'spaced-review'],
      );
    } catch {
      return Response.json({ error: 'Invalid preview route', ok: false }, { status: 400 });
    }
    let input: PreviewAttachmentRequest;
    try {
      const value = requireRecord(await request.json(), 'attachment request');
      requireExactKeys(value, 'attachment request', [
        'moduleVersionId',
        'objectKey',
        'disposition',
      ]);
      if (!isCanonicalAttachmentObjectKey(value.objectKey))
        throw new Error('Invalid attachment key');
      input = {
        moduleVersionId: requireUuid(value, 'moduleVersionId'),
        objectKey: value.objectKey,
        disposition: requireLiteral(value, 'disposition', ['inline', 'attachment']),
      };
    } catch {
      return Response.json({ error: 'Invalid attachment request', ok: false }, { status: 400 });
    }
    try {
      return Response.json({
        ok: true,
        result: await authorization.sign(courseId, courseNodeId, type, input),
      });
    } catch (error) {
      return options.onError(error);
    }
  };
}
