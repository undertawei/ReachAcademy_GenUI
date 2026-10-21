/**
 * 编辑期图片上传的共享边界。
 *
 * 幻灯片的窗口级粘贴（ReachDeckEditor）与测验富文本字段（RichTextElementEditor）共用同一套
 * 上限与 MIME 白名单，避免两条入口给出不一致的拒绝理由。
 */
export const CLIPBOARD_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

export const CLIPBOARD_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** `<input type="file">` 的 accept 提示；运行时仍以 CLIPBOARD_IMAGE_EXTENSIONS 复核。 */
export const CLIPBOARD_IMAGE_ACCEPT = Object.keys(CLIPBOARD_IMAGE_EXTENSIONS).join(',');
