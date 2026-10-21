import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveHtmlLayoutFontRuns,
  resolveHtmlLayoutFontSourceDirectory,
  verifyHtmlLayoutFontSources,
} from '../../lib/reach-deck/html-layout/fonts.js';

describe('HTML layout font resolution', () => {
  it('maps generic families to the deck body font and keeps bundled requests', async () => {
    await expect(
      resolveHtmlLayoutFontRuns(
        [
          { family: 'sans-serif', text: '床前明月光' },
          { family: '"Source Han Serif SC", serif', text: '静夜思' },
          { family: 'LXGW WenKai', text: '疑是地上霜' },
        ],
        'LXGW WenKai',
      ),
    ).resolves.toEqual(['LXGW WenKai', 'Source Han Serif SC', 'LXGW WenKai']);
  });

  it('keeps the calibrated sans default for general decks', async () => {
    await expect(
      resolveHtmlLayoutFontRuns(
        [{ family: 'sans-serif', text: '一次函数 y=2x+1' }],
        'Source Han Sans VF',
      ),
    ).resolves.toEqual(['Source Han Sans VF']);
  });

  it('falls back to Source Han Sans instead of failing when no bundled font covers a run', async () => {
    // 下标数字不在思源黑体里；显示不了个别字符可以接受，整页不能因此失败。
    await expect(
      resolveHtmlLayoutFontRuns(
        [
          { family: 'sans-serif', text: '甲烷 CH₄ 与 V₁、V₂' },
          { family: 'Times New Roman', text: 'a₀ + a₁x' },
        ],
        'Source Han Sans VF',
      ),
    ).resolves.toEqual(['Source Han Sans VF', 'Source Han Sans VF']);
  });

  it('reads source fonts from the deployed font directory when one is configured', () => {
    // Deployed images exclude player/fonts/sources; the base image supplies the fonts instead.
    expect(resolveHtmlLayoutFontSourceDirectory('/usr/share/fonts/reachany/reach-fonts')).toBe(
      path.resolve('/usr/share/fonts/reachany/reach-fonts'),
    );
    expect(resolveHtmlLayoutFontSourceDirectory('')).toMatch(
      /packages[\\/]reach-deck-player[\\/]fonts[\\/]sources$/,
    );
  });

  it('verifies every catalogued source font and rejects a directory missing them', async () => {
    await expect(verifyHtmlLayoutFontSources('')).resolves.toBeUndefined();
    const empty = await mkdtemp(path.join(tmpdir(), 'reach-html-layout-fonts-'));
    try {
      await expect(verifyHtmlLayoutFontSources(empty)).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
