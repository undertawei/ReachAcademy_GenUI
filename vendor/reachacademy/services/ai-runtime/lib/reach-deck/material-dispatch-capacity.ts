import {
  countDeterministicCapacityStructure,
  deterministicCapacityMeasure,
  discoverDecksmithCapacity,
} from './decksmith/capacity.js';
import { ReachDeckMaterialAdmissionError } from './material-admission.js';
import {
  REACH_DECK_STAGE_MAX_OUTPUT_TOKENS,
  type ReachDeckFinalizedModelPayload,
  type ReachDeckModelRequestContext,
  type ReachDeckModelEnv,
} from './model-service-client.js';

export async function assertReachDeckMaterialDispatchCapacity(
  payload: ReachDeckFinalizedModelPayload,
  context: ReachDeckModelRequestContext,
  options: { env?: ReachDeckModelEnv; fetchImpl?: typeof fetch } = {},
) {
  const stage = payload.stage;
  if (
    stage !== 'lesson-plan' &&
    stage !== 'paged-outline' &&
    stage !== 'slide' &&
    stage !== 'slide-semantics' &&
    stage !== 'quiz' &&
    stage !== 'interactive' &&
    stage !== 'narration'
  )
    return;
  const measure = deterministicCapacityMeasure(
    payload.modelInput,
    countDeterministicCapacityStructure(payload.modelInput),
  );
  let capacity;
  try {
    capacity = await discoverDecksmithCapacity({ stage, context, measure, ...options });
  } catch {
    throw new ReachDeckMaterialAdmissionError('MATERIAL_CAPACITY_UNAVAILABLE', { stage });
  }
  if (capacity.provenance.kind !== 'model-service')
    throw new ReachDeckMaterialAdmissionError('MATERIAL_CAPACITY_UNAVAILABLE', { stage });
  const extraOutput = Math.max(
    0,
    (REACH_DECK_STAGE_MAX_OUTPUT_TOKENS[stage] ?? 0) - capacity.reservedOutputCapacity,
  );
  const allowedInput = Math.max(0, capacity.thresholds.blocked - extraOutput);
  if (capacity.estimatedInput >= allowedInput)
    throw new ReachDeckMaterialAdmissionError('MATERIAL_CAPACITY_EXCEEDED', {
      stage,
      estimatedInput: capacity.estimatedInput,
      allowedInput,
    });
}
