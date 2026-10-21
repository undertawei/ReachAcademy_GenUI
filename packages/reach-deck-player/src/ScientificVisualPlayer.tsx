'use client';

import type {
  ReachDeckNativeSlideV2,
  ReachDeckScientificVisualElementV2,
} from '@reachany/reach-deck-dsl';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  SCIENTIFIC_VISUAL_INITIALIZATION_TIMEOUT_MS,
  SCIENTIFIC_VISUAL_MAX_CONCURRENT_RESOURCES,
  SCIENTIFIC_VISUAL_MAX_RESOURCE_BYTES,
  SCIENTIFIC_VISUAL_MAX_TOTAL_RESOURCE_BYTES,
  buildScientificVisualSrcDoc,
  createScientificVisualNonce,
  createScientificVisualWireMessage,
  parseScientificVisualWireMessage,
  projectScientificVisualFrame,
  type ScientificVisualPresentationFrame,
  type ScientificVisualViewport,
} from './scientificVisualBridge.js';

export interface ScientificVisualResolvedResource {
  bytes: ArrayBuffer;
  mimeType: string;
}

export type ScientificVisualResourceResolver = (
  resourceId: string,
) => Promise<ScientificVisualResolvedResource>;

export function createScientificVisualUrlResourceResolver(
  resourceUrlsById: Readonly<Record<string, string>>,
): ScientificVisualResourceResolver {
  return async (resourceId) => {
    const rawUrl = resourceUrlsById[resourceId];
    if (rawUrl === undefined || rawUrl.trim().length === 0) {
      throw new Error('Scientific resource URL is unavailable.');
    }
    const url = new URL(rawUrl, window.location.href);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) {
      throw new Error('Scientific resource URL protocol is unsupported.');
    }
    const response = await fetch(url, {
      credentials: url.origin === window.location.origin ? 'same-origin' : 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Scientific resource request failed.');
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > SCIENTIFIC_VISUAL_MAX_RESOURCE_BYTES) {
      throw new Error('Scientific resource exceeds its byte limit.');
    }
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
    if (response.body === null) {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > SCIENTIFIC_VISUAL_MAX_RESOURCE_BYTES) {
        throw new Error('Scientific resource exceeds its byte limit.');
      }
      return { bytes, mimeType };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > SCIENTIFIC_VISUAL_MAX_RESOURCE_BYTES) {
          await reader.cancel();
          throw new Error('Scientific resource exceeds its byte limit.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: combined.buffer, mimeType };
  };
}

export interface ScientificVisualPlayerProps {
  element: ReachDeckScientificVisualElementV2;
  slide: ReachDeckNativeSlideV2;
  sourceRevision?: number;
  currentTime?: number;
  playing?: boolean;
  playbackRate?: number;
  effectiveDuration?: number;
  activeNarrationSegmentId?: string;
  staticMode?: boolean;
  reducedMotion?: boolean;
  logicalWidth: number;
  logicalHeight: number;
  stageScale: number;
  dependencyBaseUrl?: string;
  resolveResource?: ScientificVisualResourceResolver;
  onPhaseChange?: (phase: 'loading' | 'active' | 'failed' | 'static') => void;
}

interface ScientificVisualController {
  present(frame: ScientificVisualPresentationFrame): void;
  resize(): void;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

export function ScientificVisualPlayer(props: ScientificVisualPlayerProps) {
  const {
    element,
    slide,
    sourceRevision = 1,
    currentTime,
    playing = false,
    playbackRate = 1,
    effectiveDuration,
    activeNarrationSegmentId,
    staticMode = false,
    reducedMotion = false,
    logicalWidth,
    logicalHeight,
    stageScale,
    dependencyBaseUrl,
    resolveResource,
    onPhaseChange,
  } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const controllerRef = useRef<ScientificVisualController | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'active' | 'failed'>('loading');
  const latestRef = useRef(props);
  latestRef.current = props;
  const identity = `${element.id}:${sourceRevision}:${element.documentHtml}:${JSON.stringify(
    element.manifest,
  )}`;

  // Reset before the iframe bootstrap can synchronously report bridge_ready/ready. Using a
  // passive effect here races a fast srcdoc: the layout effect mounts the iframe first, the child
  // can become ready, and the later passive reset would incorrectly put an active visual back into
  // loading forever.
  useLayoutEffect(() => {
    setAttempt(0);
    setPhase('loading');
  }, [identity]);

  const forceStatic = staticMode || reducedMotion;
  useEffect(() => {
    if (forceStatic) onPhaseChange?.('static');
  }, [forceStatic, onPhaseChange]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const nonce = createScientificVisualNonce();
    let disposed = false;
    let childSequence = 0;
    let parentSequence = 0;
    let bridgePhase: 'booting' | 'initializing' | 'active' | 'failed' = 'booting';
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let resourcePort: MessagePort | undefined;
    let concurrentResources = 0;
    let totalResourceBytes = 0;
    let firstAnimationFrame: number | undefined;
    let secondAnimationFrame: number | undefined;

    const setRuntimePhase = (next: 'loading' | 'active' | 'failed') => {
      if (disposed) return;
      setPhase(next);
      const latest = latestRef.current;
      latest.onPhaseChange?.(
        next === 'failed' ? 'failed' : latest.staticMode || latest.reducedMotion ? 'static' : next,
      );
    };
    const post = (type: string, payload: unknown, transfer: Transferable[] = []) => {
      frame.contentWindow?.postMessage(
        createScientificVisualWireMessage(nonce, ++parentSequence, type, payload),
        '*',
        transfer,
      );
    };
    const viewport = (): ScientificVisualViewport => {
      const bounds = frame.getBoundingClientRect();
      const latest = latestRef.current;
      return {
        logicalWidth: latest.logicalWidth,
        logicalHeight: latest.logicalHeight,
        stageScale: latest.stageScale,
        cssWidth: Math.max(0, bounds.width),
        cssHeight: Math.max(0, bounds.height),
        devicePixelRatio: Math.max(1, window.devicePixelRatio || 1),
      };
    };
    const framePayload = () =>
      projectScientificVisualFrame({
        slide: latestRef.current.slide,
        element: latestRef.current.element,
        currentTime: latestRef.current.currentTime,
        playing: latestRef.current.playing,
        playbackRate: latestRef.current.playbackRate,
        effectiveDuration: latestRef.current.effectiveDuration,
        activeNarrationSegmentId: latestRef.current.activeNarrationSegmentId,
        reducedMotion: latestRef.current.reducedMotion,
        staticMode: latestRef.current.staticMode,
      });
    const fail = () => {
      if (disposed || bridgePhase === 'failed') return;
      bridgePhase = 'failed';
      clearTimeout(watchdog);
      watchdog = undefined;
      resourcePort?.close();
      resourcePort = undefined;
      if (attempt < 1) {
        setAttempt((current) => current + 1);
      } else {
        setRuntimePhase('failed');
      }
    };
    const resyncCompositor = () => {
      firstAnimationFrame = requestAnimationFrame(() => {
        secondAnimationFrame = requestAnimationFrame(() => {
          if (disposed || !frame.isConnected) return;
          const display = frame.style.display;
          frame.style.display = 'none';
          void frame.offsetHeight;
          frame.style.display = display;
        });
      });
    };
    const handleResourceMessage = async (event: MessageEvent) => {
      const message = event.data;
      if (
        disposed ||
        !message ||
        message.type !== 'resolve' ||
        !Number.isSafeInteger(message.requestId) ||
        typeof message.id !== 'string' ||
        !element.manifest.resourceIds.includes(message.id)
      ) {
        return;
      }
      if (
        resolveResource === undefined ||
        concurrentResources >= SCIENTIFIC_VISUAL_MAX_CONCURRENT_RESOURCES
      ) {
        resourcePort?.postMessage({ type: 'rejected', requestId: message.requestId });
        return;
      }
      concurrentResources += 1;
      try {
        const resolved = await resolveResource(message.id);
        if (disposed) return;
        const bytes = resolved.bytes.slice(0);
        if (
          bytes.byteLength > SCIENTIFIC_VISUAL_MAX_RESOURCE_BYTES ||
          totalResourceBytes + bytes.byteLength > SCIENTIFIC_VISUAL_MAX_TOTAL_RESOURCE_BYTES ||
          !isAllowedResourceMime(resolved.mimeType)
        ) {
          resourcePort?.postMessage({ type: 'rejected', requestId: message.requestId });
          return;
        }
        totalResourceBytes += bytes.byteLength;
        resourcePort?.postMessage(
          { type: 'resolved', requestId: message.requestId, bytes, mimeType: resolved.mimeType },
          [bytes],
        );
      } catch {
        if (!disposed)
          resourcePort?.postMessage({ type: 'rejected', requestId: message.requestId });
      } finally {
        concurrentResources -= 1;
      }
    };
    const handleMessage = (event: MessageEvent) => {
      if (disposed || event.source !== frame.contentWindow) return;
      const message = parseScientificVisualWireMessage(event.data, 'child');
      if (message === undefined || message.nonce !== nonce || message.sequence <= childSequence)
        return;
      childSequence = message.sequence;
      if (message.type === 'bridge_ready' && bridgePhase === 'booting') {
        bridgePhase = 'initializing';
        const channel = new MessageChannel();
        resourcePort = channel.port1;
        resourcePort.onmessage = handleResourceMessage;
        resourcePort.start();
        post('initialize', { sourceRevision }, [channel.port2]);
        return;
      }
      if (message.type === 'ready' && bridgePhase === 'initializing') {
        bridgePhase = 'active';
        clearTimeout(watchdog);
        watchdog = undefined;
        frame.dataset.scientificReady = 'true';
        post('resize', viewport());
        post('present', framePayload());
        if (document.visibilityState === 'hidden') post('suspend', {});
        setRuntimePhase('active');
        resyncCompositor();
        return;
      }
      if (message.type === 'error') fail();
    };
    const resize = () => bridgePhase === 'active' && post('resize', viewport());
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(frame);
    window.addEventListener('message', handleMessage);
    frame.dataset.scientificNonce = nonce;
    frame.dataset.scientificPhase = 'loading';
    frame.dataset.scientificReady = 'false';
    setRuntimePhase('loading');
    void buildScientificVisualSrcDoc({
      element,
      nonce,
      dependencyBaseUrl:
        dependencyBaseUrl ??
        (window.location.origin === 'null' ? 'http://localhost' : window.location.origin),
    })
      .then((srcDoc) => {
        if (disposed) return;
        frame.srcdoc = srcDoc;
        watchdog = setTimeout(fail, SCIENTIFIC_VISUAL_INITIALIZATION_TIMEOUT_MS);
      })
      .catch(fail);

    const controller: ScientificVisualController = {
      present: (nextFrame) => bridgePhase === 'active' && post('present', nextFrame),
      resize,
      suspend: () => bridgePhase === 'active' && post('suspend', {}),
      resume: () => {
        if (bridgePhase !== 'active') return;
        post('resume', {});
        post('resize', viewport());
        post('present', framePayload());
        resyncCompositor();
      },
      dispose: () => post('dispose', {}),
    };
    controllerRef.current = controller;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') controller.suspend();
      else controller.resume();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(watchdog);
      if (firstAnimationFrame !== undefined) cancelAnimationFrame(firstAnimationFrame);
      if (secondAnimationFrame !== undefined) cancelAnimationFrame(secondAnimationFrame);
      observer?.disconnect();
      window.removeEventListener('message', handleMessage);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      controller.dispose();
      resourcePort?.close();
      if (controllerRef.current === controller) controllerRef.current = undefined;
      queueMicrotask(() => {
        if (frame.dataset.scientificNonce === nonce) {
          frame.dataset.scientificReady = 'false';
          frame.srcdoc = '';
        }
      });
    };
  }, [attempt, dependencyBaseUrl, identity, resolveResource, sourceRevision]);

  useLayoutEffect(() => {
    if (phase !== 'active') return;
    controllerRef.current?.present(
      projectScientificVisualFrame({
        slide,
        element,
        currentTime,
        playing,
        playbackRate,
        effectiveDuration,
        activeNarrationSegmentId,
        reducedMotion,
        staticMode,
      }),
    );
  }, [
    activeNarrationSegmentId,
    currentTime,
    effectiveDuration,
    element,
    forceStatic,
    phase,
    playbackRate,
    playing,
    reducedMotion,
    slide,
    staticMode,
  ]);

  useLayoutEffect(() => {
    if (phase !== 'active') return;
    controllerRef.current?.resize();
  }, [forceStatic, logicalHeight, logicalWidth, phase, stageScale]);

  useEffect(() => {
    const present = (printing: boolean) => {
      const latest = latestRef.current;
      controllerRef.current?.present(
        projectScientificVisualFrame({
          slide: latest.slide,
          element: latest.element,
          currentTime: printing ? 0 : latest.currentTime,
          playing: printing ? false : latest.playing,
          playbackRate: latest.playbackRate,
          effectiveDuration: latest.effectiveDuration,
          activeNarrationSegmentId: printing ? undefined : latest.activeNarrationSegmentId,
          reducedMotion: printing ? true : latest.reducedMotion,
          staticMode: printing ? true : latest.staticMode,
        }),
      );
    };
    const handleBeforePrint = () => present(true);
    const handleAfterPrint = () => present(false);
    window.addEventListener('beforeprint', handleBeforePrint);
    window.addEventListener('afterprint', handleAfterPrint);
    return () => {
      window.removeEventListener('beforeprint', handleBeforePrint);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
  }, []);

  return (
    <div
      aria-label={element.manifest.ariaLabel}
      className="scientific-visual-player"
      data-scientific-phase={phase === 'failed' ? 'failed' : forceStatic ? 'static' : phase}
      data-scientific-runtime-phase={phase}
      role="img"
    >
      <iframe
        aria-hidden="true"
        className="scientific-visual-player__frame"
        data-scientific-frame
        ref={frameRef}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        tabIndex={-1}
        title=""
      />
      {phase === 'failed' ? (
        <div className="scientific-visual-player__error" data-scientific-error role="alert">
          <strong>科学可视化加载失败 / Scientific visual failed to load</strong>
          <span>{element.manifest.textAlternative}</span>
        </div>
      ) : null}
      <span className="scientific-visual-player__text-alternative">
        {element.manifest.textAlternative}
      </span>
    </div>
  );
}

function isAllowedResourceMime(value: string): boolean {
  const mimeType = value.trim().toLowerCase();
  return (
    /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/.test(mimeType) ||
    /^(?:font|application)\/(?:woff2?|font-woff|json|octet-stream)$/.test(mimeType) ||
    /^text\/(?:plain|csv)$/.test(mimeType)
  );
}
