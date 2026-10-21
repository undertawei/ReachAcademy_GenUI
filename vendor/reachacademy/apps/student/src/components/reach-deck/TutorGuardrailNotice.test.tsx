// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  DirectedTutorDiscussion,
  TutorDiscussion,
  type DirectedTutorMessage,
  type UseDirectedTutorThreadResult,
} from '@reachany/tutor-ui';
import { createPortalTranslator } from '@/src/lib/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const richText = {
  createExtensions: () => [StarterKit],
  serialize: () => '',
  MessageContent: ({ markdown }: { markdown: string }) => <p>{markdown}</p>,
};

describe('Tutor safety stop rendering', () => {
  it.each(
    (['zh-CN', 'en-US'] as const).flatMap((locale) =>
      (['learning-fence', 'ordinary'] as const).flatMap((variant) =>
        (['failed', 'cancelled', 'completed', 'streaming'] as const).map((status) => ({
          locale,
          variant,
          status,
        })),
      ),
    ),
  )('distinguishes $status prefixes in $locale/$variant', async ({ locale, variant, status }) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const t = createPortalTranslator(locale);
    try {
      await act(async () =>
        root.render(
          <TutorDiscussion
            variant={variant}
            contextReady
            locale={locale}
            pages={[]}
            richText={richText}
            t={t}
            onSubmit={vi.fn()}
            thread={{
              entries: [
                {
                  key: 'run-1',
                  question: 'Question',
                  answer: 'Delivered prefix',
                  status,
                  votes: { question: 'none', answer: 'none' },
                },
              ],
              threadReady: true,
              busy: false,
              error: '',
              cancel: vi.fn(),
              vote: vi.fn(),
            }}
          />,
        ),
      );
      expect(host.textContent).toContain('Delivered prefix');
      const notices = host.querySelectorAll('[role="status"]');
      if (status === 'failed' || status === 'cancelled') {
        expect(notices).toHaveLength(1);
        expect(notices[0]?.textContent).toBe(
          t(status === 'failed' ? 'student.tutor.incomplete' : 'student.tutor.stopped'),
        );
      } else expect(notices).toHaveLength(0);
      expect(host.textContent).not.toContain(t('tutorDiscussion.guardrailBlocked'));
      expect(host.textContent).not.toContain(t('student.tutor.thinking'));
    } finally {
      await act(async () => root.unmount());
    }
  });

  it.each([
    ['zh-CN', 'learning-fence', 'GUARDRAIL_BLOCKED'],
    ['en-US', 'learning-fence', 'GUARDRAIL_UNAVAILABLE'],
    ['en-US', 'ordinary', 'GUARDRAIL_BLOCKED'],
    ['zh-CN', 'ordinary', 'GUARDRAIL_UNAVAILABLE'],
  ] as const)('retains the %s %s prefix on %s', async (locale, variant, code) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const t = createPortalTranslator(locale);
    try {
      await act(async () =>
        root.render(
          <TutorDiscussion
            variant={variant}
            contextReady
            locale={locale}
            pages={[]}
            richText={richText}
            t={t}
            onSubmit={vi.fn()}
            thread={{
              entries: [
                {
                  key: 'run-1',
                  question: 'Question',
                  answer: 'Reviewed prefix',
                  status: 'failed',
                  guardrailStopCode: code,
                  votes: { question: 'none', answer: 'none' },
                },
              ],
              threadReady: true,
              busy: false,
              error: '',
              cancel: vi.fn(),
              vote: vi.fn(),
            }}
          />,
        ),
      );
      expect(host.textContent).toContain('Reviewed prefix');
      expect(host.textContent).toContain(t('tutorDiscussion.guardrailTruncated'));
      expect(host.textContent).toContain(
        t(
          code === 'GUARDRAIL_BLOCKED'
            ? 'tutorDiscussion.guardrailBlocked'
            : 'tutorDiscussion.guardrailUnavailable',
        ),
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('shows a stop notice without claiming truncation when nothing was released', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const t = createPortalTranslator('zh-CN');
    try {
      await act(async () =>
        root.render(
          <TutorDiscussion
            variant="learning-fence"
            contextReady
            locale="zh-CN"
            pages={[]}
            richText={richText}
            t={t}
            onSubmit={vi.fn()}
            thread={{
              entries: [
                {
                  key: 'run-1',
                  question: 'Question',
                  answer: '',
                  status: 'failed',
                  guardrailStopCode: 'GUARDRAIL_BLOCKED',
                  votes: { question: 'none', answer: 'none' },
                },
              ],
              threadReady: true,
              busy: false,
              error: '',
              cancel: vi.fn(),
              vote: vi.fn(),
            }}
          />,
        ),
      );
      expect(host.textContent).toContain(t('tutorDiscussion.guardrailBlocked'));
      expect(host.textContent).not.toContain(t('tutorDiscussion.guardrailTruncated'));
      expect(host.textContent).not.toContain(t('student.tutor.thinking'));
    } finally {
      await act(async () => root.unmount());
    }
  });
  it.each(['zh-CN', 'en-US'] as const)(
    'retains a directed approved prefix and localized guidance in %s',
    async (locale) => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const t = createPortalTranslator(locale);
      const message: DirectedTutorMessage = {
        id: 'message-1',
        sequenceNumber: 2,
        authorKind: 'default_tutor',
        content: 'Reviewed prefix',
        status: 'failed',
        guardrailStopCode: 'GUARDRAIL_BLOCKED',
        contextWatermark: 1,
        generationEpoch: 0,
        createdAt: '2026-10-11T00:00:00Z',
        feedbackVote: 'none',
      };
      const actor: DirectedTutorMessage = {
        ...message,
        id: 'actor-1',
        sequenceNumber: 1,
        authorKind: 'actor',
        status: 'completed',
        guardrailStopCode: undefined,
        content: 'Question',
      };
      const thread = {
        messages: [actor, message],
        roster: [],
        initializing: false,
        unavailable: false,
        busy: false,
        submissionPending: false,
        threadReady: true,
        error: '',
        submit: vi.fn(),
        vote: vi.fn(),
        cancel: vi.fn(),
        clearRetryIfChanged: vi.fn(),
        refreshRoster: vi.fn(),
      } as UseDirectedTutorThreadResult;
      try {
        await act(async () =>
          root.render(
            <DirectedTutorDiscussion
              ariaLabel="Tutor"
              contextReady
              emptyText="Empty"
              locale={locale}
              resolveLearningContext={() => ({})}
              richText={richText}
              subtitle=""
              t={t}
              thread={thread}
              waitingText="Wait"
            />,
          ),
        );
        expect(host.textContent).toContain('Reviewed prefix');
        expect(host.textContent).toContain(t('tutorDiscussion.guardrailTruncated'));
        expect(host.textContent).toContain(t('tutorDiscussion.guardrailBlocked'));
        expect(host.textContent).not.toContain(t('tutorDiscussion.directed.failed'));
        expect(host.querySelector('[data-tutor-guardrail-stop]')?.getAttribute('role')).toBe(
          'status',
        );
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );
});
