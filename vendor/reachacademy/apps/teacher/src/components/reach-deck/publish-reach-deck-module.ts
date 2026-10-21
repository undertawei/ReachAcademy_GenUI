import type {
  ReachDeckClient,
  ReachDeckModuleContext,
  ReachDeckModulePublicationResource,
} from '@reachany/reach-deck-client';

export async function publishReachDeckModule<TDocument>(
  client: Pick<ReachDeckClient, 'publishModule'>,
  context: ReachDeckModuleContext,
  save: (document: TDocument) => Promise<{ draftRevision: number; contentDigest: string }>,
  document: TDocument,
): Promise<ReachDeckModulePublicationResource> {
  const materialization = await save(document);
  return client.publishModule(context, {
    expectedDraftRevision: materialization.draftRevision,
    expectedContentDigest: materialization.contentDigest,
  });
}
