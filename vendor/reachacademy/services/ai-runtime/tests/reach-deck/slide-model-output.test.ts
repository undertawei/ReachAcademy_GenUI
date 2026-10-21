import { describe, expect, it } from 'vitest';
import { parseDeckSlideValue, richTextToPlainText, type DeckSlide } from '@reachany/reach-deck-dsl';
import {
  buildDeckSlideSchema,
  DECK_SLIDE_SCHEMA,
} from '../../lib/reach-deck/model-service-schemas.js';
import {
  attachNarrationSegmentsToSlide,
  narrationFromSlide,
  normalizeSlideModelOutput,
  slideToModelOutput,
  type NarrationStageSegment,
} from '../../lib/reach-deck/slide-model-output.js';
import { GeneratedMarkdownFormulaError } from '../../lib/reach-deck/model-markdown.js';

const modelSlide = (overrides: Record<string, unknown> = {}) => ({
  id: 'page-1',
  title: '闭环生态系统',
  layout: 'freeform',
  duration: 8,
  background: '#ffffff',
  elements: [
    {
      id: 'title',
      type: 'text',
      frame: { x: 80, y: 64, width: 1440, height: 112 },
      layer: 1,
      markdown: '一个清晰的结论',
      variant: 'title',
    },
  ],
  ...overrides,
});

/** 落库形态的 slide + narration 阶段段落 → 挂好讲稿的 slide。 */
const narratedSlide = (segments: NarrationStageSegment[], duration = 8): DeckSlide => {
  const { slide } = normalizeSlideModelOutput(modelSlide({ duration }));
  return attachNarrationSegmentsToSlide(parseDeckSlideValue(slide), segments);
};

describe('模型输出 → v1 DeckSlide', () => {
  it('text.markdown 经受限子集解析成 doc，并落库为合法 slide', () => {
    const { slide, diagnostics } = normalizeSlideModelOutput(
      modelSlide({
        elements: [
          {
            id: 'body',
            type: 'text',
            frame: { x: 80, y: 208, width: 1440, height: 520 },
            layer: 2,
            markdown: '**空气**与水彼此联动',
            variant: 'body',
            colorToken: 'accent',
          },
        ],
      }),
    );

    expect(diagnostics).toEqual([]);
    const parsed = parseDeckSlideValue(slide);
    const element = parsed.elements[0];
    if (element.type !== 'text') throw new Error('fixture element must be text');
    expect(element).not.toHaveProperty('markdown');
    expect(richTextToPlainText(element.doc)).toBe('空气与水彼此联动');
    expect(element.colorToken).toBe('accent');
  });

  it('canonicalizes paired doubled delimiters in generated slide text', () => {
    const { slide } = normalizeSlideModelOutput(
      modelSlide({
        elements: [
          {
            id: 'formula',
            type: 'text',
            frame: { x: 80, y: 208, width: 1440, height: 520 },
            layer: 2,
            markdown: String.raw`化简 \\(\sqrt{x^2}\\)`,
            variant: 'body',
          },
        ],
      }),
    );

    const element = parseDeckSlideValue(slide).elements[0];
    if (element.type !== 'text') throw new Error('fixture element must be text');
    expect(element.doc.content?.[0]?.content).toEqual([
      { type: 'text', text: '化简 ' },
      { type: 'inlineMath', attrs: { latex: String.raw`\sqrt{x^2}` } },
    ]);
  });

  it('preserves LaTeX row spacing in a generated slide display formula', () => {
    const markdown = String.raw`\[
\begin{aligned}
a &= b \\[2ex]
c &= d
\end{aligned}
\]`;
    const { slide } = normalizeSlideModelOutput(
      modelSlide({
        elements: [
          {
            id: 'formula',
            type: 'text',
            frame: { x: 80, y: 208, width: 1440, height: 520 },
            layer: 2,
            markdown,
            variant: 'body',
          },
        ],
      }),
    );

    const element = parseDeckSlideValue(slide).elements[0];
    if (element.type !== 'text') throw new Error('fixture element must be text');
    expect(JSON.stringify(element.doc)).toContain(String.raw`\\[2ex]`);
  });

  it.each([
    ['decoded control', `线段 \u00028AB=DE`],
    ['literal control escape', String.raw`线段 \u00028AB=DE`],
    ['broken delimiter', String.raw`线段 \u0008(x+1)`],
    ['unclosed formula', String.raw`线段 \(AB=DE`],
  ])('rejects fresh slide text containing %s', (_label, markdown) => {
    expect(() =>
      normalizeSlideModelOutput(
        modelSlide({
          elements: [
            {
              id: 'formula',
              type: 'text',
              frame: { x: 80, y: 208, width: 1440, height: 520 },
              layer: 2,
              markdown,
              variant: 'body',
            },
          ],
        }),
      ),
    ).toThrow(GeneratedMarkdownFormulaError);
  });

  it('keeps legal dollar math, currency, ordinary backslashes, and Unicode slide text', () => {
    const { slide } = normalizeSlideModelOutput(
      modelSlide({
        elements: [
          {
            id: 'formula',
            type: 'text',
            frame: { x: 80, y: 208, width: 1440, height: 240 },
            layer: 2,
            markdown: '面积为 $x^2$，字符 π🙂',
            variant: 'body',
          },
          {
            id: 'literal',
            type: 'text',
            frame: { x: 80, y: 480, width: 1440, height: 240 },
            layer: 3,
            markdown: String.raw`价格为 $9，路径 C:\notes\第一章`,
            variant: 'body',
          },
        ],
      }),
    );
    const elements = parseDeckSlideValue(slide).elements;
    expect(JSON.stringify(elements[0])).toContain('inlineMath');
    expect(
      richTextToPlainText(
        (elements[1] as Extract<DeckSlide['elements'][number], { type: 'text' }>).doc,
      ),
    ).toBe(String.raw`价格为 $9，路径 C:\notes\第一章`);
  });

  it('子集之外的 markdown 标记只记诊断，不失败', () => {
    const { slide, diagnostics } = normalizeSlideModelOutput(
      modelSlide({
        elements: [
          {
            id: 'body',
            type: 'text',
            frame: { x: 80, y: 208, width: 1440, height: 520 },
            layer: 2,
            markdown: '# 大标题\n参见[文档](https://example.test)',
            variant: 'body',
          },
        ],
      }),
    );

    expect(diagnostics).toEqual([
      '元素 body：已忽略 markdown 标题标记（#），标题文字按普通段落保留。',
      '元素 body：已忽略 markdown 链接，仅保留链接文字。',
    ]);
    const parsed = parseDeckSlideValue(slide);
    const element = parsed.elements[0];
    if (element.type !== 'text') throw new Error('fixture element must be text');
    // 标记被剥掉，可见文字全部保留。
    expect(richTextToPlainText(element.doc)).toContain('大标题');
    expect(richTextToPlainText(element.doc)).toContain('参见文档');
  });

  it('colorToken 为 null 时不落库该字段', () => {
    const { slide } = normalizeSlideModelOutput(
      modelSlide({
        elements: [
          {
            id: 'body',
            type: 'text',
            frame: { x: 80, y: 208, width: 1440, height: 520 },
            layer: 2,
            markdown: '正文',
            variant: 'body',
            colorToken: null,
          },
        ],
      }),
    );

    expect(parseDeckSlideValue(slide).elements[0]).not.toHaveProperty('colorToken');
  });

  it('slide 阶段模型输出不再携带讲稿：voiceTimeline 先落空数组', () => {
    const { slide } = normalizeSlideModelOutput(modelSlide());
    expect(parseDeckSlideValue(slide).voiceTimeline).toEqual([]);
  });

  it('残留的 narration 键被防御性剥除，不以未知字段落库', () => {
    const { slide } = normalizeSlideModelOutput(
      modelSlide({ narration: [{ text: '不该出现的讲稿。' }] }),
    );
    expect(slide).not.toHaveProperty('narration');
    expect(parseDeckSlideValue(slide).voiceTimeline).toEqual([]);
  });

  it('shape/line 保持受限字段，line frame 仅由端点在解析时派生', () => {
    const { slide } = normalizeSlideModelOutput(
      modelSlide({
        elements: [
          {
            id: 'panel',
            type: 'shape',
            frame: { x: 80, y: 220, width: 440, height: 420 },
            layer: 1,
            shape: 'roundRect',
            fillToken: 'accentSoft',
            strokeToken: null,
          },
          {
            id: 'arrow',
            type: 'line',
            start: { x: 520, y: 430 },
            end: { x: 620, y: 430 },
            layer: 2,
            role: 'arrow',
            colorToken: 'accent',
          },
        ],
      }),
    );
    const parsed = parseDeckSlideValue(slide);
    expect(parsed.elements[0]).not.toHaveProperty('strokeToken');
    expect(parsed.elements[1]).toMatchObject({
      type: 'line',
      frame: { x: 520, y: 430, width: 100, height: 1 },
    });
    const restored = slideToModelOutput(parsed);
    expect((restored.elements as Record<string, unknown>[])[1]).not.toHaveProperty('frame');
  });

  it.each([
    ['unknown shape fill', { fillToken: 'neon' }],
    ['arbitrary shape styling', { shadow: { blur: 12 } }],
  ])('拒绝 %s', (_label, patch) => {
    const { slide } = normalizeSlideModelOutput(
      modelSlide({
        elements: [
          {
            id: 'panel',
            type: 'shape',
            frame: { x: 80, y: 220, width: 440, height: 420 },
            layer: 1,
            shape: 'roundRect',
            fillToken: 'accentSoft',
            ...patch,
          },
        ],
      }),
    );
    expect(() => parseDeckSlideValue(slide)).toThrow();
  });

  it('拒绝未知 line role/colorToken 与重合端点', () => {
    const invalidLine = (patch: Record<string, unknown>) =>
      normalizeSlideModelOutput(
        modelSlide({
          elements: [
            {
              id: 'line',
              type: 'line',
              start: { x: 100, y: 100 },
              end: { x: 200, y: 100 },
              layer: 1,
              role: 'divider',
              colorToken: 'muted',
              ...patch,
            },
          ],
        }),
      ).slide;
    expect(() => parseDeckSlideValue(invalidLine({ role: 'bezier' }))).toThrow();
    expect(() => parseDeckSlideValue(invalidLine({ colorToken: '#ff0000' }))).toThrow();
    expect(() => parseDeckSlideValue(invalidLine({ end: { x: 100, y: 100 } }))).toThrow();
  });
});

describe('narration 阶段段落 → voiceTimeline', () => {
  it('段落按顺序落库成 voiceTimeline，并保留 revealElementIds 与 revealEffect', () => {
    const parsed = narratedSlide([
      { text: '先看整体。' },
      { text: '再看细节。', revealElementIds: ['title'], revealEffect: 'zoom' },
    ]);

    expect(parsed.voiceTimeline.map((cue) => [cue.id, cue.text])).toEqual([
      ['narration-1', '先看整体。'],
      ['narration-2', '再看细节。'],
    ]);
    expect(parsed.voiceTimeline[0]).not.toHaveProperty('revealElementIds');
    expect(parsed.voiceTimeline[0]).not.toHaveProperty('revealEffect');
    expect(parsed.voiceTimeline[1].revealElementIds).toEqual(['title']);
    expect(parsed.voiceTimeline[1].revealEffect).toBe('zoom');
    // 秒数是占位值：真实时间戳由 TTS 链路回填，此处只保证有序且 end >= start。
    expect(parsed.voiceTimeline[0].start).toBeLessThan(parsed.voiceTimeline[1].start);
  });

  it('narrationFromSlide 能把落库讲稿还原成 narration 阶段输出形态', () => {
    const parsed = narratedSlide([
      { text: '第一段。', revealElementIds: ['title'], revealEffect: 'rise' },
    ]);

    expect(narrationFromSlide(parsed)).toEqual([
      { text: '第一段。', revealElementIds: ['title'], revealEffect: 'rise' },
    ]);
  });

  it('页时长不足以覆盖讲稿时被放大，保证后段 cue 可达', () => {
    // 播放器到 slide.duration 就停表，时长短于讲稿总长时后面的段落永远不会被命中。
    const parsed = narratedSlide(
      [{ text: '第一段。' }, { text: '第二段。' }, { text: '第三段。' }],
      8,
    );

    const lastCueEnd = Math.max(...parsed.voiceTimeline.map((cue) => cue.end));
    expect(parsed.duration).toBeGreaterThan(lastCueEnd);
    expect(parsed.voiceTimeline.every((cue) => cue.end <= parsed.duration)).toBe(true);
  });

  it('模型给的时长已经够长时保持原值', () => {
    expect(narratedSlide([{ text: '只有一段。' }], 600).duration).toBe(600);
  });

  it('没有讲稿段落时不改动页时长', () => {
    expect(narratedSlide([], 8).duration).toBe(8);
  });

  it('占位段长足以容纳一段常规中文旁白', () => {
    const parsed = narratedSlide([{ text: '第一段。' }, { text: '第二段。' }]);

    const [first, second] = parsed.voiceTimeline;
    // 1 秒窗口会把十几秒的真实 TTS 音频切成一秒；占位值必须留出接近真实旁白的空间。
    expect(first.end - first.start).toBeGreaterThanOrEqual(6);
    expect(second.start).toBe(first.end);
  });

  it('reveal 引用悬空的段落在挂载时立即报错，不静默落库', () => {
    expect(() => narratedSlide([{ text: '第一段。', revealElementIds: ['missing'] }])).toThrow();
  });

  it('slideToModelOutput 把落库 slide 还原成 slide 阶段输出形态（不含讲稿）', () => {
    const restored = slideToModelOutput(narratedSlide([{ text: '第一段。' }]));

    // 回喂给修复阶段的样例必须自身合法：否则模型会照抄出违反 schema 的输出。
    const element = (restored.elements as Record<string, unknown>[])[0];
    expect(element).not.toHaveProperty('doc');
    expect(element.markdown).toBe('一个清晰的结论');
    expect(restored).not.toHaveProperty('voiceTimeline');
    expect(restored).not.toHaveProperty('animations');
    expect(restored).not.toHaveProperty('narration');
  });
});

describe('生成 schema 的受限动态 profile', () => {
  const elementTypes = (
    (DECK_SLIDE_SCHEMA.schema.$defs as Record<string, any>).element.anyOf as Record<string, any>[]
  ).map((variant) => variant.properties.type.const);

  it('无可用媒体时只允许 text / shape / line', () => {
    expect(elementTypes).toEqual(['text', 'shape', 'line']);
  });

  it('有可用图片时只增加 assetId 枚举图片，不暴露 objectKey/src', () => {
    const variants = (
      buildDeckSlideSchema(['asset-a', 'asset-b']).schema.$defs as Record<string, any>
    ).element.anyOf as Record<string, any>[];
    expect(variants.map((variant) => variant.properties.type.const)).toEqual([
      'text',
      'shape',
      'line',
      'image',
    ]);
    const image = variants[3];
    expect(image.properties.assetId.enum).toEqual(['asset-a', 'asset-b']);
    expect(image.properties).not.toHaveProperty('objectKey');
    expect(image.properties).not.toHaveProperty('src');
    expect(image.properties).not.toHaveProperty('alt');
  });

  it.each(['markdown', 'quiz', 'boardWriting', 'aiPrompt'])('拒绝废弃元素 %s', (type) => {
    expect(elementTypes).not.toContain(type);
  });

  it('不再声明 animations / voiceTimeline / interactions / narration：讲稿已拆到独立阶段', () => {
    const properties = DECK_SLIDE_SCHEMA.schema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty('animations');
    expect(properties).not.toHaveProperty('voiceTimeline');
    expect(properties).not.toHaveProperty('interactions');
    expect(properties).not.toHaveProperty('narration');
    expect(DECK_SLIDE_SCHEMA.schema.$defs).not.toHaveProperty('narrationSegment');
  });

  it('text 元素只收 markdown 字符串，且 colorToken 限定五个语义值', () => {
    const text = (
      (DECK_SLIDE_SCHEMA.schema.$defs as Record<string, any>).element.anyOf as Record<string, any>[]
    )[0];
    expect(text.properties).not.toHaveProperty('text');
    expect(text.properties.markdown.type).toBe('string');
    expect(text.properties.colorToken.anyOf[0].enum).toEqual([
      'ink',
      'muted',
      'accent',
      'success',
      'warning',
    ]);
  });

  it('shape/line 只暴露受限 token，line 不暴露 frame 或任意 native 样式', () => {
    const variants = (DECK_SLIDE_SCHEMA.schema.$defs as Record<string, any>).element
      .anyOf as Record<string, any>[];
    const shape = variants[1];
    const line = variants[2];
    expect(shape.properties.shape.enum).toEqual(['rect', 'roundRect']);
    expect(shape.properties.fillToken.enum).toEqual([
      'surface',
      'accentSoft',
      'successSoft',
      'warningSoft',
      'ink',
    ]);
    expect(shape.properties).not.toHaveProperty('fill');
    expect(shape.properties).not.toHaveProperty('effects');
    expect(line.properties).not.toHaveProperty('frame');
    expect(line.properties.role.enum).toEqual(['divider', 'connector', 'arrow']);
    expect(line.properties).not.toHaveProperty('stroke');
    expect(line.additionalProperties).toBe(false);
  });
});
