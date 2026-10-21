import { readFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_MANIFEST_VERSION,
  finalizeGeneratedPagedDeckOutline,
  parseGeneratedPagedDeckOutlineValue,
  parsePagedDeckOutlineValue,
  parseProductionGeneratedPagedDeckOutlineValue,
  parseProductionReferenceCoverageManifestValue,
  parseReferenceCoverageManifestValue,
  projectReferenceRegistryMarkdown,
  type ReferenceCoverageManifest,
} from '../src/index.js';
import { REFERENCE_REGISTRY } from '../src/reference-library/index.js';

const draft = { title: 'Reference deck', pages: [{ sceneType: 'slide', title: 'Evidence' }] };
const manifest = (): ReferenceCoverageManifest => structuredClone(REFERENCE_REGISTRY);

describe('reference registry contract', () => {
  it('round-trips all 251 references and retains each category and table-capable layout', () => {
    const parsed = parseReferenceCoverageManifestValue(
      JSON.parse(JSON.stringify(REFERENCE_REGISTRY)),
    );
    expect(parsed).toEqual(REFERENCE_REGISTRY);
    expect(parsed.references).toHaveLength(251);
    expect(
      Object.fromEntries(
        [
          'provenance',
          'layout-advisory',
          'component-advisory',
          'mask-advisory',
          'palette-advisory',
          'image-style-advisory',
          'table-capable',
        ].map((capability) => [
          capability,
          parsed.references.filter((entry) => entry.capability.some((item) => item === capability))
            .length,
        ]),
      ),
    ).toEqual({
      provenance: 24,
      'layout-advisory': 76,
      'component-advisory': 52,
      'mask-advisory': 7,
      'palette-advisory': 59,
      'image-style-advisory': 33,
      'table-capable': 9,
    });
    expect(parsed.references.some((entry) => entry.id === 'source-percentage-rate-1ppt-v1')).toBe(
      true,
    );
    parsed.references[0]!.consumers.push('mutation');
    expect(REFERENCE_REGISTRY.references[0]!.consumers).not.toContain('mutation');
  });

  // IDs are derived independently from reference IDs, so a dangling verificationCaseId fails.
  const cases = REFERENCE_REGISTRY.references.map((input) => ({
    caseId: `registry-contract:${input.id}`,
    referenceId: input.id,
    input,
  }));
  it('resolves every verificationCaseId to an executable case with its reference input', () => {
    const byId = new Map(cases.map((entry) => [entry.caseId, entry]));
    for (const reference of REFERENCE_REGISTRY.references) {
      for (const id of reference.verificationCaseIds) {
        expect(byId.get(id)?.referenceId).toBe(reference.id);
      }
    }
  });
  it.each(cases)('$caseId', ({ input }) => {
    const parsed = parseProductionReferenceCoverageManifestValue(
      { schemaVersion: 'v1', references: [input] },
      REFERENCE_MANIFEST_VERSION,
    );
    expect(parsed.references[0]).toEqual(input);
    expect(input.source?.summary).toMatch(/sha256=[a-f0-9]{64}$/);
    expect(input.source?.extractionBoundary).toContain('forbidden=');
    expect(input.projection.runtime).toBe(false);
    expect(input.projection.generation).toBe(!input.capability.includes('provenance'));
    expect(JSON.stringify(input)).not.toMatch(/[A-Za-z]:[\\/]|file:\/\//);
  });

  it('projects deterministic Markdown from the registry and matches the checked-in artifact', async () => {
    const reversed = manifest();
    reversed.references.reverse();
    for (const entry of reversed.references) {
      entry.capability.reverse();
      entry.consumers.reverse();
      entry.verificationCaseIds.reverse();
    }
    const markdown = projectReferenceRegistryMarkdown(REFERENCE_REGISTRY);
    expect(projectReferenceRegistryMarkdown(reversed)).toBe(markdown);
    const destination = new URL(
      '../../../docs/plans/2026-09-20-reach-deck-reference-library-coverage.md',
      import.meta.url,
    );
    const config = await resolveConfig(destination);
    expect((await readFile(destination, 'utf8')).replace(/\r\n/g, '\n')).toBe(
      (await format(markdown, { ...config, parser: 'markdown' })).replace(/\r\n/g, '\n'),
    );
  });

  it('rejects duplicate reference IDs, unsupported capabilities, and missing verification cases', () => {
    const duplicate = manifest();
    duplicate.references.push(duplicate.references[0]!);
    expect(() => parseReferenceCoverageManifestValue(duplicate)).toThrow(/duplicate reference id/i);
    for (const patch of [
      { capability: ['unregistered-capability'] },
      { verificationCaseIds: [] },
      { projection: { markdown: true, runtime: false, generation: 'true' } },
      { source: { summary: 'test', version: '1', location: 'C:/private/source.pdf' } },
    ]) {
      expect(() =>
        parseReferenceCoverageManifestValue({
          schemaVersion: 'v1',
          references: [{ ...REFERENCE_REGISTRY.references[0], ...patch }],
        }),
      ).toThrow();
    }
    expect(() =>
      parseReferenceCoverageManifestValue({ schemaVersion: 'v2', references: [] }),
    ).toThrow();
  });

  it('rejects production metadata gaps while allowing historical manifests without source', () => {
    const legacy = manifest();
    delete legacy.references[0]!.source;
    expect(parseReferenceCoverageManifestValue(legacy)).toEqual(legacy);
    expect(() =>
      parseProductionReferenceCoverageManifestValue(legacy, REFERENCE_MANIFEST_VERSION),
    ).toThrow(/source metadata/i);
    for (const version of [undefined, '', 'future-version']) {
      expect(() =>
        parseProductionReferenceCoverageManifestValue(REFERENCE_REGISTRY, version),
      ).toThrow(/manifestVersion/);
    }
    expect(() =>
      parseProductionReferenceCoverageManifestValue(
        { schemaVersion: 'v1', references: [] },
        REFERENCE_MANIFEST_VERSION,
      ),
    ).toThrow(/source metadata/i);
  });

  it('reads old and new draft shapes, including empty page lists, without adding metadata', () => {
    expect(parseGeneratedPagedDeckOutlineValue({ title: 'Old', pages: [] })).toEqual({
      title: 'Old',
      pages: [],
    });
    const input = {
      title: 'New',
      pages: [],
      referenceCoverage: { schemaVersion: 'v1', references: [] },
    };
    expect(parseGeneratedPagedDeckOutlineValue(input)).toEqual(input);
    expect(parseGeneratedPagedDeckOutlineValue(draft)).toEqual(draft);
    expect(() => parseProductionGeneratedPagedDeckOutlineValue(draft)).toThrow(/manifestVersion/);
  });

  it('preserves coverage and version through producer validation, finalization, and persisted parsing', () => {
    const input = {
      ...draft,
      referenceCoverage: REFERENCE_REGISTRY,
      manifestVersion: REFERENCE_MANIFEST_VERSION,
    };
    const parsed = parseProductionGeneratedPagedDeckOutlineValue(input);
    let id = 0;
    const finalized = finalizeGeneratedPagedDeckOutline(parsed, (prefix) => `${prefix}-${++id}`);
    expect(finalized.referenceCoverage).toEqual(REFERENCE_REGISTRY);
    expect(finalized.manifestVersion).toBe(REFERENCE_MANIFEST_VERSION);
    expect(parsePagedDeckOutlineValue(JSON.parse(JSON.stringify(finalized)))).toEqual(finalized);
    expect(() => parseProductionGeneratedPagedDeckOutlineValue({ ...input, pages: [] })).toThrow(
      /requires pages/,
    );
    expect(() =>
      parseGeneratedPagedDeckOutlineValue({
        ...draft,
        manifestVersion: REFERENCE_MANIFEST_VERSION,
      }),
    ).toThrow();
    expect(() =>
      parseGeneratedPagedDeckOutlineValue({ ...draft, referenceCoverage: null }),
    ).toThrow();
  });
});
