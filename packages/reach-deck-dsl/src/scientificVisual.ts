import type { ReachDeckNativeSlideV2 } from './nativeV2.js';

export const REACH_SCIENTIFIC_VISUAL_MANIFEST_VERSION =
  'reach-scientific-visual-manifest/v2' as const;
export const REACH_SCIENTIFIC_VISUAL_HOOKS_VERSION = 'reach-scientific-visual-hooks/v1' as const;

export const REACH_SCIENTIFIC_VISUAL_LIMITS = Object.freeze({
  documentHtmlBytes: 256 * 1024,
  anchors: 16,
  dependencies: 8,
  resources: 16,
  identifierLength: 64,
  descriptionLength: 240,
  ariaLabelLength: 240,
  textAlternativeLength: 2_000,
});

export interface ReachScientificVisualAnchorV1 {
  id: string;
  description: string;
}

export interface ReachScientificVisualDependencyV1 {
  id: string;
  version: string;
}

export interface ReachScientificVisualManifestV1 {
  schemaVersion: typeof REACH_SCIENTIFIC_VISUAL_MANIFEST_VERSION;
  hooksVersion: typeof REACH_SCIENTIFIC_VISUAL_HOOKS_VERSION;
  anchors: ReachScientificVisualAnchorV1[];
  dependencies: ReachScientificVisualDependencyV1[];
  resourceIds: string[];
  ariaLabel: string;
  textAlternative: string;
}

/** Durable scientific resource payload; Native V2 moves these entries into document.resources.media. */
export interface ReachScientificVisualMediaResourceV1 {
  id: string;
  objectKey: string;
  contentType: string;
  digest: string;
}

export interface ReachScientificVisualPayloadV1 {
  documentHtml: string;
  manifest: ReachScientificVisualManifestV1;
  mediaResources: ReachScientificVisualMediaResourceV1[];
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseReachScientificVisualPayloadV1(
  value: unknown,
  label = 'scientific visual',
): ReachScientificVisualPayloadV1 {
  const payload = record(value, label);
  exactKeys(payload, ['documentHtml', 'manifest', 'mediaResources'], label);
  const documentHtml = parseReachScientificVisualDocumentHtmlV1(
    payload.documentHtml,
    `${label}.documentHtml`,
  );
  const manifest = parseManifest(payload.manifest, `${label}.manifest`);
  const mediaResources = array(payload.mediaResources, `${label}.mediaResources`).map(
    (candidate, index) => parseMediaResource(candidate, `${label}.mediaResources[${index}]`),
  );
  if (mediaResources.length > REACH_SCIENTIFIC_VISUAL_LIMITS.resources) {
    throw new Error(`${label}.mediaResources exceeds its item limit.`);
  }
  unique(
    mediaResources.map(({ id }) => id),
    `${label}.mediaResources ids`,
  );
  unique(
    mediaResources.map(({ objectKey }) => objectKey),
    `${label}.mediaResources object keys`,
  );

  const available = new Set(mediaResources.map(({ id }) => id));
  const referenced = [...manifest.resourceIds];
  for (const resourceId of referenced) {
    if (!available.has(resourceId)) {
      throw new Error(`${label} references unknown media resource ${resourceId}.`);
    }
  }
  const unused = mediaResources.filter(({ id }) => !referenced.includes(id));
  if (unused.length > 0) {
    throw new Error(`${label} contains unreferenced media resource ${unused[0]!.id}.`);
  }
  return { documentHtml, manifest, mediaResources };
}

export function parseReachScientificVisualDocumentHtmlV1(
  value: unknown,
  label = 'scientific visual.documentHtml',
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty HTML.`);
  }
  if (
    new TextEncoder().encode(value).byteLength > REACH_SCIENTIFIC_VISUAL_LIMITS.documentHtmlBytes
  ) {
    throw new Error(`${label} exceeds its UTF-8 byte limit.`);
  }
  return value;
}

/**
 * A durable binding set may remain readable after an element or manifest edit. Runtime projection
 * must use it only when the set still covers the current manifest exactly; partial application would
 * mix narration timing with fallback timing and produce nondeterministic scientific state.
 */
export function isReachScientificAnchorBindingSetUsable(slide: ReachDeckNativeSlideV2): boolean {
  const visual = slide.elements.find((element) => element.type === 'scientificVisual');
  const narration = slide.narration;
  const bindings = narration?.scientificAnchorBindings;
  if (
    visual?.type !== 'scientificVisual' ||
    narration?.audioResourceId === undefined ||
    narration.segments === undefined ||
    bindings === undefined
  ) {
    return false;
  }
  if (bindings.length !== visual.manifest.anchors.length) return false;

  const timedEnds = narration.segments.flatMap((segment) =>
    segment.start === undefined || segment.end === undefined ? [] : [segment.end],
  );
  if (timedEnds.length !== narration.segments.length) return false;
  const effectiveDuration = slide.duration ?? Math.max(0, ...timedEnds);
  if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return false;

  return bindings.every((binding, index) => {
    const anchor = visual.manifest.anchors[index];
    return (
      anchor !== undefined &&
      binding.elementId === visual.id &&
      binding.anchorId === anchor.id &&
      binding.id === `narration-anchor:${visual.id}:${anchor.id}` &&
      Number.isFinite(binding.start) &&
      Number.isFinite(binding.end) &&
      binding.start >= 0 &&
      binding.end > binding.start &&
      binding.end <= effectiveDuration &&
      (index === 0 || binding.start >= bindings[index - 1]!.start)
    );
  });
}

export function parseReachScientificVisualManifestV1(
  value: unknown,
  label = 'scientific visual manifest',
): ReachScientificVisualManifestV1 {
  return parseManifest(value, label);
}

function parseManifest(value: unknown, label: string): ReachScientificVisualManifestV1 {
  const manifest = record(value, label);
  exactKeys(
    manifest,
    [
      'schemaVersion',
      'hooksVersion',
      'anchors',
      'dependencies',
      'resourceIds',
      'ariaLabel',
      'textAlternative',
    ],
    label,
  );
  if (manifest.schemaVersion !== REACH_SCIENTIFIC_VISUAL_MANIFEST_VERSION) {
    throw new Error(`${label}.schemaVersion is unsupported.`);
  }
  if (manifest.hooksVersion !== REACH_SCIENTIFIC_VISUAL_HOOKS_VERSION) {
    throw new Error(`${label}.hooksVersion is unsupported.`);
  }
  const anchors = array(manifest.anchors, `${label}.anchors`).map((candidate, index) => {
    const anchor = record(candidate, `${label}.anchors[${index}]`);
    exactKeys(anchor, ['id', 'description'], `${label}.anchors[${index}]`);
    return {
      id: identifier(anchor.id, `${label}.anchors[${index}].id`),
      description: boundedText(
        anchor.description,
        REACH_SCIENTIFIC_VISUAL_LIMITS.descriptionLength,
        `${label}.anchors[${index}].description`,
      ),
    };
  });
  if (anchors.length > REACH_SCIENTIFIC_VISUAL_LIMITS.anchors) {
    throw new Error(`${label}.anchors exceeds its item limit.`);
  }
  unique(
    anchors.map(({ id }) => id),
    `${label}.anchors ids`,
  );

  const dependencies = array(manifest.dependencies, `${label}.dependencies`).map(
    (candidate, index) => {
      const dependency = record(candidate, `${label}.dependencies[${index}]`);
      exactKeys(dependency, ['id', 'version'], `${label}.dependencies[${index}]`);
      const version = boundedText(
        dependency.version,
        REACH_SCIENTIFIC_VISUAL_LIMITS.identifierLength,
        `${label}.dependencies[${index}].version`,
      );
      if (!VERSION.test(version)) {
        throw new Error(`${label}.dependencies[${index}].version is invalid.`);
      }
      return {
        id: identifier(dependency.id, `${label}.dependencies[${index}].id`),
        version,
      };
    },
  );
  if (dependencies.length > REACH_SCIENTIFIC_VISUAL_LIMITS.dependencies) {
    throw new Error(`${label}.dependencies exceeds its item limit.`);
  }
  unique(
    dependencies.map(({ id }) => id),
    `${label}.dependencies ids`,
  );

  const resourceIds = array(manifest.resourceIds, `${label}.resourceIds`).map((candidate, index) =>
    identifier(candidate, `${label}.resourceIds[${index}]`),
  );
  if (resourceIds.length > REACH_SCIENTIFIC_VISUAL_LIMITS.resources) {
    throw new Error(`${label}.resourceIds exceeds its item limit.`);
  }
  unique(resourceIds, `${label}.resourceIds`);
  return {
    schemaVersion: REACH_SCIENTIFIC_VISUAL_MANIFEST_VERSION,
    hooksVersion: REACH_SCIENTIFIC_VISUAL_HOOKS_VERSION,
    anchors,
    dependencies,
    resourceIds,
    ariaLabel: boundedText(
      manifest.ariaLabel,
      REACH_SCIENTIFIC_VISUAL_LIMITS.ariaLabelLength,
      `${label}.ariaLabel`,
    ),
    textAlternative: boundedText(
      manifest.textAlternative,
      REACH_SCIENTIFIC_VISUAL_LIMITS.textAlternativeLength,
      `${label}.textAlternative`,
    ),
  };
}

function parseMediaResource(value: unknown, label: string): ReachScientificVisualMediaResourceV1 {
  const resource = record(value, label);
  exactKeys(resource, ['id', 'objectKey', 'contentType', 'digest'], label);
  return {
    id: identifier(resource.id, `${label}.id`),
    objectKey: boundedText(resource.objectKey, 2_000, `${label}.objectKey`),
    contentType: boundedText(resource.contentType, 120, `${label}.contentType`),
    digest: boundedText(resource.digest, 2_100, `${label}.digest`),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const allowed = new Set(required);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`${label} has unsupported fields.`);
  }
}

function boundedText(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    throw new Error(`${label} must be non-empty bounded text.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = boundedText(value, REACH_SCIENTIFIC_VISUAL_LIMITS.identifierLength, label);
  if (!IDENTIFIER.test(result)) throw new Error(`${label} must be a bounded identifier.`);
  return result;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}
