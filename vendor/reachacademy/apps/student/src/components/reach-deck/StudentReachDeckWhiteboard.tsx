'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  Copy,
  Eraser,
  Hand,
  PenLine,
  Plus,
  Save,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import {
  ReachDeckPlayer,
  type QuizGradingByQuestionId,
  type ReachDeckAttachmentUrlResolver,
  type ReachDeckRuntimeByPageId,
  type ReachDeckSceneRuntimeState,
} from '@reachany/reach-deck-player';
import { Button, ConfirmDialog } from '@reachany/ui';

import type { PortalTranslator } from '@/src/lib/i18n';
import { hydrateReachDeckRuntimeImages } from '@/src/lib/reach-deck-runtime-images';
import {
  parseStudentDeckWhiteboard,
  parseStudentDeckWhiteboardList,
  type StudentDeckWhiteboard,
  type StudentDeckWhiteboardElement,
  type StudentDeckWhiteboardStroke,
  type StudentDeckWhiteboardSummary,
  type StudentDeckWhiteboardText,
} from '@/src/lib/public-v2-reach-deck-client';

import styles from './StudentReachDeckWhiteboard.module.css';

type Tool = 'pan' | 'pen' | 'eraser' | 'text';

export type StudentDeckAttachmentUrlResolver = (
  ...args: [...Parameters<ReachDeckAttachmentUrlResolver>, anchorAttemptId?: string]
) => ReturnType<ReachDeckAttachmentUrlResolver>;

/**
 * 白板参考画面需要的服务端批阅状态。白板里的 Deck 只读回放学生作答，必须和主播放器一样
 * 以服务端判分为准：未到终态或护栏未掌握时不揭示参考答案，也绝不在本地判分。
 */
export interface StudentDeckWhiteboardQuizGrading {
  quizGradingByPageId: Readonly<Record<string, QuizGradingByQuestionId>>;
  masteredLearningFenceQuestionIdsByPage: Readonly<Record<string, readonly string[]>>;
  renderQuizGradingFeedback?: (markdown: string) => ReactNode;
}

/** 冻结的 Deck 画面在白板世界坐标系中的固定位置（居中 800x450）。 */
const DECK_RECT = { height: 450, width: 800, x: -400, y: -225 };

interface StudentReachDeckWhiteboardProps {
  attemptId: string;
  currentTime: number;
  document: ReachDeckDocument;
  locale?: string;
  /**
   * 上浮列表在播放列中的停靠位置（像素，相对播放列）：底边贴控制条上沿，横向与播放器对齐，
   * 最大高度为控制条以上的可用高度。缺省时贴播放列底部、占满宽度。
   */
  dock?: StudentDeckWhiteboardDock;
  /** v2 原生媒体展示地址（resourceId → 短时签名 URL）。 */
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  onClose: () => void;
  page: ReachDeckPublishedPage;
  quizGrading: StudentDeckWhiteboardQuizGrading;
  readOnly: boolean;
  resolveAttachmentUrl: StudentDeckAttachmentUrlResolver;
  runtimeState?: ReachDeckSceneRuntimeState;
  t: PortalTranslator;
  /** 编辑画布打开/关闭：宿主据此暂停播放并锁定翻页（只展开列表不锁）。 */
  onEditingChange?: (editing: boolean) => void;
  /** 本页已保存的白板数（加载、保存、复制、删除后上报），用于控制条入口的计数。 */
  onBoardCountChange?: (count: number) => void;
}

export interface StudentDeckWhiteboardDock {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
}

interface Draft {
  anchorCurrentTime: number;
  anchorRuntimeState: Record<string, unknown>;
  dirty: boolean;
  elements: StudentDeckWhiteboardElement[];
  persisted: StudentDeckWhiteboard | null;
  whiteboardId: string;
}

export function StudentReachDeckWhiteboard({
  attemptId,
  currentTime,
  document,
  locale = 'en-US',
  dock,
  nativeResourceUrlsById,
  onBoardCountChange,
  onClose,
  onEditingChange,
  page,
  quizGrading,
  readOnly,
  resolveAttachmentUrl,
  runtimeState,
  t,
}: StudentReachDeckWhiteboardProps) {
  const [boards, setBoards] = useState<StudentDeckWhiteboardSummary[]>([]);
  const [previews, setPreviews] = useState<Record<string, StudentDeckWhiteboardElement[]>>({});
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState<
    { kind: 'delete'; board: StudentDeckWhiteboardSummary } | { kind: 'discard' }
  >();

  const editing = draft !== null;
  const editingChangeRef = useRef(onEditingChange);
  editingChangeRef.current = onEditingChange;
  useEffect(() => {
    editingChangeRef.current?.(editing);
  }, [editing]);
  // 卸载（关闭列表、换页）时画布必然已关闭，宿主据此解除翻页锁。
  useEffect(() => () => editingChangeRef.current?.(false), []);

  const countChangeRef = useRef(onBoardCountChange);
  countChangeRef.current = onBoardCountChange;
  useEffect(() => {
    if (!loading) countChangeRef.current?.(boards.length);
  }, [boards.length, loading]);

  const collectionUrl = studentDeckWhiteboardCollectionUrl(attemptId, page.pageId);
  const anchorAttemptId = draft?.persisted?.anchorAttemptId ?? attemptId;
  const resolveAnchorAttachmentUrl = useCallback<ReachDeckAttachmentUrlResolver>(
    (reference, disposition) => resolveAttachmentUrl(reference, disposition, anchorAttemptId),
    [anchorAttemptId, resolveAttachmentUrl],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(collectionUrl, { cache: 'no-store' });
      const body = await responseJson(response, t('reachDeck.whiteboard.loadFailed'));
      const parsed = parseStudentDeckWhiteboardList(body);
      setBoards(parsed.whiteboards);
      setLimit(parsed.limit);
      // 缩略图需要各白板的元素明细；并行按板拉取，单板失败只影响该板的预览。
      void Promise.all(
        parsed.whiteboards.map(async (summary) => {
          try {
            const detail = parseStudentDeckWhiteboard(
              await responseJson(
                await fetch(`${collectionUrl}/${summary.whiteboardId}`, { cache: 'no-store' }),
                t('reachDeck.whiteboard.loadFailed'),
              ),
            );
            setPreviews((current) => ({ ...current, [detail.whiteboardId]: detail.elements }));
          } catch {
            // 预览缺失时缩略图退化为占位块，打开白板时仍会重新加载明细。
          }
        }),
      );
    } catch {
      setError(t('reachDeck.whiteboard.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [collectionUrl, t]);

  useEffect(() => void load(), [load]);

  const newDraft = () => {
    setError(null);
    setDraft({
      anchorCurrentTime: currentTime,
      anchorRuntimeState: runtimeState
        ? (structuredClone(runtimeState) as unknown as Record<string, unknown>)
        : {},
      dirty: false,
      elements: [],
      persisted: null,
      whiteboardId: globalThis.crypto.randomUUID(),
    });
  };

  const edit = (board: StudentDeckWhiteboard) => {
    setError(null);
    setDraft({
      anchorCurrentTime: board.anchorCurrentTime,
      anchorRuntimeState: structuredClone(board.anchorRuntimeState),
      dirty: false,
      elements: structuredClone(board.elements),
      persisted: board,
      whiteboardId: board.whiteboardId,
    });
  };

  const openBoard = async (board: StudentDeckWhiteboardSummary) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${collectionUrl}/${board.whiteboardId}`, {
        cache: 'no-store',
      });
      const boardDetail = parseStudentDeckWhiteboard(
        await responseJson(response, t('reachDeck.whiteboard.loadFailed')),
      );
      let imageUnavailable = false;
      const anchorRuntimeState = await hydrateReachDeckRuntimeImages(
        boardDetail.anchorRuntimeState,
        async (reference) => {
          const ticket = await responseJson(
            await fetch(
              studentDeckAssetDownloadUrl(
                boardDetail.anchorAttemptId,
                boardDetail.pageId,
                reference.questionId,
              ),
              {
                body: JSON.stringify({
                  assetId: reference.assetId,
                  objectKey: reference.objectKey,
                }),
                headers: { 'Content-Type': 'application/json' },
                method: 'POST',
              },
            ),
            t('reachDeck.whiteboard.loadFailed'),
          );
          if (
            typeof ticket !== 'object' ||
            ticket === null ||
            typeof (ticket as Record<string, unknown>).downloadUrl !== 'string'
          ) {
            throw new Error(t('reachDeck.whiteboard.loadFailed'));
          }
          return (ticket as { downloadUrl: string }).downloadUrl;
        },
        { onResolveError: () => (imageUnavailable = true) },
      );
      edit({ ...boardDetail, anchorRuntimeState });
      if (imageUnavailable) setError(t('reachDeck.whiteboard.anchorImageUnavailable'));
    } catch {
      setError(t('reachDeck.whiteboard.loadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (draft === null || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        draft.persisted === null
          ? collectionUrl
          : `${collectionUrl}/${draft.persisted.whiteboardId}`,
        {
          body: JSON.stringify(
            draft.persisted === null
              ? {
                  currentTime: draft.anchorCurrentTime,
                  elements: draft.elements,
                  runtimeState: draft.anchorRuntimeState,
                  whiteboardId: draft.whiteboardId,
                }
              : {
                  elements: draft.elements,
                  expectedRevision: draft.persisted.revision,
                },
          ),
          headers: { 'Content-Type': 'application/json' },
          method: draft.persisted === null ? 'POST' : 'PATCH',
        },
      );
      const saved = parseStudentDeckWhiteboard(
        await responseJson(response, t('reachDeck.whiteboard.saveFailed')),
      );
      setBoards((current) =>
        [
          ...current.filter((candidate) => candidate.whiteboardId !== saved.whiteboardId),
          whiteboardSummary(saved),
        ].sort((left, right) => left.slot - right.slot),
      );
      setPreviews((current) => ({ ...current, [saved.whiteboardId]: saved.elements }));
      setDraft(null);
    } catch {
      setError(t('reachDeck.whiteboard.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const copyBoard = async (board: StudentDeckWhiteboardSummary) => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${collectionUrl}/${board.whiteboardId}/copy`, {
        body: JSON.stringify({
          expectedSourceRevision: board.revision,
          whiteboardId: globalThis.crypto.randomUUID(),
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const copied = parseStudentDeckWhiteboard(
        await responseJson(response, t('reachDeck.whiteboard.copyFailed')),
      );
      setBoards((current) =>
        [...current, whiteboardSummary(copied)].sort((left, right) => left.slot - right.slot),
      );
      setPreviews((current) => ({ ...current, [copied.whiteboardId]: copied.elements }));
      edit(copied);
    } catch {
      setError(t('reachDeck.whiteboard.copyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const performDeleteBoard = async (board: StudentDeckWhiteboardSummary) => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${collectionUrl}/${board.whiteboardId}`, {
        body: JSON.stringify({ expectedRevision: board.revision }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE',
      });
      if (!response.ok) await responseJson(response, t('reachDeck.whiteboard.deleteFailed'));
      setBoards((current) =>
        current.filter((candidate) => candidate.whiteboardId !== board.whiteboardId),
      );
      setPreviews((current) => {
        const { [board.whiteboardId]: _removed, ...rest } = current;
        return rest;
      });
    } catch {
      setError(t('reachDeck.whiteboard.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  const requestDiscard = () => {
    if (draft === null || readOnly || !draft.dirty) {
      setDraft(null);
      return;
    }
    setConfirmation({ kind: 'discard' });
  };

  if (draft !== null) {
    return (
      <section
        aria-label={t('reachDeck.whiteboard.dialog')}
        aria-modal="true"
        className={styles.editorOverlay}
        data-student-whiteboard-editor
        role="dialog"
      >
        <header className={styles.header}>
          <div>
            <strong>
              {draft.persisted === null
                ? t('reachDeck.whiteboard.newBoardTitle')
                : t('reachDeck.whiteboard.boardName', { slot: draft.persisted.slot })}
            </strong>
            <span>{t('reachDeck.whiteboard.pageCount', { count: boards.length, limit })}</span>
          </div>
        </header>
        {error === null ? null : (
          <div aria-live="assertive" className={styles.error} role="alert">
            {error}
          </div>
        )}
        <div className={styles.editor}>
          <WhiteboardCanvas
            anchorCurrentTime={draft.anchorCurrentTime}
            anchorRuntimeState={draft.anchorRuntimeState}
            disabled={busy || readOnly}
            document={document}
            elements={draft.elements}
            locale={locale}
            nativeResourceUrlsById={nativeResourceUrlsById}
            onChange={(elements) =>
              setDraft((current) => (current ? { ...current, dirty: true, elements } : current))
            }
            page={page}
            quizGrading={quizGrading}
            resolveAttachmentUrl={resolveAnchorAttachmentUrl}
            t={t}
          />
          <div className={styles.editorActions}>
            <Button disabled={busy} onClick={requestDiscard} variant="secondary">
              {t('reachDeck.whiteboard.backToList')}
            </Button>
            {readOnly ? null : (
              <Button
                disabled={busy}
                iconStart={<Save size={16} />}
                onClick={() => void saveDraft()}
              >
                {busy ? t('reachDeck.whiteboard.saving') : t('reachDeck.whiteboard.saveAndExit')}
              </Button>
            )}
          </div>
        </div>
        {confirmation?.kind === 'discard' ? (
          <ConfirmDialog
            cancelLabel={t('shared.confirm.cancel')}
            confirmLabel={t('shared.confirm.continue')}
            description={t('reachDeck.whiteboard.discardConfirm')}
            onCancel={() => setConfirmation(undefined)}
            onConfirm={() => {
              setConfirmation(undefined);
              setDraft(null);
            }}
            open
            title={t('reachDeck.whiteboard.discardTitle')}
            tone="danger"
          />
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-label={t('reachDeck.whiteboard.dialog')}
      className={styles.drawer}
      data-student-whiteboard-drawer
      style={
        dock === undefined
          ? { bottom: 0, left: 0, right: 0 }
          : {
              bottom: dock.bottom,
              left: dock.left,
              maxHeight: dock.maxHeight,
              width: dock.width,
            }
      }
    >
      <header className={styles.drawerHeader}>
        <div>
          <strong>{t('reachDeck.whiteboard.title')}</strong>
          <span>{t('reachDeck.whiteboard.pageCount', { count: boards.length, limit })}</span>
        </div>
        {error === null ? null : (
          <span aria-live="assertive" className={styles.drawerError} role="alert">
            {error}
          </span>
        )}
        <button
          aria-label={t('reachDeck.whiteboard.close')}
          className={styles.iconButton}
          disabled={busy}
          onClick={onClose}
          type="button"
        >
          <ChevronDown size={20} />
        </button>
      </header>
      <div className={styles.thumbRow}>
        {loading ? (
          <p className={styles.drawerHint}>{t('reachDeck.whiteboard.loading')}</p>
        ) : boards.length === 0 ? (
          <p className={styles.drawerHint}>{t('reachDeck.whiteboard.empty')}</p>
        ) : (
          boards.map((board) => (
            <div className={styles.thumbCard} key={board.whiteboardId}>
              <button
                aria-label={t('reachDeck.whiteboard.openNamed', { slot: board.slot })}
                className={styles.thumbOpen}
                disabled={busy}
                onClick={() => void openBoard(board)}
                type="button"
              >
                <WhiteboardThumbnail elements={previews[board.whiteboardId]} />
                <span className={styles.thumbCaption}>
                  <strong>{t('reachDeck.whiteboard.boardName', { slot: board.slot })}</strong>
                  <span>
                    {t('reachDeck.whiteboard.anchorTime', {
                      time: board.anchorCurrentTime.toFixed(1),
                    })}
                  </span>
                </span>
              </button>
              <div className={styles.thumbActions}>
                <button
                  aria-label={t('reachDeck.whiteboard.copyNamed', { slot: board.slot })}
                  disabled={busy || readOnly || boards.length >= limit}
                  onClick={() => void copyBoard(board)}
                  title={t('reachDeck.whiteboard.copy')}
                  type="button"
                >
                  <Copy size={14} />
                </button>
                <button
                  aria-label={t('reachDeck.whiteboard.deleteNamed', { slot: board.slot })}
                  disabled={busy || readOnly}
                  onClick={() => setConfirmation({ kind: 'delete', board })}
                  title={t('reachDeck.whiteboard.delete')}
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
        <button
          aria-label={t('reachDeck.whiteboard.addFromFrame')}
          className={styles.addCard}
          disabled={busy || loading || readOnly || boards.length >= limit}
          onClick={newDraft}
          title={
            boards.length >= limit
              ? t('reachDeck.whiteboard.limitReached')
              : t('reachDeck.whiteboard.addFromFrame')
          }
          type="button"
        >
          <Plus size={22} />
          <span>
            {boards.length >= limit
              ? t('reachDeck.whiteboard.limitReached')
              : t('reachDeck.whiteboard.addFromFrame')}
          </span>
        </button>
      </div>
      {confirmation?.kind === 'delete' ? (
        <ConfirmDialog
          cancelLabel={t('shared.confirm.cancel')}
          confirmLabel={t('shared.confirm.continue')}
          description={t('reachDeck.whiteboard.deleteConfirm')}
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => {
            const board = confirmation.board;
            setConfirmation(undefined);
            void performDeleteBoard(board);
          }}
          open
          title={t('reachDeck.whiteboard.deleteTitle')}
          tone="danger"
        />
      ) : null}
    </section>
  );
}

/**
 * 白板缩略图：以固定 Deck 参照框为基准，把笔迹与文本框缩放进一个小 SVG。
 * 元素明细未就绪时渲染灰色占位块。
 */
function WhiteboardThumbnail({ elements }: { elements?: StudentDeckWhiteboardElement[] }) {
  if (elements === undefined) {
    return <span aria-hidden="true" className={styles.thumbPlaceholder} />;
  }
  const pad = 24;
  let minX = DECK_RECT.x;
  let minY = DECK_RECT.y;
  let maxX = DECK_RECT.x + DECK_RECT.width;
  let maxY = DECK_RECT.y + DECK_RECT.height;
  for (const element of elements) {
    if (element.type === 'text') {
      minX = Math.min(minX, element.x);
      minY = Math.min(minY, element.y);
      maxX = Math.max(maxX, element.x + element.width);
      maxY = Math.max(maxY, element.y + 100);
      continue;
    }
    for (const point of element.points) {
      minX = Math.min(minX, point.x - element.width / 2);
      minY = Math.min(minY, point.y - element.width / 2);
      maxX = Math.max(maxX, point.x + element.width / 2);
      maxY = Math.max(maxY, point.y + element.width / 2);
    }
  }
  return (
    <svg
      aria-hidden="true"
      className={styles.thumbSvg}
      preserveAspectRatio="xMidYMid meet"
      viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`}
    >
      <rect
        fill="#ffffff"
        height={DECK_RECT.height}
        rx={10}
        stroke="#d8d0d4"
        strokeWidth={3}
        width={DECK_RECT.width}
        x={DECK_RECT.x}
        y={DECK_RECT.y}
      />
      {elements.map((element) =>
        element.type === 'stroke' ? (
          <polyline
            fill="none"
            key={element.id}
            points={element.points.map((point) => `${point.x},${point.y}`).join(' ')}
            stroke={element.color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={Math.max(element.width, 3)}
          />
        ) : (
          <g key={element.id}>
            <rect
              fill="rgb(255 255 255 / 80%)"
              height={100}
              rx={6}
              stroke="#91858c"
              strokeDasharray="8 6"
              strokeWidth={2}
              width={element.width}
              x={element.x}
              y={element.y}
            />
            <text fill={element.color} fontSize={26} x={element.x + 10} y={element.y + 36}>
              {element.text.slice(0, 14)}
            </text>
          </g>
        ),
      )}
    </svg>
  );
}

interface WhiteboardCanvasProps {
  anchorCurrentTime: number;
  anchorRuntimeState: Record<string, unknown>;
  disabled: boolean;
  document: ReachDeckDocument;
  elements: StudentDeckWhiteboardElement[];
  locale: string;
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  onChange: (elements: StudentDeckWhiteboardElement[]) => void;
  page: ReachDeckPublishedPage;
  quizGrading: StudentDeckWhiteboardQuizGrading;
  resolveAttachmentUrl: ReachDeckAttachmentUrlResolver;
  t: PortalTranslator;
}

function WhiteboardCanvas({
  anchorCurrentTime,
  anchorRuntimeState,
  disabled,
  document,
  elements,
  locale,
  nativeResourceUrlsById,
  onChange,
  page,
  quizGrading,
  resolveAttachmentUrl,
  t,
}: WhiteboardCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activePointerRef = useRef<number | null>(null);
  const activeStrokeRef = useRef<string | null>(null);
  const captureTargetRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(
    null,
  );
  const initializedRef = useRef(false);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#1f2937');
  const [width, setWidth] = useState(4);
  const [view, setView] = useState({ x: 0, y: 0, scale: 0.7 });

  const finishPointerInteraction = useCallback((pointerId?: number, releaseCapture = false) => {
    const activePointer = activePointerRef.current;
    if (activePointer === null || (pointerId !== undefined && pointerId !== activePointer)) return;
    const captureTarget = captureTargetRef.current ?? surfaceRef.current;
    activePointerRef.current = null;
    activeStrokeRef.current = null;
    captureTargetRef.current = null;
    panStartRef.current = null;
    if (!releaseCapture) return;
    if (!captureTarget) return;
    try {
      if (captureTarget.hasPointerCapture(activePointer)) {
        captureTarget.releasePointerCapture(activePointer);
      }
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || initializedRef.current) return;
    const initialize = () => {
      const rect = surface.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      initializedRef.current = true;
      setView({ x: rect.width / 2, y: rect.height / 2, scale: Math.min(0.8, rect.width / 1200) });
    };
    initialize();
    const observer = new ResizeObserver(initialize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const finish = () => finishPointerInteraction(undefined, true);
    window.addEventListener('blur', finish);
    return () => window.removeEventListener('blur', finish);
  }, [finishPointerInteraction]);

  useEffect(() => {
    if (disabled) finishPointerInteraction(undefined, true);
  }, [disabled, finishPointerInteraction]);

  useEffect(() => () => finishPointerInteraction(undefined, true), [finishPointerInteraction]);

  const runtimeByPageId = useMemo<ReachDeckRuntimeByPageId>(() => {
    if (Object.keys(anchorRuntimeState).length === 0) return {};
    return { [page.pageId]: anchorRuntimeState as unknown as ReachDeckSceneRuntimeState };
  }, [anchorRuntimeState, page.pageId]);

  const pointerToWorld = (clientX: number, clientY: number) => {
    const surface = surfaceRef.current;
    if (surface === null || !Number.isFinite(view.scale) || view.scale <= 0) return null;
    const rect = surface.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale,
    };
  };

  const eraseAt = (x: number, y: number) => {
    const threshold = 14 / view.scale;
    const target = [...elements].reverse().find((element) => {
      if (element.type === 'text') {
        return (
          x >= element.x && x <= element.x + element.width && y >= element.y && y <= element.y + 100
        );
      }
      return element.points.some(
        (point) => Math.hypot(point.x - x, point.y - y) <= threshold + element.width / 2,
      );
    });
    if (target) onChange(elements.filter((element) => element.id !== target.id));
  };

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || activePointerRef.current !== null || event.button > 1) return;
    const pan = tool === 'pan' || event.button === 1;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    activePointerRef.current = event.pointerId;
    captureTargetRef.current = event.currentTarget;
    if (pan) {
      panStartRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        x: view.x,
        y: view.y,
      };
      return;
    }
    const point = pointerToWorld(event.clientX, event.clientY);
    if (point === null) {
      finishPointerInteraction(event.pointerId, true);
      return;
    }
    if (tool === 'pen') {
      const stroke: StudentDeckWhiteboardStroke = {
        color,
        id: globalThis.crypto.randomUUID(),
        points: [point],
        type: 'stroke',
        width,
      };
      activeStrokeRef.current = stroke.id;
      onChange([...elements, stroke]);
    } else if (tool === 'eraser') {
      eraseAt(point.x, point.y);
    } else if (tool === 'text') {
      const text: StudentDeckWhiteboardText = {
        color,
        id: globalThis.crypto.randomUUID(),
        text: '',
        type: 'text',
        width: 260,
        x: point.x,
        y: point.y,
      };
      onChange([...elements, text]);
    }
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    if (disabled) {
      finishPointerInteraction(event.pointerId, true);
      return;
    }
    const panStart = panStartRef.current;
    if (panStart) {
      const { clientX, clientY } = event;
      setView((current) => ({
        ...current,
        x: panStart.x + clientX - panStart.clientX,
        y: panStart.y + clientY - panStart.clientY,
      }));
      return;
    }
    const point = pointerToWorld(event.clientX, event.clientY);
    if (point === null) {
      finishPointerInteraction(event.pointerId, true);
      return;
    }
    if (activeStrokeRef.current) {
      onChange(
        elements.map((element) =>
          element.type === 'stroke' && element.id === activeStrokeRef.current
            ? { ...element, points: [...element.points, point] }
            : element,
        ),
      );
    } else if (tool === 'eraser') {
      eraseAt(point.x, point.y);
    }
  };

  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) =>
    finishPointerInteraction(event.pointerId, true);

  const pointerCaptureLost = (event: ReactPointerEvent<HTMLDivElement>) =>
    finishPointerInteraction(event.pointerId);

  const pointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) return;
    } catch {
      // Fall through to cleanup when capture state cannot be queried.
    }
    finishPointerInteraction(event.pointerId);
  };

  const zoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const sx = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const sy = (clientY ?? rect.top + rect.height / 2) - rect.top;
    setView((current) => {
      const scale = Math.min(2.5, Math.max(0.25, current.scale * factor));
      const worldX = (sx - current.x) / current.scale;
      const worldY = (sy - current.y) / current.scale;
      return { scale, x: sx - worldX * scale, y: sy - worldY * scale };
    });
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.1 : 0.9, event.clientX, event.clientY);
    };
    surface.addEventListener('wheel', wheel, { passive: false });
    return () => surface.removeEventListener('wheel', wheel);
  }, [zoom]);

  return (
    <section className={styles.canvasShell}>
      <div aria-label={t('reachDeck.whiteboard.tools')} className={styles.toolbar} role="toolbar">
        {(
          [
            ['pan', Hand, t('reachDeck.whiteboard.tool.pan')],
            ['pen', PenLine, t('reachDeck.whiteboard.tool.pen')],
            ['eraser', Eraser, t('reachDeck.whiteboard.tool.eraser')],
            ['text', Type, t('reachDeck.whiteboard.tool.text')],
          ] as const
        ).map(([value, Icon, label]) => (
          <button
            aria-label={label}
            aria-pressed={tool === value}
            className={tool === value ? styles.activeTool : undefined}
            disabled={disabled}
            key={value}
            onClick={() => setTool(value)}
            title={label}
            type="button"
          >
            <Icon size={18} />
          </button>
        ))}
        <label>
          <span>{t('reachDeck.whiteboard.color')}</span>
          <input
            aria-label={t('reachDeck.whiteboard.color')}
            disabled={disabled}
            onChange={(event) => setColor(event.target.value)}
            type="color"
            value={color}
          />
        </label>
        <label>
          <span>{t('reachDeck.whiteboard.width')}</span>
          <input
            aria-label={t('reachDeck.whiteboard.width')}
            disabled={disabled}
            max="32"
            min="1"
            onChange={(event) => setWidth(Number(event.target.value))}
            type="range"
            value={width}
          />
        </label>
        <button
          aria-label={t('reachDeck.whiteboard.zoomOut')}
          onClick={() => zoom(0.9)}
          type="button"
        >
          <ZoomOut size={18} />
        </button>
        <button
          aria-label={t('reachDeck.whiteboard.zoomIn')}
          onClick={() => zoom(1.1)}
          type="button"
        >
          <ZoomIn size={18} />
        </button>
        <span className={styles.zoomValue}>{Math.round(view.scale * 100)}%</span>
      </div>
      <div
        aria-label={t('reachDeck.whiteboard.canvas')}
        className={styles.canvas}
        onLostPointerCapture={pointerCaptureLost}
        onPointerCancel={pointerEnd}
        onPointerDown={pointerDown}
        onPointerLeave={pointerLeave}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        ref={surfaceRef}
        role="application"
      >
        <div
          className={styles.grid}
          style={{
            backgroundPosition: `${view.x}px ${view.y}px`,
            backgroundSize: `${32 * view.scale}px ${32 * view.scale}px`,
          }}
        />
        <div
          className={styles.world}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <div
            aria-label={t('reachDeck.whiteboard.deckReference')}
            className={styles.deckReference}
            data-reach-deck-readable-attachments="true"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <ReachDeckPlayer
              activePageId={page.pageId}
              currentTime={anchorCurrentTime}
              document={document}
              initialRuntimeByPageId={runtimeByPageId}
              locale={locale}
              nativeResourceUrlsById={nativeResourceUrlsById}
              resolveAttachmentUrl={resolveAttachmentUrl}
              playing={false}
              showNativeTimeline={false}
              quizGradingMode="server"
              quizGradingByPageId={quizGrading.quizGradingByPageId}
              masteredLearningFenceQuestionIdsByPage={
                quizGrading.masteredLearningFenceQuestionIdsByPage
              }
              renderQuizGradingFeedback={quizGrading.renderQuizGradingFeedback}
              translate={t}
            />
          </div>
          {elements
            .filter((element): element is StudentDeckWhiteboardText => element.type === 'text')
            .map((element) => (
              <textarea
                aria-label={t('reachDeck.whiteboard.textBox')}
                className={styles.textBox}
                disabled={disabled}
                key={element.id}
                onChange={(event) =>
                  onChange(
                    elements.map((candidate) =>
                      candidate.id === element.id
                        ? { ...element, text: event.target.value }
                        : candidate,
                    ),
                  )
                }
                onPointerDown={(event) => event.stopPropagation()}
                placeholder={t('reachDeck.whiteboard.textPlaceholder')}
                style={{
                  color: element.color,
                  left: element.x,
                  pointerEvents: tool === 'text' && !disabled ? 'auto' : 'none',
                  top: element.y,
                  width: element.width,
                }}
                value={element.text}
              />
            ))}
        </div>
        <svg aria-hidden="true" className={styles.ink}>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            {elements
              .filter(
                (element): element is StudentDeckWhiteboardStroke => element.type === 'stroke',
              )
              .map((stroke) => (
                <polyline
                  fill="none"
                  key={stroke.id}
                  points={stroke.points.map((point) => `${point.x},${point.y}`).join(' ')}
                  stroke={stroke.color}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={stroke.width}
                />
              ))}
          </g>
        </svg>
      </div>
    </section>
  );
}

/** 某页白板集合的同源 BFF 路径；控制条入口的计数与列表共用。 */
export function studentDeckWhiteboardCollectionUrl(attemptId: string, pageId: string): string {
  return `/api/student/reach-deck/attempts/${attemptId}/pages/${encodeURIComponent(pageId)}/whiteboards`;
}

function studentDeckAssetDownloadUrl(
  attemptId: string,
  pageId: string,
  questionId: string,
): string {
  return `/api/student/reach-deck/attempts/${attemptId}/pages/${encodeURIComponent(pageId)}/questions/${encodeURIComponent(questionId)}/assets/presign-download`;
}

async function responseJson(response: Response, fallback: string): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new Error(fallback);
    throw new Error(fallback);
  }
  if (!response.ok) {
    throw new Error(fallback);
  }
  return body;
}

function whiteboardSummary(board: StudentDeckWhiteboard): StudentDeckWhiteboardSummary {
  return {
    anchorCurrentTime: board.anchorCurrentTime,
    createdAt: board.createdAt,
    moduleVersionId: board.moduleVersionId,
    pageId: board.pageId,
    revision: board.revision,
    slot: board.slot,
    updatedAt: board.updatedAt,
    whiteboardId: board.whiteboardId,
  };
}
