import { describe, expect, it } from 'vitest';
import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';

import { reconcileReachDeckRuntime } from '../src/sceneRuntime.js';

const documentAt = (revision: number): ReachDeckDocument => ({
  schemaVersion: 'reach-deck-document/v2',
  id: 'deck',
  title: 'Deck',
  stage: { width: 1600, height: 900, aspectRatio: '16:9' },
  theme: {
    name: 'Reach',
    background: '#fff',
    surface: '#fff',
    ink: '#111',
    muted: '#666',
    accent: '#06c',
    success: '#080',
    warning: '#a50',
    fontDisplay: 'Inter',
    fontBody: 'Inter',
  },
  defaultThemeId: 'theme',
  resources: {
    themes: [
      {
        id: 'theme',
        name: 'Reach',
        colors: { background: '#fff', ink: '#111' },
        fonts: { display: 'Inter', body: 'Inter' },
      },
    ],
    masters: [],
    layouts: [],
    media: [],
  },
  metadata: {
    source: 'editor',
    language: 'en-US',
    generatedAt: '2026-09-17T00:00:00.000Z',
    contentDigest: 'sha256:test',
  },
  revisions: [],
  pages: [
    {
      pageId: 'page',
      order: 1,
      revision,
      sceneType: 'interactive',
      title: 'Geometry',
      scene: {
        schemaVersion: 'reach-interactive-scene/v2',
        id: 'scene',
        title: 'Geometry',
        sceneType: 'interactive',
        documentHtml: '<!doctype html><html><body></body></html>',
        bridgeVersion: 'reach-interactive-bridge/v1',
        runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
        eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
      },
    },
  ],
  nativeSlides: [],
});

const runtime = {
  page: {
    kind: 'interactive' as const,
    sceneId: 'scene',
    sourceRevision: 1,
    attempt: 1,
    phase: 'active' as const,
    completed: false,
    geometry: { preserved: true },
  },
};

describe('reconcileReachDeckRuntime', () => {
  it('rejects stale revisions in normal playback', () => {
    expect(reconcileReachDeckRuntime(runtime, documentAt(2))).toEqual({});
  });

  it('migrates the same interactive scene only for an authoring caller', () => {
    expect(
      reconcileReachDeckRuntime(runtime, documentAt(2), { migrateInteractiveRevision: true }),
    ).toEqual({ page: { ...runtime.page, sourceRevision: 2 } });
  });
});
