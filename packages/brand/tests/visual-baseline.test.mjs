import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { brandCssVariables, brandTokens } from '../src/tokens.ts';

const variablesSource = readFileSync(new URL('../styles/variables.css', import.meta.url), 'utf8');
const themeSource = readFileSync(new URL('../styles/theme.css', import.meta.url), 'utf8');

function normalize(value) {
  // Prettier 会把长的 calc()/max() 拆成多行，比较前抹掉括号内侧的空白。
  return value.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

function declarations(block) {
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], normalize(match[2])]),
  );
}

function primaryRootCssVariables(source) {
  const primaryRoot = source.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(primaryRoot, 'primary :root block');
  return declarations(primaryRoot[1]);
}

test('keeps the TypeScript and CSS variable contracts in exact key and value parity', () => {
  const css = primaryRootCssVariables(variablesSource);
  const ts = new Map(Object.entries(brandCssVariables).map(([name, value]) => [name, value]));

  assert.deepEqual([...css.keys()].sort(), [...ts.keys()].sort());
  for (const [name, value] of ts) {
    assert.equal(css.get(name), normalize(value), `${name} CSS value`);
  }
});

test('publishes the confirmed Phase 2 visual baseline', () => {
  const expected = [
    ['--reachany-color-header', '#1e2740'],
    ['--reachany-color-ink', '#1e2234'],
    ['--reachany-color-primary', '#b5402e'],
    ['--reachany-color-primary-hover', '#9c3728'],
    ['--reachany-color-accent', '#f6c84b'],
    ['--reachany-color-accent-contrast', '#1e2234'],
    ['--reachany-color-canvas', '#fcf9f2'],
    ['--reachany-color-surface-warm', '#fffcf7'],
    ['--reachany-color-text', '#1e2234'],
    ['--reachany-color-text-secondary', '#6b6f80'],
    ['--reachany-color-text-tertiary', '#a5a8b8'],
    ['--reachany-color-border', '#ebebeb'],
    ['--reachany-color-success-text', '#2f7a5b'],
    ['--reachany-color-overlay', 'rgb(0 0 0 / 60%)'],
    ['--reachany-header-height', '60px'],
    ['--reachany-header-padding-inline', '40px'],
    ['--reachany-radius-lg', '16px'],
    ['--reachany-z-header', '100'],
    ['--reachany-z-modal', '1200'],
  ];
  const css = primaryRootCssVariables(variablesSource);
  for (const [name, value] of expected) {
    assert.equal(css.get(name), value, name);
  }
});

test('maps Phase 1 compatibility aliases onto Phase 2 values', () => {
  const { color } = brandTokens;
  assert.equal(color.action, color.primary);
  assert.equal(color.actionHover, color.primaryHover);
  assert.equal(color.mutedText, color.textSecondary);
  assert.equal(color.mutedAccent, color.textTertiary);
  assert.equal(color.surfaceSubtle, color.surfaceMuted);
  assert.equal(color.neutral1, color.surfaceMuted);
  assert.equal(color.neutral2, color.border);
  assert.equal(color.brick, color.primaryHover);
  assert.equal(color.brickSoft, color.primarySoft);

  const retiredPhaseOneColors = ['#f45f22', '#9a6870', '#ad7e85', '#f7ead9', '#5e3853', '#d6cdd2'];
  for (const retired of retiredPhaseOneColors) {
    assert.doesNotMatch(variablesSource, new RegExp(retired, 'i'), `${retired} is retired`);
  }
});

test('collapses motion under prefers-reduced-motion', () => {
  const reduced = variablesSource.match(
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([\s\S]*?)\}/,
  );
  assert.ok(reduced, 'reduced-motion block');
  const values = declarations(reduced[1]);
  for (const name of Object.keys(brandCssVariables).filter((key) =>
    key.startsWith('--reachany-motion-duration-'),
  )) {
    assert.equal(values.get(name), brandTokens.motion.reducedDuration, name);
  }
});

test('Tailwind theme only references declared brand variables', () => {
  const referenced = [...themeSource.matchAll(/var\((--reachany-[\w-]+)\)/g)].map(
    (match) => match[1],
  );
  assert.ok(referenced.length > 0);
  for (const name of referenced) {
    assert.ok(name in brandCssVariables, `${name} is declared`);
  }
  assert.doesNotMatch(themeSource, /#[0-9a-f]{3,8}\b/i, 'theme.css must not copy literal colors');
  // 不覆盖存量页面依赖的 Tailwind 默认刻度（见 theme.css 文件头）。
  assert.doesNotMatch(themeSource, /--radius-(md|lg|xl):/);
});

test('reserves a symmetric page gutter for the floating feedback launcher', () => {
  const css = primaryRootCssVariables(variablesSource);
  assert.equal(css.get('--reachany-layout-feedback-inset'), '16px');
  assert.equal(css.get('--reachany-layout-feedback-size'), '44px');
  assert.equal(css.get('--reachany-layout-feedback-tab-width'), '24px');

  // 入口是贴左边缘的窄标签：安全留白 = 安全区 + 收起态标签宽度（默认 24px），与标签同源。
  const gutter = css.get('--reachany-layout-page-gutter-safe');
  assert.match(gutter, /^calc\(max\(env\(safe-area-inset-left, 0px\)/);
  assert.match(gutter, /env\(safe-area-inset-right, 0px\)/);
  assert.match(gutter, /\+ var\(--reachany-layout-feedback-tab-width\)\)$/);

  // 页面左右边距永远不小于安全留白：基准档与 1280–1439 档都要包一层 max()。
  assert.equal(
    css.get('--reachany-page-padding-inline'),
    'max(40px, var(--reachany-layout-page-gutter-safe))',
  );
  const medium = variablesSource.match(
    /@media \(max-width: 1439px\)\s*\{\s*:root\s*\{([\s\S]*?)\}/,
  );
  assert.ok(medium, '1280–1439 block');
  assert.equal(
    declarations(medium[1]).get('--reachany-page-padding-inline'),
    normalize(brandTokens.layout.pagePaddingInlineMedium),
  );
  assert.match(
    brandTokens.layout.pagePaddingInlineMedium,
    /var\(--reachany-layout-page-gutter-safe\)/,
  );
});
