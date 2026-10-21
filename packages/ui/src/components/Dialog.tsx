'use client';

import { OctagonAlert, TriangleAlert, X } from 'lucide-react';
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';

import { cn } from '../cn';
import { getFocusableElements, useFocusTrap } from '../primitives/focus';
import {
  Portal,
  PersistentPortal,
  useIsClient,
  useLayer,
  type LayerKind,
} from '../primitives/layer';
import { mergeRefs } from '../primitives/refs';
import { useControllableState } from '../primitives/useControllableState';
import { usePresence } from '../primitives/usePresence';
import { Button, type ControlTouchTarget } from './Button';
import { IconButton } from './IconButton';

/** 弹窗宽度（规范 03 §3.15）：sm 480、md 640（默认）、lg 864、xl 1080。 */
export type DialogSize = 'lg' | 'md' | 'sm' | 'xl';

/** 有未保存修改时，任何关闭方式先弹出的「放弃未保存的修改？」确认框文案（规范 05 §7）。 */
export interface DialogDiscardConfirm {
  cancelLabel: ReactNode;
  confirmLabel: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}

type TriggerProps = {
  'aria-expanded'?: boolean;
  'aria-haspopup'?: 'dialog';
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
};

/** Dialog 与 Drawer 共用的属性。 */
export interface OverlayBaseProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'role' | 'title'
> {
  /** 内容区（唯一可滚动的区域）。不传时不渲染内容区。 */
  children?: ReactNode;
  /** 头部右侧关闭按钮的可读名称；不传则不显示关闭按钮。 */
  closeLabel?: string;
  /** 头部关闭按钮的响应式触控目标；不传时保留原有 sm 尺寸。 */
  touchTarget?: ControlTouchTarget;
  defaultOpen?: boolean;
  /** 关闭时保持媒体内联挂载，放大时移动同一个 portal 容器。 */
  inlineWhenClosed?: boolean;
  /** 媒体内容填满弹窗可用高度，并自行管理内部滚动。 */
  contentLayout?: 'media' | 'default';
  /** 标题下的副标题（12 `text-secondary`），同时作为 aria-describedby。 */
  description?: ReactNode;
  /** 有未保存修改：×、Esc、遮罩、DialogClose 都先弹 `discardConfirm` 确认框。 */
  dirty?: boolean;
  discardConfirm?: DialogDiscardConfirm;
  /** 是否响应任何关闭操作（×、Esc、遮罩、DialogClose）。提交进行中传 false。默认 true。 */
  dismissible?: boolean;
  /** 点遮罩是否关闭。表单弹窗传 false（规范 03 §3.15）。默认 true。 */
  dismissOnOverlay?: boolean;
  /** 底部操作区，调用方按 `[取消 default] [主操作 primary]` 渲染按钮，右对齐。 */
  footer?: ReactNode;
  /** 标题左侧的 20px 语义图标（ConfirmDialog 使用）。 */
  icon?: ReactNode;
  /** 打开后聚焦的元素；默认第一个可输入控件，没有则第一个非关闭按钮的可聚焦元素。 */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Visible persistent trigger when the opening menu item is unmounted. */
  returnFocusTarget?: RefObject<HTMLElement | null>;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  /** `alertdialog` 用于确认框；默认 `dialog`。 */
  role?: 'alertdialog' | 'dialog';
  title: ReactNode;
  /** 可选的触发元素：点击打开，关闭后焦点回到它。 */
  trigger?: ReactElement;
}

export interface DialogProps extends OverlayBaseProps {
  size?: DialogSize;
  /** `warm`：表单弹窗（新建课程、新建模块）用 `surface-warm` 底；默认 `surface`。 */
  surface?: 'default' | 'warm';
}

interface OverlayShellProps extends OverlayBaseProps {
  layerKind: Extract<LayerKind, 'drawer' | 'modal'>;
  placement?: 'bottom' | 'right';
  size?: string;
  surface?: 'default' | 'warm';
  variant: 'dialog' | 'drawer';
}

const DialogCloseContext = createContext<(() => void) | null>(null);

const noop = () => {};

/**
 * 在 Dialog / Drawer 内部拿到「请求关闭」函数：与 ×、Esc 一样遵守 `dismissible` 与未保存修改确认。
 * 只能在弹窗内容所渲染的组件里调用；在弹窗外调用得到空函数。
 */
export function useDialogClose(): () => void {
  return useContext(DialogCloseContext) ?? noop;
}

/** 把单个子元素（通常是底部「取消」按钮）变成「请求关闭」：`<DialogClose><Button>…</Button></DialogClose>`。 */
export function DialogClose({ children }: { children: ReactElement }) {
  const close = useDialogClose();
  if (!isValidElement<TriggerProps>(children)) return children;
  const childProps = children.props;
  return cloneElement(children, {
    onClick: (event: MouseEvent<HTMLElement>) => {
      childProps.onClick?.(event);
      if (!event.defaultPrevented) close();
    },
  });
}

/** 确认框左侧的 20px 语义图标：默认警告，`danger` 为危险。 */
export function ConfirmIcon({ tone = 'default' }: { tone?: 'danger' | 'default' }) {
  return tone === 'danger' ? (
    <OctagonAlert strokeWidth={1.5} />
  ) : (
    <TriangleAlert strokeWidth={1.5} />
  );
}

const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="combobox"]';

function isEmptyNode(node: ReactNode) {
  return node === undefined || node === null || node === false || node === '';
}

/** Dialog 与 Drawer 的共同实现：portal、浮层栈、焦点陷阱、presence、关闭与未保存确认。 */
export const OverlayShell = forwardRef<HTMLDivElement, OverlayShellProps>(function OverlayShell(
  {
    'aria-describedby': ariaDescribedBy,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    children,
    className,
    closeLabel,
    touchTarget,
    defaultOpen = false,
    inlineWhenClosed = false,
    contentLayout = 'default',
    description,
    dirty = false,
    discardConfirm,
    dismissible = true,
    dismissOnOverlay = true,
    footer,
    icon,
    initialFocus,
    returnFocusTarget,
    layerKind,
    onOpenChange,
    open: openProp,
    placement,
    role = 'dialog',
    size,
    surface,
    title,
    trigger,
    variant,
    ...props
  },
  ref,
) {
  const client = useIsClient();
  const [open, setControllableOpen] = useControllableState({
    defaultValue: defaultOpen,
    onChange: onOpenChange,
    value: openProp,
  });
  // 受控时每次关闭请求都通知调用方：父组件可能拒绝关闭且不重渲染（例如 ConfirmDialog 的 onCancel
  // 被忽略），useControllableState 会记住上次请求的值而吞掉后续同值请求。
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const controlled = openProp !== undefined;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlled) {
        if (next !== openProp) onOpenChangeRef.current?.(next);
        return;
      }
      setControllableOpen(next);
    },
    [controlled, openProp, setControllableOpen],
  );
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const autoFocusRef = useRef<HTMLElement | null>(null);
  const discardCancelRef = useRef<HTMLButtonElement | null>(null);
  const presence = usePresence<HTMLDivElement>(open);

  const requestClose = useCallback(() => {
    if (!dismissible) return;
    if (dirty && discardConfirm) {
      setConfirmingDiscard(true);
      return;
    }
    setOpen(false);
  }, [dirty, discardConfirm, dismissible, setOpen]);

  const layer = useLayer({
    active: open && client,
    elements: [panelRef],
    kind: layerKind,
    // 遮罩点击由遮罩元素自己处理：模态层之下没有可点的「外部」，
    // 且子层（例如放弃修改确认框）的遮罩不能被当成本层的外部点击。
    onDismiss: (reason) => {
      if (reason === 'escape') requestClose();
    },
    outside: false,
  });

  // 默认初始焦点：第一个可输入控件 → 第一个非关闭按钮的可聚焦元素 → 关闭按钮 → 面板本身。
  // 在 useFocusTrap 的 effect 之前算好（layout effect 先于 passive effect 执行）。
  useLayoutEffect(() => {
    if (!open || initialFocus) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = getFocusableElements(panel);
    autoFocusRef.current =
      focusable.find((element) => element.matches(FIELD_SELECTOR)) ??
      focusable.find((element) => element !== closeRef.current) ??
      closeRef.current ??
      null;
  }, [client, initialFocus, open]);

  useFocusTrap({
    active: open && client,
    container: panelRef,
    initialFocus: initialFocus ?? autoFocusRef,
    returnFocusTarget,
  });

  useEffect(() => {
    if (!open) setConfirmingDiscard(false);
  }, [open]);

  const triggerElement =
    trigger !== undefined && isValidElement<TriggerProps>(trigger)
      ? cloneElement(trigger, {
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          onClick: (event: MouseEvent<HTMLElement>) => {
            trigger.props.onClick?.(event);
            if (!event.defaultPrevented) setOpen(true);
          },
          ref: mergeRefs(trigger.props.ref, (node: HTMLElement | null) => {
            triggerRef.current = node;
          }),
        })
      : null;

  const inline = inlineWhenClosed && !open;
  const Container = inlineWhenClosed ? PersistentPortal : Portal;
  const hasDescription = !isEmptyNode(description);

  return (
    <>
      {triggerElement}
      {presence.mounted || inlineWhenClosed ? (
        <Container inline={inline}>
          <layer.Provider>
            <DialogCloseContext.Provider value={requestClose}>
              <div
                className={inline ? 'rx-inline-dialog-root' : 'rx-overlay-root'}
                data-state={presence.state}
                data-variant={variant}
                style={{ zIndex: layer.zIndex }}
              >
                <div
                  aria-hidden="true"
                  hidden={inline}
                  className="rx-overlay-backdrop"
                  data-state={presence.state}
                  onClick={() => {
                    if (dismissOnOverlay) requestClose();
                  }}
                />
                <div
                  {...props}
                  aria-describedby={ariaDescribedBy ?? (hasDescription ? descriptionId : undefined)}
                  aria-labelledby={inline ? undefined : (ariaLabelledBy ?? titleId)}
                  aria-label={
                    ariaLabel ?? (inline && typeof title === 'string' ? title : undefined)
                  }
                  aria-modal={inline ? undefined : true}
                  className={cn(
                    inline ? 'rx-inline-dialog' : variant === 'dialog' ? 'rx-dialog' : 'rx-drawer',
                    className,
                  )}
                  data-content-layout={contentLayout}
                  data-placement={placement}
                  data-size={size}
                  data-state={presence.state}
                  data-surface={surface === 'warm' ? 'warm' : undefined}
                  ref={mergeRefs(ref, presence.ref, (node: HTMLDivElement | null) => {
                    panelRef.current = node;
                  })}
                  role={inline ? 'region' : role}
                  tabIndex={props.tabIndex ?? -1}
                >
                  {variant === 'drawer' && placement === 'bottom' ? (
                    <div aria-hidden="true" className="rx-drawer-handle" />
                  ) : null}
                  <div className="rx-dialog-header" hidden={inline}>
                    {isEmptyNode(icon) ? null : (
                      <span aria-hidden="true" className="rx-dialog-icon">
                        {icon}
                      </span>
                    )}
                    <div className="rx-dialog-heading">
                      <h2 className="rx-dialog-title" id={titleId}>
                        {title}
                      </h2>
                      {hasDescription ? (
                        <div className="rx-dialog-description" id={descriptionId}>
                          {description}
                        </div>
                      ) : null}
                    </div>
                    {closeLabel ? (
                      <IconButton
                        className="rx-dialog-close"
                        disabled={!dismissible}
                        icon={<X strokeWidth={1.5} />}
                        label={closeLabel}
                        onClick={requestClose}
                        ref={closeRef}
                        size="sm"
                        touchTarget={touchTarget}
                        variant="ghost"
                      />
                    ) : null}
                  </div>
                  {isEmptyNode(children) ? null : (
                    <div className="rx-dialog-body rx-scroll-y">{children}</div>
                  )}
                  {isEmptyNode(footer) ? null : (
                    <div className="rx-dialog-footer" hidden={inline}>
                      {footer}
                    </div>
                  )}
                </div>
              </div>
            </DialogCloseContext.Provider>
            {discardConfirm ? (
              <Dialog
                className="rx-confirm-dialog"
                data-tone="default"
                description={discardConfirm.description}
                footer={
                  <>
                    <Button
                      onClick={() => setConfirmingDiscard(false)}
                      ref={discardCancelRef}
                      size="md"
                      variant="default"
                    >
                      {discardConfirm.cancelLabel}
                    </Button>
                    <Button
                      onClick={() => {
                        setConfirmingDiscard(false);
                        setOpen(false);
                      }}
                      size="md"
                      variant="primary"
                    >
                      {discardConfirm.confirmLabel}
                    </Button>
                  </>
                }
                icon={<ConfirmIcon />}
                initialFocus={discardCancelRef}
                onOpenChange={(next) => {
                  if (!next) setConfirmingDiscard(false);
                }}
                open={open && confirmingDiscard}
                role="alertdialog"
                size="sm"
                title={discardConfirm.title}
              />
            ) : null}
          </layer.Provider>
        </Container>
      ) : null}
    </>
  );
});

/**
 * 模态弹窗（规范 03 §3.15、04 §3.4）。渲染到共享 portal 根节点，焦点陷阱，Esc 只关最上层。
 *
 * - 表单弹窗：`surface="warm"`、`dismissOnOverlay={false}`，并在有修改时传 `dirty` + `discardConfirm`。
 * - 底部「取消」用 `<DialogClose>` 包裹，才会走未保存确认；主按钮提交时 `loading`，必要时 `dismissible={false}`。
 * - 使用约束：最多叠两层（表单弹窗上再弹确认框）；更深的流程改为页面或抽屉。
 */
export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog(props, ref) {
  return <OverlayShell {...props} layerKind="modal" ref={ref} variant="dialog" />;
});
