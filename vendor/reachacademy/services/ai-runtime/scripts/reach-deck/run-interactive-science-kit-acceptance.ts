/**
 * Generate one real Interactive page for every built-in science kit, then mount the strict v2
 * document in the login-free production Player harness and run desktop/mobile browser acceptance.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  compileDeckSlideToNativeV2,
  isNativeSlideArtifact,
  interactiveScienceKitRuntimeDependency,
  parseInteractiveScienceKitEnvelopeValue,
  parseLessonPlanValue,
  parsePagedDeckOutlineValue,
  parseReachDeckDocumentV2,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REFERENCE_MANIFEST_VERSION,
  resolveDeckTheme,
  type GeneratedSceneArtifact,
  type InteractiveScienceKitId,
  type PageOutline,
  type PageGenerationRequest,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_REGISTRY,
} from '@reachany/reach-deck-dsl/reference-library';
import { Window } from 'happy-dom';

import { generatePageArtifactWithModelService } from '../../lib/reach-deck/generation-pipeline.js';
import { GeometryGenerationSemanticError } from '../../lib/reach-deck/interactive-generation-validation.js';
import {
  buildScientificGenerationContext,
  type ScientificContextSnapshot,
} from '../../lib/reach-deck/scientific-generation-context.js';
import { INTERACTIVE_PROMPT, SLIDE_PROMPT } from '../../lib/reach-deck/prompts/index.js';
import { buildReachDeckScientificToolCatalog } from '../../lib/reach-deck/scientific-tool-catalog.js';
import type {
  ReachDeckModelEnv,
  ReachDeckModelRequestContext,
  ReachDeckProviderOutputDiagnostic,
  ReachDeckModelUsage,
} from '../../lib/reach-deck/model-service-client.js';
import { createDirectLiteLlmFetch } from './offline-model-client.js';
import {
  loadStrictReachDeckDocument,
  prepareReachDeckPlayerHarness,
  resolveTemporaryOutputDirectory,
  startReachDeckPlayerHarnessServer,
} from './player-harness.js';
import { runReachDeckPlayerHarnessSmoke } from './player-harness-smoke.js';
import {
  GEOMETRY_ACCEPTANCE_CASES,
  GEOMETRY_EVALUATION_MODEL,
  GEOMETRY_EVALUATION_VARIANTS,
  GEOMETRY_EVALUATION_VERSION,
  GeometryAcceptanceSemanticError,
  acceptanceDigest,
  createGeometryEvaluationTrials,
  validateGeometryAcceptanceScene,
  type GeometryAcceptanceCase,
  type GeometryEvaluationTrial,
  type GeometryEvaluationVariant,
  type GeometrySemanticEvidence,
} from './geometry-acceptance-cases.js';
import {
  runGeometryAcceptanceSmoke,
  type GeometryAcceptanceBrowserEvidence,
} from './geometry-acceptance-smoke.js';

const DEFAULT_MODEL = 'openrouter/openai/gpt-5.6-terra';
const DEFAULT_OUTPUT_DIRECTORY = 'tmp/reach-deck-interactive-science-kits';
const USAGE = `Usage:
  pnpm --filter @reachany/ai-runtime accept:interactive-science-kits -- [options]

Options:
  --model <id>          LiteLLM model id (default: REACH_DECK_E2E_MODEL or ${DEFAULT_MODEL})
  --kits <csv>          Generate a comma-separated subset of built-in kit ids (default: all)
  --suite <science-kits|geometry>
                        Geometry runs the frozen 12-case baseline/candidate matrix and six ablations
  --scenarios <csv>     Geometry scenario ids (default: all twelve)
  --repeat <count>      Geometry trials per baseline/candidate case (default: 3)
  --variants <csv>      baseline,candidate,candidate-no-examples (default: all)
  --prepare-only        Freeze geometry inputs without calling a model
  --supplement-concept  Prepare the separate six-trial concept-Slide amendment
  --review-file <path>  Apply digest-bound independent task/layout review to completed geometry trials
  --merge-documents <csv>
                        Merge two or more previously generated strict v2 documents by pageId;
                        later documents replace matching pages and no model is called
  --output-dir <path>   Child directory of tmp/ or .tmp/ (default: ${DEFAULT_OUTPUT_DIRECTORY})
  --skip-smoke          Prepare the Player but skip desktop/mobile Chromium acceptance
  --help                Print this contract without calling cloud models
`;

interface ScienceKitAcceptanceCase {
  kitId: InteractiveScienceKitId;
  title: string;
  learningObjective: string;
  keyPoints: string[];
  learnerAction: string;
  experienceGoal: string;
  approachHints: string[];
  source: string;
  visualDirection: string;
  assessmentEvidence?: string;
  requiresStateRestore?: boolean;
}

export const INTERACTIVE_SCIENCE_KIT_ACCEPTANCE_CASES: readonly ScienceKitAcceptanceCase[] = [
  {
    kitId: 'geometry-board',
    title: '拖动顶点，观察三角形如何保持连接',
    learningObjective: '通过拖动一个自由顶点，解释三角形的边始终连接同一组顶点。',
    keyPoints: ['底边两个端点固定', '第三个顶点可自由拖动', '三条边随顶点位置连续更新'],
    learnerAction: '反复拖动三角形的第三个顶点，比较不同形状下三条边的连接关系。',
    experienceGoal: '发现顶点位置改变会改变形状，但边与顶点的连接关系保持不变。',
    approachHints: ['spatial exploration'],
    source:
      '使用一个底边固定、第三个顶点可拖动的欧氏三角形。只讨论点、线段和拖动，不引入依赖构造。',
    visualDirection: '一个占据主要视口的二维坐标板，固定点和可拖动点有清楚区别。',
  },
  {
    kitId: 'mechanics-2d',
    title: '改变恢复系数，比较碰撞后的运动',
    learningObjective: '通过改变小球恢复系数，比较同一碰撞条件下反弹速度的变化。',
    keyPoints: ['重力和初始位置保持不变', '恢复系数是唯一可调变量', '反弹高度随恢复系数变化'],
    learnerAction: '调节恢复系数并重复观察小球落到固定地面后的碰撞和反弹。',
    experienceGoal: '观察控制变量条件下，碰撞弹性如何改变反弹结果。',
    approachHints: ['simulation', 'cause and effect'],
    source: '一个圆形小球在竖直重力下落到静止地面。恢复系数范围为 0.2 到 0.9，其他条件固定。',
    visualDirection: '二维物理世界占主画面，配一个紧凑的恢复系数控制。',
  },
  {
    kitId: 'molecule-2d',
    title: '同分异构体：相同分子式，不同连接顺序',
    learningObjective: '分别选择乙醇与二甲醚中的氧原子，通过直接相连的碳原子数解释连接差异。',
    keyPoints: [
      '乙醇 CCO 中氧直接连接 1 个碳',
      '二甲醚 COC 中氧直接连接 2 个碳',
      '两者分子式相同但连接顺序不同',
    ],
    learnerAction:
      '按任意顺序反复选择或取消选择两个结构中的氧原子，随时比较各自直接相连的碳原子数。',
    experienceGoal: '用氧原子的直接碳邻居数作为可见证据，辨认两种同分异构体的连接差异。',
    approachHints: ['interactive diagram', 'playful exploration'],
    source:
      '只使用两个给定结构和固定 id：乙醇 id=ethanol、SMILES=CCO；二甲醚 id=dimethyl_ether、SMILES=COC。selectionMode 必须为 atom。两个结构始终同时可见，学习者可按任意顺序反复选择或取消选择氧原子，每次选择立即显示该氧原子直接相连的碳原子数。不得设置任务步骤、进度、完成门槛或延迟揭示的标准结论。每次 stateChange 必须包含 ReachScienceKits.getState 返回的 kitState，并在恢复时调用 ReachScienceKits.setState。移动端两个结构及两个 O 原子仍须同时可见，kit target 可视高度不得低于 120px。不得臆造其他结构或性质。',
    visualDirection:
      '两张清晰的二维分子结构并排呈现，氧原子有足够大的可选命中区，局部反馈不遮挡结构。',
    assessmentEvidence:
      '任意一次氧原子选择都立即呈现其直接碳邻居数，两个结构可在任意顺序下形成 1 与 2 的可见比较。',
    requiresStateRestore: true,
  },
  {
    kitId: 'bio-network',
    title: '食物网中的能量关系不是一条链',
    learningObjective: '通过选择食物网节点，追踪一个物种与多个捕食关系的连接。',
    keyPoints: ['草被兔和蚱蜢取食', '兔被狐捕食', '蚱蜢被蛙捕食', '鹰同时捕食兔和蛙'],
    learnerAction: '自由选择、取消选择并拖动任意物种节点，比较不同节点的直接来源和去向。',
    experienceGoal: '用草的 2 条去向和鹰的 2 个来源作为证据，说明生态关系形成网络而不是单链。',
    approachHints: ['interactive diagram', 'spatial exploration', 'playful exploration'],
    source:
      '节点使用固定 id：grass=草、rabbit=兔、grasshopper=蚱蜢、frog=蛙、fox=狐、eagle=鹰。关系仅限：grass→rabbit、grass→grasshopper、rabbit→fox、rabbit→eagle、grasshopper→frog、frog→eagle；箭头表示被取食者到捕食者的能量方向。所有节点始终可自由选择、取消选择和拖动，每次选择立即突出其直接来源与去向，允许学习者任意切换和比较。不得设置固定选择顺序、任务进度、完成门槛或延迟揭示的标准结论。每次 stateChange 必须包含 ReachScienceKits.getState 返回的 kitState，并在恢复时调用 ReachScienceKits.setState。说明、图例和帮助必须放在 kit target 外的正常布局中，禁止绝对定位覆盖节点按钮或网络图。',
    visualDirection:
      '一个可选择、可拖动的生态关系网络，节点分组和箭头方向清楚，局部关系反馈紧邻但不覆盖网络。',
    assessmentEvidence:
      '任意节点选择都立即呈现直接来源和去向；草与鹰可在任意顺序下显示各自两条直接关系。',
    requiresStateRestore: true,
  },
  {
    kitId: 'geo-map',
    title: '经纬度如何定位同一颗地球上的地点',
    learningObjective: '在世界地图上根据经纬度定位北京、基多和伦敦并比较纬度位置。',
    keyPoints: ['北京约 116.4°E, 39.9°N', '基多约 78.5°W, 0.2°S', '伦敦约 0.1°W, 51.5°N'],
    learnerAction: '平移、缩放或旋转世界地图并选择三个坐标点，比较它们相对赤道的位置。',
    experienceGoal: '把经纬度数值与世界地图上的实际位置对应起来。',
    approachHints: ['spatial exploration'],
    source: '使用离线世界底图和三个给定近似坐标，不加载在线瓦片或外部地理数据。',
    visualDirection: '世界投影地图占主要区域，显示经纬网和三个有标签的点。',
  },
  {
    kitId: 'solid-3d',
    title: '旋转棱柱，辨认平行底面与侧面',
    learningObjective: '通过旋转三棱柱，从不同视角辨认两个平行全等底面和三个侧面。',
    keyPoints: ['两个三角形底面平行且全等', '对应顶点由侧棱连接', '视角改变不改变实体结构'],
    learnerAction: '绕三棱柱旋转视角并缩放，选择不同方向观察底面和侧面。',
    experienceGoal: '建立二维投影变化与三维实体不变量之间的联系。',
    approachHints: ['3d exploration', 'spatial model'],
    source: '只呈现一个规则三棱柱，尺寸有界；不得用二维假透视替代可旋转三维实体。',
    visualDirection: '全视口三维实体，简洁轨道控制，底面与侧面颜色层级清晰。',
  },
  {
    kitId: 'molecule-3d',
    title: '从不同方向观察水分子的弯曲结构',
    learningObjective: '旋转水分子模型，辨认一个氧原子与两个氢原子形成的弯曲空间结构。',
    keyPoints: ['氧原子位于中心', '两个氢原子分别与氧相连', '三原子不在一条直线上'],
    learnerAction: '旋转并缩放给定的三原子水分子模型，从多个方向确认其弯曲结构。',
    experienceGoal: '理解屏幕投影会随视角改变，而原子连接和空间构型保持不变。',
    approachHints: ['3d exploration', 'spatial model'],
    source: `只使用下面的内联 PDB，不访问网络：
ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O
ATOM      2  H1  HOH A   1       0.957   0.000   0.000  1.00  0.00           H
ATOM      3  H2  HOH A   1      -0.240   0.927   0.000  1.00  0.00           H
CONECT    1    2    3
END`,
    visualDirection: '一个可旋转缩放的三维球棍模型，背景安静，原子易区分。',
  },
  {
    kitId: 'sequence-track',
    title: '在 DNA 序列上定位启动子与编码区',
    learningObjective: '通过选择序列特征，区分启动子、起始密码子和编码区的位置范围。',
    keyPoints: ['序列坐标从 1 开始', '启动子位于编码区之前', 'ATG 是给定序列中的起始密码子'],
    learnerAction: '缩放和平移 DNA 序列轨道，依次选择启动子、起始密码子和编码区特征。',
    experienceGoal: '把功能注释与具体的一维序列坐标对应起来。',
    approachHints: ['process exploration'],
    source:
      '使用 DNA 序列 TATAAAGGCCATGAAACCCGGGTTTAAACCCGGG；标注启动子 1-6、起始密码子 11-13、编码区 11-31，坐标均为一基。',
    visualDirection: '横向序列主轨道配三条紧凑特征轨道，选择特征时反馈其坐标。',
  },
  {
    kitId: 'dynamic-geometry',
    title: '拖动端点，中点始终平分线段',
    learningObjective: '通过拖动线段端点，验证依赖构造出的中点始终把线段分成两段。',
    keyPoints: ['A 与 B 是自由点', 'M 是由 A、B 构造的中点', '拖动任一端点时 M 自动更新'],
    learnerAction: '反复拖动 A 或 B，观察依赖构造点 M 与线段 AB 同步变化。',
    experienceGoal: '区分自由对象和依赖对象，并观察中点关系在动态变化中保持。',
    approachHints: ['construction', 'drag and construct'],
    source:
      '构造两个自由点 A、B、线段 AB 和依赖于 A、B 的中点 M；这是依赖几何构造，不应实现成手工同步的普通点。',
    visualDirection: '带坐标轴和网格的动态几何板，A、B 可拖动，M 清楚标示为依赖中点。',
  },
] as const;

interface CliOptions {
  mergeDocumentFiles?: readonly string[];
  model: string;
  outputDirectory: string;
  scenarios: readonly ScienceKitAcceptanceCase[];
  smoke: boolean;
  geometry?: GeometryEvaluationOptions;
}
export interface GeometryEvaluationOptions {
  cases: readonly GeometryAcceptanceCase[];
  repeat: number;
  variants: readonly GeometryEvaluationVariant[];
  prepareOnly: boolean;
  reviewFile?: string;
  supplementClassification?: boolean;
  /** A separately frozen manifest, used by an amendment without rebuilding its inputs. */
  frozenInputManifest?: FrozenGeometryInputManifest;
}

export interface FrozenGeometryInputManifest {
  schemaVersion: string;
  parentProtocolDigest?: string;
  protocolDigest: string;
  inputDigest: string;
  inputs: FrozenGeometryTrial[];
}

/** Builds the separately versioned concept-Slide amendment without mutating the original run. */
export async function prepareConceptSlideSupplement(input: {
  originalDirectory: string;
  outputDirectory: string;
  prepareOnly?: boolean;
}): Promise<{ manifestFile: string; protocolDigest: string; trials: number }> {
  const originalManifest = await readOptionalJson<{
    protocolDigest: string;
    inputs: FrozenGeometryTrial[];
  }>(path.join(input.originalDirectory, 'frozen-inputs.json'));
  const originalReport = await readOptionalJson<{ results?: GeometryTrialResult[] }>(
    path.join(input.originalDirectory, 'report.json'),
  );
  if (!originalManifest || !originalReport)
    throw new Error('Original frozen geometry run is required.');
  const failures = new Set(
    (originalReport.results ?? [])
      .filter(
        (r) =>
          r.trial.scenarioId === 'control-concept-slide' &&
          r.status === 'failed' &&
          r.callCount === 0,
      )
      .map((r) => r.trial.artifactId),
  );
  const source = originalManifest.inputs.filter(
    (item) =>
      item.trial.scenarioId === 'control-concept-slide' && failures.has(item.trial.artifactId),
  );
  if (source.length !== 6)
    throw new Error(
      `Amendment A requires exactly six original zero-call concept failures; found ${source.length}.`,
    );
  const classification = {
    primaryType: 'parallel_items',
    density: 'low',
    visualFocus: 'statement',
    mediaType: 'none',
  } as const;
  const inputs = source.map((item) => {
    const page = { ...item.request.page, slideClassification: classification };
    const pagedOutline = {
      ...item.request.pagedOutline,
      pages: item.request.pagedOutline.pages.map((candidate) =>
        candidate.id === page.id ? page : candidate,
      ),
    };
    return { ...item, request: { ...item.request, page, pagedOutline } };
  });
  await mkdir(input.outputDirectory, { recursive: true });
  const protocol = {
    schemaVersion: 'reach-geometry-concept-supplement/v1',
    parentProtocolDigest: originalManifest.protocolDigest,
    classification,
    trials: inputs.map(({ trial }) => trial),
  };
  const protocolDigest = acceptanceDigest(protocol);
  const inputDigest = acceptanceDigest(inputs);
  const reversible = inputs.every((item) => {
    const original = source.find(
      (candidate) => candidate.trial.artifactId === item.trial.artifactId,
    )!;
    const strip = (page: PageOutline) => {
      const { slideClassification: _removed, ...rest } = page;
      return rest;
    };
    return (
      acceptanceDigest(strip(original.request.page)) ===
        acceptanceDigest(strip(item.request.page)) &&
      acceptanceDigest(original.request.pagedOutline.pages.map(strip)) ===
        acceptanceDigest(item.request.pagedOutline.pages.map(strip))
    );
  });
  if (!reversible) throw new Error('Amendment A byte reversibility proof failed.');
  const manifestFile = path.join(input.outputDirectory, 'frozen-inputs.json');
  await writeJson(manifestFile, {
    schemaVersion: 'reach-geometry-concept-supplement-inputs/v1',
    parentProtocolDigest: originalManifest.protocolDigest,
    protocolDigest,
    inputDigest,
    inputs,
    preparedAt: new Date().toISOString(),
  });
  await writeJson(path.join(input.outputDirectory, 'provenance.json'), {
    parentDirectory: path.resolve(input.originalDirectory),
    parentProtocolDigest: originalManifest.protocolDigest,
    parentConceptFailures: [...failures],
    byteReversible: reversible,
    amendment: classification,
  });
  return { manifestFile, protocolDigest, trials: inputs.length };
}

/** Executes the amendment matrix using the same bounded pipeline; callers must opt in explicitly. */
export async function runConceptSlideSupplement(
  input: Parameters<typeof prepareConceptSlideSupplement>[0] & {
    env: ReachDeckModelEnv;
    smoke?: boolean;
    dependencies?: Parameters<typeof runGeometryAcceptance>[2];
  },
): Promise<Record<string, unknown>> {
  const prepared = await prepareConceptSlideSupplement(input);
  if (input.prepareOnly !== false) return prepared as unknown as Record<string, unknown>;
  const frozen = await readOptionalJson<FrozenGeometryInputManifest>(prepared.manifestFile);
  if (!frozen)
    throw new Error('Prepared concept supplement manifest disappeared before execution.');
  if (acceptanceDigest(frozen.inputs) !== frozen.inputDigest)
    throw new Error('Prepared concept supplement inputs were modified; refusing to execute.');
  const options = parseInteractiveScienceKitAcceptanceOptions(
    [
      '--suite',
      'geometry',
      '--scenarios',
      'control-concept-slide',
      '--variants',
      'baseline,candidate',
      '--repeat',
      '3',
      '--output-dir',
      input.outputDirectory,
    ],
    input.env,
  );
  return runGeometryAcceptance(
    {
      ...options,
      smoke: input.smoke ?? false,
      geometry: {
        ...options.geometry!,
        supplementClassification: true,
        frozenInputManifest: frozen,
      },
    },
    input.env,
    input.dependencies,
  );
}

const optionValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
};

export const parseInteractiveScienceKitAcceptanceOptions = (
  argv: readonly string[],
  env: ReachDeckModelEnv,
): CliOptions => {
  const suite = optionValue(argv, '--suite') ?? 'science-kits';
  if (suite !== 'science-kits' && suite !== 'geometry')
    throw new Error('--suite must be science-kits or geometry.');
  if (suite === 'geometry' && (argv.includes('--kits') || argv.includes('--merge-documents')))
    throw new Error('--suite geometry cannot be combined with --kits or --merge-documents.');
  if (
    suite !== 'geometry' &&
    ['--scenarios', '--repeat', '--variants', '--prepare-only', '--review-file'].some((option) =>
      argv.includes(option),
    )
  )
    throw new Error('Geometry matrix options require --suite geometry.');
  let geometry: GeometryEvaluationOptions | undefined;
  if (suite === 'geometry') {
    const requestedScenarios = optionValue(argv, '--scenarios')
      ?.split(',')
      .map((value) => value.trim());
    const requestedVariants = optionValue(argv, '--variants')
      ?.split(',')
      .map((value) => value.trim()) ?? [...GEOMETRY_EVALUATION_VARIANTS];
    if (
      requestedScenarios?.some(
        (id) => !GEOMETRY_ACCEPTANCE_CASES.some((scenario) => scenario.scenarioId === id),
      )
    )
      throw new Error('--scenarios contains an unknown geometry scenario.');
    if (
      !requestedVariants.length ||
      requestedVariants.some(
        (value) => !GEOMETRY_EVALUATION_VARIANTS.includes(value as GeometryEvaluationVariant),
      ) ||
      new Set(requestedVariants).size !== requestedVariants.length
    )
      throw new Error(
        '--variants must contain distinct baseline,candidate,candidate-no-examples values.',
      );
    geometry = {
      cases: GEOMETRY_ACCEPTANCE_CASES.filter(
        (scenario) =>
          requestedScenarios === undefined || requestedScenarios.includes(scenario.scenarioId),
      ),
      repeat: Number(optionValue(argv, '--repeat') ?? 3),
      variants: requestedVariants as GeometryEvaluationVariant[],
      prepareOnly: argv.includes('--prepare-only'),
      ...(optionValue(argv, '--review-file') === undefined
        ? {}
        : {
            reviewFile: resolveTemporaryOutputDirectory(
              optionValue(argv, '--review-file')!,
              'The independent review file',
            ),
          }),
    };
    if (!createGeometryEvaluationTrials(geometry.cases, geometry.repeat, geometry.variants).length)
      throw new Error('The selected matrix contains no trials.');
  }
  const mergeDocumentFiles = optionValue(argv, '--merge-documents')
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (mergeDocumentFiles !== undefined && mergeDocumentFiles.length < 2) {
    throw new Error('--merge-documents requires at least two comma-separated document files.');
  }
  if (mergeDocumentFiles !== undefined && argv.includes('--kits')) {
    throw new Error('--merge-documents and --kits are mutually exclusive.');
  }
  const requested = optionValue(argv, '--kits')
    ?.split(',')
    .map((value) => value.trim());
  const known = new Set(INTERACTIVE_SCIENCE_KIT_ACCEPTANCE_CASES.map(({ kitId }) => kitId));
  if (requested?.some((kitId) => !known.has(kitId as InteractiveScienceKitId))) {
    throw new Error(
      `--kits contains an unknown kit id. Expected one of: ${[...known].join(', ')}.`,
    );
  }
  const requestedSet = requested === undefined ? undefined : new Set(requested);
  const scenarios = INTERACTIVE_SCIENCE_KIT_ACCEPTANCE_CASES.filter(
    ({ kitId }) => requestedSet === undefined || requestedSet.has(kitId),
  );
  if (scenarios.length === 0) throw new Error('--kits must select at least one kit.');
  return {
    ...(mergeDocumentFiles === undefined ? {} : { mergeDocumentFiles }),
    model: optionValue(argv, '--model') ?? env.REACH_DECK_E2E_MODEL ?? DEFAULT_MODEL,
    outputDirectory: resolveTemporaryOutputDirectory(
      optionValue(argv, '--output-dir') ??
        (geometry ? 'tmp/reach-deck-geometry-evaluation' : DEFAULT_OUTPUT_DIRECTORY),
    ),
    scenarios,
    smoke: !argv.includes('--skip-smoke'),
    ...(geometry ? { geometry } : {}),
  };
};

const writeJson = (file: string, value: unknown): Promise<void> =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const lessonPlan = parseLessonPlanValue({
  id: 'interactive-science-kit-acceptance-plan',
  title: '自然科学交互表示验收',
  audience: '中学自然科学学习者',
  durationMinutes: 45,
  learningObjectives: ['通过直接操作科学表示，观察状态变化、空间关系与保持不变的关系。'],
  teachingStrategy: '每页聚焦一个可重复操作，以即时视觉结果支持比较和解释。',
  keyTerms: ['变量', '关系', '结构', '坐标', '不变量'],
  narrative: '从二维关系、动态系统与结构表示逐步过渡到三维、地理和序列空间。',
  assessmentPlan: '以学习者的有效操作与观察到的关系作为形成性证据。',
});

const outlinePage = (scenario: ScienceKitAcceptanceCase, order: number): PageOutline => ({
  id: `science-kit-${scenario.kitId}`,
  order,
  sceneType: 'interactive',
  title: scenario.title,
  estimatedDurationMinutes: 5,
  instructionalSpec: {
    learningObjective: scenario.learningObjective,
    teachingMove: 'explore',
    keyPoints: [...scenario.keyPoints],
    visualDirection: scenario.visualDirection,
    density: 'low',
    visualAssets: [],
    ...(scenario.assessmentEvidence === undefined
      ? {}
      : { assessmentEvidence: scenario.assessmentEvidence }),
  },
  interactionBrief: {
    learnerAction: scenario.learnerAction,
    experienceGoal: scenario.experienceGoal,
    approachHints: [...scenario.approachHints],
  },
});

const extractExpectedKit = (html: string, scenario: ScienceKitAcceptanceCase) => {
  const parser = new Window({
    settings: {
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      enableImageFileLoading: false,
      enableJavaScriptEvaluation: false,
    },
  });
  const document = new parser.DOMParser().parseFromString(html, 'text/html');
  const markers = [
    ...document.querySelectorAll('script[type="application/json"][data-reach-science-kit]'),
  ];
  if (markers.length !== 1)
    throw new Error(`Expected exactly one science kit marker, got ${markers.length}.`);
  const marker = markers[0]!;
  const instanceId = marker.getAttribute('data-reach-science-kit')?.trim();
  if (!instanceId) throw new Error('Science kit marker has no instance id.');
  const envelope = parseInteractiveScienceKitEnvelopeValue(JSON.parse(marker.textContent ?? ''));
  if (envelope.kitId !== scenario.kitId) {
    throw new Error(
      `Expected model to select ${scenario.kitId}, but it selected ${envelope.kitId}.`,
    );
  }
  const targets = [...document.querySelectorAll('[data-reach-science-kit-target]')].filter(
    (candidate) => candidate.getAttribute('data-reach-science-kit-target') === instanceId,
  );
  if (targets.length !== 1)
    throw new Error(`Expected exactly one matching target for ${instanceId}.`);
  const records = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null && !Array.isArray(item),
        )
      : [];
  if (scenario.kitId === 'mechanics-2d') {
    const hasRestitutionControl = records(envelope.spec.parameters).some((parameter) => {
      const target = parameter.target;
      return (
        typeof target === 'object' &&
        target !== null &&
        !Array.isArray(target) &&
        (target as Record<string, unknown>).kind === 'body-restitution'
      );
    });
    if (!hasRestitutionControl) {
      throw new Error('Mechanics acceptance requires a body-restitution parameter.');
    }
  }
  if (scenario.kitId === 'dynamic-geometry') {
    const kinds = new Set(records(envelope.spec.constructions).map(({ kind }) => kind));
    if (!kinds.has('segment') || !kinds.has('midpoint')) {
      throw new Error('Dynamic geometry acceptance requires segment and midpoint constructions.');
    }
  }
  if (scenario.requiresStateRestore === true) {
    const authorScripts = [...document.querySelectorAll('script:not([type="application/json"])')]
      .map((script) => script.textContent ?? '')
      .join('\n');
    if (!authorScripts.includes('reach-science-kit-change')) {
      throw new Error('Stateful acceptance must consume reach-science-kit-change.');
    }
    if (
      !authorScripts.includes('ReachScienceKits.getState') ||
      !authorScripts.includes('ReachScienceKits.setState')
    ) {
      throw new Error('Stateful acceptance must snapshot and restore the mounted science kit.');
    }
    const setStateAssignment = authorScripts.match(
      /\b([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?ReachScienceKits\.setState\s*\(/,
    );
    if (setStateAssignment === null) {
      throw new Error('Stateful acceptance must retain the boolean result from kit setState.');
    }
  }
  return { envelope, instanceId };
};

const assembleDocument = (
  runId: string,
  artifacts: readonly GeneratedSceneArtifact[],
): ReachDeckDocumentV2 => {
  const theme = resolveDeckTheme('Reach');
  const compiled = artifacts
    .filter((artifact) => artifact.sceneType === 'slide')
    .map((artifact) => ({
      pageId: artifact.pageId,
      result: isNativeSlideArtifact(artifact)
        ? { slide: artifact.nativeSlide, resources: artifact.resources, diagnostics: [] }
        : compileDeckSlideToNativeV2({
            slide: artifact.scene,
            theme,
            duration: artifact.scene.duration,
          }),
    }));
  const generatedAt = new Date().toISOString();
  return parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: `interactive-science-kit-acceptance-${runId}`,
    title: '真实模型生成的自然科学 Interactive 套件',
    stage: { width: 1600, height: 900, aspectRatio: '16:9' },
    theme,
    defaultThemeId: 'interactive-science-kit-theme',
    resources: {
      themes: [
        {
          id: 'interactive-science-kit-theme',
          name: theme.name,
          colors: {
            background: theme.background,
            surface: theme.surface,
            ink: theme.ink,
            muted: theme.muted,
            accent: theme.accent,
            success: theme.success,
            warning: theme.warning,
          },
          fonts: { display: theme.fontDisplay, body: theme.fontBody },
        },
        ...[
          ...new Map(
            compiled
              .flatMap(({ result }) => result.resources.themes)
              .map((resource) => [resource.id, resource]),
          ).values(),
        ],
      ],
      masters: [],
      layouts: [],
      media: [
        ...new Map(
          compiled
            .flatMap(({ result }) => result.resources.media)
            .map((resource) => [resource.id, resource]),
        ).values(),
      ],
    },
    metadata: {
      source: 'api',
      language: 'zh-CN',
      generatedAt,
      contentDigest: createHash('sha256')
        .update(
          JSON.stringify(
            artifacts.map((artifact) =>
              isNativeSlideArtifact(artifact) ? artifact.nativeSlide : artifact.scene,
            ),
          ),
        )
        .digest('hex'),
    },
    revisions: [
      {
        id: `offline-${runId}`,
        label: 'Interactive science kit acceptance',
        author: 'ai',
        createdAt: generatedAt,
        summary: `Generated ${artifacts.length} Interactive science kit pages.`,
      },
    ],
    pages: artifacts.map((artifact, index) => ({
      pageId: artifact.pageId,
      order: index + 1,
      revision: 1,
      sceneType: artifact.sceneType,
      title: isNativeSlideArtifact(artifact) ? artifact.nativeSlide.title : artifact.scene.title,
      ...(artifact.sceneType === 'slide' ? {} : { scene: artifact.scene }),
    })),
    nativeSlides: compiled.map(({ pageId, result }) => ({ pageId, slide: result.slide })),
  });
};

export const mergeInteractiveScienceKitDocuments = (
  runId: string,
  documents: readonly ReachDeckDocumentV2[],
): { document: ReachDeckDocumentV2; overlaidPageIds: string[] } => {
  if (documents.length < 2) throw new Error('At least two documents are required for merge mode.');
  for (const document of documents) {
    if (document.resources.media.length > 0) {
      throw new Error(
        `Merge input ${document.id} declares media; resource merging is unsupported.`,
      );
    }
  }
  const [base, ...overlays] = documents;
  const basePageIds = new Set(base!.pages.map(({ pageId }) => pageId));
  const replacements = new Map<string, ReachDeckDocumentV2['pages'][number]>();
  for (const overlay of overlays) {
    for (const page of overlay.pages) {
      if (!basePageIds.has(page.pageId)) {
        throw new Error(`Merge overlay ${overlay.id} contains unknown pageId ${page.pageId}.`);
      }
      replacements.set(page.pageId, page);
    }
  }
  const pages = base!.pages.map((page, index) => ({
    ...(replacements.get(page.pageId) ?? page),
    order: index + 1,
  }));
  const overlaidPageIds = base!.pages
    .filter(({ pageId }) => replacements.has(pageId))
    .map(({ pageId }) => pageId);
  const generatedAt = new Date().toISOString();
  return {
    document: parseReachDeckDocumentV2({
      ...base,
      id: `${base!.id}-merged-${runId}`,
      metadata: {
        ...base!.metadata,
        generatedAt,
        contentDigest: createHash('sha256').update(JSON.stringify(pages)).digest('hex'),
      },
      revisions: [
        ...base!.revisions,
        {
          id: `merge-${runId}`,
          label: 'Interactive science kit acceptance merge',
          author: 'ai',
          createdAt: generatedAt,
          summary: `Replaced ${overlaidPageIds.length} page(s) from ${overlays.length} overlay document(s).`,
        },
      ],
      pages,
      nativeSlides: base!.nativeSlides.filter(({ pageId }) => !replacements.has(pageId)),
    }),
    overlaidPageIds,
  };
};

const runMergeAcceptance = async (
  options: CliOptions & { mergeDocumentFiles: readonly string[] },
): Promise<void> => {
  await rm(options.outputDirectory, { recursive: true, force: true });
  await mkdir(options.outputDirectory, { recursive: true });
  const runId = randomUUID();
  const documents = await Promise.all(
    options.mergeDocumentFiles.map((file) => loadStrictReachDeckDocument(file)),
  );
  const merged = mergeInteractiveScienceKitDocuments(runId, documents);
  const documentFile = path.join(options.outputDirectory, 'document.json');
  const playerDirectory = path.join(options.outputDirectory, 'player');
  await writeJson(documentFile, merged.document);
  const prepared = await prepareReachDeckPlayerHarness({
    assetsByResourceId: new Map(),
    document: merged.document,
    outputDirectory: playerDirectory,
    source: 'document-file',
    timingSource: 'document',
    validatesTtsAlignment: false,
  });
  let smokeStatus: 'passed' | 'failed' | 'skipped' = options.smoke ? 'failed' : 'skipped';
  let smokeError: string | undefined;
  if (options.smoke) {
    const local = await startReachDeckPlayerHarnessServer(playerDirectory);
    try {
      await runReachDeckPlayerHarnessSmoke(prepared, local.origin);
      smokeStatus = 'passed';
    } catch (error) {
      smokeError = error instanceof Error ? error.message : String(error);
    } finally {
      await local.close();
    }
  }
  const report = {
    schemaVersion: 'reach-interactive-science-kit-acceptance/v1',
    mode: 'merge',
    runId,
    generatedAt: new Date().toISOString(),
    inputDocuments: options.mergeDocumentFiles,
    overlaidPageIds: merged.overlaidPageIds,
    pageIds: merged.document.pages.map(({ pageId }) => pageId),
    smokeStatus,
    ...(smokeError === undefined ? {} : { smokeError }),
  };
  await writeJson(path.join(options.outputDirectory, 'report.json'), report);
  if (smokeStatus === 'failed') {
    throw new Error(`Interactive science-kit merge smoke failed: ${smokeError ?? 'unknown error'}`);
  }
  console.log(`Acceptance report: ${path.join(options.outputDirectory, 'report.json')}`);
};

interface FrozenGeometryTrial {
  trial: GeometryEvaluationTrial;
  scenario: GeometryAcceptanceCase;
  request: PageGenerationRequest;
  context: ReachDeckModelRequestContext;
  scientificContextSnapshot?: ScientificContextSnapshot;
}
export interface GeometryTrialResult {
  trial: GeometryEvaluationTrial;
  status: 'passed' | 'failed' | 'review-required' | 'interrupted';
  initialPassed: boolean;
  initialStructurePassed?: boolean;
  durationMs: number;
  diagnostics: ReachDeckProviderOutputDiagnostic[];
  usage: ReachDeckModelUsage[];
  providerMetadata: ProviderMetadata[];
  callCount: number;
  semantics?: GeometrySemanticEvidence;
  artifact?: GeneratedSceneArtifact;
  error?: string;
}
export interface GeometryIndependentReview {
  schemaVersion: 'reach-geometry-evaluation-review/v1';
  protocolDigest: string;
  reviewer: string;
  providerVersionLimitationAcknowledged: true;
  entries: Array<{
    artifactId: string;
    artifactDigest: string;
    semanticPassed: boolean;
    mathPassed: boolean;
    interactionPassed: boolean;
    copying: 'original' | 'acceptable-reuse' | 'copied';
    layoutOrganization: string;
    evidence: string[];
  }>;
}

export interface AmendedGeometryAggregate {
  schemaVersion: 'reach-geometry-evaluation-amended/v1';
  amendmentId: 'concept-slide-classification-v1';
  amendedEvaluation: true;
  originalEvaluationAccepted: false;
  originalProtocolDigest: string;
  supplementProtocolDigest: string;
  originalInputDigest: string;
  supplementInputDigest: string;
  supplementPerCallDeadlineMs: 600_000;
  crossRunTimingLimitation: string;
  replacedArtifactIds: string[];
  retainedOriginalResults: number;
  supplementResults: number;
  supplementUsableResults: number;
  supplementFailedResults: number;
  supplementBrowserEvidence: { captured: number; expectedForUsable: number };
  baselineConceptOriginal: { usable: number; failed: number; failureArtifactIds: string[] };
  supportedCandidate: {
    gatePassed: number;
    usableStatus: number;
    failed: number;
    browserPassed: number;
    browserFailed: number;
    pendingIndependentReview: number;
    pendingBrowserEvidence: number;
    denominator: 27;
  };
  controls: {
    gatePassed: number;
    usableStatus: number;
    failed: number;
    browserPassed: number;
    browserFailed: number;
    pendingIndependentReview: number;
    pendingBrowserEvidence: number;
    denominator: 9;
  };
  provider: ReturnType<typeof summarizeAcceptanceProviderMetadata>;
  releaseGate: {
    accepted: false;
    reason: string;
  };
}

/**
 * Combines only the six proved zero-call concept setup failures with their separately frozen
 * supplement. The original report remains authoritative and is carried in provenance.
 */
export function buildAmendedGeometryAggregate(input: {
  originalManifest: { protocolDigest: string; inputDigest: string; inputs: FrozenGeometryTrial[] };
  originalReport: {
    protocolDigest: string;
    releaseGate?: { accepted?: boolean };
    results: GeometryTrialResult[];
  };
  supplementManifest: {
    parentProtocolDigest?: string;
    protocolDigest: string;
    inputDigest: string;
    inputs: FrozenGeometryTrial[];
  };
  supplementReport: {
    protocolDigest: string;
    results: GeometryTrialResult[];
    browserEvidence?: GeometryAcceptanceBrowserEvidence[];
  };
  independentReview?: GeometryIndependentReview;
  independentReviews?: GeometryIndependentReview[];
  browserEvidence?: GeometryAcceptanceBrowserEvidence[];
}): AmendedGeometryAggregate {
  const replacements = input.originalReport.results.filter(
    (result) =>
      result.trial.scenarioId === 'control-concept-slide' &&
      result.status === 'failed' &&
      result.callCount === 0,
  );
  if (replacements.length !== 6)
    throw new Error('Amendment A can replace exactly six original zero-call concept failures.');
  if (input.supplementManifest.parentProtocolDigest !== input.originalManifest.protocolDigest)
    throw new Error('Amendment A parent protocol digest does not match the original run.');
  if (input.supplementReport.protocolDigest !== input.supplementManifest.protocolDigest)
    throw new Error('Amendment A report is not bound to its frozen supplement protocol.');
  if (acceptanceDigest(input.supplementManifest.inputs) !== input.supplementManifest.inputDigest)
    throw new Error('Amendment A supplement inputs were modified.');
  const replacementIds = replacements.map(({ trial }) => trial.artifactId).sort();
  const supplementIds = input.supplementReport.results.map(({ trial }) => trial.artifactId).sort();
  if (
    supplementIds.length !== 6 ||
    replacementIds.some((artifactId, index) => artifactId !== supplementIds[index])
  )
    throw new Error('Amendment A supplement must contain the exact six replacement trial ids.');
  if (input.originalReport.releaseGate?.accepted === true)
    throw new Error('Amendment A must preserve the original failed release gate.');
  const retained = input.originalReport.results.filter(
    (result) => !replacementIds.includes(result.trial.artifactId),
  );
  const merged = [...retained, ...input.supplementReport.results];
  const supplementUsable = input.supplementReport.results.filter(
    (result) => result.status === 'passed' || result.status === 'review-required',
  );
  const baselineConcept = input.originalReport.results.filter(
    (result) =>
      result.trial.scenarioId === 'control-concept-slide' &&
      result.trial.evaluationVariant === 'baseline',
  );
  const supported = merged.filter(
    (result) =>
      result.trial.evaluationVariant === 'candidate' &&
      result.trial.scenarioId !== 'control-function-plot' &&
      result.trial.scenarioId !== 'control-open-polyline-editor' &&
      result.trial.scenarioId !== 'control-concept-slide',
  );
  const supportedUsable = supported.filter(
    (result) => result.status === 'passed' || result.status === 'review-required',
  );
  const controls = merged.filter(
    (result) =>
      result.trial.evaluationVariant === 'candidate' &&
      ['control-concept-slide', 'control-function-plot', 'control-open-polyline-editor'].includes(
        result.trial.scenarioId,
      ),
  );
  const controlsUsable = controls.filter(
    (result) => result.status === 'passed' || result.status === 'review-required',
  );
  const reviewPasses = (result: GeometryTrialResult) => {
    const review = (
      input.independentReviews ?? (input.independentReview ? [input.independentReview] : [])
    )
      .flatMap(({ entries }) => entries)
      .find((entry) => entry.artifactId === result.trial.artifactId);
    const browser = input.browserEvidence
      ? input.browserEvidence.filter((entry) => entry.pageId === result.trial.pageId)
      : [];
    return (
      review?.semanticPassed === true &&
      review.mathPassed === true &&
      review.interactionPassed === true &&
      review.copying !== 'copied' &&
      browser.length === 4 &&
      browser.every((entry) => entry.status !== 'failed')
    );
  };
  const gatePassed = (items: GeometryTrialResult[]) => items.filter(reviewPasses).length;
  const pendingReview = (items: GeometryTrialResult[]) =>
    items.filter(
      (result) =>
        !(input.independentReviews ?? (input.independentReview ? [input.independentReview] : []))
          .flatMap(({ entries }) => entries)
          .some((entry) => entry.artifactId === result.trial.artifactId),
    ).length;
  const pendingBrowser = (items: GeometryTrialResult[]) =>
    items.filter(
      (result) =>
        result.status !== 'failed' &&
        result.status !== 'interrupted' &&
        (input.browserEvidence?.filter((entry) => entry.pageId === result.trial.pageId).length ??
          0) !== 4,
    ).length;
  const browserPasses = (result: GeometryTrialResult) => {
    const entries =
      input.browserEvidence?.filter((entry) => entry.pageId === result.trial.pageId) ?? [];
    return entries.length === 4 && entries.every((entry) => entry.status !== 'failed');
  };
  const browserFailed = (items: GeometryTrialResult[]) =>
    items.filter((result) => {
      const entries =
        input.browserEvidence?.filter((entry) => entry.pageId === result.trial.pageId) ?? [];
      return entries.some((entry) => entry.status === 'failed');
    }).length;
  const provider = summarizeAcceptanceProviderMetadata(
    merged.flatMap((result) => result.providerMetadata),
  );
  return {
    schemaVersion: 'reach-geometry-evaluation-amended/v1',
    amendmentId: 'concept-slide-classification-v1',
    amendedEvaluation: true,
    originalEvaluationAccepted: false,
    originalProtocolDigest: input.originalManifest.protocolDigest,
    supplementProtocolDigest: input.supplementManifest.protocolDigest,
    originalInputDigest: input.originalManifest.inputDigest,
    supplementInputDigest: input.supplementManifest.inputDigest,
    supplementPerCallDeadlineMs: 600_000,
    crossRunTimingLimitation:
      'The original 72 unaffected trials did not use the supplement explicit 600-second per-call deadline; cross-run timing is not identical.',
    replacedArtifactIds: replacementIds,
    retainedOriginalResults: retained.length,
    supplementResults: input.supplementReport.results.length,
    supplementUsableResults: supplementUsable.length,
    supplementFailedResults: input.supplementReport.results.length - supplementUsable.length,
    supplementBrowserEvidence: {
      captured: input.supplementReport.browserEvidence?.length ?? 0,
      expectedForUsable: supplementUsable.length * 4,
    },
    baselineConceptOriginal: {
      usable: baselineConcept.filter(
        (result) => result.status === 'passed' || result.status === 'review-required',
      ).length,
      failed: baselineConcept.filter(
        (result) => result.status === 'failed' || result.status === 'interrupted',
      ).length,
      failureArtifactIds: baselineConcept
        .filter((result) => result.status === 'failed' || result.status === 'interrupted')
        .map(({ trial }) => trial.artifactId),
    },
    supportedCandidate: {
      gatePassed: gatePassed(supported),
      usableStatus: supportedUsable.length,
      failed: supported.length - supportedUsable.length,
      browserPassed: supported.filter(browserPasses).length,
      browserFailed: browserFailed(supported),
      pendingIndependentReview: pendingReview(supported),
      pendingBrowserEvidence: pendingBrowser(supported),
      denominator: 27,
    },
    controls: {
      gatePassed: gatePassed(controls),
      usableStatus: controlsUsable.length,
      failed: controls.length - controlsUsable.length,
      browserPassed: controls.filter(browserPasses).length,
      browserFailed: browserFailed(controls),
      pendingIndependentReview: pendingReview(controls),
      pendingBrowserEvidence: pendingBrowser(controls),
      denominator: 9,
    },
    provider,
    releaseGate: {
      accepted: false,
      reason:
        'This is an amended evaluation; the original release gate remains failed until independent review, four-viewport evidence, layout and provider gates are recomputed.',
    },
  };
}
export function validateGeometryIndependentReview(
  value: unknown,
  protocolDigest: string,
  results: readonly GeometryTrialResult[],
): GeometryIndependentReview {
  const review = value as GeometryIndependentReview;
  if (
    review?.schemaVersion !== 'reach-geometry-evaluation-review/v1' ||
    review.protocolDigest !== protocolDigest ||
    typeof review.reviewer !== 'string' ||
    !review.reviewer.trim() ||
    review.providerVersionLimitationAcknowledged !== true ||
    !Array.isArray(review.entries)
  )
    throw new Error(
      'Independent review must match the frozen protocol and explicitly acknowledge the provider-version limitation.',
    );
  const seen = new Set<string>();
  for (const entry of review.entries) {
    const result = results.find((item) => item.trial.artifactId === entry?.artifactId);
    if (
      !result?.artifact ||
      seen.has(entry.artifactId) ||
      entry.artifactDigest !== acceptanceDigest(result.artifact) ||
      ['semanticPassed', 'mathPassed', 'interactionPassed'].some(
        (key) => typeof entry[key as 'semanticPassed'] !== 'boolean',
      ) ||
      !['original', 'acceptable-reuse', 'copied'].includes(entry.copying) ||
      typeof entry.layoutOrganization !== 'string' ||
      !entry.layoutOrganization.trim() ||
      !Array.isArray(entry.evidence) ||
      !entry.evidence.length ||
      entry.evidence.some((item) => typeof item !== 'string' || !item.trim())
    )
      throw new Error(
        'Independent review contains a missing, duplicate, modified, or unsubstantiated artifact judgment.',
      );
    seen.add(entry.artifactId);
  }
  return review;
}
export interface ProviderMetadata {
  model?: string;
  system_fingerprint?: string;
  model_revision?: string;
  model_version?: string;
}
export function readAcceptanceProviderMetadata(body: string): ProviderMetadata[] {
  const pieces = body.trimStart().startsWith('{')
    ? [body]
    : body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
  const metadata: ProviderMetadata[] = [];
  for (const piece of pieces) {
    if (!piece || piece === '[DONE]') continue;
    try {
      const value = JSON.parse(piece) as Record<string, unknown>;
      const entry = Object.fromEntries(
        ['model', 'system_fingerprint', 'model_revision', 'model_version'].flatMap((key) =>
          typeof value[key] === 'string' ? [[key, (value[key] as string).slice(0, 200)]] : [],
        ),
      );
      if (
        Object.keys(entry).length &&
        !metadata.some((previous) => JSON.stringify(previous) === JSON.stringify(entry))
      )
        metadata.push(entry);
    } catch {
      /* Malformed output is retained verbatim and rejected by the production parser. */
    }
  }
  return metadata;
}
export function summarizeAcceptanceProviderMetadata(records: readonly ProviderMetadata[]): {
  observed: ProviderMetadata[];
  drift: boolean;
  immutableRevisionVerified: false;
  limitation: string;
} {
  const observed = [...new Map(records.map((record) => [JSON.stringify(record), record])).values()];
  const drift = (['model', 'system_fingerprint', 'model_revision', 'model_version'] as const).some(
    (key) =>
      new Set(observed.map((entry) => entry[key]).filter((value) => value !== undefined)).size > 1,
  );
  return {
    observed,
    drift,
    immutableRevisionVerified: false,
    limitation:
      'Requested aliases and returned metadata are recorded; neither the catalog alias nor absent revision metadata proves an immutable provider version.',
  };
}

/** Freeze current design inputs before the classification-only amendment is prepared. */
const geometrySlideDesignContext = {
  schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
  libraryVersion: REFERENCE_LIBRARY_VERSION,
  librarySha256: REFERENCE_LIBRARY_SHA256,
  paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
  imageStyleReferenceIds: [REFERENCE_LIBRARY.imageStyles[0]!.id],
  visualIntent: '清楚紧凑的概念说明。',
  resolvedColors: REFERENCE_LIBRARY.palettes[0]!.colors,
};

export function geometryOutlinePage(
  scenario: GeometryAcceptanceCase,
  trial: GeometryEvaluationTrial,
  supplementClassification = false,
): PageOutline {
  return {
    id: trial.pageId,
    order: 1,
    sceneType: scenario.generationSceneType,
    title: scenario.title,
    estimatedDurationMinutes: 5,
    ...(scenario.generationSceneType === 'slide'
      ? {
          designIntent: {
            pageRole: 'content' as const,
            focus: scenario.title,
            informationRelationship: 'parallel_items',
            layoutReferenceIds: [],
            componentReferenceIds: [],
            imageStyleReferenceIds: [],
          },
        }
      : {}),
    instructionalSpec: {
      learningObjective: scenario.source,
      teachingMove: scenario.generationSceneType === 'slide' ? 'explain' : 'explore',
      keyPoints: [...scenario.keyPoints],
      visualDirection:
        scenario.generationSceneType === 'slide'
          ? '清楚紧凑的概念说明。'
          : '以题设对象和操作为中心，布局由教学目标决定，移动端保持可操作。',
      density: 'low',
      visualAssets: [],
    },
    ...(scenario.generationSceneType === 'interactive'
      ? {
          interactionBrief: {
            learnerAction: scenario.source,
            experienceGoal: scenario.keyPoints.join('；'),
            approachHints: [...scenario.approachHints],
          },
        }
      : supplementClassification
        ? {
            slideClassification: {
              primaryType: 'parallel_items',
              density: 'low',
              visualFocus: 'statement',
              mediaType: 'none',
            },
          }
        : {}),
  };
}
export function assembleGeometryEvaluationDocument(
  runId: string,
  artifacts: readonly GeneratedSceneArtifact[],
): ReachDeckDocumentV2 {
  const base = assembleDocument(runId, artifacts);
  return parseReachDeckDocumentV2({
    ...base,
    id: `geometry-evaluation-${runId}`,
    title: '动态几何固定生成评估',
    metadata: { ...base.metadata, contentDigest: acceptanceDigest(artifacts) },
  });
}
const readOptionalJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};
const geometryContext = (runId: string): ReachDeckModelRequestContext => ({
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  resourceScope: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    courseWorkspaceType: 'draft',
    courseNodeId: '33333333-3333-4333-8333-333333333333',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: '55555555-5555-4555-8555-555555555555',
  },
  jobId: `geometry-evaluation-${runId}`,
  runId,
});

export async function runGeometryAcceptance(
  options: CliOptions & { geometry: GeometryEvaluationOptions },
  env: ReachDeckModelEnv,
  dependencies: {
    generate?: typeof generatePageArtifactWithModelService;
    fetch?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  if (options.model !== GEOMETRY_EVALUATION_MODEL)
    throw new Error(`The frozen geometry protocol requires --model ${GEOMETRY_EVALUATION_MODEL}.`);
  const matrix = createGeometryEvaluationTrials(
    options.geometry.cases,
    options.geometry.repeat,
    options.geometry.variants,
  );
  const protocol = {
    schemaVersion: GEOMETRY_EVALUATION_VERSION,
    baselineMilestone: 'e4a886cf5',
    sharedValidationHardening: [
      'Malformed/unauthorized marker repair preserves the full original document in both variants.',
      'Narration and non-marker changes remain locked during bounded corrections; this is a P2 prompt/capability baseline, not the historical P2 binary.',
    ],
    model: options.model,
    matrix,
    cases: options.geometry.cases,
    requestSettings: {
      stream: true,
      stream_options: { include_usage: true },
      maxOutputCorrections: 1,
    },
    amendment: options.geometry.supplementClassification ? 'concept-slide-classification-v1' : null,
    slideDesignProtocol: {
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      designContext: geometrySlideDesignContext,
      referenceCoverage: REFERENCE_REGISTRY,
    },
    baselinePromptContract: {
      interactive: INTERACTIVE_PROMPT,
      slide: SLIDE_PROMPT,
      registry: buildReachDeckScientificToolCatalog({
        contexts: ['interactive'],
        scientificVisualsEnabled: false,
      }),
    },
  };
  const frozenManifest = options.geometry.frozenInputManifest;
  if (frozenManifest) {
    if (acceptanceDigest(frozenManifest.inputs) !== frozenManifest.inputDigest)
      throw new Error('Frozen supplement inputs differ from their recorded input digest.');
    const expectedIds = new Set(matrix.map((trial) => trial.artifactId));
    const actualIds = new Set(frozenManifest.inputs.map(({ trial }) => trial.artifactId));
    if (
      expectedIds.size !== actualIds.size ||
      [...expectedIds].some((artifactId) => !actualIds.has(artifactId))
    )
      throw new Error('Frozen supplement inputs do not match the requested evaluation matrix.');
  }
  const protocolDigest = frozenManifest?.protocolDigest ?? acceptanceDigest(protocol);
  const manifestFile = path.join(options.outputDirectory, 'frozen-inputs.json');
  const previous = await readOptionalJson<{
    protocolDigest: string;
    runId: string;
    inputs: FrozenGeometryTrial[];
    inputDigest: string;
  }>(manifestFile);
  if (
    previous &&
    (previous.protocolDigest !== protocolDigest ||
      acceptanceDigest(previous.inputs) !== previous.inputDigest)
  )
    throw new Error(
      'Frozen evaluation inputs differ or were modified; refusing to rerun or silently alter the protocol.',
    );
  const runId = previous?.runId ?? frozenManifest?.inputs[0]?.request.runId ?? randomUUID();
  const inputs =
    previous?.inputs ??
    frozenManifest?.inputs ??
    matrix.map((trial): FrozenGeometryTrial => {
      const scenario = options.geometry.cases.find((item) => item.scenarioId === trial.scenarioId)!;
      const pageInput = geometryOutlinePage(
        scenario,
        trial,
        options.geometry.supplementClassification,
      );
      const pagedOutline = parsePagedDeckOutlineValue({
        id: `outline-${trial.artifactId}`,
        title: scenario.title,
        themeName: 'Reach',
        pages: [pageInput],
        ...(scenario.generationSceneType === 'slide'
          ? {
              manifestVersion: REFERENCE_MANIFEST_VERSION,
              designContext: geometrySlideDesignContext,
              referenceCoverage: REFERENCE_REGISTRY,
            }
          : {}),
      });
      const page = pagedOutline.pages[0]!;
      const request: PageGenerationRequest = {
        runId,
        pageId: trial.pageId,
        requestedRevision: 1,
        attempt: 1,
        attemptReason: 'initial',
        source: scenario.source,
        lessonPlan,
        pagedOutline,
        page,
        nearbyLayoutReferenceIds: [],
        prompt:
          '满足给定教学目标和全部题设条件，自由选择适合的表示与布局。保留探索自由，不添加固定任务顺序或完成门槛，不向学生展示实现细节。',
      };
      const snapshot =
        trial.evaluationVariant === 'baseline' || scenario.generationSceneType === 'slide'
          ? undefined
          : buildScientificGenerationContext({
              stage: 'interactive',
              policy: 'candidate',
              pageIntent: page,
              approachHints: scenario.approachHints,
              teacherRequest: scenario.source,
              includeExamples: trial.evaluationVariant !== 'candidate-no-examples',
            });
      return {
        trial,
        scenario,
        request,
        context: geometryContext(runId),
        ...(snapshot === undefined ? {} : { scientificContextSnapshot: snapshot }),
      };
    });
  await mkdir(path.join(options.outputDirectory, 'trials'), { recursive: true });
  if (!previous && !frozenManifest)
    await writeJson(manifestFile, {
      ...protocol,
      protocolDigest,
      runId,
      inputs,
      inputDigest: acceptanceDigest(inputs),
      frozenAt: new Date().toISOString(),
    });
  else if (!previous && frozenManifest) {
    const existing = await readOptionalJson<FrozenGeometryInputManifest & { runId?: string }>(
      manifestFile,
    );
    if (
      existing &&
      (existing.protocolDigest !== frozenManifest.protocolDigest ||
        existing.inputDigest !== frozenManifest.inputDigest ||
        acceptanceDigest(existing.inputs) !== frozenManifest.inputDigest)
    )
      throw new Error('Existing supplement manifest differs from the prepared frozen manifest.');
    if (!existing)
      await writeJson(manifestFile, {
        ...frozenManifest,
        runId,
        executedFromPreparedManifest: true,
      });
  }
  if (options.geometry.prepareOnly)
    return { prepared: true, manifestFile, protocolDigest, trials: matrix.length, modelCalls: 0 };

  const generate = dependencies.generate ?? generatePageArtifactWithModelService;
  const directFetch = dependencies.fetch ?? createDirectLiteLlmFetch(env, options.model);
  const results: GeometryTrialResult[] = [];
  const priorReport = await readOptionalJson<{
    browserEvidence?: GeometryAcceptanceBrowserEvidence[];
  }>(path.join(options.outputDirectory, 'report.json'));
  const browserEvidence: GeometryAcceptanceBrowserEvidence[] = options.smoke
    ? []
    : [...(priorReport?.browserEvidence ?? [])];
  let smokeError: string | undefined;
  let independentReview: GeometryIndependentReview | undefined;
  const finalReport = () => {
    const provider = summarizeAcceptanceProviderMetadata(
      results.flatMap((result) => result.providerMetadata),
    );
    const reviewPasses = (result: GeometryTrialResult) => {
      const review = independentReview?.entries.find(
        (entry) => entry.artifactId === result.trial.artifactId,
      );
      return (
        (result.status === 'passed' || result.status === 'review-required') &&
        review?.semanticPassed &&
        review.mathPassed &&
        review.interactionPassed &&
        review.copying !== 'copied'
      );
    };
    const summaries = Object.fromEntries(
      options.geometry.variants.map((variant) => {
        const subset = results.filter((result) => result.trial.evaluationVariant === variant);
        return [
          variant,
          {
            trials: subset.length,
            initialPassed: subset.filter((result) => result.initialPassed).length,
            independentlyReviewedPassed: subset.filter(reviewPasses).length,
            independentlyReviewedInitialPassed: subset.filter(
              (result) => result.initialStructurePassed && reviewPasses(result),
            ).length,
            pendingIndependentReview: subset.filter(
              (result) =>
                !independentReview?.entries.some(
                  (entry) => entry.artifactId === result.trial.artifactId,
                ),
            ).length,
            initialStructurePassed: subset.filter((result) => result.initialStructurePassed).length,
            structuralAndSemanticPassed: subset.filter((result) => result.status === 'passed')
              .length,
            failed: subset.filter(
              (result) => result.status === 'failed' || result.status === 'interrupted',
            ).length,
            reviewRequired: subset.filter((result) => result.status === 'review-required').length,
            promptTokens: subset
              .flatMap((result) => result.usage)
              .reduce((sum, usage) => sum + usage.promptTokens, 0),
            completionTokens: subset
              .flatMap((result) => result.usage)
              .reduce((sum, usage) => sum + usage.completionTokens, 0),
            durationMs: subset.reduce((sum, result) => sum + result.durationMs, 0),
          },
        ];
      }),
    );
    const candidate = results.filter((result) => result.trial.evaluationVariant === 'candidate');
    const browserPasses = (result: GeometryTrialResult) => {
      const entries = browserEvidence.filter((entry) => entry.pageId === result.trial.pageId);
      return entries.length === 4 && entries.every((entry) => entry.status !== 'failed');
    };
    const accepted = candidate.filter(
      (result) =>
        (result.status === 'passed' || result.status === 'review-required') &&
        reviewPasses(result) &&
        browserPasses(result) &&
        options.geometry.cases.find((scenario) => scenario.scenarioId === result.trial.scenarioId)
          ?.category !== 'control',
    ).length;
    const controls = candidate.filter(
      (result) =>
        options.geometry.cases.find((scenario) => scenario.scenarioId === result.trial.scenarioId)
          ?.category === 'control',
    );
    const controlsPassed = controls.filter(
      (result) =>
        (result.status === 'passed' || result.status === 'review-required') &&
        reviewPasses(result) &&
        browserPasses(result),
    ).length;
    const layouts = new Set(
      candidate
        .filter(
          (result) =>
            reviewPasses(result) &&
            options.geometry.cases.find(
              (scenario) => scenario.scenarioId === result.trial.scenarioId,
            )?.category !== 'control',
        )
        .map(
          (result) =>
            independentReview!.entries.find(
              (entry) => entry.artifactId === result.trial.artifactId,
            )!.layoutOrganization,
        ),
    );
    const completeMatrix =
      matrix.length === 78 &&
      options.geometry.repeat === 3 &&
      results.length === 78 &&
      options.geometry.cases.length === 12 &&
      options.geometry.variants.length === 3;
    return {
      schemaVersion: GEOMETRY_EVALUATION_VERSION,
      runId,
      protocolDigest,
      model: options.model,
      ...(options.geometry.supplementClassification
        ? {
            amendment: {
              amendmentId: 'concept-slide-classification-v1',
              parentProtocolDigest: frozenManifest?.parentProtocolDigest,
              frozenInputDigest: frozenManifest?.inputDigest,
              perCallDeadlineMs: 600_000,
              deadline: 'AbortSignal.timeout(600000) applied to every model call.',
              limitation:
                'The original 72 unaffected trials did not use this explicit per-call deadline; cross-run timing is therefore not identical.',
            },
          }
        : {}),
      provider,
      summaries,
      sharedValidationHardening: protocol.sharedValidationHardening,
      results,
      browserEvidence,
      independentReview,
      smokeError,
      releaseGate: options.geometry.supplementClassification
        ? {
            scope: 'supplemental-concept-slide',
            candidateTrials: results.filter(
              (result) => result.trial.evaluationVariant === 'candidate',
            ).length,
            candidateUsable: results.filter(
              (result) =>
                result.trial.evaluationVariant === 'candidate' &&
                result.status !== 'failed' &&
                result.status !== 'interrupted',
            ).length,
            originalGateReportedSeparately: true,
            accepted: false,
            reason:
              'Supplemental concept-Slide results are reported separately; the original 78-trial release gate is not replaced by this six-trial run.',
          }
        : {
            supportedCandidatePassed: accepted,
            supportedRequired: 24,
            controlsPassed,
            controlsRequired: 9,
            layoutOrganizations: [...layouts],
            completeMatrix,
            accepted:
              completeMatrix &&
              accepted >= 24 &&
              controlsPassed === 9 &&
              layouts.size >= 3 &&
              !provider.drift &&
              !smokeError,
            reason:
              'Acceptance requires the complete frozen matrix, 24/27 supported candidates, all nine controls, three reviewed layout organizations, and no observed provider metadata drift.',
          },
      limitations: [
        'Provider prices are not inferred from tokens; authoritative cost is unavailable in this direct offline route.',
        'Alternative legacy/custom representations are review-required, not rejected for choosing no new geometry kit.',
        'Browser screenshots cannot replace independent mathematical checks.',
      ],
    };
  };
  try {
    for (const input of inputs) {
      const directory = path.join(options.outputDirectory, 'trials', input.trial.artifactId);
      await mkdir(directory, { recursive: true });
      const resultFile = path.join(directory, 'result.json');
      const saved = await readOptionalJson<GeometryTrialResult>(resultFile);
      if (saved) {
        if (acceptanceDigest(saved.trial) !== acceptanceDigest(input.trial))
          throw new Error('Saved trial identity differs from frozen matrix.');
        results.push(saved);
        continue;
      }
      const result: GeometryTrialResult = {
        trial: input.trial,
        status: 'failed',
        initialPassed: false,
        durationMs: 0,
        diagnostics: [],
        usage: [],
        providerMetadata: [],
        callCount: 0,
      };
      const startedFile = path.join(directory, 'dispatch-started.json');
      if (await readOptionalJson(startedFile)) {
        result.status = 'interrupted';
        result.error =
          'A previous dispatch was interrupted; this fixed trial is retained without another model call.';
        results.push(result);
        await writeJson(resultFile, result);
        continue;
      }
      await writeJson(startedFile, {
        trial: input.trial,
        inputDigest: acceptanceDigest(input),
        startedAt: new Date().toISOString(),
      });
      const started = Date.now(),
        pendingEvidence: Promise<void>[] = [];
      const fetchRecorded: typeof fetch = async (target, init) => {
        const callIndex = ++result.callCount;
        await writeFile(
          path.join(directory, `request-${callIndex}.json`),
          typeof init?.body === 'string' ? init.body : '',
          'utf8',
        );
        const deadline = AbortSignal.timeout(600_000);
        const response = await directFetch(target, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
        });
        const capture = response
          .clone()
          .text()
          .then(async (body) => {
            result.providerMetadata.push(...readAcceptanceProviderMetadata(body));
            await writeFile(path.join(directory, `response-${callIndex}.txt`), body, 'utf8');
          });
        void capture.catch(() => undefined);
        pendingEvidence.push(capture);
        return response;
      };
      try {
        result.artifact = await generate(input.request, {
          context: input.context,
          env,
          fetch: fetchRecorded,
          scientificCapabilityPolicy:
            input.trial.evaluationVariant === 'baseline' ? 'legacy' : 'candidate',
          scientificContextSnapshot: input.scientificContextSnapshot,
          onOutputDiagnostic: (diagnostic) => {
            result.diagnostics.push(diagnostic);
          },
          onUsage: (usage) => {
            result.usage.push(usage);
          },
          onModelPayload: async (payload) => {
            await writeFile(
              path.join(directory, `model-payload-${result.callCount + 1}.json`),
              payload.serializedModelInput,
              'utf8',
            );
          },
          validateInteractiveScene: (scene) => {
            try {
              result.semantics = validateGeometryAcceptanceScene(scene, input.scenario);
            } catch (error) {
              if (error instanceof GeometryAcceptanceSemanticError)
                throw new GeometryGenerationSemanticError(error.message, error.instanceIds);
              throw error;
            }
          },
        });
        if (
          !input.scenario.expectedSceneTypes.includes(
            result.artifact.sceneType as 'slide' | 'interactive',
          )
        )
          throw new Error('Generated scene type violates the frozen case.');
        if (
          result.artifact.pageId !== input.trial.pageId ||
          (isNativeSlideArtifact(result.artifact)
            ? result.artifact.nativeSlide.id
            : result.artifact.scene.id) !== input.trial.sceneId
        )
          throw new Error('Generated artifact identity differs from frozen trial.');
        if (result.artifact.sceneType === 'interactive')
          result.semantics = validateGeometryAcceptanceScene(result.artifact.scene, input.scenario);
        result.status = result.semantics?.status === 'passed' ? 'passed' : 'review-required';
        result.initialStructurePassed = !result.diagnostics.some(
          (diagnostic) => diagnostic.type === 'output-correction',
        );
        result.initialPassed = result.initialStructurePassed && result.status === 'passed';
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      } finally {
        const evidenceResults = await Promise.allSettled(pendingEvidence);
        if (evidenceResults.some((entry) => entry.status === 'rejected')) {
          result.status = 'failed';
          result.error = `${result.error ?? ''} Provider evidence capture failed.`;
        }
        result.durationMs = Date.now() - started;
        results.push(result);
        await writeJson(resultFile, result);
        await writeJson(path.join(options.outputDirectory, 'report.json'), finalReport());
      }
    }
    const usable = results.filter(
      (result) =>
        result.artifact && (result.status === 'passed' || result.status === 'review-required'),
    );
    if (usable.length) {
      const document = assembleGeometryEvaluationDocument(
        runId,
        usable.map((result) => result.artifact!),
      );
      await writeJson(path.join(options.outputDirectory, 'document.json'), document);
      const prepared = await prepareReachDeckPlayerHarness({
        assetsByResourceId: new Map(),
        document,
        outputDirectory: path.join(options.outputDirectory, 'player'),
        source: 'cloud-generation',
        timingSource: 'document',
        validatesTtsAlignment: false,
      });
      if (options.smoke) {
        const local = await startReachDeckPlayerHarnessServer(prepared.outputDirectory);
        try {
          browserEvidence.push(
            ...(await runGeometryAcceptanceSmoke(
              prepared,
              local.origin,
              Object.fromEntries(
                usable.map((result) => [
                  result.trial.pageId,
                  options.geometry.cases.find(
                    (scenario) => scenario.scenarioId === result.trial.scenarioId,
                  )!,
                ]),
              ),
            )),
          );
        } finally {
          await local.close();
        }
      }
    }
    if (options.geometry.reviewFile)
      independentReview = validateGeometryIndependentReview(
        await readOptionalJson(options.geometry.reviewFile),
        protocolDigest,
        results,
      );
  } catch (error) {
    smokeError = error instanceof Error ? error.message : String(error);
  } finally {
    await writeJson(path.join(options.outputDirectory, 'report.json'), finalReport());
  }
  return finalReport();
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const env: ReachDeckModelEnv = process.env;
  if (argv.includes('--supplement-concept')) {
    const outputDirectory = resolveTemporaryOutputDirectory(
      optionValue(argv, '--output-dir') ?? 'tmp/reach-deck-geometry-concept-supplement',
    );
    const originalDirectory = resolveTemporaryOutputDirectory(
      optionValue(argv, '--original-dir') ?? 'tmp/reach-deck-geometry-p3-evaluation-20260907',
    );
    const result = argv.includes('--prepare-only')
      ? await prepareConceptSlideSupplement({
          originalDirectory,
          outputDirectory,
          prepareOnly: true,
        })
      : await runConceptSlideSupplement({
          originalDirectory,
          outputDirectory,
          prepareOnly: false,
          smoke: !argv.includes('--skip-smoke'),
          env,
        });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const options = parseInteractiveScienceKitAcceptanceOptions(argv, env);
  if (options.geometry) {
    const report = await runGeometryAcceptance({ ...options, geometry: options.geometry }, env);
    console.log(
      JSON.stringify(
        report.prepared
          ? report
          : {
              reportFile: path.join(options.outputDirectory, 'report.json'),
              releaseGate: report.releaseGate,
            },
        null,
        2,
      ),
    );
    if (!report.prepared && !(report.releaseGate as { accepted: boolean }).accepted)
      process.exitCode = 1;
    return;
  }
  if (options.mergeDocumentFiles !== undefined) {
    await runMergeAcceptance({ ...options, mergeDocumentFiles: options.mergeDocumentFiles });
    return;
  }
  const directFetch = createDirectLiteLlmFetch(env, options.model);
  await rm(options.outputDirectory, { recursive: true, force: true });
  await mkdir(path.join(options.outputDirectory, 'pages'), { recursive: true });
  const runId = randomUUID();
  const pagedOutline = parsePagedDeckOutlineValue({
    id: `interactive-science-kit-outline-${runId}`,
    title: '自然科学交互套件验收',
    themeName: 'Reach',
    pages: options.scenarios.map((scenario, index) => outlinePage(scenario, index + 1)),
  });
  const source = options.scenarios
    .map((scenario) => `${scenario.title}\n${scenario.source}`)
    .join('\n\n');
  const context: ReachDeckModelRequestContext = {
    actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    billingGroupId: null,
    resourceScope: {
      organizationId: '11111111-1111-4111-8111-111111111111',
      courseId: '22222222-2222-4222-8222-222222222222',
      courseWorkspaceType: 'draft',
      courseNodeId: '33333333-3333-4333-8333-333333333333',
      moduleId: '44444444-4444-4444-8444-444444444444',
      moduleVersionId: '55555555-5555-4555-8555-555555555555',
    },
    jobId: `interactive-science-kit-acceptance-${runId}`,
    runId,
  };
  const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
  const pipelineOptions = {
    context,
    env,
    fetch: directFetch,
    onOutputDiagnostic: (diagnostic: ReachDeckProviderOutputDiagnostic) => {
      diagnostics.push(diagnostic);
    },
  };
  const artifacts: Extract<GeneratedSceneArtifact, { sceneType: 'interactive' }>[] = [];
  const cases: Array<Record<string, unknown>> = [];

  await Promise.all([
    writeJson(path.join(options.outputDirectory, 'lesson-plan.json'), lessonPlan),
    writeJson(path.join(options.outputDirectory, 'paged-outline.json'), pagedOutline),
  ]);
  console.log(
    `Generating ${options.scenarios.length} Interactive science-kit cases with ${options.model}`,
  );
  for (const [index, scenario] of options.scenarios.entries()) {
    const page = pagedOutline.pages[index]!;
    const started = Date.now();
    let generatedArtifact:
      | Extract<GeneratedSceneArtifact, { sceneType: 'interactive' }>
      | undefined;
    try {
      const artifact = await generatePageArtifactWithModelService(
        {
          runId,
          pageId: page.id,
          requestedRevision: 1,
          attempt: 1,
          attemptReason: 'initial',
          source,
          lessonPlan,
          pagedOutline,
          page,
          nearbyLayoutReferenceIds: [],
          prompt:
            'This is a capability acceptance case. Select exactly one semantically fitting specialized built-in science kit from scientificToolRegistry. Every control or dependent construction required by the learner action must be represented in that typed kit spec, not merely drawn as disconnected HTML. Do not use the custom interactive document fallback for the primary representation, do not combine kits, and do not mention runtime implementation details to the learner.',
        },
        pipelineOptions,
      );
      if (artifact.sceneType !== 'interactive')
        throw new Error('Generated artifact is not Interactive.');
      generatedArtifact = artifact;
      const marker = extractExpectedKit(artifact.scene.documentHtml, scenario);
      if (artifact.scene.runtimePolicy.completionMode !== 'none') {
        throw new Error('Science-kit exploration acceptance requires completionMode none.');
      }
      const expectedRuntime = interactiveScienceKitRuntimeDependency(scenario.kitId);
      if (
        !artifact.scene.runtimeDependencies?.some(
          ({ id, version }) => id === expectedRuntime.id && version === expectedRuntime.version,
        )
      ) {
        throw new Error(
          `Generated scene did not declare ${expectedRuntime.id}@${expectedRuntime.version}.`,
        );
      }
      artifacts.push(artifact);
      const result = {
        status: 'passed',
        kitId: scenario.kitId,
        pageId: page.id,
        modelDurationMs: Date.now() - started,
        instanceId: marker.instanceId,
        runtimeDependencies: artifact.scene.runtimeDependencies,
      };
      cases.push(result);
      await writeJson(path.join(options.outputDirectory, 'pages', `${scenario.kitId}.json`), {
        scenario,
        result,
        artifact,
      });
      console.log(`  [${index + 1}/${options.scenarios.length}] ${scenario.kitId}: passed`);
    } catch (error) {
      const result = {
        status: 'failed',
        kitId: scenario.kitId,
        pageId: page.id,
        modelDurationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
      cases.push(result);
      await writeJson(
        path.join(options.outputDirectory, 'pages', `${scenario.kitId}-failure.json`),
        {
          scenario,
          result,
          ...(generatedArtifact === undefined ? {} : { artifact: generatedArtifact }),
        },
      );
      console.error(
        `  [${index + 1}/${options.scenarios.length}] ${scenario.kitId}: ${result.error}`,
      );
    }
  }

  let smokeStatus: 'passed' | 'failed' | 'skipped' = options.smoke ? 'failed' : 'skipped';
  if (artifacts.length > 0) {
    const document = assembleDocument(runId, artifacts);
    const playerDirectory = path.join(options.outputDirectory, 'player');
    await writeJson(path.join(options.outputDirectory, 'document.json'), document);
    const prepared = await prepareReachDeckPlayerHarness({
      assetsByResourceId: new Map(),
      document,
      outputDirectory: playerDirectory,
      source: 'cloud-generation',
      timingSource: 'document',
      validatesTtsAlignment: false,
    });
    if (options.smoke) {
      const local = await startReachDeckPlayerHarnessServer(playerDirectory);
      try {
        await runReachDeckPlayerHarnessSmoke(prepared, local.origin, {
          acceptanceKitIdsByPageId: Object.fromEntries(
            options.scenarios.map((scenario, index) => [
              outlinePage(scenario, index).id,
              scenario.kitId,
            ]),
          ),
        });
        smokeStatus = 'passed';
      } finally {
        await local.close();
      }
    }
  }
  const report = {
    schemaVersion: 'reach-interactive-science-kit-acceptance/v1',
    runId,
    model: options.model,
    generatedAt: new Date().toISOString(),
    requestedKitIds: options.scenarios.map(({ kitId }) => kitId),
    passedKitIds: cases.filter(({ status }) => status === 'passed').map(({ kitId }) => kitId),
    smokeStatus,
    cases,
    diagnostics,
  };
  await writeJson(path.join(options.outputDirectory, 'report.json'), report);
  const failed = cases.filter(({ status }) => status === 'failed');
  if (failed.length > 0 || smokeStatus === 'failed') {
    throw new Error(
      `Interactive science-kit acceptance failed: ${failed.length} generation case(s), smoke=${smokeStatus}.`,
    );
  }
  console.log(`Acceptance report: ${path.join(options.outputDirectory, 'report.json')}`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
