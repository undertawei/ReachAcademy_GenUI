# ReachAcademy GenUI 本地工作台

从 ReachAcademy 提取的独立 GenUI 开发工作台。输入教学需求，生成可操作的 HTML/CSS/JavaScript 页面；查看和编辑提示词、修改 HTML、校验、预览、导入导出，并在本地保存项目。

工作台直接使用原项目的 **Interactive 提示词、InteractiveScene 数据协议、生成结果校验器、沙箱播放器与科学运行库**。已保留相关源码、测试、字体和第三方来源说明。运行时仅启动本地工作台服务，不需要原平台的 Java、登录服务、PostgreSQL、Redis、OSS 或 Docker。

## 启动

推荐 Node.js **24**、pnpm **9.15.0**。在 PowerShell 中执行：

```powershell
Set-Location -LiteralPath 'C:\Learning Data\3_shixi\17_genui\ReachAcademy_GenUI'
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:5310>。按 `Ctrl+C` 停止。

如果当前 Node 不是 24，可以使用附带的脚本；它通过 npm 调用指定的 Node/pnpm，不修改系统默认版本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Workbench.ps1
```

首次下载依赖需要网络。后续演示、HTML 编辑、导入与预览不需要模型配置。点击“载入演示”即可检查完整互动播放器。

## 填写模型配置

根目录已经生成 `.env`，所有值均为空；`.env.example` 是同样的配置模板。请使用编辑器填写自己的配置，不要把密钥放进浏览器代码或提交到 Git。

| 变量                 | 必填       | 说明                                                                      |
| -------------------- | ---------- | ------------------------------------------------------------------------- |
| `GENUI_API_BASE_URL` | 生成时必填 | OpenAI 兼容 API 根地址，通常以 `/v1` 结尾；服务调用其 `/chat/completions` |
| `GENUI_API_KEY`      | 生成时必填 | API 密钥，只在服务端使用                                                  |
| `GENUI_MODEL`        | 生成时必填 | 服务商实际支持的模型标识                                                  |
| `GENUI_MAX_TOKENS`   | 否         | 输出上限，默认 16000；模型须支持该上限                                    |
| `GENUI_TIMEOUT_MS`   | 否         | 单次模型请求超时，默认 180000 毫秒                                        |
| `GENUI_PORT`         | 否         | 本地端口，默认 5310                                                       |

填写后重启 `pnpm dev`。缺少配置时，生成接口会返回可读提示；其他本地功能仍可使用。模型请求会把教学需求、有效提示词和可选的当前页面发送给你配置的提供商。

## 使用流程

1. 载入演示，检查预览区的操作和事件反馈。
2. 在需求框描述教学主题、目标和希望学生进行的操作，点击生成。
3. 在 HTML 页签修改源码，校验并应用后再预览。生成结果和导入内容均先经过原项目协议校验。
4. 保留当前页面并提交修改需求，可以让模型重写当前互动页。
5. 在提示词页签查看、编辑本次请求的系统提示词，或恢复原项目默认值。
6. 保存项目后可从本地列表重新载入；也可以导出场景 JSON 或单文件 HTML。

输出的场景是 `reach-interactive-scene/v2`：`documentHtml` 保存页面源码，`runtimeDependencies` 声明内置运行库，`eventManifest` 描述学习事件，`narration` 保存讲稿文本。工作台不调用 TTS 生成讲稿音频。

## 代码结构

```text
apps/workbench/
  src/                       新工作台界面
  server/                    模型适配、校验、项目存储和本地 HTTP 服务
  shared/                    工作台前后端类型
  public/reach-deck-dependencies/ 原科学运行库 JS 与许可证
packages/                    19 个相关共享包及依赖闭包，保留原源码与测试
vendor/reachacademy/          原 AI Runtime、教师/学生接入源码与文档参考
data/                        运行时本地项目文件（不提交）
SOURCE_MANIFEST.json          原提交、源路径、提取路径及逐文件 SHA256
```

详细入口和职责见 [代码地图](docs/CODE_MAP.md)，提取范围和边界见 [提取说明](docs/EXTRACTION.md)。

## 验证与构建

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm verify:sources
pnpm start
```

`pnpm build` 构建 Geometry 校验服务 bundle 和前端；`pnpm start` 提供构建后的前端。`pnpm dev` 会先构建 Geometry bundle，再启动 Vite 开发服务。

`pnpm test` 仅执行独立工作台的测试；`vendor/` 和共享包保留的主站测试没有自动加入独立工作台测试范围。不要直接运行原项目的数据库/队列验收脚本。`verify:sources` 只读比较提取源码，开始修改这些源码后出现差异属于正常现象。

## 错误与范围

- 工作台绑定 `127.0.0.1`，适合本机开发；没有原平台的用户、组织、权限或计费功能。
- 互动页在 `sandbox="allow-scripts"` 的 iframe 中运行。页面不能请求外网、加载 CDN、访问父窗口会话；科学库由本机提供。
- HTML/JSON 格式、脚本语法、依赖声明或交互协议不符合要求时会被拒绝。导入的 HTML 需要监听 `reach-interactive-initialize`，并在初始化成功后调用 `ReachInteractive.ready(...)`；普通 HTML 需先适配该握手。静态预检不能保证脚本运行成功，运行错误仍由原播放器报告。具体规则见原 [HTML 编写规范](vendor/reachacademy/docs/reach-deck/interactive-html-authoring.md)。
- 模型调用失败、超时或校验失败会显示错误，不会将失败输出覆盖到当前成功页面。取消请求不保证服务商停止计费。
- 自动校正最多一次，并保留原项目的受保护内容约束：语法正常的脚本不能在校正时被重写。因此首轮脚本遗漏初始化握手等情况可能仍被拒绝；此时可以重新生成，或在 HTML 页签手动修改后校验。
- 工作台的修改接口使用当前页面上下文重写，不是原平台完整 Decksmith 工具调度器。Decksmith 原源码已随附用于后续开发。
- `genui-diagram-*` 科学 JPG/GIF 配图生成源码已保留作为参考，本工作台仅启用完整 HTML 互动页；不提供 PPT、测验、课程发布、TTS 或视频生成。
- OpenMAIC 适配来源保留在原提示词和说明中。没有为本工作台安装 EduLab，也没有声称移植其 SymPy 内核。

本次实际验证结果见 [验证记录](docs/VERIFICATION.md)。
