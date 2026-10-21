# Brand Assets

无垠学堂 / Reach Academy 的方形标志（无字母），三种配色，均为紧贴标志的 `580 × 580` 视口：

| 文件                  | 颜色      | 用途                        |
| --------------------- | --------- | --------------------------- |
| `logo-mark-red.svg`   | `#ed0501` | 浅色背景                    |
| `logo-mark-black.svg` | `#000000` | 浅色背景的单色场景          |
| `logo-mark-white.svg` | `#ffffff` | 深色背景（如 Header、页脚） |

`favicon.svg` 是专为浏览器标签页绘制的网站图标，四个前端的 `app/icon.svg` 与它保持一致：
Header 深蓝（`#1e2740`）圆角底上居中放白色标志，四周各留 6/32 的空白，圆形或圆角裁切后标志依然完整，
浅色和深色标签栏上都能看清。标志按 32 网格对齐重绘（笔画厚 2），16px 显示时笔画恰为
1 像素、不发虚；比例与原标志一致，但不是直接缩放。

Portal 的 PWA 安装图标（`apps/portal/public/pwa/`）用同样的深蓝底和白色标志，但大尺寸下直接用原标志路径：
`icon-source.svg` 为带透明边距的圆角方块（`any`），`icon-maskable-source.svg` 满版铺底、标志落在
中心 80% 安全区内（`maskable`）。改动源 SVG 后重新导出同名 192/512 PNG。

`logo-mark-loader.svg` 是品牌红的加载动画（笔画转三圈后停回标志，内嵌 CSS，
减少动效时静止），供非 React 场景使用；React 页面用 `@reachany/ui` 的 `BrandLoader`。

标志内部为 455 × 455 的正方形：左上角笔画较设计源文件整体上移 80.54，随后整体垂直居中。
页面内联使用 `@reachany/ui` 的 `BrandMark`（`fill="currentColor"`），路径与本目录文件一致；
修改标志时同步两处、`favicon.svg` 与四个前端的 `app/icon.svg`、Portal 的 `public/pwa/` 安装图标，
以及加载动画的笔画几何（`BrandLoader` 与 `logo-mark-loader.svg`；
`packages/ui/tests/brand-loader.test.tsx` 会校验动画静止帧与标志一致、两处关键帧相同）。
