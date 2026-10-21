import type {
  DeckTheme,
  InteractiveRuntimeDependency,
  ReachDeckDocumentV2,
  ReachDeckFillV2,
  ReachDeckNativeElementV2,
} from '@reachany/reach-deck-dsl';
import type { PptxFontMetricsProvider } from '../pptx/style/text-fitting.js';

export type MaicDiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';
export type MaicPageKind = 'canvas' | 'quiz' | 'interactive';
export type MaicFeature =
  | 'document'
  | 'canvas'
  | 'text'
  | 'image'
  | 'shape'
  | 'line'
  | 'chart'
  | 'table'
  | 'audio'
  | 'narration'
  | 'quiz'
  | 'interactive'
  | 'resource';

export interface MaicDiagnosticLocation {
  pageId?: string;
  sourceOrder?: number;
  elementId?: string;
  field?: string;
}

/**
 * 诊断码命名空间。同一套 Interactive HTML 转换器同时服务 MAIC JSON 导入和教师直接上传的
 * 单文件 HTML，两条路径的诊断码前缀必须可区分，教师端展示时才能各自去品牌化。
 */
export type InteractiveTransformNamespace = 'maic' | 'html';

export interface InteractiveTransformDiagnostic<
  Namespace extends InteractiveTransformNamespace = InteractiveTransformNamespace,
> {
  code: `${Namespace}.${string}`;
  severity: MaicDiagnosticSeverity;
  feature: MaicFeature;
  message: string;
  location?: MaicDiagnosticLocation;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export type MaicDiagnostic = InteractiveTransformDiagnostic<'maic'>;

export interface MaicMediaReference {
  id: string;
  sourceUrl: string;
  kind: 'image' | 'audio';
  pageId: string;
  elementId?: string;
}

export interface MaicResolvedMedia {
  objectKey: string;
  contentType: string;
  digest: `sha256:${string}`;
}

export interface MaicElementIR {
  id: string;
  type: 'text' | 'image' | 'shape' | 'line' | 'table' | 'audio' | 'chart';
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
  source: Readonly<Record<string, unknown>>;
}

export interface MaicCanvasPageIR {
  id: string;
  sourceOrder: number;
  kind: 'canvas';
  width: number;
  height: number;
  background: unknown;
  backgroundMediaReferenceId?: string;
  elements: readonly MaicElementIR[];
  script?: string;
}

export interface MaicQuizPageIR {
  id: string;
  sourceOrder: number;
  kind: 'quiz';
  width: number;
  height: number;
  questions: readonly Readonly<Record<string, unknown>>[];
}

export interface MaicInteractivePageIR {
  id: string;
  sourceOrder: number;
  kind: 'interactive';
  width: number;
  height: number;
  title: string;
  html: string;
  transformedHtml?: string;
  runtimeDependencies: readonly InteractiveRuntimeDependency[];
}

export type MaicPageIR = MaicCanvasPageIR | MaicQuizPageIR | MaicInteractivePageIR;

export interface MaicCourseIR {
  schemaVersion: 'maic-course-ir/v1';
  sourceDigest: `sha256:${string}`;
  title: string;
  width: number;
  height: number;
  pages: readonly MaicPageIR[];
  mediaReferences: readonly MaicMediaReference[];
}

export interface MaicCapabilityEntry {
  feature: MaicFeature;
  status: 'native' | 'conditional' | 'unsupported';
  reason?: string;
}

export interface MaicCapabilityPageReport {
  pageId: string;
  sourceOrder: number;
  kind: MaicPageKind;
  status: 'ok' | 'warning' | 'error';
  diagnostics: readonly MaicDiagnostic[];
}

export interface MaicCapabilityReport {
  schemaVersion: 'maic-capability-report/v1';
  entries: readonly MaicCapabilityEntry[];
  diagnostics: readonly MaicDiagnostic[];
  pageReports: readonly MaicCapabilityPageReport[];
  /** At least one page can be imported. Error pages still require explicit degraded confirmation. */
  canApply: boolean;
}

export interface MaicParseSuccess {
  ok: true;
  ir: MaicCourseIR;
  diagnostics: readonly MaicDiagnostic[];
  capabilityReport: MaicCapabilityReport;
}

export interface MaicParseFailure {
  ok: false;
  diagnostics: readonly MaicDiagnostic[];
  capabilityReport: MaicCapabilityReport;
}

export type MaicParseResult = MaicParseSuccess | MaicParseFailure;

export interface MaicReachDeckV2MapperOptions {
  documentId: string;
  applicationId: string;
  title: string;
  language: string;
  generatedAt: string;
  compatibilityTheme: DeckTheme;
  media?: Readonly<Record<string, MaicResolvedMedia>>;
  /** Bundled-font measurements in native stage pixels; grows table rows without shrinking text. */
  tableFontMetrics?: PptxFontMetricsProvider;
  /** Exact source page ids approved for apply. Omit to include every non-error page. */
  includePageIds?: readonly string[];
}

export interface MaicReachDeckV2PageReport extends MaicCapabilityPageReport {
  mappedPageId?: string;
}

export interface MaicReachDeckV2MappingSuccess {
  ok: true;
  schemaVersion: 'maic-reach-deck-v2-mapping/v1';
  document: ReachDeckDocumentV2;
  pageReports: readonly MaicReachDeckV2PageReport[];
  diagnostics: readonly MaicDiagnostic[];
}

export interface MaicReachDeckV2MappingFailure {
  ok: false;
  schemaVersion: 'maic-reach-deck-v2-mapping/v1';
  diagnostics: readonly MaicDiagnostic[];
}

export type MaicReachDeckV2MappingResult =
  | MaicReachDeckV2MappingSuccess
  | MaicReachDeckV2MappingFailure;

export interface MaicMappedCanvasPage {
  background: ReachDeckFillV2;
  elements: ReachDeckNativeElementV2[];
}
