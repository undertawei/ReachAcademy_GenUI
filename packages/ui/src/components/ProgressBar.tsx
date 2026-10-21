import type { HTMLAttributes } from 'react';

import { cn } from '../cn';

export type ProgressTone = 'orange' | 'primary' | 'purple' | 'success';

export type ProgressBarProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** 到达 100% 时自动改用 `success` 色（规范 03 §3.26）。 */
  autoSuccess?: boolean;
  /** 右侧数字的格式化；默认取整百分比（`42%`）。 */
  formatValue?: (value: number, max: number) => string;
  label: string;
  max?: number;
  /** 右侧显示数值（`numeric` 字体）。 */
  showValue?: boolean;
  /** 轨道高度：默认 6px，`lg` 10px（学生日程卡）。 */
  size?: 'lg' | 'md';
  /** 填充色：`primary`（默认）/ `success` / `orange`（进行中）/ `purple`。 */
  tone?: ProgressTone;
  /** 不传为不定进度。 */
  value?: number;
};

function defaultFormat(value: number, max: number): string {
  return `${Math.round((value / max) * 100)}%`;
}

/**
 * 线性进度条（规范 03 §3.26、04 §3.12）：填充段用 `scaleX` 过渡（`slow` `standard`），
 * 减少动效时直接跳到新值；`value` 为空时显示不定进度。
 */
export function ProgressBar({
  autoSuccess = false,
  className,
  formatValue = defaultFormat,
  label,
  max = 100,
  showValue = false,
  size,
  tone = 'primary',
  value,
  ...props
}: ProgressBarProps) {
  const normalizedMax = Number.isFinite(max) && max > 0 ? max : 100;
  const normalizedValue =
    value === undefined || !Number.isFinite(value)
      ? undefined
      : Math.min(normalizedMax, Math.max(0, value));
  const ratio = normalizedValue === undefined ? undefined : normalizedValue / normalizedMax;
  const resolvedTone = autoSuccess && ratio === 1 ? 'success' : tone;
  const valueText =
    normalizedValue === undefined ? undefined : formatValue(normalizedValue, normalizedMax);

  return (
    <div
      aria-label={label}
      aria-valuemax={normalizedMax}
      aria-valuemin={0}
      aria-valuenow={normalizedValue}
      aria-valuetext={showValue ? valueText : undefined}
      className={cn(
        'rx-progress',
        normalizedValue === undefined && 'rx-progress-indeterminate',
        className,
      )}
      data-size={size}
      data-state={
        normalizedValue === undefined ? 'indeterminate' : ratio === 1 ? 'complete' : undefined
      }
      data-tone={resolvedTone}
      role="progressbar"
      {...props}
    >
      <span className="rx-progress-track">
        <span
          className="rx-progress-value"
          style={{ transform: ratio === undefined ? undefined : `scaleX(${ratio})` }}
        />
      </span>
      {showValue && valueText !== undefined ? (
        <span aria-hidden="true" className="rx-progress-label rx-numeric">
          {valueText}
        </span>
      ) : null}
    </div>
  );
}
