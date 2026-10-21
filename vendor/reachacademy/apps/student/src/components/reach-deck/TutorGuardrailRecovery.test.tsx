// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalI18nProvider } from '../PortalI18nProvider';
import { StudentReachDeckConversation } from './StudentReachDeckConversation';
import { createPortalTranslator } from '@/src/lib/i18n';

vi.mock('./tutor-rich-text-adapter', () => ({
  tutorRichTextAdapter: {
    createExtensions: () => [StarterKit],
    serialize: () => '',
    MessageContent: ({ markdown }: { markdown: string }) => <p>{markdown}</p>,
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  static readonly CLOSED = 2;
  readonly readyState = 1;
  private listeners = new Map<string, (event: MessageEvent) => void>();
  constructor(readonly url: string) {
    EventSourceStub.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(payload) }));
  }
  close() {}
}

afterEach(() => vi.unstubAllGlobals());

describe('current learning-fence Tutor terminal prefix recovery', () => {
  it.each(
    (['zh-CN', 'en-US'] as const).flatMap((locale) => [
      ...(['GUARDRAIL_BLOCKED', 'GUARDRAIL_UNAVAILABLE'] as const).flatMap((code) =>
        (['run.guardrail_stopped', 'run.failed'] as const).map((eventType) => ({
          locale,
          code,
          eventType,
        })),
      ),
      ...(['MODEL_FAILED', 'MODEL_TIMEOUT', 'RUN_CANCELLED'] as const).map((code) => ({
        locale,
        code,
        eventType: code === 'RUN_CANCELLED' ? 'run.cancelled' : 'run.failed',
      })),
    ]),
  )(
    'shows one live and restored notice ($locale/$code/$eventType)',
    async ({ locale, code, eventType }) => {
      const domainScope = {
        attemptId: 'attempt-1',
        tutorDomain: 'learning_fence',
        fenceId: 'fence-1',
        pageId: 'page-1',
        questionId: 'question-1',
        sceneId: 'scene-1',
      };
      const learningContext = {
        schemaVersion: 'reach-deck-learning-fence-context/v1' as const,
        attemptId: 'attempt-1',
        fenceId: 'fence-1',
        pageId: 'page-1',
        questionId: 'question-1',
        sceneId: 'scene-1',
        observedAt: '2026-10-11T00:00:00Z',
      };
      let stopped = false;
      localStorage.clear();
      EventSourceStub.instances = [];
      vi.stubGlobal('EventSource', EventSourceStub);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          const path = String(url);
          if (path.includes('/threads?sceneKey='))
            return Response.json({ threads: [{ id: 'thread-1', domainScope }] });
          if (path.endsWith('/threads/thread-1'))
            return Response.json({
              thread: { id: 'thread-1', domainScope },
              history: [
                {
                  run: {
                    id: 'run-1',
                    status: stopped
                      ? code === 'RUN_CANCELLED'
                        ? 'cancelled'
                        : 'failed'
                      : 'running',
                    input: { message: 'Question', learningContext },
                    ...(stopped ? { error: { code } } : {}),
                  },
                  events: stopped
                    ? [{ id: '1', type: 'message.delta', payload: { delta: 'Approved prefix' } }]
                    : [],
                },
              ],
            });
          throw new Error(`Unexpected request ${path}`);
        }),
      );
      const host = document.createElement('div');
      document.body.append(host);
      let root = createRoot(host);
      const t = createPortalTranslator(locale);
      const render = () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <StudentReachDeckConversation
              variant="learning-fence"
              pages={[]}
              domainScope={domainScope}
              learningContext={learningContext}
            />
          </PortalI18nProvider>,
        );
      const assertNotice = () => {
        const guardrail = code.startsWith('GUARDRAIL_');
        const reason = t(
          guardrail
            ? code === 'GUARDRAIL_BLOCKED'
              ? 'tutorDiscussion.guardrailBlocked'
              : 'tutorDiscussion.guardrailUnavailable'
            : code === 'RUN_CANCELLED'
              ? 'student.tutor.stopped'
              : 'student.tutor.incomplete',
        );
        expect(host.textContent).toContain('Approved prefix');
        expect(host.textContent?.split(reason)).toHaveLength(2);
        if (guardrail) expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.querySelector('[data-fence-message="tutor"]')?.textContent).toContain(reason);
        expect(host.textContent).not.toContain(t('student.tutor.thinking'));
        expect(host.textContent).not.toContain(code);
      };
      try {
        await act(async () => render());
        const source = EventSourceStub.instances[0]!;
        expect(source).toBeDefined();
        await act(async () => {
          source.emit('message.delta', { delta: 'Approved prefix' });
          source.emit(eventType, { code });
        });
        assertNotice();
        stopped = true;
        await act(async () => root.unmount());
        root = createRoot(host);
        await act(async () => render());
        assertNotice();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );
});
