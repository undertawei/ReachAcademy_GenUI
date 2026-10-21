'use client';

import { useEffect, useRef, useState } from 'react';

/** 规范 04 §3.2：导航开始 120ms 后才出现，导航在 120ms 内完成则不出现。 */
const SHOW_DELAY_MS = 120;

type Listener = () => void;
const startListeners = new Set<Listener>();

/**
 * 通知路由进度条「导航开始了」。站内链接点击会被自动识别；
 * 用 `router.push()` 等编程式导航时由调用方在跳转前调用。
 */
export function startRouteProgress() {
  for (const listener of startListeners) listener();
}

function isInternalNavigation(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return false;
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return false;
  const current = new URL(window.location.href);
  if (url.pathname === current.pathname && url.search === current.search) return false;
  return true;
}

export interface RouteProgressProps {
  /**
   * 当前路由标识（通常为 `usePathname()` 加查询串）。变化即视为导航完成。
   * 共享包不依赖 next，由各 app 传入。
   */
  routeKey: string;
}

type Phase = 'done' | 'idle' | 'running';

/**
 * 路由加载条：内容区顶部 2px `primary` 不定进度条，缓慢爬升到 80%，完成后走满并淡出。
 * 放在各 app 角色布局里（Header 下方），与 `template.tsx` + `PageTransition` 配合使用。
 */
export function RouteProgress({ routeKey }: RouteProgressProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const pending = useRef<number | undefined>(undefined);
  const started = useRef(false);
  const firstKey = useRef(routeKey);

  useEffect(() => {
    const onStart = () => {
      started.current = true;
      window.clearTimeout(pending.current);
      pending.current = window.setTimeout(() => {
        if (started.current) setPhase('running');
      }, SHOW_DELAY_MS);
    };
    const onClick = (event: MouseEvent) => {
      if (isInternalNavigation(event)) onStart();
    };
    startListeners.add(onStart);
    document.addEventListener('click', onClick);
    return () => {
      startListeners.delete(onStart);
      document.removeEventListener('click', onClick);
      window.clearTimeout(pending.current);
    };
  }, []);

  useEffect(() => {
    if (routeKey === firstKey.current) return;
    firstKey.current = routeKey;
    started.current = false;
    window.clearTimeout(pending.current);
    setPhase((current) => (current === 'running' ? 'done' : 'idle'));
  }, [routeKey]);

  if (phase === 'idle') return null;
  return (
    <div
      aria-hidden="true"
      className="rx-route-progress"
      data-state={phase}
      onAnimationEnd={(event) => {
        if (phase === 'done' && event.animationName === 'rx-route-progress-out') setPhase('idle');
      }}
    >
      <span className="rx-route-progress-bar" />
    </div>
  );
}
