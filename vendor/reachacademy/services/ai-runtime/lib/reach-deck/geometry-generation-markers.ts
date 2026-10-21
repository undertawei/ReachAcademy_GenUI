import {
  INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN,
  interactiveScienceKitRuntimeDependency,
  parseInteractiveScienceKitEnvelopeValue,
  type InteractiveRuntimeDependency,
  type InteractiveRuntimeId,
} from '@reachany/reach-deck-dsl';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  parseGeometryEnvelope,
  validateGeometryPageBudget,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2,
  parseGeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { createGeometrySessionV2, evaluateGeometry } from '@reachany/reach-deck-geometry/server';

export interface ScientificGenerationValidationOptions {
  readonly scientificCapabilityPolicy?: 'normal' | 'legacy' | 'candidate';
  readonly allowedRuntimeDependencies?: readonly InteractiveRuntimeDependency[];
  /** Fresh generation only; durable and Decksmith reads deliberately leave this disabled. */
  readonly requireGeometryAuthoring?: boolean;
}

interface MarkerElement {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
}
interface MarkerDocument {
  querySelectorAll(selector: string): Iterable<MarkerElement>;
}

export interface ScienceMarkerInspection {
  readonly runtimeIds: ReadonlySet<InteractiveRuntimeId>;
  readonly invalidGeometryInstances: ReadonlySet<string>;
  readonly geometryInstances: ReadonlySet<string>;
  readonly errors: readonly string[];
}

export function isGeometryRuntime(id: string): boolean {
  return [EUCLIDEAN_GEOMETRY_CONTRACT.kits, EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits].some((kits) =>
    Object.values(kits).some((kit) => kit.runtimeId === id),
  );
}

/** Inspect all inert markers, retaining instance diagnostics before the repair baseline is frozen. */
export function inspectScienceGenerationMarkers(
  document: MarkerDocument,
  options: ScientificGenerationValidationOptions,
  geometryJsonRepairAllowed = false,
): ScienceMarkerInspection {
  const markers = [...document.querySelectorAll('[data-reach-science-kit]')];
  const targets = [...document.querySelectorAll('[data-reach-science-kit-target]')];
  const runtimeIds = new Set<InteractiveRuntimeId>();
  const invalidGeometryInstances = new Set<string>();
  const geometryInstances = new Set<string>();
  const errors: string[] = [];
  const seen = new Set<string>();
  const budget: { kitId: string; bytes: number }[] = [];
  if (markers.length > EUCLIDEAN_GEOMETRY_CONTRACT.limits.pageMarkers) {
    throw new Error('Interactive science kit page_markers_exceeded.');
  }
  let rawBytes = 0;
  for (const marker of markers) {
    const instanceId = (marker.getAttribute('data-reach-science-kit') ?? '').trim();
    if (
      marker.tagName.toLowerCase() !== 'script' ||
      (marker.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/json' ||
      !INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN.test(instanceId) ||
      seen.has(instanceId)
    ) {
      throw new Error(
        'Interactive science kit marker type or instance id is invalid or duplicated.',
      );
    }
    seen.add(instanceId);
    const matchingTargets = targets.filter(
      (target) =>
        (target.getAttribute('data-reach-science-kit-target') ?? '').trim() === instanceId,
    );
    if (matchingTargets.length !== 1 || matchingTargets[0]!.tagName.toLowerCase() === 'script') {
      throw new Error(`Interactive science kit ${instanceId} requires exactly one target.`);
    }
    const json = marker.textContent ?? '';
    const bytes = Buffer.byteLength(json, 'utf8');
    rawBytes += bytes;
    if (
      bytes >
      Math.max(
        EUCLIDEAN_GEOMETRY_CONTRACT.limits.markerBytes,
        EUCLIDEAN_GEOMETRY_CONTRACT_V2.limits.markerBytes,
      )
    ) {
      throw new Error(`Interactive science kit ${instanceId} marker_bytes_exceeded.`);
    }
    if (rawBytes > EUCLIDEAN_GEOMETRY_CONTRACT.limits.pageBytes) {
      throw new Error('Interactive science kit page_bytes_exceeded.');
    }
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      if (geometryJsonRepairAllowed && options.scientificCapabilityPolicy !== 'legacy') {
        invalidGeometryInstances.add(instanceId);
        geometryInstances.add(instanceId);
        errors.push(`Geometry marker ${instanceId}: invalid JSON.`);
        continue;
      }
      throw new Error(`Interactive science kit ${instanceId} must contain valid JSON.`);
    }
    const kitId =
      value !== null && typeof value === 'object'
        ? String((value as { kitId?: unknown }).kitId)
        : '';
    const geometry = Object.hasOwn(EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits, kitId);
    if (!geometry) {
      const envelope = parseInteractiveScienceKitEnvelopeValue(value);
      runtimeIds.add(interactiveScienceKitRuntimeDependency(envelope.kitId).id);
      budget.push({ kitId: envelope.kitId, bytes });
      continue;
    }
    if (options.scientificCapabilityPolicy === 'legacy') {
      throw new Error(`Interactive science kit ${instanceId}: geometry generation is disabled.`);
    }
    geometryInstances.add(instanceId);
    const version =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { kitVersion?: unknown }).kitVersion === 2
        ? 2
        : 1;
    const definitions =
      version === 2 ? EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits : EUCLIDEAN_GEOMETRY_CONTRACT.kits;
    const definition = definitions[kitId as keyof typeof definitions];
    const freshVersionError =
      options.requireGeometryAuthoring && version !== 2
        ? 'fresh geometry generation requires kitVersion:2'
        : undefined;
    if (
      freshVersionError === undefined &&
      options.allowedRuntimeDependencies !== undefined &&
      !options.allowedRuntimeDependencies.some(
        (pin) => pin.id === definition.runtimeId && pin.version === definition.runtimeVersion,
      )
    ) {
      throw new Error(`Interactive science kit ${instanceId}: runtime is not authorized.`);
    }
    runtimeIds.add(definition.runtimeId as InteractiveRuntimeId);
    budget.push({ kitId, bytes });
    try {
      if (freshVersionError !== undefined) throw new Error(freshVersionError);
      const parsed =
        version === 2 ? parseGeometryEnvelopeV2(value).projection : parseGeometryEnvelope(value);
      if (
        options.requireGeometryAuthoring &&
        version === 2 &&
        !Object.hasOwn((value as { spec?: object }).spec ?? {}, 'authoring')
      ) {
        throw new Error(
          'fresh geometry generation requires valid reach-geometry-authoring/v1 bindings at $.spec.authoring',
        );
      }
      const evaluation =
        version === 2
          ? (() => {
              const session = createGeometrySessionV2(value, instanceId);
              try {
                return session.getComputedState();
              } finally {
                session.dispose();
              }
            })()
          : evaluateGeometry(parsed.envelope);
      if (!evaluation.valid) {
        throw new Error(
          evaluation.diagnostics
            .map(({ path, code }) => {
              const match = /^\$\.spec\.(objects|measurements|assertions)\[(\d+)\]/.exec(path);
              const field = match?.[1] as 'objects' | 'measurements' | 'assertions' | undefined;
              const id =
                field === undefined
                  ? undefined
                  : parsed.envelope.spec[field][Number(match![2])]?.id;
              return `${path}${id === undefined ? '' : ` (${id})`}: ${code}`;
            })
            .join('; '),
        );
      }
    } catch (error) {
      invalidGeometryInstances.add(instanceId);
      const detail = error instanceof Error ? error.message : 'invalid geometry';
      errors.push(`Geometry marker ${instanceId} [v${version}]: ${detail.slice(0, 700)}`);
    }
  }
  validateGeometryPageBudget(budget);
  return { runtimeIds, invalidGeometryInstances, geometryInstances, errors };
}
