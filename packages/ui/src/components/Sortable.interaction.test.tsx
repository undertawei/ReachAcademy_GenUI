// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SortableHandle, SortableItem, SortableList, type SortableAnnouncements } from './Sortable';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const announcements: SortableAnnouncements = {
  cancelled: (label) => `cancelled ${label}`,
  dropped: (label, position, total) => `dropped ${label} ${position}/${total}`,
  moved: (label, position, total) => `moved ${label} ${position}/${total}`,
  pickedUp: (label, position, total) => `picked ${label} ${position}/${total}`,
};

describe('SortableList keyboard reordering', () => {
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

  function Harness({
    onReorder,
  }: {
    onReorder?: (from: number, to: number) => Promise<void> | void;
  }) {
    const [items, setItems] = useState(['Alpha', 'Beta', 'Gamma']);
    return (
      <SortableList
        announcements={announcements}
        getId={(item) => item}
        getLabel={(item) => item}
        handleLabel={(label) => `Reorder ${label}`}
        items={items}
        onReorder={async (from, to) => {
          await onReorder?.(from, to);
          setItems((current) => {
            const next = [...current];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved!);
            return next;
          });
        }}
      >
        {(list) =>
          list.map((item) => (
            <SortableItem id={item} key={item}>
              <span>{item}</span>
              <SortableHandle />
            </SortableItem>
          ))
        }
      </SortableList>
    );
  }

  const labels = () => [...container.querySelectorAll('li span')].map((node) => node.textContent);
  const handle = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Reorder ${label}"]`)!;
  const live = () => container.querySelector('[role="status"]')?.textContent;
  const press = (target: HTMLElement, key: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
    });

  it('picks up with Space, moves with arrows, drops with Space and announces each step', async () => {
    act(() => root.render(<Harness />));
    const alpha = handle('Alpha');
    act(() => alpha.focus());

    press(alpha, ' ');
    expect(live()).toBe('picked Alpha 1/3');
    expect(alpha.getAttribute('aria-pressed')).toBe('true');

    press(alpha, 'ArrowDown');
    expect(live()).toBe('moved Alpha 2/3');
    press(alpha, 'ArrowDown');
    expect(live()).toBe('moved Alpha 3/3');

    await act(async () => {
      alpha.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' }),
      );
    });
    expect(labels()).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(live()).toBe('dropped Alpha 3/3');
  });

  it('cancels with Escape without changing the order', () => {
    const onReorder = vi.fn();
    act(() => root.render(<Harness onReorder={onReorder} />));
    const beta = handle('Beta');
    act(() => beta.focus());
    press(beta, ' ');
    press(beta, 'ArrowUp');
    press(beta, 'Escape');

    expect(onReorder).not.toHaveBeenCalled();
    expect(labels()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(live()).toBe('cancelled Beta');
  });

  it('rolls back the optimistic order when saving fails', async () => {
    const failure = new Error('save failed');
    const onError = vi.fn();
    function Failing() {
      return (
        <SortableList
          announcements={announcements}
          getId={(item: string) => item}
          getLabel={(item) => item}
          handleLabel={(label) => `Reorder ${label}`}
          items={['Alpha', 'Beta']}
          onError={onError}
          onReorder={() => Promise.reject(failure)}
        >
          {(list) =>
            list.map((item) => (
              <SortableItem id={item} key={item}>
                <span>{item}</span>
                <SortableHandle />
              </SortableItem>
            ))
          }
        </SortableList>
      );
    }
    act(() => root.render(<Failing />));
    const alpha = handle('Alpha');
    act(() => alpha.focus());
    press(alpha, ' ');
    press(alpha, 'ArrowDown');
    await act(async () => {
      alpha.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(failure);
    expect(labels()).toEqual(['Alpha', 'Beta']);
  });

  it('only lets the handle start a drag and keeps other controls clickable', () => {
    const onClick = vi.fn();
    act(() =>
      root.render(
        <SortableList getId={(item: string) => item} items={['Alpha']} onReorder={vi.fn()}>
          {(list) =>
            list.map((item) => (
              <SortableItem id={item} key={item}>
                <button onClick={onClick} type="button">
                  Edit
                </button>
                <SortableHandle label="Move Alpha" />
              </SortableItem>
            ))
          }
        </SortableList>,
      ),
    );
    const edit = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === 'Edit',
    )!;
    act(() => edit.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(container.querySelector('li')?.getAttribute('data-state')).not.toBe('dragging');
  });
});
