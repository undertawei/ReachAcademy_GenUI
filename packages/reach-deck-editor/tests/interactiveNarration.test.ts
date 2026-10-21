import { describe, expect, it } from 'vitest';

import {
  deriveInteractiveNarrationViewModel,
  interactiveNarrationGenerationState,
} from '../src/interactiveNarration';

const narration = {
  schemaVersion: 'reach-interactive-narration/v1' as const,
  text: '拖动滑块并观察图形变化。',
};

describe('deriveInteractiveNarrationViewModel', () => {
  it('distinguishes absent, edited, queued, generating, ready, and failed narration', () => {
    expect(deriveInteractiveNarrationViewModel({ draftText: '' }).state).toBe('empty');
    expect(
      deriveInteractiveNarrationViewModel({
        draftText: '修改后的讲稿',
        persistedNarration: narration,
      }).state,
    ).toBe('dirty');
    expect(
      deriveInteractiveNarrationViewModel({
        draftText: narration.text,
        generationStatus: {
          activity: 'queued',
          phase: 'narration',
          state: 'loading',
        },
        persistedNarration: narration,
      }).state,
    ).toBe('queued');
    expect(
      deriveInteractiveNarrationViewModel({
        draftText: narration.text,
        generationStatus: { phase: 'narration', state: 'loading' },
        persistedNarration: narration,
      }).state,
    ).toBe('generating');
    expect(
      deriveInteractiveNarrationViewModel({
        audioSrc: 'https://signed.example/interactive.mp3',
        draftText: narration.text,
        persistedNarration: { ...narration, audioResourceId: 'audio-1' },
      }).state,
    ).toBe('ready');
    expect(
      deriveInteractiveNarrationViewModel({
        draftText: narration.text,
        generationStatus: {
          message: 'TTS failed',
          phase: 'narration',
          state: 'failed',
        },
        persistedNarration: narration,
      }),
    ).toMatchObject({ failureMessage: 'TTS failed', state: 'failed' });
  });

  it('canonicalizes spaces and validates one paragraph using Unicode scalar limits', () => {
    expect(deriveInteractiveNarrationViewModel({ draftText: '  拖动  滑块  ' })).toMatchObject({
      canonicalText: '拖动 滑块',
      scalarCount: 5,
    });
    expect(deriveInteractiveNarrationViewModel({ draftText: '第一行\n第二行' })).toMatchObject({
      state: 'dirty',
      validationError: 'invalid',
    });
    expect(deriveInteractiveNarrationViewModel({ draftText: '🔬'.repeat(601) })).toMatchObject({
      scalarCount: 601,
      validationError: 'limit',
    });
  });

  it('keeps a local edit dirty while an older generation is still running', () => {
    expect(
      deriveInteractiveNarrationViewModel({
        draftText: '新的讲稿。',
        generationStatus: { phase: 'narration', state: 'loading' },
        persistedNarration: narration,
      }).state,
    ).toBe('dirty');
  });

  it('shows a failed save on both surfaces while retaining the dirty draft', () => {
    expect(
      deriveInteractiveNarrationViewModel({
        draftText: '新的讲稿。',
        persistedNarration: narration,
        saveError: 'Save failed',
      }),
    ).toMatchObject({
      draftText: '新的讲稿。',
      failureMessage: 'Save failed',
      state: 'failed',
    });
  });

  it('trusts the narration panel draft snapshot over plain-text derivation', () => {
    const persistedNarration = { ...narration, audioResourceId: 'audio-1' };
    // 只改了语音标记：文本与已保存一致，但面板判定为未保存。
    expect(
      deriveInteractiveNarrationViewModel({
        draft: { dirty: true, saving: false, scalarCount: 12, text: narration.text },
        draftText: narration.text,
        persistedNarration,
      }),
    ).toMatchObject({ canonicalText: narration.text, scalarCount: 12, state: 'dirty' });
    expect(
      deriveInteractiveNarrationViewModel({
        draft: { dirty: false, saving: false, scalarCount: 12, text: narration.text },
        draftText: '被忽略的文本',
        persistedNarration,
      }),
    ).toMatchObject({ canonicalText: narration.text, state: 'ready' });

    const invalid = deriveInteractiveNarrationViewModel({
      draft: { dirty: true, saving: false, scalarCount: 601, validationError: 'limit' },
      draftText: narration.text,
      persistedNarration,
    });
    expect(invalid).toMatchObject({ state: 'dirty', validationError: 'limit' });
    expect(invalid.canonicalText).toBeUndefined();

    expect(
      deriveInteractiveNarrationViewModel({
        draft: { dirty: false, saving: false, scalarCount: 0, validationError: 'empty' },
        draftText: '',
      }).state,
    ).toBe('empty');
    expect(
      deriveInteractiveNarrationViewModel({
        draft: {
          dirty: true,
          saveError: '保存失败',
          saving: false,
          scalarCount: 3,
          text: '新讲稿',
        },
        draftText: narration.text,
        persistedNarration,
      }),
    ).toMatchObject({ failureMessage: '保存失败', state: 'failed' });
  });

  it('projects the host generation status for the narration panel footer', () => {
    expect(interactiveNarrationGenerationState(undefined)).toBeUndefined();
    expect(
      interactiveNarrationGenerationState({
        activity: 'queued',
        phase: 'narration',
        state: 'loading',
      }),
    ).toBe('queued');
    expect(interactiveNarrationGenerationState({ phase: 'narration', state: 'loading' })).toBe(
      'generating',
    );
    expect(
      interactiveNarrationGenerationState({
        message: 'TTS failed',
        phase: 'narration',
        state: 'failed',
      }),
    ).toBe('failed');
    expect(
      interactiveNarrationGenerationState({ phase: 'narration', state: 'manual-review-required' }),
    ).toBe('failed');
    expect(
      interactiveNarrationGenerationState({ phase: 'layout', state: 'loading' }),
    ).toBeUndefined();
  });
});
