import { readFileSync } from 'node:fs';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERACTIVE_DOCUMENT_MAX_BYTES, type InteractiveScene } from '@reachany/reach-deck-dsl';
import {
  INTERACTIVE_INITIALIZATION_TIMEOUT_MS,
  INTERACTIVE_STATE_FLUSH_TIMEOUT_MS,
  InteractiveScenePlayer,
} from '../src/InteractiveScenePlayer';
import {
  INTERACTIVE_BRIDGE_VERSION,
  INTERACTIVE_CHANNEL,
  MAX_INTERACTIVE_SRCDOC_BYTES,
  buildInteractiveSrcDoc,
  isBoundedJson,
  validateInteractiveChildMessage,
  type InteractiveWireMessage,
} from '../src/interactiveBridge';

const scene: InteractiveScene = {
  schemaVersion: 'reach-interactive-scene/v2',
  id: 'interactive-1',
  title: '探索场景',
  sceneType: 'interactive',
  documentHtml:
    '<!doctype html><html><head><title>x</title></head><body><script>ReachInteractive.ready()</script></body></html>',
  bridgeVersion: 'reach-interactive-bridge/v1',
  runtimePolicy: { completionMode: 'explicit', allowReset: true, maximumDurationSeconds: 60 },
  eventManifest: {
    schemaVersion: 'reach-interactive-event-manifest/v1',
    events: [
      {
        name: 'parameter_adjusted',
        eventVersion: 1,
        meaning: 'Learner adjusted a simulation parameter.',
        payloadFields: [
          {
            name: 'value',
            type: 'number',
            required: true,
            minimum: 0,
            maximum: 100,
          },
        ],
        delivery: { mode: 'immediate' },
      },
      {
        name: 'position_changed',
        eventVersion: 1,
        meaning: 'Learner changed the current position.',
        payloadFields: [
          { name: 'position', type: 'integer', required: true, minimum: 0, maximum: 100 },
        ],
        delivery: { mode: 'latest', intervalMs: 500 },
      },
    ],
  },
};

const ATTEMPT_2_READY_SCRIPT = `
const bridge = window.ReachInteractive;
const detail = bridge.getInitialization();
bridge.ready({
  restored: false,
  restoreToken: detail && detail.restoreToken ? detail.restoreToken : null
});`;

const playerStyles = readFileSync('styles.css', 'utf8');

describe('InteractiveScenePlayer sandbox bridge', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const stubAnimationFrames = () => {
    let nextId = 1;
    let callbacks = new Map<number, FrameRequestCallback>();
    const request = vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
    const cancel = vi.fn((id: number) => callbacks.delete(id));
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    return {
      request,
      flush: () => {
        const pending = [...callbacks.values()];
        callbacks = new Map();
        pending.forEach((callback) => callback(performance.now()));
      },
    };
  };

  const mount = (props: Partial<React.ComponentProps<typeof InteractiveScenePlayer>> = {}) => {
    act(() => root.render(<InteractiveScenePlayer scene={scene} {...props} />));
    return host.querySelector('iframe') as HTMLIFrameElement;
  };
  const nonceFrom = (frame: HTMLIFrameElement) => {
    const match = frame.srcdoc.match(/const NONCE = "([^"]+)"/);
    if (!match) throw new Error('nonce missing');
    return match[1];
  };
  const childMessage = (
    frame: HTMLIFrameElement,
    nonce: string,
    sequence: number,
    type: string,
    payload: unknown = {},
  ) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: {
            channel: INTERACTIVE_CHANNEL,
            version: INTERACTIVE_BRIDGE_VERSION,
            nonce,
            sequence,
            type,
            payload,
          },
        }),
      );
    });
  const postedMessage = (post: ReturnType<typeof vi.spyOn>, type: string) =>
    post.mock.calls
      .map(([message]) => message as { type: string; payload: Record<string, unknown> })
      .find((message) => message.type === type);

  it('keeps the iframe when translation functions change identity but their messages do not', () => {
    const frame = mount({ translate: (key) => key });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    mount({ translate: (key) => key });
    expect(nonceFrom(frame)).toBe(nonce);
    expect(postedMessage(post, 'ping')).toBeUndefined();
    expect(postedMessage(post, 'dispose')).toBeUndefined();
  });

  it.each([true, false])(
    'flushes the latest snapshot before locale remount (visible=%s)',
    async (visible) => {
      const onStateChange = vi.fn();
      const frame = mount({ visible, onStateChange, restoredSnapshot: { value: 1 } });
      const nonce = nonceFrom(frame);
      childMessage(frame, nonce, 1, 'bridge_ready');
      childMessage(frame, nonce, 2, 'ready', { restored: false });
      const post = vi.spyOn(frame.contentWindow!, 'postMessage');
      mount({ visible, locale: 'zh-CN', onStateChange, restoredSnapshot: { value: 1 } });
      const ping = postedMessage(post, 'ping');
      expect(ping?.payload).toMatchObject({ flushState: true, heartbeatId: 1 });
      expect(nonceFrom(frame)).toBe(nonce);
      expect(postedMessage(post, 'dispose')).toBeUndefined();
      childMessage(frame, nonce, 3, 'stateChange', { value: 7 });
      expect(onStateChange).toHaveBeenLastCalledWith({ value: 7 });
      await act(async () => {
        childMessage(frame, nonce, 4, 'pong', { heartbeatId: 1 });
      });
      const nextNonce = nonceFrom(frame);
      expect(nextNonce).not.toBe(nonce);
      expect(postedMessage(post, 'dispose')).toBeDefined();
      post.mockClear();
      childMessage(frame, nextNonce, 1, 'bridge_ready');
      expect(postedMessage(post, 'initialize')?.payload).toMatchObject({
        restoredSnapshot: { value: 7 },
        restoreToken: expect.any(String),
      });
      childMessage(frame, nextNonce, 2, 'ready', { restored: false });
      expect(frame.dataset.bridgeRestored).toBe('false');
    },
  );

  it.each([
    { label: 'fresh equal', replacement: { nested: { value: 1, enabled: true } }, expected: 7 },
    { label: 'reordered equal', replacement: { nested: { enabled: true, value: 1 } }, expected: 7 },
    { label: 'changed', replacement: { nested: { value: 2, enabled: true } }, expected: 2 },
  ])('handles a $label host snapshot after a locale flush', async ({ replacement, expected }) => {
    const onStateChange = vi.fn();
    const frame = mount({
      onStateChange,
      restoredSnapshot: { nested: { value: 1, enabled: true } },
    });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    mount({
      locale: 'zh-CN',
      onStateChange,
      restoredSnapshot: { nested: { value: 1, enabled: true } },
    });
    const ping = postedMessage(post, 'ping');
    expect(ping?.payload.flushState).toBe(true);
    childMessage(frame, nonce, 3, 'stateChange', { nested: { value: 7, enabled: true } });
    expect(onStateChange).toHaveBeenLastCalledWith({ nested: { value: 7, enabled: true } });
    mount({ locale: 'zh-CN', onStateChange, restoredSnapshot: replacement });
    await act(async () => {
      childMessage(frame, nonce, 4, 'pong', { heartbeatId: ping?.payload.heartbeatId });
    });
    const nextNonce = nonceFrom(frame);
    expect(nextNonce).not.toBe(nonce);
    post.mockClear();
    childMessage(frame, nextNonce, 1, 'bridge_ready');
    expect(postedMessage(post, 'initialize')?.payload.restoredSnapshot).toEqual({
      nested: { value: expected, enabled: true },
    });
  });

  it('waits for the matching flush acknowledgment and uses the last requested localization', async () => {
    const frame = mount();
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    mount({ locale: 'zh-CN' });
    mount({
      locale: 'en-US',
      translate: (key) => (key === 'reachDeck.geometry.reset' ? 'Reset experiment' : key),
    });
    expect(post.mock.calls.filter(([message]) => message.type === 'ping')).toHaveLength(1);
    await act(async () => {
      childMessage(frame, nonce, 3, 'pong', { heartbeatId: 99 });
    });
    expect(nonceFrom(frame)).toBe(nonce);
    await act(async () => {
      childMessage(frame, nonce, 4, 'pong', { heartbeatId: 1 });
    });
    expect(nonceFrom(frame)).not.toBe(nonce);
    // The serialization identity includes messages even when the requested locale is unchanged.
    expect(frame.dataset.bridgePhase).toBe('booting');
  });

  it('resumes the existing iframe after a locale switch is cancelled', async () => {
    const frame = mount();
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    mount({ locale: 'zh-CN' });
    mount({ locale: 'en-US' });
    await act(async () => {
      childMessage(frame, nonce, 3, 'pong', { heartbeatId: 1 });
    });
    expect(nonceFrom(frame)).toBe(nonce);
    expect(postedMessage(post, 'resume')).toBeDefined();
    expect(postedMessage(post, 'dispose')).toBeUndefined();
  });

  it('fails a locale switch on flush timeout and retries using the latest requested localization', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const frame = mount({ onError });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    mount({ locale: 'zh-CN', onError });
    await act(async () => {
      vi.advanceTimersByTime(INTERACTIVE_STATE_FLUSH_TIMEOUT_MS);
    });
    expect(nonceFrom(frame)).toBe(nonce);
    expect(frame.dataset.bridgePhase).toBe('failed');
    expect(onError).toHaveBeenCalledWith({ code: 'state_flush_timeout' });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => {
      (host.querySelector('button') as HTMLButtonElement).click();
    });
    expect(nonceFrom(frame)).not.toBe(nonce);
    expect(frame.dataset.bridgePhase).toBe('booting');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('switches localization before activation without waiting for an impossible active-state pong', async () => {
    const frame = mount();
    const nonce = nonceFrom(frame);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await act(async () => {
      mount({ locale: 'zh-CN' });
    });
    expect(nonceFrom(frame)).not.toBe(nonce);
    expect(postedMessage(post, 'ping')).toBeUndefined();
  });

  it('cancels a pending flush when another scene replaces the iframe', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const frame = mount({ onError });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    mount({ locale: 'zh-CN', onError });
    await act(async () => {
      mount({ scene: { ...scene, id: 'replacement' }, locale: 'zh-CN', onError });
    });
    const nextNonce = nonceFrom(frame);
    childMessage(frame, nextNonce, 1, 'bridge_ready');
    childMessage(frame, nextNonce, 2, 'ready');
    await act(async () => {
      vi.advanceTimersByTime(INTERACTIVE_STATE_FLUSH_TIMEOUT_MS);
    });
    expect(frame.dataset.bridgePhase).toBe('active');
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps standalone height defaults behind the shared Interactive CSS contract', () => {
    expect(playerStyles).toMatch(
      /\.interactive-scene-player-shell\s*\{[^}]*height:\s*var\(--reach-deck-interactive-height, min\(70vh, 720px\)\);[^}]*min-height:\s*var\(--reach-deck-interactive-min-height, 34rem\);/s,
    );
    expect(playerStyles).toMatch(
      /\.interactive-scene-player\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s,
    );
  });

  it('creates an opaque iframe with storage compatibility and a code-owned CSP', () => {
    const frame = mount();
    expect(frame.classList.contains('interactive-scene-player')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.srcdoc.indexOf('data-reach-storage-shim')).toBeLessThan(
      frame.srcdoc.indexOf('<title>x</title>'),
    );
    expect(frame.srcdoc.indexOf('const CHANNEL')).toBeLessThan(
      frame.srcdoc.indexOf('ReachInteractive.ready()'),
    );
    expect(frame.srcdoc).toContain('Content-Security-Policy');
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(frame.srcdoc).toContain('localStorage');
    expect(frame.srcdoc).toContain('data-reach-root-scroll');
    expect(frame.srcdoc).toContain('overflow-y: auto !important');
    expect(frame.srcdoc).toContain('overflow: visible !important');
  });

  it.each([
    '<div data-reach-function-plot="main">{}</div>',
    '<script data-reach-function-plot="main">{}</script>',
    '<script type="text/plain" data-reach-function-plot="main">{}</script>',
  ])('rejects non-contract function-plot markers with and without a dependency', (marker) => {
    for (const runtimeDependencies of [
      [],
      [{ id: 'function-plot' as const, version: '1.25.4' as const }],
    ]) {
      expect(() =>
        buildInteractiveSrcDoc({
          documentHtml: `<!doctype html><html><head></head><body>${marker}</body></html>`,
          nonce: '1234567890abcdef',
          allowReset: true,
          eventManifest: scene.eventManifest,
          runtimeDependencies,
        }),
      ).toThrow(/function plot marker/);
    }
  });

  it('keeps a maximum-size document with every pinned runtime inside the assembled limit', () => {
    const plotSpec = {
      schemaVersion: 'reach-function-plot/v1',
      ariaLabel: 'Plot',
      viewport: { x: [-5, 5], y: [-5, 5] },
      axes: { grid: true },
      series: [{ id: 'curve', expression: 'x', colorToken: 'accent' }],
      parameters: [],
      markers: [],
      intersections: [],
    };
    const prefix =
      '<!doctype html><html><head></head><body><div class="animate__animated"></div>' +
      `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(plotSpec)}</script>` +
      '<script>ReachExpression.evaluate("x + 1", { x: 1 });</script><p>';
    const suffix = '</p></body></html>';
    const fixedBytes = new TextEncoder().encode(prefix + suffix).byteLength;
    const documentHtml = prefix + 'x'.repeat(INTERACTIVE_DOCUMENT_MAX_BYTES - fixedBytes) + suffix;

    expect(new TextEncoder().encode(documentHtml).byteLength).toBe(INTERACTIVE_DOCUMENT_MAX_BYTES);
    const source = buildInteractiveSrcDoc({
      documentHtml,
      nonce: '1234567890abcdef',
      allowReset: true,
      eventManifest: scene.eventManifest,
      runtimeDependencies: [
        { id: 'animate-css', version: '4.1.1' },
        { id: 'expression', version: '3.0.3' },
        { id: 'function-plot', version: '1.25.4' },
      ],
    });

    expect(source).toContain('data-reach-interactive-runtime="animate-css@4.1.1"');
    expect(source).toContain('data-reach-interactive-runtime="expression@3.0.3"');
    expect(source).toContain('data-reach-interactive-runtime="function-plot@1.25.4"');
    expect(new TextEncoder().encode(source).byteLength).toBeLessThan(MAX_INTERACTIVE_SRCDOC_BYTES);
  });

  it('accepts only independently validated marked-component focus in authoring mode', () => {
    const onComponentFocus = vi.fn();
    const documentHtml =
      '<!doctype html><html><head><title>x</title></head><body><section data-reach-component-id="graph" data-reach-component-label="函数图" data-reach-component-detail="展示参数关系"><span>Graph</span></section><script>ReachInteractive.ready({restored:false})</script></body></html>';
    const focusedScene = { ...scene, documentHtml };
    const frame = mount({ scene: focusedScene, authoring: true, onComponentFocus });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready', { restored: false });

    const parsed = new DOMParser().parseFromString(documentHtml, 'text/html');
    const baselineOuterHtml = parsed.querySelector('[data-reach-component-id]')!.outerHTML;
    const payload = {
      pageId: 'interactive-1',
      sourceRevision: 1,
      componentId: 'graph',
      label: '函数图',
      detail: '展示参数关系',
      tagName: 'section',
      baselineOuterHtml,
    };
    childMessage(frame, nonce, 3, 'component_focus', {
      ...payload,
      baselineOuterHtml: '<section data-reach-component-id="graph">forged</section>',
    });
    expect(onComponentFocus).not.toHaveBeenCalled();

    childMessage(frame, nonce, 4, 'component_focus', payload);
    expect(onComponentFocus).toHaveBeenCalledWith(
      expect.objectContaining({
        componentId: 'graph',
        label: '函数图',
        pageId: 'interactive-1',
        wireSequence: 4,
      }),
    );
  });

  it('defers the initialize event until generated author scripts and runtimes have loaded', () => {
    const source = buildInteractiveSrcDoc({
      documentHtml:
        '<!doctype html><html><head></head><body><script>window.addEventListener("reach-interactive-initialize", () => ReachInteractive.ready({ restored: false }))</script></body></html>',
      nonce: '1234567890abcdef',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });

    expect(source).toContain(
      "window.addEventListener('load', scheduleInitialization, { once: true })",
    );
    expect(source).toContain(
      'const scheduleInitialization = () => setTimeout(dispatchInitialization, 0)',
    );
    expect(source).toContain(
      'getInitialization: () => initializationDispatched ? initialization : undefined',
    );
    expect(source).toContain('initializationDispatched = true');
    expect(source).toContain("if (phase === 'active' || phase === 'disposed') return");
  });

  it.each([
    {
      name: 'large function-plot runtime',
      documentHtml: (authorScript: string) => {
        const plotSpec = {
          schemaVersion: 'reach-function-plot/v1',
          ariaLabel: 'Plot',
          viewport: { x: [-5, 5], y: [-5, 5] },
          axes: { grid: true },
          series: [{ id: 'curve', expression: 'x', colorToken: 'accent' }],
          parameters: [],
          markers: [],
          intersections: [],
        };
        return `<!doctype html><html><head></head><body><div data-reach-function-plot-target="main"></div><script type="application/json" data-reach-function-plot="main">${JSON.stringify(plotSpec)}</script><script>${authorScript}</script></body></html>`;
      },
    },
    {
      name: 'ordinary page without an external runtime',
      documentHtml: (authorScript: string) =>
        `<!doctype html><html><head></head><body><script>${authorScript}</script></body></html>`,
    },
  ])(
    'does not lose initialize when the body listener is registered after DOMContentLoaded for $name',
    ({ documentHtml }) => {
      const source = buildInteractiveSrcDoc({
        documentHtml: documentHtml(
          'window.__reachAuthorRan = true; window.addEventListener("reach-interactive-initialize", () => ReachInteractive.ready({ restored: false }));',
        ),
        nonce: '1234567890123456',
        allowReset: true,
        eventManifest: scene.eventManifest,
      });
      const parsed = new DOMParser().parseFromString(source, 'text/html');
      const scripts = [...parsed.querySelectorAll('script')];
      const bootstrap = scripts.find((script) =>
        script.textContent?.includes('const CHANNEL = "reach-interactive"'),
      )?.textContent;
      const authorScript = scripts.at(-1)?.textContent;
      if (bootstrap === undefined || authorScript === undefined) throw new Error('scripts missing');

      vi.useFakeTimers();
      const messages: Array<{ type: string; payload: unknown }> = [];
      const listeners = new Map<
        string,
        Array<(event?: { source?: unknown; data?: unknown }) => void>
      >();
      const addListener = (
        name: string,
        listener: (event?: { source?: unknown; data?: unknown }) => void,
      ) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      };
      const dispatch = (name: string, event?: { source?: unknown; data?: unknown }) => {
        listeners.get(name)?.forEach((listener) => listener(event));
      };
      const parent = {
        postMessage: (message: { type: string; nonce: string; payload: unknown }) => {
          messages.push(message);
          if (message.type === 'bridge_ready') {
            dispatch('message', {
              source: parent,
              data: {
                channel: INTERACTIVE_CHANNEL,
                version: INTERACTIVE_BRIDGE_VERSION,
                nonce: message.nonce,
                sequence: 1,
                type: 'initialize',
                payload: { attempt: 1 },
              },
            });
          }
        },
      };
      const childDocument = {
        readyState: 'loading',
        currentScript: { remove: vi.fn() },
        documentElement: { dataset: {} },
        getAnimations: () => [],
        querySelectorAll: () => [],
        addEventListener: addListener,
      };
      const childWindow: Record<string, unknown> = {
        parent,
        addEventListener: addListener,
        dispatchEvent: (event: Event) => dispatch(event.type),
      };
      Function('window', 'document', bootstrap)(childWindow, childDocument);
      dispatch('DOMContentLoaded');
      vi.runAllTimers();
      Function(
        'window',
        'document',
        `const ReachInteractive = window.ReachInteractive; ${authorScript}`,
      )(childWindow, childDocument);
      childDocument.readyState = 'complete';
      dispatch('load');
      vi.runAllTimers();

      expect(messages.map(({ type }) => type)).toEqual(['bridge_ready', 'ready']);
    },
  );

  it('keeps an early ready call queued and preserves a throwing body script as a timeout', async () => {
    const source = buildInteractiveSrcDoc({
      documentHtml:
        '<!doctype html><html><head></head><body><script>ReachInteractive.ready({ restored: false });</script></body></html>',
      nonce: '1234567890123456',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });
    const messages: Array<{ type: string; payload: unknown }> = [];
    const dom = new JSDOM(source, {
      runScripts: 'dangerously',
      beforeParse: (window) => {
        Object.defineProperty(window, 'postMessage', {
          configurable: true,
          value: (message: { type: string; nonce: string }) => {
            messages.push(message as unknown as { type: string; payload: unknown });
            if (message.type === 'bridge_ready') {
              window.dispatchEvent(
                new window.MessageEvent('message', {
                  source: window.parent as unknown as Window,
                  data: {
                    channel: INTERACTIVE_CHANNEL,
                    version: INTERACTIVE_BRIDGE_VERSION,
                    nonce: message.nonce,
                    sequence: 1,
                    type: 'initialize',
                    payload: { attempt: 1 },
                  },
                }),
              );
            }
          },
        });
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(messages.map(({ type }) => type)).toEqual(['bridge_ready', 'ready']);
    dom.window.close();

    const throwingSource = buildInteractiveSrcDoc({
      documentHtml:
        '<!doctype html><html><head></head><body><script>throw new Error("author failed")</script></body></html>',
      nonce: '1234567890123456',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });
    const throwingMessages: string[] = [];
    const virtualConsole = new VirtualConsole();
    const throwingDom = new JSDOM(throwingSource, {
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse: (window) => {
        Object.defineProperty(window, 'postMessage', {
          configurable: true,
          value: (message: { type: string; nonce: string }) => {
            throwingMessages.push(message.type);
            if (message.type === 'bridge_ready') {
              window.dispatchEvent(
                new window.MessageEvent('message', {
                  source: window.parent as unknown as Window,
                  data: {
                    channel: INTERACTIVE_CHANNEL,
                    version: INTERACTIVE_BRIDGE_VERSION,
                    nonce: message.nonce,
                    sequence: 1,
                    type: 'initialize',
                    payload: { attempt: 1 },
                  },
                }),
              );
            }
          },
        });
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(throwingMessages).toEqual(['bridge_ready']);
    throwingDom.window.close();
  });

  it('executes the pinned function-plot runtime before the load-gated initialize event', async () => {
    const plotSpec = {
      schemaVersion: 'reach-function-plot/v1',
      ariaLabel: 'Plot',
      viewport: { x: [-5, 5], y: [-5, 5] },
      axes: { grid: true },
      series: [{ id: 'curve', expression: 'x', colorToken: 'accent' }],
      parameters: [],
      markers: [],
      intersections: [],
    };
    const source = buildInteractiveSrcDoc({
      documentHtml: `<!doctype html><html><head></head><body><div id="plot"></div><script type="application/json" data-reach-function-plot="main">${JSON.stringify(plotSpec)}</script><script>window.addEventListener('load', () => { window.__reachRuntimeAvailable = typeof window.ReachFunctionPlot?.config === 'function'; window.addEventListener('reach-interactive-initialize', () => window.ReachInteractive.ready({ restored: false }), { once: true }); }, { once: true });</script></body></html>`,
      nonce: '1234567890123456',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });
    const messages: Array<{ type: string; payload: unknown }> = [];
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(source, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse: (window) => {
        Object.defineProperty(window, 'postMessage', {
          configurable: true,
          value: (message: { type: string; nonce: string; payload: unknown }) => {
            messages.push(message);
            if (message.type === 'bridge_ready') {
              window.dispatchEvent(
                new window.MessageEvent('message', {
                  source: window.parent as unknown as Window,
                  data: {
                    channel: INTERACTIVE_CHANNEL,
                    version: INTERACTIVE_BRIDGE_VERSION,
                    nonce: message.nonce,
                    sequence: 1,
                    type: 'initialize',
                    payload: { attempt: 1 },
                  },
                }),
              );
            }
          },
        });
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      (dom.window as unknown as { __reachRuntimeAvailable?: boolean }).__reachRuntimeAvailable,
    ).toBe(true);
    expect(messages.map(({ type }) => type)).toEqual(['bridge_ready', 'ready']);
    dom.window.close();
  });

  it('does not enable marked-component focus for learner iframes', () => {
    const onComponentFocus = vi.fn();
    const documentHtml =
      '<!doctype html><html><head></head><body><section data-reach-component-id="graph">Graph</section><section data-reach-component-id="graph">Legacy duplicate marker</section><script>ReachInteractive.ready({restored:false})</script></body></html>';
    const frame = mount({ scene: { ...scene, documentHtml }, onComponentFocus });
    expect(frame.srcdoc).toContain('const AUTHORING = false');
    expect(frame.srcdoc).not.toContain('data-reach-interactive-runtime="expression@3.0.3"');
  });

  it('accepts only the exact child window, nonce, sequence and phase, then restores state', () => {
    const phases: string[] = [];
    const onReady = vi.fn();
    const onStateChange = vi.fn();
    const frame = mount({
      restoredSnapshot: { score: 2 },
      onReady,
      onStateChange,
      onPhaseChange: (phase) => phases.push(phase),
    });
    const nonce = nonceFrom(frame);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');

    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          data: {
            channel: INTERACTIVE_CHANNEL,
            version: INTERACTIVE_BRIDGE_VERSION,
            nonce,
            sequence: 1,
            type: 'bridge_ready',
            payload: {},
          },
        }),
      ),
    );
    expect(post).not.toHaveBeenCalled();
    childMessage(frame, 'wrong-nonce-value-that-is-long', 1, 'bridge_ready');
    expect(post).not.toHaveBeenCalled();
    childMessage(frame, nonce, 1, 'bridge_ready');
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'initialize',
        payload: expect.objectContaining({ restoredSnapshot: { score: 2 } }),
      }),
      '*',
    );
    const restoreToken = postedMessage(post, 'initialize')?.payload.restoreToken;
    expect(restoreToken).toEqual(expect.any(String));
    childMessage(frame, nonce, 2, 'ready', { restored: true, restoreToken });
    childMessage(frame, nonce, 3, 'stateChange', { score: 3 });
    expect(onReady).toHaveBeenCalledOnce();
    expect(onStateChange).toHaveBeenCalledWith({ score: 3 });
    expect(phases).toEqual(
      expect.arrayContaining(['booting', 'bridge_ready', 'initializing', 'active']),
    );
  });

  it('uses a fresh nonce for every effect setup and ignores stale messages on a reused iframe window', () => {
    const onReady = vi.fn();
    const frame = mount({ sourceRevision: 1, onReady });
    const staleNonce = nonceFrom(frame);
    const childWindow = frame.contentWindow;

    act(() =>
      root.render(<InteractiveScenePlayer scene={scene} sourceRevision={2} onReady={onReady} />),
    );
    const reusedFrame = host.querySelector('iframe') as HTMLIFrameElement;
    const currentNonce = nonceFrom(reusedFrame);
    expect(reusedFrame.contentWindow).toBe(childWindow);
    expect(currentNonce).not.toBe(staleNonce);

    childMessage(reusedFrame, staleNonce, 1, 'bridge_ready');
    childMessage(reusedFrame, staleNonce, 2, 'ready', {});
    expect(onReady).not.toHaveBeenCalled();
    expect(reusedFrame.srcdoc).not.toBe('');
    childMessage(reusedFrame, currentNonce, 1, 'bridge_ready');
    childMessage(reusedFrame, currentNonce, 2, 'ready', {});
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('reloads the current document once when a stale document is still booting in the frame', () => {
    const onReady = vi.fn();
    const frame = mount({ sourceRevision: 1, onReady });
    const staleNonce = nonceFrom(frame);
    act(() =>
      root.render(<InteractiveScenePlayer scene={scene} sourceRevision={2} onReady={onReady} />),
    );
    const reusedFrame = host.querySelector('iframe') as HTMLIFrameElement;
    const currentNonce = nonceFrom(reusedFrame);
    const currentSrcDoc = reusedFrame.srcdoc;
    const assigned: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
    Object.defineProperty(reusedFrame, 'srcdoc', {
      configurable: true,
      get: () => descriptor.get!.call(reusedFrame),
      set: (value: string) => {
        assigned.push(value);
        descriptor.set!.call(reusedFrame, value);
      },
    });

    // The browser kept the first document: its handshake carries the old nonce.
    childMessage(reusedFrame, staleNonce, 1, 'bridge_ready');
    expect(assigned).toEqual([currentSrcDoc]);
    expect(reusedFrame.dataset.staleDocumentReloaded).toBe('true');
    expect(reusedFrame.dataset.bridgePhase).toBe('booting');
    childMessage(reusedFrame, staleNonce, 2, 'bridge_ready');
    expect(assigned).toHaveLength(1);

    childMessage(reusedFrame, currentNonce, 1, 'bridge_ready');
    childMessage(reusedFrame, currentNonce, 2, 'ready', {});
    expect(onReady).toHaveBeenCalledOnce();
    expect(reusedFrame.dataset.bridgePhase).toBe('active');
  });

  it('treats restore acknowledgement as advisory', () => {
    const onError = vi.fn();
    const frame = mount({ restoredSnapshot: { score: 2 }, onError });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready', { restored: true, restoreToken: 'stale-token' });
    expect(onError).not.toHaveBeenCalled();
    expect(frame.dataset.bridgePhase).toBe('active');
    expect(frame.srcdoc).not.toBe('');

    const source = buildInteractiveSrcDoc({
      documentHtml: scene.documentHtml,
      nonce: '1234567890123456',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });
    expect(source).toContain("send('ready', readyPayload)");
    expect(source).toContain("queueSignal('stateChange', snapshot)");
    expect(source).not.toContain("queueSignal('progress', payload)");
    expect(source).toContain('setTimeout(flushSignals, 100)');
    expect(source).not.toContain(
      '{ restored: initialization && initialization.restoredSnapshot !== undefined }',
    );
  });

  it('publishes geometry initialized before the author scene becomes ready', () => {
    const source = buildInteractiveSrcDoc({
      documentHtml: scene.documentHtml,
      nonce: '1234567890123456',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const bootstrap = [...parsed.querySelectorAll('script')].find((script) =>
      script.textContent?.includes('const CHANNEL = "reach-interactive"'),
    )?.textContent;
    if (!bootstrap) throw new Error('bootstrap missing');
    const messages: Array<{ type: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: { source?: unknown; data?: unknown }) => void>();
    const parent = {
      postMessage: (message: { type: string; payload: unknown }) => messages.push(message),
    };
    const childWindow: Record<string, unknown> = {
      parent,
      addEventListener: (
        name: string,
        listener: (event: { source?: unknown; data?: unknown }) => void,
      ) => listeners.set(name, listener),
      dispatchEvent: vi.fn(),
    };
    const childDocument = {
      currentScript: { remove: vi.fn() },
      documentElement: { dataset: {} },
      getAnimations: () => [],
      querySelectorAll: () => [],
    };
    Function('window', 'document', bootstrap)(childWindow, childDocument);
    listeners.get('message')?.({
      source: parent,
      data: {
        channel: INTERACTIVE_CHANNEL,
        version: INTERACTIVE_BRIDGE_VERSION,
        nonce: '1234567890123456',
        sequence: 1,
        type: 'initialize',
        payload: { attempt: 1 },
      },
    });
    const api = childWindow.ReachInteractive as {
      geometryStateChange: (instances: unknown) => boolean;
      ready: () => void;
    };
    messages.length = 0;
    expect(api.geometryStateChange({ geometry_main: { revision: 1 } })).toBe(true);
    expect(messages).toEqual([]);
    api.ready();
    expect(messages).toEqual([
      expect.objectContaining({ type: 'ready' }),
      expect.objectContaining({
        type: 'stateChange',
        payload: {
          kind: 'interactive',
          geometry: {
            schemaVersion: 'reach-geometry-host-state/v2',
            instances: { geometry_main: { revision: 1 } },
          },
        },
      }),
    ]);
  });

  it('normalizes the absent optional restore token used by the real attempt-2 author script', () => {
    const documentHtml = `<!doctype html><html><head></head><body><svg></svg><script>${ATTEMPT_2_READY_SCRIPT}</script></body></html>`;
    const source = buildInteractiveSrcDoc({
      documentHtml,
      nonce: '1234567890123456',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const scripts = [...parsed.querySelectorAll('script')];
    const bootstrap = scripts.find((script) =>
      script.textContent?.includes('const CHANNEL = "reach-interactive"'),
    )?.textContent;
    const authorScript = scripts.find((script) =>
      script.textContent?.includes('restoreToken : null'),
    )?.textContent;
    if (bootstrap === undefined || authorScript === undefined) throw new Error('scripts missing');

    const messages: InteractiveWireMessage[] = [];
    const listeners = new Map<string, (event: { source?: unknown; data?: unknown }) => void>();
    const parent = {
      postMessage: (message: InteractiveWireMessage) => messages.push(message),
    };
    const childWindow: Record<string, unknown> = {
      parent,
      addEventListener: (
        name: string,
        listener: (event: { source?: unknown; data?: unknown }) => void,
      ) => listeners.set(name, listener),
      dispatchEvent: vi.fn(),
    };
    const childDocument = {
      currentScript: { remove: vi.fn() },
      documentElement: { dataset: {} },
      getAnimations: () => [],
      querySelectorAll: () => [],
    };
    Function('window', 'document', bootstrap)(childWindow, childDocument);
    listeners.get('message')?.({
      source: parent,
      data: {
        channel: INTERACTIVE_CHANNEL,
        version: INTERACTIVE_BRIDGE_VERSION,
        nonce: '1234567890123456',
        sequence: 1,
        type: 'initialize',
        payload: { attempt: 2 },
      },
    });
    Function('window', 'document', authorScript)(childWindow, childDocument);

    const ready = messages.find((message) => message.type === 'ready');
    if (ready === undefined) throw new Error('ready message missing');
    expect(ready.payload).toEqual({ restored: false });
    expect(validateInteractiveChildMessage(ready, 'initializing')).toBe('valid');
    expect(
      validateInteractiveChildMessage(
        {
          ...ready,
          payload: { restored: false, restoreToken: null },
        },
        'initializing',
      ),
    ).toBe('invalid_payload');
  });

  it('suspends hidden scenes and resyncs the compositor when an active scene becomes visible', () => {
    const animationFrames = stubAnimationFrames();
    const onStateChange = vi.fn();
    const frame = mount({ visible: false, onStateChange });
    const nonce = nonceFrom(frame);
    const originalSrcDoc = frame.srcdoc;
    const originalWindow = frame.contentWindow;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');

    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready', {});
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'suspend' }), '*');
    expect(frame.dataset.compositorResyncState).toBe('pending');
    expect(animationFrames.request).not.toHaveBeenCalled();

    childMessage(frame, nonce, 3, 'stateChange', { hidden: true });
    expect(onStateChange).not.toHaveBeenCalled();

    act(() =>
      root.render(<InteractiveScenePlayer scene={scene} visible onStateChange={onStateChange} />),
    );
    const reusedFrame = host.querySelector('iframe') as HTMLIFrameElement;
    expect(reusedFrame.contentWindow).toBe(originalWindow);
    expect(reusedFrame.srcdoc).toBe(originalSrcDoc);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'resume' }), '*');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }), '*');
    expect(reusedFrame.dataset.compositorResyncState).toBe('scheduled');

    act(() => animationFrames.flush());
    act(() => animationFrames.flush());
    expect(reusedFrame.dataset.compositorResyncCount).toBe('1');
    expect(reusedFrame.dataset.compositorResyncState).toBe('complete');
    expect(reusedFrame.style.display).toBe('');
  });

  it('does not terminate or blank the document on later iframe loads', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const frame = mount({ onError });
    const nonce = nonceFrom(frame);
    act(() => frame.dispatchEvent(new Event('load')));
    act(() => frame.dispatchEvent(new Event('load')));
    expect(frame.srcdoc).not.toBe('');
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready', {});
    act(() => frame.dispatchEvent(new Event('load')));
    act(() => frame.dispatchEvent(new Event('load')));
    expect(onError).not.toHaveBeenCalled();
    expect(frame.dataset.bridgePhase).toBe('active');
    expect(frame.srcdoc).not.toBe('');
  });

  it('ignores code-owned navigation signals', () => {
    const onError = vi.fn();
    const frame = mount({ onError });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'navigation', { reason: 'pagehide' });
    expect(onError).not.toHaveBeenCalled();
    expect(frame.srcdoc).not.toBe('');
  });

  it('ignores unknown, wrong-phase, and malformed messages', () => {
    const onError = vi.fn();
    let frame = mount({ onError });
    let nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'invented', {});
    expect(onError).not.toHaveBeenCalled();

    act(() =>
      root.render(
        <InteractiveScenePlayer scene={{ ...scene, id: 'interactive-phase' }} onError={onError} />,
      ),
    );
    frame = host.querySelector('iframe') as HTMLIFrameElement;
    nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'stateChange', { score: 1 });
    expect(onError).not.toHaveBeenCalled();

    act(() =>
      root.render(
        <InteractiveScenePlayer
          scene={{ ...scene, id: 'interactive-payload' }}
          onError={onError}
        />,
      ),
    );
    frame = host.querySelector('iframe') as HTMLIFrameElement;
    nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready', { unexpected: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not expire an active scene because of elapsed time or background timer throttling', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const frame = mount({ onError });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready', {});

    act(() => vi.advanceTimersByTime(10 * 60 * 1_000));
    expect(onError).not.toHaveBeenCalled();
    expect(frame.dataset.bridgePhase).toBe('active');
    expect(frame.srcdoc).not.toBe('');
  });

  it('keeps an active iframe and its state when a refresh reconstructs identical scene data', () => {
    vi.useFakeTimers();
    const onPhaseChange = vi.fn();
    const initial = { ...scene, runtimeDependencies: [] };
    const frame = mount({ scene: initial, onPhaseChange });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready', {});
    childMessage(frame, nonce, 3, 'stateChange', { selected: 'capital' });
    const srcdoc = frame.srcdoc;
    act(() => vi.advanceTimersByTime(10 * 60 * 1_000));
    mount({ scene: JSON.parse(JSON.stringify(initial)), onPhaseChange });

    expect(frame.srcdoc).toBe(srcdoc);
    expect(nonceFrom(frame)).toBe(nonce);
    expect(frame.dataset.bridgePhase).toBe('active');
    expect(onPhaseChange.mock.calls.filter(([phase]) => phase === 'booting')).toHaveLength(1);

    mount({
      scene: { ...initial, documentHtml: initial.documentHtml.replace('<title>x', '<title>y') },
    });
    expect(nonceFrom(frame)).not.toBe(nonce);
    expect(frame.dataset.bridgePhase).toBe('booting');
  });

  it('spends the initialization timeout only while the pooled frame is visible', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const frame = mount({ visible: false, onError });
    const nonce = nonceFrom(frame);
    act(() => vi.advanceTimersByTime(10 * 60 * 1_000));
    expect(onError).not.toHaveBeenCalled();
    mount({ visible: true, onError });
    act(() => vi.advanceTimersByTime(4_000));
    mount({ visible: false, onError });
    act(() => vi.advanceTimersByTime(60_000));
    expect(onError).not.toHaveBeenCalled();
    mount({ visible: true, onError });
    act(() => vi.advanceTimersByTime(5_999));
    expect(onError).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onError).toHaveBeenCalledWith({ code: 'initialization_timeout' });
    expect(nonceFrom(frame)).toBe(nonce);
  });

  it('does not collapse distinct manifests outside snapshot bounds to one dependency', () => {
    const oversized = {
      ...scene,
      eventManifest: {
        ...scene.eventManifest,
        events: scene.eventManifest.events.map((event) => ({
          ...event,
          meaning: 'x'.repeat(8193),
        })),
      },
    };
    const frame = mount({ scene: oversized });
    const nonce = nonceFrom(frame);
    mount({
      scene: {
        ...oversized,
        eventManifest: {
          ...oversized.eventManifest,
          events: oversized.eventManifest.events.map((event) => ({
            ...event,
            meaning: 'y'.repeat(8193),
          })),
        },
      },
    });
    expect(nonceFrom(frame)).not.toBe(nonce);
  });

  it('pauses the initialization watchdog in background tabs and accepts a late ready', () => {
    vi.useFakeTimers();
    let hidden = false;
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    try {
      const onError = vi.fn();
      const frame = mount({ onError });
      const nonce = nonceFrom(frame);
      act(() => vi.advanceTimersByTime(2_000));
      hidden = true;
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      act(() => vi.advanceTimersByTime(10 * 60 * 1_000));
      expect(onError).not.toHaveBeenCalled();
      hidden = false;
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      childMessage(frame, nonce, 1, 'bridge_ready');
      childMessage(frame, nonce, 2, 'ready', {});
      act(() => vi.advanceTimersByTime(INTERACTIVE_INITIALIZATION_TIMEOUT_MS));
      expect(onError).not.toHaveBeenCalled();
      expect(frame.dataset.bridgePhase).toBe('active');
    } finally {
      hiddenSpy.mockRestore();
    }
  });

  it('reports initialization timeout visibly and retries with a fresh bridge nonce', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const translate = vi.fn((key: string) =>
      key === 'reachDeck.player.interactive.startFailed' ? '互动启动失败' : key,
    );
    const frame = mount({ onError, translate });
    const firstNonce = nonceFrom(frame);

    act(() => vi.advanceTimersByTime(INTERACTIVE_INITIALIZATION_TIMEOUT_MS));

    expect(onError).toHaveBeenCalledWith({ code: 'initialization_timeout' });
    expect(frame.dataset.bridgePhase).toBe('failed');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('互动启动失败');
    const retry = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retry activity'),
    );
    expect(retry).toBeDefined();

    act(() => retry?.click());
    const retriedFrame = host.querySelector('iframe') as HTMLIFrameElement;
    expect(nonceFrom(retriedFrame)).not.toBe(firstNonce);
    expect(retriedFrame.dataset.bridgePhase).toBe('booting');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('turns an invalid persisted function-plot marker into the visible local error state', () => {
    const onError = vi.fn();
    const invalidScene: InteractiveScene = {
      ...scene,
      documentHtml:
        '<!doctype html><html><head></head><body><script type="application/json" data-reach-function-plot="plot-1">{"schemaVersion":"wrong"}</script></body></html>',
    };

    const frame = mount({ scene: invalidScene, onError });

    expect(frame.srcdoc).toBe('');
    expect(frame.dataset.bridgePhase).toBe('failed');
    expect(frame.dataset.errorCode).toBe('invalid_scene_document');
    expect(onError).toHaveBeenCalledWith({ code: 'invalid_scene_document' });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('cancels the initialization watchdog when the scene becomes active', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const frame = mount({ onError });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready', {});

    act(() => vi.advanceTimersByTime(INTERACTIVE_INITIALIZATION_TIMEOUT_MS * 2));

    expect(onError).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(frame.dataset.bridgePhase).toBe('active');
  });

  it('clears a prior timeout overlay when a different scene starts', () => {
    vi.useFakeTimers();
    const frame = mount();
    act(() => vi.advanceTimersByTime(INTERACTIVE_INITIALIZATION_TIMEOUT_MS));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    act(() =>
      root.render(
        <InteractiveScenePlayer scene={{ ...scene, id: 'interactive-next', title: 'Next' }} />,
      ),
    );

    const nextFrame = host.querySelector('iframe') as HTMLIFrameElement;
    expect(nextFrame).toBe(frame);
    expect(nextFrame.dataset.bridgePhase).toBe('booting');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('accepts completion once per attempt and resets only with the next attempt', () => {
    const onComplete = vi.fn();
    const onReset = vi.fn();
    const frame = mount({ onComplete, onReset });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready', { restored: false });
    childMessage(frame, nonce, 3, 'complete', { result: 1 });
    childMessage(frame, nonce, 4, 'complete', { result: 2 });
    expect(onComplete).toHaveBeenCalledTimes(1);
    childMessage(frame, nonce, 5, 'reset', { attempt: 2 });
    childMessage(frame, nonce, 6, 'complete', { result: 3 });
    expect(onReset).toHaveBeenCalledWith(2);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it('ignores an oversized exact-child message without blanking the document', () => {
    const onError = vi.fn();
    const frame = mount({ onError });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready', 'x'.repeat(73 * 1024));
    expect(onError).not.toHaveBeenCalled();
    expect(frame.srcdoc).not.toBe('');
  });
  it('rejects raw, unknown, and invalid learning events at the parent boundary', () => {
    const onInteraction = vi.fn();
    const onError = vi.fn();
    const frame = mount({ onError, onInteraction });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    childMessage(frame, nonce, 3, 'interaction', { value: 2 });
    childMessage(frame, nonce, 4, 'interaction', {
      name: 'unknown_event',
      eventVersion: 1,
      payload: { value: 2 },
    });
    childMessage(frame, nonce, 5, 'interaction', {
      name: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 101 },
    });
    childMessage(frame, nonce, 6, 'interaction', {
      name: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 2, extra: true },
    });
    expect(onInteraction).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects bypassed iframe progress messages', () => {
    const onInteraction = vi.fn();
    const frame = mount({ onInteraction });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    childMessage(frame, nonce, 3, 'progress', { completedSteps: 1, totalSteps: 2 });
    expect(onInteraction).not.toHaveBeenCalled();
  });

  it('rejects every learning event when the manifest is empty', () => {
    const onInteraction = vi.fn();
    const frame = mount({
      scene: { ...scene, eventManifest: { ...scene.eventManifest, events: [] } },
      onInteraction,
    });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    childMessage(frame, nonce, 3, 'interaction', {
      name: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 2 },
    });
    expect(onInteraction).not.toHaveBeenCalled();
  });

  it('enforces immediate floor, latest-value delivery, wire order, and page rate limit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onInteraction = vi.fn();
    const frame = mount({ onInteraction });
    const nonce = nonceFrom(frame);
    childMessage(frame, nonce, 1, 'bridge_ready');
    childMessage(frame, nonce, 2, 'ready');
    childMessage(frame, nonce, 3, 'interaction', {
      name: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 1 },
    });
    childMessage(frame, nonce, 4, 'interaction', {
      name: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 2 },
    });
    expect(onInteraction).toHaveBeenCalledTimes(1);
    expect(onInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { value: 1 }, wireSequence: 3 }),
    );
    act(() => vi.advanceTimersByTime(250));
    childMessage(frame, nonce, 5, 'interaction', {
      name: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 3 },
    });
    childMessage(frame, nonce, 6, 'interaction', {
      name: 'position_changed',
      eventVersion: 1,
      payload: { position: 10 },
    });
    childMessage(frame, nonce, 7, 'interaction', {
      name: 'position_changed',
      eventVersion: 1,
      payload: { position: 11 },
    });
    act(() => vi.advanceTimersByTime(500));
    expect(onInteraction).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: { position: 11 }, wireSequence: 7 }),
    );

    for (let sequence = 8; sequence < 200; sequence += 1) {
      act(() => vi.advanceTimersByTime(250));
      childMessage(frame, nonce, sequence, 'interaction', {
        name: 'parameter_adjusted',
        eventVersion: 1,
        payload: { value: sequence % 100 },
      });
    }
    expect(onInteraction).toHaveBeenCalledTimes(120);
  });

  it('enforces manifest validation and delivery inside the frozen iframe helper', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = buildInteractiveSrcDoc({
      documentHtml: scene.documentHtml,
      nonce: '1234567890123456',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const bootstrap = [...parsed.querySelectorAll('script')].find((script) =>
      script.textContent?.includes('const CHANNEL = "reach-interactive"'),
    )?.textContent;
    if (bootstrap === undefined) throw new Error('bootstrap missing');
    const messages: Array<{ type: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: { source?: unknown; data?: unknown }) => void>();
    const parent = {
      postMessage: (message: { type: string; payload: unknown }) => messages.push(message),
    };
    const childWindow: Record<string, unknown> = {
      parent,
      addEventListener: (
        name: string,
        listener: (event: { source?: unknown; data?: unknown }) => void,
      ) => listeners.set(name, listener),
      dispatchEvent: vi.fn(),
    };
    const childDocument = {
      currentScript: { remove: vi.fn() },
      documentElement: { dataset: {} },
      getAnimations: () => [],
      querySelectorAll: () => [],
    };
    Function('window', 'document', bootstrap)(childWindow, childDocument);
    listeners.get('message')?.({
      source: parent,
      data: {
        channel: INTERACTIVE_CHANNEL,
        version: INTERACTIVE_BRIDGE_VERSION,
        nonce: '1234567890123456',
        sequence: 1,
        type: 'initialize',
        payload: { attempt: 1 },
      },
    });
    const api = childWindow.ReachInteractive as {
      interaction?: unknown;
      progress?: unknown;
      ready: () => void;
      learningEvent: (name: string, payload: unknown) => boolean;
    };
    api.ready();
    messages.length = 0;

    expect(Object.isFrozen(api)).toBe(true);
    expect(api.interaction).toBeUndefined();
    expect(api.progress).toBeUndefined();
    expect(api.learningEvent('unknown', { value: 1 })).toBe(false);
    expect(api.learningEvent('parameter_adjusted', { value: 101 })).toBe(false);
    expect(api.learningEvent('parameter_adjusted', { value: 1 })).toBe(true);
    expect(api.learningEvent('parameter_adjusted', { value: 2 })).toBe(false);
    expect(messages).toEqual([
      expect.objectContaining({
        type: 'interaction',
        payload: { name: 'parameter_adjusted', eventVersion: 1, payload: { value: 1 } },
      }),
    ]);

    expect(api.learningEvent('position_changed', { position: 10 })).toBe(true);
    expect(api.learningEvent('position_changed', { position: 11 })).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'interaction',
        payload: { name: 'position_changed', eventVersion: 1, payload: { position: 11 } },
      }),
    );
  });

  it('flushes buffered child state before pong even while suspended and locks subsequent emissions', () => {
    vi.useFakeTimers();
    const source = buildInteractiveSrcDoc({
      documentHtml: scene.documentHtml,
      nonce: '1234567890123456',
      allowReset: true,
      eventManifest: scene.eventManifest,
    });
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const bootstrap = [...parsed.querySelectorAll('script')].find((script) =>
      script.textContent?.includes('const CHANNEL = "reach-interactive"'),
    )?.textContent;
    if (!bootstrap) throw new Error('bootstrap missing');
    const messages: Array<{ type: string; payload: unknown }> = [];
    const listeners = new Map<string, (event: { source?: unknown; data?: unknown }) => void>();
    const parent = {
      postMessage: (message: { type: string; payload: unknown }) => messages.push(message),
    };
    const childWindow: Record<string, unknown> = {
      parent,
      addEventListener: (
        name: string,
        listener: (event: { source?: unknown; data?: unknown }) => void,
      ) => listeners.set(name, listener),
      dispatchEvent: vi.fn(),
    };
    const childDocument = {
      currentScript: { remove: vi.fn() },
      documentElement: { dataset: {} },
      getAnimations: () => [],
      querySelectorAll: () => [],
    };
    Function('window', 'document', bootstrap)(childWindow, childDocument);
    let sequence = 0;
    const send = (type: string, payload: unknown = {}) =>
      listeners.get('message')?.({
        source: parent,
        data: {
          channel: INTERACTIVE_CHANNEL,
          version: INTERACTIVE_BRIDGE_VERSION,
          nonce: '1234567890123456',
          sequence: ++sequence,
          type,
          payload,
        },
      });
    send('initialize', { attempt: 1 });
    const api = childWindow.ReachInteractive as {
      ready: () => void;
      stateChange: (snapshot: unknown) => boolean;
      isSuspended: () => boolean;
    };
    api.ready();
    messages.length = 0;
    expect(api.stateChange({ value: 1 })).toBe(true);
    send('ping', { heartbeatId: 1 });
    expect(messages.map((message) => message.type)).toEqual(['pong']);
    expect(api.isSuspended()).toBe(false);
    send('suspend');
    expect(api.stateChange({ value: 2 })).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    messages.length = 0;
    send('ping', { heartbeatId: 2, flushState: true });
    expect(messages).toEqual([
      expect.objectContaining({ type: 'stateChange', payload: { value: 2 } }),
      expect.objectContaining({ type: 'pong', payload: { heartbeatId: 2 } }),
    ]);
    expect(api.isSuspended()).toBe(true);
    expect(api.stateChange({ value: 3 })).toBe(false);
    send('resume');
    expect(api.isSuspended()).toBe(false);
    expect(api.stateChange({ value: 4 })).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    expect(messages.at(-1)).toMatchObject({ type: 'stateChange', payload: { value: 4 } });
    send('dispose');
  });

  it('bounds host snapshots and replaces generated policy and base tags', () => {
    expect(isBoundedJson({ value: Number.NaN })).toBe(false);
    expect(isBoundedJson({ value: 'x'.repeat(8_193) })).toBe(false);
    expect(isBoundedJson({ value: 'ok' })).toBe(true);
    const source = buildInteractiveSrcDoc({
      documentHtml:
        '<html><head><base href="https://bad.test"><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body></html>',
      nonce: '1234567890123456',
      allowReset: false,
      eventManifest: scene.eventManifest,
    });
    expect(source).not.toContain('https://bad.test');
    expect(source).not.toContain('default-src *');
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("connect-src 'none'");
    expect(source).not.toContain('dom_limit_exceeded');
    expect(source).toContain("message.type === 'suspend'");
    expect(source).toContain("message.type === 'resume'");
    expect(source).toContain('reach-interactive-suspend');
    expect(source).toContain('reach-interactive-resume');
    expect(source).toContain('isSuspended');
    expect(source).toContain('learningEvent: (name, payload)');
    expect(source).not.toContain('interaction: (payload)');
    expect(source).not.toContain('progress: (payload)');
    expect(source).toContain('now - previous < 250');
    expect(source).toContain('recentLearningEvents.length >= 120');
  });
});
