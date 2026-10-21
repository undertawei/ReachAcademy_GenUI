import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { beginPageGenerationFromOutline, parseGenerationWorkspace } from '../src/index.js';
import { lessonPlan, outline, page } from './generationFixtures.js';

interface MarketplaceCopyFixture {
  targetDraftVersionId: string;
  plannedAt: string;
  expectedDraftDocument: unknown;
  expectedWorkspace: unknown;
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../java/content-service/src/test/resources/coursemarketplace/reach-deck-copy-workspace.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as MarketplaceCopyFixture;
const savedOutline = outline([page('copied-outline-page-1', 1, 'slide')]);

describe('marketplace Reach Deck COPY workspace contract', () => {
  it('matches the Java factory and remains accepted by the strict parser', () => {
    const workspace = parseGenerationWorkspace(fixture.expectedWorkspace);
    expect(workspace).toEqual(fixture.expectedWorkspace);
    expect(workspace.source).toBe('');
    expect(workspace.stage).toBe('copied');
    expect(workspace.baseDocument).toEqual(fixture.expectedDraftDocument);
    expect(workspace.lessonPlan).toBeUndefined();
    expect(workspace.pagedOutline).toBeUndefined();
  });

  it.each([
    {},
    { lessonPlan },
    { pagedOutline: savedOutline },
    { lessonPlan, pagedOutline: savedOutline },
  ])('preserves available saved stages without fabricating execution state: %j', (saved) => {
    const workspace = parseGenerationWorkspace({
      ...(fixture.expectedWorkspace as object),
      source: 'Teach the saved topic',
      ...saved,
    });
    expect(workspace).toMatchObject(saved);
    expect(workspace.order).toEqual([]);
    expect(workspace.targetPageIds).toEqual([]);
    expect(workspace.records).toEqual({});
    expect(workspace.statuses).toEqual({});
    expect(workspace.sceneArtifacts).toEqual({});
  });

  it('normalizes a legacy copy shell on read without modifying the stored object', () => {
    const stored = {
      ...(fixture.expectedWorkspace as object),
      source: 'marketplace-copy',
      stage: 'lesson-plan',
    };
    expect(parseGenerationWorkspace(stored)).toMatchObject({ source: '', stage: 'copied' });
    expect(stored.source).toBe('marketplace-copy');
    expect(stored.stage).toBe('lesson-plan');
  });

  it('keeps copied material inspection bound to the target image references', () => {
    const assetId = '11111111-1111-4111-8111-111111111111';
    const materialSources = {
      schemaVersion: 'reach-deck-material-sources/v1',
      documents: [
        {
          fileName: 'lesson.pdf',
          contentType: 'application/pdf',
          diagnostics: [],
          blocks: [
            { type: 'text', text: 'Saved lesson evidence' },
            { type: 'image', assetId, mimeType: 'image/png' },
          ],
        },
      ],
    };
    const workspace = parseGenerationWorkspace({
      ...(fixture.expectedWorkspace as object),
      materialSources,
      materialReferences: [
        { id: 'image:' + assetId, kind: 'image', fileName: 'lesson.pdf', sha256: 'a'.repeat(64) },
      ],
    });
    expect(workspace.materialSources).toEqual(materialSources);
    expect(() => parseGenerationWorkspace({ ...workspace, materialReferences: [] })).toThrow(
      'material_inspection_invalid',
    );
  });

  it('rejects copied state without its existing document or with invented execution state', () => {
    const { baseDocument: _base, ...withoutBase } = fixture.expectedWorkspace as Record<
      string,
      unknown
    >;
    expect(() => parseGenerationWorkspace({ ...withoutBase, baseRevisions: {} })).toThrow(
      'Copied workspace requires',
    );
    expect(() =>
      parseGenerationWorkspace({
        ...(fixture.expectedWorkspace as object),
        records: { invented: {} },
      }),
    ).toThrow();
  });

  it('can start an explicitly requested new generation from saved stages', () => {
    const workspace = parseGenerationWorkspace({
      ...(fixture.expectedWorkspace as object),
      source: 'Teach the saved topic',
      lessonPlan,
      pagedOutline: savedOutline,
    });
    const generating = beginPageGenerationFromOutline(workspace, savedOutline, fixture.plannedAt);
    expect(parseGenerationWorkspace(generating).stage).toBe('page-generation');
    expect(generating.targetPageIds.length).toBeGreaterThan(0);
    expect(generating.baseDocument).toEqual(workspace.baseDocument);
  });
});
