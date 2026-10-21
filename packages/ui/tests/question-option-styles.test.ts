import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readGroupStyles } from './read-styles';

// QuestionOption（规范 03 §3.8a）样式契约：只引用 token，并由共享样式入口引入。
describe('QuestionOption styles', () => {
  const css = readGroupStyles('question-option');

  it('only references brand tokens for colors, spacing and radii', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).toMatch(/var\(--reachany-color-primary-soft\)/);
    expect(css).toMatch(/var\(--reachany-color-success-soft\)/);
    expect(css).toMatch(/var\(--reachany-color-danger-soft\)/);
    expect(css).toMatch(/var\(--reachany-radius-card\)/);
    expect(css).toMatch(/var\(--reachany-text-body-lg\)/);
    expect(css).toMatch(/var\(--reachany-shadow-focus\)/);
  });

  it('outlines answered-correct and missed options with success-strong for 3:1 non-text contrast', () => {
    for (const result of ['correct', 'missed']) {
      const block = css.match(
        new RegExp(`\\.rx-question-option\\[data-result='${result}'\\]\\s*\\{([^}]*)\\}`),
      )?.[1];
      expect(block, result).toBeDefined();
      expect(block).toMatch(
        /--rx-question-option-border:\s*var\(--reachany-color-success-strong\);/,
      );
    }
    expect(css).not.toMatch(/--rx-question-option-border:\s*var\(--reachany-color-success\);/);
  });

  it('is imported by the shared stylesheet entry', () => {
    const entry = readFileSync(
      fileURLToPath(new URL('../src/styles.css', import.meta.url)),
      'utf8',
    );
    expect(entry).toContain("@import './styles/question-option.css';");
  });
});
