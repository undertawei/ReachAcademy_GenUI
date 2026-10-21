// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingGrid, SettingRow, Switch } from './Switch';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('Switch interactions', () => {
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

  const switchEl = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!;

  it('toggles uncontrolled state and exposes aria-checked', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(<Switch aria-label="Auto grade" onCheckedChange={onCheckedChange} />);
    });
    expect(switchEl().getAttribute('aria-checked')).toBe('false');
    expect(switchEl().hasAttribute('data-size')).toBe(false);
    act(() => switchEl().click());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(switchEl().getAttribute('data-state')).toBe('checked');
  });

  it('stays controlled until the parent updates', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(
        <Switch aria-label="Auto grade" checked onCheckedChange={onCheckedChange} size="sm" />,
      );
    });
    act(() => switchEl().click());
    expect(onCheckedChange).toHaveBeenCalledWith(false);
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(switchEl().getAttribute('data-size')).toBe('sm');
  });

  it('flips optimistically while an async change is pending and keeps it on success', async () => {
    const request = deferred();
    const onCheckedChange = vi.fn(() => request.promise);
    act(() => {
      root.render(<Switch aria-label="Publish" onCheckedChange={onCheckedChange} />);
    });
    act(() => switchEl().click());
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(switchEl().getAttribute('aria-busy')).toBe('true');
    expect(switchEl().querySelector('.rx-spinner')).not.toBeNull();

    // 请求期间再次点击被忽略。
    act(() => switchEl().click());
    expect(onCheckedChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve();
      await request.promise;
    });
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    expect(switchEl().hasAttribute('aria-busy')).toBe(false);
    expect(switchEl().querySelector('.rx-spinner')).toBeNull();
  });

  it('reverts and reports the error when the async change fails', async () => {
    const request = deferred();
    const onError = vi.fn();
    act(() => {
      root.render(
        <Switch aria-label="Publish" onCheckedChange={() => request.promise} onError={onError} />,
      );
    });
    act(() => switchEl().click());
    expect(switchEl().getAttribute('aria-checked')).toBe('true');
    const failure = new Error('network');
    await act(async () => {
      request.reject(failure);
      await request.promise.catch(() => undefined);
    });
    expect(switchEl().getAttribute('aria-checked')).toBe('false');
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('blocks toggling while loading, disabled or read-only', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(
        <>
          <Switch aria-label="Loading" loading onCheckedChange={onCheckedChange} />
          <Switch aria-label="Disabled" disabled onCheckedChange={onCheckedChange} />
          <Switch aria-label="Read only" onCheckedChange={onCheckedChange} readOnly />
        </>,
      );
    });
    const [loading, disabled, readOnly] = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="switch"]'),
    );
    act(() => {
      loading.click();
      disabled.click();
      readOnly.click();
    });
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(loading.getAttribute('aria-disabled')).toBe('true');
    expect(loading.disabled).toBe(false);
    expect(disabled.disabled).toBe(true);
    expect(readOnly.getAttribute('aria-readonly')).toBe('true');
  });

  it('submits its value with a form only when on', () => {
    act(() => {
      root.render(
        <form>
          <Switch aria-label="Notify" defaultChecked name="notify" value="yes" />
        </form>,
      );
    });
    const form = container.querySelector('form')!;
    expect(new FormData(form).get('notify')).toBe('yes');
    act(() => switchEl().click());
    expect(new FormData(form).get('notify')).toBeNull();
  });

  it('routes synchronous handler errors to onError without flipping', () => {
    const onError = vi.fn();
    act(() => {
      root.render(
        <Switch
          aria-label="Broken"
          onCheckedChange={() => {
            throw new Error('boom');
          }}
          onError={onError}
        />,
      );
    });
    act(() => switchEl().click());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(switchEl().getAttribute('aria-checked')).toBe('false');
  });
});

describe('SettingRow interactions', () => {
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

  it('labels the switch with the title and disables attached inputs while off', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(
        <SettingGrid>
          <SettingRow
            description="Students must pass first"
            onCheckedChange={onCheckedChange}
            title="Require passing score"
          >
            <input aria-label="Passing score" defaultValue="60" />
          </SettingRow>
        </SettingGrid>,
      );
    });
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Passing score"]')!;
    const fieldset = container.querySelector('fieldset')!;
    expect(document.getElementById(toggle.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Require passing score',
    );
    expect(document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Students must pass first',
    );
    expect(fieldset.disabled).toBe(true);
    expect(field.matches(':disabled')).toBe(true);

    act(() => toggle.click());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(fieldset.disabled).toBe(false);
    expect(container.querySelector('.rx-setting-row')!.getAttribute('data-state')).toBe('checked');
    expect(container.querySelector('.rx-setting-grid')).not.toBeNull();
  });

  it('enables attachments only after an async change succeeds', async () => {
    const request = deferred();
    act(() => {
      root.render(
        <SettingRow onCheckedChange={() => request.promise} title="Time limit">
          <input aria-label="Minutes" />
        </SettingRow>,
      );
    });
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('fieldset')!.disabled).toBe(true);
    await act(async () => {
      request.resolve();
      await request.promise;
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('fieldset')!.disabled).toBe(false);
  });

  it('renders without description or attachments', () => {
    act(() => {
      root.render(<SettingRow defaultChecked disabled title="Needs review" />);
    });
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.hasAttribute('aria-describedby')).toBe(false);
    expect(toggle.disabled).toBe(true);
    expect(container.querySelector('fieldset')).toBeNull();
  });
});
