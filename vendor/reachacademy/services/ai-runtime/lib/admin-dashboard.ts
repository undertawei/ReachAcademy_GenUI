import type { RunRecord, RunStatus, SceneKey } from './contracts.js';
import { isUuid } from './http.js';
import { SCENES } from './scenes.js';

export const ADMIN_DASHBOARD_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
export const ADMIN_DASHBOARD_MAX_PAGE_SIZE = 100;
const MAX_FILTER_VALUES = 100;
const MAX_SCOPE_VALUES = 500;

export interface AdminDashboardDimensionScope {
  platform: boolean;
  organizationIds: string[];
  actorIds: string[];
  projectIds: string[];
  courseIds: string[];
  moduleIds: string[];
}

export interface AdminDashboardFilters {
  scenes: SceneKey[];
  capabilities: string[];
  organizationIds: string[];
  actorIds: string[];
  projectIds: string[];
  courseIds: string[];
  moduleIds: string[];
}

export interface AdminDashboardQuery {
  from: string;
  to: string;
  scope: AdminDashboardDimensionScope;
  filters: AdminDashboardFilters;
  page: number;
  size: number;
}

export interface AdminDashboardRunRow {
  runId: string;
  sceneKey: SceneKey;
  status: RunStatus;
  organizationId: string;
  actorId: string;
  projectId?: string;
  courseId?: string;
  moduleId?: string;
  domainScope: Record<string, string>;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  errorCode?: string;
}

export interface AdminDashboardResolvedDimensions {
  projectId?: string;
  courseId?: string;
  moduleId?: string;
}

export interface AdminDashboardData {
  window: { from: string; to: string };
  summary: {
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    successRate: number | null;
    successRateDenominator: 'completed_and_failed_runs';
    averageDurationMs: number | null;
    averageDurationDenominator: 'finished_runs';
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      runCount: number;
      denominator: 'ai_usage_ledger_entries_for_matching_runs';
    };
  };
  trend: Array<{
    bucketStart: string;
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
  }>;
  breakdowns: {
    scenes: Array<{ sceneKey: SceneKey; runCount: number }>;
    statuses: Array<{ status: RunStatus; runCount: number }>;
    capabilities: Array<{
      capability: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      runCount: number;
      denominator: 'ai_usage_ledger_entries_for_matching_runs';
    }>;
  };
  approvals: Array<{
    approvalId: string;
    runId: string;
    sceneKey: SceneKey;
    decision: 'pending' | 'approved' | 'rejected';
    applyStatus: 'not_requested' | 'applying' | 'applied' | 'failed';
    createdAt: string;
    decidedAt?: string;
  }>;
  approvalsMeta: {
    limit: number;
    total: number;
    truncated: boolean;
  };
  runs: {
    page: number;
    size: number;
    total: number;
    totalPages: number;
    items: AdminDashboardRunRow[];
  };
}

export class AdminDashboardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminDashboardValidationError';
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AdminDashboardValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringArray(
  value: unknown,
  label: string,
  options: { max: number; uuid?: boolean } = { max: MAX_FILTER_VALUES },
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > options.max) {
    throw new AdminDashboardValidationError(`${label} must contain at most ${options.max} values`);
  }
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new AdminDashboardValidationError(`${label} must contain strings`);
    }
    const normalized = raw.trim();
    if (
      normalized.length === 0 ||
      normalized.length > 200 ||
      (options.uuid === true && !isUuid(normalized))
    ) {
      throw new AdminDashboardValidationError(`${label} contains an invalid value`);
    }
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function uuidArray(value: unknown, label: string, max: number): string[] {
  return stringArray(value, label, { max, uuid: true });
}

function dateValue(value: unknown, label: string): Date {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdminDashboardValidationError(`${label} must be an ISO-8601 timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new AdminDashboardValidationError(`${label} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function integerValue(value: unknown, label: string, fallback: number, max: number): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || (resolved as number) < 0 || (resolved as number) > max) {
    throw new AdminDashboardValidationError(`${label} must be an integer from 0 to ${max}`);
  }
  return resolved as number;
}

export function parseAdminDashboardQuery(value: unknown): AdminDashboardQuery {
  const body = objectValue(value, 'request body');
  const from = dateValue(body.from, 'from');
  const to = dateValue(body.to, 'to');
  if (to.getTime() <= from.getTime()) {
    throw new AdminDashboardValidationError('to must be later than from');
  }
  if (to.getTime() - from.getTime() > ADMIN_DASHBOARD_MAX_WINDOW_MS) {
    throw new AdminDashboardValidationError('dashboard window must not exceed 31 days');
  }

  const rawScope = objectValue(body.scope, 'scope');
  if (typeof rawScope.platform !== 'boolean') {
    throw new AdminDashboardValidationError('scope.platform must be a boolean');
  }
  const scope: AdminDashboardDimensionScope = {
    platform: rawScope.platform,
    organizationIds: uuidArray(rawScope.organizationIds, 'scope.organizationIds', MAX_SCOPE_VALUES),
    actorIds: uuidArray(rawScope.actorIds, 'scope.actorIds', MAX_SCOPE_VALUES),
    projectIds: uuidArray(rawScope.projectIds, 'scope.projectIds', MAX_SCOPE_VALUES),
    courseIds: uuidArray(rawScope.courseIds, 'scope.courseIds', MAX_SCOPE_VALUES),
    moduleIds: uuidArray(rawScope.moduleIds, 'scope.moduleIds', MAX_SCOPE_VALUES),
  };
  if (
    !scope.platform &&
    scope.organizationIds.length === 0 &&
    scope.actorIds.length === 0 &&
    scope.projectIds.length === 0 &&
    scope.courseIds.length === 0 &&
    scope.moduleIds.length === 0
  ) {
    throw new AdminDashboardValidationError(
      'non-platform scope must contain at least one authorized dimension',
    );
  }

  const rawFilters = body.filters === undefined ? {} : objectValue(body.filters, 'filters');
  const scenes = stringArray(rawFilters.scenes, 'filters.scenes', { max: MAX_FILTER_VALUES });
  for (const scene of scenes) {
    if (!(scene in SCENES)) {
      throw new AdminDashboardValidationError(`filters.scenes contains unknown Scene ${scene}`);
    }
  }
  const filters: AdminDashboardFilters = {
    scenes: scenes as SceneKey[],
    capabilities: stringArray(rawFilters.capabilities, 'filters.capabilities', {
      max: MAX_FILTER_VALUES,
    }),
    organizationIds: uuidArray(
      rawFilters.organizationIds,
      'filters.organizationIds',
      MAX_FILTER_VALUES,
    ),
    actorIds: uuidArray(rawFilters.actorIds, 'filters.actorIds', MAX_FILTER_VALUES),
    projectIds: uuidArray(rawFilters.projectIds, 'filters.projectIds', MAX_FILTER_VALUES),
    courseIds: uuidArray(rawFilters.courseIds, 'filters.courseIds', MAX_FILTER_VALUES),
    moduleIds: uuidArray(rawFilters.moduleIds, 'filters.moduleIds', MAX_FILTER_VALUES),
  };

  const page = integerValue(body.page, 'page', 0, 10_000);
  const size = integerValue(body.size, 'size', 25, ADMIN_DASHBOARD_MAX_PAGE_SIZE);
  if (size === 0) throw new AdminDashboardValidationError('size must be at least 1');

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    scope,
    filters,
    page,
    size,
  };
}

export function resolveAdminDashboardSceneKeys(query: AdminDashboardQuery): SceneKey[] {
  const requested =
    query.filters.scenes.length > 0
      ? new Set<SceneKey>(query.filters.scenes)
      : new Set<SceneKey>(Object.keys(SCENES) as SceneKey[]);
  if (query.filters.capabilities.length === 0) return [...requested];
  return Object.values(SCENES)
    .filter(
      (scene) =>
        requested.has(scene.key) &&
        query.filters.capabilities.some((capability) => scene.capabilities.includes(capability)),
    )
    .map((scene) => scene.key);
}

function matches(values: readonly string[], value: string | undefined): boolean {
  return values.length === 0 || (value !== undefined && values.includes(value));
}

export function runMatchesAdminDashboardQuery(
  run: RunRecord,
  query: AdminDashboardQuery,
  sceneKeys: readonly SceneKey[] = resolveAdminDashboardSceneKeys(query),
  relatedDimensions: AdminDashboardResolvedDimensions = {},
): boolean {
  const queuedAt = new Date(run.queuedAt).getTime();
  if (
    queuedAt < new Date(query.from).getTime() ||
    queuedAt >= new Date(query.to).getTime() ||
    !sceneKeys.includes(run.sceneKey)
  ) {
    return false;
  }
  const { projectId, courseId, moduleId } = resolveAdminDashboardDimensions(run, relatedDimensions);
  const authorized =
    query.scope.platform ||
    query.scope.organizationIds.includes(run.actor.orgId) ||
    query.scope.actorIds.includes(run.actor.subject) ||
    (projectId !== undefined && query.scope.projectIds.includes(projectId)) ||
    (courseId !== undefined && query.scope.courseIds.includes(courseId)) ||
    (moduleId !== undefined && query.scope.moduleIds.includes(moduleId));
  return (
    authorized &&
    matches(query.filters.organizationIds, run.actor.orgId) &&
    matches(query.filters.actorIds, run.actor.subject) &&
    matches(query.filters.projectIds, projectId) &&
    matches(query.filters.courseIds, courseId) &&
    matches(query.filters.moduleIds, moduleId)
  );
}

/** Direct Runtime scope is authoritative; deterministic relational resolution only fills gaps. */
export function resolveAdminDashboardDimensions(
  run: RunRecord,
  relatedDimensions: AdminDashboardResolvedDimensions = {},
): AdminDashboardResolvedDimensions {
  return {
    ...((run.domainScope.projectId ?? relatedDimensions.projectId)
      ? { projectId: run.domainScope.projectId ?? relatedDimensions.projectId }
      : {}),
    ...((run.domainScope.courseId ?? relatedDimensions.courseId)
      ? { courseId: run.domainScope.courseId ?? relatedDimensions.courseId }
      : {}),
    ...((run.domainScope.moduleId ?? relatedDimensions.moduleId)
      ? { moduleId: run.domainScope.moduleId ?? relatedDimensions.moduleId }
      : {}),
  };
}

export function dashboardRunDurationMs(run: RunRecord): number | undefined {
  if (!run.finishedAt) return undefined;
  const startedAt = run.startedAt ?? run.queuedAt;
  return Math.max(0, new Date(run.finishedAt).getTime() - new Date(startedAt).getTime());
}

export function dashboardRunRow(
  run: RunRecord,
  relatedDimensions: AdminDashboardResolvedDimensions = {},
): AdminDashboardRunRow {
  const durationMs = dashboardRunDurationMs(run);
  const dimensions = resolveAdminDashboardDimensions(run, relatedDimensions);
  return {
    runId: run.id,
    sceneKey: run.sceneKey,
    status: run.status,
    organizationId: run.actor.orgId,
    actorId: run.actor.subject,
    ...dimensions,
    domainScope: structuredClone(run.domainScope),
    queuedAt: run.queuedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(run.error?.code ? { errorCode: run.error.code } : {}),
  };
}

export function adminDashboardTrendBucketSeconds(query: AdminDashboardQuery): number {
  return new Date(query.to).getTime() - new Date(query.from).getTime() <= 48 * 60 * 60 * 1_000
    ? 60 * 60
    : 24 * 60 * 60;
}
