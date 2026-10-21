/**
 * 跨阶段共享的 prompt 片段（snippet）。
 *
 * 参考 services/ai-runtime/lib/reach-deck/prompts/snippets.ts 的组织方式：
 * 输出纪律等通用约束只在此处维护一份，各模板拼装引用，避免多处漂移。
 */

import {
  QUIZ_BLOCK_MATH_CLOSE,
  QUIZ_BLOCK_MATH_OPEN,
  QUIZ_INLINE_MATH_CLOSE,
  QUIZ_INLINE_MATH_OPEN,
} from '@reachany/quiz-markdown-contract';

const IMAGE_RULE =
  '6. 图片仅可引用图片工具刚刚返回的 ![替代文本](reachany-oss://objectKey)，不得自行编造 objectKey，不得使用外链、data/blob URL 或媒体 HTML；图片是可选教学工具，不是每题必需；';

/** 不允许反馈图片的场景（统一批阅）替换第 6 条。 */
const NO_IMAGE_RULE =
  '6. 禁止插入任何图片：不得使用 Markdown 图片语法、reachany-oss:// 引用、外链、data/blob URL 或媒体 HTML；';

const MARKDOWN_OUTPUT_RULE_LINES = [
  'feedback 正文的输出规则：',
  '1. feedback 是一份受控 Markdown 文档，可使用标题、列表、粗体、斜体、删除线、引用、表格、任务列表和代码块；',
  `2. 行内公式只使用 ${QUIZ_INLINE_MATH_OPEN}x${QUIZ_INLINE_MATH_CLOSE}；块级公式的 ${QUIZ_BLOCK_MATH_OPEN} 与 ${QUIZ_BLOCK_MATH_CLOSE} 必须各自独立成行；`,
  '3. 禁止用 $...$ 或 $$...$$ 表示公式；所有 $（包括 $100、US$ 与 $x$）都会按普通文本显示；',
  '4. 普通代码使用带语言名的围栏代码块；流程图可使用 ```mermaid 围栏，并保持源码简短；Mermaid 节点标签含括号、方括号、公式定界符或 $ 时必须用双引号包住完整标签；',
  '5. 字体颜色只允许 <span data-feedback-color="accent|success|warning|danger|muted">正文</span> 中五个单独的值，不得使用 style 或其他 HTML；',
  IMAGE_RULE,
  '7. 粗体、删除线、反引号、代码围栏和公式定界符必须成对闭合；',
  '8. 面向学生书写，语气友善、具体、可执行。',
  '9. 解释公式语法而需要展示定界符本身时，必须把每个完整定界符写进行内代码；错误示例：\\( 和 \\)、\\( ... \\)；正确示例：`\\(` 和 `\\)`、`\\(...)`。',
];

/** Markdown 输出纪律：feedback 正文的书写规则。 */
export const MARKDOWN_OUTPUT_RULES_SNIPPET = MARKDOWN_OUTPUT_RULE_LINES.join('\n');

/** 禁止反馈图片的 Markdown 输出纪律（统一批阅使用；其余条目与测验一致）。 */
export const MARKDOWN_OUTPUT_RULES_NO_IMAGES_SNIPPET = MARKDOWN_OUTPUT_RULE_LINES.map((line) =>
  line === IMAGE_RULE ? NO_IMAGE_RULE : line,
).join('\n');
