import { compileIframe, sanitizeGeneratedHtml, type HtmlDeckCompileResult } from './htmlPipeline';
import { findSlideRoot } from './renderedScene';
import { resolvePptSafeTailwind } from './tailwindResolver';

const SCIENTIFIC_SLOT_SELECTOR =
  '[data-reach-scientific-asset], [data-scientific-visual], [data-deck-kind="scientific-visual"], [data-deck-kind="scientificVisual"]';

export const HTML_LAYOUT_TRIAL_LIMITATIONS = [
  'This trial compiles one static slide into Native V2 in browser memory.',
  'Scientific visual asset slots are not supported by this trial.',
] as const;

function assertNoScientificSlots(document: Document): void {
  if (document.querySelector(SCIENTIFIC_SLOT_SELECTOR)) {
    throw new Error('Scientific visual asset slots are not supported by the HTML layout trial.');
  }
}

export async function prepareHarnessHtml(source: string, fontCss: string): Promise<string> {
  assertNoScientificSlots(new DOMParser().parseFromString(source, 'text/html'));
  const sanitized = sanitizeGeneratedHtml(source);
  const withTailwind = await resolvePptSafeTailwind(sanitized);
  const document = new DOMParser().parseFromString(withTailwind, 'text/html');

  // Trusted local data-font CSS must follow sanitization, which strips CSS URLs.
  const fonts = document.createElement('style');
  fonts.setAttribute('data-harness-fonts', '');
  fonts.textContent = fontCss;
  document.head.append(fonts);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after 20 seconds.`)),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function textOverflowDiagnostics(document: Document): string[] {
  const root = findSlideRoot(document);
  if (!root) return [];
  const diagnostics: string[] = [];
  for (const element of Array.from(root.children)) {
    if (!/^(H[1-6]|P|DIV)$/.test(element.tagName) || !element.textContent?.trim()) continue;
    if (element.querySelector('figure, svg, img, div, p, h1, h2, h3, h4, h5, h6')) continue;
    const style = document.defaultView?.getComputedStyle(element);
    if (style?.display === 'none' || style?.visibility === 'hidden') continue;
    const bounds = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const textBounds = range.getBoundingClientRect();
    const tolerance = 1;
    const overflows =
      element.scrollWidth > element.clientWidth + tolerance ||
      element.scrollHeight > element.clientHeight + tolerance ||
      textBounds.left < bounds.left - tolerance ||
      textBounds.right > bounds.right + tolerance ||
      textBounds.top < bounds.top - tolerance ||
      textBounds.bottom > bounds.bottom + tolerance;
    if (overflows) {
      diagnostics.push(
        `[TEXT_OVERFLOW] ${element.id || element.tagName.toLowerCase()}: rendered text exceeds its HTML box.`,
      );
    }
  }
  return diagnostics;
}

export async function compileHarnessIframe(
  iframe: HTMLIFrameElement,
  source: string,
): Promise<HtmlDeckCompileResult> {
  const document = iframe.contentDocument;
  if (!document?.defaultView) throw new Error('The HTML preview document is unavailable.');
  assertNoScientificSlots(document);
  const root = findSlideRoot(document);
  if (!root) throw new Error('The HTML preview slide is not loaded.');

  root.getBoundingClientRect();
  await withTimeout(document.fonts.ready, 'Font loading');
  await withTimeout(
    Promise.all(Array.from(document.images, (image) => image.decode())),
    'Image decoding',
  );
  await withTimeout(
    new Promise<void>((resolve) => {
      document.defaultView!.requestAnimationFrame(() => {
        document.defaultView!.requestAnimationFrame(() => resolve());
      });
    }),
    'Browser layout',
  );
  if (iframe.contentDocument !== document)
    throw new Error('The HTML preview changed during compilation.');

  const fontDiagnostics: string[] = [];
  const unverifiedFamilies = new Set<string>();
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (!element.textContent?.trim()) continue;
    const family = document.defaultView
      .getComputedStyle(element)
      .fontFamily.split(',')[0]!
      .trim()
      .replace(/^["']|["']$/g, '');
    if (family !== 'Source Han Sans VF') unverifiedFamilies.add(family);
  }
  for (const family of unverifiedFamilies) {
    fontDiagnostics.push(
      `[FONT_FAMILY_UNVERIFIED] ${family}: only Source Han Sans VF is embedded in both previews; fallback rendering may differ in Native V2.`,
    );
  }
  document.fonts.forEach((font) => {
    if (font.status === 'error') fontDiagnostics.push(`[FONT_LOAD_FAILED] ${font.family}`);
  });
  const diagnostics = [...fontDiagnostics, ...textOverflowDiagnostics(document)];
  const result = await compileIframe(iframe, source);
  return { ...result, diagnostics: [...result.diagnostics, ...diagnostics] };
}
