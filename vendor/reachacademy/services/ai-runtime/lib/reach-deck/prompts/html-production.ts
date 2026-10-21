import type { ReachDeckDesignContext } from '@reachany/reach-deck-dsl';
import { DEFAULT_SYSTEM_PROMPT } from '../../../scripts/reach-deck/html-layout/prompts.js';
import { HTML_REFERENCE_LAYOUT_PROMPT } from '../html-layout/reference-tables.js';
import {
  buildReferenceAssetInstructions,
  REFERENCE_HTML_INSTRUCTIONS,
} from './reference-design.js';
import { PAGE_RESPONSIBILITY_PRIORITY } from './corpus/page-responsibility.js';

export const HTML_PRODUCTION_PROMPT_VERSION =
  'html-native-v2/capabilities-reference-v10-table-budget';
export const HTML_PAGE_RESPONSIBILITY = `LEARNER-VISIBLE PAGE RESPONSIBILITY
The supplied pageRole, pageFunctions, pageJob, continuity and instructionalSpec are authoritative teaching decisions. References advise visual composition only. Do not rewrite the lesson to fit a reference.
pageTitle is navigation metadata. visibleTitleMode=none forbids a visible title, heading, eyebrow or decorative substitute; use the space for this page's actual teaching job. course_title uses the course title as the dedicated opening focus. Other modes use a natural heading of that form without mechanically copying the focus statement.
Preserve supplied facts, equations, asset identities and invariants. Never split or merge pages, introduce new learner-response duties on a Slide, or draw over a supplied scientific mechanism.
Never write a page number, page count or progress fraction such as "09 / 20": this page does not know its position in the deck and the player shows navigation. A progress component shows the section or reading path instead.`;

/** Optional entrance grouping; the host derives card groups itself, so ordinary pages need no marker. */
export const HTML_REVEAL_GROUP_INSTRUCTIONS = `ENTRANCE GROUPING (OPTIONAL)
Narration may reveal page parts as the teacher speaks. The host already reveals a card together with everything drawn inside it, reveals every other element on its own, and keeps lines, empty shapes and full-page backgrounds visible, so most pages need no marker. Add data-reach-reveal-group="item-id" only where one item is made of separate siblings that must appear together but share no card behind them, such as a step's number node, title and body; or where several items inside one large card should appear one at a time. Give every part of one item the same short id and never mark anything else.`;

export function composeHtmlProductionPrompt(
  colors?: ReachDeckDesignContext['resolvedColors'],
): string {
  return [
    DEFAULT_SYSTEM_PROMPT,
    buildReferenceAssetInstructions(colors),
    HTML_REFERENCE_LAYOUT_PROMPT,
    REFERENCE_HTML_INSTRUCTIONS,
    PAGE_RESPONSIBILITY_PRIORITY,
    HTML_PAGE_RESPONSIBILITY,
    HTML_REVEAL_GROUP_INSTRUCTIONS,
  ].join('\n\n');
}

/** The per-request asset color examples are also recorded in the actual model input digest. */
export const HTML_PRODUCTION_PROMPT = {
  version: HTML_PRODUCTION_PROMPT_VERSION,
  text: composeHtmlProductionPrompt(),
};
