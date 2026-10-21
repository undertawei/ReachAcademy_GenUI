import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import { parsePptx } from '../src/pptx/index.js';

const createPptx = async (shape: string): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shape}</p:spTree></p:cSld></p:sld>`,
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(name, new TextReader(contents));
  }
  return writer.close();
};

describe('PPTX slide shape projection', () => {
  it('projects exact direct transform, preset geometry and non-visual metadata', async () => {
    const result = await parsePptx(
      await createPptx(`<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Rounded Rectangle 1" descr="Editable shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="12700" y="25400"/><a:ext cx="127000" cy="254000"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"/></a:avLst></a:prstGeom></p:spPr>
        <p:style/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:txBody>
      </p:sp>`),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.slides[0]?.nodes[0]).toMatchObject({
      kind: 'shape',
      nonVisual: { sourceId: '2', name: 'Rounded Rectangle 1', description: 'Editable shape' },
      directTransform: {
        bounds: { x: 1, y: 2, width: 10, height: 20 },
        rotationDegrees: 90,
        flipHorizontal: true,
        flipVertical: false,
      },
      geometry: { kind: 'preset', preset: 'roundRect', adjustments: { adj: 'val 16667' } },
      text: {
        properties: { xml: { name: 'a:bodyPr' } },
        paragraphs: [{ runs: [{ kind: 'text', text: 'Hello' }] }],
      },
    });
  });

  it('retains placeholder shapes without inventing inherited transform or geometry', async () => {
    const result = await parsePptx(
      await createPptx(
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.slides[0]?.nodes[0]).toMatchObject({
      kind: 'shape',
      placeholder: { type: 'title', index: '1' },
    });
    expect(result.ir.slides[0]?.nodes[0]).not.toHaveProperty('directTransform');
    expect(result.ir.slides[0]?.nodes[0]).not.toHaveProperty('geometry');
  });

  it('rejects malformed direct transforms with a structured source diagnostic', async () => {
    const result = await parsePptx(
      await createPptx(
        '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Broken"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="-10" cy="10"/></a:xfrm></p:spPr></p:sp>',
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'pptx.geometry.invalid_extent',
          feature: 'transform',
          location: { partPath: '/ppt/slides/slide1.xml' },
        },
      ],
    });
  });

  it('accepts zero-extent transforms (horizontal/vertical straight lines)', async () => {
    const result = await parsePptx(
      await createPptx(
        '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Line"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="0"/></a:xfrm></p:spPr></p:sp>',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.slides[0]?.nodes[0]).toMatchObject({
      kind: 'shape',
      directTransform: { bounds: { width: 100, height: 0 } },
    });
  });

  it('digests deeply nested groups in linear time (no children/content double walk)', async () => {
    // 60 层嵌套：children/content 双引用下按层 ×2 序列化会是 2^60 规模，
    // 单遍规范序列化则毫秒级完成。真实课件 13 层即触发过 RangeError。
    const DEPTH = 60;
    const open = Array.from(
      { length: DEPTH },
      (_, i) =>
        `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${i + 10}" name="g${i}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`,
    ).join('');
    const close = '</p:grpSp>'.repeat(DEPTH);
    const leaf =
      '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Leaf"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr></p:sp>';

    const result = await parsePptx(await createPptx(`${open}${leaf}${close}`));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.slides[0]?.nodes[0]?.kind).toBeDefined();
  });
});
