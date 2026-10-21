'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  GeneratedSceneArtifact,
  GenerationWorkspace,
  LessonPlan,
  PagedDeckOutline,
  PageOutline,
  ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';

import { ReachDeckArtifactPreview } from './ReachDeckArtifactPreview.js';
import { canStartReachDeckPage } from './generation-state.js';

export type ReachDeckGenerationPanelJobKind =
  | 'lesson-plan'
  | 'page-outline'
  | 'page-generation'
  | 'narration-generation';

interface ReachDeckGenerationPanelJobBase {
  sourceKind?:
    | 'workspace'
    | 'workspace-interactive'
    | 'materialized-native'
    | 'materialized-interactive';
  affectedLanes?: ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
  jobId: string;
  runId?: string;
  kind: ReachDeckGenerationPanelJobKind;
  pageId?: string;
  /** Durable page identity used to reject superseded native narration recovery jobs. */
  requestedRevision?: number;
  chainId?: string;
  queuedAt?: string;
  status: string;
  done: boolean;
  progress?: number;
  /** worker 上报的当前阶段（semantics/layout/media/judge/...），用于展示真实进展。 */
  progressPhase?: string;
  error?: string;
}

export type ReachDeckGenerationPanelJob =
  | (ReachDeckGenerationPanelJobBase & {
      kind: 'lesson-plan';
      candidate?: LessonPlan;
    })
  | (ReachDeckGenerationPanelJobBase & {
      kind: 'page-outline';
      candidate?: PagedDeckOutline;
    })
  | (ReachDeckGenerationPanelJobBase & {
      kind: 'page-generation';
      artifact?: GeneratedSceneArtifact;
    })
  | (ReachDeckGenerationPanelJobBase & {
      kind: 'narration-generation';
      artifact?: GeneratedSceneArtifact;
      nativeAudioFailure?: {
        pageId: string;
        requestedRevision: number;
        markdown: string;
        speechMarkup?: ReachDeckSpeechMarkupV1;
        audioFailureCode: string;
      };
    });

export interface ReachDeckGenerationPanelProps {
  /** Local submission feedback; accepted durable jobs replace these entries. */
  pendingPageActivities?: readonly {
    /** Jobs already present before this submission; a new accepted identity takes over feedback. */
    previousJobIds?: readonly string[];
    pageId: string;
    runId: string;
    kind: 'page-generation' | 'narration-generation';
    affectedLanes?: readonly ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
  }[];
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  workspace?: GenerationWorkspace;
  workspaceRevision?: number;
  jobs: readonly ReachDeckGenerationPanelJob[];
  sourceDraft: string;
  locale?: string;
  busyAction?: string;
  message?: string;
  error?: string;
  conflict?: boolean;
  materialized?: boolean;
  materializedPreviewAvailable?: boolean;
  /**
   * native 通道讲稿资格：工作区没有生成回合状态机（PPTX 导入等）且物化 v2 文档
   * 存在 nativeSlides 绑定页。为 true 时讲稿重生成入口按 native 资格放开，
   * 进行中反馈只靠 jobs 轮询（无页锁，写冲突由服务端落地 digest 校验兜底）。
   */
  nativeNarrationEligible?: boolean;
  onSourceDraftChange: (source: string) => void;
  /** Read-only scoped URL renewal for an image in the current material references. */
  onPreviewMaterialAsset?: (
    assetId: string,
  ) => Promise<{ assetId: string; contentType: string; downloadUrl: string }>;
  onCreateWorkspace: (
    source: string,
    options?: {
      files?: readonly File[];
      webSearch?: boolean;
      /** Requested output language for Reach Deck generation; follow-system is the default. */
      generationLanguage?: 'follow-system' | 'zh-CN' | 'en-US';
      /** Browser-resolved locale used only when generationLanguage is follow-system. */
      systemLanguage?: 'zh-CN' | 'en-US';
    },
  ) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  onTogglePaused: (paused: boolean) => Promise<void> | void;
  onStartLessonPlan: (
    prompt?: string,
    options?: { regenerateNonce?: string },
  ) => Promise<void> | void;
  onApplyLessonPlan: (jobId: string) => Promise<void> | void;
  onAdoptLessonPlan?: (
    lessonPlan: LessonPlan,
    options?: { enabledSceneTypes?: readonly PageOutline['sceneType'][] },
  ) => Promise<void> | void;
  onStartPageOutline: (
    prompt?: string,
    options?: {
      enabledSceneTypes?: readonly PageOutline['sceneType'][];
      regenerateNonce?: string;
    },
  ) => Promise<void> | void;
  onRestartPlanningStage?: (
    stage: 'lesson-plan' | 'page-outline',
    prompt?: string,
    options?: { enabledSceneTypes?: readonly PageOutline['sceneType'][] },
  ) => Promise<void> | void;
  onApplyPageOutline: (jobId: string, targetPageIds: string[]) => Promise<void> | void;
  onAdoptPageOutline?: (outline: PagedDeckOutline, jobId?: string) => Promise<void> | void;
  onStartPage: (
    pageId: string,
    input: { prompt?: string; regenerate: boolean; throwOnError?: boolean },
  ) => Promise<void> | void;
  onApplyPageArtifact: (pageId: string, jobId: string) => Promise<void> | void;
  /**
   * 单页"重新生成讲稿"（仅 slide 且 ready，或讲稿阶段失败页的重试通道）。
   * `textOnly: true` 只重写讲稿文字，不合成音频、不生成讲稿动画。
   */
  onRegeneratePageNarration?: (
    pageId: string,
    options?: { textOnly?: boolean },
  ) => Promise<void> | void;
  /**
   * 整份"重新生成全部讲稿"（服务端按页串行入队，后页引用前页新讲稿）。
   * `textOnly: true` 只重写讲稿文字，不合成音频、不生成讲稿动画。
   */
  onRegenerateAllNarration?: (options?: {
    overwriteExisting?: boolean;
    textOnly?: boolean;
  }) => Promise<void> | void;
  /** Animation mode of a locally persisted media submission awaiting retry. */
  pendingMediaAnimationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
  /** Resolves when submission finishes; rejects startup failures so callers can keep retry UI open. */
  onGenerateAllAudio?: (options?: {
    animationMode?: 'preserve' | 'regenerate' | 'skip';
  }) => Promise<void> | void;
  onRegenerateAllAnimations?: () => Promise<void> | void;
  onRegenerateAllMedia?: () => Promise<void> | void;
  onInspectAllNarration?: () => Promise<{
    hasExistingNarration: boolean;
    hasInFlightNarration: boolean;
  }>;
  onRetryJob: (jobId: string) => Promise<void> | void;
  onCancelJob: (jobId: string) => Promise<void> | void;
  onMaterialize: () => Promise<void> | void;
  /** 放弃本轮分页生成并恢复上一轮成果(priorGeneration 存在时可用)。 */
  onRestorePriorGeneration?: () => Promise<void> | void;
}

export function ReachDeckGenerationPanel({
  nativeResourceUrlsById,
  workspace,
  workspaceRevision,
  jobs,
  sourceDraft,
  locale = 'en-US',
  busyAction,
  message,
  error,
  conflict,
  materialized = false,
  materializedPreviewAvailable = false,
  onSourceDraftChange,
  onCreateWorkspace,
  onRefresh,
  onTogglePaused,
  onStartLessonPlan,
  onApplyLessonPlan,
  onStartPageOutline,
  onApplyPageOutline,
  onStartPage,
  onApplyPageArtifact,
  onRetryJob,
  onCancelJob,
  onMaterialize,
}: ReachDeckGenerationPanelProps) {
  const [lessonPrompt, setLessonPrompt] = useState('');
  const [outlinePrompt, setOutlinePrompt] = useState('');
  const [pagePrompts, setPagePrompts] = useState<Record<string, string>>({});
  const lessonJob = latestJob(jobs, 'lesson-plan');
  const outlineJob = latestJob(jobs, 'page-outline');
  const outlineCandidate = outlineJob?.candidate;
  const [targetPageIds, setTargetPageIds] = useState<string[]>([]);

  useEffect(() => {
    if (outlineCandidate === undefined) return;
    setTargetPageIds(outlineCandidate.pages.map((page) => page.id));
  }, [outlineCandidate]);

  const orderedRecords = useMemo(
    () =>
      workspace === undefined
        ? []
        : workspace.order
            .map((pageId) => workspace.records[pageId])
            .filter((record) => record !== undefined),
    [workspace],
  );
  const disabled = busyAction !== undefined;

  return (
    <section
      aria-busy={disabled}
      aria-labelledby="reach-deck-generation-heading"
      className="reach-deck-generation"
    >
      <header className="reach-deck-generation__header">
        <div>
          <h2 id="reach-deck-generation-heading">AI 课件生成工作区</h2>
          <p>分阶段审阅教学计划、页面大纲和每页产物。只有“写入编辑草稿”会更新学习者课件。</p>
        </div>
        <button disabled={disabled} onClick={() => void onRefresh()} type="button">
          刷新状态
        </button>
      </header>

      {message ? (
        <p aria-live="polite" className="reach-deck-generation__notice" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <div className="reach-deck-generation__error" role="alert">
          <p>{error}</p>
          {conflict ? (
            <button onClick={() => void onRefresh()} type="button">
              加载最新状态
            </button>
          ) : null}
        </div>
      ) : null}

      {workspace === undefined ? (
        <div className="reach-deck-generation__stage">
          <h3>1. 输入课件来源</h3>
          <label>
            <span>主题、材料或教学要求</span>
            <textarea
              disabled={disabled}
              onChange={(event) => onSourceDraftChange(event.target.value)}
              placeholder="例如：面向初学者，用 30 分钟解释原子比较并交换，并包含一次测验。"
              value={sourceDraft}
            />
          </label>
          <button
            disabled={disabled || sourceDraft.trim().length === 0}
            onClick={() => void onCreateWorkspace(sourceDraft.trim())}
            type="button"
          >
            创建生成工作区
          </button>
        </div>
      ) : (
        <>
          <div className="reach-deck-generation__summary">
            <div>
              <strong>{stageLabel(workspace.stage)}</strong>
              <span>工作区修订 {workspaceRevision ?? '—'}</span>
            </div>
            <button
              aria-pressed={workspace.paused}
              disabled={disabled}
              onClick={() => void onTogglePaused(!workspace.paused)}
              type="button"
            >
              {workspace.paused ? '继续生成' : '暂停新任务'}
            </button>
          </div>
          {workspace.paused ? (
            <p className="reach-deck-generation__notice">
              工作区已暂停；现有任务仍会显示状态，但不会启动或重试新任务。
            </p>
          ) : null}

          <div className="reach-deck-generation__stage">
            <h3>1. 来源</h3>
            <p className="reach-deck-generation__source">{workspace.source}</p>
          </div>

          <div className="reach-deck-generation__stage">
            <h3>2. 教学计划</h3>
            {workspace.lessonPlan ? (
              <LessonPlanReview plan={workspace.lessonPlan} />
            ) : (
              <>
                <label>
                  <span>补充要求（可选）</span>
                  <textarea
                    disabled={disabled || workspace.paused}
                    onChange={(event) => setLessonPrompt(event.target.value)}
                    value={lessonPrompt}
                  />
                </label>
                {lessonJob?.candidate ? <LessonPlanReview plan={lessonJob.candidate} /> : null}
                <JobActions
                  applyLabel="采用教学计划"
                  disabled={disabled || workspace.paused}
                  job={lessonJob}
                  onApply={
                    lessonJob?.candidate ? () => onApplyLessonPlan(lessonJob.jobId) : undefined
                  }
                  onCancel={onCancelJob}
                  onRetry={onRetryJob}
                  onStart={() => onStartLessonPlan(optionalPrompt(lessonPrompt))}
                  startLabel="生成教学计划"
                />
              </>
            )}
          </div>

          {workspace.lessonPlan ? (
            <div className="reach-deck-generation__stage">
              <h3>3. 页面大纲</h3>
              {workspace.pagedOutline ? (
                <OutlineReview outline={workspace.pagedOutline} />
              ) : (
                <>
                  <label>
                    <span>补充要求（可选）</span>
                    <textarea
                      disabled={disabled || workspace.paused}
                      onChange={(event) => setOutlinePrompt(event.target.value)}
                      value={outlinePrompt}
                    />
                  </label>
                  {outlineCandidate ? (
                    <OutlineSelection
                      disabled={disabled}
                      onChange={setTargetPageIds}
                      outline={outlineCandidate}
                      selectedPageIds={targetPageIds}
                    />
                  ) : null}
                  <JobActions
                    applyLabel="采用所选页面"
                    disabled={disabled || workspace.paused}
                    job={outlineJob}
                    onApply={
                      outlineCandidate && targetPageIds.length > 0
                        ? () => onApplyPageOutline(outlineJob.jobId, targetPageIds)
                        : undefined
                    }
                    onCancel={onCancelJob}
                    onRetry={onRetryJob}
                    onStart={() => onStartPageOutline(optionalPrompt(outlinePrompt))}
                    startLabel="生成页面大纲"
                  />
                </>
              )}
            </div>
          ) : null}

          {workspace.pagedOutline ? (
            <div className="reach-deck-generation__stage">
              <h3>4. 页面产物</h3>
              <ol className="reach-deck-generation__pages">
                {orderedRecords.map((record) => {
                  const pageJobs = jobs.filter((job) => job.pageId === record.pageId);
                  const job = pageJobs.at(-1);
                  const previewArtifact =
                    job?.status === 'completed' && job.kind === 'page-generation'
                      ? job.artifact
                      : undefined;
                  const status = workspace.statuses[record.pageId];
                  const artifact = workspace.sceneArtifacts[record.pageId];
                  const canStart =
                    status?.state === 'pending' &&
                    canStartReachDeckPage(workspace, record.pageId) &&
                    (job === undefined || job.status === 'cancelled');
                  const canRegenerate =
                    !materialized &&
                    job === undefined &&
                    (status?.state === 'ready' ||
                      status?.state === 'failed' ||
                      status?.state === 'manual-review-required' ||
                      status?.state === 'stale');
                  return (
                    <li key={record.pageId}>
                      <div className="reach-deck-generation__page-heading">
                        <div>
                          <strong>{record.page.title}</strong>
                          <span>
                            {record.page.sceneType} · {pageStatusLabel(status?.state)}
                          </span>
                        </div>
                        <span>修订 {record.revision}</span>
                      </div>
                      {record.page.instructionalSpec ? (
                        <p>{record.page.instructionalSpec.learningObjective}</p>
                      ) : null}
                      <label>
                        <span>本页补充要求（可选）</span>
                        <input
                          disabled={disabled || workspace.paused}
                          onChange={(event) =>
                            setPagePrompts((current) => ({
                              ...current,
                              [record.pageId]: event.target.value,
                            }))
                          }
                          value={pagePrompts[record.pageId] ?? ''}
                        />
                      </label>
                      {previewArtifact ? (
                        <ReachDeckArtifactPreview
                          artifact={previewArtifact}
                          resourceUrlsById={nativeResourceUrlsById}
                          locale={locale}
                          revision={record.revision}
                          theme={workspace.baseDocument?.theme}
                          title={record.page.title}
                        />
                      ) : null}
                      <JobActions
                        applyLabel="采用页面产物"
                        disabled={disabled || workspace.paused}
                        job={job}
                        onApply={
                          job?.status === 'completed'
                            ? () => onApplyPageArtifact(record.pageId, job.jobId)
                            : undefined
                        }
                        onCancel={onCancelJob}
                        onRetry={onRetryJob}
                        onStart={
                          canStart
                            ? () =>
                                onStartPage(record.pageId, {
                                  prompt: optionalPrompt(pagePrompts[record.pageId] ?? ''),
                                  regenerate: false,
                                })
                            : undefined
                        }
                        startLabel="生成本页"
                      />
                      {canRegenerate ? (
                        <button
                          disabled={disabled || workspace.paused}
                          onClick={() =>
                            void onStartPage(record.pageId, {
                              prompt: optionalPrompt(pagePrompts[record.pageId] ?? ''),
                              regenerate: true,
                            })
                          }
                          type="button"
                        >
                          重新生成
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {workspace.stage === 'complete' ? (
            <div className="reach-deck-generation__stage">
              <h3>5. 物化学习者课件</h3>
              <p>所有目标页面已完成。物化并预览后，还需发布模块与课程，学生才会看到新版本。</p>
              <button
                disabled={
                  disabled || workspace.paused || (materialized && materializedPreviewAvailable)
                }
                onClick={() => void onMaterialize()}
                type="button"
              >
                {materialized
                  ? materializedPreviewAvailable
                    ? '已物化学习者课件'
                    : '加载已物化预览'
                  : '物化学习者课件'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function JobActions({
  job,
  disabled,
  startLabel,
  applyLabel,
  onStart,
  onApply,
  onRetry,
  onCancel,
}: {
  job?: ReachDeckGenerationPanelJob;
  disabled: boolean;
  startLabel: string;
  applyLabel: string;
  onStart?: () => Promise<void> | void;
  onApply?: () => Promise<void> | void;
  onRetry: (jobId: string) => Promise<void> | void;
  onCancel: (jobId: string) => Promise<void> | void;
}) {
  if (job === undefined) {
    return onStart ? (
      <button disabled={disabled} onClick={() => void onStart()} type="button">
        {startLabel}
      </button>
    ) : null;
  }
  const running = !job.done && !['failed', 'cancelled'].includes(job.status);
  return (
    <div className="reach-deck-generation__job">
      <div aria-live="polite" role="status">
        <span>任务状态：{jobStatusLabel(job.status)}</span>
        {job.progress !== undefined ? (
          <progress
            aria-label={startLabel + '进度'}
            max={100}
            value={Math.max(0, Math.min(100, job.progress))}
          />
        ) : null}
      </div>
      {job.error ? <p role="alert">{job.error}</p> : null}
      <div className="reach-deck-generation__job-actions">
        {job.status === 'completed' && onApply ? (
          <button disabled={disabled} onClick={() => void onApply()} type="button">
            {applyLabel}
          </button>
        ) : null}
        {job.status === 'failed' ? (
          <button disabled={disabled} onClick={() => void onRetry(job.jobId)} type="button">
            重试任务
          </button>
        ) : null}
        {running ? (
          <button
            className="is-danger"
            disabled={disabled}
            onClick={() => void onCancel(job.jobId)}
            type="button"
          >
            取消任务
          </button>
        ) : null}
        {job.status === 'cancelled' ? (
          <>
            <span>已取消的任务不能重试；请修改要求后重新启动。</span>
            {onStart ? (
              <button disabled={disabled} onClick={() => void onStart()} type="button">
                启动新任务
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function LessonPlanReview({ plan }: { plan: LessonPlan }) {
  return (
    <article className="reach-deck-generation__review">
      <h4>{plan.title}</h4>
      <p>
        {plan.audience} · {plan.durationMinutes} 分钟
      </p>
      <p>{plan.narrative}</p>
      <strong>学习目标</strong>
      <ul>
        {plan.learningObjectives.map((objective) => (
          <li key={objective}>{objective}</li>
        ))}
      </ul>
    </article>
  );
}

function OutlineReview({ outline }: { outline: PagedDeckOutline }) {
  return (
    <article className="reach-deck-generation__review">
      <h4>{outline.title}</h4>
      <ol>
        {outline.pages.map((page) => (
          <li key={page.id}>
            <strong>{page.title}</strong> <span>({page.sceneType})</span>
            {page.instructionalSpec ? <p>{page.instructionalSpec.learningObjective}</p> : null}
          </li>
        ))}
      </ol>
    </article>
  );
}

function OutlineSelection({
  outline,
  selectedPageIds,
  disabled,
  onChange,
}: {
  outline: PagedDeckOutline;
  selectedPageIds: readonly string[];
  disabled: boolean;
  onChange: (pageIds: string[]) => void;
}) {
  return (
    <article className="reach-deck-generation__review">
      <h4>{outline.title}</h4>
      <p>选择本次要生成的页面；未选择的现有页面会保留。</p>
      <ol>
        {outline.pages.map((page) => (
          <li key={page.id}>
            <label className="reach-deck-generation__target">
              <input
                checked={selectedPageIds.includes(page.id)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selectedPageIds, page.id]
                      : selectedPageIds.filter((pageId) => pageId !== page.id),
                  )
                }
                type="checkbox"
              />
              <span>
                <strong>{page.title}</strong> ({page.sceneType})
                {page.instructionalSpec ? ` — ${page.instructionalSpec.learningObjective}` : ''}
              </span>
            </label>
          </li>
        ))}
      </ol>
    </article>
  );
}

function latestJob<Kind extends ReachDeckGenerationPanelJobKind>(
  jobs: readonly ReachDeckGenerationPanelJob[],
  kind: Kind,
): Extract<ReachDeckGenerationPanelJob, { kind: Kind }> | undefined {
  return jobs
    .filter((job): job is Extract<ReachDeckGenerationPanelJob, { kind: Kind }> => job.kind === kind)
    .at(-1);
}

function optionalPrompt(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stageLabel(stage: GenerationWorkspace['stage']): string {
  return {
    'lesson-plan': '教学计划',
    'page-outline': '页面大纲',
    'page-generation': '页面生成',
    complete: '可写入草稿',
    copied: '可写入草稿',
  }[stage];
}

function pageStatusLabel(state: string | undefined): string {
  if (state === undefined) return '尚未开始';
  return (
    {
      pending: '待生成',
      generating: '生成中',
      narrating: '讲稿生成中',
      ready: '已就绪',
      stale: '需要重新生成',
      failed: '失败',
      'manual-review-required': '待教师审核',
    }[state] ?? state
  );
}

function jobStatusLabel(status: string): string {
  return (
    {
      waiting: '等待中',
      delayed: '等待重试',
      active: '运行中',
      completed: '等待采用',
      failed: '失败',
      cancelled: '已取消',
    }[status] ?? status
  );
}
