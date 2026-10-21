import { QUIZ_ANSWER_MAX_DEPTH } from '@reachany/reach-deck-dsl';

import type {
  ReachDeckLearningFenceContext,
  ReachDeckTeacherTrialLearningContext,
  ReachDeckTutorLearningContext,
  TutorLearningContext,
  VideoTutorLearningContext,
} from './contracts.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCENE_TYPES = new Set(['slide', 'quiz', 'interactive']);
const MAX_CONTEXT_BYTES = 32 * 1024;
/**
 * activity.state 根到富文本文档根之间的固定包装层数。最深的一条是填空题作答：
 * state → answers → answers[questionId] → blanks[] → blanks[].answer → .document，
 * 文档内部的 marks / attrs 再占两层，一并算进这个余量。
 */
const ACTIVITY_WRAPPER_DEPTH = 8;
/**
 * 富文本部分的预算与测验层的 QUIZ_ANSWER_MAX_DEPTH 同源，再加上包装层，
 * 保证测验存得下的答案不会在提问时被这里拒掉（issue #544）。
 * 真正约束体量的是 MAX_CONTEXT_BYTES 与 MAX_COLLECTION_ITEMS，深度只用于防止递归失控。
 */
const MAX_STATE_DEPTH = QUIZ_ANSWER_MAX_DEPTH + ACTIVITY_WRAPPER_DEPTH;
const MAX_COLLECTION_ITEMS = 200;
const MAX_STRING_LENGTH = 4_000;

export class TutorLearningContextError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'TutorLearningContextError';
  }
}

const MAX_POSITION_SECONDS = 1_000_000;

export function parseTutorLearningContext(
  value: unknown,
  domainScope: Record<string, string>,
): TutorLearningContext | undefined {
  if (value === undefined) {
    throw invalid('learningContext is required for a Tutor Run');
  }
  const encoded = safeJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTEXT_BYTES) {
    throw invalid(`learningContext exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }

  const context = record(value, 'learningContext');
  // 按字面 schemaVersion 判别分派；未知版本报错文案与既有行为保持一致。
  if (context.schemaVersion === 'reach-deck-tutor-context/v1') {
    return parseReachDeckContext(context, domainScope);
  }
  if (context.schemaVersion === 'reach-deck-teacher-trial-context/v1') {
    return parseTeacherTrialContext(context, domainScope);
  }
  if (context.schemaVersion === 'reach-deck-learning-fence-context/v1') {
    return parseLearningFenceContext(context, domainScope);
  }
  if (context.schemaVersion === 'video-tutor-context/v1') {
    return parseVideoContext(context, domainScope);
  }
  throw invalid('learningContext.schemaVersion is unsupported');
}

function parseLearningFenceContext(
  context: Record<string, unknown>,
  domainScope: Record<string, string>,
): ReachDeckLearningFenceContext {
  exactKeys(context, 'learningContext', [
    'schemaVersion',
    'attemptId',
    'fenceId',
    'pageId',
    'questionId',
    'sceneId',
    'observedAt',
  ]);
  const attemptId = uuid(context.attemptId, 'learningContext.attemptId');
  if (domainScope.attemptId !== attemptId) {
    throw invalid('learningContext attempt does not match the Tutor Thread');
  }
  for (const key of ['selectionId', 'moduleVersionId'] as const) {
    if (domainScope[key] === undefined) {
      throw invalid(`Tutor Thread domainScope.${key} is required`);
    }
  }
  const parsed: ReachDeckLearningFenceContext = {
    schemaVersion: 'reach-deck-learning-fence-context/v1',
    attemptId,
    fenceId: uuid(context.fenceId, 'learningContext.fenceId'),
    pageId: text(context.pageId, 'learningContext.pageId', 200),
    questionId: text(context.questionId, 'learningContext.questionId', 200),
    sceneId: text(context.sceneId, 'learningContext.sceneId', 200),
    observedAt: instant(context.observedAt, 'learningContext.observedAt'),
  };
  requireFenceDomain(domainScope, parsed);
  return parsed;
}

/** reach-deck-tutor-context/v1 校验：与判别分派前的既有行为逐字段一致。 */
function parseReachDeckContext(
  context: Record<string, unknown>,
  domainScope: Record<string, string>,
): ReachDeckTutorLearningContext {
  exactKeys(context, 'learningContext', [
    'schemaVersion',
    'attemptId',
    'pageId',
    'observedAt',
    'activity',
  ]);
  const attemptId = uuid(context.attemptId, 'learningContext.attemptId');
  const pageId = text(context.pageId, 'learningContext.pageId', 200);
  const observedAt = instant(context.observedAt, 'learningContext.observedAt');
  if (domainScope.attemptId !== attemptId) {
    throw invalid('learningContext attempt does not match the Tutor Thread');
  }
  for (const key of ['selectionId', 'moduleVersionId'] as const) {
    if (domainScope[key] === undefined) {
      throw invalid(`Tutor Thread domainScope.${key} is required`);
    }
  }
  requireOrdinaryDomain(domainScope);

  const activity = parseReachDeckActivity(context.activity, pageId);
  return {
    schemaVersion: 'reach-deck-tutor-context/v1',
    attemptId,
    pageId,
    observedAt,
    activity,
  };
}

function parseTeacherTrialContext(
  context: Record<string, unknown>,
  domainScope: Record<string, string>,
): ReachDeckTeacherTrialLearningContext {
  const expectedKeys = [
    'schemaVersion',
    'attemptId',
    'pageId',
    'observedAt',
    'activity',
    ...(context.learningFence === undefined ? [] : ['learningFence']),
  ];
  exactKeys(context, 'learningContext', expectedKeys);
  const attemptId = uuid(context.attemptId, 'learningContext.attemptId');
  const pageId = text(context.pageId, 'learningContext.pageId', 200);
  if (domainScope.attemptId !== attemptId) {
    throw invalid('learningContext attempt does not match the Tutor Thread');
  }
  for (const key of [
    'organizationId',
    'courseId',
    'courseNodeId',
    'moduleId',
    'moduleVersionId',
  ] as const) {
    if (domainScope[key] === undefined) {
      throw invalid(`Tutor Thread domainScope.${key} is required`);
    }
    uuid(domainScope[key], `Tutor Thread domainScope.${key}`);
  }
  const learningFence =
    context.learningFence === undefined
      ? undefined
      : (() => {
          const fence = record(context.learningFence, 'learningContext.learningFence');
          exactKeys(fence, 'learningContext.learningFence', ['questionId', 'sceneId']);
          return {
            questionId: text(fence.questionId, 'learningContext.learningFence.questionId', 200),
            sceneId: text(fence.sceneId, 'learningContext.learningFence.sceneId', 200),
          };
        })();
  if (learningFence === undefined) {
    requireOrdinaryDomain(domainScope);
  } else {
    requireFenceDomain(domainScope, {
      pageId,
      questionId: learningFence.questionId,
      sceneId: learningFence.sceneId,
    });
  }
  return {
    schemaVersion: 'reach-deck-teacher-trial-context/v1',
    attemptId,
    pageId,
    observedAt: instant(context.observedAt, 'learningContext.observedAt'),
    activity: parseReachDeckActivity(context.activity, pageId),
    ...(learningFence ? { learningFence } : {}),
  };
}

function parseReachDeckActivity(
  value: unknown,
  pageId: string,
): ReachDeckTutorLearningContext['activity'] {
  const activity = record(value, 'learningContext.activity');
  exactKeys(activity, 'learningContext.activity', [
    'schemaVersion',
    'pageId',
    'sceneId',
    'sceneType',
    'sourceRevision',
    'state',
  ]);
  if (activity.schemaVersion !== 'reach-deck-player-activity/v1') {
    throw invalid('learningContext.activity.schemaVersion is unsupported');
  }
  const activityPageId = text(activity.pageId, 'learningContext.activity.pageId', 200);
  if (activityPageId !== pageId) {
    throw invalid('learningContext activity page does not match pageId');
  }
  const sceneType = text(activity.sceneType, 'learningContext.activity.sceneType', 20);
  if (!SCENE_TYPES.has(sceneType)) {
    throw invalid('learningContext.activity.sceneType is unsupported');
  }
  if (
    typeof activity.sourceRevision !== 'number' ||
    !Number.isSafeInteger(activity.sourceRevision) ||
    activity.sourceRevision < 1
  ) {
    throw invalid('learningContext.activity.sourceRevision must be a positive integer');
  }

  return {
    schemaVersion: 'reach-deck-player-activity/v1',
    pageId: activityPageId,
    sceneId: text(activity.sceneId, 'learningContext.activity.sceneId', 200),
    sceneType: sceneType as ReachDeckTutorLearningContext['activity']['sceneType'],
    sourceRevision: activity.sourceRevision,
    state: sanitizeJson(activity.state, 0),
  };
}

/**
 * video-tutor-context/v1 校验：exactKeys 白名单 + attemptId 与 domainScope 绑定 +
 * positionSeconds 有界非负；播放位置仅作学习者自报状态，权威时长在服务端再解析时夹取。
 */
function parseVideoContext(
  context: Record<string, unknown>,
  domainScope: Record<string, string>,
): VideoTutorLearningContext {
  exactKeys(context, 'learningContext', [
    'schemaVersion',
    'attemptId',
    'positionSeconds',
    'observedAt',
  ]);
  const attemptId = uuid(context.attemptId, 'learningContext.attemptId');
  const observedAt = instant(context.observedAt, 'learningContext.observedAt');
  if (domainScope.attemptId !== attemptId) {
    throw invalid('learningContext attempt does not match the Tutor Thread');
  }
  for (const key of ['selectionId', 'moduleVersionId'] as const) {
    if (domainScope[key] === undefined) {
      throw invalid(`Tutor Thread domainScope.${key} is required`);
    }
  }
  requireOrdinaryDomain(domainScope, true);
  const positionSeconds = context.positionSeconds;
  if (
    typeof positionSeconds !== 'number' ||
    !Number.isFinite(positionSeconds) ||
    positionSeconds < 0 ||
    positionSeconds > MAX_POSITION_SECONDS
  ) {
    throw invalid(
      `learningContext.positionSeconds must be a finite number between 0 and ${MAX_POSITION_SECONDS}`,
    );
  }
  return {
    schemaVersion: 'video-tutor-context/v1',
    attemptId,
    positionSeconds,
    observedAt,
  };
}

/**
 * Matches persisted Tutor Runs to the Thread's conversation domain. This deliberately accepts
 * discriminator-less ordinary Threads so pre-discriminator history remains available, while
 * excluding learning-fence Runs that were historically written into those Threads.
 */
export function tutorLearningContextMatchesDomainScope(
  value: unknown,
  domainScope: Record<string, string>,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return domainScope.tutorDomain !== 'learning_fence';
  }
  const context = value as Record<string, unknown>;
  const schemaVersion = context.schemaVersion;
  const fenceContext =
    schemaVersion === 'reach-deck-learning-fence-context/v1' ||
    (schemaVersion === 'reach-deck-teacher-trial-context/v1' &&
      typeof context.learningFence === 'object' &&
      context.learningFence !== null &&
      !Array.isArray(context.learningFence));
  if (domainScope.tutorDomain !== 'learning_fence') return !fenceContext;
  if (!fenceContext) return false;

  const fence =
    schemaVersion === 'reach-deck-learning-fence-context/v1'
      ? context
      : (context.learningFence as Record<string, unknown>);
  if (typeof domainScope.fenceId === 'string' && fence.fenceId !== domainScope.fenceId)
    return false;
  for (const key of ['pageId', 'questionId', 'sceneId'] as const) {
    if (typeof domainScope[key] === 'string') {
      const actual = key === 'pageId' ? context.pageId : fence[key];
      if (actual !== domainScope[key]) return false;
    }
  }
  return true;
}

function requireOrdinaryDomain(
  domainScope: Record<string, string>,
  discriminatorOptional = false,
): void {
  if (
    domainScope.tutorDomain === 'ordinary' ||
    (discriminatorOptional && domainScope.tutorDomain === undefined)
  )
    return;
  throw invalid('ordinary learningContext does not match the Tutor Thread domain');
}

function requireFenceDomain(
  domainScope: Record<string, string>,
  context: { fenceId?: string; pageId: string; questionId: string; sceneId: string },
): void {
  if (domainScope.tutorDomain !== 'learning_fence') {
    throw invalid('learning fence context requires a learning-fence Tutor Thread');
  }
  if (context.fenceId !== undefined) {
    if (domainScope.fenceId === undefined) {
      throw invalid('Tutor Thread domainScope.fenceId is required');
    }
    if (domainScope.fenceId !== context.fenceId) {
      throw invalid('learningContext fence does not match the Tutor Thread');
    }
  }
  for (const key of ['pageId', 'questionId', 'sceneId'] as const) {
    if (domainScope[key] === undefined) {
      throw invalid(`Tutor Thread domainScope.${key} is required`);
    }
    if (domainScope[key] !== context[key]) {
      throw invalid(`learningContext ${key} does not match the Tutor Thread`);
    }
  }
}

function sanitizeJson(value: unknown, depth: number): unknown {
  if (depth > MAX_STATE_DEPTH) throw invalid('learningContext activity is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw invalid('learningContext activity contains a non-finite number');
    return value;
  }
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) {
      throw invalid('learningContext activity array is too large');
    }
    // 数组与其元素算同一层：paragraph.content[0] 只比 paragraph 深一层，而不是两层。
    // 数组直接套数组才是真实的层级，必须递增，否则 [[[…]]] 可以无限递归。
    return value.map((item) => sanitizeJson(item, Array.isArray(item) ? depth + 1 : depth));
  }
  if (typeof value !== 'object' || value === undefined) {
    throw invalid('learningContext activity must be JSON-compatible');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_COLLECTION_ITEMS) {
    throw invalid('learningContext activity object is too large');
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw invalid('learningContext activity contains an invalid key');
    }
    output[key] = sanitizeJson(item, depth + 1);
  }
  return output;
}

function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error('not JSON');
    return result;
  } catch {
    throw invalid('learningContext must be JSON-compatible');
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(recordValue: Record<string, unknown>, label: string, expected: string[]): void {
  const actual = Object.keys(recordValue).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw invalid(`${label} contains unsupported fields`);
  }
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw invalid(`${label} must be a non-empty string no longer than ${maxLength} characters`);
  }
  const normalized = value.trim();
  if ([...normalized].some((character) => character < ' ')) {
    throw invalid(`${label} contains control characters`);
  }
  return normalized;
}

function uuid(value: unknown, label: string): string {
  const normalized = text(value, label, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw invalid(`${label} must be a UUID`);
  return normalized;
}

function instant(value: unknown, label: string): string {
  const normalized = text(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw invalid(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function invalid(message: string): TutorLearningContextError {
  return new TutorLearningContextError(message);
}
