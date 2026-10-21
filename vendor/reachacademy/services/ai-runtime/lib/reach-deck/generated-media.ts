import type { ReachDeckGeneratedImage, ReachDeckSpeechAudio } from './model-service-tools.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ReachDeckGeneratedMediaPayload {
  bytes: Uint8Array;
  contentType: string;
}

/** Decodes the requested b64_json image and verifies a supported binary signature. */
export function decodeReachDeckGeneratedImage(
  image: ReachDeckGeneratedImage,
): ReachDeckGeneratedMediaPayload {
  if (image.base64 === undefined) {
    throw new Error('model-service must return b64_json for durable Reach Deck image storage');
  }
  const encoded = image.base64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('model-service returned invalid generated image base64');
  }
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('generated image has an invalid size');
  }
  return { bytes, contentType: detectImageContentType(bytes) };
}

export function normalizeReachDeckSpeechAudio(
  audio: ReachDeckSpeechAudio,
  responseFormat: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac',
): ReachDeckGeneratedMediaPayload {
  const bytes = new Uint8Array(audio.bytes.byteLength);
  bytes.set(audio.bytes);
  const fallback = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    opus: 'audio/ogg',
    aac: 'audio/aac',
    flac: 'audio/flac',
  }[responseFormat];
  const contentType =
    audio.contentType === 'application/octet-stream' ? fallback : audio.contentType;
  return { bytes, contentType };
}

function detectImageContentType(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  throw new Error('model-service returned an unsupported generated image format');
}
