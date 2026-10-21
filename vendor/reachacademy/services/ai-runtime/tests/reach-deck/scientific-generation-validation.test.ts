import { describe, expect, it } from 'vitest';

import {
  assertScientificVisualHtmlIsSafe,
  assertScientificVisualScripts,
  createGeneratedScientificVisualParser,
} from '../../lib/reach-deck/scientific-generation-validation.js';

const manifest = {
  schemaVersion: 'reach-scientific-visual-manifest/v2' as const,
  hooksVersion: 'reach-scientific-visual-hooks/v1' as const,
  anchors: [
    { id: 'launch', description: 'The projectile begins moving.' },
    { id: 'apex', description: 'The vertical velocity reaches zero.' },
  ],
  dependencies: [{ id: 'function-plot', version: '1.0.0' }],
  resourceIds: ['trajectory-data'],
  ariaLabel: 'Projectile trajectory over time',
  textAlternative: 'A projectile rises to an apex and then falls under constant gravity.',
};

const validHtml = String.raw`<!doctype html>
<html><head><style>html,body,#root{width:100%;height:100%;margin:0}</style></head>
<body><div id="root"></div><script>
ReachScientificVisual.register(({ root, dependencies, resources }) => {
  const plot = dependencies.get('function-plot');
  const data = resources.resolve('trajectory-data');
  return {
    present(frame) {
      const progress = frame.anchors.find((anchor) => anchor.id === 'apex')?.progress ?? 0;
      root.textContent = String(progress + plot.version.length + Number(Boolean(data)));
    },
    resize(viewport) { root.dataset.width = String(viewport.width); },
    suspend() {}, resume() {}, dispose() {}
  };
});
</script></body></html>`;

describe('scientific generation validation', () => {
  it('accepts one deterministic Hook controller with exact declared dependencies and resources', () => {
    expect(() => assertScientificVisualHtmlIsSafe(validHtml)).not.toThrow();
    expect(() => assertScientificVisualScripts(validHtml, manifest)).not.toThrow();
    expect(
      createGeneratedScientificVisualParser('page-1')({
        id: 'page-1',
        documentHtml: validHtml,
        manifest,
      }),
    ).toMatchObject({ id: 'page-1', manifest });
  });

  it.each([
    ['iframe', '<iframe src="https://example.test"></iframe>'],
    ['external link', '<link rel="stylesheet" href="https://example.test/a.css">'],
    ['event handler', '<button onclick="fetch(\'https://example.test\')">go</button>'],
    ['CSS URL', '<style>#root{background:url(https://example.test/a.png)}</style>'],
    ['form', '<form action="/submit"></form>'],
  ])('rejects forbidden %s HTML without fetching it', (_label, fragment) => {
    expect(() => assertScientificVisualHtmlIsSafe(`<html><body>${fragment}</body></html>`)).toThrow(
      /cannot|forbidden/i,
    );
  });

  it.each([
    ['network', "fetch('https://example.test')"],
    ['storage', "localStorage.setItem('x', '1')"],
    ['navigation', "window.location.href = 'https://example.test'"],
    ['randomness', 'Math.random()'],
    ['wall clock', 'new Date()'],
    ['dynamic import', "import('https://example.test/module.js')"],
    ['bridge spoofing', "window.parent.postMessage('ready', '*')"],
    ['eval', "eval('1 + 1')"],
    ['window timer', 'window.setTimeout(() => {}, 1)'],
    ['window clock', 'window.Date.now()'],
    ['computed window member', "window['fetch']('https://example.test')"],
    ['window alias', 'const w = window; w.setTimeout(() => {}, 1)'],
    ['innerHTML SVG assembly', "root.innerHTML = '<svg><rect>'"],
    ['adjacent HTML assembly', "root.insertAdjacentHTML('beforeend', '<svg></svg>')"],
  ])('rejects %s APIs in generated scripts', (_label, expression) => {
    const html = `<script>ReachScientificVisual.register(({root,dependencies,resources}) => { ${expression}; return {present(){}}; });</script>`;
    expect(() =>
      assertScientificVisualScripts(html, { ...manifest, dependencies: [], resourceIds: [] }),
    ).toThrow();
  });

  it('requires exactly one registration and exact manifest references', () => {
    expect(() =>
      assertScientificVisualScripts('<script>const value = 1;</script>', {
        ...manifest,
        dependencies: [],
        resourceIds: [],
      }),
    ).toThrow(/register exactly once/);
    expect(() =>
      assertScientificVisualScripts(
        `<script>ReachScientificVisual.register(({dependencies}) => { dependencies.get('undeclared'); return {present(){}}; });</script>`,
        { ...manifest, dependencies: [], resourceIds: [] },
      ),
    ).toThrow(/exactly match/);
    expect(() =>
      assertScientificVisualScripts(
        `<script>ReachScientificVisual.register(() => ({present(){}})); ReachScientificVisual.register(() => ({present(){}}));</script>`,
        { ...manifest, dependencies: [], resourceIds: [] },
      ),
    ).toThrow(/register exactly once/);
  });

  it('allows one script-only correction but protects manifest identity and non-script DOM', () => {
    const parse = createGeneratedScientificVisualParser('page-1');
    expect(() =>
      parse({
        id: 'page-1',
        documentHtml: validHtml.replace('const progress', 'const ='),
        manifest,
      }),
    ).toThrow(/invalid JavaScript/);
    expect(() => parse({ id: 'page-1', documentHtml: validHtml, manifest })).not.toThrow();

    const changedManifest = {
      ...manifest,
      anchors: [{ id: 'different', description: 'Changed after correction.' }],
    };
    expect(() =>
      parse({ id: 'page-1', documentHtml: validHtml, manifest: changedManifest }),
    ).toThrow(/changed protected fields/);

    const parseDomInvariant = createGeneratedScientificVisualParser('page-2');
    const pageTwoHtml = validHtml.replaceAll('page-1', 'page-2');
    expect(() =>
      parseDomInvariant({
        id: 'page-2',
        documentHtml: pageTwoHtml.replace('const progress', 'const ='),
        manifest,
      }),
    ).toThrow();
    expect(() =>
      parseDomInvariant({
        id: 'page-2',
        documentHtml: pageTwoHtml.replace('<div id="root"></div>', '<main id="root"></main>'),
        manifest,
      }),
    ).toThrow(/non-script document structure/);
  });
});
