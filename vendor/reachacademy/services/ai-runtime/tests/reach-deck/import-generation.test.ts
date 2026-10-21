import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import type { ReachDeckImportGenerationIntents } from '../../lib/reach-deck/import-generation-contracts.js';
import {
  parseReachDeckImportGenerationIntents,
  retainReachDeckImportGenerationIntents,
} from '../../lib/reach-deck/import-generation-contracts.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const deps = vi.hoisted(() => ({
  recovery: vi.fn(),
  transition: vi.fn(),
  workspace: vi.fn(),
  materialized: vi.fn(),
  voice: vi.fn(),
  register: vi.fn(),
  resume: vi.fn(),
  lease: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  loadReachDeckWorkspaceRecovery: deps.recovery,
  transitionReachDeckImportGenerationIntents: deps.transition,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', () => ({
  loadReachDeckWorkspace: deps.workspace,
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', () => ({
  loadReachDeckMaterializedWorkspaceDocument: deps.materialized,
}));
vi.mock('../../lib/reach-deck/content-service-client.js', () => ({
  resolveReachDeckVoiceSelection: deps.voice,
}));
vi.mock('../../lib/reach-deck/workspace-batch-coordinator.js', () => ({
  registerReachDeckNarrationBatch: deps.register,
  resumeReachDeckNarrationBatch: deps.resume,
}));
vi.mock('../../lib/reach-deck/decksmith/page-routes.js', () => ({
  withReachDeckOrdinaryWriterLease: deps.lease,
}));
vi.mock('../../lib/reach-deck/workspace-route.js', () => ({
  ReachDeckWorkspaceRouteError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  conflict: (message: string) => Object.assign(new Error(message), { status: 409 }),
}));
import {
  prepareReachDeckImportGeneration,
  reconcileReachDeckImportGeneration,
  recoverReachDeckImportGeneration,
} from '../../lib/reach-deck/import-generation.js';

const applicationId = 'maic-import-' + 'a'.repeat(32);
const scoped = {
  ...TEST_REACH_DECK_SCOPE,
  workspaceContext: TEST_REACH_DECK_SCOPE,
  jobScope: TEST_REACH_DECK_SCOPE,
};
const session = { retainForAsyncRun: vi.fn() };
const document = {
  schemaVersion: 'reach-deck-document/v2',
  pages: [
    { pageId: 'existing', order: 1, revision: 9, sceneType: 'slide' },
    { pageId: 'saved', order: 2, revision: 1, sceneType: 'slide' },
    { pageId: 'missing', order: 3, revision: 1, sceneType: 'slide' },
    { pageId: 'quiz', order: 4, revision: 1, sceneType: 'quiz' },
    { pageId: 'interactive', order: 5, revision: 1, sceneType: 'interactive' },
  ],
  nativeSlides: [
    { pageId: 'existing', slide: {} },
    { pageId: 'saved', slide: { narration: { markdown: 'Retain this original script.' } } },
    { pageId: 'missing', slide: {} },
  ],
  importApplications: [
    {
      applicationId,
      requestFingerprint: 'sha256:' + 'b'.repeat(64),
      insertedPageIds: ['saved', 'missing', 'quiz', 'interactive'],
    },
  ],
} as unknown as ReachDeckDocumentV2;

describe('durable imported-page narration', () => {
  let intents: ReachDeckImportGenerationIntents;
  beforeEach(() => {
    vi.clearAllMocks();
    intents = {};
    deps.recovery.mockImplementation(async () => ({
      recovery: { importGenerationIntents: structuredClone(intents) },
    }));
    deps.transition.mockImplementation(async (context, transition) => {
      intents = parseReachDeckImportGenerationIntents(transition(structuredClone(intents)));
      return { recovery: { importGenerationIntents: intents } };
    });
    deps.workspace.mockResolvedValue({
      workspace: { runId: 'generated-workspace', records: { existing: {} } },
    });
    deps.materialized.mockResolvedValue({ materialized: true, document });
    deps.voice.mockResolvedValue(DEFAULT_REACH_DECK_VOICE_SELECTION);
    deps.resume.mockResolvedValue({ status: 'missing' });
    deps.register.mockImplementation(async ({ batch }) => batch);
    session.retainForAsyncRun.mockResolvedValue(undefined);
    deps.lease.mockImplementation(({ operation }) => operation(TEST_REACH_DECK_SCOPE, session));
  });

  it('freezes only inserted native pages, preserving scripts and explicitly skipping non-slide pages', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    const intent = intents[applicationId]!;
    expect(deps.register).not.toHaveBeenCalled();
    expect(intent.batch?.members).toMatchObject([
      { pageId: 'saved', narrationMode: 'saved-content', animationMode: 'regenerate' },
      { pageId: 'missing', narrationMode: 'regenerate-text', animationMode: 'regenerate' },
    ]);
    expect(intent.batch?.members[0]).not.toHaveProperty('contentDigest');
    expect(intent.batch?.members.some((item) => item.pageId === 'existing')).toBe(false);
    expect(intent.skipped).toMatchObject([
      { pageId: 'quiz', reason: 'quiz-not-supported' },
      { pageId: 'interactive', reason: 'interactive-not-supported' },
    ]);
    await reconcileReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      session as never,
      scoped,
      applicationId,
    );
    expect(deps.register).toHaveBeenCalledOnce();
    expect(intents[applicationId]!.registered).toBe(true);
    expect(session.retainForAsyncRun).toHaveBeenCalledWith('generated-workspace');
  });

  it('replays lost responses with the original voice and accepted batch identity', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    const frozen = structuredClone(intents[applicationId]!);
    await reconcileReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      session as never,
      scoped,
      applicationId,
    );
    deps.voice.mockRejectedValue(new Error('Current voice unavailable'));
    deps.resume.mockResolvedValue({ status: 'found', batch: frozen.batch });
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    const replay = await reconcileReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      session as never,
      scoped,
      applicationId,
    );
    expect(replay?.batchId).toBe(frozen.batch!.batchId);
    expect(deps.register).toHaveBeenCalledOnce();
    expect(deps.voice).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'only registers a missing batch if its import intent was not accepted (registered=%s)',
    async (registered) => {
      await prepareReachDeckImportGeneration(
        TEST_REACH_DECK_SCOPE,
        scoped,
        document,
        applicationId,
        'generate-narration',
      );
      intents[applicationId]!.registered = registered;
      const reconcile = reconcileReachDeckImportGeneration(
        TEST_REACH_DECK_SCOPE,
        session as never,
        scoped,
        applicationId,
      );
      if (registered) {
        await expect(reconcile).rejects.toMatchObject({
          status: 409,
          message: 'Import generation receipt is unavailable',
        });
        expect(deps.register).not.toHaveBeenCalled();
        expect(session.retainForAsyncRun).not.toHaveBeenCalled();
        expect(intents[applicationId]!.registered).toBe(true);
      } else {
        expect(await reconcile).toMatchObject({
          status: 'started',
          batchId: intents[applicationId]!.batch!.batchId,
        });
        expect(deps.register).toHaveBeenCalledOnce();
        expect(session.retainForAsyncRun).toHaveBeenCalledOnce();
      }
    },
  );

  it('recovers materialization-to-enqueue interruption from workspace reads', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    deps.register.mockRejectedValueOnce(new Error('Queue temporarily unavailable'));
    expect(
      (
        await reconcileReachDeckImportGeneration(
          TEST_REACH_DECK_SCOPE,
          session as never,
          scoped,
          applicationId,
        )
      )?.status,
    ).toBe('pending');
    expect(intents[applicationId]!.registered).toBe(false);
    await recoverReachDeckImportGeneration(scoped);
    expect(deps.register).toHaveBeenCalledTimes(2);
    expect(intents[applicationId]!.registered).toBe(true);
  });

  it('invalidates the request snapshot even when a recovery writer fails after partial progress', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    const snapshot = { resource: await deps.workspace(), recovery: await deps.recovery() };
    deps.workspace.mockClear();
    deps.recovery.mockClear();
    deps.lease.mockRejectedValueOnce(new Error('write response lost'));
    expect(await recoverReachDeckImportGeneration(scoped, snapshot)).toBe(true);
    expect(deps.workspace).not.toHaveBeenCalled();
    expect(deps.recovery).not.toHaveBeenCalled();
    expect(deps.lease).toHaveBeenCalledOnce();
  });

  it('does not schedule an unapplied intent or another actor intent', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    deps.materialized.mockResolvedValue({ materialized: false });
    await recoverReachDeckImportGeneration(scoped);
    expect(deps.register).not.toHaveBeenCalled();
    deps.materialized.mockResolvedValue({
      materialized: true,
      document: { ...document, importApplications: [] },
    });
    await recoverReachDeckImportGeneration(scoped);
    expect(deps.register).not.toHaveBeenCalled();
    deps.materialized.mockResolvedValue({ materialized: true, document });
    const other = {
      ...scoped,
      jobScope: { ...scoped.jobScope, actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    };
    await recoverReachDeckImportGeneration(other);
    expect(deps.lease).not.toHaveBeenCalled();
  });

  it('starts the registration grace at delayed recovery and persists the successful timestamp', async () => {
    const preparedAt = Date.now() - 180_000;
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValueOnce(new Date(preparedAt).toISOString());
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    const requestHash = intents[applicationId]!.batch!.requestHash;
    const batchId = intents[applicationId]!.batch!.batchId;
    const recoveredAt = Date.now();
    await recoverReachDeckImportGeneration(scoped);
    const registered = deps.register.mock.calls[0]![0].batch;
    expect(Date.parse(registered.createdAt)).toBeGreaterThanOrEqual(recoveredAt);
    expect(registered).toMatchObject({ requestHash, batchId });
    expect(intents[applicationId]!.batch!.createdAt).toBe(registered.createdAt);
    expect(intents[applicationId]!.registered).toBe(true);
    vi.restoreAllMocks();
  });

  it('settles expired accepted batches without retaining a writer lease or rescheduling', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    deps.resume.mockResolvedValue({ status: 'expired' });
    await recoverReachDeckImportGeneration(scoped);
    expect(intents[applicationId]!.registered).toBe(true);
    expect(deps.register).not.toHaveBeenCalled();
    expect(session.retainForAsyncRun).not.toHaveBeenCalled();
    await recoverReachDeckImportGeneration(scoped);
    expect(deps.lease).toHaveBeenCalledOnce();
  });

  it('bounds registered intent retention beyond 100 imports while preserving unresolved current-run identities', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    const unresolved = intents[applicationId]!;
    const many = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => {
        const id = 'maic-import-' + index.toString(16).padStart(32, '0');
        return [id, { ...structuredClone(unresolved), applicationId: id, registered: true }];
      }),
    );
    const oldId = 'pptx-import-' + 'c'.repeat(32);
    const parsed = parseReachDeckImportGenerationIntents({
      ...many,
      [applicationId]: unresolved,
      [oldId]: {
        ...structuredClone(unresolved),
        applicationId: oldId,
        runId: 'abandoned-run',
        batch: { ...unresolved.batch!, runId: 'abandoned-run' },
      },
    });
    const retained = retainReachDeckImportGenerationIntents(parsed, 'generated-workspace');
    expect(Object.keys(parsed)).toHaveLength(107);
    expect(Object.keys(retained)).toHaveLength(11);
    expect(retained[applicationId]).toEqual(unresolved);
    expect(retained[oldId]).toBeUndefined();
  });

  it('retains cross-institution import owners and rejects invalid or mismatched owner organizations', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    const intent = structuredClone(intents[applicationId]!);
    expect(intent.batch).toBeDefined();
    const legacyOwner = { ...intent.owner };
    delete legacyOwner.actorOrganizationId;
    const legacyIntent = {
      ...intent,
      owner: legacyOwner,
      batch: { ...intent.batch!, owner: legacyOwner },
    };
    expect(
      parseReachDeckImportGenerationIntents({ [applicationId]: legacyIntent })[applicationId]!.owner
        .actorOrganizationId,
    ).toBe(TEST_REACH_DECK_SCOPE.resourceScope.organizationId);

    const actorOrganizationId = '77777777-7777-4777-8777-777777777777';
    const externalOwner = { ...intent.owner, actorOrganizationId };
    const externalIntent = {
      ...intent,
      owner: externalOwner,
      batch: { ...intent.batch!, owner: externalOwner },
    };
    expect(
      parseReachDeckImportGenerationIntents({ [applicationId]: externalIntent })[applicationId]!
        .owner.actorOrganizationId,
    ).toBe(actorOrganizationId);
    expect(() =>
      parseReachDeckImportGenerationIntents({
        [applicationId]: {
          ...externalIntent,
          owner: { ...externalOwner, actorOrganizationId: 'bad' },
        },
      }),
    ).toThrow(/UUID/);
    expect(() =>
      parseReachDeckImportGenerationIntents({
        [applicationId]: {
          ...externalIntent,
          owner: { ...externalOwner, actorOrganizationId: null },
        },
      }),
    ).toThrow(/actor organization/);
    expect(() =>
      parseReachDeckImportGenerationIntents({
        [applicationId]: {
          ...externalIntent,
          owner: {
            ...externalOwner,
            actorOrganizationId: '88888888-8888-4888-8888-888888888888',
          },
        },
      }),
    ).toThrow(/batch ownership/);
  });

  it('rejects a missing generation receipt without claiming work started or reconstructing paid work', async () => {
    const fingerprint = document.importApplications![0]!.requestFingerprint;
    deps.voice.mockResolvedValue({ kind: 'default', voice: 'changed_teacher_voice' });
    await expect(
      reconcileReachDeckImportGeneration(
        TEST_REACH_DECK_SCOPE,
        session as never,
        scoped,
        applicationId,
        { completionAction: 'generate-narration', requestFingerprint: fingerprint },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('receipt is unavailable'),
    });
    expect(
      await reconcileReachDeckImportGeneration(
        TEST_REACH_DECK_SCOPE,
        session as never,
        scoped,
        applicationId,
      ),
    ).toBeUndefined();
    await expect(
      reconcileReachDeckImportGeneration(
        TEST_REACH_DECK_SCOPE,
        session as never,
        scoped,
        applicationId,
        { completionAction: 'generate-narration', requestFingerprint: 'sha256:' + 'd'.repeat(64) },
      ),
    ).rejects.toThrow(/application changed/);
    expect(deps.voice).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
    expect(session.retainForAsyncRun).not.toHaveBeenCalled();
    expect(deps.transition).not.toHaveBeenCalled();
    await recoverReachDeckImportGeneration(scoped);
    expect(deps.lease).not.toHaveBeenCalled();
  });

  it('safely reports only unsupported inserted pages as skipped when the intent is missing', async () => {
    deps.materialized.mockResolvedValue({
      materialized: true,
      document: {
        ...document,
        importApplications: [
          { ...document.importApplications![0], insertedPageIds: ['quiz', 'interactive'] },
        ],
      },
    });
    expect(
      await reconcileReachDeckImportGeneration(
        TEST_REACH_DECK_SCOPE,
        session as never,
        scoped,
        applicationId,
        {
          completionAction: 'generate-narration',
          requestFingerprint: document.importApplications![0]!.requestFingerprint,
        },
      ),
    ).toEqual({
      status: 'skipped',
      skipped: [
        { pageId: 'quiz', reason: 'quiz-not-supported' },
        { pageId: 'interactive', reason: 'interactive-not-supported' },
      ],
    });
    expect(deps.voice).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.transition).not.toHaveBeenCalled();
  });

  it('rejects an incompatible completion action and malformed private target coverage', async () => {
    await prepareReachDeckImportGeneration(
      TEST_REACH_DECK_SCOPE,
      scoped,
      document,
      applicationId,
      'generate-narration',
    );
    await expect(
      prepareReachDeckImportGeneration(TEST_REACH_DECK_SCOPE, scoped, document, applicationId),
    ).rejects.toThrow(/conflicts/);
    expect(() =>
      parseReachDeckImportGenerationIntents({
        [applicationId]: { ...intents[applicationId], pageIds: ['existing'] },
      }),
    ).toThrow(/coverage/);
  });
});
