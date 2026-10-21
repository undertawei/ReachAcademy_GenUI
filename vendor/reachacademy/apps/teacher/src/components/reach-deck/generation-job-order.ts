/**
 * Timestamped recovery metadata outranks legacy entries without a timestamp. Equal timestamps
 * (including two missing timestamps) preserve the caller's registration-order fallback.
 */
export function isSameOrNewerGenerationJob(
  candidate: { queuedAt?: string },
  previous: { queuedAt?: string },
): boolean {
  if (candidate.queuedAt === undefined) return previous.queuedAt === undefined;
  return previous.queuedAt === undefined || candidate.queuedAt >= previous.queuedAt;
}
