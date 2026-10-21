'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { KeyRound } from 'lucide-react';

/**
 * 自助修改密码弹窗，挂在 RoleHeader 头像弹窗的 profileActions 插槽里。
 *
 * 文案全部由调用方以 props 传入，组件本身不依赖任何一个应用的 i18n provider，
 * 因此教师端与学生端可以共用同一份实现（Admin 仍用它自己的 AdminPasswordDialog）。
 *
 * 提交由调用方的 onSubmit 完成：解析出的失败原因由调用方翻译好再回传 message，
 * 组件只负责把它显示出来；成功后组件不自行跳转，由调用方在 onSubmit 里决定去向
 * （改密后会话必须失效，通常是跳回 Portal 重新登录）。
 */
export interface PasswordDialogLabels {
  cancel: string;
  close: string;
  confirm: string;
  current: string;
  description: string;
  mismatch: string;
  new: string;
  submit: string;
  submitting: string;
  title: string;
  tooShort: string;
}

export interface PasswordDialogProps {
  labels: PasswordDialogLabels;
  minLength?: number;
  onSubmit(input: { currentPassword: string; newPassword: string }): Promise<string | null>;
}

export function PasswordDialog({ labels, minLength = 6, onSubmit }: PasswordDialogProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setError(null);
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;
      const form = event.currentTarget;
      const data = new FormData(form);
      const currentPassword = String(data.get('currentPassword') ?? '');
      const newPassword = String(data.get('newPassword') ?? '');
      const confirmPassword = String(data.get('confirmPassword') ?? '');
      if (newPassword.length < minLength) return setError(labels.tooShort);
      if (newPassword !== confirmPassword) return setError(labels.mismatch);

      setError(null);
      setPending(true);
      try {
        const failure = await onSubmit({ currentPassword, newPassword });
        // 成功时由 onSubmit 负责跳转；这里只在组件仍挂载时收尾，避免跳转途中 setState。
        if (!mountedRef.current) return;
        if (failure) setError(failure);
        else form.reset();
      } finally {
        if (mountedRef.current) setPending(false);
      }
    },
    [labels.mismatch, labels.tooShort, minLength, onSubmit, pending],
  );

  return (
    <>
      <button className="rx-password-dialog-trigger" onClick={() => setOpen(true)} type="button">
        <KeyRound aria-hidden="true" size={16} />
        {labels.title}
      </button>

      <div
        aria-label={labels.title}
        className="rx-password-dialog-backdrop"
        hidden={!open}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        role="presentation"
      >
        <section
          aria-labelledby="rx-password-dialog-title"
          aria-modal="true"
          className="rx-password-dialog"
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
          }}
          role="dialog"
        >
          <div className="rx-password-dialog-header">
            <div>
              <h2 id="rx-password-dialog-title">{labels.title}</h2>
              <p>{labels.description}</p>
            </div>
            <button
              aria-label={labels.close}
              className="rx-password-dialog-close"
              onClick={close}
              ref={closeRef}
              type="button"
            >
              ×
            </button>
          </div>

          {error ? (
            <p className="rx-password-dialog-error" role="alert">
              {error}
            </p>
          ) : null}

          <form className="rx-password-dialog-form" onSubmit={submit}>
            <label>
              {labels.current}
              <input
                autoComplete="current-password"
                name="currentPassword"
                required
                type="password"
              />
            </label>
            <label>
              {labels.new}
              <input
                autoComplete="new-password"
                minLength={minLength}
                name="newPassword"
                required
                type="password"
              />
            </label>
            <label>
              {labels.confirm}
              <input
                autoComplete="new-password"
                minLength={minLength}
                name="confirmPassword"
                required
                type="password"
              />
            </label>
            <div className="rx-password-dialog-actions">
              <button onClick={close} type="button">
                {labels.cancel}
              </button>
              <button disabled={pending} type="submit">
                {pending ? labels.submitting : labels.submit}
              </button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
