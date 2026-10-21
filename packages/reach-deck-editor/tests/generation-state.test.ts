import { createGenerationWorkspace } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  canStartReachDeckPage,
  getReachDeckGenerationFrontierPageId,
} from '../src/generation-state.js';

const now = '2026-07-18T03:00:00.000Z';

describe('Reach Deck generation scheduling', () => {
  it('keeps page generation on the first unfinished target', () => {
    const workspace = createGenerationWorkspace({
      runId: 'run-1',
      documentId: 'deck-1',
      source: 'Teach concurrency',
      createdAt: now,
      lessonPlan: {
        id: 'plan-1',
        title: 'Concurrency',
        audience: 'Developers',
        durationMinutes: 20,
        learningObjectives: ['Explain CAS'],
        teachingStrategy: 'Worked examples',
        keyTerms: ['CAS'],
        narrative: 'Start from a lost update.',
      },
      pagedOutline: {
        id: 'outline-1',
        title: 'Concurrency',
        pages: [
          {
            id: 'page-1',
            order: 1,
            sceneType: 'slide',
            title: 'The race',
          },
          {
            id: 'page-2',
            order: 2,
            sceneType: 'quiz',
            title: 'Check',
          },
        ],
      },
    });

    expect(getReachDeckGenerationFrontierPageId(workspace)).toBe('page-1');
    expect(canStartReachDeckPage(workspace, 'page-1')).toBe(true);
    expect(canStartReachDeckPage(workspace, 'page-2')).toBe(false);
  });
});
