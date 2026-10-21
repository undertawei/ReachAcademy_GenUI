// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { canExecuteEditorCommand, resolveEditorCommandContext } from '../src/editorCommands';
const permissions = { disabled: false, structureLocked: false, lockedPageIds: new Set<string>() };
describe('editor command ownership and permissions', () => {
  it('prefers editable targets over the owning surface and retains context for window events', () => {
    const rail = document.createElement('div');
    rail.dataset.deckCommandContext = 'pageRail';
    const input = document.createElement('input');
    rail.append(input);
    expect(resolveEditorCommandContext(rail, 'canvas')).toBe('pageRail');
    expect(resolveEditorCommandContext(input, 'canvas')).toBe('text');
    expect(resolveEditorCommandContext(window, 'timeline')).toBe('timeline');
  });
  it('routes clipboard to canvas only and permits copy in read-only mode', () => {
    expect(
      canExecuteEditorCommand('copy', 'canvas', { ...permissions, disabled: true }, ['a']),
    ).toBe(true);
    for (const context of ['text', 'pageRail', 'timeline'] as const) {
      expect(canExecuteEditorCommand('copy', context, permissions, ['a'])).toBe(false);
      expect(canExecuteEditorCommand('paste', context, permissions, ['a'])).toBe(false);
    }
  });
  it('blocks page actions atomically for a locked selection, structure lock, disabled or busy state', () => {
    for (const command of ['delete', 'duplicate', 'reorder'] as const) {
      for (const locked of [
        { ...permissions, disabled: true },
        { ...permissions, busyAction: 'save' },
        { ...permissions, structureLocked: true },
        { ...permissions, lockedPageIds: new Set(['b']) },
      ]) {
        expect(canExecuteEditorCommand(command, 'pageRail', locked, ['a', 'b'])).toBe(false);
      }
      expect(canExecuteEditorCommand(command, 'pageRail', permissions, ['a', 'b'])).toBe(true);
    }
    expect(
      canExecuteEditorCommand('delete', 'canvas', { ...permissions, structureLocked: true }, ['a']),
    ).toBe(true);
  });
});
