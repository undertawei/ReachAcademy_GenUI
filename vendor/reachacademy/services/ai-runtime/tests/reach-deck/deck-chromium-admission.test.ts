import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDeckChromium,
  DECK_CHROMIUM_SLOTS,
} from '../../lib/reach-deck/code-media-policy.js';
import { renderStaticDiagram } from '../../lib/reach-deck/diagram-renderer.js';
import { compileHtmlLayout } from '../../lib/reach-deck/html-layout/index.js';

async function occupyAll(): Promise<() => void> {
  const held = await Promise.all(
    Array.from({ length: DECK_CHROMIUM_SLOTS }, () => acquireDeckChromium()),
  );
  return () => held.forEach((release) => release());
}

function probe() {
  const state = { acquired: false, release: undefined as (() => void) | undefined };
  const done = acquireDeckChromium().then((release) => {
    state.acquired = true;
    state.release = release;
  });
  return { state, done };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.restoreAllMocks());

describe('Deck Chromium admission', () => {
  it('runs at most DECK_CHROMIUM_SLOTS browser jobs and hands a released slot to the next waiter', async () => {
    expect(DECK_CHROMIUM_SLOTS).toBe(2);
    const releaseAll = await occupyAll();
    const waiter = probe();
    await tick();
    expect(waiter.state.acquired).toBe(false);
    releaseAll();
    await waiter.done;
    expect(waiter.state.acquired).toBe(true);
    waiter.state.release!();
    // 移交后计数仍正确：全部槽位都能再次拿满。
    (await occupyAll())();
  });

  it('removes a cancelled waiter without consuming a slot', async () => {
    const releaseAll = await occupyAll();
    const controller = new AbortController();
    const cancelled = acquireDeckChromium(controller.signal);
    const later = probe();
    controller.abort(new Error('queued cancellation'));
    await expect(cancelled).rejects.toThrow('queued cancellation');
    releaseAll();
    await later.done;
    later.state.release!();
    (await occupyAll())();
  });

  it('treats a repeated release as a no-op', async () => {
    const release = await acquireDeckChromium();
    release();
    release();
    const releaseAll = await occupyAll();
    const waiter = probe();
    await tick();
    expect(waiter.state.acquired).toBe(false);
    releaseAll();
    await waiter.done;
    waiter.state.release!();
  });

  it('does not start the HTML layout budget while waiting for a browser slot', async () => {
    const releaseAll = await occupyAll();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const controller = new AbortController();
    const compiling = compileHtmlLayout({
      html: '<!doctype html><html><body></body></html>',
      pageId: 'page-1',
      themeName: 'default',
      assets: [],
      signal: controller.signal,
    });
    await tick();
    expect(timeout).not.toHaveBeenCalled();
    controller.abort(new Error('queued layout cancelled'));
    await expect(compiling).rejects.toThrow('queued layout cancelled');
    releaseAll();
    (await occupyAll())();
  });

  it('does not start the diagram budget while waiting for a browser slot', async () => {
    const releaseAll = await occupyAll();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const controller = new AbortController();
    const rendering = renderStaticDiagram({
      source: '<svg width="800" height="450"></svg>',
      width: 800,
      height: 450,
      signal: controller.signal,
    });
    await tick();
    expect(timeout).not.toHaveBeenCalled();
    controller.abort(new Error('queued diagram cancelled'));
    await expect(rendering).rejects.toThrow('queued diagram cancelled');
    releaseAll();
    (await occupyAll())();
  });
});
