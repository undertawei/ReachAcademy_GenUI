import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedSceneArtifact } from '@reachany/reach-deck-dsl';
import type {
  ReachDeckCapturedModelPrompt,
  ReachDeckStagedGenerationJobPayload,
} from './contracts.js';
import { isReachDeckHarnessModeEnabled, type ReachDeckHarnessEnvironment } from './harness-mode.js';

export interface HtmlLayoutHarnessEvidence {
  html: string;
  preparedHtml?: string;
  diagnostics?: readonly string[];
  assets?: readonly { assetId: string; objectKey: string }[];
}

export interface HarnessEvidenceScope {
  actorId: string;
  roleGrantId: string;
  resourceScope: ReachDeckStagedGenerationJobPayload['resourceScope'];
}

export interface DeckHarnessGenerationEvidence {
  schemaVersion: 'reach-deck-harness-evidence/v1';
  jobId: string;
  runId: string;
  kind: ReachDeckStagedGenerationJobPayload['kind'];
  pageId?: string;
  updatedAt: string;
  status: 'capturing' | 'completed' | 'failed';
  request: unknown;
  prompts: ReachDeckCapturedModelPrompt[];
  html?: string;
  preparedHtml?: string;
  diagnostics?: readonly string[];
  assets?: readonly { assetId: string; objectKey: string }[];
  artifact?: GeneratedSceneArtifact;
  error?: string;
}

function evidenceRoot(): string {
  // Next rewrites module paths; find the shared checkout only when harness I/O is requested.
  let candidate = process.cwd();
  for (;;) {
    if (existsSync(path.join(candidate, 'pnpm-workspace.yaml')))
      return path.join(candidate, 'tmp/reach-deck-generation-evidence');
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('Harness repository root is unavailable');
    candidate = parent;
  }
}
export const HARNESS_EVIDENCE_MAX_BYTES = 12 * 1024 * 1024;
const MAX_RECORDS = 200;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function directory(scope: HarnessEvidenceScope): string {
  const resource = scope.resourceScope;
  return path.join(
    evidenceRoot(),
    hash(
      JSON.stringify([
        scope.actorId,
        scope.roleGrantId,
        resource.organizationId,
        resource.courseId,
        resource.courseWorkspaceType,
        resource.courseNodeId,
        resource.moduleId,
        resource.moduleVersionId,
      ]),
    ),
  );
}

export async function writeDeckHarnessEvidence(
  scope: HarnessEvidenceScope,
  evidence: DeckHarnessGenerationEvidence,
  env: ReachDeckHarnessEnvironment = process.env,
): Promise<void> {
  if (!isReachDeckHarnessModeEnabled(env)) return;
  const json = JSON.stringify(evidence);
  if (Buffer.byteLength(json) > HARNESS_EVIDENCE_MAX_BYTES)
    throw new Error('Harness evidence exceeds local capture limit');
  const targetDirectory = directory(scope);
  await mkdir(targetDirectory, { recursive: true });
  const target = path.join(targetDirectory, `${hash(evidence.jobId)}.json`);
  await atomicWrite(targetDirectory, target, json);
  const { jobId, runId, kind, pageId, updatedAt, status } = evidence;
  await atomicWrite(
    targetDirectory,
    path.join(targetDirectory, `${hash(evidence.jobId)}.meta.json`),
    JSON.stringify({ jobId, runId, kind, pageId, updatedAt, status }),
  );
}

async function atomicWrite(targetDirectory: string, target: string, json: string): Promise<void> {
  const temporary = path.join(targetDirectory, `${randomUUID()}.partial`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(json);
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readDeckHarnessEvidence(
  scope: HarnessEvidenceScope,
  jobId: string,
  env: ReachDeckHarnessEnvironment = process.env,
): Promise<DeckHarnessGenerationEvidence | undefined> {
  if (!isReachDeckHarnessModeEnabled(env)) return undefined;
  let file;
  try {
    file = await open(path.join(directory(scope), `${hash(jobId)}.json`), 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > HARNESS_EVIDENCE_MAX_BYTES) return undefined;
    const result = JSON.parse(await file.readFile('utf8')) as DeckHarnessGenerationEvidence;
    return result.schemaVersion === 'reach-deck-harness-evidence/v1' && result.jobId === jobId
      ? result
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

export async function listDeckHarnessEvidence(
  scope: HarnessEvidenceScope,
  runId: string,
  env: ReachDeckHarnessEnvironment = process.env,
): Promise<
  Pick<
    DeckHarnessGenerationEvidence,
    'jobId' | 'runId' | 'kind' | 'pageId' | 'updatedAt' | 'status'
  >[]
> {
  if (!isReachDeckHarnessModeEnabled(env)) return [];
  let filenames: string[];
  try {
    filenames = await readdir(directory(scope));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const results = [];
  for (const name of filenames
    .filter((name) => /^[a-f0-9]{64}\.meta\.json$/.test(name))
    .slice(-MAX_RECORDS)) {
    const file = await open(path.join(directory(scope), name), 'r');
    try {
      if ((await file.stat()).size > 4096) continue;
      const record = JSON.parse(await file.readFile('utf8')) as DeckHarnessGenerationEvidence;
      if (record.runId !== runId) continue;
      results.push({
        jobId: record.jobId,
        runId: record.runId,
        kind: record.kind,
        pageId: record.pageId,
        updatedAt: record.updatedAt,
        status: record.status,
      });
    } finally {
      await file.close();
    }
  }
  return results.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}
