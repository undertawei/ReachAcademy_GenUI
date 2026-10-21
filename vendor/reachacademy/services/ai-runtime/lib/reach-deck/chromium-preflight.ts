import { chromium } from 'playwright-core';
import { deckChromiumLaunchOptions, launchDeckChromium } from './code-media-policy.js';

const PREFLIGHT_TIMEOUT_MS = 20_000;

/**
 * Worker 启动预检：用生产参数（非 root + sandbox）真实启动一次 Deck Chromium 并渲染一页。
 *
 * 核心逻辑：
 * 1. 按 deckChromiumLaunchOptions 启动浏览器，与 HTML 编译、图示、代码媒体完全同一入口；
 * 2. 离线打开空白页并执行一次脚本，确认渲染进程也能在 sandbox 内起来；
 * 3. 任一步失败抛 ReachDeckRendererUnavailableError，由 Worker 启动流程中止进程。
 *
 * 设计动机：镜像缺浏览器或节点禁用 user namespace 时，页面任务会在模型调用之后才失败，
 * 既浪费 token 又要到教师生成时才暴露；放在消费者启动前可让发布直接卡住、旧 Pod 继续服务。
 */
export async function verifyDeckChromium(): Promise<void> {
  const browser = await launchDeckChromium(() =>
    chromium.launch({ ...deckChromiumLaunchOptions(), timeout: PREFLIGHT_TIMEOUT_MS }),
  );
  try {
    await launchDeckChromium(async () => {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', (route) => route.abort('blockedbyclient'));
      const page = await context.newPage();
      page.setDefaultTimeout(PREFLIGHT_TIMEOUT_MS);
      await page.setContent('<!doctype html><html><body><p>预检</p></body></html>');
      const rendered = await page.evaluate(() => document.body.textContent);
      if (rendered !== '预检') throw new Error('Deck Chromium preflight page did not render');
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
