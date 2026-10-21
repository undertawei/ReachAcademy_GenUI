import { buildReachDeckCodeSourceDigest } from './media-generation-checkpoint.js';
import {
  generateStructuredJsonWithModelService,
  type ReachDeckModelEnv,
  type ReachDeckModelRequestContext,
  type GenerateStructuredJsonWithModelServiceOptions,
} from './model-service-client.js';
import type { ReachDeckModelJsonSchema } from './model-service-schemas.js';
import {
  GENUI_DIAGRAM_AUTHOR_PROMPT,
  GENUI_DIAGRAM_PROMPT_VERSION,
} from './prompts/genui-diagram.js';

export { GENUI_DIAGRAM_PROMPT_VERSION } from './prompts/genui-diagram.js';

export interface GenuiDiagramModelOptions extends Pick<
  GenerateStructuredJsonWithModelServiceOptions<unknown>,
  'onUsage' | 'onPayload' | 'onOutputDiagnostic' | 'onDispatch'
> {
  context: ReachDeckModelRequestContext;
  pageId?: string;
  env?: ReachDeckModelEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export class ReachDeckScientificMediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReachDeckScientificMediaError';
  }
}
export { ReachDeckScientificMediaError as ScientificMediaError };

const authorSchema: ReachDeckModelJsonSchema = {
  name: 'reach_deck_genui_diagram',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['documentHtml', 'scientificModel'],
    properties: {
      documentHtml: { type: 'string' },
      scientificModel: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
    },
  },
};

export interface GenuiDiagramDocument {
  documentHtml: string;
  scientificModel: string[];
}

export function parseGenuiDiagramDocument(value: unknown): GenuiDiagramDocument {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid diagram document.');
  const document = value as Record<string, unknown>;
  if (
    Object.keys(document).some((key) => !['documentHtml', 'scientificModel'].includes(key)) ||
    typeof document.documentHtml !== 'string' ||
    !document.documentHtml.trim() ||
    Buffer.byteLength(document.documentHtml) > 200 * 1024 ||
    !Array.isArray(document.scientificModel) ||
    document.scientificModel.length < 1 ||
    document.scientificModel.length > 16 ||
    document.scientificModel.some(
      (rule) => typeof rule !== 'string' || !rule.trim() || rule.length > 1000,
    )
  )
    throw new Error('Diagram document or scientific rules are invalid.');
  return document as unknown as GenuiDiagramDocument;
}

export interface CodeMediaAuthorOptions {
  format: 'jpg' | 'gif';
  width: number;
  height: number;
  durationSeconds?: number;
  fps?: number;
}

/** This exact schema/prompt/payload is also used for durable author-request identity. */
export function buildCodeMediaAuthorInput(brief: string, options: CodeMediaAuthorOptions) {
  return {
    stage: 'interactive' as const,
    schema: authorSchema,
    systemPrompt: GENUI_DIAGRAM_AUTHOR_PROMPT,
    prompt: 'Generate the single visual specified in the supplied brief.',
    promptVersion: GENUI_DIAGRAM_PROMPT_VERSION,
    payload: {
      brief,
      format: options.format,
      width: options.width,
      height: options.height,
      ...(options.format === 'gif'
        ? { durationSeconds: options.durationSeconds, fps: options.fps }
        : {}),
    },
    maxOutputCorrections: 0,
    parse: parseGenuiDiagramDocument,
  };
}

export async function authorReachDeckDiagramDocument(
  brief: string,
  options: GenuiDiagramModelOptions & CodeMediaAuthorOptions,
) {
  options.signal?.throwIfAborted();
  if (
    options.format === 'jpg' &&
    (options.fps !== undefined || options.durationSeconds !== undefined)
  )
    throw new Error('JPG code media forbids animation timing.');
  if (
    options.format === 'gif' &&
    (options.fps === undefined || options.durationSeconds === undefined)
  )
    throw new Error('GIF code media requires timing.');
  const document = await generateStructuredJsonWithModelService({
    ...options,
    ...buildCodeMediaAuthorInput(brief, options),
  });
  options.signal?.throwIfAborted();
  return {
    ...document,
    sourceDigest: buildReachDeckCodeSourceDigest(document.documentHtml, document.scientificModel),
  };
}

/** Caller persists the authored receipt before invoking this pure render operation. */
export { captureReachDeckGenuiMedia } from './genui-media-capture.js';
