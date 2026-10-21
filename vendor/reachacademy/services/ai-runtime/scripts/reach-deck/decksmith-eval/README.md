# Decksmith 评测（WP9 第②、③层）

Decksmith 优化方案（`docs/plans/2026-10-08-decksmith-harness-optimization.md`）WP9 的三层评测里，
第①层是不调用模型的确定性回放（`tests/reach-deck/decksmith-replay/`，随 vitest 默认运行）。本目录是另外两层，
都是**显式运行**的脚本，不在默认 vitest 里：

| 层  | 入口                           | 模型路径                                | 验证什么                                                          |
| --- | ------------------------------ | --------------------------------------- | ----------------------------------------------------------------- |
| ②   | `run-decksmith-eval.ts`        | `createDirectLiteLlmFetch` 直连 LiteLLM | 真实模型的结局质量：多次采样的成功率、失败类别、延迟、token、费用 |
| ③   | `run-decksmith-integration.ts` | 本地 model-service + content-service    | 槽位路由、计费 usage、图片模态、护栏、取图授权                    |

两层都复用第①层的冻结输入（同一份脱敏文档、教师原话、选区、媒体状态），智能体本身走真实代码：
`runDecksmith`、pi-agent-core `agentLoop`、工具、`DecksmithDocumentSession`、提示词组装。外部依赖在
全局 `fetch` 这一层替换（`transport.ts`），因为生产代码对 model-service、content-service 与签名下载
地址的访问都经全局 `fetch`；未识别的出站请求一律拒绝。

## 第②层：真实模型质量评测

```bash
# 只校验夹具、输入组装、视觉输入授权链路与断言非空洞，不调用模型、不需要 dev.env
pnpm --filter @reachany/ai-runtime eval:decksmith -- --dry-run

# 真实运行（仓库根目录；直连 LiteLLM，需要 REACHANY_LITELLM_* 与服务 JWT 配置）
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- \
  pnpm --filter @reachany/ai-runtime eval:decksmith -- --samples 2 --concurrency 4
```

`eval:decksmith` 会先构建运行时依赖的 workspace 包；包已构建时可直接
`npx tsx services/ai-runtime/scripts/reach-deck/decksmith-eval/run-decksmith-eval.ts …`。
linked worktree 没有 `infra/env/dev.env` 时，用主 checkout 的同一文件。

常用参数（`--help` 列出全部）：

| 参数                                      | 默认                                                       | 说明                                                                 |
| ----------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `--cases a,b`                             | 全部                                                       | 见下表                                                               |
| `--samples` / `--concurrency`             | 3 / 2                                                      | 每案例样本数、并发样本数                                             |
| `--timeout-ms`                            | 300000                                                     | 单样本超时                                                           |
| `--model`                                 | `REACH_DECK_DECKSMITH_EVAL_MODEL` 或 `openai/gpt-5.6-luna` | LiteLLM 模型 id（Decksmith 槽位的默认绑定）                          |
| `--real-image-edit`                       | 关                                                         | 图片编辑走真实 RouterLink（与 model-service 同形的 chat + 图片输出） |
| `--prompt-contract current\|fixture`      | `current`                                                  | 用当前提示词合同（新 Run 行为），或保留夹具冻结的版本                |
| `--max-run-tokens` / `--max-total-tokens` | 400000 / 3000000                                           | 单样本 / 全局 token 上限，超出即中止                                 |
| `--no-early-stop`                         | 关                                                         | 默认案例首个样本超时或超 token 上限（疑似循环）时跳过其余样本        |
| `--rates <file>`                          | `rates.json`                                               | 费率表（每百万 token，按模型 id，`image-edit` 单列）                 |
| `--out <dir>`                             | `tmp/decksmith-eval/<时间戳>/`                             | 只能在 `tmp/` 或 `.tmp/` 下，报告不提交                              |

案例（`cases.ts`）只断言**结局**，接受等价的正确解法，不比对工具轨迹或措辞：

| 案例                           | 夹具                                        | 通过条件                                                                                                                             |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `image-edit-selected`          | `case2-selected-hero-image-edit`            | 附带选中图视觉输入；`edit_native_image` 成功，选中元素换绑新资源、几何/层级/fit 不变（alt 可更新），其余元素与页面不变，不另生成新图 |
| `image-ambiguous-ask`          | `wp7-ambiguous-picture-asks-teacher`        | 不修改、不调图片服务；`ask_teacher` 的候选同时含两张图                                                                               |
| `genui-to-five-open-quizzes`   | `case3-quiz-request-on-genui-origin`        | 5 个新测验页、每页一题、`has_answer=false` 且非选择题、题干互不相同；"改成"→ 来源 GenUI 删除，题目连续接在原位置；其余页不变         |
| `narration-rewrite-text-only`  | `case4-narration-rewrite-marks-media-stale` | `set_native_narration` 改本页讲稿：先出现"电功"再出现"用电器"；**不**声明采用后媒体生成；本页元素与别页不变                          |
| `narration-rewrite-with-audio` | 同上，原话加"改完重新生成配音"              | 同上，且 `outcome.afterApply` 为本页声明了音频生成                                                                                   |
| `genui-insert-commit`          | `case6-genui-commit-completion-mode`        | 一次运行内提交恰好一个新互动页（未提交的工作副本不进提案），紧接当前页之后，`completionMode: explicit`                               |

失败类别：`run-error`、`guardrail`、`timeout`、`token-cap`、`no-change`、`unexpected-change`、`wrong-target`、
`collateral-change`、`missing-clarification`、`quiz-count`、`quiz-contract`、`duplicate-stems`、
`source-handling`、`page-order`、`wording`、`media-intent`、`not-committed`、`runtime-policy`。
基础设施类单列，不代表模型推理质量：`provider-error`（网关/上游 5xx、连接中断，例如 ALB 60 秒空闲超时的 504）
与 `empty-tool-arguments`（工具调用到达时参数为空，`Received arguments: {}`——网关丢弃了同一回合多个工具调用的参数；
运行时防护拦下、返回 `DECKSMITH_PARALLEL_ARGUMENTS_DROPPED` 的调用不计工具错误，也计入这一类）。

报告（`report.json`、`report.md`，以及逐样本追加的 `samples.jsonl`）按案例给出成功率、失败类别、
p50/p95 延迟、平均主模型回合、每次运行 token 与估算费用；样本明细含工具序列、失败说明与最终答复。

口径说明：

- token 以出站调用解析出的 provider usage 为准（主模型 + `draft_layout_with_html` 等子调用 + 真实图片编辑），
  含缓存命中与推理 token；`billedUsage` 是 `runDecksmith` 的 usage 事件之和（job-runner 记账口径）。
  pi-ai 的 `promptTokens` 不含缓存命中部分，所以二者的输入 token 不同、总量一致。
- 费用 = (输入 − 缓存) × 输入单价 + 缓存 × 缓存单价 + 输出 × 输出单价；`rates.json` 是**估算**费率，
  不是计费口径。LiteLLM 在响应头报告费用时另列。
- 直连时每个请求都带 `cache: {no-cache, no-store}`：LiteLLM 的响应缓存不按会话隔离，同一冻结输入的
  第二个样本会直接命中缓存（0.2 秒、token 完全相同），样本就不独立了。
- 夹具图片是 2×2 PNG，低于生产归一化的 16 px 下限。评测把它们替换为 768×512 的合成示意图（`media.ts`，
  英文标签），并同步改写评测文档的资源 digest；第①层夹具不变。

图片编辑/生成默认用桩（返回合成示意图、不计 token）；生成媒体写入始终只进内存。第②层**不能**替代第③层：
它绕过了 model-service 的槽位路由、计费、模态策略与护栏。

## 第③层：经本地服务的集成验证

需要本地 model-service（`:8100`）与 content-service（`:8000`），二者连接 `infra/env/dev.env` 里的云端共享
PostgreSQL / OSS / LiteLLM。在仓库根目录各开一个终端（AGENTS.md Quick Start）：

```bash
cd java && npx dotenvx run -f ../infra/env/dev.env -- ./gradlew :model-service:bootRun
cd java && npx dotenvx run -f ../infra/env/dev.env -- ./gradlew :content-service:bootRun
```

auth-service 不需要（ai-runtime 自签服务 JWT）。然后：

```bash
# 只读部分：健康检查 + 取图授权
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- \
  pnpm --filter @reachany/ai-runtime eval:decksmith:integration

# 加上模型检查（会写共享库：model-service 的用量事件与护栏审计）
npx -y @dotenvx/dotenvx run -f infra/env/dev.env -- \
  pnpm --filter @reachany/ai-runtime eval:decksmith:integration -- --allow-shared-writes \
  [--expect-model openai/gpt-5.6-luna] [--reference-scope tmp/ref.json] [--guardrail-probe tmp/probe.txt]
```

服务地址只允许指向本机。两个服务都没起时打印上面的启动命令并以"跳过"结束（退出码 0）；只起了一个时，
依赖另一个的检查记为 `skip`。

| 检查                                       | 需要                                 | 通过条件                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorization.synthetic-reference-denied` | content-service                      | 合成夹具的 objectKey 不签发下载地址，且以 4xx 拒绝（合成作用域在本分支为 422 `MODULE_REFERENCE_INVALID`，作用域有效但 key 不在文档里为 404）。5xx 算失败（执行期会被归为暂不可用）；404 `Endpoint not found` 也算失败，说明端口上是不含该接口的旧进程 |
| `authorization.real-reference`             | content-service、`--reference-scope` | 一张真实课程图片能授权、下载、通过校验和并归一（只读）。文件为 `{actorId, roleGrantId, billingGroupId?, resourceScope, objectKey}`                                                                                                                    |
| `routing-and-billing`                      | 两个服务、`--allow-shared-writes`    | 讲稿改写经 model-service 完成；每次调用 200、调用合同为 `teacher.deck/courseware.deck/decksmith/chat/chat`、有上游模型（可用 `--expect-model` 核对）与 usage；usage 事件总量 = provider usage 总量                                                    |
| `modality.image-input`                     | 同上                                 | 选中图案例的首个主模型请求带图片块且被槽位接受（取图用夹具桩，授权单独验证）                                                                                                                                                                          |
| `guardrail.no-false-positive`              | 同上                                 | 上述正常教师请求没有被护栏拦截                                                                                                                                                                                                                        |
| `guardrail.blocked-probe`                  | 同上、`--guardrail-probe`            | 探针原话（由运维按护栏策略提供，不入库）以 `GUARDRAIL_BLOCKED` 失败且没有提案                                                                                                                                                                         |

`--real-image-edit` 让 `edit_native_image` 经 model-service 的 `courseware.deck.decksmith.image-edit` 槽位
真实编辑（计费）；默认用桩。生成媒体写入（`POST generated-media`）始终用内存桩，不写共享库。报告写到
`tmp/decksmith-eval/integration-<时间戳>/`。

## 新增案例

先按 `tests/reach-deck/decksmith-replay/README.md` 写第①层夹具（脱敏规则相同），再在 `cases.ts` 里加一条
`DecksmithEvalCase`：指向夹具、必要时覆盖原话，`check` 只看结果文档、`outcome`、成功的工具名与桩调用次数。
运行 `--dry-run` 确认夹具可加载、且断言会拒绝"什么都没做"的结果。
