import type {
  ReachDeckMediaResourceV2,
  ReachDeckNativeSlideV2,
  ReachDeckScientificVisualElementV2,
  ReachDeckThemeResourceV2,
  ReachDeckDesignContext,
} from '@reachany/reach-deck-dsl';

/** Structural HTML contract violations are terminal; visual checks are diagnostics only. */
export class HtmlLayoutValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HtmlLayoutValidationError';
  }
}

export type ReportLayoutDiagnostic = (elementId: string, message: string) => void;

/** Shared across visual checks so a malformed page cannot flood developer evidence. */
export function createLayoutDiagnostics() {
  const diagnostics: string[] = [];
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const report: ReportLayoutDiagnostic = (elementId, message) => {
    const key = `${elementId}\n${message}`;
    const count = counts.get(elementId) ?? 0;
    if (diagnostics.length >= 100 || count >= 5 || seen.has(key)) return;
    seen.add(key);
    counts.set(elementId, count + 1);
    diagnostics.push(message.slice(0, 1800));
  };
  return { diagnostics, report };
}

export type HtmlLayoutAsset =
  | {
      kind: 'image';
      assetId: string;
      resource: ReachDeckMediaResourceV2;
      dataUrl: string;
      /** Host-only receipt for bounded code/GIF; never populated from model HTML. */
      codeAnimation?: { sourceDigest: string; frameCount: number };
      /** 宿主提供的失败媒体兜底始终按普通静态图片编译。 */
      isPlaceholder?: boolean;
      alt?: string;
    }
  | {
      kind: 'scientificVisual';
      assetId: string;
      element: ReachDeckScientificVisualElementV2;
      resources?: ReachDeckMediaResourceV2[];
    };

export interface CompileHtmlLayoutInput {
  html: string;
  pageId: string;
  themeName: string;
  designContext?: ReachDeckDesignContext;
  assets: readonly HtmlLayoutAsset[];
  signal?: AbortSignal;
  /** Local harness callback; never serialized into production artifacts. */
  onPreparedHtml?: (html: string) => void | Promise<void>;
}

export interface HtmlLayoutResult {
  slide: ReachDeckNativeSlideV2;
  resources: ReachDeckMediaResourceV2[];
  themes: ReachDeckThemeResourceV2[];
  pendingMedia: Array<{ resourceId: string; contentType: string; dataUrl: string }>;
  diagnostics: string[];
  elementIdMap: Record<string, string>;
  /** 图片素材绑定到规范化后的最终原生元素身份。 */
  assetBindings: HtmlLayoutAssetBinding[];
}

export interface HtmlLayoutAssetBinding {
  assetId: string;
  elementId: string;
  binding: 'image-element' | 'shape-fill';
}

export const HTML_LAYOUT_LIMITS = Object.freeze({
  htmlBytes: 1_048_576,
  domNodes: 2_000,
  imagePixels: 16_000_000,
  totalPixels: 64_000_000,
  nativeElements: 80,
  textElements: 40,
  mediaResources: 80,
  timeoutMs: 60_000,
});

export interface HtmlLayoutFontRun {
  family: string;
  text: string;
}
