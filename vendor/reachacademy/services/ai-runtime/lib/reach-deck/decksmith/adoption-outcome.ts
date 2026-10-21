import type { ApprovalRecord } from '../../contracts.js';
import type { RuntimeStore } from '../../store/store.js';

/**
 * Decksmith 提案的真实采用结局（WP8 / 评审 M10）。
 *
 * `ai_approval.apply_status = 'applied'` 只说明审批已结清、租约可释放，并不等于候选真的落进了课件：
 * - adopted：`/applied` 在写锁内核对到权威文档已包含已批准候选（整文档哈希或逐页状态一致）；
 * - superseded：教师随后的保存改写了提案涉及的页，保存路由按"最新写入为准"结清了提案；
 * - stale：提案之后课件结构或文档外壳已变化，提案永远无法按原样落地，`/applied` 结清并按过期拒绝。
 *
 * 结局与审批状态在同一个应用事务里写入（`markApprovalApplied` 的事件载荷），不新增表或列：
 * 数据源是 `ai_run_event` 中该审批的 `artifact.applied` 事件载荷（`outcome` 字段）。
 * 旧事件没有 `outcome` 字段，只带 supersededByTeacherEdit / supersededByDeckChange 标记；
 * 新事件同时保留这两个旧标记，滚动升级期间的旧代码仍能识别"被替代"。
 */
export const DECKSMITH_ADOPTION_OUTCOMES = Object.freeze([
  'adopted',
  'superseded',
  'stale',
] as const);
export type DecksmithAdoptionOutcome = (typeof DECKSMITH_ADOPTION_OUTCOMES)[number];

export type DecksmithDeckChangeReason = 'structure-changed' | 'envelope-changed';

export function isDecksmithAdoptionOutcome(value: unknown): value is DecksmithAdoptionOutcome {
  return DECKSMITH_ADOPTION_OUTCOMES.includes(value as DecksmithAdoptionOutcome);
}

/**
 * `artifact.applied` 事件载荷中除 approvalId / artifactId（由存储层补齐）以外的结局字段。
 * 被替代与过期继续写旧标记，旧读者（滚动升级中的旧 worker / API）仍把它们识别为 superseded。
 */
export function decksmithAppliedEventFields(
  outcome: DecksmithAdoptionOutcome,
  deckChange?: DecksmithDeckChangeReason,
): Record<string, unknown> {
  if (outcome === 'superseded') return { outcome, supersededByTeacherEdit: true };
  if (outcome === 'stale') {
    return { outcome, supersededByDeckChange: deckChange ?? 'structure-changed' };
  }
  return { outcome };
}

/**
 * 从一条 `artifact.applied` 事件载荷读取采用结局（用于 `/applied` 响应与审批状态展示）。
 * 显式 outcome 优先；旧事件按标记推断：教师替代 → superseded，结构/外壳变化 → stale，
 * 无标记 → adopted（旧版 `/applied` 只在核对到候选已落地后才写无标记事件）。
 */
export function readDecksmithAdoptionOutcome(
  payload: Readonly<Record<string, unknown>>,
): DecksmithAdoptionOutcome {
  if (isDecksmithAdoptionOutcome(payload.outcome)) return payload.outcome;
  if (payload.supersededByTeacherEdit === true) return 'superseded';
  if (payload.supersededByDeckChange !== undefined) return 'stale';
  return 'adopted';
}

/**
 * 读取一个已结清审批的采用结局。
 *
 * 数据源：`ai_run_event`（经 RuntimeStore.listEventsByTypes 按事件类型在存储侧过滤）。
 * 核心逻辑：
 * 1. 只有 applyStatus=applied 的审批才有结局；
 * 2. 取该审批所属 Run 的 `artifact.applied` 事件中 approvalId 匹配的第一条；
 * 3. 没有事件（WP8 之前状态更新与事件追加分离、中间宕机的旧审批）时返回 undefined，调用方按"未知"处理。
 */
export async function loadDecksmithApprovalAdoptionOutcome(
  store: Pick<RuntimeStore, 'listEventsByTypes'>,
  approval: Pick<ApprovalRecord, 'id' | 'runId' | 'applyStatus'>,
): Promise<DecksmithAdoptionOutcome | undefined> {
  if (approval.applyStatus !== 'applied') return undefined;
  const events = await store.listEventsByTypes(approval.runId, ['artifact.applied']);
  const event = events.find((candidate) => candidate.payload.approvalId === approval.id);
  return event === undefined ? undefined : readDecksmithAdoptionOutcome(event.payload);
}

/** `/applied` 与审批状态响应中附带的结局字段；未知结局（旧审批）不输出任何字段。 */
export function publicDecksmithAdoptionOutcome(
  outcome: DecksmithAdoptionOutcome | undefined,
): Record<string, unknown> {
  if (outcome === undefined) return {};
  return { adoptionOutcome: outcome, supersededByTeacherEdit: outcome === 'superseded' };
}
