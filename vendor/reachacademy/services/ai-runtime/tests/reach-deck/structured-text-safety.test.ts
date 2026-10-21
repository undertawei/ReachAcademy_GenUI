import { describe, expect, it } from 'vitest';
import {
  assertReachDeckStructuredTextSafe,
  assertReachDeckOutlineInputTextSafe,
  ReachDeckOutlineInputTextError,
  ReachDeckStructuredTextError,
} from '../../lib/reach-deck/structured-text-safety.js';

describe('fresh structured model text safety', () => {
  it('reports the exact nested knowledge atom without deleting invalid teaching text', () => {
    const value = { knowledgePlan: { points: [{ items: [{ content: 'fact\u0000after' }] }] } };
    const original = structuredClone(value);
    expect(() => assertReachDeckStructuredTextSafe(value)).toThrow(ReachDeckStructuredTextError);
    try {
      assertReachDeckStructuredTextSafe(value);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_STRUCTURED_TEXT',
        path: '$.knowledgePlan.points[0].items[0].content',
        character: 'U+0000',
      });
      expect(String(error)).not.toContain('fact');
    }
    expect(value).toEqual(original);
  });

  it.each([
    '\u0000',
    '\u0001',
    '\u0008',
    '\u000b',
    '\u000c',
    '\u001f',
    '\u007f',
    '\ud800',
    '\udfff',
  ])('rejects unsafe decoded text %j at the JSON boundary', (text) =>
    expect(() => assertReachDeckStructuredTextSafe({ text })).toThrow('$.text'),
  );

  it('preserves Unicode, formulas, formatting whitespace, and literal escape notation', () => {
    const value = {
      content: '讲解😀\t$\\theta = 45°$\n下一行\r\n文字 \\u0000',
      facts: [1, null, true],
    };
    const original = structuredClone(value);
    expect(() => assertReachDeckStructuredTextSafe(value)).not.toThrow();
    expect(value).toEqual(original);
  });

  it('checks property names and escapes non-identifier paths', () => {
    expect(() => assertReachDeckStructuredTextSafe({ 'bad\u0000key': 'text' })).toThrow(
      '$["bad\\u0000key"]',
    );
    expect(() => assertReachDeckStructuredTextSafe({ 'a.b': ['\ud800'] })).toThrow('$["a.b"][0]');
  });

  it('returns an actionable saved-outline preflight error without changing the source', () => {
    expect(() => assertReachDeckOutlineInputTextSafe({ request: { source: '\u0000' } })).toThrow(
      ReachDeckOutlineInputTextError,
    );
    expect(() => assertReachDeckOutlineInputTextSafe({ request: { source: '\u0000' } })).toThrow(
      'Regenerate the lesson plan in Step 2',
    );
  });
});
