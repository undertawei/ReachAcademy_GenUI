import { createHash } from 'node:crypto';

import {
  parseReachDeckDocument,
  reachDeckInteractiveNarrationContentDigestInput,
  reachDeckNarrationSpeechContentDigestInput,
  stripVolatileReachDeckMediaUrls,
  stripReachDeckNativeSlideNarration,
  stripSlideNarration,
  type DeckSlide,
  type InteractiveScene,
  type ReachDeckNativeSlideV2,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';

import type {
  ReachDeckDecksmithJobInput,
  ReachDeckDecksmithJobResultContent,
  ReachDeckGenerationRequest,
  ReachDeckStagedGenerationJobKind,
} from './contracts.js';
import { actorOrganizationIdFromPayload } from './contracts.js';
import { parseReachDeckResourceScope, type ReachDeckResourceScope } from './resource-scope.js';
import {
  DEFAULT_REACH_DECK_VOICE_SELECTION,
  parseReachDeckVoiceSelection,
  type ReachDeckVoiceSelection,
} from './voice-selection.js';

export function buildIdempotentGenerationRunId(input: {
  idempotencyKey: string;
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  resourceScope: ReachDeckResourceScope;
  request: ReachDeckGenerationRequest;
}): string {
  const resourceScope = parseReachDeckResourceScope(input.resourceScope);
  const identity = stableSerialize({
    actorId: input.actorId,
    billingGroupId: billingIdentityValue(input.billingGroupId),
    idempotencyKey: input.idempotencyKey,
    resourceScope,
    request: input.request,
  });
  return 'run-' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

export function buildIdempotentWorkspaceRunId(input: {
  idempotencyKey: string;
  actorId: string;
  billingGroupId: string | null;
  resourceScope: ReachDeckResourceScope;
  source: string;
}): string {
  const resourceScope = parseReachDeckResourceScope(input.resourceScope);
  for (const [label, value] of [
    ['idempotencyKey', input.idempotencyKey],
    ['actorId', input.actorId],
    ['source', input.source],
  ] as const) {
    if (value.trim().length === 0) throw new Error(`${label} must be nonblank`);
  }
  return (
    'run-' +
    createHash('sha256')
      .update(
        stableSerialize({
          actorId: input.actorId,
          billingGroupId: billingIdentityValue(input.billingGroupId),
          idempotencyKey: input.idempotencyKey,
          resourceScope,
          source: input.source,
        }),
      )
      .digest('hex')
      .slice(0, 24)
  );
}

export function buildIdempotentPageRequestKey(input: {
  idempotencyKey: string;
  actorId: string;
  billingGroupId: string | null;
  resourceScope: ReachDeckResourceScope;
  runId: string;
  pageId: string;
  prompt?: string;
  voiceSelection?: ReachDeckVoiceSelection;
  /**
   * regenerate=整页重生成；narration-regenerate=只重跑讲稿；narration-regenerate-text=只重写
   * 讲稿文字（不合成音频、不生成讲稿动画）。各动作派生不同 requestKey。
   */
  action:
    | 'regenerate'
    | 'narration-regenerate'
    | 'narration-regenerate-text'
    | 'narration-generate-saved';
}): string {
  const resourceScope = parseReachDeckResourceScope(input.resourceScope);
  for (const [label, value] of [
    ['idempotencyKey', input.idempotencyKey],
    ['actorId', input.actorId],
    ['runId', input.runId],
    ['pageId', input.pageId],
    ['action', input.action],
  ] as const) {
    if (value.trim().length === 0) throw new Error(`${label} must be nonblank`);
  }
  if (input.prompt !== undefined && input.prompt.trim().length === 0) {
    throw new Error('prompt must be nonblank when supplied');
  }
  return (
    'request-' +
    createHash('sha256')
      .update(
        stableSerialize({
          action: input.action,
          actorId: input.actorId,
          billingGroupId: billingIdentityValue(input.billingGroupId),
          idempotencyKey: input.idempotencyKey,
          pageId: input.pageId,
          prompt: input.prompt,
          resourceScope,
          runId: input.runId,
          voiceSelection: parseReachDeckVoiceSelection(
            input.voiceSelection ?? DEFAULT_REACH_DECK_VOICE_SELECTION,
          ),
        }),
      )
      .digest('hex')
      .slice(0, 24)
  );
}

export function buildGenerationJobId(input: {
  actorId: string;
  billingGroupId: string | null;
  resourceScope: ReachDeckResourceScope;
  idempotencyKey?: string;
  runId: string;
  pageId: string;
  pageRevision: number;
  attempt: string;
}): string {
  const resourceScope = parseReachDeckResourceScope(input.resourceScope);
  const identity = [
    input.actorId,
    billingIdentityValue(input.billingGroupId),
    stableSerialize(resourceScope),
    input.idempotencyKey ?? '',
    input.runId,
    input.pageId,
    String(input.pageRevision),
    input.attempt,
  ].join('\n');
  return 'deck-v4-' + createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

export function buildStagedGenerationRequestHash(request: unknown): string {
  return createHash('sha256').update(stableSerialize(request)).digest('hex');
}

/**
 * slide 版面内容的稳定 digest：去掉讲稿阶段会改写的 voiceTimeline 与 duration 后哈希。
 * 讲稿任务 payload 携带它，落地时与工作区当前版面比对——版面被重生成/编辑后，
 * 旧讲稿任务与其产物即作废。
 */
export function buildReachDeckSlideContentDigest(scene: DeckSlide): string {
  return buildStagedGenerationRequestHash(stripSlideNarration(scene));
}

/** Interactive identity excluding server-derived narration audio. */
export function buildReachDeckInteractiveContentDigest(scene: InteractiveScene): string {
  const narration =
    scene.narration === undefined
      ? undefined
      : {
          schemaVersion: scene.narration.schemaVersion,
          text: scene.narration.text,
          // 仅在存在时参与：无标记讲稿的存量 digest 不变。
          ...(scene.narration.speechMarkup === undefined
            ? {}
            : { speechMarkup: scene.narration.speechMarkup }),
        };
  return buildStagedGenerationRequestHash({
    ...scene,
    ...(narration === undefined ? {} : { narration }),
  });
}

/** Interactive 讲稿内容 digest：无标记时与历史纯文本 digest 逐字节相同。 */
export function buildReachDeckInteractiveNarrationTextDigest(
  text: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): string {
  // An absent source is a valid identity only for an explicit Interactive text rewrite.
  if (text === '' && speechMarkup === undefined) return sha256('reach-interactive-narration/v1\n');
  return sha256(reachDeckInteractiveNarrationContentDigestInput(text, speechMarkup));
}

/**
 * v2 native slide 版面内容的稳定 digest（native 通道的讲稿任务用）。
 *
 * 与 v1 digest 同构：剥离讲稿阶段会写回的字段（narration/animations/duration，
 * 见 DSL `stripReachDeckNativeSlideNarration`）后做稳定序列化哈希。讲稿任务
 * payload 携带它，worker 重建输入与落地写回时都与物化文档当前版面比对——
 * 教师编辑过版面后，旧讲稿任务与其产物即作废。
 */
export function buildReachDeckNativeSlideContentDigest(slide: ReachDeckNativeSlideV2): string {
  return buildStagedGenerationRequestHash(stripReachDeckNativeSlideNarration(slide));
}

export function buildReachDeckPreservedNarrationDigest(
  slide: ReachDeckNativeSlideV2,
  audioObjectKey: string,
): string {
  return buildStagedGenerationRequestHash({
    narration: slide.narration,
    duration: slide.duration,
    audioObjectKey,
  });
}

/** SHA-256 identity of canonical authoritative narration Markdown. */
export function buildReachDeckNarrationContentDigest(
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): string {
  return sha256(reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup));
}

/**
 * Identity of the narration state observed when a job starts.
 *
 * A page that has never had narration is a valid AI-regeneration input, but an empty string is
 * not a valid narration document. Keep absence distinct instead of weakening Markdown validation.
 */
export function buildReachDeckNarrationStateDigest(
  markdown: string | undefined,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): string {
  return markdown === undefined
    ? sha256('reach-deck-narration/absent-v1')
    : buildReachDeckNarrationContentDigest(markdown, speechMarkup);
}

export function buildScopedStagedGenerationRequestHash(
  resourceScope: ReachDeckResourceScope,
  request: unknown,
): string {
  return buildStagedGenerationRequestHash({
    resourceScope: parseReachDeckResourceScope(resourceScope),
    request,
  });
}

export function buildDecksmithDocumentHash(document: unknown): string {
  return sha256(stableSerialize(stripVolatileReachDeckMediaUrls(parseReachDeckDocument(document))));
}

export function buildDecksmithRequestHash(input: ReachDeckDecksmithJobInput): string {
  return sha256(stableSerialize(input));
}

export function buildDecksmithResultHash(result: ReachDeckDecksmithJobResultContent): string {
  return sha256(stableSerialize(result));
}

export function buildDecksmithRunId(input: {
  idempotencyKey: string;
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
}): string {
  const resourceScope = parseReachDeckResourceScope(input.resourceScope);
  for (const [label, value] of [
    ['idempotencyKey', input.idempotencyKey],
    ['actorId', input.actorId],
    ['roleGrantId', input.roleGrantId],
  ] as const) {
    assertNonblank(value, label);
  }
  return (
    'decksmith-run-v2-' +
    sha256(
      stableSerialize({
        actorId: input.actorId,
        actorOrganizationId: actorOrganizationIdFromPayload(input),
        billingGroupId: billingIdentityValue(input.billingGroupId),
        idempotencyKey: input.idempotencyKey,
        resourceScope,
        roleGrantId: input.roleGrantId,
      }),
    ).slice(0, 32)
  );
}

export function buildDecksmithJobId(input: { runId: string; requestHash: string }): string {
  assertNonblank(input.runId, 'runId');
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new Error('Decksmith requestHash must be a SHA-256 hex digest');
  }
  return 'decksmith-v2-' + sha256(`${input.runId}\n${input.requestHash}`).slice(0, 32);
}

type StagedJobIdentityScope = {
  actorId: string;
  billingGroupId: string | null;
  resourceScope: ReachDeckResourceScope;
  runId: string;
  requestHash: string;
};

export type BuildStagedGenerationJobIdInput =
  | (StagedJobIdentityScope & {
      kind: Extract<ReachDeckStagedGenerationJobKind, 'lesson-plan' | 'page-outline'>;
      createdFromDraftRevision: number;
    })
  | (StagedJobIdentityScope & {
      // 讲稿 job 与页 job 共用页级身份分量；kind 参与身份哈希，两者不会撞 jobId。
      kind: Extract<ReachDeckStagedGenerationJobKind, 'page-generation' | 'narration-generation'>;
      pageId: string;
      requestedRevision: number;
      attempt: number;
    });

export function buildStagedGenerationJobId(input: BuildStagedGenerationJobIdInput): string {
  const resourceScope = parseReachDeckResourceScope(input.resourceScope);
  for (const [label, value] of [
    ['actorId', input.actorId],
    ['runId', input.runId],
  ] as const) {
    assertNonblank(value, label);
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new Error('Staged Reach Deck requestHash must be a SHA-256 hex digest');
  }
  const common = [
    input.actorId,
    billingIdentityValue(input.billingGroupId),
    stableSerialize(resourceScope),
    input.runId,
    input.kind,
  ];
  let identity: string[];
  if ('createdFromDraftRevision' in input) {
    assertIntegerAtLeast(input.createdFromDraftRevision, 0, 'createdFromDraftRevision');
    identity = [...common, String(input.createdFromDraftRevision), input.requestHash];
  } else {
    assertNonblank(input.pageId, 'pageId');
    assertIntegerAtLeast(input.requestedRevision, 1, 'requestedRevision');
    assertIntegerAtLeast(input.attempt, 1, 'attempt');
    // requestHash keeps rewound runs collision-free: after a planning rewind the
    // page identity tuple (runId, pageId, revision, attempt) restarts from the
    // same values, and an identity without content would permanently collide
    // with the durable recovery descriptor of the previous round.
    identity = [
      ...common,
      input.pageId,
      String(input.requestedRevision),
      String(input.attempt),
      input.requestHash,
    ];
  }
  return 'deck-v4-' + createHash('sha256').update(identity.join('\n')).digest('hex').slice(0, 32);
}

function billingIdentityValue(value: string | null): string {
  if (value === null) return 'billing:null';
  if (value.trim().length === 0) {
    throw new Error('Reach Deck billingGroupId must be nonblank or null');
  }
  return `billing:string:${value}`;
}

function assertNonblank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Staged Reach Deck ${label} must be nonblank`);
  }
}

function assertIntegerAtLeast(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Staged Reach Deck ${label} must be an integer >= ${minimum}`);
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableSerialize).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + stableSerialize(record[key]));
  return '{' + entries.join(',') + '}';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
