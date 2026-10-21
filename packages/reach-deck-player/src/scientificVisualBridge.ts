import {
  isReachScientificAnchorBindingSetUsable,
  parseReachFunctionPlotSpecValue,
  type ReachDeckNativeSlideV2,
  type ReachDeckScientificVisualElementV2,
} from '@reachany/reach-deck-dsl';

import {
  resolveReachScientificDependency,
  type ReachScientificDependencyRegistryEntry,
} from './scientificDependencyRegistry.generated.js';

export const SCIENTIFIC_VISUAL_CHANNEL = 'reach-scientific-visual' as const;
export const SCIENTIFIC_VISUAL_BRIDGE_VERSION = 'reach-scientific-visual-bridge/v1' as const;
export const SCIENTIFIC_VISUAL_INITIALIZATION_TIMEOUT_MS = 10_000;
export const SCIENTIFIC_VISUAL_MAX_WIRE_BYTES = 72 * 1024;
export const SCIENTIFIC_VISUAL_MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
export const SCIENTIFIC_VISUAL_MAX_TOTAL_RESOURCE_BYTES = 8 * 1024 * 1024;
export const SCIENTIFIC_VISUAL_MAX_CONCURRENT_RESOURCES = 4;
export const SCIENTIFIC_VISUAL_FALLBACK_DURATION_SECONDS = 5;
/**
 * Narration bindings identify the spoken trigger, whose word-aligned range may be only a few
 * hundred milliseconds. Scientific motion needs a separate deterministic presentation window so
 * generated controllers do not compress an entire mechanism transition into that word range.
 */
export const SCIENTIFIC_VISUAL_ANCHOR_PRESENTATION_SECONDS = 2.5;

export type ScientificVisualAnchorPhase = 'before' | 'active' | 'after';

export interface ScientificVisualAnchorFrame {
  id: string;
  state: ScientificVisualAnchorPhase;
  progress: number;
}

export interface ScientificVisualPresentationFrame {
  currentTime: number;
  /** Compatibility aliases for generated v1 visuals; both equal currentTime. */
  absoluteTime: number;
  time: number;
  playing: boolean;
  playbackRate: number;
  effectiveDuration: number;
  /** Convenience alias for generated controllers; equals effectiveDuration. */
  duration: number;
  anchors: ScientificVisualAnchorFrame[];
  activeNarrationSegmentId?: string;
  reducedMotion: boolean;
  staticMode: boolean;
}

export interface ScientificVisualViewport {
  logicalWidth: number;
  logicalHeight: number;
  stageScale: number;
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
}

export interface ScientificVisualWireMessage {
  channel: typeof SCIENTIFIC_VISUAL_CHANNEL;
  version: typeof SCIENTIFIC_VISUAL_BRIDGE_VERSION;
  nonce: string;
  sequence: number;
  type: string;
  payload: unknown;
}

export interface ScientificVisualSrcDocInput {
  element: ReachDeckScientificVisualElementV2;
  nonce: string;
  dependencyBaseUrl: string;
}

const PARENT_MESSAGE_TYPES = new Set([
  'initialize',
  'present',
  'resize',
  'suspend',
  'resume',
  'dispose',
]);
const CHILD_MESSAGE_TYPES = new Set(['bridge_ready', 'ready', 'error']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_ELEMENTS = 'base,form,iframe,object,embed,link,audio,video,source,track';
const FORBIDDEN_SCRIPT_TOKENS =
  /\b(?:eval|Function|localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie|window\s*\.\s*open|location\s*\.\s*(?:assign|replace)\s*\(/;
const FUNCTION_PLOT_MARKER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function createScientificVisualNonce(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function createScientificVisualWireMessage(
  nonce: string,
  sequence: number,
  type: string,
  payload: unknown,
): ScientificVisualWireMessage {
  return {
    channel: SCIENTIFIC_VISUAL_CHANNEL,
    version: SCIENTIFIC_VISUAL_BRIDGE_VERSION,
    nonce,
    sequence,
    type,
    payload,
  };
}

export function parseScientificVisualWireMessage(
  value: unknown,
  direction: 'parent' | 'child',
): ScientificVisualWireMessage | undefined {
  if (!plainRecord(value) || encodedSize(value) > SCIENTIFIC_VISUAL_MAX_WIRE_BYTES) return;
  if (
    value.channel !== SCIENTIFIC_VISUAL_CHANNEL ||
    value.version !== SCIENTIFIC_VISUAL_BRIDGE_VERSION ||
    typeof value.nonce !== 'string' ||
    value.nonce.length < 16 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.type !== 'string' ||
    !(direction === 'parent' ? PARENT_MESSAGE_TYPES : CHILD_MESSAGE_TYPES).has(value.type) ||
    !isBoundedValue(value.payload)
  ) {
    return;
  }
  return value as unknown as ScientificVisualWireMessage;
}

export function projectScientificVisualFrame(input: {
  slide: ReachDeckNativeSlideV2;
  element: ReachDeckScientificVisualElementV2;
  currentTime?: number;
  playing?: boolean;
  playbackRate?: number;
  effectiveDuration?: number;
  activeNarrationSegmentId?: string;
  reducedMotion?: boolean;
  staticMode?: boolean;
}): ScientificVisualPresentationFrame {
  const forceStatic = input.staticMode === true || input.reducedMotion === true;
  const currentTime = forceStatic
    ? 0
    : finiteNonnegative(input.currentTime)
      ? input.currentTime
      : 0;
  const effectiveDuration = positive(input.effectiveDuration)
    ? input.effectiveDuration
    : SCIENTIFIC_VISUAL_FALLBACK_DURATION_SECONDS;
  const bindings = isReachScientificAnchorBindingSetUsable(input.slide)
    ? input.slide.narration?.scientificAnchorBindings
    : undefined;
  const slot = effectiveDuration / Math.max(1, input.element.manifest.anchors.length);
  const anchors = input.element.manifest.anchors.map((anchor, index) => {
    const binding = bindings?.[index];
    if (binding === undefined) {
      return projectAnchor(anchor.id, currentTime, index * slot, (index + 1) * slot);
    }
    const nextTrigger = bindings?.[index + 1]?.start ?? effectiveDuration;
    const presentationEnd = Math.min(
      binding.start + SCIENTIFIC_VISUAL_ANCHOR_PRESENTATION_SECONDS,
      nextTrigger,
      effectiveDuration,
    );
    // Equal triggers intentionally leave the earlier anchor with no independent presentation slot;
    // the later manifest-ordered state takes over deterministically.
    return projectAnchor(anchor.id, currentTime, binding.start, presentationEnd);
  });
  return {
    currentTime,
    absoluteTime: currentTime,
    time: currentTime,
    playing: forceStatic ? false : input.playing === true,
    playbackRate: positive(input.playbackRate) ? input.playbackRate : 1,
    effectiveDuration,
    duration: effectiveDuration,
    anchors,
    ...(forceStatic || input.activeNarrationSegmentId === undefined
      ? {}
      : { activeNarrationSegmentId: input.activeNarrationSegmentId }),
    reducedMotion: input.reducedMotion === true,
    staticMode: input.staticMode === true,
  };
}

export async function buildScientificVisualSrcDoc(
  input: ScientificVisualSrcDocInput,
): Promise<string> {
  const parser = new DOMParser();
  const document = parser.parseFromString(input.element.documentHtml, 'text/html');
  validateGeneratedDocument(document);
  const functionPlotEntries = parseFunctionPlotMarkers(document);
  const dependencies = resolveDependencies(input.element, input.dependencyBaseUrl);
  if (
    functionPlotEntries.length > 0 &&
    !dependencies.some(({ entry }) => entry.id === 'function-plot')
  ) {
    throw new Error(
      'Scientific function plot markers require the approved function-plot dependency.',
    );
  }
  const functionPlotInstall =
    functionPlotEntries.length > 0 ? functionPlotInstallSource(functionPlotEntries) : undefined;
  const bootstrap = scientificBootstrapSource({
    nonce: input.nonce,
    dependencies: dependencies.map(({ entry }) => ({
      id: entry.id,
      globalName: entry.facade.globalName,
      installerGlobalName: entry.facade.installerGlobalName,
    })),
    resourceIds: input.element.manifest.resourceIds,
  });
  const inlineScripts = [...document.querySelectorAll<HTMLScriptElement>('script:not([src])')];
  const hashes = await Promise.all(
    [
      ...inlineScripts.map((script) => script.textContent ?? ''),
      ...(functionPlotInstall === undefined ? [] : [functionPlotInstall]),
      bootstrap,
    ].map(sha256CspHash),
  );
  const dependencySources = dependencies.map(({ url }) => url.href);
  const dependencyHashes = dependencies.map(({ entry }) => `'${entry.integrity}'`);
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = [
    "default-src 'none'",
    `script-src ${[...hashes, ...dependencyHashes, ...dependencySources].join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data: blob:',
    "connect-src 'none'",
    "media-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const rootStyle = document.createElement('style');
  rootStyle.dataset.reachScientificHostStyle = '';
  rootStyle.textContent =
    'html,body{width:100%;height:100%;margin:0;overflow:hidden}body{position:relative}';
  const dependencyScripts = dependencies.map(({ entry, url }) => {
    const script = document.createElement('script');
    script.src = url.href;
    script.setAttribute('integrity', entry.integrity);
    script.setAttribute('crossorigin', entry.crossOrigin);
    script.setAttribute('referrerpolicy', 'no-referrer');
    script.dataset.reachScientificDependency = `${entry.id}@${entry.version}`;
    return script;
  });
  const bootstrapScript = document.createElement('script');
  bootstrapScript.dataset.reachScientificBootstrap = '';
  bootstrapScript.textContent = bootstrap;
  const functionPlotInstallScript =
    functionPlotInstall === undefined ? undefined : document.createElement('script');
  if (functionPlotInstallScript !== undefined) {
    functionPlotInstallScript.dataset.reachScientificFunctionPlotInstall = '';
    functionPlotInstallScript.textContent = functionPlotInstall!;
  }
  document.head.prepend(
    csp,
    rootStyle,
    ...dependencyScripts,
    ...(functionPlotInstallScript === undefined ? [] : [functionPlotInstallScript]),
    bootstrapScript,
  );
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function resolveDependencies(
  element: ReachDeckScientificVisualElementV2,
  dependencyBaseUrl: string,
): Array<{ entry: ReachScientificDependencyRegistryEntry; url: URL }> {
  const base = new URL(dependencyBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Scientific dependency base URL must be an HTTP(S) origin.');
  }
  return element.manifest.dependencies.map((declaration) => {
    const entry = resolveReachScientificDependency(
      declaration.id,
      declaration.version,
      element.manifest.hooksVersion,
    );
    if (entry === undefined) {
      throw new Error(
        `Scientific dependency ${declaration.id}@${declaration.version} is not approved.`,
      );
    }
    return { entry, url: new URL(entry.scriptPath, base.origin) };
  });
}

function validateGeneratedDocument(document: Document): void {
  if (document.querySelector(FORBIDDEN_ELEMENTS) !== null) {
    throw new Error('Scientific HTML contains a forbidden element.');
  }
  if (document.querySelector('meta[http-equiv],script[src],style[src]') !== null) {
    throw new Error('Scientific HTML cannot supply policy or external code.');
  }
  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'ping' || name === 'target') {
        throw new Error('Scientific HTML contains a forbidden attribute.');
      }
      if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name)) {
        const allowedImageData =
          element.tagName === 'IMG' && /^data:image\/(?:png|jpeg|webp);/i.test(value);
        if (!(value.startsWith('#') || allowedImageData)) {
          throw new Error('Scientific HTML contains an external URL.');
        }
      }
      if (name === 'style' && hasExternalCssUrl(value)) {
        throw new Error('Scientific HTML contains an external CSS URL.');
      }
    }
  }
  for (const style of document.querySelectorAll('style')) {
    if (hasExternalCssUrl(style.textContent ?? '')) {
      throw new Error('Scientific HTML contains an external CSS URL.');
    }
  }
  for (const script of document.querySelectorAll<HTMLScriptElement>('script')) {
    const type = script.type.trim().toLowerCase();
    if (type && !['text/javascript', 'application/javascript', 'application/json'].includes(type)) {
      throw new Error('Scientific HTML contains an unsupported script type.');
    }
    if (type === 'application/json' && !script.hasAttribute('data-reach-function-plot')) {
      throw new Error('Scientific JSON scripts must be approved function-plot markers.');
    }
    if (FORBIDDEN_SCRIPT_TOKENS.test(script.textContent ?? '')) {
      throw new Error('Scientific HTML contains a forbidden runtime API.');
    }
  }
}

function parseFunctionPlotMarkers(
  document: Document,
): Array<{ id: string; spec: ReturnType<typeof parseReachFunctionPlotSpecValue> }> {
  const entries = [
    ...document.querySelectorAll<HTMLScriptElement>(
      'script[type="application/json"][data-reach-function-plot]',
    ),
  ].map((marker) => {
    const id = marker.dataset.reachFunctionPlot?.trim() ?? '';
    if (!FUNCTION_PLOT_MARKER_ID_PATTERN.test(id))
      throw new Error('Scientific function plot marker id is invalid.');
    let candidate: unknown;
    try {
      candidate = JSON.parse(marker.textContent ?? '');
    } catch {
      throw new Error('Scientific function plot marker must contain valid JSON.');
    }
    const spec = parseReachFunctionPlotSpecValue(candidate);
    marker.textContent = safeInlineJson(spec);
    return { id, spec };
  });
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error('Scientific function plot marker ids must be unique.');
  }
  return entries;
}

const functionPlotInstallSource = (
  entries: Array<{ id: string; spec: ReturnType<typeof parseReachFunctionPlotSpecValue> }>,
): string => `(() => {
  'use strict';
  const install = window.__installReachFunctionPlot;
  if (typeof install !== 'function') throw new Error('Reach function plot runtime unavailable.');
  install(${safeInlineJson(entries)});
  try { delete window.__installReachFunctionPlot; } catch {}
})();`;

function hasExternalCssUrl(value: string): boolean {
  return /@import\b/i.test(value) || /url\s*\(\s*['"]?(?!data:|blob:)/i.test(value);
}

function scientificBootstrapSource(input: {
  nonce: string;
  dependencies: Array<{ id: string; globalName: string; installerGlobalName: string }>;
  resourceIds: string[];
}): string {
  const serialized = safeInlineJson(input);
  return `(() => {
  'use strict';
  const CONFIG = ${serialized};
  const CHANNEL = ${JSON.stringify(SCIENTIFIC_VISUAL_CHANNEL)};
  const VERSION = ${JSON.stringify(SCIENTIFIC_VISUAL_BRIDGE_VERSION)};
  const declaredResources = new Set(CONFIG.resourceIds);
  const dependencyGlobals = new Map(CONFIG.dependencies.map((entry) => [entry.id, entry]));
  const pendingResources = new Map();
  const resourceUrls = new Map();
  let controllerFactory;
  let controller;
  let resourcePort;
  let parentSequence = 0;
  let childSequence = 0;
  let resourceRequestId = 0;
  let disposed = false;
  const send = (type, payload) => window.parent.postMessage({ channel: CHANNEL, version: VERSION, nonce: CONFIG.nonce, sequence: ++childSequence, type, payload }, '*');
  const fail = (code, detail) => send('error', { code, ...(detail === undefined ? {} : { detail: String(detail).slice(0, 512) }) });
  const resources = Object.freeze({
    resolve: (id) => {
      if (disposed || !declaredResources.has(id) || !resourcePort) return Promise.reject(new Error('Scientific resource is unavailable.'));
      if (resourceUrls.has(id)) return Promise.resolve(resourceUrls.get(id));
      const requestId = ++resourceRequestId;
      return new Promise((resolve, reject) => {
        pendingResources.set(requestId, { id, resolve, reject });
        resourcePort.postMessage({ type: 'resolve', requestId, id });
      });
    }
  });
  const dependencies = Object.freeze({
    get: (id) => {
      const declaration = dependencyGlobals.get(id);
      if (!declaration) throw new Error('Scientific dependency is undeclared.');
      const value = window[declaration.globalName];
      if (value === undefined) throw new Error('Scientific dependency facade is unavailable.');
      if (value && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) Object.freeze(value);
      return value;
    }
  });
  const api = Object.freeze({
    register: (candidate) => {
      if (controllerFactory !== undefined) throw new Error('Scientific controller may register only once.');
      if (typeof candidate === 'function') controllerFactory = candidate;
      else if (candidate && typeof candidate === 'object') controllerFactory = () => candidate;
      else throw new Error('Scientific controller registration is invalid.');
    }
  });
  Object.defineProperty(window, 'ReachScientificVisual', { value: api, configurable: false, writable: false });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { controller?.dispose?.(); } catch {}
    pendingResources.forEach(({ reject }) => reject(new Error('Scientific visual disposed.')));
    pendingResources.clear();
    resourceUrls.forEach((url) => URL.revokeObjectURL(url));
    resourceUrls.clear();
    resourcePort?.close();
  };
  const handleResource = (event) => {
    const message = event.data;
    if (!message || !Number.isSafeInteger(message.requestId)) return;
    const pending = pendingResources.get(message.requestId);
    if (!pending) return;
    pendingResources.delete(message.requestId);
    if (message.type !== 'resolved' || !(message.bytes instanceof ArrayBuffer) || typeof message.mimeType !== 'string') {
      pending.reject(new Error('Scientific resource resolution failed.'));
      return;
    }
    const url = URL.createObjectURL(new Blob([message.bytes], { type: message.mimeType }));
    resourceUrls.set(pending.id, url);
    pending.resolve(url);
  };
  window.addEventListener('message', (event) => {
    if (disposed || event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.version !== VERSION || message.nonce !== CONFIG.nonce || !Number.isSafeInteger(message.sequence) || message.sequence <= parentSequence) return;
    parentSequence = message.sequence;
    try {
      if (message.type === 'initialize' && !controller) {
        resourcePort = event.ports[0];
        if (!resourcePort || !controllerFactory) throw new Error('Scientific controller did not register.');
        resourcePort.onmessage = handleResource;
        resourcePort.start();
        const root = document.querySelector('[data-reach-scientific-root]') || document.body;
        controller = controllerFactory(Object.freeze({ root, dependencies, resources }));
        if (!controller || typeof controller.present !== 'function') throw new Error('Scientific controller must implement present().');
        send('ready', {});
      } else if (message.type === 'present' && controller) controller.present(message.payload);
      else if (message.type === 'resize' && controller) controller.resize?.(message.payload);
      else if (message.type === 'suspend' && controller) controller.suspend?.();
      else if (message.type === 'resume' && controller) controller.resume?.();
      else if (message.type === 'dispose') dispose();
    } catch (error) { fail('controller_error', error instanceof Error ? error.message : error); }
  });
  send('bridge_ready', {});
  try { document.currentScript?.remove(); } catch {}
})();`;
}

async function sha256CspHash(source: string): Promise<string> {
  if (crypto.subtle === undefined) throw new Error('SHA-256 is unavailable.');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)),
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `'sha256-${btoa(binary)}'`;
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function projectAnchor(
  id: string,
  time: number,
  start: number,
  end: number,
): ScientificVisualAnchorFrame {
  if (end <= start)
    return { id, state: time >= end ? 'after' : 'before', progress: time >= end ? 1 : 0 };
  if (time < start) return { id, state: 'before', progress: 0 };
  if (time >= end) return { id, state: 'after', progress: 1 };
  return {
    id,
    state: 'active',
    progress: Math.max(0, Math.min(1, (time - start) / (end - start))),
  };
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isBoundedValue(value: unknown): boolean {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 2_000 || depth > 8) return false;
    if (candidate === null || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate === 'string') return candidate.length <= 8_192;
    if (Array.isArray(candidate))
      return candidate.length <= 1_000 && candidate.every((item) => visit(item, depth + 1));
    if (!plainRecord(candidate)) return false;
    return Object.keys(candidate).every(
      (key) => !UNSAFE_KEYS.has(key) && visit(candidate[key], depth + 1),
    );
  };
  return encodedSize(value) <= SCIENTIFIC_VISUAL_MAX_WIRE_BYTES && visit(value, 0);
}
