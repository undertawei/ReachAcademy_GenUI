import { parseReachDeckNarrationMarkdown } from '@reachany/reach-deck-dsl';

import { ReachDeckRichText } from './ReachDeckRichText.js';
import { useNarrationOverflow } from './useNarrationOverflow.js';

/**
 * Render an internal narration cue. New authoritative narration uses the constrained Markdown
 * contract, while legacy segment strings remain literal text and can never acquire Markdown
 * semantics merely by being played by a newer client.
 */
export function NarrationCaption({
  authoritative,
  text,
  scrollable = false,
  ariaLabel,
}: {
  authoritative: boolean;
  text: string;
  scrollable?: boolean;
  ariaLabel?: string;
}) {
  const { ref, overflowing } = useNarrationOverflow(scrollable, text);
  const scrollProps = overflowing ? { tabIndex: 0, role: 'region', 'aria-label': ariaLabel } : {};
  if (!authoritative)
    return (
      <span ref={ref} {...scrollProps}>
        {text}
      </span>
    );

  try {
    return (
      <div
        ref={ref}
        {...scrollProps}
        className="voice-caption-strip__markdown"
        data-narration-caption="markdown"
      >
        <ReachDeckRichText document={parseReachDeckNarrationMarkdown(text)} />
      </div>
    );
  } catch {
    // Derived cues are validated before persistence. Keep playback resilient to historical or
    // partially repaired documents without interpreting unsupported markup as HTML.
    return (
      <span ref={ref} {...scrollProps}>
        {text}
      </span>
    );
  }
}
