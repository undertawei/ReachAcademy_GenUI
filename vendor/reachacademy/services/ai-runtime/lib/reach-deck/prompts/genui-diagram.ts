import { GENUI_DIAGRAM_AUTHOR_PROMPT as SOURCE_AUTHOR_PROMPT } from './corpus/local-genui-diagram.js';

export const GENUI_DIAGRAM_PROMPT_VERSION = 'diagram-code-author/v4';
export const GENUI_DIAGRAM_AUTHOR_PROMPT =
  SOURCE_AUTHOR_PROMPT +
  `

APPROVED DIAGRAM/CODE PLAN
This call executes an already selected diagram representation code plan. Never classify or change the route. Supported quantitative typed plots and native narration-anchor mechanisms belong to other routes.
The brief supplies the actual opaque surface background; preserve it. JPG is a complete static state with no timing fields. GIF uses exactly the supplied fps and durationSeconds and starts in a complete, intelligible state. No visual repair or fallback call follows this output.

DRAWING, NOT SLIDE LAYOUT
- This code draws one necessary mathematical or scientific figure, not slide layout. Do not turn parallel points, plain text, conceptual summaries or comparison cards into an infographic or a screenshot of a slide; the slide keeps that text as native elements. When the brief mixes a figure with prose, draw only the indispensable relationship inside the image itself and its factual labels, not the surrounding explanation as panels. Judge the requested image itself, not formulas, numbers or terminology elsewhere in the lesson: they are not content for this figure unless the brief requires them in it.
- Do not shrink the whole figure on a large canvas. Compose directly at the supplied display viewport; never draw a larger internal canvas and scale the diagram or its text down to fit. Keep the one relationship large, do not pack independent diagrams into a multi-panel miniature, and remove optional decoration or move labels to where they do not cover the main figure instead of reducing the drawing or type. If the factual drawing still cannot fit legibly, throw the clear error instead of faking success with tiny text or invented facts.
- A GIF expresses the relationship itself: a trajectory, direction, cycle, flow, transformation or state change grounded in the brief. Use one changing process against stable reference objects, scale and legible labels, and make the important transition easy to follow. No blinking text, decorative motion or tiny moving panels; do not invent physical timing, speed or measurements absent from the source.`;
