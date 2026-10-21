// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import { StudentLearningPage } from '@/src/components/student/StudentLearningPage';
import {
  resolveStudentReachDeckPageAccess,
  type StudentReachDeckNavigationState,
} from '@/src/lib/student-reach-deck-page-access';
import type { StudentReachDeckRailItem } from '@/src/lib/student-reach-deck-workspace';

import { StudentReachDeckWorkspace } from './StudentReachDeckWorkspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * 模拟播放器上报的导航状态：completedPageIds 为 null 表示 attempt 已完成（全部可跳）；
 * report 为 false 时不上报，工作区回落到服务端初始进度。
 */
const launcherNavigation = vi.hoisted(() => ({
  completedPageIds: null as string[] | null,
  fencedGrading: false,
  report: true,
}));
const launcherActivity = vi.hoisted(() => ({
  currentTime: undefined as number | undefined,
  selectionId: undefined as string | undefined,
  moduleVersionId: undefined as string | undefined,
}));

const pathname = vi.hoisted(() => ({ value: '/student/reach-deck/selection' }));
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useSearchParams: () => null,
  usePathname: () => pathname.value,
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@reachany/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reachany/ui')>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Tooltip: ({
    children,
    content,
  }: {
    children: React.ReactElement<Record<string, unknown>>;
    content: React.ReactNode;
  }) =>
    React.cloneElement(children, {
      'data-tooltip': typeof content === 'string' ? content : undefined,
    }),
}));
vi.mock('./StudentReachDeckAttemptLauncher', () => ({
  StudentReachDeckAttemptLauncher: ({
    activePageId,
    document,
    fullscreen,
    moduleVersionId,
    onFullscreenChange,
    onLearningFenceChange,
    onNavigationStateChange,
    onStartBlockedChange,
    onWhiteboardEditingChange,
    onTutorActivityChange,
    selectionId,
  }: {
    activePageId?: string;
    document: import('@reachany/reach-deck-dsl').ReachDeckDocument;
    fullscreen?: boolean;
    onFullscreenChange?: (fullscreen: boolean) => void;
    onNavigationStateChange?: (state: StudentReachDeckNavigationState | null) => void;
    moduleVersionId: string;
    onTutorActivityChange?: (context: {
      attemptId: string;
      moduleVersionId: string;
      selectionId: string;
      activity: {
        schemaVersion: 'reach-deck-player-activity/v1';
        pageId: string;
        sceneId: string;
        sceneType: 'slide';
        sourceRevision: number;
        state: { currentTime?: number };
      };
    }) => void;
    onLearningFenceChange?: (fence: {
      activatedAt: string;
      attemptId: string;
      fenceId: string;
      pageId: string;
      questionId: string;
      sceneId: string;
      status: 'active';
    }) => void;
    onStartBlockedChange?: (blocked: boolean) => void;
    onWhiteboardEditingChange?: (editing: boolean) => void;
    selectionId: string;
  }) => {
    const [navigationTick, setNavigationTick] = React.useState(0);
    React.useEffect(() => {
      if (!launcherNavigation.report) return;
      onNavigationStateChange?.({
        attemptId: '33333333-3333-4333-8333-333333333333',
        currentPageFencedGrading: launcherNavigation.fencedGrading,
        pageAccess: resolveStudentReachDeckPageAccess({
          attemptCompleted: launcherNavigation.completedPageIds === null,
          completedPageIds: launcherNavigation.completedPageIds ?? [],
          pages: document.pages,
        }),
      });
    }, [activePageId, document, navigationTick, onNavigationStateChange]);
    return (
      <div data-active-page-id={activePageId}>
        Attempt launcher
        <button onClick={() => setNavigationTick((tick) => tick + 1)} type="button">
          同步导航状态
        </button>
        <button
          onClick={() =>
            onTutorActivityChange?.({
              attemptId: '33333333-3333-4333-8333-333333333333',
              moduleVersionId: launcherActivity.moduleVersionId ?? moduleVersionId,
              selectionId: launcherActivity.selectionId ?? selectionId,
              activity: {
                schemaVersion: 'reach-deck-player-activity/v1',
                pageId: activePageId ?? 'missing-page',
                sceneId: `scene-${activePageId ?? 'missing'}`,
                sceneType: 'slide',
                sourceRevision: 1,
                state:
                  launcherActivity.currentTime === undefined
                    ? {}
                    : { currentTime: launcherActivity.currentTime },
              },
            })
          }
          type="button"
        >
          同步 Tutor 活动
        </button>
        <button
          onClick={() =>
            onLearningFenceChange?.({
              activatedAt: '2026-08-04T10:00:00.000Z',
              attemptId: '33333333-3333-4333-8333-333333333333',
              fenceId: '55555555-5555-4555-8555-555555555555',
              pageId: `${moduleVersionId}:page-1`,
              questionId: 'question-1',
              sceneId: `scene-${moduleVersionId}:page-1`,
              status: 'active',
            })
          }
          type="button"
        >
          触发学习围栏
        </button>
        <button onClick={() => onStartBlockedChange?.(true)} type="button">
          模拟开始失败
        </button>
        <button onClick={() => onWhiteboardEditingChange?.(true)} type="button">
          打开笔记画布
        </button>
        <button onClick={() => onWhiteboardEditingChange?.(false)} type="button">
          关闭笔记画布
        </button>
        <button onClick={() => onFullscreenChange?.(!fullscreen)} type="button">
          {fullscreen ? '模拟退出全屏' : '模拟进入全屏'}
        </button>
      </div>
    );
  },
}));
vi.mock('./StudentReachDeckDiscussion', () => ({
  StudentReachDeckDiscussion: ({
    domainScope,
    learningFences,
    learningContext,
    onNavigateToPage,
    onOpenLearningFence,
    preparing,
  }: {
    domainScope: Record<string, string> | null;
    preparing?: boolean;
    learningFences?: Array<{ fenceId: string }>;
    learningContext: { pageId: string } | null;
    onNavigateToPage?: (pageId: string) => void;
    onOpenLearningFence?: (fenceId: string, source?: HTMLButtonElement) => void;
  }) => (
    <aside
      data-tutor-attempt={domainScope?.attemptId ?? 'pending'}
      data-tutor-page={learningContext?.pageId ?? 'pending'}
      data-tutor-preparing={String(preparing ?? false)}
    >
      Discussion
      <button
        onClick={() => onNavigateToPage?.('22222222-2222-4222-8222-222222222222:page-3')}
        type="button"
      >
        讨论区跳到第三页
      </button>
      {learningFences?.map((fence) => (
        <button
          key={fence.fenceId}
          onClick={(event) => onOpenLearningFence?.(fence.fenceId, event.currentTarget)}
          type="button"
        >
          打开围栏记录 {fence.fenceId}
        </button>
      ))}
    </aside>
  ),
}));
vi.mock('./StudentReachDeckLearningFenceDialog', () => ({
  StudentReachDeckLearningFenceDialog: ({
    fence,
    locked,
    onRunSettled,
    readOnlyNotice,
    systemNotice,
    recoveryAction,
  }: {
    fence: { pageId: string };
    locked?: boolean;
    onRunSettled?: () => void;
    readOnlyNotice?: string;
    systemNotice?: string;
    recoveryAction?: import('react').ReactNode;
  }) => (
    <aside data-fence-locked={locked ? 'true' : 'false'} data-fence-page={fence.pageId}>
      Learning fence dialogue
      <span>{readOnlyNotice}</span>
      <span>{systemNotice}</span>
      {recoveryAction}
      <button onClick={onRunSettled} type="button">
        模拟 Tutor 判定
      </button>
    </aside>
  ),
}));

const SELECTION_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';

describe('StudentReachDeckWorkspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    launcherNavigation.completedPageIds = null;
    launcherNavigation.fencedGrading = false;
    launcherNavigation.report = true;
    launcherActivity.currentTime = undefined;
    launcherActivity.selectionId = undefined;
    launcherActivity.moduleVersionId = undefined;
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('可学模块直接进播放器：截止时间不再拦截', async () => {
    await render(true);

    expect(container.textContent).toContain('Attempt launcher');
    expect(
      container.querySelector('[data-active-page-id]')?.getAttribute('data-active-page-id'),
    ).toBe(`${VERSION_ID}:page-1`);
  });

  it('进入即开始学习：右栏先等学习上下文，开始失败后才不再等', async () => {
    await render(true);
    const tutor = () => container.querySelector('[data-tutor-preparing]');

    expect(tutor()?.getAttribute('data-tutor-preparing')).toBe('true');

    const fail = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === '模拟开始失败',
    );
    act(() => fail!.click());

    expect(tutor()?.getAttribute('data-tutor-preparing')).toBe('false');
  });

  it('顺序学锁住的模块只解释原因，不给任何绕过入口', async () => {
    await render(false);

    expect(container.textContent).toContain('已锁定模块');
    expect(container.textContent).toContain('先完成上一个模块');
    expect(container.textContent).not.toContain('Attempt launcher');
    expect(
      [...container.querySelectorAll('button')].some((item) => item.textContent?.includes('确认')),
    ).toBe(false);
    await act(async () => button('讲稿').click());
    expect(container.querySelector('[data-reach-deck-current-script]')).toBeNull();
  });

  it('resumes an in-progress attempt at the first incomplete stable page id', async () => {
    const deck = documentWithPages(3);
    await render(true, deck, 'zh-CN', activeAttempt(), {
      attemptId: '33333333-3333-4333-8333-333333333333',
      completedPageIds: [`${VERSION_ID}:page-1`, `${VERSION_ID}:page-3`],
      coverageComplete: false,
      coverageKnown: true,
      firstIncompletePageId: `${VERSION_ID}:page-2`,
      moduleVersionId: VERSION_ID,
      progress: 66.67,
      selectionId: SELECTION_ID,
      status: 'in_progress',
    });

    expect(
      container.querySelector('[data-active-page-id]')?.getAttribute('data-active-page-id'),
    ).toBe(`${VERSION_ID}:page-2`);
  });

  it('opens the track module list from the navigation row instead of a left rail', async () => {
    await render(true);

    // 左侧轨道模块栏已撤掉，模块列表挂在导航行中间的下拉里。
    expect(container.querySelector('[data-module-nav]')).not.toBeNull();
    expect(container.textContent).not.toContain('暑期轨道');

    await act(async () => {
      (container.querySelector('[data-module-nav-trigger]') as HTMLButtonElement).click();
    });

    // 模块列表是共享 DropdownMenu，挂在 body 下的浮层栈里。
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('暑期轨道');
    expect(menu?.querySelector('[role="menuitem"]')?.textContent).toContain('学习课件');
    expect(menu?.querySelector('[role="menuitem"]')?.textContent).toContain('0%');
  });

  it('lays out a full-height player column beside the shared side panel', async () => {
    const workspaceCss = readFileSync(
      resolve(process.cwd(), 'src/components/reach-deck/StudentReachDeckWorkspace.module.css'),
      'utf8',
    );

    await render(true, documentWithPages(2));

    const workspace = container.querySelector('[data-reach-deck-workspace]');
    expect(workspace?.getAttribute('data-reach-deck-layout')).toBe('workspace');
    expect(workspace?.children).toHaveLength(2);
    expect(workspace?.children[0]?.getAttribute('data-reach-deck-region')).toBe('player');
    // 左侧缩略图栏已移除：播放列之外只有右栏。
    expect(container.querySelector('[data-reach-deck-region="page-rail"]')).toBeNull();
    const sidePanel = container.querySelector('[data-reach-deck-region="side-panel"]');
    expect(sidePanel?.classList.contains('rx-side-panel')).toBe(true);
    expect(workspace?.children[1]?.contains(sidePanel ?? null)).toBe(true);
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'AI 对话',
      '讲稿',
      '大纲',
    ]);
    expect(container.querySelector('[data-reach-deck-player-container]')).not.toBeNull();
    // 学习主体不再是兜底滚动容器：overflow:clip，程序化滚动带不动外层。
    const body = container.querySelector('[data-learning-body="contained"]');
    expect(body?.className).toContain('overflow-clip');
    expect(body?.className).not.toContain('overflow-y-auto');

    expect(workspaceCss).toMatch(/\.workspace\s*\{[\s\S]*?height:\s*100%[\s\S]*?overflow:\s*clip/);
    expect(workspaceCss).toMatch(
      /\.playerColumn\s*\{[\s\S]*?flex:\s*1 1 auto[\s\S]*?overflow:\s*clip/,
    );
    expect(workspaceCss).not.toMatch(/calc\(100vh/);
    expect(workspaceCss).not.toMatch(/z-index:\s*\d/);
    expect(workspaceCss).not.toMatch(/@keyframes/);
    expect(workspaceCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(workspaceCss).toMatch(
      /\.thumbnail\s*>\s*\[data-native-v2-slide-renderer\]\s*\{[\s\S]*?position:\s*absolute[\s\S]*?inset:\s*0[\s\S]*?width:\s*100%[\s\S]*?height:\s*100%/,
    );
  });

  it('uses only current-page and module-scoped playback activity for the script tab', async () => {
    const deck = documentWithPages(2);
    const firstBinding = deck.nativeSlides[0]!;
    firstBinding.slide.narration = {
      segments: [
        { text: '第一段。', start: 0, end: 2 },
        { text: '第二段。', start: 2, end: 5 },
      ],
    };
    deck.nativeSlides.push({
      ...structuredClone(firstBinding),
      pageId: `${VERSION_ID}:page-2`,
    });
    await render(true, deck);
    await act(async () => button('讲稿').click());
    const scriptPanel = () => container.querySelector('[data-reach-deck-current-script]');
    const activeScript = () => scriptPanel()?.querySelector('[aria-current="true"]');
    expect(activeScript()).toBeNull();
    launcherActivity.currentTime = 3;
    await act(async () => button('同步 Tutor 活动').click());
    expect(activeScript()?.textContent).toBe('第二段。');
    launcherActivity.currentTime = 1;
    await act(async () => button('同步 Tutor 活动').click());
    expect(activeScript()?.textContent).toBe('第一段。');
    await act(async () => button('2. 第二页').click());
    expect(scriptPanel()?.getAttribute('data-script-page-id')).toBe(`${VERSION_ID}:page-2`);
    expect(activeScript()).toBeNull();
    await act(async () => button('同步 Tutor 活动').click());
    expect(activeScript()?.textContent).toBe('第一段。');
    launcherActivity.selectionId = 'different-selection';
    await act(async () => button('同步 Tutor 活动').click());
    expect(activeScript()).toBeNull();
    launcherActivity.selectionId = undefined;
    launcherActivity.moduleVersionId = 'different-module';
    await act(async () => button('同步 Tutor 活动').click());
    expect(activeScript()).toBeNull();
  });

  it('fills the player column with GenUI and quiz pages instead of the shared fixed height', () => {
    const workspaceCss = readFileSync(
      resolve(process.cwd(), 'src/components/reach-deck/StudentReachDeckWorkspace.module.css'),
      'utf8',
    );
    const playerCss = readFileSync(
      resolve(process.cwd(), '../../packages/reach-deck-player/styles.css'),
      'utf8',
    );

    // 共享播放器默认值保持不变（教师端独立播放器依赖它）。
    expect(playerCss).toMatch(
      /\.interactive-scene-player-shell\s*\{[\s\S]*?height:\s*var\(--reach-deck-interactive-height, min\(70vh, 720px\)\)[\s\S]*?min-height:\s*var\(--reach-deck-interactive-min-height, 34rem\)/,
    );
    // 所有页型的播放器都铺满播放列；幻灯片渲染器占字幕与控制条上方的剩余高度（二者沉底）。
    expect(workspaceCss).toMatch(
      /\.playerColumn \[data-student-native-player-shell\] > \[data-student-player-frame\] \{[\s\S]*?min-height:\s*0;[\s\S]*?flex:\s*1 1 auto;/,
    );
    // Shared learner chrome now owns stage, captions and transport internals.
    expect(workspaceCss).not.toContain(':global(.reach-deck-player');
    expect(playerCss).toContain(".reach-deck-player[data-reach-deck-appearance='learner']");
    expect(playerCss).toMatch(
      /\[data-scene-type='slide'\]\s+\[data-native-v2-slide-renderer\] \{[\s\S]*?flex:\s*1 1 0;/,
    );
    expect(playerCss).toMatch(
      /\[data-reach-deck-appearance='learner'\]\s*\{[\s\S]*?--reach-deck-interactive-height:\s*100%;[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto;/,
    );
    // Quiz owns its answer-area scrolling; the stage must remain fixed.
    expect(playerCss).toMatch(
      /\[data-scene-type='quiz'\]\s+\.reach-deck-player__stage \{[\s\S]*?overflow:\s*hidden;/,
    );
    expect(playerCss).toMatch(
      /\[data-scene-type='interactive'\]\s*\.reach-deck-player__stage\s*>\s*\[data-interactive-page-id\] \{[\s\S]*?height:\s*100%;/,
    );
  });

  it('enters fullscreen on the whole document, collapses the side panel and restores it on exit', async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });
    try {
      await render(true, documentWithPages(2));
      const sidePanel = () => container.querySelector('[data-reach-deck-region="side-panel"]');
      expect(sidePanel()?.getAttribute('data-state')).toBe('open');

      await act(async () => button('模拟进入全屏').click());
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(document.documentElement.hasAttribute('data-reach-deck-fullscreen')).toBe(true);
      expect(sidePanel()?.getAttribute('data-state')).toBe('closed');
      // 全屏时的自动收起不写入右栏收起记忆。
      expect(
        window.localStorage.getItem('reachany.student.reach-deck.side-panel-collapsed'),
      ).toBeNull();

      // 浏览器全屏 API 未真正进入时（这里的桩不触发 fullscreenchange），Esc 仍能退出页面内全屏。
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(document.documentElement.hasAttribute('data-reach-deck-fullscreen')).toBe(false);
      expect(sidePanel()?.getAttribute('data-state')).toBe('open');
    } finally {
      delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  it('collapses the side panel and remembers the choice', async () => {
    await render(true, documentWithPages(2));

    const sidePanel = () => container.querySelector('[data-reach-deck-region="side-panel"]');
    expect(sidePanel()?.getAttribute('data-state')).toBe('open');
    await act(async () => button('收起侧栏', 'aria-label').click());
    expect(sidePanel()?.getAttribute('data-state')).toBe('closed');
    expect(window.localStorage.getItem('reachany.student.reach-deck.side-panel-collapsed')).toBe(
      'true',
    );
    expect(button('展开侧栏', 'aria-label')).not.toBeNull();
  });

  it('starts with the side panel collapsed below 1280px unless the learner chose otherwise', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: query === '(max-width: 1279px)', media: query })),
    );
    await render(true, documentWithPages(2));
    expect(
      container.querySelector('[data-reach-deck-region="side-panel"]')?.getAttribute('data-state'),
    ).toBe('closed');

    act(() => root.unmount());
    root = createRoot(container);
    window.localStorage.setItem('reachany.student.reach-deck.side-panel-collapsed', 'false');
    await render(true, documentWithPages(2));
    expect(
      container.querySelector('[data-reach-deck-region="side-panel"]')?.getAttribute('data-state'),
    ).toBe('open');
  });

  it('lists every page with its thumbnail, title and script in the outline', async () => {
    const deck = documentWithPages(3);
    const slide = deck.nativeSlides[0]?.slide;
    if (slide === undefined) throw new Error('fixture must bind its first slide');
    slide.narration = { markdown: '同学们好，今天读《春》。' };
    await render(true, deck);

    const outline = container.querySelector('[data-reach-deck-outline]');
    expect(outline?.getAttribute('aria-label')).toBe('大纲');
    const items = [...(outline?.querySelectorAll('button') ?? [])];
    expect(items.map((item) => item.querySelector('[id]')?.textContent)).toEqual([
      '同学们好，今天读《春》。',
      '本页没有讲稿。',
      '本页没有讲稿。',
    ]);
    expect(items[0]?.getAttribute('aria-current')).toBe('page');
    expect(items[0]?.getAttribute('aria-describedby')).toBe(items[0]?.querySelector('[id]')?.id);
    expect(items[0]?.querySelector('[data-native-v2-slide-renderer]')).not.toBeNull();
    // 讲稿放得下时没有「更多」。
    expect(container.querySelector('[data-outline-more]')).toBeNull();

    await act(async () => button('2. 第二页').click());
    expect(activePage()).toBe(`${VERSION_ID}:page-2`);
    expect(button('2. 第二页').getAttribute('aria-current')).toBe('page');
  });

  it('clamps every outline script to the same height and opens the full script in a dialog', async () => {
    const deck = documentWithPages(3);
    const slide = deck.nativeSlides[0]?.slide;
    if (slide === undefined) throw new Error('fixture must bind its first slide');
    const longScript = '同学们好，今天读《春》。'.repeat(8);
    slide.narration = { markdown: longScript };
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-outline-script') && (this.textContent?.length ?? 0) > 20
          ? 120
          : 40;
      });
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    try {
      await render(true, deck);
      await act(async () => button('大纲').click());

      const more = [...container.querySelectorAll<HTMLButtonElement>('[data-outline-more]')];
      expect(more.map((element) => element.getAttribute('data-outline-more'))).toEqual([
        `${VERSION_ID}:page-1`,
      ]);
      expect(more[0]?.textContent).toBe('更多');
      expect(more[0]?.getAttribute('aria-label')).toBe('查看第 1 页完整讲稿');
      // 「更多」不嵌套在跳页按钮里，点它不切页。
      expect(more[0]?.closest('[data-outline-page-id]')).toBeNull();

      await act(async () => more[0]?.click());
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain('1. 第一页');
      expect(dialog?.textContent).toContain(longScript);
      expect(activePage()).toBe(`${VERSION_ID}:page-1`);
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it('scrolls only the outline list to keep the current page visible', async () => {
    const rects = new Map<string, DOMRect>();
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.hasAttribute('data-reach-deck-outline')) return new DOMRect(0, 100, 300, 200);
      const pageId = this.getAttribute('data-outline-page-id');
      const rect = pageId === null ? undefined : rects.get(pageId);
      return rect ?? original.call(this);
    };
    try {
      rects.set(`${VERSION_ID}:page-3`, new DOMRect(0, 420, 300, 80));
      launcherNavigation.completedPageIds = null;
      await render(true, documentWithPages(3));
      const outline = container.querySelector<HTMLElement>('[data-reach-deck-outline]')!;
      outline.scrollTop = 0;

      await act(async () => button('3. 第3页').click());
      // 列表底边在 300，第 3 页底边在 500：只把列表自身向下滚 200。
      expect(outline.scrollTop).toBe(200);
      const ancestors: number[] = [];
      for (let node = outline.parentElement; node !== null; node = node.parentElement) {
        ancestors.push(node.scrollTop);
      }
      expect(ancestors.every((value) => value === 0)).toBe(true);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it('locks page and track navigation only while the note canvas is open', async () => {
    await render(true, documentWithPages(2));

    await act(async () => {
      button('打开笔记画布').click();
    });
    expect(blocked(button('2. 第二页'))).toBe(true);
    expect(
      container.querySelector('[data-module-nav-trigger]')?.getAttribute('aria-expanded'),
    ).toBe('false');

    await act(async () => {
      button('关闭笔记画布').click();
    });
    expect(blocked(button('2. 第二页'))).toBe(false);
    expect(
      container.querySelector('[data-module-nav-trigger]')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('keeps the Tutor attempt scope while a new Deck page context catches up', async () => {
    await render(true, documentWithPages(2));

    await act(async () => {
      button('同步 Tutor 活动').click();
    });
    expect(
      container.querySelector('[data-tutor-attempt]')?.getAttribute('data-tutor-attempt'),
    ).toBe('33333333-3333-4333-8333-333333333333');
    expect(container.querySelector('[data-tutor-page]')?.getAttribute('data-tutor-page')).toBe(
      `${VERSION_ID}:page-1`,
    );

    await act(async () => {
      button('2. 第二页').click();
    });
    expect(
      container.querySelector('[data-tutor-attempt]')?.getAttribute('data-tutor-attempt'),
    ).toBe('33333333-3333-4333-8333-333333333333');
    expect(container.querySelector('[data-tutor-page]')?.getAttribute('data-tutor-page')).toBe(
      'pending',
    );

    await act(async () => {
      button('同步 Tutor 活动').click();
    });
    expect(container.querySelector('[data-tutor-page]')?.getAttribute('data-tutor-page')).toBe(
      `${VERSION_ID}:page-2`,
    );
  });

  async function finishOverlayAnimation() {
    const overlay = container.querySelector('[data-fence-overlay]');
    expect(overlay).not.toBeNull();
    await act(async () => overlay?.dispatchEvent(new Event('animationend', { bubbles: true })));
  }

  function ordinaryIsHidden() {
    return container.querySelector('.reach-tutor-ordinary')?.hasAttribute('inert');
  }

  async function closeOverlay(label: string) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click(),
    );
    await finishOverlayAnimation();
  }

  it('locks module and page rails and replaces ordinary Tutor for an active fence', async () => {
    await render(true, documentWithPages(2));
    await act(async () => button('收起侧栏', 'aria-label').click());
    await act(async () => {
      button('2. 第二页').click();
      button('触发学习围栏').click();
    });

    // 护栏对话在「AI 对话」页签进行：激活时自动展开右栏并切回该页签。
    expect(
      container.querySelector('[data-reach-deck-region="side-panel"]')?.getAttribute('data-state'),
    ).toBe('open');
    expect(
      [...container.querySelectorAll('[role="tab"]')]
        .find((tab) => tab.textContent === 'AI 对话')
        ?.getAttribute('aria-selected'),
    ).toBe('true');

    expect(
      container.querySelector('[data-active-page-id]')?.getAttribute('data-active-page-id'),
    ).toBe(`${VERSION_ID}:page-1`);
    expect(blocked(button('2. 第二页'))).toBe(true);
    expect(container.querySelector('.reach-deck-placeholder')).toBeNull();
    await finishOverlayAnimation();
    expect(container.querySelector('[data-fence-page]')).not.toBeNull();
    expect(container.textContent).toContain('Learning fence dialogue');
    expect(ordinaryIsHidden()).toBe(true);
    await act(async () => {
      (container.querySelector('[data-module-nav-trigger]') as HTMLButtonElement).click();
    });
    expect(document.querySelector('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps an active fence non-dismissible, then exposes a read-only revisitable card after mastery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (path.includes('/threads?sceneKey=')) return Response.json({ threads: [] });
        throw new Error(`unexpected request ${path}`);
      }),
    );
    await render(true, documentWithPages(2));
    await act(async () => button('触发学习围栏').click());

    await finishOverlayAnimation();
    expect(container.querySelector('[data-fence-locked="true"]')).not.toBeNull();
    expect(container.querySelector('.reach-tutor-fence-close')).toBeNull();
    await act(async () =>
      container
        .querySelector('[data-fence-overlay]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(container.querySelector('[data-fence-overlay-kind="active"]')).not.toBeNull();
    expect(ordinaryIsHidden()).toBe(true);

    await act(async () => {
      button('模拟 Tutor 判定').click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-fence-overlay-kind="mastered"]')).not.toBeNull();
    expect(container.textContent).toContain('恭喜通过');
    expect(blocked(button('2. 第二页'))).toBe(false);
    expect(ordinaryIsHidden()).toBe(true);
    await closeOverlay('离开对话');
    expect(ordinaryIsHidden()).toBe(false);

    await act(async () => button('打开围栏记录').click());
    await finishOverlayAnimation();
    expect(container.querySelector('[data-fence-locked="false"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="关闭学习对话"]')).not.toBeNull();
    expect(ordinaryIsHidden()).toBe(true);

    await closeOverlay('关闭学习对话');
    expect(container.textContent).toContain('Discussion');
  });

  it('restores the completed fence card from its persisted Tutor Thread after refresh', async () => {
    const attempt = activeAttempt();
    const fenceScope = {
      selectionId: SELECTION_ID,
      moduleVersionId: VERSION_ID,
      attemptId: attempt.attemptId,
      tutorDomain: 'learning_fence',
      fenceId: '55555555-5555-4555-8555-555555555555',
      pageId: `${VERSION_ID}:page-1`,
      questionId: 'question-1',
      sceneId: `scene-${VERSION_ID}:page-1`,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (path.includes('/threads?sceneKey=')) {
          return Response.json({
            threads: [
              {
                id: 'fence-thread',
                createdAt: '2026-08-04T10:00:00.000Z',
                updatedAt: '2026-08-04T10:01:00.000Z',
                domainScope: fenceScope,
              },
            ],
          });
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    await render(true, documentWithPages(2), 'zh-CN', attempt);
    await vi.waitFor(() => expect(container.textContent).toContain('Discussion'));
    await act(async () => button('同步 Tutor 活动').click());
    await vi.waitFor(() => expect(container.textContent).toContain('打开围栏记录'));

    await act(async () => button('打开围栏记录').click());
    await finishOverlayAnimation();
    expect(container.querySelector('[data-fence-page]')?.getAttribute('data-fence-page')).toBe(
      `${VERSION_ID}:page-1`,
    );
    expect(container.querySelector('[data-fence-locked="false"]')).not.toBeNull();
  });

  it('keeps an active conversation locked and recoverable when the mastery check fails', async () => {
    let recoveryFails = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('/threads?')) return Response.json({ threads: [] });
        return recoveryFails
          ? Response.json({ error: 'unavailable' }, { status: 503 })
          : Response.json({ fence: null });
      }),
    );
    await render(true, documentWithPages(2));
    await act(async () => button('触发学习围栏').click());
    await finishOverlayAnimation();
    const transcript = container.querySelector('[data-fence-page]');
    await act(async () => button('模拟 Tutor 判定').click());

    expect(container.querySelector('[data-fence-page]')).toBe(transcript);
    expect(container.querySelector('[data-fence-overlay-kind="active"]')).not.toBeNull();
    expect(container.querySelector('.reach-tutor-fence-close')).toBeNull();
    expect(blocked(button('2. 第二页'))).toBe(true);
    expect(container.textContent).toContain('必修学习状态恢复失败');
    expect(container.textContent).not.toContain('恭喜通过');

    recoveryFails = false;
    await act(async () => button('重试恢复').click());
    expect(container.querySelector('[data-fence-page]')).toBe(transcript);
    expect(container.querySelector('[data-fence-overlay-kind="mastered"]')).not.toBeNull();
    expect(blocked(button('2. 第二页'))).toBe(false);
  });

  it('restores every completed fence conversation and ignores empty fence Threads', async () => {
    const attempt = activeAttempt();
    const scope = (fenceId: string, page: number) => ({
      selectionId: SELECTION_ID,
      moduleVersionId: VERSION_ID,
      attemptId: attempt.attemptId,
      tutorDomain: 'learning_fence',
      fenceId,
      pageId: `${VERSION_ID}:page-${page}`,
      questionId: `question-${page}`,
      sceneId: `scene-${VERSION_ID}:page-${page}`,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (path.includes('/threads?sceneKey=')) {
          return Response.json({
            threads: [
              {
                id: 'fence-thread-1',
                createdAt: '2026-08-04T10:00:00.000Z',
                updatedAt: '2026-08-04T10:00:01.000Z',
                domainScope: scope('fence-1', 1),
              },
              {
                id: 'empty-thread',
                createdAt: '2026-08-04T10:01:00.000Z',
                updatedAt: '2026-08-04T10:01:00.000Z',
                domainScope: scope('empty-fence', 1),
              },
              {
                id: 'fence-thread-2',
                createdAt: '2026-08-04T10:02:00.000Z',
                updatedAt: '2026-08-04T10:02:01.000Z',
                domainScope: scope('fence-2', 2),
              },
            ],
          });
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    await render(true, documentWithPages(2), 'zh-CN', attempt);
    await act(async () => button('同步 Tutor 活动').click());
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll('button')].filter((candidate) =>
          candidate.textContent?.includes('打开围栏记录'),
        ),
      ).toHaveLength(2),
    );
    expect(container.textContent).not.toContain('empty-fence');

    await act(async () => button('打开围栏记录 fence-2').click());
    await finishOverlayAnimation();
    expect(container.querySelector('[data-fence-page]')?.getAttribute('data-fence-page')).toBe(
      `${VERSION_ID}:page-2`,
    );
  });

  it('keeps navigation locked until authoritative fence recovery succeeds', async () => {
    let recoveryFails = true;
    const fetchImpl = vi.fn(async () =>
      recoveryFails
        ? Response.json({ error: 'unavailable' }, { status: 503 })
        : Response.json({ fence: null }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    await render(true, documentWithPages(2), 'zh-CN', activeAttempt());

    expect(container.textContent).toContain('必修学习状态恢复失败');
    expect(blocked(button('2. 第二页'))).toBe(true);
    await act(async () => {
      (container.querySelector('[data-module-nav-trigger]') as HTMLButtonElement).click();
    });
    expect(document.querySelector('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).not.toContain('Discussion');

    recoveryFails = false;
    await act(async () => {
      button('重试恢复').click();
      await Promise.resolve();
    });

    expect(blocked(button('2. 第二页'))).toBe(false);
    expect(container.textContent).toContain('Discussion');
  });

  it('locks unvisited pages before the player reports progress and explains why', async () => {
    launcherNavigation.report = false;
    await render(true, documentWithPages(3));

    const second = button('2. 第二页');
    expect(blocked(button('1. 第一页'))).toBe(false);
    expect(blocked(second)).toBe(true);
    expect(second.getAttribute('data-page-status')).toBe('locked');
    expect(second.getAttribute('data-tooltip')).toBe('学完前面的页面后解锁本页。');
    expect(second.textContent).toContain('未解锁');
    // 还没学到的页不渲染缩略图，只有「未学习」占位。
    expect(second.querySelector('[data-native-v2-slide-renderer]')).toBeNull();
    expect(second.querySelector('[data-not-learned="true"]')?.textContent).toBe('未学习');
    expect(button('1. 第一页').querySelector('[data-not-learned]')).toBeNull();
    // 讲稿也不开放：只有一句说明，不参与「更多」的测量。
    const lockedScript = document.getElementById(second.getAttribute('aria-describedby')!);
    expect(lockedScript?.textContent).toBe('学到本页后开放讲稿。');
    expect(lockedScript?.hasAttribute('data-outline-script')).toBe(false);

    await act(async () => second.click());

    expect(activePage()).toBe(`${VERSION_ID}:page-1`);
    expect(container.querySelector('[data-reach-deck-page-block-notice]')?.textContent).toBe(
      '学完前面的页面后解锁本页。',
    );
    expect(
      container.querySelector('[data-reach-deck-page-block-notice]')?.getAttribute('role'),
    ).toBe('status');
  });

  it('restores completed pages and the frontier from server progress', async () => {
    launcherNavigation.report = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (path.includes('/threads?sceneKey=')) return Response.json({ threads: [] });
        throw new Error(`unexpected request ${path}`);
      }),
    );
    await render(true, documentWithPages(4), 'zh-CN', activeAttempt(), {
      attemptId: '33333333-3333-4333-8333-333333333333',
      completedPageIds: [`${VERSION_ID}:page-1`, `${VERSION_ID}:page-4`],
      coverageComplete: false,
      coverageKnown: true,
      firstIncompletePageId: `${VERSION_ID}:page-2`,
      moduleVersionId: VERSION_ID,
      progress: 50,
      selectionId: SELECTION_ID,
      status: 'in_progress',
    });

    expect(blocked(button('1. 第一页'))).toBe(false);
    expect(button('1. 第一页').getAttribute('data-page-status')).toBe('completed');
    expect(blocked(button('2. 第二页'))).toBe(false);
    expect(blocked(button('3. 第3页'))).toBe(true);
    // 靠后的已完成页仍可回看。
    expect(blocked(button('4. 第4页'))).toBe(false);
  });

  it('unlocks the next page once the player reports the current page complete', async () => {
    launcherNavigation.completedPageIds = [`${VERSION_ID}:page-1`];
    await render(true, documentWithPages(3));

    expect(blocked(button('2. 第二页'))).toBe(false);
    expect(blocked(button('3. 第3页'))).toBe(true);
    await act(async () => button('3. 第3页').click());
    expect(activePage()).toBe(`${VERSION_ID}:page-1`);

    launcherNavigation.completedPageIds = [`${VERSION_ID}:page-1`, `${VERSION_ID}:page-2`];
    await act(async () => button('同步导航状态').click());

    expect(blocked(button('3. 第3页'))).toBe(false);
    await act(async () => button('3. 第3页').click());
    expect(activePage()).toBe(`${VERSION_ID}:page-3`);
  });

  it('re-measures outline scripts when a page unlocks so a long script gets its more button', async () => {
    const deck = documentWithPages(3);
    const binding = deck.nativeSlides[0];
    if (binding === undefined) throw new Error('fixture must bind its first slide');
    const third = { ...structuredClone(binding), pageId: `${VERSION_ID}:page-3` };
    third.slide.narration = { markdown: '同学们好，今天读《春》。'.repeat(8) };
    deck.nativeSlides.push(third);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-outline-script') && (this.textContent?.length ?? 0) > 20
          ? 120
          : 40;
      });
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    try {
      launcherNavigation.completedPageIds = [`${VERSION_ID}:page-1`];
      await render(true, deck);
      await act(async () => button('大纲').click());
      expect(container.querySelector('[data-outline-more]')).toBeNull();

      // 大纲保持打开、列表尺寸不变，只是第 3 页解锁了。
      launcherNavigation.completedPageIds = [`${VERSION_ID}:page-1`, `${VERSION_ID}:page-2`];
      await act(async () => button('同步导航状态').click());

      expect(
        [...container.querySelectorAll('[data-outline-more]')].map((element) =>
          element.getAttribute('data-outline-more'),
        ),
      ).toEqual([`${VERSION_ID}:page-3`]);
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it('locks thumbnails and discussion jumps with the player while fenced grading is pending', async () => {
    launcherNavigation.fencedGrading = true;
    await render(true, documentWithPages(3));

    const second = button('2. 第二页');
    expect(blocked(second)).toBe(true);
    expect(second.getAttribute('data-page-status')).toBe('completed');
    expect(second.getAttribute('data-tooltip')).toBe(
      '本页学习护栏题正在批改，批改完成后才能切换页面。',
    );
    await act(async () => second.click());
    await act(async () => button('讨论区跳到第三页').click());
    expect(activePage()).toBe(`${VERSION_ID}:page-1`);

    launcherNavigation.fencedGrading = false;
    await act(async () => button('同步导航状态').click());
    expect(blocked(button('2. 第二页'))).toBe(false);
    await act(async () => button('讨论区跳到第三页').click());
    expect(activePage()).toBe(`${VERSION_ID}:page-3`);
  });

  it('localizes page lock reasons and status copy in English', async () => {
    launcherNavigation.report = false;
    await render(true, documentWithPages(2), 'en-US');

    const second = button('2. 第二页');
    expect(second.getAttribute('data-tooltip')).toBe(
      'Finish the earlier pages to unlock this page.',
    );
    expect(second.textContent).toContain('Locked');
    await act(async () => second.click());
    expect(container.textContent).toContain('Finish the earlier pages to unlock this page.');

    await act(async () => button('打开笔记画布').click());
    expect(button('2. 第二页').getAttribute('data-tooltip')).toBe(
      'Close the note canvas to switch pages.',
    );
  });

  it('localizes module navigation, locked-module copy, and accessibility copy in English', async () => {
    await render(false, undefined, 'en-US');

    expect(container.textContent).toContain('Locked module');
    expect(container.textContent).toContain('studied in order');
    expect(container.textContent).toContain('科学课');
    expect(container.textContent).toContain('Previous');
    expect(container.textContent).toContain('Next');
    expect(container.querySelector('[data-module-nav-trigger]')?.textContent).toContain(
      'Open track module list',
    );
    expect(container.querySelector('[aria-label="Outline"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Learning side panel"]')).not.toBeNull();
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'AI chat',
      'Script',
      'Outline',
    ]);
    expect(container.querySelector('button[aria-label="Collapse the side panel"]')).not.toBeNull();
  });

  async function render(
    available: boolean,
    document = createBlankReachDeckDocument({ id: VERSION_ID, title: '学习课件' }),
    locale: 'en-US' | 'zh-CN' = 'zh-CN',
    initialAttempt: React.ComponentProps<typeof StudentReachDeckWorkspace>['initialAttempt'] = null,
    initialAttemptProgress: React.ComponentProps<
      typeof StudentReachDeckWorkspace
    >['initialAttemptProgress'] = null,
  ) {
    await act(async () => {
      root.render(
        <PortalI18nProvider locale={locale}>
          <StudentLearningPage
            body="contained"
            railItems={[railItem(available)]}
            selectionId={SELECTION_ID}
            title="Deck"
            trackName="暑期轨道"
          >
            <StudentReachDeckWorkspace
              courseId={null}
              courseNodeId={null}
              document={document}
              initialAttempt={initialAttempt}
              initialAttemptProgress={initialAttemptProgress}
              moduleVersionId={VERSION_ID}
              moduleId={null}
              railItems={[railItem(available)]}
              selectionId={SELECTION_ID}
            />
          </StudentLearningPage>
        </PortalI18nProvider>,
      );
    });
    // 大纲在右栏第三个页签：先切过去，锁定与跳转断言都针对大纲条目。
    const outlineTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent === (locale === 'en-US' ? 'Outline' : '大纲'),
    );
    if (outlineTab !== undefined) await act(async () => outlineTab.click());
  }

  function activeAttempt() {
    return {
      applied: false,
      attemptId: '33333333-3333-4333-8333-333333333333',
      attemptNumber: 1,
      completedAt: null,
      lastActivityAt: '2026-08-04T10:00:00.000Z',
      moduleVersionId: VERSION_ID,
      progress: 0,
      score: null,
      selectionId: SELECTION_ID,
      startedAt: '2026-08-04T10:00:00.000Z',
      status: 'in_progress' as const,
    };
  }

  function blocked(element: HTMLElement): boolean {
    return element.getAttribute('aria-disabled') === 'true';
  }

  function activePage(): string | null | undefined {
    return container.querySelector('[data-active-page-id]')?.getAttribute('data-active-page-id');
  }

  function button(label: string, attribute?: 'aria-label'): HTMLButtonElement {
    const match = [...container.querySelectorAll('button')].find((candidate) =>
      attribute === undefined
        ? candidate.textContent?.includes(label)
        : candidate.getAttribute(attribute) === label,
    );
    if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
    return match;
  }
});

function documentWithPages(pageCount: number) {
  const document = createBlankReachDeckDocument({ id: VERSION_ID, title: '第一页' });
  const firstPage = document.pages[0];
  if (firstPage === undefined) throw new Error('Blank document must have a first page.');
  document.pages = Array.from({ length: pageCount }, (_, index) => ({
    ...structuredClone(firstPage),
    order: index + 1,
    pageId: `${VERSION_ID}:page-${index + 1}`,
    title: index === 0 ? '第一页' : index === 1 ? '第二页' : `第${index + 1}页`,
  }));
  return document;
}

function railItem(available: boolean): StudentReachDeckRailItem {
  return {
    available,
    courseName: '科学课',
    durationMinutes: 45,
    href: `/student/reach-deck/${SELECTION_ID}`,
    isFuture: false,
    moduleTitle: '学习课件',
    moduleType: 'reach-deck',
    progress: 0,
    scheduledAt: '2026-07-29T09:00',
    selectionId: SELECTION_ID,
    state: 'not_started',
    unavailableReason: available ? null : 'sequential_locked',
  };
}
