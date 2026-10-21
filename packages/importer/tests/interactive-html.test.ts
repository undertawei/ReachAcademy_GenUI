import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  INTERACTIVE_HTML_IMPORTER_VERSION,
  transformUploadedInteractiveHtml,
} from '../src/interactive-html/index.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const document = (body: string, head = '', htmlAttributes = ''): string =>
  `<!doctype html><html lang="zh-CN"${htmlAttributes}><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;

const codes = (result: { diagnostics: readonly { code: string }[] }): string[] =>
  result.diagnostics.map(({ code }) => code);

describe('transformUploadedInteractiveHtml', () => {
  it('accepts a self-contained document and reports no runtime dependency', () => {
    const result = transformUploadedInteractiveHtml(
      encode(
        document('<main><button id="go">go</button></main><script>document.title="x"</script>'),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.importerVersion).toBe(INTERACTIVE_HTML_IMPORTER_VERSION);
    expect(result.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.runtimeDependencies).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    // 平台负责注入激活脚本，教师的页面不写也能进入 active 阶段。
    expect(result.html).toContain('window.ReachInteractive.ready()');
  });

  it('emits html-namespaced diagnostic codes instead of maic ones', () => {
    const result = transformUploadedInteractiveHtml(
      encode(document('<main></main><script src="https://unpkg.com/x.js"></script>')),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('html.interactive.unknown_dependency');
    expect(codes(result).every((code) => code.startsWith('html.'))).toBe(true);
  });

  it('converts the Tailwind Play CDN into the platform runtime with a version warning', () => {
    const result = transformUploadedInteractiveHtml(
      encode(
        document(
          '<main class="flex items-center">x</main>',
          '<script src="https://cdn.tailwindcss.com"></script>',
        ),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtimeDependencies).toEqual([{ id: 'tailwind-browser', version: '4.3.0' }]);
    expect(result.html).toContain('data-reach-tailwind-runtime="4.3.0"');
    expect(result.html).not.toContain('cdn.tailwindcss.com');
    expect(codes(result)).toEqual(['html.interactive.tailwind_version_replacement']);
    // 上传路径的警告不提 MAIC。
    expect(result.diagnostics[0]?.message).not.toContain('MAIC');
    expect(result.diagnostics[0]?.message).toContain('Tailwind Play CDN');
  });

  it('converts a three.js import map into the platform three runtime', () => {
    const result = transformUploadedInteractiveHtml(
      encode(
        document(
          '<main></main><script type="module">import * as THREE from "three";new THREE.Scene()</script>',
          '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/"}}</script>',
        ),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtimeDependencies).toEqual([{ id: 'three-module', version: '0.185.1' }]);
    expect(result.html).toContain('data-reach-three-runtime="0.185.1"');
    expect(result.html).not.toContain('importmap');
    expect(codes(result)).toEqual(['html.interactive.three_version_replacement']);
    expect(result.diagnostics[0]?.message).not.toContain('MAIC');
  });

  it('rejects a document that writes a reserved platform runtime marker itself', () => {
    const result = transformUploadedInteractiveHtml(
      encode(document('<main></main>', '', ' data-reach-tailwind-runtime="4.3.0"')),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('html.interactive.tailwind_marker_reserved');
  });

  it.each([
    ['<main></main><script>fetch("/x")</script>', 'html.interactive.unsafe_script_api'],
    ['<iframe></iframe>', 'html.interactive.forbidden_tag'],
    ['<img src="https://example.com/a.png">', 'html.interactive.external_url'],
    [
      '<main></main><style>@import url("https://example.com/a.css");</style>',
      'html.interactive.external_css',
    ],
  ])('rejects unsafe source %#', (body, expected) => {
    const result = transformUploadedInteractiveHtml(encode(document(body)));

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(expected);
  });

  it('rejects an empty upload', () => {
    expect(codes(transformUploadedInteractiveHtml(new Uint8Array()))).toEqual([
      'html.interactive.empty_source',
    ]);
    expect(codes(transformUploadedInteractiveHtml(encode('   \n')))).toEqual([
      'html.interactive.empty_source',
    ]);
  });

  it('rejects a source that is not valid UTF-8', () => {
    // GBK 的“中” = 0xD6 0xD0，在 UTF-8 里是非法序列。
    const bytes = new Uint8Array([
      ...encode('<!doctype html><html><head><title>'),
      0xd6,
      0xd0,
      ...encode('</title></head><body></body></html>'),
    ]);

    expect(codes(transformUploadedInteractiveHtml(bytes))).toEqual([
      'html.interactive.invalid_encoding',
    ]);
  });

  it('strips a UTF-8 BOM instead of rejecting the file', () => {
    const result = transformUploadedInteractiveHtml(encode(`﻿${document('<main>x</main>')}`));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html.startsWith('﻿')).toBe(false);
  });

  it('rejects a source above 512 KiB before parsing it', () => {
    const padded = document(`<main>${'x'.repeat(512 * 1024)}</main>`);

    expect(codes(transformUploadedInteractiveHtml(encode(padded)))).toEqual([
      'html.interactive.document_too_large',
    ]);
  });

  it('produces a deterministic digest and output for identical bytes', () => {
    const bytes = encode(document('<main class="flex">x</main>'));
    const first = transformUploadedInteractiveHtml(bytes);
    const second = transformUploadedInteractiveHtml(bytes);

    expect(first).toEqual(second);
  });
});

/**
 * 教师把 `docs/reach-deck/interactive-html-authoring.md` 交给自己的 AI 助手，助手多半直接改这两个
 * 模板。它们必须原样通过门禁，否则规范就是错的。
 */
describe('authoring spec templates', () => {
  // Windows 上 core.autocrlf 会把 checkout 出来的文档改成 CRLF；归一化行尾，
  // 否则围栏匹配和模板内容都会随平台漂移。
  const markdown = readFileSync(
    new URL('../../../docs/reach-deck/interactive-html-authoring.md', import.meta.url),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const templates = [...markdown.matchAll(/```html\n([\s\S]*?)\n```/g)]
    .map((match) => match[1]!)
    .filter((block) => block.trimStart().toLowerCase().startsWith('<!doctype html>'));

  it('ships exactly the plain-CSS and Tailwind templates', () => {
    expect(templates).toHaveLength(2);
  });

  it.each([0, 1])('template %i uploads unchanged with no blocking diagnostic', (index) => {
    const result = transformUploadedInteractiveHtml(encode(templates[index]!));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.diagnostics.filter(({ severity }) => severity === 'error' || severity === 'fatal'),
    ).toEqual([]);
    // 平台注入激活脚本，模板自己不写也能进入运行态。
    expect(result.html).toContain('window.ReachInteractive.ready()');
    // 转换后不能残留任何绝对 URL——内置库的 CDN 引用应当已被替换掉。
    expect(result.html).not.toMatch(/https?:\/\//);
  });

  it('converts the Tailwind template to the platform runtime with only a version warning', () => {
    const result = transformUploadedInteractiveHtml(encode(templates[1]!));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtimeDependencies).toEqual([{ id: 'tailwind-browser', version: '4.3.0' }]);
    expect(codes(result)).toEqual(['html.interactive.tailwind_version_replacement']);
  });
});
