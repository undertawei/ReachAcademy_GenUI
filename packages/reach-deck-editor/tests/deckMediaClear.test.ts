import { describe, expect, it } from 'vitest';
import type {
  ReachDeckDocument,
  ReachDeckDocumentV2,
  ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';

import { clearReachDeckDocumentMedia, countReachDeckDocumentMedia } from '../src/deckMediaClear.js';

const fade = {
  trigger: 'on-enter' as const,
  effect: 'fade' as const,
  duration: 1,
  easing: 'linear' as const,
};

const slide = (overrides: Partial<ReachDeckNativeSlideV2>): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'slide',
  title: '页',
  background: { kind: 'none' },
  elements: [
    {
      id: 'shape-1',
      type: 'shape',
      name: '形状',
      transform: { x: 0, y: 0, width: 10, height: 10 },
      zIndex: 1,
      geometry: { kind: 'preset', preset: 'rect' },
      style: { fill: { kind: 'none' } },
    },
  ],
  animations: [],
  ...overrides,
});

const deck = (): ReachDeckDocumentV2 =>
  ({
    schemaVersion: 'reach-deck-document/v2',
    pages: [
      { pageId: 'p1', sceneType: 'slide', title: '一' },
      { pageId: 'p2', sceneType: 'slide', title: '二' },
      {
        pageId: 'p3',
        sceneType: 'interactive',
        title: '三',
        scene: {
          id: 'scene-3',
          narration: {
            schemaVersion: 'reach-interactive-narration/v1',
            text: '互动讲稿',
            audioResourceId: 'audio-3',
          },
        },
      },
      { pageId: 'p4', sceneType: 'slide', title: '四' },
    ],
    nativeSlides: [
      {
        pageId: 'p1',
        slide: slide({
          id: 's1',
          animations: [{ ...fade, id: 'a1', targetId: 'shape-1', start: 2 }],
          narration: {
            markdown: '讲稿一',
            audioResourceId: 'audio-1',
            segments: [{ text: '讲稿一', start: 0, end: 6 }],
          },
          duration: 7,
        }),
      },
      {
        pageId: 'p2',
        // 旧数据只有分段文字、没有 Markdown。
        slide: slide({
          id: 's2',
          narration: {
            audioResourceId: 'audio-2',
            segments: [{ text: '旧讲稿', start: 0, end: 4 }],
          },
          duration: 5,
        }),
      },
      {
        pageId: 'p4',
        slide: slide({
          id: 's4',
          animations: [{ ...fade, id: 'a4', targetId: 'shape-1', start: 3 }],
          duration: 4,
        }),
      },
    ],
    resources: { media: [] },
  }) as unknown as ReachDeckDocumentV2;

const slideOf = (document: ReachDeckDocument, pageId: string) =>
  document.schemaVersion === 'reach-deck-document/v2'
    ? document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide
    : undefined;

describe('clearReachDeckDocumentMedia', () => {
  it('counts pages that currently hold audio or animations', () => {
    expect(countReachDeckDocumentMedia(deck())).toEqual({ audioPages: 3, animationPages: 2 });
    expect(countReachDeckDocumentMedia(undefined)).toEqual({ audioPages: 0, animationPages: 0 });
  });

  it('removes audio but keeps narration text, and lets remaining animations own the duration', () => {
    const result = clearReachDeckDocumentMedia(deck(), { audio: true, animation: false });
    expect(result.changedPageIds.sort()).toEqual(['p1', 'p2', 'p3']);
    const first = slideOf(result.document, 'p1')!;
    expect(first.narration).toEqual({ markdown: '讲稿一' });
    expect(first.animations).toHaveLength(1);
    expect(first.duration).toBe(3);
    // 缺 Markdown 的旧讲稿由分段文字补成 Markdown，讲稿内容不丢。
    const second = slideOf(result.document, 'p2')!;
    expect(second.narration?.markdown).toContain('旧讲稿');
    expect(second.narration?.segments).toBeUndefined();
    expect(second.duration).toBeUndefined();
    const interactive = result.document.pages.find((page) => page.pageId === 'p3');
    expect(interactive?.sceneType === 'interactive' && interactive.scene.narration).toEqual({
      schemaVersion: 'reach-interactive-narration/v1',
      text: '互动讲稿',
    });
  });

  it('removes animations, keeping the audio-owned duration where audio remains', () => {
    const result = clearReachDeckDocumentMedia(deck(), { audio: false, animation: true });
    expect(result.changedPageIds).toEqual(['p1', 'p4']);
    expect(slideOf(result.document, 'p1')).toMatchObject({ animations: [], duration: 7 });
    expect(slideOf(result.document, 'p4')?.animations).toEqual([]);
    expect(slideOf(result.document, 'p4')?.duration).toBeUndefined();
  });

  it('skips locked pages and returns the same document when nothing changes', () => {
    const source = deck();
    const result = clearReachDeckDocumentMedia(
      source,
      { audio: true, animation: true },
      new Set(['p1', 'p3']),
    );
    expect(result.skippedPageIds.sort()).toEqual(['p1', 'p3']);
    expect(result.changedPageIds.sort()).toEqual(['p2', 'p4']);
    expect(slideOf(result.document, 'p1')).toBe(slideOf(source, 'p1'));

    const cleared = clearReachDeckDocumentMedia(result.document, { audio: true, animation: true });
    const again = clearReachDeckDocumentMedia(
      { ...cleared.document },
      { audio: false, animation: false },
    );
    expect(again.changedPageIds).toEqual([]);
  });
});
