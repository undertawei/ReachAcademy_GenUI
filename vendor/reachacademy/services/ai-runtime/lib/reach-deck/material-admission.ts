import {
  REACH_DECK_WORKSPACE_MATERIAL_REFERENCE_LIMIT,
  type MaterialReference,
} from '@reachany/reach-deck-dsl';

import {
  countDeterministicCapacityStructure,
  deterministicCapacityMeasure,
  discoverDecksmithCapacity,
} from './decksmith/capacity.js';
import {
  prepareReachDeckLessonPlanModelInput,
  type GenerateLessonPlanRequest,
  type ReachDeckGenerationPipelineOptions,
} from './generation-pipeline.js';
import {
  buildStructuredJsonModelInput,
  REACH_DECK_STAGE_MAX_OUTPUT_TOKENS,
  type ReachDeckModelEnv,
  type ReachDeckModelRequestContext,
} from './model-service-client.js';

export const REACH_DECK_MATERIAL_DOCUMENT_CHARACTERS = 60_000;
export const REACH_DECK_MATERIAL_SOURCE_CHARACTERS = 95_000;

export class ReachDeckMaterialAdmissionError extends Error {
  readonly status = 422;
  get retryable(): boolean {
    return this.code === 'MATERIAL_CAPACITY_UNAVAILABLE';
  }

  constructor(
    readonly code: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = 'ReachDeckMaterialAdmissionError';
  }
}

export async function assertReachDeckMaterialAdmission(
  input: GenerateLessonPlanRequest & {
    context: ReachDeckModelRequestContext;
    env?: ReachDeckModelEnv;
    fetchImpl?: typeof fetch;
    promptSnippetOverrides?: ReachDeckGenerationPipelineOptions['promptSnippetOverrides'];
  },
) {
  assertReachDeckMaterialSourceShape(input.source, input.materialReferences);
  const referenceCount = input.materialReferences?.length ?? 0;
  const modelInput = buildStructuredJsonModelInput(
    prepareReachDeckLessonPlanModelInput(input, input),
  );
  const measure = deterministicCapacityMeasure(
    modelInput,
    countDeterministicCapacityStructure(modelInput),
  );
  let capacity;
  try {
    capacity = await discoverDecksmithCapacity({
      stage: 'lesson-plan',
      context: input.context,
      measure,
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    });
  } catch {
    throw new ReachDeckMaterialAdmissionError('MATERIAL_CAPACITY_UNAVAILABLE', {});
  }
  if (capacity.provenance.kind !== 'model-service') {
    throw new ReachDeckMaterialAdmissionError('MATERIAL_CAPACITY_UNAVAILABLE', {});
  }
  // Source recurs in later planning/page turns. Keep two thirds of input capacity available
  // for the generated plan/outline, page schemas, and correction turns instead of filling it now.
  const outputReserve = Math.max(
    ...Object.values(REACH_DECK_STAGE_MAX_OUTPUT_TOKENS).filter(
      (value): value is number => value !== undefined,
    ),
  );
  const additionalOutputReserve = Math.max(0, outputReserve - capacity.reservedOutputCapacity);
  const allowedInput = Math.max(
    0,
    Math.floor((capacity.thresholds.blocked - additionalOutputReserve) / 3),
  );
  const report = {
    estimatedInput: capacity.estimatedInput,
    allowedInput,
    sourceCharacters: input.source.length,
    referenceCount,
  };
  if (report.estimatedInput >= allowedInput) {
    throw new ReachDeckMaterialAdmissionError('MATERIAL_CAPACITY_EXCEEDED', report);
  }
  return report;
}

export function assertReachDeckMaterialSourceShape(
  source: string,
  references?: readonly MaterialReference[],
) {
  if (source.length > REACH_DECK_MATERIAL_SOURCE_CHARACTERS) {
    throw new ReachDeckMaterialAdmissionError('MATERIAL_SOURCE_TOO_LONG', {
      actual: source.length,
      limit: REACH_DECK_MATERIAL_SOURCE_CHARACTERS,
    });
  }
  if ((references?.length ?? 0) > REACH_DECK_WORKSPACE_MATERIAL_REFERENCE_LIMIT) {
    throw new ReachDeckMaterialAdmissionError('MATERIAL_REFERENCES_TOO_MANY', {
      actual: references?.length ?? 0,
      limit: REACH_DECK_WORKSPACE_MATERIAL_REFERENCE_LIMIT,
    });
  }
}
