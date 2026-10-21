export const REFERENCE_INTERACTIVE_DESIGN = `REFERENCE INTERACTIVE DESIGN
Use the saved pagedOutline.designContext.resolvedColors and visualIntent, the course subject, and instructionalSpec.visualDirection. Static slide layout references do not constrain this interactive surface. Do not substitute a legacy theme.`;

const legacyReferenceResponsiveFeedback = `

RESPONSIVE FEEDBACK STATES
- Check the actual iframe, including a narrow 372 by 591 CSS-pixel viewport, in the initial, answered, all-feedback-visible, restored, and reset states. Longer wrapped feedback must remain readable without covering the next item or required controls.
- Text-bearing question and feedback cards need intrinsic block sizes and normal document flow: use auto/max-content grid rows or non-shrinking flex items, not repeat(N,minmax(0,1fr)) equal-height rows for variable text. Reserve fluid zero-minimum tracks for the primary visual surface, not for growing answer explanations. Never absolutely position feedback over another card.
- Keep the ordinary viewport contract: reduce gaps and secondary prose, reflow controls, or show one active item with compact item navigation instead of stacking more cards than fit. Keep every item and its feedback reachable, preserve answers while navigating, and keep reset available. Do not remove required evidence, shrink legible text/touch targets, truncate or line-clamp feedback, or hide essential content with overflow:hidden/clip to make a layout appear to fit.
- Preserve html as the sole vertical-scroll fallback for unusually small viewports, browser zoom, or accessibility text expansion. In that fallback allow the root to grow with its content so a fixed 100dvh root with hidden overflow cannot trap feedback or controls; do not introduce body or nested scrollers. Ordinary target viewports must still fit without vertical scrolling.
- Recheck the same layout after restoring answers or revealing the longest feedback, not only before interaction. Reset must remove obsolete feedback without leaving overlapping or inaccessible controls.`;

export function referenceResponsiveFeedbackLegacy(): string {
  return legacyReferenceResponsiveFeedback;
}

export const REFERENCE_RESPONSIVE_FEEDBACK = legacyReferenceResponsiveFeedback
  .replace(
    'Keep the ordinary viewport contract: reduce gaps and secondary prose, reflow controls, or show one active item with compact item navigation instead of stacking more cards than fit.',
    'Reduce unnecessary gaps and secondary prose, reflow controls, or show one active item with compact item navigation when that supports the teaching purpose.',
  )
  .replace(
    '- Preserve html as the sole vertical-scroll fallback for unusually small viewports, browser zoom, or accessibility text expansion. In that fallback allow the root to grow with its content so a fixed 100dvh root with hidden overflow cannot trap feedback or controls; do not introduce body or nested scrollers. Ordinary target viewports must still fit without vertical scrolling.',
    '- Choose local or whole-page scrolling, reflow, folding, scaling or panning according to the content and actual container. Allow growing feedback to expand its container or remain reachable through a clear scroll region; fixed heights and overflow must not trap feedback or controls. Coordinate touch gestures with scrolling and preserve learner state. There is no zero-scroll requirement.',
  );

/** Applied only to new reference-design requests; saved documents and legacy prompts stay intact. */
export function withReferenceInteractivePrompt(basePrompt: { version: string; text: string }) {
  if (basePrompt.text.includes('REFERENCE INTERACTIVE DESIGN')) {
    throw new Error('reference_interactive_prompt_baseline_drift');
  }
  return {
    version: `${basePrompt.version}/reference-v4`,
    text: basePrompt.text + '\n\n' + REFERENCE_INTERACTIVE_DESIGN + REFERENCE_RESPONSIVE_FEEDBACK,
  };
}
