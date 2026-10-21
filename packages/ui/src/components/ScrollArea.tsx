'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type UIEvent,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';

/** 规范 02 §5：滚动停止 800ms 后滚动条淡出。 */
const SCROLL_IDLE_MS = 800;
const RESTORE_PREFIX = 'reachany:scroll:';

export type ScrollAreaProps = HTMLAttributes<HTMLDivElement> & {
  /** 两端渐隐遮罩（规范 02 S5），用于横向条带：周历、看板、宽表格、标签列表。 */
  fade?: boolean;
  /** 隐藏滚动条但保留滚动（仅用于有其他溢出提示的横向条带）。 */
  hideScrollbar?: boolean;
  orientation?: 'both' | 'horizontal' | 'vertical';
  /**
   * 设置后按该键把滚动位置存进 sessionStorage，并在重新挂载时恢复（规范 02 S8：从详情返回列表）。
   * 切换筛选/Tab 需要回到顶部时，换一个 key 或调用 `element.scrollTo({ top: 0 })`。
   */
  restoreKey?: string;
};

/**
 * 滚动容器（规范 02 §4 S2）：细滚动条、悬停或滚动中才显形、`scrollbar-gutter: stable`、
 * `overscroll-behavior: contain`。页面里每一列最多一个主滚动容器。
 */
export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  {
    className,
    fade = false,
    hideScrollbar = false,
    onScroll,
    orientation = 'vertical',
    restoreKey,
    ...props
  },
  ref,
) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);

  const updateOverflow = useCallback(() => {
    const node = nodeRef.current;
    if (!node || !fade) return;
    const horizontal = orientation === 'horizontal';
    const start = horizontal ? node.scrollLeft : node.scrollTop;
    const size = horizontal ? node.clientWidth : node.clientHeight;
    const total = horizontal ? node.scrollWidth : node.scrollHeight;
    node.toggleAttribute('data-overflow-start', start > 1);
    node.toggleAttribute('data-overflow-end', start + size < total - 1);
  }, [fade, orientation]);

  const savePosition = useCallback(() => {
    const node = nodeRef.current;
    if (!node || !restoreKey) return;
    try {
      window.sessionStorage.setItem(
        RESTORE_PREFIX + restoreKey,
        JSON.stringify({ left: node.scrollLeft, top: node.scrollTop }),
      );
    } catch {
      // 忽略写入失败（隐私模式、配额）。
    }
  }, [restoreKey]);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node || !restoreKey) return;
    try {
      const saved = window.sessionStorage.getItem(RESTORE_PREFIX + restoreKey);
      if (saved) {
        const { left, top } = JSON.parse(saved) as { left: number; top: number };
        node.scrollLeft = left;
        node.scrollTop = top;
      }
    } catch {
      // sessionStorage 不可用时忽略恢复。
    }
    return savePosition;
  }, [restoreKey, savePosition]);

  useEffect(() => {
    updateOverflow();
    const node = nodeRef.current;
    if (!node || !fade || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fade, updateOverflow]);

  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    onScroll?.(event);
    const node = event.currentTarget;
    node.setAttribute('data-scrolling', '');
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      node.removeAttribute('data-scrolling');
      savePosition();
    }, SCROLL_IDLE_MS);
    updateOverflow();
  };

  return (
    <div
      className={cn(
        hideScrollbar
          ? 'rx-scroll-hidden'
          : orientation === 'horizontal'
            ? 'rx-scroll-x'
            : orientation === 'vertical'
              ? 'rx-scroll-y'
              : 'rx-scroll',
        fade && 'rx-scroll-fade',
        'rx-scroll-area',
        className,
      )}
      onScroll={handleScroll}
      ref={mergeRefs(ref, nodeRef)}
      {...props}
    />
  );
});
