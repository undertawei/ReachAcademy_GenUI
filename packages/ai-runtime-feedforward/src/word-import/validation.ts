import {
  createWordDiagnostic,
  isDiagnosticCode,
  WORD_IMPORT_DIAGNOSTIC_REGISTRY,
  WORD_IMPORT_DIAGNOSTIC_VERSION,
  type DiagnosticCode,
  type FieldTarget,
  type ImportDiagnostic,
  type WordUnresolvedItem,
} from './diagnostics.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const types = [
  'single_choice',
  'multiple_choice',
  'short_answer',
  'fill_in_the_blank',
  'cloze',
  'fill_with_candidates',
];
const fills = ['fill_in_the_blank', 'cloze', 'fill_with_candidates'];
const nodes = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
  'image',
  'inlineMath',
  'blockMath',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'taskList',
  'taskItem',
  'quizBlank',
  'mermaidDiagram',
  'attachment',
]);
const marks = new Set(['bold', 'italic', 'strike', 'code', 'link', 'underline', 'feedbackColor']);
export interface WordValidationOptions {
  /** Only trusted pre-materialization parser previews may use sourceMediaId. */ allowSourceMedia?: boolean;
}
export function wordRichTextHasContent(
  value: unknown,
  config: WordValidationOptions = {},
): boolean {
  if (!record(value)) return false;
  if (value.type === 'text') return typeof value.text === 'string' && value.text.trim().length > 0;
  if (
    ['image', 'attachment', 'inlineMath', 'blockMath', 'mermaidDiagram'].includes(
      String(value.type),
    )
  ) {
    if (!record(value.attrs)) return false;
    return [
      'src',
      'objectKey',
      'latex',
      'text',
      'code',
      'url',
      ...(config.allowSourceMedia ? ['sourceMediaId'] : []),
    ].some(
      (key) =>
        typeof (value.attrs as RecordValue)[key] === 'string' &&
        String((value.attrs as RecordValue)[key]).trim().length > 0,
    );
  }
  if (value.type === 'quizBlank')
    return (
      record(value.attrs) &&
      typeof value.attrs.blankId === 'string' &&
      value.attrs.blankId.length > 0
    );
  return list(value.content).some((child) => wordRichTextHasContent(child, config));
}
export function isWordRichText(value: unknown, config: WordValidationOptions = {}): boolean {
  let count = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (++count > 20_000 || depth > 40 || !record(node) || !nodes.has(String(node.type)))
      return false;
    if (node.type === 'text' && typeof node.text !== 'string') return false;
    if (node.attrs !== undefined && !record(node.attrs)) return false;
    if (
      node.marks !== undefined &&
      (!Array.isArray(node.marks) ||
        !node.marks.every((m) => record(m) && marks.has(String(m.type))))
    )
      return false;
    if (
      node.content !== undefined &&
      (!Array.isArray(node.content) || !node.content.every((n) => visit(n, depth + 1)))
    )
      return false;
    if (
      ['image', 'attachment', 'inlineMath', 'blockMath', 'mermaidDiagram'].includes(
        String(node.type),
      ) &&
      !wordRichTextHasContent(node, config)
    )
      return false;
    return true;
  };
  return record(value) && value.type === 'doc' && visit(value, 0);
}
function blankMarkers(value: unknown): RecordValue[] {
  if (!record(value)) return [];
  return [
    ...(value.type === 'quizBlank' ? [record(value.attrs) ? value.attrs : {}] : []),
    ...list(value.content).flatMap(blankMarkers),
  ];
}
function optionLabel(index: number): string {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label;
}
export function wordQuestionHasAnswer(
  question: RecordValue,
  config: WordValidationOptions = {},
): boolean {
  const type = String(question.question_type);
  if (fills.includes(type))
    return (
      list(question.blanks).length > 0 &&
      list(question.blanks).every(
        (b) =>
          record(b) &&
          (type === 'fill_in_the_blank'
            ? wordRichTextHasContent(b.answer, config)
            : Array.isArray(b.answer) && b.answer.length > 0),
      )
    );
  return type === 'short_answer'
    ? wordRichTextHasContent(question.answer, config)
    : Array.isArray(question.answer) && question.answer.length > 0;
}
/** Validates raw edited objects without native parser coercion or mutation. */
export function validateWordImportQuestions(
  input: readonly unknown[],
  config: WordValidationOptions = {},
): ImportDiagnostic[] {
  const diagnostics: ImportDiagnostic[] = [],
    ids = new Set<string>();
  let count = 0;
  const visit = (raw: unknown, depth: number): void => {
    if (!record(raw) || ++count > 2000 || depth > 12) {
      diagnostics.push(
        createWordDiagnostic({
          code: 'word-import.invalid-question',
          severity: 'error',
          phase: 'validate',
          target: { kind: 'document' },
          blocksApply: true,
          recovery: 'none',
        }),
      );
      return;
    }
    const q = raw,
      id = typeof q.id === 'string' ? q.id : '';
    const issue = (code: DiagnosticCode, field: FieldTarget) =>
      diagnostics.push(
        createWordDiagnostic({
          code,
          severity: 'error',
          phase: 'validate',
          target: id.trim() ? { kind: 'field', questionId: id, field } : { kind: 'document' },
          ...(!id.trim() ? { params: { questionOrdinal: count } } : {}),
          blocksApply: true,
          recovery: 'none',
        }),
      );
    if (!id.trim() || ids.has(id)) issue('word-import.invalid-question', { kind: 'question' });
    ids.add(id);
    const type = String(q.question_type),
      fill = fills.includes(type),
      choice = type === 'single_choice' || type === 'multiple_choice';
    if (!types.includes(type))
      issue('word-import.unsupported-question-type', { kind: 'question_type' });
    if (typeof q.points !== 'number' || !Number.isFinite(q.points) || q.points < 0)
      issue(q.points === undefined ? 'word-import.missing-points' : 'word-import.invalid-points', {
        kind: 'points',
      });
    if (!isWordRichText(q.question, config))
      issue('word-import.invalid-rich-text', { kind: 'question' });
    if (
      !wordRichTextHasContent(q.question, config) &&
      !list(q.sub_problems).some(
        (child) =>
          record(child) &&
          isWordRichText(child.question, config) &&
          wordRichTextHasContent(child.question, config),
      )
    )
      issue('word-import.empty-question', { kind: 'question' });
    if (q.analysis !== undefined && !isWordRichText(q.analysis, config))
      issue('word-import.invalid-rich-text', { kind: 'analysis' });
    const options = (value: unknown, field: FieldTarget): Set<string> => {
      const values = new Set<string>(),
        items = list(value),
        itemIds = new Set<string>();
      if (!Array.isArray(value) || items.length < 2) issue('word-import.missing-options', field);
      items.forEach((rawOption, index) => {
        const option = record(rawOption) ? rawOption : {};
        const itemId =
          typeof option.wordImportItemId === 'string' ? option.wordImportItemId : undefined;
        const target = { ...field, ...(itemId ? { itemId } : {}) } as FieldTarget;
        if (option.value !== optionLabel(index) || (itemId !== undefined && itemIds.has(itemId)))
          issue('word-import.invalid-options', target);
        if (itemId !== undefined) itemIds.add(itemId);
        if (typeof option.value === 'string') values.add(option.value);
        if (!isWordRichText(option.label, config)) issue('word-import.invalid-rich-text', target);
        if (!wordRichTextHasContent(option.label, config))
          issue('word-import.empty-option', target);
      });
      return values;
    };
    const selection = (
      answer: unknown,
      values: Set<string>,
      field: FieldTarget,
      maximum?: number,
    ) => {
      if (
        !Array.isArray(answer) ||
        answer.some((v) => typeof v !== 'string' || !values.has(v)) ||
        new Set(list(answer)).size !== list(answer).length
      )
        issue('word-import.invalid-answer-reference', field);
      if (maximum !== undefined && list(answer).length > maximum)
        issue(
          field.kind === 'blanks'
            ? 'word-import.blank-answer-count'
            : 'word-import.single-answer-count',
          field,
        );
    };
    let pool = new Set<string>();
    if (choice || type === 'fill_with_candidates') pool = options(q.options, { kind: 'options' });
    else if (q.options !== undefined)
      issue(type === 'cloze' ? 'word-import.cloze-root-pool' : 'word-import.unexpected-options', {
        kind: 'options',
      });
    if (type === 'fill_with_candidates') {
      if (typeof q.candidate_pool_repeatable !== 'boolean')
        issue('word-import.missing-pool-policy', { kind: 'candidate_pool_repeatable' });
    } else if (q.candidate_pool_repeatable !== undefined)
      issue('word-import.unexpected-pool-policy', { kind: 'candidate_pool_repeatable' });
    if (choice)
      selection(q.answer, pool, { kind: 'answer' }, type === 'single_choice' ? 1 : undefined);
    if (type === 'short_answer' && !isWordRichText(q.answer, config))
      issue('word-import.invalid-answer', { kind: 'answer' });
    const markers = blankMarkers(q.question);
    if (!fill && (q.blanks !== undefined || markers.length))
      issue('word-import.unexpected-blanks', { kind: 'blanks' });
    if (fill) {
      if (!Array.isArray(q.answer) || q.answer.length)
        issue('word-import.invalid-answer', { kind: 'answer' });
      const blanks = list(q.blanks),
        blankIds = new Set<string>(),
        used = new Set<string>();
      if (!Array.isArray(q.blanks) || !blanks.length)
        issue('word-import.missing-blanks', { kind: 'blanks' });
      if (markers.length !== blanks.length)
        issue('word-import.missing-blank-reference', { kind: 'blanks' });
      blanks.forEach((rawBlank, index) => {
        const b = record(rawBlank) ? rawBlank : {},
          blankId = typeof b.id === 'string' ? b.id : undefined;
        const field = (part: 'marker' | 'answer' | 'candidates'): FieldTarget => ({
          kind: 'blanks',
          ...(blankId ? { blankId } : {}),
          part,
        });
        if (
          !blankId ||
          blankIds.has(blankId) ||
          b.blank_index !== index + 1 ||
          markers[index]?.blankId !== blankId ||
          markers[index]?.blankIndex !== index + 1
        )
          issue('word-import.invalid-blank-identity', field('marker'));
        if (blankId) blankIds.add(blankId);
        if (type === 'fill_in_the_blank') {
          if (!isWordRichText(b.answer, config))
            issue('word-import.invalid-answer', field('answer'));
        } else
          selection(
            b.answer,
            type === 'cloze' ? options(b.candidates, field('candidates')) : pool,
            field('answer'),
            type === 'fill_with_candidates' ? 1 : undefined,
          );
        if (type !== 'cloze' && b.candidates !== undefined)
          issue('word-import.unexpected-blank-pool', field('candidates'));
        if (type === 'fill_with_candidates' && q.candidate_pool_repeatable === false)
          for (const value of list(b.answer)) {
            if (typeof value === 'string') {
              if (used.has(value)) issue('word-import.reused-pool-answer', field('answer'));
              used.add(value);
            }
          }
      });
    }
    if (typeof q.has_answer !== 'boolean' || q.has_answer !== wordQuestionHasAnswer(q, config))
      issue('word-import.has-answer-mismatch', { kind: 'answer' });
    if (!Array.isArray(q.sub_problems))
      issue('word-import.invalid-children', { kind: 'sub_problems' });
    else q.sub_problems.forEach((child) => visit(child, depth + 1));
  };
  input.forEach((q) => visit(q, 0));
  return diagnostics;
}
export type WordDiagnosticStatus = 'pending' | 'resolved' | 'normalized' | 'excluded';
export interface WordValidationResult {
  /** Current field failures plus unresolved history with source evidence. Consumers group by field
   * and code when rendering; history IDs remain separate for immutable status tracking. */
  diagnostics: ImportDiagnostic[];
  history: Array<{ diagnosticId: string; status: WordDiagnosticStatus }>;
  canApply: boolean;
  blockedQuestionIds: string[];
}
/** History is immutable evidence. Clearance always depends on the complete current selected tree. */
export function evaluateWordImportDiagnostics(
  questions: readonly unknown[],
  history: readonly ImportDiagnostic[],
  config: { diagnosticVersion?: string } & WordValidationOptions = {},
): WordValidationResult {
  const fieldDiagnostics = validateWordImportQuestions(questions, config),
    current = [...fieldDiagnostics],
    byId = new Map<string, RecordValue>();
  const collect = (values: readonly unknown[]) => {
    for (const q of values)
      if (record(q)) {
        byId.set(String(q.id), q);
        collect(list(q.sub_problems));
      }
  };
  collect(questions);
  if (
    config.diagnosticVersion !== undefined &&
    config.diagnosticVersion !== WORD_IMPORT_DIAGNOSTIC_VERSION
  )
    current.push(
      createWordDiagnostic({
        code: 'word-import.unsupported-diagnostic-version',
        severity: 'error',
        phase: 'validate',
        target: { kind: 'document' },
        blocksApply: true,
        recovery: 'none',
      }),
    );
  const statuses = history.map((diagnostic) => {
    const target = diagnostic.target,
      questionId = 'questionId' in target ? target.questionId : undefined;
    const question = questionId === undefined ? undefined : byId.get(questionId);
    let status: WordDiagnosticStatus;
    if (questionId !== undefined && !question) status = 'excluded';
    // Source-review notes cannot be repaired by editing a question. They stay as evidence on the
    // run and never gate the append.
    else if (target.kind === 'unresolved') status = 'pending';
    else if (!diagnostic.blocksApply && diagnostic.recovery === 'normalized') status = 'normalized';
    else if (!diagnostic.blocksApply)
      status =
        isDiagnosticCode(diagnostic.code) &&
        WORD_IMPORT_DIAGNOSTIC_REGISTRY[diagnostic.code].clearance === 'review'
          ? 'pending'
          : 'resolved';
    else {
      const clearance = isDiagnosticCode(diagnostic.code)
        ? WORD_IMPORT_DIAGNOSTIC_REGISTRY[diagnostic.code].clearance
        : 'never';
      const errors = fieldDiagnostics.filter(
        (d) => 'questionId' in d.target && d.target.questionId === questionId,
      );
      const matches = (a: FieldTarget, b: FieldTarget): boolean => {
        if (a.kind !== b.kind) return false;
        if (
          a.kind === 'blanks' &&
          b.kind === 'blanks' &&
          a.blankId &&
          b.blankId &&
          a.blankId !== b.blankId
        )
          return false;
        if ('itemId' in a && 'itemId' in b && a.itemId && b.itemId && a.itemId !== b.itemId)
          return false;
        if ('part' in a && 'part' in b && a.part && b.part && a.part !== b.part) return false;
        return true;
      };
      const fieldErrors =
        target.kind === 'field'
          ? errors.filter((d) => d.target.kind !== 'field' || matches(target.field, d.target.field))
          : errors;
      let answerValid =
        question !== undefined &&
        wordQuestionHasAnswer(question, config) &&
        question.has_answer === true &&
        errors.length === 0;
      if (
        question &&
        target.kind === 'field' &&
        target.field.kind === 'blanks' &&
        target.field.blankId &&
        fills.includes(String(question.question_type))
      ) {
        const blankId = target.field.blankId;
        const blank = list(question.blanks).find((b) => record(b) && b.id === blankId);
        // Other originally unanswered blanks do not turn a repaired answer into a new error.
        answerValid =
          record(blank) &&
          (question.question_type === 'fill_in_the_blank'
            ? wordRichTextHasContent(blank.answer, config)
            : Array.isArray(blank.answer) && blank.answer.length > 0) &&
          fieldErrors.length === 0 &&
          !errors.some((d) => d.code === 'word-import.has-answer-mismatch');
      }
      const valid =
        question !== undefined &&
        (clearance === 'current-fields'
          ? fieldErrors.length === 0
          : clearance === 'nonempty-answer'
            ? answerValid
            : false);
      status = valid ? 'resolved' : 'pending';
      // Review notes stay visible as evidence without gating the append, wherever they are aimed.
      if (!valid && clearance !== 'review') current.push(diagnostic);
    }
    return { diagnosticId: diagnostic.id, status };
  });
  return {
    diagnostics: current,
    history: statuses,
    canApply: questions.length > 0 && !current.some((d) => d.blocksApply),
    blockedQuestionIds: [
      ...new Set(
        current
          .filter((d) => d.blocksApply && 'questionId' in d.target)
          .map((d) => ('questionId' in d.target ? d.target.questionId : '')),
      ),
    ],
  };
}
export function summarizeWordImport(
  questions: readonly unknown[],
  result: WordValidationResult,
  unresolved: readonly WordUnresolvedItem[] = [],
) {
  let editableQuestions = 0;
  const count = (values: readonly unknown[]) =>
    values.forEach((q) => {
      if (record(q)) {
        editableQuestions++;
        count(list(q.sub_problems));
      }
    });
  count(questions);
  const unresolvedQuestions = unresolved.filter((i) => i.kind === 'question').length;
  return {
    recognizedItems: editableQuestions + unresolvedQuestions,
    editableQuestions,
    blockedQuestions: result.blockedQuestionIds.length,
    unresolvedItems: unresolvedQuestions,
    unassignedParagraphs: new Set(
      unresolved
        .filter((i) => i.kind === 'unassigned')
        .flatMap((i) => i.sourceRanges.map((r) => r.blockId)),
    ).size,
  };
}
