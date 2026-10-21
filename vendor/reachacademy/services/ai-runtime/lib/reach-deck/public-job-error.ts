import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import { classifyReachDeckFailureReason, TTS_DEPENDENCY_FAILURE } from './failure-reason.js';

const GENERATION_CANCELLED_ERROR = 'Generation cancelled';

export type ReachDeckPublicFailureCategory =
  | 'dependency-unavailable'
  | 'dependency-rejected'
  | 'material-unavailable'
  | 'invalid-output'
  | 'superseded'
  | 'internal';

/**
 * 公开 job 视图不暴露原始错误，但携带稳定的失败分类码，
 * 供前端区分「上游模型暂不可用（可重试）」与「输出不合法」两类失败。
 */
export function sanitizeReachDeckGenerationJobError(
  status: string,
  error: string | undefined,
): string | undefined {
  if (error === undefined) return undefined;
  const guardrail = guardrailCode(error);
  if (guardrail) return guardrail;
  if (status === 'cancelled' || error === GENERATION_CANCELLED_ERROR) {
    return GENERATION_CANCELLED_ERROR;
  }
  if (status === 'failed') {
    return `Generation failed: ${classifyReachDeckPublicFailure(error)}`;
  }
  if (status === 'recovery-required') return 'Generation recovery is required';
  return 'Reach Deck generation status is temporarily unavailable';
}

export function classifyReachDeckPublicFailure(error: string): ReachDeckPublicFailureCategory {
  const classification = classifyReachDeckFailureReason(error);
  if (
    classification.failureReason === 'tts-timestamps-invalid' ||
    (classification.failureReason === 'provider-output-invalid' &&
      classification.failureReasonCode === 'provider-refusal')
  ) {
    return 'invalid-output';
  }
  // 引用的参考素材已不可用时重试也无法成功，需单独提示教师处理素材。
  if (classification.failureReason === 'material-asset-missing') {
    return 'material-unavailable';
  }
  if (isReachDeckTtsDependencyFailure(error)) {
    return 'dependency-unavailable';
  }
  // 没有原因码的不可重试 TTS 错误、不支持 SSML 的音色：请求本身被拒绝，原样重试无效。
  if (classification.failureReason === 'model-service-rejected') {
    return 'dependency-rejected';
  }
  if (
    /HTTP (500|502|503|504|521|529)|ECONNREFUSED|ETIMEDOUT|fetch failed|model-service dependency.*(?:SSE|stream)/i.test(
      error,
    )
  ) {
    return 'dependency-unavailable';
  }
  if (/model-service[^\n]*HTTP 4\d\d|HTTP 4\d\d[^\n]*model-service/i.test(error)) {
    return 'dependency-rejected';
  }
  if (/schema|parse|invalid|judge/i.test(error)) {
    return 'invalid-output';
  }
  if (/obsolete/i.test(error)) {
    return 'superseded';
  }
  return 'internal';
}

export function isReachDeckTtsDependencyFailure(error: string): boolean {
  return TTS_DEPENDENCY_FAILURE.test(error);
}
