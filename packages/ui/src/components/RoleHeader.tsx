'use client';

import { ChevronDown, ChevronUp, LogOut, Menu, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '../cn';
import { BrandMark } from './BrandMark';
import { Avatar } from './Avatar';
import {
  ROLE_HEADER_COLLAPSED_ATTRIBUTE,
  ROLE_HEADER_COLLAPSE_STORAGE_KEY,
} from './RoleHeaderPersistence';

export interface RoleHeaderNavItem {
  ariaCurrent?: 'location' | 'page';
  className?: string;
  current: boolean;
  href: string;
  label: string;
}

export interface RoleHeaderProfileItem {
  label: string;
  value: string;
}

export interface RoleHeaderCollapsibleConfig {
  collapseLabel: string;
  restoreLabel: string;
}

export interface RoleHeaderProps {
  avatarLabel: string;
  avatarText: string;
  avatarSrc?: string | null;
  profileTriggerRef?: React.Ref<HTMLButtonElement>;
  editProfileLabel?: string;
  onEditProfile?: () => void;
  avatarTitle?: string;
  brandHref: string;
  brandLabel?: ReactNode;
  className?: string;
  collapsible?: RoleHeaderCollapsibleConfig;
  headerActions?: ReactNode;
  logoutAction?: string;
  keepProfileMounted?: boolean;
  navItems: readonly RoleHeaderNavItem[];
  navLabel: string;
  profileActions?: ReactNode;
  profileItems?: readonly RoleHeaderProfileItem[];
  profileName?: string;
  signOutLabel: string;
}

/** 视口宽度不超过该值时 Header 导航一律折叠为菜单（规范 02 §6：< 1024）。 */
export const ROLE_HEADER_COMPACT_MAX_WIDTH = 1023;

export function shouldUseResponsiveRoleHeader(
  availableWidth: number,
  requiredDesktopWidth: number,
  compactViewport = false,
): boolean {
  return compactViewport || requiredDesktopWidth > availableWidth;
}

export function clampResponsiveRolePageMinWidth(
  availableWidth: number,
  intrinsicHeaderWidth: number,
): number {
  return Math.max(0, Math.min(availableWidth, intrinsicHeaderWidth));
}

export function resolveResponsiveRoleHeaderAvailableWidth(
  innerWidth: number,
  documentClientWidth: number,
): number {
  const safeInnerWidth = Number.isFinite(innerWidth) ? Math.max(0, innerWidth) : 0;
  const safeDocumentWidth = Number.isFinite(documentClientWidth)
    ? Math.max(0, documentClientWidth)
    : 0;
  if (safeInnerWidth === 0) return safeDocumentWidth;
  if (safeDocumentWidth === 0) return safeInnerWidth;
  return Math.min(safeInnerWidth, safeDocumentWidth);
}

export function prepareRoleHeaderMeasurementClone(
  header: HTMLElement,
  responsive: boolean,
): HTMLElement {
  const clone = header.cloneNode(true) as HTMLElement;
  clone.classList.toggle('rx-role-header-responsive', responsive);
  clone.removeAttribute('data-role-header-collapsible');
  clone.removeAttribute('data-role-header-collapsed');
  return clone;
}

function measureIntrinsicRoleHeaderWidth(header: HTMLElement, responsive: boolean): number {
  const clone = prepareRoleHeaderMeasurementClone(header, responsive);
  Object.assign(clone.style, {
    left: '0',
    maxWidth: 'none',
    minWidth: 'max-content',
    pointerEvents: 'none',
    position: 'absolute',
    top: '0',
    visibility: 'hidden',
    width: 'max-content',
  });
  document.body.append(clone);
  const width = Math.ceil(clone.getBoundingClientRect().width);
  clone.remove();
  return width;
}

function readPersistedCollapsedState(): boolean {
  return document.documentElement.getAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE) === 'true';
}

function persistCollapsedState(collapsed: boolean): boolean {
  try {
    if (collapsed) {
      window.sessionStorage.setItem(ROLE_HEADER_COLLAPSE_STORAGE_KEY, 'true');
      document.documentElement.setAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE, 'true');
      return true;
    } else {
      window.sessionStorage.removeItem(ROLE_HEADER_COLLAPSE_STORAGE_KEY);
      document.documentElement.removeAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE);
      return false;
    }
  } catch {
    document.documentElement.removeAttribute(ROLE_HEADER_COLLAPSED_ATTRIBUTE);
    return false;
  }
}

function focusMainContent(header: HTMLElement | null) {
  const main =
    header?.parentElement?.querySelector<HTMLElement>('main') ??
    document.querySelector<HTMLElement>('main');
  if (!main) return;

  const previousTabIndex = main.getAttribute('tabindex');
  main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: true });
  main.addEventListener(
    'blur',
    () => {
      if (previousTabIndex === null) main.removeAttribute('tabindex');
      else main.setAttribute('tabindex', previousTabIndex);
    },
    { once: true },
  );
}

export function RoleHeader({
  avatarLabel,
  avatarText,
  avatarSrc,
  profileTriggerRef,
  editProfileLabel,
  onEditProfile,
  avatarTitle,
  brandHref,
  brandLabel,
  className,
  collapsible,
  headerActions,
  keepProfileMounted = false,
  logoutAction = '/auth/logout',
  navItems,
  navLabel,
  profileActions,
  profileItems = [],
  profileName,
  signOutLabel,
}: RoleHeaderProps) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [responsiveMenuOpen, setResponsiveMenuOpen] = useState(false);
  const [responsive, setResponsive] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const profileMenuId = useId();
  const responsiveMenuId = useId();
  const headerRef = useRef<HTMLElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<'collapse' | 'restore' | null>(null);
  const responsiveMenuButtonRef = useRef<HTMLButtonElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!collapsible) return;
    setCollapsed(readPersistedCollapsedState());
  }, [collapsible]);

  useLayoutEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (!pendingFocus) return;
    pendingFocusRef.current = null;
    if (pendingFocus === 'restore') restoreButtonRef.current?.focus({ preventScroll: true });
    else collapseButtonRef.current?.focus({ preventScroll: true });
  }, [collapsed, responsive]);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    let animationFrame = 0;
    const measure = () => {
      if (header.dataset.roleHeaderCollapsed === 'true') return;
      // 同时约束布局视口与窗口宽度：既避免既有 min-width 自我放大，也扣除经典滚动条宽度。
      const availableWidth = resolveResponsiveRoleHeaderAvailableWidth(
        window.innerWidth,
        document.documentElement.clientWidth,
      );
      const requiredDesktopWidth = measureIntrinsicRoleHeaderWidth(header, false);
      // 规范 02 §6：< 1024 时导航折叠为菜单；更宽时只在内容放不下才折叠。
      const compactViewport =
        typeof window.matchMedia === 'function'
          ? window.matchMedia(`(max-width: ${ROLE_HEADER_COMPACT_MAX_WIDTH}px)`).matches
          : availableWidth <= ROLE_HEADER_COMPACT_MAX_WIDTH;
      const nextResponsive = shouldUseResponsiveRoleHeader(
        availableWidth,
        requiredDesktopWidth,
        compactViewport,
      );
      setResponsive(nextResponsive);
      const measuredHeight = Math.ceil(header.getBoundingClientRect().height);
      if (measuredHeight > 0) {
        header.style.setProperty('--rx-role-header-expanded-height', `${measuredHeight}px`);
      }

      const rolePage = header.closest<HTMLElement>('.rx-role-page');
      if (rolePage && nextResponsive) {
        rolePage.style.setProperty(
          '--rx-role-page-min-width',
          `${clampResponsiveRolePageMinWidth(
            availableWidth,
            measureIntrinsicRoleHeaderWidth(header, true),
          )}px`,
        );
      } else {
        rolePage?.style.removeProperty('--rx-role-page-min-width');
      }
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    const mutationObserver =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(scheduleMeasure);
    resizeObserver?.observe(header);
    mutationObserver?.observe(header, { characterData: true, childList: true, subtree: true });
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      header
        .closest<HTMLElement>('.rx-role-page')
        ?.style.removeProperty('--rx-role-page-min-width');
    };
  }, [collapsed, responsive]);

  useEffect(() => {
    if (!profileOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [profileOpen]);

  useEffect(() => {
    if (!responsiveMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setResponsiveMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setResponsiveMenuOpen(false);
      responsiveMenuButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [responsiveMenuOpen]);

  return (
    <>
      <header
        aria-hidden={collapsed || undefined}
        className={cn('rx-role-header', responsive && 'rx-role-header-responsive', className)}
        data-role-header-collapsed={collapsed ? 'true' : 'false'}
        data-role-header-collapsible={collapsible ? 'true' : undefined}
        ref={headerRef}
      >
        <a className="rx-role-header-brand" href={brandHref}>
          <BrandMark className="rx-role-header-brand-mark" />
          {brandLabel ?? (
            <>
              REACH <span>ACADEMY</span>
            </>
          )}
        </a>
        <button
          aria-controls={responsiveMenuId}
          aria-expanded={responsiveMenuOpen}
          aria-label={navLabel}
          className="rx-role-header-menu-trigger"
          onClick={() => {
            setProfileOpen(false);
            setResponsiveMenuOpen((open) => !open);
          }}
          ref={responsiveMenuButtonRef}
          type="button"
        >
          {responsiveMenuOpen ? (
            <X aria-hidden="true" size={22} />
          ) : (
            <Menu aria-hidden="true" size={22} />
          )}
        </button>
        <div className="rx-role-header-content">
          <div
            className="rx-role-header-menu-panel"
            data-open={responsiveMenuOpen ? 'true' : 'false'}
            id={responsiveMenuId}
          >
            <nav aria-label={navLabel} className="rx-role-header-nav">
              {navItems.map((item, index) => (
                <a
                  aria-current={item.current ? (item.ariaCurrent ?? 'page') : undefined}
                  className={cn(
                    'rx-role-header-nav-link',
                    item.current && 'rx-role-header-nav-link-current',
                    item.className,
                  )}
                  href={item.href}
                  key={`${item.href}-${item.label}-${index}`}
                  onClick={() => setResponsiveMenuOpen(false)}
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
          {headerActions ? <div className="rx-role-header-actions">{headerActions}</div> : null}
          <div className="rx-role-header-profile" ref={profileRef}>
            {collapsible ? (
              <button
                aria-label={collapsible.collapseLabel}
                className="rx-role-header-collapse"
                onClick={() => {
                  setProfileOpen(false);
                  setResponsiveMenuOpen(false);
                  const nextCollapsed = persistCollapsedState(true);
                  pendingFocusRef.current = nextCollapsed ? 'restore' : 'collapse';
                  setCollapsed(nextCollapsed);
                }}
                ref={collapseButtonRef}
                title={collapsible.collapseLabel}
                type="button"
              >
                <ChevronUp aria-hidden="true" size={20} />
              </button>
            ) : null}
            <button
              aria-controls={profileMenuId}
              aria-expanded={profileOpen}
              aria-haspopup="dialog"
              aria-label={avatarLabel}
              className="rx-role-header-avatar"
              ref={profileTriggerRef}
              onClick={() => {
                setResponsiveMenuOpen(false);
                setProfileOpen((open) => !open);
              }}
              title={avatarTitle ?? profileName}
              type="button"
            >
              {avatarSrc ? (
                <Avatar decorative name={profileName ?? avatarText} src={avatarSrc} />
              ) : (
                avatarText
              )}
            </button>
            {profileOpen || keepProfileMounted ? (
              <section
                aria-label={avatarLabel}
                className="rx-role-header-popover"
                hidden={!profileOpen}
                id={profileMenuId}
                role="dialog"
              >
                <div className="rx-role-header-profile-heading">
                  <span aria-hidden="true" className="rx-role-header-profile-avatar">
                    {avatarSrc ? (
                      <Avatar decorative name={profileName ?? avatarText} src={avatarSrc} />
                    ) : (
                      avatarText
                    )}
                  </span>
                  <div>
                    <p>{avatarLabel}</p>
                    <strong>{profileName ?? avatarLabel}</strong>
                  </div>
                </div>
                {profileItems.length > 0 ? (
                  <dl className="rx-role-header-profile-items">
                    {profileItems.map((item) => (
                      <div key={item.label}>
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <div className="rx-role-header-profile-actions">
                  {onEditProfile && editProfileLabel ? (
                    <button
                      className="rx-role-header-sign-out"
                      type="button"
                      data-profile-edit-trigger
                      onClick={() => {
                        setProfileOpen(false);
                        onEditProfile();
                      }}
                    >
                      {editProfileLabel}
                    </button>
                  ) : null}
                  {profileActions}
                  <form action={logoutAction} method="post">
                    <button className="rx-role-header-sign-out" type="submit">
                      <LogOut aria-hidden="true" size={16} />
                      {signOutLabel}
                    </button>
                  </form>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </header>
      {collapsible ? (
        <div className="rx-role-header-restore-zone">
          <button
            aria-hidden={!collapsed}
            aria-label={collapsible.restoreLabel}
            className="rx-role-header-restore"
            onClick={() => {
              pendingFocusRef.current = 'collapse';
              setCollapsed(persistCollapsedState(false));
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              focusMainContent(headerRef.current);
            }}
            ref={restoreButtonRef}
            tabIndex={collapsed ? 0 : -1}
            title={collapsible.restoreLabel}
            type="button"
          >
            <ChevronDown aria-hidden="true" size={22} />
          </button>
        </div>
      ) : null}
    </>
  );
}
