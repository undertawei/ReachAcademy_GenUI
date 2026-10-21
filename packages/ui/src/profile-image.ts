export interface ProfileCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ProfileImage {
  file: File;
  url: string;
  width: number;
  height: number;
}
export function profileCrop(
  width: number,
  height: number,
  zoom: number,
  horizontal: number,
  vertical: number,
): ProfileCrop {
  const side = Math.max(1, Math.floor(Math.min(width, height) / zoom));
  return {
    x: Math.round(((width - side) * horizontal) / 100),
    y: Math.round(((height - side) * vertical) / 100),
    width: side,
    height: side,
  };
}
export function editedProfileName(value: string): string | null {
  const name = value.replace(/^ +| +$/g, '');
  return name.length >= 1 && name.length <= 100 && /^[\p{L}\p{Nd} _-]+$/u.test(name) ? name : null;
}
/** A structural animation check gives immediate feedback; the processor verifies all bytes. */
export function animatedProfileImage(bytes: Uint8Array, type: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (type === 'image/png') {
    for (let at = 8; at + 12 <= bytes.length; ) {
      const length = view.getUint32(at);
      if (text(at + 4) === 'acTL') return true;
      at += length + 12;
    }
  } else if (type === 'image/webp') {
    for (let at = 12; at + 8 <= bytes.length; ) {
      const length = view.getUint32(at + 4, true);
      if (text(at) === 'ANIM' || text(at) === 'ANMF') return true;
      at += 8 + length + (length % 2);
    }
  }
  return false;
}
export async function prepareProfileImage(file: File): Promise<ProfileImage> {
  if (file.size > 4 * 1024 * 1024) throw new Error('imageSize');
  if (!file.size || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('imageType');
  if (animatedProfileImage(new Uint8Array(await file.arrayBuffer()), file.type))
    throw new Error('imageAnimation');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('imageDecode');
  }
  try {
    const { width, height } = bitmap;
    if (width < 256 || height < 256 || width > 4096 || height > 4096)
      throw new Error('imageDimensions');
    // This URL is preview-only. Save always sends the unmodified original File.
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('imageDecode');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('imageDecode'))),
        'image/png',
      ),
    );
    canvas.width = 0;
    canvas.height = 0;
    return { file, width, height, url: URL.createObjectURL(blob) };
  } finally {
    bitmap.close();
  }
}
