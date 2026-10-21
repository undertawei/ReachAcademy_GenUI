import { describe, expect, it } from 'vitest';
import {
  REACH_DECK_NARRATION_ANIMATION_ID_PREFIX,
  type ReachDeckNativeSlideV2,
  type ReachDeckPublishedPage,
} from '@reachany/reach-deck-dsl';

import { deriveReachDeckPageLaneStatuses } from '../src/pageLaneStatus.js';

const slidePage: ReachDeckPublishedPage = {
  pageId: 'page-1',
  order: 1,
  revision: 1,
  sceneType: 'slide',
  title: 'Slide',
};

const quizPage: ReachDeckPublishedPage = {
  pageId: 'page-2',
  order: 2,
  revision: 1,
  sceneType: 'quiz',
  title: 'Quiz',
  scene: {
    schemaVersion: 'reach-quiz-scene/v1',
    id: 'quiz-1',
    title: 'Quiz',
    questions: [],
  } as unknown as Extract<ReachDeckPublishedPage, { sceneType: 'quiz' }>['scene'],
};

const nativeSlide = (
  overrides: Partial<Pick<ReachDeckNativeSlideV2, 'animations' | 'narration'>> = {},
): Pick<ReachDeckNativeSlideV2, 'animations' | 'narration'> => ({
  animations: [],
  ...overrides,
});

const narrationAnimation = {
  id: `${REACH_DECK_NARRATION_ANIMATION_ID_PREFIX}title`,
  targetId: 'title',
  trigger: 'on-enter' as const,
  effect: 'fade' as const,
  start: 0,
  duration: 0.5,
};

describe('deriveReachDeckPageLaneStatuses', () => {
  it('also projects planned lanes from a layout job before a batch view arrives', () => {
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide({
          narration: { markdown: 'Old', audioResourceId: 'old-audio' },
          animations: [narrationAnimation],
        }),
        generationStatus: {
          phase: 'layout',
          state: 'loading',
          affectedLanes: ['layout', 'narration', 'audio'],
        },
      }),
    ).toEqual({
      layout: 'generating',
      narration: 'generating',
      audio: 'generating',
      animation: 'ready',
    });
  });

  it.each(['waiting-dispatch', 'queued', 'running'])(
    'marks planned downstream regeneration as generating during layout (%s)',
    (status) => {
      expect(
        deriveReachDeckPageLaneStatuses({
          page: slidePage,
          nativeSlide: nativeSlide({
            narration: { markdown: 'Old narration', audioResourceId: 'old-audio' },
            animations: [narrationAnimation],
          }),
          locked: true,
          generationStatus: { phase: 'layout', state: 'loading' },
          batchStatuses: [
            {
              kind: 'regeneration',
              status,
              affectedLanes: ['layout', 'narration', 'audio', 'animation'],
            },
          ],
        }),
      ).toEqual({
        layout: 'generating',
        narration: 'generating',
        audio: 'generating',
        animation: 'generating',
      });
    },
  );

  it('projects regeneration onto exactly the selected lanes, including Quiz layout', () => {
    for (const status of ['running', 'failed']) {
      const state = status === 'running' ? 'generating' : 'attention';
      expect(
        deriveReachDeckPageLaneStatuses({
          page: slidePage,
          nativeSlide: nativeSlide({
            narration: { markdown: 'Saved', audioResourceId: 'audio' },
            animations: [narrationAnimation],
          }),
          batchStatuses: [{ kind: 'regeneration', status, affectedLanes: ['layout', 'audio'] }],
        }),
      ).toEqual({ layout: state, narration: 'ready', audio: state, animation: 'ready' });
      expect(
        deriveReachDeckPageLaneStatuses({
          page: quizPage,
          batchStatuses: [{ kind: 'regeneration', status, affectedLanes: ['layout', 'audio'] }],
        }),
      ).toEqual({ layout: state });
    }
  });

  it.each([
    ['narration'],
    ['audio'],
    ['animation'],
    ['audio', 'animation'],
    ['narration', 'audio', 'animation'],
  ] as const)('overrides old ready content only in affected lanes: %j', (...affectedLanes) => {
    for (const state of ['loading', 'failed'] as const) {
      const statuses = deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide({
          narration: { markdown: 'Old narration', audioResourceId: 'audio-1' },
          animations: [narrationAnimation],
        }),
        generationStatus: { phase: 'narration', state, affectedLanes },
      });
      for (const lane of ['narration', 'audio', 'animation'] as const) {
        expect(statuses[lane]).toBe(
          affectedLanes.includes(lane as never)
            ? state === 'loading'
              ? 'generating'
              : 'attention'
            : 'ready',
        );
      }
      expect(statuses.layout).toBe('ready');
    }
  });

  it('reports every lane ready once narration, audio and narration animations landed', () => {
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide({
          narration: { markdown: '讲稿', audioResourceId: 'audio-1' },
          animations: [narrationAnimation],
        }),
      }),
    ).toEqual({ layout: 'ready', narration: 'ready', audio: 'ready', animation: 'ready' });
  });

  it('keeps lanes neutral when a slide simply has no narration yet', () => {
    expect(
      deriveReachDeckPageLaneStatuses({ page: slidePage, nativeSlide: nativeSlide() }),
    ).toEqual({ layout: 'ready', narration: 'none', audio: 'none', animation: 'none' });
  });

  it('marks layout generating while the page is locked or the layout job is loading', () => {
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide(),
        locked: true,
      }),
    ).toMatchObject({ layout: 'generating', narration: 'none' });
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide(),
        generationStatus: { phase: 'layout', state: 'loading' },
      }),
    ).toMatchObject({ layout: 'generating' });
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide(),
        generationStatus: { phase: 'layout', state: 'failed' },
      }),
    ).toMatchObject({ layout: 'attention' });
  });

  it('still reports the batch lanes when the page is also locked', () => {
    // Issue #525：`locked` 让 layout 判成生成中，此前会把整个 batchStatuses 循环一起短路掉，
    // 缩略图只剩一枚蓝色的版面图标，真正在跑的语音/动画通道反而全无状态。
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide({ narration: { markdown: '讲稿', audioResourceId: 'audio-1' } }),
        locked: true,
        batchStatuses: [{ status: 'running', kind: 'media' }],
      }),
    ).toEqual({
      layout: 'generating',
      narration: 'ready',
      audio: 'generating',
      animation: 'generating',
    });
  });

  it('marks only the lanes still missing content as generating during the narration phase', () => {
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide({ narration: { markdown: '讲稿' } }),
        generationStatus: { phase: 'narration', state: 'loading' },
      }),
    ).toEqual({
      layout: 'ready',
      narration: 'ready',
      audio: 'generating',
      animation: 'generating',
    });
  });

  it('points a narration failure at the first missing lane', () => {
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide({ narration: { markdown: '讲稿', audioResourceId: 'audio-1' } }),
        generationStatus: { phase: 'narration', state: 'failed' },
      }),
    ).toEqual({ layout: 'ready', narration: 'ready', audio: 'ready', animation: 'attention' });
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: nativeSlide(),
        generationStatus: { phase: 'narration', state: 'manual-review-required' },
      }),
    ).toMatchObject({ narration: 'attention' });
  });

  it('maps batch kinds onto their lanes even when old content is still present', () => {
    const landed = nativeSlide({
      narration: { markdown: '讲稿', audioResourceId: 'audio-1' },
      animations: [narrationAnimation],
    });
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: landed,
        batchStatuses: [{ kind: 'media', status: 'running' }],
      }),
    ).toEqual({
      layout: 'ready',
      narration: 'ready',
      audio: 'generating',
      animation: 'generating',
    });
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: landed,
        batchStatuses: [{ kind: 'narration', status: 'waiting-predecessor' }],
      }),
    ).toEqual({
      layout: 'ready',
      narration: 'generating',
      audio: 'generating',
      animation: 'generating',
    });
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: landed,
        batchStatuses: [{ kind: 'narration', status: 'failed' }],
      }),
    ).toMatchObject({ narration: 'attention' });
    expect(
      deriveReachDeckPageLaneStatuses({
        page: slidePage,
        nativeSlide: landed,
        batchStatuses: [{ kind: 'media', status: 'blocked' }],
      }),
    ).toMatchObject({ audio: 'attention' });
  });

  it('exposes only the layout lane for quiz pages', () => {
    expect(deriveReachDeckPageLaneStatuses({ page: quizPage })).toEqual({ layout: 'ready' });
  });
});

it('keeps layout ready while failed images retry in their own lane', () => {
  expect(
    deriveReachDeckPageLaneStatuses({ page: slidePage, imageStatus: 'attention' }),
  ).toMatchObject({ layout: 'ready', image: 'attention' });
  expect(
    deriveReachDeckPageLaneStatuses({
      page: slidePage,
      imageStatus: 'attention',
      generationStatus: { phase: 'layout', affectedLanes: ['image'], state: 'loading' },
      batchStatuses: [{ kind: 'regeneration', affectedLanes: ['image'], status: 'active' }],
    }),
  ).toMatchObject({
    layout: 'ready',
    image: 'generating',
    narration: 'none',
    audio: 'none',
    animation: 'none',
  });
});
