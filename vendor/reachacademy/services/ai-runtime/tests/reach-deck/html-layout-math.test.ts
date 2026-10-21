// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { prepareHtmlMath, splitHtmlMath } from '../../scripts/reach-deck/html-layout/math';
import {
  compileRenderedHtml,
  sanitizeGeneratedHtml,
} from '../../scripts/reach-deck/html-layout/htmlPipeline';
import { summarizeNativeSlideElementsForNarration } from '../../../../packages/reach-deck-dsl/src/nativeNarration';
import { buildNarrationRevealManifest } from '../../lib/reach-deck/narration-capability-adapter';

function load(body: string) {
  document.documentElement.innerHTML = `<head></head><body><section id="slide" style="position:relative;width:1600px;height:900px">${body}</section></body>`;
  return document;
}

describe('standard HTML LaTeX delimiters', () => {
  it('persists explicit HTML reveal groups into the narration manifest', async () => {
    load(
      '<div id="card-bg" data-reach-reveal-group="card-1" data-reach-decorative="true" style="position:absolute;left:80px;top:80px;width:500px;height:260px;background:#fff"></div>' +
        '<p id="card-copy" data-reach-reveal-group="card-1" style="position:absolute;left:120px;top:120px;width:400px;height:100px;font-size:32px;color:#000">Card copy</p>',
    );
    const measure = (element: Element) =>
      new DOMRect(
        element.id === 'slide' ? 0 : element.id === 'card-bg' ? 80 : 120,
        element.id === 'slide' ? 0 : element.id === 'card-bg' ? 80 : 120,
        element.id === 'slide' ? 1600 : element.id === 'card-bg' ? 500 : 400,
        element.id === 'slide' ? 900 : element.id === 'card-bg' ? 260 : 100,
      );
    const result = await compileRenderedHtml(
      document,
      document.documentElement.outerHTML,
      measure,
      async () => 'data:image/png;base64,unused',
    );
    const slide = result.document.nativeSlides[0]!.slide;
    const elements = summarizeNativeSlideElementsForNarration(slide);
    const manifest = buildNarrationRevealManifest(
      elements,
      new Set(elements.map((element) => element.id)),
    );
    expect(slide.elements.find((element) => element.id === 'card-bg')?.name).toBe(
      'reveal-group:card-1',
    );
    expect(elements.find((element) => element.id === 'card-copy')?.revealGroupId).toBe('card-1');
    expect(manifest.groups.find((group) => group.groupId === 'card-1')?.elementIds).toEqual([
      'card-bg',
      'card-copy',
    ]);
    // A decorative card surface reveals with the copy it carries.
    expect(manifest.groups.find((group) => group.groupId === 'card-1')?.classification).toBe(
      'required',
    );
  });

  it('supports inline, bracket display and dollar display but not currency', () => {
    const parts = splitHtmlMath(String.raw`Price $20; \(v=\frac{s}{t}\), \[s=vt\], $$a^2$$.`);
    expect(parts.filter((part) => part.type === 'math')).toMatchObject([
      { latex: String.raw`v=\frac{s}{t}`, display: false },
      { latex: 's=vt', display: true },
      { latex: 'a^2', display: true },
    ]);
    expect(parts[0]).toEqual({ type: 'text', text: 'Price $20; ' });
  });

  it('renders locally and keeps the source, without replacing code or table content', () => {
    load(
      String.raw`<p>Speed \(v=\frac{s}{t}\).</p><pre>\(raw\)</pre><table><tbody><tr><td>\(x\)</td></tr></tbody></table>`,
    );
    expect(prepareHtmlMath(document)).toHaveLength(1);
    expect(document.querySelectorAll('[data-reach-math-latex]')).toHaveLength(1);
    expect(document.querySelector('.katex')).not.toBeNull();
    expect(document.querySelector('pre')?.textContent).toBe(String.raw`\(raw\)`);
    expect(document.querySelector('td')?.textContent).toBe(String.raw`\(x\)`);
  });

  it.each([
    String.raw`\unknownCommand{x}`,
    String.raw`\def\a{\a}\a`,
    '{'.repeat(33) + 'x' + '}'.repeat(33),
    'x'.repeat(2049),
  ])('retains invalid/complex formula as readable text: %s', (latex) => {
    load(`<p>\\(${latex}\\)</p>`);
    expect(prepareHtmlMath(document)).toHaveLength(1);
    expect(document.querySelector('[data-reach-math-latex]')).toBeNull();
    expect(document.querySelector('p')?.textContent).toBe(`\\(${latex}\\)`);
  });

  it('strips forged internal math markers during sanitization', () => {
    const html = sanitizeGeneratedHtml(
      '<section id="slide"><span data-reach-math-latex="evil" data-reach-math-display="true">ordinary text</span></section>',
    );
    expect(html).not.toContain('data-reach-math-latex');
  });

  it('bounds expanded DOM without dropping excess formula sources', () => {
    load(`<p>${String.raw`\(\frac{x^2+1}{y}\) `.repeat(80)}</p>`);
    expect(prepareHtmlMath(document).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('*').length).toBeLessThanOrEqual(1900);
    expect(document.querySelector('p')?.textContent).toContain(String.raw`\(\frac{x^2+1}{y}\)`);
  });

  it('compiles mixed inline and display math into editable rich text without rasterization', async () => {
    load(
      String.raw`<p id="formula" style="position:absolute;left:80px;top:80px;width:1000px;height:300px;font-size:40px;color:rgb(0,0,0)">Speed \(v=\frac{s}{t}\). \[s=vt\] Done.</p>`,
    );
    prepareHtmlMath(document);
    const raster = vi.fn(async () => 'data:image/png;base64,unused');
    const measure = (element: Element) =>
      new DOMRect(
        element.id === 'slide' ? 0 : 80,
        element.id === 'slide' ? 0 : 80,
        element.id === 'slide' ? 1600 : 1000,
        element.id === 'slide' ? 900 : 300,
      );
    const result = await compileRenderedHtml(
      document,
      document.documentElement.outerHTML,
      measure,
      raster,
    );
    expect(raster).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result.document);
    expect(serialized).toContain('inlineMath');
    expect(serialized).toContain('blockMath');
    expect(serialized).not.toContain('katex-html');
    expect(serialized).toContain('\\\\frac');
  });
});
