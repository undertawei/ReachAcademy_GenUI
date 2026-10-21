import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  createThemeResource,
  resolveDeckDesignTheme,
  type ReachDeckDesignContext,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '@reachany/reach-deck-dsl/reference-library';
import {
  compileHtmlLayout,
  HtmlLayoutValidationError,
  validateHtmlLayoutInput,
  type HtmlLayoutAsset,
} from '../../lib/reach-deck/html-layout';

const designContext: ReachDeckDesignContext = {
  schemaVersion: 'reach-deck-design-context/v1',
  libraryVersion: REFERENCE_LIBRARY_VERSION,
  librarySha256: REFERENCE_LIBRARY_SHA256,
  paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
  imageStyleReferenceIds: [],
  visualIntent: 'Teaching',
  resolvedColors: {
    background: '#FFFFFF',
    surface: '#FFFFFF',
    ink: '#111111',
    muted: '#555555',
    accent: '#006699',
    success: '#006600',
    warning: '#663300',
  },
};
const compile = (body: string, assets: HtmlLayoutAsset[] = []) =>
  compileHtmlLayout({
    html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:white;color:#111">${body}</section></body></html>`,
    pageId: 'reference-test',
    themeName: 'reach-classic',
    designContext,
    assets,
  });
const table = (body: string, id = 'data', style = '') =>
  `<table id="${id}" style="position:absolute;left:80px;top:160px;width:1200px;border-collapse:collapse;font:24px/32px Arial;${style}">${body}</table>`;
const cell = (text: string, tag = 'td', attrs = '') =>
  `<${tag} ${attrs} style="padding:10px;border:1px solid #555;background:white">${text}</${tag}>`;
const tableLayouts = [
  'native-table-full-width',
  'data-table-question-rail',
  'table-insight-band',
  'native-table-progression',
  'consulting-evidence',
  'semantic-heatmap-matrix',
  'specification-table-product-aside',
  'risk-matrix-recommendation-band',
  'management-variance-action',
];

describe('reference layout native capabilities', () => {
  it('captures same-call prepared HTML before contrast paint and table placeholders', async () => {
    const snapshots: string[] = [];
    const result = await compileHtmlLayout({
      html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:white;color:#111">${table(`<tr>${cell('Evidence')}</tr>`)}</section></body></html>`,
      pageId: 'prepared-evidence',
      themeName: 'reach-classic',
      designContext,
      assets: [],
      onPreparedHtml: (html) => {
        snapshots.push(html);
      },
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain('<table');
    expect(snapshots[0]).toContain('Evidence');
    expect(snapshots[0]).not.toContain('data-layout-fonts');
    expect(snapshots[0]).not.toContain('-webkit-text-fill-color: transparent');
    expect(result.slide.elements[0]).toMatchObject({ id: 'data', type: 'table' });
  }, 60_000);

  it('names the invalid table property without relaxing the style gate', async () => {
    await expect(
      compile(
        table(
          `<tr>${cell('Header', 'th')}${cell('Value')}</tr>`,
          'reading-table',
          'border-collapse:separate;',
        ),
      ),
    ).rejects.toThrow('invalid properties: border-collapse');
  });
  it('drops a decorative table shadow instead of failing the page', async () => {
    const result = await compile(
      table(
        `<tr>${cell('Header', 'th').replace('style="', 'style="box-shadow:0 2px 4px #0003;')}${cell('Value')}</tr>`,
        'shadowed',
        'box-shadow:0 8px 24px rgba(0,0,0,.1);',
      ),
    );
    expect(result.slide.elements.some((element) => element.id === 'shadowed')).toBe(true);
    expect(result.diagnostics).toContain(
      'NATIVE_TABLE: shadowed: decorative box-shadow dropped; native tables have no shadow',
    );
  }, 60_000);
  it('reports the actual overflow collision glyph and sibling bounds', async () => {
    const result = await compile(
      '<p id="main-title" style="position:absolute;left:80px;top:132px;width:650px;height:20px;margin:0;font:48px/60px Arial;overflow:visible">MMMMMMMMMMMM</p><div id="title-rule" style="position:absolute;left:500px;top:160px;width:200px;height:100px;background:black"></div>',
    );
    const message = result.diagnostics.find((item) =>
      item.includes('painted overflow intersects title-rule'),
    )!;
    expect(message).toBeDefined();
    const diagnostic = JSON.parse(message.slice(message.indexOf('{')));
    expect(diagnostic.collision.sibling).toEqual({ left: 500, right: 700, top: 160, bottom: 260 });
    expect(diagnostic.collision.glyph.right).toBeGreaterThan(501);
    expect(diagnostic.collision.glyph.bottom).toBeGreaterThan(161);
    expect(message.length).toBeLessThanOrEqual(1400);
  }, 60_000);
  it('gives the full trusted image repair contract for structure and style failures', async () => {
    const bytes = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#006699' },
    })
      .png()
      .toBuffer();
    const asset: HtmlLayoutAsset = {
      kind: 'image',
      assetId: 'trusted-image',
      alt: 'Evidence',
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      resource: {
        id: 'trusted-media',
        objectKey: 'scope/trusted.png',
        contentType: 'image/png',
        digest: 'sha256:fixture',
      },
    };
    const style =
      'position:absolute;left:100px;top:100px;width:600px;height:400px;object-fit:contain';
    for (const [body, expected] of [
      [
        `<figure id="image-frame"><img id="evidence-slot" data-reach-asset="trusted-image" style="${style}"></figure>`,
        'ASSET_SLOT: evidence-slot',
      ],
      [
        `<div id="evidence-slot" data-reach-asset="trusted-image" style="${style};border:10px solid black;border-radius:40px"></div>`,
        'border-top-left-radius=40px',
      ],
      [
        `<div id="evidence-slot" data-reach-asset="trusted-image" style="${style};filter:grayscale(1)"></div>`,
        'filter=grayscale(1)',
      ],
    ]) {
      const error = await compile(body!, [asset]).catch((error) => error);
      expect(error).toBeInstanceOf(HtmlLayoutValidationError);
      expect(error.message).toContain(expected);
      expect(error.message).toContain('evidence-slot');
      expect(error.message).toContain('border:0; border-radius:0');
      expect(error.message).toContain('separate slide-level siblings');
      expect(error.message.length).toBeLessThanOrEqual(1400);
    }
    const result = await compile(
      `<div id="frame" style="${style};background:#111;box-shadow:0 4px 8px #0003"></div><div id="evidence-slot" data-reach-asset="trusted-image" style="${style};border:0;border-radius:0"></div>`,
      [asset],
    );
    expect(result.resources.some((resource) => resource.id === 'trusted-media')).toBe(true);
    expect(
      result.slide.elements.some(
        (element) => element.id === 'evidence-slot' && element.type === 'image',
      ),
    ).toBe(true);
  }, 60_000);
  it('requires editable direct-child tables even without a design context', async () => {
    const body =
      '<figure id="legacy-figure" style="position:absolute;left:100px;top:100px;width:700px;height:250px;margin:0"><table style="width:100%;border-collapse:collapse;font:32px Arial"><tr><td>First</td><td>Second</td></tr></table></figure>';
    await expect(
      compileHtmlLayout({
        html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:white">${body}</section></body></html>`,
        pageId: 'legacy-table',
        themeName: 'reach-classic',
        assets: [],
      }),
    ).rejects.toThrow('NATIVE_TABLE: legacy-figure/table: tables must be direct slide children');
    await expect(compile(body)).rejects.toThrow(
      'NATIVE_TABLE: legacy-figure/table: tables must be direct slide children',
    );
  }, 60_000);

  it('compiles native tables and reports contrast without a design context', async () => {
    const result = await compileHtmlLayout({
      html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:white;color:#111">${table(`<tr>${cell('First', 'th')}${cell('Second', 'th')}</tr><tr>${cell('Evidence')}${cell('Explanation')}</tr>`)}<p id="faint" style="position:absolute;left:80px;top:400px;width:500px;height:30px;margin:0;font:16px/30px Arial;color:#aaa">Needs contrast</p></section></body></html>`,
      pageId: 'standalone-table',
      themeName: 'reach-classic',
      assets: [],
    });
    expect(result.slide.elements.find((element) => element.id === 'data')).toMatchObject({
      type: 'table',
      rows: [{ cells: [{ header: true }, { header: true }] }, { cells: [{}, {}] }],
    });
    expect(result.pendingMedia).toEqual([]);
    expect(result.diagnostics.join('\n')).toContain('CONTRAST_LOW');
    expect(result.diagnostics.join('\n')).not.toContain('AUTO_FLATTENED_COMPLEX_SUBTREE');
  }, 60_000);

  it('rejects stale library context before substituting a current registered mask', async () => {
    await expect(
      compileHtmlLayout({
        html: `<!doctype html><html><body><section id="slide" style="position:relative;width:1600px;height:900px"><div id="masked" data-reach-asset="photo" data-reach-asset-mask="${REFERENCE_LIBRARY.masks[0]!.id}" style="position:absolute;left:100px;top:100px;width:400px;height:300px"></div></section></body></html>`,
        pageId: 'stale-mask',
        themeName: 'reach-classic',
        assets: [],
        designContext: { ...designContext, librarySha256: '0'.repeat(64) },
      }),
    ).rejects.toThrow('requires a valid current reference library design context');
  }, 60_000);
  it.each(tableLayouts)(
    'compiles editable table for layout.%s-v1 with free position changes',
    async (name) => {
      expect(REFERENCE_LIBRARY.layouts.some((entry) => entry.id === `layout.${name}-v1`)).toBe(
        true,
      );
      const result = await compile(
        table(
          `<tr>${cell('Column A', 'th')}${cell('Column B', 'th')}</tr><tr>${cell('证据 A')}${cell('Evidence B')}</tr>`,
          'data',
          'left:240px;width:900px',
        ),
      );
      expect(result.slide.elements).toHaveLength(1);
      expect(result.slide.elements[0]).toMatchObject({
        type: 'table',
        transform: { x: 240, width: 900 },
        rows: [{ cells: [{ header: true }, { header: true }] }, { cells: [{}, {}] }],
      });
      expect(result.pendingMedia).toEqual([]);
      expect(JSON.stringify(result.slide)).toContain('证据 A');
      expect(result.themes).toEqual([
        createThemeResource(resolveDeckDesignTheme('reach-classic', designContext)),
      ]);
    },
    60_000,
  );

  it.each(REFERENCE_LIBRARY.masks.map((mask) => [mask.id]))(
    'preserves resource ID and alt for %s',
    async (id) => {
      const bytes = await sharp({
        create: { width: 40, height: 20, channels: 3, background: '#006699' },
      })
        .png()
        .toBuffer();
      const asset: HtmlLayoutAsset = {
        kind: 'image',
        assetId: 'evidence',
        alt: 'An educational evidence image',
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
        resource: {
          id: 'original-resource',
          objectKey: 'scope/evidence.png',
          contentType: 'image/png',
          digest: 'sha256:fixture',
        },
      };
      const result = await compile(
        `<div id="visual" data-reach-asset="evidence" data-reach-asset-mask="${id}" style="position:absolute;left:123px;top:111px;width:420px;height:260px;object-fit:cover"></div>`,
        [asset],
      );
      expect(result.slide.elements).toHaveLength(1);
      expect(result.slide.elements[0]).toMatchObject({
        id: 'visual',
        type: 'shape',
        ariaLabel: asset.alt,
        transform: { x: 123, y: 111 },
        geometry: {
          kind: 'custom',
          path: REFERENCE_LIBRARY.masks.find((mask) => mask.id === id)!.geometry.path,
        },
        style: { fill: { kind: 'image', resourceId: asset.resource.id, mode: 'cover' } },
      });
      expect(result.resources).toEqual([asset.resource]);
      expect(result.pendingMedia).toEqual([]);
      expect(result.assetBindings).toEqual([
        { assetId: 'evidence', elementId: 'visual', binding: 'shape-fill' },
      ]);
    },
    60_000,
  );

  it('supports merged headers and the full 8 by 6 grid without consuming top-level text budget', async () => {
    const result = await compile(
      table(
        `<tr>${cell('Header', 'th', 'colspan="6"')}</tr>${Array.from({ length: 7 }, (_, r) => `<tr>${Array.from({ length: 6 }, (_, c) => cell(`${r}:${c}`)).join('')}</tr>`).join('')}`,
      ),
    );
    expect(result.slide.elements[0]).toMatchObject({
      type: 'table',
      rows: [
        { cells: [{ columnSpan: 6 }] },
        ...Array.from({ length: 7 }, () => ({ cells: Array.from({ length: 6 }, () => ({})) })),
      ],
    });
  }, 60_000);

  it.each([
    [
      'caption with actionable table diagnostic',
      table(`<caption>Map tools</caption><tr>${cell('Title')}</tr>`, 'caption-table'),
      'NATIVE_TABLE: caption-table: unsupported table descendant <caption>. Remove it: put captions in separate editable slide-level text',
    ],
    [
      'colgroup with actionable table diagnostic',
      table(
        `<colgroup><col style="width:100%"></colgroup><tr>${cell('Title')}</tr>`,
        'width-table',
      ),
      'NATIVE_TABLE: width-table: unsupported table descendant <colgroup>. Remove it: put captions in separate editable slide-level text, set column widths on TH/TD',
    ],
    [
      'nested figure',
      `<figure>${table(`<tr>${cell('Cannot flatten')}</tr>`)}</figure>`,
      'direct slide children',
    ],
    [
      'too many rows',
      table(Array.from({ length: 9 }, () => `<tr>${cell('A')}</tr>`).join('')),
      'exceeds the 8x6 budget; kept because it fits the slide',
    ],
    [
      'too many columns',
      table(`<tr>${Array.from({ length: 7 }, () => cell('A')).join('')}</tr>`),
      'exceeds the 8x6 budget; kept because it fits the slide',
    ],
    [
      'cell text budget',
      table(`<tr>${cell('A '.repeat(121))}</tr>`),
      'a cell exceeds 240 Unicode codepoints',
    ],
    [
      'page text budget',
      table(
        Array.from(
          { length: 8 },
          () => `<tr>${Array.from({ length: 6 }, () => cell('x '.repeat(30))).join('')}</tr>`,
        ).join(''),
      ),
      'page table text exceeds 2400 Unicode codepoints',
    ],
    [
      'ink overflow under budget',
      table(
        `<tr><td style="max-width:50px;width:50px;white-space:nowrap">${'Very long evidence '.repeat(8)}</td>${cell('B')}</tr>`,
        'data',
        'table-layout:fixed;width:100px',
      ),
      'text exceeds',
    ],
    [
      'clipped cell',
      table(
        `<tr><td style="padding:0;overflow:hidden;height:8px;line-height:8px">Evidence</td></tr>`,
      ),
      'text',
    ],
    [
      'page grid budget',
      table(
        Array.from(
          { length: 8 },
          () => `<tr>${Array.from({ length: 6 }, () => cell('A')).join('')}</tr>`,
        ).join(''),
      ) + table(`<tr>${cell('B')}</tr>`, 'extra', 'top:700px'),
      'page grid exceeds 48 positions',
    ],
    [
      'low contrast',
      '<p style="position:absolute;left:100px;top:100px;font:16px Arial;color:#aaa">Unreadable</p>',
      'CONTRAST_LOW',
    ],
    [
      'gradient contrast',
      '<div style="position:absolute;inset:0;background:linear-gradient(white,#000)"></div><p style="position:absolute;left:100px;top:50px;font:16px Arial;color:white">Unreadable</p>',
      'CONTRAST_LOW',
    ],
    [
      'informative graphics',
      '<div data-reach-informative="true" style="position:absolute;left:100px;top:100px;width:300px;height:200px;background:#ccc"></div>',
      'CONTRAST_LOW',
    ],
    [
      'heatmap adjacent colors',
      table(
        '<tr><td style="padding:12px;background:#aaa">A</td><td style="padding:12px;background:#ccc">B</td></tr>',
      ).replace('<table ', '<table data-reach-heatmap '),
      'adjacent informative table colors',
    ],
    [
      'unmeasurable text opacity',
      '<p style="position:absolute;left:100px;top:100px;font:32px Arial;opacity:.5">Text</p>',
      'CONTRAST_UNMEASURABLE',
    ],
    [
      'alternate text fill',
      '<p style="position:absolute;left:100px;top:100px;font:32px Arial;color:#111;-webkit-text-fill-color:#eee">Unreadable</p>',
      'CONTRAST_UNMEASURABLE',
    ],
    [
      'nested text clipping',
      table(
        '<tr><td><span style="display:inline-block;width:30px;white-space:nowrap;overflow:hidden">Clipped evidence</span></td></tr>',
      ),
      'clipped by a nested',
    ],
    [
      'cell covered by another element',
      table(`<tr>${cell('Evidence')}</tr>`) +
        '<div style="position:absolute;left:80px;top:160px;width:1200px;height:80px;background:white"></div>',
      'obscured',
    ],
  ])(
    'keeps %s in its structural or diagnostic category',
    async (name, body, message) => {
      if (
        [
          'too many rows',
          'too many columns',
          'cell text budget',
          'page text budget',
          'page grid budget',
          'ink overflow under budget',
          'clipped cell',
          'low contrast',
          'gradient contrast',
          'informative graphics',
          'heatmap adjacent colors',
          'unmeasurable text opacity',
          'alternate text fill',
          'nested text clipping',
          'cell covered by another element',
        ].includes(name)
      ) {
        const result = await compile(body);
        expect(result.diagnostics.join('\n')).toContain(message);
        expect(result.slide.elements.length).toBeGreaterThan(0);
        if (body.includes('<table'))
          expect(result.slide.elements.some((element) => element.type === 'table')).toBe(true);
        return;
      }
      const error: unknown = await compile(body).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HtmlLayoutValidationError);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message.length).toBeLessThan(2000);
    },
    60_000,
  );

  it('allows opaque carriers over gradient and decorative colors without enforcing reference geometry', async () => {
    const result = await compile(
      '<div style="position:absolute;inset:0;background:linear-gradient(white,#111)"></div><p style="position:absolute;left:630px;top:400px;width:600px;height:80px;margin:0;background:white;color:#111;font:32px/60px Arial">Readable carrier</p><div style="position:absolute;left:150px;top:600px;width:200px;height:80px;background:#eee"></div>',
    );
    expect(
      result.slide.elements.some(
        (element) => element.type === 'textFrame' && element.transform.x === 630,
      ),
    ).toBe(true);
  }, 60_000);

  it('preserves row spans, inline formatting and inherited table fill', async () => {
    const result = await compile(
      table(
        '<tr><th rowspan="2" style="padding:12px">Header</th><td style="padding:12px"><strong>First</strong></td></tr><tr><td style="padding:12px"><em>Second</em></td></tr>',
        'merged',
        'background:#eee',
      ),
    );
    expect(result.slide.elements[0]).toMatchObject({
      type: 'table',
      rows: [
        {
          cells: [
            { rowSpan: 2, header: true, style: { fill: { color: { value: '#eeeeee' } } } },
            {},
          ],
        },
        { cells: [{}] },
      ],
    });
    expect(JSON.stringify(result.slide)).toContain('"fontWeight":700');
    expect(JSON.stringify(result.slide)).toContain('"type":"italic"');
  }, 60_000);

  it('keeps a measured-fit table beyond the column budget', async () => {
    const headers = ['篇目', '寓意', '起因', '结局', '原因', '细节', '分析'];
    const result = await compile(
      table(
        `<tr>${headers.map((text) => cell(text, 'th')).join('')}</tr>` +
          Array.from({ length: 2 }, () => `<tr>${headers.map(() => cell('')).join('')}</tr>`).join(
            '',
          ),
        'framework',
        'width:1440px',
      ),
    );
    const element = result.slide.elements.find((item) => item.id === 'framework');
    if (element?.type !== 'table') throw new Error('expected table');
    expect(element.columnWidths).toHaveLength(7);
    expect(element.rows[0]!.cells).toHaveLength(7);
    expect(result.diagnostics).toContain(
      'NATIVE_TABLE: framework: 3x7 grid exceeds the 8x6 budget; kept because it fits the slide',
    );
  }, 60_000);

  it('merges overflow columns into the last column when the table does not fit', async () => {
    const wide = (text: string, tag = 'td') =>
      `<${tag} style="padding:10px;border:1px solid #555;background:white;white-space:nowrap">${text}</${tag}>`;
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const result = await compile(
      table(
        `<tr>${letters.map((letter) => wide(`Header ${letter} long label`, 'th')).join('')}</tr>` +
          `<tr>${letters.map((letter) => wide(`Value ${letter}`)).join('')}</tr>`,
        'wide',
        'table-layout:fixed;width:1440px',
      ),
    );
    const element = result.slide.elements.find((item) => item.id === 'wide');
    expect(element).toMatchObject({ type: 'table' });
    if (element?.type !== 'table') throw new Error('expected table');
    expect(element.columnWidths).toHaveLength(6);
    const lastHeader = JSON.stringify(element.rows[0]!.cells[5]!.text.doc);
    expect(lastHeader).toContain('Header F long label');
    expect(lastHeader).toContain('／');
    expect(lastHeader).toContain('Header G long label');
    const lastValue = JSON.stringify(element.rows[1]!.cells[5]!.text.doc);
    expect(lastValue).toContain('Value F');
    expect(lastValue).toContain('"hardBreak"');
    expect(lastValue).toContain('Value G');
    expect(result.diagnostics.join('\n')).toContain(
      'NATIVE_TABLE: wide: 2x7 grid exceeds the 8x6 budget and does not fit; merged overflow into the last column/row (now 2x6)',
    );
  }, 60_000);

  it('merges overflow rows into the last row when the table does not fit', async () => {
    const tall = (text: string) =>
      `<td style="padding:30px;border:1px solid #555;background:white">${text}</td>`;
    const result = await compile(
      table(
        Array.from({ length: 9 }, (_, index) => `<tr>${tall(`Row ${index + 1}`)}</tr>`).join(''),
        'tall',
      ),
    );
    const element = result.slide.elements.find((item) => item.id === 'tall');
    if (element?.type !== 'table') throw new Error('expected table');
    expect(element.rows).toHaveLength(8);
    const lastRow = JSON.stringify(element.rows[7]!.cells[0]!.text.doc);
    expect(lastRow).toContain('Row 8');
    expect(lastRow).toContain('Row 9');
    expect(result.diagnostics.join('\n')).toContain(
      'merged overflow into the last column/row (now 8x1)',
    );
  }, 60_000);

  it('drops generated table underline and reports it as a diagnostic', async () => {
    const result = await compile(
      table(
        `<tr>${cell('<u>Key</u> term')}${cell('<span style="text-decoration:underline">Span</span>')}</tr>`,
        'underlined',
      ),
    );
    const slide = JSON.stringify(result.slide);
    expect(slide).not.toContain('"type":"underline"');
    expect(slide).toContain('Key');
    expect(result.diagnostics.filter((message) => message.includes('underline dropped'))).toEqual([
      'NATIVE_TABLE: underlined: cell 1:1 underline dropped; generated text is never underlined',
      'NATIVE_TABLE: underlined: cell 1:2 underline dropped; generated text is never underlined',
    ]);
  }, 60_000);

  it('applies large-text 3:1 threshold while keeping small text at 4.5:1', async () => {
    const text = (size: number) =>
      `<p style="position:absolute;left:100px;top:100px;margin:0;width:600px;height:90px;font:${size}px/60px Arial;color:#888">Contrast threshold</p>`;
    await expect(compile(text(24))).resolves.toHaveProperty('slide');
    expect((await compile(text(16))).diagnostics.join('\n')).toContain('requires 4.5:1');
  }, 60_000);

  it('ignores low contrast paint inside word-spacing gaps without ignoring glyph backgrounds', async () => {
    const label =
      '<p style="position:absolute;left:100px;top:100px;margin:0;width:900px;height:80px;font:32px/60px Arial;color:#111;word-spacing:300px">First Last</p>';
    await expect(
      compile(
        '<div style="position:absolute;left:230px;top:100px;width:180px;height:80px;background:#111"></div>' +
          label,
      ),
    ).resolves.toHaveProperty('slide');
    await expect(
      compile(
        '<div style="position:absolute;left:100px;top:100px;width:160px;height:80px;background:#111"></div>' +
          label,
      ),
    ).resolves.toHaveProperty(
      'diagnostics',
      expect.arrayContaining([expect.stringContaining('CONTRAST_LOW')]),
    );
  }, 60_000);

  it('reports text matching its background even though the original raster has no visible ink', async () => {
    await expect(
      compile(
        '<p style="position:absolute;left:100px;top:100px;margin:0;width:600px;height:80px;font:32px/60px Arial;color:white">Invisible text</p>',
      ),
    ).resolves.toHaveProperty(
      'diagnostics',
      expect.arrayContaining([expect.stringContaining('CONTRAST_LOW')]),
    );
  }, 60_000);

  it('uses painted glyphs rather than the entire non-whitespace word rectangle', async () => {
    await expect(
      compile(
        '<div style="position:absolute;left:200px;top:100px;width:100px;height:80px;background:#111"></div><p style="position:absolute;left:100px;top:100px;margin:0;width:900px;height:80px;font:32px/60px Arial;color:#111;letter-spacing:300px">AB</p>',
      ),
    ).resolves.toHaveProperty('slide');
  }, 60_000);

  it('reports the owning text ID, excerpt and composited colors for developer inspection', async () => {
    const result = await compile(
      '<p id="stage-labels" style="position:absolute;left:100px;top:100px;margin:0;width:800px;height:80px;font:32px/60px Arial"><span style="color:#aaa">Visible label</span></p>',
    );
    const message = result.diagnostics.join('\n');
    expect(message).toContain('stage-labels');
    expect(message).toContain('Visible label');
    expect(message).toContain('foreground rgba(170,170,170,255)');
    expect(message).toContain('background rgb(255,255,255)');
    expect(message.length).toBeLessThan(1800);
  }, 60_000);

  it('charges all glyph-mask captures to the existing aggregate decoded-pixel budget', async () => {
    const bytes = await sharp({
      create: { width: 4000, height: 3750, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const assets: HtmlLayoutAsset[] = Array.from({ length: 4 }, (_, i) => ({
      kind: 'image',
      assetId: `budget-${i}`,
      alt: 'Evidence',
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      resource: {
        id: `media-${i}`,
        objectKey: `scope/${i}.png`,
        contentType: 'image/png',
        digest: 'sha256:fixture',
      },
    }));
    const body = assets
      .map(
        (asset, i) =>
          `<div data-reach-asset="${asset.assetId}" style="position:absolute;left:${i * 380}px;top:100px;width:360px;height:600px"></div>`,
      )
      .join('');
    // 60M input pixels + one capture fits; all three required captures exceed the unchanged64M cap.
    await expect(compile(body, assets)).rejects.toThrow('decoded pixel budget');
  }, 60_000);

  it('reports independent low contrast labels together as developer diagnostics', async () => {
    const label = (id: string, top: number, color: string) =>
      `<p id="${id}" style="position:absolute;left:100px;top:${top}px;margin:0;width:900px;height:60px;font:32px/60px Arial;color:${color}">${id}</p>`;
    const result = await compile(
      label('first-problem', 100, '#aaa') +
        label('readable-label', 200, '#111') +
        label('second-problem', 300, '#bbb'),
    );
    const message = result.diagnostics.join('\n');
    expect(message).toContain('first-problem');
    expect(message).toContain('second-problem');
    expect(message).not.toContain('readable-label');
    expect(message).toContain('requires 3:1');
    expect(message.length).toBeLessThanOrEqual(1400);
  }, 60_000);

  it('reports all independent contrast samples without a correction gate', async () => {
    const body = Array.from(
      { length: 8 },
      (_, index) =>
        `<p id="problem-${index}" style="position:absolute;left:100px;top:${60 + index * 80}px;margin:0;width:900px;height:60px;font:32px/60px Arial;color:#aaa">Unreadable evidence ${index}</p>`,
    ).join('');
    const result = await compile(body);
    expect(result.diagnostics.filter((message) => message.includes('requires 3:1'))).toHaveLength(
      8,
    );
    expect(result.diagnostics.join('\n')).toContain('problem-7');
    expect(result.diagnostics.every((message) => message.length <= 1800)).toBe(true);
  }, 60_000);

  it('accepts 18 and 40 independent text elements without charging table cells to text budget', async () => {
    const body = (count: number) =>
      Array.from(
        { length: count },
        (_, i) =>
          `<p id="text-${i}" style="position:absolute;left:${80 + Math.floor(i / 20) * 700}px;top:${(i % 20) * 34}px;width:600px;height:32px;margin:0;font:24px/32px Arial">Text ${i}</p>`,
      ).join('') + table(`<tr>${cell('Table cell')}</tr>`, 'data', 'top:720px');
    for (const count of [18, 40]) {
      const result = await compile(body(count));
      expect(result.slide.elements.filter((element) => element.type === 'textFrame')).toHaveLength(
        count,
      );
      expect(result.slide.elements.filter((element) => element.type === 'table')).toHaveLength(1);
      expect(result.slide.elements).toHaveLength(count + 1);
    }
    await expect(compile(body(41))).rejects.toThrow('editable text elements 41/40');
  }, 60_000);

  it('retains the total decoded pixel budget for a four-image reference page plus inline visuals', async () => {
    const bytes = await sharp({
      create: { width: 4000, height: 4000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    const assets: HtmlLayoutAsset[] = Array.from({ length: 4 }, (_, i) => ({
      kind: 'image',
      assetId: `asset-${i}`,
      alt: 'Evidence',
      dataUrl,
      resource: {
        id: `media-${i}`,
        objectKey: `scope/${i}.png`,
        contentType: 'image/png',
        digest: 'sha256:fixture',
      },
    }));
    await expect(
      validateHtmlLayoutInput({
        html: `<!doctype html><html><body><section id="slide"><img src="${dataUrl}"></section></body></html>`,
        pageId: 'pixel-budget',
        themeName: 'reach-classic',
        designContext,
        assets,
      }),
    ).rejects.toThrow('total pixel budget');
  });

  it('preserves readable page-level stylesheet color overrides', async () => {
    const result = await compile(
      '<style>#slide{background:#111!important;color:white!important}</style><p style="position:absolute;left:100px;top:100px;font:32px Arial">Local contrast</p>',
    );
    expect(result.slide.background).toMatchObject({ kind: 'solid', color: { value: '#111111' } });
  }, 60_000);
});
