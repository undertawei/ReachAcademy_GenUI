import { describe, expect, it } from 'vitest';

import {
  CALIBRATED_WIDTHS_PX,
  TEXT_CAPACITY_TABLE,
  TEXT_CAPACITY_WIDTHS_PX,
} from '../src/textCapacityTable.js';
import {
  countEffectiveChars,
  describeContentLengthBudget,
  describeTextFrameFitContract,
  estimateCharsPerLine,
  estimateRichTextFrameFit,
  estimateTextCapacity,
  genericCapacityByToken,
  LATIN_TO_CJK_WIDTH_RATIO,
  TEXT_CAPACITY_ADDITIONAL_HEADROOM_RATIO,
} from '../src/textCapacityEstimation.js';
import { TYPOGRAPHY_TOKENS, typographyTokensForProfile } from '../src/layoutContract.js';
import type { SlideLayoutPlan } from '../src/layoutPlan.js';
import type { RichTextDocument } from '../src/richText.js';

describe('estimateTextCapacity', () => {
  it('命中标定槽宽时在既有每行一字余量上再保留 8% headroom', () => {
    for (const width of CALIBRATED_WIDTHS_PX) {
      expect(estimateTextCapacity('body', width)).toBe(
        Math.floor(
          TEXT_CAPACITY_TABLE.body[width].maxCjkChars * TEXT_CAPACITY_ADDITIONAL_HEADROOM_RATIO,
        ),
      );
    }
  });

  it('小于完整容量表最小槽宽时 clamp 到最小档，不做外推', () => {
    const smallest = TEXT_CAPACITY_WIDTHS_PX[0];
    expect(estimateTextCapacity('body', 100)).toBe(estimateTextCapacity('body', smallest));
  });

  it('196px 窄框不会再继承 320px 的容量', () => {
    expect(estimateTextCapacity('body', 196)).toBeLessThan(estimateTextCapacity('body', 320));
  });

  it('大于最大标定槽宽时 clamp 到最大档，不做外推', () => {
    const largest = CALIBRATED_WIDTHS_PX[CALIBRATED_WIDTHS_PX.length - 1];
    expect(estimateTextCapacity('body', 2000)).toBe(estimateTextCapacity('body', largest));
  });

  it('非标定槽宽按相邻两档线性插值', () => {
    const [lower, upper] = CALIBRATED_WIDTHS_PX;
    const midpoint = (lower + upper) / 2;
    const capacity = estimateTextCapacity('body', midpoint);
    const lowerCapacity = estimateTextCapacity('body', lower);
    const upperCapacity = estimateTextCapacity('body', upper);
    expect(capacity).toBeGreaterThanOrEqual(lowerCapacity);
    expect(capacity).toBeLessThanOrEqual(upperCapacity);
  });
});

describe('estimateCharsPerLine', () => {
  it('命中标定槽宽时直接返回该槽宽的 cjkCharsPerLine', () => {
    for (const width of CALIBRATED_WIDTHS_PX) {
      expect(estimateCharsPerLine('title', width)).toBeCloseTo(
        TEXT_CAPACITY_TABLE.title[width].cjkCharsPerLine * TEXT_CAPACITY_ADDITIONAL_HEADROOM_RATIO,
      );
    }
  });
});

describe('estimateRichTextFrameFit', () => {
  const doc = (...content: NonNullable<RichTextDocument['content']>): RichTextDocument => ({
    type: 'doc',
    content,
  });
  const paragraph = (text: string) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  });

  it('把段落、硬换行与列表项分别计为强制视觉行', () => {
    const fitted = estimateRichTextFrameFit(
      doc(
        paragraph('甲'),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '乙' },
            { type: 'hardBreak' },
            { type: 'text', text: '丙' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph('丁')] },
            { type: 'listItem', content: [paragraph('戊')] },
          ],
        },
      ),
      'body',
      { widthPx: 480, heightPx: 400 },
    );

    expect(fitted.requiredLines).toBe(5);
  });

  it('识别中文末行单字、禁则标点和超长英文单词', () => {
    const cjk = estimateRichTextFrameFit(doc(paragraph('甲'.repeat(16) + '乙')), 'body', {
      widthPx: 320,
      heightPx: 400,
    });
    expect(cjk.lineQualityIssues).toContainEqual({ kind: 'single-cjk-orphan', row: 0 });

    const punctuation = estimateRichTextFrameFit(doc(paragraph('甲'.repeat(8) + '。')), 'body', {
      widthPx: 320,
      heightPx: 400,
    });
    expect(punctuation.lineQualityIssues).toContainEqual({
      kind: 'forbidden-punctuation-break',
      row: 0,
    });

    const latin = estimateRichTextFrameFit(
      doc(paragraph('supercalifragilisticexpialidocious')),
      'body',
      { widthPx: 160, heightPx: 400 },
    );
    expect(latin.lineQualityIssues).toContainEqual({ kind: 'latin-whole-word-wrap', row: 0 });
  });

  it('块级公式独占完整视觉行，行内公式按可见盒宽增加占用', () => {
    const withoutInline = estimateRichTextFrameFit(doc(paragraph('由此可得')), 'body', {
      widthPx: 192,
      heightPx: 216,
    });
    const withInline = estimateRichTextFrameFit(
      doc(
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '由' },
            { type: 'inlineMath', attrs: { latex: '\\frac{x+1}{y-1}' } },
            { type: 'text', text: '可得' },
          ],
        },
        { type: 'blockMath', attrs: { latex: 'y=x^2+1' } },
      ),
      'body',
      { widthPx: 192, heightPx: 216 },
    );

    expect(withInline.effectiveLength).toBeGreaterThan(withoutInline.effectiveLength);
    expect(withInline.requiredLines).toBeGreaterThanOrEqual(2);
  });

  it('内边距缩小可用宽高，局部字号同时放大宽度需求与安全行盒', () => {
    const plain = doc(paragraph('abcdefghij'));
    const padded = estimateRichTextFrameFit(plain, 'body', {
      widthPx: 320,
      heightPx: 204,
      paddingX: 32,
      paddingY: 32,
    });
    const enlarged = estimateRichTextFrameFit(
      doc({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'abcdefghij',
            marks: [{ type: 'textStyle', attrs: { fontSize: 84 } }],
          },
        ],
      }),
      'body',
      { widthPx: 320, heightPx: 204 },
    );
    const unpadded = estimateRichTextFrameFit(plain, 'body', {
      widthPx: 320,
      heightPx: 204,
    });

    expect(padded.charsPerLine).toBeLessThan(unpadded.charsPerLine);
    expect(padded.availableLines).toBeLessThan(unpadded.availableLines);
    const expectedScale = 84 / typographyTokensForProfile('legacy').body.fontSize;
    expect(enlarged.fontScale).toBe(expectedScale);
    expect(enlarged.safeLineBoxHeight).toBe(51 * expectedScale);
    expect(enlarged.charsPerLine).toBeLessThan(unpadded.charsPerLine);
  });
});

describe('describeTextFrameFitContract', () => {
  it('从共享断点生成强制算术、容器内边距和禁止事后修正约束', () => {
    const text = describeTextFrameFitContract('v16');
    expect(text).toContain('TEXT FRAME FIT CONTRACT (MANDATORY)');
    expect(text).toContain('add 8% headroom');
    expect(text).toContain('160:');
    expect(text).toContain('320:');
    expect(text).toContain('safe line box 76px');
    expect(text).toContain('safe line box 51px');
    expect(text).toContain('safe line box 38px');
    expect(text).toContain('requiredLines <= availableLines');
    expect(text).toContain('paragraph, hard-break row, and list-item row');
    expect(text).toContain('display formula');
    expect(text).toContain('inline formulas');
    expect(text).toContain('32-48px padding');
    expect(text).toContain('text.right <= block.right - padding');
    expect(text).toContain('Never shrink typography, clip text, add in-slide scrolling');
  });
});

describe('genericCapacityByToken', () => {
  it('为每个排版档位返回满宽（1440px）下的容量', () => {
    const result = genericCapacityByToken();
    for (const tokenName of Object.keys(TYPOGRAPHY_TOKENS) as (keyof typeof TYPOGRAPHY_TOKENS)[]) {
      expect(result[tokenName]).toBe(estimateTextCapacity(tokenName, 1440));
    }
  });
});

describe('countEffectiveChars', () => {
  it('纯中文按 1 个每字计数', () => {
    expect(countEffectiveChars('中文测试')).toBe(4);
  });

  it('纯英文按数据派生的 Latin/CJK 折算比计数', () => {
    expect(countEffectiveChars('abcd')).toBeCloseTo(4 * LATIN_TO_CJK_WIDTH_RATIO);
  });

  it('折算比是从 Source Han Sans 安全容量表派生的实测值（约 0.46）', () => {
    expect(LATIN_TO_CJK_WIDTH_RATIO).toBeGreaterThan(0.4);
    expect(LATIN_TO_CJK_WIDTH_RATIO).toBeLessThan(0.48);
    expect(LATIN_TO_CJK_WIDTH_RATIO).toBeCloseTo(0.46, 1);
  });

  it('中英混排按各自权重求和', () => {
    expect(countEffectiveChars('a中b文')).toBeCloseTo(
      LATIN_TO_CJK_WIDTH_RATIO + 1 + LATIN_TO_CJK_WIDTH_RATIO + 1,
    );
  });

  it('剥离粗体标记但保留内部文字', () => {
    expect(countEffectiveChars('**中文**')).toBe(countEffectiveChars('中文'));
  });

  it('剥离斜体标记但保留内部文字', () => {
    expect(countEffectiveChars('*中文*')).toBe(countEffectiveChars('中文'));
  });

  it('剥离无序列表标记，标记本身不计入字数', () => {
    const withMarker = countEffectiveChars('- 第一条');
    const withoutMarker = countEffectiveChars('第一条');
    expect(withMarker).toBe(withoutMarker);
  });

  it('剥离有序列表标记，标记本身不计入字数', () => {
    const withMarker = countEffectiveChars('1. 第一条');
    const withoutMarker = countEffectiveChars('第一条');
    expect(withMarker).toBe(withoutMarker);
  });

  it('多行列表逐行剥离标记', () => {
    expect(countEffectiveChars('- 第一条\n- 第二条')).toBe(countEffectiveChars('第一条\n第二条'));
  });

  it('行内公式按可见数学盒估算，不按 LaTeX 控制词源码长度计数', () => {
    const plain = countEffectiveChars('由  可得');
    const short = countEffectiveChars('由 $x^2$ 可得') - plain;
    const command = countEffectiveChars('由 $\\mathrm{x}^2$ 可得') - plain;
    expect(short).toBeGreaterThan(0);
    expect(command).toBeLessThan('\\mathrm{x}^2'.length);
  });

  it('行内公式（\\(…\\) 转义形式，与 richTextToPlainText 输出一致）计数与原始 markdown 形式相同', () => {
    expect(countEffectiveChars('由 \\(x^2\\) 可得')).toBe(countEffectiveChars('由 $x^2$ 可得'));
  });

  it('块级公式（$$…$$ 原始 markdown 形式）固定按一整行折算，与公式长度无关', () => {
    const short = countEffectiveChars('$$y=1$$');
    const long = countEffectiveChars('$$y = x^2 + 2x + 1$$');
    expect(short).toBe(long);
  });

  it('块级公式（\\[…\\] 转义形式）计数与原始 markdown 形式相同', () => {
    expect(countEffectiveChars('\\[y = x^2\\]')).toBe(countEffectiveChars('$$y = x^2$$'));
  });

  it('传入槽宽对应的每行字数时，块级公式按该槽实际每行字数折算，不再套用满宽默认值', () => {
    const narrowCharsPerLine = estimateCharsPerLine('body', 480);
    const fullWidthCharsPerLine = estimateCharsPerLine('body', 1440);
    expect(narrowCharsPerLine).toBeLessThan(fullWidthCharsPerLine);

    const narrow = countEffectiveChars('$$y = x^2$$', narrowCharsPerLine);
    const fullWidthDefault = countEffectiveChars('$$y = x^2$$');
    expect(narrow).toBeCloseTo(narrowCharsPerLine);
    expect(fullWidthDefault).toBeCloseTo(fullWidthCharsPerLine);
    expect(narrow).toBeLessThan(fullWidthDefault);
  });

  it('空字符串返回 0', () => {
    expect(countEffectiveChars('')).toBe(0);
  });
});

describe('describeContentLengthBudget', () => {
  const samplePlan: SlideLayoutPlan = {
    schemaVersion: 'reach-deck-layout-plan/v1',
    recipeId: 'single-focus-v1',
    titleFrame: { x: 80, y: 64, width: 1440, height: 112 },
    contentFrame: { x: 80, y: 208, width: 1440, height: 628 },
    slots: [
      {
        id: 'slot-1',
        role: 'primary',
        contentUnitIds: ['unit-1'],
        frame: { x: 80, y: 208, width: 900, height: 628 },
      },
      {
        id: 'slot-2',
        role: 'supporting',
        contentUnitIds: ['unit-2'],
        frame: { x: 1004, y: 208, width: 516, height: 628 },
      },
    ],
    rules: [],
  };

  it('无 layoutPlan 时退化为满宽通用预算表，覆盖每个排版档位', () => {
    const text = describeContentLengthBudget();
    const generic = genericCapacityByToken();
    for (const tokenName of Object.keys(TYPOGRAPHY_TOKENS) as (keyof typeof TYPOGRAPHY_TOKENS)[]) {
      expect(text).toContain(`${tokenName}: up to ${generic[tokenName]} characters`);
    }
  });

  it('layoutPlan 无槽位时同样退化为满宽通用预算表', () => {
    const emptyPlan: SlideLayoutPlan = { ...samplePlan, slots: [] };
    expect(describeContentLengthBudget(emptyPlan)).toBe(describeContentLengthBudget());
  });

  it('有 layoutPlan 时按 titleFrame 宽度给出标题预算', () => {
    const text = describeContentLengthBudget(samplePlan);
    const titleCapacity = estimateTextCapacity('title', samplePlan.titleFrame.width);
    expect(text).toContain(
      `Title zone (width ${samplePlan.titleFrame.width}px): up to ${titleCapacity} characters`,
    );
  });

  it('有 layoutPlan 时逐槽按槽宽枚举各常用档位预算', () => {
    const text = describeContentLengthBudget(samplePlan);
    for (const slot of samplePlan.slots) {
      const bodyCapacity = estimateTextCapacity('body', slot.frame.width);
      expect(text).toContain(`Slot ${slot.id} (${slot.role}, width ${slot.frame.width}px)`);
      expect(text).toContain(`body up to ${bodyCapacity}`);
    }
  });

  it('说明段以固定小节标题开头，便于 prompt 内定位', () => {
    expect(describeContentLengthBudget().startsWith('CONTENT LENGTH BUDGET\n')).toBe(true);
  });
});
