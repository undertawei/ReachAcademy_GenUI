import * as local from './corpus/local-stages.js';
import { deckThemeCatalogSnippet } from '@reachany/reach-deck-dsl';
import { composeCompactOutlinePrompt } from './compact-outline.js';
import {
  JSON_OUTPUT_RULES_SNIPPET,
  LEARNING_INTERACTION_INTEGRITY_SNIPPET,
  SCIENTIFIC_REPRESENTATION_INTEGRITY_SNIPPET,
  SINGLE_SESSION_CONTINUITY_SNIPPET,
  SOURCE_AND_LANGUAGE_SNIPPET,
} from './corpus/local-snippets.js';
import { PAGE_RESPONSIBILITY_PRIORITY } from './corpus/page-responsibility.js';
import {
  OFFLINE_RUNTIME_REGISTRY,
  BUILT_IN_TAILWIND_AUTHORING,
  BUILT_IN_SCIENCE_KITS,
  JAVASCRIPT_CORRECTNESS,
  HOST_FUNCTION_PLOT_CAPABILITY,
  REACHINTERACTIVE_BRIDGE_CONTRACT,
  interactiveJavaScriptCorrectness,
  interactiveScienceKitCommon,
  interactiveRuntimeRegistryForEditing,
} from './interactive-runtime-contract.js';
export {
  INTERACTIVE_SCIENCE_KIT_DETAILS,
  INTERACTIVE_SCIENCE_KIT_EVENTS,
} from './interactive-runtime-contract.js';
export {
  CUSTOM_PROMPT_VERSION_SUFFIX,
  resolvePromptVersion,
  LEGACY_NARRATION_PROMPT,
  SCIENTIFIC_VISUAL_PROMPT,
  SCIENTIFIC_SLIDE_BINDING_PROMPT,
  SCIENTIFIC_VISUAL_OUTLINE_PROMPT,
  REACH_FUNCTION_PLOT_PROMPT_CONTRACT,
  type ReachDeckStagePrompt,
} from './corpus/local-stages.js';

const withResponsibility = (
  prompt: local.ReachDeckStagePrompt,
  version: string,
  appendix = '',
): local.ReachDeckStagePrompt => ({
  version,
  text: [prompt.text, appendix, PAGE_RESPONSIBILITY_PRIORITY].filter(Boolean).join('\n\n'),
});

// Retain scientific accuracy without restoring the retired engine-selection policy.
// The complete historical wording remains in the immutable source corpus.
const creativeScientificAccuracy = SCIENTIFIC_REPRESENTATION_INTEGRITY_SNIPPET.replace(
  '- Prefer a registered typed scientific capability when it faithfully expresses the core teaching action. Use a registered custom document capability only when the listed engines do not support a required semantic operation; custom output remains subject to its declared runtime and security limits.\n',
  '',
).replace(
  'Quantitative evidence uses an appropriate installed engine',
  'Quantitative evidence uses a faithful implementation',
);
export const LESSON_PLAN_PROMPT = withResponsibility(
  local.LESSON_PLAN_PROMPT,
  'lesson-plan/v22-capabilities',
);
export const PAGED_OUTLINE_PROMPT = {
  version: 'paged-outline/v68-solid-diagram-svg',
  text: composeCompactOutlinePrompt({
    rootFields: 'title, themeName and pages',
    designInstructions: deckThemeCatalogSnippet(),
  }),
};
export const SLIDE_PROMPT = withResponsibility(local.SLIDE_PROMPT, 'slide/v31-capabilities');
// The archived quiz corpus predates the v3 page specification; map its field names here.
const QUIZ_V3_PAGE_FIELDS = `V3 PAGE FIELDS
When page.instructionalSpec.schemaVersion is reach-deck-instructional-spec/v3, read the confirmed quiz design from these fields instead of the historical names above: pageJob states what is assessed and the learner task (the role of assessmentIntent); assessmentEvidence names the observable answer or artifact to collect; keyPoints carry the facts, conditions, examples and reasoning the questions may rely on (the role of supportingDetails); knowledgePointIds identify the assessed lesson-plan knowledge points; pageRole is the page responsibility. Expand question-local assessment targets from pageJob, assessmentEvidence, learningObjective and keyPoints. v3 pages carry no interactionAssessmentPlan, assessmentIntent, focusStatement or supportingDetails; their absence is not missing design. The assessment pedagogy above is unchanged.`;
export const QUIZ_PROMPT = withResponsibility(
  local.QUIZ_PROMPT,
  'quiz/v19-scene-spec-v3',
  QUIZ_V3_PAGE_FIELDS,
);
// The archived narration corpus names runtime fields the host never produced; map them here.
const NARRATION_RUNTIME_FIELDS = `NARRATION RUNTIME FIELDS
The runtime context described above arrives as narrationContext. narrationContext.coursePageMap is the course page map: every page in delivery order with its title, sceneType and, when planned, pageRole and a shortened pageJob; the entry with current: true is this page. Use it silently to see where this page sits in the whole lesson, what earlier pages already owned and what later pages will own, so this page keeps its own duty and connects naturally. Never read the map aloud, list upcoming pages, reveal what a later page owns, or re-teach an earlier page because it appears in the map. currentPage.pageRole, currentPage.pageJob and currentPage.instructionalSpec.keyPoints carry the page duty that the text above calls primaryDeliveryFunction, deliveryFunctions and deliveryBrief. Fields named above but absent from narrationContext are not supplied; do not infer or invent them.`;
// 正文里直接写的符号式拿不到公式读法：TTS 会把 f(−x) 念成「f括号负x括回」，字幕对齐也对不上。
const NARRATION_MATH_NOTATION = `NARRATION MATH NOTATION
新写讲稿时，凡是要读出来的数学式都必须放进行内公式 \\( \\) 或展示公式 \\[ \\]，由服务端生成课堂读法：包括函数记号 f(x)、f(−x)，等式与不等式（=、<、>、≤、≥、≠），集合与区间（∈、∉、⊆、[a,b]），坐标 (h,k)，比与比例，角、三角形、向量、根号、分数、指数，上下标与希腊字母（α、β、π），以及 ±、×、÷ 等运算符。不要把 Unicode 数学符号、上标数字（² ³）或下标数字（₁ ₂）直接写在正文里，也不要用汉字逐个念符号（如「f括号x」）。只用汉字叙述的关系（如「x 大于零」「两角互补」）和单独提到的字母变量可以保持普通文字。一个完整的式子放进同一对定界符，不要拆成几段。定界符本身不会显示，式子自己的括号要写在定界符里面：坐标写成 \\((h,k)\\)，函数写成 \\(f(-x)=f(x)\\)。已有的 \`$...$\` 与 payload 里教师提供的 narrationMarkdown 仍逐字保留。`;
export const NARRATION_PROMPT = withResponsibility(
  local.NARRATION_PROMPT,
  'narration/v30-math-notation',
  [NARRATION_RUNTIME_FIELDS, NARRATION_MATH_NOTATION].join('\n\n'),
);

// Technical sections remain addressable for the existing geometry/editing integration.
// All design prose and examples live in the complete immutable local corpus.
const legacyInteractivePromptSections = {
  PREAMBLE: local.INTERACTIVE_PROMPT.text,
  'OFFLINE RUNTIME REGISTRY': OFFLINE_RUNTIME_REGISTRY,
  'BUILT-IN TAILWIND AUTHORING': BUILT_IN_TAILWIND_AUTHORING,
  'BUILT-IN SCIENCE KITS': BUILT_IN_SCIENCE_KITS,
  'JAVASCRIPT CORRECTNESS': JAVASCRIPT_CORRECTNESS,
  'REACHINTERACTIVE BRIDGE CONTRACT': REACHINTERACTIVE_BRIDGE_CONTRACT,
  'HOST FUNCTION PLOT CAPABILITY': HOST_FUNCTION_PLOT_CAPABILITY,
  'JSON OUTPUT CONTRACT': JSON_OUTPUT_RULES_SNIPPET,
  'SOURCE AND LANGUAGE': SOURCE_AND_LANGUAGE_SNIPPET,
  'SINGLE-SESSION CONTINUITY': SINGLE_SESSION_CONTINUITY_SNIPPET,
  'LEARNING INTERACTION INTEGRITY': LEARNING_INTERACTION_INTEGRITY_SNIPPET,
  'SCIENTIFIC REPRESENTATION INTEGRITY': SCIENTIFIC_REPRESENTATION_INTEGRITY_SNIPPET,
  'PAGE RESPONSIBILITY': PAGE_RESPONSIBILITY_PRIORITY,
} as const;

function interactivePreamble(editing: boolean): string {
  let text = local.INTERACTIVE_PROMPT.text;
  const bridgeStart = text.indexOf('REACHINTERACTIVE BRIDGE CONTRACT\n');
  const markersStart = text.indexOf('AUTHORING COMPONENT MARKERS\n');
  const plotStart = text.indexOf('OPTIONAL FUNCTION PLOT\n');
  const narrationStart = text.indexOf('NARRATION\n', plotStart);
  if (
    bridgeStart < 0 ||
    markersStart <= bridgeStart ||
    plotStart <= markersStart ||
    narrationStart <= plotStart
  )
    throw new Error('interactive_prompt_baseline_drift');
  // The source corpus is immutable. Retire its superseded technical blocks at composition time.
  text =
    text.slice(0, bridgeStart) + text.slice(markersStart, plotStart) + text.slice(narrationStart);
  for (const snippet of [JSON_OUTPUT_RULES_SNIPPET, SOURCE_AND_LANGUAGE_SNIPPET]) {
    if (text.split(snippet).length !== 2) throw new Error('interactive_prompt_baseline_drift');
    text = text.replace(snippet, '');
  }
  text = text.replace(
    ' A structural/script correction returns the complete scene, preserving teaching content and unaffected behavior.',
    '',
  );
  if (editing) {
    text = text
      .replace(
        'Return runtimeDependencies as an array of only the exact declared pins actually used, or [].',
        'The host infers pinned runtime dependencies from the working HTML; do not pass runtimeDependencies to an editing tool.',
      )
      .replace(
        'Set runtimePolicy.allowReset to true and maximumDurationSeconds to null.',
        'The host fixes runtimePolicy.allowReset to true and maximumDurationSeconds to null; choose completionMode through check_and_commit_interactive_page when needed.',
      )
      .replace(
        "Return eventManifest as {schemaVersion:'reach-interactive-event-manifest/v1', events:[...]}",
        "When changing declared events, pass eventManifestJson to check_and_commit_interactive_page as a JSON encoding of {schemaVersion:'reach-interactive-event-manifest/v1', events:[...]}",
      );
    text = text.replace(
      text.slice(0, text.indexOf('\n\n')),
      'Create or edit the requested Interactive page with the supplied working-file tools. Design the interaction yourself from the teaching purpose and source material. Preserve page identity and unrelated behavior.',
    );
    const narration = text.indexOf('NARRATION\n');
    text =
      text.slice(0, narration) +
      `NARRATION\nKeep the existing narration faithful to the interaction. When the edit changes its meaning, supply narrationText with write_interactive_html; keep its concise orientation within the 600 Unicode-character transport limit. Do not disclose answers or read all controls. The server produces audio.`;
  }
  return text.trim();
}

export const INTERACTIVE_PROMPT_SECTIONS = {
  ...legacyInteractivePromptSections,
  PREAMBLE: interactivePreamble(false),
  'HOST FUNCTION PLOT CAPABILITY':
    HOST_FUNCTION_PLOT_CAPABILITY + '\n' + local.REACH_FUNCTION_PLOT_PROMPT_CONTRACT,
  'SCIENTIFIC REPRESENTATION INTEGRITY': creativeScientificAccuracy,
};
export type InteractivePromptSection = keyof typeof INTERACTIVE_PROMPT_SECTIONS;
export const INTERACTIVE_SCIENCE_KIT_COMMON = BUILT_IN_SCIENCE_KITS;
/** Frozen v1-v7 Decksmith sessions must retain their original prompt bytes. */
export function composeLegacyInteractivePromptSections(
  overrides: Partial<Record<InteractivePromptSection, string>> = {},
): string {
  return Object.entries(legacyInteractivePromptSections)
    .map(([key, value]) => overrides[key as InteractivePromptSection] ?? value)
    .join('\n\n');
}

export function composeInteractivePromptSections(
  overrides: Partial<Record<InteractivePromptSection, string>> = {},
  options: { editing?: boolean } = {},
): string {
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in INTERACTIVE_PROMPT_SECTIONS))
      throw new Error('interactive_prompt_section_unknown');
    if (!value?.trim()) throw new Error('interactive_prompt_section_empty');
  }
  const sections = options.editing
    ? {
        ...INTERACTIVE_PROMPT_SECTIONS,
        PREAMBLE: interactivePreamble(true),
        'BUILT-IN SCIENCE KITS': interactiveScienceKitCommon(),
        'JAVASCRIPT CORRECTNESS': interactiveJavaScriptCorrectness(true),
        'HOST FUNCTION PLOT CAPABILITY': '',
        'JSON OUTPUT CONTRACT': '',
        'OFFLINE RUNTIME REGISTRY': interactiveRuntimeRegistryForEditing(
          INTERACTIVE_PROMPT_SECTIONS['OFFLINE RUNTIME REGISTRY'],
        ),
      }
    : INTERACTIVE_PROMPT_SECTIONS;
  return Object.entries(sections)
    .map(([key, value]) => overrides[key as InteractivePromptSection] ?? value)
    .filter(Boolean)
    .join('\n\n');
}
export const INTERACTIVE_PROMPT: local.ReachDeckStagePrompt = {
  version: 'interactive/v39-flat-event-fields',
  text: composeInteractivePromptSections(),
};
