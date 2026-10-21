import data from './registry.json' with { type: 'json' };
import { parseReferenceCoverageManifestValue } from '../referenceRegistry.js';
import snapshot from './catalog.json' with { type: 'json' };
import type { SlideContentType, SlidePageRole } from '../slideSemantics.js';
import type { ReferenceCategory } from './membership.js';
export * from './membership.js';

/** Opt-in subpath keeps the full registry out of the default client entry. */
export const REFERENCE_REGISTRY = freeze(parseReferenceCoverageManifestValue(data));

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const REFERENCE_LIBRARY = freeze(snapshot.catalog);
export const REFERENCE_LIBRARY_PROVENANCE = freeze({
  sourceCatalogSha256: snapshot.sourceCatalogSha256,
  sourceGuidanceSha256: snapshot.sourceGuidanceSha256,
  snapshotSha256: snapshot.snapshotSha256,
  guidanceDifferences: snapshot.guidanceDifferences,
});
export type ReferenceEntry<C extends ReferenceCategory> = (typeof REFERENCE_LIBRARY)[C][number];
export function getReferenceEntry<C extends ReferenceCategory>(
  category: C,
  id: string,
): ReferenceEntry<C> {
  const entry = REFERENCE_LIBRARY[category].find((entry) => entry.id === id);
  if (!entry) throw new Error(`Unknown ${category} reference: ${id}`);
  return entry as ReferenceEntry<C>;
}
export function createReferenceCoverageManifest() {
  return parseReferenceCoverageManifestValue(data);
}
/** All IDs remain reachable; this index omits long source and generation evidence. */
export function createReferenceCompactIndex() {
  return (Object.keys(REFERENCE_LIBRARY) as Array<keyof typeof REFERENCE_LIBRARY>)
    .filter((category): category is ReferenceCategory => Array.isArray(REFERENCE_LIBRARY[category]))
    .flatMap((category) =>
      REFERENCE_LIBRARY[category].map((entry) => ({
        category,
        id: entry.id,
        name: 'name' in entry ? entry.name : entry.title,
        ...('contentTypes' in entry
          ? {
              contentTypes: entry.contentTypes,
              pageRoles: entry.pageRoles,
              summary: entry.readingPath,
            }
          : {}),
        ...('guidance' in entry
          ? { summary: entry.guidance.useWhen, aliases: entry.guidance.aliases }
          : {}),
        ...('compatibleZones' in entry ? { compatibleZones: entry.compatibleZones } : {}),
        ...('compatibleSlotRoles' in entry
          ? { compatibleSlotRoles: entry.compatibleSlotRoles }
          : {}),
        ...('colors' in entry ? { referenceColors: entry.colors } : {}),
      })),
    );
}

/** Compact advisory discovery only; selected entries retain their complete source guidance. */
export function createReferenceCompactIndexText(): string {
  return createReferenceCompactIndex()
    .map((entry) => {
      const relation =
        'contentTypes' in entry
          ? `${entry.contentTypes?.join(',')}; roles=${entry.pageRoles?.join(',')}`
          : '';
      const zones =
        'compatibleZones' in entry
          ? entry.compatibleZones?.join(',')
          : 'compatibleSlotRoles' in entry
            ? entry.compatibleSlotRoles?.join(',')
            : '';
      const colors =
        'referenceColors' in entry && entry.referenceColors
          ? Object.entries(entry.referenceColors)
              .map(([key, value]) => `${key}=${value}`)
              .join(',')
          : '';
      const summary = entry.summary?.replace(/\s+/g, ' ').slice(0, 96) ?? '';
      return [entry.category, entry.id, entry.name, relation, zones, colors, summary]
        .filter(Boolean)
        .join(' | ');
    })
    .join('\n');
}
export interface ReferenceLayoutQuery {
  primaryType: SlideContentType;
  pageRole: SlidePageRole;
  assetCount?: number;
  itemCount?: number;
  language?: string;
  aspectRatio?: number;
  previousReferenceIds?: readonly string[];
  explicitReferenceIds?: readonly string[];
  limit?: number;
}
/** Advisory composition only: never replaces authoritative teaching content or relationships. */
export function retrieveReferenceLayouts(input: ReferenceLayoutQuery) {
  if (
    (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) ||
    (input.aspectRatio !== undefined &&
      (!Number.isFinite(input.aspectRatio) || input.aspectRatio <= 0)) ||
    [input.assetCount, input.itemCount].some(
      (value) => value !== undefined && (!Number.isInteger(value) || value < 0),
    )
  ) {
    throw new Error('Invalid reference retrieval budget or content dimensions.');
  }
  const explicit = new Set(input.explicitReferenceIds ?? []);
  explicit.forEach((id) => getReferenceEntry('layouts', id));
  return REFERENCE_LIBRARY.layouts
    .map((reference) => {
      const crossType = !reference.contentTypes.includes(input.primaryType);
      const imageSlots = reference.slots.filter((slot) => slot.accepts.includes('image')).length;
      const textSlots = reference.slots.filter((slot) => slot.accepts.includes('text')).length;
      const mediaFrames = reference.slots
        .filter((slot) => slot.accepts.includes('image'))
        .map((slot) => slot.frame);
      const aspectPenalty =
        input.aspectRatio === undefined || mediaFrames.length === 0
          ? 0
          : Math.min(
              ...mediaFrames.map((frame) =>
                Math.abs(Math.log((frame.width * 16) / (frame.height * 9) / input.aspectRatio!)),
              ),
            ) * 4;
      // CJK text is wider per character; narrow body regions receive a soft penalty only.
      const languagePenalty = /^(zh|ja|ko)(-|$)/i.test(input.language ?? '')
        ? reference.slots.filter((slot) => slot.accepts.includes('text') && slot.frame.width < 0.2)
            .length
        : 0;
      const score =
        (explicit.has(reference.id) ? 1000 : 0) +
        (crossType ? 0 : 100) +
        (reference.pageRoles.includes(input.pageRole) ? 20 : 0) -
        Math.abs(imageSlots - (input.assetCount ?? 0)) * 3 -
        Math.abs(textSlots - (input.itemCount ?? textSlots)) -
        (input.previousReferenceIds?.includes(reference.id) ? 5 : 0) -
        aspectPenalty -
        languagePenalty;
      return {
        reference,
        score,
        crossType,
        advisory: true as const,
        informationRelationship: input.primaryType,
        instruction:
          'Borrow composition only. Preserve authoritative key points and teaching relationships; coordinates are advisory.',
      };
    })
    .sort((a, b) => b.score - a.score || (a.reference.id < b.reference.id ? -1 : 1))
    .slice(0, Math.max(explicit.size, input.limit ?? 3));
}
