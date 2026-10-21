'use client';

import { Check } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { cn } from '../../cn';
import { Portal, useLayer, type DismissReason } from '../../primitives/layer';
import { useFloating } from '../../primitives/useFloating';
import { usePresence } from '../../primitives/usePresence';
import { Spinner } from '../Spinner';
import type { ControlTouchTarget } from '../Button';
import type { SelectCreateProps, SelectStatusLabels } from './types';
import { LOAD_MORE_THRESHOLD, type SelectCore } from './useSelectCore';
import { highlight, optionDomId, type SelectRow } from './utils';

/** 规范 03 §3.4：面板最大高度 320，与触发器间距 4。 */
export const PANEL_MAX_HEIGHT = 320;
/** 已加载超过 100 项时启用虚拟列表（规范 03 §3.5）。 */
export const VIRTUALIZE_THRESHOLD = 100;
const VIRTUAL_OVERSCAN = 6;
const FALLBACK_ROW_HEIGHT = 32;
const VIEWPORT_PADDING = 8;

export type SelectAllState = 'all' | 'none' | 'some';

export interface SelectPanelProps<Value extends string>
  extends SelectStatusLabels, Pick<SelectCreateProps, 'createLabel'> {
  anchorRef: RefObject<HTMLElement | null>;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** 带搜索框 / 状态行 / 底栏时为 true：面板是外层容器，listbox 在其中滚动。 */
  chrome: boolean;
  core: SelectCore<Value>;
  footer?: ReactNode;
  isSelected: (value: Value) => boolean;
  listboxClassName?: string;
  multiple: boolean;
  onDismiss: (reason: DismissReason) => void;
  onRowClick: (row: SelectRow<Value>) => void;
  portal: boolean;
  /** 触发器所在的根元素：点在这里不算「外部」。 */
  rootRef: RefObject<HTMLElement | null>;
  search?: ReactNode;
  selectAllLabel?: ReactNode;
  selectAllState?: SelectAllState;
  touchTarget?: ControlTouchTarget;
}

function readRowHeight(element: HTMLElement | null): number {
  if (!element || typeof window === 'undefined') return FALLBACK_ROW_HEIGHT;
  const value = parseFloat(window.getComputedStyle(element).getPropertyValue('--rx-option-height'));
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_ROW_HEIGHT;
}

/** useFloating 的最小宽度等于触发器宽度、不受视口约束；这里把它夹到视口内（两侧各留 8px）。 */
function clampToViewport(style: CSSProperties): CSSProperties {
  if (typeof window === 'undefined') return style;
  const viewportWidth =
    window.visualViewport?.width ?? (document.documentElement.clientWidth || window.innerWidth);
  const limit = Math.max(0, Math.floor(viewportWidth - VIEWPORT_PADDING * 2));
  return {
    ...style,
    maxWidth: limit,
    minWidth: typeof style.minWidth === 'number' ? Math.min(style.minWidth, limit) : style.minWidth,
  };
}

function CheckMarker({ state }: { state: 'checked' | 'mixed' | 'unchecked' }) {
  return (
    <span aria-hidden="true" className="rx-select-checkbox" data-state={state}>
      {state === 'checked' ? <Check className="rx-select-checkbox-icon" strokeWidth={2} /> : null}
    </span>
  );
}

/**
 * 共享浮层面板（规范 03 §3.4）：选项列表 + 可选的搜索框、底部状态行与底栏。
 * `portal` 时挂到共享 portal 根并用 useFloating 定位（翻转、跟随滚动）；否则相对触发器绝对定位。
 */
export function SelectPanel<Value extends string>({
  anchorRef,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  chrome,
  core,
  createLabel,
  emptyLabel,
  endLabel,
  errorLabel,
  footer,
  isSelected,
  listboxClassName,
  loadingLabel,
  minSearchLabel,
  multiple,
  onDismiss,
  onRowClick,
  portal,
  retryLabel,
  rootRef,
  search,
  selectAllLabel,
  selectAllState = 'none',
  touchTarget,
}: SelectPanelProps<Value>) {
  const { activeId, followActiveRef, isRowDisabled, listboxId, open, query, rows, source } = core;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const presence = usePresence<HTMLDivElement>(open);
  const floating = useFloating({
    anchor: anchorRef,
    floating: panelRef,
    matchWidth: 'min',
    maxHeight: PANEL_MAX_HEIGHT,
    open: portal && presence.mounted,
    placement: 'bottom-start',
  });
  const layer = useLayer({
    active: open,
    elements: [rootRef, panelRef],
    kind: 'dropdown',
    onDismiss,
  });

  const optionCount = rows.length;
  const virtual = optionCount > VIRTUALIZE_THRESHOLD;
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(PANEL_MAX_HEIGHT);

  useLayoutEffect(() => {
    if (!presence.mounted || !virtual) return;
    const measure = () => {
      setRowHeight(readRowHeight(listRef.current));
      const height = listRef.current?.clientHeight ?? 0;
      setViewportHeight(height > 0 ? height : PANEL_MAX_HEIGHT);
    };
    measure();
    // 窄屏触控行高随 CSS 断点变化，虚拟列表的位置计算必须读取同一实际行高。
    if (touchTarget !== 'responsive') return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [presence.mounted, touchTarget, virtual]);

  // 键盘移动高亮时只滚动列表本身（scrollIntoView 可能连带滚动弹窗或页面）。
  useLayoutEffect(() => {
    if (!open || !followActiveRef.current) return;
    const list = listRef.current;
    if (list === null || activeId === undefined) return;
    if (virtual) {
      const index = core.activeIndex;
      if (index < 0) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      const viewport = list.clientHeight || viewportHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + viewport) list.scrollTop = bottom - viewport;
      setScrollTop(list.scrollTop);
      return;
    }
    const item = document.getElementById(activeId);
    if (item === null) return;
    const listBounds = list.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    const top = listBounds.top + list.clientTop;
    const bottom = top + list.clientHeight;
    if (itemBounds.top < top) list.scrollTop += itemBounds.top - top;
    else if (itemBounds.bottom > bottom) list.scrollTop += itemBounds.bottom - bottom;
  }, [
    activeId,
    core.activeIndex,
    floating.style.left,
    floating.style.maxHeight,
    floating.style.top,
    followActiveRef,
    open,
    rowHeight,
    viewportHeight,
    virtual,
  ]);

  const { hasMore, loadMore, status } = source;
  const nearEnd = useCallback(() => {
    const list = listRef.current;
    if (!list || !hasMore) return;
    const threshold = LOAD_MORE_THRESHOLD * (virtual ? rowHeight : readRowHeight(list));
    if (list.scrollHeight - list.scrollTop - list.clientHeight <= threshold) loadMore();
  }, [hasMore, loadMore, rowHeight, virtual]);

  // 第一页撑不满面板时继续加载，否则用户无从滚动触发下一页。
  useEffect(() => {
    if (!open || status !== 'ready' || !hasMore) return;
    // Sparse remote scans can yield an empty page with a continuation cursor.
    // Empty listboxes are hidden by CSS; continue without relying on their height.
    if (!rows.some((row) => row.kind === 'option')) {
      loadMore();
      return;
    }
    const list = listRef.current;
    if (!list || list.clientHeight === 0) return;
    if (list.scrollHeight <= list.clientHeight) loadMore();
  }, [hasMore, loadMore, open, rows, status]);

  if (!presence.mounted) return null;

  const preventFocusSteal = (event: MouseEvent) => event.preventDefault();
  const panelStyle: CSSProperties = portal
    ? { ...clampToViewport(floating.style), zIndex: layer.zIndex }
    : { zIndex: layer.zIndex };

  const renderRow = (row: SelectRow<Value>, index: number, style?: CSSProperties) => {
    const id = optionDomId(listboxId, row.key);
    if (row.kind === 'group') {
      return (
        <div
          className="rx-select-group-label"
          id={id}
          key={row.key}
          role="presentation"
          style={style}
        >
          {row.label}
        </div>
      );
    }
    const disabled = isRowDisabled(row);
    const active = id === activeId;
    let selected = false;
    let content: ReactNode;
    let marker: ReactNode = null;
    if (row.kind === 'option') {
      selected = isSelected(row.option.value);
      content = highlight(row.option.label, query);
      if (multiple) marker = <CheckMarker state={selected ? 'checked' : 'unchecked'} />;
    } else if (row.kind === 'select-all') {
      selected = selectAllState === 'all';
      content = selectAllLabel;
      marker = (
        <CheckMarker
          state={
            selectAllState === 'all' ? 'checked' : selectAllState === 'some' ? 'mixed' : 'unchecked'
          }
        />
      );
    } else {
      content = createLabel?.(row.query) ?? row.query;
    }
    return (
      <div
        aria-disabled={disabled || undefined}
        aria-posinset={virtual ? index + 1 : undefined}
        aria-selected={selected}
        aria-setsize={virtual ? optionCount : undefined}
        className="rx-select-option"
        data-active={active || undefined}
        data-kind={row.kind === 'option' ? undefined : row.kind}
        data-selected={selected || undefined}
        id={id}
        key={row.key}
        onClick={(event) => {
          // Select 常被包在 <label> 里：阻断 label 的激活转发，
          // 否则选中后 label 会再点一次触发按钮，把刚收起的弹层重新打开。
          event.preventDefault();
          if (!disabled) onRowClick(row);
        }}
        onMouseDown={preventFocusSteal}
        onPointerMove={() => {
          followActiveRef.current = false;
          if (!disabled) core.setActiveKey(row.key);
        }}
        role="option"
        style={style}
      >
        {marker}
        <span className="rx-select-option-label">{content}</span>
        {!multiple && row.kind === 'option' && selected ? (
          <Check aria-hidden="true" className="rx-select-check" strokeWidth={1.5} />
        ) : null}
      </div>
    );
  };

  const renderRows = () => {
    if (virtual) {
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - VIRTUAL_OVERSCAN);
      const end = Math.min(
        optionCount,
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + VIRTUAL_OVERSCAN,
      );
      const indexes: number[] = [];
      for (let index = start; index < end; index += 1) indexes.push(index);
      // aria-activedescendant 指向的元素必须存在：高亮项在窗口外时也渲染它。
      if (core.activeIndex >= 0 && (core.activeIndex < start || core.activeIndex >= end)) {
        indexes.push(core.activeIndex);
      }
      return (
        <div className="rx-select-virtual" style={{ height: optionCount * rowHeight }}>
          {indexes.map((index) =>
            renderRow(rows[index], index, { height: rowHeight, top: index * rowHeight }),
          )}
        </div>
      );
    }
    const output: ReactNode[] = [];
    let group: { key: string; label: ReactNode; children: ReactNode[] } | null = null;
    const flush = () => {
      if (!group) return;
      const labelId = optionDomId(listboxId, group.key);
      output.push(
        <div aria-labelledby={labelId} className="rx-select-group" key={group.key} role="group">
          <div className="rx-select-group-label" id={labelId} role="presentation">
            {group.label}
          </div>
          {group.children}
        </div>,
      );
      group = null;
    };
    rows.forEach((row, index) => {
      if (row.kind === 'group') {
        flush();
        group = { children: [], key: row.key, label: row.label };
        return;
      }
      if (row.kind === 'option' && group) {
        group.children.push(renderRow(row, index));
        return;
      }
      flush();
      output.push(renderRow(row, index));
    });
    flush();
    return output;
  };

  const hasOptionRows = rows.some((row) => row.kind === 'option');
  const busy = status === 'loading' || status === 'loading-more';
  let statusRow: ReactNode = null;
  if (source.belowMinimum) {
    statusRow = minSearchLabel ?? null;
  } else if (busy) {
    statusRow = (
      <>
        <Spinner size="sm" />
        {loadingLabel}
      </>
    );
  } else if (status === 'error') {
    statusRow = (
      <>
        <span>{errorLabel}</span>
        <button
          className="rx-select-retry"
          onClick={source.retry}
          onMouseDown={preventFocusSteal}
          type="button"
        >
          {retryLabel}
        </button>
      </>
    );
  } else if (status === 'ready' && !hasOptionRows && !source.searching) {
    statusRow = source.hasMore ? (
      <>
        <Spinner size="sm" />
        {loadingLabel}
      </>
    ) : (
      (emptyLabel ?? null)
    );
  } else if (source.reachedEnd) {
    statusRow = endLabel ?? null;
  }

  const listbox = (
    <div
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-multiselectable={multiple || undefined}
      className={cn(
        'rx-select-listbox',
        !chrome && 'rx-floating-panel rx-select-panel',
        listboxClassName,
      )}
      data-inline={(!chrome && !portal) || undefined}
      data-portal={portal || undefined}
      data-side={!chrome && portal ? floating.side : undefined}
      data-stale={source.stale || undefined}
      data-state={!chrome ? presence.state : undefined}
      data-virtual={virtual || undefined}
      data-touch-target={touchTarget}
      id={listboxId}
      onScroll={(event) => {
        if (virtual) setScrollTop(event.currentTarget.scrollTop);
        nearEnd();
      }}
      onWheel={
        chrome
          ? undefined
          : (event) => {
              followActiveRef.current = false;
              event.stopPropagation();
            }
      }
      ref={(node) => {
        listRef.current = node;
        if (!chrome) {
          panelRef.current = node;
          presence.ref(node);
        }
      }}
      role="listbox"
      style={chrome ? undefined : panelStyle}
    >
      {renderRows()}
    </div>
  );

  const panel = chrome ? (
    <div
      className="rx-floating-panel rx-select-panel"
      data-chrome=""
      data-touch-target={touchTarget}
      data-inline={!portal || undefined}
      data-side={portal ? floating.side : undefined}
      data-state={presence.state}
      onWheel={(event) => {
        followActiveRef.current = false;
        event.stopPropagation();
      }}
      ref={(node) => {
        panelRef.current = node;
        presence.ref(node);
      }}
      style={panelStyle}
    >
      {search}
      {listbox}
      <div aria-live="polite" className="rx-select-status" role="status">
        {statusRow}
      </div>
      {footer}
    </div>
  ) : (
    listbox
  );

  return portal ? (
    <Portal>
      <layer.Provider>{panel}</layer.Provider>
    </Portal>
  ) : (
    <layer.Provider>{panel}</layer.Provider>
  );
}
