export interface FeedforwardUsageObservation {
  capability: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
  questionId: string;
}

export interface FeedforwardToolObservation {
  toolName: string;
  toolCallId: string;
  questionId: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  durationMs?: number;
}

export interface FeedforwardRuntimeObserver {
  usage?(observation: FeedforwardUsageObservation): void | Promise<void>;
  toolStarted?(observation: FeedforwardToolObservation): void | Promise<void>;
  toolCompleted?(observation: FeedforwardToolObservation): void | Promise<void>;
  questionCompleted?(observation: {
    questionId: string;
    skillIds: string[];
    toolCallCounts: Record<string, number>;
  }): void | Promise<void>;
}
