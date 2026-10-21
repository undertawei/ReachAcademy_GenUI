// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';

import { StudentReachDeckDiscussion } from './StudentReachDeckDiscussion';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const tutorMounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('./StudentReachDeckTutorDiscussion', () => ({
  StudentReachDeckTutorDiscussion: ({
    activePageId,
    domainScope,
    learningContext,
    pages,
  }: {
    activePageId?: string;
    domainScope: Record<string, string>;
    learningContext: { pageId: string } | null;
    pages: Array<{ pageId: string }>;
  }) => {
    const [mountId] = React.useState(() => String(++tutorMounts.count));
    return (
      <div
        data-active-page-id={activePageId ?? 'none'}
        data-attempt-id={domainScope.attemptId}
        data-mount-id={mountId}
        data-page-count={pages.length}
        data-page-id={learningContext?.pageId ?? 'pending'}
      >
        Reach Tutor backend
      </div>
    );
  },
}));

describe('StudentReachDeckDiscussion', () => {
  it('removes seeded peer threads and waits for an active learning context', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<StudentReachDeckDiscussion domainScope={null} learningContext={null} />);
    });

    expect(container.textContent).toContain('开始本次学习后');
    expect(container.textContent).not.toContain('林同学');
    expect(container.textContent).not.toContain('前端体验模式');
  });

  it('shows the brand loader instead of the start hint while an existing attempt loads', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StudentReachDeckDiscussion domainScope={null} learningContext={null} preparing />,
      );
    });

    expect(container.querySelector('.rx-brand-loader')?.getAttribute('aria-label')).toBe(
      '正在载入讨论记录…',
    );
    expect(container.textContent).not.toContain('开始本次学习后');
  });

  it('localizes the waiting state and its accessibility label in English', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <StudentReachDeckDiscussion domainScope={null} learningContext={null} />
        </PortalI18nProvider>,
      );
    });

    expect(container.querySelector('[aria-label="Reach Tutor in-class chat"]')).not.toBeNull();
    expect(container.textContent).toContain('After you start learning');
  });

  it('embeds the private Runtime Tutor with the current attempt and page', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StudentReachDeckDiscussion
          domainScope={{
            attemptId: '11111111-1111-4111-8111-111111111111',
            selectionId: '22222222-2222-4222-8222-222222222222',
            moduleVersionId: '33333333-3333-4333-8333-333333333333',
            tutorDomain: 'ordinary',
          }}
          learningContext={{
            schemaVersion: 'reach-deck-tutor-context/v1',
            attemptId: '11111111-1111-4111-8111-111111111111',
            pageId: 'page-1',
            observedAt: '2026-07-30T10:00:00.000Z',
            activity: {
              schemaVersion: 'reach-deck-player-activity/v1',
              pageId: 'page-1',
              sceneId: 'scene-1',
              sceneType: 'interactive',
              sourceRevision: 1,
              state: { progress: 0.5 },
            },
          }}
        />,
      );
    });

    expect(container.querySelector('[data-page-id="page-1"]')).not.toBeNull();
    expect(container.querySelector('[data-attempt-id]')?.getAttribute('data-attempt-id')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(container.textContent).toContain('Reach Tutor backend');
  });

  it('keeps one Tutor instance mounted while the next page context catches up', async () => {
    tutorMounts.count = 0;
    const container = document.createElement('div');
    const root = createRoot(container);
    const domainScope = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      selectionId: '22222222-2222-4222-8222-222222222222',
      moduleVersionId: '33333333-3333-4333-8333-333333333333',
      tutorDomain: 'ordinary',
    };
    const learningContext = {
      schemaVersion: 'reach-deck-tutor-context/v1' as const,
      attemptId: domainScope.attemptId,
      pageId: 'page-1',
      observedAt: '2026-07-30T10:00:00.000Z',
      activity: {
        schemaVersion: 'reach-deck-player-activity/v1' as const,
        pageId: 'page-1',
        sceneId: 'scene-1',
        sceneType: 'slide' as const,
        sourceRevision: 1,
        state: {},
      },
    };

    await act(async () => {
      root.render(
        <StudentReachDeckDiscussion domainScope={domainScope} learningContext={learningContext} />,
      );
    });
    const mountId = container.querySelector('[data-mount-id]')?.getAttribute('data-mount-id');

    await act(async () => {
      root.render(<StudentReachDeckDiscussion domainScope={domainScope} learningContext={null} />);
    });
    expect(container.querySelector('[data-page-id="pending"]')).not.toBeNull();
    expect(container.querySelector('[data-mount-id]')?.getAttribute('data-mount-id')).toBe(mountId);

    await act(async () => {
      root.render(
        <StudentReachDeckDiscussion
          domainScope={domainScope}
          learningContext={{
            ...learningContext,
            pageId: 'page-2',
            activity: { ...learningContext.activity, pageId: 'page-2', sceneId: 'scene-2' },
          }}
        />,
      );
    });
    expect(container.querySelector('[data-page-id="page-2"]')).not.toBeNull();
    expect(container.querySelector('[data-mount-id]')?.getAttribute('data-mount-id')).toBe(mountId);
  });
});
