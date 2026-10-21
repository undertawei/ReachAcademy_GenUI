/** The surface that owns keyboard and clipboard commands, independently of selection. */
export type EditorCommandContext = 'canvas' | 'pageRail' | 'timeline' | 'text';
export type EditorCommand = 'copy' | 'cut' | 'paste' | 'delete' | 'duplicate' | 'reorder';
export interface EditorCommandPermissions {
  disabled: boolean;
  busyAction?: string;
  structureLocked: boolean;
  lockedPageIds: ReadonlySet<string>;
  /** 生成期间仍允许删页（含正在生成的页）；插入、复制、排序照旧受结构锁限制。 */
  allowDeletingGeneratingPages?: boolean;
}

export function editorCommandTargetIsEditable(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, select, [contenteditable="true"], .ProseMirror, [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
    ) !== null
  );
}

export function resolveEditorCommandContext(
  target: EventTarget | null,
  fallback: EditorCommandContext,
): EditorCommandContext {
  if (editorCommandTargetIsEditable(target)) return 'text';
  if (!(target instanceof Element)) return fallback;
  const value = target
    .closest('[data-deck-command-context]')
    ?.getAttribute('data-deck-command-context');
  return value === 'canvas' || value === 'pageRail' || value === 'timeline' || value === 'text'
    ? value
    : fallback;
}

/** Shared availability policy; document validation remains the final mutation boundary. */
export function canExecuteEditorCommand(
  command: EditorCommand,
  context: EditorCommandContext,
  permissions: EditorCommandPermissions,
  pageIds: readonly string[],
): boolean {
  if (context === 'text') return false;
  if (command === 'copy') return context === 'canvas';
  if (permissions.disabled || permissions.busyAction !== undefined) return false;
  if (
    command === 'delete' &&
    context === 'pageRail' &&
    permissions.allowDeletingGeneratingPages === true
  ) {
    return true;
  }
  if (pageIds.some((pageId) => permissions.lockedPageIds.has(pageId))) return false;
  if (permissions.structureLocked && (context === 'pageRail' || command === 'paste')) return false;
  if (context === 'timeline') return command === 'delete';
  if (context === 'pageRail')
    return command === 'delete' || command === 'duplicate' || command === 'reorder';
  return true;
}
