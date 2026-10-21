import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySceneArtifact,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  parseGenerationWorkspace,
  setPageGenerationStatus,
  type GenerationWorkspace,
  type InteractiveScene,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

const dependencies = vi.hoisted(() => ({
  loadRecovery: vi.fn(),
  transitionRetirements: vi.fn(),
  transitionAtRevision: vi.fn(),
}));

vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
  transitionReachDeckDeletedPageRetirements: dependencies.transitionRetirements,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  transitionReachDeckWorkspaceAtRevision: dependencies.transitionAtRevision,
}));

import {
  reconcileReachDeckWorkspaceDocumentStructure,
  recoverRecordedReachDeckPageDeletions,
  settleAdvancedReachDeckPageDeletions,
  synchronizeReachDeckWorkspaceDocumentStructureWithDeletions,
  unchangedReachDeckDocumentPageIds,
} from '../../lib/reach-deck/workspace-document-structure.js';
import {
  recordReachDeckDeletedPageRetirement,
  type ReachDeckDeletedPageRetirements,
} from '../../lib/reach-deck/deleted-page-retirements.js';
import type { ReachDeckAuthoringWorkspaceResource } from '../../lib/reach-deck/workspace-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const NOW = '2026-10-16T01:00:00.000Z';
const scene: InteractiveScene = {
  schemaVersion: 'reach-interactive-scene/v2',
  id: 'page-1',
  title: 'Explorer',
  sceneType: 'interactive',
  documentHtml:
    '<!doctype html><html><head><title>Explorer</title></head><body><button>Try</button></body></html>',
  bridgeVersion: 'reach-interactive-bridge/v1',
  runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
  eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
};

function fixture() {
  let workspace = createGenerationWorkspace({
    runId: 'run-1',
    documentId: 'deck-1',
    source: 'source',
    createdAt: NOW,
    lessonPlan: {
      id: 'plan-1',
      title: 'Systems',
      audience: 'Grade 8',
      durationMinutes: 45,
      learningObjectives: ['Explain'],
      teachingStrategy: 'Practice',
      keyTerms: ['system'],
      narrative: 'Explore.',
    },
    pagedOutline: {
      id: 'outline-1',
      title: 'Systems',
      pages: ['page-1', 'page-2'].map((id, index) => ({
        id,
        order: index + 1,
        sceneType: 'interactive',
        title: 'Explorer',
      })),
    },
  });
  workspace = setPageGenerationStatus(
    workspace,
    {
      runId: 'run-1',
      pageId: 'page-1',
      requestedRevision: 1,
      attempt: 1,
      state: 'generating',
      startedAt: NOW,
    },
    NOW,
  );
  workspace = applySceneArtifact(workspace, {
    runId: 'run-1',
    pageId: 'page-1',
    requestedRevision: 1,
    attempt: 1,
    sceneType: 'interactive',
    scene,
    status: 'ready',
    generatedAt: NOW,
  });
  workspace = setPageGenerationStatus(
    workspace,
    {
      runId: 'run-1',
      pageId: 'page-2',
      requestedRevision: 1,
      attempt: 1,
      state: 'failed',
      failedAt: NOW,
      retryable: true,
      message: 'layout failed',
    },
    NOW,
  );
  const blank = createBlankReachDeckDocument({ id: 'deck-1', title: 'Systems' });
  const document: ReachDeckDocument = {
    ...blank,
    pages: [
      {
        pageId: 'page-1',
        order: 1,
        revision: 1,
        title: 'Explorer',
        sceneType: 'interactive',
        scene,
      },
    ],
    nativeSlides: [],
  };
  return { workspace, document };
}

describe('materialized document generation structure reconciliation', () => {
  it('retires a deleted failed page and completes surviving ready targets', () => {
    const { workspace, document } = fixture();
    const next = reconcileReachDeckWorkspaceDocumentStructure(workspace, document, NOW);
    expect(parseGenerationWorkspace(next)).toMatchObject({
      stage: 'complete',
      targetPageIds: ['page-1'],
      order: ['page-1'],
    });
    expect(next.records['page-2']).toBeUndefined();
    expect(next.statuses['page-2']).toBeUndefined();
    expect(next.pagedOutline?.pages.map((page) => page.id)).toEqual(['page-1']);
  });

  it('retains actual pending targets even when the projection has not materialized them', () => {
    const { workspace, document } = fixture();
    const request = workspace.records['page-2']!.request!;
    const pending = {
      ...workspace,
      statuses: {
        ...workspace.statuses,
        'page-2': {
          ...workspace.statuses['page-2']!,
          state: 'pending' as const,
          requestedAt: request.requestedAt,
        },
      },
    };
    expect(reconcileReachDeckWorkspaceDocumentStructure(pending, document, NOW)).toBe(pending);
    // 教师确认删除生成中的页（其任务已取消）后，这一页照样退役。
    const retired = reconcileReachDeckWorkspaceDocumentStructure(
      pending,
      document,
      NOW,
      new Set(['page-2']),
    );
    expect(retired.order).toEqual(['page-1']);
    expect(retired.statuses['page-2']).toBeUndefined();
    expect(retired.stage).toBe('complete');
  });

  it('retires a failed page replaced with a different scene type', () => {
    const { workspace, document } = fixture();
    const replacement = createBlankReachDeckDocument({ id: 'deck-1', title: 'Replacement' });
    replacement.pages[0]!.pageId = 'page-2';
    replacement.nativeSlides[0]!.pageId = 'page-2';
    const next = reconcileReachDeckWorkspaceDocumentStructure(
      workspace,
      { ...replacement, pages: [...document.pages, { ...replacement.pages[0]!, order: 2 }] },
      NOW,
    );
    expect(next.targetPageIds).toEqual(['page-1']);
    expect(next.stage).toBe('complete');
  });

  it('uses the copied contract after every generated page was manually replaced', () => {
    const { workspace } = fixture();
    const failed = {
      ...workspace,
      statuses: {
        ...workspace.statuses,
        'page-1': { ...workspace.statuses['page-2']!, pageId: 'page-1' },
      },
    };
    const replacement = createBlankReachDeckDocument({ id: 'deck-1', title: 'Replacement' });
    const next = reconcileReachDeckWorkspaceDocumentStructure(failed, replacement, NOW);
    expect(parseGenerationWorkspace(next)).toMatchObject({
      stage: 'copied',
      targetPageIds: [],
      records: {},
      statuses: {},
      baseDocument: replacement,
    });
  });

  it('preserves independent page identity across insertion and reorder, but rejects changed content', () => {
    const { document } = fixture();
    const next = structuredClone(document);
    next.pages[0]!.order = 2;
    next.pages.unshift({ ...next.pages[0]!, pageId: 'manual-page', order: 1 });
    expect(unchangedReachDeckDocumentPageIds(document, next)).toEqual(['page-1']);
    next.pages[1]!.title = 'Replaced content';
    expect(unchangedReachDeckDocumentPageIds(document, next)).toEqual([]);
  });
});

describe('retrying the workspace synchronization after deleting a generating page', () => {
  let retirements: ReachDeckDeletedPageRetirements;
  let saved: GenerationWorkspace | undefined;

  function narratingSecondPage() {
    const { workspace, document } = fixture();
    const narrating: GenerationWorkspace = {
      ...workspace,
      statuses: {
        ...workspace.statuses,
        'page-2': {
          runId: 'run-1',
          pageId: 'page-2',
          requestedRevision: 1,
          attempt: 1,
          state: 'narrating',
          startedAt: NOW,
        },
      },
    };
    const resource = {
      ...TEST_REACH_DECK_SCOPE.resourceScope,
      draftRevision: 9,
      workspace: narrating,
    } as unknown as ReachDeckAuthoringWorkspaceResource;
    return { resource, document };
  }

  beforeEach(() => {
    retirements = {};
    saved = undefined;
    dependencies.loadRecovery.mockReset().mockImplementation(async () => ({
      recovery: { deletedPageRetirements: retirements },
    }));
    dependencies.transitionRetirements
      .mockReset()
      .mockImplementation(
        async (
          _context: unknown,
          transition: (current: ReachDeckDeletedPageRetirements) => ReachDeckDeletedPageRetirements,
        ) => {
          retirements = transition(structuredClone(retirements));
        },
      );
    dependencies.transitionAtRevision
      .mockReset()
      .mockImplementation(
        async (_context: unknown, revision: number, transition: () => GenerationWorkspace) => {
          saved = transition();
          return { resource: { draftRevision: revision + 1, workspace: saved } };
        },
      );
  });

  it('retires a recorded deleted page and keeps the record until the lane advance settles it', async () => {
    const { resource, document } = narratingSecondPage();
    retirements = recordReachDeckDeletedPageRetirement({}, 'run-1', ['page-2'], NOW);

    // 重试的保存已推不出被删页（文档里早就没有 page-2），只能靠 recovery 里的记录。
    const synchronized = await synchronizeReachDeckWorkspaceDocumentStructureWithDeletions(
      TEST_REACH_DECK_SCOPE,
      resource,
      document,
    );

    expect(synchronized.pendingLaneAdvancePageIds).toEqual(['page-2']);
    expect(synchronized.resource.workspace.order).toEqual(['page-1']);
    expect(saved?.statuses['page-2']).toBeUndefined();
    // 同步不结算：推进生成链成功之前记录一直保留。
    expect(dependencies.transitionRetirements).not.toHaveBeenCalled();

    // 工作区已退役但推进或结算失败后再同步：页已不在工作区，仍欠一次推进。
    const again = await synchronizeReachDeckWorkspaceDocumentStructureWithDeletions(
      TEST_REACH_DECK_SCOPE,
      synchronized.resource,
      document,
    );
    expect(again.pendingLaneAdvancePageIds).toEqual(['page-2']);

    await settleAdvancedReachDeckPageDeletions(TEST_REACH_DECK_SCOPE, 'run-1', ['page-2']);
    expect(retirements).toEqual({});
    const settled = await synchronizeReachDeckWorkspaceDocumentStructureWithDeletions(
      TEST_REACH_DECK_SCOPE,
      synchronized.resource,
      document,
    );
    expect(settled.pendingLaneAdvancePageIds).toEqual([]);
  });

  it('settles only the advanced run and keeps a newer run recorded meanwhile', async () => {
    retirements = {
      ...recordReachDeckDeletedPageRetirement({}, 'run-1', ['page-2', 'page-3'], NOW),
      ...recordReachDeckDeletedPageRetirement({}, 'run-2', ['page-9'], NOW),
    };
    // 旧 run 的推进迟到（已释放写锁），期间新 run 记下了自己的删页：结算不能清掉它。
    await settleAdvancedReachDeckPageDeletions(TEST_REACH_DECK_SCOPE, 'run-1', ['page-2']);
    expect(retirements['run-1']?.pageIds).toEqual(['page-3']);
    expect(retirements['run-2']?.pageIds).toEqual(['page-9']);
    await settleAdvancedReachDeckPageDeletions(TEST_REACH_DECK_SCOPE, 'run-1', ['page-3']);
    expect(Object.keys(retirements)).toEqual(['run-2']);
    await settleAdvancedReachDeckPageDeletions(TEST_REACH_DECK_SCOPE, 'run-3', ['page-1']);
    expect(Object.keys(retirements)).toEqual(['run-2']);
  });

  it('retires a recorded ghost page before the save validates page locks', async () => {
    const { resource, document } = narratingSecondPage();
    const generating = {
      ...resource,
      workspace: {
        ...resource.workspace,
        statuses: {
          ...resource.workspace.statuses,
          'page-2': { ...resource.workspace.statuses['page-2']!, state: 'generating' as const },
        },
      },
    } as ReachDeckAuthoringWorkspaceResource;

    const unrecorded = await recoverRecordedReachDeckPageDeletions(
      TEST_REACH_DECK_SCOPE,
      generating,
      document,
    );
    expect(unrecorded).toEqual({ resource: generating, pageIds: [] });

    retirements = recordReachDeckDeletedPageRetirement({}, 'run-1', ['page-2'], NOW);
    const recovered = await recoverRecordedReachDeckPageDeletions(
      TEST_REACH_DECK_SCOPE,
      generating,
      document,
    );
    expect(recovered.pageIds).toEqual(['page-2']);
    expect(recovered.resource.workspace.order).toEqual(['page-1']);
    expect(recovered.resource.draftRevision).toBe(10);
  });

  it('keeps a recorded page that is still in the document and never infers deletion without a record', async () => {
    const { resource, document } = narratingSecondPage();

    const unrecorded = await synchronizeReachDeckWorkspaceDocumentStructureWithDeletions(
      TEST_REACH_DECK_SCOPE,
      resource,
      document,
    );
    // 没有记录时在途页缺席文档不代表被删（可能只是还没物化），照旧保留。
    expect(unrecorded.resource).toBe(resource);
    expect(unrecorded.pendingLaneAdvancePageIds).toEqual([]);

    retirements = recordReachDeckDeletedPageRetirement({}, 'run-1', ['page-2'], NOW);
    const withPage = structuredClone(document);
    withPage.pages.push({ ...withPage.pages[0]!, pageId: 'page-2', order: 2 });
    const kept = await synchronizeReachDeckWorkspaceDocumentStructureWithDeletions(
      TEST_REACH_DECK_SCOPE,
      resource,
      withPage,
    );
    // 文档写入失败时被删页仍在文档里：不退役，记录保留给教师重试删除。
    expect(kept.pendingLaneAdvancePageIds).toEqual([]);
    expect(retirements['run-1']?.pageIds).toEqual(['page-2']);
  });
});
