'use client';

import { BrandLoader } from '@reachany/ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import type { TutorLearningContext } from '@/src/components/student/tutor-learning-context';

import {
  StudentReachDeckTutorDiscussion,
  type DiscussionPageSummary,
  type LearningFenceCardSummary,
} from './StudentReachDeckTutorDiscussion';

export function StudentReachDeckDiscussion({
  activePageId,
  domainScope,
  learningFences,
  learningContext,
  onOpenLearningFence,
  onNavigateToPage,
  readOnly,
  readOnlyNotice,
  pages = [],
  preparing = false,
}: {
  activePageId?: string;
  domainScope: Record<string, string> | null;
  learningContext: TutorLearningContext | null;
  learningFences?: LearningFenceCardSummary[];
  onOpenLearningFence?: (fenceId: string, source?: HTMLButtonElement) => void;
  onNavigateToPage?: (pageId: string) => void;
  readOnly?: boolean;
  readOnlyNotice?: string;
  pages?: DiscussionPageSummary[];
  /** 本次学习正在开始或载入：学习上下文马上就绪，先放 loading；起不来时才显示说明文字。 */
  preparing?: boolean;
}) {
  const { t } = usePortalI18n();

  if (domainScope === null) {
    return (
      <aside
        aria-label={t('reachDeck.discussion.label')}
        className="flex min-h-0 flex-col border-l border-line bg-surface"
      >
        <div className="grid min-h-72 flex-1 place-items-center p-5 text-center text-caption text-fg-secondary">
          {preparing ? (
            <BrandLoader label={t('student.tutor.loadingThread')} />
          ) : (
            t('reachDeck.discussion.waiting')
          )}
        </div>
      </aside>
    );
  }
  return (
    <StudentReachDeckTutorDiscussion
      activePageId={activePageId}
      domainScope={domainScope}
      learningFences={learningFences}
      learningContext={learningContext}
      onOpenLearningFence={onOpenLearningFence}
      onNavigateToPage={onNavigateToPage}
      readOnly={readOnly}
      readOnlyNotice={readOnlyNotice}
      pages={pages}
    />
  );
}
