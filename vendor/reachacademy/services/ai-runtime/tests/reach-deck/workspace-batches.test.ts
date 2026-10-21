import { describe, expect, it } from 'vitest';

import {
  buildReachDeckBatchCoordinatorJobPayload,
  buildReachDeckWorkspaceBatchId,
  MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES,
  parseReachDeckBatchCoordinatorJobPayload,
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  ReachDeckWorkspaceBatchCapacityError,
  parseReachDeckWorkspaceBatches,
  parseReachDeckWorkspaceBatchRequests,
  reachDeckRegenerationMemberMetadata,
  retainRecentReachDeckWorkspaceBatches,
  type ReachDeckWorkspaceBatch,
} from '../../lib/reach-deck/workspace-batches.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const NOW = '2026-09-13T08:00:00.000Z';
const scope = {
  ...TEST_REACH_DECK_SCOPE,
  actorOrganizationId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
};

describe('Reach Deck workspace batches', () => {
  it('keeps the image-only stage explicitly tagged as image', () => {
    const member = narrationBatch().members[0]!;
    member.regeneration = {
      stage: 'image',
      plan: {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'failed',
        audioAnimationMode: 'preserve',
      },
    };
    expect(reachDeckRegenerationMemberMetadata(member)).toEqual({
      generationKind: 'page-generation',
      affectedLanes: ['image'],
    });
  });

  it('round trips mixed imported native narration policies without changing legacy members', () => {
    const original = narrationBatch();
    const batch = {
      ...original,
      sourceKind: 'materialized-native',
      members: original.members.map((member, index) => ({
        ...member,
        sourceKind: 'materialized-native',
        narrationMode: index === 0 ? 'saved-content' : 'regenerate-text',
        animationMode: 'regenerate',
        ...(index === 0 ? { contentDigest: 'b'.repeat(64) } : {}),
      })),
    };
    expect(parseReachDeckWorkspaceBatches({ [batch.batchId]: batch })[batch.batchId]).toEqual(
      batch,
    );
    expect(
      parseReachDeckWorkspaceBatches({ [original.batchId]: original })[original.batchId],
    ).toEqual(original);
    // 新登记的已存讲稿成员不再携带 digest，派发时按当前讲稿生成。
    const withoutDigest = {
      ...batch,
      members: [{ ...batch.members[0]!, contentDigest: undefined }],
    };
    expect(
      parseReachDeckWorkspaceBatches({ [batch.batchId]: withoutDigest })[batch.batchId]!.members[0],
    ).not.toHaveProperty('contentDigest');
    expect(() =>
      parseReachDeckWorkspaceBatches({
        [batch.batchId]: {
          ...batch,
          members: [{ ...batch.members[0], narrationMode: 'regenerate-text' }],
        },
      }),
    ).toThrow(/contentDigest is invalid/);
  });
  it('round trips text-only native narration members and rejects incompatible combinations', () => {
    const original = narrationBatch();
    const batch = {
      ...original,
      sourceKind: 'materialized-native' as const,
      members: original.members.map((member) => ({
        ...member,
        sourceKind: 'materialized-native' as const,
        attempt: 1,
        textOnly: true as const,
      })),
    };
    expect(parseReachDeckWorkspaceBatches({ [batch.batchId]: batch })[batch.batchId]).toEqual(
      batch,
    );
    const withMember = (
      override: Record<string, unknown>,
      sourceKind: 'materialized-native' | 'workspace',
    ) => ({
      [batch.batchId]: {
        ...batch,
        sourceKind,
        members: [
          { ...batch.members[0], sourceKind, ...override },
          { ...batch.members[1], sourceKind, textOnly: undefined },
        ],
      },
    });
    for (const [override, sourceKind] of [
      [{ textOnly: false }, 'materialized-native'],
      [{ narrationMode: 'saved-content', contentDigest: 'b'.repeat(64) }, 'materialized-native'],
      [{ narrationMode: 'regenerate-text', animationMode: 'regenerate' }, 'materialized-native'],
      [{}, 'workspace'],
    ] as const) {
      expect(() =>
        parseReachDeckWorkspaceBatches(
          JSON.parse(JSON.stringify(withMember(override, sourceKind))),
        ),
      ).toThrow(/textOnly is invalid/);
    }
  });

  it('uses exactly one deterministic coordinator identity for each batch cursor', () => {
    const coordinator = buildReachDeckBatchCoordinatorJobPayload(
      TEST_REACH_DECK_SCOPE,
      '11111111-1111-4111-8111-111111111111',
      2,
      NOW,
    );

    expect(parseReachDeckBatchCoordinatorJobPayload(coordinator)).toEqual(coordinator);
    expect(coordinator.jobId).toBe('rdbc-11111111-1111-4111-8111-111111111111-2');
    expect(() => parseReachDeckBatchCoordinatorJobPayload({ ...coordinator, pass: 1 })).toThrow(
      /unsupported keys/i,
    );
  });

  it('derives a stable UUID batch identity from the complete request hash', () => {
    const first = buildReachDeckWorkspaceBatchId('a'.repeat(64));
    const replay = buildReachDeckWorkspaceBatchId('a'.repeat(64));
    const changed = buildReachDeckWorkspaceBatchId('b'.repeat(64));

    expect(replay).toBe(first);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });

  it('accepts an immutable ordered member set and rejects duplicate pages', () => {
    const batch = narrationBatch();
    expect(parseReachDeckWorkspaceBatches({ [batch.batchId]: batch })[batch.batchId]).toEqual(
      batch,
    );
    const duplicate = {
      ...batch,
      members: [batch.members[0], { ...batch.members[1], pageId: batch.members[0]!.pageId }],
    };
    expect(() => parseReachDeckWorkspaceBatches({ [batch.batchId]: duplicate })).toThrow(
      /members must be unique/i,
    );
  });

  it('requires dispatchable media identity and rejects media-only fields on narration batches', () => {
    const narration = narrationBatch();
    expect(() =>
      parseReachDeckWorkspaceBatches({
        [narration.batchId]: {
          ...narration,
          members: [{ ...narration.members[0], contentDigest: 'b'.repeat(64) }],
        },
      }),
    ).toThrow(/contentDigest is invalid/);
    expect(() =>
      parseReachDeckWorkspaceBatches({
        [narration.batchId]: {
          ...narration,
          members: [{ ...narration.members[0], animationMode: 'regenerate' }],
        },
      }),
    ).toThrow(/animationMode is invalid/);

    const media = {
      ...narration,
      kind: 'media',
      sourceKind: 'materialized-media',
      members: [
        {
          ...narration.members[0],
          sourceKind: 'materialized-native',
          intent: 'waiting-dispatch',
        },
      ],
    };
    expect(() => parseReachDeckWorkspaceBatches({ [media.batchId]: media })).toThrow(
      /contentDigest is required/,
    );
    const legacyMedia = {
      ...media,
      members: [{ ...media.members[0], contentDigest: 'b'.repeat(64) }],
    };
    expect(
      parseReachDeckWorkspaceBatches({ [media.batchId]: legacyMedia })[media.batchId]!.members[0],
    ).not.toHaveProperty('animationMode');
    expect(
      parseReachDeckWorkspaceBatches({
        [media.batchId]: {
          ...legacyMedia,
          members: [{ ...legacyMedia.members[0], animationMode: 'preserve' }],
        },
      })[media.batchId]!.members[0],
    ).toMatchObject({ animationMode: 'preserve' });
    expect(
      parseReachDeckWorkspaceBatches({
        [media.batchId]: {
          ...legacyMedia,
          members: [{ ...legacyMedia.members[0], animationMode: 'skip' }],
        },
      })[media.batchId]!.members[0],
    ).toMatchObject({ animationMode: 'skip' });
    expect(() =>
      parseReachDeckWorkspaceBatches({
        [media.batchId]: {
          ...media,
          members: [
            {
              ...media.members[0],
              contentDigest: 'b'.repeat(64),
              supersededAudioResourceId: 'audio-1',
            },
          ],
        },
      }),
    ).toThrow(/supersededAudioResourceId is invalid/);
    expect(() =>
      parseReachDeckWorkspaceBatches({
        [media.batchId]: {
          ...media,
          members: [
            {
              ...media.members[0],
              sourceKind: 'materialized-interactive',
              contentDigest: 'b'.repeat(64),
              supersededAudioResourceId: 'audio-1',
            },
          ],
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseReachDeckWorkspaceBatches({
        [media.batchId]: {
          ...media,
          members: [
            {
              ...media.members[0],
              sourceKind: 'materialized-interactive',
              contentDigest: 'b'.repeat(64),
              animationMode: 'regenerate',
            },
          ],
        },
      }),
    ).toThrow(/animationMode is invalid/);
  });

  it('enforces one active batch per kind and two active batches per run', () => {
    const first = narrationBatch();
    const second = narrationBatch('22222222-2222-4222-8222-222222222222');
    expect(() =>
      parseReachDeckWorkspaceBatches({
        [first.batchId]: first,
        [second.batchId]: second,
      }),
    ).toThrow(ReachDeckWorkspaceBatchCapacityError);
  });

  it('retains the ten newest terminal summaries', () => {
    const batches = Object.fromEntries(
      Array.from({ length: MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES + 2 }, (_, index) => {
        const suffix = String(index + 1).padStart(12, '0');
        const batch = terminalBatch(`11111111-1111-4111-8111-${suffix}`, index);
        return [batch.batchId, batch];
      }),
    );
    const retained = retainRecentReachDeckWorkspaceBatches(batches);
    expect(Object.keys(retained)).toHaveLength(MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES);
    expect(retained['11111111-1111-4111-8111-000000000001']).toBeUndefined();
    expect(retained['11111111-1111-4111-8111-000000000012']).toBeDefined();
    expect(() => parseReachDeckWorkspaceBatches(retained)).not.toThrow();
  });

  it('retains stopped compensation tombstones separately from ten terminal summaries', () => {
    const batches = Object.fromEntries(
      Array.from({ length: MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES + 2 }, (_, index) => {
        const suffix = String(index + 1).padStart(12, '0');
        const terminal = terminalBatch(`11111111-1111-4111-8111-${suffix}`, index);
        const batch =
          index < 2
            ? {
                ...terminal,
                phase: 'stopped' as const,
                stopReason: 'structural-mutation',
                terminalSummary: undefined,
              }
            : terminal;
        return [batch.batchId, batch];
      }),
    );

    const retained = retainRecentReachDeckWorkspaceBatches(batches);

    expect(Object.values(retained).filter((batch) => batch.phase === 'stopped')).toHaveLength(2);
    expect(Object.values(retained).filter((batch) => batch.phase === 'terminal')).toHaveLength(10);
    expect(() => parseReachDeckWorkspaceBatches(retained)).not.toThrow();
  });

  it('parses request tombstones without requiring the display batch to remain retained', () => {
    const requestHash = 'b'.repeat(64);
    expect(
      parseReachDeckWorkspaceBatchRequests({
        [requestHash]: {
          batchId: '11111111-1111-4111-8111-111111111111',
          runId: 'run-1',
          kind: 'narration',
          acceptedAt: NOW,
        },
      }),
    ).toEqual({
      [requestHash]: {
        batchId: '11111111-1111-4111-8111-111111111111',
        runId: 'run-1',
        kind: 'narration',
        acceptedAt: NOW,
      },
    });
  });

  it('rejects a batch larger than one MiB', () => {
    const batch = narrationBatch();
    const oversized = {
      ...batch,
      skipped: Array.from({ length: 6_000 }, (_, index) => ({
        pageId: `skipped-page-${index}`,
        order: index + batch.members.length,
        reason: 'x'.repeat(128),
      })),
    };
    expect(() => parseReachDeckWorkspaceBatches({ [batch.batchId]: oversized })).toThrow(
      ReachDeckWorkspaceBatchCapacityError,
    );
  });
});

function narrationBatch(batchId = '11111111-1111-4111-8111-111111111111'): ReachDeckWorkspaceBatch {
  return {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId,
    requestHash: 'a'.repeat(64),
    runId: 'run-1',
    owner: scope,
    kind: 'narration',
    sourceKind: 'workspace',
    createdAt: NOW,
    revision: 0,
    phase: 'preparing',
    dispatchCursor: 0,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: [
      {
        pageId: 'page-1',
        order: 0,
        sourceKind: 'workspace',
        requestKey: 'request-1',
        requestedRevision: 1,
        attempt: 2,
        intent: 'waiting-dispatch',
      },
      {
        pageId: 'page-2',
        order: 1,
        sourceKind: 'workspace',
        requestKey: 'request-2',
        requestedRevision: 1,
        attempt: 2,
        intent: 'waiting-predecessor',
      },
    ],
    skipped: [],
  };
}

function terminalBatch(batchId: string, minute: number): ReachDeckWorkspaceBatch {
  const batch = narrationBatch(batchId);
  const completedAt = new Date(Date.parse(NOW) + minute * 60_000).toISOString();
  return {
    ...batch,
    createdAt: completedAt,
    revision: 1,
    phase: 'terminal',
    dispatchCursor: batch.members.length,
    members: batch.members.map((member) => ({
      ...member,
      intent: 'dispatched' as const,
      terminalOutcome: 'completed' as const,
    })),
    terminalSummary: {
      completedAt,
      status: 'completed',
      total: batch.members.length,
      succeeded: batch.members.length,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      skipped: 0,
    },
  };
}
