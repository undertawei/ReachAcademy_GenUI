import { createHash } from 'node:crypto';
import type { ReachDeckNativeElementV2 } from '@reachany/reach-deck-dsl';

/** 原地替换科学内容时保留教师的通用属性，排除旧图片专属字段和旧内容的无障碍标签。 */
export function scientificMediaElementProperties(element: ReachDeckNativeElementV2) {
  return {
    id: element.id,
    transform: element.transform,
    zIndex: element.zIndex,
    name: element.name,
    hidden: element.hidden,
    opacity: element.opacity,
    source: element.source,
    locked: element.type === 'scientificVisual' ? element.locked : undefined,
  };
}

/** 图位摘要只包含科学内容，移动或缩放元素不会被误认作教师替换。 */
export function scientificMediaContentDigest(content: {
  documentHtml: string;
  manifest: unknown;
}): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : value;
  return createHash('sha256')
    .update(
      JSON.stringify(canonical({ documentHtml: content.documentHtml, manifest: content.manifest })),
    )
    .digest('hex');
}
