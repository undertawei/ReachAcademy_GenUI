import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGenerationWorkspace,
  type GenerationWorkspace,
  type LessonPlan,
} from '@reachany/reach-deck-dsl';

import {
  ReachDeckGenerationPanel,
  type ReachDeckGenerationPanelJob,
  type ReachDeckGenerationPanelProps,
} from '../src/ReachDeckGenerationPanel';
import { artifactFor } from './artifactFixture';

const now = '2026-07-18T03:00:00.000Z';
const lessonPlan: LessonPlan = {
  id: 'plan-1',
  title: 'Concurrency',
  audience: 'Developers',
  durationMinutes: 20,
  learningObjectives: ['Explain CAS'],
  teachingStrategy: 'Worked examples',
  keyTerms: ['CAS'],
  narrative: 'Start from a lost update.',
};

describe('ReachDeckGenerationPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('collects source text before creating a workspace', () => {
    const onCreateWorkspace = vi.fn();
    const props = createProps({
      sourceDraft: '',
      onCreateWorkspace,
      onSourceDraftChange: vi.fn(),
    });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    expect(buttonByText(container, '创建生成工作区').disabled).toBe(true);
    expect(container.textContent).toContain('输入课件来源');
  });

  it('shows a completed lesson-plan candidate and applies it explicitly', async () => {
    const onApplyLessonPlan = vi.fn();
    const workspace = createGenerationWorkspace({
      runId: 'run-1',
      documentId: 'deck-1',
      source: 'Teach concurrency',
      createdAt: now,
    });
    const props = createProps({
      workspace,
      workspaceRevision: 1,
      jobs: [
        {
          jobId: 'job-plan-1',
          kind: 'lesson-plan',
          status: 'completed',
          done: true,
          candidate: lessonPlan,
        },
      ],
      onApplyLessonPlan,
    });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    expect(container.textContent).toContain('Concurrency');
    await act(async () => {
      buttonByText(container, '采用教学计划').click();
    });
    expect(onApplyLessonPlan).toHaveBeenCalledWith('job-plan-1');
  });

  it('only enables the conservative first unfinished page frontier', () => {
    const workspace = createPageWorkspace();
    const props = createProps({
      workspace,
      workspaceRevision: 3,
    });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    expect(buttonsByText(container, '生成本页')).toHaveLength(1);
    expect(container.textContent).toContain('The race');
    expect(container.textContent).toContain('Check');
  });

  it('treats a ready artifact as layout-settled and offers the next page', () => {
    const workspace = {
      ...createPageWorkspace(),
      statuses: {
        'page-1': {
          state: 'ready',
          runId: 'run-1',
          pageId: 'page-1',
          requestedRevision: 1,
          attempt: 1,
          sceneId: 'page-1',
          completedAt: now,
        },
        'page-2': createPageWorkspace().statuses['page-2'],
      },
    } as GenerationWorkspace;
    const props = createProps({ workspace, workspaceRevision: 4 });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    expect(buttonsByText(container, '生成本页')).toHaveLength(1);
    expect(buttonsByText(container, '重新生成')).toHaveLength(1);
  });

  it('does not offer regeneration after the workspace has been materialized', () => {
    const props = createProps({
      workspace: createPageWorkspace(),
      workspaceRevision: 4,
      materialized: true,
    });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    expect(buttonsByText(container, '重新生成')).toHaveLength(0);
  });

  it('previews a completed page-generation artifact before apply', () => {
    const workspace = createPageWorkspace();
    const artifact = artifactFor('slide', 'page-1');
    if (artifact.sceneType !== 'slide') throw new Error('Expected slide artifact');
    const job: ReachDeckGenerationPanelJob = {
      jobId: 'job-page-generation',
      kind: 'page-generation',
      pageId: 'page-1',
      status: 'completed',
      done: true,
      artifact,
    };
    const props = createProps({
      workspace,
      workspaceRevision: 4,
      jobs: [job],
    });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    expect(container.querySelector('[aria-label="The race页面播放器"]')).not.toBeNull();
    expect(container.textContent).toContain('Actual generated slide');
    expect(container.querySelector('[aria-label="幻灯片布局问题"]')).toBeNull();
    expect(buttonByText(container, '采用页面产物')).not.toBeNull();
  });

  it('exposes durable pause and resume state without hiding job status', async () => {
    const onTogglePaused = vi.fn();
    const workspace = {
      ...createPageWorkspace(),
      paused: true,
    };
    const props = createProps({
      workspace,
      workspaceRevision: 4,
      onTogglePaused,
    });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    const resume = buttonByText(container, '继续生成');
    expect(resume.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('工作区已暂停');
    await act(async () => resume.click());
    expect(onTogglePaused).toHaveBeenCalledWith(false);
  });

  it('keeps materialization explicit after generation completes', async () => {
    const onMaterialize = vi.fn();
    const workspace = {
      ...createPageWorkspace(),
      stage: 'complete',
    } as GenerationWorkspace;
    const props = createProps({
      workspace,
      workspaceRevision: 8,
      onMaterialize,
    });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    await act(async () => {
      buttonByText(container, '物化学习者课件').click();
    });
    expect(onMaterialize).toHaveBeenCalledOnce();
  });

  it('reloads an idempotent materialized preview after browser navigation', async () => {
    const onMaterialize = vi.fn();
    const workspace = {
      ...createPageWorkspace(),
      stage: 'complete',
    } as GenerationWorkspace;
    const props = createProps({
      workspace,
      workspaceRevision: 8,
      materialized: true,
      materializedPreviewAvailable: false,
      onMaterialize,
    });
    act(() => root.render(<ReachDeckGenerationPanel {...props} />));

    const reload = buttonByText(container, '加载已物化预览');
    expect(reload.disabled).toBe(false);
    await act(async () => reload.click());
    expect(onMaterialize).toHaveBeenCalledOnce();

    act(() =>
      root.render(<ReachDeckGenerationPanel {...props} materializedPreviewAvailable={true} />),
    );
    expect(buttonByText(container, '已物化学习者课件').disabled).toBe(true);
  });
});

function createPageWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: 'deck-1',
    source: 'Teach concurrency',
    createdAt: now,
    lessonPlan,
    pagedOutline: {
      id: 'outline-1',
      title: 'Concurrency',
      pages: [
        {
          id: 'page-1',
          order: 1,
          sceneType: 'slide',
          title: 'The race',
        },
        {
          id: 'page-2',
          order: 2,
          sceneType: 'quiz',
          title: 'Check',
        },
      ],
    },
  });
}

function createProps(
  overrides: Partial<ReachDeckGenerationPanelProps> = {},
): ReachDeckGenerationPanelProps {
  return {
    jobs: [],
    sourceDraft: '',
    onSourceDraftChange: vi.fn(),
    onCreateWorkspace: vi.fn(),
    onRefresh: vi.fn(),
    onTogglePaused: vi.fn(),
    onStartLessonPlan: vi.fn(),
    onApplyLessonPlan: vi.fn(),
    onStartPageOutline: vi.fn(),
    onApplyPageOutline: vi.fn(),
    onStartPage: vi.fn(),
    onApplyPageArtifact: vi.fn(),
    onRetryJob: vi.fn(),
    onCancelJob: vi.fn(),
    onMaterialize: vi.fn(),
    ...overrides,
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = buttonsByText(container, text)[0];
  if (button === undefined) throw new Error('button not found: ' + text);
  return button;
}

function buttonsByText(container: HTMLElement, text: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter(
    (button) => button.textContent?.trim() === text,
  );
}
