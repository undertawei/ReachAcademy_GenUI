import type { ReachDeckNativeElementV2 } from '@reachany/reach-deck-dsl';

const DOCUMENT_BOUND_KEYS = new Set([
  'resourceid',
  'posterresourceid',
  'source',
  'documentid',
  'pageid',
  'themeid',
  'masterid',
  'layoutid',
]);

/**
 * A cross-Deck fragment may only carry values that can be interpreted without
 * source document resources, theme resolution, or importer provenance.
 */
export function isReachDeckElementsClipboardSelfContained(
  elements: readonly ReachDeckNativeElementV2[],
): boolean {
  return elements.length > 0 && elements.every((element) => isSelfContainedValue(element));
}

function isSelfContainedValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSelfContainedValue);
  if (typeof value !== 'object' || value === null) return true;
  const record = value as Record<string, unknown>;
  if (record.kind === 'theme') return false;
  if (
    record.type === 'image' ||
    record.type === 'audio' ||
    record.type === 'video' ||
    record.type === 'scientificVisual'
  ) {
    return false;
  }
  return Object.entries(record).every(
    ([key, child]) => !DOCUMENT_BOUND_KEYS.has(key.toLowerCase()) && isSelfContainedValue(child),
  );
}
