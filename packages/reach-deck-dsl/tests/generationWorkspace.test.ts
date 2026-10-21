import { describe, expect, it } from 'vitest';

import {
  applyNarrationArtifact,
  applyLessonPlan,
  applyOutlineChange,
  applyPagedDeckOutline,
  applySceneArtifact,
  applySlideNarrationArtifact,
  beginPageGenerationFromOutline,
  createGenerationWorkspace,
  createBlankReachDeckDocument,
  clearPageManualReviewRequired,
  clearSupersededPageNarrationFailure,
  deriveLockedPageIds,
  deriveGenerationInFlightPageIds,
  deriveRenderablePageIds,
  editOutlinePage,
  isReachDeckPageGenerationLocked,
  markNativeSlideCompilationFailed,
  moveOutlinePage,
  ReachDeckPageNotTerminalError,
  ReachDeckPageGenerationContextError,
  requestPageGeneration,
  requestSlideNarrationRegeneration,
  restorePriorGeneration,
  retryFailedPageGeneration,
  parseGenerationWorkspace,
  rewindGenerationWorkspace,
  setPageGenerationStatus,
  stageLessonPlan,
  stagePagedOutline,
  stripSlideNarration,
  updateGenerationSource,
} from '../src/index.js';
import {
  NOW,
  artifactFor,
  landSceneArtifact,
  lessonPlan,
  narratedArtifact,
  outline,
  page,
  prepareForArtifact,
} from './generationFixtures.js';

const LATER = '2026-07-18T08:05:00.000Z';
const RETRIED = '2026-07-18T08:10:00.000Z';

describe('persisted request and status invariants', () => {
  it('rejects a current page request without its status at the workspace read boundary', () => {
    const workspace = prepareForArtifact(workspaceFixture(), 'page-1');
    expect(workspace.records['page-1'].request).toBeDefined();
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);
    const corrupted = structuredClone(workspace);
    delete corrupted.statuses['page-1'];
    expect(() => parseGenerationWorkspace(corrupted)).toThrow();
    corrupted.targetPageIds = corrupted.targetPageIds.filter((id) => id !== 'page-1');
    expect(() => parseGenerationWorkspace(corrupted)).toThrow(/current request/);
  });
});

const workspaceFixture = () =>
  createGenerationWorkspace({
    runId: 'run-1',
    documentId: 'deck-1',
    source: 'authoring source that must remain private',
    lessonPlan,
    pagedOutline: outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
    createdAt: NOW,
  });

const copiedWorkspaceFixture = () => {
  const baseDocument = createBlankReachDeckDocument({
    id: 'deck-1',
    title: 'Copied',
    generatedAt: NOW,
  });
  const basePage = baseDocument.pages[0]!;
  const binding = baseDocument.nativeSlides[0]!;
  baseDocument.pages = ['page-1', 'page-2'].map((pageId, index) => ({
    ...basePage,
    pageId,
    order: index + 1,
    revision: 3,
  }));
  baseDocument.nativeSlides = baseDocument.pages.map(({ pageId }) => ({
    ...structuredClone(binding),
    pageId,
    slide: { ...structuredClone(binding.slide), id: `native-${pageId}` },
  }));
  return parseGenerationWorkspace({
    ...createGenerationWorkspace({
      runId: 'copied-run',
      documentId: 'deck-1',
      source: 'Teach systems',
      createdAt: NOW,
      existingDocument: baseDocument,
    }),
    stage: 'copied',
    lessonPlan,
    pagedOutline: outline([page('page-1', 1, 'slide'), page('page-2', 2, 'slide')]),
  });
};

const failedWorkspaceFixture = (retryable = true, paused = false) => {
  let workspace = workspaceFixture();
  workspace = prepareForArtifact(workspace, 'page-1');
  workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
  workspace = requestPageGeneration(workspace, {
    pageId: 'page-1',
    attempt: 2,
    attemptReason: 'regenerate',
    requestedAt: LATER,
  });
  const request = workspace.records['page-1'].request!;
  const identity = {
    runId: request.runId,
    pageId: request.pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
  };
  workspace = setPageGenerationStatus(
    workspace,
    { ...identity, state: 'generating', startedAt: LATER },
    LATER,
  );
  workspace = setPageGenerationStatus(
    workspace,
    {
      ...identity,
      state: 'failed',
      retryable,
      message: 'Provider temporarily unavailable',
      failedAt: LATER,
    },
    LATER,
  );
  return paused ? { ...workspace, paused: true } : workspace;
};

describe('GenerationWorkspace transitions', () => {
  it('initializes only the requested copied page without importing generation history', () => {
    const copied = copiedWorkspaceFixture();
    copied.stagedLessonPlan = { ...lessonPlan, title: 'Unadopted plan' };
    copied.stagedPagedOutline = { ...copied.pagedOutline!, title: 'Unadopted outline' };
    const original = structuredClone(copied);
    const started = requestPageGeneration(copied, {
      pageId: 'page-2',
      attempt: 1,
      attemptReason: 'initial',
      requestedAt: LATER,
      requestKey: 'request-copied-page',
    });
    expect(started.order).toEqual(['page-1', 'page-2']);
    expect(started.targetPageIds).toEqual(['page-2']);
    expect(started.records['page-2'].request).toMatchObject({
      runId: 'copied-run',
      attempt: 1,
      attemptReason: 'initial',
      requestedRevision: 4,
      requestKey: 'request-copied-page',
    });
    expect(started.records['page-1']).toMatchObject({ revision: 3, attemptHistory: [] });
    expect(started.records['page-1'].request).toBeUndefined();
    expect(Object.keys(started.statuses)).toEqual(['page-2']);
    expect(started.baseDocument).toEqual(original.baseDocument);
    expect(started.pagedOutline).toEqual(original.pagedOutline);
    expect(started.lessonPlan).toEqual(original.lessonPlan);
    expect(started.stagedLessonPlan).toEqual(original.stagedLessonPlan);
    expect(started.stagedPagedOutline).toEqual(original.stagedPagedOutline);
    expect(copied).toEqual(original);
    expect(parseGenerationWorkspace(started)).toEqual(started);
  });

  it('starts another copied page without replacing a landed artifact and then increments a prior attempt', () => {
    let first = requestPageGeneration(copiedWorkspaceFixture(), {
      pageId: 'page-2',
      attempt: 1,
      attemptReason: 'initial',
      requestedAt: LATER,
      requestKey: 'request-first-page',
    });
    first = prepareForArtifact(first, 'page-2');
    first = landSceneArtifact(first, artifactFor(first, 'page-2'));
    const second = requestPageGeneration(first, {
      pageId: 'page-1',
      attempt: 1,
      attemptReason: 'initial',
      requestedAt: RETRIED,
      requestKey: 'request-second-page',
    });
    expect(second.records['page-2']).toEqual(first.records['page-2']);
    expect(second.sceneArtifacts['page-2']).toEqual(first.sceneArtifacts['page-2']);
    expect(second.statuses['page-2']).toEqual(first.statuses['page-2']);
    expect(second.records['page-1'].request).toMatchObject({ attempt: 1, requestedRevision: 4 });
    const regenerated = requestPageGeneration(second, {
      pageId: 'page-2',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: RETRIED,
      requestKey: 'request-again',
    });
    expect(regenerated.records['page-2'].attemptHistory).toHaveLength(2);
    expect(regenerated.records['page-2'].request).toMatchObject({
      attempt: 2,
      requestedRevision: 4,
    });
    expect(parseGenerationWorkspace(regenerated)).toEqual(regenerated);
  });

  it.each([
    'paused',
    'source',
    'technical-source',
    'lesson-plan',
    'outline',
    'base',
    'page-set',
    'page-order',
    'scene-type',
    'unknown-target',
  ])(
    'rejects copied first generation with invalid %s without mutating the workspace',
    (failure) => {
      const copied = copiedWorkspaceFixture();
      let pageId = 'page-2';
      if (failure === 'paused') copied.paused = true;
      if (failure === 'source') copied.source = '';
      if (failure === 'technical-source') copied.source = 'marketplace-copy';
      if (failure === 'lesson-plan') copied.lessonPlan = undefined;
      if (failure === 'outline') copied.pagedOutline = undefined;
      if (failure === 'base') copied.baseDocument = undefined;
      if (failure === 'page-set') copied.pagedOutline!.pages.pop();
      if (failure === 'page-order')
        copied.pagedOutline!.pages.reverse().forEach((page, index) => (page.order = index + 1));
      if (failure === 'scene-type') copied.pagedOutline!.pages[1]!.sceneType = 'quiz';
      if (failure === 'unknown-target') pageId = 'not-materialized';
      const original = structuredClone(copied);
      expect(() =>
        requestPageGeneration(copied, {
          pageId,
          attempt: 1,
          attemptReason: 'initial',
          requestedAt: LATER,
          requestKey: 'request-context-check',
        }),
      ).toThrow(ReachDeckPageGenerationContextError);
      expect(copied).toEqual(original);
    },
  );

  it('keeps copied first generation subject to the initial contiguous-history contract', () => {
    for (const input of [
      { attempt: 1, attemptReason: 'regenerate' as const },
      { attempt: 2, attemptReason: 'initial' as const },
    ]) {
      expect(() =>
        requestPageGeneration(copiedWorkspaceFixture(), {
          ...input,
          pageId: 'page-2',
          requestedAt: LATER,
        }),
      ).toThrow('initial attempt');
    }
  });

  it.each([undefined, '', ' ', 'page-generation-round:full-deck'])(
    'requires an individual request key when starting a copied page: %j',
    (requestKey) => {
      expect(() =>
        requestPageGeneration(copiedWorkspaceFixture(), {
          pageId: 'page-2',
          attempt: 1,
          attemptReason: 'initial',
          requestedAt: LATER,
          requestKey,
        }),
      ).toThrow(ReachDeckPageGenerationContextError);
    },
  );
  it('keeps durable workspaces readable when historical material references exceed write limits', () => {
    const workspace = {
      ...workspaceFixture(),
      materialReferences: Array.from({ length: 65 }, (_, index) => ({
        id: `material-${index}`,
        kind: 'image' as const,
        sha256: index.toString(16).padStart(64, '0'),
        fileName: 'historical.pdf',
        page: index + 1,
      })),
    };

    expect(parseGenerationWorkspace(structuredClone(workspace)).materialReferences).toHaveLength(
      65,
    );
  });

  it('accepts only results matching run, page, requested revision, and attempt', () => {
    const workspace = prepareForArtifact(workspaceFixture(), 'page-1');
    const artifact = artifactFor(workspace, 'page-1');
    expect(applySceneArtifact(workspace, artifact).sceneArtifacts['page-1']).toEqual(artifact);

    for (const late of [
      { ...artifact, runId: 'old-run' },
      { ...artifact, pageId: 'page-2' },
      { ...artifact, requestedRevision: 2 },
      { ...artifact, attempt: 2 },
    ]) {
      expect(applySceneArtifact(workspace, late as typeof artifact)).toBe(workspace);
    }
  });

  it('rejects an artifact whose scene does not match its page identity or scene type', () => {
    const workspace = prepareForArtifact(workspaceFixture(), 'page-2');
    const artifact = artifactFor(workspace, 'page-2');
    if (artifact.sceneType !== 'quiz') throw new Error('Fixture mismatch.');
    expect(() =>
      applySceneArtifact(workspace, { ...artifact, scene: { ...artifact.scene, id: 'other' } }),
    ).toThrow(/id must match.*pageId/i);
    expect(
      applySceneArtifact(workspace, {
        ...artifactFor(workspace, 'page-2'),
        pageId: 'page-1',
      }),
    ).toBe(workspace);
  });

  it('accepts a distinct slide id when artifact and semantic page identities match', () => {
    const workspace = prepareForArtifact(workspaceFixture(), 'page-1');
    const artifact = artifactFor(workspace, 'page-1');
    if (artifact.sceneType !== 'slide') throw new Error('Fixture mismatch.');
    const distinct = {
      ...artifact,
      scene: { ...artifact.scene, id: 'generated-slide-17' },
    };
    expect(applySceneArtifact(workspace, distinct).sceneArtifacts['page-1']).toEqual(distinct);
  });

  it('rejects legacy warning, accepted, or stale runtime results', () => {
    const workspace = prepareForArtifact(workspaceFixture(), 'page-1');
    const artifact = artifactFor(workspace, 'page-1');
    if (artifact.sceneType !== 'slide') throw new Error('Fixture mismatch.');
    for (const status of ['warning', 'accepted', 'stale'] as const) {
      expect(() =>
        applySceneArtifact(workspace, { ...artifact, status } as unknown as typeof artifact),
      ).toThrow(/status is not applicable/i);
    }
    expect(workspace.sceneArtifacts['page-1']).toBeUndefined();

    const quizWorkspace = prepareForArtifact(workspaceFixture(), 'page-2');
    const quizArtifact = artifactFor(quizWorkspace, 'page-2');
    for (const status of ['warning', 'accepted', 'stale'] as const) {
      expect(() =>
        applySceneArtifact(quizWorkspace, {
          ...quizArtifact,
          status,
        } as unknown as typeof quizArtifact),
      ).toThrow(/status is not applicable/i);
    }
  });

  it('regenerates with a contiguous attempt while keeping materialized revision at base plus one', () => {
    const initial = prepareForArtifact(workspaceFixture(), 'page-1');
    const current = landSceneArtifact(initial, artifactFor(initial, 'page-1'));
    const regenerated = requestPageGeneration(current, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
    });
    expect(regenerated.records['page-1']).toMatchObject({
      revision: 1,
      request: { requestedRevision: 1, attempt: 2, attemptReason: 'regenerate' },
    });
    expect(regenerated.records['page-1'].attemptHistory.map(({ attempt }) => attempt)).toEqual([
      1, 2,
    ]);
    expect(regenerated.sceneArtifacts['page-1']?.status).toBe('stale');
    expect(applySceneArtifact(regenerated, artifactFor(workspaceFixture(), 'page-1'))).toBe(
      regenerated,
    );
    expect(() =>
      requestPageGeneration(regenerated, {
        pageId: 'page-1',
        attempt: 4,
        attemptReason: 'regenerate',
        requestedAt: LATER,
      }),
    ).toThrow(/contiguous/i);
    expect(() =>
      requestPageGeneration(regenerated, {
        pageId: 'page-1',
        attempt: 3,
        attemptReason: 'regenerate',
        requestedAt: LATER,
      }),
    ).toThrow(/terminal/i);
  });

  // 回归：首轮生成期间点「重新生成」是可预期的状态冲突。抛裸 Error 会被路由兜底成 500，
  // 教师端只能渲染一句泛化的「操作失败，请重试」（Issue #498 缺陷 A）。
  it('rejects a non-terminal regenerate with a classifiable error code', () => {
    const initial = prepareForArtifact(workspaceFixture(), 'page-1');
    const current = landSceneArtifact(initial, artifactFor(initial, 'page-1'));
    let regenerated = requestPageGeneration(current, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
    });
    const request = regenerated.records['page-1'].request!;
    regenerated = setPageGenerationStatus(
      regenerated,
      {
        runId: request.runId,
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        state: 'generating',
        startedAt: LATER,
      },
      LATER,
    );
    let thrown: unknown;
    try {
      requestPageGeneration(regenerated, {
        pageId: 'page-1',
        attempt: 3,
        attemptReason: 'regenerate',
        requestedAt: LATER,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReachDeckPageNotTerminalError);
    expect((thrown as ReachDeckPageNotTerminalError).code).toBe('PAGE_NOT_TERMINAL');
    expect((thrown as ReachDeckPageNotTerminalError).pageId).toBe('page-1');
    expect((thrown as ReachDeckPageNotTerminalError).state).toBe('generating');
  });

  it('roundtrips an authoring requestKey on the exact regenerate request and history entry', () => {
    const initial = prepareForArtifact(workspaceFixture(), 'page-1');
    const current = landSceneArtifact(initial, artifactFor(initial, 'page-1'));
    const regenerated = requestPageGeneration(current, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
      requestKey: 'regenerate-request-2',
    });

    expect(regenerated.records['page-1'].request).toMatchObject({
      attempt: 2,
      requestKey: 'regenerate-request-2',
    });
    expect(regenerated.records['page-1'].attemptHistory).toEqual([
      expect.not.objectContaining({ requestKey: expect.anything() }),
      expect.objectContaining({ attempt: 2, requestKey: 'regenerate-request-2' }),
    ]);
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(regenerated)))).toEqual(regenerated);
  });

  it('strictly rejects blank, nonstring, and unknown persisted request correlation fields', () => {
    const initial = prepareForArtifact(workspaceFixture(), 'page-1');
    const current = landSceneArtifact(initial, artifactFor(initial, 'page-1'));
    for (const requestKey of ['', '   ', 42] as const) {
      expect(() =>
        requestPageGeneration(current, {
          pageId: 'page-1',
          attempt: 2,
          attemptReason: 'regenerate',
          requestedAt: LATER,
          requestKey: requestKey as unknown as string,
        }),
      ).toThrow(/requestKey.*nonblank string/i);
    }

    const valid = requestPageGeneration(current, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
      requestKey: 'valid-key',
    });
    for (const requestKey of ['', 42] as const) {
      const corrupted = structuredClone(valid);
      const record = corrupted.records['page-1'];
      record.request!.requestKey = requestKey as unknown as string;
      record.attemptHistory[1].requestKey = requestKey as unknown as string;
      expect(() => parseGenerationWorkspace(corrupted)).toThrow(/requestKey.*nonblank string/i);
    }

    const unknown = structuredClone(valid) as unknown as {
      records: Record<
        string,
        {
          request: Record<string, unknown>;
          attemptHistory: Record<string, unknown>[];
        }
      >;
    };
    unknown.records['page-1'].request.unexpectedCorrelation = 'not-allowed';
    unknown.records['page-1'].attemptHistory[1].unexpectedCorrelation = 'not-allowed';
    expect(() => parseGenerationWorkspace(unknown)).toThrow(/unsupported fields/i);
  });

  it('lands a ready slide through narrating and renders it after narration lands', () => {
    let workspace = workspaceFixture();
    workspace = prepareForArtifact(workspace, 'page-1');
    const artifact = artifactFor(workspace, 'page-1');
    // 第一跳：版面落地，页进入 narrating 并立即可预览。
    workspace = applySceneArtifact(workspace, artifact);
    expect(workspace.statuses['page-1'].state).toBe('narrating');
    expect(workspace.sceneArtifacts['page-1'].status).toBe('ready');
    expect(deriveRenderablePageIds(workspace)).toEqual(['page-1']);
    // 第二跳：讲稿落地后转 ready；可渲染集合保持不变。
    workspace = applySlideNarrationArtifact(workspace, narratedArtifact(artifact));
    expect(workspace.statuses['page-1'].state).toBe('ready');
    expect(deriveRenderablePageIds(workspace)).toContain('page-1');
  });

  it('lets a ready page take repeated manual regenerations through the normal pending→generating path', () => {
    let workspace = workspaceFixture();
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    for (const attempt of [2, 3]) {
      workspace = requestPageGeneration(workspace, {
        pageId: 'page-1',
        attempt,
        attemptReason: 'regenerate',
        requestedAt: LATER,
      });
      expect(workspace.statuses['page-1'].state).toBe('pending');
      workspace = prepareForArtifact(workspace, 'page-1');
      expect(workspace.statuses['page-1'].state).toBe('generating');
      workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    }
  });

  it('normalizes a legacy judging status to canonical generating', () => {
    const pending = workspaceFixture();
    const request = pending.records['page-1'].request!;
    const legacy = structuredClone(pending) as unknown as {
      statuses: Record<string, Record<string, unknown>>;
    };
    legacy.statuses['page-1'] = {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
      state: 'judging',
    };
    expect(parseGenerationWorkspace(legacy).statuses['page-1']).toEqual({
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
      state: 'generating',
      startedAt: request.requestedAt,
    });
  });

  it('retries the exact current retryable failure without advancing its attempt', () => {
    const workspace = failedWorkspaceFixture(true, true);
    const record = workspace.records['page-1'];
    const request = record.request!;
    const artifact = workspace.sceneArtifacts['page-1'];
    const identity = {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    };

    const retried = retryFailedPageGeneration(workspace, identity, RETRIED);

    expect(retried).not.toBe(workspace);
    expect(retried.statuses['page-1']).toEqual({
      ...identity,
      state: 'pending',
      requestedAt: RETRIED,
    });
    expect(retried.records).toBe(workspace.records);
    expect(retried.records['page-1']).toBe(record);
    expect(retried.records['page-1'].request).toBe(request);
    expect(retried.records['page-1'].attemptHistory).toBe(record.attemptHistory);
    expect(retried.records['page-1'].attemptHistory).toHaveLength(2);
    expect(retried.records['page-1'].revision).toBe(record.revision);
    expect(retried.sceneArtifacts).toBe(workspace.sceneArtifacts);
    expect(retried.sceneArtifacts['page-1']).toBe(artifact);
    expect(retried.paused).toBe(true);
    expect(retried.stage).toBe('page-generation');
    expect(retried.updatedAt).toBe(RETRIED);
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(retried)))).toEqual(retried);
  });

  it('moves a landed native compilation failure back to failed with a stale artifact', () => {
    let workspace = workspaceFixture();
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = applySceneArtifact(workspace, artifactFor(workspace, 'page-1'));

    const failed = markNativeSlideCompilationFailed(workspace, 'page-1', LATER);

    expect(failed.stage).toBe('page-generation');
    expect(failed.sceneArtifacts['page-1']?.status).toBe('stale');
    expect(failed.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'invalid-output',
      failedAt: LATER,
    });
    const request = failed.records['page-1']!.request!;
    const retried = retryFailedPageGeneration(
      failed,
      {
        runId: request.runId,
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
      },
      RETRIED,
    );
    expect(retried.statuses['page-1']).toMatchObject({ state: 'pending' });
    expect(parseGenerationWorkspace(structuredClone(failed))).toEqual(failed);
  });

  it('does not retry nonretryable, non-failed, late, or mismatched state', () => {
    const nonretryable = failedWorkspaceFixture(false);
    const nonretryableRequest = nonretryable.records['page-1'].request!;
    const exactIdentity = {
      runId: nonretryableRequest.runId,
      pageId: nonretryableRequest.pageId,
      requestedRevision: nonretryableRequest.requestedRevision,
      attempt: nonretryableRequest.attempt,
    };
    expect(retryFailedPageGeneration(nonretryable, exactIdentity, RETRIED)).toBe(nonretryable);

    const pending = workspaceFixture();
    const pendingRequest = pending.records['page-1'].request!;
    const pendingIdentity = {
      runId: pendingRequest.runId,
      pageId: pendingRequest.pageId,
      requestedRevision: pendingRequest.requestedRevision,
      attempt: pendingRequest.attempt,
    };
    expect(retryFailedPageGeneration(pending, pendingIdentity, RETRIED)).toBe(pending);

    const failed = failedWorkspaceFixture();
    const request = failed.records['page-1'].request!;
    const identity = {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    };
    for (const mismatch of [
      { ...identity, runId: 'late-run' },
      { ...identity, pageId: 'page-2' },
      { ...identity, requestedRevision: identity.requestedRevision + 1 },
      { ...identity, attempt: identity.attempt + 1 },
    ]) {
      expect(retryFailedPageGeneration(failed, mismatch, RETRIED)).toBe(failed);
    }

    const mismatchedStatus = structuredClone(failed);
    mismatchedStatus.statuses['page-1'].attempt += 1;
    expect(retryFailedPageGeneration(mismatchedStatus, identity, RETRIED)).toBe(mismatchedStatus);
  });

  it('reorders pages without changing revisions or invalidating artifacts', () => {
    let workspace = workspaceFixture();
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = applySceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    const artifact = workspace.sceneArtifacts['page-1'];
    const moved = applyOutlineChange(
      workspace,
      moveOutlinePage(workspace.pagedOutline!, 'page-2', 'page-1'),
      LATER,
    );
    expect(moved.order).toEqual(['page-2', 'page-1']);
    expect(moved.records['page-1'].revision).toBe(1);
    expect(moved.records['page-2'].revision).toBe(1);
    expect(moved.sceneArtifacts['page-1']).toBe(artifact);
  });

  it('invalidates only the edited outline page without advancing its materialized revision', () => {
    let workspace = workspaceFixture();
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = applySceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    workspace = prepareForArtifact(workspace, 'page-2');
    workspace = applySceneArtifact(workspace, artifactFor(workspace, 'page-2'));
    const untouched = workspace.sceneArtifacts['page-2'];
    const edited = editOutlinePage(workspace.pagedOutline!, 'page-1', (value) => ({
      ...value,
      title: 'Edited title',
    }));
    const next = applyOutlineChange(workspace, edited, LATER);
    expect(next.records['page-1'].revision).toBe(1);
    expect(next.sceneArtifacts['page-1']?.status).toBe('stale');
    expect(next.statuses['page-1']).toMatchObject({
      state: 'pending',
      requestedRevision: 1,
      attempt: 2,
    });
    expect(next.records['page-2'].revision).toBe(1);
    expect(next.sceneArtifacts['page-2']).toBe(untouched);
  });

  it('invalidates the derived outline and all artifacts when the lesson plan changes', () => {
    let workspace = workspaceFixture();
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = applySceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    const next = applyLessonPlan(
      workspace,
      { ...lessonPlan, narrative: 'A changed teaching narrative.' },
      LATER,
    );
    expect(next.stage).toBe('page-outline');
    expect(next.pagedOutline).toBeUndefined();
    expect(next.order).toEqual([]);
    expect(next.records).toEqual({});
    expect(next.sceneArtifacts).toEqual({});
    expect(next.statuses).toEqual({});
  });

  it('strictly parses persisted workspaces and rejects corrupted request identities', () => {
    const workspace = workspaceFixture();
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);
    const corrupted = structuredClone(workspace);
    corrupted.records['page-1'].request!.requestedRevision = 99;
    expect(() => parseGenerationWorkspace(corrupted)).toThrow('request identity');
    expect(() => parseGenerationWorkspace({ ...workspace, unexpected: true })).toThrow(
      'unsupported fields',
    );

    const skippedAttempt = structuredClone(workspace);
    skippedAttempt.records['page-1'].attemptHistory[0].attempt = 2;
    skippedAttempt.records['page-1'].request!.attempt = 2;
    skippedAttempt.statuses['page-1'].attempt = 2;
    expect(() => parseGenerationWorkspace(skippedAttempt)).toThrow(/contiguous/i);

    const derivedAtLessonPlan = {
      ...workspace,
      stage: 'lesson-plan',
      lessonPlan: undefined,
    };
    expect(() => parseGenerationWorkspace(derivedAtLessonPlan)).toThrow(/stage is inconsistent/i);

    let withArtifact = prepareForArtifact(workspaceFixture(), 'page-1');
    withArtifact = applySceneArtifact(withArtifact, artifactFor(withArtifact, 'page-1'));
    const disagreement = structuredClone(withArtifact);
    const disagreementRequest = disagreement.records['page-1'].request!;
    disagreement.statuses['page-1'] = {
      runId: disagreement.runId,
      pageId: 'page-1',
      requestedRevision: disagreementRequest.requestedRevision,
      attempt: disagreementRequest.attempt,
      state: 'generating',
      startedAt: LATER,
    };
    expect(() => parseGenerationWorkspace(disagreement)).toThrow(
      /in-progress status.*current artifact/i,
    );
  });

  it.each(['ready', 'warning', 'accepted'] as const)(
    'normalizes a legacy %s slide and completed status to canonical ready',
    (legacyStatus) => {
      let workspace = workspaceFixture();
      workspace = prepareForArtifact(workspace, 'page-1');
      workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
      const legacy = JSON.parse(JSON.stringify(workspace)) as Record<string, any>;
      legacy.sceneArtifacts['page-1'].status = legacyStatus;
      legacy.sceneArtifacts['page-1'].judgeResult = {
        status: legacyStatus === 'ready' ? 'pass' : 'warning',
        issues:
          legacyStatus === 'ready'
            ? []
            : [
                {
                  id: 'legacy-warning',
                  code: 'TEXT_CAPACITY',
                  elementIds: [],
                  message: 'Legacy advisory warning',
                  details: {},
                },
              ],
      };
      legacy.sceneArtifacts['page-1'].acceptedWarningIds =
        legacyStatus === 'accepted' ? ['legacy-warning'] : [];
      legacy.statuses['page-1'].state = legacyStatus;

      const parsed = parseGenerationWorkspace(legacy);
      expect(parsed.sceneArtifacts['page-1']).toMatchObject({ status: 'ready' });
      expect(parsed.sceneArtifacts['page-1']).not.toHaveProperty('judgeResult');
      expect(parsed.sceneArtifacts['page-1']).not.toHaveProperty('acceptedWarningIds');
      expect(parsed.statuses['page-1']).toMatchObject({ state: 'ready' });
    },
  );

  it('tolerates and discards legacy warning fields on stale artifacts', () => {
    let workspace = workspaceFixture();
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    workspace = requestPageGeneration(workspace, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
    });
    const legacy = JSON.parse(JSON.stringify(workspace)) as Record<string, any>;
    legacy.sceneArtifacts['page-1'].judgeResult = { status: 'pass', issues: [] };
    legacy.sceneArtifacts['page-1'].acceptedWarningIds = ['legacy-warning'];

    const parsed = parseGenerationWorkspace(legacy);
    expect(parsed.sceneArtifacts['page-1']).toMatchObject({ status: 'stale' });
    expect(parsed.sceneArtifacts['page-1']).not.toHaveProperty('judgeResult');
    expect(parsed.sceneArtifacts['page-1']).not.toHaveProperty('acceptedWarningIds');
  });
});

describe('GenerationWorkspace staged fields', () => {
  const generating = () =>
    applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: 'doc-1',
          source: 'Source',
          createdAt: NOW,
        }),
        lessonPlan,
        NOW,
      ),
      outline([page('page-1', 1, 'slide')]),
      NOW,
    );

  const generatingTwoPages = () =>
    applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: 'doc-1',
          source: 'Source',
          createdAt: NOW,
        }),
        lessonPlan,
        NOW,
      ),
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );

  it('round-trips a staged lesson plan during page generation', () => {
    const staged = { ...generating(), stagedLessonPlan: { ...lessonPlan, title: 'Newer plan' } };
    const parsed = parseGenerationWorkspace(staged);
    expect(parsed.stagedLessonPlan?.title).toBe('Newer plan');
  });

  it('rejects a staged lesson plan before any derived content exists', () => {
    const early = createGenerationWorkspace({
      runId: 'run-1',
      documentId: 'doc-1',
      source: 'Source',
      createdAt: NOW,
    });
    expect(() => parseGenerationWorkspace({ ...early, stagedLessonPlan: lessonPlan })).toThrow(
      /staged lesson plan/i,
    );
  });

  it('round-trips a staged paged outline at page-outline and page-generation stages', () => {
    const atOutlineStage = applyLessonPlan(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: 'doc-1',
        source: 'Source',
        createdAt: NOW,
      }),
      lessonPlan,
      NOW,
    );
    expect(atOutlineStage.stage).toBe('page-outline');
    const stagedAtOutline = {
      ...atOutlineStage,
      stagedPagedOutline: outline([page('page-1', 1, 'slide')]),
    };
    expect(parseGenerationWorkspace(stagedAtOutline).stagedPagedOutline?.id).toBe('outline-1');

    const atGeneration = generating();
    const stagedAtGeneration = {
      ...atGeneration,
      stagedPagedOutline: outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
    };
    expect(parseGenerationWorkspace(stagedAtGeneration).stagedPagedOutline?.pages.length).toBe(2);
  });

  it('stages a paged outline candidate without touching page records', () => {
    const atOutlineStage = applyLessonPlan(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: 'doc-1',
        source: 'Source',
        createdAt: NOW,
      }),
      lessonPlan,
      NOW,
    );
    const candidate = outline([page('page-1', 1, 'slide')]);
    const staged = stagePagedOutline(atOutlineStage, candidate, NOW);
    expect(staged.stagedPagedOutline).toEqual(candidate);
    expect(staged.pagedOutline).toBeUndefined();
    expect(staged.records).toEqual({});

    // Staging identical content again returns the same reference.
    expect(stagePagedOutline(staged, candidate, NOW)).toBe(staged);
  });

  it('clears the staged outline slot when the candidate matches the current outline', () => {
    const atGeneration = generating();
    const staged = stagePagedOutline(
      atGeneration,
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );
    expect(staged.stagedPagedOutline).toBeDefined();
    const cleared = stagePagedOutline(staged, atGeneration.pagedOutline!, NOW);
    expect(cleared.stagedPagedOutline).toBeUndefined();

    // No staged outline and staging the current outline again is a no-op.
    expect(stagePagedOutline(atGeneration, atGeneration.pagedOutline!, NOW)).toBe(atGeneration);
  });

  it('throws staging a paged outline at the lesson-plan stage', () => {
    const early = createGenerationWorkspace({
      runId: 'run-1',
      documentId: 'doc-1',
      source: 'Source',
      createdAt: NOW,
    });
    expect(() => stagePagedOutline(early, outline([page('page-1', 1, 'slide')]), NOW)).toThrow(
      /generate a lesson plan/i,
    );
  });

  it('rejects a staged paged outline at a fresh lesson-plan stage', () => {
    const early = createGenerationWorkspace({
      runId: 'run-1',
      documentId: 'doc-1',
      source: 'Source',
      createdAt: NOW,
    });
    expect(() =>
      parseGenerationWorkspace({
        ...early,
        stagedPagedOutline: outline([page('page-1', 1, 'slide')]),
      }),
    ).toThrow(/staged paged outline/i);
  });

  it('round-trips a prior generation snapshot and rejects one beside current artifacts', () => {
    const current = generating();
    const snapshot = {
      lessonPlan: current.lessonPlan!,
      pagedOutline: current.pagedOutline!,
      targetPageIds: current.targetPageIds,
      records: current.records,
      order: current.order,
      sceneArtifacts: current.sceneArtifacts,
      statuses: current.statuses,
      stage: 'page-generation' as const,
    };
    const parsed = parseGenerationWorkspace({ ...current, priorGeneration: snapshot });
    expect(parsed.priorGeneration?.stage).toBe('page-generation');

    const withArtifact = applySceneArtifact(
      prepareForArtifact(current, 'page-1'),
      artifactFor(current, 'page-1'),
    );
    expect(() => parseGenerationWorkspace({ ...withArtifact, priorGeneration: snapshot })).toThrow(
      /prior generation/i,
    );
  });

  it('normalizes legacy warning state recursively inside priorGeneration', () => {
    let completed = generating();
    completed = prepareForArtifact(completed, 'page-1');
    const artifact = artifactFor(completed, 'page-1');
    completed = applySceneArtifact(completed, artifact);
    completed = applySlideNarrationArtifact(completed, narratedArtifact(artifact));
    const restarted = beginPageGenerationFromOutline(completed, completed.pagedOutline!, LATER);
    const legacy = JSON.parse(JSON.stringify(restarted)) as Record<string, any>;
    legacy.priorGeneration.sceneArtifacts['page-1'].status = 'accepted';
    legacy.priorGeneration.sceneArtifacts['page-1'].judgeResult = {
      status: 'warning',
      issues: [
        {
          id: 'legacy-warning',
          code: 'TEXT_CAPACITY',
          elementIds: [],
          message: 'Legacy advisory warning',
          details: {},
        },
      ],
    };
    legacy.priorGeneration.sceneArtifacts['page-1'].acceptedWarningIds = ['legacy-warning'];
    legacy.priorGeneration.statuses['page-1'].state = 'accepted';

    const parsed = parseGenerationWorkspace(legacy);
    expect(parsed.priorGeneration?.sceneArtifacts['page-1']).toMatchObject({ status: 'ready' });
    expect(parsed.priorGeneration?.statuses['page-1']).toMatchObject({ state: 'ready' });
    expect(parsed.priorGeneration?.sceneArtifacts['page-1']).not.toHaveProperty('judgeResult');
  });

  it('rejects a prior generation snapshot missing required fields', () => {
    const current = generating();
    expect(() =>
      parseGenerationWorkspace({
        ...current,
        priorGeneration: { stage: 'page-generation' },
      }),
    ).toThrow(/missing/i);
  });

  it('rejects a prior generation snapshot beside a landed artifact while stage remains page-generation', () => {
    const current = generatingTwoPages();
    const snapshot = {
      lessonPlan: current.lessonPlan!,
      pagedOutline: current.pagedOutline!,
      targetPageIds: current.targetPageIds,
      records: current.records,
      order: current.order,
      sceneArtifacts: current.sceneArtifacts,
      statuses: current.statuses,
      stage: 'page-generation' as const,
    };
    const withOneArtifact = applySceneArtifact(
      prepareForArtifact(current, 'page-1'),
      artifactFor(current, 'page-1'),
    );
    expect(withOneArtifact.stage).toBe('page-generation');
    expect(() =>
      parseGenerationWorkspace({ ...withOneArtifact, priorGeneration: snapshot }),
    ).toThrow(/prior generation/i);
  });

  it('updates the source in place without touching derived state', () => {
    const current = generating();
    const updated = updateGenerationSource(current, 'Fresh source', '2026-08-05T00:00:00.000Z');
    expect(updated.source).toBe('Fresh source');
    expect(updated.records).toBe(current.records);
    expect(updated.stage).toBe(current.stage);
    expect(updated.updatedAt).toBe('2026-08-05T00:00:00.000Z');
    expect(updateGenerationSource(current, current.source, NOW)).toBe(current);
    expect(() => updateGenerationSource(current, '  ', NOW)).toThrow();
  });

  it('promotes immediately in early stages and stages in later stages', () => {
    const early = createGenerationWorkspace({
      runId: 'run-1',
      documentId: 'doc-1',
      source: 'Source',
      createdAt: NOW,
    });
    const promoted = stageLessonPlan(early, lessonPlan, NOW);
    expect(promoted.lessonPlan?.id).toBe(lessonPlan.id);
    expect(promoted.stage).toBe('page-outline');
    expect(promoted.stagedLessonPlan).toBeUndefined();

    const late = generating();
    const staged = stageLessonPlan(late, { ...lessonPlan, title: 'Newer plan' }, NOW);
    expect(staged.stagedLessonPlan?.title).toBe('Newer plan');
    expect(staged.lessonPlan).toEqual(late.lessonPlan);
    expect(staged.records).toBe(late.records);
    // 采用与当前教案相同的内容 = 撤销暂存
    const cleared = stageLessonPlan(staged, late.lessonPlan!, NOW);
    expect(cleared.stagedLessonPlan).toBeUndefined();
    // 重复暂存相同内容 / 采用当前教案且无暂存 均返回同一引用
    expect(stageLessonPlan(staged, { ...lessonPlan, title: 'Newer plan' }, NOW)).toBe(staged);
    expect(stageLessonPlan(late, late.lessonPlan!, NOW)).toBe(late);
  });

  it('stores successive teacher edits even when both use the same validated staged envelope', () => {
    const envelope = { ...lessonPlan, title: 'Staged valid envelope' };
    const first = stageLessonPlan(generating(), envelope, NOW, {
      objectives: [{ statement: 'Old', evidence: 'Old evidence' }],
    });
    const currentEdit = {
      objectives: [],
      learningObjectives: [],
      story: { sections: [] },
      narrative: '',
    };
    const next = stageLessonPlan(first, envelope, '2026-08-05T00:00:00.000Z', currentEdit);
    expect(next.advisoryLessonPlan).toEqual(currentEdit);
    expect(next.stagedLessonPlan).toEqual(first.stagedLessonPlan);
    expect(next.records).toBe(first.records);
    expect(next).not.toBe(first);
    expect(stageLessonPlan(next, envelope, NOW, currentEdit)).toBe(next);
  });

  it.each(['page-outline', 'page-generation'] as const)(
    'removes an explicitly cleared advisory in %s without restoring its old content',
    (stage) => {
      const current = {
        ...generating(),
        stage,
        advisoryLessonPlan: { narrative: 'Old teacher text' },
      };
      const next = stageLessonPlan(current, current.lessonPlan!, NOW, null);
      expect(next).not.toHaveProperty('advisoryLessonPlan');
      expect(next.lessonPlan).toEqual(current.lessonPlan);
    },
  );

  it('leaves a held staged outline candidate intact when re-adopting the identical plan at an early stage', () => {
    const atOutlineStage = applyLessonPlan(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: 'doc-1',
        source: 'Source',
        createdAt: NOW,
      }),
      lessonPlan,
      NOW,
    );
    const candidate = outline([page('page-1', 1, 'slide')]);
    const withStagedOutline = stagePagedOutline(atOutlineStage, candidate, NOW);
    expect(withStagedOutline.stagedPagedOutline).toEqual(candidate);

    const result = stageLessonPlan(withStagedOutline, withStagedOutline.lessonPlan!, NOW);
    expect(result).toBe(withStagedOutline);
    expect(result.stagedPagedOutline).toEqual(candidate);
  });

  it('drops a staged paged outline when staging a plan change, and when undoing back to the current plan', () => {
    const late = generating();
    const withStagedOutline = stagePagedOutline(
      late,
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );
    expect(withStagedOutline.stagedPagedOutline).toBeDefined();

    const stagedPlanB = stageLessonPlan(withStagedOutline, { ...lessonPlan, title: 'Plan B' }, NOW);
    expect(stagedPlanB.stagedLessonPlan?.title).toBe('Plan B');
    expect(stagedPlanB.stagedPagedOutline).toBeUndefined();

    const withStagedOutlineAgain = stagePagedOutline(
      stagedPlanB,
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );
    expect(withStagedOutlineAgain.stagedPagedOutline).toBeDefined();
    const undone = stageLessonPlan(withStagedOutlineAgain, late.lessonPlan!, NOW);
    expect(undone.stagedLessonPlan).toBeUndefined();
    expect(undone.stagedPagedOutline).toBeUndefined();
  });

  it('snapshots the prior round, promotes the staged plan, and restarts every page', () => {
    const late = stagePagedOutline(
      stageLessonPlan(generating(), { ...lessonPlan, title: 'Newer plan' }, NOW),
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz'), page('page-3', 3, 'slide')]),
      NOW,
    );
    const nextOutline = outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]);
    const begun = beginPageGenerationFromOutline(late, nextOutline, '2026-08-05T00:00:00.000Z');
    expect(begun.lessonPlan?.title).toBe('Newer plan');
    expect(begun.stagedLessonPlan).toBeUndefined();
    expect(begun.stagedPagedOutline).toBeUndefined();
    expect(begun.stage).toBe('page-generation');
    expect(begun.targetPageIds).toEqual(['page-1', 'page-2']);
    expect(begun.sceneArtifacts).toEqual({});
    expect(begun.priorGeneration?.lessonPlan).toEqual(late.lessonPlan);
    expect(begun.priorGeneration?.records).toBe(late.records);
    expect(parseGenerationWorkspace(begun)).toBeTruthy();
  });

  it('keeps the oldest snapshot across repeated begins without landings', () => {
    const first = beginPageGenerationFromOutline(
      generating(),
      outline([page('page-1', 1, 'slide')]),
      NOW,
    );
    const second = beginPageGenerationFromOutline(
      first,
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );
    expect(second.priorGeneration).toBe(first.priorGeneration);
  });

  it('advances retained pages while storing a server-owned request key for the repeated round', () => {
    const restarted = beginPageGenerationFromOutline(
      generating(),
      outline([page('page-1', 1, 'slide')]),
      LATER,
      undefined,
      'page-generation-round:12',
    );

    expect(restarted.records['page-1'].request).toMatchObject({
      attempt: 2,
      attemptReason: 'regenerate',
      requestKey: 'page-generation-round:12',
    });
    expect(restarted.records['page-1'].attemptHistory).toEqual([
      expect.objectContaining({ attempt: 1, attemptReason: 'initial' }),
      expect.objectContaining({
        attempt: 2,
        attemptReason: 'regenerate',
        requestKey: 'page-generation-round:12',
      }),
    ]);
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(restarted)))).toEqual(restarted);
  });

  it('drops the prior-round snapshot when the first artifact of the new round lands', () => {
    let complete = prepareForArtifact(generating(), 'page-1');
    complete = landSceneArtifact(complete, artifactFor(complete, 'page-1'));
    expect(complete.stage).toBe('complete');

    const begun = beginPageGenerationFromOutline(
      complete,
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );
    expect(begun.priorGeneration).toBeDefined();

    let landed = prepareForArtifact(begun, 'page-1');
    landed = applySceneArtifact(landed, artifactFor(landed, 'page-1'));
    expect(landed.priorGeneration).toBeUndefined();
    expect(() => parseGenerationWorkspace(landed)).not.toThrow();
  });

  it('restores the prior round and re-stages the abandoned plan and outline', () => {
    const late = generating();
    const abandonedOutline = outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]);
    const begun = beginPageGenerationFromOutline(
      stageLessonPlan(late, { ...lessonPlan, title: 'Newer plan' }, NOW),
      abandonedOutline,
      NOW,
    );
    const restored = restorePriorGeneration(begun, '2026-08-05T01:00:00.000Z', 'run-restored');
    expect(restored.runId).toBe('run-restored');
    expect(restored.records['page-1']).toMatchObject({
      request: { runId: 'run-restored' },
      attemptHistory: [expect.objectContaining({ runId: 'run-restored' })],
    });
    expect(restored.stage).toBe(late.stage);
    expect(restored.priorGeneration).toBeUndefined();
    expect(restored.stagedLessonPlan?.title).toBe('Newer plan');
    expect(restored.stagedPagedOutline).toEqual(abandonedOutline);
    expect(restorePriorGeneration(late, NOW, 'unused-run')).toBe(late);
  });

  it('does not re-stage the outline on restore when it matches the prior round', () => {
    const late = generating();
    const begun = beginPageGenerationFromOutline(
      stageLessonPlan(late, { ...lessonPlan, title: 'Newer plan' }, NOW),
      late.pagedOutline!,
      NOW,
    );
    const restored = restorePriorGeneration(begun, '2026-08-05T01:00:00.000Z', 'run-restored');
    expect(restored.stagedPagedOutline).toBeUndefined();
  });

  it('restores a completed round intact', () => {
    let complete = prepareForArtifact(generating(), 'page-1');
    complete = landSceneArtifact(complete, artifactFor(complete, 'page-1'));
    expect(complete.stage).toBe('complete');

    const begun = beginPageGenerationFromOutline(
      complete,
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );
    expect(begun.priorGeneration?.stage).toBe('complete');
    expect(begun.stage).toBe('page-generation');

    const restored = restorePriorGeneration(begun, '2026-08-05T02:00:00.000Z', 'run-restored');
    expect(restored.stage).toBe('complete');
    expect(restored.sceneArtifacts['page-1']).toMatchObject({ runId: 'run-restored' });
    expect(restored.statuses['page-1']).toMatchObject({ runId: 'run-restored', state: 'ready' });
    expect(restored.priorGeneration).toBeUndefined();
    expect(() => parseGenerationWorkspace(restored)).not.toThrow();
  });

  it('avoids attempt-one collisions when an abandoned new page is adopted again after restore', () => {
    const original = generating();
    const abandonedOutline = outline([
      page('page-1', 1, 'slide'),
      page('brand-new-page', 2, 'quiz'),
    ]);
    const abandoned = beginPageGenerationFromOutline(
      original,
      abandonedOutline,
      NOW,
      undefined,
      'page-generation-round:2',
    );
    expect(abandoned.records['brand-new-page'].request).toMatchObject({
      runId: 'run-1',
      attempt: 1,
    });

    const restored = restorePriorGeneration(abandoned, LATER, 'run-restored');
    const readopted = beginPageGenerationFromOutline(
      restored,
      restored.stagedPagedOutline!,
      '2026-08-05T03:00:00.000Z',
      undefined,
      'page-generation-round:3',
    );
    expect(readopted.records['brand-new-page'].request).toMatchObject({
      runId: 'run-restored',
      attempt: 1,
      requestKey: 'page-generation-round:3',
    });
    expect(() => parseGenerationWorkspace(readopted)).not.toThrow();
  });

  it('v1 destructive transitions clear staged fields instead of producing invalid workspaces', () => {
    const late = stagePagedOutline(
      stageLessonPlan(generating(), { ...lessonPlan, title: 'Newer plan' }, NOW),
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );
    const applied = applyLessonPlan(late, { ...lessonPlan, title: 'Applied plan' }, NOW);
    expect(applied.stagedLessonPlan).toBeUndefined();
    expect(applied.stagedPagedOutline).toBeUndefined();
    expect(parseGenerationWorkspace(applied)).toBeTruthy();

    // A staged outline alone (same lesson plan, no staged plan or prior snapshot)
    // still forces applyLessonPlan off its no-op fast path.
    const onlyStagedOutline = stagePagedOutline(
      generating(),
      outline([page('page-1', 1, 'slide'), page('page-2', 2, 'quiz')]),
      NOW,
    );
    const reapplied = applyLessonPlan(onlyStagedOutline, onlyStagedOutline.lessonPlan!, NOW);
    expect(reapplied).not.toBe(onlyStagedOutline);
    expect(reapplied.stagedPagedOutline).toBeUndefined();

    const begun = beginPageGenerationFromOutline(late, outline([page('page-1', 1, 'slide')]), NOW);
    const rewound = rewindGenerationWorkspace(begun, 'page-outline', NOW);
    expect(rewound.priorGeneration).toBeUndefined();
    expect(rewound.stagedLessonPlan).toBeUndefined();
    expect(rewound.stagedPagedOutline).toBeUndefined();
  });
});

describe('narrating 状态机（讲稿独立阶段）', () => {
  const narratingFixture = () => {
    let workspace = prepareForArtifact(workspaceFixture(), 'page-1');
    const artifact = artifactFor(workspace, 'page-1');
    workspace = applySceneArtifact(workspace, artifact);
    return { workspace, artifact };
  };

  const interactiveNarratingFixture = () => {
    let workspace = createGenerationWorkspace({
      runId: 'run-interactive',
      documentId: 'deck-interactive',
      source: 'interactive source',
      lessonPlan,
      pagedOutline: outline([page('interactive-page', 1, 'interactive')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'interactive-page');
    const baseArtifact = artifactFor(workspace, 'interactive-page');
    if (baseArtifact.sceneType !== 'interactive') throw new Error('Fixture mismatch.');
    const artifact = {
      ...baseArtifact,
      scene: {
        ...baseArtifact.scene,
        narration: {
          schemaVersion: 'reach-interactive-narration/v1' as const,
          text: 'Adjust the control and observe the result.',
        },
      },
    };
    workspace = applySceneArtifact(workspace, artifact);
    return { workspace, artifact };
  };

  it('slide 版面落地进入 narrating，讲稿落地后转 ready', () => {
    const { workspace, artifact } = narratingFixture();
    expect(workspace.statuses['page-1'].state).toBe('narrating');
    expect(deriveRenderablePageIds(workspace)).toEqual(['page-1']);
    expect(workspace.stage).toBe('page-generation');

    const landed = applySlideNarrationArtifact(workspace, narratedArtifact(artifact));
    expect(landed.statuses['page-1']).toMatchObject({ state: 'ready' });
    expect(deriveRenderablePageIds(landed)).toEqual(['page-1']);
    const scene =
      'scene' in landed.sceneArtifacts['page-1']
        ? landed.sceneArtifacts['page-1'].scene
        : undefined;
    if (landed.sceneArtifacts['page-1'].sceneType !== 'slide') throw new Error('Fixture mismatch.');
    expect((scene as { voiceTimeline: unknown[] }).voiceTimeline).toHaveLength(1);
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(landed)))).toEqual(landed);
  });

  it('没有讲稿的非 slide 页不经过 narrating，仍一跳落到 ready', () => {
    let workspace = prepareForArtifact(workspaceFixture(), 'page-2');
    workspace = applySceneArtifact(workspace, artifactFor(workspace, 'page-2'));
    expect(workspace.statuses['page-2'].state).toBe('ready');
  });

  it('Interactive 正文先进入 narrating，音频落地后转 ready', () => {
    const { workspace, artifact } = interactiveNarratingFixture();
    expect(workspace.statuses['interactive-page'].state).toBe('narrating');
    expect(deriveRenderablePageIds(workspace)).toEqual(['interactive-page']);
    expect(parseGenerationWorkspace(structuredClone(workspace))).toEqual(workspace);

    const withAudio = {
      ...artifact,
      scene: {
        ...artifact.scene,
        narration: { ...artifact.scene.narration, audioResourceId: 'interactive-audio' },
      },
    };
    const landed = applyNarrationArtifact(workspace, withAudio);
    expect(landed.statuses['interactive-page'].state).toBe('ready');
    expect(landed.sceneArtifacts['interactive-page']).toMatchObject({
      scene: { narration: { audioResourceId: 'interactive-audio' } },
    });

    // The server stages the audio-bearing artifact before materialized-document backfill;
    // that recoverable intermediate must remain parseable and complete idempotently.
    const staged = parseGenerationWorkspace({
      ...workspace,
      sceneArtifacts: {
        ...workspace.sceneArtifacts,
        'interactive-page': withAudio,
      },
      statuses: {
        ...landed.statuses,
        'interactive-page': {
          ...workspace.statuses['interactive-page'],
          state: 'narrating',
        },
      },
    });
    expect(staged.statuses['interactive-page'].state).toBe('narrating');
    const completed = applyNarrationArtifact(staged, withAudio);
    expect(completed.statuses['interactive-page'].state).toBe('ready');
  });

  it('Interactive 讲稿落地拒绝正文或页面内容被替换的迟到结果', () => {
    const { workspace, artifact } = interactiveNarratingFixture();
    const audioResult = {
      ...artifact,
      scene: {
        ...artifact.scene,
        narration: { ...artifact.scene.narration, audioResourceId: 'interactive-audio' },
      },
    };
    expect(
      applyNarrationArtifact(workspace, {
        ...audioResult,
        scene: {
          ...audioResult.scene,
          narration: { ...audioResult.scene.narration, text: 'Replaced text.' },
        },
      }),
    ).toBe(workspace);
    expect(
      applyNarrationArtifact(workspace, {
        ...audioResult,
        scene: { ...audioResult.scene, documentHtml: `${audioResult.scene.documentHtml} ` },
      }),
    ).toBe(workspace);
  });

  it('Interactive TTS 失败保留正文工件并只重试 narration lane', () => {
    const { workspace } = interactiveNarratingFixture();
    const request = workspace.records['interactive-page'].request!;
    const identity = {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    };
    const failed = setPageGenerationStatus(
      workspace,
      { ...identity, state: 'failed', retryable: true, message: 'tts failed', failedAt: LATER },
      LATER,
    );
    expect(parseGenerationWorkspace(structuredClone(failed))).toEqual(failed);
    expect(deriveRenderablePageIds(failed)).toEqual(['interactive-page']);
    expect(
      retryFailedPageGeneration(failed, identity, RETRIED).statuses['interactive-page'],
    ).toEqual({ ...identity, state: 'narrating', startedAt: RETRIED });
  });

  it('narrating 期间重放版面结果是无操作', () => {
    const { workspace, artifact } = narratingFixture();
    expect(applySceneArtifact(workspace, artifact)).toBe(workspace);
  });

  it('讲稿结果的版面或身份不匹配时被静默忽略', () => {
    const { workspace, artifact } = narratingFixture();
    const narrated = narratedArtifact(artifact);
    if (narrated.sceneType !== 'slide' || artifact.sceneType !== 'slide') {
      throw new Error('Fixture mismatch.');
    }
    // 版面已变（元素文案不同）：讲稿对着旧版面写成，丢弃。
    const changedLayout = {
      ...narrated,
      scene: {
        ...narrated.scene,
        elements: narrated.scene.elements.map((element) => ({ ...element, layer: 5 })),
      },
    };
    expect(applySlideNarrationArtifact(workspace, changedLayout)).toBe(workspace);
    // 身份不匹配：迟到的旧尝试。
    expect(applySlideNarrationArtifact(workspace, { ...narrated, attempt: 99 })).toBe(workspace);
    // duration/voiceTimeline 的差异不参与版面比较：stripSlideNarration 等价即可落地。
    const longer = {
      ...narrated,
      scene: { ...narrated.scene, duration: 30 },
    };
    expect(applySlideNarrationArtifact(workspace, longer)).not.toBe(workspace);
  });

  it('非 narrating 页的讲稿结果被忽略（pending/ready 等状态不接收讲稿）', () => {
    const pending = workspaceFixture();
    const artifact = artifactFor(pending, 'page-1');
    expect(applySlideNarrationArtifact(pending, narratedArtifact(artifact))).toBe(pending);

    const { workspace, artifact: landedArtifact } = narratingFixture();
    const ready = applySlideNarrationArtifact(workspace, narratedArtifact(landedArtifact));
    // 已 ready 后重复落讲稿：无操作。
    expect(applySlideNarrationArtifact(ready, narratedArtifact(landedArtifact))).toBe(ready);
  });

  it('narrating 页可标记 failed（讲稿任务失败），重试回到 narrating 只重跑讲稿', () => {
    const { workspace } = narratingFixture();
    const request = workspace.records['page-1'].request!;
    const identity = {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    };
    const failed = setPageGenerationStatus(
      workspace,
      { ...identity, state: 'failed', retryable: true, message: 'internal', failedAt: LATER },
      LATER,
    );
    expect(failed.statuses['page-1'].state).toBe('failed');
    // 讲稿阶段失败保留版面工件：failed + 非 stale slide 工件是合法持久化形态。
    expect(failed.sceneArtifacts['page-1'].status).toBe('ready');
    expect(deriveRenderablePageIds(failed)).toEqual(['page-1']);
    expect(deriveLockedPageIds(failed)).not.toContain('page-1');
    expect(failed.stage).toBe('page-generation');
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(failed)))).toEqual(failed);

    const retried = retryFailedPageGeneration(failed, identity, RETRIED);
    expect(retried.statuses['page-1']).toEqual({
      ...identity,
      state: 'narrating',
      startedAt: RETRIED,
    });
    // 版面工件原样保留，重试不重跑版面。
    expect(retried.sceneArtifacts['page-1']).toBe(failed.sceneArtifacts['page-1']);
  });

  it('讲稿纠正耗尽后进入独立待审核状态，候选保持 opaque 且保存成功可清除', () => {
    const { workspace } = narratingFixture();
    const request = workspace.records['page-1'].request!;
    const identity = {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    };
    const manual = setPageGenerationStatus(
      workspace,
      {
        ...identity,
        state: 'manual-review-required',
        candidateMarkdown: '# provider candidate',
        message: 'invalid-output',
        failedAt: LATER,
      },
      LATER,
    );
    expect(manual.statuses['page-1']).toMatchObject({
      state: 'manual-review-required',
      candidateMarkdown: '# provider candidate',
    });
    expect(deriveRenderablePageIds(manual)).toEqual(['page-1']);
    expect(deriveLockedPageIds(manual)).not.toContain('page-1');
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(manual)))).toEqual(manual);
    const cleared = clearPageManualReviewRequired(manual, identity, RETRIED);
    expect(cleared.statuses['page-1']).toMatchObject({
      state: 'ready',
      sceneId:
        'scene' in manual.sceneArtifacts['page-1']
          ? manual.sceneArtifacts['page-1'].scene.id
          : undefined,
    });
  });

  it('native 讲稿落地只清掉产物生成之前的讲稿阶段失败', () => {
    const { workspace } = narratingFixture();
    const request = workspace.records['page-1'].request!;
    const identity = {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    };
    const failed = setPageGenerationStatus(
      workspace,
      { ...identity, state: 'failed', retryable: true, message: 'internal', failedAt: LATER },
      LATER,
    );
    const cleared = clearSupersededPageNarrationFailure(failed, 'page-1', LATER, RETRIED);
    expect(cleared.statuses['page-1']).toMatchObject({
      ...identity,
      state: 'ready',
      completedAt: RETRIED,
    });
    expect(parseGenerationWorkspace(structuredClone(cleared))).toEqual(cleared);
    // 产物生成之后才出现的失败（工作区通道又一次失败）是新的失败。
    expect(clearSupersededPageNarrationFailure(failed, 'page-1', NOW, RETRIED)).toBe(failed);
    // 版面失败（工件 stale）不是讲稿阶段失败。
    const layoutFailed = markNativeSlideCompilationFailed(workspace, 'page-1', LATER);
    expect(layoutFailed.statuses['page-1']?.state).toBe('failed');
    expect(clearSupersededPageNarrationFailure(layoutFailed, 'page-1', RETRIED, RETRIED)).toBe(
      layoutFailed,
    );
    // 非失败状态不动。
    expect(clearSupersededPageNarrationFailure(workspace, 'page-1', RETRIED, RETRIED)).toBe(
      workspace,
    );
  });

  it('narrating 期间不可 regenerate（页处于锁定在途态）', () => {
    let workspace = prepareForArtifact(workspaceFixture(), 'page-1');
    workspace = applySceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    expect(workspace.statuses['page-1'].state).toBe('narrating');
    expect(() =>
      requestPageGeneration(workspace, {
        pageId: 'page-1',
        attempt: 2,
        attemptReason: 'regenerate',
        requestedAt: LATER,
      }),
    ).toThrow(/terminal/i);
  });

  it('parse 校验：narrating 需要已判卷版面工件、只允许 slide 页', () => {
    const { workspace } = narratingFixture();
    const missingArtifact = structuredClone(workspace);
    delete (missingArtifact.sceneArtifacts as Record<string, unknown>)['page-1'];
    expect(() => parseGenerationWorkspace(missingArtifact)).toThrow(
      /narrating status requires a current slide artifact/i,
    );

    let quizWorkspace = prepareForArtifact(workspaceFixture(), 'page-2');
    quizWorkspace = applySceneArtifact(quizWorkspace, artifactFor(quizWorkspace, 'page-2'));
    const corrupted = structuredClone(quizWorkspace);
    const quizStatus = corrupted.statuses['page-2'];
    corrupted.statuses['page-2'] = {
      runId: quizStatus.runId,
      pageId: quizStatus.pageId,
      requestedRevision: quizStatus.requestedRevision,
      attempt: quizStatus.attempt,
      state: 'narrating',
      startedAt: NOW,
    } as (typeof corrupted.statuses)[string];
    // quiz 工件先撞 narrating 的"需要当前 slide 工件"守卫（页类型守卫在其后兜底）。
    expect(() => parseGenerationWorkspace(corrupted)).toThrow(
      /narrating status requires a current slide artifact/i,
    );
  });

  describe('requestSlideNarrationRegeneration（教师重新生成讲稿）', () => {
    /** page-1 讲稿已落地（ready）、page-2 quiz 已落地 → 工作区 complete 的夹具。 */
    const completedFixture = () => {
      let workspace = prepareForArtifact(workspaceFixture(), 'page-1');
      workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
      workspace = prepareForArtifact(workspace, 'page-2');
      workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-2'));
      expect(workspace.stage).toBe('complete');
      return workspace;
    };

    it('ready 页回到 narrating：attempt 推进、版面工件换到新身份、stage 回 page-generation', () => {
      const workspace = completedFixture();
      const regenerated = requestSlideNarrationRegeneration(workspace, {
        pageId: 'page-1',
        attempt: 2,
        requestedAt: RETRIED,
        requestKey: 'request-key-1',
      });
      expect(regenerated.statuses['page-1']).toMatchObject({
        state: 'narrating',
        attempt: 2,
        startedAt: RETRIED,
      });
      const request = regenerated.records['page-1'].request!;
      expect(request).toMatchObject({
        attempt: 2,
        attemptReason: 'regenerate',
        requestKey: 'request-key-1',
      });
      expect(regenerated.records['page-1'].attemptHistory).toHaveLength(2);
      // 版面工件保留（scene/judge 不变），仅身份随请求推进到新 attempt。
      const artifact = regenerated.sceneArtifacts['page-1'];
      const originalArtifact = workspace.sceneArtifacts['page-1'];
      if (!('scene' in artifact) || !('scene' in originalArtifact))
        throw new Error('Fixture mismatch.');
      expect(artifact).toMatchObject({ attempt: 2, status: 'ready' });
      expect(artifact.scene).toEqual(originalArtifact.scene);
      // narrating 页仍可预览且允许版面编辑；结构/发布门仍视其为生成中。
      expect(regenerated.stage).toBe('page-generation');
      expect(deriveRenderablePageIds(regenerated)).toEqual(['page-1', 'page-2']);
      expect(deriveLockedPageIds(regenerated)).toEqual([]);
      expect(deriveGenerationInFlightPageIds(regenerated)).toEqual(['page-1']);
      // 持久化往返合法。
      expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(regenerated)))).toEqual(
        regenerated,
      );
    });

    it('讲稿重生成结果按新 attempt 身份落地，工作区回到 complete', () => {
      const workspace = completedFixture();
      const regenerated = requestSlideNarrationRegeneration(workspace, {
        pageId: 'page-1',
        attempt: 2,
        requestedAt: RETRIED,
      });
      const current = regenerated.sceneArtifacts['page-1'];
      if (current.sceneType !== 'slide' || current.status === 'stale' || !('scene' in current)) {
        throw new Error('Fixture mismatch.');
      }
      const landed = applySlideNarrationArtifact(regenerated, {
        ...current,
        status: 'ready',
        scene: {
          ...current.scene,
          voiceTimeline: [
            { id: 'narration-2', label: '讲稿 2', text: '重写后的讲稿。', start: 0, end: 9 },
          ],
          duration: 10,
        },
        generatedAt: RETRIED,
      });
      expect(landed.statuses['page-1']).toMatchObject({ state: 'ready', attempt: 2 });
      expect(landed.stage).toBe('complete');
      const landedArtifact = landed.sceneArtifacts['page-1'];
      if (!('scene' in landedArtifact)) throw new Error('Fixture mismatch.');
      const scene = landedArtifact.scene as { voiceTimeline: { text: string }[] };
      expect(scene.voiceTimeline[0]?.text).toBe('重写后的讲稿。');
    });

    it('ready 页可重生成讲稿且保留版面元数据', () => {
      let workspace = prepareForArtifact(workspaceFixture(), 'page-1');
      const artifact = artifactFor(workspace, 'page-1');
      workspace = applySceneArtifact(workspace, artifact);
      workspace = applySlideNarrationArtifact(workspace, narratedArtifact(artifact));
      expect(workspace.statuses['page-1'].state).toBe('ready');

      const regenerated = requestSlideNarrationRegeneration(workspace, {
        pageId: 'page-1',
        attempt: 2,
        requestedAt: RETRIED,
      });
      expect(regenerated.statuses['page-1']).toMatchObject({ state: 'narrating', attempt: 2 });
      const regeneratedArtifact = regenerated.sceneArtifacts['page-1'];
      if (regeneratedArtifact.sceneType !== 'slide') throw new Error('Fixture mismatch.');
      expect(regeneratedArtifact.status).toBe('ready');
      expect(regeneratedArtifact.generationMetadata).toEqual(
        workspace.sceneArtifacts['page-1'].sceneType === 'slide'
          ? workspace.sceneArtifacts['page-1'].generationMetadata
          : undefined,
      );
      expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(regenerated)))).toEqual(
        regenerated,
      );
    });

    it('讲稿阶段失败（failed + 保留版面工件）的页可经本转换回到 narrating', () => {
      const { workspace } = narratingFixture();
      const request = workspace.records['page-1'].request!;
      const failed = setPageGenerationStatus(
        workspace,
        {
          runId: request.runId,
          pageId: request.pageId,
          requestedRevision: request.requestedRevision,
          attempt: request.attempt,
          state: 'failed',
          retryable: true,
          message: 'internal',
          failedAt: LATER,
        },
        LATER,
      );
      const regenerated = requestSlideNarrationRegeneration(failed, {
        pageId: 'page-1',
        attempt: 2,
        requestedAt: RETRIED,
      });
      expect(regenerated.statuses['page-1']).toMatchObject({
        state: 'narrating',
        attempt: 2,
        startedAt: RETRIED,
      });
      expect(regenerated.sceneArtifacts['page-1']).toMatchObject({ attempt: 2, status: 'ready' });
      expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(regenerated)))).toEqual(
        regenerated,
      );
    });

    it('拒绝非法前置：在途页、非 slide 页、工件缺失、attempt 不连续', () => {
      // narrating 在途：单飞行守卫。
      const { workspace: narrating } = narratingFixture();
      expect(() =>
        requestSlideNarrationRegeneration(narrating, {
          pageId: 'page-1',
          attempt: 2,
          requestedAt: RETRIED,
        }),
      ).toThrow(/cannot start from narrating/i);
      // pending（未生成过）：无版面工件。
      expect(() =>
        requestSlideNarrationRegeneration(workspaceFixture(), {
          pageId: 'page-1',
          attempt: 2,
          requestedAt: RETRIED,
        }),
      ).toThrow(/landed slide artifact/i);
      const completed = completedFixture();
      // 非 slide 页。
      expect(() =>
        requestSlideNarrationRegeneration(completed, {
          pageId: 'page-2',
          attempt: 2,
          requestedAt: RETRIED,
        }),
      ).toThrow(/only applies to slide pages/i);
      // 未知页。
      expect(() =>
        requestSlideNarrationRegeneration(completed, {
          pageId: 'page-x',
          attempt: 2,
          requestedAt: RETRIED,
        }),
      ).toThrow(/requires a generated page/i);
      // attempt 不连续。
      expect(() =>
        requestSlideNarrationRegeneration(completed, {
          pageId: 'page-1',
          attempt: 3,
          requestedAt: RETRIED,
        }),
      ).toThrow(/contiguous/i);
    });
  });

  it('stripSlideNarration 去掉讲稿改写的字段，其余版面字段保留', () => {
    const artifact = artifactFor(workspaceFixture(), 'page-1');
    if (artifact.sceneType !== 'slide') throw new Error('Fixture mismatch.');
    const stripped = stripSlideNarration(narratedArtifact(artifact).scene as typeof artifact.scene);
    expect(stripped).not.toHaveProperty('voiceTimeline');
    expect(stripped).not.toHaveProperty('duration');
    expect(stripped).toMatchObject({ id: artifact.scene.id, elements: artifact.scene.elements });
    expect(stripped).toEqual(stripSlideNarration(artifact.scene));
  });

  it('讲稿动画不参与版面并发比较，但教师动画仍参与', () => {
    const { workspace, artifact } = narratingFixture();
    if (artifact.sceneType !== 'slide') throw new Error('Fixture mismatch.');
    const narrated = narratedArtifact(artifact);
    if (narrated.sceneType !== 'slide') throw new Error('Fixture mismatch.');
    const targetId = artifact.scene.elements[0]!.id;
    const narrationAnimation = {
      id: `narration-entrance:${targetId}`,
      type: 'fade' as const,
      targetId,
      start: 1,
      duration: 0.4,
      from: { opacity: 0 },
      to: { opacity: 1 },
    };
    const withNarrationAnimation = {
      ...narrated,
      scene: { ...narrated.scene, animations: [narrationAnimation] },
    };
    expect(applySlideNarrationArtifact(workspace, withNarrationAnimation)).not.toBe(workspace);

    const teacherAnimation = { ...narrationAnimation, id: 'teacher-animation' };
    const withTeacherAnimation = {
      ...narrated,
      scene: { ...narrated.scene, animations: [teacherAnimation] },
    };
    expect(applySlideNarrationArtifact(workspace, withTeacherAnimation)).toBe(workspace);
  });
});

describe('deriveLockedPageIds', () => {
  const generating = () =>
    applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: 'doc-1',
          source: 'Source',
          createdAt: NOW,
        }),
        lessonPlan,
        NOW,
      ),
      outline([page('page-1', 1, 'slide')]),
      NOW,
    );

  const identityFor = (workspace: ReturnType<typeof generating>, pageId: string) => {
    const request = workspace.records[pageId].request!;
    return {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    };
  };

  it('locks in-flight pages and releases terminal ones', () => {
    const workspace = generating(); // page-1 状态为 pending
    expect(deriveLockedPageIds(workspace)).toEqual(['page-1']);

    const generatingWorkspace = prepareForArtifact(workspace, 'page-1');
    expect(deriveLockedPageIds(generatingWorkspace)).toEqual(['page-1']);

    // 版面落地后页进入 narrating：媒体仍在途，但版面编辑已解锁。
    const narrating = applySceneArtifact(
      generatingWorkspace,
      artifactFor(generatingWorkspace, 'page-1'),
    );
    expect(narrating.statuses['page-1'].state).toBe('narrating');
    expect(deriveLockedPageIds(narrating)).toEqual([]);
    expect(deriveGenerationInFlightPageIds(narrating)).toEqual(['page-1']);

    const landed = applySlideNarrationArtifact(
      narrating,
      narratedArtifact(artifactFor(generatingWorkspace, 'page-1')),
    );
    expect(deriveLockedPageIds(landed)).toEqual([]);

    const failed = setPageGenerationStatus(
      prepareForArtifact(workspace, 'page-1'),
      {
        ...identityFor(workspace, 'page-1'),
        state: 'failed',
        retryable: true,
        message: 'boom',
        failedAt: NOW,
      },
      NOW,
    );
    expect(deriveLockedPageIds(failed)).toEqual([]);

    // Stale pages stay editable by design: only in-flight states lock a page.
    expect(
      isReachDeckPageGenerationLocked({
        ...identityFor(workspace, 'page-1'),
        state: 'stale',
        invalidatedAt: NOW,
      }),
    ).toBe(false);
  });
});
