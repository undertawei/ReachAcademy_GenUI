import { createHash } from 'node:crypto';
import {
  QUIZ_QUESTION_TYPES,
  type QuizQuestionOption,
  type RichTextDocument,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';
import {
  WORD_IMPORT_PARSER_VERSION,
  extractWordKnowledgePoints,
  findWordBlankMarkers,
  isWordQuizHeader,
  isWordStructuralLabel,
  sliceSource,
  sourceText,
  wordChoiceAnswerLabels,
  wordChoiceSourceText,
  type WordImportCandidate,
  type WordImportDiagnostic,
  type WordImportPreview,
  type WordOptionReference,
  type WordQuestionReference,
  type WordSourceBlock,
  type WordSourceRange,
} from './contracts.js';
import {
  createWordDiagnostic,
  boundWordDiagnosticMetadata,
  projectWordSourceExcerpts,
  WORD_IMPORT_DIAGNOSTIC_VERSION,
  type DiagnosticCode,
  type FieldTarget,
  type ImportDiagnostic,
  type WordUnresolvedItem,
} from './diagnostics.js';
import { validateWordImportQuestions, wordQuestionHasAnswer } from './validation.js';

const empty = (): RichTextDocument => ({ type: 'doc', content: [{ type: 'paragraph' }] });
const canonicalLabel = (index: number): string => {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label;
};
const paragraphOrBlocks = (nodes: RichTextNode[]): RichTextNode[] => {
  const result: RichTextNode[] = [];
  let inline: RichTextNode[] = [];
  for (const node of nodes) {
    if (node.type === 'table' || node.type === 'blockMath') {
      if (inline.length) result.push({ type: 'paragraph', content: inline });
      inline = [];
      result.push(node);
    } else inline.push(node);
  }
  if (inline.length || !result.length) result.push({ type: 'paragraph', content: inline });
  return result;
};
export const wordImportIdentity = (...parts: string[]): string =>
  `wi-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;

/** Fail closed on malformed references instead of passing them through the coercing native parser. */
export function resolveWordQuestions(
  blocks: WordSourceBlock[],
  references: WordQuestionReference[],
  identity: string,
  config: {
    allowPartialRoots?: boolean;
    omitUnverifiedPoints?: boolean;
    declaredUnassignedBlockIds?: string[];
  } = {},
): WordImportPreview {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  if (byId.size !== blocks.length || blocks.length > 20_000)
    throw new Error('word-import.invalid-blocks');
  const diagnostics: WordImportDiagnostic[] = [];
  const fieldDiagnostics: ImportDiagnostic[] = [],
    unresolvedItems: WordUnresolvedItem[] = [];
  const sources: WordImportPreview['sources'] = {};
  const used = new Set<string>();
  const questionRanges = new Map<string, Array<[number, number]>>();
  let count = 0;
  const range = (ref: WordSourceRange): { block: WordSourceBlock; start: number; end: number } => {
    if (!ref || typeof ref.blockId !== 'string') throw new Error('word-import.invalid-reference');
    const block = byId.get(ref.blockId);
    if (!block) throw new Error('word-import.unknown-block');
    const length = sourceText(block.content).length;
    const start = ref.start ?? 0;
    const end = ref.end ?? length;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > length
    )
      throw new Error('word-import.invalid-range');
    used.add(block.id);
    return { block, start, end };
  };
  const allRanges = (value: unknown): WordSourceRange[] => {
    if (Array.isArray(value)) return value.flatMap(allRanges);
    if (!value || typeof value !== 'object') return [];
    if ('blockId' in value) return [value as WordSourceRange];
    return Object.values(value).flatMap(allRanges);
  };
  // Source/protocol validation is unconditional and finishes before any semantic recovery.
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  let budget = 0;
  const ranges = (v: unknown) => {
    if (!Array.isArray(v)) throw new Error('word-import.invalid-reference');
    for (const r of v) {
      if (!object(r) || Object.keys(r).some((k) => !['blockId', 'start', 'end'].includes(k)))
        throw new Error('word-import.invalid-reference');
      range(r as unknown as WordSourceRange);
    }
  };
  const preOptions = (v: unknown) => {
    if (!Array.isArray(v)) throw new Error('word-import.invalid-question');
    for (const o of v) {
      if (
        !object(o) ||
        typeof o.sourceLabel !== 'string' ||
        Object.keys(o).some((k) => !['sourceLabel', 'label'].includes(k))
      )
        throw new Error('word-import.invalid-question');
      ranges(o.label);
    }
  };
  const preflight = (v: unknown, depth: number) => {
    if (
      !object(v) ||
      ++budget > 2000 ||
      depth > 12 ||
      typeof v.questionType !== 'string' ||
      !Array.isArray(v.children)
    )
      throw new Error('word-import.invalid-question');
    if (
      Object.keys(v).some(
        (k) =>
          ![
            'sourceLabel',
            'questionType',
            'question',
            'answer',
            'analysis',
            'knowledgePoints',
            'points',
            'pointsSource',
            'options',
            'blanks',
            'candidatePoolRepeatable',
            'children',
          ].includes(k),
      )
    )
      throw new Error('word-import.unexpected-question-field');
    for (const key of ['question', 'answer', 'analysis']) ranges(v[key]);
    if (v.knowledgePoints !== undefined) ranges(v.knowledgePoints);
    if (v.pointsSource !== undefined) ranges([v.pointsSource]);
    if (v.options !== undefined) preOptions(v.options);
    if (v.sourceLabel !== undefined && typeof v.sourceLabel !== 'string')
      throw new Error('word-import.invalid-question');
    if (v.blanks !== undefined) {
      if (!Array.isArray(v.blanks)) throw new Error('word-import.invalid-question');
      for (const b of v.blanks) {
        if (
          !object(b) ||
          Object.keys(b).some((k) => !['marker', 'sourceLabel', 'answer', 'candidates'].includes(k))
        )
          throw new Error('word-import.invalid-question');
        ranges([b.marker]);
        ranges(b.answer);
        if (b.candidates !== undefined) preOptions(b.candidates);
      }
    }
    v.children.forEach((child) => preflight(child, depth + 1));
  };
  if (!Array.isArray(references)) throw new Error('word-import.invalid-question');
  references.forEach((ref) => preflight(ref, 0));
  used.clear();
  const text = (refs: WordSourceRange[]): string =>
    refs
      .map((ref) => {
        const { block, start, end } = range(ref);
        return sourceText(sliceSource(block.content, start, end));
      })
      .join('\n');
  const doc = (refs: WordSourceRange[]): RichTextDocument => {
    const content: RichTextNode[] = [];
    let blockId: string | undefined;
    let nodes: RichTextNode[] = [];
    const flush = () => {
      if (blockId !== undefined) content.push(...paragraphOrBlocks(nodes));
      nodes = [];
    };
    for (const ref of refs) {
      const { block, start, end } = range(ref);
      if (blockId !== undefined && block.id !== blockId) flush();
      blockId = block.id;
      nodes.push(...sliceSource(block.content, start, end));
    }
    flush();
    return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
  };
  const validateOptions = (refs: WordOptionReference[]): void => {
    if (
      refs.length > 26 ||
      new Set(refs.map((ref) => ref.sourceLabel.toUpperCase())).size !== refs.length
    )
      throw new Error('word-import.invalid-options');
  };
  const options = (refs: WordOptionReference[], owner = ''): QuizQuestionOption[] => {
    if (!config.allowPartialRoots) validateOptions(refs);
    const duplicateLabels =
      new Set(refs.map((r) => r.sourceLabel.toUpperCase())).size !== refs.length;
    return refs.map((ref, index) => ({
      value: duplicateLabels ? ref.sourceLabel.toUpperCase() : canonicalLabel(index),
      label: doc(ref.label),
      ...(config.allowPartialRoots
        ? {
            wordImportItemId: wordImportIdentity(
              owner,
              'option',
              String(index),
              JSON.stringify(ref.label),
            ),
          }
        : {}),
    }));
  };
  const choices = (refs: WordSourceRange[], pool: WordOptionReference[]): string[] => {
    const values = wordChoiceAnswerLabels(
      refs
        .map((ref) => {
          const { block, start, end } = range(ref);
          return wordChoiceSourceText(sliceSource(block.content, start, end));
        })
        .join('\n'),
    );
    const mapped = values.map((value) =>
      pool.findIndex((option) => option.sourceLabel.toUpperCase() === value),
    );
    if (
      mapped.some((index) => index < 0) ||
      values.some((value) => pool.filter((o) => o.sourceLabel.toUpperCase() === value).length !== 1)
    )
      throw new Error('word-import.invalid-answer-reference');
    const duplicateLabels =
      new Set(pool.map((option) => option.sourceLabel.toUpperCase())).size !== pool.length;
    return [
      ...new Set(
        mapped.map((index) =>
          duplicateLabels ? pool[index].sourceLabel.toUpperCase() : canonicalLabel(index),
        ),
      ),
    ];
  };
  const visit = (
    ref: WordQuestionReference,
    path: number[],
    depth: number,
    ancestorContext: string,
  ): WordImportCandidate => {
    if (++count > 2_000 || depth > 12) throw new Error('word-import.invalid-question');
    if (!QUIZ_QUESTION_TYPES.includes(ref.questionType))
      throw new Error('word-import.unsupported-question-type');
    if (
      !Array.isArray(ref.question) ||
      !Array.isArray(ref.answer) ||
      !Array.isArray(ref.analysis) ||
      (ref.knowledgePoints !== undefined && !Array.isArray(ref.knowledgePoints)) ||
      !Array.isArray(ref.children)
    )
      throw new Error('word-import.invalid-question');
    const id = wordImportIdentity(identity, path.join('.'));
    const emit = (
      code: DiagnosticCode,
      field: FieldTarget,
      refs: WordSourceRange[] = [],
      recovery: ImportDiagnostic['recovery'] = 'retained-source',
      blocking = true,
    ) =>
      fieldDiagnostics.push(
        createWordDiagnostic({
          code,
          severity: blocking ? 'error' : 'info',
          phase: 'parse',
          target: { kind: 'field', questionId: id, field },
          sourceRanges: refs,
          blocksApply: blocking,
          recovery,
        }),
      );
    const issue = (code: string) => diagnostics.push({ code, severity: 'warning', questionId: id });
    let points = ref.points;
    if (points !== undefined) {
      const code =
        !Number.isFinite(points) || points < 0
          ? 'word-import.invalid-points'
          : !ref.pointsSource ||
              typeof ref.pointsSource.blockId !== 'string' ||
              Number(text([ref.pointsSource]).trim()) !== points
            ? 'word-import.unsourced-points'
            : undefined;
      if (code) {
        if (!config.omitUnverifiedPoints) throw new Error(code);
        // A bad score reference must not discard otherwise source-backed questions.
        // Leave correction to the teacher; never infer a score from another numeral.
        points = undefined;
        issue(code);
        emit(code, { kind: 'points' }, ref.pointsSource ? [ref.pointsSource] : [], 'cleared-field');
      }
    }
    if (points === undefined) issue('word-import.missing-points');
    const extractedKnowledgePoints = [...(ref.knowledgePoints ?? [])];
    const questionReferences = ref.question.flatMap((source) => {
      const { block, start, end } = range(source);
      const extracted = extractWordKnowledgePoints(block, start, end);
      extractedKnowledgePoints.push(...extracted.knowledgePoints);
      return extracted.content;
    });
    extractedKnowledgePoints.forEach(range);
    for (const source of questionReferences) {
      const { block, start, end } = range(source);
      const prior = questionRanges.get(block.id) ?? [];
      if (prior.some(([a, b]) => start < b && end > a))
        throw new Error('word-import.duplicated-material');
      prior.push([start, end]);
      questionRanges.set(block.id, prior);
    }
    const question = doc(questionReferences);
    if (!questionReferences.length && !ref.children.length)
      throw new Error('word-import.empty-question');
    const pool = ref.options ?? [];
    if (!config.allowPartialRoots) validateOptions(pool);
    const isChoice = ref.questionType === 'single_choice' || ref.questionType === 'multiple_choice';
    const isFill = ['fill_in_the_blank', 'cloze', 'fill_with_candidates'].includes(
      ref.questionType,
    );
    if (ref.questionType === 'cloze' && pool.length && !config.allowPartialRoots)
      throw new Error('word-import.cloze-root-pool');
    if (
      !isChoice &&
      ref.questionType !== 'fill_with_candidates' &&
      pool.length &&
      !config.allowPartialRoots
    )
      throw new Error('word-import.unexpected-options');
    if (isChoice && pool.length < 2) issue('word-import.missing-options');
    let answer: string[] | RichTextDocument;
    try {
      answer = isChoice ? choices(ref.answer, pool) : isFill ? [] : doc(ref.answer);
      if (ref.questionType === 'single_choice' && Array.isArray(answer) && answer.length > 1)
        throw new Error('word-import.single-answer-count');
    } catch (error) {
      // An invalid answer does not invalidate the source-backed question. Keep it editable,
      // but never infer a replacement answer or relax source-reference validation.
      if (
        !config.allowPartialRoots ||
        !isChoice ||
        !(error instanceof Error) ||
        !['word-import.invalid-answer-reference', 'word-import.single-answer-count'].includes(
          error.message,
        )
      )
        throw error;
      diagnostics.push({
        code: error.message,
        severity: 'error',
        questionId: id,
        sourceAnswer: text(ref.answer),
      });
      emit(error.message as DiagnosticCode, { kind: 'answer' }, ref.answer, 'cleared-field');
      answer = [];
    }
    const candidate: WordImportCandidate = {
      id,
      question_index: path[path.length - 1] + 1,
      question_type: ref.questionType,
      question,
      answer,
      analysis: doc(ref.analysis),
      cognitive_schema: empty(),
      has_answer: isChoice ? (answer as string[]).length > 0 : text(ref.answer).trim().length > 0,
      ...(points === undefined ? {} : { points }),
      ...(isChoice || ref.questionType === 'fill_with_candidates' || pool.length
        ? { options: options(pool, id) }
        : {}),
      sub_problems: [],
    };
    const blankSources: NonNullable<WordImportPreview['sources'][string]['fields']> = [];
    if (ref.questionType === 'fill_with_candidates') {
      if (typeof ref.candidatePoolRepeatable !== 'boolean' && !config.allowPartialRoots)
        throw new Error('word-import.missing-pool-policy');
      candidate.candidate_pool_repeatable = ref.candidatePoolRepeatable;
    }
    if (!isFill && ref.blanks?.length) {
      if (!config.allowPartialRoots) throw new Error('word-import.unexpected-blanks');
      emit('word-import.unexpected-blanks', { kind: 'blanks' }, allRanges(ref.blanks));
      candidate.blanks = [];
    }
    if (ref.questionType !== 'fill_with_candidates' && ref.candidatePoolRepeatable !== undefined)
      candidate.candidate_pool_repeatable = ref.candidatePoolRepeatable;
    if (isFill) {
      const markers = (ref.blanks ?? []).map((blank) => ({ blank, ...range(blank.marker) }));
      const ordered: typeof markers = [];
      for (const source of questionReferences) {
        const { block, start, end } = range(source);
        ordered.push(
          ...markers
            .filter(
              (marker) =>
                marker.block.id === block.id && marker.start >= start && marker.end <= end,
            )
            .sort((a, b) => a.start - b.start),
        );
      }
      if (ordered.length !== markers.length || new Set(ordered).size !== markers.length)
        throw new Error('word-import.blank-outside-question');
      const missingMarker = questionReferences.some((source) => {
        const { block, start, end } = range(source);
        return findWordBlankMarkers(
          block,
          start,
          end,
          `${ancestorContext} ${text(ref.question)}`,
          'required',
        ).some(
          (marker) =>
            !ordered.some((selected) => {
              if (selected.block.id !== marker.blockId) return false;
              if (selected.start === marker.start && selected.end === marker.end) return true;
              // Only a complete blank parenthetical can represent its underlined whitespace interior.
              return (
                selected.start === marker.start! - 1 &&
                selected.end === marker.end! + 1 &&
                /^(?:\([ \u00a0]+\)|（[ \u00a0]+）)$/.test(
                  sourceText(block.content).slice(selected.start, selected.end),
                )
              );
            }),
        );
      });
      if (missingMarker) throw new Error('word-import.missing-blank-reference');
      candidate.blanks = ordered.map((marker, index) => {
        const previous = ordered[index - 1];
        if (
          marker.start === marker.end ||
          (previous?.block.id === marker.block.id && previous.end > marker.start)
        )
          throw new Error('word-import.overlapping-blanks');
        const blankPool = marker.blank.candidates ?? [];
        if (ref.questionType !== 'cloze' && blankPool.length && !config.allowPartialRoots)
          throw new Error('word-import.unexpected-blank-pool');
        if (ref.questionType === 'cloze' && blankPool.length < 2)
          issue('word-import.missing-options');
        const blankId = wordImportIdentity(id, 'blank', String(index));
        blankSources.push(
          {
            field: { kind: 'blanks', blankId, part: 'marker' },
            sourceRanges: [marker.blank.marker],
          },
          { field: { kind: 'blanks', blankId, part: 'answer' }, sourceRanges: marker.blank.answer },
          ...blankPool.map((option, i) => ({
            field: {
              kind: 'blanks' as const,
              blankId,
              part: 'candidates' as const,
              itemId: wordImportIdentity(
                blankId,
                'option',
                String(i),
                JSON.stringify(option.label),
              ),
            },
            sourceRanges: option.label,
          })),
        );
        let blankAnswer: string[] | RichTextDocument;
        try {
          blankAnswer =
            ref.questionType === 'fill_in_the_blank'
              ? doc(marker.blank.answer)
              : choices(marker.blank.answer, ref.questionType === 'cloze' ? blankPool : pool);
          if (
            ref.questionType === 'fill_with_candidates' &&
            Array.isArray(blankAnswer) &&
            blankAnswer.length > 1
          )
            throw new Error('word-import.blank-answer-count');
        } catch (error) {
          if (
            !config.allowPartialRoots ||
            !(error instanceof Error) ||
            !['word-import.invalid-answer-reference', 'word-import.blank-answer-count'].includes(
              error.message,
            )
          )
            throw error;
          emit(
            error.message as DiagnosticCode,
            { kind: 'blanks', blankId, part: 'answer' },
            marker.blank.answer,
            'cleared-field',
          );
          blankAnswer = [];
        }
        return {
          id: blankId,
          blank_index: index + 1,
          answer: blankAnswer,
          ...(ref.questionType === 'cloze' || blankPool.length
            ? { candidates: options(blankPool, blankId) }
            : {}),
        };
      });
      question.content = questionReferences.flatMap((source) => {
        const { block, start, end } = range(source);
        const content: RichTextNode[] = [];
        let offset = start;
        ordered.forEach((marker, index) => {
          if (marker.block.id !== block.id || marker.start < start || marker.end > end) return;
          content.push(...sliceSource(block.content, offset, marker.start), {
            type: 'quizBlank',
            attrs: { blankId: candidate.blanks![index].id, blankIndex: index + 1 },
          });
          offset = marker.end;
        });
        content.push(...sliceSource(block.content, offset, end));
        return paragraphOrBlocks(content);
      });
      candidate.has_answer =
        ordered.length > 0 &&
        ordered.every((marker) => text(marker.blank.answer).trim().length > 0);
      if (!ordered.length) issue('word-import.missing-blanks');
      if (ref.questionType === 'fill_with_candidates' && !candidate.candidate_pool_repeatable) {
        const values = candidate.blanks.flatMap((blank) => blank.answer as string[]);
        if (new Set(values).size !== values.length && !config.allowPartialRoots)
          throw new Error('word-import.reused-pool-answer');
      }
    }
    if (!candidate.has_answer) issue('word-import.missing-answer');
    sources[id] = {
      blockIds: [...new Set(questionReferences.map((source) => source.blockId))],
      ...(ref.sourceLabel ? { sourceLabel: ref.sourceLabel } : {}),
      sourceRanges: allRanges({ ...ref, children: [] }),
      fields: [
        { field: { kind: 'question' }, sourceRanges: ref.question },
        { field: { kind: 'answer' }, sourceRanges: ref.answer },
        { field: { kind: 'analysis' }, sourceRanges: ref.analysis },
        { field: { kind: 'points' }, sourceRanges: ref.pointsSource ? [ref.pointsSource] : [] },
        ...pool.map((o, i) => ({
          field: {
            kind: 'options' as const,
            itemId: wordImportIdentity(id, 'option', String(i), JSON.stringify(o.label)),
          },
          sourceRanges: o.label,
        })),
        ...blankSources,
      ],
    };
    candidate.sub_problems = ref.children.flatMap((child, index) =>
      boundary(child, [...path, index], depth + 1, id, `${ancestorContext} ${text(ref.question)}`),
    );
    candidate.has_answer = wordQuestionHasAnswer(candidate as unknown as Record<string, unknown>, {
      allowSourceMedia: true,
    });
    if (
      isChoice &&
      Array.isArray(answer) &&
      answer.length &&
      text(ref.answer).trim() !== answer.join('')
    )
      emit('word-import.answer-normalized', { kind: 'answer' }, ref.answer, 'normalized', false);
    return candidate;
  };
  if (references.length > 2000) throw new Error('word-import.invalid-question');
  const boundary = (
    reference: WordQuestionReference,
    path: number[],
    depth: number,
    parentQuestionId?: string,
    ancestorContext = '',
  ): WordImportCandidate[] => {
    const priorUsed = new Set(used);
    const priorRanges = structuredClone(questionRanges);
    const priorSources = new Set(Object.keys(sources));
    const priorDiagnostics = diagnostics.length;
    const priorFields = fieldDiagnostics.length,
      priorUnresolved = unresolvedItems.length;
    try {
      return [visit(reference, path, depth, ancestorContext)];
    } catch (error) {
      if (
        !config.allowPartialRoots ||
        !(error instanceof Error) ||
        ![
          'word-import.unsupported-question-type',
          'word-import.empty-question',
          'word-import.duplicated-material',
          'word-import.blank-outside-question',
          'word-import.missing-blank-reference',
          'word-import.overlapping-blanks',
        ].includes(error.message)
      )
        throw error;
      used.clear();
      priorUsed.forEach((id) => used.add(id));
      questionRanges.clear();
      priorRanges.forEach((ranges, id) => questionRanges.set(id, ranges));
      for (const id of Object.keys(sources)) if (!priorSources.has(id)) delete sources[id];
      diagnostics.length = priorDiagnostics;
      fieldDiagnostics.length = priorFields;
      unresolvedItems.length = priorUnresolved;
      const itemId = wordImportIdentity(identity, 'unresolved', path.join('.'));
      unresolvedItems.push({
        id: itemId,
        kind: 'question',
        code: error.message as DiagnosticCode,
        sourceRanges: allRanges(reference),
        ...(parentQuestionId ? { parentQuestionId } : {}),
        ...(reference.sourceLabel ? { sourceLabel: reference.sourceLabel } : {}),
      });
      fieldDiagnostics.push(
        createWordDiagnostic({
          code: error.message as DiagnosticCode,
          severity: 'error',
          phase: 'parse',
          target: { kind: 'unresolved', itemId },
          sourceRanges: allRanges(reference),
          blocksApply: false,
          recovery: 'retained-source',
        }),
      );
      diagnostics.push({
        code: 'word-import.question-parse-failed',
        severity: 'error',
        ...(reference.question[0] ? { blockId: reference.question[0].blockId } : {}),
      });
      return [];
    }
  };
  const questions = references.flatMap((reference, index) => boundary(reference, [index], 0));
  const clozeOptionPrefixes = new Map<string, number>();
  const registerClozePrefixes = (reference: WordQuestionReference) => {
    if (reference.questionType === 'cloze') {
      for (const blank of reference.blanks ?? []) {
        const first = blank.candidates?.[0]?.label[0];
        if (!first || !blank.sourceLabel) continue;
        const block = blocks.find((item) => item.id === first.blockId);
        if (!block) continue;
        const prefix = /^\s*(\d+)[.．、)）]\s*[A-Za-z][.．、)）]\s*/.exec(
          sourceText(block.content),
        );
        if (prefix?.[1] === blank.sourceLabel && prefix[0].length === first.start)
          clozeOptionPrefixes.set(block.id, prefix[0].length);
      }
    }
    reference.children.forEach(registerClozePrefixes);
  };
  references.forEach(registerClozePrefixes);
  for (const block of blocks) {
    if (
      !used.has(block.id) &&
      sourceText(block.content).trim() &&
      !isWordQuizHeader(sourceText(block.content)) &&
      !isWordStructuralLabel(sourceText(block.content), block.numbering)
    )
      diagnostics.push({
        code: 'word-import.unassigned-block',
        severity: 'warning',
        blockId: block.id,
      });
  }
  if (!config.allowPartialRoots)
    return { parserVersion: WORD_IMPORT_PARSER_VERSION, questions, diagnostics, sources };
  for (const d of validateWordImportQuestions(questions, { allowSourceMedia: true })) {
    if (
      fieldDiagnostics.some(
        (existing) =>
          existing.code === d.code && JSON.stringify(existing.target) === JSON.stringify(d.target),
      )
    )
      continue;
    const source = 'questionId' in d.target ? sources[d.target.questionId] : undefined;
    const field = d.target.kind === 'field' ? d.target.field : undefined;
    const refs =
      source?.fields
        ?.filter(
          (f) =>
            field &&
            f.field.kind === field.kind &&
            (!('blankId' in field) ||
              !field.blankId ||
              ('blankId' in f.field && f.field.blankId === field.blankId)) &&
            (!('itemId' in field) ||
              !field.itemId ||
              ('itemId' in f.field && f.field.itemId === field.itemId)) &&
            (!('part' in field) ||
              !field.part ||
              !('part' in f.field) ||
              f.field.part === field.part),
        )
        .flatMap((f) => f.sourceRanges) ?? [];
    fieldDiagnostics.push(createWordDiagnostic({ ...d, sourceRanges: refs }));
  }
  const coverage = [
    ...Object.values(sources).flatMap((s) => s.sourceRanges ?? []),
    ...unresolvedItems.flatMap((u) => u.sourceRanges),
  ];
  // Check the complete authority metadata before presentation limits can truncate it.
  if (config.declaredUnassignedBlockIds) {
    const accounted = new Set([
      ...coverage.map((r) => r.blockId),
      ...config.declaredUnassignedBlockIds,
    ]);
    if (
      blocks.some(
        (b) =>
          sourceText(b.content).trim() &&
          !isWordQuizHeader(sourceText(b.content)) &&
          !isWordStructuralLabel(sourceText(b.content), b.numbering) &&
          !accounted.has(b.id),
      )
    )
      throw new Error('word-import.unaccounted-source');
  }
  for (const block of blocks) {
    const content = sourceText(block.content);
    if (isWordQuizHeader(content) || isWordStructuralLabel(content, block.numbering)) continue;
    const spans = coverage
      .filter((r) => r.blockId === block.id)
      .map((r) => [r.start ?? 0, r.end ?? content.length])
      .sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    const residual = (start: number, end: number) => {
      const text = content.slice(start, end).trim();
      if (
        !text ||
        (start === 0 &&
          end === content.length &&
          block.content.every((node) => node.type === 'text') &&
          /^(?:[一二三四五六七八九十]+[、.．]\s*)?(?:完成句子|语法填空)\s*[:：。]?$/.test(text)) ||
        (start === 0 && end === clozeOptionPrefixes.get(block.id)) ||
        isWordStructuralLabel(text) ||
        /^(?:【(?:答案|解析|分析|详解|知识点|导语|点睛)】\s*)+(?:(?:参考)?答案|解析|分析|详解|知识点)?\s*[:：]?$/.test(
          text,
        ) ||
        /^(?:【(?:答案|解析|分析|详解|知识点|导语|点睛)】)?(?:\s*(?:\d+[.．、]|[（(]\d+[）)]|[①②③④⑤⑥⑦⑧⑨⑩]))+\s*$/.test(
          text,
        ) ||
        /^(?:【(?:答案|解析|分析|详解|知识点)】|\[(?:答案|解析|分析|详解|知识点)\])\s*[:：]?$/.test(
          text,
        ) ||
        /^(?:[\s\d一二三四五六七八九十、.．:：()（）【】\[\]分]+|[A-Za-z][.．、)）]?|(?:参考)?答案|解析|分析|详解|知识点|单项?选择题?|单选题?|多项?选择题?|多选题?|填空题|简答题|解答题)$/.test(
          text,
        )
      )
        return;
      const sourceRanges = [{ blockId: block.id, start, end }],
        itemId = wordImportIdentity(identity, 'unassigned', block.id, String(start), String(end));
      unresolvedItems.push({
        id: itemId,
        kind: 'unassigned',
        code: 'word-import.unassigned-range',
        sourceRanges,
      });
      fieldDiagnostics.push(
        createWordDiagnostic({
          code: 'word-import.unassigned-range',
          severity: 'warning',
          phase: 'parse',
          target: { kind: 'unresolved', itemId },
          sourceRanges,
          blocksApply: false,
          recovery: 'retained-source',
        }),
      );
    };
    for (const [start, end] of spans) {
      if (start > cursor) residual(cursor, start);
      cursor = Math.max(cursor, end);
    }
    if (cursor < content.length) residual(cursor, content.length);
  }
  const metadata = boundWordDiagnosticMetadata({
    diagnosticVersion: WORD_IMPORT_DIAGNOSTIC_VERSION,
    fieldDiagnostics,
    unresolvedItems,
    sourceExcerpts: fieldDiagnostics.flatMap((d) =>
      projectWordSourceExcerpts(blocks, d.sourceRanges),
    ),
    diagnosticsTruncated: false,
  });
  return {
    parserVersion: WORD_IMPORT_PARSER_VERSION,
    questions,
    diagnostics,
    sources,
    ...metadata,
  };
}
