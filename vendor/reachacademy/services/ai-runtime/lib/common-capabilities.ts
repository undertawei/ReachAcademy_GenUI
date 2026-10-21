import {
  createAttachmentIngestionState,
  ingestAttachment,
  type AttachmentIngestionOptions,
} from '@reachany/ai-runtime-common/file-ingestion';

export interface CommonFileCapability {
  key: 'common.file.ingest';
  createState: typeof createAttachmentIngestionState;
  execute(options: AttachmentIngestionOptions): ReturnType<typeof ingestAttachment>;
}

export const COMMON_CAPABILITIES: Readonly<Record<string, CommonFileCapability>> = {
  'common.file.ingest': {
    key: 'common.file.ingest',
    createState: createAttachmentIngestionState,
    execute: ingestAttachment,
  },
};

export function getCommonCapability(key: string): CommonFileCapability | undefined {
  return COMMON_CAPABILITIES[key];
}
