// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DropdownMenu, type DropdownMenuEntry } from './DropdownMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function pressKey(target: Element | null, key: string) {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
  });
}

function menu() {
  return document.querySelector<HTMLElement>('[role="menu"]');
}

function menuItems() {
  return [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
}

function focusedText() {
  return document.activeElement?.textContent;
}

describe('DropdownMenu interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onEdit = vi.fn();
  const onDuplicate = vi.fn();
  const onDelete = vi.fn();
  const onArchive = vi.fn();

  const items: DropdownMenuEntry[] = [
    { key: 'delete', label: 'Delete', danger: true, onSelect: onDelete, icon: <svg /> },
    { key: 'edit', label: 'Edit', onSelect: onEdit, icon: <svg /> },
    { key: 'disabled', label: 'Export', disabled: true },
    { type: 'separator' },
    { key: 'duplicate', label: 'Duplicate', onSelect: onDuplicate },
    { key: 'archive', label: 'Archive', onSelect: onArchive },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderMenu(extra: Partial<Parameters<typeof DropdownMenu>[0]> = {}) {
    act(() => {
      root.render(<DropdownMenu items={items} label="More actions" {...extra} />);
    });
    return container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  }

  it('renders a labelled ghost icon trigger and orders danger items last behind a separator', () => {
    const trigger = renderMenu();
    expect(trigger.getAttribute('aria-label')).toBe('More actions');
    expect(trigger.getAttribute('data-variant')).toBe('ghost');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.querySelector('svg')).not.toBeNull();

    act(() => trigger.focus());
    pressKey(trigger, 'ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(menu()?.id);
    expect(menu()?.getAttribute('aria-label')).toBe('More actions');
    expect(menu()?.classList.contains('rx-floating-panel')).toBe(true);
    expect(menu()?.style.zIndex).toBe('var(--reachany-z-dropdown)');

    const children = [...menu()!.children].map((child) =>
      child.getAttribute('role') === 'separator' ? '---' : child.textContent,
    );
    expect(children).toEqual(['Edit', 'Export', '---', 'Duplicate', 'Archive', '---', 'Delete']);
    expect(menuItems().at(-1)?.hasAttribute('data-danger')).toBe(true);
    expect(menuItems()[1]?.getAttribute('aria-disabled')).toBe('true');
  });

  it('supports APG keyboard navigation, skipping disabled items and wrapping', () => {
    const trigger = renderMenu();
    act(() => trigger.focus());
    pressKey(trigger, 'ArrowDown');
    expect(focusedText()).toBe('Edit');

    pressKey(document.activeElement, 'ArrowDown');
    expect(focusedText()).toBe('Duplicate');
    pressKey(document.activeElement, 'End');
    expect(focusedText()).toBe('Delete');
    pressKey(document.activeElement, 'ArrowDown');
    expect(focusedText()).toBe('Edit');
    pressKey(document.activeElement, 'ArrowUp');
    expect(focusedText()).toBe('Delete');
    pressKey(document.activeElement, 'Home');
    expect(focusedText()).toBe('Edit');

    // 首字母跳转：d → Duplicate → Delete → Duplicate。
    pressKey(document.activeElement, 'd');
    expect(focusedText()).toBe('Duplicate');
    pressKey(document.activeElement, 'D');
    expect(focusedText()).toBe('Delete');
    pressKey(document.activeElement, 'd');
    expect(focusedText()).toBe('Duplicate');
    // 禁用项不参与首字母跳转。
    pressKey(document.activeElement, 'e');
    expect(focusedText()).toBe('Edit');
    pressKey(document.activeElement, 'z');
    expect(focusedText()).toBe('Edit');
  });

  it('opens on ArrowUp focusing the last item', () => {
    const trigger = renderMenu();
    act(() => trigger.focus());
    pressKey(trigger, 'ArrowUp');
    expect(focusedText()).toBe('Delete');
  });

  it('selects with Enter or Space, closes and returns focus to the trigger', () => {
    const trigger = renderMenu();
    act(() => trigger.focus());
    pressKey(trigger, 'ArrowDown');
    pressKey(document.activeElement, 'Enter');
    expect(onEdit).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    pressKey(trigger, 'ArrowUp');
    pressKey(document.activeElement, ' ');
    expect(onDelete).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape and Tab with focus back on the trigger', () => {
    const trigger = renderMenu();
    act(() => trigger.focus());
    pressKey(trigger, 'ArrowDown');
    pressKey(document.activeElement, 'Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    pressKey(trigger, 'ArrowDown');
    pressKey(document.activeElement, 'Tab');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens by keyboard click on the first item and by mouse click on the menu itself', () => {
    const trigger = renderMenu();
    act(() => trigger.focus());
    act(() => trigger.click()); // detail 0：键盘触发的 click。
    expect(focusedText()).toBe('Edit');
    act(() => trigger.click());
    expect(menu()).toBeNull();

    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(document.activeElement).toBe(menu());
    pressKey(menu(), 'ArrowDown');
    expect(focusedText()).toBe('Edit');
  });

  it('ignores clicks on disabled items and selects enabled ones with the pointer', () => {
    const trigger = renderMenu();
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    const disabled = menuItems().find((item) => item.textContent === 'Export')!;
    act(() => disabled.click());
    expect(menu()).not.toBeNull();

    const archive = menuItems().find((item) => item.textContent === 'Archive')!;
    act(() => {
      archive.dispatchEvent(new Event('pointermove', { bubbles: true }));
    });
    act(() => archive.click());
    expect(onArchive).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it('closes on an outside pointerdown without stealing focus', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    const trigger = renderMenu();
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(menu()).not.toBeNull();
    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
    outside.remove();
  });

  it('supports a custom trigger, controlled open state, group labels and long labels', () => {
    const onOpenChange = vi.fn();
    const longLabel = 'Move to another very long chapter name '.repeat(6).trim();
    act(() => {
      root.render(
        <DropdownMenu
          items={[
            { key: 'group', label: 'Chapter', type: 'label' },
            { key: 'move', label: longLabel, textValue: 'Move' },
          ]}
          label="Chapter actions"
          onOpenChange={onOpenChange}
          open
          trigger={<button type="button">Actions</button>}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    expect(trigger.textContent).toBe('Actions');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(menu()?.querySelector('.rx-dropdown-menu-group-label')?.textContent).toBe('Chapter');
    expect(menuItems()[0]?.textContent).toBe(longLabel);

    pressKey(menu(), 'm');
    expect(focusedText()).toBe(longLabel);

    act(() => trigger.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(menu()).not.toBeNull();
  });

  it('renders an empty menu without crashing and keeps focus on the panel', () => {
    act(() => {
      root.render(<DropdownMenu items={[{ type: 'separator' }]} label="Empty" />);
    });
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    act(() => trigger.focus());
    pressKey(trigger, 'ArrowDown');
    expect(menuItems()).toHaveLength(0);
    expect(menu()?.children).toHaveLength(0);
    expect(document.activeElement).toBe(menu());
    pressKey(menu(), 'ArrowDown');
    pressKey(menu(), 'Enter');
    expect(menu()).not.toBeNull();
  });

  it('does not open while the default trigger is disabled', () => {
    const trigger = renderMenu({ disabled: true });
    expect(trigger.disabled).toBe(true);
    act(() => trigger.click());
    expect(menu()).toBeNull();
  });
});
