import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT as HTML_LAYOUT_CORE } from '../../scripts/reach-deck/html-layout/prompts.js';
import { HTML_PRODUCTION_PROMPT } from '../../lib/reach-deck/prompts/html-production.js';
import { PAGE_RESPONSIBILITY_PRIORITY } from '../../lib/reach-deck/prompts/corpus/page-responsibility.js';
import { composeCompactOutlinePrompt } from '../../lib/reach-deck/prompts/compact-outline.js';
import {
  GENUI_DIAGRAM_AUTHOR_PROMPT,
  GENUI_DIAGRAM_PROMPT_VERSION,
} from '../../lib/reach-deck/prompts/genui-diagram.js';

import {
  LESSON_PLAN_PROMPT,
  INTERACTIVE_PROMPT,
  NARRATION_PROMPT,
  PAGED_OUTLINE_PROMPT,
  QUIZ_PROMPT,
  SCIENTIFIC_VISUAL_PROMPT,
  SLIDE_PROMPT,
  composeInteractiveApproachGuidance,
} from '../../lib/reach-deck/prompts/index.js';
import { DECK_THEME_NAMES } from '@reachany/reach-deck-dsl';
import { PAGED_DECK_OUTLINE_SCHEMA } from '../../lib/reach-deck/model-service-schemas.js';
import {
  REFERENCE_ASSET_INSTRUCTIONS,
  REFERENCE_HTML_INSTRUCTIONS,
  REFERENCE_OUTLINE_PROMPT,
  buildReferenceAssetInstructions,
} from '../../lib/reach-deck/prompts/reference-design.js';
import {
  HTML_REFERENCE_LAYOUT_PROMPT,
  HTML_REFERENCE_LAYOUT_VERSION,
} from '../../lib/reach-deck/html-layout/reference-tables.js';

describe('Reach Deck generation prompts', () => {
  it('composes compact root and design contracts explicitly without reinterpreting teaching text', () => {
    const designInstructions =
      'Use original compositions; this design contract has no theme-catalog anchor.';
    const ordinary = composeCompactOutlinePrompt({
      rootFields: 'title, themeName and pages',
      designInstructions,
    });
    const reference = composeCompactOutlinePrompt({
      rootFields: 'title, designContext and pages',
      designInstructions,
    });
    expect(
      ordinary.startsWith(
        'Produce one compact outline JSON object with exactly title, themeName and pages.',
      ),
    ).toBe(true);
    expect(
      reference.startsWith(
        'Produce one compact outline JSON object with exactly title, designContext and pages.',
      ),
    ).toBe(true);
    expect(ordinary.slice(ordinary.indexOf('. Use the approved'))).toBe(
      reference.slice(reference.indexOf('. Use the approved')),
    );
    for (const prompt of [ordinary, reference]) {
      expect(prompt).toContain(designInstructions);
      expect(prompt).toContain('Plan one asset per visual');
      expect(prompt).toContain('A real attempt and real practice require Quiz or Interactive');
      expect(prompt).toContain(PAGE_RESPONSIBILITY_PRIORITY);
      // Motion along a declared function/series routes to the typed tracer, never a code GIF.
      expect(prompt).toContain(
        'A point moving along, or tracing, a declared function or ordered data series',
      );
      expect(prompt).toContain('is a function-plot with an animation object, never a code GIF');
      expect(prompt).toContain('motion along a declared function or data series is covered');
      // Reference images carry fallback searches in another language or alias.
      expect(prompt).toContain('alternativeQueries gives 1–3 distinct fallback searches');
    }
  });
  it('carries the teacher visual rules and interactive selection in both effective outline prompts', () => {
    for (const prompt of [PAGED_OUTLINE_PROMPT.text, REFERENCE_OUTLINE_PROMPT.text]) {
      for (const rule of [
        'The visualAssets limit is a ceiling, not a quota',
        'Parallel points, plain text lists, textual comparisons, classifications and relations between several concepts need no asset',
        'the layout draws with native shapes, arrows and text',
        'first reuse a suitable image already present in the supplied reference material: a reference-image asset whose materialReferenceOrdinal names that manifest image',
        'judge the requested image itself, not the course subject or formulas elsewhere in the lesson',
        'Scenery, people, ordinary scenes, objects and art whose internal exactness teaches nothing use image',
        'use a deterministic code path: diagram geometry, function-plot, chart or molecule when a typed contract fits (a solid or spatial figure is diagram svg, never geometry; molecule is only for a chemical structure); scientific-visual when the mechanism needs presentation-owned state or narration anchors; representation code only when no typed contract fits',
        'prefer an animated function-plot for motion along a declared function or data series; use a code GIF only when no typed engine can express that motion',
        'If no visual fits, or it would only fit as an illegible thumbnail, use text only',
        'Cover (title), section_break (section_open) and closing (close) pages keep 1–3 keyPoints',
        'silently check each page job for an interactive opportunity',
        'A Slide screenshot diagram and an Interactive scene are different outputs',
        'scientificVisualsEnabled governs Slide scientific media, not whether an enabled interactive scene may be chosen',
      ]) {
        expect(prompt, rule).toContain(rule);
      }
      // Our routing wins: mathematical figures are not routed wholesale to GenUI.
      expect(prompt).not.toContain('必须用GenUI');
      expect(prompt).not.toContain('always GenUI');
      // scientific-visual stays a route and the four-route list is intact.
      for (const route of ['- reference-image:', '- diagram:', '- scientific-visual:', '- image:'])
        expect(prompt).toContain(route);
    }
  });
  it('carries emphasis, container, palette, diagram, table and cover rules into the HTML prompt', () => {
    expect(HTML_LAYOUT_CORE).toContain('不缩小教学图迁就版式');
    for (const rule of [
      'Do not mute, desaturate, beige-wash or neutralize it',
      'at most 2 short emphasized phrases per paragraph or table cell and at most 6 per page',
      'Never underline generated text, including titles, quotations and table cells',
      'default to unmarked text',
      'normally use 0–2 text surfaces',
      'may use up to 3 peer surfaces',
      'text does not need a box',
      'never shrink a supplied teaching diagram to fit',
      'reallocate space or reduce and shorten the surrounding text',
      'If no arrangement shows the diagram legibly, keep the page text-only',
      'use a native table only for real row/column data',
      'Never fake a table with repeated rectangles and separate text boxes',
      'never shrink table text below the body tier to fit',
      'large course title in a quiet area',
      'must not compete with the focal visual or title',
      'No mandatory torn-paper seam, fixed hue or repeated poster template',
    ]) {
      expect(REFERENCE_HTML_INSTRUCTIONS, rule).toContain(rule);
      expect(HTML_PRODUCTION_PROMPT.text, rule).toContain(rule);
    }
    expect(HTML_REFERENCE_LAYOUT_PROMPT).not.toContain('EM/I, U, S');
    // Our four-tier font scale is kept; the offline 32/64 sizes are not adopted.
    expect(HTML_PRODUCTION_PROMPT.text).not.toMatch(/64px/);
  });
  it('carries the code author figure-size, GIF and slide-text boundaries', () => {
    for (const rule of [
      'Do not shrink the whole figure on a large canvas',
      'never draw a larger internal canvas and scale the diagram or its text down to fit',
      'A GIF expresses the relationship itself: a trajectory, direction, cycle, flow, transformation or state change',
      'draw only the indispensable relationship inside the image itself',
      'Do not turn parallel points, plain text, conceptual summaries or comparison cards into an infographic',
      'Judge the requested image itself, not formulas, numbers or terminology elsewhere in the lesson',
    ]) {
      expect(GENUI_DIAGRAM_AUTHOR_PROMPT, rule).toContain(rule);
    }
    expect(GENUI_DIAGRAM_PROMPT_VERSION).toBe('diagram-code-author/v4');
  });
  it('keeps local text contrast in the unconditional capability contract', () => {
    expect(HTML_REFERENCE_LAYOUT_PROMPT).toContain('normal/small text at least 4.5:1');
    expect(HTML_REFERENCE_LAYOUT_PROMPT).toContain(
      'large text (24px regular or 18.67px bold) at least 3:1',
    );
  });
  it('keeps one compact core with complete authored geometry and bounded fitting', () => {
    expect(HTML_LAYOUT_CORE.length).toBeLessThan(3000);
    for (const contract of [
      'position:absolute;left:数字px;top:数字px;width:数字px;height:数字px',
      '#slide > *{margin:0}',
      '#slide,#slide *{box-sizing:border-box}',
      '图卡高度 =',
      '素材实际比例优先于参考槽比例',
      'top+height≤876',
      'max(0,offsetY)+blur+max(0,spread)',
      '卡底+外扩+16≤页脚线 top',
      '编译器只做有限文字和公式适配',
      '观察线索',
    ]) {
      expect(HTML_LAYOUT_CORE).toContain(contract);
    }
    expect(HTML_LAYOUT_CORE).not.toContain('<div>');
    expect(HTML_LAYOUT_CORE).not.toContain('先给知识图空间');
  });

  it('keeps math editable with intact delimiters and structural height guidance', () => {
    expect(HTML_LAYOUT_CORE).toContain(String.raw`\(s=120\,\mathrm{m}\)`);
    expect(HTML_LAYOUT_CORE).toContain(String.raw`\[v=\frac{s}{t}\]`);
    for (const contract of [
      '同一文本节点',
      '独立公式单设可编辑 p/div',
      '2.8–3.2',
      '不是精确测量或硬性阈值',
      '16–24px',
      '不裁切公式',
      '不画进 figure 或 SVG',
      '自绘 figure 内不写知识性文字',
      '教学内容图只来自随附素材',
      '只承担版式与装饰',
      '字号只用四档：页面标题 48px，小标题与关键句 32px，正文 24px，标签、图注与页脚 20px',
    ]) {
      expect(HTML_LAYOUT_CORE).toContain(contract);
    }
  });

  it('defines table, color and asset contracts once in their owning prompt fragments', () => {
    expect(HTML_REFERENCE_LAYOUT_VERSION).toBe('html-reference-layout/v19');
    expect(HTML_REFERENCE_LAYOUT_PROMPT).toContain(
      `Reference layout adapter ${HTML_REFERENCE_LAYOUT_VERSION}:`,
    );
    for (const contract of [
      '40 top-level editable text elements',
      '80 native elements',
      'THEAD/TBODY/TFOOT/TR/TH/TD',
      'SPAN, STRONG/B, EM/I, S, BR; never U or underline',
      'CAPTION, COLGROUP/COL',
      'column widths on TH/TD',
      'border-collapse:collapse;background-image:none',
      'data-reach-informative',
      'data-reach-heatmap',
    ]) {
      expect(HTML_REFERENCE_LAYOUT_PROMPT).toContain(contract);
    }
    expect(REFERENCE_HTML_INSTRUCTIONS).toContain('Reference HTML contract v12');
    expect(REFERENCE_HTML_INSTRUCTIONS).toContain('normalText');
    expect(REFERENCE_HTML_INSTRUCTIONS).toContain('largeTextOnly');
    expect(REFERENCE_HTML_INSTRUCTIONS).not.toContain('THEAD/TBODY');
    expect(REFERENCE_HTML_INSTRUCTIONS).not.toContain(REFERENCE_ASSET_INSTRUCTIONS);
    expect(REFERENCE_HTML_INSTRUCTIONS).not.toContain('referenceLibraryAvailable');
    expect(REFERENCE_ASSET_INSTRUCTIONS).toContain('reference HTML v8');
    expect(REFERENCE_ASSET_INSTRUCTIONS).toContain('empty DIV directly under section#slide');
  });

  it('takes card example colors from the current palette with neutral local defaults', () => {
    const instructions = buildReferenceAssetInstructions({
      accent: '#216A75',
      surface: '#EDF4F0',
    });
    expect(instructions).toContain('linear-gradient(#216A75 0px,#216A75 8px,#EDF4F0 8px)');
    expect(instructions).toContain("figure's own border-left or linear-gradient(to right,...)");
    expect(instructions).not.toContain('#B53B35');
    expect(instructions).not.toContain('#FFFDF8');
    expect(REFERENCE_ASSET_INSTRUCTIONS).toContain(
      'linear-gradient(#555555 0px,#555555 8px,#FFFFFF 8px)',
    );
    expect(instructions.match(/<figure /g)).toHaveLength(1);
  });

  it('provides one self-contained inline example with a proportional slot and reserved caption', () => {
    const nodes = [
      ...REFERENCE_ASSET_INSTRUCTIONS.matchAll(/<(figure|p|div)\s[^>]*style="([^"]+)"[^>]*>/g),
    ];
    expect(nodes).toHaveLength(4);
    expect(REFERENCE_ASSET_INSTRUCTIONS).not.toContain('font-size');
    const boxes = nodes.map(([, , style]) => {
      expect(style).toContain('position:absolute');
      const dimension = (name: string) => {
        const value = style!.match(new RegExp(`(?:^|;)${name}:(\\d+)px(?:;|$)`));
        expect(value, name).not.toBeNull();
        return Number(value![1]);
      };
      return {
        x: dimension('left'),
        y: dimension('top'),
        width: dimension('width'),
        height: dimension('height'),
      };
    });
    const [card, label, slot, caption] = boxes;
    expect(slot!.height).toBe((slot!.width * 9) / 16);
    expect(label!.y + label!.height).toBeLessThan(slot!.y);
    expect(slot!.y + slot!.height).toBeLessThan(caption!.y);
    for (const content of [label!, slot!, caption!]) {
      expect(content.x).toBeGreaterThan(card!.x);
      expect(content.x + content.width).toBeLessThan(card!.x + card!.width);
      expect(content.y + content.height).toBeLessThan(card!.y + card!.height);
    }
    expect(caption!.height).toBe(2 * 30);
    expect(card!.height).toBe(28 + 30 + 16 + slot!.height + 16 + caption!.height + 32);
    expect(REFERENCE_ASSET_INSTRUCTIONS).toMatch(
      /<div[^>]+data-reach-asset="assetId"[^>]*><\/div>/,
    );
  });
  it('replaces the legacy outline contract without losing advisory design freedom', () => {
    expect(REFERENCE_OUTLINE_PROMPT.version).toBe(
      'paged-outline/compact-reference-v11-solid-diagram-svg',
    );
    expect(REFERENCE_OUTLINE_PROMPT.text).toContain('title, designContext and pages');
    for (const field of [
      'reach-deck-instructional-spec/v3',
      'pageRole',
      'pageJob',
      'keyPoints',
      'knowledgePointIds',
      'visibleTitleMode',
      'visualAssets',
      'interactionBrief',
      'designIntent',
    ]) {
      expect(REFERENCE_OUTLINE_PROMPT.text).toContain(field);
    }
    expect(REFERENCE_OUTLINE_PROMPT.text).not.toContain('visualIntents');
    expect(REFERENCE_OUTLINE_PROMPT.text).toContain('The application assigns page IDs and order');
    expect(REFERENCE_OUTLINE_PROMPT.text).toContain('References are advisory');
    expect(REFERENCE_OUTLINE_PROMPT.text).not.toContain('Available deck themes');
    expect(REFERENCE_OUTLINE_PROMPT.text).not.toContain('Prefer reach-classic');
    expect(REFERENCE_OUTLINE_PROMPT.text).not.toContain('exactly title, themeName and pages');
  });
  it('科学 visual prompt 说明 anchors 是数组并要求按 present(frame) 确定性重建', () => {
    expect(SCIENTIFIC_VISUAL_PROMPT.version).toBe('scientific-visual/v9');
    expect(SCIENTIFIC_VISUAL_PROMPT.text).toContain('frame.anchors is an array');
    expect(SCIENTIFIC_VISUAL_PROMPT.text).toContain(
      'frame.anchors.find((anchor) => anchor.id === "launch")',
    );
    expect(SCIENTIFIC_VISUAL_PROMPT.text).toContain(
      'a separate deterministic presentation window long enough to show the visual transition',
    );
    expect(SCIENTIFIC_VISUAL_PROMPT.text).toContain(
      "progress is not compressed to the triggering word's timestamp span",
    );
  });
  it('uses versioned source-faithful lesson and outline authoring contracts', () => {
    expect(LESSON_PLAN_PROMPT.version).toBe('lesson-plan/v22-capabilities');
    expect(LESSON_PLAN_PROMPT.text).toContain('2-5 observable learningObjectives');
    expect(LESSON_PLAN_PROMPT.text).toContain('dominant source language');
    expect(LESSON_PLAN_PROMPT.text).not.toContain('Chinese LessonPlan');
    expect(LESSON_PLAN_PROMPT.text).toContain('objectives, story, knowledgePlan');
    expect(LESSON_PLAN_PROMPT.text).toContain('includeTitlePage');
    expect(LESSON_PLAN_PROMPT.text).toContain('stable ids');
    expect(LESSON_PLAN_PROMPT.text).toContain('in source order');
    expect(LESSON_PLAN_PROMPT.text).toContain('vocabulary_cluster');
    expect(LESSON_PLAN_PROMPT.text).toContain('2–3 items is preferred');
    expect(LESSON_PLAN_PROMPT.text).toContain('mixed exploratory direct instruction');
    expect(LESSON_PLAN_PROMPT.text).toContain('fluency-oriented exercise training');
    expect(LESSON_PLAN_PROMPT.text).toContain('Quiz or GenUI Interactive');
    expect(LESSON_PLAN_PROMPT.text).toContain('rather than a narrated Slide');
    expect(LESSON_PLAN_PROMPT.text).toContain(
      'Do not allocate quiz-page or question slots at this stage',
    );

    expect(PAGED_OUTLINE_PROMPT.version).toBe('paged-outline/v68-solid-diagram-svg');
    expect(PAGED_OUTLINE_PROMPT.text).toContain('The application assigns page IDs and order');
    expect(PAGED_OUTLINE_PROMPT.text).toContain(
      'Strings are plain text with necessary inline equations',
    );
    expect(PAGED_OUTLINE_PROMPT.text).not.toContain('stable id');
    expect(PAGED_OUTLINE_PROMPT.text).not.toContain('each summary');
    expect(PAGED_OUTLINE_PROMPT.text).toContain('learnerAction');
    expect(PAGED_OUTLINE_PROMPT.text).toContain('experienceGoal');
    expect(PAGED_OUTLINE_PROMPT.text).toContain(
      'It is creative direction, not a fixed implementation',
    );
    expect(PAGED_OUTLINE_PROMPT.text).toContain(
      'do not prescribe controls, steps, event design, layout, success flows or profile markers',
    );
    expect(PAGED_OUTLINE_PROMPT.text).toContain('Follow enabledSceneTypes');
    expect(PAGED_OUTLINE_PROMPT.text).toContain('Respect requested title-page preferences');
    expect(PAGED_OUTLINE_PROMPT.text).not.toContain('Prefer slide unless');
    expect(PAGED_OUTLINE_PROMPT.text).toContain(
      'pageRole: the one primary responsibility, not a layout',
    );
    // v3 carries the micro-cycle in pageRole; the corpus field names are explicitly superseded.
    expect(PAGED_OUTLINE_PROMPT.text).toContain(
      'This field contract supersedes field names in the appended teaching corpus',
    );
    expect(PAGED_OUTLINE_PROMPT.text).toContain('For basic facts such as poetry-line meanings');
    expect(PAGED_OUTLINE_PROMPT.text).toContain('curiosity/exploration → answerable attempt');
    expect(PAGED_OUTLINE_PROMPT.text).toContain(
      'A rhetorical slide question does not count as learner evidence',
    );
  });

  it('大纲 prompt 列出主题库并要求整份 deck 只选一个主题', () => {
    for (const name of DECK_THEME_NAMES) expect(PAGED_OUTLINE_PROMPT.text).toContain(name);
    // 主题名同时进 schema 枚举，两侧取值域必须同源。
    const schema = PAGED_DECK_OUTLINE_SCHEMA.schema as {
      properties: { themeName: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.themeName.enum).toEqual([...DECK_THEME_NAMES]);
    expect(schema.required).toContain('themeName');
  });

  it('用可执行的中性契约检查科学表示的状态一致性', () => {
    const statefulPrompts = [SCIENTIFIC_VISUAL_PROMPT.text, INTERACTIVE_PROMPT.text];

    for (const prompt of statefulPrompts) {
      expect(prompt).toContain('For a stateful representation');
      expect(prompt).toContain('every discrete learner state');
      expect(prompt).toContain('boundaries and representative intermediate states');
      expect(prompt).not.toContain('every reachable learner state');
    }
    expect(SCIENTIFIC_VISUAL_PROMPT.text).toContain(
      'neither a different transformation nor a merely cosmetic movement',
    );
  });

  it('retains the archived V1 slide contract without treating it as production HTML guidance', () => {
    expect(SLIDE_PROMPT.version).toBe('slide/v31-capabilities');
    expect(SLIDE_PROMPT.text).toContain('TEXT FRAME FIT CONTRACT');
    expect(SLIDE_PROMPT.text).toContain('mandatory');
    expect(SLIDE_PROMPT.text).toContain('requiredLines <= availableLines');
    expect(SLIDE_PROMPT.text).toContain('color-block containment arithmetic');
    expect(SLIDE_PROMPT.text).toContain('SILENT COMPOSITION PROCEDURE');
    expect(SLIDE_PROMPT.text).toContain(
      'pair every foreground text frame that belongs inside a container with exactly one semantic background shape',
    );
    expect(SLIDE_PROMPT.text).toContain(
      'Derive each text frame independently from its own container x, y, width, height',
    );
    expect(SLIDE_PROMPT.text).toContain("never reuse a sibling text frame's coordinates");
    expect(SLIDE_PROMPT.text).toContain(
      'The active slide generation profile has text, shape, line, and optional current-page image',
    );
    expect(SLIDE_PROMPT.text).toContain(
      'Never emit a native-v2 document envelope, resources, object keys, URLs, arbitrary colors',
    );
    expect(SLIDE_PROMPT.text).toContain('RESTRICTED MARKDOWN SUBSET');
    expect(SLIDE_PROMPT.text).toContain('C0 control characters other than TAB, LF, or CR');
    expect(SLIDE_PROMPT.text).toContain('Unicode escape such as \\u0002 or \\u0008');
    expect(SLIDE_PROMPT.text).toContain(
      'Allowed: **bold**, *italic*, "-" bullet lines, "1." numbered lines',
    );
    expect(SLIDE_PROMPT.text).toContain(
      'Forbidden: headings (#), links, images, tables, code fences',
    );
    expect(SLIDE_PROMPT.text).toContain('COLOR TOKEN SEMANTICS');
    expect(SLIDE_PROMPT.text).toContain('keep accented text under roughly 10 percent of the page');
    expect(SLIDE_PROMPT.text).toContain(
      'The active theme owns the concrete background and text contrast',
    );
    expect(SLIDE_PROMPT.text).toContain(
      'Do not create video elements in the active slide generation profile',
    );
    expect(SLIDE_PROMPT.text).not.toContain('fixed dark title and body text');
    expect(SLIDE_PROMPT.text).not.toContain('light-background compatibility');
    expect(SLIDE_PROMPT.text).toContain('resolvedMediaAssets supplies images');
    expect(SLIDE_PROMPT.text).toContain('reference each supplied assetId');
    expect(SLIDE_PROMPT.text).toContain('use every supplied asset exactly once');
    expect(HTML_PRODUCTION_PROMPT.text).not.toContain('renderFallback');
    expect(HTML_PRODUCTION_PROMPT.text).not.toContain('Select an explicit renderFallback');
    expect(SLIDE_PROMPT.text).not.toContain('copy that objectKey unchanged');
    expect(SLIDE_PROMPT.text).toContain(
      'compositionHints is a low-priority geometric suggestion for this page',
    );
    expect(SLIDE_PROMPT.text).toContain('compositionHints remains a legacy advisory fallback');
    expect(SLIDE_PROMPT.text).toContain('Asset ids shown inside worked examples are never valid');
    expect(SLIDE_PROMPT.text).toContain('Use a consistent spacing rhythm of 24, 32, 40, or 48px');
    expect(SLIDE_PROMPT.text).toContain(
      'title 64px with 68px line height (maximum two lines), body 30px with 42px line height, and caption 24px with 32px line height',
    );
    expect(SLIDE_PROMPT.text).toContain('Source Han Sans VF');
    expect(SLIDE_PROMPT.text).toContain(
      'formula inherits the containing title, body, or caption tier',
    );
    expect(SLIDE_PROMPT.text).toContain(
      'wider text frame or a KaTeX-compatible aligned multiline display',
    );
    expect(SLIDE_PROMPT.text).toContain('never rely on horizontal scrolling');
    expect(SLIDE_PROMPT.text).toContain('Never leave an empty mechanical title zone');
    expect(SLIDE_PROMPT.text).toContain('extra room for at least one glyph');
    expect(SLIDE_PROMPT.text).not.toMatch(/\bmetric\b|\beyebrow\b/);
    expect(SLIDE_PROMPT.text).toContain(
      'caption is only for a source note, media description, or short diagram annotation',
    );
    expect(SLIDE_PROMPT.text).toContain(
      'Text-led pages may use a small number of large semantic color blocks as reading regions',
    );
    expect(SLIDE_PROMPT.text).toContain('connector is a markerless straight relationship line');
    expect(SLIDE_PROMPT.text).toContain('Do not float a stack of disconnected arrows beside text');
    expect(SLIDE_PROMPT.text).toContain('one continuous rail with visibly aligned anchors');
    expect(SLIDE_PROMPT.text).toContain('Use 3-8 meaningful elements');
    expect(SLIDE_PROMPT.text).not.toContain('authoritative geometric');
    expect(SLIDE_PROMPT.text).toContain('generic dashboard cards');
    expect(SLIDE_PROMPT.text).toContain(
      'invented action types such as spotlight, laser, or play_video',
    );
  });

  it('sends page responsibility and native HTML constraints through the actual static prompt', () => {
    expect(HTML_PRODUCTION_PROMPT.version).toBe(
      'html-native-v2/capabilities-reference-v10-table-budget',
    );
    // Optional reveal grouping reaches the production HTML prompt, not only its version.
    expect(HTML_PRODUCTION_PROMPT.text).toContain('ENTRANCE GROUPING (OPTIONAL)');
    expect(HTML_PRODUCTION_PROMPT.text).toContain('data-reach-reveal-group="item-id"');
    // The layout model does not know the page position, so it must never invent page numbers.
    expect(HTML_PRODUCTION_PROMPT.text).toContain(
      'Never write a page number, page count or progress fraction',
    );
    expect(HTML_PRODUCTION_PROMPT.text).toContain(HTML_LAYOUT_CORE);
    expect(HTML_PRODUCTION_PROMPT.text).toContain(PAGE_RESPONSIBILITY_PRIORITY);
    expect(HTML_PRODUCTION_PROMPT.text).toContain('visibleTitleMode=none forbids a visible title');
    expect(HTML_PRODUCTION_PROMPT.text).toContain('References advise visual composition only');
    expect(HTML_PRODUCTION_PROMPT.text).toContain('Never split or merge pages');
    expect(HTML_PRODUCTION_PROMPT.text).not.toContain('Return exactly one Reach Deck DeckSlide');
  });

  it('拒绝在 prompt 中残留废弃元素与 cue 高亮的说明', () => {
    expect(SLIDE_PROMPT.text).not.toContain('BOARD WRITING GEOMETRY CONTRACT');
    expect(SLIDE_PROMPT.text).not.toContain('voiceTimeline');
    expect(SLIDE_PROMPT.text).not.toContain('aiTutorPrompt');
    expect(SLIDE_PROMPT.text).not.toContain('expectedSignals');
    expect(SLIDE_PROMPT.text).not.toContain('highlight');
  });

  it('slide 阶段只出版面：讲稿输出契约已从 SLIDE_PROMPT 删除', () => {
    expect(SLIDE_PROMPT.text).not.toContain('Write narration as an ordered list');
    expect(SLIDE_PROMPT.text).not.toContain('narration is an ordered list of spoken paragraphs');
    expect(SLIDE_PROMPT.text).not.toContain('revealElementIds marks which elements should enter');
    expect(SLIDE_PROMPT.text).not.toContain('PREVIOUS PAGE NARRATION');
    // 但仍提示模型讲稿在后续阶段生成，可见文案保持可扫读。
    expect(SLIDE_PROMPT.text).toContain('authored in a later stage');
  });

  it('narration 阶段拥有独立版本化 prompt 与讲稿撰写契约', () => {
    expect(NARRATION_PROMPT.version).toBe('narration/v30-math-notation');
    // 裸符号式拿不到公式读法，讲稿必须把要念的数学式放进公式定界符。
    expect(NARRATION_PROMPT.text).toContain('凡是要读出来的数学式都必须放进行内公式 \\( \\)');
    // 定界符 \( \) 不显示，坐标自身的括号必须写在里面。
    expect(NARRATION_PROMPT.text).toContain('坐标写成 \\((h,k)\\)');
    expect(NARRATION_PROMPT.text).not.toMatch(/坐标写成 \\\(h,k\\\)/u);
    expect(NARRATION_PROMPT.text).not.toContain('或普通文本 (h,k)');
    expect(NARRATION_PROMPT.text).toContain(
      'narrationContext.coursePageMap is the course page map',
    );
    expect(NARRATION_PROMPT.text).toContain('完整、自然的教师讲稿');
    expect(NARRATION_PROMPT.text).toContain('PPT 是不可违背的事实边界');
    expect(NARRATION_PROMPT.text).toContain('narrationMarkdown 是完整权威正文');
    expect(NARRATION_PROMPT.text).toContain('中文讲稿使用自然、完整的中文表达');
    expect(NARRATION_PROMPT.text).toContain('正文与公式：narrationMarkdown 是完整权威正文');
    expect(NARRATION_PROMPT.text).toContain('正文与公式：narrationMarkdown 是完整权威正文');
    expect(NARRATION_PROMPT.text).toContain(
      '若 payload 已提供 narrationMarkdown，则它是不可修改的教师原文',
    );
    expect(NARRATION_PROMPT.text).toContain('REVEAL GROUP BINDING');
    expect(NARRATION_PROMPT.text).toContain(
      '不要为了动画改变解释顺序、增写页面细节或把正文写成逐项解说',
    );
    expect(NARRATION_PROMPT.text).toContain('只绑定这些语义块');
    expect(NARRATION_PROMPT.text).toContain('多个相关视觉组也可以共享');
    expect(NARRATION_PROMPT.text).toContain('scientificBindings 为每个 scientific anchor');
    expect(NARRATION_PROMPT.text).toContain('一次生成，没有语言重写调用');
    expect(NARRATION_PROMPT.text).not.toContain('UTF-16');
    expect(NARRATION_PROMPT.text).not.toContain('quote equal');
    // 输出纪律 + 不可信数据段约定与其他阶段同源。
    expect(NARRATION_PROMPT.text).toContain('JSON OUTPUT CONTRACT');
    expect(NARRATION_PROMPT.text).toContain('SOURCE AND LANGUAGE');
    // 前一页完整讲稿注入：用于衔接过渡与去重，不是本页要复述的素材。
    expect(NARRATION_PROMPT.text).toContain('precedingPages 提供前两页讲过的内容');
    expect(NARRATION_PROMPT.text).toContain(
      '前页 Quiz、Interactive、预期结果和 continuation 不代表这个学生已作答',
    );
  });

  it('applies source, output, and safety contracts to specialized scenes', () => {
    expect(QUIZ_PROMPT.version).toBe('quiz/v19-scene-spec-v3');
    expect(QUIZ_PROMPT.text).toContain('pageJob states what is assessed and the learner task');
    expect(QUIZ_PROMPT.text).toContain('assessmentEvidence names the observable answer');
    expect(QUIZ_PROMPT.text).toContain('minimum sufficient question group');
    expect(QUIZ_PROMPT.text).toContain('scoring points');
    expect(QUIZ_PROMPT.text).toContain('partial_credit_examples');
    expect(QUIZ_PROMPT.text).toContain('\\(...\\) for inline formulas');
    expect(QUIZ_PROMPT.text).toContain('put \\[ and \\] on separate standalone lines');
    expect(QUIZ_PROMPT.text).toContain('KaTeX-compatible LaTeX');
    expect(QUIZ_PROMPT.text).toContain(
      'Each decoded formula delimiter contains exactly one backslash',
    );
    expect(QUIZ_PROMPT.text).toContain('encode that backslash as \\\\ in raw JSON');
    expect(QUIZ_PROMPT.text).toContain('decoded doubled delimiter such as \\\\(');
    expect(QUIZ_PROMPT.text).toContain('C0 control characters other than TAB, LF, or CR');
    expect(QUIZ_PROMPT.text).toContain('Unicode escape such as \\u0002 or \\u0008');
    expect(QUIZ_PROMPT.text).toContain('unambiguously correct');
    expect(QUIZ_PROMPT.text).toContain('unique non-empty machine key');
    expect(QUIZ_PROMPT.text).toContain('label is the complete student-visible option content');
    expect(QUIZ_PROMPT.text).toContain('previousQuizSummaries');
    expect(QUIZ_PROMPT.text).toContain('JSON OUTPUT CONTRACT');

    expect(INTERACTIVE_PROMPT.version).toBe('interactive/v39-flat-event-fields');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Design the interaction yourself from the teaching purpose',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'There is no mandatory layout, control, progress indicator',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('Return narration {schemaVersion');
    expect(INTERACTIVE_PROMPT.text).toContain('reach-interactive-scene/v2');
    expect(INTERACTIVE_PROMPT.text).toContain('reach-interactive-event-manifest/v1');
    expect(INTERACTIVE_PROMPT.text).toContain('Declare only meaningful events actually emitted');
    expect(INTERACTIVE_PROMPT.text).toContain('ReachInteractive.learningEvent(name, payload)');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'ReachInteractive.learningEvent("record_replayed", { distance_a: 20, distance_b: 30 })',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'The host constructs the transport envelope and attaches eventVersion: 1',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'do not construct or copy that envelope as the second argument',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'A scalar field named name is valid when the manifest declares it',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'match the manifest spelling and letter case exactly',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('Raw interaction(payload) is not part of v2');
    expect(INTERACTIVE_PROMPT.text).toContain('Do not report numeric module progress');
    expect(INTERACTIVE_PROMPT.text).toContain('Do not use fetch');
    expect(INTERACTIVE_PROMPT.text).toContain('reach-interactive-bridge/v1');
    expect(INTERACTIVE_PROMPT.text).toContain('runtimeDependencies as an array');
    expect(INTERACTIVE_PROMPT.text).toContain('reach-science-kit-change');
    expect(INTERACTIVE_PROMPT.text).toContain('carbonNeighborCount');
    expect(INTERACTIVE_PROMPT.text).toContain('window.ReachScienceKits');
    expect(INTERACTIVE_PROMPT.text).toContain('assign the boolean return from setState');
    expect(INTERACTIVE_PROMPT.text).toContain('"id": "animate-css", "version": "4.1.1"');
    expect(INTERACTIVE_PROMPT.text).toContain('window.ReachExpression.evaluate');
    expect(INTERACTIVE_PROMPT.text).toContain('data-reach-component-id');
    expect(INTERACTIVE_PROMPT.text).toContain('Do not send ready({ empty: true })');
    expect(INTERACTIVE_PROMPT.text).toContain('Use completionMode none for ordinary exploration');
    expect(INTERACTIVE_PROMPT.text).toContain('Freely choose reflow, folding, scaling, panning');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Preserve learner state through resize and orientation changes',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('reach-function-plot/v2');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Always include parameters, markers, and intersections as arrays, using [] when empty',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Each of zero to six parameters contains exactly id, label, minimum, maximum, step, and initial',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Never substitute min, max, value, default, name, unit, or any extra field',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('"minimum":-2');
    expect(INTERACTIVE_PROMPT.text).toContain('ReachFunctionPlot.mount(targetElement, config)');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'When using this bundled capability, do not replace its parser',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('Pointer Events');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Safe custom Canvas/SVG computation remains an equally valid choice',
    );
    expect(INTERACTIVE_PROMPT.text).not.toContain(
      'Prefer a registered typed scientific capability',
    );
    expect(INTERACTIVE_PROMPT.text).not.toContain(
      'when every specialized entry lacks a semantic operation',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('Use comfortably spaced touch targets');
    expect(INTERACTIVE_PROMPT.text).toContain('reach-interactive-initialize');
    expect(INTERACTIVE_PROMPT.text).toContain('ReachInteractive.getInitialization()');
    expect(INTERACTIVE_PROMPT.text).toContain('never send restoreToken as null');
    expect(INTERACTIVE_PROMPT.text).toContain('ReachInteractive.stateChange(snapshot)');
    expect(INTERACTIVE_PROMPT.text).toContain('reach-interactive-resize');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'read event.detail { width, height } to reflow size-dependent surfaces',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'update Canvas/SVG geometry, coordinate transforms and hit testing',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('There are no mandatory panel ratios');
    expect(INTERACTIVE_PROMPT.text).toContain('maximumDurationSeconds to null');
    expect(INTERACTIVE_PROMPT.text).toContain('runtimePolicy.allowReset to true');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Host limits are execution protection, not an imposed teaching timer',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('Every inline script must be syntactically valid');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Always use braces around if, else, for, while, and do',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'never return a patch or an isolated script fragment',
    );
  });

  it('defines optional pinned Tailwind authoring, responsive motion, and bounded sizing contracts', () => {
    expect(INTERACTIVE_PROMPT.version).toBe('interactive/v39-flat-event-fields');
    expect(INTERACTIVE_PROMPT.text).toContain('Tailwind is optional');
    expect(INTERACTIVE_PROMPT.text).toContain('Plain CSS, existing pages without Tailwind');
    expect(INTERACTIVE_PROMPT.text).toContain('never infer Tailwind intent from class-name syntax');
    expect(INTERACTIVE_PROMPT.text).toContain('<html data-reach-tailwind-runtime="4.3.0">');
    expect(INTERACTIVE_PROMPT.text).toContain('{ "id": "tailwind-browser", "version": "4.3.0" }');
    expect(INTERACTIVE_PROMPT.text).toContain('must either both be absent or form that exact pair');
    expect(INTERACTIVE_PROMPT.text).toMatch(
      /Never emit only one, a wrong version, a duplicate[\s\S]*marker on a nested element or body/,
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'existing host-served, pinned, offline Tailwind browser runtime',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'The host injects only the requested pinned runtimes',
    );
    expect(INTERACTIVE_PROMPT.text).not.toContain('inlines only the requested pinned bytes');
    expect(INTERACTIVE_PROMPT.text).toMatch(
      /Never add a CDN, package URL, external stylesheet, script source, or second Tailwind runtime path/,
    );
    expect(INTERACTIVE_PROMPT.text).toContain('Do not write tailwind.config');
    expect(INTERACTIVE_PROMPT.text).toMatch(
      /Do not author Tailwind config or plugins, @config, @plugin, @import, @reference/,
    );
    expect(INTERACTIVE_PROMPT.text).toContain('arbitrary utilities containing url(...)');
    expect(INTERACTIVE_PROMPT.text).toContain('responsive rearrangement or shrinkability');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'clear visible focus, hover, active, and selected feedback',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('Tailwind preflight and cascade layers apply');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'never define the same property on the same element in both an unlayered author rule and a utility',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('stable initial geometry and bounded keyframes');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'learner-driven state change or conceptual relationship',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      '@media (prefers-reduced-motion: reduce) alternative',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('animation must never be the only feedback');
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Required controls and content must remain usable before Tailwind compilation completes',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('reach-interactive-resize');
    expect(INTERACTIVE_PROMPT.text).toContain('pause expensive motion while suspended');
  });

  it('keeps Tailwind correction within the existing single protected repair response', () => {
    expect(INTERACTIVE_PROMPT.text).toContain(
      'The host allows one correction response, not an iterative retry loop',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Tailwind declaration error, invalid inline JavaScript, or both',
    );
    expect(INTERACTIVE_PROMPT.text).toMatch(
      /Preserve id, title, narration[\s\S]*every non-Tailwind dependency[\s\S]*class values, CSS[\s\S]*every valid script/,
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'Change only the diagnosed Tailwind marker and dependency plus the initially diagnosed invalid executable script bodies',
    );
    expect(INTERACTIVE_PROMPT.text).toContain(
      'restore the exact marker/dependency pair instead of deleting both',
    );
    expect(INTERACTIVE_PROMPT.text).toContain('reach-interactive-bridge/v1');
    expect(INTERACTIVE_PROMPT.text).toContain('reach-interactive-event-manifest/v1');
    expect(INTERACTIVE_PROMPT.text).toContain('data-reach-component-id');
    expect(INTERACTIVE_PROMPT.text).toContain('maximumDurationSeconds to null');
  });

  it('按开放 approach hints 组合已知软建议，未知 hint 不构成封闭枚举', () => {
    const guidance = composeInteractiveApproachGuidance([
      'parameter-manipulation',
      'strategy challenge',
      'a completely new kinetic metaphor',
    ]);
    expect(guidance).toContain('COMPOSABLE APPROACH GUIDANCE');
    expect(guidance).toContain('conceptually meaningful variables');
    expect(guidance).toContain('update consequences immediately');
    expect(guidance).toContain('only when learnerAction or assessmentEvidence explicitly requests');
    expect(guidance).not.toContain('invite a prediction before revealing the outcome');
    expect(guidance).toContain('concept drive the rules');
    expect(guidance).toContain('action-consequence-retry loop');
    expect(guidance).not.toContain('kinetic metaphor');
    expect(composeInteractiveApproachGuidance(['unrecognized creative direction'])).toBe('');
    expect(
      composeInteractiveApproachGuidance(['simulation-free explanation', 'game theory model']),
    ).toBe('');
  });
});
