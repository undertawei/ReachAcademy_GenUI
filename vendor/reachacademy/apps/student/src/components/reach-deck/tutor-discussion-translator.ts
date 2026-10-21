import type { TutorDiscussionProps } from '@reachany/tutor-ui';

const COMMON_KEYS = new Set([
  'me',
  'voteUp',
  'voteDown',
  'replyInTopic',
  'replyInTopicHint',
  'replyToMessage',
  'replyingTo',
  'cancelReply',
  'replyPlaceholder',
  'inlineMath',
  'blockMath',
  'studentMessageAria',
  'tutorMessageAria',
  'emptyMessage',
]);
const FENCE_KEYS: Record<string, string> = {
  'fence.title': 'reachDeck.learningFence.historyCardTitle',
  'fence.readOnly': 'reachDeck.learningFence.readOnlyDescription',
  'fence.openHistory': 'reachDeck.learningFence.openHistory',
  'fence.description': 'reachDeck.learningFence.historyCardDescription',
};

export function createTutorDiscussionTranslator(
  t: TutorDiscussionProps['t'],
): TutorDiscussionProps['t'] {
  return (key, values) => {
    const suffix = key.startsWith('reachDeck.discussion.')
      ? key.slice('reachDeck.discussion.'.length)
      : '';
    return t(
      FENCE_KEYS[key] ?? (COMMON_KEYS.has(suffix) ? 'tutorDiscussion.' + suffix : key),
      values,
    );
  };
}
