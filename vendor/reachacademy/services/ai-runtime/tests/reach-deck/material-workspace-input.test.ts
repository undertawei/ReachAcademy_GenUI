import { createHash } from 'node:crypto';
import { createGenerationWorkspace, type MaterialReference } from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  authorize: vi.fn(),
  create: vi.fn(),
  load: vi.fn(),
  transition: vi.fn(),
  loadPrepared: vi.fn(),
  capacity: vi.fn(),
  admit: vi.fn(),
  bind: vi.fn(),
  authorizeTool: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('@/lib/reach-deck/tool-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/tool-route.js')>()),
  authorizeToolRoute: deps.authorizeTool,
}));
vi.mock('@/lib/reach-deck/material-preparation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/material-preparation.js')>()),
  prepareReachDeckMaterials: deps.prepare,
}));
vi.mock('@/lib/reach-deck/workspace-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-route.js')>()),
  authorizeWorkspaceRoute: deps.authorize,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  createReachDeckWorkspace: deps.create,
  loadReachDeckWorkspace: deps.load,
  transitionReachDeckWorkspaceAtRevision: deps.transition,
}));
vi.mock('@/lib/reach-deck/prepared-material-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/prepared-material-store.js')>()),
  loadPreparedReachDeckMaterials: deps.loadPrepared,
}));
vi.mock('@/lib/reach-deck/decksmith/capacity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: deps.capacity,
}));
vi.mock('@/lib/reach-deck/material-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/material-admission.js')>()),
  assertReachDeckMaterialAdmission: deps.admit,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  resolveReachDeckMaterialAsset: deps.bind,
}));

import { POST as createWorkspace } from '../../app/api/reach-deck/workspace/route.js';
import { POST as updateSource } from '../../app/api/reach-deck/workspace/source/route.js';
import { POST as prepareMaterials } from '../../app/api/reach-deck/tools/material-prepare/route.js';
import { resolveReachDeckWorkspaceMaterialInput } from '../../lib/reach-deck/material-workspace-input.js';
import { materialDigest } from '../../lib/reach-deck/material-parser.js';
import {
  preparedMaterialIdentity,
  findPreparedReachDeckMaterials,
  PREPARED_MATERIAL_TTL_SECONDS,
  storePreparedReachDeckMaterials,
  type PreparedMaterialOptions,
  type PreparedMaterialStore,
  type PreparedReachDeckMaterials,
} from '../../lib/reach-deck/prepared-material-store.js';
import type { AuthorizedWorkspaceRouteContext } from '../../lib/reach-deck/workspace-route.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const scoped: AuthorizedWorkspaceRouteContext = {
  ...TEST_REACH_DECK_SCOPE,
  workspaceContext: TEST_REACH_DECK_SCOPE,
  jobScope: TEST_REACH_DECK_SCOPE,
};
const authorSource = 'Explain energy';
const fullSource = `${authorSource}\n\n--- BEGIN REACH DECK MANAGED SOURCE CONTEXT ---\nComplete managed evidence\n--- END REACH DECK MANAGED SOURCE CONTEXT ---`;
const references: MaterialReference[] = [
  { id: 'text:' + 'a'.repeat(64), kind: 'text', sha256: 'a'.repeat(64), fileName: 'evidence.docx' },
];
const preparationId = 'material-' + 'b'.repeat(64);
let records: Map<string, string>;
let store: PreparedMaterialStore;
function request(body: Record<string, unknown>): Request {
  return new Request('https://test.invalid/api/reach-deck/workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'material-integration' },
    body: JSON.stringify(body),
  });
}
function existingWorkspace(
  generationLanguage: 'follow-system' | 'zh-CN' | 'en-US',
  systemLanguage: 'zh-CN' | 'en-US',
) {
  return createGenerationWorkspace({
    runId: 'existing-run',
    documentId: scoped.resourceScope.moduleVersionId,
    source: 'Previous source',
    generationLanguage,
    systemLanguage,
    webSearch: true,
    materialReferences: references,
    createdAt: '2026-09-30T00:00:00.000Z',
  });
}
function setExistingWorkspaceLanguages(
  generationLanguage: 'follow-system' | 'zh-CN' | 'en-US',
  systemLanguage: 'zh-CN' | 'en-US',
) {
  const workspace = existingWorkspace(generationLanguage, systemLanguage);
  deps.load.mockResolvedValue({ workspace, draftRevision: 3 });
  deps.transition.mockImplementation(async (_context, _revision, transition) => ({
    resource: { workspace: transition(workspace), draftRevision: 4 },
    applied: true,
  }));
}
async function preparation(
  options: PreparedMaterialOptions = { webSearch: false },
  warnings: Array<{ fileName: string; code: string }> = [],
  identity = preparedMaterialIdentity(TEST_REACH_DECK_SCOPE, authorSource, options),
) {
  await storePreparedReachDeckMaterials(
    {
      identity,
      fingerprint: 'fixture-fingerprint',
      source: fullSource,
      sourceDigest: materialDigest(fullSource),
      materialReferences: references,
      options,
      warnings,
      summary: {
        preparationId,
        expiresAt: Date.now() + 3600000,
        fileCount: 1,
        documentCount: 1,
        imageCount: 0,
        sourceCharacters: fullSource.length,
        referenceCount: 1,
        warnings,
        capacity: {
          estimatedInput: 100,
          allowedInput: 1000000,
          sourceCharacters: fullSource.length,
          referenceCount: 1,
        },
      },
    },
    store,
  );
}

// Deliberately reproduce the previous hash format without calling the production identity helper.
function legacyIdentity(source: string, options: PreparedMaterialOptions = { webSearch: false }) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        actorId: TEST_REACH_DECK_SCOPE.actorId,
        billingGroupId: TEST_REACH_DECK_SCOPE.billingGroupId,
        roleGrantId: TEST_REACH_DECK_SCOPE.roleGrantId,
        resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
        brief: source.trim(),
        options,
      }),
    )
    .digest('hex');
}

async function uploadMaterials(source: string) {
  const form = new FormData();
  form.set('source', source);
  form.append(
    'files',
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'evidence.png', {
      type: 'image/png',
    }),
  );
  const response = await prepareMaterials(
    new Request('https://test.invalid/api/reach-deck/tools/material-prepare', {
      method: 'POST',
      body: form,
    }),
  );
  const frames = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(frames.at(-1)).toMatchObject({ type: 'result', status: 200 });
  const record = await findPreparedReachDeckMaterials(frames.at(-1).result.preparationId, store);
  expect(record).toBeDefined();
  return record!;
}

describe('prepared material workspace integration', () => {
  beforeEach(async () => {
    records = new Map();
    store = {
      get: async (key) => records.get(key) ?? null,
      set: vi.fn(async (key, value) => {
        if (records.has(key)) return null;
        records.set(key, value);
        return 'OK';
      }),
    };
    const actual = await vi.importActual<
      typeof import('../../lib/reach-deck/prepared-material-store.js')
    >('../../lib/reach-deck/prepared-material-store.js');
    deps.loadPrepared
      .mockReset()
      .mockImplementation((input) => actual.loadPreparedReachDeckMaterials(input, store));
    deps.authorize.mockReset().mockResolvedValue(scoped);
    deps.authorizeTool.mockReset().mockResolvedValue({
      scoped: TEST_REACH_DECK_SCOPE,
      modelContext: { ...TEST_REACH_DECK_SCOPE, jobId: 'material-test', runId: 'material-test' },
      idempotencyKey: 'material-integration',
    });
    const preparationModule = await vi.importActual<
      typeof import('../../lib/reach-deck/material-preparation.js')
    >('../../lib/reach-deck/material-preparation.js');
    deps.prepare.mockReset().mockImplementation((input) =>
      preparationModule.prepareReachDeckMaterials(input, {
        store,
        parse: async () => ({
          fileName: 'evidence.png',
          contentType: 'image/png',
          sizeBytes: 8,
          markdown: 'Complete managed evidence',
          provider: 'test',
          warnings: [],
        }),
        persist: async (document) => document,
        admit: async (input) => ({
          estimatedInput: 100,
          allowedInput: 1000000,
          sourceCharacters: input.source.length,
          referenceCount: input.materialReferences!.length,
        }),
      }),
    );
    deps.bind.mockReset();
    const workspace = existingWorkspace('zh-CN', 'zh-CN');
    deps.load.mockReset().mockResolvedValue({ workspace, draftRevision: 3 });
    deps.create
      .mockReset()
      .mockImplementation(async (_context, created) => ({ workspace: created, draftRevision: 0 }));
    deps.transition.mockReset().mockImplementation(async (_context, _revision, transition) => ({
      resource: { workspace: transition(workspace), draftRevision: 4 },
      applied: true,
    }));
    deps.capacity.mockReset().mockImplementation(async ({ measure }) => ({
      provenance: { kind: 'model-service' },
      estimatedInput: measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16,
      reservedOutputCapacity: 100000,
      thresholds: { blocked: 10000000 },
    }));
    const admission = await vi.importActual<
      typeof import('../../lib/reach-deck/material-admission.js')
    >('../../lib/reach-deck/material-admission.js');
    deps.admit.mockReset().mockImplementation(admission.assertReachDeckMaterialAdmission);
  });

  it.each(['\n', '\r\n', '\r', '\n\r\n\r'])(
    'accepts multipart-to-JSON requirements with %j line endings without rewriting prepared text',
    async (lineEnding) => {
      const source = `Explain energy${lineEnding}Compare examples${lineEnding}Check understanding`;
      const record = await uploadMaterials(source);
      const uploadedSource = source.replace(/\r\n|\r|\n/g, '\r\n');
      expect(deps.prepare.mock.calls[0]![0].source).toBe(uploadedSource);
      expect(record.source.startsWith(uploadedSource + '\n\n')).toBe(true);
      expect(record.identity).toBe(legacyIdentity(source.replace(/\r\n?/g, '\n')));
      const beforeLoad = [...records.entries()];
      for (const route of [createWorkspace, updateSource]) {
        const response = await route(
          request({
            source,
            materialPreparationId: record.summary.preparationId,
            ...(route === updateSource ? { expectedDraftRevision: 3 } : {}),
          }),
        );
        expect(response.status).toBe(route === createWorkspace ? 201 : 200);
      }
      expect(deps.create.mock.calls[0]![1].source).toBe(record.source);
      const updated = await deps.transition.mock.results[0]!.value;
      expect(updated.resource.workspace.source).toBe(record.source);
      expect([...records.entries()]).toEqual(beforeLoad);
      expect(store.set).toHaveBeenCalledTimes(1);
      expect(store.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'EX',
        PREPARED_MATERIAL_TTL_SECONDS,
        'NX',
      );
    },
  );

  it.each(['\n', '\r\n', '\r'])(
    'loads old %j identity hashes through create/update with equivalent JSON line endings',
    async (legacyLineEnding) => {
      const lines = ['Explain energy', 'Compare examples', 'Check understanding'];
      await preparation({ webSearch: false }, [], legacyIdentity(lines.join(legacyLineEnding)));
      const beforeLoad = [...records.entries()];
      for (const submittedLineEnding of ['\n', '\r\n', '\r']) {
        for (const route of [createWorkspace, updateSource]) {
          const response = await route(
            request({
              source: `  ${lines.join(submittedLineEnding)}  `,
              materialPreparationId: preparationId,
              ...(route === updateSource ? { expectedDraftRevision: 3 } : {}),
            }),
          );
          expect(response.status).toBe(route === createWorkspace ? 201 : 200);
        }
      }
      expect([...records.entries()]).toEqual(beforeLoad);
      expect(store.set).toHaveBeenCalledTimes(1);
    },
  );

  it('retains exact mixed-newline legacy hashes without trying arbitrary newline permutations', async () => {
    const source = 'Explain energy\r\nCompare examples\nCheck understanding';
    await preparation({ webSearch: false }, [], legacyIdentity(source));
    expect(
      (await createWorkspace(request({ source, materialPreparationId: preparationId }))).status,
    ).toBe(201);
    const response = await createWorkspace(
      request({ source: source.replace(/\r\n/g, '\n'), materialPreparationId: preparationId }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'material_preparation_scope_mismatch' });
  });

  it.each(['canonical', 'legacy'])(
    'rejects genuine text/options/scope changes for %s identities before mutation',
    async (kind) => {
      const source = 'Explain energy\nCompare examples';
      const record = await uploadMaterials(source);
      if (kind === 'legacy') {
        for (const [key, raw] of records) {
          const previous = JSON.parse(raw) as PreparedReachDeckMaterials;
          records.set(
            key,
            JSON.stringify({
              ...previous,
              identity: legacyIdentity(source.replace(/\n/g, '\r\n')),
            }),
          );
        }
      }
      const body = { source, materialPreparationId: record.summary.preparationId };
      for (const changes of [
        { source: 'Explain power\nCompare examples' },
        { source: 'Explain  energy\nCompare examples' },
        { source: 'Explain energy Compare examples' },
        { source: 'Explain energy\n\nCompare examples' },
        { source: 'Explain energy\tCompare examples' },
        { webSearch: true },
        { generationLanguage: 'en-US' },
        { systemLanguage: 'en-US' },
      ]) {
        for (const route of [createWorkspace, updateSource]) {
          const response = await route(
            request({
              ...body,
              ...changes,
              ...(route === updateSource ? { expectedDraftRevision: 3 } : {}),
            }),
          );
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({
            code: 'material_preparation_scope_mismatch',
          });
        }
      }
      const otherId = '66666666-6666-4666-8666-666666666666';
      const identities = [
        ...['actorId', 'billingGroupId', 'roleGrantId'].map((field) => ({
          ...scoped.workspaceContext,
          [field]: otherId,
        })),
        ...['organizationId', 'courseId', 'courseNodeId', 'moduleId', 'moduleVersionId'].map(
          (field) => ({
            ...scoped.workspaceContext,
            resourceScope: { ...scoped.resourceScope, [field]: otherId },
          }),
        ),
      ];
      for (const workspaceContext of identities) {
        deps.authorize.mockResolvedValue({ ...scoped, workspaceContext });
        for (const route of [createWorkspace, updateSource]) {
          const response = await route(
            request({ ...body, ...(route === updateSource ? { expectedDraftRevision: 3 } : {}) }),
          );
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({
            code: 'material_preparation_scope_mismatch',
          });
        }
      }
      expect(deps.create).not.toHaveBeenCalled();
      expect(deps.transition).not.toHaveBeenCalled();
      expect(deps.admit).not.toHaveBeenCalled();
    },
  );

  it('does not revive an expired legacy record or bypass its source-integrity check', async () => {
    const source = 'Explain energy\nCompare examples';
    await preparation({ webSearch: false }, [], legacyIdentity(source.replace(/\n/g, '\r\n')));
    const [key, raw] = [...records.entries()][0]!;
    const record = JSON.parse(raw) as PreparedReachDeckMaterials;
    for (const [changed, status, code] of [
      [
        { ...record, summary: { ...record.summary, expiresAt: Date.now() - 1 } },
        410,
        'material_preparation_expired',
      ],
      [{ ...record, source: 'tampered evidence' }, 503, 'material_preparation_store_invalid'],
    ] as const) {
      records.set(key, JSON.stringify(changed));
      for (const route of [createWorkspace, updateSource]) {
        const response = await route(
          request({
            source,
            materialPreparationId: preparationId,
            ...(route === updateSource ? { expectedDraftRevision: 3 } : {}),
          }),
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
      }
    }
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.transition).not.toHaveBeenCalled();
  });

  it('creates and updates with authoritative prepared source/references rather than the submitted brief', async () => {
    await preparation({ webSearch: false, generationLanguage: 'en-US', systemLanguage: 'en-US' });
    const body = {
      source: authorSource,
      materialPreparationId: preparationId,
      generationLanguage: 'en-US',
      systemLanguage: 'en-US',
      webSearch: false,
    };
    expect((await createWorkspace(request(body))).status).toBe(201);
    expect(deps.create.mock.calls[0]![1]).toMatchObject({
      source: fullSource,
      materialReferences: references,
      generationLanguage: 'en-US',
      systemLanguage: 'en-US',
      webSearch: false,
    });
    expect((await updateSource(request({ ...body, expectedDraftRevision: 3 }))).status).toBe(200);
    const result = await deps.transition.mock.results[0]!.value;
    expect(result.resource.workspace).toMatchObject({
      source: fullSource,
      materialReferences: references,
      generationLanguage: 'en-US',
      systemLanguage: 'en-US',
      webSearch: false,
    });
  });
  it('binds prepared image IDs to stable assets and atomically replaces the manifest and inspection blocks', async () => {
    const temporaryId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const stableId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const imageRef = {
      id: `image:${temporaryId}`,
      kind: 'image',
      sha256: 'a'.repeat(64),
      fileName: 'picture.png',
    };
    const snapshot = {
      schemaVersion: 'reach-deck-material-sources/v1',
      documents: [
        {
          fileName: 'picture.png',
          contentType: 'image/png',
          blocks: [{ type: 'image', assetId: temporaryId, mimeType: 'image/png' }],
          diagnostics: [],
        },
      ],
    };
    deps.loadPrepared.mockResolvedValue({
      source: fullSource,
      materialReferences: [imageRef],
      materialSources: snapshot,
    });
    deps.bind.mockResolvedValue({ assetId: stableId, checksumSha256: 'a'.repeat(64) });
    const body = { source: authorSource, materialPreparationId: preparationId };
    expect((await createWorkspace(request(body))).status).toBe(201);
    expect(deps.create.mock.calls[0]![1]).toMatchObject({
      materialReferences: [{ ...imageRef, id: `image:${stableId}` }],
      materialSources: { documents: [{ blocks: [{ assetId: stableId }] }] },
    });
    expect((await updateSource(request({ ...body, expectedDraftRevision: 3 }))).status).toBe(200);
    const result = await deps.transition.mock.results[0]!.value;
    expect(result.resource.workspace.materialSources.documents[0].blocks[0].assetId).toBe(stableId);
    expect(deps.bind).toHaveBeenCalledWith(temporaryId, scoped.workspaceContext);
    deps.bind.mockRejectedValue(new Error('missing temporary asset'));
    deps.create.mockClear();
    deps.transition.mockClear();
    expect((await createWorkspace(request(body))).status).toBe(500);
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.transition).not.toHaveBeenCalled();
  });
  it('binds caller-supplied temporary image IDs to stable assets but leaves existing references alone', async () => {
    const temporaryId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const stableId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const existingId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const imageRef = (id: string): MaterialReference => ({
      id: `image:${id}`,
      kind: 'image',
      sha256: 'c'.repeat(64),
      fileName: 'picture.png',
    });
    deps.bind.mockResolvedValue({ assetId: stableId, checksumSha256: 'c'.repeat(64) });

    expect(
      (
        await createWorkspace(
          request({
            source: fullSource,
            materialReferences: [imageRef(temporaryId), imageRef(temporaryId)],
          }),
        )
      ).status,
    ).toBe(201);
    expect(deps.create.mock.calls[0]![1]).toMatchObject({
      materialReferences: [imageRef(stableId), imageRef(stableId)],
    });
    expect(deps.bind).toHaveBeenCalledTimes(1);
    expect(deps.bind).toHaveBeenCalledWith(temporaryId, scoped.workspaceContext);

    deps.bind.mockClear();
    const resolved = await resolveReachDeckWorkspaceMaterialInput(
      { source: authorSource, materialReferences: [imageRef(existingId), imageRef(temporaryId)] },
      scoped,
      { materialReferences: [imageRef(existingId)] },
    );
    expect(resolved.materialReferences).toEqual([imageRef(existingId), imageRef(stableId)]);
    expect(deps.bind).toHaveBeenCalledTimes(1);
    expect(deps.bind).toHaveBeenCalledWith(temporaryId, scoped.workspaceContext);

    deps.bind.mockClear();
    await resolveReachDeckWorkspaceMaterialInput({ source: authorSource }, scoped, {
      materialReferences: [imageRef(temporaryId)],
    });
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it('clears stale inspection metadata when unprepared source changes and retains it for identical source', async () => {
    const defaults = {
      source: 'previous',
      materialReferences: references,
      materialSources: {
        schemaVersion: 'reach-deck-material-sources/v1' as const,
        documents: [
          {
            fileName: 'source.docx',
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            blocks: [{ type: 'text' as const, text: 'reference text' }],
            diagnostics: [],
          },
        ],
      },
    };
    expect(
      (await resolveReachDeckWorkspaceMaterialInput({ source: 'new source' }, scoped, defaults))
        .materialSources,
    ).toBeUndefined();
    expect(
      (await resolveReachDeckWorkspaceMaterialInput({ source: 'previous' }, scoped, defaults))
        .materialSources,
    ).toEqual(defaults.materialSources);
  });

  it('rejects caller references before any prepared lookup or workspace mutation', async () => {
    await preparation();
    for (const route of [createWorkspace, updateSource]) {
      const response = await route(
        request({
          source: authorSource,
          materialPreparationId: preparationId,
          materialReferences: references,
          ...(route === updateSource ? { expectedDraftRevision: 3 } : {}),
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(deps.loadPrepared).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.transition).not.toHaveBeenCalled();
    expect(deps.capacity).not.toHaveBeenCalled();
  });

  it.each([['expired', 410, 'material_preparation_expired']])(
    'keeps workspace unchanged after %s rejection',
    async (kind, status, code) => {
      for (const route of [createWorkspace, updateSource]) {
        const response = await route(
          request({
            source: authorSource,
            materialPreparationId: preparationId,
            ...(route === updateSource ? { expectedDraftRevision: 3 } : {}),
          }),
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
      }
      expect(deps.create).not.toHaveBeenCalled();
      expect(deps.transition).not.toHaveBeenCalled();
      expect(deps.capacity).not.toHaveBeenCalled();
    },
  );

  it('rejects role/course mismatches before mutation and never resolves another scope through the ID', async () => {
    await preparation();
    for (const authorized of [
      { ...scoped, workspaceContext: { ...scoped.workspaceContext, roleGrantId: 'revoked-grant' } },
      {
        ...scoped,
        workspaceContext: {
          ...scoped.workspaceContext,
          resourceScope: {
            ...scoped.resourceScope,
            courseId: '66666666-6666-4666-8666-666666666666',
          },
        },
      },
    ]) {
      deps.authorize.mockResolvedValue(authorized);
      const response = await createWorkspace(
        request({ source: authorSource, materialPreparationId: preparationId }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'material_preparation_scope_mismatch' });
    }
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.transition).not.toHaveBeenCalled();
  });

  it('allows explicit warning acceptance and does not bind existing workspace defaults into preparation identity', async () => {
    await preparation({ webSearch: false }, [{ fileName: 'source.pptx', code: 'pptx_text_only' }]);
    const resolved = await resolveReachDeckWorkspaceMaterialInput(
      { source: authorSource, materialPreparationId: preparationId, acceptMaterialWarnings: true },
      scoped,
      {
        generationLanguage: 'en-US',
        systemLanguage: 'en-US',
        webSearch: true,
        materialReferences: [],
      },
    );
    expect(resolved).toMatchObject({
      source: fullSource,
      materialReferences: references,
      webSearch: false,
      generationLanguage: 'en-US',
      systemLanguage: 'en-US',
    });
    expect(deps.loadPrepared.mock.calls[0]![0]).toMatchObject({
      generationLanguage: undefined,
      systemLanguage: undefined,
      webSearch: false,
      acceptWarnings: true,
    });
    expect(deps.admit).toHaveBeenCalledWith(
      expect.objectContaining({ generationLanguage: 'en-US', systemLanguage: 'en-US' }),
    );
  });

  it.each([
    ['source', () => ({ source: 'a'.repeat(95001) }), 'MATERIAL_SOURCE_TOO_LONG'],
    [
      'references',
      () => ({
        source: authorSource,
        materialReferences: Array.from({ length: 65 }, (_, index) => ({
          ...references[0]!,
          id: `text:${index}`,
        })),
      }),
      'MATERIAL_REFERENCES_TOO_MANY',
    ],
  ])('blocks excessive legacy %s before create/update', async (_kind, body, code) => {
    for (const route of [createWorkspace, updateSource]) {
      const response = await route(
        request({ ...body(), ...(route === updateSource ? { expectedDraftRevision: 3 } : {}) }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(deps.capacity).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.transition).not.toHaveBeenCalled();
  });

  it('retains effective language/web/reference defaults for legacy source updates', async () => {
    const resolved = await resolveReachDeckWorkspaceMaterialInput(
      { source: authorSource },
      scoped,
      {
        generationLanguage: 'en-US',
        systemLanguage: 'en-US',
        webSearch: true,
        materialReferences: references,
      },
    );
    expect(resolved).toMatchObject({
      source: authorSource,
      generationLanguage: 'en-US',
      systemLanguage: 'en-US',
      webSearch: true,
      materialReferences: references,
    });
    expect(deps.loadPrepared).not.toHaveBeenCalled();
  });
  it.each([
    ['zh-CN', 'zh-CN'],
    ['en-US', 'en-US'],
    ['zh-CN', 'en-US'],
  ] as const)(
    'preserves existing %s/%s languages and admits the effective prepared update when languages are omitted',
    async (generationLanguage, systemLanguage) => {
      setExistingWorkspaceLanguages(generationLanguage, systemLanguage);
      await preparation();
      const response = await updateSource(
        request({
          source: authorSource,
          materialPreparationId: preparationId,
          expectedDraftRevision: 3,
        }),
      );
      expect(response.status).toBe(200);
      const result = await deps.transition.mock.results[0]!.value;
      expect(result.resource.workspace.generationLanguage).toBe(generationLanguage);
      expect(result.resource.workspace.systemLanguage).toBe(systemLanguage);
      expect(result.resource.workspace.webSearch).toBe(false);
      expect(deps.loadPrepared).toHaveBeenCalledWith(
        expect.objectContaining({ generationLanguage: undefined, systemLanguage: undefined }),
      );
      expect(deps.admit).toHaveBeenCalledWith(
        expect.objectContaining({ generationLanguage, systemLanguage, source: fullSource }),
      );
    },
  );
  it('honors a matching explicit prepared language change while retaining the omitted system language', async () => {
    setExistingWorkspaceLanguages('zh-CN', 'zh-CN');
    await preparation({ webSearch: false, generationLanguage: 'en-US' });
    const response = await updateSource(
      request({
        source: authorSource,
        materialPreparationId: preparationId,
        generationLanguage: 'en-US',
        expectedDraftRevision: 3,
      }),
    );
    expect(response.status).toBe(200);
    const result = await deps.transition.mock.results[0]!.value;
    expect(result.resource.workspace).toMatchObject({
      generationLanguage: 'en-US',
      systemLanguage: 'zh-CN',
    });
    expect(deps.loadPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ generationLanguage: 'en-US', systemLanguage: undefined }),
    );
    expect(deps.admit).toHaveBeenCalledWith(
      expect.objectContaining({ generationLanguage: 'en-US', systemLanguage: 'zh-CN' }),
    );
  });
  it.each([{ generationLanguage: 'en-US' }, { systemLanguage: 'en-US' }, { webSearch: true }])(
    'rejects prepared flag changes %j before effective admission or mutation',
    async (changes) => {
      await preparation();
      const response = await updateSource(
        request({
          source: authorSource,
          materialPreparationId: preparationId,
          expectedDraftRevision: 3,
          ...changes,
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'material_preparation_scope_mismatch' });
      expect(deps.admit).not.toHaveBeenCalled();
      expect(deps.transition).not.toHaveBeenCalled();
    },
  );
});
