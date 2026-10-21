import { describe, expect, it } from 'vitest';
import { isReachDeckHarnessSlidesOnlyEnabled } from '../../lib/reach-deck/harness-mode.js';
import { releaseSkippedHarnessNarration } from '../../lib/reach-deck/harness-mode.js';
import type { GenerationWorkspace } from '@reachany/reach-deck-dsl';

describe('slide-only harness gate', () => {
  it('releases only the current completed slide in explicit slides-only mode', () => {
    const identity = { runId: 'run', pageId: 'page', requestedRevision: 1, attempt: 1 };
    const workspace = {
      records: { page: { request: identity } },
      statuses: { page: { ...identity, state: 'narrating' } },
      sceneArtifacts: { page: { ...identity, sceneType: 'slide', status: 'ready' } },
    } as unknown as GenerationWorkspace;
    const env = { REACH_DECK_HARNESS_MODE: 'on', REACH_DECK_HARNESS_SLIDES_ONLY: 'on' };
    expect(releaseSkippedHarnessNarration(workspace, 'page', 'now', {}).statuses.page.state).toBe(
      'narrating',
    );
    expect(
      releaseSkippedHarnessNarration(workspace, 'page', 'now', env).statuses.page,
    ).toMatchObject({ state: 'failed', retryable: false });
    for (const patch of [
      { attempt: 2 },
      { requestedRevision: 2 },
      { runId: 'other' },
      { status: 'stale' },
      { sceneType: 'interactive' },
    ]) {
      const changed = {
        ...workspace,
        sceneArtifacts: { page: { ...workspace.sceneArtifacts.page, ...patch } },
      } as GenerationWorkspace;
      expect(releaseSkippedHarnessNarration(changed, 'page', 'now', env)).toBe(changed);
    }
    const generating = {
      ...workspace,
      statuses: { page: { ...identity, state: 'generating', startedAt: 'now' } },
    } as GenerationWorkspace;
    expect(releaseSkippedHarnessNarration(generating, 'page', 'now', env)).toBe(generating);
  });
  it('requires both explicit gates, leaving production unchanged', () => {
    expect(isReachDeckHarnessSlidesOnlyEnabled({ REACH_DECK_HARNESS_SLIDES_ONLY: 'on' })).toBe(
      false,
    );
    expect(isReachDeckHarnessSlidesOnlyEnabled({ REACH_DECK_HARNESS_MODE: 'on' })).toBe(false);
    expect(
      isReachDeckHarnessSlidesOnlyEnabled({
        REACH_DECK_HARNESS_MODE: 'on',
        REACH_DECK_HARNESS_SLIDES_ONLY: 'on',
      }),
    ).toBe(true);
  });
});
