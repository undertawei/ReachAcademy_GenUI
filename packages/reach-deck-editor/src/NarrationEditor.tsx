'use client';
import { LoadingIndicator } from '@reachany/ui';

import {
  AudioLines,
  BellRing,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Delete,
  Eraser,
  Languages,
  LoaderCircle,
  Music2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Replace,
  Save,
  ScanText,
  ScrollText,
  Space,
  Sparkles,
  Tags,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  INTERACTIVE_NARRATION_MAX_TEXT_SCALARS,
  REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS,
  REACH_DECK_NARRATION_MAX_SEMANTIC_UNITS,
  REACH_DECK_SSML_MAX_SEMANTIC_UNITS,
  REACH_DECK_SAY_AS_INTERPRETATIONS,
  REACH_DECK_SPEECH_EFFECTS,
  ReachDeckNarrationMarkdownError,
  ReachDeckSpeechMarkupError,
  analyzeReachDeckNarrationMarkdown,
  canonicalizeReachDeckSpeechMarkupV1,
  parseReachDeckNarrationMarkdown,
  parseReachDeckNarrationSpeechDocument,
  planReachDeckSsmlChunks,
  planReachDeckSsmlSelectionChunks,
  reachDeckInteractiveNarrationContentDigestInput,
  reachDeckInteractiveNarrationMarkdown,
  reachDeckInteractiveNarrationTextFromMarkdown,
  reachDeckNarrationMarkdown,
  reachDeckNarrationSpeechContentDigestInput,
  serializeReachDeckNarrationSpeechDocument,
  type ReachDeckSpeechMarkV1,
  type ReachDeckSpeechMarkupV1,
  type ReachDeckSpeechEffectV1,
  type ReachDeckSpeakOptionsV1,
  type ReachDeckInteractiveNarrationV1,
  type ReachDeckNativeSlideV2,
  type RichTextDocument,
} from '@reachany/reach-deck-dsl';
import { translateReachDeck, type ReachDeckTranslate } from '@reachany/reach-deck-player';
import { ConfirmDialog, Select } from '@reachany/ui';
import { userFacingErrorMessage } from './userFacingError.js';
import { escapeNarrationXml } from './narrationClipboard.js';
import type {
  InteractiveNarrationDraftSnapshot,
  InteractiveNarrationValidationError,
} from './interactiveNarration.js';

import {
  RichTextElementEditor,
  type NarrationSpeechEditorHandle,
  type NarrationSpeechSelection,
} from './RichTextElementEditor.js';

export interface NarrationSpeechMarkupCandidate {
  id: string;
  mark: ReachDeckSpeechMarkV1;
  sourceText: string;
}

export interface NarrationSpeechPreviewAudio {
  dataBase64: string;
  contentType: string;
}

export interface NarrationSpeechPreviewTrack extends NarrationSpeechPreviewAudio {
  id: string;
  label: string;
}

export interface NarrationSpeechPreviewCollection {
  tracks: readonly NarrationSpeechPreviewTrack[];
}

export type NarrationSpeechPreviewResult =
  | NarrationSpeechPreviewAudio
  | NarrationSpeechPreviewCollection;

export type NarrationSpeechPreviewStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'draining'
  | 'expired'
  | 'cancelling'
  | 'cancel-unconfirmed';

export interface NarrationDraftCacheEntry {
  operation?: object;
  draftState: NarrationDraftState;
  speechSpeak: ReachDeckSpeakOptionsV1 | undefined;
  baselineIdentity: string;
  sourceIdentity: string;
  dirty: boolean;
}

export type NarrationDraftCache = Map<string, NarrationDraftCacheEntry>;

/** Serialize cached edits through the same validation used by the narration Save action. */
export function prepareNarrationDraftForRegeneration(
  entry: NarrationDraftCacheEntry,
  source: { slide?: ReachDeckNativeSlideV2; interactive?: NarrationEditorInteractiveSource },
  translate?: ReachDeckTranslate,
  allowedSpeechMarkTypes: readonly ReachDeckSpeechMarkV1['type'][] = DEFAULT_SPEECH_MARK_TYPES,
): {
  markdown: string;
  speechMarkup?: ReachDeckSpeechMarkupV1;
  text?: string;
  baselineIdentity: string;
  sourceIdentity: string;
} {
  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  const sourceMarkdown =
    source.interactive?.narration?.text ??
    source.slide?.narration?.markdown ??
    reachDeckNarrationMarkdown(source.slide?.narration) ??
    '';
  const sourceMarkup =
    source.interactive?.narration?.speechMarkup ?? source.slide?.narration?.speechMarkup;
  const sourceIdentity = sourceMarkdown + '\u0000' + JSON.stringify(sourceMarkup);
  if (entry.sourceIdentity !== sourceIdentity)
    throw Object.assign(
      new Error(
        text(
          'reachDeck.regeneration.draftConflict',
          '讲稿已在其他位置发生变化，请先检查并保存当前草稿。',
        ),
      ),
      { name: 'ReachDeckUserFacingError' },
    );
  try {
    const serialized = serializeReachDeckNarrationSpeechDocument(entry.draftState.draft, {
      canonicalize: true,
    });
    const markdown = analyzeReachDeckNarrationMarkdown(serialized.markdown).markdown;
    const speechMarkup = buildSpeechMarkup(
      markdown,
      serialized.speechMarkup?.marks ?? [],
      entry.speechSpeak,
    );
    if (speechMarkup !== undefined) {
      planReachDeckSsmlChunks(markdown, speechMarkup);
      if (
        speechMarkup.speak !== undefined ||
        speechMarkup.marks.some((mark) => !allowedSpeechMarkTypes.includes(mark.type))
      )
        throw new Error('unsupported speech markup');
    }
    if (source.interactive !== undefined) {
      const value = interactiveNarrationDraftValue(markdown, speechMarkup);
      return {
        markdown,
        text: value.text,
        speechMarkup: value.speechMarkup,
        baselineIdentity: interactiveNarrationIdentity(value.text, value.speechMarkup),
        sourceIdentity: value.text + '\u0000' + JSON.stringify(value.speechMarkup),
      };
    }
    return {
      markdown,
      speechMarkup,
      baselineIdentity: narrationSpeechIdentity(markdown, speechMarkup),
      sourceIdentity: markdown + '\u0000' + JSON.stringify(speechMarkup),
    };
  } catch {
    throw Object.assign(
      new Error(
        text('reachDeck.regeneration.invalidDraft', '有未保存的讲稿未通过校验，请先修正后再生成。'),
      ),
      { name: 'ReachDeckUserFacingError' },
    );
  }
}

/** Interactive 页讲稿来源：单段落文本 + 可选语音标记，没有分段、时间戳与讲稿动画。 */
export interface NarrationEditorInteractiveSource {
  id: string;
  narration?: ReachDeckInteractiveNarrationV1;
  /** 宿主投影的音频生成状态；缺省表示没有排队、进行中或失败的生成。 */
  generationState?: 'queued' | 'generating' | 'failed';
}

/** Interactive 变体对宿主暴露的命令：画布下方状态条的保存/重试与面板主按钮走同一条保存路径。 */
export interface NarrationEditorInteractiveHandle {
  saveAndGenerate(): Promise<void>;
}

interface NarrationEditorCommonProps {
  /** Product workbench moves generation choices to its canvas dialog. Editing and saving stay available. */
  hideGenerationMenu?: boolean;
  /** Session-owned cache; the host must scope keys to a deck and page. */
  draftCache?: NarrationDraftCache;
  draftCacheKey?: string;
  allowedSpeechMarkTypes?: readonly ReachDeckSpeechMarkV1['type'][];
  /** Harness-only opt-in for editing provider-level attributes on the root `<speak>` element. */
  allowSpeechDocumentSettings?: boolean;
  applying?: boolean;
  disabled?: boolean;
  /** 完整流水线：AI 重写本页讲稿并重新合成音频；幻灯片页还会重新生成讲稿动画。 */
  onRegenerate?: () => Promise<void> | void;
  onRequestSpeechMarkupCandidates?: (
    input: { markdown: string; speechMarkup?: ReachDeckSpeechMarkupV1 },
    signal: AbortSignal,
  ) => Promise<readonly NarrationSpeechMarkupCandidate[]>;
  onPreviewSpeech?: (
    input: {
      markdown: string;
      markdownFrom: number;
      markdownTo: number;
      speechMarkup?: ReachDeckSpeechMarkupV1;
    },
    signal: AbortSignal,
    onProgress?: (status: NarrationSpeechPreviewStatus) => void,
  ) => Promise<NarrationSpeechPreviewResult>;
  /** Optional host-owned renderer for diagnostic preview tracks. */
  renderPreviewTrack?: (track: NarrationSpeechPreviewTrack, index: number) => ReactNode;
  /** Changing local preview controls invalidates the currently displayed result. */
  previewSettingsKey?: string;
  /** Defaults to the selected passage; audition dialogs can preview the entire draft. */
  previewScope?: 'selection' | 'document';
  /** Dialog hosts can keep playback inside their own focus and scroll boundary. */
  previewPresentation?: 'popover' | 'inline';
  /** Host-translated limits displayed beside the preview action. */
  previewLimitLabel?: string;
  /** Defaults to `disabled`; hosts may keep editing locked while allowing a new AI attempt. */
  regenerateDisabled?: boolean;
  /**
   * Another operation (for example a running Decksmith request) owns the deck: every action that
   * starts narration, audio or animation generation is disabled with this reason. Drafts still save.
   */
  generationBlockedReason?: string;
  regenerateButtonRef?: Ref<HTMLButtonElement>;
  /** Only affects the initial editor view; persisted speech markup remains authoritative. */
  speechTagsInitiallyVisible?: boolean;
  translate?: ReachDeckTranslate;
}

export interface NarrationEditorSlideProps extends NarrationEditorCommonProps {
  slide: ReachDeckNativeSlideV2;
  interactive?: undefined;
  actionsRef?: undefined;
  onDraftChange?: undefined;
  /** Opaque provider candidate shown for teacher review after exhausted narration correction. */
  fallbackMarkdown?: string;
  /** 仅用 AI 重写本页讲稿文字；宿主落地时清除本页音频与讲稿驱动动画。缺省不渲染该项。 */
  onRegenerateTextOnly?: () => Promise<void> | void;
  onRegenerateAnimations?: (input: {
    markdown: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onRegenerateAnimationsOnly?: (input: {
    markdown: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onSaveAndGenerate?: (input: {
    markdown: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onSaveAudio?: (input: {
    markdown: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  onSaveDraft?: (input: {
    markdown: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
}

/**
 * Interactive 页讲稿：与幻灯片讲稿共用工具栏、语音标记、智能打标与试听，但没有动画、仅讲稿重写、
 * 仅生成音频和仅保存草稿（Interactive 页播放依赖音频，草稿会阻断发布）。
 */
export interface NarrationEditorInteractiveProps extends NarrationEditorCommonProps {
  interactive: NarrationEditorInteractiveSource;
  slide?: undefined;
  /** 供画布下方状态条触发与主按钮相同的保存。 */
  actionsRef?: Ref<NarrationEditorInteractiveHandle>;
  /** 草稿、校验或保存状态变化时上报，宿主据此驱动状态条；首次挂载也会上报一次。 */
  onDraftChange?: (draft: InteractiveNarrationDraftSnapshot) => void;
  /** `text` 为规范化单段落讲稿，`speechMarkup` 锚定在 `reachDeckInteractiveNarrationMarkdown(text)` 上。 */
  onSaveAndGenerate?: (input: {
    text: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
  }) => Promise<void> | void;
  fallbackMarkdown?: undefined;
  onRegenerateTextOnly?: undefined;
  onRegenerateAnimations?: undefined;
  onRegenerateAnimationsOnly?: undefined;
  onSaveAudio?: undefined;
  onSaveDraft?: undefined;
}

export type NarrationEditorProps = NarrationEditorSlideProps | NarrationEditorInteractiveProps;

/**
 * 已保存讲稿是否带有可驱动动画的音频时间戳：仅重新生成动画沿用现有音频，
 * 因此要求音频、正时长与逐段起止时间齐全，且分段文字与已保存讲稿一致。
 */
export function hasReachDeckNarrationAudioTiming(slide: ReachDeckNativeSlideV2): boolean {
  const narration = slide.narration;
  const segments = narration?.segments ?? [];
  return (
    narration?.audioResourceId !== undefined &&
    narration.markdown !== undefined &&
    slide.duration !== undefined &&
    slide.duration > 0 &&
    segments.length > 0 &&
    segments.map((segment) => segment.text).join('') ===
      (reachDeckNarrationMarkdown(narration) ?? '') &&
    segments.every((segment) => segment.start !== undefined && segment.end !== undefined)
  );
}

export function NarrationEditor(props: NarrationEditorProps) {
  const {
    allowedSpeechMarkTypes = DEFAULT_SPEECH_MARK_TYPES,
    allowSpeechDocumentSettings = false,
    applying = false,
    disabled = false,
    hideGenerationMenu = false,
    draftCache,
    draftCacheKey: providedDraftCacheKey,
    onRegenerate,
    onRequestSpeechMarkupCandidates,
    onPreviewSpeech,
    renderPreviewTrack,
    previewSettingsKey,
    previewScope = 'selection',
    previewPresentation = 'popover',
    previewLimitLabel,
    regenerateDisabled = disabled,
    generationBlockedReason,
    regenerateButtonRef,
    speechTagsInitiallyVisible = false,
    slide,
    interactive,
    translate,
  } = props;
  // Interactive 变体没有动画、仅讲稿重写、仅音频与草稿保存：即使宿主误传也不生效。
  const isInteractive = interactive !== undefined;
  const fallbackMarkdown = isInteractive ? undefined : props.fallbackMarkdown;
  const onRegenerateTextOnly = isInteractive ? undefined : props.onRegenerateTextOnly;
  const onRegenerateAnimations = isInteractive ? undefined : props.onRegenerateAnimations;
  const onRegenerateAnimationsOnly = isInteractive ? undefined : props.onRegenerateAnimationsOnly;
  const onSaveDraft = isInteractive ? undefined : props.onSaveDraft;
  const onSaveAudio = isInteractive ? undefined : props.onSaveAudio;
  const hasSaveAndGenerate = props.onSaveAndGenerate !== undefined;
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const draftCacheKey = providedDraftCacheKey ?? interactive?.id ?? slide?.id ?? '';
  const generationBlocked = generationBlockedReason !== undefined;
  const interactiveNarration = interactive?.narration;
  const interactiveNarrationText = interactiveNarration?.text;
  const interactiveNarrationSpeechMarkup = interactiveNarration?.speechMarkup;
  const interactiveSource = useMemo(
    () =>
      isInteractive
        ? readInteractiveNarrationSource(interactiveNarrationText, interactiveNarrationSpeechMarkup)
        : undefined,
    [isInteractive, interactiveNarrationSpeechMarkup, interactiveNarrationText],
  );
  const sourceMarkdown =
    interactiveSource === undefined
      ? (reachDeckNarrationMarkdown(slide?.narration) ?? '')
      : interactiveSource.markdown;
  const sourceSpeechMarkup =
    interactiveSource === undefined
      ? slide?.narration?.speechMarkup
      : interactiveSource.speechMarkup;
  // 无法用讲稿 Markdown 方言表达的 Interactive 文本（如以 `1. ` 开头）按字面量载入，教师可编辑修正。
  const sourceLiteralText = interactiveSource?.literalText;
  const sourceBaselineIdentity =
    interactiveSource === undefined
      ? narrationSpeechIdentity(sourceMarkdown, sourceSpeechMarkup)
      : interactiveSource.baselineIdentity;
  const latestSourceRef = useRef({
    sourceMarkdown,
    sourceSpeechMarkup,
    fallbackMarkdown,
    sourceLiteralText,
    sourceBaselineIdentity,
  });
  latestSourceRef.current = {
    sourceMarkdown,
    sourceSpeechMarkup,
    fallbackMarkdown,
    sourceLiteralText,
    sourceBaselineIdentity,
  };
  const manualReviewActive = fallbackMarkdown !== undefined;
  // Ignore timing/audio-only updates when authoritative Markdown exists. They must not overwrite a
  // teacher's in-progress draft. Legacy segment text remains the source until the first save.
  const sourceIdentity = manualReviewActive
    ? `manual-review:${fallbackMarkdown}`
    : isInteractive
      ? `${interactiveNarrationText ?? ''}\u0000${JSON.stringify(sourceSpeechMarkup)}`
      : `${slide?.narration?.markdown ?? sourceMarkdown}\u0000${JSON.stringify(sourceSpeechMarkup)}`;
  const cachedDraft = fallbackMarkdown === undefined ? draftCache?.get(draftCacheKey) : undefined;
  const initialCachedDraft =
    cachedDraft && (cachedDraft.dirty || cachedDraft.sourceIdentity === sourceIdentity)
      ? cachedDraft
      : undefined;
  const [draftState, setDraftState] = useState(
    () =>
      initialCachedDraft?.draftState ??
      createNarrationDraft(sourceMarkdown, sourceSpeechMarkup, fallbackMarkdown, sourceLiteralText),
  );
  const [baselineIdentity, setBaselineIdentity] = useState(() =>
    initialCachedDraft === undefined ||
    (isInteractive && initialCachedDraft.sourceIdentity !== sourceIdentity)
      ? sourceBaselineIdentity
      : initialCachedDraft.baselineIdentity,
  );
  const [observedSourceIdentity, setObservedSourceIdentity] = useState(sourceIdentity);
  const [activeSlideId, setActiveSlideId] = useState(draftCacheKey);
  const currentPageRef = useRef(draftCacheKey);
  currentPageRef.current = draftCacheKey;
  const mountedRef = useRef(true);
  const [busyAction, setBusyAction] = useState<
    'regenerate' | 'regenerate-text' | 'save' | 'draft' | 'animations' | 'audio'
  >();
  const [audioConfirmation, setAudioConfirmation] = useState(false);
  const [animationConfirmation, setAnimationConfirmation] = useState(false);
  const [animationOnlyConfirmation, setAnimationOnlyConfirmation] = useState(false);
  const [actionError, setActionError] = useState<string>();
  /** Interactive 状态条只把保存失败投影为“生成失败”；AI 重写失败只留在面板内。 */
  const [actionErrorKind, setActionErrorKind] = useState<'save' | 'other'>('other');
  const actionErrorSourceIdentityRef = useRef<string | undefined>(undefined);
  const [regenerateConfirmation, setRegenerateConfirmation] = useState<
    'saved' | 'dirty' | undefined
  >();
  const [textOnlyConfirmation, setTextOnlyConfirmation] = useState<'saved' | 'dirty' | undefined>();
  const speechControllerRef = useRef<NarrationSpeechEditorHandle>(null);
  const speechRequestRef = useRef<AbortController | undefined>(undefined);
  const [showSpeechTags, setShowSpeechTags] = useState(speechTagsInitiallyVisible);
  const [speechSelection, setSpeechSelection] = useState<NarrationSpeechSelection>({
    empty: true,
    markdownFrom: 0,
    markdownTo: 0,
    text: '',
  });
  const [speechMarkDialog, setSpeechMarkDialog] = useState<SpeechMarkDialogState>();
  const speechMarkTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [speechSettingsOpen, setSpeechSettingsOpen] = useState(false);
  const speechSettingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [speechSpeak, setSpeechSpeak] = useState<ReachDeckSpeakOptionsV1 | undefined>(() =>
    initialCachedDraft
      ? initialCachedDraft.speechSpeak
      : fallbackMarkdown === undefined
        ? cloneSpeakOptions(sourceSpeechMarkup?.speak)
        : undefined,
  );
  const [breakDurationMs, setBreakDurationMs] = useState(300);
  const [soundEventSrc, setSoundEventSrc] = useState('');
  const [alias, setAlias] = useState('');
  const [interpretAs, setInterpretAs] =
    useState<(typeof REACH_DECK_SAY_AS_INTERPRETATIONS)[number]>('Cardinal');
  const [alphabet, setAlphabet] = useState<'py' | 'cmu' | 'ipa'>('py');
  const [phoneme, setPhoneme] = useState('');
  const [speakBgm, setSpeakBgm] = useState('');
  const [speakVolume, setSpeakVolume] = useState<number | ''>('');
  const [speakEffect, setSpeakEffect] = useState<ReachDeckSpeechEffectV1 | ''>('');
  const [speechBusy, setSpeechBusy] = useState<'candidates' | 'preview'>();
  const [speechCandidates, setSpeechCandidates] = useState<
    readonly NarrationSpeechMarkupCandidate[]
  >([]);
  const [previewResult, setPreviewResult] = useState<NarrationSpeechPreviewResult>();
  const [previewStatus, setPreviewStatus] = useState<NarrationSpeechPreviewStatus>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const previewPanelRef = useRef<HTMLDivElement>(null);
  const previewReasonId = useId();
  const previousPreviewSettingsKey = useRef(previewSettingsKey);
  const [markNotice, setMarkNotice] = useState<string>();
  const [pasteNotice, setPasteNotice] = useState<string>();
  const allowedSpeechMarkTypeSet = useMemo(
    () => new Set(allowedSpeechMarkTypes),
    [allowedSpeechMarkTypes],
  );
  const allowedSmartSpeechMarkTypeSet = useMemo(
    () =>
      new Set<ReachDeckSpeechMarkV1['type']>(
        allowedSpeechMarkTypes.filter(
          (type) => type === 'sub' || type === 'say-as' || type === 'phoneme',
        ),
      ),
    [allowedSpeechMarkTypes],
  );
  const smartSpeechUnsupported = allowedSmartSpeechMarkTypeSet.size === 0;

  useEffect(() => {
    // A source echo can arrive while the current save/rewrite is still in flight.
    // Defer adoption until that operation settles so it cannot unlock the UI or
    // restore the pre-operation draft prematurely.
    if (busyAction !== undefined && draftCacheKey === activeSlideId) return;
    if (draftCacheKey === activeSlideId && sourceIdentity === observedSourceIdentity) return;
    const candidate = fallbackMarkdown === undefined ? draftCache?.get(draftCacheKey) : undefined;
    const cached =
      candidate && (candidate.dirty || candidate.sourceIdentity === sourceIdentity)
        ? candidate
        : undefined;
    setActiveSlideId(draftCacheKey);
    setObservedSourceIdentity(sourceIdentity);
    setBaselineIdentity(
      // Interactive 的未保存草稿随权威讲稿重基：草稿与新来源一致时即不再算脏。
      cached === undefined || (isInteractive && cached.sourceIdentity !== sourceIdentity)
        ? sourceBaselineIdentity
        : cached.baselineIdentity,
    );
    setDraftState(
      cached
        ? cached.draftState
        : createNarrationDraft(
            sourceMarkdown,
            sourceSpeechMarkup,
            fallbackMarkdown,
            sourceLiteralText,
          ),
    );
    setBusyAction(undefined);
    setAudioConfirmation(false);
    setAnimationConfirmation(false);
    setAnimationOnlyConfirmation(false);
    setRegenerateConfirmation(undefined);
    setTextOnlyConfirmation(undefined);
    const request = speechRequestRef.current;
    speechRequestRef.current = undefined;
    request?.abort();
    setSpeechBusy(undefined);
    setSpeechCandidates([]);
    setPreviewResult(undefined);
    setPreviewStatus(undefined);
    setPreviewError(undefined);
    setPreviewOpen(false);
    setSpeechSelection({ empty: true, markdownFrom: 0, markdownTo: 0, text: '' });
    setMarkNotice(undefined);
    setPasteNotice(undefined);
    setSpeechMarkDialog(undefined);
    setSpeechSettingsOpen(false);
    setSpeechSpeak(
      cached
        ? cached.speechSpeak
        : fallbackMarkdown === undefined
          ? cloneSpeakOptions(sourceSpeechMarkup?.speak)
          : undefined,
    );
    // A failed operation may have already received its own source echo. Adopt
    // that source so the draft cache keeps tracking it, while preserving the
    // failure until the next explicit operation or source change.
    if (actionError === undefined || actionErrorSourceIdentityRef.current !== sourceIdentity) {
      actionErrorSourceIdentityRef.current = undefined;
      setActionError(undefined);
    }
  }, [
    activeSlideId,
    actionError,
    busyAction,
    draftCache,
    draftCacheKey,
    fallbackMarkdown,
    isInteractive,
    observedSourceIdentity,
    sourceBaselineIdentity,
    sourceIdentity,
    sourceLiteralText,
    sourceMarkdown,
    sourceSpeechMarkup,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const request = speechRequestRef.current;
      speechRequestRef.current = undefined;
      request?.abort();
    };
  }, []);

  useEffect(() => {
    if (previousPreviewSettingsKey.current === previewSettingsKey) return;
    previousPreviewSettingsKey.current = previewSettingsKey;
    const request = speechRequestRef.current;
    speechRequestRef.current = undefined;
    request?.abort();
    setSpeechBusy(undefined);
    setPreviewResult(undefined);
    setPreviewStatus(undefined);
    setPreviewError(undefined);
    setPreviewOpen(false);
  }, [previewSettingsKey]);

  const analysis = useMemo(() => {
    try {
      return {
        value: (() => {
          const serialized = serializeReachDeckNarrationSpeechDocument(draftState.draft, {
            canonicalize: true,
          });
          const markdown = analyzeReachDeckNarrationMarkdown(serialized.markdown);
          const speechMarkup = buildSpeechMarkup(
            markdown.markdown,
            serialized.speechMarkup?.marks ?? [],
            speechSpeak,
          );
          if (speechMarkup !== undefined) {
            planReachDeckSsmlChunks(markdown.markdown, speechMarkup);
          }
          return {
            ...markdown,
            speechMarkup,
            // Interactive 保存的是空白规范化后的单段落文本；试听与智能打标仍用编辑器原始 Markdown，
            // 这样选区与候选偏移和编辑器文档一致。
            interactive: isInteractive
              ? interactiveNarrationDraftValue(markdown.markdown, speechMarkup)
              : undefined,
          };
        })(),
      };
    } catch (error) {
      return { error };
    }
  }, [draftState.draft, isInteractive, speechSpeak]);
  const effectiveDraftMarkdown = analysis.value?.markdown;
  const effectiveSpeechMarkup = analysis.value?.speechMarkup;
  const interactiveDraft = analysis.value?.interactive;
  const draftEmpty =
    analysis.error instanceof ReachDeckNarrationMarkdownError && analysis.error.code === 'empty';
  const interactiveDraftEmpty = isInteractive && draftEmpty;
  const activeDraftIdentity = isInteractive
    ? interactiveDraft === undefined
      ? interactiveDraftEmpty
        ? INTERACTIVE_EMPTY_NARRATION_IDENTITY
        : undefined
      : interactiveNarrationIdentity(interactiveDraft.text, interactiveDraft.speechMarkup)
    : effectiveDraftMarkdown === undefined
      ? undefined
      : narrationSpeechIdentity(effectiveDraftMarkdown, effectiveSpeechMarkup);
  const activeDraftIdentityRef = useRef(activeDraftIdentity);
  activeDraftIdentityRef.current = activeDraftIdentity;
  // 按字面量载入且尚未编辑的 Interactive 讲稿就是已保存内容本身，不算未保存修改。
  const untouchedLiteralSource = isInteractive && draftState.untouched === true;
  const dirty = isInteractive
    ? !untouchedLiteralSource &&
      (activeDraftIdentity === undefined || activeDraftIdentity !== baselineIdentity)
    : effectiveDraftMarkdown === undefined
      ? // 还没有讲稿的页打开时就是空草稿，不算未保存修改；否则它会作为脏草稿留在缓存里，
        // 之后生成的讲稿落地也会被这份空草稿挡住，讲稿栏一直空白。
        !(draftEmpty && baselineIdentity === EMPTY_NARRATION_IDENTITY)
      : activeDraftIdentity !== baselineIdentity;
  // 草稿与已保存讲稿一致时，保存/重试原样提交已保存内容，避免规范化往返改写存量文本。
  const interactiveMatchesSource =
    untouchedLiteralSource ||
    (activeDraftIdentity !== undefined && activeDraftIdentity === sourceBaselineIdentity);
  const interactiveSavePayload: InteractiveNarrationSavePayload | undefined = !isInteractive
    ? undefined
    : interactiveMatchesSource && interactiveNarrationText !== undefined
      ? {
          text: interactiveNarrationText,
          ...(interactiveNarrationSpeechMarkup === undefined
            ? {}
            : { speechMarkup: interactiveNarrationSpeechMarkup }),
        }
      : interactiveDraft === undefined
        ? undefined
        : {
            text: interactiveDraft.text,
            ...(interactiveDraft.speechMarkup === undefined
              ? {}
              : { speechMarkup: interactiveDraft.speechMarkup }),
          };
  const savePayloadReady = isInteractive
    ? interactiveSavePayload !== undefined
    : effectiveDraftMarkdown !== undefined;
  const interactiveScalarCount = useMemo(() => {
    if (!isInteractive) return undefined;
    if (interactiveDraft !== undefined) return interactiveDraft.scalarCount;
    try {
      return interactiveNarrationScalarCount(
        collapseInteractiveNarrationSpacing(
          serializeReachDeckNarrationSpeechDocument(draftState.draft, { canonicalize: true })
            .markdown,
          undefined,
        ).markdown,
      );
    } catch {
      return undefined;
    }
  }, [draftState.draft, interactiveDraft, isInteractive]);
  useLayoutEffect(() => {
    if (activeSlideId !== draftCacheKey || observedSourceIdentity !== sourceIdentity) return;
    if (manualReviewActive) {
      draftCache?.delete(draftCacheKey);
      return;
    }
    draftCache?.set(draftCacheKey, {
      operation: draftCache.get(draftCacheKey)?.operation,
      draftState,
      speechSpeak,
      baselineIdentity,
      sourceIdentity,
      dirty,
    });
  }, [
    activeSlideId,
    draftCacheKey,
    observedSourceIdentity,
    sourceIdentity,
    draftCache,
    draftState,
    manualReviewActive,
    speechSpeak,
    baselineIdentity,
    dirty,
  ]);

  // 尚未编辑的字面量讲稿只显示载入提示；开始编辑后才按草稿校验。
  const validationError = untouchedLiteralSource
    ? undefined
    : isInteractive
      ? interactiveNarrationValidationMessage(analysis.error, text)
      : narrationValidationMessage(analysis.error, text);
  const unsupportedSpeechMarkCount =
    effectiveSpeechMarkup?.marks.filter((mark) => !allowedSpeechMarkTypeSet.has(mark.type))
      .length ?? 0;
  const unsupportedSpeechDocumentSettings =
    effectiveSpeechMarkup?.speak !== undefined && !allowSpeechDocumentSettings;
  const speechCapabilityBlocked =
    unsupportedSpeechMarkCount > 0 || unsupportedSpeechDocumentSettings;
  const previewRange =
    previewScope === 'document'
      ? { from: 0, to: effectiveDraftMarkdown?.length ?? 0 }
      : { from: speechSelection.markdownFrom, to: speechSelection.markdownTo };
  const previewIncompleteReason =
    previewScope === 'document'
      ? text(
          'reachDeck.editor.narration.speech.previewDocumentIncomplete',
          '请输入完整且可朗读的文字。',
        )
      : text('reachDeck.editor.narration.speech.previewIncomplete', '请选择完整且可朗读的文字。');
  const previewTooLongReason =
    previewScope === 'document'
      ? text(
          'reachDeck.editor.narration.speech.previewDocumentTooLong',
          '输入的文字太长，单次试听按讲稿编辑框计数最多 80，且包含语音标记最多 150 字符。',
        )
      : text(
          'reachDeck.editor.narration.speech.previewTooLong',
          '选中的文字太长，单次试听按讲稿编辑框计数最多 80，且包含语音标记最多 150 字符。',
        );
  const previewDisabledReason = (() => {
    if (disabled || busyAction !== undefined || applying) {
      return text(
        'reachDeck.editor.narration.speech.previewBusy',
        '当前无法试听，请等待操作完成。',
      );
    }
    if (analysis.value === undefined) {
      return previewScope === 'document'
        ? text(
            'reachDeck.editor.narration.speech.previewDocumentInvalid',
            '请先输入有效的试听文字。',
          )
        : text(
            'reachDeck.editor.narration.speech.previewInvalidDraft',
            '请先修正讲稿内容，再选择文字试听。',
          );
    }
    if (speechCapabilityBlocked) {
      return text(
        'reachDeck.editor.narration.speech.previewUnsupported',
        '当前音色不支持讲稿中的语音标记。',
      );
    }
    if (speechBusy !== undefined && speechBusy !== 'preview') {
      return text(
        'reachDeck.editor.narration.speech.previewBusy',
        '当前无法试听，请等待操作完成。',
      );
    }
    if (
      (previewScope === 'selection' && speechSelection.empty) ||
      previewRange.from === previewRange.to
    ) {
      return previewScope === 'document'
        ? previewIncompleteReason
        : text(
            'reachDeck.editor.narration.speech.previewSelectText',
            '请先在讲稿中选择要试听的文字。',
          );
    }
    try {
      const chunks = planReachDeckSsmlSelectionChunks(
        analysis.value.markdown,
        analysis.value.speechMarkup,
        previewRange,
      );
      if (chunks.length === 1 && chunks[0]?.alignmentTranscript.trim()) return undefined;
      return chunks.length > 1 ? previewTooLongReason : previewIncompleteReason;
    } catch (error) {
      return error instanceof ReachDeckSpeechMarkupError && error.code === 'chunk-unit-limit'
        ? previewTooLongReason
        : previewIncompleteReason;
    }
  })();
  const unsupportedSpeechCapabilityCount =
    unsupportedSpeechMarkCount + (unsupportedSpeechDocumentSettings ? 1 : 0);
  const activeSelectionUnsupported =
    speechSelection.active !== undefined &&
    !allowedSpeechMarkTypeSet.has(speechSelection.active.type);
  const busy = busyAction !== undefined;
  const regenerateLabel =
    busyAction === 'regenerate'
      ? text('reachDeck.editor.narration.regenerating', '正在重新生成…')
      : isInteractive
        ? text('reachDeck.editor.interactiveNarration.regenerate', '重新生成本页讲稿和音频')
        : text('reachDeck.editor.narration.regenerate', '重新生成本页讲稿、音频和动画');
  const regenerateTextOnlyLabel =
    busyAction === 'regenerate-text'
      ? text('reachDeck.editor.narration.regeneratingTextOnly', '正在重新生成讲稿…')
      : text('reachDeck.editor.narration.regenerateTextOnly', '仅重新生成本页讲稿');
  const partialGenerationLabel = text(
    'reachDeck.editor.narration.partialGeneration',
    '更多部分生成',
  );
  const saveLabel = isInteractive
    ? busyAction === 'save'
      ? text('reachDeck.editor.interactiveNarration.saving', '正在保存并生成…')
      : text('reachDeck.editor.interactiveNarration.saveNarrationAndGenerate', '保存讲稿并生成音频')
    : busyAction === 'save'
      ? text('reachDeck.editor.narration.saving', '正在应用…')
      : text('reachDeck.editor.narration.saveAndGenerate', '保存讲稿并生成音频与动画');
  const narrationApplied =
    !dirty &&
    baselineIdentity === sourceBaselineIdentity &&
    slide?.narration?.audioResourceId !== undefined &&
    (slide.narration.segments?.length ?? 0) > 0;
  const interactiveSaveFailed = actionError !== undefined && actionErrorKind === 'save';
  // 与画布下方状态条同一套优先级：保存失败 > 未保存 > 生成失败 > 排队/生成中 > 已就绪 > 待生成。
  const narrationState = isInteractive
    ? busyAction === 'save'
      ? text('reachDeck.editor.interactiveNarration.saving', '正在保存并生成…')
      : interactiveSaveFailed
        ? text('reachDeck.editor.interactiveNarration.failed', '互动讲稿音频生成失败')
        : dirty
          ? text('reachDeck.editor.narration.unsaved', '有未保存的修改')
          : interactive?.generationState === 'failed'
            ? text('reachDeck.editor.interactiveNarration.failed', '互动讲稿音频生成失败')
            : interactive?.generationState === 'queued'
              ? text('reachDeck.editor.interactiveNarration.queued', '音频排队中')
              : interactive?.generationState === 'generating' || applying
                ? text('reachDeck.editor.interactiveNarration.generating', '正在生成音频')
                : interactiveNarration?.audioResourceId !== undefined
                  ? text('reachDeck.editor.interactiveNarration.ready', '互动讲稿音频已就绪')
                  : text('reachDeck.editor.interactiveNarration.pending', '待生成音频')
    : busyAction === 'save' || busyAction === 'audio' || busyAction === 'animations' || applying
      ? text('reachDeck.editor.narration.updating', '正在更新旁白…')
      : dirty
        ? text('reachDeck.editor.narration.unsaved', '有未保存的修改')
        : narrationApplied
          ? text('reachDeck.editor.narration.applied', '已应用')
          : text('reachDeck.editor.narration.savedPending', '已保存，旁白待更新');

  const operationRef = useRef<object | undefined>(undefined);
  const beginDraftOperation = () => {
    const operation = {};
    operationRef.current = operation;
    const cached = draftCache?.get(draftCacheKey);
    if (cached) draftCache?.set(draftCacheKey, { ...cached, operation });
    return () =>
      draftCache === undefined || (manualReviewActive && cached === undefined)
        ? operationRef.current === operation
        : draftCache.get(draftCacheKey)?.operation === operation;
  };

  const performRegenerate = async (textOnly = false) => {
    const regenerate = textOnly ? onRegenerateTextOnly : onRegenerate;
    if (regenerate === undefined) return;
    const regeneratingPage = draftCacheKey;
    const ownsOperation = beginDraftOperation();
    const confirmedDraft = draftCache?.get(regeneratingPage);
    const canUpdate = () =>
      mountedRef.current && currentPageRef.current === regeneratingPage && ownsOperation();
    setActionError(undefined);
    setBusyAction(textOnly ? 'regenerate-text' : 'regenerate');
    try {
      await regenerate();
      // The teacher explicitly confirmed replacing the draft with generated narration.
      const latestDraft = draftCache?.get(regeneratingPage);
      const stillConfirmedDraft =
        ownsOperation() &&
        latestDraft?.draftState === confirmedDraft?.draftState &&
        latestDraft?.speechSpeak === confirmedDraft?.speechSpeak;
      if (stillConfirmedDraft && confirmedDraft) {
        const source = latestSourceRef.current;
        draftCache?.set(regeneratingPage, {
          ...confirmedDraft,
          draftState: createNarrationDraft(
            source.sourceMarkdown,
            source.sourceSpeechMarkup,
            source.fallbackMarkdown,
            source.sourceLiteralText,
          ),
          speechSpeak:
            source.fallbackMarkdown === undefined
              ? cloneSpeakOptions(source.sourceSpeechMarkup?.speak)
              : undefined,
          baselineIdentity: source.sourceBaselineIdentity,
          dirty: false,
        });
      }
      if (canUpdate() && stillConfirmedDraft) {
        const source = latestSourceRef.current;
        setDraftState(
          createNarrationDraft(
            source.sourceMarkdown,
            source.sourceSpeechMarkup,
            source.fallbackMarkdown,
            source.sourceLiteralText,
          ),
        );
        setSpeechSpeak(
          source.fallbackMarkdown === undefined
            ? cloneSpeakOptions(source.sourceSpeechMarkup?.speak)
            : undefined,
        );
        setBaselineIdentity(source.sourceBaselineIdentity);
      }
    } catch (cause) {
      if (canUpdate()) {
        actionErrorSourceIdentityRef.current = sourceIdentity;
        setActionErrorKind('other');
        setActionError(
          userFacingErrorMessage(cause) ??
            text('reachDeck.editor.narration.regenerateFailed', 'AI 重新生成讲稿失败，请重试。'),
        );
      }
    } finally {
      if (canUpdate()) setBusyAction(undefined);
    }
  };

  const runRegenerate = () => {
    if (onRegenerate === undefined || regenerateDisabled || busy || generationBlocked) return;
    const hasSavedNarration = isInteractive
      ? interactiveNarrationText !== undefined
      : sourceMarkdown.trim().length > 0;
    if (hasSavedNarration || dirty) {
      setRegenerateConfirmation(dirty ? 'dirty' : 'saved');
      return;
    }
    void performRegenerate();
  };

  /** 仅重写讲稿会清除本页音频与讲稿动画，所以无论是否已有讲稿都先确认。 */
  const runRegenerateTextOnly = () => {
    if (onRegenerateTextOnly === undefined || regenerateDisabled || busy || generationBlocked)
      return;
    setTextOnlyConfirmation(dirty ? 'dirty' : 'saved');
  };

  const runSave = async (draftOnly = false, audioOnly = false) => {
    let save: (() => Promise<void> | void) | undefined;
    let savedIdentity: string | undefined;
    if (props.interactive !== undefined) {
      const saveInteractive = props.onSaveAndGenerate;
      if (saveInteractive !== undefined && interactiveSavePayload !== undefined) {
        const payload = interactiveSavePayload;
        save = () => saveInteractive(payload);
        savedIdentity = interactiveMatchesSource ? sourceBaselineIdentity : activeDraftIdentity;
      }
    } else {
      const saveSlide = audioOnly
        ? props.onSaveAudio
        : draftOnly
          ? props.onSaveDraft
          : props.onSaveAndGenerate;
      if (saveSlide !== undefined && effectiveDraftMarkdown !== undefined) {
        const payload = {
          markdown: effectiveDraftMarkdown,
          ...(effectiveSpeechMarkup === undefined ? {} : { speechMarkup: effectiveSpeechMarkup }),
        };
        save = () => saveSlide(payload);
        savedIdentity = narrationSpeechIdentity(effectiveDraftMarkdown, effectiveSpeechMarkup);
      }
    }
    if (
      save === undefined ||
      savedIdentity === undefined ||
      (!draftOnly && generationBlocked) ||
      disabled ||
      busy ||
      speechCapabilityBlocked
    ) {
      return;
    }
    const savingPage = draftCacheKey;
    const ownsOperation = beginDraftOperation();
    const canUpdate = () =>
      mountedRef.current && currentPageRef.current === savingPage && ownsOperation();
    setActionError(undefined);
    setBusyAction(audioOnly ? 'audio' : draftOnly ? 'draft' : 'save');
    try {
      await save();
      const cached = draftCache?.get(savingPage);
      if (cached && ownsOperation())
        draftCache?.set(savingPage, {
          ...cached,
          baselineIdentity: savedIdentity,
          dirty: cached.draftState !== draftState || cached.speechSpeak !== speechSpeak,
        });
      if (canUpdate()) setBaselineIdentity(savedIdentity);
    } catch (cause) {
      if (canUpdate()) {
        actionErrorSourceIdentityRef.current = sourceIdentity;
        setActionErrorKind('save');
        setActionError(
          userFacingErrorMessage(cause) ??
            (isInteractive
              ? text(
                  'reachDeck.editor.interactiveNarration.saveFailed',
                  '保存互动讲稿并生成音频失败，讲稿仍保留在编辑器中，请重试。',
                )
              : text(
                  audioOnly
                    ? 'reachDeck.editor.narration.saveAudioFailed'
                    : draftOnly
                      ? 'reachDeck.editor.narration.saveDraftFailed'
                      : 'reachDeck.editor.narration.saveFailed',
                  audioOnly
                    ? '生成音频失败，讲稿仍保留在编辑器中，请重试。'
                    : draftOnly
                      ? '保存草稿失败，修改仍保留在编辑器中，请重试。'
                      : '保存讲稿并生成音频与动画失败，讲稿仍保留在编辑器中，请重试。',
                )),
        );
      }
    } finally {
      if (canUpdate()) setBusyAction(undefined);
    }
  };

  const runSaveRef = useRef(runSave);
  runSaveRef.current = runSave;
  useImperativeHandle(
    props.actionsRef,
    () => ({ saveAndGenerate: () => runSaveRef.current() }),
    [],
  );

  // 宿主（画布下方状态条）与面板共享同一份草稿：草稿、校验与保存状态变化时上报。
  // 只有主按钮此刻能保存的内容才带 `text`，状态条的保存按钮据此启用。
  const interactiveSaveable = interactiveSavePayload !== undefined && !speechCapabilityBlocked;
  const interactiveValidationError: InteractiveNarrationValidationError | undefined =
    interactiveSaveable
      ? undefined
      : interactiveDraftEmpty
        ? 'empty'
        : analysis.error instanceof InteractiveNarrationDraftError
          ? analysis.error.kind
          : 'invalid';
  const interactiveSnapshot: InteractiveNarrationDraftSnapshot | undefined = !isInteractive
    ? undefined
    : {
        dirty,
        saving: busyAction === 'save',
        scalarCount: interactiveScalarCount ?? 0,
        ...(interactiveSaveable ? interactiveSavePayload : {}),
        ...(interactiveValidationError === undefined
          ? {}
          : { validationError: interactiveValidationError }),
        ...(interactiveSaveFailed ? { saveError: actionError } : {}),
      };
  const interactiveSnapshotKey =
    interactiveSnapshot === undefined ? undefined : JSON.stringify(interactiveSnapshot);
  const interactiveSnapshotRef = useRef(interactiveSnapshot);
  interactiveSnapshotRef.current = interactiveSnapshot;
  const onDraftChangeRef = useRef(props.onDraftChange);
  onDraftChangeRef.current = props.onDraftChange;
  useEffect(() => {
    const snapshot = interactiveSnapshotRef.current;
    if (snapshot !== undefined) onDraftChangeRef.current?.(snapshot);
  }, [interactiveSnapshotKey]);

  const animationsOnlyUnavailable =
    dirty || manualReviewActive || slide === undefined || !hasReachDeckNarrationAudioTiming(slide);
  const performRegenerateAnimations = async (only = false) => {
    const regenerate = only ? onRegenerateAnimationsOnly : onRegenerateAnimations;
    if (
      regenerate === undefined ||
      (only && animationsOnlyUnavailable) ||
      effectiveDraftMarkdown === undefined ||
      generationBlocked ||
      disabled ||
      busy ||
      (!only && speechCapabilityBlocked)
    )
      return;
    const savingPage = draftCacheKey;
    const ownsOperation = beginDraftOperation();
    const savedIdentity = narrationSpeechIdentity(effectiveDraftMarkdown, effectiveSpeechMarkup);
    const canUpdate = () =>
      mountedRef.current && currentPageRef.current === savingPage && ownsOperation();
    setAnimationConfirmation(false);
    setAnimationOnlyConfirmation(false);
    setActionError(undefined);
    setBusyAction('animations');
    try {
      await regenerate({
        markdown: effectiveDraftMarkdown,
        ...(effectiveSpeechMarkup === undefined ? {} : { speechMarkup: effectiveSpeechMarkup }),
      });
      const cached = draftCache?.get(savingPage);
      if (cached && ownsOperation())
        draftCache?.set(savingPage, {
          ...cached,
          baselineIdentity: savedIdentity,
          dirty: cached.draftState !== draftState || cached.speechSpeak !== speechSpeak,
        });
      if (canUpdate()) setBaselineIdentity(savedIdentity);
    } catch {
      if (canUpdate()) {
        actionErrorSourceIdentityRef.current = sourceIdentity;
        setActionErrorKind('other');
        setActionError(
          text(
            only
              ? 'reachDeck.editor.narration.regenerateAnimationsOnlyFailed'
              : 'reachDeck.editor.narration.regenerateAnimationsFailed',
            only
              ? '重新生成动画失败，请重试。'
              : '重新生成音频和动画失败，讲稿仍保留在编辑器中，请重试。',
          ),
        );
      }
    } finally {
      if (canUpdate()) setBusyAction(undefined);
    }
  };

  const closeSpeechMarkDialog = () => {
    setSpeechMarkDialog(undefined);
    queueMicrotask(() => speechMarkTriggerRef.current?.focus());
  };

  const closeSpeechSettings = () => {
    setSpeechSettingsOpen(false);
    queueMicrotask(() => speechSettingsTriggerRef.current?.focus());
  };

  const openSpeechSettings = (trigger: HTMLButtonElement) => {
    speechSettingsTriggerRef.current = trigger;
    setSpeechMarkDialog(undefined);
    setSpeakBgm(speechSpeak?.bgm ?? '');
    setSpeakVolume(speechSpeak?.backgroundMusicVolume ?? '');
    setSpeakEffect(speechSpeak?.effect ?? '');
    setMarkNotice(undefined);
    setSpeechSettingsOpen(true);
  };

  const openSpeechMarkDialog = (
    kind: ReachDeckSpeechMarkV1['type'],
    trigger: HTMLButtonElement,
  ) => {
    const selection = speechControllerRef.current?.readSelection();
    const active = selection?.active;
    const editing = active?.type === kind;
    const validTarget =
      selection !== undefined &&
      (editing ||
        (active === undefined &&
          (isPointSpeechMarkType(kind) ? selection.empty : !selection.empty)));
    if (!allowedSpeechMarkTypeSet.has(kind) || !validTarget) return;

    speechMarkTriggerRef.current = trigger;
    setSpeechSettingsOpen(false);
    setMarkNotice(undefined);
    if (active?.type === 'break') setBreakDurationMs(active.durationMs);
    else if (kind === 'break') setBreakDurationMs(300);
    if (active?.type === 'soundEvent') setSoundEventSrc(active.src);
    else if (kind === 'soundEvent') setSoundEventSrc('');
    if (active?.type === 'sub') setAlias(active.alias);
    else if (kind === 'sub') setAlias('');
    if (active?.type === 'say-as') setInterpretAs(active.interpretAs);
    else if (kind === 'say-as') setInterpretAs('Cardinal');
    if (active?.type === 'phoneme') {
      setAlphabet(active.alphabet);
      setPhoneme(active.ph);
    } else if (kind === 'phoneme') {
      setAlphabet(/^\p{Script=Han}+$/u.test(selection.text) ? 'py' : 'ipa');
      setPhoneme('');
    }
    setSpeechMarkDialog({ kind, editing, sourceText: selection.text });
  };

  const runManualMark = () => {
    if (speechMarkDialog === undefined) return;
    setMarkNotice(undefined);
    const controller = speechControllerRef.current;
    if (
      controller === null ||
      !allowedSpeechMarkTypeSet.has(speechMarkDialog.kind) ||
      activeSelectionUnsupported ||
      !speechMarkDialogIsValid(
        speechMarkDialog,
        breakDurationMs,
        soundEventSrc,
        alias,
        alphabet,
        phoneme,
      )
    ) {
      return;
    }
    const result =
      speechMarkDialog.kind === 'break'
        ? controller.insertBreak(breakDurationMs)
        : speechMarkDialog.kind === 'soundEvent'
          ? controller.insertSoundEvent(soundEventSrc)
          : speechMarkDialog.kind === 'sub'
            ? controller.applySpan({ type: 'sub', alias })
            : speechMarkDialog.kind === 'say-as'
              ? controller.applySpan({ type: 'say-as', interpretAs })
              : controller.applySpan({ type: 'phoneme', alphabet, ph: phoneme });
    if (result.applied) {
      closeSpeechMarkDialog();
      return;
    }
    setMarkNotice(
      text(
        'reachDeck.editor.narration.speech.invalidSelection',
        '请选择一段不包含公式或其他标签的有效文字。',
      ),
    );
  };

  const removeManualMark = () => {
    const result = speechControllerRef.current?.removeActive();
    if (result?.applied) {
      setMarkNotice(undefined);
      if (speechMarkDialog !== undefined) closeSpeechMarkDialog();
    }
  };

  const applySpeechSettings = () => {
    if (!speechSettingsIsValid(speakBgm, speakVolume, speakEffect)) return;
    const next: ReachDeckSpeakOptionsV1 = {
      ...(speakBgm === '' ? {} : { bgm: speakBgm }),
      ...(speakVolume === '' ? {} : { backgroundMusicVolume: speakVolume }),
      ...(speakEffect === '' ? {} : { effect: speakEffect }),
    };
    setSpeechSpeak(Object.keys(next).length === 0 ? undefined : next);
    closeSpeechSettings();
  };

  const clearSpeechSettings = () => {
    setSpeechSpeak(undefined);
    closeSpeechSettings();
  };

  const runSmartMarks = async () => {
    if (
      onRequestSpeechMarkupCandidates === undefined ||
      effectiveDraftMarkdown === undefined ||
      smartSpeechUnsupported ||
      speechCapabilityBlocked ||
      speechBusy !== undefined
    ) {
      return;
    }
    speechRequestRef.current?.abort();
    const controller = new AbortController();
    const requestedDraftIdentity = activeDraftIdentity;
    speechRequestRef.current = controller;
    setSpeechBusy('candidates');
    setMarkNotice(undefined);
    try {
      const candidates = await onRequestSpeechMarkupCandidates(
        {
          markdown: effectiveDraftMarkdown,
          ...(effectiveSpeechMarkup === undefined ? {} : { speechMarkup: effectiveSpeechMarkup }),
        },
        controller.signal,
      );
      if (!controller.signal.aborted && requestedDraftIdentity === activeDraftIdentityRef.current) {
        const pronunciationCandidates = candidates.filter((candidate) =>
          allowedSmartSpeechMarkTypeSet.has(candidate.mark.type),
        );
        setSpeechCandidates(pronunciationCandidates);
        if (pronunciationCandidates.length === 0) {
          setMarkNotice(
            text('reachDeck.editor.narration.speech.smartEmpty', '没有需要调整的读音标注。'),
          );
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMarkNotice(speechToolFailureMessage(error, 'candidates', text));
      }
    } finally {
      if (speechRequestRef.current === controller) {
        speechRequestRef.current = undefined;
        setSpeechBusy(undefined);
      }
    }
  };

  const runPreview = async () => {
    if (
      onPreviewSpeech === undefined ||
      effectiveDraftMarkdown === undefined ||
      previewDisabledReason !== undefined ||
      speechBusy !== undefined
    ) {
      return;
    }
    const controller = new AbortController();
    const requestedDraftIdentity = activeDraftIdentity;
    speechRequestRef.current = controller;
    setPreviewOpen(true);
    setSpeechBusy('preview');
    setPreviewStatus('submitting');
    setPreviewError(undefined);
    setMarkNotice(undefined);
    setPreviewResult(undefined);
    try {
      const audio = await onPreviewSpeech(
        {
          markdown: effectiveDraftMarkdown,
          markdownFrom: previewRange.from,
          markdownTo: previewRange.to,
          ...(effectiveSpeechMarkup === undefined ? {} : { speechMarkup: effectiveSpeechMarkup }),
        },
        controller.signal,
        (status) => {
          if (
            speechRequestRef.current === controller &&
            requestedDraftIdentity === activeDraftIdentityRef.current
          ) {
            setPreviewStatus(status);
          }
        },
      );
      if (
        speechRequestRef.current === controller &&
        !controller.signal.aborted &&
        requestedDraftIdentity === activeDraftIdentityRef.current
      ) {
        setPreviewResult(audio);
        setPreviewStatus('ready');
      }
    } catch (error) {
      if (
        speechRequestRef.current === controller &&
        !controller.signal.aborted &&
        requestedDraftIdentity === activeDraftIdentityRef.current
      ) {
        setPreviewError(speechToolFailureMessage(error, 'preview', text));
        setPreviewStatus((current) =>
          current === 'expired' || current === 'draining' || current === 'cancelled'
            ? current
            : 'failed',
        );
      }
    } finally {
      if (speechRequestRef.current === controller) {
        speechRequestRef.current = undefined;
        setSpeechBusy(undefined);
        if (controller.signal.aborted) {
          setPreviewStatus((current) =>
            current === 'cancelling' ||
            current === 'submitting' ||
            current === 'queued' ||
            current === 'running'
              ? 'cancelled'
              : current,
          );
        }
      }
    }
  };

  const stopSpeechRequest = () => {
    setPreviewStatus('cancelling');
    setPreviewResult(undefined);
    speechRequestRef.current?.abort();
  };

  const closePreview = () => {
    const request = speechRequestRef.current;
    speechRequestRef.current = undefined;
    previewPanelRef.current?.querySelectorAll('audio').forEach((audio) => audio.pause());
    setPreviewOpen(false);
    setPreviewResult(undefined);
    setPreviewStatus(undefined);
    setPreviewError(undefined);
    setSpeechBusy(undefined);
    request?.abort();
    previewTriggerRef.current?.focus();
  };

  const acceptSpeechCandidate = (candidate: NarrationSpeechMarkupCandidate) => {
    if (disabled || busy) return;
    const sourceStillMatches = speechCandidateMatchesMarkdown(candidate, effectiveDraftMarkdown);
    const remainingCandidates = sourceStillMatches
      ? filterSpeechCandidatesAfterAcceptance(
          speechCandidates,
          candidate,
          effectiveDraftMarkdown,
          effectiveSpeechMarkup,
        )
      : [];
    const result = sourceStillMatches
      ? speechControllerRef.current?.applySourceMark(candidate.mark)
      : undefined;
    if (result?.applied) {
      setSpeechCandidates(remainingCandidates);
    } else {
      setMarkNotice(
        text('reachDeck.editor.narration.speech.staleCandidate', '讲稿已变化，请重新智能打标。'),
      );
    }
  };

  const rejectSpeechCandidate = (candidateId: string) => {
    if (disabled || busy) return;
    setSpeechCandidates((current) => current.filter((entry) => entry.id !== candidateId));
  };

  const speechMarkCommandDisabled = (kind: ReachDeckSpeechMarkV1['type']) => {
    const activeType = speechSelection.active?.type;
    return (
      disabled ||
      busy ||
      !allowedSpeechMarkTypeSet.has(kind) ||
      activeSelectionUnsupported ||
      (activeType !== undefined
        ? activeType !== kind
        : isPointSpeechMarkType(kind)
          ? !speechSelection.empty
          : speechSelection.empty)
    );
  };

  const narrationToolbarContent = (
    <span className="reach-deck-timeline__speech-toolbar">
      <label
        className="reach-deck-timeline__speech-switch"
        title={text('reachDeck.editor.narration.speech.help', '调整发音、停顿和语速')}
      >
        <input
          aria-label={text('reachDeck.editor.narration.speech.showTags', '显示语音标记')}
          aria-description={text('reachDeck.editor.narration.speech.help', '调整发音、停顿和语速')}
          checked={showSpeechTags}
          disabled={disabled || busy}
          onChange={(event) => setShowSpeechTags(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
        <Tags aria-hidden="true" size={14} />
        <span>{text('reachDeck.editor.narration.speech.label', '语音标记')}</span>
      </label>
      {showSpeechTags
        ? SPEECH_MARK_COMMANDS.filter(({ kind }) => allowedSpeechMarkTypeSet.has(kind)).map(
            ({ Icon, kind, label, translationKey }) => (
              <button
                aria-label={text(translationKey, label)}
                aria-pressed={speechSelection.active?.type === kind}
                className="reach-deck-editor__rich-text-button reach-deck-timeline__speech-command"
                disabled={speechMarkCommandDisabled(kind)}
                key={kind}
                onClick={(event) => openSpeechMarkDialog(kind, event.currentTarget)}
                title={text(translationKey, label)}
                type="button"
              >
                <Icon aria-hidden="true" size={14} />
                <span>{text(translationKey, label)}</span>
              </button>
            ),
          )
        : null}
      {showSpeechTags && allowSpeechDocumentSettings ? (
        <button
          aria-label={text(
            'reachDeck.editor.narration.speech.command.documentSettings',
            '背景与声音效果',
          )}
          aria-pressed={speechSettingsOpen}
          className="reach-deck-editor__rich-text-button reach-deck-timeline__speech-command"
          disabled={disabled || busy}
          onClick={(event) =>
            speechSettingsOpen ? closeSpeechSettings() : openSpeechSettings(event.currentTarget)
          }
          title={text(
            'reachDeck.editor.narration.speech.command.documentSettings',
            '背景与声音效果',
          )}
          type="button"
        >
          <Music2 aria-hidden="true" size={14} />
          <span>
            {text('reachDeck.editor.narration.speech.command.documentSettings', '全局效果')}
          </span>
        </button>
      ) : null}
      {onRequestSpeechMarkupCandidates === undefined ? null : (
        <button
          aria-busy={speechBusy === 'candidates'}
          aria-label={text('reachDeck.editor.narration.speech.smart', '智能打标')}
          className="reach-deck-editor__rich-text-button reach-deck-timeline__speech-command"
          disabled={
            disabled ||
            busy ||
            speechBusy !== undefined ||
            analysis.value === undefined ||
            smartSpeechUnsupported ||
            speechCapabilityBlocked
          }
          onClick={() => void runSmartMarks()}
          title={
            smartSpeechUnsupported
              ? text(
                  'reachDeck.editor.narration.speech.smartUnsupported',
                  '当前音色不支持智能读音标注，可手动添加停顿。',
                )
              : text('reachDeck.editor.narration.speech.smart', '智能打标')
          }
          type="button"
        >
          {speechBusy === 'candidates' ? (
            <LoadingIndicator size="sm">
              <LoaderCircle
                aria-hidden="true"
                className="reach-deck-timeline__speech-smart-spinner"
                size={14}
              />
            </LoadingIndicator>
          ) : (
            <Sparkles aria-hidden="true" size={14} />
          )}
          <span className="reach-deck-timeline__speech-smart-label">
            <span aria-hidden="true" className="reach-deck-timeline__speech-smart-size">
              {text('reachDeck.editor.narration.speech.smart', '智能打标')}
            </span>
            <span aria-hidden="true" className="reach-deck-timeline__speech-smart-size">
              {text('reachDeck.editor.narration.speech.smartBusy', '智能打标中')}
            </span>
            <span role="status">
              {speechBusy === 'candidates'
                ? text('reachDeck.editor.narration.speech.smartBusy', '智能打标中')
                : text('reachDeck.editor.narration.speech.smart', '智能打标')}
            </span>
          </span>
        </button>
      )}
      {activeSelectionUnsupported ? (
        <button
          aria-label={text('reachDeck.editor.narration.speech.remove', '移除标签')}
          className="reach-deck-editor__rich-text-button reach-deck-timeline__speech-remove"
          disabled={disabled || busy}
          onClick={removeManualMark}
          title={text('reachDeck.editor.narration.speech.remove', '移除标签')}
          type="button"
        >
          <Trash2 aria-hidden="true" size={14} />
        </button>
      ) : null}
    </span>
  );

  return (
    <div className="reach-deck-timeline__narration-editor">
      <div className="reach-deck-timeline__narration-header">
        <strong>{text('reachDeck.editor.narration.title', '讲稿')}</strong>
        {!hideGenerationMenu &&
        (onRegenerate !== undefined ||
          onRegenerateTextOnly !== undefined ||
          onRegenerateAnimations !== undefined ||
          onRegenerateAnimationsOnly !== undefined ||
          onSaveAudio !== undefined ||
          (hasSaveAndGenerate && !isInteractive)) ? (
          <NarrationActionMenu label={text('reachDeck.editor.narration.more', '更多讲稿操作')}>
            {onRegenerate === undefined ? null : (
              <button
                aria-label={regenerateLabel}
                disabled={regenerateDisabled || busy || generationBlocked}
                onClick={runRegenerate}
                ref={regenerateButtonRef}
                title={generationBlockedReason ?? regenerateLabel}
                type="button"
              >
                <WandSparkles aria-hidden="true" size={14} />
                <span>{regenerateLabel}</span>
              </button>
            )}
            {onRegenerateTextOnly === undefined &&
            onSaveAudio === undefined &&
            onRegenerateAnimationsOnly === undefined &&
            onRegenerateAnimations === undefined ? null : (
              <NarrationActionGroup label={partialGenerationLabel}>
                {onRegenerateTextOnly === undefined ? null : (
                  <button
                    aria-label={regenerateTextOnlyLabel}
                    disabled={regenerateDisabled || busy || generationBlocked}
                    onClick={runRegenerateTextOnly}
                    title={generationBlockedReason ?? regenerateTextOnlyLabel}
                    type="button"
                  >
                    <ScrollText aria-hidden="true" size={14} />
                    <span>{regenerateTextOnlyLabel}</span>
                  </button>
                )}
                {onSaveAudio === undefined ? null : (
                  <button
                    aria-label={text('reachDeck.editor.narration.saveAudio', '仅生成本页音频')}
                    disabled={
                      disabled ||
                      busy ||
                      generationBlocked ||
                      effectiveDraftMarkdown === undefined ||
                      speechCapabilityBlocked
                    }
                    onClick={() => setAudioConfirmation(true)}
                    title={
                      generationBlockedReason ??
                      text('reachDeck.editor.narration.saveAudio', '仅生成本页音频')
                    }
                    type="button"
                  >
                    <AudioLines aria-hidden="true" size={14} />
                    <span>{text('reachDeck.editor.narration.saveAudio', '仅生成本页音频')}</span>
                  </button>
                )}
                {onRegenerateAnimationsOnly === undefined ? null : (
                  <button
                    aria-label={text(
                      'reachDeck.editor.narration.regenerateAnimationsOnly',
                      '仅重新生成本页动画',
                    )}
                    disabled={
                      disabled ||
                      busy ||
                      animationsOnlyUnavailable ||
                      generationBlocked ||
                      effectiveDraftMarkdown === undefined
                    }
                    onClick={() => setAnimationOnlyConfirmation(true)}
                    title={
                      generationBlockedReason ??
                      (animationsOnlyUnavailable
                        ? text(
                            'reachDeck.editor.narration.animationsOnlyUnavailable',
                            '请先为已保存的讲稿生成音频，再重新生成动画。',
                          )
                        : undefined)
                    }
                    type="button"
                  >
                    <Sparkles aria-hidden="true" size={14} />
                    <span>
                      {text(
                        'reachDeck.editor.narration.regenerateAnimationsOnly',
                        '仅重新生成本页动画',
                      )}
                    </span>
                  </button>
                )}
                {onRegenerateAnimations === undefined ? null : (
                  <button
                    aria-label={text(
                      'reachDeck.editor.narration.regenerateAnimations',
                      '重新生成本页音频和动画',
                    )}
                    disabled={
                      disabled ||
                      busy ||
                      generationBlocked ||
                      effectiveDraftMarkdown === undefined ||
                      speechCapabilityBlocked
                    }
                    onClick={() => setAnimationConfirmation(true)}
                    title={generationBlockedReason}
                    type="button"
                  >
                    <Clapperboard aria-hidden="true" size={14} />
                    <span>
                      {busyAction === 'animations'
                        ? text(
                            'reachDeck.editor.narration.regeneratingAnimations',
                            '正在重新生成音频和动画…',
                          )
                        : text(
                            'reachDeck.editor.narration.regenerateAnimations',
                            '重新生成本页音频和动画',
                          )}
                    </span>
                  </button>
                )}
              </NarrationActionGroup>
            )}
          </NarrationActionMenu>
        ) : null}
      </div>
      <div className="reach-deck-timeline__narration-content">
        {draftState.literalFallback ? (
          <p className="reach-deck-timeline__narration-warning" role="status">
            {text(
              'reachDeck.editor.narration.literalFallbackWarning',
              'AI 讲稿含无法识别的 Markdown，已按纯文本载入。公式样式文本可能会被逐字朗读；请用公式工具修正并确认校验通过后再保存。',
            )}
          </p>
        ) : null}
        <RichTextElementEditor
          allowedNarrationSpeechMarkTypes={allowedSpeechMarkTypes}
          disabled={disabled || busy}
          label={
            isInteractive
              ? text('reachDeck.editor.interactiveNarration.document', '互动页讲稿')
              : text('reachDeck.editor.narration.document', '整页讲稿')
          }
          narrationSingleParagraph={isInteractive}
          narrationSpeechControllerRef={speechControllerRef}
          onChange={(draft) => {
            const request = speechRequestRef.current;
            speechRequestRef.current = undefined;
            request?.abort();
            setSpeechBusy(undefined);
            setDraftState((current) => ({ ...current, draft, untouched: false }));
            // 与原 Interactive 面板一致：修改讲稿即清除粘滞的保存失败提示。
            if (isInteractive && interactiveSaveFailed) {
              actionErrorSourceIdentityRef.current = undefined;
              setActionError(undefined);
            }
            setSpeechCandidates([]);
            setPreviewResult(undefined);
            setPreviewStatus(undefined);
            setPreviewError(undefined);
            setPreviewOpen(false);
            setPasteNotice(undefined);
          }}
          onNarrationSpeechInvalidated={(count) =>
            setMarkNotice(
              text(
                'reachDeck.editor.narration.speech.invalidated',
                '正文修改影响了 {count} 个语音标记，已移除受影响标记。',
                { count },
              ),
            )
          }
          onNarrationSpeechPasteFallback={() =>
            setPasteNotice(
              text(
                'reachDeck.editor.narration.speech.pasteFallback',
                '部分语音标记未转换，已保留原文。请检查标签格式或相邻语音标记。',
              ),
            )
          }
          onNarrationSpeechSelectionChange={setSpeechSelection}
          narrationToolbarContent={narrationToolbarContent}
          showFontControls={false}
          showNarrationSpeechTags={showSpeechTags}
          toolbarVariant="narration"
          translate={translate}
          value={draftState.draft}
        />
        {speechCandidates.length === 0 ? null : (
          <ul
            aria-label={text('reachDeck.editor.narration.speech.candidates', '智能打标候选')}
            className="reach-deck-timeline__speech-candidates"
          >
            {speechCandidates.map((candidate) => (
              <li key={candidate.id}>
                <code>{speechCandidateLabel(candidate)}</code>
                <span>
                  {candidate.sourceText ||
                    (candidate.mark.type === 'soundEvent'
                      ? text('reachDeck.editor.narration.speech.soundEvent', '音效')
                      : text('reachDeck.editor.narration.speech.break', '停顿'))}
                </span>
                <button
                  aria-label={text('reachDeck.editor.narration.speech.acceptCandidate', '采用候选')}
                  disabled={disabled || busy}
                  onClick={() => acceptSpeechCandidate(candidate)}
                  title={text('reachDeck.editor.narration.speech.acceptCandidate', '采用候选')}
                  type="button"
                >
                  <Plus size={14} />
                </button>
                <button
                  aria-label={text('reachDeck.editor.narration.speech.rejectCandidate', '忽略候选')}
                  disabled={disabled || busy}
                  onClick={() => rejectSpeechCandidate(candidate.id)}
                  title={text('reachDeck.editor.narration.speech.rejectCandidate', '忽略候选')}
                  type="button"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {validationError !== undefined ? (
          <p className="reach-deck-timeline__narration-error" role="alert">
            {validationError}
          </p>
        ) : null}
        {speechCapabilityBlocked ? (
          <p className="reach-deck-timeline__narration-error" role="alert">
            {text(
              'reachDeck.editor.narration.speech.existingMarksUnsupported',
              '当前课程音色不支持现有的 {count} 个语音标记。请开启“显示语音标记”并移除这些标记，或更换课程音色后再试听、智能打标或保存生成。',
              { count: unsupportedSpeechCapabilityCount },
            )}
          </p>
        ) : null}
        {markNotice !== undefined ? (
          <p className="reach-deck-timeline__narration-warning" role="status">
            {markNotice}
          </p>
        ) : null}
        {pasteNotice !== undefined ? (
          <p className="reach-deck-timeline__narration-warning" role="status">
            {pasteNotice}
          </p>
        ) : null}
        {actionError !== undefined ? (
          <p className="reach-deck-timeline__narration-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
      <footer className="reach-deck-timeline__narration-footer">
        <div className="reach-deck-timeline__narration-meta">
          {previewScope === 'document' && !hasSaveAndGenerate ? null : (
            <span role="status" title={narrationState}>
              {narrationState}
            </span>
          )}
          <span>
            {previewScope === 'document'
              ? text('reachDeck.editor.narration.capacity', '{count} / {limit} 字符/词', {
                  count: analysis.value?.semanticUnits ?? '—',
                  limit: REACH_DECK_SSML_MAX_SEMANTIC_UNITS,
                })
              : isInteractive
                ? text('reachDeck.editor.interactiveNarration.capacity', '{count} / {limit} 字符', {
                    count: interactiveScalarCount ?? '—',
                    limit: INTERACTIVE_NARRATION_MAX_TEXT_SCALARS,
                  })
                : text('reachDeck.editor.narration.capacity', '{count} / {limit} 字符/词', {
                    count: analysis.value?.semanticUnits ?? '—',
                    limit: REACH_DECK_NARRATION_MAX_SEMANTIC_UNITS,
                  })}
          </span>
        </div>
        <div className="reach-deck-timeline__narration-footer-actions">
          {onPreviewSpeech !== undefined && previewLimitLabel !== undefined ? (
            <span className="reach-deck-timeline__narration-preview-limit">
              {previewLimitLabel}
            </span>
          ) : null}
          <span aria-live="polite" className="sr-only" role="status">
            {previewOpen && previewStatus !== undefined
              ? speechPreviewStatusLabel(previewStatus, text)
              : ''}
          </span>
          {onPreviewSpeech === undefined ? null : (
            <div className="reach-deck-timeline__narration-preview-control">
              <button
                aria-describedby={
                  speechBusy === 'preview' || previewDisabledReason === undefined
                    ? undefined
                    : previewReasonId
                }
                aria-disabled={speechBusy !== 'preview' && previewDisabledReason !== undefined}
                aria-label={
                  speechBusy === 'preview'
                    ? text('reachDeck.editor.narration.speech.stopPreview', '停止试听')
                    : text('reachDeck.editor.narration.speech.preview', '试听')
                }
                className="reach-deck-timeline__narration-preview-action"
                onClick={() => {
                  if (speechBusy === 'preview') stopSpeechRequest();
                  else if (previewDisabledReason === undefined) void runPreview();
                }}
                ref={previewTriggerRef}
                title={
                  speechBusy === 'preview'
                    ? text('reachDeck.editor.narration.speech.stopPreview', '停止试听')
                    : (previewDisabledReason ??
                      text('reachDeck.editor.narration.speech.preview', '试听'))
                }
                type="button"
              >
                {speechBusy === 'preview' ? <Pause size={14} /> : <Play size={14} />}
                <span>
                  {speechBusy === 'preview'
                    ? text('reachDeck.editor.narration.speech.stopPreview', '停止试听')
                    : text('reachDeck.editor.narration.speech.preview', '试听')}
                </span>
              </button>
              {speechBusy !== 'preview' && previewDisabledReason !== undefined ? (
                <span
                  className="reach-deck-timeline__narration-preview-tooltip"
                  id={previewReasonId}
                  role="tooltip"
                >
                  {previewDisabledReason}
                </span>
              ) : null}
            </div>
          )}
          {!hasSaveAndGenerate ? null : (
            <button
              aria-label={saveLabel}
              title={generationBlockedReason ?? saveLabel}
              className="reach-deck-timeline__narration-apply"
              disabled={
                disabled ||
                busy ||
                generationBlocked ||
                !savePayloadReady ||
                speechCapabilityBlocked
              }
              onClick={() => void runSave()}
              type="button"
            >
              <Save size={14} />
              <span>{saveLabel}</span>
            </button>
          )}
          {onSaveDraft === undefined && (hideGenerationMenu || onSaveAudio === undefined) ? null : (
            <NarrationActionMenu
              upward
              label={text('reachDeck.editor.narration.saveOptions', '保存选项')}
            >
              {onSaveDraft === undefined ? null : (
                <button
                  aria-label={text('reachDeck.editor.narration.saveDraft', '仅保存草稿')}
                  disabled={
                    disabled ||
                    busy ||
                    effectiveDraftMarkdown === undefined ||
                    speechCapabilityBlocked
                  }
                  onClick={() => void runSave(true)}
                  type="button"
                >
                  <Save size={14} />
                  <span>
                    {busyAction === 'draft'
                      ? text('reachDeck.editor.narration.savingDraft', '正在保存草稿…')
                      : text('reachDeck.editor.narration.saveDraft', '仅保存草稿')}
                  </span>
                </button>
              )}
              {hideGenerationMenu || onSaveAudio === undefined ? null : (
                <button
                  aria-label={text('reachDeck.editor.narration.saveAudio', '仅生成本页音频')}
                  disabled={
                    disabled ||
                    busy ||
                    generationBlocked ||
                    effectiveDraftMarkdown === undefined ||
                    speechCapabilityBlocked
                  }
                  onClick={() => setAudioConfirmation(true)}
                  title={generationBlockedReason}
                  type="button"
                >
                  <AudioLines size={14} />
                  <span>{text('reachDeck.editor.narration.saveAudio', '仅生成本页音频')}</span>
                </button>
              )}
            </NarrationActionMenu>
          )}
        </div>
      </footer>
      {audioConfirmation ? (
        <ConfirmDialog
          open
          tone="danger"
          cancelLabel={text('shared.confirm.cancel', '取消')}
          confirmLabel={text('shared.confirm.continue', '继续')}
          title={text('reachDeck.editor.narration.saveAudio', '仅生成本页音频')}
          description={text(
            'reachDeck.editor.narration.confirmSaveAudio',
            '将保存当前讲稿并生成音频和时间戳，生成成功后会清空本页全部动画。是否继续？',
          )}
          onCancel={() => setAudioConfirmation(false)}
          onConfirm={() => {
            setAudioConfirmation(false);
            void runSave(false, true);
          }}
        />
      ) : null}
      {regenerateConfirmation !== undefined ? (
        <ConfirmDialog
          cancelLabel={text('shared.confirm.cancel', '取消')}
          confirmLabel={text('shared.confirm.continue', '继续')}
          description={
            isInteractive
              ? regenerateConfirmation === 'dirty'
                ? text(
                    'reachDeck.editor.interactiveNarration.confirmRegenerateDirty',
                    'AI 将重新生成本页讲稿并重新合成音频，覆盖现有讲稿和音频，同时丢弃尚未保存的修改。是否继续？',
                  )
                : text(
                    'reachDeck.editor.interactiveNarration.confirmRegenerate',
                    'AI 将重新生成本页讲稿并重新合成音频，覆盖现有讲稿和音频。是否继续？',
                  )
              : text(
                  regenerateConfirmation === 'dirty'
                    ? 'reachDeck.editor.narration.confirmRegenerateDirty'
                    : 'reachDeck.editor.narration.confirmRegenerate',
                  regenerateConfirmation === 'dirty'
                    ? 'AI 将重新生成本页讲稿，并据此重新合成音频、生成讲稿动画，覆盖现有讲稿、音频和讲稿动画，同时丢弃尚未保存的修改。是否继续？'
                    : 'AI 将重新生成本页讲稿，并据此重新合成音频、生成讲稿动画，覆盖现有讲稿、音频和讲稿动画。是否继续？',
                )
          }
          onCancel={() => setRegenerateConfirmation(undefined)}
          onConfirm={() => {
            setRegenerateConfirmation(undefined);
            void performRegenerate();
          }}
          open
          title={text('reachDeck.editor.narration.confirmTitle', '确认重新生成讲稿')}
          tone="danger"
        />
      ) : null}
      {textOnlyConfirmation !== undefined ? (
        <ConfirmDialog
          cancelLabel={text('shared.confirm.cancel', '取消')}
          confirmLabel={text('shared.confirm.continue', '继续')}
          description={text(
            textOnlyConfirmation === 'dirty'
              ? 'reachDeck.editor.narration.confirmRegenerateTextOnlyDirty'
              : 'reachDeck.editor.narration.confirmRegenerateTextOnly',
            textOnlyConfirmation === 'dirty'
              ? 'AI 只会重写本页讲稿文字，不会合成音频或生成动画。本页现有音频和讲稿动画将被清除（手工动画保留），尚未保存的修改也会被丢弃。是否继续？'
              : 'AI 只会重写本页讲稿文字，不会合成音频或生成动画。本页现有音频和讲稿动画将被清除（手工动画保留）。是否继续？',
          )}
          onCancel={() => setTextOnlyConfirmation(undefined)}
          onConfirm={() => {
            setTextOnlyConfirmation(undefined);
            void performRegenerate(true);
          }}
          open
          title={text('reachDeck.editor.narration.confirmTextOnlyTitle', '确认仅重新生成本页讲稿')}
          tone="danger"
        />
      ) : null}
      {animationConfirmation ? (
        <ConfirmDialog
          cancelLabel={text('shared.confirm.cancel', '取消')}
          confirmLabel={text('shared.confirm.continue', '继续')}
          description={text(
            'reachDeck.editor.narration.confirmRegenerateAnimations',
            '此操作会重新生成并替换当前讲稿的音频和动画，保留讲稿文本。是否继续？',
          )}
          onCancel={() => setAnimationConfirmation(false)}
          onConfirm={() => void performRegenerateAnimations()}
          open
          title={text('reachDeck.editor.narration.regenerateAnimations', '重新生成本页音频和动画')}
          tone="danger"
        />
      ) : null}
      {animationOnlyConfirmation ? (
        <ConfirmDialog
          cancelLabel={text('shared.confirm.cancel', '取消')}
          confirmLabel={text('shared.confirm.continue', '继续')}
          description={text(
            'reachDeck.editor.narration.confirmRegenerateAnimationsOnly',
            '替换本页讲稿驱动动画，保留已保存的讲稿、音频和时间戳。是否继续？',
          )}
          onCancel={() => setAnimationOnlyConfirmation(false)}
          onConfirm={() => void performRegenerateAnimations(true)}
          open
          title={text('reachDeck.editor.narration.regenerateAnimationsOnly', '仅重新生成本页动画')}
        />
      ) : null}
      {speechMarkDialog === undefined
        ? null
        : createPortal(
            <SpeechMarkDialog
              alias={alias}
              alphabet={alphabet}
              anchorElement={speechMarkTriggerRef.current}
              breakDurationMs={breakDurationMs}
              busy={disabled || busy}
              dialog={speechMarkDialog}
              interpretAs={interpretAs}
              onAliasChange={setAlias}
              onAlphabetChange={setAlphabet}
              onBreakDurationChange={setBreakDurationMs}
              onCancel={closeSpeechMarkDialog}
              onConfirm={runManualMark}
              onInterpretAsChange={setInterpretAs}
              onPhonemeChange={setPhoneme}
              onRemove={speechMarkDialog.editing ? removeManualMark : undefined}
              onSoundEventSrcChange={setSoundEventSrc}
              phoneme={phoneme}
              soundEventSrc={soundEventSrc}
              text={text}
            />,
            document.body,
          )}
      {!speechSettingsOpen
        ? null
        : createPortal(
            <SpeechDocumentSettingsDialog
              anchorElement={speechSettingsTriggerRef.current}
              bgm={speakBgm}
              busy={disabled || busy}
              effect={speakEffect}
              onBgmChange={setSpeakBgm}
              onCancel={closeSpeechSettings}
              onClear={clearSpeechSettings}
              onConfirm={applySpeechSettings}
              onEffectChange={setSpeakEffect}
              onVolumeChange={setSpeakVolume}
              text={text}
              volume={speakVolume}
            />,
            document.body,
          )}
      {previewOpen && previewPresentation === 'inline' ? (
        <SpeechPreviewPopover
          anchorElement={previewTriggerRef.current}
          inline
          error={previewError}
          onClose={closePreview}
          panelRef={previewPanelRef}
          renderPreviewTrack={renderPreviewTrack}
          result={previewResult}
          status={previewStatus}
          text={text}
        />
      ) : previewOpen ? (
        createPortal(
          <SpeechPreviewPopover
            anchorElement={previewTriggerRef.current}
            error={previewError}
            onClose={closePreview}
            panelRef={previewPanelRef}
            renderPreviewTrack={renderPreviewTrack}
            result={previewResult}
            status={previewStatus}
            text={text}
          />,
          document.body,
        )
      ) : null}
    </div>
  );
}

const DEFAULT_SPEECH_MARK_TYPES = [
  'break',
  'say-as',
  'sub',
  'phoneme',
] as const satisfies readonly ReachDeckSpeechMarkV1['type'][];

interface SpeechMarkDialogState {
  editing: boolean;
  kind: ReachDeckSpeechMarkV1['type'];
  sourceText: string;
}

type PhonemeAlphabet = 'py' | 'cmu' | 'ipa';

interface PhonemeReferenceToken {
  label: string;
  value: string;
}

interface PhonemeReferenceGroup {
  fallbackLabel: string;
  insertion: 'adjacent' | 'separated';
  labelKey: string;
  tokens: readonly PhonemeReferenceToken[];
}

const SPEECH_MARK_COMMANDS = [
  {
    Icon: Pause,
    kind: 'break',
    label: '停顿',
    translationKey: 'reachDeck.editor.narration.speech.command.break',
  },
  {
    Icon: BellRing,
    kind: 'soundEvent',
    label: '插入音效',
    translationKey: 'reachDeck.editor.narration.speech.command.soundEvent',
  },
  {
    Icon: Replace,
    kind: 'sub',
    label: '替换读法',
    translationKey: 'reachDeck.editor.narration.speech.command.sub',
  },
  {
    Icon: ScanText,
    kind: 'say-as',
    label: '指定读法',
    translationKey: 'reachDeck.editor.narration.speech.command.sayAs',
  },
  {
    Icon: Languages,
    kind: 'phoneme',
    label: '发音',
    translationKey: 'reachDeck.editor.narration.speech.command.phoneme',
  },
] as const;

const SAY_AS_LABELS: Record<(typeof REACH_DECK_SAY_AS_INTERPRETATIONS)[number], string> = {
  Cardinal: '整数',
  'Cardinal-Liang': '整数（两）',
  Spell: '逐字符',
  'Spell-Yao': '逐字符（幺）',
  'Date-YMD': '日期：年月日',
  'Date-MDY': '日期：月日年',
  'Date-DMY': '日期：日月年',
  'Date-YM': '日期：年月',
  'Date-MD': '日期：月日',
  'Date-DM': '日期：日月',
  'Date-Y': '年份',
  'Date-M': '月份',
  'Date-D': '日期',
  Time: '时间',
  Percent: '百分比',
  Fraction: '分数',
  Currency: '货币',
  Measure: '计量单位',
  Telephone: '电话号码',
  Ordinal: '序数',
  Math: '数学表达式',
  Range: '范围',
  Verbatim: '原样朗读',
  Decimal: '小数',
  Abbr: '缩写',
  'Time-Duration': '时长',
  Score: '比分',
  Electronic: '电子串',
  Letters: '字母串',
  Letterss: '字母串（连续）',
  id: '标识符',
  characters: '逐字符',
  punctuation: '标点符号',
  name: '姓名',
  address: '地址',
  date: '日期',
  digit: '数字串',
  money: '金额',
  plain: '普通文本',
};

const SPEECH_EFFECT_LABELS: Record<ReachDeckSpeechEffectV1, string> = {
  true_robot: '机器人',
  dizzy_effect: '眩晕效果',
  heartbeat_intimacy: '亲密心跳',
  ethereal_spirit: '空灵声场',
  office_ambiance: '办公室环境',
  storm_scene: '暴风雨场景',
  'demon_whisper-silence_duration': '恶魔低语',
  'lightsaber_hum-aigc_metadata': '光剑嗡鸣',
  ghostly_presence: '幽灵氛围',
  'memory_filter-icl': '回忆滤镜',
  metallic_resonance: '金属共鸣',
  tavern_live: '酒馆现场',
  cafe_ambiance: '咖啡馆环境',
  fear_atmosphere: '恐惧氛围',
  airy_echo: '轻盈回声',
  dreamcore: '梦核',
  hazy_ambience: '朦胧氛围',
  folk_reverb: '民谣混响',
  broken_mic: '故障麦克风',
  killer_vibe: '惊悚氛围',
  parking_lot_reverb: '停车场混响',
  heartbeat_background: '背景心跳',
  school_announcement: '校园广播',
  bathroom_reverb: '浴室混响',
  speech_dialogue: '对话效果',
};

const PHONEME_ALPHABET_LABELS: Record<PhonemeAlphabet, string> = {
  py: '拼音 (py)',
  cmu: 'CMU (cmu)',
  ipa: '美式音标 (ipa)',
};

const PHONEME_PLACEHOLDERS: Record<PhonemeAlphabet, string> = {
  py: 'xi1 xi1',
  cmu: 'W UW1 CH IY1 L UW N',
  ipa: 'həˈloʊ',
};

const PHONEME_REFERENCE_GROUPS: Record<PhonemeAlphabet, readonly PhonemeReferenceGroup[]> = {
  py: [
    {
      fallbackLabel: '数字声调',
      insertion: 'adjacent',
      labelKey: 'reachDeck.editor.narration.speech.phonemeGroup.tones',
      tokens: [
        { label: '1 阴平', value: '1' },
        { label: '2 阳平', value: '2' },
        { label: '3 上声', value: '3' },
        { label: '4 去声', value: '4' },
        { label: '5 轻声', value: '5' },
        { label: '6 连上变调', value: '6' },
      ],
    },
  ],
  cmu: [
    {
      fallbackLabel: '元音',
      insertion: 'separated',
      labelKey: 'reachDeck.editor.narration.speech.phonemeGroup.vowels',
      tokens: phonemeReferenceTokens('AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW'),
    },
    {
      fallbackLabel: '重音',
      insertion: 'adjacent',
      labelKey: 'reachDeck.editor.narration.speech.phonemeGroup.stress',
      tokens: [
        { label: '0 无重音', value: '0' },
        { label: '1 主重音', value: '1' },
        { label: '2 次重音', value: '2' },
      ],
    },
    {
      fallbackLabel: '辅音',
      insertion: 'separated',
      labelKey: 'reachDeck.editor.narration.speech.phonemeGroup.consonants',
      tokens: phonemeReferenceTokens('B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH'),
    },
  ],
  ipa: [
    {
      fallbackLabel: '元音与双元音',
      insertion: 'adjacent',
      labelKey: 'reachDeck.editor.narration.speech.phonemeGroup.vowelsAndDiphthongs',
      tokens: phonemeReferenceTokens(
        'i ɪ ɛ e æ ɑ ɑː ɔ ɔ: u u: ʊ ʌ ə ɜr ɜːr ər aɪ ai eɪ ei ɔɪ ɔi oʊ ou aʊ au ɑr ɑːr ɔr ʊr ur ʊər ɛr ɛər ɪr ɪər',
      ),
    },
    {
      fallbackLabel: '辅音',
      insertion: 'adjacent',
      labelKey: 'reachDeck.editor.narration.speech.phonemeGroup.consonants',
      tokens: phonemeReferenceTokens(
        'p b t d k g f v θ ð s z ʃ ʒ tʃ dʒ tr dr ts dz l r m n ŋ w j h',
      ),
    },
    {
      fallbackLabel: '重音',
      insertion: 'adjacent',
      labelKey: 'reachDeck.editor.narration.speech.phonemeGroup.stress',
      tokens: [
        { label: 'ˈ 主重音', value: 'ˈ' },
        { label: 'ˌ 次重音', value: 'ˌ' },
      ],
    },
  ],
};

function NarrationActionMenu({
  children,
  label,
  upward = false,
}: {
  children: ReactNode;
  label: string;
  upward?: boolean;
}) {
  return (
    <details
      className={`reach-deck-timeline__narration-menu${upward ? ' reach-deck-timeline__narration-menu--upward' : ''}`}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Element &&
          event.relatedTarget.closest('[aria-modal="true"]')
        )
          return;
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
        event.stopPropagation();
      }}
    >
      <summary aria-label={label} title={label}>
        {upward ? (
          <ChevronDown aria-hidden="true" size={14} />
        ) : (
          <MoreHorizontal aria-hidden="true" size={14} />
        )}
      </summary>
      <div className="reach-deck-timeline__narration-menu-items">{children}</div>
    </details>
  );
}

/**
 * 菜单内的行内二级展开组：切换按钮只展开/收起，不关闭外层菜单；外层 `details` 关闭时自动收起。
 */
function NarrationActionGroup({ children, label }: { children: ReactNode; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const groupId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const menu = toggleRef.current?.closest('details');
    if (!menu) return;
    const collapseWhenClosed = () => {
      if (!menu.open) setExpanded(false);
    };
    menu.addEventListener('toggle', collapseWhenClosed);
    return () => menu.removeEventListener('toggle', collapseWhenClosed);
  }, []);
  return (
    <>
      <button
        aria-controls={groupId}
        aria-expanded={expanded}
        className="reach-deck-timeline__narration-menu-group-toggle"
        onClick={() => setExpanded((current) => !current)}
        ref={toggleRef}
        type="button"
      >
        <span>{label}</span>
        <ChevronRight aria-hidden="true" size={14} />
      </button>
      <div
        aria-label={label}
        className="reach-deck-timeline__narration-menu-group"
        hidden={!expanded}
        id={groupId}
        role="group"
      >
        {children}
      </div>
    </>
  );
}

function phonemeReferenceTokens(values: string): readonly PhonemeReferenceToken[] {
  return values.split(' ').map((value) => ({ label: value, value }));
}

type SpeechText = (
  key: string,
  fallback: string,
  replacements?: Record<string, string | number>,
) => string;

function SpeechPreviewPopover({
  anchorElement,
  inline = false,
  error,
  onClose,
  panelRef,
  renderPreviewTrack,
  result,
  status,
  text,
}: {
  anchorElement: HTMLButtonElement | null;
  inline?: boolean;
  error?: string;
  onClose: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
  renderPreviewTrack?: (track: NarrationSpeechPreviewTrack, index: number) => ReactNode;
  result?: NarrationSpeechPreviewResult;
  status?: NarrationSpeechPreviewStatus;
  text: SpeechText;
}) {
  const [position, setPosition] = useState<SpeechPopoverPosition>();
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (inline) return;
    const updatePosition = () => {
      const panel = panelRef.current;
      if (panel === null || anchorElement === null || !anchorElement.isConnected) {
        closeRef.current();
        return;
      }
      setPosition(
        speechPopoverPosition(anchorElement.getBoundingClientRect(), panel.getBoundingClientRect()),
      );
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorElement, error, inline, panelRef, result, status]);

  useEffect(() => {
    if (inline) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        !(event.target instanceof Node) ||
        (!panelRef.current?.contains(event.target) && !anchorElement?.contains(event.target))
      )
        return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [anchorElement, inline, panelRef]);

  return (
    <div
      aria-labelledby={titleId}
      className={
        inline
          ? 'reach-deck-speech-preview-inline'
          : 'reach-deck-speech-dialog reach-deck-speech-preview-popover'
      }
      data-placement={position?.placement}
      ref={panelRef}
      role={inline ? 'region' : 'dialog'}
      style={inline ? undefined : speechPopoverStyle(position)}
    >
      <header className="reach-deck-speech-dialog__header">
        <h2 id={titleId}>{text('reachDeck.editor.narration.speech.preview', '试听')}</h2>
        <button
          aria-label={text('reachDeck.editor.narration.speech.closePreview', '关闭试听')}
          className="reach-deck-speech-dialog__close"
          onClick={onClose}
          title={text('reachDeck.editor.narration.speech.closePreview', '关闭试听')}
          type="button"
        >
          <X size={14} />
        </button>
      </header>
      <div className="reach-deck-speech-preview-popover__body">
        <p className="reach-deck-speech-preview-popover__status">
          {status === undefined ? '' : speechPreviewStatusLabel(status, text)}
        </p>
        {error === undefined ? null : (
          <p className="reach-deck-speech-preview-popover__error">{error}</p>
        )}
        {result === undefined ? null : (
          <div className="reach-deck-timeline__speech-preview">
            {previewTracks(
              result,
              text('reachDeck.editor.narration.speech.previewAudio', '当前音色试听'),
            ).map((track, index) => (
              <div className="reach-deck-timeline__speech-preview-track" key={track.id}>
                {renderPreviewTrack === undefined ? (
                  <>
                    <span>{track.label}</span>
                    <audio
                      aria-label={track.label}
                      autoPlay={index === 0}
                      controls
                      src={`data:${track.contentType};base64,${track.dataBase64}`}
                    />
                  </>
                ) : (
                  renderPreviewTrack(track, index)
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SpeechMarkDialog({
  alias,
  alphabet,
  anchorElement,
  breakDurationMs,
  busy,
  dialog,
  interpretAs,
  onAliasChange,
  onAlphabetChange,
  onBreakDurationChange,
  onCancel,
  onConfirm,
  onInterpretAsChange,
  onPhonemeChange,
  onRemove,
  onSoundEventSrcChange,
  phoneme,
  soundEventSrc,
  text,
}: {
  alias: string;
  alphabet: 'py' | 'cmu' | 'ipa';
  anchorElement: HTMLButtonElement | null;
  breakDurationMs: number;
  busy: boolean;
  dialog: SpeechMarkDialogState;
  interpretAs: (typeof REACH_DECK_SAY_AS_INTERPRETATIONS)[number];
  onAliasChange: (value: string) => void;
  onAlphabetChange: (value: 'py' | 'cmu' | 'ipa') => void;
  onBreakDurationChange: (value: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onInterpretAsChange: (value: (typeof REACH_DECK_SAY_AS_INTERPRETATIONS)[number]) => void;
  onPhonemeChange: (value: string) => void;
  onRemove?: () => void;
  onSoundEventSrcChange: (value: string) => void;
  phoneme: string;
  soundEventSrc: string;
  text: SpeechText;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const phonemeInputRef = useRef<HTMLInputElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const [position, setPosition] = useState<SpeechPopoverPosition>();
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const command = SPEECH_MARK_COMMANDS.find(({ kind }) => kind === dialog.kind);
  const markLabel = text(command?.translationKey ?? '', command?.label ?? dialog.kind);
  const valid = speechMarkDialogIsValid(
    dialog,
    breakDurationMs,
    soundEventSrc,
    alias,
    alphabet,
    phoneme,
  );
  const validationMessage = speechMarkDialogValidationMessage(
    dialog,
    breakDurationMs,
    soundEventSrc,
    alias,
    alphabet,
    phoneme,
    text,
  );

  useLayoutEffect(() => {
    const updatePosition = () => {
      const panel = panelRef.current;
      if (panel === null || anchorElement === null || !anchorElement.isConnected) {
        onCancelRef.current();
        return;
      }
      setPosition(
        speechPopoverPosition(anchorElement.getBoundingClientRect(), panel.getBoundingClientRect()),
      );
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [alphabet, anchorElement, dialog.kind]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        panelRef.current?.contains(target) ||
        anchorElement?.contains(target) ||
        (target instanceof Element &&
          target.closest('.reach-deck-speech-dialog__select-list') !== null)
      )
        return;
      onCancelRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancelRef.current();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorElement]);

  return (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className={`reach-deck-speech-dialog${
        dialog.kind === 'phoneme' ? ' reach-deck-speech-dialog--phoneme' : ''
      }`}
      data-placement={position?.placement}
      ref={panelRef}
      role="dialog"
      style={speechPopoverStyle(position)}
    >
      <header className="reach-deck-speech-dialog__header">
        <div>
          <h2 id={titleId}>
            {text(
              dialog.editing
                ? 'reachDeck.editor.narration.speech.dialog.editTitle'
                : 'reachDeck.editor.narration.speech.dialog.insertTitle',
              dialog.editing ? '编辑{mark}' : '插入{mark}',
              { mark: markLabel },
            )}
          </h2>
          <p id={descriptionId}>
            {dialog.sourceText.length === 0
              ? text(
                  'reachDeck.editor.narration.speech.dialog.cursor',
                  '标签将插入到当前光标位置。',
                )
              : text('reachDeck.editor.narration.speech.dialog.selection', '已选择：{selection}', {
                  selection: dialog.sourceText,
                })}
          </p>
        </div>
        <button
          aria-label={text('shared.confirm.cancel', '取消')}
          className="reach-deck-speech-dialog__close"
          disabled={busy}
          onClick={onCancel}
          title={text('shared.confirm.cancel', '取消')}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onConfirm();
        }}
      >
        {dialog.kind === 'break' ? (
          <label className="reach-deck-speech-dialog__field">
            <span>{text('reachDeck.editor.narration.speech.duration', '停顿')}</span>
            <span className="reach-deck-speech-dialog__number">
              <input
                aria-describedby={validationMessage === undefined ? undefined : errorId}
                aria-invalid={!valid}
                aria-label={text('reachDeck.editor.narration.speech.durationMs', '停顿毫秒数')}
                autoFocus
                disabled={busy}
                inputMode="numeric"
                max={10000}
                min={1}
                onChange={(event) => onBreakDurationChange(Number(event.currentTarget.value))}
                step={1}
                type="number"
                value={Number.isFinite(breakDurationMs) ? breakDurationMs : ''}
              />
              <span>ms</span>
            </span>
          </label>
        ) : dialog.kind === 'soundEvent' ? (
          <label className="reach-deck-speech-dialog__field">
            <span>{text('reachDeck.editor.narration.speech.soundEventSrc', '音效文件 URL')}</span>
            <input
              aria-describedby={validationMessage === undefined ? undefined : errorId}
              aria-invalid={!valid}
              aria-label={text('reachDeck.editor.narration.speech.soundEventSrc', '音效文件 URL')}
              autoFocus
              disabled={busy}
              inputMode="url"
              onChange={(event) => onSoundEventSrcChange(event.currentTarget.value)}
              placeholder="https://example.com/sound.mp3"
              type="url"
              value={soundEventSrc}
            />
          </label>
        ) : dialog.kind === 'sub' ? (
          <label className="reach-deck-speech-dialog__field">
            <span>{text('reachDeck.editor.narration.speech.alias', '替换读法')}</span>
            <input
              aria-describedby={validationMessage === undefined ? undefined : errorId}
              aria-invalid={!valid}
              aria-label={text('reachDeck.editor.narration.speech.alias', '替换读法')}
              autoFocus
              disabled={busy}
              onChange={(event) => onAliasChange(event.currentTarget.value)}
              placeholder={text(
                'reachDeck.editor.narration.speech.dialog.aliasPlaceholder',
                '输入希望合成的读法',
              )}
              value={alias}
            />
          </label>
        ) : dialog.kind === 'say-as' ? (
          <label className="reach-deck-speech-dialog__field">
            <span>{text('reachDeck.editor.narration.speech.interpretAs', '读法类型')}</span>
            <Select<(typeof REACH_DECK_SAY_AS_INTERPRETATIONS)[number]>
              aria-label={text('reachDeck.editor.narration.speech.interpretAs', '读法类型')}
              autoFocus
              className="reach-deck-speech-dialog__select"
              disabled={busy}
              listboxClassName="reach-deck-speech-dialog__select-list"
              onChange={onInterpretAsChange}
              options={REACH_DECK_SAY_AS_INTERPRETATIONS.map((value) => ({
                label: `${text(
                  `reachDeck.editor.narration.speech.interpretation.${value}`,
                  SAY_AS_LABELS[value],
                )} (${value})`,
                value,
              }))}
              portal
              value={interpretAs}
            />
          </label>
        ) : (
          <>
            <fieldset className="reach-deck-speech-dialog__field">
              <legend>{text('reachDeck.editor.narration.speech.alphabet', '音标类型')}</legend>
              <div className="reach-deck-speech-dialog__segments">
                {(['py', 'cmu', 'ipa'] as const).map((value) => (
                  <label key={value}>
                    <input
                      checked={alphabet === value}
                      disabled={busy}
                      name="reach-deck-phoneme-alphabet"
                      onChange={() => onAlphabetChange(value)}
                      type="radio"
                      value={value}
                    />
                    <span>
                      {text(
                        `reachDeck.editor.narration.speech.phonemeAlphabet.${value}`,
                        PHONEME_ALPHABET_LABELS[value],
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="reach-deck-speech-dialog__field">
              <span>{text('reachDeck.editor.narration.speech.phoneme', '发音标注')}</span>
              <input
                aria-describedby={validationMessage === undefined ? undefined : errorId}
                aria-invalid={!valid}
                aria-label={text('reachDeck.editor.narration.speech.phoneme', '发音标注')}
                autoFocus
                disabled={busy}
                onChange={(event) => onPhonemeChange(event.currentTarget.value)}
                placeholder={PHONEME_PLACEHOLDERS[alphabet]}
                ref={phonemeInputRef}
                value={phoneme}
              />
            </label>
            <PhonemeReferencePanel
              alphabet={alphabet}
              busy={busy}
              inputRef={phonemeInputRef}
              onChange={onPhonemeChange}
              text={text}
              value={phoneme}
            />
          </>
        )}

        {validationMessage === undefined ? null : (
          <p className="reach-deck-speech-dialog__validation" id={errorId} role="status">
            {validationMessage}
          </p>
        )}

        <footer className="reach-deck-speech-dialog__actions">
          {onRemove === undefined ? null : (
            <button className="is-danger" disabled={busy} onClick={onRemove} type="button">
              <Trash2 aria-hidden="true" size={14} />
              <span>{text('reachDeck.editor.narration.speech.remove', '移除标签')}</span>
            </button>
          )}
          <span className="reach-deck-speech-dialog__action-spacer" />
          <button disabled={busy} onClick={onCancel} type="button">
            {text('shared.confirm.cancel', '取消')}
          </button>
          <button className="is-primary" disabled={busy || !valid} type="submit">
            {dialog.editing
              ? text('reachDeck.editor.narration.speech.update', '更新标签')
              : text('reachDeck.editor.narration.speech.apply', '应用标签')}
          </button>
        </footer>
      </form>
    </div>
  );
}

function PhonemeReferencePanel({
  alphabet,
  busy,
  inputRef,
  onChange,
  text,
  value,
}: {
  alphabet: PhonemeAlphabet;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  text: SpeechText;
  value: string;
}) {
  const titleId = useId();
  const groups = PHONEME_REFERENCE_GROUPS[alphabet];
  const editValue = (
    operation: (current: string, selectionStart: number, selectionEnd: number) => PhonemeInputEdit,
  ) => {
    const input = inputRef.current;
    const selectionStart = input?.selectionStart ?? value.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const next = operation(value, selectionStart, selectionEnd);
    onChange(next.value);
    queueMicrotask(() => {
      input?.focus();
      input?.setSelectionRange(next.selection, next.selection);
    });
  };

  return (
    <section aria-labelledby={titleId} className="reach-deck-speech-dialog__phoneme-panel">
      <header className="reach-deck-speech-dialog__phoneme-panel-header">
        <strong id={titleId}>
          {text('reachDeck.editor.narration.speech.phonemePanel.title', '发音参考')}
        </strong>
        <span>
          {text(
            `reachDeck.editor.narration.speech.phonemePanel.${alphabet}Hint`,
            alphabet === 'py'
              ? '每个汉字一个拼音，空格分隔，末尾写数字声调。'
              : alphabet === 'cmu'
                ? '音素用空格分隔；元音后可加 0、1、2 重音。'
                : '使用豆包支持的美式音标，不使用分隔符。',
          )}
        </span>
      </header>
      <div className="reach-deck-speech-dialog__phoneme-groups">
        {groups.map((group) => (
          <div className="reach-deck-speech-dialog__phoneme-group" key={group.labelKey}>
            <span>{text(group.labelKey, group.fallbackLabel)}</span>
            <div>
              {group.tokens.map((token) => (
                <button
                  aria-label={text(
                    'reachDeck.editor.narration.speech.phonemePanel.insertToken',
                    '插入音素 {token}',
                    { token: token.label },
                  )}
                  disabled={busy}
                  key={`${token.value}:${token.label}`}
                  onClick={() =>
                    editValue((current, selectionStart, selectionEnd) =>
                      insertPhonemeToken(
                        current,
                        selectionStart,
                        selectionEnd,
                        token.value,
                        group.insertion,
                      ),
                    )
                  }
                  title={token.label}
                  type="button"
                >
                  {token.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="reach-deck-speech-dialog__phoneme-actions">
        {alphabet === 'ipa' ? null : (
          <button
            aria-label={text('reachDeck.editor.narration.speech.phonemePanel.space', '插入空格')}
            disabled={busy}
            onClick={() =>
              editValue((current, selectionStart, selectionEnd) =>
                replacePhonemeSelection(current, selectionStart, selectionEnd, ' '),
              )
            }
            title={text('reachDeck.editor.narration.speech.phonemePanel.space', '插入空格')}
            type="button"
          >
            <Space aria-hidden="true" size={14} />
          </button>
        )}
        <button
          aria-label={text('reachDeck.editor.narration.speech.phonemePanel.backspace', '退格')}
          disabled={busy || value.length === 0}
          onClick={() =>
            editValue((current, selectionStart, selectionEnd) =>
              deletePhonemeBackward(current, selectionStart, selectionEnd),
            )
          }
          title={text('reachDeck.editor.narration.speech.phonemePanel.backspace', '退格')}
          type="button"
        >
          <Delete aria-hidden="true" size={14} />
        </button>
        <button
          aria-label={text('reachDeck.editor.narration.speech.phonemePanel.clear', '清空')}
          disabled={busy || value.length === 0}
          onClick={() => editValue(() => ({ selection: 0, value: '' }))}
          title={text('reachDeck.editor.narration.speech.phonemePanel.clear', '清空')}
          type="button"
        >
          <Eraser aria-hidden="true" size={14} />
        </button>
      </div>
    </section>
  );
}

interface PhonemeInputEdit {
  selection: number;
  value: string;
}

function insertPhonemeToken(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  token: string,
  insertion: PhonemeReferenceGroup['insertion'],
): PhonemeInputEdit {
  if (insertion === 'adjacent') {
    return replacePhonemeSelection(value, selectionStart, selectionEnd, token);
  }
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const prefix = before.length === 0 || /\s$/u.test(before) ? '' : ' ';
  const suffix = after.length === 0 || /^\s/u.test(after) ? '' : ' ';
  return {
    selection: before.length + prefix.length + token.length,
    value: `${before}${prefix}${token}${suffix}${after}`,
  };
}

function replacePhonemeSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  replacement: string,
): PhonemeInputEdit {
  return {
    selection: selectionStart + replacement.length,
    value: `${value.slice(0, selectionStart)}${replacement}${value.slice(selectionEnd)}`,
  };
}

function deletePhonemeBackward(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): PhonemeInputEdit {
  if (selectionStart !== selectionEnd) {
    return replacePhonemeSelection(value, selectionStart, selectionEnd, '');
  }
  if (selectionStart === 0) return { selection: 0, value };
  const previousCodePoint = Array.from(value.slice(0, selectionStart)).at(-1);
  const deleteFrom = selectionStart - (previousCodePoint?.length ?? 0);
  return {
    selection: deleteFrom,
    value: `${value.slice(0, deleteFrom)}${value.slice(selectionEnd)}`,
  };
}

function SpeechDocumentSettingsDialog({
  anchorElement,
  bgm,
  busy,
  effect,
  onBgmChange,
  onCancel,
  onClear,
  onConfirm,
  onEffectChange,
  onVolumeChange,
  text,
  volume,
}: {
  anchorElement: HTMLButtonElement | null;
  bgm: string;
  busy: boolean;
  effect: ReachDeckSpeechEffectV1 | '';
  onBgmChange: (value: string) => void;
  onCancel: () => void;
  onClear: () => void;
  onConfirm: () => void;
  onEffectChange: (value: ReachDeckSpeechEffectV1 | '') => void;
  onVolumeChange: (value: number | '') => void;
  text: SpeechText;
  volume: number | '';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const [position, setPosition] = useState<SpeechPopoverPosition>();
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const validationMessage = speechSettingsValidationMessage(bgm, volume, text);
  const valid = validationMessage === undefined;

  useLayoutEffect(() => {
    const updatePosition = () => {
      const panel = panelRef.current;
      if (panel === null || anchorElement === null || !anchorElement.isConnected) {
        onCancelRef.current();
        return;
      }
      setPosition(
        speechPopoverPosition(anchorElement.getBoundingClientRect(), panel.getBoundingClientRect()),
      );
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorElement]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        panelRef.current?.contains(target) ||
        anchorElement?.contains(target) ||
        (target instanceof Element &&
          target.closest('.reach-deck-speech-dialog__select-list') !== null)
      )
        return;
      onCancelRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancelRef.current();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorElement]);

  return (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="reach-deck-speech-dialog"
      data-placement={position?.placement}
      ref={panelRef}
      role="dialog"
      style={speechPopoverStyle(position)}
    >
      <header className="reach-deck-speech-dialog__header">
        <div>
          <h2 id={titleId}>
            {text('reachDeck.editor.narration.speech.settings.title', '背景与声音效果')}
          </h2>
          <p id={descriptionId}>
            {text(
              'reachDeck.editor.narration.speech.settings.description',
              '这些参数应用于整篇讲稿的 speak 根标签。',
            )}
          </p>
        </div>
        <button
          aria-label={text('shared.confirm.cancel', '取消')}
          className="reach-deck-speech-dialog__close"
          disabled={busy}
          onClick={onCancel}
          title={text('shared.confirm.cancel', '取消')}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) onConfirm();
        }}
      >
        <label className="reach-deck-speech-dialog__field">
          <span>{text('reachDeck.editor.narration.speech.settings.bgm', '背景音乐 URL')}</span>
          <input
            aria-describedby={validationMessage === undefined ? undefined : errorId}
            aria-invalid={bgm !== '' && !httpUrlIsValid(bgm)}
            aria-label={text('reachDeck.editor.narration.speech.settings.bgm', '背景音乐 URL')}
            autoFocus
            disabled={busy}
            inputMode="url"
            onChange={(event) => onBgmChange(event.currentTarget.value)}
            placeholder="https://example.com/background.mp3"
            type="url"
            value={bgm}
          />
        </label>
        <label className="reach-deck-speech-dialog__field">
          <span>
            {text('reachDeck.editor.narration.speech.settings.volume', '背景音乐音量（0–100）')}
          </span>
          <input
            aria-describedby={validationMessage === undefined ? undefined : errorId}
            aria-invalid={
              volume !== '' && (!Number.isSafeInteger(volume) || volume < 0 || volume > 100)
            }
            aria-label={text(
              'reachDeck.editor.narration.speech.settings.volume',
              '背景音乐音量（0–100）',
            )}
            disabled={busy}
            inputMode="numeric"
            max={100}
            min={0}
            onChange={(event) =>
              onVolumeChange(
                event.currentTarget.value === '' ? '' : Number(event.currentTarget.value),
              )
            }
            placeholder={text('reachDeck.editor.narration.speech.settings.providerDefault', '默认')}
            step={1}
            type="number"
            value={volume}
          />
        </label>
        <label className="reach-deck-speech-dialog__field">
          <span>{text('reachDeck.editor.narration.speech.settings.effect', '声音效果')}</span>
          <Select<ReachDeckSpeechEffectV1 | ''>
            aria-label={text('reachDeck.editor.narration.speech.settings.effect', '声音效果')}
            className="reach-deck-speech-dialog__select"
            disabled={busy}
            listboxClassName="reach-deck-speech-dialog__select-list"
            onChange={onEffectChange}
            options={[
              {
                label: text('reachDeck.editor.narration.speech.settings.noEffect', '不使用'),
                value: '',
              },
              ...REACH_DECK_SPEECH_EFFECTS.map((value) => ({
                label: `${text(
                  `reachDeck.editor.narration.speech.effect.${value}`,
                  SPEECH_EFFECT_LABELS[value],
                )} (${value})`,
                value,
              })),
            ]}
            portal
            value={effect}
          />
        </label>
        {validationMessage === undefined ? null : (
          <p className="reach-deck-speech-dialog__validation" id={errorId} role="status">
            {validationMessage}
          </p>
        )}
        <footer className="reach-deck-speech-dialog__actions">
          <button className="is-danger" disabled={busy} onClick={onClear} type="button">
            <Trash2 aria-hidden="true" size={14} />
            <span>{text('reachDeck.editor.narration.speech.settings.clear', '清除全局设置')}</span>
          </button>
          <span className="reach-deck-speech-dialog__action-spacer" />
          <button disabled={busy} onClick={onCancel} type="button">
            {text('shared.confirm.cancel', '取消')}
          </button>
          <button className="is-primary" disabled={busy || !valid} type="submit">
            {text('reachDeck.editor.narration.speech.settings.apply', '应用全局设置')}
          </button>
        </footer>
      </form>
    </div>
  );
}

interface SpeechPopoverPosition {
  left: number;
  placement: 'bottom' | 'top';
  top: number;
}

function speechPopoverPosition(anchor: DOMRect, panel: DOMRect): SpeechPopoverPosition {
  const viewportPadding = 8;
  const gap = 8;
  const left = Math.min(
    Math.max(viewportPadding, anchor.left + anchor.width / 2 - panel.width / 2),
    Math.max(viewportPadding, window.innerWidth - panel.width - viewportPadding),
  );
  const topSpace = anchor.top - viewportPadding;
  const bottomSpace = window.innerHeight - anchor.bottom - viewportPadding;
  const placement = topSpace >= panel.height + gap || topSpace >= bottomSpace ? 'top' : 'bottom';
  const top =
    placement === 'top'
      ? Math.max(viewportPadding, anchor.top - panel.height - gap)
      : Math.min(
          anchor.bottom + gap,
          Math.max(viewportPadding, window.innerHeight - panel.height - viewportPadding),
        );
  return { left, placement, top };
}

function speechPopoverStyle(position: SpeechPopoverPosition | undefined): CSSProperties {
  return position === undefined
    ? { left: 0, top: 0, visibility: 'hidden' }
    : { left: position.left, top: position.top };
}

function speechMarkDialogIsValid(
  dialog: SpeechMarkDialogState,
  breakDurationMs: number,
  soundEventSrc: string,
  alias: string,
  alphabet: 'py' | 'cmu' | 'ipa',
  phoneme: string,
): boolean {
  if (dialog.kind === 'break') {
    return (
      Number.isSafeInteger(breakDurationMs) && breakDurationMs >= 1 && breakDurationMs <= 10_000
    );
  }
  if (dialog.kind === 'soundEvent') return httpUrlIsValid(soundEventSrc);
  if (dialog.kind === 'sub') return speechAttributeIsValid(alias);
  if (dialog.kind === 'say-as') return true;
  return (
    speechAttributeIsValid(phoneme) &&
    (alphabet === 'py'
      ? /^\p{Script=Han}+$/u.test(dialog.sourceText)
      : /^[A-Za-z]+(?: [A-Za-z]+)*$/u.test(dialog.sourceText))
  );
}

function speechMarkDialogValidationMessage(
  dialog: SpeechMarkDialogState,
  breakDurationMs: number,
  soundEventSrc: string,
  alias: string,
  alphabet: 'py' | 'cmu' | 'ipa',
  phoneme: string,
  text: SpeechText,
): string | undefined {
  if (dialog.kind === 'break') {
    return Number.isSafeInteger(breakDurationMs) &&
      breakDurationMs >= 1 &&
      breakDurationMs <= 10_000
      ? undefined
      : text(
          'reachDeck.editor.narration.speech.dialog.breakInvalid',
          '请输入 1 到 10000 之间的整数毫秒数。',
        );
  }
  if (dialog.kind === 'soundEvent') {
    return httpUrlIsValid(soundEventSrc)
      ? undefined
      : text(
          'reachDeck.editor.narration.speech.dialog.soundEventUrlInvalid',
          '请输入完整的 HTTP 或 HTTPS 音效文件 URL。',
        );
  }
  if (dialog.kind === 'sub') {
    return speechAttributeValidationMessage(alias, text);
  }
  if (dialog.kind === 'say-as') return undefined;
  if (alphabet === 'py' && !/^\p{Script=Han}+$/u.test(dialog.sourceText)) {
    return text(
      'reachDeck.editor.narration.speech.dialog.pySourceInvalid',
      '拼音标注只能应用到纯汉字选区。',
    );
  }
  if (alphabet !== 'py' && !/^[A-Za-z]+(?: [A-Za-z]+)*$/u.test(dialog.sourceText)) {
    return text(
      'reachDeck.editor.narration.speech.dialog.latinSourceInvalid',
      'CMU 和 IPA 标注只能应用到由拉丁字母和单个空格组成的词语。',
    );
  }
  return speechAttributeValidationMessage(phoneme, text);
}

function speechAttributeValidationMessage(value: string, text: SpeechText): string | undefined {
  if (value.length === 0 || value !== value.trim()) {
    return text(
      'reachDeck.editor.narration.speech.dialog.attributeInvalid',
      '内容不能为空，且开头和结尾不能有空格。',
    );
  }
  if ([...value].length > 500) {
    return text(
      'reachDeck.editor.narration.speech.dialog.attributeTooLong',
      '内容不能超过 500 个 Unicode 字符。',
    );
  }
  return undefined;
}

function speechAttributeIsValid(value: string): boolean {
  return speechAttributeValidationMessage(value, () => '') === undefined;
}

function speechSettingsValidationMessage(
  bgm: string,
  volume: number | '',
  text: SpeechText,
): string | undefined {
  if (bgm !== '' && !httpUrlIsValid(bgm)) {
    return text(
      'reachDeck.editor.narration.speech.settings.bgmInvalid',
      '请输入完整的 HTTP 或 HTTPS 背景音乐 URL。',
    );
  }
  if (volume !== '' && (!Number.isSafeInteger(volume) || volume < 0 || volume > 100)) {
    return text(
      'reachDeck.editor.narration.speech.settings.volumeInvalid',
      '背景音乐音量必须是 0 到 100 之间的整数。',
    );
  }
  return undefined;
}

function speechSettingsIsValid(
  bgm: string,
  volume: number | '',
  effect: ReachDeckSpeechEffectV1 | '',
): boolean {
  return (
    speechSettingsValidationMessage(bgm, volume, () => '') === undefined &&
    (effect === '' || (REACH_DECK_SPEECH_EFFECTS as readonly string[]).includes(effect))
  );
}

function httpUrlIsValid(value: string): boolean {
  if (value.length === 0 || value !== value.trim() || [...value].length > 500) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

function isPointSpeechMarkType(type: ReachDeckSpeechMarkV1['type']): boolean {
  return type === 'break' || type === 'soundEvent';
}

function cloneSpeakOptions(
  speak: ReachDeckSpeakOptionsV1 | undefined,
): ReachDeckSpeakOptionsV1 | undefined {
  return speak === undefined ? undefined : { ...speak };
}

function buildSpeechMarkup(
  markdown: string,
  marks: readonly ReachDeckSpeechMarkV1[],
  speak: ReachDeckSpeakOptionsV1 | undefined,
): ReachDeckSpeechMarkupV1 | undefined {
  if (marks.length === 0 && speak === undefined) return undefined;
  return canonicalizeReachDeckSpeechMarkupV1(
    {
      schemaVersion: 'reach-deck-speech-marks/v1',
      marks: [...marks],
      ...(speak === undefined ? {} : { speak: { ...speak } }),
    },
    markdown,
  );
}

interface NarrationDraftState {
  draft: RichTextDocument;
  literalFallback: boolean;
  /** 仅 Interactive 字面量载入：教师尚未编辑，草稿即已保存讲稿本身。 */
  untouched?: boolean;
}

function createNarrationDraft(
  sourceMarkdown: string,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
  fallbackMarkdown: string | undefined,
  literalSourceText?: string,
): NarrationDraftState {
  if (literalSourceText !== undefined) {
    return {
      draft: literalNarrationDocument(literalSourceText),
      literalFallback: true,
      untouched: true,
    };
  }
  if (fallbackMarkdown === undefined) {
    return {
      draft: parseReachDeckNarrationSpeechDocument(sourceMarkdown, speechMarkup),
      literalFallback: false,
    };
  }
  try {
    // Capacity failures still keep parsed formula semantics; only syntax/parser failures fall back
    // to literal text. The existing analysis below remains the save gate for every mode.
    return {
      draft: parseReachDeckNarrationSpeechDocument(fallbackMarkdown),
      literalFallback: false,
    };
  } catch {
    return { draft: literalNarrationDocument(fallbackMarkdown), literalFallback: true };
  }
}

function literalNarrationDocument(value: string): RichTextDocument {
  const content = value
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((block) => block.length > 0)
    .map((block) => {
      const inline: NonNullable<RichTextDocument['content']>[number][] = [];
      block.split('\n').forEach((line, index) => {
        if (index > 0) inline.push({ type: 'hardBreak' });
        if (line.length > 0) inline.push({ type: 'text', text: line });
      });
      return { type: 'paragraph', ...(inline.length === 0 ? {} : { content: inline }) };
    });
  return { type: 'doc', ...(content.length === 0 ? {} : { content }) };
}

interface InteractiveNarrationSavePayload {
  text: string;
  speechMarkup?: ReachDeckSpeechMarkupV1;
}

const INTERACTIVE_EMPTY_NARRATION_IDENTITY = 'reach-interactive-narration/empty';
const EMPTY_NARRATION_IDENTITY = narrationSpeechIdentity('', undefined);

/** Interactive 草稿不满足“单段落、≤ 600 个 Unicode 字符、无控制字符”的原因。 */
class InteractiveNarrationDraftError extends Error {
  constructor(readonly kind: 'limit' | 'invalid') {
    super(`Interactive narration draft is ${kind}.`);
    this.name = 'InteractiveNarrationDraftError';
  }
}

function interactiveNarrationIdentity(
  text: string,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
): string {
  try {
    return reachDeckInteractiveNarrationContentDigestInput(text, speechMarkup);
  } catch {
    return `invalid\u0000${text}\u0000${JSON.stringify(speechMarkup)}`;
  }
}

/**
 * 读取已保存的 Interactive 讲稿：派生编辑器用的规范 Markdown，并按与草稿相同的规范化流程计算
 * 基线身份，使“载入即未修改”。无法用讲稿 Markdown 方言表达的文本返回 `literalText`。
 */
function readInteractiveNarrationSource(
  text: string | undefined,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
): {
  baselineIdentity: string;
  literalText?: string;
  markdown: string;
  speechMarkup?: ReachDeckSpeechMarkupV1;
} {
  if (text === undefined) {
    return { baselineIdentity: INTERACTIVE_EMPTY_NARRATION_IDENTITY, markdown: '' };
  }
  let markdown: string;
  try {
    markdown = reachDeckInteractiveNarrationMarkdown(text);
    // 标记无法落在派生 Markdown 上时同样按字面量载入，避免编辑器初始化抛错。
    parseReachDeckNarrationSpeechDocument(markdown, speechMarkup);
  } catch {
    return { baselineIdentity: `literal\u0000${text}`, literalText: text, markdown: '' };
  }
  let baselineIdentity: string;
  try {
    const value = interactiveNarrationDraftValue(markdown, speechMarkup);
    baselineIdentity = interactiveNarrationIdentity(value.text, value.speechMarkup);
  } catch {
    baselineIdentity = `invalid\u0000${text}\u0000${JSON.stringify(speechMarkup)}`;
  }
  return {
    baselineIdentity,
    markdown,
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
  };
}

/**
 * 编辑器规范 Markdown + 标记 → Interactive 保存值。先折叠 U+0020（与
 * `canonicalizeInteractiveNarrationText` 同一规则）并同步平移标记偏移，保证
 * `reachDeckInteractiveNarrationMarkdown(text)` 精确等于标记所锚定的 Markdown。
 */
function interactiveNarrationDraftValue(
  markdown: string,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
): { scalarCount: number; speechMarkup?: ReachDeckSpeechMarkupV1; text: string } {
  const collapsed = collapseInteractiveNarrationSpacing(markdown, speechMarkup);
  let text: string;
  try {
    text = reachDeckInteractiveNarrationTextFromMarkdown(collapsed.markdown);
    if (reachDeckInteractiveNarrationMarkdown(text) !== collapsed.markdown) {
      throw new InteractiveNarrationDraftError('invalid');
    }
  } catch (error) {
    if (error instanceof ReachDeckNarrationMarkdownError) throw error;
    throw new InteractiveNarrationDraftError(
      interactiveNarrationScalarCount(collapsed.markdown) > INTERACTIVE_NARRATION_MAX_TEXT_SCALARS
        ? 'limit'
        : 'invalid',
    );
  }
  const canonicalMarkup =
    collapsed.speechMarkup === undefined
      ? undefined
      : canonicalizeReachDeckSpeechMarkupV1(collapsed.speechMarkup, collapsed.markdown);
  if (canonicalMarkup !== undefined) planReachDeckSsmlChunks(collapsed.markdown, canonicalMarkup);
  return {
    scalarCount: [...text].length,
    text,
    ...(canonicalMarkup === undefined ? {} : { speechMarkup: canonicalMarkup }),
  };
}

/** 折叠首尾与连续的 U+0020，并把语音标记偏移映射到折叠后的 Markdown。 */
function collapseInteractiveNarrationSpacing(
  markdown: string,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
): { markdown: string; speechMarkup?: ReachDeckSpeechMarkupV1 } {
  let first = 0;
  while (first < markdown.length && markdown[first] === ' ') first += 1;
  let last = markdown.length - 1;
  while (last >= first && markdown[last] === ' ') last -= 1;
  const offsets = new Array<number>(markdown.length + 1);
  let collapsed = '';
  for (let index = 0; index < markdown.length; index += 1) {
    offsets[index] = collapsed.length;
    const character = markdown[index]!;
    const kept =
      character !== ' ' || (index > first && index < last && markdown[index - 1] !== ' ');
    if (kept) collapsed += character;
  }
  offsets[markdown.length] = collapsed.length;
  if (speechMarkup === undefined || collapsed === markdown) {
    return { markdown: collapsed, ...(speechMarkup === undefined ? {} : { speechMarkup }) };
  }
  const marks = speechMarkup.marks.flatMap((mark): ReachDeckSpeechMarkV1[] => {
    if (mark.type === 'break' || mark.type === 'soundEvent') {
      return [{ ...mark, at: offsets[mark.at] ?? collapsed.length }];
    }
    const from = offsets[mark.from] ?? collapsed.length;
    const to = offsets[mark.to] ?? collapsed.length;
    // 只覆盖被折叠空格的范围标记没有可朗读内容，随空格一起丢弃。
    return from < to ? [{ ...mark, from, to }] : [];
  });
  return marks.length === 0 && speechMarkup.speak === undefined
    ? { markdown: collapsed }
    : { markdown: collapsed, speechMarkup: { ...speechMarkup, marks } };
}

/** 草稿对应 Interactive `text` 的 Unicode 字符数；仅用于无法保存时的容量显示与超长判定。 */
function interactiveNarrationScalarCount(markdown: string): number {
  try {
    const inline = parseReachDeckNarrationMarkdown(markdown).content?.[0]?.content ?? [];
    if (inline.some((node) => node.type === 'inlineMath')) return [...markdown].length;
    return [...inline.map((node) => node.text ?? '').join('')].length;
  } catch {
    return [...markdown].length;
  }
}

function interactiveNarrationValidationMessage(
  error: unknown,
  text: (key: string, fallback: string, replacements?: Record<string, string | number>) => string,
): string | undefined {
  if (error instanceof ReachDeckNarrationMarkdownError && error.code === 'empty') {
    return text('reachDeck.editor.interactiveNarration.empty', '请输入互动讲稿。');
  }
  if (error instanceof InteractiveNarrationDraftError) {
    return error.kind === 'limit'
      ? text(
          'reachDeck.editor.interactiveNarration.limit',
          '互动讲稿不能超过 {limit} 个 Unicode 字符。',
          { limit: INTERACTIVE_NARRATION_MAX_TEXT_SCALARS },
        )
      : text('reachDeck.editor.interactiveNarration.invalid', '互动讲稿只能是一段文字，不能换行。');
  }
  return narrationValidationMessage(error, text);
}

function narrationValidationMessage(
  error: unknown,
  text: (key: string, fallback: string, replacements?: Record<string, string | number>) => string,
): string | undefined {
  if (error instanceof ReachDeckSpeechMarkupError) {
    if (error.code === 'chunk-unit-limit') {
      return text(
        'reachDeck.editor.narration.speech.chunkLimit',
        '单个语音标记或公式按讲稿编辑框计数超过 80，或包含语音标记超过 150 字符，无法保存。',
      );
    }
    return text(
      'reachDeck.editor.narration.speech.invalidMarkup',
      '语音标记范围或属性无效，请检查后重试。',
    );
  }
  if (!(error instanceof ReachDeckNarrationMarkdownError)) {
    return error === undefined
      ? undefined
      : text('reachDeck.editor.narration.invalid', '讲稿包含不支持的内容。');
  }
  if (error.code === 'empty') {
    return text('reachDeck.editor.narration.empty', '请输入讲稿文字或公式。');
  }
  if (error.code === 'semantic-limit') {
    return text(
      'reachDeck.editor.narration.semanticLimit',
      '整份讲稿不能超过 {limit} 个字符/词。',
      { limit: REACH_DECK_NARRATION_MAX_SEMANTIC_UNITS },
    );
  }
  if (error.code === 'raw-limit') {
    return text(
      'reachDeck.editor.narration.rawLimit',
      '整份讲稿的 Markdown 不能超过 {limit} 个 Unicode 字符。',
      { limit: REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS },
    );
  }
  if (error.code === 'malformed-formula') {
    return text('reachDeck.editor.narration.malformedFormula', '讲稿中有不完整或空白的公式。');
  }
  return text('reachDeck.editor.narration.unsupported', '讲稿仅支持纯文字、段落、换行和公式。');
}

function speechToolFailureMessage(
  error: unknown,
  operation: 'candidates' | 'preview',
  text: (key: string, fallback: string, replacements?: Record<string, string | number>) => string,
): string {
  const details =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; retryAfterSeconds?: unknown })
      : undefined;
  const code = details?.code;
  if (code === 'SPEECH_VOICE_UNSUPPORTED') {
    if (operation === 'candidates') {
      return text(
        'reachDeck.editor.narration.speech.smartUnsupported',
        '当前音色不支持智能读音标注，可手动添加停顿。',
      );
    }
    return text(
      'reachDeck.editor.narration.speech.voiceUnsupported',
      '当前课程音色不支持语音标记。请改用已启用的中文 Seed-TTS 2.0 音色，或移除语音标记。',
    );
  }
  if (code === 'SPEECH_TOOL_REQUEST_ACTIVE') {
    return text(
      'reachDeck.editor.narration.speech.requestActive',
      '此页面已有语音请求正在运行，请等待完成或先停止试听。',
    );
  }
  if (code === 'SPEECH_TOOL_RATE_LIMITED') {
    const retryAfterSeconds = details?.retryAfterSeconds;
    if (
      typeof retryAfterSeconds === 'number' &&
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds > 0
    ) {
      return text(
        'reachDeck.editor.narration.speech.rateLimitedRetryAfter',
        '语音请求过于频繁，请在 {seconds} 秒后重试。',
        { seconds: retryAfterSeconds },
      );
    }
    return text('reachDeck.editor.narration.speech.rateLimited', '语音请求过于频繁，请稍后再试。');
  }
  if (code === 'SPEECH_TOOL_ADMISSION_UNAVAILABLE') {
    return text(
      'reachDeck.editor.narration.speech.unavailable',
      '语音服务暂时不可用，请稍后再试。',
    );
  }
  if (code === 'SPEECH_TOOL_STALE_REQUEST') {
    return text(
      'reachDeck.editor.narration.speech.staleRequest',
      '语音工具运行期间页面已更新，请重试。',
    );
  }
  if (code === 'SPEECH_PREVIEW_TIMEOUT') {
    return text('reachDeck.editor.narration.speech.previewTimeout', '试听等待超时，请稍后重试。');
  }
  if (code === 'SPEECH_TOOL_INVALID_REQUEST' && operation === 'preview') {
    return text(
      'reachDeck.editor.narration.speech.previewInvalidSelection',
      '选区无法试听，请缩短并选择可朗读的完整短文本。',
    );
  }
  return operation === 'candidates'
    ? text('reachDeck.editor.narration.speech.smartFailed', '智能打标失败，请重试。')
    : text('reachDeck.editor.narration.speech.previewFailed', '当前音色试听失败，请重试。');
}

function speechPreviewStatusLabel(status: NarrationSpeechPreviewStatus, text: SpeechText): string {
  switch (status) {
    case 'submitting':
      return text('reachDeck.editor.narration.speech.statusSubmitting', '正在提交试听');
    case 'queued':
      return text('reachDeck.editor.narration.speech.statusQueued', '试听排队中');
    case 'running':
      return text('reachDeck.editor.narration.speech.statusRunning', '正在生成试听');
    case 'ready':
      return text('reachDeck.editor.narration.speech.statusReady', '试听已就绪');
    case 'failed':
      return text('reachDeck.editor.narration.speech.statusFailed', '试听失败');
    case 'expired':
      return text('reachDeck.editor.narration.speech.statusExpired', '试听已过期，请重试');
    case 'cancelled':
      return text('reachDeck.editor.narration.speech.statusCancelled', '试听已取消');
    case 'cancelling':
      return text('reachDeck.editor.narration.speech.statusCancelling', '正在取消试听');
    case 'draining':
      return text(
        'reachDeck.editor.narration.speech.statusDraining',
        '已停止等待，语音服务可能仍在生成，请稍后重试',
      );
    case 'cancel-unconfirmed':
      return text(
        'reachDeck.editor.narration.speech.statusCancelUnconfirmed',
        '已停止等待，未能确认后台任务已取消',
      );
  }
}

function previewTracks(
  result: NarrationSpeechPreviewResult,
  singleTrackLabel: string,
): readonly NarrationSpeechPreviewTrack[] {
  if ('tracks' in result) return result.tracks;
  return [{ id: 'current', label: singleTrackLabel, ...result }];
}

function speechCandidateLabel(candidate: NarrationSpeechMarkupCandidate): string {
  const mark = candidate.mark;
  if (mark.type === 'break') return `<break ${mark.durationMs}ms/>`;
  if (mark.type === 'soundEvent') return `<soundEvent src="${escapeNarrationXml(mark.src)}"/>`;
  if (mark.type === 'sub') return `<sub alias="${escapeNarrationXml(mark.alias)}">`;
  if (mark.type === 'say-as') return `<say-as ${mark.interpretAs}>`;
  return `<phoneme ${mark.alphabet}="${escapeNarrationXml(mark.ph)}">`;
}

function speechCandidateMatchesMarkdown(
  candidate: NarrationSpeechMarkupCandidate,
  markdown: string | undefined,
): boolean {
  if (markdown === undefined) return false;
  const mark = candidate.mark;
  return mark.type === 'break' || mark.type === 'soundEvent'
    ? candidate.sourceText === ''
    : markdown.slice(mark.from, mark.to) === candidate.sourceText;
}

function filterSpeechCandidatesAfterAcceptance(
  candidates: readonly NarrationSpeechMarkupCandidate[],
  accepted: NarrationSpeechMarkupCandidate,
  markdown: string | undefined,
  currentSpeechMarkup: ReachDeckSpeechMarkupV1 | undefined,
): readonly NarrationSpeechMarkupCandidate[] {
  if (markdown === undefined) return [];
  const acceptedMarkup = canonicalizeReachDeckSpeechMarkupV1(
    {
      schemaVersion: 'reach-deck-speech-marks/v1',
      marks: [...(currentSpeechMarkup?.marks ?? []), accepted.mark],
      ...(currentSpeechMarkup?.speak === undefined
        ? {}
        : { speak: { ...currentSpeechMarkup.speak } }),
    },
    markdown,
  );
  return candidates.filter((candidate) => {
    if (candidate.id === accepted.id || !speechCandidateMatchesMarkdown(candidate, markdown)) {
      return false;
    }
    try {
      canonicalizeReachDeckSpeechMarkupV1(
        {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [...acceptedMarkup.marks, candidate.mark],
          ...(acceptedMarkup.speak === undefined ? {} : { speak: { ...acceptedMarkup.speak } }),
        },
        markdown,
      );
      return true;
    } catch {
      return false;
    }
  });
}

function narrationSpeechIdentity(
  markdown: string,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
): string {
  try {
    return reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup);
  } catch {
    return `invalid\u0000${markdown}\u0000${JSON.stringify(speechMarkup)}`;
  }
}
