// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InteractiveNarrationBar } from '../src/InteractiveNarrationBar';

describe('InteractiveNarrationBar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let play: ReturnType<typeof vi.spyOn>;
  let pause: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('shows escaped paragraph copy without autoplay and supports play, pause, and replay', async () => {
    const onPlay = vi.fn();
    const onPause = vi.fn();
    act(() =>
      root.render(
        <InteractiveNarrationBar
          audioSrc="https://signed.example/interactive.mp3"
          onPause={onPause}
          onPlay={onPlay}
          pageId="page-1"
          text={'拖动滑块并观察 <script>alert("x")</script> 的变化。'}
        />,
      ),
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert("x")</script>');
    expect(play).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')?.click();
    });
    expect(play).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledWith(0);

    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    audio.currentTime = 2.5;
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="暂停互动讲稿"]')?.click());
    expect(pause).toHaveBeenCalled();
    expect(onPause).toHaveBeenCalledWith(2.5);

    audio.currentTime = 4;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="重新播放互动讲稿"]')?.click();
    });
    expect(audio.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('pauses and resets when the page changes, and audits natural end locally', async () => {
    const onPause = vi.fn();
    const onPlay = vi.fn();
    const render = (pageId: string) =>
      root.render(
        <InteractiveNarrationBar
          audioSrc="https://signed.example/interactive.mp3"
          onPause={onPause}
          onPlay={onPlay}
          pageId={pageId}
          text="调整参数并比较结果。"
        />,
      );
    act(() => render('page-1'));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')?.click();
    });
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    audio.currentTime = 3;
    act(() => render('page-2'));
    expect(audio.currentTime).toBe(0);
    expect(pause).toHaveBeenCalled();

    const nextAudio = container.querySelector<HTMLAudioElement>('audio')!;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')?.click();
    });
    nextAudio.currentTime = 7;
    act(() => nextAudio.dispatchEvent(new Event('ended')));
    expect(nextAudio.currentTime).toBe(0);
    expect(onPause).toHaveBeenCalledWith(7);
  });

  it('keeps the paragraph visible when audio is missing or fails', () => {
    const render = (audioSrc?: string) =>
      root.render(
        <InteractiveNarrationBar audioSrc={audioSrc} pageId="page-1" text="先拖动，再观察。" />,
      );
    act(() => render());
    expect(container.textContent).toContain('先拖动，再观察。');
    expect(container.textContent).toContain('音频暂不可用');
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')?.disabled,
    ).toBe(true);

    act(() => render('https://signed.example/interactive.mp3'));
    act(() => container.querySelector('audio')?.dispatchEvent(new Event('error')));
    expect(container.textContent).toContain('音频暂不可用');
    expect(container.textContent).toContain('先拖动，再观察。');
  });

  it('audits replay as a pause before starting again when already playing', async () => {
    const onPlay = vi.fn();
    const onPause = vi.fn();
    act(() =>
      root.render(
        <InteractiveNarrationBar
          audioSrc="https://signed.example/interactive.mp3"
          onPause={onPause}
          onPlay={onPlay}
          pageId="page-1"
          text="调整参数并比较结果。"
        />,
      ),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')?.click();
    });
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    audio.currentTime = 2;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="重新播放互动讲稿"]')?.click();
    });
    expect(onPause).toHaveBeenCalledWith(2);
    expect(onPlay).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
  });

  it('autoplays once per page entry without auditing it as a learner action', async () => {
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const render = (pageId: string, audioSrc?: string) =>
      root.render(
        <InteractiveNarrationBar
          audioSrc={audioSrc}
          autoPlay
          onPause={onPause}
          onPlay={onPlay}
          pageId={pageId}
          text="调整参数并比较结果。"
        />,
      );
    // 签名地址晚到：地址就绪后才开始。
    act(() => render('page-1'));
    expect(play).not.toHaveBeenCalled();
    await act(async () => render('page-1', 'https://signed.example/a.mp3'));
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="暂停互动讲稿"]')).not.toBeNull();

    // 同一页换签不重复开始；自然结束不记学习者暂停。
    await act(async () => render('page-1', 'https://signed.example/a2.mp3'));
    expect(play).toHaveBeenCalledTimes(1);
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    act(() => audio.dispatchEvent(new Event('ended')));
    expect(container.querySelector('[aria-label="播放互动讲稿"]')).not.toBeNull();

    await act(async () => render('page-2', 'https://signed.example/b.mp3'));
    expect(play).toHaveBeenCalledTimes(2);
    expect(onPlay).not.toHaveBeenCalled();
    expect(onPause).not.toHaveBeenCalled();
  });

  it('holds a playing ticket, then restores position and intent-free playback from its spare after an error', async () => {
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const onMediaError = vi.fn();
    const onMediaLoaded = vi.fn();
    const render = (audioSrc: string) =>
      root.render(
        <InteractiveNarrationBar
          audioSrc={audioSrc}
          pageId="same-page"
          text="Guidance"
          onPlay={onPlay}
          onPause={onPause}
          onMediaError={onMediaError}
          onMediaLoaded={onMediaLoaded}
        />,
      );
    act(() => render('https://signed.example/first'));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')!.click(),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    audio.currentTime = 6;
    audio.playbackRate = 1.5;
    audio.volume = 0.4;
    audio.muted = true;
    act(() => audio.dispatchEvent(new Event('timeupdate')));
    act(() => render('https://signed.example/spare'));
    expect(audio.getAttribute('src')).toBe('https://signed.example/first');
    act(() => audio.dispatchEvent(new Event('error')));
    expect(onMediaError).toHaveBeenCalledWith('https://signed.example/first');
    expect(audio.getAttribute('src')).toBe('https://signed.example/spare');
    audio.currentTime = 0;
    await act(async () => audio.dispatchEvent(new Event('loadedmetadata')));
    expect(audio.currentTime).toBe(6);
    expect(audio.muted).toBe(true);
    expect(audio.volume).toBe(0.4);
    expect(play).toHaveBeenCalledTimes(2);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPause).not.toHaveBeenCalled();
    expect(onMediaLoaded).not.toHaveBeenCalled();
    act(() => audio.dispatchEvent(new Event('canplay')));
    expect(onMediaLoaded).toHaveBeenCalledWith('https://signed.example/spare');
  });

  it('releases a failed source until a later ticket arrives and ignores premetadata load reset events', async () => {
    const onMediaError = vi.fn();
    const onMediaLoaded = vi.fn();
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const render = (src: string) =>
      root.render(
        <InteractiveNarrationBar
          pageId="late-ticket"
          text="Guidance"
          audioSrc={src}
          onMediaError={onMediaError}
          onMediaLoaded={onMediaLoaded}
          onPlay={onPlay}
          onPause={onPause}
        />,
      );
    act(() => render('/first.mp3'));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')!.click(),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    Object.defineProperty(audio, 'currentSrc', {
      configurable: true,
      value: 'http://localhost/first.mp3',
    });
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 });
    audio.currentTime = 7;
    audio.volume = 0.4;
    audio.muted = true;
    act(() => audio.dispatchEvent(new Event('error')));
    expect(onMediaError).toHaveBeenCalledWith('/first.mp3');
    expect(audio.getAttribute('src')).toBe('/first.mp3');
    act(() => render('/later.mp3'));
    expect(audio.getAttribute('src')).toBe('/later.mp3');
    audio.currentTime = 0;
    audio.volume = 1;
    audio.muted = false;
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 0 });
    act(() => {
      audio.dispatchEvent(new Event('timeupdate'));
      audio.dispatchEvent(new Event('durationchange'));
    });
    await act(async () => audio.dispatchEvent(new Event('loadedmetadata')));
    expect(audio.currentTime).toBe(7);
    expect(audio.volume).toBe(0.4);
    expect(audio.muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(2);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPause).not.toHaveBeenCalled();
    act(() => audio.dispatchEvent(new Event('canplay')));
    expect(onMediaLoaded).toHaveBeenCalledWith('/later.mp3');
    act(() => render('/healthy-spare.mp3'));
    expect(audio.getAttribute('src')).toBe('/later.mp3');
  });

  it('stays playable when the browser refuses autoplay', async () => {
    play.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    await act(async () =>
      root.render(
        <InteractiveNarrationBar
          audioSrc="https://signed.example/a.mp3"
          autoPlay
          pageId="page-1"
          text="调整参数并比较结果。"
        />,
      ),
    );
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('音频暂不可用');
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')?.disabled,
    ).toBe(false);
  });
});
