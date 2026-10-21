import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ActionFooterBar,
  BackBar,
  FeedbackCapture,
  PageColumn,
  PageColumns,
  PageContent,
  PageHeader,
  PageLayout,
} from '../src/index';
import { readGroupStyles, readSharedStyles } from './read-styles';

/** 取出某个选择器的声明块（只取第一处完全匹配的规则）。 */
function rule(styles: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, selector).not.toBeNull();
  return match![1]!;
}

const brandVariables = readFileSync(
  fileURLToPath(new URL('../../brand/styles/variables.css', import.meta.url)),
  'utf8',
);

describe('floating feedback launcher safe gutter (规范 02 §6.1)', () => {
  it('docks the collapsed launcher to the left edge, sized from the shared layout tokens', () => {
    const launcher = rule(readSharedStyles(), '.rx-feedback-launcher');

    // 贴边：左侧只让出安全区，不再离边 inset；底部仍离边 inset。
    expect(launcher).toMatch(/left:\s*env\(safe-area-inset-left, 0px\)/);
    expect(launcher).toMatch(/bottom:\s*max\(var\(--reachany-layout-feedback-inset\)/);
    expect(launcher).toMatch(/min-width:\s*var\(--reachany-layout-feedback-tab-width\)/);
    expect(launcher).toMatch(/height:\s*var\(--reachany-layout-feedback-size\)/);
    // 收起态宽度必须恰好等于 tab 宽度，不能被内边距撑宽，否则会超出预留的留白。
    expect(launcher).toMatch(/box-sizing:\s*border-box/);
    expect(launcher).toMatch(/padding:\s*0 calc\(\(var\(--reachany-layout-feedback-tab-width\)/);
    // 左侧直角贴边、右侧半圆。
    expect(launcher).toMatch(
      /border-radius:\s*0 var\(--reachany-radius-pill\) var\(--reachany-radius-pill\) 0/,
    );
    // 不再出现与 token 脱钩的字面量位置/尺寸。
    expect(launcher).not.toMatch(/\b1rem\b|\b1\.25rem\b|\b(?!0px)\d+px\b/);
  });

  it('derives the page padding from the launcher tab at every breakpoint', () => {
    expect(brandVariables).toMatch(
      /--reachany-page-padding-inline:\s*max\(40px, var\(--reachany-layout-page-gutter-safe\)\);/,
    );
    expect(brandVariables).toMatch(
      /--reachany-page-padding-inline:\s*max\(24px, var\(--reachany-layout-page-gutter-safe\)\);/,
    );
    // 安全留白与标签同源：安全区 + tab 宽度（默认 24px），两档页边距因此回到设计值 40 / 24。
    expect(brandVariables).toMatch(/--reachany-layout-feedback-tab-width:\s*24px;/);
    expect(brandVariables).toMatch(
      /--reachany-layout-page-gutter-safe:\s*calc\(\s*max\(env\(safe-area-inset-left, 0px\), env\(safe-area-inset-right, 0px\)\) \+\s*var\(--reachany-layout-feedback-tab-width\)\s*\);/,
    );
    expect(brandVariables).toMatch(/--reachany-layout-feedback-inset:\s*16px;/);
    expect(brandVariables).toMatch(/--reachany-layout-feedback-size:\s*44px;/);
  });

  it('applies the safe page padding symmetrically on every shared page region', () => {
    const layout = readGroupStyles('layout');
    const symmetric = /padding:\s*0 var\(--reachany-page-padding-inline\)/;

    expect(rule(layout, '.rx-page-content-inner')).toMatch(
      /padding:\s*0 var\(--reachany-page-padding-inline\) var\(--reachany-space-6\);/,
    );
    expect(rule(layout, ".rx-page-columns[data-padded='true']")).toMatch(
      /padding:\s*0 var\(--reachany-page-padding-inline\) var\(--reachany-space-5\);/,
    );
    expect(rule(layout, '.rx-page > .rx-page-header')).toMatch(
      /padding:\s*var\(--reachany-space-8\) var\(--reachany-page-padding-inline\) var\(--reachany-space-6\);/,
    );
    expect(rule(layout, '.rx-back-bar')).toMatch(symmetric);
    expect(rule(layout, '.rx-action-footer')).toMatch(symmetric);
    // 内容最大宽度的外框把两侧边距都算进去，≥ 1920 居中时同样对称。
    expect(rule(layout, '.rx-page-content-inner')).toContain(
      'calc(var(--reachany-content-max-width) + 2 * var(--reachany-page-padding-inline))',
    );
  });

  it('renders the shared page regions with the classes that carry the gutter', () => {
    const markup = renderToStaticMarkup(
      <PageLayout template="overview">
        <BackBar href="/back" label="Back" />
        <PageHeader title="Title" />
        <PageColumns>
          <PageColumn>main</PageColumn>
        </PageColumns>
        <PageContent>body</PageContent>
        <ActionFooterBar hint="hint">actions</ActionFooterBar>
        <FeedbackCapture t={(key) => key} />
      </PageLayout>,
    );

    for (const className of [
      'rx-back-bar',
      'rx-page-header',
      'rx-page-columns',
      'rx-page-content-inner',
      'rx-action-footer',
      'rx-feedback-launcher',
    ]) {
      expect(markup).toContain(className);
    }
    expect(markup).toContain('data-padded="true"');
  });
});
