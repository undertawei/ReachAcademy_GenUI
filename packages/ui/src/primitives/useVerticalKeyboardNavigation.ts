'use client';

import { useCallback, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { isInTopmostLayer } from './layer';

// Native controls and ARIA composites retain their own arrow-key behavior. A host can mark
// another surface (for example, a scrollable transcript) without depending on its markup.
const OWN_ARROW_KEYS = [
  'input',
  'textarea',
  'select',
  'option',
  'iframe',
  'video',
  'audio',
  'summary',
  'fieldset',
  '[contenteditable]:not([contenteditable="false"])',
  '[data-vertical-navigation-ignore]',
  '[aria-haspopup]',
  ...[
    'textbox',
    'searchbox',
    'slider',
    'spinbutton',
    'scrollbar',
    'combobox',
    'listbox',
    'option',
    'menu',
    'menubar',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tree',
    'treeitem',
    'grid',
    'gridcell',
    'tablist',
    'tab',
    'radiogroup',
    'radio',
    'checkbox',
    'switch',
  ].map((role) => `[role="${role}"]`),
].join(',');
const FOCUSABLE = 'button, a[href], input, textarea, select, iframe, [tabindex], [contenteditable]';

export interface VerticalKeyboardNavigationOptions {
  /** The focus boundary that opts in; portalled descendants outside it are excluded. */
  root: RefObject<HTMLElement | null>;
  enabled?: boolean;
  locked?: boolean;
  /** Reuse the host's manual navigation path, including its boundary checks. */
  onNavigate: (direction: -1 | 1) => void;
}

/** Opt-in ↑/↓ navigation for a focusable surface, below controls and active overlays. */
export function useVerticalKeyboardNavigation({
  root,
  enabled = true,
  locked = false,
  onNavigate,
}: VerticalKeyboardNavigationOptions) {
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const surface = root.current;
      const target = event.target;
      if (
        !enabled ||
        locked ||
        event.defaultPrevented ||
        (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') ||
        event.nativeEvent.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !surface ||
        !(target instanceof Element) ||
        !surface.contains(target) ||
        surface.closest('[inert], [aria-hidden="true"]') ||
        !isInTopmostLayer(surface) ||
        target.closest(OWN_ARROW_KEYS)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      onNavigate(event.key === 'ArrowUp' ? -1 : 1);
    },
    [enabled, locked, onNavigate, root],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const surface = root.current;
      const target = event.target;
      if (
        !enabled ||
        event.defaultPrevented ||
        event.button !== 0 ||
        !surface ||
        !(target instanceof Element) ||
        !surface.contains(target) ||
        !isInTopmostLayer(surface) ||
        target.closest(OWN_ARROW_KEYS)
      )
        return;
      const focusable = target.closest(FOCUSABLE);
      if (focusable && focusable !== surface) return;
      surface.focus({ preventScroll: true });
    },
    [enabled, root],
  );

  return { onKeyDown, onPointerDown };
}
