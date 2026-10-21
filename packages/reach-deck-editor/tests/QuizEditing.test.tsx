// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReachDeckMediaResourceForObjectKey,
  createQuizQuestion,
  richTextFromPlainText,
  type QuizQuestion,
  type ReachDeckDocument,
  type RichTextDocument,
} from '@reachany/reach-deck-dsl';

import { ReachDeckEditor } from '../src/ReachDeckEditor';
import { addReachDeckPage, deleteReachDeckPage } from '../src/operations';
import { createEditorDocument } from './fixture';

describe('ReachDeckEditor quiz authoring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it.each(['disabled', 'page-locked', 'generating'] as const)(
    'keeps PDF and Office downloads signed when the quiz editor is %s',
    async (state) => {
      const attachments = [
        {
          assetId: 'pdf-asset',
          objectKey: 'quiz/reference.pdf',
          name: 'reference.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          order: 0,
        },
        {
          assetId: 'office-asset',
          objectKey: 'quiz/report.docx',
          name: 'report.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 1024,
          order: 1,
        },
      ];
      const question = {
        ...createQuizQuestion('single_choice', 1, 'download-question'),
        question_attachments: attachments,
      };
      const document = quizDocument(question);
      const initialDocument =
        state === 'generating'
          ? {
              ...document,
              pages: [...createEditorDocument().pages, { ...document.pages[0]!, order: 2 }],
              nativeSlides: createEditorDocument().nativeSlides,
            }
          : document;
      const resolveAttachmentUrl = vi.fn(async (_ref, disposition: 'inline' | 'attachment') => ({
        url: 'https://example.test/download',
        disposition,
      }));
      const anchorClick = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {});
      let finishGeneration!: (value: undefined) => void;
      const onGeneratePage = vi.fn(
        () => new Promise<undefined>((resolve) => (finishGeneration = resolve)),
      );
      await act(async () =>
        root.render(
          <ReachDeckEditor
            document={initialDocument}
            disabled={state === 'disabled'}
            lockedPageIds={state === 'page-locked' ? [document.pages[0]!.pageId] : undefined}
            onGeneratePage={onGeneratePage}
            resolveAttachmentUrl={resolveAttachmentUrl}
          />,
        ),
      );
      if (state === 'generating') {
        act(() => button('生成当前页').click());
        expect(onGeneratePage).toHaveBeenCalledOnce();
        act(() =>
          container
            .querySelector<HTMLElement>(
              `[data-page-card][data-page-id="${document.pages[0]!.pageId}"]`,
            )
            ?.click(),
        );
      }
      expect(container.querySelector('.reach-deck-editor__quiz-canvas')).toBeNull();
      expect(
        container.querySelector('.reach-deck-editor__player-layer .quiz-scene'),
      ).not.toBeNull();
      expect(resolveAttachmentUrl).not.toHaveBeenCalled();
      for (const attachment of attachments) {
        await act(async () => button(`下载 ${attachment.name}`).click());
        expect(resolveAttachmentUrl).toHaveBeenLastCalledWith(
          expect.objectContaining({
            assetId: attachment.assetId,
            objectKey: attachment.objectKey,
            pageId: document.pages[0]!.pageId,
          }),
          'attachment',
        );
      }
      expect(anchorClick).toHaveBeenCalledTimes(2);
      if (state === 'generating') await act(async () => finishGeneration(undefined));
    },
  );

  it('keeps the selected choice attached to its option while reordering and deleting', () => {
    const question = {
      ...createQuizQuestion('single_choice', 1, 'choice-question'),
      answer: ['B'],
      has_answer: true,
      options: choiceOptions(),
    };
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={quizDocument(question)} onChange={onChange} />),
    );

    expect(input('设为正确答案 B').checked).toBe(true);
    const rows = choiceRows();
    act(() => rows[1]?.dispatchEvent(dragEvent('dragstart')));
    act(() => rows[0]?.dispatchEvent(dragEvent('drop')));

    let saved = latestQuestion(onChange);
    expect(saved.options?.map((option) => [option.value, plainText(option.label)])).toEqual([
      ['A', 'Beta'],
      ['B', 'Alpha'],
      ['C', 'Gamma'],
      ['D', 'Delta'],
    ]);
    expect(saved.answer).toEqual(['A']);
    expect(saved.has_answer).toBe(true);

    act(() => button('删除选项 A').click());
    saved = latestQuestion(onChange);
    expect(saved.options?.map((option) => option.value)).toEqual(['A', 'B', 'C']);
    expect(saved.answer).toEqual([]);
    expect(saved.has_answer).toBe(false);
  });

  it('restores hidden choice fields when switching away and back during the mounted route session', () => {
    const question = {
      ...createQuizQuestion('single_choice', 1, 'type-session-question'),
      answer: ['B'],
      has_answer: true,
      options: choiceOptions(),
      question: richTextFromPlainText('共同题干'),
    };
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={quizDocument(question)} onChange={onChange} />),
    );

    chooseQuestionType('自由填空');
    expect(latestQuestion(onChange).question_type).toBe('fill_in_the_blank');
    expect(latestQuestion(onChange).options).toBeUndefined();
    chooseQuestionType('单选题');

    const restored = latestQuestion(onChange);
    expect(restored.question_type).toBe('single_choice');
    expect(restored.options?.map((option) => plainText(option.label))).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ]);
    expect(restored.answer).toEqual(['B']);
    expect(plainText(restored.question)).toBe('共同题干');
  });

  it('authors candidate answers per stable blank and remaps them atomically', () => {
    const question = {
      ...createQuizQuestion('cloze', 1, 'candidate-question'),
      blanks: [
        {
          answer: ['B'],
          blank_index: 1,
          candidates: choiceOptions(),
          id: 'candidate-stable',
        },
      ],
      has_answer: true,
      question: blankDocument('candidate-stable'),
    };
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={quizDocument(question)} onChange={onChange} />),
    );

    const blank = container.querySelector<HTMLElement>(
      '.reach-deck-editor__quiz-blank-answers section[data-blank-id="candidate-stable"]',
    );
    expect(blank).not.toBeNull();
    expect(input('设为正确答案 B').checked).toBe(true);
    const rows = [
      ...(blank?.querySelectorAll<HTMLElement>('.reach-deck-editor__quiz-options > div') ?? []),
    ];
    act(() => rows[1]?.dispatchEvent(dragEvent('dragstart')));
    act(() => rows[0]?.dispatchEvent(dragEvent('drop')));

    let saved = latestQuestion(onChange);
    expect(saved.blanks?.[0]).toMatchObject({
      answer: ['A'],
      blank_index: 1,
      id: 'candidate-stable',
    });
    expect(saved.blanks?.[0]?.candidates?.map((option) => plainText(option.label))).toEqual([
      'Beta',
      'Alpha',
      'Gamma',
      'Delta',
    ]);

    act(() => button('删除候选项 A').click());
    saved = latestQuestion(onChange);
    expect(saved.blanks?.[0]?.answer).toEqual([]);
    expect(saved.has_answer).toBe(false);
  });

  it('inserts unique stable blank ids and derives free-fill has_answer from every blank', () => {
    const question = {
      ...createQuizQuestion('fill_in_the_blank', 1, 'free-fill-question'),
      blanks: [
        {
          answer: richTextFromPlainText('first answer'),
          blank_index: 1,
          id: 'blank-2',
        },
      ],
      has_answer: true,
      question: blankDocument('blank-2'),
    };
    const onChange = vi.fn();
    act(() =>
      root.render(<ReachDeckEditor document={quizDocument(question)} onChange={onChange} />),
    );

    expect(container.querySelector('[data-blank-id="blank-2"]')).not.toBeNull();
    expect(inputByLabelText('包含标准答案').checked).toBe(true);
    act(() => button('插入填空').click());

    const saved = latestQuestion(onChange);
    expect(saved.blanks?.map((blank) => [blank.id, blank.blank_index])).toEqual([
      ['blank-1', 1],
      ['blank-2', 2],
    ]);
    expect(saved.has_answer).toBe(false);
    expect(quizBlankAttrs(saved)).toEqual([
      { blankId: 'blank-1', blankIndex: 1 },
      { blankId: 'blank-2', blankIndex: 2 },
    ]);
  });

  it('interpolates the blank number in English and Chinese accessibility labels', () => {
    const question = {
      ...createQuizQuestion('fill_in_the_blank', 1, 'free-fill-question'),
      blanks: [
        {
          answer: richTextFromPlainText('answer'),
          blank_index: 1,
          id: 'stable-blank',
        },
      ],
      has_answer: true,
      question: blankDocument('stable-blank'),
    };
    const document = quizDocument(question);
    const english = (key: string) =>
      key === 'reachDeck.editor.quiz.blankAria' ? 'Blank {number}' : key;
    const chinese = (key: string) =>
      key === 'reachDeck.editor.quiz.blankAria' ? '第 {number} 空' : key;

    act(() => root.render(<ReachDeckEditor key="en" document={document} translate={english} />));
    expect(container.querySelector('[data-quiz-blank]')?.getAttribute('aria-label')).toBe(
      'Blank 1',
    );

    act(() => root.render(<ReachDeckEditor key="zh" document={document} translate={chinese} />));
    expect(container.querySelector('[data-quiz-blank]')?.getAttribute('aria-label')).toBe(
      '第 1 空',
    );
  });

  it('saves uploaded question attachments and their resource manifest in the undo history', async () => {
    const onChange = vi.fn();
    const onUploadAuthoringMedia = vi.fn().mockResolvedValue({
      assetId: 'attachment-asset',
      objectKey: 'uploads/org/deck/attachment/notes',
      name: 'notes.pdf',
      contentType: 'application/pdf',
      sizeBytes: 3,
      digest: 'objectkey:uploads/org/deck/attachment/notes',
      downloadUrl: 'https://assets.example/notes.pdf',
    });
    act(() =>
      root.render(
        <ReachDeckEditor
          document={quizDocument(createQuizQuestion('short_answer', 1, 'attachment-question'))}
          onChange={onChange}
          onUploadAuthoringMedia={onUploadAuthoringMedia}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>(
      'section[aria-label="题目附件"] input[type="file"]',
    )!;
    const file = new File(['pdf'], 'notes.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onUploadAuthoringMedia).toHaveBeenCalledWith({
      file,
      kind: 'attachment',
      signal: expect.any(AbortSignal),
    });
    expect(latestQuestion(onChange).question_attachments).toEqual([
      expect.objectContaining({ assetId: 'attachment-asset', order: 0 }),
    ]);
    expect((onChange.mock.lastCall?.[0] as ReachDeckDocument).resources.media).toEqual([
      expect.objectContaining({
        objectKey: 'uploads/org/deck/attachment/notes',
        contentType: 'application/pdf',
      }),
    ]);
    act(() => button('移除 notes.pdf').click());
    expect(latestQuestion(onChange).question_attachments).toEqual([]);
    expect((onChange.mock.lastCall?.[0] as ReachDeckDocument).resources.media).toEqual([]);
    act(() => button('撤销课件修改').click());
    expect(latestQuestion(onChange).question_attachments).toHaveLength(1);
    expect((onChange.mock.lastCall?.[0] as ReachDeckDocument).resources.media).toHaveLength(1);
  });

  describe('inline images', () => {
    const uploaded = {
      contentType: 'image/png',
      digest: 'objectkey:uploads/org/deck/quiz/forces.png',
      downloadUrl: 'https://assets.example/forces.png?signature',
      objectKey: 'uploads/org/deck/quiz/forces.png',
    };

    it('inserts stable metadata and registers the media resource in a single commit', async () => {
      const onChange = vi.fn();
      const onUploadAuthoringMedia = vi.fn().mockResolvedValue(uploaded);
      const document = quizDocument(createQuizQuestion('short_answer', 1, 'image-question'));
      act(() =>
        root.render(
          <ReachDeckEditor
            document={document}
            onChange={onChange}
            onUploadAuthoringMedia={onUploadAuthoringMedia}
          />,
        ),
      );

      await pickImageFile(pngFile('forces.png'));

      expect(onUploadAuthoringMedia).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      const saved = onChange.mock.calls[0]?.[0] as ReachDeckDocument;
      expect(imageNodes(latestQuestion(onChange).question)).toEqual([
        {
          alt: 'forces.png',
          contentType: 'image/png',
          name: 'forces.png',
          objectKey: uploaded.objectKey,
          sizeBytes: 4,
        },
      ]);
      expect(saved.resources.media).toEqual([
        buildReachDeckMediaResourceForObjectKey(uploaded.objectKey),
      ]);
      expect(saved.pages[0]?.revision).toBe((document.pages[0]?.revision ?? 0) + 1);
    });

    it('uploads a pasted clipboard screenshot without letting the slide paste path fire', async () => {
      const onChange = vi.fn();
      const onUploadAuthoringMedia = vi.fn().mockResolvedValue(uploaded);
      act(() =>
        root.render(
          <ReachDeckEditor
            document={quizDocument(createQuizQuestion('short_answer', 1, 'image-question'))}
            onChange={onChange}
            onUploadAuthoringMedia={onUploadAuthoringMedia}
          />,
        ),
      );

      await pasteFiles([pngFile('screenshot.png')]);

      expect(onUploadAuthoringMedia).toHaveBeenCalledTimes(1);
      expect(imageNodes(latestQuestion(onChange).question)).toHaveLength(1);
      const saved = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
      expect(saved.nativeSlides).toEqual([]);
    });

    it('falls through image-only clipboard HTML to the file upload', async () => {
      const onChange = vi.fn();
      const onUploadAuthoringMedia = vi.fn().mockResolvedValue(uploaded);
      act(() =>
        root.render(
          <ReachDeckEditor
            document={quizDocument(createQuizQuestion('short_answer', 1, 'image-question'))}
            onChange={onChange}
            onUploadAuthoringMedia={onUploadAuthoringMedia}
          />,
        ),
      );

      await pasteFiles([pngFile('web.png')], {
        'text/html': '<img src="https://example.test/web.png" alt="示意图">',
      });

      expect(onUploadAuthoringMedia).toHaveBeenCalledTimes(1);
      expect(imageNodes(latestQuestion(onChange).question)).toHaveLength(1);
    });

    it.each([
      ['oversized files', new File(['x'.repeat(20)], 'huge.png', { type: 'image/png' }), true],
      ['unsupported types', new File(['x'], 'vector.bmp', { type: 'image/bmp' }), false],
    ])('rejects %s before calling the host uploader', async (_label, file, oversized) => {
      const onChange = vi.fn();
      const onUploadAuthoringMedia = vi.fn().mockResolvedValue(uploaded);
      vi.spyOn(file, 'size', 'get').mockReturnValue(oversized ? 16 * 1024 * 1024 : 4);
      act(() =>
        root.render(
          <ReachDeckEditor
            document={quizDocument(createQuizQuestion('short_answer', 1, 'image-question'))}
            onChange={onChange}
            onUploadAuthoringMedia={onUploadAuthoringMedia}
          />,
        ),
      );

      await pickImageFile(file);

      expect(onUploadAuthoringMedia).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(alertText()).toBe(
        oversized ? '单张图片不得超过 15 MB。' : '只支持 PNG、JPEG、WebP、GIF 图片。',
      );
    });

    it('stops at the per-question cap counted across every rich-text field', async () => {
      const onChange = vi.fn();
      const onUploadAuthoringMedia = vi.fn().mockResolvedValue(uploaded);
      const question: QuizQuestion = {
        ...createQuizQuestion('short_answer', 1, 'image-question'),
        analysis: imagesDocument(5, 'analysis'),
        question: imagesDocument(5, 'stem'),
      };
      act(() =>
        root.render(
          <ReachDeckEditor
            document={quizDocument(question)}
            onChange={onChange}
            onUploadAuthoringMedia={onUploadAuthoringMedia}
          />,
        ),
      );

      expect(button('插入图片').disabled).toBe(true);
      await pasteFiles([pngFile('eleventh.png')]);

      expect(onUploadAuthoringMedia).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(alertText()).toBe('每道题最多插入 10 张图片。');
    });

    it('surfaces a failed upload without touching the document', async () => {
      const onChange = vi.fn();
      const onUploadAuthoringMedia = vi.fn().mockRejectedValue(new Error('storage is down'));
      act(() =>
        root.render(
          <ReachDeckEditor
            document={quizDocument(createQuizQuestion('short_answer', 1, 'image-question'))}
            onChange={onChange}
            onUploadAuthoringMedia={onUploadAuthoringMedia}
          />,
        ),
      );

      await pickImageFile(pngFile('forces.png'));

      expect(onChange).not.toHaveBeenCalled();
      expect(alertText()).toBe('图片上传失败，请检查文件后重试。');
    });

    it('offers no image affordance when the host cannot upload media', () => {
      act(() =>
        root.render(
          <ReachDeckEditor
            document={quizDocument(createQuizQuestion('short_answer', 1, 'image-question'))}
            onChange={vi.fn()}
          />,
        ),
      );

      expect(
        container.querySelector('button[aria-label="插入图片"], input[type="file"]'),
      ).toBeNull();
    });

    async function pickImageFile(file: File): Promise<void> {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      if (input === null) throw new Error('Missing image file input');
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await flushMicrotasks();
      });
    }

    async function pasteFiles(
      files: readonly File[],
      values: Readonly<Record<string, string>> = {},
    ): Promise<void> {
      const surface = container.querySelector('.reach-deck-editor__rich-text-surface');
      if (surface === null) throw new Error('Missing quiz rich-text surface');
      const clipboardData = {
        files,
        getData: (mime: string) => values[mime] ?? '',
        items: files.map((file) => ({ getAsFile: () => file, kind: 'file', type: file.type })),
        setData: () => {},
        types: [...Object.keys(values), ...files.map((file) => file.type)],
      } as unknown as DataTransfer;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
      await act(async () => {
        surface.dispatchEvent(event);
        await flushMicrotasks();
      });
    }

    function alertText(): string {
      return container.querySelector('[role="alert"]')?.textContent ?? '';
    }
  });

  it('previews a pending Decksmith quiz proposal over the editable quiz canvas', async () => {
    const baseline = quizDocument(createQuizQuestion('short_answer', 1, 'preview-question'));
    const baselinePage = baseline.pages[0];
    if (baselinePage?.sceneType !== 'quiz') throw new Error('Expected quiz page');
    const proposal: ReachDeckDocument = {
      ...baseline,
      pages: [
        {
          ...baselinePage,
          revision: baselinePage.revision + 1,
          scene: {
            ...baselinePage.scene,
            content: {
              ...baselinePage.scene.content,
              questions: baselinePage.scene.content.questions.map((question) => ({
                ...question,
                question: richTextFromPlainText('Decksmith 改写后的题干'),
              })),
            },
          },
        },
      ],
    };
    const onAssistantPrompt = vi.fn().mockResolvedValue({
      document: proposal,
      message: '已完成 AI 修改。',
      runtimeApprovalId: 'runtime-approval-quiz-preview',
    });
    const onAssistantDecision = vi.fn();
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckEditor
          document={baseline}
          onAssistantDecision={onAssistantDecision}
          onAssistantPrompt={onAssistantPrompt}
          onChange={onChange}
        />,
      ),
    );
    const composer = container.querySelector<HTMLTextAreaElement>('#reach-deck-assistant-prompt')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        composer,
        '把这道题改写成主动回忆题',
      );
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => composer.form?.requestSubmit());
    expect(onAssistantPrompt).toHaveBeenCalled();

    const previewButton = button('按住预览修改后的页面');
    expect(container.querySelector('.reach-deck-editor__quiz-canvas')).not.toBeNull();
    expect(container.querySelector('.reach-deck-editor__player-preview-layer')).toBeNull();

    act(() => previewButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    const previewLayer = container.querySelector('.reach-deck-editor__player-preview-layer');
    expect(previewLayer).not.toBeNull();
    expect(previewLayer?.textContent).toContain('Decksmith 改写后的题干');
    // 编辑中的测验画布保持挂载（不丢富文本编辑器状态），预览只是临时覆盖层。
    expect(container.querySelector('.reach-deck-editor__quiz-canvas')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onAssistantDecision).not.toHaveBeenCalled();

    act(() => previewButton.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })));
    expect(container.querySelector('.reach-deck-editor__player-preview-layer')).toBeNull();
    expect(container.querySelector('.reach-deck-editor__quiz-canvas')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onAssistantDecision).not.toHaveBeenCalled();
  });

  describe('Word paste', () => {
    // 真正走 ProseMirror 的粘贴路径需要这些几何 API；jsdom 没有实现，缺了会在
    // scrollToSelection 里抛错，表现成「没有触发变更」。
    beforeEach(() => {
      Object.defineProperties(window.Range.prototype, {
        getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
        getClientRects: { configurable: true, value: () => [] },
      });
      Object.defineProperty(window.Element.prototype, 'getClientRects', {
        configurable: true,
        value: () => [],
      });
    });

    it('keeps formulas, marks, headings and table structure in the question stem', async () => {
      const onChange = vi.fn();
      act(() =>
        root.render(
          <ReachDeckEditor
            document={quizDocument(createQuizQuestion('short_answer', 1, 'word-question'))}
            onChange={onChange}
          />,
        ),
      );

      await pasteHtml(WORD_CLIPBOARD_HTML);

      const serialized = JSON.stringify(latestQuestion(onChange).question);
      // 公式走共享转换器的受信 latex 标记，不是一段字面文本。
      expect(serialized).toContain('"type":"inlineMath"');
      expect(serialized).toContain('\\\\frac{a}{b}');
      // 行内格式与标题层级保留。
      expect(serialized).toContain('"type":"bold"');
      expect(serialized).toContain('"type":"italic"');
      expect(serialized).toContain('"type":"heading"');
      // 表格保留结构，而不是被展平成段落 —— 这是与幻灯片文本框的关键差异。
      expect(serialized).toContain('"type":"table"');
      expect(serialized).toContain('"type":"tableCell"');
      expect(serialized).toContain('"type":"bulletList"');
      // 外部来源仍然不进文档。
      expect(serialized).not.toContain('diagram.png');
      expect(serialized).not.toContain('"type":"image"');
    });

    it('keeps clicks inside the question stem from activating the rich-text undo button', async () => {
      const onChange = vi.fn();
      act(() =>
        root.render(
          <ReachDeckEditor
            document={quizDocument(createQuizQuestion('short_answer', 1, 'stem-click-question'))}
            onChange={onChange}
          />,
        ),
      );

      await pasteHtml('<p>粘贴后的新题干</p>');
      expect(plainText(latestQuestion(onChange).question)).toContain('粘贴后的新题干');

      const promptSurface = container.querySelector<HTMLElement>('[aria-label="题干 / 大题材料"]')!;
      const promptField = promptSurface.closest<HTMLElement>(
        '.reach-deck-editor__quiz-rich-field',
      )!;
      const undo = promptField.querySelector<HTMLButtonElement>('button[aria-label="撤销"]')!;
      expect(undo.disabled).toBe(false);
      const undoClick = vi.fn();
      undo.addEventListener('click', undoClick);
      const changeCount = onChange.mock.calls.length;
      // 点在题干字段内、但落在 contenteditable 之外的区域（编辑区外框、字段标题）：
      // 旧实现里 <label> 的激活行为会把这次点击转发给「撤销」并真的撤销刚输入的题干。
      const editorFrame = promptSurface.parentElement!;
      const caption = promptField.firstElementChild as HTMLElement;
      expect(caption.textContent).toBe('题干 / 大题材料');
      for (const target of [editorFrame, caption]) {
        act(() => {
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
      }
      expect(undoClick).not.toHaveBeenCalled();
      expect(onChange.mock.calls.length).toBe(changeCount);
      expect(plainText(latestQuestion(onChange).question)).toContain('粘贴后的新题干');

      // 字段容器不能是 <label>：label 会把题干区的悬停 / 点击转发给它的第一个可标注后代，
      // 也就是格式栏里的「撤销」按钮，导致一点题干就撤销刚输入的内容。
      expect(promptField.closest('label')).toBeNull();
      expect(promptField.getAttribute('role')).toBe('group');
      expect(promptField.getAttribute('aria-labelledby')).toBeTruthy();
      expect(
        window.document.getElementById(promptField.getAttribute('aria-labelledby')!)?.textContent,
      ).toBe('题干 / 大题材料');
    });

    it('still flattens the same clipboard into a slide text frame', async () => {
      const onChange = vi.fn();
      let sequence = 0;
      act(() =>
        root.render(
          <ReachDeckEditor
            document={createEditorDocument()}
            idFactory={(prefix) => `${prefix}-slide-word-${++sequence}`}
            onChange={onChange}
          />,
        ),
      );
      act(() => container.querySelector<HTMLElement>('.reach-deck-editor__preview')?.click());

      const clipboardData = {
        files: [],
        getData: (mime: string) => (mime === 'text/html' ? WORD_CLIPBOARD_HTML : ''),
        items: [],
        setData: () => {},
        types: ['text/html'],
      } as unknown as DataTransfer;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
      await act(async () => {
        window.dispatchEvent(event);
        await flushMicrotasks();
      });

      const document = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument;
      const inserted = document.nativeSlides[0]?.slide.elements.at(-1);
      if (inserted?.type !== 'textFrame') throw new Error('Expected pasted slide text frame');
      const serialized = JSON.stringify(inserted.text.doc);
      expect(serialized).not.toContain('"type":"table"');
      expect(serialized).not.toContain('"type":"heading"');
      expect(serialized).toContain('"type":"inlineMath"');
    });

    async function pasteHtml(html: string): Promise<void> {
      const surface = container.querySelector('.reach-deck-editor__rich-text-surface');
      if (surface === null) throw new Error('Missing quiz rich-text surface');
      const clipboardData = {
        files: [],
        getData: (mime: string) => (mime === 'text/html' ? html : ''),
        items: [],
        setData: () => {},
        types: ['text/html'],
      } as unknown as DataTransfer;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
      await act(async () => {
        (surface as HTMLElement).focus();
        surface.dispatchEvent(event);
        await flushMicrotasks();
      });
    }
  });

  function choiceRows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('.reach-deck-editor__quiz-options > div')];
  }

  function input(label: string): HTMLInputElement {
    const match = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (match === null) throw new Error(`Missing input: ${label}`);
    return match;
  }

  function inputByLabelText(label: string): HTMLInputElement {
    const match = [...container.querySelectorAll<HTMLInputElement>('label input')].find(
      (candidate) => candidate.parentElement?.textContent?.includes(label),
    );
    if (match === undefined) throw new Error(`Missing labelled input: ${label}`);
    return match;
  }

  function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) =>
        candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
    );
    if (match === undefined) throw new Error(`Missing button: ${label}`);
    return match;
  }

  function chooseQuestionType(label: string): void {
    const trigger = button('第 1 题题型');
    act(() => trigger.click());
    const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (option === undefined) throw new Error(`Missing question type: ${label}`);
    act(() => option.click());
  }
});

function quizDocument(question: QuizQuestion): ReachDeckDocument {
  let sequence = 0;
  const added = addReachDeckPage(createEditorDocument(), {
    afterPageId: 'page-1',
    idFactory: (prefix) => `${prefix}-quiz-test-${++sequence}`,
    sceneType: 'quiz',
  });
  const document = deleteReachDeckPage(added, 'page-1');
  const page = document.pages[0];
  if (page?.sceneType !== 'quiz') throw new Error('Expected quiz page');
  return {
    ...document,
    pages: [
      {
        ...page,
        scene: {
          ...page.scene,
          content: { ...page.scene.content, questions: [question] },
        },
      },
    ],
  };
}

function choiceOptions() {
  return ['Alpha', 'Beta', 'Gamma', 'Delta'].map((label, index) => ({
    label: richTextFromPlainText(label),
    value: String.fromCharCode(65 + index),
  }));
}

function blankDocument(blankId: string) {
  return {
    content: [
      {
        content: [{ attrs: { blankId, blankIndex: 1 }, type: 'quizBlank' as const }],
        type: 'paragraph' as const,
      },
    ],
    type: 'doc' as const,
  };
}

function latestQuestion(onChange: ReturnType<typeof vi.fn>): QuizQuestion {
  const document = onChange.mock.calls.at(-1)?.[0] as ReachDeckDocument | undefined;
  const page = document?.pages[0];
  if (page?.sceneType !== 'quiz') throw new Error('Quiz change was not emitted');
  const question = page.scene.content.questions[0];
  if (question === undefined) throw new Error('Quiz question is missing');
  return question;
}

function plainText(document: { content?: Array<{ content?: Array<{ text?: string }> }> }): string {
  return (
    document.content
      ?.flatMap((node) => node.content?.map((child) => child.text ?? '') ?? [])
      .join('') ?? ''
  );
}

function quizBlankAttrs(question: QuizQuestion): Array<{ blankId: unknown; blankIndex: unknown }> {
  return (question.question.content ?? []).flatMap((node) =>
    (node.content ?? [])
      .filter((child) => child.type === 'quizBlank')
      .map((child) => ({ blankId: child.attrs?.blankId, blankIndex: child.attrs?.blankIndex })),
  );
}

/** 最小 Word 剪贴板样本：Office 签名 + OMML 公式 + 标题 + 表格 + 列表 + 带 alt 的图片。 */
const WORD_CLIPBOARD_HTML = `
  <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
    <meta name=Generator content="Microsoft Word 15">
    <body>
      <p class=MsoNormal><b>加粗</b> 与 <i>斜体</i>，面积 <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath> 完</p>
      <h2 class=MsoHeading2>小标题</h2>
      <table class=MsoTableGrid>
        <tr><td><p class=MsoNormal>A1</p></td><td><p class=MsoNormal>B1</p></td></tr>
        <tr><td><p class=MsoNormal>A2</p></td><td><p class=MsoNormal>B2</p></td></tr>
      </table>
      <ul><li><p class=MsoNormal>要点一</p></li></ul>
      <p class=MsoNormal><img src="file:///C:/Users/teacher/diagram.png" alt="示意图"></p>
    </body>
  </html>`;

function pngFile(name: string): File {
  return new File(['data'], name, { type: 'image/png' });
}

function imagesDocument(count: number, prefix: string): RichTextDocument {
  return {
    type: 'doc',
    content: Array.from({ length: count }, (_value, index) => ({
      type: 'image',
      attrs: { contentType: 'image/png', objectKey: `uploads/${prefix}-${index}.png` },
    })),
  };
}

function imageNodes(document: RichTextDocument): Array<Record<string, unknown>> {
  return (document.content ?? [])
    .filter((node) => node.type === 'image')
    .map((node) => node.attrs ?? {});
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function dragEvent(type: 'dragstart' | 'drop'): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { dropEffect: 'move', effectAllowed: 'move', getData: () => '', setData: () => {} },
  });
  return event;
}
