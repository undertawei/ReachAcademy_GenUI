'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { InteractiveScene } from '@reachany/reach-deck-dsl';
import {
  buildInteractiveSrcDoc,
  createInteractiveNonce,
  createWireMessage,
  isBoundedJson,
  parseInteractiveWireMessage,
  validateGeometryEditProposalAgainstDocument,
  validateInteractiveComponentFocusAgainstDocument,
  validateInteractiveChildMessage,
  validateInteractiveLearningEvent,
  type InteractiveBridgePhase,
  type InteractiveComponentFocus,
  type GeometryEditProposal,
  type GeometryHostMode,
  type ValidatedInteractiveLearningEvent,
} from './interactiveBridge.js';
import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';
import { resolveGeometryMessages } from './geometryMessages.js';

export const INTERACTIVE_INITIALIZATION_TIMEOUT_MS = 10_000;
export const INTERACTIVE_STATE_FLUSH_TIMEOUT_MS = 1_000;

export interface InteractiveScenePlayerProps {
  scene: InteractiveScene;
  /** Stable owning Reach Deck page id; standalone callers default to the scene id. */
  pageId?: string;
  visible?: boolean;
  sourceRevision?: number;
  attempt?: number;
  restoredSnapshot?: unknown;
  translate?: ReachDeckTranslate;
  locale?: string;
  /** Origin that serves the content-addressed built-in science kit runtimes. */
  dependencyBaseUrl?: string;
  /** Enables selection of explicitly marked components for the teacher authoring host only. */
  authoring?: boolean;
  /** Selects isolated learner/trial state or controlled teacher geometry edit proposals. */
  geometryHostMode?: GeometryHostMode;
  onPhaseChange?: (phase: InteractiveBridgePhase) => void;
  onReady?: (payload: unknown) => void;
  onStateChange?: (snapshot: unknown) => void;
  onComplete?: (payload: unknown) => void;
  onReset?: (attempt: number) => void;
  onInteraction?: (event: ValidatedInteractiveLearningEvent) => void;
  onComponentFocus?: (focus: InteractiveComponentFocus) => void;
  onGeometryEditProposal?: (proposal: GeometryEditProposal) => void;
  onError?: (error: { code: string; detail?: unknown }) => void;
}

interface InteractiveBridgeController {
  setVisible: (visible: boolean) => void;
  flushState: () => Promise<boolean>;
  releaseFlush: () => void;
}

const viewportFor = (frame: HTMLIFrameElement) => ({
  width: Math.max(0, Math.round(frame.getBoundingClientRect().width)),
  height: Math.max(0, Math.round(frame.getBoundingClientRect().height)),
});

const snapshotIdentity = (snapshot: unknown): string | undefined => {
  if (!isBoundedJson(snapshot)) return undefined;
  return JSON.stringify(snapshot, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : value,
  );
};

export const InteractiveScenePlayer = ({
  scene,
  pageId = scene.id,
  visible = true,
  sourceRevision = 1,
  attempt = 1,
  restoredSnapshot,
  translate,
  locale = 'en-US',
  dependencyBaseUrl,
  authoring = false,
  geometryHostMode = 'learner',
  onPhaseChange,
  onReady,
  onStateChange,
  onComplete,
  onReset,
  onInteraction,
  onComponentFocus,
  onGeometryEditProposal,
  onError,
}: InteractiveScenePlayerProps) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [initializationFailed, setInitializationFailed] = useState(false);
  // Polling, saves and signed-media refreshes reconstruct the scene's JSON objects.
  // Their identities must not restart an otherwise unchanged interactive document.
  const manifestIdentity = snapshotIdentity(scene.eventManifest) ?? scene.eventManifest;
  const dependencyIdentity =
    snapshotIdentity(scene.runtimeDependencies ?? []) ?? scene.runtimeDependencies;
  const requestedLocalization = JSON.stringify({
    locale,
    messages: resolveGeometryMessages(translate),
  });
  const [appliedLocalization, setAppliedLocalization] = useState(requestedLocalization);
  const propSnapshotIdentity = snapshotIdentity(restoredSnapshot);
  const snapshotRef = useRef({
    sceneId: scene.id,
    documentHtml: scene.documentHtml,
    sourceRevision,
    attempt,
    propSnapshotIdentity,
    snapshot: restoredSnapshot,
  });
  const previousSnapshot = snapshotRef.current;
  if (
    previousSnapshot.sceneId !== scene.id ||
    previousSnapshot.documentHtml !== scene.documentHtml ||
    previousSnapshot.sourceRevision !== sourceRevision ||
    previousSnapshot.attempt !== attempt ||
    previousSnapshot.propSnapshotIdentity !== propSnapshotIdentity
  ) {
    snapshotRef.current = {
      sceneId: scene.id,
      documentHtml: scene.documentHtml,
      sourceRevision,
      attempt,
      propSnapshotIdentity,
      snapshot: restoredSnapshot,
    };
  }
  const visibleRef = useRef(visible);
  const bridgeControllerRef = useRef<InteractiveBridgeController | undefined>(undefined);
  const latestRef = useRef({
    attempt,
    restoredSnapshot: snapshotRef.current.snapshot,
    onPhaseChange,
    onReady,
    onStateChange,
    onComplete,
    onReset,
    onInteraction,
    onComponentFocus,
    onGeometryEditProposal,
    onError,
  });
  visibleRef.current = visible;
  latestRef.current = {
    attempt,
    restoredSnapshot: snapshotRef.current.snapshot,
    onPhaseChange,
    onReady,
    onStateChange,
    onComplete,
    onReset,
    onInteraction,
    onComponentFocus,
    onGeometryEditProposal,
    onError,
  };

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    setInitializationFailed(false);
    const nonce = createInteractiveNonce();
    const localization = JSON.parse(appliedLocalization) as {
      locale: string;
      messages: ReturnType<typeof resolveGeometryMessages>;
    };
    let srcDoc: string;
    try {
      srcDoc = buildInteractiveSrcDoc({
        documentHtml: scene.documentHtml,
        nonce,
        allowReset: scene.runtimePolicy.allowReset,
        eventManifest: scene.eventManifest,
        runtimeDependencies: scene.runtimeDependencies,
        dependencyBaseUrl,
        authoring,
        geometryHostMode,
        pageId,
        sourceRevision,
        locale: localization.locale,
        geometryMessages: localization.messages,
      });
    } catch {
      frame.srcdoc = '';
      frame.dataset.bridgePhase = 'failed';
      frame.dataset.errorCode = 'invalid_scene_document';
      setInitializationFailed(true);
      latestRef.current.onPhaseChange?.('failed');
      latestRef.current.onError?.({ code: 'invalid_scene_document' });
      return;
    }
    let phase: InteractiveBridgePhase = 'booting';
    let childSequence = 0;
    let parentSequence = 0;
    let currentAttempt = latestRef.current.attempt;
    let completed = false;
    let disposed = false;
    let firstAnimationFrame: number | undefined;
    let secondAnimationFrame: number | undefined;
    let compositorResyncScheduled = false;
    let initializationWatchdog: ReturnType<typeof setTimeout> | undefined;
    let initializationBudget = INTERACTIVE_INITIALIZATION_TIMEOUT_MS;
    let initializationStartedAt: number | undefined;
    let heartbeatId = 0;
    let staleDocumentReloaded = false;
    let flushLocked = false;
    let releaseAfterFlush = false;
    let pendingFlush:
      | {
          id: number;
          promise: Promise<boolean>;
          resolve: (success: boolean) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    const lastImmediateAt = new Map<string, number>();
    const pendingLatest = new Map<string, ValidatedInteractiveLearningEvent>();
    const latestTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const deliveredAt: number[] = [];
    const componentFocusDeliveredAt: number[] = [];
    const restoreToken = createInteractiveNonce();

    const setPhase = (next: InteractiveBridgePhase) => {
      phase = next;
      if (next === 'active' || next === 'failed' || next === 'disposed') {
        clearTimeout(initializationWatchdog);
        initializationWatchdog = undefined;
        initializationStartedAt = undefined;
      }
      frame.dataset.bridgePhase = next;
      latestRef.current.onPhaseChange?.(next);
    };
    const post = (type: string, payload: unknown) => {
      frame.contentWindow?.postMessage(
        createWireMessage(nonce, ++parentSequence, type, payload),
        '*',
      );
    };
    const cancelCompositorResync = () => {
      if (firstAnimationFrame !== undefined) cancelAnimationFrame(firstAnimationFrame);
      if (secondAnimationFrame !== undefined) cancelAnimationFrame(secondAnimationFrame);
      firstAnimationFrame = undefined;
      secondAnimationFrame = undefined;
      compositorResyncScheduled = false;
    };
    const dispose = (next: 'disposed' | 'failed', error?: { code: string; detail?: unknown }) => {
      if (disposed) return;
      disposed = true;
      if (pendingFlush) {
        clearTimeout(pendingFlush.timer);
        pendingFlush.resolve(false);
        pendingFlush = undefined;
      }
      cancelCompositorResync();
      latestTimers.forEach((timer) => clearTimeout(timer));
      latestTimers.clear();
      pendingLatest.clear();
      frame.dataset.disposeReason = next;
      if (error) frame.dataset.errorCode = error.code;
      post('dispose', {});
      setPhase(next);
      if (error) latestRef.current.onError?.(error);
      if (next === 'disposed') {
        // Defer the destructive clear so a StrictMode-driven synchronous
        // remount (mount -> cleanup -> mount, all before paint) can claim
        // the frame first. If a newer effect instance has already taken
        // over by the time this microtask runs, its nonce will already be
        // recorded on the frame, so skip clearing to avoid racing its
        // freshly assigned srcdoc.
        queueMicrotask(() => {
          if (frame.dataset.bridgeNonce === nonce) frame.srcdoc = '';
        });
      }
    };
    const reportError = (code: string, detail?: unknown) => {
      frame.dataset.errorCode = code;
      latestRef.current.onError?.({ code, detail });
    };
    const updateInitializationWatchdog = () => {
      if (initializationStartedAt !== undefined) {
        initializationBudget = Math.max(
          0,
          initializationBudget - (performance.now() - initializationStartedAt),
        );
        initializationStartedAt = undefined;
      }
      clearTimeout(initializationWatchdog);
      initializationWatchdog = undefined;
      if (disposed || phase === 'active' || !visibleRef.current || document.hidden) return;
      initializationStartedAt = performance.now();
      initializationWatchdog = setTimeout(() => {
        // Background timers can run before visibilitychange is delivered.
        if (!visibleRef.current || document.hidden) {
          initializationStartedAt = undefined;
          initializationWatchdog = undefined;
          return;
        }
        if (disposed || phase === 'active') return;
        setInitializationFailed(true);
        dispose('failed', { code: 'initialization_timeout' });
      }, initializationBudget);
    };
    const underPageRateLimit = (now: number) => {
      while (deliveredAt.length > 0 && now - deliveredAt[0]! >= 60_000) deliveredAt.shift();
      return deliveredAt.length < 120;
    };
    const deliverLearningEvent = (event: ValidatedInteractiveLearningEvent) => {
      const now = Date.now();
      if (!underPageRateLimit(now)) return false;
      deliveredAt.push(now);
      latestRef.current.onInteraction?.(event);
      return true;
    };
    const acceptLearningEvent = (event: ValidatedInteractiveLearningEvent) => {
      const declaration = scene.eventManifest.events.find(
        (candidate) => candidate.name === event.name,
      );
      if (declaration === undefined) return false;
      const now = Date.now();
      if (!underPageRateLimit(now)) return false;
      if (declaration.delivery.mode === 'immediate') {
        const previous = lastImmediateAt.get(event.name);
        if (previous !== undefined && now - previous < 250) return false;
        lastImmediateAt.set(event.name, now);
        return deliverLearningEvent(event);
      }
      pendingLatest.set(event.name, event);
      if (!latestTimers.has(event.name)) {
        latestTimers.set(
          event.name,
          setTimeout(() => {
            latestTimers.delete(event.name);
            const latest = pendingLatest.get(event.name);
            pendingLatest.delete(event.name);
            if (latest !== undefined && !disposed && visibleRef.current)
              deliverLearningEvent(latest);
          }, declaration.delivery.intervalMs),
        );
      }
      return true;
    };
    // Some Chromium builds can fail to attach the first compositor surface for
    // an opaque-origin iframe. This is an implementation-specific recovery,
    // not a guarantee that the iframe has its own renderer process.
    const forceCompositorResync = () => {
      if (disposed || !frame.isConnected) return;
      if (!visibleRef.current) {
        frame.dataset.compositorResyncState = 'pending';
        return;
      }
      if (compositorResyncScheduled) return;
      compositorResyncScheduled = true;
      frame.dataset.compositorResyncState = 'scheduled';
      firstAnimationFrame = requestAnimationFrame(() => {
        firstAnimationFrame = undefined;
        secondAnimationFrame = requestAnimationFrame(() => {
          secondAnimationFrame = undefined;
          compositorResyncScheduled = false;
          if (disposed || !frame.isConnected) return;
          if (!visibleRef.current) {
            frame.dataset.compositorResyncState = 'pending';
            return;
          }
          const previousDisplay = frame.style.display;
          frame.style.display = 'none';
          void frame.offsetHeight;
          frame.style.display = previousDisplay;
          frame.dataset.compositorResyncCount = String(
            Number(frame.dataset.compositorResyncCount ?? 0) + 1,
          );
          frame.dataset.compositorResyncState = 'complete';
        });
      });
    };
    const bridgeController: InteractiveBridgeController = {
      setVisible: (nextVisible) => {
        updateInitializationWatchdog();
        if (disposed || phase !== 'active') return;
        if (!nextVisible) {
          post('suspend', {});
          frame.dataset.compositorResyncState = 'pending';
          return;
        }
        if (flushLocked) return;
        post('resume', {});
        post('resize', viewportFor(frame));
        forceCompositorResync();
      },
      flushState: () => {
        releaseAfterFlush = false;
        if (disposed || phase === 'failed') return Promise.resolve(false);
        if (phase !== 'active') return Promise.resolve(true);
        if (pendingFlush) return pendingFlush.promise;
        if (flushLocked) return Promise.resolve(true);
        flushLocked = true;
        const id = ++heartbeatId;
        let resolve!: (success: boolean) => void;
        const promise = new Promise<boolean>((done) => {
          resolve = done;
        });
        const timer = setTimeout(() => {
          setInitializationFailed(true);
          dispose('failed', { code: 'state_flush_timeout' });
        }, INTERACTIVE_STATE_FLUSH_TIMEOUT_MS);
        pendingFlush = { id, promise, resolve, timer };
        post('ping', { heartbeatId: id, flushState: true });
        return promise;
      },
      releaseFlush: () => {
        if (disposed || !flushLocked) return;
        if (pendingFlush) {
          releaseAfterFlush = true;
          return;
        }
        flushLocked = false;
        post('resume', {});
        if (!visibleRef.current) post('suspend', {});
      },
    };
    bridgeControllerRef.current = bridgeController;

    const handleMessage = (event: MessageEvent) => {
      if (
        disposed ||
        event.source !== frame.contentWindow ||
        (event.origin !== 'null' && event.origin !== '')
      )
        return;
      const message = parseInteractiveWireMessage(event.data);
      if (!message) return;
      if (message.nonce !== nonce) {
        // Two srcdoc assignments in one task (StrictMode remount, or a dependency change
        // before the first document loaded) can leave the frame on the earlier document:
        // the browser sometimes drops the second navigation, and that document's nonce
        // never matches, so the handshake would stall until the watchdog fails it. A stale
        // bridge_ready while still booting proves the frame runs an old document; reassign
        // the current srcdoc once to force it onto this setup's document.
        if (message.type === 'bridge_ready' && phase === 'booting' && !staleDocumentReloaded) {
          staleDocumentReloaded = true;
          frame.dataset.staleDocumentReloaded = 'true';
          frame.srcdoc = srcDoc;
        }
        return;
      }
      if (message.sequence <= childSequence) return;
      childSequence = message.sequence;

      const validation = validateInteractiveChildMessage(message, phase);
      if (validation !== 'valid' || message.type === 'navigation') return;

      if (message.type === 'bridge_ready' && phase === 'booting') {
        const restored = latestRef.current.restoredSnapshot;
        const safeRestored =
          restored !== undefined && isBoundedJson(restored) ? restored : undefined;
        setPhase('bridge_ready');
        setPhase('initializing');
        post('initialize', {
          sceneId: scene.id,
          sourceRevision,
          viewport: viewportFor(frame),
          policy: scene.runtimePolicy,
          attempt: currentAttempt,
          ...(safeRestored === undefined ? {} : { restoredSnapshot: safeRestored, restoreToken }),
        });
        return;
      }
      if (message.type === 'ready' && phase === 'initializing') {
        frame.dataset.bridgeRestored = String(
          typeof message.payload === 'object' &&
            message.payload !== null &&
            (message.payload as { restored?: unknown }).restored === true,
        );
        setPhase('active');
        latestRef.current.onReady?.(message.payload);
        if (visibleRef.current) forceCompositorResync();
        else {
          post('suspend', {});
          frame.dataset.compositorResyncState = 'pending';
        }
        return;
      }
      if (message.type === 'error') {
        const code = (message.payload as { code?: unknown })?.code;
        if (code === 'geometry_renderer_unavailable' || code === 'geometry_mount_failed') {
          setInitializationFailed(true);
          dispose('failed', { code });
          return;
        }
        reportError('child_error', message.payload);
        return;
      }
      if (phase !== 'active') return;
      if (
        !visibleRef.current &&
        message.type !== 'pong' &&
        !(pendingFlush && message.type === 'stateChange')
      )
        return;

      switch (message.type) {
        case 'pong': {
          if (
            pendingFlush &&
            (message.payload as { heartbeatId: number }).heartbeatId === pendingFlush.id
          ) {
            const completedFlush = pendingFlush;
            clearTimeout(completedFlush.timer);
            pendingFlush = undefined;
            completedFlush.resolve(true);
            if (releaseAfterFlush) bridgeController.releaseFlush();
          }
          break;
        }
        case 'stateChange':
          if (!isBoundedJson(message.payload)) reportError('invalid_snapshot');
          else {
            snapshotRef.current.snapshot = message.payload;
            latestRef.current.restoredSnapshot = message.payload;
            latestRef.current.onStateChange?.(message.payload);
          }
          break;
        case 'complete':
          if (!completed && scene.runtimePolicy.completionMode !== 'none') {
            completed = true;
            latestRef.current.onComplete?.(message.payload);
          }
          break;
        case 'reset': {
          const nextAttempt = (message.payload as Record<string, unknown>)?.attempt;
          if (!scene.runtimePolicy.allowReset || nextAttempt !== currentAttempt + 1) {
            reportError('invalid_reset');
            break;
          }
          currentAttempt = nextAttempt as number;
          completed = false;
          latestRef.current.onReset?.(currentAttempt);
          break;
        }
        case 'interaction': {
          const learningEvent = validateInteractiveLearningEvent(
            message.payload,
            scene.eventManifest,
            message.sequence,
          );
          if (learningEvent !== undefined) acceptLearningEvent(learningEvent);
          break;
        }
        case 'component_focus': {
          if (!authoring) break;
          const now = Date.now();
          while (
            componentFocusDeliveredAt.length > 0 &&
            now - componentFocusDeliveredAt[0]! >= 60_000
          )
            componentFocusDeliveredAt.shift();
          if (
            componentFocusDeliveredAt.length >= 30 ||
            (componentFocusDeliveredAt.length > 0 &&
              now - componentFocusDeliveredAt[componentFocusDeliveredAt.length - 1]! < 100)
          )
            break;
          const focus = validateInteractiveComponentFocusAgainstDocument({
            payload: message.payload,
            documentHtml: scene.documentHtml,
            pageId,
            sourceRevision,
            wireSequence: message.sequence,
          });
          if (focus === undefined) break;
          componentFocusDeliveredAt.push(now);
          latestRef.current.onComponentFocus?.(focus);
          break;
        }
        case 'geometry_edit_proposal': {
          if (geometryHostMode !== 'authoring-edit') break;
          const proposal = validateGeometryEditProposalAgainstDocument({
            payload: message.payload,
            documentHtml: scene.documentHtml,
            pageId,
            sourceRevision,
            wireSequence: message.sequence,
          });
          if (proposal !== undefined) latestRef.current.onGeometryEditProposal?.(proposal);
          break;
        }
      }
    };

    const resize = () =>
      phase === 'active' && visibleRef.current && post('resize', viewportFor(frame));
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(frame);
    window.addEventListener('message', handleMessage);
    document.addEventListener('visibilitychange', updateInitializationWatchdog);
    delete frame.dataset.errorCode;
    delete frame.dataset.disposeReason;
    delete frame.dataset.effectCleanup;
    delete frame.dataset.compositorResyncCount;
    delete frame.dataset.staleDocumentReloaded;
    frame.dataset.bridgeNonce = nonce;
    frame.dataset.bridgePhase = 'booting';
    frame.dataset.compositorResyncState = 'idle';
    frame.srcdoc = srcDoc;
    latestRef.current.onPhaseChange?.('booting');
    updateInitializationWatchdog();

    return () => {
      observer?.disconnect();
      window.removeEventListener('message', handleMessage);
      document.removeEventListener('visibilitychange', updateInitializationWatchdog);
      if (bridgeControllerRef.current === bridgeController) bridgeControllerRef.current = undefined;
      frame.dataset.effectCleanup = 'true';
      dispose('disposed');
    };
  }, [
    scene.bridgeVersion,
    scene.documentHtml,
    manifestIdentity,
    scene.id,
    dependencyIdentity,
    scene.runtimePolicy.allowReset,
    scene.runtimePolicy.completionMode,
    scene.runtimePolicy.maximumDurationSeconds,
    sourceRevision,
    pageId,
    restartKey,
    authoring,
    geometryHostMode,
    dependencyBaseUrl,
    appliedLocalization,
  ]);

  useLayoutEffect(() => {
    const controller = bridgeControllerRef.current;
    if (requestedLocalization === appliedLocalization) {
      controller?.releaseFlush();
      return;
    }
    let cancelled = false;
    if (controller) {
      void controller.flushState().then((success) => {
        if (success && !cancelled && bridgeControllerRef.current === controller)
          setAppliedLocalization(requestedLocalization);
      });
    } else setAppliedLocalization(requestedLocalization);
    return () => {
      cancelled = true;
    };
  }, [
    requestedLocalization,
    appliedLocalization,
    restartKey,
    scene.id,
    scene.documentHtml,
    sourceRevision,
  ]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.style.visibility = visible ? 'visible' : 'hidden';
    frame.dataset.repaintState = visible ? 'visible' : 'hidden';
    bridgeControllerRef.current?.setVisible(visible);
  }, [visible]);

  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  return (
    <div className="interactive-scene-player-shell">
      <iframe
        ref={frameRef}
        className="interactive-scene-player"
        title={scene.title}
        aria-label={scene.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        data-scene-id={scene.id}
        data-visible={visible ? 'true' : 'false'}
      />
      {initializationFailed ? (
        <div className="interactive-scene-player__error" role="alert">
          <strong>
            {text('reachDeck.player.interactive.startFailed', 'Activity could not start')}
          </strong>
          <span>
            {text(
              authoring
                ? 'reachDeck.player.interactive.authoringStartFailedHint'
                : 'reachDeck.player.interactive.startFailedHint',
              authoring
                ? 'Try loading the activity again. If it still fails, use Regenerate page in the editor to rebuild its content.'
                : 'The activity did not finish initializing. Try loading it again.',
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              setInitializationFailed(false);
              setAppliedLocalization(requestedLocalization);
              setRestartKey((current) => current + 1);
            }}
          >
            {text('reachDeck.player.interactive.retry', 'Retry activity')}
          </button>
        </div>
      ) : null}
    </div>
  );
};
