import { useEffect, useRef, useState } from 'react';
import { ReachDeckPlayer } from '@reachany/reach-deck-player';
import { compileHarnessIframe, prepareHarnessHtml } from './html-layout/browser-adapter.js';

interface LayoutConfig {
  model: string;
  corePrompt: string;
  fontCss: string;
  referenceOptions: { id: string; name: string }[];
  sampleHtml: string;
}

type CompiledLayout = Awaited<ReturnType<typeof compileHarnessIframe>>;
type Tab = 'html' | 'deck' | 'source' | 'json' | 'prompt' | 'diagnostics';
const TABS: { id: Tab; label: string }[] = [
  { id: 'html', label: 'HTML 预览' },
  { id: 'deck', label: 'Deck 预览' },
  { id: 'source', label: 'HTML 源码' },
  { id: 'json', label: 'V2 JSON' },
  { id: 'prompt', label: '完整提示词' },
  { id: 'diagnostics', label: '诊断' },
];

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      message = parsed.error ?? parsed.message ?? body;
    } catch {
      // The local server may return a plain-text error.
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function HtmlLayoutPreview({ source }: { source: string }) {
  const [config, setConfig] = useState<LayoutConfig>();
  const [referenceId, setReferenceId] = useState('');
  const [style, setStyle] = useState('');
  const [tab, setTab] = useState<Tab>('html');
  const [preview, setPreview] = useState<{ html: string; source: string; id: number }>();
  const [compiled, setCompiled] = useState<CompiledLayout>();
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [width, setWidth] = useState(800);
  const viewport = useRef<HTMLDivElement>(null);
  const version = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);

  async function loadHtml(html: string, fontCss: string) {
    const id = ++version.current;
    setError('');
    setCompiled(undefined);
    setCompiling(true);
    try {
      const prepared = await prepareHarnessHtml(html, fontCss);
      if (id !== version.current) return;
      setPreview({ html: prepared, source: html, id });
    } catch (cause) {
      if (id !== version.current) return;
      setError(`HTML 准备失败：${describe(cause)}`);
      setCompiling(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/harness/html-layout-config', { signal: controller.signal })
      .then(readResponse<LayoutConfig>)
      .then((next) => {
        if (controller.signal.aborted) return;
        setConfig(next);
        setModel(next.model);
        void loadHtml(next.sampleHtml, next.fontCss);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(`配置加载失败：${describe(cause)}`);
      });
    return () => {
      controller.abort();
      request.current?.abort();
      version.current += 1;
    };
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  async function generate() {
    if (!config) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/harness/html-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, referenceId: referenceId || undefined, style }),
        signal: controller.signal,
      });
      const result = await readResponse<{
        html: string;
        model: string;
        serializedModelInput: string;
      }>(response);
      if (controller.signal.aborted || request.current !== controller) return;
      setPrompt(result.serializedModelInput);
      setModel(result.model);
      setTab('html');
      await loadHtml(result.html, config.fontCss);
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) {
        setError(`版面生成失败：${describe(cause)}`);
      }
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }

  async function compile(iframe: HTMLIFrameElement, current: NonNullable<typeof preview>) {
    if (current.id !== version.current) return;
    try {
      const result = await compileHarnessIframe(iframe, current.source);
      if (current.id === version.current) setCompiled(result);
    } catch (cause) {
      if (current.id === version.current) setError(`V2 编译失败：${describe(cause)}`);
    } finally {
      if (current.id === version.current) setCompiling(false);
    }
  }

  return (
    <section className="html-layout-preview" data-html-layout-preview>
      {config && <style>{config.fontCss}</style>}
      <style>{`
        .html-layout-preview { min-width: 0; }
        .html-layout-preview .layout-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
        .html-layout-preview .layout-controls input { flex:1 1 200px; min-width:0; }
        .html-layout-preview .layout-tabs { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0; }
        .html-layout-preview .layout-tabs [aria-selected=true] { background:#166534; color:white; }
        .html-layout-preview pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:680px; overflow:auto; }
        .html-layout-preview .layout-viewport { width:100%; position:relative; aspect-ratio:16/9; background:#e5e7eb; overflow:hidden; }
        .html-layout-preview .layout-player { position:absolute; inset:0; }
        .html-layout-preview .layout-player > * { height:100%; }
      `}</style>
      <div className="layout-controls">
        <button
          type="button"
          data-variant="primary"
          disabled={!config || busy || !source.trim()}
          onClick={() => void generate()}
        >
          {busy ? '生成中…' : '生成版面'}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              request.current?.abort();
              request.current = undefined;
              setBusy(false);
            }}
          >
            取消
          </button>
        )}
        <button
          type="button"
          disabled={!config || busy}
          onClick={() => {
            if (!config) return;
            setPrompt('');
            setTab('html');
            void loadHtml(config.sampleHtml, config.fontCss);
          }}
        >
          载入示例
        </button>
        <select
          aria-label="布局参考"
          value={referenceId}
          onChange={(event) => setReferenceId(event.target.value)}
        >
          <option value="">无布局参考</option>
          {config?.referenceOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <input
          aria-label="风格要求"
          placeholder="风格要求（可选）"
          value={style}
          onChange={(event) => setStyle(event.target.value)}
        />
      </div>
      <div className="harness__hint" role="status">
        {model && `模型：${model}`}
        {compiling ? ' · 编译中…' : compiled ? ' · V2 编译完成' : ''}
      </div>
      {error && (
        <div className="banner" data-tone="error" role="alert">
          {error}
        </div>
      )}
      {compiled && compiled.diagnostics.length > 0 && (
        <div className="banner" role="alert">
          {compiled.diagnostics.join('\n')}
        </div>
      )}
      <div className="layout-tabs" role="tablist" aria-label="版面结果">
        {TABS.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            key={item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        ref={viewport}
        className="layout-viewport"
        style={
          tab === 'html' || tab === 'deck'
            ? undefined
            : { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' }
        }
      >
        {preview && (
          <iframe
            key={preview.id}
            title="HTML 版面预览"
            sandbox="allow-same-origin"
            srcDoc={preview.html}
            onLoad={(event) => void compile(event.currentTarget, preview)}
            style={{
              position: 'absolute',
              width: 1600,
              height: 900,
              border: 0,
              transform: `scale(${width / 1600})`,
              transformOrigin: 'top left',
              visibility: tab === 'html' ? 'visible' : 'hidden',
            }}
          />
        )}
        {compiled && tab === 'deck' && (
          <div className="layout-player">
            <ReachDeckPlayer
              document={compiled.document}
              locale="zh-CN"
              nativeResourceUrlsById={compiled.resourceUrlsById}
              hideNativeDiagnostics
              showStaticSlideWhenNotPlaying
              reducedMotion
            />
          </div>
        )}
      </div>
      {tab === 'source' && <pre>{preview?.source ?? ''}</pre>}
      {tab === 'json' && (
        <pre>{compiled ? JSON.stringify(compiled.document, null, 2) : '等待编译'}</pre>
      )}
      {tab === 'prompt' && <pre>{prompt || config?.corePrompt || ''}</pre>}
      {tab === 'diagnostics' && (
        <pre>
          {compiled
            ? JSON.stringify(
                { warnings: compiled.warnings, diagnostics: compiled.diagnostics },
                null,
                2,
              )
            : error || '等待编译'}
        </pre>
      )}
    </section>
  );
}
