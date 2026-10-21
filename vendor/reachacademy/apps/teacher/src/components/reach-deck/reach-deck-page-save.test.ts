import { createBlankReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import { isSynchronizedReachDeckPageTitleChange } from './reach-deck-page-save';

const pageId = 'deck-title-save:page-1';

function createSlideDocument(): ReachDeckDocument {
  return createBlankReachDeckDocument({ id: 'deck-title-save', title: 'Stored title' });
}

function createQuizDocument(): ReachDeckDocument {
  const document = createSlideDocument();
  const page = document.pages[0]!;
  return {
    ...document,
    pages: [
      {
        ...page,
        sceneType: 'quiz',
        title: 'Stored page title',
        scene: {
          schemaVersion: 'reach-quiz-scene/v1',
          id: pageId,
          title: 'Stored scene title',
          sceneType: 'quiz',
          content: {
            questions: [],
            display_mode: 'single_question',
            navigation: 'horizontal',
            show_progress: true,
            show_question_index: true,
            answer_reveal: 'after_submit',
            allow_previous: true,
            allow_skip: true,
          },
        },
      },
    ],
    nativeSlides: [],
  };
}

describe('isSynchronizedReachDeckPageTitleChange', () => {
  it('accepts a synchronized slide page and native slide title change', () => {
    const baseline = createSlideDocument();
    const candidate = structuredClone(baseline);
    candidate.pages[0]!.title = 'Renamed title';
    candidate.nativeSlides[0]!.slide.title = 'Renamed title';

    expect(isSynchronizedReachDeckPageTitleChange(baseline, candidate, pageId)).toBe(true);
  });

  it('rejects a slide change that only updates the page title', () => {
    const baseline = createSlideDocument();
    const candidate = structuredClone(baseline);
    candidate.pages[0]!.title = 'Renamed title';

    expect(isSynchronizedReachDeckPageTitleChange(baseline, candidate, pageId)).toBe(false);
  });

  it('rejects a slide change that only updates the native slide title', () => {
    const baseline = createSlideDocument();
    const candidate = structuredClone(baseline);
    candidate.nativeSlides[0]!.slide.title = 'Renamed title';

    expect(isSynchronizedReachDeckPageTitleChange(baseline, candidate, pageId)).toBe(false);
  });

  it('rejects a scene type change', () => {
    const baseline = createSlideDocument();
    const candidate = createQuizDocument();

    expect(isSynchronizedReachDeckPageTitleChange(baseline, candidate, pageId)).toBe(false);
  });

  it('accepts synchronized non-slide page and scene titles', () => {
    const baseline = createQuizDocument();
    const candidate = structuredClone(baseline);
    const candidatePage = candidate.pages[0]!;
    if (candidatePage.sceneType !== 'quiz') throw new Error('Expected a quiz page');
    candidatePage.title = 'Renamed title';
    candidatePage.scene.title = 'Renamed title';

    expect(isSynchronizedReachDeckPageTitleChange(baseline, candidate, pageId)).toBe(true);
  });

  it('rejects non-slide page and scene titles that changed out of sync', () => {
    const baseline = createQuizDocument();
    const candidate = structuredClone(baseline);
    const candidatePage = candidate.pages[0]!;
    if (candidatePage.sceneType !== 'quiz') throw new Error('Expected a quiz page');
    candidatePage.title = 'Renamed page title';
    candidatePage.scene.title = 'Different scene title';

    expect(isSynchronizedReachDeckPageTitleChange(baseline, candidate, pageId)).toBe(false);
  });
});
