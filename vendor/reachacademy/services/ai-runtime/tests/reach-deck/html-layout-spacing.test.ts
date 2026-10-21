import { describe, expect, it } from 'vitest';
import { compileHtmlLayout } from '../../lib/reach-deck/html-layout';

const page = (cardBottom: number, footerTop: number) => ({
  pageId: 'spacing',
  themeName: 'reach-classic',
  assets: [],
  html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:white">
  <div id="card" style="position:absolute;left:274px;top:276px;width:1052px;height:${cardBottom - 276}px;background:#fffdf8;border:1px solid tan;border-radius:22px;box-sizing:border-box"></div>
  <div id="footer-rule" style="position:absolute;left:82px;top:838px;width:1436px;height:2px;background:tan"></div>
  <p id="takeaway" style="position:absolute;left:82px;top:${footerTop}px;width:1436px;height:28px;margin:0;font:19px/28px Arial">Read the diagram.</p>
  </section></body></html>`,
});

describe('HTML footer spacing diagnostics', () => {
  it('reports ignored text declarations without rejecting or rewriting the page', async () => {
    const input = page(750, 848);
    input.html = input.html.replace(
      'font:19px/28px Arial',
      'font:19px/28px Arial;line-height:thirtypx',
    );
    const result = await compileHtmlLayout(input);
    expect(result.diagnostics).toContain(
      'INVALID_TEXT_STYLE: takeaway has unsupported line-height: thirtypx',
    );
    expect(result.slide.elements.find((element) => element.id === 'takeaway')?.transform.y).toBe(
      848,
    );
  }, 60_000);

  it.each(['state-line', 'footer-rule'])(
    'distinguishes an internal timeline from an explicitly identified footer: %s',
    async (lineId) => {
      const result = await compileHtmlLayout({
        pageId: 'state-spacing',
        themeName: 'reach-classic',
        assets: [],
        html: `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:white">
          <figure id="state-band" style="position:absolute;left:96px;top:718px;width:1408px;height:104px;margin:0;background:#fffdf8;border-radius:18px"></figure>
          <div id="${lineId}" style="position:absolute;left:420px;top:766px;width:976px;height:2px;background:tan"></div>
          </section></body></html>`,
      });
      const intersection = result.diagnostics.some((message) =>
        message.includes('FOOTER_CARD_INTERSECTION: state-band'),
      );
      expect(intersection).toBe(lineId === 'footer-rule');
    },
    60_000,
  );

  it('includes an external card shadow in footer diagnostics', async () => {
    const input = page(830, 848);
    input.html = input.html.replace(
      'border-radius:22px;',
      'border-radius:22px;box-shadow:0 10px 20px #0008;',
    );
    const result = await compileHtmlLayout(input);
    expect(result.diagnostics.join('\n')).toContain(
      'FOOTER_SHADOW_INTERSECTION: card shadow reaches across footer-rule',
    );
    expect(result.diagnostics.join('\n')).not.toContain('FOOTER_CARD_INTERSECTION');
  }, 60_000);

  it('reports the original card/divider overlap and unsafe footer without rewriting geometry', async () => {
    const input = page(848, 872);
    const result = await compileHtmlLayout(input);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('FOOTER_SAFE_AREA: takeaway leaves 0px'),
        expect.stringContaining('FOOTER_CARD_INTERSECTION: card crosses footer-rule by 10px'),
      ]),
    );
    expect(result.slide.elements.find((e) => e.id === 'card')?.transform.height).toBe(572);
    expect(result.slide.elements.find((e) => e.id === 'takeaway')?.transform.y).toBe(872);
  }, 60_000);

  it('accepts separated cards with bottom safe area and ignores full-bleed backgrounds', async () => {
    const input = page(800, 848);
    input.html = input.html.replace(
      '<div id="card"',
      '<div id="full-bleed" style="position:absolute;left:0;top:0;width:1600px;height:900px;background:white"></div><div id="card"',
    );
    const result = await compileHtmlLayout(input);
    expect(result.diagnostics.join('\n')).not.toMatch(/FOOTER_SAFE_AREA|FOOTER_CARD_INTERSECTION/);
  }, 60_000);
});
