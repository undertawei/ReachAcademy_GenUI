# GenUI 接手代码地图

## 独立工作台

`apps/workbench/src/` 提供需求输入、HTML/JSON/提示词编辑、预览和项目管理。`apps/workbench/server/` 接收请求，使用原提示词调用 OpenAI 兼容模型接口，再用原校验器解析场景，返回结果或写入本地项目文件。

后端接口仅服务于本机工作台：

`server/initialization.ts` 使用 HTML 与 JavaScript AST 预检初始化握手；`server/scenes.ts` 统一校验生成、导入和保存的场景。它不执行作者脚本，也不自动注入成功信号。

| 接口                    | 输入                                                      | 输出                                       |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------ |
| `GET /api/status`       | 无                                                        | 配置是否齐全、模型和提示词版本；不返回密钥 |
| `GET /api/prompts`      | 无                                                        | 当前默认有效系统提示词与版本               |
| `POST /api/generate`    | 必填 `instruction`；可选 `title`、`scene`、`systemPrompt` | 校验通过的 `scene` 与提示词版本            |
| `POST /api/validate`    | `scene` 或 `html`，可选 `title`                           | 校验通过的 `scene`                         |
| `GET /api/demo`         | 无                                                        | 不调用模型的演示场景                       |
| `GET /api/projects`     | 无                                                        | 本地项目摘要列表                           |
| `POST /api/projects`    | `title`、`scene`；可选 `id`、`instruction`                | 已保存的项目                               |
| `GET /api/projects/:id` | 项目 UUID                                                 | 已保存的项目                               |

## 原实现的活跃复用入口

| 位置                                                                       | 职责                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `vendor/reachacademy/services/ai-runtime/lib/reach-deck/prompts/stages.ts` | 组合当前有效 `INTERACTIVE_PROMPT`；修改提示词时先检查这里 |
| `.../prompts/corpus/local-stages.ts`                                       | 基础互动教学创作语料                                      |
| `.../prompts/interactive-runtime-contract.ts`                              | 可用科学库、离线依赖和 `ReachInteractive` 桥接协议        |
| `.../prompts/decksmith-interactive.ts`                                     | 原平台 Decksmith 对话编辑提示词；随附参考                 |
| `.../model-service-schemas.ts`                                             | 原场景输出 JSON Schema                                    |
| `.../interactive-generation-validation.ts`                                 | 生成结果 HTML、脚本和协议校验                             |
| `.../geometry-generation-markers.ts`                                       | 几何与科学标记检查                                        |
| `packages/reach-deck-dsl/src/interactiveScene.ts`                          | `InteractiveScene` 数据结构与持久化解析                   |
| `packages/reach-deck-dsl/src/interactiveHtmlAudit.ts`                      | HTML 静态检查                                             |
| `packages/reach-deck-player/src/InteractiveScenePlayer.tsx`                | 原 React 沙箱播放器                                       |
| `packages/reach-deck-player/src/interactiveBridge.ts`                      | CSP、srcdoc、消息桥、状态和事件验证                       |
| `packages/reach-deck-player/src/interactiveRuntimeRegistry.ts`             | 固定版本的本地运行库选择                                  |
| `packages/reach-deck-geometry/src/server.ts`                               | 服务端几何计算与检查；使用 esbuild 生成本地 bundle        |

## 原平台上下文参考

`vendor/reachacademy/apps/teacher/src/components/reach-deck/` 保留原教师工作区、控制器和 HTML 上传组件；学生接入在相邻 `apps/student/src/components/reach-deck/`。原生成主线的 `generation-pipeline.ts`、任务 `job-runner.ts`、Decksmith `decksmith/` 和对应测试均保留在原路径。

这些原平台编排文件仅作参考，没有接入新工作台的运行入口；直接启动它们仍需要原平台权限、数据库、队列和模型服务。
