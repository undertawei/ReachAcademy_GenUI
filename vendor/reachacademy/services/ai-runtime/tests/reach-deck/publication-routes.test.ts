import {
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  type GenerationWorkspace,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteReachDeckPage,
  duplicateReachDeckPage,
} from '../../../../packages/reach-deck-editor/src/operations.js';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  getMaterializedDocument: vi.fn(),
  loadWorkspace: vi.fn(),
  publishModule: vi.fn(),
  synchronize: vi.fn(),
  writerLease: vi.fn(),
}));

vi.mock('@/lib/reach-deck/decksmith/document-writer', () => ({
  withReachDeckOrdinaryDocumentWriterLease: dependencies.writerLease,
}));
vi.mock('@/lib/reach-deck/workspace-document-structure', () => ({
  synchronizeReachDeckWorkspaceDocumentStructure: dependencies.synchronize,
}));

vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
  publishReachDeckModule: dependencies.publishModule,
}));
vi.mock('@/lib/reach-deck/workspace-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-route.js')>()),
  authorizeWorkspaceRoute: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
}));

import { POST as publishModule } from '../../app/api/reach-deck/publication/module/route.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const NOW = '2026-07-18T08:00:00.000Z';
const scoped = {
  ...TEST_REACH_DECK_SCOPE,
  claims: {
    actorId: TEST_REACH_DECK_SCOPE.actorId,
    orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
    subject: TEST_REACH_DECK_SCOPE.actorId,
  },
};
const lessonPlan = {
  id: 'plan-1',
  title: 'Systems lesson',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain a system'],
  teachingStrategy: 'Model and practice',
  keyTerms: ['system'],
  narrative: 'Move from explanation to application.',
};
const outline = {
  id: 'outline-1',
  title: 'Systems',
  pages: [
    {
      id: 'page-1',
      order: 1,
      sceneType: 'slide' as const,
      title: 'System parts',
    },
  ],
};

describe('Reach Deck publication routes', () => {
  beforeEach(() => {
    dependencies.authorize.mockReset().mockResolvedValue({
      ...scoped,
      workspaceContext: scoped,
      jobScope: scoped,
    });
    dependencies.writerLease
      .mockReset()
      .mockImplementation(
        async (input: { context: unknown; operation: (value: { context: unknown }) => unknown }) =>
          input.operation({ context: input.context }),
      );
    dependencies.synchronize.mockReset().mockImplementation(async (_context, resource) => resource);
    dependencies.loadWorkspace.mockReset().mockResolvedValue(resource(planningWorkspace(), 7));
    dependencies.getMaterializedDocument
      .mockReset()
      .mockResolvedValue({ ...scoped.resourceScope, materialized: false });
    dependencies.publishModule.mockReset().mockResolvedValue({
      ...scoped.resourceScope,
      status: 'published',
      versionNo: 1,
    });
  });

  it('publishes the module at the browser supplied workspace revision', async () => {
    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 7,
        expectedContentDigest: 'saved-digest',
      }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.publishModule).toHaveBeenCalledWith(
      7,
      'saved-digest',
      expect.objectContaining({
        actorId: scoped.actorId,
        resourceScope: scoped.resourceScope,
      }),
    );
  });

  it('refuses to publish while the workspace is mid page generation', async () => {
    // 分页生成进行中,物化文档含占位页/回填未收敛 —— 发布会把占位页发给学习者(裁决 7)。
    dependencies.loadWorkspace.mockResolvedValue(resource(generatingWorkspace(), 4));

    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );

    expect(response.status).toBe(409);
    expect(dependencies.publishModule).not.toHaveBeenCalled();
  });

  it('refuses to publish while the materialized document still contains placeholder pages', async () => {
    // 回填失败可让工作区停在 complete 而物化文档仍残留占位页——不得发给学习者(终审 #2)。
    dependencies.loadWorkspace.mockResolvedValue(resource(completeWorkspace(), 4));
    // native-only v2 无法解析缺少 binding 的占位 slide；content-service 以冲突拒绝发布。
    dependencies.getMaterializedDocument.mockRejectedValue(
      new ContentServiceClientError(
        'Reach Deck draft still contains generating placeholder pages',
        409,
      ),
    );

    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );

    expect(response.status).toBe(409);
    expect(dependencies.publishModule).not.toHaveBeenCalled();
  });

  it('publishes a complete workspace whose materialized document has no placeholder pages', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(completeWorkspace(), 4));
    dependencies.getMaterializedDocument.mockResolvedValue(
      materializedResource(backfilledDocument()),
    );

    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.publishModule).toHaveBeenCalledWith(4, 'saved-digest', expect.anything());
  });

  it.each(['image', 'shape-fill'] as const)(
    'blocks surviving %s placeholders with actionable details',
    async (binding) => {
      const { document, workspace, pageId } = placeholderFixture(binding);
      dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 4));
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
      const response = await publishModule(
        request('/api/publication/module', {
          expectedDraftRevision: 4,
          expectedContentDigest: 'saved-digest',
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'media_placeholders_remaining',
        details: { pages: [{ pageId, assetIds: ['planned-image'] }] },
      });
      expect(dependencies.publishModule).not.toHaveBeenCalled();
    },
  );

  it('publishes legacy slide artifacts that have no mediaSlots metadata', async () => {
    const { document, workspace, pageId } = placeholderFixture('image');
    const artifact = workspace.sceneArtifacts[pageId];
    if (artifact?.sceneType !== 'slide') throw new Error('Expected a slide artifact');
    delete artifact.generationMetadata.mediaSlots;
    delete document.resources.media.find((resource) => resource.id === 'placeholder')!.origin;
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 4));
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));

    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.publishModule).toHaveBeenCalledWith(4, 'saved-digest', expect.anything());
  });

  it.each(['present', 'retired', 'missing-workspace'] as const)(
    'blocks a copied placeholder after original page deletion when source metadata is %s',
    async (metadata) => {
      const { document, workspace, pageId } = placeholderFixture('image');
      let sequence = 0;
      const copied = deleteReachDeckPage(
        duplicateReachDeckPage(document, pageId, (prefix) => `${prefix}-copy-${sequence++}`),
        pageId,
      );
      if (metadata === 'retired') workspace.sceneArtifacts = {};
      if (metadata === 'missing-workspace')
        dependencies.loadWorkspace.mockRejectedValue(
          new ContentServiceClientError('Reach Deck workspace not found', 404),
        );
      else dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 4));
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(copied));

      const response = await publishModule(
        request('/api/publication/module', {
          expectedDraftRevision: 4,
          expectedContentDigest: 'saved-digest',
        }),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'media_placeholders_remaining' });
      expect(dependencies.publishModule).not.toHaveBeenCalled();
    },
  );

  it.each(['deleted', 'replaced'] as const)(
    'allows publication after a placeholder was %s by the teacher',
    async (change) => {
      const { document, workspace } = placeholderFixture('image');
      const slide = document.nativeSlides[0]!.slide;
      if (change === 'deleted') slide.elements = [];
      else {
        const image = slide.elements[0]!;
        if (image.type === 'image') image.resourceId = 'replacement';
        document.resources.media.push({
          id: 'replacement',
          objectKey: 'teacher/replacement.png',
          contentType: 'image/png',
          digest: 'b'.repeat(64),
        });
      }
      dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 4));
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
      const response = await publishModule(
        request('/api/publication/module', {
          expectedDraftRevision: 4,
          expectedContentDigest: 'saved-digest',
        }),
      );
      expect(response.status).toBe(200);
    },
  );

  it('publishes modules without a workspace', async () => {
    // 从未走过生成流程的旧模块(手工创建的文档)没有工作区,照常发布。
    dependencies.loadWorkspace.mockRejectedValue(
      new ContentServiceClientError('Reach Deck workspace not found', 404),
    );

    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 2,
        expectedContentDigest: 'saved-digest',
      }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.publishModule).toHaveBeenCalledWith(2, 'saved-digest', expect.anything());
  });

  it('repairs obsolete generation state under the writer and publishes its new CAS revision', async () => {
    dependencies.loadWorkspace.mockResolvedValue(
      resource({ ...completeWorkspace(), stage: 'page-generation' }, 4),
    );
    dependencies.getMaterializedDocument.mockResolvedValue(
      materializedResource(backfilledDocument()),
    );
    dependencies.synchronize.mockImplementation(async (_context, current) => ({
      ...current,
      draftRevision: 5,
      workspace: completeWorkspace(),
    }));
    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );
    expect(response.status).toBe(200);
    expect(dependencies.publishModule).toHaveBeenCalledWith(5, 'saved-digest', expect.anything());
  });

  it('does not repair or publish stale client revisions', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(generatingWorkspace(), 5));
    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );
    expect(response.status).toBe(409);
    expect(dependencies.synchronize).not.toHaveBeenCalled();
    expect(dependencies.publishModule).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'running jobs', jobs: [{ status: 'running' }], batches: [] },
    { label: 'unapplied results', jobs: [{ status: 'completed', done: false }], batches: [] },
    { label: 'active batches', jobs: [], batches: [{ status: 'active' }] },
    {
      label: 'pending Decksmith proposals',
      jobs: [{ kind: 'decksmith', status: 'awaiting-approval' }],
      batches: [],
    },
  ])('publishes stable content while generation work is still in flight: $label', async () => {
    // 2026-10-17：在途任务没有写入文档，内容暂时稳定，不再因为任务状态挡住发布。
    dependencies.loadWorkspace.mockResolvedValue(resource(completeWorkspace(), 4));
    dependencies.getMaterializedDocument.mockResolvedValue(
      materializedResource(backfilledDocument()),
    );
    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );
    expect(response.status).toBe(200);
    expect(dependencies.publishModule).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'generating', 'narrating'] as const)(
    'publishes the current content of a materialized deck whose page is %s',
    async (state) => {
      const workspace = completeWorkspace();
      workspace.statuses['page-1'] = {
        ...workspace.statuses['page-1']!,
        state,
      } as GenerationWorkspace['statuses'][string];
      dependencies.loadWorkspace.mockResolvedValue(
        resource({ ...workspace, stage: 'page-generation' }, 4),
      );
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedResource(backfilledDocument()),
      );
      const response = await publishModule(
        request('/api/publication/module', {
          expectedDraftRevision: 4,
          expectedContentDigest: 'saved-digest',
        }),
      );
      expect(response.status).toBe(200);
      expect(dependencies.publishModule).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'DecksmithDeckLeaseConflictError',
    'DecksmithDeckWriterConflictError',
    'DecksmithDeckLockTimeoutError',
  ])('tells the teacher to wait while content is landing: %s', async (name) => {
    dependencies.writerLease.mockRejectedValueOnce(Object.assign(new Error('busy'), { name }));
    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'PUBLICATION_LANDING_IN_PROGRESS',
      retryable: true,
    });
    expect(dependencies.publishModule).not.toHaveBeenCalled();
  });

  it('publishes beside a Decksmith turn without repairing workspace structure', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(completeWorkspace(), 4));
    dependencies.getMaterializedDocument.mockResolvedValue(
      materializedResource(backfilledDocument()),
    );
    dependencies.writerLease.mockImplementationOnce(
      async (input: { context: unknown; operation: (value: unknown) => unknown }) =>
        input.operation({ context: input.context, session: { guest: true } }),
    );
    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );
    expect(response.status).toBe(200);
    expect(dependencies.writerLease).toHaveBeenCalledWith(
      expect.objectContaining({ coexistWithDecksmithTurn: true }),
    );
    expect(dependencies.synchronize).not.toHaveBeenCalled();
    expect(dependencies.publishModule).toHaveBeenCalledWith(4, 'saved-digest', expect.anything());
  });

  it('does not reconcile a concurrently changed materialized document', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(generatingWorkspace(), 4));
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...materializedResource(backfilledDocument()),
      contentDigest: 'new-digest',
    });
    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 4,
        expectedContentDigest: 'saved-digest',
      }),
    );
    expect(response.status).toBe(409);
    expect(dependencies.synchronize).not.toHaveBeenCalled();
  });

  it('does not treat a missing document or later reconciliation resource as a legacy workspace', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(completeWorkspace(), 2));
    dependencies.getMaterializedDocument.mockRejectedValue(
      new ContentServiceClientError('materialized document not found', 404),
    );
    const response = await publishModule(
      request('/api/publication/module', {
        expectedDraftRevision: 2,
        expectedContentDigest: 'saved-digest',
      }),
    );
    expect(response.status).toBe(404);
    expect(dependencies.publishModule).not.toHaveBeenCalled();
  });

  it('propagates non-missing workspace load failures instead of publishing blind', async () => {
    dependencies.loadWorkspace.mockRejectedValue(
      new ContentServiceClientError('content-service is unavailable', 502),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await publishModule(
        request('/api/publication/module', {
          expectedDraftRevision: 2,
          expectedContentDigest: 'saved-digest',
        }),
      );

      expect(response.status).toBe(500);
      expect(dependencies.publishModule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

function planningWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scoped.resourceScope.moduleVersionId,
    source: 'Teacher source',
    createdAt: NOW,
  });
}

function generatingWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scoped.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    pagedOutline: outline,
    createdAt: NOW,
  });
}

function completeWorkspace(): GenerationWorkspace {
  // 回填失败场景:阶段推进到 complete,但物化文档尚未收敛(占位页残留)。
  const workspace = generatingWorkspace();
  return {
    ...workspace,
    stage: 'complete',
    statuses: Object.fromEntries(
      Object.entries(workspace.statuses).map(([pageId, status]) => [
        pageId,
        { ...status, state: 'ready', sceneId: pageId, completedAt: NOW },
      ]),
    ) as GenerationWorkspace['statuses'],
  };
}

/** 回填收敛后的形态:占位 native slide 已绑定真实内容。 */
function backfilledDocument(): ReachDeckDocumentV2 {
  const document = createBlankReachDeckDocument({
    id: scoped.resourceScope.moduleVersionId,
    title: outline.title,
  });
  return {
    ...document,
    pages: document.pages,
    nativeSlides: [
      {
        pageId: document.pages[0]!.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2' as const,
          id: `${document.pages[0]!.pageId}:native`,
          title: document.pages[0]!.title,
          background: { kind: 'none' as const },
          elements: [],
          animations: [],
        },
      },
    ],
  };
}

function materializedResource(learnerDocument: unknown) {
  return {
    ...scoped.resourceScope,
    materialized: true,
    draftRevision: 4,
    mongodbDocumentId: 'mongo-1',
    contentDigest: 'saved-digest',
    materializedAt: NOW,
    learnerDocument: learnerDocument as Record<string, unknown>,
  };
}

function resource(workspace: GenerationWorkspace, draftRevision: number) {
  return {
    ...scoped.resourceScope,
    draftRevision,
    workspace,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function request(path: string, body: Record<string, unknown>): Request {
  return new Request('http://reach-deck.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function placeholderFixture(binding: 'image' | 'shape-fill') {
  const document = backfilledDocument();
  const pageId = document.pages[0]!.pageId;
  document.resources.media.push({
    id: 'placeholder',
    objectKey: 'generated/placeholder.png',
    contentType: 'image/png',
    digest: 'a'.repeat(64),
    origin: {
      schemaVersion: 'reach-deck-media-origin/v1',
      route: 'image',
      provider: 'reach-deck-placeholder/v1',
    },
  });
  const base = {
    id: 'image-element',
    zIndex: 1,
    transform: { x: 0, y: 0, width: 400, height: 300, rotation: 0 },
  };
  const element =
    binding === 'image'
      ? {
          ...base,
          type: 'image' as const,
          resourceId: 'placeholder',
          fit: 'contain' as const,
          alt: 'Planned image',
        }
      : {
          ...base,
          type: 'shape' as const,
          geometry: { kind: 'preset' as const, preset: 'rect' },
          style: {
            fill: { kind: 'image' as const, resourceId: 'placeholder', mode: 'cover' as const },
          },
        };
  document.nativeSlides[0]!.slide.elements = [
    element,
  ] as (typeof document.nativeSlides)[number]['slide']['elements'];
  const workspace = completeWorkspace();
  workspace.sceneArtifacts[pageId] = {
    sceneType: 'slide',
    generationMetadata: {
      mediaSlots: [
        {
          assetId: 'planned-image',
          elementId: base.id,
          resourceId: 'placeholder',
          status: 'failed',
        },
      ],
    },
  } as unknown as GenerationWorkspace['sceneArtifacts'][string];
  return { document, workspace, pageId };
}
