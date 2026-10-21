import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  launchDeckChromium,
  ReachDeckRendererUnavailableError,
} from '../../lib/reach-deck/code-media-policy.js';
import {
  classifyReachDeckGenerationFailure,
  isRetryableReachDeckGenerationFailure,
} from '../../lib/reach-deck/workspace-failure.js';

describe('Deck Chromium launch failures', () => {
  it('classifies every launch failure as an unavailable renderer and keeps the cause', async () => {
    const cause = new Error(
      "browserType.launch: Failed to launch chromium because executable doesn't exist at /usr/bin/chromium",
    );
    const error = await launchDeckChromium(() => Promise.reject(cause)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReachDeckRendererUnavailableError);
    expect(error).toMatchObject({ code: 'TEACHER_DECK_RENDERER_UNAVAILABLE', cause });
    expect((error as Error).message).toContain('/usr/bin/chromium');
  });

  it('returns the launched browser unchanged', async () => {
    const browser = { name: 'browser' };
    await expect(launchDeckChromium(async () => browser)).resolves.toBe(browser);
  });

  it('tells the teacher a single-pass slide failure is a dependency outage, not page content', () => {
    const terminal = new UnrecoverableError('Deck Chromium renderer is unavailable');
    Object.defineProperty(terminal, 'cause', {
      value: new ReachDeckRendererUnavailableError(new Error('Zygote process exited')),
    });

    expect(classifyReachDeckGenerationFailure(terminal)).toBe('dependency-unavailable');
    expect(isRetryableReachDeckGenerationFailure(terminal)).toBe(false);
  });
});
