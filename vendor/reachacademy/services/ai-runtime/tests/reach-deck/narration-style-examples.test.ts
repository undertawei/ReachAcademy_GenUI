import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  OPENMAIC_CHINESE_NARRATION_CORE_IDS,
  OPENMAIC_CHINESE_NARRATION_CORPUS_SHA256,
  OPENMAIC_CHINESE_NARRATION_EXAMPLES,
  OPENMAIC_EXPLICIT_CLASSROOM_LANGUAGE_EXAMPLES,
  renderProductionSafeNarrationExample,
  serializeOpenMaicChineseNarrationCorpus,
} from '../../lib/reach-deck/narration-style-examples.js';

describe('OpenMAIC 中文课堂讲稿风格语料', () => {
  it('完整保存三套 58 页原文并锁定稳定摘要', () => {
    expect(OPENMAIC_CHINESE_NARRATION_EXAMPLES).toHaveLength(58);
    expect(
      Object.fromEntries(
        [...new Set(OPENMAIC_CHINESE_NARRATION_EXAMPLES.map((item) => item.sourceCourse))].map(
          (course) => [
            course,
            OPENMAIC_CHINESE_NARRATION_EXAMPLES.filter((item) => item.sourceCourse === course)
              .length,
          ],
        ),
      ),
    ).toEqual({
      '《卖油翁》': 12,
      '《消化和吸收》': 33,
      '《电子技术的奇幻之旅：从电报到芯片》': 13,
    });

    const digest = createHash('sha256')
      .update(serializeOpenMaicChineseNarrationCorpus())
      .digest('hex');
    expect(digest).toBe(OPENMAIC_CHINESE_NARRATION_CORPUS_SHA256);
  });

  it('固定 18 页生产核心集且每条高亮都来自归档原文', () => {
    const productionIds = OPENMAIC_CHINESE_NARRATION_EXAMPLES.filter(
      (item) => item.productionEligible,
    ).map((item) => item.id);
    expect(productionIds).toHaveLength(18);
    expect(new Set(productionIds)).toEqual(new Set(OPENMAIC_CHINESE_NARRATION_CORE_IDS));
    expect(productionIds).not.toContain('openmaic-digestion-02');
    expect(productionIds).toContain('openmaic-digestion-04');

    for (const example of OPENMAIC_CHINESE_NARRATION_EXAMPLES) {
      expect(example.highlightExcerpt.length).toBeGreaterThan(0);
      expect(example.exampleText).toContain(example.highlightExcerpt);
      expect(example.teachingMoves.length).toBeGreaterThan(0);
      expect(example.styleStrengths.length).toBeGreaterThan(0);
    }
  });

  it('区分不可变归档原文与仅删除已标记片段的生产安全视图', () => {
    const withExclusions = OPENMAIC_CHINESE_NARRATION_EXAMPLES.filter(
      (example) => example.excludedSpans.length > 0,
    );
    expect(withExclusions.length).toBeGreaterThan(0);

    for (const example of withExclusions) {
      const original = example.exampleText;
      const safe = renderProductionSafeNarrationExample(example);
      expect(example.exampleText).toBe(original);
      for (const exclusion of example.excludedSpans) {
        expect(original).toContain(exclusion.text);
        expect(safe).not.toContain(exclusion.text);
      }

      let expected = original;
      for (const exclusion of example.excludedSpans) {
        expected = expected.split(exclusion.text).join('');
      }
      expect(safe).toBe(expected.trim());
    }
  });

  it('生产核心示例的安全视图剔除重复问候、虚构表现与多角色片段', () => {
    const core = OPENMAIC_CHINESE_NARRATION_EXAMPLES.filter(
      (example) => example.productionEligible,
    );
    for (const example of core) {
      const safe = renderProductionSafeNarrationExample(example);
      for (const exclusion of example.excludedSpans) expect(safe).not.toContain(exclusion.text);
    }

    const digestionSix = core.find((example) => example.id === 'openmaic-digestion-06');
    const digestionEight = core.find((example) => example.id === 'openmaic-digestion-08');
    const electronicsThirteen = core.find((example) => example.id === 'openmaic-electronics-13');
    expect(renderProductionSafeNarrationExample(digestionSix!)).not.toContain('同学们好，');
    expect(renderProductionSafeNarrationExample(digestionEight!)).not.toContain(
      '大家练习完成得很不错。',
    );
    expect(renderProductionSafeNarrationExample(electronicsThirteen!)).not.toContain(
      '大家表现得非常出色！',
    );
    for (const example of core.filter((item) => item.pagePosition === 'middle')) {
      expect(renderProductionSafeNarrationExample(example)).not.toMatch(
        /(?:大家早上好|同学们好|欢迎来到)/u,
      );
    }
  });

  it('保留 OpenMAIC 显式课堂用语的原始措辞与来源摘要', () => {
    expect(OPENMAIC_EXPLICIT_CLASSROOM_LANGUAGE_EXAMPLES.map((item) => item.text)).toEqual([
      "First, let's look at the key concept...",
      'Now observe this chart showing the relationship...',
      'Building on what we just covered...',
      "Let's see how the ideas we just covered settled in...",
      "Let's explore this concept through the interactive widget.",
    ]);
    for (const example of OPENMAIC_EXPLICIT_CLASSROOM_LANGUAGE_EXAMPLES) {
      expect(example.sourcePath).toMatch(/openmaic/u);
      expect(example.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });
});
