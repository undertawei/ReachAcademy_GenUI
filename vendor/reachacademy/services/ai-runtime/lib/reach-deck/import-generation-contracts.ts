import { parseReachDeckVoiceSelection, type ReachDeckVoiceSelection } from './voice-selection.js';
import { actorOrganizationIdFromPayload } from './contracts.js';
import { parseReachDeckResourceScope } from './resource-scope.js';
import {
  parseReachDeckWorkspaceBatch,
  sameReachDeckWorkspaceBatchOwner,
  type ReachDeckWorkspaceBatch,
  type ReachDeckWorkspaceBatchOwner,
  type ReachDeckWorkspaceBatchSkippedMember,
} from './workspace-batches.js';

export interface ReachDeckImportGenerationIntent {
  schemaVersion: 'reach-deck-import-generation-intent/v1';
  applicationId: string;
  requestFingerprint: string;
  runId: string;
  owner: ReachDeckWorkspaceBatchOwner;
  voiceSelection: ReachDeckVoiceSelection;
  pageIds: string[];
  batch?: ReachDeckWorkspaceBatch;
  skipped: ReachDeckWorkspaceBatchSkippedMember[];
  registered: boolean;
}

export type ReachDeckImportGenerationIntents = Record<string, ReachDeckImportGenerationIntent>;

const MAX_RECENT_REGISTERED_IMPORT_INTENTS = 10;

/** Accepted batches and append-only import applications retain replay proof after this cache is pruned. */
export function retainReachDeckImportGenerationIntents(
  intents: ReachDeckImportGenerationIntents,
  currentRunId: string,
): ReachDeckImportGenerationIntents {
  const entries = Object.entries(intents);
  const registered = entries
    .filter(([, intent]) => intent.registered)
    .slice(-MAX_RECENT_REGISTERED_IMPORT_INTENTS);
  return Object.fromEntries([
    ...entries.filter(([, intent]) => !intent.registered && intent.runId === currentRunId),
    ...registered,
  ]);
}

function record(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid import generation intent');
  const raw = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(raw, key)) ||
    Object.keys(raw).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('Invalid import generation intent fields');
  return raw;
}

function text(value: unknown, limit = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error('Invalid import generation intent identity');
  return value;
}

export function parseReachDeckImportGenerationIntents(
  value: unknown,
): ReachDeckImportGenerationIntents {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid import generation intents');
  const entries = Object.entries(value);
  return Object.fromEntries(
    entries.map(([applicationId, value]) => {
      const raw = record(
        value,
        [
          'schemaVersion',
          'applicationId',
          'requestFingerprint',
          'runId',
          'owner',
          'voiceSelection',
          'pageIds',
          'skipped',
          'registered',
        ],
        ['batch'],
      );
      if (
        raw.schemaVersion !== 'reach-deck-import-generation-intent/v1' ||
        !/^(pptx|maic)-import-[a-f0-9]{32}$/.test(applicationId) ||
        raw.applicationId !== applicationId ||
        typeof raw.requestFingerprint !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(raw.requestFingerprint) ||
        typeof raw.registered !== 'boolean'
      )
        throw new Error('Invalid import generation intent version or identity');
      const owner = record(
        raw.owner,
        ['actorId', 'billingGroupId', 'roleGrantId', 'resourceScope'],
        ['actorOrganizationId'],
      );
      if (Object.hasOwn(owner, 'actorOrganizationId') && owner.actorOrganizationId == null)
        throw new Error('Invalid import generation intent actor organization');
      if (owner.billingGroupId !== null && typeof owner.billingGroupId !== 'string')
        throw new Error('Invalid import generation intent billing owner');
      const resourceScope = parseReachDeckResourceScope(owner.resourceScope);
      const parsedOwner: ReachDeckWorkspaceBatchOwner = {
        actorId: text(owner.actorId),
        actorOrganizationId: actorOrganizationIdFromPayload({
          actorOrganizationId: owner.actorOrganizationId,
          resourceScope,
        }),
        billingGroupId: owner.billingGroupId === null ? null : text(owner.billingGroupId),
        roleGrantId: text(owner.roleGrantId),
        resourceScope,
      };
      if (!Array.isArray(raw.pageIds) || raw.pageIds.length < 1 || raw.pageIds.length > 1000)
        throw new Error('Invalid import generation intent pages');
      const pageIds = raw.pageIds.map((id) => text(id));
      if (new Set(pageIds).size !== pageIds.length || !Array.isArray(raw.skipped))
        throw new Error('Invalid import generation intent page uniqueness');
      const skipped = raw.skipped.map((entry) => {
        const item = record(entry, ['pageId', 'order', 'reason']);
        if (!Number.isSafeInteger(item.order) || (item.order as number) < 0)
          throw new Error('Invalid import generation skip order');
        return {
          pageId: text(item.pageId),
          order: item.order as number,
          reason: text(item.reason, 128),
        };
      });
      const batch = raw.batch === undefined ? undefined : parseReachDeckWorkspaceBatch(raw.batch);
      const runId = text(raw.runId, 100);
      const voiceSelection = parseReachDeckVoiceSelection(raw.voiceSelection);
      if (
        batch !== undefined &&
        (batch.runId !== runId ||
          batch.kind !== 'narration' ||
          batch.sourceKind !== 'materialized-native' ||
          !sameReachDeckWorkspaceBatchOwner(batch, parsedOwner) ||
          JSON.stringify(batch.voiceSelection) !== JSON.stringify(voiceSelection))
      )
        throw new Error('Import generation batch ownership is invalid');
      const targets = [
        ...(batch?.members.map((member) => member.pageId) ?? []),
        ...skipped.map((item) => item.pageId),
      ];
      if (
        targets.length !== pageIds.length ||
        new Set(targets).size !== targets.length ||
        targets.some((id) => !pageIds.includes(id))
      )
        throw new Error('Import generation target coverage is invalid');
      return [
        applicationId,
        {
          schemaVersion: 'reach-deck-import-generation-intent/v1' as const,
          applicationId,
          requestFingerprint: raw.requestFingerprint,
          runId,
          owner: parsedOwner,
          voiceSelection,
          pageIds,
          skipped,
          registered: raw.registered,
          ...(batch === undefined ? {} : { batch }),
        },
      ];
    }),
  );
}
