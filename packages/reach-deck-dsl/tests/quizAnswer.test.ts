import { describe, expect, it } from 'vitest';

import {
  isCompleteQuestionAnswer,
  parseQuestionAnswerValue,
  richTextFromPlainText,
} from '../src/index.js';

describe('parseQuestionAnswerValue', () => {
  it('normalizes selection answers to the discriminated runtime contract', () => {
    expect(parseQuestionAnswerValue(['A', 'C', 'A'], 'multiple_choice')).toEqual({
      kind: 'selection',
      values: ['A', 'C'],
    });
    expect(parseQuestionAnswerValue({ kind: 'selection', values: ['B'] }, 'single_choice')).toEqual(
      { kind: 'selection', values: ['B'] },
    );
  });

  it('upgrades legacy typed answers to rich text', () => {
    expect(parseQuestionAnswerValue('解释', 'short_answer')).toEqual({
      kind: 'rich_text',
      document: richTextFromPlainText('解释'),
      attachments: [],
    });
  });

  it('keeps stable attachment metadata on short answers', () => {
    expect(
      parseQuestionAnswerValue(
        {
          kind: 'rich_text',
          document: richTextFromPlainText('见附件'),
          attachments: [
            {
              assetId: 'asset-1',
              contentType: 'application/pdf',
              name: 'proof.pdf',
              objectKey: 'org/student-deck/proof.pdf',
              order: 4,
              sizeBytes: 1_024,
            },
          ],
        },
        'short_answer',
      ),
    ).toEqual({
      kind: 'rich_text',
      document: richTextFromPlainText('见附件'),
      attachments: [
        {
          assetId: 'asset-1',
          contentType: 'application/pdf',
          name: 'proof.pdf',
          objectKey: 'org/student-deck/proof.pdf',
          order: 0,
          sizeBytes: 1_024,
        },
      ],
    });
  });

  it('rejects legacy question-wide fill answers instead of upgrading them', () => {
    expect(() =>
      parseQuestionAnswerValue(
        {
          kind: 'rich_text',
          document: richTextFromPlainText('answer'),
          attachments: [
            {
              contentType: 'text/plain',
              name: 'answer.txt',
              objectKey: 'org/student-deck/answer.txt',
              order: 0,
              sizeBytes: 3,
            },
          ],
        },
        'fill_in_the_blank',
      ),
    ).toThrow(/fill_blanks v1/i);
    expect(() =>
      parseQuestionAnswerValue({ kind: 'selection', values: ['A'] }, 'fill_with_candidates'),
    ).toThrow(/fill_blanks v1/i);
  });

  it('parses the answer-local per-blank fill contract', () => {
    expect(
      parseQuestionAnswerValue(
        {
          kind: 'fill_blanks',
          version: 1,
          blanks: [
            {
              blankId: 'force',
              answer: { kind: 'rich_text', document: richTextFromPlainText('F=ma') },
            },
          ],
        },
        'fill_in_the_blank',
      ),
    ).toEqual({
      kind: 'fill_blanks',
      version: 1,
      blanks: [
        {
          blankId: 'force',
          answer: { kind: 'rich_text', document: richTextFromPlainText('F=ma') },
        },
      ],
    });
  });
});

describe('isCompleteQuestionAnswer', () => {
  it('requires every canonical blank id to have one complete response', () => {
    const answer = {
      kind: 'fill_blanks' as const,
      version: 1 as const,
      blanks: [
        { blankId: 'b1', answer: { kind: 'selection' as const, values: ['A'] } },
        { blankId: 'b2', answer: { kind: 'selection' as const, values: ['B'] } },
      ],
    };
    expect(isCompleteQuestionAnswer(answer, ['b1', 'b2'])).toBe(true);
    expect(isCompleteQuestionAnswer(answer, ['b1', 'b3'])).toBe(false);
  });
  it('treats formulas and asset-backed images as complete rich-text answers', () => {
    expect(
      isCompleteQuestionAnswer({
        kind: 'rich_text',
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'inlineMath', attrs: { latex: 'x^2' } }],
            },
          ],
        },
        attachments: [],
      }),
    ).toBe(true);
    expect(
      isCompleteQuestionAnswer({
        kind: 'rich_text',
        document: {
          type: 'doc',
          content: [
            {
              type: 'image',
              attrs: { objectKey: 'org/student-deck/diagram.png' },
            },
          ],
        },
        attachments: [],
      }),
    ).toBe(true);
  });

  it('treats an attachment-only short answer as complete', () => {
    expect(
      isCompleteQuestionAnswer({
        kind: 'rich_text',
        document: richTextFromPlainText(''),
        attachments: [
          {
            contentType: 'application/pdf',
            name: 'work.pdf',
            objectKey: 'org/student-deck/work.pdf',
            order: 0,
            sizeBytes: 10,
          },
        ],
      }),
    ).toBe(true);
  });
});
