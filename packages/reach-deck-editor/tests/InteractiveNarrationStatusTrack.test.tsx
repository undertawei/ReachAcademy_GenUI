// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InteractiveNarrationStatusTrack } from '../src/InteractiveNarrationStatusTrack';
import type { InteractiveNarrationViewModel } from '../src/interactiveNarration';

const readyModel: InteractiveNarrationViewModel = {
  audioSrc: 'https://signed.example/interactive.mp3',
  canonicalText: '拖动滑块并观察结果。',
  draftText: '拖动滑块并观察结果。',
  persistedNarration: {
    schemaVersion: 'reach-interactive-narration/v1',
    text: '拖动滑块并观察结果。',
    audioResourceId: 'interactive-audio',
  },
  scalarCount: 10,
  state: 'ready',
};

describe('InteractiveNarrationStatusTrack', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('plays, pauses, and replays ready audio without timeline controls', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    act(() => root.render(<InteractiveNarrationStatusTrack model={readyModel} pageId="page-1" />));

    expect(container.querySelector('input, select')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')?.click();
    });
    expect(play).toHaveBeenCalledTimes(1);
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    audio.currentTime = 4;
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="暂停互动讲稿"]')?.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="重新播放互动讲稿"]')?.click();
    });
    expect(audio.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('applies the shared preview playback rate to ready audio', () => {
    const onPlaybackRateChange = vi.fn();
    const render = (playbackRate: number) =>
      root.render(
        <InteractiveNarrationStatusTrack
          model={readyModel}
          onPlaybackRateChange={onPlaybackRateChange}
          pageId="page-1"
          playbackRate={playbackRate}
        />,
      );
    act(() => render(1.5));
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.defaultPlaybackRate).toBe(1.5);

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[role="combobox"][aria-label="播放速度"]')
        ?.click(),
    );
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent?.trim() === '0.5x',
    );
    act(() => option?.click());
    expect(onPlaybackRateChange).toHaveBeenCalledWith(0.5);
  });

  it('uses the same save action for dirty and failed states', () => {
    const onSaveAndGenerate = vi.fn();
    const render = (state: 'dirty' | 'failed') =>
      root.render(
        <InteractiveNarrationStatusTrack
          model={{ ...readyModel, state }}
          onSaveAndGenerate={onSaveAndGenerate}
          pageId="page-1"
        />,
      );
    act(() => render('dirty'));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="保存并生成音频"]')?.click());
    act(() => render('failed'));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="重试生成音频"]')?.click());
    expect(onSaveAndGenerate).toHaveBeenCalledTimes(2);
  });

  it('blocks save and retry with the host reason while another operation owns the deck', () => {
    const onSaveAndGenerate = vi.fn();
    act(() =>
      root.render(
        <InteractiveNarrationStatusTrack
          model={{ ...readyModel, state: 'dirty' }}
          onSaveAndGenerate={onSaveAndGenerate}
          pageId="page-1"
          saveBlockedReason="Decksmith 正在修改课件"
        />,
      ),
    );
    const save = container.querySelector<HTMLButtonElement>('[aria-label="保存并生成音频"]')!;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Decksmith 正在修改课件');
    act(() => save.click());
    expect(onSaveAndGenerate).not.toHaveBeenCalled();
  });
});
