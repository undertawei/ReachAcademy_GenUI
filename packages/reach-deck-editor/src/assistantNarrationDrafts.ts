import { reachDeckNarrationMarkdown, type ReachDeckDocument } from '@reachany/reach-deck-dsl';

import type { NarrationDraftCache, NarrationDraftCacheEntry } from './NarrationEditor.js';

/**
 * 采用 Decksmith 候选时的讲稿草稿协调（WP8 / 评审 S8）。
 *
 * 讲稿面板有意把未保存的讲稿（dirty draft）保留在 narrationDraftCache 中：服务端回填、预览、
 * 拒绝提案都不应清掉教师正在写的文字。但教师主动采用一个改写了该页讲稿的 AI 提案时，若继续
 * 保留旧 dirty draft，教师看不到 AI 讲稿，稍后一保存还会把 AI 讲稿覆盖回去。这里只在"采用"这一刻
 * 显式处理：把被替换的 dirty draft 移出缓存交给编辑器暂存，以便提示并支持撤销。
 *
 * 数据源：只处理入参（采用前后的草稿文档与讲稿草稿缓存），不读写服务端。
 */

/** 页面讲稿的内容身份：幻灯片取权威 Markdown + 语音标记，互动页取讲稿文本 + 语音标记。 */
function narrationIdentity(document: ReachDeckDocument, pageId: string): string | undefined {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) return undefined;
  if (page.sceneType === 'interactive') {
    const narration = page.scene.narration;
    return `interactive\u0000${narration?.text ?? ''}\u0000${JSON.stringify(narration?.speechMarkup ?? null)}`;
  }
  if (page.sceneType !== 'slide' || document.schemaVersion !== 'reach-deck-document/v2') {
    return undefined;
  }
  const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
  return `slide\u0000${reachDeckNarrationMarkdown(slide?.narration) ?? ''}\u0000${JSON.stringify(
    slide?.narration?.speechMarkup ?? null,
  )}`;
}

/** 采用前后讲稿内容确有变化的页（采用后仍存在的页）。 */
export function changedNarrationPageIds(
  before: ReachDeckDocument,
  after: ReachDeckDocument,
): string[] {
  return after.pages.flatMap((page) => {
    const next = narrationIdentity(after, page.pageId);
    if (next === undefined) return [];
    const previous = narrationIdentity(before, page.pageId);
    return previous === undefined || previous === next ? [] : [page.pageId];
  });
}

/**
 * 采用改写讲稿的候选时，取出这些页上教师未保存的讲稿草稿。
 *
 * 核心逻辑：只处理讲稿确有变化、且缓存里是 dirty 的页；同步删除缓存条目（讲稿面板据此载入 AI 讲稿），
 * 返回被替换的条目供"撤销"恢复。非 dirty 条目（与旧来源一致的缓存）同样删除，避免旧来源残留。
 */
export function takeReplacedNarrationDrafts(
  cache: NarrationDraftCache,
  before: ReachDeckDocument,
  after: ReachDeckDocument,
): Record<string, NarrationDraftCacheEntry> {
  const replaced: Record<string, NarrationDraftCacheEntry> = {};
  for (const pageId of changedNarrationPageIds(before, after)) {
    const entry = cache.get(pageId);
    if (entry === undefined) continue;
    cache.delete(pageId);
    if (entry.dirty) replaced[pageId] = entry;
  }
  return replaced;
}

/**
 * 撤销替换：把教师之前未保存的讲稿放回缓存。教师在替换后又改过 AI 讲稿（当前条目 dirty）时不覆盖，
 * 较新的教师编辑优先，返回 false。
 */
export function restoreReplacedNarrationDraft(
  cache: NarrationDraftCache,
  pageId: string,
  entry: NarrationDraftCacheEntry,
): boolean {
  if (cache.get(pageId)?.dirty === true) return false;
  cache.set(pageId, { ...entry, dirty: true });
  return true;
}
