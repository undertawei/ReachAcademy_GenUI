import { describe, expect, it } from 'vitest';
import { createLayoutDiagnostics } from '../../lib/reach-deck/html-layout/types';

describe('HTML layout developer diagnostic limits', () => {
  it('deduplicates and bounds each element and the whole page', () => {
    const { diagnostics, report } = createLayoutDiagnostics();
    report('first', 'same');
    report('first', 'same');
    expect(diagnostics).toEqual(['same']);
    for (let i = 0; i < 20; i++) report('first', `first ${i}`);
    expect(diagnostics).toHaveLength(5);
    for (let element = 0; element < 40; element++) {
      for (let issue = 0; issue < 10; issue++) report(`element-${element}`, `${element}:${issue}`);
    }
    expect(diagnostics).toHaveLength(100);
    expect(diagnostics.filter((message) => message.startsWith('0:'))).toHaveLength(5);
  });

  it('bounds each diagnostic message independently', () => {
    const { diagnostics, report } = createLayoutDiagnostics();
    report('element', 'x'.repeat(10_000));
    expect(diagnostics[0]).toHaveLength(1800);
  });
});
