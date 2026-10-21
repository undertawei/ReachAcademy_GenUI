import { describe, expect, it } from 'vitest';

import {
  REACH_DECK_SPEECH_BREAK_NODE_TYPE,
  REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
  canonicalizeReachDeckNarrationMarkdownOffsets,
  parseReachDeckNarrationSpeechDocument,
  serializeReachDeckNarrationSpeechDocument,
  type ReachDeckSpeechMarkupV1,
} from '../src/index.js';

describe('narration speech rich-text bridge', () => {
  it('normalizes empty boundary and interior paragraphs with speech offsets intact', () => {
    const source = parseReachDeckNarrationSpeechDocument('甲\n\nA\\-😀乙', {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [
        { type: 'break', at: 3, durationMs: 300 },
        { type: 'sub', from: 6, to: 9, alias: '表情乙' },
      ],
    });
    const document = {
      ...source,
      content: [
        { type: 'paragraph' },
        source.content![0]!,
        { type: 'paragraph' },
        { type: 'paragraph' },
        source.content![1]!,
        { type: 'paragraph' },
      ],
    };
    const value = serializeReachDeckNarrationSpeechDocument(document, { canonicalize: true });
    expect(value).toEqual(serializeReachDeckNarrationSpeechDocument(source));
    expect(
      serializeReachDeckNarrationSpeechDocument(
        parseReachDeckNarrationSpeechDocument(value.markdown, value.speechMarkup),
      ),
    ).toEqual(value);
  });

  it('maps redundant hard breaks while preserving single breaks and meaningful whitespace', () => {
    const source = '\n\n 甲\n乙\n\n\n\nA\\-😀\n\n';
    const normalized = canonicalizeReachDeckNarrationMarkdownOffsets(source);
    expect(normalized.markdown).toBe(' 甲\n乙\n\nA\\-😀');
    expect(normalized.offsets[source.indexOf('A')]).toBe(6);
    expect(normalized.offsets[source.indexOf('😀')]).toBe(9);
    expect(normalized.offsets[source.length]).toBe(normalized.markdown.length);
    expect(canonicalizeReachDeckNarrationMarkdownOffsets('甲\n')).toEqual({
      markdown: '甲\n',
      offsets: [0, 1, 2],
    });
  });

  it('does not trim formula contents or alter single-node serialization', () => {
    const formula = '\\[x +\ny\\]';
    expect(canonicalizeReachDeckNarrationMarkdownOffsets(`\n\n${formula}\n\n`).markdown).toBe(
      formula,
    );
    expect(
      serializeReachDeckNarrationSpeechDocument({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }],
      }),
    ).toEqual({ markdown: '\n' });
    expect(
      serializeReachDeckNarrationSpeechDocument(
        {
          type: 'doc',
          content: [{ type: 'paragraph' }, { type: 'paragraph' }],
        },
        { canonicalize: true },
      ),
    ).toEqual({ markdown: '' });
  });

  it('preserves whitespace-only paragraphs and outer spaces in ordinary narration', () => {
    const markdown = '  甲  \n\n \t \n\n 乙  ';
    const document = parseReachDeckNarrationSpeechDocument(markdown);
    expect(serializeReachDeckNarrationSpeechDocument(document, { canonicalize: true })).toEqual({
      markdown,
    });
    expect(canonicalizeReachDeckNarrationMarkdownOffsets(markdown)).toEqual({
      markdown,
      offsets: Array.from({ length: markdown.length + 1 }, (_, index) => index),
    });
  });

  it('remaps speech spans after repeated hard breaks without losing the following text', () => {
    const document = parseReachDeckNarrationSpeechDocument('甲\n\n乙', {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [{ type: 'sub', from: 3, to: 4, alias: '第二' }],
    });
    const value = serializeReachDeckNarrationSpeechDocument(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              ...document.content![0]!.content!,
              { type: 'hardBreak' },
              { type: 'hardBreak' },
              { type: 'hardBreak' },
              ...document.content![1]!.content!,
            ],
          },
        ],
      },
      { canonicalize: true },
    );
    expect(value).toEqual(serializeReachDeckNarrationSpeechDocument(document));
  });

  it('round-trips span and break annotations without putting tags in Markdown', () => {
    const markdown = '今天2026年发布。';
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [
        { type: 'break', at: 2, durationMs: 300 },
        { type: 'say-as', from: 2, to: 7, interpretAs: 'Date-Y' },
      ],
    };

    const document = parseReachDeckNarrationSpeechDocument(markdown, speechMarkup);

    expect(JSON.stringify(document)).toContain(REACH_DECK_SPEECH_BREAK_NODE_TYPE);
    expect(JSON.stringify(document)).toContain(REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE);
    expect(serializeReachDeckNarrationSpeechDocument(document)).toEqual({
      markdown,
      speechMarkup,
    });
  });

  it('derives offsets after Markdown escaping instead of storing editor positions', () => {
    const document = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A-' },
            {
              type: 'text',
              text: 'B',
              marks: [
                {
                  type: REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
                  attrs: { definition: { id: 'mark-1', type: 'sub', alias: 'bee' } },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(serializeReachDeckNarrationSpeechDocument(document)).toEqual({
      markdown: 'A\\-B',
      speechMarkup: {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [{ type: 'sub', from: 3, to: 4, alias: 'bee' }],
      },
    });
  });

  it('omits empty markup and preserves the historical plain document shape', () => {
    const document = parseReachDeckNarrationSpeechDocument('普通讲稿');
    expect(serializeReachDeckNarrationSpeechDocument(document)).toEqual({ markdown: '普通讲稿' });
  });

  it('loads multiple non-overlapping spans from one original text node', () => {
    const markdown = '甲乙丙丁';
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [
        { type: 'sub', from: 0, to: 1, alias: '第一' },
        { type: 'phoneme', from: 2, to: 3, alphabet: 'py', ph: 'bing3' },
      ],
    };
    expect(
      serializeReachDeckNarrationSpeechDocument(
        parseReachDeckNarrationSpeechDocument(markdown, speechMarkup),
      ),
    ).toEqual({ markdown, speechMarkup });
  });

  it('rejects one editor mark split by a formula or paragraph boundary', () => {
    expect(() =>
      serializeReachDeckNarrationSpeechDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '前',
                marks: [
                  {
                    type: REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
                    attrs: { definition: { id: 'same', type: 'sub', alias: '替换' } },
                  },
                ],
              },
              { type: 'inlineMath', attrs: { latex: 'x' } },
              {
                type: 'text',
                text: '后',
                marks: [
                  {
                    type: REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
                    attrs: { definition: { id: 'same', type: 'sub', alias: '替换' } },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow('contiguous');
  });
});
