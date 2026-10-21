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
  documentId: 'module-version-chart',
  applicationId: 'pptx-apply-chart',
  title: 'Imported chart lesson',
  language: 'zh-CN',
  generatedAt: '2026-09-11T00:00:00.000Z',
  compatibilityTheme,
} as const;

const transitionalChartNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const transitionalRelationshipNamespace =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const strictChartNamespace = 'http://purl.oclc.org/ooxml/drawingml/chart';
const strictRelationshipNamespace = 'http://purl.oclc.org/ooxml/officeDocument/relationships';

const chartFrame = (
  relationshipId = 'rId7',
  options: {
    chartNamespace?: string;
    chartReference?: string;
    graphicDataUri?: string;
    nonVisualAttributes?: string;
  } = {},
) => {
  const chartNamespace = options.chartNamespace ?? transitionalChartNamespace;
  const graphicDataUri = options.graphicDataUri ?? chartNamespace;
  const chartReference =
    options.chartReference ?? `<c:chart xmlns:c="${chartNamespace}" r:id="${relationshipId}"/>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart 1"${options.nonVisualAttributes ?? ''}/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="127000" y="254000"/><a:ext cx="2540000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="${graphicDataUri}">${chartReference}</a:graphicData></a:graphic></p:graphicFrame>`;
};

const chartSpace = (plotArea: string, extras = '') =>
  `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>${extras}<c:plotArea>${plotArea}</c:plotArea></c:chart></c:chartSpace>`;

async function createChartPptx(
  chartXml: string,
  relationshipTarget = '../charts/chart1.xml',
  frameRelationshipId = 'rId7',
  options: {
    frameXml?: string;
    relationshipNamespace?: string;
    relationshipType?: string;
  } = {},
) {
  const relationshipNamespace = options.relationshipNamespace ?? transitionalRelationshipNamespace;
  const relationshipType = options.relationshipType ?? `${transitionalRelationshipNamespace}/chart`;
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${relationshipNamespace}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${options.frameXml ?? chartFrame(frameRelationshipId)}</p:spTree></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="${relationshipType}" Target="${relationshipTarget}"/></Relationships>`,
    'ppt/charts/chart1.xml': chartXml,
  };
  for (const [name, contents] of Object.entries(entries)) {
    await writer.add(name, new TextReader(contents));
  }
  return writer.close();
}

async function mapChart(
  chartXml: string,
  relationshipTarget?: string,
  frameRelationshipId?: string,
  options?: Parameters<typeof createChartPptx>[3],
) {
  const parsed = await parsePptx(
    await createChartPptx(chartXml, relationshipTarget, frameRelationshipId, options),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return mapPptxPresentationToReachDeckV2(parsed.ir, mapperOptions);
}

const categoryCache = `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="1"><c:v>Active Inquirer</c:v></c:pt><c:pt idx="0"><c:v>Active Student</c:v></c:pt></c:strCache></c:strRef></c:cat>`;

const series = (input: {
  index: number;
  order: number;
  name?: string;
  values?: readonly number[];
  color?: string;
}) =>
  `<c:ser><c:idx val="${input.index}"/><c:order val="${input.order}"/><c:tx><c:strRef><c:strCache><c:ptCount val="1"/>${input.name === undefined ? '' : `<c:pt idx="0"><c:v>${input.name}</c:v></c:pt>`}</c:strCache></c:strRef></c:tx>${input.color === undefined ? '' : `<c:spPr><a:solidFill><a:srgbClr val="${input.color}"/></a:solidFill></c:spPr>`}${categoryCache}<c:val><c:numRef>${input.values === undefined ? '<c:f>Sheet1!#REF!</c:f>' : `<c:numCache><c:ptCount val="${input.values.length}"/>${input.values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')}</c:numCache>`}</c:numRef></c:val></c:ser>`;

describe('PPTX categorical chart mapping', () => {
  it.each(['barChart', 'lineChart'])(
    'maps literal categories and sparse values in %s by point index',
    async (chartType) => {
      const result = await mapChart(
        chartSpace(
          `<c:${chartType}><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Results</c:v></c:tx><c:cat><c:strLit><c:ptCount val="3"/><c:pt idx="2"><c:v>C</c:v></c:pt><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="2"><c:v>-2.5</c:v></c:pt><c:pt idx="0"><c:v>0</c:v></c:pt></c:numLit></c:val></c:ser></c:${chartType}>`,
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
        type: 'chart',
        chartType: chartType === 'barChart' ? 'column' : 'line',
        categories: ['A', 'B', 'C'],
        series: [{ name: 'Results', values: [0, null, -2.5] }],
      });
      expect(result.diagnostics.map((entry) => entry.code)).not.toContain(
        'pptx.mapper.chart_unsupported',
      );
    },
  );

  it.each([
    ['0', 'column'],
    ['10000', 'unsupported'],
  ])('validates numeric literal category and value indexes (%s)', async (index, expectedType) => {
    const result = await mapChart(
      chartSpace(
        `<c:barChart><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>2026</c:v></c:pt></c:numLit></c:cat><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="${index}"><c:v>42</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart>`,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const element = result.document.nativeSlides[0]?.slide.elements[0];
    expect(element).toMatchObject({ type: 'chart', chartType: expectedType });
    if (expectedType === 'column')
      expect(element).toMatchObject({ categories: ['2026'], series: [{ values: [42] }] });
  });

  it('maps real cached series by point index and series order without chart errors', async () => {
    const chart = chartSpace(
      `<c:barChart><c:barDir val="col"/>${series({ index: 4, order: 1, name: 'MOOC', values: [7.66, 7.87] })}${series({ index: 5, order: 0, name: 'Human-teacher', values: [6.7, 7.47], color: 'AA1122' })}<c:dLbls><c:showVal val="0"/></c:dLbls><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx/><c:valAx/>`,
      `<c:title><c:tx><c:rich><a:p><a:r><a:t>Sudent's Sense of Identity</a:t></a:r></a:p></c:rich></c:tx></c:title><c:legend><c:legendPos val="b"/></c:legend>`,
    );

    const result = await mapChart(chart);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'pptx.mapper.package_part_unsupported',
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'pptx.mapper.unknown_xml_unsupported',
    );
    expect(result.pageReports[0]).toMatchObject({ status: 'warning' });
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'chart',
      chartType: 'column',
      transform: { x: 10, y: 20, width: 200, height: 100 },
      title: "Sudent's Sense of Identity",
      categories: ['Active Student', 'Active Inquirer'],
      showLegend: true,
      showDataLabels: false,
      series: [
        {
          name: 'Human-teacher',
          values: [6.7, 7.47],
          color: { kind: 'srgb', value: '#AA1122' },
        },
        { name: 'MOOC', values: [7.66, 7.87] },
      ],
    });
  });

  it('keeps missing-cache series aligned as null gaps', async () => {
    const threeCategories = categoryCache
      .replace('$A$2:$A$3', '$A$2:$A$4')
      .replace('val="2"', 'val="3"')
      .replace('</c:strCache>', '<c:pt idx="2"><c:v>Agentutor</c:v></c:pt></c:strCache>');
    const first = series({
      index: 0,
      order: 0,
      name: '系列 1',
      values: [0.65, 0.72, 0.75],
    }).replace(categoryCache, threeCategories);
    const second = series({ index: 1, order: 1 }).replace(categoryCache, threeCategories);
    const third = series({ index: 2, order: 2 }).replace(categoryCache, threeCategories);

    const result = await mapChart(
      chartSpace(
        `<c:barChart><c:barDir val="col"/>${first}${second}${third}<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx/><c:valAx/>`,
        '<c:title><c:tx><c:rich><a:p><a:r><a:t>Test Score</a:t></a:r></a:p></c:rich></c:tx></c:title>',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'chart',
      categories: ['Active Student', 'Active Inquirer', 'Agentutor'],
      series: [
        { name: '系列 1', values: [0.65, 0.72, 0.75] },
        { name: 'Series 2', values: [null, null, null] },
        { name: 'Series 3', values: [null, null, null] },
      ],
    });
  });

  it.each([
    ['an omitted bar direction', '<c:barDir/>'],
    ['an omitted barDir element', ''],
  ])('reads %s as the schema default column chart', async (_label, barDir) => {
    const result = await mapChart(
      chartSpace(
        `<c:barChart>${barDir}${series({ index: 0, order: 0, name: 'Series', values: [1, 2] })}<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx/><c:valAx/>`,
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'chart',
      chartType: 'column',
      series: [{ name: 'Series', values: [1, 2] }],
    });
  });

  it('preserves hidden state and uses the chart description as its accessibility label', async () => {
    const result = await mapChart(
      chartSpace(
        `<c:barChart><c:barDir val="col"/>${series({ index: 0, order: 0, name: 'Series', values: [1, 2] })}<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx/><c:valAx/>`,
      ),
      undefined,
      undefined,
      {
        frameXml: chartFrame('rId7', {
          nonVisualAttributes: ' descr="Student outcomes" hidden="1"',
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'chart',
      name: 'Chart 1',
      ariaLabel: 'Student outcomes',
      hidden: true,
    });
  });

  it('accepts strict chart references and relationship types', async () => {
    const result = await mapChart(
      chartSpace(
        `<c:barChart><c:barDir val="col"/>${series({ index: 0, order: 0, name: 'Series', values: [1, 2] })}<c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx/><c:valAx/>`,
      ),
      undefined,
      undefined,
      {
        frameXml: chartFrame('rId7', { chartNamespace: strictChartNamespace }),
        relationshipNamespace: strictRelationshipNamespace,
        relationshipType: `${strictRelationshipNamespace}/chart`,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'chart',
      chartType: 'column',
    });
  });

  it('keeps strict XML errors for rogue chart-reference attributes and children', async () => {
    const result = await mapChart(
      chartSpace(`<c:barChart><c:barDir val="col"/></c:barChart>`),
      undefined,
      undefined,
      {
        frameXml: chartFrame('rId7', {
          chartReference: '<c:chart r:id="rId7" rogue="1"><c:rogue/></c:chart>',
        }),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'pptx.mapper.unknown_attribute_unsupported',
          severity: 'error',
          details: { attributes: ['rogue'] },
        }),
        expect.objectContaining({
          code: 'pptx.mapper.unknown_xml_unsupported',
          severity: 'error',
          location: expect.objectContaining({ nodePath: expect.stringContaining('c:rogue') }),
        }),
      ]),
    );
  });

  it.each([
    [
      'wrong graphic-data URI',
      chartFrame('rId7', { graphicDataUri: 'urn:unsupported-chart-payload' }),
      'pptx.mapper.unknown_xml_unsupported',
    ],
    [
      'wrong chart namespace',
      chartFrame('rId7', {
        chartReference: '<x:chart xmlns:x="urn:unsupported-chart" r:id="rId7"/>',
      }),
      'pptx.mapper.unknown_xml_unsupported',
    ],
    [
      'wrong graphic-data namespace',
      chartFrame('rId7')
        .replace('<a:graphicData', '<x:graphicData xmlns:x="urn:unsupported-graphic-data"')
        .replace('</a:graphicData>', '</x:graphicData>'),
      'pptx.mapper.unknown_xml_unsupported',
    ],
    [
      'duplicate relationship-id namespace aliases',
      chartFrame('rId7', {
        chartReference: `<c:chart r:id="rId7" xmlns:s="${strictRelationshipNamespace}" s:id="rId7"/>`,
      }),
      'pptx.mapper.unknown_attribute_unsupported',
    ],
  ])(
    'does not silently whitelist a chart reference with the %s',
    async (_label, frameXml, diagnosticCode) => {
      const result = await mapChart(
        chartSpace(`<c:barChart><c:barDir val="col"/></c:barChart>`),
        undefined,
        undefined,
        { frameXml },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: diagnosticCode,
            severity: 'error',
          }),
        ]),
      );
    },
  );

  it.each([
    ['scatterChart', '<c:scatterChart><c:ser/></c:scatterChart>'],
    ['bar3DChart', '<c:bar3DChart><c:ser/></c:bar3DChart>'],
    [
      'combination-chart',
      '<c:barChart><c:barDir val="col"/><c:ser/></c:barChart><c:lineChart><c:ser/></c:lineChart>',
    ],
  ])('retains %s as a warning-only read-only placeholder', async (sourceType, plotArea) => {
    const result = await mapChart(chartSpace(plotArea));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'pptx.mapper.chart_unsupported',
          severity: 'warning',
        }),
      ]),
    );
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'chart',
      chartType: 'unsupported',
      sourceChartType: sourceType,
      transform: { x: 10, y: 20, width: 200, height: 100 },
    });
  });

  it('uses a warning placeholder when an internal chart target cannot be resolved', async () => {
    const result = await mapChart(
      chartSpace(`<c:barChart><c:barDir val="col"/></c:barChart>`),
      undefined,
      'rId404',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'chart',
      chartType: 'unsupported',
      sourceChartType: 'unresolved-chart',
    });
  });

  it('uses a warning placeholder when the relationship has the wrong type', async () => {
    const result = await mapChart(
      chartSpace(`<c:barChart><c:barDir val="col"/></c:barChart>`),
      undefined,
      undefined,
      { relationshipType: `${transitionalRelationshipNamespace}/image` },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'pptx.mapper.chart_unsupported',
          severity: 'warning',
        }),
      ]),
    );
    expect(result.document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'chart',
      chartType: 'unsupported',
      sourceChartType: 'unresolved-chart',
    });
  });
});
