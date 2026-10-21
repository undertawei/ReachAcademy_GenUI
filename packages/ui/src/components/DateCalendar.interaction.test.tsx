// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DateCalendar } from './DateCalendar';
import { DatePicker } from './DatePicker';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const labels = { nextMonth: 'Next month', previousMonth: 'Previous month' };

function key(target: Element | null, value: string) {
  act(() => {
    target!.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value }),
    );
  });
}

describe('DateCalendar (inline)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const cell = (iso: string) => container.querySelector<HTMLElement>(`[data-date="${iso}"]`)!;
  const title = () => container.querySelector('.rx-calendar-title')?.textContent;

  it('renders inline (no trigger, no portal), marks the selected day and the supplied today', () => {
    act(() =>
      root.render(
        <DateCalendar
          aria-label="Jump to date"
          labels={labels}
          locale="en-US"
          today="2026-10-09"
          value="2026-10-12"
        />,
      ),
    );
    const root_ = container.querySelector('.rx-date-calendar');
    expect(root_?.getAttribute('aria-label')).toBe('Jump to date');
    expect(container.querySelector('.rx-date-field-trigger')).toBeNull();
    expect(document.querySelector('.rx-date-panel')).toBeNull();
    expect(cell('2026-10-12').getAttribute('aria-selected')).toBe('true');
    expect(cell('2026-10-09').getAttribute('aria-current')).toBe('date');
    expect(cell('2026-10-09').dataset.today).toBe('true');
    expect(title()).toBe('October 2026');
  });

  it('highlights a range as a soft band without selecting its ends', () => {
    act(() =>
      root.render(
        <DateCalendar
          highlight={{ end: '2026-10-11', start: '2026-10-05' }}
          labels={labels}
          locale="en-US"
          value="2026-10-08"
        />,
      ),
    );
    expect(cell('2026-10-05').dataset.highlight).toBe('start');
    expect(cell('2026-10-08').dataset.highlight).toBe('middle');
    expect(cell('2026-10-11').dataset.highlight).toBe('end');
    expect(cell('2026-10-12').dataset.highlight).toBeUndefined();
    expect(cell('2026-10-05').getAttribute('aria-selected')).toBe('false');
    expect(cell('2026-10-08').getAttribute('aria-selected')).toBe('true');
  });

  it('selects by click and keyboard in controlled mode, and follows external value changes', () => {
    const onChange = vi.fn();
    let setExternal: (value: string) => void = () => undefined;
    function Harness() {
      const [value, setValue] = useState('2026-10-09');
      setExternal = setValue;
      return (
        <DateCalendar
          labels={labels}
          locale="en-US"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          value={value}
        />
      );
    }
    act(() => root.render(<Harness />));

    act(() => cell('2026-10-20').click());
    expect(onChange).toHaveBeenLastCalledWith('2026-10-20');
    expect(cell('2026-10-20').getAttribute('aria-selected')).toBe('true');

    act(() => cell('2026-10-20').focus());
    key(cell('2026-10-20'), 'ArrowRight');
    key(document.activeElement, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-21');

    // 外部把选中日翻到下个月（例如日程翻页），显示的月份跟过去。
    act(() => setExternal('2026-11-03'));
    expect(title()).toBe('November 2026');
    expect(cell('2026-11-03').getAttribute('aria-selected')).toBe('true');
  });

  it('pages months with the header buttons without changing the selection (uncontrolled)', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <DateCalendar
          defaultValue="2026-10-09"
          labels={labels}
          locale="en-US"
          onChange={onChange}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    expect(title()).toBe('November 2026');
    expect(onChange).not.toHaveBeenCalled();
    act(() => cell('2026-11-02').click());
    expect(onChange).toHaveBeenCalledWith('2026-11-02');
  });

  it('covers only the date grid, pauses its interaction and keeps month navigation available', () => {
    const onChange = vi.fn();
    const render = (covered: boolean) =>
      act(() =>
        root.render(
          <DateCalendar
            defaultValue="2026-10-09"
            labels={labels}
            locale="en-US"
            onChange={onChange}
            gridOverlay={
              covered ? (
                <div data-test-overlay role="status">
                  Loading dates
                </div>
              ) : undefined
            }
            dayAnnotation={(date) =>
              date === '2026-10-10'
                ? { label: '3 submissions', detail: '3', marker: null }
                : undefined
            }
          />,
        ),
      );
    render(false);
    const grid = container.querySelector('table')!;
    expect(grid.hasAttribute('inert')).toBe(false);
    render(true);
    expect(container.querySelector('table')).toBe(grid);
    const region = container.querySelector('.rx-calendar-grid-region')!;
    expect(region.querySelector('[data-test-overlay]')).not.toBeNull();
    expect(region.querySelector('.rx-calendar-header')).toBeNull();
    expect(grid.hasAttribute('inert')).toBe(true);
    expect(grid.getAttribute('aria-busy')).toBe('true');
    expect(cell('2026-10-10').querySelector('.rx-calendar-day-detail')?.textContent).toBe('3');
    act(() => cell('2026-10-10').click());
    key(cell('2026-10-09'), 'Enter');
    key(cell('2026-10-09'), 'ArrowRight');
    expect(onChange).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    expect(title()).toBe('November 2026');
    expect(onChange).not.toHaveBeenCalled();
    render(false);
    expect(grid.hasAttribute('inert')).toBe(false);
    expect(grid.hasAttribute('aria-busy')).toBe(false);
    expect(region.querySelector('[data-test-overlay]')).toBeNull();
    act(() => cell('2026-11-02').click());
    expect(onChange).toHaveBeenCalledWith('2026-11-02');
  });

  it('waits for the optional month gate for headers and keyboard crossings before emitting a new range', async () => {
    const gate = vi.fn();
    const ranges = vi.fn();
    let resolve!: (allowed: boolean) => void;
    gate.mockImplementation(
      () =>
        new Promise<boolean>((value) => {
          resolve = value;
        }),
    );
    act(() =>
      root.render(
        <DateCalendar
          defaultValue="2026-10-31"
          labels={labels}
          locale="en-US"
          onBeforeMonthChange={gate}
          onVisibleRangeChange={ranges}
        />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click(),
    );
    expect(title()).toBe('October 2026');
    expect(ranges).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenLastCalledWith('2026-11-30', expect.any(AbortSignal));
    await act(async () => resolve(false));
    expect(title()).toBe('October 2026');
    await act(async () => key(cell('2026-10-31'), 'ArrowRight'));
    expect(gate).toHaveBeenLastCalledWith('2026-11-01', expect.any(AbortSignal));
    expect(title()).toBe('October 2026');
    await act(async () => resolve(true));
    expect(title()).toBe('November 2026');
    expect(ranges).toHaveBeenCalledTimes(2);
  });

  it('ignores superseded month gates and cancels them when controlled dates or constraints change', async () => {
    const pending: Array<{ resolve: (allowed: boolean) => void; signal: AbortSignal }> = [];
    const gate = vi.fn(
      (_date: string, signal: AbortSignal) =>
        new Promise<boolean>((resolve) => pending.push({ resolve, signal })),
    );
    const render = (value: string, max?: string) =>
      act(() =>
        root.render(
          <DateCalendar
            value={value}
            max={max}
            labels={labels}
            locale="en-US"
            onBeforeMonthChange={gate}
          />,
        ),
      );
    render('2026-10-09');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.click(),
    );
    expect(pending[0]!.signal.aborted).toBe(true);
    await act(async () => pending[1]!.resolve(true));
    expect(title()).toBe('September 2026');
    await act(async () => pending[0]!.resolve(true));
    expect(title()).toBe('September 2026');
    render('2026-10-09');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click(),
    );
    render('2026-12-03');
    expect(pending[2]!.signal.aborted).toBe(true);
    await act(async () => pending[2]!.resolve(true));
    expect(title()).toBe('December 2026');
    render('2026-10-09', '2026-12-31');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click(),
    );
    render('2026-10-09', '2026-10-31');
    expect(pending[3]!.signal.aborted).toBe(true);
    await act(async () => pending[3]!.resolve(true));
    expect(title()).toBe('October 2026');
  });

  it('localizes weekday headers and month title', () => {
    act(() => root.render(<DateCalendar labels={labels} locale="zh-CN" value="2026-10-09" />));
    expect(title()).toBe('2026年10月');
    expect(container.querySelector('.rx-calendar-weekday')?.getAttribute('abbr')).toBe('星期一');
    // zh-CN 的 `{ day: 'numeric' }` 会带「日」字，日格里只放数字。
    expect(cell('2026-10-09').textContent).toBe('9');
  });

  it('announces day annotations without changing selection or keyboard navigation', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <DateCalendar
          dayAnnotation={(date) =>
            date === '2026-10-09'
              ? { label: 'Review completed, 4 of 4', marker: <span>✓</span> }
              : undefined
          }
          labels={labels}
          locale="en-US"
          onChange={onChange}
          value="2026-10-08"
        />,
      ),
    );
    expect(cell('2026-10-09').getAttribute('aria-label')).toContain('Review completed, 4 of 4');
    expect(cell('2026-10-09').getAttribute('aria-selected')).toBe('false');
    expect(
      cell('2026-10-09').querySelector('.rx-calendar-day-marker')?.getAttribute('aria-hidden'),
    ).toBe('true');
    act(() => cell('2026-10-08').focus());
    key(cell('2026-10-08'), 'ArrowRight');
    key(document.activeElement, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-09');
  });

  it('renders an optional count line beside its marker while keeping a single selectable day', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <DateCalendar
          labels={labels}
          locale="en-US"
          value="2026-10-09"
          onChange={onChange}
          dayAnnotation={(date) =>
            date === '2026-10-09'
              ? { label: '5 submissions, complete', detail: 5, marker: <span>✓</span> }
              : undefined
          }
        />,
      ),
    );
    expect(cell('2026-10-09').querySelector('.rx-calendar-day-detail')?.textContent).toBe('5✓');
    expect(cell('2026-10-09').getAttribute('aria-label')).toContain('5 submissions, complete');
    act(() => cell('2026-10-09').focus());
    key(cell('2026-10-09'), 'ArrowRight');
    key(document.activeElement, 'Enter');
    expect(onChange).toHaveBeenCalledWith('2026-10-10');
    expect(cell('2026-10-10').hasAttribute('data-detail')).toBe(false);
  });

  it('reports the complete visible grid on mount, month paging and external date changes', () => {
    const onRange = vi.fn();
    const onChange = vi.fn();
    const render = (value: string) =>
      act(() =>
        root.render(
          <DateCalendar
            labels={labels}
            locale="en-US"
            onChange={onChange}
            onVisibleRangeChange={onRange}
            value={value}
          />,
        ),
      );
    render('2026-10-09');
    expect(onRange).toHaveBeenLastCalledWith({ start: '2026-09-28', end: '2026-11-08' });
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    expect(onRange).toHaveBeenLastCalledWith({ start: '2026-10-26', end: '2026-12-06' });
    expect(onChange).not.toHaveBeenCalled();
    render('2026-12-09');
    expect(onRange).toHaveBeenLastCalledWith({ start: '2026-11-30', end: '2027-01-10' });
    // Stable props and the same visible month do not refetch the range.
    const calls = onRange.mock.calls.length;
    render('2026-12-10');
    expect(onRange).toHaveBeenCalledTimes(calls);
  });

  it('does not repeat range notifications when an inline callback updates parent state', () => {
    const notified = vi.fn();
    function Harness() {
      const [range, setRange] = useState<{ start: string; end: string } | null>(null);
      return (
        <>
          <output>{range?.start}</output>
          <DateCalendar
            labels={labels}
            onVisibleRangeChange={(next) => {
              notified(next);
              setRange(next);
            }}
            value="2026-10-09"
          />
        </>
      );
    }
    act(() => root.render(<Harness />));
    expect(notified).toHaveBeenCalledTimes(1);
    expect(container.querySelector('output')?.textContent).toBe('2026-09-28');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    expect(notified).toHaveBeenCalledTimes(2);
    expect(container.querySelector('output')?.textContent).toBe('2026-10-26');
  });
});

describe('DatePicker display="pill"', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the pill trigger with custom text and marks the supplied today in the panel', () => {
    act(() =>
      root.render(
        <DatePicker
          aria-label="Pick a date"
          display="pill"
          formatValue={() => 'Oct 5 – Oct 11'}
          labels={labels}
          locale="en-US"
          today="2026-10-09"
          value="2026-10-08"
        />,
      ),
    );
    const field = container.querySelector<HTMLElement>('.rx-date-field')!;
    expect(field.dataset.variant).toBe('pill');
    const trigger = container.querySelector<HTMLButtonElement>('.rx-date-field-trigger')!;
    expect(trigger.textContent).toContain('Oct 5 – Oct 11');
    act(() => trigger.click());
    expect(document.querySelector('[data-date="2026-10-09"]')?.getAttribute('aria-current')).toBe(
      'date',
    );
  });

  it('keeps the default field look when display is omitted', () => {
    act(() => root.render(<DatePicker labels={labels} locale="en-US" value="2026-10-08" />));
    expect(container.querySelector<HTMLElement>('.rx-date-field')!.dataset.variant).toBe('field');
  });
});
