import {
  parseReachScientificVisualPayloadV1,
  type ReachDeckMediaResourceV2,
} from '@reachany/reach-deck-dsl';

import type { GeneratedScientificVisualOutput } from './scientific-generation-validation.js';

export interface ReachDeckScientificVisualPlacementManifest {
  assetId: string;
  kind: 'scientific-visual';
  purpose: string;
  alt: string;
  aspectRatio: '16:9' | '4:3' | '1:1' | '3:4';
  placement: 'hero' | 'primary' | 'supporting';
}

export interface ReachDeckResolvedScientificVisualAsset {
  manifest: ReachDeckScientificVisualPlacementManifest;
  generated: GeneratedScientificVisualOutput;
  /** 复用原生科学组件时保留图位身份和它引用的资源。 */
  mediaSlot?: { attempt: number; teacherReplaced?: true };
  resources?: ReachDeckMediaResourceV2[];
}

/**
 * Replaces layout-only scientific asset references with the complete validated durable payload.
 * The layout model never receives HTML, manifest internals, or object keys.
 */
export function bindResolvedSlideScientificVisualAssets(
  slide: unknown,
  bindings: readonly ReachDeckResolvedScientificVisualAsset[],
): unknown {
  if (bindings.length > 1) {
    throw new Error('A generated slide may bind at most one scientific visual asset.');
  }
  if (typeof slide !== 'object' || slide === null || Array.isArray(slide)) return slide;
  const record = slide as Record<string, unknown>;
  if (!Array.isArray(record.elements)) return slide;

  const byAssetId = new Map(bindings.map((binding) => [binding.manifest.assetId, binding]));
  const useCounts = new Map<string, number>();
  const elements = record.elements.map((element) => {
    if (
      typeof element !== 'object' ||
      element === null ||
      Array.isArray(element) ||
      (element as Record<string, unknown>).type !== 'scientificVisual'
    ) {
      return element;
    }
    const placeholder = element as Record<string, unknown>;
    for (const forbidden of [
      'documentHtml',
      'manifest',
      'mediaResources',
      'objectKey',
      'src',
      'url',
    ]) {
      if (Object.hasOwn(placeholder, forbidden)) {
        throw new Error(
          `Generated scientificVisual placement cannot supply server-owned ${forbidden}.`,
        );
      }
    }
    const assetId = placeholder.assetId;
    if (typeof assetId !== 'string' || !byAssetId.has(assetId)) {
      throw new Error('Generated slide references an unknown scientific visual assetId.');
    }
    const count = (useCounts.get(assetId) ?? 0) + 1;
    if (count > 1) {
      throw new Error(
        `Generated slide references scientific visual assetId ${assetId} more than once.`,
      );
    }
    useCounts.set(assetId, count);
    const binding = byAssetId.get(assetId)!;
    const payload = parseReachScientificVisualPayloadV1({
      documentHtml: binding.generated.documentHtml,
      manifest: binding.generated.manifest,
      mediaResources: [],
    });
    const { assetId: _assetId, ariaLabel: _modelAriaLabel, ...placement } = placeholder;
    return {
      ...placement,
      ariaLabel: payload.manifest.ariaLabel,
      ...payload,
    };
  });

  const unused = bindings
    .map((binding) => binding.manifest.assetId)
    .filter((assetId) => useCounts.get(assetId) !== 1);
  if (unused.length > 0) {
    throw new Error(
      `Generated slide did not use resolved scientific visual assets exactly once: ${unused.join(', ')}`,
    );
  }
  return { ...record, elements };
}
