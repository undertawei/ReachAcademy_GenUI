'use client';

import { useEffect, useRef, useState, type CSSProperties, type MouseEventHandler } from 'react';
import { createGifCompositor, parseGif, type GifAnimation } from './gifFrames.js';

// One browser animation clock serializes all visible GIF frame work; no per-GIF timers or RGBA caches.
const animations = new Set<(time: number) => void>();
let animationFrame: number | undefined;
function subscribeAnimation(tick: (time: number) => void) {
  animations.add(tick);
  const frame = (time: number) => {
    for (const animation of animations) animation(time);
    animationFrame = animations.size ? requestAnimationFrame(frame) : undefined;
  };
  if (animationFrame === undefined) animationFrame = requestAnimationFrame(frame);
  return () => {
    animations.delete(tick);
    if (!animations.size && animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
  };
}

export interface AnimatedGifProps {
  src: string;
  alt: string;
  visible: boolean;
  playing: boolean;
  staticMode: boolean;
  reducedMotion: boolean;
  controlLabel: (action: 'play' | 'pause' | 'unavailable') => string;
  style?: CSSProperties;
  onClick?: MouseEventHandler<HTMLDivElement>;
  elementId: string;
  resourceId: string;
  fit: 'cover' | 'contain' | 'stretch';
}

/**
 * Frame-accurate GIF playback: bytes are fetched and decoded so the player controls frame zero,
 * pause and restart. When the bytes cannot be read (cross-origin URL without CORS, network error,
 * oversized or undecodable payload) we fall back to a native `<img>` of the same URL, which the
 * browser can still display and animate. Native playback trade-offs:
 * - it cannot hold frame zero or pause, so staticMode/editor preview and `playing=false` still show
 *   the (animating) image — visible content beats an empty card;
 * - reduced motion must not auto-animate, so the image is only revealed after the explicit play
 *   button and removed again on pause;
 * - the `<img>` is only mounted while visible/on screen and unmounted otherwise, so re-entry restarts it.
 * 'unavailable' is reserved for the case where the native image itself errors.
 */
export function AnimatedGif(props: AnimatedGifProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [animation, setAnimation] = useState<GifAnimation>();
  // src whose bytes could not be fetched/decoded; a different src retries the decoded path.
  const [nativeSrc, setNativeSrc] = useState<string>();
  const [nativeFailedSrc, setNativeFailedSrc] = useState<string>();
  const native = nativeSrc === props.src;
  const failed = native && nativeFailedSrc === props.src;
  const [manual, setManual] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(true);
  const state = useRef<
    | {
        draw: ReturnType<typeof createGifCompositor>;
        index: number;
        elapsed: number;
        last?: number;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    const node = wrapper.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) =>
      setOnScreen(entry?.isIntersecting ?? false),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!props.visible || !onScreen) {
      setAnimation(undefined);
      state.current = undefined;
      setManual(false);
      // Re-entry retries a native image that errored earlier.
      setNativeFailedSrc(undefined);
      return;
    }
    if (native) return;
    const controller = new AbortController();
    // Only effect cleanup is a cancellation: a failed body read also aborts the request to stop
    // the download, and that failure must still reach the native fallback.
    let cancelled = false;
    const src = props.src;
    void fetch(props.src, { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('GIF load failed');
        if (Number(response.headers.get('content-length') ?? 0) > 10 * 1024 * 1024)
          throw new Error('GIF byte budget exceeded');
        if (!response.body) throw new Error('GIF response body unavailable');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 10 * 1024 * 1024) throw new Error('GIF byte budget exceeded');
            chunks.push(value);
          }
        } catch (error) {
          controller.abort();
          await reader.cancel(error).catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (!cancelled) setAnimation(parseGif(bytes));
      })
      .catch(() => {
        if (!cancelled) setNativeSrc(src);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.src, props.visible, onScreen, native]);
  useEffect(() => {
    if (!animation) return;
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const draw = createGifCompositor(animation);
    state.current = { draw, index: 0, elapsed: 0 };
    try {
      context.putImageData(new ImageData(draw(0), animation.width, animation.height), 0, 0);
    } catch {
      state.current = undefined;
      setAnimation(undefined);
      setNativeSrc(props.src);
    }
  }, [animation, props.reducedMotion, props.staticMode, props.src]);
  const play =
    props.visible &&
    onScreen &&
    documentVisible &&
    !props.staticMode &&
    (props.reducedMotion ? manual : props.playing);
  useEffect(() => {
    if (!play || !animation || native) {
      if (state.current) state.current.last = undefined;
      return;
    }
    return subscribeAnimation((now) => {
      const current = state.current,
        context = canvas.current?.getContext('2d');
      if (!current || !context) return;
      const elapsed = current.last === undefined ? 0 : Math.max(0, now - current.last);
      current.last = now;
      current.elapsed += elapsed;
      // Do not burst-decode after a long main-thread stall; resume the next exact frame.
      if (current.elapsed < animation.frames[current.index]!.delayMs) return;
      current.elapsed = 0;
      current.index = (current.index + 1) % animation.frames.length;
      try {
        context.putImageData(
          new ImageData(current.draw(current.index), animation.width, animation.height),
          0,
          0,
        );
      } catch {
        state.current = undefined;
        setAnimation(undefined);
        setNativeSrc(props.src);
      }
    });
  }, [animation, play, native, props.src]);
  const fitStyle = props.fit === 'stretch' ? 'fill' : props.fit;
  const showNative =
    native &&
    !failed &&
    props.visible &&
    onScreen &&
    (props.staticMode || !props.reducedMotion || manual);
  return (
    <div
      data-native-v2-element-id={props.elementId}
      data-native-v2-resource-id={props.resourceId}
      ref={wrapper}
      data-gif-state={failed ? 'failed' : native ? 'native' : play ? 'playing' : 'paused'}
      style={{ position: 'relative', ...props.style }}
      onClick={props.onClick}
    >
      {native ? (
        showNative ? (
          <img
            src={props.src}
            alt={props.alt}
            draggable={false}
            onError={() => setNativeFailedSrc(props.src)}
            style={{ width: '100%', height: '100%', objectFit: fitStyle, display: 'block' }}
          />
        ) : null
      ) : (
        <canvas
          ref={canvas}
          role="img"
          aria-label={props.alt}
          width={animation?.width ?? 1}
          height={animation?.height ?? 1}
          style={{ width: '100%', height: '100%', objectFit: fitStyle, display: 'block' }}
        />
      )}
      {failed ? <span role="status">{props.controlLabel('unavailable')}</span> : null}
      {props.reducedMotion && !props.staticMode && props.visible && !failed ? (
        <button
          type="button"
          aria-label={props.controlLabel(manual ? 'pause' : 'play')}
          style={{ position: 'absolute', right: 4, bottom: 4 }}
          onClick={(event) => {
            event.stopPropagation();
            setManual((value) => !value);
          }}
        >
          {props.controlLabel(manual ? 'pause' : 'play')}
        </button>
      ) : null}
    </div>
  );
}
