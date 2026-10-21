import {
  ingestAttachment as ingestCommonAttachment,
  type AttachmentIngestionDependencies,
  type AttachmentIngestionOptions,
} from '@reachany/ai-runtime-common/file-ingestion';

export * from '@reachany/ai-runtime-common/file-ingestion';

const UNAVAILABLE_MEDIA_DEPENDENCIES: AttachmentIngestionDependencies = {
  extractPdf: unavailable,
  transcribeAudio: unavailable,
  understandAudio: unavailable,
  understandVideo: unavailable,
  inspectMedia: unavailable,
  normalizeAudio: unavailable,
  normalizeVideo: unavailable,
  extractVideoAudio: unavailable,
};

/** Text and image ingestion remains local; managed document/media handlers are host-injected. */
export function ingestAttachment(options: AttachmentIngestionOptions) {
  return ingestCommonAttachment({
    ...options,
    dependencies: options.dependencies ?? UNAVAILABLE_MEDIA_DEPENDENCIES,
  });
}

async function unavailable(): Promise<never> {
  throw new Error('managed attachment capability is unavailable');
}
