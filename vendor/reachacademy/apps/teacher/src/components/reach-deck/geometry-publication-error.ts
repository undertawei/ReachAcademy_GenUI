interface GeometryPublicationErrorCopy {
  key: string;
  replacements?: Record<string, string | number>;
}

export function geometryPublicationErrorCopy(
  error: unknown,
): GeometryPublicationErrorCopy | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;
  const kind = message.split(':', 1)[0];
  switch (kind) {
    case 'geometry_mathematically_invalid': {
      // Only expose a location when the complete bounded diagnostic contract is valid.
      const diagnostic =
        message.length <= 512
          ? /^geometry_mathematically_invalid:page=([1-9][0-9]{0,5});instance=([A-Za-z][A-Za-z0-9_-]{0,63});code=([A-Za-z0-9_-]{1,160});path=([\x20-\x7e]{1,160})$/.exec(
              message,
            )
          : null;
      return diagnostic === null
        ? { key: 'reachDeck.module.geometryInvalid' }
        : {
            key: 'reachDeck.module.geometryInvalidAtPage',
            replacements: { page: Number(diagnostic[1]), instance: diagnostic[2]! },
          };
    }
    case 'geometry_structurally_invalid':
      return { key: 'reachDeck.module.geometryStructureInvalid' };
    case 'geometry_evaluator_unavailable':
      return { key: 'reachDeck.module.geometryUnavailable' };
    case 'geometry_evaluator_saturated':
      return { key: 'reachDeck.module.geometrySaturated' };
    case 'geometry_publication_limit_exceeded':
      return { key: 'reachDeck.module.geometryPublicationLimit' };
    default:
      return undefined;
  }
}
