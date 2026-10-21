/**
 * 作答批阅 Scene 的登记契约。
 *
 * 每个接入模块一个 AI Runtime Scene（各自的 capability、model-service 槽位与通道），底层共用同一套
 * 实现：同一个 Runtime 路由、同一个 Executor、同一个 pi-agent 循环与同一套分层提示词组合。业务适配器在
 * 提交时声明 Scene 并写入批阅记录；Executor 按 Run 的 Scene 从登记表解析批阅定义，未登记即判失败。
 * 批阅定义只影响 system prompt 的第 ② 层（反馈指引）、输出限制、工具子集与模型路由，不改变共享判分规则与
 * agent 循环。
 */

/** 批阅 Scene 在 model-service 的缺省 stage；Scene 可用 {@link AssessmentGradingScene.stage} 声明其他 stage。 */
export const ASSESSMENT_GRADING_STAGE = 'grading';

/** 批阅 Scene 的共享工具白名单；不含任何图片生成或持久化工具。 */
export const ASSESSMENT_GRADING_TOOLS = [
  'read_attachment',
  'get_class_performance',
  'get_recent_homework',
  'find_similar_mistakes',
  'report_feedforward',
  'patch_feedforward_markdown',
] as const;

/** 共享白名单之外，批阅定义可额外声明的 PPTX 单页渲染工具。 */
export const ASSESSMENT_GRADING_SLIDE_TOOL = 'render_presentation_slide';

/** 反馈图片生成工具：只有声明 {@link AssessmentGradingScene.imagesAllowed} 的批阅定义可以声明。 */
export const ASSESSMENT_GRADING_IMAGE_TOOL = 'generate_feedback_image';

export type AssessmentGradingToolName =
  | (typeof ASSESSMENT_GRADING_TOOLS)[number]
  | typeof ASSESSMENT_GRADING_SLIDE_TOOL
  | typeof ASSESSMENT_GRADING_IMAGE_TOOL;

/** 回写 content-service 的 rationale / feedbackMarkdown 上限（UTF-8 字节，附录 A.3）。 */
export const ASSESSMENT_GRADING_TEXT_LIMIT_BYTES = 8192;

/** 批阅定义必须保留的终止工具：没有它 agent 无法提交结构化结果。 */
export const ASSESSMENT_GRADING_REQUIRED_TOOLS: readonly AssessmentGradingToolName[] = [
  'report_feedforward',
  'patch_feedforward_markdown',
];

/**
 * 批阅记录的判分模式（content-service bundle 的 `scoringMode`）。
 *
 * <ul>
 *   <li>`ai`：AI 判分并写反馈；</li>
 *   <li>`pinned`：分数已由系统锁定（bundle `pinnedScore`），AI 只写反馈，回调分数由 content-service 丢弃；</li>
 *   <li>`feedback_only`：本题不计分，AI 只写反馈，score 传 null。</li>
 * </ul>
 */
export type AssessmentScoringMode = 'ai' | 'pinned' | 'feedback_only';

export const ASSESSMENT_SCORING_MODES: readonly AssessmentScoringMode[] = [
  'ai',
  'pinned',
  'feedback_only',
];

export interface AssessmentGradingScene {
  /**
   * AI Runtime Scene key，例如 `student.reach-deck.grading`；同时是服务令牌的 `scene_id`。
   * 形状为 `student.<模块>.grading`，或属于沿用原名清单（见 `ASSESSMENT_GRADING_LEGACY_SCENE_KEYS`）。
   */
  readonly sceneKey: string;
  /** model-service 文本 capability，例如 `text.assessment.reach-deck.grading`。 */
  readonly capability: string;
  /** model-service orchestration，例如 `reach-deck.grade`。 */
  readonly orchestration: string;
  /** model-service 槽位的 stage；缺省为 {@link ASSESSMENT_GRADING_STAGE}（测验沿用 `feedback`）。 */
  readonly stage?: string;
  /** 第 ② 层：场景语境、口吻、篇幅与结构（中文提示词正文，不含标题）。 */
  readonly feedbackGuidance: string;
  /** feedback 的 UTF-8 字节上限（≤ 8192），在 report 校验中强制，超限时 agent 在循环内自我修正。 */
  readonly maxFeedbackBytes: number;
  /** 是否输出启发式追问 followUps；为 false 时报告中的 followUps 归一为空数组。 */
  readonly emitFollowUps: boolean;
  /** 是否输出知识点标签 knowledgePoints；为 false 时归一为空数组。 */
  readonly emitKnowledgePoints: boolean;
  /**
   * 是否开放反馈图片（`generate_feedback_image`）；缺省 false。须与 content-service
   * `AssessmentGradingScenes.Descriptor.feedbackImagesAllowed` 一致。
   */
  readonly imagesAllowed?: boolean;
  /** 每题（每条记录每个调度轮次）反馈图片张数上限；缺省 0，开放图片时须 ≥ 1。 */
  readonly maxFeedbackImages?: number;
  /**
   * 可接受的判分模式；缺省只有 `ai`。bundle 的 `scoringMode` 不在其中时 Executor 判失败。声明非 `ai` 模式的
   * Scene，骨架与共享判分规则改为按题目信息中的判分模式提交 score。
   */
  readonly scoringModes?: readonly AssessmentScoringMode[];
  /**
   * 可选的工具子集：{@link ASSESSMENT_GRADING_TOOLS} 的子集，只允许额外加入
   * {@link ASSESSMENT_GRADING_SLIDE_TOOL} 与（开放图片时）{@link ASSESSMENT_GRADING_IMAGE_TOOL}，且须包含终止工具。
   */
  readonly tools?: readonly AssessmentGradingToolName[];
  /** 可选的最大 LLM 轮数（不超过共享 agent 上限）。 */
  readonly maxTurns?: number;
}

export function gradingSceneTools(
  scene: AssessmentGradingScene,
): readonly AssessmentGradingToolName[] {
  return scene.tools ?? ASSESSMENT_GRADING_TOOLS;
}

/** 批阅定义声明的 model-service stage（缺省 `grading`）。 */
export function gradingSceneStage(scene: AssessmentGradingScene): string {
  return scene.stage ?? ASSESSMENT_GRADING_STAGE;
}

/** 批阅定义每题可生成的反馈图片张数；未开放图片时恒为 0。 */
export function gradingSceneMaxFeedbackImages(scene: AssessmentGradingScene): number {
  return scene.imagesAllowed === true ? (scene.maxFeedbackImages ?? 0) : 0;
}

/** 批阅定义可接受的判分模式（缺省只有 `ai`）。 */
export function gradingSceneScoringModes(
  scene: AssessmentGradingScene,
): readonly AssessmentScoringMode[] {
  return scene.scoringModes ?? ['ai'];
}
