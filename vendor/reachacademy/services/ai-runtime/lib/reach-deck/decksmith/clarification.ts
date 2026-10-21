import { createHash } from 'node:crypto';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';

import {
  DECKSMITH_CLARIFICATION_EXPECTS,
  DECKSMITH_CLARIFICATION_LIMITS,
  parseReachDeckDecksmithClarification,
  type DecksmithClarificationAnswer,
  type DecksmithClarificationExpect,
  type ReachDeckDecksmithClarification,
} from './clarification-contract.js';
import { parseDecksmithFrozenRunInput } from './page-stream-contracts.js';
import { DecksmithSessionError, type DecksmithDocumentSession } from './session.js';
import type { DecksmithProjectionSource } from './turn-projection.js';
import { describeDecksmithNativeElement, readDecksmithResultClarification } from './turn-memory.js';

/**
 * Decksmith 结构化提问（WP7 第一阶段 / 评审 M11）的运行时部分：ask_teacher 工具、问题 id、
 * 下一轮回答的关联判定与模型提示行。
 *
 * 停止语义：
 * - 只允许在本次运行首个修改（会话文档变更或 Interactive 工作副本未提交修改）之前提问；已有修改时
 *   返回非错误的拒绝诊断，模型必须收尾并如实报告，修改不会被静默丢弃；
 * - 提问成功后 agent.ts 的工具包装阻断同批后续全部调用（pi 会执行整批工具），并在本回合后停止，
 *   不再调用模型；结果没有提案，outcome 带 clarification，Run 正常结束并释放租约。
 */

export const DECKSMITH_ASK_TEACHER_TOOL_NAME = 'ask_teacher';
export const DECKSMITH_ASK_TEACHER_AFTER_CHANGE = 'DECKSMITH_ASK_TEACHER_AFTER_CHANGE';
export const DECKSMITH_BLOCKED_BY_QUESTION = 'DECKSMITH_BLOCKED_BY_QUESTION';

/** 由 Run id 派生稳定的问题 id：同一 Run 重试仍得到同一 id，不同 Run 互不相同。 */
export function buildDecksmithClarificationQuestionId(runId: string): string {
  return `dq_${createHash('sha256')
    .update(`reach-deck-decksmith-clarification/v1\n${runId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export interface DecksmithAskTeacherDependencies {
  /** 本次运行的问题 id（buildDecksmithClarificationQuestionId）。 */
  readonly questionId: string;
  /** 教师当前所在页；候选缺省在这一页上查找。 */
  readonly originPageId?: string;
  /** 本次运行是否已有修改（会话文档已变或有未提交的 Interactive 工作副本）。 */
  readonly hasMutation: () => boolean;
  /** 提问成功时回调；之后同批工具一律不执行。 */
  readonly onAsked: (clarification: ReachDeckDecksmithClarification) => void;
}

/**
 * ask_teacher 工具。
 *
 * 数据源：Decksmith 内存会话里的当前文档（候选元素与页修订）；不访问外部服务。
 * 核心逻辑：
 * 1. 本次运行已有修改 → 返回 DECKSMITH_ASK_TEACHER_AFTER_CHANGE（不是工具错误），要求收尾报告；
 * 2. 校验问题、选项（≤5、去重、简短）与 expect 的搭配（choice ≥2 个选项，select-element ≥1 个候选）；
 * 3. 候选 id 必须是所述页（缺省为当前页）上真实存在的原生元素，派生"类型 + alt/文本前缀"标签与页修订；
 * 4. 生成 clarification 并回调，工具结果带 terminate，本回合后不再调用模型。
 */
export function createDecksmithAskTeacherTool(
  session: DecksmithDocumentSession,
  dependencies: DecksmithAskTeacherDependencies | undefined,
): AgentTool {
  return {
    name: DECKSMITH_ASK_TEACHER_TOOL_NAME,
    label: '向教师提问',
    description: [
      'Ask the teacher one clarifying question and end this turn without changing anything. The teacher sees a card with your question, optional short option buttons, and for expect "select-element" the candidate elements to pick; their reply arrives as the next request.',
      'Call it only before any change in this run and on its own: other tool calls after it in the same response are not executed, and after a change it is refused.',
      'expect "choice" needs at least two options; expect "select-element" needs candidateElementIds that exist on pageId (default: the current page); expect "text" asks for a free-text answer.',
    ].join(' '),
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        maxLength: DECKSMITH_CLARIFICATION_LIMITS.questionCharacters,
      }),
      options: Type.Optional(
        Type.Array(
          Type.String({ minLength: 1, maxLength: DECKSMITH_CLARIFICATION_LIMITS.optionCharacters }),
          { maxItems: DECKSMITH_CLARIFICATION_LIMITS.options },
        ),
      ),
      candidateElementIds: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          maxItems: DECKSMITH_CLARIFICATION_LIMITS.candidates,
        }),
      ),
      pageId: Type.Optional(Type.String({ minLength: 1 })),
      expect: Type.Union(DECKSMITH_CLARIFICATION_EXPECTS.map((value) => Type.Literal(value))),
    }),
    execute: async (_toolCallId, params) => {
      if (dependencies === undefined) {
        throw new Error('Decksmith capacity measurement cannot execute ask_teacher');
      }
      if (dependencies.hasMutation()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                asked: false,
                code: DECKSMITH_ASK_TEACHER_AFTER_CHANGE,
                note: 'Not asked: this run has already changed the deck, and a question now would hide those changes. Finish the request with the changes you made, or stop and report in your final reply what you changed and what is still unclear.',
              }),
            },
          ],
          details: { askRefused: true },
        };
      }
      const clarification = buildClarification(session, dependencies, params);
      dependencies.onAsked(clarification);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              asked: true,
              questionId: clarification.questionId,
              note: 'The question card is shown to the teacher. This turn ends now; nothing else in this response runs.',
            }),
          },
        ],
        details: { clarification: true },
        terminate: true,
      };
    },
  };
}

function buildClarification(
  session: DecksmithDocumentSession,
  dependencies: DecksmithAskTeacherDependencies,
  params: unknown,
): ReachDeckDecksmithClarification {
  const input = params as {
    question: string;
    options?: string[];
    candidateElementIds?: string[];
    pageId?: string;
    expect: DecksmithClarificationExpect;
  };
  const question = input.question.trim();
  if (question.length === 0) throw new DecksmithSessionError('ask_teacher question is blank.');
  const options = [...new Set((input.options ?? []).map((option) => option.trim()))].filter(
    (option) => option.length > 0,
  );
  const ids = [...new Set(input.candidateElementIds ?? [])];
  const pageId = input.pageId ?? dependencies.originPageId;
  const candidates =
    ids.length === 0
      ? []
      : (() => {
          if (pageId === undefined) {
            throw new DecksmithSessionError(
              'ask_teacher candidateElementIds need pageId when there is no current page.',
            );
          }
          const page = session.readPageView(pageId);
          return ids.map((elementId) => {
            const described = describeDecksmithNativeElement(
              session.document,
              pageId,
              elementId,
              DECKSMITH_CLARIFICATION_LIMITS.labelCharacters,
            );
            if (described === undefined) {
              throw new DecksmithSessionError(
                `ask_teacher candidate ${elementId} is not an element on page ${pageId}; list only element ids that exist on that page.`,
              );
            }
            return { pageId, pageRevision: page.revision, elementId, label: described.label };
          });
        })();
  if (input.expect === 'choice' && options.length < 2) {
    throw new DecksmithSessionError('ask_teacher expect "choice" needs at least two options.');
  }
  if (input.expect === 'select-element' && candidates.length === 0) {
    throw new DecksmithSessionError(
      'ask_teacher expect "select-element" needs candidateElementIds on the stated page.',
    );
  }
  return parseReachDeckDecksmithClarification({
    questionId: dependencies.questionId,
    question,
    options,
    candidates,
    expect: input.expect,
  });
}

/** 被提问阻断的同批工具调用结果：不执行、不计错，本回合后停止。 */
export function decksmithBlockedByQuestionToolResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          applied: false,
          code: DECKSMITH_BLOCKED_BY_QUESTION,
          note: 'Not executed: ask_teacher ended this turn; the teacher answers first.',
        }),
      },
    ],
    details: { blockedByQuestion: true },
    terminate: true,
  };
}

/**
 * 判定教师本条消息与所答问题的关系（入队时调用，结论冻结进 Run 输入）。
 *
 * 数据源：入队时的页面流压缩快照（当前话题 epoch 内、摘要截止点之后的各 Run 冻结输入与
 * `decksmith.result` 事件，来自 `ai_run` / `ai_run_event`）。
 * 核心逻辑：
 * 1. 只看当前 epoch 的回合，按页面流序号排序；找出结果里带该 questionId 的提问回合；
 * 2. 找不到（新话题、已压缩进摘要或 id 不属于本页面流）→ stale；
 * 3. 提问回合之后已有回合（失败/取消的不计）且其中一轮已回答它 → duplicate，否则 → stale；
 * 4. 提问回合就是最近一轮 → answered，附问题原文。
 * 设计动机：过期或重复回答不让请求失败，只在模型输入里给出明确说明，由模型按当前课件重新判断。
 */
export function resolveDecksmithClarificationAnswer(input: {
  readonly items: readonly DecksmithProjectionSource[];
  readonly epoch: number;
  readonly questionId: string;
}): DecksmithClarificationAnswer {
  const turns = input.items
    .flatMap((item) => {
      try {
        const frozen = parseDecksmithFrozenRunInput(item.input);
        return frozen.stream.epoch === input.epoch
          ? [{ item, frozen, sequence: frozen.stream.sequence }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.sequence - right.sequence);
  let askingIndex = -1;
  let question: string | undefined;
  for (const [index, turn] of turns.entries()) {
    const result = [...turn.item.events]
      .reverse()
      .find((event) => event.type === 'decksmith.result');
    const clarification =
      result === undefined ? undefined : readDecksmithResultClarification(result.payload);
    if (clarification?.questionId === input.questionId) {
      askingIndex = index;
      question = clarification.question;
    }
  }
  if (askingIndex < 0 || question === undefined) {
    return { questionId: input.questionId, status: 'stale' };
  }
  const later = turns
    .slice(askingIndex + 1)
    .filter((turn) => turn.item.status !== 'failed' && turn.item.status !== 'cancelled');
  if (
    later.some(
      (turn) =>
        turn.frozen.clarificationAnswer?.questionId === input.questionId &&
        turn.frozen.clarificationAnswer.status === 'answered',
    )
  ) {
    return { questionId: input.questionId, status: 'duplicate' };
  }
  if (later.length > 0) return { questionId: input.questionId, status: 'stale' };
  return { questionId: input.questionId, status: 'answered', question };
}

/** 首条用户消息里的回答关联说明（只在本轮带 clarificationAnswer 时出现）。 */
export function decksmithClarificationAnswerNote(answer: DecksmithClarificationAnswer): string {
  switch (answer.status) {
    case 'answered':
      return `This teacher message answers your earlier question [${answer.questionId}]: ${JSON.stringify(answer.question ?? '')}. Use the answer, and any element the teacher selected with it, to continue the original request from the earlier conversation.`;
    case 'duplicate':
      return `Note: this message refers to your earlier question [${answer.questionId}], which the teacher already answered in an earlier reply. Do not repeat that work blindly: check the earlier conversation and the current deck, and treat this message as a new request.`;
    case 'stale':
      return `Note: this message refers to an earlier question [${answer.questionId}] that is no longer open (the conversation moved on or a new topic started). Treat this message as a new request and check the current deck before editing.`;
  }
}
