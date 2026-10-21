import { describe, expect, it } from 'vitest';
import {
  normalizeQuizMarkdownMath,
  QUIZ_MARKDOWN_CONTRACT_FIXTURES,
} from '@reachany/quiz-markdown-contract';

import { validateFeedforwardReport } from '../src/feedforward/report.js';

describe('validateFeedforwardReport', () => {
  it('不合并公式示例与中间的 HTML，从生成端继续拒绝不安全内容', () => {
    const feedback =
      String.raw`\\[a\\] 是示例` + '\n<img src=x onerror=alert(1)>\n' + String.raw`再看 \\[b\\]`;
    const result = validateFeedforwardReport({ feedback }, { maxPoints: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('markdown-unsafe');
      expect(result.pendingReport).toBeUndefined();
      expect(result.diagnostics?.map((entry) => entry.code)).toContain('unsafe-html');
    }
  });
  it('在生成端归一化历史 TOPSIS 和价格公式，rationale 与读取端使用相同契约', () => {
    const fixture = QUIZ_MARKDOWN_CONTRACT_FIXTURES[2]!;
    const normalized = normalizeQuizMarkdownMath(fixture.markdown);
    const result = validateFeedforwardReport(
      { score: { value: 8, rationale: fixture.markdown }, feedback: fixture.markdown },
      { maxPoints: 10, limits: { strictRationaleMarkdown: true } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.feedback).toBe(normalized);
    expect(result.report.score?.rationale).toBe(normalized);
    expect(validateFeedforwardReport(result.report, { maxPoints: 10 })).toEqual(result);
  });

  it('归一化后再检查 feedback 和 rationale 字节上限', () => {
    const formula = String.raw`\[x\]`;
    for (const field of ['feedback', 'rationale'] as const) {
      const result = validateFeedforwardReport(
        {
          feedback: field === 'feedback' ? formula : 'ok',
          score: { value: 8, rationale: field === 'rationale' ? formula : 'ok' },
        },
        {
          maxPoints: 10,
          limits: { maxFeedbackBytes: formula.length, maxRationaleBytes: formula.length },
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('business');
        expect(result.errors.join(';')).toContain(
          field === 'feedback' ? '/feedback:' : '/score/rationale:',
        );
      }
    }
  });

  it('pendingReport 正文和诊断偏移始终引用同一份归一化文本', () => {
    const feedback = String.raw`\[x=1\]` + '\n这是 **重点';
    const result = validateFeedforwardReport({ feedback }, { maxPoints: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('markdown-repairable');
    expect(result.pendingReport?.feedback).toBe(normalizeQuizMarkdownMath(feedback));
    const diagnostic = result.diagnostics?.[0];
    expect(diagnostic?.code).toBe('unclosed-strong');
    expect(result.pendingReport?.feedback.slice(diagnostic!.start, diagnostic!.end)).toBe('**');
  });

  it('合法载荷通过并归一化可选数组字段', () => {
    const result = validateFeedforwardReport(
      {
        score: { value: 8, rationale: '要点齐全，最后一步计算失误扣 2 分' },
        feedback: '## 反馈\n\n整体思路正确，\\(x^2\\) 展开有误。',
        followUps: ['如果 x 取负数，第二步还成立吗？'],
        stepErrors: [{ step: '第 3 步', error: '符号写反', knowledgePoint: '移项变号' }],
        knowledgePoints: ['完全平方公式'],
      },
      { maxPoints: 10 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.score).toEqual({
        value: 8,
        rationale: '要点齐全，最后一步计算失误扣 2 分',
      });
      expect(result.report.stepErrors[0]).toEqual({
        step: '第 3 步',
        error: '符号写反',
        knowledgePoint: '移项变号',
      });
    }
  });

  it('score 传 null（不计分）与可选字段全部缺省时通过', () => {
    const result = validateFeedforwardReport(
      { score: null, feedback: '总结：概念掌握良好。' },
      { maxPoints: 10 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.score).toBeNull();
      expect(result.report.followUps).toEqual([]);
      expect(result.report.stepErrors).toEqual([]);
      expect(result.report.knowledgePoints).toEqual([]);
    }
  });

  it('score 缺省等价于 null', () => {
    const result = validateFeedforwardReport({ feedback: '不计分总结' }, { maxPoints: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.score).toBeNull();
  });

  it('得分超过题目分值上限被拒绝', () => {
    const result = validateFeedforwardReport(
      { score: { value: 11, rationale: '全对' }, feedback: '很好' },
      { maxPoints: 10 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(';')).toContain('超过了该题分值上限 10');
    }
  });

  it('负分被拒绝', () => {
    const result = validateFeedforwardReport(
      { score: { value: -1, rationale: 'x' }, feedback: 'y' },
      { maxPoints: 10 },
    );
    expect(result.ok).toBe(false);
  });

  it('缺 feedback 字段返回错误列表（供 agent 重试）', () => {
    const result = validateFeedforwardReport(
      { score: { value: 5, rationale: '一半' } },
      { maxPoints: 10 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.join(';')).toContain('feedback');
    }
  });

  it('stepErrors 元素缺字段被拒绝', () => {
    const result = validateFeedforwardReport(
      { feedback: 'ok', stepErrors: [{ step: '第 1 步' }] },
      { maxPoints: 10 },
    );
    expect(result.ok).toBe(false);
  });
  it.each([
    'https://cdn.example.test/feedback.png',
    'Next step: https://cdn.example.test/practice.mp4?download=1',
  ])('rejects ordinary media output URL: %s', (feedback) => {
    const result = validateFeedforwardReport({ feedback, score: null }, { maxPoints: 10 });
    expect(result.ok).toBe(false);
  });

  it('局部 Markdown 结构错误保留完整 pendingReport', () => {
    const result = validateFeedforwardReport(
      {
        score: { value: 8, rationale: '评分保持不变' },
        feedback: '这是 **重点',
        followUps: ['继续思考'],
        knowledgePoints: ['定义域'],
      },
      { maxPoints: 10, scoringEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('markdown-repairable');
      expect(result.pendingReport?.score?.value).toBe(8);
      expect(result.pendingReport?.followUps).toEqual(['继续思考']);
      expect(result.diagnostics?.map((entry) => entry.code)).toContain('unclosed-strong');
    }
  });

  it.each([
    '<iframe src="https://example.test"></iframe>',
    '![外链](https://cdn.example.test/feedback.png)',
    '<span style="color:red">危险颜色</span>',
  ])('危险 Markdown fail closed 且不建立 pendingReport: %s', (feedback) => {
    const result = validateFeedforwardReport({ feedback, score: null }, { maxPoints: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('markdown-unsafe');
      expect(result.pendingReport).toBeUndefined();
    }
  });
});
