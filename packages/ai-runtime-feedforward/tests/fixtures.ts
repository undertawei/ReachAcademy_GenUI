import type {
  FeedforwardQuizQuestion,
  FeedforwardQuizSettings,
  FeedforwardSubmissionAnswer,
} from '../src/contracts.js';

/** 测试共享 fixture：构造符合正典 schema（解析后内部模型）的题目 / 作答 / bundle。 */

export const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';
export const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
export const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';

export function textDoc(text: string): unknown {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

export function buildSettings(
  overrides: Partial<FeedforwardQuizSettings> = {},
): FeedforwardQuizSettings {
  return {
    scoringEnabled: true,
    reviewRequired: false,
    feedforwardEnabled: true,
    feedbackRequirementAttachments: [],
    subjectCode: 'math',
    ...overrides,
  };
}

export function buildQuestion(
  overrides: Partial<FeedforwardQuizQuestion> = {},
): FeedforwardQuizQuestion {
  return {
    id: 'q-1',
    questionType: 'short_answer',
    questionIndex: 1,
    question: textDoc('求解方程 x^2 - 4 = 0，写出完整解题步骤。'),
    questionAttachments: [],
    options: [],
    answer: textDoc('x = 2 或 x = -2'),
    blanks: [],
    candidates: [],
    analysis: textDoc('平方差公式分解。'),
    analysisAttachments: [],
    points: 10,
    hasAnswer: true,
    subProblems: [],
    ...overrides,
  };
}

export function buildAnswer(
  overrides: Partial<FeedforwardSubmissionAnswer> = {},
): FeedforwardSubmissionAnswer {
  return {
    questionId: 'q-1',
    response: null,
    blankResponses: [],
    richText: textDoc('x^2 = 4，所以 x = 2。'),
    attachments: [],
    ...overrides,
  };
}
