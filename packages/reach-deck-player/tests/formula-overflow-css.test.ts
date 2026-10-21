// @vitest-environment jsdom

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Reach Deck formula overflow CSS', () => {
  it('does not create a nested horizontal scroller in Player or Editor formula surfaces', () => {
    const playerStyles = readFileSync('styles.css', 'utf8');
    const editorStyles = readFileSync('../reach-deck-editor/styles.css', 'utf8');
    const mathliveStyles = readFileSync('../tiptap-mathlive/styles.css', 'utf8');

    expect(playerStyles).toMatch(
      /\.quiz-scene \.reachany-mathlive-node\.is-block\s*\{[^}]*overflow-x:\s*visible/s,
    );
    expect(playerStyles).toMatch(
      /\.reach-deck-player[\s\S]*\.katex-display\s*\{\s*overflow-x:\s*visible/s,
    );
    expect(editorStyles).toMatch(
      /\.reach-deck-editor[\s\S]*\.katex-display,[\s\S]*\.reachany-mathlive-field\s*\{\s*overflow-x:\s*visible/s,
    );

    const style = document.createElement('style');
    style.textContent = [mathliveStyles, playerStyles, editorStyles]
      .map((source) => source.replace(/^@import .*$/gm, ''))
      .join('\n');
    document.head.append(style);
    document.body.innerHTML = `
      <div class="reach-deck-player quiz-scene">
        <div class="reachany-mathlive-node is-block">
          <div class="reachany-mathlive-static"><div class="katex-display"></div></div>
        </div>
      </div>
      <div class="reach-deck-editor">
        <div class="reachany-mathlive-node is-block">
          <div class="reachany-mathlive-static"><div class="katex-display"></div></div>
          <div class="reachany-mathlive-field"></div>
        </div>
      </div>`;

    for (const element of document.querySelectorAll<HTMLElement>(
      '.reach-deck-player .reachany-mathlive-node, .reach-deck-player .katex-display, .reach-deck-editor .katex-display, .reach-deck-editor .reachany-mathlive-field',
    )) {
      expect(getComputedStyle(element).overflowX).toBe('visible');
    }
  });
});
