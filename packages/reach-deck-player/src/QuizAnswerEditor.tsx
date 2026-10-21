'use client';

import { useEditor, useEditorState } from '@tiptap/react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Braces,
  Code,
  Eraser,
  Italic,
  Highlighter,
  List,
  ListOrdered,
  Quote,
  Palette,
  Redo2,
  Sigma,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
  Undo2,
  ArrowUp,
  ArrowDown,
  Paperclip,
  Trash2,
} from 'lucide-react';
import { learnerEditorFallback } from './learner-editor-messages.js';
import { LearnerEditor, type LearnerEditorKey } from '@reachany/learner-editor';
import { createReachDeckAnswerExtensions } from '@reachany/reach-deck-rich-text';
import {
  collectRichTextObjectKeys,
  QUIZ_ANSWER_MAX_ASSETS,
  QUIZ_ANSWER_MAX_ASSET_BYTES,
  RICH_TEXT_FONT_FAMILIES,
  type QuizAttachmentReference,
  type RichTextDocument,
  type RichTextQuestionAnswer,
} from '@reachany/reach-deck-dsl';
import { createMathLiveNodeView, insertMathAndActivate } from '@reachany/tiptap-mathlive';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';
import { IconButton } from '@reachany/ui';
import {
  ReachDeckAttachmentList,
  type ReachDeckAttachmentUrlResolver,
} from './ReachDeckAttachmentList.js';

export type QuizAnswerAssetKind = 'attachment' | 'inline_image';

const ANSWER_FONT_SIZES = [14, 16, 18, 24, 32] as const;
const ALIGNMENT_LABELS = {
  center: ['reachDeck.editor.richText.align.center', '居中'],
  justify: ['reachDeck.editor.richText.align.justify', '两端'],
  left: ['reachDeck.editor.richText.align.left', '左对齐'],
  right: ['reachDeck.editor.richText.align.right', '右对齐'],
} as const;
const ALIGNMENT_ICONS = {
  left: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
  justify: AlignJustify,
};

export interface QuizAnswerUploadedAsset {
  assetId?: string;
  contentType: string;
  downloadUrl: string;
  name: string;
  objectKey: string;
  sizeBytes: number;
}

export type QuizAnswerAssetUploader = (
  file: File,
  context: { kind: QuizAnswerAssetKind; questionId: string },
) => Promise<QuizAnswerUploadedAsset>;

export function QuizAnswerEditor({
  allowAttachments,
  disabled,
  onChange,
  onBusyChange,
  questionId,
  resolveAttachmentUrl,
  mediaUrlsByObjectKey,
  translate,
  uploadAsset,
  value,
}: {
  allowAttachments: boolean;
  disabled: boolean;
  onChange: (answer: RichTextQuestionAnswer) => void;
  onBusyChange?: (busy: boolean) => void;
  questionId: string;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  translate?: ReachDeckTranslate;
  uploadAsset?: QuizAnswerAssetUploader;
  value: RichTextQuestionAnswer;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const notifyBusy = (busy: boolean) => {
    if (busyRef.current === busy) return;
    busyRef.current = busy;
    busyCallback.current?.(busy);
  };
  useEffect(
    () => () => {
      if (busyRef.current) {
        busyRef.current = false;
        busyCallback.current?.(false);
      }
    },
    [],
  );
  const uploadMutex = useRef(false);
  const scope = useRef({ questionId, disabled });
  scope.current = { questionId, disabled };
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const valueRef = useRef(value);
  valueRef.current = value;
  const editor = useEditor(
    {
      content: value.document,
      editorProps: {
        attributes: {
          'aria-label': text('reachDeck.player.quiz.enterAnswer', '填写答案'),
          class: 'quiz-answer-editor__content',
        },
      },
      extensions: createReachDeckAnswerExtensions({
        blockMathNodeView: createMathLiveNodeView({
          displayMode: true,
          label: text('reachDeck.editor.richText.editBlockMath', '编辑独立公式'),
        }),
        inlineMathNodeView: createMathLiveNodeView({
          displayMode: false,
          label: text('reachDeck.editor.richText.editInlineMath', '编辑行内公式'),
        }),
      }),
      immediatelyRender: false,
      onUpdate: ({ editor: current }) => {
        const document = current.getJSON() as RichTextDocument;
        const count = new Set([
          ...collectRichTextObjectKeys(document),
          ...valueRef.current.attachments.map((asset) => asset.objectKey),
        ]).size;
        if (count > QUIZ_ANSWER_MAX_ASSETS) {
          current.commands.setContent(valueRef.current.document, { emitUpdate: false });
          setUploadError(
            text('reachDeck.player.quiz.answer.maxAssets', '每个答案最多 {count} 个文件。', {
              count: QUIZ_ANSWER_MAX_ASSETS,
            }),
          );
          return;
        }
        onChange({ ...valueRef.current, document });
      },
    },
    [translate],
  );
  // Selection-only/stored-mark transactions must refresh toolbar active states too.
  useEditorState({ editor, selector: ({ transactionNumber }) => transactionNumber });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor) return;
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(value.document)) return;
    editor.commands.setContent(value.document, { emitUpdate: false });
  }, [editor, value.document]);

  const assetCount = new Set([
    ...collectRichTextObjectKeys(value.document),
    ...value.attachments.map((attachment) => attachment.objectKey),
  ]).size;

  const uploadImages = async (files: File[]) => {
    if (
      !editor ||
      editor.isDestroyed ||
      disabled ||
      uploadMutex.current ||
      !uploadAsset ||
      files.length === 0
    )
      return;
    let position = editor.state.selection.from;
    setUploadError('');
    if (assetCount + files.length > QUIZ_ANSWER_MAX_ASSETS) {
      setUploadError(
        text('reachDeck.player.quiz.answer.maxAssets', '每个答案最多 {count} 个文件。', {
          count: QUIZ_ANSWER_MAX_ASSETS,
        }),
      );
      return;
    }
    if (files.some((file) => !file.type.startsWith('image/'))) {
      setUploadError(text('reachDeck.player.quiz.answer.imageOnly', '请选择图片文件。'));
      return;
    }
    if (files.some((file) => file.size > QUIZ_ANSWER_MAX_ASSET_BYTES)) {
      setUploadError(text('reachDeck.player.quiz.answer.maxSize', '单个文件不得超过 100 MiB。'));
      return;
    }
    uploadMutex.current = true;
    notifyBusy(true);
    setUploading(true);
    try {
      for (const file of files) {
        const uploaded = await uploadAsset(file, { kind: 'inline_image', questionId });
        if (editor.isDestroyed || scope.current.disabled || scope.current.questionId !== questionId)
          return;
        editor
          .chain()
          .focus()
          .insertContentAt(Math.min(position, editor.state.doc.content.size), {
            type: 'image',
            attrs: {
              alt: uploaded.name,
              ...(uploaded.assetId ? { assetId: uploaded.assetId } : {}),
              contentType: uploaded.contentType,
              name: uploaded.name,
              objectKey: uploaded.objectKey,
              sizeBytes: uploaded.sizeBytes,
              src: uploaded.downloadUrl,
            },
          })
          .run();
        // insertContentAt moves the selection after the inserted image (including any
        // block split). Keep the next file there so selection order is preserved.
        position = editor.state.selection.to;
      }
    } catch (error) {
      setUploadError(
        error instanceof Error
          ? error.message
          : text('reachDeck.player.quiz.answer.imageUploadFailed', '图片上传失败。'),
      );
    } finally {
      uploadMutex.current = false;
      notifyBusy(false);
      if (!editor.isDestroyed && scope.current.questionId === questionId) setUploading(false);
    }
  };

  const uploadAttachments = async (files: File[]) => {
    if (
      !editor ||
      editor.isDestroyed ||
      disabled ||
      uploadMutex.current ||
      !uploadAsset ||
      files.length === 0
    )
      return;
    setUploadError('');
    if (assetCount + files.length > QUIZ_ANSWER_MAX_ASSETS) {
      setUploadError(
        text('reachDeck.player.quiz.answer.maxAssets', '每个答案最多 {count} 个文件。', {
          count: QUIZ_ANSWER_MAX_ASSETS,
        }),
      );
      return;
    }
    if (files.some((file) => file.size > QUIZ_ANSWER_MAX_ASSET_BYTES)) {
      setUploadError(text('reachDeck.player.quiz.answer.maxSize', '单个文件不得超过 100 MiB。'));
      return;
    }
    uploadMutex.current = true;
    notifyBusy(true);
    setUploading(true);
    let next = [...valueRef.current.attachments];
    try {
      for (const file of files) {
        const uploaded = await uploadAsset(file, { kind: 'attachment', questionId });
        if (editor.isDestroyed || scope.current.disabled || scope.current.questionId !== questionId)
          return;
        next = normalizeAttachmentOrder([
          ...next,
          {
            ...(uploaded.assetId ? { assetId: uploaded.assetId } : {}),
            contentType: uploaded.contentType,
            name: uploaded.name,
            objectKey: uploaded.objectKey,
            order: next.length,
            sizeBytes: uploaded.sizeBytes,
          },
        ]);
        const answer = { ...valueRef.current, attachments: next };
        valueRef.current = answer;
        onChange(answer);
      }
    } catch (error) {
      setUploadError(
        error instanceof Error
          ? error.message
          : text('reachDeck.player.quiz.answer.attachmentUploadFailed', '附件上传失败。'),
      );
    } finally {
      uploadMutex.current = false;
      notifyBusy(false);
      if (!editor.isDestroyed && scope.current.questionId === questionId) setUploading(false);
    }
  };

  if (!editor) return <div className="quiz-answer-editor is-loading" />;

  return (
    <div className="quiz-answer-editor">
      <LearnerEditor
        editor={editor}
        disabled={disabled}
        busy={uploading}
        contextKey={questionId}
        translate={(key: LearnerEditorKey) =>
          text(`learnerEditor.${key}`, learnerEditorFallback[key])
        }
        options={{
          formatting: 'full',
          math: true,
          images: !!uploadAsset,
          attachments: allowAttachments,
        }}
        onImages={uploadImages}
        onBusyChange={notifyBusy}
        remainingImages={QUIZ_ANSWER_MAX_ASSETS - assetCount}
        toolbarClassName="quiz-answer-editor__toolbar"
        toolbarLabel={text('reachDeck.player.quiz.answer.toolbar', '答案格式')}
        customFormattingToolbar={
          <>
            <Tool
              active={editor.isActive('bold')}
              disabled={disabled}
              label={text('reachDeck.editor.richText.mark.bold', '粗体')}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold aria-hidden="true" size={14} />
            </Tool>
            <Tool
              active={editor.isActive('italic')}
              disabled={disabled}
              label={text('reachDeck.editor.richText.mark.italic', '斜体')}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic aria-hidden="true" size={14} />
            </Tool>
            <Tool
              disabled={disabled}
              label={text('reachDeck.editor.richText.insertInlineMath', '行内公式')}
              onClick={() => insertMathAndActivate(editor, { displayMode: false })}
            >
              <Sigma aria-hidden="true" size={14} />
            </Tool>
            <details className="quiz-answer-editor__more-formatting">
              <summary>{text('reachDeck.player.quiz.answer.moreFormatting', '更多格式')}</summary>
              <div className="quiz-answer-editor__advanced-formatting">
                <Tool
                  disabled={disabled || !editor.can().undo()}
                  label={text('reachDeck.editor.richText.undo', '撤销')}
                  onClick={() => editor.chain().focus().undo().run()}
                >
                  <Undo2 aria-hidden="true" size={14} />
                </Tool>
                <Tool
                  disabled={disabled || !editor.can().redo()}
                  label={text('reachDeck.editor.richText.redo', '重做')}
                  onClick={() => editor.chain().focus().redo().run()}
                >
                  <Redo2 aria-hidden="true" size={14} />
                </Tool>
                <select
                  aria-label={text('reachDeck.player.quiz.answer.paragraphStyle', '段落样式')}
                  disabled={disabled}
                  onChange={(event) => {
                    const level = Number(event.target.value);
                    if (level === 0) editor.chain().focus().setParagraph().run();
                    else if (level === 2 || level === 3) {
                      editor.chain().focus().setHeading({ level }).run();
                    }
                  }}
                  value={
                    editor.isActive('heading', { level: 2 })
                      ? '2'
                      : editor.isActive('heading', { level: 3 })
                        ? '3'
                        : '0'
                  }
                >
                  <option value="0">{text('reachDeck.player.quiz.answer.body', '正文')}</option>
                  <option value="2">
                    {text('reachDeck.player.quiz.answer.heading2', '二级标题')}
                  </option>
                  <option value="3">
                    {text('reachDeck.player.quiz.answer.heading3', '三级标题')}
                  </option>
                </select>
                <select
                  aria-label={text('reachDeck.editor.richText.font', '字体')}
                  disabled={disabled}
                  onChange={(event) => {
                    const family = event.target.value;
                    if (family) editor.chain().focus().setFontFamily(family).run();
                    else editor.chain().focus().unsetFontFamily().run();
                  }}
                  value={
                    RICH_TEXT_FONT_FAMILIES.find((family) =>
                      editor.isActive('textStyle', { fontFamily: family }),
                    ) ?? ''
                  }
                >
                  <option value="">
                    {text('reachDeck.player.quiz.answer.defaultFont', '平台默认字体')}
                  </option>
                  {RICH_TEXT_FONT_FAMILIES.map((family) => (
                    <option key={family} value={family}>
                      {family}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={text('reachDeck.editor.richText.fontSize', '字号')}
                  disabled={disabled}
                  onChange={(event) => {
                    const size = event.target.value;
                    if (size) editor.chain().focus().setFontSize(`${size}px`).run();
                    else editor.chain().focus().unsetFontSize().run();
                  }}
                  value={
                    ANSWER_FONT_SIZES.map(String).find((size) =>
                      editor.isActive('textStyle', { fontSize: `${size}px` }),
                    ) ?? ''
                  }
                >
                  <option value="">
                    {text('reachDeck.editor.richText.defaultFontSize', '默认字号')}
                  </option>
                  {ANSWER_FONT_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>

                <Tool
                  active={editor.isActive('underline')}
                  disabled={disabled}
                  label={text('reachDeck.editor.richText.mark.underline', '下划线')}
                  onClick={() => editor.chain().focus().toggleUnderline().run()}
                >
                  <Underline aria-hidden="true" size={14} />
                </Tool>
                <Tool
                  active={editor.isActive('strike')}
                  disabled={disabled}
                  label={text('reachDeck.editor.richText.mark.strike', '删除线')}
                  onClick={() => editor.chain().focus().toggleStrike().run()}
                >
                  <Strikethrough aria-hidden="true" size={14} />
                </Tool>
                <Tool
                  active={editor.isActive('superscript')}
                  disabled={disabled}
                  label={text('reachDeck.editor.richText.mark.superscript', '上标')}
                  onClick={() => editor.chain().focus().toggleMark('superscript').run()}
                >
                  <Superscript aria-hidden="true" size={14} />
                </Tool>
                <Tool
                  active={editor.isActive('subscript')}
                  disabled={disabled}
                  label={text('reachDeck.editor.richText.mark.subscript', '下标')}
                  onClick={() => editor.chain().focus().toggleMark('subscript').run()}
                >
                  <Subscript aria-hidden="true" size={14} />
                </Tool>
                <Tool
                  active={editor.isActive('bulletList')}
                  disabled={disabled}
                  label={text('reachDeck.player.quiz.answer.bulletList', '项目列表')}
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                >
                  <List aria-hidden="true" size={14} />
                </Tool>
                <Tool
                  active={editor.isActive('orderedList')}
                  disabled={disabled}
                  label={text('reachDeck.player.quiz.answer.orderedList', '编号列表')}
                  onClick={() => editor.chain().focus().toggleOrderedList().run()}
                >
                  <ListOrdered aria-hidden="true" size={14} />
                </Tool>
                <Tool
                  active={editor.isActive('blockquote')}
                  disabled={disabled}
                  label={text('reachDeck.player.quiz.answer.blockquote', '引用')}
                  onClick={() => editor.chain().focus().toggleBlockquote().run()}
                >
                  <Quote aria-hidden="true" size={14} />
                </Tool>
                <Tool
                  active={editor.isActive('codeBlock')}
                  disabled={disabled}
                  label={text('reachDeck.player.quiz.answer.codeBlock', '代码块')}
                  onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                >
                  <Code aria-hidden="true" size={14} />
                </Tool>

                <Tool
                  disabled={disabled}
                  label={text('reachDeck.editor.richText.insertBlockMath', '独立公式')}
                  onClick={() => insertMathAndActivate(editor, { displayMode: true })}
                >
                  <Braces aria-hidden="true" size={14} />
                </Tool>
                <label
                  className="quiz-answer-editor__color"
                  title={text('reachDeck.editor.richText.textColor', '文字颜色')}
                >
                  <Palette aria-hidden="true" size={14} />
                  <input
                    aria-label={text('reachDeck.editor.richText.textColor', '文字颜色')}
                    disabled={disabled}
                    onChange={(event) => editor.chain().focus().setColor(event.target.value).run()}
                    type="color"
                    value={String(editor.getAttributes('textStyle').color ?? '#172024')}
                  />
                </label>
                <label
                  className="quiz-answer-editor__color"
                  title={text('reachDeck.editor.richText.backgroundColor', '背景色')}
                >
                  <Highlighter aria-hidden="true" size={14} />
                  <input
                    aria-label={text('reachDeck.editor.richText.backgroundColor', '背景色')}
                    disabled={disabled}
                    onChange={(event) =>
                      editor.chain().focus().setBackgroundColor(event.target.value).run()
                    }
                    type="color"
                    value={String(editor.getAttributes('textStyle').backgroundColor ?? '#ffffff')}
                  />
                </label>
                {(['left', 'center', 'right', 'justify'] as const).map((alignment) => {
                  const Icon = ALIGNMENT_ICONS[alignment];
                  return (
                    <Tool
                      disabled={disabled}
                      key={alignment}
                      active={editor.isActive({ textAlign: alignment })}
                      label={text('reachDeck.player.quiz.answer.align', '文本{alignment}', {
                        alignment: text(
                          ALIGNMENT_LABELS[alignment][0],
                          ALIGNMENT_LABELS[alignment][1],
                        ),
                      })}
                      onClick={() => editor.chain().focus().setTextAlign(alignment).run()}
                    >
                      <Icon aria-hidden="true" size={14} />
                    </Tool>
                  );
                })}
                <Tool
                  disabled={disabled}
                  label={text('reachDeck.editor.richText.clearFormatting', '清除格式')}
                  onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
                >
                  <Eraser aria-hidden="true" size={14} />
                </Tool>
              </div>
            </details>
          </>
        }
        attachments={
          allowAttachments ? (
            <div className="quiz-answer-editor__attachments">
              {uploadAsset ? (
                <button
                  className="quiz-answer-editor__attach-action"
                  disabled={
                    !uploadAsset || disabled || uploading || assetCount >= QUIZ_ANSWER_MAX_ASSETS
                  }
                  onClick={() => attachmentInputRef.current?.click()}
                  type="button"
                >
                  <Paperclip aria-hidden="true" size={16} />
                  {text('reachDeck.player.quiz.answer.chooseAttachments', '选择多个附件')}
                </button>
              ) : null}
              {uploadAsset ? (
                <input
                  hidden
                  multiple
                  onChange={(event) => {
                    void uploadAttachments(Array.from(event.target.files ?? []));
                    event.target.value = '';
                  }}
                  ref={attachmentInputRef}
                  type="file"
                />
              ) : null}
              <ReachDeckAttachmentList
                questionId={questionId}
                attachments={value.attachments}
                resolveAttachmentUrl={resolveAttachmentUrl}
                mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                translate={translate}
                renderActions={(attachment, index) =>
                  disabled ? null : (
                    <>
                      <IconButton
                        icon={<ArrowUp />}
                        size="sm"
                        label={text('reachDeck.player.quiz.answer.moveUp', '上移 {name}', {
                          name: attachment.name,
                        })}
                        disabled={disabled || uploading || index === 0}
                        onClick={() =>
                          onChange({
                            ...value,
                            attachments: moveAttachment(value.attachments, index, -1),
                          })
                        }
                        type="button"
                      />
                      <IconButton
                        icon={<ArrowDown />}
                        size="sm"
                        label={text('reachDeck.player.quiz.answer.moveDown', '下移 {name}', {
                          name: attachment.name,
                        })}
                        disabled={disabled || uploading || index === value.attachments.length - 1}
                        onClick={() =>
                          onChange({
                            ...value,
                            attachments: moveAttachment(value.attachments, index, 1),
                          })
                        }
                        type="button"
                      />
                      <IconButton
                        icon={<Trash2 />}
                        size="sm"
                        label={text('reachDeck.player.quiz.answer.removeNamed', '移除 {name}', {
                          name: attachment.name,
                        })}
                        disabled={disabled || uploading}
                        onClick={() =>
                          onChange({
                            ...value,
                            attachments: normalizeAttachmentOrder(
                              value.attachments.filter((_, current) => current !== index),
                            ),
                          })
                        }
                        type="button"
                      />
                    </>
                  )
                }
              />
            </div>
          ) : null
        }
      />
      {uploading ? <p>{text('reachDeck.player.quiz.answer.uploading', '正在上传…')}</p> : null}
      {uploadError ? <p role="alert">{uploadError}</p> : null}
    </div>
  );
}

function Tool({
  active,
  children,
  disabled = false,
  label,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className="quiz-answer-editor__tool"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function normalizeAttachmentOrder(attachments: QuizAttachmentReference[]) {
  return attachments.map((attachment, order) => ({ ...attachment, order }));
}

function moveAttachment(
  attachments: QuizAttachmentReference[],
  index: number,
  delta: -1 | 1,
): QuizAttachmentReference[] {
  const destination = index + delta;
  if (destination < 0 || destination >= attachments.length) return attachments;
  const next = [...attachments];
  const [attachment] = next.splice(index, 1);
  next.splice(destination, 0, attachment);
  return normalizeAttachmentOrder(next);
}
