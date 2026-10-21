'use client';

import { X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';

import { usePrefersReducedMotion } from '../../primitives/usePrefersReducedMotion';
import { usePresence } from '../../primitives/usePresence';
import { Popover } from '../Popover';
import { Tooltip } from '../Tooltip';

/** 胶囊间距与行距（规范 03 §3.6）。 */
const CHIP_GAP = 4;
/** 超过 50 项的列表不做 FLIP（规范 04 §5）。 */
const FLIP_LIMIT = 50;

export interface ChipItem {
  key: string;
  label: ReactNode;
  /** 纯文本：Tooltip 全文与「移除 ××」文案。 */
  text: string;
  locked?: boolean;
  /** 标签还在换取中（不显示任何文字，绝不显示裸 ID）。 */
  pending?: boolean;
}

export interface ChipListHandle {
  /** 把焦点移到最后一个可见胶囊；没有胶囊时返回 false。 */
  focusLast: () => boolean;
}

export interface ChipListProps {
  /** 输入框等跟在胶囊后面的内容（同一个换行容器内）。 */
  children?: ReactNode;
  handleRef?: Ref<ChipListHandle>;
  inputRef: RefObject<HTMLInputElement | null>;
  /** 能否删除（禁用、只读时为 false）。 */
  interactive: boolean;
  items: readonly ChipItem[];
  /** 最多显示几个胶囊（含 +N）；不传时按容器宽度算最多 2 行。 */
  maxChips?: number;
  /** +N 胶囊的可读名称，例如 `(n) => \`另有 ${n} 项\``。 */
  moreLabel?: (count: number) => string;
  onRemove: (key: string) => void;
  /** +N 弹出层的可读名称。 */
  overflowLabel?: string;
  removeLabel: (text: string) => string;
}

interface RenderedChip {
  exiting: boolean;
  item: ChipItem;
}

/** 新列表 + 仍在播放离场动画的旧胶囊（留在原来的位置）。 */
function mergeRendered(previous: RenderedChip[], items: readonly ChipItem[]): RenderedChip[] {
  const nextKeys = new Set(items.map((item) => item.key));
  const exitingAfter = new Map<string | null, RenderedChip[]>();
  let lastSurvivor: string | null = null;
  for (const entry of previous) {
    if (nextKeys.has(entry.item.key)) {
      lastSurvivor = entry.item.key;
      continue;
    }
    const bucket = exitingAfter.get(lastSurvivor) ?? [];
    bucket.push({ exiting: true, item: entry.item });
    exitingAfter.set(lastSurvivor, bucket);
  }
  const result: RenderedChip[] = [...(exitingAfter.get(null) ?? [])];
  for (const item of items) {
    result.push({ exiting: false, item });
    result.push(...(exitingAfter.get(item.key) ?? []));
  }
  return result;
}

function readMotion(element: Element): { duration: number; easing: string } {
  const style = window.getComputedStyle(element);
  const raw = style.getPropertyValue('--reachany-motion-duration-fast').trim();
  const duration = raw.endsWith('ms') ? parseFloat(raw) : parseFloat(raw) * 1000;
  const easing = style.getPropertyValue('--reachany-motion-easing-standard').trim();
  return { duration: Number.isFinite(duration) ? duration : 0, easing: easing || 'ease' };
}

interface ChipProps {
  /** 挂载后新增的胶囊播放 scale(0.8→1) 入场；首屏已有的不播放。 */
  appear?: boolean;
  exiting?: boolean;
  interactive: boolean;
  item: ChipItem;
  nodeRef?: (node: HTMLSpanElement | null) => void;
  onExited?: (key: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLSpanElement>) => void;
  onRemove: (key: string) => void;
  removeLabel: (text: string) => string;
}

/** 单个固定宽度胶囊：超长省略 + Tooltip 全文；× 删除（锁定项没有 ×）。 */
export function Chip({
  appear = false,
  exiting = false,
  interactive,
  item,
  nodeRef,
  onExited,
  onKeyDown,
  onRemove,
  removeLabel,
}: ChipProps) {
  const presence = usePresence<HTMLSpanElement>(!exiting);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const removable = interactive && item.locked !== true && !exiting;

  useEffect(() => {
    if (!presence.mounted) onExited?.(item.key);
  }, [item.key, onExited, presence.mounted]);

  if (!presence.mounted) return null;

  const measure = () => {
    const label = labelRef.current;
    setTruncated(label !== null && label.scrollWidth > label.clientWidth);
  };

  return (
    <Tooltip content={item.text} describeChild={false} disabled={!truncated || exiting}>
      <span
        aria-busy={item.pending || undefined}
        aria-hidden={exiting || undefined}
        className="rx-select-chip"
        data-appear={appear || undefined}
        data-locked={item.locked || undefined}
        data-state={presence.state}
        onFocus={measure}
        onKeyDown={exiting ? undefined : onKeyDown}
        onPointerEnter={measure}
        ref={(node) => {
          presence.ref(node);
          nodeRef?.(node);
        }}
        tabIndex={exiting ? undefined : -1}
      >
        <span className="rx-select-chip-label" ref={labelRef}>
          {item.pending ? null : item.label}
        </span>
        {removable ? (
          <button
            aria-label={removeLabel(item.text)}
            className="rx-select-chip-remove"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRemove(item.key);
            }}
            onMouseDown={(event) => event.preventDefault()}
            tabIndex={-1}
            type="button"
          >
            <X aria-hidden="true" strokeWidth={1.5} />
          </button>
        ) : null}
      </span>
    </Tooltip>
  );
}

/**
 * 多选胶囊列表（规范 03 §3.6、04 §3.10）：换行、最多 2 行，溢出收进同宽 +N 胶囊（Popover 列出其余）；
 * ←/→ 在胶囊间移动，Backspace/Delete 删除当前；删除 scale(0.8)+淡出后其余胶囊 FLIP 补位。
 */
export function ChipList({
  children,
  handleRef,
  inputRef,
  interactive,
  items,
  maxChips,
  moreLabel,
  onRemove,
  overflowLabel,
  removeLabel,
}: ChipListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY);
  const reducedMotion = usePrefersReducedMotion();

  useLayoutEffect(() => {
    if (maxChips !== undefined) return;
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') return;
    const measure = () => {
      const width = container.clientWidth;
      const chipWidth = parseFloat(
        window.getComputedStyle(container).getPropertyValue('--reachany-chip-width'),
      );
      if (!(width > 0) || !(chipWidth > 0)) {
        setCapacity(Number.POSITIVE_INFINITY);
        return;
      }
      const perRow = Math.max(1, Math.floor((width + CHIP_GAP) / (chipWidth + CHIP_GAP)));
      // 两行，最后一格留给输入框。
      setCapacity(Math.max(1, perRow * 2 - 1));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [maxChips]);

  const limit = Math.max(1, maxChips ?? capacity);
  const overflowing = items.length > limit;
  const visible = overflowing ? items.slice(0, limit - 1) : items;
  const hidden = overflowing ? items.slice(limit - 1) : [];

  // 只按 key 比较：调用方每次渲染都会新建 item 对象，未离场的胶囊直接读最新的 item。
  const visibleKey = visible.map((item) => item.key).join('\u0000');
  const [previousKey, setPreviousKey] = useState(visibleKey);
  const [rendered, setRendered] = useState<RenderedChip[]>(() =>
    visible.map((item) => ({ exiting: false, item })),
  );
  if (visibleKey !== previousKey) {
    setPreviousKey(visibleKey);
    setRendered((current) => mergeRendered(current, visible));
  }
  const liveItems = new Map(visible.map((item) => [item.key, item]));

  const initialKeysRef = useRef<Set<string> | null>(null);
  if (initialKeysRef.current === null) {
    initialKeysRef.current = new Set(visible.map((item) => item.key));
  }
  const initialKeys = initialKeysRef.current;
  const nodes = useRef(new Map<string, HTMLSpanElement>());
  const positions = useRef(new Map<string, DOMRect>());

  // FLIP：胶囊增删后其余胶囊从旧位置平滑补位（fast），减少动效时跳过。
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    const animate = !reducedMotion && rendered.length <= FLIP_LIMIT;
    nodes.current.forEach((node, key) => {
      const rect = node.getBoundingClientRect();
      next.set(key, rect);
      const previous = positions.current.get(key);
      if (!animate || !previous || typeof node.animate !== 'function') return;
      const dx = previous.left - rect.left;
      const dy = previous.top - rect.top;
      if (dx === 0 && dy === 0) return;
      const { duration, easing } = readMotion(node);
      if (duration <= 1) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration,
        easing,
      });
    });
    positions.current = next;
  }, [reducedMotion, rendered]);

  const onExited = useCallback((key: string) => {
    setRendered((current) => current.filter((entry) => !(entry.exiting && entry.item.key === key)));
  }, []);

  const liveKeys = visible.map((item) => item.key);
  const focusChip = (key: string | undefined) => {
    if (key === undefined) return false;
    const node = nodes.current.get(key);
    if (!node) return false;
    node.focus();
    return true;
  };

  useImperativeHandle(handleRef, () => ({
    focusLast: () => focusChip(liveKeys.at(-1)),
  }));

  const onChipKeyDown = (item: ChipItem) => (event: KeyboardEvent<HTMLSpanElement>) => {
    const index = liveKeys.indexOf(item.key);
    const removable = interactive && item.locked !== true;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        focusChip(liveKeys[index - 1]);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (!focusChip(liveKeys[index + 1])) inputRef.current?.focus();
        return;
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        if (!removable) return;
        onRemove(item.key);
        if (event.key === 'Delete' && focusChip(liveKeys[index + 1])) return;
        inputRef.current?.focus();
        return;
      case 'Escape':
        inputRef.current?.focus();
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          inputRef.current?.focus();
        }
    }
  };

  return (
    <div className="rx-select-chips" ref={containerRef}>
      {rendered.map(({ exiting, item: snapshot }) => {
        const item = (!exiting && liveItems.get(snapshot.key)) || snapshot;
        return (
          <Chip
            appear={!initialKeys.has(item.key)}
            exiting={exiting}
            interactive={interactive}
            item={item}
            key={item.key}
            nodeRef={(node) => {
              if (node && !exiting) nodes.current.set(item.key, node);
              else if (!node || exiting) nodes.current.delete(item.key);
            }}
            onExited={onExited}
            onKeyDown={onChipKeyDown(item)}
            onRemove={onRemove}
            removeLabel={removeLabel}
          />
        );
      })}
      {hidden.length > 0 ? (
        <Popover
          label={overflowLabel}
          trigger={
            <button
              aria-label={moreLabel?.(hidden.length)}
              className="rx-select-chip rx-select-chip-more"
              onClick={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              type="button"
            >
              {`+${hidden.length}`}
            </button>
          }
        >
          <div className="rx-select-overflow">
            {hidden.map((item) => (
              <Chip
                interactive={interactive}
                item={item}
                key={item.key}
                onRemove={onRemove}
                removeLabel={removeLabel}
              />
            ))}
          </div>
        </Popover>
      ) : null}
      {children}
    </div>
  );
}
