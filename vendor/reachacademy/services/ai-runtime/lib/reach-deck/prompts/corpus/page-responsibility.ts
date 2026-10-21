/** Approved product contract, preserved verbatim from the capability integration plan. */
export const PAGE_RESPONSIBILITY_PRIORITY_VERSION = 'page-responsibility/v1';
export const PAGE_RESPONSIBILITY_PRIORITY = `“以页面职责为纲”是 Stage 3、Slide、Quiz、Interactive 和 Narration 共享的核心教学合同，不能只保留几个 pageRole 字段。

- pageRole、pageFunctions、pageJob 或等价页面职责是当前页面的首要教学依据。
- 单页文字要求、页面标题、视觉方向、历史字段、旧版 keyPoints、单页问题数量或局部 activity hint 与页面职责冲突时，以页面职责为优先。
- 页面职责决定该页应该引入、观察、解释、示范、练习、评价、迁移还是收束。
- Slide 不能因为单页要求写了“让学生回答”就伪装成可提交的学习活动。
- Quiz/Interactive 不能因为单页要求写了“讲清楚”就代替页面职责之外的解释页。
- question_without_answer 不能提前揭示答案。
- resolve_prior_question、explain_current_idea、demonstrate_reasoning 必须直接完成当前页面职责，不能为了满足通用的“提出问题”要求重新吊胃口。
- synthesis、transfer、close 的职责不能被普通讲解页或单页标题要求改写。
- 最后一页的位置不能自动改变其页面职责。
- 页面职责与单页请求冲突时，尽量保留单页请求中的事实和材料，但必须按照页面职责决定表达方式、教学动作和输出类型。
- 页面职责不能被 GenUI 的固定机制、讲稿动画绑定或视觉模板反向改写。

冲突样例：
- 页面职责要求解释，单页要求只提问。
- 页面职责要求 Quiz，单页要求 Slide 收集答案。
- 页面职责要求揭示，单页要求继续悬念。
- 页面职责要求收束，单页要求新增知识。
- 页面职责要求迁移，单页要求重新讲完整定义。
- 页面职责要求自由 Interactive，单页 hint 指定固定控件或步骤。

每个冲突样例都要遵守页面职责优先，并保留单页要求中不冲突的事实内容。`;
