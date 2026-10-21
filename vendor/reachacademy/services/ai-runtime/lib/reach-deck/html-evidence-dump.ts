import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HtmlLayoutHarnessEvidence } from './harness-evidence.js';

/** Local diagnosis only: set this to keep each slide's model HTML outside harness mode. */
export const REACH_DECK_HTML_EVIDENCE_DIR_ENV = 'REACH_DECK_HTML_EVIDENCE_DIR';

export function resolveReachDeckHtmlEvidenceDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = env[REACH_DECK_HTML_EVIDENCE_DIR_ENV]?.trim();
  return value ? value : undefined;
}

/** Writes `<page>.<job>.{html,prepared.html,diagnostics.txt}`; failures never affect generation. */
export async function dumpReachDeckHtmlEvidence(
  dir: string,
  identity: { pageId: string; jobId: string },
  evidence: HtmlLayoutHarnessEvidence,
): Promise<void> {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  const base = path.join(dir, `${safe(identity.pageId)}.${safe(identity.jobId)}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(`${base}.html`, evidence.html, 'utf8');
    if (evidence.preparedHtml !== undefined)
      await writeFile(`${base}.prepared.html`, evidence.preparedHtml, 'utf8');
    if (evidence.diagnostics !== undefined)
      await writeFile(`${base}.diagnostics.txt`, evidence.diagnostics.join('\n'), 'utf8');
  } catch {
    console.warn('Reach Deck HTML evidence could not be written locally');
  }
}

/**
 * Keeps the bounded reference-image search/download trace as
 * `<page>.<job>.<asset>.reference-image.json` (one file per planned asset on the page).
 */
export async function dumpReachDeckReferenceImageEvidence(
  identity: { pageId: string; jobId: string; assetId: string },
  diagnostic: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const dir = resolveReachDeckHtmlEvidenceDir(env);
  if (dir === undefined) return;
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  const name = [identity.pageId, identity.jobId, identity.assetId].map(safe).join('.');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${name}.reference-image.json`),
      JSON.stringify(diagnostic, null, 1),
      'utf8',
    );
  } catch {
    console.warn('Reach Deck reference-image evidence could not be written locally');
  }
}

/**
 * Keeps a rejected structured model output and its exact validation message under the same
 * local evidence directory, so contract failures can be diagnosed without re-running the model.
 */
export async function dumpReachDeckRejectedOutput(
  identity: { stage: string; pageId?: string; jobId: string; attempt: number },
  output: { content: string; detail: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const dir = resolveReachDeckHtmlEvidenceDir(env);
  if (dir === undefined) return;
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  const name = [
    identity.pageId ?? identity.stage,
    identity.jobId,
    identity.stage,
    `a${identity.attempt}`,
  ]
    .map(safe)
    .join('.');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${name}.rejected.json`),
      JSON.stringify({ detail: output.detail, content: output.content }, null, 1),
      'utf8',
    );
  } catch {
    console.warn('Reach Deck rejected model output could not be written locally');
  }
}
