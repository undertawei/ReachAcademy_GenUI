import { createHash } from 'node:crypto';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  parseGeometryEnvelope,
  type GeometryEnvelope,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2,
  parseGeometryEnvelopeV2,
  type GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import type { GeometrySessionStateV2 } from '@reachany/reach-deck-geometry/session-v2';

export const GEOMETRY_TRANSPORT = EUCLIDEAN_GEOMETRY_CONTRACT.transport;
export const GEOMETRY_TRANSPORT_V2 = EUCLIDEAN_GEOMETRY_CONTRACT_V2.transport;
export interface GeometryValidationMarkerV1 {
  readonly instanceId: string;
  readonly envelope: GeometryEnvelope;
}
export interface GeometryValidationMarkerV2 {
  readonly instanceId: string;
  readonly envelope: GeometryEnvelopeV2;
  readonly state: GeometrySessionStateV2 | null;
}
export type GeometryValidationMarker = GeometryValidationMarkerV1 | GeometryValidationMarkerV2;
export interface GeometryValidationResult {
  readonly instanceId: string;
  readonly valid: boolean;
  readonly diagnostics: readonly { readonly code: string; readonly path: string }[];
}
export class GeometryValidationFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 503,
  ) {
    super(code);
  }
}

export function geometryDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

export function parseGeometryValidationRequest(
  bytes: Uint8Array,
  digest: string | null,
): readonly GeometryValidationMarker[] {
  const invalid = (): never => {
    throw new GeometryValidationFailure('geometry_invalid_request', 400);
  };
  if (
    bytes.byteLength >
      Math.max(GEOMETRY_TRANSPORT.requestBytes, GEOMETRY_TRANSPORT_V2.requestBytes) ||
    digest === null ||
    !new RegExp(GEOMETRY_TRANSPORT.digestPattern).test(digest) ||
    digest !== geometryDigest(bytes)
  )
    return invalid();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
  const transport =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === GEOMETRY_TRANSPORT_V2.schemaVersion
      ? GEOMETRY_TRANSPORT_V2
      : GEOMETRY_TRANSPORT;
  if (
    bytes.byteLength > transport.requestBytes ||
    !exact(value, transport.requestFields) ||
    value.schemaVersion !== transport.schemaVersion ||
    !Array.isArray(value.markers) ||
    value.markers.length < transport.minimumMarkers ||
    value.markers.length > transport.maximumMarkers
  )
    return invalid();
  const ids = new Set<string>();
  let total = 0;
  return value.markers.map((marker: unknown) => {
    if (
      !exact(marker, transport.markerFields) ||
      typeof marker.instanceId !== 'string' ||
      !new RegExp(transport.instanceIdPattern).test(marker.instanceId) ||
      ids.has(marker.instanceId)
    )
      return invalid();
    ids.add(marker.instanceId);
    try {
      if (transport === GEOMETRY_TRANSPORT_V2) {
        const parsed = parseGeometryEnvelopeV2(marker.envelope);
        if (marker.state !== null) {
          if (
            !exact(marker.state, [
              'schemaVersion',
              'instanceId',
              'fingerprint',
              'inputs',
              'auxiliary',
              'hiddenAuxiliary',
              'selection',
              'visibleGroups',
              'camera',
            ]) ||
            marker.state.schemaVersion !== 'reach-geometry-state/v2' ||
            marker.state.instanceId !== marker.instanceId ||
            typeof marker.state.fingerprint !== 'string' ||
            !/^[a-f0-9]{64}$/.test(marker.state.fingerprint)
          )
            return invalid();
        }
        const accepted: GeometryValidationMarkerV2 = {
          instanceId: marker.instanceId,
          envelope: parsed.envelope,
          state: marker.state as GeometrySessionStateV2 | null,
        };
        const size = Buffer.byteLength(JSON.stringify(accepted), 'utf8');
        total += size;
        if (size > transport.markerBytes || total > transport.aggregateMarkerBytes)
          return invalid();
        return accepted;
      }
      const parsed = parseGeometryEnvelope(marker.envelope);
      const accepted: GeometryValidationMarkerV1 = {
        instanceId: marker.instanceId,
        envelope: parsed.envelope,
      };
      const size = Buffer.byteLength(JSON.stringify(parsed.envelope), 'utf8');
      total += size;
      if (size > transport.markerBytes || total > transport.aggregateMarkerBytes) return invalid();
      return accepted;
    } catch {
      return invalid();
    }
  });
}

const diagnosticCodes = new Set<string>([
  ...EUCLIDEAN_GEOMETRY_CONTRACT.geometryUndefinedReasons,
  ...EUCLIDEAN_GEOMETRY_CONTRACT.scalarUndefinedReasons,
  ...EUCLIDEAN_GEOMETRY_CONTRACT.diagnosticCodes,
  ...EUCLIDEAN_GEOMETRY_CONTRACT_V2.reasonCodes,
]);

export function geometryTransportForMarkers(markers: readonly GeometryValidationMarker[]) {
  const v2 = markers.length > 0 && Object.hasOwn(markers[0]!, 'state');
  if (markers.some((marker) => Object.hasOwn(marker, 'state') !== v2))
    throw new GeometryValidationFailure('geometry_evaluator_unavailable', 503);
  return v2 ? GEOMETRY_TRANSPORT_V2 : GEOMETRY_TRANSPORT;
}

export function validateGeometryResults(
  value: unknown,
  markers: readonly GeometryValidationMarker[],
): asserts value is readonly GeometryValidationResult[] {
  const invalid = (): never => {
    throw new GeometryValidationFailure('geometry_evaluator_unavailable', 503);
  };
  if (!Array.isArray(value) || value.length !== markers.length) return invalid();
  const transport = geometryTransportForMarkers(markers);
  const text = new RegExp(transport.diagnosticTextPattern);
  value.forEach((result: unknown, index) => {
    if (
      !exact(result, transport.resultFields) ||
      result.instanceId !== markers[index].instanceId ||
      typeof result.valid !== 'boolean' ||
      !Array.isArray(result.diagnostics) ||
      result.diagnostics.length > transport.diagnosticsPerMarker ||
      (result.valid ? result.diagnostics.length !== 0 : result.diagnostics.length === 0)
    )
      return invalid();
    for (const diagnostic of result.diagnostics) {
      if (
        !exact(diagnostic, transport.diagnosticFields) ||
        typeof diagnostic.code !== 'string' ||
        typeof diagnostic.path !== 'string' ||
        !text.test(diagnostic.code) ||
        !text.test(diagnostic.path) ||
        !diagnosticCodes.has(diagnostic.code)
      )
        return invalid();
    }
  });
}

export function serializeGeometryResponse(
  results: unknown,
  markers: readonly GeometryValidationMarker[],
  digest: string,
): string {
  validateGeometryResults(results, markers);
  const transport = geometryTransportForMarkers(markers);
  const v2 = transport === GEOMETRY_TRANSPORT_V2;
  const body = JSON.stringify({
    schemaVersion: transport.schemaVersion,
    evaluatorVersion: v2
      ? EUCLIDEAN_GEOMETRY_CONTRACT_V2.evaluatorVersion
      : EUCLIDEAN_GEOMETRY_CONTRACT.evaluatorVersion,
    digest,
    results,
  });
  if (Buffer.byteLength(body, 'utf8') > transport.responseBytes)
    throw new GeometryValidationFailure('geometry_evaluator_unavailable', 503);
  return body;
}

export async function readGeometryBody(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  const maximumRequestBytes = Math.max(
    GEOMETRY_TRANSPORT.requestBytes,
    GEOMETRY_TRANSPORT_V2.requestBytes,
  );
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers.get('content-type') ?? '',
    ) ||
    !['identity', null].includes(request.headers.get('content-encoding'))
  )
    throw new GeometryValidationFailure('geometry_invalid_request', 400);
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumRequestBytes)
  )
    throw new GeometryValidationFailure('geometry_invalid_request', 400);
  if (!request.body) throw new GeometryValidationFailure('geometry_invalid_request', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      void reader.cancel().catch(() => {});
      reject(new GeometryValidationFailure('geometry_deadline_exceeded', 503));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new GeometryValidationFailure('geometry_deadline_exceeded', 503);
      if (item.done) return Buffer.concat(chunks, size);
      size += item.value.byteLength;
      if (size > maximumRequestBytes) {
        void reader.cancel().catch(() => {});
        throw new GeometryValidationFailure('geometry_invalid_request', 400);
      }
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
