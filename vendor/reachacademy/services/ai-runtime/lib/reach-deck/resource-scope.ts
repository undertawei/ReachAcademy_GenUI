export const REACH_DECK_DRAFT_WORKSPACE_TYPE = 'draft' as const;

export interface ReachDeckResourceScope {
  readonly organizationId: string;
  readonly courseId: string;
  readonly courseWorkspaceType: typeof REACH_DECK_DRAFT_WORKSPACE_TYPE;
  readonly courseNodeId: string;
  readonly moduleId: string;
  readonly moduleVersionId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseReachDeckResourceScope(value: unknown): ReachDeckResourceScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Reach Deck resourceScope must be an object');
  }
  const scope = value as Record<string, unknown>;
  const expected = [
    'organizationId',
    'courseId',
    'courseWorkspaceType',
    'courseNodeId',
    'moduleId',
    'moduleVersionId',
  ];
  if (
    Object.keys(scope).length !== expected.length ||
    expected.some((field) => !Object.prototype.hasOwnProperty.call(scope, field))
  ) {
    throw new Error('Reach Deck resourceScope must contain the exact UUID identity');
  }
  if (scope.courseWorkspaceType !== REACH_DECK_DRAFT_WORKSPACE_TYPE) {
    throw new Error('Reach Deck courseWorkspaceType must be draft');
  }
  return Object.freeze({
    organizationId: requireUuid(scope.organizationId, 'organizationId'),
    courseId: requireUuid(scope.courseId, 'courseId'),
    courseWorkspaceType: REACH_DECK_DRAFT_WORKSPACE_TYPE,
    courseNodeId: requireUuid(scope.courseNodeId, 'courseNodeId'),
    moduleId: requireUuid(scope.moduleId, 'moduleId'),
    moduleVersionId: requireUuid(scope.moduleVersionId, 'moduleVersionId'),
  });
}

export function sameReachDeckResourceScope(
  left: ReachDeckResourceScope,
  right: ReachDeckResourceScope,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.courseId === right.courseId &&
    left.courseWorkspaceType === right.courseWorkspaceType &&
    left.courseNodeId === right.courseNodeId &&
    left.moduleId === right.moduleId &&
    left.moduleVersionId === right.moduleVersionId
  );
}

export function sameReachDeckPageDomainScope(
  domainScope: Readonly<Record<string, string>>,
  resourceScope: ReachDeckResourceScope,
  pageId: string,
): boolean {
  const expected = {
    organizationId: resourceScope.organizationId,
    courseId: resourceScope.courseId,
    courseNodeId: resourceScope.courseNodeId,
    moduleId: resourceScope.moduleId,
    moduleVersionId: resourceScope.moduleVersionId,
    pageId,
  };
  const keys = Object.keys(expected) as Array<keyof typeof expected>;
  return (
    Object.keys(domainScope).length === keys.length &&
    keys.every((key) => domainScope[key] === expected[key])
  );
}

export function reachDeckResourceScopeQuery(scope: ReachDeckResourceScope): string {
  const query = new URLSearchParams({
    organizationId: scope.organizationId,
    courseWorkspaceType: scope.courseWorkspaceType,
    moduleId: scope.moduleId,
    moduleVersionId: scope.moduleVersionId,
  });
  return query.toString();
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('Reach Deck ' + label + ' must be a UUID');
  }
  return value.toLowerCase();
}
