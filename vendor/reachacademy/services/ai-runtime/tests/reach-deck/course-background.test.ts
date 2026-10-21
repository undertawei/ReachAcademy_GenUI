import { describe, expect, it } from 'vitest';
import type { PageGenerationRequest } from '@reachany/reach-deck-dsl';
import {
  composeCourseBackgroundImage,
  composeCourseBackgroundPrompt,
  courseBackgroundVeil,
} from '../../lib/reach-deck/course-background.js';

const request = {
  pagedOutline: { title: 'Linear functions', pages: [] },
  lessonPlan: { title: 'Linear functions' },
  page: { title: 'Welcome', instructionalSpec: { keyPoints: ['Slope as change'] } },
} as unknown as PageGenerationRequest;

describe('course background composition', () => {
  it('reserves the cover text regions and never asks for text in the artwork', () => {
    const cover = composeCourseBackgroundPrompt(request, 'cover', [
      { role: 'title', frame: { x: 0.08, y: 0.2, width: 0.4, height: 0.2 } },
    ]);
    expect(cover).toContain('Quiet text regions');
    expect(cover).toContain('Slope as change');
    expect(cover).toContain('Do not render any words');
    const body = composeCourseBackgroundPrompt(request, 'body');
    expect(body).not.toContain('Quiet text regions');
    // Shared body art must not depict one page's teaching fact.
    expect(body).not.toContain('Slope as change');
  });

  it('falls back to a white veil and rejects malformed veils', async () => {
    expect(courseBackgroundVeil(request, 'agenda')).toEqual({ color: '#FFFFFF', opacity: 0.78 });
    await expect(
      composeCourseBackgroundImage(new Uint8Array([1]), { color: 'red', opacity: 0.5 }),
    ).rejects.toThrow('veil');
  });
});
