import { beforeEach, describe, expect, it, vi } from 'vitest';
const office = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('@reachany/ai-runtime-common/office-ingestion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reachany/ai-runtime-common/office-ingestion')>()),
  prepareOfficeDocument: office.prepare,
}));
import { parseReachDeckMaterial } from '../../lib/reach-deck/material-parser.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
const context = {
  ...TEST_REACH_DECK_SCOPE,
  billingGroupId: null,
  runId: 'source-test',
  jobId: 'source-test',
};
const officeFile = (ext: string, type: string) =>
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], `source.${ext}`, { type });
describe('server material parser extraction warnings', () => {
  beforeEach(() => office.prepare.mockReset());
  it('propagates DOCX ingestion warnings with file provenance', async () => {
    office.prepare.mockResolvedValue({
      kind: 'docx',
      blocks: [{ type: 'text', text: 'full original evidence' }],
      warnings: ['unsupported_image_type:image/svg+xml'],
    });
    const parsed = await parseReachDeckMaterial(
      officeFile('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      context,
    );
    expect(parsed.markdown).toBe('full original evidence');
    expect(parsed.warnings).toEqual([
      { fileName: 'source.docx', code: 'unsupported_image_type:image/svg+xml' },
    ]);
  });
  it.each([
    [
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      { kind: 'xlsx', text: 'Visible cells' },
      'xlsx_text_only',
    ],
  ])('reports %s reference extraction as text-only', async (ext, type, prepared, code) => {
    office.prepare.mockResolvedValue(prepared);
    const parsed = await parseReachDeckMaterial(officeFile(ext as string, type as string), context);
    expect(parsed.warnings).toEqual([{ fileName: `source.${ext}`, code }]);
  });
  it('keeps visible PPTX text and original embedded images in order', async () => {
    office.prepare.mockResolvedValue({
      kind: 'pptx',
      bytes: new Uint8Array(),
      slides: [
        {
          slideNumber: 1,
          sourceSlideNumber: 2,
          text: 'Visible slide',
          blocks: [
            { type: 'text', text: 'Visible slide' },
            { type: 'image', image: { mimeType: 'image/png', data: 'AQID' } },
          ],
          warnings: ['pptx_vector_diagram_text_only'],
        },
      ],
    });
    const parsed = await parseReachDeckMaterial(
      officeFile(
        'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
      context,
    );
    expect(parsed.blocks).toEqual([
      { type: 'text', text: 'Visible slide', page: 1 },
      { type: 'image', imageIndex: 0, page: 1 },
    ]);
    expect(parsed.images).toEqual([
      expect.objectContaining({ mimeType: 'image/png', page: 1, dataBase64: 'AQID' }),
    ]);
    expect(parsed.warnings).toEqual([
      { fileName: 'source.pptx', code: 'pptx_vector_diagram_text_only' },
    ]);
  });
  it('allows text-only PPTX beyond 63 pages without requiring rendering', async () => {
    office.prepare.mockResolvedValue({
      kind: 'pptx',
      bytes: new Uint8Array(),
      slides: Array.from({ length: 64 }, (_, index) => ({
        slideNumber: index + 1,
        sourceSlideNumber: index + 1,
        text: 'text',
      })),
    });
    expect(
      (
        await parseReachDeckMaterial(
          officeFile(
            'pptx',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          ),
          context,
        )
      ).pageCount,
    ).toBe(64);
  });
  it('preserves the typed budget failure when parsed PPTX images exceed material limits', async () => {
    office.prepare.mockResolvedValue({
      kind: 'pptx',
      bytes: new Uint8Array(),
      slides: [
        {
          slideNumber: 1,
          sourceSlideNumber: 1,
          text: 'Large image',
          blocks: [
            {
              type: 'image',
              image: {
                mimeType: 'image/png',
                data: Buffer.alloc(15 * 1024 * 1024 + 1).toString('base64'),
              },
            },
          ],
        },
      ],
    });
    await expect(
      parseReachDeckMaterial(
        officeFile(
          'pptx',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ),
        context,
      ),
    ).rejects.toMatchObject({ code: 'processing_budget_exceeded' });
  });
  it('merges consecutive paragraph blocks per page so realistic long decks stay within metadata block limits', async () => {
    office.prepare.mockResolvedValue({
      kind: 'pptx',
      bytes: new Uint8Array(),
      slides: Array.from({ length: 100 }, (_, index) => ({
        slideNumber: index + 1,
        sourceSlideNumber: index + 1,
        text: 'Twenty paragraphs',
        blocks: Array.from({ length: 20 }, (_, paragraph) => ({
          type: 'text',
          text: `Paragraph ${paragraph + 1}`,
        })),
      })),
    });
    const result = await parseReachDeckMaterial(
      officeFile(
        'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
      context,
    );
    expect(result.blocks).toHaveLength(100);
    expect(result.blocks![0]).toMatchObject({
      text: expect.stringContaining('Paragraph 20'),
      page: 1,
    });
  });
});
