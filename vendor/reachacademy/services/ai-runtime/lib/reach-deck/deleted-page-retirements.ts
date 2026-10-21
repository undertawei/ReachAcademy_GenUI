/**
 * 教师删除仍在生成的页面时留下的「待退役」记录。
 *
 * 删除流程先取消被删页的任务、再写文档、最后退役工作区里这些页。文档写入成功而工作区同步
 * 失败时，下一次保存已无法从文档差异推出被删页，被删页会以 narrating 等在途状态一直留在
 * 工作区里，挡住后面的生成进度。取消任务时把这些页记进 recovery，之后任何一次结构同步都会
 * 退役文档里已不存在的记录页，退役后再清掉记录，重试因此可以收尾且幂等。
 */
export const REACH_DECK_DELETED_PAGE_RETIREMENT_SCHEMA_VERSION =
  'reach-deck-deleted-page-retirement/v1' as const;

/** 单份记录最多保留的页数，与一轮生成的页数上限同量级。 */
const MAX_DELETED_PAGE_RETIREMENT_PAGES = 1000;

export interface ReachDeckDeletedPageRetirement {
  schemaVersion: typeof REACH_DECK_DELETED_PAGE_RETIREMENT_SCHEMA_VERSION;
  runId: string;
  /** 已取消生成、待从工作区退役的被删页。 */
  pageIds: string[];
  recordedAt: string;
}

/** 按 runId 归档；只有当前 run 的记录有效，其他 run 的记录在下一次结算时丢弃。 */
export type ReachDeckDeletedPageRetirements = Record<string, ReachDeckDeletedPageRetirement>;

function identity(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new Error('Reach Deck deleted page retirement identity is invalid');
  }
  return value;
}

export function parseReachDeckDeletedPageRetirements(
  value: unknown,
): ReachDeckDeletedPageRetirements {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Reach Deck deleted page retirements are invalid');
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([runId, candidate]) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error('Reach Deck deleted page retirement is invalid');
      }
      const raw = candidate as Record<string, unknown>;
      const keys = ['schemaVersion', 'runId', 'pageIds', 'recordedAt'];
      if (
        keys.some((key) => !Object.hasOwn(raw, key)) ||
        Object.keys(raw).some((key) => !keys.includes(key)) ||
        raw.schemaVersion !== REACH_DECK_DELETED_PAGE_RETIREMENT_SCHEMA_VERSION ||
        raw.runId !== runId ||
        !Array.isArray(raw.pageIds) ||
        raw.pageIds.length < 1 ||
        raw.pageIds.length > MAX_DELETED_PAGE_RETIREMENT_PAGES ||
        typeof raw.recordedAt !== 'string' ||
        Number.isNaN(Date.parse(raw.recordedAt))
      ) {
        throw new Error('Reach Deck deleted page retirement contract is invalid');
      }
      const pageIds = raw.pageIds.map((pageId) => identity(pageId, 256));
      if (new Set(pageIds).size !== pageIds.length) {
        throw new Error('Reach Deck deleted page retirement pages are not unique');
      }
      return [
        runId,
        {
          schemaVersion: REACH_DECK_DELETED_PAGE_RETIREMENT_SCHEMA_VERSION,
          runId: identity(runId, 100),
          pageIds,
          recordedAt: raw.recordedAt,
        },
      ];
    }),
  );
}

/** 把本次删除的在途页并入当前 run 的记录；其他 run 的残留记录一并丢弃。 */
export function recordReachDeckDeletedPageRetirement(
  retirements: ReachDeckDeletedPageRetirements,
  runId: string,
  pageIds: readonly string[],
  recordedAt: string,
): ReachDeckDeletedPageRetirements {
  const existing = retirements[runId];
  const merged = [...new Set([...(existing?.pageIds ?? []), ...pageIds])];
  if (merged.length === 0) return {};
  return {
    [runId]: {
      schemaVersion: REACH_DECK_DELETED_PAGE_RETIREMENT_SCHEMA_VERSION,
      runId,
      pageIds: merged,
      recordedAt: existing?.recordedAt ?? recordedAt,
    },
  };
}

/**
 * 生成链推进成功后结算记录：只从目标 run 的记录里移除已推进的页，其他 run 的记录原样保留。
 * 记录里的页一直保留到这一步：工作区退役成功、推进或结算失败时，下一次保存仍知道欠一次推进。
 * 结算发生在释放文档写锁之后，旧 run 的结算可能迟到，期间新 run 已记下自己的删页，不能误删。
 */
export function settleAdvancedReachDeckDeletedPageRetirements(
  retirements: ReachDeckDeletedPageRetirements,
  runId: string,
  advancedPageIds: ReadonlySet<string>,
): ReachDeckDeletedPageRetirements {
  const existing = retirements[runId];
  if (existing === undefined) return retirements;
  const { [runId]: _settled, ...others } = retirements;
  const pageIds = existing.pageIds.filter((pageId) => !advancedPageIds.has(pageId));
  return pageIds.length === 0 ? others : { ...others, [runId]: { ...existing, pageIds } };
}

/**
 * 结构同步后结算记录：只保留当前 run 里仍留在工作区的页（文档写入失败时被删页还在文档里，
 * 教师重试删除时照常处理），已退役的页与其他 run 的记录都清掉。
 */
export function settleReachDeckDeletedPageRetirements(
  retirements: ReachDeckDeletedPageRetirements,
  runId: string,
  workspacePageIds: ReadonlySet<string>,
): ReachDeckDeletedPageRetirements {
  const existing = retirements[runId];
  const pageIds = existing?.pageIds.filter((pageId) => workspacePageIds.has(pageId)) ?? [];
  if (existing === undefined || pageIds.length === 0) return {};
  return { [runId]: { ...existing, pageIds } };
}
