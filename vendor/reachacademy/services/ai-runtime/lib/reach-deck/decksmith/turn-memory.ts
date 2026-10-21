import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';

import {
  DECKSMITH_CONTEXT_REF_HINT_CHARACTERS,
  DECKSMITH_PROPOSAL_OUTCOMES,
  type DecksmithContextRef,
  type DecksmithFrozenProjection,
  type DecksmithProposalOutcome,
} from './page-stream-contracts.js';
import {
  DECKSMITH_CLARIFICATION_LIMITS,
  parseReachDeckDecksmithClarification,
  type DecksmithClarificationAnswer,
  type ReachDeckDecksmithClarification,
} from './clarification-contract.js';

/**
 * Decksmith 跨轮记忆（WP1）的纯函数：答复截断、结构化变更清单、提案结局与 v2 历史条目文本。
 *
 * 数据源：只处理入参——`decksmith.result` 事件载荷、Run 的冻结输入与审批/采用事件（`ai_run_event`），
 * 以及提案前后的整文档；本模块不读写数据库。
 * 设计动机：投影、压缩与结果落库共用同一组有界格式化规则，保证入队测算与执行时重建逐字节一致。
 */

/** `decksmith.result.assistantText` 的 UTF-8 字节预算。 */
export const DECKSMITH_ASSISTANT_TEXT_BYTES = 1_500;
/** v2 助手条目中变更清单行的 UTF-8 字节预算。 */
export const DECKSMITH_CHANGE_LINE_BYTES = 700;
/** v2 助手条目中剩余任务块（WP4 预算收尾）的 UTF-8 字节预算。 */
export const DECKSMITH_REMAINING_TASKS_BLOCK_BYTES = 1_200;
/** v2 助手条目中结构化提问块（WP7）的 UTF-8 字节预算。 */
export const DECKSMITH_CLARIFICATION_BLOCK_BYTES = 1_200;
/** v2 教师条目中选区描述行的 UTF-8 字节预算。 */
export const DECKSMITH_CONTEXT_REF_LINE_BYTES = 500;
export const DECKSMITH_CHANGE_SUMMARY_SCHEMA_VERSION =
  'reach-deck-decksmith-change-summary/v1' as const;
/** 摘要 `proposalOutcomes` 中由服务端写入的结构化条目标记。 */
export const DECKSMITH_SUMMARY_PROPOSAL_OUTCOME_KIND = 'decksmith-proposal-outcome' as const;

const CHANGE_SUMMARY_LIMITS = Object.freeze({ pages: 40, elementsPerPage: 40, elements: 120 });
/** 变更清单里页标题的字符上限（事件载荷只需可读提示，格式化时还会再截到 40）。 */
const CHANGE_SUMMARY_TITLE_CHARACTERS = 120;
const ELLIPSIS = '…';
const URL_PATTERN = /\b(?:https?|data|blob):\S*/gi;

export type DecksmithChangeKind = 'added' | 'removed' | 'modified';

export interface DecksmithChangeSummary {
  readonly schemaVersion: typeof DECKSMITH_CHANGE_SUMMARY_SCHEMA_VERSION;
  readonly pages: readonly {
    readonly pageId: string;
    readonly sceneType: string;
    readonly title: string;
    readonly change: DecksmithChangeKind;
    readonly elements?: readonly {
      readonly id: string;
      readonly type: string;
      readonly change: DecksmithChangeKind;
    }[];
    /** 页级非元素字段：title、background、narration、animations、transition、notes、layoutId、duration、scene。 */
    readonly fields?: readonly string[];
  }[];
  readonly pagesReordered: boolean;
  readonly documentMetadataChanged: boolean;
  /** 页数或元素数超过上限、清单被截断时为 true。 */
  readonly truncated: boolean;
}

/**
 * 按 UTF-8 字节预算在字符边界截断，超出时以省略号结尾（省略号计入预算）。
 * 已在预算内的文本原样返回，因此重复截断是幂等的。
 */
export function truncateDecksmithUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength(ELLIPSIS, 'utf8');
  let used = 0;
  let output = '';
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > budget) break;
    output += character;
    used += size;
  }
  return output + ELLIPSIS;
}

/** 规范最终答复：去首尾空白，空文本视为无答复，超预算截断。 */
export function boundDecksmithAssistantText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return truncateDecksmithUtf8(trimmed, DECKSMITH_ASSISTANT_TEXT_BYTES);
}

/**
 * 比较提案前后的整文档，生成紧凑、有界的结构化变更清单（页 + 元素 id + 操作类型）。
 *
 * 数据源：Run 冻结基线文档与 Decksmith 会话产出的候选文档（均在内存中）。
 * 核心逻辑：
 * 1. 以 pageId 对齐 pages 与 nativeSlides，区分新增、删除、修改；顺序号与修订号不计入"修改"；
 * 2. 幻灯片页把元素（含组合内子元素）按 id 展开比较，记录元素的新增/删除/修改；
 * 3. 其余页级字段（背景、讲稿、动画、场景等）只记录字段名；
 * 4. 公共页的相对顺序变化记为 pagesReordered；超过页/元素上限时截断并标记 truncated。
 * 设计动机：不从各工具回执临时归纳，按最终 diff 得出可靠操作清单。
 */
export function buildDecksmithChangeSummary(
  baseline: ReachDeckDocument,
  result: ReachDeckDocument,
): DecksmithChangeSummary {
  const baselinePages = new Map(baseline.pages.map((page) => [page.pageId, page]));
  const resultPages = new Map(result.pages.map((page) => [page.pageId, page]));
  const baselineSlides = new Map(baseline.nativeSlides.map((binding) => [binding.pageId, binding]));
  const resultSlides = new Map(result.nativeSlides.map((binding) => [binding.pageId, binding]));
  const pages: Array<DecksmithChangeSummary['pages'][number]> = [];
  let truncated = false;
  let elementBudget = CHANGE_SUMMARY_LIMITS.elements;
  const push = (entry: DecksmithChangeSummary['pages'][number]) => {
    if (pages.length >= CHANGE_SUMMARY_LIMITS.pages) {
      truncated = true;
      return;
    }
    pages.push(entry);
  };
  for (const page of [...result.pages].sort((left, right) => left.order - right.order)) {
    const before = baselinePages.get(page.pageId);
    if (before === undefined) {
      push({
        pageId: page.pageId,
        sceneType: page.sceneType,
        title: plainText(page.title, CHANGE_SUMMARY_TITLE_CHARACTERS),
        change: 'added',
      });
      continue;
    }
    const fields: string[] = [];
    if (before.title !== page.title) fields.push('title');
    let elements: Array<{ id: string; type: string; change: DecksmithChangeKind }> = [];
    if (page.sceneType === 'slide' || before.sceneType === 'slide') {
      const beforeSlide = baselineSlides.get(page.pageId)?.slide;
      const afterSlide = resultSlides.get(page.pageId)?.slide;
      if (before.sceneType !== page.sceneType) fields.push('scene');
      for (const field of [
        'background',
        'narration',
        'animations',
        'transition',
        'notes',
        'layoutId',
        'duration',
      ] as const) {
        if (stableJson(beforeSlide?.[field]) !== stableJson(afterSlide?.[field])) {
          fields.push(field);
        }
      }
      elements = diffElements(beforeSlide?.elements ?? [], afterSlide?.elements ?? []);
    } else if ('scene' in page && 'scene' in before) {
      const { narration: beforeNarration, ...beforeScene } = before.scene as unknown as Record<
        string,
        unknown
      >;
      const { narration: afterNarration, ...afterScene } = page.scene as unknown as Record<
        string,
        unknown
      >;
      if (before.sceneType !== page.sceneType || stableJson(beforeScene) !== stableJson(afterScene))
        fields.push('scene');
      if (stableJson(beforeNarration) !== stableJson(afterNarration)) fields.push('narration');
    }
    if (fields.length === 0 && elements.length === 0) continue;
    if (
      elements.length > CHANGE_SUMMARY_LIMITS.elementsPerPage ||
      elements.length > elementBudget
    ) {
      truncated = true;
      elements = elements.slice(
        0,
        Math.min(CHANGE_SUMMARY_LIMITS.elementsPerPage, Math.max(0, elementBudget)),
      );
    }
    elementBudget -= elements.length;
    push({
      pageId: page.pageId,
      sceneType: page.sceneType,
      title: plainText(page.title, CHANGE_SUMMARY_TITLE_CHARACTERS),
      change: 'modified',
      ...(elements.length === 0 ? {} : { elements }),
      ...(fields.length === 0 ? {} : { fields }),
    });
  }
  for (const page of [...baseline.pages].sort((left, right) => left.order - right.order)) {
    if (resultPages.has(page.pageId)) continue;
    push({
      pageId: page.pageId,
      sceneType: page.sceneType,
      title: plainText(page.title, CHANGE_SUMMARY_TITLE_CHARACTERS),
      change: 'removed',
    });
  }
  const commonBefore = [...baseline.pages]
    .sort((left, right) => left.order - right.order)
    .map((page) => page.pageId)
    .filter((pageId) => resultPages.has(pageId));
  const commonAfter = [...result.pages]
    .sort((left, right) => left.order - right.order)
    .map((page) => page.pageId)
    .filter((pageId) => baselinePages.has(pageId));
  return {
    schemaVersion: DECKSMITH_CHANGE_SUMMARY_SCHEMA_VERSION,
    pages,
    pagesReordered: commonBefore.join('\n') !== commonAfter.join('\n'),
    documentMetadataChanged:
      stableJson({ title: baseline.title, stage: baseline.stage, theme: baseline.theme }) !==
      stableJson({ title: result.title, stage: result.stage, theme: result.theme }),
    truncated,
  };
}

function diffElements(
  before: readonly unknown[],
  after: readonly unknown[],
): Array<{ id: string; type: string; change: DecksmithChangeKind }> {
  const beforeMap = flattenElements(before);
  const afterMap = flattenElements(after);
  const changes: Array<{ id: string; type: string; change: DecksmithChangeKind }> = [];
  for (const [id, element] of afterMap) {
    const previous = beforeMap.get(id);
    if (previous === undefined) changes.push({ id, type: element.type, change: 'added' });
    else if (previous.json !== element.json) {
      changes.push({ id, type: element.type, change: 'modified' });
    }
  }
  for (const [id, element] of beforeMap) {
    if (!afterMap.has(id)) changes.push({ id, type: element.type, change: 'removed' });
  }
  return changes;
}

/** 按 id 展开元素；组合元素自身只比较除 children 外的字段，子元素单独比较。 */
function flattenElements(
  elements: readonly unknown[],
  output = new Map<string, { type: string; json: string }>(),
): Map<string, { type: string; json: string }> {
  for (const value of elements) {
    if (typeof value !== 'object' || value === null) continue;
    const { children, ...own } = value as Record<string, unknown>;
    if (typeof own.id === 'string') {
      output.set(own.id, {
        type: typeof own.type === 'string' ? own.type : 'element',
        json: stableJson(own),
      });
    }
    if (Array.isArray(children)) flattenElements(children, output);
  }
  return output;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

/** 宽松解析事件载荷里的变更清单；结构不符时返回 undefined（旧事件或未来版本不影响投影）。 */
export function readDecksmithChangeSummary(value: unknown): DecksmithChangeSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== DECKSMITH_CHANGE_SUMMARY_SCHEMA_VERSION ||
    !Array.isArray(record.pages) ||
    typeof record.pagesReordered !== 'boolean' ||
    typeof record.documentMetadataChanged !== 'boolean' ||
    typeof record.truncated !== 'boolean'
  ) {
    return undefined;
  }
  const pages = record.pages.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const page = entry as Record<string, unknown>;
    if (
      typeof page.pageId !== 'string' ||
      typeof page.sceneType !== 'string' ||
      typeof page.title !== 'string' ||
      !['added', 'removed', 'modified'].includes(String(page.change))
    ) {
      return [];
    }
    const elements = Array.isArray(page.elements)
      ? page.elements.flatMap((candidate) => {
          if (typeof candidate !== 'object' || candidate === null) return [];
          const element = candidate as Record<string, unknown>;
          return typeof element.id === 'string' &&
            typeof element.type === 'string' &&
            ['added', 'removed', 'modified'].includes(String(element.change))
            ? [
                {
                  id: element.id,
                  type: element.type,
                  change: element.change as DecksmithChangeKind,
                },
              ]
            : [];
        })
      : [];
    const fields = Array.isArray(page.fields)
      ? page.fields.filter((field): field is string => typeof field === 'string')
      : [];
    return [
      {
        pageId: page.pageId,
        sceneType: page.sceneType,
        title: page.title,
        change: page.change as DecksmithChangeKind,
        ...(elements.length === 0 ? {} : { elements }),
        ...(fields.length === 0 ? {} : { fields }),
      },
    ];
  });
  return {
    schemaVersion: DECKSMITH_CHANGE_SUMMARY_SCHEMA_VERSION,
    pages,
    pagesReordered: record.pagesReordered,
    documentMetadataChanged: record.documentMetadataChanged,
    truncated: record.truncated,
  };
}

/** 把变更清单渲染成一行有界英文（模型侧结构提示），无变更时返回 undefined。 */
export function formatDecksmithChangeSummary(
  summary: DecksmithChangeSummary | undefined,
): string | undefined {
  if (summary === undefined) return undefined;
  const parts = summary.pages.map((page) => {
    const head = `${page.sceneType} page "${plainText(page.title, 40)}" [${page.pageId}]`;
    if (page.change !== 'modified') return `${head} ${page.change}`;
    const details = [
      ...(page.elements ?? []).map((element) => `${element.type} ${element.id} ${element.change}`),
      ...(page.fields ?? []).map((field) => `${field} changed`),
    ];
    return details.length === 0 ? `${head} modified` : `${head} modified (${details.join(', ')})`;
  });
  if (summary.pagesReordered) parts.push('page order changed');
  if (summary.documentMetadataChanged) parts.push('deck title/stage/theme changed');
  if (summary.truncated) parts.push('more changes omitted');
  if (parts.length === 0) return undefined;
  return truncateDecksmithUtf8(
    `Proposed changes: ${parts.join('; ')}.`,
    DECKSMITH_CHANGE_LINE_BYTES,
  );
}

/**
 * 从单个 Run 的事件推导提案结局（入队时冻结进快照，见 snapshotDecksmithProposalOutcomes）。
 *
 * 数据源：该 Run 的 `artifact.proposed` / `approval.required` / `approval.decided` /
 * `artifact.applied` 事件（`ai_run_event`）。
 * 核心逻辑：按事件顺序取最后一个决定性事件——
 * 1. WP8 起 applied 事件带持久化的真实结局 outcome（adopted / superseded / stale），直接采用；
 * 2. 旧 applied 事件没有 outcome：带 supersededByTeacherEdit / supersededByDeckChange 标记为 superseded，
 *    无标记为 approved（保持 WP1 的旧来源，不重新解释旧事件）；
 * 3. decided 取其 decision；只有提案没有决定时为 pending；没有提案返回 undefined。
 * 设计动机：推导只在入队时执行，已冻结的 Run 按快照重建投影，所以新结局来源只影响新 Run（评审 M1）。
 */
export function deriveDecksmithProposalOutcome(
  events: readonly { readonly type: string; readonly payload: Readonly<Record<string, unknown>> }[],
): DecksmithProposalOutcome | undefined {
  let proposed = false;
  let outcome: DecksmithProposalOutcome | undefined;
  for (const event of events) {
    if (event.type === 'artifact.proposed' || event.type === 'approval.required') proposed = true;
    if (event.type === 'approval.decided') {
      proposed = true;
      if (event.payload.decision === 'rejected') outcome = 'rejected';
      else if (event.payload.decision === 'approved') outcome = 'approved';
    }
    if (event.type === 'artifact.applied') {
      proposed = true;
      const persisted = event.payload.outcome;
      outcome =
        persisted === 'adopted' || persisted === 'superseded' || persisted === 'stale'
          ? persisted
          : event.payload.supersededByTeacherEdit === true ||
              event.payload.supersededByDeckChange !== undefined
            ? 'superseded'
            : 'approved';
    }
  }
  return outcome ?? (proposed ? 'pending' : undefined);
}

const OUTCOME_LINES: Readonly<Record<DecksmithProposalOutcome, string>> = Object.freeze({
  approved: 'Proposal outcome: approved; the teacher adopted these changes into the deck.',
  rejected:
    'Proposal outcome: rejected; the teacher rejected these changes, so the deck does not contain them.',
  pending:
    'Proposal outcome: pending; the teacher had not decided yet, so these changes were not in the deck at that time.',
  superseded:
    'Proposal outcome: superseded; later teacher edits replaced this proposal, so these changes are not in the deck.',
  adopted:
    'Proposal outcome: adopted; the teacher adopted these changes and they were saved into the deck.',
  stale:
    'Proposal outcome: stale; the deck structure changed before these changes could be saved, so they were closed without being applied.',
});

export function formatDecksmithProposalOutcome(outcome: DecksmithProposalOutcome): string {
  return OUTCOME_LINES[outcome];
}

/**
 * v2 助手条目：实际答复（旧事件回退为 result 套话）+ 变更清单 + 结局行。
 */
export function formatDecksmithAssistantEntry(input: {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly outcome?: DecksmithProposalOutcome;
}): string | undefined {
  const reply =
    typeof input.payload.assistantText === 'string'
      ? boundDecksmithAssistantText(input.payload.assistantText)
      : undefined;
  const fallback = typeof input.payload.message === 'string' ? input.payload.message : undefined;
  const head = reply ?? fallback;
  if (head === undefined) return undefined;
  const changes = formatDecksmithChangeSummary(
    readDecksmithChangeSummary(input.payload.changeSummary),
  );
  // 模型答复可能声称做了实际未成功的修改；有答复时补一行服务端如实结果（套话本身已包含这些事实）。
  const factual = reply === undefined ? undefined : decksmithFactualResultLine(input.payload);
  const remaining = formatDecksmithRemainingTasks(input.payload);
  const clarification = formatDecksmithClarificationBlock(input.payload);
  return [
    head,
    ...(factual === undefined ? [] : [factual]),
    ...(changes === undefined ? [] : [changes]),
    ...(input.outcome === undefined ? [] : [formatDecksmithProposalOutcome(input.outcome)]),
    ...(remaining === undefined ? [] : [remaining]),
    ...(clarification === undefined ? [] : [clarification]),
  ].join('\n');
}

/** 宽松读取事件载荷里的 outcome.clarification；缺省或不合法（旧事件、未来版本）时返回 undefined。 */
export function readDecksmithResultClarification(
  payload: Readonly<Record<string, unknown>>,
): ReachDeckDecksmithClarification | undefined {
  const outcome = payload.outcome;
  if (typeof outcome !== 'object' || outcome === null) return undefined;
  const value = (outcome as Record<string, unknown>).clarification;
  if (value === undefined) return undefined;
  try {
    return parseReachDeckDecksmithClarification(value);
  } catch {
    return undefined;
  }
}

/**
 * 结构化提问块（WP7）：本轮向教师提出的问题、选项与候选（类型 + alt/文本前缀 + 所在页与修订），
 * 供下一轮在教师回答时接上。旧事件没有 clarification 时返回 undefined，投影文本保持不变。
 *
 * 数据源：`decksmith.result` 事件载荷的 outcome.clarification（服务端写入时已校验并有界）。
 * 核心逻辑：
 * 1. 首行带问题 id 与期望的回答方式，id 在行首，截断不会丢失；
 * 2. 选项与候选各一行，候选只用有界纯文本标签；
 * 3. 整块按 UTF-8 字节预算截断，保证入队与执行时逐字节一致。
 */
function formatDecksmithClarificationBlock(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const clarification = readDecksmithResultClarification(payload);
  if (clarification === undefined) return undefined;
  const lines = [
    `Question asked to the teacher [${clarification.questionId}] (expects ${clarification.expect}): ${plainText(clarification.question, DECKSMITH_CLARIFICATION_LIMITS.questionCharacters)}`,
  ];
  if (clarification.options.length > 0) {
    lines.push(
      `Options: ${clarification.options.map((option) => plainText(option, DECKSMITH_CLARIFICATION_LIMITS.optionCharacters)).join(' | ')}`,
    );
  }
  if (clarification.candidates.length > 0) {
    lines.push(
      `Candidates: ${clarification.candidates
        .map(
          (candidate) =>
            `${candidate.elementId}: ${plainText(candidate.label, DECKSMITH_CLARIFICATION_LIMITS.labelCharacters)} (page ${candidate.pageId}, revision ${candidate.pageRevision})`,
        )
        .join('; ')}`,
    );
  }
  lines.push('The turn ended with this question; nothing was changed.');
  return truncateDecksmithUtf8(lines.join('\n'), DECKSMITH_CLARIFICATION_BLOCK_BYTES);
}

/**
 * 预算收尾（WP4）留下的剩余任务块，供下一轮"继续"接着做；旧事件没有 remainingTasks 时返回 undefined，
 * 投影文本保持不变。
 *
 * 数据源：`decksmith.result` 事件载荷的 outcome.remainingTasks（服务端写入时已有界）。
 * 核心逻辑：
 * 1. 只取非空字符串条目，最多 8 条；
 * 2. 标题行提醒模型按当前课件重新定位页面，未采用提案里新建的页面并不存在；
 * 3. 整块按 UTF-8 字节预算截断，保证投影窗口有界且入队与执行时逐字节一致。
 */
function formatDecksmithRemainingTasks(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const outcome = payload.outcome;
  const raw =
    typeof outcome === 'object' && outcome !== null
      ? (outcome as Record<string, unknown>).remainingTasks
      : undefined;
  if (!Array.isArray(raw)) return undefined;
  const tasks = raw
    .filter((task): task is string => typeof task === 'string' && task.trim().length > 0)
    .slice(0, 8)
    .map((task) => `- ${plainText(task, 300)}`);
  if (tasks.length === 0) return undefined;
  const stopReason = decksmithStepLimited(outcome) ? 'its step limit' : 'its token budget';
  return truncateDecksmithUtf8(
    [
      `Remaining tasks when this turn stopped on ${stopReason} (re-locate them in the current deck; pages created only by a proposal that was not adopted do not exist):`,
      ...tasks,
    ].join('\n'),
    DECKSMITH_REMAINING_TASKS_BLOCK_BYTES,
  );
}

/** 结果是否为轮数截断（completion.state = step-limited）；旧事件与额度收尾都返回 false。 */
function decksmithStepLimited(outcome: unknown): boolean {
  if (typeof outcome !== 'object' || outcome === null) return false;
  const completion = (outcome as Record<string, unknown>).completion;
  return (
    typeof completion === 'object' &&
    completion !== null &&
    (completion as Record<string, unknown>).state === 'step-limited'
  );
}

/**
 * 服务端如实结果行：未产生修改或有工具失败时给出；正常产生提案时由变更清单行表达，返回 undefined。
 *
 * 数据源：`decksmith.result` 事件载荷的 changed 与 outcome.toolErrorCount。
 */
function decksmithFactualResultLine(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const outcome = payload.outcome;
  const rawErrors =
    typeof outcome === 'object' && outcome !== null
      ? (outcome as Record<string, unknown>).toolErrorCount
      : undefined;
  const toolErrors =
    Number.isSafeInteger(rawErrors) && Number(rawErrors) > 0 ? Number(rawErrors) : 0;
  const failures =
    toolErrors === 0 ? '' : `; ${toolErrors} tool operation${toolErrors === 1 ? '' : 's'} failed`;
  const budgetLimited =
    typeof outcome === 'object' &&
    outcome !== null &&
    typeof (outcome as Record<string, unknown>).completion === 'object' &&
    (outcome as Record<string, unknown>).completion !== null
      ? decksmithStepLimited(outcome)
        ? '; the turn stopped early because it reached its step limit'
        : '; the turn stopped early because its token budget ran out'
      : '';
  if (payload.changed === false) {
    return `Result: this turn proposed no deck changes${failures}${budgetLimited}.`;
  }
  if (payload.changed === true && (toolErrors > 0 || budgetLimited !== '')) {
    return `Result: only a partial proposal was produced${failures}${budgetLimited}.`;
  }
  return undefined;
}

/**
 * v2 教师条目：教师原话 + 当轮选区的可读描述（类型 + alt/文本前缀 + 所在页），不含 URL 或 base64。
 * 对话本身按页归档，指向来源页本身的整页引用不再重复描述。
 */
export function formatDecksmithTeacherEntry(input: {
  readonly message: string;
  readonly contextRefs: readonly DecksmithContextRef[];
  readonly hints?: DecksmithFrozenProjection['contextRefHints'];
  readonly originPageId?: string;
  /** WP7：本条消息回答的问题；缺省时条目文本与此前逐字节一致。 */
  readonly clarificationAnswer?: DecksmithClarificationAnswer;
}): string {
  const message =
    input.clarificationAnswer === undefined
      ? input.message
      : `${input.message}\n${formatDecksmithClarificationAnswerLine(input.clarificationAnswer)}`;
  const refs = input.contextRefs.filter(
    (ref) => !(ref.kind === 'page' && ref.pageId === input.originPageId),
  );
  if (refs.length === 0) return message;
  const described = refs.map((ref) => {
    if (ref.kind === 'page') {
      return `page ${ref.order} "${plainText(ref.label, 40)}" [${ref.pageId}]`;
    }
    const hint =
      input.hints?.find(
        (candidate) => candidate.pageId === ref.pageId && candidate.componentId === ref.componentId,
      )?.hint ??
      ref.display.detail ??
      (ref.display.label !== ref.componentType && ref.display.label !== ref.componentId
        ? ref.display.label
        : undefined);
    const text =
      hint === undefined ? '' : ` "${plainText(hint, DECKSMITH_CONTEXT_REF_HINT_CHARACTERS)}"`;
    return `${ref.componentType} ${ref.componentId}${text} on page ${ref.pageOrder} "${plainText(ref.pageLabel, 40)}"`;
  });
  return `${message}\n${truncateDecksmithUtf8(
    `(Teacher had selected: ${described.join('; ')})`,
    DECKSMITH_CONTEXT_REF_LINE_BYTES,
  )}`;
}

/** 教师条目里的回答关联行：回答了哪个问题，或引用的问题已不再待回答。 */
export function formatDecksmithClarificationAnswerLine(
  answer: DecksmithClarificationAnswer,
): string {
  switch (answer.status) {
    case 'answered':
      return `(Answer to Decksmith question [${answer.questionId}])`;
    case 'duplicate':
      return `(Refers to Decksmith question [${answer.questionId}], which an earlier reply already answered)`;
    case 'stale':
      return `(Refers to Decksmith question [${answer.questionId}], which was no longer open)`;
  }
}

/**
 * 原生元素的可读标签：类型 + alt（图片）或文本前缀，用于提问候选。只保留有界纯文本，不含 URL 或资源标识。
 *
 * 数据源：Decksmith 会话里的当前文档（内存）。元素不在该页时返回 undefined。
 */
export function describeDecksmithNativeElement(
  document: ReachDeckDocument,
  pageId: string,
  elementId: string,
  maxCharacters: number,
): { readonly type: string; readonly label: string } | undefined {
  const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
  const element = slide === undefined ? undefined : findElement(slide.elements, elementId);
  if (element === undefined) return undefined;
  const type = typeof element.type === 'string' ? element.type : 'element';
  const raw =
    element.type === 'image' && typeof element.alt === 'string'
      ? element.alt
      : collectText(element).join(' ');
  const detail = plainText(raw, Math.max(0, maxCharacters - type.length - 3));
  return {
    type,
    label:
      detail.length === 0
        ? `${type} ${plainText(elementId, maxCharacters - type.length - 1)}`
        : `${type} "${detail}"`,
  };
}

/**
 * 从入队时的基线文档为本轮选中元素派生可读提示：图片取 alt，含文字的元素取文本前缀。
 * 只保留有界纯文本，不保留 URL、base64 或资源标识。
 */
export function buildDecksmithContextRefHints(
  document: ReachDeckDocument,
  refs: readonly DecksmithContextRef[],
): DecksmithFrozenProjection['contextRefHints'] {
  const hints = refs.flatMap((ref) => {
    if (ref.kind !== 'native-element') return [];
    const slide = document.nativeSlides.find((binding) => binding.pageId === ref.pageId)?.slide;
    const element = slide === undefined ? undefined : findElement(slide.elements, ref.componentId);
    if (element === undefined) return [];
    const raw =
      element.type === 'image' && typeof element.alt === 'string'
        ? element.alt
        : collectText(element).join(' ');
    const hint = plainText(raw, DECKSMITH_CONTEXT_REF_HINT_CHARACTERS);
    return hint.length === 0 ? [] : [{ pageId: ref.pageId, componentId: ref.componentId, hint }];
  });
  return hints.length === 0 ? undefined : hints;
}

function findElement(
  elements: readonly unknown[],
  id: string,
): Record<string, unknown> | undefined {
  for (const value of elements) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.id === id) return record;
    if (Array.isArray(record.children)) {
      const found = findElement(record.children, id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function collectText(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 12 || output.join(' ').length > 400) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object' || value === null) return output;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'text' && typeof child === 'string') output.push(child);
    else if (typeof child === 'object') collectText(child, output, depth + 1);
  }
  return output;
}

/**
 * 单行纯文本：去 URL、压缩空白、按字符上限截断。
 * 上限按 UTF-16 码元计（与冻结合同 `boundedString` 的 `length` 校验一致），但只在码点边界截断，
 * 不会拆开代理对；否则含 emoji / 扩展汉字的长 alt 文本会让冻结输入校验失败、整轮无法入队。
 */
function plainText(value: string, maxCharacters: number): string {
  const normalized = value.replace(URL_PATTERN, '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxCharacters) return normalized;
  const budget = maxCharacters - ELLIPSIS.length;
  let output = '';
  for (const character of normalized) {
    if (output.length + character.length > budget) break;
    output += character;
  }
  return `${output}${ELLIPSIS}`;
}

export interface DecksmithSummaryProposalOutcome {
  readonly kind: typeof DECKSMITH_SUMMARY_PROPOSAL_OUTCOME_KIND;
  readonly runId: string;
  readonly sequence: number;
  readonly outcome: DecksmithProposalOutcome;
}

/** 识别摘要 `proposalOutcomes` 中服务端写入的结构化条目；模型自由生成的旧条目被忽略。 */
export function readDecksmithSummaryProposalOutcomes(
  values: readonly Readonly<Record<string, unknown>>[],
): DecksmithSummaryProposalOutcome[] {
  return values.flatMap((value) =>
    value.kind === DECKSMITH_SUMMARY_PROPOSAL_OUTCOME_KIND &&
    typeof value.runId === 'string' &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    DECKSMITH_PROPOSAL_OUTCOMES.includes(value.outcome as DecksmithProposalOutcome)
      ? [
          {
            kind: DECKSMITH_SUMMARY_PROPOSAL_OUTCOME_KIND,
            runId: value.runId,
            sequence: value.sequence as number,
            outcome: value.outcome as DecksmithProposalOutcome,
          },
        ]
      : [],
  );
}

/**
 * 摘要正文 + 冻结的"结局更新"行。无更新时原样返回，旧 Run 与无更新的新 Run 文本不变。
 */
export function decksmithSummaryContextText(
  text: string,
  updates: DecksmithFrozenProjection['summaryOutcomeUpdates'],
): string {
  if (updates === undefined || updates.length === 0) return text;
  return [
    text,
    'Outcome updates for proposals that were still pending when this summary was written:',
    ...updates.map(
      (update) =>
        `- Turn ${update.sequence}: ${formatDecksmithProposalOutcome(update.outcome).replace(/^Proposal outcome: /, '')}`,
    ),
  ].join('\n');
}
