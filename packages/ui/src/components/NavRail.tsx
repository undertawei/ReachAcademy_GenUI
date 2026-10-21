import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../cn';

export type NavRailItem = {
  href: string;
  label: string;
  icon?: LucideIcon;
  current?: boolean;
};

export type NavRailProps = {
  items: NavRailItem[];
  footer?: ReactNode;
  header?: ReactNode;
};

export function NavRail({ items, footer, header }: NavRailProps) {
  return (
    <nav className="rx-nav-rail" aria-label="Primary">
      {header ? <div className="rx-nav-rail-header">{header}</div> : null}
      <div className="rx-nav-rail-list">
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <a
              key={item.href}
              className={cn('rx-nav-rail-link', item.current && 'rx-nav-rail-link-current')}
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
            >
              {Icon ? <Icon className="rx-nav-rail-icon" aria-hidden="true" /> : null}
              <span className="rx-nav-rail-label">{item.label}</span>
            </a>
          );
        })}
      </div>
      {footer ? <div className="rx-nav-rail-footer">{footer}</div> : null}
    </nav>
  );
}
