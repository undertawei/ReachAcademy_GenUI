import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AsyncState,
  Button,
  FormSubmitButton,
  ProgressBar,
  RouteLoading,
  Skeleton,
  Spinner,
} from '../src/index';
import { readGroupStyles, readSharedStyles } from './read-styles';

describe('shared feedback primitives', () => {
  it('keeps the existing button contract while adding loading semantics', () => {
    const resting = renderToStaticMarkup(<Button>Save</Button>);
    const loading = renderToStaticMarkup(
      <Button loading loadingLabel="Saving">
        Save
      </Button>,
    );

    expect(resting).toContain('type="button"');
    expect(resting).not.toContain('disabled');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('disabled');
    expect(loading).toContain('data-loading="true"');
    expect(loading).toContain('Saving');
    expect(loading).toContain('rx-spinner-sm');
  });

  it('allows native form consumers to drive the form submit adapter explicitly', () => {
    const markup = renderToStaticMarkup(
      <form>
        <FormSubmitButton loading loadingLabel="Signing in">
          Sign in
        </FormSubmitButton>
      </form>,
    );

    expect(markup).toContain('type="submit"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Signing in');
  });

  it('exposes accessible spinner, skeleton, progress, and async-state semantics', () => {
    expect(renderToStaticMarkup(<Spinner label="Loading results" />)).toContain('role="status"');
    expect(renderToStaticMarkup(<Spinner />)).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<Skeleton label="Loading list" lines={3} />)).toContain(
      'aria-busy="true"',
    );

    const determinate = renderToStaticMarkup(
      <ProgressBar label="Upload progress" max={200} value={250} />,
    );
    expect(determinate).toContain('aria-valuenow="200"');
    expect(determinate).toContain('transform:scaleX(1)');
    expect(renderToStaticMarkup(<ProgressBar label="Starting task" />)).not.toContain(
      'aria-valuenow',
    );

    expect(
      renderToStaticMarkup(<AsyncState loadingLabel="Loading courses" status="loading" />),
    ).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<AsyncState error="Could not load" status="error" />)).toContain(
      'role="alert"',
    );
  });

  it('provides a route loading composition with app-owned copy', () => {
    const markup = renderToStaticMarkup(
      <RouteLoading description="Preparing your workspace" label="Loading Portal" />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Loading Portal');
    expect(markup).toContain('Preparing your workspace');
  });

  it('contains an explicit reduced-motion fallback for every animated primitive', () => {
    const styles = readSharedStyles();
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    for (const className of [
      '.rx-spinner',
      '.rx-skeleton-line',
      '.rx-progress-indeterminate .rx-progress-value',
      '.rx-page-transition',
      '.rx-confirm-dialog',
      '.rx-toast',
    ]) {
      expect(styles).toContain(className);
    }
  });

  it('uses the Phase 2 baseline through semantic variables only', () => {
    const styles = readSharedStyles();

    for (const variable of [
      '--reachany-color-canvas',
      '--reachany-color-header',
      '--reachany-color-primary',
      '--reachany-color-border',
      '--reachany-color-text-secondary',
      '--reachany-radius-card',
      '--reachany-shadow-overlay',
      '--reachany-z-toast',
    ]) {
      expect(styles).toContain(`var(${variable}`);
    }
    for (const retired of ['#975e5c', '#8f5756', '#9a6870', '#f45f22', '#5e3853']) {
      expect(styles).not.toContain(retired);
    }
  });

  it('keeps the shared role header at the Phase 2 height, color, and padding', () => {
    const header = readGroupStyles('header');

    const rootRule = header.match(/\n\.rx-role-header \{([^}]*)\}/)?.[1] ?? '';
    expect(rootRule).toContain('height: var(--reachany-header-height);');
    expect(rootRule).toContain('background: var(--reachany-color-header);');
    expect(rootRule).toContain('padding: 0 var(--reachany-header-padding-inline);');
    expect(rootRule).toContain('z-index: var(--reachany-z-header);');
    expect(rootRule).not.toContain('box-shadow');
    // 20 + 20 + 20 = 60px：行盒不锁死，页头会被字体度量撑到 61px。
    const navLinkRule = header.match(/\n\.rx-role-header-nav-link \{([^}]*)\}/)?.[1] ?? '';
    expect(navLinkRule).toContain('padding: 20px 0;');
    expect(navLinkRule).toContain('line-height: 20px;');
    expect(header).toContain('.rx-role-header-responsive .rx-role-header-menu-panel');
    // 机构、端切换下拉绝对定位在操作区内：操作区一旦成为滚动容器就会把下拉裁掉。
    for (const actionsRule of header.matchAll(/\.rx-role-header-actions \{([^}]*)\}/g)) {
      expect(actionsRule[1]).not.toContain('overflow');
    }
    expect(header).toContain("html[data-reachany-role-header-collapsed='true']");
    expect(header).toContain('@media (hover: none), (pointer: coarse), (max-width: 720px)');
    expect(readGroupStyles('layout')).toContain(
      '--rx-role-header-effective-height: var(--reachany-header-height)',
    );
  });
});
