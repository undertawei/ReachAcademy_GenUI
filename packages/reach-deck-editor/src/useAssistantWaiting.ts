import { useEffect, useMemo, useState } from 'react';

/** Only explicit model/tool activity renews this notice; polling and heartbeats do not. */
export function useAssistantWaiting(
  pageId: string | undefined,
  pending: boolean,
  activity: { readonly updatedAt: number } | undefined,
): boolean {
  const scope = useMemo(() => ({ pageId, pending, activity }), [pageId, pending, activity]);
  const beganAt = useMemo(() => Date.now(), [pageId, pending]);
  const lastActivityAt = activity?.updatedAt ?? beganAt;
  const [waitingScope, setWaitingScope] = useState<typeof scope>();
  useEffect(() => {
    if (!pending || pageId === undefined) return;
    const timer = setTimeout(
      () => setWaitingScope(scope),
      Math.max(0, 10_000 - (Date.now() - lastActivityAt)),
    );
    return () => clearTimeout(timer);
  }, [scope, pageId, pending, lastActivityAt]);
  return pending && (waitingScope === scope || Date.now() - lastActivityAt >= 10_000);
}
