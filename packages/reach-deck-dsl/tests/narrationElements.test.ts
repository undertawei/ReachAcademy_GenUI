import { describe, expect, it } from 'vitest';

import { summarizeDeckSlideElementsForNarration } from '../src/narrationElements.js';
import { richTextFromPlainText } from '../src/richText.js';
import type { DeckSlide } from '../src/types.js';
import { scientificVisualElementFixture } from './scientificVisualFixtures.js';

const slide: DeckSlide = {
  id: 'slide-1',
  title: '一页示例',
  layout: 'freeform',
  duration: 12,
  background: '#ffffff',
  elements: [
    {
      id: 'slide-1-title',
      type: 'text',
      frame: { x: 80, y: 64, width: 900, height: 120 },
      layer: 1,
      doc: richTextFromPlainText('一个清晰的观点'),
      variant: 'title',
    },
    {
      id: 'slide-1-image',
      type: 'image',
      frame: { x: 80, y: 240, width: 600, height: 400 },
      layer: 2,
      objectKey: 'reach-deck/media/demo.png',
      alt: '示意图：水循环',
      fit: 'contain',
    },
    {
      id: 'slide-1-clip',
      type: 'video',
      frame: { x: 760, y: 240, width: 600, height: 400 },
      layer: 3,
      src: 'decks/demo/clip.mp4',
      poster: 'decks/demo/clip.jpg',
      title: '取水过程',
    },
  ],
  animations: [],
  voiceTimeline: [],
};

describe('summarizeDeckSlideElementsForNarration', () => {
  it('按元素原序输出 id + 类型 + variant + 纯文本摘要', () => {
    expect(summarizeDeckSlideElementsForNarration(slide)).toEqual([
      { id: 'slide-1-title', type: 'text', variant: 'title', text: '一个清晰的观点' },
      { id: 'slide-1-image', type: 'image', text: '示意图：水循环' },
      { id: 'slide-1-clip', type: 'video', text: '取水过程' },
    ]);
  });

  it('无元素时输出空清单（不抛错，交给调用方决定是否照常跑讲稿）', () => {
    expect(summarizeDeckSlideElementsForNarration({ ...slide, elements: [] })).toEqual([]);
  });

  it('确定性：同一 slide 两次序列化逐字节一致', () => {
    const first = summarizeDeckSlideElementsForNarration(slide);
    const second = summarizeDeckSlideElementsForNarration(slide);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('exposes scientific anchor ids and descriptions without model-authored seconds', () => {
    const visual = scientificVisualElementFixture();
    expect(summarizeDeckSlideElementsForNarration({ ...slide, elements: [visual] })).toEqual([
      {
        id: visual.id,
        type: 'scientificVisual',
        text: visual.manifest.textAlternative,
        scientificAnchors: visual.manifest.anchors,
      },
    ]);
    expect(
      JSON.stringify(summarizeDeckSlideElementsForNarration({ ...slide, elements: [visual] })),
    ).not.toMatch(/start|end|seconds/);
  });

  it('跳过装饰性 shape/line，仅保留带明确非空 ariaLabel 的教学 primitive', () => {
    expect(
      summarizeDeckSlideElementsForNarration({
        ...slide,
        elements: [
          {
            id: 'background-panel',
            type: 'shape',
            frame: { x: 80, y: 200, width: 600, height: 400 },
            layer: 1,
            shape: 'roundRect',
            fillToken: 'accentSoft',
          },
          {
            id: 'decorative-divider',
            type: 'line',
            frame: { x: 100, y: 450, width: 400, height: 1 },
            start: { x: 100, y: 450 },
            end: { x: 500, y: 450 },
            layer: 2,
            role: 'divider',
            colorToken: 'muted',
            ariaLabel: '   ',
          },
          {
            id: 'causal-arrow',
            type: 'line',
            frame: { x: 500, y: 350, width: 200, height: 1 },
            start: { x: 500, y: 350 },
            end: { x: 700, y: 350 },
            layer: 3,
            role: 'arrow',
            colorToken: 'accent',
            ariaLabel: '蒸发导致水汽上升',
          },
        ],
      }),
    ).toEqual([{ id: 'causal-arrow', type: 'line', text: '蒸发导致水汽上升' }]);
  });
});
