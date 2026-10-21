// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
  normalizeReachDeckDocumentV2,
  REACH_DECK_BUILT_IN_FONT_FAMILIES,
  richTextToPlainText,
  richTextFromPlainText,
  isNativeSlideNarrationContentStale,
  type ReachDeckDocument,
  type ReachDeckNativeElementV2,
  type ReachDeckTextFrameV2,
} from '@reachany/reach-deck-dsl';
import { ConfirmDialog, Select } from '@reachany/ui';
import {
  REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS,
  REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS,
  REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS,
} from '@reachany/reach-deck-rich-text';

import { ReachDeckEditor, type ReachDeckEditorAssistantRecovery } from '../src/ReachDeckEditor';
import {
  addReachDeckPage,
  deleteReachDeckPage,
  REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
  REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION,
} from '../src/operations';
import { createEditorDocument } from './fixture';

const editorStyles = readFileSync('styles.css', 'utf8');
// 共享样式入口 + 按组拆分的样式文件（jsdom 不解析 @import）。
const sharedUiStyles = [
  readFileSync('../ui/src/styles.css', 'utf8'),
  ...readdirSync('../ui/src/styles')
    .filter((name) => name.endsWith('.css'))
    .sort()
    .map((name) => readFileSync(`../ui/src/styles/${name}`, 'utf8')),
].join('\n');

describe('ReachDeckEditor', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalRangeBoundingRect: PropertyDescriptor | undefined;
  let originalRangeClientRects: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalRangeBoundingRect = Object.getOwnPropertyDescriptor(
      window.Range.prototype,
      'getBoundingClientRect',
    );
    originalRangeClientRects = Object.getOwnPropertyDescriptor(
      window.Range.prototype,
      'getClientRects',
    );
    Object.defineProperties(window.Range.prototype, {
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
      getClientRects: { configurable: true, value: () => [] },
    });
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.document
      .querySelectorAll('[data-reach-deck-test-style]')
      .forEach((element) => element.remove());
    if (originalRangeBoundingRect === undefined) {
      delete (window.Range.prototype as Partial<Range>).getBoundingClientRect;
    } else {
      Object.defineProperty(
        window.Range.prototype,
        'getBoundingClientRect',
        originalRangeBoundingRect,
      );
    }
    if (originalRangeClientRects === undefined) {
      delete (window.Range.prototype as Partial<Range>).getClientRects;
    } else {
      Object.defineProperty(window.Range.prototype, 'getClientRects', originalRangeClientRects);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not override shared buttons while retaining editor-local button styling', () => {
    const editorButtonReset =
      '.reach-deck-editor button:not(:where(.rx-button, .rx-icon-button, .rx-attachment-name, .rx-select-trigger, .rx-select-option))';
    expect(editorStyles.replace(/\s+/g, '')).toContain(editorButtonReset.replace(/\s+/g, ''));
    expect(editorStyles).not.toContain(
      '.reach-deck-editor button:not(.rx-button):not(.rx-select-trigger):not(.rx-select-option)',
    );
    expect(editorStyles).not.toMatch(/\.reach-deck-editor button\s*\{[^}]*background:\s*#fff/s);

    const sharedStyle = window.document.createElement('style');
    sharedStyle.dataset.reachDeckTestStyle = 'shared';
    sharedStyle.textContent = sharedUiStyles;
    const editorStyle = window.document.createElement('style');
    editorStyle.dataset.reachDeckTestStyle = 'editor';
    editorStyle.textContent = editorStyles;
    window.document.head.append(sharedStyle, editorStyle);

    const renderSharedControls = (locale: 'en-US' | 'zh-CN') =>
      root.render(
        <div className="reach-deck-editor">
          <ConfirmDialog
            cancelLabel={locale === 'zh-CN' ? '取消' : 'Cancel'}
            confirmLabel={locale === 'zh-CN' ? '继续' : 'Continue'}
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
            open
            title={locale === 'zh-CN' ? '重新生成讲稿？' : 'Regenerate narration?'}
            tone="danger"
          />
          <Select
            aria-label={locale === 'zh-CN' ? '测试选择器' : 'Test selector'}
            onChange={vi.fn()}
            options={[{ label: locale === 'zh-CN' ? '选项' : 'Option', value: 'option' }]}
            value="option"
          />
        </div>,
      );

    act(() => renderSharedControls('zh-CN'));
    // 共享弹窗渲染在 body 下的 portal 根节点，不在编辑器容器里。
    const continueButton = [...window.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '继续',
    );
    expect(continueButton).toBeDefined();
    expect(continueButton?.matches('.rx-button[data-variant="primary"]')).toBe(true);
    expect(container.querySelector('.rx-select-trigger')?.matches('.rx-select-trigger')).toBe(true);
    expect(window.document.body.textContent).toContain('取消');
    expect(sharedUiStyles).toMatch(
      /\[data-variant='primary'\], \.rx-button-primary\) \{[^}]*--rx-button-fg: var\(--reachany-color-primary-contrast\)/s,
    );
    // 编辑器的 button 重置样式不作用于共享按钮：背景来自共享变量，而不是编辑器的字面量。
    expect(window.getComputedStyle(continueButton!).backgroundColor).not.toBe('rgb(255, 255, 255)');

    act(() => renderSharedControls('en-US'));
    expect(window.document.body.textContent).toContain('Continue');
    expect(window.document.body.textContent).toContain('Cancel');

    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={vi.fn()} />,
      ),
    );
    const composerSubmit = container.querySelector<HTMLButtonElement>(
      '.reach-deck-editor__assistant-composer button[type="submit"]',
    );
    expect(composerSubmit).not.toBeNull();
    expect(composerSubmit?.matches('.rx-button, .rx-select-trigger, .rx-select-option')).toBe(
      false,
    );
    expect(window.getComputedStyle(composerSubmit!).backgroundColor).toBe('rgb(94, 56, 83)');
    expect(window.getComputedStyle(composerSubmit!).minHeight).toBe('1.75rem');
  });

  it('fills the editor height through direct, live, and preview Interactive player layers', () => {
    expect(editorStyles).toContain(
      ".reach-deck-editor__preview > .reach-deck-player[data-scene-type='interactive']",
    );
    expect(editorStyles).toMatch(
      /\.reach-deck-editor__player-layer\s*> \.reach-deck-player\[data-scene-type='interactive'\]/,
    );
    expect(editorStyles).toMatch(
      /\.reach-deck-editor__player-preview-layer\s*> \.reach-deck-player\[data-scene-type='interactive'\]/,
    );
    expect(editorStyles).toMatch(
      /--reach-deck-interactive-height:\s*100%;[\s\S]*--reach-deck-interactive-min-height:\s*0;/,
    );
    for (const selector of [
      '> .reach-deck-player__stage',
      '> [data-interactive-page-id]',
      '.interactive-scene-player-shell',
      '.interactive-scene-player',
    ]) {
      expect(editorStyles).toContain(selector);
    }
    expect(editorStyles).toMatch(
      /@media \(orientation: portrait\) and \(max-width: 760px\)[\s\S]*\.reach-deck-editor__workspace:has\(\.reach-deck-player\[data-scene-type='interactive'\]\)[\s\S]*minmax\(34rem, 1fr\)/,
    );
  });

  it('keeps only the canvas controls above the slide', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));

    expect(container.querySelector('.reach-deck-editor__toolbar')).toBeNull();
    expect(container.querySelector('[aria-label="课件标题"]')).toBeNull();
    expect(container.querySelector('[aria-label="插入元素"]')).toBeNull();
    expect(container.querySelector('input[aria-label^="元素 "]')).toBeNull();
    expect(container.textContent).not.toContain('位置与尺寸');
    expect(container.querySelector('[aria-label="页面标题"]')).toBeNull();
    expect(container.querySelector('[aria-label="选择元素"]')).toBeNull();
    expect(container.querySelector('button[aria-label="新建幻灯片"]')).toBeNull();
    const formatting = container.querySelector('[aria-label="画布格式"]');
    expect(formatting).not.toBeNull();
    expect(formatting?.classList.contains('reach-deck-editor__property-stack')).toBe(true);
  });

  it('keeps host workspace chrome interactive when authoring controls are disabled', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          disabled
          document={createEditorDocument()}
          workspaceCommandBar={
            <select aria-label="宿主阶段选择" defaultValue="studio">
              <option value="studio">工作台</option>
            </select>
          }
          workspacePageRailHeader={<strong>模块名称</strong>}
        />,
      ),
    );

    expect(container.querySelector('.reach-deck-editor__page-rail-header')?.textContent).toBe(
      '模块名称',
    );
    expect(
      container.querySelector<HTMLSelectElement>('[aria-label="宿主阶段选择"]')?.disabled,
    ).toBe(false);
    const commandBar = container.querySelector('.reach-deck-editor__workspace-command-bar');
    expect(commandBar).not.toBeNull();
    expect(commandBar?.closest('.reach-deck-editor__properties')).not.toBeNull();
    expect(commandBar?.querySelector('.reach-deck-editor__document-history')).toBeNull();
    expect(
      container
        .querySelector('.reach-deck-editor__document-history')
        ?.closest('.reach-deck-editor__canvas-corner'),
    ).not.toBeNull();
    expect(container.querySelector('.reach-deck-editor__inspector')).toBeNull();

    const collapse = container.querySelector<HTMLButtonElement>('[aria-label="收起编辑侧栏"]');
    act(() => collapse?.click());
    expect(commandBar?.getAttribute('aria-hidden')).toBe('true');
    expect(commandBar?.hasAttribute('inert')).toBe(true);
    const expand = container.querySelector<HTMLButtonElement>('[aria-label="展开编辑侧栏"]');
    act(() => expand?.click());
    expect(commandBar?.hasAttribute('aria-hidden')).toBe(false);
    expect(commandBar?.hasAttribute('inert')).toBe(false);
  });

  it('exposes host batch status on the page card through aria and lane icons only', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          batchStatusByPageId={{
            'page-1': [
              {
                accessibleLabel: 'Narration batch: queued',
                batchId: 'batch-1',
                kind: 'narration',
                status: 'waiting-dispatch',
              },
              {
                accessibleLabel: 'Media batch: generating',
                batchId: 'batch-2',
                kind: 'media',
                status: 'running',
              },
            ],
          }}
          document={createEditorDocument()}
        />,
      ),
    );

    const page = container.querySelector(
      '[data-page-card][data-batch-status="waiting-dispatch running"]',
    );
    expect(page?.getAttribute('aria-label')).toContain('第 1 页：First page');
    expect(page?.getAttribute('aria-label')).toContain('Narration batch: queued');
    expect(page?.getAttribute('aria-label')).toContain('Media batch: generating');
    // 批次文字行与逐页取消按钮已收进宿主的批次弹层；页面卡片只剩通道图标。
    expect(page?.textContent).not.toContain('Narration batch');
    expect(container.querySelector('.reach-deck-editor__page-batch-status')).toBeNull();
    expect(container.querySelector('.reach-deck-editor__page-batch-cancel')).toBeNull();
    expect(
      [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__page-lane')].map(
        (lane) => lane.dataset.state,
      ),
    ).toEqual(['ready', 'generating', 'generating', 'generating']);
  });

  it('uses state-preserving WAI-ARIA tabs for Decksmith, properties, and narration', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onAssistantPrompt={vi.fn()}
          workspaceRightPanelAction={<button type="button">恢复上一轮内容</button>}
        />,
      ),
    );
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Decksmith', '属性', '讲稿']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    const composer = container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    act(() => {
      setNativeValue(composer, '保留这段输入');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    });
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    expect(
      container.querySelector('#reach-deck-right-panel-decksmith')?.hasAttribute('hidden'),
    ).toBe(true);
    act(() => tabs[0]?.click());
    expect(
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')?.value,
    ).toBe('保留这段输入');
    const restore = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '恢复上一轮内容',
    );
    expect(restore?.closest('.reach-deck-editor__right-panel-action')).not.toBeNull();
    expect(restore?.closest('[role="tablist"]')).toBeNull();
    const suggestion = container.querySelector<HTMLButtonElement>(
      '.reach-deck-editor__assistant-suggestions button',
    );
    expect(suggestion?.title).toBe(suggestion?.textContent);
  });

  it('uploads media through three compact accessible controls and commits one undoable insertion', async () => {
    const onChange = vi.fn();
    let resolveUpload!: (value: {
      objectKey: string;
      contentType: string;
      digest: string;
      downloadUrl: string;
    }) => void;
    const onUploadAuthoringMedia = vi.fn(
      (_input: {
        file: File;
        kind: 'image' | 'audio' | 'video' | 'attachment';
        signal: AbortSignal;
      }) =>
        new Promise<{
          objectKey: string;
          contentType: string;
          digest: string;
          downloadUrl: string;
        }>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    let id = 0;
    await act(async () => {
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => `${prefix}-media-${++id}`}
          onChange={onChange}
          onUploadAuthoringMedia={onUploadAuthoringMedia}
        />,
      );
    });

    const group = container.querySelector<HTMLElement>('[aria-label="插入媒体"]')!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => [button.ariaLabel, button.title])).toEqual([
      ['插入图片', '插入图片'],
      ['插入音频', '插入音频'],
      ['插入视频', '插入视频'],
    ]);
    const inputs = [...group.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    expect(inputs).toHaveLength(3);
    expect(inputs[0]?.accept).toContain('image/png');
    expect(inputs[1]?.accept).toContain('audio/mpeg');
    expect(inputs[2]?.accept).toContain('video/mp4');

    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    Object.defineProperty(inputs[0], 'files', { configurable: true, value: [file] });
    await act(async () => {
      inputs[0]!.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onUploadAuthoringMedia).toHaveBeenCalledWith(
      expect.objectContaining({ file, kind: 'image', signal: expect.any(AbortSignal) }),
    );
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(buttons[0]?.getAttribute('aria-busy')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpload({
        objectKey: 'uploads/deck/image/diagram.png',
        contentType: 'image/png',
        digest: `sha256:${'a'.repeat(64)}`,
        downloadUrl: 'https://signed.example/diagram.png',
      });
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const inserted = onChange.mock.calls[0]?.[0] as ReachDeckDocument;
    expect(inserted.resources.media.at(-1)).toMatchObject({
      objectKey: 'uploads/deck/image/diagram.png',
      contentType: 'image/png',
      digest: `sha256:${'a'.repeat(64)}`,
    });
    expect(JSON.stringify(inserted)).not.toContain('signed.example');
    const resourceId = inserted.resources.media.at(-1)!.id;
    expect(
      container.querySelector<HTMLImageElement>(`img[data-native-v2-resource-id="${resourceId}"]`)
        ?.src,
    ).toBe('https://signed.example/diagram.png');

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')!.click());
    const undone = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(undone.resources.media.some((resource) => resource.id === resourceId)).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="重做课件修改"]')!.click());
    const redone = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(redone.resources.media.some((resource) => resource.id === resourceId)).toBe(true);
  });

  it('hosts the media insert group inside the properties tab and only for slide pages', () => {
    const onUploadAuthoringMedia = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onUploadAuthoringMedia={onUploadAuthoringMedia}
        />,
      ),
    );
    const group = container.querySelector<HTMLElement>('[aria-label="插入媒体"]');
    expect(group?.closest('#reach-deck-right-panel-properties')).not.toBeNull();
    expect(group?.closest('.reach-deck-editor__right-panel-header')).toBeNull();

    let id = 0;
    let quizOnly = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory: (prefix) => `${prefix}-media-quiz-${++id}`,
    });
    quizOnly = deleteReachDeckPage(quizOnly, 'page-1');
    act(() =>
      root.render(
        <ReachDeckEditor document={quizOnly} onUploadAuthoringMedia={onUploadAuthoringMedia} />,
      ),
    );
    expect(container.querySelector('[aria-label="插入媒体"]')).toBeNull();
  });

  it('does not insert a completed upload into a page selected after upload began', async () => {
    let resolveUpload!: (value: {
      objectKey: string;
      contentType: string;
      digest: string;
      downloadUrl: string;
    }) => void;
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onChange={onChange}
          onUploadAuthoringMedia={() =>
            new Promise((resolve) => {
              resolveUpload = resolve;
            })
          }
        />,
      );
    });
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="插入媒体"] input[accept*="image/png"]',
    )!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['image'], 'diagram.png', { type: 'image/png' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    const secondPage = [...container.querySelectorAll<HTMLElement>('[data-page-card]')].find(
      (page) => page.textContent?.includes('Second page'),
    )!;
    act(() => secondPage.click());
    await act(async () => {
      resolveUpload({
        objectKey: 'uploads/deck/image/diagram.png',
        contentType: 'image/png',
        digest: `sha256:${'b'.repeat(64)}`,
        downloadUrl: 'https://signed.example/diagram.png',
      });
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '目标页面已切换、删除或锁定',
    );
  });

  it('blocks media upload before and after structure locking', async () => {
    const onChange = vi.fn();
    const lockedUpload = vi.fn();
    await act(async () => {
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onChange={onChange}
          onUploadAuthoringMedia={lockedUpload}
          structureLocked
        />,
      );
    });
    const lockedGroup = container.querySelector<HTMLElement>('[aria-label="插入媒体"]')!;
    expect(
      [...lockedGroup.querySelectorAll<HTMLButtonElement>('button')].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    const lockedInput = lockedGroup.querySelector<HTMLInputElement>('input[accept*="image/png"]')!;
    Object.defineProperty(lockedInput, 'files', {
      configurable: true,
      value: [new File(['image'], 'blocked.png', { type: 'image/png' })],
    });
    await act(async () => {
      lockedInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(lockedUpload).not.toHaveBeenCalled();

    let resolveUpload!: (value: {
      objectKey: string;
      contentType: string;
      digest: string;
      downloadUrl: string;
    }) => void;
    const pendingUpload = vi.fn(
      () =>
        new Promise<{
          objectKey: string;
          contentType: string;
          digest: string;
          downloadUrl: string;
        }>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const editorDocument = createEditorDocument();
    await act(async () => {
      root.render(
        <ReachDeckEditor
          document={editorDocument}
          onChange={onChange}
          onUploadAuthoringMedia={pendingUpload}
        />,
      );
    });
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="插入媒体"] input[accept*="image/png"]',
    )!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['image'], 'pending.png', { type: 'image/png' })],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(pendingUpload).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(
        <ReachDeckEditor
          document={editorDocument}
          onChange={onChange}
          onUploadAuthoringMedia={pendingUpload}
          structureLocked
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolveUpload({
        objectKey: 'uploads/deck/image/pending.png',
        contentType: 'image/png',
        digest: `sha256:${'c'.repeat(64)}`,
        downloadUrl: 'https://signed.example/pending.png',
      });
      await Promise.resolve();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '目标页面已切换、删除或锁定',
    );
  });

  it('renders the host narration action only inside the narration tab', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onAssistantPrompt={vi.fn()}
          workspaceNarrationPanelAction={<button type="button">重新生成所有讲稿和动画</button>}
        />,
      ),
    );

    const action = () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '重新生成所有讲稿和动画',
      );
    expect(action()).toBeUndefined();

    const narrationTab = container.querySelector<HTMLButtonElement>(
      '#reach-deck-right-tab-narration',
    )!;
    act(() => narrationTab.click());
    const narrationAction = action();
    expect(narrationAction).not.toBeUndefined();
    expect(narrationAction?.closest('#reach-deck-right-panel-narration')).not.toBeNull();
    expect(narrationAction?.closest('.reach-deck-timeline__narration-actions')).not.toBeNull();

    const propertiesTab = container.querySelector<HTMLButtonElement>(
      '#reach-deck-right-tab-properties',
    )!;
    act(() => propertiesTab.click());
    expect(action()).toBeUndefined();
  });

  it('collapses and restores both studio side panels without discarding their state', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onAssistantPrompt={vi.fn()}
          workspacePageRailHeader={<strong>模块名称</strong>}
        />,
      ),
    );

    const workspace = container.querySelector<HTMLElement>('.reach-deck-editor__workspace')!;
    const pageRail = container.querySelector<HTMLElement>('.reach-deck-editor__pages')!;
    const collapsePageRail =
      container.querySelector<HTMLButtonElement>('[aria-label="收起页面列表"]')!;
    act(() => collapsePageRail.click());
    expect(workspace.hasAttribute('data-page-rail-collapsed')).toBe(true);
    expect(pageRail.getAttribute('aria-hidden')).toBe('true');
    expect(pageRail.hasAttribute('inert')).toBe(true);
    const expandPageRail =
      container.querySelector<HTMLButtonElement>('[aria-label="展开页面列表"]')!;
    act(() => expandPageRail.click());
    expect(workspace.hasAttribute('data-page-rail-collapsed')).toBe(false);
    expect(pageRail.hasAttribute('inert')).toBe(false);

    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    act(() => tabs[1]?.click());
    const propertiesPanel = container.querySelector<HTMLElement>(
      '#reach-deck-right-panel-properties',
    )!;
    const collapseRightPanel =
      container.querySelector<HTMLButtonElement>('[aria-label="收起编辑侧栏"]')!;
    act(() => collapseRightPanel.click());
    expect(workspace.hasAttribute('data-right-panel-collapsed')).toBe(true);
    expect(propertiesPanel.getAttribute('aria-hidden')).toBe('true');
    expect(propertiesPanel.hasAttribute('inert')).toBe(true);
    const expandRightPanel =
      container.querySelector<HTMLButtonElement>('[aria-label="展开编辑侧栏"]')!;
    act(() => expandRightPanel.click());
    expect(workspace.hasAttribute('data-right-panel-collapsed')).toBe(false);
    expect(propertiesPanel.hasAttribute('inert')).toBe(false);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('uses the toolbar position for compact interactive policy controls', () => {
    const added = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'interactive',
      idFactory: (prefix) => `${prefix}-interactive`,
    });
    const document = deleteReachDeckPage(added, 'page-1');
    const onChange = vi.fn();

    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));

    const toolbar = container.querySelector<HTMLElement>('[aria-label="互动设置"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.classList.contains('reach-deck-editor__inspector-toolbar')).toBe(true);
    expect(toolbar?.classList.contains('reach-deck-editor__property-stack')).toBe(true);
    expect(container.querySelector('[aria-label="画布格式"]')).toBeNull();
    expect(toolbar?.querySelector('.reach-deck-editor__rich-text-toolbar')).toBeNull();
    expect(toolbar?.querySelector('.reach-deck-editor__object-toolbar')).toBeNull();
    expect(container.textContent).not.toContain('高级场景 JSON');
    expect(container.querySelector('[aria-label="场景 JSON"]')).toBeNull();

    const completion = toolbar?.querySelector<HTMLSelectElement>('[aria-label="互动完成方式"]');
    const duration = toolbar?.querySelector<HTMLInputElement>('[aria-label="互动允许时长"]');
    const reset = toolbar?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(completion?.value).toBe('none');
    expect(duration?.value).toBe('');
    expect(duration?.placeholder).toBe('不限时');
    expect(
      toolbar?.querySelector('.reach-deck-editor__interactive-duration-unit')?.textContent,
    ).toBe('秒');
    expect(reset?.checked).toBe(true);

    act(() => {
      if (!completion || !duration || !reset) throw new Error('interactive toolbar is incomplete');
      setNativeValue(completion, 'automatic');
      completion.dispatchEvent(new Event('change', { bubbles: true }));
      setNativeValue(duration, '90');
      duration.dispatchEvent(new Event('change', { bubbles: true }));
      setNativeValue(duration, '');
      duration.dispatchEvent(new Event('change', { bubbles: true }));
      reset.click();
    });

    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const page = next.pages[0];
    if (page?.sceneType !== 'interactive') throw new Error('Expected interactive page');
    expect(page.scene.documentHtml).toBe(CANONICAL_BLANK_INTERACTIVE_DOCUMENT);
    expect(page.scene.runtimeDependencies).toEqual([]);
    expect(page.scene.runtimePolicy).toEqual({
      completionMode: 'automatic',
      maximumDurationSeconds: null,
      allowReset: false,
    });
  });

  it('opens and focuses Decksmith from the host-owned blank Interactive state', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const added = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'interactive',
      idFactory: (prefix) => `${prefix}-blank-action`,
    });
    const deck = deleteReachDeckPage(added, 'page-1');
    act(() => root.render(<ReachDeckEditor document={deck} onAssistantPrompt={vi.fn()} />));

    const propertiesTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === '属性',
    )!;
    act(() => propertiesTab.click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="收起编辑侧栏"]')!.click());
    expect(
      container
        .querySelector('.reach-deck-editor__workspace')
        ?.hasAttribute('data-right-panel-collapsed'),
    ).toBe(true);
    expect(container.querySelector('iframe')).toBeNull();

    const action = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Create with Decksmith',
    )!;
    act(() => action.click());
    const decksmithTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === 'Decksmith',
    )!;
    expect(decksmithTab.getAttribute('aria-selected')).toBe('true');
    expect(
      container
        .querySelector('.reach-deck-editor__workspace')
        ?.hasAttribute('data-right-panel-collapsed'),
    ).toBe(false);
  });

  it('uses the optional translator for editor chrome and the embedded player', () => {
    const english = (key: string) =>
      ({
        'reachDeck.editor.pagesLabel': 'Slide pages',
        'reachDeck.editor.pages': 'Pages',
        'reachDeck.editor.label': 'Reach Deck editor',
        'reachDeck.editor.objectProperties': 'Object properties',
        'reachDeck.editor.timeline.label': 'Timeline',
        'reachDeck.editor.canvasFormatting': 'Canvas formatting',
        'reachDeck.editor.richText.format': 'Text formatting',
        'reachDeck.editor.richText.spacing': 'Text spacing',
        'reachDeck.editor.richText.lineSpacingPreset': 'Line spacing options',
        'reachDeck.editor.richText.lineSpacingMultiple': 'Multiple spacing',
        'reachDeck.editor.richText.lineSpacingFixed': 'Fixed value',
        'reachDeck.editor.richText.lineSpacingFixedValue': 'Fixed line spacing in pixels',
        'reachDeck.editor.richText.lineSpacingMultiplier': 'Line spacing multiplier',
        'reachDeck.editor.richText.letterSpacingPixels': 'Character spacing in pixels',
      })[key] ?? key;

    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} translate={english} />),
    );

    expect(container.querySelector('[aria-label="Slide pages"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Reach Deck editor"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Object properties"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Timeline"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Canvas formatting"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Text formatting"]')).not.toBeNull();
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    expect(container.querySelector('[data-rich-text-spacing]')?.textContent).toContain(
      'Text spacing',
    );
    const lineSpacingOptions = container.querySelector<HTMLSelectElement>(
      '[aria-label="Line spacing options"]',
    );
    expect(lineSpacingOptions).not.toBeNull();
    expect([...lineSpacingOptions!.options].map((option) => option.text)).toEqual(
      expect.arrayContaining(['Multiple spacing', 'Fixed value']),
    );
    expect(container.querySelector('[aria-label="Line spacing multiplier"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Character spacing in pixels"]')).not.toBeNull();
    act(() => {
      setNativeValue(lineSpacingOptions!, 'fixed');
      lineSpacingOptions?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[aria-label="Fixed line spacing in pixels"]')).not.toBeNull();
    expect(container.textContent).toContain('First page');
  });

  it('uses the optional translator for quiz editor chrome', () => {
    let sequence = 0;
    const idFactory = (prefix: string) => `${prefix}-localized-${++sequence}`;
    const onlyPage = (sceneType: 'quiz') => {
      const added = addReachDeckPage(createEditorDocument(), {
        afterPageId: 'page-1',
        sceneType,
        idFactory,
      });
      return deleteReachDeckPage(added, 'page-1');
    };
    const english = (key: string) =>
      ({
        'reachDeck.editor.quiz.canvas': 'Quiz editing canvas',
        'reachDeck.editor.quiz.badge': 'QUIZ',
        'reachDeck.editor.quiz.addQuestion': 'Add question',
        'reachDeck.editor.quiz.questionType': 'Question type',
      })[key] ?? key;

    act(() =>
      root.render(<ReachDeckEditor key="quiz" document={onlyPage('quiz')} translate={english} />),
    );
    expect(container.querySelector('[aria-label="Quiz editing canvas"]')).not.toBeNull();
    expect(container.textContent).toContain('QUIZ');
    expect(container.textContent).toContain('Add question');
    expect(container.textContent).toContain('Question type');
  });

  it('rerenders app-owned assistant and action state in the new locale without changing content', async () => {
    const onChange = vi.fn();
    const onGeneratePage = vi.fn().mockResolvedValue(undefined);
    const onAssistantPrompt = vi.fn();
    const translations = {
      zh: {
        'reachDeck.editor.assistant.intro': '中文助手介绍',
        'reachDeck.editor.generation.cancelled': '中文生成取消',
      },
      en: {
        'reachDeck.editor.assistant.intro': 'English assistant introduction',
        'reachDeck.editor.generation.cancelled': 'English generation cancelled',
      },
    } as const;
    const chinese = (key: string) => translations.zh[key as keyof typeof translations.zh] ?? key;
    const english = (key: string) => translations.en[key as keyof typeof translations.en] ?? key;
    const document = createEditorDocument();

    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
          onGeneratePage={onGeneratePage}
          translate={chinese}
        />,
      ),
    );
    expect(container.textContent).toContain('中文助手介绍');

    const generate = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '生成当前页',
    );
    await act(async () => {
      generate?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('中文生成取消');

    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
          onGeneratePage={onGeneratePage}
          translate={english}
        />,
      ),
    );
    expect(container.textContent).toContain('English assistant introduction');
    expect(container.textContent).toContain('English generation cancelled');
    expect(container.textContent).toContain('First page');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not render document save or publish actions inside the PPT canvas', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));

    expect(container.querySelector('.reach-deck-editor__canvas-actions')).toBeNull();
    expect(container.querySelector('.reach-deck-editor__preview [aria-label*="保存"]')).toBeNull();
    expect(container.querySelector('.reach-deck-editor__preview [aria-label*="发布"]')).toBeNull();
    expect(container.querySelector('.reach-deck-editor__toolbar')).toBeNull();
  });

  it('keeps durable titles accessible while removing visible rail title editing', () => {
    const onChange = vi.fn();
    const document = createEditorDocument();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));

    const pageCard = container.querySelector<HTMLElement>(
      '[data-page-card][aria-label="第 1 页：First page"]',
    );
    expect(pageCard).not.toBeNull();
    expect(pageCard?.querySelector('.reach-deck-editor__page-title')).toBeNull();
    expect(pageCard?.querySelector('input')).toBeNull();
    expect(pageCard?.querySelector('.sr-only')?.textContent).toBe('First page');
    expect(pageCard?.textContent).toContain('幻灯片');
    expect(document.pages[0]?.title).toBe('First page');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uploads to the visible question after a document readback reduces the question count', async () => {
    let id = 0;
    const single = deleteReachDeckPage(
      addReachDeckPage(createEditorDocument(), {
        afterPageId: 'page-1',
        sceneType: 'quiz',
        idFactory: (prefix) => `${prefix}-${++id}`,
      }),
      'page-1',
    );
    const multiple = structuredClone(single);
    const page = multiple.pages[0]!;
    if (page.sceneType !== 'quiz') throw new Error('Expected quiz');
    page.scene.content.questions.push({
      ...structuredClone(page.scene.content.questions[0]!),
      id: 'question-2',
      question_index: 2,
    });
    const upload = vi.fn(async () => ({
      objectKey: 'uploads/visible.txt',
      contentType: 'text/plain',
      digest: 'digest',
      downloadUrl: 'https://example.test/visible.txt',
    }));
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <ReachDeckEditor document={multiple} onChange={onChange} onUploadAuthoringMedia={upload} />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '.reach-deck-editor__quiz-pagination [aria-label="下一题"]',
        )!
        .click(),
    );
    expect(container.querySelector('[aria-label="第 2 题题型"]')).not.toBeNull();
    await act(async () =>
      root.render(
        <ReachDeckEditor document={single} onChange={onChange} onUploadAuthoringMedia={upload} />,
      ),
    );
    expect(container.querySelector('[aria-label="第 1 题题型"]')).not.toBeNull();
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="题目附件"] input[type="file"]',
    )!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['ok'], 'visible.txt', { type: 'text/plain' })],
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(upload).toHaveBeenCalledOnce();
    const saved = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    const savedPage = saved.pages[0]!;
    if (savedPage.sceneType !== 'quiz') throw new Error('Expected quiz');
    expect(savedPage.scene.content.questions[0]!.question_attachments).toEqual([
      expect.objectContaining({ objectKey: 'uploads/visible.txt' }),
    ]);
  });

  it('disables question attachment selection while a slide image upload is still running', async () => {
    let id = 0;
    const initial = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    let finish!: (value: {
      objectKey: string;
      contentType: string;
      digest: string;
      downloadUrl: string;
    }) => void;
    const upload = vi.fn(
      () =>
        new Promise<{
          objectKey: string;
          contentType: string;
          digest: string;
          downloadUrl: string;
        }>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      root.render(<ReachDeckEditor document={initial} onUploadAuthoringMedia={upload} />),
    );
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="插入媒体"] input[type="file"]',
    )!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['image'], 'pending.png', { type: 'image/png' })],
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    const quiz = initial.pages.find((page) => page.sceneType === 'quiz')!;
    act(() =>
      [...container.querySelectorAll<HTMLElement>('[data-page-card]')]
        .find((card) => card.textContent?.includes(quiz.title))!
        .click(),
    );
    const choose = [
      ...container.querySelectorAll<HTMLButtonElement>('[aria-label="题目附件"] button'),
    ].find((button) => button.textContent?.includes('选择附件'))!;
    expect(choose.disabled).toBe(true);
    await act(async () =>
      finish({
        objectKey: 'uploads/pending.png',
        contentType: 'image/png',
        digest: 'digest',
        downloadUrl: 'https://example.test/pending.png',
      }),
    );
    expect(choose.disabled).toBe(false);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('merges an attachment upload into the latest question without losing prompt edits', async () => {
    let id = 0;
    const initial = deleteReachDeckPage(
      addReachDeckPage(createEditorDocument(), {
        afterPageId: 'page-1',
        sceneType: 'quiz',
        idFactory: (prefix) => `${prefix}-${++id}`,
      }),
      'page-1',
    );
    let resolveUpload!: (value: {
      objectKey: string;
      contentType: string;
      digest: string;
      downloadUrl: string;
    }) => void;
    const upload = vi.fn(
      () =>
        new Promise<{
          objectKey: string;
          contentType: string;
          digest: string;
          downloadUrl: string;
        }>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <ReachDeckEditor document={initial} onChange={onChange} onUploadAuthoringMedia={upload} />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="题目附件"] input[type="file"]',
    )!;
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(upload).toHaveBeenCalledOnce();
    const edited = structuredClone(initial);
    const editedPage = edited.pages[0]!;
    if (editedPage.sceneType !== 'quiz') throw new Error('Expected quiz');
    editedPage.scene.content.questions[0]!.question =
      richTextFromPlainText('Edited while uploading');
    await act(async () =>
      root.render(
        <ReachDeckEditor document={edited} onChange={onChange} onUploadAuthoringMedia={upload} />,
      ),
    );
    await act(async () =>
      resolveUpload({
        objectKey: 'uploads/notes.txt',
        contentType: 'text/plain',
        digest: 'digest',
        downloadUrl: 'https://example.test/notes.txt',
      }),
    );
    const saved = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const page = saved.pages[0]!;
    if (page.sceneType !== 'quiz') throw new Error('Expected quiz');
    expect(richTextToPlainText(page.scene.content.questions[0]!.question)).toBe(
      'Edited while uploading',
    );
    expect(page.scene.content.questions[0]!.question_attachments).toEqual([
      expect.objectContaining({ objectKey: 'uploads/notes.txt' }),
    ]);
  });

  it.each(['switch', 'delete'] as const)(
    'announces when the upload target is lost by %s',
    async (operation) => {
      let id = 0;
      const initial = deleteReachDeckPage(
        addReachDeckPage(createEditorDocument(), {
          afterPageId: 'page-1',
          sceneType: 'quiz',
          idFactory: (prefix) => `${prefix}-${++id}`,
        }),
        'page-1',
      );
      let resolveUpload!: (value: {
        objectKey: string;
        contentType: string;
        digest: string;
        downloadUrl: string;
      }) => void;
      const upload = vi.fn(
        () =>
          new Promise<{
            objectKey: string;
            contentType: string;
            digest: string;
            downloadUrl: string;
          }>((resolve) => {
            resolveUpload = resolve;
          }),
      );
      const onChange = vi.fn();
      await act(async () =>
        root.render(
          <ReachDeckEditor
            document={initial}
            onChange={onChange}
            onUploadAuthoringMedia={upload}
          />,
        ),
      );
      const input = container.querySelector<HTMLInputElement>(
        '[aria-label="题目附件"] input[type="file"]',
      )!;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
      });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      if (operation === 'switch') {
        await act(async () =>
          [
            ...container.querySelectorAll<HTMLButtonElement>(
              '.reach-deck-editor__quiz-header-actions button',
            ),
          ]
            .find((button) => button.textContent?.includes('添加题目'))!
            .click(),
        );
      } else {
        const updated = structuredClone(initial);
        const page = updated.pages[0]!;
        if (page.sceneType !== 'quiz') throw new Error('Expected quiz');
        page.scene.content.questions[0]!.id = 'replacement-question';
        await act(async () =>
          root.render(
            <ReachDeckEditor
              document={updated}
              onChange={onChange}
              onUploadAuthoringMedia={upload}
            />,
          ),
        );
      }
      await act(async () =>
        resolveUpload({
          objectKey: 'uploads/notes.txt',
          contentType: 'text/plain',
          digest: 'digest',
          downloadUrl: 'https://example.test/notes.txt',
        }),
      );
      expect(container.textContent).toContain('题目已切换、删除或不可编辑');
      expect(container.querySelector('[aria-label="题目附件"]')?.textContent).not.toContain(
        'notes.txt',
      );
    },
  );

  it('adds a quiz page with direct shared-schema rich-text editing on the canvas', () => {
    const onChange = vi.fn();
    let id = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => prefix + '-' + ++id}
          onChange={onChange}
        />,
      ),
    );

    act(() => openInsertionMenu(container, '在页面 First page 之后插入'));
    act(() => clickMenuItem(container, '新建'));
    act(() => pickNewSceneType(container, '测验'));

    const quizSettings = container.querySelector('[aria-label="测验设置"]');
    expect(quizSettings).not.toBeNull();
    expect(quizSettings?.classList.contains('reach-deck-editor__property-stack')).toBe(true);
    expect(quizSettings?.querySelector('[aria-label="题目"]')).not.toBeNull();
    expect(
      [...container.querySelectorAll('label')].filter((label) =>
        label.textContent?.includes('答错后启用学习围栏'),
      ),
    ).toHaveLength(1);
    expect(container.querySelector('[aria-label="测验编辑画布"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="画布格式"]')).toBeNull();
    const quizCanvas = container.querySelector<HTMLElement>('[aria-label="测验编辑画布"]');
    expect(quizCanvas?.querySelector('h2')).toBeNull();
    const type = container.querySelector<HTMLButtonElement>('[aria-label="第 1 题题型"]');
    expect(type?.tagName).toBe('BUTTON');
    act(() => type?.click());
    expect(container.querySelectorAll('[role="option"]:not([data-page-card])')).toHaveLength(6);
    act(() => type?.click());
    expect(container.querySelector('[aria-label="题干 / 大题材料"]')).not.toBeNull();
    expect(quizCanvas?.querySelector('select[aria-label="字体"]')).toBeNull();
    expect(quizCanvas?.querySelector('select[aria-label="字号"]')).toBeNull();
    expect(
      quizCanvas?.querySelector('.reach-deck-editor__rich-text.is-toolbar-on-focus'),
    ).not.toBeNull();
    expect(
      quizCanvas?.querySelector(
        '.reach-deck-editor__quiz-options > div .reach-deck-editor__rich-text-surface[contenteditable="true"]',
      ),
    ).not.toBeNull();

    const next = onChange.mock.calls.at(-1)?.[0];
    const quiz = next.pages.find((page: { sceneType: string }) => page.sceneType === 'quiz');
    expect(quiz).toMatchObject({ revision: 1, sceneType: 'quiz' });
    expect(quiz.scene.content.questions[0]).toMatchObject({
      question_index: 1,
      question_type: 'single_choice',
      points: 10,
    });
    expect(quiz.scene.content.questions[0].question.type).toBe('doc');

    const headerActions = container.querySelector<HTMLElement>(
      '.reach-deck-editor__quiz-header-actions',
    );
    expect(headerActions?.firstElementChild?.getAttribute('aria-label')).toBe('测验题目翻页');
    act(() => {
      const addQuestion = [...(headerActions?.querySelectorAll('button') ?? [])].find((button) =>
        button.textContent?.includes('添加题目'),
      );
      addQuestion?.click();
    });
    expect(container.querySelectorAll('.reach-deck-editor__quiz-question')).toHaveLength(1);
    expect(container.querySelector('.reach-deck-editor__quiz-pagination')?.textContent).toContain(
      '2 / 2',
    );
    expect(container.querySelector('[aria-label="第 2 题题型"]')).not.toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="上一题"]')?.click());
    expect(container.querySelector('[aria-label="第 1 题题型"]')).not.toBeNull();
    expect(
      [
        ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__quiz-option-value > span'),
      ].map((option) => option.textContent),
    ).toEqual(['A', 'B', 'C', 'D']);

    const answerA = container.querySelector<HTMLInputElement>('[aria-label="设为正确答案 A"]');
    const answerB = container.querySelector<HTMLInputElement>('[aria-label="设为正确答案 B"]');
    expect(answerA?.type).toBe('checkbox');
    expect(container.querySelector('.reach-deck-editor__quiz-options')?.tagName).toBe('FIELDSET');
    act(() => answerA?.click());
    expect(onChange.mock.calls.at(-1)?.[0].pages[1].scene.content.questions[0].answer).toEqual([
      'A',
    ]);
    act(() => answerB?.click());
    expect(onChange.mock.calls.at(-1)?.[0].pages[1].scene.content.questions[0].answer).toEqual([
      'B',
    ]);
    act(() => answerB?.click());
    expect(onChange.mock.calls.at(-1)?.[0].pages[1].scene.content.questions[0]).toMatchObject({
      answer: [],
      has_answer: false,
    });

    act(() => {
      const addOption = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '添加选项',
      );
      addOption?.click();
    });
    expect(
      [
        ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__quiz-option-value > span'),
      ].map((option) => option.textContent),
    ).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('keeps multiple-choice answers independent while using the same compact checkbox control', () => {
    const onChange = vi.fn();
    let id = 0;
    let document = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory: (prefix) => `${prefix}-multiple-${++id}`,
    });
    document = deleteReachDeckPage(document, 'page-1');
    const page = document.pages[0];
    if (page?.sceneType !== 'quiz') throw new Error('Expected a quiz fixture');
    page.scene.content.questions[0]!.question_type = 'multiple_choice';

    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const answerA = container.querySelector<HTMLInputElement>('[aria-label="设为正确答案 A"]');
    const answerB = container.querySelector<HTMLInputElement>('[aria-label="设为正确答案 B"]');

    act(() => answerA?.click());
    act(() => answerB?.click());
    expect(onChange.mock.calls.at(-1)?.[0].pages[0].scene.content.questions[0].answer).toEqual([
      'A',
      'B',
    ]);
    act(() => answerA?.click());
    expect(onChange.mock.calls.at(-1)?.[0].pages[0].scene.content.questions[0].answer).toEqual([
      'B',
    ]);
  });

  it('authors a bounded learning fence and keeps its reference answer enabled', () => {
    const onChange = vi.fn();
    let id = 0;
    let document = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory: (prefix) => prefix + '-fence-' + ++id,
    });
    document = deleteReachDeckPage(document, 'page-1');

    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));

    const quizCanvas = container.querySelector<HTMLElement>('[aria-label="测验编辑画布"]');
    const quizSettings = container.querySelector<HTMLElement>('[aria-label="测验设置"]');
    const fenceToggle = [
      ...(quizSettings?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []),
    ].find((input) => input.parentElement?.textContent?.includes('答错后启用学习围栏'));
    expect(fenceToggle).toBeDefined();
    expect(quizCanvas?.querySelector('input[type="checkbox"]')).not.toBe(fenceToggle);
    act(() => fenceToggle?.click());

    const prompt = quizSettings?.querySelector<HTMLElement>(
      '[aria-label="第 1 题学习围栏判定提示词"]',
    );
    expect(prompt?.textContent).toContain('Only confirm mastery');
    expect(quizCanvas?.querySelector('[aria-label="第 1 题学习围栏判定提示词"]')).toBeNull();
    expect(quizCanvas?.querySelector('.reach-deck-editor__quiz-learning-fence')).toBeNull();
    const answerToggle = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((input) => input.parentElement?.textContent?.includes('包含标准答案'));
    expect(answerToggle?.checked).toBe(true);
    expect(answerToggle?.disabled).toBe(true);

    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const page = next.pages[0];
    if (page?.sceneType !== 'quiz') throw new Error('expected quiz page');
    expect(page.scene.content.questions[0]).toMatchObject({
      has_answer: true,
      learning_fence: {
        enabled: true,
        prompt: expect.stringContaining('Only confirm mastery'),
      },
    });
  });

  it('duplicates the selected page and activates the valid revision-one copy', () => {
    const onChange = vi.fn();
    const onBeforeActivePageChange = vi.fn();
    let id = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => prefix + '-' + ++id}
          onChange={onChange}
          onBeforeActivePageChange={onBeforeActivePageChange}
        />,
      ),
    );

    act(() => openPageMenu(container, 'First page'));
    act(() => clickMenuItem(container, '创建副本'));

    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next.pages).toHaveLength(2);
    expect(next.pages[1]).toMatchObject({ title: 'First page 副本', revision: 1 });
    expect(activePageTitle(container)).toBe('First page 副本');
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(onBeforeActivePageChange).toHaveBeenCalledWith('page-1', next.pages[1].pageId);
    act(() =>
      cards[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete' }),
      ),
    );
    expect(
      (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages.map((page) => page.pageId),
    ).toEqual(['page-1']);
  });

  it('duplicates a multi-page selection as an ordered block after its last source page', () => {
    const document = createTwoPageEditorDocument();
    const second = document.pages[1]!;
    document.pages.push({
      ...structuredClone(second),
      pageId: 'page-3',
      order: 3,
      title: 'Third page',
    });
    if (document.schemaVersion === 'reach-deck-document/v2') {
      document.nativeSlides.push({
        ...document.nativeSlides[1]!,
        pageId: 'page-3',
        slide: { ...document.nativeSlides[1]!.slide, id: 'slide-3', title: 'Third page' },
      });
    }
    const onChange = vi.fn();
    let id = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          idFactory={(prefix) => `${prefix}-${++id}`}
          onChange={onChange}
        />,
      ),
    );
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    act(() => cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => cards[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    act(() => openPageMenu(container, 'First page'));
    act(() => clickMenuItem(container, '创建副本'));

    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(next.pages.map((page) => page.title)).toEqual([
      'First page',
      'Second page',
      'Third page',
      'First page 副本',
      'Third page 副本',
    ]);
    expect(activePageTitle(container)).toBe('First page 副本');
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-page-card]')].map((card) =>
        card.getAttribute('aria-selected'),
      ),
    ).toEqual(['false', 'false', 'false', 'true', 'true']);
  });

  it('selects a newly inserted page so Delete removes that page', () => {
    const onChange = vi.fn();
    const onBeforeActivePageChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onChange={onChange}
          onBeforeActivePageChange={onBeforeActivePageChange}
        />,
      ),
    );
    act(() => openInsertionMenu(container, '在页面 First page 之后插入'));
    act(() => clickMenuItem(container, '新建'));
    act(() => pickNewSceneType(container, '测验'));
    const inserted = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(onBeforeActivePageChange).toHaveBeenCalledWith('page-1', inserted.pages[1]!.pageId);
    act(() =>
      cards[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete' }),
      ),
    );
    expect(
      (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages.map((page) => page.pageId),
    ).toEqual(['page-1']);
  });

  it('undoes and redoes page deletion with its native binding and does not steal input shortcuts', async () => {
    const onChange = vi.fn();
    const onAssistantPrompt = vi.fn().mockResolvedValue({ message: 'No document change.' });
    let id = 0;
    const idFactory = (prefix: string) => `${prefix}-history-${++id}`;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={idFactory}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      ),
    );
    act(() => openPageMenu(container, 'First page'));
    act(() => clickMenuItem(container, '创建副本'));
    const duplicated = structuredClone(onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument);
    const copiedPage = duplicated.pages.find((page) => page.pageId !== 'page-1');
    if (copiedPage === undefined) throw new Error('Expected copied page');
    const copiedBinding = duplicated.nativeSlides.find(
      (binding) => binding.pageId === copiedPage.pageId,
    );
    const copiedElementId = copiedBinding?.slide.elements[0]?.id;
    if (copiedBinding === undefined || copiedElementId === undefined) {
      throw new Error('Expected copied native slide and element');
    }
    act(() =>
      container.querySelector<HTMLElement>(nativeElementSelector(copiedElementId))?.click(),
    );
    expect(container.querySelector(nativeOverlaySelector(copiedElementId))).not.toBeNull();
    act(() => openPageMenu(container, 'First page'));
    act(() => clickMenuItem(container, '删除'));
    const savedEcho = structuredClone(onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument);
    expect(savedEcho.pages).toHaveLength(1);
    act(() =>
      root.render(
        <ReachDeckEditor
          document={savedEcho}
          idFactory={idFactory}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      ),
    );

    const undo = container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')!;
    const redo = container.querySelector<HTMLButtonElement>('[aria-label="重做课件修改"]')!;
    act(() => undo.click());
    const restored = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(restored.pages.map(({ pageId, order }) => ({ pageId, order }))).toEqual(
      duplicated.pages.map(({ pageId, order }) => ({ pageId, order })),
    );
    expect(
      restored.nativeSlides.map(({ pageId, slide }) => ({ pageId, slideId: slide.id })),
    ).toEqual(duplicated.nativeSlides.map(({ pageId, slide }) => ({ pageId, slideId: slide.id })));
    expect(restored.nativeSlides.find((binding) => binding.pageId === 'page-1')?.slide.id).toBe(
      duplicated.nativeSlides.find((binding) => binding.pageId === 'page-1')?.slide.id,
    );
    expect(activePageTitle(container)).toBe(copiedPage.title);
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    if (suggestion === undefined) throw new Error('Expected Decksmith suggestion');
    await act(async () => suggestion.click());
    expect(onAssistantPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pageId: copiedPage.pageId,
        selectedElementIds: [copiedElementId],
      }),
    );
    expect(redo.disabled).toBe(false);

    const input = document.createElement('input');
    container.append(input);
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'z' }),
      ),
    );
    expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(2);

    act(() => redo.click());
    expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(1);
  });

  it('copies a selected native element across pages and undoes the paste as one edit', () => {
    const onChange = vi.fn();
    let sequence = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          idFactory={(prefix) => `${prefix}-element-copy-${++sequence}`}
          onChange={onChange}
        />,
      ),
    );
    const source = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    if (source === null) throw new Error('Expected source element.');
    act(() => source.click());
    const copied = dispatchTestClipboardEvent('copy');
    expect(copied.event.defaultPrevented).toBe(true);
    expect(JSON.parse(copied.values.get(REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME)!)).toMatchObject({
      version: REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION,
      documentId: 'deck-editor',
      element: { id: 'title-1' },
    });
    expect(copied.values.has('application/vnd.reachany.reach-deck-elements-clipboard/v2')).toBe(
      true,
    );
    expect(copied.values.get('text/html')).toContain('data-reach-deck-elements');
    expect(copied.values.get('text/plain')).toBe('First page');
    const secondPage = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages [data-page-card]'),
    ].find((candidate) => candidate.textContent?.includes('Second page'));
    if (secondPage === undefined) throw new Error('Expected second page.');
    act(() => secondPage.click());
    const preview = container.querySelector<HTMLElement>('.reach-deck-editor__preview')!;
    act(() => preview.focus());
    dispatchTestClipboardEvent('paste', {
      'application/vnd.reachany.reach-deck-elements-clipboard/v2': copied.values.get(
        'application/vnd.reachany.reach-deck-elements-clipboard/v2',
      )!,
    });

    const pasted = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const targetSlide = pasted.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide;
    expect(targetSlide.elements).toHaveLength(2);
    const pastedElement = targetSlide.elements.find((element) => element.id !== 'title-1-second')!;
    expect(pastedElement.id).not.toBe('title-1');
    expect(pastedElement.transform).toMatchObject({ x: 80, y: 72 });
    expect(container.querySelector(nativeOverlaySelector(pastedElement.id))).not.toBeNull();

    dispatchTestClipboardEvent('paste', {
      'application/vnd.reachany.reach-deck-elements-clipboard/v2': copied.values.get(
        'application/vnd.reachany.reach-deck-elements-clipboard/v2',
      )!,
    });
    const repeated = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const repeatedElements = repeated.nativeSlides.find((binding) => binding.pageId === 'page-2')!
      .slide.elements;
    expect(repeatedElements).toHaveLength(3);
    expect(repeatedElements.at(-1)!.transform).toMatchObject({ x: 104, y: 96 });

    const firstPage = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages [data-page-card]'),
    ].find((candidate) => candidate.textContent?.includes('First page'));
    if (firstPage === undefined) throw new Error('Expected first page.');
    act(() => firstPage.click());
    expect(activePageTitle(container)).toBe('First page');
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());
    const changeCountBeforeFirstPagePaste = onChange.mock.calls.length;
    const firstPagePasteEvent = dispatchTestClipboardEvent('paste', {
      'application/vnd.reachany.reach-deck-elements-clipboard/v2': copied.values.get(
        'application/vnd.reachany.reach-deck-elements-clipboard/v2',
      )!,
    });
    expect(firstPagePasteEvent.event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(changeCountBeforeFirstPagePaste + 1);
    const firstPagePaste = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(firstPagePaste.nativeSlides[0]!.slide.elements.at(-1)!.transform).toMatchObject({
      x: 104,
      y: 96,
    });

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'z' }),
      ),
    );
    const undone = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(undone.nativeSlides[0]!.slide.elements).toHaveLength(1);
    expect(
      undone.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide.elements,
    ).toHaveLength(3);
  });

  it('pastes a self-contained v2 element into another Deck from the HTML carrier alone', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));
    const source = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    if (source === null) throw new Error('Expected source element.');
    act(() => source.click());
    const copied = dispatchTestClipboardEvent('copy');
    const html = copied.values.get('text/html');
    if (html === undefined) throw new Error('Expected element HTML carrier.');

    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={{ ...createEditorDocument(), id: 'other-deck' }}
          onChange={onChange}
        />,
      ),
    );
    const preview = container.querySelector<HTMLElement>('.reach-deck-editor__preview');
    if (preview === null) throw new Error('Expected target preview.');
    act(() => preview.focus());
    const pasted = dispatchTestClipboardEvent('paste', { 'text/html': html });

    expect(pasted.event.defaultPrevented).toBe(true);
    const changed = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(changed.nativeSlides[0]!.slide.elements).toHaveLength(2);
    expect(changed.nativeSlides[0]!.slide.elements[1]!.id).not.toBe('title-1');
    expect(changed.nativeSlides[0]!.slide.elements[1]!.transform).toMatchObject({ x: 80, y: 72 });
  });

  it('keeps the first paste in place in another editor tab of the same Deck', () => {
    const document = createEditorDocument();
    act(() => root.render(<ReachDeckEditor key="source-tab" document={document} />));
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    const copied = dispatchTestClipboardEvent('copy');
    const payload = copied.values.get('application/vnd.reachany.reach-deck-elements-clipboard/v2');
    if (payload === undefined) throw new Error('Expected Deck clipboard payload.');

    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor key="target-tab" document={document} onChange={onChange} />),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.focus());
    dispatchTestClipboardEvent('paste', {
      'application/vnd.reachany.reach-deck-elements-clipboard/v2': payload,
    });

    const changed = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(changed.nativeSlides[0]!.slide.elements.at(-1)!.transform).toMatchObject({
      x: 80,
      y: 72,
    });
  });

  it('does not turn an invalid Deck HTML carrier into a text frame', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());
    const pasted = dispatchTestClipboardEvent('paste', {
      'text/html': '<span data-reach-deck-elements="{malformed">Fallback text</span>',
      'text/plain': 'Fallback text',
    });
    expect(pasted.event.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('无法粘贴此 Deck 元素');
  });

  it('cuts a selected native element and restores it through one native paste', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    const cut = dispatchTestClipboardEvent('cut');
    expect(cut.event.defaultPrevented).toBe(true);
    expect(cut.values.has('application/vnd.reachany.reach-deck-elements-clipboard/v2')).toBe(true);
    expect(container.querySelector(nativeElementSelector('title-1'))).toBeNull();
    dispatchTestClipboardEvent('paste', Object.fromEntries(cut.values));
    expect(container.querySelector('[data-native-v2-element-id]')).not.toBeNull();
    expect(onChange).toHaveBeenCalledTimes(2);
    const restored = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(restored.nativeSlides[0]!.slide.elements.at(-1)?.transform).toMatchObject({
      x: 80,
      y: 72,
    });
  });

  it('opens a canvas element menu without falling through to the browser menu', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));
    const target = container.querySelector<HTMLElement>(nativeElementSelector('title-1'))!;
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 32,
      clientY: 48,
    });
    act(() => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const menu = container.querySelector<HTMLElement>('.reach-deck-editor__element-menu');
    expect(menu).not.toBeNull();
    expect(
      [...menu!.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
    ).toEqual(expect.arrayContaining(['复制', '剪切', '粘贴', '创建副本', '删除']));
  });

  it('duplicates an element from its context menu as one undoable edit', () => {
    const onChange = vi.fn();
    let sequence = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => `${prefix}-menu-copy-${++sequence}`}
          onChange={onChange}
        />,
      ),
    );
    const target = container.querySelector<HTMLElement>(nativeElementSelector('title-1'))!;
    act(() =>
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    const duplicate = [
      ...container.querySelectorAll<HTMLButtonElement>('.reach-deck-editor__element-menu button'),
    ].find((button) => button.textContent?.includes('创建副本'))!;
    act(() => duplicate.click());
    const changed = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(changed.nativeSlides[0]!.slide.elements).toHaveLength(2);
    expect(changed.nativeSlides[0]!.slide.elements[1]!.transform).toMatchObject({ x: 104, y: 96 });
    expect(container.querySelector('.reach-deck-editor__element-menu')).toBeNull();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'z' }),
      ),
    );
    expect(
      (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).nativeSlides[0]!.slide.elements,
    ).toHaveLength(1);
  });

  it('pastes an HTML-carried Deck element from the context menu', async () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    const source = container.querySelector<HTMLElement>(nativeElementSelector('title-1'))!;
    act(() => source.click());
    const copied = dispatchTestClipboardEvent('copy');
    const html = copied.values.get('text/html')!;
    vi.stubGlobal('navigator', {
      ...navigator,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      clipboard: {
        read: vi.fn().mockResolvedValue([
          {
            types: ['text/html'],
            getType: vi.fn().mockResolvedValue({ text: async () => html }),
          },
        ]),
      },
    });
    act(() =>
      source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    const paste = [
      ...container.querySelectorAll<HTMLButtonElement>('.reach-deck-editor__element-menu button'),
    ].find((button) => button.textContent?.includes('粘贴'))!;
    await act(async () => paste.click());
    expect(
      (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).nativeSlides[0]!.slide.elements,
    ).toHaveLength(2);
  });

  it('targets the containing group when opening a menu from a child element', () => {
    const document = createEditorDocument();
    document.nativeSlides[0]!.slide.elements.push({
      id: 'group-1',
      type: 'group',
      transform: { x: 100, y: 200, width: 200, height: 100 },
      zIndex: 2,
      children: [
        {
          id: 'child-1',
          type: 'shape',
          transform: { x: 100, y: 200, width: 100, height: 50 },
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rect' },
          style: { fill: { kind: 'none' } },
        },
      ],
    });
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const child = container.querySelector<HTMLElement>(nativeElementSelector('child-1'))!;
    act(() =>
      child.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '.reach-deck-editor__element-menu [role="menuitem"]:last-child',
        )!
        .click(),
    );
    expect(
      (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).nativeSlides[0]!.slide.elements.some(
        (element) => element.id === 'group-1',
      ),
    ).toBe(false);
  });

  it.each(['focus', 'contextmenu', 'blank-contextmenu', 'gap-contextmenu'])(
    'isolates page rail %s from stale canvas deletion and clipboard selection',
    (interaction) => {
      const onChange = vi.fn();
      act(() =>
        root.render(
          <ReachDeckEditor document={createTwoPageEditorDocument()} onChange={onChange} />,
        ),
      );
      act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
      expect(container.querySelector(nativeOverlaySelector('title-1'))).not.toBeNull();
      const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'))!;
      act(() => overlay.focus());
      expect(document.activeElement).toBe(overlay);
      const card = container.querySelector<HTMLElement>(
        interaction === 'blank-contextmenu'
          ? '.reach-deck-editor__pages'
          : interaction === 'gap-contextmenu'
            ? '[data-insertion-gap]'
            : '[data-page-card]',
      )!;
      act(() =>
        interaction === 'focus'
          ? card.focus()
          : card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
      );
      expect(document.activeElement).toBe(
        interaction === 'contextmenu'
          ? container.querySelector('.reach-deck-editor__page-menu [role="menuitem"]')
          : card,
      );
      for (const key of ['Delete', 'Backspace']) {
        act(() =>
          document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }),
          ),
        );
      }
      expect(
        dispatchTestClipboardEvent('copy', {}, [], document.activeElement!).event.defaultPrevented,
      ).toBe(false);
      expect(
        dispatchTestClipboardEvent(
          'paste',
          { 'text/plain': 'Do not insert on the canvas' },
          [],
          document.activeElement!,
        ).event.defaultPrevented,
      ).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
      expect(container.querySelector(nativeOverlaySelector('title-1'))).not.toBeNull();
    },
  );

  it('selects page ranges and rejects deleting every page as one operation', () => {
    const onChange = vi.fn();
    const document = createTwoPageEditorDocument();
    const second = document.pages[1]!;
    document.pages.push({
      ...structuredClone(second),
      pageId: 'page-3',
      order: 3,
      title: 'Third page',
    });
    if (document.schemaVersion === 'reach-deck-document/v2') {
      document.nativeSlides.push({
        ...document.nativeSlides[1]!,
        pageId: 'page-3',
        slide: {
          ...document.nativeSlides[1]!.slide,
          id: 'slide-3',
          title: 'Third page',
          elements: [],
          animations: [],
        },
      });
    }
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    act(() => cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => cards[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual([
      'true',
      'true',
      'true',
    ]);
    act(() =>
      cards[2]!.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete' }),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('请至少保留一页');
  });

  it('exposes selected pages as options in a multi-select listbox', () => {
    act(() => root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} />));
    const list = container.querySelector<HTMLOListElement>('.reach-deck-editor__pages ol')!;
    const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
    ]);
    expect(list.querySelector('[data-insertion-gap]')?.closest('[role="option"]')).toBeNull();

    act(() => options[0]!.click());
    act(() =>
      options[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })),
    );
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'true']);
  });

  it('toggles page selections and never partially removes an all-page selection', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} onChange={onChange} />),
    );
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    act(() => cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual(['true', 'true']);
    act(() =>
      cards[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete' }),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
    const finalCard = container.querySelectorAll<HTMLElement>('[data-page-card]')[0]!;
    act(() =>
      finalCard.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Backspace' }),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores a noncontiguous page selection and its anchor after undoing batch deletion', () => {
    const document = createTwoPageEditorDocument();
    const second = document.pages[1]!;
    document.pages.push({
      ...structuredClone(second),
      pageId: 'page-3',
      order: 3,
      title: 'Third page',
    });
    if (document.schemaVersion === 'reach-deck-document/v2') {
      document.nativeSlides.push({
        ...document.nativeSlides[1]!,
        pageId: 'page-3',
        slide: { ...document.nativeSlides[1]!.slide, id: 'slide-3', title: 'Third page' },
      });
    }
    act(() => root.render(<ReachDeckEditor document={document} onChange={vi.fn()} />));
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    act(() => cards[0]!.click());
    act(() => cards[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'true',
    ]);
    act(() =>
      cards[2]!.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete' }),
      ),
    );
    expect(container.querySelectorAll('[data-page-card]')).toHaveLength(1);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')!.click());
    const restored = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    expect(restored.map((card) => card.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'true',
    ]);
    act(() =>
      restored[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })),
    );
    expect(restored.map((card) => card.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'true',
    ]);
  });

  it('does not batch-delete a selection containing a locked page', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          lockedPageIds={['page-2']}
          onChange={onChange}
        />,
      ),
    );
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    act(() => cards[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    act(() =>
      cards[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete' }),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marquee-selects cards from the page rail background', () => {
    const document = createTwoPageEditorDocument();
    const second = document.pages[1]!;
    document.pages.push({
      ...structuredClone(second),
      pageId: 'page-3',
      order: 3,
      title: 'Third page',
    });
    if (document.schemaVersion === 'reach-deck-document/v2') {
      document.nativeSlides.push({
        ...document.nativeSlides[1]!,
        pageId: 'page-3',
        slide: { ...document.nativeSlides[1]!.slide, id: 'slide-3', title: 'Third page' },
      });
    }
    act(() => root.render(<ReachDeckEditor document={document} />));
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = cards.indexOf(this);
      return index < 0 ? new DOMRect() : new DOMRect(10, 10 + index * 90, 100, 70);
    });
    const list = container.querySelector<HTMLOListElement>('.reach-deck-editor__pages ol')!;
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      list.dispatchEvent(event);
    };
    act(() => pointer('pointerdown', 0, 0));
    act(() => pointer('pointermove', 120, 170));
    act(() => pointer('pointerup', 120, 170));
    expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual([
      'true',
      'true',
      'false',
    ]);
  });

  it.each(['page', 'structure'])(
    'disables page menu mutations and shows the reason for a %s lock',
    (kind) => {
      const onChange = vi.fn();
      act(() =>
        root.render(
          <ReachDeckEditor
            document={createTwoPageEditorDocument()}
            onChange={onChange}
            lockedPageIds={kind === 'page' ? ['page-1'] : []}
            structureLocked={kind === 'structure'}
            lockedPageReason="Generating page"
          />,
        ),
      );
      act(() => openPageMenu(container, 'First page'));
      const actions = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      expect(actions).toHaveLength(2);
      for (const action of actions) {
        expect(action.disabled).toBe(true);
        expect(action.title).toBe('Generating page');
        act(() => action.click());
      }
      expect(onChange).not.toHaveBeenCalled();
      expect(activePageTitle(container)).toBe('First page');
    },
  );

  it('deletes the selected native element with Delete/Backspace and keeps it undoable', () => {
    const onChange = vi.fn();
    const editorDocument = createEditorDocument();
    const binding = editorDocument.nativeSlides[0]!;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={{
            ...editorDocument,
            nativeSlides: [
              {
                ...binding,
                slide: {
                  ...binding.slide,
                  animations: [
                    {
                      id: 'anim-title',
                      targetId: 'title-1',
                      trigger: 'on-enter',
                      effect: 'fade',
                      start: 0,
                      duration: 0.5,
                    },
                  ],
                },
              },
            ],
          }}
          onChange={onChange}
        />,
      ),
    );
    const pressDelete = (key: 'Delete' | 'Backspace', target: EventTarget = window) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    };

    // 没有选中任何元素时不接管按键（Backspace 交给浏览器）。
    expect(pressDelete('Backspace').defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    // 焦点在输入控件里时同样不接管。
    const input = document.createElement('input');
    container.append(input);
    expect(pressDelete('Delete', input).defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    input.remove();

    const preview = container.querySelector<HTMLElement>('.reach-deck-editor__preview')!;
    act(() => preview.focus());
    expect(document.activeElement).toBe(preview);
    expect(pressDelete('Delete').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
    const deleted = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const slide = deleted.nativeSlides[0]!.slide;
    expect(slide.elements.some((element) => element.id === 'title-1')).toBe(false);
    expect(slide.animations).toEqual([]);
    expect(container.querySelector(nativeOverlaySelector('title-1'))).toBeNull();

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'z' }),
      ),
    );
    const undone = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(undone.nativeSlides[0]!.slide.elements.some((element) => element.id === 'title-1')).toBe(
      true,
    );
    expect(undone.nativeSlides[0]!.slide.animations).toHaveLength(1);
  });

  it('ignores a closed host popover dialog when guarding delete and clipboard shortcuts', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onChange={onChange}
          workspaceCanvasAction={
            // 宿主批次弹层：常驻 DOM、关闭时也带 role=dialog。
            <div popover="auto" role="dialog">
              batch progress
            </div>
          }
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    const copied = dispatchTestClipboardEvent('copy');
    expect(copied.event.defaultPrevented).toBe(true);

    const deleteKey = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Delete',
    });
    act(() => {
      window.dispatchEvent(deleteKey);
    });
    expect(deleteKey.defaultPrevented).toBe(true);
    expect(
      (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).nativeSlides[0]!.slide.elements,
    ).toHaveLength(0);
  });

  it('uses plain text when writing the Deck MIME throws', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());

    const copied = dispatchTestClipboardEvent('copy', {}, [], window, [
      REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
    ]);

    expect(copied.event.defaultPrevented).toBe(true);
    expect(copied.values.has(REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME)).toBe(false);
    expect(copied.values.get('text/plain')).toBe('First page');
  });

  it('uses plain text when the browser silently ignores the Deck MIME', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());

    const copied = dispatchTestClipboardEvent(
      'copy',
      {},
      [],
      window,
      [],
      [
        REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
        'application/vnd.reachany.reach-deck-elements-clipboard/v2',
      ],
    );

    expect(copied.event.defaultPrevented).toBe(true);
    expect(copied.values.has(REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME)).toBe(false);
    expect(copied.values.get('text/plain')).toBe('First page');
  });

  it('keeps the Deck copy when its plain-text fallback cannot be written', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());

    const copied = dispatchTestClipboardEvent('copy', {}, [], window, ['text/plain']);

    expect(copied.event.defaultPrevented).toBe(true);
    expect(copied.values.has(REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME)).toBe(true);
    expect(copied.values.has('text/plain')).toBe(false);
  });

  it('leaves a non-text copy to the browser when custom MIME is silently ignored', () => {
    const onChange = vi.fn();
    const editorDocument = createEditorDocument();
    if (editorDocument.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected a v2 editor fixture.');
    }
    editorDocument.nativeSlides[0]!.slide.elements.push({
      id: 'plainless-shape',
      type: 'shape',
      transform: { x: 100, y: 240, width: 240, height: 120 },
      zIndex: 2,
      geometry: { kind: 'preset', preset: 'rect' },
      style: { fill: { kind: 'none' } },
    });
    act(() => root.render(<ReachDeckEditor document={editorDocument} onChange={onChange} />));
    act(() =>
      container.querySelector<HTMLElement>(nativeElementSelector('plainless-shape'))?.click(),
    );

    const copied = dispatchTestClipboardEvent(
      'copy',
      {},
      [],
      window,
      [],
      [
        REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
        'application/vnd.reachany.reach-deck-elements-clipboard/v2',
      ],
    );

    expect(copied.clipboardData.setData).toHaveBeenCalledWith(
      REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
      expect.any(String),
    );
    expect(copied.event.defaultPrevented).toBe(false);
    expect(copied.values.size).toBe(0);
  });

  it('edits one merged table cell through the native text editor and preserves structure, narration and undo', async () => {
    const document = createEditorDocument();
    const slide = document.nativeSlides[0]!.slide;
    const source = slide.elements[0]!;
    if (source.type !== 'textFrame') throw new Error('fixture');
    slide.elements = [
      {
        id: 'table-1',
        type: 'table',
        transform: source.transform,
        zIndex: 1,
        columnWidths: [550, 550],
        rowHeights: [60, 60],
        rows: [
          {
            id: 'r1',
            cells: [
              {
                id: 'header',
                header: true,
                rowSpan: 1,
                columnSpan: 2,
                text: { ...source.text, doc: richTextFromPlainText('分类') },
                style: {},
              },
            ],
          },
          {
            id: 'r2',
            cells: [
              {
                id: 'left',
                rowSpan: 1,
                columnSpan: 1,
                text: { ...source.text, doc: richTextFromPlainText('左格') },
                style: {},
              },
              {
                id: 'right',
                rowSpan: 1,
                columnSpan: 1,
                text: { ...source.text, doc: richTextFromPlainText('右格') },
                style: {},
              },
            ],
          },
        ],
      },
    ];
    slide.narration = { segments: [{ text: '旧讲稿', start: 0, end: 2 }] };
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const cell = container.querySelector<HTMLElement>(
      '.reach-deck-editor__preview [data-native-v2-table-cell="left"]',
    )!;
    act(() => cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const input = container.querySelector<HTMLElement>(
      '[data-native-v2-table-cell="left"] .ProseMirror',
    )!;
    expect(input).not.toBeNull();
    expect(container.querySelector('[data-native-v2-table-cell="right"] .ProseMirror')).toBeNull();
    await act(async () => {
      dispatchTestClipboardEvent(
        'paste',
        { 'text/plain': '新增知识', 'text/html': '<p>新增知识</p>' },
        [],
        input,
      );
    });
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          ctrlKey: true,
          key: 'Enter',
          isComposing: true,
        }),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Enter' }),
      ),
    );
    const updated = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    const updatedSlide = updated.nativeSlides[0]!.slide;
    const table = updatedSlide.elements[0]!;
    if (table.type !== 'table') throw new Error('table');
    expect(richTextToPlainText(table.rows[1]!.cells[0]!.text.doc)).toContain('新增知识');
    const originalTable = slide.elements[0]!;
    if (originalTable.type !== 'table') throw new Error('fixture table');
    expect(table.rows[0]).toEqual(originalTable.rows[0]);
    expect(richTextToPlainText(table.rows[1]!.cells[1]!.text.doc)).toBe('右格');
    expect(table.rows[1]!.cells[0]!.id).toBe('left');
    expect(updatedSlide.narration?.segments).toEqual(slide.narration.segments);
    expect(isNativeSlideNarrationContentStale(updatedSlide)).toBe(true);
    act(() =>
      container.querySelector<HTMLButtonElement>('#reach-deck-right-tab-narration')!.click(),
    );
    expect(container.textContent).toContain('页面文字已变化，讲稿可能已过期');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')!.click());
    const undone = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    expect(undone.nativeSlides[0]!.slide.elements).toEqual(slide.elements);
    expect(isNativeSlideNarrationContentStale(undone.nativeSlides[0]!.slide)).toBe(false);
  });

  it('leaves copy, paste, and undo to inputs, ProseMirror, and IME composition', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    const source = container.querySelector<HTMLElement>(nativeElementSelector('title-1'))!;
    act(() => source.click());
    const input = window.document.createElement('input');
    container.append(input);
    const inputCopy = dispatchTestClipboardEvent('copy', {}, [], input);
    const inputPaste = dispatchTestClipboardEvent(
      'paste',
      { 'text/plain': 'Input text' },
      [],
      input,
    );
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: 'z',
        }),
      ),
    );
    const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'))!;
    act(() => overlay.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const proseMirror = container.querySelector<HTMLElement>('.ProseMirror')!;
    const proseMirrorCopy = dispatchTestClipboardEvent('copy', {}, [], proseMirror);
    const proseMirrorPaste = dispatchTestClipboardEvent(
      'paste',
      { 'text/html': '<p>Editor text</p>', 'text/plain': 'Editor text' },
      [],
      proseMirror,
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.focus());
    act(() => window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    const composingPaste = dispatchTestClipboardEvent('paste', { 'text/plain': 'Composing' });
    act(() => window.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    expect(inputCopy.event.defaultPrevented).toBe(false);
    expect(inputPaste.event.defaultPrevented).toBe(false);
    expect(proseMirrorCopy.event.defaultPrevented).toBe(false);
    expect(proseMirrorPaste.clipboardData.getData).toHaveBeenCalled();
    expect(composingPaste.event.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves copy to the browser when a non-collapsed text selection exists', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    const selectable = window.document.createElement('span');
    selectable.textContent = 'Selected browser text';
    container.append(selectable);
    const range = window.document.createRange();
    range.selectNodeContents(selectable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const copyEvent = dispatchTestClipboardEvent('copy');
    expect(copyEvent.event.defaultPrevented).toBe(false);
    selection?.removeAllRanges();
    const copyKey = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'c',
    });
    const pasteKey = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'v',
    });
    act(() => {
      window.dispatchEvent(copyKey);
      window.dispatchEvent(pasteKey);
    });
    expect(copyKey.defaultPrevented).toBe(false);
    expect(pasteKey.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('handles document clipboard shortcuts only in the most recently active editor', () => {
    const secondContainer = window.document.createElement('div');
    window.document.body.append(secondContainer);
    const secondRoot = createRoot(secondContainer);
    const firstChange = vi.fn();
    const secondChange = vi.fn();
    const secondDocument = { ...createEditorDocument(), id: 'deck-editor-second' };
    act(() => {
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={firstChange} />);
      secondRoot.render(<ReachDeckEditor document={secondDocument} onChange={secondChange} />);
    });
    const firstElement = container.querySelector<HTMLElement>(nativeElementSelector('title-1'))!;
    act(() => firstElement.click());
    const firstCopy = dispatchTestClipboardEvent('copy');
    dispatchTestClipboardEvent('paste', {
      [REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME]: firstCopy.values.get(
        REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
      )!,
    });
    expect(firstChange).toHaveBeenCalledTimes(1);
    expect(secondChange).not.toHaveBeenCalled();

    const secondElement = secondContainer.querySelector<HTMLElement>(
      nativeElementSelector('title-1'),
    )!;
    act(() => secondElement.click());
    const secondCopy = dispatchTestClipboardEvent('copy');
    dispatchTestClipboardEvent('paste', {
      [REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME]: secondCopy.values.get(
        REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME,
      )!,
    });
    expect(firstChange).toHaveBeenCalledTimes(1);
    expect(secondChange).toHaveBeenCalledTimes(1);
    act(() => secondRoot.unmount());
    secondContainer.remove();
  });

  it('rejects an invalid Deck MIME rather than silently inserting external HTML', () => {
    const onChange = vi.fn();
    const onUploadAuthoringMedia = vi.fn();
    let sequence = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => `${prefix}-html-paste-${++sequence}`}
          onChange={onChange}
          onUploadAuthoringMedia={onUploadAuthoringMedia}
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    expect(dispatchTestClipboardEvent('copy').event.defaultPrevented).toBe(true);

    const image = new File(['image'], 'preview.png', {
      type: 'image/png',
      lastModified: 101,
    });
    const pasted = dispatchTestClipboardEvent(
      'paste',
      {
        [REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME]: JSON.stringify({
          version: 'reach-deck-element-clipboard/unknown',
        }),
        'text/html':
          '<p style="text-align: center"><strong>Word heading</strong><br>Second line</p>',
        'text/plain': 'Plain fallback',
      },
      [image],
    );

    expect(pasted.event.defaultPrevented).toBe(true);
    expect(onUploadAuthoringMedia).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('无法粘贴此 Deck 元素');
  });

  it('rejects a stale Deck media payload without inserting fallback HTML', () => {
    const onChange = vi.fn();
    let sequence = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => `${prefix}-stale-media-${++sequence}`}
          onChange={onChange}
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());
    const stalePayload = JSON.stringify({
      animations: [],
      documentId: 'deck-editor',
      element: {
        id: 'stale-image',
        type: 'image',
        transform: { x: 0, y: 0, width: 320, height: 180 },
        zIndex: 1,
        resourceId: 'missing-media',
        fit: 'contain',
        alt: 'Stale image',
      },
      version: REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION,
    });

    expect(() =>
      dispatchTestClipboardEvent('paste', {
        [REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MIME]: stalePayload,
        'text/html': '<p><strong>Current external text</strong></p>',
        'text/plain': 'Plain fallback',
      }),
    ).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('无法粘贴此 Deck 元素');
  });

  it.each([
    ['PNG', 'image/png', 'png'],
    ['JPEG', 'image/jpeg', 'jpg'],
    ['WebP', 'image/webp', 'webp'],
    ['GIF', 'image/gif', 'gif'],
  ] as const)(
    'falls through image-only HTML to a normalized %s clipboard image upload',
    async (_label, contentType, extension) => {
      const onChange = vi.fn();
      let resolveUpload!: (value: {
        objectKey: string;
        contentType: string;
        digest: string;
        downloadUrl: string;
      }) => void;
      const onUploadAuthoringMedia = vi.fn(
        (_input: {
          file: File;
          kind: 'image' | 'audio' | 'video' | 'attachment';
          signal: AbortSignal;
        }) =>
          new Promise<{
            objectKey: string;
            contentType: string;
            digest: string;
            downloadUrl: string;
          }>((resolve) => {
            resolveUpload = resolve;
          }),
      );
      act(() =>
        root.render(
          <ReachDeckEditor
            document={createEditorDocument()}
            onChange={onChange}
            onUploadAuthoringMedia={onUploadAuthoringMedia}
          />,
        ),
      );
      act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());
      const image = new File(['image'], '', { type: contentType, lastModified: 123 });
      const pasted = dispatchTestClipboardEvent(
        'paste',
        {
          'text/html': '<p><img src="https://example.invalid/untrusted.png"></p>',
          'text/plain': 'Image fallback text',
        },
        [image],
      );
      expect(pasted.event.defaultPrevented).toBe(true);
      expect(onUploadAuthoringMedia).toHaveBeenCalledTimes(1);
      const uploadedFile = onUploadAuthoringMedia.mock.calls[0]![0].file;
      expect(uploadedFile).toMatchObject({
        name: `clipboard-image-123.${extension}`,
        type: contentType,
      });
      expect(onChange).not.toHaveBeenCalled();

      await act(async () => {
        resolveUpload({
          objectKey: `uploads/deck/image/clipboard.${extension}`,
          contentType,
          digest: `sha256:${'d'.repeat(64)}`,
          downloadUrl: `https://signed.example/clipboard.${extension}`,
        });
        await Promise.resolve();
      });
      expect(onChange).toHaveBeenCalledTimes(1);
      const inserted = (
        onChange.mock.calls[0]![0] as ReachDeckDocument
      ).nativeSlides[0]!.slide.elements.at(-1);
      expect(inserted).toMatchObject({ type: 'image', transform: { x: 320, y: 180 } });
    },
  );

  it('pastes Word formulas, flattened tables, and image alt text as one undoable text frame', () => {
    const onChange = vi.fn();
    const onUploadAuthoringMedia = vi.fn();
    let sequence = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => `${prefix}-office-paste-${++sequence}`}
          onChange={onChange}
          onUploadAuthoringMedia={onUploadAuthoringMedia}
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());

    const pasted = dispatchTestClipboardEvent(
      'paste',
      {
        'text/html': OFFICE_CLIPBOARD_HTML,
        'text/plain': 'Plain fallback',
      },
      [new File(['image'], 'inline.png', { type: 'image/png', lastModified: 321 })],
    );

    expect(pasted.event.defaultPrevented).toBe(true);
    // 有可渲染正文时不回落到 File 分支，也只形成一次 commit。
    expect(onUploadAuthoringMedia).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    const inserted = (
      onChange.mock.calls[0]![0] as ReachDeckDocument
    ).nativeSlides[0]!.slide.elements.at(-1);
    if (inserted?.type !== 'textFrame') throw new Error('Expected pasted rich text frame.');
    const text = richTextToPlainText(inserted.text.doc);
    const serialized = JSON.stringify(inserted.text.doc);

    expect(serialized).toContain('"type":"inlineMath"');
    expect(serialized).toContain('\\frac{a}{b}');
    // 表格按行展平成段落，cell 之间使用不折叠空格；幻灯片 schema 不接收 table 节点。
    expect(serialized).not.toContain('"type":"table"');
    expect(text).toContain(`A1${'\u00a0\u00a0'}B1`);
    expect(text).toContain(`A2${'\u00a0\u00a0'}B2`);
    // 图片只留非空 alt，不留来源，也不产生持久图片节点。
    expect(text).toContain('示意图');
    expect(serialized).not.toContain('"type":"image"');
    expect(serialized).not.toContain('diagram.png');
    expect(serialized).not.toContain('Plain fallback');
    // 受信解析只接受共享转换器产出的 latex：同一份 HTML 里伪造的私有公式标记
    // 只能降级成可见文本，它携带的排版 data 属性一个都进不来（插入后统一套用的
    // 是 Deck 自己的主题排版，不是剪贴板里的值）。
    expect(text).toContain('伪造公式');
    expect(serialized).not.toContain('forged');
    expect(serialized).not.toContain('Forged');
    expect(serialized).not.toContain('999999');

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'z' }),
      ),
    );
    const undone = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    expect(undone.nativeSlides[0]!.slide.elements.at(-1)?.id).not.toBe(inserted.id);
  });

  it('falls back to the single-image upload when Office HTML carries no renderable body', async () => {
    const onChange = vi.fn();
    const onUploadAuthoringMedia = vi.fn().mockResolvedValue({
      objectKey: 'uploads/deck/image/word.png',
      contentType: 'image/png',
      digest: `sha256:${'f'.repeat(64)}`,
      downloadUrl: 'https://signed.example/word.png',
    });
    await act(async () => {
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onChange={onChange}
          onUploadAuthoringMedia={onUploadAuthoringMedia}
        />,
      );
    });
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());

    // Word 复制单张图片：HTML 带 Office 签名，但去掉图片后没有任何可渲染正文。
    const pasted = dispatchTestClipboardEvent(
      'paste',
      {
        'text/html':
          '<html xmlns:o="urn:schemas-microsoft-com:office:office">' +
          '<meta name=Generator content="Microsoft Word 15">' +
          '<body><p class=MsoNormal><img src="file:///C:/Users/teacher/pasted.png"></p></body></html>',
      },
      [new File(['image'], '', { type: 'image/png', lastModified: 123 })],
    );

    expect(pasted.event.defaultPrevented).toBe(true);
    expect(onUploadAuthoringMedia).toHaveBeenCalledTimes(1);
    expect(onUploadAuthoringMedia.mock.calls[0]![0].file).toMatchObject({
      name: 'clipboard-image-123.png',
      type: 'image/png',
    });
    await act(async () => Promise.resolve());
    const inserted = (
      onChange.mock.calls.at(-1)![0] as ReachDeckDocument
    ).nativeSlides[0]!.slide.elements.at(-1);
    expect(inserted).toMatchObject({ type: 'image' });
  });

  it.each([
    [
      'oversized',
      '<meta name=Generator content="Microsoft Word 15"><p>' +
        'x'.repeat(REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS) +
        '</p>',
    ],
    [
      'over-budget',
      '<meta name=Generator content="Microsoft Word 15">' +
        '<p>x</p>'.repeat(REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS + 1),
    ],
  ] as const)(
    'falls back to the clipboard image when %s Office HTML is rejected',
    async (_label, html) => {
      const onChange = vi.fn();
      const onUploadAuthoringMedia = vi.fn().mockResolvedValue({
        objectKey: 'uploads/deck/image/word-fallback.png',
        contentType: 'image/png',
        digest: `sha256:${'a'.repeat(64)}`,
        downloadUrl: 'https://signed.example/word-fallback.png',
      });
      await act(async () => {
        root.render(
          <ReachDeckEditor
            document={createEditorDocument()}
            onChange={onChange}
            onUploadAuthoringMedia={onUploadAuthoringMedia}
          />,
        );
      });
      act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());

      const pasted = dispatchTestClipboardEvent(
        'paste',
        { 'text/html': html, 'text/plain': 'Do not use unsafe fallback' },
        [new File(['image'], '', { type: 'image/png', lastModified: 456 })],
      );

      expect(pasted.event.defaultPrevented).toBe(true);
      expect(onUploadAuthoringMedia).toHaveBeenCalledTimes(1);
      expect(onUploadAuthoringMedia.mock.calls[0]![0].file).toMatchObject({
        name: 'clipboard-image-456.png',
        type: 'image/png',
      });
      await act(async () => Promise.resolve());
      const inserted = (
        onChange.mock.calls.at(-1)![0] as ReachDeckDocument
      ).nativeSlides[0]!.slide.elements.at(-1);
      expect(inserted).toMatchObject({ type: 'image' });
    },
  );

  it('offsets repeated clipboard images when their transient lastModified values differ', async () => {
    const onChange = vi.fn();
    let sequence = 0;
    const onUploadAuthoringMedia = vi.fn().mockResolvedValue({
      objectKey: 'uploads/deck/image/repeated.png',
      contentType: 'image/png',
      digest: `sha256:${'e'.repeat(64)}`,
      downloadUrl: 'https://signed.example/repeated.png',
    });
    await act(async () => {
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => `${prefix}-repeated-image-${++sequence}`}
          onChange={onChange}
          onUploadAuthoringMedia={onUploadAuthoringMedia}
        />,
      );
    });
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());

    dispatchTestClipboardEvent('paste', { 'text/html': '<img src="file:///tmp/repeated.png">' }, [
      new File(['same'], '', { type: 'image/png', lastModified: 101 }),
    ]);
    await act(async () => Promise.resolve());
    dispatchTestClipboardEvent('paste', { 'text/html': '<img src="file:///tmp/repeated.png">' }, [
      new File(['same'], '', { type: 'image/png', lastModified: 202 }),
    ]);
    await act(async () => Promise.resolve());

    expect(onUploadAuthoringMedia).toHaveBeenCalledTimes(2);
    const changed = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    expect(
      changed.nativeSlides[0]!.slide.elements.slice(-2).map((element) => element.transform),
    ).toMatchObject([
      { x: 320, y: 180 },
      { x: 344, y: 204 },
    ]);
  });

  it.each([
    ['empty', 0],
    ['oversized', 15 * 1024 * 1024 + 1],
  ])('rejects %s clipboard images without falling through to text', (_label, size) => {
    const onChange = vi.fn();
    const onUploadAuthoringMedia = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onChange={onChange}
          onUploadAuthoringMedia={onUploadAuthoringMedia}
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());
    const image = new File(size === 0 ? [] : ['image'], 'clipboard.png', { type: 'image/png' });
    if (size > 0) Object.defineProperty(image, 'size', { configurable: true, value: size });
    const pasted = dispatchTestClipboardEvent(
      'paste',
      { 'text/html': '<img src="file:///tmp/image.png">', 'text/plain': 'Do not insert' },
      [image],
    );
    expect(pasted.event.defaultPrevented).toBe(true);
    expect(onUploadAuthoringMedia).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preserves plain-text newlines and offsets repeated paste as separate undoable edits', () => {
    const onChange = vi.fn();
    let sequence = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          idFactory={(prefix) => `${prefix}-plain-paste-${++sequence}`}
          onChange={onChange}
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());
    const payload = {
      'text/plain': 'First line\nSecond line',
    };
    dispatchTestClipboardEvent('paste', payload);
    dispatchTestClipboardEvent('paste', payload);

    expect(onChange).toHaveBeenCalledTimes(2);
    const changed = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    const pasted = changed.nativeSlides[0]!.slide.elements.slice(-2);
    expect(pasted.map((element) => element.transform)).toMatchObject([
      { x: 560, y: 390, width: 480, height: 120 },
      { x: 584, y: 414, width: 480, height: 120 },
    ]);
    for (const element of pasted) {
      if (element.type !== 'textFrame') throw new Error('Expected pasted plain text frame.');
      expect(richTextToPlainText(element.text.doc)).toBe('First line\nSecond line');
    }

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'z' }),
      ),
    );
    expect(
      (onChange.mock.calls.at(-1)![0] as ReachDeckDocument).nativeSlides[0]!.slide.elements,
    ).toHaveLength(2);
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'y' }),
      ),
    );
    expect(
      (onChange.mock.calls.at(-1)![0] as ReachDeckDocument).nativeSlides[0]!.slide.elements,
    ).toHaveLength(3);
  });

  it.each([
    ['plain text', {}, '\n'.repeat(REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS)],
    [
      'HTML plain-text fallback',
      { 'text/html': '<img src="https://invalid.example/image.png">' },
      'x'.repeat(REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS + 1),
    ],
  ] as const)('rejects over-budget %s without modifying the deck', (_label, html, plainText) => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());

    const pasted = dispatchTestClipboardEvent('paste', { ...html, 'text/plain': plainText });

    expect(pasted.event.defaultPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not paste into structure-locked native slides', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onChange={onChange} structureLocked />,
      ),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());
    const pasted = dispatchTestClipboardEvent('paste', { 'text/plain': 'Blocked' });
    expect(pasted.event.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', { disabled: true, lockedPageIds: undefined }],
    ['page-locked', { disabled: false, lockedPageIds: ['page-1'] }],
  ] as const)('does not paste while the editor is %s', (_label, state) => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          disabled={state.disabled}
          document={createEditorDocument()}
          lockedPageIds={state.lockedPageIds}
          onChange={onChange}
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>('.reach-deck-editor')?.click());
    const pasted = dispatchTestClipboardEvent('paste', { 'text/plain': 'Blocked' });
    expect(pasted.event.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not paste while page generation is pending or the active page is not a slide', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onChange={onChange}
          onGeneratePage={() => new Promise<undefined>(() => {})}
        />,
      );
    });
    const generate = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '生成当前页',
    );
    if (generate === undefined) throw new Error('Expected generate action.');
    act(() => generate.click());
    expect(
      dispatchTestClipboardEvent('paste', { 'text/plain': 'Busy' }).event.defaultPrevented,
    ).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    let sequence = 0;
    const withQuiz = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory: (prefix) => `${prefix}-non-slide-${++sequence}`,
    });
    await act(async () => {
      root.render(<ReachDeckEditor document={withQuiz} key="non-slide" onChange={onChange} />);
    });
    const quizPage = [...container.querySelectorAll<HTMLElement>('[data-page-card]')].find(
      (candidate) => candidate.textContent?.includes('新测验'),
    );
    if (quizPage === undefined) throw new Error('Expected quiz page.');
    act(() => quizPage.click());
    expect(
      dispatchTestClipboardEvent('paste', { 'text/plain': 'Non-slide' }).event.defaultPrevented,
    ).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['textarea', 'select', 'dialog'] as const)(
    'leaves clipboard events targeted at %s controls untouched',
    (kind) => {
      const onChange = vi.fn();
      act(() =>
        root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
      );
      act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
      const target =
        kind === 'textarea'
          ? document.createElement('textarea')
          : kind === 'select'
            ? document.createElement('select')
            : document.createElement('div');
      if (kind === 'dialog') target.setAttribute('role', 'dialog');
      container.append(target);
      const copied = dispatchTestClipboardEvent('copy', {}, [], target);
      const pasted = dispatchTestClipboardEvent(
        'paste',
        { 'text/plain': 'Browser-owned' },
        [],
        target,
      );
      expect(copied.event.defaultPrevented).toBe(false);
      expect(pasted.event.defaultPrevented).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it('records a quiz color drag as one transaction without evicting page-deletion undo', async () => {
    const onChange = vi.fn();
    let id = 0;
    const idFactory = (prefix: string) => `${prefix}-quiz-history-${++id}`;
    let editorDocument = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory,
    });
    const quizPage = editorDocument.pages.find((page) => page.sceneType === 'quiz');
    if (quizPage === undefined) throw new Error('Expected a quiz page');
    quizPage.scene.content.questions[0]!.question = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Color this prompt' }] }],
    };

    await act(async () => {
      root.render(
        <ReachDeckEditor document={editorDocument} idFactory={idFactory} onChange={onChange} />,
      );
      await Promise.resolve();
    });
    const quizPageCard = [...container.querySelectorAll<HTMLElement>('[data-page-card]')].find(
      (card) => card.textContent?.includes(quizPage.title),
    );
    act(() => quizPageCard?.click());
    act(() => openPageMenu(container, 'First page'));
    act(() => clickMenuItem(container, '删除'));
    editorDocument = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(editorDocument.pages).toHaveLength(1);

    const promptSurface = container.querySelector<HTMLElement>('[aria-label="题干 / 大题材料"]');
    const promptField = promptSurface?.closest('.reach-deck-editor__quiz-rich-field');
    const colorInput = promptField?.querySelector<HTMLInputElement>('input[aria-label="文字颜色"]');
    if (colorInput === null || colorInput === undefined) {
      throw new Error('Expected the quiz prompt color input');
    }
    const promptText = promptSurface?.querySelector('p')?.firstChild;
    if (!(promptText instanceof Text)) throw new Error('Expected quiz prompt text');
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(promptText, 0);
    range.setEnd(promptText, promptText.textContent?.length ?? 0);
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => {
      colorInput.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      for (const color of ['#112233', '#223344', '#334455']) {
        setNativeValue(colorInput, color);
        colorInput.dispatchEvent(new Event('input', { bubbles: true }));
        colorInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      colorInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    const undo = container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')!;
    act(() => undo.click());
    expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(1);
    act(() => undo.click());
    expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(2);
  });

  it('silently clears unsafe history and stale status when an external operation replaces the page structure', async () => {
    const baseline = createEditorDocument();
    const external = createTwoPageEditorDocument();
    const onGeneratePage = vi.fn().mockResolvedValue(undefined);
    let id = 0;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          idFactory={(prefix) => `${prefix}-external-${++id}`}
          onGeneratePage={onGeneratePage}
        />,
      ),
    );
    const generate = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '生成当前页',
    );
    await act(async () => generate?.click());
    expect(container.querySelector('.reach-deck-editor__status')?.textContent).toBe(
      '已取消页面生成',
    );
    act(() => openPageMenu(container, 'First page'));
    act(() => clickMenuItem(container, '创建副本'));
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')?.disabled,
    ).toBe(false);

    act(() => root.render(<ReachDeckEditor document={external} onGeneratePage={onGeneratePage} />));

    expect(activePageTitle(container)).toBe('First page');
    expect(container.textContent).not.toContain('撤销历史已清空');
    expect(container.querySelector('.reach-deck-editor__status')).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')?.disabled,
    ).toBe(true);
  });

  it('locks authoring while generation is pending so its result cannot overwrite later edits', async () => {
    let resolveGeneration!: (document: ReachDeckDocument) => void;
    const generation = new Promise<ReachDeckDocument>((resolve) => {
      resolveGeneration = resolve;
    });
    const generated = createEditorDocument();
    const generatedPage = generated.pages[0];
    if (generatedPage.sceneType !== 'slide') throw new Error('Expected slide fixture');
    generated.pages[0] = {
      ...generatedPage,
      revision: 2,
      title: 'Generated page',
    };
    generated.nativeSlides = generated.nativeSlides.map((binding) =>
      binding.pageId === generatedPage.pageId
        ? { ...binding, slide: { ...binding.slide, title: 'Generated page' } }
        : binding,
    );
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onGeneratePage={() => generation} />,
      ),
    );

    const generate = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '生成当前页',
    );
    act(() => generate?.click());
    expect(
      container.querySelector('[aria-label="Reach Deck 编辑器"]')?.getAttribute('aria-busy'),
    ).toBe('true');
    expect(generate?.disabled).toBe(true);

    await act(async () => resolveGeneration(generated));
    expect(activePageTitle(container)).toBe('Generated page');
  });

  it('does not expose page generation while the editor is disabled', () => {
    const onGeneratePage = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          disabled
          document={createEditorDocument()}
          onGeneratePage={onGeneratePage}
        />,
      ),
    );

    const generate = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '生成当前页',
    );
    expect(generate?.disabled).toBe(true);
    act(() => generate?.click());
    expect(onGeneratePage).not.toHaveBeenCalled();
  });

  it('ignores a stale generation result when a newer document arrives after generation starts', async () => {
    let resolveGeneration!: (document: ReachDeckDocument) => void;
    const generation = new Promise<ReachDeckDocument>((resolve) => {
      resolveGeneration = resolve;
    });
    const baseline = createEditorDocument();
    const generated = withFirstPageTitle(baseline, 'Generated page', 2);
    const newer = withFirstPageTitle(baseline, 'Newer external edit', 2);
    const onGeneratePage = () => generation;
    act(() => root.render(<ReachDeckEditor document={baseline} onGeneratePage={onGeneratePage} />));
    const generate = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '生成当前页',
    );
    act(() => generate?.click());
    act(() => root.render(<ReachDeckEditor document={newer} onGeneratePage={onGeneratePage} />));
    await act(async () => resolveGeneration(generated));

    expect(activePageTitle(container)).toBe('Newer external edit');
    expect(container.textContent).toContain('未应用过期的生成结果');
  });

  it('synchronizes editor selection when the page navigator changes', () => {
    act(() => root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} />));
    const secondPage = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')]
      .find((item) => item.textContent?.includes('Second page'))
      ?.querySelector<HTMLElement>('[data-page-card]');
    if (secondPage === null || secondPage === undefined) {
      throw new Error('second page navigator item not found');
    }
    act(() => secondPage.click());

    expect(activePageTitle(container)).toBe('Second page');
  });

  it('switches immediately while the host save is pending or fails', async () => {
    let resolveSave!: () => void;
    const onBeforeActivePageChange = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
      )
      .mockRejectedValueOnce(new Error('save failed'));
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onBeforeActivePageChange={onBeforeActivePageChange}
        />,
      ),
    );
    const pageButton = (title: string) =>
      [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')]
        .find((item) => item.textContent?.includes(title))
        ?.querySelector<HTMLElement>('[data-page-card]');

    act(() => pageButton('Second page')?.click());
    expect(activePageTitle(container)).toBe('Second page');
    expect(onBeforeActivePageChange).toHaveBeenCalledWith('page-1', 'page-2');
    await act(async () => resolveSave());
    expect(activePageTitle(container)).toBe('Second page');

    await act(async () => pageButton('First page')?.click());
    expect(onBeforeActivePageChange).toHaveBeenLastCalledWith('page-2', 'page-1');
    expect(activePageTitle(container)).toBe('First page');
  });

  it('reorders slides by dragging one item onto another', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} onChange={onChange} />),
    );

    const items = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')];
    expect(items).toHaveLength(2);
    const handle = items[1]?.querySelector<HTMLElement>('[data-page-card]');
    if (handle === null || handle === undefined) throw new Error('drag handle not found');

    // dragstart 要单独 flush，drop 时组件才读到已提交的 draggingPageId。
    act(() => handle.dispatchEvent(dragEvent('dragstart')));
    act(() => items[0]?.dispatchEvent(dragEvent('dragover')));
    act(() => items[0]?.dispatchEvent(dragEvent('drop')));

    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next.pages.map((page: { title: string }) => page.title)).toEqual([
      'Second page',
      'First page',
    ]);
    expect(next.pages.map((page: { order: number }) => page.order)).toEqual([1, 2]);
  });

  it('moves a slide after the card below it on a downward drop', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} onChange={onChange} />),
    );
    const items = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')];
    act(() =>
      items[0]!
        .querySelector<HTMLElement>('[data-page-card]')!
        .dispatchEvent(dragEvent('dragstart')),
    );
    act(() => items[1]!.dispatchEvent(dragEvent('drop')));

    expect(
      (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages.map((page) => page.pageId),
    ).toEqual(['page-2', 'page-1']);
  });

  it('moves the selected page collection together when one selected card is dragged', () => {
    const onChange = vi.fn();
    const document = createTwoPageEditorDocument();
    const second = document.pages[1]!;
    document.pages.push({
      ...structuredClone(second),
      pageId: 'page-3',
      order: 3,
      title: 'Third page',
    });
    if (document.schemaVersion === 'reach-deck-document/v2') {
      document.nativeSlides.push({
        ...document.nativeSlides[1]!,
        pageId: 'page-3',
        slide: { ...document.nativeSlides[1]!.slide, id: 'slide-3', title: 'Third page' },
      });
    }
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
    const items = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')];
    act(() => cards[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => cards[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    act(() => cards[1]!.dispatchEvent(dragEvent('dragstart')));
    act(() => items[0]!.dispatchEvent(dragEvent('dragover')));
    act(() => items[0]!.dispatchEvent(dragEvent('drop')));
    expect(
      (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages.map((page) => page.title),
    ).toEqual(['Second page', 'Third page', 'First page']);
  });

  it.each(['dragend', 'drop', 'pointerup', 'blur', 'escape'])(
    'clears page drag feedback when interrupted by %s outside the rail',
    (kind) => {
      act(() => root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} />));
      const cards = [...container.querySelectorAll<HTMLElement>('[data-page-card]')];
      act(() => cards[1]!.dispatchEvent(dragEvent('dragstart')));
      act(() => cards[0]!.parentElement!.dispatchEvent(dragEvent('dragover')));
      expect(cards[1]!.parentElement!.dataset.dragging).toBe('true');
      expect(cards[0]!.parentElement!.dataset.dragOver).toBe('true');

      act(() =>
        window.dispatchEvent(
          kind === 'escape' ? new KeyboardEvent('keydown', { key: 'Escape' }) : new Event(kind),
        ),
      );
      expect(container.querySelector('[data-dragging], [data-drag-over]')).toBeNull();
    },
  );

  it('ends an interrupted drag when opening a page menu and blocks a subsequent dragstart', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} onChange={onChange} />),
    );
    const card = container.querySelectorAll<HTMLElement>('[data-page-card]')[1]!;
    act(() => card.dispatchEvent(dragEvent('dragstart')));
    expect(card.parentElement!.dataset.dragging).toBe('true');
    act(() => openPageMenu(container, 'Second page'));
    expect(card.parentElement!.dataset.dragging).toBeUndefined();
    expect(card.draggable).toBe(false);

    const unwantedDrag = dragEvent('dragstart');
    act(() => card.dispatchEvent(unwantedDrag));
    expect(unwantedDrag.defaultPrevented).toBe(true);
    expect(card.parentElement!.dataset.dragging).toBeUndefined();
    act(() => clickMenuItem(container, '删除'));
    expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(1);
  });

  it('opens a page context menu without activating the right-clicked page', () => {
    act(() => root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} />));

    act(() => openPageMenu(container, 'Second page'));

    expect(container.querySelector('[aria-label="页面操作 Second page"]')).not.toBeNull();
    expect(activePageTitle(container)).toBe('First page');
  });

  it('keeps the active page when deleting a different page from its menu', () => {
    const onChange = vi.fn();
    const onBeforeActivePageChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onChange={onChange}
          onBeforeActivePageChange={onBeforeActivePageChange}
        />,
      ),
    );
    act(() => openPageMenu(container, 'Second page'));
    act(() => clickMenuItem(container, '删除'));
    expect(activePageTitle(container)).toBe('First page');
    expect(onBeforeActivePageChange).not.toHaveBeenCalled();
  });

  it('clears page drag feedback when a gap context menu stops event propagation', () => {
    act(() => root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} />));
    const card = container.querySelectorAll<HTMLElement>('[data-page-card]')[1]!;
    act(() => card.dispatchEvent(dragEvent('dragstart')));
    act(() =>
      container
        .querySelector('[data-insertion-gap]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(container.querySelector('[data-dragging], [data-drag-over]')).toBeNull();
    expect(container.querySelector('.reach-deck-editor__insertion-menu')).not.toBeNull();
  });

  it.each([1, 2])('deletes page at index %s through its menu and can undo it', (index) => {
    const document = addReachDeckPage(createTwoPageEditorDocument(), {
      afterPageId: 'page-2',
      sceneType: 'interactive',
      idFactory: (prefix) => `${prefix}-third`,
    });
    const target = document.pages[index]!;
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));

    act(() => openPageMenu(container, target.title));
    act(() => clickMenuItem(container, '删除'));

    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(next.pages.map((page) => page.pageId)).toEqual(
      document.pages.filter((page) => page.pageId !== target.pageId).map((page) => page.pageId),
    );
    expect(next.pages.map((page) => page.order)).toEqual([1, 2]);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(activePageTitle(container)).toBe('First page');

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')!.click());
    expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toEqual(document.pages);
  });

  it.each(['page', 'insertion'])('positions the %s menu using its rendered height', (kind) => {
    vi.stubGlobal('innerHeight', 600);
    mockPageMenuLayout();
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onRequestPptxInsert={vi.fn()} />,
      ),
    );
    const trigger = container.querySelector<HTMLElement>(
      kind === 'page' ? '[data-page-card]' : '.reach-deck-editor__pages',
    )!;
    const openAt = (clientY: number) =>
      act(() =>
        trigger.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY,
          }),
        ),
      );

    openAt(500);
    const menu = container.querySelector<HTMLElement>('.reach-deck-editor__page-menu')!;
    expect(menu.style.top).toBe('500px');

    openAt(580);
    expect(menu.style.top).toBe('518px');
    expect(menu.getBoundingClientRect().bottom).toBe(592);
  });

  it.each([
    { side: 'right', width: 1024, clientX: 20, expandedTop: 483 },
    { side: 'left', width: 1024, clientX: 950, expandedTop: 483 },
    { side: 'below', width: 320, clientX: 300, expandedTop: 408 },
  ])(
    'keeps the expanded $side submenu inside the viewport',
    ({ side, width, clientX, expandedTop }) => {
      vi.stubGlobal('innerWidth', width);
      vi.stubGlobal('innerHeight', 600);
      mockPageMenuLayout();
      act(() =>
        root.render(
          <ReachDeckEditor document={createEditorDocument()} onRequestPptxInsert={vi.fn()} />,
        ),
      );
      act(() =>
        container.querySelector('.reach-deck-editor__pages')!.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY: 580,
          }),
        ),
      );
      const menu = container.querySelector<HTMLElement>('.reach-deck-editor__page-menu')!;
      expect(menu.dataset.submenuSide).toBe(side);
      expect(menu.style.top).toBe('518px');

      act(() => clickMenuItem(container, '新建'));
      expect(menu.style.top).toBe(`${expandedTop}px`);
      const submenu = menu.querySelector('.reach-deck-editor__page-submenu')!;
      for (const element of [menu, submenu]) {
        const bounds = element.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(8);
        expect(bounds.bottom).toBeLessThanOrEqual(592);
      }

      act(() => clickMenuItem(container, '新建'));
      expect(menu.style.top).toBe('518px');
    },
  );

  it('keeps page actions separate and opens create choices from a keyboard gap button', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));
    act(() => openPageMenu(container, 'First page'));
    const pageMenuLabels = [
      ...container.querySelectorAll<HTMLButtonElement>('[aria-label^="页面操作"] button'),
    ].map((button) => button.textContent?.trim());
    expect(pageMenuLabels).toEqual(['创建副本', '删除']);

    act(() => openInsertionMenu(container, '在页面 First page 之后插入'));
    act(() => clickMenuItem(container, '新建'));

    const menu = container.querySelector('.reach-deck-editor__page-menu');
    expect(menu).not.toBeNull();
    const panel = menu?.querySelector('[aria-label="选择新建幻灯片类型"]');
    expect(panel).not.toBeNull();
    const options = [...(panel?.querySelectorAll('button') ?? [])];
    const quiz = options.find((button) => button.textContent?.includes('测验'));
    expect(quiz?.disabled).toBe(false);
  });

  it('adds the first quiz page from a touch-accessible empty deck action', () => {
    const onChange = vi.fn();
    const document = { ...createEditorDocument(), pages: [], nativeSlides: [] };
    act(() =>
      root.render(
        <ReachDeckEditor document={document} onChange={onChange} onAssistantPrompt={vi.fn()} />,
      ),
    );
    const firstPage = container.querySelector<HTMLButtonElement>(
      '.reach-deck-editor__add-first-page',
    );
    expect(firstPage?.textContent).toContain('添加第一页');
    act(() => firstPage?.click());
    act(() => clickMenuItem(container, '新建'));
    act(() => pickNewSceneType(container, '测验'));
    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(next.pages).toHaveLength(1);
    expect(next.pages[0]?.sceneType).toBe('quiz');
    expect(container.querySelector('.reach-deck-editor__add-first-page')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')?.click());
    expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(0);
    expect(container.querySelector('.reach-deck-editor__add-first-page')).not.toBeNull();
  });

  it('disables the empty deck insertion action while editing is locked', () => {
    const document = { ...createEditorDocument(), pages: [], nativeSlides: [] };
    act(() => root.render(<ReachDeckEditor document={document} disabled />));
    expect(
      container.querySelector<HTMLButtonElement>('.reach-deck-editor__add-first-page')?.disabled,
    ).toBe(true);
  });

  it('maps blank rail context actions to the after-last position', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createTwoPageEditorDocument()} onChange={onChange} />),
    );
    const rail = container.querySelector<HTMLElement>('.reach-deck-editor__pages');
    act(() =>
      rail?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      ),
    );
    act(() => clickMenuItem(container, '新建'));
    act(() => pickNewSceneType(container, '测验'));

    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(next.pages.map((page) => page.sceneType)).toEqual(['slide', 'slide', 'quiz']);
  });

  it('requests PPTX insertion after the selected gap without activating its page', () => {
    const onRequestPptxInsert = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onRequestPptxInsert={onRequestPptxInsert}
        />,
      ),
    );
    act(() => openInsertionMenu(container, '在页面 Second page 之后插入'));
    act(() => clickMenuItem(container, '导入'));
    act(() => clickMenuItem(container, '上传 PPTX'));

    expect(onRequestPptxInsert).toHaveBeenCalledOnce();
    expect(onRequestPptxInsert).toHaveBeenCalledWith({
      mode: 'insert-after',
      afterPageId: 'page-2',
    });
    expect(activePageTitle(container)).toBe('First page');
    expect(container.querySelector('.reach-deck-editor__page-menu')).toBeNull();
  });

  it('requests MAIC insertion before page one through the explicit before-first target', () => {
    const onRequestMaicInsert = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onRequestMaicInsert={onRequestMaicInsert}
        />,
      ),
    );
    act(() => openInsertionMenu(container, '在第一页之前插入'));
    act(() => clickMenuItem(container, '导入'));
    act(() => clickMenuItem(container, '从 JSON 导入'));

    expect(onRequestMaicInsert).toHaveBeenCalledOnce();
    expect(onRequestMaicInsert).toHaveBeenCalledWith({ mode: 'before-first' });
    expect(activePageTitle(container)).toBe('First page');
    expect(container.querySelector('.reach-deck-editor__page-menu')).toBeNull();
  });

  it('does not open blank-rail insertion or import actions while structure is locked', () => {
    const onRequestPptxInsert = vi.fn();
    const onRequestMaicInsert = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onRequestMaicInsert={onRequestMaicInsert}
          onRequestPptxInsert={onRequestPptxInsert}
          structureLocked
        />,
      ),
    );

    const rail = container.querySelector<HTMLElement>('.reach-deck-editor__pages');
    act(() =>
      rail?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      ),
    );

    expect(container.querySelector('[aria-label="插入操作"]')).toBeNull();
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('[data-insertion-gap]')].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    const lastGap = [...container.querySelectorAll<HTMLButtonElement>('[data-insertion-gap]')].at(
      -1,
    );
    act(() =>
      lastGap?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      ),
    );
    expect(container.querySelector('[aria-label="插入操作"]')).toBeNull();
    expect(onRequestPptxInsert).not.toHaveBeenCalled();
    expect(onRequestMaicInsert).not.toHaveBeenCalled();
  });

  it('reports a stale insertion anchor without changing the newer document', () => {
    const onChange = vi.fn();
    const initial = createTwoPageEditorDocument();
    act(() => root.render(<ReachDeckEditor document={initial} onChange={onChange} />));
    act(() => openInsertionMenu(container, '在页面 Second page 之后插入'));
    act(() => clickMenuItem(container, '新建'));

    const newer = deleteReachDeckPage(initial, 'page-2');
    act(() => root.render(<ReachDeckEditor document={newer} onChange={onChange} />));
    act(() => pickNewSceneType(container, '测验'));

    expect(container.textContent).toContain('插入页面失败，请重新选择位置后再试。');
    expect(onChange).not.toHaveBeenCalled();
    expect(activePageTitle(container)).toBe('First page');
  });

  it('offers narration regeneration from the timeline narration panel for the active slide page', async () => {
    const onRegeneratePageNarration = vi.fn();
    // 时间轴只在存在 native slide 绑定时渲染，这里给两页夹具补齐第一页的绑定。
    const createDocument = () => {
      const document = normalizeReachDeckDocumentV2(createTwoPageEditorDocument());
      const page = document.pages[0]!;
      document.nativeSlides = [
        {
          pageId: page.pageId,
          slide: {
            schemaVersion: 'reach-deck-slide/v2',
            id: 'native-slide-1',
            title: page.title,
            background: { kind: 'none' },
            elements: [],
            animations: [],
            narration: { segments: [{ text: '讲稿一', start: 0, end: 5 }] },
            duration: 8,
          },
        },
        document.nativeSlides[1]!,
      ];
      return document;
    };
    const openNarrationView = () =>
      act(() =>
        container.querySelector<HTMLButtonElement>('#reach-deck-right-tab-narration')?.click(),
      );
    const findRegenerate = () =>
      container.querySelector<HTMLButtonElement>(
        '#reach-deck-right-panel-narration [aria-label="重新生成本页讲稿、音频和动画"]',
      );

    act(() =>
      root.render(
        <ReachDeckEditor
          document={createDocument()}
          onRegeneratePageNarration={onRegeneratePageNarration}
        />,
      ),
    );
    // 讲稿视图里能看到分段全文与重新生成入口。
    openNarrationView();
    expect(container.querySelector('#reach-deck-right-panel-narration')?.textContent).toContain(
      '讲稿一',
    );
    const moreActions = container.querySelector<HTMLDetailsElement>(
      '#reach-deck-right-panel-narration .reach-deck-timeline__narration-menu',
    )!;
    act(() => moreActions.querySelector('summary')?.click());
    expect(moreActions.open).toBe(true);
    const regenerate = findRegenerate();
    expect(regenerate).not.toBeNull();
    await act(async () => regenerate?.click());
    const narrationConfirmation = window.document.querySelector('[role="alertdialog"]');
    expect(narrationConfirmation?.textContent).toContain('覆盖现有讲稿、音频和讲稿动画');
    const continueButton = [...(narrationConfirmation?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '继续',
    );
    await act(async () => continueButton?.click());
    // 作用于当前活动页（默认第一页）。
    expect(onRegeneratePageNarration).toHaveBeenCalledOnce();
    expect(onRegeneratePageNarration).toHaveBeenCalledWith('page-1');

    // 二级展开里的“仅重新生成本页讲稿”以 textOnly 调用同一回调。
    const textOnly = container.querySelector<HTMLButtonElement>(
      '#reach-deck-right-panel-narration [aria-label="仅重新生成本页讲稿"]',
    );
    expect(textOnly).not.toBeNull();
    await act(async () => textOnly?.click());
    const textOnlyConfirmation = window.document.querySelector('[role="alertdialog"]');
    expect(textOnlyConfirmation?.textContent).toContain('本页现有音频和讲稿动画将被清除');
    await act(async () =>
      [...(textOnlyConfirmation?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onRegeneratePageNarration).toHaveBeenLastCalledWith('page-1', { textOnly: true });
    expect(
      container.querySelector('#reach-deck-right-panel-narration [aria-label="全部生成音频"]'),
    ).toBeNull();

    // 活动页锁定（生成/讲稿在途）：按钮渲染但禁用（时间轴组件保持挂载，讲稿视图不丢）。
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createDocument()}
          lockedPageIds={['page-1']}
          onRegeneratePageNarration={onRegeneratePageNarration}
        />,
      ),
    );
    expect(findRegenerate()?.disabled).toBe(true);

    // 失败/生成中的页只提供完整重试：仅讲稿结果不带音频，无法让页面状态收敛。
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createDocument()}
          generationStatusByPageId={{
            'page-1': { phase: 'narration', state: 'failed', message: '讲稿生成失败' },
          }}
          onRegeneratePageNarration={onRegeneratePageNarration}
        />,
      ),
    );
    expect(
      container.querySelector(
        '#reach-deck-right-panel-narration [aria-label="仅重新生成本页讲稿"]',
      ),
    ).toBeNull();

    // 未接线（回调缺省）时不渲染该按钮；右键菜单里也不再有该入口。
    act(() => root.render(<ReachDeckEditor document={createDocument()} />));
    expect(findRegenerate()).toBeNull();
    act(() => openPageMenu(container, 'Second page'));
    expect(
      [
        ...(container.querySelector('.reach-deck-editor__page-menu')?.querySelectorAll('button') ??
          []),
      ].some((button) => button.textContent?.trim() === '重新生成讲稿'),
    ).toBe(false);
  });

  it('offers a new narration attempt for a locked non-replayable narration failure', async () => {
    const onRegeneratePageNarration = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          generationStatusByPageId={{
            'page-1': {
              phase: 'narration',
              state: 'failed',
              message: '讲稿、音频与动画生成失败',
              retryable: false,
            },
          }}
          lockedPageIds={['page-1']}
          narrationRegeneratablePageIds={['page-1']}
          onRegeneratePageNarration={onRegeneratePageNarration}
          onSavePageNarrationAndGenerate={vi.fn()}
        />,
      ),
    );

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="收起编辑侧栏"]')?.click());
    expect(
      container.querySelector('.reach-deck-editor__properties')?.getAttribute('data-collapsed'),
    ).toBe('true');

    const failure = container.querySelector(
      '.reach-deck-timeline__generation-overlay[role="alert"]',
    )!;
    const overlayButtons = [...failure.querySelectorAll<HTMLButtonElement>('button')];
    const retry = overlayButtons.find((button) => button.textContent?.includes('重试生成'))!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    expect(onRegeneratePageNarration).toHaveBeenCalledOnce();
    expect(onRegeneratePageNarration).toHaveBeenCalledWith('page-1');
  });

  it('passes the exact whole-page narration Markdown to save-and-generate', async () => {
    const onSavePageNarrationAndGenerate = vi.fn();
    const onRegeneratePageNarration = vi.fn();
    const document = normalizeReachDeckDocumentV2(createTwoPageEditorDocument());
    const page = document.pages[0]!;
    document.resources.media.push({
      id: 'audio-1',
      objectKey: 'generated/narration.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:narration',
    });
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
          narration: {
            markdown: '速度是 \\(v=d/t\\)\n\n第二段',
            segments: [{ text: 'derived caption', start: 0, end: 5 }],
            audioResourceId: 'audio-1',
          },
          duration: 8,
        },
      },
      document.nativeSlides[1]!,
    ];
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          onRegeneratePageNarration={onRegeneratePageNarration}
          onSavePageNarrationAndGenerate={onSavePageNarrationAndGenerate}
        />,
      ),
    );
    const narrationToggle = container.querySelector<HTMLButtonElement>(
      '#reach-deck-right-tab-narration',
    )!;
    act(() => narrationToggle.click());
    expect(container.querySelector('[aria-label="整页讲稿"]')?.textContent).toContain('速度是');
    expect(container.querySelector('#reach-deck-right-panel-narration')?.textContent).not.toContain(
      'derived caption',
    );
    const footerActions = container.querySelector<HTMLElement>(
      '#reach-deck-right-panel-narration .reach-deck-timeline__narration-footer-actions',
    );
    const richText = container.querySelector<HTMLElement>(
      '#reach-deck-right-panel-narration .reach-deck-editor__rich-text',
    );
    expect(footerActions?.querySelectorAll('button')).toHaveLength(1);
    expect(
      footerActions !== null &&
        richText !== null &&
        (richText.compareDocumentPosition(footerActions) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
    const save = footerActions?.querySelector<HTMLButtonElement>(
      '[aria-label="保存讲稿并生成音频与动画"]',
    )!;
    await act(async () => save.click());
    expect(onSavePageNarrationAndGenerate).toHaveBeenCalledWith({
      markdown: '速度是 \\(v=d/t\\)\n\n第二段',
      pageId: 'page-1',
    });
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          generationStatusByPageId={{
            'page-1': { phase: 'narration', state: 'loading', message: '正在生成音频与动画' },
          }}
          onRegeneratePageNarration={onRegeneratePageNarration}
          onSavePageNarrationAndGenerate={onSavePageNarrationAndGenerate}
        />,
      ),
    );
    expect(
      container.querySelector('#reach-deck-right-panel-narration [role="status"]')?.textContent,
    ).toContain('正在生成音频与动画');
    expect(container.querySelector('[aria-label="整页讲稿"]')?.textContent).toContain('速度是');
  });

  it('shows the layout failure hint next to the regenerate action', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': {
              phase: 'layout',
              state: 'failed',
              message: '幻灯片排版生成失败',
              hint: 'AI 生成的内容不符合要求，先重试一次。',
            },
          }}
          onRegeneratePage={vi.fn()}
        />,
      ),
    );
    const overlay = container.querySelector('.reach-deck-editor__generating-overlay[data-failed]')!;
    expect(overlay.textContent).toContain('幻灯片排版生成失败');
    expect(overlay.querySelector('.reach-deck-editor__generating-hint')?.textContent).toContain(
      '先重试一次',
    );
    expect(overlay.querySelector('button')?.textContent).toContain('重新生成本页');
  });

  it('loads a parseable manual-review candidate into the existing TipTap narration editor', async () => {
    const onSavePageNarrationAndGenerate = vi.fn();
    const onRegeneratePageNarration = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': {
              phase: 'narration',
              state: 'manual-review-required',
              candidateMarkdown: '速度是 \\(v=d/t\\)\n\n请确认。',
            },
          }}
          narrationRegeneratablePageIds={['page-1']}
          onRegeneratePageNarration={onRegeneratePageNarration}
          onSavePageNarrationAndGenerate={onSavePageNarrationAndGenerate}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="收起编辑侧栏"]')?.click());
    const overlay = container.querySelector<HTMLElement>(
      '.reach-deck-timeline__generation-overlay[data-manual-review="true"]',
    )!;
    const goToPanel = [...overlay.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('转到面板'),
    )!;
    await act(async () => goToPanel.click());

    const panel = container.querySelector<HTMLElement>('#reach-deck-right-panel-narration')!;
    const moreActions = panel.querySelector<HTMLDetailsElement>(
      '.reach-deck-timeline__narration-menu',
    )!;
    act(() => moreActions.querySelector('summary')?.click());
    const regenerate = panel.querySelector<HTMLButtonElement>(
      '[aria-label="重新生成本页讲稿、音频和动画"]',
    );
    expect(regenerate).not.toBeNull();
    expect(document.activeElement).not.toBe(regenerate);
    expect(panel.querySelector('textarea')).toBeNull();
    expect(panel.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(panel.querySelector('[data-mathlive-node="inline-math"]')).not.toBeNull();
    expect(panel.querySelector('.reach-deck-timeline__narration-warning')).toBeNull();
    expect(panel.textContent).toContain('有未保存的修改');

    const save = panel.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')!;
    await act(async () => save.click());
    expect(onSavePageNarrationAndGenerate).toHaveBeenCalledWith({
      markdown: '速度是 \\(v=d/t\\)\n\n请确认。',
      pageId: 'page-1',
    });
  });

  it('loads a syntax-invalid manual-review candidate as multiline literal text in TipTap', async () => {
    const onSavePageNarrationAndGenerate = vi.fn();
    const candidateMarkdown = '第一行\n第二行\n\n\\[x\\]\n结尾';
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': {
              phase: 'narration',
              state: 'manual-review-required',
              candidateMarkdown,
            },
          }}
          onSavePageNarrationAndGenerate={onSavePageNarrationAndGenerate}
        />,
      ),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('#reach-deck-right-tab-narration')?.click(),
    );

    const panel = container.querySelector<HTMLElement>('#reach-deck-right-panel-narration')!;
    expect(panel.querySelector('textarea')).toBeNull();
    expect(panel.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(panel.querySelector('[data-mathlive-node]')).toBeNull();
    expect(panel.querySelectorAll('.ProseMirror p')).toHaveLength(2);
    expect(panel.querySelectorAll('.ProseMirror br')).toHaveLength(2);
    expect(panel.textContent).toContain('公式样式文本可能会被逐字朗读');
    expect(panel.textContent).toContain('\\[x\\]');

    const save = panel.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')!;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(onSavePageNarrationAndGenerate).toHaveBeenCalledWith({
      markdown: '第一行\n第二行\n\n\\\\[x\\\\]\n结尾',
      pageId: 'page-1',
    });
  });

  it('keeps save disabled when a literal TipTap candidate still violates narration Markdown', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': {
              phase: 'narration',
              state: 'manual-review-required',
              candidateMarkdown: '1. 仍需教师修改',
            },
          }}
          onSavePageNarrationAndGenerate={vi.fn()}
        />,
      ),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('#reach-deck-right-tab-narration')?.click(),
    );

    const panel = container.querySelector<HTMLElement>('#reach-deck-right-panel-narration')!;
    const save = panel.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')!;
    expect(panel.textContent).toContain('讲稿仅支持纯文字、段落、换行和公式');
    expect(panel.textContent).toContain('1. 仍需教师修改');
    expect(save.disabled).toBe(true);
  });

  it('preserves parsed formula semantics when a manual-review candidate only exceeds capacity', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': {
              phase: 'narration',
              state: 'manual-review-required',
              candidateMarkdown: `公式 \\(x+1\\) ${'字'.repeat(2_001)}`,
            },
          }}
          onSavePageNarrationAndGenerate={vi.fn()}
        />,
      ),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('#reach-deck-right-tab-narration')?.click(),
    );

    const panel = container.querySelector<HTMLElement>('#reach-deck-right-panel-narration')!;
    const save = panel.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频与动画"]')!;
    expect(panel.querySelector('[data-mathlive-node="inline-math"]')).not.toBeNull();
    expect(panel.querySelector('.reach-deck-timeline__narration-warning')).toBeNull();
    expect(panel.textContent).toContain('整份讲稿不能超过 2000 个字符/词');
    expect(save.disabled).toBe(true);
  });

  it('keeps locked state out of the page list copy', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          lockedPageIds={['page-1', 'page-2']}
          lockedPageReason="该页正在生成"
          lockedPageReasonById={{ 'page-2': '讲稿生成中' }}
        />,
      ),
    );
    expect(container.querySelector('.reach-deck-editor__page-status')).toBeNull();
    const pageList = container.querySelector('.reach-deck-editor__pages');
    expect(pageList?.textContent).not.toContain('该页正在生成');
    expect(pageList?.textContent).not.toContain('讲稿生成中');
  });

  it('renders a failed layout as a canvas-local retry state', async () => {
    const onRegeneratePage = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': { phase: 'layout', state: 'failed', message: '幻灯片排版生成失败' },
          }}
          onRegeneratePage={onRegeneratePage}
        />,
      ),
    );

    const failure = container.querySelector('.reach-deck-editor__generating-overlay[role="alert"]');
    expect(failure?.textContent).toContain('幻灯片排版生成失败');
    const regenerate = [...failure!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '重新生成本页',
    );
    await act(async () => regenerate?.click());
    expect(onRegeneratePage).toHaveBeenCalledWith('page-1');
  });

  it.each(['failure', 'corner'])(
    'shows page-scoped submitting feedback from the %s retry button',
    async (buttonKind) => {
      let reject!: (cause: Error) => void;
      const onRegeneratePage = vi.fn(
        () =>
          new Promise<void>((_resolve, rejection) => {
            reject = rejection;
          }),
      );
      const document = createTwoPageEditorDocument();
      act(() =>
        root.render(
          <ReachDeckEditor
            document={document}
            generationStatusByPageId={{
              'page-1': { phase: 'layout', state: 'failed', message: 'old failure' },
            }}
            onRegeneratePage={onRegeneratePage}
          />,
        ),
      );
      const button = container.querySelector<HTMLButtonElement>(
        buttonKind === 'failure'
          ? '.reach-deck-editor__generating-overlay button'
          : '.reach-deck-editor__regenerate-page',
      )!;
      act(() => {
        button.click();
        button.click();
      });
      expect(onRegeneratePage).toHaveBeenCalledOnce();
      let overlay = container.querySelector('.reach-deck-editor__generating-overlay')!;
      expect(overlay.getAttribute('role')).toBe('status');
      expect(overlay.textContent).toContain('正在提交本页重新生成');
      expect(overlay.textContent).not.toContain('old failure');
      const pageTwo = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')]
        .find((item) => item.textContent?.includes('Second page'))
        ?.querySelector<HTMLElement>('[data-page-card]');
      act(() => pageTwo?.click());
      expect(container.querySelector('.reach-deck-editor__generating-overlay')).toBeNull();
      await act(async () => {
        reject(new Error('network interrupted'));
      });
      const pageOne = container.querySelector<HTMLElement>(
        '.reach-deck-editor__pages li [data-page-card]',
      );
      act(() => pageOne?.click());
      overlay = container.querySelector('.reach-deck-editor__generating-overlay')!;
      expect(overlay.getAttribute('role')).toBe('alert');
      expect(overlay.textContent).toContain('响应中断');
      expect(
        container.querySelector<HTMLButtonElement>('.reach-deck-editor__generating-overlay button')
          ?.disabled,
      ).toBe(false);
      act(() =>
        root.render(
          <ReachDeckEditor
            document={document}
            generationStatusByPageId={{
              'page-1': { phase: 'layout', state: 'loading', message: 'accepted' },
            }}
            onRegeneratePage={onRegeneratePage}
          />,
        ),
      );
      expect(
        container.querySelector('.reach-deck-editor__generating-overlay')?.textContent,
      ).toContain('accepted');
      expect(
        container.querySelector<HTMLButtonElement>('.reach-deck-editor__regenerate-page')?.disabled,
      ).toBe(true);
    },
  );

  it('releases local retry busy state when a different document replaces an unresolved request', async () => {
    let finish!: () => void;
    const onRegeneratePage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const document = createTwoPageEditorDocument();
    act(() =>
      root.render(<ReachDeckEditor document={document} onRegeneratePage={onRegeneratePage} />),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('.reach-deck-editor__regenerate-page')?.click(),
    );
    act(() =>
      root.render(
        <ReachDeckEditor
          document={{ ...document, id: 'different-document' }}
          onRegeneratePage={onRegeneratePage}
        />,
      ),
    );
    expect(container.querySelector('.reach-deck-editor')?.getAttribute('aria-busy')).toBe('false');
    expect(container.querySelector('.reach-deck-editor__generating-overlay')).toBeNull();
    await act(async () => finish());
    expect(container.querySelector('.reach-deck-editor')?.getAttribute('aria-busy')).toBe('false');
  });

  it('does not attribute one page action error to another generating page', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationActionError={{ message: 'page 1 retry failed', pageId: 'page-1' }}
          generationStatusByPageId={{
            'page-2': { phase: 'layout', state: 'loading', message: 'page 2 generating' },
          }}
          lockedPageIds={['page-2']}
        />,
      ),
    );
    const pageTwo = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')]
      .find((item) => item.textContent?.includes('Second page'))
      ?.querySelector<HTMLElement>('[data-page-card]');
    act(() => pageTwo?.click());
    const overlay = container.querySelector('.reach-deck-editor__generating-overlay');
    expect(overlay?.getAttribute('role')).toBe('status');
    expect(overlay?.textContent).not.toContain('page 1 retry failed');
  });

  it('shows a rejected page action even when the ready page has no generation status', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationActionError={{ pageId: 'page-1', message: 'Retry rejected' }}
          onRegeneratePage={vi.fn()}
        />,
      ),
    );
    expect(
      container.querySelector('.reach-deck-editor__generating-overlay[role="alert"]')?.textContent,
    ).toContain('Retry rejected');
  });

  it('offers a separate manual regeneration for a non-retryable failed layout', async () => {
    const onRegeneratePage = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': {
              phase: 'layout',
              state: 'failed',
              message: 'cannot retry',
              retryable: false,
            },
          }}
          onRegeneratePage={onRegeneratePage}
        />,
      ),
    );
    const failure = container.querySelector('.reach-deck-editor__generating-overlay[role="alert"]');
    expect(failure?.textContent).toContain('cannot retry');
    const regenerate = [...failure!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '重新生成本页',
    );
    await act(async () => regenerate?.click());
    expect(onRegeneratePage).toHaveBeenCalledWith('page-1');
  });

  it('edits native-v2 elements via the canvas overlay and the shape format strip', () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'native-shape-1',
              type: 'shape',
              name: 'Rectangle 1',
              transform: { x: 10, y: 20, width: 200, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [],
        },
      },
    ];
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const nativeElement = container.querySelector<HTMLElement>(
      '[data-native-v2-editable] [data-native-v2-element-id="native-shape-1"]',
    );
    if (nativeElement === null) {
      throw new Error(`native element not rendered: ${container.textContent ?? ''}`);
    }
    const preview = container.querySelector<HTMLElement>('.reach-deck-editor__preview')!;
    act(() => {
      preview.focus();
      nativeElement.click();
    });
    expect(
      container.querySelector('#reach-deck-right-tab-properties')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(window.document.activeElement).toBe(preview);

    // 大属性面板已移除：位置/大小直接在画布上拖拽，格式条与文字工具栏同行。
    expect(container.querySelector('[aria-label="原生对象名称"]')).toBeNull();
    const strip = container.querySelector<HTMLElement>('[aria-label="形状样式"]');
    expect(strip).not.toBeNull();
    // 作用域标签把对象条的颜色与"文字"的颜色区分开。
    expect(strip?.querySelector('.reach-deck-editor__toolbar-scope')?.textContent).toBe('形状');

    const overlay = container.querySelector<HTMLElement>(
      '[data-native-v2-transform-overlay="native-shape-1"]',
    );
    if (overlay === null) {
      throw new Error(`transform overlay not rendered: ${container.textContent ?? ''}`);
    }
    expect(overlay.querySelectorAll('[data-resize-corner]')).toHaveLength(4);
    act(() => {
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    let next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(next.pages[0]?.revision).toBe(2);
    if (next.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
    expect(next.nativeSlides[0]?.slide.elements[0]?.transform.x).toBe(20);

    const strokeToggle = strip?.querySelector<HTMLInputElement>('[aria-label="形状是否描边"]');
    if (strokeToggle === null || strokeToggle === undefined) {
      throw new Error('shape stroke toggle not found');
    }
    act(() => strokeToggle.click());
    next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    if (next.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
    const element = next.nativeSlides[0]?.slide.elements[0];
    if (element?.type !== 'shape') throw new Error('Expected shape element');
    expect(element.style.stroke).toEqual({
      width: 1,
      fill: { kind: 'srgb', value: '#111827' },
    });
  });

  it('does not surface native-v2 fidelity diagnostics as a warning popover', () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-diagnostic',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'native-shape-diagnostic',
              type: 'shape',
              transform: { x: 80, y: 80, width: 240, height: 120 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: {
                fill: { kind: 'none' },
                stroke: {
                  width: 2,
                  fill: { kind: 'srgb', value: '#111827' },
                  cap: 'round',
                  join: 'round',
                },
              },
            },
          ],
          animations: [],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} />));

    // renderer 不再把诊断面板追加到画布后面，避免挤压时间轴。
    expect(container.querySelector('[data-native-v2-diagnostics]')).toBeNull();
    expect(container.querySelector('button[aria-label="布局提醒"]')).toBeNull();
    expect(container.querySelector('.reach-deck-editor__layout-warnings-popover')).toBeNull();
  });

  it('keeps text and object toolbars in one fixed row whether or not an object is selected', () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'native-shape-1',
              type: 'shape',
              transform: { x: 10, y: 20, width: 200, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} onChange={vi.fn()} />));

    // 文字条与对象条并在同一行，无论是否选中都只有一行工具栏（不再有第二行）。
    const rows = () => [...container.querySelectorAll('.reach-deck-editor__inspector-toolbar')];
    const scopes = () =>
      [...rows()[0]!.querySelectorAll('.reach-deck-editor__toolbar-scope')].map(
        (scope) => scope.textContent,
      );
    expect(rows()).toHaveLength(1);
    expect(scopes()).toEqual(['文字', '对象']);
    // 占位不再携带引导文案。
    expect(container.textContent).not.toContain('选中形状或连接线后可在此设置样式');

    const nativeElement = container.querySelector<HTMLElement>(
      '[data-native-v2-editable] [data-native-v2-element-id="native-shape-1"]',
    );
    act(() => nativeElement?.click());

    expect(rows()).toHaveLength(1);
    expect(scopes()).toEqual(['文字', '形状']);
  });

  it('renders a single text toolbar when the native text frame shadows a same-id scene element', () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    // v2 编译产物的场景影子元素与原生元素同 id：这里复用夹具场景里的 title-1。
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'title-1',
              type: 'textFrame',
              transform: { x: 80, y: 72, width: 1100, height: 120 },
              zIndex: 1,
              text: {
                margins: { left: 4, top: 4, right: 4, bottom: 4 },
                verticalAlignment: 'top',
                wrap: true,
                autofit: { mode: 'none' },
                doc: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '标题' }] }],
                },
                fontSubstitutions: [],
              },
            },
          ],
          animations: [],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} onChange={vi.fn()} />));
    const nativeElement = container.querySelector<HTMLElement>(
      '[data-native-v2-editable] [data-native-v2-element-id="title-1"]',
    );
    if (nativeElement === null) throw new Error('native element not rendered');
    act(() => nativeElement.click());

    // 原生页只挂原生文本编辑器：文字工具栏有且只有一条
    // （回归：曾因 v1 影子元素同 id 同时挂两个编辑器，点击文本框多出一条工具栏）。
    const row = container.querySelector<HTMLElement>('[aria-label="画布格式"]');
    if (row === null) throw new Error('canvas formatting row not rendered');
    const textScopes = [...row.querySelectorAll('.reach-deck-editor__toolbar-scope')].filter(
      (scope) => scope.textContent === '文字',
    );
    expect(textScopes).toHaveLength(1);
  });

  it('enters inline text editing when double-clicking a native text-bearing shape', () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'native-text-1',
              type: 'textFrame',
              transform: { x: 10, y: 20, width: 300, height: 100 },
              zIndex: 1,
              text: {
                margins: { left: 4, top: 4, right: 4, bottom: 4 },
                verticalAlignment: 'top',
                wrap: true,
                autofit: { mode: 'none' },
                doc: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '原生文本' }] }],
                },
                fontSubstitutions: [],
              },
            },
          ],
          animations: [],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} onChange={vi.fn()} />));
    const nativeElement = container.querySelector<HTMLElement>(
      '[data-native-v2-editable] [data-native-v2-element-id="native-text-1"]',
    );
    if (nativeElement === null) throw new Error('native element not rendered');
    act(() => nativeElement.click());

    const overlay = container.querySelector<HTMLElement>(
      '[data-native-v2-transform-overlay="native-text-1"]',
    );
    if (overlay === null) throw new Error('transform overlay not rendered');
    act(() => {
      overlay.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    // 行内编辑开启：画布内出现同款富文本编辑器，浮层退出让位。
    const inlineEditor = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="native-text-1"] [data-rich-text-inline]',
    );
    expect(inlineEditor).not.toBeNull();
    expect(inlineEditor?.textContent).toContain('原生文本');
    expect(container.querySelector('[data-native-v2-transform-overlay]')).toBeNull();
    expect(container.querySelector('[data-rich-text-spacing]')).toBeNull();
  });

  it('applies theme body typography to text entered immediately in a blank canvas frame', async () => {
    const onChange = vi.fn();
    let sequence = 0;
    const baseline = createEditorDocument();
    const document: ReachDeckDocument = {
      ...baseline,
      resources: {
        ...baseline.resources,
        themes: baseline.resources.themes.map((theme) => ({
          ...theme,
          colors: { ...theme.colors, ink: '#234567' },
          fonts: { ...theme.fonts, body: 'Source Han Sans VF' },
        })),
      },
    };
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          idFactory={(prefix) => `${prefix}-blank-text-${++sequence}`}
          onChange={onChange}
        />,
      ),
    );
    const stage = container.querySelector<HTMLElement>(
      '[data-native-v2-editable] [data-native-v2-stage]',
    );
    if (stage === null) throw new Error('Expected native stage.');
    act(() =>
      stage.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: 1_550, clientY: 880 }),
      ),
    );

    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const added = next.nativeSlides[0]!.slide.elements.at(-1);
    expect(added).toMatchObject({
      type: 'textFrame',
      transform: { x: 1120, y: 780, width: 480, height: 120 },
      text: { doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
    });
    expect(
      container.querySelector(`[data-native-v2-element-id="${added!.id}"] [data-rich-text-inline]`),
    ).not.toBeNull();
    await replaceInlineEditorText(container, 'Theme body text');
    await commitInlineEditorText(container);

    const committed = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(nativeTextElement(committed, added!.id).text.doc.content?.[0]).toMatchObject({
      attrs: { lineHeightPx: 42 },
      content: [
        {
          marks: [
            {
              attrs: {
                color: '#234567',
                fontFamily: 'Source Han Sans VF',
                fontSize: '30px',
              },
              type: 'textStyle',
            },
          ],
          text: 'Theme body text',
          type: 'text',
        },
      ],
    });
  });

  it('discards a newly created text frame when it loses focus without renderable content', async () => {
    const onChange = vi.fn();
    const document = createEditorDocument();
    const originalElementIds = document.nativeSlides[0]!.slide.elements.map(
      (element) => element.id,
    );
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const stage = container.querySelector<HTMLElement>(
      '[data-native-v2-editable] [data-native-v2-stage]',
    );
    if (stage === null) throw new Error('Expected native stage.');
    act(() =>
      stage.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: 800, clientY: 450 }),
      ),
    );
    const created = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const elementId = created.nativeSlides[0]!.slide.elements.at(-1)!.id;
    expect(created.nativeSlides[0]!.slide.elements.map((element) => element.id)).toContain(
      elementId,
    );
    await act(async () => Promise.resolve());
    act(() => stage.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(container.querySelector('[data-rich-text-inline]')).toBeNull();
    const discarded = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(discarded.nativeSlides[0]!.slide.elements.map((element) => element.id)).toEqual(
      originalElementIds,
    );
    expect(container.querySelector(nativeElementSelector(elementId))).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="重做课件修改"]')?.disabled,
    ).toBe(true);
  });

  it.each(['Escape', 'keyboard page switch'] as const)(
    'discards a newly created empty text frame on %s',
    async (exitMode) => {
      const onChange = vi.fn();
      const document = createTwoPageEditorDocument();
      const originalElementIds = document.nativeSlides[0]!.slide.elements.map(
        (element) => element.id,
      );
      act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
      const stage = container.querySelector<HTMLElement>(
        '[data-native-v2-editable] [data-native-v2-stage]',
      );
      if (stage === null) throw new Error('Expected native stage.');
      act(() =>
        stage.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, clientX: 800, clientY: 450 }),
        ),
      );

      if (exitMode === 'Escape') {
        const surface = container.querySelector<HTMLElement>('[data-rich-text-inline]');
        if (surface === null) throw new Error('Expected inline text editor.');
        act(() =>
          surface.dispatchEvent(
            new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
          ),
        );
      } else {
        const secondPage = [...container.querySelectorAll<HTMLElement>('[data-page-card]')].find(
          (card) => card.textContent?.includes('Second page'),
        );
        if (secondPage === undefined) throw new Error('Expected second page card.');
        act(() =>
          secondPage.dispatchEvent(
            new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }),
          ),
        );
      }

      const discarded = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
      expect(discarded.nativeSlides[0]!.slide.elements.map((element) => element.id)).toEqual(
        originalElementIds,
      );
      expect(container.querySelector('[data-rich-text-inline]')).toBeNull();
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')?.disabled,
      ).toBe(true);
    },
  );

  it('keeps an existing empty text frame editable after blur and styles its first text', async () => {
    const onChange = vi.fn();
    const baseline = createEditorDocument();
    const document: ReachDeckDocument = {
      ...baseline,
      resources: {
        ...baseline.resources,
        themes: baseline.resources.themes.map((theme) => ({
          ...theme,
          colors: { ...theme.colors, ink: '#234567' },
          fonts: { ...theme.fonts, body: 'Source Han Sans VF' },
        })),
      },
    };
    nativeTextElement(document, 'title-1').text.doc = {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'));
    if (overlay === null) throw new Error('Expected text frame overlay.');
    act(() => overlay.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const stage = container.querySelector<HTMLElement>('[data-native-v2-stage]');
    act(() => stage?.dispatchEvent(new Event('pointerdown', { bubbles: true })));

    expect(container.querySelector(nativeElementSelector('title-1'))).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    const reopenedOverlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'));
    if (reopenedOverlay === null) throw new Error('Expected retained text frame overlay.');
    act(() => reopenedOverlay.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await replaceInlineEditorText(container, 'Text after reopening');
    await commitInlineEditorText(container);

    const committed = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(nativeTextElement(committed, 'title-1').text.doc.content?.[0]).toMatchObject({
      attrs: { lineHeightPx: 42 },
      content: [
        {
          marks: [
            {
              attrs: {
                color: '#234567',
                fontFamily: 'Source Han Sans VF',
                fontSize: '30px',
              },
              type: 'textStyle',
            },
          ],
          text: 'Text after reopening',
          type: 'text',
        },
      ],
    });
  });

  it('preserves explicit typography when committing edits to existing text', async () => {
    const onChange = vi.fn();
    const document = createEditorDocument();
    const title = nativeTextElement(document, 'title-1');
    title.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Explicit text',
              marks: [
                {
                  type: 'textStyle',
                  attrs: {
                    color: '#ff0000',
                    fontFamily: 'Explicit Font',
                    fontSize: '18px',
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'));
    if (overlay === null) throw new Error('Expected text frame overlay.');
    act(() => overlay.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await replaceInlineEditorText(container, 'Explicit text updated', true);
    await commitInlineEditorText(container);

    const committed = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(
      nativeTextElement(committed, 'title-1').text.doc.content?.[0]?.content?.[0],
    ).toMatchObject({
      marks: [
        {
          attrs: {
            color: '#ff0000',
            fontFamily: 'Explicit Font',
            fontSize: '18px',
          },
          type: 'textStyle',
        },
      ],
      text: 'Explicit text updated',
      type: 'text',
    });
  });

  it('does not add text frames from blank-canvas double-click while disabled or page-locked', () => {
    const disabledChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor disabled document={createEditorDocument()} onChange={disabledChange} />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLElement>('[data-native-v2-stage]')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 400, clientY: 300 })),
    );
    expect(disabledChange).not.toHaveBeenCalled();

    const lockedChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          lockedPageIds={['page-1']}
          onChange={lockedChange}
        />,
      ),
    );
    act(() =>
      container
        .querySelector<HTMLElement>('[data-native-v2-stage]')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 400, clientY: 300 })),
    );
    expect(lockedChange).not.toHaveBeenCalled();
  });

  it('normalizes slide coordinates inside the 16:9 page thumbnail', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));

    const thumbnail = container.querySelector<HTMLElement>('.reach-deck-editor__thumbnail');
    const viewport = thumbnail?.querySelector<HTMLElement>('[data-native-v2-viewport]');
    const stage = thumbnail?.querySelector<HTMLElement>('[data-native-v2-stage]');
    const element = stage?.querySelector<HTMLElement>('[data-native-v2-element-id="title-1"]');

    expect(viewport?.style.width).toBe('100%');
    expect(viewport?.style.aspectRatio).toBe('1600 / 900');
    expect(stage?.style.width).toBe('1600px');
    expect(stage?.style.height).toBe('900px');
    expect(element?.style.left).toBe('80px');
    expect(element?.style.top).toBe('72px');
    expect(element?.style.width).toBe('1100px');
    expect(element?.style.height).toBe('120px');
  });

  it('uses native rich-text styling in thumbnails and the editing toolbar', () => {
    const profiled = createEditorDocument();
    const native = profiled.nativeSlides[0]?.slide;
    const baseText = native?.elements[0];
    if (native === undefined || baseText?.type !== 'textFrame') {
      throw new Error('Expected native text fixture');
    }
    native.background = { kind: 'solid', color: { kind: 'srgb', value: '#0B1220' } };
    native.elements = [
      {
        ...structuredClone(baseText),
        id: 'caption-1',
        text: {
          ...baseText.text,
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Caption',
                    marks: [{ type: 'textStyle', attrs: { color: '#f0f4f8', fontSize: '24px' } }],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        ...structuredClone(baseText),
        id: 'title-profile-1',
        transform: { x: 80, y: 240, width: 600, height: 120 },
        text: {
          ...baseText.text,
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Title',
                    marks: [{ type: 'textStyle', attrs: { color: '#f0f4f8', fontSize: '64px' } }],
                  },
                ],
              },
            ],
          },
        },
      },
    ];

    act(() => root.render(<ReachDeckEditor document={profiled} />));

    const thumbnail = container.querySelector<HTMLElement>('.reach-deck-editor__thumbnail');
    const caption = thumbnail?.querySelector<HTMLElement>(
      '[data-native-v2-element-id="caption-1"] .text-element__paragraph',
    );
    const title = thumbnail?.querySelector<HTMLElement>(
      '[data-native-v2-element-id="title-profile-1"] .text-element__paragraph',
    );
    expect(thumbnail?.querySelector<HTMLElement>('[data-native-v2-stage]')?.style.background).toBe(
      'rgb(11, 18, 32)',
    );
    expect(caption?.querySelector<HTMLElement>('span')?.style.color).toBe('rgb(240, 244, 248)');
    expect(caption?.style.fontSize).toBe('24px');
    expect(title?.style.fontSize).toBe('64px');

    const captionCanvas = container.querySelector<HTMLElement>(
      '[data-native-v2-editable] [data-native-v2-element-id="caption-1"]',
    );
    act(() => captionCanvas?.click());
    expect(sharedSelectValue(container, '字号')).toBe('24');
  });

  it('opens animated slides in their static authored state', () => {
    const document = createEditorDocument();
    const native = document.nativeSlides[0]?.slide;
    if (native === undefined) throw new Error('Expected native slide fixture');
    native.animations = [
      {
        id: 'title-entrance',
        targetId: 'title-1',
        trigger: 'on-enter',
        effect: 'fade',
        start: 1,
        duration: 1,
        easing: 'linear',
        from: { opacity: 0 },
        to: { opacity: 1 },
      },
    ];

    act(() => root.render(<ReachDeckEditor document={document} />));

    const canvasElement = container.querySelector<HTMLElement>(
      '[data-native-v2-editable] [data-native-v2-element-id="title-1"]',
    );
    const thumbnailElement = container.querySelector<HTMLElement>(
      '.reach-deck-editor__thumbnail [data-native-v2-element-id="title-1"]',
    );
    expect(container.querySelector('[aria-label="时间轴播放头"]')).not.toBeNull();
    expect(canvasElement?.style.left).toBe('80px');
    expect(canvasElement?.style.opacity).toBe('1');
    expect(thumbnailElement?.style.left).toBe('80px');
  });

  // 讲稿轴改为固定只读（不可拖拽/不可编辑文本/不可删除），原“编辑讲稿文本 cue-1”
  // 与“键盘移动字幕片段”两个用例测的功能已整体移除，随 v1 语音轨编辑一起删除。

  it('previews the authored timeline continuously from the editor controls', () => {
    vi.useFakeTimers();
    try {
      const document = normalizeReachDeckDocumentV2(createEditorDocument());
      const page = document.pages[0]!;
      document.nativeSlides = [
        {
          pageId: page.pageId,
          slide: {
            schemaVersion: 'reach-deck-slide/v2',
            id: 'native-slide-1',
            title: page.title,
            background: { kind: 'none' },
            elements: [],
            animations: [],
            duration: 20,
          },
        },
      ];
      act(() => root.render(<ReachDeckEditor document={document} />));
      const scroller = container.querySelector<HTMLElement>('.reach-deck-timeline__scroller');
      const scrollTo = vi.fn();
      if (!scroller) throw new Error('timeline scroller not found');
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 100 });
      Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });
      const play = container.querySelector<HTMLButtonElement>('button[aria-label="播放预览"]');
      act(() => play?.click());
      act(() => vi.advanceTimersByTime(3_000));

      expect(container.querySelector('[aria-label="时间轴"]')?.textContent).toContain('3.0s');
      expect(container.querySelector('button[aria-label="暂停预览"]')).not.toBeNull();
      expect(scrollTo.mock.calls.at(-1)?.[0].left).toBeCloseTo(136);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds animation to the selected element and extends duration for later timing', () => {
    const onChange = vi.fn();
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'shape-1',
              type: 'shape',
              name: '形状 1',
              transform: { x: 0, y: 0, width: 100, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
            {
              id: 'shape-2',
              type: 'shape',
              name: '形状 2',
              transform: { x: 120, y: 0, width: 100, height: 100 },
              zIndex: 2,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    act(() =>
      container
        .querySelector<HTMLElement>(
          '[data-native-v2-editable] [data-native-v2-element-id="shape-2"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="添加动画"]')?.click());

    const withAnimation = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    if (withAnimation.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected v2 document');
    }
    const animatedSlide = withAnimation.nativeSlides.find(
      (entry) => entry.pageId === page.pageId,
    )?.slide;
    expect(animatedSlide?.animations[0]?.targetId).toBe('shape-2');

    const start = container.querySelector<HTMLInputElement>(
      '[aria-label="动画片段属性"] input[aria-label="动画开始时间"]',
    );
    act(() => {
      if (start === null) throw new Error('animation start input not found');
      setNativeValue(start, '10');
      start.dispatchEvent(new Event('input', { bubbles: true }));
      // 秒数输入在失焦时提交，输入中间态不回写。
      start.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    const extended = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    if (extended.schemaVersion !== 'reach-deck-document/v2')
      throw new Error('Expected v2 document');
    const extendedSlide = extended.nativeSlides.find(
      (entry) => entry.pageId === page.pageId,
    )?.slide;
    // 动画开始时间被推到 10s，内容末端 10.4s 超过既有时长，页时长随之增长。
    expect(extendedSlide?.duration).toBe(10.4);
  });

  it('does not let an orphan animation stretch the page duration when editing animation timing', () => {
    const onChange = vi.fn();
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    const fade = {
      trigger: 'on-enter' as const,
      effect: 'fade' as const,
      duration: 1,
      easing: 'ease-out' as const,
      from: { opacity: 0 },
      to: { opacity: 1 },
    };
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'shape-1',
              type: 'shape',
              name: '形状 1',
              transform: { x: 0, y: 0, width: 100, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [
            { ...fade, id: 'valid', targetId: 'shape-1', start: 1 },
            // 目标元素已删除的孤儿动画，位于页尾之外。
            { ...fade, id: 'orphan', targetId: 'deleted', start: 100 },
          ],
          duration: 5,
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '.reach-deck-timeline__track.is-animation [role="group"]:not([data-invalid]) .reach-deck-timeline__clip-move',
        )
        ?.click(),
    );
    const start = container.querySelector<HTMLInputElement>(
      '[aria-label="动画片段属性"] input[aria-label="动画开始时间"]',
    );
    act(() => {
      if (start === null) throw new Error('animation start input not found');
      setNativeValue(start, '2');
      start.dispatchEvent(new Event('input', { bubbles: true }));
      start.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    const edited = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    if (edited.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
    const slide = edited.nativeSlides.find((entry) => entry.pageId === page.pageId)?.slide;
    expect(slide?.animations.find((animation) => animation.id === 'valid')?.start).toBe(2);
    expect(slide?.duration).toBe(5);
  });

  it('shows derived page duration and keeps lane ownership in the timeline', () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'shape-1',
              type: 'shape',
              name: '形状 1',
              transform: { x: 0, y: 0, width: 100, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} />));
    // 页面时长/进度改为 header 标题行的只读文本（当前时间 / 派生时长）。
    const duration = container.querySelector('[aria-label="页面时长"]');
    expect(duration?.textContent).toBe('0.0s / 0.1s');
    expect(container.querySelectorAll('.reach-deck-timeline__track.is-animation')).toHaveLength(1);

    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="添加动画轨"]')?.click(),
    );
    expect(container.querySelectorAll('.reach-deck-timeline__track.is-animation')).toHaveLength(2);
    // 未在画布上选中元素时“添加动画”禁用；选中后才能为该元素添加。
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="添加动画"]')?.disabled,
    ).toBe(true);
    act(() =>
      container
        .querySelector<HTMLElement>(
          '[data-native-v2-editable] [data-native-v2-element-id="shape-1"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="添加动画"]')?.click());
    expect(container.querySelector('select[aria-label^="动画轨道 "]')).toBeNull();
    const tracks = container.querySelectorAll('.reach-deck-timeline__track.is-animation');
    expect(tracks[0]?.querySelector('.reach-deck-timeline__clip')).not.toBeNull();
    expect(tracks[1]).not.toBeNull();
  });

  it('drags timeline clips beyond the page duration and removes global listeners on unmount', () => {
    const onChange = vi.fn();
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'shape-1',
              type: 'shape',
              name: '形状',
              transform: { x: 0, y: 0, width: 100, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [
            {
              id: 'anim-drag',
              targetId: 'shape-1',
              trigger: 'on-enter',
              effect: 'fade',
              start: 1,
              duration: 3,
              easing: 'linear',
            },
          ],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    // 讲稿轴不可拖拽，改为对动画片段做同样的“拖出既有时长、卸载移除全局监听”验证。
    const clip = container.querySelector<HTMLElement>('.reach-deck-timeline__clip-move');
    act(() => {
      clip?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 72 }));
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 432 }));
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 432 }));
    });
    const dragged = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    if (dragged.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
    const draggedSlide = dragged.nativeSlides.find((entry) => entry.pageId === page.pageId)?.slide;
    expect(draggedSlide?.animations[0]).toMatchObject({ start: 6, duration: 3 });
    expect(draggedSlide?.duration).toBe(9);

    onChange.mockClear();
    act(() => {
      clip?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 72 }));
    });
    act(() => {
      root.render(null);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 144 }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('formats the whole text box from the toolbar without entering text editing', () => {
    const onChange = vi.fn();
    const document = createEditorDocument();
    const fixtureTitle = nativeTextElement(document, 'title-1');
    fixtureTitle.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'First page',
              marks: [
                { type: 'bold' },
                {
                  type: 'textStyle',
                  attrs: { fontFamily: 'Source Han Sans VF', fontSize: '64px' },
                },
              ],
            },
          ],
        },
      ],
    };
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    const title = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    act(() => title?.click());

    expect(container.querySelector('[aria-label="画布文本"]')).toBeNull();
    expect(container.querySelector('[aria-label="文本格式"][data-placeholder="true"]')).toBeNull();
    expect(sharedSelectOptions(container, '字体')).toEqual(REACH_DECK_BUILT_IN_FONT_FAMILIES);
    expect(sharedSelectValue(container, '字体')).toBe('Source Han Sans VF');
    expect(
      container
        .querySelector<HTMLButtonElement>('button[aria-label="粗体"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    chooseSharedSelectOption(container, '字体', 'Source Han Serif SC');
    expect(sharedSelectValue(container, '字号')).toBe('64');
    expect(sharedSelectOptions(container, '字号')).not.toContain('');
    chooseSharedSelectOption(container, '字号', '20');
    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const element = nativeTextElement(next, 'title-1');
    expect(JSON.stringify(element.text.doc)).toContain('Source Han Serif SC');
    expect(JSON.stringify(element.text.doc)).toContain('20px');

    act(() => title?.click());
    const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'));
    act(() => overlay?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const surface = container.querySelector<HTMLElement>('[aria-label="画布文本"]');
    expect(surface?.querySelector<HTMLElement>('span')?.style.fontFamily).toContain(
      'Source Han Serif SC',
    );
  });

  it('edits whole-box line and character spacing from the properties panel', () => {
    const onChange = vi.fn();
    const document = createEditorDocument();
    const fixtureTitle = nativeTextElement(document, 'title-1');
    fixtureTitle.text.doc.content![0]!.attrs = { lineHeightPx: 48, spaceAfter: 6 };

    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());

    let lineOptions = container.querySelector<HTMLSelectElement>('[aria-label="行距选项"]');
    expect(lineOptions?.selectedOptions[0]?.textContent).toBe('固定值');
    const fixedLineInput =
      container.querySelector<HTMLInputElement>('[aria-label="固定行距（像素）"]');
    expect(fixedLineInput?.value).toBe('48');
    expect(container.querySelector<HTMLInputElement>('[aria-label="字间距（像素）"]')?.value).toBe(
      '0',
    );

    act(() => {
      setNativeValue(fixedLineInput!, '56');
      fixedLineInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => fixedLineInput?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    let next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    let element = nativeTextElement(next, 'title-1');
    expect(element.text.doc.content?.[0]?.attrs).toEqual({ lineHeightPx: 56, spaceAfter: 6 });

    lineOptions = container.querySelector<HTMLSelectElement>('[aria-label="行距选项"]');
    act(() => {
      setNativeValue(lineOptions!, '1.5');
      lineOptions?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    element = nativeTextElement(next, 'title-1');
    expect(element.text.doc.content?.[0]?.attrs).toEqual({ lineHeight: 1.5, spaceAfter: 6 });

    const letterSpacing =
      container.querySelector<HTMLInputElement>('[aria-label="字间距（像素）"]');
    act(() => {
      setNativeValue(letterSpacing!, '2.5');
      letterSpacing?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => letterSpacing?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    element = nativeTextElement(next, 'title-1');
    expect(element.text.doc.content?.[0]?.content?.[0]?.marks).toContainEqual({
      type: 'textStyle',
      attrs: { letterSpacing: 2.5 },
    });
    expect(
      container.querySelector<HTMLElement>(
        `${nativeElementSelector('title-1')} .text-element__paragraph`,
      )?.style.lineHeight,
    ).toBe('1.5');
    expect(
      container.querySelector<HTMLElement>(`${nativeElementSelector('title-1')} span`)?.style
        .letterSpacing,
    ).toBe('2.5px');

    const lineInput = container.querySelector<HTMLInputElement>('[aria-label="行距倍数"]');
    const committedCallCount = onChange.mock.calls.length;
    act(() => {
      setNativeValue(lineInput!, '2');
      lineInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      lineInput?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
    );
    expect(lineInput?.value).toBe('1.5');
    expect(onChange).toHaveBeenCalledTimes(committedCallCount);

    const updatedLetterInput =
      container.querySelector<HTMLInputElement>('[aria-label="字间距（像素）"]');
    act(() => {
      setNativeValue(updatedLetterInput!, '4');
      updatedLetterInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      updatedLetterInput?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      ),
    );
    expect(updatedLetterInput?.value).toBe('2.5');
    expect(onChange).toHaveBeenCalledTimes(committedCallCount);
  });

  it('keeps character spacing on an empty text box after the controlled document updates', () => {
    const onChange = vi.fn();
    const document = createEditorDocument();
    nativeTextElement(document, 'title-1').text.doc = {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };

    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    const letterSpacing =
      container.querySelector<HTMLInputElement>('[aria-label="字间距（像素）"]');
    expect(letterSpacing?.value).toBe('0');

    act(() => {
      setNativeValue(letterSpacing!, '3');
      letterSpacing?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => letterSpacing?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));

    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    expect(nativeTextElement(next, 'title-1').text.doc.content?.[0]?.attrs).toEqual({
      defaultLetterSpacing: 3,
    });
    act(() => root.render(<ReachDeckEditor document={next} onChange={onChange} />));
    expect(container.querySelector<HTMLInputElement>('[aria-label="字间距（像素）"]')?.value).toBe(
      '3',
    );
  });

  it('shows imported numeric font sizes without restoring a default-size option', () => {
    const document = createEditorDocument();
    const title = nativeTextElement(document, 'title-1');
    title.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Imported size',
              marks: [{ type: 'textStyle', attrs: { fontSize: '18.5px' } }],
            },
          ],
        },
      ],
    };

    act(() => root.render(<ReachDeckEditor document={document} />));
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());

    expect(sharedSelectValue(container, '字号')).toBe('18.5');
    expect(sharedSelectOptions(container, '字号')).toContain('18.5');
    expect(sharedSelectOptions(container, '字号')).not.toContain('默认字号');
  });

  it('uses a non-actionable dash for mixed sizes instead of a default font size', () => {
    const document = createEditorDocument();
    const title = nativeTextElement(document, 'title-1');
    title.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Mixed',
              marks: [{ type: 'textStyle', attrs: { fontSize: '18px' } }],
            },
            {
              type: 'text',
              text: ' sizes',
              marks: [{ type: 'textStyle', attrs: { fontSize: '24px' } }],
            },
          ],
        },
      ],
    };

    act(() => root.render(<ReachDeckEditor document={document} />));
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());

    expect(sharedSelectValue(container, '字号')).toBe('—');
    expect(sharedSelectOptions(container, '字号')).not.toContain('—');
  });

  it('shows the concrete generated formula size in the slide toolbar', () => {
    const document = createEditorDocument();
    const title = nativeTextElement(document, 'title-1');
    title.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'blockMath', attrs: { latex: 'E=mc^2', fontSize: '64px' } }],
        },
      ],
    };

    act(() => root.render(<ReachDeckEditor document={document} />));
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());

    expect(sharedSelectValue(container, '字号')).toBe('64');
    expect(sharedSelectOptions(container, '字号')).not.toContain('默认字号');
  });

  it('restores the character selection before applying a font from the toolbar', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    const title = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    act(() => title?.click());
    const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'));
    act(() => overlay?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));

    const surface = container.querySelector<HTMLElement>('[aria-label="画布文本"]');
    const textNode = surface?.querySelector('p')?.firstChild;
    act(() => {
      if (!(textNode instanceof Text)) throw new Error('editable text node not found');
      const range = window.document.createRange();
      range.setStart(textNode, 1);
      range.setEnd(textNode, 3);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      window.document.dispatchEvent(new Event('selectionchange'));
    });

    chooseSharedSelectOption(container, '字体', 'Source Han Serif SC');
    act(() => {
      surface?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Enter' }),
      );
    });

    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
    const element = nativeTextElement(next, 'title-1');
    const json = JSON.stringify(element.text.doc);
    expect(json).toContain('Source Han Serif SC');
    expect(json).toContain('"text":"ir"');
  });

  it('keeps the PowerPoint-style toolbar visible and places the timeline under the canvas', () => {
    // 时间轴只在存在 native slide 绑定时渲染，这里用 v2 夹具补齐该前提。
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} />));

    const placeholder = container.querySelector<HTMLElement>(
      '.reach-deck-editor__rich-text-toolbar[data-placeholder="true"]',
    );
    expect(placeholder).not.toBeNull();
    expect(placeholder?.closest('.reach-deck-editor__inspector-toolbar')).not.toBeNull();
    expect(placeholder?.closest('#reach-deck-right-panel-properties')).not.toBeNull();
    expect(container.querySelector('.reach-deck-editor__toolbar')).toBeNull();
    const placeholderFont = placeholder?.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="字体"]',
    );
    expect(placeholderFont?.disabled).toBe(true);
    expect(placeholderFont?.textContent?.trim()).toBe('Source Han Sans VF');
    const placeholderFontSize = placeholder?.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="字号"]',
    );
    expect(placeholderFontSize?.disabled).toBe(true);
    expect(placeholderFontSize?.textContent?.trim()).toBe('—');
    expect(
      placeholder?.querySelector<HTMLButtonElement>('button[aria-label="上标"]')?.disabled,
    ).toBe(true);

    const timeline = container.querySelector<HTMLElement>('[aria-label="时间轴"]');
    expect(timeline?.parentElement?.classList.contains('reach-deck-editor__preview')).toBe(true);
  });

  it('时间轴常驻渲染：外层 view-controls 已删除，收起/展开由自身 header 控制', () => {
    // 时间轴只在存在 native slide 绑定时渲染，这里用 v2 夹具补齐该前提。
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
        },
      },
    ];
    act(() => root.render(<ReachDeckEditor document={document} />));

    // 常驻：无需外层开关直接挂载；画布上方的旧 view-controls 区块不复存在。
    expect(container.querySelector('[aria-label="时间轴"]')).not.toBeNull();
    expect(container.querySelector('.reach-deck-editor__view-controls')).toBeNull();

    // header 自带收起：内容保持挂载（高度过渡动画需要），以 data-collapsed + inert 表达收起态；
    // 视图切换和轨道向操作与播放/进度共用常驻单行 header。
    const collapse = container.querySelector<HTMLButtonElement>(
      '.reach-deck-timeline button[aria-label="收起时间轴"]',
    );
    expect(collapse).not.toBeNull();
    act(() => collapse!.click());
    expect(container.querySelector('.reach-deck-timeline[data-collapsed]')).not.toBeNull();
    expect(container.querySelector('.reach-deck-timeline__collapsible[inert]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="添加动画"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="播放预览"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="时间轴"]')).not.toBeNull();

    // 编辑禁用时时间轴仍常驻渲染。
    act(() => root.render(<ReachDeckEditor disabled document={document} />));
    expect(container.querySelector('[aria-label="时间轴"]')).not.toBeNull();
  });

  it('opens regeneration choices from the canvas without running old generation commands', () => {
    const request = vi.fn();
    const direct = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onRequestRegenerationPage={request}
          onRegeneratePage={direct}
          onRegeneratePageNarration={direct}
          onSavePageNarrationAudio={direct}
          onSavePageNarrationDraft={vi.fn()}
        />,
      ),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="重新生成本页"]')!.click(),
    );
    expect(request).toHaveBeenCalledWith('page-1');
    expect(direct).not.toHaveBeenCalled();
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((tab) => tab.textContent === '讲稿')!
        .click(),
    );
    expect(container.querySelector('[aria-label="更多讲稿操作"]')).toBeNull();
    expect(container.querySelector('[aria-label="保存选项"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="仅生成本页音频"]')).toBeNull();
  });

  it('prepares offscreen dirty Interactive narration without starting audio', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    let prepare: ((pageId?: string) => Promise<void>) | undefined;
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn();
    const register = (value: typeof prepare) => {
      prepare = value;
    };
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageInteractiveNarrationEditorDocument()}
          onRegisterRegenerationPreparation={register}
          onSaveInteractivePageNarrationDraft={onSaveDraft}
          onSaveInteractivePageNarrationAndGenerate={generate}
        />,
      ),
    );
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((tab) => tab.textContent === '讲稿')!
        .click(),
    );
    await replaceInteractiveNarrationText(container, 'Unsaved first page');
    const second = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')]
      .find((item) => item.textContent?.includes('第二个互动探索'))!
      .querySelector<HTMLElement>('[data-page-card]')!;
    act(() => second.click());
    await replaceInteractiveNarrationText(container, 'Unsaved second page');
    await act(async () => prepare!('interactive-page'));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    expect(onSaveDraft.mock.calls[0]![0]).toMatchObject({
      pageId: 'interactive-page',
      text: 'Unsaved first page',
    });
    await act(async () => prepare!());
    expect(onSaveDraft).toHaveBeenCalledTimes(2);
    expect(onSaveDraft.mock.calls[1]![0]).toMatchObject({ text: 'Unsaved second page' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('skips a cached narration draft whose page was deleted when saving every draft', async () => {
    // 宿主的右上角「保存」会保存所有页的讲稿草稿；已删除页的草稿不能把整份保存挡住。
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    let prepare: ((pageId?: string) => Promise<void>) | undefined;
    const onSaveDraft = vi.fn().mockResolvedValue(undefined);
    const register = (value: typeof prepare) => {
      prepare = value;
    };
    const document = createTwoPageInteractiveNarrationEditorDocument();
    const render = (value: typeof document) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            document={value}
            onRegisterRegenerationPreparation={register}
            onSaveInteractivePageNarrationDraft={onSaveDraft}
          />,
        ),
      );
    render(document);
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((tab) => tab.textContent === '讲稿')!
        .click(),
    );
    await replaceInteractiveNarrationText(container, 'Unsaved deleted page');
    const remaining = document.pages.filter((page) => page.pageId !== 'interactive-page');
    render({ ...document, pages: remaining.map((page, index) => ({ ...page, order: index + 1 })) });

    await act(async () => prepare!());
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it('画布右上角"重新生成本页"图标：接线时按当前页回调，未接线不渲染', () => {
    const document = createEditorDocument();
    const onRegeneratePage = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={document} onRegeneratePage={onRegeneratePage} />),
    );

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="重新生成本页"]');
    expect(button).not.toBeNull();
    const cornerActions = button?.closest('.reach-deck-editor__canvas-corner-actions');
    const cornerRow = cornerActions?.children[0];
    expect(cornerRow?.classList).toContain('reach-deck-editor__canvas-corner-row');
    expect(cornerRow?.children[0]).toBe(button);
    expect(cornerActions?.children[1]?.classList).toContain('reach-deck-editor__document-history');
    expect(cornerActions?.querySelector('[aria-label="撤销课件修改"]')).not.toBeNull();
    expect(cornerActions?.querySelector('[aria-label="重做课件修改"]')).not.toBeNull();
    expect(
      container.querySelector(
        '.reach-deck-editor__workspace-command-bar .reach-deck-editor__document-history',
      ),
    ).toBeNull();
    act(() => button!.click());
    expect(onRegeneratePage).toHaveBeenCalledWith(document.pages[0]!.pageId);

    act(() => root.render(<ReachDeckEditor document={document} />));
    expect(container.querySelector('button[aria-label="重新生成本页"]')).toBeNull();
  });

  it('renders the host canvas action left of "重新生成本页" in the same corner row', () => {
    const document = createEditorDocument();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          onRegeneratePage={vi.fn()}
          workspaceCanvasAction={<button data-host-canvas-action type="button" />}
        />,
      ),
    );
    const row = container.querySelector('.reach-deck-editor__canvas-corner-row');
    expect(row?.children[0]?.hasAttribute('data-host-canvas-action')).toBe(true);
    expect(row?.children[1]?.getAttribute('aria-label')).toBe('重新生成本页');

    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          workspaceCanvasAction={<button data-host-canvas-action type="button" />}
        />,
      ),
    );
    expect(container.querySelector('.reach-deck-editor__canvas-corner-row')?.children).toHaveLength(
      1,
    );
    act(() => root.render(<ReachDeckEditor document={document} />));
    expect(container.querySelector('.reach-deck-editor__canvas-corner-row')).toBeNull();
  });

  it('shows per-page lane indicators on the rail thumbnails', () => {
    const document = createEditorDocument();
    const binding = document.nativeSlides[0]!;
    act(() =>
      root.render(
        <ReachDeckEditor
          batchStatusByPageId={{
            'page-1': {
              accessibleLabel: '音频和动画批次：生成中',
              batchId: 'batch-1',
              kind: 'media',
              status: 'running',
            },
          }}
          document={{
            ...document,
            nativeSlides: [
              {
                ...binding,
                slide: {
                  ...binding.slide,
                  narration: {
                    markdown: '讲稿',
                    audioResourceId: 'audio-1',
                    segments: [{ text: '讲稿', start: 0, end: 1 }],
                  },
                },
              },
            ],
            resources: {
              ...document.resources,
              media: [
                {
                  id: 'audio-1',
                  objectKey: 'uploads/deck/audio/audio-1.mp3',
                  contentType: 'audio/mpeg',
                  digest: `sha256:${'c'.repeat(64)}`,
                },
              ],
            },
          }}
        />,
      ),
    );
    const lanes = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__page-lane')];
    expect(lanes.map((lane) => [lane.dataset.lane, lane.dataset.state])).toEqual([
      ['layout', 'ready'],
      ['narration', 'ready'],
      ['audio', 'generating'],
      ['animation', 'generating'],
    ]);
    expect(lanes[2]?.getAttribute('aria-label')).toBe('语音：生成中');
  });

  it('does not render the removed canvas focus button', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));

    expect(container.querySelector('button[aria-label="放大画布"]')).toBeNull();
  });

  it('owns the editor wheel gesture and scrolls the full-width canvas vertically', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));

    const preview = container.querySelector<HTMLElement>('.reach-deck-editor__preview');
    if (preview === null) throw new Error('preview not found');
    Object.defineProperties(preview, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 180 });
    act(() => preview.querySelector('.reach-deck-player__stage')?.dispatchEvent(wheel));

    expect(preview.scrollTop).toBe(180);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it('leaves wheel gestures inside the quiz card to its own scroll container', () => {
    let sequence = 0;
    const added = addReachDeckPage(createEditorDocument(), {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory: (prefix) => `${prefix}-wheel-${++sequence}`,
    });
    const document = deleteReachDeckPage(added, 'page-1');
    act(() => root.render(<ReachDeckEditor document={document} />));

    const preview = container.querySelector<HTMLElement>('.reach-deck-editor__preview');
    const quizCanvas = container.querySelector<HTMLElement>('.reach-deck-editor__quiz-canvas');
    const quizField = quizCanvas?.querySelector<HTMLElement>(
      '.reach-deck-editor__rich-text-surface',
    );
    if (preview === null || quizCanvas === null || quizField == null)
      throw new Error('quiz scroll containers not found');
    Object.defineProperties(preview, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    Object.defineProperties(quizCanvas, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 180 });
    act(() => quizField.dispatchEvent(wheel));

    expect(preview.scrollTop).toBe(0);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it('opens Tiptap in place on canvas double click and exposes formatting in the top toolbar', () => {
    const onChange = vi.fn();
    const formatted = createEditorDocument();
    const title = nativeTextElement(formatted, 'title-1');
    title.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                { type: 'bold' },
                { type: 'textStyle', attrs: { color: '#ff0000', fontSize: '48px' } },
              ],
              text: '保留格式',
            },
          ],
        },
      ],
    };
    act(() => root.render(<ReachDeckEditor document={formatted} onChange={onChange} />));

    const canvasText = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    act(() => {
      if (canvasText === null) throw new Error('canvas text element not found');
      canvasText.click();
    });
    const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'));
    act(() => overlay?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));

    const surface = container.querySelector<HTMLElement>('[aria-label="画布文本"]');
    expect(surface).not.toBeNull();
    expect(
      container.querySelector('[data-native-v2-text-frame] [data-rich-text-inline]'),
    ).not.toBeNull();
    expect(container.querySelector(nativeOverlaySelector('title-1'))).toBeNull();
    expect(surface?.querySelector('strong')?.textContent).toBe('保留格式');
    const styledText = surface?.querySelector<HTMLElement>('span[style]');
    expect(styledText?.style.fontSize).toBe('48px');
    expect(styledText?.style.color).toBe('rgb(255, 0, 0)');

    const bold = container.querySelector<HTMLButtonElement>('button[aria-label="粗体"]');
    const superscript = container.querySelector<HTMLButtonElement>('button[aria-label="上标"]');
    const subscript = container.querySelector<HTMLButtonElement>('button[aria-label="下标"]');
    expect(bold).not.toBeNull();
    expect(bold?.disabled).toBe(false);
    expect(superscript?.disabled).toBe(false);
    expect(subscript?.disabled).toBe(false);
    expect(sharedSelectOptions(container, '字体')).toEqual(REACH_DECK_BUILT_IN_FONT_FAMILIES);
    expect(sharedSelectValue(container, '字号')).toBe('48');
    expect(sharedSelectOptions(container, '字号')).not.toContain('默认字号');
  });

  it('opens Tiptap when the selected transform overlay receives the second click', () => {
    act(() => root.render(<ReachDeckEditor document={createEditorDocument()} />));
    const canvasText = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    act(() => canvasText?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'));
    expect(overlay).not.toBeNull();

    act(() =>
      overlay?.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 100 }),
      ),
    );

    expect(container.querySelector('[aria-label="画布文本"]')).not.toBeNull();
    expect(container.querySelector(nativeOverlaySelector('title-1'))).toBeNull();
  });

  it('cancels in-place text editing with Escape without mutating the document', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={createEditorDocument()} onChange={onChange} />),
    );
    const canvasText = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    act(() => canvasText?.click());
    const overlay = container.querySelector<HTMLElement>(nativeOverlaySelector('title-1'));
    act(() => overlay?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    const surface = container.querySelector<HTMLElement>('[aria-label="画布文本"]');
    act(() =>
      surface?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
    );
    expect(container.querySelector('[aria-label="画布文本"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows Decksmith as a status-only panel while the deck is generating', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantStatus="课件正在生成，完成后即可使用 Decksmith。"
          disabled
          document={createEditorDocument()}
        />,
      ),
    );

    const decksmith = container.querySelector('section[aria-label="Decksmith"]');
    expect(decksmith?.textContent).toContain('课件正在生成');
    expect(decksmith?.querySelector('[aria-label="AI 快捷指令"]')).toBeNull();
    expect(decksmith?.querySelector('#reach-deck-assistant-prompt')).toBeNull();
  });

  it('keeps Decksmith conversation actions in its header without collaboration copy', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createEditorDocument()}
          onAssistantDeleteConversation={vi.fn()}
          onAssistantNewTopic={vi.fn()}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );

    const decksmith = container.querySelector('section[aria-label="Decksmith"]');
    const header = decksmith?.querySelector('header');
    const actions = header?.querySelector('.reach-deck-editor__assistant-history-actions');
    expect(actions).not.toBeNull();
    expect(actions?.querySelector('button[aria-label="新话题"]')).not.toBeNull();
    expect(actions?.querySelector('button[aria-label="清除当前对话"]')).not.toBeNull();
    expect(decksmith?.textContent).not.toContain('正在协作编辑');
  });

  it('keeps composer input and focus when the host replaces its page-change callback', () => {
    const deck = createTwoPageEditorDocument();
    const onAssistantPrompt = vi.fn();
    const firstPageChange = vi.fn();
    const nextPageChange = vi.fn();
    const render = (onAssistantPageChange: (pageId: string) => void) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            document={deck}
            onAssistantPageChange={onAssistantPageChange}
            onAssistantPrompt={onAssistantPrompt}
          />,
        ),
      );
    render(firstPageChange);
    const composer = container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    act(() => {
      composer.focus();
      setNativeValue(composer, '正在输入的修改请求');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    render(nextPageChange);
    expect(composer.value).toBe('正在输入的修改请求');
    expect(document.activeElement).toBe(composer);
    expect(firstPageChange).toHaveBeenCalledTimes(1);
    expect(nextPageChange).not.toHaveBeenCalled();
    act(() =>
      [...container.querySelectorAll<HTMLElement>('[data-page-card]')]
        .find((page) => page.textContent?.includes('Second page'))
        ?.click(),
    );
    expect(nextPageChange).toHaveBeenCalledExactlyOnceWith('page-2');
    expect(composer.value).toBe('');
  });

  it.each(['running', 'generation', 'proposal'])(
    'allows drafting while %s prevents sending a Decksmith request',
    async (block) => {
      const deck = createEditorDocument();
      const onAssistantPrompt = vi.fn();
      act(() =>
        root.render(
          <ReachDeckEditor
            document={deck}
            onAssistantPrompt={onAssistantPrompt}
            {...(block === 'running' ? { assistantJobPageIds: ['page-1'] } : {})}
            {...(block === 'generation'
              ? { assistantBlockedReason: 'Generation in progress' }
              : {})}
            {...(block === 'proposal'
              ? {
                  assistantRecovery: {
                    id: 'pending-proposal',
                    pageId: 'page-1',
                    state: 'ready' as const,
                    response: {
                      document: withFirstPageTitle(deck, 'Pending change', 2),
                      message: 'Review this change',
                      runtimeApprovalId: 'pending-approval',
                    },
                  },
                }
              : {})}
          />,
        ),
      );
      const composer = container.querySelector<HTMLTextAreaElement>(
        '#reach-deck-assistant-prompt',
      )!;
      expect(composer.disabled).toBe(false);
      act(() => {
        composer.focus();
        setNativeValue(composer, '下一条修改请求');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(document.activeElement).toBe(composer);
      expect(
        composer.form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
      ).toBe(true);
      await act(async () => composer.form?.requestSubmit());
      expect(onAssistantPrompt).not.toHaveBeenCalled();
      expect(composer.value).toBe('下一条修改请求');
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'shows one localized welcome on every page through empty history hydration in %s',
    async (locale) => {
      const deck = createTwoPageEditorDocument();
      const welcome = locale === 'zh-CN' ? '中文欢迎语' : 'English welcome';
      const render = (pageId: string, loading: boolean) =>
        act(() =>
          root.render(
            <ReachDeckEditor
              assistantHistory={{ pageId, loading, hasOlder: false, entries: [] }}
              document={deck}
              locale={locale}
              onAssistantPrompt={vi.fn()}
              translate={(key) => (key === 'reachDeck.editor.assistant.intro' ? welcome : key)}
            />,
          ),
        );
      const expectWelcome = () => {
        const messages = container.querySelectorAll('.reach-deck-editor__assistant-message');
        expect([...messages].filter((message) => message.textContent === welcome)).toHaveLength(1);
      };
      const openPage = (title: string) =>
        act(() =>
          [...container.querySelectorAll<HTMLElement>('[data-page-card]')]
            .find((page) => page.textContent?.includes(title))
            ?.click(),
        );
      render('page-1', false);
      expectWelcome();
      openPage('Second page');
      render('page-2', true);
      expectWelcome();
      render('page-2', false);
      expectWelcome();
      openPage('First page');
      expectWelcome();
      openPage('Second page');
      expectWelcome();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'uses the shared brand loader while Decksmith loads and removes it when ready in %s',
    (locale) => {
      const deck = createEditorDocument();
      const onAssistantPrompt = vi.fn();
      const copy =
        locale === 'zh-CN'
          ? {
              'reachDeck.editor.assistant.loadingHistory': '正在加载本页对话…',
              'reachDeck.editor.assistant.loadingOlder': '正在加载更早消息…',
              'reachDeck.editor.assistant.reconnecting': '连接中断，正在重连…',
              'reachDeck.editor.assistant.thinking': '正在理解课件结构并修改…',
            }
          : {
              'reachDeck.editor.assistant.loadingHistory': 'Loading this page’s conversation…',
              'reachDeck.editor.assistant.loadingOlder': 'Loading earlier messages…',
              'reachDeck.editor.assistant.reconnecting': 'Connection lost. Reconnecting…',
              'reachDeck.editor.assistant.thinking': 'Understanding and editing the deck…',
            };
      const render = (state: 'history' | 'older' | 'reconnecting' | 'thinking' | 'ready') =>
        act(() =>
          root.render(
            <ReachDeckEditor
              assistantConnectionState={state === 'reconnecting' ? 'reconnecting' : undefined}
              assistantHistory={{
                pageId: 'page-1',
                loading: state === 'history',
                loadingOlder: state === 'older',
                hasOlder: true,
                entries: [],
              }}
              assistantJobPageIds={state === 'thinking' ? ['page-1'] : []}
              document={deck}
              locale={locale}
              onAssistantLoadOlder={vi.fn()}
              onAssistantPrompt={onAssistantPrompt}
              translate={(key) => copy[key as keyof typeof copy] ?? key}
            />,
          ),
        );
      for (const [state, key] of [
        ['history', 'reachDeck.editor.assistant.loadingHistory'],
        ['older', 'reachDeck.editor.assistant.loadingOlder'],
        ['reconnecting', 'reachDeck.editor.assistant.reconnecting'],
        ['thinking', 'reachDeck.editor.assistant.thinking'],
      ] as const) {
        render(state);
        const loader = container.querySelector('.rx-brand-loader');
        expect(loader?.getAttribute('aria-hidden')).toBe('true');
        expect(loader?.closest('[aria-busy="true"]')?.textContent).toContain(copy[key]);
        const overlay = container.querySelector('.reach-deck-editor__assistant-loading-overlay');
        const coversConversation = state === 'history' || state === 'reconnecting';
        expect(overlay !== null).toBe(coversConversation);
        expect(
          container.querySelector('.reach-deck-editor__assistant-messages')?.hasAttribute('inert'),
        ).toBe(coversConversation);
        if (coversConversation) {
          expect(overlay?.parentElement?.className).toBe(
            'reach-deck-editor__assistant-conversation',
          );
          expect(loader?.classList.contains('rx-brand-loader-lg')).toBe(true);
        } else {
          expect(loader?.classList.contains('rx-brand-loader-sm')).toBe(true);
        }
        const composer = container.querySelector<HTMLTextAreaElement>(
          '#reach-deck-assistant-prompt',
        )!;
        act(() => composer.focus());
        expect(document.activeElement).toBe(composer);
        render('ready');
        expect(container.querySelector('.rx-brand-loader')).toBeNull();
        expect(container.querySelector('[aria-busy="true"]')).toBeNull();
        expect(document.activeElement).toBe(composer);
      }
    },
  );

  it('keeps hydrated histories isolated by page and renders a visible New topic boundary', async () => {
    const onAssistantLoadOlder = vi.fn();
    const onAssistantNewTopic = vi.fn();
    const onAssistantPageChange = vi.fn();
    const document = createTwoPageEditorDocument();
    const pageAHistory = {
      pageId: 'page-1',
      loading: false,
      hasOlder: false,
      entries: [
        { id: 'run-a:user', kind: 'message' as const, role: 'user' as const, text: 'Page A only' },
      ],
    };
    const pageBHistory = {
      pageId: 'page-2',
      loading: false,
      hasOlder: true,
      entries: [
        {
          id: 'boundary-b',
          kind: 'new-topic' as const,
          messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
          replacements: {},
        },
        {
          id: 'run-b:assistant',
          kind: 'message' as const,
          role: 'assistant' as const,
          text: 'Page B only',
        },
      ],
    };
    const renderEditor = (assistantHistory: typeof pageAHistory | typeof pageBHistory) =>
      root.render(
        <ReachDeckEditor
          assistantHistory={assistantHistory}
          document={document}
          onAssistantLoadOlder={onAssistantLoadOlder}
          onAssistantNewTopic={onAssistantNewTopic}
          onAssistantPageChange={onAssistantPageChange}
          onAssistantPrompt={vi.fn()}
        />,
      );

    act(() => renderEditor(pageAHistory));
    await act(async () => Promise.resolve());
    expect(container.querySelector('[role="log"]')?.textContent).toContain('Page A only');
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain('Page B only');

    act(() => renderEditor(pageBHistory));
    await act(async () => Promise.resolve());
    const pageB = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li > [data-page-card]'),
    ].find((page) => page.textContent?.includes('Second page'));
    await act(async () => pageB?.click());
    expect(container.querySelector('[role="log"]')?.textContent).toContain('Page B only');
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain('Page A only');
    expect(container.querySelector('[role="separator"]')).not.toBeNull();

    const newTopic = container.querySelector<HTMLButtonElement>('button[aria-label="新话题"]');
    await act(async () => newTopic?.click());
    expect(onAssistantNewTopic).toHaveBeenCalledWith('page-2');

    const older = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '加载更早消息',
    );
    await act(async () => older?.click());
    expect(onAssistantLoadOlder).toHaveBeenCalledWith('page-2');

    const pageA = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li > [data-page-card]'),
    ].find((page) => page.textContent?.includes('First page'));
    await act(async () => pageA?.click());
    expect(container.querySelector('[role="log"]')?.textContent).toContain('Page A only');
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain('Page B only');
    expect(onAssistantPageChange).toHaveBeenCalledWith('page-1');
    expect(onAssistantPageChange).toHaveBeenCalledWith('page-2');
  });

  it('renders allowlisted capacity guidance in order and reuses the New topic action', async () => {
    const onAssistantNewTopic = vi.fn();
    const translate = (key: string) =>
      ({
        'reachDeck.decksmith.capacity.ordinary': 'Context is ready.',
        'reachDeck.decksmith.capacity.compacting': 'Earlier context was condensed.',
        'reachDeck.decksmith.capacity.blocked': 'This conversation cannot continue safely.',
        'reachDeck.decksmith.capacity.startNewTopic':
          'Start a new topic while keeping these messages visible.',
        'reachDeck.editor.assistant.newTopic': 'New topic',
      })[key] ?? key;
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantHistory={{
            pageId: 'page-1',
            loading: false,
            hasOlder: false,
            entries: [
              {
                id: 'ordinary',
                kind: 'application-message',
                state: 'ordinary',
                messageKey: 'reachDeck.decksmith.capacity.ordinary',
              },
              {
                id: 'compacting',
                kind: 'application-message',
                state: 'needs_compaction',
                messageKey: 'reachDeck.decksmith.capacity.compacting',
              },
              {
                id: 'blocked',
                kind: 'application-message',
                state: 'blocked',
                messageKey: 'reachDeck.decksmith.capacity.blocked',
                guidance: {
                  action: 'new-topic',
                  messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
                },
              },
              {
                id: 'malformed',
                kind: 'application-message',
                state: 'blocked',
                messageKey: 'server-controlled-copy',
                guidance: {
                  action: 'new-topic',
                  messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
                },
              } as never,
            ],
          }}
          document={createEditorDocument()}
          onAssistantNewTopic={onAssistantNewTopic}
          onAssistantPrompt={vi.fn()}
          translate={translate}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    const states = [...container.querySelectorAll<HTMLElement>('[data-decksmith-capacity-state]')];
    expect(states.map((message) => message.dataset.decksmithCapacityState)).toEqual([
      'ordinary',
      'needs_compaction',
      'blocked',
    ]);
    expect(container.querySelector('[role="log"]')?.textContent).toContain('Context is ready.');
    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      'Earlier context was condensed.',
    );
    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      'Start a new topic while keeping these messages visible.',
    );
    expect(container.querySelector('[role="log"]')?.textContent).not.toMatch(
      /server-controlled-copy|token|byte|12345/i,
    );

    const blockedAction = states
      .find((message) => message.dataset.decksmithCapacityState === 'blocked')
      ?.querySelector<HTMLButtonElement>('button');
    await act(async () => blockedAction?.click());
    expect(onAssistantNewTopic).toHaveBeenCalledWith('page-1');
  });

  it('confirms current-page deletion, clears its visible column, and reports failures', async () => {
    const onAssistantDeleteConversation = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('delete unavailable'));
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantHistory={{
            pageId: 'page-1',
            loading: false,
            hasOlder: false,
            entries: [
              {
                id: 'old-message',
                kind: 'message',
                role: 'assistant',
                text: 'Delete this history',
              },
            ],
          }}
          document={createEditorDocument()}
          onAssistantDeleteConversation={onAssistantDeleteConversation}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );
    await act(async () => Promise.resolve());
    const deleteButton = container.querySelector<HTMLButtonElement>('button[title="清除当前对话"]');

    await act(async () => deleteButton?.click());
    const deleteConfirmation = window.document.querySelector('[role="alertdialog"]');
    expect(deleteConfirmation?.textContent).toContain('隐藏当前页的全部 Decksmith 对话');
    const deleteCancelButton = [...(deleteConfirmation?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '取消',
    );
    await act(async () => deleteCancelButton?.click());
    expect(onAssistantDeleteConversation).not.toHaveBeenCalled();

    await act(async () => deleteButton?.click());
    const secondDeleteConfirmation = window.document.querySelector('[role="alertdialog"]');
    await act(async () =>
      [...(secondDeleteConfirmation?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onAssistantDeleteConversation).toHaveBeenCalledWith('page-1');
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Delete this history',
    );

    await act(async () => deleteButton?.click());
    const failedDeleteConfirmation = window.document.querySelector('[role="alertdialog"]');
    await act(async () =>
      [...(failedDeleteConfirmation?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('delete unavailable');
  });

  it('当前页 chip 报实时位置，而不是导入时写死的标题页码', () => {
    // PPTX 导入把标题写成 "Slide N"；在前面插页之后，标题里的页码就与实际位置错开。
    const document = createTwoPageEditorDocument();
    const staleTitles: ReachDeckDocument = {
      ...document,
      pages: document.pages.map((page, index) => ({
        ...page,
        title: `Slide ${String(index)}`,
      })),
    };
    act(() => root.render(<ReachDeckEditor document={staleTitles} onAssistantPrompt={vi.fn()} />));

    const chipLabel = () =>
      container.querySelector('.reach-deck-editor__assistant-current-page-label')?.textContent;
    expect(chipLabel()).toBe('当前页：第 1 页 · Slide 0');

    const secondPage = [...container.querySelectorAll<HTMLElement>('[data-page-card]')].find(
      (page) => page.textContent?.includes('Slide 1'),
    )!;
    act(() => secondPage.click());
    expect(chipLabel()).toBe('当前页：第 2 页 · Slide 1');
  });

  it('creates and removes structured @page chips with keyboard selection', async () => {
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      historyRunId: 'run-with-mention',
      message: 'Mention accepted',
      originPageId: 'page-1',
    });
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onAssistantPrompt={onAssistantPrompt}
        />,
      ),
    );
    const composer = container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    act(() => {
      setNativeValue(composer, '@Sec');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain('Second page');
    act(() =>
      composer.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    const removeMention = container.querySelector<HTMLButtonElement>(
      '[aria-label="移除页面引用 Second page"]',
    );
    expect(removeMention?.textContent).toContain('@Second page');
    const removeCurrentPage = container.querySelector<HTMLButtonElement>(
      '[aria-label="移除当前页面上下文"]',
    );
    expect(removeCurrentPage).not.toBeNull();
    act(() => removeCurrentPage?.click());
    const addCurrentPage = container.querySelector<HTMLButtonElement>(
      '[aria-label="添加当前页面上下文"]',
    );
    expect(addCurrentPage).not.toBeNull();
    expect(addCurrentPage?.dataset.included).toBe('false');
    expect(addCurrentPage?.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      setNativeValue(composer, '仅参考引用页面');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = composer.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => send?.click());
    expect(onAssistantPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        includeCurrentPage: false,
        mentionedPageIds: ['page-2'],
        pageId: 'page-1',
      }),
    );

    act(() => addCurrentPage?.click());
    const restoredCurrentPage = container.querySelector<HTMLButtonElement>(
      '[aria-label="移除当前页面上下文"]',
    );
    expect(restoredCurrentPage).not.toBeNull();
    expect(restoredCurrentPage?.dataset.included).toBe('true');
    expect(restoredCurrentPage?.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      setNativeValue(composer, '参考引用页面');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => send?.click());
    expect(onAssistantPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        includeCurrentPage: true,
        mentionedPageIds: ['page-2'],
        pageId: 'page-1',
      }),
    );
    act(() => removeMention?.click());
    expect(container.querySelector('[aria-label="移除页面引用 Second page"]')).toBeNull();

    act(() => {
      setNativeValue(composer, '@Sec');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const mouseOption = container.querySelector<HTMLButtonElement>(
      '[role="option"]:not([data-page-card])',
    );
    act(() => mouseOption?.click());
    expect(container.querySelector('[aria-label="移除页面引用 Second page"]')).not.toBeNull();

    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    await act(async () => Promise.resolve());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('引用页面已删除');
  });

  it('clears native component focus on page switch and marks background-page completion', async () => {
    const onAssistantPrompt = vi.fn().mockResolvedValue({ message: 'Done on page B' });
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantBackgroundPageIds={['page-2']}
          document={createTwoPageEditorDocument()}
          onAssistantPrompt={onAssistantPrompt}
        />,
      ),
    );
    const canvasTitle = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    act(() => canvasTitle?.click());
    expect(
      container.querySelector('[aria-label="移除组件聚焦 文本框：First page"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Decksmith 已完成此页面的回复"]')).not.toBeNull();

    const pageB = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li > [data-page-card]'),
    ].find((page) => page.textContent?.includes('Second page'));
    await act(async () => pageB?.click());
    expect(container.querySelector('[aria-label="移除组件聚焦 文本框：First page"]')).toBeNull();

    const composer = container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    act(() => {
      setNativeValue(composer, '更新第二页');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = composer.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => send?.click());
    expect(onAssistantPrompt).toHaveBeenCalledWith(
      expect.not.objectContaining({ selectedElementIds: expect.anything() }),
    );
  });

  it('exposes only the typed Interactive focus seam and keeps structured pages whole-page only', async () => {
    let id = 0;
    const withOnlyPage = (sceneType: 'interactive' | 'quiz') => {
      const added = addReachDeckPage(createEditorDocument(), {
        afterPageId: 'page-1',
        sceneType,
        idFactory: (prefix) => `${prefix}-focus-${++id}`,
      });
      return deleteReachDeckPage(added, 'page-1');
    };
    const interactive = withOnlyPage('interactive');
    const interactivePageId = interactive.pages[0]!.pageId;
    const onAssistantPrompt = vi.fn().mockResolvedValue({ message: 'Interactive done' });
    const onInteractiveComponentFocusClear = vi.fn();
    const focus = {
      pageId: interactivePageId,
      componentId: 'marked-chart',
      label: 'Marked chart',
    };
    act(() =>
      root.render(
        <ReachDeckEditor
          document={interactive}
          interactiveComponentFocus={focus}
          onAssistantPrompt={onAssistantPrompt}
          onInteractiveComponentFocusClear={onInteractiveComponentFocusClear}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="移除互动组件聚焦 Marked chart"]')).not.toBeNull();
    expect(container.querySelector('.reach-deck-editor__assistant-suggestions')).toBeNull();
    const composer = container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    act(() => {
      setNativeValue(composer, '调整图表颜色');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => composer.form?.requestSubmit());
    expect(onAssistantPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ interactiveComponentFocus: focus, pageId: interactivePageId }),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="移除互动组件聚焦 Marked chart"]')
        ?.click(),
    );
    expect(onInteractiveComponentFocusClear).toHaveBeenCalledOnce();

    for (const sceneType of ['quiz'] as const) {
      act(() =>
        root.render(
          <ReachDeckEditor
            document={withOnlyPage(sceneType)}
            interactiveComponentFocus={focus}
            key={sceneType}
            onAssistantPrompt={vi.fn()}
          />,
        ),
      );
      expect(container.querySelector('.reach-deck-editor__assistant-suggestions')).toBeNull();
      expect(container.textContent).not.toContain('互动组件：Marked chart');
      expect(container.querySelector('[aria-label^="移除组件聚焦"]')).toBeNull();
    }
  });

  it('keeps tool context while waiting and restores progress without replaying the request', async () => {
    vi.useFakeTimers();
    let finish!: (response: { message: string }) => void;
    const onAssistantPrompt = vi.fn(
      (_request: unknown) =>
        new Promise<{ message: string }>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      act(() =>
        root.render(
          <ReachDeckEditor
            document={createEditorDocument()}
            onAssistantPrompt={onAssistantPrompt}
          />,
        ),
      );
      const suggestion = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === '精简当前页文字',
      );
      await act(async () => suggestion?.click());
      const request = onAssistantPrompt.mock.calls[0]?.[0] as unknown as {
        onProgress: (value: string) => void;
      };
      act(() => request.onProgress('正在查看课件…'));
      act(() => vi.advanceTimersByTime(10_000));
      expect(container.querySelector('.is-thinking')?.textContent).toContain('正在查看课件…');
      expect(container.querySelector('.is-thinking [role="status"]')?.textContent).toContain(
        '可能正在排队，请耐心等待，或停止后重试。',
      );
      act(() => request.onProgress('正在编辑课件…'));
      expect(container.querySelector('.is-thinking [role="status"]')).toBeNull();
      expect(container.querySelector('.is-thinking')?.textContent).toBe('正在编辑课件…');
      expect(onAssistantPrompt).toHaveBeenCalledTimes(1);
      await act(async () => finish({ message: 'Done' }));
      act(() => vi.advanceTimersByTime(20_000));
      expect(container.querySelector('.is-thinking')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['zh-CN', '可能正在排队，请耐心等待，或停止后重试。', '取消生成'],
    ['en-US', 'This may be queued. Please wait, or stop and try again.', 'Cancel generation'],
  ])(
    'updates a recovered job and clears its wait on stop (%s)',
    async (_locale, notice, cancelLabel) => {
      vi.useFakeTimers();
      const document = createEditorDocument();
      const onAssistantCancel = vi.fn();
      const render = (running: boolean, progress: { text: string; updatedAt: number }) =>
        act(() =>
          root.render(
            <ReachDeckEditor
              document={document}
              onAssistantPrompt={vi.fn()}
              assistantJobPageIds={running ? ['page-1'] : []}
              assistantJobProgressByPage={{ 'page-1': progress }}
              onAssistantCancel={onAssistantCancel}
              translate={(key) =>
                key === 'reachDeck.editor.assistant.waiting'
                  ? notice
                  : key === 'reachDeck.editor.assistant.cancel'
                    ? cancelLabel
                    : key
              }
            />,
          ),
        );
      try {
        render(true, { text: '正在编辑互动页…', updatedAt: Date.now() });
        act(() => vi.advanceTimersByTime(10_000));
        expect(container.querySelector('.is-thinking [role="status"]')).not.toBeNull();
        expect(container.querySelector('.is-thinking [role="status"]')?.textContent).toBe(notice);
        render(true, { text: '正在编辑互动页…', updatedAt: Date.now() });
        expect(container.querySelector('.is-thinking [role="status"]')).toBeNull();
        act(() => vi.advanceTimersByTime(10_000));
        const cancel = container.querySelector<HTMLButtonElement>(
          `button[aria-label="${cancelLabel}"]`,
        );
        expect(cancel).not.toBeNull();
        await act(async () => cancel?.click());
        expect(onAssistantCancel).toHaveBeenCalledWith('page-1');
        render(false, { text: '正在编辑互动页…', updatedAt: Date.now() });
        expect(container.querySelector('.is-thinking')).toBeNull();
        act(() => vi.advanceTimersByTime(20_000));
        expect(container.querySelector('.is-thinking [role="status"]')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('gives a recovered legacy job a fresh wait after the previous local request finishes', async () => {
    vi.useFakeTimers();
    const document = createEditorDocument();
    const onAssistantPrompt = vi.fn().mockResolvedValue({ message: 'Done' });
    const render = (running: boolean) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            document={document}
            onAssistantPrompt={onAssistantPrompt}
            assistantJobPageIds={running ? ['page-1'] : []}
          />,
        ),
      );
    try {
      render(false);
      const suggestion = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === '精简当前页文字',
      );
      await act(async () => suggestion?.click());
      expect(onAssistantPrompt).toHaveBeenCalledOnce();
      act(() => vi.advanceTimersByTime(20_000));
      render(true);
      expect(container.querySelector('.is-thinking')).not.toBeNull();
      expect(container.querySelector('.is-thinking [role="status"]')).toBeNull();
      act(() => vi.advanceTimersByTime(9_999));
      expect(container.querySelector('.is-thinking [role="status"]')).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(container.querySelector('.is-thinking [role="status"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens Decksmith by default and applies its document response after teacher confirmation', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'AI revised page', 2);
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      changeSummary: {
        schemaVersion: 'reach-deck-editor-change-summary/v1',
        status: 'grounded',
        addedPages: [],
        removedPages: [],
        modifiedPages: [{ pageId: 'page-1', title: 'AI revised page' }],
        documentMetadataChanged: false,
        resourcesChanged: false,
      },
      document: response,
      message: '已完成 AI 修改。',
      runtimeApprovalId: 'runtime-approval-1',
    });
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      ),
    );

    expect(container.querySelector('section[aria-label="Decksmith"]')).not.toBeNull();
    const canvasTitle = container.querySelector<HTMLElement>(nativeElementSelector('title-1'));
    act(() => canvasTitle?.click());
    expect(container.querySelector(nativeOverlaySelector('title-1'))).not.toBeNull();
    const decksmithTab = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Decksmith',
    );
    act(() => decksmithTab?.click());
    const suggestion = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());

    expect(onAssistantPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'page-1',
        prompt: '精简当前页文字',
        selectedElementIds: ['title-1'],
        onProgress: expect.any(Function),
      }),
    );
    // 变更未确认前不落草稿
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ pages: response.pages }));
    expect(container.textContent).toContain('已生成修改建议，等待采用。');
    expect(container.textContent).not.toContain('已完成 AI 修改。');
    const groundedSummary = container.querySelector('[data-change-summary-status="grounded"]');
    expect(groundedSummary?.textContent).toContain('实际变更（基于文档差异）');
    expect(groundedSummary?.textContent).toContain('修改 1 页（AI revised page）');
    const confirmationGroup = container.querySelector('[role="group"][aria-label="AI 修改确认"]');
    expect(
      groundedSummary !== null &&
        confirmationGroup
          ?.closest('.reach-deck-editor__assistant-message')
          ?.contains(groundedSummary),
    ).toBe(true);
    expect(confirmationGroup?.querySelectorAll('button')).toHaveLength(3);

    const applyButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '应用修改',
    );
    expect(applyButton).not.toBeUndefined();
    await act(async () => applyButton?.click());

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pages: response.pages }));
    expect(onAssistantDecision).toHaveBeenCalledWith({
      runtimeApprovalId: 'runtime-approval-1',
      decision: 'approved',
    });
    expect(container.textContent).toContain('Decksmith 修改正在保存，等待系统确认。');
    expect(container.textContent).not.toContain('已应用 Decksmith 的修改。');
    expect(
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')?.disabled,
    ).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        '.reach-deck-editor__assistant-composer button[type="submit"]',
      )?.disabled,
    ).toBe(true);

    act(() =>
      root.render(
        <ReachDeckEditor
          assistantAppliedApprovalId="runtime-approval-1"
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      ),
    );
    expect(container.textContent).toContain('已应用 Decksmith 的修改。');
    expect(container.textContent).not.toContain('Decksmith 修改正在保存，等待系统确认。');

    expect(activePageTitle(container)).toBe('AI revised page');
  });

  it('tells the teacher which page media will be generated after adoption (WP8)', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'AI revised page', 2);
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: response,
      message: '已改写讲稿。',
      outcome: {
        schemaVersion: 'reach-deck-decksmith-outcome/v1',
        mutationStatus: 'proposal',
        rejectedFontFamilies: [],
        toolErrorCount: 0,
        afterApply: [{ kind: 'regenerate-page-media', pageId: 'page-1' }],
      },
      runtimeApprovalId: 'runtime-approval-media',
    });
    const render = (translate?: (key: string) => string) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            document={baseline}
            onAssistantDecision={vi.fn()}
            onAssistantPrompt={onAssistantPrompt}
            onChange={vi.fn()}
            {...(translate === undefined ? {} : { translate })}
          />,
        ),
      );
    render();
    const decksmithTab = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Decksmith',
    );
    act(() => decksmithTab?.click());
    const suggestion = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());
    const note = container.querySelector('[data-after-apply="regenerate-page-media"]');
    expect(note?.textContent).toBe('采用后将自动生成第 1 页音频和动画');
    // 不展示费用、不另行确认：确认区仍只有原来的三个按钮。
    expect(
      container.querySelectorAll('[role="group"][aria-label="AI 修改确认"] button'),
    ).toHaveLength(3);
    render((key) =>
      key === 'reachDeck.editor.assistant.afterApply.regenerateMedia'
        ? 'Audio and animations for page {page} will be generated automatically after you apply this change'
        : key,
    );
    expect(container.querySelector('[data-after-apply="regenerate-page-media"]')?.textContent).toBe(
      'Audio and animations for page 1 will be generated automatically after you apply this change',
    );
  });

  it('says an approved proposal was replaced by later edits instead of applied (WP8)', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'AI revised page', 2);
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: response,
      message: '已完成 AI 修改。',
      runtimeApprovalId: 'runtime-approval-superseded',
    });
    const onAssistantDecision = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={vi.fn()}
        />,
      ),
    );
    const decksmithTab = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Decksmith',
    );
    act(() => decksmithTab?.click());
    const suggestion = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());
    const applyButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '应用修改',
    );
    await act(async () => applyButton?.click());

    act(() =>
      root.render(
        <ReachDeckEditor
          assistantResolvedApprovalIds={['runtime-approval-superseded']}
          assistantSupersededApprovalIds={['runtime-approval-superseded']}
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain('本次 AI 修改已被你之后的修改替代。');
    expect(container.textContent).not.toContain('已应用 Decksmith 的修改。');
    expect(container.textContent).not.toContain('Decksmith 修改建议未采用。');

    const english = (key: string) =>
      key === 'reachDeck.editor.assistant.supersededByTeacherEdit'
        ? 'This AI change was replaced by your later edits.'
        : key;
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantResolvedApprovalIds={['runtime-approval-superseded']}
          assistantSupersededApprovalIds={['runtime-approval-superseded']}
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={vi.fn()}
          translate={english}
        />,
      ),
    );
    expect(container.textContent).toContain('This AI change was replaced by your later edits.');
  });

  it.each([
    {
      expected: 'Decksmith 未修改课件。',
      locale: 'zh-CN',
      mutationStatus: 'none',
    },
    {
      expected: 'Decksmith did not change the deck.',
      locale: 'en-US',
      mutationStatus: 'none',
    },
    {
      expected: 'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。',
      locale: 'zh-CN',
      mutationStatus: 'proposal',
    },
    {
      expected:
        'Decksmith generated a change proposal. Review the actual changes before applying it.',
      locale: 'en-US',
      mutationStatus: 'proposal',
    },
    {
      expected:
        'Decksmith 已生成部分修改建议，请检查实际变更后再决定是否采用。 已拒绝非平台内置字体请求：Times New Roman。 有 2 个工具操作失败。',
      locale: 'zh-CN',
      mutationStatus: 'partial',
    },
    {
      expected:
        'Decksmith generated a partial change proposal. Review the actual changes before applying it. Unsupported font requests were rejected: Times New Roman. 2 Decksmith tool operation(s) failed.',
      locale: 'en-US',
      mutationStatus: 'partial',
    },
  ] as const)(
    'renders $mutationStatus Decksmith outcome in $locale without leaking backend copy',
    async ({ expected, locale, mutationStatus }) => {
      const baseline = createEditorDocument();
      const translations =
        locale === 'zh-CN'
          ? {
              'reachDeck.editor.assistant.outcome.none': 'Decksmith 未修改课件。',
              'reachDeck.editor.assistant.outcome.proposal':
                'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。',
              'reachDeck.editor.assistant.outcome.partial':
                'Decksmith 已生成部分修改建议，请检查实际变更后再决定是否采用。',
              'reachDeck.editor.assistant.outcome.rejectedFonts':
                '已拒绝非平台内置字体请求：{fonts}。',
              'reachDeck.editor.assistant.outcome.toolErrors': '有 {count} 个工具操作失败。',
            }
          : {
              'reachDeck.editor.assistant.outcome.none': 'Decksmith did not change the deck.',
              'reachDeck.editor.assistant.outcome.proposal':
                'Decksmith generated a change proposal. Review the actual changes before applying it.',
              'reachDeck.editor.assistant.outcome.partial':
                'Decksmith generated a partial change proposal. Review the actual changes before applying it.',
              'reachDeck.editor.assistant.outcome.rejectedFonts':
                'Unsupported font requests were rejected: {fonts}.',
              'reachDeck.editor.assistant.outcome.toolErrors':
                '{count} Decksmith tool operation(s) failed.',
            };
      const backendCompatibilityMessage = '后端中文兼容文案：不应直接显示。';
      const hasDetails = mutationStatus === 'partial';
      const onAssistantPrompt = vi.fn().mockResolvedValue({
        message: backendCompatibilityMessage,
        outcome: {
          schemaVersion: 'reach-deck-decksmith-outcome/v1',
          mutationStatus,
          rejectedFontFamilies: hasDetails ? ['Times New Roman'] : [],
          toolErrorCount: hasDetails ? 2 : 0,
        },
        ...(mutationStatus === 'none'
          ? {}
          : {
              document: withFirstPageTitle(baseline, `${mutationStatus} result`, 2),
              runtimeApprovalId: `approval-${mutationStatus}-${locale}`,
            }),
      });

      act(() =>
        root.render(
          <ReachDeckEditor
            document={baseline}
            onAssistantPrompt={onAssistantPrompt}
            translate={(key) => translations[key as keyof typeof translations] ?? key}
          />,
        ),
      );
      const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '精简当前页文字',
      );
      await act(async () => suggestion?.click());

      expect(container.textContent).toContain(expected);
      expect(container.textContent).not.toContain(backendCompatibilityMessage);
    },
  );

  it.each([
    {
      locale: 'zh-CN',
      scope: 'run',
      expected: '本次额度已用完，还有 2 项未完成，回复"继续"接着做。',
    },
    {
      locale: 'en-US',
      scope: 'run',
      expected:
        'This request used up its budget. 2 task(s) are not finished yet — reply "continue" to pick up where it stopped.',
    },
    {
      locale: 'zh-CN',
      scope: 'daily',
      expected: '今日 AI 额度已用完，还有 2 项未完成，额度恢复后回复"继续"接着做。',
    },
  ] as const)(
    'shows the $scope budget notice with the remaining-task count in $locale',
    async ({ expected, locale, scope }) => {
      const baseline = createEditorDocument();
      const translations: Record<string, string> =
        locale === 'zh-CN'
          ? {
              'reachDeck.editor.assistant.outcome.partial':
                'Decksmith 已生成部分修改建议，请检查实际变更后再决定是否采用。',
              'reachDeck.decksmith.budget.runLimited':
                '本次额度已用完，还有 {count} 项未完成，回复"继续"接着做。',
              'reachDeck.decksmith.budget.dailyLimited':
                '今日 AI 额度已用完，还有 {count} 项未完成，额度恢复后回复"继续"接着做。',
            }
          : {
              'reachDeck.editor.assistant.outcome.partial':
                'Decksmith generated a partial change proposal. Review the actual changes before applying it.',
              'reachDeck.decksmith.budget.runLimited':
                'This request used up its budget. {count} task(s) are not finished yet — reply "continue" to pick up where it stopped.',
            };
      const onAssistantPrompt = vi.fn().mockResolvedValue({
        message: '后端兼容文案',
        outcome: {
          schemaVersion: 'reach-deck-decksmith-outcome/v1',
          mutationStatus: 'partial',
          rejectedFontFamilies: [],
          toolErrorCount: 0,
          remainingTasks: ['服务端任务文本一', '服务端任务文本二'],
          completion: {
            state: 'budget-limited',
            scope,
            messageKey: `reachDeck.decksmith.budget.${scope}Limited`,
          },
        },
        document: withFirstPageTitle(baseline, 'budget result', 2),
        runtimeApprovalId: `approval-budget-${scope}-${locale}`,
      });
      act(() =>
        root.render(
          <ReachDeckEditor
            document={baseline}
            onAssistantPrompt={onAssistantPrompt}
            translate={(key) => translations[key] ?? key}
          />,
        ),
      );
      const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '精简当前页文字',
      );
      await act(async () => suggestion?.click());

      const notice = container.querySelector('.reach-deck-editor__assistant-budget-notice');
      expect(notice?.textContent).toBe(expected);
      expect(notice?.getAttribute('data-budget-scope')).toBe(scope);
      // 服务端任务文本只用于下一轮"继续"，不直接显示。
      expect(container.textContent).not.toContain('服务端任务文本一');
    },
  );

  it('shows no budget notice for an ordinary outcome', async () => {
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      message: 'ok',
      outcome: {
        schemaVersion: 'reach-deck-decksmith-outcome/v1',
        mutationStatus: 'none',
        rejectedFontFamilies: [],
        toolErrorCount: 0,
      },
    });
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());
    expect(container.querySelector('.reach-deck-editor__assistant-budget-notice')).toBeNull();
  });

  const clarificationResponse = (expect: 'choice' | 'select-element') => ({
    message: 'Decksmith 需要你先回答一个问题，课件未修改。',
    outcome: {
      schemaVersion: 'reach-deck-decksmith-outcome/v1' as const,
      mutationStatus: 'none' as const,
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      clarification: {
        questionId: `dq_${'c'.repeat(32)}`,
        question: '要改哪一个元素？',
        options: expect === 'choice' ? ['测验页', '互动页'] : [],
        candidates: [
          { pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label: 'textFrame "标题"' },
          { pageId: 'page-9', pageRevision: 1, elementId: 'other-1', label: 'image "别页的图"' },
        ],
        expect,
      },
    },
    historyRunId: `run-clarify-${expect}`,
    originPageId: 'page-1',
  });
  const clarificationCopy: Record<'zh-CN' | 'en-US', Record<string, string>> = {
    'zh-CN': {
      'reachDeck.editor.assistant.outcome.clarification':
        'Decksmith 需要你先回答一个问题，课件尚未修改。',
      'reachDeck.editor.assistant.clarification.label': 'Decksmith 的问题',
      'reachDeck.editor.assistant.clarification.options': '可选回答',
      'reachDeck.editor.assistant.clarification.optionAnswer': '回答：{option}',
      'reachDeck.editor.assistant.clarification.candidates': '候选元素',
      'reachDeck.editor.assistant.clarification.pickCandidate': '选择并回答：{label}',
      'reachDeck.editor.assistant.clarification.pickAnswer': '选这个：{label}',
      'reachDeck.editor.assistant.clarification.replyWithText': '用文字回答',
      'reachDeck.editor.assistant.clarification.closed': '这个问题已不再等待回答。',
      'reachDeck.editor.assistant.clarification.replyLinked':
        '这条消息将作为对 Decksmith 问题的回答。',
      'reachDeck.editor.assistant.clarification.replyUnlinked':
        '这条消息将作为新请求发送，不回答上面的问题。',
      'reachDeck.editor.assistant.clarification.linkReply': '改为回答问题',
      'reachDeck.editor.assistant.clarification.unlinkReply': '改为新请求',
    },
    'en-US': {
      'reachDeck.editor.assistant.outcome.clarification':
        'Decksmith needs your answer to one question first; the deck has not changed.',
      'reachDeck.editor.assistant.clarification.label': 'Question from Decksmith',
      'reachDeck.editor.assistant.clarification.options': 'Possible answers',
      'reachDeck.editor.assistant.clarification.optionAnswer': 'Answer: {option}',
      'reachDeck.editor.assistant.clarification.candidates': 'Candidate elements',
      'reachDeck.editor.assistant.clarification.pickCandidate': 'Select and answer: {label}',
      'reachDeck.editor.assistant.clarification.pickAnswer': 'This one: {label}',
      'reachDeck.editor.assistant.clarification.replyWithText': 'Answer in text',
      'reachDeck.editor.assistant.clarification.closed':
        'This question is no longer waiting for an answer.',
      'reachDeck.editor.assistant.clarification.replyLinked':
        'This message will be sent as your answer to the Decksmith question.',
      'reachDeck.editor.assistant.clarification.replyUnlinked':
        'This message will be sent as a new request, not as an answer to the question above.',
      'reachDeck.editor.assistant.clarification.linkReply': 'Send as answer',
      'reachDeck.editor.assistant.clarification.unlinkReply': 'Send as new request',
    },
  };
  // 宿主 translate 只按 key 返回模板（缺失时返回 key），占位符由编辑器替换。
  const clarificationTranslate = (locale: 'zh-CN' | 'en-US') => (key: string) =>
    clarificationCopy[locale][key] ?? key;
  const askDecksmith = async () => {
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());
  };

  it.each(['zh-CN', 'en-US'] as const)(
    'renders the clarification card and answers with an option in %s',
    async (locale) => {
      const copy = clarificationCopy[locale];
      const onAssistantPrompt = vi
        .fn()
        .mockResolvedValueOnce(clarificationResponse('choice'))
        .mockResolvedValueOnce({
          message: 'ok',
          historyRunId: 'run-answer',
          originPageId: 'page-1',
        });
      act(() =>
        root.render(
          <ReachDeckEditor
            document={createEditorDocument()}
            onAssistantPrompt={onAssistantPrompt}
            translate={clarificationTranslate(locale)}
          />,
        ),
      );
      await askDecksmith();

      const card = container.querySelector<HTMLElement>(
        `[role="group"][aria-label="${copy['reachDeck.editor.assistant.clarification.label']}"]`,
      );
      expect(card).not.toBeNull();
      expect(card?.dataset.clarificationOpen).toBe('true');
      expect(card?.textContent).toContain('要改哪一个元素？');
      expect(container.textContent).toContain(
        copy['reachDeck.editor.assistant.outcome.clarification'],
      );
      // choice 下候选只读展示，不可点选。
      expect(card?.querySelector('ul button')).toBeNull();
      expect(
        container.querySelector('.reach-deck-editor__assistant-reply-link')?.textContent,
      ).toContain(copy['reachDeck.editor.assistant.clarification.replyLinked']);
      const option = card?.querySelector<HTMLButtonElement>(
        `button[aria-label="${copy['reachDeck.editor.assistant.clarification.optionAnswer'].replace('{option}', '测验页')}"]`,
      );
      expect(option?.textContent).toBe('测验页');
      await act(async () => option?.click());

      expect(onAssistantPrompt).toHaveBeenLastCalledWith(
        expect.objectContaining({
          prompt: '测验页',
          answersQuestionId: `dq_${'c'.repeat(32)}`,
        }),
      );
      // 回答之后旧问题只读展示。
      const closed = container.querySelector<HTMLElement>(
        '.reach-deck-editor__assistant-clarification',
      );
      expect(closed?.dataset.clarificationOpen).toBe('false');
      expect(closed?.textContent).toContain(
        copy['reachDeck.editor.assistant.clarification.closed'],
      );
      expect(closed?.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
      expect(container.querySelector('.reach-deck-editor__assistant-reply-link')).toBeNull();
    },
  );

  it('selects a candidate on the canvas and sends it as the answer context', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(clarificationResponse('select-element'))
      .mockResolvedValueOnce({ message: 'ok', historyRunId: 'run-answer', originPageId: 'page-1' });
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    await askDecksmith();
    const candidate = container.querySelector<HTMLButtonElement>(
      'button[aria-label=\'选择并回答：textFrame "标题"\']',
    );
    expect(candidate).not.toBeNull();
    await act(async () => candidate?.click());

    expect(onAssistantPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: '选这个：textFrame "标题"',
        selectedElementIds: ['title-1'],
        elementId: 'title-1',
        answersQuestionId: `dq_${'c'.repeat(32)}`,
      }),
    );
    // 画布上选中了候选元素，右侧仍停留在 Decksmith 面板。
    expect(container.querySelector(nativeOverlaySelector('title-1'))).not.toBeNull();
    expect(container.querySelector('section[aria-label="Decksmith"]')).not.toBeNull();
  });

  // 第二阶段：候选按指定列表构造（页、修订、元素与标签）。
  const pickClarificationResponse = (
    candidates: readonly {
      pageId: string;
      pageRevision: number;
      elementId: string;
      label: string;
    }[],
  ) => {
    const base = clarificationResponse('select-element');
    return {
      ...base,
      outcome: {
        ...base.outcome,
        clarification: { ...base.outcome.clarification, candidates },
      },
    };
  };
  const pickBar = () =>
    container.querySelector<HTMLElement>('[role="group"][aria-label="点选回答 Decksmith"]');
  const highlight = (elementId: string) =>
    container.querySelector<HTMLElement>(
      `[data-native-v2-stage-overlay] .reach-deck-editor__clarification-highlight[data-candidate-element-id="${elementId}"]`,
    );
  const buttonByText = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === label,
    );
  /** 第一页再加一个非候选文本框，验证普通点击不受点选影响。 */
  const withBodyFrame = (document: ReachDeckDocument): ReachDeckDocument => {
    if (document.schemaVersion !== 'reach-deck-document/v2') return document;
    return {
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) =>
        index !== 0
          ? binding
          : {
              ...binding,
              slide: {
                ...binding.slide,
                elements: [
                  ...binding.slide.elements,
                  {
                    ...structuredClone(binding.slide.elements[0]!),
                    id: 'body-1',
                    transform: { x: 80, y: 320, width: 1100, height: 200 },
                    zIndex: 2,
                  } as ReachDeckNativeElementV2,
                ],
              },
            },
      ),
    };
  };

  it('answers a candidate on another page with text, a page reference and its element identity', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(
        pickClarificationResponse([
          {
            pageId: 'page-2',
            pageRevision: 1,
            elementId: 'title-1-second',
            label: 'image "别页的图"',
          },
        ]),
      )
      .mockResolvedValueOnce({ message: 'ok', historyRunId: 'run-answer', originPageId: 'page-1' });
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onAssistantPrompt={onAssistantPrompt}
        />,
      ),
    );
    await askDecksmith();
    const candidate = container.querySelector<HTMLButtonElement>(
      'button[aria-label=\'选择并回答：image "别页的图"\']',
    );
    await act(async () => candidate?.click());
    const request = onAssistantPrompt.mock.lastCall?.[0];
    expect(request).toMatchObject({
      pageId: 'page-1',
      prompt: '选这个：第 2 页的 image "别页的图"',
      answersQuestionId: `dq_${'c'.repeat(32)}`,
      mentionedPageIds: ['page-2'],
      mentionedElements: [{ pageId: 'page-2', elementId: 'title-1-second' }],
    });
    expect(request).not.toHaveProperty('selectedElementIds');
  });

  it('tells apart two same-label candidates on another page by their element ids', async () => {
    const document = createTwoPageEditorDocument();
    if (document.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2');
    const second = document.nativeSlides[1]!;
    const twin = {
      ...structuredClone(second.slide.elements[0]!),
      id: 'title-twin-second',
      zIndex: 9,
    } as ReachDeckNativeElementV2;
    const withTwin: ReachDeckDocument = {
      ...document,
      nativeSlides: [
        document.nativeSlides[0]!,
        { ...second, slide: { ...second.slide, elements: [...second.slide.elements, twin] } },
      ],
    };
    const candidates = [
      { pageId: 'page-2', pageRevision: 1, elementId: 'title-1-second', label: 'image "示意图"' },
      {
        pageId: 'page-2',
        pageRevision: 1,
        elementId: 'title-twin-second',
        label: 'image "示意图"',
      },
    ];
    const requests = [];
    for (const index of [0, 1]) {
      const onAssistantPrompt = vi
        .fn()
        .mockResolvedValueOnce(pickClarificationResponse(candidates))
        .mockResolvedValueOnce({
          message: 'ok',
          historyRunId: 'run-answer',
          originPageId: 'page-1',
        });
      act(() =>
        root.render(
          <ReachDeckEditor
            key={`twin-${index}`}
            document={withTwin}
            onAssistantPrompt={onAssistantPrompt}
          />,
        ),
      );
      await askDecksmith();
      const buttons = [
        ...container.querySelectorAll<HTMLButtonElement>(
          'button[aria-label=\'选择并回答：image "示意图"\']',
        ),
      ];
      expect(buttons).toHaveLength(2);
      await act(async () => buttons[index]?.click());
      requests.push(onAssistantPrompt.mock.lastCall?.[0]);
    }
    expect(requests[0]).toMatchObject({
      mentionedElements: [{ pageId: 'page-2', elementId: 'title-1-second' }],
    });
    expect(requests[1]).toMatchObject({
      mentionedElements: [{ pageId: 'page-2', elementId: 'title-twin-second' }],
    });
  });

  it('highlights candidates on the canvas and answers by clicking one and confirming', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(
        pickClarificationResponse([
          { pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label: 'textFrame "标题"' },
        ]),
      )
      .mockResolvedValueOnce({ message: 'ok', historyRunId: 'run-answer', originPageId: 'page-1' });
    act(() =>
      root.render(
        <ReachDeckEditor
          document={withBodyFrame(createEditorDocument())}
          onAssistantPrompt={onAssistantPrompt}
        />,
      ),
    );
    await askDecksmith();

    // 候选在舞台叠加层里画框并带编号徽标；非候选元素不画框。
    const box = highlight('title-1');
    expect(box?.dataset.state).toBe('available');
    expect(box?.style.left).toBe('80px');
    expect(box?.style.width).toBe('1100px');
    const badge = box?.querySelector<HTMLButtonElement>('button');
    expect(badge?.getAttribute('aria-label')).toBe('候选 1：textFrame "标题"');
    expect(badge?.textContent).toBe('1');
    expect(highlight('body-1')).toBeNull();
    expect(pickBar()?.textContent).toContain('点击画布上带编号的高亮元素来回答 Decksmith 的问题。');
    expect(buttonByText('用这个')).toBeUndefined();

    // 非候选元素：照常选中并切到属性面板，不进入待确认。
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('body-1'))?.click());
    expect(container.querySelector(nativeOverlaySelector('body-1'))).not.toBeNull();
    expect(buttonByText('用这个')).toBeUndefined();
    expect(onAssistantPrompt).toHaveBeenCalledTimes(1);

    // 点中候选：选中它并显示"用这个"确认，此时尚未发送。
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    expect(container.querySelector(nativeOverlaySelector('title-1'))).not.toBeNull();
    expect(highlight('title-1')?.dataset.pending).toBe('true');
    expect(pickBar()?.textContent).toContain('已选：候选 1：textFrame "标题"');
    expect(onAssistantPrompt).toHaveBeenCalledTimes(1);

    await act(async () => buttonByText('用这个')?.click());
    expect(onAssistantPrompt).toHaveBeenCalledTimes(2);
    expect(onAssistantPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pageId: 'page-1',
        prompt: '选这个：textFrame "标题"',
        selectedElementIds: ['title-1'],
        elementId: 'title-1',
        answersQuestionId: `dq_${'c'.repeat(32)}`,
      }),
    );
    // 回答之后问题关闭，高亮与提示条消失。
    expect(highlight('title-1')).toBeNull();
    expect(pickBar()).toBeNull();
  });

  it('lets keyboard users pick a candidate with its numbered badge', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(
        pickClarificationResponse([
          { pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label: 'textFrame "标题"' },
        ]),
      )
      .mockResolvedValueOnce({ message: 'ok', historyRunId: 'run-answer', originPageId: 'page-1' });
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    await askDecksmith();
    const badge = highlight('title-1')?.querySelector<HTMLButtonElement>('button');
    expect(badge?.getAttribute('aria-pressed')).toBe('false');
    act(() => badge?.click());
    expect(badge?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => buttonByText('用这个')?.click());
    expect(onAssistantPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedElementIds: ['title-1'],
        answersQuestionId: `dq_${'c'.repeat(32)}`,
      }),
    );
  });

  it('exits the highlight mode with Esc or the exit button and can re-enter from the card', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(
        pickClarificationResponse([
          { pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label: 'textFrame "标题"' },
        ]),
      );
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    await askDecksmith();
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    expect(buttonByText('用这个')).toBeDefined();

    act(() => {
      window.document.body.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
    });
    expect(highlight('title-1')).toBeNull();
    expect(pickBar()).toBeNull();
    // 退出后点中原候选只是普通选中。
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    expect(buttonByText('用这个')).toBeUndefined();

    // 卡片提供"在画布上点选"重新进入；退出按钮同样关闭高亮。
    act(() => buttonByText('在画布上点选')?.click());
    expect(highlight('title-1')).not.toBeNull();
    act(() => buttonByText('退出点选')?.focus());
    act(() => buttonByText('退出点选')?.click());
    expect(highlight('title-1')).toBeNull();
    // 提示条卸载后焦点回到画布区，而不是落回 body。
    expect(window.document.activeElement).toBe(
      container.querySelector('.reach-deck-editor__preview'),
    );
    expect(buttonByText('在画布上点选')).toBeDefined();
    expect(onAssistantPrompt).toHaveBeenCalledTimes(1);
  });

  it('lets Esc close an open canvas menu without leaving the highlight mode', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(
        pickClarificationResponse([
          { pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label: 'textFrame "标题"' },
        ]),
      );
    act(() =>
      root.render(
        <ReachDeckEditor
          document={withBodyFrame(createEditorDocument())}
          onAssistantPrompt={onAssistantPrompt}
        />,
      ),
    );
    await askDecksmith();
    act(() =>
      container
        .querySelector<HTMLElement>(nativeElementSelector('body-1'))
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    expect(container.querySelector('.reach-deck-editor__element-menu')).not.toBeNull();
    act(() => {
      window.document.body.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
    });
    expect(container.querySelector('.reach-deck-editor__element-menu')).toBeNull();
    expect(highlight('title-1')).not.toBeNull();
    // 菜单关闭后，下一次 Esc 才退出点选。
    act(() => {
      window.document.body.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
      );
    });
    expect(highlight('title-1')).toBeNull();
  });

  it('withdraws "Use this" once the picked element leaves the selection', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(
        pickClarificationResponse([
          { pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label: 'textFrame "标题"' },
        ]),
      );
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    await askDecksmith();
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    expect(buttonByText('用这个')).toBeDefined();
    // 从上下文 chip 移除该元素：选区已空，"用这个"不能再拿它作答。
    act(() =>
      container
        .querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-element-chip')
        ?.click(),
    );
    expect(buttonByText('用这个')).toBeUndefined();
    expect(highlight('title-1')?.dataset.pending).toBeUndefined();
    expect(onAssistantPrompt).toHaveBeenCalledTimes(1);
  });

  it('shows stale candidates as unavailable on the canvas and in the card', async () => {
    const onAssistantPrompt = vi.fn().mockResolvedValueOnce(
      pickClarificationResponse([
        // 页面修订已变（提问之后页面被改过）。
        { pageId: 'page-1', pageRevision: 2, elementId: 'title-1', label: 'textFrame "标题"' },
        // 元素已删除。
        { pageId: 'page-1', pageRevision: 1, elementId: 'deleted-1', label: 'image "旧图"' },
      ]),
    );
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    await askDecksmith();

    const box = highlight('title-1');
    expect(box?.dataset.state).toBe('unavailable');
    const badge = box?.querySelector<HTMLButtonElement>('button');
    expect(badge?.disabled).toBe(true);
    expect(badge?.getAttribute('aria-label')).toBe('候选 1：textFrame "标题"（已不可用）');
    expect(highlight('deleted-1')).toBeNull();
    expect(pickBar()?.textContent).toContain('这一页没有可点选的候选。');
    expect(pickBar()?.textContent).toContain('2 个候选已不可用（元素已删除或页面已修改）。');

    const card = container.querySelector<HTMLElement>(
      '.reach-deck-editor__assistant-clarification',
    );
    const cardButtons = [
      ...(card?.querySelectorAll<HTMLButtonElement>(
        '.reach-deck-editor__assistant-clarification-candidates button',
      ) ?? []),
    ];
    expect(
      cardButtons.map((button) => [button.getAttribute('aria-label'), button.disabled]),
    ).toEqual([
      ['候选 1：textFrame "标题"（已不可用）', true],
      ['候选 2：image "旧图"（已不可用）', true],
    ]);

    // 点中过期候选是普通选中，不进入待确认。
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    expect(buttonByText('用这个')).toBeUndefined();
    expect(onAssistantPrompt).toHaveBeenCalledTimes(1);
  });

  it('keeps candidate badges inert while the page is locked', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(
        pickClarificationResponse([
          { pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label: 'textFrame "标题"' },
        ]),
      );
    const render = (lockedPageIds: readonly string[]) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            document={createEditorDocument()}
            lockedPageIds={[...lockedPageIds]}
            onAssistantPrompt={onAssistantPrompt}
          />,
        ),
      );
    render([]);
    await askDecksmith();
    render(['page-1']);
    const badge = highlight('title-1')?.querySelector<HTMLButtonElement>('button');
    expect(badge?.disabled).toBe(true);
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    expect(buttonByText('用这个')).toBeUndefined();
  });

  it('goes to the candidate page, picks there and answers from the question page', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(
        pickClarificationResponse([
          {
            pageId: 'page-2',
            pageRevision: 1,
            elementId: 'title-1-second',
            label: 'textFrame "第二页标题"',
          },
        ]),
      )
      .mockResolvedValueOnce({ message: 'ok', historyRunId: 'run-answer', originPageId: 'page-1' });
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onAssistantPrompt={onAssistantPrompt}
        />,
      ),
    );
    await askDecksmith();
    expect(pickBar()?.textContent).toContain('这一页没有可点选的候选。');
    const goTo = [...(pickBar()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === '前往第 2 页',
    );
    expect(goTo).toBeDefined();
    await act(async () => goTo?.click());

    // 第二页画布上高亮候选，提示条提供返回提问页。
    expect(highlight('title-1-second')?.dataset.state).toBe('available');
    expect(buttonByText('返回提问的第 1 页')).toBeDefined();
    act(() =>
      container.querySelector<HTMLElement>(nativeElementSelector('title-1-second'))?.click(),
    );
    expect(highlight('title-1-second')?.dataset.pending).toBe('true');
    await act(async () => buttonByText('用这个')?.click());
    await act(async () => Promise.resolve());

    // 回到提问页发送：文字作答 + 候选页引用 + 候选元素（pageId + elementId），不夹带当前选区。
    expect(onAssistantPrompt).toHaveBeenCalledTimes(2);
    const request = onAssistantPrompt.mock.lastCall?.[0];
    expect(request).toMatchObject({
      pageId: 'page-1',
      prompt: '选这个：第 2 页的 textFrame "第二页标题"',
      answersQuestionId: `dq_${'c'.repeat(32)}`,
      mentionedPageIds: ['page-2'],
      mentionedElements: [{ pageId: 'page-2', elementId: 'title-1-second' }],
    });
    expect(request).not.toHaveProperty('selectedElementIds');
    expect(pickBar()).toBeNull();
  });

  it('labels native component context chips with type, bounded text, and image thumbnails', async () => {
    const longText = '这是一个非常非常长的标题文字用于验证截断效果是否正常工作';
    const base = withCandidateImage(
      createEditorDocument(),
      'media-chip',
      'reach-deck/images/chip.png',
      '细胞结构示意图',
    );
    if (base.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2');
    const title = base.nativeSlides[0]!.slide.elements[0]!;
    if (title.type !== 'textFrame') throw new Error('Expected text frame');
    title.text.doc = richTextFromPlainText(longText);
    act(() =>
      root.render(
        <ReachDeckEditor
          document={base}
          nativeResourceUrlsById={{ 'media-chip': 'https://signed.example/chip.png' }}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );
    act(() => container.querySelector<HTMLElement>(nativeElementSelector('title-1'))?.click());
    const textChip = container.querySelector<HTMLButtonElement>(
      '.reach-deck-editor__assistant-element-chip',
    );
    const textLabel = `文本框：${Array.from(longText).slice(0, 18).join('')}…`;
    expect(textChip?.getAttribute('aria-label')).toBe(`移除组件聚焦 ${textLabel}`);
    expect(textChip?.title).toBe(`${textLabel}（ID：title-1）`);
    expect(textChip?.dataset.elementType).toBe('textFrame');
    expect(textChip?.querySelector('svg')).not.toBeNull();
    expect(textChip?.textContent).not.toContain('title-1');

    act(() =>
      container
        .querySelector<HTMLElement>(nativeElementSelector('candidate-image-media-chip'))
        ?.click(),
    );
    const imageChip = container.querySelector<HTMLButtonElement>(
      '.reach-deck-editor__assistant-element-chip',
    );
    expect(imageChip?.getAttribute('aria-label')).toBe('移除组件聚焦 图片：细胞结构示意图');
    const thumbnail = imageChip?.querySelector('img');
    expect(thumbnail?.getAttribute('src')).toBe('https://signed.example/chip.png');
    expect(thumbnail?.getAttribute('alt')).toBe('');
    expect(imageChip?.title).toBe('图片：细胞结构示意图（ID：candidate-image-media-chip）');
  });

  it('links a typed reply to the open question unless the teacher sends it as a new request', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(clarificationResponse('choice'))
      .mockResolvedValue({ message: 'ok', historyRunId: 'run-answer', originPageId: 'page-1' });
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    await askDecksmith();
    const reply = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '用文字回答',
    );
    act(() => reply?.click());
    const composer = container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    expect(document.activeElement).toBe(composer);
    // 先切到"新请求"，再切回"回答问题"：按钮名称描述切换后的动作，不叠加 aria-pressed。
    const link = container.querySelector<HTMLElement>('.reach-deck-editor__assistant-reply-link')!;
    const toggle = link.querySelector<HTMLButtonElement>('button')!;
    expect(link.dataset.linked).toBe('true');
    expect(toggle.hasAttribute('aria-pressed')).toBe(false);
    expect(toggle.textContent).toBe('改为新请求');
    act(() => toggle.click());
    expect(link.dataset.linked).toBe('false');
    expect(toggle.textContent).toBe('改为回答问题');
    act(() => toggle.click());
    act(() => {
      setNativeValue(composer, '两个都要');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      composer.form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(),
    );
    expect(onAssistantPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: '两个都要', answersQuestionId: `dq_${'c'.repeat(32)}` }),
    );
  });

  it('sends a typed message as a new request after unlinking the question', async () => {
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(clarificationResponse('choice'))
      .mockResolvedValue({ message: 'ok', historyRunId: 'run-answer', originPageId: 'page-1' });
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    await askDecksmith();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-reply-link button')
        ?.click(),
    );
    const composer = container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    act(() => {
      setNativeValue(composer, '先把标题改短');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      composer.form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(),
    );
    expect(onAssistantPrompt.mock.lastCall?.[0]).toMatchObject({ prompt: '先把标题改短' });
    expect(onAssistantPrompt.mock.lastCall?.[0]).not.toHaveProperty('answersQuestionId');
  });

  it('restores the question card from page history and closes it once a later turn exists', async () => {
    const asked = clarificationResponse('choice');
    const askingEntries = [
      { id: 'run-ask:user', kind: 'message' as const, role: 'user' as const, text: '加几道题' },
      {
        id: 'run-ask:assistant',
        kind: 'message' as const,
        role: 'assistant' as const,
        text: asked.message,
        outcome: asked.outcome,
      },
    ];
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValue({ message: 'ok', historyRunId: 'run-answer', originPageId: 'page-1' });
    const render = (entries: readonly (typeof askingEntries)[number][]) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            assistantHistory={{ pageId: 'page-1', loading: false, hasOlder: false, entries }}
            document={createEditorDocument()}
            onAssistantPrompt={onAssistantPrompt}
          />,
        ),
      );
    render(askingEntries);
    await act(async () => Promise.resolve());
    const card = () =>
      container.querySelector<HTMLElement>('.reach-deck-editor__assistant-clarification');
    // 刷新后最后一条仍是提问：卡片可作答，输入框默认作为回答发送。
    expect(card()?.dataset.clarificationOpen).toBe('true');
    expect(container.querySelector('.reach-deck-editor__assistant-reply-link')).not.toBeNull();
    const option = [...card()!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '测验页',
    );
    expect(option?.disabled).toBe(false);
    await act(async () => option?.click());
    expect(onAssistantPrompt.mock.lastCall?.[0]).toMatchObject({
      prompt: '测验页',
      answersQuestionId: asked.outcome.clarification.questionId,
    });

    // 历史里提问之后已有回合（例如另一个标签页已回答）：卡片只读，不再关联输入框。
    render([
      ...askingEntries,
      { id: 'run-later:user', kind: 'message', role: 'user', text: '测验页' },
      { id: 'run-later:assistant', kind: 'message', role: 'assistant', text: 'ok' },
    ] as never);
    await act(async () => Promise.resolve());
    const closed = container.querySelector<HTMLElement>(
      '[data-clarification-open="false"].reach-deck-editor__assistant-clarification',
    );
    expect(closed).not.toBeNull();
    expect(
      [...closed!.querySelectorAll<HTMLButtonElement>('button')].every((button) => button.disabled),
    ).toBe(true);
  });

  const decksmithSuggestionResponse = (
    suggestedActions: readonly { kind: string; pageId: string }[],
  ) => ({
    message: 'ok',
    outcome: {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      suggestedActions,
    },
  });
  const askDecksmithForSuggestions = async () => {
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());
  };
  const suggestedActionButton = (label: string) =>
    container.querySelector<HTMLButtonElement>(
      `.reach-deck-editor__assistant-suggested-action[aria-label="${label}"]`,
    );

  it('offers Decksmith suggested actions as compact buttons that call the existing regenerate hooks', async () => {
    const baseline = createEditorDocument();
    baseline.nativeSlides[0]!.slide.narration = { markdown: '保存的讲稿' };
    const onRegeneratePage = vi.fn();
    const onRegeneratePageNarrationAnimations = vi.fn();
    const onAssistantPrompt = vi.fn().mockResolvedValue(
      decksmithSuggestionResponse([
        { kind: 'regenerate-page-media', pageId: 'page-1' },
        { kind: 'regenerate-page', pageId: 'page-1' },
      ]),
    );

    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          onAssistantPrompt={onAssistantPrompt}
          onRegeneratePage={onRegeneratePage}
          onRegeneratePageNarrationAnimations={onRegeneratePageNarrationAnimations}
        />,
      ),
    );
    await askDecksmithForSuggestions();

    const media = suggestedActionButton('重新生成第 1 页音频和动画');
    expect(media?.querySelector('svg')).not.toBeNull();
    expect(media?.textContent).toBe('重新生成第 1 页音频和动画');
    expect(media?.title).toBe('重新生成第 1 页音频和动画');
    expect(media?.classList.contains('reach-deck-editor__assistant-guidance-action')).toBe(false);
    // 紧凑胶囊样式的特异性必须高于编辑器通用按钮重置（2.35rem 白底按钮）。
    const editorStyle = window.document.createElement('style');
    editorStyle.textContent = editorStyles;
    window.document.head.append(editorStyle);
    try {
      expect(window.getComputedStyle(media!).minHeight).toBe('1.5rem');
      expect(window.getComputedStyle(media!).height).toBe('1.5rem');
      expect(window.getComputedStyle(media!).backgroundColor).not.toBe('rgb(255, 255, 255)');
    } finally {
      editorStyle.remove();
    }
    await act(async () => media?.click());
    expect(onRegeneratePageNarrationAnimations).toHaveBeenCalledWith({
      pageId: 'page-1',
      markdown: '保存的讲稿',
    });
    await act(async () => suggestedActionButton('重新生成第 1 页')?.click());
    expect(onRegeneratePage).toHaveBeenCalledWith('page-1');
  });

  it('dispatches partial narration suggestions to the matching slide hooks', async () => {
    const baseline = createEditorDocument();
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'sub' as const, from: 0, to: 2, alias: '宝存' }],
    };
    baseline.nativeSlides[0]!.slide.narration = {
      markdown: '保存的讲稿',
      speechMarkup,
      audioResourceId: 'narration-audio',
      segments: [{ text: '保存的讲稿', start: 0, end: 2 }],
    };
    baseline.nativeSlides[0]!.slide.duration = 2;
    baseline.resources.media = [
      ...(baseline.resources.media ?? []),
      {
        id: 'narration-audio',
        objectKey: 'reach-deck/audio/narration.mp3',
        contentType: 'audio/mpeg',
        digest: 'objectkey:reach-deck/audio/narration.mp3',
      },
    ];
    const onRegeneratePageNarration = vi.fn();
    const onSavePageNarrationAudio = vi.fn();
    const onRegeneratePageAnimationsOnly = vi.fn();
    const onAssistantPrompt = vi.fn().mockResolvedValue(
      decksmithSuggestionResponse([
        { kind: 'regenerate-page-narration', pageId: 'page-1' },
        { kind: 'regenerate-page-narration-text', pageId: 'page-1' },
        { kind: 'generate-page-audio', pageId: 'page-1' },
        { kind: 'regenerate-page-animations', pageId: 'page-1' },
      ]),
    );

    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          onAssistantPrompt={onAssistantPrompt}
          onRegeneratePageAnimationsOnly={onRegeneratePageAnimationsOnly}
          onRegeneratePageNarration={onRegeneratePageNarration}
          onSavePageNarrationAudio={onSavePageNarrationAudio}
        />,
      ),
    );
    await askDecksmithForSuggestions();

    await act(async () => suggestedActionButton('重新生成第 1 页讲稿、音频和动画')?.click());
    expect(onRegeneratePageNarration).toHaveBeenLastCalledWith('page-1');
    await act(async () => suggestedActionButton('仅重新生成第 1 页讲稿')?.click());
    expect(onRegeneratePageNarration).toHaveBeenLastCalledWith('page-1', { textOnly: true });
    const savedNarration = { pageId: 'page-1', markdown: '保存的讲稿', speechMarkup };
    await act(async () => suggestedActionButton('生成第 1 页音频')?.click());
    expect(onSavePageNarrationAudio).toHaveBeenCalledWith(savedNarration);
    await act(async () => suggestedActionButton('重新生成第 1 页动画')?.click());
    expect(onRegeneratePageAnimationsOnly).toHaveBeenCalledWith(savedNarration);
  });

  it('disables suggestions whose hook or saved narration prerequisite is missing and says why', async () => {
    const baseline = createEditorDocument();
    baseline.nativeSlides[0]!.slide.narration = { markdown: '保存的讲稿' };
    const onAssistantPrompt = vi.fn().mockResolvedValue(
      decksmithSuggestionResponse([
        { kind: 'regenerate-page-animations', pageId: 'page-1' },
        { kind: 'regenerate-page-narration-text', pageId: 'page-1' },
        { kind: 'generate-page-audio', pageId: 'missing-page' },
      ]),
    );

    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          onAssistantPrompt={onAssistantPrompt}
          onRegeneratePageAnimationsOnly={vi.fn()}
          onSavePageNarrationAudio={vi.fn()}
        />,
      ),
    );
    await askDecksmithForSuggestions();

    const animations = suggestedActionButton('重新生成第 1 页动画');
    expect(animations?.disabled).toBe(true);
    expect(animations?.title).toBe('请先为已保存的讲稿生成音频，再重新生成动画。');
    const textOnly = suggestedActionButton('仅重新生成第 1 页讲稿');
    expect(textOnly?.disabled).toBe(true);
    expect(textOnly?.title).toBe('当前编辑器不支持此操作。');
    const missing = suggestedActionButton('生成第 ? 页音频');
    expect(missing?.disabled).toBe(true);
    expect(missing?.title).toBe('该页面已不存在。');
  });

  it('disables the text-only suggestion while the target page failed or is generating', async () => {
    const baseline = createEditorDocument();
    baseline.nativeSlides[0]!.slide.narration = { markdown: '保存的讲稿' };
    const onRegeneratePageNarration = vi.fn();
    const onAssistantPrompt = vi.fn().mockResolvedValue(
      decksmithSuggestionResponse([
        { kind: 'regenerate-page-narration-text', pageId: 'page-1' },
        { kind: 'regenerate-page-narration', pageId: 'page-1' },
      ]),
    );

    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          generationStatusByPageId={{
            'page-1': { phase: 'narration', state: 'failed', message: '讲稿生成失败' },
          }}
          onAssistantPrompt={onAssistantPrompt}
          onRegeneratePageNarration={onRegeneratePageNarration}
        />,
      ),
    );
    await askDecksmithForSuggestions();

    const textOnly = suggestedActionButton('仅重新生成第 1 页讲稿');
    expect(textOnly?.disabled).toBe(true);
    expect(textOnly?.title).toBe(
      '本页生成失败或仍在生成中，请改用“重新生成第 1 页讲稿、音频和动画”。',
    );
    // 完整重试仍可用。
    await act(async () => suggestedActionButton('重新生成第 1 页讲稿、音频和动画')?.click());
    expect(onRegeneratePageNarration).toHaveBeenCalledWith('page-1');
  });

  it('routes interactive narration suggestions and refuses slide-only kinds', async () => {
    const onSaveInteractivePageNarrationAndGenerate = vi.fn();
    const onRegeneratePageNarration = vi.fn();
    const onAssistantPrompt = vi.fn().mockResolvedValue(
      decksmithSuggestionResponse([
        { kind: 'regenerate-page-narration', pageId: 'interactive-page' },
        { kind: 'generate-page-audio', pageId: 'interactive-page' },
        { kind: 'regenerate-page-narration-text', pageId: 'interactive-page' },
        { kind: 'regenerate-page-animations', pageId: 'interactive-page' },
      ]),
    );

    // Decksmith 快捷指令只在幻灯片页出现，因此从第 2 页（幻灯片）发起，建议作用于第 2 页互动页。
    const slideDocument = normalizeReachDeckDocumentV2(createEditorDocument());
    const interactiveDocument = createInteractiveNarrationEditorDocument();
    if (interactiveDocument.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected v2 document');
    }
    const document = normalizeReachDeckDocumentV2({
      ...slideDocument,
      pages: [...slideDocument.pages, { ...interactiveDocument.pages[0]!, order: 2 }],
      resources: {
        ...slideDocument.resources,
        media: [...(slideDocument.resources.media ?? []), ...interactiveDocument.resources.media],
      },
    });
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          onAssistantPrompt={onAssistantPrompt}
          onRegeneratePageNarration={onRegeneratePageNarration}
          onSaveInteractivePageNarrationAndGenerate={onSaveInteractivePageNarrationAndGenerate}
        />,
      ),
    );
    await askDecksmithForSuggestions();

    await act(async () => suggestedActionButton('重新生成第 2 页讲稿和音频')?.click());
    expect(onRegeneratePageNarration).toHaveBeenCalledWith('interactive-page');
    await act(async () => suggestedActionButton('生成第 2 页音频')?.click());
    expect(onSaveInteractivePageNarrationAndGenerate).toHaveBeenCalledWith({
      pageId: 'interactive-page',
      text: '拖动滑块并观察结果。',
    });
    for (const label of ['仅重新生成第 2 页讲稿', '重新生成第 2 页动画']) {
      const button = suggestedActionButton(label);
      expect(button?.disabled).toBe(true);
      expect(button?.title).toBe('此操作仅适用于幻灯片页面。');
    }
  });

  it('disables generation actions while Decksmith owns the deck and says why', () => {
    const baseline = createEditorDocument();
    baseline.nativeSlides[0]!.slide.narration = { markdown: '保存的讲稿' };
    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          generationBlockedReason="Decksmith 正在修改课件"
          onRegeneratePage={vi.fn()}
        />,
      ),
    );
    const regenerate = container.querySelector<HTMLButtonElement>(
      '.reach-deck-editor__regenerate-page',
    );
    expect(regenerate?.disabled).toBe(true);
    expect(regenerate?.title).toBe('Decksmith 正在修改课件');
  });

  it.each([
    [false, true],
    [true, false],
  ] as const)(
    'lets a pending proposal block generation only until its lease expires (expired=%s)',
    async (expired, blocked) => {
      // 待审提案在服务端的租约过期后不再挡生成：提案仍挂在对话里，生成按钮恢复可用。
      const baseline = createEditorDocument();
      baseline.nativeSlides[0]!.slide.narration = { markdown: '保存的讲稿' };
      act(() =>
        root.render(
          <ReachDeckEditor
            assistantExpiredApprovalIds={expired ? ['approval-hung'] : []}
            assistantRecovery={{
              id: 'decksmith-hung',
              pageId: 'page-1',
              state: 'ready',
              response: {
                document: withFirstPageTitle(baseline, 'Hung proposal', 2),
                message: 'Hung proposal',
                runtimeApprovalId: 'approval-hung',
              },
            }}
            document={baseline}
            onAssistantPrompt={vi.fn()}
            onRegeneratePage={vi.fn()}
          />,
        ),
      );
      await act(async () => Promise.resolve());

      // 提案照样挂在对话里，可采用或放弃。
      expect(container.textContent).toContain('已生成修改建议，等待采用。');
      const regenerate = container.querySelector<HTMLButtonElement>(
        '.reach-deck-editor__regenerate-page',
      );
      expect(regenerate?.disabled).toBe(blocked);
      if (blocked) {
        expect(regenerate?.title).toBe('请先采用或放弃 Decksmith 的修改建议，再开始生成');
      }
    },
  );

  it('blocks new Decksmith requests while pages are generating and says why', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantBlockedReason="有页面正在生成"
          document={createEditorDocument()}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );
    expect(
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')?.disabled,
    ).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        '.reach-deck-editor__assistant-composer button[type="submit"]',
      )?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain('有页面正在生成');
  });

  it('keeps earlier Decksmith approvals applied after a later proposal is accepted', async () => {
    const baseline = createEditorDocument();
    const firstSaved = withFirstPageTitle(baseline, 'First approved revision', 2);
    const secondSaved = withFirstPageTitle(firstSaved, 'Second approved revision', 3);
    const response = (document: ReachDeckDocument, runtimeApprovalId: string) => ({
      changeSummary: {
        schemaVersion: 'reach-deck-editor-change-summary/v1' as const,
        status: 'grounded' as const,
        addedPages: [],
        removedPages: [],
        modifiedPages: [{ pageId: 'page-1', title: document.pages[0]!.title }],
        documentMetadataChanged: false,
        resourcesChanged: false,
      },
      document,
      message: 'AI revision ready.',
      runtimeApprovalId,
    });
    const onAssistantPrompt = vi
      .fn()
      .mockResolvedValueOnce(response(firstSaved, 'approval-1'))
      .mockResolvedValueOnce(response(secondSaved, 'approval-2'));
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    const renderEditor = (document: ReachDeckDocument, assistantAppliedApprovalId?: string) =>
      root.render(
        <ReachDeckEditor
          assistantAppliedApprovalId={assistantAppliedApprovalId}
          document={document}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      );
    const requestRevision = async () => {
      const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '精简当前页文字',
      );
      if (suggestion === undefined) throw new Error('Expected Decksmith suggestion');
      await act(async () => suggestion.click());
      const apply = container.querySelector<HTMLButtonElement>(
        '[role="log"] button[aria-label="应用修改"]',
      );
      if (apply === null) throw new Error('Expected proposal apply button');
      act(() => apply.click());
    };

    act(() => renderEditor(baseline));
    await requestRevision();
    act(() => renderEditor(firstSaved, 'approval-1'));
    await act(async () => Promise.resolve());

    await requestRevision();
    act(() => renderEditor(secondSaved, 'approval-2'));
    await act(async () => Promise.resolve());

    const statuses = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__assistant-explanation'),
    ].map((message) => message.textContent?.trim());
    expect(statuses.filter((status) => status?.includes('已应用 Decksmith 的修改。'))).toHaveLength(
      2,
    );
    expect(
      statuses.some((status) => status?.includes('Decksmith 修改正在保存，等待系统确认。')),
    ).toBe(false);
    expect(statuses.some((status) => status?.includes('已生成修改建议，等待采用。'))).toBe(false);
  });

  it('rejects a Decksmith response whose frozen origin does not match the request page', async () => {
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      historyRunId: 'wrong-origin-run',
      message: 'Must not enter page A',
      originPageId: 'page-2',
    });
    act(() =>
      root.render(
        <ReachDeckEditor document={createEditorDocument()} onAssistantPrompt={onAssistantPrompt} />,
      ),
    );
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());

    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Must not enter page A',
    );
    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      'Decksmith 回复与发起页面不匹配',
    );
  });

  it('discards a pending Decksmith change without touching the draft', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'AI revised page', 2);
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: response,
      message: '已完成 AI 修改。',
      runtimeApprovalId: 'runtime-approval-2',
    });
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      ),
    );

    const suggestion = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());
    const discardButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '放弃修改',
    );
    await act(async () => discardButton?.click());

    expect(onChange).not.toHaveBeenCalled();
    expect(onAssistantDecision).toHaveBeenCalledWith({
      runtimeApprovalId: 'runtime-approval-2',
      decision: 'rejected',
    });
    expect(container.textContent).toContain('已放弃本次 AI 修改。');
    expect(document.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt'),
    );
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === '应用修改'),
    ).toBe(false);
  });

  it('previews a pending Decksmith change transiently without applying or approving it', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'Previewed AI page', 2);
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: response,
      message: '已完成 AI 修改。',
      runtimeApprovalId: 'runtime-approval-preview',
    });
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      ),
    );
    const suggestion = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());

    const previewButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '按住预览',
    );
    expect(previewButton).not.toBeUndefined();
    act(() => previewButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(container.querySelector('[data-previewing]')).not.toBeNull();
    expect(container.querySelector('.reach-deck-editor__player-preview-layer')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onAssistantDecision).not.toHaveBeenCalled();

    act(() => previewButton?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })));
    expect(container.querySelector('[data-previewing]')).toBeNull();
    expect(container.querySelector('.reach-deck-editor__player-preview-layer')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onAssistantDecision).not.toHaveBeenCalled();
  });

  it('waits for candidate media, reuses exact identities, deduplicates object keys, and retries', async () => {
    vi.useFakeTimers();
    try {
      const baseline = createEditorDocument();
      baseline.resources.media = [
        {
          id: 'media-shared',
          objectKey: 'reach-deck/images/shared.png',
          contentType: 'image/png',
          digest: 'sha256:shared',
        },
        {
          id: 'media-image',
          objectKey: 'reach-deck/images/old.png',
          contentType: 'image/png',
          digest: 'sha256:old',
        },
      ];
      const response = withCandidateImage(
        withFirstPageTitle(baseline, 'Previewed media page', 2),
        'media-image',
        'reach-deck/images/new.png',
        'Generated candidate image',
      );
      response.resources.media = [
        baseline.resources.media[0]!,
        {
          id: 'media-image',
          objectKey: 'reach-deck/images/new.png',
          contentType: 'image/png',
          digest: 'sha256:new',
        },
        {
          id: 'media-image-alias',
          objectKey: 'reach-deck/images/new.png',
          contentType: 'image/png',
          digest: 'sha256:new',
        },
      ];
      const resolveNativeResourceUrl = vi
        .fn<(objectKey: string) => Promise<string>>()
        .mockRejectedValueOnce(new Error('temporary presign failure'))
        .mockResolvedValueOnce('https://signed.example/new.png');
      const onAssistantPrompt = vi.fn().mockResolvedValue({
        document: response,
        message: '已完成 AI 修改。',
        runtimeApprovalId: 'runtime-approval-media-preview',
      });
      act(() =>
        root.render(
          <ReachDeckEditor
            document={baseline}
            nativeResourceUrlsById={{
              'media-shared': 'https://signed.example/shared.png',
              'media-image': 'https://signed.example/old.png',
            }}
            onAssistantPrompt={onAssistantPrompt}
            resolveNativeResourceUrl={resolveNativeResourceUrl}
          />,
        ),
      );

      await act(async () =>
        [...container.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '精简当前页文字')
          ?.click(),
      );
      await act(async () => Promise.resolve());
      expect(resolveNativeResourceUrl).toHaveBeenCalledTimes(1);
      expect(resolveNativeResourceUrl).toHaveBeenCalledWith('reach-deck/images/new.png');

      const pendingPreviewButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="按住预览修改后的页面"]',
      );
      expect(pendingPreviewButton).toBeNull();
      expect(container.querySelector('.reach-deck-editor__player-preview-layer')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await act(async () => Promise.resolve());
      expect(resolveNativeResourceUrl).toHaveBeenCalledTimes(2);
      const previewButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="按住预览修改后的页面"]',
      );
      expect(previewButton).not.toBeNull();
      act(() =>
        previewButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })),
      );
      const previewLayer = container.querySelector('.reach-deck-editor__player-preview-layer');
      expect(previewLayer).not.toBeNull();
      const previewImage = previewLayer?.querySelector<HTMLImageElement>(
        '[data-native-v2-resource-id="media-image"]',
      );
      expect(previewImage?.src).toBe('https://signed.example/new.png');
      expect(previewImage?.src).not.toBe('https://signed.example/old.png');
      act(() =>
        previewButton?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 })),
      );

      act(() =>
        root.render(
          <ReachDeckEditor
            document={baseline}
            nativeResourceUrlsById={{
              'media-shared': 'https://signed.example/shared.png',
              'media-image': 'https://signed.example/old.png',
            }}
            onAssistantPrompt={onAssistantPrompt}
            resolveNativeResourceUrl={resolveNativeResourceUrl}
          />,
        ),
      );
      expect(resolveNativeResourceUrl).toHaveBeenCalledTimes(2);
      expect(container.querySelector('button[aria-label="按住预览修改后的页面"]')).not.toBeNull();

      resolveNativeResourceUrl.mockResolvedValueOnce('https://signed.example/new-v2.png');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      });
      expect(resolveNativeResourceUrl).toHaveBeenCalledTimes(3);
      const refreshedPreviewButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="按住预览修改后的页面"]',
      );
      act(() =>
        refreshedPreviewButton?.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        ),
      );
      expect(
        container.querySelector<HTMLImageElement>(
          '.reach-deck-editor__player-preview-layer [data-native-v2-resource-id="media-image"]',
        )?.src,
      ).toBe('https://signed.example/new-v2.png');
      act(() =>
        refreshedPreviewButton?.dispatchEvent(
          new MouseEvent('pointerup', { bubbles: true, button: 0 }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a pending Decksmith decision inert while the editor is disabled', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'AI revised page', 2);
    const onAssistantDecision = vi.fn();
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: response,
      message: '已完成 AI 修改。',
      runtimeApprovalId: 'runtime-approval-disabled',
    });
    const onChange = vi.fn();
    const renderEditor = (disabled = false) =>
      root.render(
        <ReachDeckEditor
          disabled={disabled}
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      );

    act(() => renderEditor());
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());
    act(() => renderEditor(true));

    const decisionButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent === '应用修改' || button.textContent === '放弃修改',
    );
    expect(decisionButtons).toHaveLength(2);
    expect(decisionButtons.every((button) => button.disabled)).toBe(true);
    act(() => decisionButtons.forEach((button) => button.click()));
    expect(onChange).not.toHaveBeenCalled();
    expect(onAssistantDecision).not.toHaveBeenCalled();
  });

  it('offers a recovered Decksmith proposal without applying it automatically', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'Recovered AI page', 2);
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'decksmith-job-1',
            state: 'ready',
            response: {
              changeSummary: {
                schemaVersion: 'reach-deck-editor-change-summary/v1',
                status: 'unavailable',
                reason: 'historical-baseline-unavailable',
              },
              document: response,
              message: 'Recovered proposal',
            },
          }}
          document={baseline}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain('Recovered proposal');
    expect(container.querySelector('[aria-label="未知页面的历史恢复结果"]')).not.toBeNull();
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Recovered proposal',
    );
    expect(
      container.querySelector('[data-change-summary-status="unavailable"]')?.textContent,
    ).toContain('无可用的结构化实际变更摘要');
    expect(onChange).not.toHaveBeenCalled();
    const applyButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '应用修改',
    );
    act(() => applyButton?.click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pages: response.pages }));
  });

  it('keeps a page-B recovery out of page A until the teacher switches to its exact origin', async () => {
    const baseline = createTwoPageEditorDocument();
    const response = structuredClone(baseline);
    response.pages[1] = { ...response.pages[1]!, title: 'Recovered page B' };

    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'decksmith-page-b',
            pageId: 'page-2',
            state: 'ready',
            response: { document: response, message: 'Recovered only for B' },
          }}
          document={baseline}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Recovered only for B',
    );
    expect(container.querySelector('.reach-deck-editor__assistant-module-recovery')).toBeNull();

    const pageB = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li > [data-page-card]'),
    ].find((page) => page.textContent?.includes('Second page'));
    await act(async () => pageB?.click());

    expect(container.querySelector('[role="log"]')?.textContent).toContain('Recovered only for B');
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Recovered proposal',
    );
  });

  it('key-upserts a recovered proposal that arrives after persisted history hydration', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'Recovered with history', 2);
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    const history = {
      pageId: 'page-1',
      loading: false,
      hasOlder: false,
      entries: [
        {
          id: 'runtime-run-recovery:assistant',
          kind: 'message' as const,
          role: 'assistant' as const,
          text: 'Persisted response before recovery metadata',
        },
      ],
    };
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantHistory={history}
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());
    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      'Persisted response before recovery metadata',
    );

    act(() =>
      root.render(
        <ReachDeckEditor
          assistantHistory={history}
          assistantRecovery={{
            id: 'decksmith-job-recovery',
            pageId: 'page-1',
            state: 'ready',
            response: {
              changeSummary: {
                schemaVersion: 'reach-deck-editor-change-summary/v1',
                status: 'grounded',
                addedPages: [],
                removedPages: [],
                modifiedPages: [{ pageId: 'page-1', title: 'Recovered with history' }],
                documentMetadataChanged: false,
                resourcesChanged: false,
              },
              document: response,
              historyRunId: 'runtime-run-recovery',
              message: 'Recovered proposal with history',
              originPageId: 'page-1',
              runtimeApprovalId: 'runtime-approval-recovery',
            },
          }}
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain('已生成修改建议，等待采用。');
    expect(container.textContent).not.toContain('Recovered proposal with history');
    expect(container.querySelectorAll('[role="group"][aria-label="AI 修改确认"]')).toHaveLength(1);
    expect(container.querySelector('[data-change-summary-status="grounded"]')).not.toBeNull();

    const applyButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '应用修改',
    );
    await act(async () => applyButton?.click());
    expect(onAssistantDecision).toHaveBeenCalledWith({
      runtimeApprovalId: 'runtime-approval-recovery',
      decision: 'approved',
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pages: response.pages }));
  });

  it('keeps legacy recovery controls bound to legacy pending state when the current page also has a proposal', async () => {
    const baseline = createEditorDocument();
    const currentResponse = withFirstPageTitle(baseline, 'Current-page proposal', 2);
    const legacyResponse = withFirstPageTitle(baseline, 'Legacy proposal', 2);
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    const renderRecovery = (recovery: ReachDeckEditorAssistantRecovery) =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={recovery}
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      );

    act(() =>
      renderRecovery({
        id: 'current-page-recovery',
        pageId: 'page-1',
        state: 'ready',
        response: {
          document: currentResponse,
          historyRunId: 'current-run',
          message: 'Current proposal',
          runtimeApprovalId: 'current-approval',
        },
      }),
    );
    await act(async () => Promise.resolve());
    act(() =>
      renderRecovery({
        id: 'legacy-recovery',
        state: 'ready',
        response: {
          document: legacyResponse,
          historyRunId: 'legacy-run',
          message: 'Legacy proposal',
          runtimeApprovalId: 'legacy-approval',
        },
      }),
    );
    await act(async () => Promise.resolve());

    const legacyPanel = container.querySelector('.reach-deck-editor__assistant-module-recovery');
    expect(legacyPanel).not.toBeNull();
    expect(
      legacyPanel?.querySelector<HTMLButtonElement>('button[aria-label="按住预览修改后的页面"]'),
    ).toBeNull();
    await act(async () =>
      legacyPanel?.querySelector<HTMLButtonElement>('button[aria-label="放弃恢复结果"]')?.click(),
    );
    expect(onAssistantDecision).toHaveBeenLastCalledWith({
      runtimeApprovalId: 'legacy-approval',
      decision: 'rejected',
    });
    expect(container.querySelector('.reach-deck-editor__assistant-module-recovery')).toBeNull();

    const currentApply = container.querySelector<HTMLButtonElement>(
      '[role="log"] button[aria-label="应用修改"]',
    );
    await act(async () => currentApply?.click());
    expect(onAssistantDecision).toHaveBeenLastCalledWith({
      runtimeApprovalId: 'current-approval',
      decision: 'approved',
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pages: currentResponse.pages }),
    );
  });

  it('preserves only an explicitly marked legacy live turn across page hydration until Runtime history replaces it', async () => {
    const document = createTwoPageEditorDocument();
    const candidate = withFirstPageTitle(document, 'Legacy live proposal', 2);
    const onAssistantDecision = vi.fn();
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: candidate,
      historyRunId: 'legacy-content-job',
      legacyHistoryRunId: 'legacy-content-job',
      message: 'Legacy live reply',
      originPageId: 'page-1',
      runtimeApprovalId: 'legacy-live-approval',
    });
    const history = (
      pageId: string,
      entries: Array<{
        id: string;
        kind: 'message';
        role: 'assistant' | 'user';
        text: string;
      }>,
    ) => ({ pageId, entries, hasOlder: false, loading: false });
    const renderEditor = (assistantHistory: ReturnType<typeof history>) =>
      root.render(
        <ReachDeckEditor
          assistantHistory={assistantHistory}
          document={document}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
        />,
      );

    act(() =>
      renderEditor(
        history('page-1', [
          {
            id: 'stale-server-run:assistant',
            kind: 'message',
            role: 'assistant',
            text: 'Unrelated stale server reply',
          },
        ]),
      ),
    );
    await act(async () => Promise.resolve());
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '精简当前页文字')
        ?.click(),
    );

    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      '已生成修改建议，等待采用。',
    );
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain('Legacy live reply');
    expect(container.querySelector('[role="group"][aria-label="AI 修改确认"]')).not.toBeNull();

    act(() =>
      renderEditor(
        history('page-1', [
          {
            id: 'unrelated-current-run:assistant',
            kind: 'message',
            role: 'assistant',
            text: 'Current unrelated reply',
          },
        ]),
      ),
    );
    await act(async () => Promise.resolve());
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Unrelated stale server reply',
    );
    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      '已生成修改建议，等待采用。',
    );
    expect(container.querySelector('[role="group"][aria-label="AI 修改确认"]')).not.toBeNull();

    const pageButton = (title: string) =>
      [
        ...container.querySelectorAll<HTMLElement>(
          '.reach-deck-editor__pages li > [data-page-card]',
        ),
      ].find((page) => page.textContent?.includes(title));
    act(() => pageButton('Second page')?.click());
    act(() => renderEditor(history('page-2', [])));
    await act(async () => Promise.resolve());
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain('Legacy live reply');
    act(() => pageButton('First page')?.click());
    act(() => renderEditor(history('page-1', [])));
    await act(async () => Promise.resolve());
    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      '已生成修改建议，等待采用。',
    );
    expect(container.querySelector('[role="group"][aria-label="AI 修改确认"]')).not.toBeNull();

    act(() =>
      renderEditor(
        history('page-1', [
          {
            id: 'runtime-authoritative-run:user',
            kind: 'message',
            role: 'user',
            text: '精简当前页文字',
          },
          {
            id: 'runtime-authoritative-run:assistant',
            kind: 'message',
            role: 'assistant',
            text: 'Legacy live reply',
          },
        ]),
      ),
    );
    await act(async () => Promise.resolve());
    expect(
      [...container.querySelectorAll('.reach-deck-editor__assistant-explanation')].filter(
        (message) => message.textContent?.includes('已生成修改建议，等待采用。'),
      ),
    ).toHaveLength(1);
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain('Legacy live reply');
    const discard = container.querySelector<HTMLButtonElement>(
      '[role="log"] button[aria-label="放弃修改"]',
    );
    expect(discard).not.toBeNull();
    await act(async () => discard?.click());
    expect(onAssistantDecision).toHaveBeenCalledWith({
      decision: 'rejected',
      runtimeApprovalId: 'legacy-live-approval',
    });
    expect(container.querySelector('[role="group"][aria-label="AI 修改确认"]')).toBeNull();
  });

  it('keeps a marked legacy recovery proposal anchored through refresh and canonical replacement', async () => {
    const baseline = createEditorDocument();
    const candidate = withFirstPageTitle(baseline, 'Legacy recovered proposal', 2);
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    const recovery: ReachDeckEditorAssistantRecovery = {
      id: 'legacy-recovery-job',
      pageId: 'page-1',
      state: 'ready',
      response: {
        document: candidate,
        historyRunId: 'legacy-recovery-job',
        legacyHistoryRunId: 'legacy-recovery-job',
        message: 'Legacy recovered reply',
        originPageId: 'page-1',
        runtimeApprovalId: 'legacy-recovery-approval',
      },
    };
    const renderRecovery = (
      entries: Array<{
        id: string;
        kind: 'message';
        role: 'assistant';
        text: string;
      }>,
    ) =>
      root.render(
        <ReachDeckEditor
          assistantHistory={{ pageId: 'page-1', entries, hasOlder: false, loading: false }}
          assistantRecovery={recovery}
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      );

    act(() => renderRecovery([]));
    await act(async () => Promise.resolve());
    act(() => renderRecovery([]));
    await act(async () => Promise.resolve());
    expect(container.querySelector('[role="log"]')?.textContent).toContain(
      '已生成修改建议，等待采用。',
    );
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Legacy recovered reply',
    );
    expect(container.querySelector('[role="group"][aria-label="AI 修改确认"]')).not.toBeNull();

    act(() =>
      renderRecovery([
        {
          id: 'runtime-recovered-run:assistant',
          kind: 'message',
          role: 'assistant',
          text: 'Legacy recovered reply',
        },
      ]),
    );
    await act(async () => Promise.resolve());
    expect(
      [...container.querySelectorAll('.reach-deck-editor__assistant-explanation')].filter(
        (message) => message.textContent?.includes('已生成修改建议，等待采用。'),
      ),
    ).toHaveLength(1);
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Legacy recovered reply',
    );
    const apply = container.querySelector<HTMLButtonElement>(
      '[role="log"] button[aria-label="应用修改"]',
    );
    expect(apply).not.toBeNull();
    await act(async () => apply?.click());
    expect(onAssistantDecision).toHaveBeenCalledWith({
      decision: 'approved',
      runtimeApprovalId: 'legacy-recovery-approval',
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pages: candidate.pages }));
    expect(container.querySelector('[role="group"][aria-label="AI 修改确认"]')).not.toBeNull();
    expect(container.textContent).toContain('重试确认应用');
  });

  it('retries only applied confirmation after an approved candidate is already in the draft', async () => {
    const baseline = createEditorDocument();
    const candidate = withFirstPageTitle(baseline, 'Confirmed content', 2);
    const onAssistantDecision = vi.fn();
    const onAssistantAppliedRetry = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();

    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'confirmation-recovery-job',
            pageId: 'page-1',
            state: 'ready',
            response: {
              document: candidate,
              historyRunId: 'confirmation-recovery-job',
              message: 'Confirmation recovery',
              originPageId: 'page-1',
              runtimeApprovalId: 'confirmation-approval',
            },
          }}
          document={baseline}
          onAssistantAppliedRetry={onAssistantAppliedRetry}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="应用修改"]')?.click(),
    );
    expect(onChange).toHaveBeenCalledOnce();
    expect(container.querySelector('button[aria-label="放弃修改"]')).toBeNull();

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="重试确认应用"]')?.click(),
    );
    expect(onAssistantAppliedRetry).toHaveBeenCalledWith('confirmation-approval');
    expect(onChange).toHaveBeenCalledOnce();
    expect(onAssistantDecision).toHaveBeenCalledOnce();
  });

  it('keeps legacy candidates without a runtime approval actionable', async () => {
    const baseline = createEditorDocument();
    const candidate = withFirstPageTitle(baseline, 'Legacy candidate', 2);
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'legacy-no-approval',
            pageId: 'page-1',
            state: 'ready',
            response: {
              document: candidate,
              historyRunId: 'legacy-no-approval',
              message: 'Legacy candidate',
              originPageId: 'page-1',
            },
          }}
          document={baseline}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());
    expect(container.querySelector('button[aria-label="应用修改"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="放弃修改"]')).not.toBeNull();
  });

  it('deduplicates a completed turn when persisted history hydrates before the response resolves', async () => {
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'Hydrated response', 2);
    let resolvePrompt!: (value: {
      changeSummary: {
        schemaVersion: 'reach-deck-editor-change-summary/v1';
        status: 'grounded';
        addedPages: never[];
        removedPages: never[];
        modifiedPages: { pageId: string; title: string }[];
        documentMetadataChanged: boolean;
        resourcesChanged: boolean;
      };
      document: ReachDeckDocument;
      historyRunId: string;
      message: string;
      originPageId: string;
    }) => void;
    const onAssistantPrompt = vi.fn(
      () =>
        new Promise<Parameters<typeof resolvePrompt>[0]>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const history = {
      pageId: 'page-1',
      loading: false,
      hasOlder: false,
      entries: [
        {
          id: 'runtime-run-complete:user',
          kind: 'message' as const,
          role: 'user' as const,
          text: '精简当前页文字',
        },
        {
          id: 'runtime-run-complete:assistant',
          kind: 'message' as const,
          role: 'assistant' as const,
          text: 'Persisted completed response',
        },
      ],
    };
    const renderEditor = () =>
      root.render(
        <ReachDeckEditor
          assistantHistory={{ ...history, entries: [...history.entries] }}
          document={baseline}
          onAssistantPrompt={onAssistantPrompt}
        />,
      );

    act(renderEditor);
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    act(() => suggestion?.click());
    await act(async () => Promise.resolve());
    act(renderEditor);
    await act(async () => Promise.resolve());
    await act(async () => {
      resolvePrompt({
        changeSummary: {
          schemaVersion: 'reach-deck-editor-change-summary/v1',
          status: 'grounded',
          addedPages: [],
          removedPages: [],
          modifiedPages: [{ pageId: 'page-1', title: 'Hydrated response' }],
          documentMetadataChanged: false,
          resourcesChanged: false,
        },
        document: response,
        historyRunId: 'runtime-run-complete',
        message: 'Persisted completed response',
        originPageId: 'page-1',
      });
      await Promise.resolve();
    });
    act(renderEditor);
    await act(async () => Promise.resolve());

    expect(
      [...container.querySelectorAll('.reach-deck-editor__assistant-message.is-user')].filter(
        (message) => message.textContent === '精简当前页文字',
      ),
    ).toHaveLength(1);
    expect(
      [...container.querySelectorAll('.reach-deck-editor__assistant-message.is-assistant')].filter(
        (message) => message.textContent?.includes('Persisted completed response'),
      ),
    ).toHaveLength(1);
    expect(container.querySelectorAll('[role="group"][aria-label="AI 修改确认"]')).toHaveLength(1);
    expect(container.querySelector('[data-change-summary-status="grounded"]')).not.toBeNull();
  });

  it('reconciles a failed optimistic user message only with a newly persisted canonical turn', async () => {
    const baseline = createEditorDocument();
    const prompt = '精简当前页文字';
    const onAssistantPrompt = vi.fn().mockRejectedValue(new Error('request failed'));
    const priorHistory = {
      pageId: 'page-1',
      loading: false,
      hasOlder: false,
      entries: [
        {
          id: 'prior-identical-run:user',
          kind: 'message' as const,
          role: 'user' as const,
          text: prompt,
        },
      ],
    };
    const renderEditor = (entries = priorHistory.entries) =>
      root.render(
        <ReachDeckEditor
          assistantHistory={{ ...priorHistory, entries }}
          document={baseline}
          onAssistantPrompt={onAssistantPrompt}
        />,
      );

    act(() => renderEditor());
    const suggestion = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === prompt,
    );
    await act(async () => suggestion?.click());
    expect(container.querySelector('[role="log"]')?.textContent).toContain('request failed');
    expect(
      [...container.querySelectorAll('.reach-deck-editor__assistant-message.is-user')].filter(
        (message) => message.textContent === prompt,
      ),
    ).toHaveLength(2);

    act(() =>
      renderEditor([
        ...priorHistory.entries,
        {
          id: 'failed-run:user',
          kind: 'message' as const,
          role: 'user' as const,
          text: prompt,
        },
      ]),
    );
    await act(async () => Promise.resolve());
    expect(
      [...container.querySelectorAll('.reach-deck-editor__assistant-message.is-user')].filter(
        (message) => message.textContent === prompt,
      ),
    ).toHaveLength(2);
    expect(container.querySelector('[role="log"]')?.textContent).toContain('request failed');
  });

  it('reconciles a cancelled optimistic user message when its canonical turn hydrates later', async () => {
    let resolvePrompt!: (value: { message: string }) => void;
    const onAssistantPrompt = vi.fn(
      () =>
        new Promise<{ message: string }>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const onAssistantCancel = vi.fn().mockResolvedValue(undefined);
    const renderEditor = (options?: { active?: boolean; withHistory?: boolean }) =>
      root.render(
        <ReachDeckEditor
          assistantHistory={
            options?.withHistory
              ? {
                  pageId: 'page-1',
                  loading: false,
                  hasOlder: false,
                  entries: [
                    {
                      id: 'cancelled-run:user',
                      kind: 'message',
                      role: 'user',
                      text: '精简当前页文字',
                    },
                  ],
                }
              : undefined
          }
          assistantJobActive={options?.active}
          document={createEditorDocument()}
          onAssistantCancel={onAssistantCancel}
          onAssistantPrompt={onAssistantPrompt}
        />,
      );

    act(() => renderEditor());
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '精简当前页文字')
        ?.click(),
    );
    await act(async () => Promise.resolve());
    act(() => renderEditor({ active: true }));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="取消生成"]')?.click(),
    );
    act(() => renderEditor({ withHistory: true }));
    await act(async () => Promise.resolve());
    expect(
      [...container.querySelectorAll('.reach-deck-editor__assistant-message.is-user')].filter(
        (message) => message.textContent === '精简当前页文字',
      ),
    ).toHaveLength(1);

    await act(async () => {
      resolvePrompt({ message: 'ignored after cancellation' });
      await Promise.resolve();
    });
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'ignored after cancellation',
    );
  });
  it('refreshes hold-preview behavior when a recovered module-level proposal changes', async () => {
    const baseline = createEditorDocument();
    const firstResponse = withFirstPageTitle(baseline, 'First recovered preview', 2);
    const secondResponse = withFirstPageTitle(baseline, 'Second recovered preview', 2);
    const renderRecovery = (id: string, document: ReachDeckDocument) =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id,
            state: 'ready',
            response: { document, message: `Recovered ${id}` },
          }}
          document={baseline}
          onAssistantPrompt={vi.fn()}
        />,
      );

    act(() => renderRecovery('recovery-1', firstResponse));
    await act(async () => Promise.resolve());
    const firstButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="按住预览修改后的页面"]',
    );
    expect(firstButton).not.toBeNull();

    act(() => renderRecovery('recovery-2', secondResponse));
    await act(async () => Promise.resolve());
    const secondButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="按住预览修改后的页面"]',
    );
    expect(secondButton).toBe(firstButton);
    act(() =>
      secondButton?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })),
    );
    expect(container.querySelector('[data-previewing]')).not.toBeNull();
    expect(container.textContent).toContain('Recovered recovery-2');
    act(() =>
      secondButton?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 })),
    );
    expect(container.querySelector('[data-previewing]')).toBeNull();
  });
  it('marks a recovered proposal stale, blocks apply, and lets the teacher discard it', async () => {
    const onAssistantRecoveryResolve = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'decksmith-job-stale',
            state: 'stale',
            response: { document: createEditorDocument(), message: 'Recovered proposal' },
          }}
          document={createEditorDocument()}
          onAssistantPrompt={vi.fn()}
          onAssistantRecoveryResolve={onAssistantRecoveryResolve}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain('已过期');
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === '应用修改'),
    ).toBe(false);
    const discardButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '放弃恢复结果',
    );
    act(() => discardButton?.click());
    expect(onAssistantRecoveryResolve).toHaveBeenCalledWith('decksmith-job-stale');
  });
  it('clears a terminal apply candidate so the Decksmith composer can start a new turn', async () => {
    const candidate = withFirstPageTitle(createEditorDocument(), 'Terminal candidate', 2);
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantApplyTerminalApprovalId="terminal-approval"
          assistantRecovery={{
            id: 'terminal-recovery',
            state: 'ready',
            response: {
              document: candidate,
              message: 'Terminal recovery',
              runtimeApprovalId: 'terminal-approval',
            },
          }}
          document={createEditorDocument()}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain('该修改无法完成应用确认');
    expect(container.querySelector('[role="group"][aria-label="AI 修改确认"]')).toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')?.disabled,
    ).toBe(false);
  });
  it('runs Decksmith on two pages at once and keeps each page busy on its own', async () => {
    const document = createTwoPageEditorDocument();
    const resolvers: Array<(response: { message: string }) => void> = [];
    const onAssistantPrompt = vi.fn(
      (_input: { pageId: string }) =>
        new Promise<{ message: string }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    act(() =>
      root.render(<ReachDeckEditor document={document} onAssistantPrompt={onAssistantPrompt} />),
    );
    await act(async () => Promise.resolve());
    const composer = () =>
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    const send = async (prompt: string) => {
      act(() => {
        setNativeValue(composer(), prompt);
        composer().dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () =>
        composer().form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(),
      );
    };
    const openPage = async (title: string) => {
      const page = [
        ...container.querySelectorAll<HTMLElement>(
          '.reach-deck-editor__pages li > [data-page-card]',
        ),
      ].find((candidate) => candidate.textContent?.includes(title));
      await act(async () => page?.click());
    };

    await send('Edit the first page');
    expect(composer().disabled).toBe(false);
    await openPage('Second page');
    expect(composer().disabled).toBe(false);
    await send('Edit the second page');
    expect(onAssistantPrompt).toHaveBeenCalledTimes(2);
    expect(
      onAssistantPrompt.mock.calls.map(([input]) => (input as { pageId: string }).pageId),
    ).toEqual(['page-1', 'page-2']);
    expect(
      container.querySelectorAll('.reach-deck-editor__assistant-page-indicator.is-running'),
    ).toHaveLength(2);

    // Finishing page 1 leaves page 2 busy.
    await act(async () => resolvers[0]!({ message: 'First page done' }));
    expect(composer().disabled).toBe(false);
    await openPage('First page');
    expect(composer().disabled).toBe(false);
    expect(container.querySelector('[role="log"]')?.textContent).toContain('First page done');
  });

  it('shows running and pending pages reported by the host', async () => {
    const document = createTwoPageEditorDocument();
    const candidate = withFirstPageTitle(document, 'Pending proposal', 2);
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantJobPageIds={['page-2']}
          assistantRecoveries={[
            {
              id: 'pending-page-1',
              pageId: 'page-1',
              state: 'ready',
              response: {
                document: candidate,
                message: 'Pending proposal',
                runtimeApprovalId: 'approval-page-1',
              },
            },
          ]}
          document={document}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    const cards = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li > [data-page-card]'),
    ];
    expect(cards[0]?.querySelector('.is-pending')).not.toBeNull();
    expect(cards[1]?.querySelector('.is-running')).not.toBeNull();
    // Page 1 has its own proposal to decide; page 2's running job does not block it.
    expect(container.querySelector('.reach-deck-editor__assistant-apply')).not.toBeNull();
  });

  it('asks before applying a proposal over another page turn and sends the override', async () => {
    const candidate = withFirstPageTitle(createEditorDocument(), 'Overriding proposal', 2);
    const onAssistantDecision = vi.fn().mockResolvedValue(undefined);
    const onAssistantApplyCheck = vi.fn().mockResolvedValue({
      expired: false,
      structural: false,
      overridable: true,
      conflicts: [
        {
          kind: 'held',
          pageIds: ['page-1'],
          holder: { originPageId: 'page-1', state: 'pending' },
        },
      ],
    });
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'overriding-recovery',
            pageId: 'page-1',
            state: 'ready',
            response: {
              document: candidate,
              message: 'Overriding proposal',
              runtimeApprovalId: 'overriding-approval',
            },
          }}
          document={createEditorDocument()}
          onAssistantApplyCheck={onAssistantApplyCheck}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    const apply = container.querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-apply');
    await act(async () => apply?.click());
    expect(onAssistantApplyCheck).toHaveBeenCalledWith('overriding-approval');
    expect(onAssistantDecision).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(
      '本修改会改动第 1 页，该页正被第 1 页发起的另一轮 Decksmith 占用（有未处理的修改建议）。',
    );
    expect(dialog?.textContent).toContain('覆盖后以本修改为准');

    const override = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent === '覆盖并应用',
    );
    await act(async () => override?.click());
    expect(onAssistantDecision).toHaveBeenCalledWith({
      runtimeApprovalId: 'overriding-approval',
      decision: 'approved',
      override: true,
    });
    expect(onChange).toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('keeps the draft untouched when approval fails and asks again on a new conflict', async () => {
    const candidate = withFirstPageTitle(createEditorDocument(), 'Conflicting proposal', 2);
    const conflict = Object.assign(new Error('HTTP 409'), {
      applyCheck: {
        expired: false,
        structural: false,
        overridable: true,
        conflicts: [
          {
            kind: 'held' as const,
            pageIds: ['page-1'],
            holder: { originPageId: 'page-1', state: 'running' as const },
          },
        ],
      },
    });
    const onAssistantDecision = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(undefined);
    // The preview itself fails (for example a network error); the decision must still gate it.
    const onAssistantApplyCheck = vi.fn().mockRejectedValue(new Error('network down'));
    const onAssistantAppliedRetry = vi.fn();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'conflicting-recovery',
            pageId: 'page-1',
            state: 'ready',
            response: {
              document: candidate,
              message: 'Conflicting proposal',
              runtimeApprovalId: 'conflicting-approval',
            },
          }}
          document={createEditorDocument()}
          onAssistantApplyCheck={onAssistantApplyCheck}
          onAssistantAppliedRetry={onAssistantAppliedRetry}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    await act(async () =>
      container.querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-apply')?.click(),
    );
    expect(onAssistantDecision).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('（运行中）');

    const override = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent === '覆盖并应用',
    );
    await act(async () => override?.click());
    expect(onAssistantDecision).toHaveBeenLastCalledWith({
      runtimeApprovalId: 'conflicting-approval',
      decision: 'approved',
      override: true,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onAssistantAppliedRetry).not.toHaveBeenCalled();
  });

  it('checks again instead of retrying confirmation after a failed approval', async () => {
    const candidate = withFirstPageTitle(createEditorDocument(), 'Failing proposal', 2);
    const onAssistantDecision = vi.fn().mockRejectedValueOnce(new Error('HTTP 503'));
    const onAssistantApplyCheck = vi
      .fn()
      .mockResolvedValue({ expired: false, structural: false, overridable: true, conflicts: [] });
    const onAssistantAppliedRetry = vi.fn();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'failing-recovery',
            pageId: 'page-1',
            state: 'ready',
            response: {
              document: candidate,
              message: 'Failing proposal',
              runtimeApprovalId: 'failing-approval',
            },
          }}
          document={createEditorDocument()}
          onAssistantApplyCheck={onAssistantApplyCheck}
          onAssistantAppliedRetry={onAssistantAppliedRetry}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());
    const apply = () =>
      container.querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-apply');

    await act(async () => apply()?.click());
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => apply()?.click());
    expect(onAssistantApplyCheck).toHaveBeenCalledTimes(2);
    expect(onAssistantAppliedRetry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('applies two recovered proposals on different pages one after the other', async () => {
    const document = createTwoPageEditorDocument();
    const retitlePage = (pageId: string, title: string) =>
      ({
        ...document,
        pages: document.pages.map((page) =>
          page.pageId === pageId ? { ...page, title, revision: page.revision + 1 } : page,
        ),
        nativeSlides: document.nativeSlides.map((binding) =>
          binding.pageId === pageId ? { ...binding, slide: { ...binding.slide, title } } : binding,
        ),
      }) as typeof document;
    const secondPage = document.pages[1]!;
    const first = retitlePage('page-1', 'Recovered first');
    const second = retitlePage(secondPage.pageId, 'Recovered second');
    const onAssistantDecision = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecoveries={[
            {
              id: 'recovered-first',
              pageId: 'page-1',
              state: 'ready',
              baselineDocument: document,
              response: {
                document: first,
                message: 'Recovered first',
                runtimeApprovalId: 'approval-first',
              },
            },
            {
              id: 'recovered-second',
              pageId: secondPage.pageId,
              state: 'ready',
              baselineDocument: document,
              response: {
                document: second,
                message: 'Recovered second',
                runtimeApprovalId: 'approval-second',
              },
            },
          ]}
          document={document}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());
    const apply = () =>
      container.querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-apply');

    await act(async () => apply()?.click());
    const pageTwo = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li > [data-page-card]'),
    ].find((page) => page.textContent?.includes('Second page'));
    await act(async () => pageTwo?.click());
    await act(async () => apply()?.click());

    expect(onAssistantDecision.mock.calls.map(([input]) => input)).toEqual([
      { runtimeApprovalId: 'approval-first', decision: 'approved' },
      { runtimeApprovalId: 'approval-second', decision: 'approved' },
    ]);
    const latest = onChange.mock.calls.at(-1)?.[0] as typeof document;
    expect(latest.pages.map((page) => page.title)).toEqual(['Recovered first', 'Recovered second']);
  });

  it('lands an approved proposal even when the draft changed while it was being approved', async () => {
    const document = createTwoPageEditorDocument();
    const secondPage = document.pages[1]!;
    const candidate = {
      ...document,
      pages: document.pages.map((page) =>
        page.pageId === secondPage.pageId
          ? { ...page, title: 'Approved second', revision: page.revision + 1 }
          : page,
      ),
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === secondPage.pageId
          ? { ...binding, slide: { ...binding.slide, title: 'Approved second' } }
          : binding,
      ),
    } as typeof document;
    let recordApproval: () => void = () => undefined;
    const onAssistantDecision = vi.fn(
      () => new Promise<void>((resolve) => (recordApproval = resolve)),
    );
    const onAssistantAppliedRetry = vi.fn();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'approved-while-editing',
            pageId: 'page-1',
            state: 'ready',
            baselineDocument: document,
            response: {
              document: candidate,
              message: 'Approved second',
              runtimeApprovalId: 'approved-while-editing',
            },
          }}
          document={document}
          onAssistantAppliedRetry={onAssistantAppliedRetry}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    let applying: Promise<void> | undefined;
    act(() => {
      container.querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-apply')?.click();
    });
    expect(onAssistantDecision).toHaveBeenCalledTimes(1);
    // Deleting the page the proposal changes while the approval is being recorded is held back:
    // the adoption that follows carries the proposal's own page structure.
    act(() => openPageMenu(container, 'Second page'));
    act(() => clickMenuItem(container, '删除'));
    expect(onChange).not.toHaveBeenCalled();
    expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).toContain('正在处理 Decksmith 的修改');
    await act(async () => {
      recordApproval();
      await applying;
      await Promise.resolve();
    });

    // The approval is recorded server-side: its candidate must land so it can be saved.
    const latest = onChange.mock.calls.at(-1)?.[0] as typeof document;
    expect(latest.pages.map((page) => page.title)).toContain('Approved second');
    expect(onAssistantAppliedRetry).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('这份修改暂时无法合并到当前草稿');
  });

  it('offers only discarding a proposal the deck structure no longer fits', async () => {
    const candidate = withFirstPageTitle(createEditorDocument(), 'Outdated proposal', 2);
    const onAssistantDecision = vi.fn().mockResolvedValue(undefined);
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'outdated-recovery',
            pageId: 'page-1',
            state: 'ready',
            response: {
              document: candidate,
              message: 'Outdated proposal',
              runtimeApprovalId: 'outdated-approval',
            },
          }}
          document={createEditorDocument()}
          onAssistantApplyCheck={() => ({
            expired: false,
            structural: false,
            overridable: false,
            conflicts: [{ kind: 'structure-changed', pageIds: ['page-1'] }],
          })}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );
    await act(async () => Promise.resolve());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-apply')?.click(),
    );
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('这份修改无法再应用，只能放弃');
    const labels = [...(dialog?.querySelectorAll('button') ?? [])].map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(['放弃这份修改', '关闭']);
    await act(async () =>
      [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])][0]?.click(),
    );
    expect(onAssistantDecision).toHaveBeenCalledWith({
      runtimeApprovalId: 'outdated-approval',
      decision: 'rejected',
    });
  });

  it('offers confirmation cleanup for an approved recovery that is already stale', async () => {
    const candidate = withFirstPageTitle(createEditorDocument(), 'Stale approved candidate', 2);
    const onAssistantAppliedRetry = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantApprovedApprovalId="stale-approved"
          assistantRecovery={{
            id: 'stale-approved-recovery',
            state: 'stale',
            response: {
              document: candidate,
              message: 'Stale approved recovery',
              runtimeApprovalId: 'stale-approved',
            },
          }}
          document={createEditorDocument()}
          onAssistantAppliedRetry={onAssistantAppliedRetry}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
        />,
      ),
    );
    await act(async () => Promise.resolve());

    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="重试确认应用"]');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    expect(onAssistantAppliedRetry).toHaveBeenCalledWith('stale-approved');
    expect(onChange).not.toHaveBeenCalled();
  });
  describe('structure changes beside unresolved Decksmith work', () => {
    const dialogButton = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
        (button) => button.textContent?.includes(label),
      );

    it('asks before deleting a page, then releases Decksmith and deletes it', async () => {
      const onChange = vi.fn();
      const onReleaseDecksmithStructureHold = vi.fn(async () => undefined);
      act(() =>
        root.render(
          <ReachDeckEditor
            decksmithStructureHold
            document={createTwoPageEditorDocument()}
            onChange={onChange}
            onReleaseDecksmithStructureHold={onReleaseDecksmithStructureHold}
          />,
        ),
      );

      act(() => openPageMenu(container, 'Second page'));
      act(() => clickMenuItem(container, '删除'));
      expect(onChange).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        '放弃后无法恢复',
      );

      await act(async () => dialogButton('放弃并继续')?.click());
      expect(onReleaseDecksmithStructureHold).toHaveBeenCalledTimes(1);
      expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(1);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(activePageTitle(container)).toBe('First page');
    });

    it('keeps the pages when the teacher cancels or Decksmith cannot be released', async () => {
      const onChange = vi.fn();
      const onReleaseDecksmithStructureHold = vi.fn(async () => {
        throw new Error('still running');
      });
      act(() =>
        root.render(
          <ReachDeckEditor
            decksmithStructureHold
            document={createTwoPageEditorDocument()}
            onChange={onChange}
            onReleaseDecksmithStructureHold={onReleaseDecksmithStructureHold}
          />,
        ),
      );

      act(() => openPageMenu(container, 'Second page'));
      act(() => clickMenuItem(container, '删除'));
      act(() => dialogButton('取消')?.click());
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(onReleaseDecksmithStructureHold).not.toHaveBeenCalled();

      act(() => openPageMenu(container, 'Second page'));
      act(() => clickMenuItem(container, '删除'));
      await act(async () => dialogButton('放弃并继续')?.click());
      expect(onReleaseDecksmithStructureHold).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        '页面结构未改动',
      );
      expect(onChange).not.toHaveBeenCalled();
    });

    it('rejects a pending proposal the editor holds before changing the page structure', async () => {
      const baseline = createTwoPageEditorDocument();
      const candidate = structuredClone(baseline);
      candidate.pages[0] = { ...candidate.pages[0]!, title: 'Proposed title' };
      const onAssistantDecision = vi.fn(async () => undefined);
      const onReleaseDecksmithStructureHold = vi.fn(async () => undefined);
      const onChange = vi.fn();
      act(() =>
        root.render(
          <ReachDeckEditor
            assistantRecovery={{
              id: 'pending-recovery',
              pageId: baseline.pages[0]!.pageId,
              state: 'ready',
              response: {
                document: candidate,
                historyRunId: 'pending-run',
                message: 'Retitled the first page',
                originPageId: baseline.pages[0]!.pageId,
                runtimeApprovalId: 'pending-approval',
              },
            }}
            document={baseline}
            onAssistantDecision={onAssistantDecision}
            onAssistantPrompt={vi.fn()}
            onChange={onChange}
            onReleaseDecksmithStructureHold={onReleaseDecksmithStructureHold}
          />,
        ),
      );
      await act(async () => Promise.resolve());

      act(() => openPageMenu(container, 'Second page'));
      act(() => clickMenuItem(container, '删除'));
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      await act(async () => dialogButton('放弃并继续')?.click());

      expect(onAssistantDecision).toHaveBeenCalledWith({
        runtimeApprovalId: 'pending-approval',
        decision: 'rejected',
      });
      expect(onReleaseDecksmithStructureHold).toHaveBeenCalledTimes(1);
      expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(1);
    });

    it('deletes a generating page after confirmation while other structure stays locked', async () => {
      const onChange = vi.fn();
      const onConfirmGeneratingPageDeletion = vi.fn();
      act(() =>
        root.render(
          <ReachDeckEditor
            allowDeletingGeneratingPages
            document={createTwoPageEditorDocument()}
            generationInFlightPageIds={['page-2']}
            lockedPageIds={['page-2']}
            onChange={onChange}
            onConfirmGeneratingPageDeletion={onConfirmGeneratingPageDeletion}
            structureLocked
          />,
        ),
      );

      act(() => openPageMenu(container, 'Second page'));
      const menuButton = (label: string) =>
        [
          ...(container
            .querySelector('.reach-deck-editor__page-menu')
            ?.querySelectorAll<HTMLButtonElement>('button') ?? []),
        ].find((button) => button.textContent?.includes(label));
      expect(menuButton('创建副本')?.disabled).toBe(true);
      expect(menuButton('删除')?.disabled).toBe(false);
      act(() => clickMenuItem(container, '删除'));
      expect(onChange).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        '其他页面继续生成',
      );

      await act(async () => dialogButton('删除')?.click());
      expect(onConfirmGeneratingPageDeletion).toHaveBeenCalledWith(['page-2']);
      expect(
        (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages.map((page) => page.pageId),
      ).toEqual(['page-1']);
    });

    it('deletes an idle page during generation without asking', () => {
      const onChange = vi.fn();
      const onConfirmGeneratingPageDeletion = vi.fn();
      act(() =>
        root.render(
          <ReachDeckEditor
            allowDeletingGeneratingPages
            document={createTwoPageEditorDocument()}
            generationInFlightPageIds={['page-1']}
            lockedPageIds={['page-1']}
            onChange={onChange}
            onConfirmGeneratingPageDeletion={onConfirmGeneratingPageDeletion}
            structureLocked
          />,
        ),
      );

      act(() => openPageMenu(container, 'Second page'));
      act(() => clickMenuItem(container, '删除'));
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(onConfirmGeneratingPageDeletion).not.toHaveBeenCalled();
      expect(
        (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages.map((page) => page.pageId),
      ).toEqual(['page-1']);
    });

    it('asks before undo restores a deleted page beside Decksmith work and keeps history on cancel', async () => {
      const onChange = vi.fn();
      const onReleaseDecksmithStructureHold = vi.fn(async () => undefined);
      const deck = createTwoPageEditorDocument();
      const render = (decksmithStructureHold: boolean) =>
        act(() =>
          root.render(
            <ReachDeckEditor
              decksmithStructureHold={decksmithStructureHold}
              document={deck}
              onChange={onChange}
              onReleaseDecksmithStructureHold={onReleaseDecksmithStructureHold}
            />,
          ),
        );
      const undo = () => container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')!;
      render(false);
      act(() => openPageMenu(container, 'Second page'));
      act(() => clickMenuItem(container, '删除'));
      expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(1);
      // 删页之后才开始 Decksmith：撤销会把页恢复回来，同样得先确认放弃 Decksmith 的工作。
      render(true);
      onChange.mockClear();

      act(() => undo().click());
      expect(onChange).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        '放弃后无法恢复',
      );
      act(() => dialogButton('取消')?.click());
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(onReleaseDecksmithStructureHold).not.toHaveBeenCalled();
      // 取消确认不消耗这一步撤销。
      expect(undo().disabled).toBe(false);

      act(() => undo().click());
      await act(async () => dialogButton('放弃并继续')?.click());
      expect(onReleaseDecksmithStructureHold).toHaveBeenCalledTimes(1);
      expect(
        (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages.map((page) => page.pageId),
      ).toEqual(['page-1', 'page-2']);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="重做课件修改"]')!.disabled,
      ).toBe(false);
    });

    it('confirms a redo that deletes a page which is now generating', async () => {
      const onChange = vi.fn();
      const onConfirmGeneratingPageDeletion = vi.fn();
      const deck = createTwoPageEditorDocument();
      const render = (generating: boolean) =>
        act(() =>
          root.render(
            <ReachDeckEditor
              allowDeletingGeneratingPages
              document={deck}
              generationInFlightPageIds={generating ? ['page-2'] : []}
              lockedPageIds={generating ? ['page-2'] : []}
              onChange={onChange}
              onConfirmGeneratingPageDeletion={onConfirmGeneratingPageDeletion}
            />,
          ),
        );
      render(false);
      act(() => openPageMenu(container, 'Second page'));
      act(() => clickMenuItem(container, '删除'));
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="撤销课件修改"]')!.click());
      expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(2);
      render(true);
      onChange.mockClear();

      act(() => container.querySelector<HTMLButtonElement>('[aria-label="重做课件修改"]')!.click());
      expect(onChange).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        '其他页面继续生成',
      );
      await act(async () => dialogButton('删除')?.click());
      expect(onConfirmGeneratingPageDeletion).toHaveBeenCalledWith(['page-2']);
      expect(
        (onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages.map((page) => page.pageId),
      ).toEqual(['page-1']);
    });

    it('commits page structure directly when no Decksmith work is unresolved', () => {
      const onChange = vi.fn();
      const onReleaseDecksmithStructureHold = vi.fn(async () => undefined);
      act(() =>
        root.render(
          <ReachDeckEditor
            document={createTwoPageEditorDocument()}
            onChange={onChange}
            onReleaseDecksmithStructureHold={onReleaseDecksmithStructureHold}
          />,
        ),
      );

      act(() => openPageMenu(container, 'Second page'));
      act(() => clickMenuItem(container, '删除'));
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(onReleaseDecksmithStructureHold).not.toHaveBeenCalled();
      expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument).pages).toHaveLength(1);
    });
  });

  it('lands an approved structural proposal while the host locks deck structure for it', async () => {
    // 宿主在存在待采用 / 已批准的 Decksmith 提案时传 structureLocked；采用这份提案本身不能被这把锁拦掉。
    const baseline = createEditorDocument();
    const candidate = structuredClone(baseline);
    candidate.pages.push({
      pageId: 'page-2',
      order: 2,
      revision: 1,
      sceneType: 'slide',
      title: 'Inserted page',
    });
    candidate.nativeSlides.push({
      pageId: 'page-2',
      slide: {
        ...candidate.nativeSlides[0]!.slide,
        id: 'native-slide-2',
        title: 'Inserted page',
      },
    });
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantRecovery={{
            id: 'structural-recovery',
            pageId: 'page-1',
            state: 'ready',
            response: {
              document: candidate,
              historyRunId: 'structural-run',
              message: 'Inserted a page',
              originPageId: 'page-1',
              runtimeApprovalId: 'structural-approval',
            },
          }}
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={vi.fn()}
          onChange={onChange}
          structureLocked
        />,
      ),
    );
    await act(async () => Promise.resolve());

    const applyButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '应用修改',
    );
    expect(applyButton).toBeDefined();
    await act(async () => applyButton?.click());
    expect(onAssistantDecision).toHaveBeenCalledWith({
      runtimeApprovalId: 'structural-approval',
      decision: 'approved',
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pages: [
          expect.objectContaining({ pageId: 'page-1' }),
          expect.objectContaining({ pageId: 'page-2' }),
        ],
      }),
    );
  });

  describe('versioned restore of an approved partial recovery (WP8 / M9)', () => {
    const fixture = () => {
      const partial = createEditorDocument();
      partial.pages[0] = { ...partial.pages[0]!, title: 'Applied first page', revision: 2 };
      partial.nativeSlides[0] = {
        ...partial.nativeSlides[0]!,
        slide: { ...partial.nativeSlides[0]!.slide, title: 'Applied first page' },
      };
      const candidate = structuredClone(partial);
      candidate.pages.push({
        pageId: 'page-2',
        order: 2,
        revision: 1,
        sceneType: 'slide',
        title: 'Second page',
      });
      candidate.nativeSlides.push({
        pageId: 'page-2',
        slide: {
          ...candidate.nativeSlides[0]!.slide,
          id: 'native-slide-2',
          title: 'Second page',
        },
      });
      return { partial, candidate };
    };
    const cleanCheck = {
      expired: false,
      structural: true,
      overridable: true,
      conflicts: [],
      changedPageIds: ['page-1', 'page-2'],
      envelopeChanged: false,
    };
    const renderRecovery = (
      partial: ReachDeckDocument,
      candidate: ReachDeckDocument,
      props: Partial<Parameters<typeof ReachDeckEditor>[0]>,
    ) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            assistantApprovedApprovalId="partial-approved"
            assistantRecovery={{
              id: 'partial-approved-recovery',
              pageId: 'page-1',
              state: 'stale',
              baselineDocument: partial,
              response: {
                document: candidate,
                message: 'Partially persisted recovery',
                runtimeApprovalId: 'partial-approved',
              },
            }}
            document={partial}
            onAssistantPrompt={vi.fn()}
            {...props}
          />,
        ),
      );
    const retryButton = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="重试确认应用"]');
    const reAdoptButton = () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === '重新采用 AI 修改',
      );

    it('restores only the missing pages after the host proves no later edit', async () => {
      const { partial, candidate } = fixture();
      const onAssistantAppliedRetry = vi.fn().mockResolvedValue(undefined);
      const onAssistantRestoreCheck = vi.fn().mockResolvedValue(cleanCheck);
      const onChange = vi.fn();
      renderRecovery(partial, candidate, {
        onAssistantAppliedRetry,
        onAssistantRestoreCheck,
        onChange,
        // The host locks structure while an approval is unresolved; restoring it is still allowed.
        structureLocked: true,
      });
      await act(async () => Promise.resolve());

      expect(retryButton()).not.toBeNull();
      await act(async () => retryButton()?.click());
      expect(onAssistantRestoreCheck).toHaveBeenCalledWith('partial-approved');
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pages: candidate.pages }));
      expect(onAssistantAppliedRetry).toHaveBeenCalledWith('partial-approved');
      expect(reAdoptButton()).toBeUndefined();
    });

    it('offers an explicit re-adopt instead of overwriting a later edit of the same page', async () => {
      const { partial, candidate } = fixture();
      const onAssistantAppliedRetry = vi.fn().mockResolvedValue(undefined);
      const onAssistantRestoreCheck = vi.fn().mockResolvedValue({
        ...cleanCheck,
        conflicts: [{ kind: 'stale', pageIds: ['page-1'] }],
      });
      const onChange = vi.fn();
      renderRecovery(partial, candidate, {
        onAssistantAppliedRetry,
        onAssistantRestoreCheck,
        onChange,
      });
      await act(async () => Promise.resolve());

      await act(async () => retryButton()?.click());
      expect(onChange).not.toHaveBeenCalled();
      expect(onAssistantAppliedRetry).not.toHaveBeenCalled();
      expect(container.textContent).toContain('这些页在 AI 修改之后又被编辑过');
      expect(reAdoptButton()?.dataset.readoptReason).toBe('later-edit');

      await act(async () => reAdoptButton()?.click());
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pages: candidate.pages }));
      expect(onAssistantAppliedRetry).toHaveBeenCalledWith('partial-approved');
    });

    it('never falls back to overwriting the whole draft when re-adopt cannot merge by page', async () => {
      const { partial, candidate } = fixture();
      const onAssistantAppliedRetry = vi.fn().mockResolvedValue(undefined);
      // 非结构性提案改动的 page-2 不在草稿里：按页合并不可能。
      const onAssistantRestoreCheck = vi.fn().mockResolvedValue({
        ...cleanCheck,
        structural: false,
        changedPageIds: ['page-2'],
      });
      const onChange = vi.fn();
      renderRecovery(partial, candidate, {
        onAssistantAppliedRetry,
        onAssistantRestoreCheck,
        onChange,
      });
      await act(async () => Promise.resolve());

      await act(async () => retryButton()?.click());
      expect(reAdoptButton()?.dataset.readoptReason).toBe('unmergeable');
      await act(async () => reAdoptButton()?.click());
      expect(onChange).not.toHaveBeenCalled();
      expect(onAssistantAppliedRetry).not.toHaveBeenCalled();
      expect(container.textContent).toContain('这份 AI 修改已无法与当前课件按页合并');
    });

    it('never restores without a host proof (cross-tab edits are invisible locally)', async () => {
      const { partial, candidate } = fixture();
      const onAssistantAppliedRetry = vi.fn().mockResolvedValue(undefined);
      const onChange = vi.fn();
      renderRecovery(partial, candidate, { onAssistantAppliedRetry, onChange });
      await act(async () => Promise.resolve());

      await act(async () => retryButton()?.click());
      expect(onChange).not.toHaveBeenCalled();
      expect(onAssistantAppliedRetry).not.toHaveBeenCalled();
      expect(reAdoptButton()?.dataset.readoptReason).toBe('unproven');
    });

    it('does not restore when the teacher edits while the proof is pending', async () => {
      const { partial, candidate } = fixture();
      const onAssistantAppliedRetry = vi.fn().mockResolvedValue(undefined);
      let resolveCheck!: (value: typeof cleanCheck) => void;
      const onAssistantRestoreCheck = vi.fn(
        () =>
          new Promise<typeof cleanCheck>((resolve) => {
            resolveCheck = resolve;
          }),
      );
      const onChange = vi.fn();
      renderRecovery(partial, candidate, {
        onAssistantAppliedRetry,
        onAssistantRestoreCheck,
        onChange,
      });
      await act(async () => Promise.resolve());

      act(() => retryButton()?.click());
      // 检查进行中教师删掉了画布上的一个元素（本地编辑）。改结构在采用决定进行中会被挡下，
      // 这里用页内编辑代表「检查期间课件有新的修改」。
      const elementId = partial.nativeSlides[0]!.slide.elements[0]!.id;
      const element = container.querySelector<HTMLElement>(nativeElementSelector(elementId));
      act(() => element?.click());
      act(() =>
        element?.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Delete' }),
        ),
      );
      const edited = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
      expect(edited.nativeSlides[0]!.slide.elements.map((item) => item.id)).not.toContain(
        elementId,
      );
      await act(async () => resolveCheck(cleanCheck));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalledWith(
        expect.objectContaining({ pages: candidate.pages }),
      );
      expect(onAssistantAppliedRetry).not.toHaveBeenCalled();
      expect(container.textContent).toContain('检查期间课件有新的修改');
    });
  });
  describe('stopped Decksmith retry', () => {
    const retryButton = () => container.querySelector<HTMLButtonElement>('[aria-label="重试生成"]');
    const stopButton = () => container.querySelector<HTMLButtonElement>('[aria-label="取消生成"]');
    const send = async (prompt: string) => {
      const composer = container.querySelector<HTMLTextAreaElement>(
        '#reach-deck-assistant-prompt',
      )!;
      act(() => {
        setNativeValue(composer, prompt);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => composer.form?.requestSubmit());
    };
    const setup = (extra: Partial<Parameters<typeof ReachDeckEditor>[0]> = {}) => {
      const resolvers: Array<(value: { message: string }) => void> = [];
      const onAssistantPrompt = vi.fn(
        (_request: import('../src/ReachDeckEditor').ReachDeckEditorAssistantRequest) =>
          new Promise<{ message: string }>((resolve) => resolvers.push(resolve)),
      );
      const onAssistantCancel = vi.fn().mockResolvedValue(undefined);
      const document = createTwoPageEditorDocument();
      let props = { document, onAssistantPrompt, onAssistantCancel, ...extra };
      const render = (update: Partial<Parameters<typeof ReachDeckEditor>[0]> = {}) => {
        props = { ...props, ...update };
        act(() => root.render(<ReachDeckEditor {...props} />));
      };
      render();
      return { render, onAssistantPrompt, onAssistantCancel, resolvers, document };
    };
    const stop = async (state: ReturnType<typeof setup>) => {
      state.render({ assistantJobPageIds: ['page-1'] });
      await act(async () => stopButton()?.click());
      state.render({ assistantJobPageIds: [] });
    };

    it('manually retries the frozen prompt and context against a fresh draft, once, ignoring the old promise', async () => {
      const state = setup();
      act(() =>
        container
          .querySelector<HTMLElement>(
            '[data-native-v2-editable] [data-native-v2-element-id="title-1"]',
          )
          ?.click(),
      );
      act(() =>
        container.querySelector<HTMLButtonElement>('#reach-deck-right-tab-decksmith')?.click(),
      );
      const composer = container.querySelector<HTMLTextAreaElement>(
        '#reach-deck-assistant-prompt',
      )!;
      act(() => {
        setNativeValue(composer, '@Sec');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() =>
        composer.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
      );
      act(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="移除当前页面上下文"]')?.click(),
      );
      await send('只修改引用页');
      const original = state.onAssistantPrompt.mock.calls[0]![0];
      expect(original.selectedElementIds).toEqual(['title-1']);
      await stop(state);
      expect(state.onAssistantPrompt).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('已停止生成');
      expect(container.querySelector('.is-thinking')).toBeNull();
      // Composer changes after stopping must not change the stopped request.
      act(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="添加当前页面上下文"]')?.click(),
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="移除页面引用 Second page"]')
          ?.click(),
      );
      state.render({
        document: {
          ...withFirstPageTitle(state.document, 'New draft', 2),
          pages: state.document.pages.map((page, index) =>
            index === 0 ? { ...page, title: 'New draft', revision: 2 } : page,
          ),
        },
      });
      const retry = retryButton()!;
      await act(async () => {
        retry.click();
        retry.click();
      });
      expect(state.onAssistantPrompt).toHaveBeenCalledTimes(2);
      const retried = state.onAssistantPrompt.mock.calls[1]![0];
      expect(retried).toMatchObject({
        prompt: original.prompt,
        pageId: 'page-1',
        includeCurrentPage: false,
        mentionedPageIds: ['page-2'],
        selectedElementIds: ['title-1'],
      });
      expect(retried.document.pages[0]?.title).toBe('New draft');
      expect(retried.onProgress).not.toBe(original.onProgress);
      await act(async () => {
        original.onProgress?.('Late old progress');
        state.resolvers[0]!({ message: 'Late old response' });
      });
      expect(container.textContent).not.toContain('Late old');
      await act(async () => state.resolvers[1]!({ message: 'Retry completed' }));
      expect(container.textContent).toContain('Retry completed');
    });

    it('keeps retry on failed new-topic and clears it after successful new-topic or a normal request', async () => {
      const onAssistantNewTopic = vi
        .fn()
        .mockRejectedValueOnce(new Error('topic failed'))
        .mockResolvedValue(undefined);
      const state = setup({ onAssistantNewTopic });
      await send('Stopped prompt');
      await stop(state);
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="新话题"]')?.click(),
      );
      expect(retryButton()).not.toBeNull();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="新话题"]')?.click(),
      );
      expect(retryButton()).toBeNull();
      await send('Next prompt');
      await stop(state);
      await send('A different request');
      expect(retryButton()).toBeNull();
      expect(state.onAssistantPrompt).toHaveBeenCalledTimes(3);
    });

    it('keeps stopped records isolated by page and removes retry when an external topic boundary arrives', async () => {
      const state = setup();
      await send('Page one request');
      await stop(state);
      const open = (title: string) =>
        act(() =>
          [...container.querySelectorAll<HTMLElement>('[data-page-card]')]
            .find((page) => page.textContent?.includes(title))
            ?.click(),
        );
      open('Second page');
      expect(retryButton()).toBeNull();
      open('First page');
      expect(retryButton()).not.toBeNull();
      state.render({
        assistantHistory: {
          pageId: 'page-1',
          loading: false,
          hasOlder: false,
          entries: [
            {
              id: 'new:boundary',
              kind: 'new-topic',
              messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
              replacements: {},
            },
          ],
        },
      });
      expect(retryButton()).toBeNull();
    });

    it('waits for cancellation confirmation before discarding an original response or exposing retry', async () => {
      let finishCancel!: () => void;
      const state = setup();
      state.onAssistantCancel.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishCancel = resolve;
          }),
      );
      await send('Pending cancel');
      state.render({ assistantJobPageIds: ['page-1'] });
      act(() => stopButton()?.click());
      await act(async () => state.resolvers[0]!({ message: 'Racing response' }));
      expect(container.textContent).not.toContain('Racing response');
      expect(retryButton()).toBeNull();
      await act(async () => finishCancel());
      state.render({ assistantJobPageIds: [] });
      expect(retryButton()).not.toBeNull();
      expect(container.textContent).not.toContain('Racing response');
    });

    it('keeps the new host job stoppable and removes the older stopped request', async () => {
      const state = setup({ assistantJobUserMessageIdsByPage: { 'page-1': 'original:user' } });
      await send('Original stopped request');
      await stop(state);
      expect(retryButton()).not.toBeNull();
      state.render({
        assistantJobPageIds: ['page-1'],
        assistantJobUserMessageIdsByPage: { 'page-1': 'new-run:user' },
      });
      expect(stopButton()).not.toBeNull();
      expect(retryButton()).toBeNull();
      state.render({ assistantJobPageIds: [] });
      expect(retryButton()).toBeNull();
    });

    it('clears retry after confirmed conversation deletion', async () => {
      const state = setup({ onAssistantDeleteConversation: vi.fn().mockResolvedValue(undefined) });
      await send('Delete this stopped request');
      await stop(state);
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="清除当前对话"]')?.click(),
      );
      await act(async () =>
        [...window.document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
          .find((button) => button.textContent?.trim() === '继续')
          ?.click(),
      );
      expect(retryButton()).toBeNull();
    });

    it.each([
      ['zh-CN', '重试生成', '已停止生成'],
      ['en-US', 'Retry generation', 'Generation stopped'],
    ])(
      'renders accessible retry in %s and blocks it with host state',
      async (_locale, label, stopped) => {
        const state = setup({
          translate: (key) =>
            key === 'reachDeck.editor.assistant.retry'
              ? label
              : key === 'reachDeck.editor.assistant.stopped'
                ? stopped
                : key,
        });
        await send('Original');
        await stop(state);
        const button = () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
        expect(button()?.title).toBe(label);
        expect(container.textContent).toContain(stopped);
        state.render({ assistantBlockedReason: 'Blocked' });
        expect(button()?.disabled).toBe(true);
        act(() => button()?.click());
        expect(state.onAssistantPrompt).toHaveBeenCalledTimes(1);
      },
    );

    it('only recovers a prompt from the exact running job in the current topic', async () => {
      const state = setup({
        assistantJobPageIds: ['page-1'],
        assistantJobUserMessageIdsByPage: { 'page-1': 'running:user' },
        assistantHistory: {
          pageId: 'page-1',
          loading: false,
          hasOlder: false,
          entries: [
            { id: 'older:user', kind: 'message', role: 'user', text: 'Wrong old request' },
            {
              id: 'boundary',
              kind: 'new-topic',
              messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
              replacements: {},
            },
            { id: 'running:user', kind: 'message', role: 'user', text: 'Restored exact request' },
          ],
        },
      });
      await stop(state);
      await act(async () => retryButton()?.click());
      expect(state.onAssistantPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Restored exact request' }),
      );
    });

    it('does not retry another job when the recovered job history has not loaded', async () => {
      const state = setup({
        assistantJobPageIds: ['page-1'],
        assistantJobUserMessageIdsByPage: { 'page-1': 'running:user' },
        assistantHistory: {
          pageId: 'page-1',
          loading: true,
          hasOlder: false,
          entries: [{ id: 'older:user', kind: 'message', role: 'user', text: 'Wrong old request' }],
        },
      });
      await stop(state);
      expect(retryButton()?.disabled).toBe(true);
      act(() => retryButton()?.click());
      expect(state.onAssistantPrompt).not.toHaveBeenCalled();
      state.render({
        assistantHistory: {
          pageId: 'page-1',
          loading: false,
          hasOlder: false,
          entries: [
            {
              id: 'loaded:boundary',
              kind: 'new-topic',
              messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
              replacements: {},
            },
            {
              id: 'running:user',
              kind: 'message',
              role: 'user',
              text: 'Late loaded exact request',
            },
          ],
        },
      });
      expect(retryButton()?.disabled).toBe(false);
      await act(async () => retryButton()?.click());
      expect(state.onAssistantPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Late loaded exact request' }),
      );
    });
  });

  it('keeps an ongoing prompt live when cancellation fails', async () => {
    let resolvePrompt!: (response: { message: string }) => void;
    const prompt = new Promise<{ message: string }>((resolve) => {
      resolvePrompt = resolve;
    });
    const onAssistantPrompt = vi.fn(() => prompt);
    const onAssistantCancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
    const renderEditor = (assistantJobActive: boolean) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            assistantJobActive={assistantJobActive}
            document={createEditorDocument()}
            onAssistantCancel={onAssistantCancel}
            onAssistantPrompt={onAssistantPrompt}
          />,
        ),
      );

    renderEditor(false);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-suggestions button')
        ?.click(),
    );
    renderEditor(true);
    const cancel = container.querySelector<HTMLButtonElement>('button[aria-label="取消生成"]');
    expect(cancel?.closest('.reach-deck-editor__assistant-thinking-row')).not.toBeNull();
    await act(async () => {
      cancel?.focus();
      cancel?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('cancel failed');
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      resolvePrompt({ message: 'Generation still completed' });
      await Promise.resolve();
      await Promise.resolve();
    });
    renderEditor(false);
    expect(container.textContent).toContain('Generation still completed');
    expect(
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')?.disabled,
    ).toBe(false);
  });

  it('clears prompt busy state after cancellation succeeds', async () => {
    let rejectPrompt!: (error: Error) => void;
    const prompt = new Promise<{ message: string }>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    const onAssistantPrompt = vi.fn(() => prompt);
    const onAssistantCancel = vi.fn().mockResolvedValue(undefined);
    const renderEditor = (assistantJobActive: boolean) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            assistantJobActive={assistantJobActive}
            document={createEditorDocument()}
            onAssistantCancel={onAssistantCancel}
            onAssistantPrompt={onAssistantPrompt}
          />,
        ),
      );

    renderEditor(false);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('.reach-deck-editor__assistant-suggestions button')
        ?.click(),
    );
    renderEditor(true);
    const cancel = container.querySelector<HTMLButtonElement>('button[aria-label="取消生成"]');
    await act(async () => {
      cancel?.focus();
      cancel?.click();
      await Promise.resolve();
    });
    renderEditor(false);
    expect(
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')?.disabled,
    ).toBe(false);
    expect(document.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt'),
    );

    await act(async () => {
      rejectPrompt(new Error('expected abort'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('expected abort');
  });

  it('locks only the listed pages and keeps the rest editable', () => {
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          lockedPageIds={['page-2']}
          lockedPageReason="第 2 页生成中"
        />,
      ),
    );

    const items = [
      ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li > [data-page-card]'),
    ];
    expect(items).toHaveLength(2);
    expect(items[0]?.dataset.locked).toBeUndefined();
    expect(items[1]?.dataset.locked).toBe('true');
    expect(items[0]?.querySelector('.reach-deck-editor__page-status')).toBeNull();
    expect(items[1]?.querySelector('.reach-deck-editor__page-status')).toBeNull();
    expect(items[0]?.draggable).toBe(true);
    expect(items[1]?.draggable).toBe(false);

    // 查看锁定页仍被允许；只在画布遮罩和缩略图上显示原因，不再额外渲染
    // 顶部蓝色状态条重复占据布局空间。
    act(() => items[1]?.click());
    expect(activePageTitle(container)).toBe('Second page');
    expect(container.querySelector('.reach-deck-editor__generating-overlay')?.textContent).toBe(
      '第 2 页生成中',
    );
    expect(container.querySelector('.reach-deck-editor__status')).toBeNull();

    act(() => items[0]?.click());
    expect(activePageTitle(container)).toBe('First page');
    expect(container.querySelector('.reach-deck-editor__status')).toBeNull();
  });

  it('previews a landed layout without unlocking the page while narration is pending', () => {
    const document = createTwoPageEditorDocument();
    const second = document.pages[1];
    if (second?.sceneType !== 'slide') throw new Error('Expected slide fixture');
    const v2 = normalizeReachDeckDocumentV2(document);
    v2.nativeSlides = [
      v2.nativeSlides[0]!,
      {
        pageId: second.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'narrating-native-slide',
          title: second.title,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
          elements: [
            {
              id: 'narrating-native-shape',
              type: 'shape',
              name: 'Narrating shape',
              transform: { x: 80, y: 80, width: 400, height: 200 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: {
                fill: { kind: 'solid', color: { kind: 'srgb', value: '#2563EB' } },
              },
            },
          ],
          animations: [],
        },
      },
    ];
    act(() =>
      root.render(
        <ReachDeckEditor
          document={v2}
          lockedPageIds={['page-2']}
          lockedPageReasonById={{ 'page-2': '版面已完成 · 讲稿、音频与动画生成中' }}
          previewableLockedPageIds={['page-2']}
        />,
      ),
    );

    const page = container.querySelector<HTMLElement>(
      '.reach-deck-editor__pages li:nth-child(2) > [data-page-card]',
    );
    expect(page?.dataset.locked).toBe('true');
    expect(page?.querySelector('.reach-deck-editor__page-status')).toBeNull();

    act(() => page?.click());
    expect(activePageTitle(container)).toBe('Second page');
    expect(container.querySelector('.reach-deck-editor__generating-overlay')).toBeNull();
    expect(page?.draggable).toBe(false);
    const native = container.querySelector<HTMLElement>('[data-native-v2-readonly]');
    expect(native).not.toBeNull();
    act(() =>
      container
        .querySelector<HTMLElement>('[data-native-v2-element-id="narrating-native-shape"]')
        ?.click(),
    );
    expect(container.querySelector('[data-native-v2-transform-overlay]')).toBeNull();
  });

  it('disables structural page actions when structureLocked', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          onChange={onChange}
          structureLocked
        />,
      ),
    );

    const items = [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')];
    const handles = items.map((item) => item.querySelector<HTMLElement>('[data-page-card]'));
    expect(handles[0]?.draggable).toBe(false);
    expect(handles[1]?.draggable).toBe(false);

    act(() => openPageMenu(container, 'First page'));
    const menu = container.querySelector('.reach-deck-editor__page-menu');
    const menuButton = (label: string) =>
      [...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) =>
        button.textContent?.includes(label),
      );
    expect(menuButton('创建副本')?.disabled).toBe(true);
    expect(menuButton('删除')?.disabled).toBe(true);
    expect(menuButton('新建')).toBeUndefined();
    const insertionButtons = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-insertion-gap]'),
    ];
    expect(insertionButtons.every((button) => button.disabled)).toBe(true);

    // 绕过 draggable 属性直接派发拖拽事件时，commit 防线仍丢弃结构变化。
    act(() => handles[1]?.dispatchEvent(dragEvent('dragstart')));
    act(() => items[0]?.dispatchEvent(dragEvent('dragover')));
    act(() => items[0]?.dispatchEvent(dragEvent('drop')));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops commits that touch locked pages', async () => {
    // Decksmith 确认路径不受页级 UI 门控约束，是绕过交互层直达 commit 的真实通道。
    const baseline = createEditorDocument();
    const response = withFirstPageTitle(baseline, 'AI revised page', 2);
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: response,
      message: '已完成 AI 修改。',
    });
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          lockedPageIds={['page-1']}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      ),
    );

    const suggestion = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '精简当前页文字',
    );
    await act(async () => suggestion?.click());
    const applyButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '应用修改',
    );
    act(() => applyButton?.click());

    expect(onChange).not.toHaveBeenCalled();
    expect(activePageTitle(container)).toBe('First page');
  });

  it('shows reconnecting independently and only cancels through the explicit action', async () => {
    const onAssistantCancel = vi.fn().mockResolvedValue(undefined);
    act(() =>
      root.render(
        <ReachDeckEditor
          assistantConnectionState="reconnecting"
          assistantJobActive
          document={createEditorDocument()}
          onAssistantCancel={onAssistantCancel}
          onAssistantPrompt={vi.fn()}
        />,
      ),
    );

    expect(container.querySelector('[data-decksmith-connection-state]')?.textContent).toContain(
      '连接中断，正在重连',
    );
    const cancelButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="取消生成"]',
    );
    expect(cancelButton?.textContent).toBe('');
    expect(cancelButton?.closest('.reach-deck-editor__assistant-loading-overlay')).not.toBeNull();
    await act(async () => cancelButton?.click());
    expect(onAssistantCancel).toHaveBeenCalledTimes(1);
  });

  it('v2 页时间轴显示 native 动画并写回 nativeSlides', () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    const originalSlide = JSON.parse(
      JSON.stringify(
        document.nativeSlides.find((binding) => binding.pageId === page.pageId)?.slide,
      ),
    );
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'native-shape-1',
              type: 'shape',
              name: 'Rectangle 1',
              transform: { x: 10, y: 20, width: 200, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [
            {
              id: 'anim-1',
              targetId: 'native-shape-1',
              trigger: 'on-enter',
              effect: 'fade',
              start: 1,
              duration: 0.4,
              easing: 'ease-out',
              from: { opacity: 0 },
              to: { opacity: 1 },
            },
          ],
          narration: { segments: [{ text: '讲稿一', start: 0, end: 5 }] },
          duration: 8,
        },
      },
    ];
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));

    // 动画片段（效果标签"淡入"）与讲稿块（讲稿文本"讲稿一"）都应渲染在时间轴上。
    expect(container.querySelector('.reach-deck-timeline__clip.is-animation')).not.toBeNull();
    expect(container.textContent).toContain('淡入');
    const voiceTrack = container.querySelector('.reach-deck-timeline__track.is-voice');
    expect(voiceTrack?.textContent).toContain('讲稿一');

    // 选中动画片段，把类型改成 scale。
    const clipMove = container.querySelector(
      '.reach-deck-timeline__clip-move',
    ) as HTMLButtonElement;
    expect(clipMove).not.toBeNull();
    act(() => clipMove.click());
    // 类型改为平铺磁贴（单选），选中项以 aria-checked 表示。
    const effects = container.querySelector(
      '[role="radiogroup"][aria-labelledby="reach-deck-animation-effect-label"]',
    );
    expect(effects).not.toBeNull();
    const scaleTile = [...effects!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (tile) => tile.textContent === '缩放',
    );
    expect(scaleTile?.getAttribute('aria-checked')).toBe('false');
    act(() => scaleTile?.click());

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    if (next.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
    const updatedAnimation = next.nativeSlides[0]?.slide.animations[0];
    expect(updatedAnimation?.effect).toBe('scale');
    expect(updatedAnimation?.trigger).toBe('on-enter');
    expect(next.nativeSlides[0]?.slide).not.toEqual(originalSlide);
  });

  const animatedDocument = () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'native-shape-1',
              type: 'shape',
              name: 'Rectangle 1',
              transform: { x: 10, y: 20, width: 200, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [
            {
              id: 'anim-1',
              targetId: 'native-shape-1',
              trigger: 'on-enter',
              effect: 'fade',
              start: 1,
              duration: 0.4,
              easing: 'ease-out',
              from: { opacity: 0 },
              to: { opacity: 1 },
            },
          ],
          duration: 8,
        },
      },
    ];
    return { document, page };
  };

  it('更换动画缓动后在画布上自动演示，点击画布即结束演示并保持原选择', () => {
    const { document } = animatedDocument();
    const onChange = vi.fn();
    act(() => root.render(<ReachDeckEditor document={document} onChange={onChange} />));
    act(() =>
      container.querySelector<HTMLButtonElement>('.reach-deck-timeline__clip-move')!.click(),
    );
    const layer = () => container.querySelector('.reach-deck-editor__player-layer')!;
    expect(layer().hasAttribute('data-animation-demo')).toBe(false);
    const easing = container.querySelector(
      '[role="radiogroup"][aria-labelledby="reach-deck-animation-easing-label"]',
    )!;
    const linear = [...easing.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (tile) => tile.textContent === '线性',
    )!;
    act(() => linear.click());
    const next = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    if (next.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
    expect(next.nativeSlides[0]?.slide.animations[0]?.easing).toBe('linear');
    expect(layer().hasAttribute('data-animation-demo')).toBe(true);
    expect(
      container.querySelector('[aria-label="动画片段属性"] [aria-label="停止预览"]'),
    ).not.toBeNull();

    act(() => {
      layer().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(layer().hasAttribute('data-animation-demo')).toBe(false);
    // 点击画布只结束演示，不改选元素：动画属性面板仍在。
    expect(container.querySelector('[aria-label="动画片段属性"]')).not.toBeNull();
  });

  it('版面失败浮层打开统一重新生成弹窗，并预勾选版面、讲稿、音频与动画', () => {
    const onRequestRegenerationPage = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': { phase: 'layout', state: 'failed', message: '幻灯片排版生成失败' },
          }}
          onRegeneratePage={vi.fn()}
          onRequestRegenerationPage={onRequestRegenerationPage}
        />,
      ),
    );
    const overlay = container.querySelector('.reach-deck-editor__generating-overlay[data-failed]')!;
    const button = overlay.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe('重新生成本页…');
    act(() => button.click());
    expect(onRequestRegenerationPage).toHaveBeenCalledWith('page-1', {
      channels: ['layout', 'narration', 'audio', 'animation'],
    });
  });

  it('讲稿失败浮层的重新生成走统一弹窗，只预勾选失败的通道', async () => {
    const onRequestRegenerationPage = vi.fn();
    const onRegeneratePageNarration = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageEditorDocument()}
          generationStatusByPageId={{
            'page-1': {
              phase: 'narration',
              state: 'failed',
              affectedLanes: ['audio', 'animation'],
              message: '音频与动画生成失败',
            },
          }}
          narrationRegeneratablePageIds={['page-1']}
          onRegeneratePageNarration={onRegeneratePageNarration}
          onRequestRegenerationPage={onRequestRegenerationPage}
        />,
      ),
    );
    const actions = container.querySelector('.reach-deck-timeline__generation-actions')!;
    const retry = [...actions.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '重新生成…',
    )!;
    await act(async () => retry.click());
    expect(onRegeneratePageNarration).not.toHaveBeenCalled();
    expect(onRequestRegenerationPage).toHaveBeenCalledWith('page-1', {
      channels: ['audio', 'animation'],
    });
  });

  it('注册的一键删除在一次提交里清空整份课件动画，并可撤销', () => {
    const { document } = animatedDocument();
    const onChange = vi.fn();
    let clear:
      | ((selection: { audio: boolean; animation: boolean }) => {
          changedPageIds: string[];
          skippedPageIds: string[];
        })
      | undefined;
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          onChange={onChange}
          onRegisterMediaClear={(next) => {
            clear = next;
          }}
        />,
      ),
    );
    expect(clear).toBeDefined();
    let result: ReturnType<NonNullable<typeof clear>> | undefined;
    act(() => {
      result = clear!({ audio: false, animation: true });
    });
    expect(result?.changedPageIds).toEqual([document.pages[0]!.pageId]);
    const cleared = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    if (cleared.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2');
    expect(cleared.nativeSlides[0]?.slide.animations).toEqual([]);

    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="撤销课件修改"]')!.click(),
    );
    const restored = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    if (restored.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2');
    expect(restored.nativeSlides[0]?.slide.animations.map((animation) => animation.id)).toEqual([
      'anim-1',
    ]);
  });

  it('suspends Undo during media deletion and acknowledges audio removal before the server prop refresh', () => {
    const { document } = animatedDocument();
    document.nativeSlides[0]!.slide.animations[0]!.id = 'narration-entrance:native-shape-1';
    document.resources.media.push({
      id: 'audio-delete',
      objectKey: 'deck/audio-delete.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:audio-delete',
    });
    document.nativeSlides[0]!.slide.narration = {
      markdown: 'Keep this narration',
      audioResourceId: 'audio-delete',
      segments: [{ text: 'Keep this narration', start: 0, end: 8 }],
    };
    const onChange = vi.fn();
    let clear: import('../src/deckMediaClear.js').ReachDeckMediaClearHandler | undefined;
    const render = (locked: boolean) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            document={document}
            documentHistoryDisabled={locked}
            onChange={onChange}
            onRegisterMediaClear={(next) => {
              clear = next;
            }}
          />,
        ),
      );
    render(true);
    let withoutAnimations: ReachDeckDocument | undefined;
    act(() => {
      withoutAnimations = clear!({ audio: false, animation: true }).document;
    });
    const callsBeforeSave = onChange.mock.calls.length;
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="撤销课件修改"]')!.disabled,
    ).toBe(true);
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
      ),
    );
    expect(onChange).toHaveBeenCalledTimes(callsBeforeSave);
    const saved = structuredClone(withoutAnimations!);
    saved.nativeSlides[0]!.slide.narration = { markdown: 'Keep this narration' };
    delete saved.nativeSlides[0]!.slide.duration;
    act(() => {
      clear!({ audio: false, animation: false }, { savedDocument: saved });
    });
    // The host can close the modal before its updated document prop reaches this editor.
    render(false);
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="撤销课件修改"]')!.click(),
    );
    const undone = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    expect(undone.nativeSlides[0]!.slide.animations.map((animation) => animation.id)).toEqual([
      'narration-entrance:native-shape-1',
    ]);
    expect(undone.nativeSlides[0]!.slide.narration?.audioResourceId).toBeUndefined();
    expect(undone.nativeSlides[0]!.slide.duration).toBe(1.4);
    act(() => root.render(<ReachDeckEditor document={saved} onChange={onChange} />));
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="重做课件修改"]')!.click(),
    );
    const redone = onChange.mock.calls.at(-1)![0] as ReachDeckDocument;
    expect(redone.nativeSlides[0]!.slide.animations).toEqual([]);
    expect(redone.nativeSlides[0]!.slide.narration?.audioResourceId).toBeUndefined();
  });

  it('routes a Teacher Editor timeline scrub through explicit narration seek intent', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.resources.media.push({
      id: 'media-narration',
      objectKey: 'reach-deck/audio/page-1.mp3',
      contentType: 'audio/mpeg',
      digest: 'objectkey:reach-deck/audio/page-1.mp3',
    });
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
          narration: {
            audioResourceId: 'media-narration',
            segments: [{ text: '讲稿一', start: 0, end: 5 }],
          },
          duration: 8,
        },
      },
    ];
    act(() =>
      root.render(
        <ReachDeckEditor
          document={document}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-1.mp3',
          }}
        />,
      ),
    );

    const audio = container.querySelector<HTMLAudioElement>('audio');
    const timeline = container.querySelector<HTMLElement>('.reach-deck-timeline__canvas');
    if (audio === null || timeline === null) throw new Error('Expected narration timeline');
    let mediaTime = 0;
    const seek = vi.fn((time: number) => {
      mediaTime = time;
    });
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => mediaTime,
      set: seek,
    });
    Object.defineProperty(timeline, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0 }),
    });

    act(() =>
      timeline.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 168 }),
      ),
    );

    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek.mock.calls[0]?.[0]).toBeCloseTo(2.33, 2);
  });

  it('无 native 绑定的页不渲染时间轴', () => {
    const placeholder = createEditorDocument();
    const page = placeholder.pages[0];
    if (page?.sceneType !== 'slide') throw new Error('Expected slide fixture');
    const binding = placeholder.nativeSlides.find((candidate) => candidate.pageId === page.pageId);
    if (binding === undefined) throw new Error('Expected native slide binding');
    binding.slide.id = 'generation-placeholder:page-1';
    placeholder.nativeSlides = [];
    expect(() => act(() => root.render(<ReachDeckEditor document={placeholder} />))).toThrow(
      'must have exactly one native binding',
    );
  });

  it('v2 时间轴文案遵循 translate 覆盖（讲稿轴与动画效果标签）', () => {
    const english = (key: string) =>
      ({
        'reachDeck.editor.timeline.label': 'Timeline',
        'reachDeck.editor.timeline.narration': 'Narration',
        'reachDeck.editor.timeline.animationEffect.fade': 'Fade',
      })[key] ?? key;

    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = document.pages[0]!;
    document.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'native-shape-1',
              type: 'shape',
              name: 'Rectangle 1',
              transform: { x: 10, y: 20, width: 200, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rect' },
              style: { fill: { kind: 'none' } },
            },
          ],
          animations: [
            {
              id: 'anim-1',
              targetId: 'native-shape-1',
              trigger: 'on-enter',
              effect: 'fade',
              start: 1,
              duration: 0.4,
              easing: 'ease-out',
              from: { opacity: 0 },
              to: { opacity: 1 },
            },
          ],
          narration: { segments: [{ text: '讲稿一', start: 0, end: 5 }] },
          duration: 8,
        },
      },
    ];

    act(() => root.render(<ReachDeckEditor document={document} translate={english} />));

    expect(container.querySelector('[aria-label="Timeline"]')).not.toBeNull();
    const labels = container.querySelector('.reach-deck-timeline__labels');
    expect(labels?.textContent).toContain('Narration');
    expect(container.textContent).toContain('Fade');
  });

  it('uses one Interactive narration draft for the panel and fixed status track', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createInteractiveNarrationEditorDocument()}
          nativeResourceUrlsById={{
            'interactive-audio': 'https://signed.example/interactive.mp3',
          }}
          onSaveInteractivePageNarrationAndGenerate={onSave}
        />,
      ),
    );

    const track = container.querySelector<HTMLElement>(
      '.reach-deck-editor__interactive-narration-track',
    );
    expect(track?.getAttribute('data-state')).toBe('ready');
    expect(container.querySelector('.reach-deck-timeline')).toBeNull();
    expect(container.querySelector('.reach-deck-player__interactive-narration')).toBeNull();

    const narrationTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === '讲稿',
    );
    if (narrationTab === undefined) throw new Error('Expected narration tab');
    act(() => narrationTab.click());
    expect(await interactiveNarrationEditorText(container)).toBe('拖动滑块并观察结果。');
    const panel = container.querySelector('#reach-deck-right-panel-narration');
    // 面板与幻灯片讲稿一致：语音标记工具栏、试听入口所在页脚、容量按 600 字符计。
    expect(panel?.querySelector('[role="switch"][aria-label="显示语音标记"]')).not.toBeNull();
    expect(panel?.querySelector('footer')?.textContent).toContain('10 / 600 字符');
    expect(panel?.querySelector('textarea')).toBeNull();

    await replaceInteractiveNarrationText(container, '  先拖动  滑块，再比较结果。  ');
    expect(track?.getAttribute('data-state')).toBe('dirty');
    // 状态条与面板共享同一份草稿：状态条的保存按钮保存的就是面板当前内容（空白已规范化）。
    const trackSave = track?.querySelector<HTMLButtonElement>('[aria-label="保存并生成音频"]');
    expect(trackSave?.disabled).toBe(false);
    const save = panel?.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]');
    await act(async () => save?.click());
    expect(onSave).toHaveBeenCalledWith({
      pageId: 'interactive-page',
      text: '先拖动 滑块，再比较结果。',
    });
  });

  it('saves the panel draft from the status track and carries saved speech markup', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const onSave = vi.fn().mockResolvedValue(undefined);
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 4, durationMs: 300 }],
    };
    const base = createInteractiveNarrationEditorDocument();
    if (base.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
    const withMarkup = normalizeReachDeckDocumentV2({
      ...base,
      pages: base.pages.map((page) =>
        page.sceneType === 'interactive'
          ? {
              ...page,
              scene: { ...page.scene, narration: { ...page.scene.narration!, speechMarkup } },
            }
          : page,
      ),
    });
    act(() =>
      root.render(
        <ReachDeckEditor
          document={withMarkup}
          generationStatusByPageId={{
            'interactive-page': { message: '音频生成失败', phase: 'narration', state: 'failed' },
          }}
          onSaveInteractivePageNarrationAndGenerate={onSave}
        />,
      ),
    );
    await act(async () => Promise.resolve());
    const track = container.querySelector('.reach-deck-editor__interactive-narration-track');
    expect(track?.getAttribute('data-state')).toBe('failed');
    // 讲稿页签未打开：状态条重试原样提交已保存的文本与语音标记。
    await act(async () =>
      track?.querySelector<HTMLButtonElement>('[aria-label="重试生成音频"]')?.click(),
    );
    expect(onSave).toHaveBeenLastCalledWith({
      pageId: 'interactive-page',
      text: '拖动滑块并观察结果。',
      speechMarkup,
    });

    await replaceInteractiveNarrationText(container, '拖动滑块后比较结果。');
    expect(track?.getAttribute('data-state')).toBe('dirty');
    await act(async () =>
      track?.querySelector<HTMLButtonElement>('[aria-label="保存并生成音频"]')?.click(),
    );
    expect(onSave).toHaveBeenLastCalledWith({
      pageId: 'interactive-page',
      text: '拖动滑块后比较结果。',
    });
  });

  it('rebases a saved Interactive narration draft when authoritative text changes', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const onSave = vi.fn().mockResolvedValue(undefined);
    const renderEditor = (document: ReachDeckDocument) =>
      root.render(
        <ReachDeckEditor
          document={document}
          nativeResourceUrlsById={{
            'interactive-audio': 'https://signed.example/interactive.mp3',
          }}
          onSaveInteractivePageNarrationAndGenerate={onSave}
        />,
      );

    act(() => renderEditor(createInteractiveNarrationEditorDocument()));
    const narrationTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === '讲稿',
    );
    if (narrationTab === undefined) throw new Error('Expected narration tab');
    act(() => narrationTab.click());
    await replaceInteractiveNarrationText(container, '先拖动滑块，再比较结果。');
    const panel = container.querySelector('#reach-deck-right-panel-narration');
    const save = panel?.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]');
    await act(async () => save?.click());

    const saved = withInteractiveNarrationText(
      createInteractiveNarrationEditorDocument(),
      'interactive-page',
      '先拖动滑块，再比较结果。',
    );
    act(() => renderEditor(saved));
    expect(await interactiveNarrationEditorText(container)).toBe('先拖动滑块，再比较结果。');

    const regenerated = withInteractiveNarrationText(
      saved,
      'interactive-page',
      '调整两个参数，比较它们对结果的影响。',
    );
    act(() => renderEditor(regenerated));

    expect(await interactiveNarrationEditorText(container)).toBe(
      '调整两个参数，比较它们对结果的影响。',
    );
    expect(
      container
        .querySelector('.reach-deck-editor__interactive-narration-track')
        ?.getAttribute('data-state'),
    ).toBe('ready');
  });

  it('does not let a late Interactive narration save mask newer authoritative text', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const initial = createInteractiveNarrationEditorDocument();
    const renderEditor = (document: ReachDeckDocument) =>
      root.render(
        <ReachDeckEditor document={document} onSaveInteractivePageNarrationAndGenerate={onSave} />,
      );

    act(() => renderEditor(initial));
    const narrationTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === '讲稿',
    );
    if (narrationTab === undefined) throw new Error('Expected narration tab');
    act(() => narrationTab.click());
    await replaceInteractiveNarrationText(container, '正在保存的旧草稿。');
    const save = container
      .querySelector('#reach-deck-right-panel-narration')
      ?.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]');
    act(() => save?.click());

    const regenerated = withInteractiveNarrationText(
      initial,
      'interactive-page',
      '整页重新生成后的权威讲稿。',
    );
    act(() => renderEditor(regenerated));
    expect(await interactiveNarrationEditorText(container)).toBe('正在保存的旧草稿。');

    await act(async () => resolveSave());

    expect(await interactiveNarrationEditorText(container)).toBe('整页重新生成后的权威讲稿。');
    expect(
      container
        .querySelector('.reach-deck-editor__interactive-narration-track')
        ?.getAttribute('data-state'),
    ).toBe('ready');
  });

  it('rebases a failed-track retry with no textarea edit before a late save completes', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const initial = createInteractiveNarrationEditorDocument();
    const renderEditor = (document: ReachDeckDocument) =>
      root.render(
        <ReachDeckEditor
          document={document}
          generationStatusByPageId={{
            'interactive-page': {
              message: '音频生成失败',
              phase: 'narration',
              state: 'failed',
            },
          }}
          onSaveInteractivePageNarrationAndGenerate={onSave}
        />,
      );

    act(() => renderEditor(initial));
    expect(await interactiveNarrationEditorText(container)).toBe('拖动滑块并观察结果。');
    const retry = container
      .querySelector('.reach-deck-editor__interactive-narration-track')
      ?.querySelector<HTMLButtonElement>('[aria-label="重试生成音频"]');
    act(() => retry?.click());
    expect(onSave).toHaveBeenCalledWith({
      pageId: 'interactive-page',
      text: '拖动滑块并观察结果。',
    });

    const regenerated = withInteractiveNarrationText(
      initial,
      'interactive-page',
      '权威来源在重试期间更新的讲稿。',
    );
    act(() => renderEditor(regenerated));
    await act(async () => resolveSave());

    expect(
      container
        .querySelector('.reach-deck-editor__interactive-narration-track')
        ?.getAttribute('data-state'),
    ).toBe('failed');
    const narrationTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === '讲稿',
    );
    if (narrationTab === undefined) throw new Error('Expected narration tab');
    act(() => narrationTab.click());
    expect(await interactiveNarrationEditorText(container)).toBe('权威来源在重试期间更新的讲稿。');
  });

  it.each([
    {
      name: 'ReachDeckUserFacingError',
      label: '宿主已本地化的产品错误',
      message: '该页正在生成中，请稍后再试。',
      expected: '该页正在生成中，请稍后再试。',
    },
    {
      name: 'TypeError',
      label: '内部异常',
      message: 'cannot read properties of undefined',
      expected: '保存互动讲稿并生成音频失败，讲稿仍保留在编辑器中，请重试。',
    },
  ])(
    'surfaces $label when the Interactive narration save rejects',
    async ({ name, message, expected }) => {
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
      const cause = new Error(message);
      cause.name = name;
      const onSave = vi.fn(() => Promise.reject(cause));
      const initial = createInteractiveNarrationEditorDocument();

      act(() =>
        root.render(
          <ReachDeckEditor document={initial} onSaveInteractivePageNarrationAndGenerate={onSave} />,
        ),
      );
      const narrationTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (tab) => tab.textContent === '讲稿',
      );
      if (narrationTab === undefined) throw new Error('Expected narration tab');
      act(() => narrationTab.click());
      await replaceInteractiveNarrationText(container, '换一段讲稿再生成音频。');
      const save = container
        .querySelector('#reach-deck-right-panel-narration')
        ?.querySelector<HTMLButtonElement>('[aria-label="保存讲稿并生成音频"]');
      await act(async () => {
        save?.click();
        await Promise.resolve();
      });

      expect(onSave).toHaveBeenCalledOnce();
      // 保存失败后讲稿仍保留在编辑器中，状态条投影为失败并提供重试。
      expect(await interactiveNarrationEditorText(container)).toBe('换一段讲稿再生成音频。');
      expect(
        container
          .querySelector('.reach-deck-editor__interactive-narration-track')
          ?.getAttribute('data-state'),
      ).toBe('failed');
      expect(
        [
          ...container
            .querySelector('#reach-deck-right-panel-narration')!
            .querySelectorAll('[role="alert"]'),
        ].map((alert) => alert.textContent),
      ).toContain(expected);
    },
  );

  it('keeps a genuinely dirty Interactive narration draft across authority updates and pages', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const initial = createTwoPageInteractiveNarrationEditorDocument();
    act(() => root.render(<ReachDeckEditor document={initial} />));
    const narrationTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === '讲稿',
    );
    if (narrationTab === undefined) throw new Error('Expected narration tab');
    act(() => narrationTab.click());
    await replaceInteractiveNarrationText(container, '我的未保存探索提示。');

    const externallyUpdated = withInteractiveNarrationText(
      initial,
      'interactive-page',
      'Decksmith 生成的新讲稿。',
    );
    act(() => root.render(<ReachDeckEditor document={externallyUpdated} />));
    expect(await interactiveNarrationEditorText(container)).toBe('我的未保存探索提示。');

    const pageButton = (title: string) =>
      [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')]
        .find((item) => item.textContent?.includes(title))
        ?.querySelector<HTMLElement>('[data-page-card]');
    act(() => pageButton('第二个互动探索')?.click());
    expect(await interactiveNarrationEditorText(container)).toBe('先选择一个选项，再观察反馈。');
    act(() => pageButton('互动探索')?.click());
    expect(await interactiveNarrationEditorText(container)).toBe('我的未保存探索提示。');
    expect(
      container
        .querySelector('.reach-deck-editor__interactive-narration-track')
        ?.getAttribute('data-state'),
    ).toBe('dirty');
  });

  it('resolves an unsaved narration draft explicitly when an adopted AI change rewrites it (WP8 S8)', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const initial = createTwoPageInteractiveNarrationEditorDocument();
    const candidate = withInteractiveNarrationText(
      initial,
      'interactive-page',
      'Decksmith 改写的讲稿。',
    );
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: candidate,
      message: '已改写讲稿。',
      runtimeApprovalId: 'runtime-approval-narration',
    });
    const onAssistantDecision = vi.fn();
    const render = (document: ReachDeckDocument) =>
      act(() =>
        root.render(
          <ReachDeckEditor
            document={document}
            onAssistantDecision={onAssistantDecision}
            onAssistantPrompt={onAssistantPrompt}
            onChange={vi.fn()}
          />,
        ),
      );
    const tab = (label: string) =>
      act(() =>
        [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find((candidateTab) => candidateTab.textContent?.trim() === label)!
          .click(),
      );
    const prompt = async () => {
      tab('Decksmith');
      const composer = container.querySelector<HTMLTextAreaElement>(
        '#reach-deck-assistant-prompt',
      )!;
      act(() => {
        setNativeValue(composer, '改写本页讲稿');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () =>
        composer.form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(),
      );
    };
    const confirmButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === label,
      );

    render(initial);
    tab('讲稿');
    await replaceInteractiveNarrationText(container, '我的未保存探索提示。');

    // 拒绝提案：不清除教师未保存的讲稿。
    await prompt();
    await act(async () => confirmButton('放弃修改')?.click());
    expect(onAssistantDecision).toHaveBeenLastCalledWith({
      runtimeApprovalId: 'runtime-approval-narration',
      decision: 'rejected',
    });
    tab('讲稿');
    expect(await interactiveNarrationEditorText(container)).toBe('我的未保存探索提示。');
    expect(container.querySelector('[data-narration-replaced]')).toBeNull();

    // 采用改写讲稿的提案：显式替换，并给出撤销。
    await prompt();
    await act(async () => confirmButton('应用修改')?.click());
    tab('讲稿');
    expect(await interactiveNarrationEditorText(container)).toBe('Decksmith 改写的讲稿。');
    const notice = container.querySelector('[data-narration-replaced]');
    expect(notice?.textContent).toContain('AI 讲稿已替换你未保存的讲稿。');
    // 宿主随后把已采用的文档回写（服务端回填）：不会把旧草稿翻回来。
    render(candidate);
    expect(await interactiveNarrationEditorText(container)).toBe('Decksmith 改写的讲稿。');

    await act(async () => confirmButton('恢复我的讲稿')?.click());
    expect(await interactiveNarrationEditorText(container)).toBe('我的未保存探索提示。');
    expect(container.querySelector('[data-narration-replaced]')).toBeNull();
    expect(
      container
        .querySelector('.reach-deck-editor__interactive-narration-track')
        ?.getAttribute('data-state'),
    ).toBe('dirty');
  });

  it('isolates Interactive narration confirmations and errors when changing pages', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const rewrite = vi.fn().mockRejectedValue(new Error('rewrite unavailable'));
    act(() =>
      root.render(
        <ReachDeckEditor
          document={createTwoPageInteractiveNarrationEditorDocument()}
          onRegeneratePageNarration={rewrite}
        />,
      ),
    );
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((tab) => tab.textContent === '讲稿')!
        .click(),
    );
    const pageButton = (title: string) =>
      [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li')]
        .find((item) => item.textContent?.includes(title))
        ?.querySelector<HTMLElement>('[data-page-card]');
    const fullRewrite = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="重新生成本页讲稿和音频"]')!;
    act(() => fullRewrite().click());
    expect(document.body.textContent).toContain('覆盖现有讲稿和音频');
    act(() => pageButton('第二个互动探索')?.click());
    expect(document.body.textContent).not.toContain('覆盖现有讲稿和音频');
    expect(rewrite).not.toHaveBeenCalled();
    act(() => fullRewrite().click());
    await act(async () => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === '继续')!
        .click();
    });
    expect(container.textContent).toContain('AI 重新生成讲稿失败');
    act(() => pageButton('互动探索')?.click());
    expect(container.textContent).not.toContain('AI 重新生成讲稿失败');
  });

  it('projects real Interactive narration queue state without rendering an empty track', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const queued = createInteractiveNarrationEditorDocument(false);
    act(() =>
      root.render(
        <ReachDeckEditor
          document={queued}
          generationStatusByPageId={{
            'interactive-page': {
              activity: 'queued',
              phase: 'narration',
              state: 'loading',
            },
          }}
        />,
      ),
    );
    expect(
      container
        .querySelector('.reach-deck-editor__interactive-narration-track')
        ?.getAttribute('data-state'),
    ).toBe('queued');
    expect(container.textContent).toContain('音频排队中');

    act(() => root.render(<ReachDeckEditor document={createBlankInteractiveEditorDocument()} />));
    expect(container.querySelector('.reach-deck-editor__interactive-narration-track')).toBeNull();
  });
});

function createInteractiveNarrationEditorDocument(withAudio = true): ReachDeckDocument {
  const base = normalizeReachDeckDocumentV2(createEditorDocument());
  return normalizeReachDeckDocumentV2({
    ...base,
    pages: [
      {
        pageId: 'interactive-page',
        order: 1,
        revision: 2,
        sceneType: 'interactive',
        title: '互动探索',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: 'interactive-page',
          title: '互动探索',
          sceneType: 'interactive',
          documentHtml: '<!doctype html><html><head></head><body>Explore</body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: {
            completionMode: 'explicit',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: {
            schemaVersion: 'reach-interactive-event-manifest/v1',
            events: [],
          },
          runtimeDependencies: [],
          narration: {
            schemaVersion: 'reach-interactive-narration/v1',
            text: '拖动滑块并观察结果。',
            ...(withAudio ? { audioResourceId: 'interactive-audio' } : {}),
          },
        },
      },
    ],
    nativeSlides: [],
    resources: {
      ...base.resources,
      media: withAudio
        ? [
            {
              id: 'interactive-audio',
              objectKey: 'reach-deck/audio/interactive.mp3',
              contentType: 'audio/mpeg',
              digest: 'objectkey:reach-deck/audio/interactive.mp3',
            },
          ]
        : [],
    },
  });
}

function createBlankInteractiveEditorDocument(): ReachDeckDocument {
  const added = addReachDeckPage(createEditorDocument(), {
    afterPageId: 'page-1',
    sceneType: 'interactive',
    idFactory: (prefix) => `${prefix}-blank-narration`,
  });
  return deleteReachDeckPage(added, 'page-1');
}

function withInteractiveNarrationText(
  document: ReachDeckDocument,
  pageId: string,
  text: string,
): ReachDeckDocument {
  if (document.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return normalizeReachDeckDocumentV2({
    ...document,
    pages: document.pages.map((page) =>
      page.pageId === pageId && page.sceneType === 'interactive'
        ? {
            ...page,
            revision: page.revision + 1,
            scene: {
              ...page.scene,
              narration: {
                ...page.scene.narration,
                schemaVersion: 'reach-interactive-narration/v1' as const,
                text,
              },
            },
          }
        : page,
    ),
  });
}

function createTwoPageInteractiveNarrationEditorDocument(): ReachDeckDocument {
  const first = createInteractiveNarrationEditorDocument();
  if (first.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  const firstPage = first.pages[0];
  if (firstPage?.sceneType !== 'interactive') throw new Error('Expected Interactive page');
  return normalizeReachDeckDocumentV2({
    ...first,
    pages: [
      firstPage,
      {
        ...structuredClone(firstPage),
        pageId: 'interactive-page-2',
        order: 2,
        title: '第二个互动探索',
        scene: {
          ...structuredClone(firstPage.scene),
          id: 'interactive-page-2',
          title: '第二个互动探索',
          narration: {
            schemaVersion: 'reach-interactive-narration/v1',
            text: '先选择一个选项，再观察反馈。',
          },
        },
      },
    ],
  });
}

function interactiveNarrationEditorSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector<HTMLElement>(
    '#reach-deck-right-panel-narration .ProseMirror',
  );
  if (surface === null) throw new Error('Expected Interactive narration rich-text editor.');
  return surface;
}

async function interactiveNarrationEditorText(container: HTMLElement): Promise<string> {
  await act(async () => Promise.resolve());
  return interactiveNarrationEditorSurface(container).textContent ?? '';
}

async function replaceInteractiveNarrationText(
  container: HTMLElement,
  text: string,
): Promise<void> {
  await act(async () => Promise.resolve());
  const surface = interactiveNarrationEditorSurface(container);
  const paragraph = surface.querySelector('p');
  if (paragraph === null) throw new Error('Expected Interactive narration paragraph.');
  await act(async () => {
    paragraph.textContent = text;
    surface.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function replaceInlineEditorText(
  container: HTMLElement,
  text: string,
  preserveInlineMarkup = false,
): Promise<void> {
  await act(async () => Promise.resolve());
  const surface = container.querySelector<HTMLElement>('[data-rich-text-inline] .ProseMirror');
  if (surface === null) throw new Error('Expected inline ProseMirror editor.');
  const paragraph = surface.querySelector('p');
  if (paragraph === null) throw new Error('Expected inline ProseMirror paragraph.');
  await act(async () => {
    if (preserveInlineMarkup) {
      const textNode = paragraph.querySelector('span')?.firstChild;
      if (!(textNode instanceof Text)) throw new Error('Expected styled ProseMirror text node.');
      textNode.data = text;
    } else {
      paragraph.textContent = text;
    }
    surface.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
    );
    await Promise.resolve();
  });
}

async function commitInlineEditorText(container: HTMLElement): Promise<void> {
  const surface = container.querySelector<HTMLElement>('[data-rich-text-inline] .ProseMirror');
  if (surface === null) throw new Error('Expected inline ProseMirror editor.');
  await act(async () => {
    surface.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'Enter',
      }),
    );
    await Promise.resolve();
  });
}

function nativeTextElement(
  document: ReachDeckDocument,
  elementId: string,
): Extract<ReachDeckNativeElementV2, { type: 'shape' | 'textFrame' }> & {
  text: ReachDeckTextFrameV2;
} {
  const element = document.nativeSlides[0]?.slide.elements.find(
    (candidate) => candidate.id === elementId,
  );
  if (
    element === undefined ||
    (element.type !== 'shape' && element.type !== 'textFrame') ||
    element.text === undefined
  ) {
    throw new Error(`Expected native text element ${elementId}`);
  }
  return element as Extract<ReachDeckNativeElementV2, { type: 'shape' | 'textFrame' }> & {
    text: ReachDeckTextFrameV2;
  };
}

function dispatchTestClipboardEvent(
  type: 'copy' | 'cut' | 'paste',
  initialValues: Readonly<Record<string, string>> = {},
  files: readonly File[] = [],
  target: EventTarget = window,
  failingSetDataTypes: readonly string[] = [],
  ignoredSetDataTypes: readonly string[] = [],
) {
  const values = new Map(Object.entries(initialValues));
  const types = [...values.keys(), ...new Set(files.map((file) => file.type))];
  const clipboardData = {
    files,
    getData: vi.fn((mime: string) => values.get(mime) ?? ''),
    items: files.map((file) => ({
      getAsFile: () => file,
      kind: 'file',
      type: file.type,
    })),
    setData: vi.fn((mime: string, value: string) => {
      if (failingSetDataTypes.includes(mime)) throw new Error(`Cannot write ${mime}`);
      if (ignoredSetDataTypes.includes(mime)) return;
      values.set(mime, value);
      if (!types.includes(mime)) types.push(mime);
    }),
    types,
  } as unknown as DataTransfer;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
  act(() => target.dispatchEvent(event));
  return { clipboardData, event, values };
}

/** 最小 Word 剪贴板样本：Office 签名 + OMML 公式 + 表格 + 带 alt 的图片。 */
const OFFICE_CLIPBOARD_HTML = `
  <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
    <meta name=Generator content="Microsoft Word 15">
    <body>
      <p class=MsoNormal>面积 <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath> 完</p>
      <table class=MsoTableGrid>
        <tr><td><p class=MsoNormal>A1</p></td><td><p class=MsoNormal>B1</p></td></tr>
        <tr><td><p class=MsoNormal>A2</p></td><td><p class=MsoNormal>B2</p></td></tr>
      </table>
      <p class=MsoNormal><img src="file:///C:/Users/teacher/diagram.png" alt="示意图"></p>
      <p class=MsoNormal><span data-type="inline-math" data-latex="\\forged" data-font-size="999999px" data-font-family="Forged">伪造公式</span></p>
    </body>
  </html>`;

const nativeElementSelector = (elementId: string) =>
  `[data-native-v2-editable] [data-native-v2-element-id="${elementId}"]`;

const nativeOverlaySelector = (elementId: string) =>
  `[data-native-v2-transform-overlay="${elementId}"]`;

function createTwoPageEditorDocument(): ReachDeckDocument {
  const document = createEditorDocument();
  const first = document.pages[0];
  if (first.sceneType !== 'slide') throw new Error('Expected slide fixture');
  const firstBinding = document.nativeSlides[0];
  if (firstBinding === undefined) throw new Error('Expected native slide fixture');
  return {
    ...document,
    pages: [
      first,
      {
        ...structuredClone(first),
        pageId: 'page-2',
        order: 2,
        title: 'Second page',
      },
    ],
    nativeSlides: [
      firstBinding,
      {
        pageId: 'page-2',
        slide: {
          ...structuredClone(firstBinding.slide),
          id: 'native-slide-2',
          title: 'Second page',
          elements: firstBinding.slide.elements.map((element) => ({
            ...structuredClone(element),
            id: `${element.id}-second`,
          })),
        },
      },
    ],
  };
}

function withFirstPageTitle(
  document: ReachDeckDocument,
  title: string,
  revision: number,
): ReachDeckDocument {
  const page = document.pages[0];
  if (page.sceneType !== 'slide') throw new Error('Expected slide fixture');
  return {
    ...document,
    pages: [
      {
        ...page,
        revision,
        title,
      },
    ],
    nativeSlides: document.nativeSlides.map((binding) =>
      binding.pageId === page.pageId ? { ...binding, slide: { ...binding.slide, title } } : binding,
    ),
  };
}

function withCandidateImage(
  document: ReachDeckDocument,
  resourceId: string,
  objectKey: string,
  alt: string,
): ReachDeckDocument {
  return {
    ...document,
    resources: {
      ...document.resources,
      media: [
        ...document.resources.media.filter((resource) => resource.id !== resourceId),
        {
          id: resourceId,
          objectKey,
          contentType: 'image/png',
          digest: `objectkey:${objectKey}`,
        },
      ],
    },
    nativeSlides: document.nativeSlides.map((binding) => ({
      ...binding,
      slide: {
        ...binding.slide,
        elements: [
          ...binding.slide.elements,
          {
            id: `candidate-image-${resourceId}`,
            type: 'image',
            resourceId,
            fit: 'contain',
            alt,
            transform: { x: 200, y: 220, width: 800, height: 450 },
            zIndex: 2,
          },
        ],
      },
    })),
  };
}

/** jsdom 没有 DragEvent 构造器；React 的合成拖拽事件需要 dataTransfer 才会分发。 */
function dragEvent(type: 'dragstart' | 'dragover' | 'drop'): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { dropEffect: 'move', effectAllowed: 'move', setData: () => {}, getData: () => '' },
  });
  return event;
}

/** 在新建幻灯片二级面板里按类型标签选择。 */
function pickNewSceneType(container: HTMLElement, label: string): void {
  const panel = container.querySelector('[aria-label="选择新建幻灯片类型"]');
  if (panel === null) throw new Error('new page panel not found');
  const option = [...panel.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  );
  if (option === undefined) throw new Error(`scene type option not found: ${label}`);
  option.click();
}

/** 在幻灯片条目上右键，打开操作菜单。 */
function openPageMenu(container: HTMLElement, pageTitle: string): void {
  const item = [
    ...container.querySelectorAll<HTMLElement>('.reach-deck-editor__pages li > [data-page-card]'),
  ].find((page) => page.textContent?.includes(pageTitle));
  if (item === undefined) throw new Error(`page item not found: ${pageTitle}`);
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

// jsdom does not perform layout; model the measured menu boxes as content expands.
function mockPageMenuLayout(): void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches('.reach-deck-editor__page-menu')) {
      const expandedBelow =
        this.dataset.submenuSide === 'below' &&
        this.querySelector('.reach-deck-editor__page-submenu') !== null;
      return new DOMRect(
        Number.parseFloat(this.style.left) || 0,
        Number.parseFloat(this.style.top) || 0,
        208,
        expandedBelow ? 184 : 74,
      );
    }
    if (this.matches('.reach-deck-editor__page-submenu')) {
      const menu = this.closest<HTMLElement>('.reach-deck-editor__page-menu')!;
      const bounds = menu.getBoundingClientRect();
      const below = menu.dataset.submenuSide === 'below';
      const left = menu.dataset.submenuSide === 'left' ? bounds.left - 180 : bounds.right + 4;
      return new DOMRect(below ? bounds.left + 5 : left, bounds.top + (below ? 39 : 1), 176, 108);
    }
    return original.call(this);
  });
}

/** 插入间隙自身是 44px 有效目标的键盘按钮，点击后打开位置菜单。 */
function openInsertionMenu(container: HTMLElement, label: string): void {
  const trigger = container.querySelector<HTMLButtonElement>(
    `[data-insertion-gap][aria-label="${label}"]`,
  );
  if (trigger === null) throw new Error(`insertion trigger not found: ${label}`);
  trigger.click();
}

function clickMenuItem(container: HTMLElement, label: string): void {
  const menu = container.querySelector('.reach-deck-editor__page-menu');
  if (menu === null) throw new Error('page menu not open');
  const item = [...menu.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  );
  if (item === undefined) throw new Error(`menu item not found: ${label}`);
  item.click();
}

function activePageTitle(container: HTMLElement): string | undefined {
  return container
    .querySelector('[aria-current="page"] .reach-deck-editor__page-copy .sr-only')
    ?.textContent?.trim();
}

function sharedSelectTrigger(container: HTMLElement, label: string): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${label}"]`,
  );
  if (trigger === null) throw new Error(`shared select trigger not found: ${label}`);
  return trigger;
}

function sharedSelectValue(container: HTMLElement, label: string): string {
  return sharedSelectTrigger(container, label).textContent?.trim() ?? '';
}

function sharedSelectOptions(container: HTMLElement, label: string): string[] {
  const trigger = sharedSelectTrigger(container, label);
  act(() => trigger.click());
  const options = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]:not([data-page-card])'),
  ].map((option) => option.textContent?.trim() ?? '');
  act(() => trigger.click());
  return options;
}

function chooseSharedSelectOption(container: HTMLElement, label: string, value: string): void {
  const trigger = sharedSelectTrigger(container, label);
  act(() => trigger.click());
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]:not([data-page-card])'),
  ].find((candidate) => candidate.textContent?.trim() === value);
  if (option === undefined) throw new Error(`shared select option not found: ${label}=${value}`);
  act(() => option.click());
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter === undefined) throw new Error('native value setter not found');
  setter.call(element, value);
}
