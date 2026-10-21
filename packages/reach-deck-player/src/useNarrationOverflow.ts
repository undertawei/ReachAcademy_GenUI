'use client';

import { useEffect, useState } from 'react';

/** Only add a keyboard stop when the narration actually needs scrolling. */
export function useNarrationOverflow(enabled: boolean, text: string) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!enabled || element === null) {
      setOverflowing(false);
      return;
    }
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight);
    // 换到下一句讲稿时回到开头，不沿用上一句滚到的位置。
    element.scrollTop = 0;
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [element, enabled, text]);

  return { ref: setElement, overflowing: enabled && overflowing };
}
