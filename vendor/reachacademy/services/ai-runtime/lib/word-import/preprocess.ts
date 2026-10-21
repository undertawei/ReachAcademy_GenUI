import type { DocxDiagnostic, DocxExtraction, DocxMediaDescriptor } from '@reachany/importer/docx';
import {
  WORD_IMPORT_SMART_PROMPT,
  type WordSourceBlock,
} from '@reachany/ai-runtime-feedforward/word-import';

export interface WordImportPreprocessing {
  blocks: WordSourceBlock[];
  diagnostics: DocxDiagnostic[];
  media: DocxMediaDescriptor[];
}

export const WORD_IMPORT_SMART_MODEL_CALL_LIMIT = 16;
export const WORD_IMPORT_SMART_TOKEN_BUDGET = 100_000;
export const WORD_IMPORT_SMART_MAX_OUTPUT_TOKENS = 16_384;

/** The one source projection consumed by both durable workers and local acceptance tools. */
export function preprocessWordImportDocument(document: DocxExtraction): WordImportPreprocessing {
  return {
    diagnostics: document.diagnostics,
    media: document.media.map(({ bytes: _bytes, ...descriptor }) => descriptor),
    blocks: document.blocks.map((block) => ({
      id: block.id,
      ...(block.numbering !== undefined && block.numberingLevel !== undefined
        ? {
            numbering: {
              label: block.numbering,
              level: block.numberingLevel,
              ...(block.numberingFormat ? { format: block.numberingFormat } : {}),
            },
          }
        : {}),
      content:
        block.kind === 'paragraph'
          ? (block.content.content?.[0]?.content ?? [])
          : (block.content.content ?? []),
    })),
  };
}

/** Mirrors the durable reservation gate before a smart segment is dispatched. */
export function wordImportSmartModelReservation(userInput: string): number {
  return (
    Buffer.byteLength(userInput + WORD_IMPORT_SMART_PROMPT) + WORD_IMPORT_SMART_MAX_OUTPUT_TOKENS
  );
}
