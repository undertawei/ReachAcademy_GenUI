// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';

import { StudentReachDeckAttemptLauncher } from './StudentReachDeckAttemptLauncher';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@reachany/ui', () => ({
  BrandLoader: ({ label }: { label: string }) => <span aria-label={label} role="status" />,
  Button: ({
    children,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock('./StudentReachDeckAttemptPlayer', () => ({
  StudentReachDeckAttemptPlayer: ({
    attempt,
    initialProgress,
    onLearningEventDeliveryFailure,
  }: {
    attempt: { attemptId: string };
    initialProgress?: { completedPageIds: string[] } | null;
    onLearningEventDeliveryFailure?: (failure: unknown) => void;
  }) => (
    <div
      data-attempt-id={attempt.attemptId}
      data-completed-page-ids={initialProgress?.completedPageIds.join(',') ?? ''}
    >
      Attempt player
      <button onClick={() => onLearningEventDeliveryFailure?.({ count: 1, reason: 'rejected' })}>
        fail delivery
      </button>
    </div>
  ),
}));

const ATTEMPT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const VERSION_ID = '99999999-9999-4999-8999-999999999999';
const SELECTION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOW = '2026-07-22T08:00:00.000Z';

describe('StudentReachDeckAttemptLauncher', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.restoreAllMocks();
  });

  it('creates the attempt on first entry without a manual start step', async () => {
    let releaseAttempt: (response: Response) => void = () => undefined;
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/progress')
        ? Response.json(progress())
        : new Promise<Response>((resolve) => {
            releaseAttempt = resolve;
          }),
    );
    await render(null);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/student/reach-deck/track-modules/${SELECTION_ID}/attempts`,
      { method: 'POST' },
    );
    // 建好之前只有品牌 loading，没有「开始学习」这一步。
    expect(container.querySelector('[data-student-player-loading] [role="status"]')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('');

    await act(async () => {
      releaseAttempt(Response.json(attempt()));
    });

    expect(container.querySelector('[data-attempt-id]')?.getAttribute('data-attempt-id')).toBe(
      ATTEMPT_ID,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/student/reach-deck/attempts/${ATTEMPT_ID}/progress`,
      { cache: 'no-store', method: 'GET' },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not create another attempt when one already exists', async () => {
    const fetchImpl = vi.spyOn(globalThis, 'fetch');
    await render(summary());

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(container.querySelector('[data-attempt-id]')).not.toBeNull();
  });

  it('renders a completed attempt without a re-study action', async () => {
    await render(summary('completed'));

    expect(container.querySelector('[data-attempt-id]')).not.toBeNull();
    expect(container.textContent).not.toContain('再学一次');
    expect(container.querySelector('[data-attempt-id]')?.parentElement?.className).not.toContain(
      'bg-[#fdfcfc]',
    );
  });

  it('surfaces learning-event delivery failures to the host console signal', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await render(summary());

    await act(async () => {
      button('fail delivery').click();
    });

    expect(warning).toHaveBeenCalledWith(
      'Reach Deck learning event delivery failed',
      expect.objectContaining({ count: 1, reason: 'rejected' }),
    );
  });

  it('fails closed when a newly created attempt has another module version', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(attempt({ moduleVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
    );
    const blocked = vi.fn();
    await render(null, 'zh-CN', blocked);

    expect(container.querySelector('[data-attempt-id]')).toBeNull();
    expect(container.textContent).toContain('新学习尝试与该轨道选定的版本不匹配。');
    expect(blocked).toHaveBeenLastCalledWith(true);
  });

  it('does not render backend error details and lets the learner retry', async () => {
    const fetchImpl = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ error: 'downstream database details' }, { status: 503 }),
      )
      .mockImplementation(async (input) =>
        String(input).endsWith('/progress') ? Response.json(progress()) : Response.json(attempt()),
      );
    const blocked = vi.fn();
    await render(null, 'zh-CN', blocked);

    expect(container.textContent).toContain('开始学习失败。');
    expect(container.textContent).not.toContain('downstream database details');
    expect(blocked).toHaveBeenLastCalledWith(true);
    // 失败后不自动重试，等学生点「重试」。
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await act(async () => {
      button('重试').click();
    });

    expect(container.querySelector('[data-attempt-id]')).not.toBeNull();
    expect(blocked).toHaveBeenLastCalledWith(false);
  });

  it('treats an attempt that is still abandoned as a failed start', async () => {
    const fetchImpl = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json(attempt({ status: 'abandoned' })));
    await render(null);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-attempt-id]')).toBeNull();
    expect(container.textContent).toContain('开始学习失败。');
  });

  it('renders the loading label and failure copy in English', async () => {
    let rejectAttempt: (reason: unknown) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectAttempt = reject;
        }),
    );
    await render(null, 'en-US');

    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      'Starting…',
    );

    await act(async () => {
      rejectAttempt(null);
    });

    expect(container.textContent).toContain('Could not start learning.');
    expect(button('Try again')).toBeDefined();
  });

  async function render(
    initialAttempt: ReturnType<typeof summary> | null,
    locale: 'en-US' | 'zh-CN' = 'zh-CN',
    onStartBlockedChange?: (blocked: boolean) => void,
  ) {
    await act(async () => {
      root.render(
        <PortalI18nProvider locale={locale}>
          <StudentReachDeckAttemptLauncher
            document={createBlankReachDeckDocument({ id: VERSION_ID, title: 'Lesson' })}
            initialAttempt={initialAttempt}
            moduleVersionId={VERSION_ID}
            onStartBlockedChange={onStartBlockedChange}
            selectionId={SELECTION_ID}
          />
        </PortalI18nProvider>,
      );
    });
  }

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
    if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
    return match;
  }
});

function summary(status: 'completed' | 'in_progress' = 'in_progress') {
  return {
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    completedAt: status === 'completed' ? NOW : null,
    lastActivityAt: NOW,
    moduleVersionId: VERSION_ID,
    progress: status === 'completed' ? 100 : 0,
    score: null,
    selectionId: SELECTION_ID,
    startedAt: NOW,
    status,
  } as const;
}

function attempt(overrides: Record<string, unknown> = {}) {
  return { applied: true, ...summary(), ...overrides };
}

function progress(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT_ID,
    completedPageIds: [],
    coverageComplete: false,
    coverageKnown: true,
    firstIncompletePageId: `${VERSION_ID}:page-1`,
    moduleVersionId: VERSION_ID,
    progress: 0,
    selectionId: SELECTION_ID,
    status: 'in_progress',
    ...overrides,
  };
}
