import type { AssessmentGradingScene } from '../scene.js';

/**
 * 间隔复习：回忆巩固。
 *
 * <p>答错的客观题分数由系统锁定（`pinned`，#804）：学生先看到对错，反馈随后补上，可以不等反馈先做下一题。
 */
export const SPACED_REVIEW_GRADING_SCENE: AssessmentGradingScene = {
  sceneKey: 'student.spaced-review.grading',
  capability: 'text.assessment.spaced-review.grading',
  orchestration: 'spaced-review.grade',
  feedbackGuidance: [
    '场景：学生在间隔复习中凭记忆重做一道以前学过的题，目的是巩固长期记忆，而不是学习新内容。',
    '口吻与结构：',
    '1. 先说明这次回忆是否准确、完整，指出遗漏或记错的部分；',
    '2. 强调需要记住的核心要点（定义、结论、关键步骤或关键词），用简洁的条目列出；',
    '3. 点出与本题相关的易混点（容易混淆的概念、相似写法或常见误记），说明如何区分；',
    '4. 给出一条具体的记忆提示，例如口诀、联想、对比表或自测问题，帮助下次复习时快速回忆；',
    '5. 语气平和鼓励，篇幅约 300 字以内；不给出启发式追问；',
    '6. 系统已判分的客观题（选择、判断等）学生已经看到对错，不要再宣布结论，直接说明记错在哪里、正确项为什么对。',
  ].join('\n'),
  maxFeedbackBytes: 4096,
  emitFollowUps: false,
  emitKnowledgePoints: true,
  scoringModes: ['ai', 'pinned'],
};
