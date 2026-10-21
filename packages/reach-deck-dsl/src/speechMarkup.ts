import {
  countReachDeckNarrationSemanticUnits,
  normalizeReachDeckNarrationMarkdown,
  reachDeckNarrationContentDigestInput,
} from './narrationMarkdown.js';
import type { RichTextNode } from './richText.js';

export const REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION = 'reach-deck-speech-marks/v1' as const;
export const REACH_DECK_SPEECH_MARKUP_MAX_MARKS = 1_000;
export const REACH_DECK_SSML_MAX_CHARACTERS = 150;
export const REACH_DECK_SSML_MAX_SEMANTIC_UNITS = 80;

const SPEECH_CONTENT_DIGEST_INPUT_VERSION = 'reach-deck-narration-speech/v1';
const SPEAK_CLOSE = '</speak>';
const MAX_ATTRIBUTE_CODE_POINTS = 500;

export const REACH_DECK_SAY_AS_INTERPRETATIONS = [
  'Cardinal',
  'Cardinal-Liang',
  'Spell',
  'Spell-Yao',
  'Date-YMD',
  'Date-MDY',
  'Date-DMY',
  'Date-YM',
  'Date-MD',
  'Date-DM',
  'Date-Y',
  'Date-M',
  'Date-D',
  'Time',
  'Percent',
  'Fraction',
  'Currency',
  'Measure',
  'Telephone',
  'Ordinal',
  'Math',
  'Range',
  'Verbatim',
  'Decimal',
  'Abbr',
  'Time-Duration',
  'Score',
  'Electronic',
  'Letters',
  'Letterss',
  'id',
  'characters',
  'punctuation',
  'name',
  'address',
  'date',
  'digit',
  'money',
  'plain',
] as const;

export const REACH_DECK_SPEECH_EFFECTS = [
  'true_robot',
  'dizzy_effect',
  'heartbeat_intimacy',
  'ethereal_spirit',
  'office_ambiance',
  'storm_scene',
  'demon_whisper-silence_duration',
  'lightsaber_hum-aigc_metadata',
  'ghostly_presence',
  'memory_filter-icl',
  'metallic_resonance',
  'tavern_live',
  'cafe_ambiance',
  'fear_atmosphere',
  'airy_echo',
  'dreamcore',
  'hazy_ambience',
  'folk_reverb',
  'broken_mic',
  'killer_vibe',
  'parking_lot_reverb',
  'heartbeat_background',
  'school_announcement',
  'bathroom_reverb',
  'speech_dialogue',
] as const;

export type ReachDeckSayAsInterpretationV1 = (typeof REACH_DECK_SAY_AS_INTERPRETATIONS)[number];
export type ReachDeckPhonemeAlphabetV1 = 'py' | 'cmu' | 'ipa';
export type ReachDeckSpeechEffectV1 = (typeof REACH_DECK_SPEECH_EFFECTS)[number];

export interface ReachDeckSpeakOptionsV1 {
  bgm?: string;
  backgroundMusicVolume?: number;
  effect?: ReachDeckSpeechEffectV1;
}

export interface ReachDeckBreakSpeechMarkV1 {
  type: 'break';
  /** Canonical narration Markdown UTF-16 boundary. */
  at: number;
  durationMs: number;
}

export interface ReachDeckSoundEventSpeechMarkV1 {
  type: 'soundEvent';
  /** Canonical narration Markdown UTF-16 boundary. */
  at: number;
  src: string;
}

export interface ReachDeckSayAsSpeechMarkV1 {
  type: 'say-as';
  /** Canonical narration Markdown UTF-16 [from, to) range. */
  from: number;
  to: number;
  interpretAs: ReachDeckSayAsInterpretationV1;
}

export interface ReachDeckSubSpeechMarkV1 {
  type: 'sub';
  /** Canonical narration Markdown UTF-16 [from, to) range. */
  from: number;
  to: number;
  alias: string;
}

export interface ReachDeckPhonemeSpeechMarkV1 {
  type: 'phoneme';
  /** Canonical narration Markdown UTF-16 [from, to) range. */
  from: number;
  to: number;
  alphabet: ReachDeckPhonemeAlphabetV1;
  ph: string;
}

export type ReachDeckSpanSpeechMarkV1 =
  | ReachDeckSayAsSpeechMarkV1
  | ReachDeckSubSpeechMarkV1
  | ReachDeckPhonemeSpeechMarkV1;

export type ReachDeckPointSpeechMarkV1 =
  | ReachDeckBreakSpeechMarkV1
  | ReachDeckSoundEventSpeechMarkV1;
export type ReachDeckSpeechMarkV1 = ReachDeckPointSpeechMarkV1 | ReachDeckSpanSpeechMarkV1;
export type SpeechMark = ReachDeckSpeechMarkV1;

export interface ReachDeckSpeechMarkupV1 {
  schemaVersion: typeof REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION;
  marks: ReachDeckSpeechMarkV1[];
  speak?: ReachDeckSpeakOptionsV1;
}

export interface ReachDeckMarkdownRangeV1 {
  from: number;
  to: number;
}

/** Longest spoken reading one formula may expand to; it must still fit one SSML chunk. */
export const REACH_DECK_FORMULA_READING_MAX_CHARACTERS = 120;

/**
 * Synthesis-only spoken reading for one complete narration formula. It is never persisted with the
 * teacher's speech marks: the formula stays one visible atomic unit, only its spoken text changes.
 * A reading may also cover a plain-text mathematical expression written without delimiters
 * (`f(−x)=f(x)`); that span becomes the same kind of atomic unit.
 */
export interface ReachDeckFormulaReadingV1 {
  /** Exact canonical formula range (delimiters included) or one plain-text expression range. */
  from: number;
  to: number;
  reading: string;
}

export interface ReachDeckSpeechSynthesisOptionsV1 {
  formulaReadings?: readonly ReachDeckFormulaReadingV1[];
}

export type ReachDeckSpeechAlignmentMapEntryKindV1 =
  | 'text'
  | 'formula'
  | ReachDeckSpeechMarkV1['type'];

/**
 * A deterministic bridge from the actual alignment transcript back to canonical Markdown.
 * `text` entries may be mapped within the range; every other kind is an indivisible unit.
 */
export interface ReachDeckSpeechAlignmentMapEntryV1 {
  kind: ReachDeckSpeechAlignmentMapEntryKindV1;
  markdownFrom: number;
  markdownTo: number;
  spokenFrom: number;
  spokenTo: number;
  atomic: boolean;
}

export interface ReachDeckSpeechProjectionV1 {
  /** Visible narration with canonical Markdown escapes decoded and formulas retained as one unit. */
  visibleText: string;
  /** Plain transcript sent to alignment; it never contains XML. */
  alignmentTranscript: string;
  alignmentMap: ReachDeckSpeechAlignmentMapEntryV1[];
}

export interface ReachDeckSpeechVisibleMapEntryV1 {
  markdownFrom: number;
  markdownTo: number;
  visibleFrom: number;
  visibleTo: number;
}

export interface ReachDeckSpeechDocumentProjectionV1 extends ReachDeckSpeechProjectionV1 {
  markdownLength: number;
  visibleMap: ReachDeckSpeechVisibleMapEntryV1[];
}

export interface ReachDeckSsmlChunkV1 {
  index: number;
  /** Global canonical Markdown range covered by this chunk. */
  markdownFrom: number;
  markdownTo: number;
  ssml: string;
  /** Chunk-local transcript and spoken offsets; Markdown offsets remain global. */
  alignmentTranscript: string;
  alignmentMap: ReachDeckSpeechAlignmentMapEntryV1[];
}

export type ReachDeckSpeechMarkupErrorCode =
  | 'invalid-schema'
  | 'invalid-mark'
  | 'invalid-range'
  | 'non-canonical-order'
  | 'overlapping-marks'
  | 'formula-intersection'
  | 'invalid-boundary'
  | 'invalid-unicode'
  | 'invalid-attribute'
  | 'mark-limit'
  | 'chunk-unit-limit'
  | 'invalid-formula-reading';

export class ReachDeckSpeechMarkupError extends Error {
  constructor(
    readonly code: ReachDeckSpeechMarkupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReachDeckSpeechMarkupError';
  }
}

type UnknownRecord = Record<string, unknown>;

interface SpeechUnit {
  kind: ReachDeckSpeechAlignmentMapEntryKindV1;
  markdownFrom: number;
  markdownTo: number;
  visibleText: string;
  spokenText: string;
  ssml: string;
  atomic: boolean;
}

/** Strict persisted-value parser. The mark array must already use canonical source order. */
export function parseReachDeckSpeechMarkupV1(
  value: unknown,
  markdown: string,
): ReachDeckSpeechMarkupV1 {
  const parsed = parseMarkupShape(value, canonicalMarkdown(markdown));
  const decorated = parsed.marks.map((mark, index) => ({ mark, index }));
  decorated.sort((left, right) => compareMarks(left.mark, right.mark));
  if (decorated.some((entry, index) => entry.index !== index)) {
    fail('non-canonical-order', 'Speech marks must use canonical source order.');
  }
  validateMarkRelationships(parsed.marks, markdown);
  return parsed;
}

/** Validate and sort editor-produced marks into the persisted canonical representation. */
export function canonicalizeReachDeckSpeechMarkupV1(
  value: unknown,
  markdown: string,
): ReachDeckSpeechMarkupV1 {
  const canonical = canonicalMarkdown(markdown);
  const parsed = parseMarkupShape(value, canonical);
  const marks = [...parsed.marks].sort(compareMarks);
  validateMarkRelationships(marks, canonical);
  return {
    schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
    marks,
    ...(parsed.speak === undefined ? {} : { speak: parsed.speak }),
  };
}

/** Formula source ranges include their canonical delimiters and are always indivisible. */
export function reachDeckNarrationFormulaRanges(markdown: string): ReachDeckMarkdownRangeV1[] {
  const canonical = canonicalMarkdown(markdown);
  const ranges: ReachDeckMarkdownRangeV1[] = [];
  let cursor = 0;
  while (cursor < canonical.length) {
    if (canonical.startsWith('\\(', cursor)) {
      const close = canonical.indexOf('\\)', cursor + 2);
      if (close < 0) fail('invalid-range', 'Narration contains an unclosed inline formula.');
      ranges.push({ from: cursor, to: close + 2 });
      cursor = close + 2;
      continue;
    }
    if (canonical.startsWith('\\[', cursor)) {
      const close = canonical.indexOf('\\]', cursor + 2);
      if (close < 0) fail('invalid-range', 'Narration contains an unclosed block formula.');
      ranges.push({ from: cursor, to: close + 2 });
      cursor = close + 2;
      continue;
    }
    if (canonical[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    cursor += codePointWidthAt(canonical, cursor);
  }
  return ranges;
}

/** Legal cue/reveal/anchor boundaries exclude formulas, speech spans, escapes, and surrogate pairs. */
export function reachDeckSpeechMarkupLegalBoundaries(
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): number[] {
  const canonical = canonicalMarkdown(markdown);
  const markup = parseOptionalMarkup(speechMarkup, canonical);
  const forbiddenRanges = [
    ...reachDeckNarrationFormulaRanges(canonical),
    ...markup.marks.filter(isSpanMark).map(({ from, to }) => ({ from, to })),
  ];
  const result: number[] = [];
  for (let at = 0; at <= canonical.length; at += 1) {
    if (!isBaseBoundary(canonical, at)) continue;
    if (forbiddenRanges.some((range) => at > range.from && at < range.to)) continue;
    result.push(at);
  }
  return result;
}

export function isReachDeckSpeechMarkupLegalBoundary(
  markdown: string,
  at: number,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): boolean {
  if (!Number.isSafeInteger(at)) return false;
  return reachDeckSpeechMarkupLegalBoundaries(markdown, speechMarkup).includes(at);
}

/** Build XML-free spoken text and the only supported coordinate projection. */
export function projectReachDeckSpeechMarkup(
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
  options?: ReachDeckSpeechSynthesisOptionsV1,
): ReachDeckSpeechProjectionV1 {
  const units = speechUnits(markdown, speechMarkup, options);
  return projectionFromUnits(units);
}

/**
 * Build the richer full-document projection used by consumers that must map arbitrary timestamp
 * ranges without reparsing a substring as standalone Markdown.
 */
export function projectReachDeckSpeechDocument(
  markdown: string,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
  options?: ReachDeckSpeechSynthesisOptionsV1,
): ReachDeckSpeechDocumentProjectionV1 {
  const units = speechUnits(markdown, speechMarkup, options);
  return {
    ...projectionFromUnits(units),
    markdownLength: markdown.length,
    visibleMap: visibleMapFromUnits(units),
  };
}

/** Extract one visible source range using offsets from a full-document projection. */
export function projectReachDeckSpeechVisibleRange(
  projection: ReachDeckSpeechDocumentProjectionV1,
  range: ReachDeckMarkdownRangeV1,
): string {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.from > range.to ||
    range.to > projection.markdownLength
  ) {
    fail('invalid-range', 'Speech visible range must be within the full canonical Markdown.');
  }
  if (
    projection.visibleMap.some(
      (entry) =>
        (range.from > entry.markdownFrom && range.from < entry.markdownTo) ||
        (range.to > entry.markdownFrom && range.to < entry.markdownTo),
    )
  ) {
    fail('invalid-boundary', 'Speech visible range must use full-document projection boundaries.');
  }
  const selected = projection.visibleMap.filter(
    (entry) => entry.markdownTo > range.from && entry.markdownFrom < range.to,
  );
  const first = selected[0];
  const last = selected.at(-1);
  if (first === undefined || last === undefined) return '';
  return projection.visibleText.slice(first.visibleFrom, last.visibleTo);
}

/** Serialize only allowlisted, structured marks. Caller-supplied XML is never accepted. */
export function serializeReachDeckSpeechMarkupToSsml(
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
  options?: ReachDeckSpeechSynthesisOptionsV1,
): string {
  const speak = parseOptionalMarkup(speechMarkup, canonicalMarkdown(markdown)).speak;
  return wrapSpeak(
    speechUnits(markdown, speechMarkup, options)
      .map((unit) => unit.ssml)
      .join(''),
    speak,
  );
}

/**
 * Plan deterministic legal provider requests. Every returned `<speak>` document is within the
 * configured XML limit and the editor's semantic-unit limit; formulas and span marks remain atomic.
 */
export function planReachDeckSsmlChunks(
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
  maxCharacters = REACH_DECK_SSML_MAX_CHARACTERS,
  options?: ReachDeckSpeechSynthesisOptionsV1,
): ReachDeckSsmlChunkV1[] {
  validateSsmlChunkLimit(maxCharacters);
  const speak = parseOptionalMarkup(speechMarkup, canonicalMarkdown(markdown)).speak;
  return planSpeechUnitChunks(speechUnits(markdown, speechMarkup, options), maxCharacters, speak);
}

/**
 * Plan a preview selection from the already validated full canonical document. The selected source
 * is never reparsed as standalone Markdown, so line-sensitive syntax outside its original context
 * cannot change meaning.
 */
export function planReachDeckSsmlSelectionChunks(
  markdown: string,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
  selection: ReachDeckMarkdownRangeV1,
  maxCharacters = REACH_DECK_SSML_MAX_CHARACTERS,
  options?: ReachDeckSpeechSynthesisOptionsV1,
): ReachDeckSsmlChunkV1[] {
  validateSsmlChunkLimit(maxCharacters);
  const units = speechUnits(markdown, speechMarkup, options);
  assertSpeechUnitRange(units, markdown.length, selection, 'Speech selection');
  const selected = units.filter((unit) =>
    isPointSpeechUnit(unit)
      ? unit.markdownFrom >= selection.from &&
        (unit.markdownFrom < selection.to ||
          (selection.to === markdown.length && unit.markdownFrom === selection.to))
      : unit.markdownFrom >= selection.from && unit.markdownTo <= selection.to,
  );
  const speak = parseOptionalMarkup(speechMarkup, canonicalMarkdown(markdown)).speak;
  return planSpeechUnitChunks(selected, maxCharacters, speak);
}

function validateSsmlChunkLimit(maxCharacters: number): void {
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters > REACH_DECK_SSML_MAX_CHARACTERS ||
    maxCharacters <= codePointLength(wrapSpeak(''))
  ) {
    fail(
      'chunk-unit-limit',
      `SSML chunk limit must be an integer between ${codePointLength(wrapSpeak('')) + 1} and ${REACH_DECK_SSML_MAX_CHARACTERS}.`,
    );
  }
}

function planSpeechUnitChunks(
  units: readonly SpeechUnit[],
  maxCharacters: number,
  speak?: ReachDeckSpeakOptionsV1,
): ReachDeckSsmlChunkV1[] {
  const chunks: ReachDeckSsmlChunkV1[] = [];
  let pending: SpeechUnit[] = [];

  const emit = (chunkUnits: readonly SpeechUnit[]): void => {
    const projection = projectionFromUnits(chunkUnits);
    if (projection.alignmentTranscript.trim().length === 0) {
      fail('chunk-unit-limit', 'Every SSML chunk must contain spoken text for alignment.');
    }
    const ssml = wrapSpeak(chunkUnits.map((unit) => unit.ssml).join(''), speak);
    chunks.push({
      index: chunks.length,
      markdownFrom: Math.min(...chunkUnits.map((unit) => unit.markdownFrom)),
      markdownTo: Math.max(...chunkUnits.map((unit) => unit.markdownTo)),
      ssml,
      alignmentTranscript: projection.alignmentTranscript,
      alignmentMap: projection.alignmentMap,
    });
  };

  for (const unit of units) {
    if (!fitsSsmlChunk([unit], maxCharacters, speak)) {
      fail(
        'chunk-unit-limit',
        `The indivisible ${unit.kind} unit at Markdown offset ${unit.markdownFrom} exceeds the SSML chunk limit.`,
      );
    }
    pending.push(unit);
    while (!fitsSsmlChunk(pending, maxCharacters, speak)) {
      const maximumPrefix = largestFittingPrefix(pending, maxCharacters, speak);
      const splitAt = fittingSpokenChunkBoundary(pending, maximumPrefix, maxCharacters, speak);
      emit(pending.slice(0, splitAt));
      pending = pending.slice(splitAt);
    }
  }
  if (pending.length > 0) emit(pending);
  return chunks;
}

function fitsSsmlChunk(
  units: readonly SpeechUnit[],
  maxCharacters: number,
  speak?: ReachDeckSpeakOptionsV1,
): boolean {
  // Check the XML envelope first to bound the subsequent semantic scans to at most 150 code points.
  if (codePointLength(wrapSpeak(units.map((unit) => unit.ssml).join(''), speak)) > maxCharacters) {
    return false;
  }
  return (
    speechUnitSemanticCount(units, 'visibleText') <= REACH_DECK_SSML_MAX_SEMANTIC_UNITS &&
    speechUnitSemanticCount(units, 'spokenText') <= REACH_DECK_SSML_MAX_SEMANTIC_UNITS
  );
}

function speechUnitSemanticCount(
  units: readonly SpeechUnit[],
  textKey: 'visibleText' | 'spokenText',
): number {
  const content: RichTextNode[] = [];
  let text = '';
  const flushText = (): void => {
    if (text.length > 0) content.push({ type: 'text', text });
    text = '';
  };
  for (const unit of units) {
    if (unit.kind === 'formula') {
      flushText();
      // Formula contents never contribute more than one editor unit.
      content.push({ type: 'inlineMath', attrs: { latex: 'x' } });
    } else {
      // Adjacent units/marks must not split Latin/digit tokens or Unicode graphemes.
      text += unit[textKey];
    }
  }
  flushText();
  return countReachDeckNarrationSemanticUnits({
    type: 'doc',
    content: [{ type: 'paragraph', content }],
  });
}

function assertSpeechUnitBoundary(units: readonly SpeechUnit[], at: number, label: string): void {
  if (units.some((unit) => at > unit.markdownFrom && at < unit.markdownTo)) {
    fail(
      'invalid-boundary',
      `${label} splits a Unicode scalar, Markdown escape, formula, or mark.`,
    );
  }
}

function assertSpeechUnitRange(
  units: readonly SpeechUnit[],
  markdownLength: number,
  range: ReachDeckMarkdownRangeV1,
  label: string,
): void {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.from >= range.to ||
    range.to > markdownLength
  ) {
    fail('invalid-range', `${label} must be a non-empty in-bounds [from, to) range.`);
  }
  assertSpeechUnitBoundary(units, range.from, `${label}.from`);
  assertSpeechUnitBoundary(units, range.to, `${label}.to`);
}

function fittingSpokenChunkBoundary(
  units: readonly SpeechUnit[],
  maximumPrefix: number,
  maxCharacters: number,
  speak?: ReachDeckSpeakOptionsV1,
): number {
  const preferred = preferredSoftChunkBoundary(units, maximumPrefix);
  const candidates = [
    ...(preferred === undefined ? [] : [preferred]),
    ...Array.from({ length: maximumPrefix }, (_, index) => maximumPrefix - index),
  ];
  for (const splitAt of new Set(candidates)) {
    const prefix = units.slice(0, splitAt);
    const suffix = units.slice(splitAt);
    if (!hasSpokenText(prefix) || !hasSpokenText(suffix)) continue;
    if (
      fitsSsmlChunk(prefix, maxCharacters, speak) &&
      fitsSsmlChunk(suffix, maxCharacters, speak)
    ) {
      return splitAt;
    }
  }
  fail(
    'chunk-unit-limit',
    'A speech break cannot share a valid SSML alignment chunk within the chunk limits.',
  );
}

function hasSpokenText(units: readonly SpeechUnit[]): boolean {
  return units.some((unit) => unit.spokenText.trim().length > 0);
}

function largestFittingPrefix(
  units: readonly SpeechUnit[],
  maxCharacters: number,
  speak?: ReachDeckSpeakOptionsV1,
): number {
  let fitting = 0;
  for (let end = 1; end <= units.length; end += 1) {
    if (!fitsSsmlChunk(units.slice(0, end), maxCharacters, speak)) break;
    fitting += 1;
  }
  if (fitting === 0) {
    fail('chunk-unit-limit', 'An indivisible speech unit exceeds the SSML chunk limit.');
  }
  return fitting;
}

function preferredSoftChunkBoundary(
  units: readonly SpeechUnit[],
  maximumPrefix: number,
): number | undefined {
  let bestAt: number | undefined;
  let bestPriority = 0;
  for (let at = 1; at <= maximumPrefix; at += 1) {
    const priority = softChunkBoundaryPriority(units, at);
    if (priority > bestPriority || (priority === bestPriority && priority > 0)) {
      bestAt = at;
      bestPriority = priority;
    }
  }
  return bestAt;
}

function softChunkBoundaryPriority(units: readonly SpeechUnit[], at: number): number {
  if (at <= 0 || at >= units.length) return 0;
  const previous = units[at - 1]!;
  const next = units[at]!;
  if (/[\r\n]$/u.test(previous.visibleText)) return 4;
  // Break and sound-event marks are deliberate pauses. A formula or marked span is merely
  // indivisible: cutting beside it mid-sentence ("It's on | 2nd August") resets the provider's
  // prosody, so it ranks with whitespace below sentence endings.
  if (isPointSpeechUnit(previous) || isPointSpeechUnit(next)) return 3;
  if (previous.atomic || next.atomic) return 2;
  if (/\s$/u.test(previous.visibleText)) return 2;
  // Closing quotes and brackets stay with their sentence: the sentence ends after them.
  if (SENTENCE_CLOSER.test(next.visibleText)) return 0;
  let end = at - 1;
  while (end > 0 && SENTENCE_CLOSER.test(units[end]!.visibleText)) end -= 1;
  const last = units[end]!;
  if (!/[.!?。！？；;…]$/u.test(last.visibleText)) return 0;
  // Keep a consecutive ellipsis together when the available window permits it.
  if (/[.…]$/u.test(previous.visibleText) && /^[.…]/u.test(next.visibleText)) return 0;
  // A full stop followed directly by a Latin letter or digit is a decimal point or abbreviation
  // (2.5, e.g). Chinese narration often continues without a space ("May.这里…"); that is a
  // sentence end, so Han and other scripts do not disqualify it.
  if (/\.$/u.test(previous.visibleText) && /^[\p{Script=Latin}\p{N}]/u.test(next.visibleText)) {
    return 0;
  }
  return 3;
}

const SENTENCE_CLOSER = /^[”’"'）)\]」』》]$/u;

/** New marks affect identity; absent marks retain the historical digest input byte-for-byte. */
export function reachDeckNarrationSpeechContentDigestInput(
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): string {
  const canonical = canonicalMarkdown(markdown);
  if (speechMarkup === undefined) {
    return reachDeckNarrationContentDigestInput(canonical);
  }
  const parsed = parseReachDeckSpeechMarkupV1(speechMarkup, canonical);
  return `${SPEECH_CONTENT_DIGEST_INPUT_VERSION}\0${canonical}\0${JSON.stringify(parsed)}`;
}

function parseMarkupShape(value: unknown, markdown: string): ReachDeckSpeechMarkupV1 {
  validateXmlText(markdown, 'Narration markdown');
  const markup = record(value, 'speech markup');
  exactKeys(markup, ['schemaVersion', 'marks'], 'speech markup', ['speak']);
  if (markup.schemaVersion !== REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION) {
    fail(
      'invalid-schema',
      `Speech markup must use schemaVersion ${REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION}.`,
    );
  }
  if (!Array.isArray(markup.marks)) fail('invalid-schema', 'Speech markup.marks must be an array.');
  const speak = markup.speak === undefined ? undefined : parseSpeakOptions(markup.speak);
  if (markup.marks.length === 0 && speak === undefined) {
    fail('invalid-schema', 'Empty speech markup must be omitted.');
  }
  if (markup.marks.length > REACH_DECK_SPEECH_MARKUP_MAX_MARKS) {
    fail('mark-limit', `Speech markup exceeds ${REACH_DECK_SPEECH_MARKUP_MAX_MARKS} marks.`);
  }
  const marks = markup.marks.map((candidate, index) => parseMark(candidate, index, markdown));
  return {
    schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
    marks,
    ...(speak === undefined ? {} : { speak }),
  };
}

function parseSpeakOptions(value: unknown): ReachDeckSpeakOptionsV1 {
  const label = 'speech markup.speak';
  const speak = record(value, label);
  exactKeys(speak, [], label, ['bgm', 'backgroundMusicVolume', 'effect']);
  if (Object.keys(speak).length === 0) {
    fail('invalid-schema', 'Empty speech markup.speak must be omitted.');
  }
  const bgm = speak.bgm === undefined ? undefined : httpUrl(speak.bgm, `${label}.bgm`);
  const backgroundMusicVolume =
    speak.backgroundMusicVolume === undefined
      ? undefined
      : integerInRange(speak.backgroundMusicVolume, 0, 100, `${label}.backgroundMusicVolume`);
  if (
    speak.effect !== undefined &&
    !(REACH_DECK_SPEECH_EFFECTS as readonly unknown[]).includes(speak.effect)
  ) {
    fail('invalid-attribute', `${label}.effect is not supported.`);
  }
  return {
    ...(bgm === undefined ? {} : { bgm }),
    ...(backgroundMusicVolume === undefined ? {} : { backgroundMusicVolume }),
    ...(speak.effect === undefined ? {} : { effect: speak.effect as ReachDeckSpeechEffectV1 }),
  };
}

function parseMark(value: unknown, index: number, markdown: string): ReachDeckSpeechMarkV1 {
  const label = `speech markup.marks[${index}]`;
  const mark = record(value, label);
  if (mark.type === 'break') {
    exactKeys(mark, ['type', 'at', 'durationMs'], label);
    const at = sourceOffset(mark.at, markdown.length, `${label}.at`);
    assertBaseBoundary(markdown, at, `${label}.at`);
    const durationMs = integerInRange(mark.durationMs, 1, 10_000, `${label}.durationMs`);
    return { type: 'break', at, durationMs };
  }
  if (mark.type === 'soundEvent') {
    exactKeys(mark, ['type', 'at', 'src'], label);
    const at = sourceOffset(mark.at, markdown.length, `${label}.at`);
    assertBaseBoundary(markdown, at, `${label}.at`);
    return { type: 'soundEvent', at, src: httpUrl(mark.src, `${label}.src`) };
  }
  if (mark.type === 'say-as') {
    exactKeys(mark, ['type', 'from', 'to', 'interpretAs'], label);
    const range = sourceRange(mark, markdown, label);
    if (!(REACH_DECK_SAY_AS_INTERPRETATIONS as readonly unknown[]).includes(mark.interpretAs)) {
      fail('invalid-attribute', `${label}.interpretAs is not supported.`);
    }
    const source = decodedPlainSource(markdown, range.from, range.to, label);
    assertSingleLinePlainText(source, label);
    return {
      type: 'say-as',
      ...range,
      interpretAs: mark.interpretAs as ReachDeckSayAsInterpretationV1,
    };
  }
  if (mark.type === 'sub') {
    exactKeys(mark, ['type', 'from', 'to', 'alias'], label);
    const range = sourceRange(mark, markdown, label);
    assertSingleLinePlainText(decodedPlainSource(markdown, range.from, range.to, label), label);
    const alias = boundedAttribute(mark.alias, `${label}.alias`);
    return { type: 'sub', ...range, alias };
  }
  if (mark.type === 'phoneme') {
    exactKeys(mark, ['type', 'from', 'to', 'alphabet', 'ph'], label);
    const range = sourceRange(mark, markdown, label);
    if (mark.alphabet !== 'py' && mark.alphabet !== 'cmu' && mark.alphabet !== 'ipa') {
      fail('invalid-attribute', `${label}.alphabet is not supported.`);
    }
    const source = decodedPlainSource(markdown, range.from, range.to, label);
    if (mark.alphabet === 'py') {
      if (!/^\p{Script=Han}+$/u.test(source)) {
        fail('invalid-attribute', `${label} py source must contain Han characters only.`);
      }
    } else if (!/^[A-Za-z]+(?: [A-Za-z]+)*$/u.test(source)) {
      fail('invalid-attribute', `${label} ${mark.alphabet} source must contain Latin words only.`);
    }
    const ph = boundedAttribute(mark.ph, `${label}.ph`);
    return { type: 'phoneme', ...range, alphabet: mark.alphabet, ph };
  }
  fail('invalid-mark', `${label}.type is not supported.`);
}

function validateMarkRelationships(
  marks: readonly ReachDeckSpeechMarkV1[],
  markdown: string,
): void {
  const formulas = reachDeckNarrationFormulaRanges(markdown);
  const spans: ReachDeckSpanSpeechMarkV1[] = [];
  const pointsByType = new Map<ReachDeckPointSpeechMarkV1['type'], Set<number>>();
  const pointOffsets: number[] = [];
  for (const mark of marks) {
    if (isPointMark(mark)) {
      const offsets = pointsByType.get(mark.type) ?? new Set<number>();
      if (offsets.has(mark.at)) {
        fail('invalid-mark', `Duplicate ${mark.type} marks are not allowed.`);
      }
      offsets.add(mark.at);
      pointsByType.set(mark.type, offsets);
      pointOffsets.push(mark.at);
      if (formulas.some((range) => pointInside(mark.at, range))) {
        fail('formula-intersection', 'Speech point marks cannot occur inside formulas.');
      }
      if (spans.some((range) => pointInside(mark.at, range))) {
        fail('overlapping-marks', 'Speech point marks cannot occur inside span marks.');
      }
      continue;
    }
    if (formulas.some((range) => rangesIntersect(mark, range))) {
      fail('formula-intersection', 'Speech span marks cannot intersect formulas.');
    }
    if (spans.some((range) => rangesIntersect(mark, range))) {
      fail('overlapping-marks', 'Speech span marks cannot cross, nest, or overlap.');
    }
    if (pointOffsets.some((at) => pointInside(at, mark))) {
      fail('overlapping-marks', 'Speech point marks cannot occur inside span marks.');
    }
    spans.push(mark);
  }
}

/**
 * Validate synthesis-only formula readings against the canonical narration. Each reading must name
 * one complete formula exactly once and be plain single-line speech: no LaTeX, Markdown or XML may
 * reach the provider through it.
 */
export function parseReachDeckFormulaReadingsV1(
  markdown: string,
  value: unknown,
): ReachDeckFormulaReadingV1[] {
  const canonical = canonicalMarkdown(markdown);
  if (!Array.isArray(value)) fail('invalid-formula-reading', 'Formula readings must be an array.');
  const formulas = new Map(
    reachDeckNarrationFormulaRanges(canonical).map((range) => [range.from, range] as const),
  );
  const formulaRanges = [...formulas.values()];
  const seen = new Set<number>();
  const readings = value.map((item: unknown, index): ReachDeckFormulaReadingV1 => {
    const label = `formulaReadings[${index}]`;
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['from', 'to', 'reading'].includes(key))
    ) {
      fail('invalid-formula-reading', `${label} must contain only from, to and reading.`);
    }
    const raw = item as UnknownRecord;
    const delimited = typeof raw.from === 'number' ? formulas.get(raw.from) : undefined;
    const formula =
      delimited !== undefined && raw.to === delimited.to
        ? delimited
        : plainFormulaReadingRange(canonical, raw.from, raw.to, formulaRanges, label);
    if (seen.has(formula.from)) {
      fail('invalid-formula-reading', `${label} repeats a formula reading.`);
    }
    seen.add(formula.from);
    const reading = raw.reading;
    if (
      typeof reading !== 'string' ||
      reading.trim().length === 0 ||
      reading !== reading.trim() ||
      /[\r\n]/u.test(reading) ||
      codePointLength(reading) > REACH_DECK_FORMULA_READING_MAX_CHARACTERS ||
      /[\\$^_{}<>&]/u.test(reading)
    ) {
      fail(
        'invalid-formula-reading',
        `${label}.reading must be plain single-line speech within ${REACH_DECK_FORMULA_READING_MAX_CHARACTERS} characters without LaTeX or markup.`,
      );
    }
    validateXmlText(reading, `${label}.reading`);
    return { from: formula.from, to: formula.to, reading };
  });
  readings.sort((left, right) => left.from - right.from);
  readings.forEach((reading, index) => {
    if (index > 0 && readings[index - 1]!.to > reading.from) {
      fail('invalid-formula-reading', 'Formula readings cannot overlap.');
    }
  });
  return readings;
}

/**
 * A plain-text expression range: one line of plain narration outside every delimited formula,
 * on legal boundaries, without surrounding whitespace, and containing at least one character that
 * is neither Han nor punctuation, so a reading never replaces ordinary prose.
 */
function plainFormulaReadingRange(
  canonical: string,
  rawFrom: unknown,
  rawTo: unknown,
  formulas: readonly ReachDeckMarkdownRangeV1[],
  label: string,
): ReachDeckMarkdownRangeV1 {
  const invalid = (): never =>
    fail(
      'invalid-formula-reading',
      `${label} must cover exactly one narration formula or one plain-text expression.`,
    );
  if (
    !Number.isSafeInteger(rawFrom) ||
    !Number.isSafeInteger(rawTo) ||
    (rawFrom as number) < 0 ||
    (rawTo as number) > canonical.length ||
    (rawFrom as number) >= (rawTo as number)
  ) {
    return invalid();
  }
  const range = { from: rawFrom as number, to: rawTo as number };
  if (
    !isBaseBoundary(canonical, range.from) ||
    !isBaseBoundary(canonical, range.to) ||
    formulas.some((formula) => rangesIntersect(range, formula))
  ) {
    return invalid();
  }
  const visible = decodePlainMarkdown(canonical.slice(range.from, range.to));
  if (
    visible !== visible.trim() ||
    /[\r\n]/u.test(visible) ||
    !/[^\p{Script=Han}\p{P}\s]/u.test(visible)
  ) {
    return invalid();
  }
  return range;
}

function speechUnits(
  markdown: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
  options?: ReachDeckSpeechSynthesisOptionsV1,
): SpeechUnit[] {
  const canonical = canonicalMarkdown(markdown);
  validateXmlText(canonical, 'Narration markdown');
  const markup = parseOptionalMarkup(speechMarkup, canonical);
  const readings =
    options?.formulaReadings === undefined
      ? []
      : parseReachDeckFormulaReadingsV1(canonical, options.formulaReadings);
  const readingByFrom = new Map(
    readings.map((reading) => [reading.from, reading.reading] as const),
  );
  const formulas = reachDeckNarrationFormulaRanges(canonical);
  const spans = markup.marks.filter(isSpanMark);
  const points = markup.marks.filter(isPointMark);
  const formulaByFrom = new Map(formulas.map((range) => [range.from, range]));
  // Plain-text expression readings yield to the teacher's speech marks: such a span keeps the
  // marked reading and is spoken as written.
  const plainReadingByFrom = new Map(
    readings
      .filter(
        (reading) =>
          !formulaByFrom.has(reading.from) &&
          !spans.some((mark) => rangesIntersect(mark, reading)) &&
          !points.some((mark) => pointInside(mark.at, reading)),
      )
      .map((reading) => [reading.from, reading] as const),
  );
  const spanByFrom = new Map(spans.map((mark) => [mark.from, mark]));
  const pointsByAt = new Map<number, ReachDeckPointSpeechMarkV1[]>();
  for (const mark of points) {
    const at = pointsByAt.get(mark.at) ?? [];
    at.push(mark);
    pointsByAt.set(mark.at, at);
  }

  const units: SpeechUnit[] = [];
  let cursor = 0;
  while (cursor <= canonical.length) {
    for (const mark of pointsByAt.get(cursor) ?? []) {
      units.push(pointUnit(mark));
    }
    if (cursor === canonical.length) break;
    const span = spanByFrom.get(cursor);
    if (span !== undefined) {
      const visible = decodePlainMarkdown(canonical.slice(span.from, span.to));
      units.push(spanUnit(span, visible));
      cursor = span.to;
      continue;
    }
    const formula = formulaByFrom.get(cursor);
    if (formula !== undefined) {
      const source = canonical.slice(formula.from, formula.to);
      // A supplied reading replaces only what is spoken; the visible unit stays the formula source.
      const spoken = readingByFrom.get(formula.from) ?? source;
      units.push({
        kind: 'formula',
        markdownFrom: formula.from,
        markdownTo: formula.to,
        visibleText: source,
        spokenText: spoken,
        ssml: escapeSsmlText(spoken),
        atomic: true,
      });
      cursor = formula.to;
      continue;
    }
    const plain = plainReadingByFrom.get(cursor);
    if (plain !== undefined) {
      units.push({
        kind: 'formula',
        markdownFrom: plain.from,
        markdownTo: plain.to,
        visibleText: decodePlainMarkdown(canonical.slice(plain.from, plain.to)),
        spokenText: plain.reading,
        ssml: escapeSsmlText(plain.reading),
        atomic: true,
      });
      cursor = plain.to;
      continue;
    }
    const sourceWidth = canonical[cursor] === '\\' ? 2 : codePointWidthAt(canonical, cursor);
    const source = canonical.slice(cursor, cursor + sourceWidth);
    const visible = decodePlainMarkdown(source);
    units.push({
      kind: 'text',
      markdownFrom: cursor,
      markdownTo: cursor + sourceWidth,
      visibleText: visible,
      spokenText: visible,
      ssml: escapeSsmlText(visible),
      atomic: false,
    });
    cursor += sourceWidth;
  }
  return units;
}

function pointUnit(mark: ReachDeckPointSpeechMarkV1): SpeechUnit {
  return {
    kind: mark.type,
    markdownFrom: mark.at,
    markdownTo: mark.at,
    visibleText: '',
    spokenText: '',
    ssml:
      mark.type === 'break'
        ? `<break time="${mark.durationMs}ms"/>`
        : `<soundEvent src="${escapeXmlAttribute(mark.src)}"/>`,
    atomic: true,
  };
}

function spanUnit(mark: ReachDeckSpanSpeechMarkV1, visible: string): SpeechUnit {
  if (mark.type === 'sub') {
    return {
      kind: mark.type,
      markdownFrom: mark.from,
      markdownTo: mark.to,
      visibleText: visible,
      spokenText: mark.alias,
      ssml: `<sub alias="${escapeXmlAttribute(mark.alias)}">${escapeSsmlText(visible)}</sub>`,
      atomic: true,
    };
  }
  if (mark.type === 'say-as') {
    return {
      kind: mark.type,
      markdownFrom: mark.from,
      markdownTo: mark.to,
      visibleText: visible,
      spokenText: visible,
      ssml: `<say-as interpret-as="${mark.interpretAs}">${escapeSsmlText(visible)}</say-as>`,
      atomic: true,
    };
  }
  return {
    kind: mark.type,
    markdownFrom: mark.from,
    markdownTo: mark.to,
    visibleText: visible,
    spokenText: visible,
    ssml: `<phoneme alphabet="${mark.alphabet}" ph="${escapeXmlAttribute(mark.ph)}">${escapeSsmlText(visible)}</phoneme>`,
    atomic: true,
  };
}

function projectionFromUnits(units: readonly SpeechUnit[]): ReachDeckSpeechProjectionV1 {
  let visibleText = '';
  let alignmentTranscript = '';
  const alignmentMap: ReachDeckSpeechAlignmentMapEntryV1[] = [];
  for (const unit of units) {
    const spokenFrom = alignmentTranscript.length;
    visibleText += unit.visibleText;
    alignmentTranscript += unit.spokenText;
    const entry: ReachDeckSpeechAlignmentMapEntryV1 = {
      kind: unit.kind,
      markdownFrom: unit.markdownFrom,
      markdownTo: unit.markdownTo,
      spokenFrom,
      spokenTo: alignmentTranscript.length,
      atomic: unit.atomic,
    };
    const previous = alignmentMap.at(-1);
    if (
      previous !== undefined &&
      previous.kind === 'text' &&
      entry.kind === 'text' &&
      previous.markdownTo === entry.markdownFrom &&
      previous.spokenTo === entry.spokenFrom &&
      previous.markdownTo - previous.markdownFrom === previous.spokenTo - previous.spokenFrom &&
      entry.markdownTo - entry.markdownFrom === entry.spokenTo - entry.spokenFrom
    ) {
      previous.markdownTo = entry.markdownTo;
      previous.spokenTo = entry.spokenTo;
    } else {
      alignmentMap.push(entry);
    }
  }
  return { visibleText, alignmentTranscript, alignmentMap };
}

function visibleMapFromUnits(units: readonly SpeechUnit[]): ReachDeckSpeechVisibleMapEntryV1[] {
  let visibleCursor = 0;
  return units.map((unit) => {
    const entry = {
      markdownFrom: unit.markdownFrom,
      markdownTo: unit.markdownTo,
      visibleFrom: visibleCursor,
      visibleTo: visibleCursor + unit.visibleText.length,
    };
    visibleCursor = entry.visibleTo;
    return entry;
  });
}

function parseOptionalMarkup(
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
  markdown: string,
): ReachDeckSpeechMarkupV1 {
  return speechMarkup === undefined
    ? { schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION, marks: [] }
    : parseReachDeckSpeechMarkupV1(speechMarkup, markdown);
}

function sourceRange(
  mark: UnknownRecord,
  markdown: string,
  label: string,
): ReachDeckMarkdownRangeV1 {
  const from = sourceOffset(mark.from, markdown.length, `${label}.from`);
  const to = sourceOffset(mark.to, markdown.length, `${label}.to`);
  if (from >= to) fail('invalid-range', `${label} must use a non-empty [from, to) range.`);
  assertBaseBoundary(markdown, from, `${label}.from`);
  assertBaseBoundary(markdown, to, `${label}.to`);
  return { from, to };
}

function decodedPlainSource(markdown: string, from: number, to: number, label: string): string {
  if (
    reachDeckNarrationFormulaRanges(markdown).some((range) => rangesIntersect({ from, to }, range))
  ) {
    fail('formula-intersection', `${label} cannot intersect a formula.`);
  }
  return decodePlainMarkdown(markdown.slice(from, to));
}

function assertSingleLinePlainText(value: string, label: string): void {
  if (value.trim().length === 0 || /[\r\n]/u.test(value)) {
    fail('invalid-range', `${label} must select non-empty text on one line.`);
  }
  validateXmlText(value, label);
}

function boundedAttribute(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    fail('invalid-attribute', `${label} must be a non-empty canonical string.`);
  }
  if (codePointLength(value) > MAX_ATTRIBUTE_CODE_POINTS) {
    fail('invalid-attribute', `${label} exceeds ${MAX_ATTRIBUTE_CODE_POINTS} Unicode code points.`);
  }
  validateXmlText(value, label);
  return value;
}

function httpUrl(value: unknown, label: string): string {
  const source = boundedAttribute(value, label);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    fail('invalid-attribute', `${label} must be an absolute HTTP or HTTPS URL.`);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    fail(
      'invalid-attribute',
      `${label} must be an HTTP or HTTPS URL without credentials or a fragment.`,
    );
  }
  return source;
}

function canonicalMarkdown(markdown: string): string {
  if (typeof markdown !== 'string') fail('invalid-range', 'Narration markdown must be a string.');
  const canonical = normalizeReachDeckNarrationMarkdown(markdown);
  if (canonical !== markdown) {
    fail('invalid-range', 'Speech mark offsets require canonical narration Markdown.');
  }
  return canonical;
}

function compareMarks(left: ReachDeckSpeechMarkV1, right: ReachDeckSpeechMarkV1): number {
  const leftStart = isPointMark(left) ? left.at : left.from;
  const rightStart = isPointMark(right) ? right.at : right.from;
  if (leftStart !== rightStart) return leftStart - rightStart;
  const order: Record<ReachDeckSpeechMarkV1['type'], number> = {
    break: 0,
    soundEvent: 1,
    phoneme: 2,
    'say-as': 3,
    sub: 4,
  };
  return order[left.type] - order[right.type];
}

function isSpanMark(mark: ReachDeckSpeechMarkV1): mark is ReachDeckSpanSpeechMarkV1 {
  return !isPointMark(mark);
}

function isPointMark(mark: ReachDeckSpeechMarkV1): mark is ReachDeckPointSpeechMarkV1 {
  return mark.type === 'break' || mark.type === 'soundEvent';
}

function isPointSpeechUnit(unit: SpeechUnit): boolean {
  return unit.kind === 'break' || unit.kind === 'soundEvent';
}

function isBaseBoundary(markdown: string, at: number): boolean {
  if (at < 0 || at > markdown.length) return false;
  if (at > 0 && at < markdown.length) {
    const previous = markdown.charCodeAt(at - 1);
    const next = markdown.charCodeAt(at);
    if (isHighSurrogate(previous) && isLowSurrogate(next)) return false;
    if (isMarkdownEscapeOpener(markdown, at - 1)) return false;
  }
  return true;
}

function assertBaseBoundary(markdown: string, at: number, label: string): void {
  if (!isBaseBoundary(markdown, at)) {
    fail('invalid-boundary', `${label} splits a Unicode scalar or Markdown escape pair.`);
  }
}

function sourceOffset(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail('invalid-range', `${label} must be a valid canonical Markdown UTF-16 offset.`);
  }
  return value as number;
}

function integerInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('invalid-attribute', `${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function validateXmlText(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (index + 1 >= value.length || !isLowSurrogate(value.charCodeAt(index + 1))) {
        fail('invalid-unicode', `${label} contains an unpaired surrogate.`);
      }
      index += 1;
      continue;
    }
    if (isLowSurrogate(code)) fail('invalid-unicode', `${label} contains an unpaired surrogate.`);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      fail('invalid-unicode', `${label} contains a character XML 1.0 cannot represent.`);
    }
  }
}

function decodePlainMarkdown(source: string): string {
  let result = '';
  for (let cursor = 0; cursor < source.length; ) {
    if (source[cursor] === '\\' && cursor + 1 < source.length) {
      result += source[cursor + 1];
      cursor += 2;
    } else {
      const width = codePointWidthAt(source, cursor);
      result += source.slice(cursor, cursor + width);
      cursor += width;
    }
  }
  return result;
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeSsmlText(value: string): string {
  // Provider text newlines can weaken explicit breaks. Preserve their width and word separation,
  // while keeping source/alignment whitespace and XML attribute values unchanged.
  return escapeXmlText(value).replace(/[\r\n]/g, ' ');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function wrapSpeak(content: string, speak?: ReachDeckSpeakOptionsV1): string {
  const attributes = [
    ...(speak?.bgm === undefined ? [] : [`bgm="${escapeXmlAttribute(speak.bgm)}"`]),
    ...(speak?.backgroundMusicVolume === undefined
      ? []
      : [`backgroundMusicVolume="${speak.backgroundMusicVolume}"`]),
    ...(speak?.effect === undefined ? [] : [`effect="${speak.effect}"`]),
  ];
  return `<speak${attributes.length === 0 ? '' : ` ${attributes.join(' ')}`}>${content}${SPEAK_CLOSE}`;
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-schema', `${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    fail('invalid-schema', `${label} must contain exactly: ${required.join(', ')}.`);
  }
}

function rangesIntersect(left: ReachDeckMarkdownRangeV1, right: ReachDeckMarkdownRangeV1): boolean {
  return left.from < right.to && right.from < left.to;
}

function pointInside(at: number, range: ReachDeckMarkdownRangeV1): boolean {
  return at > range.from && at < range.to;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function codePointWidthAt(value: string, at: number): number {
  const code = value.charCodeAt(at);
  return isHighSurrogate(code) && at + 1 < value.length && isLowSurrogate(value.charCodeAt(at + 1))
    ? 2
    : 1;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isMarkdownEscapeOpener(markdown: string, at: number): boolean {
  if (markdown[at] !== '\\') return false;
  let precedingBackslashes = 0;
  for (let index = at - 1; index >= 0 && markdown[index] === '\\'; index -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 0;
}

function fail(code: ReachDeckSpeechMarkupErrorCode, message: string): never {
  throw new ReachDeckSpeechMarkupError(code, message);
}
