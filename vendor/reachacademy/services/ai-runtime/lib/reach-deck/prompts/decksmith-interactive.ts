import {
  composeInteractivePromptSections,
  composeLegacyInteractivePromptSections,
  type ReachDeckStagePrompt,
} from './stages.js';
import {
  scientificInteractivePromptLegacy,
  scientificInteractiveContextContract,
  scientificInteractiveRuntimeRegistry,
} from './scientific-generation.js';
import { decksmithScientificCapabilityDetails } from '../decksmith/scientific-context.js';
import {
  REFERENCE_RESPONSIVE_FEEDBACK,
  referenceResponsiveFeedbackLegacy,
} from './reference-interactive.js';
import { interactiveRuntimeRegistryForEditing } from './interactive-runtime-contract.js';

/**
 * Decksmith's counterpart of REFERENCE INTERACTIVE DESIGN. Generation reads the saved design context
 * from the outline; Decksmith states the deck design derived from the slides in the user context.
 */
const DECKSMITH_INTERACTIVE_DECK_DESIGN = `DECK DESIGN
Use the deck design stated in the user context (theme colors and fonts, the text colors and sizes the slides actually use) for this interactive surface so it matches the rest of the deck. Static slide layouts do not constrain it. Do not substitute a legacy theme or an unrelated palette. When editing an existing page, keep its current palette unless the teacher asks to restyle it.`;

type DecksmithInteractivePromptOptions = {
  scientificContext: boolean;
  geometryEnabled: boolean;
  activeCapabilities?: readonly string[];
};

/** Original bytes for persisted Decksmith v1-v7 conversations. */
export function decksmithInteractivePromptLegacy(
  options: DecksmithInteractivePromptOptions,
): ReachDeckStagePrompt {
  const prompt = options.scientificContext
    ? scientificInteractivePromptLegacy(options.geometryEnabled)
    : { text: composeLegacyInteractivePromptSections() };
  return {
    version: 'decksmith-interactive/v5-deck-design',
    text: [
      prompt.text,
      DECKSMITH_INTERACTIVE_DECK_DESIGN + referenceResponsiveFeedbackLegacy(),
      ...(options.activeCapabilities ?? []).map(decksmithScientificCapabilityDetails),
      'EDITING TOOL OUTPUT ADAPTER\nThe creative, page-responsibility, security, runtime and source contracts above remain authoritative. For editing, use the Interactive working-file tools and finish with check_and_commit_interactive_page. The generation-only request to return one scene JSON is replaced by tool arguments matching the supplied tool schema. Preserve page identity and unrelated behavior. Call load_scientific_capability before using a catalog entry whose signature is load.',
    ].join('\n\n'),
  };
}

/** Creative teaching guidance plus the editing host's own output and repair boundary. */
export function decksmithInteractivePrompt(
  options: DecksmithInteractivePromptOptions,
): ReachDeckStagePrompt {
  const text = composeInteractivePromptSections(
    options.scientificContext
      ? {
          'OFFLINE RUNTIME REGISTRY': interactiveRuntimeRegistryForEditing(
            scientificInteractiveRuntimeRegistry(),
          ),
        }
      : {},
    { editing: true },
  );
  return {
    version: 'decksmith-interactive/v6-active-contracts',
    text: [
      text,
      ...(options.scientificContext ? [scientificInteractiveContextContract(true)] : []),
      DECKSMITH_INTERACTIVE_DECK_DESIGN + REFERENCE_RESPONSIVE_FEEDBACK,
      ...new Set((options.activeCapabilities ?? []).map(decksmithScientificCapabilityDetails)),
      'EDITING TOOL OUTPUT CONTRACT\nUse the Interactive working-file tools with arguments matching their supplied schemas and finish with check_and_commit_interactive_page. Preserve page identity and unrelated behavior. Call load_scientific_capability before using a catalog entry whose signature is load. An inactive capability remains available through that loader; do not guess its spec or event fields.',
    ].join('\n\n'),
  };
}
