'use client';

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../cn';
import { ScrollArea } from './ScrollArea';

export type VirtualTreeDropZone = 'before' | 'inside' | 'after';

export interface VirtualTreeHit {
  activeId: string;
  /** Client coordinate is available for pointer dragging; null for keyboard dragging. */
  clientX: number | null;
  index: number;
  overId: string;
  zone: VirtualTreeDropZone;
}

export interface VirtualTreeHandle {
  getScrollAnchor: () => { id: string; offset: number } | null;
  getScrollElement: () => HTMLDivElement | null;
  /** Returns false when the ID is not in the caller's visible rows; expand its path first. */
  scrollToId: (id: string, align?: 'start' | 'center' | 'nearest', offset?: number) => boolean;
}

export interface VirtualTreeAnnouncements<Row, Target> {
  cancelled: (row: Row) => string;
  dropped: (row: Row, target: Target) => string;
  moved: (row: Row, target: Target) => string;
  pickedUp: (row: Row) => string;
}

export interface VirtualTreeRowContext {
  handleProps: ButtonHTMLAttributes<HTMLButtonElement> & {
    ref: (element: HTMLButtonElement | null) => void;
  };
  index: number;
  isDragging: boolean;
}

export interface VirtualTreeProps<Row, Target> extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'onDrop' | 'onError' | 'onDragStart' | 'onDragEnd'
> {
  announcements: VirtualTreeAnnouncements<Row, Target>;
  apiRef?: Ref<VirtualTreeHandle>;
  canDrag?: (row: Row) => boolean;
  disabled?: boolean;
  getDepth: (row: Row) => number;
  getId: (row: Row) => string;
  getLabel: (row: Row) => string;
  handleLabel: (label: string) => string;
  instructions: string;
  onDragEnd?: (activeId: string, target: Target | null, reason: 'drop' | 'cancel') => void;
  onDragStart?: (activeId: string) => void;
  onDrop: (activeId: string, target: Target) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Fires on hovered row changes, including while the pointer is stationary during scrolling. */
  onHoverChange?: (overId: string | null) => void;
  overscan?: number;
  /** At most eight active editor/dialog rows can be retained outside the visible window. */
  pinnedIds?: readonly string[];
  renderPreview?: (row: Row) => ReactNode;
  renderRow: (row: Row, context: VirtualTreeRowContext) => ReactNode;
  resolveDropTarget: (hit: VirtualTreeHit) => Target | null;
  /**
   * Fixed row pitch in CSS pixels, including any visual gap. Derive from the owning surface's
   * semantic sizing tokens. Row content must fit this pitch; dialogs should render in portals.
   * Fixed geometry deliberately avoids depending on mounted DOM rows for drag hit testing.
   */
  rowHeight: number;
  rows: readonly Row[];
}

interface Session<Row, Target> {
  activeId: string;
  lastFrame: number;
  lifted: boolean;
  mode: 'keyboard' | 'pointer';
  over: VirtualTreeHit | null;
  pointerId: number;
  row: Row;
  startX: number;
  startY: number;
  target: Target | null;
  x: number;
  y: number;
}

interface DragView {
  activeId: string;
  index: number;
  mode: 'keyboard' | 'pointer';
  overId: string | null;
  zone: VirtualTreeDropZone | null;
}

const MAX_PINNED_ROWS = 8;
const LIFT_DISTANCE = 4;
const EDGE_SIZE = 48;
const MAX_SCROLL_PER_SECOND = 840;
const ZONES: readonly VirtualTreeDropZone[] = ['before', 'inside', 'after'];

/**
 * A flat visible-tree viewport. The caller owns hierarchy, expansion, legal targets and writes.
 * Mounted rows are bounded by viewport + overscan + eight explicit pins + one focused row.
 * A drag retains one data row, never its DOM/subtree. Window listeners survive source unmount.
 */
export function VirtualTree<Row, Target>(props: VirtualTreeProps<Row, Target>) {
  const {
    announcements,
    apiRef,
    canDrag,
    className,
    disabled = false,
    getDepth,
    getId,
    getLabel,
    handleLabel,
    instructions,
    onDragEnd,
    onDragStart,
    onDrop,
    onError,
    onHoverChange,
    overscan = 5,
    pinnedIds = [],
    renderPreview,
    renderRow,
    resolveDropTarget,
    rowHeight,
    rows,
    ...scrollerProps
  } = props;
  if (!(rowHeight > 0) || !Number.isFinite(rowHeight)) {
    throw new Error('VirtualTree rowHeight must be a positive finite CSS pixel size.');
  }
  const instructionsId = useId();
  const scroller = useRef<HTMLDivElement | null>(null);
  const preview = useRef<HTMLDivElement | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const session = useRef<Session<Row, Target> | null>(null);
  const stopListening = useRef<() => void>(() => undefined);
  const frame = useRef<number | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const hovered = useRef<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [viewport, setViewport] = useState({ height: 0, top: 0 });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const indexById = useMemo(
    () => new Map(rows.map((row, index) => [getId(row), index])),
    [rows, getId],
  );
  const currentIndex = useRef(indexById);
  currentIndex.current = indexById;

  const syncViewport = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    setViewport((previous) =>
      previous.height === node.clientHeight && previous.top === node.scrollTop
        ? previous
        : { height: node.clientHeight, top: node.scrollTop },
    );
  }, []);

  const scrollToId = useCallback<VirtualTreeHandle['scrollToId']>(
    (id, align = 'nearest', offset = 0) => {
      const node = scroller.current;
      const index = currentIndex.current.get(id);
      if (!node || index === undefined) return false;
      const height = latest.current.rowHeight;
      const top = index * height;
      let next = node.scrollTop;
      if (align === 'start') next = top + offset;
      else if (align === 'center') next = top - (node.clientHeight - height) / 2 + offset;
      else if (top < next) next = top;
      else if (top + height > next + node.clientHeight) next = top + height - node.clientHeight;
      node.scrollTop = Math.max(
        0,
        Math.min(next, latest.current.rows.length * height - node.clientHeight),
      );
      syncViewport();
      return true;
    },
    [syncViewport],
  );

  useImperativeHandle(
    apiRef,
    () => ({
      getScrollAnchor: () => {
        const node = scroller.current;
        if (!node) return null;
        const index = Math.floor(node.scrollTop / latest.current.rowHeight);
        const row = latest.current.rows[index];
        return row === undefined
          ? null
          : {
              id: latest.current.getId(row),
              offset: node.scrollTop - index * latest.current.rowHeight,
            };
      },
      getScrollElement: () => scroller.current,
      scrollToId,
    }),
    [scrollToId],
  );

  useLayoutEffect(() => {
    syncViewport();
    const node = scroller.current;
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncViewport);
    if (node) observer?.observe(node);
    window.addEventListener('resize', syncViewport);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncViewport);
    };
  }, [syncViewport]);

  const hover = (id: string | null) => {
    if (hovered.current === id) return;
    hovered.current = id;
    latest.current.onHoverChange?.(id);
  };

  const updateTarget = (hit: VirtualTreeHit | null) => {
    const active = session.current;
    if (!active || !active.lifted) return;
    const target = hit ? latest.current.resolveDropTarget(hit) : null;
    const previous = active.over;
    const wasLegal = active.target !== null;
    active.over = hit;
    active.target = target;
    hover(hit?.overId ?? null);
    if (
      previous?.overId === hit?.overId &&
      previous?.zone === hit?.zone &&
      previous?.index === hit?.index &&
      wasLegal === (target !== null)
    )
      return;
    setDragView({
      activeId: active.activeId,
      index: hit?.index ?? -1,
      mode: active.mode,
      overId: target !== null ? (hit?.overId ?? null) : null,
      zone: target !== null ? (hit?.zone ?? null) : null,
    });
    if (target !== null) setAnnouncement(latest.current.announcements.moved(active.row, target));
  };

  const hitAtPointer = () => {
    const active = session.current;
    const node = scroller.current;
    const options = latest.current;
    if (!active || !node || !active.lifted || options.rows.length === 0) return;
    const rect = node.getBoundingClientRect();
    if (
      active.x < rect.left ||
      active.x > rect.right ||
      active.y < rect.top ||
      active.y > rect.bottom
    ) {
      updateTarget(null);
      return;
    }
    const contentY = active.y - rect.top - node.clientTop + node.scrollTop;
    const index = Math.max(
      0,
      Math.min(options.rows.length - 1, Math.floor(contentY / options.rowHeight)),
    );
    const fraction = (contentY - index * options.rowHeight) / options.rowHeight;
    const zone = fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'inside';
    updateTarget({
      activeId: active.activeId,
      clientX: active.x,
      index,
      overId: options.getId(options.rows[index]!),
      zone,
    });
  };

  const restoreFocus = (id: string) => {
    pendingFocus.current = id;
    scrollToId(id);
  };

  const finish = (cancelled: boolean) => {
    const active = session.current;
    if (!active) return;
    stopListening.current();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    session.current = null;
    setDragView(null);
    hover(null);
    if (!active.lifted) return;
    const target = cancelled ? null : active.target;
    const reason = target === null ? 'cancel' : 'drop';
    if (target === null) {
      setAnnouncement(latest.current.announcements.cancelled(active.row));
      latest.current.onDragEnd?.(active.activeId, null, reason);
    } else {
      setAnnouncement(latest.current.announcements.dropped(active.row, target));
      // Invocation is synchronous so the owner can lock structural writes before another pickup.
      try {
        const result = latest.current.onDrop(active.activeId, target);
        if (result)
          void Promise.resolve(result).catch((error: unknown) => latest.current.onError?.(error));
      } catch (error) {
        latest.current.onError?.(error);
      }
      latest.current.onDragEnd?.(active.activeId, target, reason);
    }
    if (active.mode === 'keyboard') restoreFocus(active.activeId);
  };

  const animate = (time: number) => {
    const active = session.current;
    const node = scroller.current;
    if (!active || active.mode !== 'pointer' || !node) return;
    if (active.lifted) {
      const rect = node.getBoundingClientRect();
      const edge = Math.min(EDGE_SIZE, rect.height / 3);
      const elapsed = Math.min(32, active.lastFrame ? time - active.lastFrame : 16) / 1000;
      active.lastFrame = time;
      let velocity = 0;
      if (
        edge > 0 &&
        active.x >= rect.left &&
        active.x <= rect.right &&
        active.y >= rect.top &&
        active.y <= rect.bottom
      ) {
        if (active.y < rect.top + edge)
          velocity = -Math.pow((rect.top + edge - active.y) / edge, 2);
        else if (active.y > rect.bottom - edge)
          velocity = Math.pow((active.y - rect.bottom + edge) / edge, 2);
      }
      if (velocity !== 0) {
        const max = Math.max(
          0,
          latest.current.rows.length * latest.current.rowHeight - node.clientHeight,
        );
        node.scrollTop = Math.max(
          0,
          Math.min(max, node.scrollTop + velocity * MAX_SCROLL_PER_SECOND * elapsed),
        );
        syncViewport();
      }
      // Recompute even without pointer movement: scrolling and hover expansion both change rows.
      hitAtPointer();
      if (preview.current)
        preview.current.style.transform = `translate3d(${active.x}px, ${active.y}px, 0)`;
    }
    frame.current = requestAnimationFrame(animate);
  };

  const lift = (active: Session<Row, Target>) => {
    active.lifted = true;
    setDragView({
      activeId: active.activeId,
      index: -1,
      mode: active.mode,
      overId: null,
      zone: null,
    });
    latest.current.onDragStart?.(active.activeId);
    setAnnouncement(latest.current.announcements.pickedUp(active.row));
  };

  const keyboardMove = (direction: number, boundary?: 'start' | 'end') => {
    const active = session.current;
    if (!active || active.mode !== 'keyboard') return;
    const options = latest.current;
    const count = options.rows.length * ZONES.length;
    const sourceIndex = currentIndex.current.get(active.activeId) ?? 0;
    const overIndex = active.over
      ? (currentIndex.current.get(active.over.overId) ?? active.over.index)
      : sourceIndex;
    let slot =
      boundary === 'start'
        ? -1
        : boundary === 'end'
          ? count
          : overIndex * ZONES.length + (active.over ? ZONES.indexOf(active.over.zone) : 1);
    while ((slot += direction) >= 0 && slot < count) {
      const index = Math.floor(slot / ZONES.length);
      const row = options.rows[index]!;
      const hit: VirtualTreeHit = {
        activeId: active.activeId,
        clientX: null,
        index,
        overId: options.getId(row),
        zone: ZONES[slot % ZONES.length]!,
      };
      if (options.resolveDropTarget(hit) === null) continue;
      updateTarget(hit);
      scrollToId(hit.overId);
      return;
    }
  };

  const listen = () => {
    const onMove = (event: PointerEvent) => {
      const active = session.current;
      if (!active || active.mode !== 'pointer' || event.pointerId !== active.pointerId) return;
      active.x = event.clientX;
      active.y = event.clientY;
      if (
        !active.lifted &&
        Math.hypot(active.x - active.startX, active.y - active.startY) >= LIFT_DISTANCE
      )
        lift(active);
      if (active.lifted) {
        event.preventDefault();
        hitAtPointer();
      }
    };
    const onUp = (event: PointerEvent) => {
      const active = session.current;
      if (!active || active.mode !== 'pointer' || event.pointerId !== active.pointerId) return;
      active.x = event.clientX;
      active.y = event.clientY;
      hitAtPointer();
      finish(false);
    };
    const onCancel = (event: PointerEvent) => {
      if (session.current?.mode === 'pointer' && session.current.pointerId === event.pointerId)
        finish(true);
    };
    const onKey = (event: KeyboardEvent) => {
      const active = session.current;
      if (!active) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (active.mode === 'keyboard') {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        } else if (
          ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          const direction = ['ArrowUp', 'ArrowLeft', 'End'].includes(event.key) ? -1 : 1;
          keyboardMove(
            direction,
            event.key === 'Home' ? 'start' : event.key === 'End' ? 'end' : undefined,
          );
        } else if (event.key === 'Tab') finish(true);
      }
    };
    const onBlur = () => finish(true);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    stopListening.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  };

  const begin = (
    row: Row,
    mode: 'keyboard' | 'pointer',
    event?: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const options = latest.current;
    if (options.disabled || session.current || options.canDrag?.(row) === false) return;
    const active: Session<Row, Target> = {
      activeId: options.getId(row),
      lastFrame: 0,
      lifted: false,
      mode,
      over: null,
      pointerId: event?.pointerId ?? -1,
      row,
      startX: event?.clientX ?? 0,
      startY: event?.clientY ?? 0,
      target: null,
      x: event?.clientX ?? 0,
      y: event?.clientY ?? 0,
    };
    session.current = active;
    listen();
    if (mode === 'keyboard') lift(active);
    else frame.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    if (disabled && session.current) finish(true);
    // The listener reads latest props; cancellation only needs to run when the lock changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  useEffect(
    () => () => {
      stopListening.current();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const id = pendingFocus.current;
    // The owner's drop callback may have just moved the row outside the old virtual window.
    // Resolve its ID against the committed rows before restoring focus after it remounts.
    if (id) scrollToId(id);
    const handle = id ? handles.current.get(id) : null;
    if (handle && !handle.disabled) {
      handle.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const buffer = Math.max(0, Math.min(20, Math.floor(overscan)));
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - buffer);
  const end = Math.min(
    rows.length,
    Math.ceil((viewport.top + viewport.height) / rowHeight) + buffer,
  );
  const mounted = new Set<number>();
  for (let index = start; index < end; index++) mounted.add(index);
  for (const id of pinnedIds.slice(0, MAX_PINNED_ROWS)) {
    const index = indexById.get(id);
    if (index !== undefined) mounted.add(index);
  }
  if (focusedId) {
    const index = indexById.get(focusedId);
    if (index !== undefined) mounted.add(index);
  }
  const active = session.current;
  const indicatorIndex = dragView?.overId ? indexById.get(dragView.overId) : undefined;
  const indicator =
    dragView?.overId && dragView.zone && indicatorIndex !== undefined
      ? ({
          '--rx-tree-depth': getDepth(rows[indicatorIndex]!),
          height: dragView.zone === 'inside' ? rowHeight : undefined,
          top: (indicatorIndex + (dragView.zone === 'after' ? 1 : 0)) * rowHeight,
        } as CSSProperties)
      : null;

  return (
    <>
      <ScrollArea
        {...scrollerProps}
        className={cn('rx-virtual-tree', className)}
        data-dragging={dragView ? '' : undefined}
        onBlurCapture={(event) => {
          scrollerProps.onBlurCapture?.(event);
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null);
        }}
        onFocusCapture={(event) => {
          scrollerProps.onFocusCapture?.(event);
          const row = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-tree-id]');
          setFocusedId(row?.dataset.virtualTreeId ?? null);
        }}
        onScroll={(event) => {
          scrollerProps.onScroll?.(event);
          syncViewport();
        }}
        ref={scroller}
      >
        <div
          className="rx-virtual-tree-content"
          role="list"
          style={{ height: rows.length * rowHeight }}
        >
          {[...mounted]
            .sort((a, b) => a - b)
            .map((index) => {
              const row = rows[index]!;
              const id = getId(row);
              const isDragging = dragView?.activeId === id;
              return (
                <div
                  aria-posinset={index + 1}
                  aria-setsize={rows.length}
                  className="rx-virtual-tree-row"
                  data-dragging={isDragging ? '' : undefined}
                  data-virtual-tree-id={id}
                  key={id}
                  role="listitem"
                  style={{ height: rowHeight, top: index * rowHeight }}
                >
                  {renderRow(row, {
                    handleProps: {
                      'aria-describedby': instructionsId,
                      'aria-label': handleLabel(getLabel(row)),
                      'aria-pressed': isDragging,
                      className: 'rx-sortable-handle',
                      disabled: disabled || canDrag?.(row) === false,
                      onKeyDown: (event) => {
                        if (event.defaultPrevented) return;
                        if ((event.key === ' ' || event.key === 'Enter') && !session.current) {
                          event.preventDefault();
                          begin(row, 'keyboard');
                        }
                      },
                      onPointerDown: (event) => {
                        if (event.button !== 0 || event.isPrimary === false) return;
                        event.preventDefault();
                        begin(row, 'pointer', event);
                      },
                      ref: (element) => {
                        if (element) handles.current.set(id, element);
                        else handles.current.delete(id);
                      },
                      type: 'button',
                    },
                    index,
                    isDragging,
                  })}
                </div>
              );
            })}
          {indicator ? (
            <div
              aria-hidden="true"
              className="rx-virtual-tree-target"
              data-zone={dragView!.zone}
              style={indicator}
            />
          ) : null}
        </div>
      </ScrollArea>
      <div aria-atomic="true" aria-live="polite" className="rx-visually-hidden" role="status">
        {announcement}
      </div>
      <div hidden id={instructionsId}>
        {instructions}
      </div>
      {dragView?.mode === 'pointer' && active
        ? createPortal(
            <div
              aria-hidden="true"
              className="rx-virtual-tree-preview"
              ref={preview}
              style={{ transform: `translate3d(${active.x}px, ${active.y}px, 0)` }}
            >
              {renderPreview ? renderPreview(active.row) : getLabel(active.row)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
