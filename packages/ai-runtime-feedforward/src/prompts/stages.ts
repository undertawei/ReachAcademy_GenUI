/**
 * 单题批阅 agent 循环的模板版本号。
 *
 * 版本号会随请求写入 model-service 的 llm span metadata，便于按版本观测错误率与回滚。统一批阅的 system
 * prompt 由 `grading/prompt.ts` 分层组合（版本见 `ASSESSMENT_GRADING_PROMPT_VERSION`）；本文件只保留
 * awaiting_markdown_patch 后续轮次的独立观测版本。
 */

/** awaiting_markdown_patch 后续模型轮次的独立观测版本。 */
export const FEEDFORWARD_MARKDOWN_PATCH_PROMPT_VERSION = 'feedforward-markdown-patch/v1';
