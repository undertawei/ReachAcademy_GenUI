// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncState } from './AsyncState';
import { Empty } from './Empty';
import { ProgressBar } from './ProgressBar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function setup() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

describe('Empty', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => ({ container, root } = setup()));
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the default icon per variant with title, description and action', () => {
    act(() => {
      root.render(
        <Empty
          action={<button type="button">Clear filters</button>}
          description="Try another keyword"
          title="No matching courses"
          variant="no-results"
        />,
      );
    });
    const empty = container.firstElementChild as HTMLElement;
    expect(empty.dataset.variant).toBe('no-results');
    expect(empty.querySelector('.rx-empty-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(empty.querySelector('.rx-empty-icon svg')).not.toBeNull();
    expect(empty.querySelector('.rx-empty-title')?.textContent).toBe('No matching courses');
    expect(empty.querySelector('.rx-empty-description')?.textContent).toBe('Try another keyword');
    expect(empty.querySelector('.rx-empty-action button')?.textContent).toBe('Clear filters');

    act(() => root.render(<Empty headingLevel={2} icon={null} title="Nothing yet" />));
    expect(container.querySelector('.rx-empty-icon')).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Nothing yet');
    expect(container.querySelector('.rx-empty-description')).toBeNull();
  });
});

describe('AsyncState', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => ({ container, root } = setup()));
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('renders string empty and error states through Empty with a retry slot', () => {
    const onRetry = vi.fn();
    act(() => {
      root.render(
        <AsyncState
          empty="No courses yet"
          emptyAction={<button type="button">Create</button>}
          emptyVariant="no-data"
          status="empty"
        />,
      );
    });
    let region = container.firstElementChild as HTMLElement;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.querySelector('.rx-empty-title')?.textContent).toBe('No courses yet');
    expect(region.querySelector('button')?.textContent).toBe('Create');

    act(() => {
      root.render(
        <AsyncState
          error="Could not load"
          errorDescription="Network timeout"
          retry={
            <button onClick={onRetry} type="button">
              Retry
            </button>
          }
          status="error"
        />,
      );
    });
    region = container.firstElementChild as HTMLElement;
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.querySelector('.rx-empty')?.getAttribute('data-variant')).toBe('error');
    expect(region.querySelector('.rx-empty-description')?.textContent).toBe('Network timeout');
    act(() => region.querySelector('button')!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    // 非字符串节点原样渲染（兼容第一期用法）。
    act(() => root.render(<AsyncState error={<strong>Custom</strong>} status="error" />));
    expect(container.querySelector('strong')?.textContent).toBe('Custom');
    expect(container.querySelector('.rx-empty')).toBeNull();
  });

  it('fades content in after loading and passes children through on success', () => {
    act(() => root.render(<AsyncState loadingLabel="Loading" status="loading" />));
    const loading = container.firstElementChild as HTMLElement;
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).toBe('Loading');

    act(() => root.render(<AsyncState status="success">Data</AsyncState>));
    const content = container.firstElementChild as HTMLElement;
    expect(content.textContent).toBe('Data');
    expect(content.className).toBe('rx-async-state-enter');

    act(() => root.unmount());
    container.remove();
    ({ container, root } = setup());
    act(() => root.render(<AsyncState status="idle">Idle</AsyncState>));
    expect((container.firstElementChild as HTMLElement).hasAttribute('class')).toBe(false);
  });

  it('delays the loading state by 200ms and keeps it at least 300ms', () => {
    vi.useFakeTimers();
    act(() => root.render(<AsyncState delayLoading loadingLabel="Loading" status="loading" />));
    expect(container.textContent).toBe('');
    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
    act(() => vi.advanceTimersByTime(200));
    expect(container.textContent).toBe('Loading');

    act(() =>
      root.render(
        <AsyncState delayLoading loadingLabel="Loading" status="success">
          Data
        </AsyncState>,
      ),
    );
    expect(container.textContent).toBe('Loading');
    act(() => vi.advanceTimersByTime(300));
    expect(container.textContent).toBe('Data');
  });
});

describe('ProgressBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => ({ container, root } = setup()));
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const bar = () => container.querySelector<HTMLElement>('[role="progressbar"]')!;

  it('clamps the value, scales the fill and shows the numeric label', () => {
    act(() => root.render(<ProgressBar label="Upload" max={200} showValue value={50} />));
    expect(bar().getAttribute('aria-valuenow')).toBe('50');
    expect(bar().getAttribute('aria-valuemax')).toBe('200');
    expect(bar().getAttribute('aria-valuetext')).toBe('25%');
    expect(bar().querySelector<HTMLElement>('.rx-progress-value')?.style.transform).toBe(
      'scaleX(0.25)',
    );
    expect(bar().querySelector('.rx-progress-label')?.textContent).toBe('25%');
    expect(bar().dataset.tone).toBe('primary');
    expect(bar().hasAttribute('data-size')).toBe(false);

    act(() => root.render(<ProgressBar label="Upload" value={-10} />));
    expect(bar().getAttribute('aria-valuenow')).toBe('0');
    expect(bar().querySelector('.rx-progress-label')).toBeNull();
  });

  it('switches to success at 100% only with autoSuccess and supports tone/size', () => {
    act(() => root.render(<ProgressBar label="Track" size="lg" tone="orange" value={100} />));
    expect(bar().dataset.tone).toBe('orange');
    expect(bar().dataset.size).toBe('lg');
    expect(bar().dataset.state).toBe('complete');

    act(() => root.render(<ProgressBar autoSuccess label="Track" tone="orange" value={100} />));
    expect(bar().dataset.tone).toBe('success');

    act(() => root.render(<ProgressBar autoSuccess label="Track" tone="orange" value={60} />));
    expect(bar().dataset.tone).toBe('orange');
  });

  it('renders indeterminate progress without a value', () => {
    act(() =>
      root.render(
        <ProgressBar formatValue={(value, max) => `${value}/${max}`} label="Busy" showValue />,
      ),
    );
    expect(bar().className).toContain('rx-progress-indeterminate');
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(bar().dataset.state).toBe('indeterminate');
    expect(bar().querySelector('.rx-progress-label')).toBeNull();
  });
});
