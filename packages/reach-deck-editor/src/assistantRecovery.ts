import {
  reachDeckPageContentEqual,
  reachDeckValuesEqual,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { rebaseAssistantCandidateByPages } from './assistantRebase.js';

/**
 * 已批准 Decksmith 候选的"有版本证明的恢复"（WP8 / 评审 M9）。
 *
 * 场景：`/applied` 答复 candidate_not_authoritative_yet，而草稿里已经没有候选的页（多页候选只保存了
 * 一部分、旧的服务端刷新把草稿换回了基线等）。以前直接把整份候选写回草稿，会盖掉教师之后在其他页
 * 或同一页上的修改。现在只在能证明没有较新的教师修改时才恢复，且只恢复候选改动的页：
 * 1. 宿主先把本地待保存的编辑落盘，再用审批的冲突报告（服务端按采用证明逐页比对权威文档）证明
 *    提案改动的页仍处于"基线或候选"状态——跨标签页与本标签页已保存的较新修改都会被报告为 stale；
 * 2. 编辑器在发起检查前记下本地 editVersion 与审批 id、候选指纹，检查返回后三者都未变才写入，
 *    检查期间的本地编辑或刷新交错一律不自动覆盖；
 * 3. 证明不成立时返回冲突，由教师显式"重新采用"；结构 / 外壳已变的过期提案交给 `/applied` 结清。
 *
 * 数据源：只处理入参（候选、当前草稿、提案改动页与服务端冲突报告），不读写服务端。
 */

export interface DecksmithRestoreCheck {
  readonly expired: boolean;
  readonly conflicts: readonly { readonly kind: string; readonly pageIds: readonly string[] }[];
  /** 服务端冲突报告给出的提案足迹；缺省表示调用方没有服务端报告（只做本地判断）。 */
  readonly changedPageIds?: readonly string[];
  readonly structural?: boolean;
  readonly envelopeChanged?: boolean;
}

export type DecksmithCandidateRestorePlan =
  /** 草稿已包含候选改动的全部页（及结构、外壳），无需写入。 */
  | { readonly kind: 'present' }
  /** 证明成立：只把这些页恢复为候选内容。 */
  | {
      readonly kind: 'restore';
      readonly document: ReachDeckDocument;
      readonly pageIds: readonly string[];
    }
  /** 提案已过期（结构或外壳在提案之后变化）：不恢复，由 `/applied` 按过期结清。 */
  | { readonly kind: 'settle' }
  /** 无法证明没有较新的教师修改：需要教师显式重新采用。 */
  | {
      readonly kind: 'conflict';
      readonly reason: 'later-edit' | 'overlap' | 'unmergeable';
      readonly pageIds: readonly string[];
    };

function pageMatches(left: ReachDeckDocument, right: ReachDeckDocument, pageId: string): boolean {
  const leftPage = left.pages.find((page) => page.pageId === pageId);
  const rightPage = right.pages.find((page) => page.pageId === pageId);
  if (leftPage === undefined || rightPage === undefined) return leftPage === rightPage;
  if (!reachDeckPageContentEqual(leftPage, rightPage)) return false;
  if (
    left.schemaVersion !== 'reach-deck-document/v2' ||
    right.schemaVersion !== 'reach-deck-document/v2'
  ) {
    return left.schemaVersion === right.schemaVersion;
  }
  return reachDeckValuesEqual(
    left.nativeSlides.find((binding) => binding.pageId === pageId),
    right.nativeSlides.find((binding) => binding.pageId === pageId),
  );
}

function orderedPageIds(document: ReachDeckDocument): string[] {
  return [...document.pages]
    .sort((left, right) => left.order - right.order)
    .map((page) => page.pageId);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * 根据服务端冲突报告与当前草稿，决定已批准候选能否安全恢复进草稿。
 *
 * 核心逻辑：
 * 1. 过期、结构或外壳在提案之后变化、或服务端报告空足迹（审批已结清）→ settle（交给 `/applied` 结清，不恢复）；
 * 2. 报告里有 stale 页（提案之后被修改过）→ later-edit 冲突；有其他已批准未落地提案占用同页 → overlap 冲突；
 * 3. 草稿已与候选一致（改动页、结构顺序、外壳）→ present；
 * 4. 否则按改动页把候选并入当前草稿；结构性候选还要求草稿里没有提案之外新增的页（否则会被丢弃），
 *    并入失败时 → unmergeable 冲突。
 */
export function planDecksmithCandidateRestore(input: {
  readonly candidate: ReachDeckDocument;
  readonly draft: ReachDeckDocument;
  readonly changedPageIds: readonly string[];
  readonly structural: boolean;
  readonly envelopeChanged: boolean;
  readonly check: DecksmithRestoreCheck;
}): DecksmithCandidateRestorePlan {
  const { candidate, draft, changedPageIds, structural, envelopeChanged, check } = input;
  // 冲突报告只对仍待采用的提案给出真实足迹；检查期间审批已被结清（教师保存替代、过期、另一标签页
  // 已确认采用）或是旧版审批时返回空足迹。此时不能再按本地记忆的结构性候选重建页序——那会覆盖
  // 教师之后的删页 / 重排——只交给 `/applied` 按服务端结局结清。
  const settledOnServer =
    check.changedPageIds !== undefined &&
    check.changedPageIds.length === 0 &&
    check.structural !== true &&
    check.envelopeChanged !== true;
  if (
    settledOnServer ||
    check.expired ||
    check.conflicts.some(
      (conflict) => conflict.kind === 'structure-changed' || conflict.kind === 'envelope-changed',
    )
  ) {
    return { kind: 'settle' };
  }
  const later = unique(
    check.conflicts
      .filter((conflict) => conflict.kind === 'stale')
      .flatMap((conflict) => conflict.pageIds),
  );
  if (later.length > 0) return { kind: 'conflict', reason: 'later-edit', pageIds: later };
  const overlap = unique(
    check.conflicts
      .filter((conflict) => conflict.kind === 'adoption-in-progress')
      .flatMap((conflict) => conflict.pageIds),
  );
  if (overlap.length > 0) return { kind: 'conflict', reason: 'overlap', pageIds: overlap };

  const missing = changedPageIds.filter((pageId) => !pageMatches(draft, candidate, pageId));
  const candidateOrder = orderedPageIds(candidate);
  const orderMatches =
    !structural || JSON.stringify(orderedPageIds(draft)) === JSON.stringify(candidateOrder);
  const envelopeMatches =
    !envelopeChanged ||
    (draft.title === candidate.title && reachDeckValuesEqual(draft.resources, candidate.resources));
  if (missing.length === 0 && orderMatches && envelopeMatches) return { kind: 'present' };

  if (structural) {
    // 结构性候选按候选页序重建：草稿里提案没有涉及、候选里也没有的页会被丢弃，这只能是之后新增的页。
    const known = new Set([...candidateOrder, ...changedPageIds]);
    const added = draft.pages.map((page) => page.pageId).filter((pageId) => !known.has(pageId));
    if (added.length > 0) return { kind: 'conflict', reason: 'later-edit', pageIds: added };
  }
  const rebased = rebaseAssistantCandidateByPages(candidate, draft, changedPageIds, {
    envelopeChanged,
    structural,
  });
  if (rebased === undefined) return { kind: 'conflict', reason: 'unmergeable', pageIds: missing };
  return { kind: 'restore', document: rebased.document, pageIds: missing };
}

/**
 * 提案改动的页：恢复的提案取采用证明给出的页；本轮直接产生的提案按起始草稿与候选逐页比较
 * （新增、删除、内容或原生绑定变化）。两者都没有时返回 undefined（无法证明，不自动恢复）。
 */
export function decksmithCandidateChangedPageIds(input: {
  readonly candidate: ReachDeckDocument;
  readonly baseline?: ReachDeckDocument;
  readonly changedPageIds?: readonly string[];
}): readonly string[] | undefined {
  if (input.changedPageIds !== undefined) return input.changedPageIds;
  const baseline = input.baseline;
  if (baseline === undefined) return undefined;
  const pageIds = unique([
    ...baseline.pages.map((page) => page.pageId),
    ...input.candidate.pages.map((page) => page.pageId),
  ]);
  // 与采用证明一致：页序变化也算改动（证明的页状态含 order）。
  const orderOf = (document: ReachDeckDocument, pageId: string) =>
    document.pages.find((page) => page.pageId === pageId)?.order;
  return pageIds.filter(
    (pageId) =>
      !pageMatches(baseline, input.candidate, pageId) ||
      orderOf(baseline, pageId) !== orderOf(input.candidate, pageId),
  );
}

/** 候选指纹：检查前后比对，防止等待期间待处理的候选被另一个结果替换。 */
export function decksmithCandidateFingerprint(candidate: ReachDeckDocument): string {
  return JSON.stringify([
    candidate.id,
    candidate.title,
    orderedPageIds(candidate),
    candidate.pages.map((page) => [page.pageId, page.revision]),
  ]);
}
