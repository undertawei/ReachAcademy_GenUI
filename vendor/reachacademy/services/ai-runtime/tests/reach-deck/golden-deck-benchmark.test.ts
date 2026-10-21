import { describe, expect, it } from 'vitest';

import {
  GOLDEN_DECK_CAPABILITY_RUBRIC,
  GOLDEN_DECK_EXPECTED_PAGES,
  GOLDEN_DECK_TEACHER_SOURCE_PROMPT,
  type GoldenDeckSceneType,
} from './fixtures/golden-deck-benchmark.js';

const PAGE_DECLARATION = /^PAGE (\d{2}) \| sceneType=(slide|interactive|quiz) \| (.+)$/gm;

interface ParsedPageDeclaration {
  order: number;
  sceneType: GoldenDeckSceneType;
  title: string;
}

function parsePageDeclarations(sourcePrompt: string): ParsedPageDeclaration[] {
  return Array.from(sourcePrompt.matchAll(PAGE_DECLARATION), (match) => ({
    order: Number(match[1]),
    sceneType: match[2] as GoldenDeckSceneType,
    title: match[3],
  }));
}

function pageSection(sourcePrompt: string, order: number): string {
  const marker = `PAGE ${String(order).padStart(2, '0')} |`;
  const start = sourcePrompt.indexOf(marker);
  const nextMarker = `PAGE ${String(order + 1).padStart(2, '0')} |`;
  const end =
    order === GOLDEN_DECK_EXPECTED_PAGES.length
      ? sourcePrompt.length
      : sourcePrompt.indexOf(nextMarker);

  expect(start, `missing declaration for page ${order}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing boundary after page ${order}`).toBeGreaterThan(start);
  return sourcePrompt.slice(start, end);
}

function scorePromptCoverage(sourcePrompt: string) {
  return GOLDEN_DECK_CAPABILITY_RUBRIC.map((dimension) => {
    const matchedSignals = dimension.requiredSignals.filter((signal) =>
      sourcePrompt.includes(signal),
    );
    const score = (matchedSignals.length / dimension.requiredSignals.length) * dimension.weight;
    return {
      id: dimension.id,
      matchedSignals,
      score,
      weight: dimension.weight,
    };
  });
}

describe('Reach Deck Golden Deck benchmark fixture', () => {
  it('locks the exact 10-page order with eight slides, an interactive activity, and a quiz', () => {
    const expectedSequence = GOLDEN_DECK_EXPECTED_PAGES.map(({ order, sceneType, title }) => ({
      order,
      sceneType,
      title,
    }));
    const parsedSequence = parsePageDeclarations(GOLDEN_DECK_TEACHER_SOURCE_PROMPT);

    expect(parsedSequence).toEqual(expectedSequence);
    expect(parsedSequence.filter(({ sceneType }) => sceneType === 'slide')).toHaveLength(8);
    expect(parsedSequence.map(({ sceneType }) => sceneType)).toEqual([
      'slide',
      'slide',
      'slide',
      'slide',
      'slide',
      'slide',
      'interactive',
      'quiz',
      'slide',
      'slide',
    ]);
  });

  it('gives every page a local, testable capability contract', () => {
    for (const page of GOLDEN_DECK_EXPECTED_PAGES) {
      const section = pageSection(GOLDEN_DECK_TEACHER_SOURCE_PROMPT, page.order);
      expect(section).toContain(page.title);
      for (const signal of page.requiredSignals) expect(section).toContain(signal);
    }
  });

  it('expresses quiz placement and intent without an upstream question count', () => {
    const quizSection = pageSection(GOLDEN_DECK_TEACHER_SOURCE_PROMPT, 8);

    expect(quizSection).toContain('安排一次');
    expect(quizSection).toContain('题目数量和题型由下游生成合同决定');
    expect(quizSection).not.toMatch(/生成\s*\d+\s*道/u);
    expect(quizSection).not.toContain('一道单选题');
    expect(quizSection).not.toContain('一道多选题');
  });

  it('scores full coverage across the weighted teacher-authoring dimensions', () => {
    const results = scorePromptCoverage(GOLDEN_DECK_TEACHER_SOURCE_PROMPT);

    expect(GOLDEN_DECK_CAPABILITY_RUBRIC.map(({ id }) => id)).toEqual([
      'audience',
      'objectives',
      'information-density',
      'media',
      'animation-and-narration',
      'interactive',
      'quiz',
    ]);
    expect(results.reduce((total, result) => total + result.weight, 0)).toBe(100);
    expect(results.reduce((total, result) => total + result.score, 0)).toBe(100);
    for (const result of results) {
      const dimension = GOLDEN_DECK_CAPABILITY_RUBRIC.find(({ id }) => id === result.id);
      expect(result.matchedSignals, `${result.id} benchmark coverage`).toEqual(
        dimension?.requiredSignals,
      );
    }
  });

  it('is a complete offline fixture without unresolved placeholders or external URLs', () => {
    expect(GOLDEN_DECK_TEACHER_SOURCE_PROMPT).toContain('教学假设');
    expect(GOLDEN_DECK_TEACHER_SOURCE_PROMPT).not.toMatch(/https?:\/\//u);
    expect(GOLDEN_DECK_TEACHER_SOURCE_PROMPT).not.toMatch(/TODO|TBD|\[[^\]]+\]/u);
  });
});
