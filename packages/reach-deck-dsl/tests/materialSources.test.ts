import { describe, it, expect } from 'vitest';
import {
  createGenerationWorkspace,
  parseGenerationWorkspace,
  rewindGenerationWorkspace,
  parseWorkspaceMaterialSources,
} from '../src/index.js';
const assetId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const references = [
  {
    id: `image:${assetId}`,
    kind: 'image' as const,
    sha256: 'a'.repeat(64),
    fileName: 'source.docx',
  },
];
const sources = {
  schemaVersion: 'reach-deck-material-sources/v1' as const,
  documents: [
    {
      fileName: 'source.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      blocks: [
        { type: 'text' as const, text: 'text' },
        { type: 'image' as const, assetId, mimeType: 'image/webp' as const },
      ],
      diagnostics: ['image_mime_corrected'],
    },
  ],
  webSearch: { query: 'query', answer: 'answer', sources: [], excludedSources: [] },
};
describe('private workspace material snapshot', () => {
  it('survives JSON reload and a source stage transition', () => {
    const workspace = createGenerationWorkspace({
      runId: 'run',
      documentId: 'document',
      source: 'source',
      createdAt: '2026-09-30T00:00:00Z',
      materialReferences: references,
      materialSources: sources,
    });
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace))).materialSources).toEqual(
      sources,
    );
    expect(
      rewindGenerationWorkspace(workspace, 'lesson-plan', '2026-09-30T00:01:00Z').materialSources,
    ).toEqual(sources);
  });
  it('rejects image blocks outside the current manifest, unsafe URLs, bytes and unknown fields', () => {
    expect(() => parseWorkspaceMaterialSources(sources, [])).toThrow('materialSources');
    expect(() =>
      parseWorkspaceMaterialSources(
        { ...sources, documents: [{ ...sources.documents[0], bytesBase64: 'secret' }] },
        references,
      ),
    ).toThrow();
    expect(() =>
      parseWorkspaceMaterialSources(
        {
          ...sources,
          webSearch: {
            ...sources.webSearch,
            sources: [{ title: 'unsafe', url: 'javascript:alert(1)', content: 'text' }],
          },
        },
        references,
      ),
    ).toThrow();
  });
  it('bounds documents, per-document text and block volume rather than silently truncating', () => {
    expect(() =>
      parseWorkspaceMaterialSources(
        { ...sources, documents: Array.from({ length: 65 }, () => sources.documents[0]) },
        references,
      ),
    ).toThrow();
    expect(() =>
      parseWorkspaceMaterialSources(
        {
          ...sources,
          documents: [
            { ...sources.documents[0], blocks: [{ type: 'text', text: 'x'.repeat(60001) }] },
          ],
        },
        references,
      ),
    ).toThrow();
    expect(() =>
      parseWorkspaceMaterialSources(
        {
          ...sources,
          documents: [
            {
              ...sources.documents[0],
              blocks: Array.from({ length: 2049 }, () => ({ type: 'text', text: '' })),
            },
          ],
        },
        references,
      ),
    ).toThrow();
  });
});
