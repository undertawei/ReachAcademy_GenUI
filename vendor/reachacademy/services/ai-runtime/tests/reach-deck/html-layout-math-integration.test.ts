import { describe, expect, it } from 'vitest';
import { compileHtmlLayout } from '../../lib/reach-deck/html-layout';
import { loadHtmlMathStyles } from '../../lib/reach-deck/html-layout/fonts';

const html = (body: string) =>
  `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:white">${body}</section></body></html>`;

const inlineMathSizes = (node: unknown): number[] => {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(inlineMathSizes);
  const value = node as Record<string, unknown>;
  if (value.type === 'inlineMath')
    return [Number((value.attrs as Record<string, unknown>).fontSize)];
  return Object.values(value).flatMap(inlineMathSizes);
};

describe('production HTML math integration', () => {
  // Frozen coordinates/copy from the scientific page in the single-pass run.
  const stateBand = String.raw`<figure id="state-band" style="position:absolute;left:96px;top:718px;width:1408px;height:104px;margin:0;background:#FFFDF8"></figure><p id="state-0" style="position:absolute;left:420px;top:786px;width:110px;height:26px;margin:0;font:16px/26px 'Source Han Sans VF'">\(t=0\) → \(x=0\)</p>`;

  it('widens the original inline-math state label without moving it or resizing its math', async () => {
    const result = await compileHtmlLayout({
      pageId: 'inline-state',
      themeName: 'reach-classic',
      assets: [],
      html: html(stateBand),
    });
    const label = result.slide.elements.find((element) => element.id === 'state-0')!;
    expect(label.transform.x).toBe(420);
    expect(label.transform.y).toBe(786);
    expect(label.transform.width).toBeGreaterThan(110);
    expect(label.transform.width).toBeLessThanOrEqual(110 * 1.35);
    expect(label.transform.height).toBe(26);
    expect(
      result.slide.elements.find((element) => element.id === 'state-band')?.transform.height,
    ).toBe(104);
    expect(
      result.diagnostics.some((message) =>
        message.includes('TEXT_AUTOFIT: state-0 adjusted width'),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.filter((message) => message.includes('TEXT_AUTOFIT: state-0')).join('\n'),
    ).not.toContain('"unresolved":true');
    expect(JSON.stringify(label)).toContain('inlineMath');
    expect(inlineMathSizes(label)).toEqual([16, 16]);
  }, 60_000);

  it('grows the original two-line unit note inside its panel without shrinking its formula', async () => {
    const result = await compileHtmlLayout({
      pageId: 'inline-units',
      themeName: 'reach-classic',
      assets: [],
      html: html(
        String.raw`<figure id="formula-panel" style="position:absolute;left:1030px;top:190px;width:474px;height:492px;margin:0;background:#382522"></figure><p id="unit-note" style="position:absolute;left:1068px;top:388px;width:370px;height:58px;margin:0;font:19px/29px 'Source Han Sans VF';color:white">\(x\)：位置，单位是米<br>\(t\)：时间，单位是秒</p>`,
      ),
    });
    const note = result.slide.elements.find((element) => element.id === 'unit-note')!;
    expect(note.transform.x).toBe(1068);
    expect(note.transform.y).toBe(388);
    expect(note.transform.width).toBe(370);
    expect(note.transform.height).toBeGreaterThan(58);
    expect(note.transform.height).toBeLessThanOrEqual(68);
    expect(
      result.slide.elements.find((element) => element.id === 'formula-panel')?.transform.height,
    ).toBe(492);
    expect(
      result.diagnostics
        .filter((message) => message.includes('TEXT_AUTOFIT: unit-note'))
        .join('\n'),
    ).not.toContain('"unresolved":true');
    expect(JSON.stringify(note)).toContain('inlineMath');
    expect(inlineMathSizes(note)).toEqual([19, 19]);
  }, 60_000);

  it('reports blocked inline math without widening, shrinking, moving, or expanding its carrier', async () => {
    const result = await compileHtmlLayout({
      pageId: 'inline-blocked',
      themeName: 'reach-classic',
      assets: [],
      html: html(
        stateBand +
          '<p id="neighbor" style="position:absolute;left:531px;top:786px;width:100px;height:26px;margin:0;font:16px/26px Arial">neighbor</p>',
      ),
    });
    const label = result.slide.elements.find((element) => element.id === 'state-0')!;
    expect(label.transform).toMatchObject({ x: 420, y: 786, width: 110, height: 26 });
    expect(inlineMathSizes(label)).toEqual([16, 16]);
    expect(
      result.diagnostics.some((message) => message.includes('TEXT_AUTOFIT: state-0 unresolved')),
    ).toBe(true);
    expect(
      result.slide.elements.find((element) => element.id === 'state-band')?.transform.height,
    ).toBe(104);
  }, 60_000);

  it('keeps an overflowing inline formula inside the existing carrier width even when outside space is free', async () => {
    const result = await compileHtmlLayout({
      pageId: 'inline-carrier-boundary',
      themeName: 'reach-classic',
      assets: [],
      html: html(
        stateBand.replace('left:96px;top:718px;width:1408px', 'left:410px;top:718px;width:125px'),
      ),
    });
    const label = result.slide.elements.find((element) => element.id === 'state-0')!;
    expect(label.transform).toMatchObject({ x: 420, y: 786, width: 110, height: 26 });
    expect(inlineMathSizes(label)).toEqual([16, 16]);
    expect(
      result.slide.elements.find((element) => element.id === 'state-band')?.transform.width,
    ).toBe(125);
    expect(
      result.diagnostics.some((message) => message.includes('TEXT_AUTOFIT: state-0 unresolved')),
    ).toBe(true);
  }, 60_000);

  it('keeps the original formula when the available height would require illegible math', async () => {
    const result = await compileHtmlLayout({
      pageId: 'math-floor',
      themeName: 'reach-classic',
      assets: [],
      html: html(
        String.raw`<p id="formula" style="position:absolute;left:100px;top:100px;width:600px;height:10px;margin:0;font:40px/52px Arial">\[v=\frac{s}{t}\]</p><p id="caption" style="position:absolute;left:100px;top:122px;width:600px;height:30px;margin:0;font:20px/30px Arial">Caption</p>`,
      ),
    });
    const formula = result.slide.elements.find((e) => e.id === 'formula');
    expect(formula?.type === 'textFrame' && formula.text.doc.content?.[0]?.attrs?.fontSize).toBe(
      40,
    );
    expect(result.diagnostics.some((d) => d.includes('MATH_AUTOFIT: formula unresolved'))).toBe(
      true,
    );
  }, 60_000);
  it.each([false, true])(
    'fits measured display fractions with a nearby caption: %s',
    async (blocked) => {
      const result = await compileHtmlLayout({
        pageId: 'math-autofit',
        themeName: 'reach-classic',
        assets: [],
        html: html(
          String.raw`<p id="formula" style="position:absolute;left:100px;top:100px;width:600px;height:84px;margin:0;font:58px/75.4px Arial">\[v=\frac{s}{t}\]</p>` +
            (blocked
              ? '<p id="caption" style="position:absolute;left:100px;top:193px;width:600px;height:30px;margin:0;font:20px/30px Arial">Caption</p>'
              : ''),
        ),
      });
      const formula = result.slide.elements.find((e) => e.id === 'formula');
      expect(formula?.type).toBe('textFrame');
      if (formula?.type !== 'textFrame') throw new Error('Missing editable formula');
      const attrs = formula.text.doc.content?.[0]?.attrs;
      expect(attrs?.latex).toBe(String.raw`v=\frac{s}{t}`);
      expect(result.diagnostics.some((d) => d.includes('MATH_AUTOFIT: formula adjusted'))).toBe(
        true,
      );
      if (blocked) {
        expect(Number(attrs?.fontSize)).toBeLessThan(58);
        expect(Number(attrs?.fontSize)).toBeGreaterThanOrEqual(24);
        expect(formula.transform.y + formula.transform.height).toBeLessThanOrEqual(181);
      } else {
        expect(Number(attrs?.fontSize)).toBe(58);
        expect(formula.transform.height).toBeGreaterThan(84);
      }
      expect(result.pendingMedia).toEqual([]);
    },
    60_000,
  );
  // Frozen from the 2026-09-25 acceptance run (sine lesson, page 9): a whole-box inline
  // \dfrac overflowed onto its note because only display math reached MATH_AUTOFIT.
  it('fits a formula-only inline fraction above its note like display math', async () => {
    const result = await compileHtmlLayout({
      pageId: 'inline-formula-only',
      themeName: 'reach-classic',
      assets: [],
      html: html(
        String.raw`<figure id="formula-panel" style="position:absolute;left:88px;top:198px;width:1424px;height:154px;margin:0;background:#F1F4F7"></figure><p id="main-formula" style="position:absolute;left:420px;top:216px;width:820px;height:66px;margin:0;font:42px/66px 'Source Han Sans VF';text-align:center">\(\sin A=\dfrac{\text{对边}}{\text{斜边}}\)</p><p id="formula-note" style="position:absolute;left:132px;top:290px;width:1240px;height:30px;margin:0;font:20px/30px 'Source Han Sans VF'">对边属于角 A；斜边是直角三角形中与直角相对的那条边。</p>`,
      ),
    });
    const formula = result.slide.elements.find((e) => e.id === 'main-formula');
    if (formula?.type !== 'textFrame') throw new Error('Missing editable formula');
    expect(JSON.stringify(formula)).toContain('inlineMath');
    const [size] = inlineMathSizes(formula);
    expect(size).toBeLessThan(42);
    expect(size).toBeGreaterThanOrEqual(24);
    expect(formula.transform.y + formula.transform.height).toBeLessThanOrEqual(290 - 12);
    expect(result.diagnostics.some((d) => d.includes('MATH_AUTOFIT: main-formula adjusted'))).toBe(
      true,
    );
    expect(result.diagnostics.join('\n')).not.toContain('TEXT_AUTOFIT: main-formula');
    expect(result.slide.elements.find((e) => e.id === 'formula-note')?.transform.y).toBe(290);
  }, 60_000);

  it('embeds trusted KaTeX fonts without network dependencies', async () => {
    const css = await loadHtmlMathStyles();
    expect(css).toContain('data:font/woff2;base64,');
    expect(css).not.toContain('url(fonts/');
    expect(css).toContain('.katex');
  });

  it('preserves display and inline LaTeX in editable math nodes without raster resources', async () => {
    let prepared = '';
    const result = await compileHtmlLayout({
      pageId: 'math-round-trip',
      themeName: 'reach-classic',
      assets: [],
      html: html(
        String.raw`<p id="formula" style="position:absolute;left:100px;top:100px;width:900px;height:160px;margin:0;font:40px/60px 'Source Han Sans VF'">\[v=\frac{s}{t}\]</p><p id="sentence" style="position:absolute;left:100px;top:320px;width:1200px;height:100px;margin:0;font:28px/40px 'Source Han Sans VF'">速度为 \(v=6\,\mathrm{m/s}\)，单位统一。</p>`,
      ),
      onPreparedHtml: (value) => {
        prepared = value;
      },
    });
    expect(result.slide.elements.map((element) => element.type)).toEqual([
      'textFrame',
      'textFrame',
    ]);
    expect(result.pendingMedia).toEqual([]);
    expect(JSON.stringify(result.slide.elements)).toContain('blockMath');
    expect(JSON.stringify(result.slide.elements)).toContain('inlineMath');
    const formula = result.slide.elements[0];
    expect(formula?.type === 'textFrame' && formula.text.doc.content?.[0]?.attrs?.latex).toBe(
      String.raw`v=\frac{s}{t}`,
    );
    expect(prepared).toContain('class="katex"');
    expect(prepared).toContain('data-reach-math-latex');
    expect(prepared).not.toContain('data:font/');
  }, 60_000);

  it('retains invalid math as readable source without failing or rasterizing the page', async () => {
    const result = await compileHtmlLayout({
      pageId: 'math-fallback',
      themeName: 'reach-classic',
      assets: [],
      html: html(
        String.raw`<p id="invalid" style="position:absolute;left:100px;top:100px;width:1200px;height:120px;margin:0;font-size:28px">\(\notARealCommand{x}\)</p>`,
      ),
    });
    expect(result.slide.elements[0]?.type).toBe('textFrame');
    expect(JSON.stringify(result.slide.elements)).toContain('notARealCommand');
    expect(result.diagnostics.join('\n')).toContain('MATH_TEXT_FALLBACK');
  }, 60_000);
});
