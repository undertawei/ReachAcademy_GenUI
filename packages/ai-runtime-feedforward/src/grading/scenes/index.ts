import {
  ASSESSMENT_GRADING_IMAGE_TOOL,
  ASSESSMENT_GRADING_REQUIRED_TOOLS,
  ASSESSMENT_GRADING_SLIDE_TOOL,
  ASSESSMENT_GRADING_TEXT_LIMIT_BYTES,
  ASSESSMENT_GRADING_TOOLS,
  ASSESSMENT_SCORING_MODES,
  gradingSceneTools,
  type AssessmentGradingScene,
} from '../scene.js';
import { ASSESSMENT_GRADING_PROMPT_VERSION, composeGradingSystemPrompt } from '../prompt.js';
import { QUIZ_GRADING_SCENE } from './quiz.js';
import { REACH_DECK_GRADING_SCENE } from './reach-deck.js';
import { SPACED_REVIEW_GRADING_SCENE } from './spaced-review.js';

/** 批阅 Scene key 的形状：`student.<模块>.grading`。 */
const GRADING_SCENE_KEY_PATTERN = /^student\.[a-z0-9-]+\.grading$/;
/**
 * 沿用原名的批阅 Scene key：迁移进统一批阅前已经存在、沿用原 Scene、槽位与通道的模块，不新增统一名称。
 * 本期只有测验。
 */
export const ASSESSMENT_GRADING_LEGACY_SCENE_KEYS: readonly string[] = Object.freeze([
  'student.quiz.feedforward',
]);
/** model-service stage 的形状（小写段）。 */
const STAGE_PATTERN = /^[a-z0-9-]+$/;
/** 每题反馈图片张数上限（content-service 每题按 Scene 声明计数，此处只约束声明本身）。 */
const MAX_FEEDBACK_IMAGES_PER_QUESTION = 3;
/** capability 与 orchestration 的形状（小写点分段）。 */
const DOTTED_ID_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** 共享 agent 循环的最大轮数；批阅定义只能收窄。 */
export const ASSESSMENT_GRADING_MAX_TURNS = 10;

/** 本期登记的全部批阅 Scene（新增模块只需新增一个文件并登记在此，再同步 Runtime Scene 与 model-service 槽位）。 */
export const ASSESSMENT_GRADING_SCENES: readonly AssessmentGradingScene[] = Object.freeze([
  REACH_DECK_GRADING_SCENE,
  SPACED_REVIEW_GRADING_SCENE,
  QUIZ_GRADING_SCENE,
]);

/** 校验一个批阅定义是否满足共享约束；不合法时抛错（登记表加载时即失败）。 */
export function assertValidGradingScene(scene: AssessmentGradingScene): void {
  const label = scene.sceneKey;
  if (
    !GRADING_SCENE_KEY_PATTERN.test(scene.sceneKey) &&
    !ASSESSMENT_GRADING_LEGACY_SCENE_KEYS.includes(scene.sceneKey)
  ) {
    throw new Error(`Grading scene key is invalid: ${label}`);
  }
  if (!DOTTED_ID_PATTERN.test(scene.capability) || !scene.capability.startsWith('text.')) {
    throw new Error(`Grading scene capability is invalid: ${label}`);
  }
  if (!DOTTED_ID_PATTERN.test(scene.orchestration)) {
    throw new Error(`Grading scene orchestration is invalid: ${label}`);
  }
  if (scene.stage !== undefined && !STAGE_PATTERN.test(scene.stage)) {
    throw new Error(`Grading scene stage is invalid: ${label}`);
  }
  const imagesAllowed = scene.imagesAllowed === true;
  const maxImages = scene.maxFeedbackImages ?? 0;
  if (
    !Number.isSafeInteger(maxImages) ||
    (imagesAllowed
      ? maxImages < 1 || maxImages > MAX_FEEDBACK_IMAGES_PER_QUESTION
      : maxImages !== 0)
  ) {
    throw new Error(
      `Grading scene maxFeedbackImages must be 1..${MAX_FEEDBACK_IMAGES_PER_QUESTION} when images are allowed, otherwise 0: ${label}`,
    );
  }
  if (scene.scoringModes !== undefined) {
    if (
      scene.scoringModes.length === 0 ||
      !scene.scoringModes.includes('ai') ||
      scene.scoringModes.some((mode) => !ASSESSMENT_SCORING_MODES.includes(mode)) ||
      new Set(scene.scoringModes).size !== scene.scoringModes.length
    ) {
      throw new Error(`Grading scene scoringModes are invalid: ${label}`);
    }
  }
  if (scene.feedbackGuidance.trim().length === 0) {
    throw new Error(`Grading scene feedback guidance is empty: ${label}`);
  }
  if (
    !Number.isSafeInteger(scene.maxFeedbackBytes) ||
    scene.maxFeedbackBytes < 256 ||
    scene.maxFeedbackBytes > ASSESSMENT_GRADING_TEXT_LIMIT_BYTES
  ) {
    throw new Error(`Grading scene maxFeedbackBytes must be within 256..8192: ${label}`);
  }
  if (
    scene.maxTurns !== undefined &&
    (!Number.isSafeInteger(scene.maxTurns) ||
      scene.maxTurns < 2 ||
      scene.maxTurns > ASSESSMENT_GRADING_MAX_TURNS)
  ) {
    throw new Error(`Grading scene maxTurns must be within 2..10: ${label}`);
  }
  if (scene.tools !== undefined) {
    // 只能在共享白名单内收窄；唯一允许的扩展是 PPTX 单页渲染，以及开放图片时的反馈图片生成。
    const allowed = new Set<string>([...ASSESSMENT_GRADING_TOOLS, ASSESSMENT_GRADING_SLIDE_TOOL]);
    if (imagesAllowed) allowed.add(ASSESSMENT_GRADING_IMAGE_TOOL);
    if (scene.tools.some((tool) => !allowed.has(tool))) {
      throw new Error(`Grading scene tools must narrow the shared whitelist: ${label}`);
    }
    if (new Set(scene.tools).size !== scene.tools.length) {
      throw new Error(`Grading scene tools must not repeat: ${label}`);
    }
    if (ASSESSMENT_GRADING_REQUIRED_TOOLS.some((tool) => !scene.tools!.includes(tool))) {
      throw new Error(`Grading scene tools must keep the report tools: ${label}`);
    }
  }
}

const REGISTRY: ReadonlyMap<string, AssessmentGradingScene> = (() => {
  const registry = new Map<string, AssessmentGradingScene>();
  const capabilities = new Set<string>();
  const orchestrations = new Set<string>();
  for (const scene of ASSESSMENT_GRADING_SCENES) {
    assertValidGradingScene(scene);
    if (registry.has(scene.sceneKey)) throw new Error(`Duplicate grading scene: ${scene.sceneKey}`);
    // 每个模块独立的 capability 与 orchestration 才能在 model-service 独立配置模型策略、独立计量。
    if (capabilities.has(scene.capability) || orchestrations.has(scene.orchestration)) {
      throw new Error(`Grading scene must own its capability and orchestration: ${scene.sceneKey}`);
    }
    capabilities.add(scene.capability);
    orchestrations.add(scene.orchestration);
    registry.set(scene.sceneKey, Object.freeze({ ...scene }));
  }
  return registry;
})();

/**
 * 按 Run 的 Scene key 解析批阅定义。
 *
 * 未登记返回 `null`，调用方必须判失败（走失败回调），不得回退到其他 Scene。
 */
export function resolveGradingScene(sceneKey: unknown): AssessmentGradingScene | null {
  return typeof sceneKey === 'string' ? (REGISTRY.get(sceneKey) ?? null) : null;
}

/** 是否为已登记的批阅 Scene。 */
export function isAssessmentGradingSceneKey(sceneKey: unknown): boolean {
  return resolveGradingScene(sceneKey) !== null;
}

/**
 * 某个批阅 Scene 的 promptSha256 来源：实际发给模型的组合提示词的版本化基底。
 *
 * <p>以该 Scene 的工具子集组合 system prompt（骨架、共享判分规则与 Scene 反馈指引），前置提示词骨架
 * 版本号。学科 skill 与教师要求属于每次运行的输入，不计入。骨架、判分规则或该 Scene 指引的任何变化
 * 都会改变该值。
 */
export function assessmentGradingPromptFingerprintSource(sceneKey: string): string {
  const scene = resolveGradingScene(sceneKey);
  if (scene === null) throw new Error(`Unknown grading scene: ${sceneKey}`);
  return [
    ASSESSMENT_GRADING_PROMPT_VERSION,
    composeGradingSystemPrompt({
      scene,
      toolNames: gradingSceneTools(scene),
      skillSections: '',
      teacherRequirements: {},
    }),
  ].join('\n\n---\n\n');
}

export { QUIZ_GRADING_SCENE, REACH_DECK_GRADING_SCENE, SPACED_REVIEW_GRADING_SCENE };
