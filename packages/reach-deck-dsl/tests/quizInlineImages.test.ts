import { describe, expect, it } from 'vitest';

import {
  QUIZ_QUESTION_MAX_INLINE_IMAGES,
  buildReachDeckMediaResourceForObjectKey,
  collectQuizQuestionInlineImageObjectKeys,
  collectQuizQuestionAttachmentReferences,
  createBlankReachDeckDocument,
  createQuizQuestion,
  ensureReachDeckRichTextMediaResources,
  parseReachDeckDocument,
  reachDeckMediaUrlsByObjectKey,
  richTextFromPlainText,
  type QuizQuestion,
  type ReachDeckDocument,
  type RichTextDocument,
} from '../src/index.js';

function imageDocument(objectKey: string, contentType = 'image/png'): RichTextDocument {
  return {
    type: 'doc',
    content: [{ type: 'image', attrs: { alt: 'diagram', contentType, objectKey } }],
  };
}

function quizDocument(questions: QuizQuestion[]): ReachDeckDocument {
  const document = createBlankReachDeckDocument({
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Quiz lesson',
  });
  const page = document.pages[0]!;
  document.pages = [
    {
      pageId: page.pageId,
      order: page.order,
      revision: page.revision,
      title: page.title,
      sceneType: 'quiz',
      scene: {
        schemaVersion: 'reach-quiz-scene/v1',
        id: page.pageId,
        title: page.title,
        sceneType: 'quiz',
        content: {
          questions,
          display_mode: 'single_question',
          navigation: 'horizontal',
          show_progress: true,
          show_question_index: true,
          answer_reveal: 'after_submit',
          allow_previous: true,
          allow_skip: false,
        },
      },
    } as unknown as (typeof document.pages)[number],
  ];
  document.nativeSlides = [];
  return parseReachDeckDocument(document);
}

describe('collectQuizQuestionInlineImageObjectKeys', () => {
  it('covers every rich-text field of a question and dedupes by first appearance', () => {
    const question: QuizQuestion = {
      ...createQuizQuestion('single_choice', 1, 'question-1'),
      question: imageDocument('keys/stem.png'),
      options: [
        { value: 'A', label: imageDocument('keys/option.png') },
        { value: 'B', label: richTextFromPlainText('plain') },
      ],
      analysis: imageDocument('keys/analysis.png'),
      cognitive_schema: imageDocument('keys/stem.png'),
    };

    expect(collectQuizQuestionInlineImageObjectKeys(question)).toEqual([
      'keys/stem.png',
      'keys/analysis.png',
      'keys/option.png',
    ]);
  });

  it('reaches blank answers, blank candidates and sub problems', () => {
    const subProblem: QuizQuestion = {
      ...createQuizQuestion('short_answer', 1, 'sub-1'),
      answer: imageDocument('keys/sub-answer.png'),
      has_answer: true,
    };
    const question: QuizQuestion = {
      ...createQuizQuestion('cloze', 1, 'question-1'),
      blanks: [
        {
          id: 'blank-1',
          blank_index: 1,
          answer: imageDocument('keys/blank-answer.png'),
          candidates: [{ value: 'A', label: imageDocument('keys/candidate.png') }],
        },
      ],
      sub_problems: [subProblem],
    };

    expect(collectQuizQuestionInlineImageObjectKeys(question)).toEqual([
      'keys/blank-answer.png',
      'keys/candidate.png',
      'keys/sub-answer.png',
    ]);
  });

  it('keeps the per-question cap aligned with the legacy Quiz module', () => {
    expect(QUIZ_QUESTION_MAX_INLINE_IMAGES).toBe(10);
  });
});

describe('ensureReachDeckRichTextMediaResources', () => {
  it('registers recursive question attachments with their declared MIME and reclaims deleted entries', () => {
    const attachment = {
      objectKey: 'uploads/org/deck/attachment/no-extension',
      contentType: 'application/pdf',
      name: 'notes.pdf',
      sizeBytes: 40,
      order: 1,
    };
    const child = {
      ...createQuizQuestion('short_answer', 1, 'child'),
      question_attachments: [attachment],
    };
    const question = {
      ...createQuizQuestion('short_answer', 1, 'root'),
      question_attachments: [attachment],
      analysis_attachments: [{ ...attachment, objectKey: 'analysis-only.pdf' }],
      sub_problems: [child],
    };
    expect(collectQuizQuestionAttachmentReferences(question)).toEqual([attachment]);
    const registered = ensureReachDeckRichTextMediaResources(quizDocument([question]));
    expect(registered.resources.media).toEqual([
      expect.objectContaining({
        objectKey: attachment.objectKey,
        contentType: 'application/pdf',
      }),
    ]);
    expect(ensureReachDeckRichTextMediaResources(registered)).toBe(registered);
    expect(() => parseReachDeckDocument(registered)).not.toThrow();
    const deleted = {
      ...quizDocument([createQuizQuestion('short_answer', 1, 'root')]),
      resources: registered.resources,
    };
    expect(ensureReachDeckRichTextMediaResources(deleted).resources.media).toEqual([]);
  });

  it('keeps a removed attachment resource when rich text still references its object key', () => {
    const attachment = {
      objectKey: 'uploads/org/deck/attachment/chart.png',
      contentType: 'image/png',
      name: 'chart.png',
      sizeBytes: 40,
      order: 1,
    };
    const registered = ensureReachDeckRichTextMediaResources(
      quizDocument([
        { ...createQuizQuestion('short_answer', 1, 'root'), question_attachments: [attachment] },
      ]),
    );
    const imageOnly = quizDocument([
      {
        ...createQuizQuestion('short_answer', 1, 'root'),
        question: imageDocument(attachment.objectKey),
      },
    ]);
    const retained = ensureReachDeckRichTextMediaResources({
      ...imageOnly,
      resources: registered.resources,
    });
    expect(retained.resources.media).toEqual(registered.resources.media);
  });

  it('registers one resource per distinct quiz image key, byte-equal to the shared derivation', () => {
    const document = quizDocument([
      {
        ...createQuizQuestion('short_answer', 1, 'question-1'),
        question: imageDocument('uploads/org/deck/image/stem.png'),
        analysis: imageDocument('uploads/org/deck/image/analysis.webp', 'image/webp'),
      },
    ]);

    const registered = ensureReachDeckRichTextMediaResources(document);

    expect(registered.resources.media).toEqual([
      buildReachDeckMediaResourceForObjectKey('uploads/org/deck/image/stem.png'),
      buildReachDeckMediaResourceForObjectKey('uploads/org/deck/image/analysis.webp'),
    ]);
    expect(() => parseReachDeckDocument(registered)).not.toThrow();
  });

  it('is idempotent and returns the same reference when nothing is missing', () => {
    const document = quizDocument([
      {
        ...createQuizQuestion('short_answer', 1, 'question-1'),
        question: imageDocument('uploads/org/deck/image/stem.png'),
      },
    ]);

    const once = ensureReachDeckRichTextMediaResources(document);
    expect(ensureReachDeckRichTextMediaResources(once)).toBe(once);
  });

  it('leaves an image-free document untouched by reference', () => {
    const document = quizDocument([createQuizQuestion('short_answer', 1, 'question-1')]);
    expect(ensureReachDeckRichTextMediaResources(document)).toBe(document);
  });

  it('never duplicates an objectKey another resource already registered', () => {
    const document = quizDocument([
      {
        ...createQuizQuestion('short_answer', 1, 'question-1'),
        question: imageDocument('uploads/org/deck/image/stem.png'),
      },
    ]);
    document.resources.media.push({
      id: 'slide-owned-resource',
      objectKey: 'uploads/org/deck/image/stem.png',
      contentType: 'image/png',
      digest: 'sha256:slide',
    });

    const registered = ensureReachDeckRichTextMediaResources(document);

    expect(registered).toBe(document);
    expect(registered.resources.media).toHaveLength(1);
  });

  it('appends in stable first-appearance order so the revision token does not churn', () => {
    const questions = [
      {
        ...createQuizQuestion('short_answer', 1, 'question-1'),
        question: imageDocument('uploads/b.png'),
      },
      {
        ...createQuizQuestion('short_answer', 2, 'question-2'),
        question: imageDocument('uploads/a.png'),
      },
    ];

    // 同一份输入克隆两次再分别登记：`createBlankReachDeckDocument` 会盖 `generatedAt`
    // 时间戳，构造两次会引入毫秒级差异，把文档构造的抖动误算到被测函数头上。
    const base = quizDocument(questions);
    const first = ensureReachDeckRichTextMediaResources(structuredClone(base));
    const second = ensureReachDeckRichTextMediaResources(structuredClone(base));

    expect(first.resources.media.map((resource) => resource.objectKey)).toEqual([
      'uploads/b.png',
      'uploads/a.png',
    ]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('reachDeckMediaUrlsByObjectKey', () => {
  it('re-keys resolved resource urls by their stable objectKey and skips blank entries', () => {
    const document = ensureReachDeckRichTextMediaResources(
      quizDocument([
        {
          ...createQuizQuestion('short_answer', 1, 'question-1'),
          question: imageDocument('uploads/resolved.png'),
          analysis: imageDocument('uploads/unresolved.png'),
        },
      ]),
    );
    const [resolved, unresolved] = document.resources.media;

    expect(
      reachDeckMediaUrlsByObjectKey(document, {
        [resolved!.id]: 'https://cdn.example/resolved.png?signature',
        [unresolved!.id]: '   ',
      }),
    ).toEqual({ 'uploads/resolved.png': 'https://cdn.example/resolved.png?signature' });
  });
});
