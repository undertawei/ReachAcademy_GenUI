import { describe, expect, it } from 'vitest';

import { parsePptxDirectShapeStyle, parsePptxXml } from '../src/pptx/index.js';

const shapeProperties = (body: string) => {
  const result = parsePptxXml(
    '/ppt/slides/slide1.xml',
    new TextEncoder().encode(
      `<a:spPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${body}</a:spPr>`,
    ),
  );
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.root;
};

describe('PPTX direct drawing style', () => {
  it('projects solid scheme colors, modifiers and editable stroke semantics', () => {
    const result = parsePptxDirectShapeStyle(
      shapeProperties(`
        <a:solidFill><a:schemeClr val="accent1"><a:tint val="20000"/><a:alpha val="75000"/></a:schemeClr></a:solidFill>
        <a:ln w="25400" cap="rnd"><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:prstDash val="dash"/><a:round/></a:ln>`),
      { partPath: '/ppt/slides/slide1.xml' },
    );

    expect(result).toMatchObject({
      ok: true,
      style: {
        fill: {
          kind: 'solid',
          color: {
            kind: 'scheme',
            token: 'accent1',
            modifiers: [
              { kind: 'tint', value: { raw: '20000' } },
              { kind: 'alpha', value: { raw: '75000' } },
            ],
          },
        },
        stroke: {
          width: { raw: '25400' },
          cap: 'rnd',
          fill: { kind: 'solid', color: { kind: 'srgb', value: '#112233' } },
          dash: 'dash',
          join: 'round',
        },
      },
    });
  });

  it('parses linear gradient fills into ordered editable stops', () => {
    const result = parsePptxDirectShapeStyle(
      shapeProperties(
        '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="112233"/></a:gs><a:gs pos="100000"><a:srgbClr val="445566"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>',
      ),
      { partPath: '/ppt/slides/slide1.xml' },
    );
    expect(result).toMatchObject({
      ok: true,
      style: {
        fill: {
          kind: 'gradient',
          angle: { unit: 'ooxml-angle', raw: '5400000' },
          stops: [
            { position: { raw: '0' }, color: { kind: 'srgb', value: '#112233' } },
            { position: { raw: '100000' }, color: { kind: 'srgb', value: '#445566' } },
          ],
        },
      },
    });
  });

  it('rejects gradients without at least two stops instead of guessing', () => {
    const result = parsePptxDirectShapeStyle(shapeProperties('<a:gradFill rotWithShape="1"/>'), {
      partPath: '/ppt/slides/slide1.xml',
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.shape.invalid_style', feature: 'shape' }],
    });
  });

  it('retains unsupported blip fill semantics explicitly for capability blocking', () => {
    const result = parsePptxDirectShapeStyle(shapeProperties('<a:blipFill/>'), {
      partPath: '/ppt/slides/slide1.xml',
    });
    expect(result).toMatchObject({
      ok: true,
      style: { fill: { kind: 'unsupported', fillType: 'blipFill' } },
    });
  });

  it('rejects multiple direct fills rather than choosing one', () => {
    const result = parsePptxDirectShapeStyle(
      shapeProperties('<a:noFill/><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>'),
      { partPath: '/ppt/slides/slide1.xml' },
    );
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.shape.invalid_style', feature: 'shape' }],
    });
  });
});
