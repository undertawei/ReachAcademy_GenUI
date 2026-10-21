/** 单题批阅 agent 的题目、作答与设置契约（统一作答批阅共用）。 */
export interface FeedforwardQuizSettings {
  scoringEnabled: boolean;
  reviewRequired: boolean;
  feedforwardEnabled: boolean;
  subjectCode?: string;
  feedbackRequirements?: unknown;
  feedbackRequirementAttachments: FeedforwardAnswerAttachment[];
}

export type FeedforwardQuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'fill_in_the_blank'
  | 'cloze'
  | 'fill_with_candidates'
  | 'short_answer';

export interface FeedforwardQuizBlank {
  blankIndex: number;
  answer: unknown;
  candidates: Array<{ value: string; label: unknown }>;
}

export interface FeedforwardQuizQuestion {
  id: string;
  questionType: FeedforwardQuestionType | string;
  questionIndex?: number;
  question: unknown;
  questionAttachments: FeedforwardAnswerAttachment[];
  options: Array<{ value: string; label: unknown }>;
  answer: unknown;
  blanks: FeedforwardQuizBlank[];
  candidates: string[];
  analysis: unknown;
  analysisAttachments: FeedforwardAnswerAttachment[];
  points: number;
  cognitiveSchema?: unknown;
  hasAnswer: boolean;
  subProblems: FeedforwardQuizQuestion[];
  feedforwardRequirement?: string;
}

export interface FeedforwardSubmissionAnswer {
  questionId: string;
  response: string | string[] | null;
  blankResponses: Array<{
    blankIndex: number;
    response: string | string[] | null;
  }>;
  richText: unknown;
  attachments: FeedforwardAnswerAttachment[];
}

export interface FeedforwardAnswerAttachment {
  objectKey: string;
  name?: string;
  contentType?: string;
  sizeBytes?: number;
  downloadUrl?: string;
}

export type FeedforwardEnv = Partial<Record<string, string | undefined>>;

export interface FeedforwardModelRequestContext {
  readonly attemptId?: string;
  readonly submissionId: string;
  readonly generationRunId?: string;
  readonly organizationId: string;
  readonly questionId?: string;
}
