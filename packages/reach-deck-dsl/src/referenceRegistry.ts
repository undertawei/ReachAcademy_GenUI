import type { ReferenceCoverageManifest } from './generationTypes.js';

export const REFERENCE_COVERAGE_SCHEMA_VERSION = 'v1' as const;
export const REFERENCE_MANIFEST_VERSION = 'reach-deck-reference-registry/v1' as const;

/** Describes intended use, not an assertion of renderer readiness. */
export const REFERENCE_CAPABILITIES = [
  'provenance',
  'layout-advisory',
  'component-advisory',
  'mask-advisory',
  'palette-advisory',
  'image-style-advisory',
  'table-capable',
] as const;
export type ReferenceCapability = (typeof REFERENCE_CAPABILITIES)[number];

export interface ReferenceRegistryEntry {
  id: string;
  consumers: string[];
  projection: { markdown: boolean; runtime: boolean; generation: boolean };
  capability: ReferenceCapability[];
  verificationCaseIds: string[];
  source?: {
    summary: string;
    version: string;
    pageRange?: string;
    extractionBoundary?: string;
  };
}

const record = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(text) &&
  new Set(value).size === value.length;
const capabilities = new Set<string>(REFERENCE_CAPABILITIES);

export function parseReferenceRegistryEntryValue(value: unknown): ReferenceRegistryEntry {
  if (
    !record(value) ||
    !keys(
      value,
      ['id', 'consumers', 'projection', 'capability', 'verificationCaseIds'],
      ['source'],
    ) ||
    !text(value.id) ||
    value.id.trim() !== value.id ||
    !strings(value.consumers) ||
    !strings(value.verificationCaseIds)
  )
    throw new Error('Invalid reference registry entry or verificationCaseIds.');
  if (!strings(value.capability) || !value.capability.every((item) => capabilities.has(item))) {
    throw new Error(`Unknown or invalid reference capability: ${value.id}.`);
  }
  const projection = value.projection;
  if (
    !record(projection) ||
    !keys(projection, ['markdown', 'runtime', 'generation']) ||
    !Object.values(projection).every((item) => typeof item === 'boolean')
  ) {
    throw new Error(`Invalid reference projection: ${value.id}.`);
  }
  let source: ReferenceRegistryEntry['source'];
  if (Object.hasOwn(value, 'source')) {
    const input = value.source;
    if (
      !record(input) ||
      !keys(input, ['summary', 'version'], ['pageRange', 'extractionBoundary']) ||
      !text(input.summary) ||
      !text(input.version) ||
      (Object.hasOwn(input, 'pageRange') && !text(input.pageRange)) ||
      (Object.hasOwn(input, 'extractionBoundary') && !text(input.extractionBoundary))
    ) {
      throw new Error(`Invalid reference source metadata: ${value.id}.`);
    }
    source = {
      summary: input.summary,
      version: input.version,
      ...(input.pageRange === undefined ? {} : { pageRange: input.pageRange as string }),
      ...(input.extractionBoundary === undefined
        ? {}
        : { extractionBoundary: input.extractionBoundary as string }),
    };
  }
  return {
    id: value.id,
    consumers: [...value.consumers],
    projection: {
      markdown: projection.markdown as boolean,
      runtime: projection.runtime as boolean,
      generation: projection.generation as boolean,
    },
    capability: [...value.capability] as ReferenceCapability[],
    verificationCaseIds: [...value.verificationCaseIds],
    ...(source === undefined ? {} : { source }),
  };
}

export function parseReferenceCoverageManifestValue(value: unknown): ReferenceCoverageManifest {
  if (
    !record(value) ||
    !keys(value, ['schemaVersion', 'references']) ||
    value.schemaVersion !== REFERENCE_COVERAGE_SCHEMA_VERSION ||
    !Array.isArray(value.references)
  ) {
    throw new Error('Invalid reference coverage manifest schemaVersion.');
  }
  const references = value.references.map(parseReferenceRegistryEntryValue);
  if (new Set(references.map((entry) => entry.id)).size !== references.length) {
    throw new Error('Duplicate reference id in coverage manifest.');
  }
  return { schemaVersion: REFERENCE_COVERAGE_SCHEMA_VERSION, references };
}

export function parseProductionReferenceCoverageManifestValue(
  value: unknown,
  manifestVersion: unknown,
): ReferenceCoverageManifest {
  if (manifestVersion !== REFERENCE_MANIFEST_VERSION) {
    throw new Error('Production generation requires a supported manifestVersion.');
  }
  const manifest = parseReferenceCoverageManifestValue(value);
  if (manifest.references.length === 0 || manifest.references.some((entry) => !entry.source)) {
    throw new Error('Production generation requires references with source metadata.');
  }
  return manifest;
}

/** Stable Markdown projection; no filesystem or source-media access. */
export function projectReferenceRegistryMarkdown(value: ReferenceCoverageManifest): string {
  const manifest = parseReferenceCoverageManifestValue(value);
  const cell = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\|/g, '&#124;')
      .replace(/\r?\n/g, ' ');
  const entries = manifest.references
    .filter((entry) => entry.projection.markdown)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [
    '# Reach Deck Reference Registry',
    '',
    '<!-- Generated from packages/reach-deck-dsl/src/reference-library/registry.json. Do not edit. -->',
    '',
    `Schema: ${manifest.schemaVersion}. Registered references: ${manifest.references.length}.`,
    '',
    'Capabilities describe intended use. Registration tests do not certify rendering, editing, or production readiness.',
    '',
    '| ID | Source summary | Consumers | Projection | Capability | Verification cases |',
    '| --- | --- | --- | --- | --- | --- |',
    ...entries.map(
      (entry) =>
        '| ' +
        [
          entry.id,
          entry.source?.summary ?? '',
          [...entry.consumers].sort().join(', '),
          Object.entries(entry.projection)
            .filter(([, enabled]) => enabled)
            .map(([key]) => key)
            .join(', '),
          [...entry.capability].sort().join(', '),
          [...entry.verificationCaseIds].sort().join(', '),
        ]
          .map(cell)
          .join(' | ') +
        ' |',
    ),
    '',
  ].join('\n');
}
