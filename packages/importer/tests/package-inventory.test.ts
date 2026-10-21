import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import { analyzePptxCapabilities, parsePptx } from '../src/pptx/index.js';

const CONTENT_TYPES = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

const PRESENTATION = `<?xml version="1.0"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`;

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const createInventoryPptx = async (missingTheme = false): Promise<Uint8Array> => {
  const entries: (readonly [string, string])[] = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['ppt/presentation.xml', PRESENTATION],
    [
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/slide" Target="slides/slide1.xml"/></Relationships>`,
    ],
    [
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld></p:sld>',
    ],
    [
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    ],
    [
      'ppt/slideLayouts/slideLayout1.xml',
      '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title"><p:cSld name="Title"/></p:sldLayout>',
    ],
    [
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      `<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    ],
    [
      'ppt/slideMasters/slideMaster1.xml',
      '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    ],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      `<Relationships xmlns="${RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    ],
    [
      'ppt/notesSlides/notesSlide1.xml',
      '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    ],
  ];
  if (!missingTheme) {
    entries.push([
      'ppt/theme/theme1.xml',
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"/>',
    ]);
  }

  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, contents] of entries) await writer.add(name, new TextReader(contents));
  return writer.close();
};

describe('PPTX package inventory', () => {
  it('retains every XML part and relationship chain without projecting unsupported semantics', async () => {
    const result = await parsePptx(await createInventoryPptx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.inventoryComplete).toBe(false);
    expect(result.ir.slides[0]).toMatchObject({
      layoutPartPath: '/ppt/slideLayouts/slideLayout1.xml',
      notesPartPath: '/ppt/notesSlides/notesSlide1.xml',
    });
    expect(result.ir.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/ppt/slideLayouts/slideLayout1.xml',
          kind: 'slide-layout',
          xml: expect.objectContaining({ name: 'p:sldLayout' }),
        }),
        expect.objectContaining({
          path: '/ppt/slideMasters/slideMaster1.xml',
          kind: 'slide-master',
          relationships: [expect.objectContaining({ target: '/ppt/theme/theme1.xml' })],
        }),
        expect.objectContaining({ path: '/ppt/theme/theme1.xml', kind: 'theme' }),
        expect.objectContaining({ path: '/ppt/notesSlides/notesSlide1.xml', kind: 'notes-slide' }),
      ]),
    );
    expect(result.ir.relationships).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({
          partPath: '/ppt/slideMasters/_rels/slideMaster1.xml.rels',
        }),
        target: '/ppt/theme/theme1.xml',
      }),
    );
    expect(result.ir.themes[0]).toMatchObject({ name: 'Office' });
    expect(result.ir.masters[0]).toMatchObject({ themePartPath: '/ppt/theme/theme1.xml' });
    expect(result.ir.layouts[0]).toMatchObject({
      masterPartPath: '/ppt/slideMasters/slideMaster1.xml',
      name: 'Title',
      layoutType: 'title',
    });
    expect(result.ir.notes[0]).toMatchObject({ partPath: '/ppt/notesSlides/notesSlide1.xml' });
    expect(() => JSON.stringify(result.ir)).not.toThrow();

    const capabilities = analyzePptxCapabilities(result.ir);
    expect(capabilities.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: 'theme', status: 'unsupported' }),
        // Master/layout parts map natively since decoration materialization:
        // placeholders inherit, non-placeholder drawables render per page.
        expect.objectContaining({ feature: 'master', status: 'native' }),
        expect.objectContaining({ feature: 'layout', status: 'native' }),
        expect.objectContaining({ feature: 'notes', status: 'unsupported' }),
      ]),
    );
    expect(
      capabilities.diagnostics.some(
        (diagnostic) => diagnostic.feature === 'master' || diagnostic.feature === 'layout',
      ),
    ).toBe(false);
    expect(capabilities.canApply).toBe(false);
  });

  it('rejects a missing target anywhere in the relationship graph', async () => {
    const result = await parsePptx(await createInventoryPptx(true));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({
      code: 'pptx.relationship.missing_target',
      severity: 'fatal',
      location: { partPath: '/ppt/slideMasters/_rels/slideMaster1.xml.rels' },
    });
  });
});
