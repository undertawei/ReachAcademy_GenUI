import { generateHTML, generateJSON } from '@tiptap/html';
import { describe, expect, it } from 'vitest';

import { createReachDeckAnswerExtensions } from '../src/extensions.js';

describe('createReachDeckAnswerExtensions', () => {
  it('round-trips lists, marks, formulas, and stable image metadata', () => {
    const extensions = createReachDeckAnswerExtensions();
    const document = {
      type: 'doc' as const,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      marks: [{ type: 'bold' }, { type: 'underline' }],
                      text: '步骤',
                    },
                    { type: 'inlineMath', attrs: { latex: 'x^2' } },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'image',
          attrs: {
            alt: 'diagram',
            assetId: 'asset-1',
            contentType: 'image/png',
            name: 'diagram.png',
            objectKey: 'org/student-deck/diagram.png',
            sizeBytes: 100,
            src: 'https://assets.example.test/diagram.png',
          },
        },
      ],
    };

    const html = generateHTML(document, extensions);
    expect(html).toContain('<ul>');
    expect(html).toContain('data-object-key="org/student-deck/diagram.png"');
    const parsed = generateJSON(html, extensions);
    expect(parsed.content?.[0]?.type).toBe('bulletList');
    expect(parsed.content?.[1]?.attrs?.objectKey).toBe('org/student-deck/diagram.png');
  });

  it('does not add slide-only typography attributes to answer formulas', () => {
    const extensions = createReachDeckAnswerExtensions();
    const parsed = generateJSON(
      '<p><span data-type="inline-math" data-latex="x" data-font-size="30px" data-line-height-px="42" data-color="#123456" data-font-family="Source Han Sans VF"></span></p>',
      extensions,
    );

    expect(parsed.content?.[0]?.content?.[0]).toEqual({
      type: 'inlineMath',
      attrs: { latex: 'x' },
    });
  });
});
