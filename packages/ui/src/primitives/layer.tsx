'use client';

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useLayoutEffect,
  useState,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * 共享浮层栈（规范 02 §7、03 §3.4）。
 *
 * - 所有浮层渲染到 body 下同一个 portal 根节点 `[data-rx-portal-root]`。
 * - 层级只用 `--reachany-z-*` token；浮层嵌套在弹窗/抽屉里时自动高出父层一级，业务不处理。
 * - Escape 只关闭最上层；点击外部时，点在某层（含其子层，例如弹窗里打开的下拉）之外才关闭该层。
 */

export type LayerKind = 'dropdown' | 'drawer' | 'modal' | 'toast' | 'tooltip';
export type DismissReason = 'escape' | 'outside';

interface LayerContextValue {
  id: string;
  zIndex: string;
}

const LayerContext = createContext<LayerContextValue | null>(null);

interface LayerRecord {
  escape: boolean;
  kind: LayerKind;
  getElements: () => (Element | null | undefined)[];
  id: string;
  onDismiss: (reason: DismissReason, event: Event) => void;
  outside: boolean;
  parentId: string | null;
}

const records: LayerRecord[] = [];
let listening = false;

function isDescendantOf(record: LayerRecord, ancestorId: string): boolean {
  let parentId = record.parentId;
  while (parentId !== null) {
    if (parentId === ancestorId) return true;
    parentId = records.find((candidate) => candidate.id === parentId)?.parentId ?? null;
  }
  return false;
}

function ownsTarget(record: LayerRecord, target: Node): boolean {
  const hit = (candidate: LayerRecord) =>
    candidate.getElements().some((element) => element?.contains(target) ?? false);
  if (hit(record)) return true;
  return records.some((candidate) => isDescendantOf(candidate, record.id) && hit(candidate));
}

function onDocumentPointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  // 从最上层往下，逐层判断；先快照，避免回调里的关闭改动数组。
  for (const record of [...records].reverse()) {
    if (!record.outside) continue;
    if (!ownsTarget(record, target)) record.onDismiss('outside', event);
  }
}

/**
 * 最上层 = 没有处于打开状态的子层的那一层；多个时取最后打开的。
 * 不能只看注册顺序：同一次提交里父子层一起打开时，子层的 effect 先于父层执行。
 */
function topmostEscapeLayer(): LayerRecord | undefined {
  const candidates = records.filter((record) => record.escape);
  return [...candidates]
    .reverse()
    .find((record) => !candidates.some((other) => isDescendantOf(other, record.id)));
}

/** Whether an element belongs to the top interactive layer (or no layer is open). */
export function isInTopmostLayer(element: Element): boolean {
  const candidates = records.filter(
    (record) => record.kind !== 'tooltip' && record.kind !== 'toast',
  );
  const top = [...candidates]
    .reverse()
    .find((record) => !candidates.some((other) => isDescendantOf(other, record.id)));
  return !top || top.getElements().some((surface) => surface?.contains(element) ?? false);
}

function onDocumentKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = topmostEscapeLayer();
  if (!top) return;
  event.preventDefault();
  top.onDismiss('escape', event);
}

function ensureListeners() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown);
}

function releaseListeners() {
  if (!listening || records.length > 0) return;
  listening = false;
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeyDown);
}

export interface UseLayerOptions {
  /** 层是否处于打开状态；关闭时不参与 Escape/点击外部判断。 */
  active: boolean;
  /** 属于本层的元素（浮层本身、触发器等）；点在这些元素或子层里不算「外部」。 */
  elements?: readonly (RefObject<Element | null> | undefined)[];
  /** 是否响应 Escape，默认 true。 */
  escape?: boolean;
  kind: LayerKind;
  onDismiss?: (reason: DismissReason, event: Event) => void;
  /** 是否响应点击外部，默认 true。 */
  outside?: boolean;
}

export interface Layer {
  /** 包在浮层内容外，子浮层据此获得父层级与父层 id。 */
  Provider: (props: { children: ReactNode }) => ReactNode;
  zIndex: string;
  /** Active descendant surfaces, including portals, for integrating an existing modal focus boundary. */
  getActiveDescendantElements: () => Element[];
}

/** 注册一个浮层：返回它应使用的 z-index 以及给子浮层用的上下文。 */
export function useLayer({
  active,
  elements = [],
  escape = true,
  kind,
  onDismiss,
  outside = true,
}: UseLayerOptions): Layer {
  const parent = useContext(LayerContext);
  const id = useId();
  const base = `var(--reachany-z-${kind})`;
  const zIndex =
    parent === null || kind === 'toast' || kind === 'tooltip'
      ? base
      : `max(${base}, calc(${parent.zIndex} + 1))`;

  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!active || onDismissRef.current === undefined) return;
    const record: LayerRecord = {
      escape,
      kind,
      getElements: () => elementsRef.current.map((ref) => ref?.current),
      id,
      onDismiss: (reason, event) => onDismissRef.current?.(reason, event),
      outside,
      parentId: parent?.id ?? null,
    };
    records.push(record);
    ensureListeners();
    return () => {
      const index = records.indexOf(record);
      if (index >= 0) records.splice(index, 1);
      releaseListeners();
    };
  }, [active, escape, id, kind, outside, parent?.id]);

  const value = useMemo(() => ({ id, zIndex }), [id, zIndex]);
  const Provider = useMemo(
    () =>
      function LayerProvider({ children }: { children: ReactNode }) {
        return <LayerContext.Provider value={value}>{children}</LayerContext.Provider>;
      },
    [value],
  );

  const getActiveDescendantElements = () => [
    ...new Set(
      records
        .filter((record) => isDescendantOf(record, id))
        .flatMap((record) => record.getElements())
        .filter((element): element is Element => element != null && element.isConnected),
    ),
  ];
  return { Provider, zIndex, getActiveDescendantElements };
}

const PORTAL_ROOT_ATTRIBUTE = 'data-rx-portal-root';

export function getPortalRoot(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let root = document.body.querySelector<HTMLElement>(`:scope > [${PORTAL_ROOT_ATTRIBUTE}]`);
  if (!root) {
    root = document.createElement('div');
    root.setAttribute(PORTAL_ROOT_ATTRIBUTE, '');
    document.body.append(root);
  }
  return root;
}

const subscribeNoop = () => () => {};

/** 客户端挂载后才为 true，避免浮层在服务端渲染与水合时不一致。 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/** 把子节点渲染到共享 portal 根节点。服务端不渲染。 */
export function Portal({ children }: { children: ReactNode }) {
  const client = useIsClient();
  if (!client) return null;
  const root = getPortalRoot();
  return root ? createPortal(children, root) : null;
}

/** 在页面与弹窗之间移动同一个 React portal 容器，保持媒体实例。 */
export function PersistentPortal({ children, inline }: { children: ReactNode; inline: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const client = useIsClient();
  const [container] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const element = document.createElement('div');
    element.className = 'rx-persistent-portal';
    return element;
  });
  useLayoutEffect(() => () => container?.remove(), [container]);
  useLayoutEffect(() => {
    if (!container) return;
    const destination = inline ? anchor.current : getPortalRoot();
    if (!destination || container.parentElement === destination) return;
    // 原生保留状态的移动同时保留媒体播放状态和嵌入的浏览上下文。
    if (container.isConnected && 'moveBefore' in destination) {
      (
        destination as HTMLElement & { moveBefore(node: Node, before: Node | null): void }
      ).moveBefore(container, null);
    } else destination.append(container);
  }, [container, inline]);
  return (
    <>
      <div className="rx-persistent-portal-anchor" ref={anchor} hidden={!inline} />
      {client && container ? createPortal(children, container) : null}
    </>
  );
}
