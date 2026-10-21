import {
  invalidateReachDeckNativeSlideNarration,
  parseReachDeckDocument,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  changedNarrationPageIds,
  restoreReplacedNarrationDraft,
  takeReplacedNarrationDrafts,
} from '../src/assistantNarrationDrafts.js';
import type { NarrationDraftCache, NarrationDraftCacheEntry } from '../src/NarrationEditor.js';
import { createEditorDocument } from './fixture.js';

function withSlideNarration(document: ReachDeckDocument, markdown: string): ReachDeckDocument {
  if (document.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  const [first, ...rest] = document.nativeSlides;
  return parseReachDeckDocument({
    ...document,
    nativeSlides: [
      { ...first!, slide: invalidateReachDeckNativeSlideNarration(first!.slide, markdown) },
      ...rest,
    ],
  });
}

function entry(dirty: boolean, marker: string): NarrationDraftCacheEntry {
  return {
    draftState: { marker } as never,
    speechSpeak: undefined,
    baselineIdentity: `baseline:${marker}`,
    sourceIdentity: `source:${marker}`,
    dirty,
  };
}

describe('narration draft coordination on adoption (WP8 S8)', () => {
  const baseline = withSlideNarration(createEditorDocument(), '原讲稿。');
  const pageId = baseline.pages[0]!.pageId;
  const adopted = withSlideNarration(baseline, 'AI 讲稿。');

  it('detects only pages whose narration text changed', () => {
    expect(changedNarrationPageIds(baseline, adopted)).toEqual([pageId]);
    expect(changedNarrationPageIds(baseline, baseline)).toEqual([]);
  });

  it('takes dirty drafts out of the cache for undo and clears stale clean ones', () => {
    const cache: NarrationDraftCache = new Map([[pageId, entry(true, 'teacher')]]);
    const replaced = takeReplacedNarrationDrafts(cache, baseline, adopted);
    expect(Object.keys(replaced)).toEqual([pageId]);
    expect(cache.has(pageId)).toBe(false);

    const clean: NarrationDraftCache = new Map([[pageId, entry(false, 'clean')]]);
    expect(takeReplacedNarrationDrafts(clean, baseline, adopted)).toEqual({});
    expect(clean.has(pageId)).toBe(false);

    // 讲稿没变（例如只改了版面）：缓存原样保留。
    const untouched: NarrationDraftCache = new Map([[pageId, entry(true, 'teacher')]]);
    expect(takeReplacedNarrationDrafts(untouched, baseline, baseline)).toEqual({});
    expect(untouched.get(pageId)?.dirty).toBe(true);
  });

  it('restores the replaced draft only when the teacher has not edited the AI narration since', () => {
    const replacedEntry = entry(true, 'teacher');
    const cache: NarrationDraftCache = new Map([[pageId, entry(false, 'ai')]]);
    expect(restoreReplacedNarrationDraft(cache, pageId, replacedEntry)).toBe(true);
    expect(cache.get(pageId)).toMatchObject({ dirty: true, baselineIdentity: 'baseline:teacher' });

    const edited: NarrationDraftCache = new Map([[pageId, entry(true, 'newer')]]);
    expect(restoreReplacedNarrationDraft(edited, pageId, replacedEntry)).toBe(false);
    expect(edited.get(pageId)?.baselineIdentity).toBe('baseline:newer');
  });
});
