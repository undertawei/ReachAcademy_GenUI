/** Only explicitly localized host errors may replace generic editor failure copy. */
export function userFacingErrorMessage(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || cause.name !== 'ReachDeckUserFacingError') return undefined;
  const message = cause.message.trim();
  return message.length === 0 ? undefined : message;
}
