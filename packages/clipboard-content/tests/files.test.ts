import { describe, expect, it } from 'vitest';

import {
  firstSupportedClipboardImage,
  normalizeClipboardImageFile,
  type ClipboardMimeExtensions,
} from '../src/index.js';

const IMAGE_EXTENSIONS: ClipboardMimeExtensions = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function dataTransfer(items: DataTransferItem[], files: File[]): DataTransfer {
  return {
    files,
    items,
  } as unknown as DataTransfer;
}

function fileItem(file: File | null): DataTransferItem {
  return {
    getAsFile: () => file,
    kind: 'file',
  } as DataTransferItem;
}

describe('firstSupportedClipboardImage', () => {
  it('prefers item order, ignores non-files, and checks MIME case-insensitively', () => {
    const textItem = { kind: 'string' } as DataTransferItem;
    const unsupported = new File(['x'], 'x.bmp', { type: 'image/bmp' });
    const supported = new File(['x'], 'x.PNG', { type: 'IMAGE/PNG' });
    expect(
      firstSupportedClipboardImage(
        dataTransfer([textItem, fileItem(unsupported), fileItem(null), fileItem(supported)], []),
        IMAGE_EXTENSIONS,
      ),
    ).toBe(supported);
  });

  it('deduplicates item/files identity and falls back to the files list', () => {
    const unsupported = new File(['x'], 'x.bmp', { type: 'image/bmp' });
    const supported = new File(['x'], 'x.webp', { type: 'image/webp' });
    expect(
      firstSupportedClipboardImage(
        dataTransfer([fileItem(unsupported)], [unsupported, supported]),
        IMAGE_EXTENSIONS,
      ),
    ).toBe(supported);
  });
});

describe('normalizeClipboardImageFile', () => {
  it('returns a safely named file unchanged, including jpg/jpeg aliases', () => {
    const png = new File(['x'], 'diagram.PNG', { lastModified: 10, type: 'image/png' });
    const jpeg = new File(['x'], 'photo.jpeg', { lastModified: 10, type: 'image/jpeg' });
    expect(normalizeClipboardImageFile(png, IMAGE_EXTENSIONS)).toBe(png);
    expect(normalizeClipboardImageFile(jpeg, IMAGE_EXTENSIONS)).toBe(jpeg);
  });

  it('replaces an unsafe or mismatched name using lastModified when available', () => {
    const source = new File(['image'], '../bad.svg', {
      lastModified: 1_234.7,
      type: 'image/png',
    });
    const normalized = normalizeClipboardImageFile(source, IMAGE_EXTENSIONS, () => 999);
    expect(normalized).not.toBe(source);
    expect(normalized.name).toBe('clipboard-image-1235.png');
    expect(normalized.type).toBe('image/png');
    expect(normalized.lastModified).toBe(source.lastModified);
    expect(normalized.size).toBe(source.size);
  });

  it('uses the supplied clock when lastModified is absent', () => {
    const source = new File(['image'], '', { lastModified: 0, type: 'image/gif' });
    Object.defineProperty(source, 'lastModified', { value: 0 });
    expect(normalizeClipboardImageFile(source, IMAGE_EXTENSIONS, () => 456.6).name).toBe(
      'clipboard-image-457.gif',
    );
  });

  it('rejects a MIME type outside the host policy', () => {
    const source = new File(['image'], 'image.bmp', { type: 'image/bmp' });
    expect(() => normalizeClipboardImageFile(source, IMAGE_EXTENSIONS)).toThrow(TypeError);
  });
});
