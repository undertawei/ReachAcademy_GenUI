import {
  createBlankReachDeckDocument,
  retryFailedPageGeneration,
  type GenerationWorkspace,
  type NativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import { UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReachDeckPageGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';

const dependencies = vi.hoisted(() => ({
  transition: vi.fn(),
  lease: vi.fn(),
  advance: vi.fn(),
  loadRecovery: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  transitionReachDeckWorkspace: dependencies.transition,
}));
vi.mock('../../lib/reach-deck/decksmith/document-writer.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/document-writer.js')>()),
  withReachDeckRetainedAsyncWriterLease: dependencies.lease,
}));
vi.mock('../../lib/reach-deck/generation-chain.js', () => ({
  advanceReachDeckGenerationLanes: dependencies.advance,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
}));

import { markReachDeckWorkspacePageFailedBestEffort } from '../../lib/reach-deck/workspace-failure.js';
import { ReachDeckProviderOutputError } from '../../lib/reach-deck/model-service-client.js';
import { ReachDeckImageReuseError } from '../../lib/reach-deck/generation-pipeline.js';

const identity = { runId: 'run-1', pageId: 'page-1', requestedRevision: 1, attempt: 1 };
const payload = {
  ...TEST_REACH_DECK_SCOPE,
  kind: 'page-generation',
  jobId: 'job-1',
  runId: identity.runId,
  request: identity,
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
} as ReachDeckPageGenerationJobPayload;
const writerSession = { signal: new AbortController().signal };
let workspace: GenerationWorkspace;

beforeEach(() => {
  vi.clearAllMocks();
  workspace = {
    runId: identity.runId,
    stage: 'page-generation',
    paused: false,
    order: ['page-1', 'page-2'],
    records: { 'page-1': { request: identity } },
    sceneArtifacts: {},
    statuses: {
      'page-1': { ...identity, state: 'pending', requestedAt: '2026-09-21T00:00:00Z' },
      'page-2': {
        ...identity,
        pageId: 'page-2',
        state: 'pending',
        requestedAt: '2026-09-21T00:00:00Z',
      },
    },
  } as unknown as GenerationWorkspace;
  dependencies.lease.mockImplementation(async ({ context, operation }) =>
    operation({ ...context, documentWriterSession: writerSession }),
  );
  dependencies.transition.mockImplementation(async (_context, transition) => {
    const next = transition(workspace);
    const applied = next !== workspace;
    workspace = next;
    return { applied, resource: { workspace } };
  });
  dependencies.advance.mockResolvedValue({
    layout: { status: 'enqueued', pageId: 'page-2', jobId: 'job-2' },
    narration: { status: 'complete' },
  });
  dependencies.loadRecovery.mockResolvedValue({ recovery: { jobs: {}, batches: {} } });
});

describe('terminal layout failure advances both lanes', () => {
  it('retains the previous native artifact when teacher image reuse fails and permits a teacher retry', async () => {
    const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck' });
    const artifact: NativeSlideArtifact = {
      ...identity,
      schemaVersion: 'reach-deck-slide-artifact/v2' as const,
      sceneType: 'slide' as const,
      nativeSlide: document.nativeSlides[0]!.slide,
      resources: document.resources,
      status: 'ready' as const,
      generationMetadata: {
        blueprint: {
          pageId: identity.pageId,
          learningGoal: 'Explain one idea',
          keyMessage: 'Source evidence',
          audienceAssumption: 'New learner',
          narrativeRole: 'explain',
          contentUnits: [],
          desiredStudentAttention: 'The evidence',
          mediaIntent: { kind: 'none' },
        },
        classification: {
          primaryType: 'single_focus',
          itemCount: 1,
          density: 'low',
          visualFocus: 'statement',
          mediaType: 'none',
          confidence: 1,
          rationale: 'One idea',
        },
        layoutReferences: [],
        promptVersion: 'test',
      },
      generatedAt: '2026-10-17T01:00:00Z',
    };
    workspace.sceneArtifacts = { 'page-1': artifact };
    await markReachDeckWorkspacePageFailedBestEffort(
      payload,
      new ReachDeckImageReuseError(new Error('download failed')),
    );
    expect(workspace.statuses['page-1']).toMatchObject({ state: 'failed', retryable: true });
    expect(workspace.sceneArtifacts['page-1']).toEqual(artifact);
    const retried = retryFailedPageGeneration(workspace, identity, '2026-10-17T03:00:00Z');
    expect(retried.statuses['page-1']).toMatchObject({ state: 'narrating' });
    expect(retried.sceneArtifacts['page-1']).toEqual(artifact);
  });
  it.each(['typed', 'cause', 'bullmq'])(
    'persists a %s refusal as teacher-retryable and accepts the single-page retry transition',
    async (kind) => {
      const refusal = new ReachDeckProviderOutputError(
        'model-service refused the requested output',
        {
          stage: 'slide',
          pageId: 'page-1',
          reasonCode: 'provider-refusal',
          retryable: false,
        },
      );
      const error =
        kind === 'typed'
          ? refusal
          : kind === 'cause'
            ? new Error('terminal provider failure', { cause: refusal })
            : new UnrecoverableError(refusal.message);
      await markReachDeckWorkspacePageFailedBestEffort(payload, error);
      expect(workspace.statuses['page-1']).toMatchObject({
        ...identity,
        state: 'failed',
        retryable: true,
        message: 'invalid-output',
      });
      const retried = retryFailedPageGeneration(workspace, identity, '2026-10-16T03:00:00Z');
      expect(retried).not.toBe(workspace);
      expect(retried.statuses['page-1']).toMatchObject({ ...identity, state: 'pending' });
      expect(refusal.retryable).toBe(false);
    },
  );

  it('persists failure before advancing under the same writer lease without retrying the page', async () => {
    dependencies.advance.mockImplementation(async (context, scope, runId, voiceSelection) => {
      expect(workspace.statuses['page-1'].state).toBe('failed');
      expect(workspace.statuses['page-2'].state).toBe('pending');
      expect(context.documentWriterSession).toBe(writerSession);
      expect(scope.resourceScope).toEqual(TEST_REACH_DECK_SCOPE.resourceScope);
      expect(runId).toBe('run-1');
      expect(voiceSelection).toEqual(DEFAULT_REACH_DECK_VOICE_SELECTION);
    });
    await markReachDeckWorkspacePageFailedBestEffort(payload, new Error('invalid layout'));
    await markReachDeckWorkspacePageFailedBestEffort(
      payload,
      new Error('duplicate terminal event'),
    );
    expect(dependencies.advance).toHaveBeenCalledTimes(1);
    expect(workspace.statuses['page-1'].attempt).toBe(1);
  });

  it('records the failure but dispatches nothing while the workspace is paused', async () => {
    workspace = { ...workspace, paused: true };
    await markReachDeckWorkspacePageFailedBestEffort(payload, new Error('invalid layout'));
    expect(workspace.statuses['page-1'].state).toBe('failed');
    expect(dependencies.advance).not.toHaveBeenCalled();
  });

  it.each(['obsolete-run', 'new-attempt', 'completed-page', 'changed-stage'])(
    'does not advance or overwrite a %s workspace',
    async (scenario) => {
      if (scenario === 'obsolete-run') workspace = { ...workspace, runId: 'run-new' };
      if (scenario === 'new-attempt')
        workspace.statuses['page-1'] = { ...workspace.statuses['page-1'], attempt: 2 };
      if (scenario === 'completed-page')
        workspace.statuses['page-1'] = {
          ...identity,
          state: 'ready',
          sceneId: 'slide-1',
          completedAt: '2026-09-21T00:01:00Z',
        };
      if (scenario === 'changed-stage') workspace = { ...workspace, stage: 'page-outline' };
      const previous = workspace;
      await markReachDeckWorkspacePageFailedBestEffort(payload, new Error('late failure'));
      expect(workspace).toBe(previous);
      expect(dependencies.advance).not.toHaveBeenCalled();
    },
  );

  it('does not advance when CAS replay discovers a newer run', async () => {
    dependencies.transition.mockImplementation(async (_context, transition) => {
      expect(transition(workspace).statuses['page-1'].state).toBe('failed');
      workspace = { ...workspace, runId: 'run-new' };
      const next = transition(workspace);
      return { applied: next !== workspace, resource: { workspace: next } };
    });
    await markReachDeckWorkspacePageFailedBestEffort(payload, new Error('late failure'));
    expect(dependencies.advance).not.toHaveBeenCalled();
  });

  it('does not advance before failure persistence succeeds', async () => {
    dependencies.transition.mockRejectedValueOnce(new Error('CAS exhausted'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await markReachDeckWorkspacePageFailedBestEffort(payload, new Error('invalid layout'));
    expect(dependencies.advance).not.toHaveBeenCalled();
    expect(workspace.statuses['page-1'].state).toBe('pending');
    log.mockRestore();
  });

  it('does not undo the terminal failure when next-page dispatch fails', async () => {
    dependencies.advance.mockRejectedValueOnce(new Error('queue unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      markReachDeckWorkspacePageFailedBestEffort(payload, new Error('invalid layout')),
    ).resolves.toBeUndefined();
    expect(workspace.statuses['page-1'].state).toBe('failed');
    log.mockRestore();
  });
});
