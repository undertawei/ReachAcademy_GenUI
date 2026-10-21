// @vitest-environment jsdom

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VirtualTree,
  type VirtualTreeAnnouncements,
  type VirtualTreeHandle,
  type VirtualTreeHit,
  type VirtualTreeProps,
} from './VirtualTree';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Row {
  id: string;
  label: string;
  depth: number;
}
const makeRows = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index),
    label: `Module ${index}`,
    depth: index % 3,
  }));
const announcements: VirtualTreeAnnouncements<Row, string> = {
  cancelled: (row) => `cancel ${row.label}`,
  dropped: (row, target) => `drop ${row.label} ${target}`,
  moved: (row, target) => `move ${row.label} ${target}`,
  pickedUp: (row) => `pick ${row.label}`,
};
const resolve = (hit: VirtualTreeHit) =>
  hit.activeId === hit.overId ? null : `${hit.overId}:${hit.zone}`;

describe('VirtualTree', () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let time: number;
  const api = createRef<VirtualTreeHandle>();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    frames = new Map();
    nextFrame = 1;
    time = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(options: Partial<VirtualTreeProps<Row, string>> = {}) {
    act(() =>
      root.render(
        <VirtualTree
          announcements={announcements}
          apiRef={api}
          getDepth={(row) => row.depth}
          getId={(row) => row.id}
          getLabel={(row) => row.label}
          handleLabel={(label) => `Move ${label}`}
          instructions="Space to pick up; arrows to choose; Space to drop; Escape to cancel."
          onDrop={vi.fn()}
          renderRow={(row, context) => (
            <>
              <span>{row.label}</span>
              <button {...context.handleProps}>Drag</button>
            </>
          )}
          resolveDropTarget={resolve}
          rowHeight={40}
          rows={makeRows(5600)}
          {...options}
        />,
      ),
    );
    const scroller = api.current!.getScrollElement()!;
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
    scroller.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 200,
      right: 400,
      height: 200,
      width: 400,
      toJSON: () => ({}),
    });
    act(() => window.dispatchEvent(new Event('resize')));
    return scroller;
  }

  function pointer(target: EventTarget, type: string, y: number, pointerId = 1) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100,
      clientY: y,
    });
    Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } });
    act(() => target.dispatchEvent(event));
  }

  function tick(count = 1) {
    for (let index = 0; index < count; index++)
      act(() => {
        time += 16;
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(time);
      });
  }

  function press(target: EventTarget, key: string) {
    act(() =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    );
  }

  const handle = (id: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Move Module ${id}"]`)!;
  const mounted = () => container.querySelectorAll('[data-virtual-tree-id]');
  const live = () => container.querySelector('[role="status"]')!.textContent;

  it('bounds 5,600 rows by the viewport and retains only a bounded set of explicit pins', () => {
    render({ pinnedIds: Array.from({ length: 40 }, (_, index) => String(1000 + index)) });
    expect(mounted().length).toBe(18); // 5 visible + 5 overscan + capped 8 pins.
    expect(container.querySelector('[data-virtual-tree-id="1007"]')).not.toBeNull();
    expect(container.querySelector('[data-virtual-tree-id="1008"]')).toBeNull();
    act(() => {
      expect(api.current!.scrollToId('5599', 'start')).toBe(true);
    });
    expect(mounted().length).toBeLessThanOrEqual(23);
    expect(container.querySelector('[data-virtual-tree-id="5599"]')).not.toBeNull();
    expect(api.current!.getScrollAnchor()?.id).toBe('5595');
    expect(api.current!.scrollToId('not-visible')).toBe(false);
  });

  it('keeps a focused editor mounted and restores a logical anchor without requiring its DOM', () => {
    render({
      renderRow: (row, { handleProps }) => (
        <>
          <input aria-label={`Edit ${row.id}`} />
          <button {...handleProps} />
        </>
      ),
    });
    const editor = container.querySelector<HTMLInputElement>('input[aria-label="Edit 0"]')!;
    act(() => editor.focus());
    editor.value = 'unsaved';
    act(() => {
      api.current!.scrollToId('4000', 'start', 7);
    });
    expect(editor.isConnected).toBe(true);
    expect(editor.value).toBe('unsaved');
    expect(api.current!.getScrollAnchor()).toEqual({ id: '4000', offset: 7 });
    expect(mounted().length).toBeLessThanOrEqual(17);
  });

  it('continues edge scrolling with a stationary pointer, recomputes targets and drops after source unmount', () => {
    const onDrop = vi.fn();
    const onHoverChange = vi.fn();
    const scroller = render({ onDrop, onHoverChange });
    pointer(handle('0'), 'pointerdown', 20);
    pointer(window, 'pointermove', 195);
    expect(live()).toBe('move Module 0 4:after');
    tick(80);
    expect(scroller.scrollTop).toBeGreaterThan(700);
    expect(container.querySelector('[data-virtual-tree-id="0"]')).toBeNull();
    expect(document.querySelector('.rx-virtual-tree-preview')?.textContent).toBe('Module 0');
    expect(onHoverChange.mock.calls.length).toBeGreaterThan(15);
    const last = onHoverChange.mock.calls.at(-1)![0] as string;
    expect(Number(last)).toBeGreaterThan(20);
    pointer(window, 'pointerup', 195);
    expect(onDrop).toHaveBeenCalledOnce();
    expect(onDrop.mock.calls[0]![0]).toBe('0');
    expect(onDrop.mock.calls[0]![1]).toMatch(new RegExp(`^${last}:`));
    const stoppedAt = scroller.scrollTop;
    tick(5);
    expect(scroller.scrollTop).toBe(stoppedAt);
    expect(document.querySelector('.rx-virtual-tree-preview')).toBeNull();
  });

  it('hit-tests expanded rows at the stationary pointer and cancels cleanly on pointercancel', () => {
    const onDrop = vi.fn();
    const onDragEnd = vi.fn();
    const onHoverChange = vi.fn();
    const options = { rows: makeRows(10), onDrop, onDragEnd, onHoverChange };
    render(options);
    pointer(handle('0'), 'pointerdown', 20);
    pointer(window, 'pointermove', 100);
    expect(onHoverChange).toHaveBeenLastCalledWith('2');
    render({
      ...options,
      rows: [
        options.rows[0]!,
        { id: 'expanded', label: 'New section', depth: 1 },
        ...options.rows.slice(1),
      ],
    });
    tick();
    expect(onHoverChange).toHaveBeenLastCalledWith('1');
    pointer(window, 'pointercancel', 100);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onDragEnd).toHaveBeenLastCalledWith('0', null, 'cancel');
    expect(live()).toBe('cancel Module 0');
    expect(frames.size).toBe(0);
  });

  it('supports localized keyboard pickup, legal target traversal, drop and cancellation', () => {
    const onDrop = vi.fn();
    render({ onDrop });
    const source = handle('0');
    act(() => source.focus());
    press(source, ' ');
    expect(live()).toBe('pick Module 0');
    expect(source.getAttribute('aria-pressed')).toBe('true');
    expect(
      document.getElementById(source.getAttribute('aria-describedby')!)?.textContent,
    ).toContain('Escape');
    press(window, 'ArrowDown');
    expect(live()).toBe('move Module 0 1:before');
    press(window, 'ArrowRight');
    expect(live()).toBe('move Module 0 1:inside');
    press(window, 'Enter');
    expect(onDrop).toHaveBeenCalledWith('0', '1:inside');
    expect(live()).toBe('drop Module 0 1:inside');
    expect(document.activeElement).toBe(source);
    press(source, ' ');
    press(window, 'End');
    expect(container.querySelector('[data-virtual-tree-id="5599"]')).not.toBeNull();
    press(window, 'Escape');
    expect(live()).toBe('cancel Module 0');
    expect(document.activeElement).toBe(source);
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it('does not start from row content or disabled handles, and Escape stops a pointer drag', () => {
    const onDrop = vi.fn();
    render({ onDrop });
    pointer(container.querySelector('span')!, 'pointerdown', 20);
    pointer(window, 'pointermove', 100);
    expect(document.querySelector('.rx-virtual-tree-preview')).toBeNull();
    pointer(handle('0'), 'pointerdown', 20);
    pointer(window, 'pointermove', 100);
    press(window, 'Escape');
    expect(onDrop).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    render({ disabled: true, onDrop });
    expect(handle('0').disabled).toBe(true);
    press(handle('0'), ' ');
    expect(handle('0').getAttribute('aria-pressed')).toBe('false');
  });

  it.each(['Enter', ' '])(
    'finishes exactly once when %j is dispatched from the focused handle',
    (key) => {
      const onDrop = vi.fn();
      const onDragStart = vi.fn();
      const onDragEnd = vi.fn();
      render({ onDrop, onDragStart, onDragEnd });
      const source = handle('0');
      act(() => source.focus());
      press(source, ' ');
      press(source, 'ArrowDown');
      press(source, key);
      expect(onDragStart).toHaveBeenCalledTimes(1);
      expect(onDrop).toHaveBeenCalledExactlyOnceWith('0', '1:before');
      expect(onDragEnd).toHaveBeenCalledExactlyOnceWith('0', '1:before', 'drop');
      expect(source.getAttribute('aria-pressed')).toBe('false');
      expect(live()).toBe('drop Module 0 1:before');
      press(source, 'ArrowDown');
      press(source, 'Escape');
      expect(onDragStart).toHaveBeenCalledTimes(1);
      expect(onDragEnd).toHaveBeenCalledTimes(1);
      expect(live()).toBe('drop Module 0 1:before');
    },
  );
});
