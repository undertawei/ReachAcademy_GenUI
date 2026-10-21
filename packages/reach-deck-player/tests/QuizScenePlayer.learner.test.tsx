import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createQuizQuestion,
  richTextFromPlainText,
  type QuizQuestion,
  type QuizScene,
} from '@reachany/reach-deck-dsl';

import { QuizScenePlayer } from '../src/QuizScenePlayer';

const option = (value: string, label: string) => ({ value, label: richTextFromPlainText(label) });

const single: QuizQuestion = {
  ...createQuizQuestion('single_choice', 1, 'q-single'),
  answer: ['A'],
  analysis: richTextFromPlainText('解析一'),
  has_answer: true,
  options: [option('A', '比喻'), option('B', '夸张')],
  points: 2,
  question: richTextFromPlainText('修辞手法？'),
};

const candidates: QuizQuestion = {
  ...createQuizQuestion('fill_with_candidates', 2, 'q-pool'),
  answer: [],
  analysis: richTextFromPlainText('解析二'),
  blanks: [
    { id: 'b1', blank_index: 1, answer: ['A'] },
    { id: 'b2', blank_index: 2, answer: ['B'] },
  ],
  candidate_pool_repeatable: false,
  has_answer: true,
  options: [option('A', '牛毛'), option('B', '细丝'), option('C', '烟雾')],
  points: 2,
  question: richTextFromPlainText('像____，像____。'),
};

const shortAnswer: QuizQuestion = {
  ...createQuizQuestion('short_answer', 3, 'q-short'),
  points: 6,
  question: richTextFromPlainText('说说理由。'),
};

function quizScene(
  questions: QuizQuestion[],
  overrides: Partial<QuizScene['content']> = {},
): QuizScene {
  return {
    schemaVersion: 'reach-quiz-scene/v1',
    id: 'quiz-learner',
    title: '综合练习',
    sceneType: 'quiz',
    content: {
      display_mode: 'single_question',
      navigation: 'horizontal',
      show_progress: true,
      show_question_index: true,
      answer_reveal: 'after_submit',
      allow_previous: true,
      allow_skip: false,
      questions,
      ...overrides,
    },
  };
}

describe('QuizScenePlayer learner layout', () => {
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

  const navigatorItems = () =>
    [...host.querySelectorAll<HTMLButtonElement>('.quiz-scene__navigator-item')].map((item) => ({
      current: item.getAttribute('aria-current'),
      disabled: item.disabled,
      label: item.getAttribute('aria-label'),
      status: item.dataset.status,
    }));
  const footerButton = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.quiz-scene__footer button')].find(
      (button) => button.textContent?.trim() === name,
    );

  it('keeps the default layout unchanged when no layout is requested', () => {
    act(() => root.render(<QuizScenePlayer scene={quizScene([single, shortAnswer])} />));

    expect(host.querySelector('.quiz-scene')?.getAttribute('data-layout')).toBeNull();
    expect(host.querySelector('.quiz-scene__header progress')).not.toBeNull();
    expect(host.querySelector('.quiz-scene__navigator')).toBeNull();
    expect(host.querySelector('.quiz-scene__navigation')).not.toBeNull();
  });

  it('shows a type and points tag, a question navigator and a pinned footer', () => {
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          layout="learner"
          scene={quizScene([single, candidates, shortAnswer])}
        />,
      ),
    );

    expect(host.querySelector('.quiz-scene')?.getAttribute('data-layout')).toBe('learner');
    expect(host.querySelector('.quiz-scene__meta')?.textContent).toBe('1. 单选题 · 2 分');
    expect(host.querySelector('.quiz-scene__summary')?.textContent).toBe('已提交 0/3');
    // 不允许跳题：未提交前后面的题号不可点。
    expect(navigatorItems()).toEqual([
      { current: 'step', disabled: false, label: '第 1 题，未作答', status: 'unanswered' },
      { current: null, disabled: true, label: '第 2 题，未作答', status: 'unanswered' },
      { current: null, disabled: true, label: '第 3 题，未作答', status: 'unanswered' },
    ]);
    expect(footerButton('提交答案')?.disabled).toBe(true);
    expect(footerButton('跳过')).toBeUndefined();

    act(() => host.querySelector<HTMLInputElement>('input[value="A"]')!.click());
    expect(navigatorItems()[0]?.status).toBe('answered');
    expect(footerButton('提交答案')?.disabled).toBe(false);

    act(() => footerButton('提交答案')!.click());
    expect(navigatorItems()[0]).toMatchObject({ status: 'correct', label: '第 1 题，回答正确' });
    expect(navigatorItems()[1]?.disabled).toBe(false);
    expect(host.querySelector('.quiz-scene__summary')?.textContent).toBe('已提交 1/3');

    act(() => footerButton('下一题')!.click());
    expect(navigatorItems()[1]?.current).toBe('step');
    expect(host.querySelector('.quiz-scene__meta')?.textContent).toBe('2. 选词填空 · 2 分');
  });

  it('marks pool candidates taken by another blank, clears a blank and reveals per blank', () => {
    act(() =>
      root.render(
        <QuizScenePlayer gradingMode="trial" layout="learner" scene={quizScene([candidates])} />,
      ),
    );
    const blank = (index: number) =>
      host.querySelectorAll<HTMLElement>('[data-blank-kind="candidates"]')[index]!;
    const candidate = (index: number, value: string) =>
      [...blank(index).querySelectorAll('label')].find(
        (label) => label.querySelector('.quiz-scene__option-badge')?.textContent === value,
      )!;

    act(() => candidate(0, 'A').querySelector('input')!.click());
    expect(candidate(1, 'A').querySelector('input')!.disabled).toBe(true);
    expect(candidate(1, 'A').textContent).toContain('已用于第 1 空');

    const clear = blank(0).querySelector<HTMLButtonElement>('.quiz-scene__blank-clear');
    expect(clear?.textContent).toBe('清空第 1 空');
    act(() => clear!.click());
    expect(candidate(1, 'A').querySelector('input')!.disabled).toBe(false);
    expect(blank(0).querySelector('.quiz-scene__blank-clear')).toBeNull();

    // 第 1 空选对，第 2 空选错：揭晓后选中项标对/错，未选的正确答案标「漏选」。
    act(() => candidate(0, 'A').querySelector('input')!.click());
    act(() => candidate(1, 'C').querySelector('input')!.click());
    act(() => footerButton('提交答案')!.click());
    expect(candidate(0, 'A').dataset.result).toBe('correct');
    expect(candidate(1, 'C').dataset.result).toBe('incorrect');
    expect(candidate(1, 'B').dataset.result).toBe('missed');
    expect(host.querySelector('.quiz-scene__blank-references')?.textContent).toContain(
      '第 2 空B细丝',
    );
    expect(host.querySelector('.quiz-scene__done')?.textContent).toBe('本题已提交');
  });

  it('skips ahead when allowed and then points back to the first open question', () => {
    const second: QuizQuestion = {
      ...single,
      id: 'q-single-2',
      question_index: 2,
      question: richTextFromPlainText('第二题'),
    };
    act(() =>
      root.render(
        <QuizScenePlayer
          gradingMode="trial"
          layout="learner"
          scene={quizScene([single, second], { allow_skip: true })}
        />,
      ),
    );

    expect(navigatorItems()[1]?.disabled).toBe(false);
    act(() => footerButton('跳过')!.click());
    expect(navigatorItems()[1]?.current).toBe('step');
    expect(footerButton('跳过')).toBeUndefined();

    act(() => host.querySelector<HTMLInputElement>('input[value="B"]')!.click());
    act(() => footerButton('提交答案')!.click());
    expect(navigatorItems()[1]?.status).toBe('incorrect');
    act(() => footerButton('去作答第 1 题')!.click());
    expect(navigatorItems()[0]?.current).toBe('step');
  });
});
