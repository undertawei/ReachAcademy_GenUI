import { describe, expect, it } from 'vitest';

import {
  auditInteractiveTailwindAuthoringHtml,
  transformMaicInteractiveHtml,
} from '../src/maic/index.js';

describe('MAIC Interactive Tailwind authoring audit', () => {
  it('reports customization in executable scripts and inline event handlers', () => {
    expect(
      auditInteractiveTailwindAuthoringHtml(
        '<html><head><script type="module">window.tailwind.config={}</script></head><body></body></html>',
      ),
    ).toEqual([{ code: 'tailwind_customization', source: 'script' }]);
    expect(
      auditInteractiveTailwindAuthoringHtml(
        '<html><head></head><body><button onclick="tailwind.config={};return false">Try</button></body></html>',
      ),
    ).toEqual([{ code: 'tailwind_customization', source: 'event-handler' }]);
  });

  it('ignores non-executable script data and locally bound Tailwind-shaped values', () => {
    expect(
      auditInteractiveTailwindAuthoringHtml(
        '<html><head><script type="application/json">{"tailwind":{"config":{}}}</script><script>const tailwind={config:{}};tailwind.config.theme={}</script></head><body></body></html>',
      ),
    ).toEqual([]);
  });

  it('reports URL-bearing arbitrary utilities in class and JavaScript values', () => {
    expect(
      auditInteractiveTailwindAuthoringHtml(
        String.raw`<html><head></head><body><div class="bg-[u\72l(https://example.test/a.png)]"></div></body></html>`,
      ),
    ).toEqual([{ code: 'tailwind_url_utility', source: 'class' }]);
    expect(
      auditInteractiveTailwindAuthoringHtml(
        String.raw`<html><head></head><body><button onclick="this.classList.add('bg-[u\\72l(https://example.test/a.png)]');return false">Try</button></body></html>`,
      ),
    ).toEqual([{ code: 'tailwind_url_utility', source: 'event-handler' }]);
  });

  it('reports escaped Tailwind directives in style text and de-duplicates findings', () => {
    expect(
      auditInteractiveTailwindAuthoringHtml(
        String.raw`<html><head><style>@pl\75gin "synthetic";</style><style>@config "other";</style></head><body><script>tailwind.config={}</script></body></html>`,
      ),
    ).toEqual([{ code: 'tailwind_customization', source: 'style' }]);
  });

  it.each([
    {
      html: '<html><head><script>window.tailwind.config={}</script></head><body></body></html>',
      code: 'maic.interactive.tailwind_customization',
      message: 'Tailwind runtime configuration and plugins are not supported during import.',
    },
    {
      html: '<html><head><style>@plugin "synthetic";</style></head><body></body></html>',
      code: 'maic.interactive.tailwind_customization',
      message:
        'Tailwind @config, @plugin, @import, and @reference directives are not supported during import.',
    },
    {
      html: '<html><head></head><body><div class="bg-[url(https://example.test/a.png)]"></div></body></html>',
      code: 'maic.interactive.tailwind_url_utility',
      message: 'Tailwind arbitrary utilities containing url(...) are not supported.',
    },
  ])('preserves the importer diagnostic for $code', ({ html, code, message }) => {
    const result = transformMaicInteractiveHtml(html, {
      pageId: 'diagnostic',
      sourceOrder: 1,
    });

    expect(result.diagnostics).toEqual([
      {
        code,
        severity: 'error',
        feature: 'interactive',
        message,
        location: { pageId: 'diagnostic', sourceOrder: 1 },
      },
    ]);
  });

  it('leaves the platform marker rule in the importer transform', () => {
    const html = '<html data-reach-tailwind-runtime="4.3.0"><head></head><body></body></html>';

    expect(auditInteractiveTailwindAuthoringHtml(html)).toEqual([]);
    expect(transformMaicInteractiveHtml(html, { pageId: 'marker', sourceOrder: 1 })).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'maic.interactive.tailwind_marker_reserved',
          message: 'Interactive HTML cannot declare the platform-owned Tailwind runtime marker.',
        },
      ],
    });
  });
});
