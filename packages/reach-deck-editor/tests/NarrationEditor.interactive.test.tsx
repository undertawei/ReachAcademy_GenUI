// @vitest-environment jsdom

import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalizeReachDeckSpeechMarkupV1,
  reachDeckInteractiveNarrationMarkdown,
  type ReachDeckInteractiveNarrationV1,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';

import {
  NarrationEditor,
  type NarrationDraftCache,
  type NarrationEditorInteractiveHandle,
  type NarrationEditorInteractiveProps,
} from '../src/NarrationEditor.js';
import type { InteractiveNarrationDraftSnapshot } from '../src/interactiveNarration.js';

const SAVED_TEXT = '拖动滑块并观察结果。';

describe('NarrationEditor Interactive variant', () => {
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

  it('matches the slide narration panel without animation, text-only, audio-only or draft actions', async () => {
    await render(narration(SAVED_TEXT, { audioResourceId: 'audio-1' }), {
      onPreviewSpeech: vi.fn(),
      onRegenerate: vi.fn(),
      onRequestSpeechMarkupCandidates: vi.fn(),
      onSaveAndGenerate: vi.fn(),
    });

    expect(host.querySelector('.reach-deck-timeline__narration-header strong')?.textContent).toBe(
      '讲稿',
    );
    const menuLabels = [
      ...host.querySelectorAll('.reach-deck-timeline__narration-menu-items > button'),
    ].map((button) => button.getAttribute('aria-label'));
    expect(menuLabels).toEqual(['重新生成本页讲稿和音频']);
    expect(host.querySelector('[aria-expanded]')).toBeNull();
    for (const label of [
      '仅重新生成本页讲稿',
      '仅生成本页音频',
      '仅重新生成本页动画',
      '重新生成本页音频和动画',
      '仅保存草稿',
    ]) {
      expect(host.querySelector(`[aria-label="${label}"]`)).toBeNull();
    }
    expect(host.querySelector('summary[aria-label="保存选项"]')).toBeNull();
    expect(host.textContent).not.toContain('动画');

    expect(host.querySelector('.ProseMirror')?.getAttribute('aria-label')).toBe('互动页讲稿');
    expect(host.querySelector('[role="switch"][aria-label="显示语音标记"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="智能打标"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="插入行内公式"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="插入独立公式"]')).toBeNull();
    enableSpeechTags();
    for (const label of ['停顿', '替换读法', '指定读法', '发音']) {
      expect(host.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    }

    const footer = host.querySelector('footer');
    expect(footer?.querySelector('[role="status"]')?.textContent).toBe('互动讲稿音频已就绪');
    expect(footer?.textContent).toContain('10 / 600 字符');
    expect(footer?.querySelector('[aria-label="试听"]')).not.toBeNull();
    expect(
      footer?.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]')?.disabled,
    ).toBe(false);
  });

  it('previews the entire audition draft without selecting text and displays its limits', async () => {
    const onPreviewSpeech = vi
      .fn()
      .mockResolvedValue({ contentType: 'audio/mpeg', dataBase64: 'SUQz' });
    await render(narration(SAVED_TEXT), {
      onPreviewSpeech,
      previewScope: 'document',
      previewPresentation: 'inline',
      previewLimitLabel: '含语音标记最多 150 字符',
    });
    expect(host.querySelector('footer')?.textContent).toContain('10 / 80 字符/词');
    expect(host.querySelector('footer')?.textContent).toContain('含语音标记最多 150 字符');
    expect(host.querySelector('footer')?.textContent).not.toContain('待生成音频');
    expect(host.querySelector('[aria-label="试听"]')?.getAttribute('aria-disabled')).toBe('false');
    await replaceEditorText(SAVED_TEXT, '无垠学堂，让学习充满启发。');
    expect(host.querySelector('footer')?.textContent).not.toContain('有未保存的修改');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="试听"]')?.click());
    const audio = host.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.closest('[role="region"]')).not.toBeNull();
    expect(document.querySelector('.reach-deck-speech-preview-popover')).toBeNull();
    expect(onPreviewSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: '无垠学堂，让学习充满启发。',
        markdownFrom: 0,
        markdownTo: 13,
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it.each(['学'.repeat(81), 'a'.repeat(151)])(
    'blocks an oversized full audition draft: %s',
    async (value) => {
      const onPreviewSpeech = vi.fn();
      await render(narration(value), { onPreviewSpeech, previewScope: 'document' });
      const trigger = host.querySelector<HTMLButtonElement>('[aria-label="试听"]')!;
      expect(trigger.getAttribute('aria-disabled')).toBe('true');
      expect(trigger.title).toContain('输入的文字太长');
      await act(async () => trigger.click());
      expect(onPreviewSpeech).not.toHaveBeenCalled();
    },
  );

  it('blocks an empty full audition draft without prompting for a selection', async () => {
    await render(undefined, { onPreviewSpeech: vi.fn(), previewScope: 'document' });
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="试听"]')!;
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.title).not.toContain('选择');
  });

  it('confirms the narration-and-audio rewrite and keeps the draft when it fails', async () => {
    const rewrite = vi.fn().mockRejectedValue(new Error('unavailable'));
    await render(narration(SAVED_TEXT), { onRegenerate: rewrite });
    const rewriteButton = () =>
      host.querySelector<HTMLButtonElement>('[aria-label="重新生成本页讲稿和音频"]')!;

    act(() => rewriteButton().click());
    const savedCopy = document.querySelector('[role="alertdialog"]')?.textContent ?? '';
    expect(savedCopy).toContain(
      'AI 将重新生成本页讲稿并重新合成音频，覆盖现有讲稿和音频。是否继续？',
    );
    expect(savedCopy).not.toContain('动画');
    act(() => dialogButton('取消')?.click());
    expect(rewrite).not.toHaveBeenCalled();

    await replaceEditorText(SAVED_TEXT, '未保存的修改。');
    act(() => rewriteButton().click());
    const dirtyCopy = document.querySelector('[role="alertdialog"]')?.textContent ?? '';
    expect(dirtyCopy).toContain('覆盖现有讲稿和音频，同时丢弃尚未保存的修改');
    expect(dirtyCopy).not.toContain('动画');
    await act(async () => dialogButton('继续')?.click());

    expect(rewrite).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('AI 重新生成讲稿失败');
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('未保存的修改。');
  });

  it('replaces the draft with regenerated narration and skips confirmation on an empty page', async () => {
    const draftCache: NarrationDraftCache = new Map();
    let resolveRewrite!: () => void;
    const rewrite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRewrite = resolve;
        }),
    );
    await render(undefined, { draftCache, onRegenerate: rewrite });
    act(() =>
      host.querySelector<HTMLButtonElement>('[aria-label="重新生成本页讲稿和音频"]')!.click(),
    );
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(rewrite).toHaveBeenCalledOnce();

    await render(narration('AI 生成的新讲稿。'), { draftCache, onRegenerate: rewrite });
    await act(async () => resolveRewrite());
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('AI 生成的新讲稿。');
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('待生成音频');
  });

  it.each([{ disabled: true }, { generationBlockedReason: 'Decksmith 正在处理本课件。' }])(
    'disables rewrite and saving while locked: %j',
    async (locks) => {
      await render(narration(SAVED_TEXT), {
        ...locks,
        onRegenerate: vi.fn(),
        onSaveAndGenerate: vi.fn(),
      });
      expect(
        host.querySelector<HTMLButtonElement>('[aria-label="重新生成本页讲稿和音频"]')!.disabled,
      ).toBe(true);
      expect(
        host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]')!.disabled,
      ).toBe(true);
      expect(host.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe(
        locks.disabled === true ? 'false' : 'true',
      );
    },
  );

  it('saves normalized text with speech markup anchored to the derived narration markdown', async () => {
    const onSaveAndGenerate = vi.fn().mockResolvedValue(undefined);
    await render(
      narration(SAVED_TEXT, {
        speechMarkup: markup([{ type: 'break', at: 4, durationMs: 300 }]),
      }),
      { onSaveAndGenerate },
    );
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('待生成音频');

    await replaceEditorText('拖动滑块', '  拖动  滑块 ');
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('有未保存的修改');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]')?.click(),
    );

    expect(onSaveAndGenerate).toHaveBeenCalledOnce();
    const saved = onSaveAndGenerate.mock.calls[0]![0] as {
      speechMarkup?: ReachDeckSpeechMarkupV1;
      text: string;
    };
    expect(saved).toEqual({
      text: '拖动 滑块 并观察结果。',
      speechMarkup: markup([{ type: 'break', at: 6, durationMs: 300 }]),
    });
    expect(
      canonicalizeReachDeckSpeechMarkupV1(
        saved.speechMarkup,
        reachDeckInteractiveNarrationMarkdown(saved.text),
      ),
    ).toEqual(saved.speechMarkup);
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('待生成音频');
  });

  it('omits speech markup when the draft has none and keeps a failed save in the editor', async () => {
    const onSaveAndGenerate = vi.fn().mockRejectedValue(new TypeError('boom'));
    const onDraftChange = vi.fn();
    await render(narration(SAVED_TEXT, { audioResourceId: 'audio-1' }), {
      onDraftChange,
      onSaveAndGenerate,
    });
    await replaceEditorText(SAVED_TEXT, '换一段讲稿。');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]')?.click(),
    );

    expect(onSaveAndGenerate).toHaveBeenCalledWith({ text: '换一段讲稿。' });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      '保存互动讲稿并生成音频失败，讲稿仍保留在编辑器中，请重试。',
    );
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('换一段讲稿。');
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('互动讲稿音频生成失败');
    expect(lastSnapshot(onDraftChange)).toMatchObject({
      dirty: true,
      saveError: '保存互动讲稿并生成音频失败，讲稿仍保留在编辑器中，请重试。',
      saving: false,
      text: '换一段讲稿。',
    });

    // 再次修改讲稿即清除粘滞的保存失败提示。
    await replaceEditorText('换一段讲稿。', '再换一段讲稿。');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(lastSnapshot(onDraftChange).saveError).toBeUndefined();
  });

  it('reports the shared draft to the host and saves it through the imperative handle', async () => {
    const onDraftChange = vi.fn();
    const onSaveAndGenerate = vi.fn().mockResolvedValue(undefined);
    const actionsRef = createRef<NarrationEditorInteractiveHandle>();
    await render(narration(SAVED_TEXT, { audioResourceId: 'audio-1' }), {
      actionsRef,
      onDraftChange,
      onSaveAndGenerate,
    });
    expect(lastSnapshot(onDraftChange)).toEqual({
      dirty: false,
      saving: false,
      scalarCount: 10,
      text: SAVED_TEXT,
    });

    await replaceEditorText(SAVED_TEXT, '先拖动滑块。');
    expect(lastSnapshot(onDraftChange)).toEqual({
      dirty: true,
      saving: false,
      scalarCount: 6,
      text: '先拖动滑块。',
    });

    await act(async () => actionsRef.current?.saveAndGenerate());
    expect(onSaveAndGenerate).toHaveBeenCalledWith({ text: '先拖动滑块。' });
    expect(lastSnapshot(onDraftChange)).toMatchObject({ dirty: false, saving: false });
  });

  it('rebases an unsaved draft onto newer authoritative narration', async () => {
    const draftCache: NarrationDraftCache = new Map();
    const onDraftChange = vi.fn();
    await render(narration(SAVED_TEXT), { draftCache, onDraftChange });
    await replaceEditorText(SAVED_TEXT, '我的未保存探索提示。');

    await render(narration('Decksmith 生成的新讲稿。'), { draftCache, onDraftChange });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('我的未保存探索提示。');
    expect(lastSnapshot(onDraftChange).dirty).toBe(true);

    // 权威讲稿追上草稿后不再算未保存修改。
    await render(narration('我的未保存探索提示。'), { draftCache, onDraftChange });
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('我的未保存探索提示。');
    expect(lastSnapshot(onDraftChange).dirty).toBe(false);
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('待生成音频');
  });

  it('passes the editor markdown to smart tagging exactly like slide narration', async () => {
    const onRequestSpeechMarkupCandidates = vi.fn().mockResolvedValue([]);
    await render(narration('5 - 3 等于 2。'), { onRequestSpeechMarkupCandidates });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="智能打标"]')?.click(),
    );
    expect(onRequestSpeechMarkupCandidates).toHaveBeenCalledWith(
      { markdown: reachDeckInteractiveNarrationMarkdown('5 - 3 等于 2。') },
      expect.any(AbortSignal),
    );
    expect(onRequestSpeechMarkupCandidates.mock.calls[0]![0].markdown).toBe('5 \\- 3 等于 2。');
  });

  it('keeps the narration to a single paragraph for Enter and multi-line paste', async () => {
    const onDraftChange = vi.fn();
    await render(undefined, { onDraftChange });
    const surface = host.querySelector<HTMLElement>('.ProseMirror')!;
    expect(lastSnapshot(onDraftChange)).toEqual({
      dirty: false,
      saving: false,
      scalarCount: 0,
      validationError: 'empty',
    });

    await pasteNarration('第一行\n第二行\n\n第三段\t结尾');
    expect(surface.querySelectorAll('p')).toHaveLength(1);
    expect(surface.querySelector('br:not(.ProseMirror-trailingBreak)')).toBeNull();
    expect(surface.textContent).toBe('第一行 第二行 第三段 结尾');

    for (const init of [{ key: 'Enter' }, { key: 'Enter', shiftKey: true }]) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      await act(async () => {
        surface.dispatchEvent(event);
        await Promise.resolve();
      });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(surface.querySelectorAll('p')).toHaveLength(1);
    expect(surface.textContent).toBe('第一行 第二行 第三段 结尾');
    expect(lastSnapshot(onDraftChange)).toMatchObject({
      dirty: true,
      text: '第一行 第二行 第三段 结尾',
    });
  });

  it('counts capacity on the derived text and blocks saving past 600 characters', async () => {
    const onSaveAndGenerate = vi.fn();
    const onDraftChange = vi.fn();
    await render(narration(SAVED_TEXT), { onDraftChange, onSaveAndGenerate });
    const save = () => host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]')!;

    await replaceEditorText(SAVED_TEXT, '字'.repeat(601));
    expect(host.querySelector('footer')?.textContent).toContain('601 / 600 字符');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      '互动讲稿不能超过 600 个 Unicode 字符。',
    );
    expect(save().disabled).toBe(true);
    expect(lastSnapshot(onDraftChange)).toEqual({
      dirty: true,
      saving: false,
      scalarCount: 601,
      validationError: 'limit',
    });

    // 转义字符不计入容量：600 个连字符在 Markdown 中是 1200 个码位，仍可保存。
    await replaceEditorText('字'.repeat(601), '-'.repeat(600));
    expect(host.querySelector('footer')?.textContent).toContain('600 / 600 字符');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(save().disabled).toBe(false);

    await replaceEditorText('-'.repeat(600), '');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('请输入互动讲稿。');
    expect(save().disabled).toBe(true);
    expect(lastSnapshot(onDraftChange)).toMatchObject({ dirty: true, validationError: 'empty' });
  });

  it('loads narration that markdown cannot express literally and resaves it verbatim', async () => {
    const onSaveAndGenerate = vi.fn().mockResolvedValue(undefined);
    const onDraftChange = vi.fn();
    const literal = '1. 拖动滑块并观察结果。';
    await render(narration(literal, { audioResourceId: 'audio-1' }), {
      interactive: {
        id: 'interactive-page',
        narration: narration(literal, { audioResourceId: 'audio-1' }),
        generationState: 'failed',
      },
      onDraftChange,
      onSaveAndGenerate,
    });

    expect(host.querySelector('.ProseMirror')?.textContent).toBe(literal);
    expect(host.querySelector('.reach-deck-timeline__narration-warning')?.textContent).toContain(
      '已按纯文本载入',
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('footer [role="status"]')?.textContent).toBe('互动讲稿音频生成失败');
    expect(lastSnapshot(onDraftChange)).toMatchObject({ dirty: false, text: literal });

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]')?.click(),
    );
    expect(onSaveAndGenerate).toHaveBeenCalledWith({ text: literal });

    // 教师开始编辑后按草稿校验：仍是列表形态时不可保存，修正后可保存。
    await replaceEditorText(literal, '1. 拖动滑块。');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(lastSnapshot(onDraftChange)).toMatchObject({ dirty: true, validationError: 'invalid' });
    await replaceEditorText('1. 拖动滑块。', '第一步：拖动滑块。');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(lastSnapshot(onDraftChange)).toMatchObject({ dirty: true, text: '第一步：拖动滑块。' });
  });

  it.each([
    { generationState: 'queued' as const, label: '音频排队中' },
    { generationState: 'generating' as const, label: '正在生成音频' },
    { generationState: 'failed' as const, label: '互动讲稿音频生成失败' },
  ])(
    'projects the $generationState audio state in the footer',
    async ({ generationState, label }) => {
      await render(narration(SAVED_TEXT), {
        interactive: { id: 'interactive-page', narration: narration(SAVED_TEXT), generationState },
      });
      expect(host.querySelector('footer [role="status"]')?.textContent).toBe(label);
    },
  );

  async function render(
    value: ReachDeckInteractiveNarrationV1 | undefined,
    props: Partial<NarrationEditorInteractiveProps> = {},
  ) {
    await act(async () => {
      root.render(
        <NarrationEditor interactive={{ id: 'interactive-page', narration: value }} {...props} />,
      );
      await Promise.resolve();
    });
  }

  async function replaceEditorText(current: string, next: string) {
    const surface = host.querySelector<HTMLElement>('.ProseMirror')!;
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    let target: Text | undefined;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.data.includes(current)) {
        target = node;
        break;
      }
    }
    if (target === undefined) throw new Error(`Could not find ${current} in editor.`);
    const node = target;
    await act(async () => {
      node.data = node.data.replace(current, next);
      surface.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: next, inputType: 'insertText' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function pasteNarration(plainText: string) {
    const clipboardData = {
      files: [],
      getData: (type: string) => (type === 'text/plain' ? plainText : ''),
      items: [],
      types: ['text/plain'],
    } as unknown as DataTransfer;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
    await act(async () => {
      host.querySelector<HTMLElement>('.ProseMirror')?.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function enableSpeechTags() {
    const toggle = host.querySelector<HTMLInputElement>('[role="switch"]');
    if (toggle?.checked) return;
    act(() => toggle?.click());
  }

  function dialogButton(label: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === label,
    );
  }
});

function lastSnapshot(mock: ReturnType<typeof vi.fn>): InteractiveNarrationDraftSnapshot {
  const call = mock.mock.calls.at(-1);
  if (call === undefined) throw new Error('Expected a reported Interactive narration draft.');
  return call[0] as InteractiveNarrationDraftSnapshot;
}

function narration(
  text: string,
  extra: Partial<Pick<ReachDeckInteractiveNarrationV1, 'audioResourceId' | 'speechMarkup'>> = {},
): ReachDeckInteractiveNarrationV1 {
  return { schemaVersion: 'reach-interactive-narration/v1', text, ...extra };
}

function markup(marks: ReachDeckSpeechMarkupV1['marks']): ReachDeckSpeechMarkupV1 {
  return { schemaVersion: 'reach-deck-speech-marks/v1', marks };
}
