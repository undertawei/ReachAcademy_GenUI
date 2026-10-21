import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';

import { ReachDeckPlayer } from '../src/ReachDeckPlayer';

const document: ReachDeckDocument = {
  schemaVersion: 'reach-deck-document/v2',
  id: 'deck-native-editing',
  title: 'Native editing deck',
  stage: { width: 1600, height: 900, aspectRatio: '16:9' },
  theme: {
    name: 'Reach',
    background: '#fff',
    surface: '#fff',
    ink: '#172024',
    muted: '#647178',
    accent: '#2563eb',
    success: '#15803d',
    warning: '#b45309',
    fontDisplay: 'Inter',
    fontBody: 'Inter',
  },
  defaultThemeId: 'reach-default-theme',
  resources: {
    themes: [
      {
        id: 'reach-default-theme',
        name: 'Reach',
        colors: { background: '#fff', ink: '#172024' },
        fonts: { display: 'Inter', body: 'Inter' },
      },
    ],
    masters: [],
    layouts: [],
    media: [],
  },
  metadata: {
    source: 'editor',
    language: 'zh-CN',
    generatedAt: '2026-08-16T00:00:00.000Z',
    contentDigest: 'sha256:native-editing',
  },
  revisions: [],
  pages: [
    {
      pageId: 'page-1',
      order: 1,
      revision: 1,
      sceneType: 'slide',
      title: 'Native slide',
    },
  ],
  nativeSlides: [
    {
      pageId: 'page-1',
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-slide-1',
        title: 'Native slide',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
        elements: [
          {
            id: 'element-a',
            type: 'shape',
            transform: { x: 80, y: 64, width: 900, height: 120 },
            zIndex: 1,
            geometry: { kind: 'preset', preset: 'rect' },
            style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#4472C4' } } },
          },
          {
            id: 'element-b',
            type: 'shape',
            transform: { x: 80, y: 300, width: 400, height: 100 },
            zIndex: 2,
            geometry: { kind: 'preset', preset: 'rect' },
            style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#ED7D31' } } },
          },
        ],
        animations: [],
        duration: 8,
      },
    },
  ],
};

describe('ReachDeckPlayer native v2 editing integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('selects native elements and clears selection from the stage', () => {
    const onElementSelect = vi.fn();
    act(() =>
      root.render(<ReachDeckPlayer document={document} onElementSelect={onElementSelect} />),
    );

    const element = container.querySelector<HTMLElement>('[data-native-v2-element-id="element-b"]');
    act(() => element?.click());
    expect(onElementSelect).toHaveBeenLastCalledWith('element-b');

    const stage = container.querySelector<HTMLElement>('[data-native-v2-stage]');
    act(() => stage?.click());
    expect(onElementSelect).toHaveBeenLastCalledWith(undefined);
  });

  it('forwards native transform changes from the selected element overlay', () => {
    const onNativeElementTransformChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={document}
          onElementSelect={() => undefined}
          onNativeElementTransformChange={onNativeElementTransformChange}
          selectedElementId="element-a"
        />,
      ),
    );

    const overlay = container.querySelector<HTMLElement>(
      '[data-native-v2-transform-overlay="element-a"]',
    );
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelectorAll('[data-resize-corner]')).toHaveLength(4);
    act(() =>
      overlay?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(onNativeElementTransformChange).toHaveBeenLastCalledWith('element-a', {
      x: 90,
      y: 64,
      width: 900,
      height: 120,
    });
  });

  it('exposes the stable native-v2 timeline hook', () => {
    act(() => root.render(<ReachDeckPlayer document={document} />));
    expect(container.querySelector('[data-reach-deck-timeline="native-v2"]')).not.toBeNull();
  });
});
