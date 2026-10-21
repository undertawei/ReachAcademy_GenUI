import { richTextToPlainText, type ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import type { DecksmithStreamEvent } from '../../../lib/reach-deck/decksmith/agent.js';

/**
 * Decksmith 第②层评测案例：冻结输入取自第①层回放夹具，断言只看"结局"。
 *
 * 数据源：`tests/reach-deck/decksmith-replay/fixtures/cases/<fixtureId>.json` 的文档与请求；
 * 评测可覆盖教师原话（同一冻结文档上的变体），并默认改用当前提示词合同版本（新 Run 的真实行为）。
 * 核心逻辑：
 * 1. 每个案例声明夹具、是否附带选中图片（视觉输入）、可选的原话覆盖；
 * 2. `check` 只根据结果文档、outcome、工具调用名与桩调用记录判断成败，接受等价的正确解法
 *    （不比对工具轨迹、措辞或调用顺序）；
 * 3. 失败归入固定类别（见 EvalFailureCategory），报告按类别汇总，便于看出提示词/工具的问题集中在哪。
 * 设计动机：真实模型每次走的路径不同，只断言轨迹会把正确但不同的解法误判为失败（评审 M12）。
 */

export type EvalFailureCategory =
  | 'run-error'
  /** 网关/上游 5xx、连接中断：基础设施问题，不计为模型质量失败的成因。 */
  | 'provider-error'
  /** 工具调用到达时参数为空（网关丢弃了并行工具调用的参数）。 */
  | 'empty-tool-arguments'
  | 'guardrail'
  | 'timeout'
  | 'token-cap'
  | 'no-change'
  | 'unexpected-change'
  | 'wrong-target'
  | 'collateral-change'
  | 'missing-clarification'
  | 'quiz-count'
  | 'quiz-contract'
  | 'duplicate-stems'
  | 'source-handling'
  | 'page-order'
  | 'wording'
  | 'media-intent'
  | 'not-committed'
  | 'runtime-policy';

export interface EvalFailure {
  readonly category: EvalFailureCategory;
  readonly detail: string;
}

/** 案例判定所需的运行观测（不含 token / 延迟，那些属于报告）。 */
export interface EvalObservation {
  readonly baseline: ReachDeckDocumentV2;
  readonly pageId: string;
  readonly result?: Extract<DecksmithStreamEvent, { type: 'result' }>;
  /** 成功执行（isError=false）的工具名，按完成顺序。 */
  readonly toolsOk: readonly string[];
  readonly toolErrors: readonly string[];
  readonly imageEditCalls: number;
  readonly imageGenerateCalls: number;
}

export interface DecksmithEvalCase {
  readonly id: string;
  readonly fixtureId: string;
  readonly summary: string;
  /** 覆盖夹具里的教师原话（同一文档与页面上的请求变体）。 */
  readonly prompt?: string;
  /** 选中的是图片时，按生产入队路径授权并附带视觉输入（模态）。 */
  readonly vision?: boolean;
  readonly check: (observation: EvalObservation) => EvalFailure[];
}

const PAGE = (n: number) => `55555555-5555-4555-8555-555555555555:page-${n}`;

export const DECKSMITH_EVAL_CASES: readonly DecksmithEvalCase[] = [
  {
    id: 'image-edit-selected',
    fixtureId: 'case2-selected-hero-image-edit',
    summary: '选中题图后"只把左下角电池改成充电电池"：只在选中元素上参考原图编辑，其余不变',
    vision: true,
    check: (o) => {
      const failures = requireChanged(o);
      if (failures.length > 0) return failures;
      const document = o.result!.document as ReachDeckDocumentV2;
      const before = element(o.baseline, PAGE(1), 'p1-hero');
      const after = element(document, PAGE(1), 'p1-hero');
      if (after === undefined || after.type !== 'image') {
        failures.push(
          fail('wrong-target', 'selected picture p1-hero is missing or no longer an image'),
        );
      } else if (after.resourceId === (before as { resourceId?: string }).resourceId) {
        failures.push(fail('wrong-target', 'selected picture still binds its original resource'));
      } else {
        // alt 是 edit_native_image 的显式参数，按新图更新描述属于等价的正确解法；几何、层级、fit 必须保持。
        const changed = Object.keys({ ...before, ...after }).filter(
          (key) =>
            key !== 'resourceId' &&
            key !== 'alt' &&
            !sameJson(
              (before as unknown as Record<string, unknown>)[key],
              (after as unknown as Record<string, unknown>)[key],
            ),
        );
        if (changed.length > 0) {
          failures.push(
            fail('collateral-change', `selected picture changed ${changed.join(', ')}`),
          );
        }
      }
      if (!o.toolsOk.includes('edit_native_image')) {
        failures.push(
          fail(
            'wrong-target',
            'edit_native_image never succeeded (regenerated instead of editing?)',
          ),
        );
      }
      if (o.imageGenerateCalls > 0) {
        failures.push(
          fail('wrong-target', 'generated a new picture instead of editing the reference'),
        );
      }
      failures.push(...collateral(o.baseline, document, { [PAGE(1)]: ['p1-hero'] }));
      return failures;
    },
  },
  {
    id: 'image-ambiguous-ask',
    fixtureId: 'wp7-ambiguous-picture-asks-teacher',
    summary: '未选中、页面两张图时说"这张图"：ask_teacher 给出两个候选，不修改',
    check: (o) => {
      const failures: EvalFailure[] = [];
      if (o.result?.changed === true) {
        failures.push(
          fail('unexpected-change', 'changed the deck although the target was ambiguous'),
        );
      }
      if (o.imageEditCalls + o.imageGenerateCalls > 0) {
        failures.push(
          fail('unexpected-change', 'called an image service before the teacher answered'),
        );
      }
      const clarification = o.result?.outcome?.clarification;
      if (clarification === undefined) {
        failures.push(fail('missing-clarification', 'run ended without ask_teacher'));
        return failures;
      }
      const ids = new Set((clarification.candidates ?? []).map((candidate) => candidate.elementId));
      if (!ids.has('p2-dry') || !ids.has('p2-rechargeable')) {
        failures.push(
          fail(
            'missing-clarification',
            `candidates should name both pictures, got [${[...ids].join(', ')}]`,
          ),
        );
      }
      return failures;
    },
  },
  {
    id: 'genui-to-five-open-quizzes',
    fixtureId: 'case3-quiz-request-on-genui-origin',
    summary:
      '"把这个(GenUI)改成 5 个无标答的课中互动题"：5 个开放测验页、题干不同、来源 GenUI 删除',
    check: (o) => {
      const failures = requireChanged(o);
      if (failures.length > 0) return failures;
      const document = o.result!.document as ReachDeckDocumentV2;
      const baselineIds = new Set(o.baseline.pages.map((page) => page.pageId));
      const inserted = document.pages.filter((page) => !baselineIds.has(page.pageId));
      const quizzes = inserted.filter((page) => page.sceneType === 'quiz');
      if (quizzes.length !== 5 || inserted.length !== 5) {
        failures.push(
          fail(
            'quiz-count',
            `expected 5 new quiz pages, got ${quizzes.length} quiz / ${inserted.length} new`,
          ),
        );
      }
      const stems: string[] = [];
      for (const page of quizzes) {
        if (page.sceneType !== 'quiz') continue;
        const questions = page.scene.content.questions;
        if (questions.length !== 1) {
          failures.push(
            fail('quiz-contract', `${page.title}: ${questions.length} questions on one page`),
          );
        }
        for (const question of questions) {
          stems.push(normalizeStem(richTextToPlainText(question.question)));
          if (question.has_answer !== false) {
            failures.push(fail('quiz-contract', `${page.title}: has_answer is not false`));
          }
          if (
            question.question_type === 'single_choice' ||
            question.question_type === 'multiple_choice'
          ) {
            failures.push(
              fail(
                'quiz-contract',
                `${page.title}: open-ended question uses ${question.question_type}`,
              ),
            );
          }
        }
      }
      if (new Set(stems).size !== stems.length) {
        failures.push(fail('duplicate-stems', 'two quiz pages share the same stem'));
      }
      // "改成" = 替换：来源 GenUI 删除，题目接在原位置上。
      if (document.pages.some((page) => page.pageId === PAGE(3))) {
        failures.push(
          fail(
            'source-handling',
            'source GenUI page was kept although the teacher asked to turn it into quizzes',
          ),
        );
      }
      const order = document.pages.map((page) => page.pageId);
      const firstQuiz = Math.min(...quizzes.map((page) => order.indexOf(page.pageId)));
      const consecutive = quizzes.every((page) => {
        const index = order.indexOf(page.pageId);
        return index >= firstQuiz && index < firstQuiz + quizzes.length;
      });
      if (!consecutive || order.indexOf(PAGE(2)) !== firstQuiz - 1) {
        failures.push(fail('page-order', 'quiz pages are not consecutive at the source position'));
      }
      failures.push(...collateral(o.baseline, document, { [PAGE(3)]: '*' }));
      return failures;
    },
  },
  {
    id: 'narration-rewrite-text-only',
    fixtureId: 'case4-narration-rewrite-marks-media-stale',
    summary:
      '"讲稿改成先回顾电功公式再引入三种用电器"：set_native_narration 改本页讲稿、不声明媒体生成',
    check: (o) => narrationCheck(o, false),
  },
  {
    id: 'narration-rewrite-with-audio',
    fixtureId: 'case4-narration-rewrite-marks-media-stale',
    prompt: '把这一页讲稿改成先回顾电功公式 W=UIt，再引入三种用电器，改完重新生成配音',
    summary:
      '同上并"重新生成配音"：讲稿改写 + 采用后自动生成本页音频（schedule_page_media_after_apply）',
    check: (o) => narrationCheck(o, true),
  },
  {
    id: 'genui-insert-commit',
    fixtureId: 'case6-genui-commit-completion-mode',
    summary: '"在这一页后面加一个电功计算器 GenUI，学生算完点完成"：一次运行内提交新互动页',
    check: (o) => {
      const failures = requireChanged(o);
      if (failures.length > 0) return failures;
      const document = o.result!.document as ReachDeckDocumentV2;
      const baselineIds = new Set(o.baseline.pages.map((page) => page.pageId));
      const inserted = document.pages.filter((page) => !baselineIds.has(page.pageId));
      const interactive = inserted.filter((page) => page.sceneType === 'interactive');
      // 未提交的互动工作副本不进入提案文档，所以"提案里有这一页"即"已提交"。
      if (interactive.length !== 1) {
        failures.push(
          fail('not-committed', `expected 1 committed Interactive page, got ${interactive.length}`),
        );
        return failures;
      }
      const page = interactive[0]!;
      if (page.sceneType === 'interactive') {
        if (page.scene.documentHtml.trim().length < 200) {
          failures.push(fail('not-committed', 'committed Interactive page has an empty document'));
        }
        if (page.scene.runtimePolicy?.completionMode !== 'explicit') {
          failures.push(
            fail(
              'runtime-policy',
              `"学生算完点完成" needs completionMode explicit, got ${page.scene.runtimePolicy?.completionMode}`,
            ),
          );
        }
      }
      const order = document.pages.map((candidate) => candidate.pageId);
      if (order.indexOf(page.pageId) !== order.indexOf(PAGE(3)) + 1) {
        failures.push(
          fail('page-order', 'new Interactive page is not right after the current page'),
        );
      }
      if (inserted.length !== 1) {
        failures.push(fail('collateral-change', `inserted ${inserted.length} pages instead of 1`));
      }
      failures.push(...collateral(o.baseline, document, {}));
      return failures;
    },
  },
];

function narrationCheck(o: EvalObservation, audioRequested: boolean): EvalFailure[] {
  const failures = requireChanged(o);
  if (failures.length > 0) return failures;
  const document = o.result!.document as ReachDeckDocumentV2;
  if (!o.toolsOk.includes('set_native_narration')) {
    failures.push(fail('wrong-target', 'set_native_narration never succeeded'));
  }
  const before = slide(o.baseline, PAGE(1))?.narration?.markdown ?? '';
  const after = slide(document, PAGE(1))?.narration?.markdown ?? '';
  if (after === '' || after === before) {
    failures.push(fail('no-change', 'narration of the current page did not change'));
  } else {
    // 措辞约束只做简单字符串检查：先回顾电功（公式），再引入用电器。
    // 顺序按本页的具体用电器名（夹具 energy-lesson 第 1 页：电热水壶、风扇）判断，不按"用电器"一词：
    // 回顾公式的句子本身常写"电流通过用电器所做的功"，按该词判断会把正确讲稿误判为顺序颠倒。
    const recall = firstIndex(after, ['电功', 'W=UIt', 'W = UIt']);
    const appliances = firstIndex(after, ['电热水壶', '水壶', '风扇']);
    if (recall < 0)
      failures.push(fail('wording', 'narration does not recall the electric-work formula'));
    if (appliances < 0 && !after.includes('用电器'))
      failures.push(fail('wording', 'narration does not introduce the appliances'));
    if (recall >= 0 && appliances >= 0 && recall > appliances) {
      // 附讲稿开头，便于人工判断是模型没按顺序写，还是字符串检查过严。
      failures.push(
        fail(
          'wording',
          `narration introduces the appliances before recalling the formula: ${Array.from(after).slice(0, 160).join('')}`,
        ),
      );
    }
  }
  const afterApply = o.result?.outcome?.afterApply ?? [];
  if (audioRequested) {
    if (!afterApply.some((action) => action.pageId === PAGE(1))) {
      failures.push(
        fail(
          'media-intent',
          'teacher asked for new voice-over but no after-apply media was scheduled',
        ),
      );
    }
  } else if (afterApply.length > 0) {
    failures.push(
      fail(
        'media-intent',
        `scheduled ${afterApply.map((action) => action.kind).join(', ')} although only text was asked`,
      ),
    );
  }
  // 本页其余元素与别页一律不动（讲稿改写导致的音频/时间轴清空属于预期）。
  const pageBefore = slide(o.baseline, PAGE(1));
  const pageAfter = slide(document, PAGE(1));
  if (!sameJson(pageBefore?.elements, pageAfter?.elements)) {
    failures.push(fail('collateral-change', 'elements on the narration page changed'));
  }
  failures.push(...collateral(o.baseline, document, { [PAGE(1)]: '*' }));
  return failures;
}

function requireChanged(o: EvalObservation): EvalFailure[] {
  if (o.result === undefined) return [fail('run-error', 'run ended without a result')];
  if (!o.result.changed || o.result.document === undefined) {
    const clarification = o.result.outcome?.clarification;
    return [
      fail(
        'no-change',
        clarification !== undefined
          ? `asked instead of acting: ${clarification.question.slice(0, 120)}`
          : `no proposal (${o.result.message.slice(0, 120)})`,
      ),
    ];
  }
  return [];
}

/**
 * 与基线比较除允许改动之外的页面：`'*'` 表示整页允许改动（含删除），数组表示该页只允许这些元素改动。
 * 页面修订号与新增媒体资源不算附带改动。
 */
function collateral(
  baseline: ReachDeckDocumentV2,
  document: ReachDeckDocumentV2,
  allowed: Readonly<Record<string, '*' | readonly string[]>>,
): EvalFailure[] {
  const failures: EvalFailure[] = [];
  for (const page of baseline.pages) {
    const rule = allowed[page.pageId];
    if (rule === '*') continue;
    const next = document.pages.find((candidate) => candidate.pageId === page.pageId);
    if (next === undefined) {
      failures.push(fail('collateral-change', `page "${page.title}" was deleted`));
      continue;
    }
    // 允许元素级改动的页只比较 nativeSlides（页面条目里的投影可能随之刷新）。
    // 插入/删除页会顺移后续页的 order；顺序由各案例单独判定，这里只看内容。
    if (
      rule === undefined &&
      !sameJson({ ...page, revision: 0, order: 0 }, { ...next, revision: 0, order: 0 })
    ) {
      failures.push(fail('collateral-change', `page "${page.title}" scene changed`));
      continue;
    }
    const before = slide(baseline, page.pageId);
    const after = slide(document, page.pageId);
    if (before === undefined) continue;
    const skip = new Set(rule ?? []);
    const strip = (value: typeof before) => ({
      ...value,
      elements: value?.elements.filter((candidate) => !skip.has(candidate.id)),
    });
    if (after === undefined || !sameJson(strip(before), strip(after))) {
      failures.push(
        fail('collateral-change', `slide "${page.title}" changed outside the allowed elements`),
      );
    }
  }
  return failures;
}

function slide(document: ReachDeckDocumentV2, pageId: string) {
  return document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
}

function element(document: ReachDeckDocumentV2, pageId: string, elementId: string) {
  return slide(document, pageId)?.elements.find((candidate) => candidate.id === elementId);
}

function normalizeStem(value: string): string {
  return value.replace(/[\s，。？！、,.?!：:；;"“”‘’]/gu, '');
}

function firstIndex(text: string, needles: readonly string[]): number {
  const found = needles.map((needle) => text.indexOf(needle)).filter((index) => index >= 0);
  return found.length === 0 ? -1 : Math.min(...found);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(category: EvalFailureCategory, detail: string): EvalFailure {
  return { category, detail };
}
