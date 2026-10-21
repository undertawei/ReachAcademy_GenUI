import { buildReachDeckMediaResourceForObjectKey } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  type ReachDeckNarrationGenerationJobPayload,
} from '../../lib/reach-deck/contracts.js';
import {
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
  buildScopedStagedGenerationRequestHash,
} from '../../lib/reach-deck/job-identity.js';
import {
  parseCompletedStagedResult,
  stagedResultProvenanceFromPayload,
} from '../../lib/reach-deck/staged-result.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';

const narrationText = 'Move the control, then compare how the output changes.';
const audioObjectKey = 'generated/deck/page-interactive/narration.mp3';
const audioResourceId = buildReachDeckMediaResourceForObjectKey(audioObjectKey).id;
const scene = {
  schemaVersion: 'reach-interactive-scene/v2' as const,
  id: 'page-interactive',
  title: 'System explorer',
  sceneType: 'interactive' as const,
  documentHtml: '<!doctype html><html><head></head><body><button>Try</button></body></html>',
  bridgeVersion: 'reach-interactive-bridge/v1' as const,
  runtimeDependencies: [],
  runtimePolicy: {
    completionMode: 'none' as const,
    allowReset: true as const,
    maximumDurationSeconds: null,
  },
  eventManifest: {
    schemaVersion: 'reach-interactive-event-manifest/v1' as const,
    events: [],
  },
  narration: {
    schemaVersion: 'reach-interactive-narration/v1' as const,
    text: narrationText,
    audioResourceId,
  },
};
const request = {
  sourceKind: 'workspace-interactive' as const,
  runId: 'run-interactive',
  pageId: scene.id,
  requestedRevision: 2,
  attempt: 1,
  attemptReason: 'initial' as const,
  source: 'Explore a changing system.',
  page: { id: scene.id, order: 1, sceneType: 'interactive' as const, title: scene.title },
  interactiveContentDigest: buildReachDeckInteractiveContentDigest(scene),
  narrationText,
  narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
};
const payload: ReachDeckNarrationGenerationJobPayload = {
  schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  kind: 'narration-generation',
  jobId: 'job-interactive-narration',
  actorId: TEST_REACH_DECK_SCOPE.actorId,
  billingGroupId: TEST_REACH_DECK_SCOPE.billingGroupId,
  roleGrantId: TEST_REACH_DECK_SCOPE.roleGrantId,
  resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
  runId: request.runId,
  createdFromDraftRevision: 5,
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  requestHash: buildScopedStagedGenerationRequestHash(TEST_REACH_DECK_SCOPE.resourceScope, {
    request,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  }),
  request,
};
const result = {
  kind: 'narration-generation' as const,
  runId: request.runId,
  generatedFromDraftRevision: payload.createdFromDraftRevision,
  interactiveNarration: {
    interactiveContentDigest: request.interactiveContentDigest,
    narrationTextDigest: request.narrationTextDigest,
    audioObjectKey,
    artifact: {
      runId: request.runId,
      pageId: scene.id,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
      sceneType: 'interactive' as const,
      scene,
      status: 'ready' as const,
      generatedAt: '2026-09-03T00:00:00.000Z',
    },
  },
};

describe('Interactive narration durable result', () => {
  it('round-trips exact page, text, and audio provenance', () => {
    expect(parseCompletedStagedResult(result, stagedResultProvenanceFromPayload(payload))).toEqual(
      result,
    );
  });

  it.each([
    ['page digest', { interactiveContentDigest: 'c'.repeat(64) }],
    ['text digest', { narrationTextDigest: 'd'.repeat(64) }],
    ['audio object key', { audioObjectKey: 'generated/deck/other.mp3' }],
  ])('rejects a result whose %s does not match the artifact', (_label, override) => {
    expect(() =>
      parseCompletedStagedResult(
        {
          ...result,
          interactiveNarration: { ...result.interactiveNarration, ...override },
        },
        stagedResultProvenanceFromPayload(payload),
      ),
    ).toThrow(/provenance does not match/);
  });

  it('round-trips a text-only rewrite without audio and rejects mixed audio shapes', () => {
    const { audioResourceId: _audio, ...textNarration } = scene.narration;
    const textScene = { ...scene, narration: { ...textNarration, text: 'Predict first.' } };
    const textOnly = {
      ...result,
      interactiveNarration: {
        interactiveContentDigest: buildReachDeckInteractiveContentDigest(textScene),
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest('Predict first.'),
        sourceNarrationTextDigest: request.narrationTextDigest,
        sourceInteractiveContentDigest: request.interactiveContentDigest,
        textOnly: true as const,
        artifact: { ...result.interactiveNarration.artifact, scene: textScene },
      },
    };
    const provenance = stagedResultProvenanceFromPayload(payload);
    expect(parseCompletedStagedResult(textOnly, provenance)).toEqual(textOnly);
    expect(() =>
      parseCompletedStagedResult(
        { ...textOnly, interactiveNarration: { ...textOnly.interactiveNarration, audioObjectKey } },
        provenance,
      ),
    ).toThrow();
    expect(() =>
      parseCompletedStagedResult(
        {
          ...textOnly,
          interactiveNarration: {
            ...textOnly.interactiveNarration,
            artifact: { ...textOnly.interactiveNarration.artifact, scene },
          },
        },
        provenance,
      ),
    ).toThrow(/provenance does not match/);
    expect(() =>
      parseCompletedStagedResult(
        {
          ...textOnly,
          interactiveNarration: { ...textOnly.interactiveNarration, textOnly: false },
        },
        provenance,
      ),
    ).toThrow(/identity is invalid/);
  });

  it('round-trips saved speechMarkup only under the marked text digest', () => {
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 4, durationMs: 300 }],
    };
    const markedScene = { ...scene, narration: { ...scene.narration, speechMarkup } };
    const marked = {
      ...result,
      interactiveNarration: {
        ...result.interactiveNarration,
        interactiveContentDigest: buildReachDeckInteractiveContentDigest(markedScene),
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(
          narrationText,
          speechMarkup,
        ),
        artifact: { ...result.interactiveNarration.artifact, scene: markedScene },
      },
    };
    const provenance = stagedResultProvenanceFromPayload(payload);
    expect(parseCompletedStagedResult(marked, provenance)).toEqual(marked);
    expect(marked.interactiveNarration.interactiveContentDigest).not.toBe(
      request.interactiveContentDigest,
    );
    expect(() =>
      parseCompletedStagedResult(
        {
          ...marked,
          interactiveNarration: {
            ...marked.interactiveNarration,
            narrationTextDigest: request.narrationTextDigest,
          },
        },
        provenance,
      ),
    ).toThrow(/provenance does not match/);
  });
});
