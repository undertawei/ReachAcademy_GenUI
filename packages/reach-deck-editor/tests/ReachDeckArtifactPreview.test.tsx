import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationSceneType, ReachDeckDocument } from '@reachany/reach-deck-dsl';
import {
  createBlankReachDeckDocument,
  type GeneratedNativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import type { ReachDeckPlayerProps } from '@reachany/reach-deck-player';

import { ReachDeckArtifactPreview } from '../src/ReachDeckArtifactPreview';
import { artifactFor } from './artifactFixture';
import '../styles.css';

const renderedPlayerProps: ReachDeckPlayerProps[] = [];

vi.mock('@reachany/reach-deck-player', () => ({
  ReachDeckPlayer: (props: ReachDeckPlayerProps) => {
    renderedPlayerProps.push(props);
    const page = props.document.pages[0];
    return (
      <div
        data-preview-scene-id={
          page?.sceneType === 'slide'
            ? props.document.nativeSlides.find((binding) => binding.pageId === page.pageId)?.slide
                .id
            : page?.scene?.id
        }
        data-preview-scene-type={page?.sceneType}
      >
        {page?.title}
      </div>
    );
  },
}));

describe('ReachDeckArtifactPreview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    renderedPlayerProps.length = 0;
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('preserves Native geometry and forwards the authorized media map to Player', () => {
    const legacy = artifactFor('slide');
    if (legacy.sceneType !== 'slide') throw new Error('Fixture mismatch');
    const blank = createBlankReachDeckDocument({
      id: 'native-preview',
      title: 'Native preview',
      generatedAt: legacy.generatedAt,
    });
    const artifact: GeneratedNativeSlideArtifact = {
      runId: legacy.runId,
      pageId: legacy.pageId,
      requestedRevision: legacy.requestedRevision,
      attempt: legacy.attempt,
      generatedAt: legacy.generatedAt,
      status: 'ready',
      sceneType: 'slide',
      schemaVersion: 'reach-deck-slide-artifact/v2',
      nativeSlide: blank.nativeSlides[0]!.slide,
      resources: blank.resources,
      generationMetadata: legacy.generationMetadata,
    };
    const urls = { image: '/authorized/image' };
    act(() =>
      root.render(<ReachDeckArtifactPreview artifact={artifact} resourceUrlsById={urls} />),
    );
    const props = renderedPlayerProps.at(-1)!;
    expect(props.document.nativeSlides[0]!.slide).toEqual(artifact.nativeSlide);
    expect(props.document.pages[0]).not.toHaveProperty('scene');
    expect(props.nativeResourceUrlsById).toBe(urls);
  });

  it.each<GenerationSceneType>(['slide', 'quiz', 'interactive'])(
    'dispatches the actual %s artifact through the player',
    (sceneType) => {
      const artifact = artifactFor(sceneType);
      act(() =>
        root.render(
          <ReachDeckArtifactPreview
            artifact={artifact}
            locale="zh-CN"
            revision={7}
            theme={{ ...theme, accent: '#7c3aed' }}
            title={`${sceneType} review`}
          />,
        ),
      );

      const props = renderedPlayerProps.at(-1);
      const page = props?.document.pages[0];
      expect(page).toMatchObject({
        pageId: artifact.pageId,
        revision: 7,
        sceneType,
        title: `${sceneType} review`,
      });
      if (sceneType === 'slide') {
        expect(
          props?.document.nativeSlides.find((binding) => binding.pageId === artifact.pageId)?.slide,
        ).toBeDefined();
      } else {
        if (page?.sceneType === 'slide' || page === undefined)
          throw new Error('Expected non-slide page');
        expect(page?.scene).toEqual(artifact.scene);
      }
      expect(props?.document.theme.accent).toBe('#7c3aed');
      expect(props?.locale).toBe('zh-CN');
      expect(container.querySelector('[data-preview-scene-type]')?.textContent).toBe(
        `${sceneType} review`,
      );
    },
  );

  it('does not render the removed runtime layout-warning surface', () => {
    act(() => root.render(<ReachDeckArtifactPreview artifact={artifactFor('slide')} />));

    expect(container.querySelector('[aria-label="幻灯片布局问题"]')).toBeNull();
  });

  it('allows local player interaction without wiring learner persistence callbacks', () => {
    act(() => root.render(<ReachDeckArtifactPreview artifact={artifactFor('quiz')} />));

    expect(
      container.querySelector('.reach-deck-generation__artifact-player')?.hasAttribute('inert'),
    ).toBe(false);
    expect(renderedPlayerProps).toHaveLength(1);
    expect(renderedPlayerProps[0]).toEqual({
      document: expect.any(Object) as ReachDeckDocument,
      locale: 'en-US',
      // Teacher generation preview grades locally; learner hosts keep the server default.
      quizGradingMode: 'trial',
    });
    expect(renderedPlayerProps[0]?.onEvent).toBeUndefined();
    expect(renderedPlayerProps[0]?.onPageChange).toBeUndefined();
    expect(container.querySelector('article')?.getAttribute('aria-label')).toContain('页面播放器');
    expect(container.querySelector('header')?.textContent).toContain('页面播放器');
    const player = container.querySelector('.reach-deck-generation__artifact-player');
    expect(window.getComputedStyle(player!).pointerEvents).not.toBe('none');
    expect(window.getComputedStyle(player!).userSelect).not.toBe('none');
  });

  it('exposes the complete scene through a keyboard-accessible read-only representation', () => {
    act(() => root.render(<ReachDeckArtifactPreview artifact={artifactFor('quiz')} />));

    const details = container.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toContain('无障碍只读内容详情');
    expect(details?.querySelector('pre')?.textContent).toContain('The candidate is visible.');
    expect(details?.querySelector('pre')?.textContent).toContain('after_submit');
  });
});

const theme = {
  name: 'Reach',
  background: '#ffffff',
  surface: '#f8fafc',
  ink: '#172024',
  muted: '#647178',
  accent: '#2563eb',
  success: '#15803d',
  warning: '#b45309',
  fontDisplay: 'Inter',
  fontBody: 'Inter',
};
