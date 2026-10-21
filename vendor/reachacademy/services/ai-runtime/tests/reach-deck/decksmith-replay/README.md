# Decksmith 回放回归

Decksmith 优化方案（`docs/plans/2026-10-08-decksmith-harness-optimization.md`）WP0 / WP9 第①层：
**不调用模型**的确定性回归，是后续各 WP 的闸门。脚本化模型替换网络模型，图片授权/编辑/生成/存储用桩，
其余（pi-agent-core `agentLoop`、参数校验、工具、`DecksmithDocumentSession`、提示词组装）全部走真实代码。

```bash
pnpm --filter @reachany/ai-runtime test -- tests/reach-deck/decksmith-replay
```

## 目录

| 路径                         | 内容                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `replay-cases.test.ts`       | 逐案例回放与案例特有断言                                                                                                            |
| `runtime-contracts.test.ts`  | 冻结历史投影摘要、单次运行 token 预算、系统提示词摘要与工具名快照                                                                   |
| `budget-gating.test.ts`      | WP4 派发前预算门控：200k 基线、149k/199k 多工具批次、每日额度等                                                                     |
| `clarification.test.ts`      | WP7 ask_teacher 停止语义：修改前提问、同批阻断、修改后拒绝（含未提交的互动工作副本）、候选校验                                      |
| `quiz-conversion.test.ts`    | WP3 方案 A：GenUI → 5 道开放题的 v3/v4 逐轮输入字节与累计估算、顺序/保留来源/部分失败重试不重复；v6 逐个调用 9 轮在 200k 门控内完成 |
| `parallel-arguments.test.ts` | 网关丢弃并行工具调用参数：丢参调用不执行、不计错、返回诊断，配对完整；单个调用与无必填参数工具不变                                  |
| `harness.ts`                 | 桩服务、执行器与通用断言                                                                                                            |
| `fixture-loader.ts`          | 夹具加载、媒体校验与选区上下文引用（不依赖 vitest，第②/③层评测脚本共用）                                                            |
| `scripted-model.ts`          | 脚本化 `streamFn`（接入真实 `agentLoop`，派发前调用 `onPayload`）                                                                   |
| `fixtures/documents/`        | 脱敏重建的基线文档（合成内容，结构忠实）                                                                                            |
| `fixtures/media/`            | 2×2 PNG 与 `manifest.json`（SHA-256、尺寸、类型）                                                                                   |
| `fixtures/cases/<id>.json`   | 单个案例                                                                                                                            |

## 案例格式（`decksmith-replay-case/v1`）

- `teacherCase` / `summary` / `provenance`：对应方案 §1.1 的案例编号与来源说明，`provenance.kind` 只能是
  `synthetic-reconstruction`。
- `document`：`fixtures/documents/` 下的文件名。加载时核对媒体字节、清单与文档资源 `digest` 三者一致。
- `request`：除文档外的冻结运行输入，即 `DecksmithRunInput`：教师原话、当前页、选区、投影历史
  `history`、摘要 `contextSummary`、`mediaStatus`、提示词合同版本 `promptContractVersion` 等。新案例写
  当前版本（`decksmith-prompt/v7`；已有 v2–v6 案例保持原版本）；缺省表示 WP2 之前入队的旧 Run（v1 提示词、v1 工具面、互动合同预加载）。
- `followsCase`（可选，多轮案例）：`{ id, proposalOutcome, answersQuestion? }`。先回放 `id` 案例（含其断言）作为上一轮，
  按 `proposalOutcome`（`approved` / `rejected` / `pending` / `superseded`）补审批事件，再经生产代码
  （`buildDecksmithResultEventPayload`、v2 冻结投影、`assembleDecksmithRecentHistory`）生成本轮
  `history`，覆盖 `request.history`。`answersQuestion: true` 时再经 `resolveDecksmithClarificationAnswer`
  得出本轮 `clarificationAnswer`（回答上一轮的 ask_teacher）。
- `capturedWith.toolParameterSha256`：脚本用到的工具在录制时的参数 schema 摘要（不含描述文案）。参数
  形状一变，回放会直接失败并给出新摘要。此时先复核脚本，再更新摘要。
- `transcript`：每个模型回合包括可选的 `text`、`toolCalls[{id,name,arguments}]` 与 `usage`。参数中
  `{"$json": 值}` 会序列化为字符串（如 `sceneJson`）；`{"$ref": "<callId>.<字段>"}` 从此前工具结果 JSON
  取服务端派生值（如插入页的 `pageId`）。脚本用完后模型仍被调用，就以错误结束。
- `services.imageEdit` / `services.imageGenerate`：按调用顺序给出 `{"image": "<media 文件>"}` 或
  `{"fail": {"message","status","retryable"}}`。
- `expect`：通用协议断言，包括 `changed`、`outcome`、`modelTurns`、每次工具调用的 `isError` 与结果片段、
  首条用户消息应含或不应含的片段，以及桩调用次数。几何保持、讲稿失效等案例特有断言写在
  `replay-cases.test.ts`。

## 覆盖范围

| 案例 | 回放                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 1、5 | 纯前端问题，回归在 `packages/reach-deck-editor/tests/QuizEditing.test.tsx`                                                  |
| 2    | 选中图片后编辑；两张图都未选中时不修改文档；瞬时失败重试一次；持续失败时不替换图片                                          |
| 3    | 同一回合插入 5 道无标答简答题；选择题不允许 `has_answer=false`；「互动题」不注入 GenUI 合同；GenUI 来源页也不预加载         |
| 4    | 改写讲稿后媒体失效；媒体锁只拦来源页。恢复路径见 `decksmith-execution-context.test.ts`，采用竞态见 Teacher 测试             |
| 6    | 类型化 `completionMode` 提交成功；事件声明错误时诊断点名、页面不提交                                                        |
| WP1  | 跨轮记忆：上一轮改图提案被拒绝后，下一轮模型输入含上一轮实际答复、结构化变更、选区描述与"rejected"结局                      |
| WP2  | GenUI 转题全程不读互动合同；互动小补丁同回合读合同与 HTML 后提交；未读合同的写调用被拒且不计错；旧 Run 保持 v1 行为         |
| WP7  | v3：未选中且两张图都符合"这张图"时 ask_teacher 给出两个候选并停止；下一轮带回答与选区直接 edit_native_image                 |
| WP3  | v4：GenUI → 5 道开放题的成本对比（同回合 / 逐题两种形状）、来源页何时删除、第 3 题失败后的保留与不重复重试                  |
| v6   | 每次回复一个工具调用：9 轮转换的累计估算与 200k 门控放行；同一回复多个空参数调用返回 `DECKSMITH_PARALLEL_ARGUMENTS_DROPPED` |

`runtime-contracts.test.ts` 记录的是**当前**行为：历史投影分两版——v1（旧 Run，无 `projection`）只有
固定套话、不含提案结局，digest 永久不变；v2（WP1 起的新 Run）含实际答复、结构化变更与入队时冻结的提案
结局，入队后到达的审批事件不改变 digest；预算在派发前判断（WP4），放不下下一次调用就以已验证修改收尾为
部分提案并给出 `remainingTasks`，共享记账函数的硬上限保持不变；工具名和系统提示词按提示词合同
版本（v1 旧 Run / v2 / v3 / v4 / v5 / v6 新 Run）分别有快照，v1–v5 永不改变。v1 → v2 规则保留清单见
`tests/reach-deck/decksmith-system-prompt.test.ts`。
改动这些行为时，在同一提交里更新断言。

## 从真实 ai_run 新增案例

`ai_run.input` 不是完整回放输入（评审 M12）。基线文档按 `baseline.contentDigest` 来自 content-service
物化结果；历史来自页面流投影；事件里的工具参数只有 SHA-256。因此案例一律**重建**，不导出原始数据。

1. 用只读权限查看测试环境的 `ai_run`、`ai_run_event`、`ai_artifact` 和 `ai_usage_ledger`，记下工具顺序、
   报错诊断、回合数与 token 形状。不要写共享库，也不要把查询结果落盘到仓库。
2. 在 `fixtures/documents/` 重建最小文档，只保留复现所需的页面类型、元素类型、几何、层级与选区关系。
3. 按观察到的工具顺序写 `transcript`。先运行一次，再把失败信息里的参数摘要填进 `capturedWith`。
4. `expect` 写协议层结论，例如是否修改、`outcome`、哪个调用报了什么诊断；不要断言措辞风格。
   模型质量属于第②层，不在这里评测。

脱敏规则：**不得提交**真实课程内容、教师原话、讲稿、模型输出原文，也不得提交真实 id、objectKey、组织、
课程或教师标识。文本一律改写为合成内容。文档 id 使用测试 scope 的 `moduleVersionId`，媒体 objectKey
统一使用 `uploads/<测试组织>/reach-deck/decksmith-replay/` 前缀，图片字节换成极小 PNG，并把
`shasum -a 256` 结果同时写入 `media/manifest.json` 和文档资源 `digest`。

## 局限

脚本化模型会把上下文转成与 pi-ai 同形的请求体并调用 `onPayload`，因此容量与预算门控在回放里真实执行；
但这里不复现网络序列化细节、model-service 路由、真实计费和护栏（第③层），也不评估真实模型是否会走出脚本
里的轨迹（第②层）。第②、③层是显式运行的脚本，复用同一份夹具，见
[`scripts/reach-deck/decksmith-eval/`](../../../scripts/reach-deck/decksmith-eval/README.md)。
