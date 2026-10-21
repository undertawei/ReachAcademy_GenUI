import { describe, expect, it } from 'vitest';
import { richTextFromPlainText, type ReachDeckNativeElementV2 } from '@reachany/reach-deck-dsl';

import {
  ELEMENT_CHIP_DETAIL_MAX_CHARACTERS,
  locateNativeElement,
  nativeElementChipInfo,
  resolveClarificationCandidates,
} from '../src/assistantClarification';
import { createEditorDocument } from './fixture';

const textFrame = (id: string, text: string, x = 0, y = 0): ReachDeckNativeElementV2 => ({
  id,
  type: 'textFrame',
  transform: { x, y, width: 100, height: 40 },
  zIndex: 1,
  text: {
    margins: { left: 0, top: 0, right: 0, bottom: 0 },
    verticalAlignment: 'top',
    wrap: true,
    autofit: { mode: 'none' },
    doc: richTextFromPlainText(text),
    fontSubstitutions: [],
  },
});

describe('assistant clarification helpers', () => {
  it('locates group children in stage coordinates', () => {
    const group: ReachDeckNativeElementV2 = {
      id: 'group-1',
      type: 'group',
      transform: { x: 200, y: 100, width: 400, height: 300 },
      zIndex: 1,
      children: [textFrame('child-1', '子元素', 30, 40)],
    };
    expect(locateNativeElement([group], 'child-1')?.box).toEqual({
      x: 230,
      y: 140,
      width: 100,
      height: 40,
    });
    expect(locateNativeElement([group], 'missing')).toBeUndefined();
  });

  it('follows the rotation and flips of enclosing groups like the renderer', () => {
    // 组合 200×100，中心 (150,100)；子元素中心在组合内 (150,50)，即相对中心 (+50,0)。
    const child = {
      ...textFrame('child-1', '子元素', 100, 30),
      transform: { x: 100, y: 30, width: 100, height: 40, rotation: 10 },
    };
    const rotated: ReachDeckNativeElementV2 = {
      id: 'group-1',
      type: 'group',
      transform: { x: 50, y: 50, width: 200, height: 100, rotation: 90 },
      zIndex: 1,
      children: [child],
    };
    const rotatedBox = locateNativeElement([rotated], 'child-1')?.box;
    // 顺时针 90°：(+50,0) → (0,+50)，中心 (150,150)。
    expect(rotatedBox?.x).toBeCloseTo(100);
    expect(rotatedBox?.y).toBeCloseTo(130);
    expect(rotatedBox?.rotation).toBeCloseTo(100);

    const flipped: ReachDeckNativeElementV2 = {
      ...rotated,
      transform: { x: 50, y: 50, width: 200, height: 100, flipHorizontal: true },
    };
    const flippedBox = locateNativeElement([flipped], 'child-1')?.box;
    // 水平翻转：(+50,0) → (-50,0)，中心 (100,100)；子元素旋转取反。
    expect(flippedBox?.x).toBeCloseTo(50);
    expect(flippedBox?.y).toBeCloseTo(80);
    expect(flippedBox?.rotation).toBeCloseTo(-10);
  });

  it('marks candidates unavailable when the page, element or revision no longer matches', () => {
    const document = createEditorDocument();
    const resolved = resolveClarificationCandidates(document, [
      { pageId: 'page-1', pageRevision: 1, elementId: 'title-1', label: 'a' },
      { pageId: 'page-1', pageRevision: 2, elementId: 'title-1', label: 'b' },
      { pageId: 'page-1', pageRevision: 1, elementId: 'gone', label: 'c' },
      { pageId: 'page-x', pageRevision: 1, elementId: 'title-1', label: 'd' },
    ]);
    expect(resolved.map((item) => [item.index, item.state, item.pageOrder])).toEqual([
      [1, 'available', 1],
      [2, 'unavailable', 1],
      [3, 'unavailable', 1],
      [4, 'unavailable', undefined],
    ]);
    expect(resolved[0]?.box).toEqual({ x: 80, y: 72, width: 1100, height: 120 });
    expect(resolved[1]?.box).toBeDefined();
    expect(resolved[2]?.box).toBeUndefined();
  });

  it('describes elements with a bounded detail and an image resource for thumbnails', () => {
    const long = '一二三四五六七八九十'.repeat(3);
    expect(nativeElementChipInfo(textFrame('t', `  ${long}  `))).toEqual({
      type: 'textFrame',
      detail: `${Array.from(long).slice(0, ELEMENT_CHIP_DETAIL_MAX_CHARACTERS).join('')}…`,
    });
    expect(nativeElementChipInfo(textFrame('t', '   '))).toEqual({ type: 'textFrame' });
    expect(
      nativeElementChipInfo({
        id: 'img',
        type: 'image',
        resourceId: 'media-1',
        fit: 'contain',
        alt: '细胞示意图',
        transform: { x: 0, y: 0, width: 10, height: 10 },
        zIndex: 1,
      }),
    ).toEqual({ type: 'image', detail: '细胞示意图', imageResourceId: 'media-1' });
  });
});
