/**
 * AI Runtime Feedforward Scene 使用的 model-service capability 常量。
 *
 * 注意：以下 capability 需要算法团队在 model-service 的白名单中配置路由策略，
 * 未配置时调用会返回 4xx。逐题文本调用交由 job 重试/失败回调处理；附件视觉识别
 * 在 read_attachment 工具内降级为可读错误，不中断整题。
 */

/** 逐题 feedforward agent 循环使用的文本对话 capability。 */
export const FEEDFORWARD_TEXT_CAPABILITY = 'text.assessment.feedforward';

/** 逐题解释图片生成能力。 */
export const FEEDFORWARD_IMAGE_CAPABILITY = 'image.assessment.feedforward';

/** PDF extraction through model-service's managed document gateway. */
export const FEEDFORWARD_PDF_CAPABILITY = 'document.assessment.feedforward.pdf';

/** Audio transcription through model-service's policy-routed ASR gateway. */
export const FEEDFORWARD_ASR_CAPABILITY = 'media.assessment.feedforward.asr';

/** Task-directed audio understanding through model-service's direct OpenRouter gateway. */
export const FEEDFORWARD_AUDIO_UNDERSTANDING_CAPABILITY =
  'media.assessment.feedforward.audio-understanding';

/** Task-directed video understanding through model-service's direct OpenRouter gateway. */
export const FEEDFORWARD_VIDEO_UNDERSTANDING_CAPABILITY =
  'media.assessment.feedforward.video-understanding';
