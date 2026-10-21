import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({
  authorize: vi.fn(),
  create: vi.fn(),
  load: vi.fn(),
  current: vi.fn(),
  materialize: vi.fn(),
}));
vi.mock('@/lib/reach-deck/workspace-route', () => ({
  authorizeWorkspaceRoute: deps.authorize,
  conflict: (message: string) => Object.assign(new Error(message), { status: 409 }),
  workspaceRouteError: (error: { message: string; status?: number }) =>
    Response.json({ error: error.message }, { status: error.status ?? 500 }),
}));
vi.mock('@/lib/reach-deck/decksmith/page-routes', () => ({
  withReachDeckOrdinaryWriterLease: ({
    operation,
  }: {
    operation: (context: object) => Promise<Response>;
  }) => operation({}),
}));
vi.mock('@/lib/reach-deck/workspace-jobs', () => ({
  loadReachDeckMaterializedWorkspaceDocument: deps.current,
  materializeReachDeckImportedDocument: deps.materialize,
}));
vi.mock('@/lib/reach-deck/workspace-store', () => ({
  createReachDeckWorkspace: deps.create,
  loadReachDeckWorkspace: deps.load,
  ReachDeckWorkspaceRevisionConflictError: class extends Error {},
}));
import { POST } from '../../app/api/reach-deck/workspace/blank/route';
import { ReachDeckWorkspaceRevisionConflictError } from '../../lib/reach-deck/workspace-store';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client';
const version = '11111111-1111-4111-8111-111111111111';
const workspace = { runId: `blank-${version}`, source: 'manual-empty' };
const request = () =>
  new Request('http://localhost/api/reach-deck/workspace/blank', {
    method: 'POST',
    headers: { 'x-reachany-module-title': encodeURIComponent('空白讲义') },
  });
beforeEach(() => {
  vi.clearAllMocks();
  deps.authorize.mockResolvedValue({ resourceScope: { moduleVersionId: version } });
  deps.current.mockResolvedValue({ materialized: false });
  deps.create.mockResolvedValue({ workspace, draftRevision: 0 });
  deps.load.mockResolvedValue({ workspace, draftRevision: 0 });
  deps.materialize.mockResolvedValue({});
});
describe('blank workbench initialization', () => {
  it('persists a zero-page native draft through normal materialization without generation', async () => {
    expect((await POST(request())).status).toBe(201);
    expect(deps.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'manual-empty', documentId: version }),
    );
    expect(deps.materialize).toHaveBeenCalledWith(expect.anything(), {
      expectedWorkspaceDraftRevision: 0,
      document: expect.objectContaining({
        id: version,
        title: '空白讲义',
        pages: [],
        nativeSlides: [],
        resources: expect.objectContaining({ media: [] }),
      }),
    });
  });
  it('does not replace any existing document on retry', async () => {
    deps.current.mockResolvedValue({ materialized: true, document: { pages: ['authored'] } });
    expect((await POST(request())).status).toBe(200);
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.materialize).not.toHaveBeenCalled();
  });
  it('rejects existing nonblank-origin content', async () => {
    deps.current.mockResolvedValue({ materialized: true });
    deps.load.mockResolvedValue({ workspace: { source: 'maic-import', runId: 'import' } });
    expect((await POST(request())).status).toBe(409);
    expect(deps.materialize).not.toHaveBeenCalled();
  });
  it('resumes only its own partially created workspace after a failed materialization', async () => {
    deps.create.mockRejectedValue(new ContentServiceClientError('workspace exists', 409));
    expect((await POST(request())).status).toBe(201);
    expect(deps.materialize).toHaveBeenCalledOnce();
  });
  it('does not overwrite a competing workspace creation', async () => {
    deps.create.mockRejectedValue(new ReachDeckWorkspaceRevisionConflictError());
    deps.load.mockResolvedValue({ workspace: { source: 'teacher brief', runId: 'generation' } });
    expect((await POST(request())).status).toBe(409);
    expect(deps.materialize).not.toHaveBeenCalled();
  });
});
