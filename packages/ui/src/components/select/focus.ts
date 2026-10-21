import { getFocusableElements } from '../../primitives/focus';

/**
 * 把焦点移到 `from` 之后（或之前）的下一个可 Tab 聚焦的元素，跳过 `exclude` 内的元素。
 * 用于浮层内的搜索框按 Tab 时「关闭并移到下一个控件」（规范 03 §3.5）。
 * 找到目标返回 true（调用方应 preventDefault），否则返回 false。
 */
export function focusAdjacent(
  from: HTMLElement,
  direction: 1 | -1,
  exclude: HTMLElement | null,
): boolean {
  if (typeof document === 'undefined') return false;
  const candidates = getFocusableElements(document.body).filter(
    (element) =>
      element === from || (element.tabIndex >= 0 && !(exclude?.contains(element) ?? false)),
  );
  const index = candidates.indexOf(from);
  if (index < 0) return false;
  const target = candidates[index + direction];
  if (!target) return false;
  target.focus();
  return true;
}
