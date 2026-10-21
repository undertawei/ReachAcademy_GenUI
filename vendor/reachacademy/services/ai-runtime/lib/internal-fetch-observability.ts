import { createObservedInternalFetch } from '@reachany/observability/http';

const DEPENDENCIES = {
  'ai.content': 'content-service',
  'ai.student': 'student-service',
  'ai.model.chat': 'model-service',
  'ai.model.media': 'model-service',
  'ai.model.guardrail': 'model-service',
} as const;

/** Only for trusted internal service endpoints. Never pass a storage/provider download URL.
 * Measures transport time through response headers; it does not consume or wrap a response body.
 */
export function runtimeInternalFetch(
  operation: keyof typeof DEPENDENCIES,
  fetchFn: typeof fetch = fetch,
): typeof fetch {
  return createObservedInternalFetch({
    service: 'ai-runtime',
    dependency: DEPENDENCIES[operation],
    operation,
    fetchFn,
  });
}
