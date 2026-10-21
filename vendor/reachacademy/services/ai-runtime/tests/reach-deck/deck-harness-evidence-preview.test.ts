// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareEvidencePreview } from '../../scripts/reach-deck/deck-harness-evidence.js';

beforeAll(() => {
  const settings = (window as unknown as { happyDOM: { settings: Record<string, boolean> } })
    .happyDOM.settings;
  settings.disableCSSFileLoading = true;
  settings.disableIframePageLoading = true;
  settings.disableJavaScriptEvaluation = true;
  settings.handleDisabledFileLoadingAsSuccess = true;
});

describe('same-generation HTML evidence sandbox', () => {
  it('renders familiar LaTeX delimiters in raw previews without scripts or duplicate hydration', async () => {
    const raw = String.raw`<section id="slide"><p>速度 \(v=\frac{s}{t}\)</p></section>`;
    const first = await prepareEvidencePreview(raw, [], {}, false);
    const parsed = new DOMParser().parseFromString(first, 'text/html');
    expect(
      parsed.querySelector('[data-reach-math-latex]')?.getAttribute('data-reach-math-latex'),
    ).toBe(String.raw`v=\frac{s}{t}`);
    expect(parsed.querySelectorAll('.katex')).toHaveLength(1);
    const second = await prepareEvidencePreview(first, [], {}, true);
    expect(
      new DOMParser().parseFromString(second, 'text/html').querySelectorAll('.katex'),
    ).toHaveLength(1);
    expect(parsed.querySelector('script')).toBeNull();
  });
  it('preserves local SVG masks while stripping scripts, external resources and event handlers', async () => {
    const source = `<html><head><style>@import 'https://outside.invalid/font'; .a{clip-path:url(#trusted-mask);background:url(https://outside.invalid/image)}</style></head><body><script>fetch('/api')</script><iframe src="https://outside.invalid"></iframe><svg><defs><clipPath id="trusted-mask"><circle r="4"/></clipPath></defs><use href="#trusted-mask"/></svg><img data-reach-asset="asset-1" src="https://outside.invalid/image" onerror="alert(1)"><img data-reach-asset="invented" src="/api/private"></body></html>`;
    const html = await prepareEvidencePreview(
      source,
      [{ assetId: 'asset-1', objectKey: 'known' }],
      { known: '/harness/media/known' },
      true,
    );
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('script,iframe,[onerror]')).toBeNull();
    expect(document.querySelector('[data-reach-asset="asset-1"]')?.getAttribute('src')).toBe(
      '/harness/media/known',
    );
    expect(document.querySelector('[data-reach-asset="invented"]')?.hasAttribute('src')).toBe(
      false,
    );
    expect(document.querySelector('use')?.getAttribute('href')).toBe('#trusted-mask');
    expect(html).toContain('url(#trusted-mask)');
    expect(html).not.toContain('outside.invalid');
    expect(document.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain(
      "script-src 'none'; connect-src 'none'",
    );
  });
  it('never hydrates asset URLs outside the server allowlisted media route', async () => {
    const html = await prepareEvidencePreview(
      '<main id="slide"><img data-reach-asset="asset-1"></main>',
      [{ assetId: 'asset-1', objectKey: 'known' }],
      { known: 'https://outside.invalid/image' },
      true,
    );
    expect(
      new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.hasAttribute('src'),
    ).toBe(false);
  });
  it.each([false, true])(
    'hydrates trusted empty DIV slots while retaining sanitized layout (prepared=%s)',
    async (prepared) => {
      const html = await prepareEvidencePreview(
        '<section id="slide"><div id="photo" class="media-slot" data-reach-asset="asset-1" style="position:absolute;left:80px;top:90px;width:400px;height:300px;object-fit:cover" onclick="alert(1)"></div><div data-reach-asset="unknown"></div><div data-reach-asset="asset-1">Keep text</div></section>',
        [{ assetId: 'asset-1', objectKey: 'known' }],
        { known: '/harness/media/known' },
        prepared,
      );
      const document = new DOMParser().parseFromString(html, 'text/html');
      const image = document.querySelector('#photo');
      expect(image?.tagName).toBe('IMG');
      expect(image?.getAttribute('src')).toBe('/harness/media/known');
      expect(image?.getAttribute('class')).toBe('media-slot');
      expect(image?.getAttribute('data-reach-asset')).toBe('asset-1');
      expect(image?.getAttribute('style')).toContain('object-fit:cover');
      expect(image?.getAttribute('style')).toContain('left:80px');
      expect(image?.hasAttribute('onclick')).toBe(false);
      expect(document.querySelector('[data-reach-asset="unknown"]')?.tagName).toBe('DIV');
      expect(document.querySelector('div[data-reach-asset="asset-1"]')?.textContent).toBe(
        'Keep text',
      );
    },
  );
  it('does not convert a DIV slot when its mapped URL is outside the trusted media route', async () => {
    const html = await prepareEvidencePreview(
      '<section id="slide"><div data-reach-asset="asset-1"></div></section>',
      [{ assetId: 'asset-1', objectKey: 'known' }],
      { known: 'https://outside.invalid/image' },
      true,
    );
    const slot = new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelector('[data-reach-asset]');
    expect(slot?.tagName).toBe('DIV');
    expect(slot?.hasAttribute('src')).toBe(false);
  });
});
