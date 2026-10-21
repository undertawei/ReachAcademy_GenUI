// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { Popover } from './Popover';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('moves focus into positioned content and returns it after Escape on every opening', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <Popover label="Course info" trigger={<button>Open</button>}>
          <button>Save</button>
        </Popover>,
      ),
    );
    const trigger = host.querySelector('button')!;
    for (let cycle = 0; cycle < 2; cycle++) {
      act(() => trigger.click());
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(panel.style.visibility).not.toBe('hidden');
      expect(document.activeElement).toBe(panel.querySelector('button'));
      act(() =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      );
      expect(document.activeElement).toBe(trigger);
    }
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
