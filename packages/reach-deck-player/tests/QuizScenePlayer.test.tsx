import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuizQuestion,
  richTextFromPlainText,
  type QuizScene,
} from '@reachany/reach-deck-dsl';

import { QuizScenePlayer } from '../src/QuizScenePlayer';

const scene: QuizScene = {
  schemaVersion: 'reach-quiz-scene/v1',
  id: 'quiz-page-1',
  title: '快速检查',
  sceneType: 'quiz',
  content: {
    display_mode: 'single_question',
    navigation: 'horizontal',
    show_progress: true,
    show_question_index: true,
    answer_reveal: 'after_submit',
    allow_previous: true,
    allow_skip: false,
    questions: [
      {
        ...createQuizQuestion('single_choice', 1, 'q1'),
        answer: ['A'],
        analysis: richTextFromPlainText('解析一'),
        cognitive_schema: richTextFromPlainText('图式一'),
        has_answer: true,
        options: [
          { value: 'A', label: richTextFromPlainText('选项 A') },
          { value: 'B', label: richTextFromPlainText('选项 B') },
        ],
        question: richTextFromPlainText('首题'),
      },
      {
        ...createQuizQuestion('short_answer', 2, 'q2'),
        question: richTextFromPlainText('次题'),
      },
    ],
  },
};

describe('QuizScenePlayer', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each(['default', 'learner'] as const)(
    'browses every question type without mutation, grading, upload or runtime callbacks in readonly %s layout',
    async (layout) => {
      const questions = [
        'single_choice',
        'multiple_choice',
        'fill_in_the_blank',
        'fill_with_candidates',
        'cloze',
        'short_answer',
      ].map((type, index) => ({
        ...createQuizQuestion(
          type as QuizScene['content']['questions'][number]['question_type'],
          index + 1,
          `readonly-${index}`,
        ),
        question: richTextFromPlainText(`Read question ${index + 1}`),
        options: [{ value: 'A', label: richTextFromPlainText('Visible option') }],
        blanks:
          type.startsWith('fill') || type === 'cloze'
            ? [
                {
                  id: 'blank',
                  blank_index: 1,
                  answer: ['A'],
                  candidates: [{ value: 'A', label: richTextFromPlainText('Visible candidate') }],
                },
              ]
            : undefined,
      }));
      const readonlyScene: QuizScene = {
        ...scene,
        content: { ...scene.content, questions, allow_previous: false, allow_skip: false },
      };
      const onRuntimeStateChange = vi.fn();
      const onSubmit = vi.fn();
      const onRetryGrading = vi.fn();
      const uploadAnswerAsset = vi.fn();
      await act(async () =>
        root.render(
          <QuizScenePlayer
            readOnly
            layout={layout}
            scene={readonlyScene}
            gradingMode="trial"
            teacherRevealAnswers
            onRuntimeStateChange={onRuntimeStateChange}
            onSubmit={onSubmit}
            onRetryGrading={onRetryGrading}
            uploadAnswerAsset={uploadAnswerAsset}
          />,
        ),
      );
      for (let index = 0; index < questions.length; index++) {
        expect(host.textContent).toContain(`Read question ${index + 1}`);
        expect(
          host.querySelector(
            '.quiz-scene__submit, .quiz-scene__footer-submit, .quiz-scene__grading-retry',
          ),
        ).toBeNull();
        expect(host.querySelector('.quiz-scene__reveal, .quiz-scene__result')).toBeNull();
        expect(host.querySelector('[contenteditable="true"], input[type="file"]')).toBeNull();
        await act(async () => {
          host.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
            input.click();
            input.dispatchEvent(new Event('change', { bubbles: true }));
          });
          const paste = new Event('paste', { bubbles: true });
          const file = new File(['image'], 'paste.png', { type: 'image/png' });
          Object.defineProperty(paste, 'clipboardData', {
            value: {
              items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
              files: [file],
              getData: () => '',
            },
          });
          host.querySelector('[contenteditable]')?.dispatchEvent(paste);
          await Promise.resolve();
        });
        if (index < questions.length - 1) await act(async () => button('下一题').click());
      }
      expect(button('上一题').disabled).toBe(false);
      await act(async () => button('上一题').click());
      expect(host.textContent).toContain('Read question 5');
      if (layout === 'learner') {
        const nav = host.querySelectorAll<HTMLButtonElement>('.quiz-scene__navigator-item');
        expect(Array.from(nav).every((item) => !item.disabled)).toBe(true);
        await act(async () => nav[0]!.click());
        expect(host.textContent).toContain('Read question 1');
      }
      await act(async () =>
        root.render(
          <QuizScenePlayer
            readOnly
            layout={layout}
            scene={{ ...readonlyScene, content: { ...readonlyScene.content } }}
            onRuntimeStateChange={onRuntimeStateChange}
            onSubmit={onSubmit}
            onRetryGrading={onRetryGrading}
            uploadAnswerAsset={uploadAnswerAsset}
          />,
        ),
      );
      expect(onRuntimeStateChange).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onRetryGrading).not.toHaveBeenCalled();
      expect(uploadAnswerAsset).not.toHaveBeenCalled();
    },
  );

  it.each(['default', 'learner'] as const)(
    'retains normal submission with explicit readOnly=false in %s',
    (layout) => {
      const onSubmit = vi.fn();
      const onRuntimeStateChange = vi.fn();
      act(() =>
        root.render(
          <QuizScenePlayer
            scene={scene}
            layout={layout}
            readOnly={false}
            onSubmit={onSubmit}
            onRuntimeStateChange={onRuntimeStateChange}
          />,
        ),
      );
      act(() => host.querySelector<HTMLInputElement>('input')!.click());
      act(() => button('提交答案').click());
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onRuntimeStateChange).toHaveBeenCalled();
    },
  );

  it.each(['default', 'learner'] as const)(
    'displays recorded server failure and policy reveal without retries in readonly %s',
    (layout) => {
      const onRuntimeStateChange = vi.fn();
      const onRetryGrading = vi.fn();
      for (const gradingMode of ['server', 'trial'] as const) {
        act(() =>
          root.render(
            <QuizScenePlayer
              key={gradingMode}
              readOnly
              layout={layout}
              scene={scene}
              gradingMode={gradingMode}
              teacherRevealAnswers
              gradingByQuestionId={{ q1: { status: 'failed', maxScore: 1 } }}
              initialRuntimeState={{
                kind: 'quiz',
                sceneId: scene.id,
                sourceRevision: 1,
                activeIndex: 0,
                answers: { q1: { kind: 'selection', values: ['A'] } },
                submitted: { q1: true },
                sceneCompleted: false,
              }}
              onRuntimeStateChange={onRuntimeStateChange}
              onRetryGrading={onRetryGrading}
            />,
          ),
        );
        expect(host.querySelector('.quiz-scene__grading-retry, .quiz-scene__result')).toBeNull();
        expect(host.querySelector('.quiz-scene__reveal')).not.toBeNull();
        expect(host.textContent).toContain('批改失败');
        expect(onRuntimeStateChange).not.toHaveBeenCalled();
        expect(onRetryGrading).not.toHaveBeenCalled();
      }
    },
  );

  it('shows immutable answer and real grade, respects fences and never infers missing grading in readonly', () => {
    const frozen = {
      kind: 'quiz' as const,
      sceneId: scene.id,
      sourceRevision: 1,
      activeIndex: 0,
      answers: { q1: { kind: 'selection' as const, values: ['B'] } },
      submitted: { q1: true as const },
      sceneCompleted: false,
    };
    const fenced: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        questions: [
          {
            ...scene.content.questions[0]!,
            learning_fence: {
              enabled: true,
              prompt: 'Explain your reasoning',
            },
          },
          scene.content.questions[1]!,
        ],
      },
    };
    const render = (
      grade: React.ComponentProps<typeof QuizScenePlayer>['gradingByQuestionId'],
      mastered: string[] = [],
    ) =>
      act(() =>
        root.render(
          <QuizScenePlayer
            readOnly
            scene={fenced}
            initialRuntimeState={frozen}
            gradingMode="trial"
            gradingByQuestionId={grade}
            masteredLearningFenceQuestionIds={mastered}
          />,
        ),
      );
    render({
      q1: {
        status: 'graded',
        score: 0,
        maxScore: 1,
        result: 'incorrect',
        rationale: 'Recorded feedback',
      },
    });
    expect(host.querySelectorAll<HTMLInputElement>('input')[1]?.checked).toBe(true);
    expect(host.querySelector('.quiz-scene__result')?.textContent).toContain('0 / 1');
    expect(host.querySelector('.quiz-scene__reveal')).toBeNull();
    expect(host.textContent).not.toContain('Recorded feedback');
    render(
      {
        q1: {
          status: 'graded',
          score: 0,
          maxScore: 1,
          result: 'incorrect',
          rationale: 'Recorded feedback',
        },
      },
      ['q1'],
    );
    expect(host.textContent).toContain('Recorded feedback');
    expect(host.querySelector('.quiz-scene__reveal')).not.toBeNull();
    render({});
    expect(host.querySelector('.quiz-scene__result, .quiz-scene__reveal, .is-pending')).toBeNull();
  });

  it('reveals a scored result after_scene when an unscored question has a server-confirmed submission', () => {
    const mixed: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        answer_reveal: 'after_scene',
        questions: [scene.content.questions[0]!, { ...scene.content.questions[1]!, points: 0 }],
      },
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          readOnly
          scene={mixed}
          gradingByQuestionId={{
            q1: { status: 'graded', maxScore: 1, score: 1, result: 'correct' },
          }}
          initialRuntimeState={{
            kind: 'quiz',
            sceneId: scene.id,
            sourceRevision: 1,
            activeIndex: 0,
            answers: { q1: { kind: 'selection', values: ['A'] } },
            submitted: { q1: true, q2: true },
            sceneCompleted: true,
          }}
        />,
      ),
    );
    expect(host.querySelector('.quiz-scene__reveal')).not.toBeNull();
    expect(host.querySelector('.quiz-scene__result')?.textContent).toContain('1 / 1');
  });

  it('opens an exact question and reports local readonly browsing without runtime writes', () => {
    const onQuestionChange = vi.fn();
    const onRuntimeStateChange = vi.fn();
    act(() =>
      root.render(
        <QuizScenePlayer
          readOnly
          scene={scene}
          initialQuestionId="q2"
          onQuestionChange={onQuestionChange}
          onRuntimeStateChange={onRuntimeStateChange}
        />,
      ),
    );
    expect(host.textContent).toContain('次题');
    expect(onQuestionChange).toHaveBeenLastCalledWith('q2');
    act(() => button('上一题').click());
    expect(onQuestionChange).toHaveBeenLastCalledWith('q1');
    expect(onRuntimeStateChange).not.toHaveBeenCalled();
  });

  it.each(['single_choice', 'multiple_choice'] as const)(
    'locks %s answers after submission',
    (type) => {
      const lockedScene: QuizScene = {
        ...scene,
        content: {
          ...scene.content,
          questions: [{ ...scene.content.questions[0]!, question_type: type }],
        },
      };
      const onRuntimeStateChange = vi.fn();
      act(() =>
        root.render(
          <QuizScenePlayer
            gradingMode="trial"
            scene={lockedScene}
            onRuntimeStateChange={onRuntimeStateChange}
          />,
        ),
      );
      const inputs = [...host.querySelectorAll<HTMLInputElement>('.quiz-scene__options input')];
      act(() => inputs[0]!.click());
      act(() =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === '提交答案')!
          .click(),
      );
      const snapshots = onRuntimeStateChange.mock.calls.length;
      // 已提交为共享 QuestionOption 的只读态：可聚焦、可读屏，但不可再改。
      expect(inputs.every((input) => input.getAttribute('aria-readonly') === 'true')).toBe(true);
      act(() => inputs[1]!.click());
      expect(inputs[0]!.checked).toBe(true);
      expect(inputs[1]!.checked).toBe(false);
      expect(onRuntimeStateChange.mock.calls).toHaveLength(snapshots);
      expect(host.querySelector('[role="status"]')?.textContent).toContain('回答正确');
    },
  );

  it('marks multiple-choice options with host-translated labels after reveal', () => {
    const multiple: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        questions: [
          {
            ...scene.content.questions[0]!,
            answer: ['A', 'C'],
            options: ['A', 'B', 'C', 'D'].map((value) => ({
              value,
              label: richTextFromPlainText(`选项 ${value}`),
            })),
            question_type: 'multiple_choice',
          },
        ],
      },
    };
    const english: Record<string, string> = {
      'reachDeck.player.quiz.option.correct': 'Correct',
      'reachDeck.player.quiz.option.incorrect': 'Incorrect',
      'reachDeck.player.quiz.option.missed': 'Missed',
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          scene={multiple}
          translate={(key) => english[key] ?? key}
        />,
      ),
    );
    const group = host.querySelector('[role="group"][aria-labelledby]');
    expect(document.getElementById(group!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      '首题',
    );
    const inputs = [...host.querySelectorAll<HTMLInputElement>('.quiz-scene__options input')];
    act(() => inputs[0]!.click());
    act(() => inputs[1]!.click());
    expect(inputs[0]!.closest('.rx-question-option')?.getAttribute('data-state')).toBe('checked');
    expect(host.querySelector('[data-result]')).toBeNull();
    act(() => button('提交答案').click());

    const resultOf = (index: number) =>
      inputs[index]!.closest('.rx-question-option')?.getAttribute('data-result');
    expect([0, 1, 2, 3].map(resultOf)).toEqual(['correct', 'incorrect', 'missed', null]);
    expect(host.textContent).toContain('Correct');
    expect(host.textContent).toContain('Incorrect');
    expect(host.textContent).toContain('Missed');
    // 试讲判分对多选按全对计分：选错一项即整题错误。
    expect(host.querySelector('.quiz-scene__result')?.getAttribute('data-outcome')).toBe(
      'incorrect',
    );
  });

  it('renders rich text and submits the canonical selection response', () => {
    const onSubmit = vi.fn();
    act(() =>
      root.render(<QuizScenePlayer gradingMode="trial" onSubmit={onSubmit} scene={scene} />),
    );
    expect(host.textContent).toContain('首题');
    const option = host.querySelector<HTMLInputElement>('.quiz-scene__options input');
    act(() => option?.click());
    const submit = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '提交答案',
    );
    act(() => submit?.click());

    expect(onSubmit).toHaveBeenCalledWith(
      'q1',
      { kind: 'selection', values: ['A'] },
      expect.objectContaining({ submitted: { q1: true } }),
    );
    expect(host.textContent).toContain('解析一');
    expect(host.textContent).not.toContain('图式一');
    expect(host.querySelector('.rx-question-option-marker')?.textContent).toBe('A');
    expect(host.querySelector('[data-result="correct"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('回答正确');
  });

  it.each([false, true])(
    'publishes the submitted runtime before onSubmit (last question: %s)',
    (lastQuestion) => {
      const runtimeChanged = vi.fn();
      const submittedSnapshots: unknown[] = [];
      const submittedScene = lastQuestion
        ? {
            ...scene,
            content: { ...scene.content, questions: [scene.content.questions[0]] },
          }
        : scene;
      const onSubmit = vi.fn(() => submittedSnapshots.push(runtimeChanged.mock.lastCall?.[0]));
      act(() =>
        root.render(
          <QuizScenePlayer
            gradingMode="trial"
            scene={submittedScene}
            onRuntimeStateChange={runtimeChanged}
            onSubmit={onSubmit}
          />,
        ),
      );
      act(() => host.querySelector<HTMLInputElement>('.quiz-scene__options input')?.click());
      act(() => button('提交答案').click());
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(submittedSnapshots).toEqual([
        expect.objectContaining({
          answers: { q1: { kind: 'selection', values: ['A'] } },
          submitted: { q1: true },
          sceneCompleted: lastQuestion,
        }),
      ]);
    },
  );

  it('submits an ungraded short answer snapshot before notifying both student and trial hosts', () => {
    const question = { ...scene.content.questions[1], has_answer: false };
    const ungraded = { ...scene, content: { ...scene.content, questions: [question] } };
    const answer = {
      kind: 'rich_text' as const,
      document: richTextFromPlainText('response'),
      attachments: [],
    };
    const onRuntimeStateChange = vi.fn();
    const onSubmit = vi.fn();
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          initialRuntimeState={{
            activeIndex: 0,
            answers: { q2: answer },
            kind: 'quiz',
            sceneCompleted: false,
            sceneId: ungraded.id,
            sourceRevision: 1,
            submitted: {},
          }}
          onRuntimeStateChange={onRuntimeStateChange}
          onSubmit={onSubmit}
          scene={ungraded}
        />,
      ),
    );
    expect(button('提交答案').disabled).toBe(false);
    act(() => button('提交答案').click());
    expect(onSubmit).toHaveBeenCalledWith(
      'q2',
      expect.objectContaining({ kind: 'rich_text' }),
      expect.objectContaining({
        answers: { q2: expect.objectContaining({ kind: 'rich_text' }) },
        sceneCompleted: true,
        submitted: { q2: true },
      }),
    );
    expect(
      onRuntimeStateChange.mock.calls.some(
        ([runtime]) => runtime.sceneCompleted === true && runtime.submitted.q2 === true,
      ),
    ).toBe(true);
    expect(
      onRuntimeStateChange.mock.invocationCallOrder.some(
        (order) => order < onSubmit.mock.invocationCallOrder[0]!,
      ),
    ).toBe(true);
    expect(onSubmit.mock.calls[0]?.[2]).toMatchObject({
      sceneCompleted: true,
      submitted: { q2: true },
    });
    expect(host.textContent).toContain('已提交');
    expect(host.textContent).not.toContain('回答错误');
    expect(host.textContent).not.toContain('回答正确');
  });

  it('does not leak correctness before the configured reveal gate', () => {
    const controlled: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        answer_reveal: 'teacher_controlled',
        questions: [scene.content.questions[0]],
      },
    };
    act(() => root.render(<QuizScenePlayer gradingMode="trial" scene={controlled} />));
    const inputs = host.querySelectorAll<HTMLInputElement>('.quiz-scene__options input');
    act(() => inputs[1]?.click());
    act(() => button('提交答案').click());
    expect(host.querySelector('[data-result]')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).not.toContain('参考答案');

    act(() =>
      root.render(<QuizScenePlayer gradingMode="trial" scene={controlled} teacherRevealAnswers />),
    );
    expect(host.querySelector('[data-result="missed"]')).not.toBeNull();
    expect(host.querySelector('[data-result="incorrect"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('回答错误');
  });

  it('reveals after_scene answers when every question has been submitted without another action', () => {
    const afterScene: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        answer_reveal: 'after_scene',
        questions: [scene.content.questions[0]],
      },
    };
    act(() => root.render(<QuizScenePlayer gradingMode="trial" scene={afterScene} />));
    act(() => host.querySelectorAll<HTMLInputElement>('.quiz-scene__options input')[1]?.click());
    act(() => button('提交答案').click());

    expect(host.textContent).not.toContain('完成测验');
    expect(host.querySelector('[data-result="missed"]')).not.toBeNull();
    expect(host.querySelector('[data-result="incorrect"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('回答错误');
    expect(host.textContent).toContain('参考答案');
  });

  it('hides incorrect fenced answers and analysis until server-confirmed mastery', () => {
    const fenced: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        questions: [
          {
            ...scene.content.questions[0],
            learning_fence: { enabled: true, prompt: 'Explain your reasoning.' },
          },
        ],
      },
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          scene={fenced}
          masteredLearningFenceQuestionIds={[]}
        />,
      ),
    );
    act(() => host.querySelectorAll<HTMLInputElement>('.quiz-scene__options input')[1]?.click());
    act(() => button('提交答案').click());
    expect(host.querySelector('[data-result]')).toBeNull();
    expect(host.textContent).not.toContain('参考答案');
    expect(host.textContent).not.toContain('解析一');
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          scene={fenced}
          masteredLearningFenceQuestionIds={['q1']}
        />,
      ),
    );
    expect(host.querySelector('[data-result="missed"]')).not.toBeNull();
    expect(host.textContent).toContain('参考答案');
    expect(host.textContent).toContain('解析一');
  });

  it('reveals a correct fenced answer immediately after submission', () => {
    const fenced: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        questions: [
          {
            ...scene.content.questions[0],
            learning_fence: { enabled: true, prompt: 'Explain your reasoning.' },
          },
        ],
      },
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          scene={fenced}
          masteredLearningFenceQuestionIds={[]}
        />,
      ),
    );
    act(() => host.querySelectorAll<HTMLInputElement>('.quiz-scene__options input')[0]?.click());
    act(() => button('提交答案').click());
    expect(host.textContent).toContain('解析一');
  });

  it('submits one answer entry per stable fill blank id', () => {
    const onSubmit = vi.fn();
    const fillQuestion = {
      ...createQuizQuestion('fill_with_candidates', 1, 'fill-q'),
      options: [
        { value: 'A', label: richTextFromPlainText('牛顿第二定律') },
        { value: 'B', label: richTextFromPlainText('动量定理') },
      ],
      candidate_pool_repeatable: false,
      blanks: [
        {
          id: 'law-name',
          blank_index: 1,
          answer: ['A'],
        },
      ],
      has_answer: true,
      question: {
        type: 'doc' as const,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'quizBlank', attrs: { blankId: 'law-name', blankIndex: 1 } }],
          },
        ],
      },
    };
    const fillScene: QuizScene = {
      ...scene,
      content: { ...scene.content, questions: [fillQuestion] },
    };
    act(() =>
      root.render(<QuizScenePlayer gradingMode="trial" onSubmit={onSubmit} scene={fillScene} />),
    );
    expect(host.textContent).toContain('____1____');
    act(() => host.querySelector<HTMLInputElement>('.is-candidates input')?.click());
    act(() => button('提交答案').click());
    expect(onSubmit).toHaveBeenCalledWith(
      'fill-q',
      {
        kind: 'fill_blanks',
        version: 1,
        blanks: [{ blankId: 'law-name', answer: { kind: 'selection', values: ['A'] } }],
      },
      expect.objectContaining({ submitted: { 'fill-q': true } }),
    );
  });

  it('resets only a legacy fill question and recomputes scene completion on restore', () => {
    const onRuntimeStateChange = vi.fn();
    const fillQuestion = {
      ...createQuizQuestion('cloze', 1, 'fill-q'),
      blanks: [
        {
          id: 'blank-1',
          blank_index: 1,
          answer: ['A'],
          candidates: [
            { value: 'A', label: richTextFromPlainText('A') },
            { value: 'B', label: richTextFromPlainText('B') },
          ],
        },
      ],
      has_answer: true,
    };
    const other = { ...scene.content.questions[0], id: 'other-q', question_index: 2 };
    const restoreScene: QuizScene = {
      ...scene,
      content: { ...scene.content, questions: [fillQuestion, other] },
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          initialRuntimeState={{
            activeIndex: 0,
            answers: {
              'fill-q': { kind: 'selection', values: ['A'] },
              'other-q': { kind: 'selection', values: ['A'] },
            },
            kind: 'quiz',
            sceneCompleted: true,
            sceneId: scene.id,
            sourceRevision: 1,
            submitted: { 'fill-q': true, 'other-q': true },
          }}
          onRuntimeStateChange={onRuntimeStateChange}
          scene={restoreScene}
        />,
      ),
    );
    const runtime = onRuntimeStateChange.mock.calls.at(-1)?.[0];
    expect(runtime).toMatchObject({
      answers: { 'other-q': { kind: 'selection', values: ['A'] } },
      sceneCompleted: false,
      submitted: { 'other-q': true },
    });
    expect(runtime.answers).not.toHaveProperty('fill-q');
  });

  it('disables reused pooled options when repeatability is off', () => {
    const question = {
      ...createQuizQuestion('fill_with_candidates', 1, 'pooled-q'),
      options: [
        { value: 'A', label: richTextFromPlainText('A') },
        { value: 'B', label: richTextFromPlainText('B') },
      ],
      candidate_pool_repeatable: false,
      blanks: [
        { id: 'b1', blank_index: 1, answer: ['A'] },
        { id: 'b2', blank_index: 2, answer: ['B'] },
      ],
      has_answer: true,
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          scene={{ ...scene, content: { ...scene.content, questions: [question] } }}
        />,
      ),
    );
    const groups = host.querySelectorAll<HTMLElement>('.quiz-scene__options.is-candidates');
    const firstA = groups[0]?.querySelector<HTMLInputElement>('input');
    act(() => firstA?.click());
    const secondA = groups[1]?.querySelector<HTMLInputElement>('input');
    expect(secondA?.disabled).toBe(true);
  });

  it('keeps pooled options enabled when repeatability is on', () => {
    const question = {
      ...createQuizQuestion('fill_with_candidates', 1, 'pooled-q'),
      options: [{ value: 'A', label: richTextFromPlainText('A') }],
      candidate_pool_repeatable: true,
      blanks: [
        { id: 'b1', blank_index: 1, answer: ['A'] },
        { id: 'b2', blank_index: 2, answer: ['A'] },
      ],
      has_answer: true,
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          scene={{ ...scene, content: { ...scene.content, questions: [question] } }}
        />,
      ),
    );
    const groups = host.querySelectorAll<HTMLElement>('.quiz-scene__options.is-candidates');
    const firstA = groups[0]?.querySelector<HTMLInputElement>('input');
    act(() => firstA?.click());
    const secondA = groups[1]?.querySelector<HTMLInputElement>('input');
    expect(secondA?.disabled).toBe(false);
  });

  it('renders question and option formulas statically in playback', () => {
    const mathScene: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        questions: [
          {
            ...scene.content.questions[0],
            question: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: '计算 ' },
                    { type: 'inlineMath', attrs: { latex: 'x^2' } },
                  ],
                },
              ],
            },
            options: [
              {
                value: 'A',
                label: {
                  type: 'doc',
                  content: [{ type: 'blockMath', attrs: { latex: 'x=2' } }],
                },
              },
            ],
          },
        ],
      },
    };

    act(() => root.render(<QuizScenePlayer gradingMode="trial" scene={mathScene} />));

    expect(
      host.querySelector('[data-mathlive-node="inline-math"][data-latex="x^2"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-mathlive-node="block-math"][data-latex="x=2"]'),
    ).not.toBeNull();
    expect(host.querySelector('.katex')).not.toBeNull();
    expect(host.querySelector('math-field')).toBeNull();
  });

  it('removes redundant progress and navigation controls for a generated single-question page', () => {
    const singleQuestionScene: QuizScene = {
      ...scene,
      content: { ...scene.content, questions: [scene.content.questions[0]] },
    };

    act(() => root.render(<QuizScenePlayer gradingMode="trial" scene={singleQuestionScene} />));

    expect(host.querySelector('progress')).toBeNull();
    expect(host.querySelector('.quiz-scene__navigation')).toBeNull();
    expect(host.textContent).toContain('第 1 题');
    expect(host.textContent).not.toContain('1/1');
  });

  it('keeps progress and horizontal navigation for teacher-authored multi-question pages', () => {
    act(() => root.render(<QuizScenePlayer gradingMode="trial" scene={scene} />));

    expect(host.querySelector('progress')).not.toBeNull();
    const navigation = host.querySelector('.quiz-scene__navigation');
    expect(navigation).not.toBeNull();
    const next = [...(navigation?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === '下一题',
    );
    expect(next?.disabled).toBe(true);

    const option = host.querySelector<HTMLInputElement>('.quiz-scene__options input');
    act(() => option?.click());
    const submit = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '提交答案',
    );
    act(() => submit?.click());
    expect(next?.disabled).toBe(false);
    act(() => next?.click());
    expect(host.textContent).toContain('次题');
  });

  it('restores and publishes privacy-safe runtime state', () => {
    const onRuntimeStateChange = vi.fn();
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          initialRuntimeState={{
            kind: 'quiz',
            sceneId: scene.id,
            sourceRevision: 2,
            activeIndex: 1,
            answers: {
              '2': {
                kind: 'rich_text',
                document: richTextFromPlainText('回答'),
                attachments: [],
              },
            },
            submitted: {},
            sceneCompleted: false,
          }}
          onRuntimeStateChange={onRuntimeStateChange}
          scene={scene}
          sourceRevision={2}
        />,
      ),
    );
    expect(host.textContent).toContain('次题');
    expect(onRuntimeStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        activeIndex: 1,
        answers: {
          q2: {
            kind: 'rich_text',
            document: richTextFromPlainText('回答'),
            attachments: [],
          },
        },
      }),
    );
    expect(host.querySelector('[contenteditable="true"]')?.textContent).toContain('回答');
    expect(host.querySelector('[role="group"][aria-label="答案格式"]')).not.toBeNull();
  });

  it('uploads, reorders, removes, and submits multiple open-response attachments', async () => {
    const onRuntimeStateChange = vi.fn();
    const uploadAnswerAsset = vi.fn(async (file: File) => ({
      assetId:
        file.name === 'first.txt'
          ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      contentType: file.type,
      downloadUrl: `https://assets.example/${file.name}`,
      name: file.name,
      objectKey: `tmp/${file.name}`,
      sizeBytes: file.size,
    }));
    await act(async () => {
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          initialRuntimeState={{
            activeIndex: 1,
            answers: {},
            kind: 'quiz',
            sceneCompleted: false,
            sceneId: scene.id,
            sourceRevision: 2,
            submitted: {},
          }}
          onRuntimeStateChange={onRuntimeStateChange}
          scene={scene}
          sourceRevision={2}
          uploadAnswerAsset={uploadAnswerAsset}
        />,
      );
      await flush();
    });
    const attachmentInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
      (input) => !input.hasAttribute('accept'),
    );
    const files = [
      new File(['first'], 'first.txt', { type: 'text/plain' }),
      new File(['second'], 'second.pdf', { type: 'application/pdf' }),
    ];
    Object.defineProperty(attachmentInput, 'files', { configurable: true, value: files });

    await act(async () => {
      attachmentInput?.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });
    expect(uploadAnswerAsset).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('first.txt');
    expect(host.textContent).toContain('second.pdf');
    expect(latestAttachments(onRuntimeStateChange)).toEqual([
      expect.objectContaining({ name: 'first.txt', order: 0 }),
      expect.objectContaining({ name: 'second.pdf', order: 1 }),
    ]);

    await act(async () => {
      button('上移 second.pdf').click();
      await flush();
    });
    expect(latestAttachments(onRuntimeStateChange)).toEqual([
      expect.objectContaining({ name: 'second.pdf', order: 0 }),
      expect.objectContaining({ name: 'first.txt', order: 1 }),
    ]);

    await act(async () => {
      button('移除 second.pdf').click();
      await flush();
      button('提交答案').click();
      await flush();
    });
    expect(latestAttachments(onRuntimeStateChange)).toEqual([
      expect.objectContaining({ name: 'first.txt', order: 0 }),
    ]);
    const toolbar = host.querySelector('[role="group"][aria-label="答案格式"]');
    expect(toolbar).not.toBeNull();
    expect(
      [
        ...toolbar!.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
          'button, select, input',
        ),
      ].every((control) => control.disabled),
    ).toBe(true);

    function button(label: string): HTMLButtonElement {
      const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === label || candidate.ariaLabel === label,
      );
      if (!match) throw new Error(`Missing button: ${label}`);
      return match;
    }
  });

  it('resolves authored inline images in the stem, options and analysis by objectKey', () => {
    const image = (objectKey: string) => ({
      type: 'doc' as const,
      content: [{ type: 'image', attrs: { alt: objectKey, objectKey } }],
    });
    const illustrated: QuizScene = {
      ...scene,
      content: {
        ...scene.content,
        questions: [
          {
            ...scene.content.questions[0],
            analysis: image('keys/analysis.png'),
            options: [
              { value: 'A', label: image('keys/option.png') },
              { value: 'B', label: richTextFromPlainText('选项 B') },
            ],
            question: image('keys/stem.png'),
          },
        ],
      },
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          mediaUrlsByObjectKey={{
            'keys/analysis.png': 'https://assets.example/analysis.png?signature',
            'keys/option.png': 'https://assets.example/option.png?signature',
            'keys/stem.png': 'https://assets.example/stem.png?signature',
          }}
          scene={illustrated}
        />,
      ),
    );
    act(() => host.querySelector<HTMLInputElement>('.quiz-scene__options input')?.click());
    act(() => button('提交答案').click());

    expect(
      [...host.querySelectorAll<HTMLImageElement>('img[data-object-key]')].map((image) => [
        image.dataset.objectKey,
        image.getAttribute('src'),
      ]),
    ).toEqual([
      ['keys/stem.png', 'https://assets.example/stem.png?signature'],
      ['keys/option.png', 'https://assets.example/option.png?signature'],
      ['keys/analysis.png', 'https://assets.example/analysis.png?signature'],
    ]);
  });

  function button(label: string): HTMLButtonElement {
    const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === label || candidate.ariaLabel === label,
    );
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  }
});

function latestAttachments(onRuntimeStateChange: ReturnType<typeof vi.fn>) {
  const calls = onRuntimeStateChange.mock.calls;
  const runtime = calls[calls.length - 1]?.[0] as
    | { answers?: Record<string, { attachments?: unknown[] }> }
    | undefined;
  return runtime?.answers?.q2?.attachments;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
