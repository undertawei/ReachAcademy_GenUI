import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import { mapPptxPresentationToReachDeckV2, parsePptx } from '../src/pptx/index.js';

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

/** Minimal but realistic package: theme + master + layout + placeholder slide. */
const createThemedPptx = async (slideBody: string): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/theme/theme1.xml': `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="T"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FEFEFE"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4874CB"/></a:accent1><a:accent2><a:srgbClr val="EE822F"/></a:accent2><a:accent3><a:srgbClr val="F2BA02"/></a:accent3><a:accent4><a:srgbClr val="75BD42"/></a:accent4><a:accent5><a:srgbClr val="30C0B4"/></a:accent5><a:accent6><a:srgbClr val="E54C5E"/></a:accent6><a:hlink><a:srgbClr val="0026E5"/></a:hlink><a:folHlink><a:srgbClr val="7E1FAD"/></a:folHlink></a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="微软雅黑"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="微软雅黑"/></a:minorFont></a:fontScheme><a:fmtScheme name="T"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="title"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1524000" y="1122363"/><a:ext cx="9144000" cy="2387600"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${slideBody}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(name, new TextReader(contents));
  }
  return writer.close();
};

const mapThemed = async (slideBody: string) => {
  const parsed = await parsePptx(await createThemedPptx(slideBody));
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);
};

describe('themed placeholder inheritance mapping', () => {
  it('inherits transform, style-chain typography and theme colors for placeholders', async () => {
    const result = await mapThemed(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" altLang="en-US"/><a:t>这是标题</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const slide = result.document.nativeSlides[0]!.slide;
    // bgRef 1001 -> bgFillStyleLst[0] solid phClr -> scheme bg1 -> lt1 #FEFEFE.
    expect(slide.background).toEqual({
      kind: 'solid',
      color: { kind: 'srgb', value: '#FEFEFE' },
    });
    const title = slide.elements[0]!;
    expect(title).toMatchObject({
      type: 'shape',
      // Layout ctrTitle placeholder transform, in points.
      transform: { x: 120, y: 88.375039, width: 720, height: 188 },
      text: {
        verticalAlignment: 'bottom',
        doc: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { textAlign: 'center' },
              content: [
                {
                  type: 'text',
                  text: '这是标题',
                  marks: [
                    {
                      type: 'textStyle',
                      attrs: {
                        // Layout lstStyle sz=6000 overrides master titleStyle 4400;
                        // zh-CN resolves the theme Hans supplemental font, which
                        // the platform catalog constrains to the bundled family.
                        fontFamily: 'Source Han Sans VF',
                        fontSize: '60px',
                        color: '#111111',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        fontSubstitutions: [
          {
            requestedFamily: '微软雅黑',
            resolvedFamily: 'Source Han Sans VF',
            reason: 'configured-substitute',
          },
        ],
      },
    });
  });

  it('resolves p:style fillRef/lnRef through the theme style matrix', async () => {
    const result = await mapThemed(
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="矩形 3"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1098507" y="2798432"/><a:ext cx="1859485" cy="1515818"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="15000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shape = result.document.nativeSlides[0]!.slide.elements[0]!;
    expect(shape).toMatchObject({
      type: 'shape',
      geometry: { kind: 'preset', preset: 'rect' },
      style: {
        // fillRef idx=1 -> fillStyleLst[0] solid phClr -> accent1.
        fill: { kind: 'solid', color: { kind: 'srgb', value: '#4874CB' } },
        // lnRef idx=2 -> lnStyleLst[1] w=19050 EMU = 1.5pt, phClr shaded accent1.
        stroke: { width: 1.5 },
      },
    });
    if (shape.type !== 'shape' || shape.style.stroke === undefined) return;
    expect(shape.style.stroke.fill.kind).toBe('srgb');
    if (shape.style.stroke.fill.kind !== 'srgb') return;
    expect(shape.style.stroke.fill.value < '#4874CB').toBe(true);
  });

  it('maps straight connectors with theme stroke and arrow markers', async () => {
    const result = await mapThemed(
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="连接符 6"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="3117552" y="3553272"/><a:ext cx="1472859" cy="0"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln><a:tailEnd type="triangle"/></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:cxnSp>`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.document.nativeSlides[0]!.slide.elements[0]!;
    expect(line).toMatchObject({
      type: 'line',
      routing: 'straight',
      connector: true,
      end: { marker: 'triangle' },
      stroke: { width: 1, fill: { kind: 'srgb', value: '#4874CB' } },
    });
  });

  it('maps bent connectors to elbow lines with the bend fraction', async () => {
    // bentConnector2 (corner elbow, no adj) with flipV: the corner sits at
    // (end.x, start.y) in the flipped endpoint space.
    const corner = await mapThemed(
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="肘形 1"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm flipV="1"><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="bentConnector2"><a:avLst/></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="B52121"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`,
    );
    expect(corner.diagnostics).toEqual([]);
    expect(corner.ok).toBe(true);
    if (!corner.ok) return;
    expect(corner.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
      type: 'line',
      routing: 'elbow',
      bend: 1,
      connector: true,
      start: { x: 0, y: 50 },
      end: { x: 100, y: 0 },
      stroke: { fill: { kind: 'srgb', value: '#B52121' } },
    });

    // bentConnector3 carries the vertical-segment position as adj1.
    const threeSegment = await mapThemed(
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="8" name="肘形 2"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm rot="5400000"><a:off x="181831" y="1039988"/><a:ext cx="1440433" cy="895563"/></a:xfrm><a:prstGeom prst="bentConnector3"><a:avLst><a:gd name="adj1" fmla="val 626"/></a:avLst></a:prstGeom><a:ln><a:solidFill><a:srgbClr val="B52121"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`,
    );
    expect(threeSegment.diagnostics).toEqual([]);
    expect(threeSegment.ok).toBe(true);
    if (!threeSegment.ok) return;
    expect(threeSegment.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
      type: 'line',
      routing: 'elbow',
      bend: 0.00626,
      transform: { rotation: 90 },
    });
  });

  it('maps p:sp preset line geometry to a native line honouring flips', async () => {
    const result = await mapThemed(
      `<p:sp><p:nvSpPr><p:cNvPr id="8" name="直线 7"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm flipV="1"><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="19050"><a:solidFill><a:srgbClr val="335577"/></a:solidFill></a:ln></p:spPr></p:sp>`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.document.nativeSlides[0]!.slide.elements[0]!;
    expect(line).toMatchObject({
      type: 'line',
      routing: 'straight',
      connector: false,
      transform: { x: 72, y: 72, width: 144, height: 72 },
      // flipV 交换纵向端点:线从左下画到右上。
      start: { x: 0, y: 72 },
      end: { x: 144, y: 0 },
      stroke: { width: 1.5, fill: { kind: 'srgb', value: '#335577' } },
    });
  });

  it('maps p:sp preset line with theme lnRef stroke and arrow marker', async () => {
    const result = await mapThemed(
      `<p:sp><p:nvSpPr><p:cNvPr id="9" name="直线 8"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln><a:tailEnd type="triangle"/></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style></p:sp>`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.document.nativeSlides[0]!.slide.elements[0]!;
    expect(line).toMatchObject({
      type: 'line',
      connector: false,
      end: { marker: 'triangle' },
      stroke: { width: 1, fill: { kind: 'srgb', value: '#4874CB' } },
    });
  });

  it('retains unresolved chart frames with page warnings instead of silence', async () => {
    const result = await mapThemed(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'pptx.mapper.chart_unsupported',
        feature: 'chart',
        severity: 'warning',
      }),
    );
    expect(result.pageReports.map((report) => report.status)).toContain('warning');
    expect(
      result.document.nativeSlides.flatMap((binding) => binding.slide.elements),
    ).toContainEqual(
      expect.objectContaining({
        type: 'chart',
        chartType: 'unsupported',
        sourceChartType: 'unresolved-chart',
      }),
    );
  });
});
