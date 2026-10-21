import { REACH_DECK_FORMULA_READING_MAX_CHARACTERS } from '@reachany/reach-deck-dsl';

/** Leaf prompt module: the corpus manifest imports it without the model client. */
export const NARRATION_SPEECH_READINGS_PROMPT_VERSION = 'narration-speech-readings/v2';

export const NARRATION_SPEECH_READINGS_PROMPT = `You prepare teacher narration for a text-to-speech engine that cannot read LaTeX. For every formula in formulas, write exactly what the teacher says aloud for that formula at that point of the narration.
- Say only what the formula states. Do not explain it, repeat the surrounding sentence, or add connecting words that are not part of the formula.
- Use the narration's language and natural classroom reading. In Chinese: read a ratio of segments as "AB比A撇B撇" when the narration talks about ratios or proportions, and a numeric fraction as "四分之三"; x^{2} is "x的平方", \\sqrt{2} is "根号二", \\angle A is "角A", \\triangle ABC \\sim \\triangle A'B'C' is "三角形ABC相似于三角形A撇B撇C撇", a prime is "撇", = is "等于", \\approx is "约等于", \\ge is "大于等于", \\pm is "正负".
- Keep letter names as written (A, B, x, k). Write numbers as words in the narration language.
- Ignore presentation-only commands such as \\displaystyle, \\text, \\mathrm, sizing and spacing.
- Output plain spoken words only: no LaTeX, backslashes, dollar signs, ^, _, braces, angle brackets, ampersands or line breaks, and at most ${REACH_DECK_FORMULA_READING_MAX_CHARACTERS} characters per reading.
Return every formulaId exactly once.
When findPlainExpressions is true, also read narrationMarkdown outside the listed formulas and find every mathematical expression written as plain text without formula delimiters, for example f(−x)=f(x), x∈D, −2≤2t≤2, C(α±β), a₁+a₂ or 2t>1−t. Return them in plainExpressions in order of appearance, once per occurrence:
- source is the expression copied character for character from narrationMarkdown: the same symbols, letters, digits, spaces and order, never retyped, normalized, shortened or completed. Cover only the expression itself, without surrounding words or sentence punctuation.
- reading follows the reading rules above.
- Skip ordinary words, a lone letter or number, and plain arithmetic that a speech engine already reads naturally. Never return text inside the listed formulas.
Return an empty plainExpressions list when there is none.`;
