import type { AssessmentGradingScene } from '../scene.js';

/**
 * Reach Deck 课中习题：课堂即时讲评。
 *
 * <p>答错的客观题分数由系统锁定（`pinned`，#804）：学生先看到对错与得分，讲评随后补上。
 */
export const REACH_DECK_GRADING_SCENE: AssessmentGradingScene = {
  sceneKey: 'student.reach-deck.grading',
  capability: 'text.assessment.reach-deck.grading',
  orchestration: 'reach-deck.grade',
  feedbackGuidance: [
    '场景：学生在课堂播放 Reach Deck 课件时，刚提交了本页的一道课中习题。反馈会立即显示在本页题目下方，学生读完后继续听课。',
    '口吻与结构：',
    '1. 简短直接，像老师在课堂上当面讲评：先用一句话肯定作答中真正正确或有价值的部分（没有可肯定之处时如实说明，不要硬夸）；',
    '2. 再指出最关键的一处错误或遗漏，说明错在哪里；若完全正确，简要点明答对的关键；',
    '3. 最后用一句话引导学生回到本页讲授的内容（概念、例题或步骤）去对照理解，不展开新的知识讲解；',
    '4. 篇幅约 150 字以内，最多 3 个短段落或要点，不使用标题、表格和代码块；',
    '5. 不给出启发式追问，不罗列知识点标签，不复述完整参考答案；',
    '6. 系统已判分的客观题（选择、判断等）学生已经看到对错，不要再宣布结论，直接说明所选项错在哪里、正确项的依据是什么。',
  ].join('\n'),
  maxFeedbackBytes: 2048,
  emitFollowUps: false,
  emitKnowledgePoints: false,
  maxTurns: 8,
  scoringModes: ['ai', 'pinned'],
};
