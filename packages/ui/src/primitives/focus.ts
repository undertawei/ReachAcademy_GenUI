'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      !element.closest('[hidden], [inert]') &&
      isRendered(element, container),
  );
}

// 响应式布局可能通过 CSS 而非 hidden 属性隐藏整组控件。
function isRendered(element: HTMLElement, container: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (current === container) break;
  }
  return true;
}

export type InitialFocus = RefObject<HTMLElement | null> | 'container' | 'first-field';

export interface UseFocusTrapOptions {
  active: boolean;
  container: RefObject<HTMLElement | null>;
  /**
   * 打开后聚焦谁：传 ref 聚焦该元素；`first-field` 聚焦第一个可输入控件（找不到则第一个可聚焦元素，
   * 规范 03 §3.15）；`container` 聚焦容器本身。默认 `first-field`。
   */
  initialFocus?: InitialFocus;
  /** 关闭后把焦点还给打开前的元素（规范 03 §1.5），默认 true。 */
  returnFocus?: boolean;
  returnFocusTarget?: RefObject<HTMLElement | null>;
}

/** 模态浮层的焦点陷阱：Tab/Shift+Tab 在容器内循环，打开时移入焦点，关闭时归还。 */
export function useFocusTrap({
  active,
  container,
  initialFocus = 'first-field',
  returnFocus = true,
  returnFocusTarget,
}: UseFocusTrapOptions) {
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;

  useEffect(() => {
    if (!active) return;
    const node = container.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target = initialFocusRef.current;
    const focusInitial = () => {
      if (node.contains(document.activeElement) && document.activeElement !== node) return;
      if (typeof target === 'object' && target.current) {
        target.current.focus({ preventScroll: true });
        return;
      }
      if (target === 'first-field') {
        const focusable = getFocusableElements(node);
        const field = focusable.find((element) =>
          element.matches('input, textarea, select, [contenteditable="true"], [role="combobox"]'),
        );
        const next = field ?? focusable[0];
        if (next) {
          next.focus({ preventScroll: true });
          return;
        }
      }
      if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
      node.focus({ preventScroll: true });
    };
    focusInitial();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements(node);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      const restore = returnFocusTarget?.current ?? previous;
      if (returnFocus && restore?.isConnected) restore.focus({ preventScroll: true });
    };
  }, [active, container, returnFocus, returnFocusTarget]);
}
