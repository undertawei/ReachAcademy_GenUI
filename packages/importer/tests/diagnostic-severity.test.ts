import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import {
  dedupePptxDiagnostics,
  mapPptxPresentationToReachDeckV2,
  parsePptx,
  type PptxDiagnostic,
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
  applicationId: 'pptx-severity-1',
  title: 'Imported lesson',
  language: 'zh-CN',
  generatedAt: '2026-08-01T00:00:00.000Z',
  compatibilityTheme,
} as const;

const createPptx = async (slideXml: string): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': slideXml,
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(name, new TextReader(contents));
  }
  return writer.close();
};

const background = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>`;

/** One rectangle so the page always has a mappable element. */
const rect = (extra = '', shapeExtra = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Rect"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill>${shapeExtra}</p:spPr>${extra}</p:sp>`;

const slide = (body: string, rootAttributes = '', afterCommonSlideData = '') =>
  `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"${rootAttributes}><p:cSld>${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${body}</p:spTree></p:cSld>${afterCommonSlideData}</p:sld>`;

const parseIr = async (slideXml: string): Promise<PptxPresentationIR> => {
  const parsed = await parsePptx(await createPptx(slideXml));
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return parsed.ir;
};

const mapSlide = async (slideXml: string) => {
  const result = mapPptxPresentationToReachDeckV2(await parseIr(slideXml), mapperOptions);
  if (!result.ok) throw new Error(`mapping failed: ${result.diagnostics[0]?.message}`);
  return result;
};

const findDiagnostic = (
  diagnostics: readonly PptxDiagnostic[],
  predicate: (diagnostic: PptxDiagnostic) => boolean,
): PptxDiagnostic | undefined => diagnostics.find(predicate);

describe('PPTX mapper diagnostic severity contract', () => {
  it('reports dropped animation timelines as info and keeps the page ok', async () => {
    const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>`;
    const result = await mapSlide(slide(rect(), '', timing));

    const timingDiagnostics = result.diagnostics.filter((diagnostic) =>
      diagnostic.message.includes('p:timing'),
    );
    expect(timingDiagnostics.length).toBeGreaterThan(0);
    expect(timingDiagnostics.every((diagnostic) => diagnostic.severity === 'info')).toBe(true);
    // Nothing visible was lost, so the page stays clean.
    expect(result.pageReports[0]?.status).toBe('ok');
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(1);
  });

  it('accepts bullet and underline "follow text" markers without any diagnostic', async () => {
    const text = `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:buFontTx/><a:buSzTx/><a:buClrTx/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="1800"><a:uFillTx/><a:latin typeface="Noto Sans"/></a:rPr><a:t>正文</a:t></a:r></a:p></p:txBody>`;
    const result = await mapSlide(slide(rect(text)));

    expect(result.diagnostics).toEqual([]);
    expect(result.pageReports[0]?.status).toBe('ok');
  });

  it('keeps a stroke whose dash pattern has no native equivalent, as a warning', async () => {
    const line = `<a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="lgDashDot"/></a:ln>`;
    const result = await mapSlide(slide(rect('', line)));

    const diagnostic = findDiagnostic(
      result.diagnostics,
      (entry) => entry.code === 'pptx.mapper.stroke_simplified',
    );
    expect(diagnostic?.severity).toBe('warning');
    // The shape survives with an approximated dash instead of being dropped.
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      style: { stroke: { dash: 'longDash' } },
    });
  });

  it('keeps a paragraph whose alignment has no contract equivalent, as a warning', async () => {
    const text = `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="dist"/><a:r><a:rPr lang="zh-CN" sz="1800"><a:latin typeface="Noto Sans"/></a:rPr><a:t>分散对齐</a:t></a:r></a:p></p:txBody>`;
    const result = await mapSlide(slide(rect(text)));

    const diagnostic = findDiagnostic(
      result.diagnostics,
      (entry) => entry.code === 'pptx.mapper.text_simplified',
    );
    expect(diagnostic?.severity).toBe('warning');
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      text: { doc: { type: 'doc' } },
    });
  });

  it('keeps a paragraph whose tab stops cannot be represented, as a warning', async () => {
    const text = `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:tabLst><a:tab pos="914400" algn="l"/></a:tabLst></a:pPr><a:r><a:rPr lang="zh-CN" sz="1800"><a:latin typeface="Noto Sans"/></a:rPr><a:t>制表位正文</a:t></a:r></a:p></p:txBody>`;
    const result = await mapSlide(slide(rect(text)));

    const diagnostic = findDiagnostic(
      result.diagnostics,
      (entry) =>
        entry.code === 'pptx.mapper.text_simplified' && entry.message.includes('tab stops'),
    );
    expect(diagnostic?.severity).toBe('warning');
    // The words survive: only their tab alignment is gone.
    expect(JSON.stringify(result.document.nativeSlides[0]?.slide.elements[0])).toContain(
      '制表位正文',
    );
  });

  it('reports a dropped hyperlink as a warning and keeps the shape', async () => {
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Rect"><a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp>`;
    const result = await mapSlide(slide(body));

    const diagnostic = findDiagnostic(result.diagnostics, (entry) =>
      entry.message.includes('a:hlinkClick'),
    );
    expect(diagnostic?.severity).toBe('warning');
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(1);
  });

  it('still reports genuinely lost content as an error', async () => {
    // A text rectangle covering half the shape would relayout the text, so the
    // freeform is dropped rather than imported with the wrong text box.
    const geometry = `<a:custGeom><a:gdLst><a:gd name="g0" fmla="*/ w 1 2"/></a:gdLst><a:rect l="l" t="t" r="g0" b="b"/><a:pathLst><a:path w="1270000" h="635000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1270000" y="635000"/></a:lnTo></a:path></a:pathLst></a:custGeom>`;
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Freeform"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm>${geometry}<a:noFill/></p:spPr></p:sp>${rect()}`;
    const result = await mapSlide(slide(body));

    const diagnostic = findDiagnostic(
      result.diagnostics,
      (entry) => entry.code === 'pptx.mapper.custom_geometry_unsupported',
    );
    expect(diagnostic?.severity).toBe('error');
    // The freeform is missing from the candidate; only the rectangle survives.
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(1);
    expect(result.pageReports[0]?.status).toBe('warning');
  });

  it('outlines a preset without a native renderer instead of dropping the shape', async () => {
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Callout"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="homePlate"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp>`;
    const result = await mapSlide(slide(body));

    const diagnostic = findDiagnostic(
      result.diagnostics,
      (entry) => entry.code === 'pptx.mapper.preset_geometry_outlined',
    );
    // Nothing is lost but the preset identity, so the page stays clean.
    expect(diagnostic?.severity).toBe('info');
    expect(result.pageReports[0]?.status).toBe('ok');
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      geometry: {
        kind: 'custom',
        viewBox: { width: 100, height: 50 },
        path: 'M 0 0 L 75 0 L 100 25 L 75 50 L 0 50 Z',
      },
    });
  });

  it('keeps stroke-only and fill-only subpaths of a preset apart', async () => {
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Arc"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="arc"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln></p:spPr></p:sp>`;
    const result = await mapSlide(slide(body));

    const geometry = result.document.nativeSlides[0]?.slide.elements[0];
    expect(geometry).toMatchObject({
      geometry: {
        kind: 'custom',
        // The standard paints the pie wedge without a stroke and the arc itself
        // without a fill; one path could only do one of the two.
        subpaths: [{ stroked: false }, { fillMode: 'none' }],
      },
    });
  });

  it('resolves a:grpFill against the enclosing group instead of blocking', async () => {
    const child = `<p:sp><p:nvSpPr><p:cNvPr id="12" name="Child"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:grpFill/></p:spPr></p:sp>`;
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="635000"/></a:xfrm><a:solidFill><a:srgbClr val="AABBCC"/></a:solidFill></p:grpSpPr>${child}</p:grpSp>`;
    const result = await mapSlide(slide(group));

    expect(result.diagnostics).toEqual([]);
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'group',
      children: [
        { type: 'shape', style: { fill: { kind: 'solid', color: { value: '#AABBCC' } } } },
      ],
    });
  });

  it('imports an scRGB color instead of rejecting the element', async () => {
    // 50% linear light encodes to sRGB 188 (0xBC).
    const fill = `<a:solidFill><a:scrgbClr r="50000" g="50000" b="50000"/></a:solidFill>`;
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Rect"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}</p:spPr></p:sp>`;
    const result = await mapSlide(slide(body));

    expect(result.diagnostics).toEqual([]);
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#BCBCBC' } } },
    });
  });
});

describe('dedupePptxDiagnostics', () => {
  const inherited = (slideId: string): PptxDiagnostic => ({
    code: 'pptx.mapper.picture_unsupported',
    severity: 'warning',
    feature: 'image',
    message: 'Picture color/effect adjustments (a:duotone) are dropped.',
    location: { partPath: '/ppt/slideMasters/slideMaster1.xml', slideId, nodePath: '/p:sp[1]' },
  });

  it('collapses one master decoration reported once per derived page', () => {
    const deduped = dedupePptxDiagnostics([inherited('256'), inherited('257'), inherited('258')]);

    expect(deduped).toHaveLength(1);
    // Merging across slides drops the slide id: the finding belongs to the master.
    expect(deduped[0]?.location).toEqual({
      partPath: '/ppt/slideMasters/slideMaster1.xml',
      nodePath: '/p:sp[1]',
    });
  });

  it('keeps a single-page occurrence addressed to its slide', () => {
    const deduped = dedupePptxDiagnostics([inherited('256')]);

    expect(deduped).toEqual([inherited('256')]);
  });

  it('keeps distinct findings that differ only by node path', () => {
    const other = {
      ...inherited('256'),
      location: { ...inherited('256').location!, nodePath: '/p:sp[2]' },
    };

    expect(dedupePptxDiagnostics([inherited('256'), other])).toHaveLength(2);
  });
});
