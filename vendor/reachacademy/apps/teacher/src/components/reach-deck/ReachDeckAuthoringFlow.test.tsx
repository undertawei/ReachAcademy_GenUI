// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  parsePageOutlineValue,
  richTextToPlainText,
  type LessonPlan,
  type PageOutline,
  type ReachDeckDocument,
  type RichTextDocument,
} from '@reachany/reach-deck-dsl';
import type { ReachDeckWorkspaceBatchView } from '@reachany/reach-deck-client';
import type { ReachDeckGenerationPanelProps } from '@reachany/reach-deck-editor';
import { renderMathToString } from '@reachany/tiptap-mathlive/static';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';

import {
  outlineSummaryFromRichText,
  outlineSummaryToRichText,
  ReachDeckAuthoringFlow,
} from './ReachDeckAuthoringFlow.js';
import styles from './ReachDeckAuthoringFlow.module.css';
import { pageReferenceErrors } from './ReachDeckTeachingSemantics.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@reachany/reach-deck-editor', () => ({
  ReachDeckArtifactPreview: ({ artifact }: { artifact: { status: string } }) => (
    <div data-artifact-preview={artifact.status} />
  ),
}));

const WORD_TABLE = [
  '<html xmlns:o="urn:schemas-microsoft-com:office:office">',
  '<meta name="Generator" content="Microsoft Word 16"><body>',
  '<table class="MsoTableGrid">',
  '<tr><th><p class="MsoNormal">步骤</p></th><th><p class="MsoNormal">说明</p></th></tr>',
  '<tr><td><p class="MsoNormal">1</p></td><td><p class="MsoNormal">检查</p></td></tr>',
  '</table></body></html>',
].join('');

describe('ReachDeckAuthoringFlow active jobs', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    });
    host = window.document.createElement('div');
    window.document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  /** 打开 studio 命令栏的“整份课件操作”菜单；菜单经共享 Popover 渲染在 body 下的 portal 根节点。 */
  async function openDeckMenu(label = '整份课件操作'): Promise<HTMLElement> {
    const trigger = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"][aria-haspopup]`,
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    const menu = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
    expect(menu).not.toBeNull();
    return menu!;
  }

  it.each(['zh-CN', 'en-US'] as const)(
    'orders the toolbar and supports inline module renaming (%s)',
    async (locale) => {
      const zh = locale === 'zh-CN';
      const onRenameModule = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(zh ? '重命名失败，请重试。' : 'Could not rename this item. Please try again.'),
        )
        .mockResolvedValue(undefined);
      const onRequestRegeneration = vi.fn();
      const onRequestMediaDeletion = vi.fn();
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = { ...readyPageWorkspace(), stage: 'complete' };
      panelProps.jobs = [];
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              backHref="/teacher/courses/course-1"
              documentActions={{
                disabled: false,
                onPublish: vi.fn(),
                onSave: vi.fn(),
                onTrial: vi.fn(),
              }}
              editor={<div data-studio-editor />}
              materialized
              moduleTitle="Module A"
              onRenameModule={onRenameModule}
              onRequestMediaDeletion={onRequestMediaDeletion}
              onRequestRegeneration={onRequestRegeneration}
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      const toolbar = host.querySelector('[data-workbench-toolbar]');
      expect(
        [...toolbar!.querySelectorAll('a, button')].map(
          (element) => element.getAttribute('aria-label') ?? element.textContent?.trim(),
        ),
      ).toEqual(
        zh
          ? [
              '返回课程',
              '重命名“Module A”',
              'Reach Deck 生成阶段',
              '一键生成',
              '生成任务状态',
              '一键删除',
              '试学',
              '保存',
              '发布',
            ]
          : [
              'Back to course',
              'Rename Module A',
              'Reach Deck generation stages',
              'Generate all',
              'Generation tasks',
              'Delete all',
              'Try as learner',
              'Save',
              'Publish',
            ],
      );
      const rename = toolbar!.querySelector<HTMLButtonElement>(
        zh ? '[aria-label="重命名“Module A”"]' : '[aria-label="Rename Module A"]',
      )!;
      await act(async () => rename.click());
      const input = toolbar!.querySelector<HTMLInputElement>('input')!;
      expect(document.activeElement).toBe(input);
      await act(async () => fireEvent.change(input, { target: { value: '   ' } }));
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(onRenameModule).not.toHaveBeenCalled();
      expect(toolbar?.querySelector('[role="alert"]')?.textContent).toBe(
        zh ? '名称不能为空。' : 'Name is required.',
      );
      await act(async () => fireEvent.change(input, { target: { value: '  Updated module  ' } }));
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(onRenameModule).toHaveBeenCalledWith('Updated module');
      expect(input.value).toBe('  Updated module  ');
      expect(toolbar?.querySelector('[role="alert"]')).not.toBeNull();
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
      expect(onRenameModule).toHaveBeenCalledTimes(2);
      expect(toolbar?.querySelector('input')).toBeNull();
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        zh ? '重命名“Module A”' : 'Rename Module A',
      );
      await act(async () =>
        toolbar
          ?.querySelector<HTMLButtonElement>(
            zh ? '[aria-label="重命名“Module A”"]' : '[aria-label="Rename Module A"]',
          )
          ?.click(),
      );
      const cancelInput = toolbar!.querySelector<HTMLInputElement>('input')!;
      await act(async () => fireEvent.change(cancelInput, { target: { value: 'Cancelled' } }));
      await act(async () => fireEvent.keyDown(cancelInput, { key: 'Escape' }));
      expect(onRenameModule).toHaveBeenCalledTimes(2);
      expect(toolbar?.textContent).toContain('Module A');
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      // 没有确认/取消按钮：编辑态只有输入框，焦点离开即保存，且不把焦点抢回编辑按钮。
      await act(async () =>
        toolbar
          ?.querySelector<HTMLButtonElement>(
            zh ? '[aria-label="重命名“Module A”"]' : '[aria-label="Rename Module A"]',
          )
          ?.click(),
      );
      const blurInput = toolbar!.querySelector<HTMLInputElement>('input')!;
      expect(blurInput.closest('div')?.querySelectorAll('button')).toHaveLength(0);
      await act(async () => fireEvent.change(blurInput, { target: { value: 'Blurred module' } }));
      await act(async () => blurInput.blur());
      expect(onRenameModule).toHaveBeenLastCalledWith('Blurred module');
      expect(toolbar?.querySelector('input')).toBeNull();
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      expect(document.activeElement?.getAttribute('aria-label')).not.toBe(
        zh ? '重命名“Module A”' : 'Rename Module A',
      );
      // 失焦时空名称直接还原，不提交也不报错。
      await act(async () =>
        toolbar
          ?.querySelector<HTMLButtonElement>(
            zh ? '[aria-label="重命名“Module A”"]' : '[aria-label="Rename Module A"]',
          )
          ?.click(),
      );
      const emptyInput = toolbar!.querySelector<HTMLInputElement>('input')!;
      await act(async () => fireEvent.change(emptyInput, { target: { value: '  ' } }));
      await act(async () => emptyInput.blur());
      expect(onRenameModule).toHaveBeenCalledTimes(3);
      expect(toolbar?.querySelector('input')).toBeNull();
      expect(toolbar?.querySelector('[role="alert"]')).toBeNull();
      const regenerate = [...toolbar!.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === (zh ? '一键生成' : 'Generate all'),
      );
      await act(async () => regenerate?.click());
      expect(onRequestRegeneration).toHaveBeenCalledTimes(1);
    },
  );

  it('aligns the deck action group with the canvas-corner regenerate icon and opens deletion', async () => {
    const onRequestMediaDeletion = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = { ...readyPageWorkspace(), stage: 'complete' };
    panelProps.jobs = [];
    const rects = new Map<string, Partial<DOMRect>>([
      ['corner', { left: 860, right: 900, width: 40 }],
      ['actions', { left: 1000, right: 1200, width: 200 }],
      ['group', { left: 600, right: 800, width: 200 }],
      ['previous', { left: 100, right: 300, width: 200 }],
    ]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const role = this.dataset.testRect;
      return { ...new DOMRect(), ...(role === undefined ? {} : rects.get(role)) } as DOMRect;
    });
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            documentActions={{
              disabled: false,
              onPublish: vi.fn(),
              onSave: vi.fn(),
              onTrial: vi.fn(),
            }}
            editor={
              <div className="reach-deck-editor__preview">
                <div className="reach-deck-editor__canvas-corner-row" data-test-rect="corner" />
              </div>
            }
            materialized
            moduleTitle="Module A"
            onRequestMediaDeletion={onRequestMediaDeletion}
            onRequestRegeneration={vi.fn()}
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    const toolbar = host.querySelector('[data-workbench-toolbar]')!;
    const deleteButton = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '一键删除',
    )!;
    const group = deleteButton.parentElement as HTMLElement;
    group.dataset.testRect = 'group';
    (group.previousElementSibling as HTMLElement).dataset.testRect = 'previous';
    (group.nextElementSibling as HTMLElement).dataset.testRect = 'actions';
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    // 文档操作区左缘 1000 − 画布角右缘 900 = 100：组右缘与“重新生成本页”右缘对齐。
    expect(group.style.marginInlineEnd).toBe('100px');

    // 左侧空间不足时退回紧邻排布，不挤压模块名与阶段选择。
    rects.set('previous', { left: 100, right: 790, width: 690 });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(group.style.marginInlineEnd).toBe('');

    await act(async () => deleteButton.click());
    expect(onRequestMediaDeletion).toHaveBeenCalledOnce();
  });

  it('keeps an inline rename pending, blocks duplicate requests, and restores editing after failure', async () => {
    let rejectRename!: (cause: Error) => void;
    const onRenameModule = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRename = reject;
        }),
    );
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = { ...readyPageWorkspace(), stage: 'complete' };
    panelProps.jobs = [];
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={<div />}
            materialized
            moduleTitle="Module A"
            onRenameModule={onRenameModule}
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Rename Module A"]')?.click(),
    );
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => fireEvent.change(input, { target: { value: 'Updated module' } }));
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onRenameModule).toHaveBeenCalledTimes(1);
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute('aria-busy')).toBe('true');
    await act(async () => input.blur());
    expect(onRenameModule).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.keyDown(input, { key: 'Escape' }));
    expect(host.querySelector('input')).toBe(input);
    await act(async () =>
      rejectRename(new Error('The course changed elsewhere. Reload and try again.')),
    );
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('Updated module');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('course changed elsewhere');
  });

  async function openActivity(): Promise<void> {
    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="生成任务状态"], button[aria-label="Generation tasks"]',
    );
    expect(trigger).not.toBeNull();
    if (trigger?.getAttribute('aria-expanded') !== 'true') await act(async () => trigger?.click());
  }

  async function selectFlowStage(label: string): Promise<void> {
    const bannerButton = [
      ...(host
        .querySelector(
          'ol[aria-label="Reach Deck 生成阶段"], ol[aria-label="Reach Deck generation stages"]',
        )
        ?.querySelectorAll('button') ?? []),
    ].find((button) => button.textContent?.includes(label));
    if (bannerButton !== undefined) {
      await act(async () => bannerButton.click());
      return;
    }

    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"], button[aria-label="Reach Deck generation stages"][aria-haspopup="listbox"]',
    );
    await act(async () => trigger?.click());
    const option = [...window.document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent?.includes(label),
    );
    await act(async () => {
      option?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }

  it('hides every authoring stage behind the shared loading animation until workspace state resolves', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={<div data-studio-editor />}
            initialWorkspaceLoading
            materialized={false}
            moduleTitle="Resolved Deck"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const loading = host.querySelector('[data-workspace-loading="true"]');
    expect(loading?.querySelector('[role="status"]')?.textContent).toContain('Loading Reach Deck');
    expect(loading?.querySelector('progress')).toBeNull();
    expect(host.querySelector('[data-flow-step]')).toBeNull();
    expect(host.querySelector('[data-step]')).toBeNull();
    expect(host.querySelector('[aria-label="Teaching brief input"]')).toBeNull();

    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={<div data-studio-editor />}
            initialWorkspaceLoading={false}
            materialized
            moduleTitle="Resolved Deck"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[data-workspace-loading]')).toBeNull();
    expect(host.querySelector('[data-step="studio"]')).not.toBeNull();
    expect(host.querySelector('[data-studio-editor]')).not.toBeNull();
  });

  it('shows the existing brief stage after the first lookup confirms there is no workspace', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            initialWorkspaceLoading
            materialized={false}
            moduleTitle="新 Deck"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    expect(host.querySelector('[aria-label="教学需求输入"]')).toBeNull();

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            initialWorkspaceLoading={false}
            materialized={false}
            moduleTitle="新 Deck"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[data-workspace-loading]')).toBeNull();
    expect(host.querySelector('[data-step="brief"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="教学需求输入"]')).not.toBeNull();
  });

  it.each([false, true])(
    'shows preparation loading immediately before materials bind (existing draft=%s)',
    async (existing) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.jobs = [];
      if (existing) panelProps.workspace = generatingWorkspaceWithPlan();
      const render = () =>
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="课件"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        );
      await act(async () => render());
      if (existing) await selectFlowStage('需求');
      panelProps.busyAction = 'create-workspace';
      await act(async () => render());
      expect(host.querySelector('[data-material-preparing]')?.textContent).toContain(
        '正在准备教学设计',
      );
      expect(host.querySelector('[data-step]')?.getAttribute('data-step')).toBe('lesson-plan');
      expect(host.querySelector('[aria-label="教学需求输入"]')).toBeNull();
      expect(host.querySelector('[role="alertdialog"]')).toBeNull();
      panelProps.busyAction = undefined;
      panelProps.error = '材料解析失败';
      await act(async () => render());
      expect(host.querySelector('[data-material-preparing]')).toBeNull();
      expect(host.textContent).toContain('材料解析失败');
    },
  );

  it('explains that content language follows the brief in both application locales', () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];

    act(() =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="Language contract"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    expect(host.textContent).toContain('Generation language');
    expect(
      [...host.querySelectorAll('[data-brief-title-primary] [data-brief-title-word]')].map(
        (word) => word.textContent,
      ),
    ).toEqual(['knowledge', 'capabilities', 'core values']);
    expect(
      [...host.querySelectorAll('[data-brief-title-secondary] [data-brief-title-word]')].map(
        (word) => word.textContent,
      ),
    ).toEqual(['impart', 'develop', 'nurture']);

    act(() =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="语言合同"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    expect(host.textContent).toContain('生成语言');
    expect(host.querySelector('h1')?.getAttribute('aria-label')).toBe(
      '今天想传授什么知识、培养什么能力、塑造什么价值？',
    );
    expect(
      [...host.querySelectorAll('[data-brief-title-static]')].map((part) => part.textContent),
    ).toEqual(['今天想', '什么', '？']);
    expect(
      [...host.querySelectorAll('[data-brief-title-primary] [data-brief-title-word]')].map(
        (word) => word.textContent,
      ),
    ).toEqual(['传授', '培养', '塑造']);
    expect(
      [...host.querySelectorAll('[data-brief-title-secondary] [data-brief-title-word]')].map(
        (word) => word.textContent,
      ),
    ).toEqual(['知识', '能力', '价值']);
  });

  it('uses the unified language listbox and clearly distinguishes web-search states', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];

    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="Control consistency"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );

    const createPanel = host.querySelector<HTMLElement>('#reach-deck-brief-create-panel');
    const webSearch = createPanel?.querySelector<HTMLButtonElement>('[aria-pressed]');
    expect(webSearch?.getAttribute('aria-pressed')).toBe('false');
    expect(webSearch?.hasAttribute('data-active')).toBe(false);
    expect(webSearch?.querySelector('svg')?.getAttribute('width')).toBe('15');

    await act(async () => webSearch?.click());
    expect(webSearch?.getAttribute('aria-pressed')).toBe('true');
    expect(webSearch?.getAttribute('data-active')).toBe('true');

    expect(createPanel?.querySelector('select')).toBeNull();
    const languageTrigger = createPanel?.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Generation language"]',
    );
    expect(languageTrigger).not.toBeNull();
    await act(async () => languageTrigger?.click());
    const languageList = document.querySelector('[role="listbox"]');
    expect(languageList?.classList.contains(styles.languageSelectList)).toBe(true);
    const englishOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('English (US)'),
    );
    expect(englishOption).not.toBeUndefined();
    await act(async () => englishOption?.click());
    expect(languageTrigger?.textContent).toContain('English (US)');

    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="控件一致性"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    expect(host.querySelector('[role="combobox"][aria-label="生成语言"]')).not.toBeNull();
    expect(host.querySelector('select')).toBeNull();
  });

  it('renders workspace load failures inside the workspace body instead of a page-level banner', async () => {
    const onRefresh = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.error = 'Failed to read Reach Deck job';
    panelProps.onRefresh = onRefresh;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="旧工作区"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const failure = host.querySelector('[role="alert"]');
    expect(failure?.closest('[data-step="brief"]')).not.toBeNull();
    expect(failure?.textContent).toContain('Failed to read Reach Deck job');
    expect(host.querySelector('[aria-label="教学需求输入"]')).toBeNull();

    const reload = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重新加载',
    );
    await act(async () => reload?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('renders teacher-action failures as a floating state inside the existing stage', async () => {
    const onRefresh = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.error = 'Reach Deck 操作失败，请重试。';
    panelProps.onRefresh = onRefresh;
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'lesson-plan',
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="已有工作区"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const failure = host.querySelector('[role="alert"]');
    expect(failure?.closest('[data-step="lesson-plan"]')).not.toBeNull();
    expect(failure?.textContent).toContain('Reach Deck 操作失败，请重试。');
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
    const reload = [...(failure?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '重新加载',
    );
    await act(async () => reload?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('does not duplicate a page action failure already owned by the editor overlay', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.error = '本页生成失败';
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={<div data-editor-overlay-owner />}
            materialized
            moduleTitle="页面错误"
            pageErrorHandledByEditor
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[data-editor-overlay-owner]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('本页生成失败');
  });

  it('does not duplicate a studio placeholder failure when an editor render function returns null', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.error = '工作台暂不可用';
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={() => null}
            materialized
            moduleTitle="页面错误"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const alerts = host.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.closest('[data-editor-workspace="true"]')).not.toBeNull();
    expect(alerts[0]?.textContent).toContain('工作台暂不可用');
  });

  it('preserves supported page-goal formatting in the existing string contract', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '理解', marks: [{ type: 'bold' }] },
            { type: 'text', text: '勾股定理 ' },
            { type: 'inlineMath', attrs: { latex: 'a^2+b^2=c^2' } },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '应用公式' }] }],
            },
          ],
        },
      ],
    };

    const markdown = outlineSummaryFromRichText(document);
    expect(markdown).toContain('**理解**');
    expect(markdown).toContain('\\(a^2+b^2=c^2\\)');
    expect(markdown).toContain('- 应用公式');
    expect(outlineSummaryFromRichText(outlineSummaryToRichText(markdown))).toBe(markdown);
    // 旧 summary 契约不再接受，不为历史记录保留自动转换。
    expect(() =>
      parsePageOutlineValue({
        estimatedDurationMinutes: 12.5,
        id: 'page-1',
        order: 1,
        sceneType: 'slide',
        summary: markdown,
        title: '勾股定理',
      }),
    ).toThrow();
  });

  it('round-trips raw and escaped relation operators through the title rich-text bridge', () => {
    const markdown = '比较 \\(x<y>0\\)、\\(a\\lt b\\) 与 \\(c\\gt d\\)';
    const document = outlineSummaryToRichText(markdown);
    expect(document.content?.[0]?.content?.filter((node) => node.type === 'inlineMath')).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ latex: 'x<y>0' }) }),
      expect.objectContaining({ attrs: expect.objectContaining({ latex: 'a\\lt b' }) }),
      expect.objectContaining({ attrs: expect.objectContaining({ latex: 'c\\gt d' }) }),
    ]);
    expect(outlineSummaryFromRichText(document)).toBe(markdown);
    const rendered = renderMathToString('x<y>0');
    expect(rendered).toContain('&lt;');
    expect(rendered).toContain('&gt;');
    expect(richTextToPlainText(outlineSummaryToRichText('未闭合 \\(x<y'))).toBe('未闭合 \\(x<y');
  });

  it('shows a server-restored active job and lets the teacher stop it', async () => {
    const onCancelJob = vi.fn();
    const panelProps = createPanelProps(onCancelJob);
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'lesson-plan',
      lessonPlan: undefined,
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    act(() =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );

    // 生成中的骨架大图下内嵌停止按钮(取代此前独立的任务栏)。
    const generating = host.querySelector('[aria-live="polite"]');
    expect(generating).not.toBeNull();
    const stop = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '停止',
    );
    expect(stop).toBeDefined();
    act(() => stop?.click());
    const cancelDialog = document.querySelector('[role="alertdialog"]');
    expect(cancelDialog).not.toBeNull();
    await act(async () =>
      [...(cancelDialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onCancelJob).toHaveBeenCalledWith('job-plan-active');
  });

  it('shows bilingual terminal batch summaries with accessible status labels', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...readyPageWorkspace(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    const batch = createWorkspaceBatch({
      members: [
        { done: true, order: 0, pageId: 'page-1', status: 'completed' },
        { done: true, order: 1, pageId: 'page-2', status: 'failed' },
        { done: true, order: 2, pageId: 'page-3', status: 'blocked' },
        { done: true, order: 3, pageId: 'page-4', status: 'cancelled' },
      ],
      skipped: [{ order: 4, pageId: 'page-5', reason: 'not-slide' }],
      status: 'partial-failure',
    });
    const render = (locale: 'zh-CN' | 'en-US') =>
      act(() =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              batches={[batch]}
              editor={<div data-studio-editor />}
              materialized
              moduleTitle="Batch summary"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );

    render('en-US');
    await openActivity();
    const english = document.querySelector('[data-batch-status="partial-failure"]');
    expect(english?.getAttribute('aria-label')).toBe('Narration batch: Completed with issues');
    expect(english?.textContent).toContain('Total 5');
    expect(english?.textContent).toContain('Succeeded 1');
    expect(english?.textContent).toContain('Failed 1');
    expect(english?.textContent).toContain('Blocked 1');
    expect(english?.textContent).toContain('Cancelled 1');
    expect(english?.textContent).toContain('Skipped 1');
    // 计数为 0 的类别不展示。
    expect(english?.textContent).not.toContain('Audio failed 0');

    render('zh-CN');
    const chinese = document.querySelector('[data-batch-status="partial-failure"]');
    expect(chinese?.getAttribute('aria-label')).toBe('讲稿批次：部分失败');
    expect(chinese?.textContent).toContain('成功 1');
    expect(chinese?.textContent).toContain('未执行 1');
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'shows each standalone mode in the real Studio activity entry (%s)',
    async (locale) => {
      for (const lanes of [
        ['layout'],
        ['narration'],
        ['audio'],
        ['animation'],
        ['audio', 'animation'],
        ['narration', 'audio', 'animation'],
      ] as const) {
        const panelProps = createPanelProps(vi.fn());
        panelProps.workspace = { ...readyPageWorkspace(), stage: 'complete' };
        panelProps.jobs = [
          {
            jobId: 'single-' + lanes.join('-'),
            runId: panelProps.workspace.runId,
            pageId: 'page-1',
            kind: lanes[0] === 'layout' ? 'page-generation' : 'narration-generation',
            sourceKind: 'workspace',
            affectedLanes: [...lanes],
            queuedAt: '2026-10-13T00:00:00.000Z',
            status: 'active',
            progress: 37,
            done: false,
          },
        ];
        act(() =>
          root.render(
            <PortalI18nProvider locale={locale}>
              <ReachDeckAuthoringFlow
                editor={({ canvasCornerAction }) => (
                  <div data-single-corner>{canvasCornerAction}</div>
                )}
                materialized
                moduleTitle="Single"
                panelProps={panelProps}
              />
            </PortalI18nProvider>,
          ),
        );
        const trigger = document.querySelector<HTMLButtonElement>(
          '[aria-label="生成任务状态"], [aria-label="Generation tasks"]',
        );
        expect(trigger?.getAttribute('aria-label')).toBe(
          locale === 'zh-CN' ? '生成任务状态' : 'Generation tasks',
        );
        if (trigger?.getAttribute('aria-expanded') !== 'true')
          await act(async () => trigger?.click());
        const progress = document.querySelector(
          '[data-page-activity="page-1"] [role="progressbar"]',
        );
        expect(progress?.getAttribute('aria-valuenow')).toBe('37');
        expect(progress?.getAttribute('aria-label')).toBe(
          locale === 'zh-CN' ? '单页生成进度' : 'Page generation progress',
        );
      }
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'shows cancelled single-page activity without a failure or active signal (%s)',
    async (locale) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = { ...readyPageWorkspace(), stage: 'complete' };
      for (const done of [false, true]) {
        panelProps.jobs = [
          {
            jobId: 'cancelled-single',
            runId: panelProps.workspace.runId,
            pageId: 'page-1',
            kind: 'narration-generation',
            sourceKind: 'workspace',
            affectedLanes: ['audio'],
            queuedAt: '2026-10-13T00:00:00.000Z',
            status: 'cancelled',
            progress: 100,
            done,
          },
        ];
        act(() =>
          root.render(
            <PortalI18nProvider locale={locale}>
              <ReachDeckAuthoringFlow
                editor={({ canvasCornerAction }) => (
                  <div data-cancelled-corner>{canvasCornerAction}</div>
                )}
                materialized
                moduleTitle="Cancelled single"
                panelProps={panelProps}
              />
            </PortalI18nProvider>,
          ),
        );
        const trigger = document.querySelector<HTMLButtonElement>(
          '[aria-label="生成任务状态"], [aria-label="Generation tasks"]',
        );
        expect(trigger?.hasAttribute('data-active')).toBe(false);
        expect(trigger?.hasAttribute('data-attention')).toBe(true);
        expect(trigger?.getAttribute('aria-label')).toBe(
          locale === 'zh-CN' ? '生成任务状态' : 'Generation tasks',
        );
        if (trigger?.getAttribute('aria-expanded') !== 'true')
          await act(async () => trigger?.click());
        const row = document.querySelector('[data-activity-status="cancelled"]');
        expect(row?.querySelector('[role="status"]')?.textContent).toBe(
          locale === 'zh-CN' ? '已取消' : 'Cancelled',
        );
        expect(row?.querySelector('[role="alert"]')).toBeNull();
        expect(row?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
          '99',
        );
        expect(row?.querySelector('[role="progressbar"]')?.getAttribute('data-tone')).toBe(
          'primary',
        );
      }
    },
  );

  it.each([undefined, ['historical']])(
    'shows recovered live progress during pending replay without acknowledging terminal history (snapshot=%j)',
    async (previousJobIds) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = { ...readyPageWorkspace(), stage: 'complete' };
      panelProps.pendingPageActivities = [
        {
          runId: panelProps.workspace.runId,
          pageId: 'page-1',
          kind: 'narration-generation',
          affectedLanes: ['audio'],
          ...(previousJobIds === undefined ? {} : { previousJobIds }),
        },
      ];
      panelProps.jobs = [
        {
          jobId: 'recovered',
          runId: panelProps.workspace.runId,
          kind: 'narration-generation',
          pageId: 'page-1',
          sourceKind: 'workspace',
          affectedLanes: ['audio'],
          status: 'active',
          done: false,
          progress: 63,
          progressPhase: 'audio',
        },
      ];
      const render = () =>
        act(() =>
          root.render(
            <PortalI18nProvider locale="en-US">
              <ReachDeckAuthoringFlow
                editor={<div />}
                materialized
                moduleTitle="Recovered"
                panelProps={panelProps}
              />
            </PortalI18nProvider>,
          ),
        );
      render();
      await openActivity();
      expect(document.querySelector('[data-activity-status="submitting"]')).toBeNull();
      expect(
        document
          .querySelector('[data-activity-status="active"] [role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ).toBe('63');
      // Display takeover does not mutate the persisted submission, and its historical job stays excluded.
      expect(panelProps.pendingPageActivities).toHaveLength(1);
      panelProps.jobs = [
        { ...panelProps.jobs[0]!, jobId: 'historical', status: 'completed', done: true },
      ];
      render();
      expect(document.querySelector('[data-activity-status="submitting"]')).not.toBeNull();
    },
  );

  it('shows indeterminate pending feedback and clamps landing/failure progress in the Studio toolbar', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = { ...readyPageWorkspace(), stage: 'complete' };
    const render = () =>
      act(() =>
        root.render(
          <PortalI18nProvider locale="en-US">
            <ReachDeckAuthoringFlow
              editor={<div />}
              materialized
              moduleTitle="Single fallback"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
    panelProps.jobs = [];
    panelProps.pendingPageActivities = [
      {
        runId: panelProps.workspace.runId,
        pageId: 'page-1',
        kind: 'narration-generation',
        affectedLanes: ['audio'],
      },
    ];
    render();
    await openActivity();
    expect(
      document
        .querySelector('[data-activity-status="submitting"] [role="progressbar"]')
        ?.hasAttribute('aria-valuenow'),
    ).toBe(false);
    panelProps.pendingPageActivities = [];
    for (const status of ['completed', 'failed'] as const) {
      panelProps.jobs = [
        {
          jobId: 'single',
          runId: panelProps.workspace.runId,
          kind: 'narration-generation',
          pageId: 'page-1',
          sourceKind: 'workspace',
          affectedLanes: ['audio'],
          status,
          done: status === 'failed',
          progress: 100,
        },
      ];
      render();
      expect(
        document
          .querySelector('[data-page-activity="page-1"] [role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ).toBe('99');
      expect(
        document
          .querySelector('[data-page-activity="page-1"] [role="progressbar"]')
          ?.getAttribute('data-tone'),
      ).not.toBe('success');
    }
  });

  it('labels a narration waiting for TTS and lets the teacher cancel it from the activity panel', async () => {
    const onCancelJob = vi.fn();
    const panelProps = createPanelProps(onCancelJob);
    panelProps.workspace = { ...readyPageWorkspace(), stage: 'complete' };
    panelProps.jobs = [
      {
        jobId: 'waiting-tts-job',
        runId: panelProps.workspace.runId,
        kind: 'narration-generation',
        pageId: 'page-1',
        sourceKind: 'workspace',
        affectedLanes: ['audio', 'animation'],
        status: 'delayed',
        done: false,
        progress: 65,
        progressPhase: 'waiting-tts',
      },
    ];
    act(() =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={<div />}
            materialized
            moduleTitle="等待语音合成"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    await openActivity();
    const row = document.querySelector('[data-page-activity="page-1"]');
    expect(row?.textContent).toContain('正在排队等待语音合成…');
    const cancel = [...(row?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '取消',
    );
    expect(cancel).toBeDefined();
    act(() => cancel?.click());
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    await act(async () =>
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onCancelJob).toHaveBeenCalledWith('waiting-tts-job');
  });

  it('moves batch progress into the toolbar and keeps an empty activity entry', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...readyPageWorkspace(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    const activeBatch = createWorkspaceBatch({
      members: [
        { done: false, order: 0, pageId: 'page-1', status: 'running' },
        { done: false, order: 1, pageId: 'page-2', status: 'waiting-predecessor' },
      ],
      skipped: [{ order: 2, pageId: 'page-3', reason: 'has-narration' }],
    });
    const materializedDocument = {
      pages: [
        { pageId: 'page-3', order: 3, title: '第三页' },
        { pageId: 'page-1', order: 1, title: '第一页' },
        { pageId: 'page-2', order: 2, title: '第二页' },
      ],
    } as unknown as ReachDeckDocument;
    const render = (batches: ReturnType<typeof createWorkspaceBatch>[]) =>
      act(() =>
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              batches={batches}
              editor={({ canvasCornerAction }) => (
                <div data-embedded-studio-chrome>
                  <div data-studio-canvas-action>{canvasCornerAction}</div>
                </div>
              )}
              materialized
              materializedDocument={materializedDocument}
              moduleTitle="批次弹层"
              onCancelWorkspaceBatch={vi.fn()}
              onInspectWorkspaceBatch={vi.fn().mockResolvedValue(activeBatch)}
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );

    render([activeBatch]);
    // 顶部不再占一条横幅；摘要条搬进画布角落入口的弹层里。
    const corner = document.querySelector('[data-studio-canvas-action]');
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="生成任务状态"]');
    expect(trigger?.getAttribute('aria-label')).toBe('生成任务状态');
    expect(trigger?.hasAttribute('data-active')).toBe(true);
    expect(corner?.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => trigger?.click());
    const popover = document.querySelector('[role="dialog"][aria-label="当前生成批次"]');
    expect(popover?.querySelector('[data-batch-status="active"]')).not.toBeNull();
    expect(popover?.querySelector('[aria-label="关闭批量生成进度"]')).not.toBeNull();
    // 逐页进度按文档页序排在批次下方（原页面列表里的文字行）。
    expect(
      [...(popover?.querySelectorAll('[aria-label="讲稿批次 · 逐页进度"] li') ?? [])].map((row) =>
        row.textContent?.trim(),
      ),
    ).toEqual([
      '1. 第一页正在生成讲稿',
      '2. 第二页排队中，等待第 1 页讲稿',
      '3. 第三页已跳过，已有讲稿',
    ]);
    // 逐页进度按状态分组：进行中/排队中展开，跳过组默认折叠。
    expect(
      [...(popover?.querySelectorAll('details') ?? [])].map((group) => [
        group.querySelector('summary')?.textContent,
        group.open,
      ]),
    ).toEqual([
      ['进行中1 页', true],
      ['排队中1 页', true],
      ['已跳过或取消1 页', false],
    ]);
    expect(
      document.querySelector('[data-editor-workspace] > [aria-label="当前生成批次"]'),
    ).toBeNull();
    await act(async () =>
      popover?.querySelector<HTMLButtonElement>('[aria-label="关闭批量生成进度"]')?.click(),
    );
    expect(corner?.querySelector('[role="dialog"]')).toBeNull();

    render([
      createWorkspaceBatch({
        members: [{ done: true, order: 0, pageId: 'page-1', status: 'completed' }],
        status: 'completed',
      }),
    ]);
    const settled = document.querySelector<HTMLButtonElement>('button[aria-label="生成任务状态"]');
    expect(settled?.getAttribute('aria-label')).toBe('生成任务状态');
    expect(settled?.hasAttribute('data-active')).toBe(false);

    render([]);
    expect(host.querySelector('[aria-label="生成任务状态"]')).not.toBeNull();
    await openActivity();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('暂无生成任务。');
  });

  it('re-reads a member cancellation range and requires confirmation again when it changes', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...readyPageWorkspace(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    const initial = createWorkspaceBatch({
      kind: 'media',
      members: [
        { done: false, order: 0, pageId: 'page-1', status: 'running' },
        { done: false, order: 1, pageId: 'page-2', status: 'waiting-dispatch' },
      ],
    });
    const changed = createWorkspaceBatch({
      kind: 'media',
      members: [
        { done: true, order: 0, pageId: 'page-1', status: 'completed' },
        { done: false, order: 1, pageId: 'page-2', status: 'running' },
      ],
      revision: 2,
    });
    const onInspectWorkspaceBatch = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed)
      .mockResolvedValue(changed);
    const onCancelWorkspaceBatch = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            batches={[initial]}
            editor={(chrome) => <div data-studio-editor>{chrome.canvasCornerAction}</div>}
            materialized
            moduleTitle="取消批次"
            onCancelWorkspaceBatch={onCancelWorkspaceBatch}
            onInspectWorkspaceBatch={onInspectWorkspaceBatch}
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    // 嵌入式工作台里唯一的取消入口在画布角落弹层的批次摘要中。
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="生成任务状态"]');
    await act(async () => trigger?.click());
    const cancelInPopover = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] [aria-label="取消媒体生成批次"]',
    );
    expect(cancelInPopover).not.toBeNull();
    await act(async () => {
      cancelInPopover?.click();
      await Promise.resolve();
    });
    let dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('本次媒体生成批次');
    expect(dialog?.textContent).toContain('2 页');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '取消批次')
        ?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('1 页');
    expect(dialog?.textContent).toContain('未完成范围已变化');
    expect(onCancelWorkspaceBatch).not.toHaveBeenCalled();

    await act(async () => {
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '取消批次')
        ?.click();
      await Promise.resolve();
    });

    expect(onInspectWorkspaceBatch).toHaveBeenCalledTimes(3);
    expect(onCancelWorkspaceBatch).toHaveBeenCalledWith(initial.batchId);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="取消媒体生成批次"]')
        ?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps an authoritative cancellation-range read failure visible beside the batch', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...readyPageWorkspace(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    const batch = createWorkspaceBatch({
      members: [{ done: false, order: 0, pageId: 'page-1', status: 'running' }],
    });

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            batches={[batch]}
            editor={<div data-studio-editor />}
            materialized
            moduleTitle="Cancellation read failure"
            onCancelWorkspaceBatch={vi.fn()}
            onInspectWorkspaceBatch={vi.fn().mockRejectedValue(new Error('raw backend reason'))}
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    await openActivity();
    const cancel = document.querySelector<HTMLButtonElement>(
      '[aria-label="Cancel Narration batch"]',
    );
    await act(async () => {
      cancel?.click();
      await Promise.resolve();
    });

    const alert = document
      .querySelector('[data-batch-status="active"]')
      ?.parentElement?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      'The latest cancellation range could not be loaded. Try again.',
    );
    expect(host.textContent).not.toContain('raw backend reason');
  });

  it('keeps the dialog open with safe copy when the batch cancellation action fails', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...readyPageWorkspace(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    const batch = createWorkspaceBatch({
      members: [{ done: false, order: 0, pageId: 'page-1', status: 'running' }],
    });

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            batches={[batch]}
            editor={<div data-studio-editor />}
            materialized
            moduleTitle="Cancellation action failure"
            onCancelWorkspaceBatch={vi.fn().mockRejectedValue(new Error('raw POST response'))}
            onInspectWorkspaceBatch={vi.fn().mockResolvedValue(batch)}
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    await openActivity();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Cancel Narration batch"]')?.click();
      await Promise.resolve();
    });
    const dialog = document.querySelector('[role="alertdialog"]');
    await act(async () => {
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Cancel batch')
        ?.click();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe(
      'The batch could not be cancelled. Try again.',
    );
    expect(host.textContent).not.toContain('raw POST response');
  });

  it('submits the brief without confirmation and jumps to the regenerating plan view', async () => {
    const onCreateWorkspace = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.sourceDraft = '换一个主题重新讲';
    panelProps.onCreateWorkspace = onCreateWorkspace;
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    const confirmSpy = vi.spyOn(window, 'confirm');

    const render = (props: ReachDeckGenerationPanelProps) =>
      act(async () =>
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="并发控制"
              panelProps={props}
            />
          </PortalI18nProvider>,
        ),
      );

    await render(panelProps);
    await selectFlowStage('教学需求');
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();

    await act(async () => submit?.click());
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onCreateWorkspace).toHaveBeenCalledWith('换一个主题重新讲', expect.any(Object));

    const withUndoneLessonJob: ReachDeckGenerationPanelProps = {
      ...panelProps,
      jobs: [
        {
          jobId: 'job-plan-new',
          kind: 'lesson-plan',
          status: 'active',
          done: false,
        },
      ],
    };
    await render(withUndoneLessonJob);

    // 需求重提交后:一旦出现新的未完成教案任务,界面离开需求回看视图。
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.textContent).toContain('AI 正在搭建这节课的教学骨架');
  });

  it('only jumps away from the brief step once per lesson-plan job, not on every render', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'lesson-plan',
      lessonPlan: undefined,
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        jobId: 'job-plan-1',
        kind: 'lesson-plan',
        status: 'active',
        done: false,
      },
    ];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    // 首次进入需求回看视图,存在未完成教案任务:自动跳转到教案生成视图一次。
    await selectFlowStage('教学需求');
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.textContent).toContain('AI 正在搭建这节课的教学骨架');

    // 教师再次手动切回需求回看视图;同一个任务仍未完成,不应被再次弹回。
    await selectFlowStage('教学需求');
    expect(host.querySelector('button[type="submit"]')).not.toBeNull();

    // 触发一次与该跳转无关的重渲染(相同 job 列表引用变化),确认仍留在需求页。
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={{ ...panelProps, jobs: [...panelProps.jobs] }}
          />
        </PortalI18nProvider>,
      );
    });
    expect(host.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('only jumps away from the lesson-plan step once per page-outline job, not on every render', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = outlineWorkspace();
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    // 教师手动切回教学设计回看视图,此时尚无未完成的大纲任务:停留在教学设计页。
    await selectFlowStage('教学设计');
    expect(host.querySelector('[data-step="lesson-plan"]')).not.toBeNull();

    // 出现一个新的未完成大纲任务(例如采用暂存教案后自动重新生成大纲):自动跳转一次。
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={{
              ...panelProps,
              jobs: [
                {
                  jobId: 'job-outline-1',
                  kind: 'page-outline',
                  status: 'active',
                  done: false,
                },
              ],
            }}
          />
        </PortalI18nProvider>,
      );
    });
    expect(host.querySelector('[data-step="page-outline"]')).not.toBeNull();

    // 教师再次手动切回教学设计回看视图;同一个大纲任务仍未完成,不应被再次弹回。
    await selectFlowStage('教学设计');
    expect(host.querySelector('[data-step="lesson-plan"]')).not.toBeNull();
  });

  it.each([
    ['zh-CN', '已保存的素材计划'],
    ['en-US', 'Saved visual plan'],
  ] as const)(
    'shows the outline page visual plan as read-only context in %s',
    async (locale, label) => {
      const panelProps = createPanelProps(vi.fn());
      const workspace = outlineWorkspace();
      const page = workspace.pagedOutline!.pages[0]!;
      const plannedPage: PageOutline = {
        ...page,
        instructionalSpec: {
          ...page.instructionalSpec!,
          visualAssets: [
            {
              kind: 'image',
              purpose: 'Saved scientific context',
              alt: 'Source-grounded image',
              prompt: 'Describe the evidence',
              aspectRatio: '16:9',
              placement: 'supporting',
            },
          ],
        },
      };
      panelProps.workspace = {
        ...workspace,
        stage: 'page-outline',
        pagedOutline: {
          ...workspace.pagedOutline!,
          pages: workspace.pagedOutline!.pages.map((candidate) =>
            candidate.id === page.id ? plannedPage : candidate,
          ),
        },
      };
      const original = structuredClone(panelProps.workspace);
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="Evidence"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      const section = host.querySelector(`[aria-label="${label}"]`);
      expect(section?.textContent).toContain('Saved scientific context — Source-grounded image');
      expect(section?.querySelector('input,textarea,[contenteditable=true]')).toBeNull();
      expect(panelProps.workspace).toEqual(original);
    },
  );

  it('omits the visual plan section when the selected page plans no assets', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = { ...outlineWorkspace(), stage: 'page-outline' };
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="Evidence"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    expect(host.querySelector('[aria-label="Saved visual plan"]')).toBeNull();
  });

  it.each([0, 1, 6, 7])('does not gate adoption on the key-point count (%i)', async (count) => {
    const panelProps = createPanelProps(vi.fn());
    const workspace = outlineWorkspace();
    panelProps.workspace = {
      ...workspace,
      stage: 'page-outline',
      pagedOutline: {
        ...workspace.pagedOutline!,
        pages: workspace.pagedOutline!.pages.map((page, index) =>
          index === 0
            ? {
                ...page,
                instructionalSpec: {
                  ...page.instructionalSpec!,
                  keyPoints: Array.from({ length: count }, (_, i) => `Evidence ${i + 1}`),
                },
              }
            : page,
        ),
      },
    };
    panelProps.onAdoptPageOutline = vi.fn();
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="Evidence"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    // Teaching specifications are editable context, not an adoption prerequisite.
    expect(host.querySelector('[data-repair-navigation="true"]')).toBeNull();
  });

  it('confirms before regenerating existing deck content from a cancelled-job fallback', async () => {
    const onAdoptPageOutline = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [
      {
        jobId: 'job-cancelled-outline',
        kind: 'page-outline',
        status: 'cancelled',
        done: true,
      },
    ];
    panelProps.workspace = outlineWorkspace();
    panelProps.onAdoptPageOutline = onAdoptPageOutline;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');

    const continueButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '生成下一步',
    );
    expect(continueButton).toBeDefined();

    await act(async () => continueButton?.click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(onAdoptPageOutline).not.toHaveBeenCalled();

    await act(async () =>
      [...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '取消')
        ?.click(),
    );
    await act(async () => continueButton?.click());
    await act(async () =>
      [...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onAdoptPageOutline).toHaveBeenCalledWith(expect.any(Object), undefined);
  });

  it('shows the staged outline when no candidate job remains', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...outlineWorkspace(),
      stagedPagedOutline: {
        id: 'outline-1',
        title: 'Staged outline',
        pages: [
          {
            id: 'page-1',
            order: 1,
            sceneType: 'slide',
            title: 'Staged first page',
            estimatedDurationMinutes: 8,
            instructionalSpec: validInstructionalSpec(),
            slideClassification: validSlideClassification(),
          },
        ],
      },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');

    // 没有候选任务残留时,大纲屏幕退回工作区的暂存大纲(自动入库写入的候选),
    // 而不是已采用的旧 pagedOutline。
    expect(host.textContent).toContain('Staged first page');
    expect(host.textContent).not.toContain('第一页');
  });

  it.each([
    { status: 'cancelled', source: 'staged' as const, editDuration: false },
    { status: 'failed', source: 'adopted' as const, editDuration: true },
    { status: 'completed', source: 'staged' as const, editDuration: false },
  ])(
    'adopts the $source workspace outline without the $status job provenance',
    async ({ status, source, editDuration }) => {
      const onAdoptPageOutline = vi.fn();
      const panelProps = createPanelProps(vi.fn());
      const baseOutline = outlineWorkspace().pagedOutline!;
      const fallbackOutline = {
        ...baseOutline,
        id: `${source}-outline`,
        title: `${source} fallback`,
        pages: baseOutline.pages.map((page, index) => ({
          ...page,
          title: index === 0 ? `${source} fallback page` : page.title,
        })),
      };
      panelProps.workspace = {
        ...outlineWorkspace(),
        stage: 'page-outline',
        pagedOutline: source === 'adopted' ? fallbackOutline : baseOutline,
        stagedPagedOutline: source === 'staged' ? fallbackOutline : undefined,
      } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
      panelProps.jobs = [
        {
          jobId: `job-${status}-outline`,
          kind: 'page-outline',
          status,
          done: true,
        },
      ];
      panelProps.onAdoptPageOutline = onAdoptPageOutline;

      await act(async () => {
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="恢复分页大纲"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        );
      });
      await selectFlowStage('分页大纲');
      expect(host.textContent).toContain(`${source} fallback page`);

      const duration = host.querySelector<HTMLInputElement>('input[type="number"]');
      expect(duration).not.toBeNull();
      if (editDuration) {
        await act(async () => {
          if (duration === null) return;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            duration,
            '13',
          );
          duration.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '生成下一步',
      );
      expect(continueButton?.disabled).toBe(false);
      await act(async () => continueButton?.click());

      expect(onAdoptPageOutline).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `${source}-outline`,
          pages: [
            expect.objectContaining({
              id: 'page-1',
              estimatedDurationMinutes: editDuration ? 13 : 10,
            }),
            expect.objectContaining({ id: 'page-2', estimatedDurationMinutes: 10 }),
          ],
        }),
        undefined,
      );
    },
  );

  it.each([
    { editDuration: false, expectedDuration: 10 },
    { editDuration: true, expectedDuration: 14 },
  ])(
    'keeps completed candidate provenance when duration editing is $editDuration',
    async ({ editDuration, expectedDuration }) => {
      const onAdoptPageOutline = vi.fn();
      const panelProps = createPanelProps(vi.fn());
      const baseOutline = outlineWorkspace().pagedOutline!;
      const candidate = {
        ...baseOutline,
        id: 'candidate-outline',
        title: 'Completed candidate',
        pages: baseOutline.pages.map((page, index) => ({
          ...page,
          title: index === 0 ? 'Completed candidate page' : page.title,
        })),
      };
      panelProps.workspace = {
        ...outlineWorkspace(),
        stage: 'page-outline',
      } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
      panelProps.jobs = [
        {
          jobId: 'job-completed-outline',
          kind: 'page-outline',
          status: 'completed',
          done: true,
          candidate,
        },
      ];
      panelProps.onAdoptPageOutline = onAdoptPageOutline;

      await act(async () => {
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="完成分页大纲"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        );
      });
      await selectFlowStage('分页大纲');
      expect(host.textContent).toContain('Completed candidate page');

      if (editDuration) {
        const duration = host.querySelector<HTMLInputElement>('input[type="number"]');
        expect(duration).not.toBeNull();
        await act(async () => {
          if (duration === null) return;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            duration,
            '14',
          );
          duration.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '生成下一步',
      );
      expect(continueButton?.disabled).toBe(false);
      await act(async () => continueButton?.click());

      expect(onAdoptPageOutline).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'candidate-outline',
          pages: expect.arrayContaining([
            expect.objectContaining({ estimatedDurationMinutes: expectedDuration }),
          ]),
        }),
        'job-completed-outline',
      );
    },
  );

  it('keeps a registered outline job in the generating state until its candidate completes', async () => {
    const onAdoptPageOutline = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...outlineWorkspace(),
      stage: 'page-outline',
      stagedPagedOutline: outlineWorkspace().pagedOutline,
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        jobId: 'job-registered-outline',
        kind: 'page-outline',
        status: 'registered',
        done: false,
      },
    ];
    panelProps.onAdoptPageOutline = onAdoptPageOutline;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="生成分页大纲"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');

    expect(host.textContent).toContain('AI 正在规划 Deck 的叙事路径');
    expect(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '生成下一步',
      )?.disabled,
    ).toBe(true);
    expect(onAdoptPageOutline).not.toHaveBeenCalled();
  });

  it('does not auto-start a duplicate outline while a cancelled recovery descriptor remains', async () => {
    const onStartPageOutline = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...outlineWorkspace(),
      stage: 'page-outline',
      stagedPagedOutline: outlineWorkspace().pagedOutline,
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        jobId: 'job-cancelled-outline',
        kind: 'page-outline',
        status: 'cancelled',
        done: true,
      },
    ];
    panelProps.onStartPageOutline = onStartPageOutline;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="恢复分页大纲"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="恢复分页大纲"
            panelProps={{ ...panelProps, jobs: [...panelProps.jobs] }}
          />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });

    expect(onStartPageOutline).not.toHaveBeenCalled();
  });

  it('guards the legacy apply callback with completed candidate provenance', async () => {
    const onApplyPageOutline = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    const candidate = {
      ...outlineWorkspace().pagedOutline!,
      id: 'legacy-candidate-outline',
      title: 'Legacy completed candidate',
    };
    panelProps.workspace = {
      ...outlineWorkspace(),
      stage: 'page-outline',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        jobId: 'job-legacy-completed',
        kind: 'page-outline',
        status: 'completed',
        done: true,
        candidate,
      },
    ];
    panelProps.onAdoptPageOutline = undefined;
    panelProps.onApplyPageOutline = onApplyPageOutline;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="兼容采用"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');
    const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '生成下一步',
    );
    expect(continueButton?.disabled).toBe(false);
    await act(async () => continueButton?.click());

    expect(onApplyPageOutline).toHaveBeenCalledWith('job-legacy-completed', ['page-1', 'page-2']);
  });

  it('disables the legacy apply callback for a workspace outline without eligible provenance', async () => {
    const onApplyPageOutline = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...outlineWorkspace(),
      stage: 'page-outline',
      stagedPagedOutline: outlineWorkspace().pagedOutline,
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        jobId: 'job-legacy-cancelled',
        kind: 'page-outline',
        status: 'cancelled',
        done: true,
      },
    ];
    panelProps.onAdoptPageOutline = undefined;
    panelProps.onApplyPageOutline = onApplyPageOutline;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="兼容采用"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');
    const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '生成下一步',
    );

    expect(continueButton?.disabled).toBe(true);
    await act(async () => continueButton?.click());
    expect(onApplyPageOutline).not.toHaveBeenCalled();
  });

  it('offers prior-round restore in the studio', async () => {
    const onRestorePriorGeneration = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      priorGeneration: {},
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.onRestorePriorGeneration = onRestorePriorGeneration;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const restore = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '恢复上一轮内容',
    );
    expect(restore).toBeDefined();
    await act(async () => restore?.click());
    await act(async () =>
      [...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onRestorePriorGeneration).toHaveBeenCalled();
  });

  it('does not render a page-level retry banner for a restored failed page', async () => {
    const onStartPage = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.onStartPage = onStartPage;
    panelProps.error = 'request failed';
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      // 恢复上一轮后 jobs 列表被清空,但工作区快照里仍带着一个可重试的失败页面;
      // 此前只从 panelProps.jobs 派生"重新生成"按钮,导致这类页面无处补救。
      statuses: { 'page-1': { state: 'failed', retryable: true } },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[aria-label="生成问题处理"]')).toBeNull();
    const canvasFailure = host.querySelector('[role="alert"]');
    expect(canvasFailure?.textContent).toContain('request failed');
    expect(onStartPage).not.toHaveBeenCalled();
  });

  it('hides the stale failed-job retry once the page has landed via a newer attempt', async () => {
    const panelProps = createPanelProps(vi.fn());
    // 失败任务不会被标记已采用:同页经重试成功落地后,恢复列表仍可能
    // 把旧失败 job 还给前端。此时"重新生成"是陈旧入口,横幅不应再出现。
    panelProps.jobs = [
      {
        jobId: 'job-stale-narration',
        kind: 'narration-generation',
        pageId: 'page-1',
        done: true,
        error: 'Generation failed: invalid-output',
      },
    ] as unknown as ReachDeckGenerationPanelProps['jobs'];
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      statuses: { 'page-1': { state: 'ready' } },
      sceneArtifacts: { 'page-1': { sceneType: 'slide', status: 'ready' } },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const generationIssues = host.querySelector('[aria-label="生成问题处理"]');
    expect(generationIssues).toBeNull();
  });

  it('does not render a narration retry banner when the layout artifact survived', async () => {
    const onStartPage = vi.fn();
    const onRegeneratePageNarration = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.onStartPage = onStartPage;
    panelProps.onRegeneratePageNarration = onRegeneratePageNarration;
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      // 讲稿阶段失败：failed 状态 + 版面工件仍以 ready 保留（任务②形态）。
      statuses: { 'page-1': { state: 'failed', retryable: true } },
      sceneArtifacts: { 'page-1': { sceneType: 'slide', status: 'ready' } },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[aria-label="生成问题处理"]')).toBeNull();
    expect(onRegeneratePageNarration).not.toHaveBeenCalled();
    expect(onStartPage).not.toHaveBeenCalled();
  });

  it('shows the regenerate-all-narration entry first in the studio deck menu', async () => {
    // 整份入口只出现在 studio 命令栏的“整份课件操作”菜单里：未进入 studio 时没有命令栏。
    const onRegenerateAllNarration = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.onRegenerateAllNarration = onRegenerateAllNarration;
    panelProps.onGenerateAllAudio = vi.fn();
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      statuses: { 'page-1': { state: 'ready' } },
      sceneArtifacts: { 'page-1': { sceneType: 'slide', status: 'ready' } },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    const findRegenerateAll = () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="重新生成所有讲稿、音频和动画"]');

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    expect(findRegenerateAll()).toBeNull();

    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={({ commandBar }) => <div>{commandBar}</div>}
            materialized
            moduleTitle="并发控制"
            panelProps={{ ...panelProps }}
          />
        </PortalI18nProvider>,
      );
    });
    // 菜单只在打开时挂载：不支持 Popover API 的旧内核不能把它常驻显示在命令栏上。
    expect(document.querySelector('[aria-label="整份课件操作"][role="dialog"]')).toBeNull();
    expect(document.querySelector('[popover]')).toBeNull();
    const menu = await openDeckMenu();
    expect(menu.firstElementChild?.firstElementChild).toBe(
      menu.querySelector('button[aria-label="重新生成所有讲稿、音频和动画"]'),
    );
    expect(onRegenerateAllNarration).not.toHaveBeenCalled();
  });

  it('does not render a native narration retry banner', async () => {
    // native 通道没有整页重生成状态机：讲稿任务失败的重试必须走讲稿重生成，
    // 绝不能落到 onStartPage（无生成回合的 deck 上会 409）。
    const onStartPage = vi.fn();
    const onRegeneratePageNarration = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.onStartPage = onStartPage;
    panelProps.onRegeneratePageNarration = onRegeneratePageNarration;
    panelProps.nativeNarrationEligible = true;
    panelProps.jobs = [
      {
        jobId: 'job-native-narration-1',
        kind: 'narration-generation',
        status: 'failed',
        done: true,
        error: 'Generation failed: internal',
        pageId: 'page-native',
      },
    ];
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      source: 'pptx-import',
      records: {},
      statuses: {},
      targetPageIds: [],
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized
            moduleTitle="导入课件"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[aria-label="生成问题处理"]')).toBeNull();
    expect(onRegeneratePageNarration).not.toHaveBeenCalled();
    expect(onStartPage).not.toHaveBeenCalled();
  });

  it.each([
    ['zh-CN', 'GUARDRAIL_BLOCKED', '未通过安全审核'],
    ['en-US', 'GUARDRAIL_UNAVAILABLE', 'safety review could not be completed'],
  ] as const)(
    'localizes terminal safety failures in %s and hides same-job retry',
    async (locale, code, expected) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = {
        ...generatingWorkspaceWithPlan(),
        stage: 'lesson-plan',
        lessonPlan: undefined,
      } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
      panelProps.jobs = [
        {
          jobId: 'guardrail-job',
          kind: 'lesson-plan',
          status: 'failed',
          done: true,
          error: `Generation failed: ${code}`,
        },
      ];
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="Safety test"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      expect(host.textContent).toContain(expected);
      expect(host.textContent).not.toContain(code);
      expect(
        [...host.querySelectorAll('button')].find((button) =>
          ['重试该任务', 'Retry this job'].includes(button.textContent?.trim() ?? ''),
        ),
      ).toBeUndefined();
      expect(panelProps.jobs[0].error).toBe(`Generation failed: ${code}`);
    },
  );

  it('hides the retry button for superseded planning jobs', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'lesson-plan',
      lessonPlan: undefined,
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        jobId: 'job-plan-superseded',
        kind: 'lesson-plan',
        status: 'failed',
        done: true,
        error: 'Generation failed: superseded',
      },
    ];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const restart = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重新发起',
    );
    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重试该任务',
    );
    expect(restart).toBeDefined();
    expect(retry).toBeUndefined();
  });

  it.each(['lesson-plan', 'page-outline'] as const)(
    'retains previous %s content while regenerating, exposes failure, and displays the fresh result',
    async (kind) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = { ...outlineWorkspace(), stage: kind };
      panelProps.onRestartPlanningStage = vi.fn();
      const candidate =
        kind === 'lesson-plan'
          ? { ...panelProps.workspace.lessonPlan!, title: 'Fresh regenerated plan' }
          : {
              ...panelProps.workspace.pagedOutline!,
              pages: panelProps.workspace.pagedOutline!.pages.map((page) => ({
                ...page,
                title: 'Fresh regenerated page',
              })),
            };
      const render = async () => {
        await act(async () =>
          root.render(
            <PortalI18nProvider locale="zh-CN">
              <ReachDeckAuthoringFlow
                editor={null}
                materialized={false}
                moduleTitle="Regeneration"
                panelProps={panelProps}
              />
            </PortalI18nProvider>,
          ),
        );
      };
      const oldJob = {
        jobId: 'older-active',
        kind,
        status: 'active',
        done: false,
        queuedAt: '2026-09-24T01:00:00Z',
      };
      panelProps.jobs = [oldJob];
      await render();
      const screenLabel = kind === 'lesson-plan' ? '总体教学设计' : '分页大纲设计';
      const screen = () => host.querySelector(`[aria-label="${screenLabel}"]`)!;
      const assertOldVisible = () => {
        if (kind === 'lesson-plan') {
          expect(
            screen().querySelector<HTMLInputElement>('[aria-label="教学设计标题"]')?.value,
          ).toBe(panelProps.workspace?.lessonPlan?.title);
        } else {
          expect(screen().textContent).toContain(
            panelProps.workspace?.pagedOutline?.pages[0]?.title,
          );
        }
      };
      expect(screen().querySelector('[role="status"]')).not.toBeNull();
      assertOldVisible();
      const regenerate = [...screen().querySelectorAll('button')].find((button) =>
        button.textContent?.includes(kind === 'lesson-plan' ? '重新生成教学设计' : '重新生成大纲'),
      );
      expect(regenerate?.disabled).toBe(true);

      // The newer failure wins even if stale discovery appends an old in-flight job last.
      panelProps.jobs = [
        {
          jobId: 'newer-job',
          kind,
          status: 'failed',
          done: true,
          error: 'Generation failed: superseded',
          queuedAt: '2026-09-24T02:00:00Z',
        },
        oldJob,
      ];
      await render();
      expect(screen().querySelector('[role="alert"]')).not.toBeNull();
      assertOldVisible();
      expect(
        [...screen().querySelectorAll('button')].some(
          (button) => button.textContent?.trim() === '重新发起',
        ),
      ).toBe(true);

      panelProps.jobs = [
        {
          jobId: 'newer-job',
          kind,
          status: 'completed',
          done: true,
          candidate,
          queuedAt: '2026-09-24T02:00:00Z',
        } as ReachDeckGenerationPanelProps['jobs'][number],
        oldJob,
      ];
      await render();
      expect(screen().querySelector('[role="alert"]')).toBeNull();
      if (kind === 'lesson-plan') {
        expect(screen().querySelector<HTMLInputElement>('[aria-label="教学设计标题"]')?.value).toBe(
          'Fresh regenerated plan',
        );
      } else {
        expect(screen().textContent).toContain('Fresh regenerated page');
      }
    },
  );

  it.each(
    (['lesson-plan', 'page-outline'] as const).flatMap((kind) =>
      [false, true].flatMap((legacyFirst) =>
        ['active', 'completed', 'failed', 'cancelled'].map((oldStatus) => ({
          kind,
          legacyFirst,
          oldStatus,
        })),
      ),
    ),
  )(
    'keeps the timestamped $kind active ahead of a $oldStatus legacy job (legacy first=$legacyFirst)',
    async ({ kind, legacyFirst, oldStatus }) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = { ...outlineWorkspace(), stage: kind };
      panelProps.onRestartPlanningStage = vi.fn();
      const candidate =
        kind === 'lesson-plan'
          ? { ...panelProps.workspace.lessonPlan!, title: 'Stale legacy plan' }
          : {
              ...panelProps.workspace.pagedOutline!,
              pages: panelProps.workspace.pagedOutline!.pages.map((page) => ({
                ...page,
                title: 'Stale legacy page',
              })),
            };
      const oldJob = {
        jobId: 'legacy-job',
        kind,
        status: oldStatus,
        done: oldStatus !== 'active',
        ...(oldStatus === 'completed' ? { candidate } : {}),
      } as ReachDeckGenerationPanelProps['jobs'][number];
      const newJob = {
        jobId: 'current-job',
        kind,
        status: 'active',
        done: false,
        queuedAt: '2026-09-24T02:00:00Z',
      };
      panelProps.jobs = legacyFirst ? [oldJob, newJob] : [newJob, oldJob];
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="Regeneration"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      const screen = host.querySelector(
        `[aria-label="${kind === 'lesson-plan' ? '总体教学设计' : '分页大纲设计'}"]`,
      )!;
      expect(screen.querySelector('[role="status"]')).not.toBeNull();
      expect(screen.querySelector('[role="alert"]')).toBeNull();
      expect(screen.textContent).not.toContain('Stale legacy');
      if (kind === 'lesson-plan')
        expect(screen.querySelector<HTMLInputElement>('[aria-label="教学设计标题"]')?.value).toBe(
          panelProps.workspace.lessonPlan!.title,
        );
      const cancel = [...screen.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '停止',
      );
      expect(cancel).toBeDefined();
      await act(async () => cancel?.click());
      const confirm = [
        ...window.document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
      ].find((button) => button.textContent?.trim() === '继续');
      expect(confirm).toBeDefined();
      await act(async () => confirm?.click());
      expect(panelProps.onCancelJob).toHaveBeenCalledWith('current-job');
    },
  );

  it('restarts a failed lesson-plan with a fresh nonce when no planning restart handler is supplied', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'lesson-plan',
      lessonPlan: undefined,
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        jobId: 'job-cancelled-plan',
        kind: 'lesson-plan',
        status: 'failed',
        done: true,
        error: 'Generation failed: cancelled',
      },
    ];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="教案恢复"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const restart = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重新发起',
    );
    await act(async () => restart?.click());
    expect(panelProps.onStartLessonPlan).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ regenerateNonce: expect.any(String) }),
    );
  });

  it('restarts a failed page-outline through the nonce-bearing planning restart path', async () => {
    const onRestartPlanningStage = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.onRestartPlanningStage = onRestartPlanningStage;
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'page-outline',
      pagedOutline: undefined,
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        jobId: 'job-cancelled-outline',
        kind: 'page-outline',
        status: 'failed',
        done: true,
        error: 'Generation failed: cancelled',
      },
    ];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="大纲恢复"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const restart = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重新发起',
    );
    await act(async () => restart?.click());
    expect(onRestartPlanningStage).toHaveBeenCalledWith(
      'page-outline',
      undefined,
      expect.objectContaining({ enabledSceneTypes: expect.any(Array) }),
    );
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'restores a durable empty workbench without generation (%s)',
    async (locale) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.jobs = [];
      panelProps.workspace = createGenerationWorkspace({
        runId: 'blank-version',
        documentId: 'version',
        source: 'manual-empty',
        createdAt: '2026-09-28T00:00:00Z',
      });
      const document = {
        ...createBlankReachDeckDocument({ id: 'version', title: 'Blank' }),
        pages: [],
        nativeSlides: [],
      };
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              editor={<div data-empty-studio />}
              materialized
              materializedDocument={document}
              moduleTitle="Blank"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      expect(host.querySelector('[data-empty-studio]')).not.toBeNull();
      expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
      expect(panelProps.onMaterialize).not.toHaveBeenCalled();
    },
  );

  it('keeps an interrupted blank creation resumable without normal generation materialization', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.onStartLessonPlan = vi.fn();
    panelProps.onMaterialize = vi.fn();
    panelProps.jobs = [];
    panelProps.workspace = createGenerationWorkspace({
      runId: 'blank-version',
      documentId: 'version',
      source: 'manual-empty',
      createdAt: '2026-09-28T00:00:00Z',
    });
    const resume = vi.fn();
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="Blank"
            panelProps={panelProps}
            onRequestBlankCreate={resume}
          />
        </PortalI18nProvider>,
      ),
    );
    const button = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Start from blank'),
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(resume).toHaveBeenCalledOnce();
    expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
    expect(panelProps.onMaterialize).not.toHaveBeenCalled();
  });

  it('switches between the persistent brief cards and opens the existing import preview callbacks', async () => {
    const onRequestPptxCreate = vi.fn();
    const onRequestMaicCreate = vi.fn();
    const onRequestBlankCreate = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.onCreateWorkspace = vi.fn();
    panelProps.jobs = [];

    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="PPTX 导入"
            onRequestBlankCreate={onRequestBlankCreate}
            onRequestMaicCreate={onRequestMaicCreate}
            onRequestPptxCreate={onRequestPptxCreate}
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );

    const createPanel = host.querySelector<HTMLElement>('#reach-deck-brief-create-panel');
    const importPanel = host.querySelector<HTMLElement>('#reach-deck-brief-import-panel');
    const editor = createPanel?.querySelector('[contenteditable="true"]');
    expect(createPanel?.getAttribute('aria-hidden')).toBe('false');
    expect(createPanel?.hasAttribute('inert')).toBe(false);
    expect(importPanel?.getAttribute('aria-hidden')).toBe('true');
    expect(importPanel?.hasAttribute('inert')).toBe(true);

    const webSearch = createPanel?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    const pdfInput = createPanel?.querySelector<HTMLInputElement>(
      'input[aria-label="上传教学材料"]',
    );
    if (pdfInput === null || pdfInput === undefined) throw new Error('PDF input not found');
    const pdf = new File(['lesson'], 'lesson.pdf', { type: 'application/pdf' });
    await act(async () => webSearch?.click());
    Object.defineProperty(pdfInput, 'files', { configurable: true, value: [pdf] });
    await act(async () => pdfInput?.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(() => expect(createPanel?.textContent).toContain('lesson.pdf'));

    const importTab = host.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-label="切换到自主制作"]',
    );
    await act(async () => importTab?.click());
    expect(createPanel?.hasAttribute('inert')).toBe(true);
    expect(importPanel?.hasAttribute('inert')).toBe(false);

    const pptxTrigger = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.trim().startsWith('上传我的 PPTX 以开始'),
    );
    const maicTrigger = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.trim().startsWith('从 JSON 导入'),
    );
    expect(pptxTrigger).toBeDefined();
    expect(maicTrigger).toBeDefined();
    act(() => pptxTrigger?.click());
    act(() => maicTrigger?.click());
    expect(onRequestPptxCreate).toHaveBeenCalledOnce();
    expect(onRequestMaicCreate).toHaveBeenCalledOnce();
    const blankTrigger = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.trim().startsWith('从空白开始'),
    );
    expect(blankTrigger).toBeDefined();
    await act(async () => blankTrigger?.click());
    expect(onRequestBlankCreate).toHaveBeenCalledOnce();
    expect(panelProps.onCreateWorkspace).not.toHaveBeenCalled();
    expect(importPanel?.textContent).not.toContain('MAIC');

    const poweredBy = host.querySelector<HTMLElement>('[data-brief-powered-by]');
    const briefScroll = host.querySelector<HTMLElement>('[data-brief-scroll]');
    expect(poweredBy?.parentElement).toBe(briefScroll?.parentElement);
    expect(briefScroll?.contains(poweredBy ?? null)).toBe(false);
    expect(poweredBy?.getAttribute('aria-label')).toContain('OpenMAIC');
    expect(
      [...(poweredBy?.querySelectorAll('[data-powered-by-brand]') ?? [])].map(
        (brand) => brand.textContent,
      ),
    ).toEqual([
      'OpenMAIC',
      'MiniMax pptx-generator',
      'ppt-master',
      'frontend-slides',
      'pptx-from-layouts',
    ]);

    await act(async () => {
      importTab?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
    });
    expect(host.querySelector('#reach-deck-brief-create-panel')?.hasAttribute('inert')).toBe(false);
    expect(host.querySelector('[contenteditable="true"]')).toBe(editor);
    expect(host.querySelector('#reach-deck-brief-create-panel')?.textContent).toContain(
      'lesson.pdf',
    );
    expect(
      host.querySelector('#reach-deck-brief-create-panel button[aria-pressed="false"]'),
    ).not.toBeNull();
  });

  it('projects imported workspaces as stages 01 and 04 without starting hidden planning jobs', async () => {
    const onPublish = vi.fn();
    const onSave = vi.fn();
    const onTrial = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.onStartLessonPlan = vi.fn();
    panelProps.onStartPageOutline = vi.fn();
    panelProps.sourceDraft = 'pptx-import';
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      runId: `pptx-import-${'a'.repeat(32)}`,
      source: 'pptx-import',
      stage: 'lesson-plan',
      lessonPlan: undefined,
      records: {},
      statuses: {},
      targetPageIds: [],
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            documentActions={{ disabled: false, onPublish, onSave, onTrial }}
            editor={({ commandBar }) => <div data-imported-command-bar>{commandBar}</div>}
            materialized
            moduleTitle="导入课件"
            onRequestMaicCreate={vi.fn()}
            onRequestPptxCreate={vi.fn()}
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
    expect(panelProps.onStartPageOutline).not.toHaveBeenCalled();
    const publish = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '发布',
    );
    const trial = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '试学',
    );
    expect(publish?.disabled).toBe(false);
    expect(trial?.disabled).toBe(false);
    await act(async () => trial?.click());
    expect(onTrial).toHaveBeenCalledOnce();

    const stageTrigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"]',
    );
    await act(async () => stageTrigger?.click());
    const options = [...window.document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      '01 · 教学需求',
      '04 · Deck 工作台',
    ]);

    await act(async () => {
      options[0]?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const briefStageTrigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"]',
    );
    expect(briefStageTrigger?.textContent).toContain('01 · 教学需求');
    expect(document.activeElement).toBe(briefStageTrigger);
    await act(async () => briefStageTrigger?.click());
    const compactStageList = window.document.querySelector<HTMLElement>('[role="listbox"]');
    expect(compactStageList?.dataset.portal).toBe('true');
    expect(compactStageList?.classList.contains(styles.studioStepSelectList)).toBe(true);
    await act(async () => briefStageTrigger?.click());
    expect(host.querySelector('ol[aria-label="Reach Deck 生成阶段"]')).toBeNull();
    expect(
      host
        .querySelector('[role="tab"][aria-label="切换到自主制作"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="切换到从零开始"]')?.click();
    });
    expect(host.querySelector('#reach-deck-brief-create-panel')?.textContent).not.toContain(
      'pptx-import',
    );
    expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
  });

  it('restores the standard four-stage projection when an import run receives a real brief', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.sourceDraft = 'pptx-import';
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      runId: `pptx-import-${'b'.repeat(32)}`,
      source: 'pptx-import',
      stage: 'lesson-plan',
      lessonPlan: undefined,
      records: {},
      statuses: {},
      targetPageIds: [],
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    const render = async () => {
      await act(async () => {
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={({ commandBar }) => <div data-transition-command-bar>{commandBar}</div>}
              materialized
              moduleTitle="导入转生成"
              panelProps={{ ...panelProps }}
            />
          </PortalI18nProvider>,
        );
      });
    };

    await render();
    panelProps.sourceDraft = '为九年级设计一节函数复习课';
    panelProps.workspace = {
      ...panelProps.workspace,
      source: panelProps.sourceDraft,
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    await render();

    const stageTrigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"]',
    );
    await act(async () => stageTrigger?.click());
    expect(
      [...window.document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(['01 · 教学需求', '02 · 教学设计', '03 · 分页大纲', '04 · Deck 工作台']);
    expect(panelProps.onStartLessonPlan).toHaveBeenCalledOnce();
  });

  it('recognizes the durable MAIC create-import sentinel as the same two-stage workflow', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.onStartLessonPlan = vi.fn();
    panelProps.sourceDraft = 'maic-import';
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      runId: `maic-import-${'c'.repeat(32)}`,
      source: 'maic-import',
      stage: 'lesson-plan',
      lessonPlan: undefined,
      records: {},
      statuses: {},
      targetPageIds: [],
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={({ commandBar }) => <div data-maic-command-bar>{commandBar}</div>}
            materialized
            moduleTitle="MAIC 导入"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const stageTrigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"]',
    );
    await act(async () => stageTrigger?.click());
    expect(
      [...window.document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(['01 · 教学需求', '04 · Deck 工作台']);
    expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
  });

  it('keeps a partially applied imported workspace on stage 01 until materialization recovers', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.onStartLessonPlan = vi.fn();
    panelProps.onStartPageOutline = vi.fn();
    panelProps.sourceDraft = 'pptx-import';
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      runId: `pptx-import-${'d'.repeat(32)}`,
      source: 'pptx-import',
      stage: 'lesson-plan',
      lessonPlan: undefined,
      records: {},
      statuses: {},
      targetPageIds: [],
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="等待导入物化"
            onRequestMaicCreate={vi.fn()}
            onRequestPptxCreate={vi.fn()}
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const stageTrigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"]',
    );
    expect(stageTrigger?.textContent).toContain('01 · 教学需求');
    expect(host.querySelector('ol[aria-label="Reach Deck 生成阶段"]')).toBeNull();
    expect(host.querySelector('[aria-label="总体教学设计"]')).toBeNull();
    expect(
      host
        .querySelector('[role="tab"][aria-label="切换到自主制作"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
    expect(panelProps.onStartPageOutline).not.toHaveBeenCalled();
  });

  it('不再前端自动采用已完成的产物：落地与推进都在服务端', async () => {
    const onApplyPageArtifact = vi.fn();
    const onStartPage = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = pendingRegenerateWorkspace();
    panelProps.jobs = [
      {
        jobId: 'job-repair-page-1',
        kind: 'page-generation',
        pageId: 'page-1',
        status: 'completed',
        done: true,
        error: 'Reach Deck generation status is temporarily unavailable',
        artifact: { pageId: 'page-1' } as never,
      },
    ];
    panelProps.onApplyPageArtifact = onApplyPageArtifact;
    panelProps.onStartPage = onStartPage;
    panelProps.materialized = true;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    // 产物落地由页生成完成处理器在服务端完成，前端不再自动提交采用请求；
    // GenerationStudio 仍保留手动采用/重试按钮，教师可在服务端失败时兜底。
    expect(onApplyPageArtifact).not.toHaveBeenCalled();
    expect(onStartPage).not.toHaveBeenCalled();
  });

  it('不再前端自动推进：pending 页由服务端链式发起', async () => {
    const onApplyPageArtifact = vi.fn();
    const onStartPage = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = pendingRegenerateWorkspace();
    panelProps.jobs = [
      {
        jobId: 'job-repair-page-1',
        kind: 'page-generation',
        pageId: 'page-1',
        status: 'failed',
        done: true,
        error: 'Repair failed',
      },
    ];
    panelProps.onApplyPageArtifact = onApplyPageArtifact;
    panelProps.onStartPage = onStartPage;
    // 同上:已物化状态下验证失败的修复请求不会被当作 initial 重新提交。
    panelProps.materialized = true;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(onApplyPageArtifact).not.toHaveBeenCalled();
    expect(onStartPage).not.toHaveBeenCalled();
  });

  it('已物化工作区里的 pending initial 页也不会被前端自动发起', async () => {
    // 删除 autopilot 前，这正是前端会自动 onStartPage 的场景；现在推进权在服务端。
    const onStartPage = vi.fn();
    const onMaterialize = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      statuses: { 'page-1': { state: 'pending' } },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.materialized = true;
    panelProps.onStartPage = onStartPage;
    panelProps.onMaterialize = onMaterialize;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(onStartPage).not.toHaveBeenCalled();
    // 已物化则连物化都不再触发：前端在第四步只剩展示与手动操作。
    expect(onMaterialize).not.toHaveBeenCalled();
  });

  it('keeps a ready generation state beside the editor while later pages generate', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = readyPageWorkspace();
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={<div data-generation-editor />}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[data-editor-workspace="true"]')).not.toBeNull();
    expect(host.querySelector('[data-generation-editor]')).not.toBeNull();
    expect(host.querySelector('[aria-label="逐页生成工作台"]')).toBeNull();
    expect(host.querySelector('[aria-label="生成页面缩略图"]')).toBeNull();
  });

  it('defers materialization until page generation completes', async () => {
    const onMaterialize = vi.fn();
    const onStartPage = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    // 回合刚开始:page-generation 阶段,首页仍是 pending(initial),尚未物化。
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      statuses: { 'page-1': { state: 'pending' } },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.materialized = false;
    panelProps.onMaterialize = onMaterialize;
    panelProps.onStartPage = onStartPage;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    // native-only v2 不持久化缺少 binding 的生成中页面。
    expect(onMaterialize).not.toHaveBeenCalled();
    expect(onStartPage).not.toHaveBeenCalled();
  });

  it('does not repeat materialization while the persisted document is still loading', async () => {
    const onMaterialize = vi.fn();
    const onRefresh = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...readyPageWorkspace(),
      stage: 'complete',
      paused: false,
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [];
    panelProps.materialized = true;
    panelProps.materializedPreviewAvailable = false;
    panelProps.onMaterialize = onMaterialize;
    panelProps.onRefresh = onRefresh;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(onMaterialize).not.toHaveBeenCalled();
    const reload = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '重新加载',
    );
    expect(reload).toBeDefined();
    await act(async () => reload?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onMaterialize).not.toHaveBeenCalled();
  });

  it('enters fine-tuning directly once materialized, without a separate opt-in step', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = readyPageWorkspace();
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={<div data-fine-tuning-editor />}
            materialized
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[data-fine-tuning-editor]')).not.toBeNull();
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === '精调课件',
      ),
    ).toBe(false);
  });

  it('renders studio controls above the editor grid', async () => {
    const onSave = vi.fn();
    const onPublish = vi.fn();
    const onRestorePriorGeneration = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
      priorGeneration: {},
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.onRestorePriorGeneration = onRestorePriorGeneration;
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            backHref="/teacher/courses/course-1"
            documentActions={{
              disabled: false,
              onPublish,
              onSave,
              onTrial: vi.fn(),
              status: '更改已自动保存',
            }}
            editor={({ commandBar, pageRailHeader, rightPanelAction }) => (
              <div data-embedded-studio-chrome>
                {pageRailHeader}
                <div data-studio-command-bar>{commandBar}</div>
                <div data-studio-right-panel-action>{rightPanelAction}</div>
              </div>
            )}
            materialized
            moduleTitle="紧凑工作台"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const embedded = host.querySelector('[data-workbench-toolbar]');
    expect(
      host.querySelector('[data-embedded-studio-chrome] [data-studio-command-bar]')?.textContent,
    ).toBe('');
    expect(embedded?.querySelector('a[aria-label="返回课程"]')).not.toBeNull();
    expect(embedded?.textContent).toContain('紧凑工作台');
    const stageTrigger = embedded?.querySelector<HTMLButtonElement>(
      'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"]',
    );
    expect(stageTrigger).not.toBeNull();
    expect(embedded?.querySelector('select')).toBeNull();
    expect(embedded?.querySelectorAll('button')).toHaveLength(6);
    const status = embedded?.querySelector<HTMLElement>('[role="status"]');
    expect(status?.textContent).toBe('');
    expect(status?.getAttribute('aria-label')).toBe('更改已自动保存');
    expect(status?.title).toBe('更改已自动保存');
    expect(status?.className).toContain(styles.saveStatusDot);
    expect(embedded?.textContent).not.toContain('更改已自动保存');
    const restore = host.querySelector<HTMLButtonElement>(
      '[data-studio-right-panel-action] button',
    );
    expect(restore?.textContent).toContain('恢复上一轮内容');
    expect(embedded?.textContent).not.toContain('恢复上一轮内容');
    await act(async () => restore?.click());
    await act(async () =>
      [...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onRestorePriorGeneration).toHaveBeenCalledTimes(1);
    await act(async () => stageTrigger?.click());
    const stageList = window.document.querySelector('[role="listbox"]');
    expect(stageList?.getAttribute('data-portal')).toBe('true');
    expect(stageList?.classList.contains(styles.studioStepSelectList)).toBe(true);
    expect(stageList?.querySelectorAll('[role="option"]')).toHaveLength(4);
    expect(stageList?.querySelector('[aria-selected="true"]')?.textContent).toContain(
      '04 · Deck 工作台',
    );
    expect(host.querySelector('ol[aria-label="Reach Deck 生成阶段"]')).toBeNull();
  });

  it('checks the backend and confirms the whole-deck narration overwrite choice', async () => {
    const onInspectAllNarration = vi.fn().mockResolvedValue({
      hasExistingNarration: true,
      hasInFlightNarration: false,
    });
    const onRegenerateAllNarration = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [];
    panelProps.onInspectAllNarration = onInspectAllNarration;
    panelProps.onRegenerateAllNarration = onRegenerateAllNarration;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={({ commandBar }) => <div>{commandBar}</div>}
            materialized
            moduleTitle="讲稿批量生成"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const menu = await openDeckMenu();
    const actions = [...menu.querySelectorAll('button')].filter(
      (button) => button.getAttribute('aria-label') === '重新生成所有讲稿、音频和动画',
    );
    expect(actions).toHaveLength(1);
    const action = actions[0];
    await act(async () => action?.click());
    expect(onInspectAllNarration).toHaveBeenCalledTimes(1);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('重新生成所有讲稿、音频和动画？');
    expect(dialog?.textContent).toContain('幻灯片页面重新生成讲稿、音频和讲稿动画');
    const overwrite = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(overwrite).not.toBeNull();
    await act(async () => overwrite?.click());
    await act(async () =>
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onRegenerateAllNarration).toHaveBeenCalledWith({ overwriteExisting: true });
  });

  it.each([true, false] as const)(
    'confirms text-only whole-deck narration (existing narration: %s) and sends textOnly',
    async (hasExistingNarration) => {
      const onInspectAllNarration = vi.fn().mockResolvedValue({
        hasExistingNarration,
        hasInFlightNarration: false,
      });
      const onRegenerateAllNarration = vi.fn();
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = {
        ...generatingWorkspaceWithPlan(),
        stage: 'complete',
      } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
      panelProps.jobs = [];
      panelProps.onInspectAllNarration = onInspectAllNarration;
      panelProps.onRegenerateAllNarration = onRegenerateAllNarration;
      await act(async () => {
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={({ commandBar }) => <div>{commandBar}</div>}
              materialized
              moduleTitle="讲稿批量生成"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        );
      });

      const menu = await openDeckMenu();
      const action = menu.querySelector<HTMLButtonElement>(
        'button[aria-label="仅重新生成所有讲稿"]',
      );
      expect(action).not.toBeNull();
      await act(async () => action?.click());
      expect(onInspectAllNarration).toHaveBeenCalledTimes(1);
      const dialog = document.querySelector('[role="alertdialog"]');
      expect(dialog?.textContent).toContain('仅重新生成所有讲稿？');
      expect(dialog?.textContent).toContain('幻灯片页面');
      expect(dialog?.textContent).toContain('不合成音频、不生成讲稿动画');
      expect(dialog?.textContent).toContain('现有音频和讲稿动画将被清除');
      const overwrite = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(overwrite != null).toBe(hasExistingNarration);
      if (hasExistingNarration) await act(async () => overwrite?.click());
      await act(async () =>
        [...(dialog?.querySelectorAll('button') ?? [])]
          .find((button) => button.textContent?.trim() === '继续')
          ?.click(),
      );
      expect(onRegenerateAllNarration).toHaveBeenCalledWith({
        // 有已有讲稿时勾选了覆盖；没有时不出现勾选框，沿用缺省 false。
        overwriteExisting: hasExistingNarration,
        textOnly: true,
      });
    },
  );

  it('expands partial generation inline without closing the deck menu', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [];
    panelProps.onInspectAllNarration = vi.fn().mockResolvedValue({
      hasExistingNarration: false,
      hasInFlightNarration: false,
    });
    panelProps.onRegenerateAllNarration = vi.fn();
    panelProps.onGenerateAllAudio = vi.fn();
    panelProps.onRegenerateAllAnimations = vi.fn();
    panelProps.onRegenerateAllMedia = vi.fn();
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={({ commandBar }) => <div>{commandBar}</div>}
            materialized
            moduleTitle="Deck"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    const menu = await openDeckMenu();
    const [first, toggle] = [...menu.firstElementChild!.children] as HTMLElement[];
    expect(first?.getAttribute('aria-label')).toBe('重新生成所有讲稿、音频和动画');
    expect(toggle?.textContent).toBe('更多部分生成');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    const group = document.getElementById(toggle!.getAttribute('aria-controls')!)!;
    expect(group.hidden).toBe(true);
    expect(
      [...group.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
    ).toEqual(['仅重新生成所有讲稿', '全部生成音频', '重新生成所有动画', '重新生成所有音频和动画']);

    await act(async () => toggle!.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(group.hidden).toBe(false);
    expect(menu.isConnected).toBe(true);

    await act(async () =>
      group.querySelector<HTMLButtonElement>('button[aria-label="全部生成音频"]')!.click(),
    );
    expect(menu.isConnected).toBe(false);
    const reopened = await openDeckMenu();
    const reopenedToggle = reopened.querySelector('[aria-expanded]');
    expect(reopenedToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(reopenedToggle!.getAttribute('aria-controls')!)?.hidden).toBe(
      true,
    );
  });

  it.each([
    ['zh-CN', '重新生成所有音频和动画', '继续'],
    ['en-US', 'Regenerate all audio and animations', 'Continue'],
  ] as const)('confirms media-only regeneration in %s', async (locale, label, confirm) => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = { ...generatingWorkspaceWithPlan(), stage: 'complete' } as NonNullable<
      ReachDeckGenerationPanelProps['workspace']
    >;
    panelProps.jobs = [];
    panelProps.onRegenerateAllMedia = vi.fn();
    await act(async () =>
      root.render(
        <PortalI18nProvider locale={locale}>
          <ReachDeckAuthoringFlow
            editor={({ commandBar }) => <div>{commandBar}</div>}
            materialized
            moduleTitle="Deck"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    const menu = await openDeckMenu(locale === 'zh-CN' ? '整份课件操作' : 'Deck actions');
    const action = [...menu.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === label,
    );
    expect(action).toBeDefined();
    await act(async () => action?.click());
    expect(panelProps.onRegenerateAllMedia).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.querySelector('input')).toBeNull();
    await act(async () =>
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === confirm)
        ?.click(),
    );
    expect(panelProps.onRegenerateAllMedia).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'zh-CN',
      '全部生成音频',
      '整份课件操作',
      '迁移现有动画到新语音',
      '重新生成动画',
      '动画处理方式',
      '取消',
      '生成音频',
    ],
    [
      'en-US',
      'Generate audio for all pages',
      'Deck actions',
      'Migrate existing animations to new speech',
      'Regenerate animations',
      'Animation handling',
      'Cancel',
      'Generate audio',
    ],
  ] as const)(
    'selects and confirms audio animation handling in %s',
    async (
      locale,
      label,
      menuLabel,
      preserveLabel,
      regenerateLabel,
      groupLabel,
      cancel,
      confirm,
    ) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = { ...generatingWorkspaceWithPlan(), stage: 'complete' } as NonNullable<
        ReachDeckGenerationPanelProps['workspace']
      >;
      panelProps.jobs = [];
      const generate = vi.fn();
      panelProps.onGenerateAllAudio = generate;
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              editor={({ commandBar }) => <div>{commandBar}</div>}
              materialized
              moduleTitle="Deck"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      const open = async () => {
        const menu = await openDeckMenu(menuLabel);
        await act(async () =>
          menu.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
        );
        return document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      };
      const clickButton = async (dialog: HTMLElement, text: string) => {
        await act(async () =>
          [...dialog.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === text)!
            .click(),
        );
      };
      const radio = (dialog: HTMLElement, label: string) =>
        [...dialog.querySelectorAll<HTMLLabelElement>('label')]
          .find((item) => item.textContent?.includes(label))!
          .querySelector<HTMLInputElement>('input[type="radio"]')!;
      let dialog = await open();
      const groupLabelId = dialog
        .querySelector('[role="radiogroup"]')
        ?.getAttribute('aria-labelledby');
      expect(document.getElementById(groupLabelId!)?.textContent).toBe(groupLabel);
      expect(radio(dialog, preserveLabel).checked).toBe(true);
      expect(generate).not.toHaveBeenCalled();
      await clickButton(dialog, confirm);
      expect(generate).toHaveBeenLastCalledWith({ animationMode: 'preserve' });

      dialog = await open();
      await act(async () => radio(dialog, regenerateLabel).click());
      expect(radio(dialog, regenerateLabel).checked).toBe(true);
      await clickButton(dialog, confirm);
      expect(generate).toHaveBeenLastCalledWith({ animationMode: 'regenerate' });

      dialog = await open();
      expect(radio(dialog, preserveLabel).checked).toBe(true);
      await act(async () => radio(dialog, regenerateLabel).click());
      await clickButton(dialog, cancel);
      expect(generate).toHaveBeenCalledTimes(2);
      dialog = await open();
      expect(radio(dialog, preserveLabel).checked).toBe(true);
      await clickButton(dialog, cancel);
    },
  );

  it.each([
    ['zh-CN', '整份课件操作', '全部生成音频', '生成音频', '取消', '操作失败'],
    [
      'en-US',
      'Deck actions',
      'Generate audio for all pages',
      'Generate audio',
      'Cancel',
      'operation failed',
    ],
  ] as const)(
    'keeps audio options through pending submission and failure in %s',
    async (locale, menuLabel, label, confirm, cancel, error) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = { ...generatingWorkspaceWithPlan(), stage: 'complete' } as NonNullable<
        ReachDeckGenerationPanelProps['workspace']
      >;
      panelProps.jobs = [];
      let reject!: (error: Error) => void;
      const generate = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, rejectPromise) => {
              reject = rejectPromise;
            }),
        )
        .mockResolvedValue(undefined);
      panelProps.onGenerateAllAudio = generate;
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              editor={({ commandBar }) => <div>{commandBar}</div>}
              materialized
              moduleTitle="Deck"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      const menu = await openDeckMenu(menuLabel);
      await act(async () =>
        menu.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
      );
      const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      const confirmButton = [...dialog.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === confirm,
      )!;
      const cancelButton = [...dialog.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === cancel,
      )!;
      const regenerate = dialog.querySelector<HTMLInputElement>('input[value="regenerate"]')!;
      await act(async () => regenerate.click());
      await act(async () => {
        confirmButton.click();
        confirmButton.click();
      });
      expect(generate).toHaveBeenCalledOnce();
      expect(confirmButton.disabled).toBe(true);
      expect(cancelButton.disabled).toBe(true);
      expect(regenerate.disabled).toBe(true);
      expect(confirmButton.getAttribute('aria-busy')).toBe('true');
      await act(async () => fireEvent.keyDown(dialog, { key: 'Escape' }));
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      await act(async () => reject(new Error('private provider failure')));
      expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(error);
      expect(dialog.textContent).not.toContain('private provider failure');
      expect(regenerate.checked).toBe(true);
      expect(regenerate.disabled).toBe(false);
      expect(confirmButton.disabled).toBe(false);
      await act(async () => confirmButton.click());
      expect(generate).toHaveBeenLastCalledWith({ animationMode: 'regenerate' });
      expect(generate).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'resumes pending audio modes after failure and reopening in %s',
    async (locale) => {
      const zh = locale === 'zh-CN';
      const panelProps = createPanelProps(vi.fn());
      panelProps.workspace = { ...generatingWorkspaceWithPlan(), stage: 'complete' } as NonNullable<
        ReachDeckGenerationPanelProps['workspace']
      >;
      panelProps.jobs = [];
      const render = async () =>
        act(async () =>
          root.render(
            <PortalI18nProvider locale={locale}>
              <ReachDeckAuthoringFlow
                editor={({ commandBar }) => <div>{commandBar}</div>}
                materialized
                moduleTitle="Deck"
                panelProps={panelProps}
              />
            </PortalI18nProvider>,
          ),
        );
      const open = async () => {
        const menu = await openDeckMenu(zh ? '整份课件操作' : 'Deck actions');
        await act(async () =>
          menu
            .querySelector<HTMLButtonElement>(
              `button[aria-label="${zh ? '全部生成音频' : 'Generate audio for all pages'}"]`,
            )!
            .click(),
        );
        return document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      };
      const click = async (dialog: HTMLElement, label: string) =>
        act(async () =>
          [...dialog.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === label)!
            .click(),
        );
      for (const mode of ['preserve', 'regenerate', 'skip'] as const) {
        const generate = vi
          .fn()
          .mockRejectedValueOnce(new Error('Lost response'))
          .mockResolvedValue(undefined);
        panelProps.onGenerateAllAudio = generate;
        panelProps.pendingMediaAnimationMode = mode;
        await render();
        let dialog = await open();
        expect(dialog.querySelector<HTMLInputElement>(`input[value="${mode}"]`)?.checked).toBe(
          true,
        );
        expect(
          [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(
            (input) => input.disabled,
          ),
        ).toBe(true);
        if (mode === 'skip')
          expect(dialog.textContent).toContain(zh ? '清空动画' : 'clear animations');
        await click(dialog, zh ? '重试生成' : 'Retry generation');
        expect(dialog.querySelector('[role="alert"]')).not.toBeNull();
        await click(dialog, zh ? '取消' : 'Cancel');
        dialog = await open();
        expect(dialog.querySelector<HTMLInputElement>(`input[value="${mode}"]`)?.checked).toBe(
          true,
        );
        await click(dialog, zh ? '重试生成' : 'Retry generation');
        expect(generate.mock.calls).toEqual([[{ animationMode: mode }], [{ animationMode: mode }]]);
        generate.mockImplementationOnce(() => {
          panelProps.pendingMediaAnimationMode = undefined;
          return Promise.reject(new Error('Definitive rejection'));
        });
        dialog = await open();
        await click(dialog, zh ? '重试生成' : 'Retry generation');
        const nextMode = mode === 'skip' ? 'preserve' : mode;
        expect(dialog.querySelector('[role="alert"]')).not.toBeNull();
        expect(dialog.querySelector<HTMLInputElement>(`input[value="${nextMode}"]`)?.checked).toBe(
          true,
        );
        expect(dialog.querySelector<HTMLInputElement>(`input[value="${nextMode}"]`)?.disabled).toBe(
          false,
        );
        expect(dialog.querySelector('input[value="skip"]')).toBeNull();
        await click(dialog, zh ? '生成音频' : 'Generate audio');
        expect(generate).toHaveBeenLastCalledWith({ animationMode: nextMode });
      }
      panelProps.pendingMediaAnimationMode = 'animations';
      await render();
      let dialog = await open();
      expect(dialog.textContent).toContain(zh ? '重新生成所有动画' : 'Regenerate all animations');
      expect(
        [...dialog.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === (zh ? '重试生成' : 'Retry generation'),
        )?.disabled,
      ).toBe(true);
      await click(dialog, zh ? '取消' : 'Cancel');
      panelProps.pendingMediaAnimationMode = undefined;
      await render();
      dialog = await open();
      expect(dialog.querySelector<HTMLInputElement>('input[value="preserve"]')?.checked).toBe(true);
      expect(dialog.querySelector('input[value="skip"]')).toBeNull();
      expect(dialog.querySelector<HTMLInputElement>('input[value="regenerate"]')?.disabled).toBe(
        false,
      );
      await click(dialog, zh ? '取消' : 'Cancel');
    },
  );

  it.each([
    ['audio', '全部生成音频'],
    ['animations', '重新生成所有动画'],
  ] as const)('keeps the whole-deck %s action in the studio command menu', async (mode, label) => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = { ...generatingWorkspaceWithPlan(), stage: 'complete' } as NonNullable<
      ReachDeckGenerationPanelProps['workspace']
    >;
    panelProps.jobs = [];
    const actionHandler = vi.fn();
    if (mode === 'audio') panelProps.onGenerateAllAudio = actionHandler;
    else panelProps.onRegenerateAllAnimations = actionHandler;
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={({ commandBar }) => <div>{commandBar}</div>}
            materialized
            moduleTitle="Deck"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );

    const menu = await openDeckMenu();
    const action = menu.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(action).not.toBeNull();
    await act(async () => action?.click());
    const dialog = document.querySelector('[role="alertdialog"]');
    await act(async () =>
      [...(dialog?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === (mode === 'audio' ? '生成音频' : '继续'))
        ?.click(),
    );
    expect(actionHandler).toHaveBeenCalledOnce();
  });

  it('uses the studio chrome geometry instead of the stage banner on the first stage', async () => {
    const onSave = vi.fn();
    const onPublish = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            backHref="/teacher/courses/course-1"
            documentActions={{ disabled: false, onPublish, onSave, onTrial: vi.fn() }}
            editor={null}
            materialized={false}
            moduleTitle="紧凑教学需求"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const compactHeader = host.querySelector('header');
    expect(compactHeader?.querySelector('a[aria-label="返回课程"]')).not.toBeNull();
    expect(compactHeader?.textContent).toContain('紧凑教学需求');
    expect(compactHeader?.querySelector('ol[aria-label="Reach Deck 生成阶段"]')).toBeNull();
    expect(host.querySelector('form > label')).toBeNull();
    expect(host.querySelector('[aria-label="主题、材料或教学要求"]')).not.toBeNull();

    const stageTrigger = compactHeader?.querySelector<HTMLButtonElement>(
      'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"]',
    );
    expect(stageTrigger?.textContent).toContain('01 · 教学需求');
    expect(
      [...(compactHeader?.querySelectorAll('button') ?? [])].some(
        (button) => button.textContent?.trim() === '保存',
      ),
    ).toBe(true);
    expect(compactHeader?.textContent).not.toContain('发布');

    await act(async () => stageTrigger?.click());
    const compactStageList = window.document.querySelector<HTMLElement>('[role="listbox"]');
    expect(compactStageList?.dataset.portal).toBe('true');
    expect(compactStageList?.classList.contains(styles.studioStepSelectList)).toBe(true);
    expect(compactStageList?.querySelectorAll('[role="option"]')).toHaveLength(4);
    expect(onSave).not.toHaveBeenCalled();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('uses compact chrome with save and no publish while reviewing planning stages', async () => {
    const onSave = vi.fn();
    const onPublish = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            documentActions={{ disabled: false, onPublish, onSave, onTrial: vi.fn() }}
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(
      host.querySelector('[data-workbench-toolbar] [aria-label="Reach Deck 生成阶段"]')
        ?.textContent,
    ).toContain('Deck 工作台');
    expect(host.querySelector('[aria-label="逐页生成工作台"]')).toBeNull();

    await selectFlowStage('教学设计');

    for (const expected of ['02 · 教学设计', '03 · 分页大纲']) {
      const compactStageTrigger = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Reach Deck 生成阶段"][aria-haspopup="listbox"]',
      );
      expect(compactStageTrigger?.textContent).toContain(expected);
      expect(host.querySelector('ol[aria-label="Reach Deck 生成阶段"]')).toBeNull();
      const save = [...host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '保存',
      );
      const publish = [...host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '发布',
      );
      expect(save).toBeDefined();
      expect(publish).toBeUndefined();

      if (expected.startsWith('02')) {
        await act(async () => compactStageTrigger?.click());
        const outlineOption = [
          ...window.document.querySelectorAll<HTMLElement>('[role="option"]'),
        ].find((option) => option.textContent?.includes('分页大纲'));
        await act(async () => {
          outlineOption?.click();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        });
      }
    }

    expect(onPublish).not.toHaveBeenCalled();
  });

  it('enables publish in the fourth stage only after every page is complete', async () => {
    const onSave = vi.fn();
    const onPublish = vi.fn();
    const onTrial = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = generatingWorkspaceWithPlan();
    panelProps.jobs = [];

    const renderFlow = async (materialized: boolean) => {
      await act(async () => {
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              documentActions={{ disabled: false, onPublish, onSave, onTrial }}
              editor={null}
              materialized={materialized}
              moduleTitle="并发控制"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        );
      });
    };

    await renderFlow(false);
    let publish = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '发布',
    );
    expect(publish?.getAttribute('aria-disabled')).toBe('true');
    expect(publish?.title).toBe('所有页面生成完成后可发布');
    let trial = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '试学',
    );
    expect(trial?.getAttribute('aria-disabled')).toBe('true');
    expect(trial?.title).toBe('整套页面生成完成后可试学');
    await act(async () => publish?.click());
    await act(async () => trial?.click());
    expect(onPublish).not.toHaveBeenCalled();
    expect(onTrial).not.toHaveBeenCalled();

    const generationIdentity = {
      runId: panelProps.workspace.statuses['page-1'].runId,
      pageId: panelProps.workspace.statuses['page-1'].pageId,
      requestedRevision: panelProps.workspace.statuses['page-1'].requestedRevision,
      attempt: panelProps.workspace.statuses['page-1'].attempt,
    };
    panelProps.workspace = {
      ...panelProps.workspace,
      stage: 'complete',
      statuses: {
        ...panelProps.workspace.statuses,
        'page-1': {
          ...generationIdentity,
          state: 'ready',
          sceneId: 'scene-page-1',
          completedAt: '2026-08-16T00:00:00.000Z',
        },
      },
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    await renderFlow(true);
    publish = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '发布',
    );
    expect(publish?.disabled).toBe(false);
    trial = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '试学',
    );
    expect(trial?.disabled).toBe(false);
    expect(trial?.compareDocumentPosition(publish!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await act(async () => trial?.click());
    await act(async () => publish?.click());
    expect(onTrial).toHaveBeenCalledOnce();
    expect(onPublish).toHaveBeenCalledOnce();

    panelProps.workspace = {
      ...panelProps.workspace,
      statuses: {
        ...panelProps.workspace.statuses,
        'page-1': {
          ...generationIdentity,
          state: 'generating',
          startedAt: '2026-08-16T00:01:00.000Z',
        },
      },
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    await renderFlow(true);
    trial = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '试学',
    );
    publish = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '发布',
    );
    expect(trial?.getAttribute('aria-disabled')).toBe('true');
    expect(publish?.getAttribute('aria-disabled')).toBe('true');
  });

  it('enables trial and publish for a materialized marketplace copy', async () => {
    const onTrial = vi.fn();
    const onPublish = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = marketplaceCopyWorkspace();
    panelProps.jobs = [];
    panelProps.onStartLessonPlan = vi.fn();
    panelProps.onStartPageOutline = vi.fn();

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            documentActions={{ disabled: false, onPublish, onSave: vi.fn(), onTrial }}
            editor={null}
            materialized
            moduleTitle="市场复制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const trial = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '试学',
    );
    const publish = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '发布',
    );
    expect(trial?.disabled).toBe(false);
    expect(publish?.disabled).toBe(false);
    await act(async () => trial?.click());
    expect(onTrial).toHaveBeenCalledOnce();
    expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
    expect(panelProps.onStartPageOutline).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'leaves missing copied stages empty without generation in %s',
    async (locale) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.onStartLessonPlan = vi.fn();
      panelProps.onStartPageOutline = vi.fn();
      panelProps.workspace = { ...marketplaceCopyWorkspace(), stage: 'copied', source: '' };
      panelProps.sourceDraft = '';
      panelProps.jobs = [
        {
          jobId: 'legacy-unrelated-plan',
          kind: 'lesson-plan',
          status: 'completed',
          done: true,
          candidate: { ...outlineWorkspace().lessonPlan!, title: 'Unrelated platform guide' },
        },
        {
          jobId: 'legacy-unrelated-outline',
          kind: 'page-outline',
          status: 'completed',
          done: true,
          candidate: { ...outlineWorkspace().pagedOutline!, title: 'Unrelated outline' },
        },
      ];
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              editor={<div data-copied-studio />}
              materialized
              moduleTitle="Copied biology"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      expect(host.querySelector('[data-copied-studio]')).not.toBeNull();
      await selectFlowStage(locale === 'zh-CN' ? '教学设计' : 'Lesson design');
      expect(host.textContent).toContain(
        locale === 'zh-CN' ? '暂无已保存的教学设计' : 'No saved lesson plan',
      );
      expect(host.textContent).not.toContain('Unrelated platform guide');
      expect(host.querySelector('[role="status"]')).toBeNull();
      await selectFlowStage(locale === 'zh-CN' ? '分页大纲' : 'Page outline');
      expect(host.textContent).toContain(
        locale === 'zh-CN' ? '暂无已保存的分页大纲' : 'No saved page outline',
      );
      expect(host.textContent).not.toContain('Unrelated outline');
      expect(host.querySelector('[role="status"]')).toBeNull();
      await selectFlowStage(locale === 'zh-CN' ? '教学需求' : 'Teaching brief');
      expect(host.textContent).not.toContain('marketplace-copy');
      expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
      expect(panelProps.onStartPageOutline).not.toHaveBeenCalled();
    },
  );

  it.each(['lessonPlan', 'stagedLessonPlan'] as const)(
    'shows an explicit outline candidate for a blank copied brief with %s',
    async (planField) => {
      const panelProps = createPanelProps(vi.fn());
      panelProps.onStartLessonPlan = vi.fn();
      panelProps.onStartPageOutline = vi.fn();
      panelProps.onAdoptPageOutline = vi.fn();
      const saved = outlineWorkspace();
      const baseDocument = marketplaceCopyWorkspace().baseDocument;
      panelProps.workspace = {
        ...marketplaceCopyWorkspace(),
        stage: 'copied',
        source: '',
        [planField]: saved.lessonPlan,
      };
      panelProps.sourceDraft = '';
      const candidate = {
        ...saved.pagedOutline!,
        id: 'explicit-copied-outline',
        pages: saved.pagedOutline!.pages.map((page) => ({
          ...page,
          title: `Explicit copied ${page.title}`,
        })),
      };
      panelProps.jobs = [
        {
          jobId: 'explicit-copied-outline-job',
          kind: 'page-outline',
          status: 'completed',
          done: true,
          candidate,
        },
        {
          jobId: 'unrelated-copied-plan-job',
          kind: 'lesson-plan',
          status: 'completed',
          done: true,
          candidate: { ...saved.lessonPlan!, title: 'Unrelated copied plan' },
        },
      ];
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={null}
              materialized
              moduleTitle="Copied biology"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      await selectFlowStage('教学设计');
      expect(host.querySelector<HTMLInputElement>('[aria-label="教学设计标题"]')?.value).toBe(
        saved.lessonPlan?.title,
      );
      expect(host.textContent).not.toContain('Unrelated copied plan');
      await selectFlowStage('分页大纲');
      expect(host.textContent).toContain(candidate.pages[0].title);
      const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '生成下一步',
      );
      expect(continueButton?.disabled).toBe(false);
      await act(async () => continueButton?.click());
      expect(panelProps.onAdoptPageOutline).toHaveBeenCalledWith(
        expect.objectContaining({ id: candidate.id }),
        'explicit-copied-outline-job',
      );
      expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
      expect(panelProps.onStartPageOutline).not.toHaveBeenCalled();
      expect(panelProps.workspace.baseDocument).toEqual(baseDocument);
    },
  );

  it('shows saved copied brief, lesson design and outline without starting generation', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.onStartLessonPlan = vi.fn();
    panelProps.onStartPageOutline = vi.fn();
    const saved = outlineWorkspace();
    panelProps.workspace = {
      ...marketplaceCopyWorkspace(),
      stage: 'copied',
      source: 'Teach photosynthesis',
      lessonPlan: saved.lessonPlan,
      pagedOutline: saved.pagedOutline,
    };
    panelProps.sourceDraft = panelProps.workspace.source;
    panelProps.jobs = [];
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized
            moduleTitle="Copied biology"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    await selectFlowStage('教学设计');
    expect(host.querySelector<HTMLInputElement>('[aria-label="教学设计标题"]')?.value).toBe(
      saved.lessonPlan?.title,
    );
    await selectFlowStage('分页大纲');
    expect(host.textContent).toContain(saved.pagedOutline!.pages[0].title);
    await selectFlowStage('教学需求');
    expect(host.textContent).toContain('Teach photosynthesis');
    expect(panelProps.onStartLessonPlan).not.toHaveBeenCalled();
    expect(panelProps.onStartPageOutline).not.toHaveBeenCalled();
  });

  it('keeps a marketplace copy gated until its base document has landed', async () => {
    const onTrial = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    const { baseDocument: _unlanded, ...withoutBaseDocument } = marketplaceCopyWorkspace();
    panelProps.workspace = withoutBaseDocument as unknown as NonNullable<
      ReachDeckGenerationPanelProps['workspace']
    >;
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            documentActions={{ disabled: false, onPublish: vi.fn(), onSave: vi.fn(), onTrial }}
            editor={null}
            materialized
            moduleTitle="市场复制未落地"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const trial = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '试学',
    );
    expect(trial?.getAttribute('aria-disabled')).toBe('true');
    expect(trial?.title).toBe('整套页面生成完成后可试学');
    await act(async () => trial?.click());
    expect(onTrial).not.toHaveBeenCalled();
  });

  it('locks all document actions while trial is preparing', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            documentActions={{
              busy: 'trial',
              disabled: false,
              onPublish: vi.fn(),
              onSave: vi.fn(),
              onTrial: vi.fn(),
            }}
            editor={({ commandBar }) => <div data-command-bar>{commandBar}</div>}
            materialized
            moduleTitle="试学互斥"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const actionButtons = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-workbench-toolbar] button'),
    ].filter((button) =>
      ['试学', '正在保存并进入试学…', '保存', '发布'].includes(
        button.getAttribute('aria-label') ?? '',
      ),
    );
    expect(actionButtons).toHaveLength(3);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    expect(actionButtons[0]?.getAttribute('aria-label')).toBe('正在保存并进入试学…');
    expect(actionButtons[0]?.getAttribute('aria-busy')).toBe('true');
    expect(actionButtons[0]?.querySelector('.rx-brand-loader-sm')).not.toBeNull();
    expect(actionButtons[0]?.querySelectorAll('.rx-brand-loader-stroke')).toHaveLength(3);
  });

  it('keeps pending studio actions focusable with a visible reason and blocks activation', async () => {
    const onTrial = vi.fn();
    const onPublish = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    const { baseDocument: _unlanded, ...withoutBaseDocument } = marketplaceCopyWorkspace();
    panelProps.workspace = withoutBaseDocument as NonNullable<
      ReachDeckGenerationPanelProps['workspace']
    >;
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            documentActions={{ disabled: false, onPublish, onSave: vi.fn(), onTrial }}
            editor={({ commandBar }) => <div data-command-bar>{commandBar}</div>}
            materialized
            moduleTitle="等待生成"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    for (const label of ['试学', '发布']) {
      const button = host.querySelector<HTMLButtonElement>(
        `[data-workbench-toolbar] button[aria-label="${label}"]`,
      );
      expect(button?.disabled).toBe(false);
      expect(button?.getAttribute('aria-disabled')).toBe('true');
      await act(async () => button?.focus());
      const hintId = button?.getAttribute('aria-describedby');
      expect(hintId).toBeTruthy();
      const tooltip = document.getElementById(hintId!);
      expect(tooltip?.getAttribute('role')).toBe('tooltip');
      expect(tooltip?.textContent).toBe(
        label === '试学' ? '整套页面生成完成后可试学' : '所有页面生成完成后可发布',
      );
      // Portal + fixed positioning escape the toolbar's horizontal scroll clipping.
      expect(host.querySelector('[data-workbench-toolbar]')?.contains(tooltip)).toBe(false);
      expect(host.contains(tooltip)).toBe(false);
      expect(tooltip?.style.position).toBe('fixed');
      await act(async () => button?.click());
    }
    expect(onTrial).not.toHaveBeenCalled();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('shows a spinner and busy name while publishing from the studio command bar', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            documentActions={{
              busy: 'publish',
              disabled: false,
              onPublish: vi.fn(),
              onSave: vi.fn(),
              onTrial: vi.fn(),
            }}
            editor={({ commandBar }) => <div data-command-bar>{commandBar}</div>}
            materialized
            moduleTitle="发布中"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    const publish = host.querySelector<HTMLButtonElement>(
      '[data-workbench-toolbar] button[aria-label="发布中…"]',
    );
    expect(publish?.disabled).toBe(true);
    expect(publish?.getAttribute('aria-busy')).toBe('true');
    expect(publish?.querySelector('.rx-brand-loader-sm')).not.toBeNull();
    expect(publish?.querySelectorAll('.rx-brand-loader-stroke')).toHaveLength(3);
  });

  it('localizes studio controls, generation issues, and recovery copy in English', async () => {
    const panelProps = createPanelProps(vi.fn());
    const workspace = generatingWorkspaceWithPlan();
    panelProps.workspace = {
      ...workspace,
      // 页仍处于 failed(未经新任务落地):失败 job 的重试横幅应当出现。
      statuses: {
        'page-1': {
          state: 'failed',
          retryable: true,
          runId: 'run-1',
          pageId: 'page-1',
          requestedRevision: 1,
          attempt: 1,
          message: '生成失败',
          failedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        done: true,
        error: 'Generation failed',
        jobId: 'job-page-1',
        kind: 'page-generation',
        pageId: 'page-1',
        status: 'failed',
      },
    ];

    const renderFlow = async (materialized: boolean) => {
      await act(async () => {
        root.render(
          <PortalI18nProvider locale="en-US">
            <ReachDeckAuthoringFlow
              documentActions={{
                disabled: false,
                onPublish: vi.fn(),
                onSave: vi.fn(),
                onTrial: vi.fn(),
              }}
              editor={null}
              materialized={materialized}
              moduleTitle="并发控制"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        );
      });
    };

    await renderFlow(false);
    expect(host.querySelector('[aria-label="Generation issues"]')).toBeNull();
    expect(host.textContent).toContain('Save');
    const publish = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Publish',
    );
    expect(publish?.title).toBe('Finish generating all pages before publishing');

    panelProps.workspace = {
      ...panelProps.workspace,
      stage: 'complete',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [];
    panelProps.materializedPreviewAvailable = false;
    await renderFlow(true);
    expect(host.textContent).toContain(
      'The courseware is materialized, but the editable document has not loaded.',
    );
    expect(host.textContent).toContain('Reload');
  });

  it('keeps retry actions visible after placeholder materialization', async () => {
    // v2 占位物化在分页回合开始就发生,materialized 全程为 true;
    // failed 页的补救按钮不能被物化状态隐藏。
    // 已物化的占位文档不改变失败页的恢复入口。
    const panelProps = createPanelProps(vi.fn());
    const workspace = generatingWorkspaceWithPlan();
    panelProps.workspace = {
      ...workspace,
      // 页仍处于 failed(未经新任务落地):物化状态不应隐藏失败重试按钮。
      statuses: {
        'page-1': {
          state: 'failed',
          retryable: true,
          runId: 'run-1',
          pageId: 'page-1',
          requestedRevision: 1,
          attempt: 1,
          message: '生成失败',
          failedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.jobs = [
      {
        done: true,
        error: 'Generation failed',
        jobId: 'job-page-1',
        kind: 'page-generation',
        pageId: 'page-1',
        status: 'failed',
      },
    ];

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            documentActions={{
              disabled: false,
              onPublish: vi.fn(),
              onSave: vi.fn(),
              onTrial: vi.fn(),
            }}
            editor={null}
            materialized={true}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });

    expect(host.querySelector('[aria-label="Generation issues"]')).toBeNull();
  });

  it('opens an earlier stage, edits its tabbed design, and adopts it over later generation', async () => {
    const onAdoptLessonPlan = vi.fn();
    const onRestartPlanningStage = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.workspace = generatingWorkspaceWithPlan();
    panelProps.jobs = [];
    panelProps.onAdoptLessonPlan = onAdoptLessonPlan;
    panelProps.onRestartPlanningStage = onRestartPlanningStage;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="并发控制"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('教学设计');
    const lessonScreen = host.querySelector('[aria-label="总体教学设计"]');
    expect(lessonScreen).not.toBeNull();
    expect(lessonScreen?.querySelector(':scope > header')).toBeNull();
    expect(lessonScreen?.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(lessonScreen?.textContent).not.toContain('还想让 AI 调整什么');

    // 学习者使用多行输入；页面类型位于左栏底部并使用无复选框的图标切换胶囊。
    expect(lessonScreen?.querySelector<HTMLTextAreaElement>('[aria-label="教学对象"]')?.rows).toBe(
      3,
    );
    const scenePicker = lessonScreen?.querySelector<HTMLElement>('[aria-label="页面类型"]');
    expect(scenePicker).not.toBeNull();
    expect(scenePicker?.querySelector('input[type="checkbox"]')).toBeNull();
    const sceneButtons = [
      ...(scenePicker?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]') ?? []),
    ];
    expect(sceneButtons).toHaveLength(3);
    expect(sceneButtons[0]).toMatchObject({ disabled: true });
    expect(sceneButtons[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(sceneButtons[1]).toMatchObject({ disabled: false });
    expect(sceneButtons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(sceneButtons[2]).toMatchObject({ disabled: false });
    expect(sceneButtons[2]?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => sceneButtons[1]?.click());
    expect(sceneButtons[1]?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => sceneButtons[1]?.click());
    expect(sceneButtons[1]?.getAttribute('aria-pressed')).toBe('true');

    const title = lessonScreen?.querySelector<HTMLInputElement>('[aria-label="教学设计标题"]');
    await act(async () => {
      if (title === null || title === undefined) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        title,
        '修改后的水足迹调查课',
      );
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const adopt = [...(lessonScreen?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '生成下一步',
    );
    const regenerate = [...(lessonScreen?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '重新生成教学设计',
    );
    expect(adopt?.closest('footer')).not.toBeNull();
    expect(regenerate?.closest('footer')).not.toBeNull();
    await act(async () => adopt?.click());
    expect(onAdoptLessonPlan).toHaveBeenCalledWith(
      expect.objectContaining({ title: '修改后的水足迹调查课' }),
      {
        enabledSceneTypes: expect.arrayContaining(['slide', 'quiz', 'interactive']),
      },
    );
    const adoptedSceneTypes = onAdoptLessonPlan.mock.calls[0]?.[1]?.enabledSceneTypes;
    expect([...(adoptedSceneTypes ?? [])].sort()).toEqual(['interactive', 'quiz', 'slide']);
    await act(async () => regenerate?.click());
    expect(onRestartPlanningStage).toHaveBeenCalledWith('lesson-plan');
  });

  it.each([
    { locale: 'zh-CN' as const, tab: '知识点', heading: '目标理解', accept: '生成下一步' },
    {
      locale: 'en-US' as const,
      tab: 'Knowledge points',
      heading: 'Target understanding',
      accept: 'Generate next step',
    },
  ])(
    'shows knowledge points in $locale and preserves their contracts when adopting the lesson',
    async ({ locale, tab, heading, accept }) => {
      const plan = knowledgeLessonPlan();
      const onAdoptLessonPlan = vi.fn();
      const panelProps = createPanelProps(vi.fn());
      panelProps.jobs = [];
      panelProps.onAdoptLessonPlan = onAdoptLessonPlan;
      panelProps.workspace = {
        ...generatingWorkspaceWithPlan(),
        stage: 'lesson-plan',
        lessonPlan: plan,
      };

      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="水足迹"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      const knowledgeTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (button) => button.textContent === tab,
      );
      expect(knowledgeTab).toBeDefined();
      await act(async () => knowledgeTab?.click());
      const list = host.querySelector(`ol[aria-label="${tab}"]`);
      expect(list?.textContent).toContain('隐含用水');
      expect(list?.textContent).toContain('理解水足迹');
      expect(list?.textContent).toContain('读懂用水数据');
      // Objective evidence has one editor in Goals, rather than a second read-only copy here.
      expect(list?.textContent).not.toContain('列出食物生产中的用水环节');
      expect(list?.textContent).toContain('区分直接用水与隐含用水');
      expect(list?.textContent).toContain('用证据解释一件商品的水足迹');
      expect(list?.textContent).toContain(heading);
      expect(list?.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
      const pointTitle = list?.querySelector<HTMLInputElement>('input');
      let firstItem = list?.querySelector<HTMLTextAreaElement>('textarea');
      expect(pointTitle?.value).toBe('隐含用水');
      expect(firstItem?.value).toBe('区分直接用水与隐含用水');
      expect(list?.querySelectorAll('input:not([type="checkbox"])')).toHaveLength(1);
      expect(
        [
          ...(list?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ??
            []),
        ].map((field) => field.value),
      ).not.toContain('section-1');
      expect(
        [
          ...(list?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ??
            []),
        ].map((field) => field.value),
      ).not.toContain('objective-1');
      const fieldValues = [...(list?.querySelectorAll<HTMLTextAreaElement>('textarea') ?? [])].map(
        (field) => field.value,
      );
      expect(fieldValues).toEqual(
        expect.arrayContaining([
          '认识直接用水',
          '生产过程也会消耗水',
          '用证据解释一件商品的水足迹',
          '一件商品藏着多少水？',
          '预测并说明依据',
          '追踪生产环节',
        ]),
      );
      await act(async () => {
        if (
          pointTitle === undefined ||
          pointTitle === null ||
          firstItem === undefined ||
          firstItem === null
        )
          return;
        fireEvent.change(pointTitle, { target: { value: '教师修改的知识点' } });
        firstItem = host
          .querySelector(`ol[aria-label="${tab}"]`)
          ?.querySelector<HTMLTextAreaElement>('textarea');
        if (firstItem === undefined || firstItem === null) return;
        fireEvent.change(firstItem, { target: { value: '教师修改的知识内容' } });
        const targetUnderstanding = [
          ...(host.querySelector(`ol[aria-label="${tab}"]`)?.querySelectorAll('textarea') ?? []),
        ].find((field) => field.value === '生产过程也会消耗水');
        if (targetUnderstanding) {
          fireEvent.change(targetUnderstanding, { target: { value: '教师修改的目标理解' } });
        }
      });
      const adopt = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === accept,
      );
      await act(async () => adopt?.click());
      expect(onAdoptLessonPlan.mock.calls[0]?.[0]).toMatchObject({
        knowledgePlan: {
          points: [
            expect.objectContaining({
              title: '教师修改的知识点',
              id: 'point-1',
              sectionId: 'section-1',
              objectiveIds: ['objective-1'],
              targetUnderstanding: '教师修改的目标理解',
              items: [expect.objectContaining({ id: 'atom-1', content: '教师修改的知识内容' })],
            }),
          ],
        },
      });
    },
  );

  it('keeps inconsistent Step 2 references advisory so the next step can continue', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.onAdoptPageOutline = vi.fn();
    panelProps.workspace = outlineWorkspace();
    panelProps.workspace.lessonPlan = knowledgeLessonPlan();
    Object.assign(panelProps.workspace.pagedOutline!.pages[1], {
      knowledgePointId: 'missing-point',
    });
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="水足迹"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    await selectFlowStage('Page outline');
    expect(host.textContent).not.toContain('Page 2 needs correction before the next step.');
    const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Generate next step'),
    );
    expect(continueButton?.getAttribute('data-repair-navigation')).toBeNull();
    expect(continueButton?.disabled).toBe(false);
    await act(async () => continueButton?.click());
    const overwriteDialog = document.querySelector('[role="alertdialog"]');
    if (overwriteDialog !== null) {
      await act(async () =>
        [...overwriteDialog.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent?.includes('Continue'))
          ?.click(),
      );
    }
    expect(panelProps.onAdoptPageOutline).toHaveBeenCalledTimes(1);
  });

  it('keeps Step 2 objective text and evidence in one editable source across tabs and adoption', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'lesson-plan',
      lessonPlan: knowledgeLessonPlan(),
    };
    const onAdoptLessonPlan = vi.fn();
    panelProps.onAdoptLessonPlan = onAdoptLessonPlan;
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="验收"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    await selectFlowStage('教学设计');
    const tab = (text: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((entry) =>
        entry.textContent?.includes(text),
      );
    await act(async () => tab('目标与概念')?.click());
    const text = '  教师手写目标  \n第二行';
    await act(async () =>
      fireEvent.change(host.querySelector('textarea[aria-label="学习目标"]')!, {
        target: { value: text },
      }),
    );
    await act(async () =>
      fireEvent.change(host.querySelector('textarea[aria-label="可观察的目标证据"]')!, {
        target: { value: '新的证据' },
      }),
    );
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"]')!;
    panel.scrollTop = 250;
    await act(async () => tab('知识')?.click());
    expect(panel.scrollTop).toBe(0);
    expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain('读懂用水数据');
    await act(async () =>
      fireEvent.change(host.querySelector('select[aria-label="教学章节"]')!, {
        target: { value: 'section-2' },
      }),
    );
    await act(async () =>
      fireEvent.change(host.querySelector('select[aria-label="知识组织方式"]')!, {
        target: { value: 'vocabulary_cluster' },
      }),
    );
    await act(async () => tab('目标与概念')?.click());
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="学习目标"]')?.value).toBe(
      text,
    );
    expect(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="可观察的目标证据"]')?.value,
    ).toBe('新的证据');
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('生成下一步'))
        ?.click(),
    );
    const adopted = onAdoptLessonPlan.mock.calls[0]![0] as LessonPlan;
    expect(adopted.learningObjectives).toEqual([text]);
    expect(adopted.objectives).toEqual([
      { id: 'objective-1', statement: text, evidence: '新的证据' },
    ]);
    expect(adopted.knowledgePlan!.points[0]).toMatchObject({
      sectionId: 'section-2',
      kind: 'vocabulary_cluster',
    });
  });

  it('keeps all story fields editable and restores deliberate empty objectives from advisory context', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    const old = knowledgeLessonPlan();
    panelProps.workspace = {
      ...generatingWorkspaceWithPlan(),
      stage: 'lesson-plan',
      lessonPlan: old,
      advisoryLessonPlan: { ...old, learningObjectives: [], objectives: [], narrative: '' },
    };
    const onAdoptLessonPlan = vi.fn();
    panelProps.onAdoptLessonPlan = onAdoptLessonPlan;
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="验收"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    await selectFlowStage('教学设计');
    const tab = (text: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((entry) =>
        entry.textContent?.includes(text),
      );
    expect(host.querySelector('textarea[aria-label="课程核心问题"]')).not.toBeNull();
    for (const label of [
      '课程核心问题',
      '学习承诺',
      '开场',
      '教学展开',
      '导览问题',
      '导览先备知识',
      '学习路线',
      '达成证据',
      '综合总结',
      '回扣开场',
      '迁移应用',
      '章节名称',
      '章节问题',
      '进入条件',
      '预期结果',
    ]) {
      const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="' + label + '"]');
      expect(field, label).not.toBeNull();
      await act(async () => fireEvent.change(field!, { target: { value: '' } }));
    }
    await act(async () => tab('目标与概念')?.click());
    expect(host.querySelectorAll('textarea[aria-label="学习目标"]')).toHaveLength(0);
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('生成下一步'))
        ?.click(),
    );
    const adopted = onAdoptLessonPlan.mock.calls[0]![0] as LessonPlan;
    expect(adopted.learningObjectives).toEqual([]);
    expect(adopted.objectives).toEqual([]);
    expect(adopted.narrative).toBe('');
    expect(adopted.story!.coreQuestion).toBe('');
    expect(adopted.story!.advanceOrganizer).toEqual({
      coreQuestion: '',
      priorKnowledge: [''],
      learningRoute: [''],
      successEvidence: [''],
    });
    expect(adopted.story!.closing).toEqual({ synthesis: '', returnToOpening: '', transfer: '' });
    expect(adopted.story!.sections[0]).toMatchObject({
      title: '',
      question: '',
      entryCondition: '',
      exitOutcome: '',
    });
  });

  it('resets the outline editor scroll when switching pages and preserves the earlier page edits', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = outlineWorkspace();
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="验收"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    await selectFlowStage('分页大纲');
    const editor = host.querySelector<HTMLElement>('.' + styles.outlineEditorBody)!;
    await act(async () =>
      fireEvent.change(host.querySelector('textarea[aria-label="学习目标"]')!, {
        target: { value: '未保存的目标' },
      }),
    );
    editor.scrollTop = 400;
    const pageButtons = [...host.querySelectorAll<HTMLButtonElement>('button[aria-current]')];
    const nav = host.querySelector('.' + styles.outlinePageList);
    const second = [...(nav?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => !button.hasAttribute('aria-current'),
    );
    // Use the page-map cards, whose aria-current is set only for the active page.
    const first = pageButtons.find((button) => button.getAttribute('aria-current') === 'page')!;
    const sibling = first.closest('ol')?.querySelectorAll<HTMLButtonElement>('button');
    const next =
      second ??
      [...(sibling ?? [])].find((button) => button !== first && button.textContent?.includes('02'));
    expect(next).toBeDefined();
    await act(async () => next?.click());
    expect(editor.scrollTop).toBe(0);
    await act(async () => first.click());
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="学习目标"]')?.value).toBe(
      '未保存的目标',
    );
  });

  it('allows a whole-lesson closing page to reference objectives across sections', () => {
    const plan = knowledgeLessonPlan();
    plan.objectives!.push({
      id: 'objective-2',
      statement: 'Compare choices',
      evidence: 'Explain a choice',
    });
    plan.story!.sections[1]!.objectiveIds = ['objective-2'];
    const page: PageOutline = {
      ...outlineWorkspace().pagedOutline!.pages[0]!,
      pageRole: 'close',
      knowledgePointId: undefined,
      sectionId: 'section-2',
      objectiveIds: ['objective-1', 'objective-2'],
    };
    const t = ((key: string) => key) as Parameters<typeof pageReferenceErrors>[2];
    expect(pageReferenceErrors(page, plan, t)).toEqual([]);
    expect(pageReferenceErrors({ ...page, pageRole: 'develop' }, plan, t)).toContain(
      'reachDeck.semantics.objectiveSectionMismatch',
    );
    expect(pageReferenceErrors({ ...page, objectiveIds: ['missing'] }, plan, t)).toContain(
      'reachDeck.semantics.unknownObjective',
    );
    const { objectives: _objectives, ...legacyPlan } = plan;
    expect(pageReferenceErrors(page, legacyPlan, t)).toEqual([]);
    expect(pageReferenceErrors({ ...page, objectiveIds: ['missing'] }, legacyPlan, t)).toContain(
      'reachDeck.semantics.unknownObjective',
    );
  });

  it('edits outline goals and duration, deletes pages, and changes the page type', async () => {
    const onAdoptPageOutline = vi.fn();
    const onRestartPlanningStage = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = outlineWorkspace();
    panelProps.onAdoptPageOutline = onAdoptPageOutline;
    panelProps.onRestartPlanningStage = onRestartPlanningStage;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="分页大纲"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');

    const screen = host.querySelector('[aria-label="分页大纲设计"]');
    expect(screen?.textContent).not.toContain('确认 Deck 的页面节奏');
    expect(screen?.querySelector('input[type="checkbox"]')).toBeNull();
    expect(screen?.querySelector('textarea')).not.toBeNull();
    // summary 编辑器已删除;教学规格分区以结构化字段呈现。
    expect(screen?.textContent).not.toContain('分页摘要');
    const specSection = screen?.querySelector<HTMLElement>('[aria-label="教学规格"]');
    expect(specSection).not.toBeNull();
    const classificationSection = screen?.querySelector<HTMLElement>('[aria-label="页面信息分类"]');
    expect(classificationSection).not.toBeNull();
    expect(specSection?.contains(classificationSection ?? null)).toBe(true);
    // 枚举字段改用 @reachany/ui 自定义 Select:触发按钮展示当前选项文案。
    expect(
      classificationSection?.querySelector<HTMLButtonElement>('button[aria-label="信息结构"]')
        ?.textContent,
    ).toContain('并列要点');
    expect(
      specSection?.querySelector<HTMLButtonElement>('button[aria-label="页面角色"]')?.textContent,
    ).toContain('展开理解');
    expect(screen?.querySelector('select')).toBeNull();
    // 右侧分页标题与其它规划文本复用同一 TipTap/MathLive 多行编辑链，且继续暴露原有无障碍标签。
    const titleEditor = screen?.querySelector<HTMLElement>(
      '[contenteditable="true"][aria-label="分页标题"]',
    );
    expect(titleEditor).not.toBeNull();
    expect(screen?.querySelector('input[aria-label="分页标题"]')).toBeNull();
    expect(
      findRichTextFieldScope(titleEditor)?.querySelector('[aria-label="插入独立公式"]'),
    ).toBeNull();
    await act(async () => {
      titleEditor?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    expect(titleEditor?.querySelectorAll('p')).toHaveLength(2);
    await insertInlineFormula(titleEditor, 'x<y');
    expect(screen?.textContent).toContain('\\(x<y\\)');
    // Plain teaching text preserves the teacher's exact formula and wording.
    const objectiveEditor = specSection?.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="学习目标"]',
    );
    expect(objectiveEditor).not.toBeNull();
    await act(async () =>
      fireEvent.change(objectiveEditor!, { target: { value: '理解关系 \\(x^2\\)' } }),
    );
    // 自定义 Select 的交互:点开触发按钮,再点选 listbox 里的目标选项。
    const sceneTypeTrigger = screen?.querySelector<HTMLButtonElement>(
      'button[aria-label="页面类型"]',
    );
    await act(async () => sceneTypeTrigger?.click());
    const sceneOptions = [...(screen?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const quizOption = sceneOptions.find((option) => option.textContent?.includes('课堂测验'));
    expect(quizOption?.getAttribute('aria-disabled')).toBeNull();
    expect(quizOption).not.toBeUndefined();
    await act(async () => quizOption?.click());
    expect(sceneTypeTrigger?.textContent).toContain('课堂测验');
    const duration = screen?.querySelector<HTMLInputElement>('input[type="number"]');
    expect(duration?.readOnly).toBe(false);
    expect(duration?.step).toBe('1');
    expect(duration?.min).toBe('1');
    await act(async () => {
      duration?.stepUp();
      duration?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(duration?.valueAsNumber).toBe(11);
    await act(async () => {
      duration?.stepDown();
      duration?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(duration?.valueAsNumber).toBe(10);
    await act(async () => {
      if (duration === null || duration === undefined) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        duration,
        '12.5',
      );
      duration.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(duration?.min).toBe('0.5');
    await act(async () => {
      duration?.stepUp();
      duration?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(duration?.valueAsNumber).toBe(13.5);
    await act(async () => {
      duration?.stepDown();
      duration?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(duration?.valueAsNumber).toBe(12.5);
    await act(async () => {
      if (duration === null || duration === undefined) return;
      duration.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(duration, '');
      duration.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(duration?.value).toBe('');
    expect(duration?.getAttribute('aria-invalid')).toBe('true');
    expect(duration?.className).toContain('border-[var(--reachany-color-danger)]');
    await act(async () => duration?.blur());
    expect(duration?.valueAsNumber).toBe(12.5);
    expect(duration?.hasAttribute('aria-invalid')).toBe(false);
    const deleteSecond = screen?.querySelector<HTMLButtonElement>('[aria-label="删除页面 第二页"]');
    await act(async () => deleteSecond?.click());

    const regenerate = [...(screen?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '重新生成大纲',
    );
    const continueGeneration = [...(screen?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '生成下一步',
    );
    expect(regenerate?.closest('footer')).not.toBeNull();
    expect(continueGeneration?.closest('footer')).not.toBeNull();
    await act(async () => continueGeneration?.click());
    await act(async () =>
      [...(document.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === '继续')
        ?.click(),
    );
    expect(onAdoptPageOutline).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: [
          expect.objectContaining({
            estimatedDurationMinutes: 12.5,
            id: 'page-1',
            order: 1,
            sceneType: 'quiz',
            title: expect.stringContaining('\\(x<y\\)'),
            instructionalSpec: expect.objectContaining({
              learningObjective: expect.stringContaining('\\(x^2\\)'),
              teachingMove: 'explain',
            }),
          }),
        ],
      }),
      undefined,
    );
    await act(async () => regenerate?.click());
    expect(onRestartPlanningStage).toHaveBeenCalledWith('page-outline', undefined, {
      enabledSceneTypes: ['slide', 'quiz', 'interactive'],
    });

    // 插入公式触发了 node-view 的动态 import('mathlive');等它落定再结束本用例,
    // 否则卸载时 hideVirtualKeyboardWhenInactive 的回调可能在 jsdom 拆除后才执行
    // (window is not defined 的未处理拒绝,随用例数量/耗时漂移偶发)。
    await act(async () => {
      await import('mathlive');
    });
  });

  it('keeps unadopted outline edits when switching to another step and back', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = outlineWorkspace();
    panelProps.onAdoptPageOutline = vi.fn();

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="分页大纲"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');

    const titleEditor = host.querySelector<HTMLElement>(
      '[contenteditable="true"][aria-label="分页标题"]',
    );
    expect(titleEditor?.textContent).toContain('第一页');
    await insertInlineFormula(titleEditor, 'a^2<b^2');
    expect(host.textContent).toContain('\\(a^2<b^2\\)');

    const outlineScreen = host.querySelector<HTMLElement>('[aria-label="分页大纲设计"]');
    const pageButtons = [
      ...(outlineScreen?.querySelectorAll<HTMLButtonElement>('ol button') ?? []),
    ].filter((button) => button.querySelector('strong') !== null);
    const pageTwo = pageButtons[1];
    await act(async () => {
      pageTwo?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(pageTwo?.getAttribute('aria-current')).toBe('page');
    const pageOne = pageButtons[0];
    await act(async () => {
      pageOne?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(pageOne?.getAttribute('aria-current')).toBe('page');
    const pageOneTitleAfterSwitch = host.querySelector<HTMLElement>(
      '[contenteditable="true"][aria-label="分页标题"]',
    );
    expect(
      pageOneTitleAfterSwitch
        ?.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')
        ?.getAttribute('data-latex'),
    ).toBe('a^2<b^2');

    // 去教学设计步再回来:草稿提升到父级,未采用的修改不应被大纲原文覆盖。
    await selectFlowStage('教学设计');
    expect(host.querySelector('[aria-label="分页标题"]')).toBeNull();
    await selectFlowStage('分页大纲');
    const restoredTitle = host.querySelector<HTMLElement>(
      '[contenteditable="true"][aria-label="分页标题"]',
    );
    expect(
      restoredTitle
        ?.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')
        ?.getAttribute('data-latex'),
    ).toBe('a^2<b^2');
  });

  it('inserts a page between outline nodes and allows adoption with an empty teaching specification', async () => {
    const onAdoptPageOutline = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = { ...outlineWorkspace(), stage: 'page-outline' };
    panelProps.onAdoptPageOutline = onAdoptPageOutline;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="分页大纲"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');
    const screen = host.querySelector('[aria-label="分页大纲设计"]');

    // 每个节点上缘一个"插到本项之前"的热区,列表末尾一个追加热区。
    expect(screen?.querySelector('[aria-label="在第 1 个位置插入页面"]')).not.toBeNull();
    const insertBetween = screen?.querySelector<HTMLButtonElement>(
      '[aria-label="在第 2 个位置插入页面"]',
    );
    const insertTail = screen?.querySelector<HTMLButtonElement>(
      '[aria-label="在第 3 个位置插入页面"]',
    );
    expect(insertTail).not.toBeNull();
    await act(async () => insertBetween?.click());

    expect(screen?.textContent).toContain('3 个页面节点');
    // 新页立即选中,标题可编辑,默认为"新页面"。
    const title = screen?.querySelector<HTMLElement>(
      '[contenteditable="true"][aria-label="分页标题"]',
    );
    expect(title?.textContent).toContain('新页面');
    expect(title?.getAttribute('contenteditable')).toBe('true');
    await insertInlineFormula(title, 'm>n');

    const continueGeneration = [...(screen?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '生成下一步',
    );
    expect(continueGeneration?.hasAttribute('disabled')).toBe(false);
    await act(async () => continueGeneration?.click());
    expect(screen?.querySelector('[aria-current="page"]')?.textContent).toContain('新页面');
    expect(host.querySelector('[data-repair-navigation]')).toBeNull();
    expect(onAdoptPageOutline).toHaveBeenCalledTimes(1);
    expect(onAdoptPageOutline.mock.calls[0]![0].pages[1].instructionalSpec).toMatchObject({
      schemaVersion: 'reach-deck-instructional-spec/v3',
      learningObjective: '',
      visualDirection: '',
    });
  });

  it('preserves multiline plain teaching text when adopting the outline', async () => {
    const onAdoptPageOutline = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.workspace = {
      ...outlineWorkspace(),
      stage: 'page-outline',
    } as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
    panelProps.onAdoptPageOutline = onAdoptPageOutline;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="分页大纲"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');

    const objectiveEditor = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="学习目标"]',
    );
    expect(objectiveEditor).not.toBeNull();
    await act(async () =>
      fireEvent.change(objectiveEditor!, { target: { value: '步骤  说明\n1  检查' } }),
    );

    const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '生成下一步',
    );
    await act(async () => continueButton?.click());

    expect(onAdoptPageOutline).toHaveBeenCalledTimes(1);
    const adopted = onAdoptPageOutline.mock.calls[0]?.[0] as { pages: PageOutline[] };
    const learningObjective = adopted.pages[0]?.instructionalSpec?.learningObjective ?? '';
    expect(learningObjective).toContain('步骤');
    expect(learningObjective).toContain('说明');
    expect(learningObjective).toContain('1');
    expect(learningObjective).toContain('检查');
    expect(learningObjective).not.toContain('|');
  });

  it('shows editable spec and classification fields for a legacy slide missing both', async () => {
    const panelProps = createPanelProps(vi.fn());
    const onAdoptPageOutline = vi.fn();
    panelProps.onAdoptPageOutline = onAdoptPageOutline;
    panelProps.jobs = [];
    panelProps.workspace = {
      ...outlineWorkspace(),
      stage: 'page-outline',
      pagedOutline: {
        ...outlineWorkspace().pagedOutline,
        pages: [
          {
            id: 'legacy-page',
            order: 1,
            sceneType: 'slide',
            title: '历史缺规格页',
            estimatedDurationMinutes: 3,
          },
        ],
      },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="历史大纲"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('分页大纲');

    expect(host.querySelector('[aria-label="教学规格"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="页面信息分类"]')).not.toBeNull();
    expect(host.querySelector('[data-repair-navigation]')).toBeNull();
    const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '生成下一步',
    );
    expect(continueButton?.hasAttribute('disabled')).toBe(false);
    await act(async () => continueButton?.click());
    expect(onAdoptPageOutline).toHaveBeenCalledTimes(1);
  });

  it('persists the default classification for a legacy slide missing only classification', async () => {
    const onAdoptPageOutline = vi.fn();
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    panelProps.onAdoptPageOutline = onAdoptPageOutline;
    const baseOutline = outlineWorkspace().pagedOutline!;
    panelProps.workspace = {
      ...outlineWorkspace(),
      stage: 'page-outline',
      pagedOutline: {
        ...baseOutline,
        pages: baseOutline.pages.map((page, index) =>
          index === 0 ? { ...page, slideClassification: undefined } : page,
        ),
      },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="Legacy classification"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    const outlineStage = host.querySelector<HTMLButtonElement>(
      'button[data-flow-step="page-outline"]',
    );
    await act(async () => {
      outlineStage?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const continueButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Generate next step',
    );
    expect(continueButton?.hasAttribute('disabled')).toBe(false);
    await act(async () => continueButton?.click());
    expect(onAdoptPageOutline).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: expect.arrayContaining([
          expect.objectContaining({ slideClassification: validSlideClassification() }),
        ]),
      }),
      undefined,
    );
  });

  it.each(['slide', 'quiz', 'interactive'] as const)(
    'adopts a %s page with incomplete teaching content and missing duration',
    async (sceneType) => {
      const panelProps = createPanelProps(vi.fn());
      const onAdoptPageOutline = vi.fn();
      panelProps.onAdoptPageOutline = onAdoptPageOutline;
      panelProps.jobs = [];
      const baseOutline = outlineWorkspace().pagedOutline!;
      panelProps.workspace = {
        ...outlineWorkspace(),
        stage: 'page-outline',
        pagedOutline: {
          ...baseOutline,
          pages: baseOutline.pages.map((page, index) =>
            index === 1
              ? {
                  ...page,
                  sceneType,
                  title: '',
                  estimatedDurationMinutes: undefined,
                  slideClassification: undefined,
                  instructionalSpec: emptyInstructionalSpecForTest(),
                  sectionId: 'removed-section',
                  knowledgePointId: 'removed-knowledge-point',
                }
              : page,
          ),
        },
      } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

      await act(async () => {
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="非幻灯片规格校验"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        );
      });
      const outlineStage = [
        ...(host.querySelector('[aria-label="Reach Deck 生成阶段"]')?.querySelectorAll('button') ??
          []),
      ].find((button) => button.textContent?.includes('分页大纲'));
      await act(async () => outlineStage?.click());

      const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === '生成下一步',
      );
      expect(continueButton?.hasAttribute('disabled')).toBe(false);
      await act(async () => continueButton?.click());
      expect(onAdoptPageOutline).toHaveBeenCalledTimes(1);
      expect(onAdoptPageOutline.mock.calls[0]![0].pages[1]).toMatchObject({
        sceneType,
        title: '',
        instructionalSpec: { schemaVersion: 'reach-deck-instructional-spec/v3' },
      });
      expect(host.querySelector('[data-repair-navigation]')).toBeNull();
      if (sceneType === 'interactive') expect(host.textContent).toContain('GenUI 互动');
    },
  );

  it.each(['quiz', 'interactive'] as const)(
    'promotes a legacy %s page without a teaching specification when adopting',
    async (sceneType) => {
      const panelProps = createPanelProps(vi.fn());
      const onAdoptPageOutline = vi.fn();
      panelProps.jobs = [];
      panelProps.onAdoptPageOutline = onAdoptPageOutline;
      const workspace = outlineWorkspace();
      panelProps.workspace = {
        ...workspace,
        stage: 'page-outline',
        pagedOutline: {
          ...workspace.pagedOutline!,
          pages: [{ id: 'legacy-page', order: 1, title: 'Explore the source', sceneType }],
        },
      };
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="en-US">
            <ReachDeckAuthoringFlow
              editor={null}
              materialized={false}
              moduleTitle="Legacy activity"
              panelProps={panelProps}
            />
          </PortalI18nProvider>,
        ),
      );
      const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === 'Generate next step',
      );
      expect(continueButton?.disabled).toBe(false);
      await act(async () => continueButton?.click());
      expect(onAdoptPageOutline).toHaveBeenCalledTimes(1);
      expect(onAdoptPageOutline.mock.calls[0]![0].pages[0]).toMatchObject({
        sceneType,
        instructionalSpec: { schemaVersion: 'reach-deck-instructional-spec/v3' },
      });
      if (sceneType === 'interactive') expect(host.textContent).toContain('GenUI interaction');
    },
  );

  it('keeps unsupported scene types from entering page generation', async () => {
    const panelProps = createPanelProps(vi.fn());
    const onAdoptPageOutline = vi.fn();
    panelProps.jobs = [];
    panelProps.onAdoptPageOutline = onAdoptPageOutline;
    panelProps.workspace = { ...outlineWorkspace(), stage: 'page-outline' };
    panelProps.workspace.pagedOutline!.pages[0]!.sceneType = 'unknown' as PageOutline['sceneType'];
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="Page type"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      ),
    );
    const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Generate next step',
    );
    expect(continueButton?.disabled).toBe(true);
    expect(host.textContent).toContain('Choose Slide, Quiz, or GenUI interaction');
    await act(async () => continueButton?.click());
    expect(onAdoptPageOutline).not.toHaveBeenCalled();
  });

  it('allows generated scientific-visual classifications to be adopted', async () => {
    const panelProps = createPanelProps(vi.fn());
    panelProps.jobs = [];
    const baseOutline = outlineWorkspace().pagedOutline!;
    panelProps.workspace = {
      ...outlineWorkspace(),
      pagedOutline: {
        ...baseOutline,
        pages: baseOutline.pages.map((page, index) =>
          index === 0
            ? {
                ...page,
                slideClassification: {
                  ...validSlideClassification(),
                  mediaType: 'scientific-visual',
                },
              }
            : page,
        ),
      },
    } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckAuthoringFlow
            editor={null}
            materialized={false}
            moduleTitle="Scientific visual classification"
            panelProps={panelProps}
          />
        </PortalI18nProvider>,
      );
    });
    await selectFlowStage('Page outline');

    expect(host.textContent).toContain('Scientific visual');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

function knowledgeLessonPlan(): LessonPlan {
  return {
    ...generatingWorkspaceWithPlan().lessonPlan!,
    objectives: [
      { id: 'objective-1', statement: '读懂用水数据', evidence: '列出食物生产中的用水环节' },
    ],
    story: {
      schemaVersion: 'reach-deck-story/v1',
      coreQuestion: '水从哪里来？',
      learnerPromise: '看见隐含用水',
      advanceOrganizer: {
        priorKnowledge: ['直接用水'],
        coreQuestion: '水从哪里来？',
        learningRoute: ['理解水足迹'],
        successEvidence: ['解释商品用水'],
      },
      opening: '观察一件商品',
      development: '从数据到行动',
      closing: { synthesis: '看见关系', returnToOpening: '解释商品', transfer: '改变选择' },
      sections: [
        {
          id: 'section-1',
          title: '理解水足迹',
          question: '看不见的水在哪里？',
          objectiveIds: ['objective-1'],
          entryCondition: '认识直接用水',
          exitOutcome: '解释隐含用水',
        },
        {
          id: 'section-2',
          title: '做出选择',
          question: '如何选择？',
          objectiveIds: ['objective-1'],
          entryCondition: '理解水足迹',
          exitOutcome: '作出选择',
        },
      ],
    },
    knowledgePlan: {
      schemaVersion: 'reach-deck-knowledge-plan/v1',
      points: [
        {
          id: 'point-1',
          sectionId: 'section-1',
          title: '隐含用水',
          kind: 'standard',
          items: [{ id: 'atom-1', content: '区分直接用水与隐含用水' }],
          objectiveIds: ['objective-1'],
          prerequisite: '认识直接用水',
          targetUnderstanding: '生产过程也会消耗水',
          masteryEvidence: '用证据解释一件商品的水足迹',
          curiositySeed: '一件商品藏着多少水？',
          learnerAttempt: '预测并说明依据',
          reveal: '追踪生产环节',
        },
      ],
    },
    presentationPreferences: { includeTitlePage: false },
  };
}

function generatingWorkspaceWithPlan(): NonNullable<ReachDeckGenerationPanelProps['workspace']> {
  return {
    runId: 'run-1',
    stage: 'page-generation',
    paused: false,
    lessonPlan: {
      id: 'plan-1',
      title: '水足迹调查课',
      audience: '八年级',
      durationMinutes: 45,
      learningObjectives: ['读懂用水数据'],
      teachingStrategy: '证据链驱动',
      keyTerms: ['水足迹'],
      narrative: '从数据到行动',
    },
    targetPageIds: ['page-1'],
    records: {
      'page-1': {
        page: { pageId: 'page-1', title: '第一页', sceneType: 'slide' },
        request: { attemptReason: 'initial' },
      },
    },
    statuses: {
      'page-1': {
        runId: 'run-1',
        pageId: 'page-1',
        requestedRevision: 1,
        attempt: 1,
        state: 'generating',
        startedAt: '2026-08-16T00:00:00.000Z',
      },
    },
    sceneArtifacts: {},
  } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
}

/**
 * 对齐 `ReachDeckCopyWorkspaceFactory` 实际写入的恢复壳形状:没有生成回合,
 * `targetPageIds` 为空、`stage` 停在 `lesson-plan`,产出全在 `baseDocument` 里。
 */
function marketplaceCopyWorkspace(): NonNullable<ReachDeckGenerationPanelProps['workspace']> {
  const targetDraftVersionId = 'f86a70fc-a113-437d-9843-be362bb4be95';
  return {
    schemaVersion: 'reach-deck-generation-workspace/v1',
    runId: `marketplace-copy-${targetDraftVersionId}`,
    documentId: targetDraftVersionId,
    source: 'marketplace-copy',
    baseDocument: {
      schemaVersion: 'reach-deck-document/v2',
      id: targetDraftVersionId,
      pages: [{ pageId: 'page-1', revision: 1, sceneType: 'slide' }],
    },
    baseRevisions: { 'page-1': 1 },
    targetPageIds: [],
    records: {},
    order: [],
    sceneArtifacts: {},
    statuses: {},
    stage: 'lesson-plan',
    paused: false,
  } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
}

function pendingRegenerateWorkspace(): NonNullable<ReachDeckGenerationPanelProps['workspace']> {
  return {
    runId: 'run-1',
    stage: 'page-generation',
    paused: false,
    targetPageIds: ['page-1'],
    records: {
      'page-1': {
        page: {
          pageId: 'page-1',
          title: '第一页',
          sceneType: 'slide',
        },
        request: { attemptReason: 'regenerate' },
      },
    },
    statuses: { 'page-1': { state: 'pending' } },
    sceneArtifacts: {},
  } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
}

function outlineWorkspace(): NonNullable<ReachDeckGenerationPanelProps['workspace']> {
  return {
    ...generatingWorkspaceWithPlan(),
    pagedOutline: {
      id: 'outline-1',
      title: '两页证据课',
      pages: [
        {
          id: 'page-1',
          order: 1,
          sceneType: 'slide',
          title: '第一页',
          estimatedDurationMinutes: 10,
          instructionalSpec: {
            learningObjective: '说出可靠证据的三个标准',
            teachingMove: 'explain',
            keyPoints: ['标准一', '标准二', '标准三'],
            visualDirection: '三条标准并列指向同一结论',
            density: 'medium',
            visualAssets: [],
          },
          slideClassification: {
            primaryType: 'parallel_items',
            density: 'medium',
            visualFocus: 'statement',
            mediaType: 'none',
          },
        },
        {
          id: 'page-2',
          order: 2,
          sceneType: 'slide',
          title: '第二页',
          estimatedDurationMinutes: 10,
          instructionalSpec: validInstructionalSpec(),
          slideClassification: validSlideClassification(),
        },
      ],
    },
    targetPageIds: ['page-1', 'page-2'],
    order: ['page-1', 'page-2'],
  } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
}

function validInstructionalSpec(): NonNullable<PageOutline['instructionalSpec']> {
  return {
    learningObjective: '说明核心概念',
    teachingMove: 'explain',
    keyPoints: ['要点一', '要点二', '要点三'],
    visualDirection: '突出核心关系',
    density: 'medium',
    visualAssets: [],
  };
}

function validSlideClassification(): NonNullable<PageOutline['slideClassification']> {
  return {
    primaryType: 'single_focus',
    density: 'medium',
    visualFocus: 'statement',
    mediaType: 'none',
  };
}

function emptyInstructionalSpecForTest(): NonNullable<PageOutline['instructionalSpec']> {
  return {
    learningObjective: '',
    teachingMove: 'explain',
    keyPoints: [],
    visualDirection: '',
    density: 'medium',
    visualAssets: [],
  };
}

function readyPageWorkspace(): NonNullable<ReachDeckGenerationPanelProps['workspace']> {
  return {
    runId: 'run-1',
    stage: 'page-generation',
    paused: true,
    targetPageIds: ['page-1', 'page-2'],
    records: {
      'page-1': {
        page: {
          pageId: 'page-1',
          title: '第一页',
          sceneType: 'slide',
        },
        request: { attemptReason: 'regenerate' },
      },
      'page-2': {
        page: {
          pageId: 'page-2',
          title: '第二页',
          sceneType: 'slide',
        },
        request: { attemptReason: 'initial' },
      },
    },
    statuses: {
      'page-1': { state: 'ready' },
      'page-2': { state: 'pending' },
    },
    sceneArtifacts: {
      'page-1': {
        status: 'ready',
        sceneType: 'slide',
      },
    },
  } as unknown as NonNullable<ReachDeckGenerationPanelProps['workspace']>;
}

function createPanelProps(onCancelJob: (jobId: string) => void): ReachDeckGenerationPanelProps {
  const noop = vi.fn();
  return {
    jobs: [
      {
        jobId: 'job-plan-active',
        kind: 'lesson-plan',
        status: 'active',
        progress: 35,
        done: false,
      },
    ],
    sourceDraft: '',
    onSourceDraftChange: noop,
    onCreateWorkspace: noop,
    onRefresh: noop,
    onTogglePaused: noop,
    onStartLessonPlan: noop,
    onApplyLessonPlan: noop,
    onAdoptLessonPlan: noop,
    onStartPageOutline: noop,
    onApplyPageOutline: noop,
    onStartPage: noop,
    onApplyPageArtifact: noop,
    onRetryJob: noop,
    onCancelJob,
    onMaterialize: noop,
  };
}

function createWorkspaceBatch(
  overrides: Partial<ReachDeckWorkspaceBatchView> = {},
): ReachDeckWorkspaceBatchView {
  return {
    batchId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-13T00:00:00.000Z',
    kind: 'narration',
    members: [],
    revision: 1,
    runId: 'run-1',
    skipped: [],
    status: 'active',
    ...overrides,
  };
}

async function insertInlineFormula(editor: HTMLElement | null | undefined, latex: string) {
  if (editor === null || editor === undefined) throw new Error('rich-text editor not found');
  if (customElements.get('math-field') === undefined) {
    customElements.define(
      'math-field',
      class extends HTMLElement {
        mathVirtualKeyboardPolicy = 'manual';
        smartFence = true;
        value = '';
      },
    );
  }
  await act(async () => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    editor.focus();
  });
  const insert =
    findRichTextFieldScope(editor)?.querySelector<HTMLButtonElement>('[aria-label="插入行内公式"]');
  await act(async () => {
    insert?.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  const mathfield = editor.querySelector<HTMLElement & { value: string }>('math-field');
  if (mathfield === null) throw new Error('math field was not inserted');
  await act(async () => {
    mathfield.value = latex;
    mathfield.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    await import('mathlive');
  });
}

async function pasteHtml(
  editor: HTMLElement | null | undefined,
  html: string,
  plainText: string,
): Promise<void> {
  if (editor === null || editor === undefined) throw new Error('rich-text editor not found');
  const clipboardData = {
    files: [],
    getData: (type: string) =>
      type === 'text/html' ? html : type === 'text/plain' ? plainText : '',
    items: [],
    types: ['text/html', 'text/plain'],
  } as unknown as DataTransfer;
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });

  await act(async () => {
    editor.focus();
    editor.dispatchEvent(event);
    await Promise.resolve();
  });
}

function findRichTextFieldScope(editor: HTMLElement | null | undefined): HTMLElement | undefined {
  let scope = editor?.parentElement;
  while (scope !== null && scope !== undefined) {
    if (scope.querySelector('[aria-label="插入行内公式"]') !== null) return scope;
    scope = scope.parentElement;
  }
  return undefined;
}
