import {
  acquireDeckChromium,
  deckChromiumLaunchOptions,
  launchDeckChromium,
  CODE_MEDIA_LIMITS,
} from '../code-media-policy';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveReachDeckRuntimeAsset } from '../runtime-assets';
import { build } from 'esbuild';
import { parse } from 'parse5';
import sharp from 'sharp';
import { chromium, type Browser } from 'playwright-core';
import {
  parseReachDeckNativeSlideV2,
  resolveDeckDesignTheme,
  resolveDeckTheme,
} from '@reachany/reach-deck-dsl';
import { loadHtmlLayoutFonts, loadHtmlMathStyles, resolveHtmlLayoutFontRuns } from './fonts';
import {
  HTML_LAYOUT_LIMITS,
  HtmlLayoutValidationError,
  type CompileHtmlLayoutInput,
  type HtmlLayoutResult,
  type HtmlLayoutFontRun,
} from './types';

export { HTML_LAYOUT_LIMITS, HtmlLayoutValidationError } from './types';
export type {
  CompileHtmlLayoutInput,
  HtmlLayoutAsset,
  HtmlLayoutAssetBinding,
  HtmlLayoutResult,
} from './types';
export { HTML_REFERENCE_LAYOUT_VERSION, HTML_REFERENCE_LAYOUT_PROMPT } from './reference-tables';

let bundle: Promise<string> | undefined;
function browserBundle(): Promise<string> {
  if (process.env.NODE_ENV === 'production')
    return (bundle ??= readFile(resolveReachDeckRuntimeAsset('html-layout-bundle'), 'utf8'));
  return (bundle ??= build({
    entryPoints: [resolveReachDeckRuntimeAsset('html-layout-source')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    plugins: [
      {
        name: 'html-layout-static-tailwind-theme',
        setup(builder) {
          builder.onResolve({ filter: /^tailwindcss\/theme\.css\?raw$/ }, () => ({
            path: resolveReachDeckRuntimeAsset('tailwind-theme'),
            namespace: 'raw-theme',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'raw-theme' }, async ({ path: filename }) => ({
            contents: await readFile(filename, 'utf8'),
            loader: 'text',
          }));
        },
      },
    ],
  })
    .then((result) => result.outputFiles[0]!.text)
    .catch((error) => {
      bundle = undefined;
      throw error;
    }));
}

function imageBytes(dataUrl: string): Buffer {
  const match = /^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    dataUrl,
  );
  if (!match) throw new Error('HTML images must use supported base64 data URLs.');
  if (match[1]!.length > HTML_LAYOUT_LIMITS.totalPixels * 4)
    throw new Error('HTML image byte budget exceeded.');
  return Buffer.from(match[1]!, 'base64');
}

export async function validateHtmlLayoutInput(input: CompileHtmlLayoutInput): Promise<void> {
  if (!input.pageId.trim()) throw new Error('HTML layout requires a page ID.');
  if (Buffer.byteLength(input.html, 'utf8') > HTML_LAYOUT_LIMITS.htmlBytes)
    throw new HtmlLayoutValidationError('HTML layout byte budget exceeded.');
  const root = parse(input.html);
  if (!/^\s*<!doctype\s+html\s*>/i.test(input.html))
    throw new HtmlLayoutValidationError(
      'HTML layout requires a complete HTML document, not JSON or Markdown.',
    );
  let nodes = 0;
  const images: Array<{
    source: string;
    modelAuthored: boolean;
    codeAnimation?: { sourceDigest: string; frameCount: number };
  }> = [];
  function visit(node: unknown): void {
    if (++nodes > HTML_LAYOUT_LIMITS.domNodes)
      throw new HtmlLayoutValidationError('HTML layout DOM node budget exceeded.');
    const element = node as {
      tagName?: string;
      attrs?: Array<{ name: string; value: string }>;
      childNodes?: unknown[];
      content?: unknown;
    };
    if (element.tagName === 'img') {
      const src = element.attrs?.find((attribute) => attribute.name === 'src')?.value;
      if (src?.startsWith('data:')) images.push({ source: src, modelAuthored: true });
    }
    for (const child of element.childNodes ?? []) visit(child);
    if (element.content) visit(element.content);
  }
  visit(root);
  if (input.assets.length > HTML_LAYOUT_LIMITS.mediaResources)
    throw new Error('HTML layout asset budget exceeded.');
  for (const asset of input.assets)
    if (asset.kind === 'image')
      images.push({
        source: asset.dataUrl,
        modelAuthored: false,
        codeAnimation: asset.isPlaceholder ? undefined : asset.codeAnimation,
      });
  // Validate the trusted asset budget first so upstream asset failures cannot trigger model correction.
  images.sort((left, right) => Number(left.modelAuthored) - Number(right.modelAuthored));
  let pixels = 0;
  for (const { source, modelAuthored, codeAnimation } of images) {
    const metadata = await (async () => {
      try {
        return await sharp(imageBytes(source), {
          limitInputPixels: HTML_LAYOUT_LIMITS.imagePixels,
          animated: false,
        }).metadata();
      } catch (cause) {
        if (modelAuthored)
          throw new HtmlLayoutValidationError(
            'HTML inline image is invalid or exceeds its pixel budget.',
            { cause },
          );
        throw cause;
      }
    })();
    const size = (metadata.width ?? 0) * (metadata.height ?? 0);
    const frames = metadata.pages ?? 1;
    const trustedAnimation =
      !modelAuthored &&
      codeAnimation !== undefined &&
      /^[a-f0-9]{64}$/.test(codeAnimation.sourceDigest) &&
      metadata.format === 'gif' &&
      frames === codeAnimation.frameCount &&
      frames >= 2 &&
      frames <= CODE_MEDIA_LIMITS.frames &&
      metadata.width! <= CODE_MEDIA_LIMITS.gifWidth &&
      metadata.height! <= CODE_MEDIA_LIMITS.gifHeight &&
      size * frames <= CODE_MEDIA_LIMITS.decodedFramePixels;
    if (!size || size > HTML_LAYOUT_LIMITS.imagePixels || (frames > 1 && !trustedAnimation))
      throw new (modelAuthored ? HtmlLayoutValidationError : Error)(
        'HTML layout image pixel or frame budget exceeded.',
      );
    pixels += size;
    if (pixels > HTML_LAYOUT_LIMITS.totalPixels)
      throw new (modelAuthored ? HtmlLayoutValidationError : Error)(
        'HTML layout total pixel budget exceeded.',
      );
  }
}

async function compileInBrowser(
  input: CompileHtmlLayoutInput,
  signal: AbortSignal,
): Promise<HtmlLayoutResult> {
  signal.throwIfAborted();
  await validateHtmlLayoutInput(input);
  const [script, fontCss, mathCss] = await Promise.all([
    browserBundle(),
    loadHtmlLayoutFonts(input.html),
    loadHtmlMathStyles(),
  ]);
  signal.throwIfAborted();
  let browser: Browser | undefined;
  const close = () => {
    void browser?.close().catch(() => undefined);
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    browser = await launchDeckChromium(() =>
      chromium.launch({
        ...deckChromiumLaunchOptions(),
        timeout: HTML_LAYOUT_LIMITS.timeoutMs,
      }),
    );
    signal.throwIfAborted();
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.route('**/*', (route) => route.abort('blockedbyclient'));
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html><body style="margin:0;background:transparent"></body></html>',
    );
    await page.exposeFunction('resolveLayoutFonts', (runs: HtmlLayoutFontRun[]) =>
      resolveHtmlLayoutFontRuns(
        runs,
        (input.designContext
          ? resolveDeckDesignTheme(input.themeName, input.designContext)
          : resolveDeckTheme(input.themeName)
        ).fontBody,
      ),
    );
    await page.exposeFunction(
      'captureLayoutRaster',
      async (rect: { x: number; y: number; width: number; height: number }) => {
        signal.throwIfAborted();
        const bytes = await page.screenshot({
          type: 'png',
          omitBackground: true,
          clip: rect,
          timeout: HTML_LAYOUT_LIMITS.timeoutMs,
        });
        return `data:image/png;base64,${bytes.toString('base64')}`;
      },
    );
    if (input.onPreparedHtml) {
      await page.exposeFunction('capturePreparedHtml', input.onPreparedHtml);
    }
    await page.addScriptTag({ content: script });
    const { signal: _signal, onPreparedHtml, ...serializable } = input;
    // The compiler measures a single frame. Native resources still point at the original GIF bytes.
    const previewAssets = await Promise.all(
      input.assets.map(async (asset) => {
        if (asset.kind !== 'image' || !asset.codeAnimation || asset.isPlaceholder) return asset;
        const firstFrame = await sharp(imageBytes(asset.dataUrl), {
          animated: false,
          page: 0,
          limitInputPixels: CODE_MEDIA_LIMITS.gifWidth * CODE_MEDIA_LIMITS.gifHeight,
        })
          .png()
          .toBuffer();
        return { ...asset, dataUrl: `data:image/png;base64,${firstFrame.toString('base64')}` };
      }),
    );
    const outcome = await page.evaluate(
      async (value) => {
        try {
          return { ok: true as const, result: await window.compileProductionHtml(value) };
        } catch (error) {
          if (error instanceof Error && error.name === 'HtmlLayoutValidationError') {
            return { ok: false as const, message: error.message };
          }
          throw error;
        }
      },
      {
        ...serializable,
        assets: previewAssets,
        capturePreparedHtml: Boolean(onPreparedHtml),
        fontCss: `${fontCss}\n${mathCss}`,
      },
    );
    if (!outcome.ok) throw new HtmlLayoutValidationError(outcome.message);
    const result = outcome.result;
    signal.throwIfAborted();
    for (const media of result.pendingMedia) {
      const digest = createHash('sha256')
        .update(JSON.stringify(input.pageId))
        .update('\0')
        .update(imageBytes(media.dataUrl))
        .digest('hex');
      const id = `html-media-${digest}`;
      for (const element of result.slide.elements)
        if (element.type === 'image' && element.resourceId === media.resourceId)
          element.resourceId = id;
      media.resourceId = id;
    }
    result.pendingMedia = [
      ...new Map(result.pendingMedia.map((item) => [item.resourceId, item])).values(),
    ];
    result.resources = [...new Map(result.resources.map((item) => [item.id, item])).values()];
    result.slide = parseReachDeckNativeSlideV2(result.slide);
    return result;
  } finally {
    signal.removeEventListener('abort', close);
    await browser?.close();
  }
}

/**
 * 在共享 Chromium 槽位内编译一页 HTML 版面。
 *
 * 排队等槽位只受调用方信号约束（幻灯片整页另有 10 分钟上限），60 秒预算从拿到槽位才开始；
 * 否则批量生成时排队本身就会把页面耗成超时。排队中取消会立刻出队，不启动浏览器。
 */
export async function compileHtmlLayout(input: CompileHtmlLayoutInput): Promise<HtmlLayoutResult> {
  const release = await acquireDeckChromium(input.signal);
  let compiling: Promise<HtmlLayoutResult> | undefined;
  let rejectAbort: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(HTML_LAYOUT_LIMITS.timeoutMs),
    ]);
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal!.reason);
      signal!.addEventListener('abort', rejectAbort, { once: true });
    });
    compiling = compileInBrowser(input, signal);
    // 中断时先把调用方放走，槽位要等浏览器真正关闭后才释放，避免超额启动 Chromium。
    void compiling.then(release, release);
    return await Promise.race([compiling, aborted]);
  } finally {
    if (rejectAbort) signal?.removeEventListener('abort', rejectAbort);
    if (!compiling) release();
  }
}
