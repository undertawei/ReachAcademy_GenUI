// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { NarrationCaption } from '../src/NarrationCaption';

describe('NarrationCaption', () => {
  it('renders block formulas statically inside a valid block caption container', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<NarrationCaption authoritative text={'结论\n\n\\[x^2+y^2\\]'} />));

    expect(host.querySelector('div[data-narration-caption="markdown"]')).not.toBeNull();
    expect(host.querySelector('[data-mathlive-node="block-math"] .katex-display')).not.toBeNull();
    expect(host.querySelector('math-field')).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  it('falls back to safe literal text if an authoritative derived cue is malformed', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() => root.render(<NarrationCaption authoritative text={'未闭合 \\(x'} />));

    expect(host.querySelector('[data-mathlive-node]')).toBeNull();
    expect(host.textContent).toBe('未闭合 \\(x');
    expect(host.innerHTML).not.toContain('<math-field');

    act(() => root.unmount());
    host.remove();
  });
});
