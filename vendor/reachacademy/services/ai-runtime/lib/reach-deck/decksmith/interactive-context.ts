import type { ReachDeckSceneType } from '@reachany/reach-deck-dsl';

/**
 * 教师口中的「互动题 / 课中互动题」指测验页（quiz），「GenUI / 互动页 / 互动活动」才是互动页。
 * 早先把「互动题」也算进来，导致"把 GenUI 改成互动题"被引导去重写 GenUI HTML
 * （测试环境 2026-10-02、10-06 两门课实测），所以这里显式排除「互动题」。
 */
const INTERACTIVE_CONTEXT_TERM = /(?:interactive|gen\s*ui|互动(?!题))/iu;

/** Enables the coding harness without trying to classify the requested edit operation. */
export function shouldEnableDecksmithInteractiveHarness(
  prompt: string,
  originSceneType?: ReachDeckSceneType,
): boolean {
  return originSceneType === 'interactive' || INTERACTIVE_CONTEXT_TERM.test(prompt);
}
