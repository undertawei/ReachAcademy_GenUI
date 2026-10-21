import type {
  InteractiveEventDeclaration,
  InteractiveEventManifest,
  InteractiveRuntimeDependency,
} from '@reachany/reach-deck-dsl';
import {
  INTERACTIVE_DOCUMENT_MAX_BYTES,
  INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN,
  INTERACTIVE_SCIENCE_KIT_MARKER_MAX_COUNT,
  INTERACTIVE_SCIENCE_KIT_TOTAL_MAX_BYTES,
  INTERACTIVE_SCIENCE_KIT_DEFINITIONS,
  INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE,
  INTERACTIVE_THREE_ROOT_MARKER_ATTRIBUTE,
  interactiveScienceKitRuntimeDependency,
  parseInteractiveTailwindRuntimeMarkerValue,
  parseInteractiveThreeRuntimeMarkerValue,
  parseInteractiveScienceKitEnvelopeValue,
  parseReachFunctionPlotSpecValue,
  type InteractiveRuntimeId,
  type InteractiveScienceKitEnvelope,
  type ReachFunctionPlotSpec,
} from '@reachany/reach-deck-dsl';

import { resolveInteractiveRuntimes } from './interactiveRuntimeRegistry.js';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  parseGeometryEnvelope,
  validateGeometryCamera,
  type GeometryEnvelope,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2,
  parseGeometryEnvelopeV2,
  type GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { resolveGeometryMessages } from './geometryMessages.js';

export const INTERACTIVE_CHANNEL = 'reach-interactive' as const;
export const INTERACTIVE_BRIDGE_VERSION = 'reach-interactive-bridge/v1' as const;
export const MAX_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_WIRE_BYTES = 72 * 1024;
export const MAX_LEARNING_EVENT_BYTES = 4 * 1024;
export const MAX_INTERACTIVE_SRCDOC_BYTES = 1024 * 1024;
export type GeometryHostMode = 'learner' | 'authoring-edit' | 'authoring-trial';

export interface GeometryEditProposal {
  readonly schemaVersion: 'reach-geometry-edit-proposal/v1';
  readonly pageId: string;
  readonly sourceRevision: number;
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly envelope: GeometryEnvelopeV2;
  readonly state: Record<string, unknown>;
  readonly wireSequence: number;
}
const interactiveCsp = (scriptUrls: readonly string[]) =>
  [
    "default-src 'none'",
    `script-src 'unsafe-inline'${scriptUrls.map((url) => ` ${url}`).join('')}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data: blob:',
    'media-src data: blob:',
    "connect-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
const INTERACTIVE_ROOT_SCROLL_STYLE = `
html {
  block-size: 100%;
  overflow-x: hidden !important;
  overflow-y: auto !important;
  overscroll-behavior: contain;
}
body {
  min-block-size: 100%;
  block-size: auto !important;
  overflow: visible !important;
}
`;
const FUNCTION_PLOT_MARKER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COMPONENT_MARKER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COMPONENT_LABEL_MAX_CHARACTERS = 160;
const COMPONENT_DETAIL_MAX_CHARACTERS = 500;
const COMPONENT_BASELINE_MAX_CHARACTERS = 32 * 1024;
const COMPONENT_MARKER_MAX_COUNT = 64;

export type InteractiveBridgePhase =
  | 'booting'
  | 'bridge_ready'
  | 'initializing'
  | 'active'
  | 'disposed'
  | 'failed';

export interface InteractiveWireMessage {
  channel: typeof INTERACTIVE_CHANNEL;
  version: typeof INTERACTIVE_BRIDGE_VERSION;
  nonce: string;
  sequence: number;
  type: string;
  payload: unknown;
}

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

export interface InteractiveLearningEventEnvelope {
  name: string;
  eventVersion: 1;
  payload: Record<string, string | number | boolean>;
}

export interface ValidatedInteractiveLearningEvent extends InteractiveLearningEventEnvelope {
  wireSequence: number;
}

export interface InteractiveComponentFocusPayload {
  pageId: string;
  sourceRevision: number;
  componentId: string;
  label: string;
  detail?: string;
  tagName: string;
  baselineOuterHtml: string;
}

export interface InteractiveComponentFocus extends InteractiveComponentFocusPayload {
  wireSequence: number;
}

const scalarPayload = (value: unknown): value is Record<string, string | number | boolean> =>
  plainRecord(value) &&
  Object.values(value).every(
    (item) =>
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item)),
  );

const declarationAcceptsPayload = (
  declaration: InteractiveEventDeclaration,
  payload: unknown,
): payload is Record<string, string | number | boolean> => {
  if (!scalarPayload(payload) || !isBoundedJson(payload, MAX_LEARNING_EVENT_BYTES)) return false;
  const fields = new Map(declaration.payloadFields.map((field) => [field.name, field]));
  if (Object.keys(payload).some((name) => !fields.has(name))) return false;
  for (const field of declaration.payloadFields) {
    const value = payload[field.name];
    if (value === undefined) {
      if (field.required) return false;
      continue;
    }
    switch (field.type) {
      case 'string':
        if (
          typeof value !== 'string' ||
          value.length > field.maxLength ||
          (field.enum.length > 0 && !field.enum.includes(value))
        )
          return false;
        break;
      case 'number':
        if (typeof value !== 'number' || value < field.minimum || value > field.maximum)
          return false;
        break;
      case 'integer':
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < field.minimum ||
          value > field.maximum
        )
          return false;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return false;
        break;
    }
  }
  return true;
};

export const validateInteractiveLearningEvent = (
  value: unknown,
  manifest: InteractiveEventManifest,
  wireSequence: number,
): ValidatedInteractiveLearningEvent | undefined => {
  if (!plainRecord(value) || !hasOnlyKeys(value, ['name', 'eventVersion', 'payload'])) return;
  const declaration = manifest.events.find((candidate) => candidate.name === value.name);
  if (
    declaration === undefined ||
    value.eventVersion !== declaration.eventVersion ||
    !declarationAcceptsPayload(declaration, value.payload)
  )
    return;
  return {
    name: declaration.name,
    eventVersion: declaration.eventVersion,
    payload: value.payload,
    wireSequence,
  };
};

export const validateInteractiveChildMessage = (
  message: InteractiveWireMessage,
  phase: InteractiveBridgePhase,
): 'valid' | 'invalid_type' | 'invalid_phase' | 'invalid_payload' => {
  const payload = message.payload;
  const payloadRecord = plainRecord(payload) ? payload : undefined;
  const phaseTypes: Partial<Record<InteractiveBridgePhase, readonly string[]>> = {
    booting: ['bridge_ready', 'navigation', 'error'],
    initializing: ['ready', 'navigation', 'error'],
    active: [
      'stateChange',
      'complete',
      'reset',
      'interaction',
      'component_focus',
      'geometry_edit_proposal',
      'error',
      'pong',
      'navigation',
    ],
  };
  const knownTypes = new Set([
    'bridge_ready',
    'ready',
    'stateChange',
    'complete',
    'reset',
    'interaction',
    'component_focus',
    'geometry_edit_proposal',
    'error',
    'pong',
    'navigation',
  ]);
  if (!knownTypes.has(message.type)) return 'invalid_type';
  if (!phaseTypes[phase]?.includes(message.type)) return 'invalid_phase';

  switch (message.type) {
    case 'bridge_ready':
      return payloadRecord && Object.keys(payloadRecord).length === 0 ? 'valid' : 'invalid_payload';
    case 'ready':
      return payloadRecord &&
        hasOnlyKeys(payloadRecord, ['restored', 'restoreToken', 'empty']) &&
        (payloadRecord.restored === undefined || typeof payloadRecord.restored === 'boolean') &&
        (payloadRecord.restoreToken === undefined ||
          typeof payloadRecord.restoreToken === 'string') &&
        (payloadRecord.empty === undefined || typeof payloadRecord.empty === 'boolean')
        ? 'valid'
        : 'invalid_payload';
    case 'reset':
      return payloadRecord &&
        hasOnlyKeys(payloadRecord, ['attempt']) &&
        Number.isSafeInteger(payloadRecord.attempt) &&
        (payloadRecord.attempt as number) >= 1
        ? 'valid'
        : 'invalid_payload';
    case 'error':
      return payloadRecord &&
        hasOnlyKeys(payloadRecord, ['code', 'detail']) &&
        typeof payloadRecord.code === 'string' &&
        payloadRecord.code.length >= 1 &&
        payloadRecord.code.length <= 64
        ? 'valid'
        : 'invalid_payload';
    case 'pong':
      return payloadRecord &&
        hasOnlyKeys(payloadRecord, ['heartbeatId']) &&
        Number.isSafeInteger(payloadRecord.heartbeatId) &&
        (payloadRecord.heartbeatId as number) >= 1
        ? 'valid'
        : 'invalid_payload';
    case 'navigation':
      return payloadRecord &&
        hasOnlyKeys(payloadRecord, ['reason']) &&
        (payloadRecord.reason === 'pagehide' || payloadRecord.reason === 'beforeunload')
        ? 'valid'
        : 'invalid_payload';
    case 'interaction':
      return payloadRecord &&
        hasOnlyKeys(payloadRecord, ['name', 'eventVersion', 'payload']) &&
        typeof payloadRecord.name === 'string' &&
        /^[a-z][a-z0-9_]{0,63}$/.test(payloadRecord.name) &&
        payloadRecord.eventVersion === 1 &&
        plainRecord(payloadRecord.payload) &&
        isBoundedJson(payloadRecord.payload, MAX_LEARNING_EVENT_BYTES)
        ? 'valid'
        : 'invalid_payload';
    case 'component_focus':
      return parseInteractiveComponentFocusPayload(payload) === undefined
        ? 'invalid_payload'
        : 'valid';
    case 'geometry_edit_proposal':
      return parseGeometryEditProposalPayload(payload) === undefined ? 'invalid_payload' : 'valid';
    default:
      return 'valid';
  }
};

interface GeometryEditProposalPayload {
  schemaVersion: 'reach-geometry-edit-proposal/v1';
  pageId: string;
  sourceRevision: number;
  instanceId: string;
  fingerprint: string;
  state: Record<string, unknown>;
}

const parseGeometryEditProposalPayload = (
  value: unknown,
): GeometryEditProposalPayload | undefined => {
  if (
    !plainRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'pageId',
      'sourceRevision',
      'instanceId',
      'fingerprint',
      'state',
    ]) ||
    value.schemaVersion !== 'reach-geometry-edit-proposal/v1' ||
    typeof value.pageId !== 'string' ||
    value.pageId.length < 1 ||
    value.pageId.length > 128 ||
    !Number.isSafeInteger(value.sourceRevision) ||
    (value.sourceRevision as number) < 1 ||
    typeof value.instanceId !== 'string' ||
    !INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN.test(value.instanceId) ||
    typeof value.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !plainRecord(value.state) ||
    value.state.schemaVersion !== 'reach-geometry-state/v2' ||
    value.state.instanceId !== value.instanceId ||
    value.state.fingerprint !== value.fingerprint ||
    !isBoundedJson(value)
  )
    return undefined;
  return value as unknown as GeometryEditProposalPayload;
};

export const parseInteractiveComponentFocusPayload = (
  value: unknown,
): InteractiveComponentFocusPayload | undefined => {
  if (
    !plainRecord(value) ||
    !hasOnlyKeys(value, [
      'pageId',
      'sourceRevision',
      'componentId',
      'label',
      'detail',
      'tagName',
      'baselineOuterHtml',
    ]) ||
    typeof value.pageId !== 'string' ||
    value.pageId.length < 1 ||
    value.pageId.length > 128 ||
    !Number.isSafeInteger(value.sourceRevision) ||
    (value.sourceRevision as number) < 1 ||
    typeof value.componentId !== 'string' ||
    !COMPONENT_MARKER_ID_PATTERN.test(value.componentId) ||
    typeof value.label !== 'string' ||
    value.label.length < 1 ||
    value.label.length > COMPONENT_LABEL_MAX_CHARACTERS ||
    (value.detail !== undefined &&
      (typeof value.detail !== 'string' ||
        value.detail.length < 1 ||
        value.detail.length > COMPONENT_DETAIL_MAX_CHARACTERS)) ||
    typeof value.tagName !== 'string' ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(value.tagName) ||
    typeof value.baselineOuterHtml !== 'string' ||
    value.baselineOuterHtml.length < 1 ||
    value.baselineOuterHtml.length > COMPONENT_BASELINE_MAX_CHARACTERS
  ) {
    return undefined;
  }
  return value as unknown as InteractiveComponentFocusPayload;
};

const encodedSize = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
};

export const isBoundedJson = (value: unknown, maximumBytes = MAX_SNAPSHOT_BYTES): boolean => {
  const size = encodedSize(value);
  if (size === undefined || size > maximumBytes) return false;

  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 2_000 || depth > 8) return false;
    if (candidate === null || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate === 'string') return candidate.length <= 8_192;
    if (Array.isArray(candidate)) {
      if (Object.keys(candidate).length !== candidate.length) return false;
      return candidate.every((item) => visit(item, depth + 1));
    }
    if (!plainRecord(candidate)) return false;
    return Object.keys(candidate).every(
      (key) => !unsafeKeys.has(key) && visit(candidate[key], depth + 1),
    );
  };

  return visit(value, 0);
};

export const parseInteractiveWireMessage = (value: unknown): InteractiveWireMessage | undefined => {
  if (
    !plainRecord(value) ||
    encodedSize(value) === undefined ||
    encodedSize(value)! > MAX_WIRE_BYTES
  ) {
    return undefined;
  }
  if (
    value.channel !== INTERACTIVE_CHANNEL ||
    value.version !== INTERACTIVE_BRIDGE_VERSION ||
    typeof value.nonce !== 'string' ||
    value.nonce.length < 16 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.type !== 'string' ||
    value.type.length > 64 ||
    !isBoundedJson(value.payload)
  ) {
    return undefined;
  }
  return value as unknown as InteractiveWireMessage;
};

export const createInteractiveNonce = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
};

const storageShimSource = (): string => `(() => {
  const makeStore = () => {
    let data = Object.create(null);
    return {
      getItem: (key) => Object.prototype.hasOwnProperty.call(data, String(key)) ? data[String(key)] : null,
      setItem: (key, value) => { data[String(key)] = String(value); },
      removeItem: (key) => { delete data[String(key)]; },
      clear: () => { data = Object.create(null); },
      key: (index) => Object.keys(data)[index] ?? null,
      get length() { return Object.keys(data).length; }
    };
  };
  ['localStorage', 'sessionStorage'].forEach((name) => {
    try {
      const storage = window[name];
      storage.getItem('__reach_probe__');
    } catch {
      try { Object.defineProperty(window, name, { value: makeStore(), configurable: true }); } catch {}
    }
  });
})();`;

const bootstrapSource = (
  nonce: string,
  allowReset: boolean,
  eventManifest: unknown,
  authoring: boolean,
  geometryHostMode: GeometryHostMode,
  pageId: string,
  sourceRevision: number,
  componentMarkers: readonly InteractiveComponentFocusPayload[],
): string => `(() => {
  'use strict';
  const CHANNEL = ${JSON.stringify(INTERACTIVE_CHANNEL)};
  const VERSION = ${JSON.stringify(INTERACTIVE_BRIDGE_VERSION)};
  const NONCE = ${JSON.stringify(nonce)};
  const ALLOW_RESET = ${JSON.stringify(allowReset)};
  const AUTHORING = ${JSON.stringify(authoring)};
  const GEOMETRY_HOST_MODE = ${JSON.stringify(geometryHostMode)};
  const PAGE_ID = ${JSON.stringify(pageId)};
  const SOURCE_REVISION = ${JSON.stringify(sourceRevision)};
  const COMPONENT_MARKERS = new Map(${safeInlineJson(
    componentMarkers.map((marker) => [marker.componentId, marker]),
  )});
  const EVENT_MANIFEST = ${JSON.stringify(eventManifest)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')};
  const nativePost = window.parent.postMessage.bind(window.parent);
  let sequence = 0;
  let phase = 'booting';
  let attempt = 1;
  let completed = false;
  let initialization;
  let initializationDispatched = false;
  let queuedReady;
  let parentSequence = 0;
  let navigationSent = false;
  let signalTimer;
  let queuedStateChange;
  let hasQueuedStateChange = false;
  let suspended = false;
  let stateFlushLocked = false;
  let pageSnapshot;
  let geometryInstances;
  const learningEventDeclarations = new Map((EVENT_MANIFEST.events || []).map((declaration) => [declaration.name, declaration]));
  const lastImmediateAt = new Map();
  const latestSignals = new Map();
  const latestTimers = new Map();
  const recentLearningEvents = [];
  const mediaToResume = new Set();
  const animationsToResume = new Set();
  const script = document.currentScript;
  const send = (type, payload) => nativePost({ channel: CHANNEL, version: VERSION, nonce: NONCE, sequence: ++sequence, type, payload }, '*');
  let lastComponentFocusAt = 0;
  const emitComponentFocus = (event) => {
    if (!AUTHORING || phase !== 'active' || suspended) return;
    const target = event.target instanceof Element ? event.target : undefined;
    const marker = target?.closest('[data-reach-component-id]');
    if (!marker) return;
    const componentId = marker.getAttribute('data-reach-component-id') || '';
    const baseline = COMPONENT_MARKERS.get(componentId);
    if (!baseline || marker.tagName.toLowerCase() !== baseline.tagName) return;
    const now = Date.now();
    if (now - lastComponentFocusAt < 100) return;
    lastComponentFocusAt = now;
    send('component_focus', { ...baseline, pageId: PAGE_ID, sourceRevision: SOURCE_REVISION });
  };
  if (AUTHORING) document.addEventListener('click', emitComponentFocus, true);
  const flushSignals = (includeSuspended = false) => {
    if (signalTimer !== undefined) clearTimeout(signalTimer);
    signalTimer = undefined;
    if (phase !== 'active' || (suspended && !includeSuspended)) return;
    if (hasQueuedStateChange) {
      hasQueuedStateChange = false;
      send('stateChange', queuedStateChange);
      queuedStateChange = undefined;
    }
  };
  const queueSignal = (type, payload) => {
    if (phase !== 'active' || stateFlushLocked) return false;
    queuedStateChange = payload;
    hasQueuedStateChange = true;
    if (!suspended && signalTimer === undefined) signalTimer = setTimeout(flushSignals, 100);
    return true;
  };
  const copyRecordWithoutGeometry = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'geometry'));
  };
  const composedSnapshot = () => {
    if (geometryInstances === undefined) return pageSnapshot;
    const base = pageSnapshot && typeof pageSnapshot === 'object' && !Array.isArray(pageSnapshot)
      ? copyRecordWithoutGeometry(pageSnapshot)
      : { kind: 'interactive' };
    return { ...base, geometry: { schemaVersion: 'reach-geometry-host-state/v2', instances: geometryInstances } };
  };
  const geometryStateFits = (instances) => {
    if (!instances || typeof instances !== 'object' || Array.isArray(instances)) return false;
    const previous = geometryInstances;
    geometryInstances = { ...instances };
    try {
      return new TextEncoder().encode(JSON.stringify(composedSnapshot())).byteLength <= ${MAX_SNAPSHOT_BYTES};
    } catch {
      return false;
    } finally {
      geometryInstances = previous;
    }
  };
  const geometryStateChange = (instances) => {
    if (!instances || typeof instances !== 'object' || Array.isArray(instances)) return false;
    const candidate = { ...instances };
    const previous = geometryInstances;
    geometryInstances = candidate;
    if (!geometryStateFits(candidate)) {
      geometryInstances = previous;
      return false;
    }
    geometryInstances = candidate;
    const snapshot = composedSnapshot();
    if (phase === 'initializing' && !stateFlushLocked) {
      queuedStateChange = snapshot;
      hasQueuedStateChange = true;
      return true;
    }
    return queueSignal('stateChange', snapshot);
  };
  const cancelSignals = () => {
    if (signalTimer !== undefined) clearTimeout(signalTimer);
    signalTimer = undefined;
    queuedStateChange = undefined;
    hasQueuedStateChange = false;
    latestTimers.forEach((timer) => clearTimeout(timer));
    latestTimers.clear();
    latestSignals.clear();
  };
  const suspendDocument = () => {
    if (phase !== 'active' || suspended) return;
    suspended = true;
    if (signalTimer !== undefined) clearTimeout(signalTimer);
    signalTimer = undefined;
    document.querySelectorAll('audio,video').forEach((media) => {
      if (!media.paused) {
        mediaToResume.add(media);
        media.pause();
      }
    });
    if (typeof document.getAnimations === 'function') {
      document.getAnimations().forEach((animation) => {
        if (animation.playState === 'running') {
          animationsToResume.add(animation);
          animation.pause();
        }
      });
    }
    document.documentElement.dataset.reachInteractiveSuspended = 'true';
    window.dispatchEvent(new Event('reach-interactive-suspend'));
  };
  const resumeDocument = () => {
    if (phase !== 'active' || !suspended) return;
    suspended = false;
    delete document.documentElement.dataset.reachInteractiveSuspended;
    animationsToResume.forEach((animation) => { try { animation.play(); } catch {} });
    animationsToResume.clear();
    mediaToResume.forEach((media) => { try { Promise.resolve(media.play()).catch(() => {}); } catch {} });
    mediaToResume.clear();
    window.dispatchEvent(new Event('reach-interactive-resume'));
    flushSignals();
  };
  const normalizeReadyPayload = (payload) => {
    const candidate = payload || {};
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || candidate.restoreToken !== null) return candidate;
    return Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'restoreToken'));
  };
  const emitReady = (payload) => {
    const readyPayload = normalizeReadyPayload(payload);
    if (phase === 'active' || phase === 'disposed') return;
    if (phase !== 'initializing') { queuedReady = readyPayload; return; }
    phase = 'active';
    send('ready', readyPayload);
    flushSignals();
  };
  const validLearningPayload = (declaration, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const keys = Object.keys(payload);
    if (keys.some((key) => !declaration.payloadFields.some((field) => field.name === key))) return false;
    try { if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 4096) return false; } catch { return false; }
    return declaration.payloadFields.every((field) => {
      const value = payload[field.name];
      if (value === undefined) return !field.required;
      if (field.type === 'string') return typeof value === 'string' && value.length <= field.maxLength && (!field.enum.length || field.enum.includes(value));
      if (field.type === 'boolean') return typeof value === 'boolean';
      if (field.type === 'integer') return Number.isInteger(value) && value >= field.minimum && value <= field.maximum;
      return typeof value === 'number' && Number.isFinite(value) && value >= field.minimum && value <= field.maximum;
    });
  };
  const emitLearningEvent = (name, payload) => {
    if (phase !== 'active' || suspended) return false;
    const declaration = learningEventDeclarations.get(name);
    if (!declaration || !validLearningPayload(declaration, payload)) return false;
    const envelope = { name, eventVersion: declaration.eventVersion, payload };
    const now = Date.now();
    while (recentLearningEvents.length && now - recentLearningEvents[0] >= 60000) recentLearningEvents.shift();
    if (recentLearningEvents.length >= 120) return false;
    const deliver = (candidate) => {
      const deliveredAt = Date.now();
      while (recentLearningEvents.length && deliveredAt - recentLearningEvents[0] >= 60000) recentLearningEvents.shift();
      if (recentLearningEvents.length >= 120 || phase !== 'active' || suspended) return false;
      recentLearningEvents.push(deliveredAt);
      send('interaction', candidate);
      return true;
    };
    if (declaration.delivery.mode === 'immediate') {
      const previous = lastImmediateAt.get(name);
      if (previous !== undefined && now - previous < 250) return false;
      lastImmediateAt.set(name, now);
      return deliver(envelope);
    }
    latestSignals.set(name, envelope);
    if (!latestTimers.has(name)) {
      latestTimers.set(name, setTimeout(() => {
        latestTimers.delete(name);
        const latest = latestSignals.get(name);
        latestSignals.delete(name);
        if (latest) deliver(latest);
      }, declaration.delivery.intervalMs));
    }
    return true;
  };
  const doReset = () => {
    if (!ALLOW_RESET || phase !== 'active' || suspended) return false;
    flushSignals();
    attempt += 1;
    completed = false;
    send('reset', { attempt });
    window.dispatchEvent(new CustomEvent('reach-interactive-reset', { detail: { attempt } }));
    return true;
  };
  const api = Object.freeze({
    ready: (payload) => emitReady(payload),
    stateChange: (snapshot) => {
      pageSnapshot = copyRecordWithoutGeometry(snapshot);
      return queueSignal('stateChange', composedSnapshot());
    },
    geometryStateFits,
    geometryStateChange,
    geometryEditProposal: (payload) => {
      if (GEOMETRY_HOST_MODE !== 'authoring-edit' || phase !== 'active' || suspended) return false;
      send('geometry_edit_proposal', payload);
      return true;
    },
    complete: (payload) => {
      if (phase !== 'active' || suspended || completed) return false;
      flushSignals();
      completed = true;
      send('complete', payload || {});
      return true;
    },
    reset: doReset,
    learningEvent: (name, payload) => emitLearningEvent(name, payload),
    error: (payload) => { if (phase === 'disposed') return false; send('error', payload || {}); return true; },
    getInitialization: () => initializationDispatched ? initialization : undefined,
    isSuspended: () => suspended
  });
  Object.defineProperty(window, 'ReachInteractive', { value: api, configurable: false, writable: false });
  const reportNavigation = (reason) => {
    if (navigationSent || phase === 'disposed') return;
    navigationSent = true;
    send('navigation', { reason });
  };
  window.addEventListener('pagehide', () => reportNavigation('pagehide'));
  window.addEventListener('beforeunload', () => reportNavigation('beforeunload'));
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.version !== VERSION || message.nonce !== NONCE || !Number.isSafeInteger(message.sequence) || message.sequence <= parentSequence) return;
    parentSequence = message.sequence;
    if (message.type === 'initialize' && phase === 'booting') {
      phase = 'initializing';
      initialization = message.payload;
      const restoredGeometry = initialization && initialization.restoredSnapshot && initialization.restoredSnapshot.geometry;
      geometryInstances = restoredGeometry && restoredGeometry.schemaVersion === 'reach-geometry-host-state/v2' && restoredGeometry.instances && typeof restoredGeometry.instances === 'object' && !Array.isArray(restoredGeometry.instances)
        ? { ...restoredGeometry.instances }
        : undefined;
      pageSnapshot = copyRecordWithoutGeometry(initialization && initialization.restoredSnapshot);
      attempt = Number.isSafeInteger(initialization && initialization.attempt) ? initialization.attempt : 1;
      const dispatchInitialization = () => {
        if (phase !== 'disposed') {
          initializationDispatched = true;
          window.dispatchEvent(new CustomEvent('reach-interactive-initialize', { detail: initialization }));
        }
      };
      const scheduleInitialization = () => setTimeout(dispatchInitialization, 0);
      if (document.readyState === 'complete') scheduleInitialization();
      else window.addEventListener('load', scheduleInitialization, { once: true });
      if (queuedReady !== undefined) emitReady(queuedReady);
    } else if (message.type === 'resize' && phase === 'active') {
      window.dispatchEvent(new CustomEvent('reach-interactive-resize', { detail: message.payload }));
    } else if (message.type === 'suspend') {
      suspendDocument();
    } else if (message.type === 'resume') {
      stateFlushLocked = false;
      resumeDocument();
    } else if (message.type === 'requestReset') {
      doReset();
    } else if (message.type === 'ping' && phase === 'active' && message.payload && Number.isSafeInteger(message.payload.heartbeatId)) {
      if (message.payload.flushState === true) {
        flushSignals(true);
        stateFlushLocked = true;
        suspendDocument();
      }
      send('pong', { heartbeatId: message.payload.heartbeatId });
    } else if (message.type === 'dispose') {
      phase = 'disposed';
      cancelSignals();
      window.dispatchEvent(new Event('reach-interactive-dispose'));
    }
  });
  send('bridge_ready', {});
  if (script) script.remove();
})();`;

export const buildInteractiveSrcDoc = (input: {
  documentHtml: string;
  nonce: string;
  allowReset: boolean;
  eventManifest: unknown;
  runtimeDependencies?: InteractiveRuntimeDependency[];
  dependencyBaseUrl?: string;
  authoring?: boolean;
  geometryHostMode?: GeometryHostMode;
  pageId?: string;
  sourceRevision?: number;
  locale?: string;
  geometryMessages?: Readonly<Record<string, string>>;
}): string => {
  if (new TextEncoder().encode(input.documentHtml).byteLength > INTERACTIVE_DOCUMENT_MAX_BYTES) {
    throw new Error('Interactive document exceeds the stored HTML size limit.');
  }
  const parser = new DOMParser();
  const document = parser.parseFromString(input.documentHtml, 'text/html');
  document
    .querySelectorAll('base, meta[http-equiv="Content-Security-Policy" i]')
    .forEach((node) => node.remove());
  const tailwindRuntimeVersion = parseTailwindRuntimeMarker(document);
  const threeRuntimeVersion = parseThreeRuntimeMarker(document);
  const functionPlotEntries = parseFunctionPlotMarkers(document);
  const scienceKitEntries = parseScienceKitMarkers(document);
  const componentMarkers =
    input.authoring === true
      ? parseComponentMarkers(document, input.pageId ?? '', input.sourceRevision ?? 1)
      : [];
  const runtimes = resolveInteractiveRuntimes({
    runtimeDependencies: input.runtimeDependencies,
    hasFunctionPlotMarkers: functionPlotEntries.length > 0,
    requiredScienceKitRuntimeIds: scienceKitEntries.map(({ runtimeId }) => runtimeId),
    tailwindRuntimeVersion,
    threeRuntimeVersion,
  });
  const externalRuntimeUrls = new Map(
    runtimes
      .filter((runtime) => runtime.scriptPath !== undefined)
      .map((runtime) => [
        runtime.id,
        resolveInteractiveDependencyUrl(runtime.scriptPath!, input.dependencyBaseUrl),
      ]),
  );
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = interactiveCsp([...externalRuntimeUrls.values()]);
  const rootScrollStyle = document.createElement('style');
  rootScrollStyle.dataset.reachRootScroll = '';
  rootScrollStyle.textContent = INTERACTIVE_ROOT_SCROLL_STYLE;
  const storageShim = document.createElement('script');
  storageShim.dataset.reachStorageShim = '';
  storageShim.textContent = storageShimSource();
  const bootstrap = document.createElement('script');
  bootstrap.textContent = bootstrapSource(
    input.nonce,
    input.allowReset,
    input.eventManifest,
    input.authoring === true,
    input.geometryHostMode ?? 'learner',
    input.pageId ?? '',
    input.sourceRevision ?? 1,
    componentMarkers,
  );
  const runtimeNodes = runtimes.map((runtime) => {
    const node = document.createElement(runtime.kind === 'style' ? 'style' : 'script');
    node.dataset.reachInteractiveRuntime = `${runtime.id}@${runtime.version}`;
    if (runtime.id === 'function-plot') node.dataset.reachFunctionPlotRuntime = '';
    if (runtime.source !== undefined) {
      node.textContent = runtime.source;
    } else if (node instanceof HTMLScriptElement) {
      node.src = externalRuntimeUrls.get(runtime.id)!;
      node.setAttribute('integrity', runtime.integrity!);
      node.setAttribute('crossorigin', runtime.crossOrigin!);
      node.setAttribute('referrerpolicy', 'no-referrer');
    }
    return node;
  });
  const scienceKitInstall =
    scienceKitEntries.length > 0 ? document.createElement('script') : undefined;
  if (scienceKitInstall !== undefined) {
    scienceKitInstall.dataset.reachScienceKitInstall = '';
    scienceKitInstall.textContent = scienceKitInstallSource(
      scienceKitEntries,
      input.locale ?? 'en-US',
      input.geometryMessages ?? resolveGeometryMessages(),
      input.geometryHostMode ?? 'learner',
      input.pageId ?? '',
      input.sourceRevision ?? 1,
    );
  }
  if (functionPlotEntries.length > 0) {
    const functionPlotInstall = document.createElement('script');
    functionPlotInstall.dataset.reachFunctionPlotInstall = '';
    functionPlotInstall.textContent = functionPlotInstallSource(functionPlotEntries);
    document.head.prepend(
      csp,
      rootScrollStyle,
      storageShim,
      bootstrap,
      ...runtimeNodes,
      functionPlotInstall,
      ...(scienceKitInstall === undefined ? [] : [scienceKitInstall]),
    );
  } else {
    document.head.prepend(
      csp,
      rootScrollStyle,
      storageShim,
      bootstrap,
      ...runtimeNodes,
      ...(scienceKitInstall === undefined ? [] : [scienceKitInstall]),
    );
  }

  const source = `<!doctype html>${document.documentElement.outerHTML}`;
  if (new TextEncoder().encode(source).byteLength > MAX_INTERACTIVE_SRCDOC_BYTES) {
    throw new Error('Interactive srcdoc exceeds the host runtime size limit.');
  }
  return source;
};

const parseTailwindRuntimeMarker = (
  document: Document,
): ReturnType<typeof parseInteractiveTailwindRuntimeMarkerValue> | undefined => {
  const markers = [
    ...document.querySelectorAll<HTMLElement>(`[${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}]`),
  ];
  if (markers.length === 0) return undefined;
  if (markers.length !== 1 || markers[0] !== document.documentElement) {
    throw new Error(
      'Interactive Tailwind runtime marker must appear exactly once on the html root.',
    );
  }
  return parseInteractiveTailwindRuntimeMarkerValue(
    document.documentElement.getAttribute(INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE),
  );
};

const parseThreeRuntimeMarker = (
  document: Document,
): ReturnType<typeof parseInteractiveThreeRuntimeMarkerValue> | undefined => {
  const markers = [
    ...document.querySelectorAll<HTMLElement>(`[${INTERACTIVE_THREE_ROOT_MARKER_ATTRIBUTE}]`),
  ];
  if (markers.length === 0) return undefined;
  if (markers.length !== 1 || markers[0] !== document.documentElement) {
    throw new Error('Interactive three runtime marker must appear exactly once on the html root.');
  }
  return parseInteractiveThreeRuntimeMarkerValue(
    document.documentElement.getAttribute(INTERACTIVE_THREE_ROOT_MARKER_ATTRIBUTE),
  );
};

type ParsedScienceKitMarker = {
  instanceId: string;
  envelope: InteractiveScienceKitEnvelope | GeometryEnvelope | GeometryEnvelopeV2;
  runtimeId: InteractiveRuntimeId;
  geometry: boolean;
  geometryV2: boolean;
  authoredSnapshot?: GeometryAuthoredSnapshot;
  heavy: boolean;
};

interface GeometryAuthoredSnapshot {
  readonly schemaVersion: 'reach-geometry-authored-snapshot/v1';
  readonly instanceId: string;
  readonly fingerprint: string;
  readonly inputs: unknown;
  readonly camera: unknown;
}

const geometryEnvelopeFingerprint = (value: unknown): string => {
  const canonical = (candidate: unknown): string => {
    if (Array.isArray(candidate)) return `[${candidate.map(canonical).join(',')}]`;
    if (candidate && typeof candidate === 'object')
      return `{${Object.keys(candidate)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((candidate as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    return JSON.stringify(candidate);
  };
  return bytesToHex(sha256(new TextEncoder().encode(canonical(value))));
};

function immediatelyFollows(snapshot: Element, geometryMarker: Element): boolean {
  return snapshot.previousSibling === geometryMarker;
}

function parseGeometryAuthoredSnapshots(
  document: Document,
  envelopes: ReadonlyMap<string, GeometryEnvelopeV2>,
): ReadonlyMap<string, GeometryAuthoredSnapshot> {
  const snapshots = new Map<string, GeometryAuthoredSnapshot>();
  for (const marker of document.querySelectorAll<HTMLElement>('[data-reach-geometry-snapshot]')) {
    const instanceId = marker.dataset.reachGeometrySnapshot?.trim() ?? '';
    const geometryMarker = marker.previousElementSibling;
    if (
      marker.tagName.toLowerCase() !== 'script' ||
      (marker.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/json' ||
      !INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN.test(instanceId) ||
      snapshots.has(instanceId) ||
      !envelopes.has(instanceId) ||
      !(geometryMarker instanceof HTMLElement) ||
      geometryMarker.dataset.reachScienceKit?.trim() !== instanceId ||
      !immediatelyFollows(marker, geometryMarker)
    )
      throw new Error(
        'Geometry authored snapshot marker must immediately follow its unique v2 geometry marker.',
      );
    let candidate: unknown;
    try {
      candidate = JSON.parse(marker.textContent ?? '');
    } catch {
      throw new Error('Geometry authored snapshot marker must contain valid JSON.');
    }
    if (
      !plainRecord(candidate) ||
      !hasOnlyKeys(candidate, ['schemaVersion', 'instanceId', 'fingerprint', 'inputs', 'camera']) ||
      Object.keys(candidate).length !== 5 ||
      candidate.schemaVersion !== 'reach-geometry-authored-snapshot/v1' ||
      candidate.instanceId !== instanceId ||
      typeof candidate.fingerprint !== 'string' ||
      candidate.fingerprint !== geometryEnvelopeFingerprint(envelopes.get(instanceId)) ||
      !plainRecord(candidate.inputs) ||
      !plainRecord(candidate.camera) ||
      !isBoundedJson(candidate)
    )
      throw new Error('Geometry authored snapshot marker contract is invalid.');
    if (
      !hasOnlyKeys(candidate.inputs, ['parameters', 'freedoms']) ||
      Object.keys(candidate.inputs).length !== 2 ||
      !plainRecord(candidate.inputs.parameters) ||
      !plainRecord(candidate.inputs.freedoms)
    )
      throw new Error('Geometry authored snapshot inputs are invalid.');
    try {
      validateGeometryCamera(candidate.camera, envelopes.get(instanceId)!.spec.dimension);
    } catch {
      throw new Error('Geometry authored snapshot camera is invalid.');
    }
    snapshots.set(instanceId, candidate as unknown as GeometryAuthoredSnapshot);
    marker.textContent = safeInlineJson(candidate);
  }
  return snapshots;
}

function parseScienceKitMarkers(document: Document): ParsedScienceKitMarker[] {
  let entries = [...document.querySelectorAll<HTMLElement>('[data-reach-science-kit]')].map(
    (marker): ParsedScienceKitMarker => {
      const instanceId = marker.dataset.reachScienceKit?.trim() ?? '';
      if (
        marker.tagName.toLowerCase() !== 'script' ||
        (marker.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/json' ||
        !INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN.test(instanceId)
      ) {
        throw new Error('Interactive science kit marker type or instance id is invalid.');
      }
      let candidate: unknown;
      try {
        candidate = JSON.parse(marker.textContent ?? '');
      } catch {
        throw new Error('Interactive science kit marker must contain valid JSON.');
      }
      const geometry =
        candidate !== null &&
        typeof candidate === 'object' &&
        Object.hasOwn(
          EUCLIDEAN_GEOMETRY_CONTRACT.kits,
          String((candidate as { kitId?: unknown }).kitId),
        );
      const geometryV2 = geometry && (candidate as { kitVersion?: unknown }).kitVersion === 2;
      const envelope = geometryV2
        ? parseGeometryEnvelopeV2(candidate).envelope
        : geometry
          ? parseGeometryEnvelope(candidate).envelope
          : parseInteractiveScienceKitEnvelopeValue(candidate);
      const definition = geometryV2
        ? EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits[(envelope as GeometryEnvelopeV2).kitId]
        : geometry
          ? EUCLIDEAN_GEOMETRY_CONTRACT.kits[(envelope as GeometryEnvelope).kitId]
          : INTERACTIVE_SCIENCE_KIT_DEFINITIONS[(envelope as InteractiveScienceKitEnvelope).kitId];
      const targets = [
        ...document.querySelectorAll<HTMLElement>('[data-reach-science-kit-target]'),
      ].filter((target) => target.dataset.reachScienceKitTarget?.trim() === instanceId);
      if (targets.length !== 1 || targets[0]!.tagName.toLowerCase() === 'script') {
        throw new Error('Interactive science kit marker requires exactly one target.');
      }
      marker.textContent = safeInlineJson(envelope);
      return {
        instanceId,
        envelope,
        runtimeId: geometryV2
          ? (EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits[(envelope as GeometryEnvelopeV2).kitId]
              .runtimeId as InteractiveRuntimeId)
          : geometry
            ? (EUCLIDEAN_GEOMETRY_CONTRACT.kits[(envelope as GeometryEnvelope).kitId]
                .runtimeId as InteractiveRuntimeId)
            : interactiveScienceKitRuntimeDependency(
                (envelope as InteractiveScienceKitEnvelope).kitId,
              ).id,
        geometry,
        geometryV2,
        heavy: definition.heavy,
      };
    },
  );
  if (entries.length > INTERACTIVE_SCIENCE_KIT_MARKER_MAX_COUNT) {
    throw new Error('Interactive document has too many science kit markers.');
  }
  if (new Set(entries.map(({ instanceId }) => instanceId)).size !== entries.length) {
    throw new Error('Interactive science kit instance ids must be unique.');
  }
  const snapshots = parseGeometryAuthoredSnapshots(
    document,
    new Map(
      entries.flatMap((entry) =>
        entry.geometryV2 ? [[entry.instanceId, entry.envelope as GeometryEnvelopeV2] as const] : [],
      ),
    ),
  );
  entries = entries.map((entry) => ({
    ...entry,
    ...(snapshots.has(entry.instanceId)
      ? { authoredSnapshot: snapshots.get(entry.instanceId) }
      : {}),
  }));
  const totalBytes = entries.reduce(
    (sum, { envelope }) => sum + new TextEncoder().encode(JSON.stringify(envelope)).byteLength,
    0,
  );
  if (totalBytes > INTERACTIVE_SCIENCE_KIT_TOTAL_MAX_BYTES) {
    throw new Error('Interactive science kit markers exceed the page size limit.');
  }
  const heavyCount = entries.filter(({ heavy }) => heavy).length;
  if (heavyCount > 1) throw new Error('Interactive pages may contain only one heavy science kit.');
  return entries;
}

const resolveInteractiveDependencyUrl = (path: string, baseUrl?: string): string => {
  const fallback =
    typeof window === 'undefined' || window.location.origin === 'null'
      ? 'http://127.0.0.1'
      : window.location.origin;
  const base = new URL(baseUrl ?? fallback);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Interactive dependency base URL is invalid.');
  }
  return new URL(path, base.origin).href;
};

const scienceKitInstallSource = (
  entries: readonly ParsedScienceKitMarker[],
  locale: string,
  messages: Readonly<Record<string, string>>,
  geometryHostMode: GeometryHostMode,
  pageId: string,
  sourceRevision: number,
): string => `(() => {
  'use strict';
  const entries = ${safeInlineJson(entries)};
  const locale = ${safeInlineJson(locale)};
  const messages = ${safeInlineJson(entries.some((entry) => entry.geometry) ? messages : {})};
  const geometryHostMode = ${safeInlineJson(geometryHostMode)};
  const pageId = ${safeInlineJson(pageId)};
  const sourceRevision = ${safeInlineJson(sourceRevision)};
  const mounted = new Map();
  const cloneState = (value) => {
    try { return structuredClone(value); } catch { return undefined; }
  };
  const api = Object.freeze({
    getState: (instanceId) => {
      if (typeof instanceId !== 'string') return undefined;
      const controller = mounted.get(instanceId);
      return controller && typeof controller.getState === 'function'
        ? cloneState(controller.getState())
        : undefined;
    },
    setState: (instanceId, state) => {
      if (typeof instanceId !== 'string') return false;
      const controller = mounted.get(instanceId);
      return Boolean(controller && typeof controller.setState === 'function' && controller.setState(cloneState(state)));
    },
    getComputedState: (instanceId) => {
      const entry = entries.find(entry => entry.instanceId === instanceId);
      const controller = mounted.get(instanceId);
      if (!entry?.geometry) return Object.freeze({ ok: false, code: 'unsupported' });
      if (!controller?.getComputedState) return Object.freeze({ ok: false, code: 'unavailable' });
      return deepFreeze(cloneState(controller.getComputedState()) ?? { ok: false, code: 'unavailable' });
    },
    applyCommand: (instanceId, command) => {
      const entry = entries.find(entry => entry.instanceId === instanceId);
      const controller = mounted.get(instanceId);
      if (!entry?.geometry) return Object.freeze({ ok: false, code: 'unsupported' });
      if (!controller?.applyCommand) return Object.freeze({ ok: false, code: 'unavailable' });
      return deepFreeze(cloneState(controller.applyCommand(cloneState(command))) ?? { ok: false, code: 'unavailable' });
    }
  });
  Object.defineProperty(window, 'ReachScienceKits', { value: api, configurable: false, writable: false });
  const deepFreeze = (value) => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  };
  const geometryEntries = entries.filter((entry) => entry.geometryV2);
  const geometryStates = (instanceId, candidate) => Object.fromEntries(geometryEntries.map((entry) => {
    if (entry.instanceId === instanceId && candidate !== undefined) return [entry.instanceId, candidate];
    const controller = mounted.get(entry.instanceId);
    return [entry.instanceId, controller?.getState?.()];
  }));
  const geometryStateFits = (instanceId, candidate) => {
    const states = geometryStates(instanceId, candidate);
    return Object.values(states).every((state) => state !== undefined) && window.ReachInteractive.geometryStateFits(states);
  };
  const publishGeometryState = (entry) => {
    const states = geometryStates();
    if (!Object.values(states).every((state) => state !== undefined)) return false;
    const accepted = window.ReachInteractive.geometryStateChange(states);
    if (accepted && geometryHostMode === 'authoring-edit' && entry) {
      const state = states[entry.instanceId];
      window.ReachInteractive.geometryEditProposal({
        schemaVersion: 'reach-geometry-edit-proposal/v1',
        pageId,
        sourceRevision,
        instanceId: entry.instanceId,
        fingerprint: state.fingerprint,
        state,
      });
    }
    return accepted;
  };
  let mountingGeometry = false;
  const mount = () => {
    const facades = window.__reachScienceKitFacades;
    for (const entry of entries) {
      mountingGeometry = entry.geometry;
      const target = [...document.querySelectorAll('[data-reach-science-kit-target]')]
        .find((node) => node.getAttribute('data-reach-science-kit-target') === entry.instanceId);
      const facade = facades?.[entry.runtimeId];
      if (!(target instanceof HTMLElement) || !facade || typeof facade.mount !== 'function') {
        throw new Error('Reach science kit target or facade unavailable.');
      }
      mounted.set(entry.instanceId, facade.mount(target, deepFreeze(entry.envelope.spec),
        entry.geometry ? deepFreeze({
          instanceId: entry.instanceId,
          envelope: entry.envelope,
          locale,
          messages,
          geometryHostMode,
          pageId,
          sourceRevision,
          authoredSnapshot: entry.authoredSnapshot,
          canAdoptState: (candidate) => geometryStateFits(entry.instanceId, candidate),
          onStateChange: () => publishGeometryState(entry),
        }) : undefined));
    }
    try { delete window.__reachScienceKitFacades; } catch {}
  };
  const safeMount = () => {
    try { mount(); } catch (error) {
      mounted.forEach(controller => { try { controller.destroy(); } catch {} });
      mounted.clear();
      if (mountingGeometry) window.ReachInteractive.error({ code: 'geometry_mount_failed' });
      else throw error;
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeMount, { once: true });
  else safeMount();
  const restoreGeometryState = (entry, controller, restoredState, initialState) => {
    if (typeof controller?.setState !== 'function') return false;
    if (controller.setState(cloneState(restoredState))) return true;
    if (geometryHostMode !== 'authoring-edit' || !restoredState || typeof restoredState !== 'object' ||
        !initialState || typeof initialState !== 'object') return false;
    const rebound = { ...cloneState(restoredState), fingerprint: initialState.fingerprint };
    if (controller.setState(cloneState(rebound))) return true;
    const retainInputs = (current, previous) => Object.fromEntries(
      Object.entries(current && typeof current === 'object' ? current : {}).map(([key, value]) => [
        key,
        previous && typeof previous === 'object' && Object.hasOwn(previous, key)
          ? previous[key]
          : value,
      ]),
    );
    const groupIds = new Set((entry.envelope.spec.presentation.groups || []).map((group) => group.id));
    const fallback = {
      ...cloneState(initialState),
      inputs: {
        parameters: retainInputs(initialState.inputs?.parameters, restoredState.inputs?.parameters),
        freedoms: retainInputs(initialState.inputs?.freedoms, restoredState.inputs?.freedoms),
      },
      camera: cloneState(restoredState.camera ?? initialState.camera),
      visibleGroups: Array.isArray(restoredState.visibleGroups)
        ? restoredState.visibleGroups.filter((id) => groupIds.has(id))
        : initialState.visibleGroups,
      selection: null,
    };
    return Boolean(controller.setState(cloneState(fallback)));
  };
  window.addEventListener('reach-interactive-initialize', (event) => {
    if (!geometryEntries.length) return;
    const initial = new Map(geometryEntries.map((entry) => [entry.instanceId, mounted.get(entry.instanceId)?.getState?.()]));
    const restored = event.detail?.restoredSnapshot?.geometry;
    const expected = geometryEntries.map((entry) => entry.instanceId).sort();
    const actual = restored && restored.schemaVersion === 'reach-geometry-host-state/v2' && restored.instances && typeof restored.instances === 'object' && !Array.isArray(restored.instances)
      ? Object.keys(restored.instances).sort()
      : [];
    const matches = expected.length === actual.length && expected.every((id, index) => id === actual[index]);
    let accepted = matches;
    if (matches) {
      for (const entry of geometryEntries) {
        const controller = mounted.get(entry.instanceId);
        if (!restoreGeometryState(
          entry,
          controller,
          restored.instances[entry.instanceId],
          initial.get(entry.instanceId),
        )) {
          accepted = false;
          break;
        }
      }
    }
    if (!accepted) {
      for (const entry of geometryEntries) {
        const state = initial.get(entry.instanceId);
        if (state !== undefined) mounted.get(entry.instanceId)?.setState?.(state);
      }
    }
    publishGeometryState();
  });
  window.addEventListener('reach-interactive-reset', () => mounted.forEach((controller) => controller.reset()));
  window.addEventListener('reach-interactive-dispose', () => { mounted.forEach((controller) => controller.destroy()); mounted.clear(); }, { once: true });
})();`;

function parseComponentMarkers(
  document: Document,
  pageId: string,
  sourceRevision: number,
): InteractiveComponentFocusPayload[] {
  const entries = [...document.querySelectorAll<HTMLElement>('[data-reach-component-id]')].map(
    (marker): InteractiveComponentFocusPayload => {
      const componentId = marker.dataset.reachComponentId?.trim() ?? '';
      const declaredLabel = marker.dataset.reachComponentLabel?.trim();
      const detail = marker.dataset.reachComponentDetail?.trim();
      const label = declaredLabel || componentId;
      if (
        !COMPONENT_MARKER_ID_PATTERN.test(componentId) ||
        label.length < 1 ||
        label.length > COMPONENT_LABEL_MAX_CHARACTERS ||
        (detail !== undefined &&
          (detail.length < 1 || detail.length > COMPONENT_DETAIL_MAX_CHARACTERS))
      ) {
        throw new Error('Interactive component marker metadata is invalid.');
      }
      const baselineOuterHtml = marker.outerHTML;
      if (baselineOuterHtml.length > COMPONENT_BASELINE_MAX_CHARACTERS) {
        throw new Error('Interactive component marker exceeds the selection baseline limit.');
      }
      return {
        pageId,
        sourceRevision,
        componentId,
        label,
        ...(detail === undefined ? {} : { detail }),
        tagName: marker.tagName.toLowerCase(),
        baselineOuterHtml,
      };
    },
  );
  if (entries.length > COMPONENT_MARKER_MAX_COUNT) {
    throw new Error('Interactive document has too many component markers.');
  }
  if (new Set(entries.map(({ componentId }) => componentId)).size !== entries.length) {
    throw new Error('Interactive component marker ids must be unique.');
  }
  return entries;
}

export function validateInteractiveComponentFocusAgainstDocument(input: {
  payload: unknown;
  documentHtml: string;
  pageId: string;
  sourceRevision: number;
  wireSequence: number;
}): InteractiveComponentFocus | undefined {
  const payload = parseInteractiveComponentFocusPayload(input.payload);
  if (
    payload === undefined ||
    payload.pageId !== input.pageId ||
    payload.sourceRevision !== input.sourceRevision
  ) {
    return undefined;
  }
  try {
    const parser = new DOMParser();
    const document = parser.parseFromString(input.documentHtml, 'text/html');
    const matches = parseComponentMarkers(document, input.pageId, input.sourceRevision).filter(
      ({ componentId }) => componentId === payload.componentId,
    );
    if (matches.length !== 1) return undefined;
    const expected = matches[0]!;
    if (
      expected.label !== payload.label ||
      expected.detail !== payload.detail ||
      expected.tagName !== payload.tagName ||
      expected.baselineOuterHtml !== payload.baselineOuterHtml
    ) {
      return undefined;
    }
    return { ...payload, wireSequence: input.wireSequence };
  } catch {
    return undefined;
  }
}

export function validateGeometryEditProposalAgainstDocument(input: {
  payload: unknown;
  documentHtml: string;
  pageId: string;
  sourceRevision: number;
  wireSequence: number;
}): GeometryEditProposal | undefined {
  const payload = parseGeometryEditProposalPayload(input.payload);
  if (
    payload === undefined ||
    payload.pageId !== input.pageId ||
    payload.sourceRevision !== input.sourceRevision
  )
    return undefined;
  try {
    const document = new DOMParser().parseFromString(input.documentHtml, 'text/html');
    const matches = parseScienceKitMarkers(document).filter(
      (entry) => entry.geometryV2 && entry.instanceId === payload.instanceId,
    );
    if (
      matches.length !== 1 ||
      geometryEnvelopeFingerprint(matches[0]!.envelope) !== payload.fingerprint
    )
      return undefined;
    return {
      ...payload,
      envelope: matches[0]!.envelope as GeometryEnvelopeV2,
      wireSequence: input.wireSequence,
    };
  } catch {
    return undefined;
  }
}

function parseFunctionPlotMarkers(
  document: Document,
): Array<{ id: string; spec: ReachFunctionPlotSpec }> {
  const entries = [...document.querySelectorAll<HTMLElement>('[data-reach-function-plot]')].map(
    (marker) => {
      const id = marker.dataset.reachFunctionPlot?.trim() ?? '';
      if (
        marker.tagName.toLowerCase() !== 'script' ||
        (marker.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/json' ||
        !FUNCTION_PLOT_MARKER_ID_PATTERN.test(id)
      ) {
        throw new Error('Interactive function plot marker type or id is invalid.');
      }
      let candidate: unknown;
      try {
        candidate = JSON.parse(marker.textContent ?? '');
      } catch {
        throw new Error('Interactive function plot marker must contain valid JSON.');
      }
      const spec = parseReachFunctionPlotSpecValue(candidate);
      marker.textContent = safeInlineJson(spec);
      return { id, spec };
    },
  );
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error('Interactive function plot marker ids must be unique.');
  }
  return entries;
}

const safeInlineJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

const functionPlotInstallSource = (
  entries: Array<{ id: string; spec: ReachFunctionPlotSpec }>,
): string => `(() => {
  'use strict';
  const install = window.__installReachFunctionPlot;
  if (typeof install !== 'function') throw new Error('Reach function plot runtime unavailable.');
  install(${safeInlineJson(entries)});
  try { delete window.__installReachFunctionPlot; } catch {}
})();`;

export const createWireMessage = (
  nonce: string,
  sequence: number,
  type: string,
  payload: unknown,
): InteractiveWireMessage => ({
  channel: INTERACTIVE_CHANNEL,
  version: INTERACTIVE_BRIDGE_VERSION,
  nonce,
  sequence,
  type,
  payload,
});
