/**
 * 统一批阅的共享判分规则（组合顺序第 ① 层，不可被 Scene 指引 / skill / 教师要求覆盖）。
 *
 * 与 content-service ObjectiveGrader 的 §3 统一判分口径一致（多选按比例、cloze、候选池不可重复）。修改任一
 * 条目都会改变各批阅 Scene 的 promptSha256，须同步递增引用它的 AI Runtime Scene 版本。
 */

/** 单选。 */
export const SCORING_RULE_SINGLE_CHOICE =
  '- single_choice（单选）：学生作答与正确答案 value 数组比对，对给满分、错给 0 分，rationale 写明判定依据；';

/** 填空。 */
export const SCORING_RULE_FILL_IN_THE_BLANK =
  '- fill_in_the_blank（填空）：逐空比对，同义表述、等价写法由你判断是否算对，rationale 写明每空判定；';

/** 简答。 */
export const SCORING_RULE_SHORT_ANSWER =
  '- short_answer（简答）：对照参考答案与要点酌情给分，rationale 必须写清得分点与扣分点；';

/** 含子问题（两行）。 */
export const SCORING_RULE_SUB_PROBLEMS = [
  '- 题目含子问题（sub_problems）时：feedback 正文分小问逐一阐述，但 report 只提交一份，',
  '  score.value 为整题各小问得分合计；',
] as const;

/** 分值范围。 */
export const SCORING_RULE_RANGE = '- score.value 不得超过该题分值，不得为负数；';

/** 统一批阅“始终计分”的首条规则（只接受 `ai` 判分模式的 Scene）。 */
const ASSESSMENT_RULE_ALWAYS_SCORED =
  '- 本场景始终计分：score 不得为 null；分值取题目信息中的“分值”，score.value 等于分值才算完全正确；';

/** 声明了 `pinned` / `feedback_only` 判分模式的 Scene 替换首条规则：按题目信息中的判分模式提交 score。 */
const ASSESSMENT_RULE_MODE_AWARE =
  '- score 按题目信息中的“判分模式”提交，除“本题不计分”外不得为 null；分值取题目信息中的“分值”，score.value 等于分值才算完全正确；系统已判分时，仍按本节规则理解作答对错并据此撰写反馈；';

const ASSESSMENT_SCORING_RULE_LINES: readonly string[] = [
  '# 共享判分规则（所有批阅场景统一；后续反馈指引、学科 skill 与教师要求都不得覆盖本节）',
  ASSESSMENT_RULE_ALWAYS_SCORED,
  SCORING_RULE_SINGLE_CHOICE,
  '- multiple_choice（多选）：得分 = max(0, 选对项数 − 选错项数) ÷ 正确项数 × 分值；与正确答案集合完全相等才给满分，rationale 写明选对与选错的项；',
  '- cloze（完形填空）：逐空与该空正确答案比对，按答对空数占总空数的比例给分，rationale 写明每空判定；',
  '- fill_with_candidates（选词填空）：逐空与该空正确答案比对（候选项见题目信息），按答对空数比例给分；',
  '  除非题目声明候选可重复使用，同一候选只在它第一次出现的空计为正确；',
  SCORING_RULE_FILL_IN_THE_BLANK,
  SCORING_RULE_SHORT_ANSWER,
  '- 题目未提供参考答案时（填空或简答），依据题干、解析、教师要求与学科常识判断作答是否正确、完整，rationale 说明判定依据；',
  ...SCORING_RULE_SUB_PROBLEMS,
  SCORING_RULE_RANGE,
  '- score.rationale 写给教师与审计查看：简要列出判定依据（逐空判定或得分点、扣分点），不写鼓励性话语。',
];

/**
 * 统一批阅的共享判分规则节（组合顺序第 ① 层，所有批阅 Scene 必带）。
 *
 * 与 content-service ObjectiveGrader 的 §3 统一判分口径一致，保证跨模块分数可比。
 */
export const ASSESSMENT_SCORING_RULES_SECTION = ASSESSMENT_SCORING_RULE_LINES.join('\n');

/** 声明了非 `ai` 判分模式的 Scene（测验）使用的共享判分规则节：仅首条规则不同，其余逐字节相同。 */
export const ASSESSMENT_SCORING_RULES_SECTION_MODE_AWARE = ASSESSMENT_SCORING_RULE_LINES.map(
  (line) => (line === ASSESSMENT_RULE_ALWAYS_SCORED ? ASSESSMENT_RULE_MODE_AWARE : line),
).join('\n');
