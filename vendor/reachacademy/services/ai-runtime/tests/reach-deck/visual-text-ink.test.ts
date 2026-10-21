import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { inspectTextFrameInk } from '../../scripts/reach-deck/visual-text-ink.js';

describe('visual acceptance painted text bounds', () => {
  it('retains em-box diagnostics while rejecting actual clipping and tall text overflow at desktop and mobile scale', async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.REACH_DECK_HTML_CHROME_PATH
        ? { executablePath: process.env.REACH_DECK_HTML_CHROME_PATH }
        : process.platform === 'linux'
          ? { executablePath: '/usr/bin/chromium' }
          : { channel: 'chrome' }),
    });
    try {
      const page = await browser.newPage();
      const font = await readFile(
        path.resolve(
          process.cwd(),
          '../../packages/reach-deck-player/fonts/sources/SourceHanSans-VF.ttf',
        ),
      );
      await page.setContent(
        `<style>@font-face{font-family:TestHan;src:url(data:font/ttf;base64,${font.toString('base64')});font-weight:250 900}.stage{width:1600px;transform-origin:top left}.frame{width:720px;height:125px;overflow:visible;font-family:TestHan;font-size:52px;font-weight:800;line-height:62.4px}p{margin:0}</style><div class="stage"><div data-native-v2-element-id="em-box"><div class="frame" data-native-v2-text-overflow="5"><p>面对新问题，<br>怎样从证据走向解释？</p></div></div><div data-native-v2-element-id="actual-overflow"><div class="frame" style="height:63px" data-native-v2-text-overflow="67"><p>面对新问题，<br>怎样从证据走向解释？</p></div></div><div data-native-v2-element-id="clipped"><div class="frame" style="overflow:hidden" data-native-v2-text-overflow="5"><p>面对新问题，<br>怎样从证据走向解释？</p></div></div></div>`,
      );
      await page.evaluate(() => document.fonts.ready);
      for (const scale of [1, 0.23]) {
        await page.locator('.stage').evaluate((node, value) => {
          (node as HTMLElement).style.transform = `scale(${value})`;
        }, scale);
        const measured = await page.locator('.frame').evaluateAll(inspectTextFrameInk);
        expect(measured[0]).toMatchObject({
          overflow: '5',
          lineBoxOnly: true,
          visibleGlyphInkOutside: false,
        });
        expect(measured[1]).toMatchObject({
          overflow: '67',
          lineBoxOnly: false,
          visibleGlyphInkOutside: true,
        });
        expect(measured[2]?.lineBoxOnly).toBe(false);
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});
