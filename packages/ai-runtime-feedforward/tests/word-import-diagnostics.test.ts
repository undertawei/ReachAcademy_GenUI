import { describe, expect, it } from 'vitest';
import rawFixtures from './fixtures/word-import-validation.json';
import registry from './fixtures/word-import-diagnostic-registry.json';
import {
  adaptLegacyWordDiagnostic,
  boundWordDiagnosticMetadata,
  boundedWordDiagnosticText,
  createWordDiagnostic,
  mergeWordDiagnosticMetadata,
  projectWordSourceExcerpts,
  readWordDiagnostic,
  WORD_IMPORT_DIAGNOSTIC_REGISTRY,
  WORD_IMPORT_DIAGNOSTIC_LIMITS,
  WORD_IMPORT_DIAGNOSTIC_VERSION,
  wordDiagnosticIdentity,
  type ImportDiagnostic,
  type WordDiagnosticMetadata,
} from '../src/word-import/diagnostics.js';
import {
  evaluateWordImportDiagnostics,
  summarizeWordImport,
  validateWordImportQuestions,
} from '../src/word-import/validation.js';

interface FixtureQuestion extends Record<string, unknown> {
  options?: Array<{ value: string; label: unknown; wordImportItemId?: string }>;
  sub_problems?: FixtureQuestion[];
}
const fixtures = rawFixtures as {
  cases: Array<{ name: string; questions: FixtureQuestion[]; expectedCodes: string[] }>;
};
const valid = () => structuredClone(fixtures.cases[0].questions);
const diagnostic = (overrides: Partial<ImportDiagnostic> = {}): ImportDiagnostic =>
  createWordDiagnostic({
    code: 'word-import.invalid-answer-reference',
    severity: 'error',
    phase: 'parse',
    target: { kind: 'field', questionId: 'q1', field: { kind: 'answer' } },
    blocksApply: true,
    recovery: 'cleared-field',
    ...overrides,
  });
const metadata = (overrides: Partial<WordDiagnosticMetadata> = {}): WordDiagnosticMetadata => ({
  diagnosticVersion: WORD_IMPORT_DIAGNOSTIC_VERSION,
  fieldDiagnostics: [],
  unresolvedItems: [],
  sourceExcerpts: [],
  diagnosticsTruncated: false,
  ...overrides,
});

describe('raw native validation shared with Java', () => {
  for (const fixture of fixtures.cases)
    it(fixture.name, () => {
      const original = structuredClone(fixture.questions);
      const diagnostics = validateWordImportQuestions(fixture.questions);
      expect([...new Set(diagnostics.map((d) => d.code))].sort()).toEqual(
        [...fixture.expectedCodes].sort(),
      );
      expect(fixture.questions).toEqual(original);
      for (const d of diagnostics)
        expect(readWordDiagnostic(JSON.parse(JSON.stringify(d)))).toEqual(d);
    });
  it('shares the complete clearance registry with Java', () => {
    expect(registry.diagnosticVersion).toBe(WORD_IMPORT_DIAGNOSTIC_VERSION);
    expect(
      Object.fromEntries(registry.rules.map((r) => [r.code, { clearance: r.clearance }])),
    ).toEqual(WORD_IMPORT_DIAGNOSTIC_REGISTRY);
  });
  it('covers every current native-field validation code in the shared corpus', () => {
    expect([...new Set(fixtures.cases.flatMap((f) => f.expectedCodes))].sort()).toEqual(
      [
        'invalid-question',
        'unsupported-question-type',
        'missing-points',
        'invalid-points',
        'invalid-rich-text',
        'empty-question',
        'missing-options',
        'invalid-options',
        'empty-option',
        'invalid-answer-reference',
        'blank-answer-count',
        'single-answer-count',
        'cloze-root-pool',
        'unexpected-options',
        'missing-pool-policy',
        'unexpected-pool-policy',
        'invalid-answer',
        'unexpected-blanks',
        'missing-blanks',
        'missing-blank-reference',
        'invalid-blank-identity',
        'unexpected-blank-pool',
        'reused-pool-answer',
        'has-answer-mismatch',
        'invalid-children',
      ]
        .map((code) => `word-import.${code}`)
        .sort(),
    );
  });
  it('keeps field identity through option reordering and relabeling', () => {
    const fixture = structuredClone(fixtures.cases.find((f) => f.name === 'empty-option')!);
    const q = fixture.questions[0];
    q.options!.reverse().forEach((option, i) => {
      option.value = String.fromCharCode(65 + i);
    });
    const issue = validateWordImportQuestions(fixture.questions).find(
      (d) => d.code === 'word-import.empty-option',
    );
    expect(issue?.target).toMatchObject({ field: { kind: 'options', itemId: 'option-b' } });
  });
  it('accepts trusted source media only with the explicit parser-preview option', () => {
    const q = valid();
    q[0].question = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'image', attrs: { sourceMediaId: 'media1' } }] },
      ],
    };
    expect(validateWordImportQuestions(q).map((d) => d.code)).toContain(
      'word-import.invalid-rich-text',
    );
    expect(validateWordImportQuestions(q, { allowSourceMedia: true })).toEqual([]);
  });
});
describe('history and current edits', () => {
  it('retains immutable history and toggles repair after undo', () => {
    const q = valid(),
      history = [diagnostic()],
      original = structuredClone(history);
    expect(evaluateWordImportDiagnostics(q, history).canApply).toBe(true);
    q[0].answer = [];
    q[0].has_answer = false;
    expect(evaluateWordImportDiagnostics(q, history).history[0].status).toBe('pending');
    q[0].points = 5;
    expect(evaluateWordImportDiagnostics(q, history).canApply).toBe(false);
    expect(history).toEqual(original);
  });
  it('permits missing original answer, but not a forged has_answer', () => {
    const q = valid();
    q[0].answer = [];
    q[0].has_answer = false;
    expect(
      evaluateWordImportDiagnostics(q, [
        diagnostic({ code: 'word-import.missing-answer', blocksApply: false }),
      ]).canApply,
    ).toBe(true);
    q[0].has_answer = true;
    expect(evaluateWordImportDiagnostics(q, []).canApply).toBe(false);
  });
  it('permits complete manual type conversion with a nonempty answer', () => {
    const q = fixtures.cases.find((f) => f.name === 'valid-short_answer')!.questions;
    expect(evaluateWordImportDiagnostics(q, [diagnostic()]).canApply).toBe(true);
  });
  it('clears the exact repaired blank while other original missing answers remain permitted', () => {
    const q = structuredClone(
      fixtures.cases.find((f) => f.name === 'valid-shared-repeat')!.questions,
    );
    const blanks = q[0].blanks as Array<Record<string, unknown>>;
    blanks[1].answer = [];
    q[0].has_answer = false;
    const d = diagnostic({
      target: {
        kind: 'field',
        questionId: 'q1',
        field: { kind: 'blanks', blankId: 'b1', part: 'answer' },
      },
    });
    expect(evaluateWordImportDiagnostics(q, [d]).canApply).toBe(true);
    blanks[0].answer = [];
    blanks[1].answer = ['A'];
    expect(evaluateWordImportDiagnostics(q, [d]).canApply).toBe(false);
  });
  it('clears histories by stable item identity and independently of history order', () => {
    const q = structuredClone(fixtures.cases.find((f) => f.name === 'empty-option')!.questions);
    const a = diagnostic({
      id: 'a',
      code: 'word-import.empty-option',
      target: { kind: 'field', questionId: 'q1', field: { kind: 'options', itemId: 'option-a' } },
    });
    const b = diagnostic({
      id: 'b',
      code: 'word-import.empty-option',
      target: { kind: 'field', questionId: 'q1', field: { kind: 'options', itemId: 'option-b' } },
    });
    const expected = [
      { diagnosticId: 'a', status: 'resolved' },
      { diagnosticId: 'b', status: 'pending' },
    ];
    expect(evaluateWordImportDiagnostics(q, [a, b]).history).toEqual(expected);
    expect(evaluateWordImportDiagnostics(q, [b, a]).history.reverse()).toEqual(expected);
  });
  it('keeps review warnings as pending evidence without gating the append', () => {
    const d = diagnostic({
      code: 'word-import.uncertain-block',
      target: { kind: 'unresolved', itemId: 'u1' },
      blocksApply: false,
    });
    const result = evaluateWordImportDiagnostics(valid(), [d]);
    expect(result.history[0].status).toBe('pending');
    expect(result.canApply).toBe(true);
  });
  it('excludes deleted descendants without ignoring selected descendants', () => {
    const q = structuredClone(
      fixtures.cases.find((f) => f.name === 'valid-parent-material-from-child')!.questions,
    );
    const d = diagnostic({
      target: { kind: 'field', questionId: 'child', field: { kind: 'answer' } },
    });
    q[0].sub_problems![0].answer = [];
    q[0].sub_problems![0].has_answer = false;
    expect(evaluateWordImportDiagnostics(q, [d]).canApply).toBe(false);
    expect(evaluateWordImportDiagnostics(valid(), [d]).history[0].status).toBe('excluded');
  });
  it('fails closed on unknown blocking codes, versions and document truncation', () => {
    expect(
      evaluateWordImportDiagnostics(valid(), [
        diagnostic({ code: 'future-code' as ImportDiagnostic['code'] }),
      ]).canApply,
    ).toBe(false);
    expect(
      evaluateWordImportDiagnostics(valid(), [], { diagnosticVersion: 'future' }).canApply,
    ).toBe(false);
    expect(
      evaluateWordImportDiagnostics(valid(), [
        diagnostic({ code: 'word-import.diagnostics-truncated', target: { kind: 'document' } }),
      ]).canApply,
    ).toBe(false);
  });
  it('reports unresolved source items without gating the append', () => {
    const item = {
      id: 'u1',
      kind: 'unassigned' as const,
      code: 'word-import.unassigned-range' as const,
      sourceRanges: [{ blockId: 'p1' }],
    };
    const result = evaluateWordImportDiagnostics(valid(), [
      diagnostic({
        code: 'word-import.unassigned-range',
        target: { kind: 'unresolved', itemId: 'u1' },
        blocksApply: true,
      }),
    ]);
    expect(result.canApply).toBe(true);
    expect(summarizeWordImport(valid(), result, [item])).toMatchObject({
      recognizedItems: 1,
      unassignedParagraphs: 1,
      unresolvedItems: 0,
    });
  });
});
describe('wire contracts, bounded projection and merge', () => {
  it('keeps all bounded arbitrary text well formed at astral-character boundaries', () => {
    const text = 'x'.repeat(239) + '𠮷𝑥😀';
    const d = diagnostic({ params: { text, values: [text] } });
    const excerpts = projectWordSourceExcerpts(
      [{ id: 'p', content: [{ type: 'text', text }] }],
      [{ blockId: 'p' }],
    );
    const bounded = boundWordDiagnosticMetadata(
      metadata({ sourceExcerpts: [{ range: { blockId: 'p' }, text, excerptTruncated: false }] }),
    );
    const legacy = adaptLegacyWordDiagnostic({
      code: 'word-import.invalid-answer-reference',
      severity: 'error',
      sourceAnswer: text,
    });
    for (const value of [
      d.params.text,
      (d.params.values as string[])[0],
      excerpts[0].text,
      bounded.sourceExcerpts[0].text,
      legacy.params.sourceAnswer,
    ]) {
      expect(value).toBe('x'.repeat(239));
      expect(String(value)).not.toMatch(/[\uD800-\uDFFF]/);
    }
    expect(excerpts[0].excerptTruncated).toBe(true);
    expect(bounded.sourceExcerpts[0].excerptTruncated).toBe(true);
    expect(boundedWordDiagnosticText('𠮷', 2)).toBe('𠮷');
    expect(boundedWordDiagnosticText('\uDC00bad\uD800text')).toBe('\uFFFDbad\uFFFDtext');
  });
  it('keeps document field-clearance blockers pending while unresolved targets stay informational', () => {
    const d = diagnostic({ code: 'word-import.media-unavailable', target: { kind: 'document' } });
    expect(evaluateWordImportDiagnostics(valid(), [d]).canApply).toBe(false);
    const warning = diagnostic({
      code: 'word-import.unassigned-range',
      target: { kind: 'unresolved', itemId: 'u' },
      blocksApply: false,
    });
    expect(evaluateWordImportDiagnostics(valid(), [warning]).canApply).toBe(true);
  });
  it('bounds question count and depth with wire-readable diagnostics', () => {
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({ ...valid()[0], id: `q${i}` }));
    const nested = valid();
    let parent = nested[0];
    for (let i = 0; i < 13; i++) {
      const child = { ...valid()[0], id: `child${i}` };
      parent.sub_problems = [child];
      parent = child;
    }
    for (const questions of [tooMany, nested]) {
      const diagnostics = validateWordImportQuestions(questions);
      expect(diagnostics.map((d) => d.code)).toContain('word-import.invalid-question');
      for (const d of diagnostics)
        expect(readWordDiagnostic(JSON.parse(JSON.stringify(d)))).toEqual(d);
    }
  });
  it('uses deterministic identities across serialization and object-key order', () => {
    expect(wordDiagnosticIdentity({ b: 2, a: 1 })).toBe(wordDiagnosticIdentity({ a: 1, b: 2 }));
    expect(readWordDiagnostic(JSON.parse(JSON.stringify(diagnostic())))).toEqual(diagnostic());
    expect(wordDiagnosticIdentity('segment-one', 'q1')).not.toBe(
      wordDiagnosticIdentity('segment-two', 'q1'),
    );
  });
  it('rejects malformed targets/ranges and adapts unknown codes without dropping blocksApply', () => {
    expect(() =>
      readWordDiagnostic({
        ...diagnostic(),
        target: { kind: 'field', questionId: 'q1', field: { kind: 'question_invalid' } },
      }),
    ).toThrow('invalid-diagnostic');
    expect(() =>
      readWordDiagnostic({ ...diagnostic(), sourceRanges: [{ blockId: 'p', start: -1 }] }),
    ).toThrow('invalid-diagnostic');
    expect(readWordDiagnostic({ ...diagnostic(), code: 'future' })).toMatchObject({
      code: 'word-import.unknown-diagnostic',
      blocksApply: true,
      params: { originalCode: 'future' },
    });
  });
  it('adapts legacy display without modifying the artifact', () => {
    const old = {
      code: 'word-import.invalid-answer-reference',
      severity: 'error' as const,
      questionId: 'q1',
      sourceAnswer: 'A'.repeat(300),
    };
    const adapted = adaptLegacyWordDiagnostic(old);
    expect(adapted.params.sourceAnswer).toHaveLength(240);
    expect(adapted.params.sourceUnavailable).toBe(true);
    expect(old.sourceAnswer).toHaveLength(300);
  });
  it('projects safe text only from supplied trusted blocks with bounded UTF-16 offsets', () => {
    const blocks = [
      { id: 'p1', content: [{ type: 'text', text: '<img onerror=alert(1)>'.repeat(30) }] },
    ];
    const excerpt = projectWordSourceExcerpts(blocks, [{ blockId: 'p1' }])[0];
    expect(excerpt.text).toHaveLength(240);
    expect(excerpt.excerptTruncated).toBe(true);
    expect(() => projectWordSourceExcerpts(blocks, [{ blockId: 'other' }])).toThrow(
      'unknown-block',
    );
    expect(() => projectWordSourceExcerpts(blocks, [{ blockId: 'p1', end: 9999 }])).toThrow(
      'invalid-range',
    );
    expect(
      projectWordSourceExcerpts(blocks, Array(9).fill({ blockId: 'p1', start: 0, end: 240 })),
    ).toHaveLength(8);
    expect(
      projectWordSourceExcerpts(blocks, [{ blockId: 'p1', start: 0, end: 240 }])[0]
        .excerptTruncated,
    ).toBe(false);
  });
  it('enforces the byte budget with realistic default diagnostic identities', () => {
    const input = metadata({
      fieldDiagnostics: Array.from({ length: WORD_IMPORT_DIAGNOSTIC_LIMITS.count }, (_, i) =>
        diagnostic({
          target: {
            kind: 'field',
            questionId: `wi-${i.toString(16).padStart(64, '0')}`,
            field: { kind: 'answer' },
          },
          sourceRanges: [
            { blockId: `source-${i}`, start: 0, end: 100 },
            { blockId: `answer-${i}`, start: 0, end: 20 },
          ],
        }),
      ),
    });
    const bounded = boundWordDiagnosticMetadata(input);
    expect(bounded.diagnosticsTruncated).toBe(true);
    expect(bounded.fieldDiagnostics.length).toBeLessThan(WORD_IMPORT_DIAGNOSTIC_LIMITS.count);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(
      WORD_IMPORT_DIAGNOSTIC_LIMITS.bytes,
    );
    expect(bounded.fieldDiagnostics.at(-1)).toMatchObject({
      code: 'word-import.diagnostics-truncated',
      blocksApply: true,
    });
  });
  it('enforces the count boundary when default identities fit the byte budget', () => {
    const fieldDiagnostics = Array.from({ length: WORD_IMPORT_DIAGNOSTIC_LIMITS.count }, (_, i) =>
      diagnostic({ target: { kind: 'document' }, params: { ordinal: i } }),
    );
    expect(boundWordDiagnosticMetadata(metadata({ fieldDiagnostics })).diagnosticsTruncated).toBe(
      false,
    );
    fieldDiagnostics.push(diagnostic({ target: { kind: 'document' } }));
    const result = boundWordDiagnosticMetadata(metadata({ fieldDiagnostics }));
    expect(result.fieldDiagnostics).toHaveLength(WORD_IMPORT_DIAGNOSTIC_LIMITS.count);
    expect(result.diagnosticsTruncated).toBe(true);
  });
  it('bounds all metadata under 1 MiB and prevents unresolved-overflow success', () => {
    const input = metadata({
      unresolvedItems: Array.from({ length: 10000 }, (_, i) => ({
        id: `u${i}`,
        kind: 'question',
        code: 'word-import.question-parse-failed',
        sourceRanges: Array.from({ length: 20 }, (_, j) => ({
          blockId: `block${j}`,
          start: 0,
          end: 900,
        })),
      })),
    });
    const bounded = boundWordDiagnosticMetadata(input);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(bounded.diagnosticsTruncated).toBe(true);
    expect(evaluateWordImportDiagnostics(valid(), bounded.fieldDiagnostics).canApply).toBe(false);
  });
  it('deduplicates same identity, rejects collisions and mixed protocol versions', () => {
    const part = metadata({ fieldDiagnostics: [diagnostic()] });
    expect(
      mergeWordDiagnosticMetadata([part, structuredClone(part)]).fieldDiagnostics,
    ).toHaveLength(1);
    expect(() =>
      mergeWordDiagnosticMetadata([part, metadata({ diagnosticVersion: 'old' })]),
    ).toThrow('unsupported-diagnostic-version');
    expect(() =>
      mergeWordDiagnosticMetadata([
        part,
        metadata({ fieldDiagnostics: [{ ...diagnostic(), blocksApply: false }] }),
      ]),
    ).toThrow('diagnostic-identity-conflict');
  });
});
