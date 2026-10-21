import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InteractiveScene } from '@reachany/reach-deck-dsl';
import { InteractiveScenePlayer } from '../../../packages/reach-deck-player/src/InteractiveScenePlayer.js';

type Tab = 'preview' | 'html' | 'json' | 'prompt';
type Busy = 'boot' | 'generate' | 'modify' | 'validate' | 'save' | 'load' | null;
type LogKind = 'event' | 'state' | 'system' | 'error';
interface LogEntry {
  id: number;
  time: string;
  kind: LogKind;
  label: string;
  detail?: string;
}
interface ApiStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
  promptVersion: string;
}
interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
}
interface Project extends ProjectSummary {
  scene: InteractiveScene;
  instruction?: string;
}
interface PromptResponse {
  version: string;
  text: string;
}
interface DeferredSwitch {
  label: string;
  run: () => void;
}

const sampleInstructions = [
  {
    label: '物理 · 单摆实验',
    text: '为初中学生生成一个单摆互动实验。可以调节摆长和重力加速度，观察周期变化；显示实时摆动和周期数值，并提供一个预测后验证的小问题。界面简洁，适合课堂投屏。',
  },
  {
    label: '数学 · 二次函数',
    text: '生成一个二次函数互动探索页。用滑块调节 a、b、c，实时绘制抛物线并显示顶点和对称轴。引导学生观察系数如何影响图像，并设置一项探索任务。',
  },
  {
    label: '化学 · 分子观察',
    text: '生成一个面向初中学生的水分子互动教学页面。展示分子结构，可以切换空间视角，点击原子查看名称，最后用一道选择题检查对结构的理解。',
  },
];
const playerCopy: Record<string, string> = {
  'reachDeck.player.interactive.startFailed': '互动页面未能启动',
  'reachDeck.player.interactive.startFailedHint': '页面初始化未完成，可以重新载入预览。',
  'reachDeck.player.interactive.authoringStartFailedHint':
    '请重新载入预览，或检查 HTML 和运行依赖。',
  'reachDeck.player.interactive.retry': '重新载入',
};
const translatePlayer = (key: string) => playerCopy[key] ?? key;
const tabNames: Record<Tab, string> = {
  preview: '互动预览',
  html: 'HTML 源码',
  json: '场景 JSON',
  prompt: '系统提示词',
};
const phaseNames: Record<string, string> = {
  booting: '初始化中',
  active: '正在运行',
  completed: '已完成',
  failed: '启动失败',
  disposed: '已释放',
  suspended: '已暂停',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const nested =
      record.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : {};
    const message =
      typeof record.error === 'string'
        ? record.error
        : typeof nested.message === 'string'
          ? nested.message
          : typeof record.message === 'string'
            ? record.message
            : `请求失败（${response.status}）。`;
    throw new Error(message);
  }
  return body as T;
}

const post = <T,>(path: string, body: unknown, signal?: AbortSignal) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body), signal });
const sceneJson = (scene: InteractiveScene) => JSON.stringify(scene, null, 2);
function downloadText(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
const safeFilename = (title: string) =>
  title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80) || 'genui-scene';

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    sparkle: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
        <path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5L20 2Z" />
      </>
    ),
    play: <path d="m9 5 11 7-11 7V5Z" />,
    code: (
      <>
        <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
      </>
    ),
    braces: (
      <>
        <path d="M9 3H7a2 2 0 0 0-2 2v4a3 3 0 0 1-2 3 3 3 0 0 1 2 3v4a2 2 0 0 0 2 2h2M15 3h2a2 2 0 0 1 2 2v4a3 3 0 0 0 2 3 3 3 0 0 0-2 3v4a2 2 0 0 1-2 2h-2" />
      </>
    ),
    prompt: (
      <>
        <path d="M4 4h16v12H9l-5 4V4Z" />
        <path d="M8 8h8M8 12h5" />
      </>
    ),
    save: (
      <>
        <path d="M4 3h13l4 4v14H3V3h1Z" />
        <path d="M7 3v6h10V3M7 21v-8h10v8" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),
    reset: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    folder: <path d="M3 6h7l2 3h9v12H3V6Z" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    activity: <path d="M2 12h5l3-9 4 18 3-9h5" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v1" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.code}
    </svg>
  );
}

class PlayerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="empty-state">
        <Icon name="info" size={30} />
        <h3>预览发生错误</h3>
        <p>请检查场景格式，然后重新载入预览。</p>
      </div>
    ) : (
      this.props.children
    );
  }
}

export default function App() {
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [originalPrompt, setOriginalPrompt] = useState<PromptResponse | null>(null);
  const [prompt, setPrompt] = useState('');
  const [scene, setScene] = useState<InteractiveScene | null>(null);
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [html, setHtml] = useState('');
  const [json, setJson] = useState('');
  const [tab, setTab] = useState<Tab>('preview');
  const [busy, setBusy] = useState<Busy>('boot');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [savedInstruction, setSavedInstruction] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [phase, setPhase] = useState('idle');
  const [attempt, setAttempt] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deferredSwitch, setDeferredSwitch] = useState<DeferredSwitch | null>(null);
  const [validation, setValidation] = useState<'valid' | 'pending' | 'invalid'>('pending');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const revisionRef = useRef(0);
  const logIdRef = useRef(0);
  const importRef = useRef<HTMLInputElement>(null);
  const htmlDirty = Boolean(scene && html !== scene.documentHtml);
  const jsonDirty = Boolean(scene && json !== sceneJson(scene));
  const editorDirty = htmlDirty || jsonDirty;
  const sceneDirty = Boolean(
    scene && (sceneJson(scene) !== savedFingerprint || title !== scene.title),
  );
  const projectDirty = sceneDirty || instruction !== savedInstruction;
  const promptDirty = Boolean(originalPrompt && prompt !== originalPrompt.text);
  const isGenerating = busy === 'generate' || busy === 'modify';
  const isBusy = busy !== null;

  const addLog = useCallback((kind: LogKind, label: string, detail?: unknown) => {
    let formatted: string | undefined;
    if (detail !== undefined) {
      try {
        formatted = (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1_600);
      } catch {
        formatted = '[无法序列化的数据]';
      }
    }
    const entry: LogEntry = {
      id: ++logIdRef.current,
      kind,
      label,
      detail: formatted,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
    setLogs((current) => [entry, ...current].slice(0, 80));
  }, []);

  const applyScene = useCallback(
    (
      next: InteractiveScene,
      options: { project?: Project; instruction?: string; pristine?: boolean } = {},
    ) => {
      revisionRef.current += 1;
      setScene(next);
      setHtml(next.documentHtml);
      setJson(sceneJson(next));
      setTitle(next.title);
      setAttempt((current) => current + 1);
      setValidation('valid');
      setError('');
      if (options.instruction !== undefined) setInstruction(options.instruction);
      if (options.project) {
        setProjectId(options.project.id);
        setSavedFingerprint(sceneJson(next));
        setSavedInstruction(options.project.instruction ?? options.instruction ?? '');
      } else if (options.pristine) {
        setProjectId(null);
        setSavedFingerprint(sceneJson(next));
        setSavedInstruction(options.instruction ?? '');
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      const results = await Promise.allSettled([
        api<ApiStatus>('/api/status', { signal }),
        api<PromptResponse>('/api/prompts', { signal }),
        api<{ projects: ProjectSummary[] }>('/api/projects', { signal }),
        api<{ scene: InteractiveScene }>('/api/demo', { signal }),
      ]);
      if (signal.aborted) return;
      const [statusResult, promptResult, projectsResult, demoResult] = results;
      if (statusResult.status === 'fulfilled') setStatus(statusResult.value);
      if (promptResult.status === 'fulfilled') {
        setOriginalPrompt(promptResult.value);
        setPrompt(promptResult.value.text);
      }
      if (projectsResult.status === 'fulfilled') setProjects(projectsResult.value.projects);
      if (demoResult.status === 'fulfilled') {
        try {
          const checked = await post<{ scene: InteractiveScene }>(
            '/api/validate',
            { scene: demoResult.value.scene },
            signal,
          );
          if (signal.aborted) return;
          applyScene(checked.scene, { pristine: true });
          addLog('system', '已载入本地演示', '拖动滑块或操作预览，查看桥接事件和状态。');
        } catch (err) {
          if (!signal.aborted) setError(errorMessage(err));
        }
      } else setError('工作台服务暂时无法连接，请确认已执行 pnpm dev。');
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed > 0) addLog('error', '部分初始化请求未完成', '请检查本地服务终端输出后刷新页面。');
      if (!signal.aborted) setBusy(null);
    })();
    return () => controller.abort();
  }, [addLog, applyScene]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!editorDirty && !projectDirty && !promptDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editorDirty, projectDirty, promptDirty]);

  async function refreshStatus() {
    try {
      setStatus(await api<ApiStatus>('/api/status'));
      setNotice('配置状态已刷新；修改 .env 后请先重启服务。');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function guardSwitch(label: string, run: () => void, includeInstruction = true) {
    if (editorDirty || (includeInstruction ? projectDirty : sceneDirty))
      setDeferredSwitch({ label, run });
    else run();
  }

  async function loadDemo() {
    setBusy('load');
    setError('');
    try {
      const loaded = await api<{ scene: InteractiveScene }>('/api/demo');
      const checked = await post<{ scene: InteractiveScene }>('/api/validate', {
        scene: loaded.scene,
      });
      applyScene(checked.scene, { pristine: true, instruction: '' });
      setTab('preview');
      addLog('system', '已重新载入离线演示');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function generate(modify: boolean) {
    if (!instruction.trim() || (modify && !scene)) return;
    if (editorDirty) {
      setError('请先校验并应用源码修改，或撤销草稿，再开始生成。');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const revision = revisionRef.current;
    setBusy(modify ? 'modify' : 'generate');
    setError('');
    setNotice('');
    addLog('system', modify ? '开始修改当前场景' : '开始生成新场景');
    try {
      const result = await post<{ scene: InteractiveScene; promptVersion: string }>(
        '/api/generate',
        {
          instruction: instruction.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(modify ? { scene } : {}),
          ...(promptDirty ? { systemPrompt: prompt } : {}),
        },
        controller.signal,
      );
      const checked = await post<{ scene: InteractiveScene }>(
        '/api/validate',
        { scene: result.scene },
        controller.signal,
      );
      if (revision !== revisionRef.current || controller.signal.aborted) return;
      if (!modify) {
        setProjectId(null);
        setSavedFingerprint('');
      }
      applyScene(checked.scene);
      setTab('preview');
      setNotice(modify ? '场景已修改，并通过校验。' : '场景已生成，并通过校验。');
      addLog('system', modify ? '场景修改完成' : '场景生成完成', {
        promptVersion: result.promptVersion,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        setNotice('已取消生成，当前场景已保留。');
        addLog('system', '已取消本次生成');
      } else {
        setError(errorMessage(err));
        addLog('error', '生成未完成', errorMessage(err));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
    }
  }

  async function validateDraft() {
    setBusy('validate');
    setError('');
    try {
      const body =
        tab === 'json'
          ? { scene: JSON.parse(json) as unknown }
          : { scene: { ...scene, title: title.trim() || scene?.title, documentHtml: html } };
      const checked = await post<{ scene: InteractiveScene }>('/api/validate', body);
      applyScene(checked.scene);
      setNotice('校验通过，预览已更新。');
      addLog('system', '源码校验通过');
    } catch (err) {
      setValidation('invalid');
      setError(errorMessage(err));
      addLog('error', '源码校验未通过', errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function importFile(file: File) {
    if (file.size > 2_000_000) {
      setError('文件过大，请选择小于 2 MB 的 HTML 或场景 JSON。');
      return;
    }
    setBusy('validate');
    setError('');
    try {
      const content = await file.text();
      const isJson = file.name.toLowerCase().endsWith('.json');
      const body = isJson
        ? { scene: JSON.parse(content) as unknown }
        : { html: content, title: file.name.replace(/\.[^.]+$/, '') };
      const checked = await post<{ scene: InteractiveScene }>('/api/validate', body);
      setProjectId(null);
      setSavedFingerprint('');
      applyScene(checked.scene);
      setTab('preview');
      addLog('system', '文件导入并通过校验', file.name);
      setNotice('文件已导入。');
    } catch (err) {
      setError(errorMessage(err));
      addLog('error', '文件导入未完成', errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveProject() {
    if (!scene) return;
    if (editorDirty) {
      setError('请先校验并应用源码修改，再保存项目。');
      return;
    }
    setBusy('save');
    setError('');
    try {
      const checked = await post<{ scene: InteractiveScene }>('/api/validate', {
        scene: { ...scene, title: title.trim() || scene.title },
      });
      const { project } = await post<{ project: Project }>('/api/projects', {
        ...(projectId ? { id: projectId } : {}),
        title: checked.scene.title,
        scene: checked.scene,
        instruction,
      });
      applyScene(checked.scene, { project });
      const list = await api<{ projects: ProjectSummary[] }>('/api/projects');
      setProjects(list.projects);
      setNotice('项目已保存到本地。');
      addLog('system', '项目已保存', project.title);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadProject(id: string) {
    setBusy('load');
    setError('');
    try {
      const { project } = await api<{ project: Project }>(
        `/api/projects/${encodeURIComponent(id)}`,
      );
      const checked = await post<{ scene: InteractiveScene }>('/api/validate', {
        scene: project.scene,
      });
      applyScene(checked.scene, { project, instruction: project.instruction ?? '' });
      setTab('preview');
      addLog('system', '已载入本地项目', project.title);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function editHtml(value: string) {
    setHtml(value);
    setValidation('pending');
    revisionRef.current += 1;
  }
  function editJson(value: string) {
    setJson(value);
    setValidation('pending');
    revisionRef.current += 1;
  }
  function undoDrafts() {
    if (scene) {
      setHtml(scene.documentHtml);
      setJson(sceneJson(scene));
      setValidation('valid');
      setError('');
    }
  }
  const onPhaseChange = useCallback(
    (next: string) => {
      setPhase(next);
      addLog(next === 'failed' ? 'error' : 'system', `预览 · ${phaseNames[next] ?? next}`);
    },
    [addLog],
  );
  const onInteraction = useCallback(
    (event: unknown) => addLog('event', '学习交互事件', event),
    [addLog],
  );
  const onStateChange = useCallback(
    (snapshot: unknown) => addLog('state', '场景状态更新', snapshot),
    [addLog],
  );
  const onPlayerError = useCallback(
    (event: { code: string; detail?: unknown }) => addLog('error', event.code, event.detail),
    [addLog],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            G<span>↗</span>
          </div>
          <div>
            <div className="brand-title">
              GenUI <span>工作台</span>
            </div>
            <div className="brand-subtitle">REACHACADEMY / INTERACTIVE LAB</div>
          </div>
        </div>
        <div className="header-context">
          <span className="header-divider" />
          <span>从教学想法，到可交互的课堂</span>
        </div>
        <button
          className={`configuration-badge ${status?.configured ? 'configured' : ''}`}
          onClick={() => void refreshStatus()}
          title="刷新服务端模型配置状态"
        >
          <span className="status-dot" />
          {status
            ? status.configured
              ? `模型已配置 · ${status.model || 'OpenAI 兼容接口'}`
              : '演示模式 · 待配置 API'
            : '正在连接本地服务'}
        </button>
      </header>

      <div className="workspace">
        <aside className="creation-panel" aria-label="创作设置">
          <div className="panel-scroll">
            <div className="section-eyebrow">CREATE SOMETHING INTERACTIVE</div>
            <h1>设计一次探索</h1>
            <p className="section-intro">
              描述教学目标和互动方式，
              <br />
              让想法成为可以动手的页面。
            </p>
            <label className="field-label" htmlFor="scene-title">
              场景名称 <span>可选</span>
            </label>
            <input
              id="scene-title"
              className="text-input"
              value={title}
              maxLength={160}
              placeholder="例如：探索单摆的运动规律"
              disabled={isBusy}
              onChange={(event) => setTitle(event.target.value)}
            />
            <label className="field-label instruction-label" htmlFor="instruction">
              创作需求 <span>生成或修改指令</span>
            </label>
            <textarea
              id="instruction"
              className="instruction-input"
              value={instruction}
              maxLength={16_000}
              placeholder={
                '想教什么？希望学生如何参与？\n\n例如：设计一个单摆实验，通过调节摆长，探索周期的变化规律。'
              }
              onChange={(event) => setInstruction(event.target.value)}
              disabled={isBusy}
            />
            <div className="instruction-footer">
              <span>目标 · 操作 · 反馈</span>
              <span>{instruction.length.toLocaleString()} / 16,000</span>
            </div>
            <div className="sample-prompts" aria-label="示例需求">
              {sampleInstructions.map((sample) => (
                <button
                  key={sample.label}
                  disabled={isBusy}
                  onClick={() => setInstruction(sample.text)}
                >
                  {sample.label}
                  <span>↗</span>
                </button>
              ))}
            </div>
            {isGenerating ? (
              <button
                className="button button-primary generation-button"
                onClick={() => abortRef.current?.abort()}
              >
                <span className="spinner" />
                {busy === 'modify' ? '正在修改场景' : '正在生成场景'}
                <span className="cancel-label">取消</span>
              </button>
            ) : (
              <button
                className="button button-primary generation-button"
                disabled={
                  isBusy ||
                  !instruction.trim() ||
                  !status?.configured ||
                  !prompt.trim() ||
                  editorDirty
                }
                onClick={() => guardSwitch('生成新场景', () => void generate(false), false)}
              >
                <Icon name="sparkle" />
                生成新场景
                <Icon name="arrow" size={16} />
              </button>
            )}
            <button
              className="button button-secondary modify-button"
              disabled={
                isBusy ||
                !scene ||
                !instruction.trim() ||
                !status?.configured ||
                !prompt.trim() ||
                editorDirty
              }
              onClick={() => void generate(true)}
            >
              <Icon name="prompt" size={16} />
              基于当前场景修改
            </button>
            {!status?.configured && (
              <div className="config-hint">
                <Icon name="info" size={15} />
                <span>
                  在项目根目录 <code>.env</code> 填入 API
                  配置并重启服务，即可生成。演示、导入和编辑无需 API Key。
                </span>
              </div>
            )}

            <div className="section-rule" />
            <div className="section-heading">
              <h2>
                <Icon name="folder" size={16} />
                本地项目
              </h2>
              <span>{projects.length.toString().padStart(2, '0')}</span>
            </div>
            <button
              className="demo-project"
              disabled={isBusy}
              onClick={() => guardSwitch('载入离线演示', () => void loadDemo())}
            >
              <span className="demo-project-icon">
                <Icon name="play" size={17} />
              </span>
              <span>
                <strong>先体验一个互动实验</strong>
                <small>离线演示 · 无需 API Key</small>
              </span>
              <Icon name="arrow" size={16} />
            </button>
            <div className="project-list">
              {projects.length === 0 ? (
                <p className="empty-projects">
                  保存后的场景会出现在这里。
                  <br />
                  项目文件保存在你的本地电脑。
                </p>
              ) : (
                projects.map((project) => (
                  <button
                    key={project.id}
                    className={`project-row ${projectId === project.id ? 'active' : ''}`}
                    disabled={isBusy}
                    onClick={() => guardSwitch('载入本地项目', () => void loadProject(project.id))}
                  >
                    <Icon name="code" size={16} />
                    <span>
                      <strong>{project.title}</strong>
                      <small>
                        {new Date(project.updatedAt).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </small>
                    </span>
                    {projectId === project.id && <span className="project-current" />}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="sidebar-footer">
            <span className="local-dot" />
            本地工作空间<span>v1.0</span>
          </div>
        </aside>

        <main className="main-panel">
          <div className="document-toolbar">
            <div className="document-name">
              <span className="document-icon">
                <Icon name="code" size={20} />
              </span>
              <div>
                <h2>{scene?.title || '新的互动场景'}</h2>
                <div className="document-meta">
                  Interactive Scene / V2 <span>·</span>{' '}
                  {editorDirty
                    ? '源码草稿待校验'
                    : projectDirty
                      ? '尚未保存'
                      : projectId
                        ? '已保存到本地'
                        : '本地演示'}
                </div>
              </div>
            </div>
            <div className="document-actions">
              <button
                className="button button-subtle"
                disabled={!scene || isBusy || editorDirty}
                onClick={() => void saveProject()}
                aria-label="保存项目"
              >
                <Icon name="save" size={16} />
                <span>{busy === 'save' ? '保存中…' : '保存项目'}</span>
              </button>
              <button
                className="button button-subtle import-button"
                disabled={isBusy}
                onClick={() => guardSwitch('导入场景文件', () => importRef.current?.click())}
                aria-label="导入场景"
              >
                <Icon name="upload" size={16} />
                <span>导入</span>
              </button>
              <button
                className="button button-subtle inspector-toggle"
                aria-label="打开场景检查器和导出"
                onClick={() => setInspectorOpen(true)}
              >
                <Icon name="activity" size={16} />
              </button>
            </div>
          </div>

          {error && (
            <div className="message-banner error-banner" role="alert">
              <Icon name="info" size={17} />
              <span>{error}</span>
              <button aria-label="关闭错误提示" onClick={() => setError('')}>
                <Icon name="close" size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div className="message-banner notice-banner" role="status">
              <Icon name="check" size={17} />
              <span>{notice}</span>
              <button aria-label="关闭操作提示" onClick={() => setNotice('')}>
                <Icon name="close" size={15} />
              </button>
            </div>
          )}

          <div className="tabbar">
            <div className="tabs" role="tablist" aria-label="场景视图">
              {(Object.keys(tabNames) as Tab[]).map((value) => (
                <button
                  key={value}
                  id={`tab-${value}`}
                  role="tab"
                  aria-selected={tab === value}
                  aria-controls={`panel-${value}`}
                  className={tab === value ? 'active' : ''}
                  onClick={() => setTab(value)}
                >
                  <Icon
                    name={
                      value === 'preview'
                        ? 'play'
                        : value === 'html'
                          ? 'code'
                          : value === 'json'
                            ? 'braces'
                            : 'prompt'
                    }
                    size={16}
                  />
                  <span>{tabNames[value]}</span>
                  {((value === 'html' && htmlDirty) ||
                    (value === 'json' && jsonDirty) ||
                    (value === 'prompt' && promptDirty)) && <i className="draft-dot" />}
                </button>
              ))}
            </div>
            <span className="tabbar-label">GENUI CANVAS</span>
          </div>

          <section
            className="editor-area"
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
          >
            {tab === 'preview' ? (
              <>
                <div className="preview-toolbar">
                  <div className="preview-status">
                    <span className={`status-dot ${phase === 'active' ? 'live' : ''}`} />
                    {scene ? (phaseNames[phase] ?? '准备预览') : '等待场景'}
                    <span className="preview-size">沙箱运行 · 自适应画布</span>
                  </div>
                  <button
                    className="text-button"
                    disabled={!scene || isBusy}
                    onClick={() => {
                      setAttempt((current) => current + 1);
                      addLog('system', '已重置互动预览');
                    }}
                  >
                    <Icon name="reset" size={14} />
                    重置预览
                  </button>
                </div>
                <div className="preview-stage">
                  {scene ? (
                    <div className="preview-frame" data-testid="scene-preview">
                      <PlayerBoundary key={`${scene.id}-${attempt}`}>
                        <InteractiveScenePlayer
                          scene={scene}
                          attempt={attempt}
                          sourceRevision={attempt}
                          locale="zh-CN"
                          translate={translatePlayer}
                          dependencyBaseUrl={window.location.origin}
                          onPhaseChange={onPhaseChange}
                          onInteraction={onInteraction}
                          onStateChange={onStateChange}
                          onError={onPlayerError}
                          onComplete={(payload) => addLog('event', '互动完成', payload)}
                        />
                      </PlayerBoundary>
                    </div>
                  ) : (
                    <div className="empty-state">
                      <div className="empty-orbit">
                        <Icon name="sparkle" size={32} />
                      </div>
                      <h3>{busy === 'boot' ? '正在准备工作台' : '让课堂想法，变得可以互动'}</h3>
                      <p>
                        从左侧描述需求，或载入一个离线演示。
                        <br />
                        每个场景都是可独立导出的 HTML 页面。
                      </p>
                      <button
                        className="button button-secondary"
                        disabled={isBusy}
                        onClick={() => void loadDemo()}
                      >
                        <Icon name="play" size={16} />
                        体验离线演示
                      </button>
                    </div>
                  )}
                </div>
                <div className="canvas-footer">
                  <span>
                    <Icon name="check" size={13} />
                    原版 Reach Interactive 播放器
                  </span>
                  <span>HTML + CSS + JavaScript</span>
                </div>
              </>
            ) : tab === 'html' || tab === 'json' ? (
              <>
                <div className="source-toolbar">
                  <div>
                    <span className="file-type">{tab.toUpperCase()}</span>
                    <span>{tab === 'html' ? 'document.html' : 'interactive-scene.json'}</span>
                    <span className="source-lines">
                      {(tab === 'html' ? html : json).split('\n').length} 行
                    </span>
                  </div>
                  <div>
                    <button
                      className="text-button"
                      disabled={!editorDirty || isBusy}
                      onClick={undoDrafts}
                    >
                      <Icon name="reset" size={14} />
                      撤销草稿
                    </button>
                    <button
                      className="button button-small button-primary"
                      disabled={!scene || isBusy || (tab === 'html' ? !htmlDirty : !jsonDirty)}
                      onClick={() => void validateDraft()}
                    >
                      {busy === 'validate' ? (
                        <span className="spinner" />
                      ) : (
                        <Icon name="check" size={14} />
                      )}
                      校验并应用
                    </button>
                  </div>
                </div>
                <div className="code-editor-wrap">
                  <textarea
                    className="code-editor"
                    aria-label={tab === 'html' ? 'HTML 源码编辑器' : '场景 JSON 编辑器'}
                    spellCheck={false}
                    value={tab === 'html' ? html : json}
                    disabled={!scene || isBusy || (tab === 'html' ? jsonDirty : htmlDirty)}
                    onChange={(event) =>
                      tab === 'html' ? editHtml(event.target.value) : editJson(event.target.value)
                    }
                  />
                </div>
                <div className="source-footer">
                  <Icon name="info" size={13} />
                  <span>
                    {(tab === 'html' ? jsonDirty : htmlDirty)
                      ? '另一个源码视图有待处理草稿，请先在那里校验并应用，或撤销草稿。'
                      : '修改后先校验并应用，再预览、保存或导出。校验失败会保留上一次有效场景。'}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="source-toolbar prompt-toolbar">
                  <div>
                    <span className="file-type">PROMPT</span>
                    <span title={originalPrompt?.version}>
                      {originalPrompt?.version || '正在读取原版提示词'}
                    </span>
                  </div>
                  <button
                    className="text-button"
                    disabled={!promptDirty || isBusy}
                    onClick={() => {
                      if (originalPrompt) setPrompt(originalPrompt.text);
                      setNotice('已恢复原版系统提示词。');
                    }}
                  >
                    <Icon name="reset" size={14} />
                    恢复原版
                  </button>
                </div>
                <div className="prompt-note">
                  <Icon name="prompt" size={18} />
                  <div>
                    <strong>生成行为，由你掌控</strong>
                    <p>
                      这里是后端提供的默认系统提示词。修改仅应用于本次工作台会话中的后续生成；API
                      Key 始终保留在服务端。
                    </p>
                  </div>
                  {promptDirty && <span className="custom-badge">自定义</span>}
                </div>
                <div className="code-editor-wrap">
                  <textarea
                    className="code-editor prompt-editor"
                    aria-label="系统提示词编辑器"
                    spellCheck={false}
                    value={prompt}
                    disabled={!originalPrompt || isBusy}
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                </div>
                <div className="source-footer">
                  <span>{prompt.length.toLocaleString()} 个字符</span>
                  <span>恢复原版可随时撤销提示词修改</span>
                </div>
              </>
            )}
          </section>
        </main>

        {inspectorOpen && (
          <button
            className="inspector-backdrop"
            aria-label="关闭场景检查器"
            onClick={() => setInspectorOpen(false)}
          />
        )}
        <aside
          className={`inspector-panel ${inspectorOpen ? 'is-open' : ''}`}
          aria-label="场景检查器"
        >
          <div className="inspector-scroll">
            <div className="inspector-title">
              <Icon name="activity" size={17} />
              <h2>场景检查器</h2>
              <button
                className="text-button inspector-close"
                aria-label="关闭场景检查器"
                onClick={() => setInspectorOpen(false)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div
              className={`validation-card ${validation === 'valid' && scene ? 'valid' : validation === 'invalid' ? 'invalid' : ''}`}
            >
              <span className="validation-icon">
                <Icon name={validation === 'valid' && scene ? 'check' : 'info'} size={19} />
              </span>
              <div>
                <strong>
                  {validation === 'valid' && scene
                    ? '场景校验通过'
                    : validation === 'invalid'
                      ? '草稿需要修正'
                      : editorDirty
                        ? '草稿等待校验'
                        : '等待场景载入'}
                </strong>
                <p>
                  {validation === 'valid' && scene
                    ? '结构、HTML 与运行依赖已检查'
                    : '通过校验后才会更新互动预览'}
                </p>
              </div>
            </div>
            <dl className="scene-facts">
              <div>
                <dt>协议</dt>
                <dd>Interactive V2</dd>
              </div>
              <div>
                <dt>桥接版本</dt>
                <dd>Bridge V1</dd>
              </div>
              <div>
                <dt>运行依赖</dt>
                <dd>{scene?.runtimeDependencies?.length ?? 0} 项</dd>
              </div>
              <div>
                <dt>事件声明</dt>
                <dd>{scene?.eventManifest.events.length ?? 0} 项</dd>
              </div>
              <div>
                <dt>完成方式</dt>
                <dd>
                  {scene
                    ? ({ explicit: '主动提交', automatic: '自动完成', none: '自由探索' } as const)[
                        scene.runtimePolicy.completionMode
                      ]
                    : '—'}
                </dd>
              </div>
            </dl>
            <div className="export-section">
              <h3>导出场景</h3>
              <div>
                <button
                  className="button button-secondary"
                  disabled={!scene || editorDirty || isBusy}
                  onClick={() =>
                    scene &&
                    downloadText(
                      sceneJson(scene),
                      `${safeFilename(scene.title)}.json`,
                      'application/json;charset=utf-8',
                    )
                  }
                >
                  <Icon name="download" size={15} />
                  JSON
                </button>
                <button
                  className="button button-secondary"
                  disabled={!scene || editorDirty || isBusy}
                  onClick={() =>
                    scene &&
                    downloadText(
                      scene.documentHtml,
                      `${safeFilename(scene.title)}.html`,
                      'text/html;charset=utf-8',
                    )
                  }
                >
                  <Icon name="download" size={15} />
                  HTML
                </button>
              </div>
              <p>
                JSON 保留完整协议、事件和依赖。
                <br />
                HTML 仅包含页面源码。
              </p>
            </div>
            <div className="event-heading">
              <h3>
                运行日志 <span>{logs.length}</span>
              </h3>
              <button
                className="text-button"
                disabled={logs.length === 0}
                onClick={() => setLogs([])}
              >
                清空
              </button>
            </div>
            <div className="event-list" aria-label="互动运行日志" data-testid="event-log">
              {logs.length === 0 ? (
                <div className="empty-logs">
                  <Icon name="activity" size={24} />
                  <p>
                    操作互动页面，
                    <br />
                    在这里观察事件和状态。
                  </p>
                </div>
              ) : (
                logs.map((log) => (
                  <details className={`log-entry log-${log.kind}`} key={log.id}>
                    <summary>
                      <span className="log-dot" />
                      <span className="log-label">{log.label}</span>
                      <time>{log.time}</time>
                    </summary>
                    {log.detail && <pre>{log.detail}</pre>}
                  </details>
                ))
              )}
            </div>
          </div>
          <div className="inspector-footer">
            <Icon name="info" size={13} />
            <span>最近 80 条 · 仅当前会话</span>
          </div>
        </aside>
      </div>

      <input
        className="file-input"
        type="file"
        accept=".json,.html,.htm,application/json,text/html"
        ref={importRef}
        aria-label="导入 HTML 或场景 JSON 文件"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFile(file);
        }}
      />
      {deferredSwitch && (
        <div className="modal-backdrop">
          <div
            className="switch-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="switch-title"
          >
            <div className="dialog-icon">
              <Icon name="info" size={24} />
            </div>
            <h2 id="switch-title">当前场景有未保存的修改</h2>
            <p>
              “{deferredSwitch.label}”会替换当前场景。你可以先保留当前内容，校验并保存后再继续。
            </p>
            <div>
              <button
                className="button button-secondary"
                autoFocus
                onClick={() => setDeferredSwitch(null)}
              >
                保留当前
              </button>
              <button
                className="button button-primary"
                onClick={() => {
                  const action = deferredSwitch.run;
                  setDeferredSwitch(null);
                  action();
                }}
              >
                继续操作
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
