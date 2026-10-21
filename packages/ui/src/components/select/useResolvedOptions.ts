'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type { SelectOption } from './types';

/**
 * 已选值 → 选项（含标签）。查找顺序：已加载的选项 → 调用方传入的 selectedOptions →
 * resolveOptions 异步换取的结果。换取中的值不显示任何文字，绝不显示裸 ID（规范 03 §3.5）。
 * 每个值只换取一次（失败也不自动重试，避免请求风暴）。
 */
export function useResolvedOptions<Value extends string>({
  known,
  provided,
  resolveOptions,
  values,
}: {
  known: Map<Value, SelectOption<Value>>;
  provided?: readonly SelectOption<Value>[];
  resolveOptions?: (values: Value[]) => Promise<readonly SelectOption<Value>[]>;
  values: readonly Value[];
}): { lookup: (value: Value) => SelectOption<Value> | undefined; pending: boolean } {
  const [resolved, setResolved] = useState(() => new Map<Value, SelectOption<Value>>());
  const [pendingCount, setPendingCount] = useState(0);
  const requested = useRef(new Set<Value>());
  const mounted = useRef(true);
  const resolveRef = useRef(resolveOptions);
  resolveRef.current = resolveOptions;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const lookup = useMemo(() => {
    const providedMap = new Map<Value, SelectOption<Value>>();
    provided?.forEach((option) => providedMap.set(option.value, option));
    return (value: Value) => known.get(value) ?? providedMap.get(value) ?? resolved.get(value);
  }, [known, provided, resolved]);

  const missingKey =
    resolveOptions === undefined
      ? ''
      : values
          .filter((value) => lookup(value) === undefined && !requested.current.has(value))
          .join('\u0000');

  useEffect(() => {
    const resolve = resolveRef.current;
    if (!resolve || missingKey === '') return;
    const missing = (missingKey.split('\u0000') as Value[]).filter(
      (value) => !requested.current.has(value),
    );
    if (missing.length === 0) return;
    missing.forEach((value) => requested.current.add(value));
    setPendingCount((count) => count + 1);
    let promise: Promise<readonly SelectOption<Value>[]>;
    try {
      promise = Promise.resolve(resolve(missing));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise
      .then(
        (options) => {
          if (!mounted.current) return;
          setResolved((current) => {
            const next = new Map(current);
            options.forEach((option) => next.set(option.value, option));
            return next;
          });
        },
        () => undefined,
      )
      .finally(() => {
        if (mounted.current) setPendingCount((count) => Math.max(0, count - 1));
      });
  }, [missingKey]);

  return { lookup, pending: pendingCount > 0 };
}
