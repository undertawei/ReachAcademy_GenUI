// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ANIMATE_CSS_RUNTIME_SHA256,
  ANIMATE_CSS_RUNTIME_SOURCE,
  ANIMATE_CSS_RUNTIME_SOURCE_BYTES,
  EXPRESSION_RUNTIME_SHA256,
  EXPRESSION_RUNTIME_SOURCE,
  EXPRESSION_RUNTIME_SOURCE_BYTES,
  FUNCTION_PLOT_RUNTIME_SHA256,
  FUNCTION_PLOT_RUNTIME_SOURCE,
  FUNCTION_PLOT_RUNTIME_SOURCE_BYTES,
} from '../src/interactiveRuntimes.generated';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from '../src/interactiveExternalRuntimes.generated';
import { resolveInteractiveRuntimes } from '../src/interactiveRuntimeRegistry';

const testDirectory = dirname(fileURLToPath(import.meta.url));

describe('generated Interactive runtime registry', () => {
  it('exposes only deterministic bounded expression evaluation', () => {
    const runtimeWindow: Record<string, unknown> = {};
    const install = new Function(
      'window',
      `${EXPRESSION_RUNTIME_SOURCE}\nreturn window.ReachExpression;`,
    ) as (window: Record<string, unknown>) => {
      evaluate(source: string, variables?: Readonly<Record<string, number>>): number;
    };
    const expression = install(runtimeWindow);

    expect(expression.evaluate('x^2 + 1', { x: 3 })).toBe(10);
    expect(() => expression.evaluate('random()')).toThrow(/undeclared variable/);
    expect(() => expression.evaluate('x.y', { x: 1 })).toThrow(/member access/);
    expect(() => expression.evaluate('x = 1', { x: 0 })).toThrow();
  });

  it('matches the committed manifest hashes, sizes, and supported combinations', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(testDirectory, '../interactive-runtimes.manifest.json'), 'utf8'),
    ) as {
      maximumAssembledSrcdocBytes: number;
      entries: Array<{ id: string; sha256: string; sourceBytes: number }>;
      supportedCombinations: Array<{ runtimeIds: string[]; sourceBytes: number }>;
    };
    const generated = [
      [
        'animate-css',
        ANIMATE_CSS_RUNTIME_SOURCE,
        ANIMATE_CSS_RUNTIME_SOURCE_BYTES,
        ANIMATE_CSS_RUNTIME_SHA256,
      ],
      [
        'expression',
        EXPRESSION_RUNTIME_SOURCE,
        EXPRESSION_RUNTIME_SOURCE_BYTES,
        EXPRESSION_RUNTIME_SHA256,
      ],
      [
        'function-plot',
        FUNCTION_PLOT_RUNTIME_SOURCE,
        FUNCTION_PLOT_RUNTIME_SOURCE_BYTES,
        FUNCTION_PLOT_RUNTIME_SHA256,
      ],
    ] as const;
    for (const [id, source, sourceBytes, digest] of generated) {
      expect(Buffer.byteLength(source, 'utf8')).toBe(sourceBytes);
      expect(createHash('sha256').update(source).digest('hex')).toBe(digest);
      expect(manifest.entries.find((entry) => entry.id === id)).toMatchObject({
        id,
        sha256: digest,
        sourceBytes,
      });
    }
    expect(manifest.supportedCombinations).toHaveLength(7);
    expect(manifest.supportedCombinations.at(-1)).toEqual({
      runtimeIds: ['animate-css', 'expression', 'function-plot'],
      sourceBytes:
        ANIMATE_CSS_RUNTIME_SOURCE_BYTES +
        EXPRESSION_RUNTIME_SOURCE_BYTES +
        FUNCTION_PLOT_RUNTIME_SOURCE_BYTES,
    });
    expect(manifest.supportedCombinations.at(-1)!.sourceBytes).toBeLessThan(
      manifest.maximumAssembledSrcdocBytes,
    );
  });

  it('preserves legacy marker compatibility but enforces explicit function-plot use for new scenes', () => {
    expect(resolveInteractiveRuntimes({ hasFunctionPlotMarkers: true })).toMatchObject([
      { id: 'function-plot', version: '1.25.4' },
    ]);
    expect(() =>
      resolveInteractiveRuntimes({ hasFunctionPlotMarkers: true, runtimeDependencies: [] }),
    ).toThrow(/require the pinned function-plot/);
    expect(() =>
      resolveInteractiveRuntimes({
        hasFunctionPlotMarkers: false,
        runtimeDependencies: [{ id: 'function-plot', version: '1.25.4' }],
      }),
    ).toThrow(/requires a declarative/);
  });

  it('keeps the Tailwind browser runtime external, content-addressed, and separate from science kits', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(testDirectory, '../interactive-runtimes.manifest.json'), 'utf8'),
    ) as {
      maximumExternalDependencyBytes: number;
      documentRuntimeEntries: Array<{
        id: string;
        version: string;
        category: string;
        scriptPath: string;
        sourceBytes: number;
        sha256: string;
        integrity: string;
      }>;
      scienceKitEntries: Array<{ id: string; category: string }>;
    };
    const entry = INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.find(
      ({ id }) => id === 'tailwind-browser',
    );
    const manifestEntry = manifest.documentRuntimeEntries.find(
      ({ id }) => id === 'tailwind-browser',
    );
    if (entry === undefined || manifestEntry === undefined) {
      throw new Error('Pinned Tailwind browser runtime is missing.');
    }
    expect(entry).toMatchObject({
      version: '4.3.0',
      category: 'document',
      sourceBytes: 273105,
    });
    expect(manifestEntry).toEqual(
      expect.objectContaining({
        version: '4.3.0',
        category: 'document',
        scriptPath: entry.scriptPath,
        sourceBytes: entry.sourceBytes,
        sha256: entry.sha256,
        integrity: entry.integrity,
      }),
    );
    expect(manifest.scienceKitEntries.every(({ category }) => category === 'science-kit')).toBe(
      true,
    );
    expect(entry.sourceBytes).toBeLessThan(manifest.maximumExternalDependencyBytes);

    for (const application of ['student', 'teacher']) {
      const source = await readFile(
        resolve(testDirectory, `../../../apps/${application}/public/${entry.scriptPath.slice(1)}`),
      );
      expect(source).toHaveLength(entry.sourceBytes);
      expect(createHash('sha256').update(source).digest('hex')).toBe(entry.sha256);
    }
  });
});
