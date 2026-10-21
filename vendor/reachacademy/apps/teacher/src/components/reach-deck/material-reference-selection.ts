import {
  REACH_DECK_WORKSPACE_MATERIAL_REFERENCE_LIMIT,
  type MaterialReference,
} from '@reachany/reach-deck-dsl';

export interface ReachDeckMaterialImageCandidate {
  reference: MaterialReference;
  assetId?: string;
}

export interface ReachDeckMaterialReferenceGroup {
  textReference: MaterialReference;
  images: readonly ReachDeckMaterialImageCandidate[];
}

export interface ReachDeckMaterialSelection {
  selectedReferences: readonly MaterialReference[];
  omittedAssetIds: readonly string[];
  totalReferenceCount: number;
  omittedImageCount: number;
  affectedFileNames: readonly string[];
}

export class ReachDeckMaterialTextLimitError extends Error {
  constructor(readonly textReferenceCount: number) {
    super('Text material references exceed the workspace limit.');
    this.name = 'ReachDeckMaterialTextLimitError';
  }
}

/** Text is authoritative; image capacity is shared fairly between PDFs after SHA-256 deduplication. */
export function selectReachDeckMaterialReferences(
  groups: readonly ReachDeckMaterialReferenceGroup[],
  limit = REACH_DECK_WORKSPACE_MATERIAL_REFERENCE_LIMIT,
): ReachDeckMaterialSelection {
  const textReferences = groups.map((group) => group.textReference);
  if (textReferences.length > limit)
    throw new ReachDeckMaterialTextLimitError(textReferences.length);

  const omittedAssetIds = new Set<string>();
  const omittedFileNames = new Set<string>();
  const seenHashes = new Set<string>();
  let omittedImageCount = 0;
  const queues = groups.map((group) =>
    group.images
      .map((image, order) => ({ image, order }))
      .sort(
        (left, right) =>
          (left.image.reference.page ?? Number.MAX_SAFE_INTEGER) -
            (right.image.reference.page ?? Number.MAX_SAFE_INTEGER) || left.order - right.order,
      )
      .flatMap(({ image }) => {
        if (seenHashes.has(image.reference.sha256)) {
          omittedImageCount += 1;
          omittedFileNames.add(image.reference.fileName);
          if (image.assetId !== undefined) omittedAssetIds.add(image.assetId);
          return [];
        }
        seenHashes.add(image.reference.sha256);
        return [image];
      }),
  );

  const selectedImages: ReachDeckMaterialImageCandidate[] = [];
  const imageCapacity = limit - textReferences.length;
  let cursor = 0;
  while (selectedImages.length < imageCapacity && queues.some((queue) => cursor < queue.length)) {
    for (const queue of queues) {
      const candidate = queue[cursor];
      if (candidate !== undefined && selectedImages.length < imageCapacity) {
        selectedImages.push(candidate);
      }
    }
    cursor += 1;
  }

  const selectedIds = new Set(selectedImages.map((image) => image.reference.id));
  for (const queue of queues) {
    for (const image of queue) {
      if (selectedIds.has(image.reference.id)) continue;
      omittedImageCount += 1;
      omittedFileNames.add(image.reference.fileName);
      if (image.assetId !== undefined) omittedAssetIds.add(image.assetId);
    }
  }

  return {
    selectedReferences: [...textReferences, ...selectedImages.map((image) => image.reference)],
    omittedAssetIds: [...omittedAssetIds],
    totalReferenceCount:
      textReferences.length + groups.reduce((sum, group) => sum + group.images.length, 0),
    omittedImageCount,
    affectedFileNames: [...omittedFileNames],
  };
}
