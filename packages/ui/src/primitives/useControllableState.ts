'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * 受控/非受控统一（规范 03 §1.2）：传入 `value` 即受控，否则使用内部状态并以 `defaultValue` 初始化。
 * `onChange` 只在值真正变化时调用。
 */
export function useControllableState<T>({
  defaultValue,
  onChange,
  value,
}: {
  defaultValue: T | (() => T);
  onChange?: (value: T) => void;
  value?: T;
}): [T, (next: T | ((current: T) => T)) => void] {
  const [internal, setInternal] = useState<T>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? (value as T) : internal;
  const currentRef = useRef(current);
  currentRef.current = current;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setValue = useCallback(
    (next: T | ((current: T) => T)) => {
      const resolved =
        typeof next === 'function' ? (next as (current: T) => T)(currentRef.current) : next;
      if (Object.is(resolved, currentRef.current)) return;
      // 受控时不改 ref：父组件可能拒绝这次变更（不重新渲染），下一次同样的请求仍要通知到。
      if (!controlled) {
        setInternal(resolved);
        currentRef.current = resolved;
      }
      onChangeRef.current?.(resolved);
    },
    [controlled],
  );

  return [current, setValue];
}
