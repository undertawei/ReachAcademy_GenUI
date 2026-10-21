import { loadSharedAttachmentCss } from './shared-attachment-css.mjs';
/**
 * Run the production Reach Deck planning/page pipeline against cloud LiteLLM without starting
 * Reach Deck, model-service, content-service, workers, narration, TTS, or durable media persistence.
 *
 * The only substituted boundary is the pipeline's supported fetch injection: model-service would
 * normally select a model and forward the same structured request to LiteLLM, so this harness adds
 * that model field and sends the request directly. Prompts, schemas, parsing, correction retry,
 * few-shot retrieval, NativeV2 compilation, and Player rendering remain production code. Offline
 * visual evidence is observational and does not recreate a production warning/acceptance gate.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  compileDeckSlideToNativeV2,
  applyReachDeckNarrationToNativeSlide,
  buildReachDeckMediaResourceForObjectKey,
  isNativeSlideArtifact,
  stripReachDeckNativeSlideNarration,
  parseReachDeckDocumentV2,
  resolveDeckDesignTheme,
  REFERENCE_MANIFEST_VERSION,
  type ReachDeckDesignContext,
  summarizePreviousSlide,
  type GeneratedNativeSlideArtifact,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

import {
  generateLessonPlanWithModelService,
  finalizeNarrationForNativeSlide,
  generatePageArtifactWithModelService,
  generatePagedDeckOutlineWithModelService,
  prepareNarrationForNativeSlide,
  type GenerateNarrationRequest,
  type ReachDeckImageAssetRequest,
  type ReachDeckMediaDiagnostic,
  type ReachDeckPipelineCheckpoint,
} from '../../lib/reach-deck/generation-pipeline.js';
import { synthesizeReachDeckSpeech } from '../../lib/reach-deck/model-service-tools.js';
import { decodeReachDeckGeneratedImage } from '../../lib/reach-deck/generated-media.js';
import type {
  ReachDeckModelEnv,
  ReachDeckModelRequestContext,
  ReachDeckProviderOutputDiagnostic,
} from '../../lib/reach-deck/model-service-client.js';
import { applyUniformPlayerHarnessTiming } from './player-harness-fixtures.js';
import { prepareReachDeckPlayerHarness, type PlayerHarnessAsset } from './player-harness.js';
import { createDirectLiteLlmFetch } from './offline-model-client.js';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const PLAYER_ROOT = path.join(REPOSITORY_ROOT, 'packages/reach-deck-player');
const DEFAULT_OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'tmp/reach-deck-generation-e2e');
const DEFAULT_MODEL = 'openrouter/openai/gpt-5.6-terra';
const STAGE = { width: 1600, height: 900 } as const;
const USAGE = `Usage:
  pnpm --filter @reachany/ai-runtime accept:generation-offline -- [options]

Options:
  --source-file <path>  UTF-8 source file inside this repository (default: built-in Newton lesson)
  --pages <3-10>        Exact slide count (default: 5)
  --model <id>          LiteLLM model id (default: REACH_DECK_E2E_MODEL or ${DEFAULT_MODEL})
  --media <auto|off>    Generate planned images or force text-led pages (default: auto)
  --scientific <off|auto|required>  Scientific producer policy (default: off)
  --narration <off|real>  Generate narration with real TTS timestamps (default: off)
  --output-dir <path>   Child directory of tmp/ or .tmp/ (default: tmp/reach-deck-generation-e2e)
  --help                Print this message without calling cloud models
`;
const DEFAULT_SOURCE = `
课程主题：初中物理中的牛顿第一定律

牛顿第一定律说明：一切物体在没有受到力的作用时，总保持静止状态或匀速直线运动状态。
在实际分析中，更准确的判断条件是物体所受合力为零；“不受力”是理想情形，“合力为零”也能
维持原有运动状态。物体保持原有运动状态的性质叫惯性，惯性是物体自身的属性，任何物体都
具有惯性，质量越大，改变运动状态越困难。

本次示例只聚焦伽利略斜面思想实验中的一个因果变量：第二个斜面的坡度。小球从固定的第一个
斜面以相同条件释放，随后比较足够长的第二个斜面处于较陡、中等、较缓三种离散坡度时的运动。
为了让变量可辨认，摩擦力在各状态中保持不变且可忽略，不作为可见变量；每次实验中小球都趋近
相同的初始竖直高度，坡度越缓，达到该高度需要经过的路程越长。当第二个斜面趋于水平时，画面
只标出理想化的“继续匀速运动”极限，不虚构测量数值或单位。这个简化实验把可观察现象、理想化
条件和逻辑推论连接起来。

常见误解包括：“运动需要力来维持”“物体速度为零时一定不受力”“惯性是一种力”。正确区分是：
力改变运动状态，不负责维持速度；静止物体可能受到相互平衡的多个力；惯性是性质，不是力。
生活中的刹车前倾、快速抽出桌布、公交车启动时身体后仰，都可以用惯性解释，但分析时必须先
说明物体原来的运动状态以及外力如何改变了它。

教学目标是让学生能从现象提取条件，用“原状态—合力—状态变化”的链条解释例子，并能辨析
上述三个误区。幻灯片应以大字号文字、清楚的语义色块、少量直线或箭头组织关系；斜面思想实验
或生活情境可以在确有助于观察和解释时使用无文字图片，其余页面保持文字主导。
`.trim();

type MediaMode = 'auto' | 'off';
type ScientificMode = 'off' | 'auto' | 'required';
type NarrationMode = 'off' | 'real';

interface CliOptions {
  outputDirectory: string;
  source: string;
  pageCount: number;
  model: string;
  mediaMode: MediaMode;
  scientificMode: ScientificMode;
  narrationMode: NarrationMode;
}

interface OfflineImageAsset {
  bytes: Uint8Array;
  checksumSha256: string;
  contentType: string;
  dataUrl: string;
  fileName: string;
  sizeBytes: number;
}

interface OfflineSpeechAsset {
  bytes: Uint8Array;
  checksumSha256: string;
  contentType: string;
  fileName: string;
  sizeBytes: number;
  dataUrl: string;
  timestamps: Array<{ char: string; start: number; end: number }>;
}

interface GeneratedSlideEvidence {
  artifact: GeneratedNativeSlideArtifact;
  compiled: ReturnType<typeof compileDeckSlideToNativeV2>;
  domDiagnostics?: OfflineDomDiagnostics;
  screenshotName: string;
  modelDurationMs: number;
}

interface OfflineDomTextDiagnostic {
  elementId: string;
  variant: 'title' | 'body' | 'caption' | 'unknown';
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  overflowX: number;
  overflowY: number;
  text: string;
  hasFormula: boolean;
}

interface OfflineDomDiagnostics {
  loadedFontFamily: string;
  text: OfflineDomTextDiagnostic[];
  hasTitleElement: boolean;
  topOccupiedY: number | null;
  emptyTopWithoutTitle: boolean;
}

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const optionValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
};

const resolveSourceFile = (requested: string): string => {
  const sourceFile = path.resolve(REPOSITORY_ROOT, requested);
  const relative = path.relative(REPOSITORY_ROOT, sourceFile);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('--source-file must resolve to a file inside this repository.');
  }
  const segments = relative.split(path.sep);
  if (segments[0] === 'infra' && segments[1] === 'env') {
    throw new Error('--source-file must not point into infra/env.');
  }
  return sourceFile;
};

const resolveOutputDirectory = (requested: string | undefined): string => {
  const outputDirectory = requested
    ? path.resolve(REPOSITORY_ROOT, requested)
    : DEFAULT_OUTPUT_DIRECTORY;
  const allowed = ['tmp', '.tmp'].some((directory) => {
    const root = path.join(REPOSITORY_ROOT, directory);
    const relative = path.relative(root, outputDirectory);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!allowed)
    throw new Error('The output directory must be a child of repository tmp/ or .tmp/.');
  return outputDirectory;
};

const parseOptions = async (
  argv: readonly string[],
  env: ReachDeckModelEnv,
): Promise<CliOptions> => {
  const sourceFile = optionValue(argv, '--source-file');
  const source =
    sourceFile === undefined
      ? DEFAULT_SOURCE
      : await readFile(resolveSourceFile(sourceFile), 'utf8');
  if (source.trim().length === 0)
    throw new Error('The offline acceptance source must be non-empty.');
  const pageCount = Number(optionValue(argv, '--pages') ?? '5');
  if (!Number.isInteger(pageCount) || pageCount < 3 || pageCount > 10) {
    throw new Error('--pages must be an integer from 3 through 10.');
  }
  const model = optionValue(argv, '--model') ?? env.REACH_DECK_E2E_MODEL ?? DEFAULT_MODEL;
  if (model.trim().length === 0) throw new Error('The offline acceptance model must be non-empty.');
  const mediaMode = optionValue(argv, '--media') ?? 'auto';
  if (mediaMode !== 'auto' && mediaMode !== 'off') {
    throw new Error('--media must be either auto or off.');
  }
  const scientificMode = optionValue(argv, '--scientific') ?? 'off';
  if (!['off', 'auto', 'required'].includes(scientificMode)) {
    throw new Error('--scientific must be off, auto, or required.');
  }
  if (scientificMode !== 'off' && mediaMode === 'off') {
    throw new Error('--scientific auto|required needs --media auto for scientific generation.');
  }
  const narrationMode = optionValue(argv, '--narration') ?? 'off';
  if (narrationMode !== 'off' && narrationMode !== 'real') {
    throw new Error('--narration must be off or real.');
  }
  return {
    outputDirectory: resolveOutputDirectory(optionValue(argv, '--output-dir')),
    source: source.trim(),
    pageCount,
    model: model.trim(),
    mediaMode,
    scientificMode: scientificMode as ScientificMode,
    narrationMode: narrationMode as NarrationMode,
  };
};

const writeJson = (file: string, value: unknown): Promise<void> =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const imageSizeForAspectRatio = (
  aspectRatio: ReachDeckImageAssetRequest['aspectRatio'],
): string => {
  switch (aspectRatio) {
    case '1:1':
      return '1024x1024';
    case '3:4':
      return '1024x1536';
    case '16:9':
    case '4:3':
      return '1536x1024';
  }
};

const imageExtension = (contentType: string): string => {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  throw new Error(`Unsupported offline image content type: ${contentType}`);
};

const createOfflineImageResolver = (
  env: ReachDeckModelEnv,
  outputDirectory: string,
  assetsByObjectKey: Map<string, OfflineImageAsset>,
) => {
  const endpoint = env.REACHANY_OPENROUTER_IMAGE_ENDPOINT?.trim();
  const apiKey = env.REACHANY_OPENROUTER_IMAGE_API_KEY?.trim();
  const model = env.REACHANY_OPENROUTER_IMAGE_MODELS?.split(',')[0]?.trim();
  if (!endpoint || !apiKey || !model) {
    throw new Error(
      'REACHANY_OPENROUTER_IMAGE_ENDPOINT, REACHANY_OPENROUTER_IMAGE_API_KEY, and REACHANY_OPENROUTER_IMAGE_MODELS are required for --media auto.',
    );
  }
  const assetDirectory = path.join(outputDirectory, 'assets');
  return async (input: ReachDeckImageAssetRequest) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: 1,
        size: imageSizeForAspectRatio(input.aspectRatio),
        response_format: 'b64_json',
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Offline image generation failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      );
    }
    const envelope = (await response.json()) as {
      data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    };
    const decoded = decodeReachDeckGeneratedImage({
      base64: envelope.data?.[0]?.b64_json,
      revisedPrompt: envelope.data?.[0]?.revised_prompt,
    });
    const extension = imageExtension(decoded.contentType);
    const fileName = `${input.assetId}.${extension}`;
    const objectKey = `offline-generated/${fileName}`;
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(path.join(assetDirectory, fileName), decoded.bytes);
    assetsByObjectKey.set(objectKey, {
      bytes: decoded.bytes,
      checksumSha256: createHash('sha256').update(decoded.bytes).digest('hex'),
      contentType: decoded.contentType,
      dataUrl: `data:${decoded.contentType};base64,${Buffer.from(decoded.bytes).toString('base64')}`,
      fileName: `assets/${fileName}`,
      sizeBytes: decoded.bytes.byteLength,
    });
    return {
      objectKey,
      contentType: decoded.contentType,
      sizeBytes: decoded.bytes.byteLength,
      checksumSha256: createHash('sha256').update(decoded.bytes).digest('hex'),
    };
  };
};

const loadPlayerCss = async (): Promise<string> => {
  const [styles, fonts, mathStyles, katexStyles, mathliveFonts] = await Promise.all([
    readFile(path.join(PLAYER_ROOT, 'styles.css'), 'utf8'),
    readFile(path.join(PLAYER_ROOT, 'fonts/fonts.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/tiptap-mathlive/styles.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'node_modules/katex/dist/katex.min.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'node_modules/mathlive/mathlive-fonts.css'), 'utf8'),
  ]);
  const fontsDirectoryUrl = pathToFileURL(path.join(PLAYER_ROOT, 'fonts')).href;
  const staticMathStyles = [
    katexStyles.replace(/@font-face\{[^}]*\}/g, ''),
    mathliveFonts.replace(/@font-face\{[^}]*\}/g, ''),
    mathStyles.replace(/^@import .*;$/gm, ''),
  ].join('\n');
  return (
    (await loadSharedAttachmentCss()) +
    '\n' +
    styles
      .replace("@import '@reachany/tiptap-mathlive/styles.css';", staticMathStyles)
      .replace(
        "@import './fonts/fonts.css';",
        fonts.replaceAll('url("./', `url("${fontsDirectoryUrl}/`),
      )
  );
};

const buildPlayerBundle = async (harnessDirectory: string): Promise<string> => {
  const entryPath = path.join(harnessDirectory, 'entry.jsx');
  const playerModule = path.join(PLAYER_ROOT, 'dist/NativeV2SlideRenderer.js');
  await writeFile(
    entryPath,
    `import { createRoot } from 'react-dom/client';
import { NativeV2SlideRenderer } from ${JSON.stringify(playerModule)};
createRoot(document.getElementById('root')).render(
  <div className="reach-deck-player" style={{ width: ${STAGE.width} }}>
    <NativeV2SlideRenderer
      hideDiagnostics
      resourceUrlsById={window.__PAYLOAD__.resourceUrlsById}
      scientificStaticMode
      slide={window.__PAYLOAD__.slide}
      stage={window.__PAYLOAD__.stage}
      themeColors={window.__PAYLOAD__.themeColors}
    />
  </div>,
);`,
    'utf8',
  );
  const bundle = await build({
    absWorkingDir: REPOSITORY_ROOT,
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryPoints: [entryPath],
    format: 'iife',
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    nodePaths: [path.join(REPOSITORY_ROOT, 'node_modules')],
    write: false,
  });
  return bundle.outputFiles[0]!.text;
};

const assembleOfflinePlayerDocument = (input: {
  generated: readonly GeneratedSlideEvidence[];
  runId: string;
  title: string;
  themeName?: string;
  designContext?: ReachDeckDesignContext;
}): ReachDeckDocumentV2 => {
  const theme = resolveDeckDesignTheme(input.themeName, input.designContext);
  const themes = input.generated
    .flatMap((page) => page.compiled.resources.themes)
    .filter(
      (resource, index, all) =>
        all.findIndex((candidate) => candidate.id === resource.id) === index,
    );
  const media = input.generated
    .flatMap((page) => page.compiled.resources.media)
    .filter(
      (resource, index, all) =>
        all.findIndex((candidate) => candidate.id === resource.id) === index,
    );
  const defaultTheme = themes[0];
  if (defaultTheme === undefined) throw new Error('Offline Player document has no compiled theme.');
  const generatedAt = new Date().toISOString();
  return parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: `offline-generation-${input.runId}`,
    title: input.title,
    stage: { width: STAGE.width, height: STAGE.height, aspectRatio: '16:9' },
    theme,
    defaultThemeId: defaultTheme.id,
    resources: { themes, masters: [], layouts: [], media },
    metadata: {
      source: 'api',
      language: 'zh-CN',
      generatedAt,
      contentDigest: createHash('sha256')
        .update(JSON.stringify(input.generated.map((page) => page.artifact.nativeSlide)))
        .digest('hex'),
    },
    revisions: [
      {
        id: `offline-${input.runId}`,
        label: 'Offline generation acceptance',
        author: 'ai',
        createdAt: generatedAt,
        summary: `Generated ${input.generated.length} slide pages.`,
      },
    ],
    pages: input.generated.map(({ artifact }, index) => ({
      pageId: artifact.pageId,
      order: index + 1,
      revision: 1,
      sceneType: 'slide',
      title: artifact.nativeSlide.title,
    })),
    nativeSlides: input.generated.map(({ artifact, compiled }) => ({
      pageId: artifact.pageId,
      slide: compiled.slide,
    })),
  });
};

const main = async (): Promise<void> => {
  if (process.argv.slice(2).includes('--help')) {
    console.log(USAGE);
    return;
  }
  const options = await parseOptions(process.argv.slice(2), process.env);
  const env: ReachDeckModelEnv = { ...process.env };
  const offlineTtsVoice = env.REACH_DECK_OFFLINE_TTS_VOICE;
  if (
    options.narrationMode === 'real' &&
    (offlineTtsVoice === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(offlineTtsVoice))
  ) {
    throw new Error(
      'Real narration requires REACH_DECK_OFFLINE_TTS_VOICE with a configured ordinary voice ID.',
    );
  }
  const providerFetch = createDirectLiteLlmFetch(env, options.model);
  let completionIndex = 0;
  const directFetch: typeof fetch = async (input, init) => {
    const index = ++completionIndex;
    const response = await providerFetch(input, init);
    const body = await response.clone().text();
    await writeFile(path.join(options.outputDirectory, `completion-${index}.txt`), body, 'utf8');
    return response;
  };
  const harnessDirectory = path.join(options.outputDirectory, '.harness');
  await rm(options.outputDirectory, { recursive: true, force: true });
  await mkdir(harnessDirectory, { recursive: true });
  const offlineImages = new Map<string, OfflineImageAsset>();
  const offlineSpeech = new Map<string, OfflineSpeechAsset>();
  const ttsRunId = randomUUID();
  const resolveImageAsset =
    options.mediaMode === 'auto'
      ? createOfflineImageResolver(env, options.outputDirectory, offlineImages)
      : undefined;
  const resolveSpeechAsset =
    options.narrationMode === 'real'
      ? async (input: {
          pageId: string;
          cueId: string;
          text: string;
          withTimestamps?: boolean;
        }) => {
          if (input.withTimestamps !== true) {
            throw new Error('Offline real narration requires withTimestamps=true.');
          }
          const audio = await synthesizeReachDeckSpeech(input.text, {
            ...(offlineTtsVoice === undefined ? {} : { voice: offlineTtsVoice }),
            context: {
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
              jobId: `offline-tts-${ttsRunId}`,
              runId: ttsRunId,
            },
            env,
            pageId: input.pageId,
            responseFormat: 'mp3',
            withTimestamps: true,
          });
          if (audio.timestamps === undefined || audio.timestamps.length === 0) {
            throw new Error(
              'Real TTS returned no word timestamps; authoritative acceptance stops.',
            );
          }
          const digest = createHash('sha256').update(audio.bytes).digest('hex');
          const fileName = path.join('speech', `${digest}.mp3`);
          const outputFile = path.join(options.outputDirectory, fileName);
          await mkdir(path.dirname(outputFile), { recursive: true });
          await writeFile(outputFile, audio.bytes);
          const objectKey = `offline/speech/${digest}.mp3`;
          offlineSpeech.set(objectKey, {
            bytes: audio.bytes,
            checksumSha256: digest,
            contentType: audio.contentType || 'audio/mpeg',
            fileName,
            sizeBytes: audio.bytes.byteLength,
            dataUrl: `data:${audio.contentType || 'audio/mpeg'};base64,${Buffer.from(audio.bytes).toString('base64')}`,
            timestamps: audio.timestamps,
          });
          return {
            audioObjectKey: objectKey,
            objectKey,
            contentType: audio.contentType || 'audio/mpeg',
            timestamps: audio.timestamps,
          };
        }
      : undefined;

  const runId = randomUUID();
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
    jobId: `offline-acceptance-${runId}`,
    runId,
  };
  const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
  const mediaDiagnostics: ReachDeckMediaDiagnostic[] = [];
  const checkpoints: Array<{
    checkpoint: ReachDeckPipelineCheckpoint;
    at: string;
    pageId?: string;
  }> = [];
  const pipelineOptions = {
    context,
    env,
    fetch: directFetch,
    loadLayoutImage: async (objectKey: string) => {
      const asset = offlineImages.get(objectKey);
      if (asset === undefined) throw new Error(`Missing offline layout image ${objectKey}.`);
      return asset.dataUrl;
    },
    resolveLayoutMedia: async (input: {
      pageId: string;
      bytes: Uint8Array;
      contentType: string;
    }) => {
      const digest = createHash('sha256').update(input.bytes).digest('hex');
      const extension =
        input.contentType === 'image/png'
          ? 'png'
          : input.contentType === 'image/jpeg'
            ? 'jpg'
            : undefined;
      if (extension === undefined)
        throw new Error(`Unsupported offline layout media ${input.contentType}.`);
      const fileName = path.join('layout-media', `${digest}.${extension}`);
      const outputFile = path.join(options.outputDirectory, fileName);
      await mkdir(path.dirname(outputFile), { recursive: true });
      await writeFile(outputFile, input.bytes);
      const objectKey = `offline/layout/${digest}.${extension}`;
      offlineImages.set(objectKey, {
        bytes: input.bytes,
        checksumSha256: digest,
        contentType: input.contentType,
        sizeBytes: input.bytes.byteLength,
        fileName,
        dataUrl: `data:${input.contentType};base64,${Buffer.from(input.bytes).toString('base64')}`,
      });
      return {
        objectKey,
        contentType: input.contentType,
        checksumSha256: digest,
        sizeBytes: input.bytes.byteLength,
      };
    },
    ...(resolveImageAsset === undefined ? {} : { resolveImageAsset }),
    ...(resolveSpeechAsset === undefined ? {} : { resolveSpeechAsset }),
    checkpoint: (checkpoint: ReachDeckPipelineCheckpoint, detail: { pageId?: string }) => {
      checkpoints.push({ checkpoint, at: new Date().toISOString(), ...detail });
    },
    onOutputDiagnostic: (diagnostic: ReachDeckProviderOutputDiagnostic) => {
      diagnostics.push(diagnostic);
    },
    onMediaDiagnostic: (diagnostic: ReachDeckMediaDiagnostic) => {
      mediaDiagnostics.push(diagnostic);
    },
  };

  console.log(`[1/4] Generating lesson plan with ${options.model}`);
  const lessonStarted = Date.now();
  const lessonPlan = await generateLessonPlanWithModelService(
    {
      source: options.source,
      prompt: `Design a concise Chinese lesson that can be taught in exactly ${options.pageCount} projector-readable slides.`,
    },
    pipelineOptions,
  );
  const lessonDurationMs = Date.now() - lessonStarted;
  await writeJson(path.join(options.outputDirectory, 'lesson-plan.json'), lessonPlan);

  console.log(`[2/4] Generating a ${options.pageCount}-page slide-only outline`);
  const outlineStarted = Date.now();
  const pagedOutline = await generatePagedDeckOutlineWithModelService(
    {
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      source: options.source,
      lessonPlan,
      enabledSceneTypes: ['slide'],
      prompt: [
        `Return exactly ${options.pageCount} slide pages.`,
        ...(options.mediaMode === 'off'
          ? [
              'Set instructionalSpec.visualAssets to [] on every page: this run evaluates text-led composition without generated media.',
            ]
          : [
              'Apply the production visualAssets rules independently to every page. Use a source-grounded image only when a concrete observable scene or transformation materially improves understanding; keep abstract explanation and synthesis pages text-led.',
              'When the source contains a genuinely observable scene, at least one page should plan an image so this mixed-media acceptance run exercises image binding and free-coordinate image composition.',
            ]),
        ...(options.scientificMode === 'required'
          ? [
              'At least one slide whose teaching value depends on a time-driven scientific mechanism must plan exactly one visualAssets item with kind scientific-visual. Do not recreate that mechanism with slide primitives.',
            ]
          : []),
        'Vary the page structures across single focus, comparison, sequence, misconception correction, and synthesis where instructionally appropriate.',
        'Prefer substantial readable copy organized by a small number of large semantic color regions; do not turn every sentence into a separate card.',
      ].join(' '),
    },
    pipelineOptions,
  );
  const outlineDurationMs = Date.now() - outlineStarted;
  await writeJson(path.join(options.outputDirectory, 'paged-outline.json'), pagedOutline);
  if (pagedOutline.pages.length !== options.pageCount) {
    throw new Error(
      `Paged outline returned ${pagedOutline.pages.length} pages; expected exactly ${options.pageCount}.`,
    );
  }
  const invalidOutlinePage = pagedOutline.pages.find((page) => page.sceneType !== 'slide');
  if (invalidOutlinePage !== undefined) {
    throw new Error(
      `Offline layout acceptance requires slide-only pages; ${invalidOutlinePage.id} violated that policy.`,
    );
  }
  if (
    options.mediaMode === 'off' &&
    pagedOutline.pages.some((page) => (page.instructionalSpec?.visualAssets?.length ?? 0) !== 0)
  ) {
    throw new Error(
      'Offline --media off acceptance requires every visualAssets array to be empty.',
    );
  }
  const plannedScientificCount = pagedOutline.pages.reduce(
    (total, page) =>
      total +
      (page.instructionalSpec?.visualAssets?.filter((asset) => asset.kind === 'scientific-visual')
        .length ?? 0),
    0,
  );
  if (options.scientificMode === 'required' && plannedScientificCount === 0) {
    throw new Error('--scientific required expected at least one planned scientific-visual.');
  }

  console.log(`[3/4] Generating ${pagedOutline.pages.length} slide pages through current prompts`);
  const generated: GeneratedSlideEvidence[] = [];
  let representativeNarrationAnimationFound = false;
  for (const [index, outlinePage] of pagedOutline.pages.entries()) {
    const recent = generated.slice(-3);
    const previousPageSummaries = recent.map(({ artifact }) =>
      summarizePreviousSlide({
        pageId: artifact.pageId,
        slide: artifact.nativeSlide,
        generationMetadata: artifact.generationMetadata,
      }),
    );
    const nearbyLayoutReferenceIds = [
      ...new Set(
        recent.flatMap(
          ({ artifact }) =>
            artifact.generationMetadata.designIntent?.layoutReferenceIds ??
            artifact.generationMetadata.layoutReferences.map((reference) => reference.id),
        ),
      ),
    ];
    const started = Date.now();
    const artifact = await generatePageArtifactWithModelService(
      {
        runId,
        pageId: outlinePage.id,
        requestedRevision: 1,
        attempt: 1,
        attemptReason: 'initial',
        source: options.source,
        lessonPlan,
        pagedOutline,
        page: outlinePage,
        previousPageSummaries,
        nearbyLayoutReferenceIds,
      },
      pipelineOptions,
    );
    if (!isNativeSlideArtifact(artifact))
      throw new Error(`Page ${outlinePage.id} is not a Native slide.`);
    if (options.narrationMode === 'off' && artifact.nativeSlide.narration !== undefined) {
      throw new Error(`Page ${outlinePage.id} unexpectedly contains narration.`);
    }
    let pageArtifact = artifact;
    let compiled: ReturnType<typeof compileDeckSlideToNativeV2> = {
      slide: artifact.nativeSlide,
      resources: artifact.resources,
      diagnostics: [],
    };
    if (options.narrationMode === 'real') {
      const nativeSlideContentDigest = createHash('sha256')
        .update(JSON.stringify(stripReachDeckNativeSlideNarration(compiled.slide)))
        .digest('hex');
      const narrationRequest: GenerateNarrationRequest = {
        runId,
        pageId: outlinePage.id,
        requestedRevision: 1,
        attempt: 1,
        attemptReason: 'regenerate',
        source: options.source,
        page: outlinePage,
        slideContentDigest: nativeSlideContentDigest,
        ...(generated.at(-1)?.artifact.nativeSlide.narration?.segments === undefined
          ? {}
          : {
              previousPageNarration: {
                pageId: generated.at(-1)!.artifact.pageId,
                title: generated.at(-1)!.artifact.nativeSlide.title,
                segments: generated
                  .at(-1)!
                  .artifact.nativeSlide.narration!.segments!.map((segment) => segment.text),
              },
            }),
      };
      const preparedNarration = await prepareNarrationForNativeSlide(
        narrationRequest,
        compiled.slide,
        pipelineOptions,
      );
      const nativeNarration = await finalizeNarrationForNativeSlide(
        narrationRequest,
        preparedNarration,
        pipelineOptions,
      );
      if (nativeNarration.audioObjectKey === undefined) {
        throw new Error('Offline narration unexpectedly completed without audio');
      }
      const audio = buildReachDeckMediaResourceForObjectKey(nativeNarration.audioObjectKey);
      const narrated = applyReachDeckNarrationToNativeSlide(artifact.nativeSlide, {
        ...nativeNarration,
        audioResourceId: audio.id,
      });
      pageArtifact = {
        ...artifact,
        nativeSlide: narrated.slide,
        resources: { ...artifact.resources, media: [...artifact.resources.media, audio] },
      };
      compiled = {
        slide: pageArtifact.nativeSlide,
        resources: pageArtifact.resources,
        diagnostics: narrated.diagnostics,
      };
      const hasScientificVisual = compiled.slide.elements.some(
        (element) => element.type === 'scientificVisual',
      );
      const hasBodyNarrationReveal = compiled.slide.animations.some((animation) => {
        if (!animation.id.startsWith('narration-entrance:')) return false;
        const target = compiled.slide.elements.find((element) => element.id === animation.targetId);
        return target !== undefined && target.type !== 'scientificVisual';
      });
      if (hasScientificVisual && hasBodyNarrationReveal)
        representativeNarrationAnimationFound = true;
    }
    const missingOfflineMedia = compiled.resources.media.find(
      (resource) =>
        !offlineImages.has(resource.objectKey) && !offlineSpeech.has(resource.objectKey),
    );
    if (missingOfflineMedia !== undefined) {
      throw new Error(`Compiled media ${missingOfflineMedia.id} has no offline bytes.`);
    }
    const pageDirectory = path.join(
      options.outputDirectory,
      'pages',
      String(index + 1).padStart(2, '0'),
    );
    await mkdir(pageDirectory, { recursive: true });
    const screenshotName = `${String(index + 1).padStart(2, '0')}-${outlinePage.id}.png`;
    const modelDurationMs = Date.now() - started;
    await Promise.all([
      writeJson(path.join(pageDirectory, 'artifact.json'), pageArtifact),
      writeJson(path.join(pageDirectory, 'native-v2.json'), compiled),
    ]);
    generated.push({ artifact: pageArtifact, compiled, screenshotName, modelDurationMs });
    console.log(
      `  [${index + 1}/${pagedOutline.pages.length}] ${outlinePage.title}: ${artifact.status}, ${artifact.nativeSlide.elements.length} elements`,
    );
  }

  const sourcePlayerDocument = assembleOfflinePlayerDocument({
    generated,
    runId,
    title: pagedOutline.title,
    themeName: pagedOutline.themeName,
    designContext: pagedOutline.designContext,
  });
  const generatedScientificCount = sourcePlayerDocument.nativeSlides.reduce(
    (total, binding) =>
      total +
      binding.slide.elements.filter((element) => element.type === 'scientificVisual').length,
    0,
  );
  if (options.scientificMode === 'required' && generatedScientificCount === 0) {
    throw new Error('--scientific required did not produce a compiled scientificVisual element.');
  }
  if (
    options.narrationMode === 'real' &&
    options.scientificMode === 'required' &&
    !representativeNarrationAnimationFound
  ) {
    throw new Error(
      'Real narration acceptance expected at least one narration-entrance animation on the scientific representative page.',
    );
  }
  const playerAssets = new Map<string, PlayerHarnessAsset>();
  for (const resource of sourcePlayerDocument.resources.media) {
    const offline = offlineImages.get(resource.objectKey);
    const speech = offlineSpeech.get(resource.objectKey);
    if (offline === undefined && speech === undefined)
      throw new Error(`Player document resource ${resource.id} has no offline bytes.`);
    const asset = offline ?? speech!;
    playerAssets.set(resource.id, {
      bytes: asset.bytes,
      checksumSha256: asset.checksumSha256,
      contentType: asset.contentType,
      fileName: asset.fileName,
      sizeBytes: asset.sizeBytes,
    });
  }
  const preview =
    options.narrationMode === 'real'
      ? { document: sourcePlayerDocument, evidence: { timingSource: 'document' as const } }
      : applyUniformPlayerHarnessTiming(sourcePlayerDocument);
  const playerDirectory = path.join(options.outputDirectory, 'player');
  const resourceMap = Object.fromEntries(
    sourcePlayerDocument.resources.media.map((resource) => {
      const offline = offlineImages.get(resource.objectKey);
      const speech = offlineSpeech.get(resource.objectKey);
      const asset = offline ?? speech;
      if (asset === undefined) throw new Error(`No offline bytes for ${resource.objectKey}.`);
      return [
        resource.id,
        path.relative(REPOSITORY_ROOT, path.join(options.outputDirectory, asset.fileName)),
      ];
    }),
  );
  await Promise.all([
    writeJson(path.join(options.outputDirectory, 'document.json'), sourcePlayerDocument),
    writeJson(path.join(options.outputDirectory, 'resource-map.json'), resourceMap),
    writeJson(path.join(options.outputDirectory, 'player-timing-evidence.json'), preview.evidence),
  ]);
  await prepareReachDeckPlayerHarness({
    assetsByResourceId: playerAssets,
    document: preview.document,
    outputDirectory: playerDirectory,
    source: 'cloud-generation',
    timingSource: options.narrationMode === 'real' ? 'document' : 'uniform-preview',
    validatesTtsAlignment: options.narrationMode === 'real',
  });

  console.log('[4/4] Rendering production NativeV2 slides to PNG');
  const [bundleText, playerCss] = await Promise.all([
    buildPlayerBundle(harnessDirectory),
    loadPlayerCss(),
  ]);
  const browser = await chromium.launch();
  const browserPage = await browser.newPage({ deviceScaleFactor: 2, viewport: STAGE });
  let renderHtmlForServer = '';
  const renderServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderHtmlForServer);
  });
  await new Promise<void>((resolve, reject) => {
    renderServer.once('error', reject);
    renderServer.listen(0, '127.0.0.1', () => resolve());
  });
  const renderAddress = renderServer.address();
  if (renderAddress === null || typeof renderAddress === 'string') {
    await browser.close();
    renderServer.close();
    throw new Error('Static render server did not expose a TCP address.');
  }
  const renderOrigin = `http://127.0.0.1:${renderAddress.port}`;
  const theme = resolveDeckDesignTheme(pagedOutline.themeName, pagedOutline.designContext);
  for (const [index, evidence] of generated.entries()) {
    const themeResource = evidence.compiled.resources.themes[0];
    const resourceUrlsById = Object.fromEntries(
      evidence.compiled.resources.media.map((resource) => {
        const image = offlineImages.get(resource.objectKey);
        const speech = offlineSpeech.get(resource.objectKey);
        if (image === undefined && speech === undefined)
          throw new Error(`No offline bytes for ${resource.objectKey}.`);
        return [resource.id, image?.dataUrl ?? speech!.dataUrl];
      }),
    );
    const payload = {
      resourceUrlsById,
      slide: evidence.compiled.slide,
      stage: STAGE,
      themeColors: themeResource?.colors ?? {
        background: theme.background,
        surface: theme.surface,
        ink: theme.ink,
        muted: theme.muted,
        accent: theme.accent,
        success: theme.success,
        warning: theme.warning,
      },
    };
    const scientificElements = evidence.compiled.slide.elements.filter(
      (element) => element.type === 'scientificVisual',
    );
    const scientificResourceIds = new Set(
      scientificElements.flatMap((element) => element.manifest.resourceIds),
    );
    const expectedDirectResourceCount = Object.keys(resourceUrlsById).filter(
      (resourceId) =>
        !scientificResourceIds.has(resourceId) &&
        !evidence.compiled.resources.media
          .find((resource) => resource.id === resourceId)
          ?.contentType.startsWith('audio/'),
    ).length;
    const renderHtml = `<!doctype html><html><head><meta charset="utf-8">
    <style>html,body,#root{margin:0;width:${STAGE.width}px;height:${STAGE.height}px;overflow:hidden}</style>
      <style>${playerCss}</style></head><body><div id="root"></div>
      <script>window.__PAYLOAD__=${JSON.stringify(payload).replaceAll('<', '\\u003c')};</script>
      <script>${bundleText}</script></body></html>`;
    const renderPath = path.join(harnessDirectory, `${String(index + 1).padStart(2, '0')}.html`);
    await writeFile(renderPath, renderHtml, 'utf8');
    // Serve the inline render from a loopback HTTP origin. Opaque srcdoc scientific frames
    // reliably report bridge readiness to an HTTP parent; about:blank/file parents can leave
    // the visual stuck in loading in Chromium even though the same document works in Player.
    renderHtmlForServer = renderHtml;
    await browserPage.goto(renderOrigin, { waitUntil: 'load' });
    if (scientificElements.length > 0) {
      await browserPage.waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLElement>('.scientific-visual-player')].some(
            (node) => node.dataset.scientificRuntimePhase === 'active',
          ),
        undefined,
        { timeout: 10_000 },
      );
    }
    await browserPage.evaluate(async () => {
      // A setContent/about:blank host cannot always resolve the local font URLs embedded in the
      // production CSS. Font readiness is helpful for screenshots but must not turn a valid
      // scientific iframe into a network-error failure; the browser still paints with its fallback
      // font in that case.
      try {
        await document.fonts.load('30px "Source Han Sans VF"', '中文 Latin 123');
        await document.fonts.ready;
      } catch {
        // Continue with the browser's fallback font.
      }
      await Promise.all(
        [...document.images].map((image) =>
          image.complete
            ? Promise.resolve()
            : new Promise((resolve, reject) => {
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', reject, { once: true });
              }),
        ),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const probe = await browserPage.evaluate(() => ({
      elementCount: document.querySelectorAll('[data-native-v2-element-id]').length,
      stageWidth: document.querySelector('[data-native-v2-stage]')?.getBoundingClientRect().width,
      textLength: document.body.textContent?.trim().length ?? 0,
      imageCount: document.querySelectorAll('[data-native-v2-resource-id]').length,
      scientificCount: document.querySelectorAll('.scientific-visual-player').length,
      scientificFrameCount: document.querySelectorAll(
        '.scientific-visual-player [data-scientific-frame]',
      ).length,
    }));
    if (
      probe.elementCount === 0 ||
      probe.textLength === 0 ||
      probe.stageWidth !== STAGE.width ||
      probe.imageCount !== expectedDirectResourceCount ||
      probe.scientificCount !== scientificElements.length ||
      probe.scientificFrameCount !== scientificElements.length
    ) {
      throw new Error(`Render probe failed for page ${index + 1}: ${JSON.stringify(probe)}`);
    }
    const textVariants: Record<string, OfflineDomTextDiagnostic['variant']> = Object.fromEntries(
      evidence.artifact.nativeSlide.elements.flatMap((element) =>
        element.type === 'textFrame' ? [[element.id, 'unknown']] : [],
      ),
    );
    const domDiagnostics = await browserPage.evaluate(async (variants) => {
      let sourceHanLoaded = false;
      try {
        const loadedFaces = await document.fonts.load(
          '30px "Source Han Sans VF"',
          '中文 Latin 123',
        );
        sourceHanLoaded =
          loadedFaces.length > 0 &&
          document.fonts.check('30px "Source Han Sans VF"', '中文 Latin 123');
      } catch {
        // The static renderer may run under about:blank where local font URLs are unavailable;
        // retain the diagnostic flag and continue with a browser fallback face.
      }
      const elements = [...document.querySelectorAll<HTMLElement>('[data-native-v2-element-id]')];
      const text = elements.flatMap((element) => {
        const elementId = element.dataset.nativeV2ElementId ?? '(missing)';
        const variant = variants[elementId];
        if (variant === undefined) return [];
        const frame = element.querySelector<HTMLElement>('[data-native-v2-text-frame]');
        if (frame === null) return [];
        const content = element.textContent?.trim() ?? '';
        if (content.length === 0) return [];
        const clientWidth = frame.clientWidth;
        const clientHeight = frame.clientHeight;
        const scrollWidth = frame.scrollWidth;
        const scrollHeight = frame.scrollHeight;
        return [
          {
            elementId,
            variant,
            clientWidth,
            clientHeight,
            scrollWidth,
            scrollHeight,
            overflowX: Math.max(0, scrollWidth - clientWidth),
            overflowY: Math.max(0, scrollHeight - clientHeight),
            text: content.slice(0, 120),
            hasFormula: element.querySelector('[data-mathlive-node]') !== null,
          },
        ];
      });
      const hasTitleElement = text.some((entry) => entry.variant === 'title');
      const stage = document.querySelector('[data-native-v2-stage]')?.getBoundingClientRect();
      const visibleTops = elements
        .filter((element) => getComputedStyle(element).visibility !== 'hidden')
        .map((element) => element.getBoundingClientRect().top - (stage?.top ?? 0));
      const topOccupiedY = visibleTops.length === 0 ? null : Math.min(...visibleTops);
      return {
        loadedFontFamily: 'Source Han Sans VF',
        text,
        hasTitleElement,
        topOccupiedY,
        emptyTopWithoutTitle: !hasTitleElement && (topOccupiedY === null || topOccupiedY > 220),
      };
    }, textVariants);
    evidence.domDiagnostics = domDiagnostics;
    await writeJson(
      path.join(
        options.outputDirectory,
        'pages',
        String(index + 1).padStart(2, '0'),
        'dom-diagnostics.json',
      ),
      domDiagnostics,
    );
    await browserPage.locator('[data-native-v2-viewport]').screenshot({
      path: path.join(options.outputDirectory, evidence.screenshotName),
    });
  }

  const cards = generated
    .map(({ artifact, screenshotName, modelDurationMs }, index) => {
      const outlinePage = pagedOutline.pages[index]!;
      const references = artifact.generationMetadata.layoutReferences
        .map((reference) => `<code>${escapeHtml(reference.id)}</code>`)
        .join(' ');
      const imageCount = artifact.nativeSlide.elements.filter(
        (element) => element.type === 'image',
      ).length;
      return `<article><header><span>${String(index + 1).padStart(2, '0')}</span><div><h2>${escapeHtml(outlinePage.title)}</h2><p>${escapeHtml(outlinePage.slideClassification?.primaryType)} / ${escapeHtml(outlinePage.slideClassification?.visualFocus)} / ${escapeHtml(outlinePage.slideClassification?.density)}</p></div><strong class="${artifact.status}">${escapeHtml(artifact.status)}</strong></header><a href="${escapeHtml(screenshotName)}"><img src="${escapeHtml(screenshotName)}" alt="${escapeHtml(outlinePage.title)}"></a><footer><div>Few-shot: ${references}</div><div>${artifact.nativeSlide.elements.length} elements · ${imageCount} images · ${(modelDurationMs / 1000).toFixed(1)}s</div></footer></article>`;
    })
    .join('\n');
  const outlineItems = pagedOutline.pages
    .map(
      (page) =>
        `<li><b>${String(page.order).padStart(2, '0')} ${escapeHtml(page.title)}</b><span>${escapeHtml(page.instructionalSpec?.learningObjective)}</span></li>`,
    )
    .join('');
  const indexHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reach Deck offline generation acceptance</title><style>
    :root{font-family:Inter,"Noto Sans SC",system-ui,sans-serif;color:#17212b;background:#e9eef2}*{box-sizing:border-box}body{margin:0}main{width:min(1840px,100%);margin:auto;padding:28px}h1{margin:0 0 6px;font-size:30px;letter-spacing:0}.meta{margin:0 0 24px;color:#5a6875}.outline{background:#fff;border:1px solid #d3dce3;padding:20px 24px;margin-bottom:28px}.outline h2{font-size:18px;margin:0 0 14px}.outline ol{margin:0;padding-left:24px;columns:2;column-gap:40px}.outline li{break-inside:avoid;margin:0 0 12px;padding-left:6px}.outline b,.outline span{display:block}.outline span{font-size:13px;line-height:1.45;color:#64727e;margin-top:3px}article{background:#fff;border:1px solid #d3dce3;margin:0 0 28px;overflow:hidden}header{display:flex;align-items:center;gap:16px;padding:15px 20px;border-bottom:1px solid #e0e6eb}header>span{font:700 22px ui-monospace,monospace;color:#275f9d}header>div{min-width:0;flex:1}h2{font-size:19px;margin:0 0 4px;letter-spacing:0}header p{font-size:13px;color:#667582;margin:0}header strong{padding:4px 8px;border-radius:4px;font-size:12px}.ready{color:#17623c;background:#def2e4}.warning{color:#8a4b12;background:#fbe8cf}article>a{display:block;background:#cbd4dc}img{display:block;width:100%;height:auto}footer{display:flex;justify-content:space-between;gap:20px;padding:13px 20px;color:#566572;font-size:13px}code{display:inline-block;background:#eef3f6;padding:2px 5px;margin-right:4px}@media(max-width:760px){main{padding:12px}.outline ol{columns:1}footer{display:block}footer div+div{margin-top:8px}}
  </style></head><body><main><h1>${escapeHtml(pagedOutline.title)}</h1><p class="meta">当前生产提示词 → ${options.mediaMode === 'auto' ? '图片/科学 visual 生成与本地验收绑定 → ' : ''}自由坐标页面 → NativeV2 编译 → 静态 t=0 组件截图；完整 v2 文档和真实 Player 位于 <code>player/</code>，请通过本地 HTTP server 打开。</p><section class="outline"><h2>分页大纲</h2><ol>${outlineItems}</ol></section>${cards}</main></body></html>`;
  const indexPath = path.join(options.outputDirectory, 'index.html');
  await writeFile(indexPath, indexHtml, 'utf8');
  await browserPage.setViewportSize({ width: 1800, height: 1000 });
  await browserPage.goto(pathToFileURL(indexPath).href);
  await browserPage.waitForLoadState('load');
  await browserPage.screenshot({
    path: path.join(options.outputDirectory, 'contact-sheet.png'),
    fullPage: true,
  });
  await browser.close();
  await new Promise<void>((resolve) => renderServer.close(() => resolve()));

  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    model: options.model,
    sourceDigest: createHash('sha256').update(options.source).digest('hex'),
    requestedPageCount: options.pageCount,
    actualPageCount: pagedOutline.pages.length,
    stagePolicy: {
      narration: options.narrationMode === 'real',
      tts: options.narrationMode === 'real',
      animations: options.narrationMode === 'real',
      media: options.mediaMode,
      scientific: options.scientificMode,
      durableMediaPersistence: false,
    },
    plannedImageCount: pagedOutline.pages.reduce(
      (total, page) => total + (page.instructionalSpec?.visualAssets?.length ?? 0),
      0,
    ),
    generatedImageCount: offlineImages.size,
    generatedSpeechCount: offlineSpeech.size,
    plannedScientificCount,
    generatedScientificCount,
    playerHarness: {
      directory: 'player',
      timingSource: options.narrationMode === 'real' ? 'document' : 'uniform-preview',
      validatesTtsAlignment: options.narrationMode === 'real',
    },
    generatedImages: [...offlineImages.entries()].map(([objectKey, asset]) => ({
      objectKey,
      contentType: asset.contentType,
      fileName: asset.fileName,
    })),
    generatedSpeech: [...offlineSpeech.entries()].map(([objectKey, asset]) => ({
      objectKey,
      contentType: asset.contentType,
      fileName: asset.fileName,
      sizeBytes: asset.sizeBytes,
      checksumSha256: asset.checksumSha256,
      timestampCount: asset.timestamps.length,
    })),
    durationsMs: {
      lessonPlan: lessonDurationMs,
      pagedOutline: outlineDurationMs,
      pages: generated.map((page) => page.modelDurationMs),
    },
    diagnostics,
    mediaDiagnostics,
    checkpoints,
    pages: generated.map(
      ({ artifact, compiled, domDiagnostics, screenshotName, modelDurationMs }) => ({
        pageId: artifact.pageId,
        status: artifact.status,
        modelDurationMs,
        elementCount: artifact.nativeSlide.elements.length,
        imageCount: artifact.nativeSlide.elements.filter((element) => element.type === 'image')
          .length,
        layoutReferenceIds: artifact.generationMetadata.layoutReferences.map((item) => item.id),
        screenshotName,
        domDiagnostics,
        narration: {
          audioResourceId: compiled.slide.narration?.audioResourceId,
          segmentCount: compiled.slide.narration?.segments?.length ?? 0,
          segments: compiled.slide.narration?.segments ?? [],
          scientificAnchorBindings: compiled.slide.narration?.scientificAnchorBindings ?? [],
        },
      }),
    ),
  };
  await writeJson(path.join(options.outputDirectory, 'report.json'), report);
  await rm(harnessDirectory, { recursive: true, force: true });
  console.log(`Gallery: ${indexPath}`);
  console.log(`Contact sheet: ${path.join(options.outputDirectory, 'contact-sheet.png')}`);
};

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
