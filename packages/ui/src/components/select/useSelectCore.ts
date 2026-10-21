'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';

import { useControllableState } from '../../primitives/useControllableState';
import type { FilterOption, LoadOptions, SelectItem, SelectOption } from './types';
import { useOptionSource, type OptionSource } from './useOptionSource';
import { optionDomId, optionRowKey, type SelectRow } from './utils';

/** 距底部 3 项时加载下一页（规范 03 §3.5）。 */
export const LOAD_MORE_THRESHOLD = 3;

export interface SelectCoreOptions<Value extends string> {
  creatable?: boolean;
  defaultOpen?: boolean;
  /** 禁用或只读：不能打开。 */
  disabled: boolean;
  filterOption?: FilterOption<Value>;
  isOptionDisabled?: (option: SelectOption<Value>) => boolean;
  loadOptions?: LoadOptions<Value>;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  options?: readonly SelectItem<Value>[];
  /** 打开时优先高亮的值（单选的当前值）。 */
  preferredValue?: Value;
  searchDebounceMs?: number;
  minSearchLength?: number;
  resetOnQueryChange?: boolean;
  onSearchChange?: (query: string) => void;
  /** 在列表顶部加「全选」行（仅本地数据）。 */
  selectAll?: boolean;
}

export interface SelectCore<Value extends string> {
  activeId: string | undefined;
  activeIndex: number;
  activeRow: SelectRow<Value> | undefined;
  /** 键盘移动时让列表跟随滚动；滚轮/指针移动时关闭跟随。 */
  followActiveRef: MutableRefObject<boolean>;
  isRowDisabled: (row: SelectRow<Value>) => boolean;
  listboxId: string;
  moveActive: (direction: -1 | 1) => void;
  moveToEdge: (edge: 'first' | 'last') => void;
  open: boolean;
  openWithActive: (fallback?: 'first' | 'last') => void;
  query: string;
  rows: SelectRow<Value>[];
  setActiveKey: (key: string | undefined) => void;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  source: OptionSource<Value>;
}

/** Select / MultiSelect 的共享状态：开合、搜索词、数据来源、键盘高亮（aria-activedescendant）。 */
export function useSelectCore<Value extends string>({
  creatable = false,
  defaultOpen = false,
  disabled,
  filterOption,
  isOptionDisabled,
  loadOptions,
  onOpenChange,
  open: openProp,
  options,
  preferredValue,
  searchDebounceMs,
  minSearchLength,
  resetOnQueryChange,
  onSearchChange,
  selectAll = false,
}: SelectCoreOptions<Value>): SelectCore<Value> {
  const listboxId = useId();
  const [openState, setOpenState] = useControllableState({
    defaultValue: defaultOpen,
    onChange: onOpenChange,
    value: openProp,
  });
  const open = openState && !disabled;
  const [query, setQueryState] = useState('');
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const followActiveRef = useRef(true);
  const resetActiveRef = useRef(false);

  const source = useOptionSource({
    debounceMs: searchDebounceMs,
    filterOption,
    loadOptions,
    minSearchLength,
    resetOnQueryChange,
    open,
    options,
    query,
  });

  const rows = useMemo(() => {
    const trimmed = query.trim();
    const hasOptions = source.rows.some((row) => row.kind === 'option');
    const extra: SelectRow<Value>[] = [];
    if (selectAll && !source.remote && hasOptions)
      extra.push({ kind: 'select-all', key: 'select-all' });
    const list = [...extra, ...source.rows];
    if (
      creatable &&
      trimmed !== '' &&
      !hasOptions &&
      source.status === 'ready' &&
      !source.searching
    ) {
      list.push({ kind: 'create', key: 'create', query: trimmed });
    }
    return list;
  }, [creatable, query, selectAll, source.remote, source.rows, source.searching, source.status]);

  const isRowDisabled = useCallback(
    (row: SelectRow<Value>) => {
      if (row.kind === 'group') return true;
      if (row.kind !== 'option') return false;
      return row.option.disabled === true || (isOptionDisabled?.(row.option) ?? false);
    },
    [isOptionDisabled],
  );

  const enabledIndexes = useMemo(
    () =>
      rows
        .map((row, index) => (isRowDisabled(row) ? undefined : index))
        .filter((index): index is number => index !== undefined),
    [isRowDisabled, rows],
  );

  const preferredIndex = useMemo(() => {
    if (preferredValue === undefined) return undefined;
    const key = optionRowKey(preferredValue);
    const index = rows.findIndex((row) => row.key === key);
    return enabledIndexes.includes(index) ? index : undefined;
  }, [enabledIndexes, preferredValue, rows]);

  const activeIndex = activeKey === undefined ? -1 : rows.findIndex((row) => row.key === activeKey);
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const activeId =
    open && activeRow !== undefined && !isRowDisabled(activeRow)
      ? optionDomId(listboxId, activeRow.key)
      : undefined;

  const keyAt = useCallback(
    (index: number | undefined) => {
      return index === undefined ? undefined : rows[index]?.key;
    },
    [rows],
  );

  // 选项变化（远程翻页、搜索、父组件重渲染）时保持高亮项；失效时回落到已选项或第一项。
  useEffect(() => {
    if (!open) return;
    if (resetActiveRef.current && (!source.stale || !source.remote)) {
      resetActiveRef.current = false;
      setActiveKey(keyAt(enabledIndexes[0]));
      return;
    }
    setActiveKey((current) => {
      const index = current === undefined ? -1 : rows.findIndex((row) => row.key === current);
      if (enabledIndexes.includes(index)) return current;
      return keyAt(preferredIndex ?? enabledIndexes[0]);
    });
  }, [enabledIndexes, keyAt, open, preferredIndex, rows, source.remote, source.stale]);

  const loadMoreIfNear = useCallback(
    (index: number) => {
      const optionIndexes = enabledIndexes;
      const position = optionIndexes.indexOf(index);
      if (position >= 0 && optionIndexes.length - 1 - position < LOAD_MORE_THRESHOLD) {
        source.loadMore();
      }
    },
    [enabledIndexes, source],
  );

  const setOpen = useCallback(
    (next: boolean) => {
      if (next && disabled) return;
      setOpenState(next);
      if (!next) setQueryState('');
    },
    [disabled, setOpenState],
  );

  const openWithActive = useCallback(
    (fallback: 'first' | 'last' = 'first') => {
      if (disabled) return;
      followActiveRef.current = true;
      const fallbackIndex = fallback === 'first' ? enabledIndexes[0] : enabledIndexes.at(-1);
      setActiveKey(keyAt(preferredIndex ?? fallbackIndex));
      setOpen(true);
    },
    [disabled, enabledIndexes, keyAt, preferredIndex, setOpen],
  );

  const moveActive = useCallback(
    (direction: -1 | 1) => {
      if (enabledIndexes.length === 0) return;
      followActiveRef.current = true;
      const position = enabledIndexes.indexOf(activeIndex);
      const nextPosition =
        position < 0
          ? direction === 1
            ? 0
            : enabledIndexes.length - 1
          : Math.min(Math.max(position + direction, 0), enabledIndexes.length - 1);
      const next = enabledIndexes[nextPosition];
      setActiveKey(keyAt(next));
      loadMoreIfNear(next);
    },
    [activeIndex, enabledIndexes, keyAt, loadMoreIfNear],
  );

  const moveToEdge = useCallback(
    (edge: 'first' | 'last') => {
      if (enabledIndexes.length === 0) return;
      followActiveRef.current = true;
      const next = edge === 'first' ? enabledIndexes[0] : enabledIndexes.at(-1)!;
      setActiveKey(keyAt(next));
      loadMoreIfNear(next);
    },
    [enabledIndexes, keyAt, loadMoreIfNear],
  );

  const setQuery = useCallback(
    (next: string) => {
      resetActiveRef.current = true;
      followActiveRef.current = true;
      setQueryState(next);
      onSearchChange?.(next);
    },
    [onSearchChange],
  );

  useEffect(() => {
    if (disabled && openState) setOpenState(false);
  }, [disabled, openState, setOpenState]);

  return {
    activeId,
    activeIndex,
    activeRow,
    followActiveRef,
    isRowDisabled,
    listboxId,
    moveActive,
    moveToEdge,
    open,
    openWithActive,
    query,
    rows,
    setActiveKey,
    setOpen,
    setQuery,
    source,
  };
}
