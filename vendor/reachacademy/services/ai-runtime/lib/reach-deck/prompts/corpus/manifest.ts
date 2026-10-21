import { createHash } from 'node:crypto';
import * as stages from '../stages.js';
import { HTML_PRODUCTION_PROMPT } from '../html-production.js';
import { REFERENCE_OUTLINE_PROMPT } from '../reference-design.js';
import { GENUI_DIAGRAM_AUTHOR_PROMPT, GENUI_DIAGRAM_PROMPT_VERSION } from '../genui-diagram.js';
import * as localStages from './local-stages.js';
import * as snippets from './local-snippets.js';
import * as genui from './local-genui-diagram.js';
import * as runtimeContract from '../interactive-runtime-contract.js';
import {
  PAGE_RESPONSIBILITY_PRIORITY,
  PAGE_RESPONSIBILITY_PRIORITY_VERSION,
} from './page-responsibility.js';
import { NARRATION_CORPUS } from '../../narration-corpus.js';
import {
  NARRATION_SPEECH_READINGS_PROMPT,
  NARRATION_SPEECH_READINGS_PROMPT_VERSION,
} from '../narration-speech-readings.js';

export const PROMPT_CORPUS_VERSION = 'reach-deck-capability-html-corpus/2026-10-20-v9';
export const promptContentHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export interface PromptCorpusFragment {
  readonly id: string;
  readonly text: string;
  readonly stage: string;
  readonly call: string;
  readonly purpose: string;
  readonly sourceFile: string;
  readonly sourceVersion: string;
  readonly corpusVersion: string;
  readonly sha256: string;
}

function fragment(
  id: string,
  text: string,
  stage: string,
  purpose: string,
  sourceFile: string,
  sourceVersion: string,
): PromptCorpusFragment {
  return Object.freeze({
    id,
    text,
    stage,
    call: stage,
    purpose,
    sourceFile,
    sourceVersion,
    corpusVersion: PROMPT_CORPUS_VERSION,
    sha256: promptContentHash(text),
  });
}

// Never summarize or deduplicate these entries. Repetition belongs to the authored product.
export const PROMPT_CORPUS: readonly PromptCorpusFragment[] = Object.freeze([
  fragment(
    'REFERENCE_OUTLINE_PROMPT',
    REFERENCE_OUTLINE_PROMPT.text,
    'paged-outline',
    'Effective reference compact outline; explicit root and design contract with complete shared teaching body',
    'services/ai-runtime/lib/reach-deck/prompts/reference-design.ts',
    REFERENCE_OUTLINE_PROMPT.version,
  ),
  fragment(
    'CODE_DIAGRAM_AUTHOR_PROMPT',
    GENUI_DIAGRAM_AUTHOR_PROMPT,
    'diagram-code',
    'Effective code authoring for an explicit diagram/code plan; no routing or repair',
    'services/ai-runtime/lib/reach-deck/prompts/genui-diagram.ts',
    GENUI_DIAGRAM_PROMPT_VERSION,
  ),
  fragment(
    'HTML_PRODUCTION_PROMPT',
    HTML_PRODUCTION_PROMPT.text,
    'html-slide',
    'Effective HTML Native V2 prompt; per-request colors are included in model input identity',
    'services/ai-runtime/lib/reach-deck/prompts/html-production.ts',
    HTML_PRODUCTION_PROMPT.version,
  ),
  fragment(
    'NARRATION_SPEECH_READINGS_PROMPT',
    NARRATION_SPEECH_READINGS_PROMPT,
    'narration',
    'Effective pre-TTS formula reading prompt; readings are synthesis-only and never persisted',
    'services/ai-runtime/lib/reach-deck/prompts/narration-speech-readings.ts',
    NARRATION_SPEECH_READINGS_PROMPT_VERSION,
  ),
  ...Object.entries(stages)
    .filter(
      (entry): entry is [string, stages.ReachDeckStagePrompt] =>
        typeof entry[1] === 'object' &&
        entry[1] !== null &&
        'text' in entry[1] &&
        'version' in entry[1],
    )
    .map(([id, prompt]) =>
      fragment(
        id,
        prompt.text,
        prompt.version.split('/')[0],
        id === 'SLIDE_PROMPT'
          ? 'Archived V1 slide prompt; production static pages use HTML_PRODUCTION_PROMPT'
          : 'Complete effective model prompt, composed from the verbatim source corpus and payload adapters',
        'services/ai-runtime/lib/reach-deck/prompts/stages.ts',
        prompt.version,
      ),
    ),
  ...Object.entries(localStages)
    .filter(
      (entry): entry is [string, stages.ReachDeckStagePrompt] =>
        typeof entry[1] === 'object' &&
        entry[1] !== null &&
        'text' in entry[1] &&
        'version' in entry[1],
    )
    .map(([id, prompt]) =>
      fragment(
        `SOURCE_${id}`,
        prompt.text,
        prompt.version.split('/')[0],
        'Verbatim local source before composition; archived in prompts/corpus/local-stages.ts',
        'services/ai-runtime/lib/reach-deck/prompts/stages.ts',
        prompt.version,
      ),
    ),
  ...(
    [
      'REACH_FUNCTION_PLOT_PROMPT_CONTRACT',
      'SCIENTIFIC_SLIDE_BINDING_PROMPT',
      'SCIENTIFIC_VISUAL_OUTLINE_PROMPT',
    ] as const
  ).map((id) =>
    fragment(
      id,
      localStages[id],
      'slide,interactive',
      'Verbatim local scientific prompt fragment; archived in prompts/corpus/local-stages.ts',
      'services/ai-runtime/lib/reach-deck/prompts/stages.ts',
      'local-source/2026-09-23',
    ),
  ),
  ...Object.entries(snippets as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !entry[0].endsWith('_VERSION'),
    )
    .map(([id, text]) =>
      fragment(
        id,
        text,
        /NARRATION|SPEECH/.test(id) ? 'narration' : 'shared',
        'Complete local authored guidance; retained without rewriting',
        'services/ai-runtime/lib/reach-deck/prompts/snippets.ts',
        id === 'PREPARATION_DESIGN_GUIDE'
          ? snippets.PREPARATION_DESIGN_GUIDE_VERSION
          : id === 'OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET'
            ? snippets.OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET_VERSION
            : 'local-source/2026-09-23',
      ),
    ),
  ...Object.entries(genui as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !entry[0].endsWith('_VERSION'),
    )
    .map(([id, text]) =>
      fragment(
        id,
        text,
        'genui',
        'Archived scientific GenUI source; routing and runtime-repair are not production calls',
        'services/ai-runtime/lib/reach-deck/prompts/genui-diagram.ts',
        id.includes('RUNTIME_REPAIR')
          ? genui.GENUI_DIAGRAM_RUNTIME_REPAIR_PROMPT_VERSION
          : genui.GENUI_DIAGRAM_PROMPT_VERSION,
      ),
    ),
  ...Object.entries(runtimeContract as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !entry[0].endsWith('_VERSION'),
    )
    .map(([id, text]) =>
      fragment(
        id,
        text,
        'interactive',
        'Complete host runtime and scientific capability boundary; retained without rewriting',
        'services/ai-runtime/lib/reach-deck/prompts/interactive-runtime-contract.ts',
        id === 'REACHINTERACTIVE_BRIDGE_CONTRACT'
          ? runtimeContract.REACHINTERACTIVE_BRIDGE_CONTRACT_VERSION
          : 'reach-interactive-runtime-contract/v1',
      ),
    ),
  ...NARRATION_CORPUS.map((entry) =>
    fragment(
      entry.id,
      entry.text,
      entry.stage,
      entry.purpose,
      entry.sourceFile,
      entry.sourceVersion,
    ),
  ),
  fragment(
    'PAGE_RESPONSIBILITY_PRIORITY',
    PAGE_RESPONSIBILITY_PRIORITY,
    'paged-outline,slide,quiz,interactive,narration',
    'Approved conflict priority and six conflict examples',
    'approved-capability-integration-plan/section-2',
    PAGE_RESPONSIBILITY_PRIORITY_VERSION,
  ),
]);
export const PROMPT_CORPUS_DIGEST = promptContentHash(
  JSON.stringify(
    PROMPT_CORPUS.map(({ id, sha256, sourceVersion, sourceFile }) => ({
      id,
      sha256,
      sourceVersion,
      sourceFile,
    })),
  ),
);
