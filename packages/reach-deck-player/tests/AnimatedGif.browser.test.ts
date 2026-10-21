// @vitest-environment node
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';

const launchChromium = async (): Promise<Browser> => {
  try {
    return await chromium.launch({ headless: true, chromiumSandbox: true });
  } catch (bundledError) {
    try {
      return await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
    } catch (systemError) {
      throw new Error(
        `Unable to launch bundled Chromium or system Chrome. Bundled: ${String(bundledError)} System: ${String(systemError)}`,
      );
    }
  }
};

describe('GIF real browser playback', () => {
  it('controls actual pixels on mobile: reveal, pause, reduced motion, and page re-entry', async () => {
    const bundle = await build({
      stdin: {
        contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {AnimatedGif} from './src/AnimatedGif';
      const bytes=new Uint8Array([...Array.from('GIF89a',s=>s.charCodeAt(0)),1,0,1,0,128,0,0,255,0,0,0,0,255,
        33,249,4,0,50,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,
        33,249,4,0,50,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,76,1,0,59]);
      const url=URL.createObjectURL(new Blob([bytes],{type:'image/gif'}));
      const root=createRoot(document.getElementById('root'));
      window.render=(override={})=>root.render(<AnimatedGif src={url} alt="motion" visible playing staticMode={false}
        reducedMotion={false} elementId="motion" resourceId="gif" fit="contain" controlLabel={x=>x}
        style={{width:320,height:180,position:'relative'}} {...override}/>);
      window.leave=()=>root.render(null); window.render();`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const browser = await launchChromium();
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
      const pixel = () =>
        page.evaluate(() =>
          Array.from(
            document.querySelector('canvas')!.getContext('2d')!.getImageData(0, 0, 1, 1).data,
          ),
        );
      const update = (value: Record<string, unknown>) =>
        page.evaluate((value) => (window as any).render(value), value);
      await page.waitForFunction(
        () =>
          document.querySelector('canvas')?.getContext('2d')?.getImageData(0, 0, 1, 1).data[0] ===
          255,
      );
      expect(await pixel()).toEqual([255, 0, 0, 255]);
      await page.waitForFunction(
        () =>
          document.querySelector('canvas')?.getContext('2d')?.getImageData(0, 0, 1, 1).data[2] ===
          255,
      );
      await update({ playing: false });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-gif-state]')?.getAttribute('data-gif-state') === 'paused',
      );
      const paused = await pixel();
      await page.waitForTimeout(650);
      expect(await pixel()).toEqual(paused);
      await update({ visible: false });
      await page.waitForTimeout(50);
      await update({ visible: true, playing: false });
      await page.waitForFunction(
        () =>
          document.querySelector('canvas')?.getContext('2d')?.getImageData(0, 0, 1, 1).data[0] ===
          255,
      );
      expect(await pixel()).toEqual([255, 0, 0, 255]);
      await page.evaluate(() => (window as any).leave());
      await page.waitForSelector('canvas', { state: 'detached' });
      await update({ reducedMotion: true });
      await page.waitForSelector('button');
      await page.waitForTimeout(650);
      expect(await pixel()).toEqual([255, 0, 0, 255]);
      await page.getByRole('button', { name: 'play', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('canvas')?.getContext('2d')?.getImageData(0, 0, 1, 1).data[2] ===
          255,
      );
      await page.getByRole('button', { name: 'pause', exact: true }).click();
      const manuallyPaused = await pixel();
      await page.waitForTimeout(650);
      expect(await pixel()).toEqual(manuallyPaused);
    } finally {
      await browser.close();
    }
  }, 20_000);
});
