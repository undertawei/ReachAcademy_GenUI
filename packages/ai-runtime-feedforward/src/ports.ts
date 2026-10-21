import type { Model } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type {
  AttachmentIngestionDependencies,
  AttachmentToolContent,
} from '@reachany/ai-runtime-common/file-ingestion';

import type { FeedforwardModelRequestContext, FeedforwardSubmissionAnswer } from './contracts.js';

export interface FeedforwardAgentTransport {
  model: Model<'openai-completions'>;
  apiKey: string;
  streamFn?: StreamFn;
}

export interface FeedforwardQuestionPorts {
  prepareGuardrailInput?(answers: readonly FeedforwardSubmissionAnswer[]): void;
  reviewAttachmentInput?(content: AttachmentToolContent[]): Promise<void>;
  createAgentTransport(context: FeedforwardModelRequestContext): Promise<FeedforwardAgentTransport>;
  attachmentDependencies?: AttachmentIngestionDependencies;
  generateFeedbackImage(input: {
    prompt: string;
    size: '1024x1024' | '1536x1024' | '1024x1536';
    context: FeedforwardModelRequestContext;
    /** 批阅循环的中止信号：循环结束或被中止后不得再生成图片。 */
    signal?: AbortSignal;
  }): Promise<{ base64: string }>;
  persistFeedbackImage(input: {
    bytes: Uint8Array;
    filename: string;
    contentType: 'image/png' | 'image/jpeg' | 'image/webp';
    slot: number;
    context: FeedforwardModelRequestContext;
    /** 批阅循环的中止信号：中止后不得再 presign / 上传 / finalize。 */
    signal?: AbortSignal;
  }): Promise<{ objectKey: string }>;
}
