'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ReachDeckNativeElementV2 } from '@reachany/reach-deck-dsl';

type MediaElement = Extract<ReachDeckNativeElementV2, { type: 'audio' | 'video' }>;

/** Media controls live outside the scaled/clipped slide, leaving its canvas box draggable. */
export function NativeV2Media({
  element,
  source,
  poster,
  label,
  style,
  editable,
  passive,
  autoplayAllowed,
  overlayActive,
  onSelect,
}: {
  element: MediaElement;
  source?: string;
  poster?: string;
  label: string;
  style: CSSProperties;
  editable: boolean;
  passive: boolean;
  autoplayAllowed: boolean;
  overlayActive: boolean;
  onSelect?: (id: string) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoplayStarted = useRef(false);
  const savedPlayback = useRef<
    { time: number; rate: number; volume: number; muted: boolean; playing: boolean } | undefined
  >(undefined);
  const replacingSourceRef = useRef(false);
  const failedRef = useRef(false);
  const previousSourceRef = useRef(source);
  const snapshot = (media: HTMLMediaElement, playing = !media.paused) => {
    savedPlayback.current = {
      time: media.currentTime,
      rate: media.playbackRate,
      volume: media.volume,
      muted: media.muted,
      playing,
    };
  };
  const remember = (media: HTMLMediaElement, playing = !media.paused) => {
    if (replacingSourceRef.current || media.readyState === 0) return;
    snapshot(media, playing);
  };
  if (previousSourceRef.current !== source) {
    const media = mediaRef.current;
    if (media && !failedRef.current)
      snapshot(media, savedPlayback.current?.playing ?? !media.paused);
    replacingSourceRef.current = true;
    previousSourceRef.current = source;
  }
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320 });
  const popup = element.type === 'audio' || editable;
  const cancelClose = () => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
  };
  const show = () => {
    if (passive) return;
    cancelClose();
    setOpen(true);
  };
  const hide = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (
        popupRef.current?.contains(document.activeElement) ||
        anchorRef.current?.contains(document.activeElement)
      )
        return;
      setOpen(false);
    }, 180);
  };
  useEffect(() => {
    if (overlayActive) show();
    else hide();
    return cancelClose;
  }, [overlayActive, passive]);
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(element.type === 'video' ? 400 : 320, window.innerWidth - 16);
      const height =
        popupRef.current?.getBoundingClientRect().height ||
        (element.type === 'video' ? (width * 9) / 16 : 54);
      setPosition({
        width,
        left: Math.max(
          8,
          Math.min(window.innerWidth - width - 8, rect.left + (rect.width - width) / 2),
        ),
        top: Math.max(
          8,
          Math.min(
            window.innerHeight - height - 8,
            rect.top >= height + 16 ? rect.top - height - 8 : rect.bottom + 8,
          ),
        ),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer?.disconnect();
    };
  }, [open, element.type, style.left, style.top, style.width, style.height]);
  useEffect(() => {
    autoplayStarted.current = false;
    const media = mediaRef.current;
    return () => {
      try {
        if (media !== null && !navigator.userAgent.toLowerCase().includes('jsdom')) {
          media.pause();
        }
      } catch {
        // jsdom does not implement media pause; browsers do.
      }
      cancelClose();
    };
  }, [passive]);
  useEffect(() => {
    if (element.playback.autoplay && autoplayAllowed && !passive && !autoplayStarted.current) {
      autoplayStarted.current = true;
      void mediaRef.current?.play().catch(() => undefined);
    }
  }, [autoplayAllowed, element.playback.autoplay, source, passive]);
  const playback = element.playback;
  const mediaProps = {
    'aria-label': label,
    'data-native-v2-resource-id': element.resourceId,
    controls: true,
    loop: playback.loop,
    preload: 'metadata' as const,
    src: source,
    onError: (event: { currentTarget: HTMLMediaElement }) => {
      // Capture the actual failure position between media-clock updates. The browser may have
      // paused on failure, so keep the last intended playback state for the replacement source.
      if (!replacingSourceRef.current)
        snapshot(
          event.currentTarget,
          savedPlayback.current?.playing ?? !event.currentTarget.paused,
        );
      failedRef.current = true;
    },
    onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) => {
      const media = event.currentTarget;
      const saved = savedPlayback.current;
      media.currentTime = saved?.time ?? playback.startAt;
      media.volume = saved?.volume ?? playback.volume;
      if (saved) {
        media.playbackRate = saved.rate;
        media.muted = saved.muted;
      }
      replacingSourceRef.current = false;
      failedRef.current = false;
      if (saved?.playing) void media.play().catch(() => undefined);
    },
    onPlay: (event: { currentTarget: HTMLMediaElement }) => {
      const media = event.currentTarget;
      remember(media, true);
      if (
        media.currentTime < playback.startAt ||
        (playback.endAt !== undefined && media.currentTime >= playback.endAt)
      )
        media.currentTime = playback.startAt;
    },
    onPause: (event: { currentTarget: HTMLMediaElement }) => {
      if (event.currentTarget.readyState > 0) remember(event.currentTarget, false);
    },
    onRateChange: (event: { currentTarget: HTMLMediaElement }) => remember(event.currentTarget),
    onVolumeChange: (event: { currentTarget: HTMLMediaElement }) => remember(event.currentTarget),
    onTimeUpdate: (event: { currentTarget: HTMLMediaElement }) => {
      const media = event.currentTarget;
      if (replacingSourceRef.current || media.readyState === 0) return;
      remember(media);
      if (playback.endAt !== undefined && media.currentTime >= playback.endAt) {
        media.currentTime = playback.startAt;
        if (playback.loop) void media.play().catch(() => undefined);
        else media.pause();
      }
    },
  };
  const controls = passive ? null : element.type === 'audio' ? (
    <audio
      {...mediaProps}
      ref={(node) => {
        mediaRef.current = node;
      }}
      style={{ display: 'block', width: '100%' }}
    />
  ) : (
    <video
      {...mediaProps}
      ref={(node) => {
        mediaRef.current = node;
      }}
      playsInline
      poster={poster}
      style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
    />
  );
  return (
    <>
      <div
        ref={anchorRef}
        data-native-v2-element-id={element.id}
        data-native-v2-media={element.type}
        aria-label={label}
        role={popup && !passive ? 'button' : undefined}
        tabIndex={popup && !passive ? 0 : undefined}
        aria-expanded={popup && !passive ? open : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            cancelClose();
            setOpen(false);
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            show();
            onSelect?.(element.id);
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.(element.id);
          if (popup) show();
        }}
        style={{
          ...style,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: element.type === 'video' ? '#111827' : undefined,
        }}
      >
        {element.type === 'audio' ? (
          <>
            <svg
              aria-hidden="true"
              viewBox="0 0 72 72"
              style={{
                width: '100%',
                height: '100%',
                maxWidth: 72,
                maxHeight: 72,
                color: '#334155',
              }}
            >
              <rect
                x="2"
                y="2"
                width="68"
                height="68"
                rx="14"
                fill="#f1f5f9"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M14 29h10l13-11v36L24 43H14z" fill="currentColor" />
              <path
                d="M45 27q10 9 0 18M51 19q19 17 0 34"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
              />
            </svg>
          </>
        ) : popup || passive ? (
          <>
            {poster ? (
              <img
                src={poster}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : null}
            <svg
              aria-hidden="true"
              viewBox="0 0 48 48"
              style={{
                position: 'absolute',
                width: 48,
                height: 48,
                maxWidth: '80%',
                maxHeight: '80%',
              }}
            >
              <circle cx="24" cy="24" r="22" fill="#0f172acc" />
              <path d="m19 13 17 11-17 11z" fill="white" />
            </svg>
          </>
        ) : (
          controls
        )}
      </div>
      {popup && !passive && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popupRef}
              data-native-v2-element-id={element.id}
              data-native-v2-media-popover={element.id}
              onMouseEnter={show}
              onMouseLeave={hide}
              onFocus={show}
              onBlur={hide}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  cancelClose();
                  setOpen(false);
                  anchorRef.current?.focus();
                }
              }}
              style={{
                position: 'fixed',
                ...position,
                height: element.type === 'video' ? (position.width * 9) / 16 : undefined,
                zIndex: 100000,
                visibility: open ? 'visible' : 'hidden',
                pointerEvents: open ? 'auto' : 'none',
                borderRadius: 8,
                background: '#f1f5f9',
                boxShadow: '0 4px 18px #0004',
              }}
            >
              {controls}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
