import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GenerationSceneType } from '@reachany/reach-deck-dsl';

import { ReachDeckArtifactPreview } from '../src/ReachDeckArtifactPreview';
import { artifactFor } from './artifactFixture';

describe('ReachDeckArtifactPreview real player integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each<GenerationSceneType>(['slide', 'quiz', 'interactive'])(
    'mounts the real %s player branch',
    (sceneType) => {
      act(() => root.render(<ReachDeckArtifactPreview artifact={artifactFor(sceneType)} />));

      expect(container.querySelector(`[data-scene-type="${sceneType}"]`)).not.toBeNull();
    },
  );
});
