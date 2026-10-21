// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Pagination, paginationItems } from './Pagination';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const labels = {
  label: 'Pagination',
  nextLabel: 'Next page',
  pageLabel: (page: number) => `Page ${page}`,
  pageSizeLabel: (size: number) => `${size} / page`,
  previousLabel: 'Previous page',
  totalLabel: (total: number) => `${total} items`,
};

describe('paginationItems', () => {
  it('保留默认服务端输出，包括页大小触发器', () => {
    const markup = renderToStaticMarkup(<Pagination {...labels} total={60} />);
    expect(markup).not.toContain('data-touch-target');
    expect(markup).toMatchSnapshot();
  });

  it('触控能力在服务端输出，除显式属性外不改变默认 DOM', () => {
    const original = renderToStaticMarkup(<Pagination {...labels} total={60} />);
    const responsive = renderToStaticMarkup(
      <Pagination {...labels} total={60} touchTarget="responsive" />,
    );
    expect(responsive).toContain('data-touch-target="responsive"');
    expect(responsive.replaceAll(' data-touch-target="responsive"', '')).toBe(original);
  });
  it('lists every page when there are at most 7', () => {
    expect(paginationItems(1, 1)).toEqual([1]);
    expect(paginationItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('collapses the middle with ellipses around the current page', () => {
    expect(paginationItems(1, 20)).toEqual([1, 2, 3, 4, 5, 'ellipsis-end', 20]);
    expect(paginationItems(10, 20)).toEqual([1, 'ellipsis-start', 9, 10, 11, 'ellipsis-end', 20]);
    expect(paginationItems(20, 20)).toEqual([1, 'ellipsis-start', 16, 17, 18, 19, 20]);
  });
});

describe('Pagination interactions', () => {
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

  const button = (name: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) =>
        candidate.getAttribute('aria-label') === name || candidate.textContent === name,
    )!;

  it.each([undefined, 'responsive'] as const)(
    '所有按钮及弹层选项保持触控设置 %s',
    (touchTarget) => {
      act(() => root.render(<Pagination {...labels} total={250} touchTarget={touchTarget} />));
      const trigger = container.querySelector<HTMLButtonElement>('.rx-pagination-size')!;
      act(() => trigger.click());
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '.rx-pagination button, .rx-pagination-size-option',
        ),
      ];
      expect(
        buttons.filter((button) => button.classList.contains('rx-pagination-size-option')),
      ).toHaveLength(3);
      for (const button of buttons) expect(button.dataset.touchTarget).toBe(touchTarget);
      expect(container.querySelector('nav')?.hasAttribute('touchTarget')).toBe(false);
    },
  );

  it('navigates uncontrolled pages and disables the bounds', () => {
    const onChange = vi.fn();
    act(() => root.render(<Pagination {...labels} onChange={onChange} total={95} />));

    const nav = container.querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBe('Pagination');
    expect(nav.querySelector('.rx-pagination-total')?.textContent).toBe('95 items');
    expect(button('Previous page').disabled).toBe(true);
    expect(button('Page 1').getAttribute('aria-current')).toBe('page');
    expect(container.querySelectorAll('.rx-pagination-pages button')).toHaveLength(5);

    act(() => button('Next page').click());
    expect(onChange).toHaveBeenLastCalledWith(2, 20);
    expect(button('Page 2').getAttribute('aria-current')).toBe('page');

    act(() => button('Page 5').click());
    expect(onChange).toHaveBeenLastCalledWith(5, 20);
    expect(button('Next page').disabled).toBe(true);
  });

  it('only reports changes when controlled', () => {
    const onChange = vi.fn();
    act(() => root.render(<Pagination {...labels} onChange={onChange} page={3} total={500} />));
    expect(button('Page 3').getAttribute('aria-current')).toBe('page');
    expect(container.querySelectorAll('.rx-pagination-ellipsis').length).toBeGreaterThan(0);

    act(() => button('Next page').click());
    expect(onChange).toHaveBeenCalledWith(4, 20);
    expect(button('Page 3').getAttribute('aria-current')).toBe('page');

    // 当前页超出范围时收敛到最后一页。
    act(() => root.render(<Pagination {...labels} page={99} total={30} />));
    expect(button('Page 2').getAttribute('aria-current')).toBe('page');
  });

  it('changes the page size through the popover picker and resets to page 1', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<Pagination {...labels} defaultPage={3} onChange={onChange} total={250} />),
    );
    const trigger = container.querySelector<HTMLButtonElement>('.rx-pagination-size')!;
    expect(trigger.textContent).toBe('20 / page');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.rx-pagination-size-option'),
    );
    expect(options.map((option) => option.textContent)).toEqual([
      '20 / page',
      '50 / page',
      '100 / page',
    ]);
    expect(options[0]?.getAttribute('aria-pressed')).toBe('true');

    act(() => options[1]!.click());
    expect(onChange).toHaveBeenLastCalledWith(1, 50);
    expect(trigger.textContent).toBe('50 / page');
    expect(button('Page 1').getAttribute('aria-current')).toBe('page');
    expect(container.querySelectorAll('.rx-pagination-pages button')).toHaveLength(5);
  });

  it('handles an empty result set and hides the size picker without a label', () => {
    act(() =>
      root.render(<Pagination nextLabel="Next page" previousLabel="Previous page" total={0} />),
    );
    expect(container.querySelectorAll('.rx-pagination-pages button')).toHaveLength(1);
    expect(button('Previous page').disabled).toBe(true);
    expect(button('Next page').disabled).toBe(true);
    expect(container.querySelector('.rx-pagination-size')).toBeNull();
    expect(container.querySelector('.rx-pagination-total')).toBeNull();
  });
});
