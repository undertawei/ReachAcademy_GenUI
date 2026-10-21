import { describe, expect, it } from 'vitest';
import { withReferenceInteractivePrompt } from '../../lib/reach-deck/prompts/reference-interactive.js';
import { INTERACTIVE_PROMPT } from '../../lib/reach-deck/prompts/stages.js';
import { scientificInteractivePrompt } from '../../lib/reach-deck/prompts/scientific-generation.js';

describe('new-reference interactive responsive feedback constraints', () => {
  it.each([
    ['legacy science policy', INTERACTIVE_PROMPT],
    ['science enabled', scientificInteractivePrompt({ geometryEnabled: true })],
    ['geometry disabled', scientificInteractivePrompt({ geometryEnabled: false })],
  ])('versions only the reference adapter for %s', (_, basePrompt) => {
    const before = structuredClone(basePrompt);
    const adapted = withReferenceInteractivePrompt(basePrompt);
    expect(adapted.version).toBe(`${basePrompt.version}/reference-v4`);
    expect(adapted.text.startsWith(basePrompt.text + '\n\n')).toBe(true);
    expect(adapted.text).toContain('saved pagedOutline.designContext.resolvedColors');
    expect(adapted.text).toContain('Do not substitute a legacy theme.');
    expect(adapted.text).toContain('Static slide layout references do not constrain');
    expect(basePrompt).toEqual(before);
    expect(basePrompt.text).not.toContain('RESPONSIVE FEEDBACK STATES');
  });

  it('addresses dynamic feedback row overflow while preserving adaptive scrolling', () => {
    const { text } = withReferenceInteractivePrompt(INTERACTIVE_PROMPT);
    expect(text).toContain('372 by 591 CSS-pixel viewport');
    expect(text).toContain('initial, answered, all-feedback-visible, restored, and reset states');
    expect(text).toContain('auto/max-content grid rows or non-shrinking flex items');
    expect(text).toContain('not repeat(N,minmax(0,1fr)) equal-height rows');
    expect(text).toContain('preserve answers while navigating');
    expect(text).toContain('truncate or line-clamp feedback');
    expect(text).toContain('Choose local or whole-page scrolling');
    expect(text).toContain('There is no zero-scroll requirement.');
    expect(text).not.toContain('must still fit without vertical scrolling');
    expect(text).toContain('fixed heights and overflow must not trap feedback or controls');
  });

  it('fails closed if reference design instructions would be applied twice', () => {
    const adapted = withReferenceInteractivePrompt(INTERACTIVE_PROMPT);
    expect(() => withReferenceInteractivePrompt(adapted)).toThrow(
      'reference_interactive_prompt_baseline_drift',
    );
    expect(() =>
      withReferenceInteractivePrompt({
        version: INTERACTIVE_PROMPT.version,
        text: INTERACTIVE_PROMPT.text + '\nREFERENCE INTERACTIVE DESIGN',
      }),
    ).toThrow('reference_interactive_prompt_baseline_drift');
  });
});
