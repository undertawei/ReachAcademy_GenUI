'use client';

import { X, Plus } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import { usePrefersReducedMotion } from '../primitives/usePrefersReducedMotion';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** 值里可能有空格等字符，生成 id 前做一次转义，保证 aria-controls / aria-labelledby 可解析。 */
function idSafe(value: string): string {
  return Array.from(value, (char) =>
    /[A-Za-z0-9_-]/.test(char) ? char : `.${char.codePointAt(0)?.toString(36)}`,
  ).join('');
}

/** 横向 tablist 的方向键：←/→ 循环，Home/End 到首末；返回目标下标或 undefined。 */
function nextTabIndex(key: string, current: number, count: number): number | undefined {
  if (count === 0) return undefined;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowLeft') return current < 0 ? count - 1 : (current - 1 + count) % count;
  return undefined;
}

type TabRegistry = {
  /** 第一个可用 Tab 的值：未指定值时默认选中它。 */
  first: string | undefined;
  /** 当前选中值是否对应某个 Tab；否则让第一个 Tab 承担 Tab 键落点。 */
  hasSelected: boolean;
};

type TabsContextValue = {
  baseId: string;
  keepMounted: boolean;
  registry: TabRegistry;
  select: (value: string) => void;
  selected: string | undefined;
  setRegistry: (registry: TabRegistry) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error(`<${component}> must be rendered inside <Tabs>.`);
  return context;
}

export type TabsProps = Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> & {
  /** 非受控初始值；不传时选中第一个可用 Tab（不触发 onChange）。 */
  defaultValue?: string;
  /** 访问过的面板在切走后保持挂载（隐藏），用于含未保存表单的面板。默认懒渲染且切走即卸载。 */
  keepMounted?: boolean;
  /** 页面级主 Tab 需要同步到 `?tab=` 时，由页面在这里写 URL（组件不读写 URL）。 */
  onChange?: (value: string) => void;
  /** 文字 14（md，默认，列表页）或 16（lg，向导区块）。 */
  size?: 'lg' | 'md';
  value?: string;
  /** `underline`（默认，页面/面板主 Tab）或 `panel`（学习页右侧：16px 图标 + 14 文字）。 */
  variant?: 'panel' | 'underline';
};

/**
 * 标签页（规范 03 §3.11，APG Tabs 自动激活）：`<Tabs><TabList><Tab/></TabList><TabPanel/></Tabs>`。
 * ←/→ 移动焦点并激活，Home/End；下划线从旧位置滑到新位置（moderate + standard），面板淡入（fast）。
 */
export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  {
    className,
    defaultValue,
    keepMounted = false,
    onChange,
    size,
    value: valueProp,
    variant = 'underline',
    ...props
  },
  ref,
) {
  const baseId = useId();
  const [value, setValue] = useControllableState<string | undefined>({
    defaultValue,
    onChange: (next) => {
      if (next !== undefined) onChange?.(next);
    },
    value: valueProp,
  });
  const [registry, setRegistry] = useState<TabRegistry>({ first: undefined, hasSelected: true });
  const selected = value ?? registry.first;

  return (
    <TabsContext.Provider
      value={{
        baseId,
        keepMounted,
        registry,
        select: setValue,
        selected,
        setRegistry,
      }}
    >
      <div
        className={cn('rx-tabs', className)}
        data-size={size}
        data-variant={variant}
        ref={ref}
        {...props}
      />
    </TabsContext.Provider>
  );
});

export type TabListProps = HTMLAttributes<HTMLDivElement>;

/** Tab 容器（role=tablist），负责键盘导航与滑动下划线。需要 `aria-label` 或 `aria-labelledby`。 */
export const TabList = forwardRef<HTMLDivElement, TabListProps>(function TabList(
  { children, className, onKeyDown, ...props },
  ref,
) {
  const context = useTabsContext('TabList');
  const { registry, selected, setRegistry, select } = context;
  const listRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ width: number; x: number } | null>(null);

  const tabs = useCallback((): HTMLButtonElement[] => {
    const list = listRef.current;
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
      (tab) => tab.closest('[role="tablist"]') === list,
    );
  }, []);

  const measure = useCallback(() => {
    const list = listRef.current;
    const tab = tabs().find((item) => item.getAttribute('aria-selected') === 'true');
    const content = tab?.querySelector<HTMLElement>('.rx-tab-content') ?? tab;
    if (!list || !content) {
      setIndicator(null);
      return;
    }
    const listRect = list.getBoundingClientRect();
    const rect = content.getBoundingClientRect();
    const next = { width: rect.width, x: rect.left - listRect.left + list.scrollLeft };
    setIndicator((current) =>
      current && current.width === next.width && current.x === next.x ? current : next,
    );
  }, [tabs]);

  // 第一个可用 Tab 作为未指定值时的默认选中项；每次渲染同步（Tab 可能增删）。
  useIsomorphicLayoutEffect(() => {
    const all = tabs();
    const first = all.find((tab) => !tab.disabled)?.dataset.value;
    const hasSelected = all.some((tab) => tab.dataset.value === selected);
    if (first !== registry.first || hasSelected !== registry.hasSelected) {
      setRegistry({ first, hasSelected });
    }
  });

  useIsomorphicLayoutEffect(() => {
    measure();
  }, [measure, selected, children]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(list);
    for (const tab of tabs()) observer.observe(tab);
    return () => observer.disconnect();
  }, [measure, tabs, children]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const enabled = tabs().filter((tab) => !tab.disabled);
    const current = enabled.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const next = nextTabIndex(event.key, current, enabled.length);
    if (next === undefined) return;
    event.preventDefault();
    const tab = enabled[next];
    tab.focus();
    const tabValue = tab.dataset.value;
    if (tabValue !== undefined) select(tabValue);
  };

  const indicatorStyle =
    indicator === null
      ? undefined
      : ({
          '--rx-tab-indicator-width': indicator.width,
          '--rx-tab-indicator-x': `${indicator.x}px`,
        } as CSSProperties);

  return (
    <div
      aria-orientation="horizontal"
      className={cn('rx-tab-list', className)}
      onKeyDown={handleKeyDown}
      ref={mergeRefs(ref, listRef)}
      role="tablist"
      {...props}
    >
      {children}
      <span
        aria-hidden="true"
        className="rx-tab-indicator"
        data-state={indicator === null || indicator.width === 0 ? 'hidden' : 'visible'}
        style={indicatorStyle}
      />
    </div>
  );
});

export type TabProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> & {
  /** 文字后的数量（「我创建的课程 3」）。 */
  count?: ReactNode;
  /** 16px 图标（`variant="panel"` 常用）。 */
  icon?: ReactNode;
  value: string;
};

export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { children, className, count, icon, onClick, type = 'button', value, ...props },
  ref,
) {
  const { baseId, registry, select, selected } = useTabsContext('Tab');
  const isSelected = selected === value;
  // 选中值不在列表里（受控传了未知值）时，让第一个可用 Tab 可被 Tab 键聚焦。
  const focusable = isSelected || (!registry.hasSelected && value === registry.first);
  return (
    <button
      aria-controls={`${baseId}-panel-${idSafe(value)}`}
      aria-selected={isSelected}
      className={cn('rx-tab', className)}
      data-state={isSelected ? 'selected' : 'unselected'}
      data-value={value}
      id={`${baseId}-tab-${idSafe(value)}`}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) select(value);
      }}
      ref={ref}
      role="tab"
      tabIndex={focusable ? 0 : -1}
      type={type}
      {...props}
    >
      <span className="rx-tab-content">
        {icon === undefined || icon === null ? null : (
          <span aria-hidden="true" className="rx-tab-icon">
            {icon}
          </span>
        )}
        <span className="rx-tab-label">{children}</span>
        {count === undefined || count === null ? null : (
          <span className="rx-tab-count rx-numeric">{count}</span>
        )}
      </span>
    </button>
  );
});

export type TabPanelProps = HTMLAttributes<HTMLDivElement> & {
  /** 覆盖 Tabs 的 `keepMounted`（只对本面板）。 */
  keepMounted?: boolean;
  value: string;
};

/** 标签面板：默认只渲染选中项；`keepMounted` 时访问过的面板切走后隐藏而不卸载。 */
export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
  { children, className, keepMounted, value, ...props },
  ref,
) {
  const context = useTabsContext('TabPanel');
  const isSelected = context.selected === value;
  const keep = keepMounted ?? context.keepMounted;
  const [visited, setVisited] = useState(isSelected);
  if (isSelected && !visited) setVisited(true);
  const mounted = isSelected || (keep && visited);
  if (!mounted) return null;
  return (
    <div
      aria-labelledby={`${context.baseId}-tab-${idSafe(value)}`}
      className={cn('rx-tab-panel', className)}
      data-state={isSelected ? 'active' : 'inactive'}
      hidden={!isSelected}
      id={`${context.baseId}-panel-${idSafe(value)}`}
      ref={ref}
      role="tabpanel"
      tabIndex={0}
      {...props}
    >
      {children}
    </div>
  );
});

export interface ClosableTabItem {
  /** 为 false 时不显示 × 且 Delete 键不关闭（例如最后一份试卷）。默认 true。 */
  closable?: boolean;
  id: string;
  label: string;
}

export type ClosableTabsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'defaultValue' | 'onChange'
> & {
  /** 「+ 添加试卷」按钮文案；与 `onAdd` 同时提供时显示。 */
  addLabel?: ReactNode;
  /** 关闭按钮的可读名称，例如 `(label) => t('closeTab', { label })`。 */
  closeLabel: (label: string) => string;
  defaultValue?: string;
  /** 对应面板 id（写到 `aria-controls`），面板由调用方渲染。 */
  getPanelId?: (id: string) => string;
  items: readonly ClosableTabItem[];
  onAdd?: () => void;
  onChange?: (id: string) => void;
  /** 点 × 或在标签上按 Delete 时调用；是否二次确认（有内容时）由调用方决定。 */
  onClose?: (id: string) => void;
  value?: string;
};

/**
 * 可关闭标签（规范 03 §3.11，多份试卷）：高 30、圆角 4；选中 `surface-warm-strong` 底 + `primary` 描边。
 * 溢出时横向滚动并显示两端渐隐；键盘 ←/→/Home/End 切换，Delete 关闭当前标签（× 按钮不进 Tab 序列）。
 */
export const ClosableTabs = forwardRef<HTMLDivElement, ClosableTabsProps>(function ClosableTabs(
  {
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    addLabel,
    className,
    closeLabel,
    defaultValue,
    getPanelId,
    items,
    onAdd,
    onChange,
    onClose,
    value: valueProp,
    ...props
  },
  ref,
) {
  const baseId = useId();
  const reducedMotion = usePrefersReducedMotion();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useControllableState<string | undefined>({
    defaultValue,
    onChange: (next) => {
      if (next !== undefined) onChange?.(next);
    },
    value: valueProp,
  });
  const selectedIndex = items.findIndex((item) => item.id === value);
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

  const updateOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const start = scroller.scrollLeft > 1;
    const end = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    scroller.toggleAttribute('data-overflow-start', start);
    scroller.toggleAttribute('data-overflow-end', end);
  }, []);

  useIsomorphicLayoutEffect(() => {
    updateOverflow();
  }, [items, updateOverflow]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => updateOverflow());
    observer.observe(scroller);
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [updateOverflow]);

  const tabElements = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);

  // 选中项滚动到可见（规范 02 S9）。
  useEffect(() => {
    if (value === undefined) return;
    const tab = tabElements().find((element) => element.dataset.id === value);
    tab?.scrollIntoView?.({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [value, reducedMotion]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const item = items[index];
    if (event.key === 'Delete' && item && item.closable !== false && onClose) {
      event.preventDefault();
      onClose(item.id);
      return;
    }
    const next = nextTabIndex(event.key, index, items.length);
    if (next === undefined) return;
    event.preventDefault();
    tabElements()[next]?.focus();
    setValue(items[next].id);
  };

  const hasAdd = onAdd !== undefined && addLabel !== undefined && addLabel !== null;

  return (
    <div className={cn('rx-closable-tabs', className)} ref={ref} {...props}>
      <div
        className="rx-closable-tabs-scroller rx-scroll-x rx-scroll-hidden rx-scroll-fade"
        onScroll={updateOverflow}
        ref={scrollerRef}
      >
        <div
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-orientation="horizontal"
          className="rx-closable-tabs-list"
          ref={listRef}
          role="tablist"
        >
          {items.map((item, index) => {
            const selected = index === selectedIndex;
            const closable = item.closable !== false && onClose !== undefined;
            return (
              <div
                className="rx-closable-tab"
                data-state={selected ? 'selected' : 'unselected'}
                key={item.id}
                role="presentation"
              >
                <button
                  aria-controls={getPanelId?.(item.id)}
                  aria-keyshortcuts={closable ? 'Delete' : undefined}
                  aria-selected={selected}
                  className="rx-closable-tab-trigger"
                  data-id={item.id}
                  id={`${baseId}-tab-${idSafe(item.id)}`}
                  onClick={() => setValue(item.id)}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                  role="tab"
                  tabIndex={index === tabStop ? 0 : -1}
                  title={item.label}
                  type="button"
                >
                  {item.label}
                </button>
                {closable ? (
                  <button
                    aria-label={closeLabel(item.label)}
                    className="rx-closable-tab-close"
                    onClick={() => onClose?.(item.id)}
                    tabIndex={-1}
                    type="button"
                  >
                    <X aria-hidden="true" strokeWidth={1.5} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {hasAdd ? (
          <button className="rx-closable-tabs-add" onClick={onAdd} type="button">
            <Plus aria-hidden="true" className="rx-closable-tabs-add-icon" strokeWidth={1.5} />
            <span>{addLabel}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
});
