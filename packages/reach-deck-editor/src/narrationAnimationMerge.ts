import {
  collectReachDeckNativeElementIds,
  getReachDeckNativeSlideEffectiveDuration,
  isReachDeckNarrationDrivenAnimation,
  reachDeckPlayableAnimations,
  reachDeckValuesEqual,
  type ReachDeckAnimationV2,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';

/** Keep authored holds unless the missing server duration invalidates an old audio timeline. */
export function mergeReachDeckNativeSlideDuration(input: {
  previous: ReachDeckNativeSlideV2 | undefined;
  server: ReachDeckNativeSlideV2;
  draft: ReachDeckNativeSlideV2;
  animations: ReachDeckAnimationV2[];
}): number | undefined {
  if (input.server.duration !== undefined) return input.server.duration;
  const hasAudioTiming = (slide: ReachDeckNativeSlideV2 | undefined) =>
    slide?.narration?.audioResourceId !== undefined ||
    (slide?.narration?.segments?.length ?? 0) > 0 ||
    slide?.narration?.scientificAnchorBindings !== undefined;
  const removedAudioTiming =
    !hasAudioTiming(input.server) &&
    (hasAudioTiming(input.previous) || hasAudioTiming(input.draft));
  if (!removedAudioTiming) return input.draft.duration;
  const slide = {
    ...input.draft,
    narration: input.server.narration,
    duration: undefined,
    animations: input.animations,
  };
  // The DSL supplies a five-second playback fallback for static pages; it is not stored timing.
  if (
    !reachDeckPlayableAnimations(slide).some(
      (animation) => animation.start + (animation.delay ?? 0) + animation.duration > 0,
    )
  )
    return undefined;
  return getReachDeckNativeSlideEffectiveDuration(slide);
}

/**
 * Generated animations remain editable timeline content. Preserve local deletions and edits,
 * while adopting newly landed animation fields the teacher has not changed. History also passes
 * the current draft so a save acknowledgement does not erase its undo/redo animation states.
 */
export function mergeReachDeckNativeSlideAnimations(input: {
  previous: ReachDeckNativeSlideV2 | undefined;
  server: ReachDeckNativeSlideV2;
  draft: ReachDeckNativeSlideV2;
  acknowledgedDraft?: ReachDeckNativeSlideV2;
}): ReachDeckAnimationV2[] {
  const byId = (slide: ReachDeckNativeSlideV2 | undefined) =>
    new Map(
      (slide?.animations ?? [])
        .filter(isReachDeckNarrationDrivenAnimation)
        .map((animation) => [animation.id, animation]),
    );
  const previous = byId(input.previous);
  const server = byId(input.server);
  const draft = byId(input.draft);
  const acknowledgedDraft = byId(input.acknowledgedDraft);
  const elementIds = collectReachDeckNativeElementIds(input.draft.elements);
  const animations = input.draft.animations.filter(
    (animation) => !isReachDeckNarrationDrivenAnimation(animation),
  );
  for (const id of new Set([...draft.keys(), ...server.keys()])) {
    const animation = mergeAnimationValue(
      previous.get(id),
      server.get(id),
      draft.get(id),
      acknowledgedDraft.get(id),
      input.acknowledgedDraft !== undefined,
    ) as ReachDeckAnimationV2 | undefined;
    if (animation !== undefined && elementIds.has(animation.targetId)) animations.push(animation);
  }
  return animations;
}

function mergeAnimationValue(
  previous: unknown,
  server: unknown,
  draft: unknown,
  acknowledgedDraft: unknown,
  rebasingHistory: boolean,
): unknown {
  // A server echo of a teacher edit updates the durable baseline, not the history entry. Without
  // this distinction, saving a deleted track would erase the earlier state needed to undo it.
  if (rebasingHistory && reachDeckValuesEqual(server, acknowledgedDraft)) return draft;
  if (reachDeckValuesEqual(draft, previous)) return server;
  if (reachDeckValuesEqual(server, previous) || reachDeckValuesEqual(draft, server)) return draft;
  if (isRecord(server) && isRecord(draft)) {
    const base = isRecord(previous) ? previous : {};
    const acknowledged = isRecord(acknowledgedDraft) ? acknowledgedDraft : {};
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(server), ...Object.keys(draft)])) {
      const value = mergeAnimationValue(
        base[key],
        server[key],
        draft[key],
        acknowledged[key],
        rebasingHistory,
      );
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  // An explicit local deletion or timing/effect edit wins a same-field conflict. Other fields
  // still receive new audio timestamps through the recursive merge above.
  return draft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
