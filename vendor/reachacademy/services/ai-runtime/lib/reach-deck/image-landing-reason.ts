const RETRY_REASON = /(?:^|;)image-landing-retry:(\d+)(?:;|$)/;
const WAIT_REASON = /(?:^|;)image-waiting-narration:(\d+):(\d+)(?:;|$)/;

/** 重试计数与跳过提示共用既有字段；旧的单独计数仍然可读。 */
export function reachDeckImageLandingAttempts(reason: string | undefined): number {
  const attempt = Number(RETRY_REASON.exec(reason ?? '')?.[1] ?? 0);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
}

/** 清理内部重放状态后恢复前端已有的跳过提示格式。 */
export function clearReachDeckImageLandingAttempt(reason: string | undefined): string | undefined {
  return (
    reason
      ?.split(';')
      .filter((part) => !/^(image-landing-retry:|image-waiting-narration:)/.test(part))
      .join(';') || undefined
  );
}

export function withReachDeckImageLandingAttempt(
  reason: string | undefined,
  attempt: number,
): string {
  const hint = clearReachDeckImageLandingAttempt(reason);
  return `image-landing-retry:${attempt}${hint?.startsWith('image-slots-skipped:') ? `;${hint}` : ''}`;
}

export function withReachDeckImageSkippedSlots(
  reason: string | undefined,
  skipped: number,
): string {
  const hint = `image-slots-skipped:${skipped}`;
  const state = reason
    ?.split(';')
    .filter((part) => /^(image-landing-retry:|image-waiting-narration:)/.test(part));
  return [...(state ?? []), hint].join(';');
}

/** 首次等待时间跨进程保留；末次检查时间用于跳过高频协调 tick。 */
export function reachDeckImageNarrationWait(reason: string | undefined) {
  const match = WAIT_REASON.exec(reason ?? '');
  return match ? { first: Number(match[1]), last: Number(match[2]) } : undefined;
}

export function withReachDeckImageNarrationWait(reason: string | undefined, now: number): string {
  const first = reachDeckImageNarrationWait(reason)?.first ?? now;
  const prior = reason?.split(';').filter((part) => !part.startsWith('image-waiting-narration:'));
  return [...(prior ?? []), `image-waiting-narration:${first}:${now}`].join(';');
}
