# @reachany/brand

ReachAcademy 四个前端（Portal、Student、Teacher、Admin）唯一的视觉 token 来源。取值与用途见
[docs/wiki/frontend/01-visual-foundations.md](../../docs/wiki/frontend/01-visual-foundations.md)
（第二期视觉，issue #691）；修改 token 时先改规范，再同步这里。

## 导出

| 导出                             | 用途                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `brandTokens`                    | TS 形式的全部 token（颜色、模块渐变、字体、字号、间距、圆角、阴影、层级、动效、反馈尺寸、布局尺寸） |
| `brandCssVariables`              | `--reachany-*` 变量名 → 值的映射，与 `styles/variables.css` 首个 `:root` 块同键同值（契约测试保证） |
| `styles/variables.css`           | CSS 变量定义；另含 1280–1439 响应式覆盖、`[data-density='compact']` 覆盖、减少动效时长归零          |
| `styles/theme.css`               | Tailwind v4 `@theme inline` 语义工具类映射（`bg-primary`、`text-fg-secondary`、`rounded-card` 等）  |
| `brandConfig`、`brandAssetPaths` | 品牌名称与标志资源路径                                                                              |

## 接入方式

- 变量由 `@reachany/ui/styles.css` 引入（其第一行 `@import '@reachany/brand/styles/variables.css'`），各 app 不需要、也**不要**
  再在 `<body>` 上以内联样式注入 `brandCssVariables`——内联值会压住响应式、密度和减少动效的覆盖。
- 各 app 的 `globals.css` 在 `@import 'tailwindcss';` 之后引入 `@reachany/brand/styles/theme.css`。命名规则见规范 06 §2.3：
  文字色 `text-fg*`、描边 `border-line*`，圆角 `rounded-control/card/panel/hero/pill`（不覆盖 Tailwind 默认的 `rounded-md/lg/xl`）。
- 根节点 `<html data-density="compact|comfortable">`：Teacher、Admin 为 `compact`，Student、Portal 为 `comfortable`。
  颜色四端相同，密度只影响共享组件的默认尺寸（规范 06 §2.2）。

## 第一期兼容别名

`action`、`action-hover`、`muted-text`、`muted-accent`、`surface-subtle`、`header-avatar`、`brick`、`brick-soft`、
`neutral-1`、`neutral-2` 仍然存在，但已映射到第二期取值（例如 `action` = `primary`，`muted-text` = `text-secondary`），
只为让尚未迁移的页面不出现第一期配色。新代码不得使用；页面迁移完成后删除（迁移计划 P3）。

## 字体

字体栈只声明角色（`sans`、`serif`、`brand`、`numeric`）。字体文件与 Reach Deck 播放器共用
`packages/reach-deck-player/fonts/`，目前只有 Montserrat 400 与思源宋体 400；Montserrat 300/800 与思源宋体 700
的自托管见迁移计划 P0-6，未补齐前浏览器会合成字重。禁止引入 Google Fonts 等外部字体 CDN。
