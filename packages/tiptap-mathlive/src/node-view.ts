import type { Editor, NodeViewRenderer } from '@tiptap/core';
import type { MathfieldElement } from 'mathlive';

import { DISABLED_MATHLIVE_INLINE_SHORTCUTS, toPortableLatex } from './latex-compat.js';
import { renderMathToString } from './static.js';

export type MathLiveNodeViewOptions = {
  displayMode: boolean;
  label?: string;
};

export type InsertMathOptions = {
  displayMode: boolean;
  nodeType?: string;
};

type MoveDirection = 'backward' | 'forward';

type DeactivateOptions = {
  direction?: MoveDirection;
  preserveVirtualKeyboard?: boolean;
  restoreEditorFocus?: boolean;
};

type ActiveMathView = { deactivate: (options?: DeactivateOptions) => void };

let activeMathView: ActiveMathView | undefined;
let mathLiveModulePromise: Promise<typeof import('mathlive')> | undefined;

const ACTIVATE_EVENT = 'reachany:activate-mathlive';

const loadMathLive = () => (mathLiveModulePromise ??= import('mathlive'));

const hideVirtualKeyboardWhenInactive = () => {
  void loadMathLive().then(() => {
    if (typeof window === 'undefined') return;
    const keyboard = window.mathVirtualKeyboard;
    if (activeMathView === undefined && keyboard?.visible) {
      keyboard.hide({ animate: true });
    }
  });
};

/**
 * MathLive-backed atom NodeView.
 *
 * The persisted contract remains the Tiptap node's attrs.latex. Inactive and read-only nodes use
 * server-safe KaTeX markup; an editable selected node swaps in the native MathLive math-field.
 */
export function createMathLiveNodeView(options: MathLiveNodeViewOptions): NodeViewRenderer {
  return ({ editor, getPos, node: initialNode }) => {
    let currentNode = initialNode;
    let destroyed = false;
    let mathfield: MathfieldElement | undefined;

    const wrapper = document.createElement(options.displayMode ? 'div' : 'span');
    const staticFormula = document.createElement(options.displayMode ? 'div' : 'span');
    const typeName = options.displayMode ? 'block-math' : 'inline-math';
    const accessibleKind = options.displayMode ? '独立公式' : '行内公式';

    wrapper.className = [
      'reachany-mathlive-node',
      options.displayMode ? 'is-block' : 'is-inline',
    ].join(' ');
    wrapper.dataset.mathliveNode = typeName;
    wrapper.dataset.type = typeName;
    wrapper.setAttribute('data-latex', String(currentNode.attrs.latex ?? ''));
    staticFormula.className = 'reachany-mathlive-static';
    wrapper.append(staticFormula);

    const latex = () => String(currentNode.attrs.latex ?? '');
    const accessibleLabel = () => `${options.label ?? accessibleKind}：${latex() || '空'}`;

    const renderStatic = () => {
      wrapper.setAttribute('data-latex', latex());
      wrapper.setAttribute('aria-label', accessibleLabel());
      wrapper.setAttribute('role', 'math');
      staticFormula.innerHTML = renderMathToString(latex(), { displayMode: options.displayMode });
    };

    const isMathLiveChrome = (event: Event) =>
      event.composedPath().some((entry) => {
        if (!(entry instanceof Element)) return false;
        const className = typeof entry.className === 'string' ? entry.className : '';
        return className.includes('ML__') || className.includes('MLK__');
      });

    const updateLatex = (nextLatex: string) => {
      const pos = getPos();
      if (typeof pos !== 'number') return;
      const node = editor.state.doc.nodeAt(pos);
      if (!node || node.type !== currentNode.type) return;
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(pos, node.type, { ...node.attrs, latex: nextLatex }),
      );
    };

    const deleteCurrentNode = () => {
      const pos = getPos();
      if (typeof pos !== 'number') return;
      const node = editor.state.doc.nodeAt(pos);
      if (!node || node.type !== currentNode.type) return;
      editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
    };

    const handleDocumentPointerDown = (event: Event) => {
      if (event.composedPath().includes(wrapper) || isMathLiveChrome(event)) return;
      const transfersToMathView = event
        .composedPath()
        .some((entry) => entry instanceof HTMLElement && entry.dataset.mathliveNode !== undefined);
      deactivate({ preserveVirtualKeyboard: transfersToMathView });
    };

    const restoreEditorFocus = (direction: MoveDirection) => {
      if (destroyed) return;
      const pos = getPos();
      if (typeof pos !== 'number') return;
      editor
        .chain()
        .focus()
        .setTextSelection(direction === 'backward' ? pos : pos + currentNode.nodeSize)
        .run();
    };

    const deactivate = ({
      direction = 'forward',
      preserveVirtualKeyboard = false,
      restoreEditorFocus: shouldRestoreEditorFocus = false,
    }: DeactivateOptions = {}) => {
      if (!mathfield) return;
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      const value = toPortableLatex(mathfield.value, {
        removeUnresolvedPlaceholders: true,
      }).trim();
      if (value !== latex()) updateLatex(value);
      mathfield.remove();
      mathfield = undefined;
      wrapper.classList.remove('is-active');
      staticFormula.hidden = false;
      renderStatic();
      if (activeMathView?.deactivate === deactivate) activeMathView = undefined;
      if (!preserveVirtualKeyboard) hideVirtualKeyboardWhenInactive();
      if (!value && !destroyed) {
        deleteCurrentNode();
        return;
      }
      if (shouldRestoreEditorFocus) restoreEditorFocus(direction);
    };

    const mountMathfield = () => {
      if (destroyed || !editor.isEditable || mathfield) return;
      activeMathView?.deactivate({ preserveVirtualKeyboard: true });

      const field = document.createElement('math-field') as MathfieldElement;
      field.className = 'reachany-mathlive-field';
      field.value = toPortableLatex(latex());
      field.placeholder = '输入公式';
      field.smartFence = true;
      field.mathVirtualKeyboardPolicy = 'manual';
      field.setAttribute('aria-label', options.label ?? `编辑${accessibleKind}`);

      field.addEventListener('input', () => {
        const nextLatex = toPortableLatex(field.value);
        if (nextLatex === latex()) return;
        updateLatex(nextLatex);
      });
      field.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        deactivate({ restoreEditorFocus: true });
      });
      field.addEventListener('move-out', (event) => {
        const direction = (event as CustomEvent<{ direction?: string }>).detail?.direction;
        if (direction !== 'forward' && direction !== 'backward') return;
        event.preventDefault();
        event.stopPropagation();
        deactivate({ direction, restoreEditorFocus: true });
      });

      mathfield = field;
      activeMathView = { deactivate };
      staticFormula.hidden = true;
      wrapper.classList.add('is-active');
      wrapper.removeAttribute('role');
      wrapper.removeAttribute('aria-label');
      wrapper.append(field);
      const inlineShortcuts = { ...field.inlineShortcuts };
      for (const shortcut of DISABLED_MATHLIVE_INLINE_SHORTCUTS) delete inlineShortcuts[shortcut];
      field.inlineShortcuts = inlineShortcuts;
      document.addEventListener('pointerdown', handleDocumentPointerDown, true);
      requestAnimationFrame(() => field.focus());
    };

    const activate = () => {
      if (destroyed || !editor.isEditable || mathfield) return;
      if (customElements.get('math-field')) {
        mountMathfield();
        return;
      }
      void loadMathLive().then(mountMathfield);
    };

    const handleActivateRequest = (event: Event) => {
      event.stopPropagation();
      activate();
    };
    const handlePointerDown = (event: Event) => {
      if (!editor.isEditable || mathfield) return;
      event.preventDefault();
      event.stopPropagation();
      const pos = getPos();
      if (typeof pos === 'number') editor.commands.setNodeSelection(pos);
      activate();
    };
    const handleKeyDown = (event: Event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (!editor.isEditable || (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' '))
        return;
      event.preventDefault();
      activate();
    };

    wrapper.addEventListener(ACTIVATE_EVENT, handleActivateRequest);
    wrapper.addEventListener('pointerdown', handlePointerDown);
    wrapper.addEventListener('keydown', handleKeyDown);
    if (editor.isEditable) {
      wrapper.classList.add('is-editable');
      wrapper.tabIndex = 0;
    }
    renderStatic();

    return {
      dom: wrapper,
      destroy() {
        destroyed = true;
        deactivate();
        wrapper.removeEventListener(ACTIVATE_EVENT, handleActivateRequest);
        wrapper.removeEventListener('pointerdown', handlePointerDown);
        wrapper.removeEventListener('keydown', handleKeyDown);
      },
      deselectNode() {
        wrapper.classList.remove('ProseMirror-selectednode');
      },
      ignoreMutation(mutation) {
        return wrapper.contains(mutation.target);
      },
      selectNode() {
        wrapper.classList.add('ProseMirror-selectednode');
      },
      stopEvent(event) {
        return event
          .composedPath()
          .some(
            (entry) =>
              entry instanceof Element &&
              (entry === mathfield || entry.classList.contains('reachany-mathlive-field')),
          );
      },
      update(updatedNode) {
        if (updatedNode.type !== currentNode.type) return false;
        currentNode = updatedNode;
        wrapper.setAttribute('data-latex', latex());
        const portableLatex = toPortableLatex(latex());
        if (mathfield && mathfield.value !== portableLatex) mathfield.value = portableLatex;
        if (!mathfield) renderStatic();
        return true;
      },
    };
  };
}

/** Insert an empty formula atom, select its NodeView, and immediately activate MathLive. */
export function insertMathAndActivate(editor: Editor, options: InsertMathOptions): boolean {
  const nodeType = options.nodeType ?? (options.displayMode ? 'blockMath' : 'inlineMath');
  if (!editor.schema.nodes[nodeType]) return false;

  const { from, to } = editor.state.selection;
  let insertedPos: number | undefined;
  const inserted = editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, { attrs: { latex: '' }, type: nodeType })
    .command(({ tr }) => {
      const insertionStep = tr.steps.at(-1);
      insertionStep?.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        if (insertedPos !== undefined) return;
        const directNode = tr.doc.nodeAt(newStart);
        if (directNode?.type.name === nodeType) {
          insertedPos = newStart;
          return;
        }
        tr.doc.nodesBetween(newStart, newEnd, (node, pos) => {
          if (node.type.name !== nodeType) return;
          insertedPos = pos;
          return false;
        });
      });
      return true;
    })
    .run();
  if (!inserted || insertedPos === undefined || !editor.commands.setNodeSelection(insertedPos)) {
    return false;
  }
  const mathPos = insertedPos;

  requestAnimationFrame(() => {
    const dom = editor.view.nodeDOM(mathPos);
    dom?.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { bubbles: false }));
  });
  return true;
}
