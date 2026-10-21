import type { QuestionAnswer, ReachDeckSceneType } from '@reachany/reach-deck-dsl';
import type { InteractiveBridgePhase } from './interactiveBridge.js';
import type { ObjectiveGrade } from './objectiveGrading.js';

export interface ReachDeckLayoutIssue {
  id: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
  elementIds: string[];
}

export interface QuizSceneRuntimeState {
  kind: 'quiz';
  sceneId: string;
  sourceRevision: number;
  activeIndex: number;
  answers: Record<string, QuestionAnswer>;
  submitted: Record<string, true>;
  sceneCompleted: boolean;
}

export interface InteractiveSceneRuntimeState {
  kind: 'interactive';
  sceneId: string;
  sourceRevision: number;
  attempt: number;
  phase: InteractiveBridgePhase;
  snapshot?: unknown;
  geometry?: unknown;
  completed: boolean;
  errorCode?: string;
}

/**
 * Server-authoritative grading of one submitted question, projected from the page runtime
 * `state.serverGrading[questionId]`. `retrying` and `retryMessage` are host-owned UI state.
 */
export interface QuizGradingView {
  status: 'grading' | 'graded' | 'failed';
  maxScore: number;
  score?: number;
  result?: 'correct' | 'incorrect';
  rationale?: string;
  feedbackMarkdown?: string;
  /**
   * Only on `graded` entries whose score is already final (a wrong objective answer, #804): the AI
   * feedback is still being written (`grading`) or failed (`failed`, retryable through `onRetryGrading`).
   */
  feedbackStatus?: 'grading' | 'failed';
  retrying?: boolean;
  retryMessage?: string;
  /** The learner used every manual regrade; the retry action stays disabled. */
  retryExhausted?: boolean;
}

/** `server` for learner hosts (default); `trial` only for Teacher Trial/authoring previews. */
export type QuizGradingMode = 'server' | 'trial';

/**
 * 题目页排布。`default` 为原有的单卡片排布；`learner`（学生端）把题目页铺满舞台：顶部标题与
 * 题号导航、中间作答区内部滚动、底部操作条固定，并按题型给出紧凑的作答控件。
 */
export type QuizSceneLayout = 'default' | 'learner';

export type QuizGradingByQuestionId = Readonly<Record<string, QuizGradingView>>;

export type ReachDeckSceneRuntimeState = QuizSceneRuntimeState | InteractiveSceneRuntimeState;

export type ReachDeckRuntimeByPageId = Record<string, ReachDeckSceneRuntimeState>;

/** Bounded by the AI Runtime before use; page content is resolved server-side. */
export interface ReachDeckPlayerActivity {
  schemaVersion: 'reach-deck-player-activity/v1';
  pageId: string;
  sceneId: string;
  sceneType: ReachDeckSceneType;
  sourceRevision: number;
  state: unknown;
}

export type ReachDeckPlayerEvent =
  | {
      type: 'pageEnter';
      pageId: string;
      sceneType: ReachDeckSceneType;
      revision: number;
    }
  | {
      type: 'quizSubmit';
      pageId: string;
      questionId: string;
      /**
       * Local objective grade, emitted only when the host supplies no server grading (Teacher
       * Trial). Learner hosts receive grading results from the server instead.
       */
      trialGrade?: ObjectiveGrade;
    }
  | {
      type: 'interactiveComplete';
      pageId: string;
    }
  | {
      type: 'interactiveLearningEvent';
      pageId: string;
      sceneId: string;
      revision: number;
      manifestVersion: 'reach-interactive-event-manifest/v1';
      eventName: string;
      eventVersion: 1;
      payload: Record<string, string | number | boolean>;
      wireSequence: number;
    };
