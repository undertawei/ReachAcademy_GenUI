import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ authorize: vi.fn(), prepare: vi.fn() }));
vi.mock('@/lib/reach-deck/tool-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/tool-route.js')>()),
  authorizeToolRoute: deps.authorize,
}));
vi.mock('@/lib/reach-deck/material-preparation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/material-preparation.js')>()),
  prepareReachDeckMaterials: deps.prepare,
}));
import { POST } from '../../app/api/reach-deck/tools/material-prepare/route.js';
import { MaterialPreparationError } from '../../lib/reach-deck/prepared-material-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
const file = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'figure.png', {
    type: 'image/png',
  });
function request(form: FormData) {
  return new Request('https://test.invalid/api/reach-deck/tools/material-prepare', {
    method: 'POST',
    body: form,
  });
}
function form() {
  const result = new FormData();
  result.append('files', file());
  result.set('source', 'Explain photosynthesis');
  return result;
}
describe('multipart material preparation boundary', () => {
  beforeEach(() => {
    deps.authorize.mockReset().mockResolvedValue({
      scoped: TEST_REACH_DECK_SCOPE,
      modelContext: { ...TEST_REACH_DECK_SCOPE, jobId: 'source-job', runId: 'source-run' },
      idempotencyKey: 'batch-1',
    });
    deps.prepare.mockReset();
  });
  it('passes all originals and options together and uses existing progress/result frames', async () => {
    const upload = form();
    upload.append('files', file());
    upload.set('webSearch', 'true');
    upload.set('generationLanguage', 'en-US');
    deps.prepare.mockImplementation(async (input) => {
      input.onProgress('parsing:1/2');
      return { preparationId: 'opaque', fileCount: 2, warnings: [] };
    });
    const response = await POST(request(upload));
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames).toContainEqual({ type: 'progress', stage: 'parsing:1/2' });
    expect(frames.at(-1)).toEqual({
      type: 'result',
      status: 200,
      result: { preparationId: 'opaque', fileCount: 2, warnings: [] },
    });
    expect(deps.prepare.mock.calls[0]![0]).toMatchObject({
      files: [expect.any(File), expect.any(File)],
      source: 'Explain photosynthesis',
      webSearch: true,
      generationLanguage: 'en-US',
    });
  });
  it('validates every signature before streaming or parsing starts', async () => {
    const upload = form();
    upload.append('files', new File(['wrong bytes'], 'bad.pdf', { type: 'application/pdf' }));
    const response = await POST(request(upload));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'material_file_invalid',
      details: { fileName: 'bad.pdf' },
    });
    expect(deps.prepare).not.toHaveBeenCalled();
  });
  it('rejects injected references and duplicated option fields', async () => {
    for (const mutate of [
      (upload: FormData) => upload.set('materialReferences', '[]'),
      (upload: FormData) => upload.append('source', 'other brief'),
    ]) {
      const upload = form();
      mutate(upload);
      expect((await POST(request(upload))).status).toBe(400);
    }
    expect(deps.prepare).not.toHaveBeenCalled();
  });
  it('streams the structured measured error when preparation rejects', async () => {
    deps.prepare.mockRejectedValue(
      new MaterialPreparationError(413, 'material_document_too_large', {
        fileName: 'long.pdf',
        documentCharacters: 60001,
        allowedCharacters: 60000,
      }),
    );
    const response = await POST(request(form()));
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.at(-1)).toMatchObject({
      type: 'error',
      status: 413,
      body: {
        code: 'material_document_too_large',
        details: { fileName: 'long.pdf', documentCharacters: 60001, allowedCharacters: 60000 },
      },
    });
  });
  it('preserves the processing-limit status and file provenance in the streamed error', async () => {
    deps.prepare.mockRejectedValue(
      new MaterialPreparationError(413, 'material_processing_budget_exceeded', {
        fileName: 'large-images.pptx',
      }),
    );
    const response = await POST(request(form()));
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.at(-1)).toMatchObject({
      type: 'error',
      status: 413,
      body: {
        code: 'material_processing_budget_exceeded',
        details: { fileName: 'large-images.pptx' },
      },
    });
  });
});
