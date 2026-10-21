// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Button, buttonStyleProps, type ControlTouchTarget } from './Button';
import { IconButton } from './IconButton';
import { Input } from './Input';
import { SearchInput } from './SearchInput';
import { Select } from './Select';

describe('响应式触控尺寸', () => {
  const controls = [
    [
      'Button',
      (touchTarget?: ControlTouchTarget) => (
        <Button size="lg" touchTarget={touchTarget}>
          返回
        </Button>
      ),
    ],
    [
      'IconButton',
      (touchTarget?: ControlTouchTarget) => (
        <IconButton icon="★" label="收藏" noTooltip size="lg" touchTarget={touchTarget} />
      ),
    ],
    [
      'Input',
      (touchTarget?: ControlTouchTarget) => (
        <Input aria-label="名称" size="lg" touchTarget={touchTarget} />
      ),
    ],
    [
      'SearchInput',
      (touchTarget?: ControlTouchTarget) => (
        <SearchInput aria-label="搜索" size="lg" touchTarget={touchTarget} />
      ),
    ],
    [
      'Select',
      (touchTarget?: ControlTouchTarget) => (
        <Select
          aria-label="学科"
          options={[]}
          size="lg"
          touchTarget={touchTarget}
          variant="filter"
        />
      ),
    ],
    [
      '链接',
      (touchTarget?: ControlTouchTarget) => (
        <a href="/" {...buttonStyleProps({ size: 'lg', touchTarget })}>
          返回
        </a>
      ),
    ],
  ] as const;

  it.each(controls)('%s 在 SSR 输出显式能力，默认保持原尺寸', (_name, control) => {
    const responsive = renderToStaticMarkup(control('responsive'));
    const original = renderToStaticMarkup(control());
    expect(responsive).toContain('data-touch-target="responsive"');
    expect(responsive).toContain('data-size="lg"');
    expect(responsive).not.toContain('touchTarget=');
    expect(original).not.toContain('data-touch-target');
    expect(original).toContain('data-size="lg"');
  });

  it('输入框的清除按钮继承显式触控能力', () => {
    const markup = renderToStaticMarkup(
      <Input defaultValue="文本" clearable clearLabel="清除" touchTarget="responsive" />,
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    expect(container.querySelector('button')?.getAttribute('data-touch-target')).toBe('responsive');
  });

  it('尺寸规则仅在规范窄屏断点启用，且覆盖显式尺寸和筛选型尺寸', () => {
    const css = readFileSync('src/styles/touch-target.css', 'utf8');
    expect(css).toContain('@media (max-width: 1023px)');
    expect(css).toMatch(
      /:is\(\.rx-button, \.rx-icon-button, \.rx-input, \.rx-select\)\.rx-sized\[data-touch-target='responsive'\]/,
    );
    expect(css).toContain('--rx-control-height: var(--reachany-space-10)');
    expect(css).toContain('--rx-option-height: var(--reachany-space-10)');
    expect(css).toContain('min-width: var(--reachany-space-10)');
    expect(css).toContain('min-height: var(--reachany-space-10)');
  });
});
