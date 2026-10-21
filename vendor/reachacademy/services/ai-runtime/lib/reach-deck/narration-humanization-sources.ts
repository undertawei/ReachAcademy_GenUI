/**
 * Reach Deck 中文讲稿去 AI 腔来源资产。
 *
 * 完整第三方 skill 和案例文件保存在 reference-packs/v1/narration-humanization/，本文件只
 * 暴露经过教师讲稿适配的规则，以及许可证允许逐字复用的短篇完整对照。OpenMAIC 一对一
 * 语料仍是正向教师声音的最高优先级；第三方材料只负责编辑纪律，不能替换教师人格。
 */

export interface NarrationHumanizationSource {
  readonly id: string;
  readonly project: 'Humanizer' | '说人话';
  readonly repository: string;
  readonly commitSha: string;
  readonly license: 'MIT';
  readonly copyright: string;
  readonly sourcePath: string;
  readonly vendoredPath: string;
  readonly sha256Lf: string;
  readonly copiedVerbatim: true;
  readonly productionEligible: boolean;
}

export interface NarrationHumanizationExample {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly originalText: string;
  readonly rewrittenText: string;
  readonly explanation: string;
  readonly productionEligible: boolean;
  readonly use: 'normal-prompt' | 'correction' | 'audit-only';
}

export const NARRATION_HUMANIZATION_SOURCES_VERSION = 'narration-humanization-sources/v1' as const;

export const NARRATION_HUMANIZATION_SOURCES: readonly NarrationHumanizationSource[] = [
  {
    id: 'blader-humanizer-skill-v3',
    project: 'Humanizer',
    repository: 'https://github.com/blader/humanizer',
    commitSha: '9862685f575c65a8247f90369951df1b3416e3d6',
    license: 'MIT',
    copyright: 'Copyright (c) 2025 Siqi Chen',
    sourcePath: 'SKILL.md',
    vendoredPath: 'reference-packs/v1/narration-humanization/blader-humanizer/SKILL.md',
    sha256Lf: 'e8269e236bed06ed0fe4824c274112e54950b0cb46b0bafe5e1576ef7c9f93d5',
    copiedVerbatim: true,
    productionEligible: false,
  },
  {
    id: 'shuorenhua-skill-v2-5',
    project: '说人话',
    repository: 'https://github.com/MrGeDiao/shuorenhua',
    commitSha: '5a9eafefe03807404135f4d2ee4f42fe61d58759',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 MrGeDiao',
    sourcePath: 'SKILL.md',
    vendoredPath: 'reference-packs/v1/narration-humanization/mrgediao-shuorenhua/SKILL.md',
    sha256Lf: '56a156045d2ac25ebf8210768b6c2608a42c37ac7ee4979d746cde7b026012db',
    copiedVerbatim: true,
    productionEligible: false,
  },
  {
    id: 'shuorenhua-examples-v2-5',
    project: '说人话',
    repository: 'https://github.com/MrGeDiao/shuorenhua',
    commitSha: '5a9eafefe03807404135f4d2ee4f42fe61d58759',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 MrGeDiao',
    sourcePath: 'references/examples.md',
    vendoredPath:
      'reference-packs/v1/narration-humanization/mrgediao-shuorenhua/references/examples.md',
    sha256Lf: 'ef6c9e19edd8f0addf6a95335adab1a0f6344bbebdc3f15981fd4182b0e6c29c',
    copiedVerbatim: true,
    productionEligible: true,
  },
  {
    id: 'shuorenhua-real-samples-v2-5',
    project: '说人话',
    repository: 'https://github.com/MrGeDiao/shuorenhua',
    commitSha: '5a9eafefe03807404135f4d2ee4f42fe61d58759',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 MrGeDiao',
    sourcePath: 'evals/real-samples.md',
    vendoredPath:
      'reference-packs/v1/narration-humanization/mrgediao-shuorenhua/evals/real-samples.md',
    sha256Lf: 'f61d2674c556057e999b6ac094e3753cd4aa20d6ee533a05b19f4dbfec94332b',
    copiedVerbatim: true,
    productionEligible: true,
  },
] as const;

/** 逐字复制自 MrGeDiao/shuorenhua；只做短小编辑纪律示范，不作为教师人格语料。 */
export const NARRATION_HUMANIZATION_EXAMPLES: readonly NarrationHumanizationExample[] = [
  {
    id: 'shuorenhua-strip-wrapper-preserve-result',
    sourceId: 'shuorenhua-examples-v2-5',
    title: '去掉包装，保留结果',
    originalText:
      '值得注意的是，本轮我们完成了对重试策略的调整，失败请求数从 24 次降到 7 次。简而言之，重试策略已经调整过了。',
    rewrittenText: '本轮调整了重试策略，失败请求数从 24 次降到 7 次。',
    explanation: '保留了动作、结果和数字。不能只写“请求更稳定了”，也不能补请求总量或下降百分比。',
    productionEligible: true,
    use: 'normal-prompt',
  },
  {
    id: 'shuorenhua-normal-technical-noop',
    sourceId: 'shuorenhua-examples-v2-5',
    title: '普通表达不必改',
    originalText:
      '闭环控制器每 20 ms 读取一次传感器。配置中的 `retry_limit` 为 3，超过后记录错误并退出。',
    rewrittenText:
      '闭环控制器每 20 ms 读取一次传感器。配置中的 `retry_limit` 为 3，超过后记录错误并退出。',
    explanation: '术语、数字和运行行为都正常。不能为了去“工程师腔”把它改成含糊的生活化解释。',
    productionEligible: true,
    use: 'correction',
  },
  {
    id: 'shuorenhua-chat-engineer-register',
    sourceId: 'shuorenhua-real-samples-v2-5',
    title: '微信对话 / 工程师腔溢出',
    originalText:
      '先说结论：吃日料。我把你最近三周的外卖记录过了一遍，已经把差异收窄到两个选项，根因基本坐实是你上周说过腻了火锅。要不要我顺手帮你把 X 店的外卖也下了？你一回复我就上手。',
    rewrittenText: '吃日料吧，上周你说火锅腻了。要帮你下单吗？',
    explanation: '核心信息和可执行动作都留下；删掉结论播报、工程师调试腔和推销式助手外壳。',
    productionEligible: true,
    use: 'normal-prompt',
  },
] as const;

export const NARRATION_HUMANIZATION_ADAPTED_RULES = [
  '每句话都要有教学作用：增加事实、解释、观察方向、纠错标准或真实操作；只负责宣布“重要、深入、核心”的句子删掉。',
  '先说眼前的对象、动作或变化，再说原因。注意力提示必须落到具体画面、数值、公式或操作，不能只说“下面深入探索”。',
  '没有页面依据或真实常见误区，不要凭空写“你可能以为……”“不是……而是……”。真实误区可以直接纠正。',
  '页面有几个真实部分就讲几个，不为显得完整硬凑三点、三步或三个问题。',
  '段尾停在具体结论、判断方法或下一步问题上，不追加重复前文的金句和价值拔高。',
  '已知主体时把主体和动作说早；主体未知时不要为了主动语态编造老师、学生、作者或系统。',
  '保留事实、主体、动作、条件、范围、否定、可能性、完成状态、比较、程度、公式和绑定；自然不等于擅自补机制、数据或结论。',
  '已经自然、准确的句子可以不改。不要为了证明做过 correction 而机械换同义词、加“你”、加问题或加亲密话术。',
  'OpenMAIC 原稿已经自然时，保留它的段落顺序、任务铺垫、完整复句和必要重复；不要为了“去 AI 腔”把教师说明压成一串短命令。',
  '项目、实验和合作任务中的行动主体、最终产物、时长、质量标准与步骤都属于事实，不能当作冗余包装删除。',
] as const;

const promptExamples = NARRATION_HUMANIZATION_EXAMPLES.filter(
  (example) => example.id === 'shuorenhua-chat-engineer-register',
);

const promptRules = [
  NARRATION_HUMANIZATION_ADAPTED_RULES[0],
  NARRATION_HUMANIZATION_ADAPTED_RULES[1],
  NARRATION_HUMANIZATION_ADAPTED_RULES[4],
  NARRATION_HUMANIZATION_ADAPTED_RULES[6],
  NARRATION_HUMANIZATION_ADAPTED_RULES[8],
  NARRATION_HUMANIZATION_ADAPTED_RULES[9],
] as const;

export const NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK = `Humanizer / 说人话编辑纪律
下面的完整对照只示范“删姿态、留信息”。它们不是教师人格，也不是当前课程内容；不要复制其中的事实。OpenMAIC 原稿仍是教师声音主参考，Humanizer 只清理明确的空话和外壳，不能借机压缩自然的任务铺垫、完整关系和教学步骤。

${promptExamples
  .map(
    (example) =>
      `【${example.title}】\n原文：${example.originalText}\n改写：${example.rewrittenText}`,
  )
  .join('\n\n')}

写完后静默检查：${promptRules.join('')}`;
