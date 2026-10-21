# 提取范围与来源

本工作台提取于 2026-10-21。原 ReachAcademy Git 提交和每个复制文件的原路径、目标路径、SHA256 记录于根目录 `SOURCE_MANIFEST.json`。复制时未读取或复制原项目 `infra/env/dev.env`、任何本地密钥或数据库数据；空 `.env` 是新创建的独立工作台配置。

## 保留内容

- GenUI 涉及的 DSL、播放器、编辑器、导入器、几何、富文本等共享包，以及它们的工作区依赖闭包，共 19 包。保留源码、测试、构建脚本、静态资源和许可证。
- 原 AI Runtime `lib/`、Reach Deck tests/scripts/reference packs 保留在 `vendor/reachacademy/`，以保留提示词、Decksmith、生成/校验/恢复逻辑及相对导入上下文。里面存在其他原平台代码，但独立工作台不启动它们。
- 原教师和学生 Reach Deck 组件、教师 Reach Deck BFF 及相关文档，作为接手时的上下文参考。
- 教师端已提交的科学运行库文件复制到新应用 `public/reach-deck-dependencies/`，保留固定文件名、哈希和许可证，不在运行时从 CDN 下载。

源码仍保留原 package 名称与文件内容。新写代码集中在 `apps/workbench/`、根构建配置及 `scripts/`；便于比较和后续同步。

## 为独立运行做的适配

原平台通过角色 BFF、AI Runtime Worker 和 model-service 执行 GenUI。本工作台以一个仅绑定回环地址的 Node HTTP 服务替换这些编排层，直接调用用户配置的 OpenAI 兼容服务，并把项目保存为本地 JSON。

生成仍使用原有效提示词、原场景输出协议、原校验逻辑和原沙箱播放器。新工作台的“修改”是提供当前场景让模型重写，尚未移植完整 Decksmith 工具执行、审批准入、模型服务计费、课程发布和 Worker 恢复系统。

## OpenMAIC / EduLab

OpenMAIC 来源记录位于原 `prompts/corpus/local-snippets.ts` 和 `local-genui-diagram.ts`。其上游路径、版本和 hash 保持原样。完整 OpenMAIC 应用子模块没有复制或初始化；它不是本工作台依赖。

对用户提供的 `wy51ai/edulab` 只做了源码对照，没有找到当前主仓库直接移植其 SymPy kernel 和模板的来源证据，因此本工作台不包含新下载的 EduLab 文件。

## 维护注意

原 `generate-interactive-runtimes.mjs` 会对原 student/teacher 路径写文件，并包含清理旧文件/临时目录的行为。不要直接执行它；本工作台复用并验证已提交的运行库。如果需要更新，应先阅读脚本并改成明确的本工作台路径和符合单文件操作约束的维护流程。

字体、包许可证和 `THIRD_PARTY_NOTICES` 随原文件保留。新工作台不改变上游代码授权；如需对外分发，请按实际分发内容保留对应声明。
