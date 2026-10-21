import type {
  ReachDeckAnimationV2,
  ReachDeckNativeElementV2,
  ReachDeckNativeSlideV2,
} from './nativeV2.js';

/** 幻灯片上全部元素 id（含 group 子元素），用于判定动画目标是否仍存在。 */
export function collectReachDeckNativeElementIds(
  elements: readonly ReachDeckNativeElementV2[],
): Set<string> {
  const ids = new Set<string>();
  const visit = (items: readonly ReachDeckNativeElementV2[]) => {
    for (const element of items) {
      ids.add(element.id);
      if (element.type === 'group') visit(element.children);
    }
  };
  visit(elements);
  return ids;
}

/**
 * 目标元素已不存在的动画（孤儿动画）的 id。
 *
 * 孤儿动画允许保存、发布与渲染：播放时忽略，编辑器时间轴标红提示教师处理；
 * 不再像过去那样让整份文档校验失败、保存被拒绝。
 */
export function reachDeckOrphanAnimationIds(
  slide: Pick<ReachDeckNativeSlideV2, 'animations' | 'elements'>,
): Set<string> {
  const elementIds = collectReachDeckNativeElementIds(slide.elements);
  return new Set(
    slide.animations
      .filter((animation) => !elementIds.has(animation.targetId))
      .map((animation) => animation.id),
  );
}

/** 播放时真正生效的动画：剔除孤儿动画。 */
export function reachDeckPlayableAnimations(
  slide: Pick<ReachDeckNativeSlideV2, 'animations' | 'elements'>,
): ReachDeckAnimationV2[] {
  const elementIds = collectReachDeckNativeElementIds(slide.elements);
  return slide.animations.filter((animation) => elementIds.has(animation.targetId));
}
