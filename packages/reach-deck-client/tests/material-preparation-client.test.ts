import { describe, expect, it, vi } from 'vitest';
import { ReachDeckClient } from '../src/index.js';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
} as const;

describe('server material preparation', () => {
  it('reads current material image previews with scoped GET and rejects unsafe image URLs', async () => {
    const assetId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          assetId,
          contentType: 'image/webp',
          downloadUrl: 'https://signed.test/image.webp',
        }),
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock });
    expect(await client.previewMaterialAsset(context, assetId)).toEqual({
      assetId,
      contentType: 'image/webp',
      downloadUrl: 'https://signed.test/image.webp',
    });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain(`/tools/material-assets?assetId=${assetId}&`);
    expect(url).toContain(`moduleVersionId=${context.moduleVersionId}`);
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ assetId, contentType: 'image/webp', downloadUrl: 'javascript:alert(1)' }),
      ),
    );
    await expect(client.previewMaterialAsset(context, assetId)).rejects.toThrow(
      'material preview is invalid',
    );
  });
  it('uploads the complete batch and reads scoped preparation diagnostics from the stream', async () => {
    const result = {
      preparationId: 'prepared-1',
      expiresAt: 123456789,
      fileCount: 2,
      documentCount: 2,
      imageCount: 0,
      sourceCharacters: 100,
      referenceCount: 2,
      capacity: {
        estimatedInput: 1000,
        allowedInput: 5000,
        sourceCharacters: 100,
        referenceCount: 2,
      },
      warnings: [{ fileName: 'slides.pptx', code: 'pptx_text_only' }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          [
            JSON.stringify({ type: 'progress', stage: 'parsing' }),
            JSON.stringify({ type: 'result', status: 200, result }),
          ].join('\n'),
          { headers: { 'content-type': 'application/x-ndjson' } },
        ),
      );
    const client = new ReachDeckClient({ fetch: fetchMock });
    const files = [new File(['pdf'], 'lesson.pdf'), new File(['pptx'], 'slides.pptx')];
    const onProgress = vi.fn();
    expect(
      await client.prepareMaterials(context, {
        source: 'Brief',
        files,
        idempotencyKey: 'prepare-1',
        webSearch: true,
        generationLanguage: 'en-US',
        onProgress,
      }),
    ).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/tools/material-prepare?');
    const form = init.body as FormData;
    expect(form.getAll('files')).toEqual(files);
    expect(form.get('source')).toBe('Brief');
    expect(form.get('webSearch')).toBe('true');
    expect(form.get('generationLanguage')).toBe('en-US');
    expect(onProgress).toHaveBeenCalledWith('parsing');
  });

  it('retains a streamed capacity error code for localized guidance', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'error',
            status: 422,
            body: {
              error: 'Too much material',
              code: 'MATERIAL_CAPACITY_EXCEEDED',
              details: { estimatedInput: 2000, allowedInput: 1000 },
            },
          }),
          { headers: { 'content-type': 'application/x-ndjson' } },
        ),
      ),
    });
    await expect(
      client.prepareMaterials(context, { source: 'Brief', files: [], idempotencyKey: 'prepare-1' }),
    ).rejects.toMatchObject({
      code: 'MATERIAL_CAPACITY_EXCEEDED',
      status: 422,
      details: { estimatedInput: 2000, allowedInput: 1000 },
    });
  });
});
