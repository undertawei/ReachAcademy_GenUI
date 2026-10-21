import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { RunRecord, UsageEntry } from '../../contracts.js';
import { resolveModelServiceCallTimeoutMs } from '../../env.js';
import { getScene } from '../../scenes.js';
import type { RuntimeStore } from '../../store/store.js';
import { assertTeacherDeckBudget, recordTeacherDeckUsage } from '../../teacher-deck-runtime.js';
import {
  buildStructuredJsonModelInput,
  generateStructuredJsonWithModelService,
  type ReachDeckModelEnv,
} from '../model-service-client.js';
import { sameReachDeckPageDomainScope, sameReachDeckResourceScope } from '../resource-scope.js';
import {
  countDeterministicCapacityStructure,
  deterministicCapacityMeasureSerialized,
  estimateWithFrozenCapacity,
} from './capacity.js';
import {
  DECKSMITH_PAGE_STREAM_LIMITS,
  DECKSMITH_SUMMARY_SCHEMA_VERSION,
  parseDecksmithCompactionRunInput,
  parseDecksmithFrozenRunInput,
  parseDecksmithPageSummary,
  type DecksmithCompactionRunInput,
  type DecksmithPageSummary,
} from './page-stream-contracts.js';
import type { DecksmithPageStreamOwnerScope } from './page-stream.js';
import {
  decksmithProjectionPolicy,
  digestDecksmithSummary,
  digestDecksmithTurnProjection,
  projectCompleteDecksmithTurns,
} from './turn-projection.js';
import {
  DECKSMITH_SUMMARY_PROPOSAL_OUTCOME_KIND,
  readDecksmithSummaryProposalOutcomes,
  type DecksmithSummaryProposalOutcome,
} from './turn-memory.js';

export class DecksmithCompactionExecutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'DECKSMITH_COMPACTION_ALREADY_RUNNING'
      | 'DECKSMITH_COMPACTION_REPLAY_FORBIDDEN'
      | 'DECKSMITH_COMPACTION_OUTPUT_INVALID',
  ) {
    super(message);
    this.name = 'DecksmithCompactionExecutionError';
  }
}

const SUMMARY_CONTENT_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'pageFacts', 'unresolvedDecisions', 'proposalOutcomes'],
  properties: {
    text: { type: 'string', maxLength: DECKSMITH_PAGE_STREAM_LIMITS.summaryCharacters },
    pageFacts: {
      type: 'array',
      maxItems: DECKSMITH_PAGE_STREAM_LIMITS.factArrayEntries,
      items: { type: 'object' },
    },
    unresolvedDecisions: {
      type: 'array',
      maxItems: DECKSMITH_PAGE_STREAM_LIMITS.factArrayEntries,
      items: { type: 'object' },
    },
    proposalOutcomes: {
      type: 'array',
      maxItems: DECKSMITH_PAGE_STREAM_LIMITS.factArrayEntries,
      items: { type: 'object' },
    },
  },
} as const;

const SUMMARY_SCHEMA = {
  name: 'reach_deck_decksmith_summary',
  strict: true,
  schema: SUMMARY_CONTENT_OBJECT_SCHEMA,
} as const;

interface DecksmithSummaryContent {
  readonly text: string;
  readonly pageFacts: readonly Readonly<Record<string, unknown>>[];
  readonly unresolvedDecisions: readonly Readonly<Record<string, unknown>>[];
  readonly proposalOutcomes: readonly Readonly<Record<string, unknown>>[];
}

export async function executeDecksmithCompaction(input: {
  readonly store: RuntimeStore;
  readonly compactionRun: RunRecord;
  readonly parentRun: RunRecord;
  readonly scope: DecksmithPageStreamOwnerScope;
  readonly compactionInput: DecksmithCompactionRunInput;
  readonly signal?: AbortSignal;
  readonly env?: ReachDeckModelEnv;
  readonly fetchImpl?: typeof fetch;
}): Promise<{ readonly status: 'installed' | 'reused'; readonly summary: DecksmithPageSummary }> {
  const compactionInput = parseDecksmithCompactionRunInput(input.compactionInput);
  let current = await input.store.getRun(input.compactionRun.id);
  if (current === null) throw new Error('Decksmith compaction Run is unavailable');
  if (current.status === 'running') {
    const recovery = await input.store.recoverStaleDecksmithCompactionRun(
      current.id,
      decksmithCompactionRecoveryAgeMs(input.env),
    );
    current = await input.store.getRun(current.id);
    if (current === null) throw new Error('Decksmith compaction Run disappeared during recovery');
    if (recovery.status === 'terminalized') {
      throw new DecksmithCompactionExecutionError(
        'Stale Decksmith compaction was terminalized after provider work began',
        'DECKSMITH_COMPACTION_REPLAY_FORBIDDEN',
      );
    }
  }
  if (current.status === 'completed') {
    const stored = await input.store.loadDecksmithSummary({
      threadId: input.parentRun.threadId ?? compactionInput.threadId,
      scope: input.scope,
      ref: {
        schemaVersion: 'reach-deck-decksmith-summary-ref/v1',
        kind: 'summary-ref',
        runId: current.id,
        revision: (compactionInput.previousSummaryRef?.revision ?? 0) + 1,
        epoch: compactionInput.epoch,
        sourceDigest: compactionInput.source.digest,
      },
    });
    if (stored !== null) return { status: 'reused', summary: stored.summary };
    throw new DecksmithCompactionExecutionError(
      'Completed Decksmith compaction has no durable summary',
      'DECKSMITH_COMPACTION_REPLAY_FORBIDDEN',
    );
  }
  if (current.status === 'failed') {
    const [usage, attempts] = await Promise.all([
      input.store.runUsageTokens(current.id),
      input.store.listEventsByTypes(current.id, ['decksmith.compaction.provider-attempt']),
    ]);
    if (
      usage !== 0 ||
      attempts.length !== 0 ||
      current.error?.code !== 'DECKSMITH_COMPACTION_MODEL_FAILED'
    ) {
      throw new DecksmithCompactionExecutionError(
        'Decksmith compaction cannot be replayed after provider execution',
        'DECKSMITH_COMPACTION_REPLAY_FORBIDDEN',
      );
    }
    current = await input.store.retryFailedRun(current.id);
    if (current === null) {
      throw new DecksmithCompactionExecutionError(
        'Decksmith compaction retry state changed',
        'DECKSMITH_COMPACTION_REPLAY_FORBIDDEN',
      );
    }
    await input.store.appendEvent(current.id, 'decksmith.compaction.retrying', {
      sourceDigest: compactionInput.source.digest,
    });
  }
  if (current.status !== 'queued') {
    throw new DecksmithCompactionExecutionError(
      'Decksmith compaction cannot be replayed after execution started',
      current.status === 'running'
        ? 'DECKSMITH_COMPACTION_ALREADY_RUNNING'
        : 'DECKSMITH_COMPACTION_REPLAY_FORBIDDEN',
    );
  }
  const claimed = await input.store.claimRun(current.id);
  if (claimed === null)
    throw new DecksmithCompactionExecutionError(
      'Decksmith compaction claim lost',
      'DECKSMITH_COMPACTION_ALREADY_RUNNING',
    );
  try {
    assertDecksmithCompactionScope(input, compactionInput, claimed);
    await input.store.appendEvent(claimed.id, 'decksmith.compaction.running', {
      sourceDigest: compactionInput.source.digest,
      capacityProfileVersion: compactionInput.capacity.capacityProfileVersion,
      estimatorVersion: compactionInput.capacity.estimatorVersion,
    });
    const previousSummary = await resolvePreviousSummary(input, compactionInput);
    const snapshot = await input.store.loadDecksmithFrozenHistory({
      threadId: compactionInput.threadId,
      scope: input.scope,
      runIds: compactionInput.source.runIds,
    });
    // 按压缩输入冻结的投影版本与结局快照重建（旧输入无 projection 即 v1）。
    const projectionPolicy = decksmithProjectionPolicy(compactionInput.projection);
    const transcript = projectCompleteDecksmithTurns(
      snapshot,
      compactionInput.epoch,
      projectionPolicy,
    );
    const sourceDigest = digestDecksmithTurnProjection(
      transcript,
      compactionInput.previousSummaryRef?.summaryDigest,
      projectionPolicy.projectionVersion,
    );
    if (
      sourceDigest !== compactionInput.source.digest ||
      JSON.stringify(transcript.map((turn) => turn.runId)) !==
        JSON.stringify(compactionInput.source.runIds) ||
      transcript[0]?.sequence !== compactionInput.source.firstSequence ||
      transcript.at(-1)?.sequence !== compactionInput.source.lastSequence
    ) {
      throw new DecksmithCompactionExecutionError(
        'Decksmith compaction source changed',
        'DECKSMITH_COMPACTION_OUTPUT_INVALID',
      );
    }
    const {
      systemPrompt,
      prompt,
      measure: providerMeasure,
    } = measureDecksmithCompactionProviderInput({
      source: compactionInput.source,
      previousSummary,
      transcript,
      ...(compactionInput.projection?.summaryOutcomeUpdates === undefined
        ? {}
        : { proposalOutcomeUpdates: compactionInput.projection.summaryOutcomeUpdates }),
    });
    const providerCapacity = estimateWithFrozenCapacity(compactionInput.capacity, providerMeasure);
    if (providerCapacity.estimatedInput > providerCapacity.guaranteedInputCapacity) {
      throw new DecksmithCompactionExecutionError(
        'Decksmith compaction provider input exceeds the frozen guarantee',
        'DECKSMITH_COMPACTION_OUTPUT_INVALID',
      );
    }
    const scene = getScene('teacher.deck');
    if (scene === undefined) throw new Error('teacher.deck Scene is unavailable');
    await assertTeacherDeckBudget(
      input.store,
      claimed,
      scene,
      safeProjectedProviderBudget(
        providerCapacity.estimatedInput,
        providerCapacity.reservedOutputCapacity,
      ),
    );
    const usages: UsageEntry[] = [];
    let dispatchAttempt = 0;
    let exactProviderMeasure = providerMeasure;
    const generated = await generateStructuredJsonWithModelService<DecksmithSummaryContent>({
      stage: 'decksmith',
      context: {
        actorId: claimed.actor.subject,
        actorOrganizationId: claimed.actor.orgId,
        billingGroupId: claimed.actor.billingGroupId ?? null,
        resourceScope: input.scope.resourceScope,
        jobId: claimed.id,
        runId: claimed.id,
      },
      schema: SUMMARY_SCHEMA,
      systemPrompt,
      prompt,
      env: input.env,
      fetch: input.fetchImpl,
      signal: input.signal,
      // A second correction dispatch would make a missing/malformed first usage receipt
      // indistinguishable from a double-charged provider attempt. Compaction is single-dispatch.
      maxOutputCorrections: 0,
      onPayload: (payload) => {
        const measure = deterministicCapacityMeasureSerialized(
          payload.serializedModelInput,
          countDeterministicCapacityStructure(payload.modelInput),
        );
        const exactCapacity = estimateWithFrozenCapacity(compactionInput.capacity, measure);
        if (exactCapacity.estimatedInput > exactCapacity.guaranteedInputCapacity) {
          throw new DecksmithCompactionExecutionError(
            'Decksmith compaction provider input exceeds the frozen guarantee',
            'DECKSMITH_COMPACTION_OUTPUT_INVALID',
          );
        }
        exactProviderMeasure = measure;
      },
      onDispatch: async () => {
        dispatchAttempt += 1;
        await input.store.appendEvent(claimed.id, 'decksmith.compaction.provider-attempt', {
          schemaVersion: 'reach-deck-decksmith-provider-attempt/v1',
          inputDigest: exactProviderMeasure.digest,
          attempt: dispatchAttempt,
        });
      },
      onUsage: async (value) => {
        const usage = {
          capability: value.capability,
          model: value.model,
          promptTokens: value.promptTokens,
          completionTokens: value.completionTokens,
          totalTokens: value.totalTokens,
          // A stream cut off for runaway repetition is metered locally; keep that visible.
          estimated: value.estimated,
        };
        await recordTeacherDeckUsage(input.store, claimed, scene, usage);
        await input.store.appendEvent(claimed.id, 'decksmith.compaction.usage-receipt', {
          schemaVersion: 'reach-deck-decksmith-usage-receipt/v1',
          totalTokens: usage.totalTokens,
        });
        usages.push(usage);
      },
    });
    if (usages.length < 1) {
      throw new DecksmithCompactionExecutionError(
        'Decksmith compaction has no trusted usage receipt',
        'DECKSMITH_COMPACTION_REPLAY_FORBIDDEN',
      );
    }
    const parsed = buildAuthoritativeSummary({
      generated,
      compactionInput,
      previousSummary,
      claimed,
      usages,
      transcript,
    });
    const installedRef = await input.store.completeDecksmithCompaction({
      threadId: compactionInput.threadId,
      scope: input.scope,
      leaseOwnerRunId: input.parentRun.id,
      parentRunId: input.parentRun.id,
      compactionRunId: claimed.id,
      compactionInput,
      summary: parsed,
    });
    if (installedRef.status === 'stale') {
      throw new DecksmithCompactionExecutionError(
        'Decksmith compaction became stale',
        'DECKSMITH_COMPACTION_OUTPUT_INVALID',
      );
    }
    await input.store.appendEvent(claimed.id, 'decksmith.compaction.succeeded', {
      sourceDigest: compactionInput.source.digest,
      summaryRevision: parsed.revision,
    });
    return { status: installedRef.status, summary: parsed };
  } catch (error) {
    const durable = await loadInstalledAfterFailure(input, compactionInput, claimed.id);
    if (durable !== null) return { status: 'reused', summary: durable };
    const budgetCode = teacherDeckBudgetCode(error);
    const stale =
      error instanceof DecksmithCompactionExecutionError &&
      error.code === 'DECKSMITH_COMPACTION_OUTPUT_INVALID';
    const code =
      budgetCode ?? (stale ? 'DECKSMITH_COMPACTION_STALE' : 'DECKSMITH_COMPACTION_MODEL_FAILED');
    await bestEffortFailure(input.store, claimed.id, code);
    throw error;
  }
}

export function decksmithCompactionRecoveryAgeMs(env: ReachDeckModelEnv = process.env): number {
  const providerDeadline = resolveModelServiceCallTimeoutMs(env, 'stream');
  const minimumAgeMs = providerDeadline * 2 + 300_000;
  if (!Number.isSafeInteger(minimumAgeMs)) {
    throw new Error('Decksmith compaction recovery age exceeds the supported range');
  }
  return minimumAgeMs;
}

function assertDecksmithCompactionScope(
  input: Parameters<typeof executeDecksmithCompaction>[0],
  compactionInput: DecksmithCompactionRunInput,
  claimed: RunRecord,
): void {
  let parentFrozen;
  try {
    parentFrozen = parseDecksmithFrozenRunInput(input.parentRun.input);
  } catch {
    throw new DecksmithCompactionExecutionError(
      'Decksmith compaction parent scope is invalid',
      'DECKSMITH_COMPACTION_OUTPUT_INVALID',
    );
  }
  if (
    claimed.id !== input.compactionRun.id ||
    claimed.sceneKey !== 'teacher.deck' ||
    claimed.threadId !== compactionInput.threadId ||
    input.parentRun.threadId !== compactionInput.threadId ||
    !sameActor(claimed.actor, input.scope.actor) ||
    !sameActor(input.parentRun.actor, input.scope.actor) ||
    !sameReachDeckResourceScope(compactionInput.resourceScope, input.scope.resourceScope) ||
    !sameReachDeckResourceScope(parentFrozen.resourceScope, input.scope.resourceScope) ||
    compactionInput.pageId !== input.scope.pageId ||
    parentFrozen.stream.pageId !== input.scope.pageId ||
    compactionInput.authorization.roleGrantId !== parentFrozen.authorization.roleGrantId ||
    !sameReachDeckPageDomainScope(
      claimed.domainScope,
      input.scope.resourceScope,
      input.scope.pageId,
    ) ||
    !sameReachDeckPageDomainScope(
      input.parentRun.domainScope,
      input.scope.resourceScope,
      input.scope.pageId,
    )
  ) {
    throw new DecksmithCompactionExecutionError(
      'Decksmith compaction execution scope changed',
      'DECKSMITH_COMPACTION_OUTPUT_INVALID',
    );
  }
}

function sameActor(left: RunRecord['actor'], right: RunRecord['actor']): boolean {
  return (
    left.subject === right.subject &&
    left.orgId === right.orgId &&
    left.billingGroupId === right.billingGroupId &&
    isDeepStrictEqual([...left.roles].sort(), [...right.roles].sort())
  );
}

function safeProjectedProviderBudget(estimatedInput: number, reservedOutput: number): number {
  const projected = estimatedInput + reservedOutput;
  if (!Number.isSafeInteger(projected) || projected < 1) {
    throw new Error('Decksmith compaction projected provider budget is invalid');
  }
  return projected;
}

function buildAuthoritativeSummary(input: {
  readonly generated: DecksmithSummaryContent;
  readonly compactionInput: DecksmithCompactionRunInput;
  readonly previousSummary?: DecksmithPageSummary;
  readonly claimed: RunRecord;
  readonly usages: readonly UsageEntry[];
  readonly transcript: ReturnType<typeof projectCompleteDecksmithTurns>;
}): DecksmithPageSummary {
  const content = exactGeneratedSummaryContent(input.generated);
  // v2：提案结局由服务端按冻结快照写入结构化条目，不采信模型自由生成的 proposalOutcomes；
  // 仍为 pending 的条目可被后续 Run 读取最新结局后补"结局更新"行。v1 输入保持原行为。
  const proposalOutcomes =
    input.compactionInput.projection === undefined
      ? content.proposalOutcomes
      : mergeStructuredProposalOutcomes({
          previous: input.previousSummary?.proposalOutcomes ?? [],
          updates: input.compactionInput.projection.summaryOutcomeUpdates ?? [],
          transcript: input.transcript,
        });
  const previousSummaryDigest =
    input.previousSummary === undefined ? undefined : digestDecksmithSummary(input.previousSummary);
  try {
    return parseDecksmithPageSummary({
      schemaVersion: DECKSMITH_SUMMARY_SCHEMA_VERSION,
      kind: 'summary',
      revision: (input.compactionInput.previousSummaryRef?.revision ?? 0) + 1,
      epoch: input.compactionInput.epoch,
      source: {
        firstSequence: input.compactionInput.source.firstSequence,
        lastSequence: input.compactionInput.source.lastSequence,
        firstRunId: input.compactionInput.source.runIds[0],
        lastRunId: input.compactionInput.source.runIds.at(-1),
        digest: input.compactionInput.source.digest,
      },
      text: content.text,
      pageFacts: content.pageFacts,
      unresolvedDecisions: content.unresolvedDecisions,
      proposalOutcomes,
      ...(input.compactionInput.previousSummaryRef === undefined ||
      previousSummaryDigest === undefined
        ? {}
        : {
            previousSummary: {
              runId: input.compactionInput.previousSummaryRef.runId,
              revision: input.compactionInput.previousSummaryRef.revision,
              digest: previousSummaryDigest,
            },
          }),
      metadata: {
        pageId: input.compactionInput.pageId,
        status: 'installed',
        ...(previousSummaryDigest === undefined ? {} : { previousSummaryDigest }),
        capacityProfileVersion: input.compactionInput.capacity.capacityProfileVersion,
        estimatorVersion: input.compactionInput.capacity.estimatorVersion,
        capacityUnit: input.compactionInput.capacity.capacityUnit,
      },
      provenance: {
        creationRunId: input.claimed.id,
        modelUsageDigest: createHash('sha256').update(JSON.stringify(input.usages)).digest('hex'),
        sourcePlanDigest: input.compactionInput.inputDigest,
      },
    });
  } catch (error) {
    throw new DecksmithCompactionExecutionError(
      `Decksmith compaction content is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'DECKSMITH_COMPACTION_OUTPUT_INVALID',
    );
  }
}

/**
 * 合并结构化提案结局：上一版摘要的结构化条目（应用冻结的结局更新）+ 本次压缩源回合的冻结结局，
 * 同一 Run 以较新的为准，按回合序号保留最新的上限条数。
 */
function mergeStructuredProposalOutcomes(input: {
  readonly previous: readonly Readonly<Record<string, unknown>>[];
  readonly updates: readonly {
    runId: string;
    sequence: number;
    outcome: DecksmithSummaryProposalOutcome['outcome'];
  }[];
  readonly transcript: ReturnType<typeof projectCompleteDecksmithTurns>;
}): DecksmithSummaryProposalOutcome[] {
  const byRun = new Map<string, DecksmithSummaryProposalOutcome>();
  for (const entry of readDecksmithSummaryProposalOutcomes(input.previous)) {
    byRun.set(entry.runId, entry);
  }
  for (const update of input.updates) {
    byRun.set(update.runId, {
      kind: DECKSMITH_SUMMARY_PROPOSAL_OUTCOME_KIND,
      runId: update.runId,
      sequence: update.sequence,
      outcome: update.outcome,
    });
  }
  for (const turn of input.transcript) {
    if (turn.proposalOutcome === undefined) continue;
    byRun.set(turn.runId, {
      kind: DECKSMITH_SUMMARY_PROPOSAL_OUTCOME_KIND,
      runId: turn.runId,
      sequence: turn.sequence,
      outcome: turn.proposalOutcome,
    });
  }
  return [...byRun.values()]
    .sort((left, right) => left.sequence - right.sequence || left.runId.localeCompare(right.runId))
    .slice(-DECKSMITH_PAGE_STREAM_LIMITS.factArrayEntries);
}

function exactGeneratedSummaryContent(value: unknown): DecksmithSummaryContent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecksmithCompactionExecutionError(
      'Decksmith compaction model content is invalid',
      'DECKSMITH_COMPACTION_OUTPUT_INVALID',
    );
  }
  const record = value as Record<string, unknown>;
  const fields = ['text', 'pageFacts', 'unresolvedDecisions', 'proposalOutcomes'] as const;
  if (
    fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field)) ||
    Object.keys(record).some((field) => !fields.includes(field as (typeof fields)[number]))
  ) {
    throw new DecksmithCompactionExecutionError(
      'Decksmith compaction model content fields are invalid',
      'DECKSMITH_COMPACTION_OUTPUT_INVALID',
    );
  }
  return record as unknown as DecksmithSummaryContent;
}

function teacherDeckBudgetCode(
  error: unknown,
):
  | 'TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED'
  | 'TEACHER_DECK_DAILY_TOKEN_BUDGET_EXCEEDED'
  | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return error.code === 'TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED' ||
    error.code === 'TEACHER_DECK_DAILY_TOKEN_BUDGET_EXCEEDED'
    ? error.code
    : undefined;
}

export function measureDecksmithCompactionProviderInput(input: {
  readonly source: DecksmithCompactionRunInput['source'];
  readonly previousSummary?: DecksmithPageSummary;
  readonly transcript: ReturnType<typeof projectCompleteDecksmithTurns>;
  /** v2：旧摘要中当时 pending、入队时已有结局的提案；缺省时提示词与 v1 逐字节一致。 */
  readonly proposalOutcomeUpdates?: readonly {
    readonly runId: string;
    readonly sequence: number;
    readonly outcome: string;
  }[];
}) {
  const systemPrompt =
    'Summarize the supplied Decksmith page transcript. Return exactly one JSON content object with only text, pageFacts, unresolvedDecisions, and proposalOutcomes. Preserve unresolved decisions and proposal outcomes; do not invent facts. Never return schema versions, kinds, revisions, epochs, sources, run IDs, digests, previous-summary links, metadata, or provenance; the server owns those fields.';
  const promptValue = {
    source: input.source,
    previousSummary: input.previousSummary ?? null,
    ...(input.proposalOutcomeUpdates === undefined || input.proposalOutcomeUpdates.length === 0
      ? {}
      : { proposalOutcomeUpdates: input.proposalOutcomeUpdates }),
    transcript: input.transcript,
  };
  const prompt = JSON.stringify(promptValue);
  const modelInput = buildStructuredJsonModelInput({
    schema: SUMMARY_SCHEMA,
    systemPrompt,
    prompt,
  });
  const serializedModelInput = JSON.stringify(modelInput);
  return Object.freeze({
    systemPrompt,
    prompt,
    modelInput,
    serializedModelInput,
    measure: deterministicCapacityMeasureSerialized(
      serializedModelInput,
      countDeterministicCapacityStructure(modelInput),
    ),
  });
}

async function resolvePreviousSummary(
  input: Parameters<typeof executeDecksmithCompaction>[0],
  compactionInput: DecksmithCompactionRunInput,
): Promise<DecksmithPageSummary | undefined> {
  if (compactionInput.previousSummary !== undefined) return compactionInput.previousSummary;
  if (compactionInput.previousSummaryRef === undefined) return undefined;
  const stored = await input.store.loadDecksmithSummary({
    threadId: compactionInput.threadId,
    scope: input.scope,
    ref: compactionInput.previousSummaryRef,
  });
  if (stored === null) throw new Error('Decksmith previous summary is unavailable');
  return stored.summary;
}

async function loadInstalledAfterFailure(
  input: Parameters<typeof executeDecksmithCompaction>[0],
  compactionInput: DecksmithCompactionRunInput,
  runId: string,
): Promise<DecksmithPageSummary | null> {
  const run = await input.store.getRun(runId);
  if (run?.status !== 'completed') return null;
  const ref = {
    schemaVersion: 'reach-deck-decksmith-summary-ref/v1' as const,
    kind: 'summary-ref' as const,
    runId,
    revision: (compactionInput.previousSummaryRef?.revision ?? 0) + 1,
    epoch: compactionInput.epoch,
    sourceDigest: compactionInput.source.digest,
  };
  return (
    (
      await input.store.loadDecksmithSummary({
        threadId: compactionInput.threadId,
        scope: input.scope,
        ref,
      })
    )?.summary ?? null
  );
}

async function bestEffortFailure(
  store: RuntimeStore,
  runId: string,
  code:
    | 'DECKSMITH_COMPACTION_STALE'
    | 'DECKSMITH_COMPACTION_MODEL_FAILED'
    | 'TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED'
    | 'TEACHER_DECK_DAILY_TOKEN_BUDGET_EXCEEDED',
): Promise<void> {
  try {
    await store.appendEvent(
      runId,
      code === 'DECKSMITH_COMPACTION_STALE'
        ? 'decksmith.compaction.stale'
        : 'decksmith.compaction.failed',
      {
        code,
        messageKey: 'reachDeck.decksmith.capacity.compactionFailed',
      },
    );
  } catch {}
  try {
    await store.failRun(runId, { code, message: 'Decksmith compaction failed' });
  } catch {}
}

function digestTranscript(items: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

export { digestTranscript };
