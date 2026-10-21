// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RoleHeader } from './RoleHeader';
import {
  ROLE_HEADER_COLLAPSED_ATTRIBUTE,
  ROLE_HEADER_COLLAPSE_STORAGE_KEY,
} from './RoleHeaderPersistence';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('RoleHeader responsive navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.documentElement.removeAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE);
    window.sessionStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.documentElement.removeAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE);
    window.sessionStorage.clear();
  });

  function renderHeader(navLabel: string, collapsible = false) {
    act(() => {
      root.render(
        <div>
          <RoleHeader
            avatarLabel="Account"
            avatarText="A"
            brandHref="/home"
            collapsible={
              collapsible
                ? { collapseLabel: 'Collapse header', restoreLabel: 'Show header' }
                : undefined
            }
            headerActions={<button type="button">Language</button>}
            keepProfileMounted
            navItems={[
              { current: true, href: '/courses', label: 'Courses' },
              { current: false, href: '/calendar', label: 'Calendar' },
            ]}
            navLabel={navLabel}
            signOutLabel="Sign out"
          />
          <main>Page content</main>
        </div>,
      );
    });
  }

  it('opens one localized navigation panel and closes it after outside interaction', () => {
    renderHeader('学生端导航');

    const trigger = container.querySelector<HTMLButtonElement>(
      '.rx-role-header-menu-trigger[aria-label="学生端导航"]',
    );
    const panel = container.querySelector<HTMLElement>('.rx-role-header-menu-panel');

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(panel?.dataset.open).toBe('false');
    expect(panel?.querySelectorAll('a')).toHaveLength(2);
    expect(panel?.textContent).not.toContain('Language');
    expect(container.querySelector('.rx-role-header-actions')?.textContent).toContain('Language');

    act(() => trigger?.click());

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.dataset.open).toBe('true');

    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(panel?.dataset.open).toBe('false');
  });

  it('closes with Escape and restores focus to the menu trigger', () => {
    renderHeader('Teacher navigation');

    const trigger = container.querySelector<HTMLButtonElement>('.rx-role-header-menu-trigger');
    act(() => trigger?.click());
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('collapses, closes mounted overlays, persists state, and restores focus in both directions', () => {
    renderHeader('Teacher navigation', true);

    const avatar = container.querySelector<HTMLButtonElement>('.rx-role-header-avatar');
    const collapse = container.querySelector<HTMLButtonElement>('.rx-role-header-collapse');
    const restore = container.querySelector<HTMLButtonElement>('.rx-role-header-restore');
    const profile = container.querySelector<HTMLElement>('.rx-role-header-popover');

    act(() => avatar?.click());
    expect(profile?.hidden).toBe(false);

    act(() => collapse?.click());

    expect(document.documentElement.getAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE)).toBe('true');
    expect(window.sessionStorage.getItem(ROLE_HEADER_COLLAPSE_STORAGE_KEY)).toBe('true');
    expect(container.querySelector('header')?.getAttribute('aria-hidden')).toBe('true');
    expect(profile?.hidden).toBe(true);
    expect(restore?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(restore);

    act(() => restore?.click());

    expect(document.documentElement.hasAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE)).toBe(false);
    expect(window.sessionStorage.getItem(ROLE_HEADER_COLLAPSE_STORAGE_KEY)).toBeNull();
    expect(container.querySelector('header')?.hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(collapse);

    const menuTrigger = container.querySelector<HTMLButtonElement>('.rx-role-header-menu-trigger');
    const menuPanel = container.querySelector<HTMLElement>('.rx-role-header-menu-panel');
    act(() => menuTrigger?.click());
    expect(menuPanel?.dataset.open).toBe('true');
    act(() => collapse?.click());
    expect(menuPanel?.dataset.open).toBe('false');
  });

  it('dismisses the focused restore control with Escape without expanding the header', () => {
    renderHeader('Teacher navigation', true);

    const collapse = container.querySelector<HTMLButtonElement>('.rx-role-header-collapse');
    const restore = container.querySelector<HTMLButtonElement>('.rx-role-header-restore');
    const main = container.querySelector<HTMLElement>('main');
    act(() => collapse?.click());
    act(() =>
      restore?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
    );

    expect(document.documentElement.getAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE)).toBe('true');
    expect(document.activeElement).toBe(main);
    expect(restore?.tabIndex).toBe(0);
  });

  it('adopts the pre-hydrated collapsed state without changing storage', () => {
    document.documentElement.setAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE, 'true');
    window.sessionStorage.setItem(ROLE_HEADER_COLLAPSE_STORAGE_KEY, 'true');

    renderHeader('Student navigation', true);

    expect(container.querySelector('header')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('.rx-role-header-restore')?.tabIndex).toBe(0);
    expect(window.sessionStorage.getItem(ROLE_HEADER_COLLAPSE_STORAGE_KEY)).toBe('true');
  });
});
