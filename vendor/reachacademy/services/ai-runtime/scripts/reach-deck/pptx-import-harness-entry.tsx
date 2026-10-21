import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeV2SlideRenderer } from '@reachany/reach-deck-player';

import type {
  PptxImportHarnessCase,
  PptxImportHarnessCaseSummary,
  PptxImportHarnessPage,
} from './pptx-import-harness.js';

type Severity = 'info' | 'warning' | 'error' | 'fatal';

interface Diagnostic {
  code: string;
  severity: Severity;
  feature: string;
  message: string;
  location?: { partPath: string; slideId?: string; nodePath?: string; relationshipId?: string };
}

const SEVERITY_ORDER: Severity[] = ['fatal', 'error', 'warning', 'info'];

/**
 * The import gate refuses only an unreadable file, so `canApply` no longer says
 * anything about fidelity. This harness exists to measure fidelity, so it
 * reports what was lost: clean = nothing, lossy = content missing.
 */
const verdictOf = (value: {
  canApply: boolean;
  canApplyDegraded: boolean;
  severityCounts: Record<Severity, number>;
}): 'clean' | 'lossy' | 'blocked' => {
  if (!value.canApply && !value.canApplyDegraded) return 'blocked';
  return value.severityCounts.error + value.severityCounts.fatal > 0 ? 'lossy' : 'clean';
};

const VERDICT_LABEL: Record<'clean' | 'lossy' | 'blocked', string> = {
  clean: '可导入，无内容丢失',
  lossy: '可导入，但有内容丢失',
  blocked: '文件无法读取',
};

const formatBytes = (value: number): string =>
  value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;

function SeverityChips({ counts }: { counts: Record<Severity, number> }) {
  return (
    <>
      {SEVERITY_ORDER.filter((severity) => counts[severity] > 0).map((severity) => (
        <span className="pih-chip" data-severity={severity} key={severity}>
          {severity} {counts[severity]}
        </span>
      ))}
    </>
  );
}

function DiagnosticList({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  if (diagnostics.length === 0) return <p className="pih-empty">无诊断。</p>;
  const ordered = [...diagnostics].sort(
    (left, right) => SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity),
  );
  return (
    <>
      {ordered.map((diagnostic, index) => (
        <div className="pih-diag" data-severity={diagnostic.severity} key={`${index}`}>
          <code>
            {diagnostic.severity} · {diagnostic.code} · {diagnostic.feature}
          </code>
          <p>{diagnostic.message}</p>
          {diagnostic.location === undefined ? null : (
            <small>
              {diagnostic.location.partPath}
              {diagnostic.location.nodePath === undefined ? '' : ` ${diagnostic.location.nodePath}`}
              {diagnostic.location.slideId === undefined
                ? ''
                : ` (slide ${diagnostic.location.slideId})`}
            </small>
          )}
        </div>
      ))}
    </>
  );
}

/** Scales the real renderer stage down to the available column width. */
function Stage({
  active,
  harnessCase,
}: {
  active: PptxImportHarnessPage | undefined;
  harnessCase: PptxImportHarnessCase;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const measure = () => {
      const available = container.clientWidth - 32;
      setScale(Math.min(1, Math.max(0.2, available / harnessCase.stage.width)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [harnessCase.stage.width]);

  const binding = harnessCase.document?.nativeSlides.find(
    (candidate) => candidate.pageId === active?.pageId,
  );

  return (
    <div className="pih-stage" ref={containerRef}>
      {active === undefined ? (
        <p className="pih-stage-empty">没有可显示的页面。</p>
      ) : binding === undefined ? (
        <p className="pih-stage-empty">
          第 {active.sourceOrder} 页未进入候选文档（mapper 判为
          error，整页被排除），因此没有可渲染的 native slide。右侧列出了导致排除的诊断。
        </p>
      ) : (
        <div
          className="pih-stage-frame reach-deck-player"
          style={{
            width: harnessCase.stage.width,
            height: harnessCase.stage.height,
            transform: `scale(${scale})`,
            marginBottom: harnessCase.stage.height * (scale - 1),
            marginRight: harnessCase.stage.width * (scale - 1),
          }}
        >
          <NativeV2SlideRenderer
            hideDiagnostics
            resourceUrlsById={harnessCase.resourceUrlsById}
            slide={binding.slide}
            stage={harnessCase.stage}
          />
        </div>
      )}
    </div>
  );
}

function GateExplanation({ harnessCase }: { harnessCase: PptxImportHarnessCase }) {
  const { gate } = harnessCase;
  return (
    <div className="pih-gate">
      <div>
        canApply = <b>{String(gate.canApply)}</b> ← !hasUnsupportedFeature &amp;&amp;
        !hasBlockingDiagnostics
      </div>
      <div>
        hasUnsupportedFeature = <b>{String(!gate.schemaRepresentable)}</b>
        {gate.unsupportedFeatures.length === 0 ? '' : ` → ${gate.unsupportedFeatures.join(', ')}`}
      </div>
      <div>
        hasBlockingDiagnostics = <b>{String(gate.blockingDiagnosticCount > 0)}</b> ← error/fatal ×
        {gate.blockingDiagnosticCount}（去重后 {gate.distinctBlockingDiagnosticCount}）
      </div>
      <div>
        canApplyDegraded = <b>{String(gate.canApplyDegraded)}</b> ← 存在可映射候选文档
      </div>
      <div>
        native/conditional features:{' '}
        {gate.nativeFeatures.length === 0 ? '—' : gate.nativeFeatures.join(', ')}
      </div>
    </div>
  );
}

function AggregateTable({ harnessCase }: { harnessCase: PptxImportHarnessCase }) {
  if (harnessCase.aggregate.length === 0) return <p className="pih-empty">无诊断。</p>;
  return (
    <table className="pih-table">
      <thead>
        <tr>
          <th>severity</th>
          <th>code</th>
          <th className="pih-num">条数</th>
          <th className="pih-num">去重</th>
        </tr>
      </thead>
      <tbody>
        {harnessCase.aggregate.map((row) => (
          <tr key={`${row.code}-${row.severity}-${row.feature}`}>
            <td>{row.severity}</td>
            <td>
              {row.code}
              <br />
              <span style={{ color: '#647178' }}>{row.feature}</span>
            </td>
            <td className="pih-num">{row.count}</td>
            <td className="pih-num">{row.distinctCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Harness({ summaries }: { summaries: readonly PptxImportHarnessCaseSummary[] }) {
  const [caseId, setCaseId] = useState(summaries[0]?.caseId);
  const [harnessCase, setHarnessCase] = useState<PptxImportHarnessCase>();
  const [error, setError] = useState<string>();
  const [activePageId, setActivePageId] = useState<string>();
  const [scope, setScope] = useState<'page' | 'deck'>('page');

  useEffect(() => {
    if (caseId === undefined) return;
    let cancelled = false;
    setHarnessCase(undefined);
    setError(undefined);
    fetch(`/cases/${caseId}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`cases/${caseId}.json failed: HTTP ${response.status}`);
        return response.json() as Promise<PptxImportHarnessCase>;
      })
      .then((value) => {
        if (cancelled) return;
        setHarnessCase(value);
        setActivePageId(value.pages[0]?.pageId);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const activePage = useMemo(
    () => harnessCase?.pages.find((page) => page.pageId === activePageId),
    [activePageId, harnessCase],
  );
  const shownDiagnostics = useMemo<readonly Diagnostic[]>(() => {
    if (harnessCase === undefined) return [];
    if (scope === 'deck') return harnessCase.pages.flatMap((page) => page.diagnostics);
    return activePage?.diagnostics ?? [];
  }, [activePage, harnessCase, scope]);

  const summary = summaries.find((candidate) => candidate.caseId === caseId);

  return (
    <div className="pih-shell">
      <header className="pih-topbar">
        <strong>PPTX 导入 harness</strong>
        <select
          aria-label="选择课件"
          onChange={(event) => setCaseId(event.target.value)}
          value={caseId ?? ''}
        >
          {summaries.map((candidate) => (
            <option key={candidate.caseId} value={candidate.caseId}>
              {verdictOf(candidate) === 'clean'
                ? '✅'
                : verdictOf(candidate) === 'lossy'
                  ? '⚠️'
                  : '⛔'}{' '}
              {candidate.fileName}
            </option>
          ))}
        </select>
        {summary === undefined ? null : (
          <>
            <span className="pih-verdict" data-verdict={verdictOf(summary)}>
              {VERDICT_LABEL[verdictOf(summary)]}
            </span>
            <span className="pih-chip">
              {summary.slideCount} 页 · {formatBytes(summary.byteLength)}
            </span>
            <span className="pih-chip">
              ok {summary.pageStatusCounts.ok} / warn {summary.pageStatusCounts.warning} / err{' '}
              {summary.pageStatusCounts.error}
            </span>
            <span className="pih-chip">
              诊断 {summary.diagnosticCount}（去重 {summary.distinctDiagnosticCount}）
            </span>
            <div className="pih-chips">
              <SeverityChips counts={summary.severityCounts} />
            </div>
          </>
        )}
      </header>
      <div className="pih-body">
        <nav aria-label="页面列表" className="pih-pages">
          {harnessCase?.pages.map((page) => (
            <button
              aria-current={page.pageId === activePageId}
              key={page.pageId}
              onClick={() => setActivePageId(page.pageId)}
              type="button"
            >
              <span className="pih-status" data-status={page.status} />
              {page.sourceOrder}
              <span className="pih-page-title">{page.title || '（无标题）'}</span>
            </button>
          ))}
        </nav>
        {harnessCase === undefined ? (
          <div className="pih-stage">
            <p className="pih-stage-empty">{error ?? '加载中…'}</p>
          </div>
        ) : (
          <Stage active={activePage} harnessCase={harnessCase} />
        )}
        <aside className="pih-side">
          {harnessCase === undefined ? null : (
            <>
              <section>
                <h2>门禁判定</h2>
                <GateExplanation harnessCase={harnessCase} />
              </section>
              <section>
                <h2>诊断清单</h2>
                <div className="pih-toggle">
                  <label>
                    <input
                      checked={scope === 'page'}
                      name="pih-scope"
                      onChange={() => setScope('page')}
                      type="radio"
                    />{' '}
                    本页（{activePage?.diagnostics.length ?? 0}，去重{' '}
                    {activePage?.distinctDiagnosticCount ?? 0}）
                  </label>
                  <label>
                    <input
                      checked={scope === 'deck'}
                      name="pih-scope"
                      onChange={() => setScope('deck')}
                      type="radio"
                    />{' '}
                    全篇页级
                  </label>
                </div>
                <DiagnosticList diagnostics={shownDiagnostics} />
              </section>
              {harnessCase.documentDiagnostics.length === 0 ? null : (
                <section>
                  <h2>文档级诊断（非页级）</h2>
                  <DiagnosticList diagnostics={harnessCase.documentDiagnostics} />
                </section>
              )}
              <section>
                <h2>全篇汇总 code × severity</h2>
                <AggregateTable harnessCase={harnessCase} />
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
fetch('/cases.json')
  .then((response) => {
    if (!response.ok) throw new Error(`cases.json failed: HTTP ${response.status}`);
    return response.json() as Promise<PptxImportHarnessCaseSummary[]>;
  })
  .then((summaries) => root.render(<Harness summaries={summaries} />))
  .catch((cause: unknown) => {
    root.render(<pre>{cause instanceof Error ? cause.message : String(cause)}</pre>);
  });
