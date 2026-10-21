import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import {
  analyzePptxCapabilities,
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

const createPptx = async (slideBody: string): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld>${slideBody}</p:cSld></p:sld>`,
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(name, new TextReader(contents));
  }
  return writer.close();
};

const parseIr = async (slideBody: string): Promise<PptxPresentationIR> => {
  const parsed = await parsePptx(await createPptx(slideBody));
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return parsed.ir;
};

const background = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>`;

const rect = (id: number, name: string, x: number, y: number, cx: number, cy: number, ln = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill>${ln}</p:spPr></p:sp>`;

const groupTransform = (
  off: readonly [number, number],
  ext: readonly [number, number],
  chOff: readonly [number, number],
  chExt: readonly [number, number],
  attributes = '',
) =>
  `<a:xfrm${attributes}><a:off x="${off[0]}" y="${off[1]}"/><a:ext cx="${ext[0]}" cy="${ext[1]}"/><a:chOff x="${chOff[0]}" y="${chOff[1]}"/><a:chExt cx="${chExt[0]}" cy="${chExt[1]}"/></a:xfrm>`;

const group = (id: number, name: string, xfrm: string, children: string) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrm}</p:grpSpPr>${children}</p:grpSp>`;

describe('p:grpSp mapping to Reach Deck v2 group elements', () => {
  it('maps a basic group into a nested group element with group-local children', async () => {
    // 组在 (100,50)pt、200x100pt;chOff/chExt 与 off/ext 一致 → 缩放 1,
    // 子元素只需减去 chOff 变为组内坐标。
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Group 1',
      groupTransform([1270000, 635000], [2540000, 1270000], [1270000, 635000], [2540000, 1270000]),
      rect(11, 'Left', 1270000, 635000, 1270000, 635000) +
        rect(12, 'Right', 2540000, 635000, 1270000, 1270000),
    )}</p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'group',
      name: 'Group 1',
      transform: { x: 100, y: 50, width: 200, height: 100 },
      children: [
        {
          type: 'shape',
          name: 'Left',
          transform: { x: 0, y: 0, width: 100, height: 50 },
        },
        {
          type: 'shape',
          name: 'Right',
          transform: { x: 100, y: 0, width: 100, height: 100 },
        },
      ],
    });
    expect(result.pageReports[0]).toMatchObject({ status: 'ok' });
  });

  it('rescales child geometry but keeps stroke width absolute via chOff/chExt', async () => {
    // ext 200x100pt / chExt 100x50pt → scaleX=scaleY=2;chOff (100,50)pt。
    // 子形状 (150,75)pt 50x25pt → (100,50)pt 100x50pt;a:ln w 是绝对 EMU,
    // 不随组坐标空间缩放,描边保持 1pt(与 PowerPoint 渲染一致)。
    const stroke = `<a:ln w="12700"><a:solidFill><a:srgbClr val="445566"/></a:solidFill></a:ln>`;
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Scaled group',
      groupTransform([0, 0], [2540000, 1270000], [1270000, 635000], [1270000, 635000]),
      rect(11, 'Scaled child', 1905000, 952500, 635000, 317500, stroke),
    )}</p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'group',
      transform: { x: 0, y: 0, width: 200, height: 100 },
      children: [
        {
          type: 'shape',
          transform: { x: 100, y: 50, width: 100, height: 50 },
          style: { stroke: { width: 1 } },
        },
      ],
    });
  });

  it('keeps a 1.5pt stroke intact under real-world tiny-integer chExt local units', async () => {
    // 真实课件模式:chExt 用微小整数本地单位(1763x1277),ext 是正常 EMU,
    // 坐标缩放比约 1587x。a:ln w=19050 EMU(1.5pt)仍是绝对宽度;若被坐标比
    // 缩放会得到约 2381pt 的描边,把整页涂黑(P0 回归)。
    const stroke = `<a:ln w="19050"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln>`;
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Engineering drawing',
      groupTransform([914400, 914400], [2798763, 2027237], [0, 0], [1763, 1277]),
      rect(11, 'Panel', 0, 0, 882, 639, stroke),
    )}</p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element?.type).toBe('group');
    if (element?.type !== 'group') return;
    const child = element.children[0];
    expect(child?.type).toBe('shape');
    if (child?.type !== 'shape') return;
    expect(child.style.stroke?.width).toBe(1.5);
    // 子形状的几何仍按组坐标空间缩放到组盒子的一半左右。
    expect(child.transform.width).toBeGreaterThan(100);
    expect(child.transform.width).toBeLessThan(element.transform.width);
  });

  it('scales line boxes through tiny-integer group units without a pre-scale floor', async () => {
    // 真实工程图模式(d08):chExt 887x385 本地单位映射 1441450x612775 EMU
    // (113.5x48.25pt)。规则线 off(3415,598) ext(157,238) flipV 应缩放为约
    // 20.09x29.83pt 的盒子;此前 1pt 最小盒下限在组缩放前生效,被放大 ~1625 倍。
    const line = `<p:sp><p:nvSpPr><p:cNvPr id="9227" name="Line 3117"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm flipV="1"><a:off x="3415" y="598"/><a:ext cx="157" cy="238"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="080808"/></a:solidFill></a:ln></p:spPr></p:sp>`;
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Drawing group',
      groupTransform([4314825, 1065213], [1441450, 612775], [2685, 598], [887, 385]),
      line,
    )}</p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element?.type).toBe('group');
    if (element?.type !== 'group') return;
    const child = element.children[0];
    expect(child?.type).toBe('line');
    if (child?.type !== 'line') return;
    expect(child.transform.x).toBeCloseTo(93.4, 0);
    expect(child.transform.y).toBeCloseTo(0, 0);
    expect(child.transform.width).toBeCloseTo(20.1, 0);
    expect(child.transform.height).toBeCloseTo(29.8, 0);
    // flipV:起点在下端,终点在上端;端点跨满缩放后的盒子。
    expect(child.start.y).toBeCloseTo(child.transform.height, 0);
    expect(child.end.y).toBeCloseTo(0, 0);
    expect(child.end.x).toBeCloseTo(child.transform.width, 0);
    expect(child.stroke.width).toBe(1);
  });

  it('scales custom geometry viewBox and path through tiny-integer group units', async () => {
    // 组内 freeform:child 空间坐标是微小本地单位;custom geometry 的
    // viewBox/path 必须随组缩放到最终 pt 盒,否则绝对 pt 描边在微小
    // viewBox 里被放大数百倍涂满整页(d05/d08 黑块回归)。
    const freeform = `<p:sp><p:nvSpPr><p:cNvPr id="20" name="Freeform 19"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="635" cy="635"/></a:xfrm><a:custGeom><a:avLst/><a:pathLst><a:path w="635" h="635"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="635" y="635"/></a:lnTo></a:path></a:pathLst></a:custGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="080808"/></a:solidFill></a:ln></p:spPr></p:sp>`;
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Freeform group',
      groupTransform([0, 0], [2540000, 2540000], [0, 0], [1270, 1270]),
      freeform,
    )}</p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    if (element?.type !== 'group') throw new Error('Expected a group element.');
    const child = element.children[0];
    if (child?.type !== 'shape') throw new Error('Expected a shape child.');
    // chExt 1270 本地单位 → 200pt(×2000);child 635 单位 → 100pt。
    expect(child.transform).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
    expect(child.geometry).toEqual({
      kind: 'custom',
      viewBox: { width: 100, height: 100 },
      path: 'M 0 0 L 100 100',
    });
  });

  it('recursively maps nested groups and bakes the outer scale into inner children', async () => {
    // 外组 chExt 100x50pt → 页面 200x100pt(×2);内组在子空间 (50,25)pt 50x25pt。
    // 内组盒子被外组放大到 (100,50)pt 100x50pt,内组子形状坐标也随之 ×2。
    const inner = group(
      20,
      'Inner',
      groupTransform([635000, 317500], [635000, 317500], [0, 0], [635000, 317500]),
      rect(21, 'Leaf', 0, 0, 635000, 317500),
    );
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Outer',
      groupTransform([0, 0], [2540000, 1270000], [0, 0], [1270000, 635000]),
      inner,
    )}</p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outer = result.document.nativeSlides[0]?.slide.elements[0];
    expect(outer).toMatchObject({
      type: 'group',
      name: 'Outer',
      transform: { x: 0, y: 0, width: 200, height: 100 },
      children: [
        {
          type: 'group',
          name: 'Inner',
          transform: { x: 100, y: 50, width: 100, height: 50 },
          children: [
            { type: 'shape', name: 'Leaf', transform: { x: 0, y: 0, width: 100, height: 50 } },
          ],
        },
      ],
    });
  });

  it('keeps group rotation and flip on the group transform', async () => {
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Rotated group',
      groupTransform(
        [1270000, 635000],
        [1270000, 1270000],
        [1270000, 635000],
        [1270000, 1270000],
        ' rot="5400000" flipV="1"',
      ),
      rect(11, 'Child', 1270000, 635000, 635000, 635000),
    )}</p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'group',
      transform: {
        x: 100,
        y: 50,
        width: 100,
        height: 100,
        rotation: 90,
        flipVertical: true,
      },
      children: [{ type: 'shape', transform: { x: 0, y: 0, width: 50, height: 50 } }],
    });
  });

  it('retains unresolved chart children as placeholders and keeps the rest of the group', async () => {
    const graphicFrame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="12" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`;
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Partial group',
      groupTransform([0, 0], [2540000, 1270000], [0, 0], [2540000, 1270000]),
      rect(11, 'Kept', 0, 0, 1270000, 635000) + graphicFrame,
    )}</p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'pptx.mapper.chart_unsupported',
        feature: 'chart',
        severity: 'warning',
      }),
    );
    expect(
      result.diagnostics.some((diagnostic) =>
        (diagnostic.location?.nodePath ?? '').includes('p:grpSp[1]/p:graphicFrame[1]'),
      ),
    ).toBe(true);
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'group',
      children: [
        { type: 'shape', name: 'Kept' },
        { type: 'chart', chartType: 'unsupported', sourceChartType: 'unresolved-chart' },
      ],
    });
  });

  it('blocks groups without an explicit transform instead of guessing', async () => {
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="No xfrm"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${rect(
      11,
      'Child',
      0,
      0,
      1270000,
      635000,
    )}</p:grpSp></p:spTree>`;

    const result = mapPptxPresentationToReachDeckV2(await parseIr(slide), mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'pptx.mapper.group_unsupported',
    );
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    expect(result.document.nativeSlides[0]?.slide.elements).toHaveLength(0);
  });

  it('reports group as native capability while surfacing unsupported nested content', async () => {
    const graphicFrame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="21" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>`;
    const nested = group(
      20,
      'Inner',
      groupTransform([0, 0], [1270000, 635000], [0, 0], [1270000, 635000]),
      graphicFrame,
    );
    const slide = `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${group(
      10,
      'Outer',
      groupTransform([0, 0], [2540000, 1270000], [0, 0], [2540000, 1270000]),
      nested,
    )}</p:spTree>`;

    const report = analyzePptxCapabilities(await parseIr(slide));

    expect(report.entries).toContainEqual({ feature: 'group', status: 'native' });
    expect(report.diagnostics.some((diagnostic) => diagnostic.feature === 'group')).toBe(false);
    expect(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.feature === 'chart' &&
          (diagnostic.location?.nodePath ?? '').includes('p:grpSp[1]/p:grpSp[1]/p:graphicFrame[1]'),
      ),
    ).toBe(true);
  });
});
