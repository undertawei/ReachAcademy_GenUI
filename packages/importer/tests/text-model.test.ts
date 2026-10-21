import { describe, expect, it } from 'vitest';

import { parsePptxXml, projectPptxTextBody } from '../src/pptx/index.js';

const textBody = (body: string) => {
  const parsed = parsePptxXml(
    '/ppt/slides/slide1.xml',
    new TextEncoder().encode(
      `<a:txBody xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${body}</a:txBody>`,
    ),
  );
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  return parsed.root;
};

describe('PPTX text model', () => {
  it('retains body, list, paragraph, run, script font and autofit semantics', () => {
    const result = projectPptxTextBody(
      'shape-1',
      textBody(`
        <a:bodyPr lIns="12700" tIns="25400" anchor="ctr" wrap="square" numCol="2">
          <a:normAutofit fontScale="85000" lnSpcReduction="12000"/>
        </a:bodyPr>
        <a:lstStyle/>
        <a:p>
          <a:pPr lvl="2" algn="ctr" marL="38100" indent="-12700">
            <a:lnSpc><a:spcPct val="120000"/></a:lnSpc>
            <a:buAutoNum type="arabicPeriod" startAt="3"/>
            <a:tabLst><a:tab pos="50800" algn="l"/></a:tabLst>
          </a:pPr>
          <a:r><a:rPr lang="zh-CN" sz="2400" b="1"><a:latin typeface="Aptos"/><a:ea typeface="等线"/></a:rPr><a:t>第一项</a:t></a:r>
          <a:br/>
          <a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld>
        </a:p>`),
      { partPath: '/ppt/slides/slide1.xml', nodePath: '/p:sld/p:cSld/p:spTree/p:sp[1]' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toMatchObject({
      properties: {
        margins: { left: { raw: '12700' }, top: { raw: '25400' } },
        verticalAnchor: 'ctr',
        wrap: 'square',
        columns: '2',
        autofit: {
          mode: 'shrink-text',
          fontScale: { raw: '85000' },
          lineSpacingReduction: { raw: '12000' },
        },
      },
      paragraphs: [
        {
          properties: {
            level: '2',
            alignment: 'ctr',
            leftMargin: { raw: '38100' },
            indent: { raw: '-12700' },
            lineSpacing: { kind: 'percentage', value: { raw: '120000' } },
            bullet: { kind: 'automatic-number', numberingType: 'arabicPeriod', startAt: '3' },
            tabs: [{ position: { raw: '50800' }, alignment: 'l' }],
          },
          runs: [
            {
              kind: 'text',
              text: '第一项',
              properties: {
                language: 'zh-CN',
                fontSize: '2400',
                bold: true,
                typefaces: { latin: 'Aptos', eastAsia: '等线' },
              },
            },
            { kind: 'break' },
            { kind: 'field', fieldId: '{1}', fieldType: 'slidenum', text: '1' },
          ],
        },
      ],
    });
  });

  it('rejects ambiguous autofit instead of choosing a mode', () => {
    const result = projectPptxTextBody(
      'shape-1',
      textBody('<a:bodyPr><a:noAutofit/><a:spAutoFit/></a:bodyPr><a:p/>'),
      { partPath: '/ppt/slides/slide1.xml' },
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.text_frame.invalid_structure', feature: 'text-frame' }],
    });
  });

  it('collapses identical interleaved pPr repeats emitted by WPS-style generators', () => {
    const repeatedPPr =
      '<a:pPr algn="just" indent="0" marL="0"><a:lnSpc><a:spcPct val="80000"/></a:lnSpc><a:buNone/></a:pPr>';
    const result = projectPptxTextBody(
      'shape-1',
      textBody(`
        <a:bodyPr/>
        <a:p>
          ${repeatedPPr}
          <a:r><a:rPr lang="en-US"/><a:t>第一段</a:t></a:r>
          ${repeatedPPr}
          <a:r><a:rPr lang="en-US"/><a:t>第二段</a:t></a:r>
          ${repeatedPPr}
        </a:p>`),
      { partPath: '/ppt/slides/slide1.xml' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.paragraphs).toHaveLength(1);
    expect(result.text.paragraphs[0]).toMatchObject({
      properties: { alignment: 'just', leftMargin: { raw: '0' } },
      runs: [
        { kind: 'text', text: '第一段' },
        { kind: 'text', text: '第二段' },
      ],
    });
  });

  it('accepts a fld without cached text as an empty field', () => {
    const result = projectPptxTextBody(
      'shape-1',
      textBody(`
        <a:bodyPr/>
        <a:p>
          <a:fld id="{59AE3B15-24E2-F441-9DAB-E62D72EA6ACD}" type="slidenum"><a:rPr lang="zh-CN"/></a:fld>
        </a:p>`),
      { partPath: '/ppt/slides/slide1.xml' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.paragraphs[0]?.runs).toMatchObject([
      { kind: 'field', fieldType: 'slidenum', text: '' },
    ]);
  });

  it('still rejects a text run without t', () => {
    const result = projectPptxTextBody(
      'shape-1',
      textBody('<a:bodyPr/><a:p><a:r><a:rPr lang="zh-CN"/></a:r></a:p>'),
      { partPath: '/ppt/slides/slide1.xml' },
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.text_frame.invalid_structure', feature: 'text-frame' }],
    });
  });

  it('still rejects conflicting duplicate pPr elements', () => {
    const result = projectPptxTextBody(
      'shape-1',
      textBody(`
        <a:bodyPr/>
        <a:p>
          <a:pPr algn="l"/>
          <a:r><a:rPr lang="en-US"/><a:t>text</a:t></a:r>
          <a:pPr algn="r"/>
        </a:p>`),
      { partPath: '/ppt/slides/slide1.xml' },
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.text_frame.invalid_structure', feature: 'text-frame' }],
    });
  });
});
