import { describe, expect, it } from 'vitest';

import { parsePptxRelationships } from '../src/pptx/index.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const relationshipXml = (children: string): Uint8Array =>
  bytes(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${children}</Relationships>`,
  );

describe('PPTX relationships', () => {
  it('resolves internal targets against the source part and preserves external targets', () => {
    const result = parsePptxRelationships(
      '/ppt/presentation.xml',
      relationshipXml(
        '<Relationship Id="rId1" Type="urn:slide" Target="slides/slide1.xml"/>' +
          '<Relationship Id="rId2" Type="urn:web" Target="https://example.test" TargetMode="External"/>',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relationships).toEqual([
      expect.objectContaining({
        id: 'rId1',
        target: '/ppt/slides/slide1.xml',
        targetMode: 'internal',
      }),
      expect.objectContaining({
        id: 'rId2',
        target: 'https://example.test',
        targetMode: 'external',
      }),
    ]);
  });

  it('rejects duplicate relationship IDs and internal targets escaping the package', () => {
    const duplicate = parsePptxRelationships(
      '/ppt/presentation.xml',
      relationshipXml(
        '<Relationship Id="rId1" Type="urn:slide" Target="slides/slide1.xml"/>' +
          '<Relationship Id="rId1" Type="urn:slide" Target="slides/slide2.xml"/>',
      ),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics[0]?.code).toBe('pptx.relationship.duplicate_id');
    }

    const escaping = parsePptxRelationships(
      '/ppt/presentation.xml',
      relationshipXml('<Relationship Id="rId1" Type="urn:slide" Target="../../outside.xml"/>'),
    );
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) {
      expect(escaping.diagnostics[0]?.code).toBe('pptx.relationship.unsafe_target');
    }
  });
});
