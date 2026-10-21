/**
 * 免登录 Reach Deck 四阶段调试工作台（前端）。
 *
 * 页面只是一层薄壳：所有请求都经本地 harness 代理打到**真实**的 AI Runtime，
 * 由真实 worker 执行、真实落库，因此这里看到的行为与教师端一致。壳自己只负责
 * 教师端不会暴露的三件事——中间数据结构、本次实际发出的完整提示词、
 * 以及按 snippet 粒度改提示词后重跑单个阶段。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HtmlLayoutPreview } from './html-layout-preview.js';
import { DeckHarnessEvidence } from './deck-harness-evidence.js';
import { FOUR_ROUTE_TEACHING_SAMPLE, PlannedVisualRoutes } from './deck-harness-visuals.js';
import { ReachDeckPlayer } from '@reachany/reach-deck-player';
import type { PagedDeckOutline, ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { REACH_DECK_MESSAGES } from '../../../../apps/student/src/lib/reach-deck-i18n.js';

import {
  ReachDeckClient,
  type ReachDeckAuthoringWorkspaceResource,
  type ReachDeckGenerationJobResult,
  type ReachDeckModuleContext,
  type ReachDeckWorkspaceJobMetadata,
} from '@reachany/reach-deck-client';

interface HarnessConfig {
  htmlLayoutOnly?: boolean;
  slidesOnly?: boolean;
  moduleContext: ReachDeckModuleContext;
  aiRuntimeUrl: string;
  harnessModeEnabled: boolean;
  harnessModeEnvKey: string;
  promptSnippets: Record<string, string>;
}

type StageKey = 'lesson-plan' | 'page-outline' | 'page-generation' | 'narration-generation';

const STAGES: readonly { key: StageKey; name: string; hint: string }[] = [
  { key: 'lesson-plan', name: '1 · 教案', hint: '从源文本生成 LessonPlan' },
  { key: 'page-outline', name: '2 · 分页大纲', hint: '从教案生成 PagedDeckOutline' },
  { key: 'page-generation', name: '3 · 逐页版面', hint: '逐页生成版面工件与配图' },
  { key: 'narration-generation', name: '4 · 讲稿与 TTS', hint: '逐页生成讲稿并回填时间戳' },
];

/** 捕获到的完整提示词，仅在 AI Runtime 开启 harness 模式时才会有内容。 */
interface CapturedPrompt {
  stage: string;
  promptVersion?: string;
  serializedModelInput: string;
}

const client = new ReachDeckClient();

function App() {
  const [config, setConfig] = useState<HarnessConfig | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [source, setSource] = useState('');
  const [workspace, setWorkspace] = useState<ReachDeckAuthoringWorkspaceResource | undefined>();
  const [busy, setBusy] = useState<StageKey | 'workspace' | undefined>();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Partial<Record<StageKey, unknown>>>({});
  const [prompts, setPrompts] = useState<Partial<Record<StageKey, CapturedPrompt[]>>>({});
  const [tab, setTab] = useState<'data' | 'prompt' | 'workspace' | 'preview' | 'evidence'>(
    'evidence',
  );
  const [previewDocument, setPreviewDocument] = useState<ReachDeckDocument>();
  const [resourceUrlsByObjectKey, setResourceUrlsByObjectKey] = useState<Record<string, string>>(
    {},
  );
  const [previewError, setPreviewError] = useState('');
  const [activePageId, setActivePageId] = useState<string>();
  const [activeStage, setActiveStage] = useState<StageKey>('lesson-plan');
  const pollingRef = useRef(false);
  const materializingRef = useRef(false);

  useEffect(() => {
    void fetch('/harness/config')
      .then((response) => response.json() as Promise<HarnessConfig>)
      .then((loaded) => {
        setConfig(loaded);
        if (loaded.htmlLayoutOnly) setActiveStage('page-generation');
      })
      .catch((cause: unknown) => setError(describe(cause)));
  }, []);

  const context = config?.moduleContext;

  const refreshWorkspace = useCallback(async () => {
    if (context === undefined) return undefined;
    const loaded = await client.loadWorkspace(context);
    setWorkspace(loaded);
    return loaded;
  }, [context]);

  useEffect(() => {
    if (context === undefined || config?.htmlLayoutOnly) return;
    void client
      .loadWorkspace(context)
      .then((loaded) => {
        setWorkspace(loaded);
        setSource((current) => current || loaded.workspace.source);
      })
      .catch(() => {
        // 还没有工作区是正常起点，不当作错误。
      });
  }, [context, config?.htmlLayoutOnly]);

  useEffect(() => {
    if (!context || config?.htmlLayoutOnly) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const loadMedia = () =>
      fetch('/harness/media-resources').then(async (response) => {
        if (!response.ok) throw new Error('媒体资源读取失败');
        return response.json() as Promise<{ resourceUrlsByObjectKey: Record<string, string> }>;
      });
    const poll = async () => {
      const [current, initialMaterialized, initialMedia] = await Promise.allSettled([
        client.loadWorkspace(context),
        client.loadMaterializedDocument(context),
        loadMedia(),
      ]);
      if (disposed) return;
      let materialized = initialMaterialized;
      let media = initialMedia;
      if (
        current.status === 'fulfilled' &&
        current.value.workspace.stage === 'complete' &&
        materialized.status === 'fulfilled' &&
        !materialized.value.materialized &&
        !materializingRef.current
      ) {
        materializingRef.current = true;
        try {
          const result = await client.materializeWorkspace(context, {
            expectedDraftRevision: current.value.draftRevision,
          });
          materialized = { status: 'fulfilled', value: { ...result, materialized: true } };
          [media] = await Promise.allSettled([loadMedia()]);
        } catch (reason) {
          materialized = { status: 'rejected', reason };
        } finally {
          materializingRef.current = false;
        }
      }
      if (disposed) return;
      if (current.status === 'fulfilled') setWorkspace(current.value);
      if (materialized.status === 'fulfilled') {
        const next = materialized.value.document;
        setPreviewDocument((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
        setActivePageId((previous) =>
          next?.pages.some((page) => page.pageId === previous) ? previous : next?.pages[0]?.pageId,
        );
      }
      if (media.status === 'fulfilled')
        setResourceUrlsByObjectKey((previous) =>
          JSON.stringify(previous) === JSON.stringify(media.value.resourceUrlsByObjectKey)
            ? previous
            : media.value.resourceUrlsByObjectKey,
        );
      setPreviewError(
        materialized.status === 'rejected'
          ? `预览读取失败：${describe(materialized.reason)}`
          : media.status === 'rejected'
            ? describe(media.reason)
            : '',
      );
      timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [context, config?.htmlLayoutOnly]);

  const nativeResourceUrlsById = useMemo(
    () =>
      Object.fromEntries(
        (previewDocument?.resources.media ?? []).flatMap((media) =>
          resourceUrlsByObjectKey[media.objectKey]
            ? [[media.id, resourceUrlsByObjectKey[media.objectKey]]]
            : [],
        ),
      ),
    [previewDocument, resourceUrlsByObjectKey],
  );

  /**
   * 等待任务结束并取回结果。
   *
   * 轮询用的是真实的 `pollPath`，与教师端同一条路径；结果里带的
   * `capturedModelPrompts` 就是本次实际发往 provider 的完整请求。
   */
  const awaitJob = useCallback(
    async (stage: StageKey, metadata: ReachDeckWorkspaceJobMetadata) => {
      if (context === undefined) return undefined;
      pollingRef.current = true;
      try {
        for (;;) {
          const job = await client.pollGeneration(context, metadata.pollPath);
          if (job.done === true || job.status === 'completed' || job.status === 'failed') {
            if (job.status === 'failed') throw new Error(job.error ?? `${stage} failed`);
            const result =
              job.result ?? (await client.loadGenerationResult(context, metadata.jobId));
            applyJobResult(stage, result);
            return result;
          }
          await new Promise((resolve) => setTimeout(resolve, metadata.pollIntervalMs || 1000));
        }
      } finally {
        pollingRef.current = false;
      }
    },
    [context],
  );

  const applyJobResult = (stage: StageKey, result: ReachDeckGenerationJobResult) => {
    const record = result as unknown as Record<string, unknown>;
    setResults((current) => ({
      ...current,
      [stage]: record.candidate ?? record.artifact ?? record.nativeNarration ?? record,
    }));
    const captured = record.capturedModelPrompts;
    if (Array.isArray(captured)) {
      setPrompts((current) => ({ ...current, [stage]: captured as CapturedPrompt[] }));
    }
  };

  const run = useCallback(
    async (stage: StageKey, action: () => Promise<void>) => {
      setBusy(stage);
      setError(undefined);
      setActiveStage(stage);
      try {
        await action();
      } catch (cause) {
        setError(describe(cause));
      } finally {
        setBusy(undefined);
        await refreshWorkspace().catch(() => undefined);
      }
    },
    [refreshWorkspace],
  );

  const overridePayload = useMemo(
    () => (Object.keys(overrides).length === 0 ? undefined : overrides),
    [overrides],
  );

  if (error !== undefined && config === undefined) {
    return (
      <div className="banner" data-tone="error">
        {error}
      </div>
    );
  }
  if (config === undefined || context === undefined)
    return <div className="harness__rail">加载中…</div>;

  const revision = workspace?.draftRevision;

  return (
    <div className="harness">
      <style>{`
        .harness { grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); }
        .harness__rail, .harness__main { min-width: 0; }
        .harness textarea, .harness input, .harness select { max-width: 100%; box-sizing: border-box; }
        .harness .stage__head { flex-wrap: wrap; }
        .harness .stage__state { overflow-wrap: anywhere; }
        .harness .stage__head[aria-disabled=true] { cursor: default; opacity: .55; }
        .harness .stage__head[aria-current=step] { background: #f0fdf4; }
        .harness .deck-preview-player { width:100%; min-height: 220px; }
        .harness .deck-preview-pages { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:12px 0; }
        .harness .deck-preview-status { display:flex; gap:8px 16px; flex-wrap:wrap; margin:12px 0; font-size:13px; }
        .harness .tabs { flex-wrap:wrap; }
        @media (max-width: 900px) {
          .harness { grid-template-columns: minmax(0, 1fr); }
          .harness__rail { border-right: 0; border-bottom: 1px solid var(--harness-border); }
          .harness__rail, .harness__main { padding: 12px; }
        }
      `}</style>
      <aside className="harness__rail">
        <h1 className="harness__title">Reach Deck 四阶段调试工作台</h1>
        <p className="harness__hint">
          {config.htmlLayoutOnly
            ? '独立 HTML 编译试验（非四阶段生成链） · 模型调用计费'
            : `真实 AI Runtime（${config.aiRuntimeUrl}）与 worker · 模型调用计费${config.slidesOnly ? ' · Slide 专用，讲稿与 TTS 已停用' : ''}`}
        </p>
        {!config.harnessModeEnabled && (
          <div className="banner">
            AI Runtime 未开启 harness 模式（{config.harnessModeEnvKey}=on）。
            现在可以正常跑四阶段，但提示词覆盖会被拒绝，完整提示词也不会被记录。
          </div>
        )}
        {error !== undefined && (
          <div className="banner" data-tone="error">
            {error}
          </div>
        )}

        <div className="panel">
          <div className="panel__label">源文本</div>
          {!config.htmlLayoutOnly && (
            <>
              <button
                disabled={busy !== undefined}
                onClick={() => setSource(FOUR_ROUTE_TEACHING_SAMPLE)}
              >
                填入四路线教学样例
              </button>
              <p className="harness__hint">
                仅填入教学需求；生成大纲后检查策略分配，再选择页面生成。
              </p>
              {config.slidesOnly && (
                <p role="status">当前只生成版面；讲稿驱动科学图的时间轴验收需要完整四阶段模式。</p>
              )}
            </>
          )}
          <textarea
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="粘贴要生成课件的源材料…"
          />
          {!config.htmlLayoutOnly && (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                data-variant="primary"
                disabled={config.htmlLayoutOnly || busy !== undefined || source.trim().length === 0}
                onClick={() => {
                  setBusy('workspace');
                  setError(undefined);
                  void client
                    .createWorkspace(context, { source, idempotencyKey: crypto.randomUUID() })
                    .then(() => refreshWorkspace())
                    .catch((cause: unknown) => setError(describe(cause)))
                    .finally(() => setBusy(undefined));
                }}
              >
                创建工作区
              </button>
              <button
                disabled={config.htmlLayoutOnly || busy !== undefined}
                onClick={() => void refreshWorkspace()}
              >
                刷新
              </button>
              <span className="stage__state">
                {workspace === undefined
                  ? '无工作区'
                  : `修订 ${revision} · ${workspace.workspace.stage}`}
              </span>
            </div>
          )}
        </div>

        {STAGES.map((stage, index) => (
          <section className="stage" key={stage.key}>
            <header
              className="stage__head"
              role="button"
              tabIndex={config.htmlLayoutOnly && stage.key !== 'page-generation' ? -1 : 0}
              aria-disabled={config.htmlLayoutOnly && stage.key !== 'page-generation'}
              aria-current={activeStage === stage.key ? 'step' : undefined}
              onClick={() => {
                if (!config.htmlLayoutOnly || stage.key === 'page-generation')
                  setActiveStage(stage.key);
              }}
              onKeyDown={(event) => {
                if (
                  (event.key === 'Enter' || event.key === ' ') &&
                  (!config.htmlLayoutOnly || stage.key === 'page-generation')
                ) {
                  event.preventDefault();
                  setActiveStage(stage.key);
                }
              }}
            >
              <span className="stage__index">{index + 1}</span>
              <span className="stage__name">{stage.name}</span>
              <span className="stage__state">{busy === stage.key ? '运行中…' : stage.hint}</span>
            </header>
            {!config.htmlLayoutOnly && activeStage === stage.key && (
              <div className="stage__body">
                <StageActions
                  stage={stage.key}
                  slidesOnly={config.slidesOnly}
                  disabled={config.htmlLayoutOnly || busy !== undefined || workspace === undefined}
                  onRun={run}
                  context={context}
                  workspace={workspace}
                  overrides={overridePayload}
                  awaitJob={awaitJob}
                />
              </div>
            )}
          </section>
        ))}

        {!config.htmlLayoutOnly && (
          <SnippetEditor
            snippets={config.promptSnippets}
            overrides={overrides}
            onChange={setOverrides}
            enabled={config.harnessModeEnabled}
          />
        )}
      </aside>

      <main className="harness__main">
        {activeStage === 'page-generation' &&
          config.harnessModeEnabled &&
          config.htmlLayoutOnly && <HtmlLayoutPreview source={source} />}
        {!config.htmlLayoutOnly && (
          <>
            <div className="tabs">
              <button data-active={tab === 'evidence'} onClick={() => setTab('evidence')}>
                同次生成证据
              </button>
              <button data-active={tab === 'preview'} onClick={() => setTab('preview')}>
                Deck 预览
              </button>
              <button data-active={tab === 'data'} onClick={() => setTab('data')}>
                中间数据结构
              </button>
              <button data-active={tab === 'prompt'} onClick={() => setTab('prompt')}>
                实际发送的完整提示词
              </button>
              <button data-active={tab === 'workspace'} onClick={() => setTab('workspace')}>
                工作区状态
              </button>
            </div>
            {tab === 'evidence' && (
              <DeckHarnessEvidence
                runId={workspace?.workspace.runId}
                resourceUrls={resourceUrlsByObjectKey}
              />
            )}
            {tab === 'data' && <pre>{stringify(results[activeStage] ?? '（该阶段尚无产物）')}</pre>}
            {tab === 'prompt' && <PromptView captured={prompts[activeStage]} />}
            {tab === 'workspace' && <pre>{stringify(workspace ?? '（无工作区）')}</pre>}
            {tab === 'preview' && (
              <>
                <div className="deck-preview-status" role="status">
                  {workspace?.workspace.order.map((pageId, index) => {
                    const status = workspace.workspace.statuses[pageId];
                    const labels: Record<string, string> = {
                      pending: '等待中',
                      generating: '排版中',
                      narrating: '讲稿与语音',
                      ready: '已完成',
                      failed: '失败',
                      cancelled: '已取消',
                    };
                    return (
                      <span key={pageId}>
                        {index + 1}. {workspace.workspace.records[pageId]?.page.title} ·{' '}
                        {status ? (labels[status.state] ?? status.state) : '待生成'}
                      </span>
                    );
                  })}
                </div>
                {previewError && (
                  <div className="banner" data-tone="error" role="alert">
                    {previewError}
                  </div>
                )}
                {previewDocument ? (
                  <>
                    <div className="deck-preview-pages">
                      <label>
                        页面{' '}
                        <select
                          aria-label="预览页面"
                          value={activePageId ?? ''}
                          onChange={(event) => setActivePageId(event.target.value)}
                        >
                          {previewDocument.pages.map((page) => (
                            <option key={page.pageId} value={page.pageId}>
                              {page.order}. {page.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="deck-preview-player" data-harness-deck-player>
                      <ReachDeckPlayer
                        document={previewDocument}
                        activePageId={activePageId}
                        onPageChange={(page) => setActivePageId(page.pageId)}
                        nativeResourceUrlsById={nativeResourceUrlsById}
                        locale="zh-CN"
                        translate={(key) => REACH_DECK_MESSAGES['zh-CN'][key] ?? key}
                        showNativeTimeline
                        hideNativeDiagnostics
                        scientificDependencyBaseUrl={window.location.origin}
                      />
                    </div>
                  </>
                ) : (
                  <p className="harness__hint">尚无预览页面</p>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** 只读展示本次实际发往 provider 的完整请求。 */
function PromptView({ captured }: { captured?: CapturedPrompt[] }) {
  if (captured === undefined || captured.length === 0) {
    return (
      <pre>
        （尚未捕获。需要 AI Runtime 与 worker 都以 REACH_DECK_HARNESS_MODE=on
        启动，并跑完一次该阶段。）
      </pre>
    );
  }
  return (
    <>
      {captured.map((entry, index) => (
        <div className="panel" key={index}>
          <div className="panel__label">
            <span>
              第 {index + 1} 次调用 · {entry.stage}
              {entry.promptVersion === undefined ? '' : ` · ${entry.promptVersion}`}
            </span>
            <button onClick={() => void navigator.clipboard?.writeText(entry.serializedModelInput)}>
              复制
            </button>
          </div>
          <pre>{prettyJson(entry.serializedModelInput)}</pre>
        </div>
      ))}
    </>
  );
}

/**
 * snippet 覆盖编辑器。
 *
 * 只开放注册表里的 snippet：阶段模板由代码拼接而成，要改拼接方式仍然只能改代码。
 */
function SnippetEditor({
  snippets,
  overrides,
  onChange,
  enabled,
}: {
  snippets: Record<string, string>;
  overrides: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  enabled: boolean;
}) {
  const ids = Object.keys(snippets);
  const [selected, setSelected] = useState(ids[0] ?? '');
  const current = overrides[selected] ?? snippets[selected] ?? '';
  const dirty = overrides[selected] !== undefined;

  return (
    <div className="panel">
      <div className="panel__label">
        <span>提示词 snippet 覆盖{dirty ? '（已修改）' : ''}</span>
        {dirty && (
          <button
            onClick={() => {
              const next = { ...overrides };
              delete next[selected];
              onChange(next);
            }}
          >
            还原
          </button>
        )}
      </div>
      <select
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        style={{ width: '100%', marginBottom: 8 }}
      >
        {ids.map((id) => (
          <option key={id} value={id}>
            {overrides[id] === undefined ? id : `${id} ●`}
          </option>
        ))}
      </select>
      <textarea
        value={current}
        disabled={!enabled}
        onChange={(event) => onChange({ ...overrides, [selected]: event.target.value })}
      />
      <p className="harness__hint" style={{ marginTop: 6 }}>
        覆盖会进入任务身份哈希，所以改完直接重跑该阶段即可，不会被当成同一个任务跳过。
      </p>
    </div>
  );
}

/** 各阶段的触发按钮：全部调用真实 API，与教师端同一组端点。 */
function StageActions({
  stage,
  slidesOnly,
  disabled,
  onRun,
  context,
  workspace,
  overrides,
  awaitJob,
}: {
  stage: StageKey;
  slidesOnly?: boolean;
  disabled: boolean;
  onRun: (stage: StageKey, action: () => Promise<void>) => Promise<void>;
  context: ReachDeckModuleContext;
  workspace?: ReachDeckAuthoringWorkspaceResource;
  overrides?: Record<string, string>;
  awaitJob: (
    stage: StageKey,
    metadata: ReachDeckWorkspaceJobMetadata,
  ) => Promise<ReachDeckGenerationJobResult | undefined>;
}) {
  const [pageId, setPageId] = useState('');
  const [outlineJobId, setOutlineJobId] = useState('');
  const [outlinePages, setOutlinePages] = useState<PagedDeckOutline['pages']>([]);
  const [targetPageIds, setTargetPageIds] = useState<string[]>([]);
  const revision = workspace?.draftRevision ?? 0;
  const overrideInput = overrides === undefined ? {} : { promptSnippetOverrides: overrides };

  if (stage === 'lesson-plan') {
    return (
      <div className="row">
        <button
          data-variant="primary"
          disabled={disabled}
          onClick={() =>
            void onRun(stage, async () => {
              const metadata = await client.startLessonPlan(context, {
                expectedDraftRevision: revision,
                ...overrideInput,
              });
              await awaitJob(stage, metadata);
              const latest = await client.loadWorkspace(context);
              await client.applyLessonPlan(context, {
                expectedDraftRevision: latest.draftRevision,
                jobId: metadata.jobId,
              });
            })
          }
        >
          生成并采用教案
        </button>
      </div>
    );
  }

  if (stage === 'page-outline') {
    return (
      <div className="row">
        <button
          data-variant="primary"
          disabled={disabled}
          onClick={() =>
            void onRun(stage, async () => {
              const metadata = await client.startPageOutline(context, {
                expectedDraftRevision: revision,
                enabledSceneTypes: ['slide'],
                ...overrideInput,
              });
              const result = await awaitJob(stage, metadata);
              if (result && 'kind' in result && result.kind === 'page-outline') {
                setOutlineJobId(metadata.jobId);
                setOutlinePages(result.candidate.pages);
                setTargetPageIds(result.candidate.pages.slice(0, 3).map((page) => page.id));
              }
            })
          }
        >
          生成 Slide 大纲
        </button>
        {outlineJobId && (
          <>
            {outlinePages.map((page) => (
              <label key={page.id}>
                <input
                  type="checkbox"
                  checked={targetPageIds.includes(page.id)}
                  onChange={(event) =>
                    setTargetPageIds((current) =>
                      event.target.checked
                        ? [...current, page.id]
                        : current.filter((id) => id !== page.id),
                    )
                  }
                />
                {page.title}
                <PlannedVisualRoutes page={page} />
              </label>
            ))}
            <button
              disabled={disabled || targetPageIds.length === 0}
              onClick={() =>
                void onRun(stage, async () => {
                  const latest = await client.loadWorkspace(context);
                  await client.applyPageOutline(context, {
                    expectedDraftRevision: latest.draftRevision,
                    jobId: outlineJobId,
                    targetPageIds,
                  });
                })
              }
            >
              采用所选 {targetPageIds.length} 页并生成
            </button>
          </>
        )}
      </div>
    );
  }

  const pageIds = workspace?.workspace.order ?? [];
  return (
    <div className="row">
      <select value={pageId} onChange={(event) => setPageId(event.target.value)}>
        <option value="">选择页面…</option>
        {pageIds.map((id: string) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <button
        data-variant="primary"
        disabled={disabled || pageId === '' || (slidesOnly && stage === 'narration-generation')}
        onClick={() =>
          void onRun(stage, async () => {
            const latest = await client.loadWorkspace(context);
            const metadata =
              stage === 'page-generation'
                ? await client.startPageGeneration(context, pageId, {
                    expectedDraftRevision: latest.draftRevision,
                    regenerate: true,
                    idempotencyKey: crypto.randomUUID(),
                    ...overrideInput,
                  })
                : await client.regeneratePageNarration(context, pageId, {
                    expectedDraftRevision: latest.draftRevision,
                    idempotencyKey: crypto.randomUUID(),
                    ...overrideInput,
                  });
            await awaitJob(stage, metadata);
          })
        }
      >
        重跑本页
      </button>
      <span className="stage__state">
        大纲采用后，后续页面会由真实生成链自动推进；这里只做单页重跑。
      </span>
    </div>
  );
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** 完整请求是一段 JSON 文本，展开成缩进形式便于阅读提示词正文。 */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const container = document.querySelector('#root');
if (container !== null) createRoot(container).render(<App />);
