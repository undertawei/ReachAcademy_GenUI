import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright-core';
import { ReachDeckRichText } from '../../../../packages/reach-deck-player/src/ReachDeckRichText.js';
import { compileHtmlLayout } from '../../lib/reach-deck/html-layout/index.js';

describe('HTML mixed-font paragraph line boxes', () => {
  it('keeps the paragraph strut and explicit larger formula run editable', async () => {
    const result = await compileHtmlLayout({
      html: '<!doctype html><html><body><section id="slide" style="position:relative;width:1600px;height:900px;background:#fff"><p id="derivation" style="position:absolute;left:471px;top:284px;width:260px;height:123px;margin:0;font-family:Source Han Sans VF;font-size:18px;line-height:1.45;color:#27333A"><strong style="font-size:17px;letter-spacing:1px;color:#50717A">FOR t &gt; 0</strong><br>Divide both sides by <em>t</em>:<br><strong style="font-size:42px;line-height:1.2;color:#27333A">v = d/t</strong></p></section></body></html>',
      pageId: 'mixed-font',
      themeName: 'reach-classic',
      assets: [],
    });
    const element = result.slide.elements.find((element) => element.id === 'derivation');
    if (element?.type !== 'textFrame') throw new Error('Expected editable derivation');
    const paragraph = element.text.doc.content![0]!;
    expect(paragraph.attrs).toMatchObject({ fontSize: 18, lineHeightPx: 26.1 });
    const formula = paragraph.content!.find((node) => node.text === 'v = d/t')!;
    expect(formula.marks).toEqual(
      expect.arrayContaining([
        {
          type: 'textStyle',
          attrs: expect.objectContaining({ fontSize: '42px', lineHeightPx: 50.4 }),
        },
      ]),
    );
    expect(result.pendingMedia).toEqual([]);

    const browser = await chromium.launch({
      headless: true,
      ...(process.env.REACH_DECK_HTML_CHROME_PATH
        ? { executablePath: process.env.REACH_DECK_HTML_CHROME_PATH }
        : { channel: 'chrome' }),
    });
    try {
      const page = await browser.newPage();
      const native = renderToStaticMarkup(
        createElement(ReachDeckRichText, { document: element.text.doc }),
      );
      await page.setContent(
        `<!doctype html><style>p{margin:0;width:260px;font-family:Arial!important}span{font-family:Arial!important}</style><div id="source"><p style="font-size:18px;line-height:1.45"><strong style="font-size:17px;letter-spacing:1px">FOR t &gt; 0</strong><br>Divide both sides by <em>t</em>:<br><strong style="font-size:42px;line-height:1.2">v = d/t</strong></p></div><div id="native">${native}</div>`,
      );
      const positions = await page.evaluate(() => {
        const measure = (id: string) => {
          const paragraph = document.querySelector(`#${id} p`)!;
          const top = paragraph.getBoundingClientRect().top;
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
          const boxes = [];
          while (walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            const rect = range.getBoundingClientRect();
            boxes.push({
              text: walker.currentNode.textContent,
              top: rect.top - top,
              bottom: rect.bottom - top,
            });
          }
          return boxes;
        };
        return { source: measure('source'), native: measure('native') };
      });
      expect(positions.native).toHaveLength(positions.source.length);
      positions.source.forEach((expected, index) => {
        const actual = positions.native[index]!;
        expect(actual.text).toBe(expected.text);
        expect(Math.abs(actual.top - expected.top)).toBeLessThan(1);
        expect(Math.abs(actual.bottom - expected.bottom)).toBeLessThan(1);
      });
    } finally {
      await browser.close();
    }
  }, 60_000);
});
