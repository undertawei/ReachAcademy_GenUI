import { describe, expect, it } from 'vitest';

import {
  buildReachDeckCodeSourceDigest,
  buildReachDeckMediaCheckpointKey,
  createReachDeckMediaCheckpointStore,
  MAX_REACH_DECK_CODE_SOURCE_RECEIPT_BYTES,
  parseReachDeckMediaCheckpoint,
  parseReachDeckMediaCheckpoints,
  ReachDeckMediaCheckpointBudgetError,
  ReachDeckMediaCheckpointConflictError,
  ReachDeckMediaCheckpointOutcomeUnknownError,
  reachDeckMediaCheckpointDigest,
  reachDeckMediaCheckpointReservedBytes,
  type ReachDeckMediaCheckpointIdentity,
  type ReachDeckMediaCheckpointResult,
  type ReachDeckMediaCheckpoints,
} from '../../lib/reach-deck/media-generation-checkpoint.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const identity: ReachDeckMediaCheckpointIdentity = {
  kind: 'code-source',
  assetId: 'asset-1',
  runId: 'run-1',
  pageId: 'page-1',
  requestedRevision: 1,
  originalRequestHash: '1'.repeat(64),
  intentsDigest: '2'.repeat(64),
  capabilityDigest: '3'.repeat(64),
  modelInputDigest: '4'.repeat(64),
  promptVersion: 'diagram-code-author/v3',
  corpusDigest: '5'.repeat(64),
};
const codeIdentity = identity;
const source = (html = '<html><body>Model</body></html>'): ReachDeckMediaCheckpointResult => ({
  kind: 'code-source',
  documentHtml: html,
  scientificModel: ['Use the source-supported relationship.'],
  sourceDigest: buildReachDeckCodeSourceDigest(html, ['Use the source-supported relationship.']),
});

function fixture() {
  let values: ReachDeckMediaCheckpoints = {};
  let writes = 0;
  let failBeforeSave = false;
  let loseResponse = false;
  const store = createReachDeckMediaCheckpointStore(TEST_REACH_DECK_SCOPE, {
    async read() {
      return structuredClone(values);
    },
    async transition(update) {
      const candidate = update(structuredClone(values));
      if (failBeforeSave) {
        failBeforeSave = false;
        throw new Error('storage unavailable');
      }
      values = structuredClone(candidate);
      writes += 1;
      if (loseResponse) {
        loseResponse = false;
        throw new Error('response lost');
      }
      return structuredClone(values);
    },
  });
  return {
    store,
    values: () => values,
    writes: () => writes,
    failBeforeSave: () => {
      failBeforeSave = true;
    },
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

describe('durable code source receipts', () => {
  it('claims once and reuses completed sources without another dispatch', async () => {
    const { store } = fixture();
    expect(await store.read(identity)).toBeNull();
    await store.plan(identity);
    const first = await store.claim(identity, 'owner-1');
    expect(first.claimed).toBe(true);
    expect((await store.claim(identity, 'owner-1')).claimed).toBe(false);
    expect((await store.claim(identity, 'owner-2')).claimed).toBe(false);
    const saved = await store.complete(identity, 'owner-1', source());
    expect(await store.plan(identity)).toEqual(saved);
    expect(await store.claim(identity, 'owner-2')).toEqual({ checkpoint: saved, claimed: false });
    expect(await store.read(identity)).toEqual(saved);
  });

  it('does not treat an active competing claimant as a lost owner', async () => {
    const { store } = fixture();
    await store.plan(identity);
    const claims = await Promise.all([
      store.claim(identity, 'owner-1'),
      store.claim(identity, 'owner-2'),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect((await store.read(identity))?.state).toBe('in_flight');
    await expect(store.markOutcomeUnknown(identity, 'owner-2')).rejects.toBeInstanceOf(
      ReachDeckMediaCheckpointConflictError,
    );
    await store.complete(identity, 'owner-1', source());
  });

  it('returns an unsent claim to planned only for its owner', async () => {
    const { store } = fixture();
    await store.plan(identity);
    await store.claim(identity, 'owner-1');
    await expect(store.releaseUnsent(identity, 'owner-2')).rejects.toBeInstanceOf(
      ReachDeckMediaCheckpointConflictError,
    );
    expect((await store.releaseUnsent(identity, 'owner-1')).state).toBe('planned');
    expect((await store.claim(identity, 'owner-2')).claimed).toBe(true);
  });

  it('fences a confirmed lost owner with an explicit nonretryable unknown outcome', async () => {
    const { store } = fixture();
    await store.plan(identity);
    await store.claim(identity, 'lost-owner');
    const unknown = await store.markOutcomeUnknown(identity, 'lost-owner');
    expect(unknown.state).toBe('outcome_unknown');
    await expect(store.claim(identity, 'replacement')).rejects.toMatchObject({
      retryable: false,
      code: 'REACH_DECK_MEDIA_OUTCOME_UNKNOWN',
    });
    await expect(store.complete(identity, 'lost-owner', source())).rejects.toBeInstanceOf(
      ReachDeckMediaCheckpointOutcomeUnknownError,
    );
    // Explicit replanning must have a new request identity; read/plan never clear ambiguity.
    expect(await store.plan(identity)).toEqual(unknown);
    const next = { ...identity, originalRequestHash: '6'.repeat(64) };
    await store.plan(next);
    expect((await store.claim(next, 'replacement')).claimed).toBe(true);
  });

  it('keeps successful completion authoritative when an owner-loss notice arrives late', async () => {
    const { store } = fixture();
    await store.plan(identity);
    await store.claim(identity, 'owner');
    const completed = await store.complete(identity, 'owner', source());
    expect(await store.markOutcomeUnknown(identity, 'owner')).toEqual(completed);
  });

  it('recovers a lost successful save response by reading and idempotently completing', async () => {
    const f = fixture();
    await f.store.plan(codeIdentity);
    await f.store.claim(codeIdentity, 'owner');
    f.loseResponse();
    await expect(f.store.complete(codeIdentity, 'owner', source())).rejects.toThrow(
      'response lost',
    );
    const recovered = await f.store.read(codeIdentity);
    expect(recovered?.state).toBe('completed');
    expect(await f.store.complete(codeIdentity, 'owner', source())).toEqual(recovered);
    expect((await f.store.claim(codeIdentity, 'restarted')).claimed).toBe(false);
    await expect(
      f.store.complete(codeIdentity, 'owner', source('<html>different</html>')),
    ).rejects.toBeInstanceOf(ReachDeckMediaCheckpointConflictError);
  });

  it('never dispatches before plan/claim persistence and retains a source across render failure', async () => {
    const f = fixture();
    f.failBeforeSave();
    await expect(f.store.plan(identity)).rejects.toThrow('storage unavailable');
    expect(await f.store.read(identity)).toBeNull();
    await expect(f.store.claim(identity, 'owner')).rejects.toBeInstanceOf(
      ReachDeckMediaCheckpointConflictError,
    );
    await f.store.plan(codeIdentity);
    f.failBeforeSave();
    await expect(f.store.claim(codeIdentity, 'owner')).rejects.toThrow('storage unavailable');
    expect((await f.store.read(codeIdentity))?.state).toBe('planned');
    await f.store.claim(codeIdentity, 'owner');
    const completed = await f.store.complete(codeIdentity, 'owner', source());
    // Rendering has its own lifecycle; a rendering failure does not invalidate authored source.
    expect(await f.store.read(codeIdentity)).toEqual(completed);
    await expect(f.store.complete(codeIdentity, 'other-owner', source())).rejects.toBeInstanceOf(
      ReachDeckMediaCheckpointConflictError,
    );
  });

  it.each([
    'runId',
    'pageId',
    'requestedRevision',
    'originalRequestHash',
    'intentsDigest',
    'capabilityDigest',
    'modelInputDigest',
    'promptVersion',
    'corpusDigest',
  ] as const)('invalidates the key when %s changes', (field) => {
    const changed = {
      ...identity,
      [field]:
        field === 'requestedRevision'
          ? 2
          : field.endsWith('Digest') || field === 'originalRequestHash'
            ? 'a'.repeat(64)
            : 'changed',
    };
    expect(buildReachDeckMediaCheckpointKey(changed)).not.toBe(
      buildReachDeckMediaCheckpointKey(identity),
    );
  });

  it('canonicalizes key order and isolates code assets', () => {
    expect(reachDeckMediaCheckpointDigest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      reachDeckMediaCheckpointDigest({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(buildReachDeckMediaCheckpointKey({ ...codeIdentity, assetId: 'asset-2' })).not.toBe(
      buildReachDeckMediaCheckpointKey(codeIdentity),
    );
  });

  it('rejects tampered source, result, map identity, and unknown protocol fields', async () => {
    const f = fixture();
    await f.store.plan(codeIdentity);
    await f.store.claim(codeIdentity, 'owner');
    await f.store.complete(codeIdentity, 'owner', source());
    const key = buildReachDeckMediaCheckpointKey(codeIdentity);
    const original = f.values()[key]!;
    expect(() => parseReachDeckMediaCheckpoints({ ['a'.repeat(64)]: original })).toThrow();
    expect(() => parseReachDeckMediaCheckpoints({ [key]: { ...original, extra: true } })).toThrow();
    const corrupt = structuredClone(original);
    if (corrupt.state !== 'completed' || corrupt.result.kind !== 'code-source')
      throw new Error('fixture');
    corrupt.result.documentHtml += 'tampered';
    expect(() => parseReachDeckMediaCheckpoints({ [key]: corrupt })).toThrow();
  });

  it('rejects the retired visual-expansion checkpoint kind', () => {
    const now = '2026-09-25T00:00:00.000Z';
    expect(() =>
      parseReachDeckMediaCheckpoint({
        schemaVersion: 'reach-deck-media-checkpoint/v1',
        identity: { ...identity, kind: 'visual-expansion', assetId: undefined },
        state: 'planned',
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow('contract is invalid');
    const { assetId: _assetId, ...withoutAsset } = identity;
    expect(() => buildReachDeckMediaCheckpointKey(withoutAsset as never)).toThrow(
      'contract is invalid',
    );
  });

  it('reserves bounded output capacity before model dispatch and rejects oversized sources', async () => {
    const f = fixture();
    await f.store.plan(codeIdentity);
    expect(reachDeckMediaCheckpointReservedBytes(f.values())).toBeGreaterThan(500_000);
    for (let index = 2; index <= 7; index += 1)
      await f.store.plan({ ...codeIdentity, assetId: `asset-${index}` });
    await expect(f.store.plan({ ...codeIdentity, assetId: 'asset-8' })).rejects.toBeInstanceOf(
      ReachDeckMediaCheckpointBudgetError,
    );
    await f.store.claim(codeIdentity, 'owner');
    await expect(
      f.store.complete(
        codeIdentity,
        'owner',
        source('x'.repeat(MAX_REACH_DECK_CODE_SOURCE_RECEIPT_BYTES)),
      ),
    ).rejects.toBeInstanceOf(ReachDeckMediaCheckpointBudgetError);
    expect((await f.store.read(codeIdentity))?.state).toBe('in_flight');
  });
});
