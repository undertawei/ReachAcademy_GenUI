import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import {
  collectPptxReferencedMediaPartPaths,
  mapPptxPresentationToReachDeckV2,
  parsePptx,
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

const STYLE_ID = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';

// Medium Style 2 - Accent 1 缩减版:wholeTbl 全边框 lt1 + accent1 20% 底色,
// band1H 40% 底色,firstRow accent1 底 + 白色加粗文字(tcTxStyle)。
const tableStylesXml = `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="${STYLE_ID}"><a:tblStyle styleId="${STYLE_ID}" styleName="Medium 2 - Accent 1"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:left><a:right><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:right><a:top><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:top><a:bottom><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:bottom><a:insideH><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:insideH><a:insideV><a:ln w="12700" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:insideV></a:tcBdr><a:fill><a:solidFill><a:srgbClr val="DCE6F6"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl><a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:srgbClr val="B8CCEC"/></a:solidFill></a:fill></a:tcStyle></a:band1H><a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H><a:firstRow><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:bottom><a:ln w="38100" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:bottom></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow></a:tblStyle></a:tblStyleLst>`;

/** Themed package (theme + master + layout) with ppt/tableStyles.xml. */
const createTablePptx = async (slideBody: string): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/></Relationships>`,
    'ppt/tableStyles.xml': tableStylesXml,
    'ppt/theme/theme1.xml': `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="T"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FEFEFE"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4874CB"/></a:accent1><a:accent2><a:srgbClr val="EE822F"/></a:accent2><a:accent3><a:srgbClr val="F2BA02"/></a:accent3><a:accent4><a:srgbClr val="75BD42"/></a:accent4><a:accent5><a:srgbClr val="30C0B4"/></a:accent5><a:accent6><a:srgbClr val="E54C5E"/></a:accent6><a:hlink><a:srgbClr val="0026E5"/></a:hlink><a:folHlink><a:srgbClr val="7E1FAD"/></a:folHlink></a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="T"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${slideBody}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`,
    'ppt/media/image1.png': 'PNG',
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(name, new TextReader(contents));
  }
  return writer.close();
};

const mapTablePptx = async (slideBody: string) => {
  const parsed = await parsePptx(await createTablePptx(slideBody));
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);
};

const cellText = (text: string, runProps = '') =>
  `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="1800"${runProps === '' ? '/>' : `>${runProps}</a:rPr>`}<a:t>${text}</a:t></a:r></a:p></a:txBody>`;

const tableFrame = (tbl: string) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table 4"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="914400"/><a:ext cx="2540000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tbl}</a:graphicData></a:graphic></p:graphicFrame>`;

describe('table graphicFrame mapping to native v2 tables', () => {
  it('maps grids, style-layer fills/borders and explicit overrides into a table element', async () => {
    const tbl = `<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${STYLE_ID}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="1270000"/><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="1800"/><a:t>案例</a:t></a:r></a:p></a:txBody><a:tcPr vert="horz" anchor="ctr"/></a:tc><a:tc>${cellText('判断')}<a:tcPr/></a:tc></a:tr><a:tr h="635000"><a:tc gridSpan="2">${cellText('内容', '<a:solidFill><a:srgbClr val="335577"/></a:solidFill>')}<a:tcPr><a:solidFill><a:srgbClr val="FFEE00"/></a:solidFill></a:tcPr></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>`;

    const result = await mapTablePptx(tableFrame(tbl));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'table',
      transform: { x: 72, y: 72, width: 200, height: 100 },
      columnWidths: [100, 100],
      rowHeights: [50, 50],
    });
    if (element?.type !== 'table') throw new Error('Expected a table element.');
    expect(element.rows).toHaveLength(2);
    const [header, body] = element.rows;
    expect(header!.cells).toHaveLength(2);
    // firstRow 层:accent1 底色 + 统一 1pt lt1 边框(多数边 12700 EMU)。
    expect(header!.cells[0]).toMatchObject({
      rowSpan: 1,
      columnSpan: 1,
      style: {
        fill: { kind: 'solid', color: { kind: 'srgb', value: '#4874CB' } },
        stroke: { width: 1, fill: { kind: 'srgb', value: '#FEFEFE' } },
      },
    });
    // tcTxStyle b="on" + lt1 落到无显式样式的 run 上。
    const headerParagraph = header!.cells[0]!.text.doc.content?.[0] as {
      content?: Array<{ marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }>;
    };
    const headerMarks = headerParagraph.content?.[0]?.marks ?? [];
    expect(headerMarks.some((mark) => mark.type === 'bold')).toBe(true);
    const headerTextStyle = headerMarks.find((mark) => mark.type === 'textStyle');
    expect(headerTextStyle?.attrs).toMatchObject({ color: '#FEFEFE' });
    // 合并单元格只保留起点,columnSpan=2;显式 tcPr 填充覆盖样式层。
    expect(body!.cells).toHaveLength(1);
    expect(body!.cells[0]).toMatchObject({
      rowSpan: 1,
      columnSpan: 2,
      style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#FFEE00' } } },
    });
    // header 单元格 anchor="ctr" → 垂直居中。
    expect(header!.cells[0]!.text.verticalAlignment).toBe('middle');
  });

  it('reports cell blipFill media for upload like every other image reference', async () => {
    const tbl = `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000"><a:tc>${cellText('图片格')}<a:tcPr><a:blipFill xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></a:tcPr></a:tc></a:tr></a:tbl>`;
    const parsed = await parsePptx(await createTablePptx(tableFrame(tbl)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(collectPptxReferencedMediaPartPaths(parsed.ir)).toEqual(['/ppt/media/image1.png']);
  });

  it('keeps tables without a resolvable style using explicit cell borders only', async () => {
    const tbl = `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000"><a:tc>${cellText('单元格')}<a:tcPr><a:lnL w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:lnL><a:lnR w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:lnR><a:lnT w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:lnT><a:lnB w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="solid"/><a:round/></a:lnB></a:tcPr></a:tc></a:tr></a:tbl>`;

    const result = await mapTablePptx(tableFrame(tbl));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    if (element?.type !== 'table') throw new Error('Expected a table element.');
    expect(element.rows[0]!.cells[0]).toMatchObject({
      style: { stroke: { width: 1, fill: { kind: 'srgb', value: '#FF0000' } } },
    });
  });
});
