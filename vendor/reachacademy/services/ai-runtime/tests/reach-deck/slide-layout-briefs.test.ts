import { describe, expect, it } from 'vitest';

import { SLIDE_LAYOUT_EVALUATION_BRIEFS } from './fixtures/slide-layout-briefs.js';

describe('slide layout evaluation briefs', () => {
  it('covers every primary type in both supported languages', () => {
    expect(SLIDE_LAYOUT_EVALUATION_BRIEFS).toHaveLength(24);
    const byType = new Map<string, (typeof SLIDE_LAYOUT_EVALUATION_BRIEFS)[number][]>();
    for (const brief of SLIDE_LAYOUT_EVALUATION_BRIEFS) {
      const type = brief.classification.primaryType;
      byType.set(type, [...(byType.get(type) ?? []), brief]);
    }
    expect([...byType.keys()].sort()).toEqual(
      [
        'single_focus',
        'parallel_items',
        'comparison',
        'sequence',
        'cause_effect',
        'hierarchy',
        'network',
        'data_evidence',
        'worked_steps',
        'media_annotation',
        'question_reveal',
        'summary_map',
      ].sort(),
    );
    for (const briefs of byType.values()) {
      expect(briefs.map((brief) => brief.locale).sort()).toEqual(['en-US', 'zh-CN']);
    }
  });

  it('includes non-media and all supported image counts without asking for decorative media', () => {
    expect(
      new Set(SLIDE_LAYOUT_EVALUATION_BRIEFS.map((brief) => brief.expected.imageCount)),
    ).toEqual(new Set([0, 1, 2, 3]));
    for (const brief of SLIDE_LAYOUT_EVALUATION_BRIEFS) {
      expect(brief.instructionalSpec.keyPoints.length).toBeGreaterThanOrEqual(3);
      expect(brief.instructionalSpec.keyPoints.length).toBeLessThanOrEqual(5);
      if (brief.expected.imageCount === 0) {
        expect(brief.classification.mediaType).not.toBe('image');
      } else {
        expect(brief.classification.mediaType).toBe('image');
      }
    }
  });
});
