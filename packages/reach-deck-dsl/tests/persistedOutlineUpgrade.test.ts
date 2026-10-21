import { describe, expect, it } from 'vitest';
import {
  createGenerationWorkspace,
  parseGenerationWorkspace,
  parsePageOutlineValue,
} from '../src/index.js';
import { NOW, lessonPlan, outline, page } from './generationFixtures.js';

const legacySpec = {
  learningObjective: '识别函数的变化趋势',
  teachingMove: 'explain',
  keyPoints: ['定义域', '单调性', '最值'],
  visualDirection: '左文右图',
  density: 'medium',
};
const plot = {
  schemaVersion: 'reach-function-plot/v1',
  ariaLabel: '二次函数图像',
  viewport: { x: [-5, 5], y: [-5, 15] },
  axes: { grid: true, xLabel: 'x', yLabel: 'y' },
  series: [{ id: 'quadratic', expression: 'x^2', colorToken: 'accent' }],
  parameters: [],
  markers: [],
  intersections: [],
};
const common = { aspectRatio: '16:9', placement: 'supporting' } as const;

/** Rewrites one page everywhere it is persisted, the way earlier releases saved it. */
function persistLegacyPage(pageId: string, legacy: Record<string, unknown>) {
  const raw = JSON.parse(
    JSON.stringify(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: 'deck-1',
        source: 'source',
        lessonPlan,
        pagedOutline: outline([page('page-1', 1, 'slide'), page('page-2', 2, 'slide')]),
        createdAt: NOW,
      }),
    ),
  );
  const index = raw.pagedOutline.pages.findIndex((entry: { id: string }) => entry.id === pageId);
  raw.pagedOutline.pages[index] = { ...raw.pagedOutline.pages[index], ...legacy };
  raw.records[pageId].page = raw.pagedOutline.pages[index];
  return raw;
}

describe('persisted outline upgrades', () => {
  it('loads an unversioned spec without visual assets that still carries learnerAction', () => {
    const workspace = parseGenerationWorkspace(
      persistLegacyPage('page-1', {
        summary: 'retired page summary',
        instructionalSpec: { ...legacySpec, learnerAction: 'retired' },
      }),
    );
    const upgraded = workspace.pagedOutline!.pages[0]!;
    expect(upgraded).not.toHaveProperty('summary');
    expect(upgraded.instructionalSpec).not.toHaveProperty('learnerAction');
    expect(upgraded.instructionalSpec?.visualAssets).toEqual([]);
    expect(workspace.records['page-1']!.page).toEqual(upgraded);
  });

  it('upgrades kind-less image plans and pre-diagram function plots', () => {
    const workspace = parseGenerationWorkspace(
      persistLegacyPage('page-2', {
        instructionalSpec: {
          ...legacySpec,
          visualAssets: [
            { ...common, purpose: '展示情境', prompt: '操场上的学生', alt: '操场' },
            { ...common, kind: 'function-plot', purpose: '观察抛物线', plot },
          ],
        },
      }),
    );
    const [image, functionPlot] = workspace.pagedOutline!.pages[1]!.instructionalSpec!.visualAssets;
    expect(image).toMatchObject({ kind: 'image', prompt: '操场上的学生' });
    expect(functionPlot).toMatchObject({
      kind: 'diagram',
      representation: 'function-plot',
      alt: '观察抛物线',
    });
  });

  it('keeps rejecting the retired shapes on fresh outline values', () => {
    expect(() =>
      parsePageOutlineValue({ ...page('page-1', 1, 'slide'), summary: 'retired' }),
    ).toThrow();
  });
});
