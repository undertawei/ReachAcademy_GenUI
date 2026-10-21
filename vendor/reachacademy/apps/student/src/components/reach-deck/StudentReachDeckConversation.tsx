'use client';

import { describeTutorGuardrailError } from '@/src/lib/ai-guardrail-error';
import { useMemo } from 'react';
import { BrandLoader } from '@reachany/ui';
import {
  DirectedTutorDiscussion,
  TutorDiscussion,
  useDirectedTutorThread,
  type TutorDiscussionProps,
} from '@reachany/tutor-ui';
import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import { useTutorThread } from '@/src/components/student/useTutorThread';
import type { TutorLearningContext } from '@/src/components/student/tutor-learning-context';
import { tutorRichTextAdapter } from './tutor-rich-text-adapter';
import { createTutorDiscussionTranslator } from './tutor-discussion-translator';

export type StudentReachDeckConversationProps = Omit<
  TutorDiscussionProps,
  'contextReady' | 'locale' | 't' | 'richText' | 'thread' | 'onSubmit'
> & {
  domainScope: Record<string, string>;
  learningContext: TutorLearningContext | null;
};

export function StudentReachDeckConversation({
  variant = 'ordinary',
  ...props
}: StudentReachDeckConversationProps) {
  return variant === 'learning-fence' ? (
    <LegacyStudentReachDeckConversation {...props} variant={variant} />
  ) : (
    <DirectedStudentReachDeckConversation {...props} />
  );
}

function DirectedStudentReachDeckConversation({
  activePageId,
  domainScope,
  learningFences,
  learningContext,
  onNavigateToPage,
  onOpenLearningFence,
  onRunSettled,
  pages,
  readOnly,
  readOnlyNotice,
}: StudentReachDeckConversationProps) {
  const { locale, t } = usePortalI18n();
  const resolveAvatarUri = useMemo(() => {
    const selectionId = domainScope.selectionId;
    const attemptId = domainScope.attemptId;
    const moduleVersionId = domainScope.moduleVersionId;
    if (!selectionId || !attemptId || !moduleVersionId) return undefined;
    return (avatarRef: string, agentId?: string) => {
      const configurationId = agentId ?? avatarRef.slice('avatar-ref/v1/'.length);
      return `/api/student/reach-deck/track-modules/${encodeURIComponent(selectionId)}/attempts/${encodeURIComponent(attemptId)}/course-agent-avatar/${encodeURIComponent(configurationId)}?moduleVersionId=${encodeURIComponent(moduleVersionId)}`;
    };
  }, [domainScope]);
  const thread = useDirectedTutorThread({
    domainScope,
    initialLearningContext: learningContext,
    initErrorText: t('student.tutor.serviceUnavailable'),
    connectionLostText: t('student.tutor.connectionLost'),
    runFailedText: t('student.tutor.runFailed'),
    resolveAvatarUri,
    describeError: (error) => describeTutorGuardrailError(error, t),
  });
  const translate = useMemo(() => createTutorDiscussionTranslator(t), [t]);
  return (
    <DirectedTutorDiscussion
      activePageId={activePageId}
      ariaLabel={t('reachDeck.discussion.label')}
      contextReady={learningContext !== null}
      emptyText={t('reachDeck.discussion.empty')}
      composerFootnote={t('reachDeck.sidePanel.tutorDisclaimer')}
      learningFences={learningFences}
      loadingIndicator={<BrandLoader label={t('student.tutor.loadingThread')} />}
      locale={locale}
      onNavigateToPage={onNavigateToPage}
      onOpenLearningFence={onOpenLearningFence}
      onRunSettled={onRunSettled}
      pages={pages}
      readOnly={readOnly}
      readOnlyNotice={readOnlyNotice}
      resolveLearningContext={() => learningContext}
      richText={tutorRichTextAdapter}
      // Deck 右栏的页签已经写着「AI 对话」：不再重复标题区；发送键用紧凑分体样式（图标 + 快捷键）。
      sendButton="shortcut"
      showHeader={false}
      subtitle={t('reachDeck.discussion.subtitle')}
      t={translate}
      thread={thread}
      waitingText={t('reachDeck.discussion.composerWaiting')}
    />
  );
}

function LegacyStudentReachDeckConversation({
  domainScope,
  learningContext,
  ...props
}: StudentReachDeckConversationProps) {
  const { locale, t } = usePortalI18n();
  const thread = useTutorThread({
    domainScope,
    failedText: t('student.tutor.incomplete'),
    stoppedText: t('student.tutor.stopped'),
    initErrorText: t('student.tutor.serviceUnavailable'),
    unavailableText: t('student.tutor.serviceUnavailable'),
    connectionLostText: t('student.tutor.connectionLost'),
    runFailedText: t('student.tutor.runFailed'),
    describeError: (error) => describeTutorGuardrailError(error, t),
  });
  const translate = useMemo(() => createTutorDiscussionTranslator(t), [t]);
  return (
    <TutorDiscussion
      {...props}
      contextReady={learningContext !== null}
      loadingIndicator={<BrandLoader label={t('student.tutor.loadingThread')} />}
      locale={locale}
      onSubmit={(message, options) =>
        learningContext === null
          ? Promise.resolve(false)
          : thread.submit(message, learningContext, options)
      }
      richText={tutorRichTextAdapter}
      t={translate}
      thread={thread}
    />
  );
}
