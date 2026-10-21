'use client';

/**
 * DatePicker 系列的内部模块（规范 03 §3.30）：纯日期工具、月历网格（APG date picker dialog 的 grid 部分）
 * 与时间列表。内部积木只由 DatePicker.tsx 使用；对外只导出常驻月历 `DateCalendar`。
 *
 * 日期一律用 `YYYY-MM-DD` 字符串表示本地日历日，字符串比较即日期比较；时间用 `HH:mm`。
 */

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { useControllableState } from '../primitives/useControllableState';
import { IconButton } from './IconButton';

// —— 日期工具 ——

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

export function toISODate(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 严格解析 `YYYY-MM-DD`；非法日期（如 02-30）返回 null。 */
export function parseISODate(value: string | null | undefined): Date | null {
  const match = value ? ISO_DATE.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  date.setFullYear(year);
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function isValidISODate(value: string | null | undefined): value is string {
  return parseISODate(value) !== null;
}

export function addDays(iso: string, days: number): string {
  const date = parseISODate(iso)!;
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

/** 按月加减，日号超出目标月天数时取月末。 */
export function addMonths(iso: string, months: number): string {
  const date = parseISODate(iso)!;
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, last));
  return toISODate(target);
}

export function startOfWeek(iso: string, weekStartsOn: number): string {
  const offset = (parseISODate(iso)!.getDay() - weekStartsOn + 7) % 7;
  return addDays(iso, -offset);
}

export function endOfWeek(iso: string, weekStartsOn: number): string {
  return addDays(startOfWeek(iso, weekStartsOn), 6);
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function clampISODate(iso: string, min?: string, max?: string): string {
  if (min && isValidISODate(min) && iso < min) return min;
  if (max && isValidISODate(max) && iso > max) return max;
  return iso;
}

export function parseTime(
  value: string | null | undefined,
): { hour: number; minute: number } | null {
  const match = value ? TIME.exec(value) : null;
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

export function formatTime(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

// —— 语言 ——

const subscribeNoop = () => () => {};
const DEFAULT_LOCALE = 'zh-CN';

/** `locale` 属性优先，否则取 `<html lang>`，都没有时用 zh-CN；服务端渲染固定 zh-CN。 */
export function useResolvedLocale(locale: string | undefined): string {
  const documentLocale = useSyncExternalStore(
    subscribeNoop,
    () => document.documentElement.lang || DEFAULT_LOCALE,
    () => DEFAULT_LOCALE,
  );
  return locale ?? documentLocale;
}

function safeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat(DEFAULT_LOCALE, options);
  }
}

export function useDateFormatter(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(options);
  return useMemo(() => safeFormatter(locale, options), [locale, key]);
}

// —— 月历 ——

export interface CalendarLabels {
  nextMonth: string;
  nextYear?: string;
  previousMonth: string;
  previousYear?: string;
}

export interface CalendarProps {
  /** 被选中后作为焦点入口的格子（tabIndex=0）写入这里，供焦点陷阱初始聚焦。 */
  activeCellRef?: MutableRefObject<HTMLElement | null>;
  disabledDate?: (date: string, jsDate: Date) => boolean;
  /** 调用方提供的业务日期标记；可读说明合并进日期的无障碍名称。 */
  dayAnnotation?: (date: string) => CalendarDayAnnotation | undefined;
  focusedDate: string;
  /** 仅覆盖星期与日期网格的内容；显示时暂停日期网格交互。 */
  gridOverlay?: ReactNode;
  /**
   * 浅色底带标出的日期区间（含两端），只做视觉提示、不改变选中状态，
   * 例如日程周视图里「当前这一周」。
   */
  highlight?: CalendarHighlight | null;
  labels: CalendarLabels;
  locale: string;
  max?: string;
  min?: string;
  /** 用户跨月前的可选校验；返回 false 取消，返回 Promise 则等待校验完成。 */
  onBeforeMonthChange?: (
    date: string,
    signal: AbortSignal,
  ) => boolean | void | Promise<boolean | void>;
  onFocusedDateChange: (date: string) => void;
  onHoverDate?: (date: string | null) => void;
  onSelect: (date: string) => void;
  /** 包含相邻月份日格的完整可见范围，便于调用方按范围懒加载。 */
  onVisibleRangeChange?: (range: CalendarVisibleRange) => void;
  /** 高亮区间（已排序，含两端）。 */
  rangeEnd?: string | null;
  rangeStart?: string | null;
  selected?: string | null;
  /** 「今天」（`YYYY-MM-DD`），默认按浏览器时区；业务时区与浏览器不同时由调用方传入。 */
  today?: string;
  weekStartsOn: number;
}

export interface CalendarDayAnnotation {
  label: string;
  marker: ReactNode;
  /** 可选的第二行紧凑计数，与状态标记同时展示。 */
  detail?: ReactNode;
}

export interface CalendarVisibleRange {
  start: string;
  end: string;
}

export interface CalendarHighlight {
  /** `YYYY-MM-DD`，含。 */
  end: string;
  /** `YYYY-MM-DD`，含。 */
  start: string;
}

function highlightPosition(
  iso: string,
  highlight: CalendarHighlight | null | undefined,
): 'end' | 'middle' | 'single' | 'start' | undefined {
  if (!highlight || iso < highlight.start || iso > highlight.end) return undefined;
  if (highlight.start === highlight.end) return 'single';
  if (iso === highlight.start) return 'start';
  if (iso === highlight.end) return 'end';
  return 'middle';
}

/**
 * 日格里只放「几号」。zh-CN 下 `{ day: 'numeric' }` 会格式化成「9日」，在 28–32px 的圆格里
 * 会折行，所以只取 `day` 片段（仍走 Intl，保留其它语言的本地数字）。
 */
function dayLabel(formatter: Intl.DateTimeFormat, date: Date): string {
  return (
    formatter.formatToParts(date).find((part) => part.type === 'day')?.value ??
    String(date.getDate())
  );
}

export function isDateDisabled(
  iso: string,
  { disabledDate, max, min }: Pick<CalendarProps, 'disabledDate' | 'max' | 'min'>,
): boolean {
  if (min && isValidISODate(min) && iso < min) return true;
  if (max && isValidISODate(max) && iso > max) return true;
  return disabledDate?.(iso, parseISODate(iso)!) ?? false;
}

export function Calendar({
  activeCellRef,
  dayAnnotation,
  disabledDate,
  focusedDate,
  gridOverlay,
  highlight,
  labels,
  locale,
  max,
  min,
  onBeforeMonthChange,
  onFocusedDateChange,
  onHoverDate,
  onSelect,
  onVisibleRangeChange,
  rangeEnd,
  rangeStart,
  selected,
  today: todayProp,
  weekStartsOn,
}: CalendarProps) {
  const headingId = useId();
  const gridRef = useRef<HTMLTableElement | null>(null);
  const moveFocus = useRef(false);
  const monthChange = useRef<AbortController | null>(null);
  const gridCovered = gridOverlay !== undefined && gridOverlay !== null && gridOverlay !== false;
  const today = todayProp && isValidISODate(todayProp) ? todayProp : todayISO();
  const focused = parseISODate(focusedDate) ?? new Date();
  const year = focused.getFullYear();
  const month = focused.getMonth();
  const monthStartDate = new Date(year, month, 1);
  const monthStart = toISODate(monthStartDate);
  const gridStart = startOfWeek(monthStart, weekStartsOn);

  const monthFormatter = useDateFormatter(locale, { month: 'long', year: 'numeric' });
  const narrowWeekday = useDateFormatter(locale, { weekday: 'narrow' });
  const longWeekday = useDateFormatter(locale, { weekday: 'long' });
  const fullDate = useDateFormatter(locale, { dateStyle: 'full' });
  const dayNumber = useDateFormatter(locale, { day: 'numeric' });

  const weeks = useMemo(() => {
    const rows: string[][] = [];
    for (let week = 0; week < 6; week += 1) {
      const row: string[] = [];
      for (let day = 0; day < 7; day += 1) row.push(addDays(gridStart, week * 7 + day));
      rows.push(row);
    }
    return rows;
  }, [gridStart]);

  const rangeCallback = useRef(onVisibleRangeChange);
  useEffect(() => {
    rangeCallback.current = onVisibleRangeChange;
  }, [onVisibleRangeChange]);
  useEffect(() => {
    rangeCallback.current?.({ start: gridStart, end: addDays(gridStart, 41) });
  }, [gridStart]);

  const constraints = { disabledDate, max, min };
  const validMin = min && isValidISODate(min) ? min : undefined;
  const validMax = max && isValidISODate(max) ? max : undefined;

  useLayoutEffect(() => {
    if (!moveFocus.current || gridCovered) return;
    moveFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-date="${focusedDate}"]`)
      ?.focus({ preventScroll: true });
  }, [focusedDate, gridCovered]);

  useLayoutEffect(
    () => () => {
      monthChange.current?.abort();
      monthChange.current = null;
    },
    [focusedDate, min, max],
  );

  const go = (next: string, focusCell: boolean) => {
    monthChange.current?.abort();
    monthChange.current = null;
    const clamped = clampISODate(next, validMin, validMax);
    const commit = () => {
      moveFocus.current = focusCell;
      onFocusedDateChange(clamped);
    };
    if (!onBeforeMonthChange || clamped.slice(0, 7) === focusedDate.slice(0, 7)) {
      commit();
      return;
    }
    const request = new AbortController();
    monthChange.current = request;
    void Promise.resolve()
      .then(() => onBeforeMonthChange(clamped, request.signal))
      .then((allowed) => {
        if (request.signal.aborted || monthChange.current !== request) return;
        monthChange.current = null;
        if (allowed !== false) commit();
      })
      .catch(() => {
        if (monthChange.current === request) monthChange.current = null;
      });
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (gridCovered) return;
    let next: string | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        next = addDays(focusedDate, -1);
        break;
      case 'ArrowRight':
        next = addDays(focusedDate, 1);
        break;
      case 'ArrowUp':
        next = addDays(focusedDate, -7);
        break;
      case 'ArrowDown':
        next = addDays(focusedDate, 7);
        break;
      case 'PageUp':
        next = addMonths(focusedDate, event.shiftKey ? -12 : -1);
        break;
      case 'PageDown':
        next = addMonths(focusedDate, event.shiftKey ? 12 : 1);
        break;
      case 'Home':
        next = startOfWeek(focusedDate, weekStartsOn);
        break;
      case 'End':
        next = endOfWeek(focusedDate, weekStartsOn);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (!isDateDisabled(focusedDate, constraints)) onSelect(focusedDate);
        return;
      default:
        return;
    }
    event.preventDefault();
    go(next, true);
  };

  const lastOfPreviousMonth = addDays(monthStart, -1);
  const firstOfNextMonth = addMonths(monthStart, 1);
  const lastOfPreviousYear = addDays(toISODate(new Date(year, 0, 1)), -1);
  const firstOfNextYear = toISODate(new Date(year + 1, 0, 1));
  const disablePrevMonth = validMin !== undefined && lastOfPreviousMonth < validMin;
  const disableNextMonth = validMax !== undefined && firstOfNextMonth > validMax;
  const disablePrevYear = validMin !== undefined && lastOfPreviousYear < validMin;
  const disableNextYear = validMax !== undefined && firstOfNextYear > validMax;

  return (
    <div className="rx-calendar">
      <div className="rx-calendar-header">
        {labels.previousYear === undefined ? null : (
          <IconButton
            disabled={disablePrevYear}
            icon={<ChevronsLeft />}
            label={labels.previousYear}
            onClick={() => go(addMonths(focusedDate, -12), false)}
            size="sm"
          />
        )}
        <IconButton
          disabled={disablePrevMonth}
          icon={<ChevronLeft />}
          label={labels.previousMonth}
          onClick={() => go(addMonths(focusedDate, -1), false)}
          size="sm"
        />
        <span aria-live="polite" className="rx-calendar-title" id={headingId}>
          {monthFormatter.format(monthStartDate)}
        </span>
        <IconButton
          disabled={disableNextMonth}
          icon={<ChevronRight />}
          label={labels.nextMonth}
          onClick={() => go(addMonths(focusedDate, 1), false)}
          size="sm"
        />
        {labels.nextYear === undefined ? null : (
          <IconButton
            disabled={disableNextYear}
            icon={<ChevronsRight />}
            label={labels.nextYear}
            onClick={() => go(addMonths(focusedDate, 12), false)}
            size="sm"
          />
        )}
      </div>
      <div className="rx-calendar-grid-region">
        <table
          aria-busy={gridCovered || undefined}
          aria-labelledby={headingId}
          className="rx-calendar-grid"
          inert={gridCovered || undefined}
          onKeyDown={onGridKeyDown}
          onPointerLeave={() => onHoverDate?.(null)}
          ref={gridRef}
          role="grid"
        >
          <thead>
            <tr>
              {weeks[0]!.map((iso) => {
                const date = parseISODate(iso)!;
                return (
                  <th
                    abbr={longWeekday.format(date)}
                    className="rx-calendar-weekday"
                    key={iso}
                    scope="col"
                  >
                    {narrowWeekday.format(date)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {weeks.map((row) => (
              <tr key={row[0]}>
                {row.map((iso) => {
                  const date = parseISODate(iso)!;
                  const disabled = isDateDisabled(iso, constraints);
                  const isFocused = iso === focusedDate;
                  const isSelected =
                    iso === selected ||
                    (rangeStart != null && (iso === rangeStart || iso === rangeEnd));
                  const inRange =
                    rangeStart != null && rangeEnd != null && iso > rangeStart && iso < rangeEnd;
                  const annotation = dayAnnotation?.(iso);
                  return (
                    <td
                      aria-current={iso === today ? 'date' : undefined}
                      aria-disabled={disabled || undefined}
                      aria-label={
                        annotation
                          ? `${fullDate.format(date)}, ${annotation.label}`
                          : fullDate.format(date)
                      }
                      aria-selected={isSelected}
                      className="rx-calendar-day"
                      data-date={iso}
                      data-detail={annotation?.detail !== undefined ? 'true' : undefined}
                      data-disabled={disabled ? 'true' : undefined}
                      data-highlight={highlightPosition(iso, highlight)}
                      data-in-range={inRange ? 'true' : undefined}
                      data-outside={date.getMonth() !== month ? 'true' : undefined}
                      data-range-end={rangeEnd != null && iso === rangeEnd ? 'true' : undefined}
                      data-range-start={
                        rangeStart != null && iso === rangeStart ? 'true' : undefined
                      }
                      data-state={isSelected ? 'selected' : undefined}
                      data-today={iso === today ? 'true' : undefined}
                      key={iso}
                      onClick={() => {
                        if (disabled || gridCovered) return;
                        monthChange.current?.abort();
                        monthChange.current = null;
                        moveFocus.current = false;
                        onFocusedDateChange(iso);
                        onSelect(iso);
                      }}
                      onPointerEnter={() => onHoverDate?.(iso)}
                      ref={
                        isFocused && activeCellRef
                          ? (node) => {
                              activeCellRef.current = node;
                            }
                          : undefined
                      }
                      role="gridcell"
                      tabIndex={isFocused ? 0 : -1}
                    >
                      <span className={cn('rx-calendar-day-label', 'rx-numeric')}>
                        {dayLabel(dayNumber, date)}
                        {annotation && annotation.detail === undefined ? (
                          <span aria-hidden="true" className="rx-calendar-day-marker">
                            {annotation.marker}
                          </span>
                        ) : null}
                      </span>
                      {annotation?.detail !== undefined ? (
                        <span aria-hidden="true" className="rx-calendar-day-detail rx-numeric">
                          {annotation.detail}
                          <span className="rx-calendar-day-marker">{annotation.marker}</span>
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {gridOverlay}
      </div>
    </div>
  );
}

// —— 常驻月历 ——

export interface DateCalendarProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'defaultValue' | 'onChange'
> {
  defaultValue?: string | null;
  /** 不可选日期（`YYYY-MM-DD` 与对应的本地 Date）。 */
  disabledDate?: (date: string, jsDate: Date) => boolean;
  /** 离散日期的业务标记，保留日期选择与键盘导航行为。 */
  dayAnnotation?: CalendarProps['dayAnnotation'];
  /** 星期与日期网格的覆盖层；月份导航保持可用。 */
  gridOverlay?: CalendarProps['gridOverlay'];
  /** 浅色底带标出的区间（含两端），只做视觉提示，例如周视图里的当前周。 */
  highlight?: CalendarHighlight | null;
  /** 翻月按钮的可读名称；传 `previousYear` / `nextYear` 时额外显示按年翻页。 */
  labels: CalendarLabels;
  /** 显示语言，默认取 `<html lang>`，否则 zh-CN。 */
  locale?: string;
  max?: string;
  min?: string;
  onChange?: (value: string) => void;
  onBeforeMonthChange?: CalendarProps['onBeforeMonthChange'];
  onVisibleRangeChange?: CalendarProps['onVisibleRangeChange'];
  /** 「今天」（`YYYY-MM-DD`）；业务时区与浏览器时区不同时传入，默认按浏览器时区。 */
  today?: string;
  /** 选中日 `YYYY-MM-DD`；受控时传入，无选中传 null。 */
  value?: string | null;
  /** 一周从星期几开始，0 = 周日，默认 1（周一）。 */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * 常驻月历（规范 03 §3.30）：与 DatePicker 面板同一套网格与键盘交互（APG grid），
 * 但直接嵌在页面里，用于日程左栏这类「一直可见的日期导航」。宽 240，窄容器内随父级收缩。
 *
 * 显示的月份跟随选中日：受控值变到别的月份时自动翻过去；用户自己翻月不改变选中值。
 */
export function DateCalendar({
  className,
  dayAnnotation,
  defaultValue = null,
  disabledDate,
  gridOverlay,
  highlight,
  labels,
  locale: localeProp,
  max,
  min,
  onBeforeMonthChange,
  onChange,
  onVisibleRangeChange,
  today,
  value: valueProp,
  weekStartsOn = 1,
  ...props
}: DateCalendarProps) {
  const locale = useResolvedLocale(localeProp);
  const [value, setValue] = useControllableState<string | null>({
    defaultValue,
    onChange: (next) => {
      if (next !== null) onChange?.(next);
    },
    value: valueProp,
  });
  const fallback = today && isValidISODate(today) ? today : todayISO();
  const [focused, setFocused] = useState(() =>
    clampISODate(isValidISODate(value) ? value : fallback, min, max),
  );
  // 选中值从外部变化（例如日程翻到下一周）时，让显示的月份跟上。用渲染期同步而不是 effect，
  // 避免先画一帧旧月份。
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    if (isValidISODate(value)) setFocused(clampISODate(value, min, max));
  }

  return (
    <div className={cn('rx-date-calendar', className)} {...props}>
      <Calendar
        dayAnnotation={dayAnnotation}
        disabledDate={disabledDate}
        focusedDate={focused}
        gridOverlay={gridOverlay}
        highlight={highlight}
        labels={labels}
        locale={locale}
        max={max}
        min={min}
        onBeforeMonthChange={onBeforeMonthChange}
        onFocusedDateChange={setFocused}
        onSelect={setValue}
        onVisibleRangeChange={onVisibleRangeChange}
        selected={value}
        today={today}
        weekStartsOn={weekStartsOn}
      />
    </div>
  );
}

// —— 时间列表 ——

export interface TimeListProps {
  className?: string;
  label?: string;
  listRef?: MutableRefObject<HTMLElement | null>;
  locale: string;
  max?: string;
  min?: string;
  onSelect: (time: string) => void;
  /** 步进分钟数（15 或 30）。 */
  step: number;
  value: string | null;
}

export function TimeList({
  className,
  label,
  listRef,
  locale,
  max,
  min,
  onSelect,
  step,
  value,
}: TimeListProps) {
  const id = useId();
  const formatter = useDateFormatter(locale, { hour: '2-digit', minute: '2-digit' });
  const times = useMemo(() => {
    const safeStep = Math.max(1, Math.min(60, Math.floor(step) || 30));
    const list: string[] = [];
    for (let minutes = 0; minutes < 24 * 60; minutes += safeStep) {
      list.push(formatTime(Math.floor(minutes / 60), minutes % 60));
    }
    return list;
  }, [step]);
  const isDisabled = (time: string) =>
    (min !== undefined && time < min) || (max !== undefined && time > max);
  const selectedIndex = value === null ? -1 : times.indexOf(value);
  const [active, setActive] = useState(() => {
    if (selectedIndex >= 0) return selectedIndex;
    const first = times.findIndex((time) => !isDisabled(time));
    return Math.max(0, first);
  });
  const localRef = useRef<HTMLDivElement | null>(null);
  const initial = useRef(true);

  useLayoutEffect(() => {
    const option = localRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    option?.scrollIntoView?.({ block: initial.current ? 'center' : 'nearest' });
    initial.current = false;
  }, [active]);

  const moveTo = (index: number, direction: 1 | -1) => {
    let next = Math.max(0, Math.min(times.length - 1, index));
    while (next >= 0 && next < times.length && isDisabled(times[next]!)) next += direction;
    if (next >= 0 && next < times.length) setActive(next);
  };

  return (
    <div
      aria-activedescendant={`${id}-${active}`}
      aria-label={label}
      className={cn('rx-time-list', 'rx-scroll-y', className)}
      onKeyDown={(event) => {
        switch (event.key) {
          case 'ArrowDown':
            moveTo(active + 1, 1);
            break;
          case 'ArrowUp':
            moveTo(active - 1, -1);
            break;
          case 'Home':
            moveTo(0, 1);
            break;
          case 'End':
            moveTo(times.length - 1, -1);
            break;
          case 'PageDown':
            moveTo(active + Math.round(60 / step), 1);
            break;
          case 'PageUp':
            moveTo(active - Math.round(60 / step), -1);
            break;
          case 'Enter':
          case ' ': {
            const time = times[active];
            if (time !== undefined && !isDisabled(time)) onSelect(time);
            break;
          }
          default:
            return;
        }
        event.preventDefault();
      }}
      ref={(node) => {
        localRef.current = node;
        if (listRef) listRef.current = node;
      }}
      role="listbox"
      tabIndex={0}
    >
      {times.map((time, index) => {
        const parsed = parseTime(time)!;
        const disabled = isDisabled(time);
        return (
          <div
            aria-disabled={disabled || undefined}
            aria-selected={index === selectedIndex}
            className="rx-time-option rx-numeric"
            data-active={index === active ? 'true' : undefined}
            data-disabled={disabled ? 'true' : undefined}
            data-index={index}
            data-state={index === selectedIndex ? 'selected' : undefined}
            data-value={time}
            id={`${id}-${index}`}
            key={time}
            onClick={() => {
              if (disabled) return;
              setActive(index);
              onSelect(time);
            }}
            role="option"
          >
            {formatter.format(new Date(2000, 0, 1, parsed.hour, parsed.minute))}
          </div>
        );
      })}
    </div>
  );
}
