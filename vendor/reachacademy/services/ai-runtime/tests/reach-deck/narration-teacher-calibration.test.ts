import { describe, expect, it } from 'vitest';

import {
  NARRATION_TEACHER_CALIBRATION_EXAMPLES,
  NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE,
  NARRATION_TEACHER_CALIBRATION_PHRASE_BANK,
  NARRATION_TEACHER_CALIBRATION_PRODUCTION_EXAMPLE,
  NARRATION_TEACHER_CALIBRATION_VERSION,
  NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES,
  NARRATION_TEACHER_REFERENCE_EXAMPLES,
} from '../../lib/reach-deck/narration-teacher-calibration.js';

describe('教师手改中文讲稿校准语料', () => {
  it('完整保存 A/B/C 三个校准版本及其方法信号', () => {
    expect(NARRATION_TEACHER_CALIBRATION_VERSION).toBe('reach-deck-teacher-calibration/v3');
    expect(NARRATION_TEACHER_CALIBRATION_EXAMPLES).toHaveLength(3);
    expect(NARRATION_TEACHER_CALIBRATION_EXAMPLES.map((entry) => entry.sourceVariant)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(NARRATION_TEACHER_CALIBRATION_EXAMPLES[0]!.teacherEditedText).toContain(
      '要完成这个任务，你需要',
    );
    expect(NARRATION_TEACHER_CALIBRATION_EXAMPLES[1]!.teacherEditedText).toContain('刚才我们看到');
    expect(NARRATION_TEACHER_CALIBRATION_EXAMPLES[2]!.teacherEditedText).toContain(
      '让我们从第一步先开始吧~',
    );
  });

  it('同时提供方法指南、关键词句式和完整生产示范', () => {
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('前页明确呈现或讲解的内容');
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain(
      '不表示系统知道学生真的看过、读过、分析过、操作过或答对了',
    );
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('不能只做什么');
    expect(NARRATION_TEACHER_CALIBRATION_PHRASE_BANK).toContain('接着，再……');
    expect(NARRATION_TEACHER_CALIBRATION_PHRASE_BANK).toContain('前面讲到……');
    expect(NARRATION_TEACHER_CALIBRATION_PHRASE_BANK).toContain('现在关键就在于……');
    expect(NARRATION_TEACHER_CALIBRATION_PHRASE_BANK).toContain('由此可见……');
    expect(NARRATION_TEACHER_CALIBRATION_PRODUCTION_EXAMPLE).toContain('整个创作任务分成三步');
  });

  it('保存七个教师确认后的教学思维校准片段且生产片段逐字来自修改稿', () => {
    expect(NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES).toHaveLength(7);
    expect(NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES.map((entry) => entry.id)).toEqual([
      'teacher-newton-intuitive-hook',
      'teacher-newton-low-load-question',
      'teacher-math-method-sequence',
      'teacher-physics-control-variable',
      'teacher-chemistry-scope-explanation',
      'teacher-history-inference-boundary',
      'teacher-geography-evidence-explanation',
    ]);
    for (const example of NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES) {
      expect(example.productionEligible).toBe(true);
      expect(example.exampleText).toContain(example.highlightExcerpt);
      expect(example.highlightExcerpt).not.toContain('万无一失');
      expect(example.highlightExcerpt).not.toContain('你做得很棒');
    }
  });

  it('把认知负荷、广泛联系、逻辑角色和可信肯定边界写入方法指南', () => {
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('直觉问题或真实误解');
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('广泛联系”是可选点拨');
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('观察、读出、显示');
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('推断、表明、支持');
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('“断言”');
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('“外推”');
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain(
      'previousContinuity、learnerAction、event manifest',
    );
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('适度书面性');
  });

  it('逐字保留教师原稿与点评，生产适配逐项记录且不声称学生已答对', () => {
    expect(NARRATION_TEACHER_REFERENCE_EXAMPLES).toHaveLength(12);
    const newton = NARRATION_TEACHER_REFERENCE_EXAMPLES.find(
      (example) => example.id === 'teacher-newton-first-law-page-01',
    )!;
    expect(newton.teacherEditedText).toContain('运动？。');
    expect(newton.productionText).not.toContain('运动？。');
    expect(newton.teacherCommentary).toContain('魔术师');
    const ohm = NARRATION_TEACHER_REFERENCE_EXAMPLES.find(
      (example) => example.id === 'teacher-luna-v24-sample-03-physics-ohm',
    )!;
    expect(ohm.teacherEditedText).toContain('如果你正确操作了的话');
    expect(ohm.productionText).not.toContain('如果你正确操作了的话');
    const geography = NARRATION_TEACHER_REFERENCE_EXAMPLES.find(
      (example) => example.id === 'teacher-luna-v24-sample-07-geography-monsoon',
    )!;
    expect(geography.teacherEditedText).toContain('你做得很棒');
    expect(geography.productionText).not.toContain('你做得很棒');
    for (const example of NARRATION_TEACHER_REFERENCE_EXAMPLES) {
      expect(example.productionEligible).toBe(
        !['teacher-oil-seller-project-a', 'teacher-oil-seller-project-c'].includes(example.id),
      );
      for (const adaptation of example.adaptations) {
        expect(example.teacherEditedText).toContain(adaptation.originalSpan);
      }
    }
  });
});
