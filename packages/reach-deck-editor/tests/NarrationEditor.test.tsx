// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REACH_DECK_SAY_AS_INTERPRETATIONS,
  parseReachDeckNarrationSpeechDocument,
  planReachDeckSsmlChunks,
  serializeReachDeckNarrationSpeechDocument,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';

import {
  NarrationEditor,
  type NarrationDraftCache,
  type NarrationEditorSlideProps,
} from '../src/NarrationEditor.js';

describe('NarrationEditor speech marks', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('regenerates only page animations after confirmation and requires saved audio', async () => {
    const onRegenerateAnimationsOnly = vi.fn();
    const onRegenerateAnimations = vi.fn();
    const narration = {
      markdown: '原稿',
      audioResourceId: 'audio-1',
      segments: [{ text: '原稿', start: 0, end: 2 }],
    };
    await act(async () =>
      root.render(
        <NarrationEditor
          slide={{ ...slide(narration), duration: 3 }}
          onRegenerateAnimationsOnly={onRegenerateAnimationsOnly}
          onRegenerateAnimations={onRegenerateAnimations}
        />,
      ),
    );
    const action = () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅重新生成本页动画"]')!;
    expect(action().disabled).toBe(false);
    act(() => action().click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      '保留已保存的讲稿、音频和时间戳',
    );
    expect(onRegenerateAnimationsOnly).not.toHaveBeenCalled();
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((button) => button.textContent === '继续')
        ?.click(),
    );
    expect(onRegenerateAnimationsOnly).toHaveBeenCalledWith({ markdown: '原稿' });
    expect(onRegenerateAnimations).not.toHaveBeenCalled();
    await replaceEditorText('原稿', '改稿');
    expect(action().disabled).toBe(true);
    await render({ markdown: '原稿' }, { onRegenerateAnimationsOnly });
    expect(action().disabled).toBe(true);
  });

  it('allows animation-only regeneration when speech capability is blocked', async () => {
    const onRegenerateAnimationsOnly = vi.fn();
    await act(async () =>
      root.render(
        <NarrationEditor
          slide={{
            ...slide({
              markdown: '原稿',
              speechMarkup: {
                schemaVersion: 'reach-deck-speech-marks/v1' as const,
                marks: [{ type: 'sub' as const, from: 0, to: 2, alias: '原稿' }],
              },
              audioResourceId: 'audio-1',
              segments: [{ text: '原稿', start: 0, end: 2 }],
            }),
            duration: 3,
          }}
          allowedSpeechMarkTypes={[]}
          onRegenerateAnimationsOnly={onRegenerateAnimationsOnly}
        />,
      ),
    );
    const action = host.querySelector<HTMLButtonElement>('[aria-label="仅重新生成本页动画"]')!;
    expect(action.disabled).toBe(false);
    act(() => action.click());
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((button) => button.textContent === '继续')
        ?.click(),
    );
    expect(onRegenerateAnimationsOnly).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: '原稿', speechMarkup: expect.any(Object) }),
    );
  });

  it('retains independent dirty drafts across page changes and panel remounts', async () => {
    const draftCache: NarrationDraftCache = new Map();
    await render({ markdown: '第一页' }, { draftCache, draftCacheKey: 'page-a' });
    await replaceEditorText('第一页', '第一页未保存');
    await render({ markdown: '第二页' }, { draftCache, draftCacheKey: 'page-b' });
    await replaceEditorText('第二页', '第二页未保存');
    await act(async () => root.render(null));
    await render({ markdown: '第一页' }, { draftCache, draftCacheKey: 'page-a' });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('第一页未保存');
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('有未保存的修改');
    await render({ markdown: '第二页' }, { draftCache, draftCacheKey: 'page-b' });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('第二页未保存');
  });

  it('preserves dirty narration through server refill but adopts refill for a clean page', async () => {
    const draftCache: NarrationDraftCache = new Map();
    await render({ markdown: '原稿' }, { draftCache });
    await replaceEditorText('原稿', '正在编辑');
    await render({ markdown: '后台新稿' }, { draftCache });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('正在编辑');
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('有未保存的修改');
    await render({ markdown: '干净页面' }, { draftCache, draftCacheKey: 'other' });
    await render({ markdown: '后台更新' }, { draftCache, draftCacheKey: 'other' });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('后台更新');
  });

  it('adopts narration generated after the page was first opened without narration', async () => {
    const draftCache: NarrationDraftCache = new Map();
    await render(undefined, { draftCache, draftCacheKey: 'page-a' });
    expect(host.querySelector('footer [role="status"]')?.textContent).not.toBe('有未保存的修改');
    expect(draftCache.get('page-a')?.dirty).toBe(false);
    await render({ markdown: '后台生成的讲稿' }, { draftCache, draftCacheKey: 'page-a' });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('后台生成的讲稿');
  });

  it('does not cache a manual-review candidate over an externally generated narration', async () => {
    const draftCache: NarrationDraftCache = new Map();
    await render({ markdown: '原稿' }, { draftCache, fallbackMarkdown: '待复核候选稿' });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('待复核候选稿');
    expect(draftCache.size).toBe(0);
    await render({ markdown: '后台生成的新稿' }, { draftCache });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('后台生成的新稿');
    expect(host.querySelector('footer [role="status"]')?.textContent).not.toBe('有未保存的修改');
  });

  it.each(['save', 'rewrite'] as const)(
    'clears manual-review busy state and reports failed %s operations without a cached draft',
    async (action) => {
      const draftCache: NarrationDraftCache = new Map();
      const request = deferred<void>();
      const callback = vi.fn(async () => {
        await request.promise;
        throw new Error('internal failure');
      });
      const regenerateButtonRef = { current: null as HTMLButtonElement | null };
      await render(
        { markdown: '原稿' },
        {
          draftCache,
          draftCacheKey: 'review-page',
          fallbackMarkdown: '待复核候选稿',
          onSaveAndGenerate: callback,
          onRegenerate: callback,
          regenerateButtonRef,
        },
      );
      const saveButton = () =>
        host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')!;
      if (action === 'save') act(() => saveButton().click());
      else {
        act(() => regenerateButtonRef.current?.click());
        act(() =>
          [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
            .find((button) => button.textContent === '继续')
            ?.click(),
        );
      }
      expect(callback).toHaveBeenCalledOnce();
      expect(draftCache.size).toBe(0);
      await act(async () => request.resolve());
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        action === 'save' ? '保存讲稿并生成音频与动画失败' : 'AI 重新生成讲稿失败',
      );
      expect(saveButton().disabled).toBe(false);
      expect(regenerateButtonRef.current?.disabled).toBe(false);
      expect(host.querySelector('.ProseMirror')?.textContent).toBe('待复核候选稿');
    },
  );

  it('does not apply a previous page save completion to the active page', async () => {
    const draftCache: NarrationDraftCache = new Map();
    const saved = deferred<void>();
    const onSaveDraft = vi.fn(() => saved.promise);
    await render({ markdown: '原稿' }, { draftCache, draftCacheKey: 'first', onSaveDraft });
    await replaceEditorText('原稿', '已提交的修改');
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click());
    await render({ markdown: '另一页' }, { draftCache, draftCacheKey: 'second', onSaveDraft });
    await act(async () => saved.resolve());
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('已保存，旁白待更新');
    await render({ markdown: '原稿' }, { draftCache, draftCacheKey: 'first', onSaveDraft });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('已提交的修改');
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('已保存，旁白待更新');
  });

  it('releases cached edits after confirmed AI rewrite so generated narration can land', async () => {
    const draftCache: NarrationDraftCache = new Map();
    const onRegenerate = vi.fn().mockResolvedValue(undefined);
    const regenerateButtonRef = { current: null as HTMLButtonElement | null };
    await render({ markdown: '原稿' }, { draftCache, onRegenerate, regenerateButtonRef });
    await replaceEditorText('原稿', '本地修改');
    act(() => regenerateButtonRef.current?.click());
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((b) => b.textContent === '继续')
        ?.click(),
    );
    expect(onRegenerate).toHaveBeenCalledOnce();
    await render({ markdown: '生成的新稿' }, { draftCache, onRegenerate, regenerateButtonRef });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('生成的新稿');
  });

  it('does not erase a newer remounted draft when an old rewrite request completes', async () => {
    const draftCache: NarrationDraftCache = new Map();
    const request = deferred<void>();
    const onRegenerate = vi.fn(() => request.promise);
    const regenerateButtonRef = { current: null as HTMLButtonElement | null };
    await render({ markdown: '原稿' }, { draftCache, onRegenerate, regenerateButtonRef });
    await replaceEditorText('原稿', '确认丢弃的修改');
    act(() => regenerateButtonRef.current?.click());
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((b) => b.textContent === '继续')
        ?.click(),
    );
    await act(async () => root.render(null));
    await render({ markdown: '原稿' }, { draftCache, onRegenerate, regenerateButtonRef });
    await replaceEditorText('确认丢弃的修改', '重新输入的草稿');
    await act(async () => request.resolve());
    await act(async () => root.render(null));
    await render({ markdown: '后台新稿' }, { draftCache, onRegenerate, regenerateButtonRef });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('重新输入的草稿');
  });

  it('keeps the latest successful save baseline when an older mounted instance completes late', async () => {
    const draftCache: NarrationDraftCache = new Map();
    const oldSave = deferred<void>();
    const onSaveDraft = vi
      .fn()
      .mockImplementationOnce(() => oldSave.promise)
      .mockResolvedValue(undefined);
    await render({ markdown: '原稿' }, { draftCache, onSaveDraft });
    await replaceEditorText('原稿', '第一版');
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click());
    await act(async () => root.render(null));
    await render({ markdown: '原稿' }, { draftCache, onSaveDraft });
    await replaceEditorText('第一版', '第二版');
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
    );
    await act(async () => oldSave.resolve());
    await act(async () => root.render(null));
    await render({ markdown: '原稿' }, { draftCache, onSaveDraft });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('第二版');
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('已保存，旁白待更新');
  });

  it.each([
    ['语音标记', '显示语音标记', '调整发音、停顿和语速'],
    ['Speech marks', 'Show speech marks', 'Adjust pronunciation, pauses, and speaking speed'],
  ])('names the speech switch and explains it accessibly: %s', async (label, showTags, help) => {
    const translations: Record<string, string> = {
      'reachDeck.editor.narration.speech.label': label,
      'reachDeck.editor.narration.speech.showTags': showTags,
      'reachDeck.editor.narration.speech.help': help,
    };
    await render(
      { markdown: '今天发布' },
      label === '语音标记' ? {} : { translate: (key) => translations[key] ?? key },
    );
    const toggle = host.querySelector<HTMLInputElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-label')).toBe(showTags);
    expect(toggle?.getAttribute('aria-description')).toBe(help);
    expect(toggle?.closest('label')?.title).toBe(help);
    expect(toggle?.closest('label')?.textContent).toBe(label);
    expect(host.textContent).not.toContain('SSML');
    act(() => toggle?.click());
    expect(toggle?.checked).toBe(true);
  });

  it('keeps preview and apply in the footer and preserves rewrite confirmation in the more menu', async () => {
    const onRegenerate = vi.fn();
    const regenerateButtonRef = { current: null as HTMLButtonElement | null };
    await render(
      { markdown: '今天发布' },
      {
        onRegenerate,
        regenerateButtonRef,
        onPreviewSpeech: vi.fn(),
        onSaveAndGenerate: vi.fn(),
        onSaveDraft: vi.fn(),
      },
    );
    const footer = host.querySelector('footer')!;
    expect(footer.querySelector('[aria-label="试听"]')).not.toBeNull();
    expect(footer.querySelector('[aria-label="保存讲稿并生成音频与动画"]')).not.toBeNull();
    expect(footer.querySelector('[aria-label="保存选项"]')).not.toBeNull();
    expect(host.querySelector('[role="toolbar"] [aria-label="试听"]')).toBeNull();
    const menu = host.querySelector<HTMLDetailsElement>('details')!;
    act(() => menu.querySelector('summary')?.click());
    expect(menu.open).toBe(true);
    expect(regenerateButtonRef.current?.getAttribute('aria-label')).toBe(
      '重新生成本页讲稿、音频和动画',
    );
    act(() => regenerateButtonRef.current?.click());
    expect(onRegenerate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'AI 将重新生成本页讲稿，并据此重新合成音频、生成讲稿动画，覆盖现有讲稿、音频和讲稿动画。是否继续？',
    );
  });

  it('orders the full pipeline first and groups partial generation in an inline submenu', async () => {
    await render(
      { markdown: '今天发布' },
      {
        onRegenerate: vi.fn(),
        onRegenerateTextOnly: vi.fn(),
        onSaveAudio: vi.fn(),
        onRegenerateAnimationsOnly: vi.fn(),
        onRegenerateAnimations: vi.fn(),
      },
    );
    const menu = host.querySelector<HTMLDetailsElement>('details')!;
    act(() => menu.querySelector('summary')?.click());
    const items = menu.querySelector('.reach-deck-timeline__narration-menu-items')!;
    const [first, toggle] = [...items.children] as HTMLElement[];
    expect(first?.getAttribute('aria-label')).toBe('重新生成本页讲稿、音频和动画');
    expect(toggle?.textContent).toBe('更多部分生成');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    const group = document.getElementById(toggle!.getAttribute('aria-controls')!)!;
    expect(group.hidden).toBe(true);
    expect(
      [...group.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      '仅重新生成本页讲稿',
      '仅生成本页音频',
      '仅重新生成本页动画',
      '重新生成本页音频和动画',
    ]);
    act(() => toggle!.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(group.hidden).toBe(false);
    expect(menu.open).toBe(true);
    expect(host.querySelector('[aria-label="全部生成音频"]')).toBeNull();
    act(() => {
      menu.open = false;
      menu.dispatchEvent(new Event('toggle'));
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(group.hidden).toBe(true);
  });

  it('confirms text-only regeneration, states what is cleared and discards unsaved edits', async () => {
    const onRegenerate = vi.fn();
    const onRegenerateTextOnly = vi.fn();
    await render({ markdown: '原稿' }, { onRegenerate, onRegenerateTextOnly });
    await replaceEditorText('原稿', '改稿');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="仅重新生成本页讲稿"]')!.click());
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('确认仅重新生成本页讲稿');
    expect(dialog.textContent).toContain('本页现有音频和讲稿动画将被清除');
    expect(dialog.textContent).toContain('尚未保存的修改也会被丢弃');
    expect(onRegenerateTextOnly).not.toHaveBeenCalled();
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((button) => button.textContent === '继续')!
        .click(),
    );
    expect(onRegenerateTextOnly).toHaveBeenCalledOnce();
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it('saves canonical speech markup as draft without applying and reports pending narration', async () => {
    const draftSave = deferred<void>();
    const onSaveDraft = vi.fn(() => draftSave.promise);
    const onSaveAndGenerate = vi.fn();
    const original = {
      markdown: '今天2026年发布',
      audioResourceId: 'audio-1',
      segments: [{ id: 'segment-1', text: '今天2026年发布', start: 0, end: 1 }],
    };
    await render(original, { onSaveDraft, onSaveAndGenerate });
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('已应用');
    await selectText('2026');
    enableSpeechTags();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="替换读法"]')?.click());
    changeInput('替换读法', '二零二六', speechDialog());
    act(() => speechDialog()?.querySelector<HTMLButtonElement>('[type="submit"]')?.click());
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('有未保存的修改');
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click());
    expect(onSaveDraft).toHaveBeenCalledWith({
      markdown: '今天2026年发布',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'sub', from: 2, to: 6, alias: '二零二六' }],
      },
    });
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.disabled,
    ).toBe(true);
    await act(async () => draftSave.resolve());
    expect(onSaveAndGenerate).not.toHaveBeenCalled();
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('已保存，旁白待更新');
  });

  it('keeps a draft failure visible without claiming the narration was applied', async () => {
    const onSaveDraft = vi.fn().mockRejectedValue(new Error('save failed'));
    await render({ markdown: '今天发布' }, { onSaveDraft });
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('保存草稿失败');
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('已保存，旁白待更新');
  });

  it.each([
    '这一页的音频还在生成中。请等它结束或先取消，再重新生成。',
    'This page is still generating audio. Wait for it to finish, or cancel it, before generating again.',
  ])('preserves the draft and displays a localized in-flight error: %s', async (message) => {
    const error = new Error(message);
    error.name = 'ReachDeckUserFacingError';
    const onSaveAndGenerate = vi.fn().mockRejectedValue(error);
    await render({ markdown: '今天2026年发布' }, { onSaveAndGenerate });
    await selectText('2026');
    enableSpeechTags();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="替换读法"]')?.click());
    changeInput('替换读法', '二零二六', speechDialog());
    act(() => speechDialog()?.querySelector<HTMLButtonElement>('[type="submit"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click(),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('有未保存的修改');
    expect(onSaveAndGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: '今天2026年发布',
        speechMarkup: expect.objectContaining({
          marks: [expect.objectContaining({ alias: '二零二六' })],
        }),
      }),
    );
  });

  it('does not expose internal errors when applying narration fails', async () => {
    await render(
      { markdown: '今天发布' },
      {
        onSaveAndGenerate: vi.fn().mockRejectedValue(new Error('private upstream diagnostics')),
      },
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click(),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      '保存讲稿并生成音频与动画失败',
    );
    expect(host.textContent).not.toContain('private upstream diagnostics');
  });

  it('shows narration updating during save and while the host awaits generated media', async () => {
    const save = deferred<void>();
    const onSaveAndGenerate = vi.fn(() => save.promise);
    const narration = {
      markdown: '今天发布',
      audioResourceId: 'audio-1',
      segments: [{ text: '今天发布', start: 0, end: 1 }],
    };
    await render(narration, { onSaveAndGenerate });
    act(() =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click(),
    );
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('正在更新旁白…');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="正在应用…"]')?.disabled).toBe(true);
    await act(async () => save.resolve());
    await render(narration, { onSaveAndGenerate, applying: true });
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('正在更新旁白…');
    await render(narration, { onSaveAndGenerate, applying: false });
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('已应用');
  });

  it('confirms animation replacement and forwards current narration without rewriting it', async () => {
    const onRegenerate = vi.fn();
    const onRegenerateAnimations = vi.fn();
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'sub' as const, from: 2, to: 6, alias: '二零二六' }],
    };
    await render(
      { markdown: '今天2026年发布', speechMarkup },
      { onRegenerate, onRegenerateAnimations },
    );
    act(() => host.querySelector<HTMLElement>('[aria-label="更多讲稿操作"]')?.click());
    act(() =>
      host.querySelector<HTMLButtonElement>('[aria-label="重新生成本页音频和动画"]')?.click(),
    );
    expect(onRegenerateAnimations).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      '此操作会重新生成并替换当前讲稿的音频和动画，保留讲稿文本。是否继续？',
    );
    await act(async () =>
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent === '继续')
        ?.click(),
    );
    expect(onRegenerateAnimations).toHaveBeenCalledWith({
      markdown: '今天2026年发布',
      speechMarkup,
    });
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it('shows persisted tag chips without making the draft dirty', async () => {
    await render({
      markdown: '今天2026年发布',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'say-as', from: 2, to: 6, interpretAs: 'Cardinal' }],
      },
    });
    expect(host.textContent).not.toContain('有未保存的修改');

    const toolbar = host.querySelector<HTMLElement>('[role="toolbar"]');
    expect(toolbar?.querySelector('[aria-label="插入行内公式"]')).not.toBeNull();
    expect(toolbar?.querySelector('[role="switch"]')).not.toBeNull();

    act(() => host.querySelector<HTMLInputElement>('[role="switch"]')?.click());

    expect(host.textContent).not.toContain('有未保存的修改');
    expect(
      ['停顿', '替换读法', '指定读法', '发音'].every(
        (label) => toolbar?.querySelector(`[aria-label="${label}"]`) !== null,
      ),
    ).toBe(true);
    expect(toolbar?.querySelector('[aria-label="插入音效"]')).toBeNull();
    expect(
      host
        .querySelector('.reach-deck-editor__rich-text-surface')
        ?.classList.contains('reach-deck-editor__rich-text-surface--show-speech-tags'),
    ).toBe(true);
    expect(host.querySelector('[data-reach-deck-speech-mark="say-as"]')).not.toBeNull();
  });

  it('uses the host translation for a persisted pause readout', async () => {
    await render(
      {
        markdown: '请稍候。',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 300 }],
        },
      },
      {
        translate: (key, replacements) =>
          key === 'reachDeck.editor.narration.speech.breakAria'
            ? `Pause for ${replacements?.duration} milliseconds`
            : key,
      },
    );

    expect(host.querySelector('[data-reach-deck-speech-break]')?.getAttribute('aria-label')).toBe(
      'Pause for 300 milliseconds',
    );
  });

  it('converts multiple pasted pauses from plain text even when HTML is present and preserves one undo step', async () => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: '前换掉后' }, { onSaveAndGenerate });
    enableSpeechTags();
    await selectText('换掉');

    await pasteNarration('A<break time="300ms"/>B<break time=\'0.5s\'/>C', '<p>wrong HTML</p>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(2);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('前ABC后');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')?.click());
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('前换掉后');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="重做"]')?.click());
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(2);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: '前ABC后',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [
          { type: 'break', at: 2, durationMs: 300 },
          { type: 'break', at: 3, durationMs: 500 },
        ],
      },
    });
  });

  it('attaches a pause-only pasted line to the previous paragraph and survives a save/reopen round trip', async () => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: '旧讲稿' }, { onSaveAndGenerate });
    enableSpeechTags();
    await selectText('旧讲稿');
    await pasteNarration('第一句。\n<break time="500ms"/>\n第二句。');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    const saved = onSaveAndGenerate.mock.calls[0]?.[0];
    expect(saved).toEqual({
      markdown: '第一句。\n\n第二句。',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 4, durationMs: 500 }],
      },
    });
    expect(
      serializeReachDeckNarrationSpeechDocument(
        parseReachDeckNarrationSpeechDocument(saved.markdown, saved.speechMarkup),
      ),
    ).toEqual(saved);
    expect(planReachDeckSsmlChunks(saved.markdown, saved.speechMarkup)[0]?.ssml).toContain(
      '<break time="500ms"/>',
    );
  });

  it('preserves the paragraph break after a leading pause-only line at an interior caret', async () => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: 'ABCD' }, { onSaveAndGenerate });
    enableSpeechTags();
    await placeCaret('ABCD', 2);
    await pasteNarration('<break 300ms/>\nX');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: 'AB\n\nXCD',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 2, durationMs: 300 }],
      },
    });
  });

  it('preserves the paragraph break before a trailing pause-only line at an interior caret', async () => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: 'XY' }, { onSaveAndGenerate });
    enableSpeechTags();
    await placeCaret('XY', 1);
    await pasteNarration('A\n<break 300ms/>');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: 'XA\n\nY',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 4, durationMs: 300 }],
      },
    });
  });

  it('avoids an empty first paragraph for a leading pause pasted at paragraph start', async () => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: 'CD' }, { onSaveAndGenerate });
    enableSpeechTags();
    await placeCaret('CD', 0);
    await pasteNarration('<break 300ms/>\nX');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: 'XCD',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 0, durationMs: 300 }],
      },
    });
  });

  it.each([
    ['A<break 300ms/>\n', 'A', 1],
    ['\n<break 300ms/>A', 'A', 0],
  ])('converts a pause when pasted text has an outer newline: %s', async (pasted, markdown, at) => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: '旧讲稿' }, { onSaveAndGenerate });
    enableSpeechTags();
    await selectText('旧讲稿');
    await pasteNarration(pasted);

    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown,
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at, durationMs: 300 }],
      },
    });
  });

  it('converts pauses across blank-line paragraph separators and a trailing newline', async () => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: '旧讲稿' }, { onSaveAndGenerate });
    enableSpeechTags();
    await selectText('旧讲稿');
    await pasteNarration('A<break time="300ms"/>\n\nB<break time="1s"/>\n');

    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(2);
    expect(host.textContent).not.toContain('部分语音标记未转换');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: 'A\n\nB',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [
          { type: 'break', at: 1, durationMs: 300 },
          { type: 'break', at: 4, durationMs: 1000 },
        ],
      },
    });
  });

  it.each([
    ['\nX<break 300ms/>', 'AB\n\nXCD', 5],
    ['X<break 300ms/>\n', 'ABX\n\nCD', 3],
  ])(
    'keeps a pasted outer newline that separates existing text: %s',
    async (pasted, markdown, at) => {
      const onSaveAndGenerate = vi.fn();
      await render({ markdown: 'ABCD' }, { onSaveAndGenerate });
      enableSpeechTags();
      await placeCaret('ABCD', 2);
      await pasteNarration(pasted);

      expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
        await Promise.resolve();
      });
      expect(onSaveAndGenerate).toHaveBeenCalledWith({
        markdown,
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at, durationMs: 300 }],
        },
      });
    },
  );

  it('keeps a pre-existing speech mark and maps a pasted pause after formula and escaped Markdown', async () => {
    const onSaveAndGenerate = vi.fn();
    await render(
      {
        markdown: '甲\\(x<2\\)A\\-B',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'sub', from: 0, to: 1, alias: '第一' }],
        },
      },
      { onSaveAndGenerate },
    );
    enableSpeechTags();
    await selectText('B');
    await pasteNarration('B<break time="200ms"/>😀');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: '甲\\(x<2\\)A\\-B😀',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [
          { type: 'sub', from: 0, to: 1, alias: '第一' },
          { type: 'break', at: 12, durationMs: 200 },
        ],
      },
    });
  });

  it('undoes a tagged paste separately from the preceding text edit', async () => {
    await render({ markdown: '甲乙' });
    await replaceEditorText('乙', '丙');
    enableSpeechTags();
    await placeCaret('甲丙', 2);
    await pasteNarration('<break 100ms/>丁');
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲丙丁');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')?.click());
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲丙');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')?.click());
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
  });

  it('pastes adjacent pauses literally with a visible fallback notice', async () => {
    await render({ markdown: '正文' });
    enableSpeechTags();
    await placeCaret('正文', 1);
    await pasteNarration('<break 300ms/><break 200ms/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(0);
    expect(host.querySelector('.ProseMirror')?.textContent).toContain(
      '<break 300ms/><break 200ms/>',
    );
    expect(host.textContent).toContain('部分语音标记未转换，已保留原文。');
  });

  it('keeps an existing pause when a pasted pause conflicts at its Markdown position', async () => {
    const onSaveAndGenerate = vi.fn();
    await render(
      {
        markdown: '甲乙',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 300 }],
        },
      },
      { onSaveAndGenerate },
    );
    enableSpeechTags();
    await placeCaret('乙', 0);
    await pasteNarration('<break 200ms/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
    expect(host.querySelector('.ProseMirror')?.textContent).toContain('<break 200ms/>');
    expect(host.textContent).toContain('部分语音标记未转换，已保留原文。');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate.mock.calls[0]?.[0].speechMarkup.marks).toEqual([
      { type: 'break', at: 1, durationMs: 300 },
    ]);
  });

  it('keeps unsupported markup literal beside a converted pause', async () => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: '正文' }, { onSaveAndGenerate });
    enableSpeechTags();
    await placeCaret('正文', 1);
    await pasteNarration('甲<break 100ms/><emphasis>乙</emphasis><break strength="weak"/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
    expect(host.querySelector('.ProseMirror')?.textContent).toContain(
      '<emphasis>乙</emphasis><break strength="weak"/>',
    );
    expect(host.textContent).toContain('部分语音标记未转换，已保留原文。');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate.mock.calls[0]?.[0].speechMarkup.marks).toEqual([
      { type: 'break', at: 2, durationMs: 100 },
    ]);
  });

  it('shows the paste fallback notice through the host translation', async () => {
    await render(
      { markdown: 'Text' },
      {
        translate: (key) =>
          key === 'reachDeck.editor.narration.speech.pasteFallback'
            ? 'Some pause tags could not be converted and remain as text.'
            : key,
      },
    );
    enableSpeechTags();
    await placeCaret('Text', 2);
    await pasteNarration('<break time="0ms"/>');
    expect(host.textContent).toContain(
      'Some pause tags could not be converted and remain as text.',
    );
  });

  it('keeps fallback and pronunciation-mark invalidation notices visible together', async () => {
    const onSaveAndGenerate = vi.fn();
    await render(
      {
        markdown: 'ABCDE',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'sub', from: 1, to: 4, alias: 'XYZ' }],
        },
      },
      { onSaveAndGenerate },
    );
    enableSpeechTags();
    await selectText('C');
    await pasteNarration('<break time="200ms"/>');
    expect(host.querySelector('.ProseMirror')?.textContent).toContain('<break time="200ms"/>');
    expect(host.textContent).toContain('部分语音标记未转换，已保留原文。');
    expect(host.textContent).toContain('正文修改影响了 1 个语音标记');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });
    expect(onSaveAndGenerate.mock.calls[0]?.[0].speechMarkup).toBeUndefined();
  });

  it('converts a pause after a literal less-than comparison', async () => {
    const onSaveDraft = vi.fn();
    await render({ markdown: '甲乙' }, { onSaveDraft });
    await placeCaret('甲乙', 1);
    await pasteNarration('1 < 2 <break time="500ms"/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲1 < 2 乙');
    expect(host.textContent).not.toContain('部分语音标记未转换');
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
    );
    expect(onSaveDraft).toHaveBeenCalledWith({
      markdown: '甲1 \\< 2 乙',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 8, durationMs: 500 }],
      },
    });
  });

  it('keeps malformed pauses literal and leaves paste conversion off when breaks are disallowed', async () => {
    await render({ markdown: '甲乙' });
    enableSpeechTags();
    await placeCaret('甲乙', 1);
    await pasteNarration('<break time="0ms"/><break strength="medium"/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(0);
    expect(host.textContent).toContain('部分语音标记未转换，已保留原文。');

    await render({ markdown: '新正文' });
    await placeCaret('新正文', 1);
    await pasteNarration('<break time="<break 300ms/>"/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(0);

    await render({ markdown: '丙丁' }, { allowedSpeechMarkTypes: [] });
    await placeCaret('丙丁', 1);
    await pasteNarration('<break 300ms/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(0);
  });

  it('converts supported speech tags while speech marks are hidden', async () => {
    await render({ markdown: '甲乙' });
    await placeCaret('甲乙', 1);
    await pasteNarration('<break 300ms/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
  });

  it('does not change a locked narration when a pause is pasted', async () => {
    await render({ markdown: '甲乙' }, { disabled: true, speechTagsInitiallyVisible: true });
    await pasteNarration('<break 300ms/>');
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(0);
  });

  it('leaves a paste inside an active formula field to MathLive', async () => {
    await render({ markdown: '甲乙' }, { speechTagsInitiallyVisible: true });
    const field = document.createElement('math-field');
    host.querySelector('.reach-deck-editor__rich-text')?.append(field);
    const clipboardData = {
      files: [],
      getData: (type: string) => (type === 'text/plain' ? '<break 300ms/>' : ''),
      items: [],
      types: ['text/plain'],
    } as unknown as DataTransfer;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
    act(() => field.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(0);
  });

  it('keeps the pause input step aligned with its integer-millisecond validation', async () => {
    await render({ markdown: '请稍候。' });
    await selectText('');
    enableSpeechTags();

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="停顿"]')?.click());
    const duration = speechDialog()?.querySelector<HTMLInputElement>('[aria-label="停顿毫秒数"]');

    expect(duration?.step).toBe('1');
    changeInput('停顿毫秒数', '650', speechDialog());
    expect(duration?.checkValidity()).toBe(true);
  });

  it('applies a selected sub mark, saves its canonical Markdown range, and supports undo/redo', async () => {
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: '今天2026年发布' }, { onSaveAndGenerate });
    await selectText('2026');
    enableSpeechTags();

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="替换读法"]')?.click());
    expect(host.textContent).not.toContain('有未保存的修改');
    expect(speechDialog()?.textContent).toContain('已选择：2026');
    changeInput('替换读法', '二零二六', speechDialog());

    act(() => speechDialog()?.querySelector<HTMLButtonElement>('[type="submit"]')?.click());
    expect(host.textContent).toContain('有未保存的修改');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')?.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="重做"]')?.click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });

    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: '今天2026年发布',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'sub', from: 2, to: 6, alias: '二零二六' }],
      },
    });
  });

  it('dismisses a mark dialog without mutation and restores focus to its toolbar command', async () => {
    await render({ markdown: '今天2026年发布' });
    await selectText('2026');
    enableSpeechTags();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="指定读法"]')!;

    act(() => trigger.click());
    expect(speechDialog()).not.toBeNull();
    act(() => speechDialog()?.querySelector<HTMLButtonElement>('[aria-label="取消"]')?.click());
    await act(async () => Promise.resolve());
    expect(speechDialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(host.textContent).not.toContain('有未保存的修改');

    act(() => trigger.click());
    act(() =>
      speechDialog()?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
    );
    await act(async () => Promise.resolve());
    expect(speechDialog()).toBeNull();
    expect(host.textContent).not.toContain('有未保存的修改');

    act(() => trigger.click());
    expect(speechDialog()?.getAttribute('aria-modal')).toBeNull();
    expect(document.body.querySelector('.reach-deck-speech-dialog-backdrop')).toBeNull();
    act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    await act(async () => Promise.resolve());
    expect(speechDialog()).toBeNull();
    expect(host.textContent).not.toContain('有未保存的修改');
  });

  it('prefills and updates an existing speech mark from the matching toolbar command', async () => {
    const onSaveAndGenerate = vi.fn();
    await render(
      {
        markdown: '今天2026年发布',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'sub', from: 2, to: 6, alias: '二零二六' }],
        },
      },
      { onSaveAndGenerate },
    );
    enableSpeechTags();
    await selectText('2026');

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="替换读法"]')?.click());
    expect(speechDialog()?.querySelector<HTMLInputElement>('[aria-label="替换读法"]')?.value).toBe(
      '二零二六',
    );
    changeInput('替换读法', '两千零二十六', speechDialog());
    act(() => speechDialog()?.querySelector<HTMLButtonElement>('[type="submit"]')?.click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });

    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: '今天2026年发布',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'sub', from: 2, to: 6, alias: '两千零二十六' }],
      },
    });
  });

  it('confirms audio-only generation and makes cancellation inert', async () => {
    const onSaveAudio = vi.fn();
    const onSaveAndGenerate = vi.fn();
    await render({ markdown: '今天2026年发布' }, { onSaveAudio, onSaveAndGenerate });
    const audio = host.querySelector<HTMLButtonElement>('[aria-label="仅生成本页音频"]')!;
    act(() => audio.click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      '清空本页全部动画',
    );
    expect(onSaveAudio).not.toHaveBeenCalled();
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((b) => b.textContent === '取消')!
        .click(),
    );
    expect(onSaveAudio).not.toHaveBeenCalled();
    act(() => audio.click());
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((b) => b.textContent === '继续')!
        .click(),
    );
    expect(onSaveAudio).toHaveBeenCalledWith({ markdown: '今天2026年发布' });
    expect(onSaveAndGenerate).not.toHaveBeenCalled();
    // 单页面板不再提供作用于整份 Deck 的“全部生成音频”。
    expect(host.querySelector('[aria-label="全部生成音频"]')).toBeNull();
  });

  it('offers every supported say-as interpretation in its parameter dialog', async () => {
    await render({ markdown: '今天2026年发布' });
    await selectText('2026');
    enableSpeechTags();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="指定读法"]')?.click());

    const trigger = speechDialog()?.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="读法类型"]',
    );
    act(() => trigger?.click());
    const options = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        '[role="listbox"][aria-label="读法类型"] [role="option"]',
      ),
    ).map((option) => option.textContent ?? '');
    expect(options).toHaveLength(REACH_DECK_SAY_AS_INTERPRETATIONS.length);
    for (const value of [
      'Cardinal',
      'Spell-Yao',
      'Date-YMD',
      'Telephone',
      'Verbatim',
      'Decimal',
      'plain',
    ]) {
      expect(options.some((option) => option.includes(`(${value})`))).toBe(true);
    }
  });

  it('inserts an experimental sound event from its anchored toolbar popover', async () => {
    const onSaveAndGenerate = vi.fn();
    await render(
      { markdown: '提示音后继续。' },
      {
        allowedSpeechMarkTypes: ['break', 'soundEvent'],
        onSaveAndGenerate,
        speechTagsInitiallyVisible: true,
      },
    );
    await selectText('');
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="插入音效"]')!;

    act(() => trigger.click());
    expect(speechDialog()?.getAttribute('data-placement')).toBe('bottom');
    expect(document.body.querySelector('.reach-deck-speech-dialog-backdrop')).toBeNull();
    changeInput('音效文件 URL', 'https://example.com/chime.mp3', speechDialog());
    act(() => speechDialog()?.querySelector<HTMLButtonElement>('[type="submit"]')?.click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });

    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: '提示音后继续。',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'soundEvent', at: 0, src: 'https://example.com/chime.mp3' }],
      },
    });
  });

  it('applies harness-only speak settings without a global modal', async () => {
    const onSaveAndGenerate = vi.fn();
    await render(
      { markdown: '整篇讲稿。' },
      {
        allowSpeechDocumentSettings: true,
        onSaveAndGenerate,
        speechTagsInitiallyVisible: true,
      },
    );

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="背景与声音效果"]')?.click());
    expect(speechDialog()?.getAttribute('aria-modal')).toBeNull();
    changeInput('背景音乐 URL', 'https://example.com/bgm.mp3', speechDialog());
    changeInput('背景音乐音量（0–100）', '35', speechDialog());
    changeSelect('声音效果', 'true_robot', speechDialog()!);
    act(() => speechDialog()?.querySelector<HTMLButtonElement>('[type="submit"]')?.click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });

    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: '整篇讲稿。',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [],
        speak: {
          backgroundMusicVolume: 35,
          bgm: 'https://example.com/bgm.mp3',
          effect: 'true_robot',
        },
      },
    });
  });

  it('validates phoneme source text and pronunciation before applying it', async () => {
    await render({ markdown: 'hello 重' });
    await selectText('hello');
    enableSpeechTags();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="发音"]')?.click());
    const dialog = speechDialog();
    const submit = dialog?.querySelector<HTMLButtonElement>('[type="submit"]');

    expect(dialog?.querySelector<HTMLInputElement>('input[value="ipa"]')?.checked).toBe(true);
    expect(submit?.disabled).toBe(true);
    changeInput('发音标注', 'həˈloʊ', dialog);
    expect(submit?.disabled).toBe(false);
    act(() => dialog?.querySelector<HTMLInputElement>('input[value="py"]')?.click());
    expect(dialog?.textContent).toContain('拼音标注只能应用到纯汉字选区。');
    expect(submit?.disabled).toBe(true);
  });

  it('builds provider phonemes from the alphabet-specific reference panel', async () => {
    await render({ markdown: '重 hello' });
    await selectText('重');
    enableSpeechTags();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="发音"]')?.click());

    const dialog = speechDialog();
    expect(dialog?.textContent).toContain('每个汉字一个拼音');
    act(() => dialog?.querySelector<HTMLButtonElement>('[aria-label="插入音素 4 去声"]')?.click());
    expect(dialog?.querySelector<HTMLInputElement>('[aria-label="发音标注"]')?.value).toBe('4');

    act(() => dialog?.querySelector<HTMLInputElement>('input[value="cmu"]')?.click());
    expect(dialog?.textContent).toContain('音素用空格分隔');
    act(() => dialog?.querySelector<HTMLButtonElement>('[aria-label="清空"]')?.click());
    act(() => dialog?.querySelector<HTMLButtonElement>('[aria-label="插入音素 HH"]')?.click());
    act(() => dialog?.querySelector<HTMLButtonElement>('[aria-label="插入音素 AH"]')?.click());
    act(() =>
      dialog?.querySelector<HTMLButtonElement>('[aria-label="插入音素 0 无重音"]')?.click(),
    );
    expect(dialog?.querySelector<HTMLInputElement>('[aria-label="发音标注"]')?.value).toBe(
      'HH AH0',
    );

    act(() => dialog?.querySelector<HTMLInputElement>('input[value="ipa"]')?.click());
    expect(dialog?.textContent).toContain('美式音标');
    expect(dialog?.querySelector('[aria-label="插入音素 oʊ"]')).not.toBeNull();
  });

  it('shows smart tagging progress and prevents duplicate requests until candidates arrive', async () => {
    const candidates = [
      {
        id: 'candidate-1',
        mark: { type: 'say-as' as const, from: 2, to: 6, interpretAs: 'Cardinal' as const },
        sourceText: '2026',
      },
    ];
    let resolveCandidates!: (value: typeof candidates) => void;
    const onRequestSpeechMarkupCandidates = vi.fn(
      () => new Promise<typeof candidates>((resolve) => (resolveCandidates = resolve)),
    );
    await render({ markdown: '今天2026年发布' }, { onRequestSpeechMarkupCandidates });
    const button = host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')!;

    act(() => button.click());

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('[role="status"]')?.textContent).toBe('智能打标中');
    act(() => button.click());
    expect(onRequestSpeechMarkupCandidates).toHaveBeenCalledTimes(1);

    await act(async () => resolveCandidates(candidates));

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.querySelector('[role="status"]')?.textContent).toBe('智能打标');
    expect(host.querySelector('[aria-label="智能打标候选"]')?.textContent).toContain('2026');
  });

  it('keeps only pronunciation candidates and never suggests pauses or sound events', async () => {
    const onRequestSpeechMarkupCandidates = vi.fn().mockResolvedValue([
      { id: 'pause', mark: { type: 'break', at: 2, durationMs: 300 }, sourceText: '' },
      { id: 'sound', mark: { type: 'soundEvent', at: 2, src: 'test' }, sourceText: '' },
      {
        id: 'pronunciation',
        mark: { type: 'sub', from: 2, to: 6, alias: '二零二六' },
        sourceText: '2026',
      },
    ]);
    await render(
      { markdown: '今天2026年发布' },
      {
        allowedSpeechMarkTypes: ['break', 'soundEvent', 'sub'],
        onRequestSpeechMarkupCandidates,
      },
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.click(),
    );

    const candidates = host.querySelector('[aria-label="智能打标候选"]');
    expect(candidates?.querySelectorAll('li')).toHaveLength(1);
    expect(candidates?.textContent).toContain('2026');
    expect(candidates?.textContent).not.toContain('<break');
    expect(candidates?.textContent).not.toContain('<soundEvent');
  });

  it('announces when no pronunciation changes are needed', async () => {
    const onRequestSpeechMarkupCandidates = vi.fn().mockResolvedValue([]);
    await render({ markdown: '今天发布' }, { onRequestSpeechMarkupCandidates });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.click(),
    );

    expect(host.querySelector('[aria-label="智能打标候选"]')).toBeNull();
    expect(
      Array.from(host.querySelectorAll('[role="status"]')).some((status) =>
        status.textContent?.includes('没有需要调整的读音标注。'),
      ),
    ).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.disabled).toBe(false);
  });

  it('explains unsupported pronunciation capability returned by the server', async () => {
    const onRequestSpeechMarkupCandidates = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('unsupported voice'), { code: 'SPEECH_VOICE_UNSUPPORTED' }),
      );
    await render({ markdown: '今天发布' }, { onRequestSpeechMarkupCandidates });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.click(),
    );

    expect(host.textContent).toContain('当前音色不支持智能读音标注，可手动添加停顿。');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.disabled).toBe(false);
  });

  it('disables smart tagging for a pause-only voice while keeping manual pauses usable', async () => {
    const onRequestSpeechMarkupCandidates = vi.fn();
    await render(
      { markdown: '今天发布' },
      { allowedSpeechMarkTypes: ['break'], onRequestSpeechMarkupCandidates },
    );
    const button = host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('当前音色不支持智能读音标注，可手动添加停顿。');
    act(() => button.click());
    expect(onRequestSpeechMarkupCandidates).not.toHaveBeenCalled();

    await selectText('');
    enableSpeechTags();
    const pauseButton = host.querySelector<HTMLButtonElement>('[aria-label="停顿"]')!;
    expect(pauseButton.disabled).toBe(false);
    act(() => pauseButton.click());
    expect(speechDialog()?.querySelector('[aria-label="停顿毫秒数"]')).not.toBeNull();
  });

  it('applies an exact-source smart candidate and previews only the current selection', async () => {
    const onRequestSpeechMarkupCandidates = vi.fn().mockResolvedValue([
      {
        id: 'candidate-1',
        mark: { type: 'say-as', from: 2, to: 6, interpretAs: 'Cardinal' },
        sourceText: '2026',
      },
    ]);
    const onPreviewSpeech = vi.fn().mockResolvedValue({
      contentType: 'audio/mpeg',
      dataBase64: 'SUQz',
    });
    await render(
      { markdown: '今天2026年发布' },
      { onPreviewSpeech, onRequestSpeechMarkupCandidates },
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.click();
      await Promise.resolve();
    });
    expect(host.querySelector('[aria-label="智能打标候选"]')?.textContent).toContain('2026');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="采用候选"]')?.click());

    await selectText('2026');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click();
      await Promise.resolve();
    });
    expect(onPreviewSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ markdownFrom: 2, markdownTo: 6 }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(previewPopover()?.querySelector<HTMLAudioElement>('audio')?.src).toContain(
      'data:audio/mpeg;base64,SUQz',
    );
  });

  it('requires an explicit selection and explains why preview is unavailable', async () => {
    const onPreviewSpeech = vi.fn().mockResolvedValue({
      contentType: 'audio/mpeg',
      dataBase64: 'SUQz',
    });
    await render({ markdown: '今天2026年发布' }, { onPreviewSpeech });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click();
      await Promise.resolve();
    });

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="试听"]')!;
    expect(onPreviewSpeech).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent).toBe(
      '请先在讲稿中选择要试听的文字。',
    );
    expect(previewPopover()).toBeNull();

    await selectText('今天2026年发布');
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    expect(onPreviewSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: '今天2026年发布', markdownFrom: 0, markdownTo: 9 }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(previewPopover()?.querySelector<HTMLAudioElement>('audio')?.src).toContain(
      'data:audio/mpeg;base64,SUQz',
    );
  });

  it('previews the entire draft in document mode even when a shorter passage is selected', async () => {
    const onPreviewSpeech = vi
      .fn()
      .mockResolvedValue({ contentType: 'audio/mpeg', dataBase64: 'SUQz' });
    await render({ markdown: '今天2026年发布' }, { onPreviewSpeech, previewScope: 'document' });
    await selectText('2026');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click());
    expect(onPreviewSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: '今天2026年发布', markdownFrom: 0, markdownTo: 9 }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it('renders named comparison tracks while retaining the single-preview contract', async () => {
    const onPreviewSpeech = vi.fn().mockResolvedValue({
      tracks: [
        { id: 'default', label: '默认音色', contentType: 'audio/mpeg', dataBase64: 'SUQz' },
        { id: 'clone', label: '克隆音色', contentType: 'audio/mpeg', dataBase64: 'VEFH' },
      ],
    });
    await render({ markdown: '同一段讲稿' }, { onPreviewSpeech });
    await selectText('同一段讲稿');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click();
      await Promise.resolve();
    });

    const audio = previewPopover()!.querySelectorAll<HTMLAudioElement>('audio');
    expect(audio).toHaveLength(2);
    expect(previewPopover()?.textContent).toContain('默认音色');
    expect(previewPopover()?.textContent).toContain('克隆音色');
    expect(audio[0]?.getAttribute('aria-label')).toBe('默认音色');
    expect(audio[0]?.src).toContain('data:audio/mpeg;base64,SUQz');
    expect(audio[1]?.getAttribute('aria-label')).toBe('克隆音色');
    expect(audio[1]?.src).toContain('data:audio/mpeg;base64,VEFH');
  });

  it('blocks long selections before submitting a preview', async () => {
    const markdown = '讲'.repeat(81);
    const onPreviewSpeech = vi.fn();
    await render({ markdown }, { onPreviewSpeech });
    await selectText(markdown);

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="试听"]')!;
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent,
    ).toContain('选中的文字太长');
    await act(async () => trigger.click());
    expect(onPreviewSpeech).not.toHaveBeenCalled();
  });

  it('explains selections that cut through an atomic speech mark', async () => {
    const onPreviewSpeech = vi.fn();
    await render(
      {
        markdown: '今天2026年发布',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'say-as', from: 2, to: 6, interpretAs: 'Cardinal' }],
        },
      },
      { onPreviewSpeech },
    );
    await selectText('202');
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="试听"]')!;
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(trigger.getAttribute('aria-describedby')!)?.textContent,
    ).toContain('完整且可朗读');
    await act(async () => trigger.click());
    expect(onPreviewSpeech).not.toHaveBeenCalled();
  });

  it('closes a pending preview before synchronous and late cancellation callbacks', async () => {
    const pending = deferred<{ contentType: string; dataBase64: string }>();
    let progress: ((status: 'queued' | 'cancelling' | 'draining') => void) | undefined;
    let signal: AbortSignal | undefined;
    const onPreviewSpeech = vi.fn(
      (_: unknown, requestSignal: AbortSignal, update?: typeof progress) => {
        signal = requestSignal;
        progress = update;
        requestSignal.addEventListener('abort', () => update?.('cancelling'));
        update?.('queued');
        return pending.promise;
      },
    );
    await render({ markdown: '今天发布' }, { onPreviewSpeech });
    await selectText('今天发布');
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="试听"]')!;
    await act(async () => trigger.click());
    expect(previewPopover()?.textContent).toContain('试听排队中');

    await act(async () =>
      previewPopover()?.querySelector<HTMLButtonElement>('[aria-label="关闭试听"]')?.click(),
    );
    expect(signal?.aborted).toBe(true);
    expect(previewPopover()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      progress?.('draining');
      pending.resolve({ contentType: 'audio/mpeg', dataBase64: 'SUQz' });
      await pending.promise;
    });
    expect(previewPopover()).toBeNull();
  });

  it('stops a preview while retaining the cancellation outcome until close', async () => {
    const pending = deferred<{ contentType: string; dataBase64: string }>();
    const onPreviewSpeech = vi.fn(
      (_: unknown, signal: AbortSignal, update?: (status: 'queued' | 'draining') => void) => {
        update?.('queued');
        signal.addEventListener('abort', () => update?.('draining'));
        return pending.promise;
      },
    );
    await render({ markdown: '今天发布' }, { onPreviewSpeech });
    await selectText('今天发布');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="停止试听"]')?.click(),
    );
    expect(previewPopover()?.textContent).toContain('语音服务可能仍在生成');
    expect(previewPopover()).not.toBeNull();
    await act(async () => {
      pending.resolve({ contentType: 'audio/mpeg', dataBase64: 'SUQz' });
      await pending.promise;
    });
    expect(previewPopover()?.querySelector('audio')).toBeNull();
    expect(previewPopover()?.textContent).toContain('语音服务可能仍在生成');
  });

  it('pauses and unmounts every custom comparison track on close', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const onPreviewSpeech = vi.fn().mockResolvedValue({
      tracks: [
        { id: 'first', label: '音色一', contentType: 'audio/mpeg', dataBase64: 'SUQz' },
        { id: 'second', label: '音色二', contentType: 'audio/mpeg', dataBase64: 'VEFH' },
      ],
    });
    await render(
      { markdown: '今天发布' },
      {
        onPreviewSpeech,
        renderPreviewTrack: (track) => (
          <audio
            aria-label={track.label}
            controls
            src={`data:${track.contentType};base64,${track.dataBase64}`}
          />
        ),
      },
    );
    await selectText('今天发布');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click();
      await Promise.resolve();
    });
    expect(previewPopover()?.querySelectorAll('audio')).toHaveLength(2);
    await act(async () =>
      previewPopover()?.querySelector<HTMLButtonElement>('[aria-label="关闭试听"]')?.click(),
    );
    expect(pause).toHaveBeenCalledTimes(2);
    expect(previewPopover()).toBeNull();
  });

  it('closes the preview with Escape and restores trigger focus', async () => {
    const onPreviewSpeech = vi.fn().mockResolvedValue({
      contentType: 'audio/mpeg',
      dataBase64: 'SUQz',
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    await render({ markdown: '今天发布' }, { onPreviewSpeech });
    await selectText('今天发布');
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="试听"]')!;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    expect(previewPopover()).not.toBeNull();
    const editor = host.querySelector<HTMLElement>('.ProseMirror')!;
    editor.focus();
    await act(async () =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
    );
    expect(previewPopover()).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    trigger.focus();
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
    );
    expect(previewPopover()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps independent smart candidates and drops conflicting or stale ones after acceptance', async () => {
    const onSaveAndGenerate = vi.fn();
    const onRequestSpeechMarkupCandidates = vi.fn().mockResolvedValue([
      {
        id: 'candidate-a',
        mark: { type: 'say-as', from: 1, to: 5, interpretAs: 'Cardinal' },
        sourceText: '2026',
      },
      {
        id: 'candidate-b',
        mark: { type: 'sub', from: 6, to: 10, alias: '二零二七' },
        sourceText: '2027',
      },
      {
        id: 'candidate-conflict',
        mark: { type: 'phoneme', from: 3, to: 5, alphabet: 'py', ph: 'er ling' },
        sourceText: '26',
      },
      {
        id: 'candidate-stale',
        mark: { type: 'say-as', from: 0, to: 1, interpretAs: 'Spell' },
        sourceText: '错',
      },
    ]);
    await render(
      { markdown: '甲2026乙2027丙' },
      { onRequestSpeechMarkupCandidates, onSaveAndGenerate },
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.click();
      await Promise.resolve();
    });

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="采用候选"]')?.click());
    expect(host.querySelector('[aria-label="智能打标候选"]')?.textContent).toContain('2027');
    expect(host.querySelector('[aria-label="智能打标候选"]')?.textContent).not.toContain('26');
    expect(host.querySelector('[aria-label="智能打标候选"]')?.textContent).not.toContain('错');

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="采用候选"]')?.click());
    expect(host.querySelector('[aria-label="智能打标候选"]')).toBeNull();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click();
      await Promise.resolve();
    });

    expect(onSaveAndGenerate).toHaveBeenCalledWith({
      markdown: '甲2026乙2027丙',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [
          { type: 'say-as', from: 1, to: 5, interpretAs: 'Cardinal' },
          { type: 'sub', from: 6, to: 10, alias: '二零二七' },
        ],
      },
    });
  });

  it('blocks candidate mutations while saving or when the host locks narration editing', async () => {
    const save = deferred<void>();
    const onSaveAndGenerate = vi.fn(() => save.promise);
    const onRequestSpeechMarkupCandidates = vi.fn().mockResolvedValue([
      {
        id: 'candidate-1',
        mark: { type: 'say-as', from: 2, to: 6, interpretAs: 'Cardinal' as const },
        sourceText: '2026',
      },
    ]);
    await render(
      { markdown: '今天2026年发布' },
      { onRequestSpeechMarkupCandidates, onSaveAndGenerate },
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.click();
      await Promise.resolve();
    });

    act(() =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.click(),
    );
    await act(async () => Promise.resolve());

    const accept = host.querySelector<HTMLButtonElement>('[aria-label="采用候选"]');
    const reject = host.querySelector<HTMLButtonElement>('[aria-label="忽略候选"]');
    expect(accept?.disabled).toBe(true);
    expect(reject?.disabled).toBe(true);
    act(() => {
      accept?.click();
      reject?.click();
    });
    expect(host.querySelector('[aria-label="智能打标候选"]')).not.toBeNull();
    expect(onSaveAndGenerate).toHaveBeenCalledWith({ markdown: '今天2026年发布' });

    await act(async () => {
      save.resolve(undefined);
      await save.promise;
    });
    await render(
      { markdown: '今天2026年发布' },
      { disabled: true, onRequestSpeechMarkupCandidates, onSaveAndGenerate },
    );
    expect(host.querySelector<HTMLButtonElement>('[aria-label="采用候选"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="忽略候选"]')?.disabled).toBe(true);
  });

  it('removes a speech span when its marked source text changes', async () => {
    await render({
      markdown: '今天2026年发布',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'say-as', from: 2, to: 6, interpretAs: 'Cardinal' }],
      },
    });

    const { node } = findText('2026');
    await act(async () => {
      node.data = '2036';
      host
        .querySelector<HTMLElement>('.ProseMirror')
        ?.dispatchEvent(
          new InputEvent('input', { bubbles: true, data: '3', inputType: 'insertText' }),
        );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('正文修改影响了 1 个语音标记，已移除受影响标记。');
    expect(host.querySelector('[data-reach-deck-speech-mark]')).toBeNull();
  });

  it('aborts and drops smart-mark results after the narration changes', async () => {
    const pending = deferred<
      readonly {
        id: string;
        mark: { type: 'say-as'; from: number; to: number; interpretAs: 'Cardinal' };
        sourceText: string;
      }[]
    >();
    let signal: AbortSignal | undefined;
    const onRequestSpeechMarkupCandidates = vi.fn((_: unknown, requestSignal: AbortSignal) => {
      signal = requestSignal;
      return pending.promise;
    });
    await render({ markdown: '今天2026年发布' }, { onRequestSpeechMarkupCandidates });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.click();
      await Promise.resolve();
    });
    await replaceEditorText('2026', '2036');
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      pending.resolve([
        {
          id: 'candidate-1',
          mark: { type: 'say-as', from: 2, to: 6, interpretAs: 'Cardinal' },
          sourceText: '2026',
        },
      ]);
      await pending.promise;
    });

    expect(host.querySelector('[aria-label="智能打标候选"]')).toBeNull();
  });

  it('shows queue progress and ignores late progress after the narration changes', async () => {
    const pending = deferred<{ contentType: string; dataBase64: string }>();
    let update: ((status: 'queued' | 'running') => void) | undefined;
    const onPreviewSpeech = vi.fn(
      (_: unknown, _signal: AbortSignal, onProgress?: typeof update) => {
        update = onProgress;
        onProgress?.('queued');
        return pending.promise;
      },
    );
    await render({ markdown: '今天2026年发布' }, { onPreviewSpeech });
    await selectText('2026');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click();
    });
    expect(previewPopover()?.textContent).toContain('试听排队中');
    await act(async () => update?.('running'));
    expect(previewPopover()?.textContent).toContain('正在生成试听');
    await replaceEditorText('2026', '2036');
    await act(async () => {
      update?.('queued');
      pending.resolve({ contentType: 'audio/mpeg', dataBase64: 'SUQz' });
      await pending.promise;
    });
    expect(host.textContent).not.toContain('试听排队中');
    expect(previewPopover()).toBeNull();
  });

  it('aborts and drops preview audio after the narration changes', async () => {
    const pending = deferred<{ contentType: string; dataBase64: string }>();
    let signal: AbortSignal | undefined;
    const onPreviewSpeech = vi.fn((_: unknown, requestSignal: AbortSignal) => {
      signal = requestSignal;
      return pending.promise;
    });
    await render({ markdown: '今天2026年发布' }, { onPreviewSpeech });
    await selectText('2026');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click();
      await Promise.resolve();
    });
    await replaceEditorText('2026', '2036');
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      pending.resolve({ contentType: 'audio/mpeg', dataBase64: 'SUQz' });
      await pending.promise;
    });

    expect(host.querySelector('audio')).toBeNull();
  });

  it('does not carry late cancellation status to a different page with identical narration', async () => {
    const pending = deferred<{ contentType: string; dataBase64: string }>();
    let progress: ((status: 'queued' | 'draining') => void) | undefined;
    const onPreviewSpeech = (_: unknown, _signal: AbortSignal, update?: typeof progress) => {
      progress = update;
      update?.('queued');
      return pending.promise;
    };
    const narration = { markdown: '今天发布' };
    await render(narration, { onPreviewSpeech });
    await selectText('今天发布');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click());
    expect(previewPopover()?.textContent).toContain('试听排队中');
    await act(async () => {
      root.render(
        <NarrationEditor
          slide={{ ...slide(narration), id: 'slide-2' }}
          onPreviewSpeech={onPreviewSpeech}
        />,
      );
    });
    await act(async () => {
      progress?.('draining');
      pending.resolve({ contentType: 'audio/mpeg', dataBase64: 'SUQz' });
      await pending.promise;
    });
    expect(host.textContent).not.toContain('语音服务可能仍在生成');
    expect(previewPopover()).toBeNull();
  });

  it.each([
    [
      'SPEECH_VOICE_UNSUPPORTED',
      '当前课程音色不支持语音标记。请改用已启用的中文 Seed-TTS 2.0 音色，或移除语音标记。',
    ],
    ['SPEECH_TOOL_REQUEST_ACTIVE', '此页面已有语音请求正在运行，请等待完成或先停止试听。'],
    ['SPEECH_TOOL_RATE_LIMITED', '语音请求过于频繁，请稍后再试。'],
    ['SPEECH_TOOL_ADMISSION_UNAVAILABLE', '语音服务暂时不可用，请稍后再试。'],
    ['SPEECH_TOOL_STALE_REQUEST', '语音工具运行期间页面已更新，请重试。'],
    ['SPEECH_PREVIEW_TIMEOUT', '试听等待超时，请稍后重试。'],
    ['SPEECH_TOOL_INVALID_REQUEST', '选区无法试听，请缩短并选择可朗读的完整短文本。'],
  ])('shows actionable preview recovery for safe error code %s', async (code, message) => {
    const onPreviewSpeech = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('speech tool failure'), { code }));
    await render({ markdown: '今天2026年发布' }, { onPreviewSpeech });
    await selectText('2026');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click();
      await Promise.resolve();
    });

    expect(previewPopover()?.textContent).toContain(message);
  });

  it.each([
    [12, '语音请求过于频繁，请在 12 秒后重试。'],
    [undefined, '语音请求过于频繁，请稍后再试。'],
    [0, '语音请求过于频繁，请稍后再试。'],
    [1.5, '语音请求过于频繁，请稍后再试。'],
  ])('shows a safe rate-limit retry delay for %s', async (retryAfterSeconds, message) => {
    const onPreviewSpeech = vi.fn().mockRejectedValue(
      Object.assign(new Error('rate limited'), {
        code: 'SPEECH_TOOL_RATE_LIMITED',
        retryAfterSeconds,
      }),
    );
    await render({ markdown: '今天2026年发布' }, { onPreviewSpeech });
    await selectText('2026');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click();
      await Promise.resolve();
    });

    expect(previewPopover()?.textContent).toContain(message);
  });

  it('limits a pause-only voice to break and blocks existing incompatible marks until removal', async () => {
    const onRequestSpeechMarkupCandidates = vi.fn().mockResolvedValue([]);
    const onPreviewSpeech = vi.fn();
    const onSaveAndGenerate = vi.fn();
    await render(
      {
        markdown: '今天2026年发布',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'sub', from: 2, to: 6, alias: '二零二六' }],
        },
      },
      {
        allowedSpeechMarkTypes: ['break'],
        onPreviewSpeech,
        onRequestSpeechMarkupCandidates,
        onSaveAndGenerate,
      },
    );

    enableSpeechTags();
    expect(host.querySelector('[aria-label="停顿"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="替换读法"]')).toBeNull();
    expect(host.querySelector('[aria-label="指定读法"]')).toBeNull();
    expect(host.querySelector('[aria-label="发音"]')).toBeNull();
    expect(host.textContent).toContain('当前课程音色不支持现有的 1 个语音标记。');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.disabled).toBe(true);
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.disabled,
    ).toBe(true);

    await selectText('2026');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="移除标签"]')?.disabled).toBe(false);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="移除标签"]')?.click());

    expect(host.textContent).not.toContain('当前课程音色不支持现有的 1 个语音标记。');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.disabled).toBe(true);
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')?.disabled,
    ).toBe(false);
  });

  it.each(['html', 'text'])(
    'copies five speech marks across editors through %s only',
    async (transport) => {
      const original = {
        markdown: 'A汉字B123ChelloD',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1' as const,
          marks: [
            { type: 'break' as const, at: 1, durationMs: 300 },
            { type: 'phoneme' as const, from: 1, to: 3, alphabet: 'py' as const, ph: 'han4 zi4' },
            { type: 'sub' as const, from: 4, to: 7, alias: '一二三' },
            { type: 'say-as' as const, from: 8, to: 13, interpretAs: 'Spell' as const },
            { type: 'soundEvent' as const, at: 14, src: 'https://example.com/a?b="<&c=1' },
          ],
        },
      };
      await render(original);
      await selectWholeNarration();
      const copied = copyNarration();
      expect(copied['text/plain']).toContain('<phoneme alphabet="py" ph="han4 zi4">汉字</phoneme>');
      expect(copied['text/plain']).toContain('&quot;&lt;&amp;');
      expect(copied['text/plain']).not.toContain('Ⅱ');
      expect(copied['text/html']).toContain('data-reach-narration-fragment');
      const onSaveDraft = vi.fn();
      await render(
        { markdown: '前后' },
        {
          onSaveDraft,
          allowedSpeechMarkTypes: ['break', 'soundEvent', 'sub', 'say-as', 'phoneme'],
        },
      );
      await placeCaret('前后', 1);
      await pasteNarration(
        transport === 'text' ? copied['text/plain']! : '',
        transport === 'html' ? copied['text/html']! : '',
      );
      expect(host.querySelectorAll('[data-reach-deck-speech-mark]')).toHaveLength(3);
      expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(2);
      expect(host.querySelector('.ProseMirror')?.textContent).toBe('前A汉字B123ChelloD后');
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')?.click());
      expect(host.querySelector('.ProseMirror')?.textContent).toBe('前后');
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="重做"]')?.click());
      act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
      );
      expect(onSaveDraft).toHaveBeenCalledTimes(1);
      const saved = onSaveDraft.mock.calls[0]![0];
      expect(saved.speechMarkup.marks).toHaveLength(5);
      await render(saved);
      expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(2);
    },
  );

  it('drops a partially copied pronunciation span and keeps fully selected spans', async () => {
    await render({
      markdown: '汉字',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'phoneme', from: 0, to: 2, alphabet: 'py', ph: 'han4 zi4' }],
      },
    });
    await selectText('汉');
    expect(copyNarration()['text/plain']).toBe('汉');
    await selectText('汉字');
    expect(copyNarration()['text/plain']).toContain('<phoneme');
  });

  it('copies and cuts a point-only selection, preserving it through HTML paste', async () => {
    await render({
      markdown: '甲乙',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 1, durationMs: 321 }],
      },
    });
    const point = host.querySelector('[data-reach-deck-speech-break]')!;
    await act(async () => {
      host.querySelector<HTMLElement>('.ProseMirror')?.focus();
      const range = document.createRange();
      range.selectNode(point);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const copied = copyNarration('cut');
    expect(copied['text/plain']).toBe('<break time="321ms"/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(0);
    await placeCaret('甲乙', 1);
    await pasteNarration('', copied['text/html']);
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
  });

  it('keeps disallowed and malformed speech input literal with a notice', async () => {
    await render({ markdown: '甲乙' }, { allowedSpeechMarkTypes: ['break'] });
    await placeCaret('甲乙', 1);
    await pasteNarration('<sub alias="hi">hello</sub><soundEvent src="javascript:alert(1)"/>');
    expect(host.querySelectorAll('[data-reach-deck-speech-mark]')).toHaveLength(0);
    expect(host.querySelector('.ProseMirror')?.textContent).toContain(
      '<sub alias="hi">hello</sub>',
    );
    expect(host.textContent).toContain('部分语音标记未转换');
  });

  it.each(['html', 'text'])(
    'preserves inline formulas and Unicode offsets through repeated %s pastes',
    async (transport) => {
      const onSaveDraft = vi.fn();
      await render({
        markdown: '😀\\(x+y\\)汉字',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'phoneme', from: 9, to: 11, alphabet: 'py', ph: 'han4 zi4' }],
        },
      });
      await selectWholeNarration();
      const copied = copyNarration();
      await render({ markdown: '前后' }, { onSaveDraft });
      expect(copied['text/plain']).toContain('<phoneme');
      await placeCaret('前后', 1);
      await pasteNarration(
        transport === 'text' ? copied['text/plain']! : '',
        transport === 'html' ? copied['text/html'] : '',
      );
      expect(host.querySelectorAll('[data-reach-deck-speech-mark]')).toHaveLength(1);
      await placeCaret('后', 0);
      await pasteNarration(
        transport === 'text' ? copied['text/plain']! : '',
        transport === 'html' ? copied['text/html'] : '',
      );
      expect(host.querySelectorAll('[data-reach-deck-speech-mark]')).toHaveLength(2);
      act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
      );
      expect(onSaveDraft).toHaveBeenCalledTimes(1);
      expect(onSaveDraft.mock.calls[0]![0]).toEqual({
        markdown: '前😀\\(x+y\\)汉字😀\\(x+y\\)汉字后',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [
            { type: 'phoneme', from: 10, to: 12, alphabet: 'py', ph: 'han4 zi4' },
            { type: 'phoneme', from: 21, to: 23, alphabet: 'py', ph: 'han4 zi4' },
          ],
        },
      });
    },
  );

  it.each([
    '<sub alias="outer"><phoneme alphabet="py" ph="han4">汉</phoneme></sub>',
    '<emphasis><break time="300ms"/></emphasis>',
    '<soundEvent src="https://user:pass@example.com/a"/>',
    '<soundEvent src="data:text/html,hello"/>',
    '<say-as interpret-as="UNKNOWN">123</say-as>',
    '<phoneme alphabet="py" ph="han4">English</phoneme>',
  ])('keeps invalid or nested external SSML literal: %s', async (input) => {
    await render(
      { markdown: '甲乙' },
      { allowedSpeechMarkTypes: ['break', 'sub', 'soundEvent', 'say-as', 'phoneme'] },
    );
    await placeCaret('甲乙', 1);
    await pasteNarration(input);
    expect(
      host.querySelectorAll('[data-reach-deck-speech-mark], [data-reach-deck-speech-break]'),
    ).toHaveLength(0);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲' + input + '乙');
    expect(host.textContent).toContain('部分语音标记未转换');
  });

  it.each(['extra-field', 'unsafe-url', 'unknown-type', 'over-budget'])(
    'rejects hostile portable metadata: %s',
    async (kind) => {
      await render({
        markdown: '甲乙',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 200 }],
        },
      });
      await selectWholeNarration();
      const copied = copyNarration();
      const holder = document.createElement('div');
      holder.innerHTML = copied['text/html']!;
      const carrier = holder.firstElementChild!;
      const payload = JSON.parse(carrier.getAttribute('data-reach-narration-fragment')!);
      const point = payload.doc.content[0].content.find(
        (node: { type: string }) => node.type === 'reachDeckSpeechBreak',
      );
      if (kind === 'extra-field') point.attrs.definition.extra = 'bad';
      if (kind === 'unsafe-url') {
        point.type = 'reachDeckSpeechSoundEvent';
        point.attrs.definition = { id: 'foreign', type: 'soundEvent', src: 'javascript:alert(1)' };
      }
      if (kind === 'unknown-type') point.attrs.definition.type = 'prosody';
      if (kind === 'over-budget') payload.doc.content[0].content[0].text = 'x'.repeat(100_001);
      carrier.setAttribute('data-reach-narration-fragment', JSON.stringify(payload));
      await render({ markdown: '前后' });
      await placeCaret('前后', 1);
      await pasteNarration('safe fallback', holder.innerHTML);
      expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(0);
      expect(host.textContent).toContain('部分语音标记未转换');
    },
  );

  it.each(['html', 'text'])(
    'preserves paragraph breaks and block formulas through %s transport',
    async (transport) => {
      const onSaveDraft = vi.fn();
      await render({ markdown: '第一段\n换行\n\n\\[x+y\\]\n\n第二段' });
      await selectWholeNarration();
      const copied = copyNarration();
      await render({ markdown: '替换' }, { onSaveDraft });
      await selectWholeNarration();
      await pasteNarration(
        transport === 'text' ? copied['text/plain']! : '',
        transport === 'html' ? copied['text/html'] : '',
      );
      act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
      );
      expect(onSaveDraft).toHaveBeenCalledWith({ markdown: '第一段\n换行\n\n\\[x+y\\]\n\n第二段' });
    },
  );

  it('imports a plain speak wrapper without changing document settings', async () => {
    const onSaveDraft = vi.fn();
    await render({ markdown: '甲乙' }, { onSaveDraft });
    await placeCaret('甲乙', 1);
    await pasteNarration('<speak><sub alias="二">2</sub><break time="0.3s"/></speak>');
    expect(host.querySelectorAll('[data-reach-deck-speech-mark]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
    );
    expect(onSaveDraft.mock.calls[0]![0].speechMarkup.speak).toBeUndefined();
  });

  it('does not include adjacent point marks in text-only selections', async () => {
    await render({
      markdown: '甲乙',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 1, durationMs: 200 }],
      },
    });
    await selectText('甲');
    expect(copyNarration()['text/plain']).toBe('甲');
    await selectText('乙');
    expect(copyNarration()['text/plain']).toBe('乙');
  });

  it.each(['copy', 'cut'])(
    'falls back to plain text on %s when rich clipboard writing fails',
    async (type) => {
      await render({ markdown: '甲乙' });
      await selectWholeNarration();
      const values: Record<string, string> = {};
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          setData: (kind: string, value: string) => {
            if (kind === 'text/html' && value !== '') throw new Error('HTML clipboard unavailable');
            values[kind] = value;
          },
        },
      });
      act(() => host.querySelector('.ProseMirror')?.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(values['text/plain']).toBe('甲乙');
      expect(host.querySelector('.ProseMirror')?.textContent).toBe(type === 'cut' ? '' : '甲乙');
      expect(host.textContent).not.toContain('部分语音标记未转换');
    },
  );

  it('does not delete a cut selection when every clipboard write fails', async () => {
    await render({ markdown: '甲乙' });
    await selectWholeNarration();
    const event = new Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: () => {
          throw new Error('No clipboard');
        },
      },
    });
    act(() => host.querySelector('.ProseMirror')?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
    expect(host.textContent).not.toContain('部分语音标记未转换');
  });

  it('accepts expanded HTML carriers while retaining the strict decoded payload budget', async () => {
    await render({
      markdown: '甲乙',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 1, durationMs: 200 }],
      },
    });
    await selectWholeNarration();
    const copied = copyNarration();
    // Cross-browser rich HTML can contain ordinary presentation markup around the carrier.
    const expanded =
      '<div title="' + '&quot;'.repeat(20_000) + '">' + copied['text/html'] + '</div>';
    expect(expanded.length).toBeGreaterThan(100_000);
    await render({ markdown: '前后' });
    await placeCaret('前后', 1);
    await pasteNarration('', expanded);
    expect(host.querySelectorAll('[data-reach-deck-speech-break]')).toHaveLength(1);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('前甲乙后');
  });

  it('pastes styled webpage text without presentation marks and keeps one undo step', async () => {
    const onSaveDraft = vi.fn();
    await render({ markdown: '甲乙' }, { onSaveDraft });
    await placeCaret('甲乙', 1);
    await replaceEditorText('甲乙', '甲前乙');
    await placeCaret('甲前乙', 2);
    await pasteNarration(
      '网页文字',
      '<p style="text-align:center;margin-top:12px"><span style="color:red;font-size:24px">网页<strong>文字</strong></span></p>',
    );
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲前网页文字乙');
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
    );
    expect(onSaveDraft).toHaveBeenCalledWith({ markdown: '甲前网页文字乙' });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')?.click());
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲前乙');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')?.click());
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
  });

  it('pastes HTML-only Markdown lists as narration paragraphs', async () => {
    const onSaveDraft = vi.fn();
    await render({ markdown: '替换' }, { onSaveDraft });
    await selectWholeNarration();
    await pasteNarration(
      '',
      '<h2>标题</h2><ul><li><p><strong>第一项</strong></p></li><li><p><em>第二项</em></p></li></ul>',
    );
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
    );
    expect(onSaveDraft).toHaveBeenCalledWith({ markdown: '标题\n\n第一项\n\n第二项' });
  });

  it.each([
    ['empty', '<p></p>'],
    ['image-only', '<img src="https://example.com/untrusted.png">'],
    ['oversized', '<p title="' + 'x'.repeat(1_000_001) + '">ignored</p>'],
    ['too-many-nodes', '<p>' + '<strong>x</strong><em>y</em>'.repeat(5_001) + '</p>'],
    ['narration-capacity', '<p>' + '字'.repeat(2_001) + '</p>'],
  ])('falls back to bounded plain text for %s HTML', async (_kind, html) => {
    await render({ markdown: '甲乙' });
    await placeCaret('甲乙', 1);
    await pasteNarration('安全文字', html);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲安全文字乙');
    expect(host.querySelector('.ProseMirror img')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="撤销"]')?.click());
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
  });

  it('keeps formulas and existing speech marks when importing styled MathML', async () => {
    const onSaveDraft = vi.fn();
    await render(
      {
        markdown: '甲乙',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 300 }],
        },
      },
      { onSaveDraft },
    );
    await placeCaret('乙', 1);
    await pasteNarration(
      'x+1',
      '<p><strong>公式</strong><math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></math></p>',
    );
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
    );
    const saved = onSaveDraft.mock.calls[0]![0];
    expect(saved.markdown).toContain('公式\\(x+1\\)');
    expect(saved.speechMarkup.marks).toEqual([{ type: 'break', at: 1, durationMs: 300 }]);
  });

  it('leaves the selection intact when both HTML and plain fallback exceed paste budgets', async () => {
    await render({ markdown: '甲乙' });
    await selectWholeNarration();
    await pasteNarration('x'.repeat(250_001), '<p title="' + 'x'.repeat(1_000_001) + '"></p>');
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲乙');
  });

  it('does not trust private formula markup in external narration HTML', async () => {
    const onSaveDraft = vi.fn();
    await render({ markdown: '替换' }, { onSaveDraft });
    await selectWholeNarration();
    await pasteNarration(
      'safe',
      '<p data-pm-slice="1 1 []"><strong>文字</strong><span data-type="inline-math" data-latex="secret">可见内容</span><img src="javascript:alert(1)"><script>alert(1)</script></p>',
    );
    act(() => host.querySelector<HTMLElement>('[aria-label="保存选项"]')?.click());
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="仅保存草稿"]')?.click(),
    );
    expect(onSaveDraft).toHaveBeenCalledWith({ markdown: '文字可见内容' });
    expect(host.querySelector('.ProseMirror img, .ProseMirror script')).toBeNull();
  });

  it('keeps a bounded flood of unmatched tags literal without converting nested pauses', async () => {
    await render({ markdown: '甲乙' });
    await placeCaret('甲乙', 1);
    const input = '<sub alias="x">'.repeat(1_000) + '<break time="300ms"/>';
    await pasteNarration(input);
    expect(
      host.querySelectorAll('[data-reach-deck-speech-mark], [data-reach-deck-speech-break]'),
    ).toHaveLength(0);
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('甲' + input + '乙');
    expect(host.textContent).toContain('部分语音标记未转换');
  });

  async function selectWholeNarration() {
    await act(async () => {
      const surface = host.querySelector<HTMLElement>('.ProseMirror')!;
      surface.focus();
      const range = document.createRange();
      range.selectNodeContents(surface);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function copyNarration(type = 'copy') {
    const values: Record<string, string> = {};
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (type: string, value: string) => {
          values[type] = value;
        },
      },
    });
    act(() => host.querySelector('.ProseMirror')?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    return values;
  }

  async function render(
    narration: ReachDeckNativeSlideV2['narration'],
    props: Partial<NarrationEditorSlideProps> = {},
  ) {
    await act(async () => {
      root.render(<NarrationEditor {...props} slide={slide(narration)} />);
      await Promise.resolve();
    });
  }

  async function selectText(value: string) {
    const surface = host.querySelector<HTMLElement>('.ProseMirror');
    const { node: textNode, offset } = findText(value);
    await act(async () => {
      surface?.focus();
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + value.length);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      surface?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function placeCaret(value: string, offset: number) {
    const surface = host.querySelector<HTMLElement>('.ProseMirror');
    const { node } = findText(value);
    await act(async () => {
      surface?.focus();
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      surface?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function pasteNarration(plainText: string, html = '') {
    const clipboardData = {
      files: [],
      getData: (type: string) =>
        type === 'text/plain' ? plainText : type === 'text/html' ? html : '',
      items: [],
      types: html ? ['text/html', 'text/plain'] : ['text/plain'],
    } as unknown as DataTransfer;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
    await act(async () => {
      host.querySelector<HTMLElement>('.ProseMirror')?.dispatchEvent(event);
      await Promise.resolve();
    });
  }

  async function replaceEditorText(current: string, next: string) {
    const { node } = findText(current);
    await act(async () => {
      node.data = node.data.replace(current, next);
      host
        .querySelector<HTMLElement>('.ProseMirror')
        ?.dispatchEvent(
          new InputEvent('input', { bubbles: true, data: next, inputType: 'insertText' }),
        );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function enableSpeechTags() {
    const toggle = host.querySelector<HTMLInputElement>('[role="switch"]');
    if (toggle?.checked) return;
    act(() => toggle?.click());
  }

  function speechDialog(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('.reach-deck-speech-dialog');
  }

  function previewPopover(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('.reach-deck-speech-preview-popover');
  }

  function findText(value: string): { node: Text; offset: number } {
    const surface = host.querySelector('.ProseMirror');
    const walker = document.createTreeWalker(surface!, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const offset = node.data.indexOf(value);
      if (offset >= 0) return { node, offset };
    }
    throw new Error(`Could not find ${value} in editor.`);
  }

  function changeSelect(label: string, value: string, scope: ParentNode = host) {
    const trigger = scope.querySelector<HTMLButtonElement>(
      `[role="combobox"][aria-label="${label}"]`,
    )!;
    act(() => trigger.click());
    const optionId = `${trigger.getAttribute('aria-controls')}-option-${encodeURIComponent(value)}`;
    const option = document.getElementById(optionId)!;
    act(() => option.click());
  }

  function changeInput(label: string, value: string, scope: ParentNode | null = host) {
    const input = scope?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function slide(narration: ReachDeckNativeSlideV2['narration']): ReachDeckNativeSlideV2 {
  return {
    schemaVersion: 'reach-deck-slide/v2',
    id: 'slide-1',
    title: 'Slide',
    background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
    elements: [],
    animations: [],
    narration,
  };
}
