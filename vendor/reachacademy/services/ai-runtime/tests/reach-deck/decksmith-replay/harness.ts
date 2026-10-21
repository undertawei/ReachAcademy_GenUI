import type { ReachDeckDocument, ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { expect } from 'vitest';

import {
  runDecksmith,
  type DecksmithRunInput,
  type DecksmithStreamEvent,
} from '../../../lib/reach-deck/decksmith/agent.js';
import type { DecksmithBudgetController } from '../../../lib/reach-deck/decksmith/budget.js';
import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../../lib/reach-deck/contracts.js';
import { assembleDecksmithRecentHistory } from '../../../lib/reach-deck/decksmith/execution-context.js';
import {
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
  DECKSMITH_TURN_PROJECTION_V2,
  type DecksmithProposalOutcome,
} from '../../../lib/reach-deck/decksmith/page-stream-contracts.js';
import {
  buildDecksmithContextRefHints,
  readDecksmithResultClarification,
} from '../../../lib/reach-deck/decksmith/turn-memory.js';
import { resolveDecksmithClarificationAnswer } from '../../../lib/reach-deck/decksmith/clarification.js';
import {
  decksmithProjectionPolicy,
  snapshotDecksmithProposalOutcomes,
  type DecksmithProjectionSource,
} from '../../../lib/reach-deck/decksmith/turn-projection.js';
import { buildDecksmithDocumentHash } from '../../../lib/reach-deck/job-identity.js';
import { ReachDeckModelToolError } from '../../../lib/reach-deck/model-service-tools.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../../lib/reach-deck/voice-selection.js';
import { buildDecksmithResultEventPayload } from '../../../lib/teacher-deck-runtime.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from '../fixtures/resource-scope.js';
import {
  createDecksmithScriptedModel,
  type DecksmithReplayModelObservation,
  type DecksmithReplayTurn,
} from './scripted-model.js';
import {
  buildReplaySelectionContextRefs,
  DECKSMITH_REPLAY_CASE_SCHEMA_VERSION,
  DECKSMITH_REPLAY_CONTEXT,
  DECKSMITH_REPLAY_OBJECT_KEY_PREFIX,
  decksmithToolParameterDigests,
  loadReplayMedia,
  readReplayFixtureJson,
  readReplayMediaFile,
  sha256Hex,
  type DecksmithReplayCase,
  type DecksmithReplayImageServiceStep,
  type LoadedDecksmithReplayCase,
} from './fixture-loader.js';

export {
  buildReplaySelectionContextRefs,
  DECKSMITH_REPLAY_CASE_SCHEMA_VERSION,
  DECKSMITH_REPLAY_CONTEXT,
  decksmithToolParameterDigests,
  listDecksmithReplayCaseIds,
  loadDecksmithReplayCase,
  type DecksmithReplayCase,
  type LoadedDecksmithReplayCase,
} from './fixture-loader.js';

/**
 * Decksmith 回放夹具（WP0 / WP9 第①层）的加载、桩服务与执行器。
 *
 * 数据源：`fixtures/cases/*.json`（单个案例）、`fixtures/documents/*.json`（脱敏重建的基线文档）、
 * `fixtures/media/`（生成的小 PNG 与校验和清单）。不访问模型、content-service、对象存储或数据库。
 * 核心逻辑：
 * 1. 读取案例与基线文档，逐个核对媒体文件字节、清单与文档资源 digest 三者的 SHA-256；
 * 2. 核对案例记录的工具参数 schema 摘要与当前工具一致，避免脚本按旧参数形状静默回放；
 * 3. 用脚本化模型替换网络模型、用桩替换图片授权/编辑/生成/存储，跑真实 runDecksmith，
 *    工具真实作用于 DecksmithDocumentSession；
 * 4. 收集流事件、模型每回合可见上下文与桩调用记录，按案例 `expect` 做通用协议断言。
 * 夹具加载与校验在 fixture-loader.ts（不依赖 vitest，第②/③层评测脚本共用）。
 */

/** 测试文件里 vi.hoisted 的可变槽：模块桩通过它转发到当前案例的脚本模型与桩服务。 */
export interface DecksmithReplaySlot {
  streamFn?: unknown;
  services?: DecksmithReplayServices;
}

export interface DecksmithReplayServices {
  findMedia(): Promise<undefined>;
  storeMedia(input: { bytes: Uint8Array; contentType: string; pageId?: string }): Promise<{
    objectKey: string;
    downloadUrl: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string;
  }>;
  resolveReference(input: { objectKey: string }): Promise<{
    objectKey: string;
    downloadUrl: string;
    expiresInSeconds: number;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string;
    source: 'document' | 'generated';
  }>;
  loadReference(source: { downloadUrl: string }): Promise<{
    bytes: Buffer;
    contentType: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
    dataUrl: string;
  }>;
  editImage(instruction: string, referenceDataUrl: string): Promise<unknown>;
  generateImage(prompt: string): Promise<unknown>;
  readonly calls: {
    readonly imageEdit: { instruction: string; referenceSha256: string }[];
    readonly imageGenerate: { prompt: string }[];
    readonly stored: { objectKey: string; sha256: string }[];
  };
}

export interface DecksmithReplayRunOptions {
  /** 运行级预算门控（WP4）；缺省与旧回放一致，不门控。 */
  readonly budget?: DecksmithBudgetController;
  readonly signal?: AbortSignal;
  /** 与 durable worker 一致：失败直接抛出而不是产出 error 事件。 */
  readonly throwOnError?: boolean;
  /** 逐条消费事件（例如模拟 job-runner 的延迟记账）；在下一条事件被拉取前等待。 */
  readonly onEvent?: (event: DecksmithStreamEvent) => Promise<void> | void;
}

export interface DecksmithReplayRun {
  readonly events: readonly DecksmithStreamEvent[];
  /** 被 onPayload（容量/预算门控）拦下、没有派发的主模型请求次数。 */
  readonly refusedDispatches: number;
  readonly result: Extract<DecksmithStreamEvent, { type: 'result' }>;
  readonly assistantText: string;
  readonly toolEnds: readonly Extract<DecksmithStreamEvent, { type: 'tool-end' }>[];
  readonly observations: readonly DecksmithReplayModelObservation[];
  readonly userPrompt: string;
  readonly services: DecksmithReplayServices;
}

/**
 * 测试内联案例（不落夹具文件）：复用基线文档与媒体，工具参数摘要取当前值。
 * 只用于运行时合同类回归（如预算门控），教师案例仍写成夹具文件。
 */
export function buildInlineDecksmithReplayCase(input: {
  readonly id: string;
  readonly document?: string;
  readonly request: DecksmithReplayCase['request'];
  readonly transcript: DecksmithReplayCase['transcript'];
  readonly services?: DecksmithReplayCase['services'];
}): LoadedDecksmithReplayCase {
  const documentName = input.document ?? 'energy-lesson.json';
  const document = readReplayFixtureJson<ReachDeckDocument>(`documents/${documentName}`);
  const runInput: DecksmithRunInput = {
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    document,
    ...input.request,
  };
  const digests = decksmithToolParameterDigests(runInput);
  const used = new Set(
    input.transcript.flatMap((turn) => (turn.toolCalls ?? []).map((call) => call.name)),
  );
  return {
    fixture: {
      schemaVersion: DECKSMITH_REPLAY_CASE_SCHEMA_VERSION,
      id: input.id,
      teacherCase: 0,
      summary: input.id,
      provenance: { kind: 'synthetic-reconstruction', observedOn: 'inline', notes: 'inline' },
      document: documentName,
      request: input.request,
      capturedWith: {
        toolParameterSha256: Object.fromEntries(
          [...used].map((name) => [name, digests[name] ?? 'absent']),
        ),
      },
      transcript: input.transcript,
      ...(input.services === undefined ? {} : { services: input.services }),
      expect: {
        changed: false,
        outcome: { mutationStatus: 'none', toolErrorCount: 0 },
        modelTurns: 0,
      },
    },
    document,
    media: loadReplayMedia(document),
    runInput,
  };
}

export async function runDecksmithReplayCase(
  loaded: LoadedDecksmithReplayCase,
  slot: DecksmithReplaySlot,
  overrides: Pick<DecksmithRunInput, 'history' | 'clarificationAnswer'> = {},
  options: DecksmithReplayRunOptions = {},
): Promise<DecksmithReplayRun> {
  const current = decksmithToolParameterDigests(loaded.runInput);
  for (const [tool, digest] of Object.entries(loaded.fixture.capturedWith.toolParameterSha256)) {
    if (current[tool] !== digest) {
      throw new Error(
        `Decksmith replay case ${loaded.fixture.id}: parameters of ${tool} changed (now ${current[tool] ?? 'absent'}); re-check the scripted transcript and update capturedWith.`,
      );
    }
  }
  const model = createDecksmithScriptedModel(loaded.fixture.transcript);
  const services = createReplayServices(loaded);
  slot.streamFn = model.streamFn;
  slot.services = services;
  const events: DecksmithStreamEvent[] = [];
  try {
    for await (const event of runDecksmith(
      { ...structuredClone(loaded.runInput), ...overrides },
      DECKSMITH_REPLAY_CONTEXT,
      {
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.throwOnError === undefined ? {} : { throwOnError: options.throwOnError }),
      },
    )) {
      events.push(event);
      await options.onEvent?.(event);
    }
  } finally {
    slot.streamFn = undefined;
    slot.services = undefined;
  }
  const result = events.at(-1);
  if (result?.type !== 'result') {
    throw new Error(
      `Decksmith replay case ${loaded.fixture.id} ended without a result: ${JSON.stringify(result)}`,
    );
  }
  const firstUser = model.observations[0]?.messages[0];
  const userPrompt =
    firstUser?.role !== 'user'
      ? ''
      : typeof firstUser.content === 'string'
        ? firstUser.content
        : firstUser.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  return {
    events,
    refusedDispatches: model.refusedDispatches(),
    result,
    assistantText: events
      .flatMap((event) => (event.type === 'text-delta' ? [event.delta] : []))
      .join(''),
    toolEnds: events.filter(
      (event): event is Extract<DecksmithStreamEvent, { type: 'tool-end' }> =>
        event.type === 'tool-end',
    ),
    observations: model.observations,
    userPrompt,
    services,
  };
}

/**
 * 把上一轮回放结果投影成本轮模型历史（WP1 跨轮记忆），全程走生产代码：
 * 1. `buildDecksmithResultEventPayload` 生成 `decksmith.result` 载荷（实际答复 + 结构化变更清单）；
 * 2. 上一轮冻结输入带教师选区与由基线文档派生的选区提示；
 * 3. 按 `proposalOutcome` 追加审批 / 采用事件，入队时冻结结局快照（v2 投影策略）；
 * 4. `assembleDecksmithRecentHistory` 按 12 条 / 60,000 字节窗口拼装历史。
 */
export function buildReplayFollowUpHistory(
  previous: LoadedDecksmithReplayCase,
  previousRun: DecksmithReplayRun,
  outcome: DecksmithProposalOutcome,
): NonNullable<DecksmithRunInput['history']> {
  const source = buildReplayProjectionSource(previous, previousRun, outcome);
  const policy = decksmithProjectionPolicy({
    projectionVersion: DECKSMITH_TURN_PROJECTION_V2,
    proposalOutcomes: snapshotDecksmithProposalOutcomes([source]),
  });
  const assembled = assembleDecksmithRecentHistory([source], 1, policy);
  return assembled.messages.map((message) => ({ role: message.role, text: message.text }));
}

/**
 * 多轮回答提问（WP7）：上一轮以 ask_teacher 结束时，按生产代码判定本轮的回答关联结论；
 * 上一轮没有提问时抛错（案例写错）。
 */
export function buildReplayClarificationAnswer(
  previous: LoadedDecksmithReplayCase,
  previousRun: DecksmithReplayRun,
): NonNullable<DecksmithRunInput['clarificationAnswer']> {
  const source = buildReplayProjectionSource(previous, previousRun, 'pending');
  const result = source.events.find((event) => event.type === 'decksmith.result');
  const clarification =
    result === undefined ? undefined : readDecksmithResultClarification(result.payload);
  if (clarification === undefined) {
    throw new Error(`decksmith replay: ${previous.fixture.id} did not end with ask_teacher`);
  }
  return resolveDecksmithClarificationAnswer({
    items: [source],
    epoch: 1,
    questionId: clarification.questionId,
  });
}

/** 上一轮回放结果对应的投影源（冻结输入 + 结果与审批事件），供历史投影与回答关联共用。 */
export function buildReplayProjectionSource(
  previous: LoadedDecksmithReplayCase,
  previousRun: DecksmithReplayRun,
  outcome: DecksmithProposalOutcome,
): DecksmithProjectionSource {
  const pageId = previous.fixture.request.pageId;
  if (pageId === undefined) throw new Error('decksmith replay follow-up needs a page id');
  const document = previous.document as ReachDeckDocumentV2;
  const page = document.pages.find((candidate) => candidate.pageId === pageId)!;
  const documentHash = buildDecksmithDocumentHash(document);
  const contextRefs = buildReplaySelectionContextRefs(
    document,
    pageId,
    previous.fixture.request.selectedElementIds ?? [],
  );
  const hints = buildDecksmithContextRefHints(document, contextRefs);
  const decisions =
    outcome === 'pending'
      ? []
      : outcome === 'superseded'
        ? [{ type: 'artifact.applied', payload: { supersededByTeacherEdit: true } }]
        : [{ type: 'approval.decided', payload: { decision: outcome } }];
  const source: DecksmithProjectionSource = {
    runId: '0b6f9a3e-1d2c-4e5f-8a9b-0c1d2e3f4a51',
    status: 'completed',
    input: {
      schemaVersion: 'reach-deck-decksmith-frozen-run-input/v2',
      kind: 'decksmith-turn',
      message: previous.fixture.request.prompt,
      authorization: { roleGrantId: DECKSMITH_REPLAY_CONTEXT.roleGrantId },
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      stream: {
        schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
        pageId,
        sequence: 1,
        epoch: 1,
        contextRevision: 1,
      },
      baseline: {
        documentId: document.id,
        documentHash,
        contentDigest: 'decksmith-replay-content',
        pageId,
        pageRevision: page.revision,
      },
      contextRefs,
      projection: {
        projectionVersion: DECKSMITH_TURN_PROJECTION_V2,
        proposalOutcomes: [],
        ...(hints === undefined ? {} : { contextRefHints: hints }),
      },
      summaryOrCutoff: {
        schemaVersion: 'reach-deck-decksmith-cutoff/v1',
        kind: 'deterministic-cutoff',
        epoch: 1,
        afterSequence: 0,
        reason: 'no-summary',
      },
      includedRunRange: { runIds: [], firstSequence: 0, lastSequence: 0, digest: '0'.repeat(64) },
      estimatorVersion: 'decksmith-replay/v1',
    },
    events: [
      { type: 'run.started', payload: {} },
      {
        type: 'decksmith.result',
        payload: buildDecksmithResultEventPayload(previousRun.result, previous.document).payload,
      },
      ...(previousRun.result.changed
        ? [
            { type: 'artifact.proposed', payload: { approvalId: 'decksmith-replay-approval' } },
            { type: 'approval.required', payload: { approvalId: 'decksmith-replay-approval' } },
          ]
        : []),
      ...decisions,
      { type: 'run.completed', payload: {} },
    ],
  };
  return source;
}

/** 案例 `expect` 中的通用协议断言；案例特有的断言写在测试文件里。 */
export function assertDecksmithReplayExpectations(
  loaded: LoadedDecksmithReplayCase,
  run: DecksmithReplayRun,
): void {
  const expected = loaded.fixture.expect;
  expect(run.result.changed).toBe(expected.changed);
  expect(run.result.outcome).toMatchObject(expected.outcome);
  if (!expected.changed) {
    expect(run.result.document).toBeUndefined();
  } else {
    expect(run.result.document).toBeDefined();
  }
  expect(run.observations).toHaveLength(expected.modelTurns);
  for (const toolResult of expected.toolResults ?? []) {
    const end = run.toolEnds.find((event) => event.callId === toolResult.callId);
    expect(end, `tool call ${toolResult.callId}`).toMatchObject({ isError: toolResult.isError });
    const text = toolResultText(run, toolResult.callId);
    for (const fragment of toolResult.includes ?? []) {
      expect(text, `tool call ${toolResult.callId}`).toContain(fragment);
    }
  }
  for (const fragment of expected.userPromptIncludes ?? []) {
    expect(run.userPrompt).toContain(fragment);
  }
  for (const fragment of expected.userPromptExcludes ?? []) {
    expect(run.userPrompt).not.toContain(fragment);
  }
  if (expected.serviceCalls?.imageEdit !== undefined) {
    expect(run.services.calls.imageEdit).toHaveLength(expected.serviceCalls.imageEdit);
  }
  if (expected.serviceCalls?.imageGenerate !== undefined) {
    expect(run.services.calls.imageGenerate).toHaveLength(expected.serviceCalls.imageGenerate);
  }
  // 回放不得改动夹具里的基线文档（运行只作用于内存会话）。
  expect(loaded.runInput.document).toEqual(
    readReplayFixtureJson(`documents/${loaded.fixture.document}`),
  );
}

/** 模型在后续回合里看到的某次工具调用结果正文（经 provider 转换后）。 */
export function toolResultText(run: DecksmithReplayRun, callId: string): string {
  for (const observation of run.observations) {
    for (const message of observation.messages) {
      if (message.role === 'toolResult' && message.toolCallId === callId) {
        return message.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('');
      }
    }
  }
  throw new Error(`tool result ${callId} was never shown to the scripted model`);
}

function createReplayServices(loaded: LoadedDecksmithReplayCase): DecksmithReplayServices {
  const media = new Map(loaded.media);
  const editSteps = [...(loaded.fixture.services?.imageEdit ?? [])];
  const generateSteps = [...(loaded.fixture.services?.imageGenerate ?? [])];
  const calls: DecksmithReplayServices['calls'] = { imageEdit: [], imageGenerate: [], stored: [] };
  const imageStep = (steps: DecksmithReplayImageServiceStep[], label: string) => {
    const step = steps.shift();
    if (step === undefined) throw new Error(`decksmith replay: unscripted ${label} call`);
    if ('fail' in step) {
      throw new ReachDeckModelToolError(step.fail.message, step.fail.status, step.fail.retryable);
    }
    const file = readReplayMediaFile(step.image);
    return {
      base64: file.toString('base64'),
      ...(step.usage === undefined ? {} : { usage: step.usage }),
    };
  };
  return {
    calls,
    findMedia: async () => undefined,
    storeMedia: async (input) => {
      const bytes = Buffer.from(input.bytes);
      const digest = sha256Hex(bytes);
      const extension = input.contentType === 'image/jpeg' ? 'jpg' : 'png';
      const objectKey = `${DECKSMITH_REPLAY_OBJECT_KEY_PREFIX}generated/${digest.slice(0, 16)}.${extension}`;
      media.set(objectKey, {
        bytes,
        contentType: input.contentType,
        width: 2,
        height: 2,
        sha256: digest,
      });
      calls.stored.push({ objectKey, sha256: digest });
      return {
        objectKey,
        downloadUrl: `https://replay.invalid/${objectKey}`,
        contentType: input.contentType,
        sizeBytes: bytes.byteLength,
        checksumSha256: digest,
      };
    },
    resolveReference: async ({ objectKey }) => {
      const file = media.get(objectKey);
      if (file === undefined) throw new Error(`decksmith replay: unknown objectKey ${objectKey}`);
      return {
        objectKey,
        downloadUrl: `https://replay.invalid/${objectKey}`,
        expiresInSeconds: 120,
        contentType: file.contentType,
        sizeBytes: file.bytes.byteLength,
        checksumSha256: file.sha256,
        source: objectKey.includes('/generated/') ? 'generated' : 'document',
      };
    },
    loadReference: async ({ downloadUrl }) => {
      const objectKey = downloadUrl.replace('https://replay.invalid/', '');
      const file = media.get(objectKey);
      if (file === undefined) throw new Error(`decksmith replay: unknown download ${downloadUrl}`);
      return {
        bytes: file.bytes,
        contentType: file.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
        width: file.width,
        height: file.height,
        dataUrl: `data:${file.contentType};base64,${file.bytes.toString('base64')}`,
      };
    },
    editImage: async (instruction, referenceDataUrl) => {
      calls.imageEdit.push({
        instruction,
        referenceSha256: sha256Hex(Buffer.from(referenceDataUrl.split(',')[1] ?? '', 'base64')),
      });
      return imageStep(editSteps, 'image edit');
    },
    generateImage: async (prompt) => {
      calls.imageGenerate.push({ prompt });
      return imageStep(generateSteps, 'image generation');
    },
  };
}
