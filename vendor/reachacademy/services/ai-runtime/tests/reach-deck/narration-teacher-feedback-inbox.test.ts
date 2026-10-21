import { describe, expect, it } from 'vitest';

import {
  NARRATION_TEACHER_FEEDBACK_INBOX,
  NARRATION_TEACHER_FEEDBACK_INBOX_PRODUCTION_ELIGIBLE,
  NARRATION_TEACHER_FEEDBACK_REVIEW_BOUNDARY,
  NARRATION_TEACHER_FEEDBACK_INBOX_VERSION,
} from '../../lib/reach-deck/narration-teacher-feedback-inbox.js';
import { OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET } from '../../lib/reach-deck/prompts/snippets.js';
import { NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE } from '../../lib/reach-deck/narration-teacher-calibration.js';

describe('教师真实讲稿反馈待迭代语料', () => {
  it('逐字保存牛顿第一定律前两页的原稿、修订稿和点评', () => {
    expect(NARRATION_TEACHER_FEEDBACK_INBOX_VERSION).toBe('reach-deck-teacher-feedback-inbox/v2');
    expect(NARRATION_TEACHER_FEEDBACK_INBOX).toHaveLength(9);

    const first = NARRATION_TEACHER_FEEDBACK_INBOX[0]!;
    expect(first.revisedNarration).toContain('物体是不是只有在力的作用下，才能一直运动下去？');
    expect(first.revisedNarration).toContain('三百多年前，物理学家牛顿也问出了同样的问题');
    expect(first.revisedNarration).toContain('会有怎样的感受和运动？。');
    expect(first.teacherCommentary).toContain('好像魔术师变魔术的时候');
    expect(first.teacherCommentary).toContain('蠢蠢的');

    const second = NARRATION_TEACHER_FEEDBACK_INBOX[1]!;
    expect(second.revisedNarration).toContain('小车是会一直开下去还是慢慢停下？');
    expect(second.revisedNarration).toContain('请说说你的想法。');
    expect(second.teacherCommentary).toContain('在新知识引入等时候，要尽量通俗和简单一些');
  });

  it('保存 Luna 样本 1—7 的通过意见、修改稿和授课方法点评', () => {
    const luna = NARRATION_TEACHER_FEEDBACK_INBOX.filter(
      (entry) => entry.sourceSampleNumber !== undefined,
    );
    expect(luna.map((entry) => entry.sourceSampleNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    expect(luna[0]!.teacherCommentary).toBe('讲稿没问题');
    expect(luna[1]!.revisedNarration).toContain('如此，才可以万无一失。');
    expect(luna[2]!.revisedNarration).toContain('控制变量”思想的一个体现');
    expect(luna[2]!.teacherCommentary).toContain('给学生一种”广泛联系“的思维点拨');
    expect(luna[3]!.revisedNarration).toContain('天平所能称量的物质的范围');
    expect(luna[4]!.teacherCommentary).toContain('可以稍微更多衔接一点点');
    expect(luna[5]!.revisedNarration).toContain('过度外推的错误');
    expect(luna[5]!.teacherCommentary).toContain('判断 vs 推断');
    expect(luna[6]!.revisedNarration).toContain('你做得很棒');
    expect(luna[6]!.teacherCommentary).toContain('不是判断（推断）的依据，而是对现象的解释');

    expect(NARRATION_TEACHER_FEEDBACK_REVIEW_BOUNDARY).toEqual({
      reviewedSampleNumbers: [1, 2, 3, 4, 5, 6, 7],
      deferredFromSampleNumber: 8,
      note: '样本 8 及之后暂不评价，等待教师后续反馈。',
    });
  });

  it('原始 inbox 不直接进入生产 Prompt，但教师确认后的方法可以提炼晋升', () => {
    expect(NARRATION_TEACHER_FEEDBACK_INBOX_PRODUCTION_ELIGIBLE).toBe(false);
    expect(
      NARRATION_TEACHER_FEEDBACK_INBOX.every(
        (entry) =>
          entry.productionEligible === false &&
          entry.status === 'captured-awaiting-teacher-iteration',
      ),
    ).toBe(true);
    expect(OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET).not.toContain('蠢蠢的');
    expect(OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET).not.toContain(
      '三百多年前，物理学家牛顿也问出了同样的问题',
    );
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('过度外推');
    expect(NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE).toContain('广泛联系”是可选点拨');
    expect(OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET).not.toContain('你做得很棒');
  });
});
