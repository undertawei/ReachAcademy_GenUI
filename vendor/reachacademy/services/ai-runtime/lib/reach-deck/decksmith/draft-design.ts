import type { DecksmithHtmlDraftDesign } from './html-draft.js';
import { loadReachDeckWorkspace, type ReachDeckWorkspaceContext } from '../workspace-store.js';

/**
 * Generation-time design for one page: the deck's saved design context, theme, and the page's
 * outline (role, job, instructional spec). Imported or blank decks have no generation workspace;
 * the brush then falls back to the document theme and the page's current content.
 */
export async function loadDecksmithDraftDesign(
  context: ReachDeckWorkspaceContext,
  pageId: string,
): Promise<DecksmithHtmlDraftDesign | undefined> {
  try {
    const { workspace } = await loadReachDeckWorkspace(context);
    const outline = workspace.pagedOutline;
    const page = workspace.records[pageId]?.page;
    return {
      ...(outline?.designContext === undefined ? {} : { designContext: outline.designContext }),
      ...(outline?.themeName === undefined ? {} : { themeName: outline.themeName }),
      ...(page === undefined ? {} : { page }),
    };
  } catch (error) {
    console.warn('Decksmith HTML draft design unavailable; using the document theme', {
      pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
