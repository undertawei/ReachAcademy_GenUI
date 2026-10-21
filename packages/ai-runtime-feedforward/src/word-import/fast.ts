import type { QuizQuestionType, RichTextNode } from '@reachany/reach-deck-dsl';
import {
  extractWordKnowledgePoints,
  findWordBlankMarkers,
  isWordQuizHeader,
  isWordStructuralLabel,
  readWordMathSection,
  sourceText,
  sliceSource,
  wordChoiceAnswerLabels,
  wordChoiceSourceText,
  type WordBlankReference,
  type WordImportPreview,
  type WordImportDiagnostic,
  type WordOptionReference,
  type WordQuestionReference,
  type WordSourceBlock,
  type WordSourceRange,
} from './contracts.js';
import { resolveWordQuestions } from './resolve.js';
import {
  adaptLegacyWordDiagnostic,
  boundWordDiagnosticMetadata,
  projectWordSourceExcerpts,
  WORD_IMPORT_DIAGNOSTIC_VERSION,
  WORD_IMPORT_DIAGNOSTIC_REGISTRY,
} from './diagnostics.js';

const range = (blockId: string, start: number, end: number): WordSourceRange => ({
  blockId,
  start,
  end,
});
const newQuestion = (
  questionType: QuizQuestionType,
  sourceLabel?: string,
): WordQuestionReference => ({
  questionType,
  sourceLabel,
  question: [],
  answer: [],
  analysis: [],
  knowledgePoints: [],
  children: [],
});
const numberingLabel = (label: string): string => label.trim().replace(/[.)．、）]+$/u, '');
const numberingPrefixLength = (text: string, label: string): number => {
  const leading = text.length - text.trimStart().length;
  if (!text.startsWith(label, leading)) return 0;
  const whitespace = /^\s*/.exec(text.slice(leading + label.length))?.[0].length ?? 0;
  return leading + label.length + whitespace;
};
const mainLabel = (text: string) => /^\s*(\d+)(?:\.(?!\d)|[．、])\s*/.exec(text);
const questionContentStart = (block: WordSourceBlock, prefix: number): number => {
  const blank = findWordBlankMarkers(block, 0, prefix).find((marker) => {
    const visible = sourceText(block.content).slice(marker.start, marker.end);
    return (
      /^\s{2,}$/.test(visible) && /^\s*$/.test(sourceText(block.content).slice(marker.end, prefix))
    );
  });
  return blank?.start ?? prefix;
};
const inlineChildLabels = (text: string) =>
  [...text.matchAll(/[（(](\d+)[）)]\s*/g)].filter(
    (match) =>
      !text.slice(0, match.index!).trim() || /(?:\s{2}|[。；;])$/.test(text.slice(0, match.index!)),
  );
const compactAnswerNumber = String.raw`[-−]?(?:\d+(?:\.\d+)?|\\frac\s*\{[-−]?\d+\}\s*\{\d+\})`;
const compactAnswerMathValue = new RegExp(
  String.raw`^\s*(?:\\left(?:[.()|]|\[|\]|\\[{}]))?\s*(?:${compactAnswerNumber}|[A-Za-z]\s*(?:[=<>]|\\(?:leq|geq))\s*${compactAnswerNumber})\s*(?:\\right(?:[.()|]|\[|\]|\\[{}]))?\s*$`,
);
const isSolutionOperator = (value: string): boolean =>
  /^(?:[+\-＋－−=＝×÷*/]|\\(?:times|div|cdot|pm|mp|leq|geq|neq)|式)/.test(
    value.trim().replace(/^\{+\s*/, ''),
  );
const solutionStartsWithOperator = (
  block: WordSourceBlock,
  start: number,
  end: number,
): boolean => {
  const node = sliceSource(block.content, start, end).find(
    (item) => item.type !== 'text' || item.text?.trim(),
  );
  const value =
    node?.type === 'text'
      ? node.text?.trim()
      : typeof node?.attrs?.latex === 'string'
        ? node.attrs.latex.trim().replace(/^\{+\s*/, '')
        : '';
  return isSolutionOperator(value ?? '');
};
const mathSectionLabel = (text: string, nativeLabel?: string): string =>
  text
    .slice(nativeLabel ? numberingPrefixLength(text, nativeLabel) : 0)
    .trim()
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, '');
const sectionType = (
  text: string,
  nativeLabel?: string,
  nativeLevel?: number,
): QuizQuestionType | undefined => {
  const math = readWordMathSection(
    text,
    nativeLabel ? { label: nativeLabel, level: nativeLevel ?? 1 } : undefined,
  );
  if (math) return math.label === '选择题' ? 'single_choice' : 'short_answer';
  const prefix = nativeLabel ? numberingPrefixLength(text, nativeLabel) : 0;
  const label = text
    .slice(prefix)
    .trim()
    .replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '');
  if (label.length > 40) return;
  if (/^(?:阅读选择|阅读判断)\s*[:：]?$/.test(label)) return 'short_answer';
  if (/^(单项?选择|单选)/.test(label)) return 'single_choice';
  if (/^(多项?选择|多选)/.test(label)) return 'multiple_choice';
  if (/^(完[形型]填空|语篇填空)/.test(label)) return 'cloze';
  if (/^(选词填空|选择填空|共享选项)/.test(label)) return 'fill_with_candidates';
  if (/^填空题/.test(label)) return 'fill_in_the_blank';
  if (/^(解答题|简答题|证明题)/.test(label)) return 'short_answer';
};

/** Rule parsing makes no model calls. Ambiguous source remains visible in diagnostics. */
export function parseWordFast(blocks: WordSourceBlock[], identity: string): WordImportPreview {
  const diagnostics: WordImportDiagnostic[] = [];
  const references = fastWordReferences(blocks, diagnostics);
  const preview = resolveWordQuestions(blocks, references, identity, {
    allowPartialRoots: true,
    omitUnverifiedPoints: true,
  });
  preview.diagnostics.push(...diagnostics);
  const added = diagnostics.map((d, i) => {
    const diagnostic = adaptLegacyWordDiagnostic(d, i);
    if (WORD_IMPORT_DIAGNOSTIC_REGISTRY[diagnostic.code].clearance === 'review') {
      (preview.unresolvedItems ??= []).push({
        id: diagnostic.id,
        kind: 'unassigned',
        code: diagnostic.code,
        sourceRanges: diagnostic.sourceRanges,
      });
      diagnostic.target = { kind: 'unresolved', itemId: diagnostic.id };
    }
    return diagnostic;
  });
  Object.assign(
    preview,
    boundWordDiagnosticMetadata({
      diagnosticVersion: WORD_IMPORT_DIAGNOSTIC_VERSION,
      fieldDiagnostics: [...(preview.fieldDiagnostics ?? []), ...added],
      unresolvedItems: preview.unresolvedItems ?? [],
      sourceExcerpts: [
        ...(preview.sourceExcerpts ?? []),
        ...added.flatMap((d) => projectWordSourceExcerpts(blocks, d.sourceRanges)),
      ],
      diagnosticsTruncated: preview.diagnosticsTruncated ?? false,
    }),
  );
  return preview;
}

export function fastWordReferences(
  blocks: WordSourceBlock[],
  diagnostics: WordImportDiagnostic[] = [],
): WordQuestionReference[] {
  const roots: WordQuestionReference[] = [];
  let current: WordQuestionReference | undefined;
  let root: WordQuestionReference | undefined;
  let type: QuizQuestionType = 'short_answer';
  let explicitType = false;
  let surface: 'question' | 'answer' | 'analysis' = 'question';
  let answerAppendix = false;
  let appendixRoot: WordQuestionReference | undefined;
  const parents: WordQuestionReference[] = [];
  /**
   * Root numbers seen in the current section. A source number only marks where a question starts
   * and which solution belongs to it; papers keep their original, possibly non-contiguous
   * numbering (17 then 25). So a number that already names a question is a back-reference inside
   * an answer or explanation, and any other number opens the next question.
   */
  const rootLabels = new Set<string>();
  /**
   * How far the current solution has enumerated its own items. An answer key for a multi-blank
   * question lists them as "1." then "2.", so a run that starts at one and increments is solution
   * content rather than the next stem. Reset whenever a solution or a question begins.
   */
  let solutionEnumeration = 0;
  let clozeSolutionEnumerationEnd: number | undefined;
  let solutionParent: WordQuestionReference | undefined;
  let solutionSequenceStart = false;
  const explicitlyTyped = new WeakSet<WordQuestionReference>();
  const nonScoringMarkers = new WeakMap<WordQuestionReference, WordBlankReference[]>();
  const readingGroups = new WeakSet<WordQuestionReference>();
  const readingRanges = new WeakMap<WordQuestionReference, [number, number]>();
  const diagramGroups = new WeakSet<WordQuestionReference>();
  const chineseGroups = new WeakSet<WordQuestionReference>();
  const scaffoldTasks = new WeakSet<WordQuestionReference>();
  const choiceBlankMarkers = new WeakMap<WordQuestionReference, WordBlankReference[]>();
  const pendingQuestionPreludes = new Map<
    string,
    {
      ranges: WordSourceRange[];
      owner: WordQuestionReference;
      field: 'question' | 'answer' | 'analysis';
    }
  >();
  const englishGroups = new WeakMap<
    WordQuestionReference,
    { end: number; judgement: boolean; range?: [number, number] }
  >();
  const englishPools = new WeakMap<WordQuestionReference, WordOptionReference[]>();
  const englishPoolMaterialEnds = new WeakMap<WordQuestionReference, Map<string, number>>();
  const englishRowPools = new WeakMap<WordQuestionReference, Map<string, WordOptionReference[]>>();
  const englishRowContinuations = new WeakMap<WordQuestionReference, Set<string>>();
  const englishEmptyTipStates = new WeakMap<
    WordSourceBlock,
    {
      root: WordQuestionReference;
      current: WordQuestionReference | undefined;
      enumeration: number;
      enumerationEnd: number | undefined;
    }
  >();
  const choiceStatementRoots = new WeakSet<WordQuestionReference>();
  const premiseBlocks = new Set<string>();
  const premiseOwners = new WeakSet<WordQuestionReference>();
  let sharedSolutionOwners: WordQuestionReference[] | undefined;
  let independentSolutionOwners: WordQuestionReference[] | undefined;
  let ambiguousRoot: WordQuestionReference | undefined;
  let ambiguousNumber: number | undefined;
  const questionText = (question: WordQuestionReference) =>
    question.question
      .map((ref) =>
        sourceText(blocks.find((block) => block.id === ref.blockId)!.content).slice(
          ref.start,
          ref.end,
        ),
      )
      .join('\n');
  const inferChoiceFromOptions = (question: WordQuestionReference) => {
    const stem = questionText(question);
    const usesWordBank =
      /(?:所给|词库|词语|单词|word bank|given words)/i.test(stem) &&
      /(?:填空|补全|fill|complete)/i.test(stem);
    if (
      !explicitlyTyped.has(question) &&
      !usesWordBank &&
      ['short_answer', 'fill_in_the_blank', 'single_choice'].includes(question.questionType)
    ) {
      if (question.blanks && question.blanks.length > 1 && /[\p{Script=Han}]/u.test(stem))
        choiceBlankMarkers.set(question, question.blanks);
      question.questionType = 'single_choice';
      question.blanks = undefined;
    }
  };
  const choiceAnswerText = (question: WordQuestionReference) =>
    question.answer
      .map((ref) => {
        const block = blocks.find((item) => item.id === ref.blockId)!;
        return wordChoiceSourceText(
          sliceSource(block.content, ref.start ?? 0, ref.end ?? sourceText(block.content).length),
        );
      })
      .join('\n');
  const answerSpans = (question: WordQuestionReference, separation: number) =>
    question.answer.flatMap((source) => {
      const block = blocks.find((item) => item.id === source.blockId)!;
      const start = source.start ?? 0;
      return [
        ...sourceText(block.content)
          .slice(start, source.end)
          .matchAll(new RegExp(`\\S(?:.*?\\S)??(?=[ \\u00a0]{${separation},}|\\t|\\n|\\s*$)`, 'g')),
      ].map((match) =>
        range(block.id, start + match.index!, start + match.index! + match[0].length),
      );
    });
  const parentOf = (target: WordQuestionReference): WordQuestionReference | undefined => {
    const visit = (question: WordQuestionReference): WordQuestionReference | undefined =>
      question.children.includes(target) ? question : question.children.map(visit).find(Boolean);
    return roots.map(visit).find(Boolean);
  };
  const pushQuestion = (
    question: WordQuestionReference,
    block: WordSourceBlock,
    from: number,
    to: number,
  ) => {
    if (from >= to) return;
    const extracted = extractWordKnowledgePoints(block, from, to);
    question.question.push(...extracted.content);
    question.knowledgePoints!.push(...extracted.knowledgePoints);
    const context = [...new Set([...parents, question])].map(questionText).join(' ');
    for (const ref of extracted.content) {
      const blanks = readBlanks(block, ref.start ?? 0, ref.end ?? to, context);
      if (
        question.questionType !== 'cloze' &&
        /[\p{Script=Han}]/u.test(context) &&
        !/(?:空|填|补|cloze|blank|fill|complete)/i.test(context) &&
        blanks.some(
          (blank) =>
            blank.sourceLabel &&
            /^\d{1,3}$/.test(
              sourceText(block.content).slice(blank.marker.start, blank.marker.end),
            ) &&
            !/^\s*_/.test(sourceText(block.content).slice(blank.marker.end)),
        )
      ) {
        if (
          !diagnostics.some(
            (item) =>
              item.code === 'word-import.check-question-boundary' && item.blockId === block.id,
          )
        )
          diagnostics.push({
            code: 'word-import.check-question-boundary',
            severity: 'warning',
            blockId: block.id,
          });
      }
      if (
        explicitlyTyped.has(question) &&
        question.questionType === 'short_answer' &&
        blanks.length
      )
        nonScoringMarkers.set(question, [...(nonScoringMarkers.get(question) ?? []), ...blanks]);
      else if (
        blanks.length &&
        !['single_choice', 'multiple_choice'].includes(question.questionType)
      ) {
        question.blanks = [...(question.blanks ?? []), ...blanks];
        if (!explicitlyTyped.has(question) && question.questionType === 'short_answer')
          question.questionType = 'fill_in_the_blank';
      }
    }
    if (question.points === undefined) {
      const points = /[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/.exec(
        sourceText(block.content).slice(from, to),
      );
      if (points) {
        question.points = Number(points[1]);
        const at = from + points.index + points[0].indexOf(points[1]);
        question.pointsSource = range(block.id, at, at + points[1].length);
      }
    }
  };
  const hasChoiceStatements = (blockIndex: number) => {
    const labels: string[] = [];
    const options: WordOptionReference[] = [];
    for (const block of blocks.slice(blockIndex + 1, blockIndex + 60)) {
      const text = sourceText(block.content);
      const answer = /^\s*【答案】\s*([A-Za-z](?:[\s,，、]*[A-Za-z])*)\s*$/.exec(text);
      if (answer) {
        const pool = options.map((option) => option.sourceLabel.toUpperCase());
        return (
          labels.length > 1 &&
          labels.every((label, index) => Number(label) === index + 1) &&
          pool.length > 1 &&
          new Set(pool).size === pool.length &&
          pool.every(
            (label, index) =>
              index === 0 || label.charCodeAt(0) === pool[index - 1].charCodeAt(0) + 1,
          ) &&
          wordChoiceAnswerLabels(answer[1]).every((label) => pool.includes(label))
        );
      }
      if (
        /【答案】/.test(text) ||
        mainLabel(text) ||
        sectionType(text, block.numbering?.label, block.numbering?.level) ||
        /阅读.*(?:完成|回答)/.test(text)
      )
        return false;
      const child = /^\s*[（(](\d+)[）)]/.exec(text);
      if (child) {
        if (options.length) return false;
        labels.push(child[1]);
      } else options.push(...readOptions(block, 0));
    }
    return false;
  };
  const createQuestion = (sourceLabel?: string, inferType = false): WordQuestionReference => {
    const question = newQuestion(inferType ? 'short_answer' : type, sourceLabel);
    if (explicitType && !inferType) explicitlyTyped.add(question);
    return question;
  };
  const find = (label: string): WordQuestionReference | undefined => {
    const rootMatches = roots.filter((question) => question.sourceLabel === label);
    if (rootMatches.length) return rootMatches.length === 1 ? rootMatches[0] : undefined;
    const candidates: WordQuestionReference[] = [];
    const visit = (question: WordQuestionReference) => {
      if (question.sourceLabel === label) candidates.push(question);
      question.children.forEach(visit);
    };
    roots.forEach(visit);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const inlineComparison = (
    question: WordQuestionReference,
    block: WordSourceBlock,
    from: number,
    to: number,
  ) => {
    const segment = sourceText(block.content).slice(from, to);
    if (
      question !== root ||
      !/^比较下列各组数的大小[:：]/.test(questionText(question).trim() || segment.trim())
    )
      return;
    const labels = inlineChildLabels(segment);
    const allLabels = [...segment.matchAll(/[（(](\d+)[）)]/g)];
    if (allLabels.length < 2) return;
    const split =
      labels.length === allLabels.length &&
      labels.length <= 10 &&
      labels.every((label, index) => label[1] === String(index + 1)) &&
      labels.every((label, index) => {
        const nodes = sliceSource(
          block.content,
          from + label.index! + label[0].length,
          index + 1 < labels.length ? from + labels[index + 1].index! : to,
        );
        const substantive = nodes.filter((node) => node.type !== 'text' || node.text?.trim());
        return (
          substantive.length >= 3 &&
          substantive[0].type !== 'text' &&
          ['inlineMath', 'blockMath'].includes(substantive[0].type) &&
          typeof substantive[0].attrs?.latex === 'string' &&
          substantive[0].attrs.latex.trim() &&
          substantive[1].type === 'text' &&
          substantive[1].text?.trim() === '和' &&
          ['inlineMath', 'blockMath'].includes(substantive[2].type) &&
          typeof substantive[2].attrs?.latex === 'string' &&
          substantive[2].attrs.latex.trim() &&
          substantive
            .slice(3)
            .every((node) => node.type === 'text' && /^[；;。.]?\s*$/.test(node.text ?? ''))
        );
      });
    if (!split) return { labels, split: false };
    for (const item of blocks.slice(blocks.indexOf(block) + 1)) {
      const text = sourceText(item.content);
      if (
        mainLabel(text) ||
        sectionType(text, item.numbering?.label, item.numbering?.level) ||
        item.numbering?.level === 0
      )
        break;
      const marker = /【答案】|(?:参考)?答案\s*[:：]/.exec(text);
      if (!marker) continue;
      const start = marker.index + marker[0].length;
      const nextMarker = /【(?:解析|分析|详解)】|(?:解析|分析|详解)\s*[:：]/.exec(
        text.slice(start),
      );
      const end = nextMarker ? start + nextMarker.index : text.length;
      const answer = text.slice(start, end);
      const keys = inlineChildLabels(answer);
      const corroborated =
        !answer.slice(0, keys[0]?.index ?? answer.length).trim() &&
        keys.length === labels.length &&
        keys.every(
          (key, index) =>
            key[1] === labels[index][1] &&
            answer
              .slice(
                key.index! + key[0].length,
                index + 1 < keys.length ? keys[index + 1].index! : answer.length,
              )
              .replace(/[；;。.]\s*$/, '')
              .trim(),
        );
      return { labels, split: Boolean(corroborated) };
    }
    return { labels, split: false };
  };
  const inlineTaskEvidence = (
    question: WordQuestionReference,
    block: WordSourceBlock,
    from: number,
    to: number,
  ) => {
    const segment = sourceText(block.content).slice(from, to);
    const labels = inlineChildLabels(segment);
    if (
      labels.length < 2 ||
      !/[=＝×÷]/.test(segment) ||
      !labels.every((label, index) => Number(label[1]) === index + 1)
    )
      return false;
    if (
      ['single_choice', 'multiple_choice'].includes(question.questionType) ||
      /^[（(](?:单选|多选|单项选择|多项选择)[）)]/.test((questionText(question) || segment).trim())
    )
      return false;
    let keyed = false;
    const pool: WordOptionReference[] = [];
    for (const item of blocks.slice(blocks.indexOf(block) + 1, blocks.indexOf(block) + 60)) {
      const value = sourceText(item.content);
      const nativeLetter =
        item.numbering && ['lowerLetter', 'upperLetter'].includes(item.numbering.format ?? '')
          ? numberingLabel(item.numbering.label)
          : undefined;
      if (
        mainLabel(value) ||
        /^\s*[（(]\d+[）)]/.test(value) ||
        sectionType(value, item.numbering?.label, item.numbering?.level) ||
        (item.numbering?.level === 0 && !nativeLetter)
      )
        break;
      if (nativeLetter && /^[A-Za-z]$/.test(nativeLetter))
        pool.push({
          sourceLabel: nativeLetter,
          label: [
            range(item.id, numberingPrefixLength(value, item.numbering!.label), value.length),
          ],
        });
      else pool.push(...readOptions(item, 0));
      const marker = /【答案】|(?:参考)?答案\s*[:：]/.exec(value);
      if (!marker) continue;
      const answer = value
        .slice(marker.index + marker[0].length)
        .split(/【(?:解析|分析|详解)】/)[0];
      if (
        pool.length >= 2 &&
        /^[ \u00a0]*[A-Za-z](?:[\s,，、]*[A-Za-z])*[ \u00a0]*$/.test(answer) &&
        wordChoiceAnswerLabels(answer).every((key) =>
          pool.some((option) => option.sourceLabel.toUpperCase() === key),
        )
      )
        return false;
      const keys = inlineChildLabels(answer);
      keyed =
        keys.length === labels.length &&
        !answer.slice(0, keys[0]?.index ?? answer.length).trim() &&
        keys.every(
          (key, index) =>
            key[1] === labels[index][1] &&
            answer
              .slice(key.index! + key[0].length, keys[index + 1]?.index ?? answer.length)
              .trim(),
        );
      break;
    }
    return (
      keyed ||
      labels.every((label, index) => {
        const start = from + label.index! + label[0].length;
        const end = index + 1 < labels.length ? from + labels[index + 1].index! : to;
        return (
          findWordBlankMarkers(block, start, end, questionText(question)).length > 0 ||
          /[=＝]\s*[；;。.]?\s*$/.test(sourceText(block.content).slice(start, end))
        );
      })
    );
  };
  const sameBlockInlineChoice = (
    question: WordQuestionReference,
    block: WordSourceBlock,
    from: number,
    to: number,
  ) => {
    const value = sourceText(block.content);
    const stem = value.slice(from, to);
    const labels = inlineChildLabels(stem);
    const context = `${questionText(question)} ${stem}`;
    const usesWordBank =
      /(?:所给|词库|词语|单词|word bank|given words)/i.test(context) &&
      /(?:填空|补全|fill|complete)/i.test(context);
    if (
      usesWordBank ||
      labels.length < 2 ||
      !/[=＝×÷]/.test(stem) ||
      !labels.every((label, index) => Number(label[1]) === index + 1) ||
      (explicitlyTyped.has(question) &&
        !['single_choice', 'multiple_choice'].includes(question.questionType))
    )
      return;
    const optionStart = /(?:^|\s)[A-Za-z][.．、)）]/.exec(stem.slice(labels.at(-1)!.index!));
    if (!optionStart) return;
    const at =
      from +
      labels.at(-1)!.index! +
      optionStart.index +
      (optionStart[0].length - optionStart[0].trimStart().length);
    const pool = readOptions(block, at).map((option) => ({
      ...option,
      label: option.label.map((source) => ({
        ...source,
        end: Math.min(source.end ?? value.length, to),
      })),
    }));
    if (!completeLetterPool(pool)) return;
    const ownTail = value.slice(to);
    const tails = [
      { block, text: ownTail },
      ...blocks
        .slice(blocks.indexOf(block) + 1, blocks.indexOf(block) + 60)
        .map((item) => ({ block: item, text: sourceText(item.content) })),
    ];
    const proofPool: WordOptionReference[] = [...pool];
    for (const item of tails) {
      const tail = item.text;
      const nativeLetter =
        item.block !== block &&
        ['lowerLetter', 'upperLetter'].includes(item.block.numbering?.format ?? '')
          ? numberingLabel(item.block.numbering!.label).toUpperCase()
          : undefined;
      const nativeOptionContinuation =
        nativeLetter !== undefined &&
        /^[A-Z]$/.test(nativeLetter) &&
        nativeLetter.charCodeAt(0) === proofPool.at(-1)!.sourceLabel.charCodeAt(0) + 1;
      if (
        (item.block !== block && item.block.numbering?.level === 0 && !nativeOptionContinuation) ||
        mainLabel(tail) ||
        /^\s*[（(]\d+[）)]/.test(tail) ||
        sectionType(
          tail,
          item.block !== block ? item.block.numbering?.label : undefined,
          item.block.numbering?.level,
        )
      )
        return;
      const continuationOptions = nativeOptionContinuation
        ? [
            {
              sourceLabel: nativeLetter,
              label: [
                range(
                  item.block.id,
                  numberingPrefixLength(tail, item.block.numbering!.label),
                  tail.length,
                ),
              ],
            },
          ]
        : item.block !== block
          ? readOptions(item.block, 0)
          : [];
      if (continuationOptions.length) {
        const candidatePool = [
          ...proofPool,
          ...continuationOptions.map((option) => ({
            ...option,
            sourceLabel: option.sourceLabel.toUpperCase(),
          })),
        ];
        if (!completeLetterPool(candidatePool)) return;
        proofPool.push(...candidatePool.slice(proofPool.length));
      }
      const marker = /【答案】|(?:参考)?答案\s*[:：]/.exec(tail);
      if (!marker) {
        if (/【(?:解析|分析|详解)】/.test(tail)) return;
        continue;
      }
      const answer = tail
        .slice(marker.index + marker[0].length)
        .split(/【(?:解析|分析|详解)】/)[0]
        .trim();
      if (
        /^[A-Za-z](?:[\s,，、]*[A-Za-z])*$/.test(answer) &&
        wordChoiceAnswerLabels(answer).every((key) =>
          proofPool.some((option) => option.sourceLabel === key),
        )
      )
        return { at, pool };
      return;
    }
  };
  const combinedKeyAnalysis = (block: WordSourceBlock, end: number, keys: string[]) => {
    let inAnalysis = false;
    const seen: string[] = [];
    const tails = [
      { block, text: sourceText(block.content).slice(end) },
      ...blocks
        .slice(blocks.indexOf(block) + 1, blocks.indexOf(block) + 60)
        .map((item) => ({ block: item, text: sourceText(item.content) })),
    ];
    for (const item of tails) {
      let value = item.text;
      if (!value.trim()) continue;
      if (
        sectionType(value, item.block.numbering?.label, item.block.numbering?.level) ||
        isWordStructuralLabel(value) ||
        /^\s*(?:参考答案|答案与解析|参考答案及解析)\s*$/.test(value)
      )
        return false;
      const marker = /^\s*【(?:解析|分析|详解)】/.exec(value);
      if (marker) {
        inAnalysis = true;
        value = value.slice(marker[0].length);
      } else if (/【答案】|(?:参考)?答案\s*[:：]/.test(value)) return false;
      const label = mainLabel(value);
      if (label) {
        if (!inAnalysis || label[1] !== keys[seen.length] || !value.slice(label[0].length).trim())
          return false;
        seen.push(label[1]);
        if (seen.length === keys.length) return true;
      } else if (
        !inAnalysis ||
        item.block.numbering?.level === 0 ||
        /^\s*[（(]\d+[）)]/.test(value)
      )
        return false;
    }
    return false;
  };
  const pushSurface = (
    question: WordQuestionReference,
    block: WordSourceBlock,
    start: number,
    end: number,
  ) => {
    if (start >= end) return;
    const pushRange = (from: number, to: number) => {
      if (from >= to) return;
      if (surface !== 'question') {
        // Split only labels owned by this material group, retaining original source offsets.
        const text = sourceText(block.content);
        const routeLeadingMath = (start: number) => {
          if (answerAppendix) return;
          const leadingNodes = sliceSource(block.content, start, to);
          const firstNodeIndex = leadingNodes.findIndex(
            (node) => node.type !== 'text' || node.text?.trim(),
          );
          const firstNode = leadingNodes[firstNodeIndex];
          if (
            root &&
            !readingGroups.has(root) &&
            !diagramGroups.has(root) &&
            firstNode &&
            ['inlineMath', 'blockMath'].includes(firstNode.type) &&
            typeof firstNode.attrs?.latex === 'string'
          ) {
            const latex = firstNode.attrs.latex.trim();
            const plain = latex.replace(/\\(?:left|right)/g, '').replace(/[\s{}]/g, '');
            const combined = /^[（(](\d+)[）)]([①②③④⑤⑥⑦⑧⑨⑩])/.exec(plain);
            const combinedParent = combined
              ? root.children.find((child) => child.sourceLabel === combined[1])
              : undefined;
            const combinedChild = combinedParent?.children[0];
            const currentParent = root.children.includes(question) ? question : parentOf(question);
            const currentTopIndex = currentParent ? root.children.indexOf(currentParent) : -1;
            const combinedRest = combined ? plain.slice(combined[0].length) : '';
            if (
              combined &&
              combinedParent &&
              combinedChild?.sourceLabel === combined[2] &&
              ((currentTopIndex >= 0 && root.children.indexOf(combinedParent) > currentTopIndex) ||
                (question === root && combinedParent === root.children[0]) ||
                (combinedParent === currentParent && solutionSequenceStart)) &&
              (combinedRest || sourceText(leadingNodes.slice(firstNodeIndex + 1)).trim()) &&
              !isSolutionOperator(combinedRest) &&
              (combinedRest ||
                !solutionStartsWithOperator(
                  block,
                  start + sourceText(leadingNodes.slice(0, firstNodeIndex)).length + 1,
                  to,
                ))
            ) {
              question = combinedChild;
              current = question;
              solutionParent = combinedParent;
              sharedSolutionOwners = undefined;
              solutionSequenceStart = false;
              return;
            }
            const parenthesis = /^[（(](\d+)[）)]$/.exec(plain);
            const circled = /^([①②③④⑤⑥⑦⑧⑨⑩])(?!\s*[+\-=＝×÷*/])/.exec(latex);
            const label = parenthesis?.[1] ?? circled?.[1];
            const siblingParent = parenthesis
              ? solutionParent?.children.some((child) => child.sourceLabel === label)
                ? solutionParent
                : root
              : solutionParent;
            const siblings = siblingParent?.children;
            const ownerIndex = siblings?.findIndex((child) => child.sourceLabel === label) ?? -1;
            let branch: WordQuestionReference | undefined = question;
            while (branch && branch !== siblingParent && !siblings?.includes(branch))
              branch = parentOf(branch);
            const currentIndex = branch ? (siblings?.indexOf(branch) ?? -1) : -1;
            const rest = sourceText(leadingNodes.slice(firstNodeIndex + 1)).trim();
            const formulaRest = circled ? latex.slice(circled[0].length).trim() : '';
            const atomStart = start + sourceText(leadingNodes.slice(0, firstNodeIndex)).length;
            if (
              label &&
              siblings &&
              ownerIndex >= 0 &&
              (currentIndex >= 0
                ? ownerIndex > currentIndex || (solutionSequenceStart && ownerIndex === 0)
                : question === siblingParent && ownerIndex === 0) &&
              (formulaRest || rest) &&
              !isSolutionOperator(formulaRest || rest) &&
              (formulaRest || !solutionStartsWithOperator(block, atomStart + 1, to))
            ) {
              question = siblings[ownerIndex];
              current = question;
              sharedSolutionOwners = undefined;
              solutionSequenceStart = false;
              if (question.children.length) solutionParent = question;
            }
          }
        };
        routeLeadingMath(from);
        const joint = /^(?:\s*[（(]\d+[）)]){2,}\s*/.exec(text.slice(from, to));
        // Joint drawing keys share their source range, including following image-only blocks.
        if (joint) {
          const labels = [...joint[0].matchAll(/[（(](\d+)[）)]/g)].map((match) => match[1]);
          const siblings = solutionParent?.children ?? root?.children ?? [];
          const owners = labels.map((label) =>
            siblings.find((child) => child.sourceLabel === label),
          );
          if (
            new Set(labels).size === labels.length &&
            owners.every((owner) => owner !== undefined) &&
            (block.content.some((node) => node.type === 'image') ||
              /(?:作图|画|计算|竖式|drawing|draw|division|calculate)/i.test(
                root ? questionText(root) : '',
              ) ||
              /(?:作图|画图|绘图|绘制)(?:如下|如图|见)/.test(
                text.slice(from + joint[0].length, to),
              ) ||
              owners.some((owner) =>
                /请[^。！？\n]{0,60}(?:画出|绘制|标出)|(?:画出|绘制|标出)[^。！？\n]{0,40}(?:图|区域|位置)|作出[^。！？\n]{0,40}(?:垂线|平行线)|^\s*画一条(?:直线|线段|线)/.test(
                  questionText(owner!),
                ),
              ))
          ) {
            sharedSolutionOwners = owners as WordQuestionReference[];
            for (const owner of sharedSolutionOwners)
              if (from + joint[0].length < to)
                owner[surface].push(range(block.id, from + joint[0].length, to));
            return;
          }
        }
        if (sharedSolutionOwners) {
          if (
            !/^\s*(?:[（(]\d+[）)]|\d+(?:\.(?!\d)|[．、])|[①②③④⑤⑥⑦⑧⑨⑩])/.test(text.slice(from, to))
          ) {
            for (const owner of sharedSolutionOwners)
              owner[surface].push(range(block.id, from, to));
            return;
          }
          sharedSolutionOwners = undefined;
        }
        let offset = from;
        let ownershipMarkerSeen = false;
        const ownershipLabels =
          root && englishGroups.has(root)
            ? /(?:^|[ \u00a0]{2,}|\s)(\d+)(?:\.(?!\d)|[．、])\s*|[（(](\d+)[）)]\s*|([①②③④⑤⑥⑦⑧⑨⑩])/g
            : root && diagramGroups.has(root)
              ? /(?:^|[ \u00a0]{2,})(\d+)(?:\.(?!\d)|[．、])\s*|[（(](\d+)[）)]\s*|([①②③④⑤⑥⑦⑧⑨⑩])/g
              : /(?:^|[ \u00a0]{2,})(\d+)[.．、](?!\d)\s*|[（(](\d+)[）)]\s*|([①②③④⑤⑥⑦⑧⑨⑩])/g;
        for (const match of text.slice(from, to).matchAll(ownershipLabels)) {
          const prefix = text.slice(from, from + match.index!);
          if (
            match[1] &&
            surface === 'analysis' &&
            prefix.trim() &&
            root &&
            englishGroups.has(root)
          ) {
            const siblings = root.children;
            const next = siblings[siblings.indexOf(question) + 1];
            const beforeLabel = prefix + match[0].slice(0, match[0].indexOf(match[1]));
            if (
              next?.sourceLabel !== match[1] ||
              !/(?:[.．。！？?!]\s+|[ \u00a0]{2,})$/.test(beforeLabel)
            )
              continue;
          }
          const boundedSolutionPrefix =
            /^\s*解\s*[:：]\s*$/.test(prefix) &&
            !solutionStartsWithOperator(block, from + match.index! + match[0].length, to);
          const prefixNodes = sliceSource(block.content, from, from + match.index!);
          const unavailableSolutionPrefix =
            match[2] &&
            prefixNodes.some((node) => node.type === 'docxUnavailable') &&
            prefixNodes.every(
              (node) =>
                (node.type === 'text' && !node.text?.trim()) ||
                (node.type === 'docxUnavailable' && node.attrs?.reason === 'docx.math.unsupported'),
            );
          if ((match[2] || match[3]) && prefix.trim()) {
            const atBoundary = match[2]
              ? /(?:\s{2}|[.．。；;！？?!]\s*)$/.test(prefix)
              : /(?:\s{2}|[.．。；;！？?!）)]\s*)$/.test(prefix);
            const siblings = solutionParent?.children;
            const currentIndex = siblings?.indexOf(question) ?? -1;
            const terminalMath =
              prefixNodes.at(-1)?.type === 'text' &&
              /^[ \u00a0\u3000]$/.test(prefixNodes.at(-1)!.text ?? '')
                ? prefixNodes.at(-2)
                : prefixNodes.at(-1);
            const terminalLatex =
              typeof terminalMath?.attrs?.latex === 'string' ? terminalMath.attrs.latex.trim() : '';
            const terminalNumber =
              terminalMath &&
              ['inlineMath', 'blockMath'].includes(terminalMath.type) &&
              compactAnswerMathValue.test(terminalLatex);
            const candidateStart = sliceSource(
              block.content,
              from + match.index! + match[0].length,
              to,
            ).find((node) => node.type !== 'text' || node.text?.trim());
            const nextMathAnswer =
              surface === 'answer' &&
              !(root && (readingGroups.has(root) || diagramGroups.has(root))) &&
              ownershipMarkerSeen &&
              currentIndex >= 0 &&
              siblings?.[currentIndex + 1]?.sourceLabel === (match[2] ?? match[3]) &&
              terminalNumber &&
              (match[2] ? /\uFFFC$/.test(prefix) : /\uFFFC[ \u00a0\u3000]$/.test(prefix)) &&
              candidateStart &&
              ['inlineMath', 'blockMath'].includes(candidateStart.type) &&
              !/^(?:[<>＞＜≤≥⇒⇐⇔→←↔∴]|\\(?:le|ge|lt|gt|leq|geq|Rightarrow|Leftarrow|Leftrightarrow|Longrightarrow|implies|iff|to|therefore|approx|because|in|ne)(?![A-Za-z]))/.test(
                String(candidateStart.attrs?.latex ?? '')
                  .trim()
                  .replace(/^\{+\s*/, ''),
              ) &&
              (!solutionStartsWithOperator(block, from + match.index! + match[0].length, to) ||
                /^[-−]\d+(?:\.\d+)?$/.test(String(candidateStart.attrs?.latex ?? '').trim()));
            const nextCompactAnswer =
              surface === 'answer' &&
              match[3] &&
              ownershipMarkerSeen &&
              siblings?.[currentIndex + 1]?.sourceLabel === match[3] &&
              /[\uFFFC\dA-Za-z）)]$/.test(prefix) &&
              !solutionStartsWithOperator(block, from + match.index! + match[0].length, to);
            if (
              !boundedSolutionPrefix &&
              !unavailableSolutionPrefix &&
              !nextCompactAnswer &&
              !nextMathAnswer &&
              (!ownershipMarkerSeen || !atBoundary)
            )
              continue;
          }
          let owner = match[1]
            ? root && readingGroups.has(root)
              ? root.children.find((candidate) => candidate.sourceLabel === match[1])
              : independentSolutionOwners?.find((candidate) => candidate.sourceLabel === match[1])
            : match[2] && !(root && diagramGroups.has(root) && solutionParent === root)
              ? (solutionParent?.children.find((candidate) => candidate.sourceLabel === match[2]) ??
                (!readingGroups.has(root!)
                  ? root?.children.find((candidate) => candidate.sourceLabel === match[2])
                  : undefined))
              : solutionParent?.children.find((candidate) => candidate.sourceLabel === match[3]);
          if (
            !owner &&
            match[3] &&
            !prefix.trim() &&
            root &&
            !readingGroups.has(root) &&
            !diagramGroups.has(root)
          ) {
            const parent = parentOf(question);
            const candidate = parent?.children.find((child) => child.sourceLabel === match[3]);
            if (
              parent &&
              candidate &&
              (parent.children.indexOf(candidate) > parent.children.indexOf(question) ||
                (solutionSequenceStart && candidate === parent.children[0]))
            ) {
              owner = candidate;
              solutionParent = parent;
            }
          }
          if (!owner) continue;
          ownershipMarkerSeen = true;
          solutionSequenceStart = false;
          const at = from + match.index!;
          if (offset < at)
            (boundedSolutionPrefix || unavailableSolutionPrefix ? owner : question)[surface].push(
              range(block.id, offset, at),
            );
          if (match[1] || owner.children.length) solutionParent = owner;
          else if (match[2] && root?.children.includes(owner)) solutionParent = root;
          question = owner;
          current = question;
          offset = at + match[0].length;
          routeLeadingMath(offset);
        }
        if (offset < to) question[surface].push(range(block.id, offset, to));
        return;
      }
      const text = sourceText(block.content);
      solutionSequenceStart = false;
      const segment = text.slice(from, to);
      const labels = inlineChildLabels(segment);
      const localChoice =
        question === root ? sameBlockInlineChoice(question, block, from, to) : undefined;
      if (localChoice) {
        pushQuestion(question, block, from, localChoice.at);
        question.options = [...(question.options ?? []), ...localChoice.pool];
        inferChoiceFromOptions(question);
        return;
      }
      const comparison = inlineComparison(question, block, from, to);
      if (comparison && !comparison.split) {
        pushQuestion(question, block, from, to);
        return;
      }
      const blockIndex = blocks.indexOf(block);
      const nextBoundary = blocks.slice(blockIndex + 1).find((item) => {
        const text = sourceText(item.content);
        return (
          /^\s*[（(]\d+[）)]/.test(text) ||
          mainLabel(text) ||
          /【答案】/.test(text) ||
          sectionType(text, item.numbering?.label, item.numbering?.level)
        );
      });
      const firstInline =
        labels.length === 1 &&
        labels[0].index === 0 &&
        labels[0][1] === '1' &&
        question === root &&
        !question.question.length &&
        mainLabel(text) &&
        nextBoundary &&
        /^\s*[（(]2[）)]/.test(sourceText(nextBoundary.content));
      if (
        root &&
        question === root &&
        !readingGroups.has(root) &&
        !choiceStatementRoots.has(root) &&
        (comparison?.split || inlineTaskEvidence(question, block, from, to) || firstInline)
      ) {
        if (labels[0].index! > 0) pushQuestion(root, block, from, from + labels[0].index!);
        labels.forEach((label, index) => {
          const child = createQuestion(label[1]);
          root!.children.push(child);
          parents.length = 1;
          parents.push(child);
          current = child;
          pushQuestion(
            child,
            block,
            from + label.index! + label[0].length,
            index + 1 < labels.length ? from + labels[index + 1].index! : to,
          );
        });
        return;
      }
      pushQuestion(question, block, from, to);
    };
    const text = sourceText(block.content);
    const rest = text.slice(start, end);
    const marker = /【(答案|解析|分析|详解|导语|点睛)】|(?:参考)?(答案|解析|分析|详解)\s*[:：]/g;
    const matches = [...rest.matchAll(marker)];
    let offset = start;
    for (const match of matches) {
      // A numbered answer can contain an "analysis" subheading as part of its answer.
      if (
        match[2] === '分析' &&
        surface === 'answer' &&
        /(?:^|\s)\d+[.．、]\s*$/.test(rest.slice(0, match.index!))
      )
        continue;
      const at = start + match.index!;
      const precedingOwner = current;
      if (at > offset) pushRange(offset, at);
      const inlineNestedParent =
        match[2] &&
        at > offset &&
        /^\s*(?:[（(]\d+[）)])?\s*[①②③④⑤⑥⑦⑧⑨⑩]/.test(text.slice(start, at))
          ? parentOf(question)
          : undefined;
      surface = (match[1] ?? match[2]) === '答案' ? 'answer' : 'analysis';
      if (surface === 'answer' && root && !readingGroups.has(root)) {
        const keys = [
          ...text
            .slice(at + match[0].length, end)
            .matchAll(/(?:^|[ \u00a0]{2,})(\d+)(?:\.(?!\d)|[．、])\s*/g),
        ].map((key) => key[1]);
        const candidates = roots.slice(-keys.length);
        if (
          keys.length >= 2 &&
          new Set(keys).size === keys.length &&
          candidates.length === keys.length &&
          candidates.every(
            (candidate, index) =>
              candidate.sourceLabel === keys[index] &&
              rootLabels.has(keys[index]) &&
              !candidate.answer.length &&
              !readingGroups.has(candidate),
          ) &&
          candidates.at(-1) === root &&
          keys.every((key, index) => !index || Number(key) === Number(keys[index - 1]) + 1)
        ) {
          const analysisMarker = /【(?:解析|分析|详解)】/.exec(
            text.slice(at + match[0].length, end),
          );
          const tailStart = analysisMarker ? at + match[0].length + analysisMarker.index : end;
          const body = text.slice(at + match[0].length, tailStart);
          const sourceKeys = [...body.matchAll(/(?:^|[ \u00a0]{2,})(\d+)(?:\.(?!\d)|[．、])\s*/g)];
          const sourceContracts =
            sourceKeys.length === candidates.length &&
            sourceKeys.every((key, index) => {
              const candidate = candidates[index];
              const value = body
                .slice(key.index! + key[0].length, sourceKeys[index + 1]?.index ?? body.length)
                .trim();
              if (candidate.questionType === 'fill_in_the_blank' && candidate.blanks?.length)
                return (
                  value.split(/[ \u00a0]{4,}|\t|\n/).filter((part) => part.trim()).length ===
                  candidate.blanks.length
                );
              if (
                ['single_choice', 'multiple_choice'].includes(candidate.questionType) &&
                completeLetterPool(candidate.options ?? []) &&
                /^[A-Za-z](?:[\s,，、]*[A-Za-z])*$/.test(value)
              ) {
                const labels = wordChoiceAnswerLabels(value);
                return (
                  (candidate.questionType !== 'single_choice' || labels.length === 1) &&
                  labels.every((label) =>
                    candidate.options!.some((option) => option.sourceLabel.toUpperCase() === label),
                  )
                );
              }
              return false;
            });
          if (
            sourceContracts ||
            (Number(keys[0]) > 1 && combinedKeyAnalysis(block, tailStart, keys))
          )
            independentSolutionOwners = candidates as WordQuestionReference[];
          else {
            independentSolutionOwners = undefined;
            if (
              !diagnostics.some(
                (item) =>
                  item.code === 'word-import.check-question-boundary' && item.blockId === block.id,
              )
            )
              diagnostics.push({
                code: 'word-import.check-question-boundary',
                severity: 'warning',
                blockId: block.id,
              });
          }
        }
      }
      solutionSequenceStart = !inlineNestedParent || inlineNestedParent === root;
      sharedSolutionOwners = undefined;
      if (root?.children.length) {
        solutionParent =
          inlineNestedParent && inlineNestedParent !== root ? inlineNestedParent : root;
        if (
          root.children.length > 1 &&
          root.children.every((child) => child.blanks?.length && !child.answer.length)
        ) {
          question = root;
          current = root;
        }
      }
      if (root && readingGroups.has(root) && ['导语', '点睛'].includes(match[1] ?? '')) {
        question = root;
        current = root;
      }
      if (root && diagramGroups.has(root) && surface === 'analysis') {
        question = root;
        current = root;
      }
      solutionEnumeration = 0;
      clozeSolutionEnumerationEnd = undefined;
      offset = at + match[0].length;
      if (
        surface === 'answer' &&
        root &&
        !readingGroups.has(root) &&
        root.children.length >= 2 &&
        precedingOwner === root.children.at(-1) &&
        root.children.every((child) => !child.answer.length && !child.analysis.length) &&
        /^\s*见(?:详解|解析|解答)[。.]?\s*$/.test(text.slice(offset, end))
      )
        sharedSolutionOwners = [...root.children];
      if (surface === 'analysis') {
        const enumeration = mainLabel(text.slice(offset, end));
        const firstBlank =
          root && (root.questionType === 'cloze' || englishGroups.has(root))
            ? (root.blanks?.[0]?.sourceLabel ?? englishGroups.get(root)?.range?.[0]?.toString())
            : undefined;
        if (enumeration?.[1] === '1' || (firstBlank && enumeration?.[1] === firstBlank))
          solutionEnumeration = Number(enumeration![1]);
        if (firstBlank && solutionEnumeration)
          clozeSolutionEnumerationEnd =
            enumeration?.[1] === '1' && firstBlank !== '1'
              ? (root!.blanks?.length ??
                englishGroups.get(root!)!.range![1] - englishGroups.get(root!)!.range![0] + 1)
              : Number(root!.blanks?.at(-1)?.sourceLabel ?? englishGroups.get(root!)?.range?.[1]);
      }
    }
    if (offset < end) pushRange(offset, end);
  };
  const diagramMaterialRange = (blockIndex: number): [number, number] | undefined => {
    const first = sourceText(blocks[blockIndex].content).trim();
    if (/^(?:示例[:：]|本题考查|先回顾|可以根据|文中|从第|根据|结合|故选|故答案)/.test(first)) {
      const next = blocks.slice(blockIndex + 1).find((block) => sourceText(block.content).trim());
      const adjacentMedia =
        next &&
        next.content.some((node) => ['image', 'table'].includes(node.type)) &&
        next.content.every(
          (node) =>
            ['image', 'table'].includes(node.type) || (node.type === 'text' && !node.text?.trim()),
        );
      const diagramInstruction =
        first.length <= 100 &&
        /^(?:(?:根据|结合)(?:下图|下表|图示|如图|(?:下面|下列)(?:的)?(?:图|表))|文中[^。！？]{1,30}如下图)[，,：:]?\s*(?:完成(?:下面|下列)?(?:练习|各题|小题|任务)|回答(?:下面|下列)?问题)[。.]?$/.test(
          first,
        );
      const pendingResponses = (question: WordQuestionReference): number => {
        if (question.children.length) {
          const counts = question.children.map(pendingResponses);
          return counts.every(Boolean) ? counts.reduce((sum, count) => sum + count, 0) : 0;
        }
        return ['short_answer', 'fill_in_the_blank'].includes(question.questionType) &&
          !question.answer.length
          ? question.blanks?.length || 1
          : 0;
      };
      const answered = (question: WordQuestionReference): boolean => {
        if (!question.children.length) return choiceAnswerText(question).trim().length > 0;
        if (question.children.every(answered)) return true;
        // Each branch may have its own four-space key waiting for the final allocation pass.
        const responseCount = pendingResponses(question);
        return (
          responseCount > 0 &&
          !/[（(]\d+[）)]|(?:^|[ \u00a0]{4,}|\t|\n)\d+(?:\.(?!\d)|[．、])/.test(
            choiceAnswerText(question),
          ) &&
          answerSpans(question, 4).length === responseCount
        );
      };
      let branch = current;
      while (branch && branch !== root && root && !root.children.includes(branch))
        branch = parentOf(branch);
      const completedAnswerPredecessor =
        surface === 'answer' &&
        root &&
        answered(root) &&
        (current === root || branch === root.children.at(-1));
      if (
        !adjacentMedia ||
        !diagramInstruction ||
        !(completedChinesePredecessor() || completedAnswerPredecessor)
      )
        return;
    }
    const labels: string[] = [];
    let hasMaterial = false;
    for (const block of blocks.slice(blockIndex, blockIndex + 60)) {
      const text = sourceText(block.content);
      if (!text.trim()) continue;
      const answer = /^\s*【答案】([\s\S]*)$/.exec(text);
      if (answer) {
        const keyLabels = [
          ...answer[1].matchAll(/(?:^|[ \u00a0]{2,})(\d+)(?:\.(?!\d)|[．、])\s*/g),
        ].map((match) => match[1]);
        if (
          hasMaterial &&
          labels.length >= 2 &&
          mainLabel(answer[1]) &&
          keyLabels.length === labels.length &&
          labels.every((label, index) => label === keyLabels[index])
        )
          return [Number(labels[0]), Number(labels.at(-1))];
        return;
      }
      if (
        /【(?:答案|解析|分析|详解|导语|点睛)】|(?:参考)?(?:答案|解析|分析|详解)\s*[:：]/.test(
          text,
        ) ||
        sectionType(text, block.numbering?.label, block.numbering?.level) ||
        isWordStructuralLabel(text) ||
        isWordQuizHeader(text)
      )
        return;
      const task = mainLabel(text);
      if (task) {
        if (labels.length && Number(task[1]) <= Number(labels.at(-1))) return;
        labels.push(task[1]);
      } else if (!labels.length) {
        if (block.numbering || /^\s*[（(]\d+[）)]/.test(text)) return;
        hasMaterial ||= block.content.some((node) => ['image', 'table'].includes(node.type));
      }
    }
  };
  const chineseAnalysisStart = (value: string) =>
    /^(?:示例[:：]|本题考查|先回顾|可以根据|文中|从第|根据|结合|故选|故答案)/.test(value.trim());
  const chineseReadingHeading = (value: string) =>
    /^(?:(?:课内外对比|课内|课外|快乐|古文)?阅读(?:与理解|理解|实践)?[。.:：]?(?:[（(]\d+[）)])?|阅读[^。！？]{0,50}[，,。](?:完成(?:第)?(?:小题|练习|问题)|回答(?:下面的|后面的)?问题)[。.]?|读[^。！？]{0,50}[，,](?:完成练习|回答(?:下面的|后面的)?问题)[。.]?)$/.test(
      value.trim(),
    );
  const completedChinesePredecessor = () => {
    if (!root) return true;
    if (surface !== 'analysis') return false;
    const covered = (q: WordQuestionReference): boolean =>
      q.answer.length > 0 || (q.children.length > 0 && q.children.every(covered));
    const terminal = root.children.at(-1) ?? root;
    let branch = current;
    while (branch && branch !== root && !root.children.includes(branch)) branch = parentOf(branch);
    return (
      covered(root) &&
      (branch === terminal || current === root) &&
      (terminal.analysis.length > 0 || root.analysis.length > 0)
    );
  };
  // A new Chinese material must prove its source start, consecutive tasks, and complete keys.
  const chineseMaterialRange = (blockIndex: number): [number, number] | undefined => {
    const first = blocks[blockIndex];
    const value = sourceText(first.content).trim();
    if (
      first.numbering ||
      mainLabel(value) ||
      chineseAnalysisStart(value) ||
      /【(?:答案|解析|分析|详解|导语|点睛)】/.test(value) ||
      !completedChinesePredecessor()
    )
      return;
    const future = blocks.slice(blockIndex + 1, blockIndex + 100);
    const next = future.find((item) => sourceText(item.content).trim());
    const nextValue = next ? sourceText(next.content).trim() : '';
    const title =
      value.length >= 2 &&
      value.length <= 40 &&
      /[\p{Script=Han}]/u.test(value) &&
      !/[。！？：:,，]/.test(value) &&
      !findWordBlankMarkers(first).length;
    const pureImage =
      first.content.length > 0 && first.content.every((node) => node.type === 'image');
    const imageTitle =
      pureImage &&
      next &&
      sourceText(next.content).trim().length <= 40 &&
      !/[。！？：:,，]/.test(nextValue) &&
      /[\p{Script=Han}]/u.test(nextValue);
    const materialAfterTitle = imageTitle
      ? future.slice(future.indexOf(next!) + 1).find((item) => sourceText(item.content).trim())
      : next;
    const numberedParagraph =
      materialAfterTitle &&
      /^\s*①[\p{Script=Han}“「]/u.test(sourceText(materialAfterTitle.content));
    const selectedMaterial =
      /^选文[一二甲乙]\s*[:：]/.test(value) || /^【(?:甲|材料一|文段一)】$/.test(value);
    const heading = chineseReadingHeading(value);
    const sharedImage = pureImage && next && mainLabel(nextValue) && /的话(?:中)?/.test(nextValue);
    if (
      !(
        heading ||
        selectedMaterial ||
        (title && numberedParagraph) ||
        (pureImage && imageTitle && numberedParagraph) ||
        sharedImage
      )
    )
      return;
    const labels: string[] = [];
    let material = selectedMaterial || !!numberedParagraph || !!sharedImage;
    let materialCharacters = 0;
    let inAnswer = false;
    let key = '';
    for (const item of blocks.slice(blockIndex + 1, blockIndex + 100)) {
      const text = sourceText(item.content);
      if (!text.trim()) continue;
      const answer = /^\s*【答案】([\s\S]*)$/.exec(text);
      if (answer) {
        if (inAnswer) return;
        inAnswer = true;
        key += answer[1];
        continue;
      }
      if (inAnswer) {
        if (
          /【(?:解析|分析|详解|导语|点睛)】/.test(text) ||
          sectionType(text, item.numbering?.label, item.numbering?.level) ||
          isWordStructuralLabel(text)
        )
          break;
        key += `\n${text}`;
        continue;
      }
      if (
        /【(?:解析|分析|详解|导语|点睛)】/.test(text) ||
        sectionType(text, item.numbering?.label, item.numbering?.level) ||
        isWordStructuralLabel(text)
      )
        return;
      if (
        !labels.length &&
        (chineseReadingHeading(text) ||
          (text.length <= 100 &&
            /阅读/.test(text) &&
            /完成(?:下面|下列)?(?:小题|各题|题目|问题|任务)|回答问题/.test(text)))
      )
        return;
      const task = mainLabel(text);
      if (task) {
        if (labels.length && Number(task[1]) !== Number(labels.at(-1)) + 1) return;
        if (sharedImage && !/的话(?:中)?/.test(text)) return;
        labels.push(task[1]);
      } else if (!labels.length) {
        if (chineseAnalysisStart(text) || item.numbering || /^[（(]\d+[）)]/.test(text.trim()))
          return;
        materialCharacters += (text.match(/[\p{Script=Han}]/gu) ?? []).length;
        material ||= /^\s*①[\p{Script=Han}“「]/u.test(text) || materialCharacters >= 40;
      }
    }
    const keys = [...key.matchAll(/(?:^|[ \u00a0]{2,}|\n)(\d+)(?:\.(?!\d)|[．、])\s*/g)].map(
      (match) => match[1],
    );
    if (
      material &&
      labels.length >= 2 &&
      keys.length === labels.length &&
      keys.every((label, index) => label === labels[index])
    )
      return [Number(labels[0]), Number(labels.at(-1))];
  };
  const provedScaffold = (blockIndex: number, owner: WordQuestionReference) => {
    if (!/(?:照样子|仿照|(?:^|[。；;：:\s])例\s*[:：])/.test(questionText(owner))) return false;
    const first = blocks[blockIndex];
    const firstValue = sourceText(first.content);
    if (
      !/^\s*[（(]1[）)]/.test(firstValue) ||
      /[？?]/.test(firstValue) ||
      findWordBlankMarkers(first).length
    )
      return false;
    let slots = 0;
    let expected = 1;
    let tasksEnded = false;
    for (const item of blocks.slice(blockIndex, blockIndex + 60)) {
      const value = sourceText(item.content);
      if (!value.trim()) continue;
      const answer = /^\s*【答案】([\s\S]*)$/.exec(value);
      if (answer) {
        const leading = mainLabel(answer[1]);
        if (leading && leading[1] !== owner.sourceLabel) return false;
        const rest = answer[1].slice(leading?.[0].length ?? 0);
        const next = /[ \u00a0]{2,}\d+(?:\.(?!\d)|[．、])/.exec(rest);
        const key = rest.slice(0, next?.index ?? rest.length);
        if (/[（(]\d+[）)]/.test(key)) return false;
        const values = key
          .trim()
          .split(/[ \u00a0]{2,}|\t|\n/)
          .filter(Boolean);
        return expected > 2 && slots > 0 && values.length === slots;
      }
      if (/【(?:解析|分析|详解|导语|点睛)】/.test(value)) return false;
      if (mainLabel(value)) tasksEnded = true;
      if (tasksEnded) continue;
      const label = /^\s*[（(](\d+)[）)]/.exec(value);
      if (!label || Number(label[1]) !== expected++) return false;
      slots += findWordBlankMarkers(item).length;
    }
    return false;
  };
  const provedCommandPrelude = (blockIndex: number): string | undefined => {
    const first = blocks[blockIndex];
    const value = sourceText(first.content).trim();
    if (
      !root ||
      current !== root ||
      readingGroups.has(root) ||
      root.questionType === 'cloze' ||
      englishGroups.has(root) ||
      !root.sourceLabel ||
      !completedChinesePredecessor() ||
      first.numbering ||
      mainLabel(value) ||
      !first.content.every((node) => node.type === 'text') ||
      value.length > 80 ||
      chineseAnalysisStart(value) ||
      findWordBlankMarkers(first).length ||
      !/[\p{Script=Han}][。.]\s*(?:按要求|请)完成练习[。.]?$/u.test(value)
    )
      return;
    const future = blocks.slice(blockIndex + 1, blockIndex + 60);
    const next = future.find((item) => sourceText(item.content).trim());
    const nextLabel = next ? mainLabel(sourceText(next.content))?.[1] : undefined;
    if (
      !next ||
      !nextLabel ||
      nextLabel !== String(Number(root.sourceLabel) + 1) ||
      rootLabels.has(nextLabel) ||
      Number(nextLabel) === solutionEnumeration + 1 ||
      (next.numbering !== undefined && next.numbering.level !== 0)
    )
      return;
    const labels: string[] = [];
    let key = '';
    let inAnswer = false;
    for (const item of future) {
      const text = sourceText(item.content);
      if (!text.trim()) continue;
      const answer = /^\s*【答案】([\s\S]*)$/.exec(text);
      if (answer) {
        if (inAnswer) return;
        inAnswer = true;
        key += answer[1];
        continue;
      }
      if (/【(?:解析|分析|详解|导语|点睛)】/.test(text)) {
        if (inAnswer) break;
        return;
      }
      if (
        sectionType(text, item.numbering?.label, item.numbering?.level) ||
        isWordStructuralLabel(text) ||
        chineseReadingHeading(text)
      )
        return;
      if (inAnswer) key += `\n${text}`;
      else {
        const task = mainLabel(text);
        if (task) {
          if (labels.length && Number(task[1]) !== Number(labels.at(-1)) + 1) return;
          labels.push(task[1]);
        }
      }
    }
    const keys = [...key.matchAll(/(?:^|[ \u00a0]{2,}|\n)(\d+)(?:\.(?!\d)|[．、])\s*/g)].map(
      (match) => match[1],
    );
    return labels.length >= 2 &&
      labels.length === keys.length &&
      labels.every((label, index) => label === keys[index])
      ? next.id
      : undefined;
  };
  const nestedEnglishText = (nodes: RichTextNode[]): string =>
    nodes
      .map((node) =>
        node.type === 'text' ? (node.text ?? '') : nestedEnglishText(node.content ?? []),
      )
      .join('');
  const englishDominant = (value: string): boolean => {
    const material = value.replace(/[（(][^）)]*[\u4e00-\u9fff][^）)]*[）)]/g, '');
    const words = material.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) ?? [];
    return (
      words.filter((word) => /[a-z]/.test(word)).length >= 3 &&
      words.join('').length > (material.match(/[\u4e00-\u9fff]/g)?.length ?? 0) * 2
    );
  };
  const englishQuotedContinuation = (value: string) =>
    /^\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:said|says|wrote)\s*[,，:：]?\s*(?:“[^”]*”|"[^"]*"|'[^']*'|‘[^’]*’)[.!。]?\s*$/i.test(
      value,
    );
  const englishExplicitAnalysisLanguage = (value: string) =>
    /^\s*(?:This|That|The)\s+(?:sentence|paragraph|explanation|analysis)\s+(?:explains?|quotes?)\s+(?:the\s+)?(?:original|previous)\s+(?:answer|solution|question)\b/i.test(
      value,
    ) ||
    /根据|可知|考查|意为|表示|句意[:：]|故选|故答案/.test(value.replace(/[“"‘][^”"’]*[”"’]/g, ''));
  const englishAnalysisLanguage = (value: string) =>
    englishQuotedContinuation(value) || englishExplicitAnalysisLanguage(value);
  const emptyEnglishTip = (block: WordSourceBlock) =>
    block.content.every((node) => node.type === 'text') &&
    sourceText(block.content).trim() === '【点睛】';
  const completeEnglishGroupState = () => {
    const lastChild = root?.children.at(-1);
    const lastLabel =
      root?.blanks?.at(-1)?.sourceLabel ??
      (root ? englishGroups.get(root)?.range?.[1]?.toString() : undefined);
    return (
      (lastChild === current && !!lastChild?.analysis.length) ||
      (lastLabel !== undefined &&
        solutionEnumeration === (clozeSolutionEnumerationEnd ?? Number(lastLabel)))
    );
  };
  const shortEnglishInstruction = (value: string) =>
    value.length <= 220 &&
    /选出|填入|选择|填空|补全/.test(value) &&
    !englishAnalysisLanguage(value.replace(/^\s*(?:请)?根据(?:短文|材料|文章)内容[，,]?/, ''));
  const completeLetterPool = (options: WordOptionReference[]) =>
    options.length >= 2 &&
    options.every(
      (option, index) =>
        option.sourceLabel === String.fromCharCode(65 + index) &&
        projectedOptionText(option).trim(),
    );
  const projectedOptionText = (option: WordOptionReference) =>
    option.label
      .map((ref) => {
        const content = blocks.find((b) => b.id === ref.blockId)!.content;
        return sourceText(
          sliceSource(content, ref.start ?? 0, ref.end ?? sourceText(content).length),
        );
      })
      .join('');
  // Structural evidence is source-local; callers apply parser-state boundaries separately.
  const englishMaterialEvidence = (blockIndex: number, legacyFresh = false) => {
    const first = blocks[blockIndex];
    const firstText = sourceText(first.content);
    if (
      first.numbering ||
      mainLabel(firstText) ||
      isWordStructuralLabel(firstText) ||
      /【(?:答案|解析|分析|详解|导语|点睛)】|句意[:：]|故答案|故选/.test(firstText)
    )
      return;
    const speakerLine =
      firstText.trim().length <= 80 &&
      /^[A-Z][a-z]+(?:[ -][A-Z][a-z]+)*,\s*(?:[A-Z][a-z]+(?:[ -][A-Z][a-z]+)*|the (?:USA|UK))$/.test(
        firstText.trim(),
      );
    const nextMaterial = speakerLine
      ? blocks.slice(blockIndex + 1).find((item) => sourceText(item.content).trim())
      : undefined;
    const speakerPrelude =
      !!nextMaterial &&
      !nextMaterial.numbering &&
      !mainLabel(sourceText(nextMaterial.content)) &&
      !isWordStructuralLabel(sourceText(nextMaterial.content)) &&
      !englishAnalysisLanguage(sourceText(nextMaterial.content)) &&
      englishDominant(nestedEnglishText(nextMaterial.content));
    const titleWords = firstText.match(/[A-Z]+/g) ?? [];
    const uppercaseTitle =
      first.content.every((node) => node.type === 'text') &&
      firstText.trim().length <= 60 &&
      /^[A-Z &'\-:,]+$/.test(firstText.trim()) &&
      titleWords.length >= 2 &&
      titleWords.some((word) => word.length >= 4);
    const titleMaterial = uppercaseTitle
      ? blocks.slice(blockIndex + 1).find((item) => sourceText(item.content).trim())
      : undefined;
    const titlePrelude =
      !!titleMaterial &&
      !titleMaterial.numbering &&
      !mainLabel(sourceText(titleMaterial.content)) &&
      !isWordStructuralLabel(sourceText(titleMaterial.content)) &&
      !englishAnalysisLanguage(sourceText(titleMaterial.content)) &&
      englishDominant(nestedEnglishText(titleMaterial.content));
    const instruction = /阅读|读一读|选择|选词|填空|补全|判断|完成|情景对话|Read and choose/i.test(
      firstText,
    );
    const freshCloze =
      legacyFresh && findWordBlankMarkers(first).some((blank) => blank.sourceLabel);
    const legacy = firstText.length <= 220 && (instruction || freshCloze);
    const legacySharedFallback = legacy && instruction && !freshCloze;
    const sentenceCompletion = /补全(?:短文|文章|对话)|(?:选出|选择).*句子|填入(?:空白|文中)/.test(
      firstText,
    );
    const introductory = shortEnglishInstruction(firstText);
    if (
      !legacy &&
      !introductory &&
      !speakerPrelude &&
      !titlePrelude &&
      !englishDominant(nestedEnglishText(first.content)) &&
      !first.content.some((node) => ['image', 'table'].includes(node.type))
    )
      return;
    if (
      (!legacy || englishQuotedContinuation(firstText)) &&
      englishAnalysisLanguage(firstText) &&
      !introductory
    )
      return;
    const tasks: string[] = [];
    const blanks: string[] = [];
    const rows: string[] = [];
    let tableLabels: string[] = [];
    let hasEnglish = false;
    let answerStarted = false;
    let answerEnd = -1;
    let keyText = '';
    let strictKeyBodies = true;
    let material = '';
    let sharedPool: WordOptionReference[] = [];
    const sharedMaterialEnds = new Map<string, number>();
    let poolStarted = false;
    let sharedOrderValid = true;
    let activeRowLabel: string | undefined;
    const rowContinuationBlocks = new Set<string>();
    let adjacentPrefix =
      !legacy &&
      (introductory ||
        (!englishDominant(nestedEnglishText(first.content)) &&
          first.content.some((node) => ['image', 'table'].includes(node.type))));
    const taskPools = new Map<string, WordOptionReference[]>();
    const rowPools = new Map<string, WordOptionReference[]>();
    const keyLabels = (value: string) => [
      ...value.matchAll(/(?:^|\s)(\d+)(?:\.(?!\d)|[．、])\s*/g),
    ];
    const keyContent = (value: string) =>
      value.split(/【(?:解析|分析|详解|导语|点睛)】|(?:解析|分析|详解)\s*[:：]/, 1)[0];
    const appendKey = (value: string): boolean => {
      const content = keyContent(value);
      const matches = keyLabels(content);
      const expected = tasks.length ? tasks : tableLabels.length ? tableLabels : blanks;
      const previous = keyLabels(keyText).length;
      if (!matches.length || content.slice(0, matches[0].index).trim()) return false;
      if (
        (!legacy || !tableLabels.length) &&
        matches.some((match, index) => match[1] !== expected[previous + index])
      )
        return false;
      if (
        matches.some((match, index) => {
          const key = content
            .slice(match.index! + match[0].length, matches[index + 1]?.index ?? content.length)
            .trim();
          const strict = /^[A-Z]$/.test(key);
          strictKeyBodies &&= strict;
          return !key || (!legacy && !strict);
        })
      )
        return false;
      if (content !== value && previous + matches.length < expected.length) return false;
      keyText += `${keyText ? '\n' : ''}${content}`;
      return true;
    };
    const tableBlanks = (nodes: RichTextNode[]): string[] =>
      nodes.flatMap((node) =>
        node.type === 'paragraph'
          ? findWordBlankMarkers({ id: first.id, content: node.content ?? [] }).flatMap((blank) =>
              blank.sourceLabel ? [blank.sourceLabel] : [],
            )
          : tableBlanks(node.content ?? []),
      );
    for (const [index, item] of blocks.slice(blockIndex, blockIndex + 60).entries()) {
      const value = sourceText(item.content);
      if (!value.trim()) continue;
      const marker = /^\s*【答案】([\s\S]*)$/.exec(value);
      if (marker) {
        if (answerStarted) break;
        answerStarted = true;
        answerEnd = blockIndex + index;
        if (marker[1].trim()) {
          if (!appendKey(marker[1])) return;
          const expected = tasks.length ? tasks : tableLabels.length ? tableLabels : blanks;
          if (keyLabels(keyText).length >= expected.length) break;
        }
        continue;
      }
      if (answerStarted) {
        if (!mainLabel(value) || !appendKey(value)) return;
        answerEnd = blockIndex + index;
        const expected = tasks.length ? tasks : tableLabels.length ? tableLabels : blanks;
        if (keyLabels(keyText).length >= expected.length) break;
        continue;
      }
      if (
        index &&
        (isWordStructuralLabel(value) || /^\s*【(?:解析|分析|详解|导语|点睛)】/.test(value))
      )
        return;
      if (/^\s*[（(]\d+[）)]/.test(value)) return;
      if (!legacy && !tasks.length && !blanks.length && !tableLabels.length && !poolStarted) {
        if (englishExplicitAnalysisLanguage(value) && !shortEnglishInstruction(value)) return;
        if (adjacentPrefix && englishQuotedContinuation(value)) return;
        if (index && adjacentPrefix) {
          if (englishDominant(nestedEnglishText(item.content))) adjacentPrefix = false;
          else if (
            !shortEnglishInstruction(value) &&
            !item.content.some((node) => ['image', 'table'].includes(node.type))
          )
            return;
        }
      }
      hasEnglish ||= /[A-Za-z]{2,}(?:\s|['’:])/.test(nestedEnglishText(item.content));
      const optionRow = /^\s*(\d+)[.．、)）]\s*(?=[A-Za-z][.．、)）])/.exec(value);
      if (optionRow) {
        if (poolStarted) {
          if (!legacySharedFallback) return;
          sharedOrderValid = false;
        }
        rows.push(optionRow[1]);
        rowPools.set(optionRow[1], readOptions(item, optionRow[0].length));
        activeRowLabel = optionRow[1];
        continue;
      }
      const task = mainLabel(value);
      if (task) {
        if (poolStarted) {
          if (!legacySharedFallback) return;
          sharedOrderValid = false;
        }
        tasks.push(task[1]);
        activeRowLabel = undefined;
      } else {
        if (tasks.length && instruction && /阅读|读一读|根据.*(?:选择|判断)|选词填空/.test(value))
          return;
        const labelledMarkers = findWordBlankMarkers(item).filter((blank) => blank.sourceLabel);
        const itemBlanks = labelledMarkers.map((blank) => blank.sourceLabel!);
        if (poolStarted && itemBlanks.length) {
          if (!legacySharedFallback) return;
          sharedOrderValid = false;
        }
        blanks.push(...itemBlanks);
        const tables = item.content.filter((node) => node.type === 'table');
        if (tables.length) {
          const slots = tableBlanks(tables);
          if (poolStarted && slots.length) {
            if (!legacySharedFallback) return;
            sharedOrderValid = false;
          }
          tableLabels.push(...slots);
        }
        let options = readOptions(item, 0);
        let poolStart = 0;
        const lastMarker = labelledMarkers.at(-1);
        const lastMarkerEnd = lastMarker?.end ?? value.length;
        if (lastMarker && !tasks.length) {
          if (options.length && (options[0].label[0].start ?? 0) < lastMarkerEnd) {
            if (!legacySharedFallback) return;
            sharedOrderValid = false;
          }
          const trailing = /(?:^|\s)(A[.．、)）]\s*)/.exec(value.slice(lastMarkerEnd));
          if (trailing) {
            poolStart = lastMarkerEnd + trailing.index + trailing[0].indexOf(trailing[1]);
            options = readOptions(item, poolStart);
          }
        }
        if (!options.length || itemBlanks.length || tables.length) activeRowLabel = undefined;
        if (options.length && tasks.length) {
          const last = tasks.at(-1)!;
          taskPools.set(last, [...(taskPools.get(last) ?? []), ...options]);
        } else if (options.length && rows.length) {
          const previous = activeRowLabel ? rowPools.get(activeRowLabel) : undefined;
          if (previous && completeLetterPool([...previous, ...options])) {
            rowPools.set(activeRowLabel!, [...previous, ...options]);
            rowContinuationBlocks.add(item.id);
          } else activeRowLabel = undefined;
        } else if (options.length && (blanks.length || tableLabels.length)) {
          poolStarted = true;
          sharedPool.push(...options);
          if (lastMarker && poolStart >= lastMarkerEnd) {
            sharedMaterialEnds.set(item.id, poolStart);
            material += ` ${nestedEnglishText(sliceSource(item.content, 0, poolStart))}`;
          }
        } else if (
          !tasks.length &&
          !poolStarted &&
          !(index === 0 && introductory) &&
          !(!legacy && shortEnglishInstruction(value))
        ) {
          material += ` ${nestedEnglishText(item.content)}`;
        }
      }
    }
    if (!answerStarted || !hasEnglish) return;
    const keys = [...keyText.matchAll(/(?:^|\s)(\d+)(?:\.(?!\d)|[．、])\s*/g)].map(
      (match) => match[1],
    );
    const labels = tasks.length ? tasks : tableLabels.length ? tableLabels : blanks;
    const consecutive =
      labels.length >= 2 &&
      labels.every((label, index) => Number(label) === Number(labels[0]) + index);
    const exact =
      keys.length === labels.length && keys.every((key, index) => key === labels[index]);
    if (!consecutive || (!exact && (!legacy || !tableLabels.length))) return;
    if (
      rows.length &&
      (rows.length !== blanks.length || rows.some((label, index) => label !== blanks[index]))
    )
      return;
    const keyValues = [...keyText.matchAll(/(?:^|\s)(\d+)(?:\.(?!\d)|[．、])\s*([A-Z])(?=\s|$)/g)];
    const sharedCandidate = sharedPool.length > 0 && !tasks.length && !rows.length;
    const shared =
      sharedCandidate &&
      strictKeyBodies &&
      !(legacySharedFallback && tableLabels.length && !sentenceCompletion) &&
      sharedOrderValid &&
      exact &&
      englishDominant(material) &&
      keyValues.length === labels.length &&
      completeLetterPool(sharedPool) &&
      sharedPool.length >= labels.length &&
      keyValues.every((key) => sharedPool.some((o) => o.sourceLabel === key[2]));
    if (sharedCandidate && !shared && !legacySharedFallback) return;
    const structural = !legacy || shared;
    if (speakerPrelude && (!structural || !tasks.length)) return;
    if (
      titlePrelude &&
      !legacy &&
      (!structural || !tasks.length || blanks.length || tableLabels.length)
    )
      return;
    if (structural) {
      if (!exact || !englishDominant(material) || keyValues.length !== labels.length) return;
      if (tasks.length) {
        if (blanks.length || tableLabels.length) return;
        if (
          !tasks.every((label, index) => {
            const options = (taskPools.get(label) ?? []).filter((option) =>
              /^[A-Z]$/.test(option.sourceLabel),
            );
            return (
              completeLetterPool(options) &&
              options.some((o) => o.sourceLabel === keyValues[index][2])
            );
          })
        )
          return;
      } else if (rows.length) {
        if (
          !rows.every(
            (label, index) =>
              completeLetterPool(rowPools.get(label) ?? []) &&
              rowPools.get(label)!.some((o) => o.sourceLabel === keyValues[index][2]),
          )
        )
          return;
      } else if (
        !shared ||
        !completeLetterPool(sharedPool) ||
        sharedPool.length < labels.length ||
        !keyValues.every((key) => sharedPool.some((o) => o.sourceLabel === key[2]))
      )
        return;
    }
    if (freshCloze && (!rows.length || tasks.length) && !shared) return;
    const group = {
      kind: tasks.length
        ? ('tasks' as const)
        : tableLabels.length
          ? ('table' as const)
          : rows.length || shared
            ? ('cloze' as const)
            : ('fill' as const),
      range: [Number(labels[0]), Number(labels.at(-1))] as [number, number],
      end: answerEnd,
      judgement: /判断|正[（(]T[）)]|对错|是[（(]T[）)]否/i.test(firstText),
      ambiguous: !exact,
      structural,
      speakerPrelude,
      titlePrelude: titlePrelude && !legacy,
      sharedPool: shared ? sharedPool : undefined,
      sharedMaterialEnds: shared ? sharedMaterialEnds : undefined,
      rowPools: rows.length ? rowPools : undefined,
      rowContinuationBlocks: rows.length ? rowContinuationBlocks : undefined,
    };
    return {
      ...group,
      legacyFallback:
        legacySharedFallback && shared
          ? {
              ...group,
              kind: tableLabels.length ? ('table' as const) : ('fill' as const),
              structural: false,
              sharedPool: undefined,
              sharedMaterialEnds: undefined,
            }
          : undefined,
    };
  };
  const englishMaterialGroup = (blockIndex: number) => {
    const evidence = englishMaterialEvidence(
      blockIndex,
      type === 'cloze' && surface !== 'question',
    );
    if (!evidence || !evidence.structural || surface === 'question') return evidence;
    let previous = blocks
      .slice(0, blockIndex)
      .reverse()
      .find((b) => sourceText(b.content).trim());
    let precedingIndex = blockIndex - 1;
    let earliestTip: WordSourceBlock | undefined;
    while (precedingIndex >= 0) {
      const preceding = blocks[precedingIndex];
      if (!sourceText(preceding.content).trim()) {
        precedingIndex--;
        continue;
      }
      if (!emptyEnglishTip(preceding)) break;
      earliestTip = preceding;
      precedingIndex--;
    }
    const saved = earliestTip ? englishEmptyTipStates.get(earliestTip) : undefined;
    const priorState = saved?.root === root ? saved : undefined;
    if (priorState) previous = blocks[precedingIndex];
    if (
      evidence.titlePrelude &&
      root &&
      englishGroups.has(root) &&
      !priorState &&
      !completeEnglishGroupState()
    )
      return;
    const lastBlank =
      root?.blanks?.at(-1)?.sourceLabel ??
      (priorState && root ? englishGroups.get(root)?.range?.[1]?.toString() : undefined);
    const completedEnumeration =
      lastBlank !== undefined &&
      (priorState ? priorState.enumeration : solutionEnumeration) ===
        ((priorState ? priorState.enumerationEnd : clozeSolutionEnumerationEnd) ??
          Number(lastBlank));
    const lastChild = root?.children.at(-1);
    const completedSolution =
      !!previous &&
      /(?:故选\s*[A-G]|故填|故答案(?:为)?)[^\n]*[。.]?\s*$/.test(sourceText(previous.content));
    if (evidence.speakerPrelude) return completedSolution ? evidence : undefined;
    if (
      !previous ||
      completedSolution ||
      completedEnumeration ||
      (lastChild === (priorState ? priorState.current : current) && !!lastChild?.analysis.length)
    )
      return evidence;
    return evidence.legacyFallback;
  };
  const workbookHeading =
    /^(?:[一二三四五六七八九十]+[、.．]\s*)?(?:完成句子|语法填空)\s*[:：。]?$/;
  const contextualWorkbookHeading = (blockIndex: number) => {
    const heading = blocks[blockIndex];
    if (
      !heading.content.every((node) => node.type === 'text') ||
      heading.numbering ||
      sourceText(heading.content).trim().length > 40 ||
      !workbookHeading.test(sourceText(heading.content).trim())
    )
      return false;
    const following = blocks.slice(blockIndex + 1, blockIndex + 13);
    const first = following.findIndex((block) => sourceText(block.content).trim());
    if (first < 0) return false;
    const task = following[first];
    if (!mainLabel(sourceText(task.content)) || englishAnalysisLanguage(sourceText(task.content)))
      return false;
    let taskBlank = false;
    for (const [index, block] of following.slice(first).entries()) {
      const value = sourceText(block.content).trim();
      if (!value) continue;
      const answer = /^【答案】([\s\S]*)$/.exec(value);
      if (answer)
        return taskBlank && !!answer[1].split(/【(?:解析|分析|详解|导语|点睛)】/, 1)[0].trim();
      if (
        (index && (mainLabel(value) || block.numbering)) ||
        workbookHeading.test(value) ||
        isWordStructuralLabel(value) ||
        /^【(?:解析|分析|详解|导语|点睛)】/.test(value)
      )
        return false;
      taskBlank ||= findWordBlankMarkers(block).length > 0;
    }
    return false;
  };
  for (const [blockIndex, block] of blocks.entries()) {
    const text = sourceText(block.content);
    if (!text.trim()) continue;
    // The live marker handler still owns any following tip body and numbering restart.
    if (root && englishGroups.has(root) && emptyEnglishTip(block) && completeEnglishGroupState())
      englishEmptyTipStates.set(block, {
        root,
        current,
        enumeration: solutionEnumeration,
        enumerationEnd: clozeSolutionEnumerationEnd,
      });
    if (isWordQuizHeader(text)) {
      current = undefined;
      root = undefined;
      parents.length = 0;
      type = 'short_answer';
      explicitType = false;
      surface = 'question';
      answerAppendix = false;
      appendixRoot = undefined;
      rootLabels.clear();
      solutionParent = undefined;
      sharedSolutionOwners = undefined;
      continue;
    }
    const englishGroup =
      !root || blockIndex > (englishGroups.get(root)?.end ?? -1)
        ? englishMaterialGroup(blockIndex)
        : undefined;
    if (englishGroup) {
      current = newQuestion(
        englishGroup.kind === 'cloze'
          ? 'cloze'
          : englishGroup.kind === 'fill'
            ? 'fill_in_the_blank'
            : 'short_answer',
      );
      roots.push(current);
      root = current;
      englishGroups.set(current, {
        end: englishGroup.end,
        judgement: englishGroup.judgement,
        ...(englishGroup.kind === 'table' ? { range: englishGroup.range } : {}),
      });
      if (englishGroup.sharedPool) englishPools.set(current, englishGroup.sharedPool);
      if (englishGroup.sharedMaterialEnds)
        englishPoolMaterialEnds.set(current, englishGroup.sharedMaterialEnds);
      if (englishGroup.rowPools) englishRowPools.set(current, englishGroup.rowPools);
      if (englishGroup.rowContinuationBlocks)
        englishRowContinuations.set(current, englishGroup.rowContinuationBlocks);
      if (englishGroup.kind === 'tasks') {
        readingGroups.add(current);
        readingRanges.set(current, englishGroup.range);
        type = 'short_answer';
        explicitType = false;
        explicitlyTyped.add(current);
      } else if (englishGroup.kind === 'table') {
        explicitlyTyped.add(current);
        if (englishGroup.ambiguous)
          diagnostics.push({
            code: 'word-import.uncertain-block',
            severity: 'warning',
            blockId: block.id,
          });
      } else if (englishGroup.kind === 'cloze') type = 'cloze';
      parents.length = 0;
      parents.push(current);
      surface = 'question';
      solutionEnumeration = 0;
      clozeSolutionEnumerationEnd = undefined;
      rootLabels.clear();
      solutionParent = undefined;
      sharedSolutionOwners = undefined;
      pushSurface(current, block, 0, englishGroup.sharedMaterialEnds?.get(block.id) ?? text.length);
      continue;
    }
    const section = sectionType(text, block.numbering?.label, block.numbering?.level);
    if (section) {
      type = section;
      explicitType =
        !readWordMathSection(text, block.numbering)?.inferred &&
        !/^阅读选择\s*[:：]?$/.test(mathSectionLabel(text, block.numbering?.label));
      current = undefined;
      root = undefined;
      surface = 'question';
      // A section may restart numbering, so earlier numbers stop being back-references.
      rootLabels.clear();
      solutionParent = undefined;
      sharedSolutionOwners = undefined;
      parents.length = 0;
      continue;
    }
    if (contextualWorkbookHeading(blockIndex)) {
      current = undefined;
      root = undefined;
      parents.length = 0;
      surface = 'question';
      rootLabels.clear();
      solutionParent = undefined;
      sharedSolutionOwners = undefined;
      continue;
    }
    if (isWordStructuralLabel(text) && /^[一二三四五六七八九十]+、/.test(text.trim())) {
      current = undefined;
      root = undefined;
      parents.length = 0;
      surface = 'question';
      type = 'short_answer';
      explicitType = false;
      rootLabels.clear();
      solutionParent = undefined;
      sharedSolutionOwners = undefined;
      continue;
    }
    if (/^\s*(参考答案|答案与解析|参考答案及解析)\s*$/.test(text)) {
      answerAppendix = true;
      ambiguousNumber = undefined;
      current = undefined;
      surface = 'answer';
      continue;
    }
    const numbered = mainLabel(text);
    const decimal = /^\s*(\d+)\.\d/.exec(text);
    if (ambiguousRoot !== root) {
      ambiguousRoot = root;
      ambiguousNumber = root?.sourceLabel ? Number(root.sourceLabel) : undefined;
    }
    if (
      !answerAppendix &&
      decimal &&
      ambiguousNumber !== undefined &&
      Number(decimal[1]) === ambiguousNumber + 1
    ) {
      ambiguousNumber = Number(decimal[1]);
      diagnostics.push({
        code: 'word-import.check-question-boundary',
        severity: 'warning',
        blockId: block.id,
      });
    }
    if (answerAppendix) {
      const path = /^\s*(\d+(?:\.\d+)+)[.．、]?\s+/.exec(text);
      const childAnswer = /^\s*[（(](\d+)[）)]\s*/.exec(text);
      let prefixLength = numbered?.[0].length ?? 0;
      if (path) {
        const labels = path[1].split('.');
        let candidate = find(labels[0]);
        const candidateRoot = candidate;
        for (let index = 1; candidate && index < labels.length; index++) {
          const fullLabel = labels.slice(0, index + 1).join('.');
          const matches: WordQuestionReference[] = candidate.children.filter(
            (child) => child.sourceLabel === labels[index] || child.sourceLabel === fullLabel,
          );
          candidate = matches.length === 1 ? matches[0] : undefined;
        }
        if (candidate) {
          current = candidate;
          appendixRoot = candidateRoot;
          surface = 'answer';
          prefixLength = path[0].length;
        } else {
          prefixLength = 0;
          diagnostics.push({
            code: 'word-import.check-question-boundary',
            severity: 'warning',
            blockId: block.id,
          });
        }
      } else if (childAnswer) {
        const matches =
          appendixRoot?.children.filter((child) => child.sourceLabel === childAnswer[1]) ?? [];
        current = matches.length === 1 ? matches[0] : undefined;
        surface = 'answer';
        prefixLength = childAnswer[0].length;
      } else if (numbered) {
        current = find(numbered[1]);
        appendixRoot = current;
        surface = 'answer';
      } else if (block.numbering?.level === 0) {
        current = find(numberingLabel(block.numbering.label));
        appendixRoot = current;
        surface = 'answer';
        prefixLength = numberingPrefixLength(text, block.numbering.label);
      }
      if (current) pushSurface(current, block, prefixLength, text.length);
      // Unmatched appendix blocks are retained as unassigned diagnostics.
      continue;
    }
    const nativeOptionContinuation =
      surface === 'question' &&
      block.numbering?.level === 0 &&
      current !== undefined &&
      current === root &&
      current.question.length > 0 &&
      !current.answer.length &&
      !current.children.length &&
      !current.options?.length &&
      (!explicitlyTyped.has(current) ||
        ['single_choice', 'multiple_choice', 'fill_with_candidates'].includes(
          current.questionType,
        )) &&
      consecutiveOptionPool(
        block,
        readOptions(block, numberingPrefixLength(text, block.numbering.label)),
      );
    const nextBlocks = blocks.slice(blockIndex + 1, blockIndex + 60);
    const firstNext = nextBlocks.find((item) => sourceText(item.content).trim());
    const nextTask = nextBlocks.find((item) => mainLabel(sourceText(item.content)));
    const nextTaskLabel = nextTask ? mainLabel(sourceText(nextTask.content))?.[1] : undefined;
    const nextAnswer = nextBlocks.find((item) => /【答案】/.test(sourceText(item.content)));
    const newReadingPromptBeforeTask =
      nextTask &&
      nextBlocks
        .slice(0, nextBlocks.indexOf(nextTask))
        .some(
          (item) =>
            /阅读.*(?:完成|回答)/.test(sourceText(item.content)) ||
            isWordStructuralLabel(sourceText(item.content)),
        );
    const unseenReadingSet =
      surface !== 'question' &&
      root !== undefined &&
      readingGroups.has(root) &&
      nextTaskLabel !== undefined &&
      !root.children.some((candidate) => candidate.sourceLabel === nextTaskLabel) &&
      nextAnswer !== undefined &&
      !newReadingPromptBeforeTask &&
      new RegExp(`【答案】\\s*${nextTaskLabel}[.．、]`).test(sourceText(nextAnswer.content)) &&
      (text.trim().startsWith('【甲】') ||
        (text.trim().length <= 30 &&
          !/[。！？：:]/.test(text) &&
          firstNext !== undefined &&
          /^\s*①/.test(sourceText(firstNext.content))));
    const declaredReadingRange = /完成(?:第)?(\d+)[~～-](\d+)题/.exec(text);
    const preludeTask = provedCommandPrelude(blockIndex);
    if (preludeTask) {
      pendingQuestionPreludes.set(preludeTask, {
        ranges: [range(block.id, 0, text.length)],
        owner: current!,
        field: surface,
      });
      continue;
    }
    const legacyReadingPrompt =
      text.length <= 100 &&
      /阅读/.test(text) &&
      /(?:完成(?:下面|下列)?(?:小题|各题|题目|问题|任务)|回答问题)/.test(text);
    const chineseRange = legacyReadingPrompt ? undefined : chineseMaterialRange(blockIndex);
    const diagramRange =
      surface !== 'question' &&
      root !== undefined &&
      !readingGroups.has(root) &&
      !numbered &&
      !block.numbering &&
      block.content.some((node) => node.type === 'text' && node.text?.trim())
        ? diagramMaterialRange(blockIndex)
        : undefined;
    if (
      !numbered &&
      !block.numbering &&
      ((text.length <= 100 &&
        /阅读/.test(text) &&
        /(?:完成(?:下面|下列)?(?:小题|各题|题目|问题|任务)|回答问题)/.test(text)) ||
        (text.length <= 100 && /阅读/.test(text) && declaredReadingRange) ||
        unseenReadingSet ||
        diagramRange ||
        chineseRange)
    ) {
      current = newQuestion('short_answer');
      roots.push(current);
      root = current;
      readingGroups.add(current);
      if (chineseRange) {
        chineseGroups.add(current);
        readingRanges.set(current, chineseRange);
        type = 'short_answer';
        explicitType = false;
      }
      if (declaredReadingRange)
        readingRanges.set(current, [
          Number(declaredReadingRange[1]),
          Number(declaredReadingRange[2]),
        ]);
      if (diagramRange && !chineseRange) {
        diagramGroups.add(current);
        readingRanges.set(current, diagramRange);
        diagnostics.push({
          code: 'word-import.check-question-boundary',
          severity: 'warning',
          blockId: block.id,
        });
      }
      parents.length = 0;
      parents.push(current);
      surface = 'question';
      solutionEnumeration = 0;
      clozeSolutionEnumerationEnd = undefined;
      rootLabels.clear();
      solutionParent = undefined;
      sharedSolutionOwners = undefined;
      pushSurface(current, block, 0, text.length);
      continue;
    }
    if (numbered && surface !== 'question' && root?.children.length && readingGroups.has(root)) {
      const owner = root.children.find((candidate) => candidate.sourceLabel === numbered[1]);
      if (owner) {
        current = owner;
        solutionParent = owner;
        pushSurface(owner, block, numbered[0].length, text.length);
        continue;
      }
    }
    const nativeOptionLabel = block.numbering
      ? /(?:^|[.．、])([A-Za-z])$/.exec(numberingLabel(block.numbering.label))?.[1]
      : undefined;
    const optionOwner = current;
    const previousOptionLabel = optionOwner?.options?.at(-1)?.sourceLabel.toUpperCase();
    const nativeLetterOption =
      optionOwner !== undefined &&
      surface === 'question' &&
      (!explicitlyTyped.has(optionOwner) ||
        ['single_choice', 'multiple_choice', 'fill_with_candidates'].includes(
          optionOwner.questionType,
        )) &&
      (block.numbering?.format === 'lowerLetter' || block.numbering?.format === 'upperLetter') &&
      nativeOptionLabel !== undefined &&
      /^[A-Za-z]$/.test(nativeOptionLabel) &&
      (previousOptionLabel
        ? nativeOptionLabel.toUpperCase().charCodeAt(0) === previousOptionLabel.charCodeAt(0) + 1
        : nativeOptionLabel.toUpperCase() === 'A');
    if (nativeLetterOption && optionOwner) {
      optionOwner.options = [
        ...(optionOwner.options ?? []),
        {
          sourceLabel: nativeOptionLabel,
          label: [
            range(block.id, numberingPrefixLength(text, block.numbering!.label), text.length),
          ],
        },
      ];
      inferChoiceFromOptions(optionOwner);
      continue;
    }
    const child = /^\s*[（(](\d+)[）)]\s*/.exec(text);
    if (
      child &&
      surface === 'question' &&
      current === root &&
      root &&
      /根据线索.*写出.*诗句/.test(questionText(root)) &&
      inlineChildLabels(text).length >= 2 &&
      !findWordBlankMarkers(block).length
    ) {
      pushSurface(root, block, 0, text.length);
      continue;
    }
    if (
      child &&
      surface === 'question' &&
      current &&
      !current.children.length &&
      child[1] === '1' &&
      provedScaffold(blockIndex, current)
    )
      scaffoldTasks.add(current);
    if (child && surface === 'question' && current && scaffoldTasks.has(current)) {
      pushSurface(current, block, 0, text.length);
      continue;
    }
    if (
      child &&
      surface === 'question' &&
      root &&
      current === root &&
      !readingGroups.has(root) &&
      !choiceStatementRoots.has(root)
    ) {
      const labels = inlineChildLabels(text);
      if (
        inlineComparison(root, block, 0, text.length) ||
        (labels.length > 1 &&
          /[=＝×÷]/.test(text) &&
          labels.every((label, index) => Number(label[1]) === index + 1))
      ) {
        pushSurface(root, block, 0, text.length);
        continue;
      }
    }
    if (child && surface === 'question' && root && choiceStatementRoots.has(root)) {
      pushSurface(root, block, 0, text.length);
      continue;
    }
    if (surface !== 'question' && /^(?:\s*[（(]\d+[）)]){2,}/.test(text)) {
      pushSurface(current!, block, 0, text.length);
      continue;
    }
    if (
      child &&
      surface !== 'question' &&
      solutionParent?.children.some((candidate) => candidate.sourceLabel === child[1])
    ) {
      pushSurface(current!, block, 0, text.length);
      continue;
    }
    if (
      child &&
      surface !== 'question' &&
      root &&
      (!readingGroups.has(root) || chineseGroups.has(root)) &&
      solutionParent &&
      parentOf(solutionParent)?.children.some((candidate) => candidate.sourceLabel === child[1])
    ) {
      solutionParent = parentOf(solutionParent);
      pushSurface(current!, block, 0, text.length);
      continue;
    }
    const dottedCandidate = /^\s*(\d+(?:\.\d+)+)[.．、]?\s+/.exec(text);
    const dottedLabels = dottedCandidate?.[1].split('.');
    const dottedParent = dottedLabels ? parents[dottedLabels.length - 2] : undefined;
    const existingDotted = dottedParent?.children.some(
      (candidate) =>
        candidate.sourceLabel === dottedCandidate?.[1] ||
        candidate.sourceLabel === dottedLabels?.at(-1),
    );
    const expectedDotted =
      Number(dottedParent?.children.at(-1)?.sourceLabel?.split('.').at(-1) ?? 0) + 1;
    const dottedChild =
      dottedCandidate &&
      dottedLabels?.[0] === root?.sourceLabel &&
      (existingDotted ||
        (surface === 'question' && Number(dottedLabels?.at(-1)) === expectedDotted))
        ? dottedCandidate
        : null;
    if (dottedCandidate && !dottedChild && dottedLabels?.[0] === root?.sourceLabel)
      diagnostics.push({
        code: 'word-import.check-question-boundary',
        severity: 'warning',
        blockId: block.id,
      });
    const inReadingGroup = root !== undefined && readingGroups.has(root);
    if (
      child &&
      inReadingGroup &&
      surface === 'question' &&
      !root!.children.length &&
      nextTask &&
      (!nextAnswer || nextBlocks.indexOf(nextTask) < nextBlocks.indexOf(nextAnswer)) &&
      !newReadingPromptBeforeTask
    ) {
      pushSurface(root!, block, 0, text.length);
      continue;
    }
    const declaredRange = root ? readingRanges.get(root) : undefined;
    const readingChild =
      numbered &&
      inReadingGroup &&
      (!declaredRange ||
        (Number(numbered[1]) >= declaredRange[0] && Number(numbered[1]) <= declaredRange[1])) &&
      (surface === 'question' ||
        Number(numbered[1]) >
          Math.max(0, ...root!.children.map((candidate) => Number(candidate.sourceLabel))));
    const circledChild =
      parents[inReadingGroup ? 2 : 1] !== undefined ? /^\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*/.exec(text) : null;
    const inlineCircledLabels = [...text.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]/g)];
    const nextCircledBoundary = nextBlocks.find((item) => {
      const text = sourceText(item.content);
      return (
        mainLabel(text) ||
        /^\s*(?:[（(]\d+[）)]|[①②③④⑤⑥⑦⑧⑨⑩])/.test(text) ||
        /【(?:答案|解析|分析|详解)】|(?:参考)?(?:答案|解析|分析|详解)\s*[:：]/.test(text) ||
        isWordStructuralLabel(text) ||
        item.numbering?.level === 0
      );
    });
    const continuesCircledTasks =
      nextCircledBoundary && /^\s*[①②③④⑤⑥⑦⑧⑨⑩]/.test(sourceText(nextCircledBoundary.content));
    const premiseOwner = parents[inReadingGroup ? 2 : 1];
    if (
      circledChild?.[1] === '①' &&
      surface === 'question' &&
      premiseOwner &&
      !premiseOwners.has(premiseOwner) &&
      current === premiseOwner &&
      !premiseOwner.children.length &&
      (/^阅读材料\s*[:：]\s*$/.test(questionText(premiseOwner).trim()) ||
        /从(?:以下|下列)(?:三|3)个条件中(?:选择|任选)(?:两|2)个作为已知/.test(
          questionText(premiseOwner),
        ))
    ) {
      premiseOwners.add(premiseOwner);
      const list: WordSourceBlock[] = [];
      let listEnd = blockIndex;
      for (const [index, item] of blocks.slice(blockIndex, blockIndex + 20).entries()) {
        listEnd = blockIndex + index;
        const value = sourceText(item.content);
        if (!value.trim()) continue;
        const label = /^\s*([①②③④⑤⑥⑦⑧⑨⑩])/.exec(value);
        if (!label || label[1] !== '①②③④⑤⑥⑦⑧⑨⑩'[list.length]) break;
        if (
          /[?？]|_{2,}|[（(]\s*[）)]|判断|正确的是|是否正确|求|作答|填空/.test(value) ||
          item.content.some((node) => node.type === 'quizBlank')
        ) {
          list.length = 0;
          break;
        }
        list.push(item);
        listEnd++;
      }
      for (const item of blocks.slice(listEnd)) {
        const value = sourceText(item.content);
        if (
          mainLabel(value) ||
          sectionType(value, item.numbering?.label, item.numbering?.level) ||
          item.numbering?.level === 0 ||
          /^\s*[（(]\d+[）)]/.test(value) ||
          /【(?:答案|解析|分析|详解)】|(?:参考)?(?:答案|解析|分析|详解)\s*[:：]/.test(value)
        )
          break;
        const followingCircle = /^\s*([①②③④⑤⑥⑦⑧⑨⑩])/.exec(value);
        if (followingCircle) {
          if (followingCircle[1] === '①②③④⑤⑥⑦⑧⑨⑩'[list.length]) list.length = 0;
          break;
        }
      }
      let keyedCircles = false;
      let inAnswer = false;
      for (const item of blocks.slice(listEnd)) {
        const value = sourceText(item.content);
        if (mainLabel(value) || sectionType(value, item.numbering?.label, item.numbering?.level))
          break;
        if (/^\s*[①②③④⑤⑥⑦⑧⑨⑩]/.test(value)) {
          keyedCircles = inAnswer;
          break;
        }
        const markers = [
          ...value.matchAll(
            /【(答案|解析|分析|详解|导语|点睛)】|(?:参考)?(答案|解析|分析|详解)\s*[:：]/g,
          ),
        ];
        let offset = 0;
        for (let index = 0; index <= markers.length; index++) {
          const marker = markers[index];
          const answer = value.slice(offset, marker?.index ?? value.length);
          if (inAnswer) {
            const parentKeys = [
              ...answer.matchAll(
                /(?:^|[。；;.\s]|解\s*[:：]\s*)[（(](\d+(?:\.\d+)*)[）)]\s*[①②③④⑤⑥⑦⑧⑨⑩]/g,
              ),
            ];
            if (
              parentKeys.some((key) => key[1] === premiseOwner.sourceLabel) ||
              /^\s*[①②③④⑤⑥⑦⑧⑨⑩]/.test(answer)
            ) {
              keyedCircles = true;
              break;
            }
          }
          if (marker) {
            inAnswer = (marker[1] ?? marker[2]) === '答案';
            offset = marker.index! + marker[0].length;
          }
        }
        if (keyedCircles) break;
      }
      if (list.length >= 2 && !keyedCircles) list.forEach((item) => premiseBlocks.add(item.id));
    }
    if (premiseBlocks.has(block.id) && surface === 'question' && premiseOwner) {
      pushSurface(premiseOwner, block, 0, text.length);
      continue;
    }
    if (
      circledChild &&
      surface === 'question' &&
      current &&
      current === parents[1] &&
      !current.children.length &&
      !continuesCircledTasks &&
      inlineCircledLabels.length >= 2 &&
      inlineCircledLabels.every((label, index) => label[0] === '①②③④⑤⑥⑦⑧⑨⑩'[index]) &&
      block.content.some((node) => ['inlineMath', 'blockMath'].includes(node.type))
    ) {
      pushSurface(current, block, 0, text.length);
      continue;
    }
    const childDepth =
      block.numbering?.level ??
      (dottedChild
        ? dottedChild[1].split('.').length - 1
        : child
          ? inReadingGroup
            ? 2
            : 1
          : circledChild
            ? inReadingGroup
              ? 3
              : 2
            : readingChild
              ? 1
              : 0);
    const childPrefix = dottedChild?.[0] ?? child?.[0] ?? circledChild?.[0];
    const sourceChildLabel =
      dottedChild?.[1] ??
      child?.[1] ??
      circledChild?.[1] ??
      (inReadingGroup ? numbered?.[1] : undefined) ??
      (block.numbering?.label ? numberingLabel(block.numbering.label) : undefined);
    const previousSibling = parents[childDepth];
    const labelNumber = (label: string) => {
      const circled = '①②③④⑤⑥⑦⑧⑨⑩'.indexOf(label);
      return circled >= 0 ? circled + 1 : Number(label.split('.').at(-1));
    };
    const sequentialAnalysisChild =
      surface === 'analysis' &&
      previousSibling?.sourceLabel !== undefined &&
      sourceChildLabel !== undefined &&
      labelNumber(sourceChildLabel) === labelNumber(previousSibling.sourceLabel) + 1 &&
      !(parents[childDepth - 1]?.children ?? []).some(
        (sibling) => sibling.sourceLabel === sourceChildLabel,
      );
    const childStem = text.slice(childPrefix?.length ?? 0);
    const childSolution =
      /【(?:答案|解析|分析|详解)】|(?:参考)?(?:答案|解析|分析|详解)\s*[:：]/.exec(childStem);
    const childPrompt = childStem.slice(0, childSolution?.index ?? childStem.length);
    const childMarkers = findWordBlankMarkers(
      block,
      childPrefix?.length ?? 0,
      (childPrefix?.length ?? 0) + childPrompt.length,
    );
    const prompt = childPrompt.trim();
    const imperativeChild =
      /^(?:请\s*)?(?:计算|求|解释|说明|分析|简述|说出|概括|描述|回答|写|填|选|判断)\s*\S/.test(
        prompt,
      ) ||
      /^(?:please\s+)?(?:explain|describe|compare|analyse|analyze|summarize|state|calculate|find|write|choose|complete)\s+\S/i.test(
        prompt,
      );
    const explanatoryChild =
      /^(?:说明|分析|解释|简述)(?:了|可(?:知|得)|表明|显示|得到|得出|如下)/.test(prompt);
    const taskLikeChild =
      sequentialAnalysisChild &&
      (/[?？]/.test(childPrompt) ||
        childMarkers.length > 0 ||
        (!/^(?:然后|接着|再(?:计算|求|将)|因此|所以|故|由此|第.*步)/.test(prompt) &&
          !explanatoryChild &&
          (imperativeChild || /^(?:为什么|怎样|如何|根据|下图)/.test(prompt))));
    const completedConclusion =
      sequentialAnalysisChild &&
      !/[?？]|(?:求|计算|写出|确定).*(?:的值|多少|结果|答案)/.test(childPrompt) &&
      /^(?:求得|根据(?:上式|前式|上述|以上|已知)|由(?:上式|前式|上述|以上|已知))/.test(
        childPrompt.trim(),
      ) &&
      /[=＝]/.test(childPrompt) &&
      !childMarkers.length;
    const independentAnswerAfterAnalysis =
      sequentialAnalysisChild &&
      !completedConclusion &&
      (() => {
        for (const [index, item] of blocks.slice(blockIndex, blockIndex + 60).entries()) {
          const value = sourceText(item.content);
          if (
            index &&
            (mainLabel(value) ||
              /^\s*(?:[（(]\d+[）)]|[①②③④⑤⑥⑦⑧⑨⑩])/.test(value) ||
              sectionType(value, item.numbering?.label, item.numbering?.level) ||
              (item.numbering !== undefined &&
                !['lowerLetter', 'upperLetter'].includes(item.numbering.format ?? '')) ||
              isWordStructuralLabel(value) ||
              /^\s*(?:参考答案|答案与解析|参考答案及解析)\s*$/.test(value))
          )
            return false;
          const markers = [
            ...value.matchAll(/【(答案|解析|分析|详解)】|(?:参考)?(答案|解析|分析|详解)\s*[:：]/g),
          ];
          const beforeKey = value.slice(
            index ? 0 : (childPrefix?.length ?? 0),
            markers[0]?.index ?? value.length,
          );
          if (
            /(?:^|[。；;！？?!]\s*|[ \u00a0]{2,})(?:[（(]\d+[）)]|[①②③④⑤⑥⑦⑧⑨⑩]|\d+(?:\.(?!\d)|[．、])\s*)/.test(
              beforeKey,
            ) ||
            beforeKey
              .split(/\n|[。！？?!]\s*|[ \u00a0]{2,}/)
              .some(
                (part) =>
                  Boolean(sectionType(part)) ||
                  /^\s*(?:参考答案|答案与解析|参考答案及解析)\s*$/.test(part),
              )
          )
            return false;
          if (!markers.length) continue;
          if ((markers[0][1] ?? markers[0][2]) !== '答案') return false;
          return Boolean(
            value
              .slice(markers[0].index! + markers[0][0].length, markers[1]?.index ?? value.length)
              .trim(),
          );
        }
        return false;
      })();
    const ownAnswerAfterAnalysis = taskLikeChild && independentAnswerAfterAnalysis;
    if (
      (taskLikeChild || independentAnswerAfterAnalysis) &&
      !ownAnswerAfterAnalysis &&
      !diagnostics.some(
        (item) => item.code === 'word-import.check-question-boundary' && item.blockId === block.id,
      )
    )
      diagnostics.push({
        code: 'word-import.check-question-boundary',
        severity: 'warning',
        blockId: block.id,
      });
    const nextChildAfterSolution =
      childDepth > 0 &&
      surface !== 'question' &&
      (surface === 'answer' ||
        block.numbering !== undefined ||
        readingChild ||
        ownAnswerAfterAnalysis) &&
      previousSibling?.sourceLabel !== undefined &&
      sourceChildLabel !== undefined &&
      !(parents[childDepth - 1]?.children ?? []).some(
        (sibling) => sibling.sourceLabel === sourceChildLabel,
      );
    if (
      nextChildAfterSolution &&
      (surface === 'answer' || block.numbering !== undefined || readingChild) &&
      !diagnostics.some(
        (item) => item.code === 'word-import.check-question-boundary' && item.blockId === block.id,
      )
    )
      diagnostics.push({
        code: 'word-import.check-question-boundary',
        severity: 'warning',
        blockId: block.id,
      });
    const looksLikeOptions =
      /(?:^|\s)[A-Za-z][.．、)）]/.test(text) ||
      /^\s*\d+[.．、)）]\s*[A-Za-z][.．、)）]/.test(text);
    const clozeOption = /^\s*(\d+)[.．、)）]\s*(?=[A-Za-z][.．、)）])/.exec(text);
    if (
      current &&
      clozeOption &&
      (current.questionType === 'cloze' ||
        current.blanks?.some((blank) => blank.sourceLabel === clozeOption[1]))
    ) {
      const blank = current.blanks?.find((item) => item.sourceLabel === clozeOption[1]);
      if (blank) {
        current.questionType = 'cloze';
        blank.candidates =
          englishRowPools.get(current)?.get(clozeOption[1]) ??
          readOptions(block, clozeOption[0].length);
        continue;
      }
      if (current.questionType === 'cloze' && current.blanks?.length) {
        diagnostics.push({
          code: 'word-import.uncertain-block',
          severity: 'warning',
          blockId: block.id,
        });
        pushQuestion(current, block, 0, text.length);
        continue;
      }
    }
    if (current && current === root && englishRowContinuations.get(current)?.has(block.id))
      continue;
    const clozeLabels =
      root && (root.questionType === 'cloze' || englishGroups.has(root))
        ? root.blanks?.map((blank) => blank.sourceLabel).filter((label) => label !== undefined)
        : undefined;
    const consecutiveCloze =
      clozeLabels?.length &&
      clozeLabels.length === root!.blanks!.length &&
      clozeLabels.every(
        (label, index) => /^\d+$/.test(label) && Number(label) === Number(clozeLabels[0]) + index,
      );
    let freshNumberedTask = Boolean(numbered && /【答案】|(?:参考)?答案\s*[:：]/.test(text));
    if (numbered && surface !== 'question' && consecutiveCloze) {
      for (const following of nextBlocks) {
        const value = sourceText(following.content);
        if (
          mainLabel(value) ||
          following.numbering?.level === 0 ||
          sectionType(value, following.numbering?.label, following.numbering?.level)
        )
          break;
        if (englishMaterialEvidence(blocks.indexOf(following))) break;
        if (/【答案】|(?:参考)?答案\s*[:：]/.test(value)) {
          freshNumberedTask = true;
          break;
        }
        if (/【(?:解析|分析|详解|导语|点睛)】/.test(value)) break;
      }
    }
    if (
      numbered &&
      surface === 'answer' &&
      consecutiveCloze &&
      numbered[1] === clozeLabels![0] &&
      root!.answer.length &&
      /^句意\s*[:：]/.test(text.slice(numbered[0].length)) &&
      !freshNumberedTask
    ) {
      surface = 'analysis';
      solutionEnumeration = 0;
      clozeSolutionEnumerationEnd = undefined;
    }
    const clozeEnumerationEnd = clozeSolutionEnumerationEnd ?? Number(clozeLabels?.at(-1));
    const enumeratedSolutionItem =
      numbered &&
      surface !== 'question' &&
      (consecutiveCloze
        ? !freshNumberedTask &&
          ((solutionEnumeration === 0 && numbered[1] === clozeLabels![0]) ||
            (Number(numbered[1]) === solutionEnumeration + 1 &&
              Number(numbered[1]) <= clozeEnumerationEnd))
        : Number(numbered[1]) === solutionEnumeration + 1);
    if (enumeratedSolutionItem) {
      solutionEnumeration = Number(numbered![1]);
      if (consecutiveCloze && clozeSolutionEnumerationEnd === undefined)
        clozeSolutionEnumerationEnd = Number(clozeLabels!.at(-1));
    }
    const nextRootAfterSolution =
      numbered && surface !== 'question' && !enumeratedSolutionItem && !rootLabels.has(numbered[1]);
    const numberedRoot =
      numbered &&
      !childDepth &&
      !(looksLikeOptions && current?.questionType === 'cloze') &&
      (surface === 'question' || nextRootAfterSolution);
    const nativeRoot = block.numbering?.level === 0;
    const rootBoundary = !nativeOptionContinuation && Boolean(numberedRoot || nativeRoot);
    if (
      rootBoundary &&
      surface === 'question' &&
      root &&
      current === root &&
      root.sourceLabel &&
      numbered &&
      Number(numbered[1]) > Number(root.sourceLabel) + 1 &&
      root.blanks &&
      root.blanks.length >= 3 &&
      /重新排列以上句子.*(?:把序号|序号).*填在/.test(text)
    ) {
      const answer = nextBlocks.find((item) => /【答案】/.test(sourceText(item.content)));
      const nextNumber = nextBlocks.find((item) => mainLabel(sourceText(item.content)));
      const key = answer
        ? sourceText(answer.content)
            .replace(/^\s*【答案】/, '')
            .trim()
        : '';
      const keys = key.match(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/g) ?? [];
      const sourceLines = root.question.map((ref) =>
        sourceText(blocks.find((item) => item.id === ref.blockId)!.content)
          .slice(ref.start, ref.end)
          .trim(),
      );
      if (
        nextNumber &&
        mainLabel(sourceText(nextNumber.content))?.[1] === String(Number(root.sourceLabel) + 1) &&
        answer &&
        nextBlocks.indexOf(answer) < nextBlocks.indexOf(nextNumber) &&
        keys.length === root.blanks.length &&
        new Set(keys).size === keys.length &&
        key.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳\s]/g, '') === '' &&
        sourceLines.length === root.blanks.length &&
        sourceLines.every((line) => /^[（(]\s*[）)]/.test(line))
      ) {
        pushSurface(root, block, 0, text.length);
        root.blanks = root.blanks.filter((blank) => blank.marker.blockId !== block.id);
        continue;
      }
    }
    if (rootBoundary && surface !== 'question')
      diagnostics.push({
        code: 'word-import.check-question-boundary',
        severity: 'warning',
        blockId: block.id,
      });
    if (!current || rootBoundary) {
      current = createQuestion(
        numbered?.[1] ??
          (block.numbering?.label ? numberingLabel(block.numbering.label) : undefined),
      );
      if (current.sourceLabel !== undefined) rootLabels.add(current.sourceLabel);
      roots.push(current);
      root = current;
      const preludes = pendingQuestionPreludes.get(block.id);
      if (preludes) {
        current.question.push(...preludes.ranges);
        pendingQuestionPreludes.delete(block.id);
      }
      parents.length = 0;
      parents.push(current);
      surface = 'question';
      solutionEnumeration = 0;
      clozeSolutionEnumerationEnd = undefined;
      solutionParent = undefined;
      sharedSolutionOwners = undefined;
      independentSolutionOwners = undefined;
      if (hasChoiceStatements(blockIndex)) choiceStatementRoots.add(current);
    } else if (
      root &&
      childDepth > 0 &&
      (surface === 'question' || block.numbering !== undefined || nextChildAfterSolution)
    ) {
      const parent = parents[childDepth - 1];
      if (parent) {
        current = createQuestion(
          sourceChildLabel,
          inReadingGroup &&
            (diagramGroups.has(root) || englishGroups.has(root) || chineseGroups.has(root)),
        );
        if (englishGroups.get(root)?.judgement) explicitlyTyped.add(current);
        parent.children.push(current);
        parents.length = childDepth;
        parents.push(current);
        surface = 'question';
        solutionEnumeration = 0;
        clozeSolutionEnumerationEnd = undefined;
        solutionParent = undefined;
      } else {
        diagnostics.push({
          code: 'word-import.unresolved-child-level',
          severity: 'warning',
          blockId: block.id,
        });
        // Do not attach an orphan's stem to a previously parsed sibling.
        continue;
      }
    }
    const prefixStart =
      numbered && rootBoundary
        ? numbered![0].length
        : numbered && inReadingGroup && surface === 'question'
          ? numbered[0].length
          : childPrefix && surface === 'question'
            ? childPrefix.length
            : block.numbering && surface === 'question'
              ? numberingPrefixLength(text, block.numbering.label)
              : 0;
    const start = surface === 'question' ? questionContentStart(block, prefixStart) : prefixStart;
    if (surface === 'question' && looksLikeOptions) {
      const sharedMaterialEnd =
        current === root && current.questionType === 'cloze'
          ? englishPoolMaterialEnds.get(current)?.get(block.id)
          : undefined;
      if (sharedMaterialEnd !== undefined) {
        pushQuestion(current, block, start, sharedMaterialEnd);
        continue;
      }
      const parsed = readOptions(block, start);
      const lastLabelledMarker = findWordBlankMarkers(block, start)
        .filter((blank) => blank.sourceLabel)
        .at(-1);
      if (
        current === root &&
        current.questionType === 'cloze' &&
        lastLabelledMarker &&
        parsed.length &&
        (parsed[0].label[0].start ?? 0) < (lastLabelledMarker.end ?? text.length)
      ) {
        pushQuestion(current, block, start, text.length);
        continue;
      }
      const nativeRootPool =
        rootBoundary && block.numbering?.level === 0 && consecutiveOptionPool(block, parsed);
      const questionText = current.question
        .map((ref) => {
          const source = blocks.find((item) => item.id === ref.blockId)!;
          return sourceText(source.content).slice(ref.start, ref.end);
        })
        .join('');
      const asksForReason =
        !explicitlyTyped.has(current) &&
        /编入.*专栏/.test(questionText) &&
        /(?:简述|说明|分析|阐释)理由/.test(questionText) &&
        !/(?:选出|选择|正确|不正确|一项|哪些|Which)/i.test(questionText);
      const asksForOptionExplanations =
        !explicitlyTyped.has(current) &&
        /分别(?:加以)?说明[，,、\s]*并(?:选出|选择)/.test(questionText);
      if (
        parsed.length &&
        (!rootBoundary || nativeRootPool) &&
        !asksForReason &&
        !asksForOptionExplanations
      ) {
        if (current === root && englishPools.has(current) && current.questionType === 'cloze')
          continue;
        if (current === root && englishGroups.get(current)?.range && englishPools.has(current)) {
          pushQuestion(current, block, start, text.length);
          continue;
        }
        if (current === root && englishGroups.has(root!) && readingGroups.has(root!)) {
          englishPools.set(root!, [...(englishPools.get(root!) ?? []), ...parsed]);
          pushQuestion(current, block, start, text.length);
          continue;
        }
        if (nativeRootPool && !current.question.length)
          current.question.push(range(block.id, start, text.length));
        current.options = [...(current.options ?? []), ...parsed];
        inferChoiceFromOptions(current);
        continue;
      }
    }
    pushSurface(current, block, start, text.length);
  }
  // A proved prelude must survive even if a later boundary rule declines its target.
  for (const { ranges, owner, field } of pendingQuestionPreludes.values()) {
    owner[field].push(...ranges);
    owner[field].sort(
      (a, b) =>
        blocks.findIndex((block) => block.id === a.blockId) -
          blocks.findIndex((block) => block.id === b.blockId) || (a.start ?? 0) - (b.start ?? 0),
    );
    diagnostics.push({
      code: 'word-import.check-question-boundary',
      severity: 'warning',
      blockId: ranges[0].blockId,
    });
  }
  const refineMarkers = (question: WordQuestionReference, ancestorContext = '') => {
    const context = `${ancestorContext} ${questionText(question)}`;
    const retain = (blank: WordBlankReference) => {
      const block = blocks.find((item) => item.id === blank.marker.blockId)!;
      return question.question.some(
        (ref) =>
          ref.blockId === block.id &&
          readBlanks(
            block,
            ref.start ?? 0,
            ref.end ?? sourceText(block.content).length,
            context,
          ).some(
            (marker) =>
              marker.marker.start === blank.marker.start &&
              marker.marker.end === blank.marker.end &&
              marker.sourceLabel === blank.sourceLabel,
          ),
      );
    };
    if (question.blanks?.length) {
      question.blanks = question.blanks.filter(retain);
      if (!question.blanks.length && !explicitlyTyped.has(question)) {
        question.blanks = undefined;
        if (question.questionType === 'fill_in_the_blank') question.questionType = 'short_answer';
      }
    }
    const nonScoring = nonScoringMarkers.get(question);
    if (nonScoring) nonScoringMarkers.set(question, nonScoring.filter(retain));
    question.children.forEach((child) => refineMarkers(child, context));
  };
  roots.forEach((question) => refineMarkers(question));
  const finish = (question: WordQuestionReference) => {
    if (
      question.questionType === 'fill_in_the_blank' &&
      !explicitlyTyped.has(question) &&
      !question.children.length &&
      !question.options?.length &&
      question.blanks?.length === 1 &&
      /^[√×✓✗对错]+$/.test(choiceAnswerText(question).trim())
    ) {
      const blank = question.blanks[0].marker;
      const last = question.question.at(-1);
      const block = blocks.find((item) => item.id === blank.blockId)!;
      const stem = sourceText(block.content);
      const before = stem[blank.start! - 1];
      const after = stem[blank.end!];
      const whole = stem.slice(blank.start, blank.end);
      const parentheticalEnd = /^[（(][ \u00a0]*[）)]$/.test(whole)
        ? blank.end!
        : /^[ \u00a0]+$/.test(whole) && /[（(]/.test(before ?? '') && /[）)]/.test(after ?? '')
          ? blank.end! + 1
          : undefined;
      if (
        parentheticalEnd !== undefined &&
        last?.blockId === block.id &&
        /^[。.!！?？\s]*$/.test(stem.slice(parentheticalEnd, last.end)) &&
        !findWordBlankMarkers(block, last.start ?? 0, last.end, questionText(question), 'required')
          .length
      ) {
        question.questionType = 'short_answer';
        question.blanks = undefined;
      }
    }
    const options = question.options;
    const factBlocks =
      options?.length === 8
        ? [...new Set(options.slice(0, 4).flatMap((o) => o.label.map((r) => r.blockId)))]
        : [];
    const dedicatedFactBlocks = factBlocks.every(
      (id) =>
        !question.question.some((r) => r.blockId === id) &&
        !options?.slice(4).some((o) => o.label.some((r) => r.blockId === id)),
    );
    if (
      options?.length === 8 &&
      options.slice(0, 4).every((o, i) => o.sourceLabel === String.fromCharCode(97 + i)) &&
      dedicatedFactBlocks &&
      completeLetterPool(options.slice(4)) &&
      options
        .slice(4)
        .every((o) => /^[a-d](?:[\s,，、]*[a-d]){1,}$/.test(projectedOptionText(o).trim())) &&
      wordChoiceAnswerLabels(choiceAnswerText(question)).length === 1 &&
      options
        .slice(4)
        .some((o) => o.sourceLabel === wordChoiceAnswerLabels(choiceAnswerText(question))[0])
    ) {
      factBlocks.forEach((id) =>
        question.question.push(
          range(id, 0, sourceText(blocks.find((b) => b.id === id)!.content).length),
        ),
      );
      question.question.sort(
        (a, b) =>
          blocks.findIndex((block) => block.id === a.blockId) -
            blocks.findIndex((block) => block.id === b.blockId) || (a.start ?? 0) - (b.start ?? 0),
      );
      question.options = options.slice(4);
    }
    const englishParent = parentOf(question);
    const sharedPool = englishParent ? englishPools.get(englishParent) : englishPools.get(question);
    if (sharedPool?.length && !englishParent && question.blanks?.length) {
      question.blanks.forEach((blank) => {
        blank.candidates = sharedPool;
      });
    }
    if (sharedPool?.length && question.blanks?.length && question.answer.length) {
      const answer = choiceAnswerText(question).trim();
      const keys = /^[A-Za-z](?:[\s,，、;；]*[A-Za-z])*$/.test(answer)
        ? (answer.toUpperCase().match(/[A-Z]/g) ?? [])
        : [];
      if (
        keys.length &&
        keys.every((key) => sharedPool.some((option) => option.sourceLabel.toUpperCase() === key))
      ) {
        question.options = sharedPool;
        if (keys.length === question.blanks.length) {
          question.questionType = 'fill_with_candidates';
          const spans = question.answer.flatMap((ref) => {
            const block = blocks.find((item) => item.id === ref.blockId)!;
            const start = ref.start ?? 0;
            return [
              ...sourceText(block.content)
                .slice(start, ref.end)
                .matchAll(/[A-Za-z]/g),
            ].map((match) => range(block.id, start + match.index!, start + match.index! + 1));
          });
          if (spans.length === question.blanks.length)
            question.blanks.forEach((blank, index) => {
              blank.answer = [spans[index]];
            });
        } else if (keys.length === 1) {
          question.questionType = 'single_choice';
          question.blanks = undefined;
          nonScoringMarkers.delete(question);
          explicitlyTyped.add(question);
        }
      }
    }
    const childReferencesMaterialBlank = question.children.some((child) =>
      child.question.some((source) => {
        const block = blocks.find((item) => item.id === source.blockId)!;
        return /(?:横线处|横线上|空白处)/.test(
          sourceText(block.content).slice(source.start, source.end),
        );
      }),
    );
    if (
      question.children.length &&
      (readingGroups.has(question) ||
        (question.questionType === 'fill_in_the_blank' && !question.blanks?.length) ||
        (!explicitlyTyped.has(question) && !question.answer.length && childReferencesMaterialBlank))
    ) {
      question.questionType = 'short_answer';
      question.blanks = undefined;
    }
    const choiceMarkers = choiceBlankMarkers.get(question);
    if (
      choiceMarkers &&
      !explicitlyTyped.has(question) &&
      !/[（(](?:单选|多选|单项选择|多项选择)[）)]/.test(questionText(question)) &&
      question.answer.length &&
      completeLetterPool(question.options ?? [])
    ) {
      const keys = question.answer.flatMap((ref) => {
        const start = ref.start ?? 0;
        const value = sourceText(blocks.find((item) => item.id === ref.blockId)!.content).slice(
          start,
          ref.end,
        );
        if (!/^\s*[A-Z](?:[ \u00a0]{2,}[A-Z])*\s*$/.test(value)) return [];
        return [...value.matchAll(/[A-Z]/g)].map((match) => ({
          label: match[0],
          ref: range(ref.blockId, start + match.index!, start + match.index! + 1),
        }));
      });
      if (
        keys.length === choiceMarkers.length &&
        new Set(keys.map((key) => key.label)).size === keys.length &&
        keys.every((key) => question.options!.some((option) => option.sourceLabel === key.label))
      ) {
        question.questionType = 'fill_with_candidates';
        question.blanks = choiceMarkers;
        question.blanks.forEach((blank, index) => {
          blank.answer = [keys[index].ref];
        });
      }
    }
    const materialOwner = parentOf(question);
    const remoteSlotAnswer = choiceAnswerText(question).trim();
    if (
      materialOwner &&
      chineseGroups.has(materialOwner) &&
      question.questionType === 'single_choice' &&
      !explicitlyTyped.has(question) &&
      !question.blanks?.length &&
      !question.children.length &&
      /(?:选择|选出).*词语.*填(?:在|入)文中横线上/.test(questionText(question)) &&
      !/[（(](?:单选|多选|单项选择|多项选择)[）)]/.test(questionText(question)) &&
      completeLetterPool(question.options ?? []) &&
      /^(?:[（(]\d+[）)]\s*[A-Z]\s*){2,}$/.test(remoteSlotAnswer)
    ) {
      const keys = [...remoteSlotAnswer.matchAll(/[（(](\d+)[）)]\s*([A-Z])/g)];
      const materialLabels = [
        ...questionText(materialOwner).matchAll(/[（(](\d+)[）)]\s*_{2,}/g),
      ].map((match) => match[1]);
      const poolBlocks = [
        ...new Set(question.options!.flatMap((option) => option.label.map((ref) => ref.blockId))),
      ];
      const dedicatedPool = poolBlocks.every(
        (id) =>
          !question.question.some((ref) => ref.blockId === id) &&
          readOptions(blocks.find((item) => item.id === id)!, 0).length ===
            question.options!.filter((option) => option.label.some((ref) => ref.blockId === id))
              .length,
      );
      if (
        dedicatedPool &&
        keys.length === materialLabels.length &&
        keys.every(
          (key, index) =>
            key[1] === String(index + 1) &&
            materialLabels[index] === key[1] &&
            question.options!.some((option) => option.sourceLabel === key[2]),
        )
      ) {
        // The answer slots live in shared material, so preserve their ordered key as source text.
        question.questionType = 'short_answer';
        poolBlocks.forEach((id) =>
          question.question.push(
            range(id, 0, sourceText(blocks.find((item) => item.id === id)!.content).length),
          ),
        );
        question.question.sort(
          (a, b) =>
            blocks.findIndex((block) => block.id === a.blockId) -
              blocks.findIndex((block) => block.id === b.blockId) ||
            (a.start ?? 0) - (b.start ?? 0),
        );
        question.options = undefined;
      }
    }
    if (question.children.length && question.answer.length) {
      const leaves = (items: WordQuestionReference[]): WordQuestionReference[] =>
        items.flatMap((item) => (item.children.length ? leaves(item.children) : [item]));
      const children = leaves(question.children);
      const markers = children.flatMap<{
        child: WordQuestionReference;
        blank?: WordBlankReference;
      }>((child) =>
        child.blanks?.length
          ? child.blanks.map((blank) => ({ child, blank }))
          : [{ child, blank: undefined }],
      );
      const spans =
        answerSpans(question, 4).length === markers.length
          ? answerSpans(question, 4)
          : /[\p{Script=Han}]/u.test(questionText(question))
            ? answerSpans(question, 2)
            : answerSpans(question, 4);
      if (
        markers.length &&
        children.every(
          (child) =>
            ['short_answer', 'fill_in_the_blank'].includes(child.questionType) &&
            !child.answer.length,
        ) &&
        spans.length === markers.length
      ) {
        markers.forEach(({ child, blank }, index) => {
          child.answer.push(spans[index]);
          blank?.answer.push(spans[index]);
        });
        question.answer = [];
      } else if (
        /根据(?:诗句|古诗|诗词)内容填空/.test(questionText(question)) &&
        question.children.length >= 2 &&
        question.children.every(
          (child, index) =>
            child.sourceLabel === String(index + 1) &&
            child.questionType === 'fill_in_the_blank' &&
            !child.children.length &&
            child.blanks?.length &&
            !child.answer.length,
        ) &&
        markers.every((marker) => marker.blank) &&
        spans.length === markers.length + 1 &&
        !question.answer.some((ref) =>
          /[（(]\d+[）)]/.test(
            sourceText(blocks.find((item) => item.id === ref.blockId)!.content).slice(
              ref.start,
              ref.end,
            ),
          ),
        )
      ) {
        // A mismatched unkeyed source must remain a whole task rather than fabricate child keys.
        for (const child of question.children) {
          child.question.forEach((ref, index) => {
            const first = blocks.find((item) => item.id === ref.blockId)!;
            const prefix = /^\s*[（(]\d+[）)]\s*$/.exec(
              sourceText(first.content).slice(0, ref.start),
            );
            question.question.push(index === 0 && prefix ? { ...ref, start: 0 } : ref);
          });
          question.analysis.push(...child.analysis);
          question.knowledgePoints?.push(...(child.knowledgePoints ?? []));
        }
        const order = (a: WordSourceRange, b: WordSourceRange) =>
          blocks.findIndex((item) => item.id === a.blockId) -
            blocks.findIndex((item) => item.id === b.blockId) || (a.start ?? 0) - (b.start ?? 0);
        question.question.sort(order);
        question.analysis.sort(order);
        question.questionType = 'short_answer';
        question.blanks = undefined;
        question.children = [];
        diagnostics.push({
          code: 'word-import.uncertain-block',
          severity: 'warning',
          blockId: question.question[0]?.blockId,
        });
      }
    }
    // Multi-blank answer keys use these same numbers to identify blanks, including blank 1.
    if (question.sourceLabel && question.answer.length && (question.blanks?.length ?? 0) <= 1) {
      const first = question.answer[0];
      const block = blocks.find((item) => item.id === first.blockId)!;
      const start = first.start ?? 0;
      const prefix = mainLabel(sourceText(block.content).slice(start, first.end));
      if (prefix?.[1] === question.sourceLabel) first.start = start + prefix[0].length;
    }
    if (
      ['single_choice', 'multiple_choice'].includes(question.questionType) &&
      !question.answer.length
    ) {
      for (const source of question.question) {
        const block = blocks.find((item) => item.id === source.blockId)!;
        const start = source.start ?? 0;
        const text = sourceText(block.content).slice(start, source.end);
        const match = /[（(]\s*([A-Za-z](?:[\s,，、]*[A-Za-z])*)\s*[）)]/.exec(text);
        if (match) {
          const valueAt = start + match.index + match[0].indexOf(match[1]);
          question.answer.push(range(block.id, valueAt, valueAt + match[1].length));
          const originalEnd = source.end ?? sourceText(block.content).length;
          source.end = start + match.index + 1;
          question.question.splice(
            question.question.indexOf(source) + 1,
            0,
            range(block.id, start + match.index + match[0].length - 1, originalEnd),
          );
          break;
        }
      }
    }
    if (question.questionType === 'fill_with_candidates') question.candidatePoolRepeatable = false;
    const firstStem = question.question.find((ref) => {
      const block = blocks.find((item) => item.id === ref.blockId)!;
      return sourceText(block.content).slice(ref.start, ref.end).trim();
    });
    const localStem = firstStem
      ? sourceText(blocks.find((item) => item.id === firstStem.blockId)!.content)
          .slice(firstStem.start, firstStem.end)
          .trim()
      : '';
    const explicitSingleChoice =
      /^[（(]单选[）)]/.test(localStem) || /[（(]单选[）)]\s*$/.test(localStem);
    const localFillChoice =
      question.questionType === 'fill_in_the_blank' &&
      /选项是\s*[（(]\s*[）)]\s*[。.?？]?\s*$/.test(localStem) &&
      question.blanks?.length === 1;
    if (explicitSingleChoice || localFillChoice) {
      const pool = question.options ?? [];
      const answerText = choiceAnswerText(question).trim();
      const labels = wordChoiceAnswerLabels(answerText);
      const validPool =
        pool.length >= 2 &&
        pool.length <= 26 &&
        pool.every(
          (option, index) =>
            option.sourceLabel.toUpperCase() === String.fromCharCode(65 + index) &&
            option.label.some((ref) => {
              const block = blocks.find((item) => item.id === ref.blockId)!;
              return sourceText(block.content).slice(ref.start, ref.end).trim();
            }),
        );
      if (
        validPool &&
        /^[A-Z](?:[\s,，、]*[A-Z])*$/.test(answerText) &&
        labels.every((label) => pool.some((option) => option.sourceLabel.toUpperCase() === label))
      ) {
        if (labels.length === 1) {
          question.questionType = 'single_choice';
          question.blanks = undefined;
          nonScoringMarkers.delete(question);
          explicitlyTyped.add(question);
        } else if (explicitSingleChoice)
          diagnostics.push({
            code: 'word-import.check-question-boundary',
            severity: 'warning',
            blockId: question.question[0]?.blockId,
          });
      }
    }
    const ordinaryFill = question.questionType === 'fill_in_the_blank' && !question.children.length;
    let mismatchedAnswerLabels = false;
    if (question.blanks?.length) {
      if (question.blanks.length === 1) question.blanks[0].answer = question.answer;
      else if (question.blanks.some((blank) => !blank.answer.length)) {
        const answerLabels: string[] = [];
        const spansFor = (pattern: RegExp, refs: WordSourceRange[]) =>
          refs.flatMap((ref) => {
            const block = blocks.find((item) => item.id === ref.blockId)!;
            const start = ref.start ?? 0;
            return [...sourceText(block.content).slice(start, ref.end).matchAll(pattern)]
              .filter((match) => match[0].trim())
              .map((match) =>
                range(block.id, start + match.index!, start + match.index! + match[0].length),
              );
          });
        const plainSpans = (refs: WordSourceRange[]) =>
          [
            spansFor(/\S(?:.*?\S)??(?=[ \u00a0]{4,}|\t|\n|\s*$)/g, refs),
            spansFor(/[^，,;；]+/g, refs),
            spansFor(/[^\s，,;；]+(?:[ \u00a0]{1,3}[^\s，,;；]+)*/g, refs),
            ...(/[\p{Script=Han}]/u.test(questionText(question))
              ? [spansFor(/\S(?:.*?\S)??(?=[ \u00a0]{2,}|\t|\n|\s*$)/g, refs)]
              : []),
          ].find((candidate) => candidate.length === question.blanks!.length);
        for (const answerRef of question.answer) {
          const block = blocks.find((item) => item.id === answerRef.blockId)!;
          const text = sourceText(block.content);
          const start = answerRef.start ?? 0;
          const end = answerRef.end ?? text.length;
          const matches = [
            ...text
              .slice(start, end)
              .matchAll(
                /(?:^|\s|[;；])[（(]?(\d+)(?:[）)．、]|\.(?!\d))\s*|(?:^|\s|[;；。．.，,])([①②③④⑤⑥⑦⑧⑨⑩])处\s*[:：]\s*/g,
              ),
          ];
          matches.forEach((match, index) => {
            const label = match[1] ?? String('①②③④⑤⑥⑦⑧⑨⑩'.indexOf(match[2]) + 1);
            answerLabels.push(label);
            const blank = question.blanks!.find(
              (item, blankIndex) => (item.sourceLabel ?? String(blankIndex + 1)) === label,
            );
            if (blank)
              blank.answer.push(
                range(
                  block.id,
                  start + match.index! + match[0].length,
                  index + 1 < matches.length ? start + matches[index + 1].index! : end,
                ),
              );
          });
          if (
            ordinaryFill &&
            !explicitlyTyped.has(question) &&
            !matches.length &&
            question.blanks.every((blank) => !blank.answer.length)
          )
            plainSpans([answerRef])?.forEach((ref, index) =>
              question.blanks![index].answer.push(ref),
            );
        }
        if (ordinaryFill && answerLabels.length)
          mismatchedAnswerLabels =
            answerLabels.length !== question.blanks.length ||
            new Set(answerLabels).size !== answerLabels.length ||
            answerLabels.some(
              (label) =>
                !question.blanks!.some(
                  (blank, index) => (blank.sourceLabel ?? String(index + 1)) === label,
                ),
            );
        if (
          ordinaryFill &&
          !answerLabels.length &&
          question.blanks.some((blank) => !blank.answer.length)
        ) {
          // A combined paragraph count can resolve answers not matched by an existing source key.
          plainSpans(question.answer)?.forEach((ref, index) =>
            question.blanks![index].answer.push(ref),
          );
        }
      }
    }
    const sourceAnswer = question.answer
      .map((ref) =>
        sourceText(blocks.find((block) => block.id === ref.blockId)!.content).slice(
          ref.start,
          ref.end,
        ),
      )
      .join('\n');
    const preserveFillAnswer =
      ordinaryFill &&
      (explicitlyTyped.has(question) ||
        [...question.question, ...question.answer].some((ref) =>
          blocks
            .find((block) => block.id === ref.blockId)!
            .content.some((node) => ['image', 'table'].includes(node.type)),
        )) &&
      (!question.blanks?.length ||
        (sourceAnswer.trim() &&
          (mismatchedAnswerLabels || question.blanks.some((blank) => !blank.answer.length))));
    const semicolonValues = sourceAnswer.split(/[;；]/).filter((value) => value.trim());
    const sourceSlotCount = question.blanks?.length ?? nonScoringMarkers.get(question)?.length ?? 0;
    const incompatibleMathAnswer =
      question.questionType === 'short_answer' &&
      !question.children.length &&
      sourceSlotCount > 1 &&
      /°|千米|点钟/.test(questionText(question)) &&
      semicolonValues.length > sourceSlotCount &&
      semicolonValues.some((value) => /^\s*\d+(?:[（(]|\s*$)/.test(value));
    if (preserveFillAnswer) {
      question.questionType = 'short_answer';
      question.blanks = undefined;
    }
    if (preserveFillAnswer || incompatibleMathAnswer) {
      diagnostics.push({
        code: 'word-import.uncertain-block',
        severity: 'warning',
        blockId: question.question[0]?.blockId,
        sourceAnswer,
      });
    }
    if (question.questionType === 'single_choice' && question.answer.length) {
      const answerText = choiceAnswerText(question).trim();
      const labels = wordChoiceAnswerLabels(answerText);
      if (
        !explicitlyTyped.has(question) &&
        labels.length > 1 &&
        labels.every((label) => /^[A-Z]$/.test(label))
      )
        question.questionType = 'multiple_choice';
    }
    question.children.forEach(finish);
  };
  roots.forEach(finish);
  return roots;
}

function consecutiveOptionPool(block: WordSourceBlock, options: WordOptionReference[]): boolean {
  return (
    options.length >= 2 &&
    options.length <= 26 &&
    options.every((option, index) => {
      const label = option.label[0];
      return (
        sourceText(block.content).slice(label.start, label.end).trim().length > 0 &&
        (!index ||
          option.sourceLabel.toUpperCase().charCodeAt(0) ===
            options[index - 1].sourceLabel.toUpperCase().charCodeAt(0) + 1)
      );
    })
  );
}

function readOptions(block: WordSourceBlock, start: number): WordOptionReference[] {
  const text = sourceText(block.content);
  const candidates = [...text.slice(start).matchAll(/(?<![（(])([A-Za-z])([.．、)）])\s*/g)];
  const boundaries: RegExpExecArray[] = [];
  for (const [index, match] of candidates.entries()) {
    const at = start + match.index!;
    const previous = boundaries.at(-1);
    const before = text[at - 1] ?? '';
    const body = text.slice(
      at + match[0].length,
      start + (candidates[index + 1]?.index ?? text.length - start),
    );
    const leadingBoundary = previous
      ? text.slice(start + previous.index! + previous[0].length, at)
      : '';
    const nextSeparatedMarker =
      previous &&
      match[1].toUpperCase().charCodeAt(0) === previous[1].toUpperCase().charCodeAt(0) + 1 &&
      /(?:\t|[ \u00a0]{2,}|[.．。！？?!]\s+)$/.test(leadingBoundary);
    if (previous && !nextSeparatedMarker && /^[A-Za-z][.．][A-Za-z][.．]/.test(text.slice(at)))
      continue;
    if (at > start && /[.．]/.test(before)) continue;
    if (at > start && /[\p{Script=Latin}\p{N}]/u.test(before)) {
      const compact =
        previous &&
        match[1].charCodeAt(0) === previous[1].charCodeAt(0) + 1 &&
        match[2] === previous[2] &&
        body.trim() &&
        !/[)）]/.test(match[2]);
      if (!compact) continue;
    }
    boundaries.push(match);
  }
  const matches = boundaries.filter(
    (match, index) =>
      !index ||
      text
        .slice(
          start + match.index! + match[0].length,
          index + 1 < boundaries.length ? start + boundaries[index + 1].index! : text.length,
        )
        .trim(),
  );
  if (!matches.length || text.slice(start, start + matches[0].index!).trim()) return [];
  const options = matches.map((match, index) => ({
    sourceLabel: match[1],
    label: [
      range(
        block.id,
        start + match.index! + match[0].length,
        index + 1 < matches.length ? start + matches[index + 1].index! : text.length,
      ),
    ],
  }));
  if (
    options.every((option) => {
      const label = option.label[0];
      return /^[_＿﹍﹎\s]+$/.test(text.slice(label.start, label.end));
    })
  )
    return [];
  return options;
}

function readBlanks(
  block: WordSourceBlock,
  start: number,
  end: number,
  context: string,
): WordBlankReference[] {
  return findWordBlankMarkers(block, start, end, context).map(({ sourceLabel, ...marker }) => ({
    marker,
    ...(sourceLabel ? { sourceLabel } : {}),
    answer: [],
  }));
}
