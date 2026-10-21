'use client';

import { EllipsisVertical } from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

import { cn } from '../cn';
import { Portal, useLayer } from '../primitives/layer';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import { useFloating, type FloatingPlacement } from '../primitives/useFloating';
import { usePresence } from '../primitives/usePresence';
import type { ControlSize } from './Button';
import { IconButton } from './IconButton';

export interface DropdownMenuItem {
  type?: 'item';
  /** 危险操作：自动排到菜单最后、上方加分割线，`danger` 字色。 */
  danger?: boolean;
  disabled?: boolean;
  /** 16px 图标（lucide 元素）。 */
  icon?: ReactNode;
  key: string;
  label: ReactNode;
  onSelect?: () => void;
  /** 首字母跳转使用的纯文本；`label` 不是字符串时需要提供。 */
  textValue?: string;
}

export interface DropdownMenuSeparator {
  type: 'separator';
  key?: string;
}

/** 分组标题（不可选）。 */
export interface DropdownMenuGroupLabel {
  type: 'label';
  key?: string;
  label: ReactNode;
}

export type DropdownMenuEntry = DropdownMenuGroupLabel | DropdownMenuItem | DropdownMenuSeparator;

type TriggerProps = {
  'aria-controls'?: string;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: 'menu';
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
};

export interface DropdownMenuProps {
  /** 默认触发器的 className（只用于外部布局）。 */
  className?: string;
  defaultOpen?: boolean;
  /** 禁用默认触发器。 */
  disabled?: boolean;
  items: readonly DropdownMenuEntry[];
  /** 触发器与菜单的可读名称（默认触发器的 aria-label 与 Tooltip）。 */
  label: string;
  /** 菜单面板的附加 className。 */
  menuClassName?: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  placement?: FloatingPlacement;
  /** 默认触发器尺寸。 */
  size?: Exclude<ControlSize, 'xl'>;
  /** 自定义触发元素（单个按钮）；默认是 ghost IconButton + more-vertical 图标。 */
  trigger?: ReactElement;
}

type FocusIntent = 'first' | 'last' | 'menu';

type RenderEntry =
  | { kind: 'item'; item: DropdownMenuItem; index: number }
  | { kind: 'label'; key: string; label: ReactNode }
  | { kind: 'separator'; key: string };

function isItem(entry: DropdownMenuEntry): entry is DropdownMenuItem {
  return entry.type === undefined || entry.type === 'item';
}

/** 危险项排到最后并在上方加分割线；去掉开头、结尾与连续的分割线。 */
function arrange(entries: readonly DropdownMenuEntry[]): DropdownMenuEntry[] {
  const regular = entries.filter((entry) => !(isItem(entry) && entry.danger));
  const danger = entries.filter((entry) => isItem(entry) && entry.danger);
  const ordered: DropdownMenuEntry[] =
    danger.length > 0
      ? [...regular, { key: 'rx-danger-separator', type: 'separator' }, ...danger]
      : regular;
  const result: DropdownMenuEntry[] = [];
  for (const entry of ordered) {
    const previous = result[result.length - 1];
    if (entry.type === 'separator' && (previous === undefined || previous.type === 'separator'))
      continue;
    result.push(entry);
  }
  while (result.length > 0 && result[result.length - 1]?.type === 'separator') result.pop();
  return result;
}

function textOf(item: DropdownMenuItem): string {
  if (item.textValue !== undefined) return item.textValue;
  return typeof item.label === 'string' || typeof item.label === 'number' ? String(item.label) : '';
}

/**
 * 「更多操作」菜单（规范 03 §3.13、04 §3.7），WAI-ARIA menu button 模式：
 * ↑/↓ 循环、Home/End、Enter/Space 选择、Esc 关闭、首字母跳转；选择后关闭并把焦点还给触发器。
 */
export function DropdownMenu({
  className,
  defaultOpen = false,
  disabled = false,
  items,
  label,
  menuClassName,
  onOpenChange,
  open: openProp,
  placement = 'bottom-end',
  size,
  trigger,
}: DropdownMenuProps) {
  const [open, setOpen] = useControllableState({
    defaultValue: defaultOpen,
    onChange: onOpenChange,
    value: openProp,
  });
  const menuId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const intentRef = useRef<FocusIntent>('menu');
  const presence = usePresence<HTMLDivElement>(open);
  const floating = useFloating({
    anchor: triggerRef,
    floating: menuRef,
    matchWidth: 'none',
    maxHeight: 320,
    open: presence.mounted,
    placement,
  });

  const entries = useMemo<RenderEntry[]>(() => {
    let index = 0;
    return arrange(items).map((entry, position) => {
      if (entry.type === 'separator')
        return { key: entry.key ?? `separator-${position}`, kind: 'separator' };
      if (entry.type === 'label')
        return { key: entry.key ?? `label-${position}`, kind: 'label', label: entry.label };
      return { index: index++, item: entry, kind: 'item' };
    });
  }, [items]);
  const menuItems = useMemo(
    () => entries.flatMap((entry) => (entry.kind === 'item' ? [entry.item] : [])),
    [entries],
  );

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const layer = useLayer({
    active: open,
    elements: [triggerRef, menuRef],
    kind: 'dropdown',
    onDismiss: (reason) => close(reason === 'escape'),
  });

  const enabledIndexes = () => menuItems.flatMap((item, index) => (item.disabled ? [] : [index]));

  const focusItem = (index: number | undefined) => {
    if (index === undefined) return;
    itemRefs.current[index]?.focus({ preventScroll: true });
  };

  const positioned = floating.style.visibility !== 'hidden';

  useEffect(() => {
    if (!open || !positioned) return;
    const enabled = enabledIndexes();
    const intent = intentRef.current;
    intentRef.current = 'menu';
    if (intent === 'first' && enabled.length > 0) focusItem(enabled[0]);
    else if (intent === 'last' && enabled.length > 0) focusItem(enabled[enabled.length - 1]);
    else menuRef.current?.focus({ preventScroll: true });
    // 只在打开（且定位完成）时移动焦点。
  }, [open, positioned]);

  const openWith = (intent: FocusIntent) => {
    intentRef.current = intent;
    setOpen(true);
  };

  const currentIndex = () =>
    itemRefs.current.findIndex((element) => element !== null && element === document.activeElement);

  const select = (item: DropdownMenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect?.();
  };

  const move = (direction: 1 | -1) => {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const current = currentIndex();
    const position = enabled.indexOf(current);
    if (position === -1) {
      focusItem(direction === 1 ? enabled[0] : enabled[enabled.length - 1]);
      return;
    }
    focusItem(enabled[(position + direction + enabled.length) % enabled.length]);
  };

  const typeahead = (character: string) => {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const needle = character.toLocaleLowerCase();
    const start = enabled.indexOf(currentIndex());
    for (let step = 1; step <= enabled.length; step += 1) {
      const index = enabled[(start + step + enabled.length) % enabled.length]!;
      const item = menuItems[index];
      if (item && textOf(item).trim().toLocaleLowerCase().startsWith(needle)) {
        focusItem(index);
        return;
      }
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
      case 'PageUp': {
        event.preventDefault();
        focusItem(enabledIndexes()[0]);
        return;
      }
      case 'End':
      case 'PageDown': {
        event.preventDefault();
        const enabled = enabledIndexes();
        focusItem(enabled[enabled.length - 1]);
        return;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const item = menuItems[currentIndex()];
        if (item) select(item);
        return;
      }
      case 'Tab':
        event.preventDefault();
        close(true);
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          typeahead(event.key);
        }
    }
  };

  const triggerHandlers = (existing?: TriggerProps) => ({
    'aria-controls': open ? menuId : undefined,
    'aria-expanded': open,
    'aria-haspopup': 'menu' as const,
    onClick: (event: MouseEvent<HTMLElement>) => {
      existing?.onClick?.(event);
      if (event.defaultPrevented) return;
      if (open) close(false);
      // detail === 0：键盘（Enter/Space）触发的 click，按 APG 聚焦第一项；鼠标打开时聚焦菜单本身。
      else openWith(event.detail === 0 ? 'first' : 'menu');
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      existing?.onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openWith(event.key === 'ArrowDown' ? 'first' : 'last');
      }
    },
  });

  const setTriggerNode = (node: HTMLElement | null) => {
    triggerRef.current = node;
  };

  const triggerElement =
    trigger !== undefined && isValidElement<TriggerProps>(trigger) ? (
      cloneElement(trigger, {
        ...triggerHandlers(trigger.props),
        ref: mergeRefs(trigger.props.ref, setTriggerNode),
      })
    ) : (
      <IconButton
        {...triggerHandlers()}
        className={className}
        disabled={disabled}
        icon={<EllipsisVertical strokeWidth={1.5} />}
        label={label}
        ref={setTriggerNode}
        size={size}
        variant="ghost"
      />
    );

  return (
    <>
      {triggerElement}
      {presence.mounted ? (
        <Portal>
          <layer.Provider>
            <div
              aria-label={label}
              aria-orientation="vertical"
              className={cn('rx-floating-panel', 'rx-dropdown-menu', menuClassName)}
              data-side={floating.side}
              data-state={presence.state}
              id={menuId}
              onKeyDown={onMenuKeyDown}
              ref={(node) => {
                menuRef.current = node;
                presence.ref(node);
              }}
              role="menu"
              style={{ ...floating.style, zIndex: layer.zIndex }}
              tabIndex={-1}
            >
              {entries.map((entry) => {
                if (entry.kind === 'separator')
                  return (
                    <div className="rx-dropdown-menu-separator" key={entry.key} role="separator" />
                  );
                if (entry.kind === 'label')
                  return (
                    <div
                      className="rx-dropdown-menu-group-label"
                      key={entry.key}
                      role="presentation"
                    >
                      {entry.label}
                    </div>
                  );
                const { index, item } = entry;
                return (
                  <div
                    aria-disabled={item.disabled || undefined}
                    className="rx-dropdown-menu-item"
                    data-danger={item.danger ? '' : undefined}
                    data-disabled={item.disabled ? '' : undefined}
                    key={item.key}
                    onClick={() => select(item)}
                    onPointerLeave={() => {
                      if (itemRefs.current[index] === document.activeElement)
                        menuRef.current?.focus({ preventScroll: true });
                    }}
                    onPointerMove={() => {
                      const element = itemRefs.current[index];
                      if (!item.disabled && element && element !== document.activeElement)
                        element.focus({ preventScroll: true });
                    }}
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    role="menuitem"
                    tabIndex={-1}
                  >
                    {item.icon === undefined || item.icon === null ? null : (
                      <span aria-hidden="true" className="rx-dropdown-menu-icon">
                        {item.icon}
                      </span>
                    )}
                    <span className="rx-dropdown-menu-text">{item.label}</span>
                  </div>
                );
              })}
            </div>
          </layer.Provider>
        </Portal>
      ) : null}
    </>
  );
}
