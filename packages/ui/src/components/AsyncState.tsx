'use client';

import { useRef, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';
import { Empty, type EmptyVariant } from './Empty';
import { useDelayedVisibility } from './Skeleton';
import { Spinner } from './Spinner';

export type AsyncStateStatus = 'empty' | 'error' | 'idle' | 'loading' | 'success';

export type AsyncStateProps = HTMLAttributes<HTMLDivElement> & {
  /** 加载超过 200ms 才显示加载态、出现后至少保持 300ms（规范 04 §3.3），期间先不渲染内容。 */
  delayLoading?: boolean;
  /** 空态内容；传字符串时渲染为 `Empty` 的标题。 */
  empty?: ReactNode;
  /** 字符串空态的主操作（「新建课程」「清空筛选」）。 */
  emptyAction?: ReactNode;
  /** 字符串空态的说明。 */
  emptyDescription?: ReactNode;
  /** 字符串空态的场景（只影响图标），默认 `no-data`。 */
  emptyVariant?: EmptyVariant;
  /** 失败内容；传字符串时渲染为 `Empty`（错误图标）的标题。 */
  error?: ReactNode;
  /** 字符串失败态的简短原因。 */
  errorDescription?: ReactNode;
  loadingFallback?: ReactNode;
  loadingLabel?: string;
  /** 字符串失败态的「重试」操作槽（通常是一个 Button）。 */
  retry?: ReactNode;
  status: AsyncStateStatus;
};

/**
 * 异步区域四态（规范 05 §1–3）：加载中 / 有数据 / 空 / 失败。
 * 加载中 `role="status"` + `aria-busy`；失败 `role="alert"`；从加载切到内容时内容淡入 `fast`。
 */
export function AsyncState({
  children,
  className,
  delayLoading = false,
  empty,
  emptyAction,
  emptyDescription,
  emptyVariant = 'no-data',
  error,
  errorDescription,
  loadingFallback,
  loadingLabel,
  retry,
  status,
  ...props
}: AsyncStateProps) {
  const showDelayedLoading = useDelayedVisibility(delayLoading && status === 'loading');
  const previous = useRef<AsyncStateStatus | 'pending' | null>(null);

  let displayed: AsyncStateStatus | 'pending' = status;
  if (delayLoading) {
    if (showDelayedLoading) displayed = 'loading';
    else if (status === 'loading') displayed = 'pending';
  }
  const enteringFromLoading =
    (displayed === 'success' || displayed === 'idle') &&
    (previous.current === 'loading' || previous.current === 'pending');
  const stickyEnter = useRef(false);
  if (displayed === 'success' || displayed === 'idle') {
    if (enteringFromLoading) stickyEnter.current = true;
  } else {
    stickyEnter.current = false;
  }
  previous.current = displayed;

  if (displayed === 'idle' || displayed === 'success') {
    return (
      <div
        className={cn(stickyEnter.current && 'rx-async-state-enter', className) || undefined}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (displayed === 'pending') {
    return <div aria-busy="true" className={className} {...props} />;
  }

  if (displayed === 'loading') {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className={cn('rx-async-state', className)}
        role="status"
        {...props}
      >
        {loadingFallback ?? (
          <>
            <Spinner />
            {loadingLabel === undefined ? null : <span>{loadingLabel}</span>}
          </>
        )}
      </div>
    );
  }

  const content =
    displayed === 'error' ? (
      typeof error === 'string' ? (
        <Empty action={retry} description={errorDescription} title={error} variant="error" />
      ) : (
        error
      )
    ) : typeof empty === 'string' ? (
      <Empty
        action={emptyAction}
        description={emptyDescription}
        title={empty}
        variant={emptyVariant}
      />
    ) : (
      empty
    );

  return (
    <div
      className={cn('rx-async-state', `rx-async-state-${displayed}`, className)}
      role={displayed === 'error' ? 'alert' : 'status'}
      {...props}
    >
      {content}
    </div>
  );
}
