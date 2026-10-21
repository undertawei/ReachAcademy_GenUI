export const CLIPBOARD_HTML_MAX_CHARACTERS = 1_000_000;
export const CLIPBOARD_MAX_NODES = 10_000;
export const CLIPBOARD_MAX_DEPTH = 64;
export const CLIPBOARD_MAX_PARAGRAPHS = 5_000;
export const CLIPBOARD_MAX_TEXT_CHARACTERS = 250_000;

export const CLIPBOARD_FORMULA_MAX_INPUT_CHARACTERS = 100_000;
export const CLIPBOARD_FORMULA_MAX_NODES = 2_000;
export const CLIPBOARD_FORMULA_MAX_DEPTH = 64;
export const CLIPBOARD_FORMULA_MAX_OUTPUT_CHARACTERS = 50_000;

export type ClipboardBudget = 'depth' | 'html' | 'nodes' | 'paragraphs' | 'text';

export class ClipboardBudgetError extends Error {
  readonly budget: ClipboardBudget;

  constructor(budget: ClipboardBudget) {
    super(`Clipboard content exceeds the ${budget} budget.`);
    this.name = 'ClipboardBudgetError';
    this.budget = budget;
  }
}
