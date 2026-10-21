import {
  createQuizQuestion,
  richTextFromPlainText,
  type PageOutline,
  type QuizScene,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  limitPreviousQuizSummaries,
  PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS,
  summarizePreviousQuiz,
  parsePreviousQuizSummaryValue,
  type PreviousQuizSummary,
} from '../../lib/reach-deck/previous-quiz-summary.js';

describe('Reach Deck previous quiz summaries', () => {
  it('keeps consecutive quiz context valid when a teacher clears the objective and title', () => {
    const page = { ...outline({ learningObjective: '', assessmentEvidence: '' }), title: '' };
    const summary = summarizePreviousQuiz(
      'page-empty',
      page,
      quizScene({ question: 'Which observation supports the claim?', cognitiveEvidence: '' }),
    );
    expect(summary.learningObjective).toBe('Which observation supports the claim?');
    expect(parsePreviousQuizSummaryValue(summary)).toEqual(summary);
    expect(page.title).toBe('');
    expect(page.instructionalSpec?.learningObjective).toBe('');
  });
  it('builds normalized bounded context without choices, answers, or analysis', () => {
    const summary = summarizePreviousQuiz(
      '  page-neutral  ',
      outline(),
      quizScene({
        question: '  Which observation\n supports the classification?  ',
        cognitiveEvidence: '  Compare   the observations\nthen classify.  ',
      }),
    );

    expect(summary).toEqual({
      pageId: 'page-neutral',
      learningObjective: 'Classify observations using stated criteria.',
      assessmentEvidence: 'Select evidence and justify the classification.',
      teachingMove: 'evaluate',
      questionType: 'single_choice',
      questionSummary: 'Which observation supports the classification?',
      cognitiveEvidence: 'Compare the observations then classify.',
    });
    expect(Object.keys(summary)).toEqual([
      'pageId',
      'learningObjective',
      'assessmentEvidence',
      'teachingMove',
      'questionType',
      'questionSummary',
      'cognitiveEvidence',
    ]);
    expect(JSON.stringify(summary)).not.toContain('Option-only marker');
    expect(JSON.stringify(summary)).not.toContain('Reference-answer marker');
    expect(JSON.stringify(summary)).not.toContain('Analysis-only marker');
  });

  it('truncates every free-text field and omits blank optional evidence', () => {
    const page = outline({
      learningObjective: `  ${'o'.repeat(260)}  `,
      assessmentEvidence: `  ${'e'.repeat(260)}  `,
    });
    const summary = summarizePreviousQuiz(
      'page-bounded',
      page,
      quizScene({
        question: `  ${'q'.repeat(520)}  `,
        cognitiveEvidence: `  ${'c'.repeat(320)}  `,
      }),
    );

    expect(summary.learningObjective).toHaveLength(
      PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.learningObjective,
    );
    expect(summary.assessmentEvidence).toHaveLength(
      PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.assessmentEvidence,
    );
    expect(summary.questionSummary).toHaveLength(PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.questionSummary);
    expect(summary.cognitiveEvidence).toHaveLength(
      PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.cognitiveEvidence,
    );

    const withoutOptionalEvidence = summarizePreviousQuiz(
      'page-empty-evidence',
      outline({ assessmentEvidence: '   \n  ' }),
      quizScene({ question: 'Choose the supported statement.', cognitiveEvidence: '  \n ' }),
    );
    expect(withoutOptionalEvidence).not.toHaveProperty('assessmentEvidence');
    expect(withoutOptionalEvidence).not.toHaveProperty('cognitiveEvidence');
  });

  it('keeps only the newest three summaries in page order without mutating the input', () => {
    const summaries = [1, 2, 3, 4, 5].map(summaryFixture);

    expect(limitPreviousQuizSummaries(summaries).map((summary) => summary.pageId)).toEqual([
      'page-3',
      'page-4',
      'page-5',
    ]);
    expect(summaries.map((summary) => summary.pageId)).toEqual([
      'page-1',
      'page-2',
      'page-3',
      'page-4',
      'page-5',
    ]);
  });
});

function outline(
  instructionalOverrides: Partial<NonNullable<PageOutline['instructionalSpec']>> = {},
): PageOutline {
  return {
    id: 'page-neutral',
    order: 1,
    sceneType: 'quiz',
    title: 'Evidence classification check',
    instructionalSpec: {
      learningObjective: '  Classify observations   using stated criteria.  ',
      teachingMove: 'evaluate',
      keyPoints: ['Distinguish observations from interpretations.'],
      assessmentEvidence: '  Select evidence and justify\n the classification.  ',
      visualDirection: 'Use a compact evidence table.',
      density: 'medium',
      visualAssets: [],
      ...instructionalOverrides,
    },
  };
}

function quizScene(input: { question: string; cognitiveEvidence: string }): QuizScene {
  const question = createQuizQuestion('single_choice', 1, 'question-neutral');
  return {
    schemaVersion: 'reach-quiz-scene/v1',
    id: 'page-neutral',
    title: 'Evidence classification check',
    sceneType: 'quiz',
    content: {
      questions: [
        {
          ...question,
          question: richTextFromPlainText(input.question),
          cognitive_schema: richTextFromPlainText(input.cognitiveEvidence),
          analysis: richTextFromPlainText('Analysis-only marker'),
          options: [
            { value: 'A', label: richTextFromPlainText('Option-only marker') },
            { value: 'B', label: richTextFromPlainText('Another neutral option') },
          ],
          answer: ['Reference-answer marker'],
          has_answer: true,
        },
      ],
      display_mode: 'single_question',
      navigation: 'horizontal',
      show_progress: true,
      show_question_index: true,
      answer_reveal: 'after_submit',
      allow_previous: true,
      allow_skip: false,
    },
  };
}

function summaryFixture(index: number): PreviousQuizSummary {
  return {
    pageId: `page-${index}`,
    learningObjective: `Objective ${index}`,
    teachingMove: 'evaluate',
    questionType: 'single_choice',
    questionSummary: `Question ${index}`,
  };
}
