// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  clampResponsiveRolePageMinWidth,
  prepareRoleHeaderMeasurementClone,
  resolveResponsiveRoleHeaderAvailableWidth,
  RoleHeader,
  shouldUseResponsiveRoleHeader,
} from './RoleHeader';

describe('RoleHeader', () => {
  it('never lets responsive header measurement widen the role page beyond the viewport', () => {
    expect(clampResponsiveRolePageMinWidth(600, 660)).toBe(600);
    expect(clampResponsiveRolePageMinWidth(1000, 660)).toBe(660);
    expect(clampResponsiveRolePageMinWidth(600, -10)).toBe(0);
  });

  it('uses the smaller usable viewport width without trusting an enlarged document width', () => {
    expect(resolveResponsiveRoleHeaderAvailableWidth(600, 660)).toBe(600);
    expect(resolveResponsiveRoleHeaderAvailableWidth(600, 585)).toBe(585);
    expect(resolveResponsiveRoleHeaderAvailableWidth(600, 0)).toBe(600);
    expect(resolveResponsiveRoleHeaderAvailableWidth(0, 585)).toBe(585);
  });

  it('uses the shared compact breakpoint while preserving localized content measurement', () => {
    expect(shouldUseResponsiveRoleHeader(1280, 1100)).toBe(false);
    expect(shouldUseResponsiveRoleHeader(1280, 1100, true)).toBe(true);
    expect(shouldUseResponsiveRoleHeader(1281, 1100, false)).toBe(false);
    expect(shouldUseResponsiveRoleHeader(1400, 1350)).toBe(false);
    expect(shouldUseResponsiveRoleHeader(1400, 1450)).toBe(true);
    expect(shouldUseResponsiveRoleHeader(900, 950)).toBe(true);
  });

  it('renders injected navigation, actions, profile details, and a host-local logout form', () => {
    const markup = renderToStaticMarkup(
      <RoleHeader
        avatarLabel="Account menu"
        avatarText="A"
        brandHref="/home"
        headerActions={<span data-header-action="notifications" />}
        keepProfileMounted
        logoutAction="/auth/logout"
        navItems={[
          {
            ariaCurrent: 'location',
            current: true,
            href: '/courses',
            label: 'Courses',
          },
          { current: false, href: '/calendar', label: 'Calendar' },
        ]}
        navLabel="Primary navigation"
        profileActions={<button type="button">Change password</button>}
        profileItems={[{ label: 'Role', value: 'Teacher' }]}
        profileName="Alex"
        signOutLabel="Sign out"
      />,
    );

    expect(markup).toMatch(
      /<a class="rx-role-header-brand" href="\/home"><svg aria-hidden="true" class="rx-brand-mark rx-role-header-brand-mark"[^>]*viewBox="250 250 580 580"/,
    );
    expect(markup).toContain('aria-label="Primary navigation"');
    expect(markup).toMatch(
      /button[^>]*aria-controls="[^"]+"[^>]*aria-expanded="false"[^>]*aria-label="Primary navigation"/,
    );
    expect(markup).toContain('class="rx-role-header-menu-panel"');
    expect(markup).toContain('data-open="false"');
    expect(markup).toMatch(/aria-current="location"[^>]*href="\/courses"/);
    expect(markup).toContain('data-header-action="notifications"');
    expect(markup).toContain('class="rx-role-header-popover"');
    expect(markup).toContain('Alex');
    expect(markup).toContain('<dt>Role</dt><dd>Teacher</dd>');
    expect(markup).toContain('Change password');
    expect(markup).toMatch(/form[^>]*action="\/auth\/logout"[^>]*method="post"/);
    expect(markup).toContain('Sign out');
    expect(markup).not.toContain('rx-role-header-collapse');
    expect(markup).not.toContain('rx-role-header-restore-zone');
  });

  it('normalizes collapsed state before measuring a responsive clone', () => {
    const header = document.createElement('header');
    header.className = 'rx-role-header';
    header.dataset.roleHeaderCollapsible = 'true';
    header.dataset.roleHeaderCollapsed = 'true';

    const clone = prepareRoleHeaderMeasurementClone(header, true);

    expect(clone.classList.contains('rx-role-header-responsive')).toBe(true);
    expect(clone.hasAttribute('data-role-header-collapsible')).toBe(false);
    expect(clone.hasAttribute('data-role-header-collapsed')).toBe(false);
  });

  it('renders opt-in localized collapse and restore controls without changing the default API', () => {
    const markup = renderToStaticMarkup(
      <RoleHeader
        avatarLabel="Account"
        avatarText="A"
        brandHref="/home"
        collapsible={{ collapseLabel: 'Collapse header', restoreLabel: 'Show header' }}
        navItems={[]}
        navLabel="Primary navigation"
        signOutLabel="Sign out"
      />,
    );

    expect(markup).toContain('data-role-header-collapsible="true"');
    expect(markup).toContain('aria-label="Collapse header"');
    expect(markup).toContain('aria-label="Show header"');
    expect(markup).toContain('class="rx-role-header-restore-zone"');
  });
});
