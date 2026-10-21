// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Table, type TableColumn, type TableSort } from './Table';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Row {
  id: string;
  name: string;
  score: number;
}

const rows: Row[] = [
  { id: 'a', name: 'Ada', score: 92 },
  { id: 'b', name: 'Grace', score: 87 },
];

const columns: TableColumn<Row>[] = [
  { key: 'name', sortable: true, title: 'Name' },
  { key: 'score', numeric: true, sortable: true, title: 'Score' },
  {
    key: 'actions',
    render: (row) => <button type="button">Edit {row.name}</button>,
    title: 'Actions',
  },
];

describe('Table interactions', () => {
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

  it('renders a semantic table with numeric alignment, selection and custom cells', () => {
    act(() => {
      root.render(
        <Table
          caption="Students"
          captionHidden
          columns={columns}
          rowKey="id"
          rows={rows}
          selectedRowKeys={['b']}
          stickyFirstColumn
          stickyLastColumn
        />,
      );
    });
    const table = container.querySelector('table')!;
    expect(table.querySelector('caption')?.className).toBe('rx-visually-hidden');
    expect(table.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
    const bodyRows = table.querySelectorAll('tbody tr');
    expect(bodyRows).toHaveLength(2);
    expect(bodyRows[1]?.getAttribute('data-state')).toBe('selected');
    expect(bodyRows[0]?.getAttribute('data-state')).toBeNull();
    const scoreCell = bodyRows[0]?.querySelectorAll('td')[1];
    expect(scoreCell?.textContent).toBe('92');
    expect(scoreCell?.getAttribute('data-align')).toBe('right');
    expect(scoreCell?.getAttribute('data-numeric')).toBe('true');
    expect(bodyRows[0]?.querySelector('button')?.textContent).toBe('Edit Ada');
    const scroll = container.firstElementChild as HTMLElement;
    expect(scroll.dataset.stickyFirst).toBe('true');
    expect(scroll.dataset.stickyLast).toBe('true');
  });

  it('cycles sorting asc → desc → none through the controlled callback with aria-sort', () => {
    const changes: (TableSort | null)[] = [];
    function Harness() {
      const [sort, setSort] = useState<TableSort | null>(null);
      return (
        <Table
          columns={columns}
          onSortChange={(next) => {
            changes.push(next);
            setSort(next);
          }}
          rowKey={(row) => row.id}
          rows={rows}
          sort={sort}
        />
      );
    }
    act(() => root.render(<Harness />));
    const nameHeader = () => container.querySelectorAll('th')[0]!;
    const nameButton = () => nameHeader().querySelector('button')!;
    expect(nameHeader().hasAttribute('aria-sort')).toBe(false);

    act(() => nameButton().click());
    expect(nameHeader().getAttribute('aria-sort')).toBe('ascending');
    act(() => nameButton().click());
    expect(nameHeader().getAttribute('aria-sort')).toBe('descending');
    act(() => nameButton().click());
    expect(nameHeader().hasAttribute('aria-sort')).toBe(false);
    expect(changes).toEqual([
      { direction: 'asc', key: 'name' },
      { direction: 'desc', key: 'name' },
      null,
    ]);

    // 切到另一列时从升序开始。
    act(() => nameButton().click());
    act(() => container.querySelectorAll('th')[1]!.querySelector('button')!.click());
    expect(changes.at(-1)).toEqual({ direction: 'asc', key: 'score' });
    // 非排序列没有按钮。
    expect(container.querySelectorAll('th')[2]!.querySelector('button')).toBeNull();
  });

  it('keeps the header while loading and clamps skeleton rows to 5–10', () => {
    act(() => {
      root.render(
        <Table
          columns={columns}
          loading
          loadingLabel="Loading students"
          loadingRows={40}
          rowKey="id"
          rows={rows}
        />,
      );
    });
    expect(container.querySelectorAll('thead th')).toHaveLength(3);
    expect(container.querySelectorAll('tbody tr.rx-table-row-skeleton')).toHaveLength(10);
    expect(container.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading students');

    act(() => {
      root.render(<Table columns={columns} loading loadingRows={1} rowKey="id" rows={[]} />);
    });
    expect(container.querySelectorAll('tbody tr.rx-table-row-skeleton')).toHaveLength(5);
  });

  it('renders expanded content in a full-width row under controlled expanded keys', () => {
    function Harness() {
      const [open, setOpen] = useState<string[]>([]);
      return (
        <Table
          columns={[
            {
              key: 'toggle',
              render: (row: Row) => (
                <button
                  aria-controls={`detail-${row.id}`}
                  aria-expanded={open.includes(row.id)}
                  onClick={() => setOpen(open.includes(row.id) ? [] : [row.id])}
                  type="button"
                >
                  Toggle {row.name}
                </button>
              ),
              title: 'Toggle',
            },
            ...columns,
          ]}
          expandedRowId={(key) => `detail-${String(key)}`}
          expandedRowKeys={open}
          renderExpandedRow={(row) => <p>Detail of {row.name}</p>}
          rowKey="id"
          rows={rows}
        />
      );
    }
    act(() => root.render(<Harness />));
    expect(container.querySelector('.rx-table-expanded-row')).toBeNull();

    const toggle = container.querySelectorAll<HTMLButtonElement>('button[aria-controls]')[1]!;
    act(() => toggle.click());

    const bodyRows = [...container.querySelectorAll('tbody > tr')];
    expect(bodyRows).toHaveLength(3);
    // 展开内容紧跟在它所属的行下面，而不是堆到表尾。
    expect(bodyRows[1]?.getAttribute('data-expanded')).toBe('true');
    expect(bodyRows[2]?.className).toBe('rx-table-expanded-row');
    const detail = bodyRows[2]!.querySelector('td')!;
    expect(detail.colSpan).toBe(4);
    expect(detail.id).toBe('detail-b');
    expect(detail.textContent).toBe('Detail of Grace');
    // 同一个按钮节点：展开没有让这一行重新挂载（否则键盘用户会丢焦点）。
    expect(toggle.isConnected).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    act(() => toggle.click());
    expect(container.querySelector('.rx-table-expanded-row')).toBeNull();
    expect(container.querySelector('[data-expanded]')).toBeNull();
  });

  it('renders the empty node inside tbody spanning all columns', () => {
    const onSortChange = vi.fn();
    act(() => {
      root.render(
        <Table
          columns={columns}
          empty={<p>No students yet</p>}
          onSortChange={onSortChange}
          rowKey="id"
          rows={[]}
        />,
      );
    });
    const cell = container.querySelector('tbody td')!;
    expect(cell.getAttribute('colspan')).toBe('3');
    expect(cell.textContent).toBe('No students yet');
  });
});
