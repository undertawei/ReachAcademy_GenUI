// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PasswordDialog, type PasswordDialogLabels } from './PasswordDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const labels: PasswordDialogLabels = {
  cancel: '取消',
  close: '关闭',
  confirm: '确认新密码',
  current: '当前密码',
  description: '修改后需要重新登录',
  mismatch: '两次输入的新密码不一致。',
  new: '新密码',
  submit: '修改密码并退出登录',
  submitting: '提交中…',
  title: '修改密码',
  tooShort: '新密码至少 6 位。',
};

describe('PasswordDialog', () => {
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

  function render(
    onSubmit: (input: { currentPassword: string; newPassword: string }) => Promise<string | null>,
  ) {
    act(() => {
      root.render(<PasswordDialog labels={labels} onSubmit={onSubmit} />);
    });
  }

  function fill(current: string, next: string, confirm: string) {
    const form = container.querySelector('form') as HTMLFormElement;
    const set = (name: string, value: string) => {
      const input = form.querySelector(`input[name="${name}"]`) as HTMLInputElement;
      input.value = value;
    };
    set('currentPassword', current);
    set('newPassword', next);
    set('confirmPassword', confirm);
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    return form;
  }

  it('keeps the dialog closed until the trigger is used', () => {
    render(async () => null);
    const backdrop = container.querySelector('.rx-password-dialog-backdrop') as HTMLElement;
    expect(backdrop.hidden).toBe(true);

    act(() => {
      (container.querySelector('.rx-password-dialog-trigger') as HTMLButtonElement).click();
    });
    expect(backdrop.hidden).toBe(false);
  });

  it('blocks submission when the two new passwords differ', async () => {
    const onSubmit = vi.fn(async () => null);
    render(onSubmit);
    act(() => {
      (container.querySelector('.rx-password-dialog-trigger') as HTMLButtonElement).click();
    });

    fill('old-secret', 'new-secret', 'typo-secret');
    await act(async () => undefined);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('.rx-password-dialog-error')?.textContent).toBe(labels.mismatch);
  });

  it('shows the failure the caller returns and keeps the form open', async () => {
    const onSubmit = vi.fn(async () => '当前密码不正确。');
    render(onSubmit);
    act(() => {
      (container.querySelector('.rx-password-dialog-trigger') as HTMLButtonElement).click();
    });

    fill('wrong', 'new-secret', 'new-secret');
    await act(async () => undefined);

    expect(onSubmit).toHaveBeenCalledWith({
      currentPassword: 'wrong',
      newPassword: 'new-secret',
    });
    expect(container.querySelector('.rx-password-dialog-error')?.textContent).toBe(
      '当前密码不正确。',
    );
    expect(container.querySelector('form')).not.toBeNull();
  });
});
