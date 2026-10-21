import { forwardRef, useId, type ElementType, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '../cn';

export interface SideNavItem {
  /** 右侧数量徽标。 */
  count?: ReactNode;
  /** 当前页：选中样式 + `aria-current="page"`。 */
  current?: boolean;
  href: string;
  /** 16px 图标（lucide 元素）。 */
  icon?: ReactNode;
  /** React key；默认用 `href`。 */
  id?: string;
  label: ReactNode;
  /** 透传给链接组件的额外属性（如 Next.js Link 的 `prefetch`、`onClick`）。 */
  linkProps?: Record<string, unknown>;
}

export interface SideNavGroup {
  id?: string;
  items: readonly SideNavItem[];
  /** 分组标题（12 `text-tertiary`）；不传时只显示分组间距。 */
  title?: ReactNode;
}

export type SideNavProps = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  /** 分组数据；与 `items` 二选一（都传时先渲染 `items`）。 */
  groups?: readonly SideNavGroup[];
  /** 左内边距：`card`（卡片内，16，默认）或 `page`（贴页面左缘，40）。 */
  inset?: 'card' | 'page';
  items?: readonly SideNavItem[];
  /**
   * 链接组件，默认 `'a'`。Next.js 中传 `Link`（`import Link from 'next/link'`）即可，
   * 组件只给它 `href`、`className`、`aria-current` 与 children，不依赖 next。
   */
  linkComponent?: ElementType;
};

function SideNavList({
  items,
  labelledBy,
  linkComponent: Link,
}: {
  items: readonly SideNavItem[];
  labelledBy?: string;
  linkComponent: ElementType;
}) {
  return (
    <ul aria-labelledby={labelledBy} className="rx-side-nav-list">
      {items.map((item) => (
        <li key={item.id ?? item.href}>
          <Link
            {...item.linkProps}
            aria-current={item.current ? 'page' : undefined}
            className="rx-side-nav-item"
            data-state={item.current ? 'selected' : undefined}
            href={item.href}
          >
            {item.icon === undefined || item.icon === null ? null : (
              <span aria-hidden="true" className="rx-side-nav-icon">
                {item.icon}
              </span>
            )}
            <span className="rx-side-nav-label">{item.label}</span>
            {item.count === undefined || item.count === null ? null : (
              <span className="rx-side-nav-count rx-numeric">{item.count}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SideNavGroupSection({
  group,
  linkComponent,
}: {
  group: SideNavGroup;
  linkComponent: ElementType;
}) {
  const titleId = useId();
  const hasTitle = group.title !== undefined && group.title !== null;
  return (
    <div className="rx-side-nav-group">
      {hasTitle ? (
        <div className="rx-side-nav-group-title" id={titleId}>
          {group.title}
        </div>
      ) : null}
      <SideNavList
        items={group.items}
        labelledBy={hasTitle ? titleId : undefined}
        linkComponent={linkComponent}
      />
    </div>
  );
}

/**
 * 二级导航（规范 03 §3.12）：`<nav>` + 链接，宽 `--reachany-side-nav-width`（160）、白底；
 * 选中项 `primary-soft-strong` 底 + 左侧 4px `primary` 竖条，`aria-current="page"`。
 * 当前项由调用方按路由计算后写在 `item.current`。
 */
export const SideNav = forwardRef<HTMLElement, SideNavProps>(function SideNav(
  { className, groups, inset = 'card', items, linkComponent = 'a', ...props },
  ref,
) {
  return (
    <nav className={cn('rx-side-nav', className)} data-inset={inset} ref={ref} {...props}>
      {items && items.length > 0 ? (
        <SideNavList items={items} linkComponent={linkComponent} />
      ) : null}
      {groups?.map((group, index) => (
        <SideNavGroupSection group={group} key={group.id ?? index} linkComponent={linkComponent} />
      ))}
    </nav>
  );
});
