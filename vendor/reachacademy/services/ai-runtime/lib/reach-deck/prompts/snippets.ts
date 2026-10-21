// Original local wording is immutable corpus; compose adaptations at the call boundary.
export * from './corpus/local-snippets.js';
import * as local from './corpus/local-snippets.js';

// Preserve the existing harness ids; corpus text stays immutable at its source.
export const REACH_DECK_PROMPT_SNIPPETS = {
  'json-output-rules': local.JSON_OUTPUT_RULES_SNIPPET,
  'source-and-language': local.SOURCE_AND_LANGUAGE_SNIPPET,
  'text-field-rules': local.TEXT_FIELD_RULES_SNIPPET,
  'single-session-continuity': local.SINGLE_SESSION_CONTINUITY_SNIPPET,
  'learning-interaction-integrity': local.LEARNING_INTERACTION_INTEGRITY_SNIPPET,
  'scientific-representation-integrity': local.SCIENTIFIC_REPRESENTATION_INTEGRITY_SNIPPET,
  'scientific-tool-selection': local.SCIENTIFIC_TOOL_SELECTION_SNIPPET,
  'previous-page-narration': local.PREVIOUS_PAGE_NARRATION_SNIPPET,
  'semantic-context': local.SEMANTIC_CONTEXT_SNIPPET,
  'media-intent-resolution': local.MEDIA_INTENT_RESOLUTION_SNIPPET,
  'slide-authoring-quality': local.SLIDE_AUTHORING_QUALITY_SNIPPET,
} as const;
export type ReachDeckPromptSnippetId = keyof typeof REACH_DECK_PROMPT_SNIPPETS;
export function isReachDeckPromptSnippetId(value: string): value is ReachDeckPromptSnippetId {
  return Object.hasOwn(REACH_DECK_PROMPT_SNIPPETS, value);
}
