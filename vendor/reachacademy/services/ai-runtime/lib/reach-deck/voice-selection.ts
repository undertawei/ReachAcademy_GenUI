import { createHash } from 'node:crypto';

import type { ReachDeckSpeechMarkupV1 } from '@reachany/reach-deck-dsl';

/** Legacy recovery identity only; new speech resolves the teacher agent's configured voice. */
export const REACH_DECK_DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts' as const;

export type ReachDeckVoiceSelection =
  | {
      readonly kind: 'default';
      readonly voice: string;
    }
  | {
      readonly kind: 'clone';
      readonly grantId: string;
      readonly cloneId: string;
      readonly synthesisRevision: number;
      readonly courseId: string;
      readonly agentRole: 'teacher';
    };

/** Compatibility snapshot for historical jobs, not a runtime voice default. */
export const DEFAULT_REACH_DECK_VOICE_SELECTION: ReachDeckVoiceSelection = Object.freeze({
  kind: 'default',
  voice: REACH_DECK_DEFAULT_VOICE,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOICE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseReachDeckVoiceSelection(value: unknown): ReachDeckVoiceSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Reach Deck voice selection must be an object');
  }
  const input = value as Record<string, unknown>;
  if (input.kind === 'default') {
    exactKeys(input, ['kind', 'voice']);
    if (typeof input.voice !== 'string' || !VOICE_PATTERN.test(input.voice)) {
      throw new Error('Reach Deck default voice selection is invalid');
    }
    return Object.freeze({ kind: 'default', voice: input.voice });
  }
  if (input.kind !== 'clone') throw new Error('Reach Deck voice selection kind is invalid');
  exactKeys(input, ['kind', 'grantId', 'cloneId', 'synthesisRevision', 'courseId', 'agentRole']);
  if (input.agentRole !== 'teacher') {
    throw new Error('Reach Deck clone voice selection role is invalid');
  }
  const synthesisRevision = input.synthesisRevision;
  if (!Number.isSafeInteger(synthesisRevision) || (synthesisRevision as number) < 1) {
    throw new Error('Reach Deck clone voice revision is invalid');
  }
  return Object.freeze({
    kind: 'clone',
    grantId: uuid(input.grantId, 'grantId'),
    cloneId: uuid(input.cloneId, 'cloneId'),
    synthesisRevision: synthesisRevision as number,
    courseId: uuid(input.courseId, 'courseId'),
    agentRole: 'teacher',
  });
}

export function reachDeckVoiceSelectionDigest(selection: ReachDeckVoiceSelection): string {
  return createHash('sha256')
    .update(JSON.stringify(parseReachDeckVoiceSelection(selection)))
    .digest('hex');
}

/** Historical Vivi receipts retain the identities deployed before configurable ordinary voices. */
export function isLegacyReachDeckVoiceSelection(selection: ReachDeckVoiceSelection): boolean {
  return selection.kind === 'default' && selection.voice === REACH_DECK_DEFAULT_VOICE;
}

export function sameReachDeckVoiceSelection(
  left: ReachDeckVoiceSelection,
  right: ReachDeckVoiceSelection,
): boolean {
  return reachDeckVoiceSelectionDigest(left) === reachDeckVoiceSelectionDigest(right);
}

/** 克隆音色只支持 break、sub、say-as、phoneme 标记，且不支持整段 speak 设置。 */
export function reachDeckVoiceSupportsSpeechMarkup(
  voiceKind: ReachDeckVoiceSelection['kind'],
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
): boolean {
  return (
    voiceKind !== 'clone' ||
    speechMarkup === undefined ||
    (speechMarkup.speak === undefined &&
      speechMarkup.marks.every((mark) => ['break', 'sub', 'say-as', 'phoneme'].includes(mark.type)))
  );
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`Reach Deck clone voice ${name} is invalid`);
  }
  return value.toLowerCase();
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(input).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Reach Deck voice selection contains unknown fields');
  }
}
