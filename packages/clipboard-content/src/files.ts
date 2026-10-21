export type ClipboardMimeExtensions = Readonly<Record<string, string>>;

export function firstSupportedClipboardImage(
  clipboardData: DataTransfer,
  mimeExtensions: ClipboardMimeExtensions,
): File | undefined {
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  for (const file of Array.from(clipboardData.files)) {
    if (!files.includes(file)) files.push(file);
  }
  return files.find((file) => mimeExtensions[file.type.toLowerCase()] !== undefined);
}

export function normalizeClipboardImageFile(
  source: File,
  mimeExtensions: ClipboardMimeExtensions,
  now: () => number = Date.now,
): File {
  const contentType = source.type.toLowerCase();
  const extension = mimeExtensions[contentType];
  if (extension === undefined) {
    throw new TypeError(`Unsupported clipboard image MIME type: ${contentType || '(empty)'}`);
  }

  const expectedExtensions = contentType === 'image/jpeg' ? ['jpg', 'jpeg'] : [extension];
  const sourceExtension = source.name.includes('.')
    ? source.name.split('.').at(-1)?.toLowerCase()
    : '';
  const safeName =
    source.name.length > 0 &&
    source.name.length <= 255 &&
    !/[\u0000-\u001f/\\]/.test(source.name) &&
    source.name !== '.' &&
    source.name !== '..' &&
    expectedExtensions.includes(sourceExtension ?? '');
  if (safeName) return source;

  const timestamp = source.lastModified > 0 ? Math.round(source.lastModified) : Math.round(now());
  return new File([source], `clipboard-image-${timestamp}.${extension}`, {
    type: contentType,
    lastModified: source.lastModified,
  });
}
