'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FilterOption, LoadOptions, SelectCursor, SelectItem, SelectOption } from './types';
import { collectOptions, defaultFilterOption, flattenItems, type SelectRow } from './utils';

export type SourceStatus = 'error' | 'idle' | 'loading' | 'loading-more' | 'ready';

interface RemoteState<Value extends string> {
  items: readonly SelectItem<Value>[];
  nextCursor: SelectCursor | null;
  pages: number;
  /** 当前 items 对应的搜索词。 */
  query: string | null;
  /** 最近一次发起请求的搜索词（用于判断搜索是否还在防抖/请求中）。 */
  requestedQuery: string | null;
  status: SourceStatus;
}

const EMPTY_ITEMS: readonly SelectItem<never>[] = [];

export interface OptionSource<Value extends string> {
  /** 已应用搜索过滤的行（含分组标题）。 */
  rows: SelectRow<Value>[];
  /** 已加载过的全部选项（跨页、跨搜索累积），用于已选标签查找。 */
  known: Map<Value, SelectOption<Value>>;
  status: SourceStatus;
  /** 翻过页且没有更多（用于「已全部加载」）。 */
  reachedEnd: boolean;
  hasMore: boolean;
  /** 搜索词还在防抖或请求中（搜索框内显示 Spinner，规范 05 §2）。 */
  searching: boolean;
  /** 旧结果仍在显示、新结果加载中（旧内容降低不透明度，规范 05 §2）。 */
  stale: boolean;
  remote: boolean;
  belowMinimum: boolean;
  loadMore: () => void;
  retry: () => void;
}

/**
 * Select / MultiSelect 的数据来源：本地过滤，或远程分页（打开即拉第一页、搜索防抖 300ms、
 * AbortController 取消上一请求、按需加载下一页、失败可重试）。规范 03 §3.5。
 */
export function useOptionSource<Value extends string>({
  debounceMs = 300,
  filterOption,
  loadOptions,
  minSearchLength = 0,
  resetOnQueryChange = false,
  open,
  options,
  query,
}: {
  debounceMs?: number;
  filterOption?: FilterOption<Value>;
  loadOptions?: LoadOptions<Value>;
  minSearchLength?: number;
  resetOnQueryChange?: boolean;
  open: boolean;
  options?: readonly SelectItem<Value>[];
  query: string;
}): OptionSource<Value> {
  const remoteMode = loadOptions !== undefined;
  const trimmed = query.trim();
  const belowMinimum = trimmed.length < minSearchLength;
  const queryRef = useRef(trimmed);
  queryRef.current = trimmed;
  const resetRef = useRef(resetOnQueryChange);
  resetRef.current = resetOnQueryChange;
  const [remote, setRemote] = useState<RemoteState<Value>>({
    items: EMPTY_ITEMS,
    nextCursor: null,
    pages: 0,
    query: null,
    requestedQuery: null,
    status: 'idle',
  });
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const loadRef = useRef(loadOptions);
  loadRef.current = loadOptions;
  const controllerRef = useRef<AbortController | null>(null);
  const requestedRef = useRef<string | null>(null);
  const lastRequestRef = useRef<{ cursor: SelectCursor | undefined; query: string } | null>(null);
  const wasOpenRef = useRef(false);
  const knownRef = useRef(new Map<Value, SelectOption<Value>>());

  const run = useCallback((nextQuery: string, cursor?: SelectCursor) => {
    const load = loadRef.current;
    if (!load) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    requestedRef.current = nextQuery;
    lastRequestRef.current = { cursor, query: nextQuery };
    setRemote((current) => ({
      ...current,
      requestedQuery: nextQuery,
      status: cursor === undefined ? 'loading' : 'loading-more',
    }));
    let promise: Promise<Awaited<ReturnType<LoadOptions<Value>>>>;
    try {
      promise = Promise.resolve(load({ cursor, query: nextQuery, signal: controller.signal }));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (result) => {
        if (controller.signal.aborted || (resetRef.current && queryRef.current !== nextQuery))
          return;
        controllerRef.current = null;
        const items = result.items ?? [];
        collectOptions(items, knownRef.current);
        setRemote((current) => ({
          items: cursor === undefined ? items : [...current.items, ...items],
          nextCursor: result.nextCursor ?? null,
          pages: cursor === undefined ? 1 : current.pages + 1,
          query: nextQuery,
          requestedQuery: nextQuery,
          status: 'ready',
        }));
      },
      () => {
        if (controller.signal.aborted || (resetRef.current && queryRef.current !== nextQuery))
          return;
        controllerRef.current = null;
        setRemote((current) => ({ ...current, status: 'error' }));
      },
    );
  }, []);

  // 打开即拉第一页；打开期间搜索词变化时防抖后重新拉第一页。
  useEffect(() => {
    if (!remoteMode) return;
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;
    if (resetOnQueryChange || belowMinimum) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      requestedRef.current = null;
      lastRequestRef.current = null;
      setRemote({
        items: EMPTY_ITEMS,
        nextCursor: null,
        pages: 0,
        query: null,
        requestedQuery: null,
        status: 'idle',
      });
    }
    if (belowMinimum) return;
    if (requestedRef.current === trimmed) return;
    if (justOpened && minSearchLength === 0) {
      run(trimmed);
      return;
    }
    const timer = setTimeout(() => run(trimmed), debounceMs);
    return () => clearTimeout(timer);
  }, [
    belowMinimum,
    debounceMs,
    minSearchLength,
    open,
    remoteMode,
    resetOnQueryChange,
    run,
    trimmed,
  ]);

  // 关闭面板时取消在途请求；未完成的第一页下次打开重新拉。
  useEffect(() => {
    if (open) return;
    const controller = controllerRef.current;
    if (!controller) return;
    controller.abort();
    controllerRef.current = null;
    const last = lastRequestRef.current;
    if (last?.cursor === undefined) requestedRef.current = null;
    setRemote((current) =>
      current.status === 'loading' || current.status === 'loading-more'
        ? {
            ...current,
            requestedQuery: last?.cursor === undefined ? null : current.requestedQuery,
            status: current.pages > 0 ? 'ready' : 'idle',
          }
        : current,
    );
  }, [open]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const loadMore = useCallback(() => {
    const current = remoteRef.current;
    if (
      controllerRef.current !== null ||
      current.status !== 'ready' ||
      current.nextCursor === null ||
      current.query === null ||
      (resetRef.current && current.query !== queryRef.current)
    ) {
      return;
    }
    run(current.query, current.nextCursor);
  }, [run]);

  const retry = useCallback(() => {
    const last = lastRequestRef.current;
    if (!last || (resetRef.current && last.query !== queryRef.current)) return;
    run(last.query, last.cursor);
  }, [run]);

  const localRows = useMemo(() => {
    if (remoteMode) return null;
    const filter = filterOption ?? (defaultFilterOption as FilterOption<Value>);
    return flattenItems(
      options ?? EMPTY_ITEMS,
      trimmed === '' ? undefined : (option) => filter(option, trimmed),
    );
  }, [filterOption, options, remoteMode, trimmed]);

  const remoteRows = useMemo(
    () => (remoteMode ? flattenItems(remote.items) : null),
    [remote.items, remoteMode],
  );

  const known = useMemo(() => {
    const map = new Map(knownRef.current);
    if (options) collectOptions(options, map);
    return map;
    // remote.items 变化时 knownRef 已更新，这里据此重算。
  }, [options, remote.items]);

  if (!remoteMode) {
    return {
      hasMore: false,
      belowMinimum: false,
      known,
      loadMore,
      reachedEnd: false,
      remote: false,
      retry,
      rows: localRows ?? [],
      searching: false,
      stale: false,
      status: 'ready',
    };
  }

  const searching =
    open &&
    !belowMinimum &&
    (remote.requestedQuery !== trimmed ||
      (remote.status === 'loading' && remote.query !== trimmed));
  return {
    belowMinimum,
    hasMore:
      !belowMinimum &&
      (!resetOnQueryChange || remote.query === trimmed) &&
      remote.nextCursor !== null,
    known,
    loadMore,
    reachedEnd: remote.status === 'ready' && remote.nextCursor === null && remote.pages > 1,
    remote: true,
    retry,
    rows:
      belowMinimum || (resetOnQueryChange && remote.query !== trimmed) ? [] : (remoteRows ?? []),
    searching: searching && trimmed !== '',
    stale: remote.status === 'loading' && remote.pages > 0,
    status: belowMinimum
      ? 'idle'
      : resetOnQueryChange && remote.requestedQuery !== trimmed
        ? 'loading'
        : remote.status,
  };
}
