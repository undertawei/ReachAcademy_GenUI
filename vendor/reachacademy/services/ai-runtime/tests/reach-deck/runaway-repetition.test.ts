import { describe, expect, it } from 'vitest';

import {
  RUNAWAY_REPETITION_MIN_RUN_CHARS,
  RUNAWAY_REPETITION_STREAM_WINDOW_CHARS,
  describeRunawayRepetition,
  detectRunawayRepetition,
  detectTrailingRunawayRepetition,
} from '../../lib/reach-deck/runaway-repetition.js';

/** Trimmed synthetic copy of the real quiz loop (page-9eb3fa24, ~100 KB before truncation). */
function runawayQuizContent(repeats = 600): string {
  const head =
    '{"schemaVersion":"reach-quiz-scene/v1","sceneType":"quiz","content":{"questions":[{' +
    '"question_type":"fill_in_the_blank","question":"水平的轴叫____，竖直的轴叫____。",' +
    '"answer_components":[{"id":"ac1-horizontal-axis","answer":"横轴；水平的轴叫横轴。|blank1|横轴' +
    '|blank1|水平方向的轴是横轴。|blank1|横坐标轴|blank1|x轴|blank1|horizontal axis';
  return head + '|blank1|横轴。'.repeat(repeats) + '|blank1|横轴';
}

describe('runaway repetition detector', () => {
  it('flags the truncated quiz answer loop with its smallest repeating unit', () => {
    const content = runawayQuizContent();
    const found = detectRunawayRepetition(content);
    expect(found).toBeDefined();
    expect(found!.unit.length).toBe('|blank1|横轴。'.length);
    expect('|blank1|横轴。'.repeat(2)).toContain(found!.unit);
    expect(found!.repeats).toBeGreaterThanOrEqual(599);
    expect(found!.length).toBeGreaterThanOrEqual(RUNAWAY_REPETITION_MIN_RUN_CHARS);
    expect(content.slice(found!.start, found!.start + found!.length)).toBe(
      found!.unit.repeat(found!.repeats) +
        found!.unit.slice(0, found!.length - found!.unit.length * found!.repeats),
    );

    const detail = describeRunawayRepetition(found!);
    expect(detail).toContain('runaway repetition loop');
    expect(detail).toContain(JSON.stringify(found!.unit));
    expect(detail.length).toBeLessThan(400);
    expect(detail).not.toContain('shown above');
  });

  it('flags a loop that alternates between two phrases as one longer unit', () => {
    const content = '{"answer":"' + '横轴。|blank1|horizontal axis|blank1|'.repeat(200) + '"}';
    const found = detectRunawayRepetition(content);
    expect(found?.unit.length).toBe('横轴。|blank1|horizontal axis|blank1|'.length);
  });

  it('does not flag long varied teaching text', () => {
    const lines: string[] = [];
    for (let step = 1; step <= 400; step += 1) {
      lines.push(
        `第${step}步：点 \\\\((${step},${(step * 7) % 13})\\\\) 从原点向右移动${step}个单位，` +
          `再向上移动${(step * 7) % 13}个单位；读作横坐标${step}、纵坐标${(step * 7) % 13}。`,
      );
    }
    const content = JSON.stringify({ analysis: lines.join('\\n') });
    expect(content.length).toBeGreaterThan(20_000);
    expect(detectRunawayRepetition(content)).toBeUndefined();
  });

  it('does not flag legitimately repeated short lists below the threshold', () => {
    const accepted = '|blank1|横轴|blank1|x轴|blank1|横坐标轴'.repeat(8);
    const table = '<tr><td></td><td></td><td></td></tr>'.repeat(60);
    const content =
      JSON.stringify({ answer: accepted, html: table, rule: '—'.repeat(200) }) +
      ' '.repeat(RUNAWAY_REPETITION_MIN_RUN_CHARS * 2);
    expect(detectRunawayRepetition(content)).toBeUndefined();
    expect(detectRunawayRepetition('|blank1|横轴。'.repeat(300))).toBeUndefined();
  });

  it('finds a loop in the streaming tail window and reports offsets in the full content', () => {
    const varied = Array.from({ length: 800 }, (_, index) => `第${index}步：横坐标${index}。`).join(
      '',
    );
    const content = varied + '|blank1|横轴。'.repeat(700);
    expect(content.length).toBeGreaterThan(RUNAWAY_REPETITION_STREAM_WINDOW_CHARS * 2);
    const found = detectTrailingRunawayRepetition(content);
    expect(found).toBeDefined();
    // The varied text ends with 。, which the periodic run may absorb as its first unit character.
    expect(found!.start).toBeGreaterThanOrEqual(varied.length - found!.unit.length);
    expect(found!.start).toBeGreaterThanOrEqual(
      content.length - RUNAWAY_REPETITION_STREAM_WINDOW_CHARS,
    );
    expect(content.slice(found!.start, found!.start + found!.unit.length)).toBe(found!.unit);
    // A loop that has not yet reached the run threshold is not flagged.
    expect(detectTrailingRunawayRepetition(varied + '|blank1|横轴。'.repeat(300))).toBeUndefined();
    expect(detectTrailingRunawayRepetition(varied)).toBeUndefined();
  });
});
