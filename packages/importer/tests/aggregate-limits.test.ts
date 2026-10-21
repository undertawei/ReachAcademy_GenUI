import { describe, expect, it } from 'vitest';

import {
  parsePptxRelationships,
  parsePptxXml,
  type PptxRelationshipParseBudget,
  type PptxXmlParseBudget,
} from '../src/pptx/index.js';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('PPTX aggregate parser limits', () => {
  it('shares an XML-node budget across package parts', () => {
    const budget: PptxXmlParseBudget = { remainingNodes: 3 };
    expect(parsePptxXml('/ppt/a.xml', bytes('<a><b/></a>'), {}, budget).ok).toBe(true);
    const result = parsePptxXml('/ppt/b.xml', bytes('<a><b/></a>'), {}, budget);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.xml.total_node_limit_exceeded' }],
    });
  });

  it('shares a relationship budget across relationship parts', () => {
    const xmlBudget: PptxXmlParseBudget = { remainingNodes: 100 };
    const relationshipBudget: PptxRelationshipParseBudget = { remainingRelationships: 1 };
    const xml = bytes(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="urn:test" Target="a.xml"/></Relationships>',
    );
    expect(parsePptxRelationships('/ppt/a.xml', xml, {}, xmlBudget, relationshipBudget).ok).toBe(
      true,
    );
    const result = parsePptxRelationships('/ppt/b.xml', xml, {}, xmlBudget, relationshipBudget);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.relationship.total_limit_exceeded' }],
    });
  });
});
