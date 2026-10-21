import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from '@reachany/reach-deck-player';

import { createReachDeckPlayerHarnessFixture } from '../../scripts/reach-deck/player-harness-fixtures.js';
import {
  FUNCTION_PLOT_SCRIPT_PATH,
  KATEX_FONTS_URL_PREFIX,
  MATHLIVE_FONTS_URL_PREFIX,
  PLAYER_FONTS_URL_PREFIX,
  REPOSITORY_ROOT,
  loadPlayerHarnessResourceMap,
  loadStrictReachDeckDocument,
  prepareReachDeckPlayerHarness,
  resolveTemporaryOutputDirectory,
  startReachDeckPlayerHarnessServer,
} from '../../scripts/reach-deck/player-harness.js';

const temporaryDirectories: string[] = [];

const fetchPreparedArtifact = async (url: string): Promise<Response> => {
  const response = await fetch(url);
  await response.arrayBuffer();
  return response;
};

const temporaryDirectory = async (): Promise<string> => {
  await mkdir(path.join(REPOSITORY_ROOT, 'tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(REPOSITORY_ROOT, 'tmp/player-harness-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Reach Deck Player harness boundaries', () => {
  it('keeps outputs below tmp/.tmp and document inputs inside the repository', async () => {
    expect(resolveTemporaryOutputDirectory('tmp/player-harness-safe')).toBe(
      path.join(REPOSITORY_ROOT, 'tmp/player-harness-safe'),
    );
    expect(() => resolveTemporaryOutputDirectory('tmp')).toThrow(/child/);
    expect(() => resolveTemporaryOutputDirectory('../outside')).toThrow(/child/);

    const directory = await temporaryDirectory();
    const invalid = path.join(directory, 'invalid.json');
    await writeFile(invalid, '{"schemaVersion":"not-a-deck"}\n', 'utf8');
    await expect(
      loadStrictReachDeckDocument(path.relative(REPOSITORY_ROOT, invalid)),
    ).rejects.toThrow(/reach-deck-document\/v2/);
  });

  it('requires an exact declared resource map and verifies byte identity before serving', async () => {
    const fixture = createReachDeckPlayerHarnessFixture('scientific');
    const directory = await temporaryDirectory();
    const mapFile = path.join(directory, 'resource-map.json');
    await writeFile(mapFile, '{}\n', 'utf8');
    await expect(
      loadPlayerHarnessResourceMap(fixture.document, path.relative(REPOSITORY_ROOT, mapFile)),
    ).rejects.toThrow(/missing declared resource/);

    const corrupted = new Map(fixture.assetsByResourceId);
    const [resourceId, asset] = [...corrupted][0]!;
    corrupted.set(resourceId, { ...asset, checksumSha256: '0'.repeat(64) });
    await expect(
      prepareReachDeckPlayerHarness({
        assetsByResourceId: corrupted,
        document: fixture.document,
        outputDirectory: path.join(directory, 'output'),
        source: 'fixture',
        timingSource: 'document',
      }),
    ).rejects.toThrow(/checksumSha256/);
  });

  it('inlines KaTeX layout rules so static formulas do not expose raw TeX beside MathML', async () => {
    const fixture = createReachDeckPlayerHarnessFixture('scientific');
    const directory = await temporaryDirectory();
    const prepared = await prepareReachDeckPlayerHarness({
      assetsByResourceId: fixture.assetsByResourceId,
      document: fixture.document,
      outputDirectory: path.join(directory, 'output'),
      source: 'fixture',
      timingSource: 'document',
    });

    const css = await readFile(path.join(prepared.outputDirectory, 'player.css'), 'utf8');
    expect(css).toContain('.katex .katex-mathml');
    expect(css).toContain('clip:rect(1px,1px,1px,1px)');
    expect(css).toContain(`url(${KATEX_FONTS_URL_PREFIX}KaTeX_Main-Regular.woff2)`);
    expect(css).toContain(`url(${MATHLIVE_FONTS_URL_PREFIX}KaTeX_Main-Regular.woff2)`);
    expect(css).not.toContain('url(fonts/');
    expect(css).not.toContain("@import 'katex/dist/katex.min.css'");
  });

  it('serves only prepared artifacts, approved dependencies, and bounded font paths', async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, 'player.html'), '<!doctype html><p>ready</p>', 'utf8');
    const local = await startReachDeckPlayerHarnessServer(directory);
    try {
      expect((await fetchPreparedArtifact(local.origin)).status).toBe(200);
      expect(
        (await fetchPreparedArtifact(`${local.origin}/assets/%2e%2e%2fplayer.html`)).status,
      ).toBe(404);
      expect(
        (
          await fetchPreparedArtifact(
            `${local.origin}/reach-deck-dependencies/function-plot/not-approved.js`,
          )
        ).status,
      ).toBe(404);
      const dependency = await fetchPreparedArtifact(`${local.origin}${FUNCTION_PLOT_SCRIPT_PATH}`);
      expect(dependency.status).toBe(200);
      expect(dependency.headers.get('access-control-allow-origin')).toBe('*');
      expect(dependency.headers.get('cache-control')).toContain('immutable');
      for (const runtime of INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES) {
        const response = await fetchPreparedArtifact(`${local.origin}${runtime.scriptPath}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('cache-control')).toContain('immutable');
      }
      for (const fontPath of [
        `${PLAYER_FONTS_URL_PREFIX}carlito.woff2`,
        `${KATEX_FONTS_URL_PREFIX}KaTeX_Main-Regular.woff2`,
        `${MATHLIVE_FONTS_URL_PREFIX}KaTeX_Main-Regular.woff2`,
      ]) {
        const response = await fetchPreparedArtifact(`${local.origin}${fontPath}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('font/woff2');
      }
    } finally {
      await local.close();
    }
  });

  it('serves finite media lengths, HEAD and bounded byte ranges for audio seeking', async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, 'player.html'), '<!doctype html><p>ready</p>');
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'assets/narration.mp3'), Buffer.from('0123456789'));
    const local = await startReachDeckPlayerHarnessServer(directory);
    const url = `${local.origin}/assets/narration.mp3`;
    try {
      const full = await fetch(url);
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('audio/mpeg');
      expect(full.headers.get('content-length')).toBe('10');
      expect(full.headers.get('accept-ranges')).toBe('bytes');
      expect(await full.text()).toBe('0123456789');
      const head = await fetch(url, { method: 'HEAD' });
      expect(head.headers.get('content-length')).toBe('10');
      expect(await head.text()).toBe('');
      for (const [range, expected, contentRange] of [
        ['bytes=2-4', '234', 'bytes 2-4/10'],
        ['bytes=7-', '789', 'bytes 7-9/10'],
        ['bytes=-3', '789', 'bytes 7-9/10'],
        ['bytes=8-999', '89', 'bytes 8-9/10'],
      ]) {
        const part = await fetch(url, { headers: { Range: range! } });
        expect(part.status).toBe(206);
        expect(part.headers.get('content-range')).toBe(contentRange);
        expect(part.headers.get('content-length')).toBe(String(expected!.length));
        expect(await part.text()).toBe(expected);
      }
      for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5']) {
        const invalid = await fetch(url, { headers: { Range: range } });
        expect(invalid.status).toBe(416);
        expect(invalid.headers.get('content-range')).toBe('bytes */10');
        expect(await invalid.text()).toBe('');
      }
    } finally {
      await local.close();
    }
  });
});
