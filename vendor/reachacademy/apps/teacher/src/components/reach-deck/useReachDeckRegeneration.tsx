'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createReachDeckUuid,
  ReachDeckApiError,
  type ReachDeckWorkspaceBatchRegistration,
} from '@reachany/reach-deck-client';
import {
  getReachDeckRegenerationPageCapabilities,
  reachDeckValuesEqual,
  selectReachDeckRegenerationPages,
  type GenerationWorkspace,
  type ReachDeckDocument,
  type ReachDeckRegenerationPageCapabilities,
  type ReachDeckPageMediaSlot,
} from '@reachany/reach-deck-dsl';
import {
  ReachDeckRegenerationDialog,
  createReachDeckRegenerationSelection,
  getReachDeckRegenerationOptions,
  normalizeReachDeckRegenerationSelection,
  toggleReachDeckRegenerationChannel,
  type ReachDeckRegenerationChannel,
  type ReachDeckRegenerationSelection,
} from '@reachany/reach-deck-editor';
import { usePortalI18n } from '@/src/components/PortalI18nProvider';

type RegenerationResult = {
  batch?: ReachDeckWorkspaceBatchRegistration;
  acceptedPageIds: readonly string[];
  skipped: readonly { pageId: string; reason: string }[];
};
type Target = { pageId?: string; title?: string; scope: string };
type Attempt = {
  identity: string;
  key: string;
  prepared: boolean;
  selection: ReachDeckRegenerationSelection;
  target: Target;
  capabilities?: ReachDeckRegenerationPageCapabilities;
};

const EMPTY_MEDIA_SLOTS: Readonly<Record<string, readonly ReachDeckPageMediaSlot[]>> =
  Object.freeze({});

const targetIdentity = (target: Target) => JSON.stringify([target.scope, target.pageId]);

const userFacing = (message: string) =>
  Object.assign(new Error(message), { name: 'ReachDeckUserFacingError' });

const regenerationErrorMessage = (cause: ReachDeckApiError, t: (key: string) => string) => {
  if (cause.status === 409 && cause.code === 'image_generation_in_progress')
    return t('reachDeck.regeneration.imageBusy');
  const keys: Partial<Record<ReachDeckApiError['kind'], string>> = {
    authorization: 'reachDeck.workspace.error.authorization',
    revision_conflict: 'reachDeck.module.saveConflictDetail',
    page_locked: 'reachDeck.workspace.error.pageLocked',
    conflict: 'reachDeck.workspace.error.busyConflict',
    not_found: 'reachDeck.workspace.error.notFound',
  };
  const key = keys[cause.kind];
  return key === undefined ? undefined : t(key);
};

/** Mirror Runtime's layout-context-missing gate using saved generation context. */
export const deriveReachDeckLayoutRegeneratablePageIds = (
  workspace: GenerationWorkspace | undefined,
): readonly string[] =>
  workspace?.lessonPlan === undefined
    ? []
    : (workspace.pagedOutline?.pages ?? [])
        .filter((page) => workspace.records[page.id] !== undefined)
        .map((page) => page.id);

const canRegenerateLayout = (
  document: ReachDeckDocument | undefined,
  pageId: string | undefined,
  eligiblePageIds: readonly string[] | undefined,
) =>
  eligiblePageIds === undefined ||
  (pageId === undefined
    ? document?.pages.some((page) => eligiblePageIds.includes(page.pageId)) === true
    : eligiblePageIds.includes(pageId));

const withLayoutEligibility = (
  capabilities: ReachDeckRegenerationPageCapabilities | undefined,
  allowed: boolean,
) =>
  capabilities === undefined || allowed
    ? capabilities
    : {
        ...capabilities,
        channels: { ...capabilities.channels, layout: false },
      };

/** Whole-deck options follow page-type support without treating saved validity as a global gate. */
const capabilitiesForTarget = (
  document: ReachDeckDocument | undefined,
  pageId?: string,
  mediaSlotsByPageId: Readonly<Record<string, readonly ReachDeckPageMediaSlot[]>> = {},
): ReachDeckRegenerationPageCapabilities | undefined => {
  if (document === undefined) return undefined;
  if (pageId !== undefined)
    return getReachDeckRegenerationPageCapabilities(document, pageId, mediaSlotsByPageId[pageId]);
  const channels = {
    layout: false,
    image: false,
    narration: false,
    audio: false,
    animation: false,
  };
  for (const page of document.pages) {
    // Whole-deck choices depend on page types. Saved narration validity is checked per page
    // by Runtime, so parsing every page's narration/markup here adds no information.
    channels.layout = true;
    channels.image ||= (mediaSlotsByPageId[page.pageId]?.length ?? 0) > 0;
    channels.narration ||= page.sceneType === 'slide' || page.sceneType === 'interactive';
    channels.audio ||= page.sceneType === 'slide' || page.sceneType === 'interactive';
    channels.animation ||= page.sceneType === 'slide';
  }
  return { channels, validNarration: true, validAudio: true };
};

const normalizeForTarget = (
  selection: ReachDeckRegenerationSelection,
  capabilities: ReachDeckRegenerationPageCapabilities | undefined,
  singlePage: boolean,
) => {
  if (singlePage) return normalizeReachDeckRegenerationSelection(selection, capabilities);
  const supported = { ...selection, channels: { ...selection.channels } };
  if (capabilities)
    for (const key of Object.keys(supported.channels) as (keyof typeof supported.channels)[])
      supported.channels[key] = !!supported.channels[key] && !!capabilities.channels[key];
  return normalizeReachDeckRegenerationSelection(supported);
};

/** Own the dialog session separately from the editor and keep ambiguous POST retries idempotent. */
export function useReachDeckRegeneration({
  scopeIdentity,
  document,
  getLatestDocument,
  layoutRegeneratablePageIds,
  mediaSlotsByPageId = EMPTY_MEDIA_SLOTS,
  selectionContext,
  blockedReason,
  prepare,
  regenerate,
  onAccepted,
}: {
  scopeIdentity: string;
  document?: ReachDeckDocument;
  getLatestDocument: () => ReachDeckDocument | undefined;
  /** Omit only for hosts that own a different layout-generation capability contract. */
  layoutRegeneratablePageIds?: readonly string[];
  mediaSlotsByPageId?: Readonly<Record<string, readonly ReachDeckPageMediaSlot[]>>;
  selectionContext?: Pick<
    Parameters<typeof selectReachDeckRegenerationPages>[0],
    'workspace' | 'activePageIds' | 'failedLanesByPage'
  >;
  blockedReason?: string;
  prepare: (pageId?: string) => Promise<void>;
  regenerate: (
    selection: ReachDeckRegenerationSelection,
    options: { pageId?: string; idempotencyKey: string },
  ) => Promise<RegenerationResult>;
  onAccepted?: (result: RegenerationResult) => void;
}) {
  const { t } = usePortalI18n();
  const [target, setTarget] = useState<Target>();
  const [selection, setSelection] = useState(() => createReachDeckRegenerationSelection(false));
  const scopeRef = useRef(scopeIdentity);
  scopeRef.current = scopeIdentity;
  const targetRef = useRef(target);
  targetRef.current = target;
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const [uncertainAttempt, setUncertainAttempt] = useState<Attempt>();
  const uncertainAttemptsRef = useRef(new Map<string, Attempt>());
  const submittingRef = useRef(false);
  const imageRetryAttemptsRef = useRef(new Map<string, string>());
  const returnFocusTarget = useRef<HTMLElement | null>(null);
  const layoutPageIdsRef = useRef(layoutRegeneratablePageIds);
  layoutPageIdsRef.current = layoutRegeneratablePageIds;
  const staticCapabilities = useMemo(
    () =>
      target === undefined
        ? undefined
        : capabilitiesForTarget(document, target.pageId, mediaSlotsByPageId),
    [document, target, mediaSlotsByPageId],
  );
  const layoutAllowed =
    target !== undefined &&
    canRegenerateLayout(document, target.pageId, layoutRegeneratablePageIds);
  const capabilities = withLayoutEligibility(staticCapabilities, layoutAllowed);
  const selectionLocked =
    uncertainAttempt !== undefined &&
    target?.scope === uncertainAttempt.target.scope &&
    target?.pageId === uncertainAttempt.target.pageId;
  const effectiveSelection = selectionLocked
    ? uncertainAttempt.selection
    : normalizeForTarget(selection, capabilities, target?.pageId !== undefined);
  useEffect(() => {
    if (!submittingRef.current && !reachDeckValuesEqual(selection, effectiveSelection))
      setSelection(effectiveSelection);
  }, [effectiveSelection, selection]);
  const targetMissing =
    target?.pageId !== undefined && !document?.pages.some((page) => page.pageId === target.pageId);
  useEffect(() => {
    if (target?.scope !== scopeIdentity || targetMissing) setTarget(undefined);
  }, [scopeIdentity, target?.scope, targetMissing]);
  const close = useCallback(() => setTarget(undefined), []);
  /**
   * 打开弹窗。`preset` 用于失败浮层等入口预勾选要重做的通道：按依赖顺序逐个勾选，
   * 不可用的通道（页类型不支持、缺少前置内容）自动跳过，教师仍可在弹窗里调整。
   */
  const request = (
    pageId?: string,
    preset?: { channels: readonly ReachDeckRegenerationChannel[] },
  ) => {
    if (submittingRef.current) return;
    const latest = getLatestDocument();
    if (latest === undefined) return;
    const page =
      pageId === undefined
        ? undefined
        : latest.pages.find((candidate) => candidate.pageId === pageId);
    if (pageId !== undefined && page === undefined) return;
    returnFocusTarget.current =
      window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    const nextTarget = { pageId, title: page?.title, scope: scopeIdentity };
    // An uncertain POST keeps its choices and key when this target is reopened.
    const prior = uncertainAttemptsRef.current.get(targetIdentity(nextTarget));
    attemptRef.current = prior;
    setUncertainAttempt(prior);
    const presetSelection = () => {
      const capabilities = withLayoutEligibility(
        capabilitiesForTarget(latest, pageId, mediaSlotsByPageId),
        canRegenerateLayout(latest, pageId, layoutPageIdsRef.current),
      );
      return (preset?.channels ?? []).reduce(
        (current, channel) =>
          toggleReachDeckRegenerationChannel(
            current,
            channel,
            true,
            pageId === undefined ? undefined : capabilities,
          ),
        createReachDeckRegenerationSelection(pageId !== undefined),
      );
    };
    setSelection(
      prior?.prepared && prior.target.scope === scopeIdentity && prior.target.pageId === pageId
        ? prior.selection
        : presetSelection(),
    );
    setTarget(nextTarget);
  };
  const change = (next: ReachDeckRegenerationSelection) => {
    const channel = (['layout', 'image', 'narration', 'audio', 'animation'] as const).find(
      (key) => next.channels[key] !== effectiveSelection.channels[key],
    );
    if (selectionLocked || (channel === 'layout' && !layoutAllowed)) return;
    const normalized =
      channel === undefined
        ? normalizeForTarget(next, capabilities, target?.pageId !== undefined)
        : toggleReachDeckRegenerationChannel(
            effectiveSelection,
            channel,
            !!next.channels[channel],
            target?.pageId === undefined ? undefined : capabilities,
          );
    if (
      normalized.channels.image &&
      !normalized.channels.layout &&
      target?.pageId !== undefined &&
      !(mediaSlotsByPageId[target.pageId] ?? []).some((slot) => slot.status === 'failed')
    )
      normalized.imageScope = 'all';
    if (!reachDeckValuesEqual(normalized, effectiveSelection)) attemptRef.current = undefined;
    setSelection(normalized);
  };
  const submit = async (chosen: ReachDeckRegenerationSelection) => {
    if (target === undefined || submittingRef.current || target.scope !== scopeRef.current) return;
    if (blockedReason !== undefined) throw userFacing(blockedReason);
    submittingRef.current = true;
    try {
      const identity = JSON.stringify([target.scope, target.pageId, chosen]);
      let attempt = attemptRef.current;
      if (attempt?.identity !== identity) {
        attempt = {
          identity,
          key: createReachDeckUuid(),
          prepared: false,
          selection: chosen,
          target,
          capabilities,
        };
        attemptRef.current = attempt;
      }
      if (!attempt.prepared) {
        await prepare(target.pageId);
        if (target.scope !== scopeRef.current || targetRef.current !== target)
          throw userFacing(t('reachDeck.regeneration.contextChanged'));
        const latest = getLatestDocument();
        const nextCapabilities = withLayoutEligibility(
          capabilitiesForTarget(latest, target.pageId, mediaSlotsByPageId),
          canRegenerateLayout(latest, target.pageId, layoutPageIdsRef.current),
        );
        const normalized = normalizeForTarget(
          chosen,
          nextCapabilities,
          target.pageId !== undefined,
        );
        if (!reachDeckValuesEqual(normalized, chosen)) {
          setSelection(normalized);
          throw userFacing(t('reachDeck.regeneration.prerequisitesChanged'));
        }
        attempt.prepared = true;
      }
      const result = await regenerate(chosen, {
        idempotencyKey: attempt.key,
        ...(target.pageId === undefined ? {} : { pageId: target.pageId }),
      });
      attemptRef.current = undefined;
      uncertainAttemptsRef.current.delete(targetIdentity(target));
      setUncertainAttempt(undefined);
      if (target.scope === scopeRef.current) {
        try {
          onAccepted?.(result);
        } catch {
          /* Notification cannot undo durable acceptance. */
        }
      }
    } catch (cause) {
      if (cause instanceof ReachDeckApiError) {
        // A definitive rejection can never have accepted this command. New attempts must save again.
        if (cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
          attemptRef.current = undefined;
          uncertainAttemptsRef.current.delete(targetIdentity(target));
          setUncertainAttempt(undefined);
        } else if (attemptRef.current?.prepared) {
          uncertainAttemptsRef.current.set(targetIdentity(target), attemptRef.current);
          setUncertainAttempt(attemptRef.current);
        }
        const message = regenerationErrorMessage(cause, t);
        if (message !== undefined) throw userFacing(message);
      }
      if (!(cause instanceof ReachDeckApiError) && attemptRef.current?.prepared) {
        uncertainAttemptsRef.current.set(targetIdentity(target), attemptRef.current);
        setUncertainAttempt(attemptRef.current);
      }
      throw cause;
    } finally {
      submittingRef.current = false;
    }
  };
  const activeChannels = Object.entries(effectiveSelection.channels)
    .filter(([, checked]) => checked)
    .map(([channel]) => channel);
  const notice =
    target?.pageId !== undefined
      ? undefined
      : activeChannels.length === 1 && activeChannels[0] === 'audio'
        ? t('reachDeck.regeneration.audioOnlyNotice')
        : activeChannels.length === 1 && activeChannels[0] === 'animation'
          ? t('reachDeck.regeneration.animationOnlyNotice')
          : undefined;
  const retryImage = async (pageId: string, assetId: string, imageScope: 'failed' | 'all') => {
    if (submittingRef.current) throw userFacing(t('reachDeck.regeneration.submissionBusy'));
    if (blockedReason) throw userFacing(blockedReason);
    const startingScope = scopeRef.current;
    const retryIdentity = JSON.stringify([startingScope, pageId, assetId, imageScope]);
    const retryKey = imageRetryAttemptsRef.current.get(retryIdentity) ?? createReachDeckUuid();
    imageRetryAttemptsRef.current.set(retryIdentity, retryKey);
    submittingRef.current = true;
    try {
      await prepare(pageId);
      if (scopeRef.current !== startingScope)
        throw userFacing(t('reachDeck.regeneration.contextChanged'));
      const result = await regenerate(
        {
          ...createReachDeckRegenerationSelection(true),
          channels: {
            layout: false,
            image: true,
            narration: false,
            audio: false,
            animation: false,
          },
          imageScope,
          assetIds: [assetId],
        },
        { pageId, idempotencyKey: retryKey },
      );
      imageRetryAttemptsRef.current.delete(retryIdentity);
      try {
        onAccepted?.(result);
      } catch {
        /* 通知失败不改变已持久化的受理结果。 */
      }
    } catch (cause) {
      if (
        cause instanceof ReachDeckApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408
      )
        imageRetryAttemptsRef.current.delete(retryIdentity);
      if (cause instanceof ReachDeckApiError) {
        const message = regenerationErrorMessage(cause, t);
        if (message !== undefined) throw userFacing(message);
      }
      throw cause;
    } finally {
      submittingRef.current = false;
    }
  };
  const selectedPageIds =
    target !== undefined &&
    effectiveSelection.channels.image &&
    document !== undefined &&
    selectionContext !== undefined
      ? new Set(
          selectReachDeckRegenerationPages({
            ...selectionContext,
            document,
            channels: effectiveSelection.channels,
            scope: effectiveSelection.scope,
            ...(target?.pageId === undefined ? {} : { pageId: target.pageId }),
            ...(effectiveSelection.imageScope === undefined
              ? {}
              : { imageScope: effectiveSelection.imageScope }),
          }).accepted.map((page) => page.pageId),
        )
      : undefined;
  const targetSlots = Object.entries(mediaSlotsByPageId)
    .filter(
      ([pageId]) =>
        (target?.pageId === undefined || pageId === target.pageId) &&
        (selectedPageIds === undefined || selectedPageIds.has(pageId)),
    )
    .flatMap(([, slots]) => slots);
  return {
    request,
    retryImage,
    close,
    dialog: (
      <ReachDeckRegenerationDialog
        key={target?.scope + ':' + (target?.pageId ?? 'all') + ':' + String(target !== undefined)}
        open={target !== undefined && target.scope === scopeIdentity && !targetMissing}
        pageTitle={target?.pageId === undefined ? undefined : (target.title ?? '')}
        selection={effectiveSelection}
        imageCount={targetSlots.length}
        failedImageCount={targetSlots.filter((slot) => slot.status === 'failed').length}
        options={getReachDeckRegenerationOptions(
          effectiveSelection,
          target?.pageId === undefined || selectionLocked ? undefined : staticCapabilities,
          target?.pageId === undefined
            ? undefined
            : document?.pages.find((page) => page.pageId === target.pageId)?.sceneType,
        )
          .filter(
            (option) =>
              (selectionLocked ? uncertainAttempt.capabilities : staticCapabilities)?.channels[
                option.channel
              ] !== false || option.channel === 'image',
          )
          .map((option) => ({
            ...option,
            ...(option.channel === 'image' &&
            !selectionLocked &&
            staticCapabilities?.channels.image === false
              ? { disabled: true }
              : {}),
            ...(option.channel === 'layout' && !layoutAllowed && !selectionLocked
              ? { disabled: true }
              : {}),
            description:
              option.channel === 'image' && staticCapabilities?.channels.image === false
                ? t('reachDeck.regeneration.imageUnavailable')
                : option.channel === 'layout' && !layoutAllowed && !selectionLocked
                  ? t('reachDeck.regeneration.layoutContextMissing')
                  : option.descriptionKey === undefined
                    ? undefined
                    : t(option.descriptionKey),
          }))}
        disabledReason={blockedReason}
        selectionLockedReason={
          selectionLocked ? t('reachDeck.regeneration.uncertainSubmission') : undefined
        }
        notice={notice}
        onSelectionChange={change}
        onOpenChange={(open) => {
          if (!open && !submittingRef.current) close();
        }}
        onSubmit={submit}
        returnFocusTarget={returnFocusTarget}
        translate={t}
      />
    ),
  };
}
