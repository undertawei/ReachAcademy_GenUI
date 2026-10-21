import { describe, expect, it } from 'vitest';
import { richTextFromPlainText, richTextToPlainText } from '@reachany/reach-deck-dsl';
import { mapMaicToReachDeckV2, parseMaicCourse } from '../src/maic/index.js';

function mapQuestion(question: Record<string, unknown>) {
  const parsed = parseMaicCourse(
    JSON.stringify({
      title: 'Quiz fixture',
      width: 1280,
      height: 720,
      slides: [{ id: 'quiz', component_type: 'quiz', questions: [question], elements: [] }],
    }),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const mapped = mapMaicToReachDeckV2(parsed.ir, {
    documentId: 'quiz-fixture',
    applicationId: 'quiz-fixture',
    title: 'Quiz fixture',
    language: 'en-US',
    generatedAt: '2026-09-08T00:00:00Z',
    compatibilityTheme: {
      name: 'Fixture',
      background: '#FFFFFF',
      surface: '#FFFFFF',
      ink: '#000000',
      muted: '#666666',
      accent: '#FF0000',
      success: '#008000',
      warning: '#FF8800',
      fontDisplay: 'Noto Sans',
      fontBody: 'Noto Sans',
    },
  });
  if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
  expect(mapped.diagnostics).toEqual([]);
  const page = mapped.document.pages[0]!;
  if (page.sceneType !== 'quiz') throw new Error('Expected quiz page');
  return page.scene.content.questions[0]!;
}

describe('MAIC quiz rich text fidelity', () => {
  it('retains question and option formatting without changing selection answer values', () => {
    const question = mapQuestion({
      question_type: 'single_choice',
      question: '<p>Choose <strong>one</strong> &amp; explain.</p>',
      options: [
        { value: 'A', label: '<p><em>First</em><br>line</p>' },
        { value: 'B', label: '<p>Second</p>' },
      ],
      answer: ['A'],
      hasAnswer: true,
    });
    expect(richTextToPlainText(question.question)).toBe('Choose one & explain.');
    expect(question.question.content?.[0]?.content?.[1]).toMatchObject({
      text: 'one',
      marks: expect.arrayContaining([{ type: 'bold' }]),
    });
    expect(question.options?.[0]?.label.content?.[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'First',
          marks: expect.arrayContaining([{ type: 'italic' }]),
        }),
        { type: 'hardBreak' },
      ]),
    );
    expect(question.options?.map((option) => option.value)).toEqual(['A', 'B']);
    expect(question.answer).toEqual(['A']);
    expect(question.has_answer).toBe(true);
  });

  it('keeps rubric paragraphs and styles for ungraded short answers', () => {
    const question = mapQuestion({
      question_type: 'short_answer',
      question: '<p>Explain the contrast.</p>',
      answer: [],
      hasAnswer: false,
      analysis:
        '<p>Explanation.</p><p><br></p><p style="line-height:1.5;text-align:center;color:#FF0000">Level one.</p>',
      cognitive_schema: '<p><u>Compare</u> the images.</p>',
    });
    expect(question.has_answer).toBe(false);
    expect(question.answer).toEqual(richTextFromPlainText(''));
    expect(question.analysis.content).toHaveLength(3);
    expect(question.analysis.content?.[2]).toMatchObject({
      attrs: { lineHeight: 1.5, textAlign: 'center' },
      content: [
        { text: 'Level one.', marks: [{ type: 'textStyle', attrs: { color: '#FF0000' } }] },
      ],
    });
    expect(question.cognitive_schema.content?.[0]?.content?.[0]).toMatchObject({
      text: 'Compare',
      marks: expect.arrayContaining([{ type: 'underline' }]),
    });
  });

  it('parses reference and blank answers while preserving plain text newlines and comparisons', () => {
    const plain = 'Explain why a<b and n<max.\nThen compare x < 3 and y > 4.';
    const question = mapQuestion({
      question_type: 'short_answer',
      question: plain,
      answer: ['<p>First <strong>reason</strong>.</p><p>Second reason.</p>'],
      analysis: 'First line.\nSecond line.',
    });
    expect(question.question).toEqual(richTextFromPlainText(plain));
    expect(question.analysis).toEqual(richTextFromPlainText('First line.\nSecond line.'));
    if (Array.isArray(question.answer)) throw new Error('Expected rich text answer');
    expect(richTextToPlainText(question.answer)).toBe('First reason.\nSecond reason.');
    expect(question.has_answer).toBe(true);

    const fill = mapQuestion({
      question_type: 'fill_in_the_blank',
      question: 'Name the color: ____',
      answer: ['<p><strong>red</strong></p>'],
    });
    const blankAnswer = fill.blanks?.[0]?.answer;
    if (!blankAnswer || Array.isArray(blankAnswer)) throw new Error('Expected blank rich text');
    expect(richTextToPlainText(blankAnswer)).toBe('red');
  });

  it('drops executable markup from every rich text field', () => {
    const unsafe =
      '<p onclick="alert(1)">Safe<script>alert(1)</script><iframe src="https://example.com"></iframe></p>';
    const question = mapQuestion({
      question_type: 'short_answer',
      question: unsafe,
      answer: [unsafe],
      analysis: unsafe,
      cognitive_schema: unsafe,
    });
    for (const field of [
      question.question,
      question.answer,
      question.analysis,
      question.cognitive_schema,
    ]) {
      if (Array.isArray(field)) throw new Error('Expected rich text');
      expect(richTextToPlainText(field)).toBe('Safe');
      expect(JSON.stringify(field)).not.toMatch(/alert|iframe|onclick|https:/);
    }
  });
});
