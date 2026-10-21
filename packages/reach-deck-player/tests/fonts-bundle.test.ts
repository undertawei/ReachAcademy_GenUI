import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REACH_DECK_BUILT_IN_FONT_FAMILIES } from '@reachany/reach-deck-dsl';

const fontsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const css = readFileSync(join(fontsDir, 'fonts.css'), 'utf8');
const sourceFontsDir = join(fontsDir, 'sources');

/**
 * The 15 families of the platform PPTX font catalog
 * (packages/importer/src/pptx/style/font-catalog.ts, reach-fonts/2026-08-04).
 * The generated webfont bundle must cover exactly this set — a mismatch means
 * imported decks reference families the player cannot render.
 */
const CATALOG_FAMILIES = REACH_DECK_BUILT_IN_FONT_FAMILIES;

describe('generated webfont bundle', () => {
  it('declares exactly the catalog families', () => {
    const declared = new Set(
      [...css.matchAll(/font-family:\s*"([^"]+)"/g)].map((match) => match[1]),
    );
    expect([...declared].sort()).toEqual([...CATALOG_FAMILIES].sort());
  });

  it('references only woff2 files that exist next to fonts.css', () => {
    const urls = [...css.matchAll(/url\("\.\/([^"]+)"\)/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThanOrEqual(CATALOG_FAMILIES.length);
    for (const url of urls) {
      expect(url).toMatch(/\.woff2$/);
      expect(statSync(join(fontsDir, url)).size).toBeGreaterThan(0);
    }
  });

  it('gives every face an explicit weight and swap display', () => {
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face).toMatch(/font-weight: (?:\d+|\d+ \d+);/);
      expect(face).toMatch(/font-display: swap;/);
    }
  });

  it('serves the variable Source Han Sans across the catalog weight range', () => {
    expect(css).toMatch(/font-family: "Source Han Sans VF";\s+[^}]*font-weight: 250 900;/);
  });
});

describe('source font bundle', () => {
  it('tracks exactly 15 TTF/OTF files with matching SHA-256 hashes', () => {
    const sourceFiles = readdirSync(sourceFontsDir)
      .filter((name) => /\.(?:ttf|otf)$/i.test(name))
      .sort();
    const checksums = readFileSync(join(sourceFontsDir, 'SHA256SUMS'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
        expect(match).not.toBeNull();
        return { hash: match![1], file: match![2] };
      });

    expect(sourceFiles).toHaveLength(15);
    expect(checksums.map(({ file }) => file).sort()).toEqual(sourceFiles);
    for (const { file, hash } of checksums) {
      const actual = createHash('sha256')
        .update(readFileSync(join(sourceFontsDir, file)))
        .digest('hex');
      expect(actual).toBe(hash);
    }
  });

  it('has provenance and a bundled license notice for every source font', () => {
    const manifest = JSON.parse(readFileSync(join(sourceFontsDir, 'manifest.json'), 'utf8')) as {
      files: Array<{ file: string; licenseFile: string; upstream: string }>;
    };

    expect(manifest.files).toHaveLength(15);
    for (const source of manifest.files) {
      expect(source.upstream).toMatch(/^https:\/\//);
      expect(statSync(join(sourceFontsDir, source.file)).size).toBeGreaterThan(0);
      expect(statSync(join(sourceFontsDir, source.licenseFile)).size).toBeGreaterThan(0);
    }
  });
});
