/**
 * 讲稿分块合成 + 字幕对齐的实测探针。
 *
 * 数据源：无 PG/Mongo 读写；直接调用两个上游供应方——火山引擎 TTS
 * （{@link https://openspeech.bytedance.com} 单向流式合成）与火山方舟字幕对齐
 * （Responses API）。刻意绕开 model-service：本探针要测的是供应方耗时与分块后的
 * 音频质量，而 model-service 的策略、准入、鉴权层不影响这两项，却要求真实的
 * org/course scope 与模型策略行才能跑起来。
 *
 * 核心逻辑：
 * <ol>
 *   <li>用与生产同一个 {@link planReachDeckPlainSpeechChunks} 规划分块</li>
 *   <li>按给定并发度逐块合成并对齐，分别计时两跳</li>
 *   <li>ffmpeg 无重编码拼接整页音频，并按各块真实时长累加偏移拼接时间戳</li>
 *   <li>另外切出每个块边界前后若干秒的片段，便于单独试听衔接是否自然</li>
 *   <li>可选跑一次整页不分块的对齐作为基线对照（很慢，默认关闭）</li>
 * </ol>
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  planReachDeckPlainSpeechChunks,
  type ReachDeckPlainSpeechChunkV1,
} from '../../lib/reach-deck/plain-speech-chunks.js';
import { mapWithConcurrency } from '../../lib/reach-deck/concurrency.js';

export interface ProbeTimestamp {
  char: string;
  start: number;
  end: number;
}

export interface ProbeChunkResult {
  index: number;
  characters: number;
  text: string;
  audioBytes: number;
  ttsMillis: number;
  alignMillis: number;
  audioSeconds: number;
  timestamps: ProbeTimestamp[];
}

const ALIGNMENT_INSTRUCTIONS =
  '你拥有对齐语音内容与转写文本的能力，你能深刻理解语音中存在的时序关系，' +
  '现在需要你按照用户的要求输出用户所需要的识别结果。' +
  '你必须按照用户给定的模板进行输出，避免其他无关的输出内容。';

const ENTRY_PATTERN = /^\s*(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-([\s\S]+)$/;

function alignmentPrompt(transcript: string): string {
  return (
    '听写这段音频，音频对应转写结果为：「' +
    transcript +
    '」。' +
    '现在我需要你根据音频的转写结果把音频中的每个字符都对应上它的开始时间和结束时间。' +
    '要求你不要篡改转写结果，只需要根据音频的转写结果输出对应的时间信息。\n' +
    "你需要按着一字一行的格式来排列结果，每一行用';'隔开。" +
    "每一行的由三部分组成，分别为开始时间、结束时间、转写字符，并且用'-'将它们分割开。" +
    '要注意开始时间和结束时间的单位为秒，可以精确到小数点后两位。\n' +
    '可以参考下面的模板：\n' +
    '{开始时间}-{结束时间}-{转写字符};...;{开始时间}-{结束时间}-{转写字符};\n' +
    '注意你只能按着模板输出结果，请勿输出其它无关的信息和内容。'
  );
}

/** 合成一块讲稿；返回 mp3 字节。请求形状对齐 VolcengineTtsClient。 */
export async function synthesize(
  text: string,
  config: { endpoint: string; apiKey: string; resourceId: string; speaker: string },
): Promise<Uint8Array> {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'X-Api-Key': config.apiKey,
      'X-Api-Resource-Id': config.resourceId,
      'X-Api-Request-Id': crypto.randomUUID(),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      req_params: {
        text,
        speaker: config.speaker,
        audio_params: { format: 'mp3', sample_rate: 24_000, speech_rate: 0 },
        additions: JSON.stringify({ latex_parser: 'v2', disable_markdown_filter: true }),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`TTS HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  // 上游返回一串首尾相接的 JSON 值，逐个取出 data 字段（base64 音频）拼起来。
  const parts: Uint8Array[] = [];
  let completed = false;
  for (const value of splitConcatenatedJson(await response.text())) {
    const code = value.code;
    if (code === 20_000_000) {
      completed = true;
      continue;
    }
    if (code !== 0) throw new Error(`TTS 上游拒绝，code=${String(code)}`);
    if (typeof value.data === 'string' && value.data.length > 0) {
      parts.push(Uint8Array.from(Buffer.from(value.data, 'base64')));
    }
  }
  if (!completed || parts.length === 0) throw new Error('TTS 未返回完整音频');
  return Uint8Array.from(Buffer.concat(parts));
}

/** 字幕对齐一块音频；返回词级时间戳。请求形状对齐 VolcArkSubtitleAlignmentClient。 */
export async function align(
  audio: Uint8Array,
  transcript: string,
  config: { endpoint: string; apiKey: string; model: string },
): Promise<ProbeTimestamp[]> {
  const audioUrl = `data:audio/mpeg;base64,${Buffer.from(audio).toString('base64')}`;
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      instructions: ALIGNMENT_INSTRUCTIONS,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_audio', audio_url: audioUrl },
            { type: 'input_text', text: alignmentPrompt(transcript) },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`对齐 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { output?: Array<Record<string, unknown>> };
  let outputText = '';
  for (const item of body.output ?? []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type === 'output_text' && typeof part.text === 'string') outputText += part.text;
    }
  }
  const words: ProbeTimestamp[] = [];
  let previousStart = -1;
  for (const raw of outputText.split(';')) {
    if (raw.trim().length === 0) continue;
    const matched = ENTRY_PATTERN.exec(raw);
    if (matched === null) continue;
    const start = Number(matched[1]);
    const end = Number(matched[2]);
    const char = matched[3]!.trim();
    if (char.length === 0 || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0 || end < start || start < previousStart) continue;
    words.push({ char, start, end });
    previousStart = start;
  }
  return words;
}

function splitConcatenatedJson(payload: string): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < payload.length; index += 1) {
    const character = payload[index]!;
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
        values.push(JSON.parse(payload.slice(start, index + 1)) as Record<string, unknown>);
        start = -1;
      }
    }
  }
  return values;
}

export async function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} 退出码 ${code}: ${stderr}`)),
    );
  });
}

async function probeDuration(path: string): Promise<number> {
  const out = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  return Number(out.trim());
}

export interface ProbeOptions {
  text: string;
  outputDirectory: string;
  concurrency: number;
  baseline: boolean;
  tts: { endpoint: string; apiKey: string; resourceId: string; speaker: string };
  ark: { endpoint: string; apiKey: string; model: string };
  log?: (line: string) => void;
}

export async function probeNarrationChunks(options: ProbeOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const chunks: ReachDeckPlainSpeechChunkV1[] = planReachDeckPlainSpeechChunks(options.text);
  await rm(options.outputDirectory, { recursive: true, force: true });
  await mkdir(options.outputDirectory, { recursive: true });

  log(
    `讲稿 ${Array.from(options.text).length} 字，切成 ${chunks.length} 块，并发 ${options.concurrency}`,
  );
  log(`各块字数：${chunks.map((chunk) => Array.from(chunk.text).length).join(' / ')}`);
  log('');

  const startedAt = Date.now();
  const results = await mapWithConcurrency(
    chunks,
    options.concurrency,
    async (chunk): Promise<ProbeChunkResult> => {
      const ttsStart = Date.now();
      const audio = await synthesize(chunk.text, options.tts);
      const ttsMillis = Date.now() - ttsStart;
      const alignStart = Date.now();
      const timestamps = await align(audio, chunk.alignmentTranscript, options.ark);
      const alignMillis = Date.now() - alignStart;
      const path = join(
        options.outputDirectory,
        `chunk-${String(chunk.index).padStart(2, '0')}.mp3`,
      );
      await writeFile(path, audio);
      const audioSeconds = await probeDuration(path);
      log(
        `块 ${chunk.index}（${String(Array.from(chunk.text).length).padStart(3)} 字，音频 ${audioSeconds.toFixed(1)}s）` +
          ` TTS ${(ttsMillis / 1000).toFixed(1)}s，对齐 ${(alignMillis / 1000).toFixed(1)}s，` +
          `时间戳 ${timestamps.length} 条`,
      );
      return {
        index: chunk.index,
        characters: Array.from(chunk.text).length,
        text: chunk.text,
        audioBytes: audio.byteLength,
        ttsMillis,
        alignMillis,
        audioSeconds,
        timestamps,
      };
    },
  );
  const wallClockMillis = Date.now() - startedAt;

  // 拼接整页音频：与生产同一条路径（ffmpeg concat demuxer，无重编码）。
  const manifest = join(options.outputDirectory, 'chunks.ffconcat');
  await writeFile(
    manifest,
    [
      'ffconcat version 1.0',
      ...results.map((r) => `file 'chunk-${String(r.index).padStart(2, '0')}.mp3'`),
      '',
    ].join('\n'),
  );
  const pagePath = join(options.outputDirectory, 'page.mp3');
  await run('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    manifest,
    '-map',
    '0:a:0',
    '-c:a',
    'copy',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-write_xing',
    '0',
    '-y',
    pagePath,
  ]);

  // 时间戳按各块真实时长累加偏移，拼成整页一条轴。
  let offset = 0;
  const pageTimestamps: ProbeTimestamp[] = [];
  const boundaries: number[] = [];
  for (const result of results) {
    if (result.index > 0) boundaries.push(offset);
    for (const timestamp of result.timestamps) {
      pageTimestamps.push({
        char: timestamp.char,
        start: Number((timestamp.start + offset).toFixed(3)),
        end: Number((timestamp.end + offset).toFixed(3)),
      });
    }
    offset += result.audioSeconds;
  }

  // 每个块边界前后 4 秒切一段，便于单独试听衔接。
  for (const [position, at] of boundaries.entries()) {
    const from = Math.max(0, at - 4);
    await run('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-ss',
      from.toFixed(3),
      '-t',
      '8',
      '-i',
      pagePath,
      '-c:a',
      'copy',
      '-y',
      join(
        options.outputDirectory,
        `boundary-${String(position + 1).padStart(2, '0')}-at-${at.toFixed(1)}s.mp3`,
      ),
    ]);
  }

  let baseline: { alignMillis: number; timestamps: number } | undefined;
  if (options.baseline) {
    log('');
    log('跑整页不分块基线（慢，可能数百秒）……');
    const wholeAudio = await synthesize(options.text, options.tts);
    const baselineStart = Date.now();
    try {
      const wholeTimestamps = await align(wholeAudio, options.text, options.ark);
      baseline = { alignMillis: Date.now() - baselineStart, timestamps: wholeTimestamps.length };
      log(
        `基线：整页对齐 ${(baseline.alignMillis / 1000).toFixed(1)}s，时间戳 ${baseline.timestamps} 条`,
      );
    } catch (error) {
      log(`基线失败（${(Date.now() - baselineStart) / 1000}s）：${String(error)}`);
    }
  }

  const alignTotal = results.reduce((total, r) => total + r.alignMillis, 0);
  const report = {
    characters: Array.from(options.text).length,
    chunks: results.length,
    concurrency: options.concurrency,
    wallClockSeconds: Number((wallClockMillis / 1000).toFixed(1)),
    serialEquivalentSeconds: Number(
      (results.reduce((total, r) => total + r.ttsMillis + r.alignMillis, 0) / 1000).toFixed(1),
    ),
    alignSecondsPerChunk: results.map((r) => Number((r.alignMillis / 1000).toFixed(1))),
    maxAlignSeconds: Number((Math.max(...results.map((r) => r.alignMillis)) / 1000).toFixed(1)),
    pageAudioSeconds: Number(offset.toFixed(2)),
    boundariesAtSeconds: boundaries.map((at) => Number(at.toFixed(2))),
    ...(baseline === undefined
      ? {}
      : { baselineAlignSeconds: Number((baseline.alignMillis / 1000).toFixed(1)) }),
    chunkTexts: results.map((r) => r.text),
    timestamps: pageTimestamps,
  };
  await writeFile(join(options.outputDirectory, 'report.json'), JSON.stringify(report, null, 2));

  log('');
  log(`整页音频 ${offset.toFixed(1)}s → ${pagePath}`);
  log(`块边界位于 ${boundaries.map((at) => `${at.toFixed(1)}s`).join('、')}，各切了 8 秒片段`);
  log(`对齐耗时合计 ${(alignTotal / 1000).toFixed(1)}s，最慢一块 ${report.maxAlignSeconds}s`);
  log(
    `并发 ${options.concurrency} 墙钟 ${report.wallClockSeconds}s（串行需 ${report.serialEquivalentSeconds}s）`,
  );
}
