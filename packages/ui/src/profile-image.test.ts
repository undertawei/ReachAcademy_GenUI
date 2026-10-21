// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  animatedProfileImage,
  editedProfileName,
  prepareProfileImage,
  profileCrop,
} from './profile-image';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('profile image and nickname rules', () => {
  it('matches existing UTF-16 name length, ASCII trim and Unicode letter/digit semantics', () => {
    expect(editedProfileName('  中文 ٢-test_name  ')).toBe('中文 ٢-test_name');
    for (const value of [' ', '🙂', 'a.b', '\tname', 'a'.repeat(101), 'e\u0301'])
      expect(editedProfileName(value)).toBeNull();
    expect(editedProfileName('a'.repeat(100))).not.toBeNull();
  });
  it('keeps every crop square, integer and inside orientation-normalized dimensions', () => {
    for (const [width, height] of [
      [300, 700],
      [700, 300],
    ])
      for (const zoom of [1, 1.73, 4]) {
        const crop = profileCrop(width!, height!, zoom, 100, 37);
        expect(crop.width).toBe(crop.height);
        expect(Object.values(crop).every(Number.isInteger)).toBe(true);
        expect(crop.x + crop.width).toBeLessThanOrEqual(width!);
        expect(crop.y + crop.height).toBeLessThanOrEqual(height!);
      }
  });
  it('detects APNG and animated WebP chunks', () => {
    const png = new Uint8Array(20);
    png.set([97, 99, 84, 76], 12);
    const webp = new Uint8Array(20);
    webp.set([65, 78, 73, 77], 12);
    expect(animatedProfileImage(png, 'image/png')).toBe(true);
    expect(animatedProfileImage(webp, 'image/webp')).toBe(true);
    expect(animatedProfileImage(new Uint8Array(20), 'image/jpeg')).toBe(false);
  });
  it('normalizes EXIF orientation for preview but retains the original source for server validation', async () => {
    const file = new File(['jpeg'], 'portrait.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(4) });
    const close = vi.fn();
    const bitmap = { width: 300, height: 600, close };
    const decode = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal('createImageBitmap', decode);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['normalized'])),
    );
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:normalized'),
    });
    const image = await prepareProfileImage(file);
    expect(decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(image).toEqual({ file, width: 300, height: 600, url: 'blob:normalized' });
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects unsupported, oversized and dimension-invalid inputs', async () => {
    await expect(
      prepareProfileImage(new File(['x'], 'x.gif', { type: 'image/gif' })),
    ).rejects.toThrow('imageType');
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 4 * 1024 * 1024 + 1 });
    await expect(prepareProfileImage(file)).rejects.toThrow('imageSize');
    const small = new File(['x'], 'small.png', { type: 'image/png' });
    Object.defineProperty(small, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({ width: 255, height: 500, close }),
    );
    await expect(prepareProfileImage(small)).rejects.toThrow('imageDimensions');
    expect(close).toHaveBeenCalledOnce();
  });
});
