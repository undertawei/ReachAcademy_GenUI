/**
 * 讲稿分块探针的命令行入口。
 *
 * 用法：
 *   pnpm --filter @reachany/ai-runtime exec tsx \
 *     scripts/reach-deck/run-narration-chunk-probe.ts [options]
 *
 * 需要的环境变量（从 infra/env/dev.env 逐条 export，密码含特殊字符，别用 source）：
 *   REACHANY_VOLCENGINE_TTS_ENDPOINT / _API_KEY / _MODELS
 *   REACHANY_VOLC_ENDPOINT / REACHANY_VOLC_API_KEY / REACHANY_VOLC_AUDIO_SUBTITLE_MODEL
 */
import { readFile } from 'node:fs/promises';

import { probeNarrationChunks } from './narration-chunk-probe.js';

const DEFAULT_OUTPUT_DIRECTORY = 'tmp/reach-deck-narration-probe';
const DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts';

const USAGE = `Usage:
  tsx scripts/reach-deck/run-narration-chunk-probe.ts [options]

Options:
  --text-file <path>    讲稿文本文件（默认用内置的 400 字左右样例）
  --output-dir <path>   产物目录（默认 ${DEFAULT_OUTPUT_DIRECTORY}）
  --concurrency <n>     页内并发块数（默认 3）
  --speaker <id>        音色（默认 ${DEFAULT_SPEAKER}）
  --baseline            额外跑一次整页不分块对齐作为基线（很慢）
  --help                打印本说明
`;

/** 内置样例：一段真实教学口吻的讲稿，长度接近事故页的 378 字。 */
const SAMPLE_TEXT = [
  '同学们好，今天我们来研究一个看起来简单、其实很有意思的问题：为什么树叶是绿色的。',
  '我们知道，太阳光看上去是白色的，但它其实由红橙黄绿蓝靛紫等各种颜色的光混合而成。',
  '当阳光照到叶片上，叶片里的叶绿素会大量吸收红光和蓝紫光，用来驱动光合作用，',
  '而绿光被吸收得很少，大部分被反射出来，进入我们的眼睛，所以我们看到的叶子是绿的。',
  '换句话说，绿色恰恰是叶子“不要”的那部分光。',
  '这里有个容易搞混的地方：叶绿素并不是把绿光变没了，而是把它放走了。',
  '理解了这一点，我们就能解释秋天的现象——气温下降时叶绿素先分解，',
  '原本被掩盖的类胡萝卜素显露出来，叶子于是变黄变红。',
].join('');

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} 需要一个取值`);
  return value;
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${key}`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const textFile = optionValue(argv, '--text-file');
  const concurrencyRaw = optionValue(argv, '--concurrency');
  const concurrency = concurrencyRaw === undefined ? 3 : Number(concurrencyRaw);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('--concurrency 必须是正整数');
  }
  const text = textFile === undefined ? SAMPLE_TEXT : (await readFile(textFile, 'utf8')).trim();

  await probeNarrationChunks({
    text,
    outputDirectory: optionValue(argv, '--output-dir') ?? DEFAULT_OUTPUT_DIRECTORY,
    concurrency,
    baseline: argv.includes('--baseline'),
    tts: {
      endpoint: requireEnv('REACHANY_VOLCENGINE_TTS_ENDPOINT'),
      apiKey: requireEnv('REACHANY_VOLCENGINE_TTS_API_KEY'),
      resourceId: requireEnv('REACHANY_VOLCENGINE_TTS_MODELS').split(',')[0]!.trim(),
      speaker: optionValue(argv, '--speaker') ?? DEFAULT_SPEAKER,
    },
    ark: {
      endpoint: requireEnv('REACHANY_VOLC_ENDPOINT'),
      apiKey: requireEnv('REACHANY_VOLC_API_KEY'),
      model: requireEnv('REACHANY_VOLC_AUDIO_SUBTITLE_MODEL'),
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
