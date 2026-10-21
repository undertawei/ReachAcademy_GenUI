'use client';

import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { usePresence } from '../primitives/usePresence';

export type ToastVariant = 'error' | 'info' | 'success' | 'warning';

/** 规范 03 §3.20：默认 5000ms（issue #586），带「撤销」等操作的 8000ms。 */
export const DEFAULT_TOAST_DURATION = 5000;
export const DEFAULT_ACTION_TOAST_DURATION = 8000;
/** 同时最多显示 3 条，超出时最旧的提前关闭。 */
const MAX_VISIBLE_TOASTS = 3;

export interface ToastAction {
  label: ReactNode;
  onClick: () => void;
}

export type ToastInput = {
  /** 可选的一个操作链接（如「撤销」）；点击后关闭该条。 */
  action?: ToastAction;
  description?: ReactNode;
  dismissible?: boolean;
  duration?: number;
  persistent?: boolean;
  title: ReactNode;
  variant?: ToastVariant;
};

export type ToastItem = ToastInput & { id: string };

type ToastRecord = ToastItem & { closing: boolean };

type ToastContextValue = {
  clearToasts: () => void;
  dismissToast: (id: string) => void;
  pushToast: (toast: ToastInput) => string;
};

export type ToastProviderProps = {
  children: ReactNode;
  /** Application defaults; individual toast options take precedence. */
  defaults?: {
    dismissible?: boolean;
    durationByVariant?: Partial<Record<ToastVariant, number>>;
  };
  dismissLabel: string;
  /** 默认右上角（Header 下方 16px、右侧 24px）。 */
  placement?: 'bottom-right' | 'top-right';
  regionLabel: string;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({
  children,
  defaults,
  dismissLabel,
  placement = 'top-right',
  regionLabel,
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const sequence = useRef(0);
  const dismissToast = useCallback((id: string) => {
    setToasts((current) =>
      current.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast)),
    );
  }, []);
  const removeToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const clearToasts = useCallback(
    () => setToasts((current) => current.map((toast) => ({ ...toast, closing: true }))),
    [],
  );
  const pushToast = useCallback(
    (toast: ToastInput) => {
      const id = `rx-toast-${++sequence.current}`;
      setToasts((current) => {
        const next = [
          ...current,
          {
            dismissible: defaults?.dismissible,
            duration: defaults?.durationByVariant?.[toast.variant ?? 'info'],
            ...toast,
            closing: false,
            id,
          },
        ];
        const open = next.filter((item) => !item.closing);
        const overflow = open.length - MAX_VISIBLE_TOASTS;
        if (overflow <= 0) return next;
        const expired = new Set(open.slice(0, overflow).map((item) => item.id));
        return next.map((item) => (expired.has(item.id) ? { ...item, closing: true } : item));
      });
      return id;
    },
    [defaults],
  );
  const context = useMemo(
    () => ({ clearToasts, dismissToast, pushToast }),
    [clearToasts, dismissToast, pushToast],
  );

  return (
    <ToastContext.Provider value={context}>
      {children}
      <div
        aria-label={regionLabel}
        aria-live="polite"
        className="rx-toast-region"
        data-placement={placement}
        role="region"
      >
        {toasts.map((toast) => (
          <ToastMessage
            dismissLabel={dismissLabel}
            key={toast.id}
            onDismiss={dismissToast}
            onExited={removeToast}
            toast={toast}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast must be used within ToastProvider');
  return context;
}

const VARIANT_ICONS = {
  error: CircleX,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
} as const;

function ToastMessage({
  dismissLabel,
  onDismiss,
  onExited,
  toast,
}: {
  dismissLabel: string;
  onDismiss: (id: string) => void;
  onExited: (id: string) => void;
  toast: ToastRecord;
}) {
  const {
    action,
    closing,
    description,
    dismissible,
    id,
    persistent,
    title,
    variant = 'info',
  } = toast;
  const duration =
    toast.duration ??
    (action === undefined ? DEFAULT_TOAST_DURATION : DEFAULT_ACTION_TOAST_DURATION);
  const isPersistent = persistent === true || duration <= 0;
  const isDismissible = dismissible ?? isPersistent;
  const presence = usePresence<HTMLDivElement>(!closing);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration);
  const startedAt = useRef(0);

  useLayoutEffect(() => {
    if (!presence.mounted) onExited(id);
  }, [id, onExited, presence.mounted]);

  useEffect(() => {
    if (isPersistent || closing || paused) return;
    startedAt.current = Date.now();
    const timeout = window.setTimeout(() => onDismiss(id), remaining.current);
    return () => {
      window.clearTimeout(timeout);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [closing, id, isPersistent, onDismiss, paused]);

  if (!presence.mounted) return null;
  const Icon = VARIANT_ICONS[variant];

  return (
    <div
      aria-atomic="true"
      className={cn('rx-toast', `rx-toast-${variant}`)}
      data-state={presence.state}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
      onFocus={() => setPaused(true)}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      ref={presence.ref}
      role={variant === 'error' ? 'alert' : 'status'}
      style={
        isPersistent ? undefined : ({ '--rx-toast-duration': `${duration}ms` } as CSSProperties)
      }
    >
      <Icon aria-hidden="true" className="rx-toast-icon" />
      <div className="rx-toast-content">
        <strong className="rx-toast-title">{title}</strong>
        {description === undefined ? null : (
          <div className="rx-toast-description">{description}</div>
        )}
        {action === undefined ? null : (
          <button
            className="rx-toast-action"
            onClick={() => {
              action.onClick();
              onDismiss(id);
            }}
            type="button"
          >
            {action.label}
          </button>
        )}
      </div>
      {isDismissible ? (
        <button
          aria-label={dismissLabel}
          className="rx-toast-dismiss"
          onClick={() => onDismiss(id)}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
      {isPersistent ? null : (
        <span
          aria-hidden="true"
          className="rx-toast-countdown"
          data-paused={paused ? 'true' : undefined}
        />
      )}
    </div>
  );
}
