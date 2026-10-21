import { assertInteractiveDocumentHtml } from './interactiveHtmlAudit.js';
import { isInteractiveBlankDocument } from './interactiveBlank.js';
import {
  parseInteractiveRuntimeDependenciesValue,
  type InteractiveRuntimeDependency,
} from './interactiveRuntime.js';
import {
  analyzeReachDeckNarrationMarkdown,
  normalizeReachDeckNarrationMarkdown,
  serializeReachDeckNarrationMarkdown,
} from './narrationMarkdown.js';
import type { RichTextDocument } from './richText.js';
import {
  canonicalizeReachDeckSpeechMarkupV1,
  REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  type ReachDeckSpeechMarkupV1,
} from './speechMarkup.js';

export type InteractiveCompletionMode = 'explicit' | 'automatic' | 'none';
export type InteractiveEventDeliveryIntervalMs = 250 | 500 | 1000 | 2000;

export interface InteractiveRuntimePolicy {
  completionMode: InteractiveCompletionMode;
  allowReset: boolean;
  /** null means the activity has no time limit. */
  maximumDurationSeconds: number | null;
}

interface InteractiveEventPayloadFieldBase {
  name: string;
  required: boolean;
}

export interface InteractiveStringEventPayloadField extends InteractiveEventPayloadFieldBase {
  type: 'string';
  maxLength: number;
  /** An empty array permits any string up to maxLength. */
  enum: string[];
}

export interface InteractiveNumberEventPayloadField extends InteractiveEventPayloadFieldBase {
  type: 'number';
  minimum: number;
  maximum: number;
}

export interface InteractiveIntegerEventPayloadField extends InteractiveEventPayloadFieldBase {
  type: 'integer';
  minimum: number;
  maximum: number;
}

export interface InteractiveBooleanEventPayloadField extends InteractiveEventPayloadFieldBase {
  type: 'boolean';
}

export type InteractiveEventPayloadField =
  | InteractiveStringEventPayloadField
  | InteractiveNumberEventPayloadField
  | InteractiveIntegerEventPayloadField
  | InteractiveBooleanEventPayloadField;

export type InteractiveEventDelivery =
  | { mode: 'immediate' }
  | { mode: 'latest'; intervalMs: InteractiveEventDeliveryIntervalMs };

export interface InteractiveEventDeclaration {
  name: string;
  eventVersion: 1;
  meaning: string;
  payloadFields: InteractiveEventPayloadField[];
  delivery: InteractiveEventDelivery;
}

export interface InteractiveEventManifest {
  schemaVersion: 'reach-interactive-event-manifest/v1';
  events: InteractiveEventDeclaration[];
}

export const REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION =
  'reach-interactive-narration/v1' as const;
export const INTERACTIVE_NARRATION_MAX_TEXT_SCALARS = 600;

export interface ReachDeckInteractiveNarrationV1 {
  schemaVersion: typeof REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION;
  text: string;
  /**
   * 语音标记，偏移锚定在 `reachDeckInteractiveNarrationMarkdown(text)` 上；无标记时省略。
   */
  speechMarkup?: ReachDeckSpeechMarkupV1;
  /** Absent while a draft is waiting for whole-paragraph speech synthesis. */
  audioResourceId?: string;
}

export interface InteractiveScene {
  schemaVersion: 'reach-interactive-scene/v2';
  id: string;
  title: string;
  sceneType: 'interactive';
  documentHtml: string;
  bridgeVersion: 'reach-interactive-bridge/v1';
  runtimePolicy: InteractiveRuntimePolicy;
  eventManifest: InteractiveEventManifest;
  /** Absent only on legacy v2 documents created before the bundled runtime registry. */
  runtimeDependencies?: InteractiveRuntimeDependency[];
  /** Optional for legacy, imported, and intentional-empty Interactive pages. */
  narration?: ReachDeckInteractiveNarrationV1;
}

export const INTERACTIVE_EVENT_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const INTERACTIVE_EVENT_MAX_DECLARATIONS = 12;
export const INTERACTIVE_EVENT_MAX_PAYLOAD_FIELDS = 12;
export const INTERACTIVE_EVENT_MAX_STRING_LENGTH = 200;
export const INTERACTIVE_EVENT_MAX_MEANING_LENGTH = 200;
export const INTERACTIVE_EVENT_MAX_PAYLOAD_BYTES = 4096;
export const INTERACTIVE_EVENT_MIN_NUMBER = -1_000_000_000;
export const INTERACTIVE_EVENT_MAX_NUMBER = 1_000_000_000;

const forbiddenPayloadFieldNames = new Set([
  'answer',
  'answers',
  'attachments',
  'content',
  'document',
  'state',
]);

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const sceneKeys = [
  'schemaVersion',
  'id',
  'title',
  'sceneType',
  'documentHtml',
  'bridgeVersion',
  'runtimePolicy',
  'eventManifest',
];
const policyKeys = ['completionMode', 'allowReset', 'maximumDurationSeconds'];
const manifestKeys = ['schemaVersion', 'events'];
const declarationKeys = ['name', 'eventVersion', 'meaning', 'payloadFields', 'delivery'];
const commonFieldKeys = ['name', 'type', 'required'];
const narrationKeys = ['schemaVersion', 'text'];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactSafeKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => !unsafeKeys.has(key)) &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
};

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isBoundedNumber = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= INTERACTIVE_EVENT_MIN_NUMBER &&
  value <= INTERACTIVE_EVENT_MAX_NUMBER;

const isForbiddenNarrationCodePoint = (codePoint: number): boolean =>
  codePoint <= 0x1f ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  codePoint === 0x2028 ||
  codePoint === 0x2029 ||
  codePoint === 0xfeff;

/** Canonicalize one plain-text Interactive narration paragraph. */
export const canonicalizeInteractiveNarrationText = (text: string): string => {
  if (typeof text !== 'string') {
    throw new Error('Interactive narration text must be a string.');
  }

  let canonical = '';
  let scalarCount = 0;
  let pendingSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const first = text.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = text.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) {
        throw new Error('Interactive narration text must not contain isolated surrogates.');
      }
      codePoint = ((first - 0xd800) << 10) + (second - 0xdc00) + 0x10000;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error('Interactive narration text must not contain isolated surrogates.');
    }

    if (isForbiddenNarrationCodePoint(codePoint)) {
      throw new Error('Interactive narration text must be one plain-text paragraph.');
    }
    if (codePoint === 0x20) {
      pendingSpace = canonical.length > 0;
      continue;
    }
    if (pendingSpace) {
      canonical += ' ';
      scalarCount += 1;
      pendingSpace = false;
    }
    canonical += String.fromCodePoint(codePoint);
    scalarCount += 1;
    if (scalarCount > INTERACTIVE_NARRATION_MAX_TEXT_SCALARS) {
      throw new Error(
        `Interactive narration text cannot exceed ${INTERACTIVE_NARRATION_MAX_TEXT_SCALARS} Unicode scalar values.`,
      );
    }
  }

  if (canonical.length === 0) {
    throw new Error('Interactive narration text cannot be empty.');
  }
  return canonical;
};

/** 单段落：恰好一个 paragraph，且不含硬换行与块级公式。 */
const singleParagraph = (doc: RichTextDocument) => {
  const blocks = doc.content ?? [];
  const paragraph = blocks.length === 1 ? blocks[0] : undefined;
  if (paragraph?.type !== 'paragraph') return undefined;
  const inline = paragraph.content ?? [];
  return inline.some((node) => node.type === 'hardBreak') ? undefined : inline;
};

/**
 * Interactive 讲稿文本 → 规范 Narration Markdown（单段落）。
 * 文本本身已是规范单段落 Markdown 时按 Markdown 解释并原样返回，否则作为纯文本转义序列化。
 * 语音标记偏移、试听选区与带标记的 digest 都锚定在该结果上。
 * 无法用讲稿 Markdown 方言表达的纯文本（如以 `1. ` 开头、`[a](b)` 链接形态）会抛错。
 */
export const reachDeckInteractiveNarrationMarkdown = (text: string): string => {
  const canonicalText = canonicalizeInteractiveNarrationText(text);
  try {
    const analysis = analyzeReachDeckNarrationMarkdown(canonicalText);
    if (analysis.markdown === canonicalText && singleParagraph(analysis.doc) !== undefined) {
      return canonicalText;
    }
  } catch {
    // 不是规范 Markdown：按纯文本处理。
  }
  const markdown = serializeReachDeckNarrationMarkdown({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: canonicalText }] }],
  });
  try {
    if (normalizeReachDeckNarrationMarkdown(markdown) === markdown) return markdown;
  } catch {
    // 落到下方统一报错。
  }
  throw new Error('Interactive narration text cannot be represented as narration Markdown.');
};

/**
 * 编辑器产出的规范单段落 Narration Markdown → Interactive 讲稿 `text`。
 * 含行内公式时保留 Markdown；否则取解码后的纯文本，若它不能精确映射回原 Markdown（例如字面量
 * `\\(`），回退为 Markdown 本身。结果再做 Interactive 文本规范化（折叠 U+0020），因此只有空白
 * 已规范的 Markdown 满足 `reachDeckInteractiveNarrationMarkdown(结果) === markdown`。
 */
export const reachDeckInteractiveNarrationTextFromMarkdown = (markdown: string): string => {
  const analysis = analyzeReachDeckNarrationMarkdown(markdown);
  if (analysis.markdown !== markdown) {
    throw new Error('Interactive narration markdown must be canonical narration Markdown.');
  }
  const inline = singleParagraph(analysis.doc);
  if (inline === undefined) {
    throw new Error(
      'Interactive narration markdown must be one paragraph without line breaks or block formulas.',
    );
  }
  if (inline.some((node) => node.type === 'inlineMath')) {
    return canonicalizeInteractiveNarrationText(markdown);
  }
  const plain = inline.map((node) => node.text ?? '').join('');
  let representsMarkdown = false;
  try {
    representsMarkdown = reachDeckInteractiveNarrationMarkdown(plain) === markdown;
  } catch {
    representsMarkdown = false;
  }
  return canonicalizeInteractiveNarrationText(representsMarkdown ? plain : markdown);
};

/** 形状合法的空标记：仅 schemaVersion 与空 marks，无 speak。 */
const isEmptySpeechMarkupValue = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactSafeKeys(value, ['schemaVersion', 'marks']) &&
  value.schemaVersion === REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION &&
  Array.isArray(value.marks) &&
  value.marks.length === 0;

/** 规范化 Interactive 讲稿的语音标记；空标记（无 marks 且无 speak）返回 undefined。 */
const canonicalizeInteractiveNarrationSpeechMarkup = (
  text: string,
  speechMarkup: unknown,
): ReachDeckSpeechMarkupV1 | undefined => {
  if (isEmptySpeechMarkupValue(speechMarkup)) return undefined;
  return canonicalizeReachDeckSpeechMarkupV1(
    speechMarkup,
    reachDeckInteractiveNarrationMarkdown(text),
  );
};

/**
 * Versioned SHA-256 input shared by Interactive narration producers and landing checks.
 * 无标记（或空标记）时与历史输入逐字节相同；有标记时以 `\0` 追加规范化标记的 JSON。
 */
export const reachDeckInteractiveNarrationContentDigestInput = (
  text: string,
  speechMarkup?: ReachDeckSpeechMarkupV1,
): string => {
  const canonicalText = canonicalizeInteractiveNarrationText(text);
  const base = `${REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION}\n${canonicalText}`;
  const markup =
    speechMarkup === undefined
      ? undefined
      : canonicalizeInteractiveNarrationSpeechMarkup(canonicalText, speechMarkup);
  return markup === undefined ? base : `${base}\0${JSON.stringify(markup)}`;
};

export const parseInteractiveNarrationValue = (input: unknown): ReachDeckInteractiveNarrationV1 => {
  if (!isRecord(input)) {
    throw new Error('AI provider returned invalid Interactive narration.');
  }
  const hasSpeechMarkup = Object.hasOwn(input, 'speechMarkup');
  const hasAudioResourceId = Object.hasOwn(input, 'audioResourceId');
  if (
    !hasExactSafeKeys(input, [
      ...narrationKeys,
      ...(hasSpeechMarkup ? ['speechMarkup'] : []),
      ...(hasAudioResourceId ? ['audioResourceId'] : []),
    ]) ||
    input.schemaVersion !== REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION ||
    (hasAudioResourceId && !isNonEmptyText(input.audioResourceId))
  ) {
    throw new Error('AI provider returned invalid Interactive narration.');
  }

  const text = canonicalizeInteractiveNarrationText(input.text as string);
  let speechMarkup: ReachDeckSpeechMarkupV1 | undefined;
  if (hasSpeechMarkup) {
    try {
      speechMarkup = canonicalizeInteractiveNarrationSpeechMarkup(text, input.speechMarkup);
    } catch (error) {
      throw new Error(
        `Invalid Interactive narration speechMarkup: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return {
    schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
    text,
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    ...(hasAudioResourceId ? { audioResourceId: input.audioResourceId as string } : {}),
  };
};

/**
 * 一句"invalid payload field"既不指出是哪条事件的哪个字段,也不指出违反了哪条约束,
 * 生成侧只能盲猜重写整页。实测 Decksmith 会因此放弃提交互动页,所以每条校验各自点名。
 */
const describePayloadFieldKeys = (input: Record<string, unknown>): string => {
  const keys = Object.keys(input);
  return keys.length === 0 ? 'no keys' : keys.join(', ');
};

const describeKeys = (input: unknown): string =>
  isRecord(input)
    ? describePayloadFieldKeys(input)
    : Array.isArray(input)
      ? 'an array'
      : (JSON.stringify(input)?.slice(0, 80) ?? String(input));

const describeEventDeclarationViolation = (
  candidate: unknown,
  seenNames: ReadonlySet<string>,
): string | undefined => {
  if (!isRecord(candidate)) return 'each event must be a plain JSON object.';
  if (!hasExactSafeKeys(candidate, declarationKeys)) {
    return `an event declares exactly ${declarationKeys.join(', ')}; received ${describePayloadFieldKeys(candidate)}.`;
  }
  if (!INTERACTIVE_EVENT_IDENTIFIER_PATTERN.test(String(candidate.name))) {
    return `name must match ${INTERACTIVE_EVENT_IDENTIFIER_PATTERN.source}.`;
  }
  if (seenNames.has(candidate.name as string)) return 'event names must be unique.';
  if (candidate.eventVersion !== 1) return 'eventVersion must be the number 1.';
  if (
    !isNonEmptyText(candidate.meaning) ||
    candidate.meaning.length > INTERACTIVE_EVENT_MAX_MEANING_LENGTH
  ) {
    return `meaning must be non-empty text of at most ${INTERACTIVE_EVENT_MAX_MEANING_LENGTH} characters.`;
  }
  if (
    !Array.isArray(candidate.payloadFields) ||
    candidate.payloadFields.length < 1 ||
    candidate.payloadFields.length > INTERACTIVE_EVENT_MAX_PAYLOAD_FIELDS
  ) {
    return `payloadFields must be an array of 1..${INTERACTIVE_EVENT_MAX_PAYLOAD_FIELDS} fields; drop the event instead of declaring it without fields.`;
  }
  return undefined;
};

const parsePayloadField = (input: unknown, eventName: string): InteractiveEventPayloadField => {
  const fail = (reason: string): never => {
    const name = isRecord(input) && typeof input.name === 'string' ? input.name : '(unnamed)';
    throw new Error(
      `AI provider returned invalid Interactive event payload field "${name}" on event "${eventName}": ${reason}`,
    );
  };
  if (!isRecord(input)) return fail('the field must be a plain JSON object.');
  if (!INTERACTIVE_EVENT_IDENTIFIER_PATTERN.test(String(input.name))) {
    return fail(`name must match ${INTERACTIVE_EVENT_IDENTIFIER_PATTERN.source}.`);
  }
  if (forbiddenPayloadFieldNames.has(String(input.name))) {
    return fail(
      `name is reserved; rename it and never use ${[...forbiddenPayloadFieldNames].join(', ')}.`,
    );
  }
  if (typeof input.required !== 'boolean') {
    return fail('required must be declared explicitly as true or false.');
  }
  if (input.type === 'string') {
    if (!hasExactSafeKeys(input, [...commonFieldKeys, 'maxLength', 'enum'])) {
      return fail(
        `a string field declares exactly name, type, required, maxLength, enum; received ${describePayloadFieldKeys(input)}.`,
      );
    }
    if (
      !Number.isInteger(input.maxLength) ||
      (input.maxLength as number) < 1 ||
      (input.maxLength as number) > INTERACTIVE_EVENT_MAX_STRING_LENGTH
    ) {
      return fail(
        `maxLength must be an integer within 1..${INTERACTIVE_EVENT_MAX_STRING_LENGTH}; received ${JSON.stringify(input.maxLength)}.`,
      );
    }
    if (!Array.isArray(input.enum)) {
      return fail('enum must be an array; use [] when any bounded string is valid.');
    }
    if (input.enum.length > 20) {
      return fail(`enum must contain at most 20 members; received ${String(input.enum.length)}.`);
    }
    if (
      input.enum.some(
        (value) =>
          typeof value !== 'string' ||
          value.length === 0 ||
          value.length > (input.maxLength as number),
      )
    ) {
      return fail(
        `every enum member must be a non-empty string of at most maxLength (${String(input.maxLength)}) characters.`,
      );
    }
    if (new Set(input.enum).size !== input.enum.length) {
      return fail('enum members must be unique.');
    }
    return {
      name: input.name as string,
      type: 'string',
      required: input.required,
      maxLength: input.maxLength as number,
      enum: [...input.enum] as string[],
    };
  }
  if (input.type === 'number' || input.type === 'integer') {
    if (!hasExactSafeKeys(input, [...commonFieldKeys, 'minimum', 'maximum'])) {
      return fail(
        `a ${input.type} field declares exactly name, type, required, minimum, maximum; received ${describePayloadFieldKeys(input)}.`,
      );
    }
    if (!isBoundedNumber(input.minimum) || !isBoundedNumber(input.maximum)) {
      return fail(
        `minimum and maximum must be finite numbers within ${String(INTERACTIVE_EVENT_MIN_NUMBER)}..${String(INTERACTIVE_EVENT_MAX_NUMBER)}; received ${JSON.stringify(input.minimum)} and ${JSON.stringify(input.maximum)}.`,
      );
    }
    if (input.minimum > input.maximum) {
      return fail('minimum must not exceed maximum.');
    }
    if (
      input.type === 'integer' &&
      (!Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum))
    ) {
      return fail('an integer field requires integer minimum and maximum.');
    }
    return {
      name: input.name as string,
      type: input.type,
      required: input.required,
      minimum: input.minimum,
      maximum: input.maximum,
    };
  }
  if (input.type === 'boolean') {
    if (!hasExactSafeKeys(input, commonFieldKeys)) {
      return fail(
        `a boolean field declares exactly name, type, required; received ${describePayloadFieldKeys(input)}.`,
      );
    }
    return { name: input.name as string, type: 'boolean', required: input.required };
  }
  return fail(
    `type must be one of string, number, integer, boolean; received ${JSON.stringify(input.type)}.`,
  );
};

const parseDelivery = (input: unknown): InteractiveEventDelivery => {
  if (!isRecord(input)) throw new Error('AI provider returned invalid Interactive event delivery.');
  if (input.mode === 'immediate' && hasExactSafeKeys(input, ['mode'])) return { mode: 'immediate' };
  if (
    input.mode === 'latest' &&
    hasExactSafeKeys(input, ['mode', 'intervalMs']) &&
    [250, 500, 1000, 2000].includes(Number(input.intervalMs))
  ) {
    return {
      mode: 'latest',
      intervalMs: input.intervalMs as InteractiveEventDeliveryIntervalMs,
    };
  }
  throw new Error(
    `AI provider returned invalid Interactive event delivery: use exactly {mode:'immediate'} or {mode:'latest', intervalMs: 250|500|1000|2000}; received ${JSON.stringify(input).slice(0, 120)}.`,
  );
};

export const parseInteractiveEventManifestValue = (input: unknown): InteractiveEventManifest => {
  if (
    !isRecord(input) ||
    !hasExactSafeKeys(input, manifestKeys) ||
    input.schemaVersion !== 'reach-interactive-event-manifest/v1' ||
    !Array.isArray(input.events) ||
    input.events.length > INTERACTIVE_EVENT_MAX_DECLARATIONS
  ) {
    throw new Error(
      `AI provider returned invalid Interactive eventManifest: expected exactly {schemaVersion:'reach-interactive-event-manifest/v1', events:[...]} with at most ${INTERACTIVE_EVENT_MAX_DECLARATIONS} events; received ${describeKeys(input)}.`,
    );
  }
  const seenNames = new Set<string>();
  const events = input.events.map((candidate): InteractiveEventDeclaration => {
    const violation = describeEventDeclarationViolation(candidate, seenNames);
    if (violation !== undefined) {
      const name =
        isRecord(candidate) && typeof candidate.name === 'string' ? candidate.name : '(unnamed)';
      throw new Error(
        `AI provider returned invalid Interactive event declaration "${name}": ${violation}`,
      );
    }
    // 上面的描述函数已覆盖全部约束；这里只为类型收窄。
    if (!isRecord(candidate) || !Array.isArray(candidate.payloadFields)) {
      throw new Error('AI provider returned invalid Interactive event declaration.');
    }
    seenNames.add(candidate.name as string);
    const seenFields = new Set<string>();
    const eventName = candidate.name as string;
    const payloadFields = candidate.payloadFields.map((field) => {
      const parsed = parsePayloadField(field, eventName);
      if (seenFields.has(parsed.name)) {
        throw new Error(
          `AI provider returned duplicate Interactive event payload field "${parsed.name}" on event "${eventName}".`,
        );
      }
      seenFields.add(parsed.name);
      return parsed;
    });
    return {
      name: candidate.name as string,
      eventVersion: 1,
      meaning: candidate.meaning as string,
      payloadFields,
      delivery: parseDelivery(candidate.delivery),
    };
  });
  return { schemaVersion: 'reach-interactive-event-manifest/v1', events };
};

/**
 * 只报"invalid runtimePolicy"时 Decksmith 无从自纠，实测会连续三次原样重交后放弃整页
 * （测试环境 2026-10-07 第 5 页 GenUI 四次生成全部失败于此）。逐条点名违反的约束。
 */
const describeRuntimePolicyViolation = (input: unknown): string | undefined => {
  if (!isRecord(input)) return 'runtimePolicy must be a plain JSON object.';
  if (!hasExactSafeKeys(input, policyKeys)) {
    return `runtimePolicy declares exactly ${policyKeys.join(', ')}; received ${describeKeys(input)}.`;
  }
  if (!['explicit', 'automatic', 'none'].includes(String(input.completionMode))) {
    return `completionMode must be explicit, automatic, or none; received ${JSON.stringify(input.completionMode)}.`;
  }
  if (typeof input.allowReset !== 'boolean') return 'allowReset must be true or false.';
  if (
    input.maximumDurationSeconds !== null &&
    (typeof input.maximumDurationSeconds !== 'number' ||
      !Number.isInteger(input.maximumDurationSeconds) ||
      input.maximumDurationSeconds < 1 ||
      input.maximumDurationSeconds > 3600)
  ) {
    return `maximumDurationSeconds must be null or an integer within 1..3600; received ${JSON.stringify(input.maximumDurationSeconds)}.`;
  }
  return undefined;
};

export const parseInteractiveRuntimePolicyValue = (input: unknown): InteractiveRuntimePolicy => {
  const violation = describeRuntimePolicyViolation(input);
  if (violation !== undefined || !isRecord(input)) {
    throw new Error(`AI provider returned invalid Interactive runtimePolicy: ${violation}`);
  }
  return {
    completionMode: input.completionMode as InteractiveCompletionMode,
    allowReset: input.allowReset as boolean,
    maximumDurationSeconds: input.maximumDurationSeconds as number | null,
  };
};

export const parseInteractiveSceneValue = (
  input: unknown,
  expectedPageId?: string,
): InteractiveScene => {
  if (
    !isRecord(input) ||
    !hasExactSafeKeys(input, [
      ...sceneKeys,
      ...(Object.hasOwn(input, 'runtimeDependencies') ? ['runtimeDependencies'] : []),
      ...(Object.hasOwn(input, 'narration') ? ['narration'] : []),
    ]) ||
    input.schemaVersion !== 'reach-interactive-scene/v2' ||
    !isNonEmptyText(input.id) ||
    !isNonEmptyText(input.title) ||
    input.sceneType !== 'interactive' ||
    typeof input.documentHtml !== 'string' ||
    input.bridgeVersion !== 'reach-interactive-bridge/v1' ||
    (expectedPageId !== undefined && input.id !== expectedPageId)
  ) {
    throw new Error('AI provider returned invalid InteractiveScene.');
  }
  const runtimePolicy = parseInteractiveRuntimePolicyValue(input.runtimePolicy);
  const eventManifest = parseInteractiveEventManifestValue(input.eventManifest);
  const runtimeDependencies = Object.hasOwn(input, 'runtimeDependencies')
    ? parseInteractiveRuntimeDependenciesValue(input.runtimeDependencies)
    : undefined;
  const narration = Object.hasOwn(input, 'narration')
    ? parseInteractiveNarrationValue(input.narration)
    : undefined;
  assertInteractiveDocumentHtml(input.documentHtml);
  if (narration !== undefined && isInteractiveBlankDocument(input.documentHtml)) {
    throw new Error('Intentional-empty Interactive scenes must not provide narration.');
  }
  return {
    schemaVersion: 'reach-interactive-scene/v2',
    id: input.id,
    title: input.title,
    sceneType: 'interactive',
    documentHtml: input.documentHtml,
    bridgeVersion: 'reach-interactive-bridge/v1',
    runtimePolicy,
    eventManifest,
    ...(runtimeDependencies === undefined ? {} : { runtimeDependencies }),
    ...(narration === undefined ? {} : { narration }),
  };
};
