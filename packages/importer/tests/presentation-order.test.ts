import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import { parsePptx } from '../src/pptx/index.js';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

const PRESENTATION = `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="512" r:id="rId2"/>
    <p:sldId id="256" r:id="rId1"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
</p:presentation>`;

const PRESENTATION_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`;

const slide = (shape = '') => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shape}</p:spTree></p:cSld>
</p:sld>`;

const createMinimalPptx = async (presentationXml = PRESENTATION): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries: readonly (readonly [string, string])[] = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['ppt/presentation.xml', presentationXml],
    ['ppt/_rels/presentation.xml.rels', PRESENTATION_RELS],
    ['ppt/slides/slide1.xml', slide()],
    [
      'ppt/slides/slide2.xml',
      slide('<p:sp><p:nvSpPr><p:cNvPr id="7" name="Title 1"/></p:nvSpPr></p:sp>'),
    ],
  ];
  for (const [name, contents] of entries) await writer.add(name, new TextReader(contents));
  return writer.close();
};

describe('PPTX presentation IR', () => {
  it('uses the presentation slide list order instead of ZIP or relationship order', async () => {
    const input = await createMinimalPptx();
    const result = await parsePptx(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.slideSize).toEqual({ widthEmu: 9_144_000, heightEmu: 6_858_000 });
    expect(result.ir.slides.map((item) => [item.id, item.partPath, item.order])).toEqual([
      ['512', '/ppt/slides/slide2.xml', 1],
      ['256', '/ppt/slides/slide1.xml', 2],
    ]);
    expect(result.ir.slides[0]?.nodes[0]).toMatchObject({
      kind: 'shape',
      source: {
        partPath: '/ppt/slides/slide2.xml',
        nodePath: '/p:sld/p:cSld/p:spTree/p:sp[1]',
      },
    });
    expect(result.sidecars.map((sidecar) => sidecar.partPath)).toContain('/ppt/slides/slide2.xml');
    expect(
      result.sidecars.every((sidecar) => sidecar.bytes.byteLength === sidecar.byteLength),
    ).toBe(true);
  });

  it('produces deterministic JSON-safe IR and source identities', async () => {
    const input = await createMinimalPptx();
    const first = await parsePptx(input);
    const second = await parsePptx(input);

    expect(first).toEqual(second);
    expect(() => JSON.stringify(first)).not.toThrow();
    if (first.ok) {
      expect(first.ir.slides[0]?.nodes[0]?.id).toMatch(/^pptx-node-v1-[a-f0-9]{32}$/);
    }
  });

  it('fails instead of inventing a default slide size', async () => {
    const input = await createMinimalPptx(PRESENTATION.replace(/\s*<p:sldSz[^>]+\/>/, ''));
    const result = await parsePptx(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]).toMatchObject({
        code: 'pptx.presentation.missing_slide_size',
        severity: 'fatal',
      });
    }
  });

  it('rejects parts with no declared content type instead of assigning a generic fallback', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    const entries: readonly (readonly [string, string])[] = [
      ['[Content_Types].xml', CONTENT_TYPES],
      ['_rels/.rels', ROOT_RELS],
      ['ppt/presentation.xml', PRESENTATION],
      ['ppt/_rels/presentation.xml.rels', PRESENTATION_RELS],
      ['ppt/slides/slide1.xml', slide()],
      ['ppt/slides/slide2.xml', slide()],
      ['custom/untyped.bin', 'untyped'],
    ];
    for (const [name, contents] of entries) await writer.add(name, new TextReader(contents));
    const invalid = await writer.close();

    const result = await parsePptx(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('pptx.content_types.unresolved_part');
    }
  });

  it('applies caller XML limits to content types and rejects namespace lookalikes', async () => {
    const input = await createMinimalPptx();
    const limited = await parsePptx(input, { limits: { maxXmlNodes: 2 } });
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.diagnostics[0]?.code).toBe('pptx.xml.node_limit_exceeded');
      expect(limited.diagnostics[0]?.location?.partPath).toBe('/[Content_Types].xml');
    }

    const lookalike = await createMinimalPptx(
      PRESENTATION.replace(
        'http://schemas.openxmlformats.org/presentationml/2006/main',
        'https://example.test/presentationml/main',
      ),
    );
    const invalidNamespace = await parsePptx(lookalike);
    expect(invalidNamespace.ok).toBe(false);
    if (!invalidNamespace.ok) {
      expect(invalidNamespace.diagnostics[0]?.code).toBe('pptx.presentation.invalid_root');
    }
  });

  it('rejects forged presentation descendants and relationship-id attributes', async () => {
    const forgedSize = PRESENTATION.replace(
      /<p:sldSz[^>]+\/>/,
      '<evil:sldSz xmlns:evil="urn:evil" cx="9144000" cy="6858000"/>',
    );
    const sizeResult = await parsePptx(await createMinimalPptx(forgedSize));
    expect(sizeResult).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.presentation.missing_slide_size' }],
    });

    const forgedId = PRESENTATION.replace('r:id="rId2"', 'evil:id="rId2" xmlns:evil="urn:evil"');
    const idResult = await parsePptx(await createMinimalPptx(forgedId));
    expect(idResult).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.presentation.invalid_slide_reference' }],
    });
  });
});
