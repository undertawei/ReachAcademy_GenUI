import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import {
  analyzePptxCapabilities,
  collectPptxReferencedMediaPartPaths,
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

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="T"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FEFEFE"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4874CB"/></a:accent1><a:accent2><a:srgbClr val="EE822F"/></a:accent2><a:accent3><a:srgbClr val="F2BA02"/></a:accent3><a:accent4><a:srgbClr val="75BD42"/></a:accent4><a:accent5><a:srgbClr val="30C0B4"/></a:accent5><a:accent6><a:srgbClr val="E54C5E"/></a:accent6><a:hlink><a:srgbClr val="0026E5"/></a:hlink><a:folHlink><a:srgbClr val="7E1FAD"/></a:folHlink></a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="T"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const CLR_MAP = `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`;

const rect = (id: number, name: string, x: number, y: number, cx: number, cy: number): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp>`;

/** Placeholder shape: must inherit via the placeholder chain, never materialize. */
const MASTER_TITLE_PLACEHOLDER = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface DecorationPackageOptions {
  /** Extra spTree children on the master, after the title placeholder. */
  masterExtra?: string;
  /** Extra spTree children on the layout. */
  layoutExtra?: string;
  /** Attributes appended to each p:sld root (e.g. ` showMasterSp="0"`). */
  slideAttributes?: string;
  /** Attributes appended to the p:sldLayout root. */
  layoutAttributes?: string;
  /** Number of slides sharing the same layout. */
  slideCount?: number;
  /** Adds /ppt/media/image1.png wired through the master's .rels as rId10. */
  masterImage?: boolean;
}

const createDecoratedPptx = async (options: DecorationPackageOptions): Promise<Uint8Array> => {
  const slideCount = options.slideCount ?? 1;
  const slideOverrides = Array.from({ length: slideCount }, (_, index) => index + 1);
  const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${slideOverrides
    .map(
      (index) =>
        `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join(
      '',
    )}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`;
  const slideBody = (index: number): string =>
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"${options.slideAttributes ?? ''}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${rect(
      10 + index,
      `Slide shape ${index}`,
      2540000,
      2540000,
      1270000,
      635000,
    )}</p:spTree></p:cSld></p:sld>`;
  const entries: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideOverrides
      .map((index) => `<p:sldId id="${255 + index}" r:id="rId${index + 1}"/>`)
      .join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideOverrides
      .map(
        (index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index}.xml"/>`,
      )
      .join('')}</Relationships>`,
    'ppt/theme/theme1.xml': THEME,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${MASTER_TITLE_PLACEHOLDER}${
      options.masterExtra ?? ''
    }</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>${
      options.masterImage
        ? `<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>`
        : ''
    }</Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"${
      options.layoutAttributes ?? ''
    }><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${
      options.layoutExtra ?? ''
    }</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  };
  for (const index of slideOverrides) {
    entries[`ppt/slides/slide${index}.xml`] = slideBody(index);
    entries[`ppt/slides/_rels/slide${index}.xml.rels`] =
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
  }
  if (options.masterImage) entries['ppt/media/image1.png'] = PNG_BYTES;
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(
      name,
      typeof contents === 'string' ? new TextReader(contents) : new Uint8ArrayReader(contents),
    );
  }
  return writer.close();
};

const parseDecorated = async (options: DecorationPackageOptions): Promise<PptxParseSuccess> => {
  const parsed = await parsePptx(await createDecoratedPptx(options));
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return parsed;
};

const MASTER_RECT = rect(20, 'Master decoration', 0, 0, 1270000, 635000);
const LAYOUT_RECT = rect(30, 'Layout decoration', 1270000, 0, 1270000, 635000);

describe('master/layout decoration materialization', () => {
  it('materializes master and layout decorations below slide content in z-order', async () => {
    const parsed = await parseDecorated({ masterExtra: MASTER_RECT, layoutExtra: LAYOUT_RECT });

    const first = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);
    const second = mapPptxPresentationToReachDeckV2(structuredClone(parsed.ir), mapperOptions);

    expect(first).toEqual(second);
    expect(first.diagnostics).toEqual([]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const elements = first.document.nativeSlides[0]!.slide.elements;
    // master (bottom) → layout → slide's own shape (top); the master title
    // placeholder is not materialized.
    expect(elements).toMatchObject([
      {
        type: 'shape',
        name: 'Master decoration',
        zIndex: 1,
        transform: { x: 0, y: 0, width: 100, height: 50 },
        source: { partPath: '/ppt/slideMasters/slideMaster1.xml', sourceId: '20' },
      },
      {
        type: 'shape',
        name: 'Layout decoration',
        zIndex: 2,
        transform: { x: 100, y: 0, width: 100, height: 50 },
        source: { partPath: '/ppt/slideLayouts/slideLayout1.xml', sourceId: '30' },
      },
      {
        type: 'shape',
        name: 'Slide shape 1',
        zIndex: 3,
        source: { partPath: '/ppt/slides/slide1.xml' },
      },
    ]);
    expect(first.pageReports[0]).toMatchObject({ status: 'ok' });
  });

  it('skips master and layout decorations when the slide sets showMasterSp="0"', async () => {
    const parsed = await parseDecorated({
      masterExtra: MASTER_RECT,
      layoutExtra: LAYOUT_RECT,
      slideAttributes: ' showMasterSp="0"',
    });

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]!.slide.elements).toMatchObject([
      { type: 'shape', name: 'Slide shape 1', zIndex: 1 },
    ]);
  });

  it('skips only the master layer when the layout sets showMasterSp="0"', async () => {
    const parsed = await parseDecorated({
      masterExtra: MASTER_RECT,
      layoutExtra: LAYOUT_RECT,
      layoutAttributes: ' showMasterSp="0"',
    });

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]!.slide.elements).toMatchObject([
      { type: 'shape', name: 'Layout decoration', zIndex: 1 },
      { type: 'shape', name: 'Slide shape 1', zIndex: 2 },
    ]);
  });

  it('resolves master picture media through the master .rels and reports it for upload', async () => {
    const masterPicture = `<p:pic><p:nvPicPr><p:cNvPr id="21" name="Master logo" descr="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId10"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    const parsed = await parseDecorated({ masterExtra: masterPicture, masterImage: true });

    expect(collectPptxReferencedMediaPartPaths(parsed.ir)).toEqual(['/ppt/media/image1.png']);

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, {
      ...mapperOptions,
      mediaUploads: {
        '/ppt/media/image1.png': {
          objectKey: 'uploads/org/reach-deck/mv/image/logo.png',
          contentType: 'image/png',
        },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const image = result.document.nativeSlides[0]!.slide.elements[0]!;
    expect(image).toMatchObject({
      type: 'image',
      name: 'Master logo',
      zIndex: 1,
      source: { partPath: '/ppt/slideMasters/slideMaster1.xml', sourceId: '21' },
    });
    expect(result.document.resources.media).toHaveLength(1);
    expect(result.document.resources.media[0]).toMatchObject({
      objectKey: 'uploads/org/reach-deck/mv/image/logo.png',
      contentType: 'image/png',
    });
  });

  it('retains an unresolved chart decoration with a master-located warning', async () => {
    const graphicFrame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="22" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`;
    const parsed = await parseDecorated({ masterExtra: graphicFrame + MASTER_RECT });

    const result = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'pptx.mapper.chart_unsupported',
        feature: 'chart',
        severity: 'warning',
        location: expect.objectContaining({
          partPath: '/ppt/slideMasters/slideMaster1.xml',
          nodePath: expect.stringContaining('p:graphicFrame[1]'),
        }),
      }),
    );
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    // 图表占位、其余装饰物与页面自身内容都照常保留。
    expect(result.document.nativeSlides[0]!.slide.elements).toMatchObject([
      { type: 'chart', chartType: 'unsupported', sourceChartType: 'unresolved-chart' },
      { type: 'shape', name: 'Master decoration' },
      { type: 'shape', name: 'Slide shape 1' },
    ]);
  });

  it('gives one shared decoration a distinct deterministic element id per page', async () => {
    const parsed = await parseDecorated({
      masterExtra: MASTER_RECT,
      layoutExtra: LAYOUT_RECT,
      slideCount: 2,
    });

    const first = mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);
    const second = mapPptxPresentationToReachDeckV2(structuredClone(parsed.ir), mapperOptions);

    expect(first).toEqual(second);
    expect(first.diagnostics).toEqual([]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.document.nativeSlides).toHaveLength(2);
    const allIds = first.document.nativeSlides.flatMap((binding) =>
      binding.slide.elements.map((element) => element.id),
    );
    expect(new Set(allIds).size).toBe(allIds.length);
    // Both pages render the same decorations at the same coordinates.
    for (const binding of first.document.nativeSlides) {
      expect(binding.slide.elements.slice(0, 2)).toMatchObject([
        { name: 'Master decoration' },
        { name: 'Layout decoration' },
      ]);
    }
  });

  it('reports master/layout parts as native capabilities', async () => {
    const parsed = await parseDecorated({ masterExtra: MASTER_RECT, layoutExtra: LAYOUT_RECT });

    const report = analyzePptxCapabilities(parsed.ir);

    expect(report.entries).toContainEqual({ feature: 'master', status: 'native' });
    expect(report.entries).toContainEqual({ feature: 'layout', status: 'native' });
    expect(
      report.diagnostics.some(
        (diagnostic) => diagnostic.feature === 'master' || diagnostic.feature === 'layout',
      ),
    ).toBe(false);
  });
});
