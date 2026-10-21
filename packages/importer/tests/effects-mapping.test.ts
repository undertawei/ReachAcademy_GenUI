import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';

import {
  hasBlockingPptxDiagnostics,
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

const rectWithEffects = (effects: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Rect"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill>${effects}</p:spPr></p:sp>`;

const slideWith = (body: string): string =>
  `${background}<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${body}</p:spTree>`;

describe('shape effects degrade without dropping element bodies', () => {
  it('maps a:outerShdw natively with EMU→pt, 1/60000°→deg and alpha conversion', async () => {
    // blurRad 63500 EMU = 5pt; dist 38100 EMU = 3pt; dir 2700000 = 45°.
    const effects = `<a:effectLst><a:outerShdw blurRad="63500" dist="38100" dir="2700000" rotWithShape="0"><a:srgbClr val="FF0000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>`;
    const result = mapPptxPresentationToReachDeckV2(
      await parseIr(slideWith(rectWithEffects(effects))),
      mapperOptions,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageReports[0]).toMatchObject({ status: 'ok' });
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      style: {
        fill: { kind: 'solid', color: { kind: 'srgb', value: '#112233' } },
        effects: {
          shadow: {
            color: { kind: 'srgb', value: '#FF0000', alpha: 0.4 },
            blur: 5,
            distance: 3,
            angle: 45,
          },
        },
      },
    });
  });

  it('maps a:glow natively with EMU→pt radius conversion', async () => {
    // rad 127000 EMU = 10pt.
    const effects = `<a:effectLst><a:glow rad="127000"><a:srgbClr val="00FF00"/></a:glow></a:effectLst>`;
    const result = mapPptxPresentationToReachDeckV2(
      await parseIr(slideWith(rectWithEffects(effects))),
      mapperOptions,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      style: {
        effects: { glow: { color: { kind: 'srgb', value: '#00FF00' }, radius: 10 } },
      },
    });
  });

  it('keeps the shape body and degrades unsupported effects to non-blocking advisories', async () => {
    const effects = `<a:effectLst><a:reflection blurRad="6350" stA="52000" endA="300" endPos="35000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/><a:softEdge rad="127000"/></a:effectLst>`;
    const result = mapPptxPresentationToReachDeckV2(
      await parseIr(slideWith(rectWithEffects(effects))),
      mapperOptions,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const advisories = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'pptx.mapper.effects_unsupported',
    );
    expect(advisories.length).toBe(2);
    expect(advisories.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
    expect(hasBlockingPptxDiagnostics(result.diagnostics)).toBe(false);
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({
      type: 'shape',
      style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#112233' } } },
    });
    if (element?.type !== 'shape') return;
    expect(element.style.effects).toBeUndefined();
  });

  it('keeps supported effects while degrading the unsupported ones in the same list', async () => {
    const effects = `<a:effectLst><a:innerShdw blurRad="63500"><a:srgbClr val="000000"/></a:innerShdw><a:outerShdw blurRad="12700" dist="12700" dir="0"><a:srgbClr val="222222"/></a:outerShdw></a:effectLst>`;
    const result = mapPptxPresentationToReachDeckV2(
      await parseIr(slideWith(rectWithEffects(effects))),
      mapperOptions,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === 'pptx.mapper.effects_unsupported' &&
          diagnostic.severity === 'warning',
      ),
    ).toHaveLength(1);
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      style: {
        effects: {
          shadow: { color: { kind: 'srgb', value: '#222222' }, blur: 1, distance: 1, angle: 0 },
        },
      },
    });
  });

  it('maps grpSpPr outer shadows onto the group instead of dropping the group', async () => {
    const child = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Child"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp>`;
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="635000"/></a:xfrm><a:effectLst><a:outerShdw blurRad="63500" dist="38100" dir="2700000"><a:srgbClr val="336699"/></a:outerShdw></a:effectLst></p:grpSpPr>${child}</p:grpSp>`;
    const result = mapPptxPresentationToReachDeckV2(await parseIr(slideWith(group)), mapperOptions);

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pageReports[0]).toMatchObject({ status: 'ok' });
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'group',
      children: [{ type: 'shape', name: 'Child' }],
      effects: {
        shadow: {
          color: { kind: 'srgb', value: '#336699' },
          blur: 5,
          distance: 3,
          angle: 45,
        },
      },
    });
  });

  it('keeps groups whose grpSpPr effects are unsupported, with a non-blocking advisory', async () => {
    const child = `<p:sp><p:nvSpPr><p:cNvPr id="11" name="Child"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp>`;
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="635000"/></a:xfrm><a:effectLst><a:reflection blurRad="6350" dir="5400000"/></a:effectLst></p:grpSpPr>${child}</p:grpSp>`;
    const result = mapPptxPresentationToReachDeckV2(await parseIr(slideWith(group)), mapperOptions);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'pptx.mapper.group_unsupported',
    );
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'pptx.mapper.effects_unsupported' &&
          diagnostic.severity === 'warning' &&
          diagnostic.feature === 'group',
      ),
    ).toBe(true);
    expect(hasBlockingPptxDiagnostics(result.diagnostics)).toBe(false);
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({ type: 'group', children: [{ type: 'shape' }] });
    if (element?.type !== 'group') return;
    expect(element.effects).toBeUndefined();
  });

  it('degrades text-run effect lists to advisories without dropping the shape', async () => {
    const textShape = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="254000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1800"><a:effectLst><a:outerShdw blurRad="38100" dist="38100" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst><a:latin typeface="Arial"/></a:rPr><a:t>你好</a:t></a:r></a:p></p:txBody></p:sp>`;
    const result = mapPptxPresentationToReachDeckV2(
      await parseIr(slideWith(textShape)),
      mapperOptions,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'pptx.mapper.effects_unsupported' &&
          diagnostic.severity === 'warning',
      ),
    ).toBe(true);
    expect(hasBlockingPptxDiagnostics(result.diagnostics)).toBe(false);
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'shape',
      text: {
        doc: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '你好' }] }],
        },
      },
    });
  });
});
