import { createHash } from 'node:crypto';

import type { InteractiveScene } from '@reachany/reach-deck-dsl';
import {
  parseGeometryEnvelope,
  type GeometryEnvelope,
  type GeometryRange,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  createGeometryEngine,
  type GeometryInputPatch,
  type GeometrySnapshot,
} from '@reachany/reach-deck-geometry/server';
import { Window } from 'happy-dom';

export const GEOMETRY_EVALUATION_VERSION = 'reach-geometry-evaluation/v1';
export const GEOMETRY_EVALUATION_MODEL = 'openrouter/openai/gpt-5.6-terra';
export const GEOMETRY_EVALUATION_VARIANTS = [
  'baseline',
  'candidate',
  'candidate-no-examples',
] as const;
export type GeometryEvaluationVariant = (typeof GEOMETRY_EVALUATION_VARIANTS)[number];
export type KitExpectation =
  | { kind: 'any-of'; kitIds: readonly string[] }
  | { kind: 'forbid'; kitIds: readonly string[] }
  | { kind: 'none' };
export interface GeometryAcceptanceCase {
  scenarioId: string;
  category: 'core' | 'unseen' | 'control';
  title: string;
  source: string;
  keyPoints: readonly string[];
  approachHints: readonly string[];
  expectedSceneTypes: readonly ('slide' | 'interactive')[];
  generationSceneType: 'slide' | 'interactive';
  kitExpectation: KitExpectation;
  oracle: string;
  browserActions: readonly string[];
  ablation: boolean;
}
const geometryKitIds = ['euclidean-geometry-2d', 'euclidean-geometry-3d'];
const unrelatedKitIds = [
  'mechanics-2d',
  'molecule-2d',
  'molecule-3d',
  'bio-network',
  'geo-map',
  'sequence-track',
];
const interactive = {
  expectedSceneTypes: ['interactive'] as const,
  generationSceneType: 'interactive' as const,
  kitExpectation: { kind: 'forbid' as const, kitIds: unrelatedKitIds },
};

export const GEOMETRY_ACCEPTANCE_CASES: readonly GeometryAcceptanceCase[] = [
  {
    ...interactive,
    scenarioId: 'core-planar-dependencies',
    category: 'core',
    title: '拖动中的中点、垂足与圆上点',
    source:
      '固定 A=(-2,0)，B 初始为 (3,1)，可自由拖动 B。构造 AB 的中点 M；圆心 O=(0,0)、半径 2，C 只能沿圆运动，F 为 C 到直线 AB 的垂足。自由比较拖动 B、C 时哪些关系保持，不设置固定完成顺序。',
    keyPoints: ['A 和 O 固定', 'M 始终平分 AB', 'C 不离圆且 F 始终为垂足'],
    approachHints: ['spatial exploration', '直接操控'],
    oracle: 'M=(A+B)/2; |C|=2; F=A+dot(C-A,B-A)/|B-A|^2*(B-A).',
    browserActions: [
      '分别拖动 B 与 C',
      '通过键盘或参数路径改变相同自由度',
      '恢复后依赖与固定点保持',
    ],
    ablation: true,
  },
  {
    ...interactive,
    scenarioId: 'core-irregular-tetrahedron',
    category: 'core',
    title: '非规则四面体的共享顶点',
    source:
      'A=(0,0,0)、B=(4,0,0)、C=(1,3,0)、D=(1,1,h)，高度 h 可在 2 到 5 间调节。展示四个面共享顶点的非规则四面体，允许转动观察、选择面；本页不需要数值测量面板。',
    keyPoints: ['非规则四面体', '四个面共享同一组顶点', '改变高度与改变观察视角是不同操作'],
    approachHints: ['3d exploration', '选择关系'],
    oracle: 'A=(0,0,0), B=(4,0,0), C=(1,3,0), D=(1,1,h); volume=2*h; four shared faces.',
    browserActions: ['将 h 设为 2 与 5', '选择两个不同面', '旋转相机后模型坐标不变'],
    ablation: false,
  },
  {
    ...interactive,
    scenarioId: 'core-line-plane-angle',
    category: 'core',
    title: '动点与线面角',
    source:
      '矩形 ABCD 位于 z=0，A=(0,0,0)、B=(4,0,0)、C=(4,3,0)、D=(0,3,0)。P 始终在过 A 的底面法线上，PA=h，h 可在 1 到 6 间变化；M 只能沿 BC 移动。自由改变 h 和 M，比较 PM 与底面的夹角。',
    keyPoints: ['PA 始终垂直底面', 'M 不离开线段 BC', '线面角由 PM 及其底面投影决定'],
    approachHints: ['3d exploration', '参数比较'],
    oracle: 'P=(0,0,h); M=(4,3*t,0), 0<=t<=1; angle=atan2(h,sqrt(16+9*t*t))*180/pi.',
    browserActions: ['改变高度', '沿 BC 拖动 M', '旋转相机并比较角度读数'],
    ablation: true,
  },
  {
    ...interactive,
    scenarioId: 'core-half-plane-dihedral',
    category: 'core',
    title: '指定半平面的二面角',
    source:
      '两个半平面共享 x 轴；第一个包含 Q1=(0,1,0)，第二个包含 Q2=(0,cos(theta),sin(theta))。自由改变 theta 从 30 度到 180 度，比较锐角、直角、钝角和平角。二面角取指定半平面间的 0 到 180 度无符号角，120 度不能显示成 60 度。',
    keyPoints: ['共同棱为 x 轴', '明确选择两个半平面', '保留钝角与平角'],
    approachHints: ['3d exploration', '参数比较'],
    oracle: 'acos(dot(Q1,Q2)/(|Q1|*|Q2|))*180/pi; checkpoints 30,90,120,180 degrees.',
    browserActions: ['依次调为 30、90、120、180 度', '转动相机后保持角度'],
    ablation: true,
  },
  {
    ...interactive,
    scenarioId: 'core-intersection-recovery',
    category: 'core',
    title: '交点消失与恢复',
    source:
      '圆心 O=(0,0)、半径 2，水平直线 y=h，h 可在 0 到 3 间变化。改变 h，观察左右两交点合并、消失并恢复；在无交点时明确呈现未定义，恢复时继续追踪左右两支。',
    keyPoints: ['相交、相切和相离', '不存在交点时没有旧点或旧读数', '返回有效区后分支稳定恢复'],
    approachHints: ['construction', 'cause and effect'],
    oracle: 'h<2: (+/-sqrt(4-h*h),h); h=2: (0,2); h>2: undefined; replay 1,2,2.5,1.',
    browserActions: ['将 h 依次设为 1、2、2.5、1', '检查相离时的可见未定义状态'],
    ablation: false,
  },
  {
    ...interactive,
    scenarioId: 'core-composed-transforms',
    category: 'core',
    title: '旋转、镜像与缩放的组合',
    source:
      '三角形 A=(1,0,0)、B=(3,0,0)、C=(1,2,1)，依次绕 z 轴旋转 theta、关于 x=0 镜像、以原点正比例缩放 k。theta 可在 0 到 pi 弧度间变化，k 可在 0.5 到 2 间变化。原图与结果同时保留，以 A1、B1、C1 标示对应结果，比较对应长度和角度。',
    keyPoints: ['变换顺序明确', '镜像与相机转动不同', '正比例缩放保持角度并按比例改变长度'],
    approachHints: ['3d exploration', 'comparison'],
    oracle:
      '(x,y,z)->(-k*(x*cos(theta)-y*sin(theta)),k*(x*sin(theta)+y*cos(theta)),k*z); AB=2*k; AC=sqrt(5)*k.',
    browserActions: ['分别改变 theta 与 k', '比较原图及 A1、B1、C1', '相机操作不改变度量'],
    ablation: false,
  },
  {
    ...interactive,
    scenarioId: 'unseen-circle-reflection',
    category: 'unseen',
    title: '圆上运动与镜像中点',
    source:
      '圆心 O=(1,0)、半径 2，C 沿圆移动；将 C 关于直线 x=-1 镜像为 C1，构造 CC1 的中点 S。自由探索三个点的轨迹与对称关系，不设置固定完成顺序。',
    keyPoints: ['圆上自由度', '关于 x=-1 镜像', '连线中点落在对称轴上'],
    approachHints: ['spatial exploration', 'reflection'],
    oracle:
      'C=(1+2*cos(theta),2*sin(theta)); C1=(-3-2*cos(theta),2*sin(theta)); S=(-1,2*sin(theta)).',
    browserActions: ['沿圆拖动 C', '比较 C1 与 S 的同步运动', '恢复圆上位置'],
    ablation: true,
  },
  {
    ...interactive,
    scenarioId: 'unseen-oblique-plane-projection',
    category: 'unseen',
    title: '斜平面内的最短距离探索',
    source:
      '平面 alpha 为 z=x+y，Q=(0,0,3)，F 是 Q 到 alpha 的垂足；P 只能在 alpha 内移动。自由拖 P，比较 QP 与 QF，观察垂足对应的最短距离。',
    keyPoints: ['P 始终在斜平面内', 'F 是固定垂足', 'QP 不小于 QF'],
    approachHints: ['3d exploration', 'orthogonal projection'],
    oracle: 'F=(1,1,2); QF=sqrt(3); Pz=Px+Py; QP^2=3+FP^2.',
    browserActions: ['沿两个独立面内方向改变 P', '比较距离', '旋转后约束保持'],
    ablation: true,
  },
  {
    ...interactive,
    scenarioId: 'unseen-transformed-shared-polyhedron',
    category: 'unseen',
    title: '共享四面体整体变换后的对应关系',
    source:
      '四面体 A=(0,0,0)、B=(2,0,0)、C=(0,3,0)、D=(1,1,2)，M 是 BC 中点。整体先以原点缩放 k，再平移 (5,0,0)，k 可在 0.5 到 1.5 间变化。原图、变换图和对应中点同时保留，结果标为 A1、B1、C1、D1、M1，比较长度与中点关系。各面必须共享同一组顶点。',
    keyPoints: ['先缩放后平移', '共享顶点与面保持', '变换后的中点仍平分对应边'],
    approachHints: ['3d exploration', 'comparison'],
    oracle: 'X1=k*X+(5,0,0); M1=(5+k,1.5*k,0); B1C1=sqrt(13)*k; volume=2*k^3.',
    browserActions: ['将 k 调为 0.5、1、1.5', '选择并比较两个实体的面', '旋转后度量保持'],
    ablation: true,
  },
  {
    scenarioId: 'control-concept-slide',
    category: 'control',
    title: '定义、公理与猜想',
    source:
      '用一个纯概念 Slide 区分定义、公理和猜想，配简短文字例子，解释“观察成立”与“已经证明”的差别，不需要拖动实验或图形构造。',
    keyPoints: ['定义约定对象含义', '公理作为推理起点', '猜想需要证明而非只靠观察'],
    approachHints: [],
    expectedSceneTypes: ['slide'],
    generationSceneType: 'slide',
    kitExpectation: { kind: 'none' },
    oracle:
      'Native Slide binding, correct concept distinctions, no invented interactive geometry capability.',
    browserActions: ['通过原生 Slide Player 查看全部内容'],
    ablation: false,
  },
  {
    ...interactive,
    scenarioId: 'control-function-plot',
    category: 'control',
    title: '二次函数参数与开口',
    source:
      '自由调整 a 从 -2 到 2，比较 y=a*x^2 的开口方向与陡缓；展示 x=1 处的函数值，包含 a=0 的情形。',
    keyPoints: ['正负系数改变开口', '绝对值影响陡缓', 'a=0 时为零函数'],
    approachHints: ['function plot', '参数比较'],
    kitExpectation: { kind: 'forbid', kitIds: [...geometryKitIds, ...unrelatedKitIds] },
    oracle:
      'At a=-2,0,1,2 the point x=1 has y=a; valid function plot or lawful custom representation.',
    browserActions: ['依次调整 a=-2、0、1、2', '比较曲线与 x=1 的函数值'],
    ablation: false,
  },
  {
    ...interactive,
    scenarioId: 'control-open-polyline-editor',
    category: 'control',
    title: '自由折线编辑',
    source:
      '提供自由折线编辑，学生可逐次新增顶点、选择并拖动已有顶点、删除选中顶点及撤销；点数随操作变化，上限 12。只呈现当前折线，不承诺自动证明或几何约束。',
    keyPoints: ['动态增删顶点', '点顺序与位置可编辑', '撤销与状态恢复'],
    approachHints: ['custom mechanism', '自由创作'],
    kitExpectation: { kind: 'none' },
    oracle:
      'Add 3 vertices, drag the second, delete it, undo and restore; count/order/positions must agree.',
    browserActions: ['添加三个点', '拖动第二点后删除它', '撤销后恢复页面'],
    ablation: false,
  },
];

export interface GeometryEvaluationTrial {
  scenarioId: string;
  trialIndex: number;
  evaluationVariant: GeometryEvaluationVariant;
  artifactId: string;
  pageId: string;
  sceneId: string;
  caseDigest: string;
}
export const acceptanceDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createGeometryEvaluationTrials(
  cases: readonly GeometryAcceptanceCase[] = GEOMETRY_ACCEPTANCE_CASES,
  repeat = 3,
  variants: readonly GeometryEvaluationVariant[] = GEOMETRY_EVALUATION_VARIANTS,
): GeometryEvaluationTrial[] {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10)
    throw new Error('--repeat must be an integer between 1 and 10.');
  return variants.flatMap((evaluationVariant) =>
    cases.flatMap((scenario) => {
      const count =
        evaluationVariant === 'candidate-no-examples' ? Number(scenario.ablation) : repeat;
      return Array.from({ length: count }, (_, index) => {
        const trialIndex = index + 1;
        const artifactId = `${scenario.scenarioId}--${evaluationVariant}--${trialIndex}`;
        return {
          scenarioId: scenario.scenarioId,
          trialIndex,
          evaluationVariant,
          artifactId,
          pageId: artifactId,
          sceneId: artifactId,
          caseDigest: acceptanceDigest(scenario),
        };
      });
    }),
  );
}

export function assertKitExpectation(expectation: KitExpectation, kitIds: readonly string[]): void {
  if (expectation.kind === 'none' && kitIds.length)
    throw new Error(
      `acceptance_kit_forbidden: no science kit is permitted, received ${kitIds.join(',')}`,
    );
  if (expectation.kind === 'forbid' && kitIds.some((id) => expectation.kitIds.includes(id)))
    throw new Error(
      `acceptance_kit_forbidden: ${kitIds.filter((id) => expectation.kitIds.includes(id)).join(',')}`,
    );
  if (
    expectation.kind === 'any-of' &&
    (!kitIds.length || kitIds.some((id) => !expectation.kitIds.includes(id)))
  )
    throw new Error(`acceptance_kit_not_allowed: expected one of ${expectation.kitIds.join(',')}`);
}

export interface AcceptanceGeometryMarker {
  instanceId: string;
  envelope: GeometryEnvelope;
}
export function inspectAcceptanceScene(
  scene: InteractiveScene,
  scenario: GeometryAcceptanceCase,
): {
  markers: AcceptanceGeometryMarker[];
  kitIds: string[];
} {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
    },
  });
  const document = new window.DOMParser().parseFromString(scene.documentHtml, 'text/html');
  const entries = [
    ...document.querySelectorAll('script[type="application/json"][data-reach-science-kit]'),
  ].map((marker) => ({
    instanceId: marker.getAttribute('data-reach-science-kit') ?? '',
    value: JSON.parse(marker.textContent ?? '') as { kitId?: string },
  }));
  const kitIds = entries.map(({ value }) => value.kitId ?? 'unknown');
  assertKitExpectation(scenario.kitExpectation, kitIds);
  return {
    kitIds,
    markers: entries
      .filter(({ value }) => geometryKitIds.includes(value.kitId ?? ''))
      .map(({ instanceId, value }) => ({
        instanceId,
        envelope: parseGeometryEnvelope(value).envelope,
      })),
  };
}

export interface AcceptanceInputProbe {
  field: string;
  value: number;
  patch: GeometryInputPatch;
}
export function completeGeometryAcceptancePatch(
  patch: GeometryInputPatch,
  snapshot: GeometrySnapshot,
): GeometryInputPatch {
  return {
    ...patch,
    ...(patch.freedoms === undefined
      ? {}
      : {
          freedoms: Object.fromEntries(
            Object.entries(patch.freedoms).map(([id, value]) => [
              id,
              typeof value === 'number'
                ? value
                : { ...(snapshot.inputs.freedoms[id] as Record<string, number>), ...value },
            ]),
          ),
        }),
  };
}
export function geometryAcceptanceProbes(envelope: GeometryEnvelope): AcceptanceInputProbe[] {
  const probes: AcceptanceInputProbe[] = [];
  const add = (
    field: string,
    range: GeometryRange,
    patch: (value: number) => GeometryInputPatch,
  ) => {
    const values = [
      range.min,
      range.max,
      (range.min + range.max) / 2,
      0,
      0.5,
      1,
      1.5,
      2,
      2.5,
      3,
      4,
      5,
      6,
      Math.PI / 6,
      Math.PI / 2,
      -Math.PI / 2,
      (3 * Math.PI) / 2,
      (-3 * Math.PI) / 2,
      (2 * Math.PI) / 3,
      Math.PI,
      30,
      90,
      120,
      180,
    ];
    for (const value of [...new Set(values)].filter(
      (value) => value >= range.min && value <= range.max,
    ))
      probes.push({ field, value, patch: patch(value) });
  };
  for (const parameter of envelope.spec.parameters)
    if (envelope.spec.interaction.parameters.includes(parameter.id))
      add(`parameter:${parameter.id}`, parameter, (value) => ({
        parameters: { [parameter.id]: value },
      }));
  for (const freedom of envelope.spec.interaction.freedoms) {
    if (freedom.kind === 'line' || freedom.kind === 'circle')
      add(`freedom:${freedom.id}`, freedom.range, (value) => ({
        freedoms: { [freedom.id]: value },
      }));
    else {
      const axes =
        freedom.kind === 'freePoint'
          ? [
              { axis: 'x', range: freedom.x },
              { axis: 'y', range: freedom.y },
            ]
          : freedom.kind === 'plane'
            ? [
                { axis: 'u', range: freedom.u },
                { axis: 'v', range: freedom.v },
              ]
            : freedom.kind === 'translate'
              ? freedom.ranges.map((range) => ({ axis: range.axis, range }))
              : [];
      for (const { axis, range } of axes)
        add(`freedom:${freedom.id}:${axis}`, range, (value) => ({
          freedoms: { [freedom.id]: { [axis]: value } },
        }));
    }
  }
  if (probes.length > 256)
    throw new Error(
      'acceptance_probe_budget_exceeded: too many independent controls for this fixed brief',
    );
  return probes;
}

type Point = readonly number[];
const subtract = (a: Point, b: Point): number[] => a.map((value, i) => value - b[i]!);
const dot = (a: Point, b: Point): number => a.reduce((sum, value, i) => sum + value * b[i]!, 0);
const distance = (a: Point, b: Point): number => Math.hypot(...subtract(a, b));
const requireCondition = (condition: boolean, detail: string): void => {
  if (!condition) throw new Error(`acceptance_semantics: ${detail}`);
};
const near = (actual: number, expected: number, detail: string): void =>
  requireCondition(
    Number.isFinite(actual) &&
      Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected)),
    `${detail}: expected ${expected}, got ${actual}`,
  );
const pointNear = (actual: Point, expected: Point, detail: string): void => {
  requireCondition(actual.length === expected.length, `${detail}: incorrect dimension`);
  expected.forEach((value, i) => near(actual[i]!, value, `${detail}[${i}]`));
};
const normalizedLabel = (label: string): string =>
  label.replace(/[′']/g, '1').replace(/[_\s]/g, '').toLowerCase();
export function geometryPointId(envelope: GeometryEnvelope, name: string): string {
  const key = normalizedLabel(name);
  const matches = envelope.spec.objects.filter((object) => {
    const label = envelope.spec.presentation.objects.find(
      (entry) => entry.object === object.id,
    )?.label;
    return (
      normalizedLabel(object.id) === key || (label !== undefined && normalizedLabel(label) === key)
    );
  });
  requireCondition(matches.length === 1, `need one unambiguous object labelled ${name}`);
  return matches[0]!.id;
}

/** Independent analytic relations, using engine outputs as observations rather than as the oracle. */
export function assertGeometryAcceptanceSnapshot(
  scenarioId: string,
  envelope: GeometryEnvelope,
  snapshot: GeometrySnapshot,
): void {
  const point = (name: string): Point => {
    const state = snapshot.objects[geometryPointId(envelope, name)];
    requireCondition(
      state?.status === 'valid' && state.coordinates !== null,
      `${name} must be defined`,
    );
    return state!.coordinates!;
  };
  const fixed = (name: string, expected: Point): Point => {
    const actual = point(name);
    pointNear(actual, expected, name);
    return actual;
  };
  const measure = (kind: string, expected: number) => {
    const measurements = envelope.spec.measurements.filter((entry) => entry.kind === kind);
    requireCondition(measurements.length > 0, `missing ${kind} observation`);
    requireCondition(
      measurements.some((entry) => {
        const value = snapshot.measurements[entry.id];
        return (
          value?.status === 'valid' &&
          value.value !== null &&
          Math.abs(value.value - expected) < 1e-6
        );
      }),
      `${kind} must equal ${expected}`,
    );
  };
  const midpoint = (name: string, a: Point, b: Point) =>
    pointNear(
      point(name),
      a.map((value, i) => (value + b[i]!) / 2),
      name,
    );
  const sharedTetrahedron = (names: string[]) => {
    const ids = new Set(names.map((name) => geometryPointId(envelope, name)));
    const faces = envelope.spec.objects.filter(
      (object) =>
        object.kind === 'face' &&
        object.vertices.length === 3 &&
        object.vertices.every((id) => ids.has(id)),
    );
    const distinct = new Set(
      faces.map((object) => (object.kind === 'face' ? [...object.vertices].sort().join(',') : '')),
    );
    requireCondition(
      distinct.size === 4,
      `four tetrahedron faces must share ${names.join(',')} vertices`,
    );
  };
  if (scenarioId === 'core-planar-dependencies') {
    const a = fixed('A', [-2, 0]),
      b = point('B'),
      c = point('C');
    fixed('O', [0, 0]);
    midpoint('M', a, b);
    near(Math.hypot(...c), 2, 'C circle freedom');
    const direction = subtract(b, a),
      lengthSquared = dot(direction, direction);
    if (lengthSquared > 1e-12) {
      const t = dot(subtract(c, a), direction) / lengthSquared;
      pointNear(
        point('F'),
        a.map((value, i) => value + t * direction[i]!),
        'F projection',
      );
    }
  } else if (scenarioId === 'core-irregular-tetrahedron') {
    fixed('A', [0, 0, 0]);
    fixed('B', [4, 0, 0]);
    fixed('C', [1, 3, 0]);
    const d = point('D');
    near(d[0]!, 1, 'D.x');
    near(d[1]!, 1, 'D.y');
    requireCondition(d[2]! >= 2 - 1e-7 && d[2]! <= 5 + 1e-7, 'height must remain within [2,5]');
    sharedTetrahedron(['A', 'B', 'C', 'D']);
  } else if (scenarioId === 'core-line-plane-angle') {
    fixed('A', [0, 0, 0]);
    fixed('B', [4, 0, 0]);
    fixed('C', [4, 3, 0]);
    fixed('D', [0, 3, 0]);
    const p = point('P'),
      m = point('M');
    near(p[0]!, 0, 'P.x');
    near(p[1]!, 0, 'P.y');
    near(m[0]!, 4, 'M.x');
    near(m[2]!, 0, 'M.z');
    requireCondition(p[2]! >= 1 - 1e-7 && p[2]! <= 6 + 1e-7, 'height outside [1,6]');
    requireCondition(m[1]! >= -1e-7 && m[1]! <= 3 + 1e-7, 'M left segment BC');
    measure('linePlaneAngle', (Math.atan2(p[2]!, Math.hypot(4, m[1]!)) * 180) / Math.PI);
  } else if (scenarioId === 'core-half-plane-dihedral') {
    const a = fixed('Q1', [0, 1, 0]),
      b = point('Q2');
    near(b[0]!, 0, 'Q2.x');
    near(Math.hypot(...b), 1, 'Q2 radius');
    const angle = (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
    measure('dihedralAngle', angle);
  } else if (scenarioId === 'core-intersection-recovery') {
    fixed('O', [0, 0]);
    const circles = Object.values(snapshot.objects).filter((entry) => entry.kind === 'circle');
    requireCondition(
      circles.some((entry) => entry.radius !== undefined && Math.abs(entry.radius - 2) < 1e-7),
      'circle radius must be 2',
    );
    const intersections = envelope.spec.objects.filter(
      (object) => object.kind === 'intersectLineCircle',
    );
    requireCondition(intersections.length >= 2, 'both intersection branches must be constructed');
    const branches = new Set<string>();
    for (const intersection of intersections) {
      if (intersection.kind !== 'intersectLineCircle') continue;
      const line = snapshot.objects[intersection.line]!;
      requireCondition(
        line.origin !== undefined && line.direction !== undefined,
        'intersection line must exist',
      );
      near(line.direction![1]!, 0, 'line must stay horizontal');
      const h = line.origin![1]!,
        actual = snapshot.objects[intersection.id]!;
      branches.add(intersection.branch);
      if (h > 2 + 1e-7)
        requireCondition(
          actual.status === 'undefined' && actual.coordinates === null,
          'absent intersection must not retain stale coordinates',
        );
      else
        pointNear(
          actual.coordinates ?? [],
          [
            (intersection.branch === 'lower' ? -1 : 1) *
              Math.sign(line.direction![0]!) *
              Math.sqrt(Math.max(0, 4 - h * h)),
            h,
          ],
          intersection.id,
        );
    }
    requireCondition(branches.size === 2, 'distinct intersection branches required');
  } else if (scenarioId === 'unseen-circle-reflection') {
    fixed('O', [1, 0]);
    const c = point('C'),
      reflected = point('C1');
    near(distance(c, [1, 0]), 2, 'C circle');
    pointNear(reflected, [-2 - c[0]!, c[1]!], 'C1 mirror');
    midpoint('S', c, reflected);
  } else if (scenarioId === 'unseen-oblique-plane-projection') {
    const q = fixed('Q', [0, 0, 3]),
      f = fixed('F', [1, 1, 2]),
      p = point('P');
    near(p[2]!, p[0]! + p[1]!, 'P plane constraint');
    near(distance(q, p) ** 2, 3 + distance(f, p) ** 2, 'projection distance identity');
  } else if (scenarioId === 'unseen-transformed-shared-polyhedron') {
    const a = fixed('A', [0, 0, 0]),
      b = fixed('B', [2, 0, 0]),
      c = fixed('C', [0, 3, 0]),
      d = fixed('D', [1, 1, 2]);
    const a1 = fixed('A1', [5, 0, 0]),
      b1 = point('B1'),
      c1 = point('C1'),
      d1 = point('D1');
    const k = (b1[0]! - a1[0]!) / 2;
    requireCondition(k >= 0.5 - 1e-7 && k <= 1.5 + 1e-7, 'scale outside [0.5,1.5]');
    for (const [source, result] of [
      [a, a1],
      [b, b1],
      [c, c1],
      [d, d1],
    ] as const)
      pointNear(
        result,
        source.map((value, i) => value * k + (i === 0 ? 5 : 0)),
        'scale then translate',
      );
    midpoint('M', b, c);
    midpoint('M1', b1, c1);
    sharedTetrahedron(['A', 'B', 'C', 'D']);
    sharedTetrahedron(['A1', 'B1', 'C1', 'D1']);
  } else if (scenarioId === 'core-composed-transforms') {
    fixed('A', [1, 0, 0]);
    fixed('B', [3, 0, 0]);
    fixed('C', [1, 2, 1]);
    const a = point('A1'),
      b = point('B1'),
      c = point('C1');
    const k = Math.hypot(a[0]!, a[1]!);
    requireCondition(k >= 0.5 - 1e-7 && k <= 2 + 1e-7, 'scale outside [0.5,2]');
    near(a[2]!, 0, 'A1.z');
    pointNear(
      b,
      a.map((value) => 3 * value),
      'B1 transform',
    );
    pointNear(c, [a[0]! + 2 * a[1]!, a[1]! - 2 * a[0]!, k], 'rotation then mirror then scale');
    requireCondition(a[1]! >= -1e-7, 'rotation must follow theta in [0,pi]');
  }
}

export interface GeometrySemanticEvidence {
  status: 'passed' | 'review-required';
  kitIds: string[];
  observations: number;
  markers: Array<{ instanceId: string; probeCount: number }>;
  reason?: string;
}
export class GeometryAcceptanceSemanticError extends Error {
  constructor(
    message: string,
    readonly instanceIds: readonly string[],
  ) {
    super(message);
    this.name = 'GeometryAcceptanceSemanticError';
  }
}

function assertAcceptanceDomain(
  scenarioId: string,
  envelope: GeometryEnvelope,
  snapshots: readonly GeometrySnapshot[],
): void {
  const points = (name: string) =>
    snapshots.map((snapshot) => snapshot.objects[geometryPointId(envelope, name)]!.coordinates!);
  const covers = (values: readonly number[], expected: readonly number[], label: string) => {
    for (const checkpoint of expected)
      requireCondition(
        values.some((value) => Math.abs(value - checkpoint) <= 1e-6),
        `${label} never reaches ${checkpoint}`,
      );
  };
  const spansPlane = (name: string) => {
    const values = points(name),
      origin = values[0]!;
    const differences = values.map((value) => subtract(value, origin));
    requireCondition(
      differences.some((a) =>
        differences.some((b) => dot(a, a) * dot(b, b) - dot(a, b) ** 2 > 1e-8),
      ),
      `${name} needs two independent movement directions`,
    );
  };
  if (scenarioId === 'core-planar-dependencies') {
    spansPlane('B');
    covers(
      points('C').map((point) => point[0]!),
      [-2, 2],
      'circle C.x',
    );
    covers(
      points('C').map((point) => point[1]!),
      [-2, 2],
      'circle C.y',
    );
  } else if (scenarioId === 'core-irregular-tetrahedron') {
    covers(
      points('D').map((point) => point[2]!),
      [2, 5],
      'tetrahedron height',
    );
  } else if (scenarioId === 'core-line-plane-angle') {
    covers(
      points('P').map((point) => point[2]!),
      [1, 6],
      'height',
    );
    covers(
      points('M').map((point) => point[1]!),
      [0, 3],
      'segment BC',
    );
  } else if (scenarioId === 'core-half-plane-dihedral') {
    covers(
      points('Q2').map(
        (point) => (Math.acos(Math.max(-1, Math.min(1, point[1]!))) * 180) / Math.PI,
      ),
      [30, 90, 120, 180],
      'dihedral angle',
    );
  } else if (scenarioId === 'core-intersection-recovery') {
    const intersection = envelope.spec.objects.find(
      (object) => object.kind === 'intersectLineCircle',
    );
    requireCondition(intersection?.kind === 'intersectLineCircle', 'missing intersection');
    if (intersection?.kind === 'intersectLineCircle')
      covers(
        snapshots.map((snapshot) => snapshot.objects[intersection.line]!.origin![1]!),
        [1, 2, 2.5],
        'intersection height',
      );
  } else if (scenarioId === 'unseen-circle-reflection') {
    covers(
      points('C').map((point) => point[0]!),
      [-1, 3],
      'circle C.x',
    );
    covers(
      points('C').map((point) => point[1]!),
      [-2, 2],
      'circle C.y',
    );
  } else if (scenarioId === 'unseen-oblique-plane-projection') {
    spansPlane('P');
  } else if (scenarioId === 'unseen-transformed-shared-polyhedron') {
    covers(
      points('B1').map((point) => (point[0]! - 5) / 2),
      [0.5, 1.5],
      'scale',
    );
  } else if (scenarioId === 'core-composed-transforms') {
    covers(
      points('A1').map((point) => Math.hypot(point[0]!, point[1]!)),
      [0.5, 2],
      'scale',
    );
    covers(
      points('A1').map((point) => (Math.atan2(point[1]!, -point[0]!) * 180) / Math.PI),
      [0, 90, 180],
      'rotation',
    );
  }
}

export function geometryAcceptancePrimaryMarkers(
  markers: ReturnType<typeof inspectAcceptanceScene>['markers'],
  scenarioId: string,
): typeof markers {
  if (markers.length <= 1) return markers;
  const required: Record<string, string[]> = {
    'core-planar-dependencies': ['A', 'B', 'C', 'O', 'M', 'F'],
    'core-irregular-tetrahedron': ['A', 'B', 'C', 'D'],
    'core-line-plane-angle': ['A', 'B', 'C', 'D', 'P', 'M'],
    'core-half-plane-dihedral': ['Q1', 'Q2'],
    'core-intersection-recovery': ['O'],
    'core-composed-transforms': ['A', 'B', 'C', 'A1', 'B1', 'C1'],
    'unseen-circle-reflection': ['O', 'C', 'C1', 'S'],
    'unseen-oblique-plane-projection': ['Q', 'F', 'P'],
    'unseen-transformed-shared-polyhedron': ['A', 'B', 'C', 'D', 'A1', 'B1', 'C1', 'D1', 'M', 'M1'],
  };
  return markers.filter(({ envelope }) => {
    try {
      return (required[scenarioId] ?? []).every((name) => Boolean(geometryPointId(envelope, name)));
    } catch {
      return false;
    }
  });
}
export function validateGeometryAcceptanceScene(
  scene: InteractiveScene,
  scenario: GeometryAcceptanceCase,
): GeometrySemanticEvidence {
  const inspected = inspectAcceptanceScene(scene, scenario);
  if (!inspected.markers.length || scenario.category === 'control')
    return {
      status: 'review-required',
      kitIds: inspected.kitIds,
      observations: 0,
      markers: [],
      reason:
        'Independent visible task review is required for legacy/custom/control implementations; no new-kit quota.',
    };
  const markers: GeometrySemanticEvidence['markers'] = [];
  let observations = 0;
  const primary = geometryAcceptancePrimaryMarkers(inspected.markers, scenario.scenarioId);
  for (const { instanceId, envelope } of primary) {
    const engine = createGeometryEngine(envelope);
    try {
      assertGeometryAcceptanceSnapshot(scenario.scenarioId, envelope, engine.snapshot());
      observations++;
      const probes = geometryAcceptanceProbes(envelope);
      requireCondition(probes.length > 0, 'the declared learner action needs an effective input');
      let changed = false;
      const initial = engine.snapshot();
      const snapshots = [initial];
      for (const probe of probes) {
        engine.reset();
        const snapshot = engine.applyInputs(completeGeometryAcceptancePatch(probe.patch, initial));
        assertGeometryAcceptanceSnapshot(scenario.scenarioId, envelope, snapshot);
        snapshots.push(snapshot);
        changed ||= JSON.stringify(snapshot.objects) !== JSON.stringify(initial.objects);
        observations++;
      }
      requireCondition(changed, 'declared inputs never change the construction');
      assertAcceptanceDomain(scenario.scenarioId, envelope, snapshots);
      markers.push({ instanceId, probeCount: probes.length });
    } catch (error) {
      throw new GeometryAcceptanceSemanticError(
        error instanceof Error ? error.message : String(error),
        [instanceId],
      );
    } finally {
      engine.dispose();
    }
  }
  return {
    status: primary.length === inspected.markers.length ? 'passed' : 'review-required',
    kitIds: inspected.kitIds,
    observations,
    markers,
    ...(primary.length === inspected.markers.length
      ? {}
      : {
          reason:
            'Auxiliary or distributed geometry instances need an independent whole-page review.',
        }),
  };
}
