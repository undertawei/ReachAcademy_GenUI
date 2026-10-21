import {
  CLIPBOARD_HTML_MAX_CHARACTERS,
  INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE,
  isProseMirrorClipboardSlice,
  markTrustedProseMirrorClipboardHtml,
  transformOfficeClipboardHtml,
  type ClipboardTableMode,
} from '@reachany/clipboard-content';

const PRIVATE_RESOURCE_ATTRIBUTE_PATTERN =
  /\b(?:data-pm-slice|data-reach-internal-slice|data-quiz-attachment|data-(?:asset-id|object-key|question-id|surface))\b/i;
const PRIVATE_RESOURCE_ATTRIBUTES = [
  'data-pm-slice',
  INTERNAL_CLIPBOARD_MARKER_ATTRIBUTE,
  'data-asset-id',
  'data-object-key',
  'data-question-id',
  'data-surface',
] as const;

export interface QuizOfficeClipboardOptions {
  /** Supplies a temporary text marker for a visible image that the caller will upload. */
  imagePlaceholder?: () => string | undefined;
  tableMode?: ClipboardTableMode;
  trustedInternal?: boolean;
  onUnavailableImage?: () => void;
}

/**
 * 将 Office/MathML 剪贴板 HTML 投影到 Quiz 富文本 schema 可解析的 HTML。
 *
 * 只有经过共享页面令牌校验的 ProseMirror slice 才会标记为受信；普通外部 HTML 保持既有
 * 解析路径，但会移除可将外部内容提升为既有 OSS 资源引用的私有属性和可伪造的内部标记。
 */
export function transformQuizOfficeClipboardHtml(
  html: string,
  options: QuizOfficeClipboardOptions = {},
): string {
  if (options.trustedInternal && isProseMirrorClipboardSlice(html)) {
    return removeUnownedImages(
      markTrustedProseMirrorClipboardHtml(html),
      true,
      options.onUnavailableImage,
    );
  }
  try {
    let unavailableImage = false;
    const result = transformOfficeClipboardHtml(html, {
      imagePlaceholder: options.imagePlaceholder,
      tableMode: options.tableMode ?? 'preserve',
      onUnavailableImage: () => {
        unavailableImage = true;
      },
    });
    if (result.kind === 'transformed') {
      if (unavailableImage) {
        options.onUnavailableImage?.();
        const body = new DOMParser().parseFromString(result.html, 'text/html').body;
        if (!hasClipboardContent(body)) return '';
      }
      return result.html;
    }
    return removeUnownedImages(
      stripExternalQuizResourceReferences(html),
      false,
      options.onUnavailableImage,
      options.imagePlaceholder,
    );
  } catch {
    // A rejected Office representation must not fall through to the broader Quiz schema.
    return '';
  }
}

function removeUnownedImages(
  html: string,
  trustedInternal: boolean,
  onUnavailableImage?: () => void,
  imagePlaceholder?: () => string | undefined,
): string {
  if (!/<img\b/i.test(html)) return html;
  if (html.length > CLIPBOARD_HTML_MAX_CHARACTERS) return '';
  const document = new DOMParser().parseFromString(html, 'text/html');
  let removed = false;
  for (const image of document.querySelectorAll('img')) {
    const key = image.getAttribute('data-object-key') ?? '';
    const canonical =
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(key) &&
      !key.endsWith('/') &&
      !key.includes('//') &&
      !key.split('/').some((segment) => segment === '.' || segment === '..');
    if (trustedInternal && canonical) continue;
    const placeholder = imagePlaceholder?.();
    if (placeholder !== undefined) {
      image.replaceWith(document.createTextNode(placeholder));
      continue;
    }
    image.remove();
    removed = true;
  }
  if (removed) onUnavailableImage?.();
  if (removed && !hasClipboardContent(document.body)) return '';
  return document.body.innerHTML;
}

function hasClipboardContent(body: HTMLElement): boolean {
  return Boolean(
    body.textContent?.trim() ||
    body.querySelector(
      'img,table,hr,pre,[data-latex],[data-type="mermaid-diagram"],[data-quiz-blank]',
    ),
  );
}

function stripExternalQuizResourceReferences(html: string): string {
  if (!PRIVATE_RESOURCE_ATTRIBUTE_PATTERN.test(html)) return html;
  if (html.length > CLIPBOARD_HTML_MAX_CHARACTERS) return '';

  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const attachment of document.querySelectorAll('[data-quiz-attachment]')) {
    attachment.removeAttribute('data-quiz-attachment');
    attachment.removeAttribute('data-mime-type');
    attachment.removeAttribute('data-size');
  }
  for (const attribute of PRIVATE_RESOURCE_ATTRIBUTES) {
    for (const element of document.querySelectorAll(`[${attribute}]`)) {
      element.removeAttribute(attribute);
    }
  }
  return document.body.innerHTML;
}

export type { ClipboardTableMode as QuizClipboardTableMode } from '@reachany/clipboard-content';
