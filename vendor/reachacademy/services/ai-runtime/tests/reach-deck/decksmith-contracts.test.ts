import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import type { RuntimeRunInput } from '../../lib/contracts.js';
import {
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_LIMITS,
  REACH_DECK_DECKSMITH_LEGACY_COMPATIBILITY_MS,
  REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
  DECKSMITH_CONTEXT_REF_SCHEMA_VERSION,
  DECKSMITH_CUTOFF_SCHEMA_VERSION,
  DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
  DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION,
  DECKSMITH_PAGE_TURN_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_LIMITS,
  DECKSMITH_SUMMARY_SCHEMA_VERSION,
  parseDecksmithContextRef,
  parseDecksmithFrozenRunInput,
  parseDecksmithPageSummary,
  parseDecksmithPageMediaStatus,
  parseDecksmithPageTurn,
  parseReachDeckDecksmithOutcome,
  REACH_DECK_DECKSMITH_SUGGESTED_ACTION_KINDS,
  parseReachDeckDecksmithCompatibleRunInput,
  parseReachDeckDecksmithJobInput,
  parseReachDeckDecksmithJobPayload,
  parseReachDeckDecksmithJobResult,
  type ReachDeckDecksmithLegacyJobPayload,
  type ReachDeckDecksmithJobResultContent,
} from '../../lib/reach-deck/contracts.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithJobId,
  buildDecksmithRequestHash,
  buildDecksmithResultHash,
  buildDecksmithRunId,
} from '../../lib/reach-deck/job-identity.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { buildScientificGenerationContext } from '../../lib/reach-deck/scientific-generation-context.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const document = createV2Document();

if (false) {
  const mixedOrdinaryInput: RuntimeRunInput = {
    kind: 'message',
    message: 'Ordinary message',
    // @ts-expect-error Decksmith-only fields cannot leak into an ordinary message input.
    contextRefs: [],
  };
  void mixedOrdinaryInput;

  // @ts-expect-error Ordinary runtime fields cannot leak into a Decksmith control input.
  const mixedControlInput: RuntimeRunInput = {
    schemaVersion: 'reach-deck-decksmith-control-run-input/v1',
    kind: 'decksmith-control',
    message: '',
    control: {} as Extract<RuntimeRunInput, { kind: 'decksmith-control' }>['control'],
    srlReportId: 'report-id',
  };
  void mixedControlInput;

  // @ts-expect-error Ordinary runtime fields cannot leak into a Decksmith turn input.
  const mixedTurnInput: RuntimeRunInput = {
    ...createFrozenInput(),
    replyToRunId: '01900000-0000-7000-8000-000000000099',
  };
  void mixedTurnInput;
}

describe('Decksmith durable contracts', () => {
  it('strictly validates the authoritative page media status snapshot', () => {
    const status = {
      schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
      pageId: 'page-1',
      narration: 'generating',
      audio: 'generating',
      animation: 'completed',
      reasonCode: 'narration-generating',
    } as const;
    expect(parseDecksmithPageMediaStatus(status)).toEqual(status);
    expect(() => parseDecksmithPageMediaStatus({ ...status, audio: 'unknown' })).toThrow(
      /invalid/i,
    );
    expect(() =>
      parseReachDeckDecksmithJobInput({
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        prompt: 'change layout',
        document,
        pageId: document.pages[0]!.pageId,
        mediaStatus: { ...status, pageId: 'other-page' },
      }),
    ).toThrow(/does not match/i);
  });

  it('builds stable document/request hashes and deterministic identities', () => {
    const payload = createPayload();
    expect(payload.baseDocumentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.runId).toMatch(/^decksmith-run-v2-[a-f0-9]{32}$/);
    expect(payload.jobId).toMatch(/^decksmith-v2-[a-f0-9]{32}$/);
    expect(createPayload()).toEqual(payload);

    const changed = createPayload({ prompt: 'A different request' });
    expect(changed.runId).toBe(payload.runId);
    expect(changed.requestHash).not.toBe(payload.requestHash);
    expect(changed.jobId).not.toBe(payload.jobId);
  });

  it('strictly parses a bounded payload and verifies its base digest', () => {
    const payload = createPayload();
    expect(parseReachDeckDecksmithJobPayload(payload)).toEqual({
      ...payload,
      actorOrganizationId: payload.resourceScope.organizationId,
    });
    expect(() =>
      parseReachDeckDecksmithJobPayload({ ...payload, baseDocumentHash: 'b'.repeat(64) }),
    ).toThrow(/identity/i);
    expect(() => parseReachDeckDecksmithJobPayload({ ...payload, unexpected: true })).toThrow(
      /unsupported/i,
    );
  });

  it('preserves an actor organization distinct from the canonical resource organization', () => {
    const legacy = createPayload();
    const actorOrganizationId = '77777777-7777-4777-8777-777777777777';
    const runId = buildDecksmithRunId({
      idempotencyKey: 'decksmith-contract-key',
      ...TEST_REACH_DECK_SCOPE,
      actorOrganizationId,
    });
    const payload = {
      ...legacy,
      actorOrganizationId,
      runId,
      jobId: buildDecksmithJobId({ runId, requestHash: legacy.requestHash }),
    };

    expect(parseReachDeckDecksmithJobPayload(payload)).toMatchObject({
      actorOrganizationId,
      resourceScope: { organizationId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId },
    });
    expect(() =>
      parseReachDeckDecksmithJobPayload({ ...payload, actorOrganizationId: 'not-a-uuid' }),
    ).toThrow(/actorOrganizationId.*UUID/i);
  });

  it('bounds prompts, history, selected elements, and document shape', () => {
    expect(() => parseReachDeckDecksmithJobInput({ prompt: 'change it', document })).toThrow(
      /missing|capability/i,
    );
    expect(() =>
      parseReachDeckDecksmithJobInput({
        capability: 'reach-deck-decksmith/v1',
        prompt: 'change it',
        document,
      }),
    ).toThrow(/capability/i);
    expect(() =>
      parseReachDeckDecksmithJobInput({
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        prompt: 'x'.repeat(REACH_DECK_DECKSMITH_LIMITS.promptCharacters + 1),
        document,
      }),
    ).toThrow(/prompt/i);
    expect(() =>
      parseReachDeckDecksmithJobInput({
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        prompt: 'change it',
        document,
        history: Array.from({ length: REACH_DECK_DECKSMITH_LIMITS.historyEntries + 1 }, () => ({
          role: 'user',
          text: 'x',
        })),
      }),
    ).toThrow(/history/i);
    expect(() =>
      parseReachDeckDecksmithJobInput({
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        prompt: 'change it',
        document,
        selectedElementIds: ['same', 'same'],
      }),
    ).toThrow(/duplicates/i);
    expect(() =>
      parseReachDeckDecksmithJobInput({
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        prompt: 'change it',
        document: { schemaVersion: 'wrong' },
      }),
    ).toThrow();
  });

  it('validates terminal result provenance, hash, changed document, and size', () => {
    const payload = createPayload();
    const result = createResult(payload);
    expect(parseReachDeckDecksmithJobResult(result, payload)).toEqual(result);
    expect(() =>
      parseReachDeckDecksmithJobResult({ ...result, resultHash: 'b'.repeat(64) }, payload),
    ).toThrow(/hash/i);
    expect(() =>
      parseReachDeckDecksmithJobResult({ ...result, baseDocumentHash: 'b'.repeat(64) }, payload),
    ).toThrow(/provenance/i);
    expect(() =>
      parseReachDeckDecksmithJobResult(
        {
          ...result,
          message: 'x'.repeat(REACH_DECK_DECKSMITH_LIMITS.assistantMessageCharacters + 1),
        },
        payload,
      ),
    ).toThrow(/message/i);
    expect(() => parseReachDeckDecksmithJobResult({ ...result, changed: true }, payload)).toThrow(
      /document/i,
    );

    const foreignDocument = createBlankReachDeckDocument({
      id: '99999999-9999-4999-8999-999999999999',
      title: 'Foreign module version',
    });
    const foreignContent: ReachDeckDecksmithJobResultContent = {
      ...result,
      changed: true,
      document: foreignDocument,
    };
    expect(() =>
      parseReachDeckDecksmithJobResult(
        { ...foreignContent, resultHash: buildDecksmithResultHash(foreignContent) },
        payload,
      ),
    ).toThrow(/provenance/i);
  });

  it('round-trips structured outcomes while accepting pre-outcome v2 results', () => {
    const payload = createPayload();
    const legacyResult = createResult(payload);
    expect(parseReachDeckDecksmithJobResult(legacyResult, payload)).not.toHaveProperty('outcome');

    const { resultHash: _legacyHash, ...legacyContent } = legacyResult;
    const content: ReachDeckDecksmithJobResultContent = {
      ...legacyContent,
      outcome: {
        schemaVersion: 'reach-deck-decksmith-outcome/v1',
        mutationStatus: 'none',
        rejectedFontFamilies: ['Times New Roman'],
        toolErrorCount: 0,
      },
    };
    const result = { ...content, resultHash: buildDecksmithResultHash(content) };
    expect(parseReachDeckDecksmithJobResult(result, payload)).toEqual(result);

    const invalidContent: ReachDeckDecksmithJobResultContent = {
      ...content,
      outcome: { ...content.outcome!, mutationStatus: 'proposal' },
    };
    expect(() =>
      parseReachDeckDecksmithJobResult(
        { ...invalidContent, resultHash: buildDecksmithResultHash(invalidContent) },
        payload,
      ),
    ).toThrow(/outcome/i);
  });

  it('round-trips budget-limited outcomes (WP4) and keeps them consistent', () => {
    const payload = createPayload();
    const { resultHash: _legacyHash, ...legacyContent } = createResult(payload);
    const budgetLimited = {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      remainingTasks: ['在第 2 页后插入第 3 题'],
      completion: {
        state: 'budget-limited',
        scope: 'run',
        messageKey: 'reachDeck.decksmith.budget.runLimited',
      },
    } as const;
    const content: ReachDeckDecksmithJobResultContent = {
      ...legacyContent,
      outcome: budgetLimited,
    };
    const result = { ...content, resultHash: buildDecksmithResultHash(content) };
    expect(parseReachDeckDecksmithJobResult(result, payload)).toEqual(result);
    // 预算收尾且有修改时只能是 partial，不能是 proposal。
    expect(() =>
      parseReachDeckDecksmithOutcome({ ...budgetLimited, mutationStatus: 'proposal' }),
    ).toThrow(/inconsistent/);
    expect(
      parseReachDeckDecksmithOutcome({ ...budgetLimited, mutationStatus: 'partial' }),
    ).toMatchObject({ mutationStatus: 'partial' });
    // completion 与 remainingTasks 必须同时出现。
    const { remainingTasks: _tasks, ...withoutTasks } = budgetLimited;
    expect(() => parseReachDeckDecksmithOutcome(withoutTasks)).toThrow(/completion/);
    const { completion: _completion, ...withoutCompletion } = budgetLimited;
    expect(() => parseReachDeckDecksmithOutcome(withoutCompletion)).toThrow(/completion/);
    // 文案键与额度范围必须一一对应；剩余任务有界。
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...budgetLimited,
        completion: { ...budgetLimited.completion, scope: 'daily' },
      }),
    ).toThrow(/completion/);
    expect(() => parseReachDeckDecksmithOutcome({ ...budgetLimited, remainingTasks: [] })).toThrow(
      /remaining tasks/,
    );
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...budgetLimited,
        remainingTasks: Array.from({ length: 9 }, (_, index) => `task ${index}`),
      }),
    ).toThrow(/remaining tasks/);
    expect(() =>
      parseReachDeckDecksmithOutcome({ ...budgetLimited, remainingTasks: ['x'.repeat(301)] }),
    ).toThrow(/remaining task/);
  });

  it('round-trips step-limited outcomes and rejects a scope or a wrong message key', () => {
    const stepLimited = {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'partial',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      remainingTasks: ['Continue the teacher request from where this turn stopped: "改成 10 道题"'],
      completion: { state: 'step-limited', messageKey: 'reachDeck.decksmith.stepLimited' },
    } as const;
    expect(parseReachDeckDecksmithOutcome(stepLimited)).toEqual(stepLimited);
    // 截断且有修改时只能是 partial；completion 与 remainingTasks 必须同时出现。
    expect(() =>
      parseReachDeckDecksmithOutcome({ ...stepLimited, mutationStatus: 'proposal' }),
    ).toThrow(/inconsistent/);
    const { remainingTasks: _tasks, ...withoutTasks } = stepLimited;
    expect(() => parseReachDeckDecksmithOutcome(withoutTasks)).toThrow(/completion/);
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...stepLimited,
        completion: { ...stepLimited.completion, scope: 'run' },
      }),
    ).toThrow(/completion/);
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...stepLimited,
        completion: {
          ...stepLimited.completion,
          messageKey: 'reachDeck.decksmith.budget.runLimited',
        },
      }),
    ).toThrow(/completion/);
  });

  it('strictly parses every suggested page action kind and rejects unknown kinds', () => {
    const outcome = {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
    } as const;
    const suggestedActions = REACH_DECK_DECKSMITH_SUGGESTED_ACTION_KINDS.map((kind) => ({
      kind,
      pageId: 'page-1',
    }));
    expect(parseReachDeckDecksmithOutcome({ ...outcome, suggestedActions })).toEqual({
      ...outcome,
      suggestedActions,
    });
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...outcome,
        suggestedActions: [{ kind: 'run-anything', pageId: 'page-1' }],
      }),
    ).toThrow(/suggested action kind/);
  });

  it('parses frozen page-stream input while preserving legacy input compatibility', () => {
    expect(REACH_DECK_DECKSMITH_LEGACY_COMPATIBILITY_MS).toBe(86_400_000);
    const legacy = createPayload().input;
    expect(parseReachDeckDecksmithCompatibleRunInput(legacy)).toEqual({
      format: 'legacy',
      input: legacy,
    });

    const frozen = createFrozenInput();
    expect(parseReachDeckDecksmithCompatibleRunInput(frozen)).toEqual({
      format: 'frozen',
      input: frozen,
    });
    const { voiceSelection: _voiceSelection, ...withoutVoice } = frozen;
    const frozenV1 = {
      ...withoutVoice,
      schemaVersion: DECKSMITH_FROZEN_RUN_INPUT_V1_SCHEMA_VERSION,
    };
    expect(parseReachDeckDecksmithCompatibleRunInput(frozenV1)).toEqual({
      format: 'frozen',
      input: {
        ...frozenV1,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      },
    });
    expect(
      parseDecksmithPageTurn({
        schemaVersion: DECKSMITH_PAGE_TURN_SCHEMA_VERSION,
        kind: 'turn',
        role: 'teacher',
        stream: frozen.stream,
        text: frozen.message,
        contextRefs: frozen.contextRefs,
      }),
    ).toMatchObject({ role: 'teacher', text: frozen.message, stream: frozen.stream });
    expect(() =>
      parseReachDeckDecksmithCompatibleRunInput({
        ...frozen,
        baseline: { ...frozen.baseline, pageId: 'other-page' },
      }),
    ).toThrow(/baseline page/i);
    expect(() =>
      parseReachDeckDecksmithCompatibleRunInput({
        ...frozen,
        contextRefs: [frozen.contextRefs[0], frozen.contextRefs[0]],
      }),
    ).toThrow(/duplicates/i);
  });

  it('accepts optional scientific context on the normal frozen schema and validates it when present', () => {
    const legacy = createFrozenInput();
    const scientificContextSnapshot = buildScientificGenerationContext({
      stage: 'decksmith',
      contexts: ['interactive'],
      teacherRequest: 'Construct a midpoint and a circle',
    });
    const frozen = {
      ...legacy,
      schemaVersion: DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
      scientificContextSnapshot,
    };
    expect(parseDecksmithFrozenRunInput(frozen)).toEqual(frozen);
    expect(parseReachDeckDecksmithCompatibleRunInput(frozen)).toEqual({
      format: 'frozen',
      input: frozen,
    });
    expect(parseDecksmithFrozenRunInput(legacy)).toEqual(legacy);
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        scientificContextSnapshot: {
          ...scientificContextSnapshot,
          serializedInjection: scientificContextSnapshot.serializedInjection + ' altered',
        },
      }),
    ).toThrow();
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        scientificContextSnapshot: buildScientificGenerationContext({
          stage: 'interactive',
          contexts: ['interactive'],
        }),
      }),
    ).toThrow(/stage/i);
    expect(parseDecksmithFrozenRunInput({ ...legacy, scientificContextSnapshot })).toEqual(frozen);
  });

  it('round-trips bounded page, native-element, and interactive-component snapshots', () => {
    const baseline = { documentId: document.id, documentHash: 'a'.repeat(64) };
    const page = createFrozenInput().contextRefs[0];
    const native = {
      schemaVersion: DECKSMITH_CONTEXT_REF_SCHEMA_VERSION,
      kind: 'native-element',
      pageId: document.pages[0]!.pageId,
      pageLabel: document.pages[0]!.title,
      pageOrder: 1,
      pageRevision: document.pages[0]!.revision,
      sceneId: 'native-scene',
      sceneType: 'slide',
      componentId: 'native-title',
      componentType: 'textFrame',
      display: { label: 'Concurrency title', detail: 'Large heading at the top' },
      baseline: {
        ...baseline,
        pageRevision: document.pages[0]!.revision,
        componentHash: 'b'.repeat(64),
      },
    } as const;
    const interactive = {
      ...native,
      kind: 'interactive-component',
      sceneId: 'interactive-scene',
      sceneType: 'interactive',
      componentId: 'interactive-chart',
      componentType: 'chart',
      display: { label: 'Throughput chart', detail: 'Requests per second' },
      baseline: { ...native.baseline, componentHash: 'c'.repeat(64) },
    } as const;

    expect(parseDecksmithContextRef(page)).toEqual(page);
    expect(parseDecksmithContextRef(native)).toEqual(native);
    expect(parseDecksmithContextRef(interactive)).toEqual(interactive);
    expect(JSON.stringify({ native, interactive })).toMatch(/Concurrency title|Throughput chart/);
  });

  it('rejects incomplete, mismatched, stale, oversized, and unsupported context refs', () => {
    const frozen = createFrozenInput();
    const page = frozen.contextRefs[0]!;
    const native = {
      schemaVersion: DECKSMITH_CONTEXT_REF_SCHEMA_VERSION,
      kind: 'native-element',
      pageId: frozen.baseline.pageId,
      pageLabel: 'Page',
      pageOrder: 1,
      pageRevision: frozen.baseline.pageRevision,
      sceneId: 'scene',
      sceneType: 'slide',
      componentId: 'element',
      componentType: 'textFrame',
      display: { label: 'Title' },
      baseline: {
        documentId: frozen.baseline.documentId,
        documentHash: frozen.baseline.documentHash,
        pageRevision: frozen.baseline.pageRevision,
        componentHash: 'c'.repeat(64),
      },
    } as const;

    expect(() => parseDecksmithContextRef({ ...page, baseline: undefined })).toThrow(/fields/i);
    expect(() => parseDecksmithContextRef({ ...native, display: undefined })).toThrow(/fields/i);
    expect(() => parseDecksmithContextRef({ ...native, sceneType: 'interactive' })).toThrow(
      /scene type/i,
    );
    expect(() =>
      parseDecksmithContextRef({
        ...native,
        baseline: { ...native.baseline, pageRevision: native.pageRevision + 1 },
      }),
    ).toThrow(/baseline revision/i);
    expect(() =>
      parseDecksmithContextRef({
        ...native,
        display: {
          ...native.display,
          label: 'x'.repeat(DECKSMITH_PAGE_STREAM_LIMITS.labelCharacters + 1),
        },
      }),
    ).toThrow(/label/i);
    for (const kind of ['quiz-component']) {
      expect(() => parseDecksmithContextRef({ ...native, kind })).toThrow(/kind/i);
    }
  });

  it('enforces frozen-input epoch, range, cutoff, revision, baseline, and total-size coherence', () => {
    const frozen = createFrozenInput();
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        summaryOrCutoff: { ...frozen.summaryOrCutoff, epoch: frozen.stream.epoch + 1 },
      }),
    ).toThrow(/epoch/i);
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        summaryOrCutoff: { ...frozen.summaryOrCutoff, afterSequence: frozen.stream.sequence },
      }),
    ).toThrow(/precede/i);
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        includedRunRange: { ...frozen.includedRunRange, runIds: [] },
      }),
    ).toThrow(/range/i);
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        includedRunRange: { ...frozen.includedRunRange, firstSequence: 3 },
      }),
    ).toThrow(/precede/i);
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        contextRefs: [
          {
            ...frozen.contextRefs[0],
            revision: frozen.baseline.pageRevision + 1,
          },
        ],
      }),
    ).toThrow(/stale/i);
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        contextRefs: [
          {
            ...frozen.contextRefs[0],
            baseline: { ...frozen.contextRefs[0]!.baseline, documentHash: 'f'.repeat(64) },
          },
        ],
      }),
    ).toThrow(/baseline/i);

    const oversizedRefs = Array.from({ length: DECKSMITH_PAGE_STREAM_LIMITS.refs }, (_, index) => ({
      schemaVersion: DECKSMITH_CONTEXT_REF_SCHEMA_VERSION,
      kind: 'native-element' as const,
      pageId: `page-${index}-${'界'.repeat(220)}`,
      pageLabel: '界'.repeat(DECKSMITH_PAGE_STREAM_LIMITS.labelCharacters),
      pageOrder: index + 1,
      pageRevision: 1,
      sceneId: `scene-${index}-${'界'.repeat(210)}`,
      sceneType: 'slide' as const,
      componentId: `component-${index}-${'界'.repeat(205)}`,
      componentType: '界'.repeat(DECKSMITH_PAGE_STREAM_LIMITS.identifierCharacters),
      display: {
        label: '界'.repeat(DECKSMITH_PAGE_STREAM_LIMITS.labelCharacters),
        detail: '界'.repeat(DECKSMITH_PAGE_STREAM_LIMITS.displayCharacters),
      },
      baseline: {
        documentId: frozen.baseline.documentId,
        documentHash: frozen.baseline.documentHash,
        pageRevision: 1,
        componentHash: index.toString(16).padStart(64, '0'),
      },
    }));
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        message: '界'.repeat(DECKSMITH_PAGE_STREAM_LIMITS.messageCharacters),
        contextRefs: oversizedRefs,
      }),
    ).toThrow(/size limit/i);
  });

  it('shares one bounded complexity budget across all summary fact arrays', () => {
    const summary = createSummary();
    expect(parseDecksmithPageSummary(summary)).toEqual(summary);
    expect(() =>
      parseDecksmithPageSummary({
        ...summary,
        pageFacts: [{ nested: [[[[[[['too deep']]]]]]] }],
      }),
    ).toThrow(/complex/i);
    expect(() =>
      parseDecksmithPageSummary({
        ...summary,
        pageFacts: [
          Object.fromEntries(
            Array.from(
              { length: DECKSMITH_PAGE_STREAM_LIMITS.factObjectEntries + 1 },
              (_, index) => [`fact-${index}`, index],
            ),
          ),
        ],
      }),
    ).toThrow(/object is too large/i);
    const manyNodes = Array.from(
      { length: DECKSMITH_PAGE_STREAM_LIMITS.factArrayEntries },
      (_, index) => ({ index, values: Array.from({ length: 9 }, (_, value) => value) }),
    );
    expect(() =>
      parseDecksmithPageSummary({
        ...summary,
        pageFacts: manyNodes,
        unresolvedDecisions: manyNodes,
        proposalOutcomes: manyNodes,
      }),
    ).toThrow(/complex/i);
  });
});

function createFrozenInput() {
  return {
    schemaVersion: DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
    kind: 'decksmith-turn',
    message: 'Shorten the current page',
    authorization: {
      roleGrantId: '99999999-9999-4999-8999-999999999999',
    },
    resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    stream: {
      schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
      pageId: document.pages[0]!.pageId,
      sequence: 7,
      epoch: 2,
      contextRevision: 4,
    },
    baseline: {
      documentId: document.id,
      documentHash: 'a'.repeat(64),
      contentDigest: 'sha256:authoritative-materialization',
      pageId: document.pages[0]!.pageId,
      pageRevision: document.pages[0]!.revision,
    },
    contextRefs: [
      {
        schemaVersion: DECKSMITH_CONTEXT_REF_SCHEMA_VERSION,
        kind: 'page',
        pageId: document.pages[0]!.pageId,
        label: document.pages[0]!.title,
        order: 1,
        revision: document.pages[0]!.revision,
        baseline: {
          documentId: document.id,
          documentHash: 'a'.repeat(64),
        },
      },
    ],
    summaryOrCutoff: {
      schemaVersion: DECKSMITH_CUTOFF_SCHEMA_VERSION,
      kind: 'deterministic-cutoff',
      epoch: 2,
      afterSequence: 3,
      reason: 'no-summary',
    },
    includedRunRange: {
      runIds: ['01900000-0000-7000-8000-000000000001'],
      firstSequence: 4,
      lastSequence: 6,
      digest: 'b'.repeat(64),
    },
    estimatorVersion: 'conservative-bytes/v1',
  } as const;
}

function createSummary() {
  return {
    schemaVersion: DECKSMITH_SUMMARY_SCHEMA_VERSION,
    kind: 'summary',
    revision: 1,
    epoch: 2,
    source: {
      firstSequence: 1,
      lastSequence: 3,
      firstRunId: '01900000-0000-7000-8000-000000000011',
      lastRunId: '01900000-0000-7000-8000-000000000013',
      digest: 'd'.repeat(64),
    },
    text: 'The page explains concurrency.',
    pageFacts: [{ subject: 'locks', status: 'introduced' }],
    unresolvedDecisions: [{ question: 'Which example should remain?' }],
    proposalOutcomes: [{ proposal: 'shorten title', accepted: true }],
  } as const;
}

export function createPayload(
  overrides: Partial<{ prompt: string }> = {},
): ReachDeckDecksmithLegacyJobPayload {
  const input = parseReachDeckDecksmithJobInput({
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt: overrides.prompt ?? 'Shorten the first page',
    document,
    pageId: document.pages[0]!.pageId,
    selectedElementIds: ['title'],
    history: [{ role: 'user', text: 'Keep the style' }],
  });
  const runId = buildDecksmithRunId({
    idempotencyKey: 'decksmith-contract-key',
    ...TEST_REACH_DECK_SCOPE,
  });
  const requestHash = buildDecksmithRequestHash(input);
  return {
    schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: buildDecksmithJobId({ runId, requestHash }),
    runId,
    requestHash,
    baseDocumentHash: buildDecksmithDocumentHash(input.document),
    ...TEST_REACH_DECK_SCOPE,
    input,
  };
}

export function createResult(
  payload: ReachDeckDecksmithLegacyJobPayload,
): ReturnType<typeof parseReachDeckDecksmithJobResult> {
  const content: ReachDeckDecksmithJobResultContent = {
    schemaVersion: REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: payload.jobId,
    runId: payload.runId,
    requestHash: payload.requestHash,
    baseDocumentHash: payload.baseDocumentHash,
    attempt: 1,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:00:01.000Z',
    message: 'No change was needed.',
    changed: false,
  };
  return { ...content, resultHash: buildDecksmithResultHash(content) };
}

function createV2Document() {
  const normalized = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
      title: 'Decksmith contract',
    }),
  );
  const page = normalized.pages[0]!;
  return parseReachDeckDocument({
    ...normalized,
    pages: normalized.pages,
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-contract-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
        },
      },
    ],
  });
}
