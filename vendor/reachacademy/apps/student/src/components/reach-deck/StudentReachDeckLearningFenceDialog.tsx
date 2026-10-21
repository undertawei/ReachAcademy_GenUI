'use client';

import type { ReactNode } from 'react';
import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import type { StudentDeckLearningFence } from '@/src/lib/public-v2-reach-deck-client';
import { StudentReachDeckFenceConversation } from './StudentReachDeckFenceConversation';

export function StudentReachDeckLearningFenceDialog({
  domainScope,
  fence,
  onRunSettled,
  locked = false,
  welcomeText,
  readOnlyNotice,
  systemNotice,
  recoveryAction,
}: {
  domainScope: Record<string, string>;
  fence: StudentDeckLearningFence;
  onRunSettled: () => void;
  locked?: boolean;
  welcomeText?: string;
  readOnlyNotice?: string;
  systemNotice?: string;
  recoveryAction?: ReactNode;
}) {
  const { t } = usePortalI18n();
  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
      <StudentReachDeckFenceConversation
        domainScope={domainScope}
        learningContext={{
          schemaVersion: 'reach-deck-learning-fence-context/v1',
          attemptId: fence.attemptId,
          fenceId: fence.fenceId,
          observedAt: new Date().toISOString(),
          pageId: fence.pageId,
          questionId: fence.questionId,
          sceneId: fence.sceneId,
        }}
        onRunSettled={onRunSettled}
        readOnly={!locked}
        openingMessage={welcomeText ?? t('reachDeck.learningFence.tutorOpening')}
        readOnlyNotice={readOnlyNotice}
        systemNotice={systemNotice}
      />
      {recoveryAction ? (
        <div className="bg-surface-muted p-3 text-center">{recoveryAction}</div>
      ) : null}
    </div>
  );
}
