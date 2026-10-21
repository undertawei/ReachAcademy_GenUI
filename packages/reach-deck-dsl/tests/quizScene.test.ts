import { describe, expect, it } from 'vitest';

import {
  QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS,
  createQuizQuestion,
  createQuizQuestionBlank,
  parseQuestionValue,
  parseQuizSceneContentValue,
  richTextFromPlainText,
  richTextToPlainText,
} from '../src/index.js';

describe('quiz scene contract', () => {
  it('uses the same five question types and rich-text fields as the Quiz module', () => {
    const question = parseQuestionValue({
      ...createQuizQuestion('single_choice', 1, 'question-1'),
      question: '<strong>证据</strong>是什么？',
      options: [
        { value: 'A', label: '观察结果' },
        { value: 'B', label: '个人偏好' },
      ],
      has_answer: true,
      answer: ['A'],
      analysis: '比较可验证性',
      cognitive_schema: '证据 → 判断',
    });

    expect(question.question_type).toBe('single_choice');
    expect(question.question_index).toBe(1);
    expect(question.question.type).toBe('doc');
    expect(question.options?.[0]?.label.type).toBe('doc');
    expect(question.analysis.type).toBe('doc');
    expect(question.cognitive_schema.type).toBe('doc');
  });

  it.each([
    'single_choice',
    'multiple_choice',
    'fill_in_the_blank',
    'fill_with_candidates',
    'short_answer',
  ] as const)('creates canonical %s questions', (questionType) => {
    const parsed = parseQuestionValue(createQuizQuestion(questionType, 1, 'question-1'));
    expect(parsed.question_type).toBe(questionType);
    expect(parsed.points).toBe(10);
    expect(parsed.sub_problems).toEqual([]);
  });

  it('parses an enabled learning fence and keeps legacy questions compatible', () => {
    const legacy = parseQuestionValue(createQuizQuestion('single_choice', 1));
    expect(legacy.learning_fence).toBeUndefined();

    const fenced = parseQuestionValue({
      ...createQuizQuestion('single_choice', 1),
      learning_fence: { enabled: true, prompt: '  Require the learner to explain causality.  ' },
    });
    expect(fenced.learning_fence).toEqual({
      enabled: true,
      prompt: 'Require the learner to explain causality.',
    });
  });

  it('preserves a learning fence with the canonical multi-blank question shape', () => {
    const parsed = parseQuestionValue({
      ...createQuizQuestion('fill_with_candidates', 1),
      options: [
        {
          value: 'A',
          label: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
          },
        },
        {
          value: 'B',
          label: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
          },
        },
      ],
      blanks: [
        {
          ...createQuizQuestionBlank('fill_with_candidates', 1),
          candidates: undefined,
          answer: ['A'],
        },
      ],
      learning_fence: { enabled: true, prompt: 'Explain why the selected term fits.' },
    });

    expect(parsed.has_answer).toBe(true);
    expect(parsed.blanks?.[0]).toMatchObject({ answer: ['A'], blank_index: 1 });
    expect(parsed.learning_fence).toEqual({
      enabled: true,
      prompt: 'Explain why the selected term fits.',
    });
  });

  it('rejects enabled learning fences without a bounded prompt', () => {
    const question = createQuizQuestion('single_choice', 1);
    expect(() =>
      parseQuestionValue({ ...question, learning_fence: { enabled: true, prompt: '   ' } }),
    ).toThrow('learning_fence prompt');
    expect(() =>
      parseQuestionValue({
        ...question,
        learning_fence: {
          enabled: true,
          prompt: 'x'.repeat(QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS + 1),
        },
      }),
    ).toThrow('learning_fence prompt');
  });

  it('normalizes legacy true/false and string fields without a data migration', () => {
    const parsed = parseQuestionValue({
      question_type: 'true_false',
      question_index: 'q1',
      question: '系统由部分构成。',
      has_answer: true,
      answer: true,
    });

    expect(parsed.question_type).toBe('single_choice');
    expect(parsed.question_index).toBe(1);
    expect(parsed.answer).toEqual(['A']);
    expect(parsed.options?.map((option) => option.value)).toEqual(['A', 'B']);
    expect(richTextToPlainText(parsed.question)).toBe('系统由部分构成。');
  });

  it('relabels legacy generated option ids and preserves their selected answers', () => {
    const parsed = parseQuestionValue({
      ...createQuizQuestion('multiple_choice', 1, 'question-1'),
      options: [
        { value: 'OPTION-Q7K2M1', label: '第一项' },
        { value: 'OPTION-X9P4R8', label: '第二项' },
        { value: 'OPTION-H3N6T5', label: '第三项' },
      ],
      has_answer: true,
      answer: ['OPTION-Q7K2M1', 'OPTION-H3N6T5'],
    });

    expect(parsed.options?.map((option) => option.value)).toEqual(['A', 'B', 'C']);
    expect(parsed.answer).toEqual(['A', 'C']);
  });

  it('rejects incomplete choice collections', () => {
    expect(() =>
      parseQuestionValue({
        ...createQuizQuestion('single_choice', 1, 'question-1'),
        options: [{ value: 'A', label: richTextFromPlainText('A') }],
      }),
    ).toThrow(/at least two/);
  });

  it('accepts the fixed single-question scene shell', () => {
    const content = parseQuizSceneContentValue({
      questions: [createQuizQuestion('short_answer', 1, 'question-1')],
      display_mode: 'single_question',
      navigation: 'horizontal',
      show_progress: true,
      show_question_index: true,
      answer_reveal: 'after_submit',
      allow_previous: true,
      allow_skip: false,
    });
    expect(content.questions).toHaveLength(1);
  });
});
it('keeps persisted zero and fractional points when loading a quiz scene', () => {
  const root = {
    ...createQuizQuestion('fill_in_the_blank', 1, 'root'),
    points: 0,
    sub_problems: [{ ...createQuizQuestion('short_answer', 1, 'child'), points: 0.25 }],
  };
  const content = parseQuizSceneContentValue({
    questions: [root],
    display_mode: 'single_question',
    navigation: 'horizontal',
    show_progress: true,
    show_question_index: true,
    answer_reveal: 'after_submit',
    allow_previous: true,
    allow_skip: false,
  });
  expect(content.questions[0].points).toBe(0);
  expect(content.questions[0].sub_problems[0].points).toBe(0.25);
});
