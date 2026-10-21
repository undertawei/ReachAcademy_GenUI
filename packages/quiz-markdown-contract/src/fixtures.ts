export interface QuizMarkdownContractFixture {
  readonly name: string;
  readonly markdown: string;
  readonly inlineMath: readonly string[];
  readonly blockMath: readonly string[];
  readonly plainDollarText: readonly string[];
}

/** Shared golden inputs for Feedforward prompts and the Portal TipTap tokenizer. */
export const QUIZ_MARKDOWN_CONTRACT_FIXTURES: readonly QuizMarkdownContractFixture[] = [
  {
    name: 'math-and-money',
    markdown: [
      '普通金额 $100、US$20 与 `$x$` 都是文本。',
      '',
      '行内公式写作 \\(x^2 + 1\\)。',
      '',
      '\\[',
      'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}',
      '\\]',
    ].join('\n'),
    inlineMath: ['x^2 + 1'],
    blockMath: ['x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}'],
    plainDollarText: ['$100', 'US$20', '$x$'],
  },
  {
    name: 'delimiters-inside-code',
    markdown: ['`\\(not math\\)`', '', '```text', '\\[', 'not math', '\\]', '```'].join('\n'),
    inlineMath: [],
    blockMath: [],
    plainDollarText: [],
  },
  {
    name: 'legacy-feedback-topsis-and-second-hand-price',
    markdown: [
      'TOPSIS 需要补上规范化与贴近度：',
      '',
      String.raw`\\[v_{ij}=w_j\cdot\frac{x_{ij}}{\sqrt{\sum_i x_{ij}^2}},\quad C_i=\frac{d_i^-}{d_i^++d_i^-}\\]`,
      '',
      '把二手纳入备选，并建模为',
      '',
      String.raw`\\[P_{\text{二手}}=P_{\text{新}}\cdot\lambda - R\\]`,
      '',
      String.raw`当 \\(P_{\text{二手}} + R\\) 明显低于新机且 \\(C_i\\) 排名靠前时，才纳入备选。`,
    ].join('\n'),
    inlineMath: [String.raw`P_{\text{二手}} + R`, 'C_i'],
    blockMath: [
      String.raw`v_{ij}=w_j\cdot\frac{x_{ij}}{\sqrt{\sum_i x_{ij}^2}},\quad C_i=\frac{d_i^-}{d_i^++d_i^-}`,
      String.raw`P_{\text{二手}}=P_{\text{新}}\cdot\lambda - R`,
    ],
    plainDollarText: [],
  },
] as const;
