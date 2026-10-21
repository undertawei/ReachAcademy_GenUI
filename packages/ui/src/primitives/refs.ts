import type { MutableRefObject, Ref, RefCallback } from 'react';

/** 把多个 ref（对象或回调）合成一个回调 ref，用于组件内部 ref 与调用方透传 ref 并存。 */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as MutableRefObject<T | null>).current = node;
    }
  };
}
