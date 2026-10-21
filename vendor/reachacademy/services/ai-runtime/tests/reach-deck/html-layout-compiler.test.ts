import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import sharp from 'sharp';
import {
  compileHtmlLayout,
  HtmlLayoutValidationError,
  validateHtmlLayoutInput,
  type HtmlLayoutAsset,
} from '../../lib/reach-deck/html-layout';

const html = (body: string) =>
  `<!doctype html><html><body><section id="slide" style="position:relative;width:1600px;height:900px;background:white">${body}</section></body></html>`;
const input = (source: string, assets: HtmlLayoutAsset[] = []) => ({
  html: source,
  assets,
  pageId: 'page-production',
  themeName: 'reach-classic',
});

describe('HTML layout input budgets', () => {
  it('rejects oversized HTML and deeply nested DOM before launching a browser', async () => {
    await expect(validateHtmlLayoutInput(input('x'.repeat(1_048_577)))).rejects.toThrow(
      'byte budget',
    );
    await expect(
      validateHtmlLayoutInput(input(html('<span></span>'.repeat(2_001)))),
    ).rejects.toThrow('DOM node');
  });

  it('rejects excessive decoded image dimensions', async () => {
    const image = await sharp({
      create: { width: 4001, height: 4000, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(
      validateHtmlLayoutInput(
        input(html(''), [
          {
            kind: 'image',
            assetId: 'photo',
            resource: {
              id: 'r1',
              objectKey: 'scoped/photo.png',
              contentType: 'image/png',
              digest: 'sha256:fixture',
            },
            dataUrl: `data:image/png;base64,${image.toString('base64')}`,
          },
        ]),
      ),
    ).rejects.toThrow();
  });

  it('does not launch an already cancelled job', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled fixture'));
    await expect(
      compileHtmlLayout({ ...input(html('')), signal: controller.signal }),
    ).rejects.toThrow('cancelled fixture');
  });
});

describe('HTML layout Chromium compiler', () => {
  it('rejects hidden-only output while accepting a visible Native element', async () => {
    const block = (visibility: string) =>
      html(
        `<p id="content" style="position:absolute;left:80px;top:80px;width:600px;height:80px;margin:0;font-size:32px;visibility:${visibility}">Visible content</p>`,
      );
    const failure = await compileHtmlLayout(input(block('hidden'))).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HtmlLayoutValidationError);
    expect(failure).toMatchObject({
      message: expect.stringContaining('at least one visible Native element'),
    });
    const result = await compileHtmlLayout(input(block('visible')));
    expect(result.slide.elements).toHaveLength(1);
    expect(result.slide.elements[0]).toMatchObject({ type: 'textFrame', id: 'content' });
  }, 60_000);
  it.each([
    ['HTML 超过 300 KB', html(`<!--${'x'.repeat(300_000)}-->`)],
    ['没有可转换', html('')],
    [
      'HTML 元素超过 80',
      html(
        Array.from(
          { length: 81 },
          (_, index) =>
            `<div id="box-${index}" style="position:absolute;left:${index * 10}px;top:10px;width:8px;height:8px;background:red"></div>`,
        ).join(''),
      ),
    ],
  ])('classifies the preserved compiler output contract: %s', async (message, source) => {
    const failure = await compileHtmlLayout(input(source)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HtmlLayoutValidationError);
    expect(failure).toMatchObject({ message: expect.stringContaining(message) });
  });
  it('preserves explicit output validation failures across the browser boundary', async () => {
    await expect(
      compileHtmlLayout(input('<!doctype html><html><body></body></html>')),
    ).rejects.toBeInstanceOf(HtmlLayoutValidationError);
  });
  it('ignores inline SVG baseline whitespace while reporting genuinely clipped figures', async () => {
    const figure = (height: number) =>
      html(
        `<figure id="inline-svg" style="position:absolute;left:80px;top:80px;width:200px;height:200px;margin:0;overflow:hidden"><svg width="200" height="${height}"><rect x="10" y="10" width="180" height="${height - 20}" fill="red"/></svg></figure>`,
      );
    const result = await compileHtmlLayout(input(figure(200)));
    expect(result.slide.elements[0]).toMatchObject({
      type: 'image',
      transform: { width: 200, height: 200 },
    });
    expect(result.diagnostics.join('\n')).not.toContain('OVERFLOW_CLIPPED');
    const clipped = await compileHtmlLayout(input(figure(230)));
    expect(clipped.diagnostics.join('\n')).toContain('OVERFLOW_CLIPPED');
    expect(clipped.diagnostics.join('\n')).toContain('inline-svg');
  }, 60_000);

  it('keeps off-stage raster geometry and reports clipping without rejecting the slide', async () => {
    for (const left of [-50, 1700]) {
      const result = await compileHtmlLayout(
        input(
          html(
            `<figure id="outside" style="position:absolute;left:${left}px;top:100px;width:200px;height:200px;margin:0;background:linear-gradient(red,blue)"><svg width="200" height="200"><circle cx="100" cy="100" r="80" fill="red"/></svg></figure>`,
          ),
        ),
      );
      expect(result.slide.elements[0]).toMatchObject({
        type: 'image',
        transform: { x: left, width: 200 },
      });
      expect(result.diagnostics.join('\n')).toContain('OUT_OF_CANVAS');
      expect(result.pendingMedia).toHaveLength(1);
      const metadata = await sharp(
        Buffer.from(result.pendingMedia[0]!.dataUrl.split(',')[1]!, 'base64'),
      ).metadata();
      expect(metadata.width).toBe(left < 0 ? 200 : 1);
    }
  }, 60_000);

  it('isolates identical raster resource IDs across pages while retaining same-page deduplication', async () => {
    const source = html(
      '<figure id="first" style="position:absolute;left:80px;top:80px;width:100px;height:100px;margin:0;background:red"></figure><figure id="second" style="position:absolute;left:280px;top:80px;width:100px;height:100px;margin:0;background:red"></figure>',
    );
    const first = await compileHtmlLayout({ ...input(source), pageId: 'first-page' });
    const second = await compileHtmlLayout({ ...input(source), pageId: 'second-page' });
    const repeat = await compileHtmlLayout({ ...input(source), pageId: 'first-page' });
    expect(first.pendingMedia).toHaveLength(1);
    expect(second.pendingMedia).toHaveLength(1);
    expect(first.pendingMedia[0]!.dataUrl).toBe(second.pendingMedia[0]!.dataUrl);
    expect(first.pendingMedia[0]!.resourceId).not.toBe(second.pendingMedia[0]!.resourceId);
    expect(repeat.pendingMedia[0]!.resourceId).toBe(first.pendingMedia[0]!.resourceId);
    expect(
      first.slide.elements
        .filter((element) => element.type === 'image')
        .map((element) => element.resourceId),
    ).toEqual([first.pendingMedia[0]!.resourceId, first.pendingMedia[0]!.resourceId]);
  }, 60_000);

  it('gives tight CJK line boxes room for both declared line heights without shrinking text', async () => {
    for (const overflow of ['visible', 'hidden']) {
      const result = await compileHtmlLayout(
        input(
          html(
            `<h1 id="tight-title" style="position:absolute;left:80px;top:132px;width:650px;height:118px;margin:0;font-family:'Source Han Sans VF';font-size:48px;font-weight:400;line-height:60px;overflow:${overflow}">为什么好问题<br>比标准答案更重要</h1>`,
          ),
        ),
      );
      expect(result.slide.elements[0]).toMatchObject({
        type: 'textFrame',
        transform: { y: 132, height: 120 },
      });
      expect(result.diagnostics.join('\n')).not.toContain('OVERFLOW');
    }
  }, 60_000);

  it('fits recoverable overflow and still reports unsafe canvas escape and collisions', async () => {
    const text = (extra: string, top = 132) =>
      `<p id="ink" style="position:absolute;left:80px;top:${top}px;width:650px;height:20px;margin:0;font-family:'Source Han Sans VF';font-size:48px;line-height:60px;${extra}">为什么好问题</p>`;
    const visible = await compileHtmlLayout(input(html(text('overflow:visible'))));
    expect(visible.diagnostics.join('\n')).toContain('adjusted height');
    expect(visible.slide.elements[0]).toMatchObject({ transform: { height: 60 } });
    const clipped = await compileHtmlLayout(input(html(text('overflow:hidden'))));
    expect(clipped.diagnostics.join('\n')).toContain('adjusted height');
    expect(clipped.diagnostics.join('\n')).not.toContain('painted text is clipped');
    expect(
      (await compileHtmlLayout(input(html(text('overflow:visible', 875))))).diagnostics.join('\n'),
    ).toContain('painted text exceeds slide canvas');
    await expect(
      compileHtmlLayout(
        input(
          html(
            text('overflow:visible') +
              '<div id="next-element" style="position:absolute;left:80px;top:160px;width:650px;height:100px;background:red"></div>',
          ),
        ),
      ),
    ).resolves.toHaveProperty(
      'diagnostics',
      expect.arrayContaining([expect.stringContaining('painted overflow intersects next-element')]),
    );
  }, 60_000);

  it('diagnoses nested global coordinates and unsupported vertical labels without blocking output', async () => {
    const source = html(
      '<div id="band" style="position:absolute;left:112px;top:803px;width:1380px;height:58px;background:#382522"><p id="takeaway" style="position:absolute;left:145px;top:817px;width:1200px;height:30px;margin:0;font-size:22px;color:white">循环继续</p></div>' +
        '<div id="rail-label" style="position:absolute;left:0;top:0;width:32px;height:110px;font-size:18px;writing-mode:vertical-rl">水进入空气</div>',
    );
    const result = await compileHtmlLayout(input(source));
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('TEXT_OVERFLOW: takeaway painted text exceeds slide canvas'),
        expect.stringContaining('UNSUPPORTED_WRITING_MODE: rail-label'),
      ]),
    );
    const valid = await compileHtmlLayout(
      input(
        html(
          '<div id="band" style="position:absolute;left:112px;top:803px;width:1380px;height:58px;background:#382522"><p id="takeaway" style="position:absolute;left:33px;top:14px;width:1200px;height:30px;margin:0;font-size:22px;color:white">循环继续</p></div>',
        ),
      ),
    );
    expect(valid.diagnostics.join('\n')).not.toContain('painted text exceeds slide canvas');
  }, 60_000);

  it('reports independent text ink collisions and text backgrounds hiding another paragraph', async () => {
    const title =
      '<h1 id="title" style="position:absolute;left:80px;top:100px;width:650px;height:100px;margin:0;font-size:48px;line-height:60px">MMMMMMMM</h1>';
    const paragraph = (top: number, extra = '') =>
      `<p id="body" style="position:absolute;left:80px;top:${top}px;width:650px;height:100px;margin:0;font-size:24px;line-height:32px;${extra}">MMMMMMMM</p>`;
    expect(
      (await compileHtmlLayout(input(html(title + paragraph(115))))).diagnostics.join('\n'),
    ).toContain('TEXT_COLLISION');
    await expect(
      compileHtmlLayout(
        input(
          html(title + paragraph(130, 'padding-top:40px;background:white;box-sizing:border-box')),
        ),
      ),
    ).resolves.toHaveProperty(
      'diagnostics',
      expect.arrayContaining([expect.stringContaining('background or border obscures title')]),
    );
    const legal = await compileHtmlLayout(
      input(
        html(
          '<figure id="background" style="position:absolute;left:40px;top:40px;width:750px;height:350px;margin:0;background:blue"></figure>' +
            title +
            paragraph(230),
        ),
      ),
    );
    expect(legal.slide.elements.filter((element) => element.type === 'textFrame')).toHaveLength(2);
  }, 60_000);

  it('does not execute model scripts or access network resources', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end('unexpected');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local port.');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const result = await compileHtmlLayout(
        input(
          html(
            `<script>fetch('${url}');document.querySelector('#safe').remove()</script><link rel="stylesheet" href="${url}"><div id="safe" style="position:absolute;left:10px;top:10px;width:100px;height:100px;background:red;background-image:url('${url}')"></div>`,
          ),
        ),
      );
      expect(requests).toBe(0);
      expect(result.slide.elements.map((element) => element.id)).toContain('safe');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60_000);

  it('cleans up cancelled work and releases the serial browser slot', async () => {
    const controller = new AbortController();
    const first = compileHtmlLayout({
      ...input(
        html(
          '<div style="position:absolute;left:0;top:0;width:40px;height:40px;background:red"></div>',
        ),
      ),
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(new Error('cancel running compile')), 100);
    try {
      await expect(first).rejects.toThrow('cancel running compile');
      const result = await compileHtmlLayout(
        input(
          html(
            '<div style="position:absolute;left:0;top:0;width:40px;height:40px;background:red"></div>',
          ),
        ),
      );
      expect(result.slide.elements).toHaveLength(1);
    } finally {
      clearTimeout(timer);
    }
  }, 60_000);

  it('compiles editable bilingual text and isolated figures into Native V2 with durable IDs', async () => {
    const result = await compileHtmlLayout(
      input(
        html(
          '<h1 id="main-title" style="position:absolute;left:80px;top:80px;width:900px;height:100px;font:48px/80px Arial">Hello 中文</h1><figure id="art" style="position:absolute;left:100px;top:300px;width:200px;height:160px;margin:0;background:linear-gradient(red,blue)"><div style="width:50px;height:50px;background:yellow"></div></figure>',
        ),
      ),
    );
    expect(result.slide.id).toBe('page-production');
    expect(result.slide.elements.map((element) => element.type)).toEqual(['textFrame', 'image']);
    expect(result.pendingMedia).toHaveLength(1);
    expect(result.pendingMedia[0]!.resourceId).toMatch(/^html-media-[a-f0-9]{64}$/);
    expect(result.resources).toEqual([]);
    const bitmap = sharp(Buffer.from(result.pendingMedia[0]!.dataUrl.split(',')[1]!, 'base64'));
    expect(await bitmap.metadata()).toMatchObject({ width: 200, height: 160 });
    expect((await bitmap.stats()).channels.some((channel) => channel.stdev > 10)).toBe(true);
    expect(result.elementIdMap['main-title']).toBe('main-title');
    expect(JSON.stringify(result)).not.toContain('inline/');
  }, 60_000);

  it('rasterizes one rounded decorative card with its full shadow while keeping text editable', async () => {
    const result = await compileHtmlLayout(
      input(
        html(
          '<style>html,body{background:#ffeedd}</style>' +
            '<figure id="card" style="position:absolute;left:100px;top:100px;width:240px;height:180px;margin:0;border-radius:24px;overflow:hidden;background:linear-gradient(to right,#e00000 12px,#204060 12px);box-shadow:0 8px 16px 2px rgba(0,0,0,.6)"></figure>' +
            '<p id="card-copy" style="position:absolute;left:140px;top:150px;width:170px;height:60px;margin:0;font:24px/36px Arial;color:white">Editable</p>' +
            '<div id="neighbor" style="position:absolute;left:70px;top:130px;width:25px;height:100px;background:#00ff00"></div>',
        ),
      ),
    );
    const card = result.slide.elements.find((element) => element.id === 'card')!;
    expect(card.type).toBe('image');
    expect(card.transform).toMatchObject({ x: 74, y: 82, width: 292, height: 232 });
    expect(result.slide.elements.find((element) => element.id === 'card-copy')?.type).toBe(
      'textFrame',
    );
    expect(result.slide.elements.find((element) => element.id === 'neighbor')?.type).toBe('shape');
    expect(result.pendingMedia).toHaveLength(1);
    const { data, info } = await sharp(
      Buffer.from(result.pendingMedia[0]!.dataUrl.split(',')[1]!, 'base64'),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 292, height: 232 });
    const pixel = (x: number, y: number) =>
      Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
    expect(pixel(0, 0)[3]).toBeLessThan(2);
    expect(pixel(25, 80)[3]).toBeGreaterThan(10); // Shadow outside the source border box.
    expect(pixel(25, 80).slice(0, 3)).toEqual([0, 0, 0]); // No green neighboring element.
    expect(pixel(27, 19)[3]).toBeLessThan(200); // Rounded corner is not an opaque stripe.
    expect(pixel(30, 80)).toEqual([224, 0, 0, 255]);
    expect(pixel(75, 100)).toEqual([32, 64, 96, 255]); // Editable text was excluded.
  }, 60_000);

  it('charges expanded shadow paint against raster pixel budgets', async () => {
    await expect(
      compileHtmlLayout(
        input(
          html(
            '<figure id="huge-shadow" style="position:absolute;left:100px;top:100px;width:100px;height:100px;margin:0;background:red;box-shadow:0 0 2000px black"></figure>',
          ),
        ),
      ),
    ).rejects.toThrow('pixel budget');
  }, 60_000);

  it('fits native two- and three-line text over an empty decorative figure card', async () => {
    const result = await compileHtmlLayout(
      input(
        html(
          '<figure id="card" style="position:absolute;left:1250px;top:258px;width:260px;height:516px;margin:0;border-radius:22px;background:linear-gradient(to right,#b53b35 10px,#382522 10px)"></figure>' +
            '<p id="step-one" style="position:absolute;left:1286px;top:468px;width:184px;height:52px;margin:0;font:19px/29.45px Arial;color:white">Read order<br>First to last</p>' +
            '<p id="step-three" style="position:absolute;left:1286px;top:628px;width:184px;height:74px;margin:0;font:19px/29.45px Arial;color:white">Read dates<br>Approximate years<br>Not exact days</p>',
        ),
      ),
    );
    expect(result.slide.elements.find((element) => element.id === 'card')?.type).toBe('image');
    expect(result.slide.elements.find((element) => element.id === 'step-one')).toMatchObject({
      type: 'textFrame',
      transform: { height: 59 },
    });
    expect(result.slide.elements.find((element) => element.id === 'step-three')).toMatchObject({
      type: 'textFrame',
      transform: { height: 89 },
    });
    expect(result.pendingMedia).toHaveLength(1);
    expect(result.diagnostics.some((entry) => entry.includes('"unresolved":true'))).toBe(false);
  }, 60_000);

  it('preserves image resource identity and scientific HTML and anchors without rasterizing the scientific slot', async () => {
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const scientific: Extract<HtmlLayoutAsset, { kind: 'scientificVisual' }> = {
      kind: 'scientificVisual',
      assetId: 'science',
      element: {
        type: 'scientificVisual',
        id: 'science-original',
        transform: { x: 0, y: 0, width: 100, height: 100 },
        zIndex: 0,
        ariaLabel: 'Scientific visual',
        documentHtml: '<!doctype html><html><body>Scientific source</body></html>',
        manifest: {
          schemaVersion: 'reach-scientific-visual-manifest/v2',
          hooksVersion: 'reach-scientific-visual-hooks/v1',
          anchors: [{ id: 'start', description: 'Start' }],
          dependencies: [],
          resourceIds: [],
          ariaLabel: 'Scientific visual',
          textAlternative: 'Scientific source',
        },
      },
    };
    const result = await compileHtmlLayout(
      input(
        html(
          '<img data-reach-asset="photo" style="position:absolute;left:50px;top:50px;width:400px;height:200px;object-fit:contain"><div data-reach-asset="science" style="position:absolute;left:600px;top:200px;width:700px;height:500px"></div>',
        ),
        [
          {
            kind: 'image',
            assetId: 'photo',
            resource: {
              id: 'original-photo',
              objectKey: 'scoped/photo.png',
              contentType: 'image/png',
              digest: 'sha256:fixture',
            },
            dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
          },
          scientific,
        ],
      ),
    );
    expect(result.pendingMedia).toEqual([]);
    expect(result.resources[0]!.id).toBe('original-photo');
    expect(result.slide.elements[0]).toMatchObject({
      type: 'image',
      resourceId: 'original-photo',
      fit: 'contain',
    });
    expect(result.slide.elements[1]).toMatchObject({
      type: 'scientificVisual',
      documentHtml: scientific.element.documentHtml,
      manifest: scientific.element.manifest,
      transform: { x: 600, y: 200, width: 700, height: 500 },
    });
    expect(result.assetBindings).toEqual([
      { assetId: 'photo', elementId: 'asset-photo', binding: 'image-element' },
    ]);
  }, 60_000);

  it('rejects unknown asset references but only reports overflowing text', async () => {
    await expect(
      compileHtmlLayout(input(html('<img data-reach-asset="unknown">'))),
    ).rejects.toThrow('Unknown or duplicate');
    await expect(
      compileHtmlLayout(
        input(
          html(
            '<p id="overflow" style="position:absolute;left:10px;top:10px;width:50px;height:20px;overflow:hidden;font:40px/48px Arial">This cannot fit</p>',
          ),
        ),
      ),
    ).resolves.toHaveProperty(
      'diagnostics',
      expect.arrayContaining([expect.stringContaining('TEXT_OVERFLOW')]),
    );
  }, 60_000);

  // Frozen from the 2026-09-25 acceptance rerun (page 2, prompt v4): the layout model
  // still drew a labelled triangle as a "decorative" figure.
  it('reports text inside a layout-drawn figure but keeps empty decoration silent', async () => {
    const result = await compileHtmlLayout(
      input(
        html(
          `<figure id="step-bg" aria-label="第一步背景" style="position:absolute;left:100px;top:300px;width:400px;height:300px;margin:0;border-radius:24px;background:#F1F4F7"></figure>` +
            `<figure id="triangle-visual" aria-label="直角三角形中的对边与斜边示意" style="position:absolute;left:1100px;top:80px;width:260px;height:190px;margin:0"><svg width="260" height="190" viewBox="0 0 260 190" xmlns="http://www.w3.org/2000/svg"><path d="M34 156 L34 54 L218 156 Z" fill="#EAF4FF" stroke="#0064E0" stroke-width="4"/><text x="10" y="48" font-size="17">对边</text><text x="126" y="88" font-size="17">斜边</text></svg></figure>`,
        ),
      ),
    );
    const reported = result.diagnostics.filter((d) => d.includes('LAYOUT_FIGURE_CONTENT'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('triangle-visual');
    expect(reported[0]).toContain('对边');
    expect(result.slide.elements.map((element) => element.id)).toEqual(
      expect.arrayContaining(['step-bg', 'triangle-visual']),
    );
  }, 60_000);
});
