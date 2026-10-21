'use client';

import type { DiscussionPageSummary } from '@reachany/tutor-ui';
import type { TutorLearningContext } from '@/src/components/student/tutor-learning-context';
import { StudentReachDeckConversation } from './StudentReachDeckConversation';

export type { DiscussionPageSummary } from '@reachany/tutor-ui';
export interface LearningFenceCardSummary {
  activatedAt: string;
  fenceId: string;
  pageId: string;
}

export function StudentReachDeckTutorDiscussion({
  learningFences = [],
  ...props
}: {
  activePageId?: string;
  domainScope: Record<string, string>;
  learningContext: TutorLearningContext | null;
  learningFences?: LearningFenceCardSummary[];
  onOpenLearningFence?: (fenceId: string, source?: HTMLButtonElement) => void;
  onNavigateToPage?: (pageId: string) => void;
  readOnly?: boolean;
  readOnlyNotice?: string;
  pages: DiscussionPageSummary[];
}) {
  return (
    <StudentReachDeckConversation
      {...props}
      learningFences={learningFences.map(({ fenceId, ...fence }) => ({ ...fence, key: fenceId }))}
    />
  );
}
