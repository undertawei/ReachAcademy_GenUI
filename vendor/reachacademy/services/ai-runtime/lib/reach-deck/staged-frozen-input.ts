import {
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  type ReachDeckStagedGenerationJobPayload,
} from './contracts.js';
import {
  buildStagedGenerationRequestHash,
  buildScopedStagedGenerationRequestHash,
} from './job-identity.js';
import { parseScientificContextSnapshot } from './scientific-generation-context.js';

export const REACH_DECK_STAGED_FROZEN_INPUT_SCHEMA_VERSION =
  'reach-deck-staged-frozen-run-input/v1' as const;
const MAX_FROZEN_BYTES = 3 * 1024 * 1024;

export function stagedScientificSourceRequestHash(
  payload: ReachDeckStagedGenerationJobPayload,
): string {
  return buildScopedStagedGenerationRequestHash(payload.resourceScope, {
    request: payload.request,
    voiceSelection: payload.voiceSelection,
    promptSnippetOverrides: payload.promptSnippetOverrides,
  });
}

export interface ReachDeckStagedFrozenRunInput {
  readonly schemaVersion: typeof REACH_DECK_STAGED_FROZEN_INPUT_SCHEMA_VERSION;
  readonly kind: 'reach-deck-staged';
  readonly message: string;
  readonly payload: ReachDeckStagedGenerationJobPayload;
  readonly payloadDigest: string;
}

export function freezeReachDeckStagedRunInput(
  payload: ReachDeckStagedGenerationJobPayload,
): ReachDeckStagedFrozenRunInput {
  return parseReachDeckStagedFrozenRunInput({
    schemaVersion: REACH_DECK_STAGED_FROZEN_INPUT_SCHEMA_VERSION,
    kind: 'reach-deck-staged',
    message: `Reach Deck ${payload.kind} job`,
    payload,
    payloadDigest: buildStagedGenerationRequestHash(payload),
  });
}

/** Queue validation owns request shape; this private envelope binds its exact persisted bytes. */
export function parseReachDeckStagedFrozenRunInput(value: unknown): ReachDeckStagedFrozenRunInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'kind', 'message', 'payload', 'payloadDigest'];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    input.schemaVersion !== REACH_DECK_STAGED_FROZEN_INPUT_SCHEMA_VERSION ||
    input.kind !== 'reach-deck-staged'
  )
    throw invalid();
  if (typeof input.payload !== 'object' || input.payload === null || Array.isArray(input.payload))
    throw invalid();
  const payload = input.payload as ReachDeckStagedGenerationJobPayload;
  if (
    payload.schemaVersion !== REACH_DECK_STAGED_JOB_SCHEMA_VERSION ||
    (payload.kind !== 'page-outline' &&
      !(
        payload.kind === 'page-generation' &&
        ['slide', 'interactive'].includes(payload.request.page?.sceneType)
      )) ||
    input.message !== `Reach Deck ${payload.kind} job`
  )
    throw invalid();
  const snapshot = parseScientificContextSnapshot(payload.scientificContextSnapshot);
  if (
    snapshot.stage !==
    (payload.kind === 'page-outline'
      ? 'outline'
      : payload.request.page.sceneType === 'slide'
        ? 'slide'
        : 'interactive')
  )
    throw invalid();
  if (
    input.payloadDigest !== buildStagedGenerationRequestHash(payload) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_FROZEN_BYTES
  )
    throw invalid();
  return freezeJson(structuredClone(value)) as ReachDeckStagedFrozenRunInput;
}

function freezeJson(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}

function invalid(): Error {
  const error = new Error('Reach Deck authoritative frozen staged input is missing or invalid');
  Object.assign(error, { code: 'TEACHER_DECK_FROZEN_INPUT_INVALID' });
  return error;
}
