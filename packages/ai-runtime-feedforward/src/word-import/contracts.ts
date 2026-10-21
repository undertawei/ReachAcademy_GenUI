import type { QuizQuestion, QuizQuestionType, RichTextNode } from '@reachany/reach-deck-dsl';
import type {
  FieldTarget,
  ImportDiagnostic,
  WordUnresolvedItem,
  WordSourceExcerpt,
} from './diagnostics.js';

/** UTF-16 offsets in paragraph text; every non-text inline node occupies one code unit. */
export interface WordSourceRange {
  blockId: string;
  start?: number;
  end?: number;
}

export interface WordSourceBlock {
  id: string;
  content: RichTextNode[];
  numbering?: { level: number; label: string; format?: string };
}

export interface WordOptionReference {
  label: WordSourceRange[];
  sourceLabel: string;
}

export interface WordBlankReference {
  marker: WordSourceRange;
  sourceLabel?: string;
  answer: WordSourceRange[];
  candidates?: WordOptionReference[];
}

/** A model supplies only structure and source references, never rich text or asset URLs. */
export interface WordQuestionReference {
  sourceLabel?: string;
  questionType: QuizQuestionType;
  question: WordSourceRange[];
  answer: WordSourceRange[];
  analysis: WordSourceRange[];
  /** Extracted source metadata; validated and accounted for but not yet mapped to native content. */
  knowledgePoints?: WordSourceRange[];
  points?: number;
  pointsSource?: WordSourceRange;
  options?: WordOptionReference[];
  blanks?: WordBlankReference[];
  candidatePoolRepeatable?: boolean;
  children: WordQuestionReference[];
}

export interface WordImportDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  blockId?: string;
  questionId?: string;
  /** Original answer for teacher correction; preview-only, never native question content. */
  sourceAnswer?: string;
}

export type WordImportCandidate = Omit<QuizQuestion, 'points' | 'sub_problems'> & {
  points?: number;
  sub_problems: WordImportCandidate[];
};

export interface WordImportPreview {
  /** Absent on immutable v1 artifacts. Never add before checking their original hash. */
  diagnosticVersion?: string;
  fieldDiagnostics?: ImportDiagnostic[];
  unresolvedItems?: WordUnresolvedItem[];
  sourceExcerpts?: WordSourceExcerpt[];
  diagnosticsTruncated?: boolean;
  parserVersion: string;
  questions: WordImportCandidate[];
  diagnostics: WordImportDiagnostic[];
  /** Private preview metadata, never copied into a native question or persisted content. */
  sources: Record<
    string,
    {
      blockIds: string[];
      sourceLabel?: string;
      sourceRanges?: WordSourceRange[];
      fields?: Array<{
        field: FieldTarget;
        sourceRanges: WordSourceRange[];
      }>;
    }
  >;
}

export const WORD_IMPORT_PARSER_VERSION = 'word-import/v1';

/** Shared by type inference and option resolution so accepted separators cannot disagree. */
export function wordChoiceAnswerLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .trim()
        .replace(/^[【\[]?答案[】\]]?\s*[:：]?\s*/, '')
        .replace(/[\s,，、;；()（）.．]/g, '')
        .toUpperCase()
        .split(''),
    ),
  ];
}

/** Comparison-only decoding; the source projection and its offsets remain unchanged. */
export function wordChoiceSourceText(nodes: readonly RichTextNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'inlineMath' || node.type === 'blockMath') {
        let value = typeof node.attrs?.latex === 'string' ? node.attrs.latex.trim() : '';
        while (value.startsWith('{') && value.endsWith('}')) value = value.slice(1, -1).trim();
        if (/^[A-Z]$/.test(value)) return value;
      }
      return sourceText([node]);
    })
    .join('');
}

export function sourceText(nodes: readonly RichTextNode[]): string {
  return nodes
    .map((node) =>
      node.type === 'text' ? (node.text ?? '') : node.type === 'hardBreak' ? '\n' : '\uFFFC',
    )
    .join('');
}

export function isWordQuizHeader(text: string): boolean {
  const value = text.replaceAll('\u00a0', ' ').replaceAll('\uFFFC', '').trim();
  return (
    /学校\s*[:：]\s*_+\s*姓名\s*[:：]\s*_+\s*班级\s*[:：]\s*_+/i.test(value) ||
    /^\d{4}年\d{1,2}月\d{1,2}日(?:初中|高中|小学)?[\u4e00-\u9fff]{2,8}作业$/.test(value)
  );
}

/** Only complete structural labels qualify; adjacent substantive prose remains reviewable. */
export function readWordMathSection(
  text: string,
  numbering?: WordSourceBlock['numbering'],
): { label: string; inferred: boolean } | undefined {
  let value = text.trim();
  const arabicTask = /^\d+\s*[、.．)）]/.test(value);
  if (numbering?.label && value.startsWith(numbering.label))
    value = value.slice(numbering.label.length).trim();
  const chineseSection = /^[一二三四五六七八九十百]+\s*[、.．)）]\s*/.test(value);
  value = value.replace(/^[一二三四五六七八九十百\d]+\s*[、.．)）]\s*/, '');
  if (
    value.length > 80 ||
    /_{2,}|[（(][ \u00a0]*[）)]|\uFFFC|【(?:答案|解析|分析|详解)】|(?:参考)?(?:答案|解析|分析|详解)\s*[:：]|[?？]|[=＝×÷]|\d\s*[+\-<>≤≥]/.test(
      value,
    )
  )
    return;
  const pointsNote =
    /^[（(]?\s*(?:每(?:小)?题\d+(?:\.\d+)?分\s*[，,、]\s*)?共\d+(?:\.\d+)?分\s*[）)]?$/;
  const punctuatedReset =
    /^(解决问题|应用题|操作题|计算)\s*[:：。.]\s*([（(][^）)]{1,32}[）)])\s*$/.exec(value);
  const reset =
    /^(解决问题|应用题|操作题|计算)\s*(?:[（(][^）)]{1,32}[）)])?\s*[:：。.]?\s*$/.exec(value) ??
    (punctuatedReset && pointsNote.test(punctuatedReset[2]) ? punctuatedReset : null);
  if (reset && (chineseSection || numbering?.level === 0))
    return { label: reset[1], inferred: true };
  const title =
    /^(选择题|作图题|判断题|计算题|排序题)\s*(?:[（(][^）)]{1,32}[）)])?\s*(?:[:：。.]\s*([^\n]{0,32}))?\s*$/.exec(
      value,
    );
  if (!title || /[A-Za-z]\s*[+\-]\s*[A-Za-z\d]/.test(title[2] ?? '')) return;
  const instruction = title[2]?.trim();
  if (instruction) {
    let parenthesisDepth = 0;
    for (const character of instruction) {
      if (/[（(]/.test(character)) parenthesisDepth += 1;
      else if (/[）)]/.test(character) && --parenthesisDepth < 0) return;
    }
    if (parenthesisDepth !== 0) return;
    if (arabicTask || (numbering !== undefined && numbering.level !== 0)) return;
    if (
      /^\d/.test(numbering?.label ?? '') &&
      !/^直接写出得数[。.]?$/.test(instruction) &&
      !pointsNote.test(instruction.replace(/[。.]$/, ''))
    )
      return;
  }
  return { label: title[1], inferred: title[1] === '选择题' };
}

export function isWordStructuralLabel(
  text: string,
  numbering?: WordSourceBlock['numbering'],
): boolean {
  const value = text.trim();
  return (
    readWordMathSection(value, numbering) !== undefined ||
    /^(?:【(?:参考答案|答案|解析|分析|详解|知识点|导语|点睛)】|\[(?:参考答案|答案|解析|分析|详解|知识点)\]|(?:参考)?答案|解析|分析|详解|知识点)\s*[:：]?$/.test(
      value,
    ) ||
    /^(?:[一二三四五六七八九十百\d]+\s*[、.．)）]\s*)?(?:单项?选择题?|单选题?|多项?选择题?|多选题?|填空题|简答题|解答题|完形填空题?)(?:[（(][^）)]{1,32}[）)])?\s*[:：]?$/.test(
      value,
    ) ||
    /^[一二三四五六七八九十]+、\s*(?:积累运用|默写|名篇名句默写|语言表达|语言文字运用|综合性学习|名著阅读|现代文阅读|文言文阅读|古代诗歌阅读|阅读理解|阅读选择|阅读判断|作文|写作)\s*$/.test(
      value,
    )
  );
}

export function extractWordKnowledgePoints(
  block: WordSourceBlock,
  start = 0,
  end = sourceText(block.content).length,
): { content: WordSourceRange[]; knowledgePoints: WordSourceRange[] } {
  const text = sourceText(block.content);
  const marker = /【知识点】/.exec(text.slice(start, end));
  if (!marker)
    return {
      content: start < end ? [{ blockId: block.id, start, end }] : [],
      knowledgePoints: [],
    };
  const markerStart = start + marker.index;
  const valueStart = markerStart + marker[0].length;
  const knowledgePoints = [...text.slice(valueStart, end).matchAll(/[^、,，;；\n]+/g)].flatMap(
    (match) => {
      const raw = match[0];
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const from = valueStart + match.index! + leading;
      const to = valueStart + match.index! + raw.length - trailing;
      return from < to ? [{ blockId: block.id, start: from, end: to }] : [];
    },
  );
  return {
    content: start < markerStart ? [{ blockId: block.id, start, end: markerStart }] : [],
    knowledgePoints,
  };
}

export function findWordBlankMarkers(
  block: WordSourceBlock,
  start = 0,
  end = sourceText(block.content).length,
  questionContext = '',
  policy: 'candidate' | 'required' = 'candidate',
): Array<WordSourceRange & { sourceLabel?: string }> {
  const markers: Array<WordSourceRange & { sourceLabel?: string }> = [];
  const text = sourceText(block.content);
  const context = `${questionContext} ${text}`;
  const parenthetical = [...text.matchAll(/[（(]([ \u00a0]*)[）)]/g)];
  const literalParenthetical = parenthetical.filter((match) => {
    const before = text.slice(Math.max(0, match.index! - 32), match.index!);
    const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 32);
    const describesPunctuation = (value: string) =>
      /^(?:在[^。！？]{0,24}(?:作用|含义)|的?(?:用法|作用|含义)|(?:通常)?用于|是?(?:什么意思|什么含义))/.test(
        value,
      );
    const namedPunctuation =
      /(?:括号|圆括号|小括号|符号|标点)\s*$/.test(before) && describesPunctuation(after);
    const quotedPunctuation =
      /[“"]$/.test(before) && /^[”"]/.test(after) && describesPunctuation(after.slice(1));
    // A named/explained empty call is literal syntax; spaced argument placeholders remain blanks.
    const explainedCall =
      match[0] === '()' &&
      /[A-Za-z_]\w*$/.test(before) &&
      (/(?:函数|解释|说明|调用|执行|运行)\s*[A-Za-z_]\w*$/.test(before) || /^\s*函数/.test(after));
    return namedPunctuation || quotedPunctuation || explainedCall;
  });
  const isLiteralParenthetical = (from: number, to: number) =>
    literalParenthetical.some(
      (match) => from >= match.index! && to <= match.index! + match[0].length,
    );
  const drawingTools = [...text.matchAll(/[“"]([_ \u00a0]{2,})[”"]/g)].filter((match) => {
    const before = text.slice(Math.max(0, match.index! - 16), match.index!);
    const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 24);
    return (
      /(?:用|画)\s*$/.test(before) &&
      /^(?:在(?:文中|诗歌中|短文中))?(?:画出|画|的句子|的语句)/.test(after)
    );
  });
  const isDrawingTool = (from: number, to: number) =>
    drawingTools.some(
      (match) => from >= match.index! + 1 && to <= match.index! + match[0].length - 1,
    );
  const highlightedData =
    /横线(?:上|处)?的数|带下划线的数|(?:读|写)出(?:下面|下列)?各数|(?:读|写)出下面(?:的)?数|改写(?:成|为).*?(?:单位|科学记数|计数)|省略.*(?:尾数|后面)/.test(
      context,
    );
  const numericRuns = [...text.matchAll(/\d+(?:[.．,，]\d+)*/g)];
  let offset = 0;
  for (const node of block.content) {
    const value = sourceText([node]);
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + value.length);
    if (from < to && node.type === 'text') {
      const visible = value.slice(from - offset, to - offset);
      const underlined = node.marks?.some((mark) => mark.type === 'underline');
      const pattern = underlined ? /\s*\d+\s*|\s{2,}|_+/g : /_{2,}/g;
      for (const match of visible.matchAll(pattern)) {
        if (isDrawingTool(from + match.index!, from + match.index! + match[0].length)) continue;
        if (isLiteralParenthetical(from + match.index!, from + match.index! + match[0].length))
          continue;
        const sourceLabel = match[0].trim();
        if (underlined && /^\d+$/.test(sourceLabel)) {
          const numericAt = from + match.index! + match[0].indexOf(sourceLabel);
          const numericRun = numericRuns.find(
            (run) =>
              run.index! <= numericAt &&
              run.index! + run[0].length >= numericAt + sourceLabel.length,
          );
          const paddedLabel = /^\s{2,}\d{1,3}\s{2,}$/.test(match[0]);
          // Numeric tokens can span several Word style runs, including an unmarked decimal point.
          if (
            numericRun &&
            (/[.．,，]\d/.test(numericRun[0]) ||
              /^\d{4,}$/.test(numericRun[0]) ||
              (highlightedData && !paddedLabel))
          )
            continue;
        }
        markers.push({
          blockId: block.id,
          start: from + match.index!,
          end: from + match.index! + match[0].length,
          ...(sourceLabel && /^\d+$/.test(sourceLabel) ? { sourceLabel } : {}),
        });
      }
    }
    offset += value.length;
  }
  for (const match of policy === 'candidate' ? parenthetical : []) {
    if (
      match.index! < start ||
      match.index! + match[0].length > end ||
      literalParenthetical.includes(match)
    )
      continue;
    const at = match.index! + 1;
    const length = match[1].length;
    if (
      /重新排列以上句子/.test(text) &&
      /把序号填在\s*$/.test(text.slice(0, at - 1)) &&
      /^里/.test(text.slice(at + length + 1)) &&
      /[（(]\s*[）)]/.test(questionContext)
    )
      continue;
    // Empty parentheses need a nonempty source range for the native blank contract.
    const markerStart = length ? at : at - 1;
    const markerEnd = length ? at + length : at + 1;
    if (
      !markers.some((marker) => (marker.start ?? 0) < markerEnd && (marker.end ?? 0) > markerStart)
    ) {
      markers.push({ blockId: block.id, start: markerStart, end: markerEnd });
    }
  }
  markers.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return markers;
}

/** Slices preserve marks and atomic math/image nodes. Offsets never use rendered LaTeX length. */
export function sliceSource(
  nodes: readonly RichTextNode[],
  start: number,
  end: number,
): RichTextNode[] {
  const result: RichTextNode[] = [];
  let offset = 0;
  for (const node of nodes) {
    const length = node.type === 'text' ? (node.text?.length ?? 0) : 1;
    const from = Math.max(0, start - offset);
    const to = Math.min(length, end - offset);
    if (from < to) {
      result.push(
        node.type === 'text'
          ? { ...structuredClone(node), text: (node.text ?? '').slice(from, to) }
          : structuredClone(node),
      );
    }
    offset += length;
  }
  return result;
}
