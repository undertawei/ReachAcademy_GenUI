import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REACH_DECK_VOICE_SELECTION,
  isLegacyReachDeckVoiceSelection,
  parseReachDeckVoiceSelection,
  reachDeckVoiceSelectionDigest,
} from '../../lib/reach-deck/voice-selection.js';

describe('Reach Deck voice snapshots', () => {
  it('accepts configured ordinary voices and isolates their frozen identity', () => {
    const first = parseReachDeckVoiceSelection({ kind: 'default', voice: 'teacher_voice_a' });
    const second = parseReachDeckVoiceSelection({ kind: 'default', voice: 'teacher_voice_b' });
    expect(first).toEqual({ kind: 'default', voice: 'teacher_voice_a' });
    expect(Object.isFrozen(first)).toBe(true);
    expect(reachDeckVoiceSelectionDigest(first)).not.toBe(reachDeckVoiceSelectionDigest(second));
    expect(isLegacyReachDeckVoiceSelection(first)).toBe(false);
    expect(isLegacyReachDeckVoiceSelection(DEFAULT_REACH_DECK_VOICE_SELECTION)).toBe(true);
  });

  it.each(['', 'unsafe voice', 'voice\nheader', 'v'.repeat(129), null])(
    'rejects unsafe voice %s',
    (voice) => {
      expect(() => parseReachDeckVoiceSelection({ kind: 'default', voice })).toThrow(/invalid/);
    },
  );

  it('rejects caller-owned extra selection fields', () => {
    expect(() =>
      parseReachDeckVoiceSelection({
        kind: 'default',
        voice: 'teacher_voice_a',
        grantId: 'injected',
      }),
    ).toThrow(/unknown fields/);
  });
});
