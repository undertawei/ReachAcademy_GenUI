import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const service = fileURLToPath(new URL('../../', import.meta.url));
const server = path.join(service, '.next/standalone/services/ai-runtime/.next/server');
const require = createRequire(path.join(server, 'webpack-runtime.js'));
process.chdir(path.dirname(path.dirname(server)));

// Exercise the actual Next bundle, including Webpack's asset-resolution transforms.
await require('./app/api/reach-deck/imports/maic/preflight/route.js');
const runtime = require('./webpack-runtime.js');
const moduleId = Object.keys(runtime.m).find((id) =>
  runtime.m[id].toString().includes('maic.table.font_metrics_unavailable'),
);
assert(moduleId, 'MAIC preflight module must exist in the production bundle');
const exports = await runtime(moduleId);
const preflight = Object.values(exports).find(
  (value) =>
    typeof value === 'function' && value.toString().includes('maic.table.font_metrics_unavailable'),
);
assert(preflight, 'MAIC preflight must be exported by the production bundle');

const bytes = process.argv[2]
  ? await readFile(path.resolve(service, process.argv[2]))
  : Buffer.from(
      JSON.stringify({
        title: 'Bundled table font verification',
        width: 1000,
        height: 562.5,
        slides: [
          {
            id: 'slide',
            component_type: 'canvas',
            elements: [
              {
                id: 'table',
                type: 'table',
                left: 20,
                top: 30,
                width: 400,
                height: 120,
                colWidths: [0.5, 0.5],
                cellMinHeight: 30,
                data: [
                  [
                    { text: 'Table text', style: { fontsize: '20px' } },
                    { text: 'Wrapped table text '.repeat(20), style: { fontsize: '20px' } },
                  ],
                ],
              },
            ],
          },
        ],
      }),
    );
const result = await preflight(bytes, {
  applicationId: 'production-font-check',
  documentId: 'production-font-check',
  title: 'Bundled table font verification',
  language: 'zh-CN',
  generatedAt: '2026-09-21T00:00:00Z',
});
assert(result.ok, JSON.stringify(result.diagnostics));
if (!process.argv[2]) assert(result.canApply, JSON.stringify(result.diagnostics));
assert(result.mapping, 'Production preflight must produce a mapped document');
assert(
  result.mapping.document.nativeSlides.some((entry) =>
    entry.slide.elements.some((element) => element.type === 'table'),
  ),
  'Production preflight must lay out at least one table',
);
console.log(
  JSON.stringify({
    ok: result.ok,
    canApply: result.canApply,
    summary: result.summary,
    diagnosticCodes: [...new Set(result.diagnostics.map((entry) => entry.code))],
  }),
);
