/**
 * 教师直接上传单文件 Interactive HTML 的转换器版本。与 `MAIC_IMPORTER_VERSION` 分开演进：
 * 两条路径共用转换实现，但各自的候选摘要必须能独立失效。
 */
export const INTERACTIVE_HTML_IMPORTER_VERSION = '0.1.0';

export const INTERACTIVE_HTML_IMPORT_LIMITS = Object.freeze({
  /** 源文件上限。与 `INTERACTIVE_DOCUMENT_MAX_BYTES` 和转换后上限一致。 */
  maxSourceBytes: 512 * 1024,
});
