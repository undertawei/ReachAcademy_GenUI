import { createHash } from 'node:crypto';

import type { RuntimeEnv } from '../../env.js';
import {
  createModelServiceToken,
  type ReachDeckModelEnv,
  type ReachDeckModelRequestContext,
} from '../model-service-client.js';
import {
  DECKSMITH_CAPACITY_SNAPSHOT_SCHEMA_VERSION,
  DECKSMITH_APPLICATION_MESSAGE_SCHEMA_VERSION,
  parseDecksmithCapacityApplicationMessage,
  parseDecksmithCapacitySnapshot,
  type DecksmithCapacityState,
  type DecksmithFrozenCapacitySnapshot,
} from './page-stream-contracts.js';

export const DECKSMITH_CAPACITY_REQUEST_SCHEMA_VERSION =
  'reach-deck-model-capacity-estimate-request/v1' as const;
export const DECKSMITH_CAPACITY_RESPONSE_SCHEMA_VERSION =
  'reach-deck-model-capacity-estimate/v1' as const;
export const DECKSMITH_CAPACITY_ESTIMATOR_VERSION =
  'serialized-utf8-bytes-plus-structure-16/v1' as const;
export const DECKSMITH_CAPACITY_UNIT = 'model-token-upper-bound' as const;
export const DECKSMITH_CAPACITY_FALLBACK_VERSION =
  'decksmith-conservative-capacity-floor/v1' as const;
export const DECKSMITH_CONTEXT_SELECTION_ALGORITHM_VERSION =
  'decksmith-summary-plus-complete-turns/v1' as const;

// Task 4A permits a two-unit context with one unit reserved for output. A transport-only
// fallback therefore cannot honestly guarantee more than one input unit. Keeping the floor
// blocked is intentionally fail closed: it preserves the durable guidance seam without
// overstating an unavailable model profile.
const FALLBACK_GUARANTEED_INPUT_CAPACITY = 1;
const FALLBACK_RESERVED_OUTPUT_CAPACITY = 1;
const STRUCTURAL_ITEM_ESTIMATE = 16;
const DEFAULT_CAPACITY_DISCOVERY_TIMEOUT_MS = 5_000;
// Bound synchronous request preparation even though callers perform discovery outside the
// deck-wide writer lease; a slow model profile must not hold the HTTP route indefinitely.
const MAX_CAPACITY_DISCOVERY_TIMEOUT_MS = 20_000;
const NETWORK_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

export const DECKSMITH_CAPACITY_MESSAGE_KEYS: Readonly<Record<DecksmithCapacityState, string>> =
  Object.freeze({
    ordinary: 'reachDeck.decksmith.capacity.ordinary',
    approaching: 'reachDeck.decksmith.capacity.approaching',
    needs_compaction: 'reachDeck.decksmith.capacity.compacting',
    blocked: 'reachDeck.decksmith.capacity.blocked',
  });

export function decksmithCapacityApplicationMessage(state: DecksmithCapacityState) {
  return parseDecksmithCapacityApplicationMessage({
    schemaVersion: DECKSMITH_APPLICATION_MESSAGE_SCHEMA_VERSION,
    kind: 'capacity',
    state,
    messageKey: DECKSMITH_CAPACITY_MESSAGE_KEYS[state],
    ...(state === 'blocked'
      ? {
          guidance: {
            action: 'new-topic',
            messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
          },
        }
      : {}),
  });
}

export interface DecksmithCapacityInputMeasure {
  readonly serializedInputUtf8Bytes: number;
  readonly structuralItemCount: number;
  readonly digest: string;
}

interface CapacityGuarantee {
  readonly capacityProfileVersion: string;
  readonly estimatorVersion: string;
  readonly capacityUnit: string;
  readonly guaranteedInputCapacity: number;
  readonly reservedOutputCapacity: number;
  readonly estimatedInput: number;
  readonly provenance: DecksmithFrozenCapacitySnapshot['provenance'];
}

export class DecksmithCapacityDiscoveryError extends Error {
  constructor(
    message: string,
    readonly fallbackAllowed: boolean,
  ) {
    super(message);
    this.name = 'DecksmithCapacityDiscoveryError';
  }
}

export async function discoverDecksmithCapacity(input: {
  readonly context: ReachDeckModelRequestContext;
  readonly measure: DecksmithCapacityInputMeasure;
  readonly env?: ReachDeckModelEnv;
  readonly fetchImpl?: typeof fetch;
  readonly stage?:
    | 'decksmith'
    | 'lesson-plan'
    | 'paged-outline'
    | 'interactive'
    | 'slide'
    | 'slide-semantics'
    | 'quiz'
    | 'narration';
}): Promise<DecksmithFrozenCapacitySnapshot> {
  validateMeasure(input.measure);
  const env = input.env ?? process.env;
  let guarantee: CapacityGuarantee;
  try {
    guarantee = await requestCapacityEstimate({
      context: input.context,
      measure: input.measure,
      env,
      fetchImpl: input.fetchImpl ?? fetch,
      stage: input.stage ?? 'decksmith',
    });
  } catch (error) {
    if (!(error instanceof DecksmithCapacityDiscoveryError) || !error.fallbackAllowed) throw error;
    guarantee = fallbackGuarantee(input.measure);
  }
  return capacitySnapshot(guarantee, input.measure, readCapacityBands(env));
}

export function estimateWithFrozenCapacity(
  frozen: DecksmithFrozenCapacitySnapshot,
  measure: DecksmithCapacityInputMeasure,
): DecksmithFrozenCapacitySnapshot {
  const parsed = parseDecksmithCapacitySnapshot(frozen);
  validateMeasure(measure);
  if (parsed.estimatorVersion !== DECKSMITH_CAPACITY_ESTIMATOR_VERSION) {
    throw new Error('Decksmith frozen capacity estimator is unsupported');
  }
  const estimatedInput = deterministicEstimate(measure);
  return parseDecksmithCapacitySnapshot({
    ...parsed,
    estimatedInput,
    state: capacityState(estimatedInput, parsed.thresholds),
    messageKey: DECKSMITH_CAPACITY_MESSAGE_KEYS[capacityState(estimatedInput, parsed.thresholds)],
    inputMeasure: measure,
  });
}

export function capacityState(
  estimatedInput: number,
  thresholds: DecksmithFrozenCapacitySnapshot['thresholds'],
): DecksmithCapacityState {
  if (estimatedInput >= thresholds.blocked) return 'blocked';
  if (estimatedInput >= thresholds.needsCompaction) return 'needs_compaction';
  if (estimatedInput >= thresholds.approaching) return 'approaching';
  return 'ordinary';
}

export function deterministicCapacityMeasure(value: unknown, structuralItemCount: number) {
  return deterministicCapacityMeasureSerialized(JSON.stringify(value), structuralItemCount);
}

export function deterministicCapacityMeasureSerialized(
  serialized: string,
  structuralItemCount: number,
) {
  if (!Number.isSafeInteger(structuralItemCount) || structuralItemCount < 0) {
    throw new Error('Decksmith structural item count is invalid');
  }
  const serializedInputUtf8Bytes = Buffer.byteLength(serialized, 'utf8');
  return Object.freeze({
    serializedInputUtf8Bytes,
    structuralItemCount,
    digest: createHash('sha256').update(serialized).digest('hex'),
  });
}

export function countDeterministicCapacityStructure(value: unknown): number {
  if (Array.isArray(value)) {
    return (
      1 + value.reduce((count, entry) => count + countDeterministicCapacityStructure(entry), 0)
    );
  }
  if (typeof value === 'object' && value !== null) {
    return (
      1 +
      Object.entries(value).reduce(
        (count, [key, entry]) =>
          count +
          1 +
          countDeterministicCapacityStructure(key) +
          countDeterministicCapacityStructure(entry),
        0,
      )
    );
  }
  return 1;
}

export function estimateDeterministicCapacity(measure: DecksmithCapacityInputMeasure): number {
  validateMeasure(measure);
  return deterministicEstimate(measure);
}

function capacitySnapshot(
  guarantee: CapacityGuarantee,
  measure: DecksmithCapacityInputMeasure,
  bands: { approaching: number; needsCompaction: number; blocked: number },
) {
  const thresholds = Object.freeze({
    approaching: percentageThreshold(guarantee.guaranteedInputCapacity, bands.approaching),
    needsCompaction: percentageThreshold(guarantee.guaranteedInputCapacity, bands.needsCompaction),
    blocked: percentageThreshold(guarantee.guaranteedInputCapacity, bands.blocked),
  });
  const state = capacityState(guarantee.estimatedInput, thresholds);
  return parseDecksmithCapacitySnapshot({
    schemaVersion: DECKSMITH_CAPACITY_SNAPSHOT_SCHEMA_VERSION,
    capacityProfileVersion: guarantee.capacityProfileVersion,
    estimatorVersion: guarantee.estimatorVersion,
    capacityUnit: guarantee.capacityUnit,
    guaranteedInputCapacity: guarantee.guaranteedInputCapacity,
    reservedOutputCapacity: guarantee.reservedOutputCapacity,
    estimatedInput: guarantee.estimatedInput,
    thresholds,
    state,
    messageKey: DECKSMITH_CAPACITY_MESSAGE_KEYS[state],
    provenance: guarantee.provenance,
    inputMeasure: measure,
  });
}

async function requestCapacityEstimate(input: {
  readonly context: ReachDeckModelRequestContext;
  readonly measure: DecksmithCapacityInputMeasure;
  readonly env: ReachDeckModelEnv;
  readonly fetchImpl: typeof fetch;
  readonly stage:
    | 'decksmith'
    | 'lesson-plan'
    | 'paged-outline'
    | 'interactive'
    | 'slide'
    | 'slide-semantics'
    | 'quiz'
    | 'narration';
}): Promise<CapacityGuarantee> {
  const token = await createModelServiceToken(input.env, input.context);
  const endpoint = resolveCapacityEndpoint(input.env);
  const timeoutMs = resolveCapacityDiscoveryTimeoutMs(input.env);
  const body = JSON.stringify({
    schema_version: DECKSMITH_CAPACITY_REQUEST_SCHEMA_VERSION,
    invocation: {
      scene_id: 'teacher.deck',
      orchestration: 'courseware.deck',
      stage: input.stage,
      tool: 'chat',
      channel: 'chat',
    },
    input_measure: {
      serialized_input_utf8_bytes: input.measure.serializedInputUtf8Bytes,
      structural_item_count: input.measure.structuralItemCount,
    },
  });
  const timeout = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeout.abort(new DOMException('Decksmith capacity discovery timed out', 'TimeoutError')),
    timeoutMs,
  );
  let response: Response;
  try {
    response = await input.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
      signal: timeout.signal,
    });
  } catch (error) {
    if (!isCapacityTransportUnavailable(error, timeout.signal)) throw error;
    throw new DecksmithCapacityDiscoveryError(
      `Decksmith capacity discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!response.ok) {
    throw new DecksmithCapacityDiscoveryError(
      `Decksmith capacity discovery returned HTTP ${response.status}`,
      false,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new DecksmithCapacityDiscoveryError('Decksmith capacity response is not JSON', false);
  }
  return parseCapacityEnvelope(value, input.measure);
}

function parseCapacityEnvelope(
  value: unknown,
  measure: DecksmithCapacityInputMeasure,
): CapacityGuarantee {
  const envelope = exactRecord(value, ['code', 'message', 'data', 'requestId']);
  if (envelope.code !== 0 || envelope.message !== 'ok' || typeof envelope.requestId !== 'string') {
    throw new DecksmithCapacityDiscoveryError('Decksmith capacity envelope is invalid', false);
  }
  const data = exactRecord(envelope.data, [
    'schema_version',
    'capacity_profile_version',
    'estimator_version',
    'capacity_unit',
    'guaranteed_input_capacity',
    'reserved_output_capacity',
    'estimated_input',
  ]);
  const estimatedInput = deterministicEstimate(measure);
  if (
    data.schema_version !== DECKSMITH_CAPACITY_RESPONSE_SCHEMA_VERSION ||
    data.estimator_version !== DECKSMITH_CAPACITY_ESTIMATOR_VERSION ||
    data.capacity_unit !== DECKSMITH_CAPACITY_UNIT ||
    typeof data.capacity_profile_version !== 'string' ||
    data.capacity_profile_version.length === 0 ||
    !positiveInteger(data.guaranteed_input_capacity) ||
    !positiveInteger(data.reserved_output_capacity) ||
    data.estimated_input !== estimatedInput
  ) {
    throw new DecksmithCapacityDiscoveryError('Decksmith capacity response is invalid', false);
  }
  return {
    capacityProfileVersion: data.capacity_profile_version,
    estimatorVersion: data.estimator_version,
    capacityUnit: data.capacity_unit,
    guaranteedInputCapacity: data.guaranteed_input_capacity,
    reservedOutputCapacity: data.reserved_output_capacity,
    estimatedInput,
    provenance: { kind: 'model-service' },
  };
}

function fallbackGuarantee(measure: DecksmithCapacityInputMeasure): CapacityGuarantee {
  return {
    capacityProfileVersion: DECKSMITH_CAPACITY_FALLBACK_VERSION,
    estimatorVersion: DECKSMITH_CAPACITY_ESTIMATOR_VERSION,
    capacityUnit: DECKSMITH_CAPACITY_UNIT,
    guaranteedInputCapacity: FALLBACK_GUARANTEED_INPUT_CAPACITY,
    reservedOutputCapacity: FALLBACK_RESERVED_OUTPUT_CAPACITY,
    estimatedInput: deterministicEstimate(measure),
    provenance: {
      kind: 'conservative-fallback',
      fallbackVersion: DECKSMITH_CAPACITY_FALLBACK_VERSION,
    },
  };
}

function readCapacityBands(env: ReachDeckModelEnv | RuntimeEnv) {
  const approaching = percentage(env.AI_RUNTIME_DECKSMITH_CAPACITY_APPROACHING_PERCENT, 65);
  const needsCompaction = percentage(env.AI_RUNTIME_DECKSMITH_CAPACITY_COMPACTION_PERCENT, 80);
  const blocked = percentage(env.AI_RUNTIME_DECKSMITH_CAPACITY_BLOCKED_PERCENT, 90);
  if (!(approaching < needsCompaction && needsCompaction < blocked)) {
    throw new Error('Decksmith capacity bands must be strictly increasing');
  }
  return { approaching, needsCompaction, blocked };
}

function percentage(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('Decksmith capacity band is invalid');
  }
  return parsed;
}

function percentageThreshold(capacity: number, percent: number): number {
  return Math.ceil((capacity * percent) / 100);
}

function deterministicEstimate(measure: DecksmithCapacityInputMeasure): number {
  const estimate =
    measure.serializedInputUtf8Bytes + measure.structuralItemCount * STRUCTURAL_ITEM_ESTIMATE;
  if (!Number.isSafeInteger(estimate)) throw new Error('Decksmith capacity estimate is unsafe');
  return estimate;
}

function validateMeasure(measure: DecksmithCapacityInputMeasure): void {
  if (
    !Number.isSafeInteger(measure.serializedInputUtf8Bytes) ||
    measure.serializedInputUtf8Bytes < 0 ||
    !Number.isSafeInteger(measure.structuralItemCount) ||
    measure.structuralItemCount < 0 ||
    !/^[a-f0-9]{64}$/.test(measure.digest)
  ) {
    throw new Error('Decksmith capacity input measure is invalid');
  }
}

function resolveCapacityEndpoint(env: ReachDeckModelEnv): string {
  const raw = env.REACHANY_MODEL_BASE_URL?.trim();
  if (!raw) throw new Error('REACHANY_MODEL_BASE_URL is required for Decksmith capacity discovery');
  const base = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('REACHANY_MODEL_BASE_URL must use HTTP or HTTPS');
  }
  const prefix = base.pathname
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/, '')
    .replace(/\/v1$/, '');
  base.pathname = `${prefix}/api/v1/reach-deck/model-capacity-estimates`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

function resolveCapacityDiscoveryTimeoutMs(env: ReachDeckModelEnv): number {
  const raw = env.AI_RUNTIME_DECKSMITH_CAPACITY_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_CAPACITY_DISCOVERY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CAPACITY_DISCOVERY_TIMEOUT_MS) {
    throw new Error(
      `AI_RUNTIME_DECKSMITH_CAPACITY_TIMEOUT_MS must be between 1 and ${MAX_CAPACITY_DISCOVERY_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

function isCapacityTransportUnavailable(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted && signal.reason instanceof DOMException) {
    return signal.reason.name === 'TimeoutError';
  }
  if (!(error instanceof TypeError)) return false;
  const cause = error.cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && NETWORK_UNAVAILABLE_CODES.has(code);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecksmithCapacityDiscoveryError(
      'Decksmith capacity response shape is invalid',
      false,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw new DecksmithCapacityDiscoveryError(
      'Decksmith capacity response fields are invalid',
      false,
    );
  }
  return record;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
