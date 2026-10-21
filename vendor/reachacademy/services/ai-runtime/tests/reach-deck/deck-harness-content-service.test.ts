import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createReachDeckWorkspace,
  findReachDeckGeneratedMedia,
  getReachDeckMaterializedDocument,
  getReachDeckWorkspace,
  materializeReachDeckModule,
  putReachDeckWorkspace,
  putReachDeckWorkspaceRecovery,
  rematerializeReachDeckModule,
  resolveReachDeckVoiceSelection,
  storeReachDeckGeneratedMedia,
  type ContentServiceRequestOptions,
} from '../../lib/reach-deck/content-service-client.js';
import {
  startDeckHarnessContentService,
  type DeckHarnessContentScope,
  type DeckHarnessContentService,
} from '../../scripts/reach-deck/deck-harness-content-service.js';

const scope: DeckHarnessContentScope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
  moduleTitle: '调试模块',
};

let service: DeckHarnessContentService;

/**
 * 这些用例用的是**真实的** content-service 客户端与它全部的响应校验，
 * 只是把地址指向内存替身。客户端能正常往返，就说明替身的契约是对的。
 */
function requestOptions(): ContentServiceRequestOptions {
  return {
    actorId: '77777777-7777-4777-8777-777777777777',
    billingGroupId: null,
    roleGrantId: '99999999-9999-4999-8999-999999999999',
    resourceScope: {
      organizationId: scope.organizationId,
      courseId: scope.courseId,
      courseWorkspaceType: 'draft',
      courseNodeId: scope.courseNodeId,
      moduleId: scope.moduleId,
      moduleVersionId: scope.moduleVersionId,
    },
    env: {
      REACHANY_CONTENT_BASE_URL: service.origin,
      REACHANY_SERVICE_JWT_MODE: 'hs256',
      REACHANY_SERVICE_JWT_SECRET: 'deck-harness-content-secret-at-least-32-bytes',
    },
  };
}

describe('Reach Deck harness in-memory content-service', () => {
  beforeEach(async () => {
    service = await startDeckHarnessContentService({ scope });
  });

  afterEach(async () => {
    await service.close();
  });

  it('creates, reads and compare-and-sets the draft workspace', async () => {
    const created = await createReachDeckWorkspace(
      { runId: 'run-1', source: 'Teacher source' },
      { jobs: {} },
      requestOptions(),
    );
    // AI Runtime 显式要求新建工作区的初始修订为 0。
    expect(created.draftRevision).toBe(0);
    expect(created.moduleVersionId).toBe(scope.moduleVersionId);

    const loaded = await getReachDeckWorkspace(requestOptions());
    expect(loaded.workspace).toEqual({ runId: 'run-1', source: 'Teacher source' });

    const updated = await putReachDeckWorkspace(
      { runId: 'run-1', source: 'Edited source' },
      created.draftRevision,
      requestOptions(),
    );
    expect(updated.draftRevision).toBe(1);
    expect(updated.workspace).toEqual({ runId: 'run-1', source: 'Edited source' });
  });

  it('rejects a stale draft revision the same way the real service does', async () => {
    await createReachDeckWorkspace({ runId: 'run-1' }, {}, requestOptions());
    await putReachDeckWorkspace({ runId: 'run-1' }, 0, requestOptions());

    await expect(putReachDeckWorkspace({ runId: 'run-1' }, 0, requestOptions())).rejects.toThrow(
      'conflict',
    );
  });

  it('tracks the recovery revision separately from the draft revision', async () => {
    await createReachDeckWorkspace({ runId: 'run-1' }, { jobs: {} }, requestOptions());
    const updated = await putReachDeckWorkspaceRecovery({ jobs: { a: 1 } }, 0, requestOptions());

    expect(updated.recoveryRevision).toBe(1);
    expect(updated.draftRevision).toBe(0);
  });

  it('materializes a learner document and reads it back', async () => {
    await createReachDeckWorkspace({ runId: 'run-1' }, {}, requestOptions());
    const before = await getReachDeckMaterializedDocument(requestOptions());
    expect(before.materialized).toBe(false);

    const learnerDocument = { schemaVersion: 'reach-deck-document/v2', slides: [] };
    const materialization = await materializeReachDeckModule(learnerDocument, 0, requestOptions());
    expect(materialization.contentDigest).toHaveLength(64);

    const after = await getReachDeckMaterializedDocument(requestOptions());
    expect(after.materialized).toBe(true);
    if (after.materialized) {
      expect(after.learnerDocument).toEqual(learnerDocument);
      expect(after.contentDigest).toBe(materialization.contentDigest);
    }
  });

  it('rematerializes with the current workspace revision and content digest', async () => {
    await createReachDeckWorkspace({ runId: 'run-1' }, {}, requestOptions());
    const firstDocument = { schemaVersion: 'reach-deck-document/v2', slides: [] };
    const first = await materializeReachDeckModule(firstDocument, 0, requestOptions());
    await putReachDeckWorkspace({ runId: 'run-1', stage: 'complete' }, 0, requestOptions());

    const nextDocument = { schemaVersion: 'reach-deck-document/v2', slides: [{ id: 'slide-1' }] };
    const next = await rematerializeReachDeckModule(
      nextDocument,
      1,
      first.contentDigest,
      requestOptions(),
    );

    expect(next.draftRevision).toBe(1);
    const loaded = await getReachDeckMaterializedDocument(requestOptions());
    expect(loaded.materialized && loaded.learnerDocument).toEqual(nextDocument);
    await expect(
      rematerializeReachDeckModule(firstDocument, 1, first.contentDigest, requestOptions()),
    ).rejects.toThrow('conflict');
    await expect(
      rematerializeReachDeckModule(firstDocument, 0, next.contentDigest, requestOptions()),
    ).rejects.toThrow('conflict');
  });

  it('stores generated image bytes and serves them back at the download url', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const stored = await storeReachDeckGeneratedMedia(
      {
        kind: 'image',
        pageId: 'page-1',
        idempotencyKey: 'image-1',
        contentType: 'image/png',
        bytes,
      },
      requestOptions(),
    );

    expect(stored.sizeBytes).toBe(bytes.byteLength);
    expect(stored.contentType).toBe('image/png');

    const downloaded = await fetch(stored.downloadUrl);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  });

  it('keeps word timestamps attached to stored narration audio', async () => {
    const stored = await storeReachDeckGeneratedMedia(
      {
        kind: 'speech',
        pageId: 'page-1',
        idempotencyKey: 'speech-1',
        contentType: 'audio/mpeg',
        bytes: new Uint8Array([1, 2, 3, 4]),
        speechTimestamps: [{ char: '你', start: 0, end: 0.25 }],
      },
      requestOptions(),
    );

    expect(stored.contentType).toBe('audio/mpeg');
    expect(stored.speechTimestamps).toEqual([{ char: '你', start: 0, end: 0.25 }]);
  });

  it('preserves searched-image origin across store, idempotent replay and lookup', async () => {
    const origin = {
      schemaVersion: 'reach-deck-media-origin/v1' as const,
      route: 'reference-image' as const,
      provider: 'doubao',
      title: '司母戊鼎',
      sourceUrl: 'https://example.org/artifact',
      license: 'unknown',
    };
    const input = {
      kind: 'image' as const,
      pageId: 'page-reference',
      idempotencyKey: 'reference-origin',
      contentType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71]),
      origin,
    };
    const first = await storeReachDeckGeneratedMedia(input, requestOptions());
    const replay = await storeReachDeckGeneratedMedia(input, requestOptions());
    const found = await findReachDeckGeneratedMedia(input, requestOptions());
    expect(first.origin).toEqual(origin);
    expect(replay.origin).toEqual(origin);
    expect(found?.origin).toEqual(origin);
    expect(replay.objectKey).toBe(first.objectKey);
    expect(service.media.size).toBe(1);
    expect(new Uint8Array(await (await fetch(first.downloadUrl)).arrayBuffer())).toEqual(
      input.bytes,
    );
    const alternative = await storeReachDeckGeneratedMedia(
      {
        ...input,
        idempotencyKey: 'distinct-origin',
        origin: { ...origin, title: '另一来源' },
      },
      requestOptions(),
    );
    expect(alternative.objectKey).not.toBe(first.objectKey);
    expect((await findReachDeckGeneratedMedia(input, requestOptions()))?.origin).toEqual(origin);
  });

  it('rejects a signed source URL at the harness storage boundary', async () => {
    const response = await fetch(
      `${service.origin}/api/v1/reach-deck/courses/${scope.courseId}/nodes/${scope.courseNodeId}/generated-media?kind=image`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: 'reach-deck-generated-image/v1',
          contentType: 'image/png',
          imageBase64: 'AQID',
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'reference-image',
            sourceUrl: 'https://example.org/image?signature=secret',
          },
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(service.media.size).toBe(0);
  });

  it('returns the same object for a repeated idempotency key', async () => {
    const input = {
      kind: 'image' as const,
      idempotencyKey: 'stable-key',
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    };
    const first = await storeReachDeckGeneratedMedia(input, requestOptions());
    const second = await storeReachDeckGeneratedMedia(input, requestOptions());

    expect(second.objectKey).toBe(first.objectKey);
    expect(service.media.size).toBe(1);
  });

  it('resolves the default voice so narration needs no clone authorization', async () => {
    const selection = await resolveReachDeckVoiceSelection(requestOptions());
    expect(selection.kind).toBe('default');
  });

  it('serves exactly one debug course', async () => {
    const options = requestOptions();
    const foreign: ContentServiceRequestOptions = {
      ...options,
      resourceScope: {
        ...options.resourceScope,
        courseId: '66666666-6666-4666-8666-666666666666',
      },
    };

    await expect(getReachDeckWorkspace(foreign)).rejects.toThrow('single debug course');
  });
});

describe('generated media lookup before regeneration', () => {
  beforeEach(async () => {
    service = await startDeckHarnessContentService({ scope });
  });
  afterEach(async () => {
    await service.close();
  });

  it('reports nothing for an unknown idempotency key', async () => {
    const found = await findReachDeckGeneratedMedia(
      { kind: 'speech', idempotencyKey: 'never-stored' },
      requestOptions(),
    );

    expect(found).toBeUndefined();
  });

  it('finds media previously stored under the same idempotency key', async () => {
    const stored = await storeReachDeckGeneratedMedia(
      {
        kind: 'speech',
        pageId: 'page-1',
        idempotencyKey: 'narration-page-1',
        contentType: 'audio/mpeg',
        bytes: new Uint8Array([9, 8, 7]),
        speechTimestamps: [{ char: '惯', start: 0, end: 0.3 }],
      },
      requestOptions(),
    );

    const found = await findReachDeckGeneratedMedia(
      { kind: 'speech', pageId: 'page-1', idempotencyKey: 'narration-page-1' },
      requestOptions(),
    );

    expect(found?.objectKey).toBe(stored.objectKey);
    expect(found?.speechTimestamps).toEqual([{ char: '惯', start: 0, end: 0.3 }]);
  });
});
