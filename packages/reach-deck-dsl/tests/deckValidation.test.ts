import { describe, expect, it } from 'vitest';
import { isDeckSlideShape, parseDeckSlideValue } from '../src/deckValidation.js';
import { richTextFromPlainText } from '../src/richText.js';
import type { DeckSlide } from '../src/types.js';
import { scientificVisualElementFixture } from './scientificVisualFixtures.js';

const createSlideFixture = (): DeckSlide => ({
  id: 'slide-1',
  title: 'AI 基础入门',
  layout: 'freeform',
  duration: 8,
  background: '#ffffff',
  elements: [
    {
      id: 'title',
      type: 'text',
      frame: { x: 120, y: 140, width: 900, height: 120 },
      layer: 1,
      doc: richTextFromPlainText('AI 基础入门'),
      variant: 'title',
    },
  ],
  animations: [
    {
      id: 'anim-title',
      type: 'fade',
      targetId: 'title',
      start: 0,
      duration: 1,
      easing: 'easeOut',
    },
  ],
  voiceTimeline: [
    {
      id: 'cue-title',
      label: '开场',
      text: '欢迎进入 AI 基础入门课程。',
      start: 0,
      end: 4,
      revealElementIds: ['title'],
    },
  ],
});

const expectInvalidSlide = (slide: unknown) => {
  expect(isDeckSlideShape(slide)).toBe(false);
  expect(() => parseDeckSlideValue(slide)).toThrow(
    'AI provider returned JSON that is not a Reach Deck slide.',
  );
};

describe('typography profile compatibility', () => {
  it('keeps missing profile as the legacy shape and accepts explicit v16 pages', () => {
    const legacy = parseDeckSlideValue(createSlideFixture());
    const v16 = parseDeckSlideValue({ ...createSlideFixture(), typographyProfile: 'v16' });
    expect(legacy.typographyProfile).toBeUndefined();
    expect(v16.typographyProfile).toBe('v16');
  });

  it('rejects unknown typography profiles', () => {
    expectInvalidSlide({ ...createSlideFixture(), typographyProfile: 'future' });
  });
});

describe('legacy text element upgrade', () => {
  const legacySlide = () => {
    const slide = createSlideFixture() as unknown as {
      elements: ({ doc?: unknown; text?: unknown } & Record<string, unknown>)[];
    };
    const element = slide.elements[0];
    delete element.doc;
    element.text = '旧课件标题';
    return slide;
  };

  it('accepts a slide whose text element still uses a plain string', () => {
    expect(isDeckSlideShape(legacySlide())).toBe(true);
  });

  it('upgrades the plain string to a rich text document and drops the legacy field', () => {
    const parsed = parseDeckSlideValue(legacySlide());
    const element = parsed.elements[0];
    if (element.type !== 'text') throw new Error('fixture element must be text');
    expect(element.doc).toEqual(richTextFromPlainText('旧课件标题'));
    expect(element).not.toHaveProperty('text');
  });

  it('is idempotent, so re-parsing does not churn the revision digest', () => {
    const once = parseDeckSlideValue(legacySlide());
    const twice = parseDeckSlideValue(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('rejects a text element that has neither doc nor text', () => {
    const slide = legacySlide();
    delete slide.elements[0].text;
    expectInvalidSlide(slide);
  });
});

describe('slide title stays plain text', () => {
  // 实测:模型会把富文本用的标签写进纯字符串的 title,直接渲染成字面标签。
  const titledSlide = (title: string) =>
    ({ ...createSlideFixture(), title }) as unknown as DeckSlide;

  it('strips markup the model leaked into the title', () => {
    const parsed = parseDeckSlideValue(
      titledSlide(
        "如何用<strong style='color:#1E90FF'>证据</strong>判断校园<strong>节水方案</strong>",
      ),
    );
    expect(parsed.title).toBe('如何用证据判断校园节水方案');
  });

  it('turns block boundaries into spaces instead of gluing words together', () => {
    expect(parseDeckSlideValue(titledSlide('<p>前半</p><p>后半</p>')).title).toBe('前半 后半');
    expect(parseDeckSlideValue(titledSlide('上行<br/>下行')).title).toBe('上行 下行');
  });

  it('leaves a clean title untouched and stays idempotent', () => {
    const clean = titledSlide('校园节水方案');
    const once = parseDeckSlideValue(clean);
    expect(once.title).toBe('校园节水方案');
    expect(JSON.stringify(parseDeckSlideValue(once))).toBe(JSON.stringify(once));
  });
});

describe('deck validation', () => {
  it('accepts a valid DeckSlide shape', () => {
    const slide = createSlideFixture();

    expect(isDeckSlideShape(slide)).toBe(true);
    expect(parseDeckSlideValue(slide)).toEqual(slide);
  });

  it.each(['cover', 'split-media', 'timeline', 'quiz', 'board-writing', 'summary'])(
    'rejects the removed %s layout',
    (layout) => {
      expectInvalidSlide({ ...createSlideFixture(), layout });
    },
  );

  it.each(['markdown', 'quiz', 'boardWriting', 'aiPrompt', 'whiteboard'])(
    '拒绝已废弃的 %s 元素类型',
    (type) => {
      expectInvalidSlide({
        ...createSlideFixture(),
        elements: [
          {
            id: 'deprecated-1',
            type,
            frame: { x: 120, y: 208, width: 1360, height: 440 },
            layer: 1,
          },
        ],
        animations: [],
        voiceTimeline: [],
      });
    },
  );

  it('拒绝已废弃的 highlight 动画类型', () => {
    const slide = createSlideFixture();
    expectInvalidSlide({
      ...slide,
      animations: [{ ...slide.animations[0], type: 'highlight' }],
    });
  });

  it('rejects a DeckSlide with missing target references', () => {
    const slide = {
      ...createSlideFixture(),
      animations: [{ ...createSlideFixture().animations[0], targetId: 'missing-animation-target' }],
      voiceTimeline: [
        { ...createSlideFixture().voiceTimeline[0], revealElementIds: ['missing-voice-target'] },
      ],
    };

    expectInvalidSlide(slide);
  });

  it('rejects duplicate element ids', () => {
    const slide = createSlideFixture();

    expectInvalidSlide({
      ...slide,
      elements: [slide.elements[0], { ...slide.elements[0] }],
    });
  });

  it('rejects duplicate animation ids', () => {
    const slide = createSlideFixture();

    expectInvalidSlide({
      ...slide,
      animations: [slide.animations[0], { ...slide.animations[0] }],
    });
  });

  it('rejects duplicate voice cue ids', () => {
    const slide = createSlideFixture();

    expectInvalidSlide({
      ...slide,
      voiceTimeline: [slide.voiceTimeline[0], { ...slide.voiceTimeline[0] }],
    });
  });

  it.each(['start', 'end'] as const)('拒绝 line.%s 端点中的任意额外字段', (endpoint) => {
    const slide = createSlideFixture();
    const line = {
      id: 'connector',
      type: 'line',
      start: { x: 200, y: 300 },
      end: { x: 600, y: 300 },
      layer: 1,
      role: 'connector',
      colorToken: 'accent',
    };
    expect(() =>
      parseDeckSlideValue({
        ...slide,
        elements: [
          {
            ...line,
            [endpoint]: { ...line[endpoint], marker: 'triangle' },
          },
        ],
        animations: [],
        voiceTimeline: [],
      }),
    ).toThrow('AI provider returned JSON that is not a Reach Deck slide.');
  });

  it.each(['fade', 'rise', 'zoom', 'appear'] as const)(
    '接受 revealEffect 取预设名 %s',
    (revealEffect) => {
      const slide = createSlideFixture();
      const withEffect = {
        ...slide,
        voiceTimeline: [{ ...slide.voiceTimeline[0], revealEffect }],
      };
      expect(isDeckSlideShape(withEffect)).toBe(true);
      const parsed = parseDeckSlideValue(withEffect);
      expect(parsed.voiceTimeline[0]!.revealEffect).toBe(revealEffect);
    },
  );

  it.each(['sparkle', 'fade-rise', '', 3])('拒绝预设库之外的 revealEffect %s', (revealEffect) => {
    const slide = createSlideFixture();
    expectInvalidSlide({
      ...slide,
      voiceTimeline: [{ ...slide.voiceTimeline[0], revealEffect }],
    });
  });
});

describe('generated scientific visual validation', () => {
  it('accepts the exact durable element including transform metadata and accessibility', () => {
    const slide = createSlideFixture();
    const visual = scientificVisualElementFixture();
    const parsed = parseDeckSlideValue({
      ...slide,
      elements: [visual],
      animations: [],
      voiceTimeline: [],
    });
    expect(parsed.elements[0]).toEqual(visual);
  });

  it('requires element ariaLabel to match the manifest and rejects extra fields', () => {
    const slide = createSlideFixture();
    const visual = scientificVisualElementFixture();
    expectInvalidSlide({
      ...slide,
      elements: [{ ...visual, ariaLabel: '不一致' }],
      animations: [],
      voiceTimeline: [],
    });
    expectInvalidSlide({
      ...slide,
      elements: [{ ...visual, generatedUrl: 'https://example.test' }],
      animations: [],
      voiceTimeline: [],
    });
  });

  it('allows at most one scientific visual and one supported whole-element entrance', () => {
    const slide = createSlideFixture();
    const visual = scientificVisualElementFixture();
    expectInvalidSlide({
      ...slide,
      elements: [visual, { ...visual, id: 'scientific-motion-2' }],
      animations: [],
      voiceTimeline: [],
    });
    expectInvalidSlide({
      ...slide,
      elements: [visual],
      animations: [
        { id: 'entrance-1', type: 'fade', targetId: visual.id, start: 0, duration: 0.5 },
        { id: 'entrance-2', type: 'move', targetId: visual.id, start: 1, duration: 0.5 },
      ],
      voiceTimeline: [],
    });
    expectInvalidSlide({
      ...slide,
      elements: [visual],
      animations: [
        { id: 'internal', type: 'stepReveal', targetId: visual.id, start: 0, duration: 1 },
      ],
      voiceTimeline: [],
    });
  });
});
