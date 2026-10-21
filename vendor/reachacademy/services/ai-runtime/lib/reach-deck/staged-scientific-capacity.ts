import type { PageGenerationRequest } from '@reachany/reach-deck-dsl';
import {
  buildScientificGenerationModelInput,
  plannedScientificVisualForRequest,
  resolveScientificGenerationContext,
  type GeneratePagedOutlineRequest,
  type ReachDeckGenerationPipelineOptions,
} from './generation-pipeline.js';
import {
  discoverDecksmithCapacity,
  estimateWithFrozenCapacity,
  deterministicCapacityMeasure,
  countDeterministicCapacityStructure,
} from './decksmith/capacity.js';
import { DecksmithCapacityBlockedError } from './decksmith/agent.js';
import {
  trimScientificContextSnapshot,
  type ScientificContextSnapshot,
} from './scientific-generation-context.js';

export function measureScientificGenerationInput(
  value: ReturnType<typeof buildScientificGenerationModelInput>,
) {
  return deterministicCapacityMeasure(value, countDeterministicCapacityStructure(value));
}

/** Complete optional trimming before callers hash, persist or enqueue a staged input. */
export async function prepareScientificGenerationContext(
  request: GeneratePagedOutlineRequest | PageGenerationRequest,
  options: ReachDeckGenerationPipelineOptions,
): Promise<ScientificContextSnapshot | undefined> {
  let snapshot = resolveScientificGenerationContext(request, options);
  if (snapshot === undefined) return undefined;
  // Slides inject the frozen context only into a planned scientific-visual call.
  if (
    'page' in request &&
    request.page.sceneType === 'slide' &&
    plannedScientificVisualForRequest(request) === undefined
  )
    return snapshot;
  const measure = () =>
    measureScientificGenerationInput(
      buildScientificGenerationModelInput(request, {
        ...options,
        scientificContextSnapshot: snapshot,
      }),
    );
  let currentMeasure = measure();
  const capacity = await discoverDecksmithCapacity({
    stage:
      'page' in request
        ? request.page.sceneType === 'slide'
          ? 'slide'
          : 'interactive'
        : 'paged-outline',
    context: options.context,
    env: options.env,
    fetchImpl: options.fetch ?? options.fetchImpl,
    measure: currentMeasure,
  });
  for (;;) {
    const current = estimateWithFrozenCapacity(capacity, currentMeasure);
    if (current.estimatedInput < current.thresholds.blocked) return snapshot;
    const trimmed = trimScientificContextSnapshot(snapshot);
    if (trimmed === null)
      throw new DecksmithCapacityBlockedError(
        'Scientific generation capacity is unavailable or exceeded.',
      );
    snapshot = trimmed;
    currentMeasure = measure();
  }
}
