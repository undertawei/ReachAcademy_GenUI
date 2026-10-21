// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installPressHoldPreview } from '../src/pressHoldPreview';

function pointerEvent(type: string, pointerId = 1, pointerType = 'mouse'): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  return event;
}

describe('installPressHoldPreview', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts and restores on mouse hold without emitting a click', () => {
    const element = document.createElement('button');
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const cleanup = installPressHoldPreview({
      element,
      canPreview: () => true,
      onPreviewStart: onStart,
      onPreviewEnd: onEnd,
    });
    const click = vi.fn();
    element.addEventListener('click', click);

    element.dispatchEvent(pointerEvent('pointerdown'));
    expect(onStart).toHaveBeenCalledOnce();
    expect(element.dataset.previewActive).toBe('true');
    element.dispatchEvent(pointerEvent('pointerup'));
    expect(onEnd).toHaveBeenCalledOnce();
    expect(element.dataset.previewActive).toBeUndefined();
    expect(click).not.toHaveBeenCalled();

    cleanup();
  });

  it('supports keyboard preview, ignores repeat, and cancels on window blur', () => {
    const element = document.createElement('button');
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const cleanup = installPressHoldPreview({
      element,
      canPreview: () => true,
      onPreviewStart: onStart,
      onPreviewEnd: onEnd,
    });

    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
    expect(onStart).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('blur'));
    expect(onEnd).toHaveBeenCalledOnce();
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
    expect(onEnd).toHaveBeenCalledOnce();

    cleanup();
  });

  it('restores on touch cancellation and cleanup', () => {
    const element = document.createElement('button');
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const cleanup = installPressHoldPreview({
      element,
      canPreview: () => true,
      onPreviewStart: onStart,
      onPreviewEnd: onEnd,
    });
    Object.defineProperty(element, 'setPointerCapture', { value: vi.fn() });

    element.dispatchEvent(pointerEvent('pointerdown', 7, 'touch'));
    element.dispatchEvent(pointerEvent('pointercancel', 7, 'touch'));
    expect(onStart).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();

    element.dispatchEvent(pointerEvent('pointerdown', 8, 'pen'));
    cleanup();
    expect(onEnd).toHaveBeenCalledTimes(2);
  });
});
