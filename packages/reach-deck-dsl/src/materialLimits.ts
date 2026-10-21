export const REACH_DECK_WORKSPACE_MATERIAL_REFERENCE_LIMIT = 64;
export const REACH_DECK_PAGE_MATERIAL_REFERENCE_LIMIT = 32;
export const REACH_DECK_MATERIAL_REFERENCE_ORDINAL_LIMIT = 8;
export const REACH_DECK_MATERIAL_ASSET_DELETE_BATCH_SIZE = 32;

/**
 * Largest PPTX an import accepts. Import holds the whole package in memory to
 * parse it, so this is the product's answer to "how big a deck can I upload",
 * not a transport detail: the browser checks it before spending the upload and
 * the route re-checks it before spending the memory.
 */
export const REACH_DECK_PPTX_MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
