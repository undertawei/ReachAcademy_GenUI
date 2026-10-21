import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
  INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE,
  INTERACTIVE_TAILWIND_RUNTIME_ID,
  INTERACTIVE_TAILWIND_RUNTIME_VERSION,
} from '@reachany/reach-deck-dsl';

import {
  assertInlineScriptsHaveValidSyntax,
  assertInteractiveDocumentStaticallyCompiles,
  assertFunctionPlotMarkersAreValid,
  createGeneratedInteractiveSceneParser,
  fingerprintInteractiveNonScriptDocument,
  inferInteractiveRuntimeDependencies,
} from '../../lib/reach-deck/interactive-generation-validation.js';

const scene = (documentHtml: string, title = 'Function explorer') => ({
  schemaVersion: 'reach-interactive-scene/v2',
  id: 'page-6',
  title,
  sceneType: 'interactive',
  documentHtml,
  bridgeVersion: 'reach-interactive-bridge/v1',
  runtimeDependencies: documentHtml.includes('data-reach-function-plot')
    ? [{ id: 'function-plot', version: '1.25.4' }]
    : [],
  runtimePolicy: { completionMode: 'explicit', allowReset: true, maximumDurationSeconds: null },
  eventManifest: {
    schemaVersion: 'reach-interactive-event-manifest/v1',
    events: [],
  },
  narration: {
    schemaVersion: 'reach-interactive-narration/v1',
    text: 'Adjust the controls and observe how the result changes.',
  },
});

const html = (script: string, body = '<button class="primary" id="draw">Draw</button>') =>
  `<!doctype html><html><head><style>body { margin: 0; }</style></head><body>${body}<script>${script}</script></body></html>`;

const withTailwindMarker = (
  documentHtml: string,
  version: string = INTERACTIVE_TAILWIND_RUNTIME_VERSION,
) =>
  documentHtml.replace(
    '<html>',
    `<html ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="${version}">`,
  );

const tailwindDependency = {
  id: INTERACTIVE_TAILWIND_RUNTIME_ID,
  version: INTERACTIVE_TAILWIND_RUNTIME_VERSION,
} as const;

const REPORTED_PAGE_6_INVALID_ENDING =
  'if(window.ReachInteractive&&ReachInteractive.getInitialization)init(ReachInteractive.getInitialization())else draw()';

const functionPlotSpec = {
  schemaVersion: 'reach-function-plot/v1',
  ariaLabel: '函数图',
  viewport: { x: [-5, 5], y: [-5, 10] },
  axes: { grid: true },
  series: [{ id: 'curve', expression: 'a*x^2', colorToken: 'accent' }],
  parameters: [{ id: 'a', label: '参数 a', minimum: 0.5, maximum: 2, step: 0.1, initial: 1 }],
  markers: [],
  intersections: [],
};

describe('interactive generation validation', () => {
  it('restores the flat model event manifest and still accepts the canonical shape', () => {
    // 解析器带修正状态，每个用例单独创建。
    const parse = (value: unknown) => createGeneratedInteractiveSceneParser('page-6')(value);
    const documentHtml = html(
      "window.addEventListener('reach-interactive-initialize', () => window.ReachInteractive.ready({ restored: false }));",
    );
    const canonical = {
      schemaVersion: 'reach-interactive-event-manifest/v1',
      events: [
        {
          name: 'answer_checked',
          eventVersion: 1,
          meaning: 'Learner checked an answer.',
          payloadFields: [
            { name: 'choice', type: 'string', required: true, maxLength: 20, enum: [] },
            { name: 'score', type: 'number', required: true, minimum: 0, maximum: 100 },
            { name: 'attempt', type: 'integer', required: false, minimum: 1, maximum: 5 },
            { name: 'correct', type: 'boolean', required: true },
          ],
          delivery: { mode: 'latest', intervalMs: 500 },
        },
        {
          name: 'reset_pressed',
          eventVersion: 1,
          meaning: 'Learner reset the model.',
          payloadFields: [{ name: 'correct', type: 'boolean', required: false }],
          delivery: { mode: 'immediate' },
        },
      ],
    };
    // 字段顺序故意按字母序，模拟网关强制的结构化输出键顺序。
    const flat = {
      schemaVersion: 'reach-interactive-event-manifest/v1',
      events: [
        {
          delivery: { intervalMs: 500, mode: 'latest' },
          eventVersion: 1,
          meaning: 'Learner checked an answer.',
          name: 'answer_checked',
          payloadFields: [
            // 不适用的键即使非 null 也没有语义，宿主直接丢弃。
            {
              enum: null,
              maxLength: 20,
              maximum: 9,
              minimum: null,
              name: 'choice',
              required: true,
              type: 'string',
            },
            {
              enum: null,
              maxLength: null,
              maximum: 100,
              minimum: 0,
              name: 'score',
              required: true,
              type: 'number',
            },
            {
              enum: null,
              maxLength: null,
              maximum: 5,
              minimum: 1,
              name: 'attempt',
              required: false,
              type: 'integer',
            },
            {
              enum: null,
              maxLength: null,
              maximum: null,
              minimum: null,
              name: 'correct',
              required: true,
              type: 'boolean',
            },
          ],
        },
        {
          delivery: { intervalMs: null, mode: 'immediate' },
          eventVersion: 1,
          meaning: 'Learner reset the model.',
          name: 'reset_pressed',
          payloadFields: [
            {
              enum: null,
              maxLength: null,
              maximum: null,
              minimum: null,
              name: 'correct',
              required: false,
              type: 'boolean',
            },
          ],
        },
      ],
    };
    expect(parse({ ...scene(documentHtml), eventManifest: flat }).eventManifest).toEqual(canonical);
    expect(parse({ ...scene(documentHtml), eventManifest: canonical }).eventManifest).toEqual(
      canonical,
    );
    // 适用的边界为 null 时取全局上限，避免因模型未填边界而整页修正。
    const unbounded = structuredClone(flat);
    for (const field of unbounded.events[0]!.payloadFields)
      Object.assign(field, { enum: null, maxLength: null, maximum: null, minimum: null });
    expect(
      parse({ ...scene(documentHtml), eventManifest: unbounded }).eventManifest.events[0]!
        .payloadFields,
    ).toEqual([
      { name: 'choice', type: 'string', required: true, maxLength: 200, enum: [] },
      { name: 'score', type: 'number', required: true, minimum: -1e9, maximum: 1e9 },
      { name: 'attempt', type: 'integer', required: false, minimum: -1e9, maximum: 1e9 },
      { name: 'correct', type: 'boolean', required: true },
    ]);
    const missingInterval = structuredClone(flat);
    missingInterval.events[0]!.delivery.intervalMs = null as unknown as number;
    expect(() => parse({ ...scene(documentHtml), eventManifest: missingInterval })).toThrow(
      /event delivery/,
    );
  });

  it('rejects document lifecycle listeners and permits a script-only window correction', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    const broken = html(
      "document.addEventListener('reach-interactive-initialize', () => window.ReachInteractive.ready());",
    );
    expect(() => parse(scene(broken))).toThrow(/window.addEventListener/);
    expect(() =>
      parse(scene(broken.replace('document.addEventListener', 'window.addEventListener'))),
    ).not.toThrow();
  });

  it('checks computed document lifecycle listeners without rejecting strings or DOM listeners', async () => {
    await expect(
      assertInteractiveDocumentStaticallyCompiles(
        html("window.document['addEventListener']('reach-interactive-reset', () => {});"),
      ),
    ).rejects.toThrow(/window.addEventListener/);
    await expect(
      assertInteractiveDocumentStaticallyCompiles(
        html(
          `const example = "document.addEventListener('reach-interactive-initialize')";
          // document.addEventListener('reach-interactive-reset', bad);
          document.addEventListener('DOMContentLoaded', () => {});
          window.addEventListener('reach-interactive-initialize', () => window.ReachInteractive.ready());`,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('accepts trusted geometry readers in normal Interactive generation', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )[0];
    const documentHtml = html(
      'window.ReachInteractive.ready();',
      `<div data-reach-science-kit-target="main"></div><script type="application/json" data-reach-science-kit="main">${JSON.stringify(fixture.envelope)}</script>`,
    );
    expect(inferInteractiveRuntimeDependencies(documentHtml)).toEqual([
      { id: 'geometry-euclidean-2d', version: '1.0.0' },
    ]);
    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')({
        ...scene(documentHtml),
        runtimeDependencies: [{ id: 'geometry-euclidean-2d', version: '1.0.0' }],
      }),
    ).not.toThrow();
  });

  it('combines Tailwind and geometry into one exact runtime dependency set', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )[0];
    const documentHtml = withTailwindMarker(
      html(
        'window.ReachInteractive.ready();',
        `<div data-reach-science-kit-target="main"></div><script type="application/json" data-reach-science-kit="main">${JSON.stringify(fixture.envelope)}</script>`,
      ),
    );
    const runtimeDependencies = [
      { id: 'geometry-euclidean-2d', version: '1.0.0' },
      tailwindDependency,
    ] as const;

    expect(inferInteractiveRuntimeDependencies(documentHtml)).toEqual(runtimeDependencies);
    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')({
        ...scene(documentHtml),
        runtimeDependencies,
      }),
    ).not.toThrow();
  });

  it('statically compiles inline browser JavaScript and CSS without executing them', async () => {
    await expect(
      assertInteractiveDocumentStaticallyCompiles(
        '<!doctype html><html><head><style>.prompt { font-size: 24px; }</style></head><body><script>const answer = 2 + 2;</script></body></html>',
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertInteractiveDocumentStaticallyCompiles(
        '<!doctype html><html><head></head><body><script>const answer = ;</script></body></html>',
      ),
    ).rejects.toThrow(/failed static compilation/);
    await expect(
      assertInteractiveDocumentStaticallyCompiles(
        '<!doctype html><html><head><style>.prompt { color: red; /*</style></head><body></body></html>',
      ),
    ).rejects.toThrow(/style 1 failed static compilation/);
  });

  it('infers exact pinned runtime dependencies from the complete HTML', () => {
    expect(
      inferInteractiveRuntimeDependencies(
        html(
          'window.ReachExpression.evaluate("x + 1", { x: 1 });',
          '<button class="animate__animated animate__fadeIn">Try</button>',
        ),
      ),
    ).toEqual([
      { id: 'animate-css', version: '4.1.1' },
      { id: 'expression', version: '3.0.3' },
    ]);
  });

  it('infers Tailwind only from one exact authored html-root marker and supports mixed runtimes', () => {
    expect(
      inferInteractiveRuntimeDependencies(
        withTailwindMarker(html('window.ReachExpression.evaluate("x + 1", { x: 1 });')),
      ),
    ).toEqual([
      { id: 'expression', version: '3.0.3' },
      { id: 'tailwind-browser', version: '4.3.0' },
    ]);
    expect(
      inferInteractiveRuntimeDependencies(html('', '<div class="md:grid [color:red]" />')),
    ).toEqual([]);
    expect(inferInteractiveRuntimeDependencies(CANONICAL_BLANK_INTERACTIVE_DOCUMENT)).toEqual([]);
  });

  it.each([
    withTailwindMarker(html(''), '4.2.0'),
    html('', `<main ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="4.3.0"></main>`),
    withTailwindMarker(html('')).replace(
      '<body>',
      `<body ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="4.3.0">`,
    ),
    withTailwindMarker(html('')).replace(
      '<html ',
      `<html ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="4.3.0" `,
    ),
    `${withTailwindMarker(html(''))}<html ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="4.3.0"></html>`,
    withTailwindMarker(html('')).replace('<body>', '<body><html></html>'),
  ])('rejects malformed authored Tailwind marker source during inference', (documentHtml) => {
    expect(() => inferInteractiveRuntimeDependencies(documentHtml)).toThrow(/Tailwind/);
  });

  it('does not count marker-looking text inside an executable script as authored HTML', () => {
    expect(
      inferInteractiveRuntimeDependencies(
        html(`const sample = '<html ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="4.3.0">';`),
      ),
    ).toEqual([]);
  });

  it('rejects the reported unbraced else syntax with bounded line and column diagnostics', () => {
    expect(() => assertInlineScriptsHaveValidSyntax(html(REPORTED_PAGE_6_INVALID_ENDING))).toThrow(
      /Inline script 1 has invalid JavaScript at line 1, column \d+:/,
    );
  });

  it('accepts classic and module scripts without executing either script', () => {
    expect(() =>
      assertInlineScriptsHaveValidSyntax(
        '<!doctype html><html><head></head><body><script>globalThis.sideEffect = true;</script><script type="module">export const value = 1;</script></body></html>',
      ),
    ).not.toThrow();
    expect((globalThis as { sideEffect?: boolean }).sideEffect).toBeUndefined();
  });

  it('validates non-executable function plot markers and rejects duplicate or executable forms', () => {
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(functionPlotSpec)}</script>`;
    expect(() => assertFunctionPlotMarkersAreValid(html('', marker))).not.toThrow();
    expect(() => assertFunctionPlotMarkersAreValid(html('', marker + marker))).toThrow(
      /invalid type or id/,
    );
    expect(() =>
      assertFunctionPlotMarkersAreValid(
        html('', '<script data-reach-function-plot="main">alert(1)</script>'),
      ),
    ).toThrow(/invalid type or id/);
    expect(() =>
      assertFunctionPlotMarkersAreValid(
        html('', '<div data-reach-function-plot="main">not a marker</div>'),
      ),
    ).toThrow(/invalid type or id/);
    expect(() =>
      assertFunctionPlotMarkersAreValid(
        html(
          '',
          `<script type="application/json" data-reach-function-plot="main">${JSON.stringify({
            ...functionPlotSpec,
            callback: 'alert(1)',
          })}</script>`,
        ),
      ),
    ).toThrow(/invalid Reach function plot JSON/);
  });

  it('accepts nullable optional function-plot fields promised by the generation prompt', () => {
    const nullableSpec = {
      ...functionPlotSpec,
      axes: { grid: true, xLabel: null, yLabel: null },
      series: functionPlotSpec.series.map((series) => ({ ...series, domain: null })),
      markers: [{ id: 'vertex', seriesId: 'curve', x: 0, label: null }],
      intersections: [],
    };
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(nullableSpec)}</script>`;

    expect(() => assertFunctionPlotMarkersAreValid(html('', marker))).not.toThrow();
  });

  it('includes a bounded schema reason when a function-plot marker is invalid', () => {
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(
      {
        ...functionPlotSpec,
        axes: { grid: 'yes' },
      },
    )}</script>`;

    expect(() => assertFunctionPlotMarkersAreValid(html('', marker))).toThrow(
      /Function plot axes\.grid must be boolean/,
    );
  });

  it('normalizes attribute order and indentation but retains non-script content changes', () => {
    const left = html('broken(', '<button id="draw" class="primary">Draw</button>');
    const reordered = html(
      'window.ReachInteractive.ready();',
      '\n  <button class="primary" id="draw">Draw</button>\n',
    );
    const changed = html('window.ReachInteractive.ready();', '<button>Explain</button>');
    expect(fingerprintInteractiveNonScriptDocument(left)).toBe(
      fingerprintInteractiveNonScriptDocument(reordered),
    );
    expect(fingerprintInteractiveNonScriptDocument(left)).not.toBe(
      fingerprintInteractiveNonScriptDocument(changed),
    );
  });

  it('includes inert template content in the protected non-script fingerprint', () => {
    const left = html('broken(', '<template><p>Original explanation</p></template>');
    const changed = html(
      'window.ReachInteractive.ready();',
      '<template><p>Changed explanation</p></template>',
    );
    expect(fingerprintInteractiveNonScriptDocument(left)).not.toBe(
      fingerprintInteractiveNonScriptDocument(changed),
    );
  });

  it('allows one correction to replace only script content', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    expect(() => parse(scene(html(REPORTED_PAGE_6_INVALID_ENDING)))).toThrow(/invalid JavaScript/);
    expect(
      parse(
        scene(
          html(
            'if(window.ReachInteractive&&ReachInteractive.getInitialization){init(ReachInteractive.getInitialization());}else{draw();}',
          ),
        ),
      ),
    ).toMatchObject({
      id: 'page-6',
      title: 'Function explorer',
    });
  });

  it('accepts one exact Tailwind marker and dependency pair', () => {
    const documentHtml = withTailwindMarker(html('window.ReachInteractive.ready();'));
    expect(
      createGeneratedInteractiveSceneParser('page-6')({
        ...scene(documentHtml),
        runtimeDependencies: [tailwindDependency],
      }),
    ).toMatchObject({
      documentHtml,
      runtimeDependencies: [tailwindDependency],
    });
  });

  it.each([
    {
      name: 'missing dependency',
      documentHtml: withTailwindMarker(html('window.ReachInteractive.ready();')),
      runtimeDependencies: [],
    },
    {
      name: 'missing marker',
      documentHtml: html('window.ReachInteractive.ready();'),
      runtimeDependencies: [tailwindDependency],
    },
    {
      name: 'wrong marker version',
      documentHtml: withTailwindMarker(html('window.ReachInteractive.ready();'), '4.2.0'),
      runtimeDependencies: [tailwindDependency],
    },
    {
      name: 'wrong dependency version',
      documentHtml: withTailwindMarker(html('window.ReachInteractive.ready();')),
      runtimeDependencies: [{ id: 'tailwind-browser', version: '4.2.0' }],
    },
    {
      name: 'duplicate dependency',
      documentHtml: withTailwindMarker(html('window.ReachInteractive.ready();')),
      runtimeDependencies: [tailwindDependency, tailwindDependency],
    },
    {
      name: 'dependency with extra fields',
      documentHtml: withTailwindMarker(html('window.ReachInteractive.ready();')),
      runtimeDependencies: [{ ...tailwindDependency, source: 'model' }],
    },
    {
      name: 'duplicate root marker',
      documentHtml: withTailwindMarker(html('window.ReachInteractive.ready();')).replace(
        '<html ',
        `<html ${INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE}="4.3.0" `,
      ),
      runtimeDependencies: [tailwindDependency],
    },
  ])(
    'repairs $name through the first-candidate Tailwind projection',
    ({ documentHtml, runtimeDependencies }) => {
      const parse = createGeneratedInteractiveSceneParser('page-6');
      expect(() => parse({ ...scene(documentHtml), runtimeDependencies })).toThrow(/Tailwind/);

      const correctedHtml = withTailwindMarker(html('window.ReachInteractive.ready();'));
      expect(() =>
        parse({
          ...scene(correctedHtml),
          runtimeDependencies: [tailwindDependency],
        }),
      ).not.toThrow();
    },
  );

  it('rejects removing both Tailwind declarations during correction', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    const marked = withTailwindMarker(html('window.ReachInteractive.ready();'));
    expect(() => parse({ ...scene(marked), runtimeDependencies: [] })).toThrow(/Tailwind/);
    expect(() => parse(scene(html('window.ReachInteractive.ready();')))).toThrow(
      /must restore exactly one/,
    );
  });

  it('combines Tailwind and script diagnostics into one correction and permits only that script repair', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    const invalid = withTailwindMarker(html(REPORTED_PAGE_6_INVALID_ENDING));
    expect(() => parse({ ...scene(invalid), runtimeDependencies: [] })).toThrow(
      /Tailwind[\s\S]*Inline script 1 has invalid JavaScript/,
    );

    const corrected = withTailwindMarker(html('if (ready) { init(); } else { draw(); }'));
    expect(() =>
      parse({ ...scene(corrected), runtimeDependencies: [tailwindDependency] }),
    ).not.toThrow();
  });

  it('protects non-Tailwind dependencies, narration, content, classes, CSS, and valid scripts during Tailwind repair', () => {
    const originalHtml = withTailwindMarker(
      html(
        'window.ReachExpression.evaluate("x", { x: 1 });',
        '<button class="original">Original</button>',
      ),
    );
    const original = {
      ...scene(originalHtml),
      runtimeDependencies: [
        { id: 'expression', version: '3.0.3' },
        { id: 'tailwind-browser', version: '4.2.0' },
      ],
    };

    const corrections = [
      {
        ...scene(originalHtml),
        runtimeDependencies: [tailwindDependency],
      },
      {
        ...scene(originalHtml),
        runtimeDependencies: [{ id: 'expression', version: '3.0.3' }, tailwindDependency],
        narration: {
          schemaVersion: 'reach-interactive-narration/v1',
          text: 'Changed narration.',
        },
      },
      {
        ...scene(originalHtml.replace('class="original"', 'class="changed"')),
        runtimeDependencies: [{ id: 'expression', version: '3.0.3' }, tailwindDependency],
      },
      {
        ...scene(originalHtml.replace('Original</button>', 'Changed</button>')),
        runtimeDependencies: [{ id: 'expression', version: '3.0.3' }, tailwindDependency],
      },
      {
        ...scene(originalHtml.replace('body { margin: 0; }', 'body { margin: 1px; }')),
        runtimeDependencies: [{ id: 'expression', version: '3.0.3' }, tailwindDependency],
      },
      {
        ...scene(originalHtml.replace('"x", { x: 1 }', '"x + 1", { x: 1 }')),
        runtimeDependencies: [{ id: 'expression', version: '3.0.3' }, tailwindDependency],
      },
    ];

    const [runtimeCorrection, ...protectedCorrections] = corrections;
    const runtimeParse = createGeneratedInteractiveSceneParser('page-6');
    expect(() => runtimeParse(original)).toThrow(/Tailwind/);
    expect(() => runtimeParse(runtimeCorrection)).toThrow(
      /expression does not match document usage/,
    );

    for (const correction of protectedCorrections) {
      const parse = createGeneratedInteractiveSceneParser('page-6');
      expect(() => parse(original)).toThrow(/Tailwind/);
      expect(() => parse(correction)).toThrow(/changed protected fields/);
    }
  });

  it('preserves every initially valid script when another script needs syntax repair', () => {
    const initialHtml = withTailwindMarker(
      html(REPORTED_PAGE_6_INVALID_ENDING).replace(
        '</body>',
        '<script type="module">export const stable = 1;</script></body>',
      ),
    );
    const parse = createGeneratedInteractiveSceneParser('page-6');
    expect(() =>
      parse({ ...scene(initialHtml), runtimeDependencies: [tailwindDependency] }),
    ).toThrow(/invalid JavaScript/);
    const correctedHtml = initialHtml
      .replace(REPORTED_PAGE_6_INVALID_ENDING, 'if (ready) { init(); } else { draw(); }')
      .replace('export const stable = 1;', 'export const stable = 2;');
    expect(() =>
      parse({ ...scene(correctedHtml), runtimeDependencies: [tailwindDependency] }),
    ).toThrow(/valid inline scripts/);
  });

  it.each([
    '<style>@plugin "./unsafe.js";</style>',
    '<button class="bg-[url(https://example.com/x.png)]">Unsafe</button>',
    '<button onclick="tailwind.config = {}">Unsafe</button>',
    '<script>tailwind.config = {};</script>',
  ])('rejects unsupported Tailwind authoring patterns from generated HTML: %s', (unsafeHtml) => {
    const documentHtml = withTailwindMarker(html('window.ReachInteractive.ready();', unsafeHtml));
    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')({
        ...scene(documentHtml),
        runtimeDependencies: [tailwindDependency],
      }),
    ).toThrow(/Tailwind authoring does not support/);
  });

  it('rejects a correction that changes protected teaching or layout fields', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    expect(() => parse(scene(html(REPORTED_PAGE_6_INVALID_ENDING)))).toThrow();
    expect(() =>
      parse(scene(html('if (ready) { init(); } else { draw(); }'), 'Different activity')),
    ).toThrow(/changed protected fields: title/);
  });

  it('keeps non-Tailwind runtime failures outside the repair invariant', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    expect(() =>
      parse({
        ...scene(html('window.ReachExpression.evaluate("x", { x: 1 });')),
        runtimeDependencies: [],
      }),
    ).toThrow(/expression does not match document usage/);

    expect(() =>
      parse(scene(html('window.ReachInteractive.ready();'), 'Independent valid candidate')),
    ).not.toThrow();
  });

  it('keeps an invalid component marker outside the repair invariant', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    const candidate = scene(
      html(
        'window.ReachInteractive.ready();',
        '<section data-reach-component-id="same">A</section><section data-reach-component-id="same">B</section>',
      ),
    );
    expect(() => parse(candidate)).toThrow(/component marker metadata/);
    expect(() =>
      parse(scene(html('window.ReachInteractive.ready();'), 'Independent valid candidate')),
    ).not.toThrow();
  });

  it('freezes the rejected original after a hard science-kit marker failure', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    const candidate = scene(
      html(
        'window.ReachInteractive.ready();',
        '<div data-reach-science-kit-target="main"></div><script type="application/json" data-reach-science-kit="main">{invalid</script>',
      ),
    );
    expect(() => parse(candidate)).toThrow(/science kit main must contain valid JSON/);
    expect(() =>
      parse(scene(html('window.ReachInteractive.ready();'), 'Independent valid candidate')),
    ).toThrow(/changed protected fields/);
  });

  it('does not let correction replace protected content after an invalid function-plot marker shape', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    const invalidMarker = '<div data-reach-function-plot="main">not a marker</div>';
    expect(() =>
      parse({
        ...scene(html('window.ReachInteractive.ready();', invalidMarker)),
        runtimeDependencies: [],
      }),
    ).toThrow(/function plot marker has an invalid type or id/);

    expect(() =>
      parse(
        scene(
          html('window.ReachInteractive.ready();', '<main>Replacement activity</main>'),
          'Replacement activity',
        ),
      ),
    ).toThrow(/changed protected fields: title, non-script document structure/);
  });

  it('protects declarative function plot JSON during a JavaScript syntax correction', () => {
    const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(functionPlotSpec)}</script>`;
    const parse = createGeneratedInteractiveSceneParser('page-6');
    expect(() => parse(scene(html(REPORTED_PAGE_6_INVALID_ENDING, marker)))).toThrow();
    expect(() =>
      parse(scene(html('window.ReachInteractive.ready();', marker.replace('a*x^2', 'a*x^3')))),
    ).toThrow(/non-script document structure/);
  });

  it('allows one correction to repair an initially invalid declarative function plot', () => {
    const invalidMarker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(
      {
        ...functionPlotSpec,
        parameters: [{ id: 'a', label: '参数 a', min: 0.5, max: 2, step: 0.1, value: 1 }],
      },
    )}</script>`;
    const validMarker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(functionPlotSpec)}</script>`;
    const parse = createGeneratedInteractiveSceneParser('page-6');

    expect(() => parse(scene(html('window.ReachInteractive.ready();', invalidMarker)))).toThrow(
      /minimum, maximum, step, and initial/,
    );
    expect(() => parse(scene(html('window.ReachInteractive.ready();', validMarker)))).not.toThrow();
  });

  it('rejects a generated id that does not match the requested page identity', () => {
    const parse = createGeneratedInteractiveSceneParser('page-7');
    expect(() => parse(scene(html('window.ReachInteractive.ready();')))).toThrow(
      /invalid InteractiveScene/,
    );
  });

  it('requires exact runtime declarations that match actual document use', () => {
    const parse = createGeneratedInteractiveSceneParser('page-6');
    const withoutDependencies = scene(html('window.ReachInteractive.ready();')) as Record<
      string,
      unknown
    >;
    delete withoutDependencies.runtimeDependencies;
    expect(() => parse(withoutDependencies)).toThrow(/must declare runtimeDependencies/);

    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')({
        ...scene(html('window.ReachExpression.evaluate("x", { x: 1 });')),
        runtimeDependencies: [],
      }),
    ).toThrow(/expression does not match document usage/);
    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')({
        ...scene(html('window.ReachInteractive.ready();')),
        runtimeDependencies: [{ id: 'expression', version: '3.0.3' }],
      }),
    ).toThrow(/expression does not match document usage/);
    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')({
        ...scene(html('window.ReachInteractive.ready();')),
        runtimeDependencies: [{ id: 'geometry-mathigon', version: '1.0.0' }],
      }),
    ).toThrow(/science kit runtime dependencies do not match/);
  });

  it.each([
    '<div data-reach-function-plot="main">not a marker</div>',
    `<script data-reach-function-plot="main">${JSON.stringify(functionPlotSpec)}</script>`,
    `<script type="text/plain" data-reach-function-plot="main">${JSON.stringify(functionPlotSpec)}</script>`,
  ])('rejects non-Player function-plot marker shapes with and without a dependency', (marker) => {
    for (const runtimeDependencies of [
      [],
      [{ id: 'function-plot' as const, version: '1.25.4' as const }],
    ]) {
      expect(() =>
        createGeneratedInteractiveSceneParser('page-6')({
          ...scene(html('window.ReachInteractive.ready();', marker)),
          runtimeDependencies,
        }),
      ).toThrow();
    }
  });

  it('rejects duplicate or oversized teacher component markers', () => {
    const duplicate =
      '<section data-reach-component-id="chart">A</section><section data-reach-component-id="chart">B</section>';
    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')(
        scene(html('window.ReachInteractive.ready();', duplicate)),
      ),
    ).toThrow(/marker metadata is invalid or duplicated/);
    const oversizedLabel = `<section data-reach-component-id="chart" data-reach-component-label="${'x'.repeat(161)}">A</section>`;
    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')(
        scene(html('window.ReachInteractive.ready();', oversizedLabel)),
      ),
    ).toThrow(/marker metadata is invalid or duplicated/);
  });

  it('要求非空 Interactive 始终包含严格单段讲稿', () => {
    const narrated = {
      ...scene(html('window.ReachInteractive.ready();')),
      narration: {
        schemaVersion: 'reach-interactive-narration/v1',
        text: '拖动滑块改变参数，观察曲线如何变化。',
      },
    };
    expect(createGeneratedInteractiveSceneParser('page-6')(narrated)).toMatchObject({
      narration: narrated.narration,
    });
    const { narration: _narration, ...withoutNarration } = scene(
      html('window.ReachInteractive.ready();'),
    );
    expect(() => createGeneratedInteractiveSceneParser('page-6')(withoutNarration)).toThrow(
      /must include narration/,
    );
  });

  it('将模型的 nullable narration 归一为缺省，且仅 intentional-empty 允许缺省', () => {
    const nonemptyWithNull = {
      ...scene(html('window.ReachInteractive.ready();')),
      narration: null,
    };
    expect(() => createGeneratedInteractiveSceneParser('page-6')(nonemptyWithNull)).toThrow(
      /must include narration/,
    );

    const intentionalEmpty = {
      ...scene(CANONICAL_BLANK_INTERACTIVE_DOCUMENT),
      narration: null,
    };
    expect(createGeneratedInteractiveSceneParser('page-6')(intentionalEmpty)).not.toHaveProperty(
      'narration',
    );
    expect(() =>
      createGeneratedInteractiveSceneParser('page-6')({
        ...intentionalEmpty,
        narration: {
          schemaVersion: 'reach-interactive-narration/v1',
          text: 'Explore this page.',
        },
      }),
    ).toThrow(/intentional-empty.*must not provide narration/i);
  });
});
