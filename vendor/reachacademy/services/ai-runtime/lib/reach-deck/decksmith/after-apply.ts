import {
  reachDeckNarrationMarkdown,
  type ReachDeckDocument,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';

import {
  REACH_DECK_DECKSMITH_AFTER_APPLY_LIMIT,
  parseReachDeckDecksmithAfterApply,
  type ReachDeckDecksmithAfterApplyAction,
  type ReachDeckDecksmithAfterApplyKind,
} from '../contracts.js';
import { buildReachDeckNarrationStateDigest } from '../job-identity.js';

/**
 * 采用后页面媒体意图（WP8）的纯函数：校验、讲稿 digest 与持久化形状。
 *
 * 数据源：只处理入参——Decksmith 声明的意图、Run 冻结基线与候选整文档、`/applied` 写锁内读到的
 * 权威文档，以及 `artifact.applied` 事件载荷；本模块不读写数据库。
 */

/** `artifact.applied` 事件载荷里随真实采用结局一起落库的意图条目（含采用时的讲稿 digest）。 */
export interface DecksmithAdoptedAfterApplyAction {
  readonly kind: ReachDeckDecksmithAfterApplyKind;
  readonly pageId: string;
  /** 采用时权威讲稿的状态 digest；入队时与当时的权威讲稿比对，教师之后改过讲稿则跳过。 */
  readonly narrationDigest: string;
}

/** 意图对应的媒体批次动画模式，与编辑器同名按钮一致（见 ReachDeckEditor 的 suggested action 执行）。 */
export function decksmithAfterApplyAnimationMode(
  kind: ReachDeckDecksmithAfterApplyKind,
): 'skip' | 'regenerate' {
  return kind === 'regenerate-page-media' ? 'regenerate' : 'skip';
}

/** 幻灯片讲稿的状态 digest（与讲稿媒体生成路由的 expectedNarrationContentDigest 同一算法）。 */
export function decksmithSlideNarrationDigest(slide: ReachDeckNativeSlideV2): string {
  return buildReachDeckNarrationStateDigest(
    reachDeckNarrationMarkdown(slide.narration),
    slide.narration?.speechMarkup,
  );
}

function nativeSlide(document: ReachDeckDocument, pageId: string) {
  if (document.schemaVersion !== 'reach-deck-document/v2') return undefined;
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page?.sceneType !== 'slide') return undefined;
  return document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
}

/**
 * 服务端校验 Decksmith 声明的采用后媒体意图（会话结果、提案落库与 `/applied` 共用）。
 *
 * 核心逻辑：
 * 1. 每页最多一条、总数不超过上限，后声明的覆盖先声明的；
 * 2. 只保留候选中仍是幻灯片、讲稿非空的页；
 * 3. 讲稿必须相对基线确有变化（新页视为变化）——意图只能伴随本次运行写过的讲稿出现；
 * 4. 其余条目静默丢弃（模型侧已有工具级拒绝，这里是兜底）。
 */
export function validateDecksmithAfterApplyActions(input: {
  readonly baseline: ReachDeckDocument;
  readonly candidate: ReachDeckDocument;
  readonly actions: readonly ReachDeckDecksmithAfterApplyAction[];
}): ReachDeckDecksmithAfterApplyAction[] {
  const latest = new Map<string, ReachDeckDecksmithAfterApplyAction>();
  for (const action of input.actions) latest.set(action.pageId, action);
  const accepted: ReachDeckDecksmithAfterApplyAction[] = [];
  for (const action of latest.values()) {
    if (accepted.length >= REACH_DECK_DECKSMITH_AFTER_APPLY_LIMIT) break;
    const candidate = nativeSlide(input.candidate, action.pageId);
    const markdown =
      candidate === undefined ? undefined : reachDeckNarrationMarkdown(candidate.narration);
    if (candidate === undefined || markdown === undefined || markdown.trim() === '') continue;
    const baseline = nativeSlide(input.baseline, action.pageId);
    if (
      baseline !== undefined &&
      decksmithSlideNarrationDigest(baseline) === decksmithSlideNarrationDigest(candidate)
    ) {
      continue;
    }
    accepted.push({ kind: action.kind, pageId: action.pageId });
  }
  return accepted;
}

/** 宽松读取提案 changeSet 里的意图：缺省或不合法（旧提案、被篡改）一律视为没有意图。 */
export function readDecksmithProposalAfterApply(
  changeSet: Readonly<Record<string, unknown>>,
): readonly ReachDeckDecksmithAfterApplyAction[] {
  if (changeSet.afterApply === undefined) return [];
  try {
    return parseReachDeckDecksmithAfterApply(changeSet.afterApply);
  } catch {
    return [];
  }
}

/**
 * 采用确认时把意图绑定到权威讲稿（写锁内、与结局同一事务落库）。
 * 权威文档已被证明包含候选，所以这里读到的讲稿就是候选讲稿；页面不再是带讲稿的幻灯片时丢弃。
 */
export function bindDecksmithAfterApplyToAdoptedDocument(
  actions: readonly ReachDeckDecksmithAfterApplyAction[],
  document: ReachDeckDocument,
): DecksmithAdoptedAfterApplyAction[] {
  return actions.flatMap((action) => {
    const slide = nativeSlide(document, action.pageId);
    const markdown = slide === undefined ? undefined : reachDeckNarrationMarkdown(slide.narration);
    if (slide === undefined || markdown === undefined || markdown.trim() === '') return [];
    return [
      {
        kind: action.kind,
        pageId: action.pageId,
        narrationDigest: decksmithSlideNarrationDigest(slide),
      },
    ];
  });
}

/** 从 `artifact.applied` 事件载荷读取已绑定的意图；缺省或不合法时返回空数组。 */
export function readDecksmithAdoptedAfterApply(
  payload: Readonly<Record<string, unknown>>,
): DecksmithAdoptedAfterApplyAction[] {
  const value = payload.afterApply;
  if (!Array.isArray(value) || value.length > REACH_DECK_DECKSMITH_AFTER_APPLY_LIMIT) return [];
  const seen = new Set<string>();
  const actions: DecksmithAdoptedAfterApplyAction[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (
      (record.kind !== 'generate-page-audio' && record.kind !== 'regenerate-page-media') ||
      typeof record.pageId !== 'string' ||
      record.pageId.trim() === '' ||
      typeof record.narrationDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.narrationDigest) ||
      seen.has(record.pageId)
    ) {
      return [];
    }
    seen.add(record.pageId);
    actions.push({
      kind: record.kind,
      pageId: record.pageId,
      narrationDigest: record.narrationDigest,
    });
  }
  return actions;
}
