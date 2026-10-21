import { describe, expect, it } from 'vitest';
import type { ReachDeckNativeSlideV2 } from '@reachany/reach-deck-dsl';
import { slideBodyFontSize } from '../../lib/reach-deck/slide-body-font-size.js';

type Element = ReachDeckNativeSlideV2['elements'][number];
let nextId = 0;

/** A textFrame whose paragraph carries `size`; `runSize` overrides it on the text run. */
function frame(
  text: string,
  size: number,
  options: { runSize?: number; fontScale?: number; hidden?: boolean } = {},
): Element {
  return {
    id: `t${nextId++}`,
    type: 'textFrame',
    transform: { x: 0, y: 0, width: 400, height: 100, rotation: 0 },
    zIndex: 0,
    ...(options.hidden ? { hidden: true } : {}),
    text: {
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
      verticalAlignment: 'top',
      wrap: true,
      autofit:
        options.fontScale === undefined
          ? { mode: 'none' }
          : { mode: 'shrink-text', fontScale: options.fontScale },
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { fontSize: size },
            content: [
              {
                type: 'text',
                text,
                ...(options.runSize === undefined
                  ? {}
                  : {
                      marks: [{ type: 'textStyle', attrs: { fontSize: `${options.runSize}px` } }],
                    }),
              },
            ],
          },
        ],
      },
      fontSubstitutions: [],
    },
  } as Element;
}

const slide = (...elements: Element[]) => ({ elements }) as unknown as ReachDeckNativeSlideV2;
const body = (length: number) => '正'.repeat(length);

describe('slideBodyFontSize', () => {
  it('uses ordinary body text and excludes titles and footers', () => {
    expect(
      slideBodyFontSize(
        slide(
          frame('相似三角形的判定', 56),
          frame(body(80), 24),
          frame(body(40), 24),
          frame('来源：教材第 3 章', 14),
        ),
      ),
    ).toBe(24);
  });

  it('drops a short subtitle tier that sits within the body bounds', () => {
    expect(
      slideBodyFontSize(
        slide(frame('两组角分别相等', 32), frame(body(60), 20), frame(body(30), 20)),
      ),
    ).toBe(20);
  });

  it('keeps the largest tier when it carries most of the text', () => {
    // 24px paragraphs dominate; the 18px frames are short captions, not the body.
    expect(
      slideBodyFontSize(slide(frame(body(120), 24), frame('图 1', 18), frame('图 2', 18))),
    ).toBe(24);
  });

  it('reads run sizes, autofit scale and grouped or shape text', () => {
    const shape = {
      id: 'shape',
      type: 'shape',
      transform: { x: 0, y: 0, width: 200, height: 100, rotation: 0 },
      zIndex: 0,
      geometry: { kind: 'preset', preset: 'rect' },
      style: {},
      text: (frame(body(50), 22) as { text: unknown }).text,
    } as unknown as Element;
    const group = {
      id: 'group',
      type: 'group',
      transform: { x: 0, y: 0, width: 400, height: 400, rotation: 0 },
      zIndex: 0,
      children: [shape],
    } as unknown as Element;
    expect(slideBodyFontSize(slide(group))).toBe(22);
    expect(slideBodyFontSize(slide(frame(body(50), 30, { runSize: 26 })))).toBe(26);
    expect(slideBodyFontSize(slide(frame(body(50), 30, { fontScale: 0.8 })))).toBe(24);
  });

  it('ignores hidden frames and returns undefined when no body text is measurable', () => {
    expect(slideBodyFontSize(slide())).toBeUndefined();
    expect(slideBodyFontSize(slide(frame('标题', 64), frame('页脚', 12)))).toBeUndefined();
    expect(
      slideBodyFontSize(slide(frame(body(40), 28, { hidden: true }), frame(body(40), 20))),
    ).toBe(20);
  });
});
