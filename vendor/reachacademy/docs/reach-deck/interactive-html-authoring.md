# Reach Deck 互动页 HTML 编写规范

> **这份文件是给 AI 编码助手看的。**
> 如果你是老师：把这个文件整份发给你常用的 AI 编码助手（Claude Code、Codex、Cursor 等），
> 再补一句你想要的互动内容，助手产出的 `.html` 就能直接在 Reach Deck 里上传。
>
> 如果你是 AI 助手：请完整读完再动手。下面每一条都对应平台上传时的一道真实校验，
> 违反其中任何一条，文件会被直接拒收并给出对应的错误码。

---

## 1. 你要交付什么

**一个 `.html` 文件。** 不是一个项目，不是一个压缩包，不是一组文件。

| 项目   | 要求                                                          |
| ------ | ------------------------------------------------------------- |
| 文件数 | 恰好 1 个                                                     |
| 扩展名 | `.html` 或 `.htm`                                             |
| 编码   | UTF-8（不需要 BOM，有也会被自动去掉；GBK 等其它编码直接拒收） |
| 大小   | ≤ 512 KiB                                                     |
| 结构   | 必须含有 `<html>`、`<head>`、`<body>`                         |

所有 CSS 和 JavaScript 都写在这一个文件里（`<style>` 与 `<script>` 内联）。

---

## 2. 运行环境（先理解这个，后面的限制才讲得通）

页面运行在一个**不透明来源（opaque origin）的沙箱 iframe** 里：

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
```

平台会注入这条 CSP：

```
default-src 'none';
script-src 'unsafe-inline' <平台内置运行时的精确 URL>;
style-src 'unsafe-inline';
img-src data: blob:;
font-src data: blob:;
media-src data: blob:;
connect-src 'none';
worker-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none'
```

由此产生的三条事实：

1. **完全没有网络。** 页面运行时无法发起任何请求，也无法加载任何外部资源。
2. **没有真正的持久化存储。** `localStorage` / `sessionStorage` 是内存垫片，页面卸载即消失。
3. **没有同源身份。** 页面拿不到 cookie，也无法访问父页面。

页面要做的是一个**能离线自洽运行的活动**，而不是一个联网应用的壳。

---

## 3. 绝对禁止清单

下面每一项都会让上传直接失败。括号里是你会看到的错误码。

### 3.1 标签（`forbidden_tag`）

```
<base> <iframe> <object> <embed> <form> <frame> <frameset>
```

需要收集输入就用 `<input>` / `<button>` 加 JavaScript，不要用 `<form>`。

### 3.2 外部链接（`external_url`）

以下属性的值只允许为空、`#...`、`data:` 或 `blob:`：

```
src  href  action  formaction  poster  srcdoc  xlink:href
```

也就是说：**不能引用任何在线图片、字体、音频、视频、样式表或脚本。**
需要图片就内联成 `data:image/...;base64,...`，或者直接用 SVG / Canvas 画。

### 3.3 CSS 外部资源（`external_css`）

```css
@import ...;              /* 禁止 */
background: url(https://…) /* 禁止 */
background: url(data:…)    /* 允许 */
```

### 3.4 文档策略覆盖（`http_equiv`）

不要写任何 `<meta http-equiv="...">`（CSP、refresh 等一律禁止）。
`<meta charset="utf-8">` 和 `<meta name="viewport" ...>` 是允许的。

### 3.5 JavaScript API（`unsafe_script_api`）

```
fetch  XMLHttpRequest  WebSocket  EventSource  navigator.sendBeacon
Worker  SharedWorker  importScripts
import(...)  import ... from ...   （见第 4.3 节 three.js 的例外）
window.open  document.cookie  location = ...
```

### 3.6 平台保留属性（`tailwind_marker_reserved` / `three_marker_reserved`）

**不要**自己写这两个属性，它们由平台在上传时注入：

```
data-reach-tailwind-runtime
data-reach-three-runtime
```

---

## 4. 内置库：照常写 CDN 引用，平台会替换成离线版本

这是**唯一**能用到第三方库的方式。平台在上传时识别下面这几种写法，
把它们换成仓库自带、版本锁定、带 SRI 校验的离线资源。识别不了的外链一律 `unknown_dependency` 报错。

### 4.1 Tailwind CSS

照常写 Play CDN：

```html
<script src="https://cdn.tailwindcss.com"></script>
```

平台会替换成内置的 **Tailwind 4.3.0**。

> ⚠️ Play CDN 对应的是 Tailwind **3.x**，平台是 **4.3.0**。
> 请按 v4 写类名（例如 v4 已移除/改名的工具类不要用）。

额外限制：

- 不支持 `tailwind.config = {...}` 这类运行时配置，也不支持插件（`tailwind_config`）。
- 不支持 `@config` / `@plugin` / `@import` / `@reference` 指令。
- 不支持带 `url(...)` 的任意值工具类，例如 `bg-[url(...)]`（`tailwind_url_utility`）。
- Tailwind 的 preflight 与 cascade layer 是开启的。**不要用自己的 CSS 和工具类争抢同一个属性。**
- Tailwind 编译完成前页面要已经有稳定的初始布局，不要依赖编译后才成形。

### 4.2 KaTeX（数学公式）

照常引用 0.16.x：

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.33/dist/katex.min.css" />
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.33/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.33/dist/contrib/auto-render.min.js"></script>
```

上传时会发生两件事：

1. 正文里的 `$$…$$`、`\[…\]`、`\(…\)` 被**静态渲染成 MathML**，运行时零开销。
2. 如果你还要在交互后动态生成公式，平台会内嵌一份 **MathML-only 的 KaTeX 内核**。

> ⚠️ **预算提醒**：内嵌内核约 276 KB。用了 KaTeX 之后，你自己的内容大约只剩 **236 KiB** 空间。
> 只是静态展示公式的话，优先让公式被静态渲染，别在运行时调 `katex.render`。

### 4.3 three.js（3D）

用标准的 import map + ES module 写法：

```html
<script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"
    }
  }
</script>
<script type="module">
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  // ...
</script>
```

平台会删掉 import map，把 `import` 改写成读取内置 **three 0.185.1** 的全局对象。

> ⚠️ addons **只支持** `three/addons/controls/OrbitControls.js`。
> 引用其它 addon、或者用平台识别不了的 import 写法（例如动态 `import()`、重命名的副作用导入），
> 改写会失败并落到 `unsafe_script_api` 报错。

### 4.4 其它库

**不支持。** 任何其它 CDN、任何其它 `<script src>` / `<link href>` 都会被拒收。
需要图表、动画、物理效果，请用原生 Canvas / SVG / CSS 手写。

---

## 5. 生命周期：不写也能跑

平台会在 `<body>` 末尾自动追加一段激活脚本，所以**你什么都不写，页面也能正常进入运行状态**。

如果你想自己控制初始化时机（例如等资源准备好再宣告就绪），用这个写法：

```html
<script>
  window.addEventListener(
    'reach-interactive-initialize',
    () => window.ReachInteractive?.ready?.({}),
    { once: true },
  );
</script>
```

> ⏱ 页面必须在 **10 秒内**完成初始化，否则学生端会显示加载失败。

---

## 6. 能力边界：本期不支持进度与评分

上传的互动页运行在 `completionMode: 'none'` 契约下：

- ❌ 不持久化任何状态。学生刷新页面，一切从头开始。
- ❌ 不计分、不判定通过、不上报完成。
- ❌ 老师看不到这一页的作答数据。

**所以不要设计这些东西：**

- 需要保存进度的多步骤任务
- 需要提交并被批改的测验（用 Reach Deck 自带的测验页）
- 需要跨页面或跨会话记忆的内容

**适合做的是：**

- 参数可调的模拟与可视化（拖滑块看结果怎么变）
- 可自由探索、可随时重置的交互模型
- 即时反馈的练习（对错当场显示，不需要留痕）
- 概念演示与动画讲解

---

## 7. 布局契约

页面是**一块活动面板**，不是一个落地页，也不是一节小课。不要重复页面标题，不要用大段引导文字占高度。

```css
html {
  block-size: 100%;
}
body {
  margin: 0;
  block-size: 100%;
}
```

- 根容器用**一个**撑满视口的 Flex 或 Grid，不要用固定像素的舞台。
- 用可伸缩的轨道（`fr` / `minmax`）和可收缩的子项（`min-width: 0` / `min-height: 0`）。
- 写窄屏与矮屏媒体查询，保证桌面与平板都不出现纵向兜底滚动。
- 空间不足时渐进隐藏次要信息，而不是让主面板被挤扁。
- Canvas / SVG 从**容器实际尺寸**测量，不要写死像素。只在初始化和真实尺寸变化时重绘，
  不要开一个无条件的测量循环。
- 鼠标、触摸、键盘三条路径要等价可用。
- 动画要有节制，并提供等价的静态呈现：

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}
```

---

## 8. 自检清单

交付前逐条对照：

- [ ] 只有一个 `.html` 文件，UTF-8，≤ 512 KiB（用 KaTeX 时 ≤ 236 KiB）
- [ ] 全文搜索 `http://` 和 `https://`，除了第 4 节列出的三个内置库 CDN，没有任何其它外链
- [ ] 没有 `<base>` `<iframe>` `<object>` `<embed>` `<form>` `<frame>` `<frameset>`
- [ ] 没有 `<meta http-equiv>`
- [ ] 没有 `fetch` `XMLHttpRequest` `WebSocket` `EventSource` `sendBeacon` `Worker` `importScripts` `window.open` `document.cookie` `location =`
- [ ] 没有自己写 `data-reach-tailwind-runtime` / `data-reach-three-runtime`
- [ ] 图片全部是 `data:` 内联或用代码绘制
- [ ] `body` 无 margin，根容器撑满视口且可收缩
- [ ] 窄屏（390×844）与桌面（1280×800）都不出现纵向兜底滚动
- [ ] 有 `prefers-reduced-motion` 降级
- [ ] 没有依赖保存进度或评分的设计
- [ ] 在本地浏览器里直接打开能跑通（注意：本地打开时 CDN 是真联网的，平台上会换成离线版本）

---

## 9. 错误码对照表

上传失败时，面板会显示这些代码：

| 代码                           | 含义                                           | 怎么改                                      |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------- |
| `document_too_large`           | 源文件超过 512 KiB                             | 精简内容或压缩内联资源                      |
| `transformed_too_large`        | 内联内置库后超过 512 KiB                       | 多半是 KaTeX 内核占位，减少自身体积         |
| `invalid_encoding`             | 不是合法 UTF-8                                 | 用 UTF-8 重新保存                           |
| `empty_source`                 | 文件为空                                       | —                                           |
| `document_incomplete`          | 缺少 `html` / `head` / `body`                  | 补全文档结构                                |
| `unknown_dependency`           | 引用了不支持的外部依赖                         | 只能用第 4 节列出的三个库                   |
| `external_url`                 | 有外链资源                                     | 改成 `data:` 内联                           |
| `external_css`                 | CSS 里有 `@import` 或外链 `url()`              | 内联或删除                                  |
| `forbidden_tag`                | 用了禁止的标签                                 | 见 3.1                                      |
| `http_equiv`                   | 用了 `<meta http-equiv>`                       | 删除                                        |
| `unsafe_script_api`            | 用了禁止的 JS API，或 three.js import 改写失败 | 见 3.5 / 4.3                                |
| `tailwind_config`              | 写了 Tailwind 运行时配置或插件                 | 删除，只用工具类                            |
| `tailwind_url_utility`         | 任意值工具类里有 `url(...)`                    | 改用普通 CSS 的 `data:` 背景                |
| `tailwind_marker_reserved`     | 自己写了平台保留的 Tailwind 标记               | 删除该属性                                  |
| `three_marker_reserved`        | 自己写了平台保留的 three 标记                  | 删除该属性                                  |
| `tailwind_version_replacement` | ⚠️ 警告，不阻断                                | Play CDN 3.x 已换成平台 4.3.0，检查类名差异 |
| `three_version_replacement`    | ⚠️ 警告，不阻断                                | 已换成平台 three 0.185.1，检查渲染差异      |
| `scene_invalid`                | 结构或脚本语法有问题                           | 按提示修正                                  |

---

## 10. 模板 A：纯 CSS（无任何外部依赖）

可以直接改这一份。

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>正比例函数探索</title>
    <style>
      html {
        block-size: 100%;
      }
      body {
        margin: 0;
        block-size: 100%;
        font-family:
          system-ui,
          -apple-system,
          'Segoe UI',
          sans-serif;
        color: #1f2430;
        background: #f7f9fc;
      }
      .stage {
        block-size: 100%;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 0.75rem;
        padding: clamp(0.75rem, 2vw, 1.5rem);
        box-sizing: border-box;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.75rem 1.25rem;
      }
      .controls label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .controls output {
        min-inline-size: 3.5rem;
        font-variant-numeric: tabular-nums;
        font-weight: 650;
        color: #2563eb;
      }
      .panel {
        min-block-size: 0;
        min-inline-size: 0;
        background: #fff;
        border-radius: 0.75rem;
        box-shadow: 0 1px 3px rgb(15 23 42 / 10%);
        overflow: hidden;
      }
      canvas {
        display: block;
        inline-size: 100%;
        block-size: 100%;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 0.4rem 1rem;
        background: #2563eb;
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        transition: background 160ms ease;
      }
      button:hover {
        background: #1d4ed8;
      }
      @media (max-height: 520px) {
        .controls {
          gap: 0.5rem 1rem;
          font-size: 0.9rem;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        * {
          animation: none !important;
          transition: none !important;
        }
      }
    </style>
  </head>
  <body>
    <div class="stage">
      <div class="controls">
        <label>
          斜率 k
          <input id="slope" type="range" min="-3" max="3" step="0.1" value="1" />
          <output id="slopeValue">1.0</output>
        </label>
        <button id="reset" type="button">重置</button>
      </div>
      <div class="panel"><canvas id="plot"></canvas></div>
    </div>

    <script>
      const canvas = document.getElementById('plot');
      const context = canvas.getContext('2d');
      const slider = document.getElementById('slope');
      const readout = document.getElementById('slopeValue');

      // 只在初始化和容器真实尺寸变化时重绘，不开测量循环。
      const observer = new ResizeObserver(() => {
        const ratio = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        draw();
      });
      observer.observe(canvas.parentElement);

      function draw() {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const k = Number(slider.value);
        context.clearRect(0, 0, width, height);

        context.strokeStyle = '#e2e8f0';
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(0, height / 2);
        context.lineTo(width, height / 2);
        context.moveTo(width / 2, 0);
        context.lineTo(width / 2, height);
        context.stroke();

        // y = k·x，原点在画布中心，向上为正。
        const half = width / 2;
        context.strokeStyle = '#2563eb';
        context.lineWidth = 2.5;
        context.beginPath();
        context.moveTo(0, height / 2 + k * half);
        context.lineTo(width, height / 2 - k * half);
        context.stroke();
      }

      slider.addEventListener('input', () => {
        readout.textContent = Number(slider.value).toFixed(1);
        draw();
      });
      document.getElementById('reset').addEventListener('click', () => {
        slider.value = '1';
        readout.textContent = '1.0';
        draw();
      });
    </script>
  </body>
</html>
```

---

## 11. 模板 B：Tailwind

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>细胞分裂阶段</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      /* 只补 Tailwind 表达不了的东西，不要和工具类争同一个属性。 */
      html,
      body {
        block-size: 100%;
      }
      body {
        margin: 0;
      }
      @media (prefers-reduced-motion: reduce) {
        * {
          animation: none !important;
          transition: none !important;
        }
      }
    </style>
  </head>
  <body class="h-full bg-slate-50 text-slate-800">
    <main class="flex h-full flex-col gap-3 p-3 sm:p-5">
      <nav class="flex flex-wrap gap-2" id="steps"></nav>

      <section class="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="flex min-h-0 min-w-0 items-center justify-center rounded-xl bg-white shadow-sm">
          <svg class="h-full w-full max-h-full" viewBox="0 0 200 120" id="figure"></svg>
        </div>
        <aside class="min-w-0 rounded-xl bg-white p-4 shadow-sm">
          <h2 class="text-base font-semibold" id="title">前期</h2>
          <p class="mt-2 text-sm leading-relaxed text-slate-600" id="detail"></p>
        </aside>
      </section>
    </main>

    <script>
      const PHASES = [
        { name: '前期', detail: '染色质凝缩成染色体，核膜开始解体，纺锤体开始形成。', count: 4 },
        { name: '中期', detail: '染色体排列在赤道板上，纺锤丝与着丝粒连接。', count: 4 },
        { name: '后期', detail: '着丝粒分裂，姐妹染色单体被拉向两极。', count: 8 },
        { name: '末期', detail: '染色体解螺旋，核膜重建，胞质分裂开始。', count: 8 },
      ];
      const steps = document.getElementById('steps');
      const title = document.getElementById('title');
      const detail = document.getElementById('detail');
      const figure = document.getElementById('figure');
      let active = 0;

      PHASES.forEach((phase, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = phase.name;
        button.dataset.index = String(index);
        button.className =
          'rounded-full px-4 py-1.5 text-sm font-semibold transition-colors duration-150';
        steps.append(button);
      });

      steps.addEventListener('click', (event) => {
        const index = event.target?.dataset?.index;
        if (index === undefined) return;
        active = Number(index);
        render();
      });

      function render() {
        for (const button of steps.children) {
          const selected = Number(button.dataset.index) === active;
          button.setAttribute('aria-pressed', String(selected));
          button.className = selected
            ? 'rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors duration-150'
            : 'rounded-full bg-slate-200 px-4 py-1.5 text-sm font-semibold text-slate-700 transition-colors duration-150 hover:bg-slate-300';
        }
        const phase = PHASES[active];
        title.textContent = phase.name;
        detail.textContent = phase.detail;
        figure.innerHTML = Array.from({ length: phase.count }, (_, index) => {
          const x = 40 + (index % 4) * 40;
          const y = phase.count > 4 ? (index < 4 ? 35 : 85) : 60;
          return `<rect x="${x}" y="${y - 8}" width="8" height="16" rx="3" fill="#4f46e5"/>`;
        }).join('');
      }

      render();
    </script>
  </body>
</html>
```

---

## 12. 上传方式（老师操作）

1. 在 Reach Deck 编辑器里新建一个**互动**页面，或选中一个已有的互动页面。
2. 空白页上点「上传 HTML」；已有内容的互动页在右侧「属性」里点「上传 HTML」。
3. 选择文件后会先出现**预览**：页面在真实沙箱里跑一遍，并列出所有诊断。
4. 没有红色错误就可以确认应用；确认后当前页被替换。
5. 想改就改完 HTML 再传一次，走同一个入口。
