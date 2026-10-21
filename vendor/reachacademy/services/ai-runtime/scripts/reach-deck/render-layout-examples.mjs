import { loadSharedAttachmentCss } from './shared-attachment-css.mjs';
/**
 * Render the canonical prompt few-shots through the production NativeV2 renderer.
 *
 * The generated image placeholders exist only in this visual audit. The prompt examples continue
 * to carry media intent and assetId bindings, never image bytes, URLs, or object keys.
 *
 * Usage:
 *   pnpm --filter @reachany/ai-runtime render:layout-examples
 *   pnpm --filter @reachany/ai-runtime render:layout-examples -- --output-dir tmp/my-gallery
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  compileDeckSlideToNativeV2,
  judgeSlideStatic,
  LAYOUT_REFERENCE_CATALOG,
  materializeWorkedExampleSlide,
  parseDeckSlideValue,
  resolveDeckTheme,
} from '@reachany/reach-deck-dsl';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const PLAYER_ROOT = path.join(REPOSITORY_ROOT, 'packages/reach-deck-player');
const DEFAULT_OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'tmp/reach-deck-layout-examples');
const STAGE = { width: 1600, height: 900 };

const optionValue = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const requestedOutput = optionValue('--output-dir');
const outputDirectory = requestedOutput
  ? path.resolve(REPOSITORY_ROOT, requestedOutput)
  : DEFAULT_OUTPUT_DIRECTORY;
const allowedOutputRoots = ['tmp', '.tmp'].map((directory) =>
  path.join(REPOSITORY_ROOT, directory),
);
const isAllowedOutput = allowedOutputRoots.some((root) => {
  const relative = path.relative(root, outputDirectory);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
});
if (!isAllowedOutput) {
  throw new Error('The output directory must be a child of repository tmp/ or .tmp/.');
}
const harnessDirectory = path.join(outputDirectory, '.harness');

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
const placeholderDataUrl = () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
    <rect width="1200" height="900" fill="#eceff3"/>
    <rect x="6" y="6" width="1188" height="888" fill="none" stroke="#c9d2db" stroke-width="4"/>
    <g stroke="#9aa7b4" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(600 450)">
      <rect x="-110" y="-82" width="220" height="164" rx="14"/>
      <circle cx="-46" cy="-26" r="16"/>
      <path d="M -110 44 L -30 -18 L 22 22 L 62 -8 L 110 32"/>
    </g>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const loadPlayerCss = async () => {
  const [styles, fonts, mathStyles, katexStyles, mathliveFonts] = await Promise.all([
    readFile(path.join(PLAYER_ROOT, 'styles.css'), 'utf8'),
    readFile(path.join(PLAYER_ROOT, 'fonts/fonts.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/tiptap-mathlive/styles.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'node_modules/katex/dist/katex.min.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'node_modules/mathlive/mathlive-fonts.css'), 'utf8'),
  ]);
  const fontsDirectoryUrl = pathToFileURL(path.join(PLAYER_ROOT, 'fonts')).href;
  const inlinedFonts = fonts.replaceAll('url("./', `url("${fontsDirectoryUrl}/`);
  // Keep KaTeX's MathML accessibility layer clipped in the standalone visual-audit renderer.
  // The production bundle gets these imports from the app bundler; this script must inline them.
  const inlinedMathStyles = [
    katexStyles.replace(/@font-face\{[^}]*\}/g, ''),
    mathliveFonts.replace(/@font-face\{[^}]*\}/g, ''),
    mathStyles.replace(/^@import .*;$/gm, ''),
  ].join('\n');
  return (
    (await loadSharedAttachmentCss()) +
    '\n' +
    styles
      .replace("@import '@reachany/tiptap-mathlive/styles.css';", inlinedMathStyles)
      .replace("@import './fonts/fonts.css';", inlinedFonts)
  );
};

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(harnessDirectory, { recursive: true });

const entryPath = path.join(harnessDirectory, 'entry.jsx');
const playerModule = path.join(PLAYER_ROOT, 'dist/NativeV2SlideRenderer.js');
await writeFile(
  entryPath,
  `import { createRoot } from 'react-dom/client';
import { NativeV2SlideRenderer } from ${JSON.stringify(playerModule)};

createRoot(document.getElementById('root')).render(
  <div className="reach-deck-player" style={{ width: ${STAGE.width} }}>
    <NativeV2SlideRenderer
      hideDiagnostics
      resourceUrlsById={window.__PAYLOAD__.resourceUrlsById}
      slide={window.__PAYLOAD__.slide}
      stage={window.__PAYLOAD__.stage}
      themeColors={window.__PAYLOAD__.themeColors}
    />
  </div>,
);`,
  'utf8',
);
const bundle = await build({
  absWorkingDir: REPOSITORY_ROOT,
  bundle: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  entryPoints: [entryPath],
  format: 'iife',
  jsx: 'automatic',
  loader: { '.js': 'jsx' },
  nodePaths: [path.join(REPOSITORY_ROOT, 'node_modules')],
  write: false,
});
const bundleText = bundle.outputFiles[0].text;
const playerCss = await loadPlayerCss();
const theme = resolveDeckTheme('reach-classic');
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: STAGE });
const galleryEntries = [];

for (const [index, reference] of LAYOUT_REFERENCE_CATALOG.entries()) {
  const example = reference.examples[0];
  const slide = parseDeckSlideValue(materializeWorkedExampleSlide(example));
  slide.typographyProfile = 'v16';
  const judged = judgeSlideStatic(slide);
  const compiled = compileDeckSlideToNativeV2({ slide, theme, duration: slide.duration });
  const themeResource = compiled.resources.themes[0];
  const assetsByObjectKey = new Map(
    example.resolvedMediaAssets.map((asset) => [
      `worked-examples/${example.id}/${asset.assetId}.png`,
      asset,
    ]),
  );
  const resourceUrlsById = Object.fromEntries(
    compiled.resources.media.map((resource) => {
      const asset = assetsByObjectKey.get(resource.objectKey);
      if (!asset) throw new Error(`No preview asset metadata for ${resource.objectKey}.`);
      return [resource.id, placeholderDataUrl()];
    }),
  );
  const payload = {
    resourceUrlsById,
    slide: compiled.slide,
    stage: STAGE,
    themeColors: themeResource?.colors ?? {},
  };
  const renderHtml = `<!doctype html><html><head><meta charset="utf-8">
    <style>html,body,#root{margin:0;width:${STAGE.width}px;height:${STAGE.height}px;overflow:hidden}</style>
    <style>${playerCss}</style></head><body><div id="root"></div>
    <script>window.__PAYLOAD__=${JSON.stringify(payload).replaceAll('<', '\\u003c')};</script>
    <script>${bundleText}</script></body></html>`;
  const renderPath = path.join(harnessDirectory, `${String(index + 1).padStart(2, '0')}.html`);
  const screenshotName = `${String(index + 1).padStart(2, '0')}-${example.id}.png`;
  await writeFile(renderPath, renderHtml, 'utf8');
  await page.goto(pathToFileURL(renderPath).href);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolve, reject) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', reject, { once: true });
            }),
      ),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const probe = await page.evaluate(() => ({
    elementCount: document.querySelectorAll('[data-native-v2-element-id]').length,
    imageCount: document.querySelectorAll('[data-native-v2-resource-id]').length,
    stage: document.querySelector('[data-native-v2-stage]')?.getBoundingClientRect().toJSON(),
    text: document.body.textContent?.trim().length ?? 0,
  }));
  if (
    probe.elementCount === 0 ||
    probe.text === 0 ||
    probe.stage?.width !== STAGE.width ||
    probe.imageCount !== Object.keys(resourceUrlsById).length
  ) {
    throw new Error(`Render probe failed for ${example.id}: ${JSON.stringify(probe)}`);
  }
  await page.locator('[data-native-v2-viewport]').screenshot({
    path: path.join(outputDirectory, screenshotName),
  });
  galleryEntries.push({
    classification: example.brief.classification,
    compositionNotes: example.compositionNotes,
    id: example.id,
    judgeStatus: judged.status,
    screenshotName,
    visualAssets: example.brief.visualAssets,
  });
  console.log(
    `[${index + 1}/${LAYOUT_REFERENCE_CATALOG.length}] ${example.id}: ${judged.status}, ${probe.elementCount} elements, ${probe.imageCount} images`,
  );
}

const galleryCards = galleryEntries
  .map(
    (entry, index) => `<article>
      <header><span class="number">${String(index + 1).padStart(2, '0')}</span><div><h2>${escapeHtml(entry.id)}</h2>
      <p>${escapeHtml(entry.classification.primaryType)} / ${escapeHtml(entry.classification.visualFocus)} / ${escapeHtml(entry.classification.density)}</p></div>
      <span class="status">${escapeHtml(entry.judgeStatus)}</span></header>
      <a href="${escapeHtml(entry.screenshotName)}"><img src="${escapeHtml(entry.screenshotName)}" alt="${escapeHtml(entry.id)} rendered slide"></a>
      <div class="details"><section><h3>Composition notes</h3><ul>${entry.compositionNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>
      <section><h3>Visual assets (${entry.visualAssets.length})</h3>${entry.visualAssets.length === 0 ? '<p>No generated image planned.</p>' : `<ul>${entry.visualAssets.map((asset) => `<li><strong>${escapeHtml(asset.placement)}</strong> ${escapeHtml(asset.purpose)} <small>${escapeHtml(asset.aspectRatio)}</small></li>`).join('')}</ul>`}</section></div>
    </article>`,
  )
  .join('\n');
const galleryHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reach Deck canonical few-shot gallery</title><style>
  :root{font-family:Inter,"Noto Sans SC",system-ui,sans-serif;color:#1d2935;background:#edf1f4}*{box-sizing:border-box}body{margin:0}main{width:min(1840px,100%);margin:auto;padding:32px}h1{font-size:32px;margin:0 0 8px}main>p{color:#566574;margin:0 0 28px}article{background:#fff;border:1px solid #d6dee5;border-radius:8px;margin:0 0 32px;overflow:hidden}header{display:flex;align-items:center;gap:16px;padding:18px 22px;border-bottom:1px solid #e1e7ec}header div{min-width:0;flex:1}.number{font:700 24px ui-monospace,monospace;color:#2f65a7}h2{font-size:20px;margin:0 0 5px;overflow-wrap:anywhere}header p{font-size:14px;color:#657482;margin:0}.status{font-size:13px;font-weight:700;color:#19613f;background:#dff2e5;padding:5px 9px;border-radius:4px}article>a{display:block;background:#cbd4dc}img{display:block;width:100%;height:auto}.details{display:grid;grid-template-columns:1fr 1fr;gap:32px;padding:20px 24px 24px}.details h3{font-size:14px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px}.details p,.details li{font-size:14px;line-height:1.55;color:#495967}.details ul{margin:0;padding-left:20px}.details small{color:#778692;margin-left:6px}@media(max-width:760px){main{padding:16px}.details{grid-template-columns:1fr}header{align-items:flex-start;flex-wrap:wrap}}
  </style></head><body><main><h1>Reach Deck canonical few-shot gallery</h1><p>真实 NativeV2 渲染；图片区域使用仅限本审计页的代码占位图，不属于 few-shot prompt。</p>${galleryCards}</main></body></html>`;
const indexPath = path.join(outputDirectory, 'index.html');
await writeFile(indexPath, galleryHtml, 'utf8');
await writeFile(
  path.join(outputDirectory, 'manifest.json'),
  `${JSON.stringify(galleryEntries, null, 2)}\n`,
  'utf8',
);

await page.setViewportSize({ width: 1800, height: 1000 });
await page.goto(pathToFileURL(indexPath).href);
await page.waitForLoadState('load');
await page.screenshot({ path: path.join(outputDirectory, 'contact-sheet.png'), fullPage: true });
await browser.close();
await rm(harnessDirectory, { recursive: true, force: true });
console.log(`Gallery: ${indexPath}`);
