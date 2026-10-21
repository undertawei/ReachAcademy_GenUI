import {
  OPENMAIC_CHINESE_NARRATION_EXAMPLES,
  type NarrationExampleDiscipline,
  type NarrationExamplePagePosition,
  type NarrationExampleSceneType,
  type NarrationStyleExample,
  type NarrationTeachingMove,
} from './narration-style-examples.js';
import {
  OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID,
  type OneToOneNarrationCorpusEntry,
} from './narration-one-to-one-corpus.js';
import {
  NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES,
  NARRATION_TEACHER_REFERENCE_EXAMPLES,
  type NarrationTeacherPedagogyCalibrationExample,
  type NarrationTeacherReferenceExample,
} from './narration-teacher-calibration.js';
import type {
  NarrationDeliveryFunction,
  NarrationDisclosureMode,
} from './narration-capability-adapter.js';

export const NARRATION_STYLE_EXAMPLE_PROMPT_BUDGET = 1_800 as const;
export type NarrationStyleSourceMode = 'none' | 'openmaic-only' | 'teacher-only' | 'hybrid';

export interface NarrationStyleSelectionInput {
  readonly language: string;
  readonly pagePosition: NarrationExamplePagePosition;
  readonly precedingSceneType?: NarrationExampleSceneType | 'none';
  readonly teachingMoves: readonly NarrationTeachingMove[];
  readonly discipline?: NarrationExampleDiscipline;
  readonly keyConcepts?: readonly string[];
  readonly disclosureMode?: NarrationDisclosureMode;
}

export interface NarrationTeachingMoveDerivationInput {
  readonly pagePosition: NarrationExamplePagePosition;
  readonly sceneType: NarrationExampleSceneType;
  readonly precedingSceneType?: NarrationExampleSceneType | 'none';
  readonly title: string;
  readonly visibleContentSummary?: string;
  readonly pageRole?: string;
  readonly pageJob?: string;
  readonly keyPoints?: readonly string[];
  readonly pageFunctions?: readonly string[];
  readonly teachingMove?: string;
  readonly deliveryFunctions?: readonly NarrationDeliveryFunction[];
}

export interface ScoredNarrationStyleExample {
  readonly example: NarrationStyleExample;
  readonly score: number;
  readonly scoreBreakdown: {
    readonly pagePosition: number;
    readonly precedingSceneType: number;
    readonly teachingMoves: number;
    readonly disciplineAndKeywords: number;
  };
}

export interface NarrationStylePromptFragment {
  readonly promptText: string;
  readonly unicodeCharacterCount: number;
  readonly source: 'teacher' | 'openmaic';
  readonly teacherExample?: NarrationTeacherReferenceExample;
  readonly oneToOneExample?: OneToOneNarrationCorpusEntry;
  readonly primary?: ScoredNarrationStyleExample;
  readonly secondary?: ScoredNarrationStyleExample;
  readonly teacherPedagogyCalibration?: ScoredNarrationTeacherPedagogyCalibration;
}

export interface ScoredNarrationTeacherPedagogyCalibration {
  readonly example: NarrationTeacherPedagogyCalibrationExample;
  readonly score: number;
  readonly scoreBreakdown: {
    readonly pagePosition: number;
    readonly teachingMoves: number;
    readonly discipline: number;
    readonly keyConcepts: number;
  };
}

const DISCIPLINE_KEYWORDS: Readonly<Record<NarrationExampleDiscipline, readonly string[]>> = {
  language: ['语文', '文言', '文章', '文本', '字词', '朗读', '人物', '写作', '阅读', '主旨'],
  science: ['生物', '化学', '物理', '实验', '变量', '结构', '功能', '证据', '细胞', '消化', '吸收'],
  engineering: ['技术', '工程', '电子', '电路', '芯片', '信号', '系统', '控制', '算法', '计算机'],
};
const DISCIPLINE_ORDER: readonly NarrationExampleDiscipline[] = [
  'language',
  'science',
  'engineering',
] as const;

const unicodeLength = (value: string): number => Array.from(value).length;

const isChineseLanguage = (language: string): boolean => {
  const normalized = language.trim().toLowerCase();
  return (
    normalized === 'zh' ||
    normalized.startsWith('zh-') ||
    normalized.includes('chinese') ||
    normalized.includes('中文') ||
    normalized.includes('汉语')
  );
};

const unique = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

export const inferNarrationExampleDiscipline = (
  values: readonly string[],
): NarrationExampleDiscipline | undefined => {
  const searchable = values.join('\n').toLowerCase();
  const scored = DISCIPLINE_ORDER.map((discipline) => ({
    discipline,
    score: DISCIPLINE_KEYWORDS[discipline].filter((keyword) => searchable.includes(keyword)).length,
  })).sort(
    (left, right) =>
      right.score - left.score ||
      DISCIPLINE_ORDER.indexOf(left.discipline) - DISCIPLINE_ORDER.indexOf(right.discipline),
  );
  return scored[0]!.score === 0 ? undefined : scored[0]!.discipline;
};

const compareStableIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * 从固定页面信息推导教学动作。它不读取课程规划，也不调用模型；相同输入始终得到相同顺序。
 */
export const deriveNarrationTeachingMoves = (
  input: NarrationTeachingMoveDerivationInput,
): readonly NarrationTeachingMove[] => {
  const searchable = [
    input.title,
    input.visibleContentSummary ?? '',
    input.pageRole ?? '',
    input.pageJob ?? '',
    ...(input.keyPoints ?? []),
    ...(input.pageFunctions ?? []),
    input.teachingMove ?? '',
  ].join('\n');
  const primary: Record<string, NarrationTeachingMove> = {
    title: 'hook',
    hook: 'hook',
    roadmap: 'course_orientation',
    advance_organizer: 'course_orientation',
    exploration: 'observation_prompt',
    attempt: 'observation_prompt',
    reveal: 'concept_explanation',
    develop: 'concept_explanation',
    worked_example: 'evidence_reasoning',
    practice: 'practice_transition',
    checkpoint: 'practice_transition',
    section_open: 'section_transition',
    section_bridge: 'section_transition',
    stage_summary: 'synthesis_transfer',
    synthesis: 'synthesis_transfer',
    transfer: 'synthesis_transfer',
    close: 'synthesis_transfer',
  };
  const moves: NarrationTeachingMove[] = primary[input.pageRole ?? '']
    ? [primary[input.pageRole!]!]
    : [];
  const deliveryFunctions = new Set(input.deliveryFunctions ?? []);

  if (
    deliveryFunctions.has('course_opening') ||
    input.pagePosition === 'first' ||
    /导入|情境|问题驱动|hook/u.test(searchable)
  ) {
    moves.push('hook');
  }
  if (
    deliveryFunctions.has('course_orientation') ||
    input.pageRole === 'advance_organizer' ||
    input.pageRole === 'roadmap' ||
    input.pageFunctions?.includes('advance_organizer') === true ||
    input.pageFunctions?.includes('roadmap') === true ||
    /学习内容导览|学习路线|课程路线|路线图|目录|课程概览|内容概览|本课安排|本节安排|学习目标|advance_organizer|roadmap/u.test(
      searchable,
    )
  ) {
    moves.push('course_orientation');
  }
  if (/看|观察|图|表|注意|聚焦|比较|visual|observe/u.test(searchable)) {
    moves.push('attention_guidance');
  }
  if (
    deliveryFunctions.has('concept_explanation') ||
    /概念|定义|解释|原理|含义|explain|concept/u.test(searchable)
  ) {
    moves.push('concept_explanation');
  }
  if (/类比|好比|就像|analog/u.test(searchable)) moves.push('analogy');
  if (/公式|推导|机制|过程|流程|计算|formula|mechanism/u.test(searchable)) {
    moves.push('mechanism_or_formula');
  }
  if (/证据|依据|推理|论证|结果|数据|因果|evidence|reason/u.test(searchable)) {
    moves.push('evidence_reasoning');
  }
  if (/误区|易错|辨析|区分|对比|misconception|contrast/u.test(searchable)) {
    moves.push('misconception_contrast');
  }
  if (/观察|思考|预测|判断|为什么|如何|问题|observe|predict/u.test(searchable)) {
    moves.push('observation_prompt');
  }
  if (input.sceneType === 'quiz' || /练习|检测|自测|practice|quiz/u.test(searchable)) {
    moves.push('practice_transition');
  }
  if (input.precedingSceneType === 'quiz') moves.push('post_quiz_bridge');
  if (input.precedingSceneType === 'interactive') moves.push('post_interactive_bridge');
  if (
    deliveryFunctions.has('section_transition') ||
    /章节|部分|阶段|过渡|section|transition/u.test(searchable)
  ) {
    moves.push('section_transition');
  }
  if (/项目|实践|任务|创作|排演|project/u.test(searchable)) {
    moves.push('project_instruction');
  }
  if (
    deliveryFunctions.has('synthesis_transfer') ||
    input.pageRole === 'stage_summary' ||
    input.pageRole === 'synthesis' ||
    input.pageRole === 'transfer' ||
    input.pageRole === 'close' ||
    input.pageFunctions?.some((role) =>
      ['stage_summary', 'synthesis', 'transfer', 'close'].includes(role),
    ) === true ||
    /总结|小结|迁移|回望|展望|synthesi|transfer|stage_summary|close/u.test(searchable)
  ) {
    moves.push('synthesis_transfer');
  }

  return unique(moves.length > 0 ? moves : ['concept_explanation']);
};

const disciplineAndKeywordScore = (
  example: NarrationStyleExample,
  input: NarrationStyleSelectionInput,
): number => {
  if (input.discipline === example.discipline) return 40;
  const concepts = (input.keyConcepts ?? [])
    .map((concept) => concept.trim().toLowerCase())
    .filter((concept) => concept.length >= 2);
  if (concepts.length === 0) return 0;

  const disciplineHits = DISCIPLINE_KEYWORDS[example.discipline].filter((keyword) =>
    concepts.some((concept) => concept.includes(keyword) || keyword.includes(concept)),
  ).length;
  const exampleText = `${example.sourceTitle}\n${example.exampleText}`.toLowerCase();
  const directHits = concepts.filter((concept) => exampleText.includes(concept)).length;
  return Math.min(40, disciplineHits * 20 + directHits * 10);
};

export const scoreNarrationStyleExample = (
  example: NarrationStyleExample,
  input: NarrationStyleSelectionInput,
): ScoredNarrationStyleExample => {
  const positionScore = example.pagePosition === input.pagePosition ? 100 : 0;
  const hasPrecedingSceneSignal = input.precedingSceneType !== undefined;
  const requestedPrevious =
    input.precedingSceneType === 'none' ? undefined : input.precedingSceneType;
  const precedingScore =
    hasPrecedingSceneSignal && example.precedingSceneType === requestedPrevious ? 80 : 0;
  const matchedMoves = example.teachingMoves.filter((move) => input.teachingMoves.includes(move));
  const moveScore = Math.min(120, matchedMoves.length * 60);
  const relevanceScore = disciplineAndKeywordScore(example, input);
  return {
    example,
    score: positionScore + precedingScore + moveScore + relevanceScore,
    scoreBreakdown: {
      pagePosition: positionScore,
      precedingSceneType: precedingScore,
      teachingMoves: moveScore,
      disciplineAndKeywords: relevanceScore,
    },
  };
};

export const rankNarrationStyleExamples = (
  input: NarrationStyleSelectionInput,
): readonly ScoredNarrationStyleExample[] => {
  if (!isChineseLanguage(input.language)) return [];
  return OPENMAIC_CHINESE_NARRATION_EXAMPLES.filter(
    (example) => example.productionEligible && OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.has(example.id),
  )
    .map((example) => scoreNarrationStyleExample(example, input))
    .sort(
      (left, right) =>
        right.score - left.score || compareStableIds(left.example.id, right.example.id),
    );
};

/**
 * 项目任务的说话方式比前页场景相同更稀缺。保留原始稳定分数用于观测和普通页面排序，
 * 但项目页的主示例先从真正的 project_instruction 示例中选择，避免普通讲解页仅凭
 * precedingSceneType 加分抢走声音示范。分区内仍保持 score + id 的既有稳定顺序。
 */
const prioritizeTaskSpecificExamples = (
  input: NarrationStyleSelectionInput,
  ranked: readonly ScoredNarrationStyleExample[],
): readonly ScoredNarrationStyleExample[] => {
  if (!input.teachingMoves.includes('project_instruction')) return ranked;
  return [
    ...ranked.filter((candidate) =>
      candidate.example.teachingMoves.includes('project_instruction'),
    ),
    ...ranked.filter(
      (candidate) => !candidate.example.teachingMoves.includes('project_instruction'),
    ),
  ];
};

const normalizedConcepts = (input: NarrationStyleSelectionInput): readonly string[] =>
  (input.keyConcepts ?? [])
    .map((concept) => concept.trim().toLocaleLowerCase())
    .filter((concept) => concept.length >= 2);

const teacherPedagogyKeywordHits = (
  example: NarrationTeacherPedagogyCalibrationExample,
  input: NarrationStyleSelectionInput,
): number => {
  const concepts = normalizedConcepts(input);
  if (concepts.length === 0) return 0;
  return example.keyConcepts.filter((keyword) => {
    const normalizedKeyword = keyword.toLocaleLowerCase();
    return concepts.some(
      (concept) => concept.includes(normalizedKeyword) || normalizedKeyword.includes(concept),
    );
  }).length;
};

export const scoreNarrationTeacherPedagogyCalibration = (
  example: NarrationTeacherPedagogyCalibrationExample,
  input: NarrationStyleSelectionInput,
): ScoredNarrationTeacherPedagogyCalibration => {
  const pagePosition = example.pagePositions.includes(input.pagePosition) ? 100 : 0;
  const teachingMoves = Math.min(
    120,
    example.teachingMoves.filter((move) => input.teachingMoves.includes(move)).length * 60,
  );
  const discipline =
    input.discipline !== undefined && example.disciplines.includes(input.discipline) ? 40 : 0;
  const keyConcepts = Math.min(40, teacherPedagogyKeywordHits(example, input) * 10);
  return {
    example,
    score: pagePosition + teachingMoves + discipline + keyConcepts,
    scoreBreakdown: { pagePosition, teachingMoves, discipline, keyConcepts },
  };
};

export const selectNarrationTeacherPedagogyCalibration = (
  input: NarrationStyleSelectionInput,
): ScoredNarrationTeacherPedagogyCalibration | undefined => {
  if (!isChineseLanguage(input.language) || input.teachingMoves.includes('project_instruction')) {
    return undefined;
  }
  return NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES.filter(
    (example) =>
      example.productionEligible &&
      (example.teachingMoves.some((move) => input.teachingMoves.includes(move)) ||
        teacherPedagogyKeywordHits(example, input) > 0),
  )
    .map((example) => scoreNarrationTeacherPedagogyCalibration(example, input))
    .sort(
      (left, right) =>
        right.score - left.score || compareStableIds(left.example.id, right.example.id),
    )[0];
};

export interface ScoredNarrationTeacherReference {
  readonly example: NarrationTeacherReferenceExample;
  readonly score: number;
}

export const rankNarrationTeacherReferences = (
  input: NarrationStyleSelectionInput,
): readonly ScoredNarrationTeacherReference[] => {
  if (!isChineseLanguage(input.language)) return [];
  const concepts = normalizedConcepts(input);
  const primaryMove = input.teachingMoves[0];
  return NARRATION_TEACHER_REFERENCE_EXAMPLES.filter((example) => {
    if (!example.productionEligible || primaryMove === undefined) return false;
    if (!example.teachingMoves.includes(primaryMove)) return false;
    if (example.pagePositions.includes('first') && input.pagePosition !== 'first') return false;
    if (input.pagePosition === 'first' && !example.pagePositions.includes('first')) return false;
    return true;
  })
    .map((example) => {
      const keywordHits = example.keyConcepts.filter((keyword) => {
        const normalized = keyword.toLocaleLowerCase();
        return concepts.some(
          (concept) => concept.includes(normalized) || normalized.includes(concept),
        );
      }).length;
      return {
        example,
        score:
          (example.pagePositions.includes(input.pagePosition) ? 100 : 0) +
          Math.min(
            120,
            example.teachingMoves.filter((move) => input.teachingMoves.includes(move)).length * 60,
          ) +
          (input.discipline === example.discipline ? 40 : 0) +
          Math.min(40, keywordHits * 10),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score || compareStableIds(left.example.id, right.example.id),
    );
};

const oneToOneTextFor = (example: NarrationStyleExample): OneToOneNarrationCorpusEntry => {
  const rewritten = OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get(example.id);
  if (rewritten === undefined)
    throw new Error(`Missing one-to-one narration rewrite: ${example.id}`);
  return rewritten;
};

const oneToOneExcerpt = (example: NarrationStyleExample): string => {
  const text = oneToOneTextFor(example).narrationMarkdown;
  const firstParagraph = text.split(/\n\s*\n/u)[0]?.trim() ?? text.trim();
  return firstParagraph;
};

export const selectOneToOneNarrationExample = (
  input: NarrationStyleSelectionInput,
): OneToOneNarrationCorpusEntry | undefined => {
  const primary = prioritizeTaskSpecificExamples(input, rankNarrationStyleExamples(input))[0];
  return primary === undefined ? undefined : oneToOneTextFor(primary.example);
};

const styleExampleIntro = (source: 'teacher' | 'openmaic'): string =>
  source === 'teacher'
    ? '教师逐句手改完整示范。模仿她把问题讲具体、把逻辑说准确、把任务说完整的方式。'
    : 'OpenMAIC 教师讲稿完整示范。模仿其完整讲解与自然换气，保留有用的课堂关系。';

const formatPrompt = (
  source: 'teacher' | 'openmaic',
  primaryText: string,
  secondary?: { source: 'teacher' | 'openmaic'; text: string },
): string => `${styleExampleIntro(source)}
只迁移教师话语方式和教学动作，不迁移示例的人物、数字、公式、答案或结论；当前课程和页面事实始终优先。

${primaryText}${secondary === undefined ? '' : `\n\n另一课程的同类教学动作片段：\n${secondary.text}`}`;

/** A pure local source switch supports ablation benchmarks without branching production behavior. */
export const buildNarrationStylePromptFragment = (
  input: NarrationStyleSelectionInput,
  budget: number = NARRATION_STYLE_EXAMPLE_PROMPT_BUDGET,
  sourceMode: NarrationStyleSourceMode = 'hybrid',
): NarrationStylePromptFragment | undefined => {
  if (!Number.isInteger(budget) || budget <= 0)
    throw new Error('Narration style budget must be positive.');
  if (sourceMode === 'none' || !isChineseLanguage(input.language)) return undefined;
  // Concrete full examples are stronger than abstract policy. For low-disclosure or narrowly
  // scoped stages, an approximate example can easily answer the question, reteach the whole
  // course, or turn a brief close into a long summary. Until an exact role-matched corpus exists,
  // rely on the explicit delivery policy and its short in-prompt examples instead.
  if (
    input.disclosureMode !== undefined &&
    [
      'preview_without_reveal',
      'question_without_answer',
      'observe_before_explaining',
      'transition_without_reteaching',
      'consolidate_current_stage',
      'transfer_learning',
      'close_briefly',
    ].includes(input.disclosureMode)
  ) {
    return undefined;
  }
  const teacherCandidates =
    sourceMode === 'openmaic-only' ? [] : rankNarrationTeacherReferences(input);
  const openmaicCandidates =
    sourceMode === 'teacher-only'
      ? []
      : prioritizeTaskSpecificExamples(input, rankNarrationStyleExamples(input)).filter(
          (candidate) =>
            candidate.example.teachingMoves.some((move) => input.teachingMoves.includes(move)),
        );
  const primaryCandidates: Array<{
    source: 'teacher' | 'openmaic';
    text: string;
    teacherExample?: NarrationTeacherReferenceExample;
    openmaicExample?: ScoredNarrationStyleExample;
  }> = [
    ...teacherCandidates.map(({ example }) => ({
      source: 'teacher' as const,
      text: example.productionText,
      teacherExample: example,
    })),
    ...openmaicCandidates.map((candidate) => ({
      source: 'openmaic' as const,
      text: oneToOneTextFor(candidate.example).narrationMarkdown,
      openmaicExample: candidate,
    })),
  ];
  const primary = primaryCandidates.find(
    (candidate) => unicodeLength(formatPrompt(candidate.source, candidate.text)) <= budget,
  );
  if (primary === undefined) return undefined;
  const primaryCourse =
    primary.teacherExample?.sourceCourse ?? primary.openmaicExample?.example.sourceCourse;
  const secondaryCandidates =
    primary.source === 'teacher'
      ? openmaicCandidates
          .filter(
            (candidate) =>
              candidate.example.sourceCourse !== primaryCourse &&
              candidate.example.teachingMoves.some((move) => input.teachingMoves.includes(move)),
          )
          .map((candidate) => ({
            source: 'openmaic' as const,
            text: oneToOneExcerpt(candidate.example),
            secondary: candidate,
          }))
      : teacherCandidates
          .filter(
            ({ example }) =>
              example.sourceCourse !== primaryCourse &&
              example.teachingMoves.some((move) => input.teachingMoves.includes(move)),
          )
          .map(({ example }) => ({
            source: 'teacher' as const,
            text: example.productionText.split(/\n\s*\n/u)[0]?.trim() ?? example.productionText,
          }));
  const secondary =
    sourceMode === 'hybrid' && !input.teachingMoves.includes('project_instruction')
      ? secondaryCandidates.find(
          (candidate) =>
            unicodeLength(formatPrompt(primary.source, primary.text, candidate)) <= budget,
        )
      : undefined;
  const promptText = formatPrompt(primary.source, primary.text, secondary);
  return {
    promptText,
    unicodeCharacterCount: unicodeLength(promptText),
    source: primary.source,
    ...(primary.teacherExample === undefined ? {} : { teacherExample: primary.teacherExample }),
    ...(primary.openmaicExample === undefined
      ? {}
      : {
          primary: primary.openmaicExample,
          oneToOneExample: oneToOneTextFor(primary.openmaicExample.example),
        }),
    ...(secondary !== undefined && 'secondary' in secondary
      ? { secondary: secondary.secondary }
      : {}),
  };
};
