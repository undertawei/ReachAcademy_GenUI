import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { HTML_PRODUCTION_PROMPT } from '../../lib/reach-deck/prompts/html-production.js';
import { REFERENCE_OUTLINE_PROMPT } from '../../lib/reach-deck/prompts/reference-design.js';

import {
  PAGE_RESPONSIBILITY_PRIORITY,
  PAGE_RESPONSIBILITY_PRIORITY_VERSION,
  PROMPT_CORPUS,
  PROMPT_CORPUS_DIGEST,
  PROMPT_CORPUS_VERSION,
} from '../../lib/reach-deck/prompts/index.js';

describe('Reach Deck authored prompt corpus', () => {
  it('includes every complete authored stage in its effective model prompt', () => {
    for (const source of PROMPT_CORPUS.filter(
      ({ id, sourceFile }) => id.startsWith('SOURCE_') && sourceFile.endsWith('/stages.ts'),
    )) {
      const effective = PROMPT_CORPUS.find(({ id }) => id === source.id.slice('SOURCE_'.length));
      expect(effective, source.id).toBeDefined();
      if (source.id === 'SOURCE_INTERACTIVE_PROMPT') {
        // Keep authored teaching prose. Only superseded/repeated runtime and output lines retire.
        const effectiveLines = new Set(effective!.text.split('\n'));
        const retired = source.text.split('\n').filter((line) => !effectiveLines.has(line));
        expect(retired).toHaveLength(5);
        for (const line of retired)
          expect(line).toMatch(
            /All scripts must be complete|^- The bridge first dispatches|^OPTIONAL FUNCTION PLOT$|^For the bundled function-plot|^The host injects ReachFunctionPlot/,
          );
        continue;
      }
      if (source.id !== 'SOURCE_PAGED_OUTLINE_PROMPT') {
        expect(effective!.text, source.id).toContain(source.text);
        continue;
      }
      // The outline plans visualAssets directly and authors the v3 spec: only the archived
      // field-contract lines retire; every other teaching line is kept verbatim.
      const effectiveLines = new Set(effective!.text.split('\n'));
      const retired = source.text.split('\n').filter((line) => !effectiveLines.has(line));
      expect(retired, source.id).toHaveLength(7);
      for (const line of retired)
        expect(line, source.id).toMatch(
          /page IDs and order|focusStatement|continuity contains|Slides present|assessmentIntent|genUiIntent|microCycleStages and assessmentIntent/,
        );
    }
    for (const id of ['PREPARATION_DESIGN_GUIDE', 'KNOWLEDGE_MICRO_CYCLE_PEDAGOGY_SNIPPET']) {
      const source = PROMPT_CORPUS.find((fragment) => fragment.id === id)!;
      const outline = PROMPT_CORPUS.find((fragment) => fragment.id === 'PAGED_OUTLINE_PROMPT')!;
      expect(outline.text, id).toContain(source.text);
    }
  });

  it('locks the effective prompt versions, complete fragment inventory and digest', () => {
    expect({
      version: PROMPT_CORPUS_VERSION,
      digest: PROMPT_CORPUS_DIGEST,
      count: PROMPT_CORPUS.length,
      ids: PROMPT_CORPUS.map(({ id }) => id),
      versions: Object.fromEntries(
        PROMPT_CORPUS.map(({ id, sourceVersion }) => [id, sourceVersion]),
      ),
    }).toMatchInlineSnapshot(`
      {
        "count": 69,
        "digest": "0e69249c069e3dfb7b254b49b1a446f213bc92db8b58b362b77c283066653aac",
        "ids": [
          "REFERENCE_OUTLINE_PROMPT",
          "CODE_DIAGRAM_AUTHOR_PROMPT",
          "HTML_PRODUCTION_PROMPT",
          "NARRATION_SPEECH_READINGS_PROMPT",
          "LEGACY_NARRATION_PROMPT",
          "SCIENTIFIC_VISUAL_PROMPT",
          "LESSON_PLAN_PROMPT",
          "PAGED_OUTLINE_PROMPT",
          "SLIDE_PROMPT",
          "QUIZ_PROMPT",
          "NARRATION_PROMPT",
          "INTERACTIVE_PROMPT",
          "SOURCE_LESSON_PLAN_PROMPT",
          "SOURCE_PAGED_OUTLINE_PROMPT",
          "SOURCE_SLIDE_PROMPT",
          "SOURCE_SCIENTIFIC_VISUAL_PROMPT",
          "SOURCE_LEGACY_NARRATION_PROMPT",
          "SOURCE_NARRATION_PROMPT",
          "SOURCE_QUIZ_PROMPT",
          "SOURCE_INTERACTIVE_PROMPT",
          "REACH_FUNCTION_PLOT_PROMPT_CONTRACT",
          "SCIENTIFIC_SLIDE_BINDING_PROMPT",
          "SCIENTIFIC_VISUAL_OUTLINE_PROMPT",
          "JSON_OUTPUT_RULES_SNIPPET",
          "OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET",
          "NARRATION_SYSTEM_PROMPT",
          "SOURCE_AND_LANGUAGE_SNIPPET",
          "PREPARATION_DESIGN_GUIDE",
          "PREPARATION_SYSTEM_PROMPT",
          "TEXT_FIELD_RULES_SNIPPET",
          "TEACHER_CUSTOMIZATION_BOUNDARY_SNIPPET",
          "SINGLE_SESSION_CONTINUITY_SNIPPET",
          "PAGE_NARRATIVE_CONTEXT_SNIPPET",
          "ICEBERG_PEDAGOGY_SNIPPET",
          "KNOWLEDGE_MICRO_CYCLE_PEDAGOGY_SNIPPET",
          "LEARNING_INTERACTION_INTEGRITY_SNIPPET",
          "SCIENTIFIC_REPRESENTATION_INTEGRITY_SNIPPET",
          "SCIENTIFIC_TOOL_SELECTION_SNIPPET",
          "PREVIOUS_PAGE_NARRATION_SNIPPET",
          "SEMANTIC_CONTEXT_SNIPPET",
          "MEDIA_INTENT_RESOLUTION_SNIPPET",
          "SLIDE_AUTHORING_QUALITY_SNIPPET",
          "GENUI_VISUAL_ROUTING_PROMPT",
          "GENUI_DIAGRAM_AUTHOR_PROMPT",
          "GENUI_DIAGRAM_RUNTIME_REPAIR_PROMPT",
          "OFFLINE_RUNTIME_REGISTRY",
          "BUILT_IN_TAILWIND_AUTHORING",
          "BUILT_IN_SCIENCE_KITS",
          "JAVASCRIPT_CORRECTNESS",
          "REACHINTERACTIVE_BRIDGE_CONTRACT",
          "HOST_FUNCTION_PLOT_CAPABILITY",
          "NARRATION_TEACHER_CALIBRATION_EXAMPLES",
          "NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES",
          "NARRATION_TEACHER_REFERENCE_EXAMPLES",
          "NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE",
          "NARRATION_TEACHER_CALIBRATION_PHRASE_BANK",
          "NARRATION_TEACHER_CALIBRATION_PRODUCTION_EXAMPLE",
          "NARRATION_TEACHER_FEEDBACK_INBOX",
          "NARRATION_TEACHER_FEEDBACK_REVIEW_BOUNDARY",
          "NARRATION_TEACHING_MOVES",
          "OPENMAIC_CHINESE_NARRATION_CORE_IDS",
          "OPENMAIC_CHINESE_NARRATION_EXAMPLES",
          "OPENMAIC_EXPLICIT_CLASSROOM_LANGUAGE_EXAMPLES",
          "OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS",
          "NARRATION_HUMANIZATION_SOURCES",
          "NARRATION_HUMANIZATION_EXAMPLES",
          "NARRATION_HUMANIZATION_ADAPTED_RULES",
          "NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK",
          "PAGE_RESPONSIBILITY_PRIORITY",
        ],
        "version": "reach-deck-capability-html-corpus/2026-10-20-v9",
        "versions": {
          "BUILT_IN_SCIENCE_KITS": "reach-interactive-runtime-contract/v1",
          "BUILT_IN_TAILWIND_AUTHORING": "reach-interactive-runtime-contract/v1",
          "CODE_DIAGRAM_AUTHOR_PROMPT": "diagram-code-author/v4",
          "GENUI_DIAGRAM_AUTHOR_PROMPT": "genui-diagram-media/v2",
          "GENUI_DIAGRAM_RUNTIME_REPAIR_PROMPT": "genui-diagram-media/v2/runtime-repair",
          "GENUI_VISUAL_ROUTING_PROMPT": "genui-diagram-media/v2",
          "HOST_FUNCTION_PLOT_CAPABILITY": "reach-interactive-runtime-contract/v1",
          "HTML_PRODUCTION_PROMPT": "html-native-v2/capabilities-reference-v10-table-budget",
          "ICEBERG_PEDAGOGY_SNIPPET": "local-source/2026-09-23",
          "INTERACTIVE_PROMPT": "interactive/v39-flat-event-fields",
          "JAVASCRIPT_CORRECTNESS": "reach-interactive-runtime-contract/v1",
          "JSON_OUTPUT_RULES_SNIPPET": "local-source/2026-09-23",
          "KNOWLEDGE_MICRO_CYCLE_PEDAGOGY_SNIPPET": "local-source/2026-09-23",
          "LEARNING_INTERACTION_INTEGRITY_SNIPPET": "local-source/2026-09-23",
          "LEGACY_NARRATION_PROMPT": "narration/v11",
          "LESSON_PLAN_PROMPT": "lesson-plan/v22-capabilities",
          "MEDIA_INTENT_RESOLUTION_SNIPPET": "local-source/2026-09-23",
          "NARRATION_HUMANIZATION_ADAPTED_RULES": "narration-humanization-sources/v1",
          "NARRATION_HUMANIZATION_EXAMPLES": "narration-humanization-sources/v1",
          "NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK": "narration-humanization-sources/v1",
          "NARRATION_HUMANIZATION_SOURCES": "narration-humanization-sources/v1",
          "NARRATION_PROMPT": "narration/v30-math-notation",
          "NARRATION_SPEECH_READINGS_PROMPT": "narration-speech-readings/v2",
          "NARRATION_SYSTEM_PROMPT": "local-source/2026-09-23",
          "NARRATION_TEACHER_CALIBRATION_EXAMPLES": "reach-deck-teacher-calibration/v3",
          "NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE": "reach-deck-teacher-calibration/v3",
          "NARRATION_TEACHER_CALIBRATION_PHRASE_BANK": "reach-deck-teacher-calibration/v3",
          "NARRATION_TEACHER_CALIBRATION_PRODUCTION_EXAMPLE": "reach-deck-teacher-calibration/v3",
          "NARRATION_TEACHER_FEEDBACK_INBOX": "reach-deck-teacher-feedback-inbox/v2",
          "NARRATION_TEACHER_FEEDBACK_REVIEW_BOUNDARY": "reach-deck-teacher-feedback-inbox/v2",
          "NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES": "reach-deck-teacher-calibration/v3",
          "NARRATION_TEACHER_REFERENCE_EXAMPLES": "reach-deck-teacher-calibration/v3",
          "NARRATION_TEACHING_MOVES": "openmaic-chinese-narration-examples/v1",
          "OFFLINE_RUNTIME_REGISTRY": "reach-interactive-runtime-contract/v1",
          "OPENMAIC_CHINESE_NARRATION_CORE_IDS": "openmaic-chinese-narration-examples/v1",
          "OPENMAIC_CHINESE_NARRATION_EXAMPLES": "openmaic-chinese-narration-examples/v1",
          "OPENMAIC_EXPLICIT_CLASSROOM_LANGUAGE_EXAMPLES": "openmaic-chinese-narration-examples/v1",
          "OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS": "openmaic-minimal-edit-narration-corpus/v1",
          "OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET": "openmaic-teaching-speech/v15",
          "PAGED_OUTLINE_PROMPT": "paged-outline/v68-solid-diagram-svg",
          "PAGE_NARRATIVE_CONTEXT_SNIPPET": "local-source/2026-09-23",
          "PAGE_RESPONSIBILITY_PRIORITY": "page-responsibility/v1",
          "PREPARATION_DESIGN_GUIDE": "preparation-design/v8",
          "PREPARATION_SYSTEM_PROMPT": "local-source/2026-09-23",
          "PREVIOUS_PAGE_NARRATION_SNIPPET": "local-source/2026-09-23",
          "QUIZ_PROMPT": "quiz/v19-scene-spec-v3",
          "REACHINTERACTIVE_BRIDGE_CONTRACT": "reach-interactive-runtime-contract/v3-window-listeners",
          "REACH_FUNCTION_PLOT_PROMPT_CONTRACT": "local-source/2026-09-23",
          "REFERENCE_OUTLINE_PROMPT": "paged-outline/compact-reference-v11-solid-diagram-svg",
          "SCIENTIFIC_REPRESENTATION_INTEGRITY_SNIPPET": "local-source/2026-09-23",
          "SCIENTIFIC_SLIDE_BINDING_PROMPT": "local-source/2026-09-23",
          "SCIENTIFIC_TOOL_SELECTION_SNIPPET": "local-source/2026-09-23",
          "SCIENTIFIC_VISUAL_OUTLINE_PROMPT": "local-source/2026-09-23",
          "SCIENTIFIC_VISUAL_PROMPT": "scientific-visual/v9",
          "SEMANTIC_CONTEXT_SNIPPET": "local-source/2026-09-23",
          "SINGLE_SESSION_CONTINUITY_SNIPPET": "local-source/2026-09-23",
          "SLIDE_AUTHORING_QUALITY_SNIPPET": "local-source/2026-09-23",
          "SLIDE_PROMPT": "slide/v31-capabilities",
          "SOURCE_AND_LANGUAGE_SNIPPET": "local-source/2026-09-23",
          "SOURCE_INTERACTIVE_PROMPT": "interactive/v34-creative",
          "SOURCE_LEGACY_NARRATION_PROMPT": "narration/v11",
          "SOURCE_LESSON_PLAN_PROMPT": "lesson-plan/v21",
          "SOURCE_NARRATION_PROMPT": "narration/v28",
          "SOURCE_PAGED_OUTLINE_PROMPT": "paged-outline/v60-one-visual-per-intent",
          "SOURCE_QUIZ_PROMPT": "quiz/v17",
          "SOURCE_SCIENTIFIC_VISUAL_PROMPT": "scientific-visual/v9",
          "SOURCE_SLIDE_PROMPT": "slide/v30",
          "TEACHER_CUSTOMIZATION_BOUNDARY_SNIPPET": "local-source/2026-09-23",
          "TEXT_FIELD_RULES_SNIPPET": "local-source/2026-09-23",
        },
      }
    `);
  });

  it('keeps every fragment self-describing and hashable', () => {
    expect(
      PROMPT_CORPUS.every(
        (fragment) =>
          fragment.id &&
          fragment.text.length > 0 &&
          fragment.stage &&
          fragment.call &&
          fragment.purpose &&
          fragment.sourceFile &&
          fragment.sourceVersion &&
          fragment.corpusVersion === PROMPT_CORPUS_VERSION &&
          /^[a-f0-9]{64}$/u.test(fragment.sha256),
      ),
    ).toBe(true);
    for (const fragment of PROMPT_CORPUS) {
      expect(fragment.sha256, fragment.id).toBe(
        createHash('sha256').update(fragment.text, 'utf8').digest('hex'),
      );
    }
  });

  it('registers the effective HTML prompt and explicitly archives the old static slide prompt', () => {
    const html = PROMPT_CORPUS.find(({ id }) => id === 'HTML_PRODUCTION_PROMPT')!;
    expect(html.text).toBe(HTML_PRODUCTION_PROMPT.text);
    expect(html.sourceVersion).toBe(HTML_PRODUCTION_PROMPT.version);
    expect(html.text).toContain(PAGE_RESPONSIBILITY_PRIORITY);
    expect(html.stage).toBe('html-slide');
    const outline = PROMPT_CORPUS.find(({ id }) => id === 'REFERENCE_OUTLINE_PROMPT')!;
    expect(outline.text).toBe(REFERENCE_OUTLINE_PROMPT.text);
    expect(outline.sourceVersion).toBe(REFERENCE_OUTLINE_PROMPT.version);
    expect(outline.stage).toBe('paged-outline');
    expect(PROMPT_CORPUS.find(({ id }) => id === 'SLIDE_PROMPT')?.purpose).toContain('Archived');
    for (const id of ['GENUI_VISUAL_ROUTING_PROMPT', 'GENUI_DIAGRAM_RUNTIME_REPAIR_PROMPT']) {
      expect(PROMPT_CORPUS.find((fragment) => fragment.id === id)?.purpose).toContain(
        'not production calls',
      );
    }
  });
});

describe('page responsibility priority corpus', () => {
  it('locks the complete conflict matrix and priority wording', () => {
    expect(PAGE_RESPONSIBILITY_PRIORITY_VERSION).toBe('page-responsibility/v1');
    expect(PAGE_RESPONSIBILITY_PRIORITY).toContain('单页文字要求、页面标题、视觉方向');
    for (const conflict of [
      '页面职责要求解释，单页要求只提问',
      '页面职责要求 Quiz，单页要求 Slide 收集答案',
      '页面职责要求揭示，单页要求继续悬念',
      '页面职责要求收束，单页要求新增知识',
      '页面职责要求迁移，单页要求重新讲完整定义',
      '页面职责要求自由 Interactive，单页 hint 指定固定控件或步骤',
    ])
      expect(PAGE_RESPONSIBILITY_PRIORITY).toContain(conflict);
    expect(PAGE_RESPONSIBILITY_PRIORITY).toContain('每个冲突样例都要遵守页面职责优先');
  });

  it('injects the contract into each model-facing stage prompt', () => {
    for (const id of [
      'LESSON_PLAN_PROMPT',
      'PAGED_OUTLINE_PROMPT',
      'REFERENCE_OUTLINE_PROMPT',
      'SLIDE_PROMPT',
      'QUIZ_PROMPT',
      'NARRATION_PROMPT',
      'INTERACTIVE_PROMPT',
    ]) {
      const fragment = PROMPT_CORPUS.find((candidate) => candidate.id === id);
      expect(fragment?.text).toContain(PAGE_RESPONSIBILITY_PRIORITY);
    }
  });
});
