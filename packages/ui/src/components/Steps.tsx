'use client';

import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';

export interface StepItem {
  id: string;
  /** 步骤名（「教课需求」）；序号前缀由组件生成（「01. 」）。 */
  label: ReactNode;
}

export type StepStatus = 'complete' | 'current' | 'upcoming';

export type StepsProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** 右侧全局操作（`accent` 保存、`default` 试学、`primary` 发布等按钮）。 */
  actions?: ReactNode;
  /** 允许跳到未到达的步骤（业务允许跳步时）。默认只能点击已完成步骤返回。 */
  allowJump?: boolean;
  /** 当前步骤 id。 */
  current: string;
  /** 序号前缀格式，默认两位数字加点：`01.`。 */
  formatIndex?: (index: number) => string;
  items: readonly StepItem[];
  /** 左侧返回链接。 */
  leading?: ReactNode;
  /** 步骤导航的可读名称（`<nav aria-label>`）。 */
  navLabel?: string;
  /** 点击可达步骤时调用；不传时步骤不可点击。 */
  onStepClick?: (id: string, index: number) => void;
};

const defaultFormatIndex = (index: number) => `${String(index + 1).padStart(2, '0')}.`;

/**
 * 向导步骤条（规范 03 §3.16）：横向居中，步骤间 80px 连接线；已完成 `text` 500、当前 `primary` 600、
 * 未开始 `text-secondary` 400。已完成步骤可点击返回，当前步骤 `aria-current="step"`。
 */
export const Steps = forwardRef<HTMLDivElement, StepsProps>(function Steps(
  {
    actions,
    allowJump = false,
    className,
    current,
    formatIndex = defaultFormatIndex,
    items,
    leading,
    navLabel,
    onStepClick,
    ...props
  },
  ref,
) {
  const currentIndex = items.findIndex((item) => item.id === current);

  return (
    <div className={cn('rx-steps', className)} ref={ref} {...props}>
      <div className="rx-steps-leading">{leading}</div>
      <nav aria-label={navLabel} className="rx-steps-nav">
        <ol className="rx-steps-list">
          {items.map((item, index) => {
            const status: StepStatus =
              index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';
            const clickable =
              onStepClick !== undefined &&
              status !== 'current' &&
              (status === 'complete' || allowJump);
            const content = (
              <>
                <span className="rx-steps-index rx-numeric">{formatIndex(index)}</span>{' '}
                <span className="rx-steps-label">{item.label}</span>
              </>
            );
            return (
              <li className="rx-steps-item" data-state={status} key={item.id}>
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    className="rx-steps-connector"
                    data-state={index <= currentIndex ? 'complete' : 'upcoming'}
                  />
                ) : null}
                {clickable ? (
                  <button
                    className="rx-steps-trigger"
                    onClick={() => onStepClick?.(item.id, index)}
                    type="button"
                  >
                    {content}
                  </button>
                ) : (
                  <span
                    aria-current={status === 'current' ? 'step' : undefined}
                    className="rx-steps-trigger"
                  >
                    {content}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="rx-steps-actions">{actions}</div>
    </div>
  );
});
