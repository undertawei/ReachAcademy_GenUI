// @vitest-environment jsdom

import { Users } from 'lucide-react';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Card, CardBody, CardFooter, CardHeader, CardOverlayLink } from './Card';
import { StatTile } from './StatTile';
import { Ribbon } from './Tag';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('Card', () => {
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

  it('keeps the plain div contract and forwards native props and ref', () => {
    const ref = createRef<HTMLDivElement>();
    act(() => {
      root.render(
        <Card className="grid" ref={ref} role="alert">
          Failed
        </Card>,
      );
    });
    const card = container.firstElementChild as HTMLDivElement;
    expect(ref.current).toBe(card);
    expect(card.tagName).toBe('DIV');
    expect(card.className).toBe('rx-card grid');
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.textContent).toBe('Failed');
    expect(card.hasAttribute('data-padding')).toBe(false);
    expect(card.hasAttribute('data-interactive')).toBe(false);
  });

  it('exposes padding, radius, elevation and interactive state as data attributes', () => {
    act(() => {
      root.render(
        <Card elevated interactive padding="lg" radius="md">
          <Ribbon>Published</Ribbon>
          <CardOverlayLink href="/courses/1">Course title</CardOverlayLink>
          <button type="button">Copy code</button>
        </Card>,
      );
    });
    const card = container.firstElementChild as HTMLDivElement;
    expect(card.dataset.padding).toBe('lg');
    expect(card.dataset.radius).toBe('md');
    expect(card.dataset.elevated).toBe('true');
    expect(card.dataset.interactive).toBe('true');
    const link = card.querySelector('a')!;
    expect(link.className).toBe('rx-card-overlay-link');
    expect(link.getAttribute('href')).toBe('/courses/1');
    expect(card.querySelector('.rx-ribbon')?.getAttribute('data-tone')).toBe('published');
  });

  it('renders header title, description and actions with the primary section tone', () => {
    const onEdit = vi.fn();
    act(() => {
      root.render(
        <Card>
          <CardHeader
            actions={
              <button onClick={onEdit} type="button">
                Edit
              </button>
            }
            description="Basic information"
            headingLevel={2}
            title="Course info"
            tone="primary"
          />
          <CardBody>Body</CardBody>
          <CardFooter>Footer</CardFooter>
        </Card>,
      );
    });
    const header = container.querySelector('.rx-card-header')!;
    expect(header.getAttribute('data-tone')).toBe('primary');
    expect(header.querySelector('h2')?.textContent).toBe('Course info');
    expect(header.querySelector('.rx-card-description')?.textContent).toBe('Basic information');
    // 默认尺寸不写 data-size，旧用法保持原样。
    expect(header.hasAttribute('data-size')).toBe(false);
    act(() => header.querySelector('button')!.click());
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.rx-card-body')?.textContent).toBe('Body');
    expect(container.querySelector('.rx-card-footer')?.textContent).toBe('Footer');
  });

  it('marks the compact header size', () => {
    act(() => {
      root.render(
        <Card>
          <CardHeader size="sm" title="Task" />
        </Card>,
      );
    });
    expect(container.querySelector('.rx-card-header')?.getAttribute('data-size')).toBe('sm');
  });
});

describe('StatTile', () => {
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

  it('renders icon, formatted value, unit and caption', () => {
    act(() => {
      root.render(
        <StatTile
          category={3}
          formatValue={(value) => value.toLocaleString('en-US')}
          icon={<Users />}
          label="Students"
          unit="people"
          value={12345}
        />,
      );
    });
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.dataset.category).toBe('3');
    expect(tile.querySelector('.rx-stat-tile-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(tile.querySelector('.rx-stat-tile-value')?.textContent).toBe('12,345');
    expect(tile.querySelector('.rx-stat-tile-unit')?.textContent).toBe('people');
    expect(tile.querySelector('.rx-stat-tile-label')?.textContent).toBe('Students');
  });

  it('shows the final value immediately when count-up cannot observe the viewport', () => {
    act(() => root.render(<StatTile animate label="Minutes" value={42} />));
    const visible = container.querySelector('.rx-stat-tile-value')!;
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(visible.textContent).toBe('42');
    expect(container.querySelector('.rx-visually-hidden')?.textContent).toBe('42');

    act(() => root.render(<StatTile animate label="Minutes" value="—" />));
    expect(container.querySelector('.rx-stat-tile-value')?.textContent).toBe('—');
  });

  it('starts from 0 and counts up once the tile enters the viewport', () => {
    let notify: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    const disconnect = vi.fn();
    class FakeObserver {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        notify = callback;
      }
      disconnect = disconnect;
      observe() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    try {
      act(() => root.render(<StatTile animate label="Minutes" value={42} />));
      const visible = () => container.querySelector('.rx-stat-tile-value')!.textContent;
      expect(visible()).toBe('0');
      // 读屏始终读到最终值。
      expect(container.querySelector('.rx-visually-hidden')?.textContent).toBe('42');
      act(() => notify?.([{ isIntersecting: false }]));
      expect(visible()).toBe('0');
      // 测试环境没有动效时长 token，进入视口后直接落到目标值。
      act(() => notify?.([{ isIntersecting: true }]));
      expect(visible()).toBe('42');
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
