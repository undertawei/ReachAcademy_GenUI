export const QUIZ_INLINE_MATH_OPEN = '\\(';
export const QUIZ_INLINE_MATH_CLOSE = '\\)';
export const QUIZ_BLOCK_MATH_OPEN = '\\[';
export const QUIZ_BLOCK_MATH_CLOSE = '\\]';

export const QUIZ_FEEDBACK_COLORS = ['accent', 'success', 'warning', 'danger', 'muted'] as const;

export type QuizFeedbackColor = (typeof QUIZ_FEEDBACK_COLORS)[number];

export const QUIZ_MARKDOWN_LIMITS = {
  maxLength: 40_000,
  maxMermaidLength: 8_000,
  maxPatchOperations: 8,
  maxPatchTextLength: 1_000,
  maxPatchChangedCharacters: 2_000,
} as const;
