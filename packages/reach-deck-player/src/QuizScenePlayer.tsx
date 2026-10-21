'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Minus, X } from 'lucide-react';
import {
  emptyQuestionAnswer,
  emptyQuizRichText,
  isCompleteQuestionAnswer,
  parseQuestionAnswerValue,
  type Question,
  type QuestionAnswer,
  type FillBlanksQuestionAnswer,
  type QuizScene,
  type RichTextQuestionAnswer,
} from '@reachany/reach-deck-dsl';

import {
  Button,
  QuestionOption,
  QuestionOptionGroup,
  QuestionOutcome,
  type QuestionOptionResult,
} from '@reachany/ui';

import { QuizAnswerEditor, type QuizAnswerAssetUploader } from './QuizAnswerEditor.js';
import {
  ReachDeckAttachmentList,
  type ReachDeckAttachmentUrlResolver,
  type ReachDeckAttachmentUnavailablePredicate,
} from './ReachDeckAttachmentList.js';
import { ReachDeckRichText } from './ReachDeckRichText.js';
import type {
  QuizGradingByQuestionId,
  QuizGradingMode,
  QuizGradingView,
  QuizSceneLayout,
  QuizSceneRuntimeState,
} from './types.js';
import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';
import { gradeObjectiveQuestion, isScoredQuestion } from './objectiveGrading.js';

interface Props {
  /** Observation: recorded evidence and browsing remain visible; all learner writes are disabled. */
  readOnly?: boolean;
  initialQuestionId?: string;
  /** Local browsing only; separate from learner runtime persistence. */
  onQuestionChange?: (questionId: string) => void;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  isAttachmentUnavailable?: ReachDeckAttachmentUnavailablePredicate;
  scene: QuizScene;
  sourceRevision?: number;
  /** 稳定 objectKey → 短时展示 URL；授课内容里的行内图片不存 URL，渲染期在这里补。 */
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  initialRuntimeState?: QuizSceneRuntimeState;
  onRuntimeStateChange?: (state: QuizSceneRuntimeState) => void;
  onSubmit?: (
    questionId: string,
    answer: QuestionAnswer | undefined,
    state: QuizSceneRuntimeState,
  ) => void;
  teacherRevealAnswers?: boolean;
  masteredLearningFenceQuestionIds?: readonly string[];
  /**
   * Who grades submitted answers. `server` (the default, used by every learner host) never grades
   * locally and reveals answers only after the server result is terminal; `trial` is reserved for
   * Teacher Trial/authoring previews, which grade objective questions locally and show the
   * reference answer for AI-graded questions right away.
   */
  gradingMode?: QuizGradingMode;
  /** 题目页排布，缺省 `default`；学生端传 `learner`（见 {@link QuizSceneLayout}）。 */
  layout?: QuizSceneLayout;
  /**
   * Server-authoritative grading by question id (server mode). When the host supplies no
   * projection at all, scored submitted questions stay pending and nothing is revealed.
   */
  gradingByQuestionId?: QuizGradingByQuestionId;
  /** Submitted questions whose submission the host could not save; grading cannot start. */
  unsyncedSubmissionQuestionIds?: readonly string[];
  onRetryGrading?: (questionId: string) => void;
  /** Host-owned safe renderer for controlled grading Markdown; plain text when omitted. */
  renderGradingFeedback?: (markdown: string) => ReactNode;
  translate?: ReachDeckTranslate;
  uploadAnswerAsset?: QuizAnswerAssetUploader;
}

/**
 * 揭晓后的逐项结果：选中且正确 = correct，选中但错误 = incorrect，未选的正确答案 = missed；
 * 与判分无关的选项不标注。
 */
function choiceOptionResults(
  answer: Question['answer'],
  selected: readonly string[],
): Record<string, QuestionOptionResult> | undefined {
  if (!Array.isArray(answer)) return undefined;
  const results: Record<string, QuestionOptionResult> = {};
  for (const value of selected) results[value] = answer.includes(value) ? 'correct' : 'incorrect';
  for (const value of answer) if (!selected.includes(value)) results[value] = 'missed';
  return results;
}

function AnswerEditor({
  resolveAttachmentUrl,
  onBusyChange,
  disabled,
  labelledBy,
  learner,
  mediaUrlsByObjectKey,
  question,
  reveal,
  uploadAnswerAsset,
  value,
  onChange,
  translate,
  visibleBlankId,
}: {
  visibleBlankId?: string;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  disabled: boolean;
  /** 题干元素 id，选项组用它作为可读名称。 */
  labelledBy?: string;
  /** 学生端排布：填空候选为紧凑选块，可清空本空、标出已被其他空占用的候选。 */
  learner: boolean;
  onBusyChange?: (busy: boolean) => void;
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  question: Question;
  reveal: boolean;
  uploadAnswerAsset?: QuizAnswerAssetUploader;
  value: QuestionAnswer;
  onChange: (value: QuestionAnswer) => void;
  translate?: ReachDeckTranslate;
}) {
  if (question.question_type === 'single_choice' || question.question_type === 'multiple_choice') {
    const selected = value.kind === 'selection' ? value.values : [];
    const multiple = question.question_type === 'multiple_choice';
    const results = reveal ? choiceOptionResults(question.answer, selected) : undefined;
    const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
    return (
      // 共享 QuestionOption（规范 03 §3.8a）：选中只用 primary 系，揭晓后逐项标注正确 / 错误 / 正确答案或漏选；
      // 已提交为只读（仍可聚焦与读屏）。判分文案由宿主的 reach-deck 翻译回调提供。
      <div className="quiz-scene__options is-choices">
        <QuestionOptionGroup
          aria-labelledby={labelledBy}
          labels={{
            correct: text('reachDeck.player.quiz.option.correct', '正确'),
            correctAnswer: text('reachDeck.player.quiz.option.correctAnswer', '正确答案'),
            incorrect: text('reachDeck.player.quiz.option.incorrect', '错误'),
            missed: text('reachDeck.player.quiz.option.missed', '漏选'),
          }}
          multiple={multiple}
          name={`question-${question.question_index}`}
          onChange={(values) => {
            if (disabled) return;
            onChange({ kind: 'selection', values: multiple ? values : values.slice(0, 1) });
          }}
          readOnly={disabled}
          value={selected}
        >
          {(question.options ?? []).map((option) => (
            <QuestionOption
              key={option.value}
              marker={option.value}
              result={results?.[option.value]}
              value={option.value}
            >
              <div className="quiz-scene__rich-text">
                <ReachDeckRichText
                  document={option.label}
                  mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                  translate={translate}
                />
              </div>
            </QuestionOption>
          ))}
        </QuestionOptionGroup>
      </div>
    );
  }
  if (
    question.question_type === 'fill_with_candidates' ||
    (question.question_type as string) === 'cloze'
  ) {
    return (
      <FillBlanksEditor
        onBusyChange={onBusyChange}
        disabled={disabled}
        learner={learner}
        reveal={reveal}
        mediaUrlsByObjectKey={mediaUrlsByObjectKey}
        onChange={onChange}
        question={question}
        translate={translate}
        uploadAnswerAsset={uploadAnswerAsset}
        value={value}
        visibleBlankId={visibleBlankId}
      />
    );
  }
  if (question.question_type === 'fill_in_the_blank') {
    return (
      <FillBlanksEditor
        onBusyChange={onBusyChange}
        disabled={disabled}
        learner={learner}
        reveal={reveal}
        mediaUrlsByObjectKey={mediaUrlsByObjectKey}
        onChange={onChange}
        question={question}
        translate={translate}
        uploadAnswerAsset={uploadAnswerAsset}
        value={value}
        visibleBlankId={visibleBlankId}
      />
    );
  }
  const richTextValue = value as RichTextQuestionAnswer;
  return (
    <QuizAnswerEditor
      resolveAttachmentUrl={resolveAttachmentUrl}
      mediaUrlsByObjectKey={mediaUrlsByObjectKey}
      key={question.id}
      onBusyChange={onBusyChange}
      allowAttachments={question.question_type === 'short_answer'}
      disabled={disabled}
      onChange={onChange}
      questionId={question.id}
      translate={translate}
      uploadAsset={uploadAnswerAsset}
      value={richTextValue}
    />
  );
}

/** The same leaf controls as QuizScenePlayer, without scene identity, runtime or grading semantics.
 * Standalone Quiz hosts supply their own release-aware grading/feedback presentation.
 */
export function QuizReadonlyQuestion({
  question,
  answer,
  mediaUrlsByObjectKey,
  resolveAttachmentUrl,
  translate,
  visibleBlankId,
  presentation = 'complete',
  answerLabel,
}: {
  /** Source never projects blanks; answer omits the repeated source prompt and attachments. */
  presentation?: 'complete' | 'source' | 'answer';
  answerLabel?: string;
  /** Display filter only; the complete source and answer remain intact. */
  visibleBlankId?: string;
  question: Question;
  answer: QuestionAnswer;
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
  translate?: ReachDeckTranslate;
}) {
  const titleId = useId();
  return (
    <div className="quiz-scene is-learner is-readonly-question" data-presentation={presentation}>
      <article className="quiz-scene__question">
        {presentation !== 'answer' ? (
          <>
            <div className="quiz-scene__question-title" id={titleId}>
              <ReachDeckRichText
                document={question.question}
                mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                translate={translate}
              />
            </div>
            <ReachDeckAttachmentList
              attachments={question.question_attachments ?? []}
              resolveAttachmentUrl={resolveAttachmentUrl}
              mediaUrlsByObjectKey={mediaUrlsByObjectKey}
              translate={translate}
            />
          </>
        ) : null}
        <fieldset
          className="quiz-scene__answer-editor"
          aria-label={presentation === 'answer' ? answerLabel : undefined}
        >
          <AnswerEditor
            disabled
            learner
            labelledBy={presentation === 'answer' ? undefined : titleId}
            visibleBlankId={presentation === 'source' ? undefined : visibleBlankId}
            question={question}
            value={
              presentation === 'source'
                ? emptyQuestionAnswer(question.question_type, question.blanks)
                : answer
            }
            reveal={false}
            onChange={() => {}}
            mediaUrlsByObjectKey={mediaUrlsByObjectKey}
            resolveAttachmentUrl={resolveAttachmentUrl}
            translate={translate}
          />
        </fieldset>
      </article>
    </div>
  );
}

function FillBlanksEditor({
  onBusyChange,
  disabled,
  learner,
  mediaUrlsByObjectKey,
  onChange,
  question,
  reveal,
  translate,
  uploadAnswerAsset,
  value,
  visibleBlankId,
}: {
  visibleBlankId?: string;
  disabled: boolean;
  learner: boolean;
  onBusyChange?: (busy: boolean) => void;
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  onChange: (value: QuestionAnswer) => void;
  question: Question;
  /** 学生端排布揭晓后，候选空逐项标注正确 / 错误 / 正确答案（与选择题选项同一语义）。 */
  reveal: boolean;
  translate?: ReachDeckTranslate;
  uploadAnswerAsset?: QuizAnswerAssetUploader;
  value: QuestionAnswer;
}) {
  const labelIdPrefix = useId();
  const blanks = question.blanks ?? [];
  const answer =
    value.kind === 'fill_blanks'
      ? value
      : (emptyQuestionAnswer(question.question_type, question.blanks) as FillBlanksQuestionAnswer);
  const answerById = new Map(answer.blanks.map((blank) => [blank.blankId, blank.answer]));
  const updateBlank = (
    blankId: string,
    next: FillBlanksQuestionAnswer['blanks'][number]['answer'],
  ) =>
    onChange({
      kind: 'fill_blanks',
      version: 1,
      blanks: (question.blanks ?? []).map((blank) => ({
        blankId: blank.id,
        answer:
          blank.id === blankId
            ? next
            : (answerById.get(blank.id) ?? emptyFillBlank(question.question_type)),
      })),
    });
  return (
    <div className="quiz-scene__blanks">
      {blanks.map((blank, index) => {
        if (visibleBlankId !== undefined && blank.id !== visibleBlankId) return null;
        const current = answerById.get(blank.id) ?? emptyFillBlank(question.question_type);
        const labelId = `${labelIdPrefix}-${blank.id}`;
        const candidateMode =
          question.question_type === 'fill_with_candidates' ||
          (question.question_type as string) === 'cloze';
        // 共享候选池不可重复时，被其他空占用的候选标出占用它的空号（学生端排布）。
        const usedByBlank = (value: string): number | undefined => {
          if (
            !learner ||
            question.question_type !== 'fill_with_candidates' ||
            question.candidate_pool_repeatable !== false
          ) {
            return undefined;
          }
          const owner = blanks.findIndex((other) => {
            const otherAnswer = answerById.get(other.id);
            return (
              other.id !== blank.id &&
              otherAnswer?.kind === 'selection' &&
              otherAnswer.values.includes(value)
            );
          });
          return owner < 0 ? undefined : owner + 1;
        };
        return (
          <section
            className="quiz-scene__blank-answer"
            data-blank-id={blank.id}
            data-blank-kind={candidateMode ? 'candidates' : 'text'}
            key={blank.id}
          >
            <strong id={labelId}>
              {translateReachDeck(translate, 'reachDeck.player.quiz.blank', '第 {number} 空', {
                number: index + 1,
              })}
            </strong>
            {candidateMode ? (
              <>
                <div
                  aria-labelledby={labelId}
                  className="quiz-scene__options is-candidates"
                  role="radiogroup"
                >
                  {(question.question_type === 'fill_with_candidates'
                    ? (question.options ?? [])
                    : (blank.candidates ?? [])
                  ).map((candidate) => {
                    const usedBy = usedByBlank(candidate.value);
                    const result =
                      learner && reveal && Array.isArray(blank.answer)
                        ? candidateResult(
                            blank.answer,
                            current.kind === 'selection' ? current.values : [],
                            candidate.value,
                          )
                        : undefined;
                    return (
                      <label data-result={result} key={candidate.value}>
                        <input
                          checked={
                            current.kind === 'selection' && current.values.includes(candidate.value)
                          }
                          disabled={
                            disabled ||
                            (question.question_type === 'fill_with_candidates' &&
                              question.candidate_pool_repeatable === false &&
                              (question.blanks ?? []).some((other) => {
                                const answer = answerById.get(other.id);
                                return (
                                  other.id !== blank.id &&
                                  answer?.kind === 'selection' &&
                                  answer.values.includes(candidate.value)
                                );
                              }))
                          }
                          name={`question-${question.id}-blank-${blank.id}`}
                          onChange={(event) =>
                            updateBlank(blank.id, {
                              kind: 'selection',
                              values: event.target.checked ? [candidate.value] : [],
                            })
                          }
                          type="radio"
                        />
                        <span aria-hidden="true" className="quiz-scene__option-badge">
                          {candidate.value}
                        </span>
                        <div className="quiz-scene__rich-text">
                          <ReachDeckRichText
                            document={candidate.label}
                            mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                            translate={translate}
                          />
                        </div>
                        {usedBy === undefined ? null : (
                          <span className="quiz-scene__candidate-used">
                            {translateReachDeck(
                              translate,
                              'reachDeck.player.quiz.candidateUsed',
                              '已用于第 {number} 空',
                              { number: usedBy },
                            )}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
                {learner &&
                !disabled &&
                current.kind === 'selection' &&
                current.values.length > 0 ? (
                  <button
                    className="quiz-scene__blank-clear"
                    onClick={() => updateBlank(blank.id, { kind: 'selection', values: [] })}
                    type="button"
                  >
                    {translateReachDeck(
                      translate,
                      'reachDeck.player.quiz.clearBlank',
                      '清空第 {number} 空',
                      { number: index + 1 },
                    )}
                  </button>
                ) : null}
              </>
            ) : (
              <QuizAnswerEditor
                key={question.id + blank.id}
                onBusyChange={onBusyChange}
                allowAttachments={false}
                disabled={disabled}
                onChange={(next) =>
                  updateBlank(blank.id, { kind: 'rich_text', document: next.document })
                }
                questionId={question.id}
                translate={translate}
                uploadAsset={uploadAnswerAsset}
                value={{
                  kind: 'rich_text',
                  document: current.kind === 'rich_text' ? current.document : emptyQuizRichText(),
                  attachments: [],
                }}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

/** 候选空揭晓后的逐项结果；与本空无关的候选不标注。 */
function candidateResult(
  expected: readonly string[],
  selected: readonly string[],
  value: string,
): QuestionOptionResult | undefined {
  if (selected.includes(value)) return expected.includes(value) ? 'correct' : 'incorrect';
  return expected.includes(value) ? 'missed' : undefined;
}

function emptyFillBlank(
  questionType: Question['question_type'],
): FillBlanksQuestionAnswer['blanks'][number]['answer'] {
  return questionType === 'fill_with_candidates' || (questionType as string) === 'cloze'
    ? { kind: 'selection', values: [] }
    : { kind: 'rich_text', document: emptyQuizRichText() };
}

function formatGradingScore(value: number): string {
  return String(Math.round(value * 100) / 100);
}

type GradingDisplay =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'unsynced' }
  | { kind: 'failed'; view?: QuizGradingView }
  | { kind: 'trial_ai' }
  | {
      kind: 'graded';
      result: 'correct' | 'partial' | 'incorrect';
      score: number;
      maxScore: number;
      view?: QuizGradingView;
    };

function gradedDisplay(
  correct: boolean,
  score: number,
  maxScore: number,
  view?: QuizGradingView,
): Extract<GradingDisplay, { kind: 'graded' }> {
  return {
    kind: 'graded',
    result: correct ? 'correct' : score > 0 ? 'partial' : 'incorrect',
    score,
    maxScore,
    ...(view === undefined ? {} : { view }),
  };
}

function GradingFeedback({
  label,
  renderGradingFeedback,
  view,
}: {
  label: string;
  renderGradingFeedback?: (markdown: string) => ReactNode;
  view: QuizGradingView;
}) {
  const parts = [view.rationale, view.feedbackMarkdown].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  if (parts.length === 0) return null;
  return (
    <section aria-label={label} className="quiz-scene__grading-feedback">
      <strong>{label}</strong>
      {parts.map((part, index) => (
        <div className="quiz-scene__grading-feedback-body" key={index}>
          {renderGradingFeedback ? (
            renderGradingFeedback(part)
          ) : (
            <p className="quiz-scene__grading-feedback-text">{part}</p>
          )}
        </div>
      ))}
    </section>
  );
}

/** 候选空的参考答案：标记 + 候选正文（学生端排布）。 */
function CandidateValues({
  mediaUrlsByObjectKey,
  options,
  translate,
  values,
}: {
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  options: readonly { label: Question['question']; value: string }[];
  translate?: ReachDeckTranslate;
  values: readonly string[];
}) {
  return (
    <span className="quiz-scene__candidate-values">
      {values.map((value) => {
        const option = options.find((candidate) => candidate.value === value);
        return (
          <span className="quiz-scene__candidate-value" key={value}>
            <span className="quiz-scene__option-badge">{value}</span>
            {option ? (
              <ReachDeckRichText
                document={option.label}
                mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                translate={translate}
              />
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

function Reveal({ label, content }: { label: string; content: ReactNode }) {
  return (
    <section className="quiz-scene__reveal-section">
      <strong>{label}</strong>
      <div>{content}</div>
    </section>
  );
}

export function QuizScenePlayer({
  readOnly = false,
  initialQuestionId,
  onQuestionChange,
  resolveAttachmentUrl,
  isAttachmentUnavailable,
  scene,
  sourceRevision = 1,
  mediaUrlsByObjectKey,
  initialRuntimeState,
  onRuntimeStateChange,
  onSubmit,
  teacherRevealAnswers = false,
  masteredLearningFenceQuestionIds,
  gradingMode = 'server',
  layout = 'default',
  gradingByQuestionId,
  unsyncedSubmissionQuestionIds,
  onRetryGrading,
  renderGradingFeedback,
  translate,
  uploadAnswerAsset,
}: Props) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const restored =
    initialRuntimeState?.sceneId === scene.id &&
    initialRuntimeState.sourceRevision === sourceRevision
      ? initialRuntimeState
      : undefined;
  const learner = layout === 'learner';
  const titleIdPrefix = useId();
  const learnerBodyRef = useRef<HTMLDivElement>(null);
  const mediaBusyCount = useRef(0);
  const [mediaBusy, setMediaBusy] = useState(false);
  const reportMediaBusy = (busy: boolean) => {
    mediaBusyCount.current = Math.max(0, mediaBusyCount.current + (busy ? 1 : -1));
    setMediaBusy(mediaBusyCount.current > 0);
  };
  const requestedIndex = scene.content.questions.findIndex((item) => item.id === initialQuestionId);
  const [activeIndex, setActiveIndex] = useState(
    requestedIndex >= 0 ? requestedIndex : (restored?.activeIndex ?? 0),
  );
  const restoredAnswers = normalizeRestoredAnswers(restored?.answers, scene.content.questions);
  const restoredSubmitted = normalizeRestoredSubmitted(
    restored?.submitted,
    scene.content.questions,
    restoredAnswers,
  );
  const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>(() => restoredAnswers);
  const [submitted, setSubmitted] = useState<Record<string, true>>(() => restoredSubmitted);
  // Questions submitted in this mount whose server result has not arrived yet. Restored
  // submissions without an entry are unscored (or predate server grading) and count as settled.
  const [awaitingServerIds, setAwaitingServerIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sceneCompleted, setSceneCompleted] = useState(
    restored?.sceneCompleted === true &&
      scene.content.questions.every((question) => restoredSubmitted[question.id] === true),
  );
  const runtimeChangeRef = useRef(onRuntimeStateChange);
  runtimeChangeRef.current = onRuntimeStateChange;
  const lastContentRef = useRef(scene.content);

  useEffect(() => {
    if (lastContentRef.current === scene.content) return;
    lastContentRef.current = scene.content;
    setActiveIndex(0);
    setAnswers({});
    setSubmitted({});
    setAwaitingServerIds(new Set());
    setSceneCompleted(false);
  }, [scene.content]);

  useEffect(() => {
    if (readOnly) return;
    runtimeChangeRef.current?.({
      kind: 'quiz',
      sceneId: scene.id,
      sourceRevision,
      activeIndex,
      answers,
      submitted,
      sceneCompleted,
    });
  }, [activeIndex, answers, readOnly, scene.id, sceneCompleted, sourceRevision, submitted]);

  const renderedIndex = Math.min(activeIndex, scene.content.questions.length - 1);
  // 学生端排布切题时作答区回到顶部（作答区是自己的滚动容器）。
  useEffect(() => {
    if (learnerBodyRef.current !== null) learnerBodyRef.current.scrollTop = 0;
  }, [renderedIndex]);
  const hasMultipleQuestions = scene.content.questions.length > 1;
  const question = scene.content.questions[renderedIndex];
  const questionKey = question.id;
  const questionChangeRef = useRef(onQuestionChange);
  questionChangeRef.current = onQuestionChange;
  useEffect(() => {
    questionChangeRef.current?.(questionKey);
  }, [questionKey]);
  const answer =
    answers[questionKey] ?? emptyQuestionAnswer(question.question_type, question.blanks);
  const isSubmitted = submitted[questionKey] === true;
  const questionTitleId = `${titleIdPrefix}-${questionKey}-title`;
  const serverMode = readOnly || gradingMode !== 'trial';
  const isUnsynced = (candidate: Question) =>
    serverMode &&
    submitted[candidate.id] === true &&
    gradingByQuestionId?.[candidate.id] === undefined &&
    unsyncedSubmissionQuestionIds?.includes(candidate.id) === true;
  const gradingPending = (candidate: Question): boolean => {
    if (!serverMode || submitted[candidate.id] !== true) return false;
    if (isUnsynced(candidate)) return true;
    const entry = gradingByQuestionId?.[candidate.id];
    if (entry !== undefined) return entry.status === 'grading';
    // Without any server projection a scored answer can never be confirmed as settled.
    if (gradingByQuestionId === undefined) return isScoredQuestion(candidate);
    return awaitingServerIds.has(candidate.id) && isScoredQuestion(candidate);
  };
  const gradingSettled = (candidate: Question) =>
    submitted[candidate.id] === true &&
    (readOnly
      ? !isScoredQuestion(candidate) ||
        gradingByQuestionId?.[candidate.id]?.status === 'graded' ||
        gradingByQuestionId?.[candidate.id]?.status === 'failed'
      : !gradingPending(candidate));
  const allSettled = scene.content.questions.every(gradingSettled);
  const answerOf = (candidate: Question): QuestionAnswer =>
    answers[candidate.id] ?? emptyQuestionAnswer(candidate.question_type, candidate.blanks);
  /** 一道题当前的批阅展示；当前题与题号导航共用同一套判定。 */
  const gradingOf = (candidate: Question): GradingDisplay => {
    if (submitted[candidate.id] !== true) return { kind: 'none' };
    if (serverMode) {
      if (readOnly && gradingByQuestionId?.[candidate.id] === undefined) return { kind: 'none' };
      if (isUnsynced(candidate)) return { kind: 'unsynced' };
      if (gradingPending(candidate)) return { kind: 'pending' };
      const entry = gradingByQuestionId?.[candidate.id];
      if (entry?.status === 'failed') return { kind: 'failed', view: entry };
      if (entry?.status === 'graded' && typeof entry.score === 'number') {
        return gradedDisplay(entry.result === 'correct', entry.score, entry.maxScore, entry);
      }
      return { kind: 'none' };
    }
    // Trial hosts have no server: grade objective questions locally only for display.
    const trialGrade = gradeObjectiveQuestion(candidate, answerOf(candidate));
    if (
      trialGrade.mode === 'GRADED' &&
      trialGrade.score !== undefined &&
      trialGrade.maxScore !== undefined
    ) {
      return gradedDisplay(trialGrade.result === 'correct', trialGrade.score, trialGrade.maxScore);
    }
    return trialGrade.mode === 'AI_REQUIRED' ? { kind: 'trial_ai' } : { kind: 'none' };
  };
  /** 学习护栏未掌握：答案、解析与 AI 反馈挡到掌握之后；对错与得分照常公布（#804）。 */
  const fenceBlocksRevealOf = (candidate: Question, candidateGrading: GradingDisplay): boolean => {
    const gradedCorrect =
      candidateGrading.kind === 'graded' && candidateGrading.result === 'correct';
    return (
      masteredLearningFenceQuestionIds !== undefined &&
      candidate.learning_fence?.enabled === true &&
      !gradedCorrect &&
      !masteredLearningFenceQuestionIds.includes(candidate.id)
    );
  };
  /** 结论（对错与得分）是否公布：按题目的公布策略，不受护栏影响。 */
  const canShowOutcomeOf = (candidate: Question, candidateGrading: GradingDisplay): boolean =>
    (!readOnly || gradingSettled(candidate)) &&
    ((scene.content.answer_reveal === 'after_submit' && gradingSettled(candidate)) ||
      (scene.content.answer_reveal === 'after_scene' && allSettled) ||
      (scene.content.answer_reveal === 'teacher_controlled' && teacherRevealAnswers) ||
      candidateGrading.kind === 'trial_ai');
  const canRevealOf = (candidate: Question, candidateGrading: GradingDisplay): boolean => {
    return (
      (!readOnly || gradingSettled(candidate)) &&
      !fenceBlocksRevealOf(candidate, candidateGrading) &&
      ((scene.content.answer_reveal === 'after_submit' && gradingSettled(candidate)) ||
        (scene.content.answer_reveal === 'after_scene' && allSettled) ||
        (scene.content.answer_reveal === 'teacher_controlled' && teacherRevealAnswers) ||
        // Trial mode cannot AI-grade, so the reference answer is shown right after submission.
        candidateGrading.kind === 'trial_ai')
    );
  };
  const grading = gradingOf(question);
  const canReveal = canRevealOf(question, grading);
  const canShowOutcome = canShowOutcomeOf(question, grading);
  const resultLabel =
    grading.kind !== 'graded'
      ? ''
      : grading.result === 'correct'
        ? text('reachDeck.player.quiz.result.correct', '回答正确')
        : grading.result === 'partial'
          ? text('reachDeck.player.quiz.result.partial', '部分正确')
          : text('reachDeck.player.quiz.result.incorrect', '回答错误');

  const questionCount = scene.content.questions.length;
  const submitDisabled =
    readOnly ||
    !isCompleteQuestionAnswer(
      answer,
      question.blanks?.map((blank) => blank.id),
    ) ||
    isSubmitted ||
    mediaBusy;
  const previousDisabled = (!readOnly && !scene.content.allow_previous) || renderedIndex === 0;
  const nextDisabled =
    renderedIndex >= questionCount - 1 || (!readOnly && !scene.content.allow_skip && !isSubmitted);
  const submitCurrent = () => {
    if (readOnly || mediaBusyCount.current > 0) return;
    const nextSubmitted = { ...submitted, [questionKey]: true as const };
    const nextSceneCompleted = scene.content.questions.every(
      (candidate) => nextSubmitted[candidate.id] === true,
    );
    setSubmitted(nextSubmitted);
    setAwaitingServerIds((current) => new Set(current).add(questionKey));
    setSceneCompleted(nextSceneCompleted);
    // The host must observe this snapshot before it builds the submission command.
    const nextRuntime: QuizSceneRuntimeState = {
      kind: 'quiz',
      sceneId: scene.id,
      sourceRevision,
      activeIndex,
      answers,
      submitted: nextSubmitted,
      sceneCompleted: nextSceneCompleted,
    };
    runtimeChangeRef.current?.(nextRuntime);
    onSubmit?.(questionKey, answer, nextRuntime);
  };

  const questionTitle = (
    <div aria-level={3} className="quiz-scene__question-title" id={questionTitleId} role="heading">
      <ReachDeckRichText
        defaultFontSize={learner ? undefined : 19}
        document={question.question}
        mediaUrlsByObjectKey={mediaUrlsByObjectKey}
        translate={translate}
      />
    </div>
  );
  const answerArea = (
    <>
      <ReachDeckAttachmentList
        attachments={question.question_attachments ?? []}
        resolveAttachmentUrl={resolveAttachmentUrl}
        isAttachmentUnavailable={isAttachmentUnavailable}
        mediaUrlsByObjectKey={mediaUrlsByObjectKey}
        translate={translate}
      />
      <fieldset className="quiz-scene__answer-editor">
        <AnswerEditor
          resolveAttachmentUrl={resolveAttachmentUrl}
          key={questionKey}
          labelledBy={questionTitleId}
          learner={learner}
          onBusyChange={reportMediaBusy}
          disabled={readOnly || isSubmitted}
          mediaUrlsByObjectKey={mediaUrlsByObjectKey}
          onChange={(nextAnswer) => {
            if (readOnly) return;
            setAnswers((current) => ({ ...current, [questionKey]: nextAnswer }));
          }}
          question={question}
          reveal={canReveal}
          translate={translate}
          uploadAnswerAsset={readOnly ? undefined : uploadAnswerAsset}
          value={answer}
        />
      </fieldset>
    </>
  );
  const gradingResult = (
    <>
      {grading.kind === 'pending' ? (
        <p aria-live="polite" className="quiz-scene__grading is-pending" role="status">
          {text('reachDeck.player.quiz.grading.pending', '批改中…')}
        </p>
      ) : null}
      {grading.kind === 'unsynced' ? (
        <p className="quiz-scene__grading is-failed is-unsynced" role="alert">
          {text(
            'reachDeck.player.quiz.grading.unsynced',
            '答案尚未保存，保存成功后才会开始批改，请重试保存。',
          )}
        </p>
      ) : null}
      {grading.kind === 'failed' ? (
        <div className="quiz-scene__grading is-failed" role="alert">
          <p>{text('reachDeck.player.quiz.grading.failed', '批改失败，可以重新批阅。')}</p>
          {!readOnly && onRetryGrading ? (
            <button
              className="quiz-scene__grading-retry"
              disabled={grading.view?.retrying === true || grading.view?.retryExhausted === true}
              onClick={() => {
                if (!readOnly) onRetryGrading(questionKey);
              }}
              type="button"
            >
              {grading.view?.retrying === true
                ? text('reachDeck.player.quiz.grading.retrying', '正在重新批阅…')
                : text('reachDeck.player.quiz.grading.retry', '重新批阅')}
            </button>
          ) : null}
          {grading.view?.retryExhausted === true ? (
            <p aria-live="polite" className="quiz-scene__grading-message" role="status">
              {text('reachDeck.player.quiz.grading.retryLimitReached', '已达重新批阅上限')}
            </p>
          ) : grading.view?.retryMessage ? (
            <p aria-live="polite" className="quiz-scene__grading-message" role="status">
              {grading.view.retryMessage}
            </p>
          ) : null}
        </div>
      ) : null}
      {grading.kind === 'trial_ai' ? (
        <p className="quiz-scene__grading is-trial" role="note">
          {text('reachDeck.player.quiz.grading.trialSkipped', '试讲模式不进行 AI 批阅')}
        </p>
      ) : null}
      {learner &&
      isSubmitted &&
      (grading.kind === 'none' || (grading.kind === 'graded' && !canShowOutcome)) ? (
        // 学生端：已提交但结果尚未公布（全部作答后公布 / 教师控制）时给出明确状态。
        <p className="quiz-scene__grading is-submitted" role="status">
          {text('reachDeck.player.quiz.submittedAwaitingReveal', '答案已提交')}
        </p>
      ) : null}
      {canShowOutcome && grading.kind === 'graded' ? (
        // 整题结论条（共享 QuestionOutcome）：图标 + 文字 + 得分，部分正确为 warning 结论条。
        <QuestionOutcome
          aria-live="polite"
          className="quiz-scene__result"
          data-grading-result={grading.result}
          description={text('reachDeck.player.quiz.grading.score', '得分 {score} / {maxScore}', {
            score: formatGradingScore(grading.score),
            maxScore: formatGradingScore(grading.maxScore),
          })}
          outcome={grading.result}
        >
          {resultLabel}
        </QuestionOutcome>
      ) : null}
      {canReveal && grading.kind === 'graded' && grading.view ? (
        <GradingFeedback
          label={text('reachDeck.player.quiz.grading.feedbackTitle', 'AI 批阅意见')}
          renderGradingFeedback={renderGradingFeedback}
          view={grading.view}
        />
      ) : null}
      {canReveal && grading.kind === 'graded' && grading.view?.feedbackStatus === 'grading' ? (
        // 成绩已定、AI 反馈后到：学生不必等，可以先翻页，回到本页再看。
        <p
          aria-live="polite"
          className="quiz-scene__grading is-pending"
          data-quiz-feedback-status="grading"
          role="status"
        >
          {text(
            'reachDeck.player.quiz.grading.feedbackPending',
            'AI 反馈生成中，可以先继续学习，稍后回到本页查看。',
          )}
        </p>
      ) : null}
      {canReveal && grading.kind === 'graded' && grading.view?.feedbackStatus === 'failed' ? (
        <div
          className="quiz-scene__grading is-failed"
          data-quiz-feedback-status="failed"
          role="alert"
        >
          <p>{text('reachDeck.player.quiz.grading.feedbackFailed', 'AI 反馈生成失败。')}</p>
          {!readOnly && onRetryGrading ? (
            <button
              className="quiz-scene__grading-retry"
              disabled={grading.view.retrying === true || grading.view.retryExhausted === true}
              onClick={() => {
                if (!readOnly) onRetryGrading(questionKey);
              }}
              type="button"
            >
              {grading.view.retrying === true
                ? text('reachDeck.player.quiz.grading.feedbackRetrying', '正在重新生成…')
                : text('reachDeck.player.quiz.grading.feedbackRetry', '重新生成反馈')}
            </button>
          ) : null}
          {grading.view.retryExhausted === true ? (
            <p aria-live="polite" className="quiz-scene__grading-message" role="status">
              {text('reachDeck.player.quiz.grading.retryLimitReached', '已达重新批阅上限')}
            </p>
          ) : grading.view.retryMessage ? (
            <p aria-live="polite" className="quiz-scene__grading-message" role="status">
              {grading.view.retryMessage}
            </p>
          ) : null}
        </div>
      ) : null}
      {canReveal ? (
        <aside
          aria-label={text('reachDeck.player.quiz.answerExplanation', '答案解析')}
          className="quiz-scene__reveal"
        >
          {question.has_answer ? (
            <Reveal
              content={
                question.blanks && question.blanks.length > 0 ? (
                  <ol className="quiz-scene__blank-references">
                    {question.blanks.map((blank, index) => (
                      <li key={blank.id}>
                        {learner ? (
                          <span className="quiz-scene__blank-reference-label">
                            {text('reachDeck.player.quiz.blank', '第 {number} 空', {
                              number: index + 1,
                            })}
                          </span>
                        ) : null}
                        {Array.isArray(blank.answer) ? (
                          learner ? (
                            <CandidateValues
                              mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                              options={
                                question.question_type === 'fill_with_candidates'
                                  ? (question.options ?? [])
                                  : (blank.candidates ?? [])
                              }
                              translate={translate}
                              values={blank.answer}
                            />
                          ) : (
                            blank.answer.join('、')
                          )
                        ) : (
                          <ReachDeckRichText
                            document={blank.answer}
                            mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                            translate={translate}
                          />
                        )}
                      </li>
                    ))}
                  </ol>
                ) : Array.isArray(question.answer) ? (
                  question.answer.join('、')
                ) : (
                  <ReachDeckRichText
                    document={question.answer}
                    mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                    translate={translate}
                  />
                )
              }
              label={text('reachDeck.player.quiz.referenceAnswer', '参考答案')}
            />
          ) : null}
          <Reveal
            content={
              <ReachDeckRichText
                document={question.analysis}
                mediaUrlsByObjectKey={mediaUrlsByObjectKey}
                translate={translate}
              />
            }
            label={text('reachDeck.player.quiz.analysis', '解析')}
          />
        </aside>
      ) : null}
    </>
  );

  if (learner) {
    const statusOf = (candidate: Question): QuizQuestionNavStatus => {
      if (submitted[candidate.id] !== true) {
        return isCompleteQuestionAnswer(
          answerOf(candidate),
          candidate.blanks?.map((blank) => blank.id),
        )
          ? 'answered'
          : 'unanswered';
      }
      const candidateGrading = gradingOf(candidate);
      if (candidateGrading.kind === 'pending' || candidateGrading.kind === 'unsynced') {
        return 'pending';
      }
      if (candidateGrading.kind === 'failed') return 'failed';
      if (candidateGrading.kind === 'graded' && canShowOutcomeOf(candidate, candidateGrading)) {
        return candidateGrading.result;
      }
      return 'submitted';
    };
    // 题号可达性与「上一题 / 下一题」同一规则：向前看 allow_previous；向后跳过未提交的题要 allow_skip。
    const canVisit = (index: number) =>
      readOnly ||
      index === renderedIndex ||
      (index < renderedIndex
        ? scene.content.allow_previous
        : scene.content.allow_skip ||
          scene.content.questions
            .slice(renderedIndex, index)
            .every((candidate) => submitted[candidate.id] === true));
    const submittedCount = scene.content.questions.filter(
      (candidate) => submitted[candidate.id] === true,
    ).length;
    const firstOpenIndex = scene.content.questions.findIndex(
      (candidate) => submitted[candidate.id] !== true,
    );
    const typeLabel = text(
      `reachDeck.player.quiz.type.${question.question_type}`,
      QUESTION_TYPE_FALLBACK[question.question_type] ?? '',
    );
    const meta = [
      scene.content.show_question_index ? String(question.question_index) : null,
      [
        typeLabel,
        text('reachDeck.player.quiz.points', '{points} 分', {
          points: formatGradingScore(question.points),
        }),
      ]
        .filter((part) => part.length > 0)
        .join(' · '),
    ]
      .filter((part): part is string => part !== null && part.length > 0)
      .join('. ');
    return (
      <section aria-label={scene.title} className="quiz-scene is-learner" data-layout="learner">
        <header className="quiz-scene__header">
          <div className="quiz-scene__heading">
            <h2>{scene.title}</h2>
            {hasMultipleQuestions ? (
              <span className="quiz-scene__summary">
                {text('reachDeck.player.quiz.submittedCount', '已提交 {submitted}/{total}', {
                  submitted: submittedCount,
                  total: questionCount,
                })}
              </span>
            ) : null}
          </div>
          {hasMultipleQuestions ? (
            <nav
              aria-label={text('reachDeck.player.quiz.navigation', '题目导航')}
              className="quiz-scene__navigator"
            >
              <ol>
                {scene.content.questions.map((candidate, index) => {
                  const status = statusOf(candidate);
                  return (
                    <li key={candidate.id}>
                      <button
                        aria-current={index === renderedIndex ? 'step' : undefined}
                        aria-label={text(
                          'reachDeck.player.quiz.navigatorItem',
                          '第 {number} 题，{status}',
                          {
                            number: index + 1,
                            status: text(
                              `reachDeck.player.quiz.status.${status}`,
                              QUESTION_STATUS_FALLBACK[status],
                            ),
                          },
                        )}
                        className="quiz-scene__navigator-item"
                        data-status={status}
                        disabled={!canVisit(index)}
                        onClick={() => setActiveIndex(index)}
                        type="button"
                      >
                        <span aria-hidden="true">{index + 1}</span>
                        {status === 'correct' ? (
                          <Check aria-hidden="true" className="quiz-scene__navigator-mark" />
                        ) : status === 'incorrect' || status === 'failed' ? (
                          <X aria-hidden="true" className="quiz-scene__navigator-mark" />
                        ) : status === 'partial' ? (
                          <Minus aria-hidden="true" className="quiz-scene__navigator-mark" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>
          ) : null}
        </header>
        <div className="quiz-scene__body" ref={learnerBodyRef}>
          <article className="quiz-scene__question" data-question-index={question.question_index}>
            <p className="quiz-scene__meta">{meta}</p>
            {questionTitle}
            {answerArea}
            {gradingResult}
          </article>
        </div>
        <footer className="quiz-scene__footer">
          {hasMultipleQuestions ? (
            <Button
              disabled={previousDisabled}
              onClick={() => setActiveIndex(renderedIndex - 1)}
              size="md"
              iconStart={<ChevronLeft size={16} />}
              variant="ghost"
            >
              {text('reachDeck.player.quiz.previous', '上一题')}
            </Button>
          ) : (
            <span />
          )}
          <div className="quiz-scene__footer-actions">
            {readOnly ? (
              hasMultipleQuestions ? (
                <Button
                  disabled={nextDisabled}
                  iconEnd={<ChevronRight size={16} />}
                  onClick={() => setActiveIndex(renderedIndex + 1)}
                  size="md"
                >
                  {text('reachDeck.player.quiz.next', '下一题')}
                </Button>
              ) : null
            ) : !isSubmitted ? (
              <>
                {hasMultipleQuestions &&
                scene.content.allow_skip &&
                renderedIndex < questionCount - 1 ? (
                  <Button
                    onClick={() => setActiveIndex(renderedIndex + 1)}
                    size="md"
                    variant="secondary"
                  >
                    {text('reachDeck.player.quiz.skip', '跳过')}
                  </Button>
                ) : null}
                <Button
                  className="quiz-scene__footer-submit"
                  disabled={submitDisabled}
                  onClick={submitCurrent}
                  size="md"
                >
                  {text('reachDeck.player.quiz.submit', '提交答案')}
                </Button>
              </>
            ) : renderedIndex < questionCount - 1 ? (
              <Button
                disabled={nextDisabled}
                iconEnd={<ChevronRight size={16} />}
                onClick={() => setActiveIndex(renderedIndex + 1)}
                size="md"
              >
                {text('reachDeck.player.quiz.next', '下一题')}
              </Button>
            ) : firstOpenIndex >= 0 && canVisit(firstOpenIndex) ? (
              <Button onClick={() => setActiveIndex(firstOpenIndex)} size="md">
                {text('reachDeck.player.quiz.goToOpen', '去作答第 {number} 题', {
                  number: firstOpenIndex + 1,
                })}
              </Button>
            ) : firstOpenIndex < 0 ? (
              <p className="quiz-scene__done" role="status">
                <CheckCircle2 aria-hidden="true" size={16} />
                {text(
                  hasMultipleQuestions
                    ? 'reachDeck.player.quiz.allSubmitted'
                    : 'reachDeck.player.quiz.submittedDone',
                  hasMultipleQuestions ? '本页题目已全部提交' : '本题已提交',
                )}
              </p>
            ) : null}
          </div>
        </footer>
      </section>
    );
  }

  return (
    <section
      aria-label={scene.title}
      className={`quiz-scene${hasMultipleQuestions ? '' : ' is-single-question'}`}
    >
      <header className="quiz-scene__header">
        <span>{text('reachDeck.player.quiz.label', '测验')}</span>
        <h2>{scene.title}</h2>
        {scene.content.show_progress && hasMultipleQuestions ? (
          <progress max={questionCount} value={renderedIndex + 1} />
        ) : null}
      </header>
      <article className="quiz-scene__question" data-question-index={question.question_index}>
        {scene.content.show_question_index ? (
          <p className="quiz-scene__index">
            {hasMultipleQuestions
              ? text(
                  'reachDeck.player.quiz.questionProgress',
                  '第 {question} 题 · {current}/{total}',
                  {
                    question: question.question_index,
                    current: renderedIndex + 1,
                    total: questionCount,
                  },
                )
              : text('reachDeck.player.quiz.questionNumber', '第 {question} 题', {
                  question: question.question_index,
                })}
          </p>
        ) : null}
        {questionTitle}
        {answerArea}
        {!readOnly ? (
          <button
            className="quiz-scene__submit"
            disabled={submitDisabled}
            onClick={submitCurrent}
            type="button"
          >
            {isSubmitted
              ? text('reachDeck.player.quiz.submitted', '已提交')
              : text('reachDeck.player.quiz.submit', '提交答案')}
          </button>
        ) : null}
        {gradingResult}
      </article>
      {hasMultipleQuestions ? (
        <nav
          aria-label={text('reachDeck.player.quiz.navigation', '题目导航')}
          className="quiz-scene__navigation"
        >
          <button
            disabled={previousDisabled}
            onClick={() => setActiveIndex((index) => index - 1)}
            type="button"
          >
            {text('reachDeck.player.quiz.previous', '上一题')}
          </button>
          <button
            disabled={nextDisabled}
            onClick={() => setActiveIndex((index) => index + 1)}
            type="button"
          >
            {text('reachDeck.player.quiz.next', '下一题')}
          </button>
        </nav>
      ) : null}
    </section>
  );
}

type QuizQuestionNavStatus =
  | 'unanswered'
  | 'answered'
  | 'pending'
  | 'failed'
  | 'submitted'
  | 'correct'
  | 'partial'
  | 'incorrect';

const QUESTION_STATUS_FALLBACK: Record<QuizQuestionNavStatus, string> = {
  unanswered: '未作答',
  answered: '已作答，未提交',
  pending: '批改中',
  failed: '批改失败',
  submitted: '已提交',
  correct: '回答正确',
  partial: '部分正确',
  incorrect: '回答错误',
};

const QUESTION_TYPE_FALLBACK: Partial<Record<string, string>> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  fill_in_the_blank: '填空题',
  fill_with_candidates: '选词填空',
  cloze: '完形填空',
  short_answer: '简答题',
};

function normalizeRestoredAnswers(
  answers: Record<string, QuestionAnswer> | undefined,
  questions: Question[],
): Record<string, QuestionAnswer> {
  if (!answers) return {};
  return Object.fromEntries(
    questions.flatMap((question) => {
      const value = answers[question.id] ?? answers[String(question.question_index)] ?? undefined;
      if (value === undefined) return [];
      try {
        return [[question.id, parseQuestionAnswerValue(value, question.question_type)]];
      } catch {
        return [];
      }
    }),
  );
}

function normalizeRestoredSubmitted(
  submitted: Record<string, true> | undefined,
  questions: Question[],
  answers: Record<string, QuestionAnswer>,
): Record<string, true> {
  if (!submitted) return {};
  return Object.fromEntries(
    questions.flatMap((question) =>
      (submitted[question.id] || submitted[String(question.question_index)]) &&
      (((question.question_type as string) !== 'cloze' &&
        question.question_type !== 'fill_in_the_blank' &&
        question.question_type !== 'fill_with_candidates') ||
        answers[question.id]?.kind === 'fill_blanks')
        ? [[question.id, true as const]]
        : [],
    ),
  );
}
