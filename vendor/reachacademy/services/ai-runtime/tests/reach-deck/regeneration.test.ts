import {
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  nativeSlideNarrationContentBaseline,
  REACH_DECK_NARRATION_ANIMATION_ID_PREFIX,
  type ReachDeckRegenerationChannels,
  type NativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';
import {
  interactiveScene,
  lessonPlan,
  outline,
  page,
  quizScene,
  slideMetadata,
} from '../../../../packages/reach-deck-dsl/tests/generationFixtures.js';

// Keep selection tests independent of cloud services, queue workers and document writers.
vi.mock('../../lib/reach-deck/job-identity.js', () => ({
  buildStagedGenerationRequestHash: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-store.js', () => ({
  loadReachDeckWorkspace: vi.fn(),
  ReachDeckWorkspaceRevisionConflictError: class extends Error {},
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', () => ({
  loadReachDeckMaterializedWorkspaceDocument: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  loadReachDeckWorkspaceRecovery: vi.fn(),
  listReachDeckWorkspaceRecoveryJobs: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-batch-coordinator.js', () => ({
  registerReachDeckWorkspaceBatch: vi.fn(),
  resumeReachDeckWorkspaceBatch: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-batches.js', () => ({
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION: 'reach-deck-workspace-batch/v1',
  buildReachDeckWorkspaceBatchId: vi.fn(),
  sameReachDeckWorkspaceBatchOwner: vi.fn(),
}));
vi.mock('../../lib/reach-deck/saved-narration-media.js', () => ({
  publicReachDeckMediaBatch: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-route.js', () => ({ conflict: vi.fn() }));
vi.mock('../../lib/reach-deck/content-service-client.js', () => ({
  resolveReachDeckVoiceSelection: vi.fn(),
}));

import {
  applyReachDeckRegenerationBatchFailures,
  selectReachDeckRegenerationPages,
} from '../../lib/reach-deck/regeneration.js';
import type { ReachDeckWorkspaceBatch } from '../../lib/reach-deck/workspace-batches.js';

const NOW = '2026-10-16T08:00:00.000Z';

it('selects pure-image pages by slot scope independently of the whole-deck page scope', () => {
  const { document, workspace } = fixture();
  const pageId = 'green';
  document.nativeSlides[0]!.slide.elements.push({
    id: 'image',
    type: 'image',
    resourceId: 'photo',
    transform: { x: 100, y: 100, width: 300, height: 200 },
    zIndex: 1,
    fit: 'contain',
    alt: 'Image',
  });
  document.resources.media.push({
    id: 'photo',
    objectKey: 'generated/photo.png',
    contentType: 'image/png',
    digest: 'a'.repeat(64),
  });
  workspace.sceneArtifacts[pageId] = {
    schemaVersion: 'reach-deck-slide-artifact/v2',
    sceneType: 'slide',
    status: 'ready',
    runId: workspace.runId,
    pageId,
    requestedRevision: 1,
    attempt: 1,
    generatedAt: NOW,
    nativeSlide: document.nativeSlides[0]!.slide,
    resources: document.resources,
    generationMetadata: {
      ...slideMetadata(pageId),
      mediaSlots: [
        {
          assetId: 'asset',
          plannedIndex: 0,
          plannedAsset: {
            kind: 'image',
            prompt: 'Image',
            alt: 'Image',
            aspectRatio: '4:3',
            placement: 'primary',
            purpose: 'Explain',
          },
          planDigest: 'a'.repeat(64),
          elementId: 'image',
          binding: 'image-element',
          resourceId: 'photo',
          status: 'ready',
          attempt: 1,
        },
      ],
    },
  } satisfies NativeSlideArtifact;
  const base = {
    document,
    workspace,
    channels: channels({ image: true }),
    scope: 'failed' as const,
  };
  const savedPlan = workspace.lessonPlan;
  workspace.lessonPlan = undefined;
  expect(selectReachDeckRegenerationPages({ ...base, pageId, imageScope: 'all' }).skipped).toEqual([
    { pageId, reason: 'layout-context-missing' },
  ]);
  workspace.lessonPlan = savedPlan;
  const savedStatus = workspace.statuses[pageId];
  workspace.statuses[pageId] = { state: 'manual-review-required' } as typeof savedStatus;
  expect(selectReachDeckRegenerationPages({ ...base, pageId, imageScope: 'all' }).skipped).toEqual([
    { pageId, reason: 'manual-review-required' },
  ]);
  if (savedStatus) workspace.statuses[pageId] = savedStatus;
  else delete workspace.statuses[pageId];
  const all = selectReachDeckRegenerationPages({ ...base, imageScope: 'all' });
  expect(all.accepted.map((page) => page.pageId)).toEqual(['green']);
  expect(all.skipped).toContainEqual({ pageId: 'missing-narration', reason: 'no-media-slots' });
  expect(selectReachDeckRegenerationPages({ ...base, imageScope: 'failed' }).accepted).toEqual([]);
  const artifact = workspace.sceneArtifacts[pageId] as NativeSlideArtifact;
  artifact.generationMetadata.mediaSlots![0]!.status = 'failed';
  expect(
    selectReachDeckRegenerationPages({ ...base, imageScope: 'failed' }).accepted.map(
      (page) => page.pageId,
    ),
  ).toEqual(['green']);
  expect(
    selectReachDeckRegenerationPages({ ...base, imageScope: 'all', assetIds: ['unrelated'] })
      .accepted,
  ).toEqual([]);
});

it('retries a failed audio lane with valid old audio and clears the failure after a later success', () => {
  const { document, workspace } = fixture();
  const failed = {
    batchId: 'a',
    createdAt: NOW,
    members: [
      {
        pageId: 'green',
        terminalOutcome: 'failed',
        reason: 'audio-generation-failed',
        regeneration: {
          plan: { channels: { layout: false, narration: false, audio: true, animation: false } },
          stage: 'narration',
        },
      },
    ],
  } as unknown as ReachDeckWorkspaceBatch;
  const failures = new Map<string, Set<string>>();
  applyReachDeckRegenerationBatchFailures(failures, [failed]);
  expect(
    selectReachDeckRegenerationPages({
      document,
      workspace,
      channels: channels({ audio: true }),
      scope: 'failed',
      pageId: 'green',
      failedLanesByPage: failures,
    }).accepted.map((p) => p.pageId),
  ).toEqual(['green']);
  const success = structuredClone(failed);
  success.batchId = 'b';
  success.createdAt = '2026-10-16T08:01:00.000Z';
  success.members[0]!.terminalOutcome = 'completed';
  const recovered = new Map<string, Set<string>>();
  applyReachDeckRegenerationBatchFailures(recovered, [success, failed]);
  expect(
    selectReachDeckRegenerationPages({
      document,
      workspace,
      channels: channels({ audio: true }),
      scope: 'failed',
      pageId: 'green',
      failedLanesByPage: recovered,
    }).accepted,
  ).toEqual([]);
});
const channels = (
  selected: Partial<ReachDeckRegenerationChannels>,
): ReachDeckRegenerationChannels => ({
  layout: false,
  narration: false,
  audio: false,
  animation: false,
  ...selected,
});

function fixture() {
  const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck', generatedAt: NOW });
  const template = document.nativeSlides[0]!.slide;
  const ids = ['green', 'missing-narration', 'missing-audio', 'missing-animation'];
  document.pages = ids.map((pageId, index) => ({
    pageId,
    order: index + 1,
    revision: 1,
    sceneType: 'slide',
    title: pageId,
  }));
  document.nativeSlides = ids.map((pageId) => {
    const slide = { ...structuredClone(template), id: `${pageId}-slide`, duration: 4 };
    slide.narration = {
      markdown: 'Valid saved narration',
      audioResourceId: `${pageId}-audio`,
      segments: [{ text: 'Valid saved narration', start: 0, end: 3 }],
      contentBaseline: nativeSlideNarrationContentBaseline(slide),
    };
    slide.animations = [
      {
        id: `${REACH_DECK_NARRATION_ANIMATION_ID_PREFIX}${pageId}`,
        targetId: slide.elements[0]?.id ?? 'title',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 1,
        from: { opacity: 0 },
        to: { opacity: 1 },
      },
    ];
    document.resources.media.push({
      id: `${pageId}-audio`,
      objectKey: `${pageId}.mp3`,
      digest: pageId,
      contentType: 'audio/mpeg',
    });
    return { pageId, slide };
  });
  delete document.nativeSlides[1]!.slide.narration;
  document.nativeSlides[2]!.slide.narration = { markdown: 'Valid saved narration' };
  document.nativeSlides[3]!.slide.animations = [];
  const workspace = createGenerationWorkspace({
    runId: 'run',
    documentId: 'deck',
    source: 'Generation source',
    existingDocument: document,
    lessonPlan,
    pagedOutline: outline(ids.map((id, index) => page(id, index + 1, 'slide'))),
    createdAt: NOW,
  });
  workspace.statuses = {};
  return { document, workspace };
}

describe('regeneration page admission', () => {
  it.each([{ narration: true }, { narration: true, audio: true }])(
    'does not treat deliberately silent Interactive pages as failed narration or audio',
    (selected) => {
      const input = fixture();
      const scene = interactiveScene('silent');
      delete scene.narration;
      input.document.pages.push({
        pageId: 'silent',
        order: 5,
        revision: 1,
        title: 'Silent',
        sceneType: 'interactive',
        scene,
      });
      const query = { ...input, channels: channels(selected), scope: 'failed' as const };
      expect(selectReachDeckRegenerationPages(query).skipped).toContainEqual({
        pageId: 'silent',
        reason: 'no-selected-channel-failure',
      });
      expect(
        selectReachDeckRegenerationPages({ ...query, scope: 'all' }).accepted.map((p) => p.pageId),
      ).toContain('silent');
      expect(
        selectReachDeckRegenerationPages({
          ...query,
          failedLanesByPage: new Map([['silent', new Set(['narration'])]]),
        }).accepted.map((p) => p.pageId),
      ).toContain('silent');
    },
  );

  it('admits each failed page once and retains every selected lane in its plan', () => {
    const input = fixture();
    const selectedChannels = channels({ narration: true, audio: true, animation: true });
    const selected = selectReachDeckRegenerationPages({
      ...input,
      channels: selectedChannels,
      scope: 'failed',
      failedLanesByPage: new Map([['green', new Set(['audio', 'animation'])]]),
    });
    expect(selected.accepted).toEqual(
      ['green', 'missing-narration', 'missing-audio', 'missing-animation'].map((pageId) => ({
        pageId,
        planChannels: selectedChannels,
      })),
    );
    expect(new Set(selected.accepted.map((entry) => entry.pageId)).size).toBe(
      selected.accepted.length,
    );
    expect(selected.skipped).toEqual([]);
  });

  it('filters failures by selected lanes and accepts an explicit failure despite valid old artifacts', () => {
    const input = fixture();
    const selected = selectReachDeckRegenerationPages({
      ...input,
      channels: channels({ audio: true }),
      scope: 'failed',
      failedLanesByPage: new Map([
        ['green', new Set(['audio'])],
        ['missing-animation', new Set(['layout'])],
      ]),
    });
    expect(selected.accepted.map((entry) => entry.pageId)).toEqual(['green', 'missing-audio']);
    expect(selected.skipped).toEqual([
      { pageId: 'missing-narration', reason: 'invalid-narration' },
      { pageId: 'missing-animation', reason: 'no-selected-channel-failure' },
    ]);
  });

  it('skips invalid narration for audio alone while admitting pages needing audio', () => {
    const input = fixture();
    input.document.nativeSlides[3]!.slide.narration!.contentBaseline = 'stale';
    const selected = selectReachDeckRegenerationPages({
      ...input,
      channels: channels({ audio: true }),
      scope: 'all',
    });
    expect(selected.accepted.map((entry) => entry.pageId)).toEqual(['green', 'missing-audio']);
    expect(selected.skipped).toEqual([
      { pageId: 'missing-narration', reason: 'invalid-narration' },
      { pageId: 'missing-animation', reason: 'invalid-narration' },
    ]);
  });

  it('requires both valid narration and usable timed audio for animation alone', () => {
    const input = fixture();
    const selected = selectReachDeckRegenerationPages({
      ...input,
      channels: channels({ animation: true }),
      scope: 'all',
    });
    expect(selected.accepted.map((entry) => entry.pageId)).toEqual(['green', 'missing-animation']);
    expect(selected.skipped).toEqual([
      { pageId: 'missing-narration', reason: 'invalid-narration-audio' },
      { pageId: 'missing-audio', reason: 'invalid-narration-audio' },
    ]);
    expect(
      selectReachDeckRegenerationPages({
        ...input,
        channels: channels({ animation: true }),
        scope: 'failed',
      }).accepted.map((entry) => entry.pageId),
    ).toEqual(['missing-animation']);
  });

  it('admits audio plus animation using valid narration even when audio is currently absent', () => {
    const selected = selectReachDeckRegenerationPages({
      ...fixture(),
      channels: channels({ audio: true, animation: true }),
      scope: 'all',
    });
    expect(selected.accepted.map((entry) => entry.pageId)).toEqual([
      'green',
      'missing-audio',
      'missing-animation',
    ]);
    expect(selected.skipped).toEqual([
      { pageId: 'missing-narration', reason: 'invalid-narration' },
    ]);
  });

  it.each(['pending', 'generating', 'narrating'] as const)(
    'protects %s status even before its ordinary job has been registered',
    (state) => {
      const input = fixture();
      const identity = { runId: 'run', pageId: 'green', requestedRevision: 1, attempt: 1 };
      input.workspace.statuses.green =
        state === 'pending'
          ? { ...identity, state, requestedAt: NOW }
          : { ...identity, state, startedAt: NOW };
      const selected = selectReachDeckRegenerationPages({
        ...input,
        channels: channels({ narration: true }),
        scope: 'all',
        activePageIds: new Set(['missing-audio']),
      });
      expect(selected.accepted.map((entry) => entry.pageId)).toEqual([
        'missing-narration',
        'missing-animation',
      ]);
      expect(selected.skipped).toEqual([
        { pageId: 'green', reason: 'in-flight' },
        { pageId: 'missing-audio', reason: 'in-flight' },
      ]);
    },
  );

  it('limits single-page selection and reports a missing target', () => {
    const input = fixture();
    expect(
      selectReachDeckRegenerationPages({
        ...input,
        channels: channels({ narration: true }),
        scope: 'all',
        pageId: 'green',
      }).accepted.map((entry) => entry.pageId),
    ).toEqual(['green']);
    expect(
      selectReachDeckRegenerationPages({
        ...input,
        channels: channels({ narration: true }),
        scope: 'all',
        pageId: 'missing',
      }),
    ).toEqual({ accepted: [], skipped: [{ pageId: 'missing', reason: 'page-missing' }] });
  });

  it('projects combinations onto page-type capabilities and skips unsupported lanes', () => {
    const input = fixture();
    const scene = interactiveScene('interactive');
    input.document.pages.push(
      {
        pageId: 'interactive',
        order: 5,
        revision: 1,
        title: 'Interactive',
        sceneType: 'interactive',
        scene,
      },
      {
        pageId: 'quiz',
        order: 6,
        revision: 1,
        title: 'Quiz',
        sceneType: 'quiz',
        scene: quizScene('quiz'),
      },
    );
    const media = selectReachDeckRegenerationPages({
      ...input,
      channels: channels({ audio: true, animation: true }),
      scope: 'all',
    });
    expect(media.accepted).toContainEqual({
      pageId: 'interactive',
      planChannels: channels({ audio: true }),
    });
    expect(media.skipped).toContainEqual({ pageId: 'quiz', reason: 'unsupported-page-type' });
    const animation = selectReachDeckRegenerationPages({
      ...input,
      channels: channels({ animation: true }),
      scope: 'all',
    });
    expect(animation.skipped).toEqual(
      expect.arrayContaining([
        { pageId: 'interactive', reason: 'unsupported-page-type' },
        { pageId: 'quiz', reason: 'unsupported-page-type' },
      ]),
    );
  });

  it('requires saved generation context for layout and keeps page order deterministic', () => {
    const input = fixture();
    input.workspace.lessonPlan = undefined;
    expect(
      selectReachDeckRegenerationPages({
        ...input,
        channels: channels({ layout: true }),
        scope: 'all',
      }).skipped,
    ).toHaveLength(4);
    const ordered = fixture();
    ordered.document.pages.reverse();
    expect(
      selectReachDeckRegenerationPages({
        ...ordered,
        channels: channels({ narration: true }),
        scope: 'all',
      }).accepted.map((entry) => entry.pageId),
    ).toEqual(['green', 'missing-narration', 'missing-audio', 'missing-animation']);
  });
});
