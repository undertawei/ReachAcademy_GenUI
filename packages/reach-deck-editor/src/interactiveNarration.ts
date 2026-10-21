import {
  INTERACTIVE_NARRATION_MAX_TEXT_SCALARS,
  canonicalizeInteractiveNarrationText,
  type ReachDeckInteractiveNarrationV1,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';

export type InteractiveNarrationState =
  | 'empty'
  | 'dirty'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'failed';

export type InteractiveNarrationValidationError = 'empty' | 'invalid' | 'limit';

export interface InteractiveNarrationGenerationStatus {
  phase: 'layout' | 'narration';
  state: 'loading' | 'failed' | 'manual-review-required';
  activity?: 'queued' | 'generating';
  message?: string;
}

/**
 * 讲稿面板（`NarrationEditor` Interactive 变体）上报的草稿快照。面板是草稿的唯一所有者，
 * 画布下方状态条据此显示状态，并通过面板句柄保存完全相同的内容。
 */
export interface InteractiveNarrationDraftSnapshot {
  dirty: boolean;
  /** 面板正在保存并生成音频。 */
  saving: boolean;
  /** 最近一次保存失败的提示；再次保存、修改讲稿或权威讲稿变化后清除。 */
  saveError?: string;
  /** 草稿对应 `text` 的 Unicode 字符数。 */
  scalarCount: number;
  /** 保存时提交的语音标记，锚定在 `reachDeckInteractiveNarrationMarkdown(text)` 上。 */
  speechMarkup?: ReachDeckSpeechMarkupV1;
  /** 保存时提交的规范文本；草稿为空、超长或非法而无法保存时缺省。 */
  text?: string;
  validationError?: InteractiveNarrationValidationError;
}

export interface InteractiveNarrationViewModel {
  audioSrc?: string;
  canonicalText?: string;
  draftText: string;
  failureMessage?: string;
  persistedNarration?: ReachDeckInteractiveNarrationV1;
  scalarCount: number;
  state: InteractiveNarrationState;
  validationError?: InteractiveNarrationValidationError;
}

export interface DeriveInteractiveNarrationViewModelInput {
  audioSrc?: string;
  /** 讲稿面板上报的草稿快照；提供时以它为准，`draftText` 仅在缺省时使用。 */
  draft?: InteractiveNarrationDraftSnapshot;
  draftText: string;
  generationStatus?: InteractiveNarrationGenerationStatus;
  persistedNarration?: ReachDeckInteractiveNarrationV1;
  saveError?: string;
}

/**
 * 把宿主的页面生成状态投影为讲稿面板页脚使用的音频生成状态，规则与
 * `deriveInteractiveNarrationViewModel` 对未修改草稿的判定一致。
 */
export function interactiveNarrationGenerationState(
  generationStatus: InteractiveNarrationGenerationStatus | undefined,
): 'queued' | 'generating' | 'failed' | undefined {
  if (generationStatus === undefined) return undefined;
  if (
    generationStatus.state === 'manual-review-required' ||
    (generationStatus.phase === 'narration' &&
      generationStatus.state === 'failed' &&
      generationStatus.message !== undefined)
  ) {
    return 'failed';
  }
  if (generationStatus.phase === 'narration' && generationStatus.state === 'loading') {
    return generationStatus.activity === 'queued' ? 'queued' : 'generating';
  }
  return undefined;
}

export function deriveInteractiveNarrationViewModel({
  audioSrc,
  draft,
  draftText: providedDraftText,
  generationStatus,
  persistedNarration,
  saveError: providedSaveError,
}: DeriveInteractiveNarrationViewModelInput): InteractiveNarrationViewModel {
  const draftText = draft === undefined ? providedDraftText : (draft.text ?? '');
  const saveError = providedSaveError ?? draft?.saveError;
  const rawScalarCount = [...draftText].length;
  let canonicalText: string | undefined;
  let validationError: InteractiveNarrationValidationError | undefined;
  if (draft !== undefined) {
    // 面板已完成规范化与校验（含语音标记），这里不再按纯文本重新推导。
    canonicalText = draft.text;
    validationError = draft.text === undefined ? (draft.validationError ?? 'invalid') : undefined;
  } else {
    try {
      canonicalText = canonicalizeInteractiveNarrationText(draftText);
    } catch {
      if (draftText.replaceAll(' ', '').length === 0) {
        validationError = 'empty';
      } else if (rawScalarCount > INTERACTIVE_NARRATION_MAX_TEXT_SCALARS) {
        validationError = 'limit';
      } else {
        validationError = 'invalid';
      }
    }
  }
  const scalarCount =
    draft !== undefined
      ? draft.scalarCount
      : canonicalText === undefined
        ? rawScalarCount
        : [...canonicalText].length;

  if (persistedNarration === undefined && validationError === 'empty') {
    return {
      draftText,
      scalarCount,
      state: 'empty',
      validationError,
    };
  }

  const dirty =
    draft !== undefined
      ? draft.dirty
      : canonicalText === undefined || canonicalText !== persistedNarration?.text;
  const failureMessage =
    saveError ??
    (generationStatus?.phase === 'narration' && generationStatus.state === 'failed'
      ? generationStatus.message
      : undefined);
  let state: InteractiveNarrationState;
  if (saveError !== undefined) {
    state = 'failed';
  } else if (dirty) {
    state = 'dirty';
  } else if (failureMessage !== undefined || generationStatus?.state === 'manual-review-required') {
    state = 'failed';
  } else if (generationStatus?.phase === 'narration' && generationStatus.state === 'loading') {
    state = generationStatus.activity === 'queued' ? 'queued' : 'generating';
  } else if (persistedNarration?.audioResourceId !== undefined) {
    state = 'ready';
  } else {
    state = 'dirty';
  }

  return {
    ...(audioSrc === undefined ? {} : { audioSrc }),
    ...(canonicalText === undefined ? {} : { canonicalText }),
    draftText,
    ...(failureMessage === undefined ? {} : { failureMessage }),
    ...(persistedNarration === undefined ? {} : { persistedNarration }),
    scalarCount,
    state,
    ...(validationError === undefined ? {} : { validationError }),
  };
}
