// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenewableImage, RenewableImageProvider } from '../src/components/RenewableImage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const id = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const oldUrl = 'https://media.test/cover?signature=old';
const newUrl = 'https://media.test/cover?signature=new';
const covers = (url = newUrl) =>
  new Response(
    JSON.stringify({
      ok: true,
      result: [
        { courseId: id, coverUri: url },
        { courseId: otherId, coverUri: newUrl },
      ],
    }),
  );

describe('renewable images', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => covers()),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  function render(src = oldUrl, revision: unknown = 'initial', second = false) {
    act(() =>
      root.render(
        <RenewableImageProvider endpoint="/covers?source=marketplace" revision={revision}>
          <RenewableImage
            imageId={id}
            src={src}
            alt="cover"
            loading="lazy"
            decoding="async"
            fallback={<span>placeholder</span>}
          />
          {second && <RenewableImage imageId={otherId} src={oldUrl} alt="second" loading="lazy" />}
        </RenewableImageProvider>,
      ),
    );
  }
  const advance = async (time: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(time);
    });
  const fire = (name: string, index = 0) =>
    act(() => {
      host.querySelectorAll('img')[index]?.dispatchEvent(new Event(name));
    });

  it('freezes loaded pixels without background downloads or list polling', async () => {
    render();
    fire('load');
    await advance(3_600_000);
    window.dispatchEvent(new Event('focus'));
    await advance(100);
    expect(fetch).not.toHaveBeenCalled();
    expect(host.querySelector('img')?.getAttribute('src')).toBe(oldUrl);
  });
  it('coalesces card errors and retries each image at most once', async () => {
    render(oldUrl, 'initial', true);
    const images = [...host.querySelectorAll('img')];
    act(() => images.forEach((image) => image.dispatchEvent(new Event('error'))));
    await advance(50);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(`ids=${id}%2C${otherId}`);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(newUrl);
    expect(host.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    fire('load', 1);
    fire('error');
    expect(host.textContent).toContain('placeholder');
    await advance(3_600_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a loaded image when another card causes URL renewal', async () => {
    render(oldUrl, 'initial', true);
    fire('load');
    fire('error', 1);
    await advance(50);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(oldUrl);
  });
  it('keeps a visible download intact until it fails, then renews with lazy loading', async () => {
    render();
    await advance(600_050);
    expect(fetch).not.toHaveBeenCalled();
    fire('error');
    await advance(50);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(newUrl);
    expect(host.querySelector('img')?.getAttribute('loading')).toBe('lazy');
  });
  it('does not remount a slow download when the client clock makes its URL look expired', async () => {
    let intersect: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const skewedUrl = `https://media.test/cover?auth_key=${Math.floor(Date.now() / 1000) - 4000}-x`;
    render(skewedUrl);
    const image = host.querySelector('img')!;
    Object.defineProperty(image, 'currentSrc', { configurable: true, value: skewedUrl });
    act(() =>
      intersect?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    await advance(60_000);
    window.dispatchEvent(new Event('focus'));
    await advance(50);
    expect(fetch).not.toHaveBeenCalled();
    expect(host.querySelector('img')).toBe(image);
    expect(image.getAttribute('src')).toBe(skewedUrl);
    fire('load');
    expect(host.querySelector('img')).toBe(image);
  });
  it('does not request an unloaded offscreen image until it becomes visible', async () => {
    let intersect: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    render();
    await advance(700_000);
    expect(fetch).not.toHaveBeenCalled();
    act(() =>
      intersect?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    await advance(50);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('pauses hidden image recovery and resumes when visible', async () => {
    render();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fire('error');
    await advance(300_000);
    expect(fetch).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(50);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retries transient URL renewal without losing a previously loaded cover', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(covers());
    render(oldUrl, 'initial', true);
    fire('load');
    fire('error', 1);
    await advance(50);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(oldUrl);
    await advance(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(oldUrl);
    expect(host.querySelectorAll('img')[1]?.getAttribute('src')).toBe(newUrl);
  });
  it('ignores late renewal after newer props and aborts the old request', async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    render();
    fire('error');
    await advance(50);
    const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    render('https://media.test/replaced', 'new');
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve(covers());
      await Promise.resolve();
    });
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://media.test/replaced');
  });
  it('shows a placeholder for missing authorization and for a second identical-URL failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(covers(oldUrl));
    render();
    fire('error');
    await advance(50);
    expect(host.querySelector('img')?.getAttribute('src')).toBe(oldUrl);
    fire('error');
    expect(host.querySelector('img')).toBeNull();
    await advance(1_200_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('clears images on definitive denial even with a non-JSON body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html/>', { status: 403 }));
    render();
    fire('error');
    await advance(50);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('placeholder');
    await advance(1_200_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caps each coalesced request at 100 image IDs', async () => {
    const ids = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    act(() =>
      root.render(
        <RenewableImageProvider endpoint="/covers?source=marketplace">
          {ids.map((imageId) => (
            <RenewableImage key={imageId} imageId={imageId} src={oldUrl} alt="cover" />
          ))}
        </RenewableImageProvider>,
      ),
    );
    const images = [...host.querySelectorAll('img')];
    act(() => images.forEach((image) => image.dispatchEvent(new Event('error'))));
    await advance(50);
    expect(fetch).toHaveBeenCalledTimes(2);
    const sizes = vi
      .mocked(fetch)
      .mock.calls.map(
        ([url]) =>
          new URL(String(url), 'https://app.test').searchParams.get('ids')?.split(',').length,
      );
    expect(sizes).toEqual([100, 1]);
  });

  it('retries malformed success payloads and shows a placeholder for omitted IDs', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: 'bad' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: [] })));
    render();
    fire('error');
    await advance(50);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('placeholder');
    await advance(1_200_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
