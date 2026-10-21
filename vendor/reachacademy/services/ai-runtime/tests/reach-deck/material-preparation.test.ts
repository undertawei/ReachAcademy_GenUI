import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { OfficeIngestionError } from '@reachany/ai-runtime-common/office-ingestion';
import { buildPptxFixture } from '../../../../packages/ai-runtime-feedforward/tests/office-fixtures.js';
import {
  prepareReachDeckMaterials,
  validateReachDeckMaterialBatch,
} from '../../lib/reach-deck/material-preparation.js';
import {
  loadPreparedReachDeckMaterials,
  type PreparedMaterialStore,
} from '../../lib/reach-deck/prepared-material-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import {
  parseReachDeckMaterial,
  type persistReachDeckMaterialImages,
} from '../../lib/reach-deck/material-parser.js';

const scoped = {
  ...TEST_REACH_DECK_SCOPE,
  billingGroupId: null,
  roleGrantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const context = { ...scoped, jobId: 'material-test', runId: 'material-test' };
const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'diagram.png', {
    type: 'image/png',
  });
function dependencies() {
  const records = new Map<string, string>();
  const store: PreparedMaterialStore = {
    get: async (key) => records.get(key) ?? null,
    set: async (key, value) => {
      if (records.has(key)) return null;
      records.set(key, value);
      return 'OK';
    },
  };
  const parse = vi.fn().mockResolvedValue({
    fileName: 'diagram.png',
    contentType: 'image/png',
    sizeBytes: 8,
    markdown: 'Complete evidence near the end.',
    provider: 'test',
    warnings: [],
  });
  const persist = vi.fn<typeof persistReachDeckMaterialImages>(async (document) => document);
  const admit = vi.fn().mockImplementation(async (input) => ({
    estimatedInput: 123,
    allowedInput: 5000,
    sourceCharacters: input.source.length,
    referenceCount: input.materialReferences.length,
  }));
  return {
    store,
    records,
    parse,
    persist,
    admit,
    deleteAsset: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
  };
}
const input = () => ({
  files: [png()],
  source: 'Explain energy',
  scoped,
  context,
  idempotencyKey: 'batch-1',
  generationLanguage: 'en-US',
  systemLanguage: 'en-US',
});

describe('server-owned material preparation', () => {
  it('reports a real oversized embedded PPTX image as a processing limit before creating assets', async () => {
    const zip = await JSZip.loadAsync(await buildPptxFixture());
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string');
    zip.file(
      'ppt/slides/slide1.xml',
      slide.replace(
        '</p:spTree>',
        '<p:pic><p:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rImage"/></p:blipFill></p:pic></p:spTree>',
      ),
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/large.png"/></Relationships>',
    );
    const image = Buffer.alloc(15 * 1024 * 1024 + 1);
    image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    zip.file('ppt/media/large.png', image);
    const file = new File(
      [new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }))],
      'large-images.pptx',
      {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    );
    const deps = dependencies();
    await expect(
      prepareReachDeckMaterials(
        { ...input(), files: [file] },
        { ...deps, parse: parseReachDeckMaterial },
      ),
    ).rejects.toMatchObject({
      status: 413,
      code: 'material_processing_budget_exceeded',
      details: { fileName: file.name },
    });
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.records.size).toBe(0);
  });
  it.each([
    [
      new OfficeIngestionError('processing_budget_exceeded', 'ZIP budget exceeded'),
      413,
      'material_processing_budget_exceeded',
    ],
    [new OfficeIngestionError('corrupt_or_binary', 'Corrupt ZIP'), 422, 'material_parse_failed'],
    [new Error('Parser failed'), 422, 'material_parse_failed'],
  ])(
    'distinguishes processing budgets from corrupt or failed parsing (%s)',
    async (error, status, code) => {
      const deps = dependencies();
      deps.parse.mockRejectedValue(error);
      await expect(prepareReachDeckMaterials(input(), deps)).rejects.toMatchObject({
        status,
        code,
        details: { fileName: 'diagram.png' },
      });
      expect(deps.persist).not.toHaveBeenCalled();
    },
  );
  it('normalizes parameterized MIME and stores cleaned web evidence with excluded-source diagnostics', async () => {
    const deps = dependencies();
    deps.search.mockResolvedValue({
      query: 'research',
      answer: 'summary\u007f',
      provider: 'test',
      responseTime: 1,
      sources: [
        {
          title: 'paper',
          url: 'https://example.test/paper.pdf',
          content: 'readable academic text\u007f',
          score: 1,
        },
        {
          title: 'bad',
          url: 'https://example.test/bad.pdf',
          content: '%PDF-1.7\n1 0 obj /Type /Catalog endobj xref trailer << /Root 1 0 R >>',
          score: 1,
        },
      ],
    });
    const args = {
      ...input(),
      files: [
        new File([await png().arrayBuffer()], 'diagram.png', { type: 'image/png; charset=binary' }),
      ],
      webSearch: true,
    };
    const summary = await prepareReachDeckMaterials(args, deps);
    const record = await loadPreparedReachDeckMaterials(
      { ...args, preparationId: summary.preparationId },
      deps.store,
    );
    expect(record.materialSources?.documents[0]?.contentType).toBe('image/png');
    expect(record.source).not.toContain('\u007f');
    expect(record.source).not.toContain('%PDF');
    expect(record.materialSources?.webSearch?.sources).toEqual([
      { title: 'paper', url: 'https://example.test/paper.pdf', content: 'readable academic text' },
    ]);
    expect(record.materialSources?.webSearch?.excludedSources).toEqual([
      { title: 'bad', url: 'https://example.test/bad.pdf', reason: 'pdf_binary_content' },
    ]);
  });
  it('deduplicates original bytes, keeps authoritative source private and binds the stored scope and options', async () => {
    const deps = dependencies();
    const args = input();
    const summary = await prepareReachDeckMaterials({ ...args, files: [png(), png()] }, deps);
    expect(deps.parse).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ fileCount: 2, documentCount: 1, referenceCount: 1 });
    expect(summary).not.toHaveProperty('source');
    const loaded = await loadPreparedReachDeckMaterials(
      { ...args, preparationId: summary.preparationId },
      deps.store,
    );
    expect(loaded.source).toContain('Complete evidence near the end.');
    expect(loaded.source).toContain('--- END REACH DECK MANAGED SOURCE CONTEXT ---');
    expect(loaded.materialReferences[0]).toMatchObject({ kind: 'text', fileName: 'diagram.png' });
    for (const changes of [
      { source: 'Different brief' },
      { roleGrantId: 'other' },
      { generationLanguage: 'zh-CN' },
      {
        resourceScope: {
          ...scoped.resourceScope,
          courseId: '66666666-6666-4666-8666-666666666666',
        },
      },
    ]) {
      await expect(
        loadPreparedReachDeckMaterials(
          {
            ...args,
            preparationId: summary.preparationId,
            ...changes,
            scoped: {
              ...scoped,
              ...('roleGrantId' in changes ? { roleGrantId: changes.roleGrantId } : {}),
              ...('resourceScope' in changes ? { resourceScope: changes.resourceScope } : {}),
            },
          },
          deps.store,
        ),
      ).rejects.toMatchObject({ code: 'material_preparation_scope_mismatch' });
    }
    await prepareReachDeckMaterials({ ...args, files: [png(), png()] }, deps);
    expect(deps.parse).toHaveBeenCalledTimes(1);
  });
  it('rejects excessive document length without truncating or persisting images', async () => {
    const deps = dependencies();
    deps.parse.mockResolvedValue({
      fileName: 'long.pdf',
      contentType: 'application/pdf',
      markdown: 'a'.repeat(60001),
      warnings: [],
    });
    await expect(prepareReachDeckMaterials(input(), deps)).rejects.toMatchObject({
      code: 'material_document_too_large',
      details: { documentCharacters: 60001, allowedCharacters: 60000 },
    });
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.records.size).toBe(0);
  });
  it('rejects combined material volume even when every document is individually allowed', async () => {
    const deps = dependencies();
    deps.parse.mockResolvedValue({
      fileName: 'long.pdf',
      contentType: 'application/pdf',
      markdown: 'a'.repeat(48000),
      warnings: [],
    });
    const other = new File([await png().arrayBuffer(), new Uint8Array([1])], 'other.png', {
      type: 'image/png',
    });
    await expect(
      prepareReachDeckMaterials({ ...input(), files: [png(), other] }, deps),
    ).rejects.toMatchObject({ code: 'material_source_too_large' });
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it('rejects excessive distinct references rather than dropping later evidence', async () => {
    const deps = dependencies();
    deps.parse.mockResolvedValue({
      fileName: 'rich.pdf',
      markdown: 'evidence',
      warnings: [],
      images: Array.from({ length: 64 }, (_, index) => ({
        sha256: index.toString(16).padStart(64, '0'),
        source: 'embedded',
        mimeType: 'image/png',
      })),
    });
    await expect(prepareReachDeckMaterials(input(), deps)).rejects.toMatchObject({
      code: 'material_reference_count_exceeded',
      details: { referenceCount: 65 },
    });
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it('retains diagnostics without an extraction acceptance gate, and reports expiry', async () => {
    const deps = dependencies();
    deps.parse.mockResolvedValue({
      fileName: 'slides.pptx',
      markdown: 'extracted slides',
      warnings: [{ fileName: 'slides.pptx', code: 'pptx_text_only' }],
    });
    const args = input();
    const summary = await prepareReachDeckMaterials(args, deps);
    await expect(
      loadPreparedReachDeckMaterials({ ...args, preparationId: summary.preparationId }, deps.store),
    ).resolves.toHaveProperty('materialSources.documents.0.diagnostics', ['pptx_text_only']);
    await expect(
      loadPreparedReachDeckMaterials(
        { ...args, preparationId: summary.preparationId, acceptWarnings: true },
        deps.store,
      ),
    ).resolves.toHaveProperty('source');
    deps.records.clear();
    await expect(
      loadPreparedReachDeckMaterials(
        { ...args, preparationId: summary.preparationId, acceptWarnings: true },
        deps.store,
      ),
    ).rejects.toMatchObject({ status: 410, code: 'material_preparation_expired' });
  });
  it('does not persist assets when capacity admission fails', async () => {
    const deps = dependencies();
    deps.admit.mockRejectedValue(new Error('capacity exceeded'));
    await expect(prepareReachDeckMaterials(input(), deps)).rejects.toThrow('capacity exceeded');
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it('cleans candidate assets if a later write fails', async () => {
    const deps = dependencies();
    deps.persist.mockImplementationOnce(async (_document, options) => {
      options.onAsset?.('created-1');
      throw new Error('asset write failed');
    });
    await expect(prepareReachDeckMaterials(input(), deps)).rejects.toThrow('asset write failed');
    expect(deps.deleteAsset).toHaveBeenCalledWith('created-1', scoped);
  });
  it('keeps one immutable concurrent preparation and cleans only the losing candidate assets', async () => {
    const deps = dependencies();
    deps.persist.mockImplementation(async (document, options) => {
      // Match content-service's actual runId + checksum asset identity.
      const assetId = crypto.randomUUID();
      options.onAsset?.(assetId);
      return {
        ...document,
        images: [{ sha256: 'a'.repeat(64), mimeType: 'image/png', source: 'direct', assetId }],
      };
    });
    const [first, second] = await Promise.all([
      prepareReachDeckMaterials(input(), deps),
      prepareReachDeckMaterials(input(), deps),
    ]);
    expect(first.preparationId).toBe(second.preparationId);
    expect(deps.records.size).toBe(1);
    expect(new Set(deps.persist.mock.calls.map(([, options]) => options.runId)).size).toBe(2);
    expect(deps.deleteAsset).toHaveBeenCalledTimes(1);
    const stored = await loadPreparedReachDeckMaterials(
      { ...input(), preparationId: first.preparationId },
      deps.store,
    );
    const image = stored.materialReferences.find((reference) => reference.kind === 'image');
    expect(deps.deleteAsset.mock.calls[0]![0]).not.toBe(image?.id.replace('image:', ''));
  });
  it('checks actual file count and aggregate bytes without trusting request headers', async () => {
    await expect(
      validateReachDeckMaterialBatch(Array.from({ length: 65 }, png), 'brief'),
    ).rejects.toMatchObject({ code: 'material_file_count_exceeded' });
    const file = png();
    Object.defineProperty(file, 'size', { value: 201 * 1024 * 1024 });
    await expect(validateReachDeckMaterialBatch([file], 'brief')).rejects.toMatchObject({
      code: 'material_aggregate_too_large',
    });
  });
  it('reports the oversized file and per-format byte allowance before parsing', async () => {
    const file = png();
    Object.defineProperty(file, 'size', { value: 16 * 1024 * 1024 });
    await expect(validateReachDeckMaterialBatch([file], 'brief')).rejects.toMatchObject({
      code: 'material_file_too_large',
      details: {
        fileName: 'diagram.png',
        sizeBytes: 16 * 1024 * 1024,
        allowedBytes: 15 * 1024 * 1024,
      },
    });
  });
});
