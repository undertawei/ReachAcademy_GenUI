import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID,
  OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS,
  OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS_SHA256,
  OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS_VERSION,
  serializeOpenMaicOneToOneNarrationCorpus,
} from '../../lib/reach-deck/narration-one-to-one-corpus.js';
import {
  OPENMAIC_CHINESE_NARRATION_EXAMPLES,
  renderProductionSafeNarrationExample,
} from '../../lib/reach-deck/narration-style-examples.js';

const normalizeForSimilarity = (value: string): string =>
  value.replace(/\s+/gu, '').replace(/[‘’]/gu, "'");

const lcsLength = (left: string, right: string): number => {
  const a = Array.from(left);
  const b = Array.from(right);
  let previous = new Uint16Array(b.length + 1);
  let current = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[b.length]!;
};

const similarity = (left: string, right: string): number => {
  const normalizedLeft = normalizeForSimilarity(left);
  const normalizedRight = normalizeForSimilarity(right);
  return (
    (2 * lcsLength(normalizedLeft, normalizedRight)) /
    Math.max(1, normalizedLeft.length + normalizedRight.length)
  );
};

describe('OpenMAIC 58 页原稿最小修订参考全集', () => {
  it('与来源语料逐页一一对应且课程分组保持 12/33/13', () => {
    expect(OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS_VERSION).toBe(
      'openmaic-minimal-edit-narration-corpus/v1',
    );
    expect(OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS).toHaveLength(58);
    expect(OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.size).toBe(58);
    expect(new Set(OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS.map((entry) => entry.id))).toEqual(
      new Set(OPENMAIC_CHINESE_NARRATION_EXAMPLES.map((entry) => entry.id)),
    );
    expect(
      createHash('sha256').update(serializeOpenMaicOneToOneNarrationCorpus()).digest('hex'),
    ).toBe(OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS_SHA256);
    expect(
      Object.fromEntries(
        [...new Set(OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS.map((entry) => entry.sourceCourse))].map(
          (course) => [
            course,
            OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS.filter((entry) => entry.sourceCourse === course)
              .length,
          ],
        ),
      ),
    ).toEqual({
      '《卖油翁》': 12,
      '《消化和吸收》': 33,
      '《电子技术的奇幻之旅：从电报到芯片》': 13,
    });
  });

  it('以安全过滤后的 OpenMAIC 原稿为主体，而不是再写一套短讲稿', () => {
    const scores = OPENMAIC_CHINESE_NARRATION_EXAMPLES.map((source) => {
      const adapted = OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get(source.id);
      expect(adapted).toBeDefined();
      return {
        id: source.id,
        productionEligible: source.productionEligible,
        score: similarity(renderProductionSafeNarrationExample(source), adapted!.narrationMarkdown),
      };
    });

    // 57 页只做称呼、缺陷或事实级局部修订；电子技术第 6 页因多角色交错，必须合回单教师声轨。
    expect(scores.filter((entry) => entry.score >= 0.72)).toHaveLength(57);
    expect(scores.filter((entry) => entry.productionEligible && entry.score >= 0.85)).toHaveLength(
      18,
    );
    expect(scores.find((entry) => entry.id === 'openmaic-electronics-06')!.score).toBeGreaterThan(
      0.5,
    );
  });

  it('逐页删除原语料明确标注的缺陷片段，并保持单教师声轨', () => {
    const sourceById = new Map(
      OPENMAIC_CHINESE_NARRATION_EXAMPLES.map((entry) => [entry.id, entry] as const),
    );
    for (const entry of OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS) {
      expect(entry.narrationMarkdown.trim().length).toBeGreaterThan(0);
      expect(entry.sceneType).toBe(sourceById.get(entry.id)?.sceneType);
      for (const exclusion of sourceById.get(entry.id)?.excludedSpans ?? []) {
        expect(entry.narrationMarkdown).not.toContain(exclusion.text);
      }
      expect(entry.narrationMarkdown).not.toMatch(
        /(?:学生：|助教：|笔记员|显眼包|大家表现得|大家都完成得|相信大家已经)/u,
      );
      expect(entry.narrationMarkdown).not.toMatch(
        /(?:亲爱的同学|小可爱|宝子|咱就是说|秒懂|拿捏|冲鸭)/u,
      );
    }
  });

  it('生产核心示例不暗示系统知道学生的实际行为或结果', () => {
    const productionIds = new Set(
      OPENMAIC_CHINESE_NARRATION_EXAMPLES.filter((entry) => entry.productionEligible).map(
        (entry) => entry.id,
      ),
    );
    const productionCorpus = OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS.filter((entry) =>
      productionIds.has(entry.id),
    );

    expect(productionCorpus).toHaveLength(18);
    for (const entry of productionCorpus) {
      expect(entry.narrationMarkdown).not.toMatch(
        /(?:刚才的检测题做得怎么样|我们通过模拟体验了|我们严格规范了实验操作|我们通过辨析题区分了|我们系统地回顾了)/u,
      );
      expect(entry.narrationMarkdown).not.toMatch(
        /(?:你做得很棒|如果你正确操作了|你已经掌握|你答对了)/u,
      );
    }
  });

  it('保留项目页的合作主体、交付物、质量标准和完整三阶段任务', () => {
    const project = OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get('openmaic-maiyouweng-11');
    expect(project?.narrationMarkdown).toContain('你和组员一起完成');
    expect(project?.narrationMarkdown).toContain('以小组为单位');
    expect(project?.narrationMarkdown).toContain('创作并排演一个三分钟的课本剧');
    expect(project?.narrationMarkdown).toContain('忠实于原文');
    expect(project?.narrationMarkdown).toContain('动作、神态和语气');
    expect(project?.narrationMarkdown).toContain('你们的第一项任务');
    expect(project?.narrationMarkdown).toContain('角色解码与细节挖掘');
    expect(project?.narrationMarkdown).toContain('剧本结构与台词创作');
    expect(project?.narrationMarkdown).toContain('剧本修订与排演规划');
    expect(project?.narrationMarkdown).toContain('完成角色分配');
  });

  it('只在确有必要的页面修复班级编排、多角色残缺和明确事实问题', () => {
    expect(
      OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get('openmaic-maiyouweng-02')?.narrationMarkdown,
    ).not.toMatch(/(?:一位同学|其他同学|全班齐读)/u);
    expect(
      OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get('openmaic-maiyouweng-06')?.narrationMarkdown,
    ).not.toMatch(/陈尧咨最后的‘笑’包含什么意味/u);
    expect(
      OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get('openmaic-digestion-15')?.narrationMarkdown,
    ).not.toContain('麦芽糖已经有甜味了，但它仍然是大分子物质');
    expect(
      OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get('openmaic-electronics-01')?.narrationMarkdown,
    ).not.toMatch(/\n\n没错/u);
    expect(
      OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get('openmaic-electronics-04')?.narrationMarkdown,
    ).toContain('单向脉动电流');
    expect(
      OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get('openmaic-electronics-06')?.narrationMarkdown,
    ).toContain('实时波形图');
    expect(
      OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get('openmaic-electronics-06')?.narrationMarkdown,
    ).toContain('这里可以记下三点');
  });
});
