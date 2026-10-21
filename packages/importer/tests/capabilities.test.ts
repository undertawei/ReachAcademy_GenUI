import { describe, expect, it } from 'vitest';

import {
  PPTX_IR_SCHEMA_VERSION,
  analyzePptxCapabilities,
  createPptxSourceDigest,
  type PptxPresentationIR,
  type PptxUnknownNodeIR,
} from '../src/pptx/index.js';

const emptyDigest = createPptxSourceDigest(new Uint8Array());

const unknownShape = (): PptxUnknownNodeIR => ({
  kind: 'unknown',
  id: 'pptx-node-v1-0123456789abcdef0123456789abcdef',
  qualifiedName: 'p:sp',
  namespaceUri: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  attributes: {},
  relationshipIds: [],
  canonicalFragmentDigest: emptyDigest,
  xml: { name: 'p:sp', attributes: {}, children: [], content: [] },
  source: {
    partPath: '/ppt/slides/slide1.xml',
    nodePath: '/p:sld/p:cSld/p:spTree/p:sp[1]',
  },
});

const presentation = (nodes: readonly PptxUnknownNodeIR[]): PptxPresentationIR => ({
  schemaVersion: PPTX_IR_SCHEMA_VERSION,
  inventoryComplete: false,
  sourceDigest: emptyDigest,
  presentationPartPath: '/ppt/presentation.xml',
  slideSize: { widthEmu: 9_144_000, heightEmu: 6_858_000 },
  relationships: [],
  parts: [],
  themes: [],
  masters: [],
  layouts: [],
  notes: [],
  slides: [
    {
      id: '256',
      relationshipId: 'rId1',
      partPath: '/ppt/slides/slide1.xml',
      order: 1,
      nodes,
    },
  ],
});

describe('Reach Deck PPTX capability analysis', () => {
  it('blocks parsed but not yet semantically mapped nodes with exact source diagnostics', () => {
    const report = analyzePptxCapabilities(presentation([unknownShape()]));

    expect(report.canApply).toBe(false);
    expect(report.entries).toContainEqual({
      feature: 'shape',
      status: 'unsupported',
      reason:
        'Exact package bytes are retained, but this content is not yet mapped to a native editable Reach Deck element.',
    });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'pptx.feature.unsupported',
        severity: 'error',
        feature: 'shape',
        location: {
          partPath: '/ppt/slides/slide1.xml',
          slideId: '256',
          nodePath: '/p:sld/p:cSld/p:spTree/p:sp[1]',
        },
      }),
    );
  });

  it('blocks the presentation until the native mapper is implemented', () => {
    const report = analyzePptxCapabilities(presentation([]));

    expect(report.canApply).toBe(false);
    expect(report.entries).toEqual([
      {
        feature: 'presentation',
        status: 'unsupported',
        reason: 'A native Reach Deck mapper is not implemented for this capability profile.',
      },
    ]);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'pptx.feature.unsupported',
          feature: 'presentation',
          location: { partPath: '/ppt/presentation.xml' },
        }),
        expect.objectContaining({ code: 'pptx.inventory.incomplete' }),
      ]),
    );
  });
});
