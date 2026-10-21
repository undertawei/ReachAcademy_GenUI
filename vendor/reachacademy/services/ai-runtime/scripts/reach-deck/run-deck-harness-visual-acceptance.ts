/** Bounded real four-stage acceptance. Calls are billable; never reruns a failed generation. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PageOutline } from '@reachany/reach-deck-dsl';
import {
  ReachDeckClient,
  type ReachDeckGenerationJobResult,
  type ReachDeckModuleContext,
  type ReachDeckWorkspaceJobMetadata,
} from '@reachany/reach-deck-client';
import {
  resolveDeckHarnessAiRuntimeUrl,
  resolveDeckHarnessOutputDirectory,
} from './deck-harness.js';
import { FOUR_ROUTE_TEACHING_SAMPLE, plannedRouteSummaries } from './deck-harness-visuals.js';

const requiredRoutes = ['reference-image', 'diagram', 'scientific-visual', 'image'];
const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.includes('--help')) {
  console.log(
    'tsx scripts/reach-deck/run-deck-harness-visual-acceptance.ts --origin http://127.0.0.1:16200 --output-dir tmp/deck-visual-acceptance [--plan-only] [--resume tmp/deck-visual-acceptance/state.json] [--exclude-reference-image]\nCreates one lesson plan and one outline; --plan-only stops before paid page generation. --resume continues exact saved workspace/job identities without repeating planning. --exclude-reference-image adopts only other pages and reports partial coverage. A later resume without that flag starts only remaining pending pages. No automatic retries.',
  );
} else {
  await main();
}

async function main() {
  for (let index = 0; index < args.length; index += 1) {
    if (['--plan-only', '--exclude-reference-image'].includes(args[index]!)) continue;
    if (!['--origin', '--output-dir', '--resume'].includes(args[index]!) || !args[++index])
      throw new Error('Unknown or missing argument.');
  }
  const option = (key: string, fallback: string) =>
    args.indexOf(key) < 0 ? fallback : args[args.indexOf(key) + 1]!;
  const origin = resolveDeckHarnessAiRuntimeUrl(option('--origin', 'http://127.0.0.1:16200'));
  const output = resolveDeckHarnessOutputDirectory(
    option('--output-dir', `tmp/deck-visual-acceptance-${Date.now()}`),
  );
  await mkdir(output, { recursive: true });
  const save = (name: string, value: unknown) =>
    writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
  const request: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('origin', origin);
    return fetch(typeof input === 'string' ? new URL(input, origin) : input, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
  };
  const configResponse = await request(`${origin}/harness/config`);
  if (!configResponse.ok) throw new Error('Workbench config unavailable');
  const config = (await configResponse.json()) as {
    moduleContext: ReachDeckModuleContext;
    harnessModeEnabled: boolean;
    slidesOnly?: boolean;
    htmlLayoutOnly?: boolean;
  };
  if (!config.harnessModeEnabled || config.slidesOnly || config.htmlLayoutOnly) {
    throw new Error(
      'Full four-stage harness mode is required, including narration; no generation was started.',
    );
  }
  const client = new ReachDeckClient({ fetch: request });
  const context = config.moduleContext;
  type State = {
    origin: string;
    moduleVersionId: string;
    runId: string;
    lessonJob?: ReachDeckWorkspaceJobMetadata;
    lessonApplied?: boolean;
    outlineJob?: ReachDeckWorkspaceJobMetadata;
    outlineApplied?: boolean;
    targetPageIds?: string[];
    pageJobs?: Record<string, ReachDeckWorkspaceJobMetadata>;
    deferredReferencePage?: PageOutline;
    manualRepresentationEdit?: { pageId: string; from: 'svg'; to: 'html'; reason: string };
  };
  const resumeFile = args.includes('--resume')
    ? resolveDeckHarnessOutputDirectory(option('--resume', ''))
    : undefined;
  let state: State | undefined = resumeFile
    ? (JSON.parse(await readFile(resumeFile, 'utf8')) as State)
    : undefined;
  if (
    state &&
    (state.origin !== origin || state.moduleVersionId !== context.moduleVersionId || !state.runId)
  )
    throw new Error('Saved state belongs to a different workbench or module');
  const saveState = () => save('state.json', state);
  let runId: string | undefined;
  const deadline = Date.now() + 30 * 60_000;
  const assertDeadline = () => {
    if (Date.now() > deadline)
      throw new Error(
        'Acceptance deadline exceeded; inspect remaining jobs before any new generation.',
      );
  };
  const waitJob = async (
    metadata: ReachDeckWorkspaceJobMetadata,
  ): Promise<ReachDeckGenerationJobResult> => {
    for (;;) {
      assertDeadline();
      const job = await client.pollGeneration(context, metadata.pollPath);
      if (job.status === 'failed') throw new Error(`Job ${metadata.jobId} failed: ${job.error}`);
      if (job.status === 'completed' || job.done) {
        const result = job.result ?? (await client.loadGenerationResult(context, metadata.jobId));
        await save(`${metadata.jobId}.json`, result);
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };
  try {
    // The normal creation contract rejects a populated module; this runner never clears one.
    let workspace = state
      ? await client.loadWorkspace(context)
      : await client.createWorkspace(context, {
          source: FOUR_ROUTE_TEACHING_SAMPLE,
          idempotencyKey: randomUUID(),
        });
    if (state && workspace.workspace.runId !== state.runId)
      throw new Error('Saved run no longer matches the workbench workspace');
    runId = workspace.workspace.runId;
    state ??= { origin, moduleVersionId: context.moduleVersionId, runId };
    await saveState();
    await save('source.json', { source: FOUR_ROUTE_TEACHING_SAMPLE, runId });
    const lesson =
      state.lessonJob ??
      (await client.startLessonPlan(context, {
        expectedDraftRevision: workspace.draftRevision,
      }));
    state.lessonJob = lesson;
    await saveState();
    await waitJob(lesson);
    workspace = await client.loadWorkspace(context);
    if (!state.lessonApplied) {
      await client.applyLessonPlan(context, {
        expectedDraftRevision: workspace.draftRevision,
        jobId: lesson.jobId,
      });
      state.lessonApplied = true;
      await saveState();
    }
    workspace = await client.loadWorkspace(context);
    const outline =
      state.outlineJob ??
      (await client.startPageOutline(context, {
        expectedDraftRevision: workspace.draftRevision,
        enabledSceneTypes: ['slide'],
      }));
    state.outlineJob = outline;
    await saveState();
    const result = await waitJob(outline);
    if (!('kind' in result) || result.kind !== 'page-outline')
      throw new Error('Expected page outline result');
    const pages = result.candidate.pages;
    const routes = new Set(pages.flatMap(plannedRouteSummaries).map((entry) => entry.route));
    await save(
      'planned-routes.json',
      pages.map((page) => ({
        pageId: page.id,
        title: page.title,
        routes: plannedRouteSummaries(page),
      })),
    );
    if (pages.length > 5 || !requiredRoutes.every((route) => routes.has(route))) {
      throw new Error(
        `Outline not accepted: ${pages.length} pages, routes ${[...routes].join(', ')}. No page generation started.`,
      );
    }
    if (args.includes('--plan-only')) {
      await save('report.json', {
        status: 'planning-passed',
        plannedRoutes: [...routes],
        runId,
        pages: pages.length,
        outlineApplied: state.outlineApplied ?? false,
        pageGeneration: 'not started',
      });
      console.log(
        `Planning passed; no page generation started. Resume with --resume ${path.join(output, 'state.json')}.`,
      );
      return;
    }
    workspace = await client.loadWorkspace(context);
    let selectedPages = args.includes('--exclude-reference-image')
      ? pages.filter(
          (page) => !plannedRouteSummaries(page).some((asset) => asset.route === 'reference-image'),
        )
      : pages;
    if (args.includes('--exclude-reference-image')) {
      state.deferredReferencePage = pages.find((page) =>
        plannedRouteSummaries(page).some((asset) => asset.route === 'reference-image'),
      );
      const waterPage = selectedPages.find(
        (page) =>
          /水/.test(page.title) &&
          page.instructionalSpec?.visualAssets.some(
            (asset) => asset.kind === 'diagram' && asset.representation === 'svg',
          ),
      );
      if (!waterPage)
        throw new Error(
          'Cannot locate the intended SVG water-cycle page for the authorized HTML edit',
        );
      state.manualRepresentationEdit = {
        pageId: waterPage.id,
        from: 'svg',
        to: 'html',
        reason: 'Authorized acceptance edit to cover HTML rendering; original model selected SVG.',
      };
      selectedPages = selectedPages.map((page, index) => ({
        ...page,
        order: index + 1,
        ...(page.id === waterPage.id && page.instructionalSpec
          ? {
              instructionalSpec: {
                ...page.instructionalSpec,
                visualAssets: page.instructionalSpec.visualAssets.map((asset) =>
                  asset.kind === 'diagram' && asset.representation === 'svg'
                    ? { ...asset, representation: 'html' as const }
                    : asset,
                ),
              },
            }
          : {}),
      }));
      await save('selected-outline.json', { ...result.candidate, pages: selectedPages });
      await saveState();
    }
    if (selectedPages.length === 0) throw new Error('No pages selected for generation');
    const selectedIds = selectedPages.map((page) => page.id);
    const selectedRoutes = new Set(
      selectedPages.flatMap(plannedRouteSummaries).map((asset) => asset.route),
    );
    // A previous apply response can be lost; authoritative adopted outline prevents a second apply.
    if (!state.outlineApplied && workspace.workspace.pagedOutline?.id === result.candidate.id) {
      state.outlineApplied = true;
      state.targetPageIds = workspace.workspace.targetPageIds;
      await saveState();
    }
    if (!state.outlineApplied) {
      if (selectedPages.length !== pages.length) {
        await client.adoptPageOutline(context, {
          expectedDraftRevision: workspace.draftRevision,
          jobId: outline.jobId,
          outline: { ...result.candidate, pages: selectedPages },
        });
      } else {
        await client.applyPageOutline(context, {
          expectedDraftRevision: workspace.draftRevision,
          jobId: outline.jobId,
          targetPageIds: selectedIds,
        });
      }
      state.outlineApplied = true;
      state.targetPageIds = selectedIds;
      await saveState();
    } else {
      if (
        state.deferredReferencePage &&
        !args.includes('--exclude-reference-image') &&
        !workspace.workspace.records[state.deferredReferencePage.id]
      ) {
        throw new Error(
          'The deferred page must be added through the normal outline-edit flow. This runner will not silently regenerate completed pages.',
        );
      }
      // Normal single-page entry can fill later pending pages; failed pages require separate diagnosis.
      for (const page of selectedPages.filter((page) => !state!.targetPageIds?.includes(page.id))) {
        workspace = await client.loadWorkspace(context);
        const current = workspace.workspace.statuses[page.id];
        if (current && ['failed', 'manual-review-required'].includes(current.state))
          throw new Error(`Page ${page.id} failed previously; automatic retry is forbidden`);
        if (!current || current.state === 'pending') {
          state.pageJobs ??= {};
          const job =
            state.pageJobs[page.id] ??
            (await client.startPageGeneration(context, page.id, {
              expectedDraftRevision: workspace.draftRevision,
            }));
          state.pageJobs[page.id] = job;
        }
        state.targetPageIds = [...new Set([...(state.targetPageIds ?? []), page.id])];
        await saveState();
      }
    }
    for (;;) {
      assertDeadline();
      workspace = await client.loadWorkspace(context);
      const statuses = selectedPages.map((page) => workspace.workspace.statuses[page.id]);
      if (
        statuses.every(
          (status) =>
            status && ['ready', 'failed', 'manual-review-required'].includes(status.state),
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await save('workspace.json', workspace);
    if (selectedPages.some((page) => workspace.workspace.statuses[page.id]?.state !== 'ready'))
      throw new Error('One or more pages failed; see workspace.json. No page was retried.');
    const partial = selectedPages.length !== pages.length;
    if (partial) {
      const actual = new Set<string>();
      for (const page of selectedPages) {
        const artifact = workspace.workspace.sceneArtifacts[page.id];
        if (artifact && 'nativeSlide' in artifact) {
          artifact.resources.media.forEach((media) => {
            if (media.origin) actual.add(media.origin.route);
          });
          if (artifact.nativeSlide.elements.some((element) => element.type === 'scientificVisual'))
            actual.add('scientific-visual');
        }
      }
      await save('report.json', {
        status: 'partial-generation-passed',
        plannedRoutes: [...routes],
        selectedRoutes: [...selectedRoutes],
        actualRoutes: [...actual],
        runId,
        selectedPageIds: selectedIds,
        pendingPageIds: pages
          .filter((page) => !selectedIds.includes(page.id))
          .map((page) => page.id),
        browserAcceptance: 'pending',
        fourRouteAcceptance: 'not complete',
        manualRepresentationEdit: state.manualRepresentationEdit,
      });
      console.log(
        `Selected ${selectedPages.length}/${pages.length} pages ready; reference-image and full four-route acceptance remain pending. The deferred page remains in state for the normal outline-edit flow.`,
      );
      return;
    }
    const existing = await client.loadMaterializedDocument(context);
    const materialized = existing.materialized
      ? existing
      : await client.materializeWorkspace(context, {
          expectedDraftRevision: workspace.draftRevision,
        });
    const document = materialized.document;
    if (!document) throw new Error('Materialized document missing');
    await save('document.json', document);
    const actual = new Set(
      document.resources.media.flatMap((media) =>
        media.origin ? [media.origin.route as string] : [],
      ),
    );
    if (
      document.nativeSlides.some(({ slide }) =>
        slide.elements.some((element) => element.type === 'scientificVisual'),
      )
    )
      actual.add('scientific-visual');
    if (!requiredRoutes.every((route) => actual.has(route)))
      throw new Error(`Actual route coverage incomplete: ${[...actual].join(', ')}`);
    const resourceMap: Record<string, string> = {};
    const manifest = (await (await request(`${origin}/harness/media-resources`)).json()) as {
      resourceUrlsByObjectKey: Record<string, string>;
    };
    for (const media of document.resources.media) {
      const localPath = manifest.resourceUrlsByObjectKey[media.objectKey];
      if (!localPath?.startsWith('/harness/media/'))
        throw new Error(`Missing local media ${media.id}`);
      const response = await request(new URL(localPath, origin));
      if (!response.ok) throw new Error(`Media download failed ${media.id}`);
      const file = path.join(
        output,
        `media-${Object.keys(resourceMap).length}${path.extname(media.objectKey)}`,
      );
      await writeFile(file, new Uint8Array(await response.arrayBuffer()));
      resourceMap[media.id] = file;
    }
    await save('resource-map.json', resourceMap);
    await save('report.json', {
      status: 'generation-passed',
      plannedRoutes: [...routes],
      actualRoutes: [...actual],
      runId,
      pages: pages.length,
      browserAcceptance: 'pending',
    });
    console.log(
      `Generation passed. Evidence: ${output}. Run the real Player harness with --document-file document.json --resource-map resource-map.json --timing document --smoke; inspect all page screenshots separately.`,
    );
  } catch (error) {
    await save('report.json', {
      status: 'failed',
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (runId) {
      const list = (await request(
        `${origin}/harness/generation-evidence?runId=${encodeURIComponent(runId)}`,
      ).then((response) => response.json())) as { entries?: { jobId: string }[] };
      for (const entry of list.entries ?? []) {
        const response = await request(
          `${origin}/harness/generation-evidence?runId=${encodeURIComponent(runId)}&jobId=${encodeURIComponent(entry.jobId)}`,
        );
        if (response.ok) await save(`evidence-${entry.jobId}.json`, await response.json());
      }
    }
  }
}
