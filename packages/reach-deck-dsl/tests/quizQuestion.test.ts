import { describe, expect, it } from 'vitest';

import {
  QUIZ_BLANK_NODE_TYPE,
  allocateQuizBlankId,
  captureQuizQuestionTypeSession,
  convertQuizQuestionTypeWithSession,
  createQuizQuestion,
  createQuizQuestionBlank,
  parseQuizQuestionValue,
  reconcileQuizQuestionTypeSession,
  richTextFromPlainText,
  synchronizeQuizQuestionBlanks,
  type RichTextDocument,
} from '../src/index.js';

describe('Quiz question type editor sessions', () => {
  it('preserves a single selection when expanding to multiple choice', () => {
    const single = {
      ...createQuizQuestion('single_choice', 1, 'choice'),
      answer: ['B'],
      has_answer: true,
    };

    const changed = convertQuizQuestionTypeWithSession(single, 'multiple_choice');

    expect(changed.question).toMatchObject({
      answer: ['B'],
      has_answer: true,
      question_type: 'multiple_choice',
    });
    expect(changed.question.options).toEqual(single.options);
  });

  it('does not guess a single answer from multiple selections and restores the cached set', () => {
    const multiple = {
      ...createQuizQuestion('multiple_choice', 1, 'choice'),
      answer: ['A', 'C'],
      has_answer: true,
    };

    const single = convertQuizQuestionTypeWithSession(multiple, 'single_choice');
    expect(single.question).toMatchObject({
      answer: [],
      has_answer: false,
      question_type: 'single_choice',
    });

    const restored = convertQuizQuestionTypeWithSession(
      single.question,
      'multiple_choice',
      single.session,
    );
    expect(restored.question).toMatchObject({
      answer: ['A', 'C'],
      has_answer: true,
      question_type: 'multiple_choice',
    });
  });

  it('preserves an unambiguous multiple-choice selection when narrowing to single choice', () => {
    const multiple = {
      ...createQuizQuestion('multiple_choice', 1, 'choice'),
      answer: ['C'],
      has_answer: true,
    };

    const single = convertQuizQuestionTypeWithSession(multiple, 'single_choice');

    expect(single.question).toMatchObject({
      answer: ['C'],
      has_answer: true,
      question_type: 'single_choice',
    });
  });

  it('keeps blank identities but not incompatible answers between fill modes', () => {
    const question = {
      ...createQuizQuestion('fill_in_the_blank', 1, 'fill'),
      blanks: [
        {
          ...createQuizQuestionBlank('fill_in_the_blank', 1, 'durable-blank'),
          answer: richTextFromPlainText('free answer'),
        },
      ],
      has_answer: true,
      question: {
        type: 'doc' as const,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: QUIZ_BLANK_NODE_TYPE,
                attrs: { blankId: 'durable-blank', blankIndex: 1 },
              },
            ],
          },
        ],
      },
    };

    const candidate = convertQuizQuestionTypeWithSession(question, 'fill_with_candidates');
    expect(candidate.question.blanks?.[0]).toMatchObject({
      answer: [],
      id: 'durable-blank',
    });
    expect(candidate.question.has_answer).toBe(false);

    const restored = convertQuizQuestionTypeWithSession(
      candidate.question,
      'fill_in_the_blank',
      candidate.session,
    );
    expect(restored.question.blanks?.[0]).toMatchObject({ id: 'durable-blank' });
    expect(restored.question.blanks?.[0]?.answer).toEqual(richTextFromPlainText('free answer'));
    expect(restored.question.has_answer).toBe(true);
  });

  it('restores short-answer fields without replacing common question content', () => {
    const short = {
      ...createQuizQuestion('short_answer', 1, 'short'),
      analysis: richTextFromPlainText('shared analysis'),
      answer: richTextFromPlainText('reference answer'),
      has_answer: true,
      question: richTextFromPlainText('original prompt'),
    };
    const choice = convertQuizQuestionTypeWithSession(short, 'single_choice');
    const editedChoice = { ...choice.question, question: richTextFromPlainText('edited prompt') };

    const restored = convertQuizQuestionTypeWithSession(
      editedChoice,
      'short_answer',
      choice.session,
    );

    expect(restored.question.answer).toEqual(richTextFromPlainText('reference answer'));
    expect(restored.question.question).toEqual(richTextFromPlainText('edited prompt'));
    expect(restored.question.analysis).toEqual(richTextFromPlainText('shared analysis'));
  });

  it('keeps inactive snapshots after an unchanged save roundtrip and drops them on conflict', () => {
    const short = {
      ...createQuizQuestion('short_answer', 1, 'question'),
      answer: richTextFromPlainText('cached answer'),
      has_answer: true,
    };
    const choice = convertQuizQuestionTypeWithSession(short, 'single_choice');
    const locallyEdited = {
      ...choice.question,
      answer: ['A'],
      has_answer: true,
    };
    const session = captureQuizQuestionTypeSession(choice.session, locallyEdited);

    const unchanged = reconcileQuizQuestionTypeSession(session, {
      ...locallyEdited,
      question: richTextFromPlainText('server-normalized common prompt'),
    });
    expect(unchanged.short_answer).toBeDefined();

    const conflicted = reconcileQuizQuestionTypeSession(session, {
      ...locallyEdited,
      answer: ['B'],
    });
    expect(conflicted.short_answer).toBeUndefined();
    expect(conflicted.single_choice?.answer).toEqual(['B']);
  });
});

describe('Quiz fill blanks', () => {
  it('parses shared candidate pools with repeated answers', () => {
    const parsed = parseQuizQuestionValue({
      id: 'pool',
      question_type: 'fill_with_candidates',
      question: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'quizBlank', attrs: { blankId: 'b1', blankIndex: 1 } }],
          },
        ],
      },
      options: [
        {
          value: 'A',
          label: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'save' }] }],
          },
        },
        {
          value: 'B',
          label: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cost' }] }],
          },
        },
      ],
      candidate_pool_repeatable: true,
      blanks: [{ id: 'b1', blank_index: 1, answer: ['A', 'A'] }],
    });
    expect(parsed.question_type).toBe('fill_with_candidates');
    expect(parsed.options).toHaveLength(2);
    expect(parsed.blanks?.[0]?.answer).toEqual(['A']);
  });
  it('creates fill questions with the canonical blanks contract only', () => {
    expect(createQuizQuestion('fill_in_the_blank', 1)).toMatchObject({
      blanks: [],
      has_answer: false,
      question_type: 'fill_in_the_blank',
    });
    expect(createQuizQuestion('fill_in_the_blank', 1).answer).toEqual([]);
    expect(createQuizQuestion('fill_with_candidates', 1)).not.toHaveProperty('candidates');
  });

  it('renumbers marker nodes and carries configuration with the surviving marker', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: QUIZ_BLANK_NODE_TYPE, attrs: { blankIndex: 2 } },
            { type: 'text', text: ' then ' },
            { type: QUIZ_BLANK_NODE_TYPE, attrs: { blankIndex: 3 } },
          ],
        },
      ],
    };
    const blanks = [1, 2, 3].map((index) => ({
      ...createQuizQuestionBlank('fill_in_the_blank', index),
      answer: {
        type: 'doc' as const,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `answer-${index}` }] }],
      },
    }));

    const normalized = synchronizeQuizQuestionBlanks('fill_in_the_blank', document, blanks);

    expect(normalized.blanks.map((blank) => blank.blank_index)).toEqual([1, 2]);
    expect(normalized.blanks.map((blank) => blank.id)).toEqual(['blank-2', 'blank-3']);
    expect(normalized.blanks.map((blank) => JSON.stringify(blank.answer))).toEqual([
      JSON.stringify(blanks[1].answer),
      JSON.stringify(blanks[2].answer),
    ]);
    expect(normalized.document.content?.[0].content?.map((node) => node.attrs?.blankIndex)).toEqual(
      [1, undefined, 2],
    );
    expect(normalized.document.content?.[0].content?.map((node) => node.attrs?.blankId)).toEqual([
      'blank-2',
      undefined,
      'blank-3',
    ]);
  });

  it('creates a default candidate group for a newly inserted marker', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: QUIZ_BLANK_NODE_TYPE, attrs: { blankIndex: 1 } }] },
      ],
    };
    const normalized = synchronizeQuizQuestionBlanks('fill_with_candidates', document, []);
    expect(normalized.blanks[0]).toMatchObject({
      answer: [],
      blank_index: 1,
    });
    expect(normalized.blanks[0].candidates).toBeUndefined();
  });

  it('allocates a new id before blank-1 without stealing its durable configuration', () => {
    const existing = {
      ...createQuizQuestionBlank('fill_in_the_blank', 1),
      answer: richTextFromPlainText('preserved answer'),
    };
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: QUIZ_BLANK_NODE_TYPE, attrs: { blankIndex: 2 } },
            { type: 'text', text: ' before ' },
            {
              type: QUIZ_BLANK_NODE_TYPE,
              attrs: { blankId: existing.id, blankIndex: 1 },
            },
          ],
        },
      ],
    };

    const synchronized = synchronizeQuizQuestionBlanks('fill_in_the_blank', document, [existing]);
    expect(synchronized.blanks.map((blank) => blank.id)).toEqual(['blank-2', 'blank-1']);
    expect(synchronized.blanks[1]?.answer).toEqual(existing.answer);
    expect(allocateQuizBlankId(synchronized.blanks.map((blank) => blank.id))).toBe('blank-3');

    const reloaded = parseQuizQuestionValue(
      JSON.parse(
        JSON.stringify({
          ...createQuizQuestion('fill_in_the_blank', 1, 'fill-question'),
          blanks: synchronized.blanks,
          question: synchronized.document,
        }),
      ),
    );
    expect(reloaded.blanks?.map((blank) => blank.id)).toEqual(['blank-2', 'blank-1']);
    expect(reloaded.question.content?.[0]?.content?.map((node) => node.attrs?.blankId)).toEqual([
      'blank-2',
      undefined,
      'blank-1',
    ]);
  });

  it('rejects duplicate durable blank ids', () => {
    expect(() =>
      parseQuizQuestionValue({
        ...createQuizQuestion('fill_in_the_blank', 1, 'fill-question'),
        blanks: [
          { answer: richTextFromPlainText('one'), blank_index: 1, id: 'duplicate' },
          { answer: richTextFromPlainText('two'), blank_index: 2, id: 'duplicate' },
        ],
      }),
    ).toThrow('Quiz blank ids must be unique.');
  });
});
describe('persisted question scores', () => {
  it.each([
    'single_choice',
    'multiple_choice',
    'short_answer',
    'fill_in_the_blank',
    'cloze',
    'fill_with_candidates',
  ] as const)('preserves exact zero and decimal scores for %s roots and nested readers', (type) => {
    const root = {
      ...createQuizQuestion(type, 1, 'root'),
      points: 0,
      sub_problems: [
        {
          ...createQuizQuestion(type, 1, 'child'),
          points: 0.25,
          sub_problems: [{ ...createQuizQuestion('short_answer', 1, 'grandchild'), points: 1.75 }],
        },
      ],
    };
    const input = JSON.parse(JSON.stringify(root));
    const parsed = parseQuizQuestionValue(input);
    expect(parsed.points).toBe(0);
    expect(parsed.sub_problems[0].points).toBe(0.25);
    expect(parsed.sub_problems[0].sub_problems[0].points).toBe(1.75);
    expect(input).toEqual(root);
    expect(parseQuizQuestionValue(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
  it.each([
    undefined,
    null,
    '0.25',
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('keeps the legacy fallback for invalid score %s', (points) => {
    expect(
      parseQuizQuestionValue({ ...createQuizQuestion('short_answer', 1), points }).points,
    ).toBe(10);
  });
});
