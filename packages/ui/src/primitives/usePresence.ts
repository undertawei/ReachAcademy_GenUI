'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

function parseTimes(value: string): number[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.endsWith('ms') ? parseFloat(part) : parseFloat(part) * 1000))
    .map((time) => (Number.isFinite(time) ? time : 0));
}

function longestMotion(style: CSSStyleDeclaration): number {
  const total = (durations: string, delays: string) => {
    const d = parseTimes(durations);
    const l = parseTimes(delays);
    return d.reduce((max, duration, index) => Math.max(max, duration + (l[index] ?? 0)), 0);
  };
  const animationName = style.animationName ?? '';
  const animation =
    animationName && animationName !== 'none'
      ? total(style.animationDuration ?? '', style.animationDelay ?? '')
      : 0;
  const transition = total(style.transitionDuration ?? '', style.transitionDelay ?? '');
  return Math.max(animation, transition);
}

export type PresenceState = 'open' | 'closed';

export interface Presence<T extends HTMLElement> {
  /** 是否应当渲染（打开中，或正在播放离场动画）。 */
  mounted: boolean;
  /** 绑定到播放进出场动画的元素上。 */
  ref: (node: T | null) => void;
  /** 写到 `data-state` 上驱动 CSS：打开为 open，离场动画期间为 closed。 */
  state: PresenceState;
}

/**
 * 「动画结束后再卸载」的 presence 工具（规范 04 §6）。
 *
 * `present` 变为 false 时先把 `state` 切到 `closed`（CSS 据此播放离场动画），
 * 等元素上的 animationend/transitionend（或按计算样式推得的时长兜底）后再卸载。
 * 没有动画（测试环境、减少动效）时立即卸载。业务代码不要自己写 setTimeout 卸载。
 */
export function usePresence<T extends HTMLElement = HTMLElement>(present: boolean): Presence<T> {
  const [previous, setPrevious] = useState(present);
  const [exiting, setExiting] = useState(false);
  const nodeRef = useRef<T | null>(null);

  if (previous !== present) {
    setPrevious(present);
    setExiting(!present);
  }

  useLayoutEffect(() => {
    if (!exiting) return;
    const node = nodeRef.current;
    const duration =
      node && typeof window !== 'undefined' ? longestMotion(window.getComputedStyle(node)) : 0;
    if (!node || duration <= 1) {
      setExiting(false);
      return;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setExiting(false);
    };
    const onEnd = (event: Event) => {
      if (event.target === node) finish();
    };
    node.addEventListener('animationend', onEnd);
    node.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(finish, duration + 50);
    return () => {
      node.removeEventListener('animationend', onEnd);
      node.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
    };
  }, [exiting]);

  const ref = useCallback((node: T | null) => {
    nodeRef.current = node;
  }, []);

  return { mounted: present || exiting, ref, state: present ? 'open' : 'closed' };
}
