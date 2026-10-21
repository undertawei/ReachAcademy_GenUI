import { CLIPBOARD_HTML_MAX_CHARACTERS } from './budgets.js';

export const INTERNAL_CLIPBOARD_MIME = 'application/x-reachany-editor-clipboard';
export const INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE = 'data-reach-internal-slice';

const INTERNAL_CLIPBOARD_MARKER_VALUE = '1';

type ClipboardReader = Pick<DataTransfer, 'getData'>;
type ClipboardWriter = Pick<DataTransfer, 'setData'>;

let pageClipboardToken: string | undefined;

/** Write the current page's unguessable token after an editor has populated its normal formats. */
export function writeInternalClipboardToken(dataTransfer: ClipboardWriter): boolean {
  const token = getPageClipboardToken();
  if (token === undefined) return false;
  try {
    dataTransfer.setData(INTERNAL_CLIPBOARD_MIME, token);
    return true;
  } catch {
    return false;
  }
}

/** Validate that a paste originated from an editor participating on this page. */
export function hasInternalClipboardToken(dataTransfer: ClipboardReader): boolean {
  const token = getPageClipboardToken();
  if (token === undefined) return false;
  try {
    return dataTransfer.getData(INTERNAL_CLIPBOARD_MIME) === token;
  } catch {
    return false;
  }
}

/**
 * Mark every top-level element in a validated ProseMirror slice.
 *
 * Quiz schemas use this marker while parsing nested resource nodes. Existing markers are removed
 * first so callers never preserve marker placement supplied by clipboard HTML itself.
 */
export function markTrustedProseMirrorClipboardHtml(html: string): string {
  if (html.length > CLIPBOARD_HTML_MAX_CHARACTERS) return '';
  const document = new DOMParser().parseFromString('', 'text/html');
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll(
    `[${INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE}]`,
  )) {
    element.removeAttribute(INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE);
  }
  for (const element of Array.from(template.content.children)) {
    element.setAttribute(INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE, INTERNAL_CLIPBOARD_MARKER_VALUE);
  }
  return template.innerHTML;
}

function getPageClipboardToken(): string | undefined {
  if (pageClipboardToken !== undefined) return pageClipboardToken;
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') {
    pageClipboardToken = crypto.randomUUID();
    return pageClipboardToken;
  }
  if (typeof crypto?.getRandomValues !== 'function') return undefined;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  pageClipboardToken = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return pageClipboardToken;
}
