// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Steps, type StepItem } from './Steps';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const items: StepItem[] = [
  { id: 'needs', label: 'Needs' },
  { id: 'outline', label: 'Outline' },
  { id: 'content', label: 'Content' },
  { id: 'publish', label: 'Publish' },
];

describe('Steps interactions', () => {
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

  const steps = () => Array.from(container.querySelectorAll<HTMLElement>('.rx-steps-item'));
  const buttons = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button.rx-steps-trigger'));

  it('derives statuses, formats two-digit indexes and marks the current step', () => {
    act(() => {
      root.render(
        <Steps
          actions={<button type="button">Publish now</button>}
          current="content"
          items={items}
          leading={<a href="/back">Back</a>}
          navLabel="Progress"
        />,
      );
    });
    expect(steps().map((step) => step.getAttribute('data-state'))).toEqual([
      'complete',
      'complete',
      'current',
      'upcoming',
    ]);
    expect(steps()[0].textContent).toBe('01. Needs');
    expect(steps()[3].textContent).toBe('04. Publish');
    expect(container.querySelector('[aria-current="step"]')!.textContent).toBe('03. Content');
    expect(container.querySelector('nav')!.getAttribute('aria-label')).toBe('Progress');
    expect(
      Array.from(container.querySelectorAll('.rx-steps-connector')).map((line) =>
        line.getAttribute('data-state'),
      ),
    ).toEqual(['complete', 'complete', 'upcoming']);
    expect(container.querySelector('.rx-steps-leading a')!.getAttribute('href')).toBe('/back');
    expect(container.querySelector('.rx-steps-actions button')!.textContent).toBe('Publish now');
    // 不传 onStepClick 时没有可点击步骤。
    expect(buttons()).toHaveLength(0);
  });

  it('lets completed steps be clicked, but not upcoming ones unless jumping is allowed', () => {
    const onStepClick = vi.fn();
    act(() => {
      root.render(<Steps current="outline" items={items} onStepClick={onStepClick} />);
    });
    expect(buttons()).toHaveLength(1);
    act(() => buttons()[0].click());
    expect(onStepClick).toHaveBeenCalledWith('needs', 0);

    act(() => {
      root.render(<Steps allowJump current="outline" items={items} onStepClick={onStepClick} />);
    });
    expect(buttons().map((button) => button.textContent)).toEqual([
      '01. Needs',
      '03. Content',
      '04. Publish',
    ]);
    act(() => buttons()[2].click());
    expect(onStepClick).toHaveBeenLastCalledWith('publish', 3);
  });

  it('accepts a custom index format and an unknown current id', () => {
    act(() => {
      root.render(
        <Steps current="missing" formatIndex={(index) => `Step ${index + 1}:`} items={items} />,
      );
    });
    expect(steps().every((step) => step.getAttribute('data-state') === 'upcoming')).toBe(true);
    expect(steps()[1].textContent).toBe('Step 2: Outline');
    expect(container.querySelector('[aria-current]')).toBeNull();
  });

  it('renders an empty step list', () => {
    act(() => {
      root.render(<Steps current="" items={[]} />);
    });
    expect(steps()).toHaveLength(0);
  });
});
