/** Shared transport classification without a model-client/input-review import cycle. */
export class ModelServiceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelServiceError';
  }
}

export function transportFailure(
  userSignal?: AbortSignal,
  effectiveSignal?: AbortSignal,
): ModelServiceError {
  if (userSignal?.aborted) return new ModelServiceError('model-service request cancelled', false);
  if (effectiveSignal?.aborted)
    return new ModelServiceError('model-service request timed out', true);
  return new ModelServiceError('model-service transport failed', true);
}
