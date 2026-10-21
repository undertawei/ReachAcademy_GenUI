import {
  isEntranceAnimationPresetName,
  normalizeReachDeckNarrationMarkdown,
  parseRestrictedMarkdown,
  type RichTextDocument,
  type RichTextNode,
  type EntranceAnimationPresetName,
} from '@reachany/reach-deck-dsl';

import type { NarrationStageSegment } from './slide-model-output.js';
import { canonicalizeGeneratedMathDelimiters } from './model-markdown.js';

const MAX_CUES = 8;
const MAX_SEGMENTS_PER_CUE = 16;
const MAX_SEGMENTS_PER_PAGE = 64;

// Match production-workflow narration, not ordinary instructional discussion of these subjects.
const GENERATED_NARRATION_META_PATTERNS: readonly RegExp[] = [
  /(?:(?:这一页|本页|当前页).{0,4})?(?:先|首先)(?:确认|核对|检查).{0,8}作者.{0,16}(?:再|然后)(?:生成|撰写|组织).{0,6}(?:讲稿|旁白)/u,
  /(?:作为\s*(?:AI|人工智能|语言模型|模型助手|AI\s*助手)|(?:AI|人工智能|语言模型|模型助手|AI\s*助手|系统助手)\s*(?:需要|应该|将|会|正在|准备|打算)).{0,24}(?:分析|检查|确认|规划|生成|撰写|输出|处理|读取)/iu,
  /我(?:需要|应该|将|会|正在|准备|打算)?(?:先|首先)?(?:分析|检查|确认|规划|处理|读取).{0,16}(?:本页|页面|素材|源材料|参考材料|PDF|文件|提示词|指令|上下文|附件).{0,20}(?:再|然后).{0,8}(?:生成|撰写|输出|组织).{0,6}(?:讲稿|旁白)/iu,
  /我(?:需要|应该|将|会|正在|准备|打算)?(?:先|首先)?(?:生成|撰写|输出|组织).{0,8}(?:本页|这一页|页面)?(?:讲稿|旁白)/u,
  /(?:根据|按照|遵循|满足).{0,12}(?:系统提示词|系统指令|用户提示词|用户指令|开发者指令|原始提示词|prompt)/iu,
  /(?:不能|不要|不得).{0,8}(?:透露|展示|输出).{0,8}(?:系统提示词|内部指令|思考过程)/u,
  /(?:AI|人工智能|语言模型|模型助手|AI\s*助手|系统助手).{0,12}(?:后台|内部|隐藏)(?:检查|核对|验证|校验)/iu,
  /(?:内部检查|隐藏检查|隐藏指令|隐藏要求).{0,16}(?:输出|提示词|指令|要求)/u,
  /\b(?:as an ai|as a language model|the system prompt|hidden instructions?|internal (?:check|reasoning|plan)|i (?:need to|will) (?:analy[sz]e|check|inspect|process) (?:the )?(?:prompt|source|upload|page))\b/i,
];

class GeneratedNarrationMetaInstructionError extends Error {
  readonly code = 'narration-meta-instruction' as const;

  constructor() {
    super('Generated narration must not contain internal planning or source-processing narration.');
    this.name = 'GeneratedNarrationMetaInstructionError';
  }
}

interface TemporaryNarrationSegment {
  script: string;
  revealElementIds: string[];
  revealEffect?: EntranceAnimationPresetName;
  scientificAnchorId?: string;
}

interface TemporaryNarrationCue {
  segments: TemporaryNarrationSegment[];
}

export interface NarrationRevealRange {
  start: number;
  end: number;
  revealElementIds: string[];
  revealEffect?: EntranceAnimationPresetName;
}

/** Temporary segment ranges compiled to durable animation anchors after TTS. */
export interface TimedNarrationReveal {
  start: number;
  revealElementIds: string[];
  revealEffect?: EntranceAnimationPresetName;
}

export interface NarrationScientificAnchorRange {
  elementId: string;
  anchorId: string;
  start: number;
  end: number;
}

export interface CompiledNarrationStructure {
  markdown: string;
  cues: NarrationStageSegment[];
  revealRanges: NarrationRevealRange[];
  /** Explicitly static targets whose previous narration entrances must be removed on preserve. */
  persistentElementIds?: string[];
  scientificAnchorRanges?: NarrationScientificAnchorRange[];
}

export interface GeneratedNarrationMarkdownNormalization {
  inputCodePoints: number;
  outputCodePoints: number;
  diagnostics: readonly string[];
}

export function compileGeneratedNarrationStructure(
  value: unknown,
  allowedElementIds: ReadonlySet<string>,
  allowedScientificAnchors: ReadonlyMap<string, string> = new Map(),
  onMarkdownNormalized?: (result: GeneratedNarrationMarkdownNormalization) => void,
): CompiledNarrationStructure {
  const temporary = parseTemporaryNarration(value, allowedElementIds, allowedScientificAnchors);
  const source = temporary.map(cueText).join('');
  assertLearnerFacingGeneratedNarration(source);
  const raw = canonicalizeGeneratedMathDelimiters(source);
  const protectedRaw = protectNarrationLiteralAsterisks(raw);
  const restricted = parseRestrictedMarkdown(protectedRaw);
  const markdown = normalizeReachDeckNarrationMarkdown(
    restrictedMarkdownToNarrationText(restricted.doc).replace(/\uE002/gu, '\\*'),
  );
  if (markdown !== raw || restricted.diagnostics.length > 0) {
    onMarkdownNormalized?.({
      inputCodePoints: [...raw].length,
      outputCodePoints: [...markdown].length,
      diagnostics: restricted.diagnostics,
    });
  }
  return projectTemporaryNarration(temporary, markdown, allowedScientificAnchors);
}

function protectNarrationLiteralAsterisks(markdown: string): string {
  // Short variable/numeric products and powers must not become Markdown emphasis.
  return markdown.replace(
    /(?<![\w\\])(?:\d+(?:\.\d+)?|[A-Za-z])(?:(?:\*{1,2}|[ \t]+\*{1,2}[ \t]+)(?:\d+(?:\.\d+)?|[A-Za-z]))+(?!\w)/gu,
    (product) => product.replace(/\*/gu, '\uE002'),
  );
}

/** Keep speech boundaries while removing unsupported formatting from generated Markdown. */
function restrictedMarkdownToNarrationText(document: RichTextDocument): string {
  return (document.content ?? [])
    .map(flattenNarrationNode)
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function flattenNarrationNode(node: RichTextNode): string {
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'inlineMath' || node.type === 'mathInline') {
    return formulaText(node, '\\(', '\\)');
  }
  if (node.type === 'blockMath' || node.type === 'mathBlock') {
    return formulaText(node, '\\[', '\\]');
  }
  const children = (node.content ?? []).map(flattenNarrationNode);
  if (node.type === 'listItem' || node.type === 'bulletList' || node.type === 'orderedList') {
    return children.filter((text) => text.length > 0).join('\n');
  }
  return children.join('');
}

function formulaText(node: RichTextNode, open: string, close: string): string {
  const latex = typeof node.attrs?.latex === 'string' ? node.attrs.latex.trim() : '';
  return latex.length === 0 ? '' : `${open}${latex}${close}`;
}

function assertLearnerFacingGeneratedNarration(markdown: string): void {
  const normalized = markdown.replace(/\s+/gu, ' ');
  if (GENERATED_NARRATION_META_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new GeneratedNarrationMetaInstructionError();
  }
}

export function compileSavedNarrationStructure(
  value: unknown,
  markdown: string,
  allowedElementIds: ReadonlySet<string>,
  allowedScientificAnchors: ReadonlyMap<string, string> = new Map(),
): CompiledNarrationStructure {
  return projectTemporaryNarration(
    parseTemporaryNarration(value, allowedElementIds, allowedScientificAnchors),
    markdown,
    allowedScientificAnchors,
  );
}

export function fallbackNarrationStructure(markdown: string): CompiledNarrationStructure {
  return {
    markdown,
    cues: [{ text: markdown }],
    revealRanges: [],
  };
}

function parseTemporaryNarration(
  value: unknown,
  allowedElementIds: ReadonlySet<string>,
  allowedScientificAnchors: ReadonlyMap<string, string>,
): TemporaryNarrationCue[] {
  if (!isRecord(value) || !Array.isArray(value.cues)) {
    throw new Error('Narration output must contain cues.');
  }
  if (value.cues.length < 1 || value.cues.length > MAX_CUES) {
    throw new Error(`Narration output must contain 1 to ${MAX_CUES} cues.`);
  }
  let segmentCount = 0;
  const revealed = new Set<string>();
  const usedScientificAnchors: string[] = [];
  const parsed = value.cues.map((cue, cueIndex) => {
    if (!isRecord(cue) || !Array.isArray(cue.segments)) {
      throw new Error(`Narration cue ${cueIndex} must contain segments.`);
    }
    if (cue.segments.length < 1 || cue.segments.length > MAX_SEGMENTS_PER_CUE) {
      throw new Error(
        `Narration cue ${cueIndex} must contain 1 to ${MAX_SEGMENTS_PER_CUE} segments.`,
      );
    }
    segmentCount += cue.segments.length;
    if (segmentCount > MAX_SEGMENTS_PER_PAGE) {
      throw new Error(`Narration output may contain at most ${MAX_SEGMENTS_PER_PAGE} segments.`);
    }
    return {
      segments: cue.segments.map((segment, segmentIndex) => {
        if (!isRecord(segment) || typeof segment.script !== 'string') {
          throw new Error(`Narration cue ${cueIndex} segment ${segmentIndex} needs script.`);
        }
        if (segment.script.trim().length === 0) {
          throw new Error(`Narration cue ${cueIndex} segment ${segmentIndex} script is empty.`);
        }
        const ids = Array.isArray(segment.elements)
          ? segment.elements.filter((id): id is string => {
              if (typeof id !== 'string' || !allowedElementIds.has(id) || revealed.has(id)) {
                return false;
              }
              revealed.add(id);
              return true;
            })
          : [];
        const effect = isEntranceAnimationPresetName(segment.effect) ? segment.effect : undefined;
        const scientificAnchorId =
          typeof segment.scientificAnchor === 'string' &&
          allowedScientificAnchors.has(segment.scientificAnchor) &&
          !usedScientificAnchors.includes(segment.scientificAnchor)
            ? segment.scientificAnchor
            : undefined;
        if (typeof segment.scientificAnchor === 'string' && scientificAnchorId === undefined) {
          throw new Error(
            `Narration cue ${cueIndex} segment ${segmentIndex} scientific anchor is invalid or duplicated.`,
          );
        }
        if (scientificAnchorId !== undefined) usedScientificAnchors.push(scientificAnchorId);
        return {
          script: segment.script,
          revealElementIds: ids,
          ...(effect === undefined ? {} : { revealEffect: effect }),
          ...(scientificAnchorId === undefined ? {} : { scientificAnchorId }),
        };
      }),
    };
  });
  const expectedScientificAnchors = [...allowedScientificAnchors.keys()];
  if (
    expectedScientificAnchors.length > 0 &&
    (usedScientificAnchors.length !== expectedScientificAnchors.length ||
      usedScientificAnchors.some(
        (anchorId, index) => anchorId !== expectedScientificAnchors[index],
      ))
  ) {
    throw new Error(
      'Narration scientific anchors must reference every declared anchor exactly once in manifest order.',
    );
  }
  return parsed;
}

function projectTemporaryNarration(
  temporary: readonly TemporaryNarrationCue[],
  markdown: string,
  allowedScientificAnchors: ReadonlyMap<string, string>,
): CompiledNarrationStructure {
  const rawCueLengths = temporary.map((cue) => cueText(cue).length);
  const rawTotal = rawCueLengths.reduce((sum, length) => sum + length, 0);
  if (rawTotal <= 0) {
    if (allowedScientificAnchors.size > 0) {
      throw new Error(
        'Narration scientific anchors could not be projected onto the authoritative Markdown.',
      );
    }
    return fallbackNarrationStructure(markdown);
  }

  const legal = legalNarrationBoundaries(markdown);
  const projectedGroups: Array<{ temporaryEnd: number; boundary: number }> = [
    { temporaryEnd: 0, boundary: 0 },
  ];
  let cumulative = 0;
  for (let index = 0; index < temporary.length - 1; index += 1) {
    cumulative += rawCueLengths[index]!;
    const previous = projectedGroups.at(-1)!.boundary;
    const boundary = nearestUsableBoundary(
      markdown,
      legal,
      (cumulative / rawTotal) * markdown.length,
      previous,
      markdown.length,
    );
    if (boundary !== undefined) {
      projectedGroups.push({ temporaryEnd: index + 1, boundary });
    }
  }
  projectedGroups.push({ temporaryEnd: temporary.length, boundary: markdown.length });

  const cues: NarrationStageSegment[] = [];
  for (let index = 0; index < projectedGroups.length - 1; index += 1) {
    const text = markdown.slice(
      projectedGroups[index]!.boundary,
      projectedGroups[index + 1]!.boundary,
    );
    if (text.trim().length > 0) cues.push({ text });
  }
  if (cues.length === 0 || cues.map((cue) => cue.text).join('') !== markdown) {
    if (allowedScientificAnchors.size > 0) {
      throw new Error(
        'Narration scientific anchors could not be projected onto the authoritative Markdown.',
      );
    }
    return fallbackNarrationStructure(markdown);
  }

  const revealRanges: NarrationRevealRange[] = [];
  const scientificAnchorRanges: NarrationScientificAnchorRange[] = [];
  for (let groupIndex = 0; groupIndex < projectedGroups.length - 1; groupIndex += 1) {
    const group = projectedGroups[groupIndex]!;
    const nextGroup = projectedGroups[groupIndex + 1]!;
    const cueStart = group.boundary;
    const cueEnd = nextGroup.boundary;
    const groupedTemporary = temporary.slice(group.temporaryEnd, nextGroup.temporaryEnd);
    const rawCueTotal = groupedTemporary.reduce((sum, cue) => sum + cueText(cue).length, 0);
    if (rawCueTotal <= 0) continue;
    let rawCueCursor = 0;
    for (const cue of groupedTemporary) {
      for (const segment of cue.segments) {
        const target = cueStart + (rawCueCursor / rawCueTotal) * (cueEnd - cueStart);
        rawCueCursor += segment.script.length;
        if (segment.revealElementIds.length === 0 && segment.scientificAnchorId === undefined) {
          continue;
        }
        const start = nearestBoundary(legal, target, cueStart, Math.max(cueStart, cueEnd - 1));
        if (start === undefined) continue;
        const end = nextBoundaryWithContent(markdown, legal, start);
        if (end === undefined || end > cueEnd) continue;
        if (segment.revealElementIds.length > 0) {
          revealRanges.push({
            start,
            end,
            revealElementIds: segment.revealElementIds,
            ...(segment.revealEffect === undefined ? {} : { revealEffect: segment.revealEffect }),
          });
        }
        if (segment.scientificAnchorId !== undefined) {
          scientificAnchorRanges.push({
            elementId: allowedScientificAnchors.get(segment.scientificAnchorId)!,
            anchorId: segment.scientificAnchorId,
            start,
            end,
          });
        }
      }
    }
  }
  if (
    allowedScientificAnchors.size > 0 &&
    (scientificAnchorRanges.length !== allowedScientificAnchors.size ||
      scientificAnchorRanges.some(
        (range, index) => range.anchorId !== [...allowedScientificAnchors.keys()][index],
      ))
  ) {
    throw new Error(
      'Narration scientific anchors could not be projected onto the authoritative Markdown in manifest order.',
    );
  }
  return {
    markdown,
    cues,
    revealRanges,
    ...(scientificAnchorRanges.length === 0 ? {} : { scientificAnchorRanges }),
  };
}

function cueText(cue: TemporaryNarrationCue): string {
  return cue.segments.map((segment) => segment.script).join('');
}

function legalNarrationBoundaries(markdown: string): number[] {
  const formulas = narrationFormulaRanges(markdown);
  const boundaries: number[] = [];
  for (let index = 0; index <= markdown.length; index += 1) {
    const splitsSurrogate =
      index > 0 &&
      index < markdown.length &&
      isHighSurrogate(markdown.charCodeAt(index - 1)) &&
      isLowSurrogate(markdown.charCodeAt(index));
    const splitsFormula = formulas.some((range) => index > range.start && index < range.end);
    if (!splitsSurrogate && !splitsFormula) boundaries.push(index);
  }
  return boundaries;
}

function nearestUsableBoundary(
  markdown: string,
  legal: readonly number[],
  target: number,
  minimum: number,
  maximum: number,
): number | undefined {
  return [...legal]
    .filter(
      (boundary) =>
        boundary > minimum &&
        boundary < maximum &&
        markdown.slice(minimum, boundary).trim().length > 0 &&
        markdown.slice(boundary, maximum).trim().length > 0,
    )
    .sort((left, right) => Math.abs(left - target) - Math.abs(right - target))[0];
}

function nearestBoundary(
  legal: readonly number[],
  target: number,
  minimum: number,
  maximum: number,
): number | undefined {
  return [...legal]
    .filter((boundary) => boundary >= minimum && boundary <= maximum)
    .sort((left, right) => Math.abs(left - target) - Math.abs(right - target))[0];
}

function nextBoundaryWithContent(
  markdown: string,
  legal: readonly number[],
  start: number,
): number | undefined {
  return legal.find(
    (boundary) => boundary > start && markdown.slice(start, boundary).trim().length > 0,
  );
}

function narrationFormulaRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < markdown.length - 1) {
    if (markdown[cursor] !== '\\') {
      cursor += 1;
      continue;
    }
    const delimiter = markdown[cursor + 1];
    if (delimiter !== '(' && delimiter !== '[') {
      cursor += 2;
      continue;
    }
    const close = delimiter === '(' ? '\\)' : '\\]';
    const closeIndex = markdown.indexOf(close, cursor + 2);
    if (closeIndex < 0) break;
    ranges.push({ start: cursor, end: closeIndex + close.length });
    cursor = closeIndex + close.length;
  }
  return ranges;
}

const isHighSurrogate = (value: number): boolean => value >= 0xd800 && value <= 0xdbff;
const isLowSurrogate = (value: number): boolean => value >= 0xdc00 && value <= 0xdfff;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
