// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addMonths, parseISODate, startOfWeek } from './DateCalendar';
import {
  DatePicker,
  DateRangePicker,
  DateTimePicker,
  TimePicker,
  type DatePickerLabels,
  type DateRange,
} from './DatePicker';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const labels: DatePickerLabels = {
  clear: 'Clear',
  dialog: 'Choose date',
  nextMonth: 'Next month',
  nextYear: 'Next year',
  previousMonth: 'Previous month',
  previousYear: 'Previous year',
  time: 'Time',
};

function key(target: Element | null, value: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: value,
    shiftKey,
  });
  act(() => {
    target!.dispatchEvent(event);
  });
  return event;
}

const trigger = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('.rx-date-field-trigger')!;
const panel = () => document.querySelector<HTMLElement>('.rx-date-panel');
const cell = (iso: string) => document.querySelector<HTMLElement>(`[data-date="${iso}"]`)!;
const focusedDate = () => (document.activeElement as HTMLElement | null)?.dataset.date;

describe('date helpers', () => {
  it('parses strictly, clamps month ends and finds week starts', () => {
    expect(parseISODate('2026-02-30')).toBeNull();
    expect(parseISODate('2026-2-3')).toBeNull();
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-15');
    expect(startOfWeek('2026-07-26', 1)).toBe('2026-07-20');
    expect(startOfWeek('2026-07-26', 0)).toBe('2026-07-26');
  });
});

describe('DatePicker interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 6, 15, 9, 0), toFake: ['Date'] });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.querySelector('[data-rx-portal-root]')?.replaceChildren();
    vi.useRealTimers();
  });

  it('opens a labelled dialog grid, focuses the selected date and selects with Enter', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <DatePicker
          aria-label="Due date"
          defaultValue="2026-07-08"
          labels={labels}
          locale="en-US"
          onChange={onChange}
          placeholder="Pick a date"
        />,
      ),
    );
    const button = trigger(container);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('07/08/2026');
    expect(container.querySelector('input[type="date"]')).toBeNull();

    act(() => button.click());
    const dialog = panel()!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Choose date');
    expect(dialog.classList.contains('rx-floating-panel')).toBe(true);
    expect(button.getAttribute('aria-controls')).toBe(dialog.id);
    expect(document.querySelector('[role="grid"]')).toBeTruthy();
    expect(document.querySelector('.rx-calendar-title')?.textContent).toBe('July 2026');
    // 周一开头。
    expect(document.querySelector('.rx-calendar-weekday')?.getAttribute('abbr')).toBe('Monday');
    expect(focusedDate()).toBe('2026-07-08');
    expect(cell('2026-07-08').getAttribute('aria-selected')).toBe('true');
    expect(cell('2026-07-15').dataset.today).toBe('true');
    expect(cell('2026-07-15').getAttribute('aria-current')).toBe('date');
    expect(cell('2026-06-29').dataset.outside).toBe('true');

    key(document.activeElement, 'ArrowRight');
    expect(focusedDate()).toBe('2026-07-09');
    key(document.activeElement, 'ArrowDown');
    expect(focusedDate()).toBe('2026-07-16');
    key(document.activeElement, 'Home');
    expect(focusedDate()).toBe('2026-07-13');
    key(document.activeElement, 'End');
    expect(focusedDate()).toBe('2026-07-19');
    key(document.activeElement, 'ArrowUp');
    expect(focusedDate()).toBe('2026-07-12');
    key(document.activeElement, 'ArrowLeft');
    expect(focusedDate()).toBe('2026-07-11');
    key(document.activeElement, 'PageDown');
    expect(focusedDate()).toBe('2026-08-11');
    expect(document.querySelector('.rx-calendar-title')?.textContent).toBe('August 2026');
    key(document.activeElement, 'PageUp', true);
    expect(focusedDate()).toBe('2025-08-11');
    key(document.activeElement, 'PageDown', true);
    key(document.activeElement, 'PageUp');
    expect(focusedDate()).toBe('2026-07-11');

    key(document.activeElement, 'Enter');
    expect(onChange).toHaveBeenCalledWith('2026-07-11');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe('07/11/2026');
  });

  it('Escape closes and returns focus to the trigger without changing the value', () => {
    const onChange = vi.fn();
    act(() => root.render(<DatePicker labels={labels} locale="en-US" onChange={onChange} />));
    const button = trigger(container);
    act(() => button.focus());
    key(button, 'ArrowDown');
    expect(panel()).toBeTruthy();
    // 无值时聚焦今天。
    expect(focusedDate()).toBe('2026-07-15');
    key(document.activeElement, 'ArrowRight');
    key(document.activeElement, 'Escape');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is controlled: value comes from props and clicks only report changes', () => {
    const onChange = vi.fn();
    const render = (value: string | null) =>
      act(() =>
        root.render(
          <DatePicker
            clearable
            labels={labels}
            locale="en-US"
            name="due"
            onChange={onChange}
            placeholder="Pick"
            value={value}
          />,
        ),
      );
    render('2026-07-01');
    act(() => trigger(container).click());
    act(() => cell('2026-07-20').click());
    expect(onChange).toHaveBeenCalledWith('2026-07-20');
    expect(trigger(container).textContent).toBe('07/01/2026');
    expect(container.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe(
      '2026-07-01',
    );

    render('2026-07-20');
    expect(trigger(container).textContent).toBe('07/20/2026');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Clear"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith(null);

    render(null);
    expect(trigger(container).textContent).toBe('Pick');
    expect(container.querySelector('[aria-label="Clear"]')).toBeNull();
  });

  it('respects min/max and disabledDate: disabled cells are not selectable and focus is clamped', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <DatePicker
          defaultOpen
          defaultValue="2026-07-15"
          disabledDate={(_, date) => date.getDay() === 0}
          labels={labels}
          locale="en-US"
          max="2026-07-31"
          min="2026-07-10"
          onChange={onChange}
        />,
      ),
    );
    expect(cell('2026-07-09').dataset.disabled).toBe('true');
    expect(cell('2026-07-19').getAttribute('aria-disabled')).toBe('true');
    act(() => cell('2026-07-19').click());
    act(() => cell('2026-07-05').click());
    expect(onChange).not.toHaveBeenCalled();
    const next = document.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!;
    expect(next.disabled).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.disabled,
    ).toBe(true);

    act(() => cell('2026-07-15').focus());
    key(document.activeElement, 'PageDown');
    expect(focusedDate()).toBe('2026-07-31');
    key(document.activeElement, 'PageUp', true);
    expect(focusedDate()).toBe('2026-07-10');
    key(document.activeElement, 'Home');
    expect(focusedDate()).toBe('2026-07-10');
    key(document.activeElement, 'ArrowDown');
    key(document.activeElement, 'End');
    expect(focusedDate()).toBe('2026-07-19');
    key(document.activeElement, 'Enter');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses Intl for month and weekday names and honours weekStartsOn', () => {
    act(() =>
      root.render(
        <DatePicker
          defaultOpen
          defaultValue="2026-07-08"
          labels={labels}
          locale="zh-CN"
          weekStartsOn={0}
        />,
      ),
    );
    expect(document.querySelector('.rx-calendar-title')?.textContent).toBe('2026年7月');
    expect(document.querySelector('.rx-calendar-weekday')?.getAttribute('abbr')).toBe('星期日');
    expect(trigger(container).textContent).toBe('2026/07/08');
  });

  it('month buttons navigate without stealing focus from the dialog', () => {
    act(() =>
      root.render(
        <DatePicker defaultOpen defaultValue="2026-07-08" labels={labels} locale="en-US" />,
      ),
    );
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    expect(document.querySelector('.rx-calendar-title')?.textContent).toBe('August 2026');
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Next year"]')!.click());
    expect(document.querySelector('.rx-calendar-title')?.textContent).toBe('August 2027');
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Previous year"]')!.click());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.click());
    expect(document.querySelector('.rx-calendar-title')?.textContent).toBe('July 2026');
  });

  it('disabled and readOnly never open', () => {
    act(() => root.render(<DatePicker disabled labels={labels} />));
    expect(trigger(container).disabled).toBe(true);
    act(() => root.render(<DatePicker labels={labels} readOnly value="2026-07-01" />));
    act(() => trigger(container).click());
    expect(panel()).toBeNull();
    expect(container.querySelector('.rx-date-field')?.getAttribute('data-readonly')).toBe('true');
  });

  it('shows raw text for invalid values and omits data-size unless size is passed', () => {
    act(() => root.render(<DatePicker labels={labels} value="not-a-date" />));
    expect(trigger(container).textContent).toBe('not-a-date');
    expect(container.querySelector('.rx-date-field')?.hasAttribute('data-size')).toBe(false);
    act(() => root.render(<DatePicker labels={labels} size="lg" value="2026-07-01" />));
    expect(container.querySelector('.rx-date-field')?.getAttribute('data-size')).toBe('lg');
  });

  it('DateRangePicker selects with two clicks, previews on hover and orders the range', () => {
    const onChange = vi.fn<(value: DateRange | null) => void>();
    act(() =>
      root.render(
        <DateRangePicker
          display="pill"
          formatValue={(range) => `${range.start} — ${range.end}`}
          labels={labels}
          locale="en-US"
          onChange={onChange}
        />,
      ),
    );
    expect(container.querySelector('.rx-date-field')?.getAttribute('data-variant')).toBe('pill');
    act(() => trigger(container).click());
    act(() => cell('2026-07-20').click());
    expect(panel()).toBeTruthy();
    act(() => {
      cell('2026-07-10').dispatchEvent(new Event('pointerover', { bubbles: true }));
    });
    // React 的 onPointerEnter 由 pointerover/pointerout 推导。
    expect(cell('2026-07-15').dataset.inRange).toBe('true');
    expect(cell('2026-07-10').dataset.rangeStart).toBe('true');
    expect(cell('2026-07-20').dataset.rangeEnd).toBe('true');
    act(() => cell('2026-07-10').click());
    expect(onChange).toHaveBeenCalledWith({ end: '2026-07-20', start: '2026-07-10' });
    expect(panel()).toBeNull();
    expect(trigger(container).textContent).toBe('2026-07-10 — 2026-07-20');
  });

  it('DateRangePicker supports keyboard range selection', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <DateRangePicker
          defaultValue={{ end: '2026-07-05', start: '2026-07-01' }}
          labels={labels}
          locale="en-US"
          onChange={onChange}
        />,
      ),
    );
    expect(trigger(container).textContent).toBe('07/01/2026 — 07/05/2026');
    act(() => trigger(container).click());
    expect(focusedDate()).toBe('2026-07-01');
    key(document.activeElement, 'Enter');
    key(document.activeElement, 'ArrowDown');
    expect(cell('2026-07-04').dataset.inRange).toBe('true');
    key(document.activeElement, 'Enter');
    expect(onChange).toHaveBeenCalledWith({ end: '2026-07-08', start: '2026-07-01' });
  });

  it('TimePicker lists times by step and selects with the keyboard', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <TimePicker
          defaultValue="09:00"
          labels={{ dialog: 'Choose time', time: 'Times' }}
          locale="en-GB"
          onChange={onChange}
          step={15}
        />,
      ),
    );
    expect(trigger(container).textContent).toBe('09:00');
    act(() => trigger(container).click());
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(list.getAttribute('aria-label')).toBe('Times');
    expect(document.activeElement).toBe(list);
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(96);
    const active = () => document.getElementById(list.getAttribute('aria-activedescendant')!);
    expect(active()?.dataset.value).toBe('09:00');
    key(list, 'ArrowDown');
    key(list, 'ArrowDown');
    expect(active()?.dataset.value).toBe('09:30');
    key(list, 'PageUp');
    expect(active()?.dataset.value).toBe('08:30');
    key(list, 'Enter');
    expect(onChange).toHaveBeenCalledWith('08:30');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger(container));
  });

  it('TimePicker 30-minute step and min/max bounds', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<TimePicker defaultOpen max="10:00" min="08:00" onChange={onChange} step={30} />),
    );
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options).toHaveLength(48);
    const early = options.find((option) => option.dataset.value === '07:30')!;
    expect(early.getAttribute('aria-disabled')).toBe('true');
    act(() => early.click());
    expect(onChange).not.toHaveBeenCalled();
    act(() => options.find((option) => option.dataset.value === '10:00')!.click());
    expect(onChange).toHaveBeenCalledWith('10:00');
  });

  it('DateTimePicker combines the date grid and the time list into an ISO string', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <DateTimePicker defaultTime="09:00" labels={labels} locale="en-US" onChange={onChange} />,
      ),
    );
    act(() => trigger(container).click());
    const dialog = panel()!;
    expect(dialog.querySelector('[role="grid"]')).toBeTruthy();
    expect(dialog.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Time');
    act(() => cell('2026-07-20').click());
    expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 6, 20, 9, 0).toISOString());
    expect(panel()).toBeTruthy();
    act(() => dialog.querySelector<HTMLElement>('[data-value="14:30"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 6, 20, 14, 30).toISOString());
    expect(panel()).toBeNull();
    expect(trigger(container).textContent).toBe('07/20/2026, 02:30 PM');
  });
});
