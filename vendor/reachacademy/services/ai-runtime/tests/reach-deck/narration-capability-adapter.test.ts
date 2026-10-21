import { describe, expect, it } from 'vitest';
import {
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  applyPageInstructionalSpec,
  getPageInstructionalSpec,
  type PageOutline,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
} from '@reachany/reach-deck-dsl/reference-library';
import { extractNarrationCandidateMarkdown } from '../../lib/reach-deck/model-service-client.js';
import {
  buildNarrationCapabilityContext,
  buildNarrationRevealManifest,
  compileNaturalNarration,
  splitNaturalNarrationCues,
  validateNarrationLessonContext,
} from '../../lib/reach-deck/narration-capability-adapter.js';

const elements = [
  { id: 'title', type: 'text', text: '牛顿第一定律', variant: 'title' },
  { id: 'body', type: 'text', text: '无外力时保持静止或匀速直线运动。', revealGroupId: 'body' },
  { id: 'diagram', type: 'image', text: '理想实验示意图', revealGroupId: 'diagram' },
  { id: 'decoration', type: 'shape', text: 'Unlabelled visual grouping shape' },
];
const manifest = buildNarrationRevealManifest(elements, new Set(elements.map(({ id }) => id)));
const envelope = (narrationMarkdown: string) => ({
  narrationMarkdown,
  revealBindings: [],
  scientificBindings: [],
});

describe('natural narration adapter', () => {
  it('reveals ungrouped Native elements alone and explicit card members together', () => {
    const cardElements = [
      { id: 'background', type: 'shape', revealGroupId: 'card' },
      { id: 'content', type: 'text', text: '内容', revealGroupId: 'card' },
      { id: 'ungrouped', type: 'text', text: '常驻内容' },
      { id: 'figure', type: 'image', revealGroupId: 'figure', decorative: true },
    ];
    const cardManifest = buildNarrationRevealManifest(
      cardElements,
      new Set(cardElements.map(({ id }) => id)),
    );
    expect(cardManifest.groups).toMatchObject([
      { groupId: 'card', elementIds: ['background', 'content'], classification: 'required' },
      { groupId: 'ungrouped', elementIds: ['ungrouped'], classification: 'required' },
      { groupId: 'figure', classification: 'persistent', allowedEffects: [] },
    ]);
    const result = compileNaturalNarration(
      {
        ...envelope('解释内容。'),
        revealBindings: [{ revealGroupId: 'card', anchorText: '内容' }],
      },
      cardManifest,
    );
    expect(result.revealRanges[0]?.revealElementIds).toEqual(['background', 'content']);
    const restricted = buildNarrationRevealManifest(cardElements, new Set(['content']));
    expect(restricted.groups[0]?.classification).toBe('persistent');
  });

  it('lets a card surface follow every explicit sub-group inside it', () => {
    const elements = [
      {
        id: 'surface',
        type: 'image',
        text: '卡片底图',
        revealCompanionGroupIds: ['step-1', 'step-2'],
      },
      { id: 'label', type: 'text', text: '方法', revealCompanionGroupIds: ['step-1', 'step-2'] },
      { id: 'step-1-text', type: 'text', text: '第一步', revealGroupId: 'step-1' },
      { id: 'step-2-text', type: 'text', text: '第二步', revealGroupId: 'step-2' },
    ];
    const manifest = buildNarrationRevealManifest(elements, new Set(elements.map(({ id }) => id)));
    expect(manifest.groups).toMatchObject([
      {
        groupId: 'step-1',
        elementIds: ['step-1-text', 'surface', 'label'],
        classification: 'required',
      },
      {
        groupId: 'step-2',
        elementIds: ['step-2-text', 'surface', 'label'],
        classification: 'required',
      },
    ]);
    expect(() =>
      buildNarrationRevealManifest(
        [{ id: 'orphan', type: 'image', revealGroupId: 'x', revealCompanionGroupIds: ['y'] }],
        new Set(['orphan']),
      ),
    ).toThrow('companions');

    const markdown = '先讲第一步，再讲第二步。';
    // Only step 2 bound: step 1 text stays visible, so its card must stay visible too.
    const partial = compileNaturalNarration(
      {
        revealBindings: [{ revealGroupId: 'step-2', anchorText: '第二步' }],
        scientificBindings: [],
      },
      manifest,
      new Map(),
      markdown,
    );
    expect(partial.revealRanges.map((range) => range.revealElementIds)).toEqual([['step-2-text']]);
    // Step 1 bound, but its anchor matches nothing: its text stays visible, and so must the card.
    const unmatched = compileNaturalNarration(
      {
        revealBindings: [
          { revealGroupId: 'step-1', anchorText: '？？' },
          { revealGroupId: 'step-2', anchorText: '第二步' },
        ],
        scientificBindings: [],
      },
      manifest,
      new Map(),
      markdown,
    );
    expect(unmatched.revealRanges.map((range) => range.revealElementIds)).toEqual([
      ['step-2-text'],
    ]);
    // Both bound: the card enters with each, and the earliest reveal claims it downstream.
    const complete = compileNaturalNarration(
      {
        revealBindings: [
          { revealGroupId: 'step-1', anchorText: '第一步' },
          { revealGroupId: 'step-2', anchorText: '第二步' },
        ],
        scientificBindings: [],
      },
      manifest,
      new Map(),
      markdown,
    );
    expect(complete.revealRanges.map((range) => range.revealElementIds)).toEqual([
      ['step-1-text', 'surface', 'label'],
      ['step-2-text', 'surface', 'label'],
    ]);
  });

  it('keeps a group containing a title persistent and rejects ambiguous identities', () => {
    const members = [
      { id: 'title', type: 'text', variant: 'title', revealGroupId: 'card' },
      { id: 'body', type: 'text', revealGroupId: 'card' },
    ];
    expect(
      buildNarrationRevealManifest(members, new Set(['title', 'body'])).groups[0],
    ).toMatchObject({ classification: 'persistent', allowedEffects: [] });
    expect(() => buildNarrationRevealManifest([members[0]!, members[0]!], new Set())).toThrow(
      'must be unique',
    );
    expect(() =>
      buildNarrationRevealManifest([{ id: 'card', type: 'shape' }, members[1]!], new Set()),
    ).toThrow('must not collide');
  });

  it('rejects old cues in both generated and saved model envelopes', () => {
    const cues = [{ segments: [{ script: '自然讲解。' }] }];
    expect(() => compileNaturalNarration({ cues }, manifest)).toThrow('narrationMarkdown');
    expect(() => compileNaturalNarration({ ...envelope('自然讲解。'), cues }, manifest)).toThrow(
      'unsupported envelope fields',
    );
    expect(() =>
      compileNaturalNarration(
        { revealBindings: [], scientificBindings: [], cues },
        manifest,
        new Map(),
        '保存原文。',
      ),
    ).toThrow('unsupported envelope fields');
  });

  it('drops model-added punctuation escapes outside formulas before canonicalization', () => {
    // `\=` / `\.` are not narration-dialect escapes; before stripping they failed the parser.
    expect(
      compileNaturalNarration(
        envelope(String.raw`满足 y\=2x\+1 的点\. 即 \(y\=2x\+1\)。`),
        manifest,
      ).markdown,
    ).toBe(String.raw`满足 y=2x\+1 的点. 即 \(y\=2x\+1\)。`);
    // The dialect itself canonically spells a prose `+` as `\+`, escaped by the model or not.
    expect(
      compileNaturalNarration(envelope(String.raw`满足 y=2x\+1 的点`), manifest).markdown,
    ).toBe(compileNaturalNarration(envelope('满足 y=2x+1 的点'), manifest).markdown);
  });

  it.each([
    ['exploration', 'question_without_answer'],
    ['attempt', 'question_without_answer'],
    ['reveal', 'resolve_prior_question'],
    ['develop', 'explain_current_idea'],
    ['worked_example', 'demonstrate_reasoning'],
    ['transfer', 'transfer_learning'],
    ['close', 'close_briefly'],
  ])('maps v3 %s responsibility independently of stale cycle fields', (role, mode) => {
    const base: any = {
      id: 'p',
      order: 1,
      sceneType: 'slide',
      title: '页面',
      microCycleStages: ['explain_reveal'],
      instructionalSpec: {
        schemaVersion: 'reach-deck-instructional-spec/v3',
        pageRole: role,
        pageJob: '当前职责',
        keyPoints: [],
      },
    };
    const context = buildNarrationCapabilityContext({
      page: base,
      pageTitle: '页面',
      elements,
      revealGroupManifest: manifest,
    });
    expect(context.context.currentPage.deliveryPolicy.mode).toBe(mode);
  });
  it('preserves mixed legacy reveal precedence and does not restore a cleared role', () => {
    const base: PageOutline = {
      id: 'p',
      order: 1,
      sceneType: 'slide',
      title: '页面',
      pageRole: 'develop',
      microCycleStages: ['attempt_predict', 'explain_reveal'],
    };
    const migrated = applyPageInstructionalSpec(base, getPageInstructionalSpec(base));
    const context = buildNarrationCapabilityContext({
      page: migrated,
      pageTitle: '页面',
      elements,
      revealGroupManifest: manifest,
    });
    expect(context.context.currentPage.deliveryPolicy.mode).toBe('resolve_prior_question');
    const cleared = applyPageInstructionalSpec(migrated, {
      ...getPageInstructionalSpec(migrated),
      pageRole: undefined,
      pageJob: '',
      keyPoints: [],
    });
    const after = buildNarrationCapabilityContext({
      page: { ...cleared, microCycleStages: ['attempt_predict'] },
      pageTitle: '页面',
      elements,
      revealGroupManifest: manifest,
    });
    expect(after.context.currentPage.deliveryPolicy.mode).toBe('explain_current_idea');
  });
  it('accepts whole natural prose with no mandatory element coverage', () => {
    const markdown = '先回到刚才的现象。我们今天要解释的，是物体为什么能保持运动。';
    const result = compileNaturalNarration(envelope(markdown), manifest);
    expect(result.markdown).toBe(markdown);
    expect(result.cues.map(({ text }) => text).join('')).toBe(markdown);
    expect(result.revealRanges).toEqual([]);
  });

  it('supports shared phrases and visual order independent from the manifest', () => {
    const value = envelope('先观察运动。接下来一起解释图中的关系。');
    const result = compileNaturalNarration(
      {
        ...value,
        revealBindings: [
          { revealGroupId: 'diagram', anchorText: '一起解释', effect: 'fade' },
          { revealGroupId: 'body', anchorText: '一起解释', effect: null },
        ],
      },
      manifest,
    );
    const anchorStart = value.narrationMarkdown.indexOf('一起解释');
    expect(result.revealRanges.map(({ start }) => start)).toEqual([anchorStart, anchorStart]);
    expect(result.markdown).toBe(value.narrationMarkdown);
  });

  it('uses approximate phrases without changing narration and preserves formula boundaries', () => {
    const markdown = '先观察现象。关系是 \\(F=ma\\)，现在解释公式。';
    const result = compileNaturalNarration(
      {
        ...envelope(markdown),
        revealBindings: [{ revealGroupId: 'diagram', anchorText: '解释这个公式', effect: null }],
        scientificBindings: [
          { scientificAnchorId: 'first', anchorText: '解释公式' },
          { scientificAnchorId: 'second', anchorText: '先观察现象' },
        ],
      },
      manifest,
      new Map([
        ['first', 'diagram'],
        ['second', 'diagram'],
      ]),
    );
    expect(result.markdown).toBe(markdown);
    expect(result.revealRanges[0]).toMatchObject({ start: 6, end: markdown.length });
    const start = markdown.indexOf('解释公式');
    expect(result.scientificAnchorRanges?.[0]).toMatchObject({ start, end: start + 4 });
    expect(result.scientificAnchorRanges?.[1]).toMatchObject({ start, end: start + 4 });
  });

  it('preserves teacher-saved Markdown verbatim, including whitespace and complete formulas', () => {
    const markdown = '  教师原文。\n\n关系为 \\(a < b\\)。  ';
    const result = compileNaturalNarration(
      { revealBindings: [], scientificBindings: [] },
      manifest,
      new Map(),
      markdown,
    );
    expect(result.markdown).toBe(markdown);
    expect(result.cues.map(({ text }) => text).join('')).toBe(markdown);
    expect(() => compileNaturalNarration(envelope('改写'), manifest, new Map(), markdown)).toThrow(
      'must not contain narrationMarkdown',
    );
  });

  it('retains production narration guardrails', () => {
    expect(() =>
      compileNaturalNarration(envelope('作为AI，我会先分析页面再生成讲稿。'), manifest),
    ).toThrow('internal planning');
  });

  it('retains natural prose for the existing manual-review recovery path', () => {
    const markdown = '教师完整讲解。';
    expect(
      extractNarrationCandidateMarkdown({ ...envelope(markdown), revealBindings: 'invalid' }),
    ).toBe(markdown);
    expect(extractNarrationCandidateMarkdown(envelope('  '))).toBeUndefined();
    expect(extractNarrationCandidateMarkdown(envelope('字'.repeat(10_001)))).toBeUndefined();
  });

  it.each(['missing', 'title'])('rejects undeclared or persistent binding %s', (id) => {
    expect(() =>
      compileNaturalNarration(
        {
          ...envelope('自然讲解。'),
          revealBindings: [{ revealGroupId: id, anchorText: '讲解', effect: null }],
        },
        manifest,
      ),
    ).toThrow('unknown, persistent or duplicated');
  });

  it('requires declared scientific identities without adding prose', () => {
    expect(() =>
      compileNaturalNarration(envelope('自然讲解。'), manifest, new Map([['a', 'diagram']])),
    ).toThrow('every declared scientific anchor');
  });

  it.each(['XYZ', '。'])(
    'does not invent first-sentence timing for unmatched anchor %s',
    (anchorText) => {
      const markdown = '先观察运动。接下来解释公式。';
      const value = {
        ...envelope(markdown),
        revealBindings: [{ revealGroupId: 'diagram', anchorText, effect: null }],
      };
      const result = compileNaturalNarration(value, manifest);
      expect(result.markdown).toBe(markdown);
      expect(result.revealRanges).toEqual([]);
      expect(() =>
        compileNaturalNarration(
          { ...value, scientificBindings: [{ scientificAnchorId: 'state', anchorText }] },
          manifest,
          new Map([['state', 'diagram']]),
        ),
      ).toThrow('no matching spoken context');
    },
  );

  it('keeps Unicode and formulas whole while bounding server cue count', () => {
    const markdown = `${'观察现象。'.repeat(15)}完整公式 \\(x=1.2+y\\)。观察 \u{1F9EA}。`;
    const cues = splitNaturalNarrationCues(markdown);
    expect(cues.length).toBeLessThanOrEqual(8);
    expect(cues.map(({ text }) => text).join('')).toBe(markdown);
    expect(cues.some(({ text }) => text.includes('\\(x=1.2+y\\)'))).toBe(true);
  });

  it('does not split decimal, version or abbreviation dots', () => {
    const markdown = 'Use 3.14 with v2.0, e.g. a circle. Dr. Li explains it! 下一句。';
    expect(splitNaturalNarrationCues(markdown).map(({ text }) => text)).toEqual([
      'Use 3.14 with v2.0, e.g. a circle. ',
      'Dr. Li explains it! ',
      '下一句。',
    ]);
  });

  it('keeps closing quotes, brackets and stacked marks with the sentence they end', () => {
    const markdown = '他说：“这是对的。”接着看图（见图一。）真的吗？！当然……。结论成立。';
    expect(splitNaturalNarrationCues(markdown).map(({ text }) => text)).toEqual([
      '他说：“这是对的。”',
      '接着看图（见图一。）',
      '真的吗？！',
      '当然……。',
      '结论成立。',
    ]);
  });

  it('does not split a quoted sentence that the outer sentence continues after', () => {
    const markdown =
      '主标题问“为什么要先建立学习路径？”，副标题也提示了路线：九讲学习地图。下一句。';
    expect(splitNaturalNarrationCues(markdown).map(({ text }) => text)).toEqual([
      '主标题问“为什么要先建立学习路径？”，副标题也提示了路线：九讲学习地图。',
      '下一句。',
    ]);
  });

  it('does not swallow an opening quote that starts the next line', () => {
    const markdown = '第一段结束\n"引号开头的下一段。"';
    expect(splitNaturalNarrationCues(markdown).map(({ text }) => text)).toEqual([
      '第一段结束\n',
      '"引号开头的下一段。"',
    ]);
  });

  it('preserves newlines, break tags and multiline formulas without splitting their contents', () => {
    const formula = '\\[x=3.14\n+y\\]';
    const breakTag = '<break\n time="0.5s"/>';
    const markdown = `第一行\r\n第二行。${formula}\nObserve ${breakTag} now? 继续！`;
    const cues = splitNaturalNarrationCues(markdown);
    expect(cues.map(({ text }) => text).join('')).toBe(markdown);
    expect(cues.some(({ text }) => text.includes(formula))).toBe(true);
    expect(cues.some(({ text }) => text.includes(breakTag))).toBe(true);
    expect(cues[0]?.text).toBe('第一行\r\n');
    expect(cues.at(-1)?.text).toBe('继续！');
  });

  it('passes page responsibility intact even when a final-page title requests an introduction', () => {
    const page: PageOutline = {
      id: 'p1',
      title: '再讲一次全部定义',
      order: 3,
      sceneType: 'slide',
      pageRole: 'transfer',
      pageFunctions: ['transfer'],
      instructionalSpec: {
        learningObjective: '迁移速度概念',
        teachingMove: 'transfer',
        keyPoints: ['速度'],
        visualDirection: '呈现迁移情境',
        density: 'low',
        visualAssets: [],
      },
    };
    const context = buildNarrationCapabilityContext({
      page,
      pageTitle: page.title,
      elements,
      revealGroupManifest: manifest,
      lessonContext: { courseTitle: '运动', pageIndex: 2, totalPages: 3, currentPage: page },
    });
    expect(context.context.currentPage.pageRole).toBe('transfer');
    expect(context.context.currentPage.pageFunctions).toEqual(['transfer']);
    expect(context.context.currentPage.deliveryPolicy.mode).toBe('transfer_learning');
    expect(context.context.pagePosition).toBe('last');
    expect(context.systemPrompt).toContain('页面职责');
  });

  it('keeps optional context backward compatible and rejects invalid page positions', () => {
    expect(() => validateNarrationLessonContext(undefined)).not.toThrow();
    expect(() =>
      validateNarrationLessonContext({ courseTitle: '课', pageIndex: 2, totalPages: 2 }),
    ).toThrow('page position');
  });

  it('accepts a bounded course page map and rejects malformed entries', () => {
    const base = { courseTitle: '课', pageIndex: 1, totalPages: 3 };
    const coursePageMap = [
      { title: '封面', sceneType: 'slide', pageRole: 'title', pageJob: '引入主题' },
      { title: '观察', sceneType: 'interactive', pageRole: 'exploration', current: true },
      { title: '小测', sceneType: 'quiz' },
    ];
    expect(() => validateNarrationLessonContext({ ...base, coursePageMap })).not.toThrow();
    for (const invalid of [
      [...coursePageMap, { title: '多余', sceneType: 'slide' }],
      coursePageMap.map((entry) => ({ ...entry, current: true })),
      [{ title: '封面', sceneType: 'video' }],
      [{ title: '封面', sceneType: 'slide', pageJob: '长'.repeat(161) }],
      [{ title: '封面', sceneType: 'slide', extra: 'field' }],
    ]) {
      expect(() => validateNarrationLessonContext({ ...base, coursePageMap: invalid })).toThrow(
        'course page map',
      );
    }
  });

  it.each(['currentPage', 'nextPage', 'precedingPages'] as const)(
    'validates %s against the trusted reference design context',
    (field) => {
      const designContext = {
        schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
        libraryVersion: REFERENCE_LIBRARY_VERSION,
        librarySha256: REFERENCE_LIBRARY_SHA256,
        paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
        originalDesign: false,
        typographyProfile: 'general' as const,
        imageStyleReferenceIds: [],
        visualIntent: 'Clear relationships',
        resolvedColors: {
          background: '#FFFFFF',
          surface: '#FFFFFF',
          ink: '#111111',
          muted: '#555555',
          accent: '#006699',
          success: '#006600',
          warning: '#663300',
        },
      };
      const page: PageOutline = {
        id: 'p1',
        order: 1,
        sceneType: 'slide',
        title: 'Comparison',
        instructionalSpec: {
          learningObjective: 'Compare',
          teachingMove: 'explain',
          keyPoints: ['Compare'],
          focusStatement: 'Compare the lines',
          supportingDetails: [],
          visualDirection: 'Comparison',
          density: 'low',
          visualAssets: Array.from({ length: 4 }, () => ({
            kind: 'image',
            purpose: 'Compare',
            prompt: 'Draw lines',
            alt: 'Lines',
            aspectRatio: '16:9',
            placement: 'supporting',
          })),
        },
      };
      const context = {
        courseTitle: 'Lines',
        pageIndex: 0,
        totalPages: 2,
        [field]: field === 'precedingPages' ? [page] : page,
      };
      expect(() => validateNarrationLessonContext(context, 'p1')).toThrow();
      expect(() => validateNarrationLessonContext(context, 'p1', designContext)).not.toThrow();
    },
  );
});
