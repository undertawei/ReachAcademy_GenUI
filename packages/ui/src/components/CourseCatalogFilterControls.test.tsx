// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CourseCatalogFilterControls } from './CourseCatalogFilterControls';
import { courseCatalogFilterFields, defaultCourseCatalogFilters } from './course-catalog-filters';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe('course filter controls with real Select and Portal', () => {
  let host: HTMLDivElement, root: Root;
  const onChange = vi.fn();
  beforeEach(() => {
    onChange.mockClear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const fields = courseCatalogFilterFields((key) => key, {
    stage: [{ value: '高中', label: 'High school' }],
    grade: [],
    subject: [],
    source: [],
  });
  function Harness({ disabled = false }: { disabled?: boolean }) {
    const [value, setValue] = useState(defaultCourseCatalogFilters);
    return (
      <CourseCatalogFilterControls
        value={value}
        fields={fields}
        label="Course filters"
        compactLabel="Filters"
        disabled={disabled}
        onChange={(field, next) => {
          onChange(field, next);
          setValue({ ...value, [field]: next });
        }}
      />
    );
  }
  it('orders all five controls and selects/clears through the real portal listbox', async () => {
    await act(async () => root.render(<Harness />));
    const controls = [...host.querySelectorAll<HTMLButtonElement>('[role="combobox"]')];
    expect(controls.map((control) => control.getAttribute('aria-label'))).toEqual([
      'sort',
      'stage',
      'schoolYear',
      'subject',
      'source',
    ]);
    await act(async () => controls[1].click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === 'High school',
    )!;
    expect(host.contains(option)).toBe(false);
    await act(async () => option.click());
    expect(onChange).toHaveBeenLastCalledWith('stage', '高中');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="clearStage"]')!.click(),
    );
    expect(onChange).toHaveBeenLastCalledWith('stage', 'all');
    await act(async () => controls[0].click());
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => option.textContent === 'sort.favorites')!
        .click(),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="clearSort"]')!.click(),
    );
    expect(onChange).toHaveBeenLastCalledWith('sort', 'updated');
  });
  it('keeps all five filters visible in a narrow library and Escape closes only the dropdown', async () => {
    host.style.width = '350px';
    await act(async () => root.render(<Harness />));
    expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(5);
    expect(host.querySelector('button[aria-label="Course filters"]')).toBeNull();
    const stage = host.querySelectorAll<HTMLButtonElement>('[role="combobox"]')[1];
    await act(async () => stage.click());
    expect(stage.getAttribute('aria-expanded')).toBe('true');
    await act(async () =>
      stage.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    expect(stage.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(5);
  });
  it('locks every control during a source drag', async () => {
    await act(async () => root.render(<Harness disabled />));
    const controls = [...host.querySelectorAll<HTMLButtonElement>('[role="combobox"]')];
    expect(controls.every((control) => control.disabled)).toBe(true);
    await act(async () => controls.forEach((control) => control.click()));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
