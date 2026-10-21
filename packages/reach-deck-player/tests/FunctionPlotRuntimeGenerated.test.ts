// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
  REACH_FUNCTION_PLOT_RUNTIME_SHA256,
  REACH_FUNCTION_PLOT_RUNTIME_SOURCE,
} from '../src/reachFunctionPlotRuntime.generated';
import {
  REACH_SCIENTIFIC_DEPENDENCIES,
  resolveReachScientificDependency,
} from '../src/scientificDependencyRegistry.generated';

const testDirectory = dirname(fileURLToPath(import.meta.url));

describe('generated ReachFunctionPlot runtime', () => {
  it('matches the bytes and digest from a fresh bundle of the entry', async () => {
    const result = await build({
      entryPoints: [resolve(testDirectory, '../scripts/reach-function-plot-runtime.entry.ts')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      legalComments: 'none',
    });
    const source = result.outputFiles[0]?.text;
    expect(source).toBe(REACH_FUNCTION_PLOT_RUNTIME_SOURCE);
    expect(
      createHash('sha256')
        .update(source ?? '')
        .digest('hex'),
    ).toBe(REACH_FUNCTION_PLOT_RUNTIME_SHA256);
  });

  it('publishes identical content-addressed bytes with exact registry metadata', async () => {
    const entry = resolveReachScientificDependency(
      'function-plot',
      '1.25.4',
      'reach-scientific-visual-hooks/v1',
    );
    expect(entry).toBe(REACH_SCIENTIFIC_DEPENDENCIES[0]);
    expect(entry).toMatchObject({
      crossOrigin: 'anonymous',
      credentials: 'omit',
      facade: {
        globalName: 'ReachFunctionPlot',
        installerGlobalName: '__installReachFunctionPlot',
      },
      license: 'MIT',
      requirements: { workers: false, wasm: false, fonts: false, media: false },
      sha256: REACH_FUNCTION_PLOT_RUNTIME_SHA256,
    });
    expect(entry?.scriptPath).toBe(
      `/reach-deck-dependencies/function-plot/${REACH_FUNCTION_PLOT_RUNTIME_SHA256}.js`,
    );
    expect(entry?.weightBytes).toBe(Buffer.byteLength(REACH_FUNCTION_PLOT_RUNTIME_SOURCE));
    expect(entry?.integrity).toBe(
      `sha256-${createHash('sha256').update(REACH_FUNCTION_PLOT_RUNTIME_SOURCE).digest('base64')}`,
    );
    expect(
      resolveReachScientificDependency(
        'function-plot',
        '1.25.3',
        entry!.compatibleHookVersions[0]!,
      ),
    ).toBeUndefined();
    expect(
      resolveReachScientificDependency('unknown', '1.25.4', entry!.compatibleHookVersions[0]!),
    ).toBeUndefined();

    const relativePath = entry!.scriptPath.replace(/^\//, '');
    const repositoryDirectory = resolve(testDirectory, '../../..');
    const [studentBytes, teacherBytes] = await Promise.all(
      ['student', 'teacher'].map((application) =>
        readFile(resolve(repositoryDirectory, 'apps', application, 'public', relativePath)),
      ),
    );
    expect(studentBytes.equals(teacherBytes)).toBe(true);
    expect(studentBytes.toString('utf8')).toBe(REACH_FUNCTION_PLOT_RUNTIME_SOURCE);
    expect(createHash('sha256').update(studentBytes).digest('hex')).toBe(entry!.sha256);
  });

  it.each(['student', 'teacher'])(
    'serves %s dependency chunks with anonymous immutable headers',
    async (application) => {
      const repositoryDirectory = resolve(testDirectory, '../../..');
      const configUrl = pathToFileURL(
        resolve(repositoryDirectory, 'apps', application, 'next.config.mjs'),
      );
      const config = (await import(configUrl.href)).default as {
        headers(): Promise<
          Array<{ source: string; headers: Array<{ key: string; value: string }> }>
        >;
      };
      const entries = await config.headers();
      const dependencyHeaders = entries.find((entry) =>
        entry.source.includes('reach-deck-dependencies'),
      )!;
      expect(dependencyHeaders).toMatchObject({
        source: '/reach-deck-dependencies/:dependencyId/:digest.js',
      });
      expect(dependencyHeaders.headers).toEqual(
        expect.arrayContaining([
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ]),
      );
      expect(
        dependencyHeaders.headers.some(
          ({ key }) => key.toLowerCase() === 'access-control-allow-credentials',
        ),
      ).toBe(false);
    },
  );
});
