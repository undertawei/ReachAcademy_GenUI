// @vitest-environment jsdom

import { act, forwardRef, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SideNav } from './SideNav';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type RouterLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean };

const RouterLink = forwardRef<HTMLAnchorElement, RouterLinkProps>(function RouterLink(
  { prefetch, ...props },
  ref,
) {
  return <a data-prefetch={String(prefetch)} data-router="" ref={ref} {...props} />;
});

describe('SideNav interactions', () => {
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

  it('renders a labelled nav of links with the current page marked', () => {
    act(() => {
      root.render(
        <SideNav
          aria-label="Settings"
          items={[
            { href: '/settings/profile', label: 'Profile', current: true, count: 2 },
            { href: '/settings/security', label: 'Security', icon: <svg data-icon="lock" /> },
          ]}
        />,
      );
    });
    const nav = container.querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBe('Settings');
    expect(nav.getAttribute('data-inset')).toBe('card');
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/settings/profile',
      '/settings/security',
    ]);
    expect(links[0].getAttribute('aria-current')).toBe('page');
    expect(links[0].getAttribute('data-state')).toBe('selected');
    expect(links[1].hasAttribute('aria-current')).toBe(false);
    expect(links[0].querySelector('.rx-side-nav-count')!.textContent).toBe('2');
    expect(links[1].querySelector('.rx-side-nav-icon [data-icon="lock"]')).not.toBeNull();
  });

  it('labels grouped lists by their titles and supports the page inset', () => {
    act(() => {
      root.render(
        <SideNav
          aria-label="Library"
          groups={[
            { id: 'mine', title: 'Mine', items: [{ href: '/a', label: 'Drafts' }] },
            { id: 'untitled', items: [{ href: '/b', label: 'Shared' }] },
          ]}
          inset="page"
        />,
      );
    });
    const lists = Array.from(container.querySelectorAll('ul'));
    expect(lists).toHaveLength(2);
    expect(document.getElementById(lists[0].getAttribute('aria-labelledby')!)!.textContent).toBe(
      'Mine',
    );
    expect(lists[1].hasAttribute('aria-labelledby')).toBe(false);
    expect(container.querySelector('nav')!.getAttribute('data-inset')).toBe('page');
  });

  it('renders through a custom link component such as Next.js Link', () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    act(() => {
      root.render(
        <SideNav
          aria-label="Course"
          items={[
            {
              current: true,
              href: '/course/1',
              label: 'Overview',
              linkProps: { onClick, prefetch: false },
            },
          ]}
          linkComponent={RouterLink}
        />,
      );
    });
    const link = container.querySelector<HTMLAnchorElement>('a[data-router]')!;
    expect(link.getAttribute('href')).toBe('/course/1');
    expect(link.getAttribute('data-prefetch')).toBe('false');
    expect(link.className).toBe('rx-side-nav-item');
    expect(link.getAttribute('aria-current')).toBe('page');
    act(() => link.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders an empty nav without items', () => {
    act(() => {
      root.render(<SideNav aria-label="Empty" />);
    });
    expect(container.querySelector('nav')!.children).toHaveLength(0);
  });
});
