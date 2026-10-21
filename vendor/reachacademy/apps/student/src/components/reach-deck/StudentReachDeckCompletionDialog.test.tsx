// @vitest-environment jsdom

import { studentLearningEntryHref } from '@/src/lib/student-learning-entry';

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import { StudentLearningPage } from '@/src/components/student/StudentLearningPage';
import type { StudentReachDeckRailItem } from '@/src/lib/student-reach-deck-workspace';

import { StudentReachDeckCompletionDialog } from './StudentReachDeckCompletionDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const origin = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ from: origin.value }),
  useRouter: () => ({ push: vi.fn() }),
}));

const railItem = (
  selectionId: string,
  moduleTitle: string,
  overrides: Partial<StudentReachDeckRailItem> = {},
): StudentReachDeckRailItem => ({
  available: true,
  courseName: '语文',
  durationMinutes: null,
  href: `/student/reach-deck/${selectionId}`,
  isFuture: false,
  moduleTitle,
  moduleType: 'reach-deck',
  progress: 0,
  scheduledAt: null,
  selectionId,
  state: 'not_started',
  unavailableReason: null,
  ...overrides,
});

describe('StudentReachDeckCompletionDialog', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    origin.value = '';
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function renderDialog(
    props: Partial<ComponentProps<typeof StudentReachDeckCompletionDialog>> = {},
    { locale = 'zh-CN', nextAvailable = true, finalModule = false } = {},
  ) {
    const onGoToFirstIncomplete = vi.fn();
    act(() =>
      root.render(
        <PortalI18nProvider locale={locale as 'zh-CN' | 'en-US'}>
          <StudentLearningPage
            backHref="/student/track-detail?track=t1"
            railItems={[
              railItem('deck-1', '走进《春》'),
              ...(finalModule
                ? []
                : [
                    railItem('quiz-2', '春天小测', {
                      available: nextAvailable,
                      unavailableReason: nextAvailable ? null : 'sequential_locked',
                    }),
                  ]),
            ]}
            selectionId="deck-1"
            template="player"
            title="走进《春》"
          >
            <StudentReachDeckCompletionDialog
              attemptCompleted
              completedPages={21}
              confirmation={{ status: 'ready' }}
              firstIncompletePageNumber={null}
              gradingPending={false}
              moduleTitle="走进《春》"
              onGoToFirstIncomplete={onGoToFirstIncomplete}
              onOpenChange={() => undefined}
              onRetry={() => undefined}
              open
              totalPages={21}
              {...props}
            />
          </StudentLearningPage>
        </PortalI18nProvider>,
      ),
    );
    return { onGoToFirstIncomplete };
  }

  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
  const link = (name: string) =>
    [...(dialog()?.querySelectorAll('a') ?? [])].find((anchor) => anchor.textContent === name);

  it('congratulates and links back to the track and on to the next module', () => {
    renderDialog({ gradingPending: true });

    expect(dialog()?.textContent).toContain('恭喜完成本模块！');
    expect(dialog()?.textContent).toContain('你已学完「走进《春》」的全部 21 页。');
    expect(dialog()?.textContent).toContain('还有题目在批改中');
    expect(dialog()?.textContent).toContain('春天小测');
    expect(link('返回学习轨道')?.getAttribute('href')).toBe('/student/track-detail?track=t1');
    expect(link('下一模块')?.getAttribute('href')).toBe(
      studentLearningEntryHref('/student/reach-deck/quiz-2', {
        title: '春天小测',
        moduleType: 'reach-deck',
      }),
    );
  });

  it('offers a Today return and preserves the source in the next-module action', () => {
    origin.value = 'today';
    renderDialog();
    expect(link('返回今日学习')?.getAttribute('href')).toBe('/student/today');
    expect(link('下一模块')?.getAttribute('href')).toBe(
      studentLearningEntryHref('/student/reach-deck/quiz-2?from=today', {
        title: '春天小测',
        moduleType: 'reach-deck',
      }),
    );
  });

  it('offers to keep reviewing when the next module is not open yet', () => {
    renderDialog({}, { nextAvailable: false });

    expect(link('下一模块')).toBeUndefined();
    expect(dialog()?.textContent).toContain('春天小测');
    expect(dialog()?.textContent).toContain('这条轨道要求顺序学习，请先完成前面的模块。');
    expect(dialog()?.textContent).toContain('继续回看');
  });

  it('sends the learner to the first unlearned page while pages remain', () => {
    const { onGoToFirstIncomplete } = renderDialog({
      attemptCompleted: false,
      completedPages: 19,
      firstIncompletePageNumber: 10,
    });

    expect(dialog()?.textContent).toContain('还有 2 页没学完');
    const goTo = [...dialog()!.querySelectorAll('button')].find(
      (button) => button.textContent === '去第 10 页',
    );
    act(() => goTo!.click());
    expect(onGoToFirstIncomplete).toHaveBeenCalledTimes(1);
  });

  it('localizes both states in English', () => {
    renderDialog({}, { locale: 'en-US' });
    expect(dialog()?.textContent).toContain('Congratulations, module complete!');
    expect(link('Next module')).toBeDefined();

    renderDialog(
      { attemptCompleted: false, completedPages: 20, firstIncompletePageNumber: 21 },
      { locale: 'en-US' },
    );
    expect(dialog()?.textContent).toContain('Pages left to study: 1');
    expect(dialog()?.textContent).toContain('Go to page 21');
    expect(dialog()?.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });

  it.each(['zh-CN', 'en-US'])(
    'never congratulates unconfirmed coverage and exposes checking, pending and retry copy in %s',
    (locale) => {
      renderDialog({ attemptCompleted: false, confirmation: { status: 'checking' } }, { locale });
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        locale === 'zh-CN'
          ? '正在同步学习记录并核对进度…'
          : 'Syncing your learning records and checking progress…',
      );
      expect(dialog()?.textContent).not.toContain(locale === 'zh-CN' ? '恭喜' : 'Congratulations');

      renderDialog({ attemptCompleted: false }, { locale });
      expect(dialog()?.textContent).toContain(
        locale === 'zh-CN' ? '正在等待完成确认' : 'Waiting for completion confirmation',
      );
      expect(dialog()?.textContent).not.toContain(locale === 'zh-CN' ? '恭喜' : 'Congratulations');

      const onRetry = vi.fn();
      renderDialog(
        {
          attemptCompleted: false,
          confirmation: { status: 'error', message: 'A failed read' },
          onRetry,
        },
        { locale },
      );
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('A failed read');
      const retry = [...dialog()!.querySelectorAll('button')].find(
        (button) => button.textContent === (locale === 'zh-CN' ? '重新核对' : 'Check again'),
      )!;
      act(() => retry.click());
      expect(onRetry).toHaveBeenCalledOnce();
    },
  );

  it('keeps a genuine final module on return and review actions', () => {
    renderDialog({}, { finalModule: true });
    expect(link('下一模块')).toBeUndefined();
    expect(dialog()?.textContent).not.toContain('春天小测');
    expect(dialog()?.textContent).toContain('继续回看');
  });
});
