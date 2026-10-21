import { createHash } from 'node:crypto';

import type { InteractiveRuntimeDependency } from '@reachany/reach-deck-dsl';

import { transformInteractiveHtml } from '../maic/interactive.js';
import type { InteractiveTransformDiagnostic } from '../maic/types.js';

import { INTERACTIVE_HTML_IMPORT_LIMITS, INTERACTIVE_HTML_IMPORTER_VERSION } from './version.js';

export * from './version.js';
export type { InteractiveTransformDiagnostic } from '../maic/types.js';

export type InteractiveHtmlDiagnostic = InteractiveTransformDiagnostic<'html'>;
export type InteractiveHtmlSourceDigest = `sha256:${string}`;

export interface InteractiveHtmlTransformSuccess {
  ok: true;
  importerVersion: string;
  sourceDigest: InteractiveHtmlSourceDigest;
  /** 净化并内联内置运行时后的自包含文档。 */
  html: string;
  runtimeDependencies: readonly InteractiveRuntimeDependency[];
  diagnostics: readonly InteractiveHtmlDiagnostic[];
}

export interface InteractiveHtmlTransformFailure {
  ok: false;
  importerVersion: string;
  sourceDigest: InteractiveHtmlSourceDigest;
  diagnostics: readonly InteractiveHtmlDiagnostic[];
}

export type InteractiveHtmlTransformResult =
  | InteractiveHtmlTransformSuccess
  | InteractiveHtmlTransformFailure;

const diagnostic = (
  suffix: string,
  message: string,
  severity: InteractiveHtmlDiagnostic['severity'] = 'error',
): InteractiveHtmlDiagnostic => ({
  code: `html.interactive.${suffix}`,
  severity,
  feature: 'interactive',
  message,
});

const sourceDigestOf = (bytes: Uint8Array): InteractiveHtmlSourceDigest =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * 严格 UTF-8 解码并去掉 BOM。教师的 agent 可能产出 GBK 或带 BOM 的文件，前者必须明确报错而不是
 * 静默产生乱码页面。
 */
const decodeUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
};

/**
 * 把教师上传的单个 HTML 文件转换成平台可离线运行的 Interactive 文档。
 *
 * 净化、内置库（Tailwind / KaTeX / three.js）替换与静态审计完全复用 MAIC 导入的
 * {@link transformInteractiveHtml}；这里只负责字节层面的解码、尺寸闸与摘要。
 */
export const transformUploadedInteractiveHtml = (
  bytes: Uint8Array,
): InteractiveHtmlTransformResult => {
  const sourceDigest = sourceDigestOf(bytes);
  const failure = (
    diagnostics: readonly InteractiveHtmlDiagnostic[],
  ): InteractiveHtmlTransformFailure => ({
    ok: false,
    importerVersion: INTERACTIVE_HTML_IMPORTER_VERSION,
    sourceDigest,
    diagnostics,
  });

  if (bytes.byteLength === 0) {
    return failure([diagnostic('empty_source', 'The uploaded HTML file is empty.')]);
  }
  if (bytes.byteLength > INTERACTIVE_HTML_IMPORT_LIMITS.maxSourceBytes) {
    return failure([diagnostic('document_too_large', 'Interactive HTML exceeds 512 KiB.')]);
  }
  const html = decodeUtf8(bytes);
  if (html === undefined) {
    return failure([
      diagnostic('invalid_encoding', 'The uploaded HTML file must be encoded as UTF-8.'),
    ]);
  }
  if (html.trim().length === 0) {
    return failure([diagnostic('empty_source', 'The uploaded HTML file is empty.')]);
  }

  const transformed = transformInteractiveHtml(html, {}, 'html');
  if (!transformed.ok || transformed.html === undefined) {
    return failure(transformed.diagnostics);
  }
  return {
    ok: true,
    importerVersion: INTERACTIVE_HTML_IMPORTER_VERSION,
    sourceDigest,
    html: transformed.html,
    runtimeDependencies: transformed.runtimeDependencies,
    diagnostics: transformed.diagnostics,
  };
};
