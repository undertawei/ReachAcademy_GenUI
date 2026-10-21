import { act, render, waitFor } from '@testing-library/react';
import type {
  ReachDeckNativeSlideV2,
  ReachDeckScientificVisualElementV2,
} from '@reachany/reach-deck-dsl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ScientificVisualPlayer,
  createScientificVisualUrlResourceResolver,
} from '../src/ScientificVisualPlayer.js';
import { createScientificVisualWireMessage } from '../src/scientificVisualBridge.js';

const element: ReachDeckScientificVisualElementV2 = {
  id: 'scientific-motion',
  type: 'scientificVisual',
  transform: { x: 0, y: 0, width: 640, height: 360 },
  zIndex: 1,
  ariaLabel: 'Motion visual',
  documentHtml: '<main></main><script>ReachScientificVisual.register({present(){}})</script>',
  manifest: {
    schemaVersion: 'reach-scientific-visual-manifest/v2',
    hooksVersion: 'reach-scientific-visual-hooks/v1',
    anchors: [],
    dependencies: [],
    resourceIds: [],
    ariaLabel: 'Motion visual',
    textAlternative: 'A body follows a deterministic path.',
  },
};

const slide: ReachDeckNativeSlideV2 = {
  schemaVersion: 'reach-deck-slide/v2',
  id: 'slide-1',
  title: 'Motion',
  background: { kind: 'none' },
  elements: [element],
  animations: [],
};

describe('ScientificVisualPlayer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps static mode pointer-passive while mounting the scientific iframe', () => {
    const { container } = render(
      <ScientificVisualPlayer
        element={element}
        logicalHeight={360}
        logicalWidth={640}
        slide={slide}
        stageScale={1}
        staticMode
      />,
    );
    expect(container.querySelector('[data-scientific-frame]')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.firstElementChild?.getAttribute('data-scientific-phase')).toBe('static');
  });

  it('hydrates only host-resolved resource ids and returns bounded bytes', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const resolver = createScientificVisualUrlResourceResolver({ data: '/api/media/data' });
    await expect(resolver('missing')).rejects.toThrow(/unavailable/i);
    await expect(resolver('data')).resolves.toMatchObject({
      mimeType: 'application/octet-stream',
      bytes: expect.any(ArrayBuffer),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/api/media/data', window.location.href),
      expect.objectContaining({ credentials: 'same-origin', referrerPolicy: 'no-referrer' }),
    );
  });

  it('rejects a resource from response metadata before reading oversized bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(new Uint8Array([1]), {
            headers: {
              'content-length': String(2 * 1024 * 1024 + 1),
              'content-type': 'application/octet-stream',
            },
          }),
        ),
      ),
    );
    await expect(
      createScientificVisualUrlResourceResolver({ data: '/api/media/data' })('data'),
    ).rejects.toThrow(/byte limit/i);
  });

  it('sends current stage geometry through resize without rebuilding the iframe', async () => {
    const props = {
      element,
      logicalHeight: 360,
      logicalWidth: 640,
      slide,
      stageScale: 1,
    };
    const { container, rerender } = render(<ScientificVisualPlayer {...props} />);
    const frame = container.querySelector<HTMLIFrameElement>('[data-scientific-frame]')!;
    Object.defineProperty(frame, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 360,
        height: 360,
        left: 0,
        right: 640,
        top: 0,
        width: 640,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
    await waitFor(() => expect(frame.srcdoc).toContain('data-reach-scientific-bootstrap'));
    const nonce = frame.dataset.scientificNonce!;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: createScientificVisualWireMessage(nonce, 1, 'bridge_ready', {}),
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ nonce, type: 'initialize' }),
        '*',
        expect.any(Array),
      ),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: createScientificVisualWireMessage(nonce, 2, 'ready', {}),
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-scientific-phase')).toBe('active'),
    );
    postMessage.mockClear();

    rerender(
      <ScientificVisualPlayer
        {...props}
        logicalHeight={576}
        logicalWidth={1024}
        stageScale={0.75}
      />,
    );

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          nonce,
          payload: expect.objectContaining({
            logicalHeight: 576,
            logicalWidth: 1024,
            stageScale: 0.75,
          }),
          type: 'resize',
        }),
        '*',
        [],
      ),
    );
    expect(container.querySelector('[data-scientific-frame]')).toBe(frame);
    expect(frame.dataset.scientificNonce).toBe(nonce);
  });

  it('presents an initial deterministic frame at t=0 after the bridge is ready', async () => {
    const { container } = render(
      <ScientificVisualPlayer
        element={element}
        logicalHeight={360}
        logicalWidth={640}
        slide={slide}
        stageScale={1}
      />,
    );
    const frame = container.querySelector<HTMLIFrameElement>('[data-scientific-frame]')!;
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
    await waitFor(() => expect(frame.srcdoc).toContain('data-reach-scientific-bootstrap'));
    const nonce = frame.dataset.scientificNonce!;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: createScientificVisualWireMessage(nonce, 1, 'bridge_ready', {}),
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'initialize' }),
        '*',
        expect.any(Array),
      ),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: createScientificVisualWireMessage(nonce, 2, 'ready', {}),
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          nonce,
          type: 'present',
          payload: expect.objectContaining({ currentTime: 0, staticMode: false }),
        }),
        '*',
        [],
      ),
    );
  });

  it('presents the real iframe at t=0 for printing and restores the playhead afterward', async () => {
    const { container } = render(
      <ScientificVisualPlayer
        currentTime={4.5}
        element={element}
        logicalHeight={360}
        logicalWidth={640}
        playing
        slide={slide}
        stageScale={1}
      />,
    );
    const frame = container.querySelector<HTMLIFrameElement>('[data-scientific-frame]')!;
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
    await waitFor(() => expect(frame.srcdoc).toContain('data-reach-scientific-bootstrap'));
    const nonce = frame.dataset.scientificNonce!;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: createScientificVisualWireMessage(nonce, 1, 'bridge_ready', {}),
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'initialize' }),
        '*',
        expect.any(Array),
      ),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: createScientificVisualWireMessage(nonce, 2, 'ready', {}),
          source: frame.contentWindow,
        }),
      );
    });
    await waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-scientific-phase')).toBe('active'),
    );
    postMessage.mockClear();

    act(() => window.dispatchEvent(new Event('beforeprint')));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'present',
        payload: expect.objectContaining({ currentTime: 0, playing: false, staticMode: true }),
      }),
      '*',
      [],
    );

    postMessage.mockClear();
    act(() => window.dispatchEvent(new Event('afterprint')));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'present',
        payload: expect.objectContaining({ currentTime: 4.5, playing: true, staticMode: false }),
      }),
      '*',
      [],
    );
  });

  it('reports an accessible failed phase when scientific HTML cannot initialize', async () => {
    const invalidElement = {
      ...element,
      documentHtml: '<script src="https://external.example.test/runtime.js"></script>',
    } satisfies ReachDeckScientificVisualElementV2;
    const { container } = render(
      <ScientificVisualPlayer
        element={invalidElement}
        logicalHeight={360}
        logicalWidth={640}
        slide={{ ...slide, elements: [invalidElement] }}
        stageScale={1}
      />,
    );
    await waitFor(() =>
      expect(container.firstElementChild?.getAttribute('data-scientific-phase')).toBe('failed'),
    );
    expect(container.querySelector('[data-scientific-error][role="alert"]')?.textContent).toContain(
      invalidElement.manifest.textAlternative,
    );
    expect(container.querySelector('[data-scientific-error][role="alert"]')?.textContent).toContain(
      'Scientific visual failed to load',
    );
  });
});
