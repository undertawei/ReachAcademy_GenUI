import { describe, expect, it } from 'vitest';

import {
  addOutlinePage,
  applyOutlineChange,
  createGenerationWorkspace,
  deleteOutlinePage,
  duplicateOutlinePage,
  editOutlinePage,
  editOutlineRoot,
  moveOutlinePage,
} from '../src/index.js';
import { NOW, lessonPlan, outline, page } from './generationFixtures.js';

const createWorkspace = () =>
  createGenerationWorkspace({
    runId: 'outline-run',
    documentId: 'outline-deck',
    source: 'outline source',
    lessonPlan,
    pagedOutline: outline([
      page('page-1', 1, 'slide'),
      page('page-2', 2, 'quiz'),
      page('page-3', 3, 'interactive'),
    ]),
    createdAt: NOW,
  });

describe('outline change descriptor governance', () => {
  it('accepts a root-only change but rejects root changes that smuggle page mutations', () => {
    const workspace = createWorkspace();
    const root = editOutlineRoot(workspace.pagedOutline!, (value) => ({
      ...value,
      title: 'Changed outline title',
    }));
    expect(applyOutlineChange(workspace, root, NOW).pagedOutline?.title).toBe(
      'Changed outline title',
    );
    expect(() =>
      applyOutlineChange(
        workspace,
        {
          outline: {
            ...root.outline,
            pages: root.outline.pages.map((candidate) =>
              candidate.id === 'page-1' ? { ...candidate, title: 'Smuggled title' } : candidate,
            ),
          },
          change: { kind: 'root' },
        },
        NOW,
      ),
    ).toThrow(/root.*semantic/i);
  });

  it('validates add anchors and exact result order', () => {
    const workspace = createWorkspace();
    const added = addOutlinePage(workspace.pagedOutline!, 'page-1', () => 'page-new');
    expect(() =>
      applyOutlineChange(
        workspace,
        { ...added, change: { kind: 'add', pageId: 'page-new', afterPageId: 'page-3' } },
        NOW,
      ),
    ).toThrow(/add.*order.*descriptor/i);
  });

  it('validates delete targets and membership', () => {
    const workspace = createWorkspace();
    const deleted = deleteOutlinePage(workspace.pagedOutline!, 'page-2');
    expect(() =>
      applyOutlineChange(
        workspace,
        { ...deleted, change: { kind: 'delete', pageId: 'page-1' } },
        NOW,
      ),
    ).toThrow(/delete.*still present|membership/i);
  });

  it('validates duplicate source identity and placement', () => {
    const workspace = createWorkspace();
    const duplicated = duplicateOutlinePage(workspace.pagedOutline!, 'page-1', () => 'page-copy');
    expect(() =>
      applyOutlineChange(
        workspace,
        {
          ...duplicated,
          change: { kind: 'duplicate', pageId: 'page-copy', sourcePageId: 'page-2' },
        },
        NOW,
      ),
    ).toThrow(/duplicate.*order.*descriptor/i);
  });

  it('validates reorder targets and before-page placement', () => {
    const workspace = createWorkspace();
    const moved = moveOutlinePage(workspace.pagedOutline!, 'page-3', 'page-1');
    expect(() =>
      applyOutlineChange(
        workspace,
        { ...moved, change: { kind: 'reorder', pageId: 'page-2', beforePageId: 'page-1' } },
        NOW,
      ),
    ).toThrow(/reorder.*order.*descriptor/i);
  });

  it('allows only the declared semantic page to change', () => {
    const workspace = createWorkspace();
    const edited = editOutlinePage(workspace.pagedOutline!, 'page-1', (value) => ({
      ...value,
      title: 'Declared edit',
    }));
    const smuggled = {
      ...edited,
      outline: {
        ...edited.outline,
        pages: edited.outline.pages.map((candidate) =>
          candidate.id === 'page-2' ? { ...candidate, title: 'Undeclared edit' } : candidate,
        ),
      },
    };
    expect(() => applyOutlineChange(workspace, smuggled, NOW)).toThrow(
      /semantic.*undeclared semantic/i,
    );
  });
});
