'use client';

import { ChevronDown, CircleX, Search, X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEventHandler,
  type ForwardedRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { focusAdjacent } from './select/focus';
import { SelectPanel } from './select/SelectPanel';
import type { ControlTouchTarget } from './Button';
import type { SelectOption, SelectSize, SelectSourceProps } from './select/types';
import { useResolvedOptions } from './select/useResolvedOptions';
import { useSelectCore } from './select/useSelectCore';
import { optionText, type SelectRow } from './select/utils';
import { Spinner } from './Spinner';

export type {
  FilterOption,
  LoadOptions,
  LoadOptionsParams,
  LoadOptionsResult,
  SelectCursor,
  SelectItem,
  SelectOption,
  SelectOptionGroup,
  SelectSize,
  SelectStatusLabels,
} from './select/types';

/** 触发器外观（规范 03 §3.5）：表单型 outlined / filled，页头筛选型 filter。 */
export type SelectVariant = 'filled' | 'filter' | 'outlined';

const TYPEAHEAD_RESET_MS = 500;

export interface SelectProps<Value extends string = string> extends SelectSourceProps<Value> {
  /** 无障碍名称；触发按钮与弹层共用。 */
  'aria-label'?: string;
  /** 可见标签元素 ID；触发按钮与弹层共用。 */
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-required'?: boolean | 'true' | 'false';
  autoFocus?: boolean;
  /** 只用于外部布局（宽度、外边距）。 */
  className?: string;
  /** 显示清除按钮（表单型悬停/聚焦时出现；筛选型激活后常驻为 ⊗）。 */
  clearable?: boolean;
  /** 清除按钮的可读名称，例如「清除」。 */
  clearLabel?: string;
  /** 非受控初始值。 */
  defaultValue?: Value;
  defaultOpen?: boolean;
  disabled?: boolean;
  /**
   * 代表「未选择 / 全部」的值：清除时回到它，筛选型选中它时不算激活。
   * 不传时清除把值置空并调用 onClear（受控用法请在 onClear 里把 value 置为 undefined）。
   */
  emptyValue?: Value;
  id?: string;
  invalid?: boolean;
  /** 直接加在 listbox 元素上（包括挂到 portal 时）。 */
  listboxClassName?: string;
  /** 触发器显示加载中（选项本身在准备）。 */
  loading?: boolean;
  /** 同时渲染隐藏 input，供原生表单提交。 */
  name?: string;
  onBlur?: FocusEventHandler<HTMLButtonElement>;
  onChange?: (value: Value) => void;
  onClear?: () => void;
  onFocus?: FocusEventHandler<HTMLButtonElement>;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  placeholder?: ReactNode;
  /**
   * 把弹层挂到共享 portal 根（跨越滚动容器裁剪、在弹窗里使用）。
   * 默认 false：弹层相对触发器绝对定位（兼容第一期调用）。
   */
  portal?: boolean;
  readOnly?: boolean;
  /** 面板顶部显示搜索框（打开即聚焦）。远程数据（loadOptions）与 creatable 时默认开启。 */
  searchable?: boolean;
  /** 当前值不在已加载选项里时用于显示标签。 */
  selectedOption?: SelectOption<Value>;
  size?: SelectSize;
  touchTarget?: ControlTouchTarget;
  value?: Value | undefined;
  variant?: SelectVariant;
}

function SelectInner<Value extends string = string>(
  props: SelectProps<Value>,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  const {
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-required': ariaRequired,
    autoFocus,
    className,
    clearable = false,
    clearLabel,
    creatable = false,
    createLabel,
    defaultOpen,
    defaultValue,
    disabled = false,
    emptyLabel,
    emptyValue,
    endLabel,
    errorLabel,
    filterOption,
    id,
    invalid = false,
    listboxClassName,
    loadOptions,
    loading = false,
    loadingLabel,
    name,
    onBlur,
    onChange,
    onClear,
    onCreate,
    onFocus,
    onOpenChange,
    open: openProp,
    options,
    placeholder,
    portal = false,
    readOnly = false,
    resolveOptions,
    retryLabel,
    searchDebounceMs,
    minSearchLength,
    resetOnQueryChange,
    onSearchChange,
    minSearchLabel,
    searchLabel,
    searchPlaceholder,
    selectedOption,
    size,
    touchTarget,
    value: valueProp,
    variant = 'outlined',
  } = props;
  const searchable = props.searchable ?? (loadOptions !== undefined || creatable);
  const controlled = Object.prototype.hasOwnProperty.call(props, 'value');
  const [internalValue, setInternalValue] = useState<Value | undefined>(defaultValue);
  const value = controlled ? valueProp : internalValue;

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeahead = useRef<{ buffer: string; timer: number | undefined }>({
    buffer: '',
    timer: undefined,
  });

  const core = useSelectCore<Value>({
    creatable,
    defaultOpen,
    disabled: disabled || readOnly,
    filterOption,
    loadOptions,
    onOpenChange,
    open: openProp,
    options,
    preferredValue: value,
    searchDebounceMs,
    minSearchLength,
    resetOnQueryChange,
    onSearchChange,
  });
  const { activeRow, isRowDisabled, open, rows, setOpen, source } = core;

  const values = useMemo(() => (value === undefined ? [] : [value]), [value]);
  const provided = useMemo(() => (selectedOption ? [selectedOption] : undefined), [selectedOption]);
  const resolved = useResolvedOptions({
    known: source.known,
    provided,
    resolveOptions,
    values,
  });
  const selected = value === undefined ? undefined : resolved.lookup(value);
  const resolving = value !== undefined && selected === undefined && resolved.pending;
  const hasValue = value !== undefined && value !== emptyValue;
  const filterActive = variant === 'filter' && hasValue;
  const interactive = !disabled && !readOnly;
  const showClear = clearable && interactive && hasValue && clearLabel !== undefined;

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus({ preventScroll: true });
  }, [open, searchable]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const commitValue = (next: Value | undefined) => {
    if (!controlled) setInternalValue(next);
    if (next !== undefined && next !== value) onChange?.(next);
  };

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger && searchable) triggerRef.current?.focus({ preventScroll: true });
  };

  const commitRow = (row: SelectRow<Value> | undefined) => {
    if (row === undefined || isRowDisabled(row)) return;
    if (row.kind === 'option') {
      close(true);
      commitValue(row.option.value);
    } else if (row.kind === 'create') {
      close(true);
      onCreate?.(row.query);
    }
  };

  const clear = () => {
    commitValue(emptyValue);
    onClear?.();
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const runTypeahead = (char: string) => {
    const state = typeahead.current;
    window.clearTimeout(state.timer);
    state.buffer += char.toLocaleLowerCase();
    state.timer = window.setTimeout(() => {
      state.buffer = '';
    }, TYPEAHEAD_RESET_MS);
    const candidates = rows
      .map((row, index) => ({ index, row }))
      .filter(({ row }) => row.kind === 'option' && !isRowDisabled(row));
    if (candidates.length === 0) return;
    const current = candidates.findIndex(({ index }) => index === core.activeIndex);
    const offset = state.buffer.length === 1 ? 1 : 0;
    for (let step = 0; step < candidates.length; step += 1) {
      const candidate =
        candidates[(Math.max(current, -1) + offset + step + candidates.length) % candidates.length];
      if (candidate.row.kind !== 'option') continue;
      if (optionText(candidate.row.option).toLocaleLowerCase().startsWith(state.buffer)) {
        if (!open) core.openWithActive();
        core.followActiveRef.current = true;
        core.setActiveKey(candidate.row.key);
        return;
      }
    }
  };

  /** 列表导航（触发器与搜索框共用）；返回是否已处理。 */
  const handleListKey = (event: KeyboardEvent<HTMLElement>, allowEdges: boolean): boolean => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) core.openWithActive(event.key === 'ArrowDown' ? 'first' : 'last');
      else core.moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if ((event.key === 'Home' || event.key === 'End') && allowEdges) {
      if (!open) return false;
      event.preventDefault();
      core.moveToEdge(event.key === 'Home' ? 'first' : 'last');
      return true;
    }
    return false;
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (handleListKey(event, true)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) core.openWithActive();
      else commitRow(activeRow);
      return;
    }
    if (event.key === 'Tab') {
      if (open) setOpen(false);
      return;
    }
    if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      interactive
    ) {
      if (searchable) {
        event.preventDefault();
        if (!open) core.openWithActive();
        core.setQuery(event.key);
      } else {
        runTypeahead(event.key);
      }
    }
  };

  const onEscapeCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (handleListKey(event, core.query === '')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRow(activeRow);
      return;
    }
    if (event.key === 'Tab') {
      const trigger = triggerRef.current;
      setOpen(false);
      if (!trigger) return;
      const panel = document
        .getElementById(core.listboxId)
        ?.closest<HTMLElement>('.rx-select-panel');
      if (focusAdjacent(trigger, event.shiftKey ? -1 : 1, panel ?? null)) event.preventDefault();
      else trigger.focus();
    }
  };

  const triggerLabel: ReactNode = selected
    ? selected.label
    : resolving
      ? null
      : (placeholder ?? '');
  const isPlaceholder = selected === undefined && !resolving;

  const search = searchable ? (
    <div className="rx-select-search">
      <Search aria-hidden="true" className="rx-select-search-icon" strokeWidth={1.5} />
      <input
        aria-activedescendant={core.activeId}
        aria-autocomplete="list"
        aria-controls={core.listboxId}
        aria-expanded={open}
        aria-label={searchLabel ?? ariaLabel}
        aria-labelledby={searchLabel === undefined ? ariaLabelledBy : undefined}
        autoComplete="off"
        className="rx-select-search-input"
        onChange={(event) => core.setQuery(event.target.value)}
        onKeyDown={onSearchKeyDown}
        onKeyDownCapture={onEscapeCapture}
        placeholder={searchPlaceholder}
        ref={searchRef}
        role="combobox"
        spellCheck={false}
        type="text"
        value={core.query}
      />
      {source.searching ? <Spinner className="rx-select-search-spinner" size="sm" /> : null}
    </div>
  ) : undefined;

  return (
    <div
      className={cn('rx-select', 'rx-sized', className)}
      data-active={filterActive || undefined}
      data-clearable={showClear || undefined}
      data-disabled={disabled || undefined}
      data-invalid={invalid || ariaInvalid === true || ariaInvalid === 'true' || undefined}
      data-readonly={readOnly || undefined}
      data-size={size}
      data-touch-target={touchTarget}
      data-state={open ? 'open' : 'closed'}
      data-variant={variant}
      ref={rootRef}
    >
      <button
        aria-activedescendant={searchable ? undefined : core.activeId}
        aria-busy={loading || resolving || undefined}
        aria-controls={core.listboxId}
        aria-describedby={ariaDescribedBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={invalid || ariaInvalid === true || ariaInvalid === 'true' || undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-readonly={readOnly || undefined}
        aria-required={ariaRequired}
        autoFocus={autoFocus}
        className="rx-select-trigger"
        disabled={disabled}
        id={id}
        onBlur={onBlur}
        onClick={() => {
          if (!interactive) return;
          if (open) setOpen(false);
          else core.openWithActive();
        }}
        onFocus={onFocus}
        onKeyDown={onTriggerKeyDown}
        onKeyDownCapture={onEscapeCapture}
        ref={mergeRefs(ref, triggerRef)}
        role="combobox"
        type="button"
      >
        <span className={cn('rx-select-value', isPlaceholder && 'rx-select-placeholder')}>
          {triggerLabel}
        </span>
        {loading ? (
          <Spinner className="rx-select-spinner" size="sm" />
        ) : (
          <ChevronDown
            aria-hidden="true"
            className="rx-select-chevron"
            data-open={open || undefined}
            strokeWidth={1.5}
          />
        )}
      </button>
      {showClear ? (
        <button
          aria-label={clearLabel}
          className="rx-select-clear"
          onClick={(event) => {
            event.preventDefault();
            clear();
          }}
          type="button"
        >
          {variant === 'filter' ? (
            <CircleX aria-hidden="true" strokeWidth={1.5} />
          ) : (
            <X aria-hidden="true" strokeWidth={1.5} />
          )}
        </button>
      ) : null}
      {name !== undefined ? <input name={name} type="hidden" value={value ?? ''} /> : null}
      <SelectPanel
        anchorRef={triggerRef}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        chrome={searchable || source.remote || creatable || emptyLabel !== undefined}
        core={core}
        createLabel={createLabel}
        emptyLabel={emptyLabel}
        endLabel={endLabel}
        errorLabel={errorLabel}
        isSelected={(optionValue) => optionValue === value}
        listboxClassName={listboxClassName}
        loadingLabel={loadingLabel}
        minSearchLabel={minSearchLabel}
        multiple={false}
        onDismiss={(reason) => close(reason === 'escape')}
        onRowClick={commitRow}
        portal={portal}
        retryLabel={retryLabel}
        rootRef={rootRef}
        search={search}
        touchTarget={touchTarget}
      />
    </div>
  );
}

/**
 * 单选下拉（规范 03 §3.5）。一律用它替代原生 select。
 *
 * ARIA combobox + listbox：↑/↓ 移动、Enter/Space 选择、Esc 关闭、Home/End、Tab 关闭并移到下一个控件；
 * 可搜索时打开即聚焦面板顶部搜索框，直接输入即搜索；不可搜索时按字母键直达匹配项。
 * 数据：本地 `options`（可分组、可 filterOption）或远程 `loadOptions`（分页、防抖、可取消、失败重试）。
 */
export const Select = forwardRef(SelectInner) as <Value extends string = string>(
  props: SelectProps<Value> & { ref?: Ref<HTMLButtonElement> },
) => ReactElement | null;
