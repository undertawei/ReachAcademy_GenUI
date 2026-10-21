export const INTERACTIVE_BLANK_TEMPLATE_VERSION = 'reach-interactive-blank/v1' as const;

export const CANONICAL_BLANK_INTERACTIVE_DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="reach-interactive-template" content="reach-interactive-blank/v1"><title></title></head><body><main data-reach-interactive-blank="reach-interactive-blank/v1"></main><script>window.addEventListener("reach-interactive-initialize",()=>window.ReachInteractive?.ready?.({empty:true,restored:false}),{once:true});</script></body></html>';

export type InteractiveBlankClassification = 'canonical-v1' | 'legacy-editor-v1' | 'nonblank';

const LEGACY_BLANK_BODY_COPY = new Set([
  'Design the interactive content here.',
  '在这里设计互动内容。',
]);

const normalizeKnownTemplate = (html: string): string =>
  html
    .trim()
    .replace(/>\s+</g, '><')
    .replace(/^<!doctype\s+html>/i, '<!doctype html>');

export function classifyInteractiveBlankDocument(
  documentHtml: string,
): InteractiveBlankClassification {
  const normalized = normalizeKnownTemplate(documentHtml);
  if (normalized === CANONICAL_BLANK_INTERACTIVE_DOCUMENT) return 'canonical-v1';

  const legacy =
    /^<!doctype html><html lang="(zh-CN|en-US)"><head><meta charset="utf-8"><title>([^<>]{1,200})<\/title><\/head><body><main><h1>\2<\/h1><p>([^<>]{1,80})<\/p><\/main><\/body><\/html>$/.exec(
      normalized,
    );
  return legacy !== null && LEGACY_BLANK_BODY_COPY.has(legacy[3]!)
    ? 'legacy-editor-v1'
    : 'nonblank';
}

export const isInteractiveBlankDocument = (documentHtml: string): boolean =>
  classifyInteractiveBlankDocument(documentHtml) !== 'nonblank';
