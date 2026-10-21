import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuizQuestion,
  richTextFromPlainText,
  type Question,
  type QuizScene,
} from '@reachany/reach-deck-dsl';

import { QuizScenePlayer } from '../src/QuizScenePlayer';
import type { QuizGradingByQuestionId, QuizSceneRuntimeState } from '../src/types';

const singleChoice: Question = {
  ...createQuizQuestion('single_choice', 1, 'q1'),
  answer: ['A'],
  analysis: richTextFromPlainText('解析一'),
  has_answer: true,
  options: [
    { value: 'A', label: richTextFromPlainText('选项 A') },
    { value: 'B', label: richTextFromPlainText('选项 B') },
  ],
  question: richTextFromPlainText('首题'),
};

const multipleChoice: Question = {
  ...createQuizQuestion('multiple_choice', 1, 'q1'),
  answer: ['A', 'B'],
  analysis: richTextFromPlainText('解析一'),
  has_answer: true,
  options: [
    { value: 'A', label: richTextFromPlainText('选项 A') },
    { value: 'B', label: richTextFromPlainText('选项 B') },
    { value: 'C', label: richTextFromPlainText('选项 C') },
  ],
  question: richTextFromPlainText('多选题'),
};

const shortAnswer: Question = {
  ...createQuizQuestion('short_answer', 2, 'q2'),
  analysis: richTextFromPlainText('简答解析'),
  answer: richTextFromPlainText('光合作用'),
  has_answer: true,
  question: richTextFromPlainText('简答题'),
};

function quizScene(
  questions: Question[],
  answerReveal: QuizScene['content']['answer_reveal'] = 'after_submit',
): QuizScene {
  return {
    schemaVersion: 'reach-quiz-scene/v1',
    id: 'quiz-scene',
    title: '课中检测',
    sceneType: 'quiz',
    content: {
      display_mode: 'single_question',
      navigation: 'horizontal',
      show_progress: true,
      show_question_index: true,
      answer_reveal: answerReveal,
      allow_previous: true,
      allow_skip: true,
      questions,
    },
  };
}

function submittedRuntime(
  scene: QuizScene,
  answers: QuizSceneRuntimeState['answers'],
  activeIndex = 0,
): QuizSceneRuntimeState {
  return {
    kind: 'quiz',
    sceneId: scene.id,
    sourceRevision: 1,
    activeIndex,
    answers,
    submitted: Object.fromEntries(Object.keys(answers).map((id) => [id, true as const])),
    sceneCompleted: Object.keys(answers).length === scene.content.questions.length,
  };
}

const shortAnswerResponse = {
  kind: 'rich_text' as const,
  document: richTextFromPlainText('植物利用光能'),
  attachments: [],
};

describe('QuizScenePlayer server grading', () => {
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

  it('waits for the server result after a submit and never grades locally', () => {
    const scene = quizScene([singleChoice]);
    const onSubmit = vi.fn();
    act(() =>
      root.render(<QuizScenePlayer gradingByQuestionId={{}} onSubmit={onSubmit} scene={scene} />),
    );
    act(() => host.querySelector<HTMLInputElement>('.quiz-scene__options input')?.click());
    act(() => button('提交答案').click());

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(status()?.textContent).toBe('批改中…');
    expect(status()?.getAttribute('aria-live')).toBe('polite');
    expect(host.textContent).not.toContain('回答正确');
    expect(host.textContent).not.toContain('参考答案');
    expect(host.querySelector('[data-result]')).toBeNull();

    // The selected answer is locally correct, but only the server verdict is displayed.
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{
            q1: { status: 'graded', maxScore: 10, score: 0, result: 'incorrect' },
          }}
          onSubmit={onSubmit}
          scene={scene}
        />,
      ),
    );
    expect(result()?.dataset.gradingResult).toBe('incorrect');
    expect(result()?.textContent).toContain('回答错误');
    expect(result()?.textContent).toContain('得分 0 / 10');
    expect(host.textContent).toContain('参考答案');
  });

  it.each([
    [{ score: 10, result: 'correct' }, 'correct', '回答正确', '得分 10 / 10'],
    [{ score: 6.67, result: 'incorrect' }, 'partial', '部分正确', '得分 6.67 / 10'],
    [{ score: 0, result: 'incorrect' }, 'incorrect', '回答错误', '得分 0 / 10'],
  ] as const)('renders graded results with the server score (%o)', (grade, state, label, score) => {
    const scene = quizScene([multipleChoice]);
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{ q1: { status: 'graded', maxScore: 10, ...grade } }}
          initialRuntimeState={submittedRuntime(scene, {
            q1: { kind: 'selection', values: ['A'] },
          })}
          scene={scene}
        />,
      ),
    );
    expect(result()?.dataset.gradingResult).toBe(state);
    // 整题结论是共享 QuestionOutcome：部分正确为 warning 结论条。
    expect(result()?.dataset.outcome).toBe(state);
    expect(result()?.textContent).toContain(label);
    expect(result()?.textContent).toContain(score);
    expect(host.textContent).toContain('解析一');
  });

  it('shows a wrong objective result at once while its AI feedback is still being written', () => {
    const scene = quizScene([singleChoice]);
    const onRetryGrading = vi.fn();
    const render = (feedbackStatus: 'grading' | 'failed' | undefined, feedbackMarkdown?: string) =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{
            q1: {
              status: 'graded',
              maxScore: 10,
              score: 0,
              result: 'incorrect',
              ...(feedbackStatus === undefined ? {} : { feedbackStatus }),
              ...(feedbackMarkdown === undefined ? {} : { feedbackMarkdown }),
            },
          }}
          initialRuntimeState={submittedRuntime(scene, {
            q1: { kind: 'selection', values: ['B'] },
          })}
          onRetryGrading={onRetryGrading}
          scene={scene}
        />,
      );
    act(() => render('grading'));
    // 结论、得分与答案解析不等 AI。
    expect(result()?.textContent).toContain('回答错误');
    expect(host.textContent).toContain('参考答案');
    expect(host.querySelector('[data-quiz-feedback-status="grading"]')?.textContent).toContain(
      'AI 反馈生成中',
    );

    act(() => render('failed'));
    expect(host.querySelector('[data-quiz-feedback-status="failed"]')?.textContent).toContain(
      'AI 反馈生成失败',
    );
    act(() => button('重新生成反馈').click());
    expect(onRetryGrading).toHaveBeenCalledWith('q1');

    act(() => render(undefined, '**B** 混淆了概念。'));
    expect(host.querySelector('[data-quiz-feedback-status]')).toBeNull();
    expect(host.textContent).toContain('AI 批阅意见');
  });

  it('keeps the reference answer hidden while AI grading and shows host-rendered feedback after', () => {
    const scene = quizScene([shortAnswer]);
    const runtime = submittedRuntime(scene, { q2: shortAnswerResponse });
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{ q2: { status: 'grading', maxScore: 10 } }}
          initialRuntimeState={runtime}
          scene={scene}
        />,
      ),
    );
    expect(status()?.textContent).toBe('批改中…');
    expect(host.textContent).not.toContain('参考答案');
    expect(host.textContent).not.toContain('简答解析');

    const renderGradingFeedback = vi.fn((markdown: string) => (
      <em data-testid="rendered-feedback">{markdown}</em>
    ));
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{
            q2: {
              status: 'graded',
              maxScore: 10,
              score: 8,
              result: 'incorrect',
              rationale: '要点基本正确',
              feedbackMarkdown: '**补充**光反应',
            },
          }}
          initialRuntimeState={runtime}
          renderGradingFeedback={renderGradingFeedback}
          scene={scene}
        />,
      ),
    );
    expect(result()?.textContent).toContain('部分正确');
    expect(host.querySelector('[aria-label="AI 批阅意见"]')?.textContent).toContain('AI 批阅意见');
    expect(renderGradingFeedback.mock.calls.map(([markdown]) => markdown)).toEqual([
      '要点基本正确',
      '**补充**光反应',
    ]);
    expect(host.querySelectorAll('[data-testid="rendered-feedback"]')).toHaveLength(2);
    expect(host.textContent).toContain('参考答案');
    expect(host.textContent).toContain('简答解析');
  });

  it('renders feedback as plain text without a host renderer, never as HTML', () => {
    const scene = quizScene([shortAnswer]);
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{
            q2: {
              status: 'graded',
              maxScore: 10,
              score: 10,
              result: 'correct',
              feedbackMarkdown: '<img src=x onerror="alert(1)"> **好**',
            },
          }}
          initialRuntimeState={submittedRuntime(scene, { q2: shortAnswerResponse })}
          scene={scene}
        />,
      ),
    );
    const feedback = host.querySelector('.quiz-scene__grading-feedback-text');
    expect(feedback?.textContent).toBe('<img src=x onerror="alert(1)"> **好**');
    expect(host.querySelector('.quiz-scene__grading-feedback img')).toBeNull();
  });

  it('offers a retry for failed grading and reveals the answer once grading is terminal', () => {
    const scene = quizScene([shortAnswer]);
    const runtime = submittedRuntime(scene, { q2: shortAnswerResponse });
    const onRetryGrading = vi.fn();
    const render = (grading: QuizGradingByQuestionId) =>
      act(() =>
        root.render(
          <QuizScenePlayer
            gradingByQuestionId={grading}
            initialRuntimeState={runtime}
            onRetryGrading={onRetryGrading}
            scene={scene}
          />,
        ),
      );
    render({ q2: { status: 'failed', maxScore: 10 } });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('批改失败');
    expect(host.textContent).toContain('参考答案');
    act(() => button('重新批阅').click());
    expect(onRetryGrading).toHaveBeenCalledWith('q2');

    render({ q2: { status: 'failed', maxScore: 10, retrying: true } });
    expect(button('正在重新批阅…').disabled).toBe(true);

    render({ q2: { status: 'failed', maxScore: 10, retryMessage: '请在 42 秒后再重新批阅。' } });
    expect(button('重新批阅').disabled).toBe(false);
    expect(host.textContent).toContain('请在 42 秒后再重新批阅。');

    render({ q2: { status: 'grading', maxScore: 10 } });
    expect(status()?.textContent).toBe('批改中…');
    expect(host.textContent).not.toContain('重新批阅');
  });

  it('treats a submitted question without an entry as unscored and settled', () => {
    const unscored = { ...singleChoice, has_answer: false };
    const scene = quizScene([unscored]);
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{}}
          initialRuntimeState={submittedRuntime(scene, {
            q1: { kind: 'selection', values: ['B'] },
          })}
          scene={scene}
        />,
      ),
    );
    expect(host.textContent).not.toContain('批改中');
    expect(result()).toBeNull();
    expect(host.textContent).toContain('解析一');
  });

  it('settles a just-submitted unscored question without waiting for the server', () => {
    const unscored = { ...singleChoice, has_answer: false };
    act(() =>
      root.render(<QuizScenePlayer gradingByQuestionId={{}} scene={quizScene([unscored])} />),
    );
    act(() => host.querySelector<HTMLInputElement>('.quiz-scene__options input')?.click());
    act(() => button('提交答案').click());
    expect(host.textContent).not.toContain('批改中');
    expect(host.textContent).toContain('解析一');
  });

  it('reveals after_scene answers only once every question is terminal', () => {
    const scene = quizScene([singleChoice, shortAnswer], 'after_scene');
    const runtime = submittedRuntime(scene, {
      q1: { kind: 'selection', values: ['A'] },
      q2: shortAnswerResponse,
    });
    const render = (grading: QuizGradingByQuestionId) =>
      act(() =>
        root.render(
          <QuizScenePlayer
            gradingByQuestionId={grading}
            initialRuntimeState={runtime}
            scene={scene}
          />,
        ),
      );
    render({
      q1: { status: 'graded', maxScore: 10, score: 10, result: 'correct' },
      q2: { status: 'grading', maxScore: 10 },
    });
    expect(host.textContent).not.toContain('参考答案');
    expect(result()).toBeNull();

    render({
      q1: { status: 'graded', maxScore: 10, score: 10, result: 'correct' },
      q2: { status: 'failed', maxScore: 10 },
    });
    expect(host.textContent).toContain('参考答案');
    expect(result()?.textContent).toContain('回答正确');
  });

  it("shows a fenced wrong answer's verdict but holds answers and AI feedback until mastery", () => {
    const fenced: Question = {
      ...singleChoice,
      learning_fence: { enabled: true, prompt: 'Explain your reasoning.' },
    };
    const scene = quizScene([fenced]);
    const runtime = submittedRuntime(scene, { q1: { kind: 'selection', values: ['B'] } });
    const render = (grading: QuizGradingByQuestionId, mastered: string[]) =>
      act(() =>
        root.render(
          <QuizScenePlayer
            gradingByQuestionId={grading}
            initialRuntimeState={runtime}
            masteredLearningFenceQuestionIds={mastered}
            scene={scene}
          />,
        ),
      );
    const wrong = {
      status: 'graded' as const,
      maxScore: 10,
      score: 0,
      result: 'incorrect' as const,
      feedbackMarkdown: '选项 B 混淆了概念',
    };
    render({ q1: wrong }, []);
    // 对错与得分照常公布；答案、解析与 AI 反馈挡到掌握之后。
    expect(result()?.textContent).toContain('回答错误');
    expect(result()?.textContent).toContain('得分 0 / 10');
    expect(host.textContent).not.toContain('解析一');
    expect(host.textContent).not.toContain('参考答案');
    expect(host.textContent).not.toContain('选项 B 混淆了概念');
    expect(host.textContent).not.toContain('答案已提交');

    render({ q1: wrong }, ['q1']);
    expect(host.textContent).toContain('解析一');
    expect(host.textContent).toContain('选项 B 混淆了概念');

    render({ q1: { status: 'graded', maxScore: 10, score: 10, result: 'correct' } }, []);
    expect(host.textContent).toContain('解析一');
  });

  function button(label: string): HTMLButtonElement {
    const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === label,
    );
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  }

  function status(): HTMLElement | null {
    return host.querySelector<HTMLElement>('.quiz-scene__grading.is-pending');
  }

  function result(): HTMLElement | null {
    return host.querySelector<HTMLElement>('.quiz-scene__result');
  }
});

describe('QuizScenePlayer default server mode safety', () => {
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

  it('never reveals a submitted AI-graded answer when the host passes no grading data', () => {
    const scene = quizScene([shortAnswer]);
    act(() =>
      root.render(
        <QuizScenePlayer
          initialRuntimeState={submittedRuntime(scene, { q2: shortAnswerResponse })}
          scene={scene}
        />,
      ),
    );
    expect(host.textContent).toContain('批改中…');
    expect(host.textContent).not.toContain('试讲模式不进行 AI 批阅');
    expect(host.textContent).not.toContain('参考答案');
    expect(host.textContent).not.toContain('光合作用');
    expect(host.textContent).not.toContain('简答解析');
  });

  it('does not grade objective answers locally without an explicit trial mode', () => {
    const scene = quizScene([singleChoice]);
    act(() =>
      root.render(
        <QuizScenePlayer
          initialRuntimeState={submittedRuntime(scene, {
            q1: { kind: 'selection', values: ['A'] },
          })}
          scene={scene}
        />,
      ),
    );
    expect(host.querySelector('.quiz-scene__result')).toBeNull();
    expect(host.querySelector('[data-result]')).toBeNull();
    expect(host.textContent).not.toContain('参考答案');
  });

  it('replaces the pending state with a save error when the submission could not be saved', () => {
    const scene = quizScene([shortAnswer]);
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{}}
          initialRuntimeState={submittedRuntime(scene, { q2: shortAnswerResponse })}
          scene={scene}
          unsyncedSubmissionQuestionIds={['q2']}
        />,
      ),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('答案尚未保存');
    expect(host.textContent).not.toContain('批改中…');
    expect(host.textContent).not.toContain('参考答案');

    // A server entry supersedes a stale unsynced flag.
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{ q2: { status: 'grading', maxScore: 10 } }}
          initialRuntimeState={submittedRuntime(scene, { q2: shortAnswerResponse })}
          scene={scene}
          unsyncedSubmissionQuestionIds={['q2']}
        />,
      ),
    );
    expect(host.textContent).toContain('批改中…');
    expect(host.textContent).not.toContain('答案尚未保存');
  });

  it('disables regrading and explains the limit once retries are exhausted', () => {
    const scene = quizScene([shortAnswer]);
    const onRetryGrading = vi.fn();
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{ q2: { status: 'failed', maxScore: 10, retryExhausted: true } }}
          initialRuntimeState={submittedRuntime(scene, { q2: shortAnswerResponse })}
          onRetryGrading={onRetryGrading}
          scene={scene}
        />,
      ),
    );
    const retry = host.querySelector<HTMLButtonElement>('.quiz-scene__grading-retry');
    expect(retry?.disabled).toBe(true);
    act(() => retry?.click());
    expect(onRetryGrading).not.toHaveBeenCalled();
    expect(host.textContent).toContain('已达重新批阅上限');
  });
});

describe('QuizScenePlayer trial grading', () => {
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

  it('grades objective questions locally with partial credit', () => {
    const scene = quizScene([multipleChoice]);
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          initialRuntimeState={submittedRuntime(scene, {
            q1: { kind: 'selection', values: ['A'] },
          })}
          scene={scene}
        />,
      ),
    );
    const result = host.querySelector<HTMLElement>('.quiz-scene__result');
    expect(result?.dataset.gradingResult).toBe('partial');
    expect(result?.textContent).toContain('部分正确');
    expect(result?.textContent).toContain('得分 5 / 10');
    expect(host.textContent).not.toContain('批改中');
  });

  it('skips AI grading in trial mode and shows the reference answer', () => {
    const scene = quizScene([shortAnswer], 'teacher_controlled');
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          initialRuntimeState={submittedRuntime(scene, { q2: shortAnswerResponse })}
          scene={scene}
        />,
      ),
    );
    expect(host.textContent).toContain('试讲模式不进行 AI 批阅');
    expect(host.textContent).toContain('参考答案');
    expect(host.textContent).toContain('光合作用');
    expect(host.querySelector('.quiz-scene__result')).toBeNull();
    expect(host.textContent).not.toContain('批改中');
  });

  it('uses the host translator for grading copy', () => {
    const scene = quizScene([shortAnswer]);
    const translate = (key: string) =>
      ({
        'reachDeck.player.quiz.grading.pending': 'Grading…',
        'reachDeck.player.quiz.grading.failed': 'Grading failed.',
        'reachDeck.player.quiz.grading.retry': 'Grade again',
      })[key] ?? key;
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingByQuestionId={{ q2: { status: 'failed', maxScore: 10 } }}
          initialRuntimeState={submittedRuntime(scene, { q2: shortAnswerResponse })}
          onRetryGrading={() => undefined}
          scene={scene}
          translate={translate}
        />,
      ),
    );
    expect(host.textContent).toContain('Grading failed.');
    expect(host.textContent).toContain('Grade again');
  });
});
