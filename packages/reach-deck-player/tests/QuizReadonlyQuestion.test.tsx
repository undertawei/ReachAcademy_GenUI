import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  createQuizQuestion,
  emptyQuestionAnswer,
  richTextFromPlainText,
} from '@reachany/reach-deck-dsl';
import { QuizReadonlyQuestion } from '../src/QuizScenePlayer';

describe('QuizReadonlyQuestion shared leaf controls', () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  it.each([
    'single_choice',
    'multiple_choice',
    'fill_in_the_blank',
    'fill_with_candidates',
    'cloze',
    'short_answer',
  ] as const)('renders %s without scene, learner writes or grading controls', (type) => {
    const question = createQuizQuestion(type, 1, 'real-question');
    question.question = richTextFromPlainText('Real prompt');
    question.options = [{ value: 'A', label: richTextFromPlainText('Candidate') }];
    question.blanks = [
      { id: 'real-blank', blank_index: 1, answer: [], candidates: question.options },
    ];
    const answer = emptyQuestionAnswer(type, question.blanks);
    act(() => root.render(<QuizReadonlyQuestion question={question} answer={answer} />));
    expect(host.textContent).toContain('Real prompt');
    expect(host.querySelector('.quiz-scene__footer')).toBeNull();
    expect(host.querySelector('.quiz-scene__navigator')).toBeNull();
    expect(
      host.querySelector(
        'input:not(:disabled):not([readonly]):not([aria-readonly=true]),textarea:not(:disabled):not([readonly]),[contenteditable=true]',
      ),
    ).toBeNull();
    const choice = host.querySelector<HTMLInputElement>('input[type=radio],input[type=checkbox]');
    if (choice) {
      act(() => choice.click());
      expect(choice.checked).toBe(false);
    }
    expect(host.querySelector('[data-scene-id]')).toBeNull();
  });
  it('filters ordinary blank display by real ID while retaining original ordinal and full readonly value', () => {
    const question = createQuizQuestion('fill_in_the_blank', 1, 'fill');
    question.question = richTextFromPlainText('Root fill prompt');
    question.blanks = [
      { id: 'real-first', blank_index: 1, answer: [] },
      { id: 'real-second', blank_index: 2, answer: [] },
    ];
    const answer = {
      kind: 'fill_blanks' as const,
      version: 1 as const,
      blanks: question.blanks.map((blank, index) => ({
        blankId: blank.id,
        answer: {
          kind: 'rich_text' as const,
          document: richTextFromPlainText(index ? 'Second frozen' : 'First frozen'),
        },
      })),
    };
    const snapshot = JSON.stringify({ question, answer });
    act(() =>
      root.render(
        <QuizReadonlyQuestion question={question} answer={answer} visibleBlankId="real-second" />,
      ),
    );
    expect(host.textContent).toContain('Root fill prompt');
    expect(host.textContent).toContain('第 2 空');
    expect(host.textContent).toContain('Second frozen');
    expect(host.textContent).not.toContain('First frozen');
    expect(host.querySelectorAll('[data-blank-id]')).toHaveLength(1);
    expect(host.querySelector('[data-blank-id]')?.getAttribute('data-blank-id')).toBe(
      'real-second',
    );
    expect(host.querySelector('[contenteditable=true]')).toBeNull();
    act(() =>
      root.render(
        <QuizReadonlyQuestion question={question} answer={answer} visibleBlankId="real-first" />,
      ),
    );
    expect(host.textContent).toContain('First frozen');
    expect(host.textContent).not.toContain('Second frozen');
    act(() =>
      root.render(
        <QuizReadonlyQuestion question={question} answer={answer} visibleBlankId="unknown" />,
      ),
    );
    expect(host.querySelectorAll('[data-blank-id]')).toHaveLength(0);
    act(() => root.render(<QuizReadonlyQuestion question={question} answer={answer} />));
    expect(host.querySelectorAll('[data-blank-id]')).toHaveLength(2);
    expect(JSON.stringify({ question, answer })).toBe(snapshot);
  });
  it.each(['fill_in_the_blank', 'fill_with_candidates', 'cloze'] as const)(
    'separates full empty %s source from filtered answer without changing inputs',
    (type) => {
      const question = createQuizQuestion(type, 1, 'leaf');
      question.question = richTextFromPlainText('Complete source prompt');
      question.options = [{ value: 'A', label: richTextFromPlainText('Shared candidate') }];
      question.blanks = [1, 2].map((number) => ({
        id: `real-${number}`,
        blank_index: number,
        answer: [],
        candidates: [{ value: 'A', label: richTextFromPlainText(`Local candidate ${number}`) }],
      }));
      question.candidate_pool_repeatable = true;
      const answer = {
        kind: 'fill_blanks' as const,
        version: 1 as const,
        blanks: question.blanks.map((blank, index) => ({
          blankId: blank.id,
          answer:
            type === 'fill_in_the_blank'
              ? {
                  kind: 'rich_text' as const,
                  document: richTextFromPlainText(`Frozen ${index + 1}`),
                }
              : { kind: 'selection' as const, values: ['A'] },
        })),
      };
      const snapshot = JSON.stringify({ question, answer });
      act(() =>
        root.render(
          <QuizReadonlyQuestion
            presentation="source"
            question={question}
            answer={answer}
            visibleBlankId="real-2"
          />,
        ),
      );
      expect(host.querySelectorAll('[data-blank-id]')).toHaveLength(2);
      expect(host.textContent).toContain('Complete source prompt');
      expect(host.textContent).not.toContain('Frozen');
      expect(host.querySelector('input:checked')).toBeNull();
      act(() =>
        root.render(
          <QuizReadonlyQuestion
            presentation="answer"
            answerLabel="Submitted answer"
            question={question}
            answer={answer}
            visibleBlankId="real-2"
          />,
        ),
      );
      expect(host.querySelectorAll('[data-blank-id]')).toHaveLength(1);
      expect(host.querySelector('[data-blank-id]')?.getAttribute('data-blank-id')).toBe('real-2');
      expect(host.textContent).not.toContain('Complete source prompt');
      expect(host.querySelector('fieldset')?.getAttribute('aria-label')).toBe('Submitted answer');
      expect(host.querySelector('[contenteditable=true],input:not(:disabled)')).toBeNull();
      if (type === 'fill_in_the_blank') expect(host.textContent).toContain('Frozen 2');
      else {
        expect(host.querySelector('input:checked')).not.toBeNull();
        expect(host.textContent).toContain(
          type === 'cloze' ? 'Local candidate 2' : 'Shared candidate',
        );
        expect(host.textContent).not.toContain('Local candidate 1');
      }
      expect(JSON.stringify({ question, answer })).toBe(snapshot);
    },
  );
});
