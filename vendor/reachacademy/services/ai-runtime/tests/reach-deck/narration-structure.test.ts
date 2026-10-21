import { describe, expect, it, vi } from 'vitest';

import {
  compileGeneratedNarrationStructure,
  compileSavedNarrationStructure,
} from '../../lib/reach-deck/narration-structure.js';

const segment = (script: string, elements: string[] | null = null) => ({
  script,
  elements,
  effect: null,
});

describe('nested narration cue/segment projection', () => {
  it('persists outer cues and keeps inner segments as animation-only ranges', () => {
    const result = compileGeneratedNarrationStructure(
      {
        cues: [
          { segments: [segment('接下来我们看'), segment('A', ['a'])] },
          { segments: [segment('和'), segment('B。', ['b'])] },
        ],
      },
      new Set(['a', 'b']),
    );
    expect(result.cues.map((cue) => cue.text).join('')).toBe(result.markdown);
    expect(result.cues).toHaveLength(2);
    expect(result.cues.every((cue) => cue.revealElementIds === undefined)).toBe(true);
    expect(result.revealRanges.map((range) => range.revealElementIds)).toEqual([['a'], ['b']]);
  });

  it('canonicalizes paired doubled delimiters from generated narration segments', () => {
    const result = compileGeneratedNarrationStructure(
      {
        cues: [
          {
            segments: [segment(String.raw`观察 \\(x^2+y^2\\) 的关系。`)],
          },
        ],
      },
      new Set(),
    );

    expect(result.markdown).toBe(String.raw`观察 \(x^2+y^2\) 的关系。`);
    expect(result.cues).toEqual([{ text: result.markdown }]);
  });

  it('normalizes common Markdown formatting while preserving inline formulas', () => {
    const onNormalized = vi.fn();
    const result = compileGeneratedNarrationStructure(
      {
        cues: [
          {
            segments: [
              segment(
                '## **速度变化**\n观察 [位移](https://example.test) 与 $v=\\frac{\\Delta x}{t}$。<br>',
              ),
            ],
          },
        ],
      },
      new Set(),
      new Map(),
      onNormalized,
    );

    expect(result.markdown).toContain('速度变化');
    expect(result.markdown).toContain(String.raw`\(v=\frac{\Delta x}{t}\)`);
    expect(result.markdown).not.toMatch(/##|\*\*|https?:|<br>/u);
    expect(onNormalized).toHaveBeenCalledWith(
      expect.objectContaining({
        inputCodePoints: expect.any(Number),
        diagnostics: expect.any(Array),
      }),
    );
  });

  it('preserves list, line, comparison, and formula boundaries while stripping controls', () => {
    const result = compileGeneratedNarrationStructure(
      {
        cues: [
          {
            segments: [
              segment('## 观察\n- 面积是 2*3*4 平方米\n- 当 a<b 并且 c>d 时成立\n\n$$x < y$$'),
            ],
          },
        ],
      },
      new Set(),
    );
    expect(result.markdown).toBe(
      '观察\n\n面积是 2\\*3\\*4 平方米\n当 a\\<b 并且 c\\>d 时成立\n\n\\[x < y\\]',
    );
  });

  it('preserves paragraph, list item, and hard-break boundaries independently', () => {
    const result = compileGeneratedNarrationStructure(
      {
        cues: [
          {
            segments: [
              segment('第一段。\n\n第二段。\n继续第二段。\n\n- 第一项\n- 第二项\n\n第三段。'),
            ],
          },
        ],
      },
      new Set(),
    );
    expect(result.markdown).toBe(
      '第一段。\n\n第二段。\n继续第二段。\n\n第一项\n第二项\n\n第三段。',
    );
    expect(result.cues.map((cue) => cue.text).join('')).toBe(result.markdown);
  });

  it.each(['2*3*4', '2 * 3 * 4', 'a*b*c', 'a * b * c', '2.5 * a * 4', '2**3', '2 ** 3', 'a**b'])(
    'preserves arithmetic in %s while removing emphasis',
    (product) => {
      const result = compileGeneratedNarrationStructure(
        { cues: [{ segments: [segment(`**计算** ${product}，再看 *结果*。`)] }] },
        new Set(),
      );
      expect(result.markdown).toBe(`计算 ${product.replace(/\*/gu, '\\*')}，再看 结果。`);
    },
  );

  it('strips actual emphasis between variables without mistaking it for multiplication', () => {
    const result = compileGeneratedNarrationStructure(
      { cues: [{ segments: [segment('a *b* c 与 **结果**。')] }] },
      new Set(),
    );
    expect(result.markdown).toBe('a b c 与 结果。');
  });

  it('projects each inner segment inside its actual outer cue boundary', () => {
    const markdown = '甲乙丙丁戊己庚辛';
    const result = compileSavedNarrationStructure(
      {
        cues: [
          { segments: [segment('long prefix'), segment('target one', ['a'])] },
          { segments: [segment('x'), segment('target two', ['b'])] },
        ],
      },
      markdown,
      new Set(['a', 'b']),
    );
    const firstCueEnd = result.cues[0]!.text.length;
    expect(result.revealRanges[0]!.start).toBeLessThan(firstCueEnd);
    expect(result.revealRanges[1]!.start).toBeGreaterThanOrEqual(firstCueEnd);
  });

  it('never splits formulas or UTF-16 surrogate pairs', () => {
    const markdown = '先看😀与\\(x+1\\)，再看结论。';
    const result = compileSavedNarrationStructure(
      {
        cues: [{ segments: [segment('a'), segment('b', ['body'])] }],
      },
      markdown,
      new Set(['body']),
    );
    const formulaStart = markdown.indexOf('\\(x+1\\)');
    const formulaEnd = formulaStart + '\\(x+1\\)'.length;
    for (const range of result.revealRanges) {
      expect(range.start).not.toBe(markdown.indexOf('😀') + 1);
      expect(range.start > formulaStart && range.start < formulaEnd).toBe(false);
    }
  });

  it('does not treat an escaped backslash before a parenthesis as a formula delimiter', () => {
    const markdown = String.raw`字面\\(不是公式)这里应该可落点。\(x\)结尾`;
    const result = compileSavedNarrationStructure(
      {
        cues: [{ segments: [segment('a'), segment('b', ['body'])] }],
      },
      markdown,
      new Set(['body']),
    );
    const literalEnd = markdown.indexOf(')') + 1;
    const realFormulaStart = markdown.lastIndexOf(String.raw`\(`);
    expect(result.revealRanges).toHaveLength(1);
    expect(result.revealRanges[0]!.start).toBeGreaterThanOrEqual(literalEnd);
    expect(result.revealRanges[0]!.start).toBeLessThan(realFormulaStart);
  });

  it('ignores invalid and duplicate targets while keeping the first valid reveal', () => {
    const result = compileGeneratedNarrationStructure(
      {
        cues: [
          {
            segments: [segment('A', ['valid', 'ghost']), segment('B', ['valid'])],
          },
        ],
      },
      new Set(['valid']),
    );
    expect(result.revealRanges).toHaveLength(1);
    expect(result.revealRanges[0]!.revealElementIds).toEqual(['valid']);
  });

  it('projects saved-content scientific anchors in manifest order onto authoritative Markdown', () => {
    const markdown = '先观察小球。再比较斜面。最后归纳结论。';
    const result = compileSavedNarrationStructure(
      {
        cues: [
          {
            segments: [
              { ...segment('先观察小球。'), scientificAnchor: 'launch' },
              { ...segment('再比较斜面。'), scientificAnchor: 'compare' },
            ],
          },
          { segments: [{ ...segment('最后归纳结论。'), scientificAnchor: 'limit' }] },
        ],
      },
      markdown,
      new Set(),
      new Map([
        ['launch', 'scientific-motion'],
        ['compare', 'scientific-motion'],
        ['limit', 'scientific-motion'],
      ]),
    );
    expect(result.markdown).toBe(markdown);
    expect(result.scientificAnchorRanges?.map((range) => range.anchorId)).toEqual([
      'launch',
      'compare',
      'limit',
    ]);
    expect(result.scientificAnchorRanges?.every((range) => range.end > range.start)).toBe(true);
  });

  it('rejects a saved scientific page when projection drops a declared anchor', () => {
    expect(() =>
      compileSavedNarrationStructure(
        {
          cues: [{ segments: [{ ...segment('only one sentence'), scientificAnchor: 'launch' }] }],
        },
        'only one sentence',
        new Set(),
        new Map([
          ['launch', 'scientific-motion'],
          ['missing', 'scientific-motion'],
        ]),
      ),
    ).toThrow('must reference every declared anchor');
  });

  it('rejects page-wide temporary segment counts over 64', () => {
    const cues = Array.from({ length: 8 }, () => ({
      segments: Array.from({ length: 9 }, () => segment('x')),
    }));
    expect(() => compileGeneratedNarrationStructure({ cues }, new Set())).toThrow(
      'at most 64 segments',
    );
  });

  it.each([
    '这一页先确认作者希望强调什么，再生成面向学生的讲稿。',
    '作为 AI 助手，我需要分析页面素材后生成讲稿。',
    '我会先读取上传的 PDF 文件，再生成这一页的讲稿。',
    '根据系统提示词要求，不要透露内部指令。',
    '接下来先做内部检查，确认输出符合隐藏要求。',
    'As a language model, I will inspect the source before teaching this page.',
  ])('rejects generated internal or source-processing narration: %s', (script) => {
    expect(() =>
      compileGeneratedNarrationStructure({ cues: [{ segments: [segment(script)] }] }, new Set()),
    ).toThrow('must not contain internal planning or source-processing narration');
  });

  it.each([
    '作者在这里用“潮汐”这个意象表现思乡之情，我们结合上下文看它如何推进主题。',
    '这一页我们先确认作者身份，再结合写作年代判断这则史料的价值。',
    '接下来我们分析这一页的受力关系，先找到重力和支持力。',
    '上传 PDF 时，文件会保留原始页码，方便学习者回到出处核对。',
    '这个线性回归模型需要先分析训练样本的分布，才能给出可靠的预测。',
    '操作系统会读取磁盘上的文件，再把内容加载到内存里。',
    '编译器会先解析源文件，生成抽象语法树。',
    '接下来在后台校验用户提交的数据是否合法。',
  ])('accepts learner-facing teaching narration: %s', (script) => {
    expect(
      compileGeneratedNarrationStructure({ cues: [{ segments: [segment(script)] }] }, new Set())
        .markdown,
    ).toBe(script);
  });

  it('does not apply generated-output policy to immutable saved narration', () => {
    const markdown = '这一页先确认作者希望强调什么，再给学生解释概念。';
    expect(
      compileSavedNarrationStructure(
        { cues: [{ segments: [segment(markdown)] }] },
        markdown,
        new Set(),
      ).markdown,
    ).toBe(markdown);
  });
});
