import { describe, expect, it } from 'vitest';
import type { PagedDeckOutline } from '@reachany/reach-deck-dsl';

import {
  reachDeckDocumentContainsScientificVisual,
  reachDeckOutlineContainsScientificVisual,
} from '../../lib/reach-deck/scientific-visual-production.js';

describe('scientific visual detection', () => {
  it('detects planned and durable scientific content without changing reader parsing', () => {
    const outline: PagedDeckOutline = {
      id: 'outline',
      title: 'Physics',
      pages: [
        {
          id: 'page-1',
          order: 0,
          sceneType: 'slide',
          title: 'Trajectory',
          instructionalSpec: {
            learningObjective: 'Explain projectile motion',
            teachingMove: 'explain',
            keyPoints: ['Gravity changes vertical velocity.'],
            visualDirection: 'Show the trajectory.',
            density: 'low',
            visualAssets: [
              {
                kind: 'scientific-visual',
                purpose: 'Show the mechanism',
                prompt: 'Animate a projectile path.',
                alt: 'Projectile trajectory',
                aspectRatio: '16:9',
                placement: 'primary',
              },
            ],
          },
        },
      ],
    };
    expect(reachDeckOutlineContainsScientificVisual(outline)).toBe(true);

    const document = {
      nativeSlides: [{ slide: { elements: [{ type: 'scientificVisual' }] } }],
    } as Parameters<typeof reachDeckDocumentContainsScientificVisual>[0];
    expect(reachDeckDocumentContainsScientificVisual(document)).toBe(true);
  });
});
