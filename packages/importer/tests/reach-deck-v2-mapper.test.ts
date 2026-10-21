import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import {
  collectPptxReferencedMediaPartPaths,
  mapPptxPresentationToReachDeckV2,
  parsePptx,
  type PptxPresentationIR,
} from '../src/pptx/index.js';

const compatibilityTheme = {
  name: 'Imported compatibility theme',
  background: '#FFFFFF',
  surface: '#F8FAFC',
  ink: '#111827',
  muted: '#64748B',
  accent: '#2563EB',
  success: '#15803D',
  warning: '#B45309',
  fontDisplay: 'Noto Sans',
  fontBody: 'Noto Sans',
} as const;

const mapperOptions = {
  documentId: 'module-version-1',
  applicationId: 'pptx-apply-1',
  title: 'Imported lesson',
  language: 'zh-CN',
  generatedAt: '2026-08-01T00:00:00.000Z',
  compatibilityTheme,
} as const;

const createPptx = async (
  slideBody: string,
  slideXmlOverride?: string,
  extraEntries: Record<string, string> = {},
): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml':
      slideXmlOverride ??
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld>${slideBody}</p:cSld></p:sld>`,
    ...extraEntries,
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(name, new TextReader(contents));
  }
  return writer.close();
};

const supportedSlide = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
  <p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="445566"/></a:solidFill><a:prstDash val="dash"/><a:round/></a:ln></p:spPr></p:sp>
  <p:sp><p:nvSpPr><p:cNvPr id="3" name="Ellipse 1" hidden="1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="1905000" y="254000"/><a:ext cx="635000" cy="635000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:sp>
</p:spTree>`;

const parseIr = async (slideBody: string): Promise<PptxPresentationIR> => {
  const parsed = await parsePptx(await createPptx(slideBody));
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return parsed.ir;
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24"/></svg>',
);

const createPptxWithPicture = async (slideBody: string): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld>${slideBody}</p:cSld></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.svg"/></Relationships>`,
    'ppt/media/image1.png': PNG_BYTES,
    'ppt/media/image2.svg': SVG_BYTES,
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(
      name,
      typeof contents === 'string' ? new TextReader(contents) : new Uint8ArrayReader(contents),
    );
  }
  return writer.close();
};

const pictureSlide = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
  <p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1" descr="Course diagram"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:srcRect l="10000" r="20000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
</p:spTree>`;

const parsePictureIr = async (): Promise<PptxPresentationIR> => {
  const parsed = await parsePptx(await createPptxWithPicture(pictureSlide));
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return parsed.ir;
};

describe('strict PPTX to Reach Deck v2 mapper', () => {
  it.each(['shape', 'connector', 'table', 'group'])(
    'omits whitespace metadata on %s without losing the element',
    async (kind) => {
      const rectangle = supportedSlide.match(/<p:sp>.*?<\/p:sp>/s)![0];
      const core = '<p:cNvPr id="9" name="   " descr="   "/>';
      const transform = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm>';
      const node =
        kind === 'shape'
          ? rectangle.replace('<p:cNvPr id="2" name="Rectangle 1"/>', core)
          : kind === 'connector'
            ? `<p:cxnSp><p:nvCxnSpPr>${core}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${transform}<a:prstGeom prst="straightConnector1"/><a:ln w="12700"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`
            : kind === 'table'
              ? `<p:graphicFrame><p:nvGraphicFramePr>${core}<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
              : `<p:grpSp><p:nvGrpSpPr>${core}<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="635000"/></a:xfrm></p:grpSpPr>${rectangle}</p:grpSp>`;
      const result = mapPptxPresentationToReachDeckV2(
        await parseIr(supportedSlide.replace('</p:spTree>', `${node}</p:spTree>`)),
        mapperOptions,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const elements = result.document.nativeSlides[0]!.slide.elements;
      expect(elements).toHaveLength(3);
      expect(elements[2]!.name).toBeUndefined();
      expect(elements[2]!.ariaLabel).toBeUndefined();
      expect(result.diagnostics).toEqual([]);
    },
  );

  it.each([
    ['   ', '   ', undefined, undefined, 'Imported image'],
    ['  Picture  ', '  Description  ', '  Picture  ', '  Description  ', '  Description  '],
    ['  Picture  ', '   ', '  Picture  ', undefined, '  Picture  '],
  ])(
    'uses nonblank picture metadata and alt text (%j, %j)',
    async (name, description, expectedName, expectedLabel, expectedAlt) => {
      const parsed = await parsePptx(
        await createPptxWithPicture(
          pictureSlide.replace(
            'name="Image 1" descr="Course diagram"',
            `name="${name}" descr="${description}"`,
          ),
        ),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const result = mapPptxPresentationToReachDeckV2(parsed.ir, {
        ...mapperOptions,
        mediaUploads: {
          '/ppt/media/image1.png': { objectKey: 'uploads/image.png', contentType: 'image/png' },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const image = result.document.nativeSlides[0]!.slide.elements[0]!;
      expect(image.type).toBe('image');
      if (image.type !== 'image') return;
      expect(image.name).toBe(expectedName);
      expect(image.ariaLabel).toBe(expectedLabel);
      expect(image.alt).toBe(expectedAlt);
      expect(result.diagnostics).toEqual([]);
    },
  );

  it('retains tiny grouped custom geometry with a source warning and positive view box', async () => {
    const customShape = supportedSlide
      .match(/<p:sp>.*?<\/p:sp>/s)![0]
      .replace(
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
        '<a:custGeom><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo></a:path></a:pathLst></a:custGeom>',
      );
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Tiny group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000000" cy="1270000"/></a:xfrm></p:grpSpPr>${customShape}</p:grpSp>`;
    const result = mapPptxPresentationToReachDeckV2(
      await parseIr(supportedSlide.replace('</p:spTree>', `${group}</p:spTree>`)),
      mapperOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]!.slide.elements[2]!;
    expect(element.type).toBe('group');
    if (element.type !== 'group') return;
    expect(element.children[0]).toMatchObject({
      transform: { width: 0.01, height: 50 },
      geometry: { kind: 'custom', viewBox: { width: 0.01, height: 50 } },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'pptx.mapper.geometry_simplified',
        severity: 'warning',
        location: expect.objectContaining({
          partPath: '/ppt/slides/slide1.xml',
          nodePath: expect.stringContaining('p:grpSp[1]/p:sp[1]'),
        }),
      }),
    ]);
  });

  it('attributes nested geometry warnings to each source shape after skipped children', async () => {
    const customShape = supportedSlide
      .match(/<p:sp>.*?<\/p:sp>/s)![0]
      .replace(
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
        '<a:custGeom><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo></a:path></a:pathLst></a:custGeom>',
      );
    // 引用未声明的 guide,整形状被跳过。
    const skippedShape = customShape.replace('<a:pt x="100" y="100"/>', '<a:pt x="gd0" y="100"/>');
    const group = (id: string, children: string, tiny = false) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${tiny ? '1' : '1270000'}" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="${tiny ? '1270000000' : '1270000'}" cy="1270000"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`;
    const nested = group(
      '10',
      skippedShape +
        customShape +
        customShape +
        group('11', customShape.replace('id="2"', 'id="4"')),
    );
    const result = mapPptxPresentationToReachDeckV2(
      await parseIr(
        supportedSlide.replace('</p:spTree>', `${group('9', nested, true)}</p:spTree>`),
      ),
      mapperOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outer = result.document.nativeSlides[0]!.slide.elements[2]!;
    expect(outer.type).toBe('group');
    if (outer.type !== 'group') return;
    const inner = outer.children[0]!;
    expect(inner.type).toBe('group');
    if (inner.type !== 'group') return;
    expect(inner.children).toHaveLength(3);
    const warnings = result.diagnostics.filter(
      (entry) => entry.code === 'pptx.mapper.geometry_simplified',
    );
    expect(warnings).toHaveLength(3);
    expect(warnings).toEqual(
      expect.arrayContaining(
        [
          ['p:grpSp[1]/p:grpSp[1]/p:sp[2]', '2'],
          ['p:grpSp[1]/p:grpSp[1]/p:sp[3]', '2'],
          ['p:grpSp[1]/p:grpSp[1]/p:grpSp[1]/p:sp[1]', '4'],
        ].map(([nodePath, sourceId]) =>
          expect.objectContaining({
            severity: 'warning',
            location: expect.objectContaining({
              partPath: '/ppt/slides/slide1.xml',
              nodePath: expect.stringContaining(nodePath!),
            }),
            details: { sourceId },
          }),
        ),
      ),
    );
  });

  it.each([
    [
      'lIns="-12700"',
      '<a:normAutofit fontScale="0"/>',
      { left: 0, top: 3.6, right: 7.2, bottom: 3.6 },
      { mode: 'shrink-text' },
      ['pptx.mapper.text_autofit_simplified', 'pptx.mapper.text_margin_simplified'],
    ],
    [
      '',
      '<a:normAutofit fontScale="110000" lnSpcReduction="-1"/>',
      { left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 },
      { mode: 'shrink-text' },
      ['pptx.mapper.text_autofit_simplified', 'pptx.mapper.text_autofit_simplified'],
    ],
    [
      '',
      '<a:normAutofit lnSpcReduction="110000"/>',
      { left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 },
      { mode: 'shrink-text' },
      ['pptx.mapper.text_autofit_simplified'],
    ],
    [
      'lIns="12700" tIns="0"',
      '<a:normAutofit fontScale="75000" lnSpcReduction="20000"/>',
      { left: 1, top: 0, right: 7.2, bottom: 3.6 },
      { mode: 'shrink-text', fontScale: 0.75, lineSpacingReduction: 0.2 },
      [],
    ],
    [
      '',
      '<a:normAutofit/>',
      { left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 },
      { mode: 'shrink-text' },
      [],
    ],
  ])(
    'retains text with compatible margins and autofit (%s, %s)',
    async (bodyAttributes, autofitXml, expectedMargins, expectedAutofit, warnings) => {
      const text = `<p:txBody><a:bodyPr ${bodyAttributes}>${autofitXml}</a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr sz="1800"><a:latin typeface="Arial"/><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>Retained text</a:t></a:r></a:p></p:txBody>`;
      const result = mapPptxPresentationToReachDeckV2(
        await parseIr(supportedSlide.replace('</p:sp>', `${text}</p:sp>`)),
        mapperOptions,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.nativeSlides[0]!.slide.elements).toHaveLength(2);
      expect(result.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
        text: { margins: expectedMargins, autofit: expectedAutofit },
      });
      expect(JSON.stringify(result.document.nativeSlides[0]!.slide.elements[0])).toContain(
        'Retained text',
      );
      expect(result.diagnostics.map((entry) => entry.code)).toEqual(warnings);
      for (const entry of result.diagnostics) {
        expect(entry.severity).toBe('warning');
        expect(entry.location).toMatchObject({ partPath: '/ppt/slides/slide1.xml' });
      }
    },
  );

  it('keeps filled shapes and their text while making zero-width outlines invisible', async () => {
    const text = `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="Noto Sans"/></a:rPr><a:t>Retained text</a:t></a:r></a:p></p:txBody>`;
    const ir = await parseIr(
      supportedSlide
        .replace('w="25400"', 'w="0"')
        .replace('</p:spPr></p:sp>', `</p:spPr>${text}</p:sp>`),
    );
    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(2);
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      source: { sourceId: '2' },
      style: {
        fill: { kind: 'solid', color: { value: '#112233' } },
        stroke: { width: 0.75, fill: { value: '#445566', alpha: 0 } },
      },
      text: { doc: { content: [{ content: [{ text: 'Retained text' }] }] } },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'pptx.mapper.stroke_simplified',
        severity: 'warning',
        message: expect.stringContaining('Zero-width'),
        location: expect.objectContaining({ partPath: '/ppt/slides/slide1.xml' }),
      }),
    ]);
    expect(result.pageReports[0]?.status).toBe('warning');
  });

  it.each([
    ['w="1"', 0.000079],
    ['w="127"', 0.01],
    ['', 0.75],
  ])('preserves visible positive or default stroke widths (%s)', async (attribute, width) => {
    const ir = await parseIr(supportedSlide.replace('w="25400"', attribute));
    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      style: { stroke: { width, fill: { value: '#445566' } } },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects a negative source width rather than making it invisible', async () => {
    const result = mapPptxPresentationToReachDeckV2(
      await parseIr(supportedSlide.replace('w="25400"', 'w="-1"')),
      mapperOptions,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'pptx.mapper.stroke_unsupported',
        message: 'Stroke width is invalid.',
      }),
    ]);
  });

  it.each(['shape', 'connector'])(
    'keeps a zero-width %s line invisible without losing its source identity',
    async (kind) => {
      const node =
        kind === 'shape'
          ? `<p:sp><p:nvSpPr><p:cNvPr id="7" name="Invisible line"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="0"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr></p:sp>`
          : `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="Invisible line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="0"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`;
      const ir = await parseIr(supportedSlide.replace('</p:spTree>', `${node}</p:spTree>`));
      const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(3);
      expect(result.document.nativeSlides[0]?.slide.elements[2]).toMatchObject({
        type: 'line',
        source: { sourceId: '7' },
        stroke: { width: 0.75, fill: { alpha: 0 } },
      });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'pptx.mapper.stroke_simplified' }),
      ]);
    },
  );

  it('keeps pictures with zero-width borders and the source warning', async () => {
    const parsed = await parsePptx(
      await createPptxWithPicture(
        pictureSlide.replace(
          '</p:spPr>',
          '<a:ln w="0"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr>',
        ),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = mapPptxPresentationToReachDeckV2(parsed.ir, {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': { objectKey: 'uploads/image.png', contentType: 'image/png' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'image',
      stroke: { width: 0.75, fill: { alpha: 0 } },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'pptx.mapper.stroke_simplified' }),
    ]);
  });

  it('keeps table cell contents and fill when all four borders have zero width', async () => {
    const borders = ['L', 'R', 'T', 'B']
      .map(
        (side) =>
          `<a:ln${side} w="0"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln${side}>`,
      )
      .join('');
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="Noto Sans"/></a:rPr><a:t>Cell</a:t></a:r></a:p></a:txBody><a:tcPr>${borders}<a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:tcPr></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const ir = await parseIr(supportedSlide.replace('</p:spTree>', `${table}</p:spTree>`));
    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[2]).toMatchObject({
      type: 'table',
      rows: [
        {
          cells: [
            {
              style: {
                fill: { color: { value: '#112233' } },
                stroke: { width: 0.75, fill: { alpha: 0 } },
              },
              text: { doc: { content: [{ content: [{ text: 'Cell' }] }] } },
            },
          ],
        },
      ],
    });
    expect(
      result.diagnostics.filter((entry) => entry.code === 'pptx.mapper.stroke_simplified'),
    ).toHaveLength(1);
    expect(
      result.diagnostics.some((entry) => entry.code === 'pptx.mapper.invalid_reach_deck_candidate'),
    ).toBe(false);
  });

  it.each([
    ['theme zero', '0', '', 0.75, 0],
    ['direct zero overrides theme', '25400', 'w="0"', 0.75, 0],
    ['width inherited from theme', '25400', '', 2, undefined],
    ['direct positive overrides theme zero', '0', 'w="127"', 0.01, undefined],
  ])(
    'resolves stroke width precedence before compatibility mapping (%s)',
    async (_name, themeWidth, directWidth, width, alpha) => {
      const slide = supportedSlide
        .replace(/<a:ln w="25400">.*?<\/a:ln>/s, `<a:ln ${directWidth}/>`)
        .replace(
          '</p:spPr></p:sp>',
          '</p:spPr><p:style><a:lnRef idx="1"><a:srgbClr val="445566"/></a:lnRef></p:style></p:sp>',
        );
      const parsed = await parsePptx(
        await createPptx(slide, undefined, {
          '[Content_Types].xml':
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
          'ppt/presentation.xml':
            '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
          'ppt/_rels/presentation.xml.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="master" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="slide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
          'ppt/slides/_rels/slide1.xml.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="layout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
          'ppt/slideLayouts/slideLayout1.xml':
            '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldLayout>',
          'ppt/slideLayouts/_rels/slideLayout1.xml.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="master" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
          'ppt/slideMasters/slideMaster1.xml':
            '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldMaster>',
          'ppt/slideMasters/_rels/slideMaster1.xml.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="theme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>',
          'ppt/theme/theme1.xml': `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fmtScheme><a:lnStyleLst><a:ln w="${themeWidth}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
        }),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const element = result.document.nativeSlides[0]?.slide.elements[0];
      expect(element).toMatchObject({ style: { stroke: { width, fill: { value: '#445566' } } } });
      if (element?.type !== 'shape') throw new Error('Expected a shape.');
      expect(element.style?.stroke?.fill.alpha).toBe(alpha);
      expect(result.diagnostics).toHaveLength(alpha === 0 ? 1 : 0);
    },
  );

  it.each(['', '   '])('omits blank optional shape names (%j)', async (name) => {
    const ir = await parseIr(supportedSlide.replace('name="Rectangle 1"', `name="${name}"`));
    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]?.name).toBeUndefined();
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(2);
  });

  it.each(['picture', 'chart'])(
    'keeps a picture and %s with reused source ids distinct',
    async (kind) => {
      const picture = pictureSlide.match(/<p:pic>.*?<\/p:pic>/s)![0];
      const sibling =
        kind === 'picture'
          ? picture
          : `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`;
      const parsed = await parsePptx(
        await createPptxWithPicture(pictureSlide.replace('</p:spTree>', `${sibling}</p:spTree>`)),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const options = {
        ...mapperOptions,
        mediaUploads: {
          '/ppt/media/image1.png': { objectKey: 'uploads/image.png', contentType: 'image/png' },
        },
      };
      const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const elements = result.document.nativeSlides[0]!.slide.elements;
      expect(elements).toHaveLength(2);
      expect(new Set(elements.map((element) => element.id)).size).toBe(2);
      expect(elements.map((element) => element.source?.sourceId)).toEqual(['7', '7']);
      expect(mapPptxPresentationToReachDeckV2(parsed.ir, options)).toEqual(result);
    },
  );

  it('accepts nominal standard stages serialized with rounded EMU dimensions', async () => {
    const ir = await parseIr(supportedSlide);
    ir.slideSize.widthEmu = 12_191_695;
    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.stage).toEqual({ width: 960, height: 540, aspectRatio: '16:9' });
  });

  it('still rejects fractional-point stages outside the producer-rounding tolerance', async () => {
    const ir = await parseIr(supportedSlide);
    ir.slideSize.widthEmu = 12_190_000;
    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'pptx.mapper.stage_unsupported' })]),
    );
  });

  it('maps direct rect/ellipse geometry and styles into a validated deterministic document', async () => {
    const ir = await parseIr(supportedSlide);
    expect(ir.inventoryComplete).toBe(false);

    const first = mapPptxPresentationToReachDeckV2(ir, mapperOptions);
    const second = mapPptxPresentationToReachDeckV2(structuredClone(ir), mapperOptions);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.document).toMatchObject({
      schemaVersion: 'reach-deck-document/v2',
      id: 'module-version-1',
      stage: { width: 720, height: 540, aspectRatio: '4:3' },
      metadata: { source: 'import', language: 'zh-CN' },
      provenance: { source: 'pptx', sourceDigest: ir.sourceDigest },
      pages: [{ order: 1, revision: 1, sceneType: 'slide' }],
    });
    expect(first.document.nativeSlides[0]?.slide.textCompatibility).toBe('pptx');
    const elements = first.document.nativeSlides[0]?.slide.elements;
    expect(elements).toMatchObject([
      {
        type: 'shape',
        zIndex: 1,
        transform: { x: 10, y: 20, width: 100, height: 50 },
        geometry: { kind: 'preset', preset: 'rect' },
        style: {
          fill: { kind: 'solid', color: { kind: 'srgb', value: '#112233' } },
          stroke: {
            width: 2,
            fill: { kind: 'srgb', value: '#445566' },
            dash: 'dash',
            join: 'round',
          },
        },
      },
      {
        type: 'shape',
        zIndex: 2,
        hidden: true,
        transform: {
          x: 150,
          y: 20,
          width: 50,
          height: 50,
          rotation: 90,
          flipHorizontal: true,
        },
        geometry: { kind: 'preset', preset: 'ellipse' },
        style: { fill: { kind: 'none' } },
      },
    ]);
    expect(first.diagnostics).toEqual([]);
  });

  it('localizes lost content to its slide and still yields a candidate', async () => {
    const ir =
      await parseIr(`<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Star shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="127000" cy="127000"/></a:xfrm><a:prstGeom prst="cloudCallout"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:effectLst/></p:spPr></p:sp>
      <p:pic/>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    // Two things are lost here — the theme background and the picture — and
    // the page still imports on a plain surface with both losses itemized.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(1);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'pptx.mapper.style_matrix_unsupported',
        // 空 p:pic 走图片分支：缺少嵌入关系时给出针对性的诊断。
        'pptx.mapper.picture_unsupported',
      ]),
    );
    // 标准预置几何不再阻断：cloudCallout 按标准定义的轮廓导入。
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'pptx.mapper.preset_geometry_unsupported',
    );
    // 空 a:effectLst 无视觉语义：不再产生 effects 诊断，也不参与阻断。
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'pptx.mapper.effects_unsupported',
    );
    expect(
      result.diagnostics.every(
        (diagnostic) => diagnostic.location?.partPath === '/ppt/slides/slide1.xml',
      ),
    ).toBe(true);
    expect(
      result.diagnostics
        .filter((diagnostic) => diagnostic.code !== 'pptx.mapper.preset_geometry_outlined')
        .every((diagnostic) => diagnostic.severity === 'error'),
    ).toBe(true);
  });

  it('accepts placeholder-free text boxes and ignorable extension metadata', async () => {
    const ir =
      await parseIr(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Text box 1"><a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"/></a:extLst></p:cNvPr><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="254000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="none"/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1800"><a:latin typeface="Arial"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>你好</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'shape',
      geometry: { kind: 'preset', preset: 'rect' },
      style: { fill: { kind: 'none' } },
      text: {
        wrap: false,
        doc: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '你好',
                  marks: [
                    {
                      type: 'textStyle',
                      // 平台字体收敛:微软雅黑 → 内置目录的思源黑体。
                      attrs: {
                        fontFamily: 'Source Han Sans VF',
                        fontSize: '18px',
                        color: '#111827',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
  });

  it('maps percentage space-before, point line spacing, indentation and character spacing', async () => {
    const ir =
      await parseIr(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Text box 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr marL="457200" marR="228600" indent="-228600"><a:lnSpc><a:spcPts val="2400"/></a:lnSpc><a:spcBef><a:spcPct val="50000"/></a:spcBef><a:spcAft><a:spcPct val="25000"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000" spc="150"><a:latin typeface="Arial"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>排版属性</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'shape',
      text: {
        doc: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: {
                // spcPts 2400 → 24pt 绝对行距。
                lineHeightPx: 24,
                // spcPct 相对行高:20pt × 1.2 × 50% = 12pt;25% = 6pt。
                spaceBefore: 12,
                spaceAfter: 6,
                // marL 457200EMU=36pt、marR 228600EMU=18pt、indent -18pt 悬挂。
                leftIndent: 36,
                rightIndent: 18,
                firstLineIndent: -18,
              },
              content: [
                {
                  type: 'text',
                  text: '排版属性',
                  marks: [
                    {
                      type: 'textStyle',
                      // rPr spc=150(1/100pt) → 1.5px 字符间距。
                      attrs: { fontSize: '20px', letterSpacing: 1.5 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
  });

  it('maps bodyPr vert East-Asian vertical text to frame orientation instead of dropping it', async () => {
    const ir =
      await parseIr(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Vertical text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635000" cy="2540000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr vert="eaVert"/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1800"><a:latin typeface="Arial"/><a:ea typeface="微软雅黑"/></a:rPr><a:t>竖排标题</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'shape',
      text: { orientation: 'vertical' },
    });
    expect(result.pageReports[0]).toMatchObject({ status: 'ok' });
  });

  it('ignores custDataLst, transition and showMasterSp as non-content chrome', async () => {
    const slideXml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" showMasterSp="0"><p:cSld><p:custDataLst><p:custData/></p:custDataLst>${supportedSlide}</p:cSld><p:transition spd="slow"><p:fade/></p:transition></p:sld>`;
    const parsed = await parsePptx(await createPptx('', slideXml));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('maps freeform custom geometry into a box-normalized SVG path', async () => {
    // Path space 2540000x1270000 EMU (200x100pt) drawn into a 100x50pt box → ×0.5.
    const ir =
      await parseIr(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Freeform 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst></a:gdLst><a:ahLst/><a:cxnLst></a:cxnLst><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="2540000" h="1270000"><a:moveTo><a:pt x="0" y="1270000"/></a:moveTo><a:lnTo><a:pt x="1270000" y="0"/></a:lnTo><a:cubicBezTo><a:pt x="1524000" y="254000"/><a:pt x="2286000" y="508000"/><a:pt x="2540000" y="1270000"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr></p:sp>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'shape',
      transform: { x: 10, y: 20, width: 100, height: 50 },
      geometry: {
        kind: 'custom',
        viewBox: { width: 100, height: 50 },
        path: 'M 0 50 L 50 0 C 60 10 90 20 100 50 Z',
      },
      style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#112233' } } },
    });
  });

  it('maps zero-height freeform paths without dividing by the empty axis', async () => {
    const ir =
      await parseIr(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Horizontal freeform"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="12700"/></a:xfrm><a:custGeom><a:avLst/><a:pathLst><a:path w="1270000" h="0"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1270000" y="0"/></a:lnTo></a:path></a:pathLst></a:custGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr></p:sp>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      geometry: {
        kind: 'custom',
        // The zero axis of the path space contributes only zero coordinates.
        viewBox: { width: 100, height: 1 },
        path: 'M 0 0 L 100 0',
      },
    });
  });

  it('maps legacy freeforms whose guides only feed connection sites and a full-bounds rect', async () => {
    // Real corpus shape (量子 d05): gdLst holds "*/ n w|h d" guides referenced
    // only by cxnLst and a rect that evaluates to the full shape bounds; the
    // path itself uses literal coordinates, so guides never affect rendering.
    const ir =
      await parseIr(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Freeform 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst><a:gd name="T0" fmla="*/ 0 w 48"/><a:gd name="T1" fmla="*/ 0 h 192"/><a:gd name="T2" fmla="*/ 48 w 48"/><a:gd name="T3" fmla="*/ 192 h 192"/><a:gd name="T4" fmla="*/ 0 60000 65536"/></a:gdLst><a:ahLst/><a:cxnLst><a:cxn ang="T4"><a:pos x="T0" y="T1"/></a:cxn></a:cxnLst><a:rect l="T0" t="T1" r="T2" b="T3"/><a:pathLst><a:path w="48" h="192"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:cubicBezTo><a:pt x="24" y="32"/><a:pt x="48" y="64"/><a:pt x="48" y="96"/></a:cubicBezTo><a:lnTo><a:pt x="0" y="192"/></a:lnTo></a:path></a:pathLst></a:custGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr></p:sp>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      geometry: {
        kind: 'custom',
        viewBox: { width: 100, height: 50 },
        // 48x192 path units into a 100x50pt box.
        path: 'M 0 0 C 50 8.333333 100 16.666667 100 25 L 0 50',
      },
    });
  });

  it('maps freeform paths without a declared coordinate space in the shape space', async () => {
    // WPS 导出的圆角「任意多边形」:a:path 不写 w/h,坐标全由 gdLst 按形状 w/h 求值。
    const freeform = (path: string, guides = '') =>
      `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="任意多边形 16"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst>${guides}</a:gdLst><a:ahLst/><a:cxnLst/><a:pathLst>${path}</a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr></p:sp>
    </p:spTree>`;
    const cases = [
      {
        // Guide formulas over the shape w/h.
        xml: freeform(
          `<a:path><a:moveTo><a:pt x="p0" y="p1"/></a:moveTo><a:lnTo><a:pt x="p2" y="p1"/></a:lnTo><a:lnTo><a:pt x="p2" y="p3"/></a:lnTo><a:close/></a:path>`,
          `<a:gd name="p0" fmla="*/ 10 w 100"/><a:gd name="p1" fmla="*/ 0 h 100"/><a:gd name="p2" fmla="*/ 90 w 100"/><a:gd name="p3" fmla="*/ 100 h 100"/>`,
        ),
        path: 'M 10 0 L 90 0 L 90 50 Z',
      },
      {
        // Literal coordinates are shape-space EMU.
        xml: freeform(
          `<a:path><a:moveTo><a:pt x="127000" y="0"/></a:moveTo><a:lnTo><a:pt x="1143000" y="635000"/></a:lnTo></a:path>`,
        ),
        path: 'M 10 0 L 90 50',
      },
      {
        // w="0"/h="0" is the attribute default and also means the shape space.
        xml: freeform(
          `<a:path w="0" h="0"><a:moveTo><a:pt x="127000" y="0"/></a:moveTo><a:lnTo><a:pt x="1143000" y="635000"/></a:lnTo></a:path>`,
        ),
        path: 'M 10 0 L 90 50',
      },
    ];
    for (const { xml, path } of cases) {
      const result = mapPptxPresentationToReachDeckV2(await parseIr(xml), mapperOptions);
      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
        type: 'shape',
        transform: { width: 100, height: 50 },
        geometry: { kind: 'custom', viewBox: { width: 100, height: 50 }, path },
      });
    }
  });

  it.each([
    ['declared axes', 'w="2540000" h="1270000"', '2540000', '1270000', '50 25'],
    ['missing height', 'w="2540000"', '2540000', '635000', '50 50'],
    ['zero height', 'w="2540000" h="0"', '2540000', '635000', '50 50'],
    ['missing width', 'h="1270000"', '1270000', '1270000', '100 25'],
    ['zero width', 'w="0" h="1270000"', '1270000', '1270000', '100 25'],
    ['missing axes', '', '1270000', '635000', '100 50'],
    ['zero axes', 'w="0" h="0"', '1270000', '635000', '100 50'],
  ])(
    'evaluates shape guides before independent path scaling: %s',
    async (_label, dimensions, literalX, literalY, guidedPoint) => {
      // DrawingML guides use the shape EMU extent, even when the path declares
      // another coordinate space. Only the declared axes introduce a path scale;
      // omitted/zero axes retain the shape's own EMU-to-point scale.
      const ir = await parseIr(`<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Guided freeform"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom><a:gdLst><a:gd name="gx" fmla="val w"/><a:gd name="gy" fmla="val h"/></a:gdLst><a:rect l="0" t="0" r="1270000" b="635000"/><a:pathLst><a:path ${dimensions}><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="gx" y="gy"/></a:lnTo><a:lnTo><a:pt x="${literalX}" y="${literalY}"/></a:lnTo></a:path></a:pathLst></a:custGeom><a:noFill/></p:spPr></p:sp>
    </p:spTree>`);

      const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
        type: 'shape',
        geometry: {
          kind: 'custom',
          viewBox: { width: 100, height: 50 },
          path: `M 0 0 L ${guidedPoint} L 100 50`,
        },
      });
    },
  );

  it('maps the DrawingML shape-guide example with a declared EMU path space', async () => {
    // ISO/IEC 29500-1 a:gd example: myGuide = h * 2/3 places the base of
    // the triangle at 2/3 of its height, with explicit path w/h in EMUs.
    const ir = await parseIr(`<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Guide triangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom><a:gdLst><a:gd name="myGuide" fmla="*/ h 2 3"/></a:gdLst><a:pathLst><a:path w="1270000" h="635000"><a:moveTo><a:pt x="0" y="myGuide"/></a:moveTo><a:lnTo><a:pt x="1270000" y="myGuide"/></a:lnTo><a:lnTo><a:pt x="635000" y="0"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom><a:noFill/></p:spPr></p:sp>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      geometry: { kind: 'custom', path: 'M 0 33.333333 L 100 33.333333 L 50 0 Z' },
    });
  });

  it('drops out-of-slice custom geometry with a page warning', async () => {
    const freeform = (body: string) =>
      `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Freeform 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom>${body}</a:custGeom><a:noFill/></p:spPr></p:sp>
    </p:spTree>`;
    const simplePath = `<a:pathLst><a:path w="1270000" h="635000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1270000" y="635000"/></a:lnTo></a:path></a:pathLst>`;
    const cases = [
      // A text rectangle that resolves to half the shape width changes layout.
      `<a:gdLst><a:gd name="g0" fmla="*/ w 1 2"/></a:gdLst><a:rect l="l" t="t" r="g0" b="b"/>${simplePath}`,
      // A coordinate referencing a guide the shape never declares.
      `<a:pathLst><a:path w="1270000" h="635000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="gd0" y="635000"/></a:lnTo></a:path></a:pathLst>`,
      // A path that does not start at an explicit point.
      `<a:pathLst><a:path w="1270000" h="635000"><a:lnTo><a:pt x="0" y="0"/></a:lnTo></a:path></a:pathLst>`,
    ];
    for (const body of cases) {
      const result = mapPptxPresentationToReachDeckV2(await parseIr(freeform(body)), mapperOptions);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'pptx.mapper.custom_geometry_unsupported',
      );
      expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
      expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(0);
    }
  });

  it('maps embedded pictures with caller-supplied storage keys into image elements', async () => {
    const ir = await parsePictureIr();
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/abc.png',
          contentType: 'image/png',
        },
      },
    };

    const first = mapPptxPresentationToReachDeckV2(ir, options);
    const second = mapPptxPresentationToReachDeckV2(structuredClone(ir), options);

    expect(first).toEqual(second);
    expect(first.diagnostics).toEqual([]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const element = first.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'image',
      transform: { x: 10, y: 20, width: 100, height: 50 },
      fit: 'stretch',
      crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 },
      alt: 'Course diagram',
    });
    expect(first.document.resources.media).toHaveLength(1);
    expect(first.document.resources.media[0]).toMatchObject({
      objectKey: 'uploads/org/reach-deck/mv/image/abc.png',
      contentType: 'image/png',
    });
    if (element?.type !== 'image') throw new Error('Expected an image element.');
    expect(element.resourceId).toBe(first.document.resources.media[0]!.id);
  });

  it('maps OLE graphicFrames through their picture fallback rendering', async () => {
    // Equation-style embedded objects: mc:Choice requires VML, so MCE resolves
    // to the mc:Fallback oleObj whose p:pic carries the rendered bitmap.
    const oleSlide = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Object 1"/><p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:oleObj spid="_x0000_s1" name="Equation" r:id="rId2" imgW="1270000" imgH="635000" progId="Equation.3"><p:embed/></p:oleObj></mc:Choice><mc:Fallback><p:oleObj name="Equation" r:id="rId2" imgW="1270000" imgH="635000" progId="Equation.3"><p:embed/><p:pic><p:nvPicPr><p:cNvPr id="9" name="Object 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr bwMode="auto"><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:pic></p:oleObj></mc:Fallback></mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(oleSlide));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/eq.png',
          contentType: 'image/png',
        },
      },
    };

    expect(collectPptxReferencedMediaPartPaths(parsed.ir)).toEqual(['/ppt/media/image1.png']);
    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'image',
      transform: { x: 10, y: 20, width: 100, height: 50 },
      fit: 'stretch',
    });
  });

  it('retains unresolved chart frames as warning-only placeholders', async () => {
    const chartSlide = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>
    </p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(chartSlide), mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'pptx.mapper.chart_unsupported',
        feature: 'chart',
        severity: 'warning',
      }),
    );
    expect(result.document.nativeSlides[0]?.slide.elements).toContainEqual(
      expect.objectContaining({
        type: 'chart',
        chartType: 'unsupported',
        sourceChartType: 'unresolved-chart',
      }),
    );
  });

  it('maps blipFill image backgrounds into a v2 image fill', async () => {
    const backgroundSlide = `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rId1"><a:lum/></a:blip><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(backgroundSlide));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/bg.png',
          contentType: 'image/png',
        },
      },
    };

    expect(collectPptxReferencedMediaPartPaths(parsed.ir)).toEqual(['/ppt/media/image1.png']);
    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const slide = result.document.nativeSlides[0]?.slide;
    expect(slide?.background).toMatchObject({ kind: 'image', mode: 'stretch' });
    expect(result.document.resources.media).toHaveLength(1);
    if (slide?.background.kind !== 'image') throw new Error('Expected an image background.');
    expect(slide.background.resourceId).toBe(result.document.resources.media[0]!.id);
  });

  it('keeps a page whose background cannot resolve, on a plain surface', async () => {
    const backgroundSlide = `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId1"/><a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/></a:blipFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(backgroundSlide));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/bg.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    // The background is one lost element; the page — and its content — stays,
    // on the compatibility theme's plain background, with the loss on record.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.diagnostics.some((entry) => entry.code === 'pptx.mapper.background_fill_unsupported'),
    ).toBe(true);
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    expect(result.document.nativeSlides[0]?.slide.background).toEqual({
      kind: 'solid',
      color: { kind: 'srgb', value: '#FFFFFF' },
    });
  });

  it('maps shape blipFill stretch fills into a v2 image fill', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Photo box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:blipFill rotWithShape="1"><a:blip r:embed="rId1"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/fill.png',
          contentType: 'image/png',
        },
      },
    };

    expect(collectPptxReferencedMediaPartPaths(parsed.ir)).toEqual(['/ppt/media/image1.png']);
    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'shape',
      style: { fill: { kind: 'image', mode: 'stretch' } },
    });
    expect(result.document.resources.media).toHaveLength(1);
    if (element?.type !== 'shape' || element.style.fill?.kind !== 'image') {
      throw new Error('Expected an image shape fill.');
    }
    expect(element.style.fill.resourceId).toBe(result.document.resources.media[0]!.id);
  });

  it('maps identity-tiled shape blipFill to a tile image fill and blocks scaled tiles', async () => {
    const shape = (id: string, tile: string) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Texture ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:blipFill rotWithShape="1"><a:blip r:embed="rId1"/><a:srcRect/>${tile}</a:blipFill></p:spPr></p:sp>`;
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      ${shape('2', '<a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/>')}
      ${shape('3', '<a:tile sx="50000" sy="50000"/>')}
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/fill.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const elements = result.document.nativeSlides[0]?.slide.elements;
    // 恒等平铺映射为 tile 图片填充;非恒等缩放平铺保持阻断丢弃。
    expect(elements).toHaveLength(1);
    expect(elements?.[0]).toMatchObject({
      type: 'shape',
      style: { fill: { kind: 'image', mode: 'tile' } },
    });
    expect(
      result.diagnostics.some(
        (entry) => entry.code === 'pptx.mapper.fill_unsupported' && entry.severity === 'error',
      ),
    ).toBe(true);
  });

  it('bare shape blipFill without stretch or tile defaults to a stretch image fill', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Photo box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:blipFill rotWithShape="1"><a:blip r:embed="rId1"/></a:blipFill></p:spPr></p:sp>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/fill.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      style: { fill: { kind: 'image', mode: 'stretch' } },
    });
  });

  it('maps shape blipFill stretch fillRect offsets into image fill insets', async () => {
    // 负偏移 = 出血(常见照片填充);微小值(<0.1%)归零。
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Bleed photo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:blipFill rotWithShape="1"><a:blip r:embed="rId1"/><a:srcRect/><a:stretch><a:fillRect l="-3401" t="-16456" b="-44304"/></a:stretch></a:blipFill></p:spPr></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="Tiny offsets"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="700000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect l="-6" t="-15" r="6" b="21"/></a:stretch></a:blipFill></p:spPr></p:sp>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/fill.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const elements = result.document.nativeSlides[0]?.slide.elements;
    expect(elements?.[0]).toMatchObject({
      type: 'shape',
      style: {
        fill: {
          kind: 'image',
          mode: 'stretch',
          insets: { left: -0.03401, top: -0.16456, right: 0, bottom: -0.44304 },
        },
      },
    });
    // 全部偏移低于 0.1% → 纯拉伸,不带 insets。
    expect(elements?.[1]).toMatchObject({
      type: 'shape',
      style: { fill: { kind: 'image', mode: 'stretch' } },
    });
    if (elements?.[1]?.type !== 'shape' || elements[1].style.fill?.kind !== 'image') {
      throw new Error('Expected an image shape fill.');
    }
    expect(elements[1].style.fill.insets).toBeUndefined();
  });

  it('keeps pictures with a:noFill styling without diagnostics', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({ type: 'image' });
  });

  it('maps a picture whose only image relationship is the Office SVG extension', async () => {
    // A generator that targets modern renderers writes no raster fallback, so
    // the bare blip's extension is the picture's only relationship.
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Icon 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="406400" cy="406400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(collectPptxReferencedMediaPartPaths(parsed.ir)).toEqual(['/ppt/media/image2.svg']);
    const options = {
      ...mapperOptions,
      mediaUploads: {
        // Vector art reaches the mapper already rasterized by the caller.
        '/ppt/media/image2.svg': {
          objectKey: 'uploads/org/reach-deck/mv/image/icon.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({ type: 'image' });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'pptx.mapper.vector_image_rasterized',
        severity: 'info',
        feature: 'image',
      }),
    ]);
    expect(result.pageReports[0]).toMatchObject({ status: 'ok' });
  });

  it('prefers the raster fallback over the SVG extension when the blip carries both', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Icon 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="406400" cy="406400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(collectPptxReferencedMediaPartPaths(parsed.ir)).toEqual(['/ppt/media/image1.png']);
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({ type: 'image' });
  });

  it('keeps pictures with blip color adjustments and degrades them to advisories', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"><a:duotone><a:prstClr val="black"/><a:srgbClr val="D9C3A5"><a:tint val="50000"/><a:satMod val="180000"/></a:srgbClr></a:duotone></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 图片主体保留;调整以 warning 级 advisory 记录,不阻断页面。
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({ type: 'image' });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'pptx.mapper.picture_unsupported',
        severity: 'warning',
      }),
    ]);
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
  });

  it('clips pictures to non-rect preset geometry and keeps spPr fill styling as an advisory', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 非矩形预设几何按轮廓裁剪图片填充,实色 a:ln 成为形状描边;solidFill 背景降级为 advisory。
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      geometry: { kind: 'preset', preset: 'ellipse' },
      style: {
        fill: { kind: 'image', mode: 'stretch' },
        stroke: { width: 1, fill: { kind: 'srgb', value: '#000000' } },
      },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'pptx.mapper.picture_unsupported', severity: 'warning' }),
    ]);
  });

  it('maps negative picture srcRect values as inset crops', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:srcRect l="-138" t="405" r="66467" b="-405"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'image',
      crop: { left: -0.00138, top: 0.00405, right: 0.66467, bottom: -0.00405 },
    });
  });

  it('maps custom-geometry pictures to path-clipped image fills', async () => {
    // 笔刷/撕纸遮罩图片:p:pic + a:custGeom + 上下负裁剪(位图在帧外出血)。
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Brush 1"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:srcRect t="10000" b="10000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="100" h="50"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:cubicBezTo><a:pt x="40" y="10"/><a:pt x="60" y="0"/><a:pt x="100" y="5"/></a:cubicBezTo><a:lnTo><a:pt x="90" y="50"/></a:lnTo><a:lnTo><a:pt x="0" y="45"/></a:lnTo><a:close/><a:moveTo><a:pt x="95" y="45"/></a:moveTo><a:lnTo><a:pt x="100" y="50"/></a:lnTo><a:lnTo><a:pt x="95" y="50"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    // srcRect 上下各裁 10% ⇒ 位图高 = 帧高 / 0.8,上下各出血 0.125 帧高。
    expect(element).toMatchObject({
      type: 'shape',
      name: 'Brush 1',
      geometry: { kind: 'custom', viewBox: { width: 100, height: 50 } },
      style: {
        fill: {
          kind: 'image',
          resourceId: result.document.resources.media[0]!.id,
          mode: 'stretch',
          insets: { left: 0, top: -0.125, right: 0, bottom: -0.125 },
        },
      },
    });
    expect(element?.type === 'shape' && element.geometry.kind === 'custom').toBe(true);
    if (element?.type !== 'shape' || element.geometry.kind !== 'custom') return;
    expect(element.geometry.path.match(/M/g)).toHaveLength(2);
  });

  it('keeps custom-geometry pictures as bounding-box images when the path is unsupported', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Brush 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom><a:pathLst><a:path w="100" h="50"><a:lnTo><a:pt x="100" y="50"/></a:lnTo></a:path></a:pathLst></a:custGeom></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({ type: 'image' });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'pptx.mapper.picture_unsupported', severity: 'warning' }),
    ]);
  });

  it.each([
    // 原生预设保留预设身份与调整值。
    [
      'roundRect',
      '<a:gd name="adj" fmla="val 25000"/>',
      { kind: 'preset', preset: 'roundRect', adjustments: { adj: 25000 } },
      [],
    ],
    // 无原生渲染的预设按 OOXML 标准轮廓导入(info)。
    ['heart', '', { kind: 'custom' }, ['pptx.mapper.preset_geometry_outlined']],
  ] as const)(
    'clips pictures to the %s preset geometry',
    async (preset, adjustments, geometry, codes) => {
      const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:srcRect l="25000" r="25000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="${preset}"><a:avLst>${adjustments}</a:avLst></a:prstGeom></p:spPr></p:pic>
    </p:spTree>`;
      const parsed = await parsePptx(await createPptxWithPicture(slideBody));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const result = mapPptxPresentationToReachDeckV2(parsed.ir, {
        ...mapperOptions,
        mediaUploads: {
          '/ppt/media/image1.png': {
            objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
            contentType: 'image/png',
          },
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
        type: 'shape',
        geometry,
        style: {
          fill: {
            kind: 'image',
            mode: 'stretch',
            insets: { left: -0.5, top: 0, right: -0.5, bottom: 0 },
          },
        },
      });
      expect(result.diagnostics.map((entry) => entry.code)).toEqual(codes);
    },
  );

  it('keeps pictures with an unknown preset geometry as bounding-box images', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="notARealPreset"><a:avLst/></a:prstGeom></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = mapPptxPresentationToReachDeckV2(parsed.ir, {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({ type: 'image' });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'pptx.mapper.picture_unsupported',
        severity: 'warning',
        message: expect.stringContaining('notARealPreset'),
      }),
    ]);
  });

  it('maps picture a:ln outlines onto the image element stroke', async () => {
    const slideBody = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="25400"><a:solidFill><a:srgbClr val="445566"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr></p:pic>
    </p:spTree>`;
    const parsed = await parsePptx(await createPptxWithPicture(slideBody));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const options = {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/pic.png',
          contentType: 'image/png',
        },
      },
    };

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, options);

    // 可映射的图片边框直接上元素,不再发 advisory。
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'image',
      stroke: { width: 2, fill: { kind: 'srgb', value: '#445566' }, dash: 'dash' },
    });
  });

  it('drops pictures without a storage key instead of importing dead references', async () => {
    const ir = await parsePictureIr();

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'pptx.mapper.media_object_key_missing',
    );
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(0);
    expect(result.document.resources.media).toHaveLength(0);
  });

  it('exposes referenced media part paths for caller-side uploads', async () => {
    const ir = await parsePictureIr();
    const { collectPptxReferencedMediaPartPaths } = await import('../src/pptx/index.js');
    expect(collectPptxReferencedMediaPartPaths(ir)).toEqual(['/ppt/media/image1.png']);
  });

  it('keeps a page whose style-matrix background cannot resolve and imports both pages', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    // bgRef idx=1001 points into a theme background fill this package does not
    // define: the background is lost, the page is not.
    const brokenSlide = `<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>`;
    const cleanSlide = `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>`;
    const entries: Record<string, string> = {
      '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
      '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
      'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`,
      'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${brokenSlide}</p:sld>`,
      'ppt/slides/slide2.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${cleanSlide}</p:sld>`,
    };
    for (const [name, contents] of Object.entries(entries)) {
      await writer.add(name, new TextReader(contents));
    }
    const parsed = await parsePptx(await writer.close());
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageReports.map((report) => report.status)).toEqual(['warning', 'ok']);
    expect(result.document.pages).toHaveLength(2);
    expect(result.document.pages.map((page) => page.title)).toEqual(['Slide 1', 'Slide 2']);
    expect(result.document.pages[0]!.pageId).toBe(result.pageReports[0]!.pageId);
    expect(
      result.diagnostics.some((entry) => entry.code === 'pptx.mapper.style_matrix_unsupported'),
    ).toBe(true);
  });

  it('excludes only a page whose slide part is unreadable, keeping contiguous order', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    const cleanSlide = `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld>`;
    const entries: Record<string, string> = {
      '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
      '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
      'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`,
      'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${cleanSlide}</p:sld>`,
      'ppt/slides/slide2.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${cleanSlide}</p:sld>`,
    };
    for (const [name, contents] of Object.entries(entries)) {
      await writer.add(name, new TextReader(contents));
    }
    const parsed = await parsePptx(await writer.close());
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
    // The package parses; the mapper is what has to cope with a slide whose
    // XML never made it into the inventory.
    const ir = {
      ...parsed.ir,
      parts: parsed.ir.parts.map((part) =>
        part.path === '/ppt/slides/slide1.xml' ? { ...part, xml: undefined } : part,
      ),
    };

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing exists to import for slide 1; slide 2 still lands, renumbered.
    expect(result.pageReports.map((report) => report.status)).toEqual(['error', 'ok']);
    expect(result.document.pages).toHaveLength(1);
    expect(result.document.pages[0]).toMatchObject({ order: 1, title: 'Slide 2' });
    expect(result.document.pages[0]!.pageId).toBe(result.pageReports[1]!.pageId);
  });

  it('drops foreign extension nodes with explicit warnings instead of omitting them silently', async () => {
    const ir =
      await parseIr(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="127000" cy="127000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp>
      <p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"/>
    </p:spTree>`);

    const result = mapPptxPresentationToReachDeckV2(ir, mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'pptx.mapper.unknown_xml_unsupported',
          location: expect.objectContaining({ nodePath: expect.stringContaining('p14:media') }),
        }),
        expect.objectContaining({
          code: 'pptx.mapper.unknown_node_unsupported',
        }),
      ]),
    );
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    // 可映射的矩形保留，未知节点被丢弃并留痕。
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(1);
  });
});
