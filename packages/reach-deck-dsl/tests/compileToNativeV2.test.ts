import { describe, expect, it } from 'vitest';

import {
  buildReachDeckMediaResourceForObjectKey,
  DECK_THEME_COLOR_SLOTS,
  compileDeckSlideToNativeV2,
  createThemeResource,
  resolveThemeColorV2,
  type CompileDeckSlideToNativeV2Input,
} from '../src/compileToNativeV2.js';
import {
  DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE,
  ENTRANCE_ANIMATION_PRESET_NAMES,
  ENTRANCE_ANIMATION_PRESETS,
} from '../src/entranceAnimationPresets.js';
import { TYPOGRAPHY_TOKENS, V16_TYPOGRAPHY_TOKENS } from '../src/layoutContract.js';
import type {
  ReachDeckImageElementV2,
  ReachDeckLineElementV2,
  ReachDeckNativeSlideV2,
  ReachDeckShapeElementV2,
  ReachDeckScientificVisualElementV2,
  ReachDeckTextFrameV2,
  ReachDeckVideoElementV2,
} from '../src/nativeV2.js';
import { parseReachDeckNativeSlideV2 } from '../src/nativeV2Validation.js';
import { richTextFromPlainText, type RichTextNode } from '../src/richText.js';
import type { DeckElement, DeckSlide, DeckTheme } from '../src/types.js';
import { scientificVisualElementFixture } from './scientificVisualFixtures.js';

const textFrameAt = (slide: ReachDeckNativeSlideV2, index: number): ReachDeckTextFrameV2 => {
  const element = slide.elements[index];
  if (element?.type !== 'textFrame') throw new Error(`elements[${index}] 不是 textFrame`);
  return element.text;
};

const imageAt = (slide: ReachDeckNativeSlideV2, index: number): ReachDeckImageElementV2 => {
  const element = slide.elements[index];
  if (element?.type !== 'image') throw new Error(`elements[${index}] 不是 image`);
  return element;
};

const videoAt = (slide: ReachDeckNativeSlideV2, index: number): ReachDeckVideoElementV2 => {
  const element = slide.elements[index];
  if (element?.type !== 'video') throw new Error(`elements[${index}] 不是 video`);
  return element;
};

const shapeAt = (slide: ReachDeckNativeSlideV2, index: number): ReachDeckShapeElementV2 => {
  const element = slide.elements[index];
  if (element?.type !== 'shape') throw new Error(`elements[${index}] 不是 shape`);
  return element;
};

const lineAt = (slide: ReachDeckNativeSlideV2, index: number): ReachDeckLineElementV2 => {
  const element = slide.elements[index];
  if (element?.type !== 'line') throw new Error(`elements[${index}] 不是 line`);
  return element;
};

/** 取段落里第一个文字节点的 textStyle 属性。 */
const firstTextStyleAttrs = (text: ReachDeckTextFrameV2): Record<string, unknown> | undefined =>
  text.doc.content?.[0]?.content?.[0]?.marks?.find((mark) => mark.type === 'textStyle')?.attrs;

const firstParagraph = (text: ReachDeckTextFrameV2): RichTextNode => text.doc.content![0]!;

const theme: DeckTheme = {
  name: '水足迹',
  background: '#ffffff',
  surface: '#f8fafc',
  ink: '#172024',
  muted: '#647178',
  accent: '#2563eb',
  success: '#15803d',
  warning: '#b45309',
  fontDisplay: 'Noto Serif',
  fontBody: 'Noto Sans',
};

const slideOf = (elements: DeckElement[], background = 'surface'): DeckSlide => ({
  id: 'slide-1',
  title: '水足迹调查',
  layout: 'freeform',
  duration: 0,
  background,
  elements,
  animations: [],
  voiceTimeline: [],
});

const titleElement: DeckElement = {
  id: 'title',
  type: 'text',
  frame: { x: 80, y: 64, width: 900, height: 120 },
  layer: 1,
  doc: richTextFromPlainText('一杯牛奶的水足迹'),
  variant: 'title',
  colorToken: 'accent',
};

const bodyElement: DeckElement = {
  id: 'body',
  type: 'text',
  frame: { x: 80, y: 250, width: 900, height: 300 },
  layer: 2,
  doc: richTextFromPlainText('生产 1 升牛奶约需 1000 升水。'),
  variant: 'body',
};

const imageElement: DeckElement = {
  id: 'photo',
  type: 'image',
  frame: { x: 1050, y: 64, width: 400, height: 300 },
  layer: 3,
  objectKey: 'decks/水足迹/photo.png',
  alt: '牧场取水',
  fit: 'cover',
};

const videoElement: DeckElement = {
  id: 'clip',
  type: 'video',
  frame: { x: 1050, y: 450, width: 400, height: 250 },
  layer: 4,
  src: 'decks/water/clip.mp4',
  poster: 'decks/water/clip-poster.jpg',
  title: '取水过程',
};

const representativeInput = (): CompileDeckSlideToNativeV2Input => ({
  slide: slideOf([titleElement, bodyElement, imageElement, videoElement]),
  theme,
  narration: {
    audioResourceId: 'media-narration',
    segments: [
      { text: '先看标题。', start: 0, end: 3, revealElementIds: ['title'] },
      { text: '再看数据。', start: 3, end: 8, revealElementIds: ['body', 'photo'] },
      { text: '最后播放视频。', revealElementIds: ['clip'] },
    ],
  },
  duration: 12,
});

describe('compileDeckSlideToNativeV2 产物合法性', () => {
  it('代表性 slide 编译结果通过 parseReachDeckNativeSlideV2', () => {
    const result = compileDeckSlideToNativeV2(representativeInput());
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
    expect(result.slide.elements.map((element) => element.id)).toEqual([
      'title',
      'body',
      'photo',
      'clip',
    ]);
    expect(result.slide.elements.map((element) => element.type)).toEqual([
      'textFrame',
      'textFrame',
      'image',
      'video',
    ]);
    expect(result.slide.duration).toBe(12);
    expect(result.slide.textCompatibility).toBe('native');
    expect(result.diagnostics).toEqual([]);
  });

  it('透传讲稿分段的文本与时间戳', () => {
    const { slide } = compileDeckSlideToNativeV2(representativeInput());
    expect(slide.narration).toEqual({
      audioResourceId: 'media-narration',
      segments: [
        { text: '先看标题。', start: 0, end: 3 },
        { text: '再看数据。', start: 3, end: 8 },
        { text: '最后播放视频。' },
      ],
    });
  });

  it('页时长非正数时忽略并记 diagnostic', () => {
    const input = representativeInput();
    const result = compileDeckSlideToNativeV2({ ...input, duration: 0 });
    expect(result.slide.duration).toBeUndefined();
    expect(result.diagnostics).toContain('已忽略页时长 0：必须是正数秒。');
  });
});

describe('compileDeckSlideToNativeV2 主题与颜色', () => {
  it('登记的主题资源覆盖全部语义槽，且背景引用的 token 能解析', () => {
    const result = compileDeckSlideToNativeV2(representativeInput());
    const [themeResource] = result.resources.themes;
    expect(Object.keys(themeResource!.colors).sort()).toEqual(
      DECK_THEME_COLOR_SLOTS.map(([, token]) => token).sort(),
    );
    expect(themeResource!.fonts).toEqual({ display: 'Noto Serif', body: 'Noto Sans' });

    expect(result.slide.background).toEqual({
      kind: 'solid',
      color: { kind: 'theme', token: 'surface' },
    });
    const background = result.slide.background as { color: { kind: 'theme'; token: string } };
    expect(resolveThemeColorV2(background.color, themeResource!)).toBe('#f8fafc');
  });

  it('同一主题跨次编译得到同一个资源 id', () => {
    expect(createThemeResource(theme).id).toBe(createThemeResource({ ...theme }).id);
    expect(createThemeResource(theme).id).not.toBe(
      createThemeResource({ ...theme, ink: '#000000' }).id,
    );
  });

  it('背景为字面色值时按 srgb 处理，非法色值回退到主题底色', () => {
    expect(
      compileDeckSlideToNativeV2({ slide: slideOf([], '#FFF'), theme }).slide.background,
    ).toEqual({
      kind: 'solid',
      color: { kind: 'srgb', value: '#ffffff' },
    });
    const invalid = compileDeckSlideToNativeV2({ slide: slideOf([], 'rgb(1,2,3)'), theme });
    expect(invalid.slide.background).toEqual({
      kind: 'solid',
      color: { kind: 'srgb', value: '#ffffff' },
    });
    expect(invalid.diagnostics).toContain(
      '页面背景「rgb(1,2,3)」既不是主题 token 也不是 #RRGGBB 色值，已回退为主题底色。',
    );
  });

  it('作者可控字符串命中原型属性时走回退分支，而不是抛错', () => {
    // background / colorToken / 扩展名都来自模型生成内容，取值不受约束；
    // 直接用它们索引对象字面量会命中 constructor / __proto__ 等原型属性。
    for (const background of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const result = compileDeckSlideToNativeV2({ slide: slideOf([], background), theme });
      expect(result.slide.background).toEqual({
        kind: 'solid',
        color: { kind: 'srgb', value: '#ffffff' },
      });
      expect(result.diagnostics).toContain(
        `页面背景「${background}」既不是主题 token 也不是 #RRGGBB 色值，已回退为主题底色。`,
      );
      expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
    }
  });

  it('objectKey 扩展名命中原型属性时回退为通用二进制类型', () => {
    const image = {
      ...(imageElement as Extract<DeckElement, { type: 'image' }>),
      objectKey: 'decks/water/photo.constructor',
    };
    const result = compileDeckSlideToNativeV2({ slide: slideOf([image]), theme });
    expect(result.resources.media[0]!.contentType).toBe('application/octet-stream');
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
  });

  it('colorToken 取到原型属性时回退为 ink，未知 variant 回退为 body', () => {
    const rogue = {
      ...(bodyElement as Extract<DeckElement, { type: 'text' }>),
      colorToken: 'constructor',
      variant: '__proto__',
    } as unknown as DeckElement;
    const result = compileDeckSlideToNativeV2({ slide: slideOf([rogue]), theme });
    expect(firstTextStyleAttrs(textFrameAt(result.slide, 0))).toEqual({
      fontSize: `${TYPOGRAPHY_TOKENS.body.fontSize}px`,
      color: theme.ink,
      fontFamily: 'Noto Sans',
    });
    expect(result.diagnostics).toContain(
      '元素 body：未知的文本 variant「__proto__」，已回退为 body。',
    );
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
  });

  it('colorToken 按主题语义槽解析进文本样式，缺省为 ink', () => {
    const { slide } = compileDeckSlideToNativeV2(representativeInput());
    expect(firstTextStyleAttrs(textFrameAt(slide, 0))).toEqual({
      fontSize: '64px',
      color: '#2563eb',
      fontFamily: 'Noto Serif',
    });
    expect(firstTextStyleAttrs(textFrameAt(slide, 1))).toEqual({
      fontSize: '30px',
      color: '#172024',
      fontFamily: 'Noto Sans',
    });
  });

  it('variant 的行高按 TYPOGRAPHY_TOKENS 落到段落上', () => {
    const { slide } = compileDeckSlideToNativeV2(representativeInput());
    expect(firstParagraph(textFrameAt(slide, 0)).attrs).toEqual({
      lineHeightPx: TYPOGRAPHY_TOKENS.title.lineHeight,
    });
    expect(firstParagraph(textFrameAt(slide, 1)).attrs).toEqual({
      lineHeightPx: TYPOGRAPHY_TOKENS.body.lineHeight,
    });
  });

  it('legacy 与 v16 均把三档枚举落成同一套具体字号', () => {
    const caption = {
      ...bodyElement,
      id: 'caption',
      variant: 'caption',
    } as Extract<DeckElement, { type: 'text' }>;
    const legacy = compileDeckSlideToNativeV2({
      slide: slideOf([titleElement, bodyElement, caption]),
      theme,
    });
    const v16 = compileDeckSlideToNativeV2({
      slide: { ...slideOf([titleElement, bodyElement, caption]), typographyProfile: 'v16' },
      theme,
    });

    for (const compiled of [legacy, v16]) {
      expect(firstTextStyleAttrs(textFrameAt(compiled.slide, 0))?.fontSize).toBe('64px');
      expect(firstTextStyleAttrs(textFrameAt(compiled.slide, 1))?.fontSize).toBe('30px');
      expect(firstTextStyleAttrs(textFrameAt(compiled.slide, 2))?.fontSize).toBe('24px');
    }
    expect(V16_TYPOGRAPHY_TOKENS).toBe(TYPOGRAPHY_TOKENS);
  });

  it('让纯公式、混排公式与块公式继承所属档位，且保留作者局部样式', () => {
    const formulaElement: DeckElement = {
      ...bodyElement,
      variant: 'caption',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'inlineMath', attrs: { latex: 'x^2' } },
              { type: 'text', text: ' 与 ' },
              { type: 'mathInline', attrs: { latex: 'y', fontSize: '40px', color: '#ff0000' } },
            ],
          },
          { type: 'blockMath', attrs: { latex: 'x+y=1' } },
        ],
      },
    };
    const { slide } = compileDeckSlideToNativeV2({ slide: slideOf([formulaElement]), theme });
    const doc = textFrameAt(slide, 0).doc;
    const inline = doc.content?.[0]?.content?.[0];
    const authored = doc.content?.[0]?.content?.[2];
    const block = doc.content?.[1];
    expect(inline?.attrs).toMatchObject({
      fontSize: '24px',
      lineHeightPx: 32,
      fontFamily: 'Noto Sans',
      color: theme.ink,
    });
    expect(authored?.attrs).toMatchObject({ fontSize: '40px', color: '#ff0000' });
    expect(block?.attrs).toMatchObject({
      fontSize: '24px',
      lineHeightPx: 32,
      fontFamily: 'Noto Sans',
      color: theme.ink,
    });
  });

  it('已有的段落行高与文字样式不被覆盖', () => {
    const authored: DeckElement = {
      ...(bodyElement as Extract<DeckElement, { type: 'text' }>),
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { lineHeightPx: 60 },
            content: [
              {
                type: 'text',
                text: '强调',
                marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }],
              },
            ],
          },
        ],
      },
    };
    const { slide } = compileDeckSlideToNativeV2({ slide: slideOf([authored]), theme });
    const text = textFrameAt(slide, 0);
    expect(firstParagraph(text).attrs).toEqual({ lineHeightPx: 60 });
    expect(firstTextStyleAttrs(text)).toEqual({
      color: '#ff0000',
      fontSize: `${TYPOGRAPHY_TOKENS.body.fontSize}px`,
      fontFamily: 'Noto Sans',
    });
  });
});

describe('compileDeckSlideToNativeV2 受限 shape / line', () => {
  const shape: DeckElement = {
    id: 'panel',
    type: 'shape',
    frame: { x: 80, y: 220, width: 440, height: 420 },
    layer: 1,
    shape: 'roundRect',
    fillToken: 'accentSoft',
    strokeToken: 'accent',
  };
  const arrow: DeckElement = {
    id: 'arrow',
    type: 'line',
    frame: { x: 520, y: 430, width: 100, height: 1 },
    start: { x: 520, y: 430 },
    end: { x: 620, y: 430 },
    layer: 2,
    role: 'arrow',
    colorToken: 'accent',
  };
  const connector: DeckElement = {
    ...arrow,
    id: 'connector',
    frame: { x: 520, y: 320, width: 180, height: 120 },
    start: { x: 520, y: 320 },
    end: { x: 700, y: 440 },
    role: 'connector',
  };

  it('把语义 shape token 确定性派生为 native geometry/style', () => {
    const result = compileDeckSlideToNativeV2({ slide: slideOf([shape]), theme });
    const native = shapeAt(result.slide, 0);
    expect(native.geometry).toEqual({ kind: 'preset', preset: 'roundRect' });
    expect(native.style).toEqual({
      fill: { kind: 'solid', color: { kind: 'srgb', value: '#e0e9fc' } },
      stroke: {
        width: 2,
        fill: { kind: 'theme', token: 'accent' },
        dash: 'solid',
      },
    });
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
  });

  it('从全局端点派生 line transform，并由 role 决定 marker/线宽/路由', () => {
    const result = compileDeckSlideToNativeV2({ slide: slideOf([arrow]), theme });
    const native = lineAt(result.slide, 0);
    expect(native.transform).toEqual({ x: 520, y: 430, width: 100, height: 1 });
    expect(native.start).toEqual({ x: 0, y: 0, marker: 'none' });
    expect(native.end).toEqual({ x: 100, y: 0, marker: 'triangle' });
    expect(native.routing).toBe('straight');
    expect(native.connector).toBe(true);
    expect(native.stroke).toEqual({
      width: 4,
      fill: { kind: 'theme', token: 'accent' },
      dash: 'solid',
      cap: 'round',
      join: 'round',
    });
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
  });

  it('把 connector 编译为无 marker 的斜直线，而不是三段 elbow 折线', () => {
    const result = compileDeckSlideToNativeV2({ slide: slideOf([connector]), theme });
    const native = lineAt(result.slide, 0);

    expect(native.transform).toEqual({ x: 520, y: 320, width: 180, height: 120 });
    expect(native.start).toEqual({ x: 0, y: 0, marker: 'none' });
    expect(native.end).toEqual({ x: 180, y: 120, marker: 'none' });
    expect(native.routing).toBe('straight');
    expect(native.connector).toBe(true);
  });

  it('同一 shape/line 输入重复编译逐字节稳定', () => {
    const input = { slide: slideOf([shape, arrow]), theme };
    const first = compileDeckSlideToNativeV2(input);
    const second = compileDeckSlideToNativeV2(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('纠正模型倒置 layer，使 shape < line < text/media，并保留同层内相对顺序', () => {
    const invertedShape = { ...shape, layer: 999 } as DeckElement;
    const invertedLine = { ...arrow, layer: 500 } as DeckElement;
    const firstText = { ...titleElement, id: 'text-first', layer: -20 } as DeckElement;
    const secondText = { ...bodyElement, id: 'text-second', layer: -10 } as DeckElement;
    const result = compileDeckSlideToNativeV2({
      slide: slideOf([firstText, invertedLine, secondText, invertedShape]),
      theme,
    });
    const zIndexById = Object.fromEntries(
      result.slide.elements.map((element) => [element.id, element.zIndex]),
    );
    expect(zIndexById).toEqual({
      'text-first': 2,
      arrow: 1,
      'text-second': 3,
      panel: 0,
    });
  });
});

describe('compileDeckSlideToNativeV2 媒体资源', () => {
  it('图片按 objectKey 登记媒体资源并以 resourceId 引用', () => {
    const result = compileDeckSlideToNativeV2({ slide: slideOf([imageElement]), theme });
    const image = imageAt(result.slide, 0);
    const media = result.resources.media;
    expect(media).toHaveLength(1);
    expect(media[0]!.objectKey).toBe('decks/水足迹/photo.png');
    expect(media[0]!.contentType).toBe('image/png');
    expect(media[0]!.id).toBe(image.resourceId);
    expect(image.fit).toBe('cover');
    expect(image.alt).toBe('牧场取水');
  });

  it('视频登记 src 与 poster 两条资源', () => {
    const result = compileDeckSlideToNativeV2({ slide: slideOf([videoElement]), theme });
    const video = videoAt(result.slide, 0);
    expect(result.resources.media).toHaveLength(2);
    expect(result.resources.media.map((entry) => entry.contentType).sort()).toEqual([
      'image/jpeg',
      'video/mp4',
    ]);
    expect(video.posterResourceId).not.toBe(video.resourceId);
    expect(video.playback).toEqual({ startAt: 0, autoplay: false, loop: false, volume: 1 });
  });

  it('同一个 objectKey 只登记一次', () => {
    const second = { ...(imageElement as Extract<DeckElement, { type: 'image' }>), id: 'photo-2' };
    const result = compileDeckSlideToNativeV2({ slide: slideOf([imageElement, second]), theme });
    expect(result.resources.media).toHaveLength(1);
  });

  it('缺少 objectKey 的图片被跳过，图注被丢弃并记 diagnostic', () => {
    const withoutKey: DeckElement = {
      id: 'photo',
      type: 'image',
      frame: { x: 100, y: 100, width: 400, height: 300 },
      layer: 1,
      src: 'https://cdn.test/signed.png',
      alt: '临时图',
      fit: 'contain',
      caption: '数据来源：某报告',
    };
    const result = compileDeckSlideToNativeV2({ slide: slideOf([withoutKey]), theme });
    expect(result.slide.elements).toEqual([]);
    expect(result.diagnostics).toContain(
      '已跳过图片元素 photo：缺少稳定的 objectKey，无法登记媒体资源。',
    );

    const withKey = { ...withoutKey, objectKey: 'decks/a.png' } as DeckElement;
    const kept = compileDeckSlideToNativeV2({ slide: slideOf([withKey]), theme });
    expect(kept.diagnostics).toContain(
      '已丢弃图片元素 photo 的图注「数据来源：某报告」：v2 image 元素没有图注槽位。',
    );
  });
});

describe('compileDeckSlideToNativeV2 scientific visual', () => {
  it('preserves the complete payload and registers every stable managed resource', () => {
    const source = scientificVisualElementFixture();
    const result = compileDeckSlideToNativeV2({ slide: slideOf([source]), theme });
    const native = result.slide.elements[0] as ReachDeckScientificVisualElementV2;

    expect(native).toEqual({
      id: source.id,
      type: 'scientificVisual',
      transform: source.frame,
      zIndex: 0,
      ariaLabel: source.ariaLabel,
      name: source.name,
      locked: source.locked,
      documentHtml: source.documentHtml,
      manifest: source.manifest,
    });
    expect(result.resources.media).toEqual(
      source.mediaResources.map(({ objectKey }) =>
        buildReachDeckMediaResourceForObjectKey(objectKey),
      ),
    );
    expect(parseReachDeckNativeSlideV2(result.slide)).toBe(result.slide);
  });

  it('fails visibly when supplied media metadata does not match stable objectKey identity', () => {
    const source = scientificVisualElementFixture();
    source.mediaResources[0] = { ...source.mediaResources[0]!, digest: 'sha256:tampered' };
    expect(() => compileDeckSlideToNativeV2({ slide: slideOf([source]), theme })).toThrow(
      /does not match its stable objectKey identity/i,
    );
  });

  it('recompiles the self-contained durable element byte-stably', () => {
    const input = { slide: slideOf([scientificVisualElementFixture()]), theme };
    const first = compileDeckSlideToNativeV2(input);
    const second = compileDeckSlideToNativeV2(structuredClone(input));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('persists narration-owned scientific bindings only with audio and fully timed segments', () => {
    const source = scientificVisualElementFixture();
    const scientificAnchorBindings = source.manifest.anchors.map((anchor, index) => ({
      id: `narration-anchor:${source.id}:${anchor.id}`,
      elementId: source.id,
      anchorId: anchor.id,
      start: index * 2,
      end: (index + 1) * 2,
    }));
    const complete = compileDeckSlideToNativeV2({
      slide: slideOf([source]),
      theme,
      duration: 5,
      narration: {
        markdown: '完整讲稿',
        audioResourceId: 'scientific-audio',
        segments: [{ text: '完整讲稿', start: 0, end: 4 }],
        scientificAnchorBindings,
      },
    });
    expect(complete.slide.narration?.scientificAnchorBindings).toEqual(scientificAnchorBindings);
    expect(parseReachDeckNativeSlideV2(complete.slide)).toBe(complete.slide);

    const invalidatedDraft = compileDeckSlideToNativeV2({
      slide: slideOf([source]),
      theme,
      duration: 5,
      narration: {
        markdown: '待重试讲稿',
        segments: [{ text: '待重试讲稿' }],
        scientificAnchorBindings,
      },
    });
    expect(invalidatedDraft.slide.narration).toEqual({ markdown: '待重试讲稿' });
    expect(invalidatedDraft.slide.narration).not.toHaveProperty('scientificAnchorBindings');
  });
});

describe('compileDeckSlideToNativeV2 入场动画', () => {
  it('带时间戳的讲稿分段为目标元素生成入场动画（缺省按元素类型回落预设）', () => {
    const { slide } = compileDeckSlideToNativeV2(representativeInput());
    expect(slide.animations).toEqual([
      {
        id: 'title-entrance',
        targetId: 'title',
        trigger: 'on-enter',
        start: 0,
        // textFrame 缺省预设是 rise（淡入上浮），与放开效果前的视觉等价。
        ...ENTRANCE_ANIMATION_PRESETS.rise,
        from: { ...ENTRANCE_ANIMATION_PRESETS.rise.from },
        to: { ...ENTRANCE_ANIMATION_PRESETS.rise.to },
      },
      {
        id: 'body-entrance',
        targetId: 'body',
        trigger: 'on-enter',
        start: 3,
        ...ENTRANCE_ANIMATION_PRESETS.rise,
        from: { ...ENTRANCE_ANIMATION_PRESETS.rise.from },
        to: { ...ENTRANCE_ANIMATION_PRESETS.rise.to },
      },
      {
        id: 'photo-entrance',
        targetId: 'photo',
        trigger: 'on-enter',
        start: 3,
        // image 缺省预设是 fade（纯淡入）。
        ...ENTRANCE_ANIMATION_PRESETS.fade,
        from: { ...ENTRANCE_ANIMATION_PRESETS.fade.from },
        to: { ...ENTRANCE_ANIMATION_PRESETS.fade.to },
      },
    ]);
    // 第三段没有时间戳，不产动画。
    expect(slide.animations.some((animation) => animation.targetId === 'clip')).toBe(false);
  });

  it('预设库形状：预设名列表与预设表同源，缺省映射与旧固定映射逐值等价', () => {
    expect(Object.keys(ENTRANCE_ANIMATION_PRESETS).sort()).toEqual(
      [...ENTRANCE_ANIMATION_PRESET_NAMES].sort(),
    );
    expect(DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE).toEqual({
      textFrame: 'rise',
      shape: 'fade',
      line: 'appear',
      image: 'fade',
      video: 'fade',
      scientificVisual: 'fade',
    });
    // rise 即旧 textFrame 预设，fade 即旧 image/video 预设。
    expect(ENTRANCE_ANIMATION_PRESETS.rise).toMatchObject({
      effect: 'fade',
      from: { opacity: 0, translateY: 24 },
      to: { opacity: 1, translateY: 0 },
    });
    expect(ENTRANCE_ANIMATION_PRESETS.fade).toMatchObject({
      effect: 'fade',
      from: { opacity: 0 },
      to: { opacity: 1 },
    });
    expect(ENTRANCE_ANIMATION_PRESETS.zoom).toMatchObject({
      effect: 'scale',
      from: { opacity: 0, scale: 0.92 },
      to: { opacity: 1, scale: 1 },
    });
    expect(ENTRANCE_ANIMATION_PRESETS.appear.effect).toBe('appear');
    expect(ENTRANCE_ANIMATION_PRESETS.appear.duration).toBeLessThanOrEqual(0.05);
  });

  it('分段带 revealEffect 时使用具名预设，appear 不落空补间', () => {
    const result = compileDeckSlideToNativeV2({
      slide: slideOf([titleElement, bodyElement, imageElement]),
      theme,
      narration: {
        segments: [
          { text: '放大看。', start: 0, end: 2, revealElementIds: ['photo'], revealEffect: 'zoom' },
          {
            text: '直接出现。',
            start: 2,
            end: 4,
            revealElementIds: ['body'],
            revealEffect: 'appear',
          },
        ],
      },
    });
    const zoom = result.slide.animations.find((animation) => animation.targetId === 'photo')!;
    expect(zoom).toMatchObject({
      effect: 'scale',
      from: { opacity: 0, scale: 0.92 },
      to: { opacity: 1, scale: 1 },
    });
    const appear = result.slide.animations.find((animation) => animation.targetId === 'body')!;
    expect(appear.effect).toBe('appear');
    expect(appear).not.toHaveProperty('from');
    expect(appear).not.toHaveProperty('to');
    // 产物仍是合法 v2 slide。
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
  });

  it('revealEffect 不在预设库内时回落元素类型缺省并记 diagnostic', () => {
    const result = compileDeckSlideToNativeV2({
      slide: slideOf([titleElement]),
      theme,
      narration: {
        segments: [
          {
            text: '未知效果。',
            start: 0,
            end: 2,
            revealElementIds: ['title'],
            revealEffect: 'sparkle' as never,
          },
        ],
      },
    });
    expect(result.slide.animations[0]).toMatchObject({
      targetId: 'title',
      effect: ENTRANCE_ANIMATION_PRESETS.rise.effect,
      from: { ...ENTRANCE_ANIMATION_PRESETS.rise.from },
    });
    expect(
      result.diagnostics.some((message) => message.includes('sparkle') && message.includes('回落')),
    ).toBe(true);
  });

  it('编译是确定性的：同一输入两次编译产物深度相等', () => {
    const first = compileDeckSlideToNativeV2(representativeInput());
    const second = compileDeckSlideToNativeV2(representativeInput());
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('时间戳被忽略的分段不产动画，讲稿与动画不会错位', () => {
    const result = compileDeckSlideToNativeV2({
      slide: slideOf([titleElement, bodyElement]),
      theme,
      narration: {
        segments: [
          { text: '有效', start: 4, end: 6, revealElementIds: ['title'] },
          // start 残缺 → 讲稿丢时间戳，动画也不该按原始 start 触发。
          { text: '残缺', start: 1, revealElementIds: ['body'] },
        ],
      },
    });
    expect(result.slide.narration?.segments).toEqual([
      { text: '有效', start: 4, end: 6 },
      { text: '残缺' },
    ]);
    expect(result.slide.animations.map((animation) => animation.targetId)).toEqual(['title']);
  });

  it('revealElementIds 悬空引用被跳过并记 diagnostic', () => {
    const input = representativeInput();
    const result = compileDeckSlideToNativeV2({
      ...input,
      narration: {
        segments: [{ text: '点亮', start: 1, end: 2, revealElementIds: ['title', '不存在'] }],
      },
    });
    expect(result.slide.animations.map((animation) => animation.targetId)).toEqual(['title']);
    expect(result.diagnostics).toContain(
      '已跳过讲稿分段 0 的入场动画：元素 不存在 不存在或未被编译。',
    );
  });
});

describe('compileDeckSlideToNativeV2 跳过与静默修正', () => {
  it('越界元素被拉回安全区并记 diagnostic', () => {
    const escaped: DeckElement = {
      ...(titleElement as Extract<DeckElement, { type: 'text' }>),
      frame: { x: 1500, y: 800, width: 300, height: 120 },
    };
    const result = compileDeckSlideToNativeV2({ slide: slideOf([escaped]), theme });
    expect(result.slide.elements[0]!.transform).toEqual({
      x: 1220,
      y: 716,
      width: 300,
      height: 120,
    });
    expect(result.diagnostics[0]).toBe(
      '元素 title：超出安全区，已从 (1500, 800) 平移到 (1220, 716)。',
    );
  });

  it('框高放不下一行时启用 shrink-text，且缩放不低于 0.9', () => {
    const squeezed: DeckElement = {
      ...(titleElement as Extract<DeckElement, { type: 'text' }>),
      frame: { x: 80, y: 64, width: 900, height: 40 },
    };
    const result = compileDeckSlideToNativeV2({ slide: slideOf([squeezed]), theme });
    const autofit = textFrameAt(result.slide, 0).autofit;
    expect(autofit).toEqual({ mode: 'shrink-text', fontScale: 0.9 });
    expect(result.diagnostics).toContain('元素 title：字号缩放 0.59 低于下限 0.9，已抬到 0.9。');
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
  });

  it('框高放得下一行时不缩字', () => {
    const result = compileDeckSlideToNativeV2({ slide: slideOf([titleElement]), theme });
    expect(textFrameAt(result.slide, 0).autofit).toEqual({ mode: 'none' });
  });

  it('重复的元素 id 被跳过，保证 v2 元素 id 唯一', () => {
    const duplicate = { ...(titleElement as Extract<DeckElement, { type: 'text' }>) };
    const result = compileDeckSlideToNativeV2({ slide: slideOf([titleElement, duplicate]), theme });
    expect(result.slide.elements).toHaveLength(1);
    expect(result.diagnostics).toContain('已跳过元素 title：元素 id 在本页重复。');
  });

  it('残缺或倒序的讲稿时间戳被忽略，产物仍然合法', () => {
    const result = compileDeckSlideToNativeV2({
      slide: slideOf([titleElement]),
      theme,
      narration: {
        segments: [
          { text: '第一段', start: 5, end: 8 },
          { text: '第二段', start: 1, end: 2 },
          { text: '第三段', start: 9 },
        ],
      },
    });
    expect(result.slide.narration?.segments).toEqual([
      { text: '第一段', start: 5, end: 8 },
      { text: '第二段' },
      { text: '第三段' },
    ]);
    expect(result.diagnostics).toContain(
      '已忽略讲稿分段 1 的时间戳：起点早于前一段，时间轴必须单调非降。',
    );
    expect(result.diagnostics).toContain('已忽略讲稿分段 2 的时间戳：start 与 end 必须同时给出。');
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
  });
});
