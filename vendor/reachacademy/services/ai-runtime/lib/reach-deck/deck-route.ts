import { ReachDeckAuthorizationError, type ScopedReachDeckRequest } from './auth.js';
import { ContentServiceClientError } from './content-service-client.js';
import {
  ReachDeckLegacyDraftRetiredError,
  ReachDeckRevisionConflictError,
  type ReachDeckContentContext,
} from './deck-store.js';

export function toReachDeckContentContext(
  request: Request,
  scoped: ScopedReachDeckRequest,
): ReachDeckContentContext {
  // Portal 侧对该 header 做了 encodeURIComponent(中文标题无法直接进 HTTP header),这里对应解码;
  // 纯 ASCII 标题编码前后一致,解码失败时按原文兜底,兼容未编码的旧调用方。
  const rawTitle = request.headers.get('x-reachany-module-title')?.trim();
  const title = rawTitle ? decodeModuleTitle(rawTitle) : undefined;
  return {
    actorId: scoped.actorId,
    actorOrganizationId: scoped.actorOrganizationId,
    billingGroupId: scoped.billingGroupId,
    roleGrantId: scoped.roleGrantId,
    resourceScope: scoped.resourceScope,
    ...(title ? { title } : {}),
  };
}

function decodeModuleTitle(rawTitle: string): string {
  try {
    return decodeURIComponent(rawTitle);
  } catch {
    return rawTitle;
  }
}

export function reachDeckRouteError(error: unknown): Response {
  if (error instanceof ReachDeckAuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ReachDeckRevisionConflictError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ReachDeckLegacyDraftRetiredError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ContentServiceClientError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : 'Reach Deck request failed';
  const status =
    message.includes('must') ||
    message.includes('invalid') ||
    message.includes('required') ||
    message.includes('wrong')
      ? 400
      : 500;
  return Response.json({ error: message }, { status });
}

export function readDeckMutation(value: unknown): {
  document?: unknown;
  expectedRevisionToken?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Reach Deck mutation body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (
    body.expectedRevisionToken !== undefined &&
    (typeof body.expectedRevisionToken !== 'string' ||
      body.expectedRevisionToken.trim().length === 0)
  ) {
    throw new Error('expectedRevisionToken must be a non-empty string');
  }
  return {
    ...(body.document === undefined ? {} : { document: body.document }),
    ...(typeof body.expectedRevisionToken === 'string'
      ? { expectedRevisionToken: body.expectedRevisionToken.trim() }
      : {}),
  };
}
