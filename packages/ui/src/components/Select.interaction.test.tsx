// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPortalRoot } from '../primitives/layer';
import { Select, type SelectOption } from './Select';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const options = [
  { value: 'language', label: 'Language' },
  { value: 'disabled', label: 'Disabled', disabled: true },
  { value: 'history', label: 'History' },
  { value: 'geography', label: 'Geography' },
] as const satisfies readonly SelectOption[];

describe('Select interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let visualViewportDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    visualViewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (visualViewportDescriptor === undefined) {
      Reflect.deleteProperty(window, 'visualViewport');
    } else {
      Object.defineProperty(window, 'visualViewport', visualViewportDescriptor);
    }
  });

  function renderSelect({
    autoFocus = false,
    disabled = false,
    listboxClassName,
    onChange = vi.fn(),
    portal = false,
    value = 'language' as string | undefined,
  }: {
    autoFocus?: boolean;
    disabled?: boolean;
    listboxClassName?: string;
    onChange?: (value: string) => void;
    portal?: boolean;
    value?: string | undefined;
  } = {}) {
    act(() => {
      root.render(
        <Select
          aria-label="Subject"
          autoFocus={autoFocus}
          disabled={disabled}
          listboxClassName={listboxClassName}
          onChange={onChange}
          options={options}
          placeholder="Choose a subject"
          portal={portal}
          value={value}
        />,
      );
    });
    return container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  }

  it('forwards auto focus to the combobox trigger', () => {
    const trigger = renderSelect({ autoFocus: true });
    expect(document.activeElement).toBe(trigger);
  });

  function key(target: HTMLElement, value: string, shiftKey = false) {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: value,
      shiftKey,
    });
    act(() => target.dispatchEvent(event));
    return event;
  }

  it('uses a select-only combobox with stable active and selected option state', () => {
    const trigger = renderSelect({ value: 'history' });
    const controls = trigger.getAttribute('aria-controls');

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(controls).toBeTruthy();
    expect(trigger.hasAttribute('aria-activedescendant')).toBe(false);

    act(() => trigger.focus());
    act(() => trigger.click());

    const listbox = document.querySelector('[role="listbox"]');
    const renderedOptions = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    const history = renderedOptions[2];
    expect(listbox?.id).toBe(controls);
    expect(listbox?.parentElement).toBe(trigger.parentElement);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(history.id);
    expect(history.getAttribute('aria-selected')).toBe('true');
    expect(renderedOptions[1].getAttribute('aria-disabled')).toBe('true');

    act(() => trigger.click());
    act(() => trigger.click());
    expect(document.querySelectorAll<HTMLElement>('[role="option"]')[2].id).toBe(history.id);
  });

  it('navigates enabled options and selects with the keyboard while retaining trigger focus', () => {
    const onChange = vi.fn();
    const trigger = renderSelect({ onChange });
    act(() => trigger.focus());

    key(trigger, 'ArrowDown');
    key(trigger, 'ArrowDown');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      document.querySelectorAll<HTMLElement>('[role="option"]')[2].id,
    );

    key(trigger, 'End');
    key(trigger, 'Enter');
    expect(onChange).toHaveBeenCalledWith('geography');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    const updatedTrigger = renderSelect({ onChange, value: 'geography' });
    key(updatedTrigger, ' ');
    key(updatedTrigger, 'Home');
    key(updatedTrigger, ' ');
    expect(onChange).toHaveBeenLastCalledWith('language');
  });

  it('keeps marking a portaled listbox with data-portal for existing consumers', () => {
    const trigger = renderSelect({ portal: true });
    act(() => trigger.click());
    expect(document.querySelector('[role="listbox"]')?.getAttribute('data-portal')).toBe('true');
  });

  it('keeps the phase-1 option id format so callers can locate options via aria-controls', () => {
    const trigger = renderSelect();
    act(() => trigger.click());
    const optionId = `${trigger.getAttribute('aria-controls')}-option-${encodeURIComponent('history')}`;
    const option = document.getElementById(optionId);
    expect(option?.getAttribute('role')).toBe('option');
    expect(option?.textContent).toContain('History');
  });

  it('closes on Escape without escaping to an ancestor and closes on Tab without blocking traversal', () => {
    const trigger = renderSelect({ portal: true });
    const ancestorKeyDown = vi.fn();
    document.addEventListener('keydown', ancestorKeyDown);
    act(() => trigger.click());

    const escape = key(trigger, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(ancestorKeyDown).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    act(() => trigger.click());
    const tab = key(trigger, 'Tab', true);
    expect(tab.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    act(() => trigger.click());
    const forwardTab = key(trigger, 'Tab');
    expect(forwardTab.defaultPrevented).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    document.removeEventListener('keydown', ancestorKeyDown);
  });

  it.each([false, true])(
    'keeps keyboard navigation inside the visible list (portal=%s)',
    (portal) => {
      const trigger = renderSelect({ portal });
      act(() => trigger.click());
      const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
      const items = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
      Object.defineProperty(list, 'clientHeight', { value: 60 });
      vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
      items.forEach((item, index) => {
        vi.spyOn(item, 'getBoundingClientRect').mockImplementation(
          () =>
            ({
              top: 100 + index * 30 - list.scrollTop,
              bottom: 130 + index * 30 - list.scrollTop,
            }) as DOMRect,
        );
      });
      key(trigger, 'ArrowDown'); // Skip the disabled second option.
      expect(list.scrollTop).toBe(30);
      key(trigger, 'ArrowDown');
      expect(list.scrollTop).toBe(60);
      key(trigger, 'Home');
      expect(list.scrollTop).toBe(0);
      key(trigger, 'End');
      expect(list.scrollTop).toBe(60);
      key(trigger, 'ArrowUp');
      key(trigger, 'ArrowUp');
      expect(list.scrollTop).toBe(0);
    },
  );

  it('does not pull manual scrolling back on pointer movement or parent rerenders', () => {
    const onWheel = vi.fn();
    const render = () =>
      act(() =>
        root.render(
          <div onWheel={onWheel}>
            <Select
              aria-label="Subject"
              onChange={vi.fn()}
              options={options.map((option) => ({ ...option }))}
              portal
              value="language"
            />
          </div>,
        ),
      );
    render();
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    act(() => trigger.click());
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    const items = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    const scrollIntoView = vi.fn();
    items.forEach((item) => Object.assign(item, { scrollIntoView }));
    Object.defineProperty(list, 'clientHeight', { value: 60 });
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(items[2], 'getBoundingClientRect').mockReturnValue({
      top: 80,
      bottom: 110,
    } as DOMRect);
    list.scrollTop = 80;
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 2.5 });
    act(() => list.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(false);
    expect(onWheel).not.toHaveBeenCalled();
    act(() => items[2].dispatchEvent(new Event('pointermove', { bubbles: true })));
    render();
    expect(list.scrollTop).toBe(80);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('dismisses on an outside pointer and selects through pointer-compatible click behavior', () => {
    const onChange = vi.fn();
    const trigger = renderSelect({ onChange, portal: true });
    act(() => trigger.click());

    act(() =>
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })),
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    act(() => trigger.click());
    const geography = document.querySelectorAll<HTMLElement>('[role="option"]')[3];
    act(() => geography.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    act(() => geography.click());
    expect(onChange).toHaveBeenCalledWith('geography');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when disabled while open and cannot be reopened', () => {
    const trigger = renderSelect({ portal: true });
    act(() => trigger.click());
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    const disabledTrigger = renderSelect({ disabled: true, portal: true });
    expect(disabledTrigger.disabled).toBe(true);
    expect(disabledTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    act(() => disabledTrigger.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('does not reopen through a wrapping label after an option is selected', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <label>
          Subject
          <Select aria-label="Subject" onChange={onChange} options={options} value="language" />
        </label>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    act(() => trigger.click());
    act(() => document.querySelectorAll<HTMLElement>('[role="option"]')[2].click());

    expect(onChange).toHaveBeenCalledWith('history');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('associates a visible label with both the combobox and listbox', () => {
    act(() => {
      root.render(
        <div>
          <span id="subject-label">Subject</span>
          <Select
            aria-labelledby="subject-label"
            onChange={vi.fn()}
            options={options}
            value="language"
          />
        </div>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.getAttribute('aria-labelledby')).toBe('subject-label');

    act(() => trigger.click());
    expect(document.querySelector('[role="listbox"]')?.getAttribute('aria-labelledby')).toBe(
      'subject-label',
    );
  });

  it('portals the popup and repositions it after a scrolled-layout geometry change', () => {
    const trigger = renderSelect({ listboxClassName: 'subject-listbox', portal: true });
    let rect = {
      bottom: 120,
      height: 36,
      left: 900,
      right: 1100,
      top: 84,
      width: 200,
      x: 900,
      y: 84,
      toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => rect);

    act(() => trigger.click());
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    // Phase 2 (spec 03 §3.4): portaled panels live in the shared portal root, are at least as
    // wide as the trigger and cap at 320px.
    expect(listbox.parentElement).toBe(getPortalRoot());
    expect(listbox.classList.contains('subject-listbox')).toBe(true);
    expect(listbox.dataset.side).toBe('bottom');
    expect(listbox.style.left).toBe('816px');
    expect(listbox.style.top).toBe('124px');
    expect(listbox.style.minWidth).toBe('200px');
    expect(listbox.style.maxHeight).toBe('320px');

    // jsdom has no layout engine, so mocked DOMRects exercise the measurable collision calculation.
    rect = {
      ...rect,
      bottom: 736,
      left: 100,
      right: 300,
      top: 700,
      x: 100,
      y: 700,
    };
    // useFloating flips by measured content height; jsdom has no layout, so give the panel one.
    Object.defineProperty(listbox, 'scrollHeight', { configurable: true, value: 200 });
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(listbox.dataset.side).toBe('top');
    expect(listbox.style.left).toBe('100px');
    expect(listbox.style.top).toBe('496px');

    act(() => trigger.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('constrains the popup to a narrow offset visual viewport', () => {
    const visualViewport = new EventTarget() as EventTarget &
      Pick<VisualViewport, 'height' | 'offsetLeft' | 'offsetTop' | 'width'>;
    Object.assign(visualViewport, { height: 568, offsetLeft: 0, offsetTop: 100, width: 320 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    const trigger = renderSelect({ portal: true });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      bottom: 236,
      height: 36,
      left: 20,
      right: 420,
      top: 200,
      width: 400,
      x: 20,
      y: 200,
      toJSON: () => ({}),
    } as DOMRect);

    act(() => trigger.click());
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox.parentElement).toBe(getPortalRoot());
    expect(listbox.dataset.side).toBe('bottom');
    expect(listbox.style.left).toBe('8px');
    expect(listbox.style.top).toBe('240px');
    expect(listbox.style.minWidth).toBe('304px');
    expect(listbox.style.maxHeight).toBe('320px');
  });
});

describe('Select phase-2 capabilities', () => {
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
    vi.useRealTimers();
  });

  const trigger = () => container.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
  const optionEls = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const optionNamed = (name: string) => optionEls().find((option) => option.textContent === name);
  const search = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const flush = () => act(async () => {});

  function press(target: HTMLElement, value: string) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value });
    act(() => target.dispatchEvent(event));
    return event;
  }

  function typeInto(input: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('works uncontrolled from defaultValue and exposes state attributes', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <Select
          aria-label="Subject"
          defaultValue="history"
          name="subject"
          onChange={onChange}
          options={options}
          size="lg"
          variant="filled"
        />,
      ),
    );
    const select = container.querySelector<HTMLElement>('.rx-select')!;
    expect(select.dataset.variant).toBe('filled');
    expect(select.dataset.size).toBe('lg');
    expect(select.classList.contains('rx-sized')).toBe(true);
    expect(trigger().textContent).toBe('History');
    expect(container.querySelector<HTMLInputElement>('input[name="subject"]')?.value).toBe(
      'history',
    );

    act(() => trigger().click());
    expect(select.dataset.state).toBe('open');
    act(() => optionNamed('Geography')!.click());
    expect(onChange).toHaveBeenCalledWith('geography');
    expect(trigger().textContent).toBe('Geography');
    expect(container.querySelector<HTMLInputElement>('input[name="subject"]')?.value).toBe(
      'geography',
    );
  });

  it('does not write data-size without an explicit size', () => {
    act(() => root.render(<Select aria-label="Subject" options={options} />));
    expect(container.querySelector<HTMLElement>('.rx-select')!.hasAttribute('data-size')).toBe(
      false,
    );
    expect(trigger().textContent).toBe('');
  });

  it('searches local options, highlights hits, and selects the first match with Enter', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <Select
          aria-label="Subject"
          emptyLabel="No matches"
          onChange={onChange}
          options={options}
          searchable
          searchPlaceholder="Search"
          value="language"
        />,
      ),
    );
    act(() => trigger().click());
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute('aria-controls')).toBe(trigger().getAttribute('aria-controls'));
    expect(trigger().hasAttribute('aria-activedescendant')).toBe(false);

    typeInto(search(), 'GRA');
    expect(optionEls().map((option) => option.textContent)).toEqual(['Geography']);
    expect(document.querySelector('.rx-select-hit')?.textContent).toBe('gra');
    expect(search().getAttribute('aria-activedescendant')).toBe(optionEls()[0].id);

    press(search(), 'Enter');
    expect(onChange).toHaveBeenCalledWith('geography');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());

    act(() => trigger().click());
    typeInto(search(), 'zzz');
    expect(optionEls()).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe('No matches');

    const escape = press(search(), 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('starts searching when typing on a searchable trigger and closes on Tab from the search box', () => {
    act(() =>
      root.render(
        <div>
          <Select aria-label="Subject" options={options} searchable />
          <button type="button">Next</button>
        </div>,
      ),
    );
    act(() => trigger().focus());
    press(trigger(), 'h');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(search().value).toBe('h');

    const tab = press(search(), 'Tab');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe('Next');
  });

  it('supports custom filterOption', () => {
    act(() =>
      root.render(
        <Select
          aria-label="Subject"
          filterOption={(option, query) => option.value.startsWith(query)}
          options={options}
          searchable
        />,
      ),
    );
    act(() => trigger().click());
    typeInto(search(), 'hist');
    expect(optionEls().map((option) => option.textContent)).toEqual(['History']);
  });

  it('jumps to options by typing on a select-only trigger', () => {
    act(() => root.render(<Select aria-label="Subject" options={options} />));
    act(() => trigger().focus());
    press(trigger(), 'g');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-activedescendant')).toBe(optionNamed('Geography')!.id);
  });

  it('renders groups as non-selectable headers and skips them with the keyboard', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <Select
          aria-label="Stage"
          onChange={onChange}
          options={[
            { type: 'group', label: 'Primary', options: [{ value: 'p1', label: 'Grade 1' }] },
            { type: 'group', label: 'Secondary', options: [{ value: 's1', label: 'Grade 7' }] },
          ]}
        />,
      ),
    );
    act(() => trigger().focus());
    press(trigger(), 'ArrowDown');
    const groups = [...document.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups).toHaveLength(2);
    expect(groups[0].getAttribute('aria-labelledby')).toBe(
      groups[0].querySelector('.rx-select-group-label')?.id,
    );
    expect(trigger().getAttribute('aria-activedescendant')).toBe(optionNamed('Grade 1')!.id);
    press(trigger(), 'ArrowDown');
    expect(trigger().getAttribute('aria-activedescendant')).toBe(optionNamed('Grade 7')!.id);
    press(trigger(), 'Enter');
    expect(onChange).toHaveBeenCalledWith('s1');
  });

  it('offers creation when nothing matches', () => {
    const onCreate = vi.fn();
    act(() =>
      root.render(
        <Select
          aria-label="Subject"
          createLabel={(query) => `Create "${query}"`}
          creatable
          emptyLabel="No matches"
          onCreate={onCreate}
          options={options}
          searchable
        />,
      ),
    );
    act(() => trigger().click());
    typeInto(search(), 'Physics');
    expect(optionEls().map((option) => option.textContent)).toEqual(['Create "Physics"']);
    press(search(), 'Enter');
    expect(onCreate).toHaveBeenCalledWith('Physics');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('shows an active filter pill with a clear button that returns to the empty value', () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    const render = (value: string) =>
      act(() =>
        root.render(
          <Select
            aria-label="Stage"
            clearLabel="Clear"
            clearable
            emptyValue="all"
            onChange={onChange}
            onClear={onClear}
            options={[
              { value: 'all', label: 'All stages' },
              { value: 'high', label: 'High school' },
            ]}
            value={value}
            variant="filter"
          />,
        ),
      );
    render('all');
    const select = container.querySelector<HTMLElement>('.rx-select')!;
    expect(select.hasAttribute('data-active')).toBe(false);
    expect(container.querySelector('button[aria-label="Clear"]')).toBeNull();

    render('high');
    expect(select.hasAttribute('data-active')).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Clear"]')!.click());
    expect(onChange).toHaveBeenCalledWith('all');
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger());
  });

  it('clears an uncontrolled outlined select back to the placeholder', () => {
    const onClear = vi.fn();
    act(() =>
      root.render(
        <Select
          aria-label="Subject"
          clearLabel="Clear"
          clearable
          defaultValue="history"
          onClear={onClear}
          options={options}
          placeholder="Choose"
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Clear"]')!.click());
    expect(onClear).toHaveBeenCalled();
    expect(trigger().textContent).toBe('Choose');
    expect(container.querySelector('button[aria-label="Clear"]')).toBeNull();
  });

  it('does not open when read-only and marks invalid state', () => {
    act(() =>
      root.render(
        <Select aria-label="Subject" invalid options={options} readOnly value="history" />,
      ),
    );
    act(() => trigger().click());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-readonly')).toBe('true');
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps a long label intact in the trigger', () => {
    const label = 'A very long option label '.repeat(8).trim();
    act(() =>
      root.render(
        <Select aria-label="Subject" options={[{ value: 'long', label }]} value="long" />,
      ),
    );
    expect(trigger().querySelector('.rx-select-value')?.textContent).toBe(label);
  });

  it('never shows a raw id: uses selectedOption, or resolves it asynchronously', async () => {
    act(() =>
      root.render(
        <Select
          aria-label="Teacher"
          options={[]}
          selectedOption={{ value: 'u-42', label: 'Ada' }}
          value="u-42"
        />,
      ),
    );
    expect(trigger().textContent).toBe('Ada');

    let resolveLabels!: (options: SelectOption[]) => void;
    const resolveOptions = vi.fn(
      () =>
        new Promise<SelectOption[]>((resolve) => {
          resolveLabels = resolve;
        }),
    );
    act(() =>
      root.render(
        <Select
          aria-label="Teacher"
          options={[]}
          placeholder="Choose"
          resolveOptions={resolveOptions}
          value="u-7"
        />,
      ),
    );
    await flush();
    expect(resolveOptions).toHaveBeenCalledWith(['u-7']);
    expect(trigger().textContent).toBe('');
    expect(trigger().getAttribute('aria-busy')).toBe('true');
    await act(async () => resolveLabels([{ value: 'u-7', label: 'Grace' }]));
    expect(trigger().textContent).toBe('Grace');
  });

  it.each([
    [false, undefined],
    [true, undefined],
    [false, 'responsive'],
    [true, 'responsive'],
  ] as const)('列表触控属性在 portal=%s 时保持 %s', (portal, touchTarget) => {
    act(() =>
      root.render(
        <Select
          aria-label="Subject"
          options={options}
          portal={portal}
          searchable
          touchTarget={touchTarget}
        />,
      ),
    );
    act(() => trigger().click());
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    const panel = listbox.closest<HTMLElement>('.rx-select-panel')!;
    expect(listbox.dataset.touchTarget).toBe(touchTarget);
    expect(panel.dataset.touchTarget).toBe(touchTarget);
    expect(container.contains(panel)).toBe(!portal);
  });

  it('响应式虚拟列表在视口变化后同步实际行高和偏移', () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      value: String(index),
      label: `Option ${index}`,
    }));
    act(() =>
      root.render(<Select aria-label="Many" options={many} portal touchTarget="responsive" />),
    );
    act(() => trigger().click());
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    for (const height of [40, 32]) {
      listbox.style.setProperty('--rx-option-height', `${height}px`);
      act(() => window.dispatchEvent(new Event('resize')));
      expect(listbox.querySelector<HTMLElement>('.rx-select-virtual')!.style.height).toBe(
        `${height * 120}px`,
      );
      const rows = listbox.querySelectorAll<HTMLElement>('[role="option"]');
      expect(rows[0].style.height).toBe(`${height}px`);
      expect(rows[1].style.top).toBe(`${height}px`);
    }
  });

  it('virtualizes more than 100 loaded options and keeps the active option rendered', () => {
    const many = Array.from({ length: 500 }, (_, index) => ({
      value: `v${index + 1}`,
      label: `Option ${index + 1}`,
    }));
    act(() => root.render(<Select aria-label="Many" options={many} />));
    act(() => trigger().focus());
    press(trigger(), 'ArrowDown');
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox.dataset.virtual).toBeDefined();
    expect(optionEls().length).toBeLessThan(60);
    expect(optionEls()[0].getAttribute('aria-setsize')).toBe('500');

    press(trigger(), 'End');
    const activeId = trigger().getAttribute('aria-activedescendant')!;
    expect(document.getElementById(activeId)?.textContent).toBe('Option 500');
    expect(document.getElementById(activeId)?.getAttribute('aria-posinset')).toBe('500');
    expect(listbox.scrollTop).toBeGreaterThan(0);
    expect(optionEls().length).toBeLessThan(60);
  });

  describe('remote data', () => {
    type Page = { items: SelectOption[]; nextCursor?: string | null };
    type Call = {
      cursor: string | number | undefined;
      query: string;
      reject: (error: Error) => void;
      resolve: (result: Page) => void;
      signal: AbortSignal;
    };

    function remoteLoader() {
      const calls: Call[] = [];
      const loadOptions = vi.fn(
        ({
          cursor,
          query,
          signal,
        }: {
          cursor: string | number | undefined;
          query: string;
          signal: AbortSignal;
        }) =>
          new Promise<Page>((resolve, reject) => {
            calls.push({ cursor, query, reject, resolve, signal });
          }),
      );
      return { calls, loadOptions };
    }

    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        value: `t${from + index}`,
        label: `Teacher ${from + index}`,
      }));

    function renderRemote(loadOptions: ReturnType<typeof remoteLoader>['loadOptions']) {
      const onChange = vi.fn();
      act(() =>
        root.render(
          <Select
            aria-label="Teacher"
            emptyLabel="No matches"
            endLabel="All loaded"
            errorLabel="Failed to load"
            loadOptions={loadOptions}
            loadingLabel="Loading…"
            onChange={onChange}
            retryLabel="Retry"
          />,
        ),
      );
      return onChange;
    }

    it('loads the first page on open, pages near the bottom and reports the end', async () => {
      const { calls, loadOptions } = remoteLoader();
      const onChange = renderRemote(loadOptions);
      expect(loadOptions).not.toHaveBeenCalled();

      act(() => trigger().click());
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ cursor: undefined, query: '' });
      const status = () => document.querySelector('[role="status"]')!;
      expect(status().textContent).toBe('Loading…');
      expect(document.querySelector('[role="listbox"]')?.getAttribute('aria-busy')).toBe('true');

      await act(async () => calls[0].resolve({ items: page(1, 20), nextCursor: 'c2' }));
      expect(optionEls()).toHaveLength(20);
      expect(status().textContent).toBe('');

      const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
      Object.defineProperty(listbox, 'scrollHeight', { configurable: true, value: 640 });
      Object.defineProperty(listbox, 'clientHeight', { configurable: true, value: 320 });
      listbox.scrollTop = 250;
      act(() => listbox.dispatchEvent(new Event('scroll')));
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ cursor: 'c2', query: '' });
      // A second scroll while the page is in flight does not duplicate the request.
      act(() => listbox.dispatchEvent(new Event('scroll')));
      expect(calls).toHaveLength(2);

      await act(async () => calls[1].resolve({ items: page(21, 5), nextCursor: null }));
      expect(optionEls()).toHaveLength(25);
      expect(status().textContent).toBe('All loaded');

      act(() => optionNamed('Teacher 23')!.click());
      expect(onChange).toHaveBeenCalledWith('t23');
    });

    it('opt-in threshold resets rows and paging immediately, cancels races and retains deduplication', async () => {
      vi.useFakeTimers();
      const { calls, loadOptions } = remoteLoader();
      const onChange = vi.fn();
      act(() =>
        root.render(
          <Select
            aria-label="Teacher"
            loadOptions={loadOptions}
            minSearchLength={2}
            minSearchLabel="Type two characters"
            resetOnQueryChange
            searchDebounceMs={250}
            onChange={onChange}
          />,
        ),
      );
      act(() => trigger().click());
      expect(document.querySelector('[role="status"]')?.textContent).toBe('Type two characters');
      typeInto(search(), ' a ');
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(calls).toHaveLength(0);
      typeInto(search(), '  Teacher A  ');
      await act(async () => vi.advanceTimersByTimeAsync(249));
      expect(calls).toHaveLength(0);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(calls[0].query).toBe('Teacher A');
      await act(async () => calls[0].resolve({ items: page(1, 10), nextCursor: 'second' }));
      for (let i = 0; i < 8; i++) press(search(), 'ArrowDown');
      expect(calls[1].cursor).toBe('second');
      typeInto(search(), 'Teacher B');
      expect(calls[1].signal.aborted).toBe(true);
      expect(optionEls()).toHaveLength(0);
      press(search(), 'Enter');
      press(search(), 'End');
      expect(onChange).not.toHaveBeenCalled();
      expect(calls).toHaveLength(2);
      await act(async () => calls[1].resolve({ items: page(11, 10), nextCursor: 'third' }));
      expect(optionEls()).toHaveLength(0);
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(calls[2]).toMatchObject({ query: 'Teacher B', cursor: undefined });
      await act(async () =>
        calls[2].resolve({ items: [...page(1, 10), ...page(1, 1)], nextCursor: 'b2' }),
      );
      expect(optionEls()).toHaveLength(10);
      typeInto(search(), ' ');
      expect(optionEls()).toHaveLength(0);
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(calls).toHaveLength(3);
    });

    it('loads the next page when the keyboard reaches the last 3 options', async () => {
      const { calls, loadOptions } = remoteLoader();
      renderRemote(loadOptions);
      act(() => trigger().click());
      await act(async () => calls[0].resolve({ items: page(1, 5), nextCursor: 'c2' }));
      press(search(), 'ArrowDown');
      expect(calls).toHaveLength(1);
      press(search(), 'ArrowDown');
      expect(calls).toHaveLength(2);
      expect(calls[1].cursor).toBe('c2');
    });

    it('retries a failed later page without losing loaded options or duplicating them', async () => {
      const { calls, loadOptions } = remoteLoader();
      renderRemote(loadOptions);
      act(() => trigger().click());
      await act(async () => calls[0].resolve({ items: page(1, 5), nextCursor: 'second' }));
      press(search(), 'ArrowDown');
      press(search(), 'ArrowDown');
      await act(async () => calls[1].reject(new Error('Synthetic failure')));
      expect(optionEls()).toHaveLength(5);
      act(() => document.querySelector<HTMLButtonElement>('.rx-select-retry')!.click());
      expect(calls[2]).toMatchObject({ query: '', cursor: 'second' });
      await act(async () =>
        calls[2].resolve({ items: [...page(5, 1), ...page(6, 5)], nextCursor: null }),
      );
      expect(optionEls()).toHaveLength(10);
      expect(document.querySelector('[role="status"]')?.textContent).toBe('All loaded');
    });

    it('debounces search by 300ms and aborts the previous request', async () => {
      vi.useFakeTimers();
      const { calls, loadOptions } = remoteLoader();
      renderRemote(loadOptions);
      act(() => trigger().click());
      expect(document.activeElement).toBe(search());
      expect(calls).toHaveLength(1);

      typeInto(search(), 'a');
      typeInto(search(), 'ad');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(calls).toHaveLength(1);
      expect(document.querySelector('.rx-select-search .rx-spinner')).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(calls).toHaveLength(2);
      expect(calls[1].query).toBe('ad');
      expect(calls[0].signal.aborted).toBe(true);

      // A late answer to the aborted request is ignored.
      await act(async () => calls[0].resolve({ items: page(1, 3) }));
      expect(optionEls()).toHaveLength(0);

      await act(async () => calls[1].resolve({ items: [{ value: 'ada', label: 'Ada' }] }));
      expect(optionEls().map((option) => option.textContent)).toEqual(['Ada']);
      expect(document.querySelector('.rx-select-hit')?.textContent).toBe('Ad');

      // The label of a remote pick survives after the list is gone (no raw id).
      press(search(), 'Enter');
      expect(trigger().textContent).toBe('Ada');
    });

    it('keeps the panel open on failure and retries', async () => {
      const { calls, loadOptions } = remoteLoader();
      renderRemote(loadOptions);
      act(() => trigger().click());
      await act(async () => calls[0].reject(new Error('boom')));
      const status = document.querySelector('[role="status"]')!;
      expect(status.textContent).toContain('Failed to load');
      expect(trigger().getAttribute('aria-expanded')).toBe('true');

      const retry = [...status.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry',
      )!;
      act(() => retry.click());
      expect(calls).toHaveLength(2);
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      await act(async () => calls[1].resolve({ items: [] }));
      expect(document.querySelector('[role="status"]')?.textContent).toBe('No matches');
    });

    it('aborts an in-flight request when the panel closes', () => {
      const { calls, loadOptions } = remoteLoader();
      renderRemote(loadOptions);
      act(() => trigger().click());
      press(search(), 'Escape');
      expect(calls[0].signal.aborted).toBe(true);
      act(() => trigger().click());
      expect(calls).toHaveLength(2);
    });
  });
});
