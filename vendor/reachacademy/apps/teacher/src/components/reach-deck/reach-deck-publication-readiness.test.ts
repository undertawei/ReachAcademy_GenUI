import { describe, expect, it } from 'vitest';

import { createEditorDocument } from '../../../../../packages/reach-deck-editor/tests/fixture';
import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';
import {
  reachDeckPublicationBlockers,
  summarizeReachDeckPageNumbers,
} from './reach-deck-publication-readiness';

function slideDocument(): ReachDeckDocument {
  return createEditorDocument();
}

describe('reachDeckPublicationBlockers', () => {
  it('finds slide narration whose audio or timings have not been generated', () => {
    const document = slideDocument();
    document.nativeSlides[0]!.slide.narration = { markdown: '讲稿' };
    expect(reachDeckPublicationBlockers(document)).toEqual({
      incompletePageNumbers: [],
      missingAudioPageNumbers: [1],
    });

    document.nativeSlides[0]!.slide.narration = {
      markdown: '讲稿',
      audioResourceId: 'audio-1',
      segments: [],
    };
    expect(reachDeckPublicationBlockers(document).missingAudioPageNumbers).toEqual([1]);
  });

  it('finds interactive narration and slide audio gaps in visible page order', () => {
    const document = slideDocument();
    document.pages.unshift({
      pageId: 'interactive-1',
      order: 1,
      revision: 1,
      sceneType: 'interactive',
      title: 'Question',
      scene: {
        schemaVersion: 'reach-interactive-scene/v2',
        id: 'interactive-1',
        title: 'Question',
        sceneType: 'interactive',
        documentHtml: '<p>Question</p>',
        bridgeVersion: 'reach-interactive-bridge/v1',
        runtimePolicy: {
          completionMode: 'explicit',
          allowReset: true,
          maximumDurationSeconds: null,
        },
        eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
        narration: { schemaVersion: 'reach-interactive-narration/v1', text: '请回答' },
      },
    });
    document.nativeSlides[0]!.slide.narration = { markdown: '讲稿' };
    expect(reachDeckPublicationBlockers(document).missingAudioPageNumbers).toEqual([1, 2]);
  });

  it('uses the displayed page order even when the document array is unsorted', () => {
    const document = slideDocument();
    const firstPage = document.pages[0]!;
    document.pages = [
      { ...firstPage, pageId: 'page-2', order: 2 },
      { ...firstPage, order: 1 },
    ];
    document.nativeSlides[0]!.slide.narration = { markdown: '讲稿' };
    expect(reachDeckPublicationBlockers(document).missingAudioPageNumbers).toEqual([1]);
  });

  it('separates missing or unfinished slides from missing narration audio', () => {
    const document = slideDocument();
    document.nativeSlides[0]!.slide.id = 'generation-placeholder:page-1';
    document.nativeSlides[0]!.slide.narration = { markdown: '讲稿' };
    expect(reachDeckPublicationBlockers(document)).toEqual({
      incompletePageNumbers: [1],
      missingAudioPageNumbers: [],
    });
  });
});

describe('summarizeReachDeckPageNumbers', () => {
  it('uses the interface locale and bounds long page lists', () => {
    const pages = [1, 2, 3, 4, 5, 6, 7];
    const english = summarizeReachDeckPageNumbers(pages, 'en-US');
    const chinese = summarizeReachDeckPageNumbers(pages, 'zh-CN');
    expect(english).toEqual({ pages: '1, 2, 3, 4, & 5', remaining: 2 });
    expect(chinese.remaining).toBe(2);
    expect(chinese.pages).toContain('1');
    expect(chinese.pages).not.toContain('6');
  });
});
