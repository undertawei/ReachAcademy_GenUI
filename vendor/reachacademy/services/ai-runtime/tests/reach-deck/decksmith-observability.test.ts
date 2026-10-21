import { describe, expect, it, vi } from 'vitest';

import {
  decksmithEventLagMs,
  observeDecksmith,
} from '../../lib/reach-deck/decksmith/observability.js';

describe('Decksmith observability', () => {
  it('emits only the allowlisted operational metadata', () => {
    const logger = vi.fn();

    observeDecksmith(
      {
        event: 'terminal',
        jobId: 'decksmith-v1-safe',
        attempt: 2,
        terminalState: 'succeeded',
      },
      logger,
    );

    expect(logger).toHaveBeenCalledWith({
      component: 'reach-deck.decksmith',
      event: 'terminal',
      jobId: 'decksmith-v1-safe',
      attempt: 2,
      terminalState: 'succeeded',
    });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/prompt|document|token|jwt|secret/i);
  });

  it('derives nonnegative event lag from the Redis Stream id', () => {
    expect(decksmithEventLagMs('1000-7', () => 1250)).toBe(250);
    expect(decksmithEventLagMs('2000-0', () => 1250)).toBe(0);
    expect(() => decksmithEventLagMs('invalid')).toThrow('timestamp is invalid');
  });
});
