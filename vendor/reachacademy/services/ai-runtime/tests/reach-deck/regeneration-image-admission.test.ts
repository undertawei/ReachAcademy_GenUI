import {
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  type NativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lessonPlan,
  outline,
  page,
  slideMetadata,
} from '../../../../packages/reach-deck-dsl/tests/generationFixtures.js';
import type { ReachDeckWorkspaceBatch } from '../../lib/reach-deck/workspace-batches.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const dependencies = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  loadMaterialized: vi.fn(),
  loadRecovery: vi.fn(),
  listJobs: vi.fn(),
  resume: vi.fn(),
  register: vi.fn(),
  publicBatch: vi.fn(),
  conflict: vi.fn((message: string, code?: string) =>
    Object.assign(new Error(message), { status: 409, code }),
  ),
}));
vi.mock('../../lib/reach-deck/job-identity.js', () => ({
  buildStagedGenerationRequestHash: () => 'a'.repeat(64),
}));
vi.mock('../../lib/reach-deck/workspace-store.js', () => ({
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  ReachDeckWorkspaceRevisionConflictError: class extends Error {},
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', () => ({
  loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterialized,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
  listReachDeckWorkspaceRecoveryJobs: dependencies.listJobs,
}));
vi.mock('../../lib/reach-deck/workspace-batch-coordinator.js', () => ({
  registerReachDeckWorkspaceBatch: dependencies.register,
  resumeReachDeckWorkspaceBatch: dependencies.resume,
}));
vi.mock('../../lib/reach-deck/workspace-batches.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-batches.js')>()),
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION: 'reach-deck-workspace-batch/v1',
  buildReachDeckWorkspaceBatchId: () => 'new-batch',
}));
vi.mock('../../lib/reach-deck/saved-narration-media.js', () => ({
  publicReachDeckMediaBatch: dependencies.publicBatch,
}));
vi.mock('../../lib/reach-deck/workspace-route.js', () => ({ conflict: dependencies.conflict }));
vi.mock('../../lib/reach-deck/content-service-client.js', () => ({
  resolveReachDeckVoiceSelection: vi.fn(),
}));

import { startReachDeckRegeneration } from '../../lib/reach-deck/regeneration.js';

const NOW = '2026-10-17T08:00:00.000Z';
const context = { ...TEST_REACH_DECK_SCOPE };
const imageChannels = {
  layout: false,
  image: true,
  narration: false,
  audio: false,
  animation: false,
};

function fixture(activeSource: 'batch' | 'job') {
  const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck', generatedAt: NOW });
  const pageId = document.pages[0]!.pageId;
  const nativeSlide = document.nativeSlides[0]!.slide;
  nativeSlide.elements.push({
    id: 'image',
    type: 'image',
    resourceId: 'placeholder',
    transform: { x: 100, y: 100, width: 300, height: 200 },
    zIndex: 1,
    fit: 'contain',
    alt: 'Image',
  });
  document.resources.media.push({
    id: 'placeholder',
    objectKey: 'generated/placeholder.png',
    contentType: 'image/png',
    digest: 'a'.repeat(64),
  });
  const workspace = createGenerationWorkspace({
    runId: 'run',
    documentId: 'deck',
    source: 'Generation source',
    existingDocument: document,
    lessonPlan,
    pagedOutline: outline([page(pageId, 1, 'slide')]),
    createdAt: NOW,
  });
  workspace.statuses[pageId] = {
    runId: workspace.runId,
    pageId,
    requestedRevision: 1,
    attempt: 1,
    state: 'ready',
    sceneId: nativeSlide.id,
    completedAt: NOW,
  };
  workspace.sceneArtifacts[pageId] = {
    schemaVersion: 'reach-deck-slide-artifact/v2',
    sceneType: 'slide',
    status: 'ready',
    runId: workspace.runId,
    pageId,
    requestedRevision: 1,
    attempt: 1,
    generatedAt: NOW,
    nativeSlide,
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
          resourceId: 'placeholder',
          status: 'failed',
          attempt: 1,
        },
      ],
    },
  } satisfies NativeSlideArtifact;
  const batch: ReachDeckWorkspaceBatch = {
    schemaVersion: 'reach-deck-workspace-batch/v1',
    batchId: 'existing-image-batch',
    requestHash: 'a'.repeat(64),
    runId: workspace.runId,
    owner: TEST_REACH_DECK_SCOPE,
    kind: 'regeneration',
    sourceKind: 'regeneration',
    createdAt: NOW,
    revision: 0,
    phase: 'ready',
    dispatchCursor: 0,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: [
      {
        pageId,
        order: 0,
        sourceKind: 'materialized-native',
        requestKey: 'image-member',
        requestedRevision: 1,
        attempt: 1,
        intent: 'dispatched',
        jobId: 'active-image-job',
        regeneration: {
          plan: { channels: imageChannels, imageScope: 'failed', audioAnimationMode: 'preserve' },
          stage: 'image',
        },
      },
    ],
    skipped: [],
  };
  dependencies.loadWorkspace.mockResolvedValue({ draftRevision: 7, workspace });
  dependencies.loadMaterialized.mockResolvedValue({ materialized: true, document });
  dependencies.loadRecovery.mockResolvedValue({
    recovery: { batches: activeSource === 'batch' ? { [batch.batchId]: batch } : {} },
  });
  dependencies.listJobs.mockResolvedValue(
    activeSource === 'job'
      ? [
          {
            jobId: 'active-image-job',
            pageId,
            kind: 'page-generation',
            status: 'running',
            done: false,
            affectedLanes: ['image'],
          },
        ]
      : [],
  );
  dependencies.resume.mockResolvedValue({ status: 'missing' });
  return {
    batch,
    workspace,
    command: {
      scoped: { ...context, workspaceContext: context, jobScope: TEST_REACH_DECK_SCOPE },
      writerContext: context,
      expectedDraftRevision: 7,
      channels: imageChannels,
      scope: 'failed' as const,
      audioAnimationMode: 'preserve' as const,
      imageScope: 'failed' as const,
      assetIds: ['asset'],
      pageId,
      idempotencyKey: 'image-retry',
    },
  };
}

describe('single-page image regeneration admission', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects another actor while the same page has an active image batch', async () => {
    const { command, batch } = fixture('batch');
    dependencies.loadRecovery.mockResolvedValue({
      recovery: {
        batches: {
          [batch.batchId]: {
            ...batch,
            owner: { ...batch.owner, actorId: '22222222-2222-4222-8222-222222222222' },
          },
        },
      },
    });
    await expect(startReachDeckRegeneration(command)).rejects.toMatchObject({
      status: 409,
      code: 'image_generation_in_progress',
    });
    expect(dependencies.register).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'terminal'] as const)(
    'allows regeneration after an image batch is %s and has no live job',
    async (phase) => {
      const { command, batch } = fixture('batch');
      batch.phase = phase;
      dependencies.register.mockImplementationOnce(async ({ batch }) => batch);
      await expect(startReachDeckRegeneration(command)).resolves.toMatchObject({
        acceptedPageIds: [command.pageId],
      });
      expect(dependencies.register).toHaveBeenCalledOnce();
    },
  );

  it.each(['layout', 'narration'])(
    'does not label active %s work as image generation',
    async (lane) => {
      const { command } = fixture('job');
      dependencies.listJobs.mockResolvedValue([
        {
          pageId: command.pageId,
          kind: lane === 'layout' ? 'page-generation' : 'narration-generation',
          status: 'running',
          done: false,
          affectedLanes: [lane],
        },
      ]);
      await expect(startReachDeckRegeneration(command)).rejects.toMatchObject({
        status: 409,
        code: undefined,
      });
      expect(dependencies.register).not.toHaveBeenCalled();
    },
  );

  it.each(['batch', 'job'] as const)(
    'rejects a new request when ready page still has an active image %s',
    async (activeSource) => {
      const { command, workspace } = fixture(activeSource);
      expect(workspace.statuses[command.pageId]!.state).toBe('ready');

      await expect(startReachDeckRegeneration(command)).rejects.toMatchObject({
        status: 409,
        code: 'image_generation_in_progress',
      });

      expect(dependencies.register).not.toHaveBeenCalled();
      expect(dependencies.conflict).toHaveBeenCalledWith(
        'Images for this page are already generating',
        'image_generation_in_progress',
      );
      expect(workspace.statuses[command.pageId]!.state).toBe('ready');
    },
  );

  it.each(['batch', 'job'] as const)(
    'replays the accepted request before checking the active image %s or changed revision',
    async (activeSource) => {
      const { command, batch } = fixture(activeSource);
      dependencies.resume.mockResolvedValue({ status: 'found', batch });
      const publicBatch = { batchId: batch.batchId };
      dependencies.publicBatch.mockReturnValue(publicBatch);

      await expect(
        startReachDeckRegeneration({ ...command, expectedDraftRevision: 6 }),
      ).resolves.toEqual({ batch: publicBatch, acceptedPageIds: [command.pageId], skipped: [] });

      expect(dependencies.resume).toHaveBeenCalledWith(
        context,
        TEST_REACH_DECK_SCOPE,
        'run',
        'regeneration',
        batch.requestHash,
      );
      expect(dependencies.loadRecovery).not.toHaveBeenCalled();
      expect(dependencies.listJobs).not.toHaveBeenCalled();
      expect(dependencies.conflict).not.toHaveBeenCalled();
      expect(dependencies.register).not.toHaveBeenCalled();
    },
  );
});
