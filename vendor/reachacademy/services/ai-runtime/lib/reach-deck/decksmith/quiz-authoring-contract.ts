import { SOURCE_AND_LANGUAGE_SNIPPET } from '../prompts/corpus/local-snippets.js';
import { GENERATION_SAFE_QUIZ_QUESTION_TYPES } from '../quiz-model-output.js';

/** Editor-specific contract. Archived v4/v7 contracts remain unchanged for frozen runs. */
export function decksmithQuizContractTextV8(): string {
  return [
    'DECKSMITH QUIZ AUTHORING CONTRACT v8',
    'OUTPUT AND FIELDS',
    '- insert_quiz_page creates one page with exactly one top-level question in content.questions and no sub_problems. For N questions insert N pages with distinct assessment targets. replace_quiz_scene edits an existing scene: preserve its existing supported question types, question grouping, and unrelated fields unless the teacher asks to change them.',
    `- For new questions, question_type is exactly one of ${GENERATION_SAFE_QUIZ_QUESTION_TYPES.join(', ')}. Choose selection when it provides the requested evidence, or short_answer when the learner must produce reasoning or an explanation.`,
    '- sceneJson is one QuizScene JSON object encoded as a string in the tool arguments: {"schemaVersion":"reach-quiz-scene/v1","sceneType":"quiz","id":"pending","title":"Short page title","content":{"questions":[<question>]}}. For replacement preserve the actual scene id. The server supplies stable ids and display defaults; omit display fields and never invent a display object.',
    '- Question fields: question_type, question (the student-visible stem, never prompt or stem), has_answer, answer, analysis, cognitive_schema; choice questions also have options. For new questions omit id, question_index, points, and sub_problems; the server fills these. Optional assessment fields are described below.',
    '- options are objects {"value":"A","label":"Complete student-visible content"}. Prefer 3-5 concise options with A, B, C, ... keys in displayed order. This is authoring guidance; honor a teacher-requested count. Other counts and unique non-empty keys are supported by the runtime. Every label must contain visible content. single_choice answer is one emitted key, such as "B"; multiple_choice answer is a non-empty array of unique emitted keys, such as ["A","C"]. Never use option wording as its key.',
    '- Reference answers are the default: has_answer true, with one key for single_choice, unique keys for multiple_choice, or a reference answer for short_answer. Choice questions always have a reference answer.',
    '- When the teacher requests no standard/reference answer (无标答, 没有标准答案, 开放题, open-ended), use short_answer, has_answer false, answer "", and omit scoring_points, answer_components, acceptable_variants, partial_credit_examples, and typical_wrong_answers. analysis may describe what a thoughtful response could address, without inventing one correct answer. The server clears answer and scoring fields supplied with has_answer false.',
    '',
    'ASSESSMENT DESIGN',
    '- Derive the task from the teacher request and the current deck pages and narration. Keep each new page focused on a distinct observable response. Do not repeat or paraphrase a question already inserted in this run. Use neighboring pages for continuity and avoid revealing an answer before a requested learner attempt.',
    '- Align the stem, answer, and feedback with supplied facts. Avoid trivia, absent facts, wording traps, overlapping options, all-of-the-above, or absurd distractors. Keep distractors plausible and clearly incorrect; use parallel wording and similar length so position or phrasing does not reveal the answer.',
    '- analysis explains the reasoning, common wrong reasoning, and how to repair it. cognitive_schema names the transferable concept or reasoning pattern. Keep planning ids and design rationale out of learner-visible text.',
    '- For referenced-answer questions with a rubric, declare question-local target_ids (unique descriptive strings) and an evidence_type describing the observable response. These targets belong to this question, not to a separate outline or lesson objective registry. slot_id may be omitted.',
    '- scoring_points: [{"id":"p1","target_ids":["q1-target"],"criterion":"One observable criterion","acceptable_answers":["Accepted evidence"],"points":1}]. Use positive points and separate independently assessable outputs instead of one all-or-nothing criterion. Each target_ids is a non-empty unique subset of the question target_ids.',
    '- answer_components: [{"id":"c1","target_ids":["q1-target"],"answer":"Expected component","required":true}]. Split independent outputs into independent components; each target_ids is a non-empty unique subset of the question target_ids. acceptable_variants and misconceptions, when useful, are arrays of non-empty strings.',
    '- partial_credit_examples: [{"answer":"Partly correct response","earned_point_ids":["p1"],"missed_point_ids":["p2"]}]. Only include when there are at least two scoring points. Point references must exist in this question, contain no duplicates, never overlap, and describe the intended earned/missed partition.',
    '- typical_wrong_answers: [{"answer":"Wrong response","missed_point_ids":["p1"],"feedback":"How to repair the reasoning"}]. References must be unique ids from this question scoring_points. diagnostic_feedback is optional plain text.',
    '- learning_fence is optional. Use an object {"enabled":true,"prompt":"Repair hint"}, never a string. prompt is at most 4000 characters. Optional target_ids and point_ids reference this question targets and scoring points; repair_prompt and mastery_criterion are optional non-empty strings. Omit the field if there is no repair hint.',
    '',
    'TEXT AND JSON',
    String.raw`- question, analysis, cognitive_schema, short_answer answer, and option labels are restricted Markdown strings: plain paragraphs, bold, italic, and formulas. Use \(...\) for inline math; for display math put \[ and \] on separate lines with the LaTeX between them. In raw sceneJson JSON escape each backslash as \\. Do not use $ delimiters, raw HTML, or unsupported Markdown. Existing rich-text documents read from a page may be preserved during replacement.`,
    String.raw`- Encode valid JSON and escape string newlines. Never emit C0 control characters except TAB/LF/CR, DEL, or Unicode escapes that hide control characters or split formula delimiters.`,
    String.raw`Example, open-ended: {"schemaVersion":"reach-quiz-scene/v1","sceneType":"quiz","id":"pending","title":"电功与电压","content":{"questions":[{"question_type":"short_answer","question":"保持 \\(I\\) 和 \\(t\\) 不变，只把电压调大，电功会怎样变化？说说理由。","has_answer":false,"answer":"","analysis":"可从 \\(W=UIt\\) 讨论预测。","cognitive_schema":"控制变量下的比例关系"}]}}`,
    'Example, single choice: {"schemaVersion":"reach-quiz-scene/v1","sceneType":"quiz","id":"pending","title":"电功的单位","content":{"questions":[{"question_type":"single_choice","question":"电功的国际单位是什么？","options":[{"value":"A","label":"瓦特"},{"value":"B","label":"焦耳"},{"value":"C","label":"伏特"}],"has_answer":true,"answer":"B","analysis":"电功与能量同单位，是焦耳。","cognitive_schema":"物理量与单位的对应"}]}}',
    '',
    SOURCE_AND_LANGUAGE_SNIPPET,
  ].join('\n');
}
