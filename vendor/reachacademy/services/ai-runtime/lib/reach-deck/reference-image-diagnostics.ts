import { ReferenceImageDownloadError } from './reference-image-download.js';

/**
 * Bounded, secret-free trace of one reference-image resolution.
 *
 * Hosts only (never the signed image URL or its query string), truncated titles, and per-candidate
 * reasons, so a failed route can be explained from the worker log or the job failedReason alone.
 */
export const REFERENCE_IMAGE_DIAGNOSTIC_CANDIDATE_LIMIT = 12;
const TITLE_LIMIT = 80;
const ERROR_LIMIT = 120;
const MESSAGE_LIMIT = 1500;

export type ReferenceImageCandidateReason =
  | 'selected'
  | 'no-source-url'
  | 'identity-miss'
  | 'excluded-term'
  | 'origin-rejected'
  | 'download-failed'
  | 'attempt-budget'
  | 'not-reached';

export interface ReferenceImageIdentityGroupDiagnostic {
  /** First alias of the group, truncated; enough to tell which group missed. */
  group: string;
  title: boolean;
  /** null when the candidate has no description text (the description check is then skipped). */
  description: boolean | null;
}

export interface ReferenceImageIdentityDiagnostic {
  matched: boolean;
  groups: ReferenceImageIdentityGroupDiagnostic[];
  excludedTerm?: string;
}

export interface ReferenceImageDownloadDiagnostic {
  outcome: 'ok' | 'failed';
  failure?: string;
  status?: number;
  contentType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  error?: string;
}

export interface ReferenceImageCandidateDiagnostic {
  index: number;
  sourceHost?: string;
  imageHost?: string;
  title: string;
  identity?: ReferenceImageIdentityDiagnostic;
  download?: ReferenceImageDownloadDiagnostic;
  reason: ReferenceImageCandidateReason;
}

/** One search the resolver issued, in order; the planned query is always the first. */
export interface ReferenceImageQueryAttemptDiagnostic {
  query: string;
  resultCount: number;
  outcome: ReferenceImageSearchDiagnostic['outcome'];
}

export interface ReferenceImageSearchDiagnostic {
  /** The planned primary query; `attempts` lists every query actually searched. */
  query: string;
  requiredIdentityGroups: readonly (readonly string[])[];
  excludedTerms: readonly string[];
  provider?: string;
  /** resultCount/candidates describe the latest attempt that returned any result. */
  resultCount: number;
  outcome: 'selected' | 'no-results' | 'no-usable-candidate' | 'timeout';
  candidates: ReferenceImageCandidateDiagnostic[];
  attempts?: ReferenceImageQueryAttemptDiagnostic[];
}

/** Log-safe projection: every candidate collapses into one line so console depth never hides it. */
export interface ReferenceImageDiagnosticSummary {
  query: string;
  provider?: string;
  resultCount: number;
  outcome: ReferenceImageSearchDiagnostic['outcome'];
  candidates: string[];
  attempts?: string[];
}

export const REFERENCE_IMAGE_NO_MATCH_MESSAGE =
  'No usable reference image matched the required identity and download constraints';

export class ReferenceImageResolutionError extends Error {
  readonly headline: string;
  readonly diagnostic: ReferenceImageSearchDiagnostic;

  constructor(headline: string, diagnostic: ReferenceImageSearchDiagnostic, cause?: unknown) {
    super(
      truncate(`${headline}: ${formatReferenceImageDiagnostic(diagnostic)}`, MESSAGE_LIMIT),
      cause === undefined ? undefined : { cause },
    );
    this.name = 'ReferenceImageResolutionError';
    this.headline = headline;
    this.diagnostic = diagnostic;
  }
}

const normalize = (value: string) =>
  value
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const contains = (text: string, value: string) => {
  const term = normalize(value);
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^[a-z0-9]/i.test(term) && /[a-z0-9]$/i.test(term)
    ? new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'u').test(text)
    : text.includes(term);
};

/** Latin identities need token boundaries; CJK names use normalized substring matching. */
export function explainReferenceImageIdentity(
  candidate: { title?: string; description?: string },
  plan: {
    requiredIdentityGroups: readonly (readonly string[])[];
    excludedTerms: readonly string[];
  },
): ReferenceImageIdentityDiagnostic {
  const title = normalize(candidate.title ?? '');
  const description = normalize(candidate.description ?? '');
  const evidence = title + ' ' + description;
  const groups = plan.requiredIdentityGroups.map((group) => ({
    group: truncate(group[0] ?? '', 32),
    title: group.some((alias) => contains(title, alias)),
    // A title may mention the requested subject only to compare it with another object.
    // When supplied, the description must independently identify the same subject.
    description:
      description.length === 0 ? null : group.some((alias) => contains(description, alias)),
  }));
  const excludedTerm = plan.excludedTerms.find((term) => contains(evidence, term));
  return {
    matched:
      groups.every((group) => group.title && group.description !== false) &&
      excludedTerm === undefined,
    groups,
    ...(excludedTerm !== undefined ? { excludedTerm: truncate(excludedTerm, 32) } : {}),
  };
}

export function referenceImageHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host || undefined;
  } catch {
    return 'unparseable-url';
  }
}

export function describeReferenceImageDownloadFailure(
  error: unknown,
): ReferenceImageDownloadDiagnostic {
  if (error instanceof ReferenceImageDownloadError)
    return { outcome: 'failed', failure: error.failure, ...error.detail };
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    outcome: 'failed',
    failure: 'error',
    error: truncate(`${name}: ${message}`, ERROR_LIMIT),
  };
}

export function truncateReferenceImageTitle(value: string | undefined): string {
  return truncate(
    (value ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    TITLE_LIMIT,
  );
}

function formatDownload(download: ReferenceImageDownloadDiagnostic): string {
  const parts = [
    download.failure,
    download.status !== undefined ? `status=${download.status}` : undefined,
    download.contentType !== undefined ? `type=${download.contentType || 'none'}` : undefined,
    download.bytes !== undefined ? `bytes=${download.bytes}` : undefined,
    download.width !== undefined && download.height !== undefined
      ? `${download.width}x${download.height}`
      : undefined,
    download.error,
  ].filter((part): part is string => part !== undefined);
  return `dl=${download.outcome}${parts.length ? `(${parts.join(' ')})` : ''}`;
}

export function formatReferenceImageCandidate(
  candidate: ReferenceImageCandidateDiagnostic,
): string {
  const parts = [
    `#${candidate.index}`,
    `host=${candidate.sourceHost ?? 'none'}`,
    ...(candidate.imageHost && candidate.imageHost !== candidate.sourceHost
      ? [`img=${candidate.imageHost}`]
      : []),
    JSON.stringify(candidate.title),
  ];
  if (candidate.identity) {
    parts.push(
      'ids=' +
        candidate.identity.groups
          .map(
            (group) =>
              `${group.group}:${group.title ? 'T' : 't-miss'}${
                group.description === null ? '' : group.description ? '+D' : '+d-miss'
              }`,
          )
          .join(','),
    );
    if (candidate.identity.excludedTerm) parts.push(`excl=${candidate.identity.excludedTerm}`);
  }
  if (candidate.download) parts.push(formatDownload(candidate.download));
  parts.push(`-> ${candidate.reason}`);
  return parts.join(' ');
}

const formatAttempt = (attempt: ReferenceImageQueryAttemptDiagnostic) =>
  `${JSON.stringify(attempt.query)}:${attempt.resultCount}:${attempt.outcome}`;

export function summarizeReferenceImageDiagnostic(
  diagnostic: ReferenceImageSearchDiagnostic,
): ReferenceImageDiagnosticSummary {
  return {
    query: diagnostic.query,
    ...(diagnostic.provider !== undefined ? { provider: diagnostic.provider } : {}),
    resultCount: diagnostic.resultCount,
    outcome: diagnostic.outcome,
    candidates: diagnostic.candidates.map(formatReferenceImageCandidate),
    ...(diagnostic.attempts !== undefined
      ? { attempts: diagnostic.attempts.map(formatAttempt) }
      : {}),
  };
}

export function formatReferenceImageDiagnostic(diagnostic: ReferenceImageSearchDiagnostic): string {
  const attempts = diagnostic.attempts ?? [];
  return [
    `query=${JSON.stringify(diagnostic.query)} results=${diagnostic.resultCount} outcome=${diagnostic.outcome}` +
      (attempts.length > 1 ? ` attempts=${attempts.map(formatAttempt).join(',')}` : ''),
    ...diagnostic.candidates.map(formatReferenceImageCandidate),
  ].join('; ');
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}
