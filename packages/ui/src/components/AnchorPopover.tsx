'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
} from 'react';
import { cn } from '../cn';
import { Portal, useLayer } from '../primitives/layer';
import { useFloating } from '../primitives/useFloating';

export interface AnchorPopoverProps extends HTMLAttributes<HTMLDivElement> {
  anchor: RefObject<HTMLElement | null>;
  onDismiss(): void;
  dismissDisabled?: boolean;
  /** Closest module frame used for positioning; the trigger remains the focus anchor. */
  positionAnchorSelector?: string;
  offset?: number;
  joinedTone?: 'warning' | 'purple' | 'category-2';
}

/** An externally controlled, portalled dialog anchored to an existing control. */
export function AnchorPopover({
  anchor,
  children,
  className,
  onDismiss,
  dismissDisabled = false,
  positionAnchorSelector,
  offset,
  joinedTone,
  ...props
}: AnchorPopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const positionAnchor = useRef<HTMLElement | null>(null);
  const [hidden, setHidden] = useState(false);
  useLayoutEffect(() => {
    const update = () => setHidden(Boolean(anchor.current?.closest('[hidden]')));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['hidden'],
      subtree: true,
    });
    return () => observer.disconnect();
  }, [anchor]);
  useLayoutEffect(() => {
    positionAnchor.current = positionAnchorSelector
      ? (anchor.current?.closest<HTMLElement>(positionAnchorSelector) ?? anchor.current)
      : anchor.current;
  }, [anchor, positionAnchorSelector]);
  useLayoutEffect(() => {
    const card = positionAnchor.current;
    if (!card || !joinedTone) return;
    card.setAttribute('data-rx-popover-anchor-tone', joinedTone);
    return () => card.removeAttribute('data-rx-popover-anchor-tone');
  }, [anchor, positionAnchorSelector, joinedTone]);
  const floating = useFloating({
    anchor: positionAnchor,
    floating: panel,
    open: !hidden,
    placement: 'top-start',
    matchWidth: positionAnchorSelector ? 'exact' : 'none',
    collision: positionAnchorSelector ? 'shift' : 'flip',
    offset,
  });
  const layer = useLayer({
    active: !hidden,
    elements: [anchor, panel],
    kind: 'dropdown',
    outside: false,
    onDismiss: () => {
      if (!dismissDisabled) onDismiss();
    },
  });
  const positioned = !hidden && floating.style.visibility !== 'hidden';
  useEffect(() => {
    if (!positioned) return;
    const target = panel.current?.querySelector<HTMLElement>(
      '[data-popover-autofocus], input, .rx-date-field-trigger',
    );
    (target ?? panel.current)?.focus({ preventScroll: true });
  }, [positioned]);
  return (
    <Portal>
      <layer.Provider>
        <div
          {...props}
          ref={panel}
          hidden={hidden}
          role="dialog"
          aria-modal="false"
          tabIndex={-1}
          className={cn('rx-floating-panel', 'rx-popover', className)}
          data-side={floating.side}
          data-rx-popover-tone={joinedTone}
          style={{
            ...floating.style,
            zIndex: layer.zIndex,
            ...(positionAnchorSelector ? { maxWidth: 'none', minWidth: 0 } : {}),
            ...(hidden ? { display: 'none' } : {}),
          }}
        >
          {children}
        </div>
      </layer.Provider>
    </Portal>
  );
}
