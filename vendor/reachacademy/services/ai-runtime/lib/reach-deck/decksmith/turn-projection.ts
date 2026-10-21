import { createHash } from 'node:crypto';

import type { RunRecord } from '../../contracts.js';
import {
  DECKSMITH_TURN_PROJECTION_V2,
  parseDecksmithFrozenRunInput,
  type DecksmithFrozenProjection,
  type DecksmithPageSummaryRef,
  type DecksmithProposalOutcome,
} from './page-stream-contracts.js';
import {
  deriveDecksmithProposalOutcome,
  formatDecksmithAssistantEntry,
  formatDecksmithTeacherEntry,
} from './turn-memory.js';

export interface DecksmithProjectionSource {
  readonly runId: string;
  readonly status: RunRecord['status'];
  readonly input: unknown;
  readonly events: readonly {
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }[];
}

export interface DecksmithTurnProjection {
  readonly runId: string;
  readonly sequence: number;
  readonly user: { readonly role: 'user'; readonly content: string };
  readonly assistant?: { readonly role: 'assistant'; readonly content: string };
  /** 仅 v2：入队时冻结的提案结局（无提案时缺省）。v1 投影绝不出现此键，保持旧 digest 不变。 */
  readonly proposalOutcome?: DecksmithProposalOutcome;
}

/**
 * 历史投影策略。v1：教师原话 + result 套话（旧 Run / 旧压缩输入）。
 * v2：结局只来自冻结快照，入队后到达的审批事件不改变投影与 digest。
 */
export type DecksmithProjectionPolicy =
  | { readonly projectionVersion: 1 }
  | {
      readonly projectionVersion: typeof DECKSMITH_TURN_PROJECTION_V2;
      readonly outcomes: ReadonlyMap<string, DecksmithProposalOutcome>;
    };

export const DECKSMITH_PROJECTION_V1: DecksmithProjectionPolicy = Object.freeze({
  projectionVersion: 1,
});

/** 由冻结合同得到投影策略；缺省（旧 Run）即 v1。 */
export function decksmithProjectionPolicy(
  projection: DecksmithFrozenProjection | undefined,
): DecksmithProjectionPolicy {
  if (projection === undefined) return DECKSMITH_PROJECTION_V1;
  return Object.freeze({
    projectionVersion: DECKSMITH_TURN_PROJECTION_V2,
    outcomes: new Map(projection.proposalOutcomes.map((entry) => [entry.runId, entry.outcome])),
  });
}

/**
 * 入队时读取每个源 Run 的当前提案结局，作为 v2 冻结快照（只列出有提案的 Run，按 runId 排序）。
 *
 * 数据源：压缩快照 / 冻结历史中各 Run 的审批与采用事件（ai_run_event）。
 */
export function snapshotDecksmithProposalOutcomes(
  items: readonly DecksmithProjectionSource[],
): DecksmithFrozenProjection['proposalOutcomes'] {
  return items
    .flatMap((item) => {
      const outcome = deriveDecksmithProposalOutcome(item.events);
      return outcome === undefined ? [] : [{ runId: item.runId, outcome }];
    })
    .sort((left, right) => left.runId.localeCompare(right.runId));
}

/** One policy shared by direct history and compaction. Control/hidden/non-turn runs fail parsing. */
export function projectEligibleDecksmithTurns(
  items: readonly DecksmithProjectionSource[],
  epoch: number,
  policy: DecksmithProjectionPolicy = DECKSMITH_PROJECTION_V1,
): readonly DecksmithTurnProjection[] {
  return items
    .flatMap((item) => {
      try {
        if (
          (item.status === 'failed' || item.status === 'cancelled') &&
          !item.events.some(
            (event) => event.type === 'run.started' || event.type === 'run.recovered',
          )
        ) {
          return [];
        }
        const frozen = parseDecksmithFrozenRunInput(item.input);
        if (frozen.stream.epoch !== epoch) return [];
        if (policy.projectionVersion === DECKSMITH_TURN_PROJECTION_V2) {
          return [projectV2Turn(item, frozen, policy)];
        }
        const result = [...item.events].reverse().find((event) => event.type === 'decksmith.result')
          ?.payload.message;
        return [
          Object.freeze({
            runId: item.runId,
            sequence: frozen.stream.sequence,
            user: Object.freeze({ role: 'user' as const, content: frozen.message }),
            ...(typeof result === 'string'
              ? { assistant: Object.freeze({ role: 'assistant' as const, content: result }) }
              : {}),
          }),
        ];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.sequence - right.sequence || left.runId.localeCompare(right.runId));
}

/**
 * v2 单回合投影。
 *
 * 数据源：源 Run 的冻结输入（教师原话、选区与选区提示）、最后一个 `decksmith.result` 事件
 * （assistantText / changeSummary / message），以及调用方冻结的提案结局。
 * 核心逻辑：教师条目 = 原话 + 回答关联行（WP7，仅回答提问时）+ 选区描述；
 * 助手条目 = 实际答复（旧事件回退套话）+ 变更清单 + 结局行 + 结构化提问块（仅提问回合）。
 */
function projectV2Turn(
  item: DecksmithProjectionSource,
  frozen: ReturnType<typeof parseDecksmithFrozenRunInput>,
  policy: Extract<DecksmithProjectionPolicy, { projectionVersion: 2 }>,
): DecksmithTurnProjection {
  const outcome = policy.outcomes.get(item.runId);
  const result = [...item.events].reverse().find((event) => event.type === 'decksmith.result');
  const assistant =
    result === undefined
      ? undefined
      : formatDecksmithAssistantEntry({ payload: result.payload, outcome });
  return Object.freeze({
    runId: item.runId,
    sequence: frozen.stream.sequence,
    user: Object.freeze({
      role: 'user' as const,
      content: formatDecksmithTeacherEntry({
        message: frozen.message,
        contextRefs: frozen.contextRefs,
        hints: frozen.projection?.contextRefHints,
        originPageId: frozen.stream.pageId,
        ...(frozen.clarificationAnswer === undefined
          ? {}
          : { clarificationAnswer: frozen.clarificationAnswer }),
      }),
    }),
    ...(assistant === undefined
      ? {}
      : { assistant: Object.freeze({ role: 'assistant' as const, content: assistant }) }),
    ...(outcome === undefined ? {} : { proposalOutcome: outcome }),
  });
}

/**
 * Compaction consumes only the maximal contiguous prefix of complete eligible turns. An
 * ineligible failed/cancelled-before-start Run is omitted by the shared eligibility policy, while
 * any eligible user-only/incomplete turn is a hard boundary that keeps it and all later turns raw.
 */
export function projectCompleteDecksmithTurns(
  items: readonly DecksmithProjectionSource[],
  epoch: number,
  policy: DecksmithProjectionPolicy = DECKSMITH_PROJECTION_V1,
): readonly (DecksmithTurnProjection & {
  readonly assistant: { readonly role: 'assistant'; readonly content: string };
})[] {
  const statusByRun = new Map(items.map((item) => [item.runId, item.status]));
  const prefix: Array<
    DecksmithTurnProjection & {
      readonly assistant: { readonly role: 'assistant'; readonly content: string };
    }
  > = [];
  for (const turn of projectEligibleDecksmithTurns(items, epoch, policy)) {
    if (statusByRun.get(turn.runId) !== 'completed' || turn.assistant === undefined) break;
    prefix.push({ ...turn, assistant: turn.assistant });
  }
  return Object.freeze(prefix);
}

/**
 * 投影 digest。v1 的序列化形状保持逐字节不变（已排队旧任务按它校验）；
 * v2 额外带 projectionVersion，避免与 v1 摘要碰撞。
 */
export function digestDecksmithTurnProjection(
  turns: readonly DecksmithTurnProjection[],
  previousSummaryDigest?: string,
  projectionVersion: DecksmithProjectionPolicy['projectionVersion'] = 1,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...(projectionVersion === 1 ? {} : { projectionVersion }),
        previousSummaryDigest: previousSummaryDigest ?? null,
        turns,
      }),
    )
    .digest('hex');
}

export function digestDecksmithSummary(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Compare the frozen parent-summary lineage with the live page-stream context at install time.
 * Digest/coverage fields may be absent on a legacy live ref even after the authorized summary body
 * upgraded the frozen ref, but any value present on both sides must remain identical.
 */
export function sameDecksmithSummaryLineage(
  expected: DecksmithPageSummaryRef | undefined,
  current: DecksmithPageSummaryRef | undefined,
): boolean {
  if (expected === undefined || current === undefined) return expected === current;
  return (
    expected.runId === current.runId &&
    expected.revision === current.revision &&
    expected.epoch === current.epoch &&
    expected.sourceDigest === current.sourceDigest &&
    (current.summaryDigest === undefined || expected.summaryDigest === current.summaryDigest) &&
    (current.sourceLastSequence === undefined ||
      expected.sourceLastSequence === current.sourceLastSequence)
  );
}
