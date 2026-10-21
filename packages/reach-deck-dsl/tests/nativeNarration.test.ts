import { describe, expect, it } from 'vitest';

import {
  applyReachDeckNarrationToNativeSlide,
  applyReachDeckTextOnlyNarrationToNativeSlide,
  invalidateReachDeckNativeSlideNarration,
  isReachDeckNarrationDrivenAnimation,
  isNativeSlideNarrationContentStale,
  nativeSlideNarrationContentBaseline,
  preserveNativeSlideNarrationContentBaseline,
  parseReachDeckNativeSlideV2,
  REACH_DECK_NARRATION_ANIMATION_ID_PREFIX,
  resolveNativeV2ElementPlaybackState,
  richTextFromPlainText,
  stripReachDeckNativeSlideNarration,
  summarizeNativeSlideElementsForNarration,
  type ReachDeckAnimationV2,
  type ReachDeckNativeSlideV2,
  type ReachDeckTextFrameV2,
} from '../src/index.js';
import { scientificNativeSlideFixture } from './scientificVisualFixtures.js';

const transform = { x: 10, y: 20, width: 400, height: 120 };

const textFrame = (text: string): ReachDeckTextFrameV2 => ({
  margins: { left: 0, top: 0, right: 0, bottom: 0 },
  verticalAlignment: 'top',
  wrap: true,
  autofit: { mode: 'none' },
  doc: richTextFromPlainText(text),
  fontSubstitutions: [],
});

const teacherAnimation: ReachDeckAnimationV2 = {
  id: 'teacher-anim-1',
  targetId: 'image-1',
  trigger: 'on-click',
  effect: 'move',
  start: 2,
  duration: 1,
  from: { translateX: -40 },
  to: { translateX: 0 },
};

describe('preserved narration animation timing', () => {
  const existingAnimation: ReachDeckAnimationV2 = {
    ...teacherAnimation,
    id: `${REACH_DECK_NARRATION_ANIMATION_ID_PREFIX}text-1`,
    targetId: 'text-1',
    trigger: 'on-enter',
  };
  it('animation-only replaces narration entrances while retaining all narration and duration', () => {
    const slide = {
      ...nativeSlide(),
      animations: [existingAnimation, teacherAnimation],
      duration: 6,
      narration: {
        markdown: '保存讲稿',
        audioResourceId: 'existing-audio',
        segments: [{ text: '保存讲稿', start: 0, end: 5 }],
        contentBaseline: 'existing-baseline',
      },
    };
    const applied = applyReachDeckNarrationToNativeSlide(slide, {
      animationMode: 'animations',
      markdown: '保存讲稿',
      segments: slide.narration.segments,
      audioResourceId: 'existing-audio',
      duration: 6,
      reveals: [{ start: 4, revealElementIds: ['text-1'], revealEffect: 'fade' }],
    }).slide;
    expect(applied.narration).toBe(slide.narration);
    expect(applied.duration).toBe(slide.duration);
    expect(applied.animations[0]).toBe(teacherAnimation);
    expect(applied.animations[1]).toMatchObject({ targetId: 'text-1', start: 4, effect: 'fade' });
  });
  it.each([true, false])(
    'audio-only clears every animation only after complete audio succeeds (complete: %s)',
    (complete) => {
      const slide = { ...nativeSlide(), animations: [existingAnimation, teacherAnimation] };
      const result = applyReachDeckNarrationToNativeSlide(slide, {
        animationMode: 'skip',
        markdown: '新讲稿',
        segments: complete ? [{ text: '新讲稿', start: 0, end: 5 }] : [],
        ...(complete ? { audioResourceId: 'audio-1' } : {}),
        duration: 6,
        reveals: [{ start: 4, revealElementIds: ['shape-1'], revealEffect: 'fade' }],
      });
      if (complete) {
        expect(result.slide.animations).toEqual([]);
      } else {
        expect(result.slide.animations).toBe(slide.animations);
        expect(result.slide.animations[0]).toBe(existingAnimation);
        expect(result.slide.animations[1]).toBe(teacherAnimation);
      }
      expect(result.diagnostics).toHaveLength(complete ? 0 : 1);
      if (complete) expect(result.slide.narration?.audioResourceId).toBe('audio-1');
    },
  );
  it('keeps animation design in a saved draft and changes only start on apply', () => {
    const slide = { ...nativeSlide(), animations: [existingAnimation, teacherAnimation] };
    const draft = invalidateReachDeckNativeSlideNarration(slide, '新讲稿', undefined, {
      preserveAnimations: true,
    });
    expect(draft.animations).toEqual(slide.animations);
    expect(draft.narration).toEqual({ markdown: '新讲稿' });
    const applied = applyReachDeckNarrationToNativeSlide(draft, {
      animationMode: 'preserve',
      markdown: '新讲稿',
      segments: [{ text: '新讲稿', start: 0, end: 5 }],
      audioResourceId: 'audio-1',
      duration: 6,
      reveals: [{ start: 4, revealElementIds: ['text-1', 'shape-1'], revealEffect: 'fade' }],
    }).slide;
    expect(applied.animations).toEqual([{ ...existingAnimation, start: 4 }, teacherAnimation]);
    expect(() => parseReachDeckNativeSlideV2(applied)).not.toThrow();
  });
  it('fails explicitly when a narration animation cannot be aligned', () => {
    expect(() =>
      applyReachDeckNarrationToNativeSlide(
        { ...nativeSlide(), animations: [existingAnimation] },
        {
          animationMode: 'preserve',
          markdown: '新讲稿',
          segments: [{ text: '新讲稿', start: 0, end: 5 }],
          audioResourceId: 'audio-1',
          duration: 6,
          reveals: [],
        },
      ),
    ).toThrow('NARRATION_ANIMATION_ALIGNMENT_FAILED');
  });
  it('keeps an orphan narration entrance instead of failing alignment', () => {
    const orphan = { ...existingAnimation, id: 'narration-entrance:deleted', targetId: 'deleted' };
    const applied = applyReachDeckNarrationToNativeSlide(
      { ...nativeSlide(), animations: [orphan] },
      {
        animationMode: 'preserve',
        markdown: '新讲稿',
        segments: [{ text: '新讲稿', start: 0, end: 5 }],
        audioResourceId: 'audio-1',
        duration: 6,
        reveals: [],
      },
    ).slide;
    expect(applied.animations).toEqual([orphan]);
    expect(applied.duration).toBe(6);
  });
  it('removes explicitly static narration entrances while retaining teacher animations', () => {
    const slide = { ...nativeSlide(), animations: [existingAnimation, teacherAnimation] };
    const applied = applyReachDeckNarrationToNativeSlide(slide, {
      animationMode: 'preserve',
      markdown: '新讲稿',
      segments: [{ text: '新讲稿', start: 0, end: 5 }],
      audioResourceId: 'audio-1',
      duration: 6,
      reveals: [],
      persistentElementIds: ['text-1', 'image-1'],
    }).slide;
    expect(applied.animations).toEqual([teacherAnimation]);
    expect(slide.animations).toEqual([existingAnimation, teacherAnimation]);
    expect(() => parseReachDeckNativeSlideV2(applied)).not.toThrow();
  });
  it('does not create animations when preserving a page without any', () => {
    const result = applyReachDeckNarrationToNativeSlide(
      { ...nativeSlide(), animations: [] },
      {
        animationMode: 'preserve',
        markdown: '新讲稿',
        segments: [{ text: '新讲稿', start: 0, end: 5 }],
        audioResourceId: 'audio-1',
        duration: 6,
        reveals: [{ start: 2, revealElementIds: ['text-1'] }],
      },
    );
    expect(result.slide.animations).toEqual([]);
  });
});

const nativeSlide = (): ReachDeckNativeSlideV2 =>
  parseReachDeckNativeSlideV2({
    schemaVersion: 'reach-deck-slide/v2',
    id: 'slide-1',
    title: '导入页',
    background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
    notes: { doc: richTextFromPlainText('本页强调水循环的三个阶段') },
    elements: [
      { id: 'text-1', type: 'textFrame', transform, zIndex: 1, text: textFrame('水循环') },
      {
        id: 'shape-1',
        type: 'shape',
        transform,
        zIndex: 2,
        geometry: { kind: 'preset', preset: 'roundRect' },
        style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#eeeeee' } } },
        text: textFrame('蒸发 → 凝结 → 降水'),
      },
      {
        id: 'shape-empty',
        type: 'shape',
        transform,
        zIndex: 3,
        geometry: { kind: 'preset', preset: 'ellipse' },
        style: { fill: { kind: 'none' } },
      },
      {
        id: 'image-1',
        type: 'image',
        transform,
        zIndex: 4,
        resourceId: 'media-1',
        fit: 'cover',
        alt: '水循环示意图',
      },
      {
        id: 'video-1',
        type: 'video',
        transform,
        zIndex: 5,
        resourceId: 'media-2',
        playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
        title: '水循环讲解视频',
      },
      {
        id: 'text-hidden',
        type: 'textFrame',
        transform,
        zIndex: 6,
        hidden: true,
        text: textFrame('隐藏文本'),
      },
    ],
    animations: [teacherAnimation],
    duration: 12,
    narration: { segments: [{ text: '旧讲稿', start: 0, end: 3 }] },
  });

describe('summarizeNativeSlideElementsForNarration', () => {
  it('projects selected media identity without raw source prompts or signed links', () => {
    const summaries = summarizeNativeSlideElementsForNarration(nativeSlide(), [
      {
        id: 'media-1',
        objectKey: 'images/water.png',
        contentType: 'image/png',
        digest: 'sha256:test',
        origin: {
          schemaVersion: 'reach-deck-media-origin/v1',
          route: 'diagram',
          title: '<b>水循环</b>',
          description: '科学示意图',
          engine: 'svg',
          license: 'unknown',
        },
      },
    ]);
    expect(summaries.find((entry) => entry.id === 'image-1')?.origin).toEqual({
      route: 'diagram',
      title: '水循环',
      description: '科学示意图',
    });
  });
  it('projects every table cell once with header, span and blank positions and no cell IDs', () => {
    const slide = nativeSlide();
    slide.animations = [];
    slide.elements = [
      {
        id: 'table',
        type: 'table',
        transform,
        zIndex: 1,
        columnWidths: [100, 100, 100],
        rowHeights: [40, 40],
        rows: [
          {
            id: 'row-private-1',
            cells: [
              {
                id: 'cell-private-1',
                header: true,
                rowSpan: 2,
                columnSpan: 1,
                text: textFrame('总量'),
                style: {},
              },
              {
                id: 'cell-private-2',
                header: true,
                rowSpan: 1,
                columnSpan: 2,
                text: textFrame('分类'),
                style: {},
              },
            ],
          },
          {
            id: 'row-private-2',
            cells: [
              { id: 'cell-private-3', rowSpan: 1, columnSpan: 1, text: textFrame(''), style: {} },
              {
                id: 'cell-private-4',
                rowSpan: 1,
                columnSpan: 1,
                text: textFrame('长'.repeat(2600)),
                style: {},
              },
            ],
          },
        ],
      },
    ];
    const summaries = summarizeNativeSlideElementsForNarration(slide);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.type).toBe('table');
    expect(summaries[0]?.text).toContain(
      'header (row 1, column 1; rowSpan 2, columnSpan 1): "总量"',
    );
    expect(summaries[0]?.text).toContain('[covered by row 1, column 1]');
    expect(summaries[0]?.text).toContain('cell (row 2, column 2; rowSpan 1, columnSpan 1): ""');
    expect(summaries[0]?.text).toContain('长'.repeat(2600));
    expect(summaries[0]?.text).not.toContain('private');
    expect(summaries[0]?.text.match(/总量/g)).toHaveLength(1);
    expect(
      summarizeNativeSlideElementsForNarration(
        parseReachDeckNativeSlideV2(JSON.parse(JSON.stringify(slide))),
      ),
    ).toEqual(summaries);
  });

  it('gives a masked image the same media identity, description and default reveal as an image', () => {
    const slide = nativeSlide();
    slide.elements = [
      {
        id: 'masked',
        type: 'shape',
        transform,
        zIndex: 1,
        geometry: { kind: 'preset', preset: 'ellipse' },
        ariaLabel: '水循环示意图',
        style: { fill: { kind: 'image', resourceId: 'media-1', mode: 'cover' } },
      },
    ];
    expect(summarizeNativeSlideElementsForNarration(slide)).toEqual([
      { id: 'masked', type: 'image', text: '水循环示意图' },
    ]);
    const applied = applyReachDeckNarrationToNativeSlide(slide, {
      segments: [{ text: '讲解', start: 0, end: 2, revealElementIds: ['masked'] }],
      duration: 3,
    }).slide;
    expect(applied.animations.find((animation) => animation.targetId === 'masked')?.effect).toBe(
      'fade',
    );
    delete slide.elements[0]!.ariaLabel;
    expect(() => nativeSlideNarrationContentBaseline(slide)).not.toThrow();
    expect(summarizeNativeSlideElementsForNarration(slide)).toEqual([]);
  });

  it('keeps an undescribed masked image out of the summary like an image with an empty alt', () => {
    const slide = nativeSlide();
    slide.elements = [
      {
        id: 'masked',
        type: 'shape',
        transform,
        zIndex: 1,
        geometry: { kind: 'preset', preset: 'ellipse' },
        style: { fill: { kind: 'image', resourceId: 'media-1', mode: 'stretch' } },
      },
      {
        id: 'masked-with-text',
        type: 'shape',
        transform,
        zIndex: 2,
        geometry: { kind: 'preset', preset: 'rect' },
        style: { fill: { kind: 'image', resourceId: 'media-1', mode: 'stretch' } },
        text: textFrame('暮江吟'),
      },
    ];
    expect(summarizeNativeSlideElementsForNarration(slide)).toEqual([
      { id: 'masked-with-text', type: 'image', text: '暮江吟' },
    ]);
  });
  it('serializes textFrame/shape-with-text/image/video into the v1-isomorphic summary shape', () => {
    expect(summarizeNativeSlideElementsForNarration(nativeSlide())).toEqual([
      { id: 'text-1', type: 'text', text: '水循环' },
      { id: 'shape-1', type: 'text', text: '蒸发 → 凝结 → 降水' },
      { id: 'image-1', type: 'image', text: '水循环示意图' },
      { id: 'video-1', type: 'video', text: '水循环讲解视频' },
    ]);
  });

  it('skips hidden elements, textless shapes, and blank summaries', () => {
    const ids = summarizeNativeSlideElementsForNarration(nativeSlide()).map((entry) => entry.id);
    expect(ids).not.toContain('text-hidden');
    expect(ids).not.toContain('shape-empty');
  });

  it('serializes scientific anchors without timing fields', () => {
    const slide = scientificNativeSlideFixture();
    expect(summarizeNativeSlideElementsForNarration(slide)).toEqual([
      {
        id: 'scientific-motion',
        type: 'scientificVisual',
        text: '一个物体沿直线从起点匀速移动到终点。',
        scientificAnchors: [
          { id: 'launch', description: '物体开始运动' },
          { id: 'arrival', description: '物体到达终点' },
        ],
      },
    ]);
  });
});

describe('native narration content baseline', () => {
  it('marks first legacy text edit, preserves audio, survives refresh and clears on undo or regeneration', () => {
    const original = nativeSlide();
    original.narration!.audioResourceId = 'audio-1';
    expect(isNativeSlideNarrationContentStale(original)).toBe(false);
    const changed = structuredClone(original);
    const element = changed.elements[0]!;
    if (element.type !== 'textFrame') throw new Error('fixture');
    element.text.doc = richTextFromPlainText('新知识');
    const marked = preserveNativeSlideNarrationContentBaseline(original, changed);
    expect(marked.narration?.audioResourceId).toBe('audio-1');
    expect(marked.narration?.segments).toEqual(original.narration?.segments);
    expect(
      isNativeSlideNarrationContentStale(
        parseReachDeckNativeSlideV2(JSON.parse(JSON.stringify(marked))),
      ),
    ).toBe(true);
    const undone = { ...original, narration: marked.narration };
    expect(isNativeSlideNarrationContentStale(undone)).toBe(false);
    const regenerated = applyReachDeckNarrationToNativeSlide(marked, {
      segments: [{ text: '新讲稿', start: 0, end: 2 }],
      audioResourceId: 'audio-2',
      duration: 3,
    }).slide;
    expect(isNativeSlideNarrationContentStale(regenerated)).toBe(false);
    expect(regenerated.narration?.contentBaseline).toBe(
      nativeSlideNarrationContentBaseline(changed),
    );
    const failed = applyReachDeckNarrationToNativeSlide(marked, {
      markdown: '新讲稿',
      segments: [],
      duration: 3,
    }).slide;
    expect(failed.narration?.contentBaseline).toBe(marked.narration?.contentBaseline);
    expect(isNativeSlideNarrationContentStale(failed)).toBe(true);
  });

  it('does not mark geometry or style edits or pages with no narration', () => {
    const original = nativeSlide();
    const moved = structuredClone(original);
    moved.elements[0]!.transform.x += 100;
    moved.elements[0]!.opacity = 0.5;
    expect(preserveNativeSlideNarrationContentBaseline(original, moved).narration).toEqual(
      original.narration,
    );
    delete moved.narration;
    expect(preserveNativeSlideNarrationContentBaseline(original, moved).narration).toBeUndefined();
  });
});

describe('stripReachDeckNativeSlideNarration', () => {
  it('removes only narration, animations, and duration', () => {
    const slide = nativeSlide();
    const stripped = stripReachDeckNativeSlideNarration(slide);
    expect(stripped).not.toHaveProperty('narration');
    expect(stripped).not.toHaveProperty('animations');
    expect(stripped).not.toHaveProperty('duration');
    expect(stripped.elements).toEqual(slide.elements);
    expect(stripped.title).toBe(slide.title);
    expect(stripped.notes).toEqual(slide.notes);
  });

  it('is stable across narration rewrites (digest input does not drift)', () => {
    const slide = nativeSlide();
    const rewritten = applyReachDeckNarrationToNativeSlide(slide, {
      segments: [{ text: '新讲稿', start: 0, end: 4, revealElementIds: ['shape-1'] }],
      audioResourceId: 'media-audio',
      duration: 5,
    }).slide;
    expect(stripReachDeckNativeSlideNarration(rewritten)).toEqual(
      stripReachDeckNativeSlideNarration(slide),
    );
  });
});

describe('applyReachDeckNarrationToNativeSlide', () => {
  const segments = [
    { text: '第一段：先看标题。', start: 0, end: 3.5 },
    {
      text: '第二段：要点出现。',
      start: 3.5,
      end: 8,
      revealElementIds: ['shape-1'],
      revealEffect: 'zoom' as const,
    },
    { text: '第三段：看示意图。', start: 8, end: 12.5, revealElementIds: ['image-1', 'video-1'] },
  ];

  it('writes narration, audioResourceId, duration, and preset entrance animations', () => {
    const result = applyReachDeckNarrationToNativeSlide(nativeSlide(), {
      segments,
      audioResourceId: 'media-audio',
      duration: 13.5,
    });
    const slide = result.slide;
    expect(slide.narration).toEqual({
      contentBaseline: nativeSlideNarrationContentBaseline(slide),
      audioResourceId: 'media-audio',
      segments: [
        { text: '第一段：先看标题。', start: 0, end: 3.5 },
        { text: '第二段：要点出现。', start: 3.5, end: 8 },
        { text: '第三段：看示意图。', start: 8, end: 12.5 },
      ],
    });
    expect(slide.duration).toBe(13.5);
    const narrationAnimations = slide.animations.filter(isReachDeckNarrationDrivenAnimation);
    // shape-1 用模型选择的 zoom 预设；image-1 回落 fade；video-1 已被教师动画占用之外的
    // 情形——这里教师动画目标是 image-1，故 image-1 跳过、video-1 回落 fade。
    expect(narrationAnimations.map((animation) => animation.targetId).sort()).toEqual([
      'shape-1',
      'video-1',
    ]);
    const shapeEntrance = narrationAnimations.find((entry) => entry.targetId === 'shape-1')!;
    expect(shapeEntrance).toMatchObject({
      id: `${REACH_DECK_NARRATION_ANIMATION_ID_PREFIX}shape-1`,
      trigger: 'on-enter',
      effect: 'scale',
      start: 3.5,
    });
    // 教师自建动画原样保留；其目标（image-1）不再叠加讲稿入场动画，并记诊断。
    expect(slide.animations).toContainEqual(teacherAnimation);
    expect(result.diagnostics.some((entry) => entry.includes('image-1'))).toBe(true);
  });

  it('keeps authoritative markdown while replacing derived playback state', () => {
    const invalidated = invalidateReachDeckNativeSlideNarration(nativeSlide(), '精确 \\(x^2\\)');
    const generated = applyReachDeckNarrationToNativeSlide(invalidated, {
      segments: [{ text: '精确 \\(x^2\\)', start: 0, end: 2 }],
      audioResourceId: 'media-new',
      duration: 3,
    }).slide;
    expect(generated.narration).toEqual({
      contentBaseline: nativeSlideNarrationContentBaseline(generated),
      markdown: '精确 \\(x^2\\)',
      audioResourceId: 'media-new',
      segments: [{ text: '精确 \\(x^2\\)', start: 0, end: 2 }],
    });
    expect(() => parseReachDeckNativeSlideV2(generated)).not.toThrow();
  });

  it('writes scientific anchor bindings only with authoritative audio and complete timing', () => {
    const source = scientificNativeSlideFixture();
    const scientificAnchorBindings =
      source.elements[0]!.type === 'scientificVisual'
        ? source.elements[0]!.manifest.anchors.map((anchor, index) => ({
            id: `narration-anchor:scientific-motion:${anchor.id}`,
            elementId: 'scientific-motion',
            anchorId: anchor.id,
            start: index * 2,
            end: (index + 1) * 2,
          }))
        : [];
    const applied = applyReachDeckNarrationToNativeSlide(source, {
      markdown: '科学讲稿',
      segments: [{ text: '科学讲稿', start: 0, end: 4 }],
      audioResourceId: 'scientific-audio',
      scientificAnchorBindings,
      duration: 5,
    }).slide;
    expect(applied.narration?.scientificAnchorBindings).toEqual(scientificAnchorBindings);
    expect(parseReachDeckNativeSlideV2(applied)).toBe(applied);

    const invalidatedDraft = applyReachDeckNarrationToNativeSlide(applied, {
      markdown: '待重试科学讲稿',
      segments: [{ text: '待重试科学讲稿' }],
      scientificAnchorBindings,
      duration: 5,
    }).slide;
    expect(invalidatedDraft.narration).toEqual({
      markdown: '待重试科学讲稿',
      contentBaseline: nativeSlideNarrationContentBaseline(invalidatedDraft),
    });
    expect(invalidatedDraft.narration).not.toHaveProperty('scientificAnchorBindings');
  });

  it('cannot create mixed authoritative text and incomplete derived state', () => {
    const invalidated = invalidateReachDeckNativeSlideNarration(nativeSlide(), '精确讲稿');
    const failed = applyReachDeckNarrationToNativeSlide(invalidated, {
      segments: [{ text: '精确讲稿' }],
      duration: 3,
    });
    expect(failed.slide.narration).toEqual({ markdown: '精确讲稿' });
    expect(failed.slide).not.toHaveProperty('duration');
    expect(failed.slide.animations).toEqual([teacherAnimation]);
    expect(failed.diagnostics.some((entry) => entry.includes('可重试'))).toBe(true);
    expect(() => parseReachDeckNativeSlideV2(failed.slide)).not.toThrow();
  });

  it('persists word-level timestamps only on segments with a valid window', () => {
    const words = [
      { text: '第一', start: 0, end: 1.5 },
      { text: '段。', start: 1.5, end: 3.5 },
    ];
    const result = applyReachDeckNarrationToNativeSlide(nativeSlide(), {
      segments: [
        { text: '第一段。', start: 0, end: 3.5, words },
        // 无段级窗口（降级）：词级无从锚定，写回时应剔除。
        { text: '第二段。', words },
      ],
      duration: 10.5,
    });
    expect(result.slide.narration?.segments?.[0]).toEqual({
      text: '第一段。',
      start: 0,
      end: 3.5,
      words,
    });
    expect(result.slide.narration?.segments?.[1]).toEqual({ text: '第二段。' });
    // 写回产物必须通过严格 v2 校验（words 已进 schema 白名单）。
    expect(() => parseReachDeckNativeSlideV2(result.slide)).not.toThrow();
  });

  it('replaces previously narration-driven animations instead of stacking them', () => {
    const first = applyReachDeckNarrationToNativeSlide(nativeSlide(), {
      segments,
      audioResourceId: 'media-audio',
      duration: 13.5,
    }).slide;
    const second = applyReachDeckNarrationToNativeSlide(first, {
      segments: [{ text: '重写讲稿。', start: 0, end: 6, revealElementIds: ['shape-1'] }],
      duration: 7,
    }).slide;
    const narrationAnimations = second.animations.filter(isReachDeckNarrationDrivenAnimation);
    expect(narrationAnimations).toHaveLength(1);
    expect(narrationAnimations[0]).toMatchObject({ targetId: 'shape-1', effect: 'fade', start: 0 });
    expect(second.animations).toContainEqual(teacherAnimation);
  });

  it('skips unknown reveal targets with a diagnostic and omits empty narration', () => {
    const result = applyReachDeckNarrationToNativeSlide(nativeSlide(), {
      segments: [{ text: '  ', start: 0, end: 1, revealElementIds: ['ghost'] }],
      duration: 2,
    });
    expect(result.slide.narration).toBeUndefined();
    expect(result.slide.animations.filter(isReachDeckNarrationDrivenAnimation)).toHaveLength(0);
    expect(result.diagnostics.some((entry) => entry.includes('ghost'))).toBe(true);
  });

  it('produces a strictly valid v2 slide whose animation timing matches the narration', () => {
    // 集成用例：写回产物过 parseReachDeckNativeSlideV2 严格校验，
    // 且 playbackV2 的时序与讲稿段 start 一致（讲到即出现）。
    const applied = applyReachDeckNarrationToNativeSlide(nativeSlide(), {
      segments,
      audioResourceId: 'media-audio',
      duration: 13.5,
    }).slide;
    const parsed = parseReachDeckNativeSlideV2(structuredClone(applied));
    // shape-1 在其讲稿段开始前不可见，段开始后按预设入场，动画结束后完全可见。
    expect(resolveNativeV2ElementPlaybackState(parsed, 'shape-1', 3.4).visible).toBe(false);
    expect(resolveNativeV2ElementPlaybackState(parsed, 'shape-1', 3.6).visible).toBe(true);
    const settled = resolveNativeV2ElementPlaybackState(parsed, 'shape-1', 5);
    expect(settled).toMatchObject({ visible: true, opacity: 1 });
    // 教师动画目标（image-1）沿用教师动画自己的时序（move 属入场类：start=2 前隐藏）。
    expect(resolveNativeV2ElementPlaybackState(parsed, 'image-1', 1.9).visible).toBe(false);
    expect(resolveNativeV2ElementPlaybackState(parsed, 'image-1', 3.1).visible).toBe(true);
  });
});

describe('invalidateReachDeckNativeSlideNarration', () => {
  it('preserves canonical markdown and teacher animations while removing derived state', () => {
    const withNarrationAnimation = applyReachDeckNarrationToNativeSlide(nativeSlide(), {
      markdown: '旧讲稿',
      segments: [{ text: '旧讲稿', start: 0, end: 4, revealElementIds: ['shape-1'] }],
      audioResourceId: 'old-audio',
      duration: 5,
    }).slide;
    const invalidated = invalidateReachDeckNativeSlideNarration(
      withNarrationAnimation,
      '新讲稿\n\n\\[x^2\\]',
    );
    expect(invalidated.narration).toEqual({
      markdown: '新讲稿\n\n\\[x^2\\]',
      contentBaseline: nativeSlideNarrationContentBaseline(invalidated),
    });
    expect(invalidated).not.toHaveProperty('duration');
    expect(invalidated.animations).toEqual([teacherAnimation]);
    expect(invalidated.animations.some(isReachDeckNarrationDrivenAnimation)).toBe(false);
    expect(() => parseReachDeckNativeSlideV2(invalidated)).not.toThrow();
  });

  it('atomically removes scientific anchor bindings with the other derived narration state', () => {
    const slide = scientificNativeSlideFixture();
    slide.duration = 6;
    slide.narration = {
      markdown: '旧讲稿',
      audioResourceId: 'old-audio',
      segments: [{ text: '旧讲稿', start: 0, end: 6 }],
      scientificAnchorBindings: [
        {
          id: 'narration-anchor:scientific-motion:launch',
          elementId: 'scientific-motion',
          anchorId: 'launch',
          start: 0,
          end: 3,
        },
      ],
    };
    const invalidated = invalidateReachDeckNativeSlideNarration(slide, '新讲稿');
    expect(invalidated.narration).toEqual({ markdown: '新讲稿' });
    expect(invalidated).not.toHaveProperty('duration');
    expect(parseReachDeckNativeSlideV2(invalidated)).toBe(invalidated);
  });
});

describe('applyReachDeckTextOnlyNarrationToNativeSlide', () => {
  it('lands rewritten text against the current layout and drops derived audio state', () => {
    const narrated = applyReachDeckNarrationToNativeSlide(nativeSlide(), {
      markdown: '旧讲稿',
      segments: [{ text: '旧讲稿', start: 0, end: 4, revealElementIds: ['shape-1'] }],
      audioResourceId: 'old-audio',
      duration: 5,
    }).slide;
    const staleBaseline: ReachDeckNativeSlideV2 = {
      ...narrated,
      narration: { ...narrated.narration!, contentBaseline: '[]' },
    };
    expect(isNativeSlideNarrationContentStale(staleBaseline)).toBe(true);

    const landed = applyReachDeckTextOnlyNarrationToNativeSlide(staleBaseline, '新讲稿');

    expect(landed.narration).toEqual({
      contentBaseline: nativeSlideNarrationContentBaseline(staleBaseline),
      markdown: '新讲稿',
    });
    expect(isNativeSlideNarrationContentStale(landed)).toBe(false);
    expect(landed).not.toHaveProperty('duration');
    expect(landed.animations).toEqual([teacherAnimation]);
    expect(parseReachDeckNativeSlideV2(landed)).toEqual(landed);
  });
});
