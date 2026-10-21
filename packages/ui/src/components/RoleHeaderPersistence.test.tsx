import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ROLE_HEADER_COLLAPSED_ATTRIBUTE,
  ROLE_HEADER_COLLAPSE_STORAGE_KEY,
  RoleHeaderPersistenceScript,
} from './RoleHeaderPersistence';

describe('RoleHeaderPersistenceScript', () => {
  it('hydrates the document root from tab-scoped storage before the role header renders', () => {
    const markup = renderToStaticMarkup(<RoleHeaderPersistenceScript />);

    expect(markup).toContain('data-reachany-role-header-persistence="true"');
    expect(markup).toContain('window.sessionStorage.getItem');
    expect(markup).toContain(ROLE_HEADER_COLLAPSE_STORAGE_KEY);
    expect(markup).toContain(ROLE_HEADER_COLLAPSED_ATTRIBUTE);
    expect(markup).toContain("collapsed === 'true'");
  });
});
