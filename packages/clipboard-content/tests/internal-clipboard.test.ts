import { describe, expect, it, vi } from 'vitest';

import {
  hasInternalClipboardToken,
  INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE,
  INTERNAL_CLIPBOARD_MIME,
  markTrustedProseMirrorClipboardHtml,
  writeInternalClipboardToken,
} from '../src/index.js';

describe('internal editor clipboard provenance', () => {
  it('shares one opaque token between writers and readers on the current page', () => {
    const values = new Map<string, string>();
    const clipboard = {
      getData: (type: string) => values.get(type) ?? '',
      setData: vi.fn((type: string, value: string) => {
        values.set(type, value);
      }),
    };

    expect(writeInternalClipboardToken(clipboard)).toBe(true);
    expect(clipboard.setData).toHaveBeenCalledWith(INTERNAL_CLIPBOARD_MIME, expect.any(String));
    expect(hasInternalClipboardToken(clipboard)).toBe(true);
    expect(hasInternalClipboardToken({ getData: () => 'forged-token' })).toBe(false);
  });

  it('marks every top-level element and replaces forged nested markers', () => {
    const html = markTrustedProseMirrorClipboardHtml(
      '<p data-pm-slice="0 0 []">one</p>' +
        '<figure><span data-reach-internal-slice="forged">two</span></figure>',
    );
    const document = new DOMParser().parseFromString(html, 'text/html');

    expect(Array.from(document.body.children)).toHaveLength(2);
    expect(
      Array.from(document.body.children).every(
        (element) => element.getAttribute(INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE) === '1',
      ),
    ).toBe(true);
    expect(document.querySelector('span')?.hasAttribute(INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE)).toBe(
      false,
    );
  });
});
