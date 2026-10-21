// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPageInstructionalSpec,
  getPageInstructionalSpec,
  type PageOutline,
  type PlannedVisualAsset,
} from '@reachany/reach-deck-dsl';
import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import { ReachDeckPageSpecEditor } from './ReachDeckPageSpecEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const originalText = '<p>保留  两个空格</p>\n{"hint":"<svg>原文</svg>"}\n末行';
const pageFor = (sceneType: PageOutline['sceneType']): PageOutline => ({
  id: 'page-1',
  order: 1,
  sceneType,
  title: 'A page',
  instructionalSpec: {
    schemaVersion: 'reach-deck-instructional-spec/v3',
    learningObjective: 'Understand the relation',
    pageRole: 'develop',
    pageJob: 'Explain this relation',
    keyPoints: [originalText],
    knowledgePointIds: ['point-1'],
    teachingMove: 'explain',
    visualDirection: '',
    density: 'medium',
    visualAssets: [],
  },
});

describe('scene-owned instructional specifications', () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: PageOutline;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = async (initialPage: PageOutline, locale: 'en-US' | 'zh-CN' = 'en-US') => {
    function Harness() {
      const [page, setPage] = useState(initialPage);
      current = page;
      return (
        <PortalI18nProvider locale={locale}>
          <button
            onClick={() =>
              setPage((value) => ({
                ...value,
                sceneType: value.sceneType === 'slide' ? 'quiz' : 'slide',
              }))
            }
          >
            change type
          </button>
          <ReachDeckPageSpecEditor
            disabled={false}
            onChange={(spec) => setPage(applyPageInstructionalSpec(page, spec))}
            page={page}
            spec={getPageInstructionalSpec(page)}
            plan={{
              id: 'plan',
              title: 'Plan',
              audience: 'Students',
              durationMinutes: 10,
              learningObjectives: [],
              teachingStrategy: '',
              keyTerms: [],
              narrative: '',
              knowledgePlan: {
                schemaVersion: 'reach-deck-knowledge-plan/v1',
                points: [{ id: 'point-1', title: 'Water cycle' }],
              } as never,
            }}
          >
            <div data-classification>classification</div>
          </ReachDeckPageSpecEditor>
        </PortalI18nProvider>
      );
    }
    await act(async () => root.render(<Harness />));
  };
  const field = (label: string) =>
    host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  const change = async (label: string, value: string) => {
    expect(field(label)).not.toBeNull();
    await act(async () => fireEvent.change(field(label)!, { target: { value } }));
  };
  const clickText = async (text: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.textContent?.trim() === text,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };

  it.each(['slide', 'quiz', 'interactive'] as const)(
    'keeps %s fields specific to that scene',
    async (sceneType) => {
      await render(pageFor(sceneType));
      expect(field('Learning objective')).not.toBeNull();
      expect(field('Page responsibility and core task')).not.toBeNull();
      expect(host.querySelector('[data-classification]') !== null).toBe(sceneType === 'slide');
      expect(field('Expected response / learning evidence') !== null).toBe(sceneType === 'quiz');
      expect(field('Learner action') !== null).toBe(sceneType === 'interactive');
      expect(field('Experience to discover') !== null).toBe(sceneType === 'interactive');
      expect(field('Density') !== null).toBe(sceneType === 'slide');
      expect(host.textContent).not.toContain('(JSON)');
      expect(host.textContent).not.toContain('Assessment intent');
      expect(host.textContent).not.toContain('GenUI intent');
      expect(host.textContent).not.toContain('Section');
    },
  );

  it('shows named associations and keeps exact content through unrelated edits and clearing', async () => {
    await render(pageFor('quiz'));
    const keyPoint = host.querySelector<HTMLTextAreaElement>('[role="group"] textarea');
    expect(keyPoint?.value).toBe(originalText);
    expect(host.querySelector('p')?.textContent ?? '').not.toContain('两个空格');
    expect(host.textContent).toContain('Water cycle');
    expect(host.querySelector('input[value="point-1"]')).toBeNull();
    await change('Learning objective', 'Changed objective');
    expect(current.instructionalSpec?.keyPoints).toEqual([originalText]);
    await act(async () => fireEvent.change(keyPoint!, { target: { value: '' } }));
    expect(getPageInstructionalSpec(current).keyPoints).toEqual(['']);
    await clickText('Water cycle');
    expect(current.instructionalSpec?.knowledgePointIds).toEqual([]);
  });

  it('edits Interactive brief as text and keeps ordinary exploration free of assessment', async () => {
    const page = pageFor('interactive');
    page.instructionalSpec!.interactionBrief = {
      learnerAction: 'Drag a point',
      experienceGoal: 'Observe an invariant',
      approachHints: ['euclidean-geometry-2d'],
    };
    await render(page);
    expect(field('Expected response / learning evidence')).toBeNull();
    await change('Learner action', '自由  拖动\n与比较');
    await change('Experience to discover', '');
    expect(current.interactionBrief).toMatchObject({
      learnerAction: '自由  拖动\n与比较',
      experienceGoal: '',
    });
    expect(field('Creative and capability hints 1')?.value).toBe('euclidean-geometry-2d');
    await change('Creative and capability hints 1', 'custom exploration');
    expect(current.instructionalSpec?.interactionBrief?.approachHints).toEqual([
      'custom exploration',
    ]);
    await clickText('Add assessment need (optional)');
    await change('Expected response / learning evidence', 'Explain one observation');
    await clickText('Remove assessment need');
    expect(field('Expected response / learning evidence')).toBeNull();
    expect(current.instructionalSpec?.assessmentEvidence).toBeUndefined();
  });

  it('presents preserved assessment and continuity as editable fields without changing untouched text', async () => {
    const assessment =
      '[interactionAssessmentPlan]\n{ "targets": [ {"statement":"原文  精调", "evidence":"解释\\n两个半径", "required":true} ], "timeBudgetSeconds": 30 }';
    const continuity =
      '[continuity]\r\n{\r\n  "fromPrevious": "保留  承接",\r\n  "learningAdvance": "揭示关系"\r\n}';
    const page = pageFor('quiz');
    page.instructionalSpec!.keyPoints = ['first', assessment, 'last', continuity];
    page.instructionalSpec!.pageJob = '解释关系\n\n[assessmentIntent]\n检查关系迁移';
    await render(page, 'zh-CN');
    expect(field('关键内容 1')?.value).toBe('first');
    expect(field('关键内容 2')?.value).toBe('last');
    expect(field('关键内容 3')).toBeNull();
    expect(host.querySelector('details')?.textContent).toContain('已有补充内容');
    expect(
      [...host.querySelectorAll('textarea')].some((entry) =>
        entry.value.startsWith('[interactionAssessmentPlan]'),
      ),
    ).toBe(false);
    expect(field('已有评价设计 / 评价目标 / 第 1 项 / 目标描述')?.value).toBe('原文  精调');
    expect(field('已有评价设计 / 评价目标 / 第 1 项 / 学习证据')?.value).toBe('解释\n两个半径');
    expect(field('页面职责与核心任务')?.value).toBe('解释关系');
    await change('关键内容 2', 'edited last');
    expect(current.instructionalSpec?.keyPoints).toEqual([
      'first',
      assessment,
      'edited last',
      continuity,
    ]);
    await change('已有评价设计 / 评价目标 / 第 1 项 / 学习证据', '新证据  \n不压缩');
    expect(current.instructionalSpec?.keyPoints).toEqual([
      'first',
      assessment.replace('"解释\\n两个半径"', JSON.stringify('新证据  \n不压缩')),
      'edited last',
      continuity,
    ]);
    await change('跨页衔接 / 承接前页', '');
    expect(current.instructionalSpec?.keyPoints[3]).toBe(continuity.replace('"保留  承接"', '""'));
    await change('评价意图', '');
    expect(current.instructionalSpec?.pageJob).toBe('解释关系\n\n[assessmentIntent]\n');
  });

  it('preserves unknown, malformed and repeated supplementary fields and removes only the selected content', async () => {
    const unknown = '[teacherCustomNote]\n{"custom":"<p>自定义  原文</p>","other":["A", "B"]}';
    const malformed = '[continuity]\n{教师自由改过，不是 JSON';
    const page = pageFor('quiz');
    page.instructionalSpec!.keyPoints = ['same', unknown, 'same', malformed];
    await render(page);
    expect(field('Existing item: teacherCustomNote / Existing item: custom')?.value).toBe(
      '<p>自定义  原文</p>',
    );
    expect(field('Connections between pages')?.value).toBe('{教师自由改过，不是 JSON');
    const keyGroup = host.querySelector('[aria-label="Key content"]')!;
    await act(async () => keyGroup.querySelectorAll<HTMLButtonElement>('button')[1]!.click());
    expect(current.instructionalSpec?.keyPoints).toEqual(['same', unknown, malformed]);
    await change('Connections between pages', '教师  手改\n原文');
    expect(current.instructionalSpec?.keyPoints).toEqual([
      'same',
      unknown,
      '[continuity]\n教师  手改\n原文',
    ]);
    await clickText('Remove this supplementary item');
    expect(current.instructionalSpec?.keyPoints).toEqual([
      'same',
      '[continuity]\n教师  手改\n原文',
    ]);
  });

  it('keeps a supplementary assessment editable when an initially empty page responsibility is filled', async () => {
    const page = pageFor('quiz');
    page.instructionalSpec!.pageJob = '[assessmentIntent]\nOriginal assessment';
    await render(page);
    expect(field('Page responsibility and core task')?.value).toBe('');
    await change('Page responsibility and core task', 'New responsibility');
    expect(field('Assessment purpose')?.value).toBe('Original assessment');
    await change('Assessment purpose', 'Edited assessment');
    expect(current.instructionalSpec?.pageJob).toBe(
      'New responsibility\n\n[assessmentIntent]\nEdited assessment',
    );
  });

  it('preserves numeric and null types while clearing and refilling legacy values', async () => {
    const page = pageFor('quiz');
    const raw =
      '[interactionAssessmentPlan]\n{ "timeBudgetSeconds": 30, "evidence": null, "other": "原文  不动" }';
    page.instructionalSpec!.keyPoints = [raw];
    await render(page);
    const numberLabel = 'Existing assessment design / Time available (seconds)';
    await change(numberLabel, '');
    expect(field(numberLabel)?.value).toBe('');
    expect(current.instructionalSpec?.keyPoints[0]).toBe(raw);
    await act(async () => fireEvent.focusOut(field(numberLabel)!));
    expect(current.instructionalSpec?.keyPoints[0]).toBe(raw.replace(': 30', ': null'));
    expect(field(numberLabel)?.getAttribute('type')).toBe('number');
    await change(numberLabel, '3');
    expect(current.instructionalSpec?.keyPoints[0]).toBe(raw.replace(': 30', ': 3'));
    await change('Existing assessment design / Learning evidence', 'New evidence');
    await change('Existing assessment design / Learning evidence', '');
    expect(current.instructionalSpec?.keyPoints[0]).toBe(raw.replace(': 30', ': 3'));
    await clickText('change type');
    expect(field('Existing assessment design / Learning evidence')?.value).toBe('');
  });

  it('applies empty object and array edits as containers and keeps invalid draft out of saved content', async () => {
    const page = pageFor('quiz');
    const raw = '[teacherCustomNote]\n{ "object": {}, "array": [], "other": "保留  原文" }';
    page.instructionalSpec!.keyPoints = [raw];
    await render(page);
    const objectLabel = 'Existing item: teacherCustomNote / Existing item: object';
    await change(objectLabel, '{"statement":');
    await clickText('Apply group content');
    expect(field(objectLabel)?.getAttribute('aria-invalid')).toBe('true');
    expect(current.instructionalSpec?.keyPoints[0]).toBe(raw);
    await change(objectLabel, '{"statement":"新  描述"}');
    await clickText('Apply group content');
    expect(current.instructionalSpec?.keyPoints[0]).toBe(
      raw.replace('{}', '{"statement":"新  描述"}'),
    );
    expect(
      field('Existing item: teacherCustomNote / Existing item: object / Target description')?.value,
    ).toBe('新  描述');
    await change('Existing item: teacherCustomNote / Existing item: array', '["A", "B"]');
    await clickText('Apply group content');
    expect(current.instructionalSpec?.keyPoints[0]).toBe(
      raw.replace('{}', '{"statement":"新  描述"}').replace('[]', '["A","B"]'),
    );
    expect(field('Existing item: teacherCustomNote / Existing item: array / Item 1')?.value).toBe(
      'A',
    );
    await change('Existing item: teacherCustomNote / Existing item: array / Item 2', '');
    expect(current.instructionalSpec?.keyPoints[0]).toContain('"array": ["A",""]');
  });

  it('shows the planned visual assets read-only and keeps them when switching page types', async () => {
    const page = pageFor('slide');
    const asset: PlannedVisualAsset = {
      kind: 'image',
      purpose: 'Show the relation',
      prompt: 'Exactly three particles',
      alt: 'Three particles',
      aspectRatio: '4:3',
      placement: 'primary',
    };
    page.instructionalSpec!.visualAssets = [asset];
    await render(page);
    expect(host.textContent).toContain('Show the relation — Three particles');
    expect(field('Visual content and factual requirements')).toBeNull();
    await clickText('change type');
    await clickText('change type');
    expect(current.instructionalSpec?.visualAssets).toEqual([asset]);
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'localizes new controls and role labels in %s',
    async (locale) => {
      const page = pageFor('interactive');
      page.instructionalSpec!.pageRole = 'exploration';
      await render(page, locale);
      expect(host.textContent).toContain(locale === 'zh-CN' ? '探索与观察' : 'Exploration');
      expect(field(locale === 'zh-CN' ? '学生操作' : 'Learner action')).not.toBeNull();
      expect(host.textContent).not.toContain('reachDeck.');
    },
  );
});
