// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReachDeckApiError } from '@reachany/reach-deck-client';
import {
  createBlankReachDeckDocument,
  type ReachDeckDocument,
  type GenerationWorkspace,
  type ReachDeckPageMediaSlot,
  selectReachDeckRegenerationPages,
} from '@reachany/reach-deck-dsl';
import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import {
  deriveReachDeckLayoutRegeneratablePageIds,
  useReachDeckRegeneration,
} from './useReachDeckRegeneration';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof useReachDeckRegeneration>;
let deck: ReachDeckDocument;
let scope: string;
let prepare: ReturnType<typeof vi.fn>;
let regenerate: ReturnType<typeof vi.fn>;
let onAccepted: ReturnType<typeof vi.fn>;
let locale: 'zh-CN' | 'en-US';
let layoutPageIds: readonly string[] | undefined;
let mediaSlotsByPageId: Readonly<Record<string, readonly ReachDeckPageMediaSlot[]>>;
let selectionContext: Parameters<typeof selectReachDeckRegenerationPages>[0] | undefined;

function Harness() {
  current = useReachDeckRegeneration({
    scopeIdentity: scope,
    document: deck,
    layoutRegeneratablePageIds: layoutPageIds,
    mediaSlotsByPageId,
    selectionContext,
    getLatestDocument: () => deck,
    prepare,
    regenerate,
    onAccepted,
  });
  return current.dialog;
}
const render = () =>
  act(() =>
    root.render(
      <PortalI18nProvider locale={locale}>
        <Harness />
      </PortalI18nProvider>,
    ),
  );
const checkboxes = () =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(
    (box) => !box.closest('.reach-deck-regeneration__image-option'),
  );
const submit = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    [
      locale === 'zh-CN' ? '开始生成' : 'Start generation',
      locale === 'zh-CN' ? '确认上次提交' : 'Check previous submission',
    ].includes(button.textContent ?? ''),
  )!;
const toggle = (index: number) => act(() => checkboxes()[index]!.click());

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  deck = createBlankReachDeckDocument({ id: 'regeneration-deck', title: 'Deck' });
  scope = 'module-v1';
  locale = 'zh-CN';
  layoutPageIds = undefined;
  mediaSlotsByPageId = {};
  selectionContext = undefined;
  prepare = vi.fn().mockResolvedValue(undefined);
  regenerate = vi.fn().mockResolvedValue({ acceptedPageIds: [deck.pages[0]!.pageId], skipped: [] });
  onAccepted = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('useReachDeckRegeneration', () => {
  it('does not inspect saved narration while closed or computing whole-deck options', () => {
    const nativeSlides = deck.nativeSlides;
    const readSlides = vi.fn(() => nativeSlides);
    Object.defineProperty(deck, 'nativeSlides', { get: readSlides });
    render();
    render();
    expect(readSlides).not.toHaveBeenCalled();
    act(() => current.request());
    toggle(2);
    render();
    expect(checkboxes()).toHaveLength(4);
    expect(readSlides).not.toHaveBeenCalled();
    act(() => current.close());
    render();
    expect(readSlides).not.toHaveBeenCalled();
  });

  it('reuses single-page validity across unrelated renders and refreshes when the document changes', () => {
    deck.nativeSlides[0]!.slide.narration = { markdown: 'Saved narration' };
    const nativeSlides = deck.nativeSlides;
    const readSlides = vi.fn(() => nativeSlides);
    Object.defineProperty(deck, 'nativeSlides', { get: readSlides, enumerable: true });
    render();
    act(() => current.request(deck.pages[0]!.pageId));
    const reads = readSlides.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    render();
    toggle(2);
    render();
    expect(readSlides).toHaveBeenCalledTimes(reads);
    deck = { ...deck, nativeSlides: [] };
    render();
    expect(checkboxes()[2]!.disabled).toBe(true);
    expect(checkboxes()[2]!.checked).toBe(false);
  });

  it('matches layout context prerequisites without granting imported or copied pages generation ability', () => {
    const workspace = {
      lessonPlan: {},
      pagedOutline: { pages: [{ id: 'generated' }, { id: 'no-record' }] },
      records: { generated: {}, copied: {} },
    } as unknown as GenerationWorkspace;
    expect(deriveReachDeckLayoutRegeneratablePageIds(workspace)).toEqual(['generated']);
    expect(deriveReachDeckLayoutRegeneratablePageIds(undefined)).toEqual([]);
    expect(
      deriveReachDeckLayoutRegeneratablePageIds({ ...workspace, lessonPlan: undefined }),
    ).toEqual([]);
    expect(
      deriveReachDeckLayoutRegeneratablePageIds({ ...workspace, pagedOutline: undefined }),
    ).toEqual([]);
    expect(deriveReachDeckLayoutRegeneratablePageIds({ ...workspace, records: {} })).toEqual([]);
  });

  it.each(['whole', 'page'] as const)(
    'disables layout lacking original generation context while keeping saved-narration audio available (%s)',
    (kind) => {
      layoutPageIds = [];
      deck.nativeSlides[0]!.slide.narration = { markdown: 'Saved narration' };
      render();
      act(() => current.request(kind === 'page' ? deck.pages[0]!.pageId : undefined));
      expect(checkboxes()[0]!.disabled).toBe(true);
      expect(document.body.textContent).toContain('缺少原始教学计划、页面大纲或生成记录');
      expect(checkboxes()[2]!.disabled).toBe(false);
      toggle(0);
      expect(checkboxes()[0]!.checked).toBe(false);
      toggle(2);
      expect(checkboxes().map((box) => box.checked)).toEqual([false, false, true, false]);
      expect(submit().disabled).toBe(false);
    },
  );

  it('allows layout for the eligible part of a mixed deck and drops it if no eligible pages remain', () => {
    layoutPageIds = [deck.pages[0]!.pageId];
    const original = deck.pages[0]!;
    deck = { ...deck, pages: [...deck.pages, { ...original, pageId: 'copied', order: 2 }] };
    render();
    act(() => current.request());
    expect(checkboxes()[0]!.disabled).toBe(false);
    toggle(0);
    expect(checkboxes()[0]!.checked).toBe(true);
    layoutPageIds = [];
    render();
    expect(checkboxes()[0]!.disabled).toBe(true);
    expect(checkboxes()[0]!.checked).toBe(false);
    expect(submit().disabled).toBe(true);
    layoutPageIds = [original.pageId];
    render();
    act(() => current.close());
    act(() => current.request('copied'));
    expect(checkboxes()[0]!.disabled).toBe(true);
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'starts empty and preserves whole-deck skip warnings (%s)',
    (language) => {
      locale = language;
      render();
      act(() => current.request());
      expect(checkboxes().every((box) => !box.checked)).toBe(true);
      expect(submit().disabled).toBe(true);
      expect(
        document.querySelector<HTMLInputElement>('input[type="radio"][value="failed"]')?.checked,
      ).toBe(true);
      toggle(2);
      expect(document.body.textContent).toContain(
        language === 'zh-CN' ? '跳过所有无效讲稿页' : 'Skip all pages without valid narration',
      );
      toggle(2);
      toggle(3);
      expect(document.body.textContent).toContain(
        language === 'zh-CN'
          ? '跳过所有讲稿和音频无效页'
          : 'Skip all pages without valid narration or audio',
      );
    },
  );

  it('adds dependencies in whole-deck selection despite missing saved narration', () => {
    render();
    act(() => current.request());
    toggle(0);
    expect(checkboxes()[2]!.disabled).toBe(false);
    toggle(2);
    expect(checkboxes().map((box) => box.checked)).toEqual([true, true, true, false]);
  });

  it('pre-checks failure-overlay lanes with their dependencies when a preset is supplied', () => {
    render();
    act(() =>
      current.request(deck.pages[0]!.pageId, {
        channels: ['layout', 'narration', 'audio', 'animation'],
      }),
    );
    expect(checkboxes().map((box) => box.checked)).toEqual([true, true, true, true]);
    act(() => current.close());
    // 无预设时仍从空选择开始，避免误触整页重做。
    act(() => current.request(deck.pages[0]!.pageId));
    expect(checkboxes().some((box) => box.checked)).toBe(false);
  });

  it('skips preset lanes whose prerequisites are missing', () => {
    render();
    act(() => current.request(deck.pages[0]!.pageId, { channels: ['audio', 'animation'] }));
    expect(checkboxes().some((box) => box.checked)).toBe(false);
  });

  it('enables page animation only after audio and removes it when audio is unchecked', () => {
    deck.nativeSlides[0]!.slide.narration = { markdown: 'Saved narration' };
    render();
    act(() => current.request(deck.pages[0]!.pageId));
    expect(checkboxes()[2]!.disabled).toBe(false);
    expect(checkboxes()[3]!.disabled).toBe(true);
    toggle(2);
    expect(checkboxes()[3]!.disabled).toBe(false);
    toggle(3);
    expect(checkboxes()[3]!.checked).toBe(true);
    toggle(2);
    expect(checkboxes()[3]!.checked).toBe(false);
    expect(checkboxes()[3]!.disabled).toBe(true);
  });

  it('keeps uncertain retries on one idempotency key and one preparation, including close/reopen', async () => {
    regenerate.mockRejectedValueOnce(new Error('Transport outcome unknown'));
    render();
    act(() => current.request());
    toggle(0);
    await act(async () => submit().click());
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('提交失败');
    act(() => current.close());
    deck = { ...deck, title: 'Edited while outcome unknown' };
    render();
    act(() => current.request());
    expect(checkboxes()[0]!.checked).toBe(true);
    expect(checkboxes().every((box) => box.disabled || box.closest('fieldset')?.disabled)).toBe(
      true,
    );
    expect(document.body.textContent).toContain('上次提交结果尚未确认');
    toggle(1);
    expect(checkboxes()[1]!.checked).toBe(false);
    await act(async () => submit().click());
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(regenerate.mock.calls[0]![1]).toEqual(regenerate.mock.calls[1]![1]);
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('saves changed content on a new command after an explicit revision conflict', async () => {
    regenerate.mockRejectedValueOnce(new ReachDeckApiError('Conflict', 409, 'revision_conflict'));
    render();
    act(() => current.request());
    toggle(0);
    await act(async () => submit().click());
    act(() => current.close());
    deck = { ...deck, title: 'Edited while closed' };
    render();
    act(() => current.request());
    expect(checkboxes()[0]!.checked).toBe(false);
    toggle(0);
    await act(async () => submit().click());
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(regenerate.mock.calls[0]![1].idempotencyKey).not.toBe(
      regenerate.mock.calls[1]![1].idempotencyKey,
    );
  });

  it('uses a new key for changed choices and never posts when saving fails', async () => {
    prepare.mockRejectedValueOnce(new Error('Save failed'));
    regenerate.mockRejectedValueOnce(new ReachDeckApiError('Conflict', 409, 'revision_conflict'));
    render();
    act(() => current.request());
    toggle(0);
    await act(async () => submit().click());
    expect(regenerate).not.toHaveBeenCalled();
    await act(async () => submit().click());
    toggle(1);
    await act(async () => submit().click());
    expect(regenerate.mock.calls[0]![1].idempotencyKey).not.toBe(
      regenerate.mock.calls[1]![1].idempotencyKey,
    );
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('does not turn an accepted command into a failed submission when notification throws', async () => {
    onAccepted.mockImplementation(() => {
      throw new Error('Notification failed');
    });
    render();
    act(() => current.request());
    toggle(0);
    await act(async () => submit().click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it('filters whole-deck options by page support and persistently drops removed capabilities', () => {
    render();
    act(() => current.request());
    toggle(3);
    const quiz = {
      ...deck.pages[0]!,
      sceneType: 'quiz',
      scene: {},
    } as ReachDeckDocument['pages'][number];
    deck = { ...deck, pages: [quiz], nativeSlides: [] };
    render();
    expect(checkboxes()).toHaveLength(1);
    expect(submit().disabled).toBe(true);
    deck = createBlankReachDeckDocument({ id: deck.id, title: 'Deck' });
    render();
    expect(checkboxes().every((box) => !box.checked)).toBe(true);
  });

  it('closes on a changed module or removed target page', () => {
    render();
    act(() => current.request(deck.pages[0]!.pageId));
    deck = { ...deck, pages: [] };
    render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    deck = createBlankReachDeckDocument({ id: 'new', title: 'New' });
    act(() => current.request());
    scope = 'module-v2';
    render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

it('flushes autosave before retrying one image and replays an uncertain submission with the same key', async () => {
  let release!: () => void;
  prepare.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  regenerate.mockRejectedValueOnce(new TypeError('Network disconnected'));
  render();
  let first!: Promise<void>;
  act(() => {
    first = current.retryImage(deck.pages[0]!.pageId, 'image-asset', 'failed');
  });
  expect(prepare).toHaveBeenCalledWith(deck.pages[0]!.pageId);
  expect(regenerate).not.toHaveBeenCalled();
  await act(async () => {
    release();
    await expect(first).rejects.toThrow('Network disconnected');
  });
  await act(async () => current.retryImage(deck.pages[0]!.pageId, 'image-asset', 'failed'));
  expect(regenerate.mock.calls[0]![0]).toMatchObject({
    channels: { layout: false, image: true, narration: false, audio: false, animation: false },
    imageScope: 'failed',
    assetIds: ['image-asset'],
  });
  expect(regenerate.mock.calls[0]![1]).toEqual(regenerate.mock.calls[1]![1]);
});

it.each(['quiz', 'interactive'] as const)(
  'hides image regeneration on a single %s page',
  (sceneType) => {
    deck = {
      ...deck,
      pages: [{ ...deck.pages[0]!, sceneType, scene: {} } as ReachDeckDocument['pages'][number]],
      nativeSlides: [],
    };
    render();
    act(() => current.request(deck.pages[0]!.pageId));
    expect(document.querySelector('.reach-deck-regeneration__image-option')).toBeNull();
    expect(checkboxes()).toHaveLength(sceneType === 'quiz' ? 1 : 3);
  },
);

it('counts images only on pages selected by the Runtime failed-page selector', async () => {
  const firstPageId = deck.pages[0]!.pageId;
  deck = {
    ...deck,
    pages: [...deck.pages, { ...deck.pages[0]!, pageId: 'ready-page', order: 2 }],
    nativeSlides: [...deck.nativeSlides, { ...deck.nativeSlides[0]!, pageId: 'ready-page' }],
  };
  const slot = (index: number, status: 'ready' | 'failed'): ReachDeckPageMediaSlot => ({
    assetId: `asset-${index}`,
    plannedIndex: index,
    elementId: `image-${index}`,
    resourceId: `resource-${index}`,
    binding: 'image-element',
    status,
    planDigest: 'digest',
    attempt: 1,
    plannedAsset: {
      kind: 'image',
      purpose: 'Example',
      prompt: 'Forest',
      alt: 'Image',
      aspectRatio: '1:1',
      placement: 'primary',
    },
    ...(status === 'failed'
      ? { failure: { reason: 'timeout' as const, retryable: true, at: '2026-10-17T00:00:00Z' } }
      : {}),
  });
  mediaSlotsByPageId = {
    [firstPageId]: [slot(0, 'failed')],
    'ready-page': Array.from({ length: 21 }, (_, i) => slot(i + 1, 'ready')),
  };
  const workspace = {
    runId: 'count-run',
    lessonPlan: {},
    pagedOutline: { pages: deck.pages.map((page) => ({ id: page.pageId })) },
    records: Object.fromEntries(deck.pages.map((page) => [page.pageId, {}])),
    statuses: {},
    sceneArtifacts: Object.fromEntries(
      deck.pages.map((page) => [
        page.pageId,
        {
          schemaVersion: 'reach-deck-slide-artifact/v2',
          sceneType: 'slide',
          status: 'ready',
          generationMetadata: { mediaSlots: mediaSlotsByPageId[page.pageId] },
        },
      ]),
    ),
  } as unknown as GenerationWorkspace;
  selectionContext = {
    workspace,
    document: deck,
    channels: { layout: true, image: true, narration: false, audio: false, animation: false },
    scope: 'failed',
  };
  expect(
    selectReachDeckRegenerationPages(selectionContext).accepted.map((page) => page.pageId),
  ).toEqual([firstPageId]);
  render();
  act(() => current.request());
  toggle(0);
  expect(document.body.textContent).toContain('将重新生成 1 张图片');
  await act(async () => submit().click());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(regenerate).toHaveBeenCalledOnce();
});

it('localizes the concurrent image retry rejection', async () => {
  regenerate.mockRejectedValueOnce(
    new ReachDeckApiError('Busy', 409, 'conflict', 'image_generation_in_progress'),
  );
  render();
  await act(async () => {
    await expect(current.retryImage(deck.pages[0]!.pageId, 'image-asset', 'all')).rejects.toThrow(
      '本页图片正在生成',
    );
  });
});

it('reports image retry blocked by an in-flight dialog submission', async () => {
  let release!: () => void;
  regenerate.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  render();
  act(() => current.request(deck.pages[0]!.pageId));
  toggle(0);
  act(() => submit().click());
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await expect(current.retryImage(deck.pages[0]!.pageId, 'asset-1', 'failed')).rejects.toThrow(
      '正在提交生成请求，请稍后重试。',
    );
  });
  expect(regenerate).toHaveBeenCalledTimes(1);
  await act(async () => {
    release();
  });
});

it.each([
  ['zh-CN', '本页图片正在生成。'],
  ['en-US', 'Images on this page are already generating.'],
] as const)(
  'localizes an image conflict submitted from the dialog (%s)',
  async (language, message) => {
    locale = language;
    regenerate.mockRejectedValueOnce(
      new ReachDeckApiError('Busy', 409, 'conflict', 'image_generation_in_progress'),
    );
    render();
    act(() => current.request(deck.pages[0]!.pageId));
    toggle(0);
    await act(async () => submit().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
  },
);
