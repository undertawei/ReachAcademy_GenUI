import type { TutorDiscussionProps } from '@reachany/tutor-ui';

const FENCE_KEYS: Record<string, string> = {
  'fence.title': 'reachDeck.trial.fenceHistoryCardTitle',
  'fence.readOnly': 'reachDeck.trial.fenceHistoryReadOnly',
  'fence.openHistory': 'reachDeck.trial.fenceOpenHistory',
  'fence.description': 'reachDeck.trial.fenceHistoryCardDescription',
};

export function createTutorDiscussionTranslator(
  t: TutorDiscussionProps['t'],
): TutorDiscussionProps['t'] {
  return (key, values) => {
    const commonKey = key.startsWith('tutorDiscussion.')
      ? `reachDeck.discussion.${key.slice('tutorDiscussion.'.length)}`
      : key;
    return t(FENCE_KEYS[key] ?? commonKey, values);
  };
}
