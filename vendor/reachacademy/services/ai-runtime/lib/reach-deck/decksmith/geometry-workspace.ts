import { createHash } from 'node:crypto';

import { reachDeckValuesEqual } from '@reachany/reach-deck-dsl';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  parseGeometryEnvelope,
  type GeometryEnvelope,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2,
  parseGeometryEnvelopeV2,
  type GeometryAuthoringBindingsV2,
  type GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import {
  createGeometrySessionV2,
  type GeometrySessionInitialV2,
} from '@reachany/reach-deck-geometry/server';
import { Window } from 'happy-dom';

import { DecksmithSessionError } from './session.js';

const parserWindow = new Window({
  settings: {
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    enableImageFileLoading: false,
    enableJavaScriptEvaluation: false,
  },
});
const INSTANCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type GeometryVersion = 1 | 2;
type GeometryEnvelopeVersioned = GeometryEnvelope | GeometryEnvelopeV2;
type GeometryCategory = 'objects' | 'measurements' | 'relations';

interface GeometryMarker {
  readonly element: HTMLScriptElement;
  readonly instanceId: string;
  readonly version: GeometryVersion;
  readonly envelope: GeometryEnvelopeVersioned;
  snapshot?: GeometrySnapshotMarker;
}

interface GeometrySnapshotMarker {
  readonly element: HTMLScriptElement;
  readonly initial: GeometrySessionInitialV2;
}

export interface DecksmithGeometryInstanceInspection {
  readonly instanceId: string;
  readonly kitId: string;
  readonly kitVersion: GeometryVersion;
  readonly specSchemaVersion: string;
  readonly runtimeDependency: { readonly id: string; readonly version: string };
  readonly editable: boolean;
  readonly hasAuthoredSnapshot: boolean;
  readonly readOnlyReason?: 'legacy-v1' | 'missing-authoring-binding';
  readonly envelope: GeometryEnvelopeVersioned;
}

export interface DecksmithGeometryInspection {
  readonly htmlSha256: string;
  readonly instances: readonly DecksmithGeometryInstanceInspection[];
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function envelopeFingerprint(envelope: GeometryEnvelopeV2): string {
  return digest(canonicalJson(envelope));
}

function validateSnapshot(
  envelope: GeometryEnvelopeV2,
  instanceId: string,
  value: unknown,
): GeometrySessionInitialV2 {
  if (envelope.spec.authoring === undefined) {
    throw new DecksmithSessionError(
      `[GEOMETRY_SNAPSHOT_INVALID] Geometry ${instanceId} snapshot requires authoring bindings.`,
    );
  }
  let session;
  try {
    session = createGeometrySessionV2(envelope, instanceId, {
      initial: value as GeometrySessionInitialV2,
    });
    return value as GeometrySessionInitialV2;
  } catch {
    throw new DecksmithSessionError(
      `[GEOMETRY_SNAPSHOT_INVALID] Geometry ${instanceId} has an invalid authored snapshot.`,
    );
  } finally {
    session?.dispose();
  }
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function immediatelyFollows(snapshot: Element, geometryMarker: Element): boolean {
  return snapshot.previousSibling === geometryMarker;
}

function parseDocument(documentHtml: string): { document: Document; markers: GeometryMarker[] } {
  const document = new parserWindow.DOMParser().parseFromString(
    documentHtml,
    'text/html',
  ) as unknown as Document;
  const allMarkers = [...document.querySelectorAll('[data-reach-science-kit]')];
  const targets = [...document.querySelectorAll('[data-reach-science-kit-target]')];
  const seen = new Set<string>();
  const markers: GeometryMarker[] = [];
  for (const candidate of allMarkers) {
    const instanceId = (candidate.getAttribute('data-reach-science-kit') ?? '').trim();
    if (
      candidate.tagName.toLowerCase() !== 'script' ||
      (candidate.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/json' ||
      !INSTANCE_ID_PATTERN.test(instanceId) ||
      seen.has(instanceId)
    ) {
      throw new DecksmithSessionError('[GEOMETRY_MARKER_INVALID] Invalid or duplicate marker.');
    }
    seen.add(instanceId);
    const matches = targets.filter(
      (target) =>
        (target.getAttribute('data-reach-science-kit-target') ?? '').trim() === instanceId,
    );
    if (matches.length !== 1 || matches[0]!.tagName.toLowerCase() === 'script') {
      throw new DecksmithSessionError(
        `[GEOMETRY_MARKER_INVALID] Geometry ${instanceId} requires exactly one target.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(candidate.textContent ?? '');
    } catch {
      throw new DecksmithSessionError(
        `[GEOMETRY_MARKER_INVALID] Geometry ${instanceId} must contain strict JSON.`,
      );
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const kitId = String((value as { kitId?: unknown }).kitId ?? '');
    if (!Object.hasOwn(EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits, kitId)) continue;
    const rawVersion = (value as { kitVersion?: unknown }).kitVersion;
    const version: GeometryVersion = rawVersion === 2 ? 2 : 1;
    const envelope =
      rawVersion === 2
        ? parseGeometryEnvelopeV2(value).envelope
        : rawVersion === 1
          ? parseGeometryEnvelope(value).envelope
          : undefined;
    if (envelope === undefined) {
      throw new DecksmithSessionError(
        `[GEOMETRY_MARKER_INVALID] Geometry ${instanceId} has an unsupported version.`,
      );
    }
    markers.push({
      element: candidate as unknown as HTMLScriptElement,
      instanceId,
      version,
      envelope,
    });
  }
  const snapshotIds = new Set<string>();
  for (const candidate of document.querySelectorAll('[data-reach-geometry-snapshot]')) {
    const instanceId = (candidate.getAttribute('data-reach-geometry-snapshot') ?? '').trim();
    const marker = markers.find((entry) => entry.instanceId === instanceId);
    if (
      candidate.tagName.toLowerCase() !== 'script' ||
      (candidate.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/json' ||
      !INSTANCE_ID_PATTERN.test(instanceId) ||
      snapshotIds.has(instanceId) ||
      marker?.version !== 2 ||
      !immediatelyFollows(candidate, marker.element)
    ) {
      throw new DecksmithSessionError(
        '[GEOMETRY_SNAPSHOT_INVALID] Authored snapshot must immediately follow its unique v2 geometry marker.',
      );
    }
    snapshotIds.add(instanceId);
    let value: unknown;
    try {
      value = JSON.parse(candidate.textContent ?? '');
    } catch {
      throw new DecksmithSessionError(
        `[GEOMETRY_SNAPSHOT_INVALID] Geometry ${instanceId} snapshot must contain strict JSON.`,
      );
    }
    marker.snapshot = {
      element: candidate as unknown as HTMLScriptElement,
      initial: validateSnapshot(marker.envelope as GeometryEnvelopeV2, instanceId, value),
    };
  }
  return { document, markers };
}

function runtimeFor(marker: GeometryMarker) {
  const definitions =
    marker.version === 2 ? EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits : EUCLIDEAN_GEOMETRY_CONTRACT.kits;
  const kit = definitions[marker.envelope.kitId as keyof typeof definitions];
  return { id: kit.runtimeId, version: kit.runtimeVersion };
}

export function inspectDecksmithGeometry(documentHtml: string): DecksmithGeometryInspection {
  const { markers } = parseDocument(documentHtml);
  return {
    htmlSha256: digest(documentHtml),
    instances: markers.map((marker) => {
      const authoring =
        marker.version === 2 ? (marker.envelope as GeometryEnvelopeV2).spec.authoring : undefined;
      return {
        instanceId: marker.instanceId,
        kitId: marker.envelope.kitId,
        kitVersion: marker.version,
        specSchemaVersion: marker.envelope.spec.schemaVersion,
        runtimeDependency: runtimeFor(marker),
        editable: authoring !== undefined,
        hasAuthoredSnapshot: marker.snapshot !== undefined,
        ...(marker.version === 1
          ? { readOnlyReason: 'legacy-v1' as const }
          : authoring === undefined
            ? { readOnlyReason: 'missing-authoring-binding' as const }
            : {}),
        envelope: marker.envelope,
      };
    }),
  };
}

function mapById<T extends { readonly id: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function changedIds<T extends { readonly id: string }>(
  before: readonly T[],
  after: readonly T[],
): { added: string[]; removed: string[]; changed: string[] } {
  const left = mapById(before);
  const right = mapById(after);
  return {
    added: [...right.keys()].filter((id) => !left.has(id)),
    removed: [...left.keys()].filter((id) => !right.has(id)),
    changed: [...left.keys()].filter(
      (id) => right.has(id) && !reachDeckValuesEqual(left.get(id), right.get(id)),
    ),
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    new Set(right).size === right.length
  );
}

function assertDefinitionChanges(
  before: GeometryEnvelopeV2,
  after: GeometryEnvelopeV2,
  bindings: GeometryAuthoringBindingsV2,
): Record<GeometryCategory | 'freedoms', ReturnType<typeof changedIds>> {
  const parameters = changedIds(before.spec.parameters, after.spec.parameters);
  if (
    parameters.added.length ||
    parameters.removed.length ||
    parameters.changed.some((id) => !bindings.editable.parameters.includes(id))
  ) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_READ_ONLY] Only bound parameter values and ranges may change.',
    );
  }
  const changes = {
    objects: changedIds(before.spec.objects, after.spec.objects),
    measurements: changedIds(before.spec.measurements, after.spec.measurements),
    relations: changedIds(before.spec.relations, after.spec.relations),
    freedoms: changedIds(before.spec.interaction.freedoms, after.spec.interaction.freedoms),
  };
  for (const category of ['objects', 'measurements', 'relations'] as const) {
    const change = changes[category];
    if (change.changed.length) {
      throw new DecksmithSessionError(
        `[GEOMETRY_EDIT_READ_ONLY] Existing ${category} definitions cannot be rewritten.`,
      );
    }
    if (change.removed.some((id) => !bindings.deletable[category].includes(id))) {
      throw new DecksmithSessionError(
        `[GEOMETRY_EDIT_READ_ONLY] Removed ${category} are not declared deletable.`,
      );
    }
    if (change.removed.some((id) => bindings.externalReferences.includes(id))) {
      throw new DecksmithSessionError(
        '[GEOMETRY_EDIT_EXTERNAL_REFERENCE] An externally referenced item cannot be deleted.',
      );
    }
  }
  if (
    changes.freedoms.changed.some((id) => !bindings.editable.freedoms.includes(id)) ||
    changes.freedoms.removed.some((id) => !bindings.editable.freedoms.includes(id))
  ) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_READ_ONLY] Changed freedoms are not declared editable.',
    );
  }
  return changes;
}

function assertPresentationChanges(
  before: GeometryEnvelopeV2,
  after: GeometryEnvelopeV2,
  bindings: GeometryAuthoringBindingsV2,
  changes: ReturnType<typeof assertDefinitionChanges>,
): void {
  const definitions = [
    ['objects', 'object'],
    ['measurements', 'measurement'],
    ['relations', 'relation'],
  ] as const;
  for (const [category, key] of definitions) {
    const beforeValues = before.spec.presentation[category].map((value) => ({
      id: (value as unknown as Record<string, string>)[key]!,
      value,
    }));
    const afterValues = after.spec.presentation[category].map((value) => ({
      id: (value as unknown as Record<string, string>)[key]!,
      value,
    }));
    const presentationChanges = changedIds(beforeValues, afterValues);
    const allowed = new Set([...bindings.editable[category], ...changes[category].added]);
    if (
      [
        ...presentationChanges.added,
        ...presentationChanges.removed,
        ...presentationChanges.changed,
      ].some((id) => !allowed.has(id))
    ) {
      throw new DecksmithSessionError(
        `[GEOMETRY_EDIT_READ_ONLY] Presentation changes for ${category} exceed authoring bindings.`,
      );
    }
  }
  if (
    !reachDeckValuesEqual(before.spec.presentation.groups, after.spec.presentation.groups) ||
    !reachDeckValuesEqual(before.spec.presentation.rightAngles, after.spec.presentation.rightAngles)
  ) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_READ_ONLY] Groups and right-angle declarations are outside this tool.',
    );
  }
}

function assertAuthoringTransition(
  before: GeometryAuthoringBindingsV2,
  after: GeometryAuthoringBindingsV2,
  changes: ReturnType<typeof assertDefinitionChanges>,
): void {
  if (!sameStringSet(before.externalReferences, after.externalReferences)) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_READ_ONLY] externalReferences cannot be changed by a proposal.',
    );
  }
  for (const category of ['objects', 'measurements', 'relations'] as const) {
    const expectedEditable = before.editable[category]
      .filter((id) => !changes[category].removed.includes(id))
      .concat(changes[category].added);
    const expectedDeletable = before.deletable[category]
      .filter((id) => !changes[category].removed.includes(id))
      .concat(changes[category].added);
    if (
      !sameStringSet(expectedEditable, after.editable[category]) ||
      !sameStringSet(expectedDeletable, after.deletable[category])
    ) {
      throw new DecksmithSessionError(
        `[GEOMETRY_EDIT_BINDING] Added ${category} must become editable/deletable and existing bindings cannot be widened.`,
      );
    }
  }
  const expectedFreedoms = before.editable.freedoms
    .filter((id) => !changes.freedoms.removed.includes(id))
    .concat(changes.freedoms.added);
  if (
    !sameStringSet(before.editable.parameters, after.editable.parameters) ||
    !sameStringSet(expectedFreedoms, after.editable.freedoms)
  ) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_BINDING] Parameter/freedom authoring bindings cannot be widened.',
    );
  }
}

function assertControlledV2Edit(before: GeometryEnvelopeV2, after: GeometryEnvelopeV2): void {
  const bindings = before.spec.authoring;
  if (bindings === undefined) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_READ_ONLY] Geometry marker has no authoring binding.',
    );
  }
  if (
    before.kitId !== after.kitId ||
    before.spec.dimension !== after.spec.dimension ||
    before.spec.units !== after.spec.units ||
    !reachDeckValuesEqual(before.spec.assertions, after.spec.assertions)
  ) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_READ_ONLY] Identity, units, dimension, and assertions are immutable.',
    );
  }
  const changes = assertDefinitionChanges(before, after, bindings);
  assertPresentationChanges(before, after, bindings, changes);
  const afterBindings = after.spec.authoring;
  if (afterBindings === undefined) {
    throw new DecksmithSessionError('[GEOMETRY_EDIT_BINDING] Authoring binding cannot be removed.');
  }
  assertAuthoringTransition(bindings, afterBindings, changes);
}

export function applyDecksmithGeometryProposal(input: {
  readonly documentHtml: string;
  readonly instanceId: string;
  readonly expectedHtmlSha256: string;
  readonly envelope: unknown;
}): { readonly documentHtml: string; readonly previousSha256: string; readonly sha256: string } {
  const previousSha256 = digest(input.documentHtml);
  if (input.expectedHtmlSha256 !== previousSha256) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_STALE] Interactive HTML changed; inspect geometry again.',
    );
  }
  const parsed = parseDocument(input.documentHtml);
  const marker = parsed.markers.find((candidate) => candidate.instanceId === input.instanceId);
  if (marker === undefined) {
    throw new DecksmithSessionError('[GEOMETRY_EDIT_NOT_FOUND] Geometry instance was not found.');
  }
  if (marker.version !== 2) {
    throw new DecksmithSessionError(
      '[GEOMETRY_EDIT_LEGACY_V1] Existing v1 geometry cannot be upgraded implicitly.',
    );
  }
  const envelope = parseGeometryEnvelopeV2(input.envelope).envelope;
  assertControlledV2Edit(marker.envelope as GeometryEnvelopeV2, envelope);
  if (marker.snapshot !== undefined) {
    const initial = validateSnapshot(envelope, marker.instanceId, {
      ...marker.snapshot.initial,
      fingerprint: envelopeFingerprint(envelope),
    });
    marker.snapshot.element.textContent = safeInlineJson(initial);
  }
  marker.element.textContent = safeInlineJson(envelope);
  const documentHtml = `<!doctype html>${parsed.document.documentElement.outerHTML}`;
  return { documentHtml, previousSha256, sha256: digest(documentHtml) };
}
