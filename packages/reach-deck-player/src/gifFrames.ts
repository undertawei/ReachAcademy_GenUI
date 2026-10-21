/** Bounded GIF parsing and sequential decoding; retains compressed frames, not all RGBA frames. */
export interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  delayMs: number;
  disposal: number;
  transparent?: number;
  palette: Uint8Array;
  minimumCodeSize: number;
  compressed: Uint8Array;
  interlaced: boolean;
}
export interface GifAnimation {
  width: number;
  height: number;
  frames: GifFrame[];
}

export function parseGif(bytes: Uint8Array): GifAnimation {
  if (
    bytes.length > 10 * 1024 * 1024 ||
    bytes.length < 14 ||
    !['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6)))
  )
    throw new Error('Invalid GIF');
  let cursor = 6;
  const byte = () => {
    if (cursor >= bytes.length) throw new Error('Truncated GIF');
    return bytes[cursor++]!;
  };
  const word = () => byte() | (byte() << 8);
  const take = (size: number) => {
    if (cursor + size > bytes.length) throw new Error('Truncated GIF');
    const value = bytes.slice(cursor, cursor + size);
    cursor += size;
    return value;
  };
  const blocks = () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let n = byte(); n; n = byte()) {
      chunks.push(take(n));
      size += n;
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return joined;
  };
  const width = word(),
    height = word(),
    packed = byte();
  byte();
  byte();
  if (!width || !height || width > 1280 || height > 720)
    throw new Error('GIF dimensions exceed budget');
  const globalPalette = packed & 128 ? take(3 * (1 << ((packed & 7) + 1))) : new Uint8Array();
  const frames: GifFrame[] = [];
  let delayMs = 100,
    disposal = 0,
    transparent: number | undefined;
  for (;;) {
    const marker = byte();
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        if (byte() !== 4) throw new Error('Invalid GIF control');
        const flags = byte();
        disposal = (flags >> 2) & 7;
        delayMs = Math.max(10, word() * 10);
        const index = byte();
        transparent = flags & 1 ? index : undefined;
        if (byte() !== 0 || disposal > 3) throw new Error('Invalid GIF control');
      } else blocks();
      continue;
    }
    if (marker !== 0x2c) throw new Error('Unsupported GIF block');
    const left = word(),
      top = word(),
      frameWidth = word(),
      frameHeight = word(),
      flags = byte();
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
      throw new Error('Invalid GIF frame rectangle');
    const palette = flags & 128 ? take(3 * (1 << ((flags & 7) + 1))) : globalPalette;
    const minimumCodeSize = byte();
    if (!palette.length || minimumCodeSize < 2 || minimumCodeSize > 8)
      throw new Error('Invalid GIF encoding');
    frames.push({
      left,
      top,
      width: frameWidth,
      height: frameHeight,
      delayMs,
      disposal,
      transparent,
      palette,
      minimumCodeSize,
      compressed: blocks(),
      interlaced: Boolean(flags & 64),
    });
    if (frames.length > 120 || width * height * frames.length > 32_000_000)
      throw new Error('GIF decoded frame budget exceeded');
    delayMs = 100;
    disposal = 0;
    transparent = undefined;
  }
  if (!frames.length) throw new Error('GIF has no frames');
  return { width, height, frames };
}

export function decodeGifFrame(frame: GifFrame): Uint8Array {
  const clear = 1 << frame.minimumCodeSize,
    end = clear + 1;
  const prefix = new Uint16Array(4096),
    suffix = new Uint8Array(4096),
    stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let size = frame.minimumCodeSize + 1,
    next = end + 1,
    bit = 0,
    previous = -1,
    first = 0,
    written = 0;
  const output = new Uint8Array(frame.width * frame.height);
  while (bit + size <= frame.compressed.length * 8) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++)
      code |= ((frame.compressed[bit >> 3]! >> (bit & 7)) & 1) << i;
    if (code === clear) {
      size = frame.minimumCodeSize + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;
    const original = code;
    let count = 0;
    if (code === next && previous >= 0) {
      stack[count++] = first;
      code = previous;
    } else if (code >= next) throw new Error('Invalid GIF LZW code');
    while (code >= clear) {
      if (count >= 4096 || code >= next) throw new Error('Invalid GIF LZW chain');
      stack[count++] = suffix[code]!;
      code = prefix[code]!;
    }
    first = suffix[code]!;
    stack[count++] = first;
    while (count) {
      if (written >= output.length) throw new Error('GIF frame overflow');
      output[written++] = stack[--count]!;
    }
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next++] = first;
      if (next === 1 << size && size < 12) size++;
    }
    previous = original;
  }
  if (written !== output.length) throw new Error('Incomplete GIF frame');
  if (!frame.interlaced) return output;
  const ordered = new Uint8Array(output.length);
  let row = 0;
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ])
    for (let y = start!; y < frame.height; y += step!) {
      ordered.set(output.subarray(row * frame.width, ++row * frame.width), y * frame.width);
    }
  return ordered;
}

/** Keeps two bounded canvas-sized buffers so disposal and pause are exact. */
export function createGifCompositor(animation: GifAnimation) {
  const pixels = new Uint8ClampedArray(animation.width * animation.height * 4);
  let restore: Uint8ClampedArray | undefined, previous: GifFrame | undefined;
  return (index: number) => {
    if (index === 0) {
      pixels.fill(0);
      previous = undefined;
      restore = undefined;
    }
    if (previous?.disposal === 2) {
      for (let y = previous.top; y < previous.top + previous.height; y++)
        pixels.fill(
          0,
          (y * animation.width + previous.left) * 4,
          (y * animation.width + previous.left + previous.width) * 4,
        );
    } else if (previous?.disposal === 3 && restore) pixels.set(restore);
    const frame = animation.frames[index]!;
    restore = frame.disposal === 3 ? pixels.slice() : undefined;
    const indices = decodeGifFrame(frame);
    for (let y = 0; y < frame.height; y++)
      for (let x = 0; x < frame.width; x++) {
        const color = indices[y * frame.width + x]!;
        if (color === frame.transparent) continue;
        if (color * 3 + 2 >= frame.palette.length) throw new Error('Invalid GIF palette index');
        const offset = ((frame.top + y) * animation.width + frame.left + x) * 4;
        pixels[offset] = frame.palette[color * 3]!;
        pixels[offset + 1] = frame.palette[color * 3 + 1]!;
        pixels[offset + 2] = frame.palette[color * 3 + 2]!;
        pixels[offset + 3] = 255;
      }
    previous = frame;
    return pixels;
  };
}
