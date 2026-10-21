// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TutorPanel, useTutorPanel } from '@reachany/tutor-ui';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Harness({
  kind = 'history',
  onForceExit,
  onOutsideEscape,
}: {
  kind?: 'active' | 'history';
  onForceExit?: (key: string) => void;
  onOutsideEscape?: () => void;
}) {
  const controller = useTutorPanel({ onForceExit });
  const [draft, setDraft] = useState('Saved question');
  return (
    <div onKeyDown={(event) => event.key === 'Escape' && onOutsideEscape?.()}>
      <button onClick={() => controller.activateFence('fence-2')} type="button">
        Activate fence
      </button>
      <button
        onClick={() =>
          controller.setOverlay((current) => current && { ...current, kind: 'mastered' })
        }
        type="button"
      >
        Complete fence
      </button>
      <TutorPanel
        closeLabel="Close fence"
        controller={controller}
        renderFence={() => (
          <div aria-label="Fence answer" contentEditable suppressContentEditableWarning />
        )}
        title="Learning fence"
      >
        <input
          aria-label="Ordinary draft"
          onChange={(event) => setDraft(event.target.value)}
          value={draft}
        />
        <button
          onClick={(event) => controller.openFence('fence-1', kind, event.currentTarget)}
          type="button"
        >
          Open fence
        </button>
      </TutorPanel>
    </div>
  );
}

describe('shared TutorPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function button(label: string) {
    const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) =>
        candidate.textContent === label || candidate.getAttribute('aria-label') === label,
    );
    expect(result).toBeDefined();
    return result!;
  }

  function overlay() {
    const result = container.querySelector<HTMLElement>('[data-fence-overlay]');
    expect(result).not.toBeNull();
    return result!;
  }

  async function finishAnimation() {
    await act(async () => overlay().dispatchEvent(new Event('animationend', { bubbles: true })));
  }

  it('retains the ordinary discussion DOM and draft while hiding it from focus and accessibility', async () => {
    await act(async () => root.render(<Harness />));
    const input = container.querySelector<HTMLInputElement>('input')!;
    const ordinary = input.parentElement!;
    await act(async () => button('Open fence').click());

    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('Saved question');
    expect(ordinary.hasAttribute('inert')).toBe(true);
    expect(ordinary.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[aria-label="Fence answer"]')).toBeNull();

    await finishAnimation();
    expect(container.querySelector('[aria-label="Fence answer"]')).not.toBeNull();
    await act(async () => button('Close fence').click());
    await finishAnimation();

    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('Saved question');
    expect(ordinary.hasAttribute('inert')).toBe(false);
    expect(ordinary.hasAttribute('aria-hidden')).toBe(false);
  });

  it('animates from the history card, focuses its close control, and restores focus after exit', async () => {
    await act(async () => root.render(<Harness />));
    const trigger = button('Open fence');
    const panel = container.querySelector<HTMLElement>('[data-tutor-panel]')!;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 260, 160, 50));
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 400, 600));
    trigger.focus();
    const restoreFocus = vi.spyOn(trigger, 'focus').mockImplementation(() => {
      expect(trigger.closest('[inert]')).toBeNull();
      expect(container.querySelector('[data-fence-overlay]')).toBeNull();
      HTMLElement.prototype.focus.call(trigger);
    });
    await act(async () => trigger.click());

    expect(overlay().style.getPropertyValue('--fence-overlay-scale-x')).toBe('0.4');
    expect(Number(overlay().style.getPropertyValue('--fence-overlay-scale-y'))).toBeCloseTo(
      50 / 600,
    );
    expect(overlay().style.getPropertyValue('--fence-overlay-translate-x')).toBe('30px');
    expect(overlay().style.getPropertyValue('--fence-overlay-translate-y')).toBe('60px');
    await finishAnimation();
    expect(document.activeElement).toBe(button('Close fence'));

    await act(async () => button('Close fence').click());
    expect(overlay().dataset.fenceOverlayPhase).toBe('exiting');
    await finishAnimation();
    expect(container.querySelector('[data-fence-overlay]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it('opens and exits immediately for reduced motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    await act(async () => root.render(<Harness />));
    const trigger = button('Open fence');
    await act(async () => trigger.click());
    expect(overlay().dataset.fenceOverlayPhase).toBe('open');
    expect(document.activeElement).toBe(button('Close fence'));
    await act(async () => button('Close fence').click());
    expect(container.querySelector('[data-fence-overlay]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([false, true])(
    'returns focus to the panel after an automatic fence follows history (reduced motion: %s)',
    async (reducedMotion) => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: reducedMotion })),
      );
      await act(async () => root.render(<Harness />));
      const historyTrigger = button('Open fence');
      await act(async () => historyTrigger.click());
      if (!reducedMotion) await finishAnimation();
      await act(async () => button('Close fence').click());
      if (!reducedMotion) await finishAnimation();
      expect(document.activeElement).toBe(historyTrigger);

      await act(async () => button('Activate fence').click());
      if (!reducedMotion) await finishAnimation();
      expect(overlay().dataset.fenceOverlayKind).toBe('active');
      await act(async () => button('Complete fence').click());
      await act(async () => button('Close fence').click());
      if (!reducedMotion) await finishAnimation();

      expect(container.querySelector('[data-fence-overlay]')).toBeNull();
      expect(document.activeElement).toBe(container.querySelector('[data-tutor-panel]'));
    },
  );

  it('finishes entrance and exit when animation events are unavailable', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Harness />));
    const trigger = button('Open fence');
    await act(async () => trigger.click());
    await act(async () => vi.advanceTimersByTime(459));
    expect(overlay().dataset.fenceOverlayPhase).toBe('entering');
    await act(async () => vi.advanceTimersByTime(1));
    expect(overlay().dataset.fenceOverlayPhase).toBe('open');

    await act(async () => button('Close fence').click());
    await act(async () => vi.advanceTimersByTime(399));
    expect(overlay().dataset.fenceOverlayPhase).toBe('exiting');
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelector('[data-fence-overlay]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps an active learner fence non-dismissible and consumes Escape', async () => {
    const onOutsideEscape = vi.fn();
    await act(async () => root.render(<Harness kind="active" onOutsideEscape={onOutsideEscape} />));
    await act(async () => button('Open fence').click());
    await finishAnimation();
    expect(container.querySelector('[aria-label="Close fence"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Fence answer"]'));

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => overlay().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(onOutsideEscape).not.toHaveBeenCalled();
    expect(overlay().dataset.fenceOverlayPhase).toBe('open');
  });

  it.each([false, true])(
    'force-exits an active teacher fence only once before rerender (reduced motion: %s)',
    async (reducedMotion) => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: reducedMotion })),
      );
      const onForceExit = vi.fn();
      await act(async () => root.render(<Harness kind="active" onForceExit={onForceExit} />));
      await act(async () => button('Open fence').click());
      if (!reducedMotion) await finishAnimation();
      await act(async () => {
        button('Close fence').click();
        overlay().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(onForceExit).toHaveBeenCalledExactlyOnceWith('fence-1');
      if (!reducedMotion) {
        expect(overlay().dataset.fenceOverlayPhase).toBe('exiting');
        await finishAnimation();
      }
      expect(container.querySelector('[data-fence-overlay]')).toBeNull();
    },
  );
});
