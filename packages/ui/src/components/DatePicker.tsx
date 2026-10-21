'use client';

import { CalendarDays, Clock, X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ForwardedRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { cn } from '../cn';
import { useFocusTrap } from '../primitives/focus';
import { Portal, useLayer } from '../primitives/layer';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import { useFloating } from '../primitives/useFloating';
import { usePresence } from '../primitives/usePresence';
import type { ControlSize } from './Button';
import {
  Calendar,
  clampISODate,
  formatTime,
  isValidISODate,
  parseISODate,
  parseTime,
  TimeList,
  todayISO,
  toISODate,
  useDateFormatter,
  useResolvedLocale,
  type CalendarLabels,
} from './DateCalendar';

// —— 公共类型 ——

export interface DatePickerLabels extends CalendarLabels {
  /** 清除按钮的可读名称（`clearable` 时必填）。 */
  clear?: string;
  /** 浮层（role=dialog）的可读名称。 */
  dialog?: string;
  /** 时间列表（role=listbox）的可读名称，DateTimePicker 使用。 */
  time?: string;
}

export interface TimePickerLabels {
  clear?: string;
  dialog?: string;
  time?: string;
}

interface FieldBaseProps {
  'aria-describedby'?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  autoFocus?: boolean;
  className?: string;
  /** 有值时显示清除按钮（需要 `labels.clear`）。 */
  clearable?: boolean;
  defaultOpen?: boolean;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  /** 显示语言，默认取 `<html lang>`，否则 zh-CN。 */
  locale?: string;
  /** 表单提交用：渲染同名 hidden input，值为 ISO 字符串。 */
  name?: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  size?: ControlSize;
}

interface CalendarBaseProps {
  /** 不可选日期（`YYYY-MM-DD` 与对应的本地 Date）。 */
  disabledDate?: (date: string, jsDate: Date) => boolean;
  /** 可选范围上限（含），`YYYY-MM-DD`。 */
  max?: string;
  /** 可选范围下限（含），`YYYY-MM-DD`。 */
  min?: string;
  /** 面板里标记的「今天」（`YYYY-MM-DD`）；业务时区与浏览器不同时传入，默认按浏览器时区。 */
  today?: string;
  /** 一周从星期几开始，0 = 周日，默认 1（周一）。 */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

// —— 触发器 ——

interface DateFieldProps extends FieldBaseProps {
  anchorRef: RefObject<HTMLDivElement | null>;
  clearLabel?: string;
  display?: 'field' | 'pill';
  forwardedRef: ForwardedRef<HTMLButtonElement>;
  hiddenValue: string;
  icon: ReactNode;
  onClear: () => void;
  onToggle: () => void;
  open: boolean;
  panelId: string;
  text: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

function DateField({
  'aria-describedby': ariaDescribedBy,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  anchorRef,
  autoFocus,
  className,
  clearLabel,
  clearable,
  disabled = false,
  display = 'field',
  forwardedRef,
  hiddenValue,
  icon,
  id,
  invalid = false,
  name,
  onClear,
  onToggle,
  open,
  panelId,
  placeholder,
  readOnly = false,
  size,
  text,
  triggerRef,
}: DateFieldProps) {
  const showClear =
    clearable && text !== null && !disabled && !readOnly && clearLabel !== undefined;
  return (
    <div
      className={cn('rx-date-field', 'rx-sized', className)}
      data-disabled={disabled ? 'true' : undefined}
      data-invalid={invalid ? 'true' : undefined}
      data-readonly={readOnly ? 'true' : undefined}
      data-size={size}
      data-state={open ? 'open' : 'closed'}
      data-variant={display}
      ref={anchorRef}
    >
      <button
        aria-controls={open ? panelId : undefined}
        aria-describedby={ariaDescribedBy}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        autoFocus={autoFocus}
        className="rx-date-field-trigger"
        data-clearable={showClear ? 'true' : undefined}
        disabled={disabled}
        id={id}
        onClick={() => {
          if (!readOnly) onToggle();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key === 'ArrowDown' && !open && !readOnly) {
            event.preventDefault();
            onToggle();
          }
        }}
        ref={mergeRefs(forwardedRef, triggerRef)}
        type="button"
      >
        <span className={text === null ? 'rx-date-field-placeholder' : 'rx-date-field-value'}>
          {text ?? placeholder}
        </span>
        <span aria-hidden="true" className="rx-date-field-icon">
          {icon}
        </span>
      </button>
      {showClear ? (
        <button
          aria-label={clearLabel}
          className="rx-date-field-clear"
          onClick={() => {
            onClear();
            triggerRef.current?.focus();
          }}
          type="button"
        >
          <X aria-hidden="true" strokeWidth={1.5} />
        </button>
      ) : null}
      {name === undefined ? null : <input name={name} type="hidden" value={hiddenValue} />}
    </div>
  );
}

// —— 浮层 ——

function PickerPanel({
  anchorRef,
  children,
  className,
  id,
  initialFocusRef,
  label,
  onClose,
  open,
  triggerRef,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  id: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  label?: string;
  onClose: () => void;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const presence = usePresence<HTMLDivElement>(open);
  const floating = useFloating({
    anchor: anchorRef,
    floating: panelRef,
    matchWidth: 'none',
    open: presence.mounted,
    placement: 'bottom-start',
  });
  const layer = useLayer({
    active: open,
    elements: [anchorRef, panelRef],
    kind: 'dropdown',
    onDismiss: (reason) => {
      onClose();
      if (reason === 'escape') triggerRef.current?.focus({ preventScroll: true });
    },
  });
  useFocusTrap({
    active: open,
    container: panelRef,
    initialFocus: initialFocusRef,
    returnFocus: false,
  });

  // 选择或 Esc 关闭后焦点回到触发器；点击外部时焦点留在用户点的地方。
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    return () => {
      const active = document.activeElement;
      if (panel?.contains(active) || active === document.body || active === null) {
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
  }, [open, triggerRef]);

  if (!presence.mounted) return null;
  return (
    <Portal>
      <layer.Provider>
        <div
          aria-label={label}
          aria-modal="true"
          className={cn('rx-floating-panel', 'rx-date-panel', className)}
          data-side={floating.side}
          data-state={presence.state}
          id={id}
          ref={(node) => {
            panelRef.current = node;
            presence.ref(node);
          }}
          role="dialog"
          style={{ ...floating.style, zIndex: layer.zIndex }}
        >
          {children}
        </div>
      </layer.Provider>
    </Portal>
  );
}

/** 打开时（含受控打开）重算的派生状态，避免在 effect 里 setState 导致焦点落到旧格子。 */
function useOnOpen(open: boolean, onOpen: () => void) {
  const [previous, setPrevious] = useState(open);
  if (previous !== open) {
    setPrevious(open);
    if (open) onOpen();
  }
}

function initialFocusDate(candidate: string | null | undefined, min?: string, max?: string) {
  return clampISODate(isValidISODate(candidate) ? candidate : todayISO(), min, max);
}

// —— DatePicker ——

export interface DatePickerProps extends FieldBaseProps, CalendarBaseProps {
  defaultValue?: string | null;
  /** `pill`：工具条里的紧凑胶囊触发器（surface-muted 底 + 日历图标），规范 03 §3.30。默认 `field`。 */
  display?: 'field' | 'pill';
  /** 自定义展示文字；默认 `Intl.DateTimeFormat(locale)` 的年月日。 */
  formatValue?: (value: string) => string;
  labels: DatePickerLabels;
  onChange?: (value: string | null) => void;
  /** `YYYY-MM-DD`；无值传 null。 */
  value?: string | null;
}

/**
 * 日期选择（规范 03 §3.30，APG Date Picker Dialog）。触发器外观同 Input，面板为共享浮层；
 * 方向键按日/周移动，PageUp/PageDown 按月（Shift 按年），Home/End 到周首/周末，Enter 选择，Esc 关闭。
 */
export const DatePicker = forwardRef<HTMLButtonElement, DatePickerProps>(function DatePicker(
  {
    defaultOpen = false,
    defaultValue = null,
    disabledDate,
    display = 'field',
    formatValue,
    labels,
    locale: localeProp,
    max,
    min,
    onChange,
    onOpenChange,
    open: openProp,
    today,
    value: valueProp,
    weekStartsOn = 1,
    ...field
  },
  ref,
) {
  const [value, setValue] = useControllableState<string | null>({
    defaultValue,
    onChange,
    value: valueProp,
  });
  const [open, setOpen] = useControllableState({
    defaultValue: defaultOpen,
    onChange: onOpenChange,
    value: openProp,
  });
  const locale = useResolvedLocale(localeProp);
  const formatter = useDateFormatter(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const panelId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const cellRef = useRef<HTMLElement | null>(null);
  const [focused, setFocused] = useState(() => initialFocusDate(value, min, max));
  useOnOpen(open, () => setFocused(initialFocusDate(value, min, max)));

  const date = parseISODate(value);
  const text =
    value === null || value === ''
      ? null
      : date === null
        ? value
        : (formatValue?.(value) ?? formatter.format(date));

  return (
    <>
      <DateField
        {...field}
        anchorRef={anchorRef}
        clearLabel={labels.clear}
        display={display}
        forwardedRef={ref}
        hiddenValue={value ?? ''}
        icon={<CalendarDays strokeWidth={1.5} />}
        onClear={() => setValue(null)}
        onToggle={() => setOpen((current) => !current)}
        open={open}
        panelId={panelId}
        text={text}
        triggerRef={triggerRef}
      />
      <PickerPanel
        anchorRef={anchorRef}
        id={panelId}
        initialFocusRef={cellRef}
        label={labels.dialog}
        onClose={() => setOpen(false)}
        open={open && !field.disabled}
        triggerRef={triggerRef}
      >
        <Calendar
          activeCellRef={cellRef}
          disabledDate={disabledDate}
          focusedDate={focused}
          labels={labels}
          locale={locale}
          max={max}
          min={min}
          onFocusedDateChange={setFocused}
          onSelect={(next) => {
            setValue(next);
            setOpen(false);
          }}
          selected={value}
          today={today}
          weekStartsOn={weekStartsOn}
        />
      </PickerPanel>
    </>
  );
});

// —— DateRangePicker ——

export interface DateRange {
  /** `YYYY-MM-DD`，含。 */
  end: string;
  /** `YYYY-MM-DD`，含。 */
  start: string;
}

export interface DateRangePickerProps extends FieldBaseProps, CalendarBaseProps {
  defaultValue?: DateRange | null;
  /** `pill`：展示态胶囊（surface-muted 底 + 日历图标），规范 03 §3.30。 */
  display?: 'field' | 'pill';
  formatValue?: (value: DateRange) => string;
  labels: DatePickerLabels;
  onChange?: (value: DateRange | null) => void;
  value?: DateRange | null;
}

/** 日期范围：两次点击确定起止，第二次点击前悬停/键盘移动实时预览区间。 */
export const DateRangePicker = forwardRef<HTMLButtonElement, DateRangePickerProps>(
  function DateRangePicker(
    {
      defaultOpen = false,
      defaultValue = null,
      disabledDate,
      display = 'field',
      formatValue,
      labels,
      locale: localeProp,
      max,
      min,
      onChange,
      onOpenChange,
      open: openProp,
      today,
      value: valueProp,
      weekStartsOn = 1,
      ...field
    },
    ref,
  ) {
    const [value, setValue] = useControllableState<DateRange | null>({
      defaultValue,
      onChange,
      value: valueProp,
    });
    const [open, setOpen] = useControllableState({
      defaultValue: defaultOpen,
      onChange: onOpenChange,
      value: openProp,
    });
    const locale = useResolvedLocale(localeProp);
    const formatter = useDateFormatter(locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const panelId = useId();
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const cellRef = useRef<HTMLElement | null>(null);
    const [focused, setFocused] = useState(() => initialFocusDate(value?.start, min, max));
    const [anchor, setAnchor] = useState<string | null>(null);
    const [hover, setHover] = useState<string | null>(null);
    useOnOpen(open, () => {
      setFocused(initialFocusDate(value?.start, min, max));
      setAnchor(null);
      setHover(null);
    });

    const format = (iso: string) => {
      const date = parseISODate(iso);
      return date === null ? iso : formatter.format(date);
    };
    const text =
      value === null
        ? null
        : (formatValue?.(value) ?? `${format(value.start)} — ${format(value.end)}`);

    let rangeStart: string | null = value?.start ?? null;
    let rangeEnd: string | null = value?.end ?? null;
    if (anchor !== null) {
      const other = hover ?? focused;
      rangeStart = anchor < other ? anchor : other;
      rangeEnd = anchor < other ? other : anchor;
    }

    return (
      <>
        <DateField
          {...field}
          anchorRef={anchorRef}
          clearLabel={labels.clear}
          display={display}
          forwardedRef={ref}
          hiddenValue={value === null ? '' : `${value.start}/${value.end}`}
          icon={<CalendarDays strokeWidth={1.5} />}
          onClear={() => setValue(null)}
          onToggle={() => setOpen((current) => !current)}
          open={open}
          panelId={panelId}
          text={text}
          triggerRef={triggerRef}
        />
        <PickerPanel
          anchorRef={anchorRef}
          id={panelId}
          initialFocusRef={cellRef}
          label={labels.dialog}
          onClose={() => setOpen(false)}
          open={open && !field.disabled}
          triggerRef={triggerRef}
        >
          <Calendar
            activeCellRef={cellRef}
            disabledDate={disabledDate}
            focusedDate={focused}
            labels={labels}
            locale={locale}
            max={max}
            min={min}
            onFocusedDateChange={(next) => {
              setFocused(next);
              setHover(null);
            }}
            onHoverDate={setHover}
            onSelect={(next) => {
              if (anchor === null) {
                setAnchor(next);
                return;
              }
              setValue(
                anchor <= next ? { end: next, start: anchor } : { end: anchor, start: next },
              );
              setAnchor(null);
              setOpen(false);
            }}
            rangeEnd={rangeEnd}
            rangeStart={rangeStart}
            today={today}
            weekStartsOn={weekStartsOn}
          />
        </PickerPanel>
      </>
    );
  },
);

// —— TimePicker ——

export interface TimePickerProps extends FieldBaseProps {
  defaultValue?: string | null;
  formatValue?: (value: string) => string;
  labels?: TimePickerLabels;
  /** 可选上限 `HH:mm`（含）。 */
  max?: string;
  /** 可选下限 `HH:mm`（含）。 */
  min?: string;
  onChange?: (value: string | null) => void;
  /** 步进分钟数，默认 30。 */
  step?: 15 | 30;
  /** `HH:mm`（24 小时制）；无值传 null。 */
  value?: string | null;
}

/** 时间选择：按 15/30 分钟步进的列表（规范 03 §3.30）。 */
export const TimePicker = forwardRef<HTMLButtonElement, TimePickerProps>(function TimePicker(
  {
    defaultOpen = false,
    defaultValue = null,
    formatValue,
    labels = {},
    locale: localeProp,
    max,
    min,
    onChange,
    onOpenChange,
    open: openProp,
    step = 30,
    value: valueProp,
    ...field
  },
  ref,
) {
  const [value, setValue] = useControllableState<string | null>({
    defaultValue,
    onChange,
    value: valueProp,
  });
  const [open, setOpen] = useControllableState({
    defaultValue: defaultOpen,
    onChange: onOpenChange,
    value: openProp,
  });
  const locale = useResolvedLocale(localeProp);
  const formatter = useDateFormatter(locale, { hour: '2-digit', minute: '2-digit' });
  const panelId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const parsed = parseTime(value);
  const text =
    value === null || value === ''
      ? null
      : parsed === null
        ? value
        : (formatValue?.(value) ??
          formatter.format(new Date(2000, 0, 1, parsed.hour, parsed.minute)));

  return (
    <>
      <DateField
        {...field}
        anchorRef={anchorRef}
        clearLabel={labels.clear}
        forwardedRef={ref}
        hiddenValue={value ?? ''}
        icon={<Clock strokeWidth={1.5} />}
        onClear={() => setValue(null)}
        onToggle={() => setOpen((current) => !current)}
        open={open}
        panelId={panelId}
        text={text}
        triggerRef={triggerRef}
      />
      <PickerPanel
        anchorRef={anchorRef}
        className="rx-time-panel"
        id={panelId}
        initialFocusRef={listRef}
        label={labels.dialog}
        onClose={() => setOpen(false)}
        open={open && !field.disabled}
        triggerRef={triggerRef}
      >
        <TimeList
          label={labels.time}
          listRef={listRef}
          locale={locale}
          max={max}
          min={min}
          onSelect={(next) => {
            setValue(next);
            setOpen(false);
          }}
          step={step}
          value={parsed === null ? null : formatTime(parsed.hour, parsed.minute)}
        />
      </PickerPanel>
    </>
  );
});

// —— DateTimePicker ——

export interface DateTimePickerProps extends FieldBaseProps, CalendarBaseProps {
  defaultValue?: string | null;
  /** 只选了日期时使用的时间，默认 `00:00`。 */
  defaultTime?: string;
  formatValue?: (value: string) => string;
  labels: DatePickerLabels;
  onChange?: (value: string | null) => void;
  step?: 15 | 30;
  /** 完整 ISO 时间串（`Date#toISOString()`，UTC）；无值传 null。 */
  value?: string | null;
}

function splitDateTime(value: string | null): { date: string; time: string } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return { date: toISODate(date), time: formatTime(date.getHours(), date.getMinutes()) };
}

function joinDateTime(date: string, time: string): string | null {
  const day = parseISODate(date);
  const clock = parseTime(time) ?? { hour: 0, minute: 0 };
  if (!day) return null;
  day.setHours(clock.hour, clock.minute, 0, 0);
  return day.toISOString();
}

/** 日期时间：左侧月历、右侧时间列表；选日期立即生效并保留面板，选时间后关闭。 */
export const DateTimePicker = forwardRef<HTMLButtonElement, DateTimePickerProps>(
  function DateTimePicker(
    {
      defaultOpen = false,
      defaultTime = '00:00',
      defaultValue = null,
      disabledDate,
      formatValue,
      labels,
      locale: localeProp,
      max,
      min,
      onChange,
      onOpenChange,
      open: openProp,
      step = 30,
      today,
      value: valueProp,
      weekStartsOn = 1,
      ...field
    },
    ref,
  ) {
    const [value, setValue] = useControllableState<string | null>({
      defaultValue,
      onChange,
      value: valueProp,
    });
    const [open, setOpen] = useControllableState({
      defaultValue: defaultOpen,
      onChange: onOpenChange,
      value: openProp,
    });
    const locale = useResolvedLocale(localeProp);
    const formatter = useDateFormatter(locale, {
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const panelId = useId();
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const cellRef = useRef<HTMLElement | null>(null);
    const parts = splitDateTime(value);
    const [focused, setFocused] = useState(() => initialFocusDate(parts?.date, min, max));
    useOnOpen(open, () => setFocused(initialFocusDate(parts?.date, min, max)));

    const text =
      value === null || value === ''
        ? null
        : parts === null
          ? value
          : (formatValue?.(value) ?? formatter.format(new Date(value)));

    return (
      <>
        <DateField
          {...field}
          anchorRef={anchorRef}
          clearLabel={labels.clear}
          forwardedRef={ref}
          hiddenValue={value ?? ''}
          icon={<CalendarDays strokeWidth={1.5} />}
          onClear={() => setValue(null)}
          onToggle={() => setOpen((current) => !current)}
          open={open}
          panelId={panelId}
          text={text}
          triggerRef={triggerRef}
        />
        <PickerPanel
          anchorRef={anchorRef}
          className="rx-date-time-panel"
          id={panelId}
          initialFocusRef={cellRef}
          label={labels.dialog}
          onClose={() => setOpen(false)}
          open={open && !field.disabled}
          triggerRef={triggerRef}
        >
          <Calendar
            activeCellRef={cellRef}
            disabledDate={disabledDate}
            focusedDate={focused}
            labels={labels}
            locale={locale}
            max={max}
            min={min}
            onFocusedDateChange={setFocused}
            onSelect={(next) => setValue(joinDateTime(next, parts?.time ?? defaultTime))}
            selected={parts?.date ?? null}
            today={today}
            weekStartsOn={weekStartsOn}
          />
          <TimeList
            className="rx-date-time-list"
            label={labels.time}
            locale={locale}
            onSelect={(time) => {
              setValue(joinDateTime(parts?.date ?? focused, time));
              setOpen(false);
            }}
            step={step}
            value={parts?.time ?? null}
          />
        </PickerPanel>
      </>
    );
  },
);
