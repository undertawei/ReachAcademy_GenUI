import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import { REACH_DECK_MESSAGES } from '../../../../apps/student/src/lib/reach-deck-i18n.js';
import {
  ReachDeckPlayer,
  type ReachDeckPlayerActivity,
  type ReachDeckPlayerEvent,
  type ReachDeckRuntimeByPageId,
  type ReachDeckSceneRuntimeState,
} from '@reachany/reach-deck-player';

interface HarnessConfig {
  source: 'cloud-generation' | 'document-file' | 'fixture';
  timingSource: 'document' | 'uniform-preview';
  validatesTtsAlignment: boolean;
  resourceUrlsById: Record<string, string>;
}

interface HarnessLogEntry {
  at: string;
  kind: 'activity' | 'event' | 'page' | 'runtime';
  detail: unknown;
}

interface HarnessState {
  activePageId?: string;
  currentTime: number;
  playing: boolean;
  logs: HarnessLogEntry[];
}

declare global {
  interface Window {
    __REACH_DECK_HARNESS_STATE__: HarnessState;
    __REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__: ReachDeckRuntimeByPageId;
    __REACH_DECK_HARNESS_REMOUNT__: (runtime?: ReachDeckRuntimeByPageId) => void;
  }
}

const initialState: HarnessState = { currentTime: 0, playing: false, logs: [] };
window.__REACH_DECK_HARNESS_STATE__ = initialState;

const appendLog = (
  setLogs: Dispatch<SetStateAction<HarnessLogEntry[]>>,
  kind: HarnessLogEntry['kind'],
  detail: unknown,
) => {
  setLogs((current) => [...current.slice(-79), { at: new Date().toISOString(), kind, detail }]);
};

function Harness({ config, document }: { config: HarnessConfig; document: ReachDeckDocument }) {
  const orderedPages = useMemo(
    () => [...document.pages].sort((left, right) => left.order - right.order),
    [document],
  );
  const [activePageId, setActivePageId] = useState(orderedPages[0]?.pageId);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [logs, setLogs] = useState<HarnessLogEntry[]>([]);
  const geometry = document.id === 'reach-deck-geometry-p2';
  const [locale, setLocale] = useState<'en-US' | 'zh-CN'>(geometry ? 'en-US' : 'zh-CN');
  const runtimeRef = useRef<ReachDeckRuntimeByPageId>({});
  const [playerMount, setPlayerMount] = useState<{
    generation: number;
    initialRuntimeByPageId: ReachDeckRuntimeByPageId;
  }>({ generation: 0, initialRuntimeByPageId: {} });

  useEffect(() => {
    window.__REACH_DECK_HARNESS_STATE__ = { activePageId, currentTime, playing, logs };
  }, [activePageId, currentTime, logs, playing]);

  useEffect(() => {
    window.__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__ = runtimeRef.current;
    window.__REACH_DECK_HARNESS_REMOUNT__ = (runtime) => {
      const initialRuntimeByPageId = structuredClone(runtime ?? runtimeRef.current);
      runtimeRef.current = initialRuntimeByPageId;
      window.__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__ = runtimeRef.current;
      setPlayerMount((current) => ({
        generation: current.generation + 1,
        initialRuntimeByPageId,
      }));
    };
  }, []);

  const changePage = (page: ReachDeckPublishedPage) => {
    setActivePageId(page.pageId);
    appendLog(setLogs, 'page', { pageId: page.pageId, sceneType: page.sceneType });
  };
  const recordActivity = (activity: ReachDeckPlayerActivity) => {
    appendLog(setLogs, 'activity', activity);
  };
  const recordEvent = (event: ReachDeckPlayerEvent) => appendLog(setLogs, 'event', event);
  const recordRuntime = (pageId: string, state: ReachDeckSceneRuntimeState) => {
    runtimeRef.current = { ...runtimeRef.current, [pageId]: state };
    window.__REACH_DECK_HARNESS_RUNTIME_BY_PAGE_ID__ = runtimeRef.current;
    appendLog(setLogs, 'runtime', { pageId, state });
  };

  return (
    <main className="harness-shell">
      <header className="harness-header">
        <div>
          <strong>Reach Deck Player harness</strong>
          <span>
            {config.source} · {config.timingSource} · TTS alignment:{' '}
            {config.validatesTtsAlignment ? 'validated' : 'not validated'}
          </span>
        </div>
        <nav aria-label="Harness page navigation">
          {geometry ? (
            <>
              <select
                aria-label="Experiment"
                data-harness-page-select
                value={activePageId}
                onChange={(event) => setActivePageId(event.target.value)}
              >
                {orderedPages.map((page) => (
                  <option key={page.pageId} value={page.pageId}>
                    {page.title}
                  </option>
                ))}
              </select>
              <select
                aria-label="Language"
                data-harness-locale
                value={locale}
                onChange={(event) => setLocale(event.target.value as 'en-US' | 'zh-CN')}
              >
                <option value="en-US">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </>
          ) : (
            orderedPages.map((page) => (
              <button
                aria-current={page.pageId === activePageId ? 'page' : undefined}
                data-harness-page-id={page.pageId}
                key={page.pageId}
                onClick={() => setActivePageId(page.pageId)}
                type="button"
              >
                {page.order}. {page.title}
              </button>
            ))
          )}
        </nav>
      </header>
      <section className="harness-player" data-harness-player>
        <ReachDeckPlayer
          activePageId={activePageId}
          document={document}
          locale={locale}
          translate={(key) => REACH_DECK_MESSAGES[locale][key] ?? key}
          hideNativeDiagnostics
          initialRuntimeByPageId={playerMount.initialRuntimeByPageId}
          key={playerMount.generation}
          nativeResourceUrlsById={config.resourceUrlsById}
          onActivityChange={recordActivity}
          onCurrentTimeChange={setCurrentTime}
          onEvent={recordEvent}
          onPageChange={changePage}
          onPlayingChange={setPlaying}
          onRuntimeStateChange={recordRuntime}
          reducedMotion={new URLSearchParams(window.location.search).has('reduced-motion')}
          scientificDependencyBaseUrl={window.location.origin}
          showNativeTimeline
        />
      </section>
      <aside className="harness-evidence" aria-label="Harness runtime evidence">
        <div>
          <b data-harness-page>{activePageId ?? 'none'}</b>
          <span data-harness-time>{currentTime.toFixed(2)}s</span>
          <span data-harness-playing>{playing ? 'playing' : 'paused'}</span>
        </div>
        <pre data-harness-log>{JSON.stringify(logs.slice(-12), null, 2)}</pre>
      </aside>
    </main>
  );
}

const root = createRoot(document.getElementById('root')!);
Promise.all([
  fetch('/document.json').then((response) => {
    if (!response.ok) throw new Error(`document.json failed with HTTP ${response.status}`);
    return response.json() as Promise<ReachDeckDocument>;
  }),
  fetch('/harness-config.json').then((response) => {
    if (!response.ok) throw new Error(`harness-config.json failed with HTTP ${response.status}`);
    return response.json() as Promise<HarnessConfig>;
  }),
])
  .then(([documentValue, config]) =>
    root.render(<Harness config={config} document={documentValue} />),
  )
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    root.render(<pre data-harness-load-error>{message}</pre>);
  });
