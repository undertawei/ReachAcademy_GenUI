import type { ReachDeckNativeSlideV2 } from './nativeV2.js';

/** 收集一页全部媒体资源身份，包含组合、各类图片填充和科学组件清单。 */
export function collectReachDeckNativeSlideResourceIds(slide: ReachDeckNativeSlideV2): string[] {
  const resourceIds = new Set<string>();
  const visitFill = (fill: typeof slide.background | undefined) => {
    if (fill?.kind === 'image') resourceIds.add(fill.resourceId);
  };
  visitFill(slide.background);
  const visitElement = (element: (typeof slide.elements)[number]): void => {
    if (element.type === 'group') element.children.forEach(visitElement);
    if (element.type === 'shape' || element.type === 'textFrame') visitFill(element.style?.fill);
    if (element.type === 'table')
      element.rows.forEach((row) => row.cells.forEach((cell) => visitFill(cell.style.fill)));
    if (element.type === 'diagram') element.nodes.forEach((node) => visitFill(node.style.fill));
    if (element.type === 'scientificVisual')
      element.manifest.resourceIds.forEach((resourceId) => resourceIds.add(resourceId));
    if (element.type === 'image' || element.type === 'audio' || element.type === 'video') {
      resourceIds.add(element.resourceId);
    }
    if (element.type === 'video' && element.posterResourceId) {
      resourceIds.add(element.posterResourceId);
    }
  };
  slide.elements.forEach(visitElement);
  if (slide.narration?.audioResourceId) resourceIds.add(slide.narration.audioResourceId);
  return [...resourceIds];
}
