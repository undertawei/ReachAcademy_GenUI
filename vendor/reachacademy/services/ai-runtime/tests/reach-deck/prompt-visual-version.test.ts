import { describe, expect, it } from 'vitest';
import { buildCodeMediaRenderIdentity } from '../../lib/reach-deck/code-media-policy.js';
import { PAGED_OUTLINE_PROMPT } from '../../lib/reach-deck/prompts/stages.js';
import { REFERENCE_OUTLINE_PROMPT } from '../../lib/reach-deck/prompts/reference-design.js';
describe('authoritative visual plan and code render identity', () => {
  it('separates authored source from each render configuration', () => {
    const input = {
      sourceDigest: 'a'.repeat(64),
      format: 'gif' as const,
      width: 640,
      height: 360,
      fps: 10,
      durationSeconds: 2,
      browserManifestDigest: 'browser',
      fontManifestDigest: 'fonts',
      ffmpegVersion: 'ffmpeg',
    };
    const key = buildCodeMediaRenderIdentity(input);
    for (const change of [
      { width: 800 },
      { fps: 12 },
      { durationSeconds: 3 },
      { browserManifestDigest: 'browser-new' },
      { fontManifestDigest: 'fonts-new' },
      { ffmpegVersion: 'new' },
    ]) {
      expect(buildCodeMediaRenderIdentity({ ...input, ...change })).not.toBe(key);
    }
  });
  it.each([
    ['paged', PAGED_OUTLINE_PROMPT.text],
    ['reference', REFERENCE_OUTLINE_PROMPT.text],
  ])('declares the four routes in the %s outline and forbids a second classifier', (_, text) => {
    for (const route of ['reference-image', 'diagram', 'scientific-visual', 'image'])
      expect(text).toContain(`- ${route}:`);
    expect(text).toContain('execution never reclassifies');
    expect(text).toContain('Plan one asset per visual');
    expect(text).toContain('Most slides need 0 or 1 asset');
    expect(text).toContain('never a visual asset');
    expect(text).toContain('svg/html only for non-metric schematic relations');
    expect(text).toContain('The geometry engine draws only flat 2D figures');
    expect(text).toContain('a solid or spatial figure is diagram svg, never geometry');
    expect(text).toContain('the right-angle vertex, side names and given values');
    expect(text).toContain('gif requires durationSeconds and fps');
    expect(text).toContain('materialReferenceOrdinal is the GLOBAL 1-based ordinal');
    expect(text).toContain('FUNCTION PLOT JSON CONTRACT');
    expect(text).not.toContain('visualIntents');
    expect(text).not.toContain('function-plot DSL');
    expect(text).not.toMatch(/never emit[^.]*visualAssets/);
  });
});
