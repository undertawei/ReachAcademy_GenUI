/// <reference lib="dom" />
// @vitest-environment jsdom

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { auditInteractiveDocumentHtml } from '@reachany/reach-deck-dsl';

import {
  collectMaicMediaReferences,
  createMaicCandidateDigest,
  createStableMaicId,
  mapMaicToReachDeckV2,
  parseMaicCourse,
  transformMaicInteractiveHtml,
} from '../src/maic/index.js';

const theme = {
  name: 'Import',
  background: '#FFFFFF',
  surface: '#F8FAFC',
  ink: '#111827',
  muted: '#64748B',
  accent: '#2563EB',
  success: '#15803D',
  warning: '#B45309',
  fontDisplay: 'Noto Sans',
  fontBody: 'Noto Sans',
} as const;

const source = {
  title: 'Synthetic lesson',
  width: 1280,
  height: 720,
  theme: {},
  slides: [
    {
      id: 'canvas-1',
      component_type: 'canvas',
      canvas_width: 1280,
      canvas_height: 720,
      background: { color: '#ffffff' },
      script: 'Synthetic narration',
      elements: [
        {
          id: 'text-1',
          type: 'text',
          left: 100,
          top: 100,
          width: 300,
          height: 80,
          rotate: 0,
          content: '<p>Synthetic text</p>',
        },
        {
          id: 'image-1',
          type: 'image',
          left: 500,
          top: 100,
          width: 200,
          height: 100,
          rotate: 0,
          src: 'https://file.maic.chat/synthetic.png',
        },
        {
          id: 'audio-1',
          type: 'audio',
          left: 100,
          top: 300,
          width: 50,
          height: 50,
          rotate: 0,
          src: 'https://file.maic.chat/synthetic.mp3',
          autoplay: false,
          loop: false,
        },
      ],
    },
    {
      id: 'quiz-1',
      component_type: 'quiz',
      canvas_width: 1280,
      canvas_height: 720,
      elements: [],
      questions: [
        {
          question_type: 'single_choice',
          question: 'Synthetic question',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
          answer: ['a'],
          hasAnswer: true,
          analysis: '',
        },
      ],
    },
    {
      id: 'interactive-1',
      component_type: 'interactive',
      canvas_width: 1280,
      canvas_height: 720,
      elements: [],
      content: {
        title: 'Synthetic activity',
        html: `<!doctype html><html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script></head><body><p>\\(x^2\\)</p><script>renderMathInElement(document.body)</script></body></html>`,
      },
    },
  ],
};

describe('bounded MAIC import', () => {
  it('renames every duplicate canvas element id without colliding with source ids', () => {
    const duplicateSource = structuredClone(source) as unknown as {
      slides: Array<{ id: string; elements: Array<Record<string, unknown>> }>;
    };
    const canvas = duplicateSource.slides[0]!;
    const reservedGeneratedId = createStableMaicId('duplicate-element', [
      canvas.id,
      'repeated-text',
      '2',
      '0',
    ]);
    canvas.elements = [
      {
        id: 'repeated-text',
        type: 'text',
        left: 10,
        top: 20,
        width: 200,
        height: 40,
        content: '<p>First</p>',
      },
      {
        id: 'repeated-text',
        type: 'text',
        left: 10,
        top: 70,
        width: 200,
        height: 40,
        content: '<p>Second</p>',
      },
      {
        id: reservedGeneratedId,
        type: 'text',
        left: 10,
        top: 120,
        width: 200,
        height: 40,
        content: '<p>Reserved source id</p>',
      },
      {
        id: 'repeated-text',
        type: 'text',
        left: 10,
        top: 170,
        width: 200,
        height: 40,
        content: '<p>Third</p>',
      },
    ];

    const first = parseMaicCourse(JSON.stringify(duplicateSource));
    const second = parseMaicCourse(JSON.stringify(duplicateSource));

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const page = first.ir.pages[0];
    expect(page?.kind).toBe('canvas');
    if (page?.kind !== 'canvas') return;
    expect(page.elements).toHaveLength(4);
    expect(new Set(page.elements.map((element) => element.id)).size).toBe(4);
    expect(page.elements[0]?.id).toBe('repeated-text');
    expect(page.elements[2]?.id).toBe(reservedGeneratedId);
    expect(page.elements.map((element) => element.source.id)).toEqual([
      'repeated-text',
      'repeated-text',
      reservedGeneratedId,
      'repeated-text',
    ]);
    const duplicateDiagnostics = first.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'maic.element.duplicate_id',
    );
    expect(duplicateDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        details: {
          originalId: 'repeated-text',
          remappedId: page.elements[1]?.id,
          occurrence: 2,
        },
      }),
      expect.objectContaining({
        severity: 'warning',
        details: {
          originalId: 'repeated-text',
          remappedId: page.elements[3]?.id,
          occurrence: 3,
        },
      }),
    ]);
    expect(first.capabilityReport.pageReports[0]).toMatchObject({ status: 'warning' });

    const mapped = mapMaicToReachDeckV2(first.ir, {
      documentId: 'duplicate-document',
      applicationId: 'duplicate-application',
      title: 'Duplicate identity fixture',
      language: 'en-US',
      generatedAt: '2026-09-09T00:00:00.000Z',
      compatibilityTheme: theme,
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const elements = mapped.document.nativeSlides[0]?.slide.elements ?? [];
    expect(elements).toHaveLength(4);
    expect(new Set(elements.map((element) => element.id)).size).toBe(4);
    expect(elements.map((element) => element.zIndex)).toEqual([0, 1, 2, 3]);
    expect(elements.map((element) => element.source?.sourceId)).toEqual(
      page.elements.map((element) => element.id),
    );
  });

  it('keeps duplicate media element identities and resources separate', () => {
    const duplicateSource = structuredClone(source) as unknown as {
      slides: Array<{ elements: Array<Record<string, unknown>> }>;
    };
    duplicateSource.slides[0]!.elements = [
      {
        id: 'repeated-image',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        src: 'https://file.maic.chat/first.png',
      },
      {
        id: 'repeated-image',
        type: 'image',
        left: 100,
        top: 0,
        width: 100,
        height: 100,
        src: 'https://file.maic.chat/second.png',
      },
    ];
    const parsed = parseMaicCourse(JSON.stringify(duplicateSource));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const page = parsed.ir.pages[0];
    expect(page?.kind).toBe('canvas');
    if (page?.kind !== 'canvas') return;
    expect(parsed.ir.mediaReferences).toHaveLength(2);
    expect(parsed.ir.mediaReferences.map((reference) => reference.elementId).sort()).toEqual(
      page.elements.map((element) => element.id).sort(),
    );
    expect(new Set(parsed.ir.mediaReferences.map((reference) => reference.id)).size).toBe(2);

    const media = Object.fromEntries(
      parsed.ir.mediaReferences.map((reference) => [
        reference.id,
        {
          objectKey: reference.sourceUrl.includes('/first.png')
            ? 'courses/synthetic/first.png'
            : 'courses/synthetic/second.png',
          contentType: 'image/png',
          digest:
            `sha256:${reference.sourceUrl.includes('/first.png') ? '1'.repeat(64) : '2'.repeat(64)}` as `sha256:${string}`,
        },
      ]),
    );
    const mapped = mapMaicToReachDeckV2(parsed.ir, {
      documentId: 'duplicate-media-document',
      applicationId: 'duplicate-media-application',
      title: 'Duplicate media fixture',
      language: 'en-US',
      generatedAt: '2026-09-09T00:00:00.000Z',
      compatibilityTheme: theme,
      media,
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const elements = mapped.document.nativeSlides[0]?.slide.elements ?? [];
    expect(elements.map((element) => element.zIndex)).toEqual([0, 1]);
    const referencesByElementId = new Map(
      parsed.ir.mediaReferences.map((reference) => [reference.elementId, reference]),
    );
    const resourcesById = new Map(
      mapped.document.resources.media.map((resource) => [resource.id, resource]),
    );
    expect(
      elements.map((element) => ('resourceId' in element ? element.resourceId : undefined)),
    ).toEqual(
      page.elements.map((element) => {
        const reference = referencesByElementId.get(element.id);
        return reference
          ? createStableMaicId('media', ['duplicate-media-application', reference.id])
          : undefined;
      }),
    );
    expect(
      elements.map((element) =>
        'resourceId' in element ? resourcesById.get(element.resourceId)?.objectKey : undefined,
      ),
    ).toEqual(['courses/synthetic/first.png', 'courses/synthetic/second.png']);
  });

  it('parses deterministic IR, media references, and offline interactive HTML', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(source));
    const first = parseMaicCourse(bytes);
    const second = parseMaicCourse(bytes);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.ir.pages.map((page) => page.kind)).toEqual(['canvas', 'quiz', 'interactive']);
    expect(first.capabilityReport.canApply).toBe(true);
    expect(first.capabilityReport.pageReports[2]).toMatchObject({ status: 'ok' });
    expect(first.diagnostics.map((entry) => entry.code)).not.toContain(
      'maic.interactive.katex_patch_skew',
    );
    expect(collectMaicMediaReferences(first.ir)).toHaveLength(2);
    const interactive = first.ir.pages[2];
    expect(interactive?.kind).toBe('interactive');
    if (interactive?.kind === 'interactive') {
      const transformedHtml = interactive.transformedHtml;
      expect(transformedHtml).toBeDefined();
      if (transformedHtml === undefined) return;
      expect(transformedHtml).toContain('<math');
      expect(transformedHtml).toContain('ReachInteractive.ready');
      expect(transformedHtml).not.toContain('cdn.jsdelivr.net');
      const bundle = transformedHtml.match(
        /<script data-maic-offline-katex="">([\s\S]*?)<\/script>/,
      );
      expect(bundle?.[1]).toBeDefined();
      expect(auditInteractiveDocumentHtml(transformedHtml).status).toBe('pass');
      expect(new TextEncoder().encode(bundle?.[1] ?? '')).toHaveLength(276592);
      expect(
        createHash('sha256')
          .update(bundle?.[1] ?? '')
          .digest('hex'),
      ).toBe('edad612acc62d4af72674aa72764852b9d2399410ce7b026edaf499ffcdc49e6');
    }
  });

  it.each(['https://cdn.tailwindcss.com', 'https://cdn.tailwindcss.com/'])(
    'replaces the exact MAIC Tailwind CDN dependency with the pinned platform runtime: %s',
    (url) => {
      const tailwindSource = structuredClone(source) as unknown as {
        slides: Array<Record<string, unknown>>;
      };
      tailwindSource.slides[2] = {
        ...tailwindSource.slides[2],
        content: {
          title: 'Tailwind activity',
          html: `<!doctype html><html><head><script src="${url}"></script></head><body><button class="md:text-2xl hover:bg-indigo-700">Try</button></body></html>`,
        },
      };

      const parsed = parseMaicCourse(JSON.stringify(tailwindSource));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const interactive = parsed.ir.pages[2];
      if (interactive?.kind !== 'interactive') throw new Error('Expected Interactive page.');
      expect(interactive.runtimeDependencies).toEqual([
        { id: 'tailwind-browser', version: '4.3.0' },
      ]);
      expect(interactive.transformedHtml).toContain('data-reach-tailwind-runtime="4.3.0"');
      expect(interactive.transformedHtml).not.toContain('cdn.tailwindcss.com');
      expect(interactive.transformedHtml).not.toContain('data-maic-offline-tailwind');
      expect(
        parsed.diagnostics.filter(({ code }) => code.includes('tailwind')).map(({ code }) => code),
      ).toEqual(['maic.interactive.tailwind_version_replacement']);

      const mapped = mapMaicToReachDeckV2(parsed.ir, {
        documentId: 'doc-tailwind',
        applicationId: 'apply-tailwind',
        title: 'Tailwind import',
        language: 'en-US',
        generatedAt: '2026-09-09T00:00:00.000Z',
        compatibilityTheme: theme,
      });
      expect(mapped.ok).toBe(true);
      if (!mapped.ok) return;
      const page = mapped.document.pages.find(({ sceneType }) => sceneType === 'interactive');
      expect(page?.sceneType).toBe('interactive');
      if (page?.sceneType !== 'interactive') return;
      expect(page.scene.runtimeDependencies).toEqual([
        { id: 'tailwind-browser', version: '4.3.0' },
      ]);
      expect(mapped.document.provenance?.importerVersion).toBe('0.3.5');
    },
  );

  const cssDocument = (body: string) =>
    `<!doctype html><html><head></head><body>${body}</body></html>`;

  it.each([
    // 同文档 SVG 标记引用——MAIC 的 diagram 页大量使用，运行时完全能离线解析。
    ['style 元素引用同文档 fragment', '<style>.edge{marker-end:url(#arrowhead);}</style>'],
    ['style 属性引用同文档 fragment', '<div style="clip-path:url(#clip)"></div>'],
  ])('keeps offline CSS url() references importable: %s', (_label, body) => {
    const result = transformMaicInteractiveHtml(cssDocument(body), {
      pageId: 'offline-css',
      sourceOrder: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(auditInteractiveDocumentHtml(result.html ?? '').issues).toEqual([]);
  });

  it.each([
    ['style 元素引用外部图', '<style>.a{background:url(https://evil.test/x.png);}</style>'],
    ['带引号的外部图', '<style>.a{background:url("https://evil.test/x.png");}</style>'],
    // 导入侧原本不检查 style 属性，这类页会一路漏到文档审计层才被拦下。
    ['style 属性引用外部图', '<div style="background:url(https://evil.test/x.png)"></div>'],
    ['@import 外部样式表', '<style>@import "https://evil.test/x.css";</style>'],
    // CSS 转义混淆：`\75 rl(...)` 浏览器会当成 url(...)。
    ['转义混淆的 url', '<style>.a{background:\\75 rl(https://evil.test/x.png);}</style>'],
    // DSL 不剥注释，导入侧必须同样拒绝，否则会漏成无页面定位的 fatal。
    ['注释里藏的外部 url', '<style>.a{background:/* url(https://evil.test/a) */url(#ok);}</style>'],
    // 导入侧一贯拒绝内联资源，媒体要走托管管线；这里刻意比 DSL 更严。
    ['内联 data: 图片', '<style>.a{background:url(data:image/png;base64,iVBOR);}</style>'],
  ])('rejects CSS that reaches outside the document: %s', (_label, body) => {
    const result = transformMaicInteractiveHtml(cssDocument(body), {
      pageId: 'external-css',
      sourceOrder: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain('maic.interactive.external_css');
  });

  const threeImportMap = `<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}</script>`;
  const threeDocument = (body: string) =>
    `<!doctype html><html><head>${threeImportMap}</head><body>${body}</body></html>`;

  it('rewrites MAIC three imports onto the platform runtime globals', () => {
    const result = transformMaicInteractiveHtml(
      threeDocument(
        `<script type="module">import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const scene = new THREE.Scene();
const controls = new OrbitControls();</script>`,
      ),
      { pageId: 'three-page', sourceOrder: 1 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtimeDependencies).toEqual([{ id: 'three-module', version: '0.185.1' }]);
    expect(result.html).toContain('data-reach-three-runtime="0.185.1"');
    expect(result.html).toContain('const THREE = window.__reachThree;');
    expect(result.html).toContain('const { OrbitControls } = window.__reachThreeAddons;');
    // importmap 指向 unpkg，接管后必须从产物里消失。
    expect(result.html).not.toContain('importmap');
    expect(result.html).not.toContain('unpkg.com');
    // 关键不变量：产物必须能原样通过文档审计。
    const transformedHtml = result.html ?? '';
    expect(auditInteractiveDocumentHtml(transformedHtml).issues).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'maic.interactive.three_version_replacement',
    );
  });

  it('rewrites named three imports and preserves local aliases', () => {
    const result = transformMaicInteractiveHtml(
      threeDocument(
        `<script type="module">import { Scene, Mesh as M } from 'three';
const s = new Scene();
const m = new M();</script>`,
      ),
      { pageId: 'three-named', sourceOrder: 1 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('const { Scene, Mesh: M } = window.__reachThree;');
  });

  it.each([
    // 平台只打包了 OrbitControls；其他 addon 改写出来会拿到 undefined。
    `<script type="module">import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';</script>`,
    // OrbitControls 之外的具名导入同样不在白名单里。
    `<script type="module">import { TrackballControls } from 'three/addons/controls/OrbitControls.js';</script>`,
    // three 没有默认导出。
    `<script type="module">import THREE from 'three';</script>`,
    // 非 three 模块没有平台内置版本。
    `<script type="module">import * as THREE from 'three';
import confetti from 'canvas-confetti';</script>`,
  ])('refuses to rewrite an unsupported three import: %#', (body) => {
    const result = transformMaicInteractiveHtml(threeDocument(body), {
      pageId: 'three-unsupported',
      sourceOrder: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'maic.interactive.unsafe_script_api',
    );
  });

  it('refuses a three import without the matching importmap', () => {
    const result = transformMaicInteractiveHtml(
      `<!doctype html><html><head></head><body><script type="module">import * as THREE from 'three';</script></body></html>`,
      { pageId: 'three-no-map', sourceOrder: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'maic.interactive.unsafe_script_api',
    );
  });

  it('refuses a document that declares the platform-owned three marker', () => {
    const result = transformMaicInteractiveHtml(
      '<!doctype html><html data-reach-three-runtime="0.185.1"><head></head><body></body></html>',
      { pageId: 'three-marker', sourceOrder: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'maic.interactive.three_marker_reserved',
    );
  });

  it.each([
    // 静态 ESM import 必须在本页就判错，否则会漏到文档审计层变成无页面定位的 fatal。
    // three 是唯一例外（平台自带同一个库，导入期会改写），由上面的改写用例覆盖；
    // 这里保留「有 three import 但没有 importmap」的形态，它仍应判错。
    `<script type="module">import { OrbitControls } from 'three/addons/controls/OrbitControls.js';</script>`,
    `<script type="module">import confetti from 'canvas-confetti';</script>`,
    // 动态 import 是旧口径已覆盖的形式，一并锁住防回归。
    `<script type="module">import('./chunk.js');</script>`,
  ])('rejects an interactive script that imports a module: %#', (body) => {
    const result = transformMaicInteractiveHtml(
      `<!doctype html><html><head></head><body>${body}</body></html>`,
      { pageId: 'module-import', sourceOrder: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'maic.interactive.unsafe_script_api',
    );
  });

  it('keeps prose mentioning import and from out of the forbidden-API check', () => {
    const result = transformMaicInteractiveHtml(
      '<!doctype html><html><head></head><body><p>Iron is important, imported from ore.</p></body></html>',
      { pageId: 'prose-only', sourceOrder: 1 },
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    'http://cdn.tailwindcss.com/',
    'https://cdn.tailwindcss.com/?plugins=forms',
    'https://cdn.tailwindcss.com/3.4.17',
    'https://cdn.tailwindcss.com.evil.test/',
  ])('rejects a non-exact Tailwind CDN dependency: %s', (url) => {
    const result = transformMaicInteractiveHtml(
      `<!doctype html><html><head><script src="${url}"></script></head><body></body></html>`,
      { pageId: 'tailwind-lookalike', sourceOrder: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.runtimeDependencies).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'maic.interactive.unknown_dependency',
    );
  });

  it.each([
    '<html data-reach-tailwind-runtime="4.3.0"><head></head><body></body></html>',
    '<html><head></head><body data-reach-tailwind-runtime="4.3.0"></body></html>',
    '<html><head><script>tailwind.config={theme:{}}</script></head><body></body></html>',
    '<html><head><script>window.tailwind["plugin"]({})</script></head><body></body></html>',
    '<html><head><script>window["tailwind"]={config:{}}</script></head><body></body></html>',
    '<html><head><script>window["tailwind"].config={}</script></head><body></body></html>',
    '<html><head><script>globalThis["tailwind"]["plugin"]({})</script></head><body></body></html>',
    '<html><head><script>tailwind/* comment */.config={}</script></head><body></body></html>',
    '<html><head><script>const key="tail"+"wind";window[key].config={}</script></head><body></body></html>',
    '<html><head><script>const key=`tail${"wind"}`;window[key].config={}</script></head><body></body></html>',
    '<html><head><script>let key;key="tailwind";window[key].config={}</script></head><body></body></html>',
    '<html><head><script>let key;window[key].config={}</script></head><body></body></html>',
    '<html><head><script>const {tailwind:tw}=window;tw.config={}</script></head><body></body></html>',
    '<html><head><script>const {["tailwind"]:tw}=window;tw.config={}</script></head><body></body></html>',
    '<html><head><script>const {[getKey()]:tw}=window;tw.config={}</script></head><body></body></html>',
    '<html><head><script>var tailwind={config:{}}</script></head><body></body></html>',
    '<html><head><script>function tailwind(){};tailwind.config={}</script></head><body></body></html>',
    '<html><head><script>window.window.tailwind={config:{}}</script></head><body></body></html>',
    '<html><head><script>frames.tailwind.config={}</script></head><body></body></html>',
    '<html><head><script>document.defaultView.tailwind={config:{}}</script></head><body></body></html>',
    '<html><head><script>const {frames:w}=window;w.tailwind.config={}</script></head><body></body></html>',
    '<html><head><script>const {defaultView:w}=document;w.tailwind.config={}</script></head><body></body></html>',
    '<html><head><script>Reflect.get(window,"tailwind").config={}</script></head><body></body></html>',
    '<html><head><script>this.tailwind={config:{}}</script></head><body></body></html>',
    '<html><head><script>Reflect.set(window,"tailwind",{})</script></head><body></body></html>',
    '<html><head><script>Reflect.set(window,key,{})</script></head><body></body></html>',
    '<html><head><script>Object.defineProperty(window,"tailwind",{value:{}})</script></head><body></body></html>',
    '<html><head><script>Object.getOwnPropertyDescriptors(window).tailwind.value.config={}</script></head><body></body></html>',
    '<html><head><script>Object.assign(window,{tailwind:{config:{}}})</script></head><body></body></html>',
    '<html><head><script>const set=Reflect.set;set(window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><script>const assign=Object.assign;assign(window,{tailwind:{config:{}}})</script></head><body></body></html>',
    '<html><head><script>const set=Reflect.set.bind(Reflect);set(window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><script>Reflect.set.call(Reflect,window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><script>const set=Reflect.set;set.call(Reflect,window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><script>Reflect.set.apply(Reflect,[window,"tailwind",{config:{}}])</script></head><body></body></html>',
    '<html><head><script>Reflect.set.bind(Reflect)(window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><script>const set=Reflect.set.bind(Reflect,window,"tailwind");set({config:{}})</script></head><body></body></html>',
    '<html><head><script>Object.getOwnPropertyDescriptors.call(Object,window).tailwind.value.config={}</script></head><body></body></html>',
    '<html><head><script>Reflect.set.call.call(Reflect.set,Reflect,window,"tailwind",{})</script></head><body></body></html>',
    '<html><head><script>window.Reflect.set(window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><script>const R=Reflect;R.set(window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><script>const {set}=window.Reflect;set(window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><script>globalThis.Object.assign(window,{tailwind:{config:{}}})</script></head><body></body></html>',
    '<html><head><script>const key=getKey();Object.assign(window,{[key]:{config:{}}})</script></head><body></body></html>',
    '<html><head><script>const source=getSource();Object.assign(window,{...source})</script></head><body></body></html>',
    '<html><head><script>const {set}=Reflect;set(window,"tailwind",{config:{}})</script></head><body></body></html>',
    '<html><head><style>@plugin "synthetic";</style></head><body></body></html>',
    '<html><head><style type="text/tailwindcss">@pl/**/ugin "./plugin.js";</style></head><body></body></html>',
    '<html><head><style type="text/tailwindcss">@con/**/fig "./tailwind.config.js";</style></head><body></body></html>',
    String.raw`<html><head><style>@pl\75gin "synthetic";</style></head><body></body></html>`,
    '<html><head></head><body><div class="bg-[url(https://example.test/a.png)]"></div></body></html>',
    String.raw`<html><head></head><body><div class="bg-[u\72l(https://example.test/a.png)]"></div></body></html>`,
    '<html><head></head><body><script>document.body.classList.add("bg-[url(https://example.test/a.png)]")</script></body></html>',
    String.raw`<html><head></head><body><script>document.body.classList.add("bg-[u\\72l(https://example.test/a.png)]")</script></body></html>`,
    '<html><head></head><body><button onclick="tailwind.config={};return false">Try</button></body></html>',
    '<html><head></head><body><button onclick="event.view.tailwind.config={}">Try</button></body></html>',
    '<html><head></head><body><button onclick="this.ownerDocument.defaultView.tailwind.config={}">Try</button></body></html>',
    '<html><head></head><body><button onclick="this.classList.add(\'bg-[url(https://example.test/a.png)]\')">Try</button></body></html>',
    String.raw`<html><head></head><body><button onclick="this.classList.add('bg-[u\\72l(https://example.test/a.png)]')">Try</button></body></html>`,
  ])('rejects unsupported or forged Tailwind input', (html) => {
    const result = transformMaicInteractiveHtml(`<!doctype html>${html}`, {
      pageId: 'tailwind-unsafe',
      sourceOrder: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.runtimeDependencies).toEqual([]);
    expect(result.diagnostics.some(({ code }) => code.includes('tailwind'))).toBe(true);
  });

  it('does not confuse locally bound Tailwind-shaped identifiers with the runtime global', () => {
    const result = transformMaicInteractiveHtml(
      `<!doctype html><html><head><script src="https://cdn.tailwindcss.com/"></script><script>
        const tailwind = { config: {} };
        function render(tailwind) { return tailwind.config; }
        render(tailwind);
      </script></head><body><button onclick="const tailwind={config:{}};return tailwind.config">Try</button></body></html>`,
      { pageId: 'tailwind-local-binding', sourceOrder: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'maic.interactive.tailwind_version_replacement',
    ]);
  });

  it('does not interpret Tailwind-shaped text inside CSS strings as directives', () => {
    const result = transformMaicInteractiveHtml(
      '<!doctype html><html><head><script src="https://cdn.tailwindcss.com/"></script><style>.label::after{content:"@pl/**/ugin @config"}</style></head><body></body></html>',
      { pageId: 'tailwind-css-string', sourceOrder: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'maic.interactive.tailwind_version_replacement',
    ]);
  });

  it.each([
    '<script>{const Reflect={set(){}};Reflect.set(window,"tailwind",{})}</script>',
    '<script>const Object={assign(){}};Object.assign(window,{tailwind:{config:{}}})</script>',
    '<script>function render(Reflect){Reflect.set(window,"tailwind",{})}render({set(){}})</script>',
  ])('does not confuse locally shadowed built-ins with Tailwind mutation: %s', (script) => {
    const result = transformMaicInteractiveHtml(
      `<!doctype html><html><head><script src="https://cdn.tailwindcss.com/"></script>${script}</head><body></body></html>`,
      { pageId: 'tailwind-local-builtin', sourceOrder: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'maic.interactive.tailwind_version_replacement',
    ]);
  });

  it('rejects an external CSS URL hidden with CSS escapes', () => {
    const result = transformMaicInteractiveHtml(
      String.raw`<!doctype html><html><head><style>.probe{background:u\72l(https://example.test/a.png)}</style></head><body></body></html>`,
      { pageId: 'css-escape-unsafe', sourceOrder: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.runtimeDependencies).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain('maic.interactive.external_css');
  });

  it('maps canvas, quiz and interactive pages with managed media and text-only narration', () => {
    const markdownLikeSource = structuredClone(source) as unknown as {
      slides: Array<Record<string, unknown>>;
    };
    markdownLikeSource.slides[0]!.script = '**Synthetic narration**\n# literal <break> costs $12';
    const parsed = parseMaicCourse(JSON.stringify(markdownLikeSource));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = Object.fromEntries(
      parsed.ir.mediaReferences.map((reference) => [
        reference.id,
        {
          objectKey: `courses/synthetic/${reference.kind}`,
          contentType: reference.kind === 'image' ? 'image/png' : 'audio/mpeg',
          digest: `sha256:${(reference.kind === 'image' ? '1' : '2').repeat(64)}` as const,
        },
      ]),
    );
    const options = {
      documentId: 'doc-1',
      applicationId: 'apply-1',
      title: 'Synthetic lesson',
      language: 'en-US',
      generatedAt: '2026-08-13T00:00:00.000Z',
      compatibilityTheme: theme,
      media: resolved,
    } as const;
    const first = mapMaicToReachDeckV2(parsed.ir, options);
    const second = mapMaicToReachDeckV2(structuredClone(parsed.ir), options);
    expect(first).toEqual(second);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.document.pages.map((page) => page.sceneType)).toEqual([
      'slide',
      'quiz',
      'interactive',
    ]);
    const interactivePage = first.document.pages.find((page) => page.sceneType === 'interactive');
    expect(interactivePage?.scene).toMatchObject({
      schemaVersion: 'reach-interactive-scene/v2',
      eventManifest: {
        schemaVersion: 'reach-interactive-event-manifest/v1',
        events: [],
      },
    });
    expect(first.document.nativeSlides[0]?.slide.narration).toEqual({
      markdown: '\\*\\*Synthetic narration\\*\\*\n\\# literal \\<break\\> costs $12',
    });
    expect(first.document.nativeSlides[0]?.slide.animations).toEqual([]);
    expect(createMaicCandidateDigest(first.document)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('accepts 2,000 narration units and reports 2,001 at page scope', () => {
    const oversizedSource = structuredClone(source) as unknown as {
      slides: Array<Record<string, unknown>>;
    };
    oversizedSource.slides = [
      {
        id: 'at-limit-script',
        component_type: 'canvas',
        canvas_width: 1280,
        canvas_height: 720,
        background: { color: '#ffffff' },
        script: '界'.repeat(2_000),
        elements: [],
      },
      {
        id: 'oversized-script',
        component_type: 'canvas',
        canvas_width: 1280,
        canvas_height: 720,
        background: { color: '#ffffff' },
        script: '界'.repeat(2_001),
        elements: [],
      },
      {
        id: 'valid-script',
        component_type: 'canvas',
        canvas_width: 1280,
        canvas_height: 720,
        background: { color: '#ffffff' },
        script: 'Valid narration',
        elements: [],
      },
    ];
    const parsed = parseMaicCourse(JSON.stringify(oversizedSource));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapped = mapMaicToReachDeckV2(parsed.ir, {
      documentId: 'oversized-narration-document',
      applicationId: 'oversized-narration-application',
      title: 'Oversized narration',
      language: 'en-US',
      generatedAt: '2026-09-11T00:00:00.000Z',
      compatibilityTheme: theme,
    });

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.document.pages).toHaveLength(2);
    expect(mapped.document.nativeSlides).toHaveLength(2);
    expect(mapped.document.nativeSlides[0]?.slide.narration).toEqual({
      markdown: '界'.repeat(2_000),
    });
    expect(mapped.document.nativeSlides[1]?.slide.narration).toEqual({
      markdown: 'Valid narration',
    });
    expect(mapped.pageReports).toEqual([
      expect.objectContaining({ pageId: 'at-limit-script', status: 'ok' }),
      expect.objectContaining({
        pageId: 'oversized-script',
        status: 'error',
        mappedPageId: undefined,
        diagnostics: [
          expect.objectContaining({
            code: 'maic.narration.invalid',
            severity: 'error',
            feature: 'narration',
            location: expect.objectContaining({
              pageId: 'oversized-script',
              sourceOrder: 2,
              field: 'script',
            }),
            details: { reason: 'semantic-limit' },
          }),
        ],
      }),
      expect.objectContaining({ pageId: 'valid-script', status: 'ok' }),
    ]);
  });

  it('reports lossy canvas fidelity and preserves short-answer reference answers', () => {
    const fidelitySource = structuredClone(source) as unknown as {
      slides: Array<Record<string, unknown>>;
    };
    fidelitySource.slides[0]!.background = { type: 'image', src: 'ignored.png' };
    fidelitySource.slides[1]!.questions = [
      {
        question_type: 'short_answer',
        question: 'Explain why.',
        answer: ['Reference explanation'],
        analysis: '',
      },
    ];
    const parsed = parseMaicCourse(JSON.stringify(fidelitySource));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = Object.fromEntries(
      parsed.ir.mediaReferences.map((reference) => [
        reference.id,
        {
          objectKey: `courses/synthetic/${reference.kind}`,
          contentType: reference.kind === 'image' ? 'image/png' : 'audio/mpeg',
          digest: `sha256:${(reference.kind === 'image' ? '1' : '2').repeat(64)}` as const,
        },
      ]),
    );
    const mapped = mapMaicToReachDeckV2(parsed.ir, {
      documentId: 'doc-fidelity',
      applicationId: 'apply-fidelity',
      title: 'Fidelity diagnostics',
      language: 'en-US',
      generatedAt: '2026-08-13T00:00:00.000Z',
      compatibilityTheme: theme,
      media: resolved,
    });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.diagnostics.map((entry) => entry.code)).toContain(
      'maic.canvas.background_degraded',
    );
    expect(mapped.diagnostics.map((entry) => entry.code)).not.toContain(
      'maic.canvas.text_formatting_degraded',
    );
    const quiz = mapped.document.pages.find((page) => page.sceneType === 'quiz');
    if (quiz?.scene.sceneType !== 'quiz') throw new Error('Expected mapped quiz page.');
    expect(quiz.scene.content.questions[0]).toMatchObject({ has_answer: true });
    expect(JSON.stringify(quiz.scene.content.questions[0]?.answer)).toContain(
      'Reference explanation',
    );
  });

  it('keeps KaTeX rendering available for math inserted after an interaction', () => {
    const result = transformMaicInteractiveHtml(
      `<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script></head><body><button id="reveal">Reveal</button><div id="result"></div><script>document.getElementById('reveal').addEventListener('click',function(){var target=document.getElementById('result');target.textContent='\\\\(y^2\\\\)';renderMathInElement(target)})</script></body></html>`,
      { pageId: 'interactive-dynamic-math', sourceOrder: 1 },
    );

    expect(result.ok).toBe(true);
    if (!result.html) return;
    const parsed = new DOMParser().parseFromString(result.html, 'text/html');
    document.head.innerHTML = parsed.head.innerHTML;
    document.body.innerHTML = parsed.body.innerHTML;
    document.querySelectorAll('script').forEach((script) => window.eval(script.textContent ?? ''));

    document.getElementById('reveal')?.click();

    const rendered = document.getElementById('result');
    expect(rendered?.querySelector('math')).not.toBeNull();
    expect(rendered?.innerHTML).not.toContain('\\(y^2\\)');
  });

  it('rejects unsafe structures and unknown interactive dependencies', () => {
    expect(parseMaicCourse('{"title":"x","width":1,"height":1,"slides":[]}').ok).toBe(false);
    const unsafe = transformMaicInteractiveHtml(
      '<!doctype html><html><head><script src="https://example.com/runtime.js"></script></head><body></body></html>',
      { pageId: 'page-1', sourceOrder: 1 },
    );
    expect(unsafe.ok).toBe(false);
    expect(unsafe.diagnostics.map((entry) => entry.code)).toContain(
      'maic.interactive.unknown_dependency',
    );
    const unsupportedKatex = transformMaicInteractiveHtml(
      '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/katex@0.15.6/dist/katex.min.js"></script></head><body></body></html>',
      { pageId: 'page-unsupported-katex', sourceOrder: 1 },
    );
    expect(unsupportedKatex.ok).toBe(false);
    expect(unsupportedKatex.diagnostics.map((entry) => entry.code)).toContain(
      'maic.interactive.unknown_dependency',
    );
    for (const html of [
      '<!doctype html><html><head></head><body><img src="data:image/png;base64,iVBORw0KGgo="></body></html>',
      '<!doctype html><html><head></head><body><img src="./local.png"></body></html>',
      '<!doctype html><html><head><style>.x{background:url(data:image/png;base64,iVBORw0KGgo=)}</style></head><body></body></html>',
    ]) {
      const embedded = transformMaicInteractiveHtml(html, {
        pageId: 'page-embedded',
        sourceOrder: 1,
      });
      expect(embedded.ok).toBe(false);
      expect(embedded.diagnostics.some((entry) => entry.severity === 'error')).toBe(true);
    }
  });

  it('rejects non-standard ports on the exact media allowlist host during parsing', () => {
    const portSource = structuredClone(source) as unknown as {
      slides: Array<{ elements?: Array<Record<string, unknown>> }>;
    };
    const image = portSource.slides[0]?.elements?.find((element) => element.type === 'image');
    if (!image) throw new Error('Expected image fixture.');
    image.src = 'https://file.maic.chat:8443/synthetic.png';

    const parsed = parseMaicCourse(JSON.stringify(portSource));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.capabilityReport.pageReports[0]).toMatchObject({ status: 'error' });
    expect(parsed.diagnostics.map((entry) => entry.code)).toContain(
      'maic.resource.url_not_allowed',
    );
  });

  it('accepts only the exact approved MAIC OSS hostname during parsing', () => {
    const approvedSource = structuredClone(source) as unknown as {
      slides: Array<{ elements?: Array<Record<string, unknown>> }>;
    };
    const image = approvedSource.slides[0]?.elements?.find((element) => element.type === 'image');
    if (!image) throw new Error('Expected image fixture.');
    image.src = 'https://maic-prod.oss-cn-wulanchabu.aliyuncs.com/synthetic.png';

    const approved = parseMaicCourse(JSON.stringify(approvedSource));
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.capabilityReport.pageReports[0]).toMatchObject({ status: 'ok' });
    expect(approved.ir.mediaReferences.map((reference) => reference.sourceUrl)).toContain(
      image.src,
    );

    for (const hostname of [
      'maic-prod.oss-cn-wulanchabu.aliyuncs.com.evil.test',
      'other.oss-cn-wulanchabu.aliyuncs.com',
    ]) {
      image.src = `https://${hostname}/synthetic.png`;
      const rejected = parseMaicCourse(JSON.stringify(approvedSource));
      expect(rejected.ok).toBe(true);
      if (!rejected.ok) continue;
      expect(rejected.diagnostics.map((entry) => entry.code)).toContain(
        'maic.resource.url_not_allowed',
      );
    }
  });

  it('registers a cover canvas background as collision-free page media', () => {
    const backgroundSource = structuredClone(source) as unknown as {
      slides: Array<{
        id: string;
        background?: unknown;
        elements?: Array<Record<string, unknown>>;
      }>;
    };
    const canvas = backgroundSource.slides[0]!;
    const backgroundUrl = 'https://file.maic.chat/shared.png';
    canvas.background = {
      type: 'image',
      image: { src: backgroundUrl, size: 'cover' },
    };
    canvas.elements = [
      {
        id: 'canvas-background',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        src: backgroundUrl,
      },
    ];

    const parsed = parseMaicCourse(JSON.stringify(backgroundSource));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const page = parsed.ir.pages.find((candidate) => candidate.id === canvas.id);
    expect(page?.kind).toBe('canvas');
    if (page?.kind !== 'canvas') return;
    const backgroundReference = parsed.ir.mediaReferences.find(
      (reference) => reference.id === page.backgroundMediaReferenceId,
    );
    const elementReference = parsed.ir.mediaReferences.find(
      (reference) => reference.elementId === 'canvas-background',
    );
    expect(backgroundReference).toMatchObject({
      sourceUrl: backgroundUrl,
      kind: 'image',
      pageId: canvas.id,
    });
    expect(backgroundReference?.elementId).toBeUndefined();
    expect(elementReference?.id).not.toBe(backgroundReference?.id);
  });

  it('rejects a disallowed cover background URL without registering it', () => {
    const backgroundSource = structuredClone(source) as unknown as {
      slides: Array<{ background?: unknown; elements?: Array<Record<string, unknown>> }>;
    };
    backgroundSource.slides[0]!.elements = [];
    backgroundSource.slides[0]!.background = {
      type: 'image',
      image: {
        src: 'https://maic-prod.oss-cn-wulanchabu.aliyuncs.com.evil.test/bg.png',
        size: 'cover',
      },
    };

    const parsed = parseMaicCourse(JSON.stringify(backgroundSource));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'maic.resource.url_not_allowed',
          severity: 'error',
          location: expect.objectContaining({ field: 'background' }),
        }),
      ]),
    );
    expect(parsed.ir.mediaReferences.map((reference) => reference.sourceUrl)).not.toContain(
      'https://maic-prod.oss-cn-wulanchabu.aliyuncs.com.evil.test/bg.png',
    );
    const mapped = mapMaicToReachDeckV2(parsed.ir, {
      documentId: 'invalid-background-url',
      applicationId: 'invalid-background-url',
      title: 'Invalid background URL',
      language: 'en-US',
      generatedAt: '2026-09-08T00:00:00Z',
      compatibilityTheme: theme,
      includePageIds: parsed.capabilityReport.pageReports
        .filter((report) => report.status !== 'error')
        .map((report) => report.pageId),
    });
    expect(mapped.ok).toBe(true);
    expect(mapped.diagnostics.map((entry) => entry.code)).not.toContain(
      'maic.canvas.background_degraded',
    );
  });
});
