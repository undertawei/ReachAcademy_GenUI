// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReachDeckPageMediaSlot } from '@reachany/reach-deck-dsl';
import { ReachDeckEditor } from '../src/ReachDeckEditor';
import { createEditorDocument } from './fixture';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const slot: ReachDeckPageMediaSlot = {
  assetId: 'asset-1',
  plannedIndex: 0,
  elementId: 'image-1',
  resourceId: 'placeholder',
  binding: 'image-element',
  status: 'failed',
  planDigest: 'digest',
  attempt: 1,
  failure: { reason: 'timeout', retryable: true, at: '2026-10-17T00:00:00Z' },
  plannedAsset: {
    kind: 'image',
    purpose: 'Example',
    prompt: 'Forest',
    alt: 'Forest',
    aspectRatio: '4:3',
    placement: 'primary',
  },
};
function fixture() {
  const document = createEditorDocument();
  document.resources.media.push({
    id: 'placeholder',
    objectKey: 'generated/placeholder.png',
    contentType: 'image/png',
    digest: 'sha256:placeholder',
  });
  document.nativeSlides[0]!.slide.elements = [
    {
      id: 'group-1',
      type: 'group',
      zIndex: 1,
      transform: { x: 100, y: 100, width: 200, height: 200, rotation: 90 },
      children: [
        {
          id: 'image-1',
          type: 'image',
          zIndex: 1,
          resourceId: 'placeholder',
          fit: 'contain',
          alt: 'Forest',
          transform: { x: 20, y: 30, width: 40, height: 50 },
        },
      ],
    },
  ];
  return document;
}
it('centers the retry over a rotated group child and sends only that image', async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  act(() =>
    root.render(
      <ReachDeckEditor
        document={fixture()}
        mediaSlotsByPageId={{ 'page-1': [slot] }}
        onRegenerateImage={retry}
      />,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>(
    '.reach-deck-editor__media-slot-retry',
  )!;
  expect(button.style.left).toBe('245px');
  expect(button.style.top).toBe('140px');
  expect(button.title).toContain('图片生成失败');
  await act(async () => button.click());
  expect(retry).toHaveBeenCalledWith('page-1', 'asset-1', 'failed');
});
it('does not render a retry inside any hidden ancestor group', () => {
  const document = fixture();
  const group = document.nativeSlides[0]!.slide.elements[0]!;
  document.nativeSlides[0]!.slide.elements = [
    {
      ...group,
      id: 'outer-group',
      type: 'group',
      hidden: true,
      children: [group],
    },
  ];
  act(() =>
    root.render(
      <ReachDeckEditor
        document={document}
        mediaSlotsByPageId={{ 'page-1': [slot] }}
        onRegenerateImage={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector('.reach-deck-editor__media-slot-retry')).toBeNull();
});
it.each(['zh-CN', 'en-US'] as const)(
  'gives each failed image a distinct accessible retry name in %s',
  (locale) => {
    const document = fixture();
    const group = document.nativeSlides[0]!.slide.elements[0]!;
    if (group.type !== 'group') throw new Error('测试组合不存在');
    group.children.push({ ...group.children[0]!, id: 'image-2' });
    const translations =
      locale === 'zh-CN'
        ? { 'reachDeck.editor.mediaSlot.retryLabel': '重试第 {number} 张图片：{description}' }
        : { 'reachDeck.editor.mediaSlot.retryLabel': 'Retry image {number}: {description}' };
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          translate={(key, values) =>
            Object.entries(values ?? {}).reduce(
              (copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)),
              translations[key as keyof typeof translations] ?? key,
            )
          }
          mediaSlotsByPageId={{
            'page-1': [
              slot,
              { ...slot, assetId: 'asset-2', elementId: 'image-2', plannedIndex: 1 },
            ],
          }}
          onRegenerateImage={vi.fn()}
        />,
      ),
    );
    const names = [...container.querySelectorAll('.reach-deck-editor__media-slot-retry')].map(
      (button) => button.getAttribute('aria-label'),
    );
    expect(names).toEqual(
      locale === 'zh-CN'
        ? ['重试第 1 张图片：Forest', '重试第 2 张图片：Forest']
        : ['Retry image 1: Forest', 'Retry image 2: Forest'],
    );
  },
);
it('keeps the retry control size independent of canvas zoom', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('styles.css', 'utf8');
  container.append(style);
  act(() =>
    root.render(
      <ReachDeckEditor
        document={fixture()}
        mediaSlotsByPageId={{ 'page-1': [slot] }}
        onRegenerateImage={vi.fn()}
      />,
    ),
  );
  container.append(style);
  const button = container.querySelector<HTMLElement>('.reach-deck-editor__media-slot-retry')!;
  expect(getComputedStyle(button).transform).toContain(
    'scale(calc(1 / var(--native-v2-stage-scale)))',
  );
});
it.each(['zh-CN', 'en-US'] as const)(
  'omits the description separator when image alt is blank in %s',
  (locale) => {
    const messages: Record<string, string> =
      locale === 'zh-CN'
        ? {
            'reachDeck.editor.mediaSlot.retryLabel': '重试第 {number} 张图片：{description}',
            'reachDeck.editor.mediaSlot.retryLabelWithoutDescription': '重试第 {number} 张图片',
          }
        : {
            'reachDeck.editor.mediaSlot.retryLabel': 'Retry image {number}: {description}',
            'reachDeck.editor.mediaSlot.retryLabelWithoutDescription': 'Retry image {number}',
          };
    act(() =>
      root.render(
        <ReachDeckEditor
          document={fixture()}
          translate={(key, values) =>
            Object.entries(values ?? {}).reduce(
              (copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)),
              messages[key] ?? key,
            )
          }
          mediaSlotsByPageId={{
            'page-1': [{ ...slot, plannedAsset: { ...slot.plannedAsset, alt: '   ' } }],
          }}
          onRegenerateImage={vi.fn()}
        />,
      ),
    );
    expect(
      container.querySelector('.reach-deck-editor__media-slot-retry')?.getAttribute('aria-label'),
    ).toBe(locale === 'zh-CN' ? '重试第 1 张图片' : 'Retry image 1');
  },
);
it('lets the owning locale format the entire retry tooltip', () => {
  const translate = vi.fn((key: string, values?: Record<string, string | number>) => {
    if (key === 'reachDeck.editor.mediaSlot.retry') return 'Retry image';
    if (key === 'reachDeck.editor.mediaSlot.reason.timeout') return 'Timed out';
    if (key === 'reachDeck.editor.mediaSlot.retryTooltip')
      return `${values?.label}: ${values?.reason}`;
    return key;
  });
  act(() =>
    root.render(
      <ReachDeckEditor
        document={fixture()}
        translate={translate}
        mediaSlotsByPageId={{ 'page-1': [slot] }}
        onRegenerateImage={vi.fn()}
      />,
    ),
  );
  expect(
    container.querySelector<HTMLButtonElement>('.reach-deck-editor__media-slot-retry')?.title,
  ).toBe('Retry image: Timed out');
});
it('keeps the canvas editable while the image lane is generating and disables all retry icons', () => {
  const document = fixture();
  act(() =>
    root.render(
      <ReachDeckEditor
        document={document}
        mediaSlotsByPageId={{ 'page-1': [slot] }}
        imageGeneratingPageIds={['page-1']}
        generationStatusByPageId={{
          'page-1': { phase: 'layout', affectedLanes: ['image'], state: 'loading' },
        }}
        onRegenerateImage={vi.fn()}
      />,
    ),
  );
  expect(
    container.querySelector<HTMLButtonElement>('.reach-deck-editor__media-slot-retry')?.disabled,
  ).toBe(true);
  const group = [...container.querySelectorAll('[data-native-v2-element-id="group-1"]')].find(
    (element) =>
      element.closest('[data-deck-command-context]')?.getAttribute('data-deck-command-context') ===
      'canvas',
  )!;
  act(() => group.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(container.querySelector('[data-native-v2-transform-overlay="group-1"]')).not.toBeNull();
  expect(
    container.querySelector('.reach-deck-editor__media-slot-retry')?.getAttribute('aria-busy'),
  ).toBe('true');
});
it('offers regeneration for a ready image inside a group in the context menu', async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  act(() =>
    root.render(
      <ReachDeckEditor
        document={fixture()}
        mediaSlotsByPageId={{ 'page-1': [{ ...slot, status: 'ready' }] }}
        onRegenerateImage={retry}
      />,
    ),
  );
  const image = [...container.querySelectorAll('[data-native-v2-element-id="image-1"]')].find(
    (element) =>
      element.closest('[data-deck-command-context]')?.getAttribute('data-deck-command-context') ===
      'canvas',
  )!;
  act(() =>
    image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  const regenerate = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.includes('重新生成这张图片'),
  )!;
  expect(regenerate).toBeDefined();
  await act(async () => regenerate.click());
  expect(retry).toHaveBeenCalledWith('page-1', 'asset-1', 'all');
});
it('hides retry when the teacher replaces the generated resource in the current draft', () => {
  const document = fixture();
  const group = document.nativeSlides[0]!.slide.elements[0]!;
  if (group.type === 'group' && group.children[0]?.type === 'image')
    group.children[0].resourceId = 'teacher-image';
  document.resources.media.push({
    id: 'teacher-image',
    objectKey: 'uploads/teacher.png',
    contentType: 'image/png',
    digest: 'sha256:teacher',
  });
  act(() =>
    root.render(
      <ReachDeckEditor
        document={document}
        mediaSlotsByPageId={{ 'page-1': [slot] }}
        onRegenerateImage={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector('.reach-deck-editor__media-slot-retry')).toBeNull();
});

it('clears a failed retry message after the image slot is repaired elsewhere', async () => {
  const error = Object.assign(new Error('Retry denied'), { name: 'ReachDeckUserFacingError' });
  const retry = vi.fn().mockRejectedValue(error);
  const render = (slots: readonly ReachDeckPageMediaSlot[]) =>
    root.render(
      <ReachDeckEditor
        document={fixture()}
        mediaSlotsByPageId={{ 'page-1': slots }}
        onRegenerateImage={retry}
      />,
    );
  act(() => render([slot]));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.reach-deck-editor__media-slot-retry')!.click(),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Retry denied');
  act(() => render([{ ...slot, status: 'ready', attempt: 2 }]));
  expect(
    [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
  ).not.toContain('Retry denied');
});

it('offers image regeneration for an unchanged native scientific slot', async () => {
  const document = fixture();
  document.nativeSlides[0]!.slide.elements = [
    {
      id: 'science-1',
      type: 'scientificVisual',
      documentHtml: '<main>Original</main>',
      manifest: {
        schemaVersion: 'reach-scientific-visual-manifest/v2',
        hooksVersion: 'reach-scientific-visual-hooks/v1',
        anchors: [],
        dependencies: [],
        resourceIds: [],
        ariaLabel: 'Science',
        textAlternative: 'Original',
      },
      ariaLabel: 'Science',
      zIndex: 1,
      transform: { x: 0, y: 0, width: 100, height: 100 },
    },
  ];
  const { resourceId: _resourceId, failure: _failure, ...common } = slot;
  const scientificSlot: ReachDeckPageMediaSlot = {
    ...common,
    elementId: 'science-1',
    binding: 'scientific-visual',
    status: 'ready',
    contentDigest: 'a'.repeat(64),
  };
  const retry = vi.fn().mockResolvedValue(undefined);
  act(() =>
    root.render(
      <ReachDeckEditor
        document={document}
        onRegenerateImage={retry}
        mediaSlotsByPageId={{ 'page-1': [scientificSlot] }}
      />,
    ),
  );
  const element = [...container.querySelectorAll('[data-native-v2-element-id="science-1"]')].find(
    (node) =>
      node.closest('[data-deck-command-context]')?.getAttribute('data-deck-command-context') ===
      'canvas',
  )!;
  act(() =>
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  const regenerate = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (node) => node.textContent?.includes('重新生成这张图片'),
  )!;
  expect(regenerate).toBeDefined();
  await act(async () => regenerate.click());
  expect(retry).toHaveBeenCalledWith('page-1', 'asset-1', 'all');
});

it('shows a hidden placeholder and its hidden ancestors only when reveal is requested', () => {
  const document = fixture();
  const group = document.nativeSlides[0]!.slide.elements[0]!;
  group.hidden = true;
  if (group.type === 'group') group.children[0]!.hidden = true;
  const change = vi.fn();
  act(() =>
    root.render(
      <ReachDeckEditor
        document={document}
        onChange={change}
        mediaSlotsByPageId={{ 'page-1': [slot] }}
        onRegenerateImage={vi.fn()}
        mediaSlotFocusRequest={{ pageId: 'page-1', elementId: 'image-1', key: 1 }}
      />,
    ),
  );
  expect(change).not.toHaveBeenCalled();
  act(() =>
    root.render(
      <ReachDeckEditor
        document={document}
        onChange={change}
        mediaSlotsByPageId={{ 'page-1': [slot] }}
        onRegenerateImage={vi.fn()}
        mediaSlotFocusRequest={{
          pageId: 'page-1',
          elementId: 'image-1',
          revealHidden: true,
          key: 2,
        }}
      />,
    ),
  );
  const revealed = change.mock.calls.at(-1)?.[0].nativeSlides[0].slide.elements[0];
  expect(revealed).toMatchObject({
    hidden: false,
    children: [expect.objectContaining({ hidden: false })],
  });
  expect(container.querySelector('.reach-deck-editor__media-slot-retry')).not.toBeNull();
});
