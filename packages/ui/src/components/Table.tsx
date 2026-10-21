'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Fragment, type CSSProperties, type HTMLAttributes, type Key, type ReactNode } from 'react';

import { cn } from '../cn';
import { Skeleton } from './Skeleton';

export type TableAlign = 'center' | 'left' | 'right';
export type TableSortDirection = 'asc' | 'desc';

export interface TableSort {
  direction: TableSortDirection;
  key: string;
}

export interface TableColumn<Row> {
  align?: TableAlign;
  /** 列标识；未提供 `render` 时按此键读取 `row[key]`。 */
  key: string;
  /** 数字列：右对齐 + `tabular-nums`。 */
  numeric?: boolean;
  render?: (row: Row, index: number) => ReactNode;
  /** 可排序：表头可点击，在 升序 → 降序 → 无 之间切换。 */
  sortable?: boolean;
  title: ReactNode;
  width?: CSSProperties['width'];
}

export type TableProps<Row> = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** 表格标题（`<caption>`）；`captionHidden` 时仅供读屏。 */
  caption?: ReactNode;
  captionHidden?: boolean;
  columns: readonly TableColumn<Row>[];
  /** 可读最小表宽；业务使用品牌语义 token，横向滚动留在本 Table 容器内。 */
  minWidth?: CSSProperties['minWidth'];
  /**
   * 当前展开的行（受控）。展开内容由 `renderExpandedRow` 给出，渲染在该行下方、跨全部列的一行里。
   * 展开/收起的按钮由调用方放在某一列里：`aria-expanded` 跟随本数组，`aria-controls` 用
   * `expandedRowId` 给出的 id。
   */
  expandedRowKeys?: readonly Key[];
  /** 展开行容器的 id，供触发按钮的 `aria-controls` 使用。 */
  expandedRowId?: (key: Key) => string;
  /** 空态节点（通常是 `Empty`），在表体内跨全部列显示；区分「无数据」与「无筛选结果」由调用方决定。 */
  empty?: ReactNode;
  /** 加载中：保留表头，显示骨架行。 */
  loading?: boolean;
  /** Optional application-specific loading body, spanning all columns. */
  loadingFallback?: ReactNode;
  /** 加载中的读屏文字。 */
  loadingLabel?: string;
  /** 骨架行数，限制在 5–10，默认 5。 */
  loadingRows?: number;
  /** 当前排序（受控）；`null` 表示无排序。 */
  onSortChange?: (sort: TableSort | null) => void;
  /** 展开行的内容；只对 `expandedRowKeys` 里的行调用。 */
  renderExpandedRow?: (row: Row, index: number) => ReactNode;
  rowKey: ((row: Row, index: number) => Key) | keyof Row;
  rows: readonly Row[];
  selectedRowKeys?: readonly Key[];
  sort?: TableSort | null;
  /** 横向滚动时固定首列。 */
  stickyFirstColumn?: boolean;
  /** 横向滚动时固定末列（操作列）。 */
  stickyLastColumn?: boolean;
  /** 透传给 `<table>` 的属性（例如 `aria-label`）。 */
  tableProps?: HTMLAttributes<HTMLTableElement>;
};

function nextSort(current: TableSort | null | undefined, key: string): TableSort | null {
  if (!current || current.key !== key) return { direction: 'asc', key };
  if (current.direction === 'asc') return { direction: 'desc', key };
  return null;
}

function cellAlign<Row>(column: TableColumn<Row>): TableAlign | undefined {
  return column.align ?? (column.numeric ? 'right' : undefined);
}

function readCell<Row>(row: Row, column: TableColumn<Row>, index: number): ReactNode {
  if (column.render) return column.render(row, index);
  const value = (row as Record<string, unknown>)[column.key];
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

/**
 * 数据表格（规范 03 §3.24）：语义 `<table>`，表头在滚动容器内 sticky；
 * 可固定首列与操作列；排序受控（`sort` / `onSortChange`），表头显示方向图标并写 `aria-sort`；
 * 加载保留表头显示骨架行；空态在表体内显示；行可展开（`expandedRowKeys` / `renderExpandedRow`）。
 */
export function Table<Row>({
  caption,
  captionHidden = false,
  className,
  columns,
  empty,
  expandedRowId,
  expandedRowKeys,
  loading = false,
  loadingFallback,
  loadingLabel,
  loadingRows = 5,
  minWidth,
  onSortChange,
  renderExpandedRow,
  rowKey,
  rows,
  selectedRowKeys,
  sort,
  stickyFirstColumn = false,
  stickyLastColumn = false,
  tableProps,
  ...props
}: TableProps<Row>) {
  const selected = new Set<Key>(selectedRowKeys ?? []);
  const expanded = new Set<Key>(renderExpandedRow ? (expandedRowKeys ?? []) : []);
  const skeletonCount = Number.isFinite(loadingRows)
    ? Math.min(10, Math.max(5, Math.floor(loadingRows)))
    : 5;
  const keyOf = (row: Row, index: number): Key =>
    typeof rowKey === 'function' ? rowKey(row, index) : (row[rowKey] as unknown as Key);
  const columnCount = Math.max(1, columns.length);

  return (
    <div
      className={cn(
        'rx-table-scroll',
        'rx-scroll',
        loadingFallback !== undefined && 'rx-table-custom-loading',
        className,
      )}
      data-sticky-first={stickyFirstColumn ? 'true' : undefined}
      data-sticky-last={stickyLastColumn ? 'true' : undefined}
      {...props}
    >
      <table
        {...tableProps}
        style={{ ...tableProps?.style, ...(minWidth === undefined ? {} : { minWidth }) }}
        aria-busy={loading || undefined}
        className={cn('rx-table', tableProps?.className)}
      >
        {caption === undefined || caption === null ? null : (
          <caption className={captionHidden ? 'rx-visually-hidden' : 'rx-table-caption'}>
            {caption}
          </caption>
        )}
        <colgroup>
          {columns.map((column) => (
            <col
              key={column.key}
              style={column.width === undefined ? undefined : { width: column.width }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort && sort.key === column.key ? sort.direction : undefined;
              const SortIcon =
                active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown;
              return (
                <th
                  aria-sort={
                    column.sortable && active
                      ? active === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className="rx-table-head"
                  data-align={cellAlign(column)}
                  data-numeric={column.numeric ? 'true' : undefined}
                  key={column.key}
                  scope="col"
                >
                  {column.sortable ? (
                    <button
                      className="rx-table-sort"
                      data-state={active}
                      onClick={() => onSortChange?.(nextSort(sort, column.key))}
                      type="button"
                    >
                      <span>{column.title}</span>
                      <SortIcon
                        aria-hidden="true"
                        className="rx-table-sort-icon"
                        strokeWidth={1.5}
                      />
                    </button>
                  ) : (
                    column.title
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && loadingFallback !== undefined && rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount}>
                <div
                  className="rx-table-loading"
                  style={{ '--rx-table-loading-rows': skeletonCount } as CSSProperties}
                >
                  {loadingFallback}
                </div>
              </td>
            </tr>
          ) : loading && loadingFallback === undefined ? (
            Array.from({ length: skeletonCount }, (_, index) => (
              <tr
                aria-hidden="true"
                className="rx-table-row rx-table-row-skeleton"
                key={`skeleton-${index}`}
              >
                {columns.map((column) => (
                  <td
                    className="rx-table-cell"
                    data-align={cellAlign(column)}
                    data-numeric={column.numeric ? 'true' : undefined}
                    key={column.key}
                  >
                    <Skeleton className="rx-table-skeleton" />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            empty === undefined || empty === null ? null : (
              <tr className="rx-table-empty-row">
                <td className="rx-table-empty" colSpan={columnCount}>
                  {empty}
                </td>
              </tr>
            )
          ) : (
            rows.map((row, index) => {
              const key = keyOf(row, index);
              const isExpanded = expanded.has(key);
              const cells = (
                <tr
                  className="rx-table-row"
                  data-expanded={isExpanded ? 'true' : undefined}
                  data-state={selected.has(key) ? 'selected' : undefined}
                >
                  {columns.map((column) => (
                    <td
                      className="rx-table-cell"
                      data-align={cellAlign(column)}
                      data-numeric={column.numeric ? 'true' : undefined}
                      key={column.key}
                    >
                      {readCell(row, column, index)}
                    </td>
                  ))}
                </tr>
              );
              // 始终包在同一个 Fragment 里：展开/收起时这一行不重新挂载，触发按钮才不会丢焦点。
              return (
                <Fragment key={key}>
                  {cells}
                  {isExpanded ? (
                    <tr className="rx-table-expanded-row">
                      <td
                        className="rx-table-expanded"
                        colSpan={columnCount}
                        id={expandedRowId?.(key)}
                      >
                        {renderExpandedRow?.(row, index)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
      {loading && loadingFallback !== undefined && rows.length > 0 ? (
        <div className="rx-table-loading-overlay">{loadingFallback}</div>
      ) : null}
      {loading && loadingLabel && loadingFallback === undefined ? (
        <span className="rx-visually-hidden" role="status">
          {loadingLabel}
        </span>
      ) : null}
    </div>
  );
}
