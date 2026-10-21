import { createHash } from 'node:crypto';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import {
  parseInteractiveRuntimeDependenciesValue,
  type InteractiveCompletionMode,
  type ReachDeckNativeElementV2,
} from '@reachany/reach-deck-dsl';
import { EUCLIDEAN_GEOMETRY_CONTRACT } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { EUCLIDEAN_GEOMETRY_CONTRACT_V2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { Type } from 'typebox';

import { parseJsonWithRepair } from '../json-repair.js';
import { canonicalizeGeneratedMathDelimiters } from '../model-markdown.js';
import { QUIZ_PROMPT as QUIZ_CORPUS_PROMPT } from '../prompts/corpus/local-stages.js';
import {
  buildScientificGenerationContext,
  parseScientificContextSnapshot,
  type ScientificContextSnapshot,
} from '../scientific-generation-context.js';
import { buildReachDeckScientificToolCatalog } from '../scientific-tool-catalog.js';
import { decksmithScientificCapabilityDetails } from './scientific-context.js';
import {
  GENERATION_SAFE_QUIZ_QUESTION_TYPES,
  normalizeDecksmithQuizSceneReplacement,
  normalizeQuizModelOutput,
} from '../quiz-model-output.js';
import {
  REACH_DECK_DECKSMITH_AFTER_APPLY_KINDS,
  REACH_DECK_DECKSMITH_SUGGESTED_ACTION_KINDS,
  type ReachDeckDecksmithAfterApplyAction,
  type ReachDeckDecksmithSuggestedAction,
} from '../contracts.js';
import { DecksmithInteractiveWorkspace } from './interactive-workspace.js';
import { DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED } from './prompt-contract-version.js';
import { compactDecksmithNativeSlide } from './slide-view.js';
import { decksmithQuizContractTextV8 } from './quiz-authoring-contract.js';
import {
  DecksmithSessionError,
  type DecksmithDocumentSession,
  type DecksmithInsertSceneType,
  type DecksmithNativeAnimationInput,
  type DecksmithNativeShapeInput,
  type DecksmithNativeTableCellInput,
  type DecksmithNativeTextInput,
  type DecksmithNativeTransformInput,
} from './session.js';

/** Quiz authoring corpus without the generation-only page-spec appendices Decksmith cannot supply. */
const DECKSMITH_QUIZ_CONTRACT = QUIZ_CORPUS_PROMPT.text;

/**
 * 生成合同要求"始终 has_answer=true 并给参考答案"；教师在 Decksmith 里明确要"无标答/开放题"时
 * 这条必须让位，否则模型只能编一个标准答案交差（测试环境第 15 页实测）。
 */
const DECKSMITH_OPEN_ENDED_QUIZ_RULE =
  'TEACHER OVERRIDE FOR OPEN-ENDED QUESTIONS: when the teacher asks for a question without a standard or reference answer (for example 无标答, 没有标准答案, 开放题, open-ended), this overrides the "always set has_answer to true" rule above. Use question_type short_answer, set has_answer to false, leave answer as an empty string, and omit scoring_points and answer_components. Put what a thoughtful response could address in analysis as guidance, never as the one correct answer. Do not invent a reference answer the teacher declined.';

/** 通用生成合同里与 Decksmith 开放题冲突的那一句；v4 合同把它换成指向 Decksmith 规则的引用。 */
const QUIZ_CORPUS_ALWAYS_ANSWER_RULE =
  'Always set has_answer to true and provide the reference answer required by the selected type.';

/** 无参考答案题不得携带的评分字段；与 quiz-model-output.ts 的服务端清理一致。 */
const OPEN_ENDED_OMITTED_FIELDS =
  'scoring_points, answer_components, acceptable_variants, partial_credit_examples, and typical_wrong_answers';

/**
 * v4（WP3 方案 A / 评审 M2）的 Decksmith 专属测验合同：Decksmith 规则前置并声明优先，通用合同里
 * "始终 has_answer=true" 一句换成指向这些规则的引用，不再靠末尾追加的"覆盖"段落和原文打架。
 * 题型集合与服务端校验共用 GENERATION_SAFE_QUIZ_QUESTION_TYPES。v1–v3 的合同正文保持不变。
 */
export function decksmithQuizContractTextV4(): string {
  if (!DECKSMITH_QUIZ_CONTRACT.includes(QUIZ_CORPUS_ALWAYS_ANSWER_RULE)) {
    throw new Error('Quiz corpus no longer contains the has_answer rule Decksmith replaces.');
  }
  const allowed = GENERATION_SAFE_QUIZ_QUESTION_TYPES.join(', ');
  return [
    'DECKSMITH QUIZ PAGE RULES (they take precedence over the general QuizScene contract that follows wherever the two differ):',
    '- One quiz page holds exactly one top-level question in content.questions, without sub_problems. For N questions insert N quiz pages, each with its own distinct assessment target; never repeat or paraphrase a question already inserted in this run.',
    `- question_type is exactly one of ${allowed}. Other question types the general contract mentions (such as fill_in_the_blank or fill_with_candidates) are not available in Decksmith and are rejected.`,
    '- Reference answers by default: set has_answer to true and give the reference answer the type requires (single_choice: one emitted option key; multiple_choice: unique emitted option keys; short_answer: a reference answer).',
    `- Open-ended questions: when the teacher asks for questions without a standard or reference answer (for example 无标答, 没有标准答案, 开放题, open-ended), use question_type short_answer, set has_answer to false, set answer to the empty string "", and omit ${OPEN_ENDED_OMITTED_FIELDS}. Put what a thoughtful response could address in analysis as guidance, never as the one correct answer, and never invent a reference answer the teacher declined. The server clears any answer or scoring field sent with has_answer false and reports it in diagnostics. single_choice and multiple_choice always set has_answer to true; has_answer false on them is rejected.`,
    '- Decksmith supplies no page outline, instructionalSpec, interactionAssessmentPlan, or previousQuizSummaries. Derive the assessment target from the teacher request, the current deck pages, and their narration; fields described below as coming from the page specification are simply absent.',
    '',
    DECKSMITH_QUIZ_CONTRACT.replace(
      QUIZ_CORPUS_ALWAYS_ANSWER_RULE,
      'Set has_answer and the reference answer exactly as the DECKSMITH QUIZ PAGE RULES above state.',
    ),
  ].join('\n');
}

/**
 * v7 测验合同前置的 sceneJson 字段说明（2026-10-09）。v4 合同正文来自课件生成的出题原则，生成流程靠结构化输出
 * schema 约束字段，正文里没有任何字段名；Decksmith 让模型在字符串里手写整段 JSON，第②层评测取参显示 4/4 个
 * 样本首次把题干写成 prompt、把 learning_fence 写成字符串、另造 display 字段，各浪费一回合。字段与取值以
 * quiz-model-output.ts（生成边界归一化与校验）和 reach-deck-dsl quizQuestion.ts / quizScene.ts 为准：
 * 题目 id、question_index、points、sub_problems 与 content 展示位由服务端补齐，选择题 3–5 个选项、键 A–E 连续。
 */
const DECKSMITH_QUIZ_SCENE_SHAPE = [
  'SCENEJSON FIELD REFERENCE: insert_quiz_page and replace_quiz_scene take one QuizScene as a JSON object string. Use exactly these field names; the server fills everything listed as omitted.',
  '- Scene: {"schemaVersion": "reach-quiz-scene/v1", "sceneType": "quiz", "id": "pending", "title": <short page title in the deck language, required>, "content": {"questions": [<exactly one question>]}}. Omit display fields (display_mode, navigation, answer_reveal, show_progress, show_question_index, allow_previous, allow_skip) and never invent other fields such as display.',
  '- Question: "question_type", "question" (the student-visible stem; the field is named question, never prompt, stem, or question_text), "has_answer", "answer", "analysis", "cognitive_schema", plus "options" for choice types and the optional assessment metadata the general contract below describes (target_ids, evidence_type, scoring_points, answer_components, ...). Omit id, question_index, points, and sub_problems.',
  '- question, analysis, cognitive_schema, a short_answer answer, and option labels are restricted Markdown strings; inline math uses \\( ... \\) (written \\\\( ... \\\\) inside the JSON string).',
  '- options: 3-5 objects {"value": "A", "label": "..."} with contiguous keys A, B, C, ... in order. single_choice answer is one key string such as "B"; multiple_choice answer is an array of unique keys such as ["A", "C"].',
  '- learning_fence is optional; when used it is an object {"enabled": true, "prompt": "<repair hint for a learner who missed the target>"}, never a bare string. Omit it otherwise.',
  'Example, open-ended short answer without a reference answer: {"schemaVersion": "reach-quiz-scene/v1", "sceneType": "quiz", "id": "pending", "title": "电压与电功", "content": {"questions": [{"question_type": "short_answer", "question": "保持 \\\\(I\\\\) 和 \\\\(t\\\\) 不变，只把电压调大，电功会怎样变化？说说你的理由。", "has_answer": false, "answer": "", "analysis": "可从 \\\\(W=UIt\\\\) 中各量的关系说明预测。", "cognitive_schema": "控制变量下的比例关系"}]}}',
  'Example, single choice: {"schemaVersion": "reach-quiz-scene/v1", "sceneType": "quiz", "id": "pending", "title": "电功的单位", "content": {"questions": [{"question_type": "single_choice", "question": "电功的国际单位是什么？", "options": [{"value": "A", "label": "瓦特"}, {"value": "B", "label": "焦耳"}, {"value": "C", "label": "伏特"}], "has_answer": true, "answer": "B", "analysis": "电功与能量同单位，是焦耳。", "cognitive_schema": "物理量与单位的对应"}]}}',
].join('\n');

/** v7 测验合同：sceneJson 字段说明与示例在前，v4 合同正文（Decksmith 规则 + 通用出题原则）原样在后。 */
export function decksmithQuizContractTextV7(): string {
  return [DECKSMITH_QUIZ_SCENE_SHAPE, '', decksmithQuizContractTextV4()].join('\n');
}

/**
 * 模型历史里测验写调用回执的开头（agent.ts 把较早成功的 sceneJson 换成该回执）。评测实测模型会把回执原样
 * 当成新一次调用的 sceneJson 重发；工具据此给出可执行的说明，而不是笼统的"不是 JSON 对象"。
 */
export const DECKSMITH_QUIZ_RECEIPT_PREFIX = '[quiz receipt:';

/** v4：insert_quiz_page 发现本次运行已插入过同一题干时返回的诊断码（非工具错误，不改文档）。 */
export const DECKSMITH_QUIZ_DUPLICATE = 'DECKSMITH_QUIZ_DUPLICATE';

/**
 * 测验工具的提示词合同版本选项（v4 / WP3 方案 A）。缺省 = v1–v3 行为：通用合同 + 覆盖段落，
 * 每次读取都返回全文，插入不查重。
 */
export interface DecksmithQuizToolOptions {
  readonly strictContract?: boolean;
  /** v7：合同前置 sceneJson 字段说明与示例，insert_quiz_page 描述点明字段名。只与 strictContract 组合。 */
  readonly sceneShapeContract?: boolean;
  /** v8：独立编辑合同，去除生成阶段的规划字段与分组指令。 */
  readonly editingContract?: boolean;
}

const transformSchema = Type.Object({
  x: Type.Number({ minimum: 0 }),
  y: Type.Number({ minimum: 0 }),
  width: Type.Number({ exclusiveMinimum: 0 }),
  height: Type.Number({ exclusiveMinimum: 0 }),
  rotation: Type.Optional(Type.Number()),
  flipHorizontal: Type.Optional(Type.Boolean()),
  flipVertical: Type.Optional(Type.Boolean()),
});

const decksmithColorSchema = (description: string) =>
  Type.String({ description, pattern: '^#[0-9A-Fa-f]{6}$' });

/**
 * 按需读取的互动合同（提示词合同 v2 起）。缺省时为 v1：合同已在用户消息里预加载，
 * 工具面不含 read_interactive_authoring_contract，互动写工具也不设门槛。
 */
export interface DecksmithInteractiveContractSource {
  /** 合同正文，按本次运行冻结的科学上下文与来源页激活能力生成；首次读取时才组装。 */
  readonly text: () => string;
  /** 合同正文已含其细节的科学能力；读取合同后视为已加载（与 v1 预加载时一致）。 */
  readonly capabilities: readonly string[];
}

/**
 * Decksmith v2 tool surface. There is deliberately no write_page or generic whole-page escape
 * hatch: mutations and insertion are scene-typed, operation-specific, and revalidated by the
 * session transition gate.
 */
export function createDecksmithTools(
  session: DecksmithDocumentSession,
  frozenContext?: ScientificContextSnapshot,
  initiallyLoadedCapabilities: readonly string[] = [],
  interactiveContract?: DecksmithInteractiveContractSource,
  quizOptions: DecksmithQuizToolOptions = {},
): AgentTool[] {
  const interactiveWorkspace = new DecksmithInteractiveWorkspace(session);
  const strictQuiz = quizOptions.strictContract === true;
  const quizSceneShape = strictQuiz && quizOptions.sceneShapeContract === true;
  let quizContractRead = false;
  // 上次返回合同全文之后是否已有成功的测验写调用。模型历史只在这种情况下才可能把合同换成回执
  // （agent.ts convertDecksmithMessagesForProvider），所以此时再读要重新给全文，否则答 already-read。
  let quizWriteSinceContract = false;
  // 本次运行已插入的测验题干摘要 -> 页 id（v4 查重；页被删除后可再次插入同一题）。
  const insertedQuizQuestions = new Map<string, string>();
  const loadedCapabilities = new Set(initiallyLoadedCapabilities);
  const loadedExamples = new Set(
    frozenContext?.exampleVersions.map(({ id, version }) => `${id}@${version}`) ?? [],
  );
  const frozenSnapshot =
    frozenContext === undefined ? undefined : parseScientificContextSnapshot(frozenContext);
  const frozenInjection =
    frozenSnapshot === undefined
      ? undefined
      : (JSON.parse(frozenSnapshot.serializedInjection) as {
          scientificToolRegistry: {
            capabilities: unknown[][];
            commonLimits: Record<string, unknown>;
            geometryGrammar?: unknown;
          };
          scientificCapabilityReferences: unknown[];
          selectedScientificExamples: Array<{
            id: string;
            version: string;
            capability: string;
            runtime: readonly [string, string];
            brief: string;
            oracle: string;
            reuse: string;
            documentHtml?: string;
            planning?: string;
          }>;
        });
  const frozenGuidance = (row: unknown[]): string => {
    try {
      return decksmithScientificCapabilityDetails(String(row[0]));
    } catch {
      return [
        `FROZEN SCIENTIFIC CAPABILITY: ${String(row[0])}`,
        `Contract: ${String(row[1])}`,
        `Supports: ${Array.isArray(row[5]) ? row[5].join('; ') : String(row[5])}`,
        'Use only the frozen fields, events, limits, and runtime pin in this snapshot.',
      ].join('\n');
    }
  };
  const canEnableCurrentGeometry = (
    capabilityId: string,
    dependency: readonly [string, string] | undefined,
  ) => {
    if (!Object.hasOwn(EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits, capabilityId)) return false;
    const key = capabilityId as keyof typeof EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits;
    const kits = [EUCLIDEAN_GEOMETRY_CONTRACT.kits[key], EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits[key]];
    return (
      dependency === undefined ||
      kits.some((kit) => dependency[0] === kit.runtimeId && dependency[1] === kit.runtimeVersion)
    );
  };
  const loadScientificCapability: AgentTool = {
    name: 'load_scientific_capability',
    label: '加载科学互动能力',
    description:
      'Load the exact field/event contract for a scientific capability from the complete catalog before using it on any page. Includes all existing science kits, cartesian-plot, custom-interactive-document and euclidean-geometry-2d/3d. Returns only its dedicated guidance; does not modify a page. Geometry selection uses the existing normal-policy activation boundary.',
    parameters: Type.Object({
      capabilityId: Type.String({ minLength: 1, maxLength: 80 }),
      teacherRequest: Type.Optional(Type.String({ maxLength: 8000 })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { capabilityId: string; teacherRequest?: string };
      const snapshot = frozenSnapshot;
      const frozenRegistry = frozenInjection?.scientificToolRegistry;
      const frozenRow = frozenRegistry?.capabilities.find(
        (row: unknown[]) => row[0] === input.capabilityId,
      );
      const currentGeometry = Object.hasOwn(
        EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits,
        input.capabilityId,
      );
      const geometry =
        frozenRow?.[6] === 'geometry' || (frozenRow === undefined && currentGeometry);
      const entry =
        snapshot === undefined
          ? buildReachDeckScientificToolCatalog({
              contexts: ['interactive'],
              scientificVisualsEnabled: false,
            }).find((candidate) => candidate.capability === input.capabilityId)
          : undefined;
      if (snapshot !== undefined ? frozenRow === undefined : entry === undefined)
        throw new DecksmithSessionError('Unknown scientific capability.');

      const frozenDependency =
        frozenRow === undefined || frozenRow[3] === null
          ? undefined
          : ((frozenRow[3] === 'engine' ? frozenRow[2] : frozenRow[3]) as readonly [
              string,
              string,
            ]);
      const runtimeDependency =
        snapshot === undefined ? entry?.runtimeDependency : frozenDependency;
      const runtimeId =
        runtimeDependency === undefined
          ? undefined
          : Array.isArray(runtimeDependency)
            ? runtimeDependency[0]
            : 'id' in runtimeDependency
              ? runtimeDependency.id
              : undefined;
      const runtimeVersion =
        runtimeDependency === undefined
          ? undefined
          : Array.isArray(runtimeDependency)
            ? runtimeDependency[1]
            : 'version' in runtimeDependency
              ? runtimeDependency.version
              : undefined;
      if (
        snapshot === undefined &&
        !geometry &&
        runtimeDependency &&
        !session.interactiveValidationOptions.allowedRuntimeDependencies?.some(
          (pin) => pin.id === runtimeId && pin.version === runtimeVersion,
        )
      )
        throw new DecksmithSessionError(
          'Scientific capability is not permitted in this editing session.',
        );
      const alreadyLoaded = loadedCapabilities.has(input.capabilityId);
      const receipt = {
        ...(snapshot === undefined ? {} : { frozenContextDigest: snapshot.digest }),
        capabilityId: input.capabilityId,
        contractStatus: 'already-loaded',
      };
      if (
        alreadyLoaded &&
        (snapshot !== undefined || !geometry || input.teacherRequest === undefined)
      ) {
        if (geometry && canEnableCurrentGeometry(input.capabilityId, frozenDependency))
          session.enableScientificCapability(
            input.capabilityId,
            frozenDependency === undefined
              ? undefined
              : parseInteractiveRuntimeDependenciesValue([
                  { id: frozenDependency[0], version: frozenDependency[1] },
                ])[0],
          );
        return textResult(JSON.stringify(receipt));
      }
      if (!geometry) {
        loadedCapabilities.add(input.capabilityId);
        return textResult(
          JSON.stringify({
            ...(snapshot === undefined ? {} : { frozenContextDigest: snapshot.digest }),
            capability: frozenRow ?? entry,
            guidance:
              frozenRow === undefined
                ? decksmithScientificCapabilityDetails(input.capabilityId)
                : frozenGuidance(frozenRow),
            commonRules:
              'The existing shared safety, marker, bridge, state restoration, layout and free-exploration rules still apply.',
          }),
        );
      }
      if (snapshot !== undefined) {
        if (canEnableCurrentGeometry(input.capabilityId, frozenDependency))
          session.enableScientificCapability(
            input.capabilityId,
            frozenDependency === undefined
              ? undefined
              : parseInteractiveRuntimeDependenciesValue([
                  { id: frozenDependency[0], version: frozenDependency[1] },
                ])[0],
          );
        loadedCapabilities.add(input.capabilityId);
        const selectedScientificExamples = frozenInjection!.selectedScientificExamples.filter(
          (example) => {
            if (example.capability !== input.capabilityId) return false;
            const key = `${example.id}@${example.version}`;
            if (loadedExamples.has(key)) return false;
            loadedExamples.add(key);
            return true;
          },
        );
        return textResult(
          JSON.stringify({
            frozenContextDigest: snapshot.digest,
            guidance: frozenGuidance(frozenRow!),
            capability: frozenRow,
            commonLimits: frozenRegistry!.commonLimits,
            geometryGrammar: frozenRegistry!.geometryGrammar,
            selectedScientificExamples,
            scientificCapabilityReferences: frozenInjection!.scientificCapabilityReferences,
          }),
        );
      }
      const kit =
        EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits[
          input.capabilityId as keyof typeof EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits
        ];
      const context = buildScientificGenerationContext({
        stage: 'decksmith',
        approachHints: [input.capabilityId],
        teacherRequest: input.teacherRequest,
        allowedRuntimeDependencies: [
          ...(session.interactiveValidationOptions.allowedRuntimeDependencies ?? []),
          ...parseInteractiveRuntimeDependenciesValue([
            { id: kit.runtimeId, version: kit.runtimeVersion },
          ]),
        ],
      });
      const injection = JSON.parse(context.serializedInjection);
      session.enableScientificCapability(
        input.capabilityId,
        parseInteractiveRuntimeDependenciesValue([
          { id: kit.runtimeId, version: kit.runtimeVersion },
        ])[0],
      );
      loadedCapabilities.add(input.capabilityId);
      const selectedScientificExamples = injection.selectedScientificExamples.filter(
        (example: { id: string; version: string }) => {
          const key = `${example.id}@${example.version}`;
          if (loadedExamples.has(key)) return false;
          loadedExamples.add(key);
          return true;
        },
      );
      if (alreadyLoaded) {
        return textResult(JSON.stringify({ ...receipt, selectedScientificExamples }));
      }
      return textResult(
        JSON.stringify({
          guidance: decksmithScientificCapabilityDetails(input.capabilityId),
          capability: injection.scientificToolRegistry.capabilities.find(
            (row: unknown[]) => row[0] === input.capabilityId,
          ),
          commonLimits: injection.scientificToolRegistry.commonLimits,
          geometryGrammar: injection.scientificToolRegistry.geometryGrammar,
          selectedScientificExamples,
          scientificCapabilityReferences: injection.scientificCapabilityReferences,
        }),
      );
    },
  };
  const listPages: AgentTool = {
    name: 'list_pages',
    label: '页面清单',
    description:
      'List every page with its stable identity, scene type, revision, and whether it has an authoritative native slide.',
    parameters: Type.Object({}),
    execute: async () => textResult(JSON.stringify(session.listPages())),
  };

  const readPage: AgentTool = {
    name: 'read_page',
    label: '读取页面',
    description: [
      'Read one complete page. Quiz and interactive pages expose their complete validated scene, including full Interactive documentHtml.',
      'Native slides default to a compact view: stable ids, geometry, plain text with its dominant style, fills, table rows/cells, animations, and narration Markdown. That is enough for almost every edit.',
      'Pass detail "full" (optionally with elementId) only when you must see exact rich-text runs, such as partial bold or mixed colors inside one frame, or the embedded scientific visual document.',
    ].join(' '),
    parameters: Type.Object({
      pageId: Type.String(),
      detail: Type.Optional(Type.Union([Type.Literal('compact'), Type.Literal('full')])),
      elementId: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string; detail?: 'compact' | 'full'; elementId?: string };
      const view = session.readPageView(input.pageId);
      if (view.nativeSlide === undefined) return textResult(JSON.stringify(view));
      if (input.detail === 'full') {
        if (input.elementId === undefined) return textResult(JSON.stringify(view));
        const element = findNativeElement(view.nativeSlide.elements, input.elementId);
        if (element === undefined) {
          throw new DecksmithSessionError(`Element ${input.elementId} is not on ${input.pageId}.`);
        }
        return textResult(
          JSON.stringify({ pageId: view.pageId, revision: view.revision, element }),
        );
      }
      return textResult(
        JSON.stringify({ ...view, nativeSlide: compactDecksmithNativeSlide(view.nativeSlide) }),
      );
    },
  };

  const setPageTitle: AgentTool = {
    name: 'set_page_title',
    label: '修改页面标题',
    description:
      'Set one page metadata/accessibility title. For native slides this synchronizes the page projection and native slide title atomically, but it does not change visible canvas text; use upsert_native_text for a visible title.',
    parameters: Type.Object({ pageId: Type.String(), title: Type.String() }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string; title: string };
      const page = session.setPageTitle(input.pageId, input.title);
      return textResult(`Page ${page.pageId} title updated at revision ${page.revision}.`);
    },
  };

  const upsertNativeText: AgentTool = {
    name: 'upsert_native_text',
    label: '编辑原生文本',
    description: [
      'Create or update one native textFrame (or the text inside an existing shape).',
      'Text is converted through the shared Reach Deck rich-text contract.',
      'role selects theme-resolved title, body, or caption typography; omitted role remains backward-compatible body text.',
      'textColor changes glyph foreground; inlineBackgroundColor changes or clears glyph highlighting; frameFillColor changes or clears the text-frame or shape background.',
      'Foreground and background colors must be different so the text remains readable; an unreadable combination fails and must be corrected.',
      'transform is required only for a new element.',
    ].join(' '),
    parameters: Type.Object({
      pageId: Type.String(),
      elementId: Type.String(),
      text: Type.String(),
      transform: Type.Optional(transformSchema),
      zIndex: Type.Optional(Type.Integer()),
      role: Type.Optional(
        Type.Union([Type.Literal('title'), Type.Literal('body'), Type.Literal('caption')]),
      ),
      textColor: Type.Optional(decksmithColorSchema('#RRGGBB glyph foreground')),
      inlineBackgroundColor: Type.Optional(
        Type.Union([
          decksmithColorSchema('#RRGGBB glyph highlight'),
          Type.Null({ description: 'clear glyph highlighting' }),
        ]),
      ),
      frameFillColor: Type.Optional(
        Type.Union([
          decksmithColorSchema('#RRGGBB text-frame or shape background'),
          Type.Null({ description: 'clear text-frame or shape background' }),
        ]),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as DecksmithNativeTextInput;
      const slide = session.upsertNativeText({
        ...input,
        text: canonicalizeGeneratedMathDelimiters(input.text),
      });
      return textResult(`Native text ${input.elementId} updated on ${slide.id}.`);
    },
  };

  const setNativeTableCell: AgentTool = {
    name: 'set_native_table_cell',
    label: '编辑表格单元格',
    description: [
      'Edit one cell of a native table element (type "table") by its exact table elementId and cellId from read_page.',
      'Tables are single native elements whose rows[].cells[] carry their own rich text and style; upsert_native_text cannot edit them.',
      'text replaces the cell text through the shared rich-text contract and keeps the cell typography; textColor alone recolors the existing text; fillColor changes or clears (null) the cell background.',
      'Call once per cell. Column widths, row heights, and cell count are unchanged.',
    ].join(' '),
    parameters: Type.Object({
      pageId: Type.String(),
      elementId: Type.String(),
      cellId: Type.String(),
      text: Type.Optional(Type.String()),
      textColor: Type.Optional(decksmithColorSchema('#RRGGBB glyph foreground')),
      fillColor: Type.Optional(
        Type.Union([
          decksmithColorSchema('#RRGGBB cell background'),
          Type.Null({ description: 'clear cell background' }),
        ]),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as DecksmithNativeTableCellInput;
      const slide = session.setNativeTableCell({
        ...input,
        ...(input.text === undefined
          ? {}
          : { text: canonicalizeGeneratedMathDelimiters(input.text) }),
      });
      return textResult(`Table ${input.elementId} cell ${input.cellId} updated on ${slide.id}.`);
    },
  };

  const animationValues = Type.Intersect([
    Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()])),
    Type.Object({ color: Type.Optional(decksmithColorSchema('#RRGGBB animated color')) }),
  ]);
  const upsertNativeAnimation: AgentTool = {
    name: 'upsert_native_animation',
    label: '编辑原生动画',
    description: [
      'Create or replace one non-narration native animation by stable id.',
      'The target element must already exist. Read the page first and preserve unrelated animations.',
      'Narration-owned ids use a reserved prefix and can only be changed by narration regeneration.',
    ].join(' '),
    parameters: Type.Object({
      pageId: Type.String(),
      id: Type.String(),
      targetId: Type.String(),
      trigger: Type.Union([
        Type.Literal('on-enter'),
        Type.Literal('on-click'),
        Type.Literal('after-previous'),
        Type.Literal('with-previous'),
      ]),
      effect: Type.Union([
        Type.Literal('appear'),
        Type.Literal('fade'),
        Type.Literal('move'),
        Type.Literal('scale'),
        Type.Literal('rotate'),
        Type.Literal('color'),
        Type.Literal('disappear'),
      ]),
      start: Type.Number({ minimum: 0 }),
      duration: Type.Number({ minimum: 0 }),
      delay: Type.Optional(Type.Number({ minimum: 0 })),
      easing: Type.Optional(
        Type.Union([
          Type.Literal('linear'),
          Type.Literal('ease-in'),
          Type.Literal('ease-out'),
          Type.Literal('ease-in-out'),
        ]),
      ),
      from: Type.Optional(animationValues),
      to: Type.Optional(animationValues),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as DecksmithNativeAnimationInput;
      session.assertMediaMutationAllowed('animation', input.pageId);
      const slide = session.upsertNativeAnimation(input);
      return textResult(`Native animation ${input.id} updated on ${slide.id}.`);
    },
  };

  const removeNativeAnimation: AgentTool = {
    name: 'remove_native_animation',
    label: '删除原生动画',
    description:
      'Remove one non-narration animation by stable id. Narration-owned animations must be changed through narration regeneration.',
    parameters: Type.Object({ pageId: Type.String(), animationId: Type.String() }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string; animationId: string };
      session.assertMediaMutationAllowed('animation', input.pageId);
      const slide = session.removeNativeAnimation(input.pageId, input.animationId);
      return textResult(`Native animation ${input.animationId} removed from ${slide.id}.`);
    },
  };

  const upsertNativeShape: AgentTool = {
    name: 'upsert_native_shape',
    label: '编辑原生形状',
    description: [
      'Create or update one native preset shape with validated transform and style.',
      'Optional text uses the shared rich-text contract. transform is required only for a new shape.',
    ].join(' '),
    parameters: Type.Object({
      pageId: Type.String(),
      elementId: Type.String(),
      preset: Type.String(),
      transform: Type.Optional(transformSchema),
      zIndex: Type.Optional(Type.Integer()),
      fillColor: Type.Optional(
        Type.Union([
          decksmithColorSchema('#RRGGBB'),
          Type.Null({ description: 'clear shape fill' }),
        ]),
      ),
      strokeColor: Type.Optional(decksmithColorSchema('#RRGGBB')),
      strokeWidth: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      text: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as DecksmithNativeShapeInput;
      const slide = session.upsertNativeShape({
        ...input,
        ...(input.text === undefined
          ? {}
          : { text: canonicalizeGeneratedMathDelimiters(input.text) }),
      });
      return textResult(`Native shape ${input.elementId} updated on ${slide.id}.`);
    },
  };

  const transformNativeElement: AgentTool = {
    name: 'transform_native_element',
    label: '变换原生元素',
    description:
      'Move, resize, rotate, flip, or reorder an existing top-level native element on the declared page. Preserves the complete subtype payload for lines, groups, tables, charts, formulas, diagrams, media, text, and shapes. No-op requests are reported as changed=false.',
    parameters: Type.Object({
      pageId: Type.String(),
      elementId: Type.String(),
      transform: transformSchema,
      zIndex: Type.Optional(Type.Integer()),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as DecksmithNativeTransformInput;
      const outcome = session.transformNativeElement(input);
      return textResult(
        JSON.stringify({
          operation: 'transform_native_element',
          pageId: outcome.pageId,
          elementId: outcome.elementId,
          changed: outcome.changed,
          before: outcome.before,
          after: outcome.after,
          revision: outcome.revision,
          message: outcome.changed ? 'element transformed' : 'no material change',
        }),
      );
    },
  };

  const setNativeLayout: AgentTool = {
    name: 'set_native_layout',
    label: '设置原生版式',
    description:
      'Bind a native slide to a validated document layout resource, or clear the binding with clear=true.',
    parameters: Type.Object({
      pageId: Type.String(),
      layoutId: Type.Optional(Type.String()),
      clear: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string; layoutId?: string; clear?: boolean };
      if (input.clear !== true && input.layoutId === undefined) {
        throw new DecksmithSessionError('layoutId is required unless clear=true.');
      }
      if (input.clear === true && input.layoutId !== undefined) {
        throw new DecksmithSessionError('layoutId and clear=true are mutually exclusive.');
      }
      const slide = session.setNativeLayout(
        input.pageId,
        input.clear === true ? null : input.layoutId!,
      );
      return textResult(`Native layout updated on ${slide.id}.`);
    },
  };

  const setNarration: AgentTool = {
    name: 'set_native_narration',
    label: '编辑权威讲稿',
    description:
      'Set the authoritative canonical narration Markdown for one native slide and invalidate stale derived audio, timing, and narration animations.',
    parameters: Type.Object({ pageId: Type.String(), markdown: Type.String() }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string; markdown: string };
      session.assertMediaMutationAllowed('narration', input.pageId);
      const slide = session.setNarrationMarkdown(
        input.pageId,
        canonicalizeGeneratedMathDelimiters(input.markdown),
      );
      return textResult(`Authoritative narration updated on ${slide.id}; derived media is stale.`);
    },
  };

  const replaceQuizScene: AgentTool = {
    name: 'replace_quiz_scene',
    label: '编辑测验场景',
    description:
      'Replace only the quiz scene on an existing quiz page. Call read_quiz_authoring_contract first when authoring questions. sceneJson is checked by the dedicated quiz parser; page identity, order, and revision are managed by the session.',
    parameters: Type.Object({ pageId: Type.String(), sceneJson: Type.String() }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string; sceneJson: string };
      const scene = parseQuizSceneInput(input.sceneJson);
      if (!strictQuiz) {
        // v1–v3：原样交给会话解析，结果正文保持不变。
        const page = session.replaceScene(input.pageId, 'quiz', scene);
        return textResult(`quiz page ${page.pageId} updated to revision ${page.revision}.`);
      }
      // v4：与 insert_quiz_page 同一套开放题清理与富文本归一化（逐题、含子题，不限一页一题），
      // 避免 has_answer=false 的题残留参考答案；清理诊断附在结果后（结果仍以 "updated to revision" 开头）。
      const normalized = normalizeDecksmithQuizSceneReplacement(
        scene,
        session.listPages().find((page) => page.pageId === input.pageId)?.title,
      );
      const page = session.replaceScene(input.pageId, 'quiz', normalized.scene);
      quizWriteSinceContract = true;
      // 查重表跟随改写后的首题题干：旧题干不再阻止插入，新题干不能再插第二页。
      for (const [key, pageId] of insertedQuizQuestions) {
        if (pageId === page.pageId) insertedQuizQuestions.delete(key);
      }
      const questionKey = quizQuestionKey(normalized.scene);
      if (questionKey !== undefined) insertedQuizQuestions.set(questionKey, page.pageId);
      return textResult(
        `quiz page ${page.pageId} updated to revision ${page.revision}.${
          normalized.diagnostics.length === 0
            ? ''
            : `\nDiagnostics: ${JSON.stringify(normalized.diagnostics)}`
        }${
          (normalized.repairs ?? []).length === 0
            ? ''
            : `\nField repairs: ${JSON.stringify(normalized.repairs)}`
        }`,
      );
    },
  };

  const insertSlidePage: AgentTool = {
    name: 'insert_slide_page',
    label: '插入原生幻灯页',
    description:
      'Insert a new native slide at a 1-based position (omit to append). The server derives stable page/native identities, reuses the neighbouring slide background, and creates a visible title text frame; use typed native tools for further content. narrationText, when given, becomes the authoritative narration Markdown of the new slide.',
    parameters: Type.Object({
      title: Type.String(),
      position: Type.Optional(Type.Integer({ minimum: 1 })),
      narrationText: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { title: string; position?: number; narrationText?: string };
      // 新插入的页不可能处于媒体生成中（生成锁只描述已有的来源页），无需预检。
      const page = session.insertSlidePage(input.title, input.position);
      if (input.narrationText !== undefined) {
        session.setNarrationMarkdown(
          page.pageId,
          canonicalizeGeneratedMathDelimiters(input.narrationText),
        );
      }
      return textResult(
        `Native slide ${page.pageId} inserted at position ${page.order}${
          input.narrationText === undefined ? '' : ' with authoritative narration'
        }.`,
      );
    },
  };

  // The full quiz authoring contract is ~16k characters. Shipping it in a tool description made
  // every model turn of every Decksmith run pay for it; load it only when a quiz is being written.
  const suggestPageAction: AgentTool = {
    name: 'suggest_page_action',
    label: '提供页面操作按钮',
    description: [
      'Offer the teacher a one-click button for an existing editor operation. Nothing runs until the teacher clicks it, and it does not change the document.',
      'Pick the kind that matches exactly what the teacher asked for:',
      'regenerate-page: regenerate the whole page (layout and narration) from its outline.',
      'regenerate-page-narration: have AI rewrite this page’s narration text, then synthesize its audio and narration-driven animations (on interactive pages: rewrite narration and synthesize audio).',
      'regenerate-page-narration-text: have AI rewrite only this page’s narration text; it clears the page’s existing audio and narration-driven animations and synthesizes nothing. Slide pages only.',
      'generate-page-audio: synthesize audio and timestamps from the page’s saved narration without rewriting it; it clears narration-driven animations.',
      'regenerate-page-animations: regenerate only the narration-driven animations from the page’s existing audio timing; narration text and audio stay unchanged. Slide pages that already have narration audio only.',
      'regenerate-page-media: synthesize audio from the saved narration and regenerate its narration-driven animations, keeping the narration text.',
      'Use it ONLY when the teacher explicitly asks for that regeneration in this request. Never offer it on your own initiative.',
    ].join(' '),
    parameters: Type.Object({
      kind: Type.Union(
        REACH_DECK_DECKSMITH_SUGGESTED_ACTION_KINDS.map((kind) => Type.Literal(kind)),
      ),
      pageId: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as ReachDeckDecksmithSuggestedAction;
      session.suggestAction(input);
      return textResult(
        `Button offered: ${input.kind} for ${input.pageId}. It runs only if the teacher clicks it; tell them so.`,
      );
    },
  };

  const readQuizAuthoringContract: AgentTool = {
    name: 'read_quiz_authoring_contract',
    label: '读取测验编写规范',
    description:
      'Return the complete QuizScene authoring contract (JSON shape, supported question types, assessment rules). Call it once before the first insert_quiz_page or replace_quiz_scene in this run. Does not modify the document.',
    parameters: Type.Object({}),
    execute: async () => {
      if (strictQuiz) {
        // v4：全文仍在模型历史里时只回一条短说明（同互动合同），避免历史里出现多份 16k 合同；
        // 成功写过测验后历史可能已把全文换成回执，这时重读返回全文。
        if (quizContractRead && !quizWriteSinceContract) {
          return textResult(
            JSON.stringify({
              contractStatus: 'already-read',
              note: 'The quiz authoring contract was returned earlier in this run and still applies.',
            }),
          );
        }
        quizContractRead = true;
        quizWriteSinceContract = false;
        return textResult(
          quizOptions.editingContract === true
            ? decksmithQuizContractTextV8()
            : quizSceneShape
              ? decksmithQuizContractTextV7()
              : decksmithQuizContractTextV4(),
        );
      }
      return textResult(
        [
          DECKSMITH_QUIZ_CONTRACT,
          'Decksmith supplies no page outline or instructionalSpec. Derive the assessment target from the teacher request, the current deck pages, and their narration; fields described above as coming from the page specification are simply absent.',
          DECKSMITH_OPEN_ENDED_QUIZ_RULE,
        ].join('\n\n'),
      );
    },
  };

  const insertQuizPage: AgentTool = {
    name: 'insert_quiz_page',
    label: '插入测验页',
    // 题型约束在规范正文中间,实测模型几乎总在首次调用时写成不受支持的题型再靠报错自纠。
    // 把这一条前置到描述首行,让它先于长篇契约被读到。
    // v7 再把字段名前置：实测模型首次几乎总把题干写成 prompt（合同正文原本没有字段说明）。
    description: quizSceneShape
      ? `Insert one quiz page. sceneJson is one QuizScene JSON object: {"schemaVersion": "reach-quiz-scene/v1", "sceneType": "quiz", "id": "pending", "title": ..., "content": {"questions": [one question]}}; the stem field is "question" (not prompt), and question_type must be exactly one of ${GENERATION_SAFE_QUIZ_QUESTION_TYPES.join(', ')}. Call read_quiz_authoring_contract first for the field reference, examples, and assessment rules. The server replaces "pending" with the stable page id and normalizes restricted Markdown into durable rich text before validation.`
      : `Insert one quiz page. content.questions[0].question_type must be exactly one of ${GENERATION_SAFE_QUIZ_QUESTION_TYPES.join(', ')}; any other value is rejected. Call read_quiz_authoring_contract first for the complete reach-quiz-scene/v1 QuizScene contract. Put the complete model-boundary QuizScene JSON in sceneJson. Use "pending" as its id; the server replaces it with the stable page id and normalizes restricted Markdown into durable rich text before validation.`,
    parameters: Type.Object({
      sceneJson: Type.String(),
      position: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { sceneJson: string; position?: number };
      // 字段写法改正对全部版本生效：只把原本会被拒绝、意思明确的输入改成模型显然想写的形状（与 v6 丢参防护
      // 同理，属于运行时兼容而非提示词变化）；唯一例外是缺 enabled 的 learning_fence 对象，见
      // quiz-model-output.ts repairQuizQuestionFields 第 3 条。
      const normalized = normalizeQuizModelOutput(parseQuizSceneInput(input.sceneJson), {
        allowOpenEndedShortAnswer: true,
        repairFieldMistakes: true,
      });
      const questionKey = strictQuiz ? quizQuestionKey(normalized.scene) : undefined;
      const existingPageId =
        questionKey === undefined ? undefined : insertedQuizQuestions.get(questionKey);
      if (
        existingPageId !== undefined &&
        session.listPages().some((page) => page.pageId === existingPageId)
      ) {
        // v4 幂等：重试或重复规划同一题时不再插第二页；不是工具错误，避免误记为部分失败。
        return textResult(
          JSON.stringify({
            operation: 'insert_quiz_page',
            applied: false,
            code: DECKSMITH_QUIZ_DUPLICATE,
            existingPageId,
            message: `Nothing was inserted: quiz page ${existingPageId} with the same question was already written in this run. Treat that question as done, or write a different question.`,
          }),
        );
      }
      const page = session.insertScenePage('quiz', normalized.scene, input.position);
      if (questionKey !== undefined) insertedQuizQuestions.set(questionKey, page.pageId);
      quizWriteSinceContract = true;
      return textResult(
        JSON.stringify({
          operation: 'insert_quiz_page',
          pageId: page.pageId,
          order: page.order,
          diagnostics: normalized.diagnostics,
          ...((normalized.repairs ?? []).length === 0 ? {} : { fieldRepairs: normalized.repairs }),
        }),
      );
    },
  };

  // 互动合同门槛（v2）：本次运行读过合同之前，互动写工具只返回诊断、不改工作副本。
  // 选择"拒绝 + 诊断"而不是在结果里自动附带合同：合同很长，自动附带等于把成本藏进任意一次写调用，
  // 还会在同一运行里重复出现；模型可在同一回合里先读合同再读 HTML，小补丁不因此多一个回合。
  // 拒绝结果不是工具错误，避免模型随后补读合同并成功提交时被误记为"部分失败"。
  let interactiveContractRead = interactiveContract === undefined;
  const readInteractiveAuthoringContract: AgentTool | undefined =
    interactiveContract === undefined
      ? undefined
      : {
          name: 'read_interactive_authoring_contract',
          label: '读取互动页编写规范',
          description:
            'Return the complete Interactive (GenUI) authoring and validation contract, including active scientific capability guidance. Call it once in this run before the Interactive insert, edit, write, geometry proposal, or commit tools. Does not modify the document.',
          parameters: Type.Object({}),
          execute: async () => {
            if (interactiveContractRead) {
              return textResult(
                JSON.stringify({
                  contractStatus: 'already-read',
                  note: 'The Interactive authoring contract was returned earlier in this run and still applies.',
                }),
              );
            }
            interactiveContractRead = true;
            for (const capability of interactiveContract.capabilities) {
              loadedCapabilities.add(capability);
            }
            return textResult(
              [
                'Interactive authoring and validation contract:',
                'Choose insert, patch, rewrite, or convert yourself; there is no preclassified operation. Use the server-held working-file tools and finish with check_and_commit_interactive_page. Apply the following content/safety/layout/runtime/validation contracts to tool edits; do not answer with raw scene JSON. Follow diagnostics until validation and commit succeed.',
                interactiveContract.text(),
              ].join('\n'),
            );
          },
        };
  const interactiveTools = createInteractiveWorkspaceTools(
    interactiveWorkspace,
    () => interactiveContractRead,
  );

  const deletePage: AgentTool = {
    name: 'delete_page',
    label: '删除页面',
    description: 'Delete one existing page and its native binding. At least one page must remain.',
    parameters: Type.Object({ pageId: Type.String() }),
    execute: async (_toolCallId, params) => {
      const pageId = (params as { pageId: string }).pageId;
      session.deletePage(pageId);
      return textResult(`Page ${pageId} deleted.`);
    },
  };

  const movePage: AgentTool = {
    name: 'move_page',
    label: '移动页面',
    description: 'Move one page to a new 1-based position.',
    parameters: Type.Object({ pageId: Type.String(), position: Type.Integer({ minimum: 1 }) }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string; position: number };
      session.movePage(input.pageId, input.position);
      return textResult(`Page ${input.pageId} moved to position ${input.position}.`);
    },
  };

  return [
    listPages,
    readPage,
    setPageTitle,
    upsertNativeText,
    setNativeTableCell,
    upsertNativeShape,
    transformNativeElement,
    upsertNativeAnimation,
    removeNativeAnimation,
    ...(session.hasLayoutResources() ? [setNativeLayout] : []),
    setNarration,
    replaceQuizScene,
    insertSlidePage,
    readQuizAuthoringContract,
    suggestPageAction,
    insertQuizPage,
    ...(session.interactiveValidationOptions.scientificCapabilityPolicy === 'normal'
      ? [loadScientificCapability]
      : []),
    ...(readInteractiveAuthoringContract === undefined ? [] : [readInteractiveAuthoringContract]),
    ...interactiveTools,
    deletePage,
    movePage,
  ];
}

/**
 * 归一化后首题的去空白纯文本摘要（v4 查重键）；取不到题干时不查重。
 * 题干相同、只换了解析也视为同一道题，避免重试时插出两页；选择题还比较选项文字，
 * 因为"下列说法正确的是"这类通用题干在不同选项下是不同的题。
 */
function quizQuestionKey(scene: unknown): string | undefined {
  const question = (scene as { content?: { questions?: unknown[] } } | undefined)?.content
    ?.questions?.[0] as { question?: unknown; options?: unknown } | undefined;
  const plain = (value: unknown) => richTextPlainText(value).replace(/\s+/gu, '');
  const text = plain(question?.question);
  if (text.length === 0) return undefined;
  const options = Array.isArray(question?.options)
    ? question.options.map((option) =>
        plain((option as { label?: unknown } | null | undefined)?.label),
      )
    : [];
  return createHash('sha256')
    .update(JSON.stringify([text, ...options]))
    .digest('hex');
}

/** 富文本 doc（或字符串）的纯文本，公式节点取其 latex。 */
export function richTextPlainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';
  const node = value as { text?: unknown; attrs?: { latex?: unknown }; content?: unknown };
  const own =
    typeof node.text === 'string'
      ? node.text
      : typeof node.attrs?.latex === 'string'
        ? node.attrs.latex
        : '';
  const children = Array.isArray(node.content)
    ? node.content.map((child) => richTextPlainText(child)).join('')
    : '';
  return own + children;
}

/**
 * 测验写工具的 sceneJson 解析：先识别模型把历史回执原样当参数重发的情况（第②层评测实测），
 * 给出可执行的说明；其余同 parseObject。
 */
function parseQuizSceneInput(source: string): Record<string, unknown> {
  if (source.trimStart().startsWith(DECKSMITH_QUIZ_RECEIPT_PREFIX)) {
    throw new DecksmithSessionError(
      'sceneJson is a history receipt of a quiz page that already exists, not a QuizScene. Do not resend receipts. To add another question, send a complete new QuizScene JSON with a different question; to change that page, call read_page and then replace_quiz_scene.',
    );
  }
  return parseObject(source);
}

/** 合同门槛的诊断结果（非工具错误）；convertDecksmithMessagesForProvider 不把它当作基线变化。 */
function interactiveContractRequired(operation: string) {
  return textResult(
    JSON.stringify({
      operation,
      applied: false,
      code: DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED,
      message:
        'Nothing was changed. Call read_interactive_authoring_contract once in this run, then retry this call if it still follows the contract.',
    }),
  );
}

function createInteractiveWorkspaceTools(
  workspace: DecksmithInteractiveWorkspace,
  contractRead: () => boolean,
): AgentTool[] {
  const gated = (tool: AgentTool): AgentTool => ({
    ...tool,
    execute: async (...args) =>
      contractRead() ? tool.execute(...args) : interactiveContractRequired(tool.name),
  });
  const insert: AgentTool = {
    name: 'insert_interactive_page',
    label: '插入互动页',
    description:
      'Open a pending Interactive page working copy at a 1-based position. Write or edit its HTML, then call check_and_commit_interactive_page; the document stays unchanged until commit.',
    parameters: Type.Object({
      title: Type.String(),
      position: Type.Optional(Type.Integer({ minimum: 1 })),
      narrationText: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { title: string; position?: number; narrationText?: string };
      return textResult(
        JSON.stringify(workspace.prepareInsert(input.title, input.position, input.narrationText)),
      );
    },
  };
  const read: AgentTool = {
    name: 'read_interactive_html',
    label: '读取互动页 HTML',
    description:
      'Read exact Interactive HTML and supersede older baselines. Omit offset/limit for the whole file; use 1-based lines only for partial reads.',
    parameters: Type.Object({
      pageId: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string; offset?: number; limit?: number };
      const completeHtml = workspace.read(input.pageId);
      const result = textResult(workspace.read(input.pageId, input.offset, input.limit));
      return {
        ...result,
        details: {
          interactiveRead: {
            pageId: input.pageId,
            complete:
              (input.offset === undefined || input.offset === 1) &&
              (input.limit === undefined || input.limit >= completeHtml.split('\n').length),
          },
        },
      };
    },
  };
  const edit: AgentTool = {
    name: 'edit_interactive_html',
    label: '补丁编辑互动页 HTML',
    description:
      'Patch server-held HTML with exact unique non-overlapping replacements. For geometry marker JSON use inspect_interactive_geometry then propose_interactive_geometry_edit. Returns compact checks; reread after a server-held receipt.',
    parameters: Type.Object({
      pageId: Type.String(),
      edits: Type.Array(
        Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }),
        { minItems: 1, maxItems: 16 },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        pageId: string;
        edits: { oldText: string; newText: string }[];
      };
      return textResult(JSON.stringify(await workspace.edit(input.pageId, input.edits)));
    },
  };
  const write: AgentTool = {
    name: 'write_interactive_html',
    label: '重写互动页 HTML',
    description:
      'Replace all server-held Interactive HTML for a new page, conversion, or deliberate rewrite; prefer edit_interactive_html for precise changes. Include narrationText for new content. Returns compact checks; reread after a server-held receipt.',
    parameters: Type.Object({
      pageId: Type.String(),
      documentHtml: Type.String({ minLength: 1 }),
      narrationText: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        pageId: string;
        documentHtml: string;
        narrationText?: string;
      };
      return textResult(
        JSON.stringify(
          await workspace.write(input.pageId, input.documentHtml, input.narrationText),
        ),
      );
    },
  };
  const inspectGeometry: AgentTool = {
    name: 'inspect_interactive_geometry',
    label: '检查互动几何',
    description:
      'Read typed v1/v2 geometry envelopes, runtime pins, editability, and the HTML SHA-256. v1 is read-only unless explicitly upgraded.',
    parameters: Type.Object({ pageId: Type.String() }),
    execute: async (_toolCallId, params) => {
      const input = params as { pageId: string };
      return textResult(JSON.stringify(workspace.inspectGeometry(input.pageId)));
    },
  };
  const proposeGeometryEdit: AgentTool = {
    name: 'propose_interactive_geometry_edit',
    label: '提议互动几何修改',
    description:
      'After inspection, propose one strict v2 envelope with exact htmlSha256. Preserve identity, assertions, constructions, and bindings; only bound edits pass. Changes only the working copy; finish with check_and_commit_interactive_page.',
    parameters: Type.Object({
      pageId: Type.String(),
      instanceId: Type.String(),
      expectedHtmlSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      envelopeJson: Type.String({ minLength: 2 }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        pageId: string;
        instanceId: string;
        expectedHtmlSha256: string;
        envelopeJson: string;
      };
      return textResult(
        JSON.stringify(
          await workspace.proposeGeometryEdit({
            pageId: input.pageId,
            instanceId: input.instanceId,
            expectedHtmlSha256: input.expectedHtmlSha256,
            envelope: parseStrictJson(input.envelopeJson, 'envelopeJson'),
          }),
        ),
      );
    },
  };
  const commit: AgentTool = {
    name: 'check_and_commit_interactive_page',
    label: '检查并提交互动页',
    description:
      'Run all Interactive content, runtime, event, and policy checks. Commit atomically only when valid; otherwise return bounded diagnostics and retain the working copy; fix exactly what the diagnostic names before retrying. Reread before editing after commit.',
    // runtimePolicy 曾是自由 JSON 字符串且无任何形状说明，模型只能猜（常漏 maximumDurationSeconds
    // 或自造键），测试环境实测 GenUI 插入连续失败于此。allowReset/maximumDurationSeconds 在生成
    // 合同里本就是定值（true/null），这里只开放唯一需要判断的 completionMode。
    parameters: Type.Object({
      pageId: Type.String(),
      title: Type.Optional(Type.String()),
      completionMode: Type.Optional(
        Type.Union([Type.Literal('explicit'), Type.Literal('automatic'), Type.Literal('none')], {
          description:
            'explicit: the page calls ReachInteractive.complete after the learner finishes; automatic: it completes itself when its condition is reached; none: it never calls complete. Omit to keep the current mode (none for a new page).',
        }),
      ),
      eventManifestJson: Type.Optional(
        Type.String({
          description:
            'Omit unless the HTML emits ReachInteractive events. Exact JSON: {"schemaVersion":"reach-interactive-event-manifest/v1","events":[{"name":"snake_case","eventVersion":1,"meaning":"<=200 chars","payloadFields":[1-12 fields],"delivery":{"mode":"immediate"}|{"mode":"latest","intervalMs":250|500|1000|2000}}]}. A field is exactly {"name","type":"string","required","maxLength":1-200,"enum":[]} or {"name","type":"number"|"integer","required","minimum","maximum"} or {"name","type":"boolean","required"}; never name a field answer, answers, attachments, content, document, or state.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        pageId: string;
        title?: string;
        completionMode?: InteractiveCompletionMode;
        eventManifestJson?: string;
      };
      return textResult(
        JSON.stringify(
          await workspace.commit({
            pageId: input.pageId,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.completionMode === undefined ? {} : { completionMode: input.completionMode }),
            ...(input.eventManifestJson === undefined
              ? {}
              : { eventManifest: parseJsonValue(input.eventManifestJson, 'eventManifestJson') }),
          }),
        ),
      );
    },
  };
  return [
    gated(insert),
    read,
    gated(edit),
    gated(write),
    inspectGeometry,
    gated(proposeGeometryEdit),
    gated(commit),
  ];
}

function parseStrictJson(source: string, name: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new DecksmithSessionError(`${name} must be strict JSON.`);
  }
}

function parseJsonValue(source: string, name: string): unknown {
  const outcome = parseJsonWithRepair(source);
  if (outcome === null) throw new DecksmithSessionError(`${name} must be valid JSON.`);
  return outcome.value;
}

function parseObject(source: string): Record<string, unknown> {
  const outcome = parseJsonWithRepair(source);
  if (
    outcome === null ||
    typeof outcome.value !== 'object' ||
    outcome.value === null ||
    Array.isArray(outcome.value)
  ) {
    throw new DecksmithSessionError('sceneJson must be a JSON object string.');
  }
  return outcome.value as Record<string, unknown>;
}

/**
 * v5 工具（WP8）：声明采用后由服务端自动生成本页音频/动画。
 *
 * 只登记意图、不改文档也不立即执行；教师采用提案后，`/applied` 在确认真实采用的同时持久化意图，
 * 随后按讲稿媒体生成接口的页修订 / 讲稿 digest / 幂等合同入队。被替代或过期的提案不会执行。
 */
export function createDecksmithAfterApplyMediaTool(session: DecksmithDocumentSession): AgentTool {
  return {
    name: 'schedule_page_media_after_apply',
    label: '采用后生成页面媒体',
    description: [
      'Schedule audio (and optionally narration-driven animations) for a slide whose narration you wrote with set_native_narration in this run. It runs automatically on the server after the teacher adopts your change; nothing runs before adoption and it does not change the document.',
      'Use it only when the teacher asked in this request for audio, voice-over, or animations of that narration; never when they asked only for the text.',
      'generate-page-audio: synthesize audio and subtitles from your narration (narration-driven animations are cleared).',
      'regenerate-page-media: synthesize audio and regenerate the narration-driven animations.',
    ].join(' '),
    parameters: Type.Object({
      kind: Type.Union(REACH_DECK_DECKSMITH_AFTER_APPLY_KINDS.map((kind) => Type.Literal(kind))),
      pageId: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as ReachDeckDecksmithAfterApplyAction;
      session.scheduleMediaAfterApply(input);
      return textResult(
        `Scheduled ${input.kind} for ${input.pageId}. It starts automatically after the teacher adopts this change; tell them so.`,
      );
    },
  };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

function findNativeElement(
  elements: readonly ReachDeckNativeElementV2[],
  elementId: string,
): ReachDeckNativeElementV2 | undefined {
  for (const element of elements) {
    if (element.id === elementId) return element;
    if (element.type === 'group') {
      const child = findNativeElement(element.children, elementId);
      if (child !== undefined) return child;
    }
  }
  return undefined;
}
