import { createHash } from 'node:crypto';
import * as calibration from './narration-teacher-calibration.js';
import * as inbox from './narration-teacher-feedback-inbox.js';
import * as style from './narration-style-examples.js';
import * as oneToOne from './narration-one-to-one-corpus.js';
import * as humanization from './narration-humanization-sources.js';

export const NARRATION_CORPUS_VERSION = 'reach-deck-narration-corpus/2026-09-22-v1';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Serialized fragments retain every authored string, including non-production source evidence. */
export const NARRATION_CORPUS = [
  {
    assets: calibration,
    file: 'narration-teacher-calibration.ts',
    version: calibration.NARRATION_TEACHER_CALIBRATION_VERSION,
  },
  {
    assets: inbox,
    file: 'narration-teacher-feedback-inbox.ts',
    version: inbox.NARRATION_TEACHER_FEEDBACK_INBOX_VERSION,
  },
  {
    assets: style,
    file: 'narration-style-examples.ts',
    version: style.OPENMAIC_CHINESE_NARRATION_CORPUS_VERSION,
  },
  {
    assets: oneToOne,
    file: 'narration-one-to-one-corpus.ts',
    version: oneToOne.OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS_VERSION,
  },
  {
    assets: humanization,
    file: 'narration-humanization-sources.ts',
    version: humanization.NARRATION_HUMANIZATION_SOURCES_VERSION,
  },
].flatMap(({ assets, file, version }) =>
  Object.entries(assets)
    .filter(
      ([id, value]) =>
        !id.endsWith('_VERSION') &&
        !id.endsWith('_SHA256') &&
        (typeof value === 'string' ||
          Array.isArray(value) ||
          (typeof value === 'object' && value !== null && !(value instanceof Map))),
    )
    .map(([id, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return Object.freeze({
        id,
        text,
        stage: 'narration',
        call: 'narration',
        purpose:
          'Full authored narration examples, source evidence, and teacher revisions; production selection remains governed by the original eligibility metadata',
        sourceFile: `services/ai-runtime/lib/reach-deck/${file}`,
        sourceVersion: version,
        corpusVersion: NARRATION_CORPUS_VERSION,
        sha256: sha256(text),
      });
    }),
);

export const NARRATION_CORPUS_DIGEST = sha256(
  JSON.stringify(
    NARRATION_CORPUS.map(({ id, sourceVersion, sha256: digest }) => ({
      id,
      sourceVersion,
      sha256: digest,
    })),
  ),
);
