import { describe, expect, it } from 'vitest';

import { parsePptxThemeStyle, parsePptxXml } from '../src/pptx/index.js';

const parseTheme = (body: string) => {
  const result = parsePptxXml(
    '/ppt/theme/theme1.xml',
    new TextEncoder().encode(
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${body}</a:theme>`,
    ),
  );
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.root;
};

describe('PPTX theme style projection', () => {
  it('projects deterministic theme colors and script-aware major/minor fonts', () => {
    const result = parsePptxThemeStyle(
      parseTheme(`
        <a:themeElements>
          <a:clrScheme name="Office">
            <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
            <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
            <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
          </a:clrScheme>
          <a:fontScheme name="Office">
            <a:majorFont>
              <a:latin typeface="Aptos Display" panose="020B0604020202020204"/>
              <a:ea typeface="等线 Light"/>
              <a:cs typeface="Arial"/>
              <a:font script="Hans" typeface="等线 Light"/>
            </a:majorFont>
            <a:minorFont>
              <a:latin typeface="Aptos"/>
              <a:ea typeface="等线"/>
              <a:cs typeface="Arial"/>
              <a:font script="Hans" typeface="等线"/>
            </a:minorFont>
          </a:fontScheme>
        </a:themeElements>`),
      '/ppt/theme/theme1.xml',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.style.colorScheme).toEqual({
      name: 'Office',
      colors: {
        dk1: { token: 'dk1', sourceKind: 'system', systemName: 'windowText', value: '000000' },
        lt1: { token: 'lt1', sourceKind: 'srgb', value: 'FFFFFF' },
        accent1: { token: 'accent1', sourceKind: 'srgb', value: '4472C4' },
      },
    });
    expect(result.style.fontScheme).toMatchObject({
      name: 'Office',
      major: {
        latin: { typeface: 'Aptos Display' },
        eastAsia: { typeface: '等线 Light' },
        complexScript: { typeface: 'Arial' },
        supplemental: { Hans: '等线 Light' },
      },
      minor: { latin: { typeface: 'Aptos' }, supplemental: { Hans: '等线' } },
    });
  });

  it('rejects system colors without a deterministic lastClr', () => {
    const result = parsePptxThemeStyle(
      parseTheme(
        '<a:themeElements><a:clrScheme><a:dk1><a:sysClr val="windowText"/></a:dk1></a:clrScheme></a:themeElements>',
      ),
      '/ppt/theme/theme1.xml',
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.theme.unresolved_system_color', feature: 'theme' }],
    });
  });

  it('rejects duplicate supplemental script mappings', () => {
    const result = parsePptxThemeStyle(
      parseTheme(`
        <a:themeElements><a:fontScheme>
          <a:majorFont><a:font script="Hans" typeface="A"/><a:font script="Hans" typeface="B"/></a:majorFont>
          <a:minorFont/>
        </a:fontScheme></a:themeElements>`),
      '/ppt/theme/theme1.xml',
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'pptx.theme.duplicate_font_script', feature: 'theme' }],
    });
  });
});
