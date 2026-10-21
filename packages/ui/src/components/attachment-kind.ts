import { File, FileAudio, FileImage, FileText, FileVideo, type LucideIcon } from 'lucide-react';

export type AttachmentPreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'none';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const AUDIO_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
]);
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+*-]{0,126}$/;

/** 文件名不能授予 inline 权限；签名响应的可信 MIME 决定实际预览类型。 */
export function attachmentPreviewKind(contentType?: string | null): AttachmentPreviewKind {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!MIME_TYPE.test(type)) return 'none';
  if (IMAGE_TYPES.has(type)) return 'image';
  if (VIDEO_TYPES.has(type)) return 'video';
  if (AUDIO_TYPES.has(type)) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') && type !== 'text/html') return 'text';
  return 'none';
}

export function attachmentIcon(kind: AttachmentPreviewKind): LucideIcon {
  switch (kind) {
    case 'image':
      return FileImage;
    case 'pdf':
    case 'text':
      return FileText;
    case 'video':
      return FileVideo;
    case 'audio':
      return FileAudio;
    default:
      return File;
  }
}
