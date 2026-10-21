/**
 * 公式朗读工作台（#705）：本机回环页面，试听含公式讲稿在不同送法下的真实读法。
 *
 * - 单行变体：直连火山 v3 单向流式 TTS（与 model-service 相同的 endpoint、resource、默认音色、
 *   additions 形状），逐个比较纯文本 / SSML / say-as / sub 等送法；
 * - 整链试听：调用生产 `finalizeNarrationForNativeSlide`（读法生成经 LiteLLM 直连），只把「合成 +
 *   对齐」换成直连火山 + 本地 model-service 的生产 ASR 对齐器（拒绝时回落 Seed，与生产同序），
 *   ffmpeg 拼接测时长；结果用播放器字幕区与编辑器讲稿轴的同一套代码渲染、随音频同步。另有
 *   「生产现状」对照（修复前：纯文本分块、LaTeX 原样送出、旧逐字映射）。
 *
 * 支持预置音色与 postpaid 克隆音色（seed-icl-2.0）。不落库、不写文件；音频只存在浏览器内存里。
 * 每次合成、对齐与模型调用都是真实计费调用。
 *
 * 前置：本地 model-service（REACHANY_ENV=local，默认 http://127.0.0.1:8100，可用
 * REACH_DECK_WORKBENCH_MODEL_SERVICE 覆盖）；reach-deck-player / reach-deck-editor 已 build。
 * worktree 里必须引用主 checkout 的 infra/env/dev.env，不要用 worktree 里的副本。
 * 运行（仓库根目录）：
 *   npx -y @dotenvx/dotenvx run -f <主 checkout>/infra/env/dev.env -- \
 *     pnpm --filter @reachany/ai-runtime exec tsx scripts/reach-deck/run-formula-speech-workbench.ts \
 *     --port 4191 [--clone-speaker <provider_speaker_id>]
 * 端口不要用 4190：它在浏览器与 undici 的封禁端口表里。
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  normalizeReachDeckNarrationMarkdown,
  planReachDeckSsmlChunks,
  REACH_DECK_SSML_MAX_CHARACTERS,
  type ReachDeckFormulaReadingV1,
} from '@reachany/reach-deck-dsl';

import { renderMathToString } from '@reachany/tiptap-mathlive/static';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  finalizeNarrationForNativeSlide,
  prepareNarrationFormulaReadings,
} from '../../lib/reach-deck/generation-pipeline.js';
import type { ReachDeckModelRequestContext } from '../../lib/reach-deck/model-service-client.js';
import type { ReachDeckSpeechTimestamp } from '../../lib/reach-deck/model-service-tools.js';
import { splitNaturalNarrationCues } from '../../lib/reach-deck/narration-capability-adapter.js';
import { mapSegmentTimings } from '../../lib/reach-deck/narration-timing.js';
import { planReachDeckPlainSpeechChunks } from '../../lib/reach-deck/plain-speech-chunks.js';
import { concatReachDeckSpeechChunks } from '../../lib/reach-deck/speech-audio.js';
// 展示侧直接用播放器字幕区与编辑器讲稿轴的构建产物（包入口未导出这两个模块）。
import { NarrationCaption } from '../../../../packages/reach-deck-player/dist/NarrationCaption.js';
import {
  narrationCharacterMarks,
  narrationDisplayWindows,
} from '../../../../packages/reach-deck-editor/dist/timelineOperations.js';
import { createDirectLiteLlmFetch } from './offline-model-client.js';

const DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts';
const PRESET_RESOURCE_ID = 'seed-tts-2.0';
/** 与 VolcengineTtsClient 的 postpaid 克隆路径一致。 */
const CLONE_RESOURCE_ID = 'seed-icl-2.0';
const CLONE_MODEL = 'seed-tts-2.0-standard';
const MAX_INPUT_CHARACTERS = 600;
const MAX_NARRATION_CHARACTERS = 4000;
const PLAIN_ADDITIONS = { latex_parser: 'v2', disable_markdown_filter: true };
const SSML_ADDITIONS = { latex_parser: 'v2', disable_markdown_filter: false };

type Voice = { kind: 'preset' | 'clone'; speaker: string };

interface SynthesisInput {
  placement: 'text' | 'ssml';
  input: string;
  voice: Voice;
  additions: Record<string, unknown>;
}

interface SubtitleWord {
  word: string;
  startTime: number;
  endTime: number;
}

interface SynthesisResult {
  audio: Buffer;
  words: SubtitleWord[];
  sentences: string[];
  errors: string[];
}

function readArgument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readPort(argv: readonly string[]): number {
  const value = Number(readArgument(argv, '--port') ?? 4191);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error('--port is invalid');
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is not configured (run through dotenvx with infra/env/dev.env)`);
  return value;
}

async function synthesize(request: SynthesisInput): Promise<SynthesisResult> {
  const endpoint = requireEnv('REACHANY_VOLCENGINE_TTS_ENDPOINT');
  const apiKey = requireEnv('REACHANY_VOLCENGINE_TTS_API_KEY');
  const clone = request.voice.kind === 'clone';
  const reqParams: Record<string, unknown> = {
    [request.placement]: request.input,
    speaker: request.voice.speaker,
    audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: 0, enable_subtitle: true },
    ...(clone ? { model: CLONE_MODEL } : {}),
    additions: JSON.stringify({ ...request.additions, enable_timestamp: true }),
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': clone ? CLONE_RESOURCE_ID : PRESET_RESOURCE_ID,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({ req_params: reqParams }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${body.slice(0, 300)}`);
  const audio: Buffer[] = [];
  const words: SubtitleWord[] = [];
  const sentences: string[] = [];
  const errors: string[] = [];
  // 响应是连续拼接的 JSON 对象（非严格换行分隔），按花括号深度切分。
  for (const chunk of splitConcatenatedJson(body)) {
    const code = chunk.code;
    if (code === 0 && typeof chunk.data === 'string' && chunk.data.length > 0) {
      audio.push(Buffer.from(chunk.data, 'base64'));
    } else if (code !== 0 && code !== 20_000_000) {
      errors.push(`code=${String(code)} ${String(chunk.message ?? '')}`);
    }
    const sentence = chunk.sentence as { text?: unknown; words?: unknown } | undefined;
    if (sentence && typeof sentence.text === 'string') sentences.push(sentence.text);
    if (sentence && Array.isArray(sentence.words)) {
      for (const word of sentence.words as Array<Record<string, unknown>>) {
        if (typeof word.word === 'string') {
          words.push({
            word: word.word,
            startTime: Number(word.startTime),
            endTime: Number(word.endTime),
          });
        }
      }
    }
  }
  return { audio: Buffer.concat(audio), words, sentences, errors };
}

function splitConcatenatedJson(body: string): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        values.push(JSON.parse(body.slice(start, index + 1)) as Record<string, unknown>);
        start = -1;
      }
    }
  }
  return values;
}

/** 本地 model-service：生产 ASR 对齐器与 Seed 对齐的本机诊断端点。 */
const MODEL_SERVICE_ORIGIN =
  process.env.REACH_DECK_WORKBENCH_MODEL_SERVICE || 'http://127.0.0.1:8100';
const LOCAL_ALIGNMENT_ROUTE = '/internal/dev/v1/reach-deck/clone-speech';
/** 与编辑器默认缩放一致（ZOOM_LEVELS[2]）。 */
const TIMELINE_PIXELS_PER_SECOND = 72;

type AlignmentSource = 'asr' | 'seed' | 'seed-inexact';

interface AlignedChunk {
  placement: 'text' | 'ssml';
  input: string;
  transcript: string;
  source: AlignmentSource;
  audio: Buffer;
  timestamps: ReachDeckSpeechTimestamp[];
}

async function postLocal<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(MODEL_SERVICE_ORIGIN + LOCAL_ALIGNMENT_ROUTE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`local model-service ${path} HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

/**
 * 与生产 `alignNarrationTimestamps` 同序：先 ASR + 生产 Java 对齐器；拒绝时回落 Seed 对齐，
 * SSML 块要求 Seed 结果能与转写精确对账（生产同样要求），纯文本块沿用 Seed 原始词。
 */
async function alignChunk(
  audio: Buffer,
  transcript: string,
  placement: 'text' | 'ssml',
): Promise<{ source: AlignmentSource; timestamps: ReachDeckSpeechTimestamp[] }> {
  const dataBase64 = audio.toString('base64');
  const asr = await postLocal<{
    alignedWords: Array<{ text: string; start: number; end: number }> | null;
  }>('/asr', { dataBase64, transcript });
  if (asr.alignedWords !== null && asr.alignedWords.length > 0) {
    return {
      source: 'asr',
      timestamps: asr.alignedWords.map((word) => ({
        char: word.text,
        start: word.start,
        end: word.end,
      })),
    };
  }
  const seed = await postLocal<{
    words: Array<{ word: string; startTime: number; endTime: number }>;
    exact: boolean;
  }>('/align', { dataBase64, transcript });
  if (!seed.exact && placement === 'ssml') {
    throw new Error(
      `块转写「${transcript.slice(0, 30)}…」ASR 与 Seed 都无法精确对齐（生产会让本页失败重试）`,
    );
  }
  return {
    source: seed.exact ? 'seed' : 'seed-inexact',
    timestamps: seed.words.map((word) => ({
      char: word.word,
      start: word.startTime,
      end: word.endTime,
    })),
  };
}

async function synthesizeAndAlign(
  chunks: ReadonlyArray<{ placement: 'text' | 'ssml'; input: string; transcript: string }>,
  voice: Voice,
): Promise<{
  aligned: AlignedChunk[];
  audio: Buffer;
  timestamps: ReachDeckSpeechTimestamp[];
  duration: number;
}> {
  const aligned: AlignedChunk[] = [];
  for (const chunk of chunks) {
    const synthesized = await synthesize({
      placement: chunk.placement,
      input: chunk.input,
      voice,
      additions: chunk.placement === 'ssml' ? SSML_ADDITIONS : PLAIN_ADDITIONS,
    });
    if (synthesized.errors.length > 0) throw new Error(synthesized.errors.join('; '));
    aligned.push({
      ...chunk,
      audio: synthesized.audio,
      ...(await alignChunk(synthesized.audio, chunk.transcript, chunk.placement)),
    });
  }
  // 与生产相同：ffmpeg 拼接并逐块测时长，时间戳按前序块真实时长偏移。
  const concatenated = await concatReachDeckSpeechChunks(
    aligned.map((chunk) => ({ bytes: chunk.audio, contentType: 'audio/mpeg' })),
  );
  let offset = 0;
  const timestamps = aligned.flatMap((chunk, index) => {
    const shifted = chunk.timestamps.map((timestamp) => ({
      ...timestamp,
      start: timestamp.start + offset,
      end: timestamp.end + offset,
    }));
    offset += concatenated.durationsSeconds[index]!;
    return shifted;
  });
  return {
    aligned,
    audio: Buffer.from(concatenated.bytes),
    timestamps,
    duration: concatenated.durationsSeconds.reduce((total, value) => total + value, 0),
  };
}

function workbenchContext(): ReachDeckModelRequestContext {
  const runId = randomUUID();
  return {
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
    jobId: `formula-speech-workbench-${runId}`,
    runId,
  };
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 与编辑器讲稿轴同一渲染：行内公式，\displaystyle 降为 \textstyle。 */
const renderInlineFormula = (latex: string) =>
  renderMathToString(latex.replace(/\\displaystyle\b/gu, '\\textstyle'), { displayMode: false });

const FORMULA_WORD = /^\\\(([\s\S]*)\\\)$|^\\\[([\s\S]*)\\\]$/u;

/** 落库形态的字幕段 → 播放器字幕区 HTML + 逐字时间 + 编辑器讲稿轴标记。 */
function subtitleView(
  segments: ReadonlyArray<{
    text: string;
    start: number;
    end: number;
    words?: ReadonlyArray<{ text: string; start: number; end: number }>;
  }>,
) {
  const windows = narrationDisplayWindows(segments);
  return {
    pixelsPerSecond: TIMELINE_PIXELS_PER_SECOND,
    segments: segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      captionHtml: renderToStaticMarkup(
        createElement(NarrationCaption, { authoritative: true, text: segment.text }),
      ),
      words: (segment.words ?? []).map((word) => {
        const formula = word.text.trim().match(FORMULA_WORD);
        return {
          start: word.start,
          end: word.end,
          formula: formula !== null,
          html:
            formula === null
              ? escapeHtml(word.text)
              : renderInlineFormula((formula[1] ?? formula[2] ?? '').trim()),
        };
      }),
    })),
    marks: narrationCharacterMarks(windows, TIMELINE_PIXELS_PER_SECOND).map((mark) => ({
      time: mark.time,
      formula: mark.formula === true,
      html: mark.formula ? renderInlineFormula(mark.char) : escapeHtml(mark.char),
    })),
  };
}

/**
 * 整链试听。
 * - readings：调用生产 `finalizeNarrationForNativeSlide`——读法生成、分块、投影、字幕段与逐字时间
 *   全部是生产代码；只把「合成 + 对齐」换成本工作台的直连火山 + 本地 model-service 生产对齐器。
 * - production：修复前的线上路径——纯文本分块、LaTeX 原样送出、旧 `mapSegmentTimings` 映射。
 */
async function runPipeline(input: {
  markdown: string;
  mode: 'readings' | 'production';
  voice: Voice;
}) {
  const markdown = normalizeReachDeckNarrationMarkdown(input.markdown);
  const cues = splitNaturalNarrationCues(markdown);
  if (input.mode === 'production') {
    const plan = planReachDeckPlainSpeechChunks(markdown).map((chunk) => ({
      placement: 'text' as const,
      input: chunk.text,
      transcript: chunk.alignmentTranscript,
    }));
    const speech = await synthesizeAndAlign(plan, input.voice);
    let cursor = 0;
    const joined = {
      text: markdown,
      ranges: cues.map((cue) => {
        const range = { start: cursor, end: cursor + cue.text.length };
        cursor = range.end;
        return range;
      }),
    };
    const timings = mapSegmentTimings(joined, speech.timestamps);
    const segments = cues.map((cue, index) => ({
      text: cue.text,
      start: timings[index]?.start ?? 0,
      end: timings[index]?.end ?? 0,
      ...(timings[index] === undefined ? {} : { words: timings[index]!.words }),
    }));
    return pipelineResponse(markdown, [], speech, subtitleView(segments), undefined);
  }

  const model = process.env.REACH_DECK_E2E_MODEL || 'openai/gpt-5.6-luna';
  const modelOptions = {
    context: workbenchContext(),
    env: process.env,
    fetch: createDirectLiteLlmFetch(process.env, model),
  };
  // 与 job-runner 相同的顺序：读法在首次合成前生成一次，再交给 finalize。
  const readings = await prepareNarrationFormulaReadings(
    { pageId: 'workbench-page', text: markdown, pageTitle: '公式朗读工作台' },
    modelOptions,
  );
  let speech: Awaited<ReturnType<typeof synthesizeAndAlign>> | undefined;
  const product = await finalizeNarrationForNativeSlide(
    {
      pageId: 'workbench-page',
      sourceKind: 'materialized-native',
      pageTitle: '公式朗读工作台',
    } as unknown as Parameters<typeof finalizeNarrationForNativeSlide>[0],
    { markdown, cues, revealRanges: [] },
    {
      ...modelOptions,
      resolveSpeechAsset: async (request) => {
        // 与 generation-media.planSpeechChunks 相同的分块选择。
        const requestReadings = request.formulaReadings ?? [];
        const plan =
          request.speechMarkup !== undefined || requestReadings.length > 0
            ? planReachDeckSsmlChunks(
                request.text,
                request.speechMarkup,
                REACH_DECK_SSML_MAX_CHARACTERS,
                requestReadings.length === 0 ? undefined : { formulaReadings: requestReadings },
              ).map((chunk) => ({
                placement: 'ssml' as const,
                input: chunk.ssml,
                transcript: chunk.alignmentTranscript,
              }))
            : planReachDeckPlainSpeechChunks(request.text).map((chunk) => ({
                placement: 'text' as const,
                input: chunk.text,
                transcript: chunk.alignmentTranscript,
              }));
        speech = await synthesizeAndAlign(plan, input.voice);
        return {
          audioObjectKey: 'workbench/narration.mp3',
          contentType: 'audio/mpeg',
          timestamps: speech.timestamps,
          mediaDuration: speech.duration,
        };
      },
    },
    readings,
  );
  return pipelineResponse(markdown, readings, speech!, subtitleView(product.segments), model);
}

function pipelineResponse(
  markdown: string,
  readings: readonly ReachDeckFormulaReadingV1[],
  speech: Awaited<ReturnType<typeof synthesizeAndAlign>>,
  view: ReturnType<typeof subtitleView>,
  model: string | undefined,
) {
  return {
    model,
    readings: readings.map((reading) => ({
      latex: markdown.slice(reading.from, reading.to),
      reading: reading.reading,
    })),
    audioBase64: speech.audio.toString('base64'),
    duration: speech.duration,
    chunks: speech.aligned.map((chunk) => ({
      placement: chunk.placement,
      input: chunk.input,
      source: chunk.source,
    })),
    view,
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('body must be an object');
  }
  return value as Record<string, unknown>;
}

function parseVoice(value: unknown): Voice {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const speaker = typeof record.speaker === 'string' ? record.speaker.trim() : '';
  if (record.kind !== 'preset' && record.kind !== 'clone') throw new Error('voice.kind is invalid');
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(speaker)) throw new Error('voice.speaker is invalid');
  return { kind: record.kind, speaker };
}

function boundedText(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label} must be nonempty`);
  if (Array.from(value).length > limit) throw new Error(`${label} is too long`);
  return value;
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function sendJson(response: ServerResponse, work: Promise<unknown>): void {
  work
    .then((result) => send(response, 200, 'application/json', JSON.stringify(result)))
    .catch((error: unknown) =>
      send(
        response,
        400,
        'application/json',
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      ),
    );
}

/** 页面公式样式：只提供 katex.min.css 与其 woff2 字体，文件名白名单防路径穿越。 */
const KATEX_DIST = dirname(createRequire(import.meta.url).resolve('katex/dist/katex.min.css'));
const KATEX_ASSET = /^\/katex\/(katex\.min\.css|fonts\/KaTeX_[A-Za-z0-9_-]+\.woff2)$/u;

const argv = process.argv.slice(2);
const port = readPort(argv);
const cloneSpeaker = readArgument(argv, '--clone-speaker')?.trim();
requireEnv('REACHANY_VOLCENGINE_TTS_ENDPOINT');
requireEnv('REACHANY_VOLCENGINE_TTS_API_KEY');

const server = createServer((request, response) => {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) {
    send(response, 403, 'text/plain', 'cross-origin requests are rejected');
    return;
  }
  if (request.method === 'GET' && request.url === '/') {
    send(response, 200, 'text/html; charset=utf-8', page(cloneSpeaker));
    return;
  }
  const katexFile = request.method === 'GET' ? request.url?.match(KATEX_ASSET) : null;
  if (katexFile) {
    readFile(join(KATEX_DIST, katexFile[1]!))
      .then((bytes) => {
        response.writeHead(200, {
          'content-type': katexFile[1]!.endsWith('.css') ? 'text/css' : 'font/woff2',
          'cache-control': 'no-store',
        });
        response.end(bytes);
      })
      .catch(() => send(response, 404, 'text/plain', 'not found'));
    return;
  }
  if (request.method === 'POST' && request.url === '/synthesize') {
    sendJson(
      response,
      readJson(request).then(async (body) => {
        if (body.placement !== 'text' && body.placement !== 'ssml') {
          throw new Error('placement must be text or ssml');
        }
        const result = await synthesize({
          placement: body.placement,
          input: boundedText(body.input, MAX_INPUT_CHARACTERS, 'input'),
          voice: parseVoice(body.voice),
          additions:
            typeof body.additions === 'object' && body.additions !== null
              ? (body.additions as Record<string, unknown>)
              : {},
        });
        return { ...result, audio: undefined, audioBase64: result.audio.toString('base64') };
      }),
    );
    return;
  }
  if (request.method === 'POST' && request.url === '/pipeline') {
    sendJson(
      response,
      readJson(request).then((body) => {
        if (body.mode !== 'readings' && body.mode !== 'production')
          throw new Error('mode is invalid');
        return runPipeline({
          markdown: boundedText(body.markdown, MAX_NARRATION_CHARACTERS, 'markdown'),
          mode: body.mode,
          voice: parseVoice(body.voice),
        });
      }),
    );
    return;
  }
  send(response, 404, 'text/plain', 'not found');
});
server.listen(port, '127.0.0.1', () => {
  console.log(`公式朗读工作台：http://127.0.0.1:${port}（每次合成与模型调用都是真实计费调用）`);
});

const LEAD = '这个共同的放大或缩小比例可以写成';
const TAIL = '。这里的每一个比值都相同。';
const F = String.raw`\frac{AB}{A'B'}=\frac{BC}{B'C'}=\frac{CA}{C'A'}=k`;
const G = String.raw`已知 \(\triangle ABC \sim \triangle A'B'C'\)，\(\angle A=\angle A'\)，且 \(\sqrt{2}\approx 1.414\)，\(x^{2}\ge 0\)。`;
const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const speak = (inner: string) => `<speak>${inner}</speak>`;
const inline = (latex: string) => String.raw`\(` + latex + String.raw`\)`;
const PRESETS: Array<[string, 'text' | 'ssml', string, Record<string, unknown>]> = [
  [
    'P1 生产现状：纯文本 \\(\\displaystyle …\\)',
    'text',
    LEAD + inline(String.raw`\displaystyle ` + F) + TAIL,
    PLAIN_ADDITIONS,
  ],
  ['P1b 纯文本 \\(…\\)，去掉 \\displaystyle', 'text', LEAD + inline(F) + TAIL, PLAIN_ADDITIONS],
  [
    'P7 纯文本：我们给出的读法',
    'text',
    LEAD + 'AB比A撇B撇，等于BC比B撇C撇，等于CA比C撇A撇，等于k' + TAIL,
    PLAIN_ADDITIONS,
  ],
  ['P9 纯文本 \\(…\\)：一句多个公式', 'text', G, PLAIN_ADDITIONS],
  [
    'S1 SSML 内 \\(\\displaystyle …\\)',
    'ssml',
    speak(esc(LEAD + inline(String.raw`\displaystyle ` + F) + TAIL)),
    SSML_ADDITIONS,
  ],
  [
    'S6 SSML 读法直接替换公式（本次方案）',
    'ssml',
    speak(esc(LEAD + 'AB比A撇B撇，等于BC比B撇C撇，等于CA比C撇A撇，等于k' + TAIL)),
    SSML_ADDITIONS,
  ],
  ['S10 SSML 内 \\(…\\)：一句多个公式', 'ssml', speak(esc(G)), SSML_ADDITIONS],
  [
    'S4 SSML say-as Math（线性写法）',
    'ssml',
    speak(
      esc(LEAD) +
        '<say-as interpret-as="Math">' +
        esc("AB/A'B'=BC/B'C'=CA/C'A'=k") +
        '</say-as>' +
        esc(TAIL),
    ),
    SSML_ADDITIONS,
  ],
  [
    'S7 SSML say-as Math：简单式',
    'ssml',
    speak(
      '方程<say-as interpret-as="Math">' +
        esc('x^2+2x+1=0') +
        '</say-as>的解是<say-as interpret-as="Math">' +
        esc('x=-1') +
        '</say-as>。',
    ),
    SSML_ADDITIONS,
  ],
];
const NARRATIONS: Array<[string, string]> = [
  [
    '测试课件第 5 页（相似三角形）',
    String.raw`刚才的判断把关键问题呈现出来了：两个三角形即使大小不同，也可能保持相同的形状关系。这样的两个三角形叫作相似三角形。判断“相似”时，关注的不是它们是否一样大，而是对应角是否相等，以及对应边是否按照同一个比例变化。

看左侧的图，较大的三角形可以看作较小三角形的整体放大：对应角的位置关系保持不变，对应边同时按同一个倍数改变。这个共同的放大或缩小比例可以写成

\(\displaystyle \frac{AB}{A'B'}=\frac{BC}{B'C'}=\frac{CA}{C'A'}=k\)

这里的每一个比值都相同，表示三组对应边的变化是一致的。要注意，相似不等于全等：全等图形的形状和大小都相同，而相似三角形只要求形状关系相同，大小可以不同。后面配对应角和对应边时，先确认这种对应关系，再检查角与边的共同变化。`,
  ],
  ['一句多个几何公式', G],
];

/** 嵌入 script 的 JSON 需转义 `<`，避免提前闭合标签。 */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

function page(clone: string | undefined): string {
  return String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>公式朗读工作台 #705</title>
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:24px;max-width:1200px;color:#1f2937}
h1{font-size:20px}h2{font-size:16px;margin-top:28px}.hint{color:#6b7280;font-size:13px}
.row{border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:12px 0}
.row header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
textarea{width:100%;min-height:54px;font-family:ui-monospace,Consolas,monospace;font-size:13px;margin-top:8px}
#narration{min-height:180px}
.additions{font-family:ui-monospace,Consolas,monospace;font-size:12px;width:520px}
.words{font-size:13px;margin-top:6px;line-height:1.9}
.words span{background:#eef2ff;border-radius:4px;padding:1px 4px;margin-right:3px;cursor:pointer}
.err{color:#b91c1c;font-size:13px}.sent{color:#374151;font-size:13px}
pre{white-space:pre-wrap;font-size:12px;background:#f9fafb;padding:8px;border-radius:6px}
button{padding:4px 12px}
.panel{border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;margin:10px 0}
.label{font-size:12px;color:#6b7280;margin-bottom:6px}
.caption{min-height:44px;font-size:20px;background:#111827;color:#f9fafb;border-radius:6px;padding:10px 14px}
.wordRow{line-height:2.4;font-size:15px}
.wordRow > span{border-radius:4px;padding:2px 3px;margin-right:1px;cursor:pointer}
.wordRow > span.active{background:#fde68a}
.wordRow > span.formula{background:#eef2ff}
.axisScroller{overflow-x:auto;position:relative}
.axis{position:relative;height:28px;background:#ecfdf5;border-radius:4px}
.axis > span{position:absolute;top:0;bottom:0;display:flex;align-items:center;transform:translateX(-50%);font-size:11.2px;line-height:1;white-space:pre}
.axis > span .katex{font-size:1.2em;line-height:1}
.axis > .playhead{width:2px;background:#ef4444;transform:none}
</style>
<link rel="stylesheet" href="/katex/katex.min.css"></head><body>
<h1>公式朗读工作台（#705）</h1>
<p class="hint">每次合成与模型调用都是真实计费调用。</p>
<p><label>音色 <select id="voiceKind"><option value="clone">克隆（seed-icl-2.0）</option><option value="preset">预置（seed-tts-2.0）</option></select></label>
<input id="speaker" size="60"></p>

<h2>整链试听：讲稿 → 读法 → 合成</h2>
<p class="hint">「生成读法并合成」使用生产的读法提示词（经 LiteLLM 直连）和生产的 SSML 分块；「生产现状」是当前线上的纯文本分块，LaTeX 原样送出。</p>
<p><select id="sample"></select></p>
<textarea id="narration"></textarea>
<p><button id="withReadings">生成读法并合成</button> <button id="production">生产现状对照</button> <span id="pipelineStatus"></span></p>
<audio id="pipelineAudio" controls style="width:100%"></audio>
<div class="panel"><div class="label">幻灯片字幕区（播放器 NarrationCaption）</div><div id="caption" class="caption"></div></div>
<div class="panel"><div class="label">逐字时间（落库的 words；点击跳转）</div><div id="wordRow" class="wordRow"></div></div>
<div class="panel"><div class="label">讲稿轴（编辑器 narrationCharacterMarks，72px/秒）</div><div id="axisScroller" class="axisScroller"><div id="axis" class="axis"></div></div></div>
<div id="pipelineResult"></div>

<h2>单行变体</h2>
<p class="hint">placement=text 对应「无讲稿标记」页，ssml 对应 req_params.ssml。additions 原样序列化，另外强制加上 enable_timestamp。点击字幕词可跳到对应时间。</p>
<p><button id="all">全部合成（2 路并发）</button></p>
<div id="rows"></div>
<p><button id="add">+ 新增一行</button></p>
<script>
const CLONE = ${scriptJson(clone ?? '')};
const PRESET_SPEAKER = ${scriptJson(DEFAULT_SPEAKER)};
const PRESETS = ${scriptJson(PRESETS)};
const NARRATIONS = ${scriptJson(NARRATIONS)};
const PLAIN = ${scriptJson(PLAIN_ADDITIONS)};
const kind = document.getElementById('voiceKind'), speaker = document.getElementById('speaker');
kind.value = CLONE ? 'clone' : 'preset';
speaker.value = CLONE || PRESET_SPEAKER;
kind.onchange = () => { speaker.value = kind.value === 'clone' ? CLONE : PRESET_SPEAKER; };
const voice = () => ({ kind: kind.value, speaker: speaker.value.trim() });
async function post(path, body) {
  const response = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
const sample = document.getElementById('sample'), narration = document.getElementById('narration');
NARRATIONS.forEach(([label], index) => { const o = document.createElement('option'); o.value = index; o.textContent = label; sample.appendChild(o); });
sample.onchange = () => { narration.value = NARRATIONS[sample.value][1]; };
narration.value = NARRATIONS[0][1];
async function pipeline(mode) {
  const status = document.getElementById('pipelineStatus'), out = document.getElementById('pipelineResult');
  status.textContent = mode === 'readings' ? '生成读法并合成中…' : '合成中…'; out.textContent = '';
  try {
    const result = await post('/pipeline', { markdown: narration.value, mode, voice: voice() });
    document.getElementById('pipelineAudio').src = 'data:audio/mpeg;base64,' + result.audioBase64;
    const lines = [];
    if (mode === 'readings') {
      lines.push('读法模型：' + result.model);
      for (const r of result.readings) lines.push('公式 ' + r.latex + '\n  读作：' + r.reading);
    }
    result.chunks.forEach((c, i) => lines.push('\n[块 ' + (i + 1) + ' · ' + c.placement + ' · 对齐来源 ' + c.source + ']\n' + c.input));
    const pre = document.createElement('pre'); pre.textContent = lines.join('\n'); out.appendChild(pre);
    renderSubtitles(result.view, result.duration);
    status.textContent = '完成';
  } catch (error) { status.textContent = '失败：' + (error.message || error); }
}
let view;
function renderSubtitles(nextView, duration) {
  view = nextView;
  const audio = document.getElementById('pipelineAudio');
  const wordRow = document.getElementById('wordRow'); wordRow.textContent = '';
  view.words = [];
  view.segments.forEach((segment) => {
    segment.words.forEach((word) => {
      const span = document.createElement('span');
      span.innerHTML = word.html;
      if (word.formula) span.className = 'formula';
      span.title = word.start.toFixed(2) + '–' + word.end.toFixed(2) + 's';
      span.onclick = () => { audio.currentTime = word.start; audio.play(); };
      wordRow.appendChild(span);
      view.words.push({ span, start: word.start, end: word.end });
    });
  });
  const axis = document.getElementById('axis'); axis.textContent = '';
  axis.style.width = Math.max(600, duration * view.pixelsPerSecond + 40) + 'px';
  view.marks.forEach((mark) => {
    const span = document.createElement('span');
    span.innerHTML = mark.html;
    span.style.left = mark.time * view.pixelsPerSecond + 'px';
    axis.appendChild(span);
  });
  const playhead = document.createElement('span'); playhead.className = 'playhead'; axis.appendChild(playhead);
  view.playhead = playhead;
  syncSubtitles();
}
function syncSubtitles() {
  if (!view) return;
  const t = document.getElementById('pipelineAudio').currentTime;
  const segment = view.segments.find((s) => t >= s.start && t < s.end) ?? view.segments.findLast((s) => s.start <= t);
  const caption = document.getElementById('caption');
  const html = segment ? segment.captionHtml : '';
  if (caption.dataset.html !== html) { caption.innerHTML = html; caption.dataset.html = html; }
  view.words.forEach((w) => w.span.classList.toggle('active', t >= w.start && t < w.end));
  view.playhead.style.left = t * view.pixelsPerSecond + 'px';
}
(function tick() { syncSubtitles(); requestAnimationFrame(tick); })();
document.getElementById('withReadings').onclick = () => pipeline('readings');
document.getElementById('production').onclick = () => pipeline('production');

const rows = document.getElementById('rows');
function addRow([label, placement, input, additions]) {
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = '<header><b></b><select><option value="text">text</option><option value="ssml">ssml</option></select>'
    + '<input class="additions"><button class="go">合成</button><span class="status"></span></header>'
    + '<textarea></textarea><audio controls style="width:100%;margin-top:6px"></audio>'
    + '<div class="sent"></div><div class="words"></div><div class="err"></div>';
  row.querySelector('b').textContent = label;
  row.querySelector('select').value = placement;
  row.querySelector('.additions').value = JSON.stringify(additions);
  row.querySelector('textarea').value = input;
  row.querySelector('.go').onclick = () => run(row);
  rows.appendChild(row);
}
async function run(row) {
  const status = row.querySelector('.status'), err = row.querySelector('.err');
  status.textContent = '合成中…'; err.textContent = '';
  try {
    const result = await post('/synthesize', {
      placement: row.querySelector('select').value,
      input: row.querySelector('textarea').value,
      voice: voice(),
      additions: JSON.parse(row.querySelector('.additions').value || '{}'),
    });
    const audio = row.querySelector('audio');
    audio.src = 'data:audio/mpeg;base64,' + result.audioBase64;
    row.querySelector('.sent').textContent = result.sentences.length ? '供应方 sentence：' + result.sentences.join(' | ') : '';
    const words = row.querySelector('.words'); words.textContent = '';
    for (const w of result.words) {
      const span = document.createElement('span');
      span.textContent = w.word; span.title = w.startTime + '–' + w.endTime + 's';
      span.onclick = () => { audio.currentTime = w.startTime; audio.play(); };
      words.appendChild(span);
    }
    if (result.errors.length) err.textContent = result.errors.join('; ');
    status.textContent = '完成（' + result.words.length + ' 词）';
  } catch (error) { status.textContent = '失败'; err.textContent = String(error.message || error); }
}
PRESETS.forEach(addRow);
document.getElementById('add').onclick = () => addRow(['自定义', 'text', '', PLAIN]);
document.getElementById('all').onclick = async () => {
  const all = [...rows.children]; let next = 0;
  const worker = async () => { while (next < all.length) await run(all[next++]); };
  await Promise.all([worker(), worker()]);
};
</script></body></html>`;
}
