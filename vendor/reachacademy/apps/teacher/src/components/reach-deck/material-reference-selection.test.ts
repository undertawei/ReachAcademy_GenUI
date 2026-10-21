import { describe, expect, it } from 'vitest';

import type { MaterialReference } from '@reachany/reach-deck-dsl';

import {
  ReachDeckMaterialTextLimitError,
  selectReachDeckMaterialReferences,
  type ReachDeckMaterialReferenceGroup,
} from './material-reference-selection.js';

function groups(imageCounts: readonly number[]): ReachDeckMaterialReferenceGroup[] {
  return imageCounts.map((count, groupIndex) => ({
    textReference: reference(
      `text-${groupIndex}`,
      'text',
      `${groupIndex}`.repeat(64),
      `file-${groupIndex}.pdf`,
    ),
    images: Array.from({ length: count }, (_, imageIndex) => ({
      assetId: `asset-${groupIndex}-${imageIndex}`,
      reference: reference(
        `image-${groupIndex}-${imageIndex}`,
        'image',
        (groupIndex * 1000 + imageIndex + 10).toString(16).padStart(64, '0'),
        `file-${groupIndex}.pdf`,
        imageIndex + 1,
      ),
    })),
  }));
}

describe('selectReachDeckMaterialReferences', () => {
  it('keeps three text references and fairly selects 61 of 152 images', () => {
    const result = selectReachDeckMaterialReferences(groups([51, 51, 50]));

    expect(result.totalReferenceCount).toBe(155);
    expect(result.selectedReferences).toHaveLength(64);
    expect(result.selectedReferences.slice(0, 3).map((entry) => entry.kind)).toEqual([
      'text',
      'text',
      'text',
    ]);
    expect(result.selectedReferences.filter((entry) => entry.kind === 'image')).toHaveLength(61);
    expect(result.omittedAssetIds).toHaveLength(91);
    expect(result.affectedFileNames).toEqual(['file-0.pdf', 'file-1.pdf', 'file-2.pdf']);
  });

  it('omits duplicate image assets even when capacity remains', () => {
    const input = groups([1, 1]);
    input[1]!.images[0]!.reference.sha256 = input[0]!.images[0]!.reference.sha256;

    const result = selectReachDeckMaterialReferences(input);

    expect(result.selectedReferences).toHaveLength(3);
    expect(result.omittedAssetIds).toEqual(['asset-1-0']);
    expect(result.omittedImageCount).toBe(1);
  });

  it('rejects when text references alone exceed the limit', () => {
    expect(() => selectReachDeckMaterialReferences(groups([0, 0, 0]), 2)).toThrow(
      ReachDeckMaterialTextLimitError,
    );
  });
});

function reference(
  id: string,
  kind: MaterialReference['kind'],
  sha256: string,
  fileName: string,
  page?: number,
): MaterialReference {
  return { id, kind, sha256, fileName, ...(page === undefined ? {} : { page }) };
}
