import { describe, expect, it } from 'vitest';

import { parseJsonWithRepair } from '../../lib/reach-deck/json-repair.js';

describe('Reach Deck JSON 容错修复链', () => {
  it('原样可解析时标记为 exact 且不算修复', () => {
    const outcome = parseJsonWithRepair('{"a": 1}');
    expect(outcome).toEqual({ value: { a: 1 }, strategy: 'exact/plain', repaired: false });
  });

  it('剥离 Markdown 围栏并从代码块中抽取 JSON', () => {
    const outcome = parseJsonWithRepair('前置说明\n```json\n{"a": 1}\n```\n后置说明');
    expect(outcome).toMatchObject({
      value: { a: 1 },
      strategy: 'code-block/plain',
      repaired: true,
    });
  });

  it('剥离 reasoning 思考前缀后解析', () => {
    const outcome = parseJsonWithRepair('<think>推理过程...</think>\n{"a": 1}');
    expect(outcome).toMatchObject({ value: { a: 1 }, repaired: true });
    expect(outcome?.strategy).toContain('reasoning-strip');
  });

  it('括号深度扫描可从散文包裹中截取完整 JSON 结构', () => {
    const outcome = parseJsonWithRepair('结果如下：{"a": {"b": [1, 2]}} 希望有帮助。');
    expect(outcome).toMatchObject({
      value: { a: { b: [1, 2] } },
      strategy: 'bracket-scan/plain',
      repaired: true,
    });
  });

  it('括号扫描跳过字符串字面量中的括号字符', () => {
    const outcome = parseJsonWithRepair('输出 {"text": "包含 } 与 { 的文案"} 结束');
    expect(outcome).toMatchObject({
      value: { text: '包含 } 与 { 的文案' },
      repaired: true,
    });
  });

  it('手工修复字符串中未双重转义的 LaTeX 命令', () => {
    // \g 不是合法 JSON 转义，直接解析会失败，手工修复层将其双重转义
    const outcome = parseJsonWithRepair('{"formula": "\\gamma + \\delta"}');
    expect(outcome).toMatchObject({ value: { formula: '\\gamma + \\delta' }, repaired: true });
    expect(outcome?.strategy).toContain('manual-fix');
  });

  it('手工修复被整体误引号化的属性片段', () => {
    const outcome = parseJsonWithRepair('{"width": 100, "height: 76", "visible: false"}');
    expect(outcome).toMatchObject({
      value: { width: 100, height: 76, visible: false },
      repaired: true,
    });
  });

  it('补全被截断的 JSON 数组', () => {
    const outcome = parseJsonWithRepair('[{"a": 1}, {"b": 2}');
    expect(outcome).toMatchObject({ value: [{ a: 1 }, { b: 2 }], repaired: true });
  });

  it('补全被截断的 JSON 对象', () => {
    const outcome = parseJsonWithRepair('{"a": {"b": 1}');
    expect(outcome).toMatchObject({ value: { a: { b: 1 } }, repaired: true });
  });

  it('jsonrepair 兜底修复未转义引号等复杂损坏', () => {
    const outcome = parseJsonWithRepair("{'a': 1, b: 'x'}");
    expect(outcome).toMatchObject({ value: { a: 1, b: 'x' }, repaired: true });
  });

  it('转义字符串中的裸控制字符', () => {
    const outcome = parseJsonWithRepair('{"text": "第一行\n第二行"}');
    expect(outcome).toMatchObject({ value: { text: '第一行\n第二行' }, repaired: true });
  });
});
