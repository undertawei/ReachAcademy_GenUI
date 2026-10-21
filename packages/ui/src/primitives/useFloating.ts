'use client';

import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export type FloatingSide = 'bottom' | 'left' | 'right' | 'top';
export type FloatingAlign = 'center' | 'end' | 'start';
export type FloatingPlacement = FloatingSide | `${FloatingSide}-${'end' | 'start'}`;

export interface UseFloatingOptions {
  /** Keep the preferred side and shift into the viewport instead of flipping. */
  collision?: 'flip' | 'shift';
  anchor: RefObject<Element | null>;
  floating: RefObject<HTMLElement | null>;
  /** 固定宽度等于触发器（exact）、最小宽度等于触发器（min，默认）或不约束（none）。 */
  matchWidth?: 'exact' | 'min' | 'none';
  /** 纵向放置时的最大高度（规范 03 §3.4：320）。 */
  maxHeight?: number;
  /** 与触发器的间距（规范：4px）。 */
  offset?: number;
  open: boolean;
  placement?: FloatingPlacement;
  viewportPadding?: number;
}

export interface FloatingResult {
  /** 实际采用的方向与对齐（翻转后），写到 data-side / data-align 上供动效定原点。 */
  align: FloatingAlign;
  side: FloatingSide;
  style: CSSProperties;
  update: () => void;
}

interface Position {
  align: FloatingAlign;
  left: number;
  maxHeight?: number;
  minWidth?: number;
  side: FloatingSide;
  top: number;
  width?: number;
}

const MIN_USEFUL_SPACE = 160;

function parsePlacement(placement: FloatingPlacement): [FloatingSide, FloatingAlign] {
  const [side, align] = placement.split('-') as [FloatingSide, 'end' | 'start' | undefined];
  return [side, align ?? 'center'];
}

function viewportBox() {
  const visualViewport = window.visualViewport;
  const left = visualViewport?.offsetLeft ?? 0;
  const top = visualViewport?.offsetTop ?? 0;
  const width =
    visualViewport?.width ?? (document.documentElement.clientWidth || window.innerWidth);
  const height =
    visualViewport?.height ?? (document.documentElement.clientHeight || window.innerHeight);
  return { bottom: top + height, height, left, right: left + width, top, width };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/**
 * 基于 `position: fixed` 的锚点定位：空间不足时翻转到对侧，并跟随滚动、窗口与元素尺寸变化重新定位。
 * 返回的 style 只包含定位相关属性；浮层自身的外观由 CSS 决定。
 */
export function useFloating({
  collision = 'flip',
  anchor,
  floating,
  matchWidth = 'min',
  maxHeight,
  offset = 4,
  open,
  placement = 'bottom-start',
  viewportPadding = 8,
}: UseFloatingOptions): FloatingResult {
  const [position, setPosition] = useState<Position>();
  const [preferredSide, preferredAlign] = parsePlacement(placement);

  const update = useCallback(() => {
    const anchorElement = anchor.current;
    const floatingElement = floating.current;
    if (!anchorElement || !floatingElement || typeof window === 'undefined') return;

    const rect = anchorElement.getBoundingClientRect();
    const viewport = viewportBox();
    const contentWidth = Math.max(floatingElement.offsetWidth, floatingElement.scrollWidth);
    const contentHeight = Math.max(floatingElement.offsetHeight, floatingElement.scrollHeight);
    const width =
      matchWidth === 'exact'
        ? rect.width
        : matchWidth === 'min'
          ? Math.max(contentWidth, rect.width)
          : contentWidth;
    const boundedWidth = Math.min(width, viewport.width - viewportPadding * 2);

    let side = preferredSide;
    let left: number;
    let top: number;
    let resolvedMaxHeight: number | undefined;

    if (side === 'bottom' || side === 'top') {
      const below = viewport.bottom - viewportPadding - rect.bottom - offset;
      const above = rect.top - offset - (viewport.top + viewportPadding);
      const needed = Math.min(contentHeight, maxHeight ?? contentHeight, MIN_USEFUL_SPACE);
      if (collision === 'flip') {
        if (side === 'bottom' && below < needed && above > below) side = 'top';
        else if (side === 'top' && above < needed && below > above) side = 'bottom';
      }
      const available = Math.max(0, side === 'bottom' ? below : above);
      resolvedMaxHeight = Math.min(
        maxHeight ?? Number.POSITIVE_INFINITY,
        collision === 'shift' ? viewport.height - viewportPadding * 2 : available,
      );
      const height = Math.min(contentHeight, resolvedMaxHeight);
      top = side === 'bottom' ? rect.bottom + offset : rect.top - offset - height;
      if (collision === 'shift')
        top = clamp(
          top,
          viewport.top + viewportPadding,
          viewport.bottom - viewportPadding - height,
        );
      left =
        preferredAlign === 'start'
          ? rect.left
          : preferredAlign === 'end'
            ? rect.right - boundedWidth
            : rect.left + rect.width / 2 - boundedWidth / 2;
      left = clamp(
        left,
        viewport.left + viewportPadding,
        viewport.right - viewportPadding - boundedWidth,
      );
    } else {
      const right = viewport.right - viewportPadding - rect.right - offset;
      const leftSpace = rect.left - offset - (viewport.left + viewportPadding);
      if (side === 'right' && right < contentWidth && leftSpace > right) side = 'left';
      else if (side === 'left' && leftSpace < contentWidth && right > leftSpace) side = 'right';
      left = side === 'right' ? rect.right + offset : rect.left - offset - contentWidth;
      top =
        preferredAlign === 'start'
          ? rect.top
          : preferredAlign === 'end'
            ? rect.bottom - contentHeight
            : rect.top + rect.height / 2 - contentHeight / 2;
      top = clamp(
        top,
        viewport.top + viewportPadding,
        viewport.bottom - viewportPadding - contentHeight,
      );
    }

    const next: Position = {
      align: preferredAlign,
      left: Math.round(left),
      maxHeight:
        resolvedMaxHeight === undefined || !Number.isFinite(resolvedMaxHeight)
          ? undefined
          : Math.floor(resolvedMaxHeight),
      minWidth: matchWidth === 'min' ? Math.round(rect.width) : undefined,
      side,
      top: Math.round(top),
      width:
        matchWidth === 'exact'
          ? Math.round(collision === 'shift' ? boundedWidth : rect.width)
          : undefined,
    };
    setPosition((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.side === next.side &&
      current.maxHeight === next.maxHeight &&
      current.minWidth === next.minWidth &&
      current.width === next.width
        ? current
        : next,
    );
  }, [
    anchor,
    collision,
    floating,
    matchWidth,
    maxHeight,
    offset,
    preferredAlign,
    preferredSide,
    viewportPadding,
  ]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    update();
    const visualViewport = typeof window === 'undefined' ? undefined : window.visualViewport;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (anchor.current) observer?.observe(anchor.current);
    if (floating.current) observer?.observe(floating.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    visualViewport?.addEventListener('resize', update);
    visualViewport?.addEventListener('scroll', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      visualViewport?.removeEventListener('resize', update);
      visualViewport?.removeEventListener('scroll', update);
    };
  }, [anchor, floating, open, update]);

  return {
    align: position?.align ?? preferredAlign,
    side: position?.side ?? preferredSide,
    style: {
      left: position?.left ?? 0,
      maxHeight: position?.maxHeight,
      minWidth: position?.minWidth,
      position: 'fixed',
      top: position?.top ?? 0,
      visibility: position === undefined ? 'hidden' : undefined,
      width: position?.width,
    },
    update,
  };
}
