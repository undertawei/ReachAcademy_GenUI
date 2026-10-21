import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import {
  analyzePptxCapabilities,
  mapPptxPresentationToReachDeckV2,
  parsePptx,
  type PptxParseSuccess,
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

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const SLIDE_ROOT_ATTRIBUTES = [
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'mc:Ignorable="p14"',
].join(' ');

const createPptx = async (slideBody: string, withImage = false): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${withImage ? '<Default Extension="png" ContentType="image/png"/>' : ''}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld ${SLIDE_ROOT_ATTRIBUTES}><p:cSld>${slideBody}</p:cSld></p:sld>`,
    ...(withImage
      ? {
          'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`,
          'ppt/media/image1.png': PNG_BYTES,
        }
      : {}),
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(
      name,
      typeof contents === 'string' ? new TextReader(contents) : new Uint8ArrayReader(contents),
    );
  }
  return writer.close();
};

const parseSlide = async (slideBody: string, withImage = false): Promise<PptxParseSuccess> => {
  const parsed = await parsePptx(await createPptx(slideBody, withImage));
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return parsed;
};

const background = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>`;

const rect = (id: number, name: string, x: number, y: number, cx: number, cy: number) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp>`;

const picture = `<p:pic><p:nvPicPr><p:cNvPr id="7" name="Image 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;

const groupTransform = `<a:xfrm><a:off x="1270000" y="635000"/><a:ext cx="2540000" cy="1270000"/><a:chOff x="1270000" y="635000"/><a:chExt cx="2540000" cy="1270000"/></a:xfrm>`;

const group = (children: string) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${groupTransform}</p:grpSpPr>${children}</p:grpSp>`;

const P14_NAMESPACE = 'http://schemas.microsoft.com/office/powerpoint/2010/main';

const choice = (requires: string, content: string, namespaces = `xmlns:p14="${P14_NAMESPACE}"`) =>
  `<mc:Choice ${namespaces} Requires="${requires}">${content}</mc:Choice>`;

const alternateContent = (branches: string) =>
  `<mc:AlternateContent>${branches}</mc:AlternateContent>`;

const spTree = (content: string) =>
  `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${content}</p:spTree>`;

describe('mc:AlternateContent markup-compatibility expansion', () => {
  it.each([
    ['\u2322', true],
    ['\u2323', false],
  ] as const)(
    'selects native circular-arc math only when the accent %s is supported',
    async (character, native) => {
      const equation = rect(20, 'Arc equation', 0, 0, 1270000, 635000).replace(
        '</p:sp>',
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a14:m><m:oMath><m:acc><m:accPr><m:chr m:val="' +
          character +
          '"/></m:accPr><m:e><m:r><m:t>AB</m:t></m:r></m:e></m:acc></m:oMath></a14:m></a:p></p:txBody></p:sp>',
      );
      const namespaces =
        'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
      const parsed = await parseSlide(
        spTree(
          alternateContent(
            choice('a14', equation, namespaces) + `<mc:Fallback>${picture}</mc:Fallback>`,
          ),
        ),
        true,
      );
      expect(parsed.diagnostics.map((d) => d.code)).toEqual(
        native ? [] : ['pptx.mce.fallback_applied'],
      );
      const result = mapPptxPresentationToReachDeckV2(parsed.ir, {
        ...mapperOptions,
        mediaUploads: {
          '/ppt/media/image1.png': {
            objectKey: 'uploads/org/reach-deck/mv/image/arc.png',
            contentType: 'image/png',
          },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.diagnostics).toEqual([]);
      const elements = result.document.nativeSlides[0]?.slide.elements;
      expect(elements).toHaveLength(1);
      if (native) {
        expect(elements?.[0]).toMatchObject({
          type: 'shape',
          name: 'Arc equation',
          text: {
            doc: {
              content: [
                { content: [{ type: 'inlineMath', attrs: { latex: '\\overset{\\frown}{AB}' } }] },
              ],
            },
          },
        });
        expect(result.document.resources.media).toHaveLength(0);
      } else {
        expect(elements?.[0]).toMatchObject({ type: 'image', name: 'Image 1' });
        expect(result.document.resources.media).toHaveLength(1);
      }
    },
  );
  it('maps the mc:Fallback shape when every mc:Choice requires unsupported extensions', async () => {
    const slide = spTree(
      alternateContent(
        choice('p14', rect(20, 'Extension shape', 0, 0, 1270000, 635000)) +
          `<mc:Fallback>${rect(21, 'Fallback shape', 1270000, 635000, 1270000, 635000)}</mc:Fallback>`,
      ),
    );
    const parsed = await parseSlide(slide);

    expect(parsed.diagnostics).toMatchObject([
      {
        code: 'pptx.mce.fallback_applied',
        severity: 'info',
        location: {
          partPath: '/ppt/slides/slide1.xml',
          nodePath: '/p:sld[1]/p:cSld[1]/p:spTree[1]/mc:AlternateContent[1]',
        },
        details: { requiredNamespaces: [P14_NAMESPACE] },
      },
    ]);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageReports[0]).toMatchObject({ status: 'ok' });
    expect(result.document.nativeSlides[0]?.slide.elements).toMatchObject([
      {
        type: 'shape',
        name: 'Fallback shape',
        transform: { x: 100, y: 50, width: 100, height: 50 },
      },
    ]);
  });

  it('selects the first mc:Choice whose Requires namespaces are all understood', async () => {
    const slide = spTree(
      alternateContent(
        choice('p14', rect(20, 'Extension shape', 0, 0, 1270000, 635000)) +
          choice('a', rect(21, 'Native choice shape', 0, 0, 1270000, 635000), '') +
          `<mc:Fallback>${rect(22, 'Fallback shape', 0, 0, 1270000, 635000)}</mc:Fallback>`,
      ),
    );
    const parsed = await parseSlide(slide);

    expect(parsed.diagnostics).toEqual([]);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements).toMatchObject([
      { type: 'shape', name: 'Native choice shape' },
    ]);
  });

  it('recursively expands nested mc:AlternateContent inside a chosen mc:Fallback', async () => {
    const nested = alternateContent(
      choice('p14', rect(30, 'Nested extension', 0, 0, 1270000, 635000)) +
        `<mc:Fallback>${rect(31, 'Deep fallback shape', 0, 0, 1270000, 635000)}</mc:Fallback>`,
    );
    const slide = spTree(
      alternateContent(
        choice('p14', rect(20, 'Extension shape', 0, 0, 1270000, 635000)) +
          `<mc:Fallback>${nested}</mc:Fallback>`,
      ),
    );
    const parsed = await parseSlide(slide);

    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'pptx.mce.fallback_applied',
      'pptx.mce.fallback_applied',
    ]);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements).toMatchObject([
      { type: 'shape', name: 'Deep fallback shape' },
    ]);
  });

  it('keeps unsupported diagnostics when no branch applies (no mc:Fallback)', async () => {
    const slide = spTree(
      rect(2, 'Kept shape', 0, 0, 1270000, 635000) +
        alternateContent(choice('p14', `<p14:extShape xmlns:p14="${P14_NAMESPACE}"/>`)),
    );
    const parsed = await parseSlide(slide);

    expect(parsed.diagnostics).toEqual([]);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'pptx.mapper.unknown_node_unsupported',
    );
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    expect(result.document.nativeSlides[0]?.slide.elements).toMatchObject([
      { type: 'shape', name: 'Kept shape' },
    ]);

    const report = analyzePptxCapabilities(parsed.ir);
    expect(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.feature === 'unknown-ooxml' &&
          diagnostic.message.includes('mc:AlternateContent'),
      ),
    ).toBe(true);
  });

  it('maps an mc:Fallback picture through the existing picture pipeline', async () => {
    const slide = spTree(
      alternateContent(
        choice('p14', rect(20, 'Extension shape', 0, 0, 1270000, 635000)) +
          `<mc:Fallback>${picture}</mc:Fallback>`,
      ),
    );
    const parsed = await parseSlide(slide, true);

    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'pptx.mce.fallback_applied',
    ]);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/abc.png',
          contentType: 'image/png',
        },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements).toMatchObject([
      { type: 'image', name: 'Image 1' },
    ]);
    expect(result.document.resources.media).toHaveLength(1);
  });

  it('maps an mc:Fallback group through the existing group pipeline', async () => {
    const slide = spTree(
      alternateContent(
        choice('p14', rect(20, 'Extension shape', 0, 0, 1270000, 635000)) +
          `<mc:Fallback>${group(rect(11, 'Grouped shape', 1270000, 635000, 1270000, 635000))}</mc:Fallback>`,
      ),
    );
    const parsed = await parseSlide(slide);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements).toMatchObject([
      {
        type: 'group',
        name: 'Group 1',
        transform: { x: 100, y: 50, width: 200, height: 100 },
        children: [{ type: 'shape', name: 'Grouped shape' }],
      },
    ]);
  });

  it('expands mc:AlternateContent nested inside a p:grpSp child list', async () => {
    const slide = spTree(
      group(
        alternateContent(
          choice('p14', rect(20, 'Extension shape', 0, 0, 1270000, 635000)) +
            `<mc:Fallback>${rect(11, 'Grouped fallback', 1270000, 635000, 1270000, 635000)}</mc:Fallback>`,
        ),
      ),
    );
    const parsed = await parseSlide(slide);

    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'pptx.mce.fallback_applied',
    ]);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements).toMatchObject([
      {
        type: 'group',
        children: [{ type: 'shape', name: 'Grouped fallback' }],
      },
    ]);
  });
});
