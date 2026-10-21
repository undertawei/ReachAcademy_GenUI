'use client';

import { Extension, Mark, Node, type NodeViewRenderer } from '@tiptap/core';
import {
  DOMParser as ProseMirrorDOMParser,
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
  type Schema,
} from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { createPortal } from 'react-dom';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Braces,
  Eraser,
  Highlighter,
  ImagePlus,
  Italic,
  Palette,
  Plus,
  Redo2,
  Sigma,
  Strikethrough,
  Subscript,
  Superscript,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  firstSupportedClipboardImage,
  hasInternalClipboardToken,
  isProseMirrorClipboardSlice,
  markTrustedProseMirrorClipboardHtml,
  normalizeClipboardImageFile,
  writeInternalClipboardToken,
} from '@reachany/clipboard-content';
import {
  REACH_DECK_SPEECH_BREAK_NODE_TYPE,
  REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
  REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE,
  allocateQuizBlankId,
  analyzeReachDeckNarrationMarkdown,
  canonicalizeReachDeckNarrationMarkdownOffsets,
  canonicalizeReachDeckSpeechMarkupV1,
  collectQuizBlankIds,
  normalizeRichText,
  countQuizBlankNodes,
  QUIZ_BLANK_NODE_TYPE,
  REACH_DECK_BUILT_IN_FONT_FAMILIES,
  richTextHasRenderableContent,
  richTextMaximumFontSize,
  parseReachDeckNarrationSpeechDocument,
  parseReachDeckNarrationMarkdown,
  planReachDeckSsmlChunks,
  reachDeckSpeechRichTextDefinition,
  serializeReachDeckNarrationSpeechDocument,
  serializeReachDeckNarrationMarkdown,
  type ReachDeckSpeechMarkV1,
  type ReachDeckSpeechRichTextDefinition,
  type RichTextDocument,
  type RichTextFontFamily,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';
import {
  createReachDeckTextExtensions,
  REACH_DECK_CLIPBOARD_MAX_DEPTH,
  REACH_DECK_CLIPBOARD_MAX_NODES,
  richTextFromClipboardHtml,
  richTextFromClipboardPlainText,
  transformReachDeckPastedHtml,
  type ReachDeckClipboardSurface,
} from '@reachany/reach-deck-rich-text';
import { createMathLiveNodeView, insertMathAndActivate } from '@reachany/tiptap-mathlive';
import { CLIPBOARD_IMAGE_EXTENSIONS } from './authoringMedia.js';
import { translateReachDeck, type ReachDeckTranslate } from '@reachany/reach-deck-player';
import { Select } from '@reachany/ui';
import {
  escapeNarrationXml,
  NARRATION_SSML_LIKE,
  narrationSsmlNodes,
  readNarrationClipboard,
  writeNarrationClipboard,
} from './narrationClipboard.js';

/** 字号档位（px）。覆盖 TYPOGRAPHY_TOKENS 的基准字号，供局部调整用。 */
const FONT_SIZES = [16, 20, 22, 24, 28, 30, 36, 40, 48, 56, 64, 72, 88] as const;

const TEXT_ALIGNMENTS = [
  { value: 'left', label: '左对齐', Icon: AlignLeft },
  { value: 'center', label: '居中', Icon: AlignCenter },
  { value: 'right', label: '右对齐', Icon: AlignRight },
  { value: 'justify', label: '两端对齐', Icon: AlignJustify },
] as const;

const INLINE_MARK_BUTTONS = [
  { mark: 'bold', label: '粗体', Icon: Bold },
  { mark: 'italic', label: '斜体', Icon: Italic },
  { mark: 'strike', label: '删除线', Icon: Strikethrough },
  { mark: 'underline', label: '下划线', Icon: UnderlineIcon },
  { mark: 'superscript', label: '上标', Icon: Superscript },
  { mark: 'subscript', label: '下标', Icon: Subscript },
] as const;

const NARRATION_SPEECH_ACTION_META = 'reachDeckNarrationSpeechAction';
const NARRATION_SPEECH_INVALIDATION_META = 'reachDeckNarrationSpeechInvalidation';

let narrationSpeechIdSequence = 0;

export interface NarrationSpeechSelection {
  active?: ReachDeckSpeechRichTextDefinition;
  empty: boolean;
  markdownFrom: number;
  markdownTo: number;
  text: string;
}

export type NarrationSpeechCommandResult =
  | { applied: true }
  | { applied: false; reason: 'invalid-selection' | 'no-active-mark' };

export type NarrationSpeechSpanDefinitionInput =
  | Omit<Extract<ReachDeckSpeechRichTextDefinition, { type: 'sub' }>, 'id'>
  | Omit<Extract<ReachDeckSpeechRichTextDefinition, { type: 'say-as' }>, 'id'>
  | Omit<Extract<ReachDeckSpeechRichTextDefinition, { type: 'phoneme' }>, 'id'>;

/** 上传成功后写进图片节点的稳定元数据；展示地址不在其中，也不会进文档。 */
export interface RichTextUploadedImage {
  contentType: string;
  name: string;
  objectKey: string;
  sizeBytes: number;
}

/**
 * 测验富文本字段的行内图片能力。
 *
 * 由宿主（ReachDeckEditor）提供 —— 上传要落到教师受信的媒体通道，展示 URL 要由宿主的媒体
 * 协调器周期重签。字段本身只负责插节点与限额提示。
 */
export interface RichTextImageInsertion {
  /** `<input type="file">` 的 accept 提示。 */
  accept: string;
  maxBytes: number;
  maxImages: number;
  /** 本题还能再插几张；<= 0 时禁用插入并给出限额提示。 */
  remaining: number;
  /** 稳定 objectKey → 短时展示 URL。引用变化会触发已挂载图片节点重绘。 */
  urlsByObjectKey: Readonly<Record<string, string>>;
  /** 返回 undefined 表示目标已失效（切页/锁定），调用方据此给出提示而不插入。 */
  upload: (file: File, signal: AbortSignal) => Promise<RichTextUploadedImage | undefined>;
}

export interface NarrationSpeechEditorHandle {
  applySourceMark(mark: ReachDeckSpeechMarkV1): NarrationSpeechCommandResult;
  applySpan(definition: NarrationSpeechSpanDefinitionInput): NarrationSpeechCommandResult;
  insertBreak(durationMs: number): NarrationSpeechCommandResult;
  insertSoundEvent(src: string): NarrationSpeechCommandResult;
  readSelection(): NarrationSpeechSelection;
  removeActive(): NarrationSpeechCommandResult;
}

/** 常驻的 PowerPoint 式格式栏；进入画布文本编辑后由真实 Tiptap 工具栏原位接管。 */
export function RichTextToolbarPlaceholder({ translate }: { translate?: ReachDeckTranslate } = {}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  return (
    <div
      aria-label={text('reachDeck.editor.richText.format', '文本格式')}
      className="reach-deck-editor__rich-text-toolbar"
      data-placeholder="true"
      role="toolbar"
    >
      <span className="reach-deck-editor__toolbar-scope is-placeholder">
        {text('reachDeck.editor.richText.scope', '文字')}
      </span>
      <span className="reach-deck-editor__rich-text-divider" />
      <button
        aria-label={text('reachDeck.editor.richText.undo', '撤销')}
        className="reach-deck-editor__rich-text-button"
        disabled
        type="button"
      >
        <Undo2 size={14} />
      </button>
      <button
        aria-label={text('reachDeck.editor.richText.redo', '重做')}
        className="reach-deck-editor__rich-text-button"
        disabled
        type="button"
      >
        <Redo2 size={14} />
      </button>
      <span className="reach-deck-editor__rich-text-divider" />
      <label className="reach-deck-editor__rich-text-field">
        <span className="sr-only">{text('reachDeck.editor.richText.font', '字体')}</span>
        <Select<RichTextFontFamily>
          aria-label={text('reachDeck.editor.richText.font', '字体')}
          disabled
          onChange={() => undefined}
          options={REACH_DECK_BUILT_IN_FONT_FAMILIES.map((family) => ({
            label: family,
            value: family,
          }))}
          portal
          value="Source Han Sans VF"
        />
      </label>
      <label className="reach-deck-editor__rich-text-field">
        <span className="sr-only">{text('reachDeck.editor.richText.fontSize', '字号')}</span>
        <Select
          aria-label={text('reachDeck.editor.richText.fontSize', '字号')}
          disabled
          onChange={() => undefined}
          options={[]}
          placeholder="—"
          portal
          value={undefined}
        />
      </label>
      <span className="reach-deck-editor__rich-text-divider" />
      {INLINE_MARK_BUTTONS.map(({ mark, label, Icon }) => (
        <button
          aria-label={text(`reachDeck.editor.richText.mark.${mark}`, label)}
          className="reach-deck-editor__rich-text-button"
          disabled
          key={label}
          type="button"
        >
          <Icon size={14} />
        </button>
      ))}
      <span className="reach-deck-editor__rich-text-divider" />
      <span aria-hidden="true" className="reach-deck-editor__rich-text-color is-placeholder">
        <Palette size={14} />
      </span>
      <span aria-hidden="true" className="reach-deck-editor__rich-text-color is-placeholder">
        <Highlighter size={14} />
      </span>
      <button
        aria-label={text('reachDeck.editor.richText.clearFormatting', '清除格式')}
        className="reach-deck-editor__rich-text-button"
        disabled
        type="button"
      >
        <Eraser size={14} />
      </button>
      <span className="reach-deck-editor__rich-text-divider" />
      {TEXT_ALIGNMENTS.map(({ value, label, Icon }) => (
        <button
          aria-label={text(`reachDeck.editor.richText.align.${value}`, label)}
          className="reach-deck-editor__rich-text-button"
          disabled
          key={label}
          type="button"
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}

/**
 * 文本元素的富文本编辑面板。
 *
 * 用 tiptap（与 portal 的 QuizRichTextEditor 同一套做法）：存 `getJSON()`，
 * schema 来自 `createReachDeckTextExtensions()` —— 与服务端 HTML→JSON 转换共用，
 * 保证两侧对同一段内容的理解一致。
 */
export function RichTextElementEditor({
  defaultFontFamily = 'Source Han Sans VF',
  defaultFontSize,
  defaultFontWeight = 400,
  disabled = false,
  formatWholeDocument = false,
  historyGroup,
  imageInsertion,
  inline = false,
  allowQuizBlankInsertion = false,
  label,
  onChange,
  surface = 'slide',
  onCancel,
  onDone,
  onHistoryGroupEnd,
  showFontControls = true,
  toolbarTarget,
  toolbarOnly = false,
  toolbarVariant = 'full',
  toolbarVisibility = 'always',
  translate,
  value,
  narrationSpeechControllerRef,
  narrationToolbarContent,
  onNarrationSpeechInvalidated,
  onNarrationSpeechPasteFallback,
  onNarrationSpeechSelectionChange,
  showNarrationSpeechTags = false,
  allowNarrationBreakPaste = true,
  allowedNarrationSpeechMarkTypes,
  narrationSingleParagraph = false,
}: {
  defaultFontFamily?: RichTextFontFamily;
  defaultFontSize?: number;
  defaultFontWeight?: number;
  disabled?: boolean;
  formatWholeDocument?: boolean;
  historyGroup?: string;
  /**
   * 行内图片能力。**有无必须在编辑器实例生命周期内保持稳定** —— `useEditor` 没有依赖数组，
   * extensions 只构建一次，中途开关不会改变 schema。
   */
  imageInsertion?: RichTextImageInsertion;
  inline?: boolean;
  allowQuizBlankInsertion?: boolean;
  /**
   * 结构能力档位。`document` 额外接受标题与表格，使从 Word 复制过来的题干保留结构；
   * 幻灯片文本框保持 `slide`。与 `imageInsertion` 同样的约束：**编辑器实例生命周期内必须稳定**。
   */
  surface?: ReachDeckClipboardSurface;
  label: string;
  onChange: (document: RichTextDocument, metadata?: { historyGroup?: string }) => void;
  onCancel?: () => void;
  onDone?: () => void;
  onHistoryGroupEnd?: () => void;
  showFontControls?: boolean;
  toolbarTarget?: HTMLElement | null;
  toolbarOnly?: boolean;
  /** Narration authoring intentionally exposes only history and formula insertion. */
  toolbarVariant?: 'full' | 'narration';
  toolbarVisibility?: 'always' | 'focus';
  translate?: ReachDeckTranslate;
  value: RichTextDocument;
  narrationSpeechControllerRef?: Ref<NarrationSpeechEditorHandle>;
  narrationToolbarContent?: ReactNode;
  onNarrationSpeechInvalidated?: (count: number) => void;
  onNarrationSpeechPasteFallback?: () => void;
  onNarrationSpeechSelectionChange?: (selection: NarrationSpeechSelection) => void;
  showNarrationSpeechTags?: boolean;
  allowNarrationBreakPaste?: boolean;
  allowedNarrationSpeechMarkTypes?: readonly ReachDeckSpeechMarkV1['type'][];
  /**
   * 讲稿单段落模式（Interactive 页）：文档恒为一个段落，不接受硬换行与独立公式；回车不分段，
   * 粘贴内容的换行折叠为一个空格。与 extensions 一样，**编辑器实例生命周期内必须稳定**。
   */
  narrationSingleParagraph?: boolean;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  // 最近一次「已知内容」的序列化形态。onUpdate 与之相同时说明是 tiptap 自己
  // 补齐属性 / 挂载引起的空转，不是教师编辑，不能上报 —— 否则选中一个文本元素
  // 就会把文档标脏并递增 revision。
  const knownValueRef = useRef(stableRichTextSerialization(value));
  const selectionRef = useRef<{ from: number; to: number } | undefined>(undefined);
  const appliedColorRef = useRef<{ background?: string; text?: string }>({});
  const colorInteractionRef = useRef<string | undefined>(undefined);
  const colorInteractionSequenceRef = useRef(0);
  const historyGroupRef = useRef(historyGroup);
  const trustedInternalPasteRef = useRef(false);
  const rejectedPasteRef = useRef(false);
  const preparedPasteHtmlRef = useRef<{ input: string; output: string } | undefined>(undefined);
  const narrationBreakPasteRef = useRef(false);
  // extensions 与粘贴回调只构建一次，单段落档位在实例生命周期内固定。
  const narrationSingleParagraphRef = useRef(
    toolbarVariant === 'narration' && narrationSingleParagraph,
  );
  const allowedNarrationSpeechMarkTypesRef = useRef<readonly ReachDeckSpeechMarkV1['type'][]>([]);
  allowedNarrationSpeechMarkTypesRef.current =
    allowedNarrationSpeechMarkTypes ??
    (allowNarrationBreakPaste
      ? ['break', 'soundEvent', 'sub', 'say-as', 'phoneme']
      : ['soundEvent', 'sub', 'say-as', 'phoneme']);
  const narrationSpeechPasteFallbackRef = useRef(onNarrationSpeechPasteFallback);
  narrationSpeechPasteFallbackRef.current = onNarrationSpeechPasteFallback;
  historyGroupRef.current = historyGroup;
  const narrationSpeechInvalidatedRef = useRef(onNarrationSpeechInvalidated);
  narrationSpeechInvalidatedRef.current = onNarrationSpeechInvalidated;
  const narrationSpeechSelectionChangeRef = useRef(onNarrationSpeechSelectionChange);
  narrationSpeechSelectionChangeRef.current = onNarrationSpeechSelectionChange;
  const imageInsertionRef = useRef(imageInsertion);
  imageInsertionRef.current = imageInsertion;
  // extensions 只构建一次，档位在实例生命周期内固定；粘贴路径也读这个定值。
  const surfaceRef = useRef(surface);
  const imageRepaintListenersRef = useRef(new Set<() => void>());
  const imageUrlSourceRef = useRef<QuizImageUrlSource>({
    resolve: (objectKey) => imageInsertionRef.current?.urlsByObjectKey[objectKey],
    subscribe: (listener) => {
      const listeners = imageRepaintListenersRef.current;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageUploadAbortRef = useRef<AbortController | undefined>(undefined);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState('');
  const imageNodeViewRef = useRef<NodeViewRenderer | undefined>(undefined);
  if (imageInsertion !== undefined && imageNodeViewRef.current === undefined) {
    imageNodeViewRef.current = createRichTextImageNodeView(imageUrlSourceRef.current, text);
  }

  const editor = useEditor({
    content: value,
    editable: !disabled,
    editorProps: {
      attributes: {
        'aria-label': label,
        class: 'reach-deck-editor__rich-text-surface',
      },
      transformPastedHTML: (html) => {
        rejectedPasteRef.current = false;
        try {
          const prepared = preparedPasteHtmlRef.current;
          preparedPasteHtmlRef.current = undefined;
          if (prepared?.input === html) return prepared.output;
          const trustedInternal = trustedInternalPasteRef.current;
          trustedInternalPasteRef.current = false;
          if (trustedInternal && isProseMirrorClipboardSlice(html)) {
            const output = markTrustedProseMirrorClipboardHtml(html);
            if (html.length > 0 && output.length === 0) rejectedPasteRef.current = true;
            return output;
          }
          const output = transformReachDeckPastedHtml(html, surfaceRef.current);
          if (html.length > 0 && output.length === 0) rejectedPasteRef.current = true;
          return output;
        } catch {
          rejectedPasteRef.current = true;
          return '';
        }
      },
      transformPastedText: (plainText) => {
        rejectedPasteRef.current = false;
        try {
          richTextFromClipboardPlainText(plainText);
          return plainText;
        } catch {
          rejectedPasteRef.current = true;
          return '';
        }
      },
      transformPasted: (pasted, view) => {
        // 单段落讲稿：先把粘贴/拖入内容折叠成行内片段，后续转换与校验都基于折叠结果。
        const slice = narrationSingleParagraphRef.current
          ? foldSliceToSingleParagraph(pasted, view.state.schema)
          : pasted;
        if (!narrationBreakPasteRef.current) return slice;
        const {
          converted,
          hasLiteralBreak,
          slice: transformed,
        } = convertNarrationBreakPasteSlice(
          slice,
          view.state.schema,
          view.state.selection.$from.parentOffset > 0,
          view.state.selection.$to.parentOffset < view.state.selection.$to.parent.content.size,
          allowedNarrationSpeechMarkTypesRef.current,
        );
        if (converted === 0) {
          queueMicrotask(() => narrationSpeechPasteFallbackRef.current?.());
          return slice;
        }
        try {
          const transaction = view.state.tr.replaceSelection(transformed);
          if (narrationPasteTransactionValid(transaction)) {
            if (hasLiteralBreak) {
              queueMicrotask(() => narrationSpeechPasteFallbackRef.current?.());
            }
            return transformed;
          }
        } catch {
          // The original plain-text slice remains safe to paste as visible text.
        }
        queueMicrotask(() => narrationSpeechPasteFallbackRef.current?.());
        return slice;
      },
      handlePaste: (view, event, slice) => {
        if (narrationBreakPasteRef.current) {
          view.dispatch(
            closeHistory(view.state.tr)
              .replaceSelection(slice)
              .scrollIntoView()
              .setMeta('paste', true)
              .setMeta('uiEvent', 'paste'),
          );
          return true;
        }
        if (!rejectedPasteRef.current) return false;
        rejectedPasteRef.current = false;
        event.preventDefault();
        return true;
      },
    },
    extensions: [
      ...createReachDeckTextExtensions({
        blockMathNodeView: createMathLiveNodeView({
          displayMode: true,
          label: text('reachDeck.editor.richText.editBlockMath', '编辑独立公式'),
        }),
        inlineMathNodeView: createMathLiveNodeView({
          displayMode: false,
          label: text('reachDeck.editor.richText.editInlineMath', '编辑行内公式'),
        }),
        ...(imageNodeViewRef.current === undefined
          ? {}
          : { imageNode: true, imageNodeView: imageNodeViewRef.current }),
        richBlocks: surfaceRef.current === 'document',
      }),
      ...(allowQuizBlankInsertion ? [createQuizBlankExtension(text)] : []),
      ...(toolbarVariant === 'narration'
        ? [
            ReachDeckNarrationSpeechMark,
            createNarrationSpeechBreakExtension(text),
            createNarrationSpeechSoundEventExtension(text),
            narrationSingleParagraphRef.current
              ? NarrationSingleParagraphDocumentGuard
              : NarrationDocumentGuard,
            ...(narrationSingleParagraphRef.current ? [NarrationSingleParagraphKeymap] : []),
            createNarrationSpeechIntegrityExtension((count) =>
              narrationSpeechInvalidatedRef.current?.(count),
            ),
          ]
        : []),
    ],
    immediatelyRender: false,
    onUpdate: ({ editor: current }) => {
      // 归一化剔除 tiptap 补齐的空属性（如 TextAlign 的 textAlign: null），
      // 使比较基于内容而非 tiptap 的内部形态。
      const next = cleanRichTextForPersistence(normalizeRichText(current.getJSON()));
      const serialized = stableRichTextSerialization(next);
      if (serialized === knownValueRef.current) return;
      knownValueRef.current = serialized;
      onChange(
        next,
        colorInteractionRef.current === undefined && historyGroupRef.current === undefined
          ? undefined
          : { historyGroup: colorInteractionRef.current ?? historyGroupRef.current },
      );
    },
  });

  // 外部（撤销 / Decksmith 应用修改 / 切换元素）改了文档时同步进编辑器。
  // 比较归一后的结果，避免把自己刚发出的内容再写回去造成光标跳动。
  useEffect(() => {
    if (!editor) return;
    const serialized = stableRichTextSerialization(value);
    knownValueRef.current = serialized;
    if (stableRichTextSerialization(normalizeRichText(editor.getJSON())) === serialized) return;
    appliedColorRef.current = {};
    colorInteractionRef.current = undefined;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  // 换签后的新地址直接重绘已挂载的图片节点：不发 transaction、不进撤销栈、不动光标，
  // 文档因此永远不知道 URL 存在（易失 URL 进文档会打乱 revision token）。
  useEffect(() => {
    for (const repaint of imageRepaintListenersRef.current) repaint();
  }, [imageInsertion?.urlsByObjectKey]);

  useEffect(
    () => () => {
      imageUploadAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    editor?.view.dom.classList.toggle(
      'reach-deck-editor__rich-text-surface--show-speech-tags',
      showNarrationSpeechTags,
    );
  }, [editor, showNarrationSpeechTags]);

  // 下拉框会把浏览器焦点移出 ProseMirror。显式记住最后一个编辑器选区，
  // 字体 / 字号命令执行前恢复它，避免命令落到光标而不是教师框选的字符上。
  useEffect(() => {
    if (!editor) return;
    const rememberSelection = () => {
      const { from, to } = editor.state.selection;
      selectionRef.current = { from, to };
    };
    rememberSelection();
    editor.on('selectionUpdate', rememberSelection);
    const reportNarrationSpeechSelection = () => {
      narrationSpeechSelectionChangeRef.current?.(readNarrationSpeechSelection(editor));
    };
    reportNarrationSpeechSelection();
    editor.on('selectionUpdate', reportNarrationSpeechSelection);
    editor.on('update', reportNarrationSpeechSelection);
    return () => {
      editor.off('selectionUpdate', rememberSelection);
      editor.off('selectionUpdate', reportNarrationSpeechSelection);
      editor.off('update', reportNarrationSpeechSelection);
    };
  }, [editor]);

  useImperativeHandle(
    narrationSpeechControllerRef,
    () => ({
      applySourceMark: (mark) => applyNarrationSourceMark(editor, mark),
      applySpan: (definition) => applyNarrationSpeechSpan(editor, selectionRef.current, definition),
      insertBreak: (durationMs) =>
        insertNarrationSpeechBreak(editor, selectionRef.current, durationMs),
      insertSoundEvent: (src) => insertNarrationSpeechSoundEvent(editor, selectionRef.current, src),
      readSelection: () => readNarrationSpeechSourceSelection(editor, selectionRef.current),
      removeActive: () => removeActiveNarrationSpeech(editor, selectionRef.current),
    }),
    [editor],
  );

  useEffect(() => {
    if (inline && editor) editor.commands.focus('end');
  }, [editor, inline]);

  if (!editor) return <div className="reach-deck-editor__rich-text" />;

  const activeEditor = editor;
  const imageMegabytes = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

  /** 校验并上传一张图片，成功后就地插入。返回 false 表示已给出错误提示、未插入。 */
  const uploadAndInsertImage = async (file: File): Promise<boolean> => {
    const insertion = imageInsertionRef.current;
    if (insertion === undefined || disabled || toolbarOnly) return false;
    setImageError('');
    if (insertion.remaining <= 0) {
      setImageError(
        text('reachDeck.editor.quiz.image.maxCount', '每道题最多插入 {count} 张图片。', {
          count: insertion.maxImages,
        }),
      );
      return false;
    }
    if (CLIPBOARD_IMAGE_EXTENSIONS[file.type.toLowerCase()] === undefined) {
      setImageError(
        text('reachDeck.editor.quiz.image.unsupported', '只支持 PNG、JPEG、WebP、GIF 图片。'),
      );
      return false;
    }
    if (file.size === 0 || file.size > insertion.maxBytes) {
      setImageError(
        text('reachDeck.editor.quiz.image.tooLarge', '单张图片不得超过 {size} MB。', {
          size: imageMegabytes(insertion.maxBytes),
        }),
      );
      return false;
    }
    if (imageUploadAbortRef.current !== undefined) return false;

    // 触发时的光标位置：上传是异步的，期间教师可能已经把光标移走。
    const insertAt = activeEditor.state.selection.from;
    const abortController = new AbortController();
    imageUploadAbortRef.current = abortController;
    setImageUploading(true);
    try {
      const uploaded = await insertion.upload(file, abortController.signal);
      if (abortController.signal.aborted) return false;
      if (uploaded === undefined) {
        setImageError(
          text(
            'reachDeck.editor.media.targetChanged',
            '上传已完成，但目标页面已切换、删除或锁定，未插入媒体。',
          ),
        );
        return false;
      }
      const node = {
        type: 'image',
        attrs: {
          alt: uploaded.name,
          contentType: uploaded.contentType,
          name: uploaded.name,
          objectKey: uploaded.objectKey,
          sizeBytes: uploaded.sizeBytes,
        },
      };
      const documentSize = activeEditor.state.doc.content.size;
      if (insertAt <= documentSize) {
        activeEditor.chain().focus().insertContentAt(insertAt, node).run();
      } else {
        activeEditor.chain().focus('end').insertContent(node).run();
      }
      return true;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        setImageError(
          text('reachDeck.editor.quiz.image.uploadFailed', '图片上传失败，请检查文件后重试。'),
        );
      }
      return false;
    } finally {
      if (imageUploadAbortRef.current === abortController) {
        imageUploadAbortRef.current = undefined;
        setImageUploading(false);
      }
    }
  };

  const rememberDomSelection = () => {
    if (formatWholeDocument) return;
    const selection = window.getSelection();
    if (!selection?.anchorNode || !selection.focusNode) return;
    const anchorElement =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode.parentElement;
    const focusElement =
      selection.focusNode instanceof Element
        ? selection.focusNode
        : selection.focusNode.parentElement;
    if (!anchorElement || !focusElement) return;
    if (!editor.view.dom.contains(anchorElement) || !editor.view.dom.contains(focusElement)) return;
    try {
      const anchor = editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset);
      const focus = editor.view.posAtDOM(selection.focusNode, selection.focusOffset);
      const nextSelection = { from: Math.min(anchor, focus), to: Math.max(anchor, focus) };
      if (
        nextSelection.from === nextSelection.to &&
        selectionRef.current !== undefined &&
        selectionRef.current.from !== selectionRef.current.to
      ) {
        return;
      }
      selectionRef.current = nextSelection;
    } catch {
      // 浏览器选区处于 ProseMirror 外部时保留上一次合法选区。
    }
  };

  const formattingChain = (captureDomSelection = true) => {
    if (captureDomSelection) rememberDomSelection();
    const chain = editor.chain().focus();
    if (formatWholeDocument) return chain.selectAll();
    return selectionRef.current === undefined
      ? chain
      : chain.setTextSelection(selectionRef.current);
  };

  const applyColor = (kind: 'background' | 'text', value: string) => {
    if (colorInteractionRef.current === undefined) rememberDomSelection();
    const color = normalizeColorInput(value);
    if (color === undefined) return;
    const selection = formatWholeDocument
      ? `all:${editor.state.doc.content.size}`
      : `${selectionRef.current?.from ?? editor.state.selection.from}:${selectionRef.current?.to ?? editor.state.selection.to}`;
    const signature = `${selection}:${color}`;
    if (appliedColorRef.current[kind] === signature) return;
    colorInteractionRef.current ??= `rich-text-color:${kind}:${++colorInteractionSequenceRef.current}`;
    appliedColorRef.current[kind] = signature;
    const chain = formattingChain(false);
    if (kind === 'text') chain.setColor(color).run();
    else chain.setBackgroundColor(color).run();
  };

  const markIsActive = (mark: (typeof INLINE_MARK_BUTTONS)[number]['mark']) =>
    formatWholeDocument
      ? wholeDocumentMarkIsActive(editor.getJSON(), mark, defaultFontWeight)
      : selectionMarkIsActive(editor, mark, defaultFontWeight);

  const currentFontSize = resolveToolbarFontSize({
    defaultFontSize,
    document: editor.getJSON(),
    editor,
    formatWholeDocument,
  });
  const currentFontSizeIsPreset = FONT_SIZES.map(String).includes(currentFontSize);

  const toggleMark = (mark: (typeof INLINE_MARK_BUTTONS)[number]['mark']) => {
    const chain = formattingChain();
    if (mark !== 'bold') {
      chain.toggleMark(mark).run();
      return;
    }
    if (markIsActive('bold')) {
      chain
        .unsetBold()
        .setMark('textStyle', { fontWeight: defaultFontWeight >= 600 ? 400 : null })
        .removeEmptyTextStyle()
        .run();
      return;
    }
    if (defaultFontWeight >= 600) {
      chain.setMark('textStyle', { fontWeight: null }).removeEmptyTextStyle().run();
      return;
    }
    chain.setMark('textStyle', { fontWeight: null }).setBold().removeEmptyTextStyle().run();
  };

  const toolbar = (
    <div
      aria-label={text('reachDeck.editor.richText.format', '文本格式')}
      className="reach-deck-editor__rich-text-toolbar"
      onPointerDownCapture={rememberDomSelection}
      role="toolbar"
    >
      <span className="reach-deck-editor__toolbar-scope">
        {text('reachDeck.editor.richText.scope', '文字')}
      </span>
      <span className="reach-deck-editor__rich-text-divider" />
      <button
        aria-label={text('reachDeck.editor.richText.undo', '撤销')}
        className="reach-deck-editor__rich-text-button"
        disabled={disabled || !editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
        title={text('reachDeck.editor.richText.undo', '撤销')}
        type="button"
      >
        <Undo2 size={14} />
      </button>

      {allowQuizBlankInsertion ? (
        <button
          aria-label={text('reachDeck.editor.quiz.insertBlank', '插入填空')}
          className="reach-deck-editor__rich-text-button"
          disabled={disabled || toolbarOnly}
          onClick={() => {
            const document = editor.getJSON() as RichTextDocument;
            const blankIndex = countQuizBlankNodes(document) + 1;
            const blankId = allocateQuizBlankId(collectQuizBlankIds(document));
            editor
              .chain()
              .focus()
              .insertContent({
                attrs: { blankId, blankIndex },
                type: QUIZ_BLANK_NODE_TYPE,
              })
              .run();
          }}
          title={text('reachDeck.editor.quiz.insertBlank', '插入填空')}
          type="button"
        >
          <Plus size={14} />
        </button>
      ) : null}
      {imageInsertion ? (
        <button
          aria-busy={imageUploading || undefined}
          aria-label={text('reachDeck.editor.media.insertImage', '插入图片')}
          className="reach-deck-editor__rich-text-button"
          disabled={disabled || toolbarOnly || imageUploading || imageInsertion.remaining <= 0}
          onClick={() => imageInputRef.current?.click()}
          title={text('reachDeck.editor.media.insertImage', '插入图片')}
          type="button"
        >
          <ImagePlus size={14} />
        </button>
      ) : null}
      <button
        aria-label={text('reachDeck.editor.richText.redo', '重做')}
        className="reach-deck-editor__rich-text-button"
        disabled={disabled || !editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
        title={text('reachDeck.editor.richText.redo', '重做')}
        type="button"
      >
        <Redo2 size={14} />
      </button>
      <span className="reach-deck-editor__rich-text-divider" />

      {showFontControls && toolbarVariant === 'full' ? (
        <>
          <label className="reach-deck-editor__rich-text-field">
            <span className="sr-only">{text('reachDeck.editor.richText.font', '字体')}</span>
            <Select<string>
              aria-label={text('reachDeck.editor.richText.font', '字体')}
              disabled={disabled}
              onChange={(family) => {
                formattingChain().setFontFamily(family).run();
              }}
              options={REACH_DECK_BUILT_IN_FONT_FAMILIES.map((family) => ({
                label: family,
                value: family,
              }))}
              portal
              value={
                (formatWholeDocument
                  ? wholeDocumentTextStyleValue(editor.getJSON(), 'fontFamily', defaultFontFamily)
                  : REACH_DECK_BUILT_IN_FONT_FAMILIES.find((family) =>
                      editor.isActive('textStyle', { fontFamily: family }),
                    )) ?? defaultFontFamily
              }
            />
          </label>

          <label className="reach-deck-editor__rich-text-field">
            <span className="sr-only">{text('reachDeck.editor.richText.fontSize', '字号')}</span>
            <Select
              aria-label={text('reachDeck.editor.richText.fontSize', '字号')}
              disabled={disabled}
              onChange={(size) => {
                formattingChain()
                  .setFontSize(size + 'px')
                  .run();
              }}
              options={[
                ...(currentFontSize !== '' && !currentFontSizeIsPreset
                  ? [{ label: currentFontSize, value: currentFontSize }]
                  : []),
                ...FONT_SIZES.map((size) => ({ label: String(size), value: String(size) })),
              ]}
              placeholder="—"
              portal
              value={currentFontSize || undefined}
            />
          </label>

          <span className="reach-deck-editor__rich-text-divider" />
        </>
      ) : null}

      {toolbarVariant === 'full'
        ? INLINE_MARK_BUTTONS.map(({ mark, label: markLabel, Icon }) => (
            <MarkButton
              active={markIsActive(mark)}
              disabled={disabled}
              key={mark}
              label={text(`reachDeck.editor.richText.mark.${mark}`, markLabel)}
              onToggle={() => toggleMark(mark)}
            >
              <Icon size={14} />
            </MarkButton>
          ))
        : null}

      <button
        aria-label={text('reachDeck.editor.richText.insertInlineMath', '插入行内公式')}
        className="reach-deck-editor__rich-text-button"
        disabled={disabled || toolbarOnly}
        onClick={() => insertMathAndActivate(editor, { displayMode: false })}
        title={text('reachDeck.editor.richText.insertInlineMath', '插入行内公式')}
        type="button"
      >
        <Sigma size={14} />
      </button>
      {narrationSingleParagraphRef.current ? null : (
        <button
          aria-label={text('reachDeck.editor.richText.insertBlockMath', '插入独立公式')}
          className="reach-deck-editor__rich-text-button"
          disabled={disabled || toolbarOnly}
          onClick={() => insertMathAndActivate(editor, { displayMode: true })}
          title={text('reachDeck.editor.richText.insertBlockMath', '插入独立公式')}
          type="button"
        >
          <Braces size={14} />
        </button>
      )}

      {toolbarVariant === 'narration' && narrationToolbarContent !== undefined ? (
        <>
          <span className="reach-deck-editor__rich-text-divider" />
          {narrationToolbarContent}
        </>
      ) : null}

      {toolbarVariant === 'full' ? (
        <>
          <span className="reach-deck-editor__rich-text-divider" />

          <label
            className="reach-deck-editor__rich-text-color"
            title={text('reachDeck.editor.richText.textColor', '文字颜色')}
          >
            <Palette size={14} />
            <span className="sr-only">
              {text('reachDeck.editor.richText.textColor', '文字颜色')}
            </span>
            <NativeColorInput
              aria-label={text('reachDeck.editor.richText.textColor', '文字颜色')}
              disabled={disabled}
              onInteractionEnd={() => {
                colorInteractionRef.current = undefined;
              }}
              onValue={(value) => applyColor('text', value)}
              value={
                typeof editor.getAttributes('textStyle').color === 'string'
                  ? (editor.getAttributes('textStyle').color as string)
                  : '#172024'
              }
            />
          </label>

          <label
            className="reach-deck-editor__rich-text-color"
            title={text('reachDeck.editor.richText.backgroundColor', '背景色')}
          >
            <Highlighter size={14} />
            <span className="sr-only">
              {text('reachDeck.editor.richText.backgroundColor', '背景色')}
            </span>
            <NativeColorInput
              aria-label={text('reachDeck.editor.richText.backgroundColor', '背景色')}
              disabled={disabled}
              onInteractionEnd={() => {
                colorInteractionRef.current = undefined;
              }}
              onValue={(value) => applyColor('background', value)}
              value={
                typeof editor.getAttributes('textStyle').backgroundColor === 'string'
                  ? (editor.getAttributes('textStyle').backgroundColor as string)
                  : '#ffffff'
              }
            />
          </label>

          <button
            aria-label={text('reachDeck.editor.richText.clearFormatting', '清除格式')}
            className="reach-deck-editor__rich-text-button"
            disabled={disabled}
            onClick={() => formattingChain().unsetAllMarks().run()}
            title={text('reachDeck.editor.richText.clearFormatting', '清除格式')}
            type="button"
          >
            <Eraser size={14} />
          </button>

          <span className="reach-deck-editor__rich-text-divider" />

          {TEXT_ALIGNMENTS.map(({ value: alignment, label: alignLabel, Icon }) => (
            <button
              aria-label={text(`reachDeck.editor.richText.align.${alignment}`, alignLabel)}
              aria-pressed={editor.isActive({ textAlign: alignment })}
              className="reach-deck-editor__rich-text-button"
              disabled={disabled}
              key={alignment}
              onClick={() => formattingChain().setTextAlign(alignment).run()}
              title={text(`reachDeck.editor.richText.align.${alignment}`, alignLabel)}
              type="button"
            >
              <Icon size={14} />
            </button>
          ))}
        </>
      ) : null}
    </div>
  );

  if (toolbarOnly) return toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar;

  return (
    <div
      className={`reach-deck-editor__rich-text${inline ? ' is-inline' : ''}${toolbarVisibility === 'focus' ? ' is-toolbar-on-focus' : ''}`}
      data-rich-text-inline={inline || undefined}
      onCopyCapture={(event) => {
        if (
          toolbarVariant !== 'narration' ||
          editor === null ||
          (event.target instanceof Element && event.target.closest('math-field'))
        )
          return;
        try {
          if (writeNarrationClipboard(editor.state, event.clipboardData)) {
            event.preventDefault();
            event.stopPropagation();
          }
        } catch {
          // If even plain text cannot be written, let the browser try its ordinary copy path.
        }
      }}
      onCutCapture={(event) => {
        if (
          toolbarVariant !== 'narration' ||
          editor === null ||
          disabled ||
          (event.target instanceof Element && event.target.closest('math-field'))
        )
          return;
        try {
          if (writeNarrationClipboard(editor.state, event.clipboardData)) {
            event.preventDefault();
            event.stopPropagation();
            editor.view.dispatch(
              closeHistory(editor.state.tr)
                .deleteSelection()
                .scrollIntoView()
                .setMeta('uiEvent', 'cut'),
            );
          }
        } catch {
          event.preventDefault();
          event.stopPropagation();
          // Do not remove the selection when every clipboard write failed.
        }
      }}
      onCopy={(event) => writeInternalClipboardToken(event.clipboardData)}
      onCut={(event) => writeInternalClipboardToken(event.clipboardData)}
      onPasteCapture={(event) => {
        const clipboardData = event.nativeEvent.clipboardData;
        trustedInternalPasteRef.current = false;
        rejectedPasteRef.current = false;
        preparedPasteHtmlRef.current = undefined;
        if (clipboardData === null) {
          rejectedPasteRef.current = true;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const trustedInternal = hasInternalClipboardToken(clipboardData);
        trustedInternalPasteRef.current = trustedInternal;
        try {
          const html = clipboardData.getData('text/html');
          const plainText = clipboardData.getData('text/plain');
          if (
            editor !== null &&
            !disabled &&
            toolbarVariant === 'narration' &&
            !(event.target instanceof Element && event.target.closest('math-field'))
          ) {
            let portable: ReturnType<typeof readNarrationClipboard>;
            try {
              portable = readNarrationClipboard(
                clipboardData,
                editor.state.schema,
                allowedNarrationSpeechMarkTypesRef.current,
              );
            } catch {
              queueMicrotask(() => narrationSpeechPasteFallbackRef.current?.());
            }
            if (portable !== undefined) {
              const transaction = closeHistory(editor.state.tr)
                .replaceSelection(
                  narrationSingleParagraphRef.current
                    ? foldSliceToSingleParagraph(portable.slice, editor.state.schema)
                    : portable.slice,
                )
                .scrollIntoView()
                .setMeta('paste', true)
                .setMeta('uiEvent', 'paste');
              if (narrationPasteTransactionValid(transaction)) {
                event.preventDefault();
                event.stopPropagation();
                editor.view.dispatch(transaction);
                if (portable.fallback)
                  queueMicrotask(() => narrationSpeechPasteFallbackRef.current?.());
                return;
              }
              queueMicrotask(() => narrationSpeechPasteFallbackRef.current?.());
            }
            // Formula-bearing plain narration uses its documented newline dialect: a single
            // newline is a hard break, and blank lines separate paragraphs.
            if (!NARRATION_SSML_LIKE.test(plainText) && /\\[([]/u.test(plainText)) {
              try {
                richTextFromClipboardPlainText(plainText);
                const doc = editor.state.schema.nodeFromJSON(
                  parseReachDeckNarrationMarkdown(plainText),
                );
                const formulaSlice = Slice.maxOpen(doc.content);
                const transaction = closeHistory(editor.state.tr)
                  .replaceSelection(
                    narrationSingleParagraphRef.current
                      ? foldSliceToSingleParagraph(formulaSlice, editor.state.schema)
                      : formulaSlice,
                  )
                  .scrollIntoView()
                  .setMeta('paste', true)
                  .setMeta('uiEvent', 'paste');
                if (narrationPasteTransactionValid(transaction)) {
                  event.preventDefault();
                  event.stopPropagation();
                  editor.view.dispatch(transaction);
                  return;
                }
              } catch {
                /* Let the bounded literal paste path preserve invalid formula text. */
              }
            }
          }
          if (
            editor !== null &&
            !disabled &&
            toolbarVariant === 'narration' &&
            !(event.target instanceof Element && event.target.closest('math-field') !== null) &&
            (NARRATION_SSML_LIKE.test(plainText) || /\\[([]/u.test(plainText))
          ) {
            richTextFromClipboardPlainText(plainText);
            event.preventDefault();
            event.stopPropagation();
            narrationBreakPasteRef.current = true;
            try {
              editor.view.pasteText(plainText, event.nativeEvent);
            } finally {
              narrationBreakPasteRef.current = false;
            }
            return;
          }
          if (
            editor !== null &&
            !disabled &&
            toolbarVariant === 'narration' &&
            !(event.target instanceof Element && event.target.closest('math-field')) &&
            html.length > 0
          ) {
            // Narration persists text/formulas rather than webpage typography. The slide
            // clipboard parser still owns sanitization and budgets before decorations are removed.
            const insertNarration = (document: RichTextDocument): boolean => {
              const next = narrationClipboardDocument(document);
              if (!richTextHasRenderableContent(next)) return false;
              const slice = Slice.maxOpen(editor.state.schema.nodeFromJSON(next).content);
              const transaction = closeHistory(editor.state.tr)
                .replaceSelection(
                  narrationSingleParagraphRef.current
                    ? foldSliceToSingleParagraph(slice, editor.state.schema)
                    : slice,
                )
                .scrollIntoView()
                .setMeta('paste', true)
                .setMeta('uiEvent', 'paste');
              if (!narrationPasteTransactionValid(transaction)) return false;
              editor.view.dispatch(transaction);
              return true;
            };
            event.preventDefault();
            event.stopPropagation();
            trustedInternalPasteRef.current = false;
            try {
              let document: RichTextDocument;
              if (trustedInternal && isProseMirrorClipboardSlice(html)) {
                const holder = window.document.createElement('div');
                holder.innerHTML = markTrustedProseMirrorClipboardHtml(html);
                document = normalizeRichText(
                  ProseMirrorDOMParser.fromSchema(editor.state.schema).parse(holder).toJSON(),
                );
              } else {
                document = richTextFromClipboardHtml(html);
              }
              if (insertNarration(document)) return;
            } catch {
              // Rejected, oversized or empty HTML must not discard a safe text/plain format.
            }
            if (plainText.length > 0) {
              insertNarration(richTextFromClipboardPlainText(plainText));
            }
            return;
          }
          // 剪贴板里的图片**文件**是唯一的上传入口；外部 HTML 里的 `<img src>` 仍然照旧被
          // transformReachDeckPastedHtml 整体剥离。取舍与幻灯片的窗口级粘贴一致：先看 HTML
          // 能不能落成可见文字，落不下来（例如从网页复制一张图）才回落到图片上传。
          const clipboardImage =
            imageInsertionRef.current === undefined || trustedInternal
              ? undefined
              : firstSupportedClipboardImage(clipboardData, CLIPBOARD_IMAGE_EXTENSIONS);
          const uploadClipboardImage = (file: File) => {
            trustedInternalPasteRef.current = false;
            event.preventDefault();
            // 阻断冒泡，使 ReachDeckEditor 的窗口级幻灯片粘贴不会同时处理这次事件。
            event.stopPropagation();
            void uploadAndInsertImage(
              normalizeClipboardImageFile(file, CLIPBOARD_IMAGE_EXTENSIONS),
            );
          };
          if (html.length > 0) {
            const output =
              trustedInternal && isProseMirrorClipboardSlice(html)
                ? markTrustedProseMirrorClipboardHtml(html)
                : transformReachDeckPastedHtml(html, surfaceRef.current);
            if (
              clipboardImage !== undefined &&
              !clipboardHtmlIsRenderable(output, surfaceRef.current)
            ) {
              uploadClipboardImage(clipboardImage);
              return;
            }
            if (output.length === 0) throw new Error('Clipboard HTML was rejected.');
            preparedPasteHtmlRef.current = { input: html, output };
          } else if (clipboardImage !== undefined) {
            uploadClipboardImage(clipboardImage);
            return;
          } else {
            richTextFromClipboardPlainText(plainText);
          }
        } catch {
          trustedInternalPasteRef.current = false;
          rejectedPasteRef.current = true;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onPaste={() => {
        trustedInternalPasteRef.current = false;
        preparedPasteHtmlRef.current = undefined;
      }}
      onDropCapture={() => {
        trustedInternalPasteRef.current = false;
        preparedPasteHtmlRef.current = undefined;
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof globalThis.Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        onHistoryGroupEnd?.();
      }}
      style={
        inline
          ? {
              fontSize: `${richTextMaximumFontSize(value, defaultFontSize ?? 16)}px`,
            }
          : undefined
      }
      onKeyDown={(event) => {
        if (!inline) return;
        if (event.nativeEvent.isComposing || editor?.view.composing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel?.();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          onDone?.();
        }
      }}
    >
      {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar}
      <EditorContent editor={editor} />
      {imageInsertion ? (
        <>
          <input
            accept={imageInsertion.accept}
            aria-hidden="true"
            className="reach-deck-editor__sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) void uploadAndInsertImage(file);
            }}
            ref={imageInputRef}
            tabIndex={-1}
            type="file"
          />
          {imageUploading || imageError.length > 0 ? (
            <p className="reach-deck-editor__rich-text-image-status" role="alert">
              {imageUploading
                ? text('reachDeck.editor.quiz.image.uploading', '正在上传图片…')
                : imageError}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * 清洗后的剪贴板 HTML 还剩不剩可见内容。
 *
 * 只在剪贴板同时带着图片文件时才需要问这个问题：从网页复制一张图，`text/html` 是
 * `<img src>`，清洗后什么都不剩，这时应该回落到图片上传而不是粘贴一段空内容。
 * 解析失败按「不可见」处理，让调用方去走图片分支。
 */
function clipboardHtmlIsRenderable(
  sanitizedHtml: string,
  surface: ReachDeckClipboardSurface,
): boolean {
  if (sanitizedHtml.length === 0) return false;
  try {
    return richTextHasRenderableContent(richTextFromClipboardHtml(sanitizedHtml, surface));
  } catch {
    return false;
  }
}

interface QuizImageUrlSource {
  resolve(objectKey: string): string | undefined;
  subscribe(listener: () => void): () => void;
}

/**
 * 行内图片的展示 NodeView。
 *
 * 节点 schema 里没有 `src`（见 `@reachany/reach-deck-rich-text` 的 ReachDeckAuthoringImage），
 * 地址只在 DOM 上短暂存在。地址未就绪时移除 `src` 并打 `data-pending`，否则空 `<img>` 会渲染成
 * 破图图标。
 */
function createRichTextImageNodeView(
  source: QuizImageUrlSource,
  text: (key: string, fallback: string, replacements?: Record<string, string | number>) => string,
): NodeViewRenderer {
  return ({ node }) => {
    const dom = window.document.createElement('img');
    dom.className = 'reach-deck-editor__rich-text-image';
    dom.draggable = false;
    let current = node;
    const paint = () => {
      const objectKey = typeof current.attrs.objectKey === 'string' ? current.attrs.objectKey : '';
      const alt = typeof current.attrs.alt === 'string' ? current.attrs.alt : '';
      dom.alt = alt.length > 0 ? alt : text('reachDeck.player.richText.image', '图片');
      if (objectKey.length > 0) dom.dataset.objectKey = objectKey;
      else delete dom.dataset.objectKey;
      const url = objectKey.length > 0 ? source.resolve(objectKey) : undefined;
      if (url === undefined || url.length === 0) {
        dom.removeAttribute('src');
        dom.dataset.pending = 'true';
        return;
      }
      delete dom.dataset.pending;
      if (dom.getAttribute('src') !== url) dom.setAttribute('src', url);
    };
    paint();
    const unsubscribe = source.subscribe(paint);
    return {
      dom,
      update: (next) => {
        if (next.type.name !== current.type.name) return false;
        current = next;
        paint();
        return true;
      },
      // 叶子节点没有 contentDOM；我们自己写 src / data-* 不能被当成编辑内容的变更。
      ignoreMutation: () => true,
      selectNode: () => dom.classList.add('is-selected'),
      deselectNode: () => dom.classList.remove('is-selected'),
      destroy: unsubscribe,
    };
  };
}

function NativeColorInput({
  'aria-label': ariaLabel,
  disabled,
  onInteractionEnd,
  onValue,
  value,
}: {
  'aria-label': string;
  disabled: boolean;
  onInteractionEnd: () => void;
  onValue: (value: string) => void;
  value: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const receivedInputRef = useRef(false);
  const finishTimerRef = useRef<number | undefined>(undefined);
  const onInteractionEndRef = useRef(onInteractionEnd);
  const onValueRef = useRef(onValue);
  onInteractionEndRef.current = onInteractionEnd;
  onValueRef.current = onValue;

  const finishInteraction = () => {
    if (finishTimerRef.current !== undefined) window.clearTimeout(finishTimerRef.current);
    finishTimerRef.current = undefined;
    receivedInputRef.current = false;
    onInteractionEndRef.current();
  };
  const scheduleInteractionEnd = () => {
    if (finishTimerRef.current !== undefined) window.clearTimeout(finishTimerRef.current);
    finishTimerRef.current = window.setTimeout(() => {
      finishTimerRef.current = undefined;
      receivedInputRef.current = false;
      onInteractionEndRef.current();
    }, 250);
  };

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const finishNativeChange = () => {
      // Firefox may emit only a final change, while Chromium emits input + change for every
      // sampled color. Debounce the boundary so both event orders remain one gesture.
      if (!receivedInputRef.current) onValueRef.current(input.value);
      receivedInputRef.current = false;
      scheduleInteractionEnd();
    };
    input.addEventListener('change', finishNativeChange);
    return () => {
      input.removeEventListener('change', finishNativeChange);
      if (finishTimerRef.current !== undefined) window.clearTimeout(finishTimerRef.current);
    };
  }, []);
  return (
    <input
      aria-label={ariaLabel}
      disabled={disabled}
      onBlur={finishInteraction}
      onInput={(event) => {
        receivedInputRef.current = true;
        onValueRef.current(event.currentTarget.value);
        scheduleInteractionEnd();
      }}
      onPointerDown={() => {
        finishInteraction();
      }}
      onPointerUp={scheduleInteractionEnd}
      ref={inputRef}
      type="color"
      value={value}
    />
  );
}

function normalizeColorInput(value: string): string | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  return match === null ? undefined : `#${match[1]!.toUpperCase()}`;
}

function createQuizBlankExtension(
  text: (key: string, fallback: string, replacements?: Record<string, string | number>) => string,
) {
  return Node.create({
    name: QUIZ_BLANK_NODE_TYPE,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return { blankId: { default: null }, blankIndex: { default: 1 } };
    },
    parseHTML() {
      return [{ tag: 'span[data-quiz-blank]' }];
    },
    renderHTML({ node }) {
      const blankIndex = Math.max(1, Math.trunc(Number(node.attrs.blankIndex) || 1));
      return [
        'span',
        {
          'aria-label': text('reachDeck.editor.quiz.blankAria', '第 {number} 空', {
            number: blankIndex,
          }),
          class: 'reach-deck-editor__quiz-blank',
          'data-blank-id': node.attrs.blankId,
          'data-quiz-blank': String(blankIndex),
        },
        `____${blankIndex}____`,
      ];
    },
    renderText({ node }) {
      return `____${Math.max(1, Math.trunc(Number(node.attrs.blankIndex) || 1))}____`;
    },
  });
}

const ReachDeckNarrationSpeechMark = Mark.create({
  name: REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
  inclusive: false,
  excludes: REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
  addAttributes() {
    return { definition: { default: null } };
  },
  parseHTML: () => [{ tag: 'span[data-reach-deck-speech-mark]' }],
  renderHTML({ HTMLAttributes }) {
    const definition = readSpeechDefinition(HTMLAttributes.definition);
    const type = definition?.type ?? 'invalid';
    return [
      'span',
      {
        'data-reach-deck-speech-mark': type,
        'data-reach-deck-speech-open': speechOpenLabel(definition),
        'data-reach-deck-speech-close': `</${type}>`,
      },
      0,
    ];
  },
});

function createNarrationSpeechBreakExtension(
  text: (key: string, fallback: string, replacements?: Record<string, string | number>) => string,
) {
  return Node.create({
    name: REACH_DECK_SPEECH_BREAK_NODE_TYPE,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return { definition: { default: null } };
    },
    parseHTML: () => [
      { tag: 'span[data-reach-deck-speech-break]:not([data-reach-deck-speech-sound-event])' },
    ],
    renderHTML({ HTMLAttributes }) {
      const definition = readSpeechDefinition(HTMLAttributes.definition);
      const label =
        definition?.type === 'break'
          ? text('reachDeck.editor.narration.speech.breakAria', '停顿 {duration} 毫秒', {
              duration: definition.durationMs,
            })
          : text('reachDeck.editor.narration.speech.break', '停顿');
      return [
        'span',
        {
          'aria-label': label,
          title: label,
          'data-reach-deck-speech-break':
            definition?.type === 'break' ? `<break ${definition.durationMs}ms/>` : '<break/>',
          role: 'img',
        },
      ];
    },
  });
}

function createNarrationSpeechSoundEventExtension(
  text: (key: string, fallback: string, replacements?: Record<string, string | number>) => string,
) {
  return Node.create({
    name: REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE,
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return { definition: { default: null } };
    },
    parseHTML: () => [{ tag: 'span[data-reach-deck-speech-sound-event]' }],
    renderHTML({ HTMLAttributes }) {
      const definition = readSpeechDefinition(HTMLAttributes.definition);
      const label =
        definition?.type === 'soundEvent'
          ? `<soundEvent src="${escapeNarrationXml(definition.src)}"/>`
          : '<soundEvent/>';
      const accessibleLabel =
        definition?.type === 'soundEvent'
          ? text('reachDeck.editor.narration.speech.soundEventAria', '音效 {src}', {
              src: definition.src,
            })
          : text('reachDeck.editor.narration.speech.soundEvent', '音效');
      return [
        'span',
        {
          'aria-label': accessibleLabel,
          title: accessibleLabel,
          'data-reach-deck-speech-break': label,
          'data-reach-deck-speech-sound-event': label,
          role: 'img',
        },
      ];
    },
  });
}

function createNarrationSpeechIntegrityExtension(onInvalidated: (count: number) => void) {
  return Extension.create({
    name: 'reachDeckNarrationSpeechIntegrity',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          appendTransaction: (transactions, oldState, newState) => {
            if (
              !transactions.some((transaction) => transaction.docChanged) ||
              transactions.some(
                (transaction) =>
                  transaction.getMeta(NARRATION_SPEECH_ACTION_META) === true ||
                  transaction.getMeta(NARRATION_SPEECH_INVALIDATION_META) === true,
              )
            ) {
              return null;
            }
            const oldSpans = collectNarrationSpeechSpans(oldState);
            const nextSpans = collectNarrationSpeechSpans(newState);
            const invalidIds = [...oldSpans.entries()].flatMap(([id, oldSpan]) => {
              const next = nextSpans.get(id);
              return next === undefined || next.text !== oldSpan.text ? [id] : [];
            });
            if (invalidIds.length === 0) return null;
            const transaction = newState.tr;
            const speechMark = newState.schema.marks[REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE];
            if (speechMark !== undefined) {
              for (const id of invalidIds) {
                for (const range of nextSpans.get(id)?.ranges ?? []) {
                  transaction.removeMark(range.from, range.to, speechMark);
                }
              }
            }
            queueMicrotask(() => onInvalidated(invalidIds.length));
            if (!transaction.docChanged) return null;
            transaction.setMeta(NARRATION_SPEECH_INVALIDATION_META, true);
            return transaction;
          },
        }),
      ];
    },
  });
}

function applyNarrationSpeechSpan(
  editor: Editor | null,
  savedSelection: { from: number; to: number } | undefined,
  input: NarrationSpeechSpanDefinitionInput,
): NarrationSpeechCommandResult {
  if (editor === null) return { applied: false, reason: 'invalid-selection' };
  const selection = savedSelection ?? editor.state.selection;
  const active = findActiveNarrationSpeechSpan(editor.state, selection.from, selection.to);
  const from =
    selection.from === selection.to && active !== undefined ? active.from : selection.from;
  const to = selection.from === selection.to && active !== undefined ? active.to : selection.to;
  if (!plainNarrationSelection(editor.state, from, to)) {
    return { applied: false, reason: 'invalid-selection' };
  }
  const intersecting = intersectingNarrationSpeechSpans(editor.state, from, to);
  if (
    intersecting.some(
      (span) =>
        span.definition.id !== active?.definition.id || span.from !== from || span.to !== to,
    )
  ) {
    return { applied: false, reason: 'invalid-selection' };
  }
  const definition = {
    id: active?.definition.id ?? nextNarrationSpeechId(),
    ...input,
  } as ReachDeckSpeechRichTextDefinition;
  const speechType = editor.state.schema.marks[REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE];
  if (speechType === undefined) return { applied: false, reason: 'invalid-selection' };
  const transaction = editor.state.tr;
  for (const span of intersecting) {
    transaction.removeMark(span.from, span.to, speechType);
  }
  transaction.addMark(from, to, speechType.create({ definition }));
  transaction.setMeta(NARRATION_SPEECH_ACTION_META, true);
  if (!speechTransactionValid(transaction)) {
    return { applied: false, reason: 'invalid-selection' };
  }
  editor.view.dispatch(transaction);
  return { applied: true };
}

function insertNarrationSpeechBreak(
  editor: Editor | null,
  savedSelection: { from: number; to: number } | undefined,
  durationMs: number,
): NarrationSpeechCommandResult {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 10_000) {
    return { applied: false, reason: 'invalid-selection' };
  }
  return insertNarrationSpeechPoint(editor, savedSelection, REACH_DECK_SPEECH_BREAK_NODE_TYPE, {
    type: 'break',
    at: 0,
    durationMs,
  });
}

function insertNarrationSpeechSoundEvent(
  editor: Editor | null,
  savedSelection: { from: number; to: number } | undefined,
  src: string,
): NarrationSpeechCommandResult {
  return insertNarrationSpeechPoint(
    editor,
    savedSelection,
    REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE,
    { type: 'soundEvent', at: 0, src },
  );
}

function insertNarrationSpeechPoint(
  editor: Editor | null,
  savedSelection: { from: number; to: number } | undefined,
  nodeTypeName:
    | typeof REACH_DECK_SPEECH_BREAK_NODE_TYPE
    | typeof REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE,
  mark: Extract<ReachDeckSpeechMarkV1, { type: 'break' | 'soundEvent' }>,
): NarrationSpeechCommandResult {
  if (editor === null) return { applied: false, reason: 'invalid-selection' };
  const selection = savedSelection ?? editor.state.selection;
  const selectedNode = (
    editor.state.selection as typeof editor.state.selection & {
      node?: { type?: { name?: string } };
    }
  ).node;
  const nodeType = editor.state.schema.nodes[nodeTypeName];
  if (nodeType === undefined) return { applied: false, reason: 'invalid-selection' };
  const definition = reachDeckSpeechRichTextDefinition(mark, nextNarrationSpeechId());
  if (selectedNode?.type?.name === nodeTypeName) {
    const transaction = editor.state.tr
      .setNodeMarkup(selection.from, nodeType, { definition })
      .setMeta(NARRATION_SPEECH_ACTION_META, true);
    if (!speechTransactionValid(transaction)) {
      return { applied: false, reason: 'invalid-selection' };
    }
    editor.view.dispatch(transaction);
    return { applied: true };
  }
  if (selection.from !== selection.to) return { applied: false, reason: 'invalid-selection' };
  const transaction = editor.state.tr
    .setSelection(TextSelection.create(editor.state.doc, selection.from))
    .replaceSelectionWith(nodeType.create({ definition }))
    .setMeta(NARRATION_SPEECH_ACTION_META, true);
  if (!speechTransactionValid(transaction)) {
    return { applied: false, reason: 'invalid-selection' };
  }
  editor.view.dispatch(transaction);
  return { applied: true };
}

function removeActiveNarrationSpeech(
  editor: Editor | null,
  savedSelection: { from: number; to: number } | undefined,
): NarrationSpeechCommandResult {
  if (editor === null) return { applied: false, reason: 'no-active-mark' };
  const selection = savedSelection ?? editor.state.selection;
  const selectedNode = (
    editor.state.selection as typeof editor.state.selection & { node?: unknown }
  ).node as { type?: { name?: string } } | undefined;
  if (isNarrationSpeechPointNodeName(selectedNode?.type?.name)) {
    editor.view.dispatch(
      editor.state.tr.deleteSelection().setMeta(NARRATION_SPEECH_ACTION_META, true),
    );
    return { applied: true };
  }
  const active = findActiveNarrationSpeechSpan(editor.state, selection.from, selection.to);
  const speechType = editor.state.schema.marks[REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE];
  if (active === undefined || speechType === undefined) {
    return { applied: false, reason: 'no-active-mark' };
  }
  editor.view.dispatch(
    editor.state.tr
      .removeMark(active.from, active.to, speechType)
      .setMeta(NARRATION_SPEECH_ACTION_META, true),
  );
  return { applied: true };
}

function applyNarrationSourceMark(
  editor: Editor | null,
  mark: ReachDeckSpeechMarkV1,
): NarrationSpeechCommandResult {
  if (editor === null) return { applied: false, reason: 'invalid-selection' };
  try {
    const current = serializeReachDeckNarrationSpeechDocument(
      normalizeRichText(editor.state.doc.toJSON()),
      { canonicalize: true },
    );
    const speechMarkup = canonicalizeReachDeckSpeechMarkupV1(
      {
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [...(current.speechMarkup?.marks ?? []), mark],
      },
      current.markdown,
    );
    const next = editor.state.schema.nodeFromJSON(
      parseReachDeckNarrationSpeechDocument(current.markdown, speechMarkup),
    );
    const transaction = editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, next.content)
      .setMeta(NARRATION_SPEECH_ACTION_META, true);
    editor.view.dispatch(transaction);
    return { applied: true };
  } catch {
    return { applied: false, reason: 'invalid-selection' };
  }
}

function readNarrationSpeechSelection(editor: Editor): NarrationSpeechSelection {
  const { from, to } = editor.state.selection;
  const active = findActiveNarrationSpeechSpan(editor.state, from, to)?.definition;
  const selectedNode = (
    editor.state.selection as typeof editor.state.selection & {
      node?: { attrs?: { definition?: unknown }; type?: { name?: string } };
    }
  ).node;
  let markdownFrom = 0;
  let markdownTo = 0;
  if (from !== to) {
    try {
      markdownFrom = proseMirrorPositionToNarrationMarkdown(editor.state, from);
      markdownTo = proseMirrorPositionToNarrationMarkdown(editor.state, to);
    } catch {
      // An incomplete draft can still be edited; it simply cannot be previewed yet.
      return { empty: true, markdownFrom: 0, markdownTo: 0, text: '' };
    }
  }
  return {
    ...(active === undefined
      ? isNarrationSpeechPointNodeName(selectedNode?.type?.name)
        ? { active: readSpeechDefinition(selectedNode?.attrs?.definition) }
        : {}
      : { active }),
    empty: from === to,
    markdownFrom,
    markdownTo,
    text: editor.state.doc.textBetween(from, to, '\n'),
  };
}

function readNarrationSpeechSourceSelection(
  editor: Editor | null,
  savedSelection: { from: number; to: number } | undefined,
): NarrationSpeechSelection {
  if (editor === null) {
    return { empty: true, text: '', markdownFrom: 0, markdownTo: 0 };
  }
  const selection = savedSelection ?? editor.state.selection;
  const basic = readNarrationSpeechSelection(editor);
  const activeSpan = findActiveNarrationSpeechSpan(editor.state, selection.from, selection.to);
  const from =
    selection.from === selection.to && activeSpan !== undefined ? activeSpan.from : selection.from;
  const to =
    selection.from === selection.to && activeSpan !== undefined ? activeSpan.to : selection.to;
  return {
    ...basic,
    empty: from === to,
    text: editor.state.doc.textBetween(from, to, '\n'),
    markdownFrom: proseMirrorPositionToNarrationMarkdown(editor.state, from),
    markdownTo: proseMirrorPositionToNarrationMarkdown(editor.state, to),
  };
}

function plainNarrationSelection(state: EditorState, from: number, to: number): boolean {
  if (from >= to || state.doc.resolve(from).parent !== state.doc.resolve(to).parent) return false;
  let valid = true;
  let hasText = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      hasText = true;
      return;
    }
    if (node.isLeaf) valid = false;
  });
  return valid && hasText;
}

interface CollectedSpeechSpan {
  definition: ReachDeckSpeechRichTextDefinition;
  from: number;
  ranges: Array<{ from: number; to: number }>;
  text: string;
  to: number;
}

function collectNarrationSpeechSpans(state: EditorState): Map<string, CollectedSpeechSpan> {
  const spans = new Map<string, CollectedSpeechSpan>();
  state.doc.descendants((node, position) => {
    if (!node.isText) return;
    const mark = node.marks.find(
      (candidate) => candidate.type.name === REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE,
    );
    const definition = readSpeechDefinition(mark?.attrs.definition);
    if (
      definition === undefined ||
      definition.type === 'break' ||
      definition.type === 'soundEvent'
    ) {
      return;
    }
    const existing = spans.get(definition.id);
    const range = { from: position, to: position + node.nodeSize };
    if (existing === undefined) {
      spans.set(definition.id, {
        definition,
        from: range.from,
        ranges: [range],
        text: node.text ?? '',
        to: range.to,
      });
    } else {
      existing.ranges.push(range);
      existing.from = Math.min(existing.from, range.from);
      existing.to = Math.max(existing.to, range.to);
      existing.text += node.text ?? '';
    }
  });
  return spans;
}

function findActiveNarrationSpeechSpan(
  state: EditorState,
  from: number,
  to: number,
): CollectedSpeechSpan | undefined {
  return [...collectNarrationSpeechSpans(state).values()].find((span) =>
    from === to ? from >= span.from && from <= span.to : span.from < to && from < span.to,
  );
}

function intersectingNarrationSpeechSpans(
  state: EditorState,
  from: number,
  to: number,
): CollectedSpeechSpan[] {
  return [...collectNarrationSpeechSpans(state).values()].filter(
    (span) => span.from < to && from < span.to,
  );
}

function speechTransactionValid(transaction: Transaction): boolean {
  try {
    serializeReachDeckNarrationSpeechDocument(normalizeRichText(transaction.doc.toJSON()), {
      canonicalize: true,
    });
    return true;
  } catch {
    return false;
  }
}

function convertNarrationBreakPasteSlice(
  slice: Slice,
  schema: Schema,
  hasContentBeforeSelection: boolean,
  hasContentAfterSelection: boolean,
  allowed: readonly ReachDeckSpeechMarkV1['type'][],
): { converted: number; hasLiteralBreak: boolean; slice: Slice } {
  const breakType = schema.nodes[REACH_DECK_SPEECH_BREAK_NODE_TYPE];
  if (breakType === undefined) return { converted: 0, hasLiteralBreak: true, slice };
  let converted = 0;
  let hasLiteralBreak = false;

  const convertNode = (node: ProseMirrorNode): ProseMirrorNode[] => {
    if (node.isText) {
      const result = narrationSsmlNodes(node.text ?? '', schema, allowed);
      converted +=
        result.converted + (result.nodes.some((child) => child.type.name === 'inlineMath') ? 1 : 0);
      hasLiteralBreak ||= result.fallback;
      return result.nodes;
    }
    if (node.isLeaf) return [node];
    if (
      node.type.name === 'paragraph' &&
      node.childCount === 1 &&
      node.firstChild?.isText &&
      node.textContent.startsWith('\\[')
    ) {
      try {
        const parsed = parseReachDeckNarrationMarkdown(node.textContent);
        if (parsed.content?.length === 1 && parsed.content[0]?.type === 'blockMath') {
          converted += 1;
          return [schema.nodeFromJSON(parsed.content[0])];
        }
      } catch {
        /* Malformed formulas remain literal. */
      }
    }
    const children: ProseMirrorNode[] = [];
    node.forEach((child) => children.push(...convertNode(child)));
    return [node.copy(Fragment.fromArray(children))];
  };

  const blocks: ProseMirrorNode[] = [];
  slice.content.forEach((node) => blocks.push(...convertNode(node)));
  // Plain-text paste can leave empty boundary paragraphs for outer newlines. Keep an open edge
  // only when it joins text outside the pasted slice; narration Markdown drops the other empties.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.type.name !== 'paragraph' || block.childCount !== 0) continue;
    if (index === 0 && slice.openStart > 0 && hasContentBeforeSelection) continue;
    if (index === blocks.length - 1 && slice.openEnd > 0 && hasContentAfterSelection) continue;
    blocks.splice(index, 1);
  }
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (!paragraphContainsOnlyBreaks(block)) continue;
    if (index === 0 && slice.openStart > 0 && hasContentBeforeSelection) continue;
    if (index === blocks.length - 1 && slice.openEnd > 0 && hasContentAfterSelection) continue;
    const previous = blocks[index - 1];
    const next = blocks[index + 1];
    if (previous?.type.name === 'paragraph') {
      blocks[index - 1] = previous.copy(previous.content.append(block.content));
    } else if (next?.type.name === 'paragraph') {
      blocks[index + 1] = next.copy(block.content.append(next.content));
    } else {
      continue;
    }
    blocks.splice(index, 1);
    index -= 1;
  }
  return {
    converted,
    hasLiteralBreak,
    slice: new Slice(Fragment.fromArray(blocks), slice.openStart, slice.openEnd),
  };
}

function paragraphContainsOnlyBreaks(node: ProseMirrorNode): boolean {
  if (node.type.name !== 'paragraph' || node.childCount === 0) return false;
  let onlyBreaks = true;
  node.forEach((child) => {
    if (!isNarrationSpeechPointNodeName(child.type.name)) onlyBreaks = false;
  });
  return onlyBreaks;
}

/** Remove presentation only after clipboard validation; list wrappers become narration blocks. */
function narrationClipboardDocument(document: RichTextDocument): RichTextDocument {
  let nodes = 0;
  const visit = (node: RichTextNode, depth: number): RichTextNode[] => {
    if (++nodes > REACH_DECK_CLIPBOARD_MAX_NODES || depth > REACH_DECK_CLIPBOARD_MAX_DEPTH) {
      throw new Error('Narration clipboard exceeds structure limits.');
    }
    if (node.type === 'text') return [{ type: 'text', text: node.text }];
    if (node.type === 'hardBreak') return [{ type: 'hardBreak' }];
    if (node.type === 'inlineMath' || node.type === 'blockMath') {
      return [{ type: node.type, attrs: { latex: node.attrs?.latex } }];
    }
    const content = (node.content ?? []).flatMap((child) => visit(child, depth + 1));
    if (
      node.type === 'doc' ||
      node.type === 'bulletList' ||
      node.type === 'orderedList' ||
      node.type === 'listItem'
    ) {
      return content;
    }
    if (node.type === 'paragraph') return [{ type: 'paragraph', content }];
    throw new Error('Unsupported narration clipboard node.');
  };
  return { type: 'doc', content: visit(document, 0) };
}

function narrationPasteTransactionValid(transaction: Transaction): boolean {
  try {
    const { markdown, speechMarkup } = serializeReachDeckNarrationSpeechDocument(
      normalizeRichText(transaction.doc.toJSON()),
      { canonicalize: true },
    );
    const canonical = analyzeReachDeckNarrationMarkdown(markdown).markdown;
    if (canonical !== markdown) return false;
    if (speechMarkup !== undefined) {
      planReachDeckSsmlChunks(
        canonical,
        canonicalizeReachDeckSpeechMarkupV1(speechMarkup, canonical),
      );
    }
    return true;
  } catch {
    return false;
  }
}

function proseMirrorPositionToNarrationMarkdown(state: EditorState, position: number): number {
  const exact = new Map<number, number>();
  let markdownAt = 0;
  let sourceMarkdown = '';
  state.doc.forEach((block, blockOffset, blockIndex) => {
    if (blockIndex > 0) {
      markdownAt += 2;
      sourceMarkdown += '\n\n';
    }
    if (block.type.name === 'blockMath') {
      const source = serializeReachDeckNarrationMarkdown({
        type: 'doc',
        content: [block.toJSON()],
      });
      sourceMarkdown += source;
      exact.set(blockOffset, markdownAt);
      exact.set(blockOffset + block.nodeSize, markdownAt + source.length);
      markdownAt += source.length;
      return;
    }
    const contentStart = blockOffset + 1;
    exact.set(contentStart, markdownAt);
    block.forEach((inline, inlineOffset) => {
      const pmFrom = contentStart + inlineOffset;
      if (isNarrationSpeechPointNodeName(inline.type.name)) {
        exact.set(pmFrom, markdownAt);
        exact.set(pmFrom + inline.nodeSize, markdownAt);
        return;
      }
      const inlineJson = inline.toJSON();
      const source = serializeReachDeckNarrationMarkdown({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ ...inlineJson, marks: undefined }] }],
      });
      sourceMarkdown += source;
      if (inline.isText) {
        for (let visibleAt = 0; visibleAt <= (inline.text?.length ?? 0); visibleAt += 1) {
          exact.set(
            pmFrom + visibleAt,
            markdownAt + narrationSourceOffsetForVisibleOffset(source, visibleAt),
          );
        }
      } else {
        exact.set(pmFrom, markdownAt);
        exact.set(pmFrom + inline.nodeSize, markdownAt + source.length);
      }
      markdownAt += source.length;
    });
    exact.set(contentStart + block.content.size, markdownAt);
  });
  const result = exact.get(position);
  if (result === undefined) throw new Error('Narration selection is outside canonical Markdown.');
  return canonicalizeReachDeckNarrationMarkdownOffsets(sourceMarkdown).offsets[result]!;
}

function narrationSourceOffsetForVisibleOffset(source: string, visibleOffset: number): number {
  let sourceAt = 0;
  let visibleAt = 0;
  while (visibleAt < visibleOffset) {
    if (source[sourceAt] === '\\') sourceAt += 1;
    const width = source.codePointAt(sourceAt)! > 0xffff ? 2 : 1;
    sourceAt += width;
    visibleAt += width;
  }
  return sourceAt;
}

function readSpeechDefinition(value: unknown): ReachDeckSpeechRichTextDefinition | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const definition = value as ReachDeckSpeechRichTextDefinition;
  return typeof definition.id === 'string' &&
    ['break', 'soundEvent', 'sub', 'say-as', 'phoneme'].includes(definition.type)
    ? definition
    : undefined;
}

function speechOpenLabel(definition: ReachDeckSpeechRichTextDefinition | undefined): string {
  if (definition === undefined) return '<invalid>';
  if (definition.type === 'sub') return `<sub alias="${escapeNarrationXml(definition.alias)}">`;
  if (definition.type === 'say-as') return `<say-as ${definition.interpretAs}>`;
  if (definition.type === 'phoneme') {
    return `<phoneme ${definition.alphabet}="${escapeNarrationXml(definition.ph)}">`;
  }
  if (definition.type === 'soundEvent') return `<soundEvent src="${definition.src}"/>`;
  return `<break ${definition.durationMs}ms/>`;
}

function isNarrationSpeechPointNodeName(type: string | undefined): boolean {
  return (
    type === REACH_DECK_SPEECH_BREAK_NODE_TYPE || type === REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE
  );
}

function nextNarrationSpeechId(): string {
  narrationSpeechIdSequence += 1;
  return `speech-${Date.now().toString(36)}-${narrationSpeechIdSequence.toString(36)}`;
}

/**
 * The shared TipTap schema is intentionally broad for slide text. Narration reuses its node views,
 * but rejects transactions that introduce any structure/mark outside the authoring contract.
 * Empty formula nodes are allowed transiently while MathLive is open; save validation rejects them.
 */
const NarrationDocumentGuard = Extension.create({
  name: 'reachDeckNarrationDocumentGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) =>
          narrationDocumentStructureAllowed(transaction.doc.toJSON()),
      }),
    ];
  },
});

/** 单段落讲稿（Interactive 页）：恰好一个段落，不允许硬换行与独立公式。 */
const NarrationSingleParagraphDocumentGuard = Extension.create({
  name: 'reachDeckNarrationSingleParagraphDocumentGuard',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) =>
          narrationDocumentStructureAllowed(transaction.doc.toJSON(), true),
      }),
    ];
  },
});

/**
 * 单段落讲稿不分段也不换行：回车类按键直接吞掉。优先级高于 StarterKit 的段落/硬换行快捷键，
 * 否则它们会先产生一个被守卫拒绝的事务，再回落到浏览器默认的 contenteditable 换行。
 */
const NarrationSingleParagraphKeymap = Extension.create({
  name: 'reachDeckNarrationSingleParagraphKeymap',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: () => true,
      'Shift-Enter': () => true,
      'Mod-Enter': () => true,
    };
  },
});

/**
 * 把粘贴/拖入的切片折叠成单段落可接受的行内片段：块之间与硬换行折叠为一个空格，
 * 独立公式降级为行内公式，制表符按空格处理。语音标记与行内公式原样保留。
 */
function foldSliceToSingleParagraph(slice: Slice, schema: Schema): Slice {
  const inlineMathType = schema.nodes.inlineMath;
  const inline: ProseMirrorNode[] = [];
  const endsWithSpace = (): boolean => {
    const last = inline.at(-1);
    return last === undefined || (last.isText && (last.text ?? '').endsWith(' '));
  };
  const pushSeparator = () => {
    if (!endsWithSpace()) inline.push(schema.text(' '));
  };
  const visit = (node: ProseMirrorNode) => {
    if (node.isText) {
      const folded = (node.text ?? '').replace(/[\t\n\r]+/gu, ' ');
      if (folded.length > 0) inline.push(schema.text(folded, node.marks));
      return;
    }
    if (node.type.name === 'hardBreak') {
      pushSeparator();
      return;
    }
    if (node.type.name === 'blockMath') {
      if (inlineMathType === undefined) return;
      pushSeparator();
      inline.push(inlineMathType.create({ latex: node.attrs.latex }));
      return;
    }
    if (node.isInline) {
      inline.push(node);
      return;
    }
    const before = inline.length;
    if (before > 0) pushSeparator();
    const separatorIndex = inline.length;
    node.forEach(visit);
    // 空块（例如首尾换行留下的空段落）不贡献内容，也不留下分隔空格。
    if (inline.length === separatorIndex) inline.length = before;
  };
  slice.content.forEach(visit);
  return new Slice(Fragment.fromArray(inline), 0, 0);
}

function narrationDocumentStructureAllowed(node: RichTextNode, singleParagraph = false): boolean {
  if (
    node.marks !== undefined &&
    (node.type !== 'text' ||
      node.marks.length !== 1 ||
      node.marks[0]?.type !== REACH_DECK_SPEECH_RICH_TEXT_MARK_TYPE ||
      readSpeechDefinition(node.marks[0].attrs?.definition)?.type === 'break')
  ) {
    return false;
  }
  if (node.type === 'doc') {
    if (singleParagraph) {
      const blocks = node.content ?? [];
      return (
        blocks.length <= 1 &&
        blocks.every(
          (child) => child.type === 'paragraph' && narrationDocumentStructureAllowed(child, true),
        )
      );
    }
    return (node.content ?? []).every(
      (child) =>
        (child.type === 'paragraph' || child.type === 'blockMath') &&
        narrationDocumentStructureAllowed(child),
    );
  }
  if (node.type === 'paragraph') {
    return (node.content ?? []).every(
      (child) =>
        [
          'text',
          ...(singleParagraph ? [] : ['hardBreak']),
          'inlineMath',
          REACH_DECK_SPEECH_BREAK_NODE_TYPE,
          REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE,
        ].includes(child.type) && narrationDocumentStructureAllowed(child),
    );
  }
  if (isNarrationSpeechPointNodeName(node.type)) {
    const definition = readSpeechDefinition(node.attrs?.definition);
    return (
      node.content === undefined &&
      node.text === undefined &&
      definition !== undefined &&
      ((node.type === REACH_DECK_SPEECH_BREAK_NODE_TYPE && definition.type === 'break') ||
        (node.type === REACH_DECK_SPEECH_SOUND_EVENT_NODE_TYPE && definition.type === 'soundEvent'))
    );
  }
  if (node.type === 'text' || node.type === 'hardBreak') return node.content === undefined;
  if (node.type === 'inlineMath' || node.type === 'blockMath') {
    return node.content === undefined && node.text === undefined;
  }
  return false;
}

function MarkButton({
  active,
  children,
  disabled,
  label,
  onToggle,
}: {
  active: boolean;
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className="reach-deck-editor__rich-text-button"
      disabled={disabled}
      onClick={onToggle}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function selectionMarkIsActive(editor: Editor, mark: string, defaultFontWeight: number): boolean {
  if (mark !== 'bold') return editor.isActive(mark);
  const explicitWeight = numericFontWeight(editor.getAttributes('textStyle').fontWeight);
  if (explicitWeight !== undefined) return explicitWeight >= 600;
  return editor.isActive('bold') || defaultFontWeight >= 600;
}

function wholeDocumentMarkIsActive(
  document: RichTextDocument,
  mark: string,
  defaultFontWeight: number,
): boolean {
  const nodes = richTextLeafNodes(document);
  if (nodes.length === 0) return mark === 'bold' && defaultFontWeight >= 600;
  return nodes.every((node) => {
    if (mark !== 'bold') return node.marks?.some((candidate) => candidate.type === mark) === true;
    const textStyle = node.marks?.find((candidate) => candidate.type === 'textStyle');
    const explicitWeight = numericFontWeight(textStyle?.attrs?.fontWeight);
    if (explicitWeight !== undefined) return explicitWeight >= 600;
    return (
      node.marks?.some((candidate) => candidate.type === 'bold') === true ||
      defaultFontWeight >= 600
    );
  });
}

function wholeDocumentTextStyleValue(
  document: RichTextDocument,
  attribute: 'fontFamily' | 'fontSize',
  fallback: string,
): string | undefined {
  const values = richTextLeafNodes(document).map((node) => {
    if (FORMULA_NODE_TYPES.has(node.type)) {
      const value = node.attrs?.[attribute];
      return value === undefined || value === null ? fallback : String(value);
    }
    const textStyle = node.marks?.find((candidate) => candidate.type === 'textStyle');
    const value = textStyle?.attrs?.[attribute];
    return value === undefined || value === null ? fallback : String(value);
  });
  if (values.length === 0) return fallback;
  return values.every((value) => value === values[0]) ? values[0] : undefined;
}

const FORMULA_NODE_TYPES = new Set(['inlineMath', 'mathInline', 'blockMath', 'mathBlock']);

function resolveToolbarFontSize({
  defaultFontSize,
  document,
  editor,
  formatWholeDocument,
}: {
  defaultFontSize: number | undefined;
  document: RichTextDocument;
  editor: Editor;
  formatWholeDocument: boolean;
}): string {
  const fallback = defaultFontSize === undefined ? '' : `${defaultFontSize}px`;
  const raw = formatWholeDocument
    ? wholeDocumentTextStyleValue(document, 'fontSize', fallback)
    : (editor.getAttributes('textStyle').fontSize ?? fallback);
  const parsed = Number.parseFloat(String(raw ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '';
}

function richTextLeafNodes(document: RichTextDocument): RichTextNode[] {
  const leaves: RichTextNode[] = [];
  const visit = (nodes: RichTextNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (
        (typeof node.text === 'string' && node.text.length > 0) ||
        FORMULA_NODE_TYPES.has(node.type)
      ) {
        leaves.push(node);
      }
      visit(node.content);
    }
  };
  visit(document.content);
  return leaves;
}

function numericFontWeight(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stableRichTextSerialization(document: RichTextDocument): string {
  return JSON.stringify(cleanRichTextForPersistence(document));
}

function cleanRichTextForPersistence(document: RichTextDocument): RichTextDocument {
  const cleanValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(cleanValue);
    if (typeof value !== 'object' || value === null) return value;
    const entries = Object.entries(value)
      .filter(([, nested]) => nested !== null && nested !== undefined)
      .map(([key, nested]) => [key, cleanValue(nested)] as const)
      .filter(([, nested]) => {
        if (Array.isArray(nested)) return nested.length > 0;
        return typeof nested !== 'object' || nested === null || Object.keys(nested).length > 0;
      })
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
  };
  return cleanValue(document) as RichTextDocument;
}
