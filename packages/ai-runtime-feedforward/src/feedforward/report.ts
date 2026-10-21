import { Type, type Static } from 'typebox';
import { Check, Errors } from 'typebox/value';
import {
  normalizeQuizMarkdownMath,
  validateQuizMarkdown,
  type QuizMarkdownDiagnostic,
} from '@reachany/quiz-markdown-contract';

/**
 * report_feedforward 终止工具的载荷 schema 与校验（独立纯函数，可单测）。
 *
 * <p>数据源：无（纯内存校验）。校验通过的报告由 AI Runtime Executor 回写 content-service 批阅记录。
 */

/** report_feedforward 的 typebox 参数 schema（同时用作 agent 工具的 parameters）。 */
export const FEEDFORWARD_REPORT_SCHEMA = Type.Object({
  score: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({
        value: Type.Number({ minimum: 0, description: '本题得分，0 到该题分值之间' }),
        rationale: Type.String({ minLength: 1, description: '给分依据说明' }),
      }),
    ]),
  ),
  feedback: Type.String({
    minLength: 1,
    description:
      '给学生的受控 Markdown 反馈；公式只用 \\(...\\) 或独立成行的 \\[...\\]，禁止美元公式',
  }),
  followUps: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  stepErrors: Type.Optional(
    Type.Array(
      Type.Object({
        step: Type.String({ minLength: 1, description: '学生原步骤（可摘录原式）' }),
        error: Type.String({ minLength: 1, description: '该步骤错在何处' }),
        knowledgePoint: Type.Optional(Type.String({ description: '对应知识点标签' })),
      }),
    ),
  ),
  knowledgePoints: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export type FeedforwardReportInput = Static<typeof FEEDFORWARD_REPORT_SCHEMA>;

/** 校验通过后归一化的单题报告。 */
export interface FeedforwardReport {
  score: { value: number; rationale: string } | null;
  feedback: string;
  followUps: string[];
  stepErrors: Array<{ step: string; error: string; knowledgePoint?: string }>;
  knowledgePoints: string[];
}

/**
 * 批阅 Scene 的附加限制（由批阅定义推导；不传时只做结构与分值校验）。
 * 超限时返回 business 错误，agent 在循环内按错误提示自我修正后重新提交。
 */
export interface FeedforwardReportLimits {
  /** feedback 的 UTF-8 字节上限。 */
  maxFeedbackBytes?: number;
  /** score.rationale 的 UTF-8 字节上限。 */
  maxRationaleBytes?: number;
  /** 为 true 时 feedback 与 rationale 禁止任何图片（Markdown 图片或 img/媒体 HTML）。 */
  forbidImages?: boolean;
  /**
   * 开放反馈图片的批阅 Scene：feedback 至多这么多张 `reachany-oss://` Markdown 图片（不得使用外链或媒体 HTML），
   * rationale 仍禁止任何图片。`forbidImages` 为 true 时忽略。
   */
  maxFeedbackImages?: number;
  /** 为 true 时 rationale 也走受控 Markdown 严格校验。 */
  strictRationaleMarkdown?: boolean;
  /** 为 false 时 followUps 归一为空数组。 */
  emitFollowUps?: boolean;
  /** 为 false 时 knowledgePoints 归一为空数组。 */
  emitKnowledgePoints?: boolean;
}

export type FeedforwardReportValidation =
  | { ok: true; report: FeedforwardReport }
  | {
      ok: false;
      kind: 'schema' | 'business' | 'markdown-unsafe' | 'markdown-repairable';
      errors: string[];
      diagnostics?: readonly QuizMarkdownDiagnostic[];
      pendingReport?: FeedforwardReport;
    };

/**
 * 校验一次 report_feedforward 提交。
 *
 * <p>核心逻辑：
 * <ol>
 *   <li>typebox 结构校验（字段类型、必填 feedback、score 可空对象）；</li>
 *   <li>业务规则校验：score.value 不得超过该题分值 maxPoints；</li>
 *   <li>失败返回中文错误列表（原样反馈给 agent 供其重试），通过则返回归一化报告
 *       （可选数组字段统一补空数组）。</li>
 * </ol>
 */
export function validateFeedforwardReport(
  value: unknown,
  options: { maxPoints: number; scoringEnabled?: boolean; limits?: FeedforwardReportLimits },
): FeedforwardReportValidation {
  if (!Check(FEEDFORWARD_REPORT_SCHEMA, value)) {
    const errors = [...Errors(FEEDFORWARD_REPORT_SCHEMA, value)].map(
      (error) => `${error.instancePath || '(root)'}: ${error.message}`,
    );
    return { ok: false, kind: 'schema', errors };
  }
  const input = value as FeedforwardReportInput;
  const feedback = normalizeQuizMarkdownMath(input.feedback);
  const score =
    input.score == null
      ? null
      : { ...input.score, rationale: normalizeQuizMarkdownMath(input.score.rationale) };
  if (options.scoringEnabled === true && score === null) {
    return {
      ok: false,
      kind: 'business',
      errors: ['/score: score is required when scoring is enabled'],
    };
  }
  if (options.scoringEnabled === false && score !== null) {
    return {
      ok: false,
      kind: 'business',
      errors: ['/score: score must be null when scoring is disabled'],
    };
  }
  if (score !== null && score.value > options.maxPoints) {
    return {
      ok: false,
      kind: 'business',
      errors: [`/score/value: 得分 ${score.value} 超过了该题分值上限 ${options.maxPoints}`],
    };
  }
  const limits = options.limits;
  if (limits !== undefined) {
    const errors = limitErrors(feedback, score?.rationale, limits);
    if (errors.length > 0) return { ok: false, kind: 'business', errors };
  }
  const report: FeedforwardReport = {
    score,
    feedback,
    followUps: limits?.emitFollowUps === false ? [] : (input.followUps ?? []),
    stepErrors: (input.stepErrors ?? []).map((entry) => ({
      step: entry.step,
      error: entry.error,
      ...(entry.knowledgePoint === undefined ? {} : { knowledgePoint: entry.knowledgePoint }),
    })),
    knowledgePoints: limits?.emitKnowledgePoints === false ? [] : (input.knowledgePoints ?? []),
  };
  const markdown = validateQuizMarkdown(feedback);
  if (!markdown.ok) {
    return {
      ok: false,
      kind: markdown.repairable ? 'markdown-repairable' : 'markdown-unsafe',
      errors: markdown.diagnostics.map(
        (entry) => `/feedback:${entry.start}-${entry.end} [${entry.code}] ${entry.message}`,
      ),
      diagnostics: markdown.diagnostics,
      ...(markdown.repairable ? { pendingReport: report } : {}),
    };
  }
  return { ok: true, report };
}

const IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)|<\s*(img|picture|video|audio|source|iframe)\b/i;
/** Markdown 图片：`![alt](target)` 或带可选标题 `![alt](target "title")`；target 可用尖括号包住。 */
const MARKDOWN_IMAGE_PATTERN =
  /!\[[^\]]*\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

/** 反馈图片引用的对象协议。 */
export const OSS_IMAGE_SCHEME = 'reachany-oss://';

/**
 * 提取 Markdown 中全部图片的目标地址（忽略可选标题）。工具层校验“只能引用本题生成的图片”与报告层的张数 /
 * 协议校验共用这一份解析，避免带标题的引用绕过其中一处。
 */
export function markdownImageTargets(markdown: string): string[] {
  return [...markdown.matchAll(MARKDOWN_IMAGE_PATTERN)].map((match) => match[1] ?? '');
}
const MEDIA_HTML_PATTERN = /<\s*(img|picture|video|audio|source|iframe)\b/i;

function limitErrors(
  feedback: string,
  rationale: string | undefined,
  limits: FeedforwardReportLimits,
): string[] {
  const errors: string[] = [];
  const feedbackBytes = Buffer.byteLength(feedback, 'utf8');
  if (limits.maxFeedbackBytes !== undefined && feedbackBytes > limits.maxFeedbackBytes) {
    errors.push(
      `/feedback: 反馈正文 ${feedbackBytes} 字节，超过上限 ${limits.maxFeedbackBytes} 字节，请精简后重新提交`,
    );
  }
  if (rationale !== undefined) {
    const rationaleBytes = Buffer.byteLength(rationale, 'utf8');
    if (limits.maxRationaleBytes !== undefined && rationaleBytes > limits.maxRationaleBytes) {
      errors.push(
        `/score/rationale: 判分依据 ${rationaleBytes} 字节，超过上限 ${limits.maxRationaleBytes} 字节，请精简后重新提交`,
      );
    }
    if (limits.strictRationaleMarkdown === true) {
      const markdown = validateQuizMarkdown(rationale);
      if (!markdown.ok) {
        errors.push(
          ...markdown.diagnostics.map(
            (entry) =>
              `/score/rationale:${entry.start}-${entry.end} [${entry.code}] ${entry.message}`,
          ),
        );
      }
    }
  }
  if (limits.forbidImages === true) {
    if (IMAGE_PATTERN.test(feedback)) errors.push('/feedback: 本场景禁止在反馈中插入任何图片');
    if (rationale !== undefined && IMAGE_PATTERN.test(rationale)) {
      errors.push('/score/rationale: 本场景禁止在判分依据中插入任何图片');
    }
  } else if (limits.maxFeedbackImages !== undefined) {
    const images = markdownImageTargets(feedback);
    if (MEDIA_HTML_PATTERN.test(feedback)) {
      errors.push('/feedback: 反馈中不得使用 img 或其他媒体 HTML');
    }
    if (images.some((target) => !target.startsWith(OSS_IMAGE_SCHEME))) {
      errors.push(
        '/feedback: 反馈图片只能原样引用 generate_feedback_image 返回的 reachany-oss:// 片段',
      );
    }
    if (images.length > limits.maxFeedbackImages) {
      errors.push(
        `/feedback: 反馈至多 ${limits.maxFeedbackImages} 张图片，当前 ${images.length} 张，请删减后重新提交`,
      );
    }
    if (rationale !== undefined && IMAGE_PATTERN.test(rationale)) {
      errors.push('/score/rationale: 判分依据中不得插入任何图片');
    }
  }
  return errors;
}
