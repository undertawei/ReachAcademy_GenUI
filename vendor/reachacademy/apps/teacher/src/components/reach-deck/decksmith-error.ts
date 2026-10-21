import { ReachDeckApiError } from '@reachany/reach-deck-client';

export function decksmithFailureCopy(
  error: unknown,
  phase: 'save' | 'start' | 'observe',
): { key: string } | undefined {
  const uncertain = { key: `reachDeck.decksmith.error.${phase}Unconfirmed` };
  if (
    error instanceof TypeError &&
    /^(Failed to fetch|fetch failed|NetworkError(?: when attempting to fetch resource\.?)?|Load failed)$/i.test(
      error.message,
    )
  ) {
    return uncertain;
  }
  if (!(error instanceof ReachDeckApiError)) return undefined;

  if (error.kind === 'revision_conflict') {
    // The observer also uses 409 for cancellation; only its status read can disambiguate.
    return {
      key:
        phase === 'observe'
          ? 'reachDeck.decksmith.error.requestFailed'
          : 'reachDeck.decksmith.error.revisionConflict',
    };
  }
  const keyByKind: Partial<Record<ReachDeckApiError['kind'], string>> = {
    authorization: 'reachDeck.workspace.error.authorization',
    not_found: 'reachDeck.workspace.error.notFound',
    page_locked: 'reachDeck.workspace.error.pageLocked',
    conflict: 'reachDeck.workspace.error.busyConflict',
  };
  const key = keyByKind[error.kind];
  if (key !== undefined) return { key };
  if (error.status >= 500 || error.kind === 'dependency_unavailable') return uncertain;
  if (phase === 'save' && error.status === 400) {
    return { key: 'reachDeck.module.saveRejectedDetail' };
  }
  if (error.status >= 400) return { key: 'reachDeck.decksmith.error.requestFailed' };
  return undefined;
}
