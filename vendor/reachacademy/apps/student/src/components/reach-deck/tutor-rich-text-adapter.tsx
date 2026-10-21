'use client';

import { useMemo } from 'react';
import type { TutorRichTextAdapter } from '@reachany/tutor-ui';
import { QuizRichTextContent } from '@/src/components/student/QuizRichTextContent';
import { createQuizBrowserRichTextExtensions } from '@/src/components/teacher/quiz-rich-text-browser';
import { markdownToTiptapJson, tiptapJsonToMarkdown } from '@/src/lib/quiz/markdown-to-tiptap';
import type { RichTextDocument } from '@/src/lib/quiz-content-model';

/**
 * Safe renderer for controlled Markdown (tutor replies, AI grading feedback): validated by the Quiz
 * Markdown contract and rendered read-only through TipTap; falls back to plain text, never HTML.
 */
export function ControlledMarkdownContent({
  ariaLabel,
  markdown,
  emptyLabel,
}: {
  ariaLabel: string;
  markdown: string;
  emptyLabel: string;
}) {
  const document = useMemo(() => {
    try {
      return markdownToTiptapJson(markdown);
    } catch {
      return null;
    }
  }, [markdown]);
  return document === null ? (
    <p aria-label={ariaLabel} className="whitespace-pre-wrap text-body text-fg">
      {markdown}
    </p>
  ) : (
    <QuizRichTextContent ariaLabel={ariaLabel} emptyLabel={emptyLabel} value={document} />
  );
}

export const tutorRichTextAdapter: TutorRichTextAdapter = {
  createExtensions: createQuizBrowserRichTextExtensions,
  serialize: (document) => tiptapJsonToMarkdown(document as RichTextDocument),
  MessageContent: ControlledMarkdownContent,
};
