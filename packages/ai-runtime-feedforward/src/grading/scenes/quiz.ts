import type { AssessmentGradingScene } from '../scene.js';

/**
 * 测验：逐题形成性反馈（feedforward）。
 *
 * <p>沿用原 Scene key `student.quiz.feedforward`、capability `text.assessment.feedforward` 与 model-service
 * 槽位 `quiz.feedback.chat`（stage `feedback`）、图片槽位 `quiz.feedback.image-generation`。反馈指引承接原整卷
 * 提示词 `FEEDFORWARD_QUESTION_PROMPT`（feedforward-question/v9，已删除）的反馈部分（角色、附件与音视频处理、反馈结构）；判分规则改用共享判分规则，
 * PPTX 单页渲染与反馈图片的用法由骨架按可用工具生成。客观题分数由系统锁定（`pinned`），不计分的题只写反馈
 * （`feedback_only`）。
 */
export const QUIZ_GRADING_SCENE: AssessmentGradingScene = {
  sceneKey: 'student.quiz.feedforward',
  capability: 'text.assessment.feedforward',
  orchestration: 'quiz.feedback',
  stage: 'feedback',
  feedbackGuidance: [
    '场景：学生完成一份测验并交卷，本题的反馈会显示在测验结果中，直接展示给学生本人。你的任务不是简单判分，',
    '而是帮助学生理解“哪里对了、哪里错了、为什么错、下一步怎么改进”（形成性反馈 feedforward）。',
    '分析方法：',
    '1. 阅读注入的教学方法 skill（若有），按其方法论组织分析与反馈；',
    '2. PDF 会返回有界正文和页内图片，应结合两者理解，不得忽略图表、示意图或手写内容；',
    '   DOCX 会返回可见正文、表格及受支持的内嵌图片；XLSX 会返回可见单元格显示值与未执行的公式文本；',
    '3. 对音频或视频，先结合题目、学生作答和教师反馈要求生成具体 analysisTask，调用 read_attachment 时传入该任务，',
    '   并判断是否确有必要将 includeTranscript 设为 true；音视频理解结果用于整体反馈，不生成或引用源媒体时间片段；',
    '4. 附件用于理解学生作答；附件不可读时如实说明证据有限，不要声称已经看过。',
    '   unauthorized_object_key 是工具参数中的附件引用错误，不是文件读取失败，也不能据此判定缺少作答证据。',
    '   遇到该错误时从 availableObjectKeys 中逐字复制本次所需的授权 objectKey 并重试一次；不得猜测或改写路径。',
    '   只有使用正确授权引用实际读取后仍返回文件处理限制时，才说明对应限制并基于其余证据继续批阅。',
    '反馈结构：',
    '1. 先肯定作答中真正正确或有价值的部分（没有可肯定之处时如实说明，不要硬夸）；',
    '2. 指出错误或遗漏，说明错在哪里、为什么错，必要时对照题目考查的概念或关键步骤解释；',
    '3. 给出下一步具体、可执行的改进建议；完全正确时简要点明答对的关键，并给出巩固或拓展方向；',
    '4. 题目带有所属大题的上下文时，只针对本小题作答写反馈；',
    '5. 篇幅与题目难度相称，结构清晰，可使用小标题、列表与公式；不给出启发式追问，不罗列知识点标签。',
  ].join('\n'),
  maxFeedbackBytes: 8192,
  emitFollowUps: false,
  emitKnowledgePoints: false,
  imagesAllowed: true,
  maxFeedbackImages: 1,
  scoringModes: ['ai', 'pinned', 'feedback_only'],
  tools: [
    'read_attachment',
    'render_presentation_slide',
    'get_class_performance',
    'get_recent_homework',
    'find_similar_mistakes',
    'generate_feedback_image',
    'report_feedforward',
    'patch_feedforward_markdown',
  ],
};
