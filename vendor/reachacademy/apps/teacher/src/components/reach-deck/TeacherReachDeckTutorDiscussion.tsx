'use client';
import { TeacherLoadingRegion } from '../TeacherLoading';

import { describeTutorGuardrailError } from '@/src/lib/ai-guardrail-error';
import { useMemo } from 'react';
import {
  DirectedTutorDiscussion,
  TutorDiscussion,
  useDirectedTutorThread,
  type DiscussionPageSummary,
  type TutorFenceCardSummary,
} from '@reachany/tutor-ui';
import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import {
  useTeacherTrialTutorThread,
  type TeacherTrialTutorLearningContext,
} from './useTeacherTrialTutorThread';
import { tutorRichTextAdapter } from './tutor-rich-text-adapter';
import { createTutorDiscussionTranslator } from './tutor-discussion-translator';

export type { DiscussionPageSummary } from '@reachany/tutor-ui';
export type TeacherTrialFenceCardSummary = TutorFenceCardSummary;
export type TeacherTutorDiscussionVariant = 'ordinary' | 'learning-fence';

interface TeacherReachDeckTutorDiscussionProps {
  activePageId?: string;
  domainScope: Record<string, string>;
  learningContext: TeacherTrialTutorLearningContext | null;
  learningFences?: TeacherTrialFenceCardSummary[];
  onNavigateToPage?: (pageId: string) => void;
  onRunSettled?: () => void;
  openingMessage?: string;
  onOpenLearningFence?: (key: string, source?: HTMLButtonElement) => void;
  onTrialFenceReleased?: () => void;
  pages: DiscussionPageSummary[];
  readOnly?: boolean;
  readOnlyNotice?: string;
  systemNotice?: string;
  variant?: TeacherTutorDiscussionVariant;
}

export function TeacherReachDeckTutorDiscussion({
  variant = 'ordinary',
  ...props
}: TeacherReachDeckTutorDiscussionProps) {
  return variant === 'learning-fence' ? (
    <LegacyTeacherReachDeckTutorDiscussion {...props} variant={variant} />
  ) : (
    <DirectedTeacherReachDeckTutorDiscussion {...props} />
  );
}

function DirectedTeacherReachDeckTutorDiscussion({
  activePageId,
  domainScope,
  learningFences = [],
  learningContext,
  onNavigateToPage,
  onRunSettled,
  onOpenLearningFence,
  pages,
  readOnly = false,
  readOnlyNotice,
}: TeacherReachDeckTutorDiscussionProps) {
  const { locale, t } = usePortalI18n();
  const resolveAvatarUri = useMemo(() => {
    const courseId = domainScope.courseId;
    if (!courseId) return undefined;
    return (avatarRef: string, agentId?: string) => {
      const configurationId = agentId ?? avatarRef.slice('avatar-ref/v1/'.length);
      return `/teacher/courses/${encodeURIComponent(courseId)}/configuration/avatar/${encodeURIComponent(configurationId)}/media`;
    };
  }, [domainScope]);
  const thread = useDirectedTutorThread({
    domainScope,
    initialLearningContext: learningContext,
    initErrorText: t('student.tutor.initFailed'),
    connectionLostText: t('student.tutor.connectionLost'),
    runFailedText: t('student.tutor.runFailed'),
    resolveAvatarUri,
    describeError: (error) => describeTutorGuardrailError(error, t),
  });

  const translate = useMemo(() => createTutorDiscussionTranslator(t), [t]);
  return (
    <DirectedTutorDiscussion
      loadingIndicator={<TeacherLoadingRegion />}
      activePageId={activePageId}
      ariaLabel={t('reachDeck.discussion.label')}
      contextReady={learningContext !== null}
      emptyText={t('reachDeck.discussion.empty')}
      learningFences={learningFences}
      locale={locale}
      onNavigateToPage={onNavigateToPage}
      onOpenLearningFence={onOpenLearningFence}
      onRunSettled={onRunSettled}
      pages={pages}
      readOnly={readOnly}
      readOnlyNotice={readOnlyNotice}
      resolveLearningContext={() => learningContext}
      richText={tutorRichTextAdapter}
      subtitle={t('reachDeck.discussion.subtitle')}
      t={translate}
      thread={thread}
      waitingText={t('reachDeck.discussion.composerWaiting')}
    />
  );
}

function LegacyTeacherReachDeckTutorDiscussion({
  activePageId,
  domainScope,
  learningFences = [],
  learningContext,
  onNavigateToPage,
  onRunSettled,
  openingMessage,
  onOpenLearningFence,
  onTrialFenceReleased,
  pages,
  readOnly = false,
  readOnlyNotice,
  systemNotice,
  variant = 'learning-fence',
}: TeacherReachDeckTutorDiscussionProps) {
  const { locale, t } = usePortalI18n();
  const thread = useTeacherTrialTutorThread({
    domainScope,
    failedText: t('student.tutor.incomplete'),
    stoppedText: t('student.tutor.stopped'),
    initErrorText: t('student.tutor.initFailed'),
    unavailableText: t('student.tutor.unavailable'),
    connectionLostText: t('student.tutor.connectionLost'),
    runFailedText: t('student.tutor.runFailed'),
    describeError: (error) => describeTutorGuardrailError(error, t),
    onTrialFenceReleased,
  });
  const translate = useMemo(() => createTutorDiscussionTranslator(t), [t]);
  return (
    <TutorDiscussion
      loadingIndicator={<TeacherLoadingRegion />}
      activePageId={activePageId}
      contextReady={learningContext !== null}
      learningFences={learningFences}
      locale={locale}
      onNavigateToPage={onNavigateToPage}
      onOpenLearningFence={onOpenLearningFence}
      onRunSettled={onRunSettled}
      onSubmit={(message, options) =>
        learningContext === null
          ? Promise.resolve(false)
          : thread.submit(message, learningContext, options)
      }
      openingMessage={openingMessage}
      pages={pages}
      readOnly={readOnly}
      readOnlyNotice={readOnlyNotice}
      richText={tutorRichTextAdapter}
      systemNotice={systemNotice}
      t={translate}
      thread={{ ...thread, submissionPending: thread.trialFenceReleasePending }}
      variant={variant}
    />
  );
}
