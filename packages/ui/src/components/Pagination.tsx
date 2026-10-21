'use client';

import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { forwardRef, useState, type HTMLAttributes } from 'react';

import { cn } from '../cn';
import { useControllableState } from '../primitives/useControllableState';
import { Popover } from './Popover';
import type { ControlTouchTarget } from './Button';

export type PaginationItem = number | 'ellipsis-end' | 'ellipsis-start';

/** 计算要显示的页码：总页数 ≤ 7 时全部显示，否则首页、末页、当前页 ±1，中间用省略号。 */
export function paginationItems(page: number, pageCount: number): PaginationItem[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const items: PaginationItem[] = [1];
  let start = Math.max(2, page - 1);
  let end = Math.min(pageCount - 1, page + 1);
  if (page <= 4) {
    start = 2;
    end = 5;
  } else if (page >= pageCount - 3) {
    start = pageCount - 4;
    end = pageCount - 1;
  }
  if (start > 2) items.push('ellipsis-start');
  for (let value = start; value <= end; value += 1) items.push(value);
  if (end < pageCount - 1) items.push('ellipsis-end');
  items.push(pageCount);
  return items;
}

export type PaginationProps = Omit<HTMLAttributes<HTMLElement>, 'onChange'> & {
  defaultPage?: number;
  defaultPageSize?: number;
  disabled?: boolean;
  /** `<nav>` 的可读名称（如「分页」）。 */
  label?: string;
  nextLabel: string;
  /** 页码或每页条数变化；改每页条数时回到第 1 页。 */
  onChange?: (page: number, pageSize: number) => void;
  /** 当前页（从 1 开始，受控）。 */
  page?: number;
  /** 页码按钮的可读名称模板，如 `(n) => \`第 ${n} 页\``；不传时读出数字本身。 */
  pageLabel?: (page: number) => string;
  pageSize?: number;
  /** 每页条数的显示文字，如 `(n) => \`${n} 条/页\``；不传时不显示每页条数选择。 */
  pageSizeLabel?: (pageSize: number) => string;
  /** 默认 20 / 50 / 100。 */
  pageSizeOptions?: readonly number[];
  previousLabel: string;
  total: number;
  /** 总数文字，如 `(n) => \`共 ${n} 条\``。 */
  totalLabel?: (total: number) => string;
  /** 窄屏时扩大所有分页控件的点击目标，默认保持原有角色密度。 */
  touchTarget?: ControlTouchTarget;
};

const DEFAULT_PAGE_SIZES = [20, 50, 100] as const;

/**
 * 管理后台数据表的分页（规范 03 §3.25）：放在表格底部右侧，显示总数、页码（带省略号）、
 * 上一页/下一页与每页条数（20/50/100）。状态同步到 URL 由调用方负责。
 */
export const Pagination = forwardRef<HTMLElement, PaginationProps>(function Pagination(
  {
    className,
    defaultPage = 1,
    defaultPageSize,
    disabled = false,
    label,
    nextLabel,
    onChange,
    page: pageProp,
    pageLabel,
    pageSize: pageSizeProp,
    pageSizeLabel,
    pageSizeOptions = DEFAULT_PAGE_SIZES,
    previousLabel,
    total,
    totalLabel,
    touchTarget,
    ...props
  },
  ref,
) {
  const [pageSize, setPageSize] = useControllableState({
    defaultValue: defaultPageSize ?? pageSizeOptions[0] ?? DEFAULT_PAGE_SIZES[0],
    value: pageSizeProp,
  });
  const [rawPage, setPage] = useControllableState({ defaultValue: defaultPage, value: pageProp });
  const [menuOpen, setMenuOpen] = useState(false);
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const safeSize = pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZES[0];
  const pageCount = Math.max(1, Math.ceil(safeTotal / safeSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(rawPage) || 1));

  const goTo = (next: number) => {
    const clamped = Math.min(pageCount, Math.max(1, next));
    if (clamped === page) return;
    setPage(clamped);
    onChange?.(clamped, safeSize);
  };

  const chooseSize = (next: number) => {
    setMenuOpen(false);
    if (next === safeSize) return;
    setPageSize(next);
    setPage(1);
    onChange?.(1, next);
  };

  return (
    <nav aria-label={label} className={cn('rx-pagination', className)} ref={ref} {...props}>
      {totalLabel ? <span className="rx-pagination-total">{totalLabel(safeTotal)}</span> : null}
      <button
        aria-label={previousLabel}
        className="rx-pagination-button rx-pagination-step"
        data-touch-target={touchTarget}
        disabled={disabled || page <= 1}
        onClick={() => goTo(page - 1)}
        type="button"
      >
        <ChevronLeft aria-hidden="true" strokeWidth={1.5} />
      </button>
      <ul className="rx-pagination-pages">
        {paginationItems(page, pageCount).map((item) =>
          typeof item === 'number' ? (
            <li key={item}>
              <button
                aria-current={item === page ? 'page' : undefined}
                aria-label={pageLabel?.(item)}
                className="rx-pagination-button rx-numeric"
                data-touch-target={touchTarget}
                data-state={item === page ? 'selected' : undefined}
                disabled={disabled}
                onClick={() => goTo(item)}
                type="button"
              >
                {item}
              </button>
            </li>
          ) : (
            <li aria-hidden="true" className="rx-pagination-ellipsis" key={item}>
              …
            </li>
          ),
        )}
      </ul>
      <button
        aria-label={nextLabel}
        className="rx-pagination-button rx-pagination-step"
        data-touch-target={touchTarget}
        disabled={disabled || page >= pageCount}
        onClick={() => goTo(page + 1)}
        type="button"
      >
        <ChevronRight aria-hidden="true" strokeWidth={1.5} />
      </button>
      {pageSizeLabel && pageSizeOptions.length > 1 ? (
        <Popover
          className="rx-pagination-size-panel"
          label={pageSizeLabel(safeSize)}
          onOpenChange={setMenuOpen}
          open={menuOpen}
          placement="top-end"
          trigger={
            <button
              className="rx-pagination-size"
              data-touch-target={touchTarget}
              disabled={disabled}
              type="button"
            >
              <span>{pageSizeLabel(safeSize)}</span>
              <ChevronDown aria-hidden="true" strokeWidth={1.5} />
            </button>
          }
        >
          <ul className="rx-pagination-size-list">
            {pageSizeOptions.map((option) => (
              <li key={option}>
                <button
                  aria-pressed={option === safeSize}
                  className="rx-pagination-size-option"
                  data-touch-target={touchTarget}
                  data-state={option === safeSize ? 'selected' : undefined}
                  onClick={() => chooseSize(option)}
                  type="button"
                >
                  <span>{pageSizeLabel(option)}</span>
                  {option === safeSize ? (
                    <Check
                      aria-hidden="true"
                      className="rx-pagination-size-check"
                      strokeWidth={1.5}
                    />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </nav>
  );
});
