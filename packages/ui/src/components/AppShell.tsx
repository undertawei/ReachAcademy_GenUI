import type { ReactNode } from 'react';

import { NavRail, type NavRailItem } from './NavRail';

export type AppShellProps = {
  nav: NavRailItem[];
  navFooter?: ReactNode;
  navHeader?: ReactNode;
  children: ReactNode;
};

export function AppShell({ nav, navFooter, navHeader, children }: AppShellProps) {
  return (
    <div className="rx-app-shell">
      <NavRail items={nav} footer={navFooter} header={navHeader} />
      <main className="rx-app-shell-main">{children}</main>
    </div>
  );
}
