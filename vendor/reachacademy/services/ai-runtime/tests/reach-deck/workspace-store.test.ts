import {
  createGenerationWorkspace,
  requestPageGeneration,
  setGenerationPaused,
  setPageGenerationStatus,
  type GenerationWorkspace,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const content = vi.hoisted(() => ({
  getReachDeckWorkspace: vi.fn(),
  putReachDeckWorkspace: vi.fn(),
}));

vi.mock('../../lib/reach-deck/content-service-client.js', () => ({
  ...content,
  ContentServiceClientError: class ContentServiceClientError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import {
  ReachDeckWorkspaceRevisionConflictError,
  loadReachDeckWorkspace,
  saveReachDeckWorkspace,
  transitionReachDeckWorkspace,
  transitionReachDeckWorkspaceForPage,
} from '../../lib/reach-deck/workspace-store.js';

const resourceScope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};
const context = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope,
  env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret-at-least-32-bytes' },
  fetch: vi.fn() as unknown as typeof fetch,
};
const workspace = () =>
  createGenerationWorkspace({
    runId: 'run-1',
    documentId: resourceScope.moduleVersionId,
    source: 'teacher source',
    createdAt: '2026-07-21T00:00:00Z',
  });
const resource = (value: unknown, draftRevision: number) => ({
  ...resourceScope,
  draftRevision,
  workspace: value,
  recoveryRevision: 0,
  recovery: {},
  createdAt: '2026-07-21T00:00:00Z',
  updatedAt: '2026-07-21T00:01:00Z',
});

describe('Reach Deck UUID authoring workspace store', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the exact UUID-owned workspace', async () => {
    const materializedAt = '2026-07-21T00:02:00Z';
    content.getReachDeckWorkspace.mockResolvedValue({
      ...resource(workspace(), 4),
      materializedAt,
    });
    await expect(loadReachDeckWorkspace(context)).resolves.toMatchObject({
      ...resourceScope,
      draftRevision: 4,
      materializedAt,
      workspace: { documentId: resourceScope.moduleVersionId },
    });
    expect(content.getReachDeckWorkspace).toHaveBeenCalledWith(context);
  });

  it('strips U+0000 persisted by earlier outlines so derived run input fits in jsonb', async () => {
    const nul = String.fromCharCode(0);
    content.getReachDeckWorkspace.mockResolvedValue(
      resource({ ...workspace(), source: `例如 ${nul}(-∞,-5]` }, 4),
    );
    const loaded = await loadReachDeckWorkspace(context);
    expect(loaded.workspace.source).toBe('例如 (-∞,-5]');
  });

  it('CAS-saves one contiguous revision', async () => {
    content.putReachDeckWorkspace.mockResolvedValue(resource(workspace(), 5));
    await expect(saveReachDeckWorkspace(context, workspace(), 4)).resolves.toMatchObject({
      draftRevision: 5,
    });
    expect(content.putReachDeckWorkspace).toHaveBeenCalledWith(workspace(), 4, context);
  });

  it('maps Java 409 to the domain revision conflict', async () => {
    content.putReachDeckWorkspace.mockRejectedValue(new ContentServiceClientError('stale', 409));
    await expect(saveReachDeckWorkspace(context, workspace(), 4)).rejects.toBeInstanceOf(
      ReachDeckWorkspaceRevisionConflictError,
    );
  });

  it('reloads and retries a transition after one CAS conflict', async () => {
    content.getReachDeckWorkspace
      .mockResolvedValueOnce(resource(workspace(), 1))
      .mockResolvedValueOnce(resource(workspace(), 2));
    content.putReachDeckWorkspace
      .mockRejectedValueOnce(new ContentServiceClientError('stale', 409))
      .mockResolvedValueOnce(
        resource(setGenerationPaused(workspace(), true, '2026-07-21T00:02:00Z'), 3),
      );

    const result = await transitionReachDeckWorkspace(context, (current) =>
      setGenerationPaused(current, true, '2026-07-21T00:02:00Z'),
    );
    expect(result.resource.draftRevision).toBe(3);
    expect(content.getReachDeckWorkspace).toHaveBeenCalledTimes(2);
  });

  describe('page-scoped transitions', () => {
    // Real two-page workspace; page-1's state and attempt are its page identity.
    const withPage = (state: string, attempt: number, other = 'ready'): GenerationWorkspace => {
      const base = createGenerationWorkspace({
        runId: 'run-1',
        documentId: resourceScope.moduleVersionId,
        source: 'teacher source',
        lessonPlan: {
          id: 'plan-1',
          title: 'Plan',
          audience: 'Grade 8',
          durationMinutes: 20,
          learningObjectives: ['Understand'],
          teachingStrategy: 'Explain',
          keyTerms: [],
          narrative: 'Narrative',
        },
        pagedOutline: {
          id: 'outline-1',
          title: 'Deck',
          pages: [1, 2].map((order) => ({
            id: `page-${order}`,
            order,
            sceneType: 'slide' as const,
            title: `Page ${order}`,
          })),
        },
        createdAt: '2026-07-21T00:00:00Z',
      });
      const at = '2026-07-21T00:01:00Z';
      const mark = (current: GenerationWorkspace, pageId: string, value: string) => {
        const request = current.records[pageId]!.request!;
        const identity = {
          runId: request.runId,
          pageId,
          requestedRevision: request.requestedRevision,
          attempt: request.attempt,
        };
        if (value === 'pending') return current;
        return setPageGenerationStatus(
          current,
          value === 'failed'
            ? { ...identity, state: 'failed', retryable: true, message: 'x', failedAt: at }
            : { ...identity, state: 'generating', startedAt: at },
          at,
        );
      };
      let next = mark(base, 'page-2', other === 'ready' ? 'failed' : other);
      next = mark(next, 'page-1', state);
      // The attempt is part of the page identity: a new request on page-1 bumps it.
      if (attempt > 1)
        next = requestPageGeneration(mark(next, 'page-1', 'failed'), {
          pageId: 'page-1',
          attempt,
          attemptReason: 'regenerate',
          requestedAt: at,
        });
      return next;
    };

    beforeEach(() => {
      content.putReachDeckWorkspace.mockImplementation(async (value, revision) =>
        resource(value, revision + 1),
      );
    });

    it('rebases onto a newer revision when only other pages changed', async () => {
      // The teacher saw revision 4; another page then landed (revision 5).
      content.getReachDeckWorkspace.mockResolvedValue(resource(withPage('failed', 1, 'failed'), 5));
      const result = await transitionReachDeckWorkspaceForPage(
        context,
        4,
        'page-1',
        (current) => setGenerationPaused(current, true, '2026-07-21T00:02:00Z'),
        1,
      );
      expect(result.applied).toBe(true);
      expect(content.putReachDeckWorkspace).toHaveBeenCalledWith(expect.anything(), 5, context);
    });

    it('retries when another page lands between the read and the save', async () => {
      content.getReachDeckWorkspace
        .mockResolvedValueOnce(resource(withPage('failed', 1, 'generating'), 5))
        .mockResolvedValueOnce(resource(withPage('failed', 1, 'generating'), 5))
        .mockResolvedValueOnce(resource(withPage('failed', 1, 'failed'), 6));
      content.putReachDeckWorkspace
        .mockRejectedValueOnce(new ContentServiceClientError('stale', 409))
        .mockImplementationOnce(async (value, revision) => resource(value, revision + 1));
      const result = await transitionReachDeckWorkspaceForPage(
        context,
        5,
        'page-1',
        (current) => setGenerationPaused(current, true, '2026-07-21T00:02:00Z'),
        1,
      );
      expect(result.resource.draftRevision).toBe(7);
    });

    it('still rejects a stale caller when the page itself changed', async () => {
      content.getReachDeckWorkspace
        .mockResolvedValueOnce(resource(withPage('failed', 1), 5))
        .mockResolvedValueOnce(resource(withPage('pending', 2), 6));
      content.putReachDeckWorkspace.mockRejectedValueOnce(
        new ContentServiceClientError('stale', 409),
      );
      await expect(
        transitionReachDeckWorkspaceForPage(
          context,
          5,
          'page-1',
          (current) => setGenerationPaused(current, true, '2026-07-21T00:02:00Z'),
          1,
        ),
      ).rejects.toBeInstanceOf(ReachDeckWorkspaceRevisionConflictError);
    });

    it('rejects a caller whose seen page attempt was already superseded before the request', async () => {
      // The teacher saw revision 4 / attempt 1; page-1 was regenerated (attempt 2) by revision 9.
      content.getReachDeckWorkspace.mockResolvedValue(resource(withPage('pending', 2), 9));
      await expect(
        transitionReachDeckWorkspaceForPage(
          context,
          4,
          'page-1',
          (current) => setGenerationPaused(current, true, '2026-07-21T00:02:00Z'),
          1,
        ),
      ).rejects.toBeInstanceOf(ReachDeckWorkspaceRevisionConflictError);
      expect(content.putReachDeckWorkspace).not.toHaveBeenCalled();
      // The same stale revision still rebases when the seen attempt is the current one.
      const result = await transitionReachDeckWorkspaceForPage(
        context,
        4,
        'page-1',
        (current) => setGenerationPaused(current, true, '2026-07-21T00:02:00Z'),
        2,
      );
      expect(result.applied).toBe(true);
    });

    it('falls back to the strict deck revision when the caller names no page attempt', async () => {
      // Older clients and pre-upgrade persisted commands: revision 4 is stale against revision 9.
      content.getReachDeckWorkspace.mockResolvedValue(resource(withPage('pending', 2), 9));
      await expect(
        transitionReachDeckWorkspaceForPage(context, 4, 'page-1', (current) =>
          setGenerationPaused(current, true, '2026-07-21T00:02:00Z'),
        ),
      ).rejects.toBeInstanceOf(ReachDeckWorkspaceRevisionConflictError);
      expect(content.putReachDeckWorkspace).not.toHaveBeenCalled();
      const result = await transitionReachDeckWorkspaceForPage(context, 9, 'page-1', (current) =>
        setGenerationPaused(current, true, '2026-07-21T00:02:00Z'),
      );
      expect(result.resource.draftRevision).toBe(10);
    });

    it('rejects a caller revision newer than the stored workspace', async () => {
      content.getReachDeckWorkspace.mockResolvedValue(resource(withPage('failed', 1), 3));
      await expect(
        transitionReachDeckWorkspaceForPage(context, 4, 'page-1', (current) => current),
      ).rejects.toBeInstanceOf(ReachDeckWorkspaceRevisionConflictError);
      expect(content.putReachDeckWorkspace).not.toHaveBeenCalled();
    });
  });

  it('rejects a workspace document that is not owned by moduleVersionId', async () => {
    content.getReachDeckWorkspace.mockResolvedValue(
      resource({ ...workspace(), documentId: '66666666-6666-4666-8666-666666666666' }, 1),
    );
    await expect(loadReachDeckWorkspace(context)).rejects.toThrow('moduleVersionId');
  });
});
