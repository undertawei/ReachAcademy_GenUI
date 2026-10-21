'use client';

import { GripVertical } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { cn } from '../cn';
import { mergeRefs } from '../primitives/refs';
import { usePrefersReducedMotion } from '../primitives/usePrefersReducedMotion';

/**
 * 拖拽排序（规范 03 §3.23、动效 04 §3.10、反馈 05 §5）。不依赖第三方拖拽库。
 *
 * - 只有手柄能拿起：指针拖拽（pointer events + setPointerCapture）或键盘（Space 拿起、↑/↓ 移动、Space 放下、Esc 取消）。
 * - 指针拖拽中被拖项 `shadow-raised` + `scale(1.01)` 沿排列方向跟随指针，其余项用 transform 让位（standard 200ms），
 *   目标位置显示 `border-warm` 虚线占位框；靠近最近的滚动容器边缘 48px 内自动滚动；放下时 200ms 落位。
 * - 键盘移动直接按新顺序重排 DOM，并用 FLIP 平滑过渡；每一步经 polite live region 播报。
 * - 乐观更新：放下后立即按新顺序显示并调用 `onReorder`；它抛错或返回的 Promise 被拒绝时回滚并调用 `onError`。
 * - 减少动效：不做 FLIP、不缩放，落位瞬时完成。
 * - 每个 SortableList 有独立上下文，嵌套列表互不影响。
 */

export type SortableId = number | string;
export type SortableOrientation = 'horizontal' | 'vertical';

export interface SortableAnnouncements {
  cancelled: (label: string) => string;
  dropped: (label: string, position: number, total: number) => string;
  moved: (label: string, position: number, total: number) => string;
  pickedUp: (label: string, position: number, total: number) => string;
}

export interface UseSortableOptions<T> {
  /** 读屏播报模板（位置从 1 开始）。不传则不播报。 */
  announcements?: SortableAnnouncements;
  disabled?: boolean;
  getId: (item: T) => SortableId;
  /** 条目的可读名称，用于播报与手柄名称；默认用 id。 */
  getLabel?: (item: T) => string;
  /** 手柄的可读名称，例如 `(label) => \`拖动排序：${label}\``。 */
  handleLabel?: (label: string) => string;
  /** 手柄的操作说明（aria-describedby），例如「按空格拿起，方向键移动，空格放下，Esc 取消」。 */
  instructions?: string;
  items: readonly T[];
  onError?: (error: unknown) => void;
  /**
   * 放下后调用，索引基于当前显示顺序。可以同步更新 items，也可以返回 Promise 并在成功后更新；
   * 抛错或 Promise 被拒绝时组件回滚显示顺序（若调用方已先行更新了 items，需要在 onError 里自行还原）。
   */
  onReorder: (fromIndex: number, toIndex: number) => Promise<void> | void;
  orientation?: SortableOrientation;
}

type DragPhase = 'dragging' | 'dropping';

interface SlotRect {
  crossSize: number;
  crossStart: number;
  size: number;
  start: number;
}

interface DragState {
  from: number;
  id: SortableId;
  mode: 'keyboard' | 'pointer';
  over: number;
  phase: DragPhase;
  /** 指针拖拽：拿起时各项相对列表的位置（排列方向与交叉方向）。 */
  rects?: SlotRect[];
  /** 指针拖拽：其余项让位的距离（被拖项尺寸 + 间距）。 */
  space?: number;
}

interface PointerSession {
  from: number;
  id: SortableId;
  lastX: number;
  lastY: number;
  lifted: boolean;
  over: number;
  pointerId: number;
  raf: number;
  rects: SlotRect[];
  scroller: HTMLElement | null;
  startRelative: number;
  startX: number;
  startY: number;
}

export interface SortableItemBindings {
  'data-sortable-id': string;
  'data-state'?: 'dragging' | 'dropping' | 'lifted';
  ref: (node: HTMLElement | null) => void;
  style?: CSSProperties;
}

export interface SortableHandleBindings {
  'aria-describedby'?: string;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  'data-state'?: 'dragging' | 'lifted';
  disabled?: boolean;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  ref: (node: HTMLElement | null) => void;
}

export interface UseSortableResult<T> {
  activeId: SortableId | null;
  /** 当前 live region 文本。使用 SortableList 时已自动渲染。 */
  announcement: string;
  getHandleProps: (id: SortableId, label?: string) => SortableHandleBindings;
  getItemProps: (id: SortableId) => SortableItemBindings;
  instructionsId: string;
  /** 按显示顺序排列的条目（含乐观更新与键盘移动预览）。 */
  items: T[];
  listProps: {
    'data-orientation': SortableOrientation;
    'data-state': 'dragging' | 'dropping' | 'idle' | 'lifted';
    ref: (node: HTMLElement | null) => void;
  };
  orientation: SortableOrientation;
  /** 指针拖拽时目标位置的占位框样式（相对列表绝对定位），否则 null。 */
  placeholder: CSSProperties | null;
  state: 'dragging' | 'dropping' | 'idle' | 'lifted';
}

const LIFT_THRESHOLD = 4;
const EDGE = 48;
const MAX_SCROLL_STEP = 16;

function nextFrame(callback: () => void): number {
  return typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(callback)
    : window.setTimeout(callback, 16);
}

function cancelFrame(handle: number) {
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
}

function arrayMove<V>(list: readonly V[], from: number, to: number): V[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as V);
  return next;
}

function transitionTime(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  const parse = (value: string) =>
    value
      .split(',')
      .map((part) => part.trim())
      .map((part) => (part.endsWith('ms') ? parseFloat(part) : parseFloat(part) * 1000))
      .map((time) => (Number.isFinite(time) ? time : 0));
  const durations = parse(style.transitionDuration || '0s');
  const delays = parse(style.transitionDelay || '0s');
  return durations.reduce(
    (max, duration, index) => Math.max(max, duration + (delays[index] ?? 0)),
    0,
  );
}

function findScroller(start: HTMLElement | null, axis: 'x' | 'y'): HTMLElement | null {
  let node = start?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    const scrollable =
      axis === 'y' ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth;
    if (/(auto|scroll|overlay)/.test(overflow) && scrollable) return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** 拖拽排序的状态机与事件绑定；SortableList 就是它的薄封装。 */
export function useSortable<T>({
  announcements,
  disabled = false,
  getId,
  getLabel,
  handleLabel,
  instructions,
  items,
  onError,
  onReorder,
  orientation = 'vertical',
}: UseSortableOptions<T>): UseSortableResult<T> {
  const axis = orientation === 'horizontal' ? 'x' : 'y';
  const reducedMotion = usePrefersReducedMotion();
  const instructionsId = useId();
  const ids = items.map(getId);
  const signature = ids.map(String).join('\u0001');
  const itemById = new Map<SortableId, T>();
  items.forEach((item, index) => itemById.set(ids[index]!, item));

  const [override, setOverride] = useState<{ base: string; ids: SortableId[] } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const baseIds = useMemo(() => {
    if (!override || override.base !== signature) return ids;
    const known = new Set(ids);
    const ordered = override.ids.filter((id) => known.has(id));
    return ordered.length === ids.length ? ordered : ids;
  }, [override, signature]);

  const activeDrag = drag && baseIds.includes(drag.id) ? drag : null;
  const displayIds =
    activeDrag?.mode === 'keyboard'
      ? arrayMove(baseIds, activeDrag.from, activeDrag.over)
      : baseIds;
  const displaySignature = displayIds.map(String).join('\u0001');

  // —— 引用：事件回调里读最新值 ——
  const listRef = useRef<HTMLElement | null>(null);
  const itemEls = useRef(new Map<SortableId, HTMLElement>());
  const handleEls = useRef(new Map<SortableId, HTMLElement>());
  const pointer = useRef<PointerSession | null>(null);
  const positions = useRef(new Map<SortableId, { x: number; y: number }>());
  const skipFlip = useRef(false);
  const draggedEl = useRef<HTMLElement | null>(null);
  const token = useRef(0);
  const latest = useRef({
    announcements,
    baseIds,
    drag: activeDrag,
    getLabel,
    itemById,
    onError,
    onReorder,
    reducedMotion,
    signature,
  });
  latest.current = {
    announcements,
    baseIds,
    drag: activeDrag,
    getLabel,
    itemById,
    onError,
    onReorder,
    reducedMotion,
    signature,
  };

  const labelOf = useCallback((id: SortableId) => {
    const item = latest.current.itemById.get(id);
    return item !== undefined && latest.current.getLabel
      ? latest.current.getLabel(item)
      : String(id);
  }, []);

  const announce = useCallback((build: (a: SortableAnnouncements) => string) => {
    const templates = latest.current.announcements;
    if (templates) setAnnouncement(build(templates));
  }, []);

  // 过期的乐观顺序（调用方已换了一批 items）直接丢弃。
  useEffect(() => {
    if (override && override.base !== signature) setOverride(null);
  }, [override, signature]);

  const commit = useCallback(
    (from: number, to: number, mode: 'keyboard' | 'pointer', id: SortableId) => {
      const { baseIds: previous, signature: base } = latest.current;
      const total = previous.length;
      setDrag(null);
      announce((a) => a.dropped(labelOf(id), to + 1, total));
      if (from === to) return;
      const next = arrayMove(previous, from, to);
      skipFlip.current = mode === 'pointer';
      setOverride({ base, ids: next });
      const current = ++token.current;
      const rollback = (error: unknown) => {
        if (current !== token.current) return;
        skipFlip.current = false;
        setOverride({ base: latest.current.signature, ids: previous });
        latest.current.onError?.(error);
      };
      try {
        const result = latest.current.onReorder(from, to);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).then(undefined, rollback);
        }
      } catch (error) {
        rollback(error);
      }
    },
    [announce, labelOf],
  );

  // —— 指针拖拽 ——

  const measure = useCallback(
    (list: HTMLElement): SlotRect[] => {
      const listRect = list.getBoundingClientRect();
      return latest.current.baseIds.map((id) => {
        const rect = itemEls.current.get(id)?.getBoundingClientRect();
        if (!rect) return { crossSize: 0, crossStart: 0, size: 0, start: 0 };
        return axis === 'y'
          ? {
              crossSize: rect.width,
              crossStart: rect.left - listRect.left - list.clientLeft,
              size: rect.height,
              start: rect.top - listRect.top - list.clientTop,
            }
          : {
              crossSize: rect.height,
              crossStart: rect.top - listRect.top - list.clientTop,
              size: rect.width,
              start: rect.left - listRect.left - list.clientLeft,
            };
      });
    },
    [axis],
  );

  const pointerRelative = useCallback(
    (session: PointerSession) => {
      const list = listRef.current;
      if (!list) return 0;
      const rect = list.getBoundingClientRect();
      return axis === 'y'
        ? session.lastY - rect.top - list.clientTop
        : session.lastX - rect.left - list.clientLeft;
    },
    [axis],
  );

  const updatePointer = useCallback(() => {
    const session = pointer.current;
    if (!session?.lifted) return;
    const delta = pointerRelative(session) - session.startRelative;
    const { from, rects } = session;
    const dragged = rects[from]!;
    const center = dragged.start + delta + dragged.size / 2;
    let over = from;
    for (let index = from + 1; index < rects.length; index += 1) {
      if (center > rects[index]!.start + rects[index]!.size / 2) over = index;
    }
    for (let index = from - 1; index >= 0; index -= 1) {
      if (center < rects[index]!.start + rects[index]!.size / 2) over = index;
    }
    const element = itemEls.current.get(session.id);
    if (element) {
      const translate =
        axis === 'y' ? `translate3d(0, ${delta}px, 0)` : `translate3d(${delta}px, 0, 0)`;
      element.style.transform = latest.current.reducedMotion
        ? translate
        : `${translate} scale(1.01)`;
    }
    if (over !== session.over) {
      session.over = over;
      setDrag((current) =>
        current && current.mode === 'pointer' ? { ...current, over } : current,
      );
    }
  }, [axis, pointerRelative]);

  const stopListening = useRef<() => void>(() => {});

  const endPointer = useCallback(
    (cancelled: boolean) => {
      const session = pointer.current;
      stopListening.current();
      if (!session) return;
      cancelFrame(session.raf);
      if (!session.lifted) {
        pointer.current = null;
        return;
      }
      const target = cancelled ? session.from : session.over;
      session.over = target;
      setDrag((current) =>
        current && current.mode === 'pointer'
          ? { ...current, over: target, phase: 'dropping' }
          : current,
      );
      if (cancelled) announce((a) => a.cancelled(labelOf(session.id)));
    },
    [announce, labelOf],
  );

  const autoScroll = useCallback(() => {
    const session = pointer.current;
    if (!session?.lifted) return;
    const scroller = session.scroller;
    if (scroller) {
      const root = scroller === document.scrollingElement || scroller === document.documentElement;
      const rect = root
        ? { bottom: window.innerHeight, left: 0, right: window.innerWidth, top: 0 }
        : scroller.getBoundingClientRect();
      const position = axis === 'y' ? session.lastY : session.lastX;
      const low = axis === 'y' ? rect.top : rect.left;
      const high = axis === 'y' ? rect.bottom : rect.right;
      let step = 0;
      if (position < low + EDGE)
        step = -Math.ceil(((low + EDGE - position) / EDGE) * MAX_SCROLL_STEP);
      else if (position > high - EDGE)
        step = Math.ceil(((position - (high - EDGE)) / EDGE) * MAX_SCROLL_STEP);
      if (step !== 0) {
        if (axis === 'y') scroller.scrollTop += step;
        else scroller.scrollLeft += step;
        updatePointer();
      }
    }
    session.raf = nextFrame(autoScroll);
  }, [axis, updatePointer]);

  const lift = useCallback(
    (session: PointerSession) => {
      const list = listRef.current;
      if (!list) return;
      session.lifted = true;
      session.rects = measure(list);
      session.startRelative = pointerRelative(session);
      session.scroller = findScroller(list, axis);
      const rects = session.rects;
      const from = session.from;
      const dragged = rects[from]!;
      const neighbour =
        from < rects.length - 1
          ? rects[from + 1]!.start - (dragged.start + dragged.size)
          : from > 0
            ? dragged.start - (rects[from - 1]!.start + rects[from - 1]!.size)
            : 0;
      draggedEl.current = itemEls.current.get(session.id) ?? null;
      setDrag({
        from,
        id: session.id,
        mode: 'pointer',
        over: from,
        phase: 'dragging',
        rects,
        space: dragged.size + Math.max(0, neighbour),
      });
      announce((a) => a.pickedUp(labelOf(session.id), from + 1, rects.length));
      session.raf = nextFrame(autoScroll);
    },
    [announce, autoScroll, axis, labelOf, measure, pointerRelative],
  );

  const onPointerDown = useCallback(
    (id: SortableId, event: ReactPointerEvent<HTMLElement>) => {
      if (disabled || latest.current.drag || pointer.current) return;
      if (event.button !== undefined && event.button !== 0) return;
      const from = latest.current.baseIds.indexOf(id);
      if (from < 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {
        // 合成事件或不支持时忽略，下面在 window 上监听同样能收到移动。
      }
      const session: PointerSession = {
        from,
        id,
        lastX: event.clientX,
        lastY: event.clientY,
        lifted: false,
        over: from,
        pointerId: event.pointerId,
        raf: 0,
        rects: [],
        scroller: null,
        startRelative: 0,
        startX: event.clientX,
        startY: event.clientY,
      };
      pointer.current = session;
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== session.pointerId) return;
        session.lastX = move.clientX;
        session.lastY = move.clientY;
        if (!session.lifted) {
          const distance = Math.hypot(move.clientX - session.startX, move.clientY - session.startY);
          if (distance < LIFT_THRESHOLD) return;
          lift(session);
        }
        updatePointer();
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== session.pointerId) return;
        endPointer(up.type === 'pointercancel');
      };
      const onKey = (key: globalThis.KeyboardEvent) => {
        if (key.key !== 'Escape') return;
        key.preventDefault();
        key.stopPropagation();
        endPointer(true);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      window.addEventListener('keydown', onKey, true);
      stopListening.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        window.removeEventListener('keydown', onKey, true);
        stopListening.current = () => {};
      };
    },
    [disabled, endPointer, lift, updatePointer],
  );

  // 放下：被拖项过渡到目标位置，结束后提交。
  useLayoutEffect(() => {
    if (!activeDrag || activeDrag.mode !== 'pointer' || activeDrag.phase !== 'dropping') return;
    const session = pointer.current;
    const element = draggedEl.current;
    const rects = activeDrag.rects ?? [];
    const { from, over } = activeDrag;
    const finish = () => {
      pointer.current = null;
      commit(from, over, 'pointer', activeDrag.id);
    };
    if (!session || !element || rects.length === 0) {
      finish();
      return;
    }
    const target =
      over > from ? rects[over]!.start + rects[over]!.size - rects[from]!.size : rects[over]!.start;
    const offset = target - rects[from]!.start;
    element.style.transform =
      axis === 'y' ? `translate3d(0, ${offset}px, 0)` : `translate3d(${offset}px, 0, 0)`;
    const duration = transitionTime(element);
    if (duration <= 1) {
      finish();
      return;
    }
    let done = false;
    const complete = () => {
      if (done) return;
      done = true;
      finish();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === 'transform') complete();
    };
    element.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(complete, duration + 50);
    return () => {
      element.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
    };
  }, [activeDrag, axis, commit]);

  // 拖拽结束：清掉被拖项的命令式 transform（与 DOM 重排同一帧，避免闪动）。
  useLayoutEffect(() => {
    if (activeDrag?.mode === 'pointer') return;
    const element = draggedEl.current;
    if (element) {
      element.style.transform = '';
      draggedEl.current = null;
    }
  }, [activeDrag]);

  // 键盘移动后焦点留在手柄上（重排 DOM 可能让它失焦）。
  useLayoutEffect(() => {
    if (activeDrag?.mode !== 'keyboard') return;
    const handle = handleEls.current.get(activeDrag.id);
    if (handle && document.activeElement !== handle) handle.focus({ preventScroll: true });
  }, [activeDrag, displaySignature]);

  // FLIP：显示顺序变化（键盘移动、取消、回滚）时让条目从旧位置平滑过渡到新位置。
  // 位置用 offsetLeft/offsetTop（布局位置，不含 transform），列表是条目的 offsetParent。
  useLayoutEffect(() => {
    const next = new Map<SortableId, { x: number; y: number }>();
    for (const id of displayIds) {
      const element = itemEls.current.get(id);
      if (element) next.set(id, { x: element.offsetLeft, y: element.offsetTop });
    }
    const previous = positions.current;
    positions.current = next;
    const animate = !skipFlip.current && !latest.current.reducedMotion && previous.size > 0;
    skipFlip.current = false;
    if (!animate) return;
    const moved: HTMLElement[] = [];
    for (const [id, after] of next) {
      const element = itemEls.current.get(id);
      const before = previous.get(id);
      if (!element || !before) continue;
      const dx = before.x - after.x;
      const dy = before.y - after.y;
      if (dx === 0 && dy === 0) continue;
      element.removeAttribute('data-flip');
      element.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      moved.push(element);
    }
    if (moved.length === 0) return;
    void listRef.current?.offsetWidth;
    const frame = nextFrame(() => {
      for (const element of moved) {
        // data-flip 打开 CSS 里的 transform 过渡（standard 200ms），过渡结束后移除。
        element.setAttribute('data-flip', 'true');
        element.style.transform = '';
        const clear = (event: TransitionEvent) => {
          if (event.target !== element) return;
          element.removeAttribute('data-flip');
          element.removeEventListener('transitionend', clear);
        };
        element.addEventListener('transitionend', clear);
      }
    });
    return () => cancelFrame(frame);
  }, [displaySignature]);

  // 卸载或条目被移除时结束拖拽。
  useEffect(() => {
    if (drag && !activeDrag) {
      stopListening.current();
      if (pointer.current) cancelFrame(pointer.current.raf);
      pointer.current = null;
      setDrag(null);
    }
  }, [activeDrag, drag]);

  useEffect(
    () => () => {
      stopListening.current();
      if (pointer.current) cancelFrame(pointer.current.raf);
    },
    [],
  );

  // —— 键盘 ——

  const onHandleKeyDown = useCallback(
    (id: SortableId, event: KeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      const current = latest.current.drag;
      const total = latest.current.baseIds.length;
      const isToggle = event.key === ' ' || event.key === 'Enter';
      if (!current) {
        if (!isToggle || pointer.current) return;
        event.preventDefault();
        const from = latest.current.baseIds.indexOf(id);
        if (from < 0) return;
        setDrag({ from, id, mode: 'keyboard', over: from, phase: 'dragging' });
        announce((a) => a.pickedUp(labelOf(id), from + 1, total));
        return;
      }
      if (current.mode !== 'keyboard' || current.id !== id) return;
      const previousKeys =
        orientation === 'horizontal' ? ['ArrowLeft', 'ArrowUp'] : ['ArrowUp', 'ArrowLeft'];
      const nextKeys =
        orientation === 'horizontal' ? ['ArrowRight', 'ArrowDown'] : ['ArrowDown', 'ArrowRight'];
      if (previousKeys.includes(event.key) || nextKeys.includes(event.key)) {
        event.preventDefault();
        const over = Math.max(
          0,
          Math.min(total - 1, current.over + (previousKeys.includes(event.key) ? -1 : 1)),
        );
        if (over === current.over) return;
        setDrag({ ...current, over });
        announce((a) => a.moved(labelOf(id), over + 1, total));
        return;
      }
      if (isToggle) {
        event.preventDefault();
        commit(current.from, current.over, 'keyboard', id);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDrag(null);
        announce((a) => a.cancelled(labelOf(id)));
      }
    },
    [announce, commit, disabled, labelOf, orientation],
  );

  const onHandleBlur = useCallback(
    (id: SortableId) => {
      // 重排 DOM 引起的短暂失焦会在布局阶段被重新聚焦；微任务后仍不在手柄上才算离开。
      queueMicrotask(() => {
        const current = latest.current.drag;
        if (!current || current.mode !== 'keyboard' || current.id !== id) return;
        if (document.activeElement === handleEls.current.get(id)) return;
        setDrag(null);
        announce((a) => a.cancelled(labelOf(id)));
      });
    },
    [announce, labelOf],
  );

  // —— 绑定 ——

  const state: UseSortableResult<T>['state'] = !activeDrag
    ? 'idle'
    : activeDrag.mode === 'keyboard'
      ? 'lifted'
      : activeDrag.phase;

  const getItemProps = (id: SortableId): SortableItemBindings => {
    let itemState: SortableItemBindings['data-state'];
    let style: CSSProperties | undefined;
    if (activeDrag?.id === id) {
      itemState = activeDrag.mode === 'keyboard' ? 'lifted' : activeDrag.phase;
    } else if (activeDrag?.mode === 'pointer' && activeDrag.space !== undefined) {
      const index = baseIds.indexOf(id);
      const { from, over, space } = activeDrag;
      let shift = 0;
      if (from < over && index > from && index <= over) shift = -space;
      else if (over < from && index >= over && index < from) shift = space;
      if (shift !== 0) {
        style = {
          transform:
            axis === 'y' ? `translate3d(0, ${shift}px, 0)` : `translate3d(${shift}px, 0, 0)`,
        };
      }
    }
    return {
      'data-sortable-id': String(id),
      'data-state': itemState,
      ref: (node) => {
        if (node) itemEls.current.set(id, node);
        else itemEls.current.delete(id);
      },
      style,
    };
  };

  const getHandleProps = (id: SortableId, label?: string): SortableHandleBindings => {
    const item = itemById.get(id);
    const itemLabel = item !== undefined && getLabel ? getLabel(item) : String(id);
    const lifted = activeDrag?.id === id;
    return {
      'aria-describedby': instructions ? instructionsId : undefined,
      'aria-label': label ?? handleLabel?.(itemLabel),
      'aria-pressed': activeDrag?.mode === 'keyboard' ? lifted : undefined,
      'data-state': lifted ? (activeDrag?.mode === 'keyboard' ? 'lifted' : 'dragging') : undefined,
      disabled: disabled || undefined,
      onBlur: () => onHandleBlur(id),
      onKeyDown: (event) => onHandleKeyDown(id, event),
      onPointerDown: (event) => onPointerDown(id, event),
      ref: (node) => {
        if (node) handleEls.current.set(id, node);
        else handleEls.current.delete(id);
      },
    };
  };

  let placeholder: CSSProperties | null = null;
  if (activeDrag?.mode === 'pointer' && activeDrag.rects && activeDrag.rects.length > 0) {
    const { from, over, rects } = activeDrag;
    const dragged = rects[from]!;
    const start =
      over > from ? rects[over]!.start + rects[over]!.size - dragged.size : rects[over]!.start;
    placeholder =
      axis === 'y'
        ? {
            height: dragged.size,
            left: 0,
            position: 'absolute',
            top: 0,
            transform: `translate3d(${dragged.crossStart}px, ${start}px, 0)`,
            width: dragged.crossSize,
          }
        : {
            height: dragged.crossSize,
            left: 0,
            position: 'absolute',
            top: 0,
            transform: `translate3d(${start}px, ${dragged.crossStart}px, 0)`,
            width: dragged.size,
          };
  }

  return {
    activeId: activeDrag?.id ?? null,
    announcement,
    getHandleProps,
    getItemProps,
    instructionsId,
    items: displayIds.map((id) => itemById.get(id)!),
    listProps: {
      'data-orientation': orientation,
      'data-state': state,
      ref: (node) => {
        listRef.current = node;
      },
    },
    orientation,
    placeholder,
    state,
  };
}

// —— 组件 ——

interface SortableContextValue {
  instructions?: string;
  listTag: 'div' | 'ol' | 'ul';
  sortable: UseSortableResult<unknown>;
}

const SortableContext = createContext<SortableContextValue | null>(null);
const SortableItemContext = createContext<SortableId | null>(null);

function useSortableContext(component: string): SortableContextValue {
  const context = useContext(SortableContext);
  if (!context) throw new Error(`${component} must be rendered inside <SortableList>.`);
  return context;
}

export type SortableListProps<T> = UseSortableOptions<T> &
  Omit<HTMLAttributes<HTMLElement>, 'children' | 'onError'> & {
    /** 列表元素，默认 `ul`（条目渲染为 `li`）。 */
    as?: 'div' | 'ol' | 'ul';
    /** 按显示顺序渲染条目：`(items) => items.map((item) => <SortableItem id=… />)`。 */
    children: (items: T[]) => ReactNode;
  };

export function SortableList<T>({
  announcements,
  as: Tag = 'ul',
  children,
  className,
  disabled,
  getId,
  getLabel,
  handleLabel,
  instructions,
  items,
  onError,
  onReorder,
  orientation,
  ...props
}: SortableListProps<T>) {
  const sortable = useSortable({
    announcements,
    disabled,
    getId,
    getLabel,
    handleLabel,
    instructions,
    items,
    onError,
    onReorder,
    orientation,
  });
  const value: SortableContextValue = {
    instructions,
    listTag: Tag,
    sortable: sortable as UseSortableResult<unknown>,
  };
  const PlaceholderTag = Tag === 'div' ? 'div' : 'li';

  return (
    <SortableContext.Provider value={value}>
      <Tag {...props} {...sortable.listProps} className={cn('rx-sortable', className)}>
        {children(sortable.items)}
        {sortable.placeholder ? (
          <PlaceholderTag
            aria-hidden="true"
            className="rx-sortable-placeholder"
            role="presentation"
            style={sortable.placeholder}
          />
        ) : null}
      </Tag>
      <div aria-atomic="true" aria-live="polite" className="rx-visually-hidden" role="status">
        {sortable.announcement}
      </div>
      {instructions ? (
        <div hidden id={sortable.instructionsId}>
          {instructions}
        </div>
      ) : null}
    </SortableContext.Provider>
  );
}

export type SortableItemProps = HTMLAttributes<HTMLElement> & {
  /** 默认随列表：`ul/ol` 下为 `li`，`div` 下为 `div`。 */
  as?: 'div' | 'li';
  id: SortableId;
};

export const SortableItem = forwardRef<HTMLElement, SortableItemProps>(function SortableItem(
  { as, children, className, id, style, ...props },
  ref,
) {
  const { listTag, sortable } = useSortableContext('SortableItem');
  const bindings = sortable.getItemProps(id);
  const Tag = as ?? (listTag === 'div' ? 'div' : 'li');
  return (
    <SortableItemContext.Provider value={id}>
      <Tag
        {...props}
        className={cn('rx-sortable-item', className)}
        data-sortable-id={bindings['data-sortable-id']}
        data-state={bindings['data-state']}
        ref={mergeRefs(ref as never, bindings.ref)}
        style={bindings.style ? { ...style, ...bindings.style } : style}
      >
        {children}
      </Tag>
    </SortableItemContext.Provider>
  );
});

export type SortableHandleProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** 默认 lucide GripVertical。 */
  icon?: ReactNode;
  /** 条目 id；在 SortableItem 内可省略。 */
  itemId?: SortableId;
  /** 手柄可读名称；缺省用列表的 `handleLabel(label)`。 */
  label?: string;
};

export const SortableHandle = forwardRef<HTMLButtonElement, SortableHandleProps>(
  function SortableHandle({ className, icon, itemId, label, ...props }, ref) {
    const { sortable } = useSortableContext('SortableHandle');
    const contextId = useContext(SortableItemContext);
    const id = itemId ?? contextId;
    if (id === null) throw new Error('SortableHandle needs an itemId outside <SortableItem>.');
    const bindings = sortable.getHandleProps(id, label);
    return (
      <button
        type="button"
        {...props}
        aria-describedby={cn(props['aria-describedby'], bindings['aria-describedby']) || undefined}
        aria-label={bindings['aria-label'] ?? props['aria-label']}
        aria-pressed={bindings['aria-pressed']}
        className={cn('rx-sortable-handle', className)}
        data-state={bindings['data-state']}
        disabled={props.disabled ?? bindings.disabled}
        onBlur={(event) => {
          props.onBlur?.(event);
          bindings.onBlur(event);
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (!event.defaultPrevented) bindings.onKeyDown(event);
        }}
        onPointerDown={(event) => {
          props.onPointerDown?.(event);
          if (!event.defaultPrevented) bindings.onPointerDown(event);
        }}
        ref={mergeRefs(ref, bindings.ref)}
      >
        {icon ?? <GripVertical aria-hidden="true" strokeWidth={1.5} />}
      </button>
    );
  },
);
