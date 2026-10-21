import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  getMaterializedDocument: vi.fn(),
  discoverCapacity: vi.fn(),
}));

vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
}));
vi.mock('../../lib/reach-deck/decksmith/capacity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: dependencies.discoverCapacity,
}));

import {
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
  type ReachDeckDecksmithV2JobPayload,
} from '../../lib/reach-deck/contracts.js';
import {
  buildDecksmithFrozenContextDigest,
  buildDecksmithV2RequestIdentity,
  deterministicCompactionRunId,
  prepareDecksmithTurn,
  rehydrateDecksmithV2Input,
} from '../../lib/reach-deck/decksmith/execution-context.js';
import {
  buildDecksmithDocumentHash,
  buildStagedGenerationRequestHash,
} from '../../lib/reach-deck/job-identity.js';
import {
  DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_LIMITS,
  parseDecksmithFrozenRunInput,
} from '../../lib/reach-deck/decksmith/page-stream-contracts.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import { DecksmithPageStreamService } from '../../lib/reach-deck/decksmith/page-stream.js';
import { measureDecksmithModelInput } from '../../lib/reach-deck/decksmith/agent.js';
import { DECKSMITH_PROMPT_CONTRACT_VERSION } from '../../lib/reach-deck/decksmith/prompt-contract-version.js';
import {
  capacityState,
  deterministicCapacityMeasure,
} from '../../lib/reach-deck/decksmith/capacity.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { buildDecksmithResultEventPayload } from '../../lib/teacher-deck-runtime.js';
import { buildDecksmithClarificationQuestionId } from '../../lib/reach-deck/decksmith/clarification.js';

const frozenAuthorization = {
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  baselineContentDigest: 'sha256:authoritative-materialization',
} as const;

describe('Decksmith frozen v2 execution context', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    dependencies.getMaterializedDocument.mockReset();
    dependencies.discoverCapacity.mockReset().mockImplementation(async ({ measure }) => {
      const estimatedInput = measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16;
      const state =
        estimatedInput >= 86_400
          ? 'blocked'
          : estimatedInput >= 76_800
            ? 'needs_compaction'
            : estimatedInput >= 62_400
              ? 'approaching'
              : 'ordinary';
      return {
        schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1',
        capacityProfileVersion: 'test-profile-96k',
        estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
        capacityUnit: 'model-token-upper-bound',
        guaranteedInputCapacity: 96_000,
        reservedOutputCapacity: 16_384,
        estimatedInput,
        thresholds: { approaching: 62_400, needsCompaction: 76_800, blocked: 86_400 },
        state,
        messageKey: `reachDeck.decksmith.capacity.${
          state === 'needs_compaction' ? 'compacting' : state
        }`,
        provenance: { kind: 'model-service' },
        inputMeasure: measure,
      };
    });
  });

  it('counts system and tool overhead in all three capacity transitions', () => {
    const document = validSlideDocument('Capacity overhead');
    const prompt = 'Short request';
    const raw = deterministicCapacityMeasure(prompt, 0);
    const exact = measureDecksmithModelInput({
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      prompt,
      document,
      pageId: document.pages[0]!.pageId,
    });
    const rawEstimate = raw.serializedInputUtf8Bytes;
    const exactEstimate = exact.serializedInputUtf8Bytes + exact.structuralItemCount * 16;
    expect(exactEstimate).toBeGreaterThan(rawEstimate + 3);

    const bands = [
      {
        expected: 'approaching',
        thresholds: {
          approaching: rawEstimate + 1,
          needsCompaction: exactEstimate + 1,
          blocked: exactEstimate + 2,
        },
      },
      {
        expected: 'needs_compaction',
        thresholds: {
          approaching: rawEstimate + 1,
          needsCompaction: rawEstimate + 2,
          blocked: exactEstimate + 1,
        },
      },
      {
        expected: 'blocked',
        thresholds: {
          approaching: rawEstimate + 1,
          needsCompaction: rawEstimate + 2,
          blocked: rawEstimate + 3,
        },
      },
    ] as const;
    for (const band of bands) {
      expect(capacityState(rawEstimate, band.thresholds)).toBe('ordinary');
      expect(capacityState(exactEstimate, band.thresholds)).toBe(band.expected);
    }
  });

  it('requires exact active lease ownership before authoritative rehydration', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
      billingGroupId: undefined,
    };
    const document = validSlideDocument('Frozen worker baseline');
    const pageId = document.pages[0]!.pageId;
    const prepared = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Keep this prompt only in the Runtime run',
      idempotencyKey: 'rehydration-key',
      document,
    });
    expect(prepared.frozenInput.schemaVersion).toBe('reach-deck-decksmith-frozen-run-input/v2');
    expect(prepared.frozenInput.scientificContextSnapshot?.policy).toBe('normal');
    dependencies.discoverCapacity.mockRejectedValueOnce(
      new Error('exact replay must not rediscover capacity'),
    );
    await expect(
      prepareDecksmithTurn({
        ...frozenAuthorization,
        store,
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId,
        prompt: 'Keep this prompt only in the Runtime run',
        idempotencyKey: 'rehydration-key',
        document,
        existingRunId: prepared.run.id,
      }),
    ).resolves.toMatchObject({ created: false, run: { id: prepared.run.id } });
    expect(dependencies.discoverCapacity).toHaveBeenCalledOnce();
    const requestHash = buildDecksmithV2RequestIdentity({
      idempotencyKey: 'rehydration-key',
      billingGroupId: actor.billingGroupId ?? null,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      frozenInput: prepared.frozenInput,
    });
    expect(
      buildDecksmithV2RequestIdentity({
        idempotencyKey: 'rehydration-key',
        billingGroupId: actor.billingGroupId ?? null,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        frozenInput: {
          ...prepared.frozenInput,
          authorization: {
            ...prepared.frozenInput.authorization,
            roleGrantId: '88888888-8888-4888-8888-888888888888',
          },
        },
      }),
    ).not.toBe(requestHash);
    expect(
      buildDecksmithV2RequestIdentity({
        idempotencyKey: 'rehydration-key',
        billingGroupId: actor.billingGroupId ?? null,
        resourceScope: {
          ...TEST_REACH_DECK_RESOURCE_SCOPE,
          courseId: '88888888-8888-4888-8888-888888888888',
        },
        frozenInput: {
          ...prepared.frozenInput,
          resourceScope: {
            ...TEST_REACH_DECK_RESOURCE_SCOPE,
            courseId: '88888888-8888-4888-8888-888888888888',
          },
        },
      }),
    ).not.toBe(requestHash);
    const payload: ReachDeckDecksmithV2JobPayload = {
      schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: 'decksmith-v2-frozen-worker',
      runId: 'decksmith-run-v2-frozen-worker',
      runtimeRunId: prepared.run.id,
      threadId: prepared.threadId,
      requestHash,
      baseDocumentHash: buildDecksmithDocumentHash(document),
      contextDigest: buildStagedGenerationRequestHash(prepared.frozenInput),
      actorId: actor.subject,
      billingGroupId: null,
      roleGrantId: '99999999-9999-4999-8999-999999999999',
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    };
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: true,
      contentDigest: frozenAuthorization.baselineContentDigest,
      learnerDocument: document,
    });

    await expect(rehydrateDecksmithV2Input(payload, store)).rejects.toMatchObject({
      code: 'DECKSMITH_FROZEN_CONTEXT_STALE',
      message: 'Decksmith execution lease is stale',
    });
    expect(dependencies.getMaterializedDocument).not.toHaveBeenCalled();

    await store.acquireDecksmithDeckLease({
      threadId: prepared.threadId,
      scope: { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId },
      ownerRunId: prepared.run.id,
      ownerRequestKey: 'rehydration-lease',
    });
    await expect(
      rehydrateDecksmithV2Input(
        {
          ...payload,
          resourceScope: {
            ...payload.resourceScope,
            courseId: '88888888-8888-4888-8888-888888888888',
          },
        },
        store,
      ),
    ).rejects.toMatchObject({
      code: 'DECKSMITH_FROZEN_CONTEXT_STALE',
      message: 'Decksmith frozen context digest is stale',
    });
    expect(dependencies.getMaterializedDocument).not.toHaveBeenCalled();

    await expect(
      rehydrateDecksmithV2Input(
        {
          ...payload,
          roleGrantId: '88888888-8888-4888-8888-888888888888',
        },
        store,
      ),
    ).rejects.toMatchObject({
      code: 'DECKSMITH_FROZEN_CONTEXT_STALE',
      message: 'Decksmith frozen context digest is stale',
    });
    expect(dependencies.getMaterializedDocument).not.toHaveBeenCalled();

    const rehydrated = await rehydrateDecksmithV2Input(payload, store);
    expect(rehydrated).toEqual({
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      prompt: prepared.frozenInput.message,
      document,
      pageId,
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      scientificContextSnapshot: prepared.frozenInput.scientificContextSnapshot,
      promptContractVersion: DECKSMITH_PROMPT_CONTRACT_VERSION,
      // Ordinary capacity is not carried into the rehydrated input.
      ...(prepared.frozenInput.capacity?.state === 'ordinary'
        ? {}
        : { capacity: prepared.frozenInput.capacity }),
    });
    expect(prepared.frozenInput.capacity?.inputMeasure).toEqual(
      measureDecksmithModelInput(rehydrated),
    );

    // Teacher page saves may land beside a queued turn: the worker starts from the current deck.
    const changed = structuredClone(document);
    changed.pages[0]!.revision += 1;
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: true,
      contentDigest: 'sha256:different-authoritative-materialization',
      learnerDocument: changed,
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await expect(rehydrateDecksmithV2Input(payload, store)).resolves.toMatchObject({
        document: changed,
      });
    } finally {
      info.mockRestore();
    }

    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: false,
    });
    await expect(rehydrateDecksmithV2Input(payload, store)).rejects.toMatchObject({
      code: 'DECKSMITH_FROZEN_CONTEXT_STALE',
    });
  });

  it('carries the frozen origin-page media status into the rehydrated agent input', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
      billingGroupId: undefined,
    };
    const document = validSlideDocument('Media status baseline');
    const pageId = document.pages[0]!.pageId;
    const mediaStatus = {
      schemaVersion: 'reach-deck-decksmith-page-media-status/v1' as const,
      pageId,
      narration: 'generating' as const,
      audio: 'generating' as const,
      animation: 'generating' as const,
      reasonCode: 'narration-generating',
    };
    const prepared = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: '修改本页讲稿',
      idempotencyKey: 'media-status-key',
      document,
      mediaStatus,
    });
    expect(prepared.frozenInput.mediaStatus).toEqual(mediaStatus);
    const payload: ReachDeckDecksmithV2JobPayload = {
      schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: 'decksmith-v2-media-status',
      runId: 'decksmith-run-v2-media-status',
      runtimeRunId: prepared.run.id,
      threadId: prepared.threadId,
      requestHash: buildDecksmithV2RequestIdentity({
        idempotencyKey: 'media-status-key',
        billingGroupId: null,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        frozenInput: prepared.frozenInput,
      }),
      baseDocumentHash: buildDecksmithDocumentHash(document),
      contextDigest: buildStagedGenerationRequestHash(prepared.frozenInput),
      actorId: actor.subject,
      billingGroupId: null,
      roleGrantId: frozenAuthorization.roleGrantId,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    };
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: true,
      contentDigest: frozenAuthorization.baselineContentDigest,
      learnerDocument: document,
    });
    await store.acquireDecksmithDeckLease({
      threadId: prepared.threadId,
      scope: { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId },
      ownerRunId: prepared.run.id,
      ownerRequestKey: 'media-status-lease',
    });

    const rehydrated = await rehydrateDecksmithV2Input(payload, store);
    // 漏传时 V2 主路径上"生成中禁止改讲稿/音频/动画"的锁与提示词说明都会失效。
    expect(rehydrated.mediaStatus).toEqual(mediaStatus);
    expect(prepared.frozenInput.capacity?.inputMeasure).toEqual(
      measureDecksmithModelInput(rehydrated),
    );
  });

  it('trims optional scientific examples before freezing the measured context', async () => {
    const defaultDiscovery = dependencies.discoverCapacity.getMockImplementation()!;
    dependencies.discoverCapacity.mockImplementationOnce(async (options) => {
      const value = await defaultDiscovery(options);
      return {
        ...value,
        state: 'blocked',
        messageKey: 'reachDeck.decksmith.capacity.blocked',
        guaranteedInputCapacity: value.estimatedInput + 1000,
        thresholds: {
          approaching: value.estimatedInput - 500,
          needsCompaction: value.estimatedInput - 100,
          blocked: value.estimatedInput - 1,
        },
      };
    });
    const document = validSlideDocument('Scientific context trimming');
    const prepared = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store: new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' }),
      actor: {
        subject: '11111111-1111-4111-8111-111111111111',
        orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
        roles: ['teacher'],
      },
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId: document.pages[0]!.pageId,
      prompt: 'circle midpoint free exploration',
      idempotencyKey: 'scientific-trim',
      document,
    });
    expect(prepared.frozenInput.scientificContextSnapshot?.exampleVersions).toEqual([]);
    expect(prepared.frozenInput.capacity?.state).toBe('ordinary');
    expect(prepared.frozenInput.capacity?.inputMeasure.digest).not.toBe(
      dependencies.discoverCapacity.mock.calls[0]![0].measure.digest,
    );
    expect(prepared.frozenInput.capacity?.inputMeasure).toEqual(
      measureDecksmithModelInput({
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document,
        pageId: document.pages[0]!.pageId,
        prompt: prepared.frozenInput.message,
        scientificContextSnapshot: prepared.frozenInput.scientificContextSnapshot,
        promptContractVersion: DECKSMITH_PROMPT_CONTRACT_VERSION,
      }),
    );
  });

  it('keeps the frozen context blocked when removing optional guidance cannot fit the guarantee', async () => {
    const defaultDiscovery = dependencies.discoverCapacity.getMockImplementation()!;
    dependencies.discoverCapacity.mockImplementationOnce(async (options) => ({
      ...(await defaultDiscovery(options)),
      state: 'blocked',
      messageKey: 'reachDeck.decksmith.capacity.blocked',
      guaranteedInputCapacity: 100,
      thresholds: { approaching: 65, needsCompaction: 80, blocked: 90 },
    }));
    const document = validSlideDocument('No scientific context budget');
    const prepared = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store: new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' }),
      actor: {
        subject: '11111111-1111-4111-8111-111111111111',
        orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
        roles: ['teacher'],
      },
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId: document.pages[0]!.pageId,
      prompt: 'circle midpoint free exploration',
      idempotencyKey: 'scientific-no-budget',
      document,
    });
    expect(prepared.frozenInput.scientificContextSnapshot?.exampleVersions).toEqual([]);
    expect(prepared.frozenInput.scientificContextSnapshot?.referenceVersions).toEqual([]);
    expect(prepared.frozenInput.capacity).toMatchObject({
      state: 'blocked',
      guaranteedInputCapacity: 100,
    });
    expect(prepared.frozenInput.capacity?.inputMeasure).toEqual(
      measureDecksmithModelInput({
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document,
        pageId: document.pages[0]!.pageId,
        prompt: prepared.frozenInput.message,
        scientificContextSnapshot: prepared.frozenInput.scientificContextSnapshot,
        promptContractVersion: DECKSMITH_PROMPT_CONTRACT_VERSION,
      }),
    );
  });

  it('replays and rehydrates an authentic frozen v1 run with its original identities', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Frozen v1 baseline');
    const pageId = document.pages[0]!.pageId;
    const seed = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Keep this legacy prompt',
      idempotencyKey: 'frozen-v1-seed',
      document,
    });
    const {
      voiceSelection: _voiceSelection,
      scientificContextSnapshot: _scientificContext,
      projection: _projection,
      promptContractVersion: _promptContractVersion,
      ...legacyProjection
    } = seed.frozenInput;
    expect(seed.frozenInput.promptContractVersion).toBe(DECKSMITH_PROMPT_CONTRACT_VERSION);
    // 未知版本（例如更新的 API 入队、旧 worker 执行）直接拒绝，不静默退回旧提示词。
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...seed.frozenInput,
        promptContractVersion: 'decksmith-prompt/v99',
      }),
    ).toThrow('Decksmith prompt contract version is invalid');
    // 真实 v1 Run 没有 projection，其 includedRunRange.digest 按 v1 投影形状计算。
    const rawV1 = {
      ...legacyProjection,
      schemaVersion: DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION,
      includedRunRange: {
        ...legacyProjection.includedRunRange,
        digest: createHash('sha256')
          .update(JSON.stringify({ runIds: [], messages: [] }))
          .digest('hex'),
      },
    };
    const frozenV1 = parseDecksmithFrozenRunInput(rawV1);
    const requestHash = buildDecksmithV2RequestIdentity({
      idempotencyKey: 'frozen-v1-replay',
      billingGroupId: null,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      frozenInput: frozenV1,
    });
    const legacyRequestHash = buildStagedGenerationRequestHash({
      version: 2,
      clientIdempotencyKey: 'frozen-v1-replay',
      billingGroupId: null,
      roleGrantId: frozenV1.authorization.roleGrantId,
      resourceScope: frozenV1.resourceScope,
      prompt: frozenV1.message,
      baselineHash: frozenV1.baseline.documentHash,
      originPageId: frozenV1.stream.pageId,
      epoch: frozenV1.stream.epoch,
      refsContextDigest: buildStagedGenerationRequestHash(frozenV1.contextRefs),
    });
    expect(requestHash).toBe(legacyRequestHash);
    expect(buildDecksmithFrozenContextDigest(frozenV1)).toBe(
      buildStagedGenerationRequestHash(rawV1),
    );

    const created = await store.createRun({
      ...runCreation(seed.run),
      requestKey: `decksmith-turn-v2:${requestHash}`,
      input: rawV1 as never,
    });
    dependencies.discoverCapacity.mockRejectedValueOnce(
      new Error('legacy replay must not rediscover capacity'),
    );
    await expect(
      prepareDecksmithTurn({
        ...frozenAuthorization,
        store,
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId,
        prompt: frozenV1.message,
        idempotencyKey: 'frozen-v1-replay',
        document,
        existingRunId: created.run.id,
      }),
    ).resolves.toMatchObject({
      created: false,
      run: { id: created.run.id },
      contextDigest: buildStagedGenerationRequestHash(rawV1),
    });
    await expect(
      prepareDecksmithTurn({
        ...frozenAuthorization,
        store,
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId,
        prompt: frozenV1.message,
        idempotencyKey: 'frozen-v1-replay',
        document,
        voiceSelection: {
          kind: 'clone',
          grantId: '22222222-2222-4222-8222-222222222222',
          cloneId: '33333333-3333-4333-8333-333333333333',
          synthesisRevision: 1,
          courseId: TEST_REACH_DECK_RESOURCE_SCOPE.courseId,
          agentRole: 'teacher',
        },
        existingRunId: created.run.id,
      }),
    ).rejects.toMatchObject({ code: 'DECKSMITH_FROZEN_CONTEXT_STALE' });

    await store.acquireDecksmithDeckLease({
      threadId: seed.threadId,
      scope: { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId },
      ownerRunId: created.run.id,
      ownerRequestKey: 'frozen-v1-active-lease',
    });
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: true,
      contentDigest: frozenAuthorization.baselineContentDigest,
      learnerDocument: document,
    });
    const payload: ReachDeckDecksmithV2JobPayload = {
      schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: 'decksmith-frozen-v1-worker',
      runId: 'decksmith-frozen-v1-run',
      runtimeRunId: created.run.id,
      threadId: seed.threadId,
      requestHash,
      baseDocumentHash: buildDecksmithDocumentHash(document),
      contextDigest: buildDecksmithFrozenContextDigest(frozenV1),
      actorId: actor.subject,
      billingGroupId: null,
      roleGrantId: frozenV1.authorization.roleGrantId,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    };
    const rehydratedV1 = await rehydrateDecksmithV2Input(payload, store);
    expect(rehydratedV1).toMatchObject({
      prompt: frozenV1.message,
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    });
    // 旧 Run 没有提示词合同版本：执行时保持缺省，继续使用 v1 提示词与互动合同预加载。
    expect(rehydratedV1).not.toHaveProperty('promptContractVersion');
  });

  it('freezes only the newest 12 messages from the exact current epoch', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Window baseline');
    const pageId = document.pages[0]!.pageId;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    const priorRunIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const prepared = await prepareDecksmithTurn({
        ...frozenAuthorization,
        store,
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId,
        prompt: `Teacher turn ${index}`,
        idempotencyKey: `window-${index}`,
        document,
      });
      priorRunIds.push(prepared.run.id);
      await store.appendEvent(prepared.run.id, 'decksmith.result', {
        message: `Assistant turn ${index}`,
      });
    }
    const next = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Next turn',
      idempotencyKey: 'window-next',
      document,
    });

    expect(next.frozenInput.includedRunRange.runIds).toEqual(priorRunIds.slice(-6));

    const stream = await new DecksmithPageStreamService(store).pageStream(scope);
    await new DecksmithPageStreamService(store).newTopic({
      threadId: stream.threadId,
      scope,
      idempotencyKey: 'new-epoch',
    });
    const afterBoundary = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Fresh epoch',
      idempotencyKey: 'fresh-epoch',
      document,
    });
    expect(afterBoundary.frozenInput.includedRunRange.runIds).toEqual([]);
  });

  it('marks 501+ eligible turns truncated without a middle-band compaction source', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Compaction coverage boundary');
    const pageId = document.pages[0]!.pageId;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    const seed = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Seed turn',
      idempotencyKey: 'coverage-seed',
      document,
    });
    const runIds = [seed.run.id];
    for (let sequence = 2; sequence <= DECKSMITH_PAGE_STREAM_LIMITS.includedRuns; sequence += 1) {
      const created = await store.createRun({
        threadId: seed.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: seed.run.sceneVersion,
        actor,
        requestKey: `coverage-${sequence}`,
        input: {
          ...seed.frozenInput,
          message: `Turn ${sequence}`,
          stream: {
            ...seed.frozenInput.stream,
            sequence,
            contextRevision: sequence,
          },
        },
        domainScope: seed.run.domainScope,
        tokenBudget: seed.run.tokenBudget,
      });
      runIds.push(created.run.id);
    }
    const context = globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.get(
      seed.threadId,
    )!;
    globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.set(seed.threadId, {
      ...context,
      streamSequence: DECKSMITH_PAGE_STREAM_LIMITS.includedRuns,
      contextRevision: DECKSMITH_PAGE_STREAM_LIMITS.includedRuns,
    });

    const exactLimit = await store.loadDecksmithCompactionSnapshot({
      threadId: seed.threadId,
      scope,
    });
    expect(exactLimit).toMatchObject({ truncated: false });
    expect(exactLimit.items.map((item) => item.runId)).toEqual(runIds);

    const foreignEpoch = await store.createRun({
      threadId: seed.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: seed.run.sceneVersion,
      actor,
      requestKey: 'coverage-foreign-epoch',
      input: {
        ...seed.frozenInput,
        message: 'Foreign epoch',
        stream: { ...seed.frozenInput.stream, sequence: 700, epoch: 2, contextRevision: 700 },
        summaryOrCutoff: { ...seed.frozenInput.summaryOrCutoff, epoch: 2 },
      },
      domainScope: seed.run.domainScope,
      tokenBudget: seed.run.tokenBudget,
    });
    const otherPage = await new DecksmithPageStreamService(store).pageStream({
      ...scope,
      pageId: 'coverage-other-page',
    });
    const foreignPage = await store.createRun({
      threadId: otherPage.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: seed.run.sceneVersion,
      actor,
      requestKey: 'coverage-foreign-page',
      input: {
        ...seed.frozenInput,
        message: 'Foreign page',
        stream: { ...seed.frozenInput.stream, pageId: 'coverage-other-page', sequence: 1 },
        baseline: { ...seed.frozenInput.baseline, pageId: 'coverage-other-page' },
      },
      domainScope: otherPage.domainScope,
      tokenBudget: seed.run.tokenBudget,
    });
    const overflow = await store.createRun({
      threadId: seed.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: seed.run.sceneVersion,
      actor,
      requestKey: 'coverage-501',
      input: {
        ...seed.frozenInput,
        message: 'Turn 501',
        stream: {
          ...seed.frozenInput.stream,
          sequence: DECKSMITH_PAGE_STREAM_LIMITS.includedRuns + 1,
          contextRevision: DECKSMITH_PAGE_STREAM_LIMITS.includedRuns + 1,
        },
      },
      domainScope: seed.run.domainScope,
      tokenBudget: seed.run.tokenBudget,
    });
    globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.set(seed.threadId, {
      ...context,
      streamSequence: DECKSMITH_PAGE_STREAM_LIMITS.includedRuns + 1,
      contextRevision: DECKSMITH_PAGE_STREAM_LIMITS.includedRuns + 1,
    });

    const truncated = await store.loadDecksmithCompactionSnapshot({
      threadId: seed.threadId,
      scope,
    });
    expect(truncated.truncated).toBe(true);
    expect(truncated.items.map((item) => item.runId)).toEqual(runIds);
    expect(truncated.items.map((item) => item.runId)).not.toContain(overflow.run.id);
    expect(truncated.items.map((item) => item.runId)).not.toContain(foreignEpoch.run.id);
    expect(truncated.items.map((item) => item.runId)).not.toContain(foreignPage.run.id);

    const prepared = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Must fail closed before model execution',
      idempotencyKey: 'coverage-blocked-parent',
      document,
    });
    expect(prepared.frozenInput.contextPlan?.coverage).toEqual({
      truncated: true,
      eligibleRunCount: DECKSMITH_PAGE_STREAM_LIMITS.includedRuns + 1,
      contiguous: false,
    });
    expect(prepared.frozenInput.contextPlan?.compaction).toBeUndefined();

    globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.set(seed.threadId, {
      ...globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.get(seed.threadId)!,
      modelContextCutoffSequence: 2,
    });
    const afterCutoff = await store.loadDecksmithCompactionSnapshot({
      threadId: seed.threadId,
      scope,
    });
    expect(afterCutoff.truncated).toBe(false);
    expect(afterCutoff.items[0]?.runId).toBe(runIds[2]);
    expect(afterCutoff.items).toHaveLength(DECKSMITH_PAGE_STREAM_LIMITS.includedRuns);
  });

  it('excludes a failed-before-execution turn from later model context', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Failed queue context baseline');
    const pageId = document.pages[0]!.pageId;
    const failed = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'This never reached model execution',
      idempotencyKey: 'failed-before-execution',
      document,
    });
    await store.failRunQueueing(failed.run.id, {
      code: 'RUN_QUEUE_UNAVAILABLE',
      message: 'Queue unavailable',
    });
    await store.appendEvent(failed.run.id, 'run.failed', {
      code: 'RUN_QUEUE_UNAVAILABLE',
    });

    const next = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Later valid turn',
      idempotencyKey: 'after-failed-before-execution',
      document,
    });

    expect(next.frozenInput.includedRunRange.runIds).not.toContain(failed.run.id);
    expect(next.frozenInput.includedRunRange.runIds).toEqual([]);
    const snapshot = await store.loadDecksmithCompactionSnapshot({
      threadId: next.threadId,
      scope: { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId },
    });
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.items.map((item) => item.runId)).toEqual([next.run.id]);
  });

  it('applies the deterministic 60,000-byte history ceiling newest-first', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Byte window baseline');
    const pageId = document.pages[0]!.pageId;
    const older = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Older small turn',
      idempotencyKey: 'byte-window-older',
      document,
    });
    await store.appendEvent(older.run.id, 'decksmith.result', { message: 'small result' });
    const newest = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Newest large turn',
      idempotencyKey: 'byte-window-newest',
      document,
    });
    await store.appendEvent(newest.run.id, 'decksmith.result', {
      message: 'x'.repeat(59_850),
    });

    const next = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Apply byte cutoff',
      idempotencyKey: 'byte-window-next',
      document,
    });

    expect(next.frozenInput.includedRunRange.runIds).toEqual([newest.run.id]);
  });

  it('atomically creates and exactly replays a frozen parent-compaction pair in memory', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Atomic compaction pair');
    const pageId = document.pages[0]!.pageId;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    const older = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Older fact',
      idempotencyKey: 'atomic-older',
      document,
    });
    await store.appendEvent(older.run.id, 'decksmith.result', { message: 'Older result' });
    await store.claimRun(older.run.id);
    await store.completeRun(older.run.id);
    const large = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Large turn',
      idempotencyKey: 'atomic-large',
      document,
    });
    await store.appendEvent(large.run.id, 'decksmith.result', { message: 'x'.repeat(70_000) });
    await store.claimRun(large.run.id);
    await store.completeRun(large.run.id);

    const prepared = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'Create the atomic pair',
      idempotencyKey: 'atomic-parent',
      document,
    });
    const childRef = prepared.frozenInput.contextPlan?.compaction;
    expect(childRef).toBeDefined();
    const child = await store.getRun(childRef!.runId);
    expect(child).toMatchObject({ id: childRef!.runId, input: { kind: 'decksmith-compaction' } });
    expect(deterministicCompactionRunId(child!.input)).toBe(child!.id);

    const replay = await store.createDecksmithPageTurn({
      threadId: prepared.threadId,
      scope,
      run: runCreation(prepared.run),
      compaction: { id: child!.id, run: runCreation(child!) },
    });
    expect(replay).toMatchObject({
      created: false,
      run: { id: prepared.run.id },
      compactionRun: { id: child!.id },
    });

    const beforeInvalidPair = await store.listThreadRuns(prepared.threadId);
    const nextFrozen = {
      ...prepared.frozenInput,
      message: 'Must not enqueue parent after child validation fails',
      stream: {
        ...prepared.frozenInput.stream,
        sequence: prepared.frozenInput.stream.sequence + 1,
        contextRevision: prepared.frozenInput.stream.contextRevision + 1,
      },
    };
    await expect(
      store.createDecksmithPageTurn({
        threadId: prepared.threadId,
        scope,
        run: {
          ...runCreation(prepared.run),
          requestKey: 'atomic-invalid-child',
          input: nextFrozen,
        },
        compaction: {
          id: child!.id,
          run: {
            ...runCreation(child!),
            actor: { ...actor, subject: '22222222-2222-4222-8222-222222222222' },
          },
        },
      }),
    ).rejects.toThrow(/compaction pair/i);
    expect(await store.listThreadRuns(prepared.threadId)).toEqual(beforeInvalidPair);

    await store.appendEvent(prepared.run.id, 'decksmith.result', { message: 'y'.repeat(70_000) });
    await store.claimRun(prepared.run.id);
    await store.completeRun(prepared.run.id);
    const beforeParentFailure = await store.listThreadRuns(prepared.threadId);
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new Error('injected parent construction failure');
    });
    try {
      await expect(
        prepareDecksmithTurn({
          ...frozenAuthorization,
          store,
          actor,
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          pageId,
          prompt: 'No orphan child may escape',
          idempotencyKey: 'atomic-parent-failure',
          document,
        }),
      ).rejects.toThrow(/injected parent construction failure/i);
    } finally {
      uuid.mockRestore();
    }
    expect(await store.listThreadRuns(prepared.threadId)).toEqual(beforeParentFailure);
  });

  it('freezes the last-good body into ordinary turns and chains a second rolling compaction', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Rolling summaries');
    const pageId = document.pages[0]!.pageId;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    await completedPreparedTurn(store, actor, document, pageId, 'fact one', 'r1');
    await completedPreparedTurn(
      store,
      actor,
      document,
      pageId,
      'fact two',
      'r2',
      'x'.repeat(70_000),
    );
    const firstParent = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'install first summary',
      idempotencyKey: 'rolling-parent-1',
      document,
    });
    const firstSummary = await installPlannedSummary(store, firstParent, scope, 'first summary');
    await store.appendEvent(firstParent.run.id, 'decksmith.result', {
      message: 'first parent completed after summary installation',
    });
    await store.claimRun(firstParent.run.id);
    await store.completeRun(firstParent.run.id);
    const ordinary = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'ordinary after summary',
      idempotencyKey: 'rolling-ordinary',
      document,
    });
    expect(ordinary.frozenInput.summaryOrCutoff).toEqual(firstSummary);
    await store.appendEvent(ordinary.run.id, 'decksmith.result', {
      message: 'y'.repeat(70_000),
    });
    await store.claimRun(ordinary.run.id);
    await store.completeRun(ordinary.run.id);
    const secondParent = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'install second summary',
      idempotencyKey: 'rolling-parent-2',
      document,
    });
    const child = await store.getRun(secondParent.frozenInput.contextPlan!.compaction!.runId);
    expect(child!.input).toMatchObject({
      previousSummaryRef: secondParent.frozenInput.contextPlan!.previousSummaryRef,
      previousSummary: firstSummary,
      source: { firstSequence: firstParent.frozenInput.stream.sequence },
    });
    expect((child!.input as unknown as { source: { runIds: string[] } }).source.runIds).toEqual(
      expect.arrayContaining([firstParent.run.id, ordinary.run.id]),
    );
    const liveContext = structuredClone(
      globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.get(secondParent.threadId)!,
    );
    await installPlannedSummary(
      store,
      secondParent,
      scope,
      'must not attach to a replaced parent summary',
      {
        beforeInstall: async () => {
          globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.set(secondParent.threadId, {
            ...liveContext,
            summary: { ...liveContext.summary!, runId: crypto.randomUUID() },
          });
        },
        expectedStatus: 'stale',
      },
    );
    globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.set(
      secondParent.threadId,
      liveContext,
    );
    const secondSummary = await installPlannedSummary(
      store,
      secondParent,
      scope,
      'first summary; ordinary fact',
    );
    expect(secondSummary.previousSummary).toMatchObject({
      runId: firstSummary.provenance!.creationRunId,
      revision: firstSummary.revision,
    });
    expect(secondSummary.source.lastSequence).toBeGreaterThan(firstSummary.source.lastSequence);
  });

  it('rejects summary installation when a durable source result mutates during provider latency', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Compaction source CAS');
    const pageId = document.pages[0]!.pageId;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    const source = await completedPreparedTurn(
      store,
      actor,
      document,
      pageId,
      'source fact',
      'cas-source',
      'x'.repeat(70_000),
    );
    const parent = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'compact with latency',
      idempotencyKey: 'cas-parent',
      document,
    });
    await installPlannedSummary(store, parent, scope, 'must stay uninstalled', {
      beforeInstall: async () => {
        await store.appendEvent(source.run.id, 'decksmith.result', {
          message: 'mutated durable result',
        });
      },
      expectedStatus: 'stale',
    });
    const stream = await new DecksmithPageStreamService(store).pageStream(scope);
    expect(stream.context.summary).toBeUndefined();
  });

  it('rolls up only before an eligible gap, retains its teacher fact raw, then resumes after retry', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Contiguous compaction');
    const pageId = document.pages[0]!.pageId;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    dependencies.discoverCapacity.mockImplementation(async ({ measure }) =>
      testCapacity(measure, 'approaching'),
    );

    const prefix = await completedPreparedTurn(
      store,
      actor,
      document,
      pageId,
      'prefix fact',
      'gap-prefix',
    );
    const gap = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'teacher fact at the interrupted turn',
      idempotencyKey: 'eligible-gap',
      document,
    });
    await store.claimRun(gap.run.id);
    await store.appendEvent(gap.run.id, 'run.started', { source: 'gap-test' });
    await store.failRun(gap.run.id, { code: 'MODEL_FAILED', message: 'interrupted' });
    const later = await completedPreparedTurn(
      store,
      actor,
      document,
      pageId,
      'later fact',
      'gap-later',
      'later assistant fact',
    );
    for (let index = 0; index < 4; index += 1) {
      await completedPreparedTurn(
        store,
        actor,
        document,
        pageId,
        `later fact ${index + 2}`,
        `gap-later-${index + 2}`,
        `later assistant fact ${index + 2}`,
      );
    }
    const firstParent = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'first rollup stops at gap',
      idempotencyKey: 'gap-rollup-1',
      document,
    });
    expect(firstParent.frozenInput.contextPlan?.compaction?.source.runIds).toEqual([prefix.run.id]);
    expect(firstParent.frozenInput.includedRunRange.runIds).toEqual(
      expect.arrayContaining([gap.run.id, later.run.id]),
    );
    const firstSummary = await installPlannedSummary(
      store,
      firstParent,
      scope,
      'prefix fact summary',
    );
    await store.appendEvent(firstParent.run.id, 'decksmith.result', {
      message: 'first rollup parent result',
    });
    await store.claimRun(firstParent.run.id);
    await store.completeRun(firstParent.run.id);

    const blockedByGap = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'do not cross the interrupted turn',
      idempotencyKey: 'gap-blocked-rollup',
      document,
    });
    expect(blockedByGap.frozenInput.contextPlan?.compaction).toBeUndefined();
    expect(blockedByGap.frozenInput.includedRunRange.runIds).toContain(gap.run.id);
    expect(blockedByGap.frozenInput.summaryOrCutoff).toEqual(firstSummary);

    await store.retryFailedRun(gap.run.id);
    await store.claimRun(gap.run.id);
    await store.appendEvent(gap.run.id, 'decksmith.result', {
      message: 'assistant recovered the interrupted teacher fact',
    });
    await store.completeRun(gap.run.id);
    await store.claimRun(blockedByGap.run.id);
    await store.appendEvent(blockedByGap.run.id, 'decksmith.result', {
      message: 'gap-safe parent completed',
    });
    await store.completeRun(blockedByGap.run.id);

    const secondParent = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'second rollup after recovery',
      idempotencyKey: 'gap-rollup-2',
      document,
    });
    expect(secondParent.frozenInput.contextPlan?.compaction?.source.runIds).toEqual(
      expect.arrayContaining([gap.run.id, later.run.id]),
    );
    expect(secondParent.frozenInput.includedRunRange.runIds).toContain(blockedByGap.run.id);
    const secondSummary = await installPlannedSummary(
      store,
      secondParent,
      scope,
      'prefix summary; teacher fact at the interrupted turn; later fact',
    );
    expect(secondSummary.source.lastSequence).toBeGreaterThan(firstSummary.source.lastSequence);

    dependencies.discoverCapacity.mockImplementation(async ({ measure }) =>
      testCapacity(measure, 'ordinary'),
    );
    const ordinary = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'ordinary after recovered rollup',
      idempotencyKey: 'gap-ordinary-after-rollup',
      document,
    });
    expect(ordinary.frozenInput.summaryOrCutoff).toMatchObject({
      text: expect.stringContaining('teacher fact at the interrupted turn'),
    });
  });

  it('freezes enqueue-time proposal outcomes so later approvals never stale a queued turn (WP1)', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = replayDocument();
    const pageId = REPLAY_PAGE_ID;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: true,
      contentDigest: frozenAuthorization.baselineContentDigest,
      learnerDocument: document,
    });
    const first = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: '只把左下角电池改成充电电池',
      idempotencyKey: 'memory-first',
      document,
      contextRefs: [heroContextRef(document)],
    });
    expect(first.frozenInput.projection).toEqual({
      projectionVersion: 2,
      proposalOutcomes: [],
      contextRefHints: [
        {
          pageId,
          componentId: 'p1-hero',
          hint: '电热水壶、风扇和左下角一节电池之间的能量转化示意图',
        },
      ],
    });
    const edited = structuredClone(document);
    const hero = edited.nativeSlides[0]!.slide.elements.find((element) => element.id === 'p1-hero');
    if (hero?.type !== 'image') throw new Error('fixture hero must be an image');
    hero.alt = '左下角换成充电电池的能量转化示意图';
    const reply = '已参考原图把左下角电池改成正在充电的充电电池，其余构图沿用原图。';
    await store.appendEvent(
      first.run.id,
      'decksmith.result',
      buildDecksmithResultEventPayload(
        {
          type: 'result',
          message: 'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。',
          assistantText: reply,
          changed: true,
          document: edited,
        },
        document,
      ).payload,
    );
    await store.appendEvent(first.run.id, 'artifact.proposed', { approvalId: 'approval-1' });
    await store.appendEvent(first.run.id, 'approval.required', { approvalId: 'approval-1' });
    await store.claimRun(first.run.id);
    await store.completeRun(first.run.id);

    const second = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: '换个思路再试一次',
      idempotencyKey: 'memory-second',
      document,
    });
    expect(second.frozenInput.projection?.proposalOutcomes).toEqual([
      { runId: first.run.id, outcome: 'pending' },
    ]);
    await store.acquireDecksmithDeckLease({
      threadId: second.threadId,
      scope,
      ownerRunId: second.run.id,
      ownerRequestKey: 'memory-second-lease',
    });
    const payload = jobPayload(second, document, 'memory-second');
    const queued = await rehydrateDecksmithV2Input(payload, store);
    expect(queued.history).toHaveLength(2);
    expect(queued.history![0]!.text).toContain(
      '(Teacher had selected: image p1-hero "电热水壶、风扇和左下角一节电池之间的能量转化示意图"',
    );
    expect(queued.history![1]!.text).toContain(reply);
    expect(queued.history![1]!.text).toContain(`image p1-hero modified`);
    expect(queued.history![1]!.text).toContain('Proposal outcome: pending');
    // 入队测算与执行时重建的输入逐字节一致。
    expect(second.frozenInput.capacity?.inputMeasure).toEqual(measureDecksmithModelInput(queued));

    // 入队后教师拒绝：已冻结的 Run 不误报 stale，仍看到入队时的事实。
    await store.appendEvent(first.run.id, 'approval.decided', {
      approvalId: 'approval-1',
      decision: 'rejected',
    });
    await expect(rehydrateDecksmithV2Input(payload, store)).resolves.toEqual(queued);

    // 下一轮入队重新读取最新结局。
    await store.appendEvent(second.run.id, 'decksmith.result', {
      message: 'Decksmith 未修改课件。',
    });
    await store.claimRun(second.run.id);
    await store.completeRun(second.run.id);
    await store.releaseDecksmithDeckLease(second.run.id);
    const third = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: '那就保持原图',
      idempotencyKey: 'memory-third',
      document,
    });
    expect(third.frozenInput.projection?.proposalOutcomes).toEqual([
      { runId: first.run.id, outcome: 'rejected' },
    ]);
    await store.acquireDecksmithDeckLease({
      threadId: third.threadId,
      scope,
      ownerRunId: third.run.id,
      ownerRequestKey: 'memory-third-lease',
    });
    const latest = await rehydrateDecksmithV2Input(
      jobPayload(third, document, 'memory-third'),
      store,
    );
    expect(latest.history![1]!.text).toContain('Proposal outcome: rejected');
    expect(latest.history![3]!.text).toBe('Decksmith 未修改课件。');
    await store.releaseDecksmithDeckLease(third.run.id);

    // 升级前已排队的 Run（无 projection）继续按 v1 重建并通过原 digest 校验。
    const {
      projection: _projection,
      promptContractVersion: _promptContractVersion,
      ...legacyInput
    } = second.frozenInput;
    const v1Messages = [
      { role: 'user', text: '只把左下角电池改成充电电池' },
      {
        role: 'assistant',
        text: 'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。',
      },
    ];
    const legacy = {
      ...legacyInput,
      includedRunRange: {
        ...legacyInput.includedRunRange,
        digest: createHash('sha256')
          .update(
            JSON.stringify({ runIds: legacyInput.includedRunRange.runIds, messages: v1Messages }),
          )
          .digest('hex'),
      },
    };
    const legacyRun = await store.createRun({
      ...runCreation(second.run),
      requestKey: 'memory-legacy-v1-projection',
      input: legacy as never,
    });
    await store.acquireDecksmithDeckLease({
      threadId: second.threadId,
      scope,
      ownerRunId: legacyRun.run.id,
      ownerRequestKey: 'memory-legacy-lease',
    });
    await expect(
      rehydrateDecksmithV2Input(
        {
          ...payload,
          runtimeRunId: legacyRun.run.id,
          contextDigest: buildDecksmithFrozenContextDigest(parseDecksmithFrozenRunInput(legacy)),
        },
        store,
      ),
    ).resolves.toMatchObject({ history: v1Messages });
  });

  it('freezes a linked answer to the latest question and marks a repeated answer duplicate (WP7)', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = replayDocument();
    const pageId = REPLAY_PAGE_ID;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: true,
      contentDigest: frozenAuthorization.baselineContentDigest,
      learnerDocument: document,
    });
    const prepare = (prompt: string, idempotencyKey: string, answersQuestionId?: string) =>
      prepareDecksmithTurn({
        ...frozenAuthorization,
        store,
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId,
        prompt,
        idempotencyKey,
        document,
        ...(answersQuestionId === undefined ? {} : { answersQuestionId }),
      });
    const complete = async (runId: string, payload: Record<string, unknown>) => {
      await store.appendEvent(runId, 'decksmith.result', payload);
      await store.claimRun(runId);
      await store.completeRun(runId);
    };
    const asking = await prepare('把图里的电池换掉', 'clarify-ask');
    const questionId = buildDecksmithClarificationQuestionId(asking.run.id);
    const question = '要改题图里的哪一节电池？';
    await complete(
      asking.run.id,
      buildDecksmithResultEventPayload(
        {
          type: 'result',
          message: 'Decksmith 需要你先回答一个问题，课件未修改。',
          changed: false,
          outcome: {
            schemaVersion: 'reach-deck-decksmith-outcome/v1',
            mutationStatus: 'none',
            rejectedFontFamilies: [],
            toolErrorCount: 0,
            clarification: {
              questionId,
              question,
              options: ['左下角', '右上角'],
              candidates: [],
              expect: 'choice',
            },
          },
        },
        document,
      ).payload,
    );

    const answer = await prepare('左下角', 'clarify-answer', questionId);
    expect(answer.frozenInput.clarificationAnswer).toEqual({
      questionId,
      status: 'answered',
      question,
    });
    // 同一幂等键重放时回答关联必须一致，否则视为冲突的冻结上下文。
    await store.acquireDecksmithDeckLease({
      threadId: answer.threadId,
      scope,
      ownerRunId: answer.run.id,
      ownerRequestKey: 'clarify-answer-lease',
    });
    await expect(
      prepareDecksmithTurn({
        ...frozenAuthorization,
        store,
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId,
        prompt: '左下角',
        idempotencyKey: 'clarify-answer',
        document,
        existingRunId: answer.run.id,
      }),
    ).rejects.toMatchObject({ code: 'DECKSMITH_FROZEN_CONTEXT_STALE' });
    const queued = await rehydrateDecksmithV2Input(
      jobPayload(answer, document, 'clarify-answer'),
      store,
    );
    expect(queued.clarificationAnswer).toEqual(answer.frozenInput.clarificationAnswer);
    expect(queued.history?.[1]?.text).toContain(`Question asked to the teacher [${questionId}]`);
    // 入队测算与执行时重建的输入逐字节一致（回答说明同样计入）。
    expect(answer.frozenInput.capacity?.inputMeasure).toEqual(measureDecksmithModelInput(queued));
    await store.releaseDecksmithDeckLease(answer.run.id);
    await complete(answer.run.id, { message: 'Decksmith 已生成修改建议。', changed: false });

    // 再次回答同一问题：不失败，冻结为 duplicate；下一轮投影里上一条教师消息链接到问题。
    const repeated = await prepare('左下角', 'clarify-repeat', questionId);
    expect(repeated.frozenInput.clarificationAnswer).toEqual({ questionId, status: 'duplicate' });
    await store.acquireDecksmithDeckLease({
      threadId: repeated.threadId,
      scope,
      ownerRunId: repeated.run.id,
      ownerRequestKey: 'clarify-repeat-lease',
    });
    const repeatedInput = await rehydrateDecksmithV2Input(
      jobPayload(repeated, document, 'clarify-repeat'),
      store,
    );
    expect(repeatedInput.history?.[2]?.text).toBe(
      `左下角\n(Answer to Decksmith question [${questionId}])`,
    );
  });

  it('corrects a summary written while a proposal was pending with a frozen outcome update', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Outcome updates');
    const pageId = document.pages[0]!.pageId;
    const scope = { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId };
    const proposal = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'retitle the slide',
      idempotencyKey: 'outcome-proposal',
      document,
    });
    await store.appendEvent(proposal.run.id, 'decksmith.result', {
      message: 'proposal ready',
      assistantText: 'Retitled the slide.',
    });
    await store.appendEvent(proposal.run.id, 'approval.required', { approvalId: 'approval-2' });
    await store.claimRun(proposal.run.id);
    await store.completeRun(proposal.run.id);
    await completedPreparedTurn(
      store,
      actor,
      document,
      pageId,
      'large turn',
      'outcome-large',
      'x'.repeat(70_000),
    );
    const parent = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'compact while pending',
      idempotencyKey: 'outcome-parent',
      document,
    });
    const child = await store.getRun(parent.frozenInput.contextPlan!.compaction!.runId);
    expect(child!.input).toMatchObject({
      projection: {
        projectionVersion: 2,
        proposalOutcomes: [{ runId: proposal.run.id, outcome: 'pending' }],
      },
    });
    // 压缩排队后才拒绝：安装仍按冻结快照校验，不误报 stale。
    await store.appendEvent(proposal.run.id, 'approval.decided', {
      approvalId: 'approval-2',
      decision: 'rejected',
    });
    await installPlannedSummary(store, parent, scope, 'teacher asked to retitle the slide', {
      proposalOutcomes: [
        {
          kind: 'decksmith-proposal-outcome',
          runId: proposal.run.id,
          sequence: proposal.frozenInput.stream.sequence,
          outcome: 'pending',
        },
      ],
    });
    await store.appendEvent(parent.run.id, 'decksmith.result', { message: 'parent done' });
    await store.claimRun(parent.run.id);
    await store.completeRun(parent.run.id);

    const next = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId,
      prompt: 'continue',
      idempotencyKey: 'outcome-next',
      document,
    });
    expect(next.frozenInput.projection?.summaryOutcomeUpdates).toEqual([
      {
        runId: proposal.run.id,
        sequence: proposal.frozenInput.stream.sequence,
        outcome: 'rejected',
      },
    ]);
    await store.acquireDecksmithDeckLease({
      threadId: next.threadId,
      scope,
      ownerRunId: next.run.id,
      ownerRequestKey: 'outcome-next-lease',
    });
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...TEST_REACH_DECK_RESOURCE_SCOPE,
      materialized: true,
      contentDigest: frozenAuthorization.baselineContentDigest,
      learnerDocument: document,
    });
    const rehydrated = await rehydrateDecksmithV2Input(
      jobPayload(next, document, 'outcome-next'),
      store,
    );
    expect(rehydrated.contextSummary).toBe(
      [
        'teacher asked to retitle the slide',
        'Outcome updates for proposals that were still pending when this summary was written:',
        `- Turn ${proposal.frozenInput.stream.sequence}: rejected; the teacher rejected these changes, so the deck does not contain them.`,
      ].join('\n'),
    );
    expect(next.frozenInput.capacity?.inputMeasure).toEqual(measureDecksmithModelInput(rehydrated));
  });

  it('validates a marked Interactive component from the exact documentHtml baseline', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = interactiveDocument(
      '<button class="primary" data-reach-component-id="launch-action">Launch</button>',
    );
    const page = document.pages[0]!;
    const contextRef = interactiveContextRef(document, {
      componentHash: buildStagedGenerationRequestHash({
        id: 'launch-action',
        type: 'button',
        html: '<button class="primary" data-reach-component-id="launch-action">Launch</button>',
      }),
    });

    const prepared = await prepareDecksmithTurn({
      ...frozenAuthorization,
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId: page.pageId,
      prompt: 'Update the marked control',
      idempotencyKey: 'interactive-marker-valid',
      document,
      contextRefs: [contextRef],
    });

    expect(prepared.frozenInput.contextRefs).toEqual([contextRef]);
  });

  it('keeps Interactive marker type, subtree hash, and uniqueness fail closed', async () => {
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const markedHtml =
      '<button class="primary" data-reach-component-id="launch-action">Launch</button>';
    const document = interactiveDocument(markedHtml);
    const componentHash = buildStagedGenerationRequestHash({
      id: 'launch-action',
      type: 'button',
      html: markedHtml,
    });
    const validRef = interactiveContextRef(document, { componentHash });
    const cases = [
      {
        name: 'forged type',
        document,
        ref: { ...validRef, componentType: 'div' },
      },
      {
        name: 'forged subtree hash',
        document,
        ref: {
          ...validRef,
          baseline: { ...validRef.baseline, componentHash: 'f'.repeat(64) },
        },
      },
      {
        name: 'unmarked element',
        document: interactiveDocument('<button id="launch-action">Launch</button>'),
        ref: validRef,
      },
      {
        name: 'duplicate marker',
        document: interactiveDocument(`${markedHtml}${markedHtml}`),
        ref: validRef,
      },
    ];

    for (const testCase of cases) {
      const exactRef = {
        ...testCase.ref,
        baseline: {
          ...testCase.ref.baseline,
          documentHash: buildDecksmithDocumentHash(testCase.document),
        },
      };
      await expect(
        prepareDecksmithTurn({
          ...frozenAuthorization,
          store: new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' }),
          actor,
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          pageId: testCase.document.pages[0]!.pageId,
          prompt: `Reject ${testCase.name}`,
          idempotencyKey: `interactive-marker-${testCase.name}`,
          document: testCase.document,
          contextRefs: [exactRef],
        }),
      ).rejects.toMatchObject({ code: 'DECKSMITH_COMPONENT_REF_STALE' });
    }
  });
});

const REPLAY_PAGE_ID = '55555555-5555-4555-8555-555555555555:page-1';

function replayDocument() {
  return JSON.parse(
    readFileSync(
      new URL('./decksmith-replay/fixtures/documents/energy-lesson.json', import.meta.url),
      'utf8',
    ),
  ) as ReachDeckDocumentV2;
}

function heroContextRef(document: ReachDeckDocumentV2) {
  const page = document.pages.find((candidate) => candidate.pageId === REPLAY_PAGE_ID)!;
  const component = document.nativeSlides
    .find((binding) => binding.pageId === REPLAY_PAGE_ID)!
    .slide.elements.find((element) => element.id === 'p1-hero')!;
  return {
    schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
    kind: 'native-element' as const,
    pageId: REPLAY_PAGE_ID,
    pageLabel: page.title,
    pageOrder: 1,
    pageRevision: page.revision,
    sceneId: REPLAY_PAGE_ID,
    sceneType: 'slide' as const,
    componentId: 'p1-hero',
    componentType: 'image',
    display: { label: 'image' },
    baseline: {
      documentId: document.id,
      documentHash: buildDecksmithDocumentHash(document),
      pageRevision: page.revision,
      componentHash: buildStagedGenerationRequestHash(component),
    },
  };
}

function jobPayload(
  prepared: Awaited<ReturnType<typeof prepareDecksmithTurn>>,
  document: ReachDeckDocumentV2,
  idempotencyKey: string,
): ReachDeckDecksmithV2JobPayload {
  return {
    schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: `decksmith-${idempotencyKey}`,
    runId: `decksmith-run-${idempotencyKey}`,
    runtimeRunId: prepared.run.id,
    threadId: prepared.threadId,
    requestHash: buildDecksmithV2RequestIdentity({
      idempotencyKey,
      billingGroupId: null,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      frozenInput: prepared.frozenInput,
    }),
    baseDocumentHash: buildDecksmithDocumentHash(document),
    contextDigest: buildDecksmithFrozenContextDigest(prepared.frozenInput),
    actorId: prepared.run.actor.subject,
    billingGroupId: null,
    roleGrantId: frozenAuthorization.roleGrantId,
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  };
}

function interactiveDocument(componentHtml: string) {
  const document = createBlankReachDeckDocument({
    id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
    title: 'Interactive baseline',
  });
  const pageId = document.pages[0]!.pageId;
  return normalizeReachDeckDocumentV2({
    ...document,
    pages: [
      {
        pageId,
        order: 1,
        revision: 1,
        sceneType: 'interactive',
        title: 'Interactive baseline',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: pageId,
          title: 'Interactive baseline',
          sceneType: 'interactive',
          documentHtml: `<!doctype html><html><head></head><body>${componentHtml}<script>window.ReachInteractive?.ready?.();</script></body></html>`,
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: {
            completionMode: 'explicit',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: {
            schemaVersion: 'reach-interactive-event-manifest/v1',
            events: [],
          },
        },
      },
    ],
    nativeSlides: [],
  });
}

async function completedPreparedTurn(
  store: MemoryRuntimeStore,
  actor: { subject: string; orgId: string; roles: string[] },
  document: ReturnType<typeof validSlideDocument>,
  pageId: string,
  prompt: string,
  idempotencyKey: string,
  assistant = `${prompt} result`,
) {
  const prepared = await prepareDecksmithTurn({
    ...frozenAuthorization,
    store,
    actor,
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    pageId,
    prompt,
    idempotencyKey,
    document,
  });
  await store.appendEvent(prepared.run.id, 'decksmith.result', { message: assistant });
  await store.claimRun(prepared.run.id);
  await store.completeRun(prepared.run.id);
  return prepared;
}

async function installPlannedSummary(
  store: MemoryRuntimeStore,
  parent: Awaited<ReturnType<typeof prepareDecksmithTurn>>,
  scope: Parameters<MemoryRuntimeStore['acquireDecksmithDeckLease']>[0]['scope'],
  text: string,
  options: {
    beforeInstall?: () => Promise<void>;
    expectedStatus?: 'installed' | 'stale';
    proposalOutcomes?: Record<string, unknown>[];
  } = {},
) {
  const childId = parent.frozenInput.contextPlan!.compaction!.runId;
  const child = (await store.getRun(childId))!;
  const compaction = child.input as unknown as {
    epoch: number;
    pageId: string;
    source: { runIds: string[]; firstSequence: number; lastSequence: number; digest: string };
    previousSummaryRef?: {
      runId: string;
      revision: number;
      sourceDigest: string;
      summaryDigest?: string;
    };
    capacity: {
      capacityProfileVersion: string;
      estimatorVersion: string;
      capacityUnit: string;
    };
    inputDigest: string;
  };
  await store.acquireDecksmithDeckLease({
    threadId: parent.threadId,
    scope,
    ownerRunId: parent.run.id,
    ownerRequestKey: parent.run.requestKey!,
  });
  await store.claimRun(childId);
  const previousDigest =
    compaction.previousSummaryRef?.summaryDigest ?? compaction.previousSummaryRef?.sourceDigest;
  const summary = {
    schemaVersion: 'reach-deck-decksmith-summary/v1' as const,
    kind: 'summary' as const,
    revision: (compaction.previousSummaryRef?.revision ?? 0) + 1,
    epoch: compaction.epoch,
    metadata: {
      pageId: compaction.pageId,
      status: 'installed' as const,
      ...(previousDigest === undefined ? {} : { previousSummaryDigest: previousDigest }),
      capacityProfileVersion: compaction.capacity.capacityProfileVersion,
      estimatorVersion: compaction.capacity.estimatorVersion,
      capacityUnit: compaction.capacity.capacityUnit,
    },
    source: {
      firstSequence: compaction.source.firstSequence,
      lastSequence: compaction.source.lastSequence,
      firstRunId: compaction.source.runIds[0]!,
      lastRunId: compaction.source.runIds.at(-1)!,
      digest: compaction.source.digest,
    },
    text,
    pageFacts: [{ fact: text }],
    unresolvedDecisions: [],
    proposalOutcomes: options.proposalOutcomes ?? [],
    ...(compaction.previousSummaryRef === undefined
      ? {}
      : {
          previousSummary: {
            runId: compaction.previousSummaryRef.runId,
            revision: compaction.previousSummaryRef.revision,
            digest: previousDigest!,
          },
        }),
    provenance: {
      creationRunId: childId,
      modelUsageDigest: 'e'.repeat(64),
      sourcePlanDigest: compaction.inputDigest,
    },
  };
  await options.beforeInstall?.();
  await expect(
    store.completeDecksmithCompaction({
      threadId: parent.threadId,
      scope,
      leaseOwnerRunId: parent.run.id,
      parentRunId: parent.run.id,
      compactionRunId: childId,
      compactionInput: child.input as never,
      summary,
    }),
  ).resolves.toMatchObject({ status: options.expectedStatus ?? 'installed' });
  await store.releaseDecksmithDeckLease(parent.run.id);
  return summary;
}

function runCreation(run: Awaited<ReturnType<MemoryRuntimeStore['getRun']>> & {}) {
  if (run === null) throw new Error('Expected Run');
  return {
    ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
    sceneKey: run.sceneKey,
    sceneVersion: run.sceneVersion,
    actor: run.actor,
    ...(run.requestKey === undefined ? {} : { requestKey: run.requestKey }),
    input: run.input,
    domainScope: run.domainScope,
    tokenBudget: run.tokenBudget,
  };
}

function testCapacity(
  measure: ReturnType<typeof deterministicCapacityMeasure>,
  state: 'ordinary' | 'approaching',
) {
  const estimatedInput = state === 'ordinary' ? 10 : 65_000;
  return {
    schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1' as const,
    capacityProfileVersion: 'test-profile-96k',
    estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
    capacityUnit: 'model-token-upper-bound',
    guaranteedInputCapacity: 96_000,
    reservedOutputCapacity: 16_384,
    estimatedInput,
    thresholds: { approaching: 62_400, needsCompaction: 76_800, blocked: 86_400 },
    state,
    messageKey: `reachDeck.decksmith.capacity.${state}`,
    provenance: { kind: 'model-service' as const },
    inputMeasure: measure,
  };
}

function validSlideDocument(title: string) {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title,
    }),
  );
  const page = document.pages[0]!;
  return normalizeReachDeckDocumentV2({
    ...document,
    pages: document.pages,
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `${document.id}:slide-1`,
          title,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
          elements: [],
          animations: [],
        },
      },
    ],
  });
}

function interactiveContextRef(
  document: ReturnType<typeof interactiveDocument>,
  input: { componentHash: string },
) {
  const page = document.pages[0]!;
  if (page.sceneType !== 'interactive' || page.scene === undefined) {
    throw new Error('Expected interactive page');
  }
  return {
    schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
    kind: 'interactive-component' as const,
    pageId: page.pageId,
    pageLabel: page.title,
    pageOrder: 1,
    pageRevision: page.revision,
    sceneId: page.scene.id,
    sceneType: 'interactive' as const,
    componentId: 'launch-action',
    componentType: 'button',
    display: { label: 'Launch' },
    baseline: {
      documentId: document.id,
      documentHash: buildDecksmithDocumentHash(document),
      pageRevision: page.revision,
      componentHash: input.componentHash,
    },
  };
}
