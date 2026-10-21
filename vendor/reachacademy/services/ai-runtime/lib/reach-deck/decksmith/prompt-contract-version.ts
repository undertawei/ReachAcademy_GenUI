/**
 * Decksmith 提示词与工具合同版本（WP2 / WP7 / 评审 M1）。
 *
 * - 缺省（旧 Run，冻结输入没有 promptContractVersion）= v1：一段式系统提示词
 *   （system-prompt-v1.ts 逐字保留），来源页为互动页或原话命中 GenUI/互动 时在用户消息里整份注入互动合同，
 *   工具面没有 read_interactive_authoring_contract，互动写工具不设门槛；
 * - v2：分节系统提示词；互动合同经 read_interactive_authoring_contract 按需读取，互动写工具在本次运行
 *   读过合同之前返回 DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED；拿不准时用文字提问；
 * - v3（WP7 第一阶段）：在 v2 之上增加 ask_teacher 结构化提问工具，提示词里"拿不准就问"改为调用该工具。
 * - v4（WP3 方案 A）：在 v3 之上增加测验多题生成的运行内历史回执与转换语义——系统提示词新增 QUIZ PAGES 一节，
 *   测验合同改为 Decksmith 专属正文（一页一题、允许题型、开放题规则）且同一运行只返回一次，
 *   重复插入同一题干被拒绝，较早成功的测验写调用参数与过期的 read_page 结果在模型历史里换成回执。
 *   这些都改变模型可见内容，所以单独成版：已冻结 v2 / v3 的 Run 保持原提示词、合同正文与历史形状。
 * - v5（WP8）：在 v4 之上增加 schedule_page_media_after_apply 工具与 NARRATION 一节的对应规则——
 *   Decksmith 自己写了幻灯片讲稿、且教师在本次请求里要了音频/动画时，声明采用后由服务端自动生成媒体；
 *   只改讲稿文字时不声明。工具面与提示词都变了，已冻结 v2–v4 的 Run 保持原样。
 * - v6（2026-10-09 发现）：OpenAI 系模型经 LiteLLM / RouterLink 网关在一次回复里发出 2 个及以上工具调用时，
 *   每个调用的参数都会被清空（""），parallel_tool_calls:false 也不生效。v2–v5 提示词鼓励"同一回合发出
 *   全部调用"（v4 的 QUIZ PAGES 甚至要求同回合插入 N 题），对 GPT 槽位有害。v6 把所有同回合批量指引
 *   改为"每次回复只调用一个工具，拿到结果后再调用下一个"，其余规则与工具面同 v5；已冻结 v1–v5 的 Run 保持原样。
 * - v7（2026-10-09 第②层评测取参分析）：测验合同原是课件生成的出题原则，没有 sceneJson 的字段说明（生成流程靠
 *   结构化输出 schema），Decksmith 手写 JSON 时只能猜字段名：实测 4/4 个样本首次把题干写成 prompt、
 *   learning_fence 写成字符串。v7 在测验合同前置 sceneJson 字段说明与两个最小示例，insert_quiz_page 描述点明
 *   题干字段名，QUIZ PAGES 一节说明历史回执不可当参数重发、"改成"类转换以删除来源页收尾，
 *   用词冲突一条说明"描述"指教师要求创建的产出而非来源页
 *   （实测模型因来源页是滑块模拟而把"改成 5 个课中互动题"误判为冲突去追问）；其余规则与工具面同 v6，
 *   已冻结 v1–v6 的 Run 保持原样。
 * - v8（2026-10-15）：恢复已知参数的独立工具同回复批量调用，仍按顺序执行；依赖工具结果的调用留到下一轮，
 *   多题转换先确认全部插入成功，再另轮删除来源页；ask_teacher 仍独立调用。继承 v7 的工具面与回执。
 *   互动与测验改用独立编辑合同，删除生成专用规则、重复能力详情与矛盾策略；v1–v7 保留原合同。
 *
 * 新 Run 入队时冻结当前版本；执行时按冻结版本选择提示词与工具面，所以已排队的旧 Run 不会换用新提示词，
 * 入队测算与执行测算也保持一致。
 */
export const DECKSMITH_PROMPT_CONTRACT_V2 = 'decksmith-prompt/v2' as const;
export const DECKSMITH_PROMPT_CONTRACT_V3 = 'decksmith-prompt/v3' as const;
export const DECKSMITH_PROMPT_CONTRACT_V4 = 'decksmith-prompt/v4' as const;
export const DECKSMITH_PROMPT_CONTRACT_V5 = 'decksmith-prompt/v5' as const;
export const DECKSMITH_PROMPT_CONTRACT_V6 = 'decksmith-prompt/v6' as const;
export const DECKSMITH_PROMPT_CONTRACT_V7 = 'decksmith-prompt/v7' as const;
export const DECKSMITH_PROMPT_CONTRACT_V8 = 'decksmith-prompt/v8' as const;
/** 新 Run 冻结的当前提示词合同版本。 */
export const DECKSMITH_PROMPT_CONTRACT_VERSION = DECKSMITH_PROMPT_CONTRACT_V8;
/** 冻结输入可接受的显式版本；v1 只以"字段缺省"表示，不写入冻结输入。 */
export const DECKSMITH_PROMPT_CONTRACT_VERSIONS = Object.freeze([
  DECKSMITH_PROMPT_CONTRACT_V2,
  DECKSMITH_PROMPT_CONTRACT_V3,
  DECKSMITH_PROMPT_CONTRACT_V4,
  DECKSMITH_PROMPT_CONTRACT_V5,
  DECKSMITH_PROMPT_CONTRACT_V6,
  DECKSMITH_PROMPT_CONTRACT_V7,
  DECKSMITH_PROMPT_CONTRACT_V8,
] as const);
export type DecksmithPromptContractVersion = (typeof DECKSMITH_PROMPT_CONTRACT_VERSIONS)[number];

/** 互动写工具在本次运行读过合同之前返回的诊断码。 */
export const DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED = 'DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED';

export function isDecksmithPromptContractVersion(
  value: unknown,
): value is DecksmithPromptContractVersion {
  return DECKSMITH_PROMPT_CONTRACT_VERSIONS.includes(value as DecksmithPromptContractVersion);
}

/** true = v2 起的按需合同模式；undefined（旧 Run）= v1 预加载模式。 */
export function decksmithUsesOnDemandInteractiveContract(
  version: DecksmithPromptContractVersion | undefined,
): boolean {
  return version !== undefined;
}

/** true = v3 起工具面含 ask_teacher；v1 / v2 冻结的 Run 保持原工具面与文字提问。 */
export function decksmithOffersAskTeacher(
  version: DecksmithPromptContractVersion | undefined,
): boolean {
  return (
    version === DECKSMITH_PROMPT_CONTRACT_V3 ||
    version === DECKSMITH_PROMPT_CONTRACT_V4 ||
    version === DECKSMITH_PROMPT_CONTRACT_V5 ||
    version === DECKSMITH_PROMPT_CONTRACT_V6 ||
    version === DECKSMITH_PROMPT_CONTRACT_V7 ||
    version === DECKSMITH_PROMPT_CONTRACT_V8
  );
}

/**
 * true = v4 起的测验多题模式（WP3 方案 A）：Decksmith 专属测验合同且每次运行只返回一次、
 * 重复题干拒绝插入、模型历史里较早成功的测验写调用与过期 read_page 换成回执。
 */
export function decksmithUsesQuizHistoryReceipts(
  version: DecksmithPromptContractVersion | undefined,
): boolean {
  return (
    version === DECKSMITH_PROMPT_CONTRACT_V4 ||
    version === DECKSMITH_PROMPT_CONTRACT_V5 ||
    version === DECKSMITH_PROMPT_CONTRACT_V6 ||
    version === DECKSMITH_PROMPT_CONTRACT_V7 ||
    version === DECKSMITH_PROMPT_CONTRACT_V8
  );
}

/**
 * true = v5 起（WP8）：工具面含 schedule_page_media_after_apply，提示词的讲稿一节改为
 * "自己写讲稿且教师要了音频/动画时，声明采用后自动生成"。
 */
export function decksmithSchedulesMediaAfterApply(
  version: DecksmithPromptContractVersion | undefined,
): boolean {
  return (
    version === DECKSMITH_PROMPT_CONTRACT_V5 ||
    version === DECKSMITH_PROMPT_CONTRACT_V6 ||
    version === DECKSMITH_PROMPT_CONTRACT_V7 ||
    version === DECKSMITH_PROMPT_CONTRACT_V8
  );
}

/**
 * true = v6 / v7：提示词要求每次回复只调用一个工具；v8 恢复独立调用批量派发。
 * 工具面与 v5 相同；v1–v5 冻结的 Run 保持原提示词。
 */
export function decksmithRequiresOneToolCallPerResponse(
  version: DecksmithPromptContractVersion | undefined,
): boolean {
  return version === DECKSMITH_PROMPT_CONTRACT_V6 || version === DECKSMITH_PROMPT_CONTRACT_V7;
}

/**
 * true = v7 起：测验合同前置 sceneJson 字段说明与示例，insert_quiz_page 描述点明题干字段名；系统提示词
 * 的用词冲突一条只看要求的产出、QUIZ PAGES 的转换一条以删除来源页收尾、回执一条说明回执不可当参数重发。
 * 工具参数与 v6 相同。
 */
export function decksmithQuizContractStatesSceneShape(
  version: DecksmithPromptContractVersion | undefined,
): boolean {
  return version === DECKSMITH_PROMPT_CONTRACT_V7 || version === DECKSMITH_PROMPT_CONTRACT_V8;
}
