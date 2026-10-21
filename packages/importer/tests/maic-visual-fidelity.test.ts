import { describe, expect, it } from 'vitest';
import { mapMaicToReachDeckV2, parseMaicCourse } from '../src/maic/index.js';

function mapElements(elements: Record<string, unknown>[]) {
  const parsed = parseMaicCourse(
    JSON.stringify({
      title: 'Visual fixture',
      width: 1280,
      height: 720,
      slides: [
        {
          id: 'canvas',
          component_type: 'canvas',
          canvas_width: 1280,
          canvas_height: 720,
          elements: elements.map((element) => ({
            left: 20,
            top: 40,
            width: 200,
            height: 100,
            ...element,
          })),
        },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return mapMaicToReachDeckV2(parsed.ir, {
    documentId: 'fixture',
    applicationId: 'fixture',
    title: 'Visual fixture',
    language: 'en-US',
    generatedAt: '2026-09-08T00:00:00Z',
    compatibilityTheme: {
      name: 'Fixture',
      background: '#FFFFFF',
      surface: '#FFFFFF',
      ink: '#000000',
      muted: '#666666',
      accent: '#FF0000',
      success: '#008000',
      warning: '#FF8800',
      fontDisplay: 'Noto Sans',
      fontBody: 'Noto Sans',
    },
    media: Object.fromEntries(
      parsed.ir.mediaReferences.map((ref) => [
        ref.id,
        {
          objectKey: ref.id,
          contentType: 'image/png',
          digest: `sha256:${'a'.repeat(64)}` as const,
        },
      ]),
    ),
  });
}

function mapBackgrounds(backgrounds: unknown[], resolveMedia = true) {
  const parsed = parseMaicCourse(
    JSON.stringify({
      title: 'Background fixture',
      width: 1280,
      height: 720,
      slides: backgrounds.map((background, index) => ({
        id: `canvas-${index + 1}`,
        component_type: 'canvas',
        canvas_width: 1280,
        canvas_height: 720,
        background,
        elements: [],
      })),
    }),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return mapMaicToReachDeckV2(parsed.ir, {
    documentId: 'background-fixture',
    applicationId: 'background-fixture',
    title: 'Background fixture',
    language: 'en-US',
    generatedAt: '2026-09-08T00:00:00Z',
    compatibilityTheme: {
      name: 'Fixture',
      background: '#FFFFFF',
      surface: '#FFFFFF',
      ink: '#000000',
      muted: '#666666',
      accent: '#FF0000',
      success: '#008000',
      warning: '#FF8800',
      fontDisplay: 'Noto Sans',
      fontBody: 'Noto Sans',
    },
    ...(resolveMedia
      ? {
          media: Object.fromEntries(
            parsed.ir.mediaReferences.map((ref) => [
              ref.id,
              {
                objectKey: ref.id,
                contentType: 'image/png',
                digest: `sha256:${'b'.repeat(64)}` as const,
              },
            ]),
          ),
        }
      : {}),
  });
}

describe('MAIC visual fidelity', () => {
  it('preserves the confirmed nested cover image background as a managed native fill', () => {
    const mapped = mapBackgrounds([
      {
        type: 'image',
        image: { src: 'https://file.maic.chat/background.png', size: 'cover' },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.document.resources.media).toHaveLength(1);
    expect(mapped.document.nativeSlides[0]!.slide.background).toEqual({
      kind: 'image',
      resourceId: mapped.document.resources.media[0]!.id,
      mode: 'cover',
    });
  });

  it('makes a registered but unresolved cover background a page error', () => {
    const mapped = mapBackgrounds(
      [
        {
          type: 'image',
          image: { src: 'https://file.maic.chat/background.png', size: 'cover' },
        },
      ],
      false,
    );

    expect(mapped.ok).toBe(false);
    expect(mapped.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'maic.resource.unresolved', severity: 'error' }),
      ]),
    );
  });

  it('does not fetch unsupported image-background sizes before degrading to white', () => {
    const mapped = mapBackgrounds([
      {
        type: 'image',
        image: { src: 'https://file.maic.chat/background.png', size: 'contain' },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([
      expect.objectContaining({ code: 'maic.canvas.background_degraded', severity: 'warning' }),
    ]);
    expect(mapped.document.resources.media).toEqual([]);
    expect(mapped.document.nativeSlides[0]!.slide.background).toEqual({
      kind: 'solid',
      color: { kind: 'srgb', value: '#FFFFFF' },
    });
  });

  it('preserves valid linear and radial canvas gradient backgrounds', () => {
    const mapped = mapBackgrounds([
      {
        type: 'gradient',
        gradient: {
          type: 'linear',
          rotate: 0,
          colors: [
            { pos: 0, color: 'rgb(218,229,240)' },
            { pos: 100, color: '#fff' },
          ],
        },
      },
      {
        type: 'gradient',
        gradient: {
          type: 'radial',
          rotate: 45,
          colors: [
            { pos: 0, color: '#FFFFFF00' },
            { pos: 100, color: '#FFFFFFCC' },
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.document.nativeSlides.map((binding) => binding.slide.background)).toEqual([
      {
        kind: 'gradient',
        angle: 90,
        stops: [
          { offset: 0, color: { kind: 'srgb', value: '#DAE5F0' } },
          { offset: 1, color: { kind: 'srgb', value: '#FFFFFF' } },
        ],
      },
      {
        kind: 'gradient',
        gradientType: 'radial',
        angle: 135,
        stops: [
          { offset: 0, color: { kind: 'srgb', value: '#FFFFFF', alpha: 0 } },
          {
            offset: 1,
            color: { kind: 'srgb', value: '#FFFFFF', alpha: 0.8 },
          },
        ],
      },
    ]);
  });

  it.each([
    { type: 'gradient', gradient: { type: 'linear', rotate: 0, colors: [] } },
    {
      gradient: {
        type: 'linear',
        rotate: 0,
        colors: [
          { pos: 0, color: '#000000' },
          { pos: 100, color: '#FFFFFF' },
        ],
      },
    },
    { type: 'solid', color: 'not-a-color' },
    {
      type: 'gradient',
      gradient: {
        type: 'linear',
        rotate: 0,
        colors: [
          { pos: 100, color: '#FFFFFF' },
          { pos: 0, color: '#000000' },
        ],
      },
    },
    {
      type: 'image',
      src: 'https://file.maic.chat/background.png',
      gradient: {
        type: 'linear',
        rotate: 0,
        colors: [
          { pos: 0, color: '#000000' },
          { pos: 100, color: '#FFFFFF' },
        ],
      },
    },
    {
      type: 'mesh',
      color: '#123456',
      gradient: {
        type: 'linear',
        rotate: 0,
        colors: [
          { pos: 0, color: '#000000' },
          { pos: 100, color: '#FFFFFF' },
        ],
      },
    },
  ])('warns and uses white for unsupported or malformed background %#', (background) => {
    const mapped = mapBackgrounds([background]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([
      expect.objectContaining({
        code: 'maic.canvas.background_degraded',
        severity: 'warning',
      }),
    ]);
    expect(mapped.document.nativeSlides[0]!.slide.background).toEqual({
      kind: 'solid',
      color: { kind: 'srgb', value: '#FFFFFF' },
    });
  });

  it('preserves a valid legacy canvas solid without a type discriminator', () => {
    const mapped = mapBackgrounds([{ color: '#123456' }]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.document.nativeSlides[0]!.slide.background).toEqual({
      kind: 'solid',
      color: { kind: 'srgb', value: '#123456' },
    });
  });

  it('does not let nested gradient metadata override an explicit solid background', () => {
    const mapped = mapBackgrounds([
      {
        type: 'solid',
        color: '#123456',
        gradient: {
          type: 'linear',
          rotate: 0,
          colors: [
            { pos: 0, color: '#000000' },
            { pos: 100, color: '#FFFFFF' },
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.document.nativeSlides[0]!.slide.background).toEqual({
      kind: 'solid',
      color: { kind: 'srgb', value: '#123456' },
    });
  });

  it('keeps zero-width outlines invisible and scales table text with its geometry', () => {
    const mapped = mapElements([
      {
        id: 'shape',
        type: 'shape',
        outline: { width: 0, color: '#FF0000' },
        text: { content: '<div style="padding:-4px"><p>Safe</p></div>' },
      },
      {
        id: 'table',
        type: 'table',
        colWidths: [200],
        rowHeights: [100],
        data: [
          [
            {
              text: '<div style="padding:4px"><p><span style="font-size:32px">Cell</span></p></div>',
            },
          ],
        ],
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
    expect(mapped.diagnostics).toEqual([]);
    const elements = mapped.document.nativeSlides[0]!.slide.elements;
    expect(elements[0]).toMatchObject({
      style: { stroke: { width: 1, fill: { alpha: 0 } } },
      text: { margins: { top: 0, right: 0, bottom: 0, left: 0 } },
    });
    expect(elements[1]).toMatchObject({
      type: 'table',
      columnWidths: [250],
      rowHeights: [125],
      rows: [
        {
          cells: [
            {
              text: {
                margins: { top: 5, right: 5, bottom: 5, left: 5 },
                doc: {
                  content: [
                    { content: [{ marks: [{ type: 'textStyle', attrs: { fontSize: '40px' } }] }] },
                  ],
                },
              },
            },
          ],
        },
      ],
    });
  });

  it('preserves proportional legacy table widths and derives rows from cellMinHeight', () => {
    const mapped = mapElements([
      {
        id: 'legacy-table',
        type: 'table',
        width: 400,
        height: 120,
        colWidths: [0.25, 0.75],
        cellMinHeight: 50,
        data: [
          [{ text: 'A' }, { text: 'B' }],
          [{ text: 'C' }, { text: 'D' }],
        ],
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
      type: 'table',
      columnWidths: [0.3125, 0.9375],
      rowHeights: [75, 75],
    });
  });

  it('imports MAIC full-grid tables that keep placeholder cells for merged spans', () => {
    // MAIC 导出表格时保留被合并覆盖的单元格作为空占位（每行长度恒等于列数），
    // 与省略被覆盖格的 HTML 语义不同。这里的表格按 HTML 语义读会算出 4 列里塞了
    // 5 格，曾被判成 maic.table.invalid 让整页导不进来。
    const mapped = mapElements([
      {
        id: 'full-grid-table',
        type: 'table',
        width: 400,
        height: 120,
        colWidths: [0.25, 0.25, 0.25, 0.25],
        rowHeights: [40, 40, 40],
        data: [
          [{ text: 'A' }, { text: 'B', colspan: 2 }, { text: '' }, { text: 'C' }],
          [{ text: 'D', rowspan: 2 }, { text: 'E' }, { text: 'F' }, { text: 'G' }],
          [{ text: '' }, { text: 'H' }, { text: 'I' }, { text: 'J' }],
        ],
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([]);
    const element = mapped.document.nativeSlides[0]!.slide.elements[0];
    if (element?.type !== 'table') throw new Error('Expected a table element.');
    // 占位格被剔除，只留合并起点，跨度交给渲染层。
    expect(
      element.rows.map((row) => row.cells.map((cell) => `${cell.rowSpan}x${cell.columnSpan}`)),
    ).toEqual([
      ['1x1', '1x2', '1x1'],
      ['2x1', '1x1', '1x1', '1x1'],
      ['1x1', '1x1', '1x1'],
    ]);
  });

  it.each([
    {
      name: 'a minimum row height that cannot fit',
      table: {
        colWidths: [0.5, 0.5],
        cellMinHeight: 61,
        data: [
          [{ text: 'A' }, { text: 'B' }],
          [{ text: 'C' }, { text: 'D' }],
        ],
      },
    },
    {
      name: 'ragged rows',
      table: {
        colWidths: [0.5, 0.5],
        cellMinHeight: 50,
        data: [[{ text: 'A' }, { text: 'B' }], [{ text: 'C' }]],
      },
    },
    {
      name: 'a span outside the declared grid',
      table: {
        colWidths: [0.5, 0.5],
        cellMinHeight: 50,
        data: [[{ text: 'A', colspan: 3 }], [{ text: 'C' }, { text: 'D' }]],
      },
    },
    {
      name: 'malformed explicit row heights',
      table: {
        colWidths: [0.5, 0.5],
        rowHeights: [120],
        cellMinHeight: 50,
        data: [
          [{ text: 'A' }, { text: 'B' }],
          [{ text: 'C' }, { text: 'D' }],
        ],
      },
    },
  ])('keeps rejecting legacy tables with $name', ({ table }) => {
    const mapped = mapElements([
      { id: 'invalid-legacy-table', type: 'table', width: 400, height: 120, ...table },
    ]);

    expect(mapped.ok).toBe(false);
    expect(mapped.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'maic.table.invalid', severity: 'error' }),
      ]),
    );
  });

  it('retains a full page when image cropping extends beyond the bitmap', () => {
    const mapped = mapElements([
      {
        id: 'image',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: {
          shape: 'rect',
          range: [
            [46.229, 7.861],
            [96.888, 100.243],
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.document.pages).toHaveLength(1);
    const image = mapped.document.nativeSlides[0]!.slide.elements[0]!;
    expect(image.type).toBe('image');
    if (image.type !== 'image') return;
    expect(image.fit).toBe('stretch');
    expect(image.crop?.bottom).toBeCloseTo(-0.00243);
    expect(image.crop?.left).toBeCloseTo(0.46229);
  });

  it('retains a rounded MAIC image clip as an explicitly degraded rectangular crop', () => {
    const mapped = mapElements([
      {
        id: 'rounded-image',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: {
          shape: 'roundRect',
          range: [
            [8.823, 0],
            [91.177, 100],
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.document.pages).toHaveLength(1);
    expect(mapped.pageReports[0]).toMatchObject({ status: 'warning' });
    expect(mapped.diagnostics).toEqual([
      expect.objectContaining({
        code: 'maic.image.rounded_clip_degraded',
        severity: 'warning',
      }),
    ]);
    const image = mapped.document.nativeSlides[0]!.slide.elements[0]!;
    expect(image.type).toBe('image');
    if (image.type !== 'image') return;
    expect(image.crop?.left).toBeCloseTo(0.08823);
    expect(image.crop?.top).toBe(0);
    expect(image.crop?.right).toBeCloseTo(0.08823);
    expect(image.crop?.bottom).toBe(0);
  });

  it('renders an elliptical MAIC image clip as an ellipse shape with an image fill', () => {
    // ellipse 是 MAIC 的一等裁剪形状。曾被当成未知形状判 error（《两宋绘画2》
    // 50 页里丢 6 页），之后降级成外接矩形；现在映射成椭圆 shape + 图片填充，
    // 渲染器按轮廓裁剪，椭圆得以真正保留。
    const mapped = mapElements([
      {
        id: 'ellipse-image',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: {
          shape: 'ellipse',
          range: [
            [10, 20],
            [90, 80],
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.document.pages).toHaveLength(1);
    expect(mapped.pageReports[0]).toMatchObject({ status: 'warning' });
    expect(mapped.diagnostics).toEqual([
      expect.objectContaining({ code: 'maic.image.ellipse_clip_as_shape', severity: 'warning' }),
    ]);

    const element = mapped.document.nativeSlides[0]!.slide.elements[0]!;
    expect(element.type).toBe('shape');
    if (element.type !== 'shape') return;
    expect(element.geometry).toEqual({ kind: 'preset', preset: 'ellipse' });
    expect(element.style.fill?.kind).toBe('image');
    if (element.style.fill?.kind !== 'image') return;
    expect(element.style.fill.mode).toBe('stretch');
    // srcRect [0.1,0.9]x[0.2,0.8] → fillRect：宽度 1/0.8=1.25、高度 1/0.6≈1.667，
    // 裁剪窗口正好铺满盒子，多出的部分作为负向出血被椭圆轮廓裁掉。
    expect(element.style.fill.insets?.left).toBeCloseTo(-0.125);
    expect(element.style.fill.insets?.right).toBeCloseTo(-0.125);
    expect(element.style.fill.insets?.top).toBeCloseTo(-1 / 3);
    expect(element.style.fill.insets?.bottom).toBeCloseTo(-1 / 3);
  });

  it('maps a full-range elliptical clip to an uninset image fill', () => {
    const mapped = mapElements([
      {
        id: 'ellipse-full',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: {
          shape: 'ellipse',
          range: [
            [0, 0],
            [100, 100],
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
    const element = mapped.document.nativeSlides[0]!.slide.elements[0]!;
    if (element.type !== 'shape' || element.style.fill?.kind !== 'image')
      throw new Error('expected an ellipse shape with an image fill');
    expect(element.style.fill.insets).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('imports MAIC crop windows that reach past the bitmap edge', () => {
    // MAIC 会把裁剪窗口开到原图两倍多高（底边 226.8%），意思是图片只占框的上
    // 44%、下面留透明边。原来 range[1] 卡在 200 以内，这类图会落 invalid_crop
    // 把整页判废——【基础】梳理故事 20 页里有 13 页是这么丢的。
    const mapped = mapElements([
      {
        id: 'deep-bleed-crop',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: {
          shape: 'rect',
          range: [
            [0, 0],
            [38.01, 226.8],
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics).toEqual([]);
    const element = mapped.document.nativeSlides[0]!.slide.elements[0];
    if (element?.type !== 'image') throw new Error('Expected an image element.');
    expect(element.crop).toMatchObject({ left: 0, top: 0, right: 0.6199 });
    // 1 - 226.8/100 的浮点尾差，断言到小数点后十位即可。
    expect(element.crop!.bottom).toBeCloseTo(-1.268, 10);
  });

  it('degrades an ellipse clip too narrow for fill insets instead of failing the import', () => {
    // 椭圆裁剪走 shape + 图片填充，insets = -sx0/sw 之类；裁剪窗口窄到原图 9% 时
    // right 会算到 -10.11，越过 DSL 对 fill.insets 的 [-10, 1]，整份课件会退成
    // maic.mapping.invalid_document fatal，连同别的好页一起导不进来。
    const mapped = mapElements([
      {
        id: 'narrow-ellipse-clip',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: {
          shape: 'ellipse',
          range: [
            [0, 0],
            [9, 100],
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'maic.image.ellipse_clip_degraded',
    );
    expect(mapped.diagnostics.filter((diagnostic) => diagnostic.severity !== 'warning')).toEqual(
      [],
    );
    // 退回普通图片 + 矩形裁剪，页面照常导入。
    const element = mapped.document.nativeSlides[0]!.slide.elements[0];
    if (element?.type !== 'image') throw new Error('Expected an image element.');
    expect(element.crop).toMatchObject({ left: 0, top: 0, right: 0.91, bottom: 0 });
  });

  it('still maps an ellipse clip whose insets stay inside the fill bounds', () => {
    const mapped = mapElements([
      {
        id: 'wide-ellipse-clip',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: {
          shape: 'ellipse',
          range: [
            [0, 0],
            [10, 100],
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));

    expect(mapped.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      'maic.image.ellipse_clip_degraded',
    );
    const element = mapped.document.nativeSlides[0]!.slide.elements[0];
    if (element?.type !== 'shape' || element.style.fill?.kind !== 'image')
      throw new Error('expected an ellipse shape with an image fill');
    expect(element.style.fill.insets).toMatchObject({ left: 0, top: 0, bottom: 0 });
    expect(element.style.fill.insets!.right).toBeCloseTo(-9, 10);
  });

  it('keeps unknown image clip shapes as page errors', () => {
    const mapped = mapElements([
      {
        id: 'unknown-clip',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: {
          shape: 'star',
          range: [
            [0, 0],
            [100, 100],
          ],
        },
      },
    ]);

    expect(mapped.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'maic.image.invalid_crop', severity: 'error' }),
      ]),
    );
  });

  it.each([
    [
      [50, 0],
      [50, 100],
    ],
    [
      [0, 0],
      [100, 1101],
    ],
  ])('diagnoses an invalid crop window %j', (start, end) => {
    const mapped = mapElements([
      {
        id: 'image',
        type: 'image',
        src: 'https://file.maic.chat/fixture.png',
        clip: { shape: 'rect', range: [start, end] },
      },
    ]);
    expect(mapped.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'maic.image.invalid_crop', severity: 'error' }),
      ]),
    );
  });

  it('retains managed media referenced only by shape fills and preserves paths and alpha', () => {
    const mapped = mapElements([
      {
        id: 'shape',
        type: 'shape',
        pattern: 'https://file.maic.chat/fill.png',
        viewBox: [200, 200],
        path: 'M 0 100 L 100 0 L 200 100 L 100 200 Z',
        opacity: 0.4,
        outline: { color: 'rgba(255, 0, 0, 0.5)', width: 2 },
        text: { content: '<p>Caption</p>' },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
    expect(mapped.diagnostics).toEqual([]);
    const element = mapped.document.nativeSlides[0]!.slide.elements[0]!;
    expect(element).toMatchObject({
      type: 'shape',
      opacity: 0.4,
      text: { doc: { content: [{ attrs: { fontSize: 20, lineHeight: 1.2 } }] } },
      geometry: {
        kind: 'custom',
        viewBox: { width: 200, height: 200 },
        path: 'M 0 100 L 100 0 L 200 100 L 100 200 Z',
      },
      style: {
        fill: { kind: 'image', mode: 'cover' },
        stroke: { width: 2.5, fill: { kind: 'srgb', value: '#FF0000', alpha: 0.5 } },
      },
    });
    expect(mapped.document.resources.media).toHaveLength(1);
    if (element.type === 'shape' && element.style.fill?.kind === 'image')
      expect(element.style.fill.resourceId).toBe(mapped.document.resources.media[0]!.id);
  });

  it('preserves descending line endpoints and arrowheads in positive bounds', () => {
    const mapped = mapElements([
      {
        id: 'line',
        type: 'line',
        start: [100, 0],
        end: [0, 80],
        points: ['', 'arrow'],
        color: '#FF0000',
        width: 2,
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
    expect(mapped.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
      type: 'line',
      transform: { x: 25, y: 50, width: 125, height: 100 },
      start: { x: 125, y: 0, marker: 'none' },
      end: { x: 0, y: 100, marker: 'arrow', markerSize: 3, markerAnchor: 'center' },
    });
  });

  it('preserves radial backgrounds and content-sized text fills without inventing invalid outlines', () => {
    const mapped = mapElements([
      {
        id: 'radial',
        type: 'shape',
        viewBox: [200, 200],
        path: 'M0 0H200V200H0Z',
        gradient: {
          type: 'radial',
          rotate: 0,
          colors: [
            { pos: 0, color: '#FFFFFF00' },
            { pos: 100, color: '#FFFFFFCC' },
          ],
        },
      },
      {
        id: 'text',
        type: 'text',
        fill: '#FFFFFFCC',
        content: '<p><br></p>',
        outline: { width: 1, color: '#rgba(255,255,255,0)' },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
    expect(mapped.diagnostics).toEqual([]);
    expect(mapped.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
      style: { fill: { kind: 'gradient', gradientType: 'radial' } },
    });
    expect(mapped.document.nativeSlides[0]!.slide.elements[1]).toMatchObject({
      type: 'textFrame',
      fillSizing: 'content',
      style: { stroke: { fill: { alpha: 0 } } },
    });
  });

  it('preserves the existing default angle and linear type for shape gradients', () => {
    const mapped = mapElements([
      {
        id: 'default-gradient',
        type: 'shape',
        gradient: {
          colors: [
            { pos: 0, color: '#000000' },
            { pos: 100, color: '#FFFFFF' },
          ],
        },
      },
    ]);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
    expect(mapped.document.nativeSlides[0]!.slide.elements[0]).toMatchObject({
      style: {
        fill: {
          kind: 'gradient',
          angle: 90,
          stops: [{ offset: 0 }, { offset: 1 }],
        },
      },
    });
  });
});
