# ReachAcademy AI Runtime

可以把 AI Runtime 理解为 ReachAcademy 里所有 AI 功能共用的“运行控制中心”。Student、
Teacher Reach Deck 等产品把 AI 任务交给它，它负责确认谁在使用、允许做什么、调用了哪些工具和模型、
消耗了多少、是否需要人工确认，以及结果是否已经真正应用到业务系统。

它不是一个单独的聊天页面，也不取代课程、课件、作业、成绩等业务服务。权威数据仍由领域服务
持有，模型调用统一经过 `model-service`；Runtime 专注于把 Agent 执行、安全、预算、事件、
审计和审批做成一套可复用的工程底座。

工程上，一次 AI 行为被统一建模为 `Scene -> Run -> Event -> Artifact -> Approval`。
不同产品可以复用这套协议，同时保留自己的 UI 和领域所有权。

## 当前场景

| Scene                           | 入口                     | 执行形态         | 写入策略                                                                                                   |
| ------------------------------- | ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `student.tutor`                 | Student module Tutor     | Agent            | 默认只读；匹配学习围栏的 Run 才注册受审计、无模型身份参数的 mastery 工具                                   |
| `teacher.deck`                  | Teacher Reach Deck BFF   | Native workflow  | Runtime 原生执行生成与 Decksmith，变更生成 Artifact/Approval，业务结果仍归 Content                         |
| `teacher.lesson-prep`           | Teacher lesson-prep BFF  | Domain workflow  | 课程 scoped 编排 run；使用独立 queue，结果保持 staged，课程写入仍归 Content                                |
| `student.quiz.feedforward`      | 测验逐题批阅             | Runtime workflow | 作答批阅（共享实现，版本 2）：每个 Run 只批一道叶子题，沿用原 capability、槽位与通道，开放每题一张反馈图片 |
| `student.srl.feedforward`       | SRL report submission    | Runtime workflow | 独立 queue/channel；保持独立 prompt、bundle、Scene 与审计身份                                              |
| `student.spaced-review.grading` | Spaced review submission | Runtime workflow | 作答批阅（共享实现）：content-service `assessment/grading` 持有批阅记录，领域服务持有复习计划与结果        |
| `student.reach-deck.grading`    | Deck 课中习题提交        | Runtime workflow | 作答批阅（共享实现）：独立 capability、模型槽位与通道，结果回写 Deck 运行时与 `quiz_result`                |
| `course.video.processing`       | Video finalize           | Runtime workflow | Runtime 执行媒体探测与字幕处理，Content Service 持有视频权威状态                                           |

独立的 `/student/tutor` 页面已移除。学生 Tutor 只接受带有效 attempt、selection、module
version 标识的课内会话；提交 Run 必须携带学习上下文。旧的无上下文会话与 Run 不再通过
学生接口访问，历史数据保留。Deck、视频、学习围栏和教师试学仍使用共享 Tutor 能力。

发布顺序：先上线兼容的 API 与学生前端，移除独立入口并阻止新的无上下文 Run 入队，再更新
Tutor Worker。已有无上下文 Run 在新 Worker 上按 409 上下文错误直接失败，不重试模型请求；
部署前应确认这些历史任务的处置，不会自动补造学习上下文。无须变更 schema 或删除历史记录。

Decksmith 仍是课件编辑引擎，但其队列、执行与 Runtime 生命周期现在位于同一 AI Runtime
服务边界，并在独立的 `teacher.deck` Worker 内原生闭环，不再通过 HTTP adapter 回调
Runtime。Runtime Store 不保存整份课件；Artifact 只记录摘要、变更页 ID 与领域引用，完整文档
仍由 Content Service 持有。

## 运行链路

```text
Role applications
  ├─ student.tutor ── actor JWT ──> AI Runtime ── delegate JWT ──> model-service
  │                                      └─ actor JWT ──> content/student services
  └─ Teacher /api/reach-deck/* ────────> native teacher.deck queue + worker
                                         └─ Run/Event → Artifact → Approval → applied
```

统一事件包括：

- `run.queued / run.started / run.retry_scheduled / run.completed / run.failed`
- `tool.started / tool.completed`
- `usage.updated`
- `message.delta / message.completed`
- `artifact.proposed / artifact.validated / approval.required`
- `approval.decided / artifact.applied`

SSE 支持 `Last-Event-ID`，事件来自持久化 Run Event Store，可重放且不暴露模型思维链。

Tutor 会话使用最小 Thread API：

- `POST /api/threads`：创建绑定 Scene、actor、organization 与 domain scope 的 Thread；
- `GET /api/threads?sceneKey=student.tutor`：列出当前 actor 的会话；
- `GET /api/threads/{threadId}`：返回 Thread 和可安全重放的 Run 消息历史；
- `POST /api/runs` 可携带 `threadId`，Runtime 会拒绝跨 actor、跨组织、跨 Scene 或 scope 漂移。

`student.tutor` 的 `POST /api/threads` 按 actor、billing group 与规范化 domain scope 原子
get-or-create。同 scope 的历史物理重复 Thread 会被投影为一个逻辑会话；缺少 `tutorDomain` 的旧普通
Thread 只作为 canonical `ordinary` Thread 的过滤后历史来源，新 Run 不再写回旧 Thread。

Reach Deck 学习围栏复用 `student.tutor` 队列，但使用独立的
`reach-deck-learning-fence-context/v1` 上下文和独立 Thread domain。围栏 scope 固定携带
`tutorDomain=learning_fence`、`fenceId`、`pageId`、`questionId` 与 `sceneId`，普通 scope 固定携带
`tutorDomain=ordinary`。Runtime 拒绝缺失判别字段、普通上下文写入围栏 Thread，以及围栏上下文写入
普通 Thread。历史投影按上下文 domain 再过滤一次，因此 discriminator 修复前误写进同一 Thread 的
旧 Run 不会继续混入普通对话。新 Student Run 持久化前会通过 student-service 读取 active fence：有
active fence 时拒绝 ordinary Run，围栏失效后拒绝新的 fence Run；已存在的幂等 Run 仍返回原结果。
Worker 执行前重复这项检查以覆盖排队竞态，并重新读取不可变题目与教师判定提示词，叠加不可覆盖的
固定掌握度策略。普通 Tutor Run 不注册 `learning_fence.mark_mastered`；围栏 Run 的工具也不接收
fence/run/actor 等模型参数，所有身份从 Run 与短期服务 JWT 推导，Content Service 再校验
`scene_id`、`run_id` 与 active fence 后 CAS 写入。

Teacher Trial 的 `learning_fence.trial_released` 是可重放的 durable event。浏览器在 SSE 断线后从
Thread history 恢复到该事件时同样解除活动围栏，不依赖首次 live delivery。

普通、attempt-scoped Tutor Run 可调用无参数的 `learning_fence.read_history`。它只枚举当前 Run actor
可见、且 organization/course/module/selection/attempt scope 一致的围栏 Thread，最多返回最近 40 轮
已完成对话；模型不能传入学生、attempt 或 fence 身份扩大读取范围。存储层通过一次有界查询完成
筛选，并接收工具超时的取消信号。围栏 Run 本身不注册该工具。Teacher Trial 围栏 Run 使用
`learning_fence.release_trial`；成功时持久化幂等的 `learning_fence.trial_released` 事件，只有该事件
而非通用 `run.completed` 会通知教师端 Tutor 放行，且不会写入 Student mastery。

管理员可通过 `GET /api/diagnostics` 查询组织范围的基础诊断。Admin 运营看板使用独立的
`POST /api/admin/dashboard`：只接受 `aud=ai-runtime`、`sub=admin-service`、
`token_type=service` 的短时令牌，并要求 admin-service 提供与用户筛选分离的可信授权 scope。
该接口提供最长 31 天、每页最多 100 行的 Run 汇总、趋势、Scene/状态分布、usage-ledger
capability 用量、分页安全明细和队列 readiness，不返回提示词、私有输入、JWT 或模型思维链。
审批明细按新到旧最多返回 50 条，并显式返回匹配总数与截断标记。
Run capability 筛选使用 Scene 声明能力；用量 breakdown 使用 `ai_usage_ledger.capability`，响应中
明确两个不同分母。Runtime 只返回规范业务 ID；当前显示名与 Admin 数据范围由 admin-service 负责。

## 接口入口

| 能力                     | 接口                                                     | 说明                                                               |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------ |
| Thread                   | `POST /api/threads`、`GET /api/threads/{threadId}`       | 创建和恢复同一学习上下文中的多轮会话                               |
| Run                      | `POST /api/runs`、`GET /api/runs/{runId}`                | 创建和读取一次 AI 执行                                             |
| 流式事件                 | `GET /api/runs/{runId}/events`                           | SSE 输出消息、工具、用量和状态事件，支持断线重放                   |
| 取消                     | `POST /api/runs/{runId}/cancel`                          | 取消仍可终止的 Run                                                 |
| 审批                     | `POST /api/approvals/{approvalId}/decide`                | 批准或拒绝高影响 Artifact                                          |
| 应用回执                 | `POST /api/approvals/{approvalId}/applied`               | 领域服务实际保存成功后回写 applied                                 |
| Reach Deck               | `/api/reach-deck/*`                                      | 教师课件生成、Decksmith、工具、导入与可恢复事件流                  |
| Assessment grading       | `POST /api/integrations/assessment-grading/runs`         | content-service 按批阅记录与调度轮次幂等创建单题批阅 Run（含测验） |
| Group review integration | `POST /api/integrations/group-collaboration-review/runs` | Content Service 按 submission generation 幂等创建小组合作批阅 Run  |
| 诊断                     | `GET /api/diagnostics`                                   | 管理员查看运行、审批、用量、Scene 与队列摘要                       |
| Admin 看板查询           | `POST /api/admin/dashboard`                              | admin-service 专用的有界授权筛选、汇总与分页查询                   |
| 探针                     | `GET /api/health`、`GET /api/ready`                      | 进程存活与 PostgreSQL/Redis 等 API 依赖状态；Worker 离线作为警告   |

Runtime Worker 镜像按工作负载分为 Tutor、Feedforward、Video Processing 与 Courseware 四个部署。
Feedforward 同一进程消费四个学生 Scene 和内部 `teacher.quiz.word-import` Scene，合计六个执行
channel（Word 的 fast/smart 各一个）；各 channel 保持独立 queue name、Redis slot、并发、
心跳和 readiness，但共享 Pod 资源。学生反馈 Scene 保持独立审计身份和 FIFO 调度；不使用跨 queue 的 BullMQ priority。
Feedforward 等待或执行时不会占用 Tutor 的 worker slot；崩溃后由 BullMQ 重投的 Feedforward Run
可以窄范围重领既有 `running` Run，并保留 Content Service checkpoint 的幂等恢复语义。
SRL 使用与 Quiz 相同的有界 `read_attachment` ingestion 读取锁定报告附件，但保留独立 prompt、
bundle 与回调。Worker 结构化日志和 model-service 用量 metadata 都携带 `sceneKey/scene_id`
与 `runId`，因此独立队列不会改变反馈的检索和审计区分。
SSE 通过 Redis Run 通知唤醒，PostgreSQL 只负责 durable 事件回放与 20 秒安全补偿，不再按连接
每 200ms 查询数据库。

跨工具工程规则以仓库根目录的 [`AGENTS.md`](../../AGENTS.md) 为唯一来源；Runtime 的接口、
身份、幂等、状态码和事件契约由本 README、路由 schema 与对应测试共同约束。

## 轮询与进程瓶颈诊断

现有私有 `9466 /metrics` 在监听期间每 5 秒采样进程 CPU、内存、事件循环延迟与利用率。
`reach_process_cpu_seconds_total{mode}` 的 rate 是消耗的 CPU 核数；
`reach_process_event_loop_delay_seconds{statistic="p99"|"max"}` 是最近一个采样窗口的延迟，
`reach_process_event_loop_utilization_ratio` 表示事件循环忙碌比例。
`reach_process_sample_timestamp_seconds` 过旧表示采样停滞，不能把旧值当作健康证据。
这些指标只在部署后提供新证据，无法补回历史事故。瞬时 gauge 可能漏掉抓取间隔内的峰值；
累计直方图 `reach_process_event_loop_window_max_seconds` 保留各采样窗口的最大延迟分布。

Workspace GET 的 `reach_workspace_read_inflight`、`reach_workspace_read_phase_seconds{phase}`
与 `reach_workspace_read_cache_decoded_bytes_total` 分别记录处理中的请求、固定阶段耗时与解码量。
阶段包含嵌套调用，不能直接相加；在途数不包含进入处理器前的 socket/Next 调度等待。
超过 1 秒的请求产生 `workspace_read_slow` 日志，每进程最多每 30 秒一条，包含阶段次数、耗时、
解码字节和请求期间的**进程级** CPU 消耗，不包含课件内容。结合容器 CPU throttling 与探针事件：
事件循环延迟和 CPU 同升时排查同步计算/解码；CPU 不高而读取阶段慢时排查下游；限流同期上升时
再评估资源配额。必要时在可控复现环境采集 CPU profile，不能仅凭总耗时确定热点。

空闲 Workspace GET 在请求内复用一次已授权的原始快照，避免四次读取和重复 recovery 校验。
导入恢复尝试写入后即失效重读；lease/CAS 路径保持实时检查，不跨请求共享可变解析对象。

整文档保存冲突记录 `reach_deck_save_conflict`，包含资源 ID、trace 上下文、请求 digest/revision
与写入前观察值。观察值早于保存，不能冒充拒绝瞬间的权威版本；日志不记录文档或 prompt。

## 本地运行

API 与 Worker 分开运行：

```powershell
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- corepack pnpm ai-runtime:dev
$env:AI_RUNTIME_WORKER_SCENES = "student.tutor"
corepack pnpm exec dotenvx run -f infra/env/dev.env -- corepack pnpm ai-runtime:worker
$env:AI_RUNTIME_WORKER_SCENES = "student.quiz.feedforward,student.srl.feedforward,student.group-collaboration.review,student.spaced-review.grading,student.reach-deck.grading,teacher.quiz.word-import"
corepack pnpm exec dotenvx run -f infra/env/dev.env -- corepack pnpm ai-runtime:worker
$env:AI_RUNTIME_WORKER_SCENES = "course.video.processing"
corepack pnpm exec dotenvx run -f infra/env/dev.env -- corepack pnpm ai-runtime:worker
$env:AI_RUNTIME_WORKER_SCENES = "teacher.deck,teacher.lesson-prep"
corepack pnpm exec dotenvx run -f infra/env/dev.env -- corepack pnpm ai-runtime:worker
```

四个 Worker 需要在不同终端中运行。`AI_RUNTIME_WORKER_SCENES` 缺失或为空时 Worker 拒绝启动，
避免误配实例同时消费多个 Scene。
Feedforward 进程不要设置 `AI_RUNTIME_WORD_IMPORT_MODE`，以同时消费 fast/smart 两条 Word 队列。
Word 默认并发分别为 2 和 1；可通过该 Worker 的环境变量
`AI_RUNTIME_WORD_IMPORT_FAST_CONCURRENCY`、`AI_RUNTIME_WORD_IMPORT_SMART_CONCURRENCY` 独立调整。
云效 AppStack 通过共享 `ai-runtime-secret` 注入这两个变量；变量组参考值为 2 和 1。
调整 Secret 后需要滚动重启 Feedforward worker，已有 Pod 的环境变量不会自动刷新。

生产形态需要：

- `REACHANY_DATABASE_URL`，或共享的 `POSTGRES_HOST/PORT/DB/USER/PASSWORD`
- `REACHANY_REDIS_URL`，或共享的 `REDIS_HOST/PORT/USERNAME/PASSWORD`
- `REACHANY_SERVICE_JWT_*`
- `REACHANY_MODEL_BASE_URL`
- `REACHANY_CONTENT_BASE_URL`
- `REACHANY_STUDENT_BASE_URL`

Model-service calls have code-owned outer deadlines and therefore require no deployment variables
for the standard budget: non-streaming calls default to 630 seconds and streaming calls to 690
seconds. Operators can override them with `REACHANY_MODEL_NON_STREAM_CALL_TIMEOUT_MS` and
`REACHANY_MODEL_STREAM_CALL_TIMEOUT_MS`; invalid or non-positive values fail fast.

AI Runtime 的表结构随共享库统一治理：经用户审核的 DDL 用 psql 执行，归档于
`java/docs/db/schema/90-ai-runtime.sql`（规则见 `java/docs/db/README.md`）。迁移框架已从仓库移除。

## 部署形态

Runtime 保持一个代码包、一个 API 与四个 Worker 工作负载，各工作负载内按 channel 注册消费者：

- `ai-runtime-api`：鉴权、Run/Approval API、SSE 与健康检查；
- `ai-runtime-worker-tutor`：只消费 `student.tutor`。
- `ai-runtime-worker-feedforward`：在同一 Pod/进程内消费四个学生反馈 Scene 和内部 Word 导入 Scene；Word 的 fast/smart 使用两条独立 queue，共六个 channel，各有自己的 Redis slot、Worker heartbeat 和并发配置，不额外部署 Word worker。
- `ai-runtime-worker-video-processing`：只消费 `course.video.processing`。
- `ai-runtime-worker-deck`：同一进程内分别注册原生 `teacher.deck` 与
  `teacher.lesson-prep` Worker，并消费独立 speech-preview channel；三条队列拥有各自的并发和恢复边界。

对应镜像与 AppStack 清单位于 `Dockerfile.api`、`Dockerfile.worker` 和
`infra/appstack/services/ai-runtime/`。API readiness 只确认 PostgreSQL、Redis 和队列等 AI Runtime
自身依赖；required Scene 没有已注册 Worker 时响应仍为成功，但会通过 `dependencies.worker: warning` 和
`warnings[].channels` 明确报告离线 channel。Worker 可消费性由各自独立的 exec readiness 探针判定。

Worker 的 exec probe 只检查当前进程的 loopback readiness，不再通过其他 Pod 的共享 heartbeat
判定本 Pod 就绪。`AI_RUNTIME_WORKER_HEALTH_PORT` 在 Kubernetes 中为 9465；本机默认不启用 listener，
并行启动多个 Worker 时如需探针必须分配不同端口。SIGTERM/SIGINT 使用一个不可延长的排空预算，
先停止新领取，再等待已获取或已在途的工作并保持续锁，最后关闭资源；超时非零退出。
默认预算 `AI_RUNTIME_WORKER_DRAIN_TIMEOUT_MS=600000`，声明的
`AI_RUNTIME_WORKER_TERMINATION_GRACE_SECONDS=630` 必须与 Pod grace 一致并保留至少 30 秒余量。
这不是最长任务时间保证：视频转码、ASR、模型等可能超过预算。

`queue-metrics.mjs` 是同 Worker 镜像中的独立只读 observer。它使用共享 channel/capacity contract、
专用 Redis 只读凭据和 scrape token，在私网 9464 提供指标，不运行消费者或修改业务 API。
四组 KEDA 只允许按队列信号扩容，自动缩容在未完成长任务/provider 安全验证前硬性禁用。
完整[部署与验收说明](../../infra/appstack/autoscaling/workers/README.md)和
[逐队列恢复边界](../../docs/plans/2026-09-27-issue-667-queue-safety.md)是启用前必读。

API 与 Worker 的运行阶段共用
`reach-common/ai-runtime-api-worker-base:node24-bookworm-reach-fonts-metafile-2026-09-11`，预装 Node 24、
pnpm、ffmpeg、WMF/EMF 转换工具（`libwmf-bin`、`emf2svg`）及其 URW 替身字体
（`fonts-urw-base35`），以及 `packages/reach-deck-player/fonts/sources/` 的 15 个 TTF/OTF 字体。
API 之所以也用它：PPTX 导入是同步应答，元文件转换发生在请求路径上而不是 worker 里。Office/PPTX
转换默认从 `/usr/share/fonts/reachany/reach-fonts-2026-08-04` 扫描，不使用 WOFF2。基础镜像
只在运行时、字体或这些系统包变化时通过
`infra/appstack/services/build-ai-runtime-api-worker-base-acr.sh` 推送；两个业务镜像复用该层，
不再访问 GitHub Raw，也不会重复上传源字体。完整构建顺序见 AppStack AI Runtime README。

## Native Decksmith 契约

Teacher BFF 通过 `/api/reach-deck/workspace/decksmith` 创建持久任务。API 在入队前用 Reach jobId
幂等创建 `teacher.deck` Run；专用 worker 直接把文本、工具、用量、结果及错误写入 Runtime Store，
不调用 `/api/integrations/decksmith/*`。变更结果会幂等创建 Artifact/Approval，再把引用补入领域结果。
教师批准并成功保存后，产品调用既有 Approval applied 回执。Runtime PostgreSQL 只保存 scope、
哈希和摘要，完整任务 payload 留在 BullMQ，完整课件由 Content Service 持有。

本地契约测试不需要数据库、Redis 或模型服务：

```powershell
corepack pnpm --filter @reachany/ai-runtime test
```

其中 `tests/teacher-deck-runtime.test.ts` 覆盖 Run、Artifact、Approval 与恢复生命周期；
`tests/reach-deck/` 覆盖 Reach Deck 生成、事件、恢复与授权边界。

真实 Deck 生成仍需要 PostgreSQL、MongoDB、Redis、content-service、model-service 和
`teacher.deck` Worker 全部可用。任一依赖不可达时不得降级为浏览器固定模板后宣称真实联通。

## 工程验证

提交 Runtime 改动前至少执行：

```powershell
corepack pnpm --filter @reachany/ai-runtime test
corepack pnpm --filter @reachany/ai-runtime lint
corepack pnpm --filter @reachany/ai-runtime build
```

## 安全边界

- 浏览器只连接 Student/Teacher 角色前端的同源代理，不能自带 actor/org/role。
- Runtime 从签名 JWT 获取 actor，并按 actor + org 校验 Run 与 Approval 所有权。
- Tutor 的考试状态由领域工具读取，调用方不能伪造。
- 学生数据投影在工具层递归移除答案、解法、rubric 与教师私密备注。
- 工具调用有白名单、超时、输出上限和 fail-closed 审计。
- Scene 保留单 Run token 上限并持续记录用户用量；默认不设置用户每日 token 上限。
- Scene 显式声明 capability、Context Provider、Artifact 类型和 Approval Policy。
- 流式 usage 优先使用 provider 的最终 usage；缺失时明确标记为 estimated。

## 后续阶段

当前阶段建立了共享底座与 Tutor/Deck 两条端到端纵切。下一阶段应在同一原语上扩展：

1. Thread 会话列表 UI、checkpoint、上下文压缩与跨设备恢复；
2. `grade-proposal` 和 `learning-track-change` Artifact；
3. 领域 dry-run/rebase 协议及 apply failure 回写；
4. 金标评测集、内容安全升级和人工转介策略；
5. Scene 配置管理与运营侧用量/失败率看板。
