import { createHash } from 'node:crypto';

import type { ReachDeckModelRequestContext } from './model-service-client.js';
import { ReachDeckModelToolError } from './model-service-tools.js';
import {
  authorizeWorkspaceRoute,
  badRequest,
  type AuthorizedWorkspaceRouteContext,
  workspaceRouteError,
} from './workspace-route.js';

export async function authorizeToolRoute(request: Request): Promise<{
  scoped: AuthorizedWorkspaceRouteContext;
  modelContext: ReachDeckModelRequestContext;
  idempotencyKey: string;
}> {
  const scoped = await authorizeWorkspaceRoute(request);
  const idempotencyKey = request.headers.get('idempotency-key')?.trim();
  if (!idempotencyKey) throw badRequest('Idempotency-Key is required');
  const correlation = createHash('sha256')
    .update([scoped.actorId, scoped.resourceScope.moduleVersionId, idempotencyKey].join('\n'))
    .digest('hex')
    .slice(0, 24);
  return {
    scoped,
    idempotencyKey,
    modelContext: {
      actorId: scoped.actorId,
      billingGroupId: scoped.billingGroupId,
      resourceScope: scoped.resourceScope,
      jobId: 'source-' + correlation,
      runId: 'source-' + correlation,
    },
  };
}

export function toolRouteError(error: unknown): Response {
  if (error instanceof ReachDeckModelToolError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return Response.json({ error: error.message }, { status });
  }
  return workspaceRouteError(error);
}
