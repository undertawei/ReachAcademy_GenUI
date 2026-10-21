import { describe, expect, it } from 'vitest';
import { parseReachDeckNarrationSpeechDocument } from '@reachany/reach-deck-dsl';
import {
  prepareNarrationDraftForRegeneration,
  type NarrationDraftCacheEntry,
} from '../src/NarrationEditor';
import { createEditorDocument } from './fixture';

const entry = (markdown: string, source = 'Saved narration'): NarrationDraftCacheEntry => ({
  draftState: { draft: parseReachDeckNarrationSpeechDocument(markdown), literalFallback: false },
  speechSpeak: undefined,
  baselineIdentity: source,
  sourceIdentity: source + '\u0000undefined',
  dirty: true,
});

describe('regeneration narration preparation', () => {
  it('serializes valid unsaved edits without changing the saved source', () => {
    const slide = createEditorDocument().nativeSlides[0]!.slide;
    slide.narration = { markdown: 'Saved narration' };
    const draft = entry('Updated narration');
    expect(prepareNarrationDraftForRegeneration(draft, { slide })).toMatchObject({
      markdown: 'Updated narration',
      sourceIdentity: 'Updated narration\u0000undefined',
    });
    expect(slide.narration.markdown).toBe('Saved narration');
    expect(draft.dirty).toBe(true);
  });

  it('rejects a source conflict before overwriting current authoritative content', () => {
    const slide = createEditorDocument().nativeSlides[0]!.slide;
    slide.narration = { markdown: 'Changed elsewhere' };
    expect(() => prepareNarrationDraftForRegeneration(entry('My draft'), { slide })).toThrow(
      '讲稿已在其他位置发生变化',
    );
  });

  it('rejects empty/unsupported drafts using user-facing errors', () => {
    const slide = createEditorDocument().nativeSlides[0]!.slide;
    slide.narration = { markdown: 'Saved narration' };
    const draft = entry('Updated narration');
    draft.speechSpeak = { rate: 1 } as NarrationDraftCacheEntry['speechSpeak'];
    expect(() => prepareNarrationDraftForRegeneration(draft, { slide })).toThrow(
      '有未保存的讲稿未通过校验',
    );
    draft.speechSpeak = undefined;
    draft.draftState = {
      draft: { type: 'doc', content: [{ type: 'paragraph' }] },
      literalFallback: false,
    };
    expect(() => prepareNarrationDraftForRegeneration(draft, { slide })).toThrow(
      '有未保存的讲稿未通过校验',
    );
  });

  it('normalizes Interactive output into a single paragraph for the draft-only saver', () => {
    expect(
      prepareNarrationDraftForRegeneration(entry('Updated  narration'), {
        interactive: {
          id: 'interactive',
          narration: { schemaVersion: 'reach-interactive-narration/v1', text: 'Saved narration' },
        },
      }),
    ).toMatchObject({
      text: 'Updated narration',
      sourceIdentity: 'Updated narration\u0000undefined',
    });
  });
});
