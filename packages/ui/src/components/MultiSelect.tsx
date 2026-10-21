'use client';

import { ChevronDown } from 'lucide-react';
import {
  forwardRef,
  useCallback,
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
import { ChipList, type ChipItem, type ChipListHandle } from './select/Chips';
import { SelectPanel, type SelectAllState } from './select/SelectPanel';
import type { SelectOption, SelectSize, SelectSourceProps } from './select/types';
import { useResolvedOptions } from './select/useResolvedOptions';
import { useSelectCore } from './select/useSelectCore';
import { optionText, type SelectRow } from './select/utils';
import { Spinner } from './Spinner';

export type MultiSelectVariant = 'filled' | 'outlined';

export interface MultiSelectProps<Value extends string = string> extends Omit<
  SelectSourceProps<Value>,
  'searchLabel'
> {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-required'?: boolean | 'true' | 'false';
  autoFocus?: boolean;
  /** 只用于外部布局（宽度、外边距）。 */
  className?: string;
  /** 面板底部「清空」（锁定项不会被清掉）。不传则不显示。 */
  clearAllLabel?: ReactNode;
  defaultOpen?: boolean;
  defaultValue?: readonly Value[];
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  listboxClassName?: string;
  loading?: boolean;
  /** 最多可选几项；达到后其余选项禁用。 */
  max?: number;
  /** 达到上限时的提示，例如 `(n) => \`最多选择 ${n} 项\``。 */
  maxReachedLabel?: (max: number) => ReactNode;
  /** 最多显示几个胶囊（含 +N）；不传时按宽度算满 2 行。 */
  maxChips?: number;
  /** +N 胶囊的可读名称，例如 `(n) => \`另有 ${n} 项\``。 */
  moreLabel?: (count: number) => string;
  /** 同时为每个值渲染一个同名隐藏 input，供原生表单提交。 */
  name?: string;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onChange?: (value: Value[]) => void;
  onFocus?: FocusEventHandler<HTMLInputElement>;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  /** +N 弹出层的可读名称。 */
  overflowLabel?: string;
  placeholder?: string;
  /** 默认 true：面板挂到共享 portal 根。 */
  portal?: boolean;
  readOnly?: boolean;
  /** 胶囊 × 的可读名称，例如 `(label) => \`移除 ${label}\``。 */
  removeLabel: (label: string) => string;
  /** 输入框即搜索框（默认 true）。false 时只能从列表里点选。 */
  searchable?: boolean;
  /** 本地数据时在列表顶部提供「全选」（作用于当前搜索结果）。 */
  selectAllLabel?: ReactNode;
  /** 已选项不在已加载页里时用于显示标签。 */
  selectedOptions?: readonly SelectOption<Value>[];
  /** 面板底部「已选 N 项」。 */
  selectedCountLabel?: (count: number) => ReactNode;
  size?: SelectSize;
  value?: readonly Value[];
  variant?: MultiSelectVariant;
}

const EMPTY: readonly never[] = [];

function MultiSelectInner<Value extends string = string>(
  props: MultiSelectProps<Value>,
  ref: ForwardedRef<HTMLInputElement>,
) {
  const {
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-required': ariaRequired,
    autoFocus,
    className,
    clearAllLabel,
    creatable = false,
    createLabel,
    defaultOpen,
    defaultValue,
    disabled = false,
    emptyLabel,
    endLabel,
    errorLabel,
    filterOption,
    id,
    invalid = false,
    listboxClassName,
    loadOptions,
    loading = false,
    loadingLabel,
    max,
    maxChips,
    maxReachedLabel,
    moreLabel,
    name,
    onBlur,
    onChange,
    onCreate,
    onFocus,
    onOpenChange,
    open: openProp,
    options,
    overflowLabel,
    placeholder,
    portal = true,
    readOnly = false,
    removeLabel,
    resolveOptions,
    retryLabel,
    searchable = true,
    searchDebounceMs,
    minSearchLength,
    resetOnQueryChange,
    onSearchChange,
    minSearchLabel,
    searchPlaceholder,
    selectAllLabel,
    selectedCountLabel,
    selectedOptions,
    size,
    value: valueProp,
    variant = 'outlined',
  } = props;
  const controlled = Object.prototype.hasOwnProperty.call(props, 'value');
  const [internalValue, setInternalValue] = useState<readonly Value[]>(defaultValue ?? EMPTY);
  const value = (controlled ? valueProp : internalValue) ?? EMPTY;
  const valueRef = useRef(value);
  valueRef.current = value;
  const selectedSet = useMemo(() => new Set<string>(value), [value]);
  const interactive = !disabled && !readOnly;
  const maxReached = max !== undefined && value.length >= max;

  const rootRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const chipsRef = useRef<ChipListHandle>(null);

  const isOptionDisabled = useCallback(
    (option: SelectOption<Value>) => maxReached && !selectedSet.has(option.value),
    [maxReached, selectedSet],
  );

  const core = useSelectCore<Value>({
    creatable,
    defaultOpen,
    disabled: !interactive,
    filterOption,
    isOptionDisabled,
    loadOptions,
    onOpenChange,
    open: openProp,
    options,
    searchDebounceMs,
    minSearchLength,
    resetOnQueryChange,
    onSearchChange,
    selectAll: selectAllLabel !== undefined && loadOptions === undefined,
  });
  const { activeRow, isRowDisabled, open, rows, setOpen, source } = core;

  const resolved = useResolvedOptions({
    known: source.known,
    provided: selectedOptions,
    resolveOptions,
    values: value,
  });

  const commit = (next: readonly Value[]) => {
    if (!controlled) setInternalValue(next);
    onChange?.([...next]);
  };

  const isLocked = (candidate: Value) => resolved.lookup(candidate)?.locked === true;

  const remove = (key: string) => {
    const current = valueRef.current;
    if (!interactive || isLocked(key as Value) || !current.includes(key as Value)) return;
    commit(current.filter((item) => item !== key));
  };

  const toggle = (option: SelectOption<Value>) => {
    const current = valueRef.current;
    if (current.includes(option.value)) {
      if (option.locked) return;
      commit(current.filter((item) => item !== option.value));
    } else if (max === undefined || current.length < max) {
      commit([...current, option.value]);
    }
  };

  const visibleOptions = rows
    .filter((row): row is Extract<SelectRow<Value>, { kind: 'option' }> => row.kind === 'option')
    .map((row) => row.option)
    .filter((option) => option.disabled !== true);
  const selectedVisible = visibleOptions.filter((option) => selectedSet.has(option.value)).length;
  const selectAllState: SelectAllState =
    selectedVisible === 0 ? 'none' : selectedVisible === visibleOptions.length ? 'all' : 'some';

  const toggleAll = () => {
    const current = valueRef.current;
    if (selectAllState === 'all') {
      const removable = new Set(
        visibleOptions.filter((option) => !option.locked).map((option) => option.value),
      );
      commit(current.filter((item) => !removable.has(item)));
      return;
    }
    const next = [...current];
    for (const option of visibleOptions) {
      if (max !== undefined && next.length >= max) break;
      if (!next.includes(option.value)) next.push(option.value);
    }
    commit(next);
  };

  const clearAll = () => {
    commit(valueRef.current.filter((item) => isLocked(item)));
  };

  const activateRow = (row: SelectRow<Value> | undefined) => {
    if (row === undefined || isRowDisabled(row)) return;
    if (row.kind === 'option') toggle(row.option);
    else if (row.kind === 'select-all') toggleAll();
    else if (row.kind === 'create') {
      onCreate?.(row.query);
      core.setQuery('');
    }
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  const chips: ChipItem[] = value.map((item) => {
    const option = resolved.lookup(item);
    return {
      key: item,
      label: option?.label ?? null,
      locked: option?.locked,
      pending: option === undefined,
      text: option ? optionText(option) : '',
    };
  });

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!interactive) return;
        if (!open) core.openWithActive(event.key === 'ArrowDown' ? 'first' : 'last');
        else core.moveActive(event.key === 'ArrowDown' ? 1 : -1);
        return;
      case 'Home':
      case 'End':
        if (!open || core.query !== '') return;
        event.preventDefault();
        core.moveToEdge(event.key === 'Home' ? 'first' : 'last');
        return;
      case 'Enter':
        if (!interactive) return;
        event.preventDefault();
        if (!open) core.openWithActive();
        else activateRow(activeRow);
        return;
      case ' ':
        if (searchable && core.query !== '') return;
        if (!interactive) return;
        event.preventDefault();
        if (!open) core.openWithActive();
        else activateRow(activeRow);
        return;
      case 'Tab':
        if (open) setOpen(false);
        return;
      case 'Backspace':
      case 'ArrowLeft':
        if (core.query !== '' || !atStart) return;
        if (chipsRef.current?.focusLast()) event.preventDefault();
        return;
      default:
    }
  };

  const onEscapeCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };

  const invalidState = invalid || ariaInvalid === true || ariaInvalid === 'true';
  const removableCount = value.filter((item) => !isLocked(item)).length;
  const hasFooter =
    selectedCountLabel !== undefined ||
    (clearAllLabel !== undefined && removableCount > 0) ||
    (maxReached && maxReachedLabel !== undefined && max !== undefined);
  const footer = hasFooter ? (
    <div className="rx-select-footer">
      <span className="rx-select-footer-count">{selectedCountLabel?.(value.length)}</span>
      {maxReached && max !== undefined && maxReachedLabel !== undefined ? (
        <span className="rx-select-footer-max">{maxReachedLabel(max)}</span>
      ) : null}
      {clearAllLabel !== undefined && removableCount > 0 ? (
        <button
          className="rx-select-footer-action"
          onClick={clearAll}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          {clearAllLabel}
        </button>
      ) : null}
    </div>
  ) : undefined;

  return (
    <div
      className={cn('rx-select', 'rx-multi-select', 'rx-sized', className)}
      data-disabled={disabled || undefined}
      data-invalid={invalidState || undefined}
      data-readonly={readOnly || undefined}
      data-size={size}
      data-state={open ? 'open' : 'closed'}
      data-variant={variant}
      ref={rootRef}
    >
      <div
        className="rx-select-control"
        onClick={(event) => {
          // +N 的 Popover 通过 portal 渲染，React 事件仍会冒泡到这里：只处理控件自身 DOM 内的点击。
          if (!interactive || !controlRef.current?.contains(event.target as Node)) return;
          const onInput = event.target === inputRef.current;
          if (!open) core.openWithActive();
          else if (!onInput) setOpen(false);
          inputRef.current?.focus({ preventScroll: true });
        }}
        onMouseDown={(event) => {
          // 点在控件空白处或胶囊上时不让输入框失焦。
          if (!controlRef.current?.contains(event.target as Node)) return;
          if (event.target !== inputRef.current) event.preventDefault();
        }}
        ref={controlRef}
      >
        <ChipList
          handleRef={chipsRef}
          inputRef={inputRef}
          interactive={interactive}
          items={chips}
          maxChips={maxChips}
          moreLabel={moreLabel}
          onRemove={remove}
          overflowLabel={overflowLabel}
          removeLabel={removeLabel}
        >
          <input
            aria-activedescendant={core.activeId}
            aria-autocomplete={searchable ? 'list' : 'none'}
            aria-busy={loading || resolved.pending || undefined}
            aria-controls={core.listboxId}
            aria-describedby={ariaDescribedBy}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-invalid={invalidState || undefined}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            aria-readonly={readOnly || undefined}
            aria-required={ariaRequired}
            autoComplete="off"
            autoFocus={autoFocus}
            className="rx-select-input"
            disabled={disabled}
            id={id}
            onBlur={onBlur}
            onChange={(event) => {
              if (!searchable || !interactive) return;
              core.setQuery(event.target.value);
              if (!open) core.openWithActive();
            }}
            onFocus={onFocus}
            onKeyDown={onInputKeyDown}
            onKeyDownCapture={onEscapeCapture}
            placeholder={value.length === 0 ? (searchPlaceholder ?? placeholder) : undefined}
            readOnly={!searchable || !interactive}
            ref={mergeRefs(ref, inputRef)}
            role="combobox"
            spellCheck={false}
            type="text"
            value={core.query}
          />
        </ChipList>
        {loading || source.searching ? (
          <Spinner className="rx-select-spinner" size="sm" />
        ) : (
          <ChevronDown
            aria-hidden="true"
            className="rx-select-chevron"
            data-open={open || undefined}
            strokeWidth={1.5}
          />
        )}
      </div>
      {name !== undefined
        ? value.map((item) => <input key={item} name={name} type="hidden" value={item} />)
        : null}
      <SelectPanel
        anchorRef={controlRef}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        chrome
        core={core}
        createLabel={createLabel}
        emptyLabel={emptyLabel}
        endLabel={endLabel}
        errorLabel={errorLabel}
        footer={footer}
        isSelected={(optionValue) => selectedSet.has(optionValue)}
        listboxClassName={listboxClassName}
        loadingLabel={loadingLabel}
        minSearchLabel={minSearchLabel}
        multiple
        onDismiss={(reason) => {
          setOpen(false);
          if (reason === 'escape') inputRef.current?.focus({ preventScroll: true });
        }}
        onRowClick={activateRow}
        portal={portal}
        retryLabel={retryLabel}
        rootRef={rootRef}
        selectAllLabel={selectAllLabel}
        selectAllState={selectAllState}
      />
    </div>
  );
}

/**
 * 多选下拉（规范 03 §3.6）：已选项显示为固定宽度胶囊（最多 2 行，溢出收进 +N），
 * 输入框即搜索框；面板与 Select 相同（搜索、远程分页、状态行），选项前有复选标记，选择后面板保持打开。
 * 键盘：输入为空时 Backspace/← 聚焦最后一个胶囊，←/→ 在胶囊间移动，Backspace/Delete 删除当前。
 */
export const MultiSelect = forwardRef(MultiSelectInner) as <Value extends string = string>(
  props: MultiSelectProps<Value> & { ref?: Ref<HTMLInputElement> },
) => ReactElement | null;
