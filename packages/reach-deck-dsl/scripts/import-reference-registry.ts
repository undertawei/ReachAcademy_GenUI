import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import {
  parseProductionReferenceCoverageManifestValue,
  REFERENCE_MANIFEST_VERSION,
} from '../src/referenceRegistry.js';

// Offline, explicit import only. Applications consume the checked-in registry snapshot.
const catalogPath = process.argv[2];
if (!catalogPath) throw new Error('Usage: import-reference-registry.ts <catalog.json>');
const bytes = await readFile(catalogPath);
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== '53a35d8ba7af5ae686d1552889638db02385eb2e64d3b53d5f36f5c9b3ae5951') {
  throw new Error(
    'Unexpected reference catalog digest; review the source version before importing.',
  );
}
interface CatalogReference {
  id: string;
  version: number;
  name?: string;
  sourceId?: string;
  sourcePages?: number[];
  slots?: Array<{ accepts: string[] }>;
}
interface CatalogSource extends CatalogReference {
  title: string;
  digestSha256: string;
  rightsStatus: string;
  permittedExtraction: string[];
  forbiddenReuse: string[];
}
// The pinned digest identifies the reviewed input shape; output still passes the runtime parser.
const catalog = JSON.parse(bytes.toString('utf8')) as {
  sources: CatalogSource[];
  layouts: CatalogReference[];
  components: CatalogReference[];
  masks: CatalogReference[];
  palettes: CatalogReference[];
  imageStyles: CatalogReference[];
};
const groups = [
  ['sources', 'provenance', ['reference-audit']],
  ['layouts', 'layout-advisory', ['outline-planning', 'html-layout']],
  ['components', 'component-advisory', ['html-layout']],
  ['masks', 'mask-advisory', ['asset-planning', 'html-layout']],
  ['palettes', 'palette-advisory', ['deck-design', 'html-layout']],
  ['imageStyles', 'image-style-advisory', ['asset-planning', 'image-generation']],
] as const;
const sources = new Map(catalog.sources.map((source) => [source.id, source]));
const references = groups.flatMap(([group, capability, consumers]) =>
  catalog[group].map((item) => {
    const source = sources.get(group === 'sources' ? item.id : (item.sourceId ?? ''));
    if (!source) throw new Error(`Missing source for ${item.id}`);
    const table = group === 'layouts' && item.slots?.some((slot) => slot.accepts.includes('table'));
    return {
      id: item.id,
      consumers: [...consumers],
      projection: { markdown: true, runtime: false, generation: group !== 'sources' },
      capability: [capability, ...(table ? ['table-capable'] : [])],
      verificationCaseIds: [`registry-contract:${item.id}`],
      source: {
        summary: `${item.name ?? source.title}; source=${source.id}; sha256=${source.digestSha256.toLowerCase()}`,
        version: String(item.version),
        ...(item.sourcePages?.length ? { pageRange: item.sourcePages.join(',') } : {}),
        extractionBoundary: `rights=${source.rightsStatus}; permitted=${source.permittedExtraction.join(',')}; forbidden=${source.forbiddenReuse.join(',')}`,
      },
    };
  }),
);
const manifest = parseProductionReferenceCoverageManifestValue(
  { schemaVersion: 'v1', references },
  REFERENCE_MANIFEST_VERSION,
);
if (references.length !== 251) throw new Error('Expected 251 references.');
const directory = new URL('../src/reference-library/', import.meta.url);
await mkdir(directory, { recursive: true });

const guidancePath = process.argv[3];
if (!guidancePath) throw new Error('A pinned image guidance JSON path is required.');
const guidanceBytes = await readFile(guidancePath);
const guidanceDigest = createHash('sha256').update(guidanceBytes).digest('hex');
if (guidanceDigest !== 'd2de452fcb6fbd41a19a7b9c8f03585ebe4d1bac925b466bea95deaca3a215ec') {
  throw new Error('Unexpected image guidance digest.');
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const sanitize = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'location')
        .map(([key, child]) => [key, sanitize(child)]),
    );
  }
  if (typeof value === 'string' && /(?:[A-Za-z]:[\\/]|file:\/\/)/.test(value)) {
    throw new Error('Unreviewed local path in reference input.');
  }
  return value;
};
const snapshot = sanitize(JSON.parse(bytes.toString('utf8'))) as Record<string, Json>;
const guidance = JSON.parse(guidanceBytes.toString('utf8')) as {
  imageStyles: Array<Record<string, Json> & { id: string; avoid: string[] }>;
};
const guidanceById = new Map(guidance.imageStyles.map((item) => [item.id, item]));
if (guidanceById.size !== 33 || guidance.imageStyles.length !== 33)
  throw new Error('Duplicate/missing guidance IDs.');
const differences: Array<{ id: string; fields: string[] }> = [];
snapshot.imageStyles = (
  snapshot.imageStyles as Array<Record<string, Json> & { id: string; avoid: string[] }>
).map((item) => {
  const detail = guidanceById.get(item.id);
  if (!detail) throw new Error(`Missing guidance: ${item.id}`);
  guidanceById.delete(item.id);
  const changed = ['medium', 'treatment', 'promptFragment', 'avoid'].filter(
    (key) => detail[key] !== undefined && JSON.stringify(item[key]) !== JSON.stringify(detail[key]),
  );
  if (changed.length) differences.push({ id: item.id, fields: changed });
  return {
    ...item,
    catalogAvoid: [...item.avoid],
    guidance: sanitize(detail),
    avoid: [...new Set([...item.avoid, ...detail.avoid])],
  };
});
if (guidanceById.size) throw new Error('Unknown image guidance IDs.');
const snapshotSha256 = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const output = {
  libraryVersion: 'reach-deck-reference-library/v1',
  sourceCatalogSha256: digest,
  sourceGuidanceSha256: guidanceDigest,
  snapshotSha256,
  guidanceDifferences: differences,
  catalog: snapshot,
};
async function writeSnapshot(name: string, value: unknown) {
  const destination = new URL(name, directory);
  await writeFile(
    destination,
    await format(JSON.stringify(value), {
      ...(await resolveConfig(destination)),
      parser: 'json',
    }),
  );
}
await writeSnapshot('registry.json', manifest);
await writeSnapshot('catalog.json', output);
const membership = Object.fromEntries(
  groups.map(([group]) => [group, catalog[group].map((item) => item.id)]),
);
await writeSnapshot('membership.json', {
  libraryVersion: output.libraryVersion,
  librarySha256: snapshotSha256,
  categories: membership,
});
