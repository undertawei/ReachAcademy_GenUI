// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AnimatedGif, type AnimatedGifProps } from '../src/AnimatedGif.js';
import { parseGif, createGifCompositor } from '../src/gifFrames.js';

// Two full 1x1 frames: red then blue, each 100ms, infinite looping.
const bytes = new Uint8Array([
  ...Array.from('GIF89a', (s) => s.charCodeAt(0)),
  1,
  0,
  1,
  0,
  128,
  0,
  0,
  255,
  0,
  0,
  0,
  0,
  255,
  33,
  249,
  4,
  0,
  10,
  0,
  0,
  0,
  44,
  0,
  0,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
  2,
  2,
  68,
  1,
  0,
  33,
  249,
  4,
  0,
  10,
  0,
  0,
  0,
  44,
  0,
  0,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
  2,
  2,
  76,
  1,
  0,
  59,
]);
let root: Root, host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>, next: number;
const putImageData = vi.fn();
const props: AnimatedGifProps = {
  src: '/motion.gif',
  alt: 'Point moves',
  visible: true,
  playing: true,
  staticMode: false,
  reducedMotion: false,
  elementId: 'motion',
  resourceId: 'gif',
  fit: 'contain',
  controlLabel: (action) => action,
};
const render = async (overrides: Partial<AnimatedGifProps> = {}) => {
  await act(async () => {
    root.render(<AnimatedGif {...props} {...overrides} />);
  });
};
const tick = async (time: number) => {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(time));
  });
};
const lastPixel = () => Array.from(putImageData.mock.calls.at(-1)![0].data as Uint8ClampedArray);
beforeEach(() => {
  frames = new Map();
  next = 0;
  putImageData.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    putImageData,
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(bytes)),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('controlled GIF lifecycle', () => {
  it('parses and composites actual frame bytes without retaining decoded animation', () => {
    const animation = parseGif(bytes),
      draw = createGifCompositor(animation);
    expect(Array.from(draw(0))).toEqual([255, 0, 0, 255]);
    expect(Array.from(draw(1))).toEqual([0, 0, 255, 255]);
    expect(Array.from(draw(0))).toEqual([255, 0, 0, 255]);
    expect(() => parseGif(bytes.subarray(0, 30))).toThrow();
  });
  it('starts at frame zero, pauses at the current frame, resumes, and restarts on reveal', async () => {
    await render();
    expect(lastPixel()).toEqual([255, 0, 0, 255]);
    await tick(0);
    await tick(110);
    expect(lastPixel()).toEqual([0, 0, 255, 255]);
    await render({ playing: false });
    const count = putImageData.mock.calls.length;
    await tick(300);
    expect(putImageData).toHaveBeenCalledTimes(count);
    await render({ playing: true });
    await tick(1000);
    expect(lastPixel()).toEqual([0, 0, 255, 255]);
    await tick(1110);
    expect(lastPixel()).toEqual([255, 0, 0, 255]);
    await render({ visible: false });
    expect(frames.size).toBe(0);
    await render({ visible: true });
    expect(lastPixel()).toEqual([255, 0, 0, 255]);
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);
    root = createRoot(host);
  });
  it('defaults reduced motion to frame zero and requires explicit play', async () => {
    await render({ reducedMotion: true });
    expect(lastPixel()).toEqual([255, 0, 0, 255]);
    expect(frames.size).toBe(0);
    await act(async () => host.querySelector('button')!.click());
    await tick(0);
    await tick(110);
    expect(lastPixel()).toEqual([0, 0, 255, 255]);
    await act(async () => host.querySelector('button')!.click());
    expect(frames.size).toBe(0);
  });
  it('keeps the decoded canvas path when bytes load', async () => {
    await render({ fit: 'cover' });
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[data-gif-state]')!.getAttribute('data-gif-state')).toBe('playing');
  });
});

describe('native <img> fallback when bytes cannot be read', () => {
  const src = 'https://oss.example.com/motion.gif?Signature=x';
  it('renders the original URL natively when fetch rejects (e.g. CORS)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await render({ src, fit: 'cover' });
    const img = host.querySelector('img')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe(src);
    expect(img.getAttribute('alt')).toBe('Point moves');
    expect(img.style.objectFit).toBe('cover');
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[data-gif-state]')!.getAttribute('data-gif-state')).toBe('native');
    expect(frames.size).toBe(0);
    // Hidden -> unmounted without refetching; re-entry remounts so the GIF restarts.
    await render({ src, visible: false });
    expect(host.querySelector('img')).toBeNull();
    await render({ src, visible: true });
    expect(host.querySelector('img')!.getAttribute('src')).toBe(src);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('falls back when the bytes are not a decodable GIF, including in static mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes.subarray(0, 30))),
    );
    await render({ src, staticMode: true, fit: 'stretch' });
    expect(host.querySelector('img')!.style.objectFit).toBe('fill');
  });
  it('falls back when the response body fails mid-read instead of leaving a blank canvas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 10));
                controller.error(new TypeError('network error'));
              },
            }),
          ),
      ),
    );
    await render({ src });
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.querySelector('img')!.getAttribute('src')).toBe(src);
    expect(host.querySelector('[data-gif-state]')!.getAttribute('data-gif-state')).toBe('native');
  });
  it('reveals the native image only after explicit play under reduced motion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await render({ src, reducedMotion: true });
    expect(host.querySelector('img')).toBeNull();
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('img')!.getAttribute('src')).toBe(src);
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('img')).toBeNull();
  });
  it('shows unavailable only when the native image itself errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await render({ src });
    await act(async () => {
      host.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[role="status"]')!.textContent).toBe('unavailable');
    expect(host.querySelector('[data-gif-state]')!.getAttribute('data-gif-state')).toBe('failed');
  });
});

describe('controlled GIF lifecycle (clock)', () => {
  it('never loads hidden media and uses a single clock for multiple visible mobile assets', async () => {
    await render({ visible: false });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <>
          <AnimatedGif {...props} />
          <AnimatedGif {...props} elementId="second" />
        </>,
      ),
    );
    expect(frames.size).toBe(1);
    await tick(0);
    await tick(110);
    expect(frames.size).toBe(1);
  });
});
