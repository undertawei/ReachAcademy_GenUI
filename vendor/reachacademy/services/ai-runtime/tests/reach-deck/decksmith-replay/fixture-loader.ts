import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import type { ReachDeckDocument, ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import {
  buildDecksmithInitialProviderInput,
  type DecksmithRunInput,
} from '../../../lib/reach-deck/decksmith/agent.js';
import {
  buildDecksmithDocumentHash,
  buildStagedGenerationRequestHash,
} from '../../../lib/reach-deck/job-identity.js';
import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../../lib/reach-deck/contracts.js';
import type { DecksmithProposalOutcome } from '../../../lib/reach-deck/decksmith/page-stream-contracts.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from '../fixtures/resource-scope.js';
import type { DecksmithReplayTurn } from './scripted-model.js';

/**
 * Decksmith 回放夹具的加载与校验（不依赖 vitest）。
 *
 * 数据源：`fixtures/cases/*.json`（单个案例）、`fixtures/documents/*.json`（脱敏重建的基线文档）、
 * `fixtures/media/`（生成的小 PNG 与校验和清单）。不访问模型、content-service、对象存储或数据库。
 * 核心逻辑：
 * 1. 读取案例与基线文档，核对案例头；
 * 2. 逐个核对媒体文件字节、清单与文档资源 digest 三者的 SHA-256；
 * 3. 按当前工具面计算参数 schema 摘要，供回放核对脚本与工具形状一致。
 * 设计动机：第①层回放（vitest）与第②/③层评测脚本（tsx，见 scripts/reach-deck/decksmith-eval/）
 * 共用同一份冻结输入；脚本进程不能加载 vitest，所以加载逻辑独立成本模块。
 */
export const DECKSMITH_REPLAY_CASE_SCHEMA_VERSION = 'decksmith-replay-case/v1';
export const DECKSMITH_REPLAY_FIXTURE_ROOT = new URL('./fixtures/', import.meta.url);
export const DECKSMITH_REPLAY_OBJECT_KEY_PREFIX = `uploads/${TEST_REACH_DECK_RESOURCE_SCOPE.organizationId}/reach-deck/decksmith-replay/`;

export const DECKSMITH_REPLAY_CONTEXT = Object.freeze({
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  sessionId: 'decksmith-replay-job',
  jobId: 'decksmith-replay-job',
  runId: 'decksmith-replay-run',
});

export type DecksmithReplayImageServiceStep =
  | {
      readonly fail: {
        readonly message: string;
        readonly status: number;
        readonly retryable: boolean;
      };
    }
  | {
      readonly image: string;
      readonly usage?: {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly totalTokens: number;
      };
    };

export interface DecksmithReplayCase {
  readonly schemaVersion: typeof DECKSMITH_REPLAY_CASE_SCHEMA_VERSION;
  readonly id: string;
  /** 对应方案 §1.1 的教师案例编号；0 表示非案例的运行时合同回归。 */
  readonly teacherCase: number;
  readonly summary: string;
  readonly provenance: {
    readonly kind: 'synthetic-reconstruction';
    readonly observedOn: string;
    readonly notes: string;
  };
  /** `fixtures/documents/` 下的基线文档文件名。 */
  readonly document: string;
  /** 冻结的运行输入（文档以外）：教师原话、当前页、选区、投影历史、摘要、媒体生成状态等。 */
  readonly request: Omit<DecksmithRunInput, 'capability' | 'document'>;
  /**
   * 多轮案例：先回放 `id` 案例作为上一轮，按 `proposalOutcome` 记录教师对其提案的处理，
   * 再经真实的结果载荷、v2 投影与最近窗口拼装得到本轮 `history`（覆盖 request.history）。
   */
  readonly followsCase?: {
    readonly id: string;
    readonly proposalOutcome: DecksmithProposalOutcome;
    /**
     * WP7：本轮回答上一轮的 ask_teacher 问题。按生产代码（resolveDecksmithClarificationAnswer）
     * 对上一轮的投影源判定关联结论，作为本轮 clarificationAnswer。
     */
    readonly answersQuestion?: boolean;
  };
  /** 脚本里用到的工具在录制时的参数 schema SHA-256；参数形状变化时必须重新核对脚本。 */
  readonly capturedWith: { readonly toolParameterSha256: Readonly<Record<string, string>> };
  readonly transcript: readonly DecksmithReplayTurn[];
  readonly services?: {
    readonly imageEdit?: readonly DecksmithReplayImageServiceStep[];
    readonly imageGenerate?: readonly DecksmithReplayImageServiceStep[];
  };
  readonly expect: {
    readonly changed: boolean;
    readonly outcome: {
      readonly mutationStatus: 'none' | 'proposal' | 'partial';
      readonly toolErrorCount: number;
    };
    readonly modelTurns: number;
    readonly toolResults?: readonly {
      readonly callId: string;
      readonly isError: boolean;
      readonly includes?: readonly string[];
    }[];
    readonly userPromptIncludes?: readonly string[];
    readonly userPromptExcludes?: readonly string[];
    readonly serviceCalls?: { readonly imageEdit?: number; readonly imageGenerate?: number };
  };
}

export interface DecksmithReplayMediaFile {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

export interface LoadedDecksmithReplayCase {
  readonly fixture: DecksmithReplayCase;
  readonly document: ReachDeckDocument;
  readonly media: ReadonlyMap<string, DecksmithReplayMediaFile>;
  readonly runInput: DecksmithRunInput;
}

export function listDecksmithReplayCaseIds(): string[] {
  return readdirSync(new URL('cases/', DECKSMITH_REPLAY_FIXTURE_ROOT))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

export function loadDecksmithReplayCase(id: string): LoadedDecksmithReplayCase {
  const fixture = readReplayFixtureJson<DecksmithReplayCase>(`cases/${id}.json`);
  if (fixture.schemaVersion !== DECKSMITH_REPLAY_CASE_SCHEMA_VERSION || fixture.id !== id) {
    throw new Error(`Decksmith replay case ${id} has an invalid header`);
  }
  const document = readReplayFixtureJson<ReachDeckDocument>(`documents/${fixture.document}`);
  const media = loadReplayMedia(document);
  return {
    fixture,
    document,
    media,
    runInput: { capability: REACH_DECK_DECKSMITH_CAPABILITY, document, ...fixture.request },
  };
}

/** 当前工具参数 schema 的 SHA-256（只看名称与参数，不看描述文案）。 */
export function decksmithToolParameterDigests(input: DecksmithRunInput): Record<string, string> {
  return Object.fromEntries(
    buildDecksmithInitialProviderInput(input).tools.map((tool) => [
      tool.function.name,
      sha256Hex(JSON.stringify(tool.function.parameters)),
    ]),
  );
}

/**
 * 教师在画布上的选区（入队时的 native-element 上下文引用，与 Teacher BFF 冻结的形状一致）。
 *
 * 数据源：基线文档的 pages 与 nativeSlides。核心逻辑：按选中顺序为每个元素生成
 * `reach-deck-decksmith-context-ref/v1`，基线带文档哈希、页修订与组件哈希；元素不存在时抛错（案例写错）。
 * 回放的跨轮投影与第②/③层评测的视觉输入授权（authorizeDecksmithVisualInputs）共用。
 */
export function buildReplaySelectionContextRefs(
  document: ReachDeckDocumentV2,
  pageId: string,
  selectedElementIds: readonly string[],
) {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) throw new Error(`replay page ${pageId} is missing`);
  const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
  const documentHash = buildDecksmithDocumentHash(document);
  return selectedElementIds.map((componentId) => {
    const component = slide?.elements.find((element) => element.id === componentId);
    if (component === undefined) throw new Error(`replay selection ${componentId} is missing`);
    return {
      schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
      kind: 'native-element' as const,
      pageId,
      pageLabel: page.title,
      pageOrder: document.pages.indexOf(page) + 1,
      pageRevision: page.revision,
      sceneId: pageId,
      sceneType: 'slide' as const,
      componentId,
      componentType: component.type,
      display: { label: component.type },
      baseline: {
        documentId: document.id,
        documentHash,
        pageRevision: page.revision,
        componentHash: buildStagedGenerationRequestHash(component),
      },
    };
  });
}

export function loadReplayMedia(
  document: ReachDeckDocument,
): Map<string, DecksmithReplayMediaFile> {
  const manifest = readReplayFixtureJson<{
    files: Record<string, { contentType: string; width: number; height: number; sha256: string }>;
  }>('media/manifest.json');
  const media = new Map<string, DecksmithReplayMediaFile>();
  for (const resource of document.resources.media) {
    if (!resource.objectKey.startsWith(DECKSMITH_REPLAY_OBJECT_KEY_PREFIX)) {
      throw new Error(`Replay media ${resource.objectKey} must use the synthetic replay prefix`);
    }
    const name = resource.objectKey.slice(DECKSMITH_REPLAY_OBJECT_KEY_PREFIX.length);
    const entry = manifest.files[name];
    // 非图片资源（讲稿音频等）只保留稳定 digest，不提供字节。
    if (entry === undefined) continue;
    const bytes = readReplayMediaFile(name);
    const digest = sha256Hex(bytes);
    if (digest !== entry.sha256 || resource.digest !== `sha256:${digest}`) {
      throw new Error(`Replay media ${name} checksum does not match its manifest or resource`);
    }
    media.set(resource.objectKey, { bytes, ...entry });
  }
  return media;
}

export function readReplayMediaFile(name: string): Buffer {
  return readFileSync(new URL(`media/${name}`, DECKSMITH_REPLAY_FIXTURE_ROOT));
}

export function readReplayFixtureJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, DECKSMITH_REPLAY_FIXTURE_ROOT), 'utf8')) as T;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
