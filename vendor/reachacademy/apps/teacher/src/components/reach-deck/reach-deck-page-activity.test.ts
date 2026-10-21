import { describe, expect, it } from 'vitest';
import type { GenerationWorkspace, ReachDeckDocument } from '@reachany/reach-deck-dsl';
import type { ReachDeckGenerationPanelJob } from '@reachany/reach-deck-editor';
import type { ReachDeckWorkspaceBatchView } from '@reachany/reach-deck-client';
import {
  pageActivityFailed,
  pageActivityLabelKey,
  pageActivityKindKey,
  pageActivityProgress,
  pendingPageActivityHasJob,
  selectStandalonePageJobs,
} from './reach-deck-page-activity';

const workspace = { runId: 'run', statuses: {}, records: {} } as GenerationWorkspace;
const job = (values: Partial<ReachDeckGenerationPanelJob> = {}): ReachDeckGenerationPanelJob =>
  ({
    jobId: 'single',
    kind: 'narration-generation',
    pageId: 'page',
    runId: 'run',
    status: 'active',
    done: false,
    queuedAt: '2026-10-13T01:00:00.000Z',
    ...values,
  }) as ReachDeckGenerationPanelJob;
const batch = (values: Partial<ReachDeckWorkspaceBatchView> = {}): ReachDeckWorkspaceBatchView => ({
  batchId: 'batch',
  runId: 'run',
  kind: 'narration',
  createdAt: '2026-10-12T01:00:00.000Z',
  revision: 1,
  status: 'completed',
  members: [{ pageId: 'page', order: 1, jobId: 'batch-job', status: 'completed', done: true }],
  skipped: [],
  ...values,
});

describe('single page activity selection', () => {
  it('takes over pending feedback only for the scoped new request, and conservatively displays legacy live recovery', () => {
    const pending = {
      runId: 'run',
      pageId: 'page',
      kind: 'narration-generation' as const,
      affectedLanes: ['audio'] as const,
      previousJobIds: ['historical'],
    };
    expect(
      pendingPageActivityHasJob(pending, [job({ affectedLanes: ['audio', 'animation'] })]),
    ).toBe(true);
    for (const wrong of [
      job({ jobId: 'historical' }),
      job({ runId: 'other' }),
      job({ pageId: 'other' }),
      job({ kind: 'page-generation' }),
      job({ affectedLanes: ['animation'] }),
    ])
      expect(pendingPageActivityHasJob(pending, [wrong])).toBe(false);
    const { previousJobIds, ...legacy } = pending;
    for (const live of [
      job(),
      job({ status: 'completed', done: false, progressPhase: 'narration-landing' }),
    ]) {
      expect(pendingPageActivityHasJob(legacy, [live])).toBe(true);
    }
    for (const terminal of [
      job({ status: 'completed', done: true }),
      job({ status: 'completed', done: false }),
      job({ status: 'completed', done: false, progressPhase: 'finalizing' }),
      job({ status: 'failed' }),
      job({ status: 'cancelled' }),
    ]) {
      expect(pendingPageActivityHasJob(legacy, [terminal])).toBe(false);
      expect(pendingPageActivityHasJob(pending, [terminal])).toBe(true);
    }
    expect(pendingPageActivityHasJob(legacy, [])).toBe(false);
  });
  it.each([undefined, 'invalid'])(
    'keeps an unknown-time live single visible beside a timestamped historical exact batch member (%s)',
    (queuedAt) => {
      const single = job({ queuedAt, progress: 43 });
      const historical = job({
        jobId: 'batch-job',
        queuedAt: '2026-10-12T01:00:00.000Z',
        status: 'completed',
        done: true,
      });
      for (const jobs of [
        [historical, single],
        [single, historical],
      ]) {
        expect(selectStandalonePageJobs(jobs, workspace, [batch()])).toEqual([single]);
      }
      expect(selectStandalonePageJobs([single], workspace, [batch({ runId: 'other' })])).toEqual([
        single,
      ]);
    },
  );
  it('does not resurrect unknown-time terminal history ahead of a completed exact batch request', () => {
    const old = job({ queuedAt: undefined, status: 'failed', done: true });
    const historical = job({
      jobId: 'batch-job',
      queuedAt: '2026-10-12T01:00:00.000Z',
      status: 'completed',
      done: true,
    });
    expect(selectStandalonePageJobs([old, historical], workspace, [batch()])).toEqual([]);
    // A historical batch alone is not evidence that an unrelated undated failure is older.
    expect(selectStandalonePageJobs([old], workspace, [batch()])).toEqual([old]);
    const restoredCompleted = job({ queuedAt: undefined, status: 'completed', done: false });
    expect(selectStandalonePageJobs([historical, restoredCompleted], workspace, [batch()])).toEqual(
      [],
    );
    const landing = { ...restoredCompleted, progressPhase: 'narration-landing' };
    expect(selectStandalonePageJobs([historical, landing], workspace, [batch()])).toEqual([
      landing,
    ]);
    const stale = job({
      jobId: 'stale',
      queuedAt: undefined,
      sourceKind: 'materialized-native',
      requestedRevision: 1,
    });
    const document = {
      schemaVersion: 'reach-deck-document/v2',
      pages: [{ pageId: 'page', revision: 4 }],
      nativeSlides: [],
    } as unknown as ReachDeckDocument;
    expect(
      selectStandalonePageJobs(
        [{ ...old, sourceKind: 'workspace' }, { ...historical, sourceKind: 'workspace' }, stale],
        workspace,
        [batch()],
        document,
      ),
    ).toEqual([]);
  });
  it('keeps an unfinished undispatched batch in control when the single has no timestamp', () => {
    expect(
      selectStandalonePageJobs([job({ queuedAt: undefined })], workspace, [
        batch({
          status: 'active',
          members: [{ pageId: 'page', order: 1, status: 'waiting-dispatch' }],
        }),
      ]),
    ).toEqual([]);
    expect(
      selectStandalonePageJobs([job()], workspace, [batch({ createdAt: 'invalid' })]),
    ).toHaveLength(1);
    const activeOlder = batch({
      status: 'active',
      members: [{ pageId: 'page', order: 1, status: 'waiting-dispatch' }],
    });
    expect(
      selectStandalonePageJobs([job()], workspace, [activeOlder, batch({ createdAt: 'invalid' })]),
    ).toHaveLength(1);
    expect(
      selectStandalonePageJobs([job()], workspace, [{ ...activeOlder, createdAt: 'invalid' }]),
    ).toEqual([]);
    expect(
      selectStandalonePageJobs([job({ queuedAt: undefined })], workspace, [
        batch({
          status: 'stopped',
          members: [{ pageId: 'page', order: 1, status: 'waiting-dispatch' }],
        }),
      ]),
    ).toHaveLength(1);
  });
  it.each([false, true])(
    'labels cancellation explicitly while preserving terminal ownership (done=%s)',
    (done) => {
      const cancelled = job({ status: 'cancelled', done, progress: 100 });
      expect(pageActivityLabelKey(cancelled)).toBe('reachDeck.activity.cancelled');
      expect(pageActivityFailed(cancelled)).toBe(true);
      expect(pageActivityProgress(cancelled)).toBe(99);
      expect(pageActivityLabelKey(job({ status: 'failed', done: true }))).toBe(
        'reachDeck.activity.failed',
      );
    },
  );

  it('excludes exact historical batch jobs and continuation chains, without excluding a newer single on the same page', () => {
    const old = batch();
    const next = batch({
      batchId: 'new-batch',
      createdAt: '2026-10-13T00:00:00.000Z',
      members: [],
    });
    expect(
      selectStandalonePageJobs(
        [
          job({ jobId: 'batch-job', pageId: 'batch-page' }),
          job({ jobId: 'continuation', chainId: 'batch-job', pageId: 'child-page' }),
          job(),
        ],
        workspace,
        [old, next],
      ),
    ).toEqual([job()]);
  });
  it('excludes a native batch chain before member job IDs are projected, using its run', () => {
    const pending = batch({ members: [{ pageId: 'page', order: 1, status: 'waiting-dispatch' }] });
    expect(
      selectStandalonePageJobs([job({ chainId: pending.batchId })], workspace, [pending]),
    ).toEqual([]);
    expect(
      selectStandalonePageJobs([job({ chainId: pending.batchId })], workspace, [
        { ...pending, runId: 'other' },
      ]),
    ).toHaveLength(1);
  });
  it('shows the current layout completion and failure after their own workspace timestamps advance', () => {
    const current = {
      ...workspace,
      statuses: {
        page: { state: 'ready', requestedRevision: 4, completedAt: '2026-10-13T02:00:00.000Z' },
      },
    } as unknown as GenerationWorkspace;
    const completed = job({
      kind: 'page-generation',
      requestedRevision: 4,
      status: 'completed',
      done: true,
    });
    expect(selectStandalonePageJobs([completed], current, [])).toEqual([completed]);
    const failed = job({
      kind: 'page-generation',
      requestedRevision: 4,
      status: 'failed',
      done: true,
    });
    const failedWorkspace = {
      ...current,
      statuses: {
        page: { state: 'failed', requestedRevision: 4, failedAt: '2026-10-13T02:00:00.000Z' },
      },
    } as unknown as GenerationWorkspace;
    expect(selectStandalonePageJobs([failed], failedWorkspace, [])).toEqual([failed]);
  });
  it('selects the latest request across layout and narration, independent of discovery order and prior run', () => {
    const older = job({
      jobId: 'old',
      status: 'completed',
      done: true,
      queuedAt: '2026-10-12T01:00:00.000Z',
    });
    const latest = job({ kind: 'page-generation' });
    for (const jobs of [
      [older, latest],
      [latest, older],
    ])
      expect(
        selectStandalonePageJobs(
          [...jobs, job({ jobId: 'other-run', runId: 'other' })],
          workspace,
          [],
        ),
      ).toEqual([latest]);
  });
  it('lets a newer batch with undispatched members supersede an old single', () => {
    expect(
      selectStandalonePageJobs([job({ status: 'failed', done: true })], workspace, [
        batch({
          status: 'active',
          createdAt: '2026-10-13T02:00:00.000Z',
          members: [{ pageId: 'page', order: 1, status: 'waiting-dispatch' }],
        }),
      ]),
    ).toEqual([]);
  });
  it('rejects obsolete native failures while preserving workspace jobs with their independent revision', () => {
    const document = {
      schemaVersion: 'reach-deck-document/v2',
      pages: [{ pageId: 'page', revision: 4 }],
      nativeSlides: [],
    } as unknown as ReachDeckDocument;
    expect(
      selectStandalonePageJobs(
        [
          job({
            sourceKind: 'materialized-native',
            requestedRevision: 3,
            done: true,
            status: 'failed',
          }),
        ],
        workspace,
        [],
        document,
      ),
    ).toEqual([]);
    expect(
      selectStandalonePageJobs(
        [job({ sourceKind: 'workspace', requestedRevision: 1, done: true, status: 'failed' })],
        workspace,
        [],
        document,
      ),
    ).toHaveLength(1);
  });
  describe('first-round workspace narration that kept only the script', () => {
    // 首轮工作区讲稿只保留讲稿时，落地本身让页面变成 ready（completedAt 晚于入队时间）；
    // 这条音频失败不是「被后来的成功覆盖的旧失败」，必须仍在页面活动里出现。
    const failure = {
      pageId: 'page',
      requestedRevision: 2,
      markdown: '保留下来的讲稿。',
      audioFailureCode: 'TTS_TIMESTAMPS_TEXT_MISMATCH',
    };
    const scriptOnly = (narration: Record<string, unknown> = { markdown: failure.markdown }) =>
      ({
        ...workspace,
        // 首轮生成的页有工作区请求记录，与无请求记录的导入页区分开。
        records: { page: { request: { runId: 'run', pageId: 'page', requestedRevision: 2 } } },
        statuses: {
          page: {
            state: 'ready',
            runId: 'run',
            pageId: 'page',
            requestedRevision: 2,
            attempt: 3,
            completedAt: '2026-10-13T02:00:00.000Z',
          },
        },
        sceneArtifacts: {
          page: {
            runId: 'run',
            pageId: 'page',
            requestedRevision: 2,
            attempt: 3,
            sceneType: 'slide',
            status: 'ready',
            nativeSlide: { narration },
          },
        },
      }) as unknown as GenerationWorkspace;
    const audioFailed = (values: Partial<ReachDeckGenerationPanelJob> = {}) =>
      job({
        jobId: 'first-round-narration',
        requestedRevision: 2,
        status: 'completed',
        done: true,
        nativeAudioFailure: failure,
        ...values,
      } as Partial<ReachDeckGenerationPanelJob>);

    it.each([undefined, 'workspace'] as const)(
      'keeps the current failure visible on its ready page before materialization (sourceKind %s)',
      (sourceKind) => {
        const current = audioFailed(sourceKind === undefined ? {} : { sourceKind });
        expect(selectStandalonePageJobs([current], scriptOnly(), [])).toEqual([current]);
        expect(pageActivityLabelKey(current)).toBe('reachDeck.editor.narration.audioFailed');
      },
    );

    it('keeps it visible after materialization, whatever the materialized page revision is', () => {
      const document = {
        schemaVersion: 'reach-deck-document/v2',
        pages: [{ pageId: 'page', revision: 7, sceneType: 'slide' }],
        nativeSlides: [{ pageId: 'page', slide: { narration: { markdown: failure.markdown } } }],
      } as unknown as ReachDeckDocument;
      const current = audioFailed();
      expect(selectStandalonePageJobs([current], scriptOnly(), [], document)).toEqual([current]);
    });

    it('drops the failure once audio landed, the script changed, or a new attempt started', () => {
      const current = audioFailed();
      expect(
        selectStandalonePageJobs(
          [current],
          scriptOnly({ markdown: failure.markdown, audioResourceId: 'audio-1' }),
          [],
        ),
      ).toEqual([]);
      expect(
        selectStandalonePageJobs([current], scriptOnly({ markdown: '教师改过的讲稿。' }), []),
      ).toEqual([]);
      const document = {
        schemaVersion: 'reach-deck-document/v2',
        pages: [{ pageId: 'page', revision: 7, sceneType: 'slide' }],
        nativeSlides: [
          {
            pageId: 'page',
            slide: { narration: { markdown: failure.markdown, audioResourceId: 'audio-1' } },
          },
        ],
      } as unknown as ReachDeckDocument;
      expect(selectStandalonePageJobs([current], scriptOnly(), [], document)).toEqual([]);
      const regenerated = scriptOnly();
      (regenerated.statuses.page as { requestedRevision: number }).requestedRevision = 3;
      expect(selectStandalonePageJobs([current], regenerated, [])).toEqual([]);
    });

    it('still hides an ordinary failure that a later landing superseded', () => {
      expect(
        selectStandalonePageJobs(
          [job({ requestedRevision: 2, status: 'failed', done: true })],
          scriptOnly(),
          [],
        ),
      ).toEqual([]);
    });
  });
  it('keeps unknown progress indeterminate and reserves 100 for observed successful completion', () => {
    expect(pageActivityProgress(job())).toBeUndefined();
    expect(pageActivityProgress(job({ status: 'completed', progress: 100, done: false }))).toBe(99);
    expect(pageActivityProgress(job({ status: 'failed', progress: 100, done: true }))).toBe(99);
    expect(pageActivityProgress(job({ status: 'completed', done: true }))).toBe(100);
    expect(
      pageActivityProgress(
        job({
          status: 'completed',
          done: true,
          nativeAudioFailure: {
            pageId: 'page',
            requestedRevision: 1,
            markdown: 'Text',
            audioFailureCode: 'tts-unavailable',
          },
        }),
      ),
    ).toBeUndefined();
  });
  it('does not infer an unknown request mode from a worker phase', () => {
    expect(pageActivityKindKey(job({ progressPhase: 'animation' }))).toBe(
      'reachDeck.activity.kind.unknown',
    );
  });
});
